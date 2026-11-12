let sessionId = null

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

async function call(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sessionId ? { 'X-Session-Id': sessionId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ success: false, message: `Server error (${res.status})` }))
  if (!res.ok || !json.success) throw new ApiError(json.message || `Request failed (${res.status})`, res.status, json.data)
  return json.data
}

export async function startSession() {
  const stored = sessionStorage.getItem('vowledger.session')
  if (stored) {
    sessionId = stored
    try {
      await call('GET', '/contracts')
      return stored
    } catch {
      sessionId = null
    }
  }
  const data = await call('POST', '/session')
  sessionId = data.sessionId
  try {
    sessionStorage.setItem('vowledger.session', sessionId)
  } catch {
    // Private windows can block storage: the session simply lasts for this page load.
  }
  return sessionId
}

export const api = {
  health: () => call('GET', '/health'),
  contracts: () => call('GET', '/contracts'),
  contract: (id) => call('GET', `/contracts/${id}`),
  createContract: (body) => call('POST', '/contracts', body),
  preview: (sample = 'B') => call('GET', `/preview?sample=${sample}`),
  extend: (id, stepId, dueDate) => call('POST', `/contracts/${id}/extend`, { stepId, dueDate }),
  move: (id, eventDate) => call('POST', `/contracts/${id}/move`, { eventDate }),
  execute: (id, approvalId) => call('POST', `/contracts/${id}/approvals/${approvalId}/execute`),
  dismiss: (id, approvalId) => call('POST', `/contracts/${id}/approvals/${approvalId}/dismiss`),
  retry: (id, jobId) => call('POST', `/contracts/${id}/jobs/${jobId}/retry`),
  recordPayment: (id, body) => call('POST', `/contracts/${id}/record-payment`, body),
  captureDeposit: (id) => call('POST', `/contracts/${id}/deposit/capture`),
  refresh: (id) => call('POST', `/contracts/${id}/refresh`),
  buyerPays: (contractId, stepId) => call('POST', '/dev/buyer-pays', { contractId, stepId }),
  failNext: (op) => call('POST', '/dev/fail-next', { op }),
}
