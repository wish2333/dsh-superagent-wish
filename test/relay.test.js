// The report channel: what a Worker reports reaches Partner as one message with
// a Worker's own source. Tests go through the preset modules and the fake Host;
// they read the messages the Partner Session took and the tool results.
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

/** A live Partner Agent: records what its inbox takes, the way the real one does. */
function partnerAgent(base) {
  const delivered = []
  return {
    id: PARTNER,
    session: { id: PARTNER, header: { cwd: base } },
    status: 'idle',
    delivered,
    followup: (message) => delivered.push({ mode: 'followup', message }),
    steer: (message) => delivered.push({ mode: 'steer', message }),
    inject: (message) => delivered.push({ mode: 'inject', message }),
    cancel: (cause, options) => delivered.push({ mode: 'cancel', cause, options }),
  }
}

/**
 * The manager, the Partner preset and both Worker presets on one fake Host, as
 * DSH mounts them; the Partner Session is open and its Agent takes messages.
 */
async function host() {
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-'))
  const services = ['agentPresets', 'systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory']
  openManager(createHost({ storageDomain: createStorageDomain(), services }).ctx)
  const fake = createHost({ storageDomain: createStorageDomain(), services, workingDirectory: base })
  partnerModule.apply(fake.ctx)
  discoverer.apply(fake.ctx)
  implementer.apply(fake.ctx)
  fake.partner = fake.setAgent(PARTNER, partnerAgent(base))
  fake.cleanup = () => rm(base, { recursive: true, force: true })
  return fake
}

/** The message the Partner Session took last, which is a report only when it says so. */
function lastReport(fake) {
  const last = fake.partner.delivered.at(-1)
  assert.ok(last, 'the Partner Session took no message')
  return last
}

/** The report JSON inside a relay: its text block, parsed. */
function reportOf(delivery) {
  assert.deepEqual(delivery.message.content.map((block) => block.type), ['text'])
  return JSON.parse(delivery.message.content[0].text)
}

/** Calls a Partner tool as DSH does, from the Partner Session. */
async function call(fake, name, args) {
  const registration = fake.callsTo('tools.register').find((call) => call.args.definition.name === name)
  assert.ok(registration, `the Partner preset registers ${name}`)
  return registration.args.definition.execute(args, { agent: { id: PARTNER }, callId: 'call-1', signal: undefined })
}

/** The single text block of a tool result. */
function textOf(result) {
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  return result.content[0].text
}

/** Opens one working unit through the Partner tool and returns its id. */
async function oneUnit(fake, type = 'implementer') {
  return textOf(await call(fake, 'partner_dispatch', { type, title: 'Write the storage layer', body: 'Implement the tables under src/.' }))
}

/** The `partner_list` record for `unitId`. */
async function listed(fake, unitId) {
  const result = await call(fake, 'partner_list', {})
  return result.record.units.find((unit) => unit.id === unitId)
}

/** Every `partner_report` registration, one per Worker preset; both accept the same call. */
function reports(fake) {
  return fake.callsTo('tools.register')
    .filter((call) => call.args.definition.name === 'partner_report')
    .map((call) => call.args.definition)
}

/** Calls `partner_report` as the unit's Worker Session does. */
async function report(fake, unitId, args) {
  const [definition] = reports(fake)
  return definition.execute(args, { agent: { id: `superagent-wish-${unitId}` }, callId: 'call-1', signal: undefined })
}

/** The Worker Agent of `unitId`, as the fake Host opened it. */
function worker(fake, unitId) {
  const agent = fake.ctx.agents.get(`superagent-wish-${unitId}`)
  assert.ok(agent, `unit ${unitId} has a worker session`)
  return agent
}

test('a ready report reaches Partner as one relay from the Worker session', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    await report(fake, unitId, { state: 'ready', summary: 'Delivered the tables under src/.' })
    const delivery = lastReport(fake)
    assert.equal(delivery.mode, 'steer')
    assert.equal(delivery.message.role, 'user')
    assert.equal(typeof delivery.message.id, 'string')
    assert.deepEqual(delivery.message.source, { kind: 'agent-message', form: 'relay', senderSessionId: `superagent-wish-${unitId}` })
    const relayed = reportOf(delivery)
    assert.equal(relayed.kind, 'worker_report')
    assert.equal(relayed.unit_id, unitId)
    assert.equal(relayed.state, 'ready')
    assert.match(relayed.summary, /Delivered the tables under src\//)
  } finally {
    await fake.cleanup()
  }
})

test('ready, blocked and failed reports reach Partner, each as one message', async () => {
  const fake = await host()
  try {
    for (const state of ['ready', 'blocked', 'failed']) {
      const unitId = await oneUnit(fake)
      const before = fake.partner.delivered.length
      await report(fake, unitId, { state, summary: `A ${state} report.` })
      assert.equal(fake.partner.delivered.length, before + 1, `${state} reaches Partner`)
      assert.equal(reportOf(lastReport(fake)).state, state)
    }
  } finally {
    await fake.cleanup()
  }
})

test('a progress report stays out of the Partner inbox, and still moves nothing', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const before = fake.partner.delivered.length
    await report(fake, unitId, { state: 'progress', summary: 'Half of the tables are written.' })
    assert.equal(fake.partner.delivered.length, before)
    // Partner sees it only when it looks.
    assert.equal((await listed(fake, unitId)).lastReport.state, 'progress')
  } finally {
    await fake.cleanup()
  }
})

test('a dropped report ends the unit without a message to Partner', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const before = fake.partner.delivered.length
    const text = textOf(await report(fake, unitId, { state: 'dropped', summary: 'Nothing to do after all.' }))
    assert.match(text, /Recorded dropped/)
    assert.equal(fake.partner.delivered.length, before)
    assert.equal((await listed(fake, unitId)).state, 'ended')
  } finally {
    await fake.cleanup()
  }
})

test('a report that asks a question reaches Partner even when its state is not pushed', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const [definition] = reports(fake)
    const text = textOf(await definition.execute(
      { state: 'progress', summary: 'Two shapes fit; which one?', question: 'One table per kind, or one flat table?' },
      { agent: { id: `superagent-wish-${unitId}` }, callId: 'call-1', signal: undefined },
    ))
    assert.match(text, /Recorded progress/)
    assert.equal(fake.partner.delivered.length, 1, 'the question is the one message Partner takes')
    const relayed = reportOf(lastReport(fake))
    assert.equal(relayed.state, 'progress')
    assert.equal(relayed.question, 'One table per kind, or one flat table?')
  } finally {
    await fake.cleanup()
  }
})

test('a repeat of the same report reaches Partner once', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const before = fake.partner.delivered.length
    const args = { state: 'blocked', summary: 'The schema can be one table or four.' }
    await report(fake, unitId, args)
    await report(fake, unitId, args)
    assert.equal(fake.partner.delivered.length, before + 1)
  } finally {
    await fake.cleanup()
  }
})
