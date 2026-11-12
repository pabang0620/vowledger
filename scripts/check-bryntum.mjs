// VB check: does the real Bryntum Gantt agree with the server engine?
// Needs the app running in mock mode (FORCE_MOCK=1 npm start) and a Chromium that Playwright can launch.
// Usage: node scripts/check-bryntum.mjs   (BASE_URL, CHROMIUM_PATH optional)
// No fixed sleeps: every step waits for the server answer it caused, then for the Gantt to show the server's plan.
import { chromium } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3002'
const WAIT_MS = 20000

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = join(process.env.HOME || '', '.cache', 'ms-playwright')
  if (!existsSync(root)) return undefined
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell'))) {
    const exe = join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
    if (existsSync(exe)) return exe
  }
  return undefined
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}\n`)
}

const browser = await chromium.launch({ executablePath: findChromium() })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.setDefaultTimeout(WAIT_MS)
page.on('pageerror', (e) => process.stdout.write(`PAGEERROR ${e.message}\n`))

// The Gantt is mounted, has its rows, and Bryntum's engine has finished its pending calculation.
async function ganttReady() {
  await page.waitForFunction(() => window.__vowledgerGantt?.taskStore?.count > 0)
  await page.evaluate(() => window.__vowledgerGantt.project.commitAsync())
}

// Dates of every task as Bryntum holds them right now.
const bryntumDates = () => page.evaluate(() => {
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  return Object.fromEntries(window.__vowledgerGantt.taskStore.records.map((t) => [t.id, iso(t.startDate)]))
})

async function serverView() {
  const sid = await page.evaluate(() => sessionStorage.getItem('vowledger.session'))
  const list = await (await fetch(`${BASE}/api/contracts`, { headers: { 'x-session-id': sid } })).json()
  const id = list.data[list.data.length - 1].id
  return (await (await fetch(`${BASE}/api/contracts/${id}`, { headers: { 'x-session-id': sid } })).json()).data
}

const serverRows = async () => Object.fromEntries((await serverView()).gantt.rows.map((r) => [r.id, r.startDate]))

// Waits until the Gantt shows exactly the server's dates (it may be re-mounted on the way). Returns the last Gantt dates.
async function settled() {
  const until = Date.now() + WAIT_MS
  let shown = null
  let server = null
  while (Date.now() < until) {
    server = await serverRows()
    const match = await page.waitForFunction((want) => {
      const g = window.__vowledgerGantt
      if (!g?.taskStore?.count) return false
      const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
      const got = Object.fromEntries(g.taskStore.records.map((t) => [t.id, iso(t.startDate)]))
      return JSON.stringify(got) === want
    }, JSON.stringify(server), { timeout: 2000 }).then(() => true, () => false)
    await ganttReady()
    shown = await bryntumDates().catch(() => null)
    if (match && JSON.stringify(shown) === JSON.stringify(server)) return { shown, server }
  }
  return { shown, server }
}

const isPost = (part) => (r) => r.url().includes(part) && r.request().method() === 'POST'

async function openSample(name) {
  await page.evaluate(() => sessionStorage.clear()).catch(() => {})
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const created = page.waitForResponse(isPost('/api/contracts'))
  await page.getByRole('button', { name: new RegExp(`Try sample: ${name}`) }).click()
  await created
  const approve = page.getByRole('button', { name: /Approve (3 invoices|checkout and 2 invoices|2 invoices)/ })
  await approve.waitFor({ state: 'visible' })
  const executed = page.waitForResponse(isPost('/execute'))
  await approve.click()
  await executed
  await page.waitForFunction(() => !document.querySelector('button[disabled].vl-btn-primary'))
  return settled()
}

async function drag(days) {
  await ganttReady()
  // The wedding bar sits to the right of the first screen: bring it into view and wait until the scroll has settled.
  await page.evaluate(async () => {
    const g = window.__vowledgerGantt
    await g.scrollTaskIntoView(g.taskStore.getById('event'), { animate: false, edgeOffset: 200 })
  })
  await page.waitForFunction(() => {
    const g = window.__vowledgerGantt
    const el = g.getElementFromTaskRecord(g.taskStore.getById('event'))
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.x > 0 && r.x < window.innerWidth
  })
  const pos = await page.evaluate(() => {
    const g = window.__vowledgerGantt
    const rec = g.taskStore.getById('event')
    const el = g.getElementFromTaskRecord(rec)
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const d = new Date(rec.startDate)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, day: g.getCoordinateFromDate(next) - g.getCoordinateFromDate(d) }
  })
  // Bryntum's own result at the moment of the drop, before the server answers.
  await page.evaluate(() => {
    const g = window.__vowledgerGantt
    window.__preview = null
    g.on('taskDrop', () => {
      const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
      window.__preview = Object.fromEntries(g.taskStore.records.map((t) => [t.id, iso(t.startDate)]))
    })
  })
  const moved = page.waitForResponse(isPost('/move'))
  await page.mouse.move(pos.x, pos.y)
  await page.mouse.down()
  for (let i = 1; i <= 25; i += 1) await page.mouse.move(pos.x + (pos.day * days * i) / 25, pos.y)
  await page.mouse.up()
  await page.waitForFunction(() => window.__preview !== null)
  const preview = await page.evaluate(() => window.__preview)
  const response = await moved
  return { preview, status: response.status() }
}

// Sample B (Ortiz & Lee): load, then drag the wedding 30 days later.
const first = await openSample('Ortiz')
check('VB1 load: Bryntum (Backward) keeps every server date', JSON.stringify(first.shown) === JSON.stringify(first.server), JSON.stringify(first.shown))

const later = await drag(30)
await page.getByRole('button', { name: /Approve \d PayPal change/ }).waitFor({ state: 'visible' })
const afterMove = await serverRows()
check('VB2 drag preview: Bryntum preview == server plan for the dropped date', later.status === 200 && JSON.stringify(later.preview) === JSON.stringify(afterMove), `event ${later.preview?.event}`)
check('VB3 pinned: the sent retainer and its shoot did not move', later.preview?.p1 === first.shown.p1 && later.preview?.t1 === first.shown.t1, `${later.preview?.p1} ${later.preview?.t1}`)

// VB4: moving the wedding earlier than today: the server refuses, the notice shows, and the Gantt returns to the server plan.
const dismissed = page.waitForResponse(isPost('/dismiss'))
await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
await dismissed
const base = await settled()
const early = await drag(-125)
const notice = await page.locator('.vl-notice').first()
await notice.waitFor({ state: 'visible' })
const reset = await settled()
check('VB4 earlier than today: server refuses, Gantt returns to the server plan', early.status === 409 && JSON.stringify(reset.shown) === JSON.stringify(base.server), await notice.innerText())

// VB5: sample A has two pinned payments (sent today). Pulling the wedding 45 days earlier would put the balance before them.
const baseA = await openSample('Kim')
const earlyA = await drag(-45)
const noticeA = page.locator('.vl-notice').first()
await noticeA.waitFor({ state: 'visible' })
const textA = await noticeA.innerText()
const resetA = await settled()
check('VB5 earlier than a pinned payment: server says pinned, Gantt returns to the server plan', earlyA.status === 409 && /pinned/.test(textA) && JSON.stringify(resetA.shown) === JSON.stringify(baseA.server), textA)

// VB6 / VB7 need a proposal and a scheduled invoice: sample B, pay the deposit through the mock checkout.
await openSample('Ortiz')
const href = await page.locator('a:has-text("client checkout link")').getAttribute('href')
await page.goto(href, { waitUntil: 'networkidle' })
await page.click('a.pay')
await page.waitForURL((url) => url.origin === new URL(BASE).origin && url.pathname === '/')
let serverProposal = null
const until = Date.now() + WAIT_MS
while (!serverProposal && Date.now() < until) {
  serverProposal = (await serverView()).gantt.rows.find((r) => r.id === 't1').baselines.find((b) => b.name === 'proposal') || null
  if (!serverProposal) await page.waitForResponse((r) => r.url().includes('/api/contracts/'), { timeout: 6000 }).catch(() => {})
}
await page.waitForFunction(() => document.querySelectorAll('.b-task-baseline.vl-bl-proposal').length > 0)
await ganttReady()
const proposed = await page.evaluate(() => {
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const g = window.__vowledgerGantt
  const bl = g.taskStore.getById('t1').baselines.records.find((b) => b.name === 'proposal')
  return { start: bl && iso(bl.startDate), drawn: document.querySelectorAll('.b-task-baseline.vl-bl-proposal').length }
})
check('VB6 proposal baseline: drawn at the date the server proposed', Boolean(serverProposal) && proposed.start === serverProposal.startDate && proposed.drawn === 1, `${proposed.start} vs ${serverProposal?.startDate}`)

await page.waitForFunction(() => document.querySelectorAll('.b-indicator').length >= 2)
const indicators = await page.evaluate(() => {
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const g = window.__vowledgerGantt
  const day = 86400000
  return ['p2', 'p3'].map((id) => { const r = g.taskStore.getById(id); return { id, issue: r.issueDate && iso(r.issueDate), due: iso(r.startDate), gap: r.issueDate ? Math.round((r.startDate - r.issueDate) / day) : null } })
})
const markers = await page.evaluate(() => document.querySelectorAll('.b-indicator').length)
check('VB7 indicators: issue date = due date - 14 days, and indicators are drawn', indicators.every((i) => i.gap === 14) && markers >= 2, JSON.stringify(indicators))

await browser.close()
const failed = results.filter((r) => !r.ok).length
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`)
process.exit(failed ? 1 : 0)
