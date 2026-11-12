const ACTOR = { human: 'Lena', agent: 'Agent', paypal: 'PayPal', system: 'System' }

// Who approved what, and what PayPal did, newest first.
export default function ActivityLog({ activity }) {
  return (
    <section id="activity" className="vl-activity" aria-label="Activity">
      <h3>Activity</h3>
      <ol>
        {activity.slice(0, 14).map((a) => (
          <li key={a.id} className={a.ok === false ? 'is-bad' : ''}>
            <time dateTime={a.at}>{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            <strong>{ACTOR[a.actor] || a.actor}</strong> {a.text}
          </li>
        ))}
        {activity.length === 0 && <li className="vl-muted">Nothing yet.</li>}
      </ol>
    </section>
  )
}
