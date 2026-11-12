import { randomUUID } from 'node:crypto'
import { HttpError } from '../store.js'
import { dueForPaypal, extendConflict, isPinned, moveConflict, withExtension } from '../schedule/engine.js'
import { modelOf } from '../schedule/model.js'
import { shortLabel } from '../dates.js'
import { usd } from '../schedule/compute.js'
import { bumpPlan, logActivity, scheduleOf } from './contracts.js'
import { createAndSend, editDates } from './invoiceOps.js'
import { createDeposit, captureDeposit } from './deposits.js'
import { newApproval } from './approvalFactory.js'
import { refreshInvoice, scanDueTriggers, runTrigger } from './triggers.js'
import { withLock } from './lock.js'

// The only code that changes PayPal. Each executor runs behind an approved card, inside the contract lock.

export function requestInvoices(ctx, contract) {
  const sched = scheduleOf(ctx, contract)
  const lines = sched.steps.filter((s) => s.kind === 'installment' && !contract.steps.find((x) => x.id === s.id).invoice).map((s) => {
    const step = contract.steps.find((x) => x.id === s.id)
    if (step.via === 'order') return { text: `Deposit ${usd(s.amountCents)}  PayPal checkout link (Orders), the client pays and the server captures`, stepId: s.id, op: 'deposit' }
    return {
      text: `${s.label} ${usd(s.amountCents)}  ${s.sendNow ? 'send now' : `send ${shortLabel(s.issueDate)}`} · due ${shortLabel(dueForPaypal(s.dueDate, ctx.today()))}${s.sendNow ? '' : ' · SCHEDULED'}`,
      stepId: s.id,
      op: 'create',
    }
  })
  const deposits = lines.filter((l) => l.op === 'deposit').length
  const invoices = lines.length - deposits
  const [id, approval] = newApproval(contract, {
    type: 'CREATE_INVOICES',
    title: deposits ? `Create the deposit checkout and ${invoices} PayPal invoices?` : `Create ${lines.length} PayPal invoices?`,
    versioned: true,
    lines,
    approveLabel: deposits ? `Approve checkout and ${invoices} invoices` : `Approve ${lines.length} invoices`,
    payload: { private: {}, public: {} },
  })
  contract.approvals.set(id, approval)
  return approval
}

export function requestRecordPayment(ctx, contract, { stepId, amountCents }) {
  const step = contract.steps.find((s) => s.id === stepId)
  if (!step?.invoice) throw new HttpError(404, 'No invoice for that step yet.')
  if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(step.invoice.status)) throw new HttpError(409, `${step.invoice.number} is ${step.invoice.status} and cannot take a payment.`)
  const due = step.amountCents - (step.invoice.paidCents || 0)
  const cents = amountCents ?? due
  if (!Number.isInteger(cents) || cents <= 0 || cents > due) throw new HttpError(400, `Amount must be between $0.01 and ${usd(due)}.`)
  const [id, approval] = newApproval(contract, {
    type: 'RECORD_PAYMENT',
    title: `Record ${usd(cents)} bank transfer on ${step.invoice.number}?`,
    versioned: false,
    lines: [{ text: `${step.label}: ${cents === due ? 'pays the invoice in full' : `partial payment, ${usd(due - cents)} stays due`}` }],
    approveLabel: 'Record payment',
    payload: { private: { stepId, amountCents: cents }, public: { stepId, amountCents: cents } },
  })
  contract.approvals.set(id, approval)
  return approval
}

// ---------- executors: return { after: [async fn] } for work that must run once the lock is released ----------

async function runItems(ctx, contract, job, items) {
  for (const item of items) {
    const step = contract.steps.find((s) => s.id === item.stepId)
    item.status = 'running'
    if (step.invoice) step.invoice.syncing = true
    try {
      if (item.op === 'deposit') await createDeposit(ctx, contract, step)
      else if (item.op === 'create') await createAndSend(ctx, contract, step)
      else if (item.op === 'edit') {
        const sstep = scheduleOf(ctx, contract).steps.find((s) => s.id === step.id)
        await editDates(ctx, contract, step, { issueDate: sstep.issueDate, dueDate: dueForPaypal(sstep.dueDate, ctx.today()), sendNow: sstep.sendNow, contractDueDate: sstep.dueDate })
      }
      item.status = 'done'
      item.error = null
    } catch (err) {
      item.status = 'failed'
      item.error = err.message
      logActivity(contract, { actor: 'paypal', text: `${step.invoice?.number || step.label} failed: ${err.message}${err.debugId ? ` (PayPal debug id ${err.debugId})` : ''}`, ok: false })
    } finally {
      if (step.invoice) step.invoice.syncing = false
    }
  }
  job.status = job.items.every((i) => i.status === 'done') ? 'done' : 'partial'
  const failed = job.items.filter((i) => i.status === 'failed').length
  job.summary = failed ? `${job.items.length - failed} of ${job.items.length} changes applied` : `${job.items.length} of ${job.items.length} changes applied`
  return job
}

