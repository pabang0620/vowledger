import { modes } from '../config.js'
import { runClaudeAgent } from './claudeAgent.js'
import { runAccountAgent } from './accountAgent.js'
import { runReplayAgent } from './replayAgent.js'
import { attemptLive } from '../llmGuard.js'
import { runMockAgent } from './mockAgent.js'

// Exported so tests can swap in a fake model; nothing else touches it.
export const LIVE_RUNNERS = { live: runClaudeAgent, account: runAccountAgent }

// Claude when a key or a local account is configured. In mock mode a recorded real run is replayed where one exists
// for the sample and event; otherwise, and after a live failure, the rule-based stand-in decides.
export async function decide(ctx, contract, trigger, options) {
  const run = LIVE_RUNNERS[modes.llm]
  let fallbackReason = null
  if (run) {
    // Only the hosted key path is capped; the local account backend is the developer's own login.
    const attempt = modes.llm === 'live' ? await attemptLive(() => run(ctx, contract, trigger, options)) : await attemptLive(() => run(ctx, contract, trigger, options), { limiter: { take: () => true } })
    if (attempt.out?.choice) return attempt.out
    fallbackReason = attempt.reason || 'live model gave no usable choice'
  }
  const replay = await runReplayAgent(ctx, contract, trigger, options)
  if (replay.choice) return { ...replay, fallbackReason }
  return { ...(await runMockAgent(ctx, contract, trigger, options)), fallbackReason }
}
