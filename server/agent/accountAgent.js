import { TOOL_DEFS, buildTools, runToolSafely } from './tools.js'
import { SYSTEM_PROMPT } from './claudeAgent.js'
import { runAccountTools } from './accountRunner.js'

// Same system prompt, same tools, same output shape as claudeAgent.js: the rest of the app cannot tell them apart.
// Each event also carries the time since the run started, and the model's closing text is returned, so a run can be recorded.
export async function runAccountAgent(ctx, contract, trigger, options) {
  const sink = { choice: null }
  const events = []
  const handlers = buildTools(ctx, contract, trigger, options, sink)
  const started = Date.now()
  const modelText = await runAccountTools({
    system: SYSTEM_PROMPT,
    prompt: `Event: ${JSON.stringify(trigger)}. Contract: ${contract.name}. Decide with the tools.`,
    defs: TOOL_DEFS,
    call: async (name, input) => {
      const out = await runToolSafely(handlers, name, input)
      events.push({ tool: name, ok: out.ok, input, atMs: Date.now() - started })
      return out
    },
  })
  return { choice: sink.choice, events, via: 'claude-account', modelText, durationMs: Date.now() - started }
}
