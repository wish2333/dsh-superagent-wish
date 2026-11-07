// The Partner tools are loaded through the package subpath, so a wrong `exports`
// entry fails here (ADR-0002).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import { createHost, createStorageDomain } from './host-fake.js'

const PARTNER = 'partner-1'

/** The Partner and the implementer preset mounted on one fake Host, Partner Session open. */
async function partner() {
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-'))
  const host = createHost({
    storageDomain: createStorageDomain(),
    services: ['agentPresets', 'systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory'],
    workingDirectory: base,
  })
  partnerModule.apply(host.ctx)
  implementer.apply(host.ctx)
  host.setAgent(PARTNER, { id: PARTNER, session: { id: PARTNER, header: { cwd: base } } })
  host.cleanup = () => rm(base, { recursive: true, force: true })
  return host
}

/** Calls a tool as DSH does, from the calling Agent's Session. */
async function call(host, name, args, agentId = PARTNER) {
  const registration = host.callsTo('tools.register').find((call) => call.args.definition.name === name)
  assert.ok(registration, `a preset registers ${name}`)
  return registration.args.definition.execute(args, { agent: { id: agentId }, callId: 'call-1', signal: undefined })
}

/** The single text block of a tool result. */
function textOf(result) {
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  return result.content[0].text
}

const DISPATCH = { type: 'implementer', title: 'Write the storage layer', body: 'Implement the tables under src/.' }

test('a working unit whose session was deleted is opened again from its own id', async () => {
  const host = await partner()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const sessionId = `superagent-wish-${unitId}`
    const directory = host.callsTo('workspaceRegistry.create')[0].args
    assert.ok(host.removeSession(sessionId), 'the test deleted the worker session')

    const text = textOf(await call(host, 'partner_followup', { unitId, text: 'Carry on where you stopped.' }))
    assert.match(text, new RegExp(`Sent to ${unitId}`))

    const created = host.callsTo('sessionController.create').map((item) => item.args)
    assert.equal(created.length, 2)
    // The same id, and the same directory: the unit keeps both across the loss.
    assert.equal(created[1].sessionId, sessionId)
    assert.equal(host.callsTo('workspaceRegistry.create').at(-1).args, directory)

    const agent = host.ctx.agents.get(sessionId)
    assert.equal(agent.delivered.at(-1).message.content[0].text, 'Carry on where you stopped.')
  } finally {
    await host.cleanup()
  }
})

test('the recreated worker session is permitted and named like the first one', async () => {
  const host = await partner()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const sessionId = `superagent-wish-${unitId}`
    host.removeSession(sessionId)
    const permitted = host.callsTo('permissionPresets.set').length
    const named = host.callsTo('sessionController.rename').length

    await call(host, 'partner_followup', { unitId, text: 'Again.' })
    assert.equal(host.callsTo('permissionPresets.set').length, permitted + 1)
    assert.equal(host.callsTo('sessionController.rename').length, named + 1)
    assert.equal(host.callsTo('permissionPresets.set').at(-1).args.session.id, sessionId)
    assert.deepEqual(host.callsTo('sessionController.rename').at(-1).args, { sessionId, title: 'Write the storage layer' })
  } finally {
    await host.cleanup()
  }
})

test('a title change renames the session and leaves the directory as it was', async () => {
  const host = await partner()
  try {
    const first = textOf(await call(host, 'partner_dispatch', DISPATCH))
    // A second unit of the same title is a different unit and a different directory.
    const second = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Write the storage layer, again' }))
    const directories = host.callsTo('workspaceRegistry.create').map((item) => item.args)
    assert.deepEqual(directories, [
      join(host.ctx.workingDirectory.defaultDirectory, 'superagent-wish', first),
      join(host.ctx.workingDirectory.defaultDirectory, 'superagent-wish', second),
    ])
    assert.ok(host.callsTo('sessionController.rename').every((item) => !String(item.args.sessionId).includes('storage')))
  } finally {
    await host.cleanup()
  }
})

test('a worker session that a Host failure cannot open is reported in one sentence', async () => {
  const host = await partner()
  try {
    host.ctx.workspaceRegistry.create = () => Promise.reject(new Error('Workspace path is not fully qualified'))
    const text = textOf(await call(host, 'partner_dispatch', DISPATCH))
    assert.equal(text, 'Workspace path is not fully qualified')
    // No unit was recorded for a dispatch that never reached a Worker.
    assert.match(textOf(await call(host, 'partner_list', {})), /No working units yet/)
  } finally {
    await host.cleanup()
  }
})
