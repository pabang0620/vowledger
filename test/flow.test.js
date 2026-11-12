import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, sampleContract, approveInvoices, pendingOf, settle, startApp } from './helpers.js'
import { executeApproval, requestRecordPayment, retryJob } from '../server/services/approvals.js'
import { prepareMove, handleInvoiceEvent } from '../server/services/triggers.js'
import { publicContract } from '../server/services/contracts.js'

const stepOf = (contract, id) => contract.steps.find((s) => s.id === id)
const dates = (contract, id) => `${stepOf(contract, id).invoice.remote.issueDate} / ${stepOf(contract, id).invoice.remote.dueDate}`

async function approvedB() {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  return { ctx, session, contract }
}

test('approval creates 3 PayPal invoices: retainer sent now, 2 scheduled with issue = due - 14', async () => {
  const { ctx, contract } = await approvedB()
  assert.equal(stepOf(contract, 'p1').invoice.status, 'SENT')
  assert.equal(stepOf(contract, 'p2').invoice.status, 'SCHEDULED')
  assert.equal(stepOf(contract, 'p3').invoice.status, 'SCHEDULED')
  assert.equal(dates(contract, 'p1'), '2026-11-12 / 2026-11-12')
  assert.equal(dates(contract, 'p2'), '2026-12-28 / 2027-01-11')
  assert.equal(dates(contract, 'p3'), '2027-01-27 / 2027-02-10')
  const pp = [...ctx.invoicing.invoices.values()]
  assert.equal(pp.length, 3)
  const p3 = pp.find((i) => i.detail.invoice_number === stepOf(contract, 'p3').invoice.number)
  assert.equal(p3.detail.payment_term.term_type, 'DUE_ON_DATE_SPECIFIED')
  assert.equal(p3.items[0].unit_amount.value, '1440.00')
})

test('nothing reaches PayPal before a card is approved', async () => {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'B')
  assert.equal(ctx.invoicing.calls.length, 0)
  const card = await prepareMove(ctx, contract, '2027-04-30').catch((e) => e)
  assert.equal(ctx.invoicing.calls.length, 0)
  assert.ok(card)
  await assert.rejects(executeApproval(ctx, session, contract.id, 'missing'), /not found/)
})

