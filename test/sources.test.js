// The two event sources, read through the plugin entry: the config block in the
// policy's `sources`, the Partner setup tool that writes it, and the Secretary's
// request-time rules. Every assertion is on a tool result, a Host call or a
// stored record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as openManager, judgeNow } from '@wish2333/dsh-superagent-wish'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as secretary from '@wish2333/dsh-superagent-wish/secretary'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import * as sourcesModule from '@wish2333/dsh-superagent-wish/sources'
import { createHost, createStorageDomain } from './host-fake.js'

/** A live Agent as the fake Host hands one out: its inbox records what it takes. */
function liveAgent(id) {
  const delivered = []
  return {
    id,
    delivered,
    session: { id, header: {} },
    status: 'idle',
    followup: (message) => { delivered.push({ mode: 'followup', message }) },
    steer: (message) => { delivered.push({ mode: 'steer', message }) },
    cancel: () => {},
  }
}

/** How long a test waits for the manager's judgement pass, which runs on load. */
const JUDGE_WAIT_MS = 20

const PARTNER = 'partner-1'
const SECRETARY_ID = 'partner-1-secretary'
const PRINCIPAL = 'wish-principal-1'
const SERVICES = [
  'agentPresets',
  'systemPrompt',
  'tools',
  'agents',
  'workspaceRegistry',
  'sessionController',
  'permissionPresets',
  'workingDirectory',
]

/** The plugin entry mounted as DSH mounts it, with a working directory of its own. */
async function plugin(options = {}) {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'superagent-wish-')))
  const medium = options.medium ?? createStorageDomain()
  const host = createHost({ storageDomain: medium, services: SERVICES, workingDirectory: base })
  openManager(host.ctx)
  // The five preset rows, each mounting its own module: the manager opens the
  // tables, the file source reads them, the Secretary judges, Partner talks.
  host.sources = { read: sourcesModule.apply(host.ctx) }
  partnerModule.apply(host.ctx)
  secretary.apply(host.ctx)
  implementer.apply(host.ctx)

  // A live Agent, as the Host's controller hands one out: it records what its inbox takes.
  host.setAgent(SECRETARY_ID, liveAgent(SECRETARY_ID))
  host.setAgent(PARTNER, liveAgent(PARTNER))
  host.base = base
  host.medium = medium
  host.cleanup = () => rm(base, { recursive: true, force: true })
  return host
}

/** The definition of the tool named `name` mounted on `host`. */
function tool(host, name) {
  const registration = host.callsTo('tools.register').find((item) => item.args.definition.name === name)
  assert.ok(registration, `${name} is registered`)
  return registration.args.definition
}

/** Calls a tool as DSH does: the arguments and the calling Agent. */
async function call(host, name, args, agentId = PARTNER) {
  return tool(host, name).execute(args, { agent: { id: agentId }, callId: 'call-1', signal: undefined })
}

/** The single text block of a tool result. */
function textOf(result) {
  assert.deepEqual(result.content.map((block) => block.type), ['text'])
  return result.content[0].text
}

/**
 * Reads every watched directory now, as the next poll would, through the file
 * source the preset row mounted.
 * @returns the events this read recorded
 */
async function readNow(host) {
  const read = host.sources.read
  assert.ok(read, 'the file source is mounted')
  return read()
}

/** The config block the policy holds for source `id`. */
function configOf(host, id) {
  return host.medium.contents('policy').current?.sources?.[id]
}

test('the settings tool saves the file source: its directories, file types and per-type default handling', async () => {
  const host = await plugin()
  try {
    const text = textOf(await call(host, 'partner_setup', {

      settings: {
        source: 'files',
        config: {
          enabled: true,
          directories: ['/inbox', '/notes'],
          types: [
            { match: '.md', defaultHandling: 'open', note: 'Reading notes: explore, then report.' },
            { match: '.pdf', defaultHandling: 'ask', note: 'Ask wish before opening a PDF.' },
          ],
        },
      },
    }))
    assert.match(text, /files/)
    const config = configOf(host, 'files')
    assert.equal(config.enabled, true)
    assert.deepEqual(config.config.directories, ['/inbox', '/notes'])
    assert.equal(config.config.types.length, 2)
    assert.deepEqual(config.config.types[0], { match: '.md', defaultHandling: 'open', note: 'Reading notes: explore, then report.' })
  } finally {
    await host.cleanup()
  }
})

