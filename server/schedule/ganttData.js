import { addDays, diffDays } from '../dates.js'
import { depositLabel } from './depositStatus.js'

// Everything the Gantt needs, as plain data. Dates come from the engine; this file only reshapes them
// (and turns date gaps into dependency lags so Bryntum's own engine can preview a drag).

function badge(step, sstep, today) {
  const inv = step?.invoice
  // Deposit (PayPal Orders checkout): same badge fields as an invoice, so the Gantt draws it with the same pills.
  if (step && (step.deposit || step.depositUnknown) && !inv) {
    return {
      type: 'order',
      number: 'Deposit',
      status: depositLabel(step),
      issueDate: sstep.issueDate,
      dueDate: sstep.dueDate,
      remoteIssueDate: sstep.issueDate,
      remoteDueDate: sstep.dueDate,
      pinned: sstep.pinned,
      syncState: 'synced',
      overdueDays: 0,
    }
  }
  if (!inv) return null
  return {
    number: inv.number,
    status: inv.status,
    issueDate: sstep.issueDate,
    dueDate: sstep.dueDate,
    remoteIssueDate: inv.remote.issueDate,
    remoteDueDate: inv.remote.dueDate,
    pinned: sstep.pinned,
    syncState: inv.syncState,
    overdueDays: sstep.overdueDays,
  }
}

const waitRef = (step) => step?.invoice?.number || step?.label || null

// Baseline 0 = the plan before the last change (grey). Baseline 1 = the agent's proposal (dotted). The name picks the style.
const bl = (name, start, end) => ({ name, startDate: start, endDate: end })

export function ganttData(contract, schedule, { baseline0 = null, proposal = null, today }) {
  const rows = []
  const deps = []
  const event = schedule.eventDate
  const b0Steps = new Map((baseline0?.steps || []).map((s) => [s.id, s]))
  const b0Tasks = new Map((baseline0?.tasks || []).map((t) => [t.id, t]))
  const p1Steps = new Map((proposal?.schedule.steps || []).map((s) => [s.id, s]))
  const p1Tasks = new Map((proposal?.schedule.tasks || []).map((t) => [t.id, t]))

  const baselinesFor = (b0, p1, startOf, endOf) => {
    const list = []
    if (b0) list.push(bl('previous', startOf(b0), endOf(b0)))
    if (p1) list.push(bl('proposal', startOf(p1), endOf(p1)))
    return list
  }

  for (const s of schedule.steps) {
    const step = contract.steps.find((x) => x.id === s.id)
    const b0 = b0Steps.get(s.id)
    const p1 = p1Steps.get(s.id)
    const changed0 = b0 && (b0.dueDate !== s.dueDate)
    rows.push({
      id: s.id,
      name: s.kind === 'fee' ? `${s.label}` : `${s.label} ${step.percent ? `${step.percent}%` : ''}`.trim(),
      kind: 'payment',
      milestone: true,
      startDate: s.dueDate,
      duration: 0,
      amountCents: s.amountCents,
      issueDate: s.issueDate,
      pinned: s.pinned,
      paid: s.paid,
      constraintType: s.follows ? null : 'muststarton',
      constraintDate: s.follows ? null : s.dueDate,
      baselines: baselinesFor(changed0 ? b0 : null, p1 && p1.dueDate !== s.dueDate ? p1 : null, (x) => x.dueDate, (x) => x.dueDate),
      badge: badge(step, s, today),
    })
    if (s.follows) deps.push({ id: `d-${s.id}`, from: s.id, to: 'event', lag: diffDays(event, s.dueDate), lagUnit: 'day' })
  }

  for (const t of schedule.tasks) {
    const b0 = b0Tasks.get(t.id)
    const p1 = p1Tasks.get(t.id)
    rows.push({
      id: t.id,
      name: t.name,
      kind: 'task',
      milestone: false,
      startDate: t.startDate,
      duration: t.durationDays,
      cost: t.cost,
      // A task that follows a pinned payment. It is not pinned itself, so the Gantt draws it with a chain, not a pin.
      chained: t.pinnedChain,
      pinned: false,
      adjusted: t.adjusted,
      // The invoice (or deposit) this held task waits for: the hold ends when PayPal reports it PAID.
      waitsFor: t.waitsFor ? waitRef(contract.steps.find((x) => x.id === t.waitsFor)) : null,
      deadlineDate: t.deadlineDate,
      constraintType: t.fixed ? 'muststarton' : t.adjusted === 'hold' ? 'startnoearlierthan' : null,
      constraintDate: t.fixed || t.adjusted === 'hold' ? t.startDate : null,
      baselines: baselinesFor(b0 && b0.startDate !== t.startDate ? b0 : null, p1 && p1.startDate !== t.startDate ? p1 : null, (x) => x.startDate, (x) => x.endDate),
    })
    const predIsStep = schedule.steps.some((s) => s.id === t.after)
    const predEnd = predIsStep ? schedule.steps.find((s) => s.id === t.after).dueDate : schedule.tasks.find((x) => x.id === t.after).endDate
    deps.push({ id: `d-${t.after}-${t.id}`, from: t.after, to: t.id, lag: diffDays(t.startDate, predEnd), lagUnit: 'day' })
    if (!t.fixed) deps.push({ id: `d-${t.id}-event`, from: t.id, to: 'event', lag: diffDays(event, t.endDate), lagUnit: 'day' })
  }

  const b0Event = baseline0 && baseline0.eventDate !== event ? { startDate: baseline0.eventDate, endDate: baseline0.eventDate } : null
  rows.push({
    id: 'event',
    name: 'WEDDING DAY',
    kind: 'event',
    milestone: true,
    startDate: event,
    duration: 0,
    pinned: false,
    // ALAP puts the wedding at the latest allowed day, which is where the server put it. Dragging rewrites this date.
    constraintType: 'startnolaterthan',
    constraintDate: event,
    baselines: b0Event ? [bl('previous', b0Event.startDate, b0Event.endDate)] : [],
  })

  return {
    direction: 'Backward',
    eventDate: event,
    today,
    // The timeline opens a week before today (or before the earliest bar), so the first screen is the present, not the whole plan.
    projectStart: addDays(rows.reduce((m, r) => (r.startDate < m ? r.startDate : m), today), -7),
    // The scheduling end sits far behind the wedding so the bar can be dragged later; the timeline shows 75 days after it.
    projectEnd: addDays(event, 200),
    timelineEnd: addDays(event, 75),
    rows,
    dependencies: deps,
  }
}
