/**
 * Secretary preset: judges external events, and speaks only when wish must decide.
 *
 * Mounted by its own `plugins` row in `index.js` (ADR-0002), so the prompt below
 * reaches Secretary Sessions only. The Secretary session is created by this same
 * module: an `agent/created` listener starts one beside each new Partner session.
 *
 * Secrets of the role: the conclusions stay in the source event table, and the
 * Partner conversation is read-only for this agent.
 *
 * The judging rules are the policy's `rules`, and they are read on every request:
 * the section's text is a function, which the Host calls as it assembles the
 * prompt for each step. A rule saved through `partner_setup` therefore applies to
 * the next judgement on a running session, with no restart and no reload.
 */

import { decide, DECIDE_TOOL, principalOf } from './judge.js'
import { sharedPolicy } from './policy.js'
import { recordPatrol } from './sources.js'
import { sharedStore } from './working-units.js'

export const inject = ['systemPrompt', 'tools', 'agentPresets', 'sessionController']

/**
 * The one tool the Secretary calls: a patrol.
 *
 * The schedule source's task delivers its prompt to a Secretary conversation
 * every period, and the prompt asks for this call. The call records what the
 * patrol observed in the source event table and returns; it opens no working
 * unit and sends nothing to wish.
 */
export const PATROL_TOOL = {
  name: 'partner_patrol',
  description: [
    'Record one patrol of the watched directories. Call it when the scheduled patrol message arrives, then stop.',
    'It records what the directories hold in the source event table, where Partner and wish read it; it opens no working unit and says nothing to wish.',
    'It takes no arguments and has nothing to decide.',
  ].join(' '),
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => (Array.isArray(value?.content) ? value.content : [{ type: 'text', text: String(value) }]),
  },
}

/**
 * The one read the Secretary makes: the recent messages of the Partner
 * conversation it serves, as the talk that a judgement needs.
 *
 * The Partner Session is derived from the Secretary's own id by
 * {@link principalOf}, the way a judgement finds it, so no Session id is
 * named to anyone. The read folds the Session's recorded events into messages;
 * nothing is appended, prompted or cancelled, and the Partner's history is
 * unchanged.
 */
export const READ_CONVERSATION_TOOL = {
  name: 'partner_read_conversation',
  description: [
    'Read the last messages of the Partner conversation you serve. Read-only: it writes nothing and says nothing to wish.',
    'Each line names who said it (wish or Partner) and gives the message text.',
    'Use it to judge whether an event is worth opening a working unit now. Call it once per judgement, with the number of messages you need.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', description: 'How many recent messages to read at most. Defaults to 20.' },
    },
    required: [],
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => (Array.isArray(value?.content) ? value.content : [{ type: 'text', text: String(value) }]),
  },
}

/** The most messages one read returns, so a long conversation is a page, not the history. */
export const READ_LIMIT = 100

