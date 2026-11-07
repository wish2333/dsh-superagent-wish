/**
 * The report channel, shared by the Partner preset and the two worker presets.
 *
 * Partner creates it when its preset loads; each worker's `partner_report` tool
 * records into it. It cannot live on `ctx`: Cordis refuses reads of properties
 * it did not inject ("cannot get property ... without inject"), and the worker
 * scopes are not the scope that created the channel.
 *
 * The presets load `partner.js` and `worker-*.js` from the same package, so both
 * sides reach this one module instance.
 */

let channel

/** @param {object | undefined} next the channel Partner bound, or undefined to clear it. */
export function setReportChannel(next) {
  channel = next
}

/** @returns the channel Partner bound, or undefined while no Partner preset is loaded. */
export function getReportChannel() {
  return channel
}
