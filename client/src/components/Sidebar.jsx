import { useState } from 'react'
import { usd } from '../dates.js'

const READ_BY = { 'recorded-claude': 'a recorded Claude Sonnet run', 'claude-account': 'Claude Sonnet (local account)', claude: 'Claude (API key)', 'mock-reader': 'the rule-based reader' }

// Left column: contracts, a way to start one (sample or pasted text), and the clauses the agent read.
export default function Sidebar({ health, contracts, contract, onOpen, onCreate, busy }) {
  const [pasting, setPasting] = useState(false)
  const [text, setText] = useState('')
  const samples = health?.samples || []
  return (
    <aside className="vl-side" aria-label="Contracts">
      <h2>Contracts</h2>
      <ul className="vl-contracts">
        {contracts.map((c) => (
          <li key={c.id}>
            <button type="button" className={contract?.id === c.id ? 'is-open' : ''} onClick={() => onOpen(c.id)}>
              <span>{c.name}</span><span>{usd(c.totalCents)}</span>
            </button>
          </li>
        ))}
        {contracts.length === 0 && <li className="vl-muted">No contract yet.</li>}
      </ul>

      <h3>Try a sample contract</h3>
      <div className="vl-samples">
        {samples.map((s) => (
          <button key={s.key} type="button" className="vl-btn" disabled={busy} onClick={() => onCreate({ sample: s.key })}>
            <strong>{s.couple}</strong>
            <small>{s.blurb}</small>
          </button>
        ))}
      </div>

      <button type="button" className="vl-link" onClick={() => setPasting(!pasting)}>{pasting ? 'Hide' : '+ Upload contract text'}</button>
      {pasting && (
        <div className="vl-paste">
          <label htmlFor="contract-text">Paste a contract (text). Use made-up data only.</label>
          <textarea id="contract-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          <input type="file" accept=".txt,text/plain" aria-label="Contract text file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()) }} />
          <button type="button" className="vl-btn vl-btn-primary" disabled={busy || text.trim().length < 40} onClick={() => onCreate({ text })}>Read contract</button>
        </div>
      )}

      {contract && (
        <>
          <h3>Clauses read</h3>
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
        </>
      )}
    </aside>
  )
}
