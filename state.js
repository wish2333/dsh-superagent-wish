/**
 * The working unit state machine. Pure: every function takes a working unit and
 * the fact that happened, and returns the next working unit. Nothing here reads
 * the Host, and a function never changes the unit it was given.
 *
 * States (ADR-0005, docs/design/working-unit.md):
 *
 *   pending → running → waiting-for-decision / waiting-for-input → ended
 *
 * A unit runs while one of its assignments runs. An assignment moves from
 * `pending` to `running` to `ended`; a report ends the assignment it belongs
 * to and moves the unit as the report says.
 */

/** Error thrown when a transition is not allowed on the unit it was given. */
export class WorkingUnitError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkingUnitError'
    this.code = code
  }
}

const withAssignments = (unit, assignments) => ({ ...unit, assignments })

/** A new assignment that receives the unit's waiting input, and the unit moved to running. */
const openAssignment = (unit, at) => ({
  ...unit,
  state: 'running',
  assignments: [...unit.assignments, { id: nextAssignmentId(unit), state: 'pending', createdAt: at }],
})

const nextAssignmentId = (unit) => `${unit.id}/assignment-${unit.assignments.length}`

/**
 * Start a working unit under the mandate created for it, with its first
 * assignment pending.
 * @param unit the fields Partner decided: id, type, title, source, sessionId
 * @param mandate scope, strength, policyVersion, basis
 * @returns the started unit
 */
export function begin(unit, mandate) {
  return {
    ...unit,
    state: 'running',
    mandate,
    assignments: [{ id: `${unit.id}/assignment-0`, state: 'pending', createdAt: unit.createdAt }],
    inputs: [],
    undelivered: [],
  }
}

/**
 * Apply a fact to a working unit.
 * @param unit the current unit
 * @param fact what happened outside a report or new input: `start`, `deliver`, `read`, `stop`
 * @returns the next unit
 */
export function dispatch(unit, fact) {
  switch (fact.state) {
    case 'start':
      return start(unit, fact)
    case 'deliver':
      return deliver(unit, fact, fact.at ?? unit.updatedAt)
    case 'read':
      return read(unit, fact, fact.at ?? unit.updatedAt)
    case 'stop':
      return stop(unit, fact)
    default:
      throw new WorkingUnitError('workingUnit/unknownFact', `unknown fact '${fact.state}'`)
  }
}

/** Mark the latest pending assignment running. */
function start(unit, fact) {
  const pending = unit.assignments.findLastIndex((assignment) => assignment.state === 'pending')
  if (unit.state === 'ended' || pending < 0) return unit
  const assignments = unit.assignments.map((assignment, index) =>
    index === pending ? { ...assignment, state: 'running', startedAt: fact.at } : assignment)
  return withAssignments(unit, assignments)
}

/**
 * Record that `inputIds` reached the worker of the running assignment: they
 * leave the queue, keep their place, and wait to be read.
 */
function deliver(unit, fact, at) {
  const assignment = unit.assignments.at(-1)
  if (unit.state === 'ended' || assignment?.state !== 'running') return unit
  const ids = fact.inputIds.filter((id) => unit.undelivered.includes(id))
  if (!ids.length) return unit
  const inputs = unit.inputs.map((input) =>
    ids.includes(input.id) ? { ...input, deliveredTo: assignment.id, readAt: null } : input)
  const assignments = unit.assignments.map((item, index) =>
    index === unit.assignments.length - 1 ? { ...item, deliveredAt: at } : item)
  return withAssignments(
    { ...unit, inputs, assignments, undelivered: unit.undelivered.filter((id) => !ids.includes(id)), updatedAt: at },
    assignments)
}

/** Record that the worker's session took `inputIds` into a step, so its model read them. */
function read(unit, fact, at) {
  if (unit.state === 'ended') return unit
  const ids = fact.inputIds.filter((id) => unit.inputs.some((input) => input.id === id && input.readAt === null))
  if (!ids.length) return unit
  return {
    ...unit,
    inputs: unit.inputs.map((input) => (ids.includes(input.id) && input.readAt === null ? { ...input, readAt: at } : input)),
    updatedAt: at,
  }
}

/**
 * End the running assignment, and with it the unit's work for now: the unit
 * waits for an input. A stop is not an end — the unit keeps its id, its
 * directory and its queue — and the next input opens a new assignment.
 *
 * Input delivered to the ended assignment that the worker never read goes back
 * to the front of the queue: a cancel may have dropped it, so only its next
 * delivery is guaranteed.
 */
function stop(unit, fact) {
  if (unit.state === 'ended') return unit
  const assignment = unit.assignments.at(-1)
  const at = fact.at ?? unit.updatedAt
  if (!assignment || assignment.state === 'ended') return unit
  const unread = unit.inputs
    .filter((input) => input.deliveredTo === assignment.id && input.readAt === null && !unit.undelivered.includes(input.id))
    .map((input) => input.id)
  const requeued = unit.inputs.map((input) =>
    unread.includes(input.id) ? { ...input, deliveredTo: undefined, readAt: undefined } : input)
  return withAssignments(
    { ...unit, state: 'waiting-for-input', inputs: requeued, undelivered: [...unread, ...unit.undelivered], updatedAt: at },
    unit.assignments.map((item) => (item.id === assignment.id
      ? { ...item, state: 'ended', endedAt: at, endedReason: fact.endedReason ?? 'stopped' }
      : item)))
}

