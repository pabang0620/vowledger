import { z } from 'zod'

export class ContractError extends Error {
  constructor(message) {
    super(message)
    this.status = 422
  }
}

export const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`
export const money2 = (cents) => (cents / 100).toFixed(2)

// Shape of one payment clause as the model (or the mock reader) returns it. Numbers must come from the quote.
export const clauseSchema = z.object({
  label: z.string().min(1).max(60),
  percent: z.number().positive().max(100),
  anchor: z.enum(['SIGNING', 'EVENT']),
  offsetDays: z.number().int().min(-730).max(0),
  quote: z.string().min(8).max(500),
})

export const MIN_INSTALLMENTS = 2
export const MAX_INSTALLMENTS = 6

// Money is computed here, never by the model: cents per clause = round(total * percent / 100).
export function buildSteps(clauses, totalCents) {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new ContractError('Contract total must be a positive amount.')
  if (clauses.length < MIN_INSTALLMENTS || clauses.length > MAX_INSTALLMENTS) {
    throw new ContractError(`Expected ${MIN_INSTALLMENTS} to ${MAX_INSTALLMENTS} payment clauses, found ${clauses.length}.`)
  }
  const steps = clauses.map((c, i) => ({
    id: `p${i + 1}`,
    kind: 'installment',
    label: c.label,
    percent: c.percent,
    amountCents: Math.round((totalCents * c.percent) / 100),
    anchor: c.anchor,
    offsetDays: c.offsetDays,
    quote: c.quote,
    invoice: null,
  }))
  // Percents that add up to 100 always give exactly the total: the last step takes the rounding cents.
  const percentSum = clauses.reduce((s, c) => s + c.percent, 0)
  if (Math.abs(percentSum - 100) < 1e-9) {
    const head = steps.slice(0, -1).reduce((s, x) => s + x.amountCents, 0)
    steps[steps.length - 1].amountCents = totalCents - head
  }
  const sum = steps.reduce((s, x) => s + x.amountCents, 0)
  if (sum !== totalCents) {
    throw new ContractError(`Clauses add up to ${usd(sum)}, contract total is ${usd(totalCents)}. Edit a step or upload again.`)
  }
  return steps
}

// Production tasks that hang off the payments. Positions, not names, so any 2 to 6 step contract works.
export function templateTasks(steps) {
  const first = steps[0].id
  const second = steps[Math.min(1, steps.length - 1)].id
  const last = steps[steps.length - 1].id
  return [
    { id: 't1', name: 'Engagement shoot', after: first, lagDays: 14, durationDays: 1, cost: 'internal' },
    { id: 't2', name: 'Album order', after: second, lagDays: 1, durationDays: 3, cost: 'external', deadlineOffsetDays: -21 },
    { id: 't3', name: 'Final shot list', after: last, lagDays: 3, durationDays: 2, cost: 'internal' },
  ]
}
