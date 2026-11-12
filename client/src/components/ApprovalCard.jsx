import { useState } from 'react'

// One approval card. Nothing reaches PayPal until the button is pressed.
export default function ApprovalCard({ approval, onApprove, onDismiss, busy, hideLines = false }) {
  const [working, setWorking] = useState(false)
  const stale = approval.stale
  const run = async (fn) => {
    setWorking(true)
    try {
      await fn(approval.id)
    } finally {
      setWorking(false)
    }
  }
  return (
    <section className={`vl-card vl-card-${approval.type.toLowerCase()}`} aria-label={approval.title}>
      <header>
        <h3>{approval.title}</h3>
        <span className="vl-version">plan v{approval.planVersion}</span>
      </header>
      {approval.note && <p className="vl-card-note">{approval.note}{approval.noteBy && <span className="vl-muted vl-fine"> ({approval.noteBy})</span>}</p>}
      {!hideLines && (
        <ul className="vl-lines">
          {approval.lines.map((l, i) => (
            <li key={i} className={l.kind === 'create_fee' ? 'is-new' : ''}>{l.text}</li>
          ))}
          {approval.lines.length === 0 && <li className="vl-muted">No PayPal invoice changes.</li>}
        </ul>
      )}
      {approval.unchanged.length > 0 && (
        <p className="vl-unchanged"><strong>Unchanged (pinned):</strong> {approval.unchanged.map((u) => u.text).join('; ')}</p>
      )}
      {stale && <p className="vl-warn">Plan changed, recalculate. Drag the wedding date again or dismiss this card.</p>}
      <div className="vl-actions">
        <button type="button" className="vl-btn vl-btn-primary" disabled={stale || working || busy} onClick={() => run(onApprove)}>{working ? 'Working...' : approval.approveLabel}</button>
        <button type="button" className="vl-btn" disabled={working || busy} onClick={() => run(onDismiss)}>Cancel</button>
      </div>
    </section>
  )
}
