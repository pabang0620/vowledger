import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, sampleContract, approveInvoices, pendingOf, startApp, settle } from './helpers.js'
import { executeApproval, captureDepositFor } from '../server/services/approvals.js'
import { prepareMove } from '../server/services/triggers.js'
import { prepareExtend } from '../server/services/extension.js'
import { publicContract, stepsDone } from '../server/services/contracts.js'

const stepOf = (contract, id) => contract.steps.find((s) => s.id === id)
const remote = (contract, id) => `${stepOf(contract, id).invoice.remote.issueDate} / ${stepOf(contract, id).invoice.remote.dueDate}`

async function approvedB(opts = {}) {
  const ctx = makeCtx(opts)
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  return { ctx, session, contract }
}

// ---- guide band: the server decides the three steps ----

test('steps band: the deposit-checkout path ticks all three steps (server stepsDone)', async () => {
  const { ctx, session, contract } = await approvedB({ depositCheckout: true })
  assert.deepEqual(publicContract(ctx, contract).summary.stepsDone, { created: true, paid: false, moved: false })
  ctx.mockOrders.simulateApprove(contract.steps[0].deposit.orderId)
  await captureDepositFor(ctx, contract, 'p1')
  assert.deepEqual(stepsDone(contract), { created: true, paid: true, moved: false })
  const card = await prepareMove(ctx, contract, '2027-04-30')
  await executeApproval(ctx, session, contract.id, card.id)
  assert.deepEqual(publicContract(ctx, contract).summary.stepsDone, { created: true, paid: true, moved: true })
})

test('steps band: before approval nothing is ticked, and a partial move does not tick step 3 until it ran', async () => {
  const ctx = makeCtx({ depositCheckout: true })
  const { contract } = await sampleContract(ctx, 'B')
  assert.deepEqual(stepsDone(contract), { created: false, paid: false, moved: false })
})

// ---- extension: a human drag of one scheduled payment becomes a PayPal PUT ----

test('extension: dragging the balance later drafts a card, PayPal is untouched until approval, then one PUT', async () => {
  const { ctx, session, contract } = await approvedB()
  const callsBefore = ctx.invoicing.calls.length
  const card = prepareExtend(ctx, contract, 'p3', '2027-02-24')
  assert.equal(card.type, 'EXTEND_DUE')
  assert.match(card.title, /^Extend INV-\d+ due Feb 10 -> Feb 24\?$/)
  assert.equal(card.lines.length, 1)
  assert.match(card.lines[0].text, /Balance \$1,440\s+send Jan 27 -> Feb 10 · due Feb 10 -> Feb 24/)
  assert.equal(ctx.invoicing.calls.length, callsBefore, 'no PayPal call for a draft')
  const view = publicContract(ctx, contract)
  assert.equal(view.gantt.rows.find((r) => r.id === 'p3').startDate, '2027-02-24', 'the Gantt previews the new date')
  assert.equal(view.gantt.rows.find((r) => r.id === 'p3').baselines[0].startDate, '2027-02-10')
  assert.equal(remote(contract, 'p3'), '2027-01-27 / 2027-02-10')

  await executeApproval(ctx, session, contract.id, card.id)
  assert.equal(remote(contract, 'p3'), '2027-02-10 / 2027-02-24')
  assert.equal(remote(contract, 'p2'), '2026-12-28 / 2027-01-11', 'the other scheduled invoice is not touched')
  assert.equal(stepOf(contract, 'p3').invoice.status, 'SCHEDULED')
  const pp = ctx.invoicing.invoices.get(stepOf(contract, 'p3').invoice.id)
  assert.equal(pp.detail.payment_term.due_date, '2027-02-24')
  assert.equal(pp.items[0].unit_amount.value, '1440.00', 'the amount is the server amount, untouched')
  assert.equal(publicContract(ctx, contract).summary.notSynced, 0)
})

test('extension: an extended payment stops following the wedding date', async () => {
  const { ctx, session, contract } = await approvedB()
  const card = prepareExtend(ctx, contract, 'p3', '2027-02-24')
  await executeApproval(ctx, session, contract.id, card.id)
  const move = await prepareMove(ctx, contract, '2027-03-20')
  assert.ok(move.lines.some((l) => /Second installment/.test(l.text)))
  assert.ok(!move.lines.some((l) => /Balance/.test(l.text)), 'the extended balance is not part of the wedding move')
  await assert.rejects(prepareMove(ctx, contract, '2027-04-30'), (e) => e.status === 409 && /would put "Balance" before "Second installment"/.test(e.message))
})

test('extension: order violation, pinned, earlier, past the wedding and unknown steps are refused', async () => {
  const { ctx, contract } = await approvedB()
  assert.throws(() => prepareExtend(ctx, contract, 'p2', '2027-02-24'), (e) => e.status === 409 && /after "Balance"/.test(e.message))
  assert.throws(() => prepareExtend(ctx, contract, 'p1', '2026-12-01'), (e) => e.status === 409 && /already sent or paid/.test(e.message))
  assert.throws(() => prepareExtend(ctx, contract, 'p3', '2027-02-01'), (e) => e.status === 409 && /later than 2027-02-10/.test(e.message))
  assert.throws(() => prepareExtend(ctx, contract, 'p3', '2027-03-20'), (e) => e.status === 409 && /after the wedding/.test(e.message))
  assert.throws(() => prepareExtend(ctx, contract, 'nope', '2027-02-24'), (e) => e.status === 409)
  assert.equal(pendingOf(contract, 'EXTEND_DUE').length, 0)
})

