import { buildTools, runToolSafely } from './tools.js'
import { agentScene, recording, recordingLabel } from '../builtin/recordings.js'

// Mock mode with a recorded real run for this sample and event: replay the model's tool calls in the recorded order
// against today's tools (so every answer is computed fresh) and submit the model's recorded pick and reason.
// The pick goes through the same validation as a live one. No recording, or a pick that no longer fits: no choice,
// and the caller falls back to the rule-based agent, which is labelled as such.
export async function runReplayAgent(ctx, contract, trigger, options) {
  const run = contract.sampleKey ? recording(agentScene(contract.sampleKey, trigger)) : null
  if (!run) return { choice: null, events: [], via: 'recorded-claude' }
  const sink = { choice: null }
  const events = []
  const handlers = buildTools(ctx, contract, trigger, options, sink)
  for (const call of run.toolCalls) {
    const out = await runToolSafely(handlers, call.tool, call.input)
    events.push({ tool: call.tool, ok: out.ok, input: call.input, atMs: call.atMs })
  }
  return {
    choice: sink.choice,
    events,
    via: 'recorded-claude',
    modelText: run.modelText || '',
    recording: { scene: run.scene, label: recordingLabel(run), model: run.model, recordedOn: run.recordedOn, durationMs: run.durationMs },
  }
}
