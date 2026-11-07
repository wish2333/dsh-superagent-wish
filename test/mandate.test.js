// The mandate's scope: the unit's authorization comes from what the Worker was
// told to do, and a follow-up that widens the work adds to that scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost, createStorageDomain } from './host-fake.js'
import * as partner from '@wish2333/dsh-superagent-wish/partner'

const PARTNER = 'partner-1'

/** The Partner preset mounted on a fake Host, its Partner Session open. */
async function partnerHost() {
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-'))
  const host = createHost({
    storageDomain: createStorageDomain(),
    services: ['agentPresets', 'systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory'],
    workingDirectory: base,
  })
  partner.apply(host.ctx)
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

const BODY = 'Move the storage layer under src/storage and keep its tests green.'

test('a dispatched unit\'s mandate takes its scope from what the worker was told, and its title only names it', async () => {
  const host = await partnerHost()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', { type: 'implementer', title: 'Storage cleanup', body: BODY }))
    const listed = (await call(host, 'partner_list', {})).record.units.find((unit) => unit.id === unitId)
    assert.equal(listed.name, 'Storage cleanup', 'the title is still what the unit is called')
    assert.deepEqual(listed.scope, { current: BODY, previous: [] }, 'the authorization is the dispatch\'s first input, not its name')
    assert.notEqual(listed.scope.current, listed.name)
  } finally {
    await host.cleanup()
  }
})

test('a follow-up that widens the work adds to the unit\'s scope, and the old scope is still readable', async () => {
  const host = await partnerHost()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', { type: 'implementer', title: 'Storage cleanup', body: BODY }))
    const widening = 'Also update the CLI that reads the old path.'
    const text = textOf(await call(host, 'partner_followup', { unitId, text: widening }))
    assert.match(text, new RegExp(`Sent to ${unitId}`))

    const listed = (await call(host, 'partner_list', {})).record.units.find((unit) => unit.id === unitId)
    assert.deepEqual(listed.scope, { current: `${BODY}\n\n${widening}`, previous: [BODY] })
    // The widening reaches the worker as an input, in order.
    const delivered = host.ctx.agents.get(`superagent-wish-${unitId}`).delivered.map((item) => item.message.content[0].text)
    assert.deepEqual(delivered, [BODY, widening])
  } finally {
    await host.cleanup()
  }
})
