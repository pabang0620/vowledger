import { usd } from '../dates.js'

// The deposit (first milestone) is paid through a PayPal checkout link, not an invoice.
// The client opens the link; when PayPal returns them the server captures. "Capture now" is the recovery button.
export default function DepositPanel({ contract, busy, onCapture }) {
  const step = contract.steps.find((s) => s.via === 'order')
  if (!step?.deposit) return null
  const d = step.deposit
  return (
    <section className="vl-card vl-deposit" aria-label="Deposit checkout">
      <div>
        <h3>Deposit {usd(step.amountCents)}: PayPal checkout</h3>
        <p className="vl-muted">
          Status <span className={`vl-pill vl-p-status vl-p-${d.status.toLowerCase()}`}>{d.status.replace('_', ' ')}</span>
          {d.status === 'CAPTURED' && ' The deposit is paid, pinned on the Gantt, and never moves.'}
        </p>
      </div>
      {d.approveUrl && <a className="vl-btn vl-btn-primary" href={d.approveUrl} target="_blank" rel="noreferrer">Open the client checkout link</a>}
      {d.canCapture && <button type="button" className="vl-btn" disabled={busy} onClick={onCapture}>Capture now</button>}
    </section>
  )
}
