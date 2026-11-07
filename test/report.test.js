import { test } from 'node:test'
import assert from 'node:assert/strict'
import { report } from '../report.js'
import { setReportChannel, getReportChannel } from '../channel-registry.js'

function reportCtx() {
  const recorded = []
  // The worker tool reaches the channel through the shared module, not the context:
  // Cordis refuses a context property it did not inject.
  setReportChannel({ record: (...args) => recorded.push(args) })
  const ctx = {
    agents: { get: () => ({ session: {} }), turnBoundaryOf: () => ({ lastTurn: 3 }) },
  }
  return { recorded, ctx }
}

test('a worker report is recorded with its session, turn, state and summary', () => {
  const { ctx, recorded } = reportCtx()
  const result = report(ctx, { state: 'blocked', summary: 'scope is unclear' }, { agent: { id: 'worker-1' } })
  assert.deepEqual(recorded, [['worker-1', 3, 'blocked', 'scope is unclear']])
  assert.match(result.content[0].text, /blocked/)
})

test('an unknown state is refused and records nothing', () => {
  const { ctx, recorded } = reportCtx()
  const result = report(ctx, { state: 'waiting', summary: 'nope' }, { agent: { id: 'worker-1' } })
  assert.equal(result.isError, true)
  assert.deepEqual(recorded, [])
})

test('an empty summary is refused', () => {
  const { ctx, recorded } = reportCtx()
  const result = report(ctx, { state: 'ready', summary: '   ' }, { agent: { id: 'worker-1' } })
  assert.equal(result.isError, true)
  assert.deepEqual(recorded, [])
})

test('the execution agent names the session', () => {
  const { ctx, recorded } = reportCtx()
  report(ctx, { state: 'ready', summary: 'done' }, { agent: { id: 'worker-2' } })
  assert.equal(recorded[0][0], 'worker-2')
})

test('a report without an execution agent records nothing instead of throwing', () => {
  const { ctx, recorded } = reportCtx()
  assert.doesNotThrow(() => report(ctx, { state: 'ready', summary: 'done' }))
  assert.deepEqual(recorded, [])
})

test('the worker never reads the channel off the context', () => {
  const { ctx } = reportCtx()
  // A context property read Cordis did not inject throws; the channel must not be one.
  assert.equal(typeof getReportChannel().record, 'function')
  assert.equal(Object.hasOwn(ctx, 'reportChannel'), false)
})

test('clearing the channel makes reporting a silent no-op', () => {
  reportCtx()
  setReportChannel(undefined)
  assert.doesNotThrow(() => report({}, { state: 'ready', summary: 'done' }, { agent: { id: 'w' } }))
})
