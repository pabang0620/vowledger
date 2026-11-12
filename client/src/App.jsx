import { useCallback, useEffect, useRef, useState } from 'react'
import { api, startSession } from './api.js'
import { long, short, usd } from './dates.js'
import GanttView from './components/GanttView.jsx'
import StepBand from './components/StepBand.jsx'
import TopNav from './components/TopNav.jsx'
import MoneyRail from './components/MoneyRail.jsx'
import ApprovalPanel from './components/ApprovalPanel.jsx'
import { previewCounts, PreviewBanner, ChangeTiles } from './components/PreviewSummary.jsx'
import AgentPanel from './components/AgentPanel.jsx'
import ActivityLog from './components/ActivityLog.jsx'
import DemoControls from './components/DemoControls.jsx'
import DepositPanel from './components/DepositPanel.jsx'
import SandboxEvidence from './components/SandboxEvidence.jsx'
import { TotalsError, SyncError } from './components/ErrorPanels.jsx'

const POLL_MS = 4000
const fullDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

export default function App() {
  const [health, setHealth] = useState(null)
  const [contracts, setContracts] = useState([])
  const [contract, setContract] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [totalsError, setTotalsError] = useState(null)
  const [resetNonce, setResetNonce] = useState(0)
  const [moveDate, setMoveDate] = useState('')
  const [preview, setPreview] = useState(null)
  const contractId = useRef(null)

  const adopt = useCallback((view) => {
    contractId.current = view.id
    setContract(view)
    setContracts((list) => (list.some((c) => c.id === view.id) ? list.map((c) => (c.id === view.id ? { ...c, name: view.name, totalCents: view.totalCents, eventDate: view.eventDate } : c)) : [...list, { id: view.id, name: view.name, totalCents: view.totalCents, eventDate: view.eventDate }]))
  }, [])

  // One wrapper for every server action: busy flag, error notice, and a Gantt reset when the server said no.
  const act = useCallback(async (fn, doneNotice = '') => {
    setBusy(true)
    setNotice('')
    try {
      adopt(await fn())
      if (doneNotice) setNotice(doneNotice)
    } catch (err) {
      setNotice(err.message)
      setResetNonce((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }, [adopt])

  // PayPal sends the payer back to /?deposit=captured|checking|error|cancelled after the server tried to capture.
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('deposit')
    if (!result) return
    const words = { captured: 'The deposit was paid and captured.', checking: 'PayPal has not confirmed the deposit yet. It is being checked.', error: 'The deposit was not captured. See the activity log.', cancelled: 'The client left the PayPal checkout. The link still works.' }
    setNotice(words[result] || '')
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  useEffect(() => {
    startSession()
      .then(async () => {
        const [h, list] = await Promise.all([api.health(), api.contracts()])
        setHealth(h)
        setContracts(list)
        if (list[0]) adopt(await api.contract(list[0].id))
        else api.preview('B').then(setPreview).catch(() => {})
      })
      .catch((err) => setNotice(err.message))
  }, [adopt])

  // Webhooks and due dates change the plan without a click: look again every few seconds.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!contractId.current || document.hidden) return
      api.contract(contractId.current).then(adopt).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [adopt])

  const create = async (body) => {
    setBusy(true)
    setNotice('')
    setTotalsError(null)
    try {
      adopt(await api.createContract(body))
    } catch (err) {
      if (err.status === 422 && err.data?.clauses) setTotalsError({ message: err.message, data: err.data })
      else setNotice(err.message)
    } finally {
      setBusy(false)
    }
  }

  const recheck = (edits) => create({ ...(totalsError.data.sample ? { sample: totalsError.data.sample } : { text: totalsError.data.text }), edits })

  const id = contract?.id
  const pendingCards = contract ? contract.approvals.filter((a) => a.status === 'pending' && a.type !== 'APPLY_PROPOSAL') : []
  const syncJob = contract?.jobs.find((j) => j.status === 'partial')
  const change = pendingCards.find((a) => ['MOVE_EVENT', 'EXTEND_DUE'].includes(a.type) && !a.stale)
  const counts = change ? previewCounts(contract, change) : null
  const daysAway = contract ? Math.round((Date.parse(contract.eventDate) - Date.parse(contract.today)) / 86400000) : 0
  const moveTo = change?.type === 'MOVE_EVENT' ? change.payload?.eventDate : null
  const openContract = (cid) => { setTotalsError(null); act(() => api.contract(cid)) }

  return (
    <div className="vl-app">
      <TopNav health={health} contracts={contracts} contract={totalsError ? null : contract} busy={busy} onOpen={openContract} onCreate={create} />
      <div className="vl-page">
        <section className="vl-head" aria-label="Contract summary">
          <div>
            {contract && !totalsError ? (
              <>
                <h2>{contract.name} Wedding</h2>
                {moveTo
                  ? <p>Wedding <s>{short(contract.eventDate)}</s> &rarr; <strong>{fullDate(moveTo)}</strong> · preview, not sent</p>
                  : <p>Event <strong>{fullDate(contract.eventDate)}</strong> · {daysAway} days away · {usd(contract.totalCents)} · plan v{contract.planVersion}</p>}
              </>
            ) : <h2>Wedding payment schedules</h2>}
          </div>
          <StepBand contract={totalsError ? null : contract} />
        </section>
        {notice && <p className="vl-notice" role="alert">{notice}</p>}

        {totalsError && <TotalsError error={totalsError} onRecheck={recheck} onDismiss={() => setTotalsError(null)} />}
        {!contract && !totalsError && (
          <div className="vl-empty">
            <h2>Drag the wedding date. The couple's real PayPal invoices move with it.</h2>
            <p>Start with a sample contract. The agent reads the payment clauses, the server counts every date back from the wedding day, and a Bryntum Gantt shows the plan.</p>
            <div className="vl-actions">
              {(health?.samples || []).filter((s) => s.key !== 'C').map((s) => (
                <button key={s.key} type="button" className="vl-btn vl-btn-primary" disabled={busy} onClick={() => create({ sample: s.key })}>Try sample: {s.couple}</button>
              ))}
            </div>
            {preview && (
              <div className="vl-preview">
                <p className="vl-muted vl-fine">Preview: the plan for {preview.name} ({usd(preview.totalCents)}, wedding {long(preview.eventDate)}). Read-only, computed by the server. Nothing is sent to PayPal.</p>
                <GanttView gantt={preview.gantt} busy={false} readOnly />
              </div>
            )}
            <SandboxEvidence evidence={health?.evidence} />
          </div>
        )}
        {contract && !totalsError && (
          <div className="vl-grid">
            <section id="schedule" className="vl-panel vl-ganttbox" aria-label="Schedule">
              <GanttView key={resetNonce} gantt={contract.gantt} busy={busy}
                onMoveEvent={(date) => act(() => api.move(id, date))} onExtend={(stepId, date) => act(() => api.extend(id, stepId, date))}
                banner={counts && <PreviewBanner counts={counts} isMove={change.type === 'MOVE_EVENT'} />}
                toolbar={(
                  <form className="vl-move" onSubmit={(e) => { e.preventDefault(); if (moveDate) act(() => api.move(id, moveDate)) }}>
                    <label htmlFor="move-date">Or type a new wedding date</label>
                    <input id="move-date" type="date" value={moveDate} onChange={(e) => setMoveDate(e.target.value)} />
                    <button type="submit" className="vl-btn" disabled={busy || !moveDate}>Preview change</button>
                  </form>
                )} />
              <p className="vl-legend">
                <span className="vl-leg"><span className="vl-key vl-key-prev" /> previous plan</span>
                <span className="vl-leg"><span className="vl-key vl-key-prop" /> agent proposal</span>
                <span className="vl-leg"><i className="fa fa-thumbtack vl-ico vl-ico-pin" /> pinned payment: sent or paid, never moved</span>
                <span className="vl-leg"><i className="fa fa-link vl-ico vl-ico-chain" /> follows a pinned payment</span>
                <span className="vl-leg"><i className="fa fa-paper-plane vl-ico vl-ico-issue" /> PayPal sends (due date minus 14 days)</span>
                <span className="vl-leg"><span className="vl-key vl-key-sched" /> scheduled at PayPal</span>
              </p>
            </section>

            <div className="vl-side">
              {pendingCards.length > 0
                ? pendingCards.map((a) => (
                  <ApprovalPanel key={a.id} approval={a} contract={contract} busy={busy} onApprove={(aid) => act(() => api.execute(id, aid))} onDismiss={(aid) => act(() => api.dismiss(id, aid))} />
                ))
                : <MoneyRail contract={contract} />}
            </div>

            <div className="vl-rest">
              {counts && <ChangeTiles counts={counts} />}
              <DepositPanel contract={contract} busy={busy} onCapture={() => act(() => api.captureDeposit(id))} />
              {syncJob && <SyncError contract={contract} job={syncJob} busy={busy} onRetry={(jid) => act(() => api.retry(id, jid))} onRevert={(date) => act(() => api.move(id, date))} />}
              <AgentPanel contract={contract} busy={busy} onApprove={(aid) => act(() => api.execute(id, aid))} onDismiss={(aid) => act(() => api.dismiss(id, aid))} />
              <ActivityLog activity={contract.activity} />
              {pendingCards.length > 0 && <MoneyRail contract={contract} />}
              <DemoControls contract={contract} health={health} busy={busy}
                onRecord={(stepId) => act(() => api.recordPayment(id, { stepId }))}
                onBuyerPays={(stepId) => act(() => api.buyerPays(id, stepId))}
                onFailNext={(op) => act(async () => { await api.failNext(op); return api.contract(id) }, 'Armed (mock only): the next PayPal edit fails once. Move the wedding date and approve to see the partial failure.')}
                onRefresh={() => act(() => api.refresh(id))} />
              <SandboxEvidence evidence={health?.evidence} />
            </div>
          </div>
        )}
      </div>
      <footer className="vl-foot">Gantt: Bryntum trial build, watermark kept. Drag preview runs on Bryntum's engine; the confirmed dates come from the server engine, because webhooks run without a browser.</footer>
    </div>
  )
}
