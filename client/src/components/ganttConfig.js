import { parseIso, short } from '../dates.js'

// Turns the server's gantt payload into Bryntum data. No date is computed here: lags and constraints
// are copied from the server so Bryntum's own engine can preview a drag; the drop result is the server's.

const STATUS_SHORT = { SCHEDULED: 'SCHED', ORDER_CREATED: 'ORDER', PARTIALLY_PAID: 'PART PAID', MARKED_AS_PAID: 'PAID' }
const statusWord = (status) => STATUS_SHORT[status] || status.replace('_', ' ')

// Short label on the bar, for example "INV-0027 · SCHED · due Mar 1". Long sync details live in the tooltip.
function label(row) {
  if (row.kind === 'event') return `WEDDING DAY ${short(row.startDate)} (drag me)`
  if (row.kind === 'payment' && row.badge) {
    const b = row.badge
    if (b.syncState === 'not_synced') return `${b.number} · NOT SYNCED · due ${short(b.dueDate)}`
    return `${b.number} · ${statusWord(b.status)} · due ${short(b.dueDate)}`
  }
  if (row.kind === 'payment') return `not invoiced yet · due ${short(row.startDate)}`
  if (row.waitsFor) return `${row.name} (held: waits for ${row.waitsFor})`
  if (row.adjusted === 'hold') return `${row.name} (held)`
  return row.name
}

// Full text for the hover tooltip, including what PayPal holds right now.
function tooltip(row) {
  if (row.kind === 'event') return 'Wedding day. Drag the diamond to a new day: the server drafts the PayPal changes for you to approve.'
  if (row.kind === 'payment' && row.badge) {
    const b = row.badge
    const lines = [`${b.number} ${row.name}`, `Status ${b.status}. PayPal sends ${short(b.issueDate)}, due ${short(b.dueDate)}.`]
    if (b.syncState === 'not_synced') lines.push(`NOT SYNCED: PayPal still has send ${short(b.remoteIssueDate)}, due ${short(b.remoteDueDate)}. Use Retry.`)
    if (row.pinned) lines.push('Pinned: sent or paid, the plan never moves it.')
    else if (b.type !== 'order') lines.push('Scheduled: drag it later to draft an extension.')
    return lines.join(' ')
  }
  if (row.kind === 'payment') return `${row.name}: not invoiced yet, due ${short(row.startDate)}.`
  if (row.waitsFor) return `${row.name} waits for ${row.waitsFor}: the hold ends as soon as PayPal reports it PAID, and moves later each day it stays unpaid.`
  if (row.chained) return `${row.name} follows a pinned payment, so it does not move with the wedding.`
  return row.name
}

function clsOf(row) {
  const cls = [`vl-${row.kind}`]
  if (row.pinned) cls.push('vl-pinned')
  if (row.chained) cls.push('vl-chained')
  if (row.paid) cls.push('vl-paid')
  if (row.badge?.syncState === 'not_synced') cls.push('vl-unsynced')
  if (row.adjusted === 'hold') cls.push('vl-held')
  if (row.cost === 'external') cls.push('vl-external')
  if (row.baselines.some((b) => b.name === 'previous')) cls.push('vl-moved')
  return cls.join(' ')
}

// A scheduled invoice (not sent, not paid, not a checkout order) can be dragged later to draft an extension.
const isExtendable = (row) => row.kind === 'payment' && !row.pinned && row.badge?.type !== 'order' && row.badge?.status === 'SCHEDULED'

export function toTasksData(rows) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startDate: parseIso(row.startDate),
    duration: row.duration,
    durationUnit: 'day',
    cls: clsOf(row),
    rightLabel: label(row),
    tooltip: tooltip(row),
    extendable: isExtendable(row),
    chained: Boolean(row.chained),
    issueDate: row.issueDate && row.issueDate < row.startDate ? parseIso(row.issueDate) : null,
    kind: row.kind,
    pinned: Boolean(row.pinned),
    badge: row.badge || null,
    constraintType: row.constraintType || null,
    constraintDate: row.constraintDate ? parseIso(row.constraintDate) : null,
    deadlineDate: row.deadlineDate ? parseIso(row.deadlineDate) : null,
    baselines: row.baselines.map((b) => ({ name: b.name, cls: `vl-bl-${b.name}`, startDate: parseIso(b.startDate), endDate: parseIso(b.endDate) })),
  }))
}

export function toDependenciesData(deps) {
  return deps.map((d) => ({ id: d.id, from: d.from, to: d.to, type: 2, lag: d.lag, lagUnit: 'day' }))
}

// A calendar with no non-working time, so a 3 day task is 3 calendar days, like the invoices.
export const ALL_DAYS = [{ id: 'allDays', name: 'Every day', intervals: [] }]

// Bryntum draws these as full-height bands: where today is, and the wedding day.
export function toTimeRanges(gantt, today) {
  return [
    { id: 'today', name: 'Today', startDate: parseIso(today), duration: 1, durationUnit: 'day', cls: 'vl-range-today' },
    { id: 'wedding', name: 'Wedding day', startDate: parseIso(gantt.eventDate), duration: 1, durationUnit: 'day', cls: 'vl-range-wedding' },
  ]
}

// Pixels per day on the time axis. Fixed (6 px = 42 px per week) so the deposit through the balance fit a 1440 px screen,
// and a 3 day task or a 14 day baseline is still a bar you can see. The panel scrolls sideways to the wedding.
export const DAY_PX = 6
