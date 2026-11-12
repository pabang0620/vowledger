// Three-step guide for the judge. The server decides which steps are done (summary.stepsDone), so the band
// reads the same truth the tests read: the checkout path and the invoice path tick the same way.
export default function StepBand({ contract }) {
  const done = contract?.summary.stepsDone || {}
  const items = [
    { n: 1, text: 'Approve checkout + invoices', done: Boolean(done.created) },
    { n: 2, text: 'Client pays deposit', done: Boolean(done.paid) },
    { n: 3, text: 'Drag the wedding date', done: Boolean(done.moved) },
  ]
  const current = items.find((i) => !i.done)?.n
  return (
    <ol className="vl-steps" aria-label="Demo steps">
      {items.map((i) => (
        <li key={i.n} className={i.done ? 'is-done' : i.n === current ? 'is-current' : ''}>
          <span className="vl-step-mark">{i.done ? '\u2713' : i.n}</span>
          {i.text}
        </li>
      ))}
    </ol>
  )
}
