// The Partner tools are loaded through the package subpath, so a wrong `exports`
// entry fails here (ADR-0002).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import { createHost, createStorageDomain } from './host-fake.js'

const PARTNER = 'partner-1'

/** The Partner preset mounted on a fake Host, with its Partner Session open. */
async function partner() {
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-'))
  const host = createHost({
    storageDomain: createStorageDomain(),
    services: ['agentPresets', 'systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory'],
    workingDirectory: base,
  })
  partnerModule.apply(host.ctx)
  host.setAgent(PARTNER, { id: PARTNER, session: { id: PARTNER, header: { cwd: base } } })
  host.cleanup = () => rm(base, { recursive: true, force: true })
  return host
}

/** Calls a Partner tool as DSH does, from the Partner Session. */
async function call(host, name, args) {
  const registration = host.callsTo('tools.register').find((call) => call.args.definition.name === name)
  assert.ok(registration, `the Partner preset registers ${name}`)
  return registration.args.definition.execute(args, { agent: { id: PARTNER }, callId: 'call-1', signal: undefined })
}

/** The single text block of a tool result. */
function textOf(result) {
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  return result.content[0].text
}

const DISPATCH = { type: 'implementer', title: 'Write the storage layer', body: 'Implement the tables under src/.' }

/** Opens one working unit and returns its id. */
async function oneUnit(host) {
  return textOf(await call(host, 'partner_dispatch', DISPATCH))
}

/** The Worker Session a unit id belongs to. */
function worker(host, unitId) {
  const agent = host.ctx.agents.get(`superagent-wish-${unitId}`)
  assert.ok(agent, `unit ${unitId} has a worker session`)
  return agent
}

test('partner_followup queues the input and delivers it to the same worker session', async () => {
  const host = await partner()
  try {
    const unitId = await oneUnit(host)
    const created = host.callsTo('sessionController.create').length
    const agent = worker(host, unitId)

    const result = await call(host, 'partner_followup', { unitId, text: 'Also cover the empty directory case.' })
    assert.match(textOf(result), new RegExp(`Sent to ${unitId}`))

    // The same Session, not a new one.
    assert.equal(host.callsTo('sessionController.create').length, created)
    assert.equal(agent.delivered.length, 2)
    const delivered = agent.delivered.at(-1)
    assert.equal(delivered.mode, 'followup')
    assert.equal(delivered.message.content[0].text, 'Also cover the empty directory case.')
    assert.equal(delivered.message.role, 'user')
    assert.deepEqual(delivered.message.source, { kind: 'user' })
    assert.equal(typeof delivered.message.id, 'string')
  } finally {
    await host.cleanup()
  }
})

test('a follow-up asks no confirmation and rebuilds no working directory', async () => {
  const host = await partner()
  try {
    const unitId = await oneUnit(host)
    const directories = host.callsTo('workspaceRegistry.create').length
    const renames = host.callsTo('sessionController.rename').length
    await call(host, 'partner_followup', { unitId, text: 'One more thing.' })
    assert.equal(host.callsTo('workspaceRegistry.create').length, directories, 'no workspace is registered again')
    assert.equal(host.callsTo('sessionController.rename').length, renames, 'the title is left as it was')
    // DSH renders the tool result as it is: no question is put to the model here.
    assert.equal(host.callsTo('sessionController.prompt').length, 0)
  } finally {
    await host.cleanup()
  }
})

test('follow-ups queue in order, and the next arrives after the one before', async () => {
  const host = await partner()
  try {
    const unitId = await oneUnit(host)
    const agent = worker(host, unitId)
    await call(host, 'partner_followup', { unitId, text: 'First addition.' })
    await call(host, 'partner_followup', { unitId, text: 'Second addition.' })
    assert.deepEqual(
      agent.delivered.map((item) => item.message.content[0].text),
      [DISPATCH.body, 'First addition.', 'Second addition.'],
    )
  } finally {
    await host.cleanup()
  }
})

test('a follow-up to an unknown unit is refused in one sentence', async () => {
  const host = await partner()
  try {
    const text = textOf(await call(host, 'partner_followup', { unitId: 'unit-99', text: 'Hello' }))
    assert.match(text, /there is no working unit unit-99/)
    assert.doesNotMatch(text, /\n/)
  } finally {
    await host.cleanup()
  }
})

test('partner_stop cancels the worker turn and leaves the unit in place', async () => {
  const host = await partner()
  try {
    const unitId = await oneUnit(host)
    const agent = worker(host, unitId)
    const text = textOf(await call(host, 'partner_stop', { unitId }))
    assert.match(text, new RegExp(`Stopped ${unitId}`))

    const cancelled = agent.delivered.filter((item) => item.mode === 'cancel')
    assert.equal(cancelled.length, 1)
    assert.deepEqual(cancelled[0].cause, { kind: 'user' })
    // A stop ends this turn, not the input already queued behind it.
    assert.deepEqual(cancelled[0].options, { keepInbox: true })

    // The unit is still there, and it is not ended.
    const listed = textOf(await call(host, 'partner_list', {}))
    assert.match(listed, new RegExp(`${unitId} "Write the storage layer" — implementer`))
    assert.doesNotMatch(listed, /ended/)
  } finally {
    await host.cleanup()
  }
})

test('a stopped unit takes a follow-up, which reaches the same worker', async () => {
  const host = await partner()
  try {
    const unitId = await oneUnit(host)
    const agent = worker(host, unitId)
    await call(host, 'partner_stop', { unitId })
    const text = textOf(await call(host, 'partner_followup', { unitId, text: 'Actually start over from the schema.' }))
    assert.match(text, new RegExp(`Sent to ${unitId}`))
    assert.equal(host.callsTo('sessionController.create').length, 1, 'the stopped session is still the worker')
    assert.equal(agent.delivered.at(-1).message.content[0].text, 'Actually start over from the schema.')
  } finally {
    await host.cleanup()
  }
})

test('partner_stop and partner_followup refuse a finished unit', async () => {
  const host = await partner()
  try {
    const unitId = await oneUnit(host)
    await call(host, 'partner_followup', { unitId, text: 'Only this far.' })
    await call(host, 'partner_list', {})
  } finally {
    await host.cleanup()
  }
})
