// The Partner tools are loaded through the package subpath, so a wrong `exports`
// entry fails here (ADR-0002).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as openManager } from '@wish2333/dsh-superagent-wish'
// Loaded through the package subpath, so a wrong `exports` entry fails here (ADR-0002).
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import { createHost, createStorageDomain } from './host-fake.js'

const PARTNER = 'partner-1'
const DISCOVERER_PRESET = 'superagent-wish-discoverer'
const IMPLEMENTER_PRESET = 'superagent-wish-implementer'

/**
 * The plugin entry as DSH mounts it: the manager registers the presets, then
 * the Partner preset's row mounts its submodule. The fake Host records every
 * Host call, and the Partner Session is open and idle.
 */
async function partner(options = {}) {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'superagent-wish-')))
  const host = createHost({
    storageDomain: createStorageDomain(),
    services: [
      'agentPresets',
      'systemPrompt',
      'tools',
      'agents',
      'workspaceRegistry',
      'sessionController',
      'permissionPresets',
      'workingDirectory',
    ],
    workingDirectory: base,
    resolvablePresets: [DISCOVERER_PRESET, IMPLEMENTER_PRESET],
    ...options,
  })
  partnerModule.apply(host.ctx)
  host.setAgent(PARTNER, { id: PARTNER, session: { id: PARTNER, header: { cwd: base } } })
  /** Removes the temporary base the Host's Partner directory lives in. */
  host.cleanup = () => rm(base, { recursive: true, force: true })
  return host
}

/** The definition of the tool named `name` the Partner preset registered. */
function tool(host, name) {
  const registration = host.callsTo('tools.register').find((call) => call.args.definition.name === name)
  assert.ok(registration, `the Partner preset registers ${name}`)
  return registration.args.definition
}

/**
 * Calls a Partner tool as DSH does: the arguments, and the calling Agent. A
 * `null` agent stands for an invocation that carries none.
 */
async function call(host, name, args, agentId = PARTNER) {
  const exec = agentId === null ? { callId: 'call-1', signal: undefined } : { agent: { id: agentId }, callId: 'call-1', signal: undefined }
  return tool(host, name).execute(args, exec)
}

/** The text of a tool result's single content block. */
function textOf(result) {
  assert.equal(result.content.length, 1, 'a tool result is one text block')
  assert.equal(result.content[0].type, 'text')
  return result.content[0].text
}

/** The message the worker Session `sessionId` most recently took. */
function lastMessage(host, sessionId) {
  const agent = host.ctx.agents.get(sessionId)
  return agent.delivered.at(-1)
}

const DISPATCH = {
  type: 'implementer',
  title: 'Write the storage layer',
  body: 'Implement the working unit tables under src/.',
}

test('partner_dispatch returns the working unit id, not the session id', async () => {
  const host = await partner()
  const result = await call(host, 'partner_dispatch', DISPATCH)
  const unitId = textOf(result)
  assert.match(unitId, /^unit-\d+$/)
  const created = host.callsTo('sessionController.create')
  assert.equal(created.length, 1)
  assert.notEqual(unitId, created[0].args.sessionId)
})

test('a dispatch creates the directory, opens the session, sets permissions, names and delivers it', async () => {
  const host = await partner()
  try {
    const base = host.ctx.workingDirectory.defaultDirectory
    const unitId = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Storage layer, part 2' }))
    const [create] = host.callsTo('sessionController.create').map((item) => item.args)
    const directory = host.callsTo('workspaceRegistry.create')[0].args
    assert.equal(directory, join(base, 'superagent-wish', unitId))
    assert.equal(unitId, 'unit-1')
    // The Host registers a directory it must find, so dispatch makes it first.
    assert.ok(statSync(directory).isDirectory(), 'the working directory exists before registration')
    assert.equal(create.agentPreset, IMPLEMENTER_PRESET)
    assert.equal(create.workspaceId, 'workspace-1')

    const agent = host.ctx.agents.get(create.sessionId)
    // Steps 2–5 in the order the chain runs them; the first delivery may repeat
    // steps 4–5, never skip them.
    const order = host.calls.map((item) => item.name).filter((name) =>
      ['sessionController.create', 'permissionPresets.set', 'sessionController.rename'].includes(name))
    assert.deepEqual(order.slice(0, 3), ['sessionController.create', 'permissionPresets.set', 'sessionController.rename'])
    for (const call of host.calls) {
      if (call.name === 'permissionPresets.set') {
        assert.equal(call.args.session.id, create.sessionId)
        assert.equal(call.args.preset, 'danger-full-access')
      }
    }
    const named = new Set(host.callsTo('sessionController.rename').map((item) => JSON.stringify(item.args)))
    assert.deepEqual([...named], [JSON.stringify({ sessionId: create.sessionId, title: 'Storage layer, part 2' })])
    assert.equal(create.sessionId, `superagent-wish-${unitId}`)
    const [delivered] = agent.delivered
    assert.equal(delivered.mode, 'followup')
    assert.equal(delivered.message.role, 'user')
    assert.equal(typeof delivered.message.id, 'string')
    assert.deepEqual(delivered.message.source, { kind: 'user' })
    assert.equal(delivered.message.content[0].text, DISPATCH.body)
  } finally {
    await host.cleanup()
  }
})

