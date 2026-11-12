import { createStore } from './store.js'
import { invoicing, orders } from './integrations/invoicing.js'
import { todayIso } from './dates.js'
import { decide } from './agent/index.js'
import { config } from './config.js'

// Everything the services need, in one object, so tests can swap PayPal, the clock and the agent.
export function createContext(overrides = {}) {
  return {
    store: createStore(),
    invoicing,
    orders,
    depositCheckout: config.depositCheckout,
    appBaseUrl: config.appBaseUrl,
    today: todayIso,
    agent: { decide },
    seenEvents: new Set(),
    ...overrides,
  }
}
