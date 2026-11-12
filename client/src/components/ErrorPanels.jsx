import { useState } from 'react'
import { short, usd } from '../dates.js'

// Error screen 1: the clauses do not add up to the contract total. Nothing is invoiced until it does.
export function TotalsError({ error, onRecheck, onDismiss }) {
  const clauses = error.data?.clauses || []
  const [percents, setPercents] = useState(clauses.map((c) => c.percent))
  return (
    <section className="vl-error" role="alert">
      <h3>Contract check failed</h3>
      <p>{error.message}</p>
      <ul className="vl-clause-edit">
        {clauses.map((c, i) => (
          <li key={i}>
            <label>
              <span>{c.label}</span>
              <input type="number" min="1" max="100" value={percents[i]} onChange={(e) => setPercents(percents.map((p, j) => (j === i ? Number(e.target.value) : p)))} aria-label={`${c.label} percent`} />%
            </label>
            <q>{c.quote}</q>
          </li>
        ))}
      </ul>
      <div className="vl-actions">
        <button type="button" className="vl-btn vl-btn-primary" onClick={() => onRecheck(percents.map((percent, index) => ({ index, percent })))}>Check again</button>
        <button type="button" className="vl-btn" onClick={onDismiss}>Upload again</button>
        <button type="button" className="vl-btn" disabled>Create invoices</button>
      </div>
    </section>
  )
}

// Error screen 2: PayPal rejected some changes after approval. The plan moved, PayPal did not, and the screen says so.
export function SyncError({ contract, job, onRetry, onRevert, busy }) {
  const done = job.items.filter((i) => i.status === 'done').length
  const failed = job.items.filter((i) => i.status === 'failed')
  if (!failed.length) return null
  const move = contract.approvals.find((a) => a.id === job.approvalId)
  return (
    <section className="vl-error" role="alert">
      <h3>{done} of {job.items.length} changes applied</h3>
      {failed.map((item) => {
        const step = contract.steps.find((s) => s.id === item.stepId)
        return (
          <p key={item.stepId}>
            {step?.invoice?.number || item.label} failed. {item.error}
            {step?.invoice && <> The Gantt shows the new plan; PayPal still has send {short(step.invoice.remote.issueDate)}, due {short(step.invoice.remote.dueDate)} ({usd(step.amountCents)}).</>}
          </p>
        )
      })}
      <div className="vl-actions">
        {failed.map((item) => {
          const step = contract.steps.find((s) => s.id === item.stepId)
          return <button key={item.stepId} type="button" className="vl-btn vl-btn-primary" disabled={busy} onClick={() => onRetry(job.id)}>Retry {step?.invoice?.number || item.label}</button>
        })}
        {move?.payload?.previousEventDate && <button type="button" className="vl-btn" disabled={busy} onClick={() => onRevert(move.payload.previousEventDate)}>Revert plan</button>}
      </div>
    </section>
  )
}
