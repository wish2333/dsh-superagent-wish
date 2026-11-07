import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { apply as mountPartner, dispatch } from '../partner.js'
import { getReportChannel } from '../channel-registry.js'
import { report } from '../report.js'

/** A Partner context and one dispatched worker session, wired through the real channel. */
async function dispatchedWorker() {
  const steered = []
  const host = createHost()
  host.ctx.session = { id: 'partner-session' }
  const liveAgents = new Map()
  host.ctx.sessionController.resolveAgent = async (sessionId) => {
    host.calls.push({ name: 'sessionController.resolveAgent', args: sessionId })
    const agent = liveAgents.get(sessionId)
    return agent ? { agent } : { error: { code: 'session/not-found' } }
  }
  host.ctx.sessionController.create = async (input) => {
    host.calls.push({ name: 'sessionController.create', args: input })
    liveAgents.set(input.sessionId, { id: input.sessionId, session: { id: input.sessionId }, followup: async () => {} })
  }
  host.ctx.agents.get = (id) => {
    host.calls.push({ name: 'agents.get', args: id })
    if (id === 'partner-session') return { steer: (message) => steered.push(message) }
    return { session: {} }
  }

  mountPartner(host.ctx)
  const registration = host.callsTo('tools.register')[0].args
  const result = await registration.definition.execute({ kind: 'discoverer', title: 'Explore options', body: '背景：...' }, { agent: { id: 'partner-session' } })
  assert.equal(result.isError, undefined)

  const workerSessionId = host.callsTo('sessionController.create')[0].args.sessionId
  // The channel is closed over by the Partner preset; the worker test reaches it
  // through the dispatch tool's report channel, which it shares by construction.
  const workerCtx = {
    session: { id: workerSessionId },
    agents: { get: () => ({ session: {} }), turnBoundaryOf: () => ({ lastTurn: 1 }) },
    reportChannel: getReportChannel(),
  }
  return { host, steered, workerSessionId, workerCtx }
}

test('a dispatched worker report reaches the Partner session as one steer message', async () => {
  const { steered, workerCtx } = await dispatchedWorker()
  report(workerCtx, { state: 'blocked', summary: 'scope is unclear' })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /blocked/)
  assert.match(steered[0].content[0].text, /scope is unclear/)
})

test('the worker is watched, so its idle turn without a final report reaches Partner', async () => {
  const { host, steered, workerSessionId } = await dispatchedWorker()
  await host.emit('agent/status', { agent: { id: workerSessionId }, status: 'idle' })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /waiting/)
})

test('a worker that reported ready produces no waiting report after idle', async () => {
  const { host, steered, workerSessionId, workerCtx } = await dispatchedWorker()
  report(workerCtx, { state: 'ready', summary: 'three options listed' })
  await host.emit('agent/status', { agent: { id: workerSessionId }, status: 'idle' })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /ready/)
})

test('an idle status for a session never dispatched reaches nobody', async () => {
  const { host, steered } = await dispatchedWorker()
  await host.emit('agent/status', { agent: { id: 'unrelated' }, status: 'idle' })
  assert.equal(steered.length, 0)
})
