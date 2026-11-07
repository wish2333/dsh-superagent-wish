/**
 * The pump: start queued implementers when a slot is free.
 *
 * It runs at three moments, the ones the spec names:
 *
 * - a dispatch, which may have to queue and may free nothing;
 * - a round ending, when a report or a stop ended an assignment and so gave a
 *   slot back;
 * - a restart, which re-pumps everything the store holds, so a queue survives
 *   the plugin going away.
 *
 * The queue state lives in the working unit tables, not here: a queued unit is
 * one the store opened whose worker was never started. A start is recorded
 * before the worker is told, and the store is read afresh on every pass, so two
 * pumps over one store cannot start a unit twice: whichever records the start
 * first takes the slot, and the other passes over the unit.
 */

import { nextToStart, occupying, queued } from './queue.js'
import { deliver, describe, ensureWorker, selectModel } from './sessions.js'

/**
 * Open the pump over a store.
 *
 * @param ctx the manager's context, which the Worker Sessions are opened through
 * @param store the open working unit tables
 * @param slots `() => number`, the implementer slots the configuration allows
 * @returns `{ pump }`
 */
export function openPump(ctx, store, slots) {
  let running

  /**
   * Open the unit's Worker — steps 0–5 of the chain — and record the start
   * before the worker is told anything.
   *
   * A model the unit records is selected now: a queued dispatch could not have
   * checked it, and a model the Host does not have ends this attempt before the
   * unit holds a slot.
   */
  const start = async (unit) => {
    const { agent } = await ensureWorker(ctx, unit)
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: unit.workerSessionId, title: unit.title })
    if (unit.model) await selectModel(ctx, unit.workerSessionId, unit.model)
    // The assignment is marked running before the worker is told: from here the
    // unit holds a slot, and a second pump pass passes over it.
    const started = await store.start(unit.id)
    const first = started.undelivered
      .map((id) => started.inputs.find((input) => input.id === id))
      .find(Boolean)
    if (!first) return started
    await deliver(ctx, started, first)
    return store.deliver(started.id, [first.id])
  }

  const pass = async () => {
    // A unit whose start failed is passed over for the rest of this pass: it
    // keeps its place in the queue and its input stays queued, and the next
    // pump — a report, a stop, a restart — tries it again.
    const failed = new Set()
    for (;;) {
      const units = store.list()
      const next = nextToStart(queued(units).filter((unit) => !failed.has(unit.id)), units, slots())
      if (!next) return
      await start(next).catch((error) => {
        failed.add(next.id)
        ctx.logger?.warn?.(`superagent-wish: ${next.id} did not start: ${describe(error)}`)
      })
    }
  }

  const pump = () => {
    // A pass already running has read the store before this call, so the call
    // runs after it rather than joining it: its unit must be seen. Passes chain
    // one after another, so the queue stays in order and nothing starts twice.
    const chained = (running ?? Promise.resolve()).then(pass, pass)
    const current = chained.finally(() => { if (running === current) running = undefined })
    running = current
    return current
  }

  return { pump }
}

/**
 * The pumps open over each storage medium, so every mount point of this plugin
 * reaches the one the manager started: Partner dispatches, a Worker report and
 * a stop all advance the same queue, and each is a separate preset scope.
 *
 * A pump is stateless — it reads the store on every pass — so sharing one
 * across scopes only saves opening the domain a second time.
 */
const pumps = new WeakMap()



/**
 * Register the pump `pump` as the one for `medium`, or read it back.
 * @param medium the `ctx.storageDomain` service the store opened over
 * @param pump the pump to register, or nothing to read the one registered
 * @returns the pump for `medium`, or undefined when none was registered
 */
export function pumpFor(medium, pump) {
  if (!medium || typeof medium !== 'object') return undefined
  if (pump) pumps.set(medium, pump)
  return pumps.get(medium)
}

/** The registrations still being made, by medium. */
const registering = new WeakMap()

/**
 * Record that the pump for `medium` is being opened, so {@link ready} waits for
 * it rather than reading nothing.
 * @param medium the `ctx.storageDomain` service
 * @param opening a promise of the pump
 */
export function registeringPump(medium, opening) {
  if (medium && typeof medium === 'object') registering.set(medium, opening)
}

/**
 * Wait for the pump registration for `medium`, if one is being made.
 * @param medium the `ctx.storageDomain` service
 */
export async function ready(medium) {
  if (!medium || typeof medium !== 'object') return
  await registering.get(medium)?.catch(() => {})
}

/** The slot count each manager was loaded with, by medium. */
const configuredSlots = new WeakMap()

/**
 * Record the implementer slot count the manager was configured with.
 * @param medium the `ctx.storageDomain` service
 * @param slots the count
 */
export function configureSlots(medium, slots) {
  if (medium && typeof medium === 'object') configuredSlots.set(medium, slots)
}

/**
 * The configured slot count for `medium`, or `fallback` when the manager that
 * loads this plugin was given none. A preset mounted alone, or mounted before
 * the manager, reads the manager's setting rather than its own.
 * @param medium the `ctx.storageDomain` service
 * @param fallback the count this scope was given
 */
export function slotsFor(medium, fallback) {
  return (medium && typeof medium === 'object' ? configuredSlots.get(medium) : undefined) ?? fallback
}

/**
 * Whether a pump registration for `medium` is being made or is done.
 * @param medium the `ctx.storageDomain` service
 */
export function awaitingRegistration(medium) {
  return medium && typeof medium === 'object' && registering.has(medium)
}
