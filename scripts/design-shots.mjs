// Walks the README path in mock mode and saves screenshots (1440x900, plus a 390 px phone pass).
// Usage: BASE_URL=http://localhost:3471 OUT=../final_shots node scripts/design-shots.mjs
import { chromium } from 'playwright-core'
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3002'
const OUT = process.env.OUT || 'final_shots'
mkdirSync(OUT, { recursive: true })

function findChromium() {
  const root = join(process.env.HOME || '', '.cache', 'ms-playwright')
  for (const dir of existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell')) : []) {
    const exe = join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
    if (existsSync(exe)) return exe
  }
  return undefined
}

const browser = await chromium.launch({ executablePath: findChromium() })
const errors = []
async function walk(width, height, prefix) {
  const page = await browser.newPage({ viewport: { width, height } })
  page.on('pageerror', (e) => errors.push(`${prefix} ${e.message}`))
  const shot = async (name, full = false) => { await page.waitForTimeout(700); await page.screenshot({ path: join(OUT, `${prefix}${name}.png`), fullPage: full }) }
  const overflow = async (name) => {
    const w = await page.evaluate(() => document.documentElement.scrollWidth)
    if (w > width + 1) errors.push(`${prefix}${name}: page is ${w}px wide at ${width}px`)
  }
  await page.goto(BASE)
  await page.waitForTimeout(1200)
  await shot('01_first_screen'); await overflow('01')
  await page.getByRole('button', { name: /Try sample: Ortiz/ }).first().click()
  await page.waitForTimeout(1800)
  await shot('02_contract_read_approval'); await overflow('02')
  await page.getByRole('button', { name: /Approve checkout and 2 invoices/ }).click()
  await page.waitForTimeout(2000)
  await shot('03_after_approve_money_rail'); await overflow('03')
  const href = await page.locator('a:has-text("client checkout link")').getAttribute('href')
  await page.goto(href)
  await page.waitForTimeout(600)
  if (prefix === '') await page.screenshot({ path: join(OUT, '04_mock_checkout.png') })
  await page.click('a.pay')
  await page.waitForTimeout(3500)
  await shot('05_deposit_captured_proposal', true)
  await page.getByRole('button', { name: /Apply proposal/ }).click()
  await page.waitForTimeout(2000)
  await shot('06_proposal_applied')
  await page.fill('#move-date', '2027-04-30')
  await page.getByRole('button', { name: 'Preview change' }).click()
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.scrollTo(0, 0))
  await shot('07_move_preview_approval_panel'); await overflow('07')
  if (prefix === '') await shot('07b_move_preview_full', true)
  await page.getByRole('button', { name: /Approve 3 PayPal changes/ }).click()
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.scrollTo(0, 0))
  await shot('08_after_sync_all_synced'); await overflow('08')
  if (prefix === '') await shot('08b_after_sync_full', true)
  if (prefix === '') {
    for (const [couple, name] of [['Kim', '09_sampleA_due_unpaid'], ['Novak', '10_sampleC_clause_mismatch']]) {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.locator('.vl-menu summary').click()
      await page.locator('.vl-menu-pop button', { hasText: couple }).click()
      await page.waitForTimeout(2000)
      const approve = page.getByRole('button', { name: /^Approve (checkout and \d|\d) invoices/ })
      if (await approve.count()) { await approve.first().click(); await page.waitForTimeout(2500) }
      await shot(name)
    }
  }
  await page.close()
}
await walk(1440, 900, '')
await walk(390, 844, 'm_')
await browser.close()
console.log(errors.length ? errors.join('\n') : 'no page errors, no horizontal overflow')
