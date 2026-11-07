// Loaded through the package subpath, so a wrong `exports` entry fails here (ADR-0002).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import * as secretary from '@wish2333/dsh-superagent-wish/secretary'

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
  const host = createHost({ services: secretary.inject ?? [], ...options })
  secretary.apply(host.ctx)
  const agent = host.setAgent(partnerId, { id: partnerId, session: { id: partnerId } })
  host.setPreset(agent.session, PARTNER)
  host.calls.length = 0
  await host.emit('agent/created', { agent, source: 'startup' })
  return host
}

test('a new Partner session gets one Secretary session', async () => {
  const host = await openPartner()
  const created = host.callsTo('sessionController.create').map((call) => call.args)
  assert.equal(created.length, 1)
  assert.equal(created[0].agentPreset, SECRETARY)
  assert.notEqual(created[0].sessionId, 'partner-1')
})

test('an ordinary session gets no Secretary', async () => {
  for (const preset of ['superagent-wish-discoverer', 'superagent-wish-implementer', null]) {
    const host = createHost({ services: secretary.inject ?? [] })
    secretary.apply(host.ctx)
    const agent = host.setAgent('ordinary-1', { id: 'ordinary-1', session: { id: 'ordinary-1' } })
    if (preset) host.setPreset(agent.session, preset)
    await host.emit('agent/created', { agent, source: 'startup' })
    assert.deepEqual(host.callsTo('sessionController.create'), [], `preset ${preset} must create none`)
  }
})

test('an unreadable preset id creates no Secretary and does not fail creation', async () => {
  const host = createHost({ services: secretary.inject ?? [] })
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
