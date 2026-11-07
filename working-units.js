import { affectedByPolicyChange, begin, dispatch, followup as followupState, policyChanged as policyChangedState, report as reportState } from './state.js'
import { DOMAIN_NAME, workingUnitTables } from './schema.js'

/** Domain and table names must match the Host's `^[a-z][a-z0-9_]*$`. */
const NAME = /^[a-z][a-z0-9_]*$/

/**
 * Declare the domain over the record schemas, in the shape
 * `ctx.storageDomain.open` takes and `defineDomain` produces.
 *
 * The checks mirror `defineDomain` in `@deepseek-ai/dsh-storage-domain` (name
 * shape, non-negative integer version), so a bad declaration fails at module
 * load here rather than at open. The package is not imported: it ships with the
 * Host, not with this plugin, and `node --test` runs without it.
 */
function declareDomain() {
  const spec = {
    name: DOMAIN_NAME,
    version: 1,
    tables: Object.fromEntries(
      Object.entries(workingUnitTables).map(([name, valueSchema]) => [name, { valueSchema }]),
    ),
  }
  if (!NAME.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${NAME}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`domain '${spec.name}' version must be a non-negative integer`)
  for (const table of Object.keys(spec.tables)) {
    if (!NAME.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${NAME}`)
  }
  return spec
}

/** The domain specification the store opens. */
export const workingUnitDomain = declareDomain()

/** The unit missing from a transition request. */
export class UnknownWorkingUnit extends Error {
  constructor(id) {
    super(`Unknown working unit ${id}`)
    this.name = 'UnknownWorkingUnit'
    this.id = id
  }
}

/**
 * Open the tables and return the operations Partner and the executor call.
 *
 * Every operation reads the unit and its rows, applies one transition, and
 * writes the changed rows before resolving: a write is durable when its call
 * returns, so the next call reading the medium sees it.
 *
 * The caller owns the handle and closes it on unload: `ctx.effect` registers the
 * disposer here, and the store also exposes `close()` for a caller that unloads
 * before the effect runs.
 *
 * @param ctx the plugin context; it must provide `storageDomain`
 * @returns the store
 */
export async function openWorkingUnits(ctx) {
  const domain = await ctx.storageDomain.open(workingUnitDomain)
  let closed
  const close = () => (closed ??= Promise.resolve(domain.close()))
  ctx.effect(() => () => { void close() })

  const units = domain.table('working_units')
  const inputs = domain.table('inputs')
  const assignments = domain.table('assignments')
  const mandates = domain.table('mandates')
  const events = domain.table('source_events')

  /** Read one unit with its rows, in the shape the state machine takes. */
  const read = (id) => {
    const record = units.get(id)
    if (!record) throw new UnknownWorkingUnit(id)
    const { unitId: _unitId, ...mandate } = mandates.get(record.mandate) ?? { unitId: record.mandate }
    return {
      ...record,
      mandate,
      inputs: (record.inputs ?? []).map((inputId) => inputs.get(inputId)).filter(Boolean),
      assignments: (record.assignments ?? []).map((assignmentId) => assignments.get(assignmentId)).filter(Boolean),
    }
  }

  /**
   * The stored form of a unit: its own fields, and the ids of the rows it holds.
   * The unit's `mandate` is its authorization, so the row is named by the unit id.
   */
  const stored = ({ inputs, assignments, undelivered, ...own }) => ({
    ...own,
    inputs: inputs.map((input) => input.id),
    undelivered: undelivered ?? [],
    assignments: assignments.map((assignment) => assignment.id),
    mandate: own.id,
  })

  /** Write the rows one transition changed, before the caller sees the result. */
  const write = async (unit) => {
    for (const input of unit.inputs) await inputs.put(input.id, { ...input, unitId: unit.id })
    for (const assignment of unit.assignments) await assignments.put(assignment.id, { ...assignment, unitId: unit.id })
    await mandates.put(unit.id, { ...unit.mandate, unitId: unit.id })
    const record = stored(unit)
    await units.put(record.id, record)
    return unit
  }

  const at = () => new Date().toISOString()

  return {
    /** The next id a dispatch issues; a deleted unit's id is never reused. */
    nextId() {
      // Count past the highest stored number, so a reloaded domain continues the
      // sequence rather than repeating an id a deleted unit once held.
      const highest = [...units.keys()]
        .map((key) => Number(/^unit-(\d+)$/.exec(key)?.[1]))
        .filter((number) => Number.isFinite(number))
        .reduce((a, b) => Math.max(a, b), 0)
      return `unit-${highest + 1}`
    },

    /**
     * Start a unit under a mandate Partner created for it, with its first input.
     *
     * The Worker Session id and the directory are the caller's to name; the
     * store only records what the Host was told, so a reloaded plugin reads back
     * the Session and directory a unit actually has.
     *
     * @param unit `id`, `type`, `title`, `text`, `source`, `partnerSessionId`,
     *   `workerSessionId`, `directory`, `scope`, `strength`, `policyVersion`, `basis`
     */
    async dispatch(unit) {
      const now = at()
      const { text, source = 'wish', scope, strength: s = 'explicit', policyVersion, basis = 'wish', ...fields } = unit
      const started = begin(
        { ...fields, source, createdAt: now, updatedAt: now },
        { scope, strength: s, policyVersion, basis },
      )
      return write(followupState(started, { text, source, at: now }))
    },

    /** Add input to an open unit and queue it. */
    async followup(id, incoming) {
      const unit = read(id)
      return write(followupState(unit, { ...incoming, at: incoming?.at ?? at() }))
    },

    /** Record a worker report and apply it. */
    async report(id, incoming) {
      const unit = read(id)
      return write(reportState(unit, { ...incoming, at: incoming?.at ?? at() }))
    },

    /** Stop the running assignment; the unit keeps its state. */
    async stop(id, reason) {
      const unit = read(id)
      return write(dispatch(unit, { state: 'stop', at: at(), endedReason: reason }))
    },

    /** Mark the latest pending assignment running. */
    async start(id) {
      const unit = read(id)
      return write(dispatch(unit, { state: 'start', at: at() }))
    },

    /**
     * Record that the policy changed on every unit it bears on, oldest first, so
     * their notices queue in the order the units were opened. A unit that ended,
     * or that was opened under the rules now in force, is left alone; no unit's
     * mandate changes, and no unit's state does.
     *
     * @param change `from`, `to` and the `rules` the policy now holds
     * @returns the ids of the units it notified, in order
     */
    async policyChanged(change) {
      const when = at()
      const notified = []
      for (const id of this.list().map((unit) => unit.id)) {
        const unit = read(id)
        if (!affectedByPolicyChange(unit, change.from, change.to)) continue
        await write(policyChangedState(unit, { ...change, at: when }))
        notified.push(id)
      }
      return notified
    },

    /** Record that input reached the worker. */
    async deliver(id, inputIds) {
      const unit = read(id)
      return write(dispatch(unit, { state: 'deliver', inputIds, at: at() }))
    },

    /** Record that the worker read input. */
    async read(id, inputIds) {
      const unit = read(id)
      return write(dispatch(unit, { state: 'read', inputIds, at: at() }))
    },

    /**
     * Record one event a source observed, unless its id is already recorded.
     *
     * The row is written before anything judges the event, so an event that
     * arrives while no Secretary exists is still read by the next one.
     *
     * @param event the event, with `id`, `source`, `kind`, `ref`, `key`,
     *   `status`, `at`, `text` and its source's own fields
     * @returns the stored row, and `fresh`: whether this call wrote it
     */
    async observe(event) {
      const stored_ = events.get(event.id)
      if (stored_) return { event: stored_, fresh: false }
      const row = { ...event, at: event.at ?? at() }
      await events.put(row.id, row)
      return { event: row, fresh: true }
    },

    /** Every event a source recorded, oldest first. */
    events() {
      return [...events.entries()].map(([, event]) => event).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    },

    /** The events that wait for a judgement, oldest first. */
    pendingEvents() {
      return this.events().filter((event) => event.status === 'pending')
    },

    /**
     * Record what a judgement decided for an event.
     *
     * @param id the event id
     * @param decision `status` — `dropped` or `opened` — with `reason` and
     *   `unitId` where they apply, and `principal`, the Partner conversation
     *   whose Secretary decided
     * @returns the row after the decision
     */
    async judgeEvent(id, decision) {
      const event = events.get(id)
      if (!event) throw new Error(`no source event ${id}`)
      const row = { ...event, ...decision, judgedAt: decision.judgedAt ?? at() }
      await events.put(id, row)
      return row
    },

    /** One source event, or undefined. */
    event(id) {
      return events.get(id)
    },

    /** The last observation a patrol recorded, or undefined before the first one. */
    lastPatrol() {
      return this.events().filter((event) => event.kind === 'patrol').at(-1)
    },

    /**
     * The events judged not to open a unit, newest first, and at most `limit`.
     * @param options `limit`, the most rows to return
     */
    droppedEvents({ limit = 20 } = {}) {
      return this.events()
        .filter((event) => event.status === 'dropped')
        .sort((a, b) => (b.judgedAt ?? b.at).localeCompare(a.judgedAt ?? a.at))
        .slice(0, limit)
    },

    /** One unit with its inputs and assignments, or undefined. */
    get(id) {
      return units.get(id) ? read(id) : undefined
    },

    /** Release the domain. Idempotent, and also run by the effect on unload. */
    close,

    /** Every unit, in creation order. */
    list() {
      return [...units.entries()]
        .map(([id]) => read(id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },
  }
}


/**
 * One store per storage medium, shared by every scope that opens it.
 *
 * The plugin opens its tables from the manager, from the Partner preset and from
 * each Worker preset, and those are separate scopes: a store each would be a
 * separate handle over the same records, and a write on one would not be what
 * the others read. One handle per medium keeps every scope on the same rows,
 * which is what the queue's pump depends on.
 */
const stores = new WeakMap()

/**
 * The store for `ctx`'s medium, opened once.
 *
 * The domain is released by the first opener's `ctx.effect`, so it lives as long
 * as the plugin; a later caller joins the same handle.
 *
 * @param ctx a plugin context that provides `storageDomain`
 * @returns the shared store
 */
export function sharedStore(ctx) {
  const medium = ctx.storageDomain
  if (!stores.has(medium)) stores.set(medium, openWorkingUnits(ctx))
  return stores.get(medium)
}
