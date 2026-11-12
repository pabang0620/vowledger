import { addDays, maxDate } from '../dates.js'
import { computeSchedule, HOLD_GRACE_DAYS, isPinned } from './engine.js'
import { modelOf } from './model.js'

// The server builds every choice and computes the schedule each choice leads to.
// The model can only name an id from this list; it never writes a date.

const withAdjustments = (contract, extra) => ({ ...contract.adjustments, ...extra })

// A hold lasts until the payment step is PAID (the engine re-extends it while unpaid and drops it once paid).
const hold = (stepId, date) => ({ kind: 'hold', date, untilStep: stepId })

function schedFor(contract, today, overrides = {}) {
  return computeSchedule(modelOf(contract, overrides), today)
}

function option(id, label, description, overrides, contract, today, extra = {}) {
  return { id, label, description, adjustments: overrides.adjustments || {}, schedule: schedFor(contract, today, overrides), ...extra }
}

function dependents(contract, stepId, today) {
  const schedule = schedFor(contract, today)
  return schedule.tasks.filter((t) => t.after === stepId)
}

export function listOptions(contract, trigger, today) {
  if (trigger.kind === 'PAID') return paidOptions(contract, trigger, today)
  if (trigger.kind === 'DUE_UNPAID') return dueOptions(contract, trigger, today)
  if (trigger.kind === 'MOVE') return moveOptions(contract, trigger, today)
  return []
}

function paidOptions(contract, { stepId }, today) {
  const step = contract.steps.find((s) => s.id === stepId)
  const out = [option(`paid:${stepId}:keep`, 'Keep the planned dates', `Payment for "${step.label}" is confirmed. Leave the production dates as planned.`, {}, contract, today)]
  const earliest = addDays(today, 1)
  for (const task of dependents(contract, stepId, today)) {
    if (task.startDate <= earliest) continue
    const adjustments = withAdjustments(contract, { [task.id]: { kind: 'pull', date: earliest } })
    out.push(option(`paid:${stepId}:pull:${task.id}`, `Start "${task.name}" now`, `Payment is confirmed, so "${task.name}" (${task.cost === 'external' ? 'outside cost' : 'no outside cost'}) can start tomorrow instead of waiting.`, { adjustments }, contract, today, { taskId: task.id }))
  }
  return out
}

function dueOptions(contract, { stepId }, today) {
  const step = contract.steps.find((s) => s.id === stepId)
  const out = [option(`due:${stepId}:keep`, 'Proceed as planned', `"${step.label}" is due but unpaid. Leave all production dates unchanged.`, {}, contract, today)]
  const tasks = dependents(contract, stepId, today)
  const sched = schedFor(contract, today)
  const due = sched.steps.find((s) => s.id === stepId).dueDate
  const holdDate = addDays(maxDate(due, today), HOLD_GRACE_DAYS)
  const effective = tasks.filter((t) => t.startDate < holdDate)
  for (const task of effective) {
    const adjustments = withAdjustments(contract, { [task.id]: hold(stepId, holdDate) })
    out.push(option(`due:${stepId}:hold:${task.id}`, `Hold "${task.name}" until payment`, `Hold "${task.name}" (${task.cost === 'external' ? 'outside cost' : 'no outside cost'}) until PayPal reports this invoice PAID. While it is unpaid the start keeps moving to ${HOLD_GRACE_DAYS} days after the latest check; the moment it is paid the hold is released.`, { adjustments }, contract, today, { taskId: task.id }))
  }
  if (effective.length > 1) {
    const adjustments = withAdjustments(contract, Object.fromEntries(effective.map((t) => [t.id, hold(stepId, holdDate)])))
    out.push(option(`due:${stepId}:hold-all`, 'Hold every dependent task until payment', 'Hold all tasks that follow this installment until PayPal reports it PAID.', { adjustments }, contract, today))
  }
  return out
}

function moveOptions(contract, { eventDate }, today) {
  const overrides = { eventDate }
  const out = []
  if (contract.dateChangeFee) {
    out.push(option('move:fee-add', 'Move the date and add the change fee', `Contract date-change clause: "${contract.dateChangeFee.quote}"`, overrides, contract, today, { feeCents: contract.dateChangeFee.cents }))
  }
  out.push(option('move:fee-skip', 'Move the date without a fee', 'Waive the date-change fee for this move.', overrides, contract, today, { feeCents: 0 }))
  return out
}

// Triggers worth running for this contract right now.
export function dueUnpaidTriggers(contract, today) {
  const sched = schedFor(contract, today)
  return sched.steps
    .filter((s) => s.kind === 'installment' && s.pinned && !s.paid && s.dueDate <= today)
    .filter((s) => {
      const step = contract.steps.find((x) => x.id === s.id)
      // Reminders exist for invoices only; an unpaid deposit checkout has no reminder tool.
      return Boolean(step.invoice) && isPinned(step) && step.invoice.status !== 'PARTIALLY_PAID'
    })
    .map((s) => ({ kind: 'DUE_UNPAID', stepId: s.id }))
}
