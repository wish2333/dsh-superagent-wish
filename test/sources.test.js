// The two event sources, read through the plugin entry: the config block in the
// policy's `sources`, the Partner setup tool that writes it, and the Secretary's
// request-time rules. Every assertion is on a tool result, a Host call or a
// stored record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
