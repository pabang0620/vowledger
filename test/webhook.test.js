import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeApproval } from '../server/services/approvals.js'
import { config } from '../server/config.js'
import { makeCtx, sampleContract, approveInvoices, pendingOf, startApp, settle } from './helpers.js'

async function post(app, path, body, headers = {}) {
  const res = await fetch(`${app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

test('webhook route: unsigned deliveries are refused, signed ones are handled once', async () => {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  const p1 = contract.steps[0]
  await ctx.invoicing.simulateBuyerPayment(p1.invoice.id)
  await settle()
  const app = await startApp(ctx)
  try {
    const event = { id: 'WH-HTTP-1', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: p1.invoice.id } } }
    const base = `http://127.0.0.1:${new URL(app.url).port}`
    const wrap = { base }
    const refused = await post(wrap, '/api/webhooks/paypal', event)
    assert.equal(refused.status, 401)
    const wrong = await post(wrap, '/api/webhooks/paypal', event, { 'x-mock-webhook-secret': 'nope' })
    assert.equal(wrong.status, 401)
    const ok = await post(wrap, '/api/webhooks/paypal', event, { 'x-mock-webhook-secret': config.mockWebhookSecret })
    assert.equal(ok.status, 200)
    const again = await post(wrap, '/api/webhooks/paypal', event, { 'x-mock-webhook-secret': config.mockWebhookSecret })
    assert.equal(again.body.data.duplicate, true)
    assert.equal(contract.proposals.length, 1)
  } finally {
    await app.close()
  }
})

test('input validation: bad ids, dates and bodies are 400, unknown sample is 400', async () => {
  const ctx = makeCtx()
  const app = await startApp(ctx)
  try {
    const session = (await app.call('POST', '/api/session')).body.data.sessionId
    assert.equal((await app.call('POST', '/api/contracts', { session, body: {} })).status, 400)
    assert.equal((await app.call('POST', '/api/contracts', { session, body: { sample: 'Z' } })).status, 400)
    assert.equal((await app.call('POST', '/api/contracts', { session, body: { text: 'too short' } })).status, 400)
    assert.equal((await app.call('GET', '/api/contracts/not-a-uuid', { session })).status, 400)
    assert.equal((await app.call('GET', '/api/contracts', { session: 'not-a-uuid' })).status, 400)
    assert.equal((await app.call('POST', '/api/dev/fail-next', { session, body: { op: 'delete' } })).status, 400)
  } finally {
    await app.close()
  }
})

test('a temporary invoice lookup failure allows redelivery to release the held task once', async () => {
  const ctx = makeCtx()
  ctx.invoicing.setWebhookSink(() => {})
  const { session, contract } = await sampleContract(ctx, 'A')
  await approveInvoices(ctx, session, contract)
  const [apply] = pendingOf(contract, 'APPLY_PROPOSAL')
  await executeApproval(ctx, session, contract.id, apply.id)
  const invoice = contract.steps.find((step) => step.id === 'p2').invoice
  assert.equal(contract.adjustments.t2.untilStep, 'p2')
  ctx.setToday('2026-11-20')
  await ctx.invoicing.simulateBuyerPayment(invoice.id)
  const originalGet = ctx.invoicing.getInvoice.bind(ctx.invoicing)
  let reads = 0
  ctx.invoicing.getInvoice = async (id) => {
    reads += 1
    if (reads === 1) throw new Error('Temporary invoice lookup failure')
    return originalGet(id)
  }
  const app = await startApp(ctx)
  const body = { id: 'WH-RETRY-HELD', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoice.id } } }
  const deliver = () => post(app, '/api/webhooks/paypal', body, { 'x-mock-webhook-secret': config.mockWebhookSecret })
  try {
    assert.ok((await deliver()).status >= 500)
    assert.equal(contract.adjustments.t2.untilStep, 'p2')
    const deliveries = await Promise.all([deliver(), deliver()])
    assert.ok(deliveries.every((d) => d.status === 200))
    assert.equal(deliveries.filter((d) => d.body.data.duplicate).length, 1)
    assert.equal(reads, 2)
    assert.equal(invoice.status, 'PAID')
    assert.equal(contract.adjustments.t2.untilStep, undefined)
    assert.equal(contract.activity.filter((a) => a.text.startsWith('Hold released:')).length, 1)
  } finally {
    await app.close()
  }
})
