import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeCtx, sampleContract, approveInvoices, settle } from './helpers.js'
import { setAccountSdk, withoutApiKey } from '../server/agent/accountRunner.js'
import { runAccountAgent } from '../server/agent/accountAgent.js'
import { readContractAccount } from '../server/contracts/extract.js'
import { readContractMock } from '../server/contracts/mockReader.js'
import { sampleFor, sampleContractText } from '../server/contracts/samples.js'
import { listOptions } from '../server/schedule/options.js'

// A stand-in for @anthropic-ai/claude-agent-sdk: it records the options and plays a script of tool calls
// through the same in-process tools the adapter registered. No model, no login, no network.
function fakeSdk(script) {
  const seen = { options: null, toolNames: [], results: [] }
  const sdk = {
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    createSdkMcpServer: ({ name, tools }) => ({ name, tools }),
    query({ options }) {
      seen.options = options
      const server = options.mcpServers.vowledger
      seen.toolNames = server.tools.map((t) => t.name)
      return (async function* run() {
        for (const [name, input] of script) {
          const res = await server.tools.find((t) => t.name === name).handler(input)
          seen.results.push({ name, isError: res.isError })
        }
        yield { type: 'result', subtype: 'success', result: 'done' }
      })()
    },
  }
  setAccountSdk(sdk)
  return seen
}

after(() => setAccountSdk(null))

async function paidTrigger() {
  const ctx = makeCtx()
  const { session, contract } = await sampleContract(ctx, 'B')
  await approveInvoices(ctx, session, contract)
  await ctx.invoicing.simulateBuyerPayment(contract.steps[0].invoice.id)
  await settle()
  const trigger = { kind: 'PAID', stepId: 'p1' }
  return { ctx, contract, trigger, options: listOptions(contract, trigger, ctx.today()) }
}

test('account backend: the API key and token are removed from the child environment', () => {
  const env = withoutApiKey({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 'tok', HOME: '/home/x', PATH: '/bin' })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH'])
})

test('account backend: tool calls map to the same tools, the pick becomes a choice, nothing else is exposed', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-must-not-reach-the-model'
  const { ctx, contract, trigger, options } = await paidTrigger()
  const pick = options.find((o) => o.id.includes(':pull:'))
  const seen = fakeSdk([
    ['get_invoice_status', { step_id: 'p1' }],
    ['list_options', {}],
    ['propose_option', { option_id: pick.id, reason: 'The deposit is in, so the shoot can start early.', not_chosen: options.filter((o) => o.id !== pick.id).map((o) => ({ option_id: o.id, why: 'Waiting gains nothing once the deposit is in.' })) }],
  ])
  const out = await runAccountAgent(ctx, contract, trigger, options)
  assert.equal(out.via, 'claude-account')
  assert.deepEqual(out.events.map((e) => e.tool), ['get_invoice_status', 'list_options', 'propose_option'])
  assert.equal(out.choice.optionId, pick.id)
  assert.deepEqual(seen.toolNames, ['get_invoice_status', 'get_schedule', 'get_dependents', 'list_contract_clauses', 'list_options', 'propose_option'])
  assert.deepEqual(seen.options.tools, [], 'no built-in tool (no shell, no files)')
  assert.equal(seen.options.model, 'claude-sonnet-5-5')
  assert.deepEqual(seen.options.settingSources, [])
  assert.equal('ANTHROPIC_API_KEY' in seen.options.env, false)
  assert.equal('ANTHROPIC_AUTH_TOKEN' in seen.options.env, false)
  delete process.env.ANTHROPIC_API_KEY
})

test('account backend: the same validation applies, a date in the reason or an unknown id is an error result and no choice', async () => {
  const { ctx, contract, trigger, options } = await paidTrigger()
  const seen = fakeSdk([
    ['propose_option', { option_id: 'made:up', reason: 'A plausible reason here.' }],
    ['propose_option', { option_id: options[0].id, reason: 'Start on 2026-11-13 please.' }],
  ])
  const out = await runAccountAgent(ctx, contract, trigger, options)
  assert.equal(out.choice, null)
  assert.deepEqual(seen.results.map((r) => r.isError), [true, true])
})

test('account backend: the contract reader goes through the same submit tool and the same checks', async () => {
  const text = sampleContractText(sampleFor('B'), '2026-11-12').text
  const terms = readContractMock(text)
  const seen = fakeSdk([['submit_contract_terms', terms]])
  const out = await readContractAccount(text)
  assert.deepEqual(out, terms)
  assert.deepEqual(seen.toolNames, ['submit_contract_terms'])
  fakeSdk([])
  await assert.rejects(readContractAccount(text), /no payment terms/)
})

test('FORCE_MOCK beats LLM_BACKEND=account, so tests can never reach a model', async () => {
  process.env.FORCE_MOCK = '1'
  process.env.LLM_BACKEND = 'account'
  const { modes } = await import('../server/config.js?forcemock')
  assert.equal(modes.llm, 'mock')
  assert.equal(modes.llmLabel, 'Rule-based agent')
  delete process.env.LLM_BACKEND
})

test('FORCE_MOCK_PAYPAL blanks the PayPal keys but leaves the model backend alone', async () => {
  process.env.PAYPAL_CLIENT_ID = 'id-from-env'
  process.env.PAYPAL_CLIENT_SECRET = 'secret-from-env'
  process.env.FORCE_MOCK_PAYPAL = '1'
  process.env.FORCE_MOCK = '0'
  process.env.LLM_BACKEND = 'account'
  const { modes, config } = await import('../server/config.js?mockpaypal')
  assert.equal(modes.paypal, 'mock')
  assert.equal(config.paypalClientId, '')
  assert.equal(modes.llm, 'account')
  assert.equal(modes.llmLabel, 'Claude Sonnet (local account)')
  process.env.FORCE_MOCK = '1'
  for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'FORCE_MOCK_PAYPAL', 'LLM_BACKEND']) delete process.env[k]
})
