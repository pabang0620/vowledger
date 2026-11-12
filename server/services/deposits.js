import { HttpError } from '../store.js'
import { usd, money2 } from '../schedule/compute.js'
import { OutcomeUnknownError } from '../integrations/orders/errors.js'
import { bumpPlan, logActivity } from './contracts.js'

// The deposit (first milestone) is collected through a PayPal Orders checkout instead of an invoice.
// Both writes follow one order: claim in the store, then the PayPal call, then record the result.
// Callers hold the contract lock. See paypal-plan.md (DUPLICATE CLAIMS, UNKNOWN OUTCOMES).

const createKey = (contract, step) => `deposit-create:${contract.id}:${step.id}`
const captureKey = (orderId) => `deposit-capture:${orderId}`

const withDebug = (err) => (err.debugId ? `${err.message} (PayPal debug id ${err.debugId})` : err.message)

function recordOrder(ctx, contract, step, order, ref) {
  const today = ctx.today()
  step.deposit = {
    orderId: order.id,
    status: order.status || 'CREATED',
    approveUrl: order.approveUrl,
    amountCents: step.amountCents,
    issueDate: today,
    dueDate: today,
    ref,
    captureId: null,
    unknown: false,
    createdAt: new Date().toISOString(),
  }
  step.depositUnknown = false
  logActivity(contract, { actor: 'human', text: `Deposit ${usd(step.amountCents)}: PayPal checkout created (order ${order.id}), the client pays from the link` })
}

// Create the checkout order for the first milestone. Money is not moved here: the payer approves, then capture runs.
export async function createDeposit(ctx, contract, step) {
  // Invariants first, before any claim exists, so a refused value leaves nothing behind.
  if (!contract.depositCheckout || contract.steps[0].id !== step.id) throw new HttpError(409, 'Only the first milestone of a contract is collected by checkout.')
  if (step.deposit) return step.deposit
  const key = createKey(contract, step)
  const attempt = step.depositAttempt || 1
  const ref = `vl-dep-${contract.id}-${step.id}-${attempt}`
  const existing = ctx.store.getClaim(key)
  if (existing && existing.state !== 'unknown') throw new HttpError(409, 'The deposit checkout is already being created.')
  if (!existing && !ctx.store.claim(key, { ref, state: 'claimed' })) throw new HttpError(409, 'The deposit checkout is already being created.')
  const requestId = existing?.ref || ref
  const request = {
    amountCents: step.amountCents,
    referenceId: step.id,
    description: `${step.label} for ${contract.name}`.slice(0, 127),
    customId: requestId,
    brandName: contract.vendor.businessName,
    returnUrl: `${ctx.appBaseUrl}/api/deposit/return`,
    cancelUrl: `${ctx.appBaseUrl}/api/deposit/cancel`,
    requestId,
  }
  try {
    let order
    try {
      order = await ctx.orders.createOrder(request)
    } catch (err) {
      if (!(err instanceof OutcomeUnknownError)) throw err
      // Lost answer: Orders has no search by reference, so settle by replaying the same PayPal-Request-Id.
      ctx.store.setClaim(key, { state: 'unknown' })
      step.depositUnknown = true
      order = await ctx.orders.createOrder(request)
    }
    ctx.store.setClaim(key, { state: 'done' })
    recordOrder(ctx, contract, step, order, requestId)
    return step.deposit
  } catch (err) {
    if (err instanceof OutcomeUnknownError) {
      logActivity(contract, { actor: 'paypal', text: `Deposit checkout: PayPal did not confirm the order yet. Checking again on retry (nothing is reported as failed).`, ok: false })
    } else {
      // PayPal refused it, or it never left: release the claim so a later attempt is not blocked.
      ctx.store.releaseClaim(key)
      step.depositAttempt = attempt + 1
      step.depositUnknown = false
      logActivity(contract, { actor: 'paypal', text: `Deposit checkout failed: ${withDebug(err)}`, ok: false })
    }
    throw err
  }
}

