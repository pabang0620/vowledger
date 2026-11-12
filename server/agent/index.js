import { modes } from '../config.js'
import { runClaudeAgent } from './claudeAgent.js'
import { runAccountAgent } from './accountAgent.js'
import { runReplayAgent } from './replayAgent.js'
import { runMockAgent } from './mockAgent.js'

const LIVE_RUNNERS = { live: runClaudeAgent, account: runAccountAgent }

// Claude when a key or a local account is configured. In mock mode a recorded real run is replayed where one exists
// for the sample and event; otherwise, and after a live failure, the rule-based stand-in decides.
export async function decide(ctx, contract, trigger, options) {
  const run = LIVE_RUNNERS[modes.llm]
  if (run) {
    try {
      const out = await run(ctx, contract, trigger, options)
      if (out.choice) return out
    } catch (err) {
      console.error('Claude agent failed, using the rule-based agent:', err.message)
    }
  } else {
    const replay = await runReplayAgent(ctx, contract, trigger, options)
    if (replay.choice) return replay
  }
  return runMockAgent(ctx, contract, trigger, options)
}
