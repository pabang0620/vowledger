import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/config.js'
import { makeCtx, sampleContract, approveInvoices, startApp, settle } from './helpers.js'

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