function newJob(contract, approvalId, items) {
  const job = { id: randomUUID(), approvalId, status: 'running', items: items.map((i) => ({ ...i, status: 'pending', error: null })) }
  contract.jobs.unshift(job)
  return job
}

// Items still needed so PayPal matches the plan. Pinned invoices are never listed.
function pendingItems(ctx, contract) {
  const today = ctx.today()
  const sched = scheduleOf(ctx, contract)
  const items = []
  for (const s of sched.steps) {
    const step = contract.steps.find((x) => x.id === s.id)
    if (!step.invoice) {
      if (step.kind === 'fee') items.push({ stepId: step.id, op: 'create', label: step.label })
      continue
    }
    if (s.pinned) continue
    const same = step.invoice.remote.issueDate === s.issueDate && step.invoice.remote.dueDate === dueForPaypal(s.dueDate, today)
    if (!same) items.push({ stepId: step.id, op: 'edit', label: `${step.invoice.number} ${step.label}` })
  }
  return items
}

async function execCreateInvoices(ctx, contract, approval) {
  const items = approval.lines.map((l) => ({ stepId: l.stepId, op: l.op || 'create', label: l.text }))
  const job = newJob(contract, approval.id, items)
  await runItems(ctx, contract, job, job.items)
  return { job, after: [() => scanDueTriggers(ctx, contract)] }
}

async function execMoveEvent(ctx, contract, approval) {
  const { eventDate, feeCents } = approval.payload.private
  const conflict = moveConflict(modelOf(contract), eventDate, ctx.today())
  if (conflict) throw new HttpError(409, conflict)
  const before = scheduleOf(ctx, contract)
  contract.eventDate = eventDate
  if (feeCents > 0 && !contract.steps.some((s) => s.id === 'fee')) {
    contract.steps.push({ id: 'fee', kind: 'fee', label: 'Date change fee', amountCents: feeCents, anchor: 'FIXED', fixedDate: ctx.today(), offsetDays: 0, quote: contract.dateChangeFee?.quote || 'Date change fee', invoice: null })
  }
  bumpPlan(contract, { keepBaseline: false, before })
  logActivity(contract, { actor: 'human', text: `Approved: wedding ${before.eventDate} -> ${eventDate}` })
  const job = newJob(contract, approval.id, pendingItems(ctx, contract))
  await runItems(ctx, contract, job, job.items)
  return { job }
}

async function execExtendDue(ctx, contract, approval) {
  const { stepId, dueDate } = approval.payload.private
  const conflict = extendConflict(modelOf(contract), stepId, dueDate, ctx.today())
  if (conflict) throw new HttpError(409, conflict)
  const before = scheduleOf(ctx, contract)
  const step = contract.steps.find((s) => s.id === stepId)
  // A new step object: the extended payment now has a fixed due date and stops following the wedding.
  contract.steps = contract.steps.map((s) => (s.id === stepId ? withExtension(modelOf(contract), stepId, dueDate).steps.find((x) => x.id === stepId) : s))
  bumpPlan(contract, { keepBaseline: false, before })
  logActivity(contract, { actor: 'human', text: `Approved: ${step.invoice.number} due ${before.steps.find((s) => s.id === stepId).dueDate} -> ${dueDate}` })
  const job = newJob(contract, approval.id, pendingItems(ctx, contract))
  await runItems(ctx, contract, job, job.items)
  return { job }
}

async function execApplyProposal(ctx, contract, approval) {
  const proposal = contract.proposals.find((p) => p.id === approval.payload.private.proposalId)
  if (!proposal || proposal.status !== 'pending' || proposal.stale) throw new HttpError(409, 'Plan changed, recalculate.')
  const before = scheduleOf(ctx, contract)
  contract.adjustments = { ...proposal.adjustments }
  bumpPlan(contract, { keepBaseline: false, before })
  proposal.status = 'applied'
  logActivity(contract, { actor: 'human', text: `Applied proposal: ${proposal.label}`, proposalId: proposal.id })
  return {}
}

