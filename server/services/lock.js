const locks = new Map()

// Serialize every money or schedule write for one contract so two approvals never interleave.
export function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}
