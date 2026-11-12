import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, sampleContract, approveInvoices, pendingOf, startApp, settle } from './helpers.js'
import { executeApproval } from '../server/services/approvals.js'
import { prepareMove } from '../server/services/triggers.js'
import { publicContract } from '../server/services/contracts.js'
import { computeSchedule, isPinned } from '../server/schedule/engine.js'
import { modelOf } from '../server/schedule/model.js'
import { createMockOrders } from '../server/integrations/orders/mockOrders.js'
import { mockCheckoutRouter } from '../server/integrations/orders/mockCheckout.js'

async function depositB() {
  const ctx = makeCtx({ depositCheckout: true })
  const { session, contract } = await sampleContract(ctx, 'B')
  return { ctx, session, contract, step: contract.steps[0] }
}

// What the payer's browser does: approve on the checkout page, then follow PayPal's redirect to our return URL.
async function payerReturns(app, ctx, orderId) {
  ctx.mockOrders.simulateApprove(orderId)
  const res = await fetch(`${app.base}/api/deposit/return?token=${orderId}&PayerID=MOCKPAYER`, { redirect: 'manual' })
  return { status: res.status, location: res.headers.get('location') }
}

test('deposit path: the first card lists the checkout and two invoices, nothing reaches PayPal before approval', async () => {
  const { ctx, contract } = await depositB()
  const [card] = pendingOf(contract, 'CREATE_INVOICES')
  assert.equal(card.title, 'Create the deposit checkout and 2 PayPal invoices?')
  assert.equal(card.lines.length, 3)
  assert.match(card.lines[0].text, /^Deposit \$1,440 {2}PayPal checkout link/)
  assert.equal(ctx.mockOrders.calls.length + ctx.invoicing.calls.length, 0)
})

test('approval creates one order for the deposit and invoices only for the later milestones', async () => {
  const { ctx, session, contract, step } = await depositB()
  await approveInvoices(ctx, session, contract)
  assert.equal(ctx.mockOrders.orders.size, 1)
  assert.equal(ctx.invoicing.invoices.size, 2)
  assert.equal(step.invoice, null)
  assert.equal(step.deposit.status, 'CREATED')
  assert.match(step.deposit.approveUrl, /\/mock-paypal\/checkout\?token=/)
  const order = [...ctx.mockOrders.orders.values()][0]
  assert.equal(order.purchaseUnits[0].amount.value, '1440.00')
  assert.equal(order.context.returnUrl, 'http://localhost:3002/api/deposit/return')
  const view = publicContract(ctx, contract)
  const row = view.gantt.rows.find((r) => r.id === 'p1')
  assert.equal(row.badge.status, 'ORDER_CREATED')
  assert.equal(row.badge.type, 'order')
  assert.equal(view.steps[0].deposit.status, 'ORDER_CREATED')
})

test('a card cannot create two deposit orders, even from two tabs', async () => {
  const { ctx, session, contract } = await depositB()
  const [card] = pendingOf(contract, 'CREATE_INVOICES')
  await Promise.allSettled([executeApproval(ctx, session, contract.id, card.id), executeApproval(ctx, session, contract.id, card.id)])
  assert.equal(ctx.mockOrders.orders.size, 1)
  assert.equal([...ctx.mockOrders.calls].filter((c) => c.op === 'create').length, 1)
})

test('return after the payer approved: the server captures, the badge says CAPTURED, the agent runs', async () => {
  const { ctx, session, contract, step } = await depositB()
  await approveInvoices(ctx, session, contract)
  const app = await startApp(ctx)
  try {
    const { status, location } = await payerReturns(app, ctx, step.deposit.orderId)
    assert.equal(status, 302)
    assert.equal(location, 'http://localhost:3002/?deposit=captured')
  } finally {
    await app.close()
  }
  assert.equal(step.deposit.status, 'COMPLETED')
  const view = publicContract(ctx, contract)
  assert.equal(view.gantt.rows.find((r) => r.id === 'p1').badge.status, 'CAPTURED')
  assert.equal(view.summary.paidCents, 144000)
  assert.equal(contract.proposals.length, 1, 'the PAID trigger ran for the captured deposit')
  assert.ok(contract.activity.some((a) => /Deposit \$1,440 captured/.test(a.text)))
})

test('two returns at once capture once', async () => {
  const { ctx, session, contract, step } = await depositB()
  await approveInvoices(ctx, session, contract)
  const app = await startApp(ctx)
  try {
    ctx.mockOrders.simulateApprove(step.deposit.orderId)
    const url = `${app.base}/api/deposit/return?token=${step.deposit.orderId}`
    await Promise.all([fetch(url, { redirect: 'manual' }), fetch(url, { redirect: 'manual' })])
  } finally {
    await app.close()
  }
  assert.equal(ctx.mockOrders.calls.filter((c) => c.op === 'capture').length, 1)
})

test('return with an order id the app never created is refused and nothing is called', async () => {
  const { ctx } = await depositB()
  const app = await startApp(ctx)
  try {
    const res = await fetch(`${app.base}/api/deposit/return?token=NOTMYORDER123`, { redirect: 'manual' })
    assert.equal(res.status, 404)
    const bad = await fetch(`${app.base}/api/deposit/return?token=../etc`, { redirect: 'manual' })
    assert.equal(bad.status, 400)
  } finally {
    await app.close()
  }
  assert.equal(ctx.mockOrders.calls.length, 0)
})

