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

/**
 * Renders a tool result as the content blocks DSH requires. DSH rejects a tool
 * definition without an `output` block, so every tool here declares one.
 */
function renderText(args, value) {
  const text = value && Array.isArray(value.content)
    ? value.content.map((block) => block.text ?? '').join('\n')
    : String(value)
  return [{ type: 'text', text }]
}

export const DISPATCH_TOOL = {
  name: DISPATCH_TOOL_NAME,
  description:
    'Start a worker session for a task. Call only after wish agrees to the dispatch. '
    + 'Use discoverer while options are still unclear, implementer once a direction is confirmed.',
  // `ctx.tools.register` takes the JSON Schema the provider receives, not the
  // author-facing DSL `defineTool` compiles. Passing the DSL here sends a
  // schema without `type`/`properties`, and the provider rejects every request
  // in that session with a 400.
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: Object.keys(WORKER_KINDS),
        description: 'Worker type: discoverer for exploration, implementer for delivery.',
      },
      title: {
        type: 'string',
        description: 'Short task title; the worker session is named after it.',
      },
      body: {
        type: 'string',
        description: 'The exploratory prompt or task spec, already formatted as text.',
      },
    },
    required: ['kind', 'title', 'body'],
  },
  output: { schema: { type: 'object' }, render: renderText },
}

export const REPORT_TOOL = {
  name: REPORT_TOOL_NAME,
  description:
    'Report progress, ready, blocked or failed to Partner before a turn ends. '
    + 'Report blocked instead of deciding a product or scope question yourself.',
  parameters: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: REPORT_STATES,
        description: 'progress while working, ready when delivered, blocked when a decision is needed, failed when stuck.',
      },
      summary: {
        type: 'string',
        description: 'One short paragraph Partner can relay to wish.',
      },
    },
    required: ['state', 'summary'],
  },
  output: { schema: { type: 'object' }, render: renderText },
}
