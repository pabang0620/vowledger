import { PaypalError } from 'paypal'
import { OrdersError, OutcomeUnknownError } from './errors.js'

// One mapping from the SDK's failure family to the app's error, used by every Orders call.
// The SDK message names the URL, so it is never returned: callers get a fixed message or PayPal's own reason.

function reasonOf(payload) {
  const body = payload && typeof payload === 'object' && 'body' in payload ? payload.body : null
  if (!body) return null
  const detail = body.details?.[0]
  const text = detail?.description || detail?.issue || body.message || ''
  return text ? String(text).slice(0, 300) : null
}

function withDebugId(error, payload) {
  const body = payload && typeof payload === 'object' && 'body' in payload ? payload.body : null
  if (body?.debugId) error.debugId = body.debugId
  return error
}

// Returns the error to throw. `write` calls turn "no answer" into an unknown outcome.
export function translateSdkError(err, { write, what }) {
  if (!(err instanceof PaypalError)) return err
  switch (err.kind) {
    case 'api': {
      const status = err.status
      if (status === 401 || status === 403) return new OrdersError(502, 'AUTH', 'PayPal refused our credentials.')
      if (status === 429) return new OrdersError(503, 'RATE_LIMITED', 'PayPal is rate limiting this app. Try again soon.')
      if (status >= 500) return withDebugId(new OrdersError(502, 'PAYPAL_ERROR', 'PayPal had an error.'), err.payload)
      const reason = reasonOf(err.payload) || 'PayPal rejected the request.'
      return withDebugId(new OrdersError(status, 'REJECTED', reason), err.payload)
    }
    case 'decode':
      if (err.status >= 400 && err.status < 500) return new OrdersError(err.status, 'REJECTED', 'PayPal rejected the request; the details were unreadable.')
      return write ? new OutcomeUnknownError(what) : new OrdersError(502, 'UNREADABLE', 'PayPal answered with something unreadable.')
    case 'connection':
    case 'timeout':
      return write ? new OutcomeUnknownError(what) : new OrdersError(502, 'UNREACHABLE', 'PayPal could not be reached.')
    case 'auth':
      return new OrdersError(502, 'AUTH', 'PayPal credentials could not be obtained.')
    case 'encode':
      return new OrdersError(500, 'ENCODE', 'The PayPal request could not be built.')
    default:
      return err
  }
}
