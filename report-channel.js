/**
 * The host side of the report channel.
 *
 * A worker reports in-session via `partner_report`. A report with state
 * `progress` is kept for the record and never wakes Partner; the other states
 * are relayed into the Partner session as a `steer` message. When a worker
 * turns idle after only a `progress` report, a `waiting` report is synthesised
 * so a forgotten report never looks like silence.
 *
 * Identity of a report is its worker session plus its turn, state and summary,
 * so a retried delivery is dropped instead of reaching Partner twice.
 */

import { REPORT_STATES } from './tools.js'

export const WAITING_SUMMARY = 'Worker ended its turn without a final report.'

/** The text Partner receives for one report. */
export function formatReport(workerSessionId, state, summary) {
  return [`Worker ${workerSessionId} reported ${state}:`, '', summary].join('\n')
}

/**
 * @param {object} deps
 * @param {() => object | undefined} deps.getPartnerAgent returns the live Partner agent
 * @param {(text: string, id: string) => void} [deps.onRelay] observes each delivery
 */
export function createReportChannel(deps) {
  /** worker session id -> the report recorded for its current turn */
  const reports = new Map()
  /** worker session ids this plugin dispatched or adopted */
  const workers = new Set()
  /** identities already handed to Partner */
  const delivered = new Set()
  let partnerSessionId

  function identity(workerId, report) {
    return `${workerId}|${report.turn}|${report.state}|${report.summary}`
  }

  function relay(workerId, report) {
    const id = identity(workerId, report)
    if (delivered.has(id)) return false
    delivered.add(id)
    const agent = deps.getPartnerAgent()
    if (!agent || typeof agent.steer !== 'function') return false
    const message = { role: 'user', content: [{ type: 'text', text: formatReport(workerId, report.state, report.summary) }], id }
    agent.steer(message)
    if (deps.onRelay) deps.onRelay(message.content[0].text, id)
    return true
  }

  return {
    /** Binds the Partner session; a dispatch calls this with its own ids. */
    configure({ partnerSessionId: id, workerSessionId } = {}) {
      if (id) partnerSessionId = id
      if (workerSessionId) workers.add(workerSessionId)
    },

    /** Adopts a session as a worker whose status this channel watches. */
    track(workerSessionId) {
      workers.add(workerSessionId)
    },

    get partnerSessionId() {
      return partnerSessionId
    },

    /** Called by the worker-side tool with the worker's session and turn. */
    record(workerSessionId, turn, state, summary) {
      if (!REPORT_STATES.includes(state)) return false
      workers.add(workerSessionId)
      const report = { turn, state, summary, statusOnly: state === 'progress' }
      reports.set(workerSessionId, report)
      if (report.statusOnly) return true
      relay(workerSessionId, report)
      return true
    },

    /** Reacts to an `agent/status` event. */
    onStatus({ agent, status }) {
      if (status !== 'idle') return
      const workerId = agent && agent.id
      if (!workerId || !workers.has(workerId)) return
      const report = reports.get(workerId)
      if (report && !report.statusOnly) return
      const turn = report ? report.turn : 0
      relay(workerId, { turn, state: 'waiting', summary: WAITING_SUMMARY })
      reports.set(workerId, { turn, state: 'waiting', summary: WAITING_SUMMARY, statusOnly: false })
    },

    /** Identities already relayed, for tests and diagnostics. */
    get deliveredIds() {
      return [...delivered]
    },
  }
}
