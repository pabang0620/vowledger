import { randomUUID } from 'node:crypto'
import { listOptions, dueUnpaidTriggers } from '../schedule/options.js'
import { PAID_STATUSES, PINNED_STATUSES, moveConflict } from '../schedule/engine.js'
import { diffPaypal, changeLine, unchangedDetail } from '../schedule/diffPaypal.js'
import { modelOf } from '../schedule/model.js'
import { shortLabel } from '../dates.js'
import { payRef } from '../schedule/depositStatus.js'
import { refreshDeposit } from './deposits.js'
import { usd } from '../schedule/compute.js'
import { HttpError } from '../store.js'
import { runMockAgent } from '../agent/mockAgent.js'
import { bumpPlan, logActivity, scheduleOf } from './contracts.js'
import { applyRemote } from './invoiceOps.js'
import { withLock } from './lock.js'
import { newApproval } from './approvalFactory.js'

const VIA_LABELS = { 'mock-agent': 'Rule-based agent', claude: 'Claude (API key)', 'claude-account': 'Claude Sonnet (local account)' }

// Who made the pick, in words a judge can trust: a replay names the recorded run and its date.
function viaLabel(agent) {
  return agent.recording?.label || VIA_LABELS[agent.via] || agent.via
}

// Two entrances, one exit. A payment event or a dragged wedding date becomes server-computed options;
// the agent picks an option id; the pick becomes a proposal or an approval card. Nothing is executed here.

async function decide(ctx, contract, trigger, options) {
  const out = await ctx.agent.decide(ctx, contract, trigger, options)
  if (out.choice) return out
  logActivity(contract, { actor: 'system', text: 'The agent gave no usable choice; the rule-based pick was used.' })
  return runMockAgent(ctx, contract, trigger, options)
}

// Re-read one invoice from PayPal and bring the local record up to date. Caller holds the contract lock.
export async function refreshInvoice(ctx, contract, step) {
  const inv = step.invoice
  const prev = inv.status
  applyRemote(step, await ctx.invoicing.getInvoice(inv.id))
  const changed = prev !== inv.status
  const newlyPaid = PAID_STATUSES.has(inv.status) && !PAID_STATUSES.has(prev)
  if (changed) {
    bumpPlan(contract)
    const pinnedNow = PINNED_STATUSES.has(inv.status) && !PINNED_STATUSES.has(prev)
    logActivity(contract, { actor: 'paypal', text: `${inv.number} ${prev} -> ${inv.status}${pinnedNow ? ' (pinned on the Gantt)' : ''}`, invoiceId: inv.id })
  }
  if (newlyPaid) releaseHolds(ctx, contract, step)
  return { changed, newlyPaid }
}

// The payment a hold waited for is PAID: the hold ends now. The task may start from today (never in the past),
// so the stored hold becomes a plain "not before today" and the activity log says what was released.
function releaseHolds(ctx, contract, step) {
  const today = ctx.today()
  const held = Object.entries(contract.adjustments).filter(([, adj]) => adj.kind === 'hold' && adj.untilStep === step.id)
  if (!held.length) return
  contract.adjustments = { ...contract.adjustments, ...Object.fromEntries(held.map(([taskId]) => [taskId, { kind: 'hold', date: today }])) }
  const after = scheduleOf(ctx, contract)
  for (const [taskId] of held) {
    const task = after.tasks.find((t) => t.id === taskId)
    logActivity(contract, { actor: 'system', text: `Hold released: ${step.invoice.number} is paid, so "${task.name}" can start ${shortLabel(task.startDate)}.` })
  }
}

