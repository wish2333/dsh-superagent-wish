// Every tool this plugin registers is read through the package subpaths, the way
// a preset mounts it (ADR-0002).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as discoverer from '@wish2333/dsh-superagent-wish/worker-discoverer'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import * as worker from '@wish2333/dsh-superagent-wish/worker'
import { createHost, createStorageDomain } from './host-fake.js'

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/**
 * Every registration the four submodules make on a Host that has all their
 * services, labelled by the submodule that mounts it.
 */
function registrations() {
  const services = ['systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory']
  const all = []
  for (const [label, module] of [['partner', partnerModule], ['worker-discoverer', discoverer], ['worker-implementer', implementer]]) {
    const host = createHost({ storageDomain: createStorageDomain(), services })
    module.apply(host.ctx)
    for (const call of host.callsTo('tools.register')) all.push({ label, ...call.args.definition })
  }
  return all
}

const TOOLS = registrations()

/** The schema node itself and every node under it. */
function nodes(schema, path = 'schema', out = []) {
  out.push({ path, node: schema })
  if (schema.properties) for (const [name, child] of Object.entries(schema.properties)) nodes(child, `${path}.${name}`, out)
  if (schema.items) nodes(schema.items, `${path}.items`, out)
  if (schema.oneOf) for (const [index, child] of schema.oneOf.entries()) nodes(child, `${path}.oneOf[${index}]`, out)
  return out
}

// DSH rejects a registration without this block, and the preset then loads broken.
for (const definition of TOOLS) {
  test(`${definition.name} declares the output block DSH requires`, () => {
    assert.equal(typeof definition.output, 'object')
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
  })

  test(`${definition.name} renders a result as text content blocks only`, () => {
    for (const value of [
      { content: [{ type: 'text', text: 'hello' }] },
      { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
    ]) {
      const blocks = definition.output.render({}, value)
      assert.deepEqual(blocks, value.content)
    }
    assert.deepEqual(definition.output.render({}, 'plain'), [{ type: 'text', text: 'plain' }])
  })

  // ADR-0004: `parameters` goes to the provider as it is. A DSL author schema
  // there makes every request in the session fail with a 400.
  test(`${definition.name} declares parameters as the JSON Schema the provider takes`, () => {
    const { parameters } = definition
    assert.equal(parameters.type, 'object')
    assert.equal(parameters.additionalProperties, false)
    assert.equal(typeof parameters.properties, 'object')
    assert.ok(Array.isArray(parameters.required), 'required is an array of names')
    for (const name of parameters.required) {
      assert.ok(parameters.properties[name], `${name} is a declared property`)
    }
    for (const [name, property] of Object.entries(parameters.properties)) {
      assert.ok(SCHEMA_TYPES.includes(property.type), `${name} declares a supported type`)
      assert.equal(typeof property.description, 'string', `${name} says what it is`)
    }
    // Every node, at any depth, stays inside the subset DSH enforces: the author
    // DSL's `required: true` on a property node is not JSON Schema.
    for (const { path, node } of nodes(parameters)) {
      for (const key of Object.keys(node)) {
        assert.ok(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'oneOf'].includes(key), `${path}.${key} is a supported keyword`)
      }
      if ('required' in node) assert.ok(Array.isArray(node.required), `${path}.required is an array of names`)
      if (node.type === 'object' && node.properties) assert.equal(node.additionalProperties, false, `${path} closes its properties`)
      if (node.type === 'object' && Array.isArray(node.required)) {
        for (const name of node.required) assert.ok(node.properties?.[name], `${path}.${name} is declared`)
      }
    }
  })
}

test('the five tools are the ones the presets mount, and each preset gets its own', () => {
  const mounted = (label) => TOOLS.filter((definition) => definition.label === label).map((definition) => definition.name).sort()
  assert.deepEqual(mounted('partner'), ['partner_dispatch', 'partner_followup', 'partner_list', 'partner_stop'])
  assert.deepEqual(mounted('worker-discoverer'), ['partner_report'])
  assert.deepEqual(mounted('worker-implementer'), ['partner_report'])
})

test('partner_dispatch takes a type, a title, a body and an optional model', () => {
  const definition = TOOLS.find((tool) => tool.name === 'partner_dispatch')
  assert.deepEqual(definition.parameters.required, ['type', 'title', 'body'])
  assert.deepEqual(definition.parameters.properties.type.enum, ['discoverer', 'implementer'])
  const model = definition.parameters.properties.model
  assert.equal(model.type, 'object')
  assert.deepEqual(model.required, ['provider', 'model'])
})

test('partner_report takes a state and a summary, and lists the states in its description', () => {
  const definition = TOOLS.find((tool) => tool.name === 'partner_report')
  assert.deepEqual(definition.parameters.required, ['state', 'summary'])
  assert.deepEqual(definition.parameters.properties.state.enum, Object.keys(worker.REPORT_STATES))
  for (const state of Object.keys(worker.REPORT_STATES)) {
    assert.ok(definition.description.includes(`${state} — ${worker.REPORT_STATES[state]}`), `the description defines ${state}`)
  }
})

// Cordis refuses a read of an undeclared service, so the tools mount inside a
// child scope that declares what they read.
test('the Partner tools declare the worker services they read', () => {
  assert.deepEqual(partnerModule.WORKER_SERVICES, ['sessionController', 'workspaceRegistry', 'permissionPresets', 'agents', 'workingDirectory'])
  assert.deepEqual(partnerModule.STORE_SERVICES, ['storageDomain'])
})

// A missing service must cost the tool, not the preset: a Partner session still
// gets its prompt and any tool whose services are present.
test('a missing Host service leaves the Partner tools absent rather than failing the preset', async () => {
  for (const missing of ['sessionController', 'permissionPresets', 'storageDomain']) {
    const host = createHost({ missing: [missing], services: ['systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory'] })
    partnerModule.apply(host.ctx)
    assert.equal(host.callsTo('tools.register').length, 0, `no tool mounts without ${missing}`)
    assert.equal(host.callsTo('systemPrompt.section').length, 1, 'the Partner prompt still mounts')
    assert.equal(host.callsTo('inject.pending').length, 1)
  }
})

test('a missing storage domain leaves partner_report absent rather than failing the Worker preset', () => {
  for (const module of [discoverer, implementer]) {
    const host = createHost({ missing: ['storageDomain'], services: ['systemPrompt', 'tools'] })
    module.apply(host.ctx)
    assert.equal(host.callsTo('tools.register').length, 0)
    assert.equal(host.callsTo('systemPrompt.section').length, 1, 'the Worker prompt still mounts')
  }
})

// `tools.register` reads `execute` off the definition; one left in the options
// is dropped, and the tool then fails at call time.
test('every tool carries execute on its definition, never in the registration options', () => {
  const services = ['systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory']
  for (const module of [partnerModule, discoverer, implementer]) {
    const host = createHost({ storageDomain: createStorageDomain(), services })
    module.apply(host.ctx)
    for (const call of host.callsTo('tools.register')) {
      assert.equal(typeof call.args.definition.execute, 'function')
      assert.equal(call.args.options?.execute, undefined)
    }
  }
})
