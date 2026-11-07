import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The top-level modules this package ships, as the directory holds them. */
const modules = readdirSync(root).filter((name) => name.endsWith('.js'))

test('every top-level module ships, and every shipped module exists', () => {
  for (const name of modules) {
    assert.ok(manifest.files.includes(name), `files lists ${name}`)
  }
  for (const name of manifest.files.filter((file) => file.endsWith('.js'))) {
    assert.ok(modules.includes(name), `${name} is a module in the package root`)
  }
})

// ADR-0002: `exports` is the preset interface. A subpath a preset row mounts is
// there; an internal module a row never mounts is not, and nothing else may
// depend on it.
test('the subpaths are the ones the preset rows mount', async () => {
  const { PRESETS } = await import('@wish2333/dsh-superagent-wish')
  const mounted = PRESETS.map((preset) => `./${preset.subpath}`).sort()
  assert.deepEqual(Object.keys(manifest.exports).filter((key) => mounted.includes(key)).sort(), mounted)
  for (const key of ['./relay', './judge', './sessions', './policy', './queue']) {
    assert.equal(manifest.exports[key], undefined, `${key} is not a subpath`)
  }
  // Each mounted subpath resolves, which is what a preset row does at load.
  for (const subpath of mounted) await import(`@wish2333/dsh-superagent-wish/${subpath.slice(2)}`)
})

// The manager opens the working-unit tables as it loads, without a caller
// awaiting it: a Host with no storage medium still gets every preset.
test('a Host with no storage medium still registers every preset, and opens no table', async () => {
  const { createHost } = await import('./host-fake.js')
  const { apply, inject, PRESETS } = await import('@wish2333/dsh-superagent-wish')
  assert.ok(inject.includes('storageDomain'), 'the plugin asks for the storage domain where it can have one')
  const host = createHost({ missing: ['storageDomain'] })
  host.ctx.logger = { warn() {} }
  apply(host.ctx)
  assert.equal(host.callsTo('agentPresets.register').length, PRESETS.length)
  assert.deepEqual(host.callsTo('storageDomain.open'), [])
})