test('the settings tool saves the schedule source: its patrol period', async () => {
  const host = await plugin()
  try {
    textOf(await call(host, 'partner_setup', {

      settings: { source: 'schedule', config: { enabled: true, everySeconds: 300 } },
    }))
    assert.deepEqual(configOf(host, 'schedule'), { enabled: true, config: { everySeconds: 300, report: 'change' } })
  } finally {
    await host.cleanup()
  }
})

test('the settings tool refuses a configuration it cannot run, and keeps what was saved', async () => {
  const host = await plugin()
  try {
    textOf(await call(host, 'partner_setup', {

      settings: { source: 'files', config: { enabled: true, directories: ['/inbox'], types: [] } },
    }))
    const before = JSON.stringify(configOf(host, 'files'))
    const text = textOf(await call(host, 'partner_setup', {

      settings: {
        source: 'files',
        config: { enabled: true, directories: ['inbox'], types: [{ match: '.md', defaultHandling: 'ignore', note: '' }] },
      },
    }))
    assert.match(text, /absolute/)
    assert.equal(JSON.stringify(configOf(host, 'files')), before)
  } finally {
    await host.cleanup()
  }
})

// User story 5: Partner names a unit by its working unit id, so a settings call
// carries no Session id; the conversation it is made from is the one it serves.
test('a settings change takes its conversation from the call, not from a session id in the arguments', async () => {
  const host = await plugin()
  try {
    const text = textOf(await call(host, 'partner_setup', {
      settings: { rules: [{ id: 'inbox-notes', instruction: 'Open a working unit for a note placed in the inbox.' }] },
    }))
    assert.match(text, /Saved 1 rule/)
    const policy = host.medium.contents('policy').current
    assert.equal(policy.principal, PARTNER, 'the call\'s own conversation records the rules')
    // Reading a new event judges it for the Secretary of that conversation.
    const inbox = join(host.base, 'inbox')
    await put(inbox, 'note.md', '# a note')
    textOf(await call(host, 'partner_setup', {
      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    assert.equal((await readNow(host)).length, 1, 'the file source reads the new directory')
    const pending = Object.values(host.medium.contents('source_events')).filter((event) => event.status === 'pending')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].principal, PARTNER)
    const description = tool(host, 'partner_setup').description
    assert.doesNotMatch(description, /principalSessionId/)
    assert.deepEqual(tool(host, 'partner_setup').parameters.properties.principalSessionId, undefined)
  } finally {
    await host.cleanup()
  }
})

test('the settings tool saves the judging rules as rule text in the policy', async () => {
  const host = await plugin()
  try {
    textOf(await call(host, 'partner_setup', {

      settings: {
        rules: [{ id: 'inbox-notes', name: 'Inbox notes', instruction: 'Open a working unit for a note placed in the inbox.' }],
      },
    }))
    const policy = host.medium.contents('policy').current
    assert.deepEqual(policy.rules, [{
      id: 'inbox-notes',
      name: 'Inbox notes',
      enabled: true,
      instruction: 'Open a working unit for a note placed in the inbox.',
    }])
  } finally {
    await host.cleanup()
  }
})

test('the Secretary gets the rules at request time, so a saved rule reaches the next request without a restart', async () => {
  const host = await plugin()
  try {
    const sections = () => host.callsTo('systemPrompt.section').map((item) => item.args).filter((args) => args.name === secretary.SECTION.name)
    assert.equal(sections().length, 1)
    const ask = () => sections()[0].text({ agent: { id: SECRETARY_ID }, scope: undefined })
    assert.equal(typeof (await ask()), 'string')

    textOf(await call(host, 'partner_setup', {

      settings: { rules: [{ id: 'inbox-notes', instruction: 'Open a working unit for a note placed in the inbox.' }] },
    }))
    assert.ok((await ask()).includes('Open a working unit for a note placed in the inbox.'))

    textOf(await call(host, 'partner_setup', {

      settings: { rules: [{ id: 'inbox-notes', instruction: 'Judge an inbox note and open work only for a decision it requires.' }] },
    }))
    // The same mount, the next request: no reload, no restart.
    const next = await ask()
    assert.ok(next.includes('Judge an inbox note and open work only for a decision it requires.'))
    assert.ok(!next.includes('Open a working unit for a note placed in the inbox.'))
    assert.ok(next.includes('inbox-notes'))
  } finally {
    await host.cleanup()
  }
})

test('a disabled rule is left out of the Secretary\'s request', async () => {
  const host = await plugin()
  try {
    textOf(await call(host, 'partner_setup', {

      settings: {
        rules: [
          { id: 'inbox-notes', instruction: 'Open a working unit for a note placed in the inbox.' },
          { id: 'drafts', instruction: 'Never open a draft in an ignored type.' },
          { id: 'old', instruction: 'This rule is retired.', enabled: false },
        ],
      },
    }))
    const section = host.callsTo('systemPrompt.section').map((item) => item.args).find((args) => args.name === secretary.SECTION.name)
    const text = await section.text({ agent: { id: SECRETARY_ID }, scope: undefined })
    assert.ok(text.includes('Open a working unit for a note placed in the inbox.'))
    assert.ok(text.includes('Never open a draft in an ignored type.'))
    assert.ok(!text.includes('This rule is retired.'))
  } finally {
    await host.cleanup()
  }
})

test('with no rule set the Secretary reads that no rule is set, and judges by nothing else', async () => {
  const host = await plugin()
  try {
    const section = host.callsTo('systemPrompt.section').map((item) => item.args).find((args) => args.name === secretary.SECTION.name)
    const text = await section.text({ agent: { id: SECRETARY_ID }, scope: undefined })
    assert.match(text, /no rule is set/i)
  } finally {
    await host.cleanup()
  }
})

// --- the file source: intake -------------------------------------------------

/** Puts a file in `directory` and returns its path. */
async function put(directory, name, content) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, content)
  return path
}

