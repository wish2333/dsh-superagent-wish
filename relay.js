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
import { WORKER_SESSION } from './sessions.js'

/** The text of a `waiting` report for a turn that ended without one. */
export const WAITING_SUMMARY = 'The turn ended without a report. Partner has no state for it; ask for one.'

/**
 * Every report key already carried. The store keeps the report; this keeps the
 * fact that it was carried, so a report that arrives twice — a retried tool
 * call, or the executor repeating a turn's ending — is one message.
 */
const carried = new Set()

/**
 * The relay idempotency key of a report: one report of the same unit, round,
 * state and summary relays once to one Partner.
 *
 * The same round may `progress` with one summary and `waiting` with another, so
 * the round is part of the key and stands for the turn a report ends. A report
 * Partner's Session could not take keeps its key, so a caller that carries it
 * again after a failure says whose retry it is.
 */
export function reportKey(unit, round, incoming) {
  return `report:${unit.partnerSessionId}:${unit.id}:${round}:${incoming.state}:${incoming.summary}:${incoming.source ?? ''}`
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
 * @param options `round` is the assignment or turn the report belongs to;
 *   `reported` is the set of keys already carried, which a caller may replace
 *   to carry a report of its own under a key of its own
 * @returns the relay key carried, or undefined when this report is not pushed or was carried already
 * @throws when the Partner Session could not be reached to carry it
 */
export async function relayReport(ctx, unit, incoming, { round, reported = carried } = {}) {
  if (!incoming.pushes && !pushes(incoming)) return undefined
  const key = reportKey(unit, round ?? unit.assignments.at(-1)?.id, incoming)
  if (reported.has(key)) return undefined
  reported.add(key)
  const resolved = await ctx.sessionController.resolveAgent(unit.partnerSessionId)
  if ('error' in resolved) throw new Error(`the Partner session ${unit.partnerSessionId} could not be opened (${resolved.error?.code ?? 'unknown error'})`)
  resolved.agent.steer(relayMessage(reportMessage(unit, incoming, new Date().toISOString()), incoming.source))
  return key
}

/**
 * The Worker's last report, as this module saw it, per store and unit. The
 * store keeps the report too, but a `waiting` the fallback adds replaces it,
 * and a turn's end must not count a report the fallback itself added. A store
 * this module has not reported on reads the store's own report.
 */
const lastReport = new WeakMap()

/** @returns the store's memory, opened on first use. */
function memoryOf(store) {
  let seen = lastReport.get(store)
  if (!seen) lastReport.set(store, (seen = new Map()))
  return seen
}

/** @returns the remembered `{ round, state }` for `unit`, or undefined for a store it has not seen. */
const remembered = (store, unitId) => lastReport.get(store)?.get(unitId)

/**
 * Note the round a Worker turn ended with, so the turn's end needs no `waiting`.
 * @param store the table handle the report was written through
 * @param unit the unit after the report
 * @param round the assignment the report belongs to
 */
export function noted(store, unit, round) {
  memoryOf(store).set(unit.id, { round, state: unit.assignments.at(-1)?.report?.state })
}

/**
 * The turn end of a Worker Session: after a turn that produced no report, or
 * only `progress`, the unit gets a `waiting` report so Partner is never left
 * with a silent Worker.
 *
 * The Worker runs in its own preset scope, so the listener that calls this must
 * be `{ global: true }`.
 *
 * @param ctx the scanning preset's context, which declares `storageDomain` and `sessionController`
 * @param store the open working-unit tables
 * @param sessionId the Session that went idle, possibly any Session of the Host
 * @param after a turn whose end comes after the caller finishes; the listener
 *   yields to it first, so a report that turn writes is the one counted
 * @returns the report added, or undefined when the Session is no Worker or needs none
 */
export async function turnEnded(ctx, store, sessionId, after) {
  const match = WORKER_SESSION.exec(String(sessionId ?? ''))
  if (!match) return undefined
  try {
    // A Worker that is no longer idle began another turn as the event landed:
    // this turn's end is over, and the next one has its own.
    const still = await after?.()
    if (still && still.status !== 'idle') return undefined
    const unit = store.get(match[1])
    if (!unit || unit.workerSessionId !== sessionId) return undefined
    if (unit.state === 'ended' || unit.state !== 'running') return undefined
    const round = unit.assignments.at(-1)
    if (round?.state !== 'running') return undefined
    // A report written by the turn is in the store whether or not it reached
    // Partner; the turn is silent only when the store holds nothing new.
    const seen = remembered(store, unit.id)
    const state = seen?.round === round.id ? seen.state : round.report?.state
    // A `waiting` this round already sent is its report: a turn end that comes
    // twice is still the one report, so it does not send another.
    if (state === 'waiting' && seen?.round === round.id) return undefined
    if (state !== undefined && !['progress', 'waiting'].includes(state)) return undefined
    const updated = await store.report(unit.id, { state: 'waiting', summary: WAITING_SUMMARY, source: 'executor' })
    memoryOf(store).set(unit.id, { round: round.id, state: 'waiting' })
    // The turn end carries itself: the push rule would keep every executor-
    // written `waiting` home.
    await relayReport(ctx, updated, { state: 'waiting', summary: WAITING_SUMMARY, source: sessionId, pushes: true }, { round: round.id })
    return updated
  } catch (error) {
    ctx.logger?.warn?.(`superagent-wish: the turn end of ${sessionId} could not be recorded: ${String(error)}`)
    return undefined
  }
}

/**
 * A message Partner's Session takes from another Session.
 *
 * Every user message needs an `id` and a `source`, and the Host drops one
 * without either without a word. `agent-message` requires the relay form and
 * the sending Session's id, which is how Partner tells a Worker's report from
 * wish's own words.
 */
function relayMessage(relayed, senderSessionId) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: JSON.stringify(relayed) }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  }
}
