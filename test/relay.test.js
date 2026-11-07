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

/** Each host is one Partner Session of its own, as each test is one conversation. */
let conversations = 0

/**
 * A live Partner Agent: records what its inbox takes, the way the real one
 * does. `turn` holds the messages of the turn a test is running, which is what
 * the turn-end fallback adds to.
 */
function partnerAgent(base) {
  const delivered = []
  const take = (mode) => (message) => {
    const entry = { mode, message }
    delivered.push(entry)
    agent.turn?.push(entry)
  }
  const agent = {
    id: `partner-${conversations}`,
    session: { id: `partner-${conversations}`, header: { cwd: base } },
    status: 'idle',
    delivered,
    followup: take('followup'),
    steer: take('steer'),
    inject: take('inject'),
    cancel: (cause, options) => delivered.push({ mode: 'cancel', cause, options }),
  }
  return agent
}

/**
 * The manager, the Partner preset and both Worker presets on one fake Host, as
 * DSH mounts them; the Partner Session is open and its Agent takes messages.
 */
async function host() {
  conversations += 1
  const base = await mkdtemp(join(tmpdir(), 'superagent-wish-'))
  const services = ['agentPresets', 'systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory']
  openManager(createHost({ storageDomain: createStorageDomain(), services }).ctx)
  const fake = createHost({ storageDomain: createStorageDomain(), services, workingDirectory: base })
  partnerModule.apply(fake.ctx)
  discoverer.apply(fake.ctx)
  implementer.apply(fake.ctx)
  fake.partner = fake.setAgent(`partner-${conversations}`, partnerAgent(base))
  fake.partnerId = fake.partner.id
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
  return registration.args.definition.execute(args, { agent: { id: fake.partnerId }, callId: 'call-1', signal: undefined })
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

/** The `partner_list` record for `unitId`; ended units are asked for by name. */
async function listed(fake, unitId, { includeEnded = true } = {}) {
  const result = await call(fake, 'partner_list', { includeEnded })
  return result.record.units.find((unit) => unit.id === unitId)
}

/** Every `partner_report` registration, one per Worker preset, in mount order: discoverer first. */
function reports(fake) {
  const mounted = ['superagent-wish-discoverer', 'superagent-wish-implementer'].map((path) =>
    (path === 'superagent-wish-discoverer' ? discoverer : implementer))
  const registrations = fake.callsTo('tools.register')
    .filter((call) => call.args.definition.name === 'partner_report')
  assert.equal(registrations.length, mounted.length)
  return registrations.map((call) => call.args.definition)
}

/**
 * Calls `partner_report` as the unit's Worker Session does, through the
 * registration of the preset that unit's Worker runs.
 * @param type the worker type the unit has, which decides its preset
 */
async function report(fake, unitId, args, type = 'implementer') {
  const definitions = reports(fake)
  const definition = definitions[type === 'discoverer' ? 0 : definitions.length - 1]
  const result = await definition.execute(args, { agent: { id: `superagent-wish-${unitId}` }, callId: 'call-1', signal: undefined })
  assert.match(textOf(result), /^Recorded /, `the report was accepted: ${textOf(result)}`)
  return result
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

/**
 * Runs one Worker turn the way the loop does: the delivery on the dispatch
 * wakes the Worker, the test's `turn` is the Worker's work, and the turn's end
 * makes it idle.
 * @returns the messages the Partner Session took during the turn
 */
async function turn(fake, unitId, act, type = 'implementer') {
  const agent = worker(fake, unitId)
  // A fresh array: the fallback holds the one it writes into until it returns.
  fake.partner.turn = []
  const took = fake.partner.turn
  const before = fake.partner.delivered.length
  await fake.setStatus(agent, 'running')
  await act()
  await fake.setStatus(agent, 'idle')
  // The turn end is carried after the event returns, so the test lets the
  // listener's work finish before it reads what Partner took.
  await new Promise((resolve) => setImmediate(resolve))
  return took
}

test('a turn that ends without a report brings Partner a waiting report', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const took = await turn(fake, unitId, async () => {})
    assert.equal(took.length, 1)
    assert.equal(took[0].mode, 'steer')
    assert.deepEqual(took[0].message.source, { kind: 'agent-message', form: 'relay', senderSessionId: `superagent-wish-${unitId}` })
    const relayed = reportOf(took[0])
    assert.equal(relayed.kind, 'worker_report')
    assert.equal(relayed.unit_id, unitId)
    assert.equal(relayed.state, 'waiting')
    const unit = await listed(fake, unitId)
    assert.equal(unit.state, 'running', 'a waiting report changes no state')
    assert.equal(unit.lastReport.state, 'waiting')
  } finally {
    await fake.cleanup()
  }
})

test('the turn-end fallback listens on agent/status across preset scopes', async () => {
  const fake = await host()
  try {
    assert.ok(fake.ctx.storageDomain, 'the host has the store service')
    const statusListeners = fake.callsTo('on').filter((call) => call.args.name === 'agent/status')
    assert.ok(statusListeners.length >= 1, 'a preset listens on agent/status')
    assert.ok(statusListeners.every((call) => call.args.options?.global === true), 'every status listener asks for cross-scope delivery')
  } finally {
    await fake.cleanup()
  }
})

