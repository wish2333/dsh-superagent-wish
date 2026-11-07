/**
 * The worker side of the report channel: a tool a worker calls to tell Partner
 * what happened. The tool validates the report; the report channel relays it to
 * the Partner session.
 */

import { REPORT_STATES } from './tools.js'

/** @returns the tool result shown to the worker. */
export function report(ctx, args, exec) {
  if (!REPORT_STATES.includes(args.state)) {
    return { isError: true, content: [{ type: 'text', text: `Unknown report state "${args.state}".` }] }
  }
  if (typeof args.summary !== 'string' || args.summary.trim() === '') {
    return { isError: true, content: [{ type: 'text', text: 'A report needs a non-empty summary.' }] }
  }
  const sessionId = sessionIdOf(ctx, exec)
  const turn = ctx.agents && sessionId ? turnOf(ctx, sessionId) : 0
  if (ctx.reportChannel && sessionId) ctx.reportChannel.record(sessionId, turn, args.state, args.summary)
  return { content: [{ type: 'text', text: `Reported ${args.state} to Partner.` }] }
}

function sessionIdOf(ctx, exec) {
  if (exec && exec.agent && exec.agent.id) return exec.agent.id
  return ctx.session ? ctx.session.id : undefined
}

function turnOf(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  const boundary = agent && typeof ctx.agents.turnBoundaryOf === 'function' ? ctx.agents.turnBoundaryOf(agent.session) : undefined
  return boundary && boundary.lastTurn !== undefined ? boundary.lastTurn : 0
}
