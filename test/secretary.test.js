// Loaded through the package subpath, so a wrong `exports` entry fails here (ADR-0002).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createStorageDomain } from './host-fake.js'
import * as secretary from '@wish2333/dsh-superagent-wish/secretary'
import { apply as applyManager } from '@wish2333/dsh-superagent-wish'

test('the Secretary preset adds one prompt section describing its job', async () => {
  const host = createHost({ services: secretary.inject ?? [] })
  secretary.apply(host.ctx)
  const sections = host.callsTo('systemPrompt.section').map((call) => call.args)
  assert.equal(sections.length, 1)
  const text = sections[0].text
  // The text is rendered per request, so the judging rules are the ones in force then.
  const rendered = typeof text === 'function' ? await text({ agent: null, scope: undefined }) : text
  // Its job: judge external events, read the conversation, speak only when wish must decide,
  // and keep its conclusions in the tables.
  for (const phrase of ['judge', 'read', 'speak only when wish must decide', 'table']) {
    assert.ok(rendered.includes(phrase), `the section must state "${phrase}"`)
  }
})

const PARTNER = 'superagent-wish-partner'
const SECRETARY = 'superagent-wish-secretary'

/** Applies the module and opens the Partner Session `partnerId` as DSH does on open. */
async function openPartner(partnerId = 'partner-1', options = {}) {
  // The Secretary's tools open the working-unit tables and read a Session, so a
  // Host that mounts them provides a storage domain and a Session controller.
  const services = [...new Set([...(secretary.inject ?? []), 'storageDomain'])]
  const host = createHost({ services, ...options })
  // The manager owns the listener that starts a Secretary: the Secretary module
  // is mounted only by its own preset, which does not exist before the first
  // Secretary does.
  applyManager(host.ctx)
  secretary.apply(host.ctx)
  host.setAgent(partnerId, { id: partnerId, session: { id: partnerId }, ctx: { agent: partnerId } })
  host.mounts = host.callsTo('tools.register').map((item) => item.args.definition)
  host.calls.length = 0
  // DSH creates the Session first and records the preset afterwards; that
  // selection event is what tells the manager this is a Partner conversation.
  await selectPreset(host, partnerId, options.preset ?? PARTNER)
  return host
}

/** Records `preset` on the Session and announces the selection, as the Host does. */
async function selectPreset(host, sessionId, preset) {
  const agent = host.ctx.agents.get(sessionId)
  host.setPreset(agent.session, preset)
  await host.emit('agent-preset/selected', sessionId, preset)
}

test('the Partner preset is taken from the selection event, after the Session exists', async () => {
  // The desktop app creates a Session and picks its preset afterwards. Nothing
  // at creation says which preset it will run, so `agent/created` cannot decide;
  // the selection event names the Session and the preset together.
  const host = createHost({ services: [...new Set([...(secretary.inject ?? []), 'storageDomain'])] })
  applyManager(host.ctx)
  secretary.apply(host.ctx)
  const agent = host.setAgent('partner-late', { id: 'partner-late', session: { id: 'partner-late' }, ctx: { agent: 'partner-late' } })
  await host.emit('agent/created', { agent, source: 'startup' })
  assert.deepEqual(host.callsTo('sessionController.create'), [], 'creation alone selects no preset, so no Secretary')

  await selectPreset(host, 'partner-late', PARTNER)
  const created = host.callsTo('sessionController.create').map((call) => call.args)
  assert.equal(created.length, 1, 'the selection creates the Secretary')
  assert.equal(created[0].agentPreset, SECRETARY)
  assert.equal(created[0].sessionId, 'partner-late-secretary')
})

test('a new Partner session gets one Secretary session', async () => {
  const host = await openPartner()
  const created = host.callsTo('sessionController.create').map((call) => call.args)
  assert.equal(created.length, 1)
  assert.equal(created[0].agentPreset, SECRETARY)
  assert.notEqual(created[0].sessionId, 'partner-1')
})

test('an ordinary session gets no Secretary', async () => {
  for (const preset of ['superagent-wish-discoverer', 'superagent-wish-implementer', 'standard']) {
    const host = createHost({ services: secretary.inject ?? [] })
    applyManager(host.ctx)
    secretary.apply(host.ctx)
    const agent = host.setAgent('ordinary-1', { id: 'ordinary-1', session: { id: 'ordinary-1' } })
    host.setPreset(agent.session, preset)
    await host.emit('agent-preset/selected', 'ordinary-1', preset)
    assert.deepEqual(host.callsTo('sessionController.create'), [], `preset ${preset} must create none`)
  }
})

test('an unreadable preset id creates no Secretary and does not fail creation', async () => {
  const host = createHost({ services: secretary.inject ?? [] })
  applyManager(host.ctx)
  secretary.apply(host.ctx)
  const agent = host.setAgent('unreadable-1', { id: 'unreadable-1', session: { id: 'unreadable-1' } })
  host.setPreset(agent.session, { unreadable: true })
  await host.emit('agent/created', { agent, source: 'startup' })
  assert.deepEqual(host.callsTo('sessionController.create'), [])
})