function markCaptured(ctx, contract, step, order) {
  step.deposit = { ...step.deposit, status: 'COMPLETED', captureId: order.captureId, unknown: false }
  bumpPlan(contract)
  logActivity(contract, { actor: 'paypal', text: `Deposit ${usd(step.amountCents)} captured (order ${step.deposit.orderId}, pinned and paid on the Gantt)`, invoiceId: null })
}

// Capture after the payer approved. The order is read first: the amount must equal the schedule's amount.
// Returns { captured, newlyPaid }.
export async function captureDeposit(ctx, contract, step) {
  const deposit = step.deposit
  if (!deposit) throw new HttpError(404, 'No deposit checkout for this contract yet.')
  if (deposit.status === 'COMPLETED') return { captured: true, newlyPaid: false }
  const key = captureKey(deposit.orderId)
  const requestId = `vl-cap-${deposit.orderId}`

  const current = await ctx.orders.getOrder(deposit.orderId)
  if (current.status === 'COMPLETED') {
    markCaptured(ctx, contract, step, current)
    ctx.store.setClaim(key, { state: 'done' })
    return { captured: true, newlyPaid: true }
  }
  if (current.status !== 'APPROVED') {
    step.deposit = { ...deposit, status: current.status }
    throw new HttpError(409, 'The client has not approved the payment on PayPal yet.')
  }
  if (current.amountCents !== step.amountCents) {
    throw new HttpError(409, `PayPal's order is ${usd(current.amountCents)} but the schedule says ${usd(step.amountCents)} (${money2(step.amountCents)}). Nothing was captured.`)
  }

  const existing = ctx.store.getClaim(key)
  if (existing && existing.state !== 'unknown') throw new HttpError(409, 'The deposit is already being captured.')
  if (!existing && !ctx.store.claim(key, { ref: requestId, state: 'claimed' })) throw new HttpError(409, 'The deposit is already being captured.')

  try {
    let order
    try {
      order = await ctx.orders.captureOrder(deposit.orderId, { requestId })
    } catch (err) {
      if (!(err instanceof OutcomeUnknownError)) throw err
      // Lost answer: read the order back. COMPLETED settles it; APPROVED replays the same PayPal-Request-Id.
      ctx.store.setClaim(key, { state: 'unknown' })
      step.deposit = { ...step.deposit, unknown: true }
      const reread = await ctx.orders.getOrder(deposit.orderId)
      order = reread.status === 'COMPLETED' ? reread : await ctx.orders.captureOrder(deposit.orderId, { requestId })
    }
    if (order.status !== 'COMPLETED') throw new HttpError(409, `PayPal answered with order status ${order.status}.`)
    ctx.store.setClaim(key, { state: 'done' })
    markCaptured(ctx, contract, step, order)
    return { captured: true, newlyPaid: true }
  } catch (err) {
    if (err instanceof OutcomeUnknownError) {
      logActivity(contract, { actor: 'paypal', text: 'Deposit capture: PayPal did not confirm yet. Press "Capture now" to check again (nothing is reported as failed).', ok: false })
    } else {
      // Refused or never sent: release so a later attempt is not blocked.
      ctx.store.releaseClaim(key)
      step.deposit = { ...step.deposit, unknown: false }
      logActivity(contract, { actor: 'paypal', text: `Deposit capture failed: ${withDebug(err)}`, ok: false })
    }
    throw err
  }
}

// Read-only refresh used by polling: CREATED -> APPROVED, or a capture that happened elsewhere.
export async function refreshDeposit(ctx, contract, step) {
  const deposit = step.deposit
  if (!deposit || deposit.status === 'COMPLETED') return { newlyPaid: false }
  const current = await ctx.orders.getOrder(deposit.orderId)
  if (current.status === 'COMPLETED') {
    markCaptured(ctx, contract, step, current)
    return { newlyPaid: true }
  }
  if (current.status !== deposit.status) {
    step.deposit = { ...deposit, status: current.status }
    logActivity(contract, { actor: 'paypal', text: `Deposit order ${deposit.status} -> ${current.status}` })
  }
  return { newlyPaid: false }
}
