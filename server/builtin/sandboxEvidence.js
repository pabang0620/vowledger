// What was checked against the real services, copied from VERIFY.md. Only PASS items are listed as passed;
// partial and not-run items are named so nothing reads as verified when it was not.
export const SANDBOX_EVIDENCE = {
  ranOn: '2026-11-12',
  passed: [
    { id: 'V1', text: 'Two SCHEDULED invoices stayed SCHEDULED after a PUT moved their issue and due dates' },
    { id: 'V2', text: 'PayPal accepts a due date in the past' },
    { id: 'V4', text: 'PUT on a SENT invoice is allowed' },
    { id: 'V7', text: 'APIMatic SDK smoke: a real getOrder answered 404 with the mapped message' },
    { id: 'V9 (steps 1-5)', text: 'Deposit order created, approved by the sandbox buyer, captured once ($1,440.00 COMPLETED); a second capture press sent no call' },
    { id: 'S1 (full app walk)', text: 'README steps 1-4 in sandbox mode: order 28E9422366600420M paid on the real sandbox checkout page, capture 98690159WF131234R; wedding moved Mar 12 -> Apr 30, INV-0021 and INV-0022 stayed SCHEDULED with new dates (get_invoice), fee invoice INV-0027 SENT' },
    { id: 'V8 (account mode)', text: 'Claude Sonnet through a local Claude Code login read sample B and picked a server option; not the hosted API-key path' },
    { id: 'VB1-VB7', text: 'Real Bryntum Gantt in headless Chromium agrees with the server engine (npm run check:bryntum)' },
  ],
  partial: [{ id: 'V3', text: 'Partial payment: record-payment path PASS, hosted-page partial payment not driven' }],
  notRun: [{ id: 'V5', text: 'Webhook delivery (needs a public URL)' }, { id: 'V6', text: 'Automatic reminders (not wired)' }, { id: 'V9 step 6', text: 'Network cut during order create' }],
}
