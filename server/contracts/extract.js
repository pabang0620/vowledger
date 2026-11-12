import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { config, modes } from '../config.js'
import { ContractError, clauseSchema, buildSteps } from '../schedule/compute.js'
import { isValidIso, addDays, diffDays } from '../dates.js'
import { recording, readerScene, recordingLabel } from '../builtin/recordings.js'
import { readContractMock } from './mockReader.js'
import { attemptLive } from '../llmGuard.js'
import { runAccountTools } from '../agent/accountRunner.js'
import { callRequiredTool } from '../llm/requireTool.js'

const readSchema = z.object({
  couple: z.string().min(1).max(80).optional(),
  client: z.object({ given: z.string().min(1).max(60), surname: z.string().min(1).max(60), email: z.email() }).optional(),
  eventDate: z.string().refine(isValidIso, 'eventDate must be YYYY-MM-DD'),
  signedOn: z.string().refine(isValidIso, 'signedOn must be YYYY-MM-DD').nullable().optional(),
  totalCents: z.number().int().positive(),
  totalQuote: z.string().max(500).optional(),
  clauses: z.array(clauseSchema).min(2).max(6),
  dateChangeFee: z.object({ cents: z.number().int().positive(), quote: z.string().max(500) }).nullable().optional(),
  partialAllowed: z.boolean().optional(),
  leadDays: z.number().int().min(0).max(60).nullable().optional(),
})

export const READ_TOOL = {
  name: 'submit_contract_terms',
  description: 'Submit the payment terms found in the contract. Copy numbers only from the contract text. Never compute dollar amounts per clause: give the percent and the quote.',
  input_schema: {
    type: 'object',
    properties: {
      couple: { type: 'string' },
      client: { type: 'object', properties: { given: { type: 'string' }, surname: { type: 'string' }, email: { type: 'string' } }, required: ['given', 'surname', 'email'] },
      eventDate: { type: 'string', description: 'YYYY-MM-DD as written in the contract' },
      signedOn: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
      totalCents: { type: 'integer', description: 'Total contract fee in cents, copied from the contract' },
      totalQuote: { type: 'string' },
      clauses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            percent: { type: 'number', description: 'Percent of the total fee, as written' },
            anchor: { type: 'string', enum: ['SIGNING', 'EVENT'] },
            offsetDays: { type: 'integer', description: '0 for signing, otherwise negative days before the event (60 days before = -60)' },
            quote: { type: 'string', description: 'The exact sentence from the contract' },
          },
          required: ['label', 'percent', 'anchor', 'offsetDays', 'quote'],
        },
      },
      dateChangeFee: { type: ['object', 'null'], properties: { cents: { type: 'integer' }, quote: { type: 'string' } } },
      partialAllowed: { type: 'boolean' },
      leadDays: { type: ['integer', 'null'], description: 'Days before the due date the invoice is sent, if the contract says so' },
    },
    required: ['eventDate', 'totalCents', 'clauses'],
  },
}

const READ_SYSTEM = 'You read wedding photography contracts. Find the payment schedule and call submit_contract_terms once. Copy numbers and quotes only from the text. Do not invent clauses.'

// Same tool, same system prompt, but through the local Claude Code account (LLM_BACKEND=account).
// trace (optional) receives the model's closing text, used when a run is recorded.
export async function readContractAccount(text, trace = {}) {
  let found = null
  trace.modelText = await runAccountTools({
    system: READ_SYSTEM,
    prompt: text,
    defs: [READ_TOOL],
    maxTurns: 4,
    call: async (name, input) => {
      if (name === READ_TOOL.name) found = input
      return { ok: true, result: { ok: true, message: 'Terms received.' } }
    },
  })
  if (!found) throw new ContractError('The reader returned no payment terms.')
  return found
}

export async function readContractLive(text, client = new Anthropic({ apiKey: config.anthropicKey })) {
  return callRequiredTool(client, {
    model: config.anthropicModel,
    max_tokens: 4000,
    system: READ_SYSTEM,
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: text }],
  }, READ_TOOL.name)
}