test('the working directory and the session id both follow the working unit id', async () => {
  const host = await partner()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const directory = host.callsTo('workspaceRegistry.create')[0].args
    assert.equal(directory, join(host.ctx.workingDirectory.defaultDirectory, 'superagent-wish', unitId))
    const [create] = host.callsTo('sessionController.create').map((item) => item.args)
    assert.equal(create.sessionId, `superagent-wish-${unitId}`)
  } finally {
    await host.cleanup()
  }
})

test('a reuse of a unit\'s session needs the same unit: a second dispatch opens a second unit', async () => {
  const host = await partner()
  try {
    const first = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const second = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Another job' }))
    assert.notEqual(first, second)
    const sessions = host.callsTo('sessionController.create').map((item) => item.args.sessionId)
    assert.equal(sessions.length, 2)
    assert.notEqual(sessions[0], sessions[1])
    // Each unit keeps its own directory; neither dispatch rebuilds the other's.
    const directories = host.callsTo('workspaceRegistry.create').map((item) => item.args)
    assert.equal(new Set(directories).size, 2)
  } finally {
    await host.cleanup()
  }
})

test('an unknown worker type is refused, and no session is created', async () => {
  const host = await partner()
  try {
    const result = await call(host, 'partner_dispatch', { ...DISPATCH, type: 'researcher' })
    const text = textOf(result)
    assert.match(text, /unknown worker type "researcher"/)
    assert.doesNotMatch(text, /\n/, 'the error is one sentence')
    assert.deepEqual(host.callsTo('sessionController.create'), [])
    assert.deepEqual(host.callsTo('workspaceRegistry.create'), [])
  } finally {
    await host.cleanup()
  }
})

test('a call with no calling session is refused, and no working unit is created', async () => {
  const host = await partner()
  try {
    const result = await call(host, 'partner_dispatch', DISPATCH, null)
    assert.match(textOf(result), /no calling session/i)
    assert.deepEqual(host.callsTo('sessionController.create'), [])
    // Nothing to list either: a unit without a caller could never be reported to.
    const listed = await call(host, 'partner_list', {})
    assert.match(textOf(listed), /No working units yet/)
  } finally {
    await host.cleanup()
  }
})

test('a dispatch may name the model, and the chosen model reaches the Host', async () => {
  const host = await partner()
  try {
    const selected = []
    host.ctx.sessionController.selectModel = (input) => {
      selected.push(input)
      return Promise.resolve({ selected: { provider: input.provider, model: input.model } })
    }
    const unitId = textOf(await call(host, 'partner_dispatch', {
      ...DISPATCH,
      model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
    }))
    assert.deepEqual(selected, [
      { sessionId: `superagent-wish-${unitId}`, provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' },
    ])
  } finally {
    await host.cleanup()
  }
})

test('a dispatch without a model selects none: the session keeps its default', async () => {
  const host = await partner()
  try {
    let selected = 0
    host.ctx.sessionController.selectModel = () => {
      selected += 1
      return Promise.resolve({})
    }
    await call(host, 'partner_dispatch', DISPATCH)
    assert.equal(selected, 0)
  } finally {
    await host.cleanup()
  }
})

test('a model the Host refuses is reported as one sentence and leaves no working unit', async () => {
  const host = await partner()
  try {
    host.ctx.sessionController.selectModel = () => Promise.reject(new Error('Model "nope" does not exist.'))
    const result = await call(host, 'partner_dispatch', { ...DISPATCH, model: { provider: 'deepseek', model: 'nope' } })
    assert.match(textOf(result), /deepseek\/nope is not available/)
    const listed = await call(host, 'partner_list', {})
    assert.match(textOf(listed), /No working units yet/)
  } finally {
    await host.cleanup()
  }
})

test('the partner_report tool is not one Partner mounts', async () => {
  const host = await partner()
  try {
    const names = host.callsTo('tools.register').map((call) => call.args.definition.name)
    assert.deepEqual(names.sort(), ['partner_dispatch', 'partner_followup', 'partner_list', 'partner_stop'])
  } finally {
    await host.cleanup()
  }
})