test('reopening an existing Partner session creates no second Secretary', async () => {
  const host = await openPartner()
  const agent = host.ctx.agents.get('partner-1')
  host.calls.length = 0
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    await host.emit('agent/created', { agent, source })
  }
  assert.deepEqual(host.callsTo('sessionController.create'), [])
})

test('the Secretary only reads the Partner conversation and never writes to it', async () => {
  const host = await openPartner()
  const asks = host.calls
    .filter((call) => call.name.startsWith('sessionController.') && call.name !== 'sessionController.create')
    .filter((call) => {
      const input = call.args
      const sessionId = input?.sessionId ?? input?.address?.sessionId
      return sessionId === 'partner-1'
    })
    .map((call) => call.name)
  const writes = asks.filter((name) =>
    ['sessionController.prompt', 'sessionController.updateQueue', 'sessionController.cancel', 'sessionController.rename'].includes(name),
  )
  assert.deepEqual(writes, [])
})

test('the Secretary sends no message to wish', async () => {
  const host = await openPartner()
  await host.emit('agent/created', { agent: host.ctx.agents.get('partner-1'), source: 'resume' })
  for (const name of ['sessionController.prompt', 'sessionController.updateQueue']) {
    assert.deepEqual(host.callsTo(name), [], name)
  }
})

// User story 27: the Secretary reads the current conversation, so its judgement
// is about what wish is doing now. It reads; it never writes to it.
// User story 27: the Secretary reads the current conversation, so its judgement
// is about what wish is doing now. It reads; it never writes to it.
test('the Secretary reads the recent messages of the Partner conversation through its own tool', async () => {
  const host = await openPartner()
  // The Partner Agent's Session records its events; the test controls that log.
  const turns = []
  host.ctx.agents.get('partner-1').session = { id: 'partner-1', snapshotEvents: () => turns }
  const say = (role, value) => turns.push({
    seq: turns.length,
    type: role === 'user' ? 'user/message' : 'assistant/message',
    data: role === 'user'
      ? { id: `m-${turns.length}`, role: 'user', content: [{ type: 'text', text: value }], source: { kind: 'user' } }
      : { message: { id: `a-${turns.length}`, role: 'assistant', content: [{ type: 'text', text: value }] } },
  })
  say('user', 'I am cleaning up the storage layer this week.')
  say('assistant', 'Then the inbox notes about it are worth a unit.')
  say('user', 'Only if they touch src/storage.')

  // The tool is mounted by the Secretary preset, under the name the Secretary's prompt gives.
  const read = host.mounts.find((definition) => definition.name === 'partner_read_conversation')
  assert.ok(read, `the Secretary mounts its read tool, not ${host.calls.map((item) => item.name).join(', ')}`)
  const said = host.calls.length
  const result = await read.execute({}, { agent: { id: 'partner-1-secretary' }, callId: 'c1', signal: undefined })
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  const text = result.content[0].text
  assert.ok(text.includes('wish: I am cleaning up the storage layer this week.'), text)
  assert.ok(text.includes('Partner: Then the inbox notes about it are worth a unit.'), text)
  assert.ok(text.includes('wish: Only if they touch src/storage.'), text)
  // Reading is all it does: no message, prompt, rename or cancel toward any Session.
  const written = host.calls.slice(said).map((item) => item.name).filter((name) => name !== 'sessionController.resolveAgent')
  assert.deepEqual(written, [])

  // Only the last messages are read when a limit is given.
  const last = await read.execute({ limit: 1 }, { agent: { id: 'partner-1-secretary' }, callId: 'c2', signal: undefined })
  assert.ok(last.content[0].text.includes('Only if they touch src/storage.'))
  assert.ok(!last.content[0].text.includes('I am cleaning up'))
})

test('the read tool says so when the conversation cannot be read, and never fails the call', async () => {
  const host = await openPartner()
  const read = host.mounts.find((definition) => definition.name === 'partner_read_conversation')
  assert.ok(read, 'the Secretary mounts its read tool')
  // The Partner Session is not open any more.
  host.removeSession('partner-1')
  const result = await read.execute({}, { agent: { id: 'partner-1-secretary' }, callId: 'c1', signal: undefined })
  assert.match(result.content[0].text, /could not be read/i)
  // A call from a Session that names no Partner conversation is refused in one sentence.
  const other = await read.execute({}, { agent: { id: 'someone-else' }, callId: 'c2', signal: undefined })
  assert.match(other.content[0].text, /not the secretary/i)
  assert.doesNotMatch(other.content[0].text, /\n/)
})

test('a Secretary that cannot be started does not fail the Partner session', async () => {
  const host = createHost({ services: secretary.inject ?? [] })
  secretary.apply(host.ctx)
  const agent = host.setAgent('partner-1', { id: 'partner-1', session: { id: 'partner-1' } })
  host.setPreset(agent.session, PARTNER)
  host.ctx.sessionController.resolveAgent = () => Promise.reject(new Error('persistence unavailable'))
  host.ctx.logger = { warn() {} }
  // `agent/created` is serial: a throw here would fail the Partner session itself.
  await assert.doesNotReject(() => host.emit('agent/created', { agent, source: 'startup' }))
})
