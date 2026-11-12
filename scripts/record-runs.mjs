// Records the real model on the demo scenes, once, so mock mode can replay them honestly labelled.
// Runs Claude through the local Claude Code login (Claude Agent SDK, the API key is stripped) and keeps PayPal on the
// in-memory mock: this script never builds a sandbox client. Writes server/builtin/recorded-runs/*.json.
// Usage: FORCE_MOCK=1 FORCE_MOCK_PAYPAL=1 node scripts/record-runs.mjs [scene ...]
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createContext } from '../server/context.js'
import { config, modes } from '../server/config.js'
import { createMockPaypal } from '../server/integrations/mockPaypal.js'
import { createMockOrders } from '../server/integrations/orders/mockOrders.js'
import { readContractAccount, acceptReading } from '../server/contracts/extract.js'
import { sampleFor, sampleContractText } from '../server/contracts/samples.js'
import { createContract } from '../server/services/contracts.js'
import { executeApproval, captureDepositFor, requestInvoices } from '../server/services/approvals.js'
import { prepareMove, scanDueTriggers } from '../server/services/triggers.js'
import { runAccountAgent } from '../server/agent/accountAgent.js'
import { RECORDINGS_DIR, agentScene, readerScene } from '../server/builtin/recordings.js'
import { addDays, diffDays, todayIso } from '../server/dates.js'

if (modes.paypal !== 'mock') {
  process.stderr.write('Refusing to run: PayPal is not on the mock. Set FORCE_MOCK_PAYPAL=1.\n')
  process.exit(1)
}

const MODEL_NAME = 'Claude Sonnet'
const BACKEND = 'Claude Agent SDK through a local Claude Code login (LLM_BACKEND=account), no API key'
const today = todayIso()
const only = new Set(process.argv.slice(2))
const wanted = (scene) => only.size === 0 || only.has(scene)
const out = (msg) => process.stdout.write(`${msg}\n`)

mkdirSync(RECORDINGS_DIR, { recursive: true })
function save(run) {
  const file = path.join(RECORDINGS_DIR, `${run.scene}.json`)
  writeFileSync(file, `${JSON.stringify({ ...run, model: config.anthropicModel, modelName: MODEL_NAME, backend: BACKEND, recordedOn: today, recordedToday: today }, null, 2)}\n`)
  out(`saved ${run.scene} (${run.durationMs} ms)`)
}

// One transient error gets one retry; a second failure stops the script.
async function once(fn) {
  try {
    return await fn()
  } catch (err) {
    out(`retrying after: ${err.message}`)
    return fn()
  }
}

async function record(sampleKey) {
  const { text } = sampleContractText(sampleFor(sampleKey), today)
  const trace = {}
  const started = Date.now()
  const raw = await once(() => readContractAccount(text, trace))
  const durationMs = Date.now() - started
  let accepted = null
  let outcome = 'accepted'
  try {
    accepted = acceptReading(structuredClone(raw), text)
  } catch (err) {
    outcome = `refused by the server check: ${err.message}`
  }
  if (wanted(readerScene(sampleKey))) {
    save({ scene: readerScene(sampleKey), kind: 'reader', sampleKey, durationMs, toolCalls: [{ tool: 'submit_contract_terms', input: raw, atMs: durationMs }], modelText: trace.modelText || '', outcome })
  }
  return accepted && { ...accepted, text }
}

const ctx = createContext({
  invoicing: createMockPaypal({ today: () => today }),
  orders: createMockOrders({ appBaseUrl: config.appBaseUrl }),
  depositCheckout: true,
  today: () => today,
})

ctx.agent = {
  async decide(c, contract, trigger, options) {
    const scene = agentScene(contract.sampleKey, trigger)
    const result = await once(() => runAccountAgent(c, contract, trigger, options))
    if (wanted(scene)) {
      save({
        scene,
        kind: 'agent',
        sampleKey: contract.sampleKey,
        trigger: trigger.kind === 'MOVE' ? { kind: 'MOVE', shiftDays: diffDays(trigger.eventDate, contract.eventDate) } : trigger,
        optionIds: options.map((o) => o.id),
        durationMs: result.durationMs,
        toolCalls: result.events,
        choice: result.choice,
        modelText: result.modelText || '',
      })
    }
    return result
  },
}

const pending = (contract, type) => [...contract.approvals.values()].find((a) => a.type === type && a.status === 'pending')

async function open(session, sampleKey) {
  const reading = await record(sampleKey)
  if (!reading) return null
  return createContract(ctx, session, { read: reading.read, steps: reading.steps, text: reading.text, source: 'claude-account', sampleKey })
}

const session = ctx.store.createSession()

// Sample B: approve, the client pays the deposit (PAID), apply the pick, then move the wedding 49 days (MOVE).
const b = await open(session, 'B')
if (b) {
  requestInvoices(ctx, b)
  await executeApproval(ctx, session, b.id, pending(b, 'CREATE_INVOICES').id)
  ctx.orders.simulateApprove(b.steps[0].deposit.orderId)
  await captureDepositFor(ctx, b, 'p1')
  const apply = pending(b, 'APPLY_PROPOSAL')
  if (apply) await executeApproval(ctx, session, b.id, apply.id)
  await prepareMove(ctx, b, addDays(b.eventDate, 49))
}

// Sample A: approve; the 2nd installment is due today and unpaid (DUE_UNPAID).
const a = await open(session, 'A')
if (a) {
  requestInvoices(ctx, a)
  await executeApproval(ctx, session, a.id, pending(a, 'CREATE_INVOICES').id)
  await scanDueTriggers(ctx, a)
}

// Sample C: only the reading (its clauses add up to 95%, so the server refuses it).
if (wanted(readerScene('C'))) await record('C')
out('done')
