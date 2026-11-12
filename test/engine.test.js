import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSchedule, issueDateFor, moveConflict, dueForPaypal } from '../server/schedule/engine.js'
import { buildSteps, templateTasks, ContractError } from '../server/schedule/compute.js'
import { addDays, diffDays, weekday } from '../server/dates.js'
import { TODAY } from './helpers.js'

const CLAUSES = [
  { label: 'Retainer', percent: 30, anchor: 'SIGNING', offsetDays: 0, quote: 'Retainer of 30% due at signing' },
  { label: 'Second installment', percent: 40, anchor: 'EVENT', offsetDays: -60, quote: '40% due 60 days before the event' },
  { label: 'Balance', percent: 30, anchor: 'EVENT', offsetDays: -30, quote: '30% due 30 days before the event' },
]

function modelFor(eventDate, overrides = {}) {
  const steps = buildSteps(CLAUSES, 480000)
  return { eventDate, signedOn: TODAY, leadDays: 14, steps, tasks: templateTasks(steps), adjustments: {}, ...overrides }
}

const row = (sched, id) => sched.steps.find((s) => s.id === id)
const pair = (s) => `${s.issueDate} / ${s.dueDate}`

test('issue date rule: due - 14 days, never in the past', () => {
  assert.deepEqual(issueDateFor('2027-01-11', TODAY), { issueDate: '2026-12-28', sendNow: false })
  assert.deepEqual(issueDateFor('2026-11-12', TODAY), { issueDate: TODAY, sendNow: true })
  assert.deepEqual(issueDateFor('2026-11-20', TODAY), { issueDate: TODAY, sendNow: true })
  assert.equal(issueDateFor('2026-11-26', TODAY).sendNow, true)
  assert.equal(issueDateFor('2026-11-27', TODAY).sendNow, false)
})

test('sample A (event T+60) reproduces every plan date', () => {
  const event = addDays(TODAY, 60)
  assert.equal(event, '2027-01-11')
  const s = computeSchedule(modelFor(event), TODAY)
  assert.equal(pair(row(s, 'p1')), '2026-11-12 / 2026-11-12')
  assert.equal(row(s, 'p1').sendNow, true)
  assert.equal(pair(row(s, 'p2')), '2026-11-12 / 2026-11-12')
  assert.equal(row(s, 'p2').sendNow, true)
  assert.equal(pair(row(s, 'p3')), '2026-11-28 / 2026-12-12')
  assert.equal(row(s, 'p3').sendNow, false)
})

test('sample B (event T+120) reproduces every plan date', () => {
  const event = addDays(TODAY, 120)
  assert.equal(event, '2027-03-12')
  assert.equal(weekday(event), 'Fri')
  const s = computeSchedule(modelFor(event), TODAY)
  assert.equal(pair(row(s, 'p1')), '2026-11-12 / 2026-11-12')
  assert.equal(pair(row(s, 'p2')), '2026-12-28 / 2027-01-11')
  assert.equal(pair(row(s, 'p3')), '2027-01-27 / 2027-02-10')
})

test('sample B moved Mar 12 -> Apr 30 (+49 days)', () => {
  assert.equal(diffDays('2027-04-30', '2027-03-12'), 49)
  assert.equal(weekday('2027-04-30'), 'Fri')
  const s = computeSchedule(modelFor('2027-04-30'), TODAY)
  assert.equal(pair(row(s, 'p2')), '2027-02-15 / 2027-03-01')
  assert.equal(pair(row(s, 'p3')), '2027-03-17 / 2027-03-31')
})

test('month end: Feb 28 is not skipped', () => {
  const s = computeSchedule(modelFor('2027-04-30'), TODAY)
  assert.equal(addDays('2027-03-01', -1), '2027-02-28')
  assert.equal(row(s, 'p2').issueDate, '2027-02-15')
})

test('past due date: contract keeps the real date, PayPal gets today', () => {
  const s = computeSchedule(modelFor(addDays(TODAY, 57)), TODAY)
  assert.equal(row(s, 'p2').dueDate, '2026-11-09')
  assert.equal(dueForPaypal(row(s, 'p2').dueDate, TODAY), TODAY)
  assert.equal(row(s, 'p2').issueDate, TODAY)
})

