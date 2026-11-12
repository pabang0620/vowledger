import { AsyncLocalStorage } from 'node:async_hooks'
import { config } from './config.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export const REASON_LIMIT = 'live limit reached'
export const REASON_UNAVAILABLE = 'live model unavailable'

// Rolling windows: runs per client IP in the last hour, and runs on this host in the last 24 hours.
// One run is one user-triggered action (a contract reading or an agent decision), not one tool turn.
export function createLimiter({ perIpHour, perDay, now = Date.now }) {
  const byIp = new Map()
  let day = []
  const fresh = (list, span, t) => list.filter((at) => t - at < span)
  return {
    take(ip) {
      const t = now()
      const hour = fresh(byIp.get(ip) || [], HOUR_MS, t)
      day = fresh(day, DAY_MS, t)
      if (hour.length >= perIpHour || day.length >= perDay) {
        byIp.set(ip, hour)
        return false
      }
      byIp.set(ip, [...hour, t])
      day = [...day, t]
      return true
    },
  }
}

export const defaultLimiter = createLimiter({ perIpHour: config.livePerIpHour, perDay: config.livePerDay })

// The HTTP layer stores the caller's IP here so the model code can count a run without passing it through every service.
const clientStore = new AsyncLocalStorage()
export const withClient = (ip, fn) => clientStore.run({ ip }, fn)
export const currentIp = () => clientStore.getStore()?.ip || 'unknown'

// Try one live run. Returns { out } on success, or { reason } when a cap is reached or the model call fails
// for any reason (network, 4xx/5xx, timeout, credit). The caller then answers from a recording or the rule-based twin.
export async function attemptLive(run, { limiter = defaultLimiter, ip = currentIp() } = {}) {
  if (!limiter.take(ip)) return { reason: REASON_LIMIT }
  try {
    return { out: await run() }
  } catch {
    return { reason: REASON_UNAVAILABLE }
  }
}
