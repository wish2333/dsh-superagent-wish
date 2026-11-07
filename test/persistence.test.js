import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createStorageDomain } from './host-fake.js'
import { openWorkingUnits } from '../working-units.js'

// The dispatch's first input, and the authorization Partner gives it: a unit
// is authorized for the work it was told to do, not for its title.
const DISPATCH = {
  type: 'implementer',
  title: 'Write the storage layer',
  text: 'Implement the working unit tables',
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

/**
 * Starts one unit through the store: the id comes from the store, the Worker
 * Session and the directory from the caller, as the Partner tool passes them.
 */
function start(store, fields = {}) {
  const id = store.nextId()
  // The mandate a dispatch records is the one it was given: the scope is what
  // Partner authorized, and the first input does not widen it again.
  return store.dispatch({
    ...DISPATCH,
    scope: DISPATCH.text,
    ...fields,
    id,
    partnerSessionId: 'partner-1',
    workerSessionId: `superagent-wish-${id}`,
    directory: `/work/superagent-wish/${id}`,
  })
}

test('a working unit is read back after the plugin reloads', async () => {
  const first = await open()
  const { id } = await start(first.store)
  await first.medium.opened.at(-1).close()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const unit = second.store.get(id)
  assert.equal(unit.title, DISPATCH.title)
  assert.equal(unit.state, 'running')
})

test('each table holds the record its relation belongs to', async () => {
  const { store, medium } = await open()
  const { id } = await start(store)
  assert.equal(id, 'unit-1')
  assert.deepEqual(medium.writesOf('working_units').map((write) => write.key), [id])
  assert.deepEqual(medium.writesOf('mandates').map((write) => write.key), [id])
  assert.deepEqual(medium.writesOf('assignments').map((write) => write.key), [`${id}/assignment-0`])
})

test('the store closes the domain it opened when the plugin unloads', async () => {
  const { host, medium } = await open()
  assert.equal(medium.specs().length, 1)
  assert.deepEqual(Object.keys(medium.specs()[0].tables).sort(), ['assignments', 'inputs', 'mandates', 'source_events', 'working_units'])
  host.dispose()
  assert.equal(medium.closed, true)
})

test('a follow-up input survives a reload and is still queued', async () => {
  const first = await open()
  const { id } = await start(first.store)
  await first.store.followup(id, { text: 'Make it tolerate holes' })
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const unit = second.store.get(id)
  assert.deepEqual(unit.inputs.map((input) => input.text), [DISPATCH.text, 'Make it tolerate holes'])
  assert.deepEqual(unit.undelivered, unit.inputs.map((input) => input.id))
})

test('a report made before a reload is still the state read back', async () => {
  const first = await open()
  const { id } = await start(first.store)
  await first.store.report(id, { state: 'ready', summary: 'Delivered the storage layer' })
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  assert.equal(second.store.get(id).state, 'waiting-for-decision')
  assert.equal(second.store.get(id).assignments.at(-1).report.summary, 'Delivered the storage layer')
})

test('the authorization read back keeps its scope, strength and policy version', async () => {
  const first = await open()
  const { id } = await start(first.store, { scope: 'src/worker', strength: 'inferred', policyVersion: 'policy-9' })
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const { mandate } = second.store.get(id)
  assert.deepEqual(mandate, {
    scope: 'src/worker',
    strength: 'inferred',
    policyVersion: 'policy-9',
    basis: 'wish',
  })
})

test('a unit started after a reload gets an id no stored unit has', async () => {
  const first = await open()
  const { id } = await start(first.store)
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const next = await start(second.store, { title: 'Second unit' })
  assert.notEqual(next.id, id)
  assert.deepEqual(second.store.list().map((unit) => unit.title), [DISPATCH.title, 'Second unit'])
})

test('an id a stored unit still holds is not issued again', async () => {
  const first = await open()
  const { id: firstId } = await start(first.store)
  const { id: secondId } = await start(first.store, { title: 'Second unit' })
  await first.medium.opened.at(-1).table('working_units').delete(firstId)
  first.host.dispose()

  const second = await open(createStorageDomain(first.medium.snapshot()))
  const next = await start(second.store, { title: 'Third unit' })
  assert.equal(secondId, 'unit-2')
  assert.equal(next.id, 'unit-3')
})

test('an input delivered but not yet read is stored and read back', async () => {
  const first = await open()
  const { id } = await start(first.store)
  await first.store.start(id)
  const unit = first.store.get(id)
  await first.store.deliver(id, [unit.undelivered[0]])
  first.host.dispose()

  // A `readAt` of null means "delivered, not yet read": the stored record must
  // pass the schema the Host validates at open.
  const second = await open(createStorageDomain(first.medium.snapshot()))
  const reloaded = second.store.get(id)
  assert.equal(reloaded.inputs[0].readAt, null)
  assert.equal(reloaded.inputs[0].deliveredTo, `${id}/assignment-0`)
})
