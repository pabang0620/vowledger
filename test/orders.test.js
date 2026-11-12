import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderRequestSchema, orderSchema, PaypalError } from 'paypal'
import { createLiveOrders } from '../server/integrations/orders/liveOrders.js'
import { OutcomeUnknownError } from '../server/integrations/orders/errors.js'
import { fakeSdk, script, json, orderWire, token, dropped } from './sdkFake.js'
import { makeCtx, sampleContract, approveInvoices, startApp } from './helpers.js'
import { createDeposit, captureDeposit } from '../server/services/deposits.js'

const request = { amountCents: 144000, referenceId: 'p1', description: 'Retainer', customId: 'vl-ref', brandName: 'Lena Park Photography', returnUrl: 'http://localhost:3002/api/deposit/return', cancelUrl: 'http://localhost:3002/api/deposit/cancel', requestId: 'vl-dep-1' }
const header = (call, name) => call.request.headers.get(name)

// A context whose Orders adapter is the real SDK adapter over a faked fetch.
async function liveCtx(...steps) {
  const sdk = fakeSdk(script(...steps))
  const ctx = makeCtx({ depositCheckout: true, orders: sdk.orders })
  const { session, contract } = await sampleContract(ctx, 'B')
  return { ctx, session, contract, sdk, step: contract.steps[0] }
}

test('createOrder sends the planned request and no key that a sheet row does not require', async () => {
  const sdk = fakeSdk(script(json(201, orderWire())))
  const order = await sdk.orders.createOrder(request)
  const [, create] = sdk.calls
  assert.equal(create.method, 'POST')
  assert.equal(create.path, '/v2/checkout/orders')
  assert.equal(header(create, 'paypal-request-id'), 'vl-dep-1')
  for (const h of ['paypal-mock-response', 'paypal-partner-attribution-id', 'paypal-client-metadata-id', 'paypal-auth-assertion']) assert.equal(header(create, h), null, h)
  const body = JSON.parse(create.body)
  assert.deepEqual(Object.keys(body).sort(), ['application_context', 'intent', 'purchase_units'])
  assert.deepEqual(Object.keys(body.application_context).sort(), ['brand_name', 'cancel_url', 'landing_page', 'return_url', 'shipping_preference', 'user_action'])
  assert.equal(body.application_context.shipping_preference, 'NO_SHIPPING')
  assert.equal(body.application_context.user_action, 'PAY_NOW')
  assert.equal(body.intent, 'CAPTURE')
  assert.deepEqual(body.purchase_units[0], { reference_id: 'p1', amount: { currency_code: 'USD', value: '1440.00' }, description: 'Retainer', custom_id: 'vl-ref' })
  orderRequestSchema.decode(body)
  assert.equal(order.approveUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345')
  assert.equal(order.amountCents, 144000)
  orderSchema.decode(orderWire())
})

test('the SDK client refuses any host but the sandbox', () => {
  assert.throws(() => createLiveOrders({ clientId: 'a', clientSecret: 'b', baseUrl: 'https://api-m.paypal.com' }), /Refusing PayPal host/)
})

test('the claim is in the store before the createOrder request leaves', async () => {
  let seen = null
  let ctxRef = null
  const { ctx, session, contract } = await (async () => {
    const sdk = fakeSdk(script((call) => {
      seen = ctxRef.store.getClaim(`deposit-create:${ctxRef.contract.id}:p1`)
      return json(201, orderWire())
    }))
    const ctx = makeCtx({ depositCheckout: true, orders: sdk.orders })
    const made = await sampleContract(ctx, 'B')
    ctxRef = { store: ctx.store, contract: made.contract }
    return { ctx, ...made }
  })()
  await approveInvoices(ctx, session, contract)
  assert.ok(seen, 'claim must exist when the request leaves')
  assert.equal(seen.state, 'claimed')
  assert.match(seen.ref, /^vl-dep-/)
  assert.equal(contract.steps[0].deposit.status, 'CREATED')
})

test('duplicate claim: a second createDeposit while one is running never reaches PayPal', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { ctx, contract, sdk, step } = await liveCtx(async () => { await gate; return json(201, orderWire()) })
  const first = createDeposit(ctx, contract, step)
  await new Promise((r) => setTimeout(r, 5))
  await assert.rejects(createDeposit(ctx, contract, step), (e) => e.status === 409)
  release()
  await first
  assert.equal(sdk.onlyOrderCalls().length, 1)
})

test('lost createOrder response: the replay with the same request id settles on one order', async () => {
  const { ctx, contract, sdk, step } = await liveCtx(dropped, json(201, orderWire()))
  await createDeposit(ctx, contract, step)
  const creates = sdk.onlyOrderCalls()
  assert.equal(creates.length, 2)
  assert.equal(header(creates[0], 'paypal-request-id'), header(creates[1], 'paypal-request-id'))
  assert.equal(step.deposit.orderId, 'ORDER12345')
  assert.equal(ctx.store.getClaim(`deposit-create:${contract.id}:p1`).state, 'done')
})

