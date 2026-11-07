import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { apply, inject, PRESETS } from '../index.js'

const EXPECTED = [
  { id: 'superagent-wish-recruiter', name: 'Partner', subpath: 'partner' },
  { id: 'superagent-wish-discoverer', name: '启发者', subpath: 'worker-discoverer' },
  { id: 'superagent-wish-implementer', name: '执行者', subpath: 'worker-implementer' },
]

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
    const { subpath } = EXPECTED[index]
    assert.equal(definition.plugins.length, 1)
    assert.equal(definition.plugins[0].name, `@wish2333/dsh-superagent-wish/${subpath}`)
  }
})

test('works with no role config, as the bundle patch mounts it', async () => {
  const host = createHost()
  apply(host.ctx)
  await Promise.resolve()
  assert.equal(host.callsTo('agentPresets.register').length, 3)
})

test('the package exports every subpath a preset mounts', async () => {
  const { default: manifest } = await import('../package.json', { with: { type: 'json' } })
  for (const { subpath } of EXPECTED) {
    assert.ok(manifest.exports[`./${subpath}`], `package.json exports ./${subpath}`)
  }
})

test('only the Partner submodule declares the dispatch tool', async () => {
  const { DISPATCH_TOOL } = await import('../partner.js')
  assert.equal(DISPATCH_TOOL.name, 'partner_dispatch')
  for (const path of ['../worker-discoverer.js', '../worker-implementer.js']) {
    const module = await import(path)
    assert.equal(module.DISPATCH_TOOL, undefined, `${path} declares no dispatch tool`)
  }
})

test('a discoverer mounts a whitelist without write tools', async () => {
  const { apply: mount } = await import('../worker-discoverer.js')
  const host = createHost()
  mount(host.ctx)
  const [restriction] = host.callsTo('tools.restrict')
  assert.ok(restriction)
  const allow = restriction.args.allow
  for (const tool of ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'partner_report']) {
    assert.ok(allow.includes(tool), `discoverer allows ${tool}`)
  }
  for (const tool of ['write', 'edit', 'bash']) {
    assert.ok(!allow.includes(tool), `discoverer must not allow ${tool}`)
  }
})

test('an implementer mounts the same whitelist plus the write tools', async () => {
  const { apply: mount } = await import('../worker-implementer.js')
  const host = createHost()
  mount(host.ctx)
  const [restriction] = host.callsTo('tools.restrict')
  assert.ok(restriction)
  for (const tool of ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'partner_report', 'write', 'edit', 'bash']) {
    assert.ok(restriction.args.allow.includes(tool), `implementer allows ${tool}`)
  }
})

test('both worker prompts document the four report states', async () => {
  for (const path of ['../worker-discoverer.js', '../worker-implementer.js']) {
    const module = await import(path)
    const prompt = module.DISCOVERER_PROMPT ?? module.IMPLEMENTER_PROMPT
    for (const state of ['progress', 'ready', 'blocked', 'failed']) {
      assert.match(prompt, new RegExp(state), `${path} mentions ${state}`)
    }
    assert.match(prompt, /partner_report/)
  }
})

test('the Partner prompt names partner_dispatch and never a worker tool', async () => {
  const { ROLE_SECTION_TEXT } = await import('../partner.js')
  assert.match(ROLE_SECTION_TEXT, /Partner/)
  assert.doesNotMatch(ROLE_SECTION_TEXT, /partner_report/)
})

test('PRESETS exposes the three manifest rows the manager uses', () => {
  assert.equal(PRESETS.length, 3)
})
