import { dueForPaypal } from '../schedule/engine.js'
import { invoiceBody, withNewDates } from './invoiceBody.js'
import { scheduleOf, logActivity } from './contracts.js'
import { usd } from '../schedule/compute.js'

// Every function here talks to PayPal. They are called only from approved executors (approvals.js) or the read-only refresh.

const cents = (money) => Math.round(Number(money?.value || 0) * 100)

export function applyRemote(step, remoteInvoice) {
  const inv = step.invoice
  inv.status = remoteInvoice.status
  inv.remote = { issueDate: remoteInvoice.detail.invoice_date, dueDate: remoteInvoice.detail.payment_term.due_date, status: remoteInvoice.status }
  inv.paidCents = cents(remoteInvoice.payments?.paid_amount)
}

// Create the draft (idempotent through PayPal-Request-Id), then send. A future issue date means PayPal schedules it.
// Invoice numbers are unique per PayPal business account, and every app and every restart on that account shares
// them, so a number this server picks can already be taken. PayPal answers 422 DUPLICATE_INVOICE_NUMBER; the
// next number is tried (the request id carries the number, so a retry is a new request, not a replay).
const NUMBER_ATTEMPTS = 25

async function createWithFreeNumber(ctx, contract, step, issueDate, dueDate) {
  for (let attempt = 1; ; attempt += 1) {
    const number = ctx.store.nextInvoiceNumber()
    const requestId = `${contract.id}:${step.id}:v${contract.planVersion}:${number}`
    try {
      return { number, created: await ctx.invoicing.createInvoice(invoiceBody({ contract, step, number, issueDate, dueDate }), { requestId }) }
    } catch (err) {
      if (err.issue !== 'DUPLICATE_INVOICE_NUMBER' || attempt >= NUMBER_ATTEMPTS) throw err
    }
  }
}

export async function createAndSend(ctx, contract, step) {
  const today = ctx.today()
  const sstep = scheduleOf(ctx, contract).steps.find((s) => s.id === step.id)
  const issueDate = sstep.issueDate
  const dueDate = dueForPaypal(sstep.dueDate, today)
  if (!step.invoice) {
    const { created, number } = await createWithFreeNumber(ctx, contract, step, issueDate, dueDate)
    step.invoice = { id: created.id, number, status: 'DRAFT', remote: { issueDate, dueDate, status: 'DRAFT' }, contractDueDate: sstep.dueDate, paidCents: 0, syncState: 'pending' }
  }
  await ctx.invoicing.sendInvoice(step.invoice.id)
  applyRemote(step, await ctx.invoicing.getInvoice(step.invoice.id))
  logActivity(contract, {
    actor: 'human',
    text: `${step.invoice.number} ${step.label} ${usd(step.amountCents)}: ${step.invoice.status}, send ${step.invoice.remote.issueDate}, due ${step.invoice.remote.dueDate}`,
    invoiceId: step.invoice.id,
  })
}

// Reschedule a not-yet-sent invoice: read it, change only the two dates, PUT the whole body, send now if the issue date is today.
export async function editDates(ctx, contract, step, want) {
  const inv = step.invoice
  const current = await ctx.invoicing.getInvoice(inv.id)
  if (!['SCHEDULED', 'DRAFT'].includes(current.status)) {
    applyRemote(step, current)
    throw new Error(`${inv.number} is already ${current.status} and cannot be moved`)
  }
  const before = { ...inv.remote }
  inv.contractDueDate = want.contractDueDate
  await ctx.invoicing.updateInvoice(inv.id, withNewDates(current, want.issueDate, want.dueDate))
  if (want.sendNow) await ctx.invoicing.sendInvoice(inv.id)
  applyRemote(step, await ctx.invoicing.getInvoice(inv.id))
  logActivity(contract, {
    actor: 'human',
    text: `${inv.number} send ${before.issueDate} -> ${inv.remote.issueDate}, due ${before.dueDate} -> ${inv.remote.dueDate} (${inv.remote.status})`,
    invoiceId: inv.id,
    before,
    after: { ...inv.remote },
  })
}
