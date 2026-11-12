import { addDays, diffDays, maxDate } from '../dates.js'

// The one place that turns an event date into calendar dates. Pure: same input, same output.
// The browser draws these dates, the webhook agent reads them, diffPaypal compares them.

export const ISSUE_LEAD_DAYS = 14
export const HOLD_GRACE_DAYS = 3
export const PINNED_STATUSES = new Set(['SENT', 'UNPAID', 'PAID', 'PARTIALLY_PAID', 'MARKED_AS_PAID', 'PAYMENT_PENDING'])
export const PAID_STATUSES = new Set(['PAID', 'MARKED_AS_PAID'])

// The dates PayPal already holds for a step, or null while nothing has gone out. An invoice that is sent or paid,
// or a deposit checkout (Orders) that exists, fixes the step: the engine never moves it.
export function lockOf(step) {
  if (step.invoice && PINNED_STATUSES.has(step.invoice.status)) return { issueDate: step.invoice.remote.issueDate, dueDate: step.invoice.remote.dueDate }
  if (step.deposit && step.deposit.status !== 'VOIDED') return { issueDate: step.deposit.issueDate, dueDate: step.deposit.dueDate }
  return null
}

export function isPinned(step) {
  return Boolean(lockOf(step))
}

// A captured deposit is paid exactly like a paid invoice.
export function isPaid(step) {
  return Boolean((step.invoice && PAID_STATUSES.has(step.invoice.status)) || step.deposit?.status === 'COMPLETED')
}

// Issue date rule: due date - lead days, but never in the past. Past means the invoice goes out today.
export function issueDateFor(dueDate, today, leadDays = ISSUE_LEAD_DAYS) {
  const ideal = addDays(dueDate, -leadDays)
  return { issueDate: maxDate(ideal, today), sendNow: ideal <= today }
}

// PayPal does not need a due date in the past. The contract keeps the real date, the invoice gets today.
export function dueForPaypal(dueDate, today) {
  return maxDate(dueDate, today)
}

function stepDue(step, eventDate, signedOn) {
  if (step.anchor === 'FIXED') return step.fixedDate
  const base = step.anchor === 'SIGNING' ? signedOn : eventDate
  return addDays(base, step.offsetDays)
}

/**
 * model: { eventDate, signedOn, leadDays, steps, tasks, adjustments }
 * Pinned steps (invoice already sent or paid) keep the dates PayPal has.
 */
export function computeSchedule(model, today) {
  const leadDays = model.leadDays ?? ISSUE_LEAD_DAYS
  const adjustments = model.adjustments || {}

  const steps = model.steps.map((step) => {
    const locked = lockOf(step)
    const pinned = Boolean(locked)
    const dueDate = locked ? locked.dueDate : stepDue(step, model.eventDate, model.signedOn)
    const issue = locked ? { issueDate: locked.issueDate, sendNow: false } : issueDateFor(dueDate, today, leadDays)
    return {
      id: step.id,
      kind: step.kind,
      label: step.label,
      amountCents: step.amountCents,
      dueDate,
      issueDate: issue.issueDate,
      sendNow: issue.sendNow,
      pinned,
      // Moves with the wedding date only while it is counted back from the wedding and not yet sent.
      follows: !pinned && step.anchor === 'EVENT',
      paid: isPaid(step),
      overdueDays: !pinned || !step.invoice || isPaid(step) ? 0 : Math.max(0, diffDays(today, step.invoice.contractDueDate || dueDate)),
    }
  })
  const byId = new Map(steps.map((s) => [s.id, s]))

  const tasks = []
  const taskById = new Map()
  for (const task of model.tasks) {
    const pred = byId.get(task.after)
    const predTask = taskById.get(task.after)
    const predEnd = pred ? pred.dueDate : predTask.endDate
    const predFixed = pred ? !pred.follows : predTask.fixed
    const predPinned = pred ? pred.pinned : predTask.pinnedChain
    let startDate = addDays(predEnd, task.lagDays)
    const adj = adjustments[task.id]
    let adjusted = null
    let waitsFor = null
    // A hold tied to a payment (untilStep) lasts until that payment is PAID, not until a fixed day: while it is unpaid
    // the start keeps sliding to today + HOLD_GRACE_DAYS. Once paid the hold is gone and the planned start counts again.
    const waitStep = adj?.kind === 'hold' && adj.untilStep ? byId.get(adj.untilStep) : null
    const holdDate = adj?.kind !== 'hold' ? null : waitStep ? (waitStep.paid ? null : maxDate(adj.date, addDays(today, HOLD_GRACE_DAYS))) : adj.date
    if (waitStep && !waitStep.paid) waitsFor = waitStep.id
    if (holdDate && holdDate > startDate) {
      startDate = holdDate
      adjusted = 'hold'
    } else if (adj?.kind === 'pull' && predFixed && adj.date < startDate) {
      startDate = adj.date
      adjusted = 'pull'
    }
    const out = {
      id: task.id,
      name: task.name,
      after: task.after,
      lagDays: task.lagDays,
      cost: task.cost,
      durationDays: task.durationDays,
      startDate,
      endDate: addDays(startDate, task.durationDays),
      // A task follows the wedding date only when its chain starts at an unpinned payment.
      fixed: predFixed,
      pinnedChain: predPinned,
      adjusted,
      // Step id of the unpaid payment this task waits for (a hold that lasts until PayPal says PAID).
      waitsFor,
      deadlineDate: task.deadlineOffsetDays === undefined ? null : addDays(model.eventDate, task.deadlineOffsetDays),
    }
    tasks.push(out)
    taskById.set(out.id, out)
  }

  return { eventDate: model.eventDate, steps, tasks }
}

