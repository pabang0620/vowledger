import { OrdersError, OutcomeUnknownError } from './errors.js'

// One plain shape for an SDK `Order`. Both the live adapter and the mock go through here.
const APPROVE_RELS = ['payer-action', 'approve']
const toCents = (value) => Math.round(Number(value) * 100)

export function normalizeOrder(order) {
  const unit = order.purchaseUnits?.[0]
  const capture = unit?.payments?.captures?.[0]
  const link = order.links?.find((l) => APPROVE_RELS.includes(l.rel))
  return {
    id: order.id,
    status: order.status,
    approveUrl: link?.href || null,
    amountCents: unit?.amount ? toCents(unit.amount.value) : null,
    currency: unit?.amount?.currencyCode || null,
    customId: unit?.customId || null,
    captureId: capture?.id || null,
    captureStatus: capture?.status || null,
  }
}

// Every Order member is optional on the wire, so a truncated success decodes cleanly. Guard what we rely on.
export function requireOrderFields(order, fields, { write, what }) {
  const missing = fields.filter((f) => !order[f])
  if (!missing.length) return order
  if (write) throw new OutcomeUnknownError(what)
  throw new OrdersError(502, 'UNREADABLE', 'PayPal answered with an unreadable order.')
}
