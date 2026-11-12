import { randomUUID } from 'node:crypto'

// Build an approval card. Returns [id, approval] so callers can put it straight into the map.
export function newApproval(contract, fields) {
  const id = randomUUID()
  return [id, {
    id,
    contractId: contract.id,
    status: 'pending',
    planVersion: contract.planVersion,
    createdAt: new Date().toISOString(),
    lines: [],
    unchanged: [],
    ...fields,
  }]
}