test('a file put in a watched directory is recorded as an event the Secretary judges', async () => {
  const host = await plugin()
  try {
    // The file source is a preset row of its own, mounted beside the others.
    const inbox = join(host.base, 'inbox')
    textOf(await call(host, 'partner_setup', {

      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    const path = await put(inbox, 'note.md', '# a note')
    const written = await readNow(host)
    assert.equal(written.length, 1)
    const [event] = written
    assert.equal(event.source, 'files')
    assert.equal(event.kind, 'file')
    assert.equal(event.ref, path)
    assert.equal(event.status, 'pending')
    assert.equal(event.handling, 'open')
    // The row is on record for a Secretary that is not there yet, too.
    assert.deepEqual(Object.keys(host.medium.contents('source_events')), [event.id])
  } finally {
    await host.cleanup()
  }
})

test('a file already processed is not opened twice, after a restart either', async () => {
  const host = await plugin()
  try {
    const inbox = join(host.base, 'inbox')
    textOf(await call(host, 'partner_setup', {

      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    await put(inbox, 'note.md', '# a note')
    assert.equal((await readNow(host)).length, 1)
    assert.equal((await readNow(host)).length, 0, 'the second read records nothing')

    // A restart: a second Host over the same medium, its own file source.
    const rows = Object.keys(host.medium.contents('source_events'))
    const restarted = await plugin({ base: host.base, medium: createStorageDomain(host.medium.snapshot()) })
    try {
      assert.equal((await readNow(restarted)).length, 0, 'the file is known after the restart')
      assert.deepEqual(Object.keys(restarted.medium.contents('source_events')), rows)
    } finally {
      await restarted.cleanup()
    }
  } finally {
    await host.cleanup()
  }
})

test('a file that changed is a new event, and one of an ignored type is recorded as dropped', async () => {
  const host = await plugin()
  try {
    const inbox = join(host.base, 'inbox')
    textOf(await call(host, 'partner_setup', {

      settings: {
        source: 'files',
        config: {
          enabled: true,
          directories: [inbox],
          types: [{ match: '.md', defaultHandling: 'open' }, { match: '.tmp', defaultHandling: 'ignore' }],
        },
      },
    }))
    await put(inbox, 'note.md', '# a note')
    await put(inbox, 'draft.tmp', 'x')
    const first = await readNow(host)
    assert.deepEqual(first.map((event) => [event.kind, event.status]).sort(), [['file', 'pending'], ['ignored', 'dropped']])
    const ignored = first.find((event) => event.kind === 'ignored')
    assert.match(ignored.reason, /ignores this file type/)

    // The note grows: same path, new identity.
    await writeFile(join(inbox, 'note.md'), '# a note, and more')
    const second = await readNow(host)
    assert.equal(second.length, 1)
    assert.equal(second[0].ref, join(inbox, 'note.md'))
    assert.notEqual(second[0].id, first.find((event) => event.kind === 'file').id)
  } finally {
    await host.cleanup()
  }
})

test('the schedule source seats its patrol on a ctx.schedule task and records what it observes without waking a conversation', async () => {
  const host = await plugin()
  try {

    const inbox = join(host.base, 'inbox')
    await put(inbox, 'note.md', '# a note')
    await put(inbox, 'other.txt', 'not a watched type')
    textOf(await call(host, 'partner_setup', {

      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    textOf(await call(host, 'partner_setup', { settings: { source: 'schedule', config: { enabled: true, everySeconds: 300 } } }))

    const created = host.callsTo('schedule.create').map((call) => call.args.request)
    assert.equal(created.length, 1)
    assert.equal(created[0].timing.kind, 'every')
    assert.equal(created[0].timing.everySeconds, 300)
    assert.equal(typeof created[0].prompt, 'string')
    assert.ok(created[0].title)

    // The period arrives: the Secretary's conversation runs the patrol tool.
    const before = host.calls.filter((call) => ['sessionController.prompt', 'sessionController.updateQueue'].includes(call.name)).length
    const result = await call(host, 'partner_patrol', {}, SECRETARY_ID)
    const after = host.calls.filter((call) => ['sessionController.prompt', 'sessionController.updateQueue'].includes(call.name)).length
    assert.equal(after, before, 'the patrol sends nothing to a conversation')
    assert.match(textOf(result), /Patrol recorded/)
    const patrolled = Object.values(host.medium.contents('source_events')).filter((event) => event.kind === 'patrol')
    assert.equal(patrolled.length, 1)
    assert.equal(patrolled[0].source, 'schedule')
    assert.equal(patrolled[0].status, 'recorded')
    assert.match(patrolled[0].text, /2 file\(s\), 1 of a watched type/)
  } finally {
    await host.cleanup()
  }
})

test('a patrol that observes nothing new writes no row, and a patrol that reports always writes one', async () => {
  const host = await plugin()
  try {
    const inbox = join(host.base, 'inbox')
    await put(inbox, 'note.md', '# a note')
    textOf(await call(host, 'partner_setup', {

      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    textOf(await call(host, 'partner_setup', { settings: { source: 'schedule', config: { enabled: true, everySeconds: 300 } } }))
    textOf(await call(host, 'partner_patrol', {}, SECRETARY_ID))
    const unchanged = textOf(await call(host, 'partner_patrol', {}, SECRETARY_ID))
    assert.match(unchanged, /nothing changed/)
    assert.equal(Object.values(host.medium.contents('source_events')).filter((event) => event.kind === 'patrol').length, 1)

    textOf(await call(host, 'partner_setup', { settings: { source: 'schedule', config: { report: 'always' } } }))
    const recorded = textOf(await call(host, 'partner_patrol', {}, SECRETARY_ID))
    assert.match(recorded, /Patrol recorded at/)
    const patrols = () => Object.values(host.medium.contents('source_events')).filter((event) => event.kind === 'patrol')
    assert.equal(patrols().length, 2, 'the always report writes a row even when nothing changed')
  } finally {
    await host.cleanup()
  }
})

// --- the judgement -----------------------------------------------------------

/** Sets up the files source with one rule, and puts a note in the inbox. */
async function withNote(host, options = {}) {
  const inbox = join(host.base, 'inbox')
  await put(inbox, 'note.md', '# a note')
  // The setup is saved from the Partner conversation that is open, which is the one its Secretary serves.
  textOf(await call(host, 'partner_setup', {
    settings: {
      rules: [{ id: 'inbox-notes', instruction: 'Open a working unit for a note placed in the inbox.', ...(options.rule ?? {}) }],
    },
  }))
  textOf(await call(host, 'partner_setup', {
    settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
  }))
  const written = await readNow(host)
  // The manager hands the waiting events to the Secretary, as its loop does.
  const woken = await judgeNow(host.ctx)
  return { written, woken, inbox, principal: host.medium.contents('policy').current.principal }
}

test('a file event reaches the Secretary of the conversation that set the rules, with the rule text and the event', async () => {
  const host = await plugin()
  try {
    const { written, woken, principal } = await withNote(host)
    assert.equal(written.length, 1)
      // The Secretary of the recorded conversation is the one woken.
    const agent = host.ctx.agents.get(SECRETARY_ID)
    const sent = (agent?.delivered ?? []).filter((item) => item.mode === 'followup')
    assert.equal(sent.length, 1, 'the event wakes one judgement')
    assert.deepEqual(sent[0].message.source, { kind: 'agent-message', form: 'relay', senderSessionId: PARTNER })
    const payload = JSON.parse(sent[0].message.content[0].text)
    assert.equal(payload.kind, 'judgement')
    assert.equal(payload.event.id, written[0].id)
    assert.equal(payload.event.source, 'files')
    assert.ok(payload.event.text.includes('note.md'))
    assert.deepEqual(payload.rules.map((rule) => rule.id), ['inbox-notes'])
    assert.equal(payload.decide.tool, 'partner_decide', 'the judgement names the tool that decides it')
  } finally {
    await host.cleanup()
  }
})

test('an event that arrives while no conversation is open is recorded, and the next Secretary sees it', async () => {
  const host = await plugin()
  try {
    const inbox = join(host.base, 'inbox')
    // No Secretary exists: the conversation is not open.
    host.removeSession(SECRETARY_ID)
    textOf(await call(host, 'partner_setup', {

      settings: { rules: [{ id: 'inbox-notes', instruction: 'Open a working unit for a note placed in the inbox.' }] },
    }))
    textOf(await call(host, 'partner_setup', {

      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    await put(inbox, 'note.md', '# a note')
    await readNow(host)
    assert.equal(host.ctx.agents.get(SECRETARY_ID), undefined, 'no Secretary, so no judgement was sent')
    const pending = Object.values(host.medium.contents('source_events')).filter((event) => event.status === 'pending')
    assert.equal(pending.length, 1, 'the event is on record with no Secretary to judge it')

    // The next conversation opens a Secretary, and that one is handed the waiting event.
    const next = createHost({ storageDomain: createStorageDomain(host.medium.snapshot()), services: SERVICES, workingDirectory: host.base })
    // The conversation is open before the plugin loads, as a reopened Partner is.
    next.setAgent(SECRETARY_ID, liveAgent(SECRETARY_ID))
    // The manager loads last: its own judgement pass runs after the Secretary
    // exists, and hands the waiting event over.
    openManager(next.ctx)
    await new Promise((resolve) => setTimeout(resolve, JUDGE_WAIT_MS))
    // Once handed over, the event is decided once: no further pass repeats it.
    await judgeNow(next.ctx)
    // The Secretary's inbox took one message: the waiting event, judged once.
    const agent = next.ctx.agents.get(SECRETARY_ID)
    const sent = agent.delivered.filter((item) => item.mode === 'followup')
    assert.equal(sent.length, 1, 'the event reached the Secretary once')
    assert.equal(JSON.parse(sent[0].message.content[0].text).event.id, pending[0].id, 'and it is the waiting event')
    assert.equal(JSON.parse(sent[0].message.content[0].text).event.id, pending[0].id)
  } finally {
    await host.cleanup()
  }
})


// --- the decision -------------------------------------------------------------

/** The Partner tools mounted on `host`, for the Secretary to answer through. */
function resolve(host, name) {
  return host.callsTo('tools.register').map((item) => item.args.definition).find((definition) => definition.name === name)
}

test('a judgement that opens a working unit records the event as its source, and the unit runs under Partner\'s conversation', async () => {
  const host = await plugin()
  try {
    const { written } = await withNote(host)
    const text = textOf(await call(host, 'partner_decide', {
      eventId: written[0].id,
      decision: 'open',
      type: 'discoverer',
      title: 'Read the inbox note',
      body: 'Read the note and tell Partner what it asks for.',
    }, SECRETARY_ID))
    const unitId = /(unit-\d+)/.exec(text)?.[1]
    assert.ok(unitId, text)
    const unit = host.medium.contents('working_units')[unitId]
    assert.equal(unit.source, written[0].id, 'the source records which event opened it')
    assert.equal(unit.partnerSessionId, PARTNER, 'the unit belongs to the Partner conversation')
    assert.equal(unit.type, 'discoverer')
    // The row says the event opened it, and leaves the queue.
    const event = host.medium.contents('source_events')[written[0].id]
    assert.equal(event.status, 'opened')
    assert.equal(event.unitId, unitId)
    // A second decision on the same event is refused.
    assert.match(textOf(await call(host, 'partner_decide', { eventId: written[0].id, decision: 'drop', reason: 'again' }, SECRETARY_ID)), /already judged/)
  } finally {
    await host.cleanup()
  }
})

test('a judgement that drops an event keeps when it was dropped, which event, and why', async () => {
  const host = await plugin()
  try {
    const { written } = await withNote(host)
    const text = textOf(await call(host, 'partner_decide', {
      eventId: written[0].id,
      decision: 'drop',
      reason: 'Inbox notes rule: the note asks for nothing now.',
    }, SECRETARY_ID))
    assert.match(text, /dropped/)
    const event = host.medium.contents('source_events')[written[0].id]
    assert.equal(event.status, 'dropped')
    assert.equal(event.reason, 'Inbox notes rule: the note asks for nothing now.')
    assert.equal(typeof event.judgedAt, 'string')
    assert.equal(event.at, written[0].at)
    assert.equal(Object.keys(host.medium.contents('working_units')).length, 0, 'a dropped event opens no unit')
  } finally {
    await host.cleanup()
  }
})

test('a drop without its reason is refused and the event keeps waiting', async () => {
  const host = await plugin()
  try {
    const { written } = await withNote(host)
    const text = textOf(await call(host, 'partner_decide', { eventId: written[0].id, decision: 'drop' }, SECRETARY_ID))
    assert.match(text, /reason/)
    assert.equal(host.medium.contents('source_events')[written[0].id].status, 'pending')
  } finally {
    await host.cleanup()
  }
})

test('partner_list shows the dropped events to Partner, with when, which event and why', async () => {
  const host = await plugin()
  try {
    const { written } = await withNote(host)
    await call(host, 'partner_decide', { eventId: written[0].id, decision: 'drop', reason: 'Nothing to do with it yet.' }, SECRETARY_ID)
    const text = textOf(await call(host, 'partner_list', {}))
    assert.match(text, /Dropped external events:/)
    assert.ok(text.includes('note.md'), text)
    assert.ok(text.includes('Nothing to do with it yet.'))
    const definition = resolve(host, 'partner_list')
    assert.match(definition.description, /dropped/i)
    // The list of units is still read through the same tool: nothing was added to read the events.
    const names = host.callsTo('tools.register').map((item) => item.args.definition.name).sort()
    assert.deepEqual(names, ['partner_decide', 'partner_dispatch', 'partner_followup', 'partner_list', 'partner_patrol', 'partner_read_conversation', 'partner_report', 'partner_setup', 'partner_stop'])
  } finally {
    await host.cleanup()
  }
})

test('saving a new patrol period edits the one task, and turning the source off pauses it', async () => {
  const host = await plugin()
  try {
    textOf(await call(host, 'partner_setup', { settings: { source: 'schedule', config: { enabled: true, everySeconds: 300 } } }))
    const [task] = Object.values(host.tasks())
    assert.deepEqual(task.timing, { kind: 'every', everySeconds: 300 })
    assert.equal(task.status, 'active')
    assert.equal(host.callsTo('schedule.create').length, 1)

    textOf(await call(host, 'partner_setup', { settings: { source: 'schedule', config: { everySeconds: 600 } } }))
    assert.equal(host.callsTo('schedule.create').length, 1, 'no second task is opened')
    assert.deepEqual(host.tasks()[task.id].timing, { kind: 'every', everySeconds: 600 })

    textOf(await call(host, 'partner_setup', { settings: { source: 'schedule', enabled: false } }))
    assert.equal(host.tasks()[task.id].status, 'paused')
  } finally {
    await host.cleanup()
  }
})

test('a judgement message is not pushed to Partner as a report: nothing reaches wish', async () => {
  const host = await plugin()
  try {
    const { written } = await withNote(host)
    const partner = host.ctx.agents.get(PARTNER)
    assert.equal(partner.delivered.length, 0, 'judging wakes only the Secretary')
    assert.equal(written.length, 1)
    // The judgement went to the Secretary's inbox, and nowhere else.
    const secretary = host.ctx.agents.get(SECRETARY_ID)
    assert.equal(secretary.delivered.filter((item) => item.mode === 'followup').length, 1)
    assert.deepEqual([...host.ctx.agents.get(PARTNER).delivered], [])
  } finally {
    await host.cleanup()
  }
})
