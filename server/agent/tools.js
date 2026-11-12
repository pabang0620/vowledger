import { scheduleOf } from '../services/contracts.js'
import { depositLabel } from '../schedule/depositStatus.js'

// Tools the model can call. Read tools plus propose_option. There is no tool that moves money or writes a date.

export class ToolError extends Error {}

const ISO_IN_TEXT = /\d{4}-\d{2}-\d{2}/
const AMOUNT_IN_TEXT = /\$\s?\d|\b\d[\d,]*(\.\d+)?\s?(usd|dollars?)\b/i
const MOVE_WORDS = /\b(move|moves|moved|moving|shift|shifts|shifted|shifting|slide|slides|reschedul\w*|later|earlier)\b/i
const STAY_WORDS = /\b(not|never|stay|stays|unchanged|pinned|fixed|keeps? (its|their) (dates?|place))\b|n't\b/i

// Which tasks an option moves and which it leaves alone, compared with the confirmed schedule.
function taskEffect(now, option) {
  const was = new Map(now.tasks.map((t) => [t.id, t.startDate]))
  const moving = option.schedule.tasks.filter((t) => was.get(t.id) !== t.startDate).map((t) => t.name)
  const unchanged = option.schedule.tasks.filter((t) => was.get(t.id) === t.startDate).map((t) => t.name)
  return { moving, unchanged }
}

// The reason must not say that a task moves when the chosen option leaves it where it is (for example a task tied to a
// captured deposit when the wedding moves). Checked per sentence: a sentence with a move word may not name an unchanged
// task, unless it is a "does not move" sentence that names no moving task.
export function misnamedTasks(reason, effect) {
  const bad = new Set()
  for (const sentence of reason.split(/(?<=[.!?;])\s+/)) {
    if (!MOVE_WORDS.test(sentence)) continue
    const names = effect.unchanged.filter((n) => sentence.toLowerCase().includes(n.toLowerCase()))
    if (!names.length) continue
    const namesMoving = effect.moving.some((n) => sentence.toLowerCase().includes(n.toLowerCase()))
    if (STAY_WORDS.test(sentence) && !namesMoving) continue
    names.forEach((n) => bad.add(n))
  }
  return [...bad]
}

function contractClauses(contract) {
  return [
    ...contract.steps.filter((s) => s.kind === 'installment').map((s) => ({ id: s.id, label: s.label, quote: s.quote })),
    ...(contract.dateChangeFee ? [{ id: 'date_change', label: 'Date change fee', quote: contract.dateChangeFee.quote }] : []),
  ]
}

// Every option the model did not pick must be named once, with its own reason. Returns them with their labels.
export function checkNotChosen(options, chosenId, notChosen) {
  if (!Array.isArray(notChosen)) throw new ToolError('not_chosen must be a list of { option_id, why }.')
  const others = options.filter((o) => o.id !== chosenId)
  const seen = new Set()
  for (const item of notChosen) {
    if (!item || typeof item.option_id !== 'string' || !others.some((o) => o.id === item.option_id)) throw new ToolError(`not_chosen names "${item?.option_id}", which is not one of the other options: ${others.map((o) => o.id).join(', ') || 'none'}.`)
    if (seen.has(item.option_id)) throw new ToolError(`not_chosen names "${item.option_id}" twice.`)
    if (typeof item.why !== 'string' || item.why.trim().length < 5 || item.why.length > 300) throw new ToolError('Each not_chosen why must be 5 to 300 characters.')
    if (ISO_IN_TEXT.test(item.why) || AMOUNT_IN_TEXT.test(item.why)) throw new ToolError('Do not write dates or amounts in not_chosen.')
    seen.add(item.option_id)
  }
  const missing = others.filter((o) => !seen.has(o.id)).map((o) => o.id)
  if (missing.length) throw new ToolError(`not_chosen must also explain: ${missing.join(', ')}.`)
  return notChosen.map((item) => ({ optionId: item.option_id, label: others.find((o) => o.id === item.option_id).label, why: item.why.trim() }))
}

export const TOOL_DEFS = [
  { name: 'get_invoice_status', description: 'Status and PayPal dates of the invoice for one payment step.', input_schema: { type: 'object', properties: { step_id: { type: 'string' } }, required: ['step_id'] } },
  { name: 'get_schedule', description: 'The current confirmed schedule: payments and production tasks with their dates. followsWedding / movesWithWedding say whether an item is counted back from the wedding date (it moves when the wedding moves) or is tied to a sent or paid payment (it never moves).', input_schema: { type: 'object', properties: {} } },
  { name: 'get_dependents', description: 'Production tasks that follow a payment step, with whether they cost outside money.', input_schema: { type: 'object', properties: { step_id: { type: 'string' } }, required: ['step_id'] } },
  { name: 'list_contract_clauses', description: 'Contract clauses with their exact quotes. Optional topic filter.', input_schema: { type: 'object', properties: { topic: { type: 'string' } } } },
  { name: 'list_options', description: 'The choices the server computed for this event, each with the schedule it would produce and the task names it moves and leaves unchanged. Pick from these ids only.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'propose_option',
    description: 'Choose one option id from list_options and explain why in plain words. Do not write dates or amounts: refer to tasks and contract sections. Only say a task moves if it is in that option\'s movingTasks; name unchanged tasks in a separate sentence. In not_chosen, give every other option id from list_options with one short sentence why you did not choose it. The server draws the chosen schedule and asks a human to approve.',
    input_schema: {
      type: 'object',
      properties: {
        option_id: { type: 'string' },
        reason: { type: 'string' },
        not_chosen: {
          type: 'array',
          description: 'Every other option id from list_options, each with why it was not chosen (no dates, no amounts)',
          items: { type: 'object', properties: { option_id: { type: 'string' }, why: { type: 'string' } }, required: ['option_id', 'why'] },
        },
        reminder_note: { type: 'string', description: 'Only for an unpaid installment: a short polite note for the client (no dates, no amounts)' },
        reminder_clause: { type: 'string', description: 'With reminder_note: the id of the contract clause (from list_contract_clauses) the reminder rests on' },
      },
      required: ['option_id', 'reason', 'not_chosen'],
    },
  },
]

