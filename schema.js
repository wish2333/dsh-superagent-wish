/**
 * Record schemas and the domain spec of the working unit tables.
 *
 * A record schema here only has to provide `parse(value)`, which is what the
 * storage domain calls when it loads stored records. The checks are written out
 * rather than imported so this module loads without the Host packages, which the
 * packaged plugin resolves from its own profile.
 */

/** A failure of one record against its schema; `path` names the field. */
export class RecordInvalid extends Error {
  constructor(path, message) {
    super(path ? `${path} ${message}` : message)
    this.name = 'RecordInvalid'
    this.path = path
  }
}

const fail = (path, message) => {
  throw new RecordInvalid(path, message)
}

const checkString = (value, path) => {
  if (typeof value !== 'string') fail(path, `expected a string but got ${JSON.stringify(value)}`)
  return value
}

const checkOneOf = (value, allowed, path) => {
  if (!allowed.includes(value)) fail(path, `expected one of ${allowed.join(', ')} but got ${JSON.stringify(value)}`)
  return value
}

const checkObject = (value, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object')
  return value
}

/**
 * A record schema over `fields`, an object of field name to its check.
 * A field whose check returns `undefined` because the value is absent stays
 * absent, so an optional field costs no storage.
 */
function record(fields) {
  return {
    parse(value) {
      const source = checkObject(value, '')
      const result = {}
      for (const [name, check] of Object.entries(fields)) {
        const checked = check(source[name], name)
        if (checked !== undefined) result[name] = checked
      }
      return result
    },
  }
}

/** A nested record's check, which reports a bad field under the field that holds it. */
const nested = (inner) => (value, path) => {
  if (value === undefined) return undefined
  try {
    return inner.parse(value)
  } catch (error) {
    if (error instanceof RecordInvalid) fail(path ? `${path}.${error.path}` : error.path, error.message.replace(/^\S+ /, ''))
    throw error
  }
}

const requiredString = (value, path) => checkString(value, path)
const requiredOneOf = (...allowed) => (value, path) => checkOneOf(value, allowed, path)
const optionalString = (value, path) => (value === undefined ? undefined : checkString(value, path))
/** A string once it is known, `null` while it is not: delivered input waits to be read. */
const nullableString = (value, path) => (value === undefined || value === null ? value : checkString(value, path))
const stringList = (value, path) => {
  if (!Array.isArray(value)) fail(path, 'expected a list of strings')
  return value.map((item, index) => checkString(item, `${path}[${index}]`))
}

const rulesList = (value, path) => {
  if (!Array.isArray(value)) fail(path, 'expected a list of rules')
  return value.map((rule, index) => nested(record({
    id: requiredString,
    name: optionalString,
    enabled: (enabled, field) => {
      if (enabled === undefined) return undefined
      if (typeof enabled !== 'boolean') fail(field, 'expected true or false')
      return enabled
    },
    instruction: requiredString,
  }))(rule, `${path}[${index}]`))
}

/** A model a dispatch named: the provider and model id, with an optional reasoning effort. */
const optionalModel = (value, path) => {
  if (value === undefined) return undefined
  const parsed = record({ provider: requiredString, model: requiredString, reasoningEffort: optionalString }).parse(value)
  return { provider: parsed.provider, model: parsed.model, ...(parsed.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.reasoningEffort }) }
}

const reportFields = {
  state: requiredOneOf('progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'),
  summary: requiredString,
  at: requiredString,
  // The Session that sent the report: a Worker Session, or the executor for a
  // `waiting` it added to a turn that ended without one.
  source: optionalString,
}

const workingUnitRecord = record({
  id: requiredString,
  type: requiredOneOf('discoverer', 'implementer'),
  state: requiredOneOf('running', 'waiting-for-decision', 'waiting-for-input', 'ended'),
  title: requiredString,
  source: requiredString,
  // The Partner Session this unit hangs on, the Worker Session it runs in, and
  // the one directory that Session keeps from its first delivery to its last.
  partnerSessionId: requiredString,
  workerSessionId: requiredString,
  directory: requiredString,
  // The model a dispatch named, if it named one: a queued unit selects it when
  // it starts, so the choice outlives the call that made it.
  model: optionalModel,
  // The ids of the unit's rows; each row lives in its own table.
  inputs: stringList,
  undelivered: stringList,
  assignments: stringList,
  mandate: requiredString,
  createdAt: requiredString,
  updatedAt: requiredString,
  ended: nested(record({
    at: requiredString,
    by: requiredOneOf('executor', 'human'),
    outcome: requiredString,
  })),
})

