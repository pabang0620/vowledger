// VB check: does the real Bryntum Gantt agree with the server engine?
// Needs the app running in mock mode (FORCE_MOCK=1 npm start) and a Chromium that Playwright can launch.
// Usage: node scripts/check-bryntum.mjs   (BASE_URL, CHROMIUM_PATH optional)
import { chromium } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3002'

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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: findChromium() })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))

// Dates of every task as Bryntum holds them right now.
const bryntumDates = () => page.evaluate(() => {
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  return Object.fromEntries(window.__vowledgerGantt.taskStore.records.map((t) => [t.id, iso(t.startDate)]))
})

const serverRows = async () => {
  const sid = await page.evaluate(() => sessionStorage.getItem('vowledger.session'))
  const list = await (await fetch(`${BASE}/api/contracts`, { headers: { 'x-session-id': sid } })).json()
  const view = await (await fetch(`${BASE}/api/contracts/${list.data[0].id}`, { headers: { 'x-session-id': sid } })).json()
  return Object.fromEntries(view.data.gantt.rows.map((r) => [r.id, r.startDate]))
}

async function drag(days) {
  // The wedding bar sits to the right of the first screen: bring it into view and let the scroll settle first.
  await page.evaluate(async () => {
    const g = window.__vowledgerGantt
    await g.scrollTaskIntoView(g.taskStore.getById('event'), { animate: false, edgeOffset: 200 })
  })
  await page.waitForTimeout(400)
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
  await page.evaluate(() => {
    const g = window.__vowledgerGantt
    window.__preview = null
    g.on('taskDrop', () => {
      const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
      window.__preview = Object.fromEntries(g.taskStore.records.map((t) => [t.id, iso(t.startDate)]))
    })
  })
  await page.mouse.move(pos.x, pos.y)
  await page.mouse.down()
  for (let i = 1; i <= 25; i += 1) await page.mouse.move(pos.x + (pos.day * days * i) / 25, pos.y)
  await page.mouse.up()
  await page.waitForTimeout(1800)
  return page.evaluate(() => window.__preview)
}

await page.goto(BASE)
await page.waitForTimeout(800)
await page.getByRole('button', { name: /Try sample: Ortiz/ }).click()
await page.waitForTimeout(1800)
await page.getByRole('button', { name: /Approve (3 invoices|checkout and 2 invoices)/ }).click()
await page.waitForTimeout(2000)

// VB1: loading the server's dates into a Backward project must not make Bryntum recalculate them.
const loaded = await bryntumDates()
const server = await serverRows()
check('VB1 load: Bryntum (Backward) keeps every server date', JSON.stringify(loaded) === JSON.stringify(server), JSON.stringify(loaded))

// VB2: dragging the wedding bar: Bryntum's own preview equals what the server computes for the same date.
const preview = await drag(30)
const movedTo = preview?.event
const sid = await page.evaluate(() => sessionStorage.getItem('vowledger.session'))
const after = await serverRows()
check('VB2 drag preview: Bryntum preview == server plan for the dropped date', preview && JSON.stringify(preview) === JSON.stringify(after), `event ${movedTo}`)
check('VB3 pinned: the sent retainer and its shoot did not move', preview && preview.p1 === loaded.p1 && preview.t1 === loaded.t1, `${preview?.p1} ${preview?.t1}`)

// VB4: moving the wedding earlier than a pinned payment allows: the server refuses and the Gantt snaps back.
await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
await page.waitForTimeout(800)
const base = await serverRows()
await drag(-125)
await page.waitForTimeout(800)
const notice = await page.locator('.vl-notice').allInnerTexts()
const reset = await bryntumDates()
check('VB4 earlier than today: server refuses, Gantt returns to the server plan', notice.length > 0 && JSON.stringify(reset) === JSON.stringify(base), notice[0] || 'no notice')
void sid

// VB5: sample A has two pinned payments (sent today). Pulling the wedding 45 days earlier would put the balance before them.
await page.evaluate(() => sessionStorage.clear())
await page.goto(BASE)
await page.waitForTimeout(800)
await page.getByRole('button', { name: /Try sample: Kim/ }).click()
await page.waitForTimeout(1800)
await page.getByRole('button', { name: /Approve (checkout and 2 invoices|2 invoices|3 invoices)/ }).click()
await page.waitForTimeout(2200)
const baseA = await serverRows()
await drag(-45)
await page.waitForTimeout(800)
const noticeA = await page.locator('.vl-notice').allInnerTexts()
const resetA = await bryntumDates()
check('VB5 earlier than a pinned payment: server says pinned, Gantt returns to the server plan', /pinned/.test(noticeA[0] || '') && JSON.stringify(resetA) === JSON.stringify(baseA), noticeA[0] || 'no notice')

// VB6 / VB7 need a proposal and a scheduled invoice: sample B, pay the deposit through the mock checkout.
await page.evaluate(() => sessionStorage.clear())
await page.goto(BASE)
await page.waitForTimeout(800)
await page.getByRole('button', { name: /Try sample: Ortiz/ }).click()
await page.waitForTimeout(1800)
await page.getByRole('button', { name: /Approve (3 invoices|checkout and 2 invoices)/ }).click()
await page.waitForTimeout(2200)
const href = await page.locator('a:has-text("client checkout link")').getAttribute('href')
await page.goto(href)
await page.click('a.pay')
await page.waitForTimeout(3500)
const proposed = await page.evaluate(() => {
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const g = window.__vowledgerGantt
  const rec = g.taskStore.getById('t1')
  const bl = rec.baselines.records.find((b) => b.name === 'proposal')
  return { start: bl && iso(bl.startDate), drawn: document.querySelectorAll('.b-task-baseline.vl-bl-proposal').length }
})
const tasksNow = await serverRows()
const sidNow = await page.evaluate(() => sessionStorage.getItem('vowledger.session'))
const listNow = await (await fetch(`${BASE}/api/contracts`, { headers: { 'x-session-id': sidNow } })).json()
const viewNow = await (await fetch(`${BASE}/api/contracts/${listNow.data[0].id}`, { headers: { 'x-session-id': sidNow } })).json()
const serverProposal = viewNow.data.gantt.rows.find((r) => r.id === 't1').baselines.find((b) => b.name === 'proposal')
check('VB6 proposal baseline: drawn at the date the server proposed', Boolean(serverProposal) && proposed.start === serverProposal.startDate && proposed.drawn === 1, `${proposed.start} vs ${serverProposal?.startDate}`)

const indicators = await page.evaluate(() => {
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const g = window.__vowledgerGantt
  const day = 86400000
  return ['p2', 'p3'].map((id) => { const r = g.taskStore.getById(id); return { id, issue: r.issueDate && iso(r.issueDate), due: iso(r.startDate), gap: r.issueDate ? Math.round((r.startDate - r.issueDate) / day) : null } })
})
const markers = await page.evaluate(() => document.querySelectorAll('.b-indicator').length)
check('VB7 indicators: issue date = due date - 14 days, and indicators are drawn', indicators.every((i) => i.gap === 14) && markers >= 2, JSON.stringify(indicators))
void tasksNow

await browser.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
