import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { report } from '../report.js'

function reportHost() {
  const host = createHost()
  const recorded = []
  host.ctx.recordReport = (state, summary) => recorded.push({ state, summary })
  return { host, recorded }
}

test('a worker report is recorded with its state and summary', () => {
  const { host, recorded } = reportHost()
  const result = report(host.ctx, { state: 'blocked', summary: 'scope is unclear' })
  assert.deepEqual(recorded, [{ state: 'blocked', summary: 'scope is unclear' }])
  assert.match(result.content[0].text, /blocked/)
})

test('an unknown state is refused and records nothing', () => {
  const { host, recorded } = reportHost()
  const result = report(host.ctx, { state: 'waiting', summary: 'nope' })
  assert.equal(result.isError, true)
  assert.deepEqual(recorded, [])
})

test('an empty summary is refused', () => {
  const { host, recorded } = reportHost()
  const result = report(host.ctx, { state: 'ready', summary: '   ' })
  assert.equal(result.isError, true)
  assert.deepEqual(recorded, [])
})