/**
 * Moving the wedding date must not collide with payments that are already out.
 * Rules: due dates keep their contract order, and an unpinned payment cannot land before a pinned one.
 * Returns null when fine, or a message.
 */
export function moveConflict(model, newEventDate, today) {
  if (newEventDate <= today) return 'The wedding date must be after today.'
  const next = computeSchedule({ ...model, eventDate: newEventDate }, today)
  let lastPinned = null
  for (const step of next.steps) {
    if (step.kind !== 'installment') continue
    if (step.pinned) {
      lastPinned = step
      continue
    }
    if (lastPinned && step.dueDate < lastPinned.dueDate) {
      return `Moving the wedding to ${newEventDate} puts "${step.label}" (due ${step.dueDate}) before "${lastPinned.label}", which is already ${lastPinned.paid ? 'paid' : 'sent'} and pinned (due ${lastPinned.dueDate}).`
    }
  }
  const unpinned = next.steps.filter((s) => s.kind === 'installment' && !s.pinned)
  for (let i = 1; i < unpinned.length; i += 1) {
    if (unpinned[i].dueDate < unpinned[i - 1].dueDate) {
      return `Moving the wedding to ${newEventDate} would put "${unpinned[i].label}" before "${unpinned[i - 1].label}".`
    }
  }
  const lastDue = next.steps.filter((s) => s.kind === 'installment').reduce((m, s) => maxDate(m, s.dueDate), '0000-00-00')
  if (lastDue > newEventDate) return `The last payment (due ${lastDue}) would fall after the wedding date.`
  return null
}

// An extension gives one scheduled payment a later fixed due date. It stops following the wedding date; the
// payments after it keep their order, and nothing may end up after the wedding.
export function withExtension(model, stepId, dueDate) {
  return { ...model, steps: model.steps.map((s) => (s.id === stepId ? { ...s, anchor: 'FIXED', fixedDate: dueDate } : s)) }
}

export function extendConflict(model, stepId, dueDate, today) {
  const step = model.steps.find((s) => s.id === stepId)
  if (!step || step.kind !== 'installment') return 'Only a contract payment can be extended.'
  if (isPinned(step) || !step.invoice) return 'This payment is already sent or paid, so PayPal keeps its dates. Only a scheduled invoice can be extended.'
  const current = computeSchedule(model, today).steps.find((s) => s.id === stepId)
  if (dueDate <= current.dueDate) return `An extension must move the due date later than ${current.dueDate}.`
  const next = computeSchedule(withExtension(model, stepId, dueDate), today)
  const installments = next.steps.filter((s) => s.kind === 'installment')
  const at = installments.findIndex((s) => s.id === stepId)
  const after = installments[at + 1]
  if (after && after.dueDate < dueDate) return `Extending to ${dueDate} would put "${installments[at].label}" after "${after.label}" (due ${after.dueDate}).`
  if (dueDate > model.eventDate) return `The extended due date ${dueDate} would fall after the wedding date.`
  return null
}
