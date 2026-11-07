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

/** The store the tools opened, through the medium the Host was given. */
const mediumOf = (host) => host.storageDomain

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

/**
 * Turns the clock forward for the rest of one test, so a span between two
 * recorded instants is known: the store writes those instants from this clock.
 */
const clockAt = (iso) => {
  const original = Date.now
  Date.now = () => Date.parse(iso)
  return () => { Date.now = original }
}

test('partner_list names each unit\'s name, type, state and how long it has been there', async () => {
  const host = await partner()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const text = textOf(await call(host, 'partner_list', {}))
    assert.match(text, new RegExp(`${unitId} "Write the storage layer" — implementer, running \\(0m in this state\\)`))
  } finally {
    await host.cleanup()
  }
})

test('a unit waiting for wish shows how long it has waited and the report it waits on', async () => {
  const host = await partner()
  let restore = () => {}
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    await call(host, 'partner_report', { state: 'ready', summary: 'Delivered the tables.' }, `superagent-wish-${unitId}`)
    // Move the clock on: the unit waits on the ready report it took.
    restore = clockAt(new Date(Date.now() + 2 * 3600_000 + 10 * 60_000).toISOString())
    const text = textOf(await call(host, 'partner_list', {}))
    assert.match(text, /waiting-for-decision \(2h 10m in this state\): ready — Delivered the tables\./)
  } finally {
    restore()
    await host.cleanup()
  }
})

test('an ended unit shows how long ago it ended when it is asked for', async () => {
  const host = await partner()
  let restore = () => {}
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, type: 'discoverer' }))
    await call(host, 'partner_report', { state: 'ready', summary: 'Wrote three options.' }, `superagent-wish-${unitId}`)
    restore = clockAt(new Date(Date.now() + 26 * 3600_000).toISOString())
    const text = textOf(await call(host, 'partner_list', { includeEnded: true }))
    assert.match(text, /, ended \(1d 2h ago\)/)
  } finally {
    restore()
    await host.cleanup()
  }
})

test('partner_list leaves every unit as it was', async () => {
  const host = await partner()
  try {
    const unitId = textOf(await call(host, 'partner_dispatch', DISPATCH))
    const before = JSON.stringify(mediumOf(host).snapshot())
    await call(host, 'partner_list', {})
    await call(host, 'partner_list', { includeEnded: false })
    assert.equal(JSON.stringify(mediumOf(host).snapshot()), before)
    assert.ok(unitId)
  } finally {
    await host.cleanup()
  }
})

// User story 36: Partner's context holds what it needs. Ended units are read
// only when asked for, so a long life does not grow the list on every call.
test('partner_list leaves the ended units out unless they are asked for', async () => {
  const host = await partner()
  try {
    const done = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, type: 'discoverer' }))
    await call(host, 'partner_report', { state: 'ready', summary: 'Wrote three options.' }, `superagent-wish-${done}`)
    const open = textOf(await call(host, 'partner_dispatch', DISPATCH))

    const listed = textOf(await call(host, 'partner_list', {}))
    assert.ok(listed.includes(open), 'open work is always listed')
    assert.ok(!listed.includes(done), 'an ended unit is not listed by default')

    const asked = textOf(await call(host, 'partner_list', { includeEnded: true }))
    assert.ok(asked.includes(open))
    assert.ok(asked.includes(done), 'includeEnded true brings the ended units back')
    assert.match(asked, /, ended \(0m ago\)/)
  } finally {
    await host.cleanup()
  }
})

test('the ended units are not read by default, and no unit is changed either way', async () => {
  const host = await partner()
  try {
    const done = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, type: 'discoverer' }))
    await call(host, 'partner_report', { state: 'ready', summary: 'Wrote three options.' }, `superagent-wish-${done}`)
    const before = JSON.stringify(mediumOf(host).snapshot())
    await call(host, 'partner_list', {})
    await call(host, 'partner_list', { includeEnded: true })
    assert.equal(JSON.stringify(mediumOf(host).snapshot()), before)
    const description = host.callsTo('tools.register').find((call) => call.args.definition.name === 'partner_list').args.definition.description
    assert.doesNotMatch(description, /Ended units are listed too/)
    assert.match(description, /Ended units are left out unless/)
  } finally {
    await host.cleanup()
  }
})

test('the state meanings are written in the partner_list description', async () => {
  const host = await partner()
  try {
    const description = host.callsTo('tools.register')
      .find((call) => call.args.definition.name === 'partner_list').args.definition.description
    for (const [state, meaning] of Object.entries(partnerModule.STATE_MEANINGS)) {
      assert.ok(description.includes(`${state} — ${meaning}`), `the description defines ${state}`)
    }
  } finally {
    await host.cleanup()
  }
})
