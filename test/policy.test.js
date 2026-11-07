// The policy is read through the plugin entry: `partner_setup` saves it and
// says which unit a rule change reached; `partner_list` shows what a unit
// recorded and what its worker was sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as openManager } from '@wish2333/dsh-superagent-wish'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import { createHost, createStorageDomain } from './host-fake.js'

const PARTNER = 'partner-1'
const DISCOVERER_PRESET = 'superagent-wish-discoverer'
const IMPLEMENTER_PRESET = 'superagent-wish-implementer'
const SERVICES = [
  'agentPresets',
  'systemPrompt',
  'tools',
  'agents',
  'workspaceRegistry',
  'sessionController',
  'permissionPresets',
  'workingDirectory',
]

const DISPATCH = {
  type: 'implementer',
  title: 'Write the storage layer',
  body: 'Implement the working unit tables under src/.',
}

/**
 * The plugin entry as DSH mounts it: the manager registers the presets, then the
 * Partner and implementer presets mount their modules on the same Host. A
 * second host over the medium's `snapshot()` is the plugin after a restart.
 */
async function plugin(options = {}) {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'superagent-wish-')))
  const host = createHost({
    storageDomain: options.medium ?? createStorageDomain(),
    services: SERVICES,
    workingDirectory: base,
    resolvablePresets: [DISCOVERER_PRESET, IMPLEMENTER_PRESET],
  })
  partnerModule.apply(host.ctx)
  implementer.apply(host.ctx)
  host.setAgent(PARTNER, { id: PARTNER, session: { id: PARTNER, header: { cwd: base } } })
  host.base = base
  host.cleanup = () => rm(base, { recursive: true, force: true })
  return host
}

/** The definition of the tool named `name` mounted on `host`. */
function tool(host, name) {
  const registration = host.callsTo('tools.register').find((call) => call.args.definition.name === name)
  assert.ok(registration, `${name} is registered`)
  return registration.args.definition
}

/** Calls a tool as DSH does: the arguments, and the calling Agent. */
async function call(host, name, args, agentId = PARTNER) {
  const exec = { agent: { id: agentId }, callId: 'call-1', signal: undefined }
  return tool(host, name).execute(args, exec)
}

/** The text of a tool result's single content block. */
function textOf(result) {
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  return result.content[0].text
}

/** The `partner_list` record of `unitId`, as Partner reads it. */
async function listed(host, unitId) {
  const result = await call(host, 'partner_list', { includeEnded: true })
  const unit = result.record.units.find((item) => item.id === unitId)
  assert.ok(unit, `${unitId} is listed`)
  return unit
}

/** The texts of the messages the worker Session `sessionId` has taken, in order. */
function texts(host, sessionId) {
  const agent = host.ctx.agents.get(sessionId)
  assert.ok(agent, `${sessionId} is open`)
  return agent.delivered.map((item) => item.message.content[0].text)
}

test('a dispatched unit records a policy version, and partner_list gives it time to be read', async () => {
  const host = await plugin()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const unit = await listed(host, unitId)
    assert.equal(typeof unit.sinceAt, 'string', 'the list says when the unit entered its state')
    assert.deepEqual(host.callsTo('sessionController.create').map((item) => item.args.sessionId), [`superagent-wish-${unitId}`])
  } finally {
    await host.cleanup()
  }
})

test('the version follows the rules: saving the same rules keeps it, saving a new rule moves it', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', DISPATCH)
    const first = await changeRules(host, [])
    assert.equal(first.from, first.to, 'the default rules saved as they are: nothing moved')

    const second = await changeRules(host, [{ id: 'scope', name: 'Scope', enabled: true, instruction: 'Stay inside src/.' }])
    assert.notEqual(second.to, second.from, 'a new rule gives another version')
    assert.equal(second.notified.length, 1, 'the open unit is told once')
    // The same rules saved again change nothing.
    const third = await changeRules(host, [{ id: 'scope', name: 'Scope', enabled: true, instruction: 'Stay inside src/.' }])
    assert.equal(third.to, second.to, 'the same rules give the same version')
    assert.deepEqual(third.notified, [], 'and tell no unit again')
  } finally {
    await host.cleanup()
  }
})

