/**
 * The tools a preset registers, as plain definitions the Host mounts with
 * `ctx.tools.register`. Kept free of Host imports so tests can read them.
 */

/** Tool names a worker uses to report to Partner. */
export const REPORT_TOOL_NAME = 'partner_report'

/** The states a report may carry; `waiting` is synthesised by the host, never reported. */
export const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed']

/** Tool name Partner uses to start a worker; no worker preset carries it. */
export const DISPATCH_TOOL_NAME = 'partner_dispatch'

/** Worker kinds Partner may dispatch, and the preset each one runs under. */
export const WORKER_KINDS = {
  discoverer: 'superagent-wish-discoverer',
  implementer: 'superagent-wish-implementer',
}

export const DISPATCH_TOOL = {
  name: DISPATCH_TOOL_NAME,
  description:
    'Start a worker session for a task. Call only after wish agrees to the dispatch. '
    + 'Use discoverer while options are still unclear, implementer once a direction is confirmed.',
  parameters: {
    kind: {
      type: 'string',
      required: true,
      enum: Object.keys(WORKER_KINDS),
      description: 'Worker type: discoverer for exploration, implementer for delivery.',
    },
    title: {
      type: 'string',
      required: true,
      description: 'Short task title; the worker session is named after it.',
    },
    body: {
      type: 'string',
      required: true,
      description: 'The exploratory prompt or task spec, already formatted as text.',
    },
  },
}

export const REPORT_TOOL = {
  name: REPORT_TOOL_NAME,
  description:
    'Report progress, ready, blocked or failed to Partner before a turn ends. '
    + 'Report blocked instead of deciding a product or scope question yourself.',
  parameters: {
    state: {
      type: 'string',
      required: true,
      enum: REPORT_STATES,
      description: 'progress while working, ready when delivered, blocked when a decision is needed, failed when stuck.',
    },
    summary: {
      type: 'string',
      required: true,
      description: 'One short paragraph Partner can relay to wish.',
    },
  },
}
