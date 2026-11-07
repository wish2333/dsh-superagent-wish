/**
 * The judgement: an event a source recorded reaches a Secretary, and what it
 * decides is written back on the event.
 *
 * An event is judged by the Secretary of the conversation that set the rules
 * (`principal`). Its decision arrives as a call to `partner_decide`, whose
 * arguments are checked here before anything is written: an accept opens a
 * working unit whose `source` is the event, a drop writes the reason on the
 * event itself, and either way the event leaves the queue.
 *
 * The judgement is a notice, built the one way a message to another Session is
 * built (relay.js): `agent-message`, `form: 'relay'`, the sending Session. It
 * is not a report, so it is never pushed as one.
 */

import { advance } from './advance.js'
import { dispatch } from './partner.js'
import { sharedPolicy } from './policy.js'
import { openPump, slotsFor } from './pump.js'
import { slotsFrom } from './queue.js'
import { WORKER_TYPES } from './sessions.js'
import { sharedStore } from './working-units.js'

/** What the Secretary reads about one event: the event, the rules in force, and the tool that decides it. */
export const DECIDE_TOOL = 'partner_decide'

/** How many events one judgement carries; a fuller queue is judged in further batches. */
export const JUDGEMENT_BATCH = 5

/** How often the plugin looks for events waiting on a judgement, in milliseconds. */
export const JUDGE_POLL_MS = 2000

/** The unit type each default handling asks for, when the Secretary's decision names none. */
const HANDLING_TYPE = { open: 'discoverer', ask: 'discoverer', ignore: 'implementer' }

/**
 * Record that `principal`, the Partner conversation, is the one external events
 * are judged for from now on.
 *
 * The choice is stored with the rules, so a restart and the file source, which
 * runs in its own preset, read the same conversation.
 *
 * @param ctx the context the policy opens on
 * @param policy the open policy record
 * @param principal the Partner Session id
 */
export async function setPrincipal(ctx, policy, principal) {
  if (!principal) return
  await policy.setPolicy({ principal })
}

/** The Partner conversation external events are judged for, as stored, or undefined before one saved it. */
export function principalFor(policy) {
  return policy.current().principal
}

/**
 * Point every event that still waits on the conversation `principal`.
 *
 * An event recorded before any conversation saved a source has no principal;
 * it waits for one, and this is the one that takes it. An event already judged
 * is left as it was judged.
 *
 * @param ctx the context the store opens on
 * @param store the open tables
 * @param principal the Partner Session id
 * @returns the events that now wait on `principal`
 */
export async function reannotate(ctx, store, principal) {
  if (!principal) return []
  const taken = []
  for (const event of store.pendingEvents()) {
    if (event.principal === principal) continue
    await store.reassignEvent(event.id, principal)
    taken.push(event.id)
  }
  return taken
}

/** What a pairing of event and conversation the plugin has already woken, so one event is judged once. */
const woken = new Set()

/** The timers running on each medium, so the plugin unloads without leaving one behind. */
const timers = new WeakMap()

/**
 * The message a Secretary takes for one judgement: an `agent-message` from the
 * Partner conversation whose rules it judges by.
 */
function judgementMessage(payload, principal) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: principal },
  }
}

/**
 * The event as the Secretary reads it: enough to judge, and nothing that would
 * let it act on the event's text as if it were a rule.
 */
function eventPayload(event) {
  return {
    id: event.id,
    source: event.source,
    kind: event.kind,
    at: event.at,
    ref: event.ref,
    ...(event.handling ? { defaultHandling: event.handling } : {}),
    text: event.text,
  }
}

/**
 * Wake the Secretary for every event that waits on a judgement.
 *
 * A waiting event is woken once: the pairing is kept in memory, and it is
 * forgotten when the event is decided. An event whose Secretary is not there
 * stays `pending` — it waits for the next Secretary, however long that takes.
 *
 * @param ctx the context the stores open on; it declares `sessionController`
 * @returns the event ids woken by this call
 */
export async function judge(ctx, { store = undefined, policy = undefined } = {}) {
  const [tables, record] = await Promise.all([store ?? sharedStore(ctx), policy ?? sharedPolicy(ctx)])
  const pending = tables.pendingEvents()
  if (!pending.length) return []
  const rules = record.current().rules.filter((rule) => rule.enabled !== false)
  const groups = new Map()
  for (const event of pending) {
    const principal = event.principal
    if (!principal) continue
    const pair = `${principal}:${event.id}`
    if (woken.has(pair)) continue
    const batch = groups.get(principal) ?? []
    if (batch.length >= JUDGEMENT_BATCH) continue
    batch.push(event)
    groups.set(principal, batch)
  }
  const sent = []
  for (const [principal, batch] of groups) {
    const resolved = await ctx.sessionController.resolveAgent(`${principal}-secretary`)
    if ('error' in resolved) continue
    const agent = resolved.agent
    for (const event of batch) woken.add(`${principal}:${event.id}`)
    const payload = {
      kind: 'judgement',
      principalSessionId: principal,
      event: batch.length === 1 ? eventPayload(batch[0]) : undefined,
      events: batch.length === 1 ? undefined : batch.map(eventPayload),
      rules: rules.map((rule) => ({ id: rule.id, name: rule.name, instruction: rule.instruction })),
      decide: { tool: DECIDE_TOOL, fields: ['eventId', 'decision', 'reason', 'type', 'title', 'body'] },
      summary: 'Judge each event against the rules. Open a working unit with partner_decide only when a rule says so; otherwise drop it with the reason a rule gives. Say nothing about it to wish.',
    }
    if (payload.event === undefined) delete payload.event
    if (payload.events === undefined) delete payload.events
    try {
      agent.followup(judgementMessage(payload, principal))
      sent.push(...batch.map((event) => event.id))
    } catch (error) {
      for (const event of batch) woken.delete(`${principal}:${event.id}`)
      ctx.logger?.warn?.(`superagent-wish: the judgement for ${principal} was not sent: ${String(error)}`)
    }
  }
  return sent
}

