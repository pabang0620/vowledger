import { HttpError } from '../store.js'
import { computeSchedule, extendConflict, withExtension } from '../schedule/engine.js'
import { diffPaypal } from '../schedule/diffPaypal.js'
import { modelOf } from '../schedule/model.js'
import { shortLabel } from '../dates.js'
import { logActivity } from './contracts.js'
import { newApproval } from './approvalFactory.js'

// Entrance 3: the photographer dragged one scheduled payment to a later day. Like a wedding move it only drafts a card;
// the PUT happens after approval, with the same executor path and the same lock.
export function prepareExtend(ctx, contract, stepId, dueDate) {
  const today = ctx.today()
  const model = modelOf(contract)
  const conflict = extendConflict(model, stepId, dueDate, today)
  if (conflict) throw new HttpError(409, conflict)
  for (const a of contract.approvals.values()) if ((a.type === 'EXTEND_DUE' || a.type === 'MOVE_EVENT') && a.status === 'pending') a.status = 'cancelled'
  const step = contract.steps.find((s) => s.id === stepId)
  const preview = computeSchedule(withExtension(model, stepId, dueDate), today)
  const diff = diffPaypal(contract, preview, { today })
  const before = computeSchedule(model, today).steps.find((s) => s.id === stepId).dueDate
  const [id, approval] = newApproval(contract, {
    type: 'EXTEND_DUE',
    title: `Extend ${step.invoice.number} due ${shortLabel(before)} -> ${shortLabel(dueDate)}?`,
    versioned: true,
    lines: diff.changes.map((c) => ({ text: c.text, kind: c.kind, stepId: c.stepId })),
    unchanged: diff.unchanged.map((u) => ({ text: `${u.invoiceNumber} ${u.label} ${u.status}`, stepId: u.stepId })),
    note: `The client asked for more time on "${step.label}". Later payments keep their order and the PayPal invoice is edited with a PUT.`,
    approveLabel: `Approve ${diff.changes.length} PayPal change${diff.changes.length === 1 ? '' : 's'}`,
    payload: { private: { stepId, dueDate }, public: { stepId, dueDate } },
    previewSchedule: preview,
  })
  contract.approvals.set(id, approval)
  logActivity(contract, { actor: 'agent', text: `Drafted an extension of ${step.invoice.number} to ${dueDate}: ${diff.changes.length} PayPal change(s)`, approvalId: id })
  return approval
}