// Webhook or poll entrance. Duplicate deliveries (same event id) are ignored.
export async function handleInvoiceEvent(ctx, event) {
  if (!event?.id || ctx.seenEvents.has(event.id)) return { duplicate: true }
  const invoiceId = event.resource?.invoice?.id || event.resource?.id
  const found = invoiceId && ctx.store.findByInvoiceId(invoiceId)
  if (!found) return { ignored: true }
  const { contract, step } = found
  // The event type is only a hint: the actual status always comes from get_invoice.
  const result = await withLock(contract.id, async () => {
    if (ctx.seenEvents.has(event.id)) return null
    const refreshed = await refreshInvoice(ctx, contract, step)
    // Only acknowledge a delivery after the source invoice was read successfully.
    ctx.seenEvents.add(event.id)
    return refreshed
  })
  if (!result) return { duplicate: true }
  if (result.newlyPaid) await runTrigger(ctx, contract, { kind: 'PAID', stepId: step.id })
  await scanDueTriggers(ctx, contract)
  return { handled: true, ...result }
}

export async function pollContract(ctx, contract) {
  for (const step of contract.steps) {
    if (step.deposit && step.deposit.status !== 'COMPLETED') {
      const result = await withLock(contract.id, () => refreshDeposit(ctx, contract, step))
      if (result.newlyPaid) await runTrigger(ctx, contract, { kind: 'PAID', stepId: step.id })
      continue
    }
    if (!step.invoice || ['PAID', 'MARKED_AS_PAID', 'CANCELLED'].includes(step.invoice.status)) continue
    const result = await withLock(contract.id, () => refreshInvoice(ctx, contract, step))
    if (result.newlyPaid) await runTrigger(ctx, contract, { kind: 'PAID', stepId: step.id })
  }
  await scanDueTriggers(ctx, contract)
}

export async function scanDueTriggers(ctx, contract) {
  for (const trigger of dueUnpaidTriggers(contract, ctx.today())) await runTrigger(ctx, contract, trigger)
}

function validateProposal(optionsById, choice) {
  const opt = optionsById.get(choice.optionId)
  if (!opt) throw new HttpError(422, 'The agent chose an option that is not in the server list.')
  return opt
}

// Entrance 1: payment events. Each (kind, step) runs once.
export async function runTrigger(ctx, contract, trigger) {
  const key = `${trigger.kind}:${trigger.stepId}`
  if (contract.triggerKeys.has(key)) return null
  contract.triggerKeys.add(key)
  const options = listOptions(contract, trigger, ctx.today())
  // Nothing to decide: no task can move. An overdue installment still gets a reminder.
  const overdue = trigger.kind === 'DUE_UNPAID' && scheduleOf(ctx, contract).steps.find((s) => s.id === trigger.stepId).overdueDays > 0
  if (options.length < 2 && !overdue) return null
  const agent = await decide(ctx, contract, trigger, options)
  const opt = validateProposal(new Map(options.map((o) => [o.id, o])), agent.choice)
  const step = contract.steps.find((s) => s.id === trigger.stepId)
  const isKeep = opt.id.endsWith(':keep')
  // Server-computed before and after dates for the card, so nobody has to read the Gantt to see what the pick changes.
  const now = scheduleOf(ctx, contract)
  const changes = opt.schedule.tasks.flatMap((t) => {
    const was = now.tasks.find((x) => x.id === t.id)
    return was && was.startDate !== t.startDate ? [{ id: t.id, name: t.name, from: was.startDate, to: t.startDate, text: opt.id.includes(':hold') ? `${t.name} waits for the ${step.label || 'installment'} invoice payment (planned ${shortLabel(was.startDate)}, shown as ${shortLabel(t.startDate)} while unpaid)` : `${t.name} ${shortLabel(was.startDate)} -> ${shortLabel(t.startDate)}` }] : []
  })
  const proposal = {
    id: randomUUID(),
    trigger,
    optionId: opt.id,
    label: opt.label,
    reason: agent.choice.reason,
    notChosen: agent.choice.notChosen || [],
    planVersion: contract.planVersion,
    adjustments: opt.adjustments,
    schedule: opt.schedule,
    status: isKeep ? 'noted' : 'pending',
    via: agent.via,
    viaLabel: viaLabel(agent),
    recording: agent.recording || null,
    createdAt: new Date().toISOString(),
    toolCalls: agent.events.map((e) => e.tool),
    changes,
  }
  contract.proposals.unshift(proposal)
  logActivity(contract, { actor: 'agent', text: `${trigger.kind === 'PAID' ? `${payRef(step)} paid` : `${payRef(step)} due and unpaid`}: proposed "${opt.label}"`, proposalId: proposal.id })
  if (!isKeep) {
    contract.approvals.set(...newApproval(contract, {
      type: 'APPLY_PROPOSAL',
      title: opt.label,
      versioned: true,
      lines: [{ text: agent.choice.reason }],
      approveLabel: 'Apply proposal',
      payload: { private: { proposalId: proposal.id }, public: { proposalId: proposal.id } },
    }))
  }
  if (trigger.kind === 'DUE_UNPAID' && agent.choice.reminderNote) {
    contract.approvals.set(...newApproval(contract, {
      type: 'REMINDER',
      title: `Send a reminder for ${step.invoice.number}`,
      versioned: false,
      lines: [{ text: agent.choice.reminderNote }, { text: `Contract${agent.choice.reminderClause ? ` (cited by the agent)` : ''}: "${agent.choice.reminderQuote || step.quote}"` }],
      approveLabel: 'Send reminder',
      payload: { private: { stepId: step.id, note: agent.choice.reminderNote }, public: { stepId: step.id } },
    }))
  }
  return proposal
}

