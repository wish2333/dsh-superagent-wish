import { test } from 'node:test'
import assert from 'node:assert/strict'
import { begin, dispatch, followup, pushes, report } from '../state.js'

const UNIT = {
  id: 'unit-1',
  type: 'implementer',
  title: 'Write the storage layer',
  source: 'wish',
  sessionId: 'partner-1',
}

test('a started working unit runs its first assignment', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  assert.equal(unit.state, 'running')
  assert.equal(unit.assignments.length, 1)
  assert.equal(unit.assignments[0].state, 'pending')
})

test('a report moves the working unit to the state it describes', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const ready = report(unit, { state: 'ready', summary: 'Delivered the storage layer' })
  assert.equal(ready.state, 'waiting-for-decision')
  const blocked = report(unit, { state: 'blocked', summary: 'Needs the schema decided' })
  assert.equal(blocked.state, 'waiting-for-input')
})

test('a report leaves the ticket it was given unchanged', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  report(unit, { state: 'ready', summary: 'Delivered' })
  assert.equal(unit.state, 'running')
})

test('new input moves a working unit waiting for a decision back to running', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const waiting = report(unit, { state: 'ready', summary: 'Delivered the storage layer' })
  const followed = followup(waiting, { text: 'Make it tolerate holes in the directories' })
  assert.equal(followed.state, 'running')
})

test('input queues in order and keeps undelivered ids in that order', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const first = followup(unit, { text: 'First' })
  const second = followup(first, { text: 'Second' })
  assert.deepEqual(second.inputs.map((input) => input.text), ['First', 'Second'])
  assert.deepEqual(second.undelivered, second.inputs.map((input) => input.id))
})

test('a new input moves a working unit waiting for input back to running and starts an assignment', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const waiting = report(unit, { state: 'blocked', summary: 'Needs the schema decided' })
  const followed = followup(waiting, { text: 'Use one table per kind of record' })
  assert.equal(followed.state, 'running')
  assert.equal(followed.assignments.length, 2)
})

test('a discoverer unit ends on a ready report', () => {
  const unit = begin({ ...UNIT, type: 'discoverer' }, { scope: 'research/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const ready = report(unit, { state: 'ready', summary: 'Wrote three options' })
  assert.equal(ready.state, 'ended')
  assert.deepEqual({ by: ready.ended.by, outcome: ready.ended.outcome }, { by: 'executor', outcome: 'ready' })
})

test('a dropped report ends the working unit', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const dropped = report(unit, { state: 'dropped', summary: 'Nothing left to do' })
  assert.equal(dropped.state, 'ended')
  assert.equal(dropped.ended.outcome, 'dropped')
})

test('a stop ends the assignment and leaves the working unit waiting for input', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const stopped = dispatch(unit, { state: 'stop' })
  // A stop is not an end: the unit stays, and only its work for this round stops.
  assert.equal(stopped.state, 'waiting-for-input')
  assert.equal(stopped.ended, undefined)
  assert.equal(stopped.assignments[0].state, 'ended')
  assert.equal(stopped.assignments[0].endedReason, 'stopped')
})

test('input on an ended working unit is refused', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const ended = report(unit, { state: 'dropped', summary: 'Nothing left to do' })
  assert.throws(() => followup(ended, { text: 'One more thing' }), { code: 'workingUnit/ended' })
})

test('input never delivered is put back in front of the queue when its assignment ends', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const queued = followup(unit, { text: 'First' })
  const stopped = dispatch(queued, { state: 'stop' })
  assert.equal(stopped.state, 'waiting-for-input')
  assert.deepEqual(stopped.undelivered, queued.undelivered)
})

test('the authorization records the policy version it was created under', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'inferred', policyVersion: 'policy-7', basis: 'file' })
  assert.deepEqual(unit.mandate, { scope: 'src/', strength: 'inferred', policyVersion: 'policy-7', basis: 'file' })
})

test('delivery marks input delivered and leaves it unread until the worker reads it', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const queued = followup(unit, { text: 'First', at: '2026-01-01T00:00:01.000Z' })
  const [first] = queued.undelivered
  const started = dispatch(queued, { state: 'start', at: '2026-01-01T00:00:02.000Z' })
  const delivered = dispatch(started, { state: 'deliver', inputIds: [first], at: '2026-01-01T00:00:03.000Z' })
  assert.deepEqual(delivered.undelivered, [])
  assert.equal(delivered.inputs[0].deliveredTo, 'unit-1/assignment-0')
  assert.equal(delivered.inputs[0].readAt, null)
  const read = dispatch(delivered, { state: 'read', inputIds: [first], at: '2026-01-01T00:00:04.000Z' })
  assert.equal(read.inputs[0].readAt, '2026-01-01T00:00:04.000Z')
})

test('input delivered but not read goes back in front of the queue when its assignment stops', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const queued = followup(unit, { text: 'First' })
  const [first] = queued.undelivered
  const running = dispatch(queued, { state: 'start' })
  const delivered = dispatch(running, { state: 'deliver', inputIds: [first] })
  const second = followup(delivered, { text: 'Second' })
  const [rest] = second.undelivered
  const stopped = dispatch(second, { state: 'stop' })
  assert.deepEqual(stopped.undelivered, [first, rest])
})

test('a report says whether Partner hears about it', () => {
  assert.equal(pushes({ state: 'ready' }), true)
  assert.equal(pushes({ state: 'blocked' }), true)
  assert.equal(pushes({ state: 'failed' }), true)
  assert.equal(pushes({ state: 'progress' }), false)
  assert.equal(pushes({ state: 'waiting' }), false)
  assert.equal(pushes({ state: 'dropped' }), false)
})

test('a follow-up after a stop starts a new assignment instead of vanishing', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const stopped = dispatch(unit, { state: 'stop' })
  const followed = followup(stopped, { text: 'Take the other direction' })
  assert.equal(followed.state, 'running')
  assert.equal(followed.assignments.length, 2)
  assert.equal(followed.assignments[1].state, 'pending')
  assert.equal(followed.assignments[0].state, 'ended')
})

test('a report after a stop does not restart the stopped assignment', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const stopped = dispatch(unit, { state: 'stop' })
  // The cancelled turn still reports its last reading: it is recorded, and the
  // ended assignment stays ended, so nothing looks like work in progress.
  const reported = report(stopped, { state: 'progress', summary: 'Stopped mid-way' })
  assert.equal(reported.assignments[0].state, 'ended')
  assert.equal(reported.assignments[0].report.state, 'progress')
})

test('a waiting report does not replace the ready the worker reported', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const ready = report(unit, { state: 'ready', summary: 'Delivered the storage layer' })
  assert.equal(ready.state, 'waiting-for-decision')
  const waited = report(ready, { state: 'waiting', summary: 'The turn ended without a report.' })
  assert.equal(waited.assignments[0].report.state, 'ready')
  assert.equal(waited.assignments[0].report.summary, 'Delivered the storage layer')
})

test('a report records the session that sent it', () => {
  const unit = begin(UNIT, { scope: 'src/', strength: 'explicit', policyVersion: 'policy-1', basis: 'wish' })
  const reported = report(unit, { state: 'blocked', summary: 'Needs the schema decided', source: 'superagent-wish-unit-1' })
  assert.equal(reported.assignments[0].report.source, 'superagent-wish-unit-1')
})
