import { randomUUID } from 'node:crypto'

const SESSION_TTL_MS = 6 * 60 * 60 * 1000

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// In-memory store, one bucket per browser session. A session never sees another session's contracts.
export function createStore() {
  const sessions = new Map()
  let invoiceCounter = 20
  // Durable-write claims: one row per write, committed before the PayPal call. Set-if-absent is the duplicate guard.
  const claims = new Map()

  return {
    createSession() {
      const session = { id: randomUUID(), createdAt: Date.now(), contracts: new Map() }
      sessions.set(session.id, session)
      return session
    },
    getSession(id) {
      const session = sessions.get(id)
      if (!session) return null
      if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(id)
        return null
      }
      return session
    },
    getContract(session, contractId) {
      const contract = session.contracts.get(contractId)
      if (!contract) throw new HttpError(404, 'Contract not found.')
      return contract
    },
    // Webhooks carry no session: find the contract that owns an invoice.
    findByInvoiceId(invoiceId) {
      for (const session of sessions.values()) {
        for (const contract of session.contracts.values()) {
          const step = contract.steps.find((s) => s.invoice?.id === invoiceId)
          if (step) return { contract, step }
        }
      }
      return null
    },
    findByOrderId(orderId) {
      for (const session of sessions.values()) {
        for (const contract of session.contracts.values()) {
          const step = contract.steps.find((s) => s.deposit?.orderId === orderId)
          if (step) return { contract, step }
        }
      }
      return null
    },
    claim(key, value) {
      if (claims.has(key)) return false
      claims.set(key, { ...value, at: Date.now() })
      return true
    },
    getClaim: (key) => claims.get(key) || null,
    setClaim(key, value) {
      claims.set(key, { ...claims.get(key), ...value })
    },
    releaseClaim: (key) => claims.delete(key),
    allContracts() {
      return [...sessions.values()].flatMap((s) => [...s.contracts.values()])
    },
    nextInvoiceNumber() {
      invoiceCounter += 1
      return `INV-${String(invoiceCounter).padStart(4, '0')}`
    },
  }
}
