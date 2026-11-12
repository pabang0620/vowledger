import { useState } from 'react'
import { short, usd } from '../dates.js'
import { paypalCalls } from '../paypalCalls.js'
import { moneyState } from './MoneyRail.jsx'

const VENDOR = 'Lena Park Photography'

// One before/after row: "Send Dec 28 -> Feb 15". A date that does not change is shown once.
function DateRow({ label, from, to, now }) {
  if (now) return <p className="vl-diff-row"><span>{label}</span><span><em>now</em></span></p>
  if (!to) return null
  return (
    <p className="vl-diff-row">
      <span>{label}</span>
      <span>{from && from !== to && <><s>{short(from)}</s><span className="vl-arr" aria-label="to"> &rarr; </span></>}<em>{short(to)}</em></span>
    </p>
  )
}

function ChangeLine({ line }) {
  const d = line.detail
  if (!d) return <li className={`vl-diff vl-diff-text ${line.kind === 'create_fee' ? 'is-new' : ''}`}>{line.text}</li>
  if (line.kind === 'create_fee') {
    return (
      <li className="vl-diff vl-diff-fee">
        <p className="vl-diff-head"><span>New · {d.label}</span><strong>{usd(d.amountCents)}</strong></p>
        <p className="vl-diff-row"><span>Send</span><span><em>now</em>, due the day the new date is confirmed</span></p>
      </li>
    )
  }
  return (
    <li className="vl-diff" title={line.text}>
      <p className="vl-diff-head"><span>{d.invoiceNumber} · {d.label}</span><strong>{usd(d.amountCents)}</strong></p>
      <DateRow label="Send" from={d.from?.issueDate} to={d.to?.issueDate} now={d.sendNow} />
      <DateRow label="Due" from={d.from?.dueDate} to={d.to?.dueDate} />
    </li>
  )
}

// The right rail turns into this panel while a card waits: what changes, what stays pinned, who approves,
// and the PayPal calls that run on approval. Nothing reaches PayPal until the button is pressed.
export default function ApprovalPanel({ approval, contract, onApprove, onDismiss, busy }) {
  const [working, setWorking] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const stale = approval.stale
  const run = async (fn) => {
    setWorking(true)
    try {
      await fn(approval.id)
    } finally {
      setWorking(false)
    }
  }
  const feeCents = approval.lines.filter((l) => l.kind === 'create_fee').reduce((sum, l) => sum + (l.detail?.amountCents || 0), 0)
  const calls = paypalCalls(approval, contract.steps)
  return (
    <section className={`vl-card vl-approve vl-card-${approval.type.toLowerCase()}`} aria-label={approval.title}>
      <div className="vl-approve-in">
        <header>
          <h2>{approval.title}</h2>
          <span className="vl-version">plan v{approval.planVersion}</span>
        </header>
        {approval.note && <p className={`vl-lead ${showNote ? 'is-open' : ''}`} title={approval.note}>{approval.note}{approval.noteBy && <span className="vl-fine"> ({approval.noteBy})</span>}</p>}
        {showNote && approval.notChosen?.length > 0 && (
          <ul className="vl-lines vl-fine" aria-label="Options the agent did not choose">
            {approval.notChosen.map((n) => <li key={n.optionId}>Not chosen: <strong>{n.label}</strong>. {n.why}</li>)}
          </ul>
        )}
        {(approval.note?.length > 220 || approval.notChosen?.length > 0) && <button type="button" className="vl-link vl-more" onClick={() => setShowNote(!showNote)}>{showNote ? 'Show less' : 'Why the agent chose this'}</button>}
        <ul className="vl-diffs" aria-label="PayPal changes">
          {approval.lines.map((l, i) => <ChangeLine key={i} line={l} />)}
          {approval.lines.length === 0 && <li className="vl-muted">No PayPal invoice changes.</li>}
        </ul>
        {approval.unchanged.length > 0 && (
          <div className="vl-diff vl-diff-pin vl-unchanged">
            <p className="vl-diff-head"><span><i className="fa fa-thumbtack vl-ico vl-ico-pin" />Unchanged (pinned)</span></p>
            {approval.unchanged.map((u) => (
              <p key={u.stepId} className="vl-diff-row vl-diff-pinrow">
                {u.detail
                  ? <><span>{u.detail.invoiceNumber} {u.detail.label} <span className={`vl-pill vl-st-${moneyState(u.detail.status)}`}>{String(u.detail.status).replace(/_/g, ' ')}</span></span><strong>{usd(u.detail.amountCents)}</strong></>
                  : <span>{u.text}</span>}
              </p>
            ))}
          </div>
        )}
        {stale && <p className="vl-warn">Plan changed, recalculate. Drag the wedding date again or dismiss this card.</p>}
        <p className="vl-who"><i className="fa fa-user-check" aria-hidden="true" /><span>Approver: <strong>{VENDOR}</strong>, on plan v{approval.planVersion}. Nothing reaches PayPal until you approve.</span></p>
        {calls.length > 0 && (
          <ul className="vl-calls" aria-label="PayPal calls on approval">
            {calls.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        )}
      </div>
      <footer className="vl-approve-foot">
        <p className="vl-tot"><span>Paid <b>{usd(contract.summary.paidCents)}</b></span>{!['MOVE_EVENT', 'EXTEND_DUE'].includes(approval.type)
          ? <span>Contract total <b>{usd(contract.totalCents)}</b></span>
          : <span>Scheduled after <b>{usd(contract.summary.scheduledCents + feeCents)}</b></span>}</p>
        <div className="vl-btns">
          <button type="button" className="vl-btn vl-btn-primary vl-btn-go" disabled={stale || working || busy} onClick={() => run(onApprove)}>
            <span className="vl-pp" aria-hidden="true">P</span>{working ? 'Working...' : approval.approveLabel}
          </button>
          <button type="button" className="vl-btn vl-btn-cancel" disabled={working || busy} onClick={() => run(onDismiss)}>Cancel</button>
        </div>
      </footer>
    </section>
  )
}