test('a card cannot run twice, even from two tabs at once', async () => {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'B')
  const [card] = pendingOf(contract, 'CREATE_INVOICES')
  const results = await Promise.allSettled([executeApproval(ctx, session, contract.id, card.id), executeApproval(ctx, session, contract.id, card.id)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(ctx.invoicing.invoices.size, 3)
})

test('PayPal-Request-Id makes create idempotent', async () => {
  const ctx = makeCtx()
  const body = { detail: { invoice_date: '2026-11-12', payment_term: { due_date: '2026-11-12' } }, items: [{ unit_amount: { value: '1.00' }, quantity: '1' }], primary_recipients: [{}] }
  const a = await ctx.invoicing.createInvoice(body, { requestId: 'c:p1:v1' })
  const b = await ctx.invoicing.createInvoice(body, { requestId: 'c:p1:v1' })
  assert.equal(a.id, b.id)
  assert.equal(ctx.invoicing.invoices.size, 1)
})

test('drag the wedding date: card lists issue and due before/after, pinned deposit is Unchanged', async () => {
  const { ctx, session, contract } = await approvedB()
  const approval = await prepareMove(ctx, contract, '2027-04-30')
  const texts = approval.lines.map((l) => l.text)
  assert.equal(approval.title, 'Move wedding Mar 12 -> Apr 30?')
  assert.ok(texts.some((t) => /Second installment \$1,920\s+send Dec 28 -> Feb 15 · due Jan 11 -> Mar 1/.test(t)), texts.join('\n'))
  assert.ok(texts.some((t) => /Balance \$1,440\s+send Jan 27 -> Mar 17 · due Feb 10 -> Mar 31/.test(t)))
  assert.ok(texts.some((t) => /^NEW Date change fee \$150 send now/.test(t)))
  assert.equal(approval.approveLabel, 'Approve 3 PayPal changes')
  assert.equal(approval.unchanged.length, 1)
  assert.match(approval.unchanged[0].text, /Retainer \$1,440 SENT/)
  assert.equal(approval.lines.some((l) => /Retainer/.test(l.text)), false)

  const view = publicContract(ctx, contract)
  assert.equal(view.gantt.rows.find((r) => r.id === 'p2').startDate, '2027-03-01')
  assert.equal(view.gantt.rows.find((r) => r.id === 'p2').baselines[0].startDate, '2027-01-11')
  assert.equal(view.gantt.rows.find((r) => r.id === 'p1').constraintType, 'muststarton')
  assert.equal(contract.eventDate, '2027-03-12', 'preview does not change the confirmed plan')

  await executeApproval(ctx, session, contract.id, approval.id)
  assert.equal(contract.eventDate, '2027-04-30')
  assert.equal(dates(contract, 'p2'), '2027-02-15 / 2027-03-01')
  assert.equal(dates(contract, 'p3'), '2027-03-17 / 2027-03-31')
  assert.equal(stepOf(contract, 'p2').invoice.status, 'SCHEDULED')
  assert.equal(dates(contract, 'p1'), '2026-11-12 / 2026-11-12', 'pinned retainer untouched')
  const fee = contract.steps.find((s) => s.id === 'fee')
  assert.equal(fee.invoice.status, 'SENT')
  assert.equal(fee.amountCents, 15000)
  const after = publicContract(ctx, contract)
  assert.equal(after.summary.notSynced, 0)
  assert.ok(after.steps.filter((s) => s.invoice).every((s) => s.invoice.syncState === 'synced'))
  // the PUT replaced the whole invoice and kept the amount and recipient
  const pp = ctx.invoicing.invoices.get(stepOf(contract, 'p2').invoice.id)
  assert.equal(pp.items[0].unit_amount.value, '1920.00')
  assert.equal(pp.detail.payment_term.due_date, '2027-03-01')
})

test('partial failure keeps the plan, keeps the successes, retries only the failed invoice', async () => {
  const { ctx, session, contract } = await approvedB()
  const approval = await prepareMove(ctx, contract, '2027-04-30')
  ctx.invoicing.failNext({ op: 'update', invoiceId: stepOf(contract, 'p3').invoice.id })
  const { job } = await executeApproval(ctx, session, contract.id, approval.id)
  assert.equal(job.status, 'partial')
  assert.equal(job.items.filter((i) => i.status === 'done').length, 2)
  const failed = job.items.find((i) => i.status === 'failed')
  assert.equal(failed.stepId, 'p3')
  assert.equal(contract.eventDate, '2027-04-30')
  assert.equal(dates(contract, 'p2'), '2027-02-15 / 2027-03-01')
  assert.equal(dates(contract, 'p3'), '2027-01-27 / 2027-02-10', 'PayPal still has the old dates')
  assert.equal(publicContract(ctx, contract).steps.find((s) => s.id === 'p3').invoice.syncState, 'not_synced')
  const updatesBefore = ctx.invoicing.calls.filter((c) => c.op === 'update').length
  await retryJob(ctx, session, contract.id, job.id)
  assert.equal(ctx.invoicing.calls.filter((c) => c.op === 'update').length, updatesBefore + 1)
  assert.equal(dates(contract, 'p3'), '2027-03-17 / 2027-03-31')
  assert.equal(job.status, 'done')
})

test('moving the wedding earlier than a pinned payment allows is refused by the server', async () => {
  const { ctx, session, contract } = await approvedB()
  const [pay] = [stepOf(contract, 'p2')]
  ctx.setToday('2027-01-05')
  ctx.invoicing.setToday(() => '2027-01-05')
  // second installment goes out (issue date reached) and gets pinned
  ctx.invoicing.setToday(() => '2026-12-29')
  await handleInvoiceEvent(ctx, { id: 'EV-1', event_type: 'INVOICING.INVOICE.UPDATED', resource: { invoice: { id: pay.invoice.id } } })
  assert.equal(pay.invoice.status, 'SENT')
  assert.equal(publicContract(ctx, contract).steps.find((s) => s.id === 'p2').invoice.syncState, 'synced')
  await assert.rejects(prepareMove(ctx, contract, '2027-02-05'), (e) => e.status === 409 && /pinned/.test(e.message))
})

test('plan version: a card made on an older plan cannot be applied', async () => {
  const { ctx, session, contract } = await approvedB()
  const first = await prepareMove(ctx, contract, '2027-04-30')
  contract.planVersion += 1
  await assert.rejects(executeApproval(ctx, session, contract.id, first.id), (e) => e.status === 409 && /Plan changed, recalculate/.test(e.message))
  assert.equal(ctx.invoicing.calls.filter((c) => c.op === 'update').length, 0)
})

test('two different move cards: the second is refused after the first applied', async () => {
  const { ctx, session, contract } = await approvedB()
  const a = await prepareMove(ctx, contract, '2027-04-30')
  const stale = { ...a }
  await executeApproval(ctx, session, contract.id, a.id)
  const b = [...contract.approvals.values()].find((x) => x.id === stale.id)
  assert.equal(b.status, 'done')
  await assert.rejects(executeApproval(ctx, session, contract.id, a.id), /already done/)
})

test('payment confirmed: webhook -> get_invoice -> pin -> agent picks a server option -> baseline 1 -> apply', async () => {
  const { ctx, session, contract } = await approvedB()
  const p1 = stepOf(contract, 'p1')
  await ctx.invoicing.simulateBuyerPayment(p1.invoice.id)
  await settle()
  assert.equal(p1.invoice.status, 'PAID')
  const proposal = contract.proposals[0]
  assert.equal(proposal.optionId, 'paid:p1:pull:t1')
  assert.equal(proposal.status, 'pending')
  assert.ok(proposal.toolCalls.includes('list_options') && proposal.toolCalls.includes('propose_option'))
  assert.equal(proposal.planVersion, contract.planVersion)
  const view = publicContract(ctx, contract)
  const shoot = view.gantt.rows.find((r) => r.id === 't1')
  assert.equal(shoot.baselines.at(-1).name, 'proposal')
  assert.equal(shoot.baselines.at(-1).startDate, '2026-11-13')
  const [card] = pendingOf(contract, 'APPLY_PROPOSAL')
  await executeApproval(ctx, session, contract.id, card.id)
  assert.equal(publicContract(ctx, contract).schedule.tasks.find((t) => t.id === 't1').startDate, '2026-11-13')
  assert.equal(proposal.status, 'applied')
})

test('duplicate webhook deliveries are handled once', async () => {
  const { ctx, contract } = await approvedB()
  const p1 = stepOf(contract, 'p1')
  await ctx.invoicing.simulateBuyerPayment(p1.invoice.id)
  await settle()
  const event = { id: 'WH-DUP-1', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: p1.invoice.id } } }
  const first = await handleInvoiceEvent(ctx, event)
  const second = await handleInvoiceEvent(ctx, event)
  assert.equal(first.handled, true)
  assert.equal(second.duplicate, true)
  assert.equal(contract.proposals.length, 1)
})

