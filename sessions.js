/**
 * The executor: the Partner tools go through this module to reach the Host.
 *
 * It owns the seven-step chain of `docs/impl/superagent-impl.md` §2 — resolve,
 * make the directory, open the workspace, create the Session, resolve it
 * again, set permissions, name it — and the two things every working unit
 * thereafter asks of its Worker Session: a delivery, and a stop.
 *
 * A Worker Session id and its directory are both derived from the working unit
 * id, so a unit keeps one Session and one directory for its whole life; a title
 * change renames the Session and never the directory. A deleted Session is
 * opened again from the same unit id on the next delivery.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Preset id of each worker type (ADR-0003 keeps the whitelist on the plugin rows). */
export const WORKER_PRESETS = {
  discoverer: 'superagent-wish-discoverer',
  implementer: 'superagent-wish-implementer',
}

/** The worker types a dispatch may name. */
export const WORKER_TYPES = Object.keys(WORKER_PRESETS)

/** The session id that belongs to working unit `unitId`. */
export function workerSessionId(unitId) {
  return `superagent-wish-${unitId}`
}

/** The directory Partner creates under, taken from its own session and never from the profile directory. */
export function baseDirectory(ctx, session) {
  try {
    const own = session ? ctx.workingDirectory?.get(session) : undefined
    if (typeof own === 'string' && own.startsWith('/')) return own
  } catch {
    // The Session's directory could not be read; fall through to the deployment one.
  }
  const fallback = ctx.workingDirectory?.defaultDirectory
  return typeof fallback === 'string' && fallback.startsWith('/') ? fallback : process.cwd()
}

/** The working unit's own directory: one directory per unit, named after the unit id. */
export function unitDirectory(ctx, session, unitId) {
  return join(baseDirectory(ctx, session), 'superagent-wish', unitId)
}

/** A message the Worker accepts: `UserMessage.id` and `.source` are required, and one without them is dropped silently. */
function userMessage(text) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** One readable sentence for a failure, on the same line as the Host's own words. */
export function describe(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
}

/**
 * The worker services, read once. A Host without one of them cannot run a
 * Worker at all, and the tool that asked says so instead of throwing.
 * @returns the services, or the one missing service's name
 */
function services(ctx) {
  for (const name of ['sessionController', 'workspaceRegistry', 'permissionPresets', 'agents']) {
    if (!ctx[name]) return { missing: name }
  }
  return {
    sessionController: ctx.sessionController,
    workspaceRegistry: ctx.workspaceRegistry,
    permissionPresets: ctx.permissionPresets,
    agents: ctx.agents,
    workingDirectory: ctx.workingDirectory,
  }
}

/**
 * The live Worker of a working unit: resolved, then opened from the unit's id
 * when the Host has no such Session — it was never created, or it was deleted
 * outside the plugin. The unit keeps its id and its directory either way.
 *
 * Steps 0–3 of the chain. The directory is made before the workspace is
 * registered because the Host owns directories, it does not create them.
 *
 * @param ctx the Partner context, which declares the worker services
 * @param unit the unit whose Worker is asked for
 * @param options `session` is the Partner Session, whose directory a unit's own
 *   is created under
 * @returns `agent`, and `opened`: whether this call created the Session
 */
export async function ensureWorker(ctx, unit, { session } = {}) {
  const host = services(ctx)
  if (host.missing) throw new Error(`the Host provides no ${host.missing} service`)
  const { sessionController, workspaceRegistry } = host

  const sessionId = unit.workerSessionId ?? workerSessionId(unit.id)
  let resolved = await sessionController.resolveAgent(sessionId)
  const opened = 'error' in resolved
  if (opened) {
    // The tables always record the directory a unit used, because the Host's
    // Workspace cannot be renamed; a unit missing one has never run.
    const directory = unit.directory ?? unitDirectory(ctx, session, unit.id)
    await mkdir(directory, { recursive: true })
    const workspace = await workspaceRegistry.create(directory)
    await sessionController.create({
      sessionId,
      workspaceId: workspace.id,
      agentPreset: WORKER_PRESETS[unit.type],
    })
    resolved = await sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(`the worker session could not be opened (${resolved.error?.code ?? 'unknown error'})`)
  }
  return { agent: resolved.agent, opened }
}

/**
 * Steps 4–5 of the chain for one Worker Session: full permissions, then the
 * unit's title. A later delivery repeats them after a Session was recreated, so
 * it is named and permitted like the first one; the directory is never renamed.
 */
async function decorate(ctx, unit, agent) {
  ctx.permissionPresets.set(agent.session, 'danger-full-access')
  const sessionId = unit.workerSessionId ?? workerSessionId(unit.id)
  await ctx.sessionController.rename({ sessionId, title: unit.title })
}

/**
 * Deliver one input text to the unit's Worker.
 *
 * `followup` sends it as the next turn: an idle Worker wakes up, and a Worker
 * still answering the previous input takes it in order after that one. Nothing
 * is asked of wish again and the directory is not rebuilt.
 *
 * @returns `'delivered'`; throws when the Host refused the message
 */
export async function deliver(ctx, unit, input, session) {
  const { agent, opened } = await ensureWorker(ctx, unit, { session })
  // A Session that ran before keeps what steps 4–5 gave it; one opened again is
  // permitted and named like the first one. The directory is never rebuilt.
  if (opened) await decorate(ctx, unit, agent)
  agent.followup(userMessage(input.text))
  return 'delivered'
}

/**
 * End the current assignment without ending the unit: the live Worker's turn is
 * cancelled, its pending inbox is kept, and a later input starts the next
 * assignment.
 *
 * @returns `true` when a live Worker was cancelled, `false` when none was running
 */
export function stop(ctx, unit) {
  const agent = ctx.agents?.get(unit.workerSessionId ?? workerSessionId(unit.id))
  if (!agent) return false
  // `keepInbox` is the real Agent's option: a stop ends this turn, not the input already queued behind it.
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  return true
}

/**
 * Select the model for a new Worker Session. A dispatch that names none leaves
 * the Session on the Host default, which the Session inherits at creation.
 * @throws when the Host has no model of that name
 */
export async function selectModel(ctx, sessionId, model) {
  await ctx.sessionController.selectModel({ sessionId, ...model })
}
