import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, sampleContract, approveInvoices, pendingOf, settle } from './helpers.js'
import { executeApproval } from '../server/services/approvals.js'
import { pollContract, prepareMove } from '../server/services/triggers.js'
import { publicContract, scheduleOf } from '../server/services/contracts.js'
import { misnamedTasks } from '../server/agent/tools.js'

// "Hold until payment" is tied to the invoice: it lasts while the invoice is unpaid and ends when PayPal says PAID.

const stepOf = (contract, id) => contract.steps.find((s) => s.id === id)
const taskOf = (ctx, contract, id) => scheduleOf(ctx, contract).tasks.find((t) => t.id === id)

async function heldAlbum() {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'A')
  await approveInvoices(ctx, session, contract)
  const [apply] = pendingOf(contract, 'APPLY_PROPOSAL')
  await executeApproval(ctx, session, contract.id, apply.id)
  return { ctx, session, contract }
}

test('a hold stores the payment it waits for and the Gantt says which invoice', async () => {
  const { ctx, contract } = await heldAlbum()
  assert.deepEqual(contract.adjustments.t2, { kind: 'hold', date: '2026-11-15', untilStep: 'p2' })
  const album = taskOf(ctx, contract, 't2')
  assert.equal(album.startDate, '2026-11-15')
  assert.equal(album.waitsFor, 'p2')
  const row = publicContract(ctx, contract).gantt.rows.find((r) => r.id === 't2')
  assert.equal(row.waitsFor, stepOf(contract, 'p2').invoice.number)
})

test('still unpaid after the hold date: the hold extends instead of releasing', async () => {
  const { ctx, contract } = await heldAlbum()
  ctx.setToday('2026-11-20')
  await pollContract(ctx, contract)
  assert.equal(stepOf(contract, 'p2').invoice.status, 'SENT')
  const album = taskOf(ctx, contract, 't2')
  assert.equal(album.startDate, '2026-11-23', 'today + 3 days, not the old Nov 15')
  assert.equal(album.adjusted, 'hold')
  assert.equal(album.waitsFor, 'p2')
})

test('PayPal reports PAID: the hold is released from the payment day and the log says so', async () => {
  const { ctx, contract } = await heldAlbum()
  ctx.setToday('2026-11-20')
  await ctx.invoicing.simulateBuyerPayment(stepOf(contract, 'p2').invoice.id)
  await settle()
  await pollContract(ctx, contract)
  assert.equal(stepOf(contract, 'p2').invoice.status, 'PAID')
  assert.deepEqual(contract.adjustments.t2, { kind: 'hold', date: '2026-11-20' })
  const album = taskOf(ctx, contract, 't2')
  assert.equal(album.startDate, '2026-11-20', 'starts on the day the money arrived, not 3 days later and not in the past')
  assert.equal(album.waitsFor, null)
  assert.ok(contract.activity.some((a) => /Hold released: .* is paid, so "Album order" can start Nov 20/.test(a.text)))
})

test('paid before the hold date: the task goes back to its planned start', async () => {
  const { ctx, contract } = await heldAlbum()
  await ctx.invoicing.simulateBuyerPayment(stepOf(contract, 'p2').invoice.id)
  await settle()
  await pollContract(ctx, contract)
  assert.equal(taskOf(ctx, contract, 't2').startDate, '2026-11-13')
})

test('a reason that says a pinned task moves is refused; a correct one passes', () => {
  const effect = { moving: ['Album order', 'Final shot list'], unchanged: ['Engagement shoot'] }
  const recorded = 'The Engagement shoot, Album order and Final shot list tasks keep their order after their payment steps and shift to fit the new event date.'
  assert.deepEqual(misnamedTasks(recorded, effect), ['Engagement shoot'])
  const fine = 'Album order and Final shot list move with the new date. The Engagement shoot is tied to the paid retainer and does not move.'
  assert.deepEqual(misnamedTasks(fine, effect), [])
})

test('move after the deposit is paid: list_options names the tasks that move and the one that stays', async () => {
  const ctx = makeCtx()
  let seen = null
  ctx.agent = {
    async decide(c, contract, trigger, options) {
      const { buildTools } = await import('../server/agent/tools.js')
      const tools = buildTools(c, contract, trigger, options, {})
      if (trigger.kind === 'MOVE') seen = tools.list_options()
      const { runMockAgent } = await import('../server/agent/mockAgent.js')
      return runMockAgent(c, contract, trigger, options)
    },
  }
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  await ctx.invoicing.simulateBuyerPayment(stepOf(contract, 'p1').invoice.id)
  await settle()
  await pollContract(ctx, contract)
  const [apply] = pendingOf(contract, 'APPLY_PROPOSAL')
  await executeApproval(ctx, session, contract.id, apply.id)
  await prepareMove(ctx, contract, '2027-04-30')
  const fee = seen.find((o) => o.id === 'move:fee-add')
  assert.deepEqual(fee.unchangedTasks, ['Engagement shoot'])
  assert.deepEqual(fee.movingTasks, ['Album order', 'Final shot list'])
})

test('an invoice number already used on the PayPal account is skipped, not reported as a failure', async () => {
  const ctx = makeCtx()
  ctx.invoicing.reserveInvoiceNumbers(['INV-0021', 'INV-0022'])
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  const numbers = contract.steps.filter((s) => s.invoice).map((s) => s.invoice.number)
  assert.deepEqual(numbers, ['INV-0023', 'INV-0024', 'INV-0025'])
  assert.equal(contract.steps.filter((s) => s.invoice?.syncState === 'not_synced').length, 0)
  assert.equal(ctx.invoicing.calls.filter((c) => c.op === 'create').length, 5)
})
