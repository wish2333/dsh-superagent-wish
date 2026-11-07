import { advance } from './advance.js'
import { sharedStore } from './working-units.js'

/**
 * The part both Worker presets share: the `partner_report` tool and the report
 * state vocabulary.
 *
 * A Worker is a separate DSH Session that Partner dispatched. It reaches
 * Partner only through `partner_report`: the plugin records the report on the
 * working unit, and the relay that carries it to Partner is the host side's
 * (ticket 03), not this tool.
 */

export const inject = ['systemPrompt', 'tools']

/** The report states a Worker may carry, with what each one means for the unit. */
export const REPORT_STATES = {
  progress: 'still working; the unit keeps running, and Partner sees this only when it looks',
  ready: 'the result is there for wish to accept; an implementer unit waits for wish, a discoverer unit ends',
  blocked: 'a decision or a missing fact stops the work; the unit waits for an input to continue',
  failed: 'the work cannot be finished; the unit waits for an input to continue',
  dropped: 'nothing needs doing after all; the unit ends and wish is not disturbed',
}

export const REPORT_TOOL = {
  name: 'partner_report',
  description: [
    'Report to Partner on this working unit. Call it before a turn ends: Partner does not see a turn that ends without a report.',
    'State what is true now, not what you plan to do. Report blocked rather than deciding a product or scope question yourself.',
    `States: ${Object.entries(REPORT_STATES).map(([state, meaning]) => `${state} — ${meaning}`).join('; ')}.`,
    'The summary must be specific enough for wish to judge: what was produced, where it is, and what changed.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      state: {
        type: 'string',
        enum: Object.keys(REPORT_STATES),
        description: 'One of the states above.',
      },
      summary: {
        type: 'string',
        description: 'What was done and what is there now: files, findings or the exact decision the work waits on.',
      },
    },
    required: ['state', 'summary'],
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => (Array.isArray(value?.content)
      ? value.content
      : [{ type: 'text', text: String(value) }]),
  },
}

/** This Worker Session's working unit id, from `superagent-wish-<unit id>`. */
export const UNIT_SESSION = /^superagent-wish-(unit-\d+)$/

/**
 * The record a report writes. The store applies it to the unit the same way it
 * applies one the plugin found itself, so a Worker cannot set a state the unit
 * state machine would not take.
 *
 * @param ctx the Worker preset's context, which declares `storageDomain`
 * @param store the open working-unit tables
 * @param sessionId the calling Worker Session
 * @param args the report
 */
export async function record(ctx, store, sessionId, args) {
  const match = UNIT_SESSION.exec(String(sessionId ?? ''))
  const unit = match ? store.get(match[1]) : undefined
  if (!unit) {
    return refused(`${sessionId ?? 'this session'} is not the worker of any working unit.`)
  }
  if (unit.workerSessionId !== sessionId) {
    return refused(`${unit.id} runs in a different worker session, so its report does not count.`)
  }
  if (unit.state === 'ended') {
    return refused(`${unit.id} has ended; nothing more can be reported on it.`)
  }
  const state = String(args.state ?? '')
  const summary = String(args.summary ?? '').trim()
  if (!(state in REPORT_STATES)) return refused(`Unknown report state "${state}". Use ${Object.keys(REPORT_STATES).join(', ')}.`)
  if (!summary) return refused('A report needs a summary that says what was done or what the work waits on.')

  const updated = await store.report(unit.id, { state, summary, source: sessionId })
  return {
    content: [{
      type: 'text',
      text: `Recorded ${state} on ${unit.id}. The unit is now ${updated.state}.`,
    }],
    record: { unitId: unit.id, state, unitState: updated.state },
  }
}

/** One readable sentence for a refusal; the tool reports it as the result text. */
function refused(text) {
  return { content: [{ type: 'text', text }] }
}

/**
 * Mount `partner_report` for a Worker preset. The store opens in a child scope
 * that declares `storageDomain`: a Host without it leaves the tool absent rather
 * than failing the preset.
 * @param ctx the Worker preset's context
 * @param section the preset's own prompt section
 */
export function mountWorker(ctx, section, config) {
  ctx.effect(() => ctx.systemPrompt.section(section))
  ctx.inject(['storageDomain'], (storeCtx) => {
    // The store the manager and the Partner opened: a report is recorded where
    // every other scope reads it.
    const store = () => sharedStore(storeCtx)
    storeCtx.effect(() => ctx.tools.register({
      ...REPORT_TOOL,
      execute: async (args, exec) => {
        try {
          const result = await record(storeCtx, await store(), exec?.agent?.id, args ?? {})
          // A report may end the assignment and give a slot back; the queued
          // unit that can start now does, before this turn's answer returns.
          if (result.record) await advance(storeCtx)
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return refused(message.replace(/\s+/g, ' ').trim().replace(/\.$/, ''))
        }
      },
    }))
  })
}
