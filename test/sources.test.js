// The two event sources, read through the plugin entry: the config block in the
// policy's `sources`, the Partner setup tool that writes it, and the Secretary's
// request-time rules. Every assertion is on a tool result, a Host call or a
// stored record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as openManager } from '@wish2333/dsh-superagent-wish'
import * as partnerModule from '@wish2333/dsh-superagent-wish/partner'
import * as secretary from '@wish2333/dsh-superagent-wish/secretary'
import * as implementer from '@wish2333/dsh-superagent-wish/worker-implementer'
import { createHost, createStorageDomain } from './host-fake.js'

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
  partnerModule.apply(host.ctx)
  secretary.apply(host.ctx)
  implementer.apply(host.ctx)
  host.setAgent(PARTNER, { id: PARTNER, session: { id: PARTNER, header: { cwd: base } } })
  host.setAgent(SECRETARY_ID, { id: SECRETARY_ID, session: { id: SECRETARY_ID, header: { cwd: base } } })
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

/** The config block the policy holds for source `id`. */
function configOf(host, id) {
  return host.medium.contents('policy').current?.sources?.[id]
}

test('the settings tool saves the file source: its directories, file types and per-type default handling', async () => {
  const host = await plugin()
  try {
    const text = textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
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
      principalSessionId: PRINCIPAL,
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
      principalSessionId: PRINCIPAL,
      settings: { source: 'files', config: { enabled: true, directories: ['/inbox'], types: [] } },
    }))
    const before = JSON.stringify(configOf(host, 'files'))
    const text = textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
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

test('the settings tool saves the judging rules as rule text in the policy', async () => {
  const host = await plugin()
  try {
    textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
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
      principalSessionId: PRINCIPAL,
      settings: { rules: [{ id: 'inbox-notes', instruction: 'Open a working unit for a note placed in the inbox.' }] },
    }))
    assert.ok((await ask()).includes('Open a working unit for a note placed in the inbox.'))

    textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
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
      principalSessionId: PRINCIPAL,
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

/** A fake Host whose clock and timers the test drives, alongside the services. */
function fakeClock() {
  const timers = []
  return {
    timers,
    install(host) {
      host.ctx.schedule = {
        create(request, actorSessionId, signal) {
          host.calls.push({ name: 'schedule.create', args: { request, actorSessionId, signal } })
          return Promise.resolve({ id: `schedule-${timers.length}` })
        },
        edit(request) {
          host.calls.push({ name: 'schedule.edit', args: request })
          return Promise.resolve({})
        },
      }
      host.ctx.effect(() => () => {
        for (const timer of timers.splice(0)) clearInterval(timer)
      })
      return host
    },
  }
}

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
    const sources = await import('@wish2333/dsh-superagent-wish/sources')
    sources.apply(host.ctx)
    const inbox = join(host.base, 'inbox')
    textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    const path = await put(inbox, 'note.md', '# a note')
    const written = await sources.poll(host.ctx)
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
    const sources = await import('@wish2333/dsh-superagent-wish/sources')
    sources.apply(host.ctx)
    const inbox = join(host.base, 'inbox')
    textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    await put(inbox, 'note.md', '# a note')
    assert.equal((await sources.poll(host.ctx)).length, 1)
    assert.equal((await sources.poll(host.ctx)).length, 0, 'the second read records nothing')

    // A restart: a second Host over the same medium, its own file source.
    const rows = Object.keys(host.medium.contents('source_events'))
    const restarted = await plugin({ base: host.base, medium: createStorageDomain(host.medium.snapshot()) })
    try {
      const again = await import('@wish2333/dsh-superagent-wish/sources')
      again.apply(restarted.ctx)
      assert.equal((await again.poll(restarted.ctx)).length, 0, 'the file is known after the restart')
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
    const sources = await import('@wish2333/dsh-superagent-wish/sources')
    sources.apply(host.ctx)
    const inbox = join(host.base, 'inbox')
    textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
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
    const first = await sources.poll(host.ctx)
    assert.deepEqual(first.map((event) => [event.kind, event.status]).sort(), [['file', 'pending'], ['ignored', 'dropped']])
    const ignored = first.find((event) => event.kind === 'ignored')
    assert.match(ignored.reason, /ignores this file type/)

    // The note grows: same path, new identity.
    await writeFile(join(inbox, 'note.md'), '# a note, and more')
    const second = await sources.poll(host.ctx)
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
    const clock = fakeClock().install(host)
    const inbox = join(host.base, 'inbox')
    await put(inbox, 'note.md', '# a note')
    await put(inbox, 'other.txt', 'not a watched type')
    textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    textOf(await call(host, 'partner_setup', { principalSessionId: PRINCIPAL, settings: { source: 'schedule', config: { enabled: true, everySeconds: 300 } } }))

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
    assert.ok(clock)
  } finally {
    await host.cleanup()
  }
})

test('a patrol that observes nothing new writes no row, and a patrol that reports always writes one', async () => {
  const host = await plugin()
  try {
    fakeClock().install(host)
    const inbox = join(host.base, 'inbox')
    await put(inbox, 'note.md', '# a note')
    textOf(await call(host, 'partner_setup', {
      principalSessionId: PRINCIPAL,
      settings: { source: 'files', config: { enabled: true, directories: [inbox], types: [{ match: '.md', defaultHandling: 'open' }] } },
    }))
    textOf(await call(host, 'partner_setup', { principalSessionId: PRINCIPAL, settings: { source: 'schedule', config: { enabled: true, everySeconds: 300 } } }))
    textOf(await call(host, 'partner_patrol', {}, SECRETARY_ID))
    const unchanged = textOf(await call(host, 'partner_patrol', {}, SECRETARY_ID))
    assert.match(unchanged, /nothing changed/)
    assert.equal(Object.values(host.medium.contents('source_events')).filter((event) => event.kind === 'patrol').length, 1)

    textOf(await call(host, 'partner_setup', { principalSessionId: PRINCIPAL, settings: { source: 'schedule', config: { report: 'always' } } }))
    const recorded = textOf(await call(host, 'partner_patrol', {}, SECRETARY_ID))
    assert.match(recorded, /Patrol recorded at/)
    const patrols = () => Object.values(host.medium.contents('source_events')).filter((event) => event.kind === 'patrol')
    assert.equal(patrols().length, 2, 'the always report writes a row even when nothing changed')
  } finally {
    await host.cleanup()
  }
})