test('a contract clause can change the lead days', () => {
  const s = computeSchedule(modelFor('2027-03-12', { leadDays: 7 }), TODAY)
  assert.equal(pair(row(s, 'p2')), '2027-01-04 / 2027-01-11')
})

test('tasks follow their payment; pinned chains do not move', () => {
  const steps = buildSteps(CLAUSES, 480000)
  const sent = (id) => steps.map((st) => (st.id === id ? { ...st, invoice: { status: 'SENT', remote: { issueDate: '2026-11-12', dueDate: '2026-11-12' } } } : st))
  const model = modelFor('2027-03-12', { steps: sent('p1') })
  const before = computeSchedule(model, TODAY)
  const after = computeSchedule({ ...model, eventDate: '2027-04-30' }, TODAY)
  const task = (s, id) => s.tasks.find((t) => t.id === id)
  assert.equal(task(before, 't1').startDate, task(after, 't1').startDate)
  assert.equal(task(after, 't1').fixed, true)
  assert.equal(task(after, 't2').fixed, false)
  assert.equal(diffDays(task(after, 't2').startDate, task(before, 't2').startDate), 49)
  assert.equal(task(before, 't2').deadlineDate, '2027-02-19')
})

test('hold keeps a task back; pull needs a pinned predecessor', () => {
  const steps = buildSteps(CLAUSES, 480000)
  const base = modelFor('2027-03-12')
  const held = computeSchedule({ ...base, adjustments: { t2: { kind: 'hold', date: '2027-02-01' } } }, TODAY)
  assert.equal(held.tasks.find((t) => t.id === 't2').startDate, '2027-02-01')
  const followsWedding = computeSchedule({ ...base, adjustments: { t2: { kind: 'pull', date: '2026-11-13' } } }, TODAY)
  assert.equal(followsWedding.tasks.find((t) => t.id === 't2').startDate, '2027-01-12')
  const pinned = steps.map((st) => (st.id === 'p1' ? { ...st, invoice: { status: 'PAID', remote: { issueDate: TODAY, dueDate: TODAY } } } : st))
  const pulled = computeSchedule({ ...base, steps: pinned, adjustments: { t1: { kind: 'pull', date: '2026-11-13' } } }, TODAY)
  assert.equal(pulled.tasks.find((t) => t.id === 't1').startDate, '2026-11-13')
})

test('moving the wedding earlier is rejected when it collides with a pinned payment', () => {
  const steps = buildSteps(CLAUSES, 480000).map((st) => (st.id === 'p2' ? { ...st, invoice: { status: 'SENT', remote: { issueDate: '2026-12-28', dueDate: '2027-01-11' } } } : st))
  const model = modelFor('2027-03-12', { steps })
  assert.equal(moveConflict(model, '2027-04-30', TODAY), null)
  assert.equal(moveConflict(model, '2027-02-20', TODAY), null)
  const msg = moveConflict(model, '2027-02-05', TODAY)
  assert.match(msg, /pinned/)
  assert.match(moveConflict(model, '2026-11-01', TODAY), /after today/)
})

test('money: cents add up to the total or the check fails with the plan wording', () => {
  const steps = buildSteps(CLAUSES, 480000)
  assert.deepEqual(steps.map((s) => s.amountCents), [144000, 192000, 144000])
  const bad = CLAUSES.map((c, i) => (i === 1 ? { ...c, percent: 35 } : c))
  assert.throws(() => buildSteps(bad, 480000), (e) => e instanceof ContractError && e.message.startsWith('Clauses add up to $4,560, contract total is $4,800.'))
  assert.throws(() => buildSteps(CLAUSES.slice(0, 1), 480000), ContractError)
  const odd = buildSteps([{ ...CLAUSES[0], percent: 50 }, { ...CLAUSES[1], percent: 50 }], 100001)
  assert.equal(odd.reduce((s, x) => s + x.amountCents, 0), 100001)
})
