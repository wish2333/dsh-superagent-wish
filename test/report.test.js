import { test } from 'node:test'
import assert from 'node:assert/strict'
import { report } from '../report.js'

function reportCtx() {
  const recorded = []
  return {
    recorded,
    ctx: {
      session: { id: 'worker-1' },
      agents: { get: () => ({ session: {} }), turnBoundaryOf: () => ({ lastTurn: 3 }) },
      reportChannel: { record: (...args) => recorded.push(args) },
    },
  }
}

test('a worker report is recorded with its session, turn, state and summary', () => {
  const { ctx, recorded } = reportCtx()
  const result = report(ctx, { state: 'blocked', summary: 'scope is unclear' })
  assert.deepEqual(recorded, [['worker-1', 3, 'blocked', 'scope is unclear']])
  assert.match(result.content[0].text, /blocked/)
})

test('an unknown state is refused and records nothing', () => {
  const { ctx, recorded } = reportCtx()
  const result = report(ctx, { state: 'waiting', summary: 'nope' })
  assert.equal(result.isError, true)
  assert.deepEqual(recorded, [])
})

test('an empty summary is refused', () => {
  const { ctx, recorded } = reportCtx()
  const result = report(ctx, { state: 'ready', summary: '   ' })
  assert.equal(result.isError, true)
  assert.deepEqual(recorded, [])
})

test('the execution agent names the session when the context has none', () => {
  const { ctx, recorded } = reportCtx()
  ctx.session = undefined
  report(ctx, { state: 'ready', summary: 'done' }, { agent: { id: 'worker-2' } })
  assert.equal(recorded[0][0], 'worker-2')
})
