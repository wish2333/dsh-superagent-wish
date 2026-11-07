import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { apply, inject } from '../index.js'

test('declares the Host services it needs to load', () => {
  assert.deepEqual(inject, ['agentPresets', 'systemPrompt'])
})

test('the manager role registers the Partner preset', async () => {
  const host = createHost()
  apply(host.ctx, { role: 'manager' })
  await Promise.resolve()

  const [registration] = host.callsTo('agentPresets.register')
  assert.ok(registration, 'expected agentPresets.register to be called')
  assert.equal(registration.args.id, 'superagent-wish-recruiter')
  assert.equal(registration.args.name, 'Partner')
})

test('the instructions role adds the Partner prompt section', () => {
  const host = createHost()
  apply(host.ctx, { role: 'instructions' })

  const [section] = host.callsTo('systemPrompt.section')
  assert.ok(section, 'expected systemPrompt.section to be called')
  assert.equal(section.args.name, 'superagent-wish-role')
  assert.match(section.args.text, /Partner/)
})

test('the instructions role registers no preset and the manager role adds no prompt section', async () => {
  const host = createHost()
  apply(host.ctx, { role: 'instructions' })
  await Promise.resolve()
  assert.equal(host.callsTo('agentPresets.register').length, 0)

  const other = createHost()
  apply(other.ctx, { role: 'manager' })
  await Promise.resolve()
  assert.equal(other.callsTo('systemPrompt.section').length, 0)
})
