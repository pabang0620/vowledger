import { useRef, useState } from 'react'

// "Try a sample" menu in the top bar: the sample contracts and a way to paste or upload contract text.
// (This was the left column; the layout now gives that width to the Gantt.)
export default function SampleMenu({ health, onCreate, busy }) {
  const [pasting, setPasting] = useState(false)
  const [text, setText] = useState('')
  const box = useRef(null)
  const samples = health?.samples || []
  const create = (body) => {
    if (box.current) box.current.open = false
    onCreate(body)
  }
  return (
    <details className="vl-menu" ref={box}>
      <summary>Try a sample</summary>
      <div className="vl-menu-pop">
        <div className="vl-samples">
          {samples.map((s) => (
            <button key={s.key} type="button" className="vl-btn" disabled={busy} onClick={() => create({ sample: s.key })}>
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
            <button type="button" className="vl-btn vl-btn-primary" disabled={busy || text.trim().length < 40} onClick={() => create({ text })}>Read contract</button>
          </div>
        )}
      </div>
    </details>
  )
}
