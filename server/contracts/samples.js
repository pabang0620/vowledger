import { addDays } from '../dates.js'
import { usd } from '../schedule/compute.js'

// Synthetic contracts. Dates are built from the day the button is pressed, never hard coded.
export const SAMPLES = [
  { key: 'A', couple: 'Kim & Rivera', given: 'Jae', surname: 'Kim', email: 'kim.rivera@example.com', eventOffsetDays: 60, blurb: 'Event in 60 days: the 2nd installment is due today' },
  { key: 'B', couple: 'Ortiz & Lee', given: 'Marta', surname: 'Ortiz', email: 'ortiz.lee@example.com', eventOffsetDays: 120, blurb: 'Event in 120 days: drag the wedding date' },
  { key: 'C', couple: 'Novak & Daniels', given: 'Ana', surname: 'Novak', email: 'novak.daniels@example.com', eventOffsetDays: 150, blurb: 'Clauses add up to 95%: shows the check', percents: [30, 35, 30] },
]

export const SAMPLE_TOTAL_CENTS = 480000

export function sampleFor(key) {
  return SAMPLES.find((s) => s.key === key) || null
}

// Plain contract text a photographer would upload. The reader finds the clauses in it.
export function sampleContractText(sample, today) {
  const eventDate = addDays(today, sample.eventOffsetDays)
  const [p1, p2, p3] = sample.percents || [30, 40, 30]
  return {
    eventDate,
    signedOn: today,
    text: [
      'WEDDING PHOTOGRAPHY AGREEMENT (SAMPLE, SYNTHETIC DATA)',
      '',
      `Photographer: Lena Park Photography. Client: ${sample.couple} (${sample.given} ${sample.surname}, ${sample.email}).`,
      `Event date: ${eventDate}. Contract signed: ${today}.`,
      '',
      `1. Fee. The total fee for the event coverage is ${usd(SAMPLE_TOTAL_CENTS)}.`,
      '2. Coverage. Eight hours of coverage, one lead photographer, an engagement shoot and a 30 page album.',
      `3. Retainer. A retainer of ${p1}% of the total fee is due at signing and holds the date.`,
      `4. Second installment. ${p2}% of the total fee is due 60 days before the event.`,
      `5. Balance. The remaining ${p3}% of the total fee is due 30 days before the event.`,
      '6. Invoices are sent 14 days before each due date. Partial payments are accepted.',
      '7. Album. The album is ordered once the second installment has been paid.',
      '8. Cancellation. The retainer is not refundable.',
      '9. Date change. Moving the event date after signing carries a change fee of $150, due on the day the new date is confirmed.',
      '',
    ].join('\n'),
  }
}
