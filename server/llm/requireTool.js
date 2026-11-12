// The hosted model rejects forced tool_choice (type "tool" or "any") with HTTP 400.
// So every request is sent with tool_choice auto plus a system line, and the answer is checked afterwards.
export class ToolNotCalledError extends Error {}

const instruction = (toolName) => `You must answer by calling the tool ${toolName}.`

export function buildRequest(params, toolName) {
  const { tool_choice: _ignored, ...rest } = params
  return {
    ...rest,
    system: `${params.system || ''} ${instruction(toolName)}`.trim(),
    tool_choice: { type: 'auto' },
  }
}

// Calls create() up to twice. The second try repeats the instruction. Throws ToolNotCalledError when the tool is still not called,
// so the caller's existing fallback (recording or rule-based reader) takes over.
export async function callRequiredTool(client, params, toolName) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const base = buildRequest(params, toolName)
    const request = attempt === 0 ? base : { ...base, system: `${base.system} ${instruction(toolName)} Do not reply with plain text.` }
    const response = await client.messages.create(request)
    const use = response.content.find((b) => b.type === 'tool_use' && b.name === toolName)
    if (use) return use.input
  }
  throw new ToolNotCalledError(`The model did not call ${toolName}.`)
}
