import { dueForPaypal } from './engine.js'
import { shortLabel } from '../dates.js'
import { usd } from './compute.js'
import { depositLabel } from './depositStatus.js'

// What must change at PayPal so the invoices match a schedule. Pinned invoices (sent or paid) are never touched.
// Compares the wanted dates with what PayPal holds now (invoice.remote), not with the previous plan.

export function diffPaypal(contract, schedule, { today, feeCents = 0, feeQuote = '' } = {}) {
  const changes = []
  const unchanged = []
  for (const sstep of schedule.steps) {
    const step = contract.steps.find((s) => s.id === sstep.id)
    if (step?.deposit && sstep.pinned) {
      unchanged.push({ stepId: step.id, label: step.label, amountCents: step.amountCents, invoiceNumber: 'Deposit', status: depositLabel(step) })
      continue
    }
    if (!step?.invoice) continue
    const inv = step.invoice
    if (sstep.pinned) {
      unchanged.push({ stepId: step.id, label: step.label, amountCents: step.amountCents, invoiceNumber: inv.number, status: inv.status })
      continue
    }
    const wantIssue = sstep.issueDate
    const wantDue = dueForPaypal(sstep.dueDate, today)
    if (inv.remote.issueDate === wantIssue && inv.remote.dueDate === wantDue) continue
    changes.push({
      kind: 'edit',
      stepId: step.id,
      label: step.label,
      amountCents: step.amountCents,
      invoiceNumber: inv.number,
      invoiceId: inv.id,
      sendNow: sstep.sendNow,
      from: { issueDate: inv.remote.issueDate, dueDate: inv.remote.dueDate },
      to: { issueDate: wantIssue, dueDate: wantDue },
      text: `${inv.number} ${step.label} ${usd(step.amountCents)}  ${sstep.sendNow ? 'send now' : `send ${shortLabel(inv.remote.issueDate)} -> ${shortLabel(wantIssue)}`} · due ${shortLabel(inv.remote.dueDate)} -> ${shortLabel(wantDue)}`,
    })
  }
  if (feeCents > 0) {
    changes.push({
      kind: 'create_fee',
      stepId: 'fee',
      label: 'Date change fee',
      amountCents: feeCents,
      sendNow: true,
      quote: feeQuote,
      text: `NEW Date change fee ${usd(feeCents)} send now`,
    })
  }
  return { changes, unchanged }
}

// Card lines for an approval: the text plus the structured before/after the approval panel draws.
export const changeLine = (c) => ({ text: c.text, kind: c.kind, stepId: c.stepId, detail: { invoiceNumber: c.invoiceNumber || null, label: c.label, amountCents: c.amountCents, sendNow: Boolean(c.sendNow), from: c.from || null, to: c.to || null } })
export const unchangedDetail = (u) => ({ invoiceNumber: u.invoiceNumber, label: u.label, amountCents: u.amountCents, status: u.status })