test('sample A: second installment due today and unpaid -> hold the album order + reminder card', async () => {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'A')
  await approveInvoices(ctx, session, contract)
  assert.equal(stepOf(contract, 'p2').invoice.status, 'SENT')
  assert.equal(dates(contract, 'p2'), '2026-11-12 / 2026-11-12')
  assert.equal(dates(contract, 'p3'), '2026-11-28 / 2026-12-12')
  assert.equal(stepOf(contract, 'p3').invoice.status, 'SCHEDULED')
  const proposal = contract.proposals.find((p) => p.trigger.kind === 'DUE_UNPAID')
  assert.equal(proposal.optionId, 'due:p2:hold:t2')
  const album = publicContract(ctx, contract).gantt.rows.find((r) => r.id === 't2')
  assert.equal(album.baselines.at(-1).name, 'proposal')
  assert.equal(album.baselines.at(-1).startDate, '2026-11-15')
  const [reminder] = pendingOf(contract, 'REMINDER')
  assert.ok(reminder)
  await executeApproval(ctx, session, contract.id, reminder.id)
  assert.equal(ctx.invoicing.calls.filter((c) => c.op === 'reminder').length, 1)
})

test('record a bank transfer needs approval; partial payment keeps the invoice open', async () => {
  const { ctx, session, contract } = await approvedB()
  const p1 = stepOf(contract, 'p1')
  const card = requestRecordPayment(ctx, contract, { stepId: 'p1', amountCents: 50000 })
  assert.equal(ctx.invoicing.calls.filter((c) => c.op === 'record_payment').length, 0)
  await executeApproval(ctx, session, contract.id, card.id)
  assert.equal(p1.invoice.status, 'PARTIALLY_PAID')
  assert.equal(p1.invoice.paidCents, 50000)
  assert.equal(contract.proposals.length, 0, 'partial payment does not trigger the agent')
  assert.throws(() => requestRecordPayment(ctx, contract, { stepId: 'p1', amountCents: 999999 }), /Amount must be/)
  const rest = requestRecordPayment(ctx, contract, { stepId: 'p1' })
  await executeApproval(ctx, session, contract.id, rest.id)
  assert.equal(p1.invoice.status, 'MARKED_AS_PAID')
  assert.equal(contract.proposals.length, 1)
})

