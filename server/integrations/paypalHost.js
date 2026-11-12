// The one PayPal host this app talks to. The SDK declares a single server and no environment selector,
// so the host is bound here and every client factory checks it. Live money is never reachable from this code.
export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'

export function assertSandbox(baseUrl) {
  if (baseUrl !== SANDBOX_BASE) throw new Error(`Refusing PayPal host ${baseUrl}: only ${SANDBOX_BASE} is allowed.`)
  return baseUrl
}
