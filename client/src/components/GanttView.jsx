import { useMemo, useRef, useEffect } from 'react'
import { BryntumGantt } from '@bryntum/gantt-react'
import '@bryntum/gantt/gantt.css'
import '@bryntum/gantt/stockholm-light.css'
import '@bryntum/gantt/fontawesome/css/fontawesome.css'
import '@bryntum/gantt/fontawesome/css/solid.css'
import { toIso, parseIso, short } from '../dates.js'
import { toTasksData, toDependenciesData, toTimeRanges, ALL_DAYS, DAY_PX } from './ganttConfig.js'

const ROW_HEIGHT = 46
const HEADER_AND_FOOTER = 74
const WEEK_PX = DAY_PX * 7

// Month on top, the Monday of each week below as a plain day number: it stays legible at 6 px per day.
const HEADERS = [
  { unit: 'month', dateFormat: 'MMM YYYY' },
  { unit: 'week', renderer: (start) => String(start.getDate()) },
]

const pill = (text, cls) => ({ tag: 'span', className: `vl-pill ${cls}`, text })
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const NARROW = typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches

// A pin means "sent or paid, never moved". A chain means "a task that follows a pinned payment". Two meanings, two icons.
function nameRenderer({ record, value }) {
  const icon = record.kind === 'payment' && record.pinned
    ? { tag: 'i', className: 'fa fa-thumbtack vl-ico vl-ico-pin', title: 'Pinned: sent or paid, never moved' }
    : record.chained
      ? { tag: 'i', className: 'fa fa-link vl-ico vl-ico-chain', title: 'Follows a pinned payment, does not move with the wedding' }
      : null
  return [icon, { tag: 'span', className: 'vl-name', text: value }].filter(Boolean)
}

function badgeRenderer({ record }) {
  const b = record.badge
  if (!b) return record.kind === 'payment' ? pill('not invoiced', 'vl-p-none') : ''
  const status = pill(b.status.replace('_', ' '), `vl-p-status vl-p-${b.status.toLowerCase()}`)
  if (b.type === 'order' || b.syncState === 'synced') return status
  // The full wording is in the bar label and the tooltip; the column only flags the problem.
  const wait = b.syncState === 'pending'
  return [status, { tag: 'i', className: `fa ${wait ? 'fa-rotate' : 'fa-triangle-exclamation'} vl-ico ${wait ? 'vl-ico-wait' : 'vl-ico-bad'}`, title: wait ? 'Syncing with PayPal' : 'Not synced with PayPal' }]
}

const allColumns = [
  { type: 'name', text: 'Task', width: 230, field: 'name', renderer: nameRenderer },
  { text: 'PayPal', width: 130, sortable: false, field: 'badge', renderer: badgeRenderer },
]

const columns = NARROW ? allColumns.slice(0, 1).map((c) => ({ ...c, width: 170 })) : allColumns

// Baselines: "previous" = the plan before the last change (grey), "proposal" = the agent's pick (orange, dashed).
// The label sits outside the bar and carries the date the server computed.
function baselineRenderer({ baselineRecord }) {
  const date = short(toIso(baselineRecord.startDate))
  return baselineRecord.name === 'proposal'
    ? { tag: 'span', className: 'vl-bl-label vl-bl-label-proposal', text: `proposal: ${date}` }
    : { tag: 'span', className: 'vl-bl-label', text: `was ${date}` }
}

// Show what just changed: the proposal bars first, otherwise the wedding bar after a drag.
function focusTaskId(rows) {
  const proposed = rows.find((r) => r.baselines.some((b) => b.name === 'proposal'))
  if (proposed) return proposed.id
  return rows.find((r) => r.id === 'event' && r.baselines.length > 0) ? 'event' : null
}

const indicatorItems = {
  // Built-in indicators we do not use are switched off; deadline and constraint come from the server's data.
  earlyDates: false,
  lateDates: false,
  deadlineDate: true,
  constraintDate: true,
  // The issue date rule (due date minus 14 days) is the heart of the product, so it gets its own marker.
  issueDate: (task) => (task.issueDate ? { startDate: task.issueDate, name: `PayPal sends ${short(toIso(task.issueDate))}`, iconCls: 'fa fa-paper-plane', cls: 'vl-ind-issue' } : null),
}

