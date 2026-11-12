// Mock PayPal only: stand-ins for the sandbox buyer paying and for a PayPal edit that fails once.
export default function DemoControls({ contract, health, onBuyerPays, onFailNext, onRefresh, onRecord, busy }) {
  const open = contract.steps.filter((s) => s.invoice && ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(s.invoice.status))
  const isMock = health?.modes.paypal === 'mock'
  return (
    <details className="vl-demo">
      <summary>{isMock ? 'Demo controls (mock PayPal)' : 'Payments and polling'}</summary>
      <div className="vl-demo-body">
        <div className="vl-demo-row">
          <span className="vl-label">Record bank transfer</span>
          {open.length === 0 && <span className="vl-muted">No open invoice yet.</span>}
          {open.map((s) => (
            <button key={s.id} type="button" className="vl-btn" disabled={busy} onClick={() => onRecord(s.id)}>{s.invoice.number} {s.label}</button>
          ))}
        </div>
        {isMock && (
          <div className="vl-demo-row">
            <span className="vl-label">Sandbox buyer pays</span>
            {open.length === 0 && <span className="vl-muted">No open invoice yet.</span>}
            {open.map((s) => (
              <button key={s.id} type="button" className="vl-btn" disabled={busy} onClick={() => onBuyerPays(s.id)}>{s.invoice.number}</button>
            ))}
          </div>
        )}
        {isMock && (
          <div className="vl-demo-row">
            <span className="vl-label">Failure test</span>
            <button type="button" className="vl-btn" disabled={busy} onClick={() => onFailNext('update')}>Make the next PayPal edit fail</button>
          </div>
        )}
        <div className="vl-demo-row">
          <span className="vl-label">Check PayPal now</span>
          <button type="button" className="vl-btn" disabled={busy} onClick={onRefresh}>Poll invoices</button>
          {health?.testBuyer && <span className="vl-muted">Sandbox buyer: {health.testBuyer.email} / {health.testBuyer.password}</span>}
        </div>
      </div>
    </details>
  )
}
