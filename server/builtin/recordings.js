import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Real model runs recorded once with LLM_BACKEND=account (scripts/record-runs.mjs) and replayed in mock mode,
// so a judge without a model sees what Claude actually did instead of a scripted stand-in.
export const RECORDINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recorded-runs')

function loadAll(dir) {
  if (!existsSync(dir)) return new Map()
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  return new Map(files.map((f) => {
    const run = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    return [run.scene, run]
  }))
}

let cache = null
const runs = () => (cache ||= loadAll(RECORDINGS_DIR))

// Tests point the loader at their own folder.
export function useRecordingsFrom(dir) {
  cache = dir ? loadAll(dir) : null
}

export function readerScene(sampleKey) {
  return `reader-${sampleKey}`
}

export function agentScene(sampleKey, trigger) {
  return `agent-${sampleKey}-${trigger.kind}${trigger.stepId ? `-${trigger.stepId}` : ''}`
}

export function recording(scene) {
  return runs().get(scene) || null
}

export function recordingLabel(run) {
  return `Recorded run: ${run.modelName || 'Claude Sonnet'}, ${run.recordedOn}`
}

// One line for the header: what answers in mock mode.
export function recordingsSummary() {
  const all = [...runs().values()]
  if (!all.length) return null
  const days = [...new Set(all.map((r) => r.recordedOn))].sort()
  return { count: all.length, label: `Recorded runs: ${all[0].modelName || 'Claude Sonnet'}, ${days.join(', ')}`, scenes: all.map((r) => r.scene).sort() }
}
