/**
 * Secretary preset: judges external events, and speaks only when wish must decide.
 *
 * Mounted by its own `plugins` row in `index.js` (ADR-0002), so the prompt below
 * reaches Secretary Sessions only. The Secretary session is created by this same
 * module: an `agent/created` listener starts one beside each new Partner session.
 *
 * Secrets of the role: the conclusions stay in the working-unit tables, and the
 * Partner conversation is read-only for this agent. The judging rules themselves
 * are added by the event sources (ticket 05); this module owns the role.
 */

export const inject = ['systemPrompt', 'agentPresets', 'sessionController']

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

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section(SECTION))
  ctx.on('agent/created', async ({ agent }) => {
    if (presetOf(ctx, agent) !== PARTNER_PRESET) return
    await ensureSecretary(ctx, agent)
  })
}
