import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { apply, inject, PRESETS, presetRows } from '../index.js'

const EXPECTED = [
  { id: 'superagent-wish-recruiter', name: 'Partner', subpath: 'partner' },
  { id: 'superagent-wish-discoverer', name: '启发者', subpath: 'worker-discoverer' },
  { id: 'superagent-wish-implementer', name: '执行者', subpath: 'worker-implementer' },
]

const FS = '@deepseek-ai/dsh-tool-fs'
const SEARCH = '@deepseek-ai/dsh-tool-fs-search'
const WEB = '@deepseek-ai/dsh-tool-web'
const TODO = '@deepseek-ai/dsh-tool-todo'
const BASH = '@deepseek-ai/dsh-tool-bash'

async function registered() {
  const host = createHost()
  apply(host.ctx)
  await Promise.resolve()
  await Promise.resolve()
  return host.callsTo('agentPresets.register').map((call) => call.args)
}

test('the manager declares only the preset registry', () => {
  assert.deepEqual(inject, ['agentPresets'])
})

test('registers the three presets with their ids, names and order', async () => {
  const definitions = await registered()
  assert.equal(definitions.length, 3)
  assert.deepEqual(
    definitions.map(({ id, name }) => ({ id, name })),
    EXPECTED.map(({ id, name }) => ({ id, name })),
  )
  const orders = definitions.map((definition) => definition.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
})

test('each preset mounts its own subpath of this package (ADR-0002)', async () => {
  const definitions = await registered()
  for (const [index, definition] of definitions.entries()) {
    assert.equal(definition.plugins[0].name, `@wish2333/dsh-superagent-wish/${EXPECTED[index].subpath}`)
  }
})

test('the package exports every subpath a preset mounts', async () => {
  const { default: manifest } = await import('../package.json', { with: { type: 'json' } })
  for (const { subpath } of EXPECTED) {
    assert.ok(manifest.exports[`./${subpath}`], `package.json exports ./${subpath}`)
    assert.ok(manifest.files.includes(manifest.exports[`./${subpath}`].slice(2)), `package.json ships ./${subpath}`)
  }
})

test('the discoverer mounts no shell and no write tool plugin (ADR-0003)', async () => {
  const definitions = await registered()
  const discoverer = definitions.find((definition) => definition.id === 'superagent-wish-discoverer')
  const mounted = discoverer.plugins.map((row) => row.name)

  for (const plugin of [FS, SEARCH, WEB, TODO]) assert.ok(mounted.includes(plugin), `mounts ${plugin}`)
  assert.ok(!mounted.includes(BASH), 'must not mount the shell')
})

test('the implementer mounts the discoverer tool set plus the shell', async () => {
  const definitions = await registered()
  const mounted = definitions
    .find((definition) => definition.id === 'superagent-wish-implementer')
    .plugins.map((row) => row.name)
  for (const plugin of [FS, SEARCH, WEB, TODO, BASH]) assert.ok(mounted.includes(plugin), `mounts ${plugin}`)
})

test('Partner mounts no Host tool plugin at all', async () => {
  const definitions = await registered()
  const partner = definitions.find((definition) => definition.id === 'superagent-wish-recruiter')
  assert.equal(partner.plugins.length, 1, 'only its own module')
})

test('no preset applies a tool restriction to an inherited set', async () => {
  const host = createHost()
  for (const path of ['../worker-discoverer.js', '../worker-implementer.js']) {
    const { apply: mount } = await import(path)
    mount(host.ctx)
  }
  assert.equal(host.callsTo('tools.restrict').length, 0)
})

test('presetRows puts the preset module first, then its tool plugins', () => {
  const preset = { subpath: 'worker-implementer', tools: [FS, BASH] }
  assert.deepEqual(presetRows(preset).map((row) => row.name), [
    '@wish2333/dsh-superagent-wish/worker-implementer',
    FS,
    BASH,
  ])
})

test('PRESETS exposes the three manifest rows the manager uses', () => {
  assert.equal(PRESETS.length, 3)
})