test('sessions are separate: another session cannot read or run my contract', async () => {
  const ctx = makeCtx()
  const app = await startApp(ctx)
  try {
    const mine = (await app.call('POST', '/api/session')).body.data.sessionId
    const theirs = (await app.call('POST', '/api/session')).body.data.sessionId
    const made = await app.call('POST', '/api/contracts', { session: mine, body: { sample: 'B' } })
    assert.equal(made.status, 201)
    const id = made.body.data.id
    const cardId = made.body.data.approvals[0].id
    assert.equal((await app.call('GET', `/api/contracts/${id}`, { session: theirs })).status, 404)
    assert.equal((await app.call('POST', `/api/contracts/${id}/approvals/${cardId}/execute`, { session: theirs })).status, 404)
    assert.equal((await app.call('GET', `/api/contracts/${id}`)).status, 400)
    assert.equal((await app.call('POST', `/api/contracts/${id}/move`, { session: mine, body: { eventDate: 'next friday' } })).status, 400)
    assert.equal(ctx.invoicing.calls.length, 0)
    const ok = await app.call('POST', `/api/contracts/${id}/approvals/${cardId}/execute`, { session: mine })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.data.steps.filter((s) => s.invoice).length, 3)
  } finally {
    await app.close()
  }
})

test('sample C shows the totals check and an edited percent passes', async () => {
  const ctx = makeCtx()
  const app = await startApp(ctx)
  try {
    const session = (await app.call('POST', '/api/session')).body.data.sessionId
    const bad = await app.call('POST', '/api/contracts', { session, body: { sample: 'C' } })
    assert.equal(bad.status, 422)
    assert.match(bad.body.message, /^Clauses add up to \$4,560, contract total is \$4,800\./)
    assert.equal(bad.body.data.clauses.length, 3)
    const fixed = await app.call('POST', '/api/contracts', { session, body: { sample: 'C', edits: [{ index: 1, percent: 40 }] } })
    assert.equal(fixed.status, 201)
  } finally {
    await app.close()
  }
})

test('paid retainer: moving the wedding keeps it out of the change list and in Unchanged', async () => {
  const { ctx, session, contract } = await approvedB()
  await ctx.invoicing.simulateBuyerPayment(stepOf(contract, 'p1').invoice.id)
  await settle()
  const approval = await prepareMove(ctx, contract, '2027-04-30')
  assert.equal(approval.lines.some((l) => l.stepId === 'p1'), false)
  assert.match(approval.unchanged[0].text, /Retainer \$1,440 PAID/)
  await executeApproval(ctx, session, contract.id, approval.id)
  assert.equal(dates(contract, 'p1'), '2026-11-12 / 2026-11-12')
  assert.equal(stepOf(contract, 'p1').invoice.status, 'PAID')
})

test('earlier wedding: a new issue date in the past becomes "send now", both dates are PUT, then it is sent', async () => {
  const { ctx, session, contract } = await approvedB()
  const approval = await prepareMove(ctx, contract, '2027-01-21')
  const line = approval.lines.find((l) => l.stepId === 'p2')
  assert.match(line.text, /send now · due Jan 11 -> Nov 22/)
  await executeApproval(ctx, session, contract.id, approval.id)
  assert.equal(stepOf(contract, 'p2').invoice.status, 'SENT')
  assert.equal(dates(contract, 'p2'), '2026-11-12 / 2026-11-22')
  const ops = ctx.invoicing.calls.filter((c) => c.id === stepOf(contract, 'p2').invoice.id).map((c) => c.op)
  assert.ok(ops.indexOf('update') > -1 && ops.lastIndexOf('send') > ops.indexOf('update'), ops.join(','))
  assert.equal(publicContract(ctx, contract).steps.find((s) => s.id === 'p2').invoice.syncState, 'synced')
})
