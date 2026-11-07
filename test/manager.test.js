import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { apply, PRESETS, presetRows } from '../index.js'

const EXPECTED = [
  { id: 'superagent-wish-partner', name: 'Partner', subpath: 'partner' },
  { id: 'superagent-wish-secretary', name: 'Secretary', subpath: 'secretary' },
  { id: 'superagent-wish-discoverer', name: '启发者', subpath: 'worker-discoverer' },
  { id: 'superagent-wish-implementer', name: '执行者', subpath: 'worker-implementer' },
]

test('the manager registers the four presets in order', async () => {
  const host = createHost()
  apply(host.ctx)
  const registrations = host.callsTo('agentPresets.register').map((call) => call.args)
  assert.deepEqual(
    registrations.map((definition) => ({ id: definition.id, name: definition.name })),
    EXPECTED.map(({ id, name }) => ({ id, name })),
  )
})

test('each preset mounts its own submodule first', () => {
  for (const [index, definition] of PRESETS.entries()) {
    const rows = presetRows(definition)
    assert.equal(rows[0].name, `@wish2333/dsh-superagent-wish/${EXPECTED[index].subpath}`)
  }
})

test('only the implementer preset mounts the shell', () => {
  const byId = Object.fromEntries(PRESETS.map((preset) => [preset.id, preset]))
  assert.ok(presetRows(byId['superagent-wish-implementer']).some((row) => row.name === '@deepseek-ai/dsh-tool-bash'))
  assert.ok(!presetRows(byId['superagent-wish-discoverer']).some((row) => row.name === '@deepseek-ai/dsh-tool-bash'))
})