// Quotes must exist in the contract, and each percent must appear in its quote. Otherwise it is not a reading, it is a guess.
export function verifyAgainstText(read, text) {
  const normalized = text.replace(/\s+/g, ' ')
  for (const clause of read.clauses) {
    const q = clause.quote.replace(/\s+/g, ' ').trim()
    if (!normalized.includes(q)) throw new ContractError(`The quote for "${clause.label}" is not in the contract. Edit the clause or upload again.`)
    if (!q.includes(`${clause.percent}%`)) throw new ContractError(`The ${clause.percent}% for "${clause.label}" does not appear in its quote.`)
  }
  if (read.dateChangeFee) {
    const q = read.dateChangeFee.quote.replace(/\s+/g, ' ').trim()
    if (!normalized.includes(q)) read.dateChangeFee = null
  }
  return read
}

// Schema, quote check and the money check (clauses must add up to the total) for any reader's raw output.
export function acceptReading(raw, text, edits = []) {
  const parsed = readSchema.safeParse(raw)
  if (!parsed.success) throw new ContractError(`Could not read the contract: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  const read = verifyAgainstText(parsed.data, text)
  // The photographer may correct a percent after the check failed. The quote stays, the number is theirs.
  for (const edit of edits) {
    const clause = read.clauses[edit.index]
    if (clause) read.clauses[edit.index] = { ...clause, percent: edit.percent, edited: true }
  }
  let steps
  try {
    steps = buildSteps(read.clauses, read.totalCents)
  } catch (err) {
    err.read = read
    throw err
  }
  return { read, steps }
}

// A sample contract in mock mode: the model's recorded reading of the same sample. Sample text is built from the day
// it is opened, so the two dates the model copied are shifted by the days since the recording. The reading must still
// pass the schema and the quote check against today's text, or the rule-based reader is used instead.
export function recordedReading(sampleKey, text, today) {
  const run = sampleKey && today ? recording(readerScene(sampleKey)) : null
  if (!run) return null
  const shift = diffDays(today, run.recordedToday)
  const raw = run.toolCalls[0]?.input
  if (!raw || !isValidIso(raw.eventDate)) return null
  const rebased = { ...raw, eventDate: addDays(raw.eventDate, shift), ...(raw.signedOn ? { signedOn: addDays(raw.signedOn, shift) } : {}) }
  if (!text.includes(rebased.eventDate)) return null
  const parsed = readSchema.safeParse(rebased)
  if (!parsed.success) return null
  try {
    verifyAgainstText(structuredClone(parsed.data), text)
  } catch {
    return null
  }
  return { raw: rebased, label: recordingLabel(run) }
}

const SOURCES = { live: 'claude', account: 'claude-account', mock: 'mock-reader' }
const SOURCE_LABELS = { claude: 'Claude (API key)', 'claude-account': 'Claude Sonnet (local account)', 'mock-reader': 'the rule-based reader' }

// Exported so tests can swap in a fake model; nothing else touches it.
export const LIVE_READERS = { live: readContractLive, account: readContractAccount }

export async function readContract(text, { edits = [], offline = false, sampleKey = null, today = null } = {}) {
  const mode = offline ? 'mock' : modes.llm
  let fallbackReason = null
  if (mode === 'live' || mode === 'account') {
    const run = LIVE_READERS[mode]
    // Only the hosted key path is capped; the local account backend is the developer's own login.
    const attempt = await attemptLive(() => run(text), mode === 'live' ? {} : { limiter: { take: () => true } })
    if (attempt.out) {
      const source = SOURCES[mode]
      return { ...acceptReading(attempt.out, text, edits), source, sourceLabel: SOURCE_LABELS[source] }
    }
    fallbackReason = attempt.reason
  }
  const because = fallbackReason ? ` (${fallbackReason})` : ''
  const replay = !offline ? recordedReading(sampleKey, text, today) : null
  if (replay) return { ...acceptReading(replay.raw, text, edits), source: 'recorded-claude', sourceLabel: `${replay.label}${because}` }
  const label = fallbackReason ? `Rule-based stand-in${because}` : SOURCE_LABELS['mock-reader']
  return { ...acceptReading(readContractMock(text), text, edits), source: 'mock-reader', sourceLabel: label }
}