async function execReminder(ctx, contract, approval) {
  const { stepId, note } = approval.payload.private
  const step = contract.steps.find((s) => s.id === stepId)
  await ctx.invoicing.sendReminder(step.invoice.id, { subject: `Payment reminder: ${step.label}`, note })
  logActivity(contract, { actor: 'human', text: `Reminder sent for ${step.invoice.number}`, invoiceId: step.invoice.id })
  return {}
}

async function execRecordPayment(ctx, contract, approval) {
  const { stepId, amountCents } = approval.payload.private
  const step = contract.steps.find((s) => s.id === stepId)
  await ctx.invoicing.recordPayment(step.invoice.id, { amountCents, method: 'BANK_TRANSFER', note: 'Bank transfer recorded in VowLedger' })
  const result = await refreshInvoice(ctx, contract, step)
  logActivity(contract, { actor: 'human', text: `Recorded ${usd(amountCents)} bank transfer on ${step.invoice.number}`, invoiceId: step.invoice.id })
  return { after: result.newlyPaid ? [() => runTrigger(ctx, contract, { kind: 'PAID', stepId })] : [] }
}

// Capture the deposit once the payer approved it (return redirect or the "Capture now" button).
// The payer's approval on PayPal is the consent; the amount is checked against the schedule inside captureDeposit.
export async function captureDepositFor(ctx, contract, stepId) {
  const step = contract.steps.find((s) => s.id === stepId)
  if (!step?.deposit) throw new HttpError(404, 'No deposit checkout for this contract yet.')
  const result = await withLock(contract.id, () => captureDeposit(ctx, contract, step))
  if (result.newlyPaid) await runTrigger(ctx, contract, { kind: 'PAID', stepId })
  return result
}

const EXECUTORS = {
  CREATE_INVOICES: execCreateInvoices,
  MOVE_EVENT: execMoveEvent,
  EXTEND_DUE: execExtendDue,
  APPLY_PROPOSAL: execApplyProposal,
  REMINDER: execReminder,
  RECORD_PAYMENT: execRecordPayment,
}

export async function executeApproval(ctx, session, contractId, approvalId) {
  const contract = ctx.store.getContract(session, contractId)
  const approval = contract.approvals.get(approvalId)
  if (!approval) throw new HttpError(404, 'Approval not found.')
  if (approval.status !== 'pending') throw new HttpError(409, `This card is already ${approval.status}.`)
  if (approval.versioned && approval.planVersion !== contract.planVersion) throw new HttpError(409, 'Plan changed, recalculate.')
  // Claim the card before any await: a second click or a second tab cannot run it twice.
  approval.status = 'executing'
  let outcome
  try {
    outcome = await withLock(contract.id, async () => {
      if (approval.versioned && approval.planVersion !== contract.planVersion) throw new HttpError(409, 'Plan changed, recalculate.')
      return EXECUTORS[approval.type](ctx, contract, approval)
    })
  } catch (err) {
    approval.status = err instanceof HttpError && err.status === 409 ? 'stale' : 'failed'
    approval.error = err.message
    throw err
  }
  approval.status = outcome.job && outcome.job.status === 'partial' ? 'partial' : 'done'
  approval.jobId = outcome.job?.id || null
  approval.executedAt = new Date().toISOString()
  for (const fn of outcome.after || []) await fn()
  return { approval, job: outcome.job || null }
}

export function dismissApproval(ctx, session, contractId, approvalId) {
  const contract = ctx.store.getContract(session, contractId)
  const approval = contract.approvals.get(approvalId)
  if (!approval) throw new HttpError(404, 'Approval not found.')
  if (approval.status !== 'pending') throw new HttpError(409, `This card is already ${approval.status}.`)
  approval.status = 'cancelled'
  if (approval.type === 'APPLY_PROPOSAL') {
    const proposal = contract.proposals.find((p) => p.id === approval.payload.private.proposalId)
    if (proposal && proposal.status === 'pending') proposal.status = 'dismissed'
  }
  return approval
}

// Retry only what failed. The plan already changed; PayPal catches up one invoice at a time.
export async function retryJob(ctx, session, contractId, jobId) {
  const contract = ctx.store.getContract(session, contractId)
  const job = contract.jobs.find((j) => j.id === jobId)
  if (!job) throw new HttpError(404, 'Job not found.')
  const failed = job.items.filter((i) => i.status === 'failed')
  if (!failed.length) throw new HttpError(409, 'Nothing to retry.')
  if (job.status === 'running') throw new HttpError(409, 'This job is still running.')
  job.status = 'running'
  await withLock(contract.id, () => runItems(ctx, contract, job, failed))
  const approval = contract.approvals.get(job.approvalId)
  if (approval) approval.status = job.status === 'done' ? 'done' : 'partial'
  return job
}