export function buildTools(ctx, contract, trigger, options, sink) {
  const find = (id) => contract.steps.find((s) => s.id === id)
  const now = scheduleOf(ctx, contract)
  const effects = new Map(options.map((o) => [o.id, taskEffect(now, o)]))
  return {
    get_invoice_status({ step_id }) {
      const step = find(step_id)
      if (!step) throw new ToolError(`Unknown step ${step_id}`)
      if (step.deposit) return { step_id, number: 'Deposit', status: depositLabel(step), issueDate: step.deposit.issueDate, dueDate: step.deposit.dueDate, paidCents: step.deposit.status === 'COMPLETED' ? step.amountCents : 0 }
      if (!step.invoice) return { step_id, invoice: null }
      const { number, status, remote, paidCents } = step.invoice
      return { step_id, number, status, issueDate: remote.issueDate, dueDate: remote.dueDate, paidCents }
    },
    get_schedule() {
      const s = scheduleOf(ctx, contract)
      return {
        eventDate: s.eventDate,
        steps: s.steps.map((x) => ({ id: x.id, label: x.label, dueDate: x.dueDate, pinned: x.pinned, paid: x.paid, followsWedding: x.follows })),
        tasks: s.tasks.map((t) => ({ id: t.id, name: t.name, after: t.after, startDate: t.startDate, endDate: t.endDate, cost: t.cost, movesWithWedding: !t.fixed, tiedToPinnedPayment: t.pinnedChain, waitsForPayment: t.waitsFor })),
      }
    },
    get_dependents({ step_id }) {
      return scheduleOf(ctx, contract).tasks.filter((t) => t.after === step_id).map((t) => ({ id: t.id, name: t.name, cost: t.cost, startDate: t.startDate }))
    },
    list_contract_clauses({ topic } = {}) {
      const all = contractClauses(contract)
      if (!topic) return all
      const t = topic.toLowerCase()
      return all.filter((c) => c.label.toLowerCase().includes(t) || c.quote.toLowerCase().includes(t))
    },
    list_options() {
      return options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        resultTasks: o.schedule.tasks.map((t) => ({ id: t.id, name: t.name, startDate: t.startDate, endDate: t.endDate })),
        movingTasks: effects.get(o.id).moving,
        unchangedTasks: effects.get(o.id).unchanged,
        feeCents: o.feeCents,
      }))
    },
    propose_option({ option_id, reason, not_chosen: notChosen = [], reminder_note, reminder_clause }) {
      if (typeof option_id !== 'string' || ISO_IN_TEXT.test(option_id)) throw new ToolError('option_id must be an id returned by list_options, not a date.')
      if (!options.some((o) => o.id === option_id)) throw new ToolError(`Unknown option_id "${option_id}". Valid ids: ${options.map((o) => o.id).join(', ')}`)
      if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 800) throw new ToolError('reason must be 5 to 800 characters.')
      if (ISO_IN_TEXT.test(reason)) throw new ToolError('Do not write dates in the reason. Refer to tasks and contract sections; the server shows the dates.')
      if (AMOUNT_IN_TEXT.test(reason)) throw new ToolError('Do not write amounts in the reason. The server computes every amount.')
      const wrong = misnamedTasks(reason, effects.get(option_id))
      if (wrong.length) throw new ToolError(`The reason says ${wrong.map((n) => `"${n}"`).join(', ')} moves, but this option leaves ${wrong.length === 1 ? 'it' : 'them'} unchanged. Tasks this option moves: ${effects.get(option_id).moving.join(', ') || 'none'}. Name unchanged tasks in their own sentence.`)
      const alternatives = checkNotChosen(options, option_id, notChosen)
      let reminderQuote = null
      if (reminder_note) {
        if (reminder_note.length > 600 || ISO_IN_TEXT.test(reminder_note) || AMOUNT_IN_TEXT.test(reminder_note)) throw new ToolError('reminder_note must be under 600 characters and contain no dates and no amounts.')
        if (reminder_clause !== undefined) {
          const clause = contractClauses(contract).find((c) => c.id === reminder_clause)
          if (!clause) throw new ToolError(`Unknown reminder_clause "${reminder_clause}". Valid ids: ${contractClauses(contract).map((c) => c.id).join(', ')}`)
          reminderQuote = clause.quote
        }
      }
      sink.choice = { optionId: option_id, reason: reason.trim(), notChosen: alternatives, reminderNote: reminder_note?.trim() || null, reminderClause: reminder_clause || null, reminderQuote }
      return { ok: true, message: 'Proposal recorded. A human must approve it before anything changes.' }
    },
  }
}

export async function runToolSafely(handlers, name, input) {
  const fn = handlers[name]
  if (!fn) return { ok: false, result: { error: `Unknown tool ${name}` } }
  try {
    return { ok: true, result: await fn(input || {}) }
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, result: { error: err.message } }
    throw err
  }
}