test('the version survives a restart: a reloaded plugin reads the rules it saved, and tells a waiting unit once', async () => {
  const medium = createStorageDomain()
  const before = await plugin({ medium })
  try {
    await call(before, 'partner_dispatch', DISPATCH)
    const saved = await changeRules(before, [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix wording only.' }])
    before.dispose()

    // The same plugin over what the first host stored, as a restart replays it.
    const after = await plugin({ medium: createStorageDomain(medium.snapshot()), base: before.base })
    try {
      const setup = textOf(await call(after, 'partner_setup', {}))
      assert.match(setup, /copy \(Copy fixes\): Fix wording only\./)
      // The same rules, saved again after the restart, are the rules in force.
      const again = await changeRules(after, [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix wording only.' }])
      assert.equal(again.to, saved.to, 'the reloaded policy holds the version it was saved with')
    } finally {
      await after.cleanup()
    }
  } finally {
    await before.cleanup()
  }
})

test('a rule change reaches the unit still running, as an input its worker reads', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', DISPATCH)
    const before = texts(host, 'superagent-wish-unit-1')
    const result = await changeRules(host, [{ id: 'scope', name: 'Scope', enabled: true, instruction: 'Stay inside src/.' }])

    assert.deepEqual(result.notified, ['unit-1'], 'the running unit is told')
    // The notice is recorded on the unit, and reaches the worker after what it
    // had already read.
    const unit = await listed(host, 'unit-1')
    assert.deepEqual(unit.policyNotices, [{ from: result.from, to: result.to }], 'the unit records the change')
    const delivered = texts(host, 'superagent-wish-unit-1')
    assert.deepEqual(delivered.slice(0, before.length), before, 'what the worker had read is unchanged')
    assert.equal(delivered.length, before.length + 1)
    assert.match(delivered.at(-1), /policy/i)
    assert.match(delivered.at(-1), /Stay inside src\//, 'the rule as it now reads reaches the worker')
  } finally {
    await host.cleanup()
  }
})

test('a rule change does not revoke the mandate of a running unit, which still takes work', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', DISPATCH)
    await changeRules(host, [{ id: 'scope', name: 'Scope', enabled: true, instruction: 'Stay inside src/.' }])

    // The unit keeps running, and a follow-up still reaches it.
    assert.equal((await listed(host, 'unit-1')).state, 'running')
    const text = textOf(await call(host, 'partner_followup', { unitId: 'unit-1', text: 'One more file.' }))
    assert.match(text, /Sent to unit-1/)
    assert.equal(texts(host, 'superagent-wish-unit-1').at(-1), 'One more file.')
  } finally {
    await host.cleanup()
  }
})

test('a save that changes no rule notifies no unit and reaches no worker', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', DISPATCH)
    const before = texts(host, 'superagent-wish-unit-1').length
    // The same rules the unit was opened under: no version change, no notification.
    const result = await changeRules(host, [])
    assert.equal(result.from, result.to)
    assert.deepEqual(result.notified, [], 'the version did not change, so no unit hears of it')
    assert.equal(texts(host, 'superagent-wish-unit-1').length, before)
  } finally {
    await host.cleanup()
  }
})

test('a rule change reaches a unit waiting for input, and one waiting for a decision', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First job' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second job' })
    await call(host, 'partner_report', { state: 'blocked', summary: 'The schema must be decided.' }, 'superagent-wish-unit-1')
    await call(host, 'partner_report', { state: 'ready', summary: 'Delivered the tables.' }, 'superagent-wish-unit-2')
    assert.equal((await listed(host, 'unit-1')).state, 'waiting-for-input')
    assert.equal((await listed(host, 'unit-2')).state, 'waiting-for-decision')

    const result = await changeRules(host, [{ id: 'scope', name: 'Scope', enabled: true, instruction: 'Stay inside src/.' }])
    assert.deepEqual(result.notified, ['unit-1', 'unit-2'], 'oldest first')
    for (const id of ['unit-1', 'unit-2']) {
      const unit = await listed(host, id)
      assert.deepEqual(unit.policyNotices, [{ from: result.from, to: result.to }], `${id} records the change`)
      assert.match(texts(host, `superagent-wish-${id}`).at(-1), /Stay inside src\//, `the worker of ${id} reads the rule`)
    }
  } finally {
    await host.cleanup()
  }
})

test('a rule change leaves an ended unit untouched', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, type: 'discoverer' })
    await call(host, 'partner_report', { state: 'ready', summary: 'Wrote three options.' }, 'superagent-wish-unit-1')
    assert.equal((await listed(host, 'unit-1')).state, 'ended')
    const delivered = texts(host, 'superagent-wish-unit-1').length
    const result = await changeRules(host, [{ id: 'scope', name: 'Scope', enabled: true, instruction: 'Stay inside src/.' }])
    assert.equal(result.notified.includes('unit-1'), false)
    assert.equal(texts(host, 'superagent-wish-unit-1').length, delivered)
  } finally {
    await host.cleanup()
  }
})

/** Saves the rules through the Partner's settings tool, as wish does. */
async function changeRules(host, rules) {
  const result = await call(host, 'partner_setup', { settings: { rules } })
  return { ...result.record, notified: result.record.notified ?? [] }
}

/**
 * A policy that withdraws the mandate of every unit already open: a unit was
 * opened under rules that named it, and the rules now name something else. The
 * version no longer matches, so the mandate does not revalidate.
 */
const WITHDRAWN = [{ id: 'other', name: 'Other', enabled: true, instruction: 'Only this rule applies now.' }]

test('an ended unit that is asked to continue is revalidated against the current policy', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, type: 'discoverer' })
    await call(host, 'partner_report', { state: 'ready', summary: 'Wrote three options.' }, 'superagent-wish-unit-1')
    assert.equal((await listed(host, 'unit-1')).state, 'ended')
    // The rules that unit was opened under are replaced.
    await changeRules(host, WITHDRAWN)

    const text = textOf(await call(host, 'partner_followup', { unitId: 'unit-1', text: 'Carry on.' }))
    assert.match(text, /no longer holds|policy/i)
    assert.doesNotMatch(text, /\n/, 'the error is one sentence')
    assert.equal((await listed(host, 'unit-1')).state, 'ended', 'it stays ended')
    assert.equal(host.callsTo('sessionController.create').length, 1, 'no worker was opened again')
  } finally {
    await host.cleanup()
  }
})

test('an ended unit whose mandate still holds stays ended for the ordinary reason', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, type: 'discoverer' })
    await call(host, 'partner_report', { state: 'ready', summary: 'Wrote three options.' }, 'superagent-wish-unit-1')
    const text = textOf(await call(host, 'partner_followup', { unitId: 'unit-1', text: 'Carry on.' }))
    // Ending is final, and the refusal does not blame the policy for it.
    assert.match(text, /has ended/)
    assert.doesNotMatch(text, /no longer holds/)
  } finally {
    await host.cleanup()
  }
})
