import { money2 } from '../schedule/compute.js'
import { modes } from '../config.js'

// Invoicing v2 request body. invoice_date = when PayPal sends it, due_date = when it must be paid.
export function invoiceBody({ contract, step, number, issueDate, dueDate }) {
  const amount = { currency_code: 'USD', value: money2(step.amountCents) }
  return {
    detail: {
      invoice_number: number,
      invoice_date: issueDate,
      reference: `${contract.id}:${step.id}`,
      currency_code: 'USD',
      note: `${step.label} for ${contract.name}. Contract clause: "${step.quote}"`.slice(0, 4000),
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate },
    },
    invoicer: {
      business_name: contract.vendor.businessName,
      // PayPal sends from the account behind the REST app. A sample address makes send_invoice fail with USER_NOT_FOUND, so the live path leaves it out.
      ...(modes.paypal === 'sandbox' ? {} : { email_address: contract.vendor.email }),
    },
    primary_recipients: [{
      billing_info: {
        name: { given_name: contract.client.given, surname: contract.client.surname },
        email_address: contract.client.email,
      },
    }],
    items: [{ name: step.label, description: `${contract.name} wedding photography`, quantity: '1', unit_amount: amount }],
    configuration: {
      allow_tip: false,
      partial_payment: contract.partialAllowed
        ? { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '1.00' } }
        : { allow_partial_payment: false },
    },
  }
}

// PUT replaces the invoice. Start from the body PayPal returned so nothing is cleared, change only the two dates.
export function withNewDates(current, issueDate, dueDate) {
  return {
    detail: { ...current.detail, invoice_date: issueDate, payment_term: { ...current.detail.payment_term, term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate } },
    invoicer: current.invoicer,
    primary_recipients: current.primary_recipients,
    items: current.items,
    configuration: current.configuration,
  }
}