export default function GanttView({ gantt, busy, readOnly = false, onMoveEvent, onExtend }) {
  const ref = useRef(null)
  const lastDrag = useRef(null)
  const ganttKey = useMemo(() => JSON.stringify([gantt.rows, gantt.dependencies]), [gantt])

  const project = useMemo(() => ({
    direction: gantt.direction,
    calendars: ALL_DAYS,
    calendar: 'allDays',
    hoursPerDay: 24,
    daysPerWeek: 7,
    daysPerMonth: 30,
    endDate: parseIso(gantt.projectEnd),
    tasks: toTasksData(gantt.rows),
    dependencies: toDependenciesData(gantt.dependencies),
    timeRanges: toTimeRanges(gantt, gantt.today),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ganttKey])

  useEffect(() => {
    const instance = ref.current?.instance
    if (!instance) return undefined
    window.__vowledgerGantt = instance
    const focus = focusTaskId(gantt.rows)
    const timer = focus ? setTimeout(() => {
      const record = instance.taskStore.getById(focus)
      if (record) instance.scrollTaskIntoView(record, { animate: 300, edgeOffset: 120 })
    }, 200) : null
    return () => {
      if (timer) clearTimeout(timer)
      if (window.__vowledgerGantt === instance) delete window.__vowledgerGantt
    }
  }, [ganttKey])

  const height = Math.max(300, gantt.rows.length * ROW_HEIGHT + HEADER_AND_FOOTER)
  // The wedding bar is usually off screen to the right: one click brings a bar into view.
  const jump = (id) => {
    const instance = ref.current?.instance
    const record = instance?.taskStore.getById(id)
    if (!record) return
    // Centre the wedding day so there is room to drag it about 50 days to the right without auto-scroll.
    if (id === 'event') instance.scrollToDate(record.startDate, { block: 'center', animate: 300 })
    else instance.scrollTaskIntoView(record, { animate: 300, edgeOffset: 120 })
  }
  const allowDrag = (record) => !readOnly && !busy && (record.id === 'event' || record.extendable)

  return (
    <div className="vl-gantt-wrap">
      <div className="vl-jump">
        <button type="button" className="vl-link" onClick={() => jump('p1')}>Jump to the first payment</button>
        <button type="button" className="vl-link" onClick={() => jump('event')}>Jump to the wedding day</button>
      </div>
      <div className={busy ? 'vl-gantt vl-busy' : 'vl-gantt'} style={{ height }}>
        <BryntumGantt
          key={ganttKey}
          ref={ref}
          project={project}
          columns={columns}
          startDate={parseIso(gantt.projectStart)}
          endDate={parseIso(gantt.timelineEnd)}
          projectLinesFeature={false}
          viewPreset={{ base: 'weekAndMonth', tickWidth: WEEK_PX, headers: HEADERS }}
          rowHeight={ROW_HEIGHT}
          barMargin={9}
          timeResolution={{ unit: 'day', increment: 1 }}
          baselinesFeature={{ renderer: baselineRenderer }}
          labelsFeature={{ right: { field: 'rightLabel' } }}
          indicatorsFeature={{ items: indicatorItems }}
          timeRangesFeature={{ showCurrentTimeLine: false, showHeaderElements: false, enableResizing: false }}
          taskTooltipFeature={{ template: ({ taskRecord }) => esc(taskRecord.tooltip || taskRecord.name) }}
          taskEditFeature={false}
          taskResizeFeature={false}
          percentBarFeature={false}
          cellEditFeature={false}
          dependencyEditFeature={false}
          taskMenuFeature={false}
          rowReorderFeature={false}
          taskDragCreateFeature={false}
          taskCopyPasteFeature={false}
          taskSegmentDragFeature={false}
          cellMenuFeature={false}
          headerMenuFeature={false}
          dependencyMenuFeature={false}
          timeAxisHeaderMenuFeature={false}
          onBeforeTaskDrag={({ taskRecord }) => allowDrag(taskRecord)}
          onTaskDrag={({ taskRecords, startDate }) => { lastDrag.current = { id: taskRecords[0]?.id, startDate } }}
          onBeforeTaskDropFinalize={({ context }) => {
            // A payment bar is tied to the wedding by Backward scheduling, so Bryntum would snap it back.
            // We read where it was dropped, refuse Bryntum's own move, and let the server draw the draft.
            const rec = context.taskRecords[0]
            if (!rec?.extendable || lastDrag.current?.id !== rec.id) return
            context.valid = false
            const drop = lastDrag.current.startDate
            lastDrag.current = null
            if (drop) onExtend?.(rec.id, toIso(drop))
          }}
          onTaskDrop={({ taskRecords }) => {
            const rec = taskRecords[0]
            if (!rec) return
            if (rec.id === 'event') onMoveEvent?.(toIso(rec.startDate))
            else if (rec.extendable) onExtend?.(rec.id, toIso(rec.startDate))
          }}
        />
      </div>
    </div>
  )
}
