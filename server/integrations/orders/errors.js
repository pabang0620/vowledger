import { PayPalError } from '../mockPaypal.js'

// An error whose message is the plain sentence for the caller (the SDK's own message names the URL and stays in the logs).
export class OrdersError extends PayPalError {
  constructor(status, name, text) {
    super(status, name, text)
    this.message = text
  }
}

// The write may have reached PayPal but the answer was lost or unreadable. This is "unknown", never "failed".
export class OutcomeUnknownError extends OrdersError {
  constructor(what) {
    super(502, 'OUTCOME_UNKNOWN', `PayPal did not confirm whether the ${what} happened. It is being checked; nothing is reported as failed.`)
    this.unknown = true
  }
}
