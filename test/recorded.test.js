import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { makeCtx, pendingOf, startApp } from './helpers.js'
import { decide } from '../server/agent/index.js'
import { readContract } from '../server/contracts/extract.js'
import { sampleFor, sampleContractText } from '../server/contracts/samples.js'
import { createContract } from '../server/services/contracts.js'
import { executeApproval, captureDepositFor, requestInvoices } from '../server/services/approvals.js'
import { RECORDINGS_DIR, useRecordingsFrom, recording } from '../server/builtin/recordings.js'
import { SANDBOX_EVIDENCE } from '../server/builtin/sandboxEvidence.js'
import { addDays } from '../server/dates.js'

const ISO = /\d{4}-\d{2}-\d{2}/
const files = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.json'))
const runs = files.map((f) => JSON.parse(readFileSync(path.join(RECORDINGS_DIR, f), 'utf8')))

after(() => useRecordingsFrom(null))

async function paidB(today) {
  const ctx = makeCtx({ today, depositCheckout: true, agent: { decide } })
  const session = ctx.store.createSession()
  const { text } = sampleContractText(sampleFor('B'), ctx.today())
  const reading = await readContract(text, { sampleKey: 'B', today: ctx.today() })
  const contract = createContract(ctx, session, { ...reading, text, sampleKey: 'B' })
  requestInvoices(ctx, contract)
  await executeApproval(ctx, session, contract.id, pendingOf(contract, 'CREATE_INVOICES')[0].id)
  ctx.mockOrders.simulateApprove(contract.steps[0].deposit.orderId)
  await captureDepositFor(ctx, contract, 'p1')
  return { ctx, contract, reading }
}

test('recordings: six real runs, recorded through the account backend, with tool calls, timings and model text', () => {
  assert.deepEqual(runs.map((r) => r.scene).sort(), ['agent-A-DUE_UNPAID-p2', 'agent-B-MOVE', 'agent-B-PAID-p1', 'reader-A', 'reader-B', 'reader-C'])
  for (const run of runs) {
    assert.equal(run.model, 'claude-sonnet-5-5')
    assert.match(run.backend, /Claude Code login/)
    assert.ok(run.durationMs > 0 && run.toolCalls.length > 0 && typeof run.modelText === 'string')
    assert.doesNotMatch(JSON.stringify(run), /sk-ant|ANTHROPIC_API_KEY/)
    if (run.kind === 'agent') {
      assert.equal(run.toolCalls.at(-1).tool, 'propose_option')
      assert.doesNotMatch(run.choice.reason, ISO, 'a recorded reason has no dates, so it stays true on any day')
      assert.ok(run.toolCalls.length >= 4, 'the model chose several read tools before picking')
    }
  }
})

test('mock mode replays the recorded Claude run: same tool order, same pick, labelled as a recording', async () => {
  const { contract } = await paidB('2026-11-12')
  const [proposal] = contract.proposals
  const run = recording('agent-B-PAID-p1')
  assert.equal(proposal.via, 'recorded-claude')
  assert.equal(proposal.viaLabel, 'Recorded run: Claude Sonnet, 2026-11-12')
  assert.deepEqual(proposal.toolCalls, run.toolCalls.map((t) => t.tool))
  assert.equal(proposal.optionId, run.choice.optionId)
  assert.equal(proposal.reason, run.choice.reason)
  assert.equal(proposal.recording.durationMs, run.durationMs)
})

test('a recorded reading of a sample is shifted to the day it is opened and still passes the quote check', async () => {
  const today = '2026-12-20'
  const { reading } = await paidB(today)
  assert.equal(reading.source, 'recorded-claude')
  assert.equal(reading.sourceLabel, 'Recorded run: Claude Sonnet, 2026-11-12')
  assert.equal(reading.read.eventDate, addDays(today, 120))
  assert.deepEqual(reading.steps.map((s) => s.amountCents), [144000, 192000, 144000])
})

test('the recorded reading of sample C is refused by the same money check', async () => {
  const { text } = sampleContractText(sampleFor('C'), '2026-11-20')
  await assert.rejects(readContract(text, { sampleKey: 'C', today: '2026-11-20' }), /Clauses add up to \$4,560, contract total is \$4,800/)
})

test('pasted text has no recording: the rule-based reader runs and says so', async () => {
  const { text } = sampleContractText(sampleFor('B'), '2026-11-12')
  const reading = await readContract(text, { today: '2026-11-12' })
  assert.equal(reading.source, 'mock-reader')
  assert.equal(reading.sourceLabel, 'the rule-based reader')
})

test('a recorded pick that no longer fits the server options is not used: the rule-based agent decides and is labelled', async () => {
  const dir = mkdtempSync(path.join(RECORDINGS_DIR, '..', '.test-runs-'))
  try {
    const run = recording('agent-B-PAID-p1')
    const broken = { ...run, toolCalls: run.toolCalls.map((t) => (t.tool === 'propose_option' ? { ...t, input: { ...t.input, option_id: 'paid:p1:pull:gone' } } : t)) }
    writeFileSync(path.join(dir, 'agent-B-PAID-p1.json'), JSON.stringify(broken))
    useRecordingsFrom(dir)
    const { contract } = await paidB('2026-11-12')
    assert.equal(contract.proposals[0].via, 'mock-agent')
    assert.equal(contract.proposals[0].viaLabel, 'Rule-based agent')
  } finally {
    useRecordingsFrom(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the API labels who read the contract, and health says recorded runs answer in mock mode', async () => {
  const ctx = makeCtx({ depositCheckout: true })
  const app = await startApp(ctx)
  try {
    const { body: s } = await app.call('POST', '/api/session')
    const sid = s.data.sessionId
    const { status, body } = await app.call('POST', '/api/contracts', { session: sid, body: { sample: 'B' } })
    assert.equal(status, 201)
    assert.equal(body.data.readBy, 'recorded-claude')
    assert.equal(body.data.readByLabel, 'Recorded run: Claude Sonnet, 2026-11-12')
    const { body: h } = await app.call('GET', '/api/health')
    assert.equal(h.data.recordings.count, 6)
    assert.match(h.data.recordings.label, /^Recorded runs: Claude Sonnet, 2026-11-12$/)
  } finally {
    await app.close()
  }
})

test('sandbox evidence lists as PASS only items VERIFY.md records as PASS', () => {
  const verify = readFileSync(path.join(RECORDINGS_DIR, '..', '..', '..', 'VERIFY.md'), 'utf8')
  for (const item of SANDBOX_EVIDENCE.passed) {
    const id = item.id.split(' ')[0]
    if (id.startsWith('VB')) {
      assert.equal((verify.match(/\| pass \|/g) || []).length, 7)
      continue
    }
    const section = verify.split(`## ${id} `)[1] || ''
    assert.match(section.slice(0, 200), /\*\*Result 2026-11-12: PASS/, `${id} must be PASS in VERIFY.md`)
  }
  for (const item of SANDBOX_EVIDENCE.notRun.filter((i) => !i.id.includes('step'))) {
    assert.match(((verify.split(`## ${item.id} `)[1] || '').split('\n## ')[0]), /SKIPPED/)
  }
})
