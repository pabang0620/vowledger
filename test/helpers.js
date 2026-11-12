import express from 'express'
import { createContext } from '../server/context.js'
import { createMockPaypal } from '../server/integrations/mockPaypal.js'
import { createMockOrders } from '../server/integrations/orders/mockOrders.js'
import { createApi, errorHandler } from '../server/routes.js'
import { handleInvoiceEvent } from '../server/services/triggers.js'
import { runMockAgent } from '../server/agent/mockAgent.js'
import { readContract } from '../server/contracts/extract.js'
import { sampleFor, sampleContractText } from '../server/contracts/samples.js'
import { createContract, publicContract } from '../server/services/contracts.js'
import { requestInvoices, executeApproval } from '../server/services/approvals.js'

export const TODAY = '2026-11-12'

// A full context on a fixed day with its own mock PayPal. Webhooks flow into the real handler.
// depositCheckout is off by default so the invoice-only tests keep their meaning; deposit tests turn it on.
export function makeCtx({ today = TODAY, agent, depositCheckout = false, orders } = {}) {
  const state = { today }
  const paypal = createMockPaypal({ today: () => state.today })
  const mockOrders = createMockOrders({ appBaseUrl: 'http://localhost:3002' })
  const ctx = createContext({ invoicing: paypal, orders: orders || mockOrders, depositCheckout, appBaseUrl: 'http://localhost:3002', today: () => state.today, agent: agent || { decide: runMockAgent } })
  ctx.mockOrders = mockOrders
  paypal.setWebhookSink((event) => handleInvoiceEvent(ctx, event).catch(() => {}))
  ctx.setToday = (d) => { state.today = d }
  return ctx
}

// Webhooks reach the handler through setImmediate; give them room when several test files run at once.
export const settle = () => new Promise((r) => setTimeout(r, 150))

export async function sampleContract(ctx, key = 'B') {
  const session = ctx.store.createSession()
  const { text } = sampleContractText(sampleFor(key), ctx.today())
  const { read, steps } = await readContract(text)
  const contract = createContract(ctx, session, { read, steps, text })
  requestInvoices(ctx, contract)
  return { session, contract }
}

export function pendingOf(contract, type) {
  return [...contract.approvals.values()].filter((a) => a.type === type && a.status === 'pending')
}

export async function approveInvoices(ctx, session, contract) {
  const [card] = pendingOf(contract, 'CREATE_INVOICES')
  return executeApproval(ctx, session, contract.id, card.id)
}

export async function startApp(ctx) {
  const app = express()
  app.use(express.json())
  app.use('/api', createApi(ctx))
  app.use(errorHandler)
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, { session, body } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(session ? { 'x-session-id': session } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  return { call, url: base, base, close: () => new Promise((r) => server.close(r)) }
}

export { publicContract }
