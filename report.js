/**
 * The worker side of the report channel: a tool a worker calls to tell Partner
 * what happened. The host queued the report and delivers it to Partner with
 * `steer`; the tool itself only acknowledges.
 */

import { REPORT_STATES } from './tools.js'

/** @returns the tool result shown to the worker. */
export function report(ctx, args) {
  if (!REPORT_STATES.includes(args.state)) {
    return { isError: true, content: [{ type: 'text', text: `Unknown report state "${args.state}".` }] }
  }
  if (typeof args.summary !== 'string' || args.summary.trim() === '') {
    return { isError: true, content: [{ type: 'text', text: 'A report needs a non-empty summary.' }] }
  }
  if (typeof ctx.recordReport === 'function') ctx.recordReport(args.state, args.summary)
  return { content: [{ type: 'text', text: `Reported ${args.state} to Partner.` }] }
}
