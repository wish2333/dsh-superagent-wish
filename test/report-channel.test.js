import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReportChannel, formatReport, WAITING_SUMMARY } from '../report-channel.js'

function channel() {
  const steered = []
  const partner = { steer: (message) => steered.push(message) }
  const reportChannel = createReportChannel({ getPartnerAgent: () => partner })
  reportChannel.configure({ partnerSessionId: 'partner-1', workerSessionId: 'worker-1' })
  return { reportChannel, steered }
}

const textOf = (message) => message.content[0].text

test('a blocked report reaches the partner session as one steer message', () => {
  const { reportChannel, steered } = channel()
  reportChannel.record('worker-1', 1, 'blocked', 'scope is unclear')
  assert.equal(steered.length, 1)
  assert.match(textOf(steered[0]), /blocked/)
  assert.match(textOf(steered[0]), /scope is unclear/)
})

test('ready and failed reports reach the partner session', () => {
  const { reportChannel, steered } = channel()
  reportChannel.record('worker-1', 1, 'ready', 'delivered')
  reportChannel.record('worker-1', 2, 'failed', 'no route')
  assert.equal(steered.length, 2)
})

test('a progress report does not wake the partner session', () => {
  const { reportChannel, steered } = channel()
  reportChannel.record('worker-1', 1, 'progress', 'halfway')
  assert.equal(steered.length, 0)
})

test('a worker turning idle without a final report gets a waiting report', () => {
  const { reportChannel, steered } = channel()
  reportChannel.record('worker-1', 1, 'progress', 'halfway')
  reportChannel.onStatus({ agent: { id: 'worker-1' }, status: 'idle' })
  assert.equal(steered.length, 1)
  assert.match(textOf(steered[0]), /waiting/)
  assert.match(textOf(steered[0]), new RegExp(WAITING_SUMMARY.slice(0, 20)))
})

test('a worker turning idle after a final report gets nothing extra', () => {
  const { reportChannel, steered } = channel()
  reportChannel.record('worker-1', 1, 'ready', 'done')
  reportChannel.onStatus({ agent: { id: 'worker-1' }, status: 'idle' })
  assert.equal(steered.length, 1)
})

test('the same report delivered twice reaches the partner session once', () => {
  const { reportChannel, steered } = channel()
  reportChannel.record('worker-1', 1, 'blocked', 'scope is unclear')
  reportChannel.record('worker-1', 1, 'blocked', 'scope is unclear')
  assert.equal(steered.length, 1)
})

test('an idle status for a session this plugin did not dispatch is ignored', () => {
  const { reportChannel, steered } = channel()
  reportChannel.onStatus({ agent: { id: 'someone-else' }, status: 'idle' })
  assert.equal(steered.length, 0)
})

test('a running status change never relays', () => {
  const { reportChannel, steered } = channel()
  reportChannel.onStatus({ agent: { id: 'worker-1' }, status: 'running' })
  assert.equal(steered.length, 0)
})

test('an unknown state is refused and relays nothing', () => {
  const { reportChannel, steered } = channel()
  assert.equal(reportChannel.record('worker-1', 1, 'done', 'x'), false)
  assert.equal(steered.length, 0)
})

test('the relayed text names the worker session, the state and the summary', () => {
  const text = formatReport('worker-9', 'ready', 'three files')
  assert.match(text, /worker-9/)
  assert.match(text, /reported ready/)
  assert.match(text, /three files/)
})

test('the relayed text names the task the worker was dispatched for', () => {
  const text = formatReport('w-1', 'blocked', 'needs a decision', { title: 'Explore macOS', kind: 'discoverer' })
  assert.match(text, /discoverer/)
  assert.match(text, /Explore macOS/)
  // Partner keeps the conclusion; the session holds the trace.
  assert.match(text, /Read session w-1 for the full trace/)
})

test('a dispatched worker report carries its task title', () => {
  const { reportChannel, steered } = channel()
  reportChannel.track('worker-1', { title: 'Explore macOS', kind: 'discoverer' })
  reportChannel.record('worker-1', 1, 'ready', 'done')
  assert.match(textOf(steered[0]), /Explore macOS/)
})

test('no partner agent means the report is dropped, not thrown', () => {
  const reportChannel = createReportChannel({ getPartnerAgent: () => undefined })
  reportChannel.configure({ partnerSessionId: 'partner-1', workerSessionId: 'worker-1' })
  assert.doesNotThrow(() => reportChannel.record('worker-1', 1, 'ready', 'done'))
})

test('a relayed report is a complete user message', () => {
  const { reportChannel, steered } = channel()
  reportChannel.record('worker-1', 1, 'blocked', 'scope is unclear')
  const message = steered[0]
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.deepEqual(message.source, { kind: 'user' })
})
