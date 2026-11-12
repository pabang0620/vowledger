import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, sampleContract, approveInvoices, pendingOf, settle } from './helpers.js'
import { buildTools, runToolSafely, TOOL_DEFS } from '../server/agent/tools.js'
import { listOptions } from '../server/schedule/options.js'
import { publicContract } from '../server/services/contracts.js'
import { prepareMove, runTrigger } from '../server/services/triggers.js'
import { addDays } from '../server/dates.js'

async function paidContext() {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  return { ctx, session, contract }
}

test('the model has no tool that moves money or writes a date', () => {
  const names = TOOL_DEFS.map((t) => t.name)
  assert.deepEqual(names.sort(), ['get_dependents', 'get_invoice_status', 'get_schedule', 'list_contract_clauses', 'list_options', 'propose_option'])
  const propose = TOOL_DEFS.find((t) => t.name === 'propose_option')
  assert.deepEqual(Object.keys(propose.input_schema.properties), ['option_id', 'reason', 'reminder_note'])
})

test('propose_option rejects ids that are not in the server list, and dates', async () => {
  const { ctx, contract } = await paidContext()
  const trigger = { kind: 'DUE_UNPAID', stepId: 'p2' }
  const options = listOptions(contract, { kind: 'PAID', stepId: 'p1' }, ctx.today())
  const sink = { choice: null }
  const tools = buildTools(ctx, contract, { kind: 'PAID', stepId: 'p1' }, options, sink)
  for (const bad of ['paid:p1:pull:t9', '2027-05-01', 'paid:p1:pull:t1:2027-05-01', '', 42, null]) {
    const out = await runToolSafely(tools, 'propose_option', { option_id: bad, reason: 'because the work can start' })
    assert.equal(out.ok, false, `accepted ${bad}`)
  }
  assert.equal(sink.choice, null)
  const dated = await runToolSafely(tools, 'propose_option', { option_id: 'paid:p1:pull:t1', reason: 'Start it on 2026-11-13 please' })
  assert.equal(dated.ok, false)
  assert.match(dated.result.error, /Do not write dates/)
  const ok = await runToolSafely(tools, 'propose_option', { option_id: 'paid:p1:pull:t1', reason: 'No outside cost, so it can start now.' })
  assert.equal(ok.ok, true)
  assert.equal(sink.choice.optionId, 'paid:p1:pull:t1')
  assert.equal(trigger.kind, 'DUE_UNPAID')
})

test('list_options returns server-computed dates for every choice', async () => {
  const { ctx, contract } = await paidContext()
  const options = listOptions(contract, { kind: 'MOVE', eventDate: '2027-04-30' }, ctx.today())
  assert.deepEqual(options.map((o) => o.id), ['move:fee-add', 'move:fee-skip'])
  const tools = buildTools(ctx, contract, { kind: 'MOVE', eventDate: '2027-04-30' }, options, { choice: null })
  const listed = tools.list_options()
  assert.equal(listed[0].resultTasks.find((t) => t.id === 't2').startDate, '2027-03-02')
  assert.equal(listed[0].feeCents, 15000)
})

test('a model that names an unknown option cannot create a proposal or a card', async () => {
  const ctx = makeCtx({ agent: { decide: async () => ({ choice: { optionId: 'invented-option', reason: 'trust me' }, events: [], via: 'claude' }) } })
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  await assert.rejects(runTrigger(ctx, contract, { kind: 'PAID', stepId: 'p1' }), /not in the server list/)
  assert.equal(contract.proposals.length, 0)
  assert.equal(pendingOf(contract, 'APPLY_PROPOSAL').length, 0)
})

test('an agent with no usable choice falls back to the rule-based pick', async () => {
  const ctx = makeCtx({ agent: { decide: async () => ({ choice: null, events: [], via: 'claude' }) } })
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  const approval = await prepareMove(ctx, contract, '2027-04-30')
  assert.equal(approval.lines.at(-1).kind, 'create_fee')
  assert.ok(contract.activity.some((a) => /rule-based pick/.test(a.text)))
})

test('contract without a date-change clause: no fee option, no fee line', async () => {
  const { ctx, contract } = await paidContext()
  contract.dateChangeFee = null
  const approval = await prepareMove(ctx, contract, '2027-04-30')
  assert.equal(approval.lines.some((l) => l.kind === 'create_fee'), false)
  assert.equal(approval.approveLabel, 'Approve 2 PayPal changes')
})

test('overdue installment (event in 57 days): contract shows 3 days late, a reminder card opens', async () => {
  const ctx = makeCtx()
  const { read } = await import('../server/contracts/extract.js').then(async (m) => {
    const { sampleFor, sampleContractText } = await import('../server/contracts/samples.js')
    const text = sampleContractText({ ...sampleFor('A'), eventOffsetDays: 57 }, ctx.today()).text
    return { read: await m.readContract(text), text }
  })
  const { createContract } = await import('../server/services/contracts.js')
  const { requestInvoices } = await import('../server/services/approvals.js')
  const session = ctx.store.createSession()
  const contract = createContract(ctx, session, { read: read.read, steps: read.steps, text: 'x' })
  requestInvoices(ctx, contract)
  await approveInvoices(ctx, session, contract)
  const view = publicContract(ctx, contract)
  assert.equal(contract.steps[1].invoice.contractDueDate, addDays(ctx.today(), -3))
  assert.equal(view.schedule.steps.find((s) => s.id === 'p2').overdueDays, 3)
  assert.equal(view.steps.find((s) => s.id === 'p2').invoice.remote.dueDate, ctx.today())
  assert.equal(pendingOf(contract, 'REMINDER').length, 1)
})

test('a proposal made on an older plan shows as stale and cannot be applied', async () => {
  const { ctx, session, contract } = await paidContext()
  await ctx.invoicing.simulateBuyerPayment(contract.steps[0].invoice.id)
  await settle()
  const proposal = contract.proposals[0]
  assert.equal(proposal.status, 'pending')
  const { bumpPlan } = await import('../server/services/contracts.js')
  bumpPlan(contract)
  const [card] = pendingOf(contract, 'APPLY_PROPOSAL')
  const { executeApproval } = await import('../server/services/approvals.js')
  await assert.rejects(executeApproval(ctx, session, contract.id, card.id), /Plan changed, recalculate/)
  assert.equal(publicContract(ctx, contract).gantt.rows.find((r) => r.id === 't1').baselines.some((b) => b.name === 'proposal'), false)
})
