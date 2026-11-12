import { modes, config } from '../config.js'
import { createMockPaypal } from './mockPaypal.js'
import { livePaypal } from './livePaypal.js'
import { todayIso } from '../dates.js'
import { createMockOrders } from './orders/mockOrders.js'
import { getLiveOrders } from './orders/liveOrders.js'

export const mockPaypal = createMockPaypal({ today: todayIso })

// One interface, two backends. Mock runs when no sandbox keys are set.
export const invoicing = modes.paypal === 'sandbox' ? livePaypal : mockPaypal

export const mockOrders = createMockOrders()

// Orders v2 (the deposit checkout) goes through the APIMatic SDK in sandbox mode.
export const orders = modes.paypal === 'sandbox' ? getLiveOrders() : mockOrders

export async function verifyWebhook(headers, event) {
  if (modes.paypal === 'sandbox') return livePaypal.verifyWebhook(headers, event)
  return headers['x-mock-webhook-secret'] === config.mockWebhookSecret
}
