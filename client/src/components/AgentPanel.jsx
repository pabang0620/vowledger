import { short } from '../dates.js'
import ApprovalCard from './ApprovalCard.jsx'

const TRIGGER_TEXT = { PAID: 'Payment confirmed', DUE_UNPAID: 'Installment due and unpaid', MOVE: 'Wedding date moved' }

// What the agent decided, in plain words, with the server-computed result drawn on the Gantt as a dotted baseline.
export default function AgentPanel({ contract, onApprove, onDismiss, busy }) {
  const proposals = contract.proposals.slice(0, 3)
  if (!proposals.length) {
    return (
      <section className="vl-agent vl-quiet" aria-label="Agent">
        <h3>Agent</h3>
        <p className="vl-muted">Watching PayPal. When an invoice is paid or an installment falls due, it picks one of the server-computed options here and explains why. It never writes a date: the server does.</p>
      </section>
    )
  }
  return (
    <section className="vl-agent" aria-label="Agent">
      <h3>Agent</h3>
      {proposals.map((p) => {
        const card = contract.approvals.find((a) => a.type === 'APPLY_PROPOSAL' && a.payload?.proposalId === p.id && a.status === 'pending')
        const step = contract.steps.find((s) => s.id === p.trigger.stepId)
        return (
          <article key={p.id} className={`vl-proposal is-${p.stale && p.status === 'pending' ? 'stale' : p.status}`}>
            <p className="vl-proposal-head">
              <strong>{TRIGGER_TEXT[p.trigger.kind]}</strong>
              {step?.invoice && <span> {step.invoice.number}</span>}
              <span className="vl-version">plan v{p.planVersion}</span>
            </p>
            <p className="vl-proposal-pick">Option chosen: <strong>{p.label}</strong></p>
            <p>{p.reason}</p>
            {p.changes?.length > 0 && (
              <ul className="vl-lines vl-changes" aria-label="Dates this option changes">
                {p.changes.map((c) => <li key={c.id}>{c.text}</li>)}
              </ul>
            )}
            {p.status === 'pending' && p.tasks.length > 0 && (
              <p className="vl-muted">Dotted bars on the Gantt show this proposal. The dates come from the server.</p>
            )}
            <p className="vl-tools">tools: {p.toolCalls.join(' > ')} ({p.viaLabel || p.via}{p.recording ? `, ${(p.recording.durationMs / 1000).toFixed(1)} s, replayed on today's data` : ''})</p>
            {p.status === 'pending' && card && (
              <ApprovalCard approval={card} onApprove={onApprove} onDismiss={onDismiss} busy={busy} hideLines />
            )}
            {p.status === 'pending' && !card && <p className="vl-warn">Plan changed, recalculate.</p>}
            {p.status === 'applied' && <p className="vl-ok">Applied.</p>}
            {p.status === 'noted' && <p className="vl-muted">No schedule change needed.</p>}
            {p.status === 'dismissed' && <p className="vl-muted">Dismissed.</p>}
          </article>
        )
      })}
      {proposals.length > 0 && <p className="vl-muted vl-fine">Latest: {short(proposals[0].createdAt.slice(0, 10))}</p>}
    </section>
  )
}
