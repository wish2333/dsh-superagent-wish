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

import { sharedPolicy } from './policy.js'
import { recordPatrol } from './sources.js'
import { sharedStore } from './working-units.js'

export const inject = ['systemPrompt', 'agentPresets', 'sessionController']

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
    'a working unit now. You read it; you do not write to it, and nothing you say enters the Partner history.',
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
  // A Host without the tables records no patrol; the tool is then absent rather than failing the preset.
  if (ctx.tools) {
    ctx.inject(['storageDomain'], (storeCtx) => {
      storeCtx.effect(() => ctx.tools.register({ ...PATROL_TOOL, execute: () => patrol(storeCtx) }))
    })
  }
  ctx.on('agent/created', async ({ agent }) => {
    if (presetOf(ctx, agent) !== PARTNER_PRESET) return
    await ensureSecretary(ctx, agent)
  })
}
