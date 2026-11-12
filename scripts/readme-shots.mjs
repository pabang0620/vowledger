// Re-captures the two README screenshots from the current app (1440x900), on a mock-mode server.
// Usage: FORCE_MOCK=1 FORCE_MOCK_PAYPAL=1 PORT=3594 npm start, then BASE_URL=http://localhost:3594 node scripts/readme-shots.mjs
// Which image shows which screen: docs/img/README-shots.md. Waits on app state, never on fixed sleeps.
import { chromium } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3002'
const OUT = process.env.OUT || 'docs/img'

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = join(process.env.HOME || '', '.cache', 'ms-playwright')
  for (const dir of existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell')) : []) {
    const exe = join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
    if (existsSync(exe)) return exe
  }
  return undefined
}

const health = await (await fetch(`${BASE}/api/health`)).json()
if (health.data.modes.paypal !== 'mock' || !health.data.recordings) {
  process.stderr.write('Start the server with FORCE_MOCK=1 FORCE_MOCK_PAYPAL=1 so the shots show mock PayPal and the recorded runs.\n')
  process.exit(1)
}

const browser = await chromium.launch({ executablePath: findChromium() })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const isPost = (part) => (r) => r.url().includes(part) && r.request().method() === 'POST'
const idle = () => page.waitForFunction(() => window.__vowledgerGantt?.taskStore?.count > 0 && !document.querySelector('.vl-btn-primary[disabled]'))
const fontsAndGantt = async () => {
  await idle()
  await page.evaluate(async () => { await document.fonts.ready; await window.__vowledgerGantt.project.commitAsync() })
  await page.waitForFunction(() => !document.querySelector('.b-mask'))
}

await page.goto(BASE, { waitUntil: 'networkidle' })
const created = page.waitForResponse(isPost('/api/contracts'))
await page.getByRole('button', { name: /Try sample: Ortiz/ }).first().click()
await created
const executed = page.waitForResponse(isPost('/execute'))
await page.getByRole('button', { name: /Approve checkout and 2 invoices/ }).click()
await executed
await idle()

// 05: the client paid the deposit, the agent proposal with its tool trail and "Not chosen" line.
const href = await page.locator('a:has-text("client checkout link")').getAttribute('href')
await page.goto(href, { waitUntil: 'networkidle' })
await page.click('a.pay')
await page.waitForURL((url) => url.pathname === '/')
await page.locator('.vl-proposal .vl-tools', { hasText: 'Recorded run' }).waitFor()
await page.waitForFunction(() => document.querySelectorAll('.b-task-baseline.vl-bl-proposal').length > 0)
await fontsAndGantt()
await page.locator('.vl-agent').scrollIntoViewIfNeeded()
await page.screenshot({ path: join(OUT, '05_agent_tool_trail_and_proposal_card.png') })

// 08: proposal applied, wedding moved 49 days and approved: the right rail says every invoice is synced.
const applied = page.waitForResponse(isPost('/execute'))
await page.getByRole('button', { name: /Apply proposal/ }).click()
await applied
await idle()
const eventDate = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('vowledger.session')
  const list = await (await fetch('/api/contracts', { headers: { 'x-session-id': sid } })).json()
  return list.data[0].eventDate
})
const moved = new Date(`${eventDate}T12:00:00Z`)
moved.setUTCDate(moved.getUTCDate() + 49)
await page.fill('#move-date', moved.toISOString().slice(0, 10))
const previewed = page.waitForResponse(isPost('/move'))
await page.getByRole('button', { name: 'Preview change' }).click()
await previewed
const synced = page.waitForResponse(isPost('/execute'))
await page.getByRole('button', { name: /Approve 3 PayPal changes/ }).click()
await synced
await page.getByText('0 not synced').first().waitFor()
await fontsAndGantt()
await page.evaluate(() => window.scrollTo(0, 0))
await page.waitForFunction(() => window.scrollY === 0)
// Show the moved wedding day and its "was" baseline: wait until the bar is inside the timeline and the scroll has stopped.
await page.evaluate(async () => {
  const g = window.__vowledgerGantt
  await g.scrollTaskIntoView(g.taskStore.getById('event'), { animate: false, edgeOffset: 160 })
})
await page.waitForFunction(() => {
  const g = window.__vowledgerGantt
  const el = g.getElementFromTaskRecord(g.taskStore.getById('event'))
  const box = g.timeAxisSubGridElement.getBoundingClientRect()
  const r = el?.getBoundingClientRect()
  return Boolean(r) && r.width > 0 && r.left > box.left && r.right < box.right
})
await page.screenshot({ path: join(OUT, '08_after_sync_all_synced.png') })

await browser.close()
process.stdout.write(errors.length ? `page errors:\n${errors.join('\n')}\n` : `saved ${OUT}/05_agent_tool_trail_and_proposal_card.png and ${OUT}/08_after_sync_all_synced.png\n`)
process.exit(errors.length ? 1 : 0)
