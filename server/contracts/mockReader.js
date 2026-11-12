import { ContractError } from '../schedule/compute.js'

// Deterministic contract reader used when no ANTHROPIC_API_KEY is set. It reads the real text with
// patterns, quotes the sentence it used, and returns the same shape the Claude reader returns.

const sentences = (text) => text.split(/\n+/).map((l) => l.trim()).filter(Boolean)

function parseDollars(raw) {
  return Math.round(Number(raw.replace(/,/g, '')) * 100)
}

export function readContractMock(text) {
  const lines = sentences(text)
  const out = { clauses: [], dateChangeFee: null, partialAllowed: false, leadDays: null }

  const totalLine = lines.find((l) => /total fee/i.test(l))
  const totalMatch = totalLine && totalLine.match(/\$([\d,]+(?:\.\d{2})?)/)
  if (!totalMatch) throw new ContractError('Could not find a total fee in the contract.')
  out.totalCents = parseDollars(totalMatch[1])
  out.totalQuote = totalLine

  const eventDate = text.match(/Event date:\s*(\d{4}-\d{2}-\d{2})/i)
  const signedOn = text.match(/signed:\s*(\d{4}-\d{2}-\d{2})/i)
  if (!eventDate) throw new ContractError('Could not find the event date in the contract.')
  out.eventDate = eventDate[1]
  out.signedOn = signedOn ? signedOn[1] : null

  const client = text.match(/Client:\s*([^(]+)\(([^,)]+),\s*([^)]+)\)/)
  if (client) {
    const [given, ...rest] = client[2].trim().split(/\s+/)
    out.couple = client[1].trim().replace(/\.$/, '')
    out.client = { given, surname: rest.join(' ') || given, email: client[3].trim() }
  }

  for (const line of lines) {
    const pct = line.match(/(\d{1,3})%/)
    if (!pct || /total fee/i.test(line) === false) continue
    const label = (line.match(/^\d+\.\s*([A-Za-z ]+?)\./) || [])[1]
    if (/at signing/i.test(line)) {
      out.clauses.push({ label: label || 'Retainer', percent: Number(pct[1]), anchor: 'SIGNING', offsetDays: 0, quote: line.replace(/^\d+\.\s*/, '') })
      continue
    }
    const days = line.match(/(\d{1,3})\s+days?\s+before the event/i)
    if (days) out.clauses.push({ label: label || 'Installment', percent: Number(pct[1]), anchor: 'EVENT', offsetDays: -Number(days[1]), quote: line.replace(/^\d+\.\s*/, '') })
  }

  const feeLine = lines.find((l) => /change fee/i.test(l))
  const feeMatch = feeLine && feeLine.match(/\$([\d,]+(?:\.\d{2})?)/)
  if (feeMatch) out.dateChangeFee = { cents: parseDollars(feeMatch[1]), quote: feeLine.replace(/^\d+\.\s*/, '') }

  out.partialAllowed = lines.some((l) => /partial payments? (?:are|is) accepted/i.test(l))
  const lead = text.match(/sent\s+(\d{1,3})\s+days?\s+before each due date/i)
  out.leadDays = lead ? Number(lead[1]) : null
  return out
}
