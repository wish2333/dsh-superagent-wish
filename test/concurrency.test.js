// Concurrency and the dispatch queue, read through the plugin entry: what the
// Worker Sessions were handed, what the store holds, and what a tool returned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as openManager } from '@wish2333/dsh-superagent-wish'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import { createHost, createStorageDomain } from './host-fake.js'
import { advance } from '../advance.js'

const PARTNER = 'partner-1'
const DISPATCH = { type: 'implementer', title: 'A job', body: 'Do the job.' }

/** The plugin entry with `implementerSlots` set through `apply(ctx, config)`. */
async function pluginWith(slots) {
  const host = await plugin({ config: { implementerSlots: slots } })
  return host
}

/** The Partner Agent, with an inbox that takes what a report relays to it. */
function partnerAgent(base) {
  const delivered = []
  const take = (mode) => (message) => { delivered.push({ mode, message }) }
  return {
    id: PARTNER,
    session: { id: PARTNER, header: { cwd: base } },
    status: 'idle',
    delivered,
    followup: take('followup'),
    steer: take('steer'),
    cancel: (cause, options) => delivered.push({ mode: 'cancel', cause, options }),
  }
}

/** The plugin entry over `medium`, with the Partner and implementer presets mounted. */
async function plugin(options = {}) {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'superagent-wish-')))
  const host = createHost({
    storageDomain: options.medium ?? createStorageDomain(),
    services: ['agentPresets', 'systemPrompt', 'tools', 'agents', 'workspaceRegistry', 'sessionController', 'permissionPresets', 'workingDirectory'],
    workingDirectory: base,
  })
  if (options.manager !== false) openManager(host.ctx, options.config)
  partnerModule.apply(host.ctx)
  implementer.apply(host.ctx)
  host.setAgent(PARTNER, partnerAgent(base))
  host.base = base
  host.cleanup = () => rm(base, { recursive: true, force: true })
  return host
}

/** Calls a tool as DSH does, from the Partner Session. */
async function call(host, name, args, agentId = PARTNER) {
  const registration = host.callsTo('tools.register').find((item) => item.args.definition.name === name)
  assert.ok(registration, `${name} is registered`)
  return registration.args.definition.execute(args, { agent: { id: agentId }, callId: 'call-1', signal: undefined })
}

/** The text of a tool result's single content block. */
function textOf(result) {
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  return result.content[0].text
}

/** The messages the worker Session `sessionId` has taken, if it is open. */
function texts(host, sessionId) {
  return host.ctx.agents.get(sessionId)?.delivered.map((item) => item.message.content[0].text) ?? []
}

/** The record of `unitId` in the store. */
function stored(host, unitId) {
  return host.storageDomain.contents('working_units')[unitId]
}

test('two implementers run at once and a third waits for a slot', async () => {
  const host = await plugin()
  try {
    const first = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' }))
    const second = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' }))
    // The default is two implementer slots: the third is queued, not refused.
    const third = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third' }))
    assert.match(third, /^unit-3$|queued/i, 'the third dispatch returns its unit id')

    assert.deepEqual(texts(host, `superagent-wish-${first}`), ['Do the job.'])
    assert.deepEqual(texts(host, `superagent-wish-${second}`), ['Do the job.'])
    // The third unit exists, and nothing reached its worker yet.
    assert.ok(stored(host, third))
    assert.deepEqual(texts(host, `superagent-wish-${third}`), [])
    assert.equal(stored(host, third).state, 'running', 'the unit is open, waiting to start')
  } finally {
    await host.cleanup()
  }
})

/** Reports `state` from the worker of `unitId`, as the Worker preset's tool does. */
async function report(host, unitId, state, summary = 'Done as asked.') {
  return call(host, 'partner_report', { state, summary }, `superagent-wish-${unitId}`)
}

