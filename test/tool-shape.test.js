import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DISPATCH_TOOL, REPORT_TOOL } from '../tools.js'

// DSH rejects a tool definition without this block, which marks the whole
// preset broken at load time. A fake Host accepts anything, so assert it here.
for (const [label, tool] of [['partner_dispatch', DISPATCH_TOOL], ['partner_report', REPORT_TOOL]]) {
  test(`${label} declares the output block DSH requires`, () => {
    assert.equal(typeof tool.output, 'object')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function')
  })

  test(`${label} renders its result as an array of text content blocks`, () => {
    const blocks = tool.output.render({}, { content: [{ type: 'text', text: 'hello' }] })
    assert.ok(Array.isArray(blocks))
    assert.ok(blocks.length > 0)
    for (const block of blocks) assert.equal(block.type, 'text')
    assert.equal(blocks[0].text, 'hello')
  })
}