test('lost createOrder twice: reported unknown, claim kept, the next try replays the same id', async () => {
  const { ctx, contract, sdk, step } = await liveCtx(dropped, dropped, json(201, orderWire()))
  await assert.rejects(createDeposit(ctx, contract, step), (e) => e instanceof OutcomeUnknownError && e.unknown && /did not confirm/.test(e.message))
  assert.equal(step.deposit, null)
  assert.equal(step.depositUnknown, true)
  await createDeposit(ctx, contract, step)
  const ids = sdk.onlyOrderCalls().map((c) => header(c, 'paypal-request-id'))
  assert.equal(new Set(ids).size, 1)
  assert.equal(step.deposit.status, 'CREATED')
  assert.equal(step.depositUnknown, false)
})

test('a refused credential on createOrder sends nothing, does not replay, and frees the claim', async () => {
  const sdk = fakeSdk((call) => (call.path === '/v1/oauth2/token' ? json(401, { error: 'invalid_client' }) : json(500, {})))
  const ctx = makeCtx({ depositCheckout: true, orders: sdk.orders })
  const { contract } = await sampleContract(ctx, 'B')
  const step = contract.steps[0]
  await assert.rejects(createDeposit(ctx, contract, step), (e) => e.status === 502 && !e.unknown && /credentials/.test(e.message))
  assert.equal(sdk.onlyOrderCalls().length, 0)
  assert.equal(ctx.store.getClaim(`deposit-create:${contract.id}:p1`), null)
})

test('a refused 422 frees the claim and the reason reaches the caller', async () => {
  const body = { name: 'UNPROCESSABLE_ENTITY', message: 'bad', debug_id: 'dbg1', details: [{ issue: 'INVALID_CURRENCY_CODE', description: 'Currency code is invalid.' }] }
  const { ctx, contract, step } = await liveCtx(json(422, body), json(201, orderWire()))
  await assert.rejects(createDeposit(ctx, contract, step), (e) => e.status === 422 && /Currency code is invalid/.test(e.message) && e.debugId === 'dbg1')
  assert.equal(ctx.store.getClaim(`deposit-create:${contract.id}:p1`), null)
  await createDeposit(ctx, contract, step)
  assert.equal(step.depositAttempt, 2)
  assert.equal(step.deposit.status, 'CREATED')
})

test('status mapping: 401 and 403 are 502 with a fixed message, 429 is 503, 5xx is 502', async () => {
  for (const [status, want] of [[401, 502], [403, 502], [429, 503], [500, 502], [503, 502]]) {
    const sdk = fakeSdk(script(json(status, { name: 'X', message: 'secret internal text', debug_id: 'd' })))
    await assert.rejects(sdk.orders.getOrder('ORDER12345'), (e) => e.status === want && !/secret internal text/.test(e.message), `status ${status}`)
  }
})

test('a truncated success body is not reported as success', async () => {
  const sdk = fakeSdk(script(json(200, {}), json(201, {})))
  await assert.rejects(sdk.orders.getOrder('ORDER12345'), (e) => e.status === 502 && !e.unknown && /unreadable/.test(e.message))
  await assert.rejects(sdk.orders.createOrder(request), (e) => e instanceof OutcomeUnknownError)
})

test('a connection failure on a read is a plain 502, not an unknown outcome', async () => {
  const sdk = fakeSdk(script(dropped))
  await assert.rejects(sdk.orders.getOrder('ORDER12345'), (e) => e.status === 502 && !e.unknown)
})

test('an SDK error never puts its URL-bearing message on the wire', async () => {
  const sdk = fakeSdk(script(json(404, { name: 'RESOURCE_NOT_FOUND', message: 'nope', debug_id: 'dd', details: [{ issue: 'INVALID_RESOURCE_ID', description: 'Specified resource ID does not exist.' }] })))
  await assert.rejects(sdk.orders.getOrder('ORDER12345'), (e) => e.status === 404 && /Specified resource ID does not exist/.test(e.message) && !/api-m\.sandbox/.test(e.message))
  assert.ok(PaypalError)
})

async function approvedDeposit(...steps) {
  const made = await liveCtx(json(201, orderWire()), ...steps)
  await createDeposit(made.ctx, made.contract, made.step)
  return made
}

test('capture: reads the order first, then captures with its own request id', async () => {
  const { ctx, contract, step, sdk } = await approvedDeposit(json(200, orderWire({ status: 'APPROVED' })), json(201, orderWire({ status: 'COMPLETED', captured: true })))
  const result = await captureDeposit(ctx, contract, step)
  assert.equal(result.newlyPaid, true)
  const calls = sdk.onlyOrderCalls()
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /v2/checkout/orders', 'GET /v2/checkout/orders/ORDER12345', 'POST /v2/checkout/orders/ORDER12345/capture'])
  const capture = calls[2]
  assert.equal(header(capture, 'paypal-request-id'), 'vl-cap-ORDER12345')
  assert.equal(capture.body, '{}') // sandbox answers 415 without a JSON body (measured 2026-11-12)
  assert.match(header(capture, 'content-type') || '', /json/)
  assert.equal(step.deposit.status, 'COMPLETED')
  assert.equal(step.deposit.captureId, 'CAP1')
})

