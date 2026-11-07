/**
 * Advancing the dispatch queue after something freed a slot.
 *
 * A round ends in three places — a Worker report, a stop, a dispatch — and each
 * runs in a different preset scope, so none of them can call the manager's pump
 * directly. They all reach it through {@link pumpFor} over the storage medium,
 * which the plugin opens from every scope anyway.
 *
 * A failure here never fails the tool that caused it: the queue stays as the
 * store holds it, and the next report, stop or restart pumps it again.
 */

import { awaitingRegistration, pumpFor, ready } from './pump.js'

/**
 * Pump the queue over `ctx`'s medium.
 *
 * The pump is the manager's, which has the Worker services a start needs; a
 * scope that has none — a Worker preset's report tool — only asks it to pass.
 * A scope with no pump registered has nothing to advance, which is the case
 * before the manager loaded.
 *
 * @param ctx the calling scope; it needs `storageDomain` and, for the log, a logger
 * @param open `() => { pump }` or a `{ pump }` to open a pump when none was
 *   registered. The Partner preset mounts on its own scope, so a Host that
 *   mounted it without the manager still has a queue to start from.
 * @returns a promise that settles when the pass ended
 */
export async function advance(ctx, open) {
  // The manager registers its pump when the plugin loads, and that load is not
  // awaited; a tool call may arrive before it, so the registration settles first.
  await ready(ctx.storageDomain)
  let pump = pumpFor(ctx.storageDomain)
  // A Host that mounted this preset without a manager has no registration to
  // wait for, so the scope opens its own pump instead.
  if (!pump && open && !awaitingRegistration(ctx.storageDomain)) pump = await open()
  if (!pump) return
  try {
    await pump.pump()
  } catch (error) {
    ctx.logger?.warn?.(`superagent-wish: the dispatch queue did not advance: ${error.message}`)
  }
}
