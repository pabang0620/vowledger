import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readContractMock } from '../server/contracts/mockReader.js'
import { readContract, verifyAgainstText } from '../server/contracts/extract.js'
import { sampleFor, sampleContractText } from '../server/contracts/samples.js'
import { invoiceBody, withNewDates } from '../server/services/invoiceBody.js'
import { TODAY } from './helpers.js'

const textB = sampleContractText(sampleFor('B'), TODAY)

test('the reader finds three clauses with exact quotes, the fee clause and the lead time', async () => {
  const out = await readContract(textB.text)
  assert.deepEqual(out.read.clauses.map((c) => [c.percent, c.anchor, c.offsetDays]), [[30, 'SIGNING', 0], [40, 'EVENT', -60], [30, 'EVENT', -30]])
  for (const c of out.read.clauses) assert.ok(textB.text.includes(c.quote), c.quote)
  assert.equal(out.read.totalCents, 480000)
  assert.equal(out.read.eventDate, textB.eventDate)
  assert.equal(out.read.dateChangeFee.cents, 15000)
  assert.equal(out.read.leadDays, 14)
  assert.equal(out.read.partialAllowed, true)
  assert.deepEqual(out.steps.map((s) => s.amountCents), [144000, 192000, 144000])
})

test('a quote that is not in the contract, or a percent that is not in its quote, is refused', () => {
  const read = readContractMock(textB.text)
  const made = { ...read, clauses: read.clauses.map((c, i) => (i === 1 ? { ...c, quote: 'The second installment is 45% due 45 days before the event' } : c)) }
  assert.throws(() => verifyAgainstText(made, textB.text), /not in the contract/)
  const wrongPercent = { ...read, clauses: read.clauses.map((c, i) => (i === 1 ? { ...c, percent: 45 } : c)) }
  assert.throws(() => verifyAgainstText(wrongPercent, textB.text), /does not appear in its quote/)
})

test('text without a total or an event date fails with a plain message', async () => {
  await assert.rejects(readContract('Hello this is not a contract at all, just some words to pass the length.'), /total fee/)
})

test('invoice body uses payment_term DUE_ON_DATE_SPECIFIED and a PUT keeps everything but the two dates', () => {
  const contract = { id: 'c1', name: 'Ortiz & Lee', client: { given: 'Marta', surname: 'Ortiz', email: 'm@example.com' }, vendor: { businessName: 'Lena Park Photography', email: 'lena@example.com' }, partialAllowed: true }
  const step = { id: 'p3', label: 'Balance', amountCents: 144000, quote: '30% due 30 days before the event' }
  const body = invoiceBody({ contract, step, number: 'INV-0023', issueDate: '2027-01-27', dueDate: '2027-02-10' })
  assert.equal(body.detail.invoice_date, '2027-01-27')
  assert.equal(body.detail.payment_term.term_type, 'DUE_ON_DATE_SPECIFIED')
  assert.equal(body.detail.payment_term.due_date, '2027-02-10')
  assert.equal(body.items[0].unit_amount.value, '1440.00')
  assert.equal(body.configuration.partial_payment.allow_partial_payment, true)
  const put = withNewDates(body, '2027-03-17', '2027-03-31')
  assert.equal(put.detail.invoice_date, '2027-03-17')
  assert.equal(put.detail.payment_term.due_date, '2027-03-31')
  assert.equal(put.detail.invoice_number, 'INV-0023')
  assert.deepEqual(put.items, body.items)
  assert.deepEqual(put.primary_recipients, body.primary_recipients)
})