/**
 * Read the decision a Secretary sent and check it against the event.
 *
 * @param store the open tables
 * @param policy the open policy record
 * @param args the tool arguments: `eventId`, `decision`, and the reason or the unit
 * @returns the decision as it will be written, or `{ refused }` with a sentence
 */
export function decision(tables, record, args) {
  const eventId = String(args.eventId ?? '').trim()
  const event = tables.event(eventId)
  if (!event) return { refused: `Decide refused: there is no source event ${eventId}.` }
  if (event.status !== 'pending') return { refused: `Decide refused: event ${eventId} was already judged (${event.status}).` }
  if (args.decision !== 'open' && args.decision !== 'drop') {
    return { refused: 'Decide refused: decision must be "open" or "drop".' }
  }
  if (args.decision === 'drop') {
    const reason = String(args.reason ?? '').trim()
    if (!reason) return { refused: 'Decide refused: a drop needs its reason, as the rule states it.' }
    return { event, decision: { decision: 'drop', reason } }
  }
  const type = String(args.type ?? '').trim()
  const workerType = WORKER_TYPES.includes(type) ? type : HANDLING_TYPE[event.handling]
  const title = String(args.title ?? '').trim()
  const body = String(args.body ?? '').trim()
  if (!title) return { refused: 'Decide refused: an opened unit needs a title.' }
  if (!body) return { refused: 'Decide refused: an opened unit needs its first input.' }
  return { event, decision: { decision: 'open', type: workerType, title, body } }
}

/** The sentence the Secretary reads for one decision, and the row it was written to. */
function decided(decision_, event) {
  return { content: [{ type: 'text', text: decision_.decision === 'drop'
    ? `Event ${event.id} dropped: ${decision_.reason}`
    : `Event ${event.id} opened ${decision_.unitId}.` }] }
}

/**
 * `partner_decide`: write one judgement on its event.
 *
 * The decision is checked before anything is written. An accept goes through
 * the same dispatch a wish-requested unit does, with the event as its `source`
 * and the Partner directory it runs under; a drop writes the reason on the
 * event and wakes nobody. Either way the event leaves the queue, and a refusal
 * leaves it waiting.
 *
 * @param ctx the Secretary's context, which declares the worker services
 * @param store the open tables
 * @param policy the open policy record
 * @param args `eventId`, `decision`, and `reason` or `title` and `body`
 * @param exec the tool call, whose Agent is the Secretary itself
 */
export async function decide(ctx, store, policy, args, exec) {
  const checked = decision(store, policy, args)
  if (checked.refused) return { content: [{ type: 'text', text: checked.refused }] }
  const { event } = checked
  const principal = principalOf(exec) ?? event.principal
  if (!principal) return { content: [{ type: 'text', text: `Decide refused: event ${event.id} names no conversation to run the unit under.` }] }
  if (checked.decision.decision === 'drop') {
    const row = await store.judgeEvent(event.id, { status: 'dropped', reason: checked.decision.reason, principal })
    return decided({ decision: 'drop', reason: checked.decision.reason }, row)
  }
  const { type, title, body } = checked.decision
  const exec_ = { agent: { id: principal, session: { id: principal } }, callId: undefined, signal: undefined }
  const slots = slotsFor(ctx.storageDomain, slotsFrom(undefined))
  const result = await dispatch(ctx, store, policy, slots, { type, title, body }, exec_, { origin: event.id })
  const text = result.content?.[0]?.text ?? ''
  const unitId = /^(unit-\d+)/.exec(text)?.[1]
  if (!unitId) return { content: [{ type: 'text', text: `The unit was not opened, so the event stays waiting. ${text}` }] }
  const row = await store.judgeEvent(event.id, { status: 'opened', unitId, principal })
  await advance(ctx, () => openPump(ctx, store, () => slots))
  return decided({ decision: 'open', unitId }, row)
}

/**
 * The Partner conversation a call belongs to: the Secretary's own id names it
 * (`<partnerId>-secretary`), and a call that carries no Agent has none.
 * @returns the Partner Session id, or undefined
 */
export function principalOf(exec) {
  const id = String(exec?.agent?.id ?? '')
  const match = /^(.*)-secretary$/.exec(id)
  return match?.[1] || undefined
}

/**
 * Start the judgement loop on `ctx`: every poll wakes the Secretary for the
 * events that wait on one.
 *
 * The timer is registered in `ctx.effect`, so the plugin unloads without it.
 * A poll that fails is logged and the next one tries again: an event waits in
 * the table until a Secretary takes it, and a failure costs time, not the event.
 *
 * @param ctx the context the stores open on
 * @returns a promise of the first poll
 */
export function applyJudge(ctx) {
  const poll = async () => {
    try {
      return await judge(ctx)
    } catch (error) {
      ctx.logger?.warn?.(`superagent-wish: the judgement poll failed: ${String(error)}`)
      return []
    }
  }
  if (ctx.storageDomain && typeof ctx.storageDomain === 'object') timers.set(ctx.storageDomain, true)
  ctx.effect(() => {
    const timer = setInterval(() => { void poll() }, JUDGE_POLL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  })
  return poll()
}

/** Whether the judgement loop has been started on `medium`. */
export function judging(medium) {
  return timers.has(medium)
}