// Entrance 2: the photographer dragged the wedding date. Preview only: nothing reaches PayPal until the card is approved.
export async function prepareMove(ctx, contract, eventDate) {
  const today = ctx.today()
  if (eventDate === contract.eventDate) throw new HttpError(409, 'That is already the wedding date.')
  const conflict = moveConflict(modelOf(contract), eventDate, today)
  if (conflict) throw new HttpError(409, conflict)
  for (const a of contract.approvals.values()) if (a.type === 'MOVE_EVENT' && a.status === 'pending') a.status = 'cancelled'
  const trigger = { kind: 'MOVE', eventDate }
  const options = listOptions(contract, trigger, today)
  const agent = await decide(ctx, contract, trigger, options)
  const opt = validateProposal(new Map(options.map((o) => [o.id, o])), agent.choice)
  const diff = diffPaypal(contract, opt.schedule, { today, feeCents: opt.feeCents || 0, feeQuote: contract.dateChangeFee?.quote })
  const approval = newApproval(contract, {
    type: 'MOVE_EVENT',
    title: `Move wedding ${shortLabel(contract.eventDate)} -> ${shortLabel(eventDate)}?`,
    versioned: true,
    lines: diff.changes.map(changeLine),
    unchanged: diff.unchanged.map((u) => ({ text: `${u.invoiceNumber} ${u.label} ${usd(u.amountCents)} ${u.status}`, stepId: u.stepId, detail: unchangedDetail(u) })),
    note: agent.choice.reason,
    noteBy: viaLabel(agent),
    notChosen: agent.choice.notChosen || [],
    approveLabel: `Approve ${diff.changes.length} PayPal change${diff.changes.length === 1 ? '' : 's'}`,
    payload: { private: { eventDate, previousEventDate: contract.eventDate, optionId: opt.id, feeCents: opt.feeCents || 0 }, public: { eventDate, previousEventDate: contract.eventDate } },
    previewSchedule: opt.schedule,
  })
  contract.approvals.set(...approval)
  logActivity(contract, { actor: 'agent', text: `Drafted the move to ${eventDate}: ${diff.changes.length} PayPal change(s), ${diff.unchanged.length} pinned`, approvalId: approval[0] })
  return approval[1]
}

export function currentScheduleOf(ctx, contract) {
  return scheduleOf(ctx, contract)
}
