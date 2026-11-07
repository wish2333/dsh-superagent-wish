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

test('the policy and the queue are reachable as subpaths', () => {
  assert.equal(manifest.exports['./policy'], './policy.js')
  assert.equal(manifest.exports['./queue'], './queue.js')
})