test('a turn that reported blocked gets no waiting on top of its report', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const took = await turn(fake, unitId, () => report(fake, unitId, { state: 'blocked', summary: 'The schema can be one table or four.' }))
    assert.deepEqual(took.map((delivery) => reportOf(delivery).state), ['blocked'])
    const unit = await listed(fake, unitId)
    assert.equal(unit.state, 'waiting-for-input')
    assert.equal(unit.lastReport.summary, 'The schema can be one table or four.')
  } finally {
    await fake.cleanup()
  }
})

test('a turn that only reported progress brings Partner the waiting report', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const took = await turn(fake, unitId, () => report(fake, unitId, { state: 'progress', summary: 'Half of the tables are written.' }))
    assert.deepEqual(took.map((delivery) => reportOf(delivery).state), ['waiting'])
    assert.equal((await listed(fake, unitId)).state, 'running')
  } finally {
    await fake.cleanup()
  }
})

test('a discoverer unit ends on its ready report, and the turn end adds nothing after it', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake, 'discoverer')
    const took = await turn(fake, unitId, () => report(fake, unitId, { state: 'ready', summary: 'Wrote three options to options.md.' }, 'discoverer'), 'discoverer')
    assert.deepEqual(took.map((delivery) => reportOf(delivery).state), ['ready'])
    const unit = await listed(fake, unitId)
    assert.equal(unit.state, 'ended')
    assert.equal(unit.lastReport.state, 'ready')
  } finally {
    await fake.cleanup()
  }
})

test('a turn end that comes twice is still one waiting report', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    const agent = worker(fake, unitId)
    // A fresh array: the fallback holds the one it writes into until it returns.
    fake.partner.turn = []
    const took = fake.partner.turn
    await fake.setStatus(agent, 'running')
    await fake.setStatus(agent, 'idle')
    await fake.setStatus(agent, 'running')
    await fake.setStatus(agent, 'idle')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(took.filter((delivery) => reportOf(delivery).state === 'waiting').length, 1)
  } finally {
    await fake.cleanup()
  }
})

test('a unit whose round has ended gets no waiting when its worker goes idle', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    await call(fake, 'partner_stop', { unitId, reason: 'wish changed direction' })
    const agent = worker(fake, unitId)
    const before = fake.partner.delivered.length
    await fake.setStatus(agent, 'running')
    await fake.setStatus(agent, 'idle')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fake.partner.delivered.length, before)
  } finally {
    await fake.cleanup()
  }
})

test('a discoverer ends on its ready report, and its follow-up opens a new unit', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake, 'discoverer')
    await report(fake, unitId, { state: 'ready', summary: 'Wrote three options to options.md.' }, 'discoverer')
    assert.equal((await listed(fake, unitId)).state, 'ended')
    // New work after an end is Partner's call: the ended unit takes no more input.
    const refused = textOf(await call(fake, 'partner_followup', { unitId, text: 'And a fourth option.' }))
    assert.match(refused, /has ended/)
    assert.equal((await listed(fake, unitId)).state, 'ended')
  } finally {
    await fake.cleanup()
  }
})

test('an implementer waits for the decision on its ready report, and a follow-up continues the same unit', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake, 'implementer')
    const workerId = `superagent-wish-${unitId}`
    await report(fake, unitId, { state: 'ready', summary: 'Delivered the tables under src/.' })
    assert.equal((await listed(fake, unitId)).state, 'waiting-for-decision')
    const accepted = textOf(await call(fake, 'partner_followup', { unitId, text: 'Make it tolerate holes.' }))
    assert.match(accepted, new RegExp(`Sent to ${unitId}`))
    const unit = await listed(fake, unitId)
    assert.equal(unit.state, 'running', 'the follow-up continues the unit instead of opening one')
    // The same Session and the same directory receive it.
    const delivered = worker(fake, unitId).delivered.at(-1)
    assert.equal(delivered.mode, 'followup')
    assert.equal(delivered.message.content[0].text, 'Make it tolerate holes.')
    assert.equal(worker(fake, unitId).id, workerId)
    // No second unit was opened.
    const all = (await call(fake, 'partner_list', {})).record.units
    assert.deepEqual(all.map((item) => item.id), [unitId])
  } finally {
    await fake.cleanup()
  }
})

test('a report is the only message Partner takes from a Worker session, and it says whose it is', async () => {
  const fake = await host()
  try {
    const unitId = await oneUnit(fake)
    await report(fake, unitId, { state: 'failed', summary: 'The tables need a migration this task did not allow.' })
    const fromWorker = fake.partner.delivered.filter((delivery) => delivery.message.source?.senderSessionId === `superagent-wish-${unitId}`)
    assert.equal(fromWorker.length, 1)
    assert.equal(fromWorker[0].message.source.kind, 'agent-message')
    assert.equal(fromWorker[0].message.source.form, 'relay')
    // Never as wish's own words, which is what a message without that source would read as.
    assert.notDeepEqual(fromWorker[0].message.source, { kind: 'user' })
  } finally {
    await fake.cleanup()
  }
})
