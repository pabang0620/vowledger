// Turns a stored contract into the plain input the engine needs.
export function modelOf(contract, overrides = {}) {
  return {
    eventDate: overrides.eventDate || contract.eventDate,
    signedOn: contract.signedOn,
    leadDays: contract.leadDays,
    steps: contract.steps,
    tasks: contract.tasks,
    adjustments: overrides.adjustments || contract.adjustments,
  }
}