/** The text blocks of one recorded message, joined. */
const textOf = (message) => (message?.content ?? [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text.trim())
  .filter(Boolean)
  .join('\n')

/** One line of a message: who said it, and its text. */
function messageLine(event) {
  if (event.type === 'user/message') {
    // A relayed report or a judgement is not talk; only wish's own words are.
    if (event.data?.source?.kind !== 'user') return undefined
    return { who: 'wish', text: textOf(event.data) }
  }
  if (event.type === 'assistant/message') return { who: 'Partner', text: textOf(event.data?.message) }
  return undefined
}

/**
 * The last `limit` messages of a Partner Session, oldest first.
 *
 * The Session's recorded events are folded into messages, so a forked or
 * re-seeded conversation reads what its log holds. Nothing is appended,
 * prompted or steered; a missing or unreadable Session is `undefined`.
 * @returns `{ messages, total }`, or `undefined` when the Session cannot be read
 */
async function recentMessages(controller, partnerId, limit) {
  let session
  try {
    const resolved = await controller.resolveAgent(partnerId)
    if ('error' in resolved) return undefined
    session = resolved.agent?.session
  } catch {
    return undefined
  }
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const messages = []
  for (const event of events) {
    const line = messageLine(event)
    if (line?.text) messages.push(line)
  }
  return { messages: messages.slice(-limit), total: messages.length }
}

/** One readable block of the conversation, or the reason it could not be read. */
function conversationText(partnerId, read) {
  if (!read) {
    return `The conversation ${partnerId} could not be read: its Session is not open. Judge by the event and the rules only, and say nothing about this to wish.`
  }
  if (!read.messages.length) return `The conversation ${partnerId} holds no message yet.`
  const shown = read.messages.length < read.total ? `the last ${read.messages.length} of ${read.total}` : `all ${read.total}`
  return [`The conversation ${partnerId}, ${shown} message(s), oldest first:`, ...read.messages.map((line) => `${line.who}: ${line.text}`)].join('\n')
}

/**
 * `partner_read_conversation`: one read of the Partner conversation.
 *
 * The Partner Session is the one this Secretary serves, derived from the
 * calling Session the way every judgement is; a call from another Session is
 * refused in one sentence.
 */
export async function readConversation(ctx, args, exec) {
  const partnerId = principalOf(exec)
  if (!partnerId) return { content: [{ type: 'text', text: 'Read refused: this call is not the secretary of any Partner conversation.' }] }
  const wanted = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 20
  const limit = Math.min(wanted, READ_LIMIT)
  const read = await recentMessages(ctx.sessionController, partnerId, limit)
  return { content: [{ type: 'text', text: conversationText(partnerId, read) }] }
}

/** Preset id of the Partner, whose new sessions get a Secretary. */
export const PARTNER_PRESET = 'superagent-wish-partner'

/** Preset id of this module, recorded on the Secretary session it creates. */
export const SECRETARY_PRESET = 'superagent-wish-secretary'

export const SECTION = {
  name: 'superagent-wish-secretary',
  order: 900,
  text: [
    'You are the Secretary of this personal agent setup. You judge external events.',
    '',
    '## What you judge',
    '',
    'A file placed in a watched folder, or a scheduled event, arrives as an input. You decide whether it',
    'should become a working unit. You do not decide how the work is done, and you do not do it.',
    '',
    '## How you see the conversation',
    '',
    'You can read the current Partner conversation, for the judgement: whether this event is worth opening',
    'a working unit now. Call `partner_read_conversation` for the last messages, and ask for as many as the judgement needs.',
    'You read it; you do not write to it, and nothing you say enters the Partner history.',
    '',
    '## When you speak',
    '',
    'You speak only when wish must decide something. Every other judgement result goes into the working-unit',
    'tables: wish and Partner see it there when they look. You never speak to wish directly.',
    '',
    '## What you produce',
    '',
    'Your conclusions land in the tables, where Partner reads them. You do not change the state of a working',
    'unit; the code does that from your judgement.',
  ].join('\n'),
}

/**
 * The rule text the Secretary judges by, read from the policy now in force.
 *
 * Read from the Host's storage on every call, never kept: the rules are the
 * policy's, and a second Session may have saved new ones since the last request.
 *
 * @param ctx a context over the storage domain the policy is stored in
 * @returns `{ rules, section }`: the rules enabled now, and the prompt text for them
 */
export async function rulesNow(ctx) {
  const policy = await sharedPolicy(ctx)
  const rules = policy.current().rules.filter((rule) => rule.enabled !== false)
  if (!rules.length) {
    return {
      rules,
      section: [
        '## The judging rules',
        '',
        'No rule is set, so open no working unit from an external event: record each event as dropped, with "no rule is set" as the reason. Wish sets the rules with partner_setup.',
      ].join('\n'),
    }
  }
  return {
    rules,
    section: [
      '## The judging rules',
      '',
      'These are the rules set for judging external events. They are not current when this prompt was built: they were read for this request, and they hold now.',
      '',
      ...rules.map((rule) => `### ${rule.name ?? rule.id} (${rule.id})\n\n${rule.instruction}`),
    ].join('\n'),
  }
}

/** @returns the preset id recorded for `agent`'s session, or `undefined` when unreadable. */
function presetOf(ctx, agent) {
  try {
    return ctx.agentPresets.presetForSession(agent.session) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the Secretary session `sessionId` already exists. An unreadable
 * answer counts as absent only after {@link ensureSecretary} fails to create.
 * @returns `true` when the Secretary is there
 */
async function exists(ctx, sessionId) {
  const resolution = await ctx.sessionController.resolveAgent(sessionId)
  return !('error' in resolution)
}

/** The Secretary session id that belongs to Partner session `partnerId`. */
export function secretaryIdFor(partnerId) {
  return `${partnerId}-secretary`
}

/**
 * Starts a Secretary session beside the Partner session `agent`. The id is
 * derived from the Partner id, so a reopened Partner finds the same Secretary
 * and no second one is created.
 *
 * A failure here is logged and contained: `agent/created` is a serial event,
 * so throwing would fail the Partner session that this Secretary serves.
 */
async function ensureSecretary(ctx, agent) {
  const sessionId = secretaryIdFor(agent.id)
  try {
    if (await exists(ctx, sessionId)) return
    const created = await ctx.sessionController.create({
      sessionId,
      cwd: agent.session.header?.cwd,
      agentPreset: SECRETARY_PRESET,
    })
    if (created?.agentPreset === undefined) {
      ctx.logger?.warn?.(`secretary: preset "${SECRETARY_PRESET}" did not resolve on session ${sessionId}`)
    }
  } catch (error) {
    ctx.logger?.warn?.(`secretary: could not start session ${sessionId} for Partner ${agent.id}: ${String(error)}`)
  }
}

/**
 * The prompt section of the Secretary: its role, then the rules as they stand
 * when the request is assembled.
 *
 * A rule that cannot be read is left out of the section rather than failing the
 * request; the Secretary then judges by the role alone and records that it had
 * no rule.
 */
export function sectionFor(ctx) {
  return {
    ...SECTION,
    text: async () => {
      let rules
      try {
        // A Host without the policy's medium has no rules to read; it says so rather than failing the request.
        if (!ctx.storageDomain) {
          return `${SECTION.text}\n\n## The judging rules\n\nThe rules could not be read on this Host, so open no working unit from an external event and record why.`
        }
        rules = await rulesNow(ctx)
      } catch (error) {
        ctx.logger?.warn?.(`secretary: the rules could not be read for this request: ${String(error)}`)
        return SECTION.text
      }
      return `${SECTION.text}\n\n${rules.section}`
    },
  }
}

/**
 * The tool a judgement is written with: one event, opened as a working unit or
 * dropped with the reason the rules give for it.
 */
export const DECIDE_DEFINITION = {
  name: DECIDE_TOOL,
  description: [
    'Record your judgement of one external event. Call it once for each event you were given, then stop.',
    'decision "open" starts a working unit whose source is this event, and the Worker does the work it asks for.',
    'decision "drop" opens nothing; the reason is kept with the event, where Partner and wish read it. Dropping is the normal answer: give the rule and the fact that made it not worth a unit.',
    'A dropped event is not a mistake of the judgement, so never say anything about it to wish.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      eventId: { type: 'string', description: 'The id of the event you are judging, exactly as the judgement message gave it.' },
      decision: { type: 'string', enum: ['open', 'drop'], description: 'Open a working unit for it, or drop it with the reason.' },
      reason: { type: 'string', description: 'For drop: which rule decided it and on what fact, in one sentence.' },
      type: {
        type: 'string',
        enum: ['discoverer', 'implementer'],
        description: 'For open: the worker type. Omit it to follow the type rule\'s default handling.',
      },
      title: { type: 'string', description: 'For open: the short name of the unit, in wish\'s words.' },
      body: { type: 'string', description: 'For open: what the Worker reads first, with the event and what the rule asks for.' },
    },
    required: ['eventId', 'decision'],
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => (Array.isArray(value?.content) ? value.content : [{ type: 'text', text: String(value) }]),
  },
}

/**
 * `partner_patrol`: record one patrol, or nothing when it repeats the last one.
 *
 * @param ctx the Secretary context, which declares `storageDomain` and `tools`
 * @returns the sentence the Secretary reads: a line per watched directory, or a note that nothing changed
 */
export async function patrol(ctx) {
  const [store, policy] = await Promise.all([sharedStore(ctx), sharedPolicy(ctx)])
  const current = policy.current()
  const recorded = await recordPatrol(ctx, store, current.sources.schedule, current.sources.files)
  const text = recorded
    ? `Patrol recorded at ${recorded.at}. ${recorded.text}`
    : 'Patrol recorded: nothing changed since the last one, so no new row was written.'
  return { content: [{ type: 'text', text }] }
}

export function apply(ctx) {
  const section = sectionFor(ctx)
  ctx.effect(() => ctx.systemPrompt.section(section))
  // A Host without the tables records no patrol and no judgement; the tools are then absent rather than failing the preset.
  if (ctx.tools) {
    ctx.inject(['storageDomain'], (storeCtx) => {
      storeCtx.effect(() => ctx.tools.register({ ...PATROL_TOOL, execute: () => patrol(storeCtx) }))
      // The conversation is read through the Session service, so the tool is
      // mounted only where the Host can resolve a Session.
      storeCtx.inject(['sessionController'], (readCtx) => storeCtx.effect(() => ctx.tools.register({
        ...READ_CONVERSATION_TOOL,
        execute: (args, exec) => readConversation(readCtx, args ?? {}, exec),
      })))
      storeCtx.inject(['sessionController', 'workspaceRegistry', 'permissionPresets', 'agents', 'workingDirectory'], (workerCtx) => {
        storeCtx.effect(() => workerCtx.tools.register({
          ...DECIDE_DEFINITION,
          execute: async (args, exec) => {
            try {
              const [store, policy] = await Promise.all([sharedStore(workerCtx), sharedPolicy(workerCtx)])
              return await decide(workerCtx, store, policy, args ?? {}, exec)
            } catch (error) {
              return { content: [{ type: 'text', text: String(error?.message ?? error) }] }
            }
          },
        }))
      })
    })
  }
  ctx.on('agent/created', async ({ agent }) => {
    if (presetOf(ctx, agent) !== PARTNER_PRESET) return
    await ensureSecretary(ctx, agent)
  })
}
