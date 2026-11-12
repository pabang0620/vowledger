import test from 'node:test'
import assert from 'node:assert/strict'
import { readContractLive, READ_TOOL } from '../server/contracts/extract.js'

const toolReply = { content: [{ type: 'tool_use', name: READ_TOOL.name, input: { eventDate: '2027-01-01' } }] }
const textReply = { content: [{ type: 'text', text: 'Here are the terms.' }] }

function fakeClient(replies) {
  const requests = []
  return {
    requests,
    messages: {
      async create(req) {
        requests.push(req)
        const type = req.tool_choice?.type
        if (type === 'tool' || type === 'any') throw new Error('400 tool_choice: type "tool" and "any" are not supported for this model')
        return replies[Math.min(requests.length - 1, replies.length - 1)]
      },
    },
  }
}

test('no request carries a forced tool_choice and the tool name is in the system line', async () => {
  const client = fakeClient([toolReply])
  const out = await readContractLive('contract', client)
  assert.equal(out.eventDate, '2027-01-01')
  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0].tool_choice.type, 'auto')
  assert.match(client.requests[0].system, /calling the tool submit_contract_terms/)
})

test('a model that answers in text once is retried with the instruction repeated', async () => {
  const client = fakeClient([textReply, toolReply])
  const out = await readContractLive('contract', client)
  assert.equal(out.eventDate, '2027-01-01')
  assert.equal(client.requests.length, 2)
  assert.ok(client.requests.every((r) => r.tool_choice.type === 'auto'))
  assert.ok(client.requests[1].system.length > client.requests[0].system.length)
})

test('a model that never calls the tool throws so the fallback runs', async () => {
  const client = fakeClient([textReply])
  await assert.rejects(() => readContractLive('contract', client), /did not call submit_contract_terms/)
  assert.equal(client.requests.length, 2)
})
