import { usd } from '../dates.js'

const DAY = 86400000
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

// Counts for a pending move or extension, read from the card and the Gantt rows the server sent.
export function previewCounts(contract, approval) {
  const edits = approval.lines.filter((l) => l.kind === 'edit').length
  const fees = approval.lines.filter((l) => l.kind === 'create_fee')
  const tasks = contract.gantt.rows.filter((r) => r.kind === 'task' && r.baselines.some((b) => b.name === 'previous')).length
  const from = approval.payload?.previousEventDate
  const to = approval.payload?.eventDate
  return { edits, fees, tasks, pinned: approval.unchanged.length, days: from && to ? dayDiff(from, to) : null }
}

// The strip on top of the Gantt while a change waits for approval.
export function PreviewBanner({ counts, isMove }) {
  const shift = counts.days ? ` (${counts.days > 0 ? '+' : ''}${counts.days} days)` : ''
  return (
    <p className="vl-banner" role="status">
      <i className="fa fa-lock" aria-hidden="true" />
      <span><b>Preview only.</b> {counts.edits} invoice{counts.edits === 1 ? '' : 's'} and {counts.tasks} task{counts.tasks === 1 ? '' : 's'} {isMove ? `follow the wedding${shift}` : 'move with this payment'}.
        {counts.pinned > 0 ? ' Pinned payments stay where they are.' : ''} Grey bars show the old plan. Nothing reaches PayPal until you approve.</span>
    </p>
  )
}

// Four tiles under the Gantt: the size of the change in numbers.
export function ChangeTiles({ counts }) {
  const feeCents = counts.fees.reduce((sum, l) => sum + (l.detail?.amountCents || 0), 0)
  const tiles = [
    { n: counts.edits, text: 'PayPal invoices get new send and due dates', tone: 'pending' },
    { n: counts.fees.length, text: counts.fees.length ? `new invoice: date change fee ${usd(feeCents)}` : 'new invoices', tone: 'accent' },
    { n: counts.tasks, text: 'tasks follow on the Gantt', tone: 'ink' },
    { n: counts.pinned, text: 'pinned: sent or paid, never moves', tone: 'captured' },
  ]
  return (
    <ul className="vl-tiles" aria-label="Size of this change">
      {tiles.map((t) => <li key={t.text} className={`vl-tile vl-tile-${t.tone}`}><b>{t.n}</b><span>{t.text}</span></li>)}
    </ul>
  )
}