test('a slot frees when the worker reports, and the queued unit starts then', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third' })
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), [], 'the third waits')

    await report(host, 'unit-1', 'ready')
    // The first report frees its slot, and the queued unit started at once.
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), ['Do the job.'])
    const created = host.callsTo('sessionController.create').map((item) => item.args.sessionId)
    assert.ok(created.includes('superagent-wish-unit-3'))
  } finally {
    await host.cleanup()
  }
})

/**
 * Runs one Worker turn the way the loop does: the delivery wakes the Worker,
 * `act` is the turn's work, and the turn's end makes it idle. Returns once the
 * turn-end listener has settled.
 * @param options `whenIdle`, which the listener asks the Agent for its status
 *   after this turn and after every later one
 * @returns nothing
 */
async function turn(host, unitId, act = async () => {}, { whenIdle } = {}) {
  const agent = host.ctx.agents.get(`superagent-wish-${unitId}`)
  assert.ok(agent, `unit ${unitId} has a worker session`)
  if (whenIdle) agent.whenIdle = whenIdle
  await host.setStatus(agent, 'running')
  await act()
  await host.setStatus(agent, 'idle')
}

test('a slot frees when a worker turn ends without a report, and the queued unit starts then', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third' })
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), [], 'the third waits')

    await turn(host, 'unit-1')
    // The silent turn is the round's end: its slot is free, so the third starts.
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), ['Do the job.'])
    assert.equal(stored(host, 'unit-1').state, 'running', 'the unit is open, still able to take input')
  } finally {
    await host.cleanup()
  }
})

test('a turn-end waiting report frees the slot a queued dispatch starts on', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third' })

    // A progress report is not work in progress: the turn ends without an end
    // report, and the `waiting` the turn end adds is the round's own ending.
    await turn(host, 'unit-1', () => report(host, 'unit-1', 'progress', 'Half of the work is done.'))
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), ['Do the job.'])
  } finally {
    await host.cleanup()
  }
})

test('a worker that ran on keeps its slot, and frees it at the turn end it then gets', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third' })

    // One idle event, and the Worker is already running the next turn: this
    // end is not the round's.
    await turn(host, 'unit-1', async () => {}, { whenIdle: async () => ({ status: 'running' }) })
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), [], 'the slot stays booked')

    // The turn that then ends with no report is the round's end, and frees it.
    host.ctx.agents.get('superagent-wish-unit-1').whenIdle = async () => ({ status: 'idle' })
    await turn(host, 'unit-1')
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), ['Do the job.'])
  } finally {
    await host.cleanup()
  }
})


test('the next queued unit starts when the queued one is stopped', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third' })
    await call(host, 'partner_stop', { unitId: 'unit-2' })
    assert.deepEqual(texts(host, 'superagent-wish-unit-3'), ['Do the job.'])
  } finally {
    await host.cleanup()
  }
})

test('discoverers never take a slot: three run while two implementers hold both', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    const discoverers = []
    for (const title of ['Explore one', 'Explore two', 'Explore three']) {
      discoverers.push(textOf(await call(host, 'partner_dispatch', { ...DISPATCH, type: 'discoverer', title })))
    }
    for (const id of discoverers) {
      assert.deepEqual(texts(host, `superagent-wish-${id}`), ['Do the job.'], `${id} started`)
    }
    // A third implementer still waits behind the two that hold the slots.
    const queued = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third implementer' }))
    assert.deepEqual(texts(host, `superagent-wish-${queued}`), [])
  } finally {
    await host.cleanup()
  }
})

test('a wish follow-up reaches a waiting unit while both implementer slots are full', async () => {
  const host = await plugin()
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    // Both slots are full, and the first Worker reported blocked: it waits for wish.
    await report(host, 'unit-1', 'blocked', 'Which schema?')
    const text = textOf(await call(host, 'partner_followup', { unitId: 'unit-1', text: 'Use four tables.' }))
    assert.match(text, /Sent to unit-1/)
    assert.deepEqual(texts(host, 'superagent-wish-unit-1').at(-1), 'Use four tables.')
  } finally {
    await host.cleanup()
  }
})

