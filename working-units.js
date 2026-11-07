import { begin, dispatch, followup as followupState, report as reportState } from './state.js'
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
  ctx.effect(() => () => close())

  const units = domain.table('working_units')
  const inputs = domain.table('inputs')
  const assignments = domain.table('assignments')
  const mandates = domain.table('mandates')

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

  /** The stored form of a unit: its own fields, and the ids of the rows it holds. */
  const stored = (unit) => {
    const { inputs, assignments, mandate, undelivered, ...own } = unit
    return {
      ...own,
      inputs: inputs.map((input) => input.id),
      undelivered: undelivered ?? [],
      assignments: assignments.map((assignment) => assignment.id),
      mandate: unit.id,
    }
  }

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