test('return before the payer approved leaves the order open; the cancel return keeps the link alive', async () => {
  const { ctx, session, contract, step } = await depositB()
  await approveInvoices(ctx, session, contract)
  const app = await startApp(ctx)
  try {
    const res = await fetch(`${app.base}/api/deposit/return?token=${step.deposit.orderId}`, { redirect: 'manual' })
    assert.equal(res.headers.get('location'), 'http://localhost:3002/?deposit=error')
    const cancel = await fetch(`${app.base}/api/deposit/cancel?token=${step.deposit.orderId}`, { redirect: 'manual' })
    assert.equal(cancel.headers.get('location'), 'http://localhost:3002/?deposit=cancelled')
  } finally {
    await app.close()
  }
  assert.equal(step.deposit.status, 'CREATED')
  assert.ok(publicContract(ctx, contract).steps[0].deposit.approveUrl)
})

test('mock lost answers: create settles by replay, capture settles by read-back, one order and one capture', async () => {
  const { ctx, session, contract, step } = await depositB()
  ctx.mockOrders.loseNextResponse('create')
  await approveInvoices(ctx, session, contract)
  assert.equal(ctx.mockOrders.orders.size, 1)
  assert.equal(step.deposit.status, 'CREATED')
  ctx.mockOrders.simulateApprove(step.deposit.orderId)
  ctx.mockOrders.loseNextResponse('capture')
  const app = await startApp(ctx)
  try {
    const res = await app.call('POST', `/api/contracts/${contract.id}/deposit/capture`, { session: session.id })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.steps[0].deposit.status, 'CAPTURED')
  } finally {
    await app.close()
  }
  assert.equal(ctx.mockOrders.calls.filter((c) => c.op === 'capture').length, 1)
})

test('another session cannot capture my deposit', async () => {
  const { ctx, session, contract, step } = await depositB()
  await approveInvoices(ctx, session, contract)
  ctx.mockOrders.simulateApprove(step.deposit.orderId)
  const other = ctx.store.createSession()
  const app = await startApp(ctx)
  try {
    const res = await app.call('POST', `/api/contracts/${contract.id}/deposit/capture`, { session: other.id })
    assert.equal(res.status, 404)
  } finally {
    await app.close()
  }
  assert.equal(step.deposit.status, 'CREATED')
})

test('a captured deposit is fixed and paid: the engine pins it and the wedding move leaves it Unchanged', async () => {
  const { ctx, session, contract, step } = await depositB()
  await approveInvoices(ctx, session, contract)
  ctx.mockOrders.simulateApprove(step.deposit.orderId)
  const app = await startApp(ctx)
  try {
    await app.call('POST', `/api/contracts/${contract.id}/deposit/capture`, { session: session.id })
  } finally {
    await app.close()
  }
  assert.equal(isPinned(step), true)
  const sstep = computeSchedule(modelOf(contract), ctx.today()).steps[0]
  assert.equal(sstep.pinned, true)
  assert.equal(sstep.paid, true)
  const card = await prepareMove(ctx, contract, '2027-04-30')
  assert.ok(card.unchanged.some((u) => /^Deposit .* CAPTURED$/.test(u.text)), JSON.stringify(card.unchanged))
  assert.equal(card.lines.some((l) => /Deposit|Retainer/.test(l.text)), false)
})

test('an agent proposal after the deposit is paid keeps the deposit step at its date', async () => {
  const { ctx, session, contract, step } = await depositB()
  await approveInvoices(ctx, session, contract)
  ctx.mockOrders.simulateApprove(step.deposit.orderId)
  const app = await startApp(ctx)
  try {
    await app.call('POST', `/api/contracts/${contract.id}/deposit/capture`, { session: session.id })
  } finally {
    await app.close()
  }
  const [proposal] = contract.proposals
  const p1 = proposal.schedule.steps.find((s) => s.id === 'p1')
  assert.equal(p1.pinned, true)
  assert.equal(p1.paid, true)
  assert.equal(p1.dueDate, ctx.today())
})

test('with the deposit path off the first milestone is an invoice as before', async () => {
  const ctx = makeCtx({ depositCheckout: false })
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  assert.equal(ctx.mockOrders.orders.size, 0)
  assert.equal(ctx.invoicing.invoices.size, 3)
})

test('mock checkout page: Pay Now approves the order and redirects to the return URL', async () => {
  const orders = createMockOrders({ appBaseUrl: 'http://localhost:3002' })
  const express = (await import('express')).default
  const app = express()
  app.use('/mock-paypal', mockCheckoutRouter(orders))
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const order = await orders.createOrder({ amountCents: 5000, referenceId: 'p1', description: '<b>x</b>', customId: 'c', brandName: 'Studio', returnUrl: 'http://localhost:3002/api/deposit/return', cancelUrl: 'http://localhost:3002/api/deposit/cancel', requestId: 'r1' })
    const page = await (await fetch(`${base}/mock-paypal/checkout?token=${order.id}`)).text()
    assert.match(page, /Pay Now/)
    assert.doesNotMatch(page, /<b>x<\/b>/)
    const approve = await fetch(`${base}/mock-paypal/approve?token=${order.id}`, { redirect: 'manual' })
    assert.match(approve.headers.get('location'), /^http:\/\/localhost:3002\/api\/deposit\/return\?token=/)
    assert.equal((await orders.getOrder(order.id)).status, 'APPROVED')
    await assert.rejects(orders.captureOrder('MISSING12345', {}), (e) => e.status === 404)
  } finally {
    await new Promise((r) => server.close(r))
  }
  await settle()
})