test('the same directory never runs two implementers at once', async () => {
  const host = await plugin()
  try {
    const first = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' }))
    assert.deepEqual(texts(host, `superagent-wish-${first}`), ['Do the job.'])

    // Two more units pointed at the first unit's directory, as a retry or a
    // hand-made record can: two workers writing the same files would overwrite
    // each other, so neither starts while the first holds the directory.
    const { store } = await partnerModule.handles(host.ctx)
    const shared = store.get(first).directory
    for (const id of [store.nextId(), store.nextId()]) {
      const next = store.nextId()
      await store.dispatch({
        id: next,
        type: 'implementer',
        title: `Shares ${id}`,
        text: 'Write into the same directory.',
        source: 'wish',
        partnerSessionId: PARTNER,
        workerSessionId: `superagent-wish-${next}`,
        directory: shared,
        scope: 'shared',
        strength: 'explicit',
        policyVersion: 'v',
        basis: 'wish',
      })
      await advance(host.ctx)
    }
    assert.equal(host.callsTo('workspaceRegistry.create').length, 1, 'no second worker opened in that directory')

    // Once the first reports and gives the directory up, one of them starts —
    // one, not both.
    await report(host, first, 'ready')
    const opened = host.callsTo('workspaceRegistry.create').length
    assert.equal(opened, 2, 'exactly one of the two waiting units started')
  } finally {
    await host.cleanup()
  }
})

test('the slot count is set through the plugin configuration', async () => {
  const host = await pluginWith(1)
  try {
    await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    const second = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' }))
    assert.deepEqual(texts(host, 'superagent-wish-unit-1'), ['Do the job.'], 'one slot: the first runs')
    assert.deepEqual(texts(host, `superagent-wish-${second}`), [], 'the second waits')

    // The free slot goes to the second unit on the first report.
    await report(host, 'unit-1', 'ready')
    assert.deepEqual(texts(host, `superagent-wish-${second}`), ['Do the job.'])
  } finally {
    await host.cleanup()
  }
})

test('a slot count outside the accepted range falls back to the default of two', async () => {
  for (const value of [0, -1, 99, 'many']) {
    const host = await pluginWith(value)
    try {
      await call(host, 'partner_dispatch', { ...DISPATCH, title: 'First' })
      await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
      const third = textOf(await call(host, 'partner_dispatch', { ...DISPATCH, title: 'Third' }))
      assert.deepEqual(texts(host, 'superagent-wish-unit-2'), ['Do the job.'], `${value}: two run`)
      assert.deepEqual(texts(host, `superagent-wish-${third}`), [], `${value}: the third waits`)
    } finally {
      await host.cleanup()
    }
  }
})

test('the dispatch queue survives a restart and starts when a slot frees', async () => {
  const medium = createStorageDomain()
  const before = await plugin({ medium })
  const base = before.base
  try {
    await call(before, 'partner_dispatch', { ...DISPATCH, title: 'First' })
    await call(before, 'partner_dispatch', { ...DISPATCH, title: 'Second' })
    const queuedId = textOf(await call(before, 'partner_dispatch', { ...DISPATCH, title: 'Third' }))
    assert.equal(queuedId, 'unit-3')
    assert.equal(before.ctx.agents.get('superagent-wish-unit-3'), undefined, 'the third never started')
    before.dispose()

    // The same plugin over what the first host stored, as a restart replays it.
    const after = await plugin({ medium: createStorageDomain(medium.snapshot()), base })
    try {
      // Both slots are taken by the units the store still records as running,
      // so the queued unit waits for one of them.
      assert.equal(after.ctx.agents.get('superagent-wish-unit-3'), undefined, 'still queued: both slots are held')
      await report(after, 'unit-1', 'ready')
      assert.deepEqual(texts(after, 'superagent-wish-unit-3'), ['Do the job.'], 'it starts once a slot frees')
    } finally {
      await after.cleanup()
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
