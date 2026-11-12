import { randomBytes } from 'node:crypto'
import { config } from '../../config.js'
import { money2 } from '../../schedule/compute.js'
import { PayPalError } from '../mockPaypal.js'
import { OutcomeUnknownError } from './errors.js'
import { normalizeOrder } from './normalize.js'

// Mock of Orders v2 with the SDK's `Order` model shape (camelCase members, links with rel and href).
// Same rules as PayPal: an order is captured only after the payer approved it, and a replayed
// PayPal-Request-Id returns the original answer instead of acting twice.

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const block = (n) => Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join('')

export function createMockOrders({ appBaseUrl = config.appBaseUrl } = {}) {
  const orders = new Map()
  const answers = new Map()
  const calls = []
  let failNext = null
  let loseNext = null

  const record = (op, id) => calls.push({ op, id: id || null })

  function maybeFail(op) {
    if (failNext && (failNext.op === op || failNext.op === '*')) {
      const f = failNext
      failNext = null
      throw new PayPalError(f.status || 422, 'UNPROCESSABLE_ENTITY', f.issue || 'ORDER_NOT_APPROVED', '(simulated failure)')
    }
  }

  // The write happened, the answer is lost on the way back.
  function maybeLose(op, what) {
    if (loseNext === op) {
      loseNext = null
      throw new OutcomeUnknownError(what)
    }
  }

  function need(id) {
    const order = orders.get(id)
    if (!order) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID')
    return order
  }

  // What PayPal's `Prefer: return=minimal` returns for create and capture: id, status, links.
  const minimal = (order) => structuredClone({ id: order.id, status: order.status, links: order.links })
  const full = (order) => structuredClone({ id: order.id, status: order.status, intent: order.intent, createTime: order.createTime, purchaseUnits: order.purchaseUnits, links: order.links })

  return {
    calls,
    orders,
    failNext(spec) { failNext = spec },
    loseNextResponse(op) { loseNext = op },
    reset() { orders.clear(); answers.clear(); calls.length = 0; failNext = null; loseNext = null },

    // POST /v2/checkout/orders
    async createOrder({ amountCents, currency = 'USD', referenceId, description, customId, brandName, returnUrl, cancelUrl, requestId }) {
      record('create')
      maybeFail('create')
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INVALID_PARAMETER_VALUE', 'amount')
      if (requestId && answers.has(`create:${requestId}`)) {
        const again = orders.get(answers.get(`create:${requestId}`))
        maybeLose('create', 'deposit order creation')
        return normalizeOrder(minimal(again))
      }
      const id = `${block(8)}${block(9)}`
      const order = {
        id,
        status: 'CREATED',
        intent: 'CAPTURE',
        createTime: new Date().toISOString(),
        purchaseUnits: [{ referenceId, amount: { currencyCode: currency, value: money2(amountCents) }, description, customId }],
        links: [
          { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
          { href: `${appBaseUrl}/mock-paypal/checkout?token=${id}`, rel: 'payer-action', method: 'GET' },
        ],
        context: { brandName, returnUrl, cancelUrl },
      }
      orders.set(id, order)
      if (requestId) answers.set(`create:${requestId}`, id)
      maybeLose('create', 'deposit order creation')
      return normalizeOrder(minimal(order))
    },

    async getOrder(id) {
      record('get', id)
      return normalizeOrder(full(need(id)))
    },

    // POST /v2/checkout/orders/{id}/capture. 422 ORDER_NOT_APPROVED until the payer approved.
    async captureOrder(id, { requestId } = {}) {
      record('capture', id)
      maybeFail('capture')
      const order = need(id)
      if (requestId && answers.has(`capture:${requestId}`)) {
        maybeLose('capture', 'deposit capture')
        return normalizeOrder(minimal(order))
      }
      if (order.status === 'COMPLETED') throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED')
      if (order.status !== 'APPROVED') throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED')
      const unit = order.purchaseUnits[0]
      order.status = 'COMPLETED'
      unit.payments = { captures: [{ id: `CAP-${block(14)}`, status: 'COMPLETED', amount: { ...unit.amount } }] }
      if (requestId) answers.set(`capture:${requestId}`, id)
      maybeLose('capture', 'deposit capture')
      return normalizeOrder(minimal(order))
    },

    // Mock only: the payer approving on the PayPal page. Returns where PayPal would send the browser.
    simulateApprove(id) {
      record('payer_approves', id)
      const order = need(id)
      if (order.status !== 'CREATED') throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVABLE', `status is ${order.status}`)
      order.status = 'APPROVED'
      return { returnUrl: order.context.returnUrl, cancelUrl: order.context.cancelUrl }
    },

    // Mock only: what the checkout page shows.
    checkoutView(id) {
      const order = need(id)
      return { id, status: order.status, amount: order.purchaseUnits[0].amount, brandName: order.context.brandName, description: order.purchaseUnits[0].description, cancelUrl: order.context.cancelUrl }
    },
  }
}