const inputRecord = record({
  id: requiredString,
  unitId: requiredString,
  text: requiredString,
  source: requiredString,
  at: requiredString,
  // A notice that the policy changed carries its kind and both versions; a
  // plain input carries neither.
  kind: optionalString,
  ref: optionalString,
  from: optionalString,
  to: optionalString,
  rules: (value, path) => (value === undefined ? undefined : rulesList(value, path)),
  deliveredTo: optionalString,
  readAt: nullableString,
})

const assignmentRecord = record({
  id: requiredString,
  unitId: requiredString,
  state: requiredOneOf('pending', 'running', 'ended'),
  createdAt: requiredString,
  startedAt: optionalString,
  endedAt: optionalString,
  endedReason: optionalString,
  report: nested(record(reportFields)),
})

const mandateRecord = record({
  unitId: requiredString,
  // The authorization: the work the unit was dispatched with, and everything a
  // later input widened it by. `scope` is what the Worker is authorized to do.
  scope: requiredString,
  // What the scope was before the last widening, oldest first; empty until one.
  previousScopes: (value, path) => {
    if (value === undefined) return []
    const scopes = stringList(value, path)
    for (const [index, scope] of scopes.entries()) {
      if (!scope.trim()) fail(`${path}[${index}] must not be empty`)
    }
    return scopes
  },
  strength: requiredOneOf('explicit', 'inferred'),
  policyVersion: requiredString,
  basis: requiredString,
})

/**
 * An event a source observed, and where it went.
 *
 * The row is written by the source as it reads the event, before anyone judges
 * it, so an event that arrives while no Secretary exists is still on record.
 * `status` then says what happened to it: `pending` waits for a judgement,
 * `dropped` records that it was judged not to open a unit, `opened` names the
 * unit it opened, and `recorded` is a patrol's observation, which opens nothing.
 */
const sourceEventRecord = record({
  id: requiredString,
  source: requiredOneOf('files', 'schedule'),
  kind: requiredOneOf('file', 'ignored', 'patrol'),
  // `ref` is the file's path, or the schedule source's patrol; `key` is the
  // stable identity a file is recognised by on the next read.
  ref: requiredString,
  key: requiredString,
  status: requiredOneOf('pending', 'dropped', 'opened', 'recorded'),
  at: requiredString,
  text: requiredString,
  handling: optionalString,
  size: (value, path) => {
    if (value === undefined) return undefined
    if (!Number.isInteger(value) || value < 0) fail(path, 'expected a byte count')
    return value
  },
  mtimeMs: (value, path) => {
    if (value === undefined) return undefined
    if (!Number.isFinite(value)) fail(path, 'expected a modification time')
    return value
  },
  observedAt: optionalString,
  // What a judgement decided: the reason it dropped the event, or the unit it opened.
  reason: optionalString,
  unitId: optionalString,
  // The Partner conversation whose Secretary judged it, and when it reached a decision.
  principal: optionalString,
  judgedAt: optionalString,
})

/** Record schemas by table name; the storage domain validates every stored row with them. */
export const workingUnitTables = {
  working_units: workingUnitRecord,
  inputs: inputRecord,
  assignments: assignmentRecord,
  mandates: mandateRecord,
  source_events: sourceEventRecord,
}

/** Domain name; must match the Host's `^[a-z][a-z0-9_]*$`. */
export const DOMAIN_NAME = 'working_units'

const sourcesRecord = (value, path) => {
  checkObject(value, path)
  return Object.fromEntries(Object.entries(value).map(([id, config]) => [id, checkObject(config, `${path}.${id}`)]))
}

/**
 * The policy record's fields. A field that names a block of the policy is the
 * block's storage; the record also keeps the version derived from those blocks
 * and when it was last written.
 */
const policyRecord = record({
  rules: rulesList,
  sources: sourcesRecord,
  // The Partner conversation external events are judged for; absent until a
  // source or the rules were saved from one.
  principal: optionalString,
  version: requiredString,
  updatedAt: requiredString,
})

/** Record schemas of the policy table; the policy store validates every row with them. */
export const policyTables = {
  policy: policyRecord,
}
