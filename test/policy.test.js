// The policy is read through the plugin entry: `partner_dispatch` stamps its
// version into the new unit's mandate, the rules reach the Partner's own
// conversation, and a rule change reaches the Workers that are still running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as openManager } from '@wish2333/dsh-superagent-wish'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import { createHost, createStorageDomain } from './host-fake.js'
import { openPolicy } from '../policy.js'

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

/** The record of `unitId` in the working_unit table the plugin keeps. */
function stored(host, unitId) {
  return host.storageDomain.contents('working_units')[unitId]
}

/** The mandate of `unitId`, as the store keeps it. */
function mandate(host, unitId) {
  return host.storageDomain.contents('mandates')[unitId]
}

/** The texts of the messages the worker Session `sessionId` has taken, in order. */
function texts(host, sessionId) {
  const agent = host.ctx.agents.get(sessionId)
  assert.ok(agent, `${sessionId} is open`)
  return agent.delivered.map((item) => item.message.content[0].text)
}

/**
 * The policy record opened over the same medium the plugin uses, the way a
 * settings tool would open it. The plugin's own handle keeps its records, so a
 * second handle reads what the plugin wrote and writes what the plugin reads.
 */
async function openPolicyAt(host) {
  const scope = createHost({ storageDomain: host.storageDomain })
  return openPolicy(scope.ctx)
}

test('a new unit records the policy version current at its dispatch', async () => {
  const host = await plugin()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const stored_ = mandate(host, unitId)
    assert.equal(typeof stored_.policyVersion, 'string')
    assert.notEqual(stored_.policyVersion, 'policy-1', 'the placeholder is gone')
    assert.doesNotMatch(stored_.policyVersion, /policy-1/)
  } finally {
    await host.cleanup()
  }
})

test('the version follows the rules: the same rules give the same version, different rules another', async () => {
  // Two hosts with their own medium and directory, and the same rules: both start from the default policy.
  const first = await plugin()
  const second = await plugin()
  try {
    await call(first, 'partner_dispatch', DISPATCH)
    await call(second, 'partner_dispatch', DISPATCH)
    const one = mandate(first, 'unit-1').policyVersion
    const two = mandate(second, 'unit-1').policyVersion
    assert.equal(one, two, 'nothing was changed between the two dispatches')
    // A second dispatch under one policy keeps that policy's version.
    await call(second, 'partner_dispatch', { ...DISPATCH, title: 'Second job' })
    assert.equal(mandate(second, 'unit-2').policyVersion, two)

    // A change to the rules gives another version; the units opened before it keep theirs.
    const policy = await openPolicyAt(second)
    await policy.setPolicy({ rules: [{ id: 'scope', name: 'Scope', enabled: true, instruction: 'Stay inside src/.' }] })
    await call(second, 'partner_dispatch', { ...DISPATCH, title: 'Third job' })
    const third = mandate(second, 'unit-3').policyVersion
    assert.notEqual(third, two)
    assert.equal(mandate(second, 'unit-1').policyVersion, two, 'an earlier unit keeps the version it was opened under')
  } finally {
    await second.cleanup()
    await first.cleanup()
  }
})

test('the version survives a restart: a reloaded plugin dispatches under the same version', async () => {
  const medium = createStorageDomain()
  const before = await plugin({ medium })
  try {
    const policy = await openPolicyAt(before)
    await policy.setPolicy({ rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix wording only.' }] })
    const version = mandate(before, textOf(await call(before, 'partner_dispatch', DISPATCH))).policyVersion
    before.dispose()

    // The same plugin over what the first host stored, as a restart replays it.
    const after = await plugin({ medium: createStorageDomain(medium.snapshot()), base: before.base })
    try {
      const reloaded = mandate(after, textOf(await call(after, 'partner_dispatch', { ...DISPATCH, title: 'After restart' }))).policyVersion
      assert.equal(reloaded, version)
    } finally {
      await after.cleanup()
    }
  } finally {
    await before.cleanup()
  }
})