/**
 * Record a worker report. `ready` moves an implementer to waiting-for-decision
 * and ends a discoverer; `dropped` ends the unit; `blocked` and `failed` move
 * it to waiting-for-input; `progress` and `waiting` change no state.
 */
export function report(unit, incoming) {
  if (unit.state === 'ended') throw new WorkingUnitError('workingUnit/ended', 'The working unit has ended')
  const at = incoming.at ?? unit.updatedAt
  const latest = unit.assignments.at(-1)
  // A discoverer's `ready` ended the unit, and the `waiting` the executor adds
  // when that same turn goes idle must not replace the result wish is to judge.
  if (incoming.state === 'waiting' && latest?.report?.state === 'ready') return unit
  // A report other than `progress` ends the assignment it belongs to: the
  // worker's turn is over, so the slot it held is free. `progress` reports on a
  // turn still running and leaves the assignment as it is.
  const finished = incoming.state !== 'progress'
  const assignments = unit.assignments.map((assignment, index) =>
    index === unit.assignments.length - 1
      ? {
        ...assignment,
        report: { state: incoming.state, summary: incoming.summary, at, ...(incoming.source ? { source: incoming.source } : {}) },
        ...(finished ? { state: 'ended', endedAt: at, endedReason: incoming.state } : {}),
      }
      : assignment)
  const reported = withAssignments(unit, assignments)
  switch (incoming.state) {
    case 'ready':
      return reported.type === 'discoverer'
        ? end(reported, 'executor', 'ready', at)
        : { ...reported, state: 'waiting-for-decision' }
    case 'dropped':
      return end(reported, 'executor', 'dropped', at)
    case 'blocked':
    case 'failed':
      return { ...reported, state: 'waiting-for-input' }
    default:
      return reported
  }
}

/**
 * Add input and queue it, returning a unit waiting for a decision or for input
 * to running with a new assignment.
 *
 * An ended unit is not continued: ending is final, and the same work needs a
 * new unit.
 * @throws WorkingUnitError `workingUnit/ended` when the unit has ended
 */
export function followup(unit, incoming) {
  if (unit.state === 'ended') throw new WorkingUnitError('workingUnit/ended', 'The working unit has ended')
  const at = incoming.at ?? unit.updatedAt
  const input = { id: `${unit.id}/input-${unit.inputs.length}`, text: incoming.text, source: incoming.source ?? 'wish', at }
  const queued = {
    ...unit,
    inputs: [...unit.inputs, input],
    undelivered: [...unit.undelivered, input.id],
    updatedAt: at,
  }
  if (queued.state === 'running') return queued
  return openAssignment(queued, at)
}

/**
 * Add the notice that the policy changed to a unit that has not ended, and
 * queue it. The mandate is not touched: the unit continues under what was
 * granted, and the worker reads what it must keep within.
 *
 * The id includes `at`, so two changes between the same two versions still
 * record two notices; a notice already recorded is not added twice.
 *
 * @param unit the current unit
 * @param change `from`, `to`, the `rules` the policy defines now, and `at`
 * @returns the next unit, or the same unit when it has ended or holds the notice
 */
export function policyChanged(unit, change) {
  if (unit.state === 'ended') return unit
  const at = change.at ?? unit.updatedAt
  const id = `${unit.id}/input-policy-${change.from}-${change.to}-${at}`
  if (unit.inputs.some((input) => input.id === id)) return unit
  const input = {
    id,
    kind: 'policy-changed',
    text: policyNotice(change.rules ?? []),
    ref: unit.mandate?.policyVersion ?? change.from,
    from: change.from,
    to: change.to,
    rules: change.rules ?? [],
    source: 'policy',
    at,
  }
  return {
    ...unit,
    inputs: [...unit.inputs, input],
    undelivered: [...unit.undelivered, input.id],
    updatedAt: at,
  }
}

/**
 * Whether a unit hears of a policy change: it has not ended, and it was opened
 * under other rules than the ones now in force.
 * @returns `true` when the unit is notified
 */
export function affectedByPolicyChange(unit, from, to) {
  if (unit.state === 'ended') return false
  if (from === to) return false
  return unit.mandate?.policyVersion !== to
}

/** The text a worker reads when the policy changed under it; the prototype's `policyMessage`, narrowed to rules. */
export function policyNotice(rules) {
  return [
    'Policy change: the rules that bear on this working unit changed.',
    ...rules.filter((rule) => rule.enabled !== false).map((rule) => `Rule ${rule.name ?? rule.id} (${rule.id}) now reads: ${rule.instruction}`),
    'The mandate you were given stands: finish the current assignment within it, and take on nothing outside it.',
  ].join('\n')
}

/** End the unit; ending is final. */
function end(unit, by, outcome, at) {
  return {
    ...withAssignments(unit, unit.assignments.map((assignment) =>
      assignment.state === 'ended' ? assignment : { ...assignment, state: 'ended', endedAt: at, endedReason: outcome })),
    state: 'ended',
    ended: { at, by, outcome },
    undelivered: [],
    updatedAt: at,
  }
}

/**
 * Whether a report reaches Partner. A `ready` result, a blocker, a failure and a
 * question do; `progress` is execution detail and stays internal, the `waiting`
 * a silent turn produces asks nothing, and `dropped` ends a unit without
 * spending wish's attention.
 * @param report the report state, and whether it asks a question
 */
export function pushes(incoming) {
  if (incoming.question) return true
  return ['ready', 'blocked', 'failed'].includes(incoming.state)
}
