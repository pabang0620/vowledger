// Badge words for the deposit checkout (PayPal Orders), shown with the same pills as invoice statuses.
// The order's own statuses are CREATED, APPROVED and COMPLETED; the badge says what that means for the photographer.
export function depositLabel(step) {
  const d = step.deposit
  if (!d) return step.depositUnknown ? 'CHECKING' : 'NONE'
  if (d.unknown) return 'CHECKING'
  if (d.status === 'COMPLETED') return 'CAPTURED'
  if (d.status === 'APPROVED') return 'APPROVED'
  if (d.status === 'VOIDED') return 'VOIDED'
  return 'ORDER_CREATED'
}

// How a step is named in the activity log: the invoice number, or "Deposit".
export function payRef(step) {
  return step.invoice?.number || (step.deposit || step.via === 'order' ? 'Deposit' : step.label)
}
