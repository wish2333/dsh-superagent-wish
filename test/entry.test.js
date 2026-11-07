import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createStorageDomain } from './host-fake.js'
import { apply, inject, openStore } from '../index.js'

test('the plugin asks for the storage domain service', () => {
  assert.ok(inject.includes('storageDomain'))
})

test('apply opens the working unit tables on the plugin scope', async () => {
  const medium = createStorageDomain()
  const host = createHost({ storageDomain: medium })
  await openStore(host.ctx)
  const [spec] = medium.specs()
  assert.equal(spec.name, 'working_units')
  assert.deepEqual(Object.keys(spec.tables).sort(), ['assignments', 'inputs', 'mandates', 'source_events', 'working_units'])
})

test('the opened domain is closed when the plugin unloads', async () => {
  const medium = createStorageDomain()
  const host = createHost({ storageDomain: medium })
  await openStore(host.ctx)
  host.dispose()
  assert.equal(medium.closed, true)
})
