// Results of the sandbox and model checks in VERIFY.md, with their ids. Partial and not-run items are named as such.
export default function SandboxEvidence({ evidence }) {
  if (!evidence) return null
  return (
    <details className="vl-demo vl-evidence">
      <summary>Sandbox evidence ({evidence.passed.length} PASS, {evidence.ranOn})</summary>
      <div className="vl-demo-body">
        <ul className="vl-lines">
          {evidence.passed.map((e) => <li key={e.id}><strong>{e.id} PASS</strong> {e.text}</li>)}
          {evidence.partial.map((e) => <li key={e.id} className="vl-muted"><strong>{e.id} partial</strong> {e.text}</li>)}
          {evidence.notRun.map((e) => <li key={e.id} className="vl-muted"><strong>{e.id} not run</strong> {e.text}</li>)}
        </ul>
        <p className="vl-fine vl-muted">Details, calls and fallbacks: VERIFY.md in the repository.</p>
      </div>
    </details>
  )
}
