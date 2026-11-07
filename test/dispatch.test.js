import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { dispatch, workspaceDirectory } from '../partner.js'

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

// workspaceRegistry.create rejects a relative path: "Workspace path is not fully
// qualified". The Host reports that only at runtime, so assert it here.
test('a worker workspace path is absolute, created, and under the Partner directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-test-'))
  const { host } = hostWithSession()
  host.ctx.workingDirectory = { defaultDirectory: '/deployment/default', get: () => base }
  host.setAgent('partner-session', { id: 'partner-session', session: { id: 'partner-session' } })

  try {
    await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, CALLER)

    const created = host.callsTo('workspaceRegistry.create')[0].args
    assert.equal(created, `${base}/superagent-wish/write-the-report`)
    // workspaceRegistry.create refuses a nonexistent directory, so dispatch makes it.
    assert.ok(statSync(created).isDirectory(), 'the worker directory exists before registration')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a missing Partner directory falls back to the deployment directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-test-'))
  const { host } = hostWithSession()
  host.ctx.workingDirectory = { defaultDirectory: base }
  try {
    await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, CALLER)
    assert.equal(host.callsTo('workspaceRegistry.create')[0].args, `${base}/superagent-wish/write-the-report`)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a missing deployment directory falls back to an absolute path anyway', () => {
  assert.ok(workspaceDirectory('A task', undefined).startsWith('/'))
  assert.ok(workspaceDirectory('A task', '').startsWith('/'))
  assert.equal(workspaceDirectory('A task', '/base/'), '/base/superagent-wish/a-task')
})

test('the dispatch path declares the service that supplies the base directory', async () => {
  const { WORKER_SERVICES } = await import('../partner.js')
  assert.ok(WORKER_SERVICES.includes('workingDirectory'))
})

// DSH's inbox takes { id, content, source, role }. A message without id/source
// is dropped: the worker session is created but stays blank, with no error.
test('the dispatched message carries the identity and source DSH requires', async () => {
  const { host } = hostWithSession()
  await dispatch({ ...CONTEXT, ...host.ctx }, ARGS, CALLER)

  const message = host.callsTo('agent.followup')[0].args
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.deepEqual(message.source, { kind: 'user' })
  assert.deepEqual(message.content, [{ type: 'text', text: ARGS.body }])
})

test('two dispatches never reuse one message id', async () => {
  const { userMessage } = await import('../messages.js')
  assert.notEqual(userMessage('a').id, userMessage('a').id)
})
