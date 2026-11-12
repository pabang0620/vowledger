import 'dotenv/config'
import { randomBytes } from 'node:crypto'

const forceMock = process.env.FORCE_MOCK === '1'
// Keeps PayPal on the built-in mock while the model runs for real (FORCE_MOCK would turn both off).
const forceMockPaypal = forceMock || process.env.FORCE_MOCK_PAYPAL === '1'
function positiveInt(raw, fallback, min = 1) {
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= min ? n : fallback
}

const port = Number(process.env.PORT || 3002)

export const config = {
  port,
  anthropicKey: forceMock ? '' : process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  paypalClientId: forceMockPaypal ? '' : process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: forceMockPaypal ? '' : process.env.PAYPAL_CLIENT_SECRET || '',
  paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || '',
  // Only used by the built-in mock PayPal to authenticate its own webhook deliveries.
  mockWebhookSecret: randomBytes(16).toString('hex'),
  // The first milestone is collected by a PayPal Orders checkout. DEPOSIT_CHECKOUT=0 puts it back on an invoice.
  depositCheckout: process.env.DEPOSIT_CHECKOUT !== '0',
  // Where PayPal sends the payer back (the server captures there) and where the mock checkout page lives.
  appBaseUrl: (process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  // Live model protection: runs per client IP per hour and per host per day. Over either, answers come from recordings or the rule-based twin.
  livePerIpHour: positiveInt(process.env.LLM_LIVE_PER_IP_HOUR, 10),
  livePerDay: positiveInt(process.env.LLM_LIVE_PER_DAY, 150),
  // Proxy hops in front of the app (the deployed host sits behind one). 0 trusts no forwarded header.
  trustProxyHops: positiveInt(process.env.TRUST_PROXY_HOPS, 1, 0),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
  testBuyer: process.env.SANDBOX_BUYER_EMAIL ? { email: process.env.SANDBOX_BUYER_EMAIL, password: process.env.SANDBOX_BUYER_PASSWORD || '' } : null,
}

// 'account' runs the model through the developer's Claude Code login (LLM_BACKEND=account), never with an API key.
// 'live' uses ANTHROPIC_API_KEY. FORCE_MOCK=1 beats both so tests never reach a model.
const accountBackend = !forceMock && process.env.LLM_BACKEND === 'account'
const llm = accountBackend ? 'account' : config.anthropicKey ? 'live' : 'mock'

export const modes = {
  llm,
  llmLabel: { account: 'Claude Sonnet (local account)', live: 'Claude (API key)', mock: 'Rule-based agent' }[llm],
  paypal: config.paypalClientId && config.paypalClientSecret ? 'sandbox' : 'mock',
}
