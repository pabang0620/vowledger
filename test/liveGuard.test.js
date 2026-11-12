import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter, attemptLive, withClient, REASON_LIMIT, REASON_UNAVAILABLE } from '../server/llmGuard.js'
import { modes } from '../server/config.js'
import { decide, LIVE_RUNNERS } from '../server/agent/index.js'
import { readContract, LIVE_READERS } from '../server/contracts/extract.js'
import { sampleFor, sampleContractText } from '../server/contracts/samples.js'
import { makeCtx, sampleContract, approveInvoices } from './helpers.js'
import { listOptions } from '../server/schedule/options.js'
import { prepareMove } from '../server/services/triggers.js'
import { addDays } from '../server/dates.js'

const original = { llm: modes.llm, agent: LIVE_RUNNERS.live, reader: LIVE_READERS.live }
afterEach(() => {
  modes.llm = original.llm
  LIVE_RUNNERS.live = original.agent
  LIVE_READERS.live = original.reader
})

const clock = (start = 0) => {
  const state = { t: start }
  return { now: () => state.t, advance: (ms) => { state.t += ms } }
}
const ok = async () => 'done'
const boom = async () => { throw new Error('529 overloaded: credit balance is too low') }

test('per-IP hourly cap: the 11th run in an hour is refused, then the window slides', async () => {
  const c = clock()
  const limiter = createLimiter({ perIpHour: 10, perDay: 150, now: c.now })
  for (let i = 0; i < 10; i += 1) assert.equal((await attemptLive(ok, { limiter, ip: 'a' })).out, 'done')
  assert.deepEqual(await attemptLive(ok, { limiter, ip: 'a' }), { reason: REASON_LIMIT })
  assert.equal((await attemptLive(ok, { limiter, ip: 'b' })).out, 'done', 'another IP is not affected')
  c.advance(60 * 60 * 1000 + 1)
  assert.equal((await attemptLive(ok, { limiter, ip: 'a' })).out, 'done')
})

test('per-host daily cap holds across IPs and resets after 24 hours', async () => {
  const c = clock()
  const limiter = createLimiter({ perIpHour: 10, perDay: 3, now: c.now })
  for (const ip of ['a', 'b', 'c']) assert.equal((await attemptLive(ok, { limiter, ip })).out, 'done')
  assert.equal((await attemptLive(ok, { limiter, ip: 'd' })).reason, REASON_LIMIT)
  c.advance(24 * 60 * 60 * 1000 + 1)
  assert.equal((await attemptLive(ok, { limiter, ip: 'd' })).out, 'done')
})

test('a model that throws never leaks the error text', async () => {
  const limiter = createLimiter({ perIpHour: 10, perDay: 10 })
  const result = await attemptLive(boom, { limiter, ip: 'a' })
  assert.deepEqual(result, { reason: REASON_UNAVAILABLE })
})

test('the agent falls back to the recorded run when the API errors, labelled with the reason', async () => {
  modes.llm = 'live'
  LIVE_RUNNERS.live = boom
  const ctx = makeCtx({ agent: { decide } })
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  const trigger = { kind: 'PAID', stepId: 'p1' }
  const options = listOptions(contract, trigger, ctx.today())
  const out = await withClient('9.9.9.9', () => decide(ctx, contract, trigger, options))
  assert.equal(out.fallbackReason, REASON_UNAVAILABLE)
  assert.ok(out.choice)
})

test('the agent falls back to the rule-based stand-in when no recording exists', async () => {
  modes.llm = 'live'
  LIVE_RUNNERS.live = boom
  const ctx = makeCtx({ agent: { decide } })
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  const custom = { ...contract, sampleKey: null }
  const proposal = await withClient('9.9.9.9', async () => {
    const trigger = { kind: 'PAID', stepId: 'p1' }
    return decide(ctx, custom, trigger, listOptions(contract, trigger, ctx.today()))
  })
  assert.equal(proposal.via, 'mock-agent')
  assert.equal(proposal.fallbackReason, REASON_UNAVAILABLE)
})

test('a move still produces an approval card when the live model is down, with an honest label', async () => {
  modes.llm = 'live'
  LIVE_RUNNERS.live = boom
  const ctx = makeCtx({ agent: { decide } })
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  const card = await withClient('8.8.8.8', () => prepareMove(ctx, contract, addDays(contract.eventDate, 30)))
  assert.ok(card)
  assert.match(JSON.stringify(card), /live model unavailable/)
  assert.doesNotMatch(JSON.stringify(card), /credit balance|529/)
})

test('the contract reader falls back to the recorded reading, then to the rule-based reader', async () => {
  modes.llm = 'live'
  LIVE_READERS.live = boom
  const today = '2026-11-12'
  const { text } = sampleContractText(sampleFor('B'), today)
  const recorded = await withClient('7.7.7.7', () => readContract(text, { sampleKey: 'B', today }))
  assert.equal(recorded.source, 'recorded-claude')
  assert.match(recorded.sourceLabel, /Recorded run.*live model unavailable/)
  const standIn = await withClient('7.7.7.7', () => readContract(text, { sampleKey: null, today }))
  assert.equal(standIn.source, 'mock-reader')
  assert.match(standIn.sourceLabel, /Rule-based stand-in \(live model unavailable\)/)
})

test('a user run counts once even if the model call takes many tool turns', async () => {
  const limiter = createLimiter({ perIpHour: 1, perDay: 10 })
  const manyTurns = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); return 'done' }
  assert.equal((await attemptLive(manyTurns, { limiter, ip: 'a' })).out, 'done')
  assert.equal((await attemptLive(manyTurns, { limiter, ip: 'a' })).reason, REASON_LIMIT)
})
