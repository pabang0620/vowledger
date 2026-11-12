import { z } from 'zod'
import { config } from '../config.js'

// Local development only (LLM_BACKEND=account): runs a tool loop through the Claude Agent SDK, which signs in with
// the developer's Claude Code account. The API key is stripped from the child environment so it can never be billed.
const SERVER_NAME = 'vowledger'
const DEFAULT_TURNS = 12
const TIMEOUT_MS = 180000

let sdk = null

// Tests hand in a fake SDK so no model is ever started.
export function setAccountSdk(fake) {
  sdk = fake
}

async function loadSdk() {
  if (!sdk) sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk
}

export function withoutApiKey(env = process.env) {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = env
  return rest
}

function buildServer({ tool, createSdkMcpServer }, defs, call) {
  const tools = defs.map((def) =>
    tool(def.name, def.description, z.fromJSONSchema(def.input_schema).shape, async (input) => {
      const outcome = await call(def.name, input)
      return { content: [{ type: 'text', text: JSON.stringify(outcome.result).slice(0, 12000) }], isError: !outcome.ok }
    }),
  )
  return createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools })
}

// call(name, input) must return { ok, result }. Returns the final text of the model, if any.
export async function runAccountTools({ system, prompt, defs, call, maxTurns = DEFAULT_TURNS }) {
  const agentSdk = await loadSdk()
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS)
  let text = ''
  try {
    const stream = agentSdk.query({
      prompt,
      options: {
        model: config.anthropicModel,
        systemPrompt: system,
        tools: [],
        allowedTools: [`mcp__${SERVER_NAME}__*`],
        mcpServers: { [SERVER_NAME]: buildServer(agentSdk, defs, call) },
        maxTurns,
        effort: 'medium',
        settingSources: [],
        abortController,
        env: withoutApiKey(),
      },
    })
    for await (const message of stream) {
      if (message.type !== 'result') continue
      if (message.subtype === 'success') text = message.result || ''
      else if (message.subtype !== 'error_max_turns') throw new Error(`Account run failed: ${message.subtype}`)
    }
  } finally {
    clearTimeout(timer)
  }
  return text
}
