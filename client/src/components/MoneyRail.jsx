import { short, usd } from '../dates.js'

const READ_BY = { 'recorded-claude': 'a recorded Claude Sonnet run', 'claude-account': 'Claude Sonnet (local account)', claude: 'Claude (API key)', 'mock-reader': 'the rule-based reader' }

// Money-state colour for a PayPal status: scheduled (blue), waiting on the client (amber), money in (green), failed (red).
export function moneyState(status, syncState) {
  if (syncState === 'not_synced') return 'failed'
  if (['PAID', 'MARKED_AS_PAID', 'CAPTURED', 'COMPLETED'].includes(status)) return 'captured'
  if (['SENT', 'UNPAID', 'PARTIALLY_PAID', 'APPROVED', 'CHECKING'].includes(status)) return 'held'
  if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(status)) return 'refunded'
  if (['CANCELLED', 'FAILED', 'ERROR', 'VOIDED'].includes(status)) return 'failed'
  return 'pending'
}

function PaymentRow({ step }) {
  const inv = step.invoice
  const d = step.deposit
  const status = inv ? inv.status : d ? d.status : 'NOT INVOICED'
  const sub = inv
    ? `${inv.number} · ${inv.status === 'SCHEDULED' ? `PayPal sends ${short(inv.remote.issueDate)} · ` : ''}due ${short(inv.remote.dueDate)}`
    : d ? 'Deposit, PayPal checkout' : 'not invoiced yet'
  return (
    <li className="vl-pay">
      <strong>{step.label}{step.percent ? ` ${step.percent}%` : ''}</strong>
      <span className="vl-amt">{usd(step.amountCents)}</span>
      <small>{sub}</small>
      <span className={`vl-pill vl-st-${moneyState(status, inv?.syncState)}`}>{status.replace(/_/g, ' ')}</span>
    </li>
  )
}

// The right rail when nothing waits for approval: the total, what is paid and scheduled, each payment,
// the next thing PayPal will do, and the clauses the reader quoted.
export default function MoneyRail({ contract }) {
  const { paidCents, scheduledCents, notSynced } = contract.summary
  const total = contract.totalCents || 1
  const payments = contract.steps.filter((s) => s.kind === 'installment' || s.kind === 'fee')
  const next = payments
    .filter((s) => s.invoice?.status === 'SCHEDULED')
    .sort((a, b) => a.invoice.remote.issueDate.localeCompare(b.invoice.remote.issueDate))[0]
  return (
    <aside className="vl-rail vl-money" aria-label="Money">
      <h2 className="vl-kicker">Money</h2>
      <p className="vl-big">{usd(contract.totalCents)}<small>contract total</small></p>
      <div className="vl-meter" role="img" aria-label={`Paid ${usd(paidCents)}, scheduled ${usd(scheduledCents)} of ${usd(contract.totalCents)}`}>
        <i className="vl-meter-paid" style={{ width: `${Math.min(100, (paidCents / total) * 100)}%` }} />
        <i className="vl-meter-sched" style={{ width: `${Math.min(100, (scheduledCents / total) * 100)}%` }} />
      </div>
      <p className="vl-meterkey vl-sums">
        <span>Paid <b>{usd(paidCents)}</b></span>
        <span>Scheduled <b>{usd(scheduledCents)}</b></span>
        <span className={notSynced ? 'vl-bad' : ''}>{notSynced} not synced</span>
      </p>
      <ul className="vl-pays" aria-label="Payments">
        {payments.map((s) => <PaymentRow key={s.id} step={s} />)}
      </ul>
      {next && (
        <div className="vl-next">
          <i className="fa fa-paper-plane" aria-hidden="true" />
          <p><b>Next at PayPal: {next.invoice.number} goes out {short(next.invoice.remote.issueDate)}</b>
            Scheduled at PayPal, {contract.leadDays || 14} days before it is due. Move the wedding and it follows.</p>
        </div>
      )}
      <section id="contract" className="vl-clauses-box" aria-label="Clauses read">
        <h3 className="vl-kicker">Clauses read</h3>
        <ol className="vl-clauses">
          {contract.clauses.map((c) => (
            <li key={c.id}>
              <strong>{c.label}: {c.percent}% = {usd(c.amountCents)}</strong>
              <q>{c.quote}</q>
            </li>
          ))}
          {contract.dateChangeFee && (
            <li><strong>Date change fee: {usd(contract.dateChangeFee.cents)}</strong><q>{contract.dateChangeFee.quote}</q></li>
          )}
        </ol>
        <p className="vl-fine vl-muted">Read by {contract.readByLabel || READ_BY[contract.readBy] || 'the rule-based reader'}. The reader quotes the contract. Amounts are computed by code from the total, never by the model.</p>
      </section>
    </aside>
  )
}
