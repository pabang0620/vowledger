import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config, modes } from './config.js'
import { createContext } from './context.js'
import { createApi, errorHandler } from './routes.js'
import { mockPaypal, mockOrders } from './integrations/invoicing.js'
import { mockCheckoutRouter } from './integrations/orders/mockCheckout.js'
import { handleInvoiceEvent, pollContract } from './services/triggers.js'

// npm run demo:sandbox: refuse to start on the mock when the sandbox keys are missing, so nobody demos a mock by accident.
if (process.env.REQUIRE_SANDBOX === '1' && modes.paypal !== 'sandbox') {
  process.stderr.write('demo:sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app) in .env.\n')
  process.exit(1)
}

const ctx = createContext()
const app = express()
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

app.disable('x-powered-by')
app.set('trust proxy', config.trustProxyHops)
app.use(express.json({ limit: '60kb' }))
app.use('/api', createApi(ctx))
// The mock stand-in for PayPal's hosted checkout page exists only when no sandbox keys are set.
if (modes.paypal === 'mock') app.use('/mock-paypal', mockCheckoutRouter(mockOrders))

if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(path.join(distDir, 'index.html'))
  })
}
app.use(errorHandler)

// The mock PayPal delivers its webhooks straight into the same handler the HTTP route uses.
if (modes.paypal === 'mock') {
  mockPaypal.setWebhookSink((event) => handleInvoiceEvent(ctx, event).catch((err) => console.error('webhook failed:', err.message)))
}

// Poll as a second entrance: sandbox webhooks cannot reach localhost, and a due date passing is not a webhook.
setInterval(() => {
  for (const contract of ctx.store.allContracts()) pollContract(ctx, contract).catch((err) => console.error('poll failed:', err.message))
}, config.pollIntervalMs).unref()

app.listen(config.port, () => {
  console.log(`VowLedger on http://localhost:${config.port}`)
  console.log(`Modes: Claude=${modes.llm} PayPal=${modes.paypal}`)
})
