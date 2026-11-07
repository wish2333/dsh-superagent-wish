import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { dispatch } from '../partner.js'

const CONTEXT = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} } }

function hostWithSession({ existing = false } = {}) {
  const host = createHost()
  const agent = { session: { id: 'agent-session' }, followup: [] }
  agent.followup = async (message) => {
    host.calls.push({ name: 'agent.followup', args: message })
  }
  let resolutions = 0
  host.ctx.sessionController.resolveAgent = async (sessionId) => {
    resolutions += 1
    host.calls.push({ name: 'sessionController.resolveAgent', args: sessionId })
    if (existing) return { agent }
    return resolutions === 1 ? { error: { code: 'session/not-found' } } : { agent }
  }
  return { host, agent }
}

const ARGS = { kind: 'implementer', title: 'Write the report', body: 'goal: write the report' }
const CALLER = { agent: { id: 'partner-session' } }

test('a dispatch runs the seven Host steps in order', async () => {
  const { host } = hostWithSession()
  const result = await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, CALLER)

  const order = host.calls.map((call) => call.name)
  const expected = [
    'sessionController.resolveAgent',
    'workspaceRegistry.create',
    'sessionController.create',
    'sessionController.resolveAgent',
    'permissionPresets.set',
    'sessionController.rename',
    'agent.followup',
  ]
  assert.deepEqual(order.filter((name) => expected.includes(name)), expected)
  assert.equal(result.isError, undefined)
})

test('a dispatch names the worker preset, the session and the rights', async () => {
  const { host } = hostWithSession()
  await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, CALLER)

  const create = host.callsTo('sessionController.create')[0].args
  assert.equal(create.agentPreset, 'superagent-wish-implementer')
  assert.ok(create.sessionId)
  assert.equal(host.callsTo('sessionController.rename')[0].args.title, 'Write the report')
  assert.equal(host.callsTo('permissionPresets.set')[0].args.preset, 'danger-full-access')
  assert.match(host.callsTo('agent.followup')[0].args.content[0].text, /write the report/)
})

test('a dispatch of a discoverer uses the discoverer preset', async () => {
  const { host } = hostWithSession()
  await dispatch({ ...CONTEXT, ...host.ctx }, { ...ARGS, kind: 'discoverer' }, CALLER)
  assert.equal(host.callsTo('sessionController.create')[0].args.agentPreset, 'superagent-wish-discoverer')
})

test('a retry of the same dispatch reuses the session instead of creating a second one', async () => {
  const { host } = hostWithSession({ existing: true })
  const result = await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, CALLER)
  assert.equal(host.callsTo('sessionController.create').length, 0)
  assert.equal(host.callsTo('workspaceRegistry.create').length, 0)
  assert.match(result.content[0].text, /Reused/)
})

test('an unknown worker type is an error and touches no Host service', async () => {
  const { host } = hostWithSession()
  const result = await dispatch({ ...CONTEXT, ...host.ctx }, { ...ARGS, kind: 'reviewer' }, CALLER)
  assert.equal(result.isError, true)
  assert.equal(host.calls.length, 0)
})

test('a dispatch without a calling session is refused before any Host call', async () => {
  const { host } = hostWithSession()
  for (const exec of [undefined, {}, { agent: {} }]) {
    const result = await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, exec)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /calling Partner session/)
  }
  assert.equal(host.calls.length, 0)
})

test('a missing Host service is an error result, not a thrown exception', async () => {
  const result = await dispatch({ ...CONTEXT }, ARGS, CALLER)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Host services/)
})

test('a Host failure is translated into a one-line error result', async () => {
  const { host } = hostWithSession()
  host.ctx.workspaceRegistry.create = async () => {
    throw new Error('disk is full')
  }
  const result = await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, CALLER)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /disk is full/)
})
