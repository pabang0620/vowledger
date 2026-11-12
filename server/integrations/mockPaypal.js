import { randomBytes } from 'node:crypto'
import { todayIso, diffDays } from '../dates.js'

// Mock of PayPal Invoicing v2. Same paths, bodies and statuses as the sandbox; no network.
// Statuses follow the REST reference: DRAFT, SCHEDULED, SENT, UNPAID, PARTIALLY_PAID, PAID, MARKED_AS_PAID, CANCELLED.

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const block = () => Array.from(randomBytes(4), (b) => ALNUM[b % ALNUM.length]).join('')

export class PayPalError extends Error {
  constructor(status, name, issue, message) {
    super(`PayPal ${name}: ${issue} (${status})${message ? ` ${message}` : ''}`)
    this.status = status
    this.paypalName = name
    this.issue = issue
  }
}

export function createMockPaypal({ today = todayIso, onWebhook = () => {} } = {}) {
  const invoices = new Map()
  // Numbers used by other apps on the same business account (mock only, set by reserveInvoiceNumbers).
  const takenNumbers = new Set()
  const requests = new Map()
  const calls = []
  let failNext = null
  let eventCounter = 0
  let todayFn = today

  const record = (op, id) => calls.push({ op, id: id || null })

  function maybeFail(op, id) {
    if (failNext && (failNext.op === op || failNext.op === '*') && (!failNext.invoiceId || failNext.invoiceId === id) && (!failNext.appliesTo || failNext.appliesTo(id))) {
      const f = failNext
      failNext = null
      throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', f.issue || 'INVALID_INVOICE_DATE', '(simulated failure)')
    }
  }

  function need(id) {
    const inv = invoices.get(id)
    if (!inv) throw new PayPalError(404, 'INVALID_RESOURCE_ID', 'INVALID_RESOURCE_ID')
    tick(inv)
    return inv
  }

  // PayPal sends a SCHEDULED invoice by itself when its issue date arrives.
  function tick(inv) {
    if (inv.status === 'SCHEDULED' && inv.detail.invoice_date <= todayFn()) inv.status = 'SENT'
  }

  function validateBody(body) {
    const missing = []
    if (!body?.detail?.invoice_date) missing.push('/detail/invoice_date')
    if (!body?.detail?.payment_term?.due_date) missing.push('/detail/payment_term/due_date')
    if (!body?.items?.length) missing.push('/items')
    if (!body?.primary_recipients?.length) missing.push('/primary_recipients')
    if (missing.length) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'MISSING_REQUIRED_PARAMETER', missing.join(', '))
    if (body.detail.payment_term.due_date < body.detail.invoice_date) {
      throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'DUE_DATE_BEFORE_INVOICE_DATE')
    }
  }

  function totalOf(body) {
    return body.items.reduce((sum, i) => sum + Math.round(Number(i.unit_amount.value) * 100) * Number(i.quantity || 1), 0)
  }

  const moneyOf = (cents) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) })

  function view(inv) {
    const total = totalOf(inv)
    const paid = inv.payments.reduce((s, p) => s + p.cents, 0)
    return structuredClone({
      id: inv.id,
      status: inv.status,
      detail: { ...inv.detail, metadata: { create_time: inv.createdAt, recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${inv.id}` } },
      invoicer: inv.invoicer,
      primary_recipients: inv.primary_recipients,
      items: inv.items,
      configuration: inv.configuration,
      amount: moneyOf(total),
      due_amount: moneyOf(Math.max(0, total - paid)),
      payments: { paid_amount: moneyOf(paid), transactions: inv.payments.map((p) => ({ payment_id: p.id, method: p.method, payment_date: p.date, amount: moneyOf(p.cents) })) },
      links: [{ rel: 'self', href: `/v2/invoicing/invoices/${inv.id}`, method: 'GET' }],
    })
  }

  function emit(eventType, inv) {
    eventCounter += 1
    const event = {
      id: `WH-${block()}${block()}-${eventCounter}`,
      event_type: eventType,
      create_time: new Date().toISOString(),
      resource_type: 'invoices',
      resource: { invoice: { id: inv.id, status: inv.status, detail: { invoice_number: inv.detail.invoice_number } } },
    }
    setImmediate(() => onWebhook(event))
  }

  const api = {
    calls,
    invoices,
    setToday(fn) { todayFn = fn },
    setWebhookSink(fn) { onWebhook = fn },
    failNext(spec) { failNext = spec },
    reset() { invoices.clear(); requests.clear(); calls.length = 0; failNext = null; eventCounter = 0 },

    // POST /v2/invoicing/invoices -> 201 with a self link. PayPal-Request-Id makes the call idempotent.
    async createInvoice(body, { requestId } = {}) {
      record('create')
      maybeFail('create')
      validateBody(body)
      if (requestId && requests.has(requestId)) return structuredClone(requests.get(requestId))
      const number = body.detail?.invoice_number
      if (number && (takenNumbers.has(number) || [...invoices.values()].some((i) => i.detail?.invoice_number === number))) {
        throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'DUPLICATE_INVOICE_NUMBER')
      }
      const id = `INV2-${block()}-${block()}-${block()}-${block()}`
      invoices.set(id, { ...structuredClone(body), id, status: 'DRAFT', payments: [], createdAt: new Date().toISOString() })
      const res = { rel: 'self', href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}`, method: 'GET', id }
      if (requestId) requests.set(requestId, res)
      emit('INVOICING.INVOICE.CREATED', invoices.get(id))
      return structuredClone(res)
    },

    // POST /v2/invoicing/invoices/{id}/send. Issue date in the future -> SCHEDULED, else SENT.
    async sendInvoice(id) {
      record('send', id)
      maybeFail('send', id)
      const inv = need(id)
      if (!['DRAFT', 'SCHEDULED'].includes(inv.status)) return { status: inv.status }
      inv.status = inv.detail.invoice_date > todayFn() ? 'SCHEDULED' : 'SENT'
      if (inv.status === 'SCHEDULED') emit('INVOICING.INVOICE.SCHEDULED', inv)
      return { status: inv.status }
    },

    async getInvoice(id) {
      record('get', id)
      return view(need(id))
    },

    // PUT replaces the whole invoice. Omitted fields are cleared, so a partial body is rejected like PayPal does.
    async updateInvoice(id, body) {
      record('update', id)
      maybeFail('update', id)
      const inv = need(id)
      if (!['DRAFT', 'SCHEDULED'].includes(inv.status)) {
        throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INVOICE_NOT_EDITABLE', `status is ${inv.status}`)
      }
      validateBody(body)
      Object.assign(inv, structuredClone({ detail: body.detail, invoicer: body.invoicer, primary_recipients: body.primary_recipients, items: body.items, configuration: body.configuration }))
      emit('INVOICING.INVOICE.UPDATED', inv)
      return view(inv)
    },

    async deleteInvoice(id) {
      record('delete', id)
      const inv = need(id)
      if (!['DRAFT', 'SCHEDULED'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INVOICE_NOT_DELETABLE')
      invoices.delete(id)
      emit('INVOICING.INVOICE.CANCELLED', inv)
      return {}
    },

    // POST /v2/invoicing/invoices/{id}/payments: MARKED_AS_PAID when covered, PARTIALLY_PAID otherwise.
    async recordPayment(id, { amountCents, method = 'BANK_TRANSFER', note = '', date } = {}) {
      record('record_payment', id)
      maybeFail('record_payment', id)
      const inv = need(id)
      if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) {
        throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INVOICE_NOT_PAYABLE', `status is ${inv.status}`)
      }
      const total = totalOf(inv)
      const paid = inv.payments.reduce((s, p) => s + p.cents, 0)
      const cents = amountCents ?? total - paid
      if (!Number.isInteger(cents) || cents <= 0 || paid + cents > total) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INVALID_PAYMENT_AMOUNT')
      inv.payments.push({ id: `EXT-${block()}`, cents, method, note, date: date || todayFn() })
      inv.status = paid + cents === total ? 'MARKED_AS_PAID' : 'PARTIALLY_PAID'
      emit('INVOICING.INVOICE.PAID', inv)
      return { payment_id: inv.payments.at(-1).id }
    },

    // Mock only: another app on the same PayPal business account already used these invoice numbers.
    reserveInvoiceNumbers(numbers) {
      numbers.forEach((n) => takenNumbers.add(n))
    },

    // Mock only: the sandbox buyer paying through the PayPal-hosted page.
    async simulateBuyerPayment(id) {
      record('buyer_payment', id)
      const inv = need(id)
      if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INVOICE_NOT_PAYABLE', `status is ${inv.status}`)
      const total = totalOf(inv)
      const paid = inv.payments.reduce((s, p) => s + p.cents, 0)
      inv.payments.push({ id: `PAY-${block()}`, cents: total - paid, method: 'PAYPAL', date: todayFn() })
      inv.status = 'PAID'
      emit('INVOICING.INVOICE.PAID', inv)
      return { status: 'PAID' }
    },

    async sendReminder(id, { subject, note } = {}) {
      record('reminder', id)
      const inv = need(id)
      if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INVOICE_NOT_PAYABLE')
      inv.reminders = [...(inv.reminders || []), { subject, note, at: new Date().toISOString() }]
      return {}
    },

    daysUntilDue(id) {
      const inv = need(id)
      return diffDays(inv.detail.payment_term.due_date, todayFn())
    },
  }
  return api
}
