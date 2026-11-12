import { createLiveOrders } from '../server/integrations/orders/liveOrders.js'

// A fake `fetch` for the SDK (the seam typescript-testing describes). Records every request, answers from a queue
// or a responder. The first request of a fresh client is the OAuth token request.
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
export const token = () => json(200, { access_token: 'T', token_type: 'Bearer', expires_in: 3600 })

export const orderWire = ({ id = 'ORDER12345', status = 'CREATED', cents = 144000, captured = false, approve = true } = {}) => ({
  id,
  status,
  links: [
    { href: `https://api.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
    ...(approve ? [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: 'payer-action', method: 'GET' }] : []),
  ],
  purchase_units: [{
    reference_id: 'p1',
    amount: { currency_code: 'USD', value: (cents / 100).toFixed(2) },
    custom_id: 'vl-ref',
    ...(captured ? { payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: (cents / 100).toFixed(2) } }] } } : {}),
  }],
})

export function fakeSdk(responder) {
  const calls = []
  const fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = request.body === null ? undefined : await request.clone().text()
    const url = new URL(request.url)
    const call = { url, request, body, method: request.method, path: url.pathname }
    calls.push(call)
    return responder(call, calls)
  }
  const orders = createLiveOrders({ clientId: 'id', clientSecret: 'secret', fetch, retry: { maxRetries: 0 } })
  return { orders, calls, onlyOrderCalls: () => calls.filter((c) => c.path.startsWith('/v2/')) }
}

// Answer the token request, then hand the rest to the script in order.
export function script(...steps) {
  const queue = [...steps]
  return (call) => {
    if (call.path === '/v1/oauth2/token') return token()
    const next = queue.shift()
    if (!next) throw new Error(`unscripted request ${call.method} ${call.path}`)
    if (typeof next === 'function') return next(call)
    return next
  }
}
export const dropped = () => { throw new TypeError('socket hang up') }
