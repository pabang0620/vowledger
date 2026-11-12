// Sandbox housekeeping. Lists this sandbox business account's invoices, or cancels / deletes named ones.
// Sandbox only (api-m.sandbox.paypal.com). Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from .env; never prints them.
// Usage: node scripts/sandbox-invoices.mjs list
//        node scripts/sandbox-invoices.mjs get <invoiceId>
//        node scripts/sandbox-invoices.mjs remove <invoiceId> [...]   (cancel; if PayPal refuses for a SCHEDULED one, delete)
import 'dotenv/config'
import { SANDBOX_BASE } from '../server/integrations/paypalHost.js'

const out = (msg) => process.stdout.write(`${msg}\n`)
const [cmd, ...ids] = process.argv.slice(2)

async function token() {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')
  const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!res.ok) throw new Error(`oauth ${res.status}`)
  return (await res.json()).access_token
}

async function call(bearer, method, path, body) {
  const res = await fetch(`${SANDBOX_BASE}${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return { status: res.status, data: text ? JSON.parse(text) : {} }
}

const line = (inv) => [inv.id, inv.detail?.invoice_number, inv.status, `issue ${inv.detail?.invoice_date}`, `due ${inv.detail?.payment_term?.due_date || '-'}`, inv.amount?.value, inv.primary_recipients?.[0]?.billing_info?.name?.full_name || inv.primary_recipients?.[0]?.billing_info?.name?.given_name || '-', inv.detail?.note?.slice(0, 40) || ''].join(' | ')

const bearer = await token()
if (cmd === 'list') {
  for (let page = 1; page <= 5; page += 1) {
    const { data } = await call(bearer, 'GET', `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true&fields=all`)
    for (const inv of data.items || []) out(line(inv))
    if (!data.items || data.items.length < 100) break
  }
} else if (cmd === 'get') {
  for (const id of ids) out(line((await call(bearer, 'GET', `/v2/invoicing/invoices/${id}`)).data))
} else if (cmd === 'remove') {
  for (const id of ids) {
    const cancel = await call(bearer, 'POST', `/v2/invoicing/invoices/${id}/cancel`, { send_to_invoicer: false, send_to_recipient: false, note: 'Created by mistake during a VowLedger test run.' })
    if (cancel.status === 204) {
      out(`${id}: cancelled (204)`)
      continue
    }
    out(`${id}: cancel answered ${cancel.status} ${cancel.data.details?.[0]?.issue || cancel.data.name || ''}`)
    const del = await call(bearer, 'DELETE', `/v2/invoicing/invoices/${id}`)
    out(`${id}: delete answered ${del.status}`)
  }
  for (const id of ids) {
    const after = await call(bearer, 'GET', `/v2/invoicing/invoices/${id}`)
    out(after.status === 200 ? `after: ${line(after.data)}` : `after: ${id} GET ${after.status}`)
  }
} else {
  out('Usage: list | get <id> | remove <id> [...]')
}
