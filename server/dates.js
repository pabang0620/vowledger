// Calendar dates are plain 'YYYY-MM-DD' strings. All arithmetic runs in UTC so DST never shifts a day.
const DAY_MS = 86400000

export function toMs(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function fromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(iso, days) {
  return fromMs(toMs(iso) + days * DAY_MS)
}

export function diffDays(later, earlier) {
  return Math.round((toMs(later) - toMs(earlier)) / DAY_MS)
}

export const maxDate = (a, b) => (a >= b ? a : b)
export const minDate = (a, b) => (a <= b ? a : b)

export function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidIso(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  return fromMs(toMs(value)) === value
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'Mar 12' style label used in cards and badges.
export function shortLabel(iso) {
  const [, m, d] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}`
}

export function weekday(iso) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(toMs(iso)).getUTCDay()]
}
