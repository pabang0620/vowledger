import { Router } from 'express'
import { z } from 'zod'
import { config, modes } from './config.js'
import { HttpError } from './store.js'
import { verifyWebhook } from './integrations/invoicing.js'
import { readContract } from './contracts/extract.js'
import { SAMPLES, sampleFor, sampleContractText } from './contracts/samples.js'
import { ContractError } from './schedule/compute.js'
import { createContract, publicContract } from './services/contracts.js'
import { requestInvoices, requestRecordPayment, executeApproval, dismissApproval, retryJob, captureDepositFor } from './services/approvals.js'
import { prepareMove, handleInvoiceEvent, pollContract } from './services/triggers.js'
import { prepareExtend } from './services/extension.js'
import { isValidIso } from './dates.js'
import { recordingsSummary } from './builtin/recordings.js'
import { withClient } from './llmGuard.js'
import { SANDBOX_EVIDENCE } from './builtin/sandboxEvidence.js'

const idSchema = z.string().uuid()
const orderTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9]{8,40}$/, 'bad checkout token') })
const isoSchema = z.string().refine(isValidIso, 'must be a calendar date like 2027-03-12')

function parse(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '))
  return result.data
}

export function createApi(ctx) {
  const api = Router()
  api.use((req, res, next) => withClient(req.ip, next))

  const sessionOf = (req) => {
    const header = req.get('x-session-id')
    if (!header) throw new HttpError(400, 'Session missing, reload the page.')
    const id = parse(idSchema, header)
    const session = ctx.store.getSession(id)
    if (!session) throw new HttpError(404, 'Session not found. Reload the page.')
    return session
  }
  const contractOf = (req) => ctx.store.getContract(sessionOf(req), parse(idSchema, req.params.id))
  const send = (res, data, status = 200) => res.status(status).json({ success: true, data })

  api.get('/health', (req, res) => {
    send(res, { modes, model: config.anthropicModel, recordings: modes.llm === 'mock' ? recordingsSummary() : null, evidence: SANDBOX_EVIDENCE, testBuyer: modes.paypal === 'sandbox' ? config.testBuyer : null, samples: SAMPLES.map(({ key, couple, blurb }) => ({ key, couple, blurb })), today: ctx.today() })
  })

  // First screen before any contract exists: a read-only Gantt of a sample plan. Computed by the server, nothing is created or sent.
  api.get('/preview', async (req, res, next) => {
    try {
      const { sample } = parse(z.object({ sample: z.enum(['A', 'B']).default('B') }), req.query)
      const text = sampleContractText(sampleFor(sample), ctx.today()).text
      // The preview never spends a model call.
      const { read, steps } = await readContract(text, { offline: true })
      const throwaway = { id: 'preview', contracts: new Map() }
      const view = publicContract(ctx, createContract(ctx, throwaway, { read, steps, text }))
      send(res, { name: view.name, eventDate: view.eventDate, totalCents: view.totalCents, gantt: view.gantt })
    } catch (err) {
      next(err)
    }
  })

  api.post('/session', (req, res) => {
    send(res, { sessionId: ctx.store.createSession().id })
  })

  api.get('/contracts', (req, res, next) => {
    try {
      const session = sessionOf(req)
      send(res, [...session.contracts.values()].map((c) => ({ id: c.id, name: c.name, totalCents: c.totalCents, eventDate: c.eventDate })))
    } catch (err) {
      next(err)
    }
  })

  // Read a contract (sample or pasted text), check the money, and open the first approval card.
  api.post('/contracts', async (req, res, next) => {
    try {
      const session = sessionOf(req)
      const body = parse(z.object({
        sample: z.enum(['A', 'B', 'C']).optional(),
        text: z.string().min(40).max(20000).optional(),
        edits: z.array(z.object({ index: z.number().int().min(0).max(5), percent: z.number().positive().max(100) })).max(6).optional(),
      }).refine((b) => b.sample || b.text, 'Send a sample key or contract text.'), req.body)
      const text = body.sample ? sampleContractText(sampleFor(body.sample), ctx.today()).text : body.text
      let result
      try {
        result = await readContract(text, { edits: body.edits, sampleKey: body.sample || null, today: ctx.today() })
      } catch (err) {
        if (err instanceof ContractError) {
          res.status(422).json({ success: false, message: err.message, data: { clauses: err.read?.clauses || [], text, sample: body.sample || null } })
          return
        }
        throw err
      }
      const contract = createContract(ctx, session, { read: result.read, steps: result.steps, text, source: result.source, sourceLabel: result.sourceLabel, sampleKey: body.sample || null })
      requestInvoices(ctx, contract)
      send(res, publicContract(ctx, contract), 201)
    } catch (err) {
      next(err)
    }
  })

  api.get('/contracts/:id', (req, res, next) => {
    try {
      send(res, publicContract(ctx, contractOf(req)))
    } catch (err) {
      next(err)
    }
  })

  // The photographer dropped the wedding bar on a new day. Returns the preview and the approval card; PayPal is untouched.
  api.post('/contracts/:id/move', async (req, res, next) => {
    try {
      const contract = contractOf(req)
      const { eventDate } = parse(z.object({ eventDate: isoSchema }), req.body)
      await prepareMove(ctx, contract, eventDate)
      send(res, publicContract(ctx, contract))
    } catch (err) {
      next(err)
    }
  })

  // The photographer dragged one scheduled payment to a later day. Draft only: PayPal is untouched until approval.
  api.post('/contracts/:id/extend', (req, res, next) => {
    try {
      const contract = contractOf(req)
      const { stepId, dueDate } = parse(z.object({ stepId: z.string().min(1).max(20), dueDate: isoSchema }), req.body)
      prepareExtend(ctx, contract, stepId, dueDate)
      send(res, publicContract(ctx, contract))
    } catch (err) {
      next(err)
    }
  })

  api.post('/contracts/:id/approvals/:aid/execute', async (req, res, next) => {
    try {
      const session = sessionOf(req)
      const contractId = parse(idSchema, req.params.id)
      await executeApproval(ctx, session, contractId, parse(idSchema, req.params.aid))
      send(res, publicContract(ctx, ctx.store.getContract(session, contractId)))
    } catch (err) {
      if (err instanceof HttpError || err.status) return next(err)
      // PayPal failure inside an executor: report it, keep the plan.
      next(new HttpError(502, err.message))
    }
  })

  api.post('/contracts/:id/approvals/:aid/dismiss', (req, res, next) => {
    try {
      const session = sessionOf(req)
      const contractId = parse(idSchema, req.params.id)
      dismissApproval(ctx, session, contractId, parse(idSchema, req.params.aid))
      send(res, publicContract(ctx, ctx.store.getContract(session, contractId)))
    } catch (err) {
      next(err)
    }
  })

  api.post('/contracts/:id/jobs/:jid/retry', async (req, res, next) => {
    try {
      const session = sessionOf(req)
      const contractId = parse(idSchema, req.params.id)
      await retryJob(ctx, session, contractId, parse(idSchema, req.params.jid))
      send(res, publicContract(ctx, ctx.store.getContract(session, contractId)))
    } catch (err) {
      next(err)
    }
  })

  api.post('/contracts/:id/record-payment', (req, res, next) => {
    try {
      const contract = contractOf(req)
      const body = parse(z.object({ stepId: z.string().min(1).max(20), amountCents: z.number().int().positive().max(100000000).optional() }), req.body)
      requestRecordPayment(ctx, contract, body)
      send(res, publicContract(ctx, contract))
    } catch (err) {
      next(err)
    }
  })

  // Polling entrance (the sandbox may not reach a local webhook URL).
  api.post('/contracts/:id/refresh', async (req, res, next) => {
    try {
      const contract = contractOf(req)
      await pollContract(ctx, contract)
      send(res, publicContract(ctx, contract))
    } catch (err) {
      next(err)
    }
  })

  // PayPal sends the payer back here after approving. The order id must be one this app created.
  // The browser carries no session header, so the contract is found through the order id.
  api.get('/deposit/return', async (req, res, next) => {
    try {
      const { token } = parse(orderTokenSchema, req.query)
      const found = ctx.store.findByOrderId(token)
      if (!found) throw new HttpError(404, 'Unknown checkout. Nothing was captured.')
      let outcome = 'captured'
      try {
        await captureDepositFor(ctx, found.contract, found.step.id)
      } catch (err) {
        if (!err.status) throw err
        outcome = err.unknown ? 'checking' : 'error'
      }
      res.redirect(302, `${ctx.appBaseUrl}/?deposit=${outcome}`)
    } catch (err) {
      next(err)
    }
  })

  api.get('/deposit/cancel', (req, res, next) => {
    try {
      const { token } = parse(orderTokenSchema, req.query)
      if (!ctx.store.findByOrderId(token)) throw new HttpError(404, 'Unknown checkout.')
      res.redirect(302, `${ctx.appBaseUrl}/?deposit=cancelled`)
    } catch (err) {
      next(err)
    }
  })

  // Recovery for a lost return or an unknown outcome: read the order, capture if the payer approved.
  api.post('/contracts/:id/deposit/capture', async (req, res, next) => {
    try {
      const contract = contractOf(req)
      await captureDepositFor(ctx, contract, contract.steps[0].id)
      send(res, publicContract(ctx, contract))
    } catch (err) {
      next(err)
    }
  })

  api.post('/webhooks/paypal', async (req, res, next) => {
    try {
      const event = req.body
      if (!(await verifyWebhook(req.headers, event))) throw new HttpError(401, 'Webhook signature check failed.')
      const result = await handleInvoiceEvent(ctx, event)
      res.status(200).json({ success: true, data: result })
    } catch (err) {
      next(err)
    }
  })

  // Mock-only controls for the demo: the sandbox buyer paying, and a PayPal edit that fails once.
  api.post('/dev/buyer-pays', async (req, res, next) => {
    try {
      if (typeof ctx.invoicing.simulateBuyerPayment !== 'function') throw new HttpError(404, 'Not available with real sandbox keys: pay from the sandbox buyer account.')
      const contract = contractOf({ get: req.get.bind(req), params: { id: req.body.contractId } })
      const { stepId } = parse(z.object({ stepId: z.string().min(1).max(20) }), req.body)
      const step = contract.steps.find((s) => s.id === stepId)
      if (!step?.invoice) throw new HttpError(404, 'No invoice for that step yet.')
      await ctx.invoicing.simulateBuyerPayment(step.invoice.id)
      await new Promise((r) => setTimeout(r, 30))
      await pollContract(ctx, contract)
      send(res, publicContract(ctx, contract))
    } catch (err) {
      next(err)
    }
  })

  api.post('/dev/fail-next', (req, res, next) => {
    try {
      if (typeof ctx.invoicing.failNext !== 'function') throw new HttpError(404, 'Not available with real sandbox keys.')
      const session = sessionOf(req)
      const { op } = parse(z.object({ op: z.enum(['update', 'send']) }), req.body)
      // Scoped to this session's invoices: another judge's PayPal edit is never the one that fails.
      const owns = (invoiceId) => Boolean(invoiceId) && [...session.contracts.values()].some((c) => c.steps.some((s) => s.invoice?.id === invoiceId))
      ctx.invoicing.failNext({ op, appliesTo: owns })
      send(res, { armed: op })
    } catch (err) {
      next(err)
    }
  })

  return api
}

export function errorHandler(err, req, res, next) {
  const status = err.status || 500
  if (status >= 500) console.error(err)
  // Unexpected errors never leak their internal message to the browser.
  res.status(status).json({ success: false, message: err.status ? err.message : 'Server error. Try again, or reload the page.' })
}
