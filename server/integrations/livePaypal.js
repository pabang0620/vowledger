import { randomBytes } from 'node:crypto'
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai'
import { config } from '../config.js'
import { PayPalError } from './mockPaypal.js'
import { SANDBOX_BASE } from './paypalHost.js'

// Sandbox PayPal. Create and PUT go through REST because the Agent Toolkit create_invoice has no
// payment_term / due_date field and update_invoicing would clear it (PUT replaces the whole invoice).
// Send, get, delete, reminder and record payment go through the Toolkit.
// Nothing here runs without PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.

const API_BASE = SANDBOX_BASE

const ACTIONS = { invoices: { get: true, send: true, delete: true, sendReminder: true, recordPayment: true } }
let toolkitTools = null
let toolkit = null
let callCounter = 0

function getToolkit() {
  if (!toolkit) {
    // context.sandbox must be true or the toolkit talks to the live PayPal API.
    toolkit = new PayPalAgentToolkit({ clientId: config.paypalClientId, clientSecret: config.paypalClientSecret, configuration: { actions: ACTIONS, context: { sandbox: true } } })
    toolkitTools = new Map(toolkit.getTools().map((t) => [t.function.name, t.function]))
  }
  return toolkit
}

async function toolkitCall(name, args) {
  getToolkit()
  if (!toolkitTools.has(name)) throw new Error(`PayPal toolkit tool ${name} is not enabled`)
  callCounter += 1
  const result = await toolkit.handleToolCall({ id: `call_${callCounter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const parsed = result.content ? JSON.parse(result.content) : {}
  if (parsed && parsed.error) {
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || JSON.stringify(parsed.error)
    throw new PayPalError(422, name, message)
  }
  return parsed
}

let token = { value: null, expires: 0 }

async function accessToken() {
  if (token.value && Date.now() < token.expires - 60000) return token.value
  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64')
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new PayPalError(401, 'oauth', 'unauthorized')
  const data = await res.json()
  token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 }
  return token.value
}

async function rest(method, path, body, requestId) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId || randomBytes(12).toString('hex'),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) throw new PayPalError(res.status, data.name || 'ERROR', data.details?.[0]?.issue || data.message || String(res.status))
  return data
}

const idFromHref = (href) => href.split('/').pop()

export const livePaypal = {
  async createInvoice(body, { requestId } = {}) {
    const link = await rest('POST', '/v2/invoicing/invoices', body, requestId)
    return { ...link, id: idFromHref(link.href) }
  },
  sendInvoice: (id) => toolkitCall('send_invoice', { invoice_id: id, send_to_recipient: true }),
  getInvoice: (id) => toolkitCall('get_invoice', { invoice_id: id }),
  // Caller must pass the complete body (fresh get_invoice result with the new dates).
  async updateInvoice(id, body) {
    await rest('PUT', `/v2/invoicing/invoices/${id}`, body)
    return toolkitCall('get_invoice', { invoice_id: id })
  },
  deleteInvoice: (id) => toolkitCall('delete_invoice', { invoice_id: id }),
  recordPayment: (id, { amountCents, method = 'BANK_TRANSFER', note = '', date }) =>
    toolkitCall('record_payment_for_invoice', {
      invoice_id: id,
      method,
      note,
      payment_date: date,
      amount: amountCents === undefined ? undefined : { currency_code: 'USD', value: (amountCents / 100).toFixed(2) },
    }),
  sendReminder: (id, { subject, note }) => toolkitCall('send_invoice_reminder', { invoice_id: id, subject, note }),

  // POST /v1/notifications/verify-webhook-signature. Needs PAYPAL_WEBHOOK_ID.
  async verifyWebhook(headers, event) {
    if (!config.paypalWebhookId) return false
    const result = await rest('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypalWebhookId,
      webhook_event: event,
    })
    return result.verification_status === 'SUCCESS'
  },
}
