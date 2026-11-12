// What PayPal will be asked to do when a card is approved, one line per call. Read from the card's own lines;
// the executors on the server (services/approvals.js, invoiceOps.js) make exactly these calls.
export function paypalCalls(approval, steps) {
  const invoiceId = (stepId) => steps.find((s) => s.id === stepId)?.invoice?.id || '{id}'
  if (approval.type === 'REMINDER') return [`send_invoice_reminder ${invoiceId(approval.payload?.stepId)}`]
  if (approval.type === 'RECORD_PAYMENT') return ['record_payment_for_invoice']
  return approval.lines.flatMap((l) => {
    if (l.op === 'deposit') return ['POST /v2/checkout/orders']
    if (l.kind === 'edit') return [`PUT /v2/invoicing/invoices/${invoiceId(l.stepId)}`, ...(l.detail?.sendNow ? ['send_invoice'] : [])]
    if (l.kind === 'create_fee' || l.op === 'create') return ['POST /v2/invoicing/invoices + send_invoice']
    return []
  })
}
