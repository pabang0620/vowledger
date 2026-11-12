import { PaypalClient, CheckoutPaymentIntent, OrderApplicationContextShippingPreference, OrderApplicationContextUserAction } from 'paypal'
import { config } from '../../config.js'
import { money2 } from '../../schedule/compute.js'
import { SANDBOX_BASE, assertSandbox } from '../paypalHost.js'
import { translateSdkError } from './errorMap.js'
import { normalizeOrder, requireOrderFields } from './normalize.js'

// Orders v2 through the APIMatic-generated `paypal` SDK. Every field below is listed in paypal-plan.md.
// Writes are sent once (no SDK retry); the unknown-outcome handling lives in services/deposits.js.

const WRITE = { retry: { maxRetries: 0 } }

export function createLiveOrders({ clientId, clientSecret, fetch, baseUrl = SANDBOX_BASE, retry } = {}) {
  assertSandbox(baseUrl)
  const client = new PaypalClient({
    oauth2: { clientId, clientSecret },
    serverOptions: { baseUrl },
    logging: { level: 'off' },
    ...(fetch ? { fetch } : {}),
    ...(retry ? { retry } : {}),
  })

  return {
    async createOrder({ amountCents, currency = 'USD', referenceId, description, customId, brandName, returnUrl, cancelUrl, requestId }) {
      const opts = { write: true, what: 'deposit order creation' }
      try {
        const order = await client.orders.createOrder({
          payPalRequestId: requestId,
          body: {
            intent: CheckoutPaymentIntent.Capture,
            purchaseUnits: [{ referenceId, amount: { currencyCode: currency, value: money2(amountCents) }, description, customId }],
            applicationContext: { brandName, returnUrl, cancelUrl, shippingPreference: OrderApplicationContextShippingPreference.NoShipping, userAction: OrderApplicationContextUserAction.PayNow },
          },
        }, WRITE)
        return normalizeOrder(requireOrderFields(order, ['id'], opts))
      } catch (err) {
        throw translateSdkError(err, opts)
      }
    },

    async getOrder(id) {
      const opts = { write: false, what: 'order read' }
      try {
        return normalizeOrder(requireOrderFields(await client.orders.getOrder({ id }), ['id', 'status'], opts))
      } catch (err) {
        throw translateSdkError(err, opts)
      }
    },

    async captureOrder(id, { requestId }) {
      const opts = { write: true, what: 'deposit capture' }
      try {
        return normalizeOrder(requireOrderFields(await client.orders.captureOrder({ id, payPalRequestId: requestId, body: {} }, WRITE), ['status'], opts))
      } catch (err) {
        throw translateSdkError(err, opts)
      }
    },
  }
}

let held = null

// Built once: the OAuth token cache lives on the client.
export function getLiveOrders() {
  if (!held) held = createLiveOrders({ clientId: config.paypalClientId, clientSecret: config.paypalClientSecret })
  return held
}
