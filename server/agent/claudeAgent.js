import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { TOOL_DEFS, buildTools, runToolSafely } from './tools.js'

const MAX_STEPS = 8

export const SYSTEM_PROMPT = `You are the scheduling assistant inside VowLedger, used by a wedding photographer who invoices couples through PayPal.
The server owns every date and every amount. You never write a date or a dollar figure: you read the situation with the read tools, then call propose_option once with an option id returned by list_options and a short plain-language reason.
How to choose:
- A payment was confirmed (PAID): look at the tasks that follow it. A task with no outside cost can start early. A task with outside cost is safe to start only because the money is in. If nothing gains from moving, choose the keep option.
- An installment is due and unpaid (DUE_UNPAID): hold tasks that cost outside money and are tied to that installment by the contract. Never hold internal work. Include a short, polite reminder_note for the client (no dates).
- The wedding date moved (MOVE): choose the fee option only if list_contract_clauses shows a date-change clause.
  Not every task moves with the wedding: a task tied to a payment that is already sent or paid stays where it is. Describe only the movingTasks and unchangedTasks that list_options gives for your option.
Refer to contract sections and task names in the reason. A human approves everything you propose.`

let client = null
const getClient = () => (client ||= new Anthropic({ apiKey: config.anthropicKey }))

export async function runClaudeAgent(ctx, contract, trigger, options) {
  const sink = { choice: null }
  const events = []
  const handlers = buildTools(ctx, contract, trigger, options, sink)
  const messages = [{ role: 'user', content: `Event: ${JSON.stringify(trigger)}. Contract: ${contract.name}. Decide with the tools.` }]

  for (let step = 0; step < MAX_STEPS && !sink.choice; step += 1) {
    const response = await getClient().messages.create({ model: config.anthropicModel, max_tokens: 2000, system: SYSTEM_PROMPT, tools: TOOL_DEFS, messages })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') break
    const results = []
    for (const use of response.content.filter((b) => b.type === 'tool_use')) {
      const out = await runToolSafely(handlers, use.name, use.input)
      events.push({ tool: use.name, ok: out.ok, input: use.input })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.result).slice(0, 12000), is_error: !out.ok })
    }
    messages.push({ role: 'user', content: results })
  }
  return { choice: sink.choice, events, via: 'claude' }
}
