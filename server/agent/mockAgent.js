import { buildTools, runToolSafely } from './tools.js'

// Rule-based stand-in for the Claude loop. It calls the same tools in the same order a model would
// and goes through the same validation, so a mock run and a live run produce the same kind of proposal.

async function call(handlers, events, name, input) {
  const out = await runToolSafely(handlers, name, input)
  events.push({ tool: name, ok: out.ok, input })
  return out
}

// The rule-based twin also explains every option it did not pick, so its proposal passes the same check as Claude's.
function whyNot(option) {
  if (option.id === 'move:fee-skip') return 'The contract has a date-change clause, so waiving the fee would not follow it.'
  if (option.id === 'move:fee-add') return 'The contract has no date-change clause, so there is no fee to add.'
  if (option.id.endsWith(':keep')) return 'Keeping every date ignores what this payment event changes for the tasks that follow it.'
  if (option.id.endsWith(':hold-all')) return 'Holding internal work as well would delay the couple for no outside cost.'
  if (option.id.includes(':hold:')) return 'The rule holds only work that costs outside money, and this option is not the first such task.'
  return 'The rule starts internal work first and this option ranks lower under it.'
}

const notChosen = (options, chosenId) => options.filter((o) => o.id !== chosenId).map((o) => ({ option_id: o.id, why: whyNot(o) }))

async function propose(handlers, events, options, input) {
  return call(handlers, events, 'propose_option', { ...input, not_chosen: notChosen(options, input.option_id) })
}

export async function runMockAgent(ctx, contract, trigger, options) {
  const sink = { choice: null }
  const events = []
  const handlers = buildTools(ctx, contract, trigger, options, sink)

  if (trigger.kind === 'MOVE') {
    await call(handlers, events, 'list_contract_clauses', { topic: 'change' })
    await call(handlers, events, 'list_options', {})
    const fee = options.find((o) => o.id === 'move:fee-add') || options.find((o) => o.id === 'move:fee-skip')
    await propose(handlers, events, options, {
      option_id: fee.id,
      reason: fee.id === 'move:fee-add'
        ? 'The contract has a date-change clause, so the change fee is added as its own invoice, due as soon as the new date is confirmed.'
        : 'The contract has no date-change clause, so no fee is added.',
    })
    return { choice: sink.choice, events, via: 'mock-agent' }
  }

  await call(handlers, events, 'get_invoice_status', { step_id: trigger.stepId })
  await call(handlers, events, 'get_schedule', {})
  const deps = (await call(handlers, events, 'get_dependents', { step_id: trigger.stepId })).result
  await call(handlers, events, 'list_contract_clauses', {})
  await call(handlers, events, 'list_options', {})

  if (trigger.kind === 'PAID') {
    const internal = deps.find((d) => d.cost === 'internal' && options.some((o) => o.id === `paid:${trigger.stepId}:pull:${d.id}`))
    const external = deps.find((d) => d.cost === 'external' && options.some((o) => o.id === `paid:${trigger.stepId}:pull:${d.id}`))
    const pick = internal || external
    if (pick) {
      await propose(handlers, events, options, {
        option_id: `paid:${trigger.stepId}:pull:${pick.id}`,
        reason: `The payment is confirmed, so "${pick.name}" no longer has to wait for the planned date. ${pick.cost === 'internal' ? 'It has no outside cost, so starting early is safe.' : 'The money is in, so the outside cost is covered.'} Everything else keeps its planned dates.`,
      })
    } else {
      await propose(handlers, events, options, { option_id: `paid:${trigger.stepId}:keep`, reason: 'The payment is confirmed and no task benefits from starting earlier, so the planned dates stay.' })
    }
  } else {
    const external = deps.find((d) => d.cost === 'external' && options.some((o) => o.id === `due:${trigger.stepId}:hold:${d.id}`))
    const step = contract.steps.find((s) => s.id === trigger.stepId)
    const note = `Hi ${contract.client.given}, a friendly reminder that the ${step.label.toLowerCase()} invoice is due. Once it is paid I can place the album order. Thank you!`
    if (external) {
      await propose(handlers, events, options, {
        option_id: `due:${trigger.stepId}:hold:${external.id}`,
        reason: `"${external.name}" costs outside money and the contract ties it to this installment, so it waits until PayPal confirms the payment. Internal tasks are not blocked.`,
        reminder_note: note,
        reminder_clause: trigger.stepId,
      })
    } else {
      await propose(handlers, events, options, { option_id: `due:${trigger.stepId}:keep`, reason: 'No dependent task costs outside money, so production continues while the reminder goes out.', reminder_note: note, reminder_clause: trigger.stepId })
    }
  }
  return { choice: sink.choice, events, via: 'mock-agent' }
}
