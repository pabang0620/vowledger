import { randomUUID } from 'node:crypto'
import { computeSchedule, isPinned, isPaid, dueForPaypal } from '../schedule/engine.js'
import { templateTasks, usd } from '../schedule/compute.js'
import { modelOf } from '../schedule/model.js'
import { ganttData } from '../schedule/ganttData.js'
import { depositLabel } from '../schedule/depositStatus.js'

export function logActivity(contract, entry) {
  const item = { id: randomUUID(), at: new Date().toISOString(), ...entry }
  contract.activity = [item, ...contract.activity].slice(0, 100)
  return item
}

export function scheduleOf(ctx, contract, overrides) {
  return computeSchedule(modelOf(contract, overrides), ctx.today())
}

export function createContract(ctx, session, { read, steps, text, source = 'mock-reader', sourceLabel = null, sampleKey = null }) {
  const today = ctx.today()
  const contract = {
    id: randomUUID(),
    sessionId: session.id,
    name: read.couple || `${read.client?.surname || 'Client'} wedding`,
    client: read.client || { given: 'Client', surname: 'Client', email: 'client@example.com' },
    vendor: { businessName: 'Lena Park Photography', email: 'lena@example.com' },
    text,
    readBy: source,
    readByLabel: sourceLabel,
    // Which built-in sample this is, if any: recorded model runs are looked up by it in mock mode.
    sampleKey,
    totalCents: read.totalCents,
    totalQuote: read.totalQuote || '',
    eventDate: read.eventDate,
    signedOn: read.signedOn || today,
    leadDays: read.leadDays ?? 14,
    partialAllowed: Boolean(read.partialAllowed),
    dateChangeFee: read.dateChangeFee || null,
    // The first milestone is collected by a PayPal Orders checkout when the deposit path is on.
    depositCheckout: Boolean(ctx.depositCheckout),
    steps: steps.map((s, i) => (i === 0 && ctx.depositCheckout ? { ...s, via: 'order', deposit: null } : s)),
    tasks: templateTasks(steps),
    adjustments: {},
    planVersion: 1,
    baseline0: null,
    proposals: [],
    approvals: new Map(),
    jobs: [],
    activity: [],
    seenEvents: new Set(),
    triggerKeys: new Set(),
    createdAt: new Date().toISOString(),
  }
  session.contracts.set(contract.id, contract)
  logActivity(contract, { actor: 'agent', text: `Read the contract: ${steps.length} payment clauses, total ${usd(contract.totalCents)}` })
  return contract
}

// Bump the plan version. Every proposal or approval made against an older version stops being applicable.
export function bumpPlan(contract, { keepBaseline = true, before = null } = {}) {
  contract.planVersion += 1
  if (before && !keepBaseline) contract.baseline0 = before
  for (const p of contract.proposals) if (p.status === 'pending' && p.planVersion !== contract.planVersion) p.stale = true
  for (const a of contract.approvals.values()) if (a.status === 'pending' && a.planVersion !== contract.planVersion && a.versioned) a.stale = true
}

function syncStateOf(ctx, contract, step, sstep) {
  const inv = step.invoice
  if (!inv) return 'none'
  if (inv.syncing) return 'pending'
  if (sstep.pinned) return 'synced'
  const same = inv.remote.issueDate === sstep.issueDate && inv.remote.dueDate === dueForPaypal(sstep.dueDate, ctx.today())
  return same ? 'synced' : 'not_synced'
}

