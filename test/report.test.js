// The Worker presets are loaded through their package subpaths (ADR-0002), and
// `partner_report` is mounted by the module each one lists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as openManager } from '@wish2333/dsh-superagent-wish'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as discoverer from '@wish2333/dsh-superagent-wish/worker-discoverer'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import { createHost, createStorageDomain } from './host-fake.js'

const PARTNER = 'partner-1'

/** The Partner and one Worker preset mounted on one fake Host, as DSH loads them. */
async function host() {
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-'))
  const services = ['agentPresets', 'systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory']
  openManager(createHost({ storageDomain: createStorageDomain(), services }).ctx)
  const fake = createHost({ storageDomain: createStorageDomain(), services, workingDirectory: base })
  partnerModule.apply(fake.ctx)
  discoverer.apply(fake.ctx)
  implementer.apply(fake.ctx)
  fake.setAgent(PARTNER, { id: PARTNER, session: { id: PARTNER, header: { cwd: base } } })
  fake.cleanup = () => rm(base, { recursive: true, force: true })
  return fake
}

/** Every registration of the tool named `name`, one per preset that mounts it. */
function registrations(fake, name) {
  return fake
    .callsTo('tools.register')
    .filter((call) => call.args.definition.name === name)
    .map((call) => call.args.definition)
}

/** Calls the `partner_report` registration whose result the test reads. */
async function report(fake, args, agentId) {
  const [definition] = registrations(fake, 'partner_report')
  assert.ok(definition, 'a Worker preset registers partner_report')
  return definition.execute(args, { agent: { id: agentId }, callId: 'call-1', signal: undefined })
}

/** The single text block of a tool result. */
function textOf(result) {
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  return result.content[0].text
}

/** Opens one working unit through the Partner tool and returns its id. */
async function oneUnit(fake, type = 'implementer') {
  const registration = fake.callsTo('tools.register').find((call) => call.args.definition.name === 'partner_dispatch')
  const result = await registration.args.definition.execute(
    { type, title: 'Write the storage layer', body: 'Implement the tables under src/.' },
    { agent: { id: PARTNER }, callId: 'call-1', signal: undefined },
  )
  return textOf(result)
}

/** The `partner_list` record for `unitId`. */
async function listed(fake, unitId) {
  const registration = fake.callsTo('tools.register').find((call) => call.args.definition.name === 'partner_list')
  const result = await registration.args.definition.execute({ includeEnded: true }, { agent: { id: PARTNER }, callId: 'call-1', signal: undefined })
  return result.record.units.find((unit) => unit.id === unitId)
}

test('both Worker presets mount partner_report, and nothing else from the Partner tools', async () => {
  const fake = await host()
  try {
    assert.equal(registrations(fake, 'partner_report').length, 2)
    // One registration per Worker preset module, not one per call.
    const workerSections = fake.callsTo('systemPrompt.section').map((call) => call.args.name)
    assert.ok(workerSections.includes('superagent-wish-discoverer'))
    assert.ok(workerSections.includes('superagent-wish-implementer'))
  } finally {
    await fake.cleanup()
  }
})

test('a ready report from the unit\'s worker moves the unit to waiting for wish', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const text = textOf(await report(fake, { state: 'ready', summary: 'Delivered the tables under src/.' }, `superagent-wish-${unitId}`))
    assert.match(text, /Recorded ready/)
    const unit = await listed(fake, unitId)
    assert.equal(unit.state, 'waiting-for-decision')
    assert.deepEqual(unit.lastReport, { state: 'ready', summary: 'Delivered the tables under src/.' })
  } finally {
    await fake.cleanup()
  }
})

test('progress is recorded without changing the unit state', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    await report(fake, { state: 'progress', summary: 'Half of the tables are written.' }, `superagent-wish-${unitId}`)
    const unit = await listed(fake, unitId)
    assert.equal(unit.state, 'running')
    assert.equal(unit.lastReport.state, 'progress')
  } finally {
    await fake.cleanup()
  }
})

test('a blocked report moves an implementer to waiting for input', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    await report(fake, { state: 'blocked', summary: 'The schema can be one table or four; wish must decide.' }, `superagent-wish-${unitId}`)
    const unit = await listed(fake, unitId)
    assert.equal(unit.state, 'waiting-for-input')
  } finally {
    await fake.cleanup()
  }
})

test('a discoverer unit ends on its ready report, and a follow-up is refused afterwards', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake, 'discoverer')
    await report(fake, { state: 'ready', summary: 'Wrote three options to options.md.' }, `superagent-wish-${unitId}`)
    assert.equal((await listed(fake, unitId)).state, 'ended')
    const followup = fake.callsTo('tools.register').find((call) => call.args.definition.name === 'partner_followup')
    const result = await followup.args.definition.execute({ unitId, text: 'More options.' }, { agent: { id: PARTNER }, callId: 'c', signal: undefined })
    assert.match(textOf(result), /has ended/)
  } finally {
    await fake.cleanup()
  }
})

test('a report from a session that is no working unit\'s worker is refused in one sentence', async () => {
  const fake = await host()
  try {
    const text = textOf(await report(fake, { state: 'ready', summary: 'Done.' }, 'someone-else'))
    assert.match(text, /is not the worker of any working unit/)
    assert.doesNotMatch(text, /\n/)
  } finally {
    await fake.cleanup()
  }
})

test('a report for a unit that has ended says so instead of throwing', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake, 'discoverer')
    const worker = `superagent-wish-${unitId}`
    await report(fake, { state: 'ready', summary: 'Wrote three options.' }, worker)
    const text = textOf(await report(fake, { state: 'progress', summary: 'Still here.' }, worker))
    assert.match(text, /ended/)
  } finally {
    await fake.cleanup()
  }
})