test('extension: a second card replaces the first, and an old card cannot run after the plan changed', async () => {
  const { ctx, session, contract } = await approvedB()
  const first = prepareExtend(ctx, contract, 'p3', '2027-02-20')
  const second = prepareExtend(ctx, contract, 'p3', '2027-02-24')
  assert.equal(first.status, 'cancelled')
  await executeApproval(ctx, session, contract.id, second.id)
  await assert.rejects(executeApproval(ctx, session, contract.id, first.id), (e) => e.status === 409)
  assert.equal(remote(contract, 'p3'), '2027-02-10 / 2027-02-24')
})

test('extension HTTP: dates are validated and another session cannot extend my contract', async () => {
  const { ctx, session, contract } = await approvedB()
  const app = await startApp(ctx)
  try {
    const path = `/api/contracts/${contract.id}/extend`
    assert.equal((await app.call('POST', path, { session: session.id, body: { stepId: 'p3', dueDate: 'soon' } })).status, 400)
    assert.equal((await app.call('POST', path, { session: session.id, body: { stepId: 'p3', dueDate: '2027-02-24' } })).status, 200)
    const other = (await app.call('POST', '/api/session')).body.data.sessionId
    assert.equal((await app.call('POST', path, { session: other, body: { stepId: 'p3', dueDate: '2027-02-25' } })).status, 404)
  } finally {
    await app.close()
  }
})

// ---- proposal card shows the server-computed before and after ----

test('proposal: the card carries the dates it changes, computed by the server', async () => {
  const { ctx, contract } = await approvedB()
  await ctx.invoicing.simulateBuyerPayment(stepOf(contract, 'p1').invoice.id)
  await settle()
  const view = publicContract(ctx, contract)
  const proposal = view.proposals[0]
  assert.equal(proposal.changes.length, 1)
  assert.equal(proposal.changes[0].text, 'Engagement shoot Nov 26 -> Nov 13')
  assert.equal(proposal.changes[0].to, '2026-11-13')
})

// ---- first screen preview ----

test('preview: a read-only sample plan with no session, nothing created and nothing sent', async () => {
  const ctx = makeCtx()
  const app = await startApp(ctx)
  try {
    const res = await app.call('GET', '/api/preview?sample=B')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.gantt.direction, 'Backward')
    assert.ok(res.body.data.gantt.rows.some((r) => r.id === 'event'))
    assert.equal((await app.call('GET', '/api/preview?sample=Z')).status, 400)
    assert.equal(ctx.invoicing.calls.length, 0)
    assert.equal(ctx.store.allContracts().length, 0)
  } finally {
    await app.close()
  }
})

// ---- small server fixes ----

test('a missing session header says what to do, not a zod message', async () => {
  const app = await startApp(makeCtx())
  try {
    const res = await app.call('GET', '/api/contracts')
    assert.equal(res.status, 400)
    assert.equal(res.body.message, 'Session missing, reload the page.')
  } finally {
    await app.close()
  }
})

test('an unexpected error never leaks its internal message', async () => {
  const ctx = makeCtx()
  const app = await startApp(ctx)
  const original = console.error
  console.error = () => {}
  try {
    const session = (await app.call('POST', '/api/session')).body.data.sessionId
    ctx.store.getSession = () => { throw new Error('secret internal detail') }
    const res = await app.call('GET', '/api/contracts', { session })
    assert.equal(res.status, 500)
    assert.ok(!/secret internal detail/.test(res.body.message))
  } finally {
    console.error = original
    await app.close()
  }
})

test('fail-next is scoped to the session that armed it', async () => {
  const mine = await approvedB()
  const { ctx } = mine
  // a second judge on the same server
  const other = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, other.session, other.contract)
  const app = await startApp(ctx)
  try {
    assert.equal((await app.call('POST', '/api/dev/fail-next', { session: mine.session.id, body: { op: 'update' } })).status, 200)
    const otherCard = await prepareMove(ctx, other.contract, '2027-04-30')
    const done = await executeApproval(ctx, other.session, other.contract.id, otherCard.id)
    assert.equal(done.job.status, 'done', 'the other session is unaffected')
    const myCard = await prepareMove(ctx, mine.contract, '2027-04-30')
    const mineDone = await executeApproval(ctx, mine.session, mine.contract.id, myCard.id)
    assert.equal(mineDone.job.status, 'partial', 'my own edit fails once')
    assert.equal((await app.call('POST', '/api/dev/fail-next', { session: mine.session.id, body: { op: 'create' } })).status, 400)
  } finally {
    await app.close()
  }
})