export function publicContract(ctx, contract) {
  const today = ctx.today()
  const schedule = scheduleOf(ctx, contract)
  for (const sstep of schedule.steps) {
    const step = contract.steps.find((s) => s.id === sstep.id)
    if (step.invoice) step.invoice.syncState = syncStateOf(ctx, contract, step, sstep)
  }
  const pendingProposal = contract.proposals.find((p) => p.status === 'pending') || null
  const movePreview = [...contract.approvals.values()].find((a) => ['MOVE_EVENT', 'EXTEND_DUE'].includes(a.type) && a.status === 'pending' && !a.stale) || null
  const shown = movePreview ? movePreview.previewSchedule : schedule
  const installments = contract.steps.filter((s) => s.kind === 'installment' || s.kind === 'fee')
  const paid = installments.reduce((sum, s) => sum + (s.invoice ? s.invoice.paidCents || 0 : s.deposit?.status === 'COMPLETED' ? s.amountCents : 0), 0)
  const scheduled = installments.filter((s) => s.invoice && !isPinned(s)).reduce((sum, s) => sum + s.amountCents, 0)
  const notSynced = contract.steps.filter((s) => s.invoice?.syncState === 'not_synced').length
  return {
    id: contract.id,
    name: contract.name,
    client: contract.client,
    totalCents: contract.totalCents,
    eventDate: contract.eventDate,
    planVersion: contract.planVersion,
    today,
    leadDays: contract.leadDays,
    dateChangeFee: contract.dateChangeFee,
    clauses: contract.steps.filter((s) => s.kind === 'installment').map((s) => ({ id: s.id, label: s.label, percent: s.percent, amountCents: s.amountCents, quote: s.quote })),
    readBy: contract.readBy,
    readByLabel: contract.readByLabel,
    summary: { paidCents: paid, scheduledCents: scheduled, notSynced, stepsDone: stepsDone(contract) },
    schedule: shown,
    gantt: ganttData(contract, shown, { baseline0: movePreview ? schedule : contract.baseline0, proposal: pendingProposal && !pendingProposal.stale ? pendingProposal : null, today }),
    steps: contract.steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label, percent: s.percent, amountCents: s.amountCents, quote: s.quote, via: s.via || 'invoice', deposit: publicDeposit(s), invoice: s.invoice && { id: s.invoice.id, number: s.invoice.number, status: s.invoice.status, remote: s.invoice.remote, syncState: s.invoice.syncState, paidCents: s.invoice.paidCents || 0 } })),
    proposals: contract.proposals.map(publicProposal),
    approvals: [...contract.approvals.values()].map(publicApproval).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    jobs: contract.jobs.map((j) => ({ id: j.id, approvalId: j.approvalId, status: j.status, items: j.items })),
    activity: contract.activity,
  }
}

// The three demo steps, decided by the server so the guide band and the tests read the same truth.
// 1: every contract payment has an invoice or a checkout order. 2: some payment is paid. 3: a wedding move was approved.
export function stepsDone(contract) {
  const installments = contract.steps.filter((s) => s.kind === 'installment')
  const partly = (s) => Boolean(s.invoice && s.invoice.status === 'PARTIALLY_PAID')
  return {
    created: installments.length > 0 && installments.every((s) => s.invoice || s.deposit || s.depositUnknown),
    paid: installments.some((s) => isPaid(s) || partly(s)),
    moved: [...contract.approvals.values()].some((a) => a.type === 'MOVE_EVENT' && ['done', 'partial'].includes(a.status)),
  }
}

function publicDeposit(step) {
  if (!step.deposit && !step.depositUnknown) return null
  const d = step.deposit
  return { orderId: d?.orderId || null, status: depositLabel(step), approveUrl: d && d.status === 'CREATED' ? d.approveUrl : null, canCapture: Boolean(d && d.status !== 'COMPLETED' && (d.status === 'APPROVED' || d.unknown)), captureId: d?.captureId || null }
}

export function publicProposal(p) {
  const { schedule, adjustments, ...rest } = p
  return { ...rest, tasks: schedule.tasks.map((t) => ({ id: t.id, name: t.name, startDate: t.startDate, endDate: t.endDate })) }
}

export function publicApproval(a) {
  const { previewSchedule, execute, payload, ...rest } = a
  return { ...rest, payload: payload?.public || null }
}
