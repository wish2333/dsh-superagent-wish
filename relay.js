/**
 * The report channel: the one place a report becomes a message to Partner.
 *
 * A Worker report is the only thing a Worker says to Partner, and it reaches
 * Partner as Partner's own inbox takes any message from another Session: one
 * user message whose source says `agent-message`, `form: 'relay'`, and the
 * Session that sent it. Partner therefore reads "a Worker reported this",
 * never "wish said this".
 *
 * Whether a report is relayed is decided here by `pushes` in `state.js`, not by
 * the Worker and not by Partner.
 */

import { pushes } from './state.js'

/**
 * Every report key already carried. The store keeps the report; this keeps the
 * fact that it was carried, so a report that arrives twice — a retried tool
 * call, or the executor repeating a turn's ending — is one message.
 */
const carried = new Set()

/** The relay idempotency key of a report: one report of the same unit, round, state and summary relays once. */
export function reportKey(unitId, round, state, summary) {
  return `report:${unitId}:${round}:${state}:${summary}`
}

/** The partner-readable account of one report. */
export function reportMessage(unit, incoming, at) {
  return {
    kind: 'worker_report',
    unit_id: unit.id,
    title: unit.title,
    worker_type: unit.type,
    state: incoming.state,
    summary: incoming.summary,
    ...(incoming.question ? { question: incoming.question } : {}),
    at,
  }
}

/**
 * Carry one recorded report to Partner.
 *
 * The report has already moved the unit, and Partner's Session may be gone: a
 * failure to carry it is the caller's to log, never a failure of the report.
 *
 * @param ctx the Partner context, which declares `sessionController`
 * @param unit the unit after the report, as the store holds it
 * @param incoming the report `{ state, summary, question?, source }`
 * @param options `round` is the assignment or turn the report belongs to
 * @returns the relay key carried, or undefined when this report is not pushed or was carried already
 * @throws when the Partner Session could not be reached to carry it
 */
export async function relayReport(ctx, unit, incoming, { round } = {}) {
  if (!pushes(incoming)) return undefined
  const key = reportKey(unit.id, round ?? unit.assignments.at(-1)?.id, incoming.state, incoming.summary)
  if (carried.has(key)) return undefined
  carried.add(key)
  const resolved = await ctx.sessionController.resolveAgent(unit.partnerSessionId)
  if ('error' in resolved) throw new Error(`the Partner session ${unit.partnerSessionId} could not be opened (${resolved.error?.code ?? 'unknown error'})`)
  resolved.agent.steer(relayMessage(reportMessage(unit, incoming, new Date().toISOString()), incoming.source))
  return key
}

/**
 * A message Partner's Session takes from another Session.
 *
 * The id is the key, so the same report carried twice is one message in the
 * history and the inbox takes one copy. `agent-message` requires the relay
 * form and the sending Session's id; a message without an id or a source is
 * dropped without a word.
 */
function relayMessage(relayed, senderSessionId) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: JSON.stringify(relayed) }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  }
}
