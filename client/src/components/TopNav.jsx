import { usd } from '../dates.js'
import SampleMenu from './Sidebar.jsx'

// Top bar: the contract switcher, section links, the sample menu, and which PayPal and agent modes are live.
export default function TopNav({ health, contracts, contract, busy, onOpen, onCreate }) {
  const mode = health?.modes
  return (
    <header className="vl-nav">
      <h1 className="vl-logo"><img className="brand-logo" src="/logo-512.png" width="32" height="32" alt="VowLedger" />VowLedger</h1>
      {contracts.length > 0 && (
        <label className="vl-switch">
          <span className="vl-sr">Contract</span>
          <select value={contract?.id || ''} disabled={busy} onChange={(e) => onOpen(e.target.value)}>
            {!contract && <option value="">Choose a contract</option>}
            {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}  {usd(c.totalCents)}</option>)}
          </select>
        </label>
      )}
      <nav className="vl-navlinks" aria-label="Sections">
        {contract && <><a href="#schedule">Schedule</a><a href="#contract">Contract</a><a href="#activity">Activity</a></>}
        <SampleMenu health={health} onCreate={onCreate} busy={busy} />
      </nav>
      <span className="vl-grow" />
      <div className="vl-modes" role="status">
        <span className="vl-chip"><span className={`vl-dot ${mode?.paypal === 'sandbox' ? 'is-live' : ''}`} />{mode?.paypal === 'sandbox' ? 'PayPal sandbox connected' : 'Mock PayPal (Invoicing v2 shapes)'}</span>
        {(() => { const llm = mode?.llm === 'mock' && health?.recordings ? `${health.recordings.label} (samples), rule-based for new text` : mode?.llmLabel || 'Rule-based agent'; return <span className="vl-chip" title={llm}>{llm}</span> })()}
      </div>
      <span className="vl-me"><b aria-hidden="true">LP</b>Lena Park Photography</span>
    </header>
  )
}
