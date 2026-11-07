import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './host-fake.js'
import { apply, PRESETS } from '../index.js'

test('the manager registers the three presets and nothing model-facing', async () => {
  const host = createHost()
  apply(host.ctx)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(host.callsTo('agentPresets.register').length, 3)
  assert.equal(host.callsTo('systemPrompt.section').length, 0)
  assert.equal(host.callsTo('tools.register').length, 0)
})

test('every preset row names a subpath this package exports', async () => {
  const { default: manifest } = await import('../package.json', { with: { type: 'json' } })
  for (const preset of PRESETS) {
    const specifier = `@wish2333/dsh-superagent-wish/${preset.subpath}`
    const subpath = `./${preset.subpath}`
    assert.ok(manifest.exports[subpath], `${specifier} is exported`)
    assert.ok(manifest.files.includes(manifest.exports[subpath].slice(2)), `${specifier} ships`)
  }
})

test('the Partner submodule adds the prompt section and the dispatch tool', async () => {
  const { apply: mount } = await import('../partner.js')
  const host = createHost()
  mount(host.ctx)

  const [section] = host.callsTo('systemPrompt.section')
  assert.equal(section.args.name, 'superagent-wish-role')
  assert.match(section.args.text, /Partner/)

  const [registration] = host.callsTo('tools.register')
  assert.equal(registration.args.definition.name, 'partner_dispatch')
})

test('a worker submodule adds its prompt section and the report tool only', async () => {
  for (const [path, name] of [
    ['../worker-discoverer.js', 'superagent-wish-discoverer'],
    ['../worker-implementer.js', 'superagent-wish-implementer'],
  ]) {
    const { apply: mount } = await import(path)
    const host = createHost()
    mount(host.ctx)

    const [section] = host.callsTo('systemPrompt.section')
    assert.equal(section.args.name, name)
    const [registration] = host.callsTo('tools.register')
    assert.equal(registration.args.definition.name, 'partner_report')
  }
})

// DSH's ToolRegistrationOptions carries only `when`. An `execute` passed there is
// silently dropped, and the tool then fails at call time with
// "tool.execute is not a function" — the fake host accepted anything, so assert
// the shape the real Host requires.
test('a tool carries execute on its definition, never in the registration options', async () => {
  for (const path of ['../partner.js', '../worker-discoverer.js', '../worker-implementer.js']) {
    const { apply: mount } = await import(path)
    const host = createHost()
    mount(host.ctx)

    const [registration] = host.callsTo('tools.register')
    assert.ok(registration, `${path} registers a tool`)
    assert.equal(typeof registration.args.definition.execute, 'function', `${path} puts execute on the definition`)
    assert.equal(registration.args.options?.execute, undefined, `${path} leaves execute out of the options`)
  }
})
