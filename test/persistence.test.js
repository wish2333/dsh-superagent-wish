import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createStorageDomain } from './host-fake.js'
import { openWorkingUnits } from '../working-units.js'

const DISPATCH = {
  type: 'implementer',
  title: 'Write the storage layer',
  text: 'Implement the working unit tables',
  scope: 'src/',
  strength: 'explicit',
  policyVersion: 'policy-1',
}

/** Opens the store over a fresh fake medium, or over the records a previous store left. */
async function open(medium = createStorageDomain()) {
  const host = createHost()
  host.ctx.storageDomain = medium.service
  const store = await openWorkingUnits(host.ctx)
  return { store, host, medium }
}

test('a working unit is read back after the plugin reloads', async () => {
  const first = await open()
  const { id } = await first.store.dispatch(DISPATCH)
  await first.medium.opened.at(-1).close()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const unit = second.store.get(id)
  assert.equal(unit.title, DISPATCH.title)
  assert.equal(unit.state, 'running')
})

test('each table holds the record its relation belongs to', async () => {
  const { store, medium } = await open()
  const { id } = await store.dispatch(DISPATCH)
  assert.deepEqual(medium.writesOf('working_units').map((write) => write.key), [id])
  assert.deepEqual(medium.writesOf('mandates').map((write) => write.key), [id])
  assert.deepEqual(medium.writesOf('assignments').map((write) => write.key), [`${id}/assignment-0`])
})

test('the store closes the domain it opened when the plugin unloads', async () => {
  const { host, medium } = await open()
  assert.equal(medium.specs().length, 1)
  assert.deepEqual(Object.keys(medium.specs()[0].tables).sort(), ['assignments', 'inputs', 'mandates', 'working_units'])
  host.dispose()
  assert.equal(medium.closed, true)
})

test('a follow-up input survives a reload and is still queued', async () => {
  const first = await open()
  const { id } = await first.store.dispatch(DISPATCH)
  await first.store.followup(id, { text: 'Make it tolerate holes' })
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const unit = second.store.get(id)
  assert.deepEqual(unit.inputs.map((input) => input.text), [DISPATCH.text, 'Make it tolerate holes'])
  assert.deepEqual(unit.undelivered, unit.inputs.map((input) => input.id))
})

test('a report made before a reload is still the state read back', async () => {
  const first = await open()
  const { id } = await first.store.dispatch(DISPATCH)
  await first.store.report(id, { state: 'ready', summary: 'Delivered the storage layer' })
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  assert.equal(second.store.get(id).state, 'waiting-for-decision')
  assert.equal(second.store.get(id).assignments.at(-1).report.summary, 'Delivered the storage layer')
})

test('the authorization read back keeps its scope, strength and policy version', async () => {
  const first = await open()
  const { id } = await first.store.dispatch({ ...DISPATCH, scope: 'src/worker', strength: 'inferred', policyVersion: 'policy-9' })
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const { mandate } = second.store.get(id)
  assert.deepEqual({ scope: mandate.scope, strength: mandate.strength, policyVersion: mandate.policyVersion }, {
    scope: 'src/worker',
    strength: 'inferred',
    policyVersion: 'policy-9',
  })
})

test('a unit started after a reload gets an id no stored unit has', async () => {
  const first = await open()
  const { id } = await first.store.dispatch(DISPATCH)
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const next = await second.store.dispatch({ ...DISPATCH, title: 'Second unit' })
  assert.notEqual(next.id, id)
  assert.deepEqual(second.store.list().map((unit) => unit.title), [DISPATCH.title, 'Second unit'])
})

test('an id a stored unit still holds is not issued again', async () => {
  const first = await open()
  const { id: firstId } = await first.store.dispatch(DISPATCH)
  const { id: secondId } = await first.store.dispatch({ ...DISPATCH, title: 'Second unit' })
  await first.medium.opened.at(-1).table('working_units').delete(firstId)
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const next = await second.store.dispatch({ ...DISPATCH, title: 'Third unit' })
  assert.equal(secondId, 'unit-2')
  assert.equal(next.id, 'unit-3')
})