test('the capture claim is in the store before the request leaves, and a second capture never reaches PayPal', async () => {
  let seen = null
  let holder
  const { ctx, contract, step, sdk } = await approvedDeposit(json(200, orderWire({ status: 'APPROVED' })), () => { seen = holder.store.getClaim('deposit-capture:ORDER12345'); return json(201, orderWire({ status: 'COMPLETED', captured: true })) })
  holder = ctx
  await captureDeposit(ctx, contract, step)
  assert.equal(seen.state, 'claimed')
  const before = sdk.calls.length
  const again = await captureDeposit(ctx, contract, step)
  assert.equal(again.captured, true)
  assert.equal(sdk.calls.length, before)
})

test('lost captureOrder response: getOrder shows COMPLETED and there is no second capture', async () => {
  const { ctx, contract, step, sdk } = await approvedDeposit(json(200, orderWire({ status: 'APPROVED' })), dropped, json(200, orderWire({ status: 'COMPLETED', captured: true })))
  await captureDeposit(ctx, contract, step)
  const calls = sdk.onlyOrderCalls()
  assert.equal(calls.filter((c) => c.path.endsWith('/capture')).length, 1)
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2)
  assert.equal(step.deposit.status, 'COMPLETED')
})

test('lost captureOrder response, order still APPROVED: replay with the same request id', async () => {
  const { ctx, contract, step, sdk } = await approvedDeposit(json(200, orderWire({ status: 'APPROVED' })), dropped, json(200, orderWire({ status: 'APPROVED' })), json(201, orderWire({ status: 'COMPLETED', captured: true })))
  await captureDeposit(ctx, contract, step)
  const captures = sdk.onlyOrderCalls().filter((c) => c.path.endsWith('/capture'))
  assert.equal(captures.length, 2)
  assert.equal(header(captures[0], 'paypal-request-id'), header(captures[1], 'paypal-request-id'))
})

test('lost captureOrder twice: unknown, badge says CHECKING, nothing is reported as failed', async () => {
  const { ctx, contract, step } = await approvedDeposit(json(200, orderWire({ status: 'APPROVED' })), dropped, json(200, orderWire({ status: 'APPROVED' })), dropped)
  await assert.rejects(captureDeposit(ctx, contract, step), (e) => e instanceof OutcomeUnknownError)
  assert.equal(step.deposit.unknown, true)
  assert.equal(ctx.store.getClaim('deposit-capture:ORDER12345').state, 'unknown')
  assert.equal(contract.activity.some((a) => /capture failed/.test(a.text)), false)
})

test('a refused credential on captureOrder sends nothing and is not an unknown outcome', async () => {
  const sdk = fakeSdk((call) => (call.path === '/v1/oauth2/token' ? json(401, { error: 'invalid_client' }) : json(500, {})))
  await assert.rejects(sdk.orders.captureOrder('ORDER12345', { requestId: 'r' }), (e) => !e.unknown && e.status === 502)
  assert.equal(sdk.onlyOrderCalls().length, 0)
})

test('capture is refused when the order amount differs from the schedule', async () => {
  const { ctx, contract, step, sdk } = await approvedDeposit(json(200, orderWire({ status: 'APPROVED', cents: 100 })))
  await assert.rejects(captureDeposit(ctx, contract, step), (e) => e.status === 409 && /Nothing was captured/.test(e.message))
  assert.equal(sdk.onlyOrderCalls().filter((c) => c.path.endsWith('/capture')).length, 0)
})

test('capture before the payer approved is refused and PayPal is not asked to capture', async () => {
  const { ctx, contract, step, sdk } = await approvedDeposit(json(200, orderWire({ status: 'CREATED' })))
  await assert.rejects(captureDeposit(ctx, contract, step), (e) => e.status === 409)
  assert.equal(sdk.onlyOrderCalls().filter((c) => c.path.endsWith('/capture')).length, 0)
})

test('createDeposit refuses a later milestone and never calls PayPal', async () => {
  const { ctx, contract, sdk } = await liveCtx()
  await assert.rejects(createDeposit(ctx, contract, contract.steps[1]), (e) => e.status === 409)
  assert.equal(sdk.calls.length, 0)
  assert.equal(ctx.store.getClaim(`deposit-create:${contract.id}:p2`), null)
})

test('HTTP: a PayPal 404 reason reaches the response of the capture route', async () => {
  const { ctx, session, contract } = await approvedDeposit(json(404, { name: 'RESOURCE_NOT_FOUND', message: 'nope', debug_id: 'd1', details: [{ issue: 'INVALID_RESOURCE_ID', description: 'Specified resource ID does not exist.' }] }))
  const app = await startApp(ctx)
  try {
    const res = await app.call('POST', `/api/contracts/${contract.id}/deposit/capture`, { session: session.id })
    assert.equal(res.status, 404)
    assert.match(res.body.message, /Specified resource ID does not exist/)
  } finally {
    await app.close()
  }
})
