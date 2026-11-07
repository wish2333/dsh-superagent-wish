/**
 * The event sources: what a file in a watched directory or a due patrol turns
 * into, before the Secretary judges it.
 *
 * Two sources exist, and each has one config block under the policy's
 * `sources`, so the policy version already covers a change to either:
 *
 *   sources.files    = { enabled, config: { directories, types } }
 *   sources.schedule = { enabled, config: { everySeconds } }
 *
 * A block is written only through the Partner's setup tool, which validates
 * it here first, so a block that cannot run is never stored.
 *
 * A source reads its events and hands each one to {@link openIntake}, which
 * records it as a row of `source_events`; the Secretary judges the rows that
 * wait.
 */

import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { sharedPolicy } from './policy.js'
import { sharedStore } from './working-units.js'

/** Config block id of the file source. */
export const FILES = 'files'

/** Config block id of the scheduled source. */
export const SCHEDULE = 'schedule'

/** Every source id, in the order the setup tool lists them. */
export const SOURCE_IDS = [FILES, SCHEDULE]

/**
 * What a file of a matched type asks for by default:
 *
 * - `open`: the Secretary judges it and may open a working unit;
 * - `ask`: the Secretary records it for wish to decide, and opens nothing by itself;
 * - `ignore`: it is recorded as dropped, without the Secretary judging it.
 */
export const TYPE_DISPOSITIONS = ['open', 'ask', 'ignore']

/** What a patrol may say about the watched directories. */
export const PATROL_REPORT_MODES = ['always', 'change']

/** The shortest patrol period: the floor the Host puts on a repeating schedule. */
export const MIN_EVERY_SECONDS = 60

/** The longest patrol period: a day. */
export const MAX_EVERY_SECONDS = 86_400

/** The patrol period a schedule source is started with before the setup tool sets one. */
export const DEFAULT_EVERY_SECONDS = 900

/** A short stable key over a string, so a record can name one observation in its id. */
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)

/** The id of a patrol at `at` over `key`: the instant and the observation, and a suffix when the store already holds it. */
function uniqueId(at, key, store) {
  const base = `patrol:${at}:${hash(key)}`
  let id = base
  for (let n = 2; store.event(id); n += 1) id = `${base}#${n}`
  return id
}

/** A configuration the source refuses; the message names the field that is wrong. */
export class ConfigInvalid extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigInvalid'
  }
}

const fail = (message) => {
  throw new ConfigInvalid(message)
}

/** A path a source may read: absolute, with no `..`, so a block names one place. */
function absolutePath(value, field) {
  if (typeof value !== 'string' || !value.startsWith('/')) fail(`${field} must be an absolute path starting with '/', but it reads ${JSON.stringify(value)}`)
  if (value.split('/').includes('..')) fail(`${field} must not hold a '..' segment`)
  return value.replace(/\/+$/, '') || '/'
}

/** A file-type rule: one suffix (or `*` for any file), and what a file of it asks for. */
function fileType(value, index) {
  const field = `types[${index}]`
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  const match = value.match
  if (typeof match !== 'string' || !match.trim()) fail(`${field}.match must be a suffix such as '.md', or '*' for any file`)
  if (!TYPE_DISPOSITIONS.includes(value.defaultHandling)) {
    fail(`${field}.defaultHandling must be one of ${TYPE_DISPOSITIONS.join(', ')}, but it reads ${JSON.stringify(value.defaultHandling)}`)
  }
  const note = value.note === undefined ? '' : value.note
  if (typeof note !== 'string') fail(`${field}.note must be text`)
  return { match: match.trim(), defaultHandling: value.defaultHandling, note }
}

/**
 * Validate and normalize the files source's config.
 *
 * @param config the block's `config`
 * @returns `{ directories, types }` as stored
 */
export function filesConfig(config) {
  const source = config ?? {}
  const directories = source.directories ?? []
  if (!Array.isArray(directories)) fail('directories must be a list of absolute paths')
  const types = source.types ?? []
  if (!Array.isArray(types)) fail('types must be a list of file-type rules')
  return {
    directories: directories.map((directory, index) => absolutePath(directory, `directories[${index}]`)),
    types: types.map(fileType),
  }
}

/** The file-type rule that applies to `path`, the first whose suffix matches, or undefined. */
export function typeOf(types, path) {
  const suffix = extname(path).toLowerCase()
  return types.find((type) => type.match === '*' || type.match.toLowerCase() === suffix)
}

/**
 * The scheduled source's config: how often the directories are patrolled, and
 * what a patrol reports.
 *
 * A patrol reads the watched directories. `report: 'always'` records every
 * patrol, so a period with nothing to see is still a row; `'change'` records
 * only a patrol whose observation differs from the last one recorded.
 */
export function scheduleConfig(config) {
  const source = config ?? {}
  const every = source.everySeconds ?? DEFAULT_EVERY_SECONDS
  if (!Number.isInteger(every) || every < MIN_EVERY_SECONDS || every > MAX_EVERY_SECONDS) {
    fail(`everySeconds must be a whole number from ${MIN_EVERY_SECONDS} to ${MAX_EVERY_SECONDS}, but it reads ${JSON.stringify(source.everySeconds)}`)
  }
  const report = source.report ?? 'change'
  if (!PATROL_REPORT_MODES.includes(report)) fail(`report must be one of ${PATROL_REPORT_MODES.join(', ')}, but it reads ${JSON.stringify(source.report)}`)
  return { everySeconds: every, report }
}

/** The validator of each source's config. */
const VALIDATORS = { [FILES]: filesConfig, [SCHEDULE]: scheduleConfig }

/** The defaults a source is configured with before the setup tool wrote a block for it. */
export const DEFAULT_CONFIGS = Object.freeze({
  [FILES]: Object.freeze({ directories: [], types: [] }),
  [SCHEDULE]: Object.freeze({ everySeconds: DEFAULT_EVERY_SECONDS, report: 'change' }),
})

/**
 * Validate and normalize one source's config block.
 *
 * @param id the source id, `files` or `schedule`
 * @param value the block `{ enabled, config }`; a field left out keeps what was stored
 * @param previous the block stored before, whose values an omitted field keeps
 * @returns the block as stored
 */
export function sourceBlock(id, value, previous = {}) {
  const validate = VALIDATORS[id]
  if (!validate) fail(`unknown source ${JSON.stringify(id)}; the sources are ${SOURCE_IDS.join(' and ')}`)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('a source block must be an object with enabled and config')
  const enabled = value.enabled ?? previous.enabled ?? true
  if (typeof enabled !== 'boolean') fail('enabled must be true or false')
  const merged = { ...(previous.config ?? DEFAULT_CONFIGS[id]), ...(value.config ?? {}) }
  for (const key of ['directories', 'types']) {
    // A list is replaced, never merged: an omitted one keeps the stored list, and an empty one clears it.
    if (value.config && key in value.config) merged[key] = value.config[key]
  }
  return { enabled, config: validate(merged) }
}

/** The file a watched directory holds, as the file source sees it. */
function fileEvent(directory, name, info, types) {
  const path = join(directory, name)
  const type = typeOf(types, path)
  // A file no type rule claims is not opened: the saved rules did not say what such a file asks for.
  if (!type) return undefined
  const kind = type.defaultHandling === 'ignore' ? 'ignored' : 'file'
  return {
    id: kind === 'ignored' ? `ignored:${path}` : `file:${path}:${info.size}:${Math.trunc(info.mtimeMs)}`,
    kind,
    // A read file waits for its judgement; one the saved setup ignores is dropped as it is read.
    status: kind === 'ignored' ? 'dropped' : 'pending',
    ...(kind === 'ignored' ? { reason: 'The saved setup ignores this file type, so it was not judged.' } : {}),
    judgedAt: kind === 'ignored' ? new Date(info.mtimeMs).toISOString() : undefined,
    // The identity a processed file keeps: the same path, unchanged in size and modification time, is the same file.
    ref: path,
    key: `${path}|${info.size}|${Math.trunc(info.mtimeMs)}`,
    size: info.size,
    mtimeMs: Math.trunc(info.mtimeMs),
    handling: type.defaultHandling,
    observedAt: new Date(info.mtimeMs).toISOString(),
  }
}

/**
 * Read one watched directory and return the files in it that a type rule claims.
 *
 * @param ctx the reading context; `logger` takes a directory that could not be read
 * @param directory the absolute path to read
 * @param types the file-type rules
 * @returns the file events, in name order
 */
export async function readDirectory(ctx, directory, types) {
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    // A directory that is not there yet is not an error: it is made when the first file is put in it.
    if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`superagent-wish: the watched directory ${directory} could not be read: ${String(error)}`)
    return []
  }
  const events = []
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const path = join(directory, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      const event = fileEvent(directory, name, info, types)
      if (event) events.push(event)
    } catch {
      // A file that went away between the listing and the read is not there to open.
    }
  }
  return events
}

/**
 * What one patrol observes: each watched directory, how many files it holds and
 * how many of them a type rule claims. The report says which watched place the
 * patrol read, so its record is readable on its own; it is not a file event.
 *
 * @param ctx the reading context
 * @param config the files source's config
 * @returns the directory facts, in configured order
 */
export async function observeDirectories(ctx, config) {
  const watched = []
  for (const directory of config.directories) {
    let names = []
    try {
      names = await readdir(directory)
    } catch {
      watched.push({ directory, present: false, files: 0, claimed: 0 })
      continue
    }
    let files = 0
    let claimed = 0
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      try {
        const info = await stat(join(directory, name))
        if (!info.isFile()) continue
        files += 1
        if (typeOf(config.types, name)) claimed += 1
      } catch {
        // The file went away; it is not there to count.
      }
    }
    watched.push({ directory, present: true, files, claimed })
  }
  return watched
}

/** The text a `file` event is judged by, as the Secretary reads it. */
export function fileText(event, type) {
  const where = basename(event.ref)
  return [
    `A file arrived in a watched directory: ${event.ref}`,
    `Name: ${where}. Size: ${event.size} bytes. Type rule: ${type?.match ?? 'none'} — default handling ${event.handling}.`,
    type?.note ? `What the saved setup says about this type: ${type.note}` : '',
  ].filter(Boolean).join('\n')
}

// --- the sources on a Host ---------------------------------------------------

/**
 * Read one source's events now and record the new ones.
 *
 * A source that is off, or that watches nothing yet, reads nothing. Each event
 * is stored under a stable id, so reading the same place twice records one row,
 * and a file whose size or modification time changed is a new event.
 *
 * @param ctx the context the directories are read with
 * @param store the open working-unit tables
 * @param id the source id
 * @param block the source's config block
 * @returns the events this read recorded, in order
 */
export async function run(ctx, store, id, block, { principal } = {}) {
  if (!block?.enabled || id !== FILES) return []
  const written = []
  for (const directory of block.config.directories) {
    for (const event of await readDirectory(ctx, directory, block.config.types)) {
      const row = {
        ...event,
        source: FILES,
        ...(principal ? { principal } : {}),
        text: fileText(event, typeOf(block.config.types, event.ref)),
      }
      const { event: stored, fresh } = await store.observe(row)
      if (fresh) written.push(stored)
    }
  }
  return written
}

/** How often the file source reads its directories, in milliseconds. */
export const FILE_POLL_MS = 2000

/** The pollers running on each medium, so a test reads the directories now instead of waiting for the next period. */
const pollers = new WeakMap()

/**
 * Read every source's directories now, as the next poll would.
 * @param ctx the context the stores open on
 */
export async function poll(ctx) {
  const running = pollers.get(ctx.storageDomain)?.read
  return running ? running() : []
}

/** The task title the schedule source creates. */
export const PATROL_TITLE = 'superagent-wish: patrol watched directories'

/**
 * The prompt `ctx.schedule` delivers for one patrol.
 *
 * The delivery wakes a Secretary conversation, so the prompt asks for one tool
 * call and nothing else: the patrol records itself, and the Secretary talks to
 * nobody about a period with nothing to see.
 */
export const PATROL_PROMPT = 'Run one partner_patrol. It records what the patrol observed and returns; do not reply to wish or start any other work.'

/** The schedule state of each medium: the task id, and the period it was opened with. */
const scheduleState = new WeakMap()

/** @returns `{ id, everySeconds }` for `medium`'s schedule source, edited on the first use. */
function stateOf(medium) {
  if (!scheduleState.has(medium)) scheduleState.set(medium, {})
  return scheduleState.get(medium)
}

/**
 * Bring the schedule source's task in line with `block`.
 *
 * The task is created once and then edited: a new period edits the same task
 * rather than opening a second one, and a source turned off pauses its task, so
 * a later save of the same period does not open a second task either.
 *
 * @param ctx the context `ctx.schedule` reaches the Host through
 * @param block the schedule source's config block
 * @returns the task id now on record, or undefined when the source is off
 */
export async function applySchedule(ctx, block) {
  const state = stateOf(ctx.storageDomain)
  const schedule = ctx.schedule
  if (!schedule) return state.id
  if (!block?.enabled) {
    if (state.id && !state.paused) {
      await schedule.edit({ id: state.id, action: 'pause' }).catch(() => {})
      state.paused = true
    }
    return state.id
  }
  const everySeconds = block.config.everySeconds
  if (state.id) {
    if (!state.paused && state.everySeconds === everySeconds) return state.id
    await schedule.edit({
      id: state.id,
      action: 'update',
      patch: { timing: { kind: 'every', everySeconds }, active: true },
    }).catch(() => {})
    Object.assign(state, { everySeconds, paused: false })
    return state.id
  }
  const task = await schedule.create({
    title: PATROL_TITLE,
    prompt: PATROL_PROMPT,
    timing: { kind: 'every', everySeconds },
    target: { kind: 'new_once', create: { agentPreset: 'superagent-wish-secretary' } },
  })
  Object.assign(state, { id: task?.id, everySeconds, paused: false })
  return state.id
}

/**
 * Record one patrol: what the watched directories hold, as of now.
 *
 * The observation opens nothing and wakes nobody. It is recorded when
 * `report` is `always`, or when it differs from the last observation on record
 * — a file put in a directory, or taken out of one, since the last patrol.
 *
 * @param ctx the context the directories are read with
 * @param store the open working-unit tables
 * @param block the schedule source's config block
 * @param files the files source's config block
 * @returns the row recorded, or undefined when this patrol is not recorded
 */
export async function recordPatrol(ctx, store, block, files) {
  const every = block?.config?.everySeconds ?? DEFAULT_EVERY_SECONDS
  const mode = block?.config?.report ?? 'change'
  const watched = files?.enabled ? await observeDirectories(ctx, files.config) : []
  const key = JSON.stringify(watched)
  // Read after the directories, not before: two patrols a tick apart must not share the instant the reading took.
  const at = new Date().toISOString()
  const text = watched.length
    ? watched.map((item) => (item.present
      ? `${item.directory}: ${item.files} file(s), ${item.claimed} of a watched type`
      : `${item.directory}: not there`)).join('\n')
    : 'No watched directory is set, so the patrol observed nothing.'
  const row = {
    // The observation and its instant name the row. Two observations in one millisecond (`change`)
    // or two recorded in one millisecond (`always`) still each get their own row.
    id: uniqueId(at, key, store),
    source: SCHEDULE,
    kind: 'patrol',
    ref: 'watched directories',
    key,
    status: 'recorded',
    at,
    text,
    observedAt: at,
    everySeconds: every,
  }
  const last = store.lastPatrol()
  if (mode === 'change' && last && last.key === key) return undefined
  const { event } = await store.observe(row)
  return event
}

/**
 * The file source as its preset row mounts it: it reads its directories on a
 * timer, and records what changed.
 *
 * Why a timer rather than `ctx.schedule`: a schedule task always delivers its
 * prompt to a conversation and wakes that turn (`dsh-schedule` lib/index.js
 * `send`: `agent.followup(message)` and then `sessions.flush`), and its target
 * is resolved before the task is stored (`create` → `resolveTarget(request.target
 * ?? { kind: 'new_once' })`), so no task exists without a conversation. Reading a
 * watched directory must record a row and wake nobody, which only the plugin's
 * own timer can do inside `ctx.effect`.
 */
export function apply(ctx) {
  const read = async () => {
    try {
      const store = await sharedStore(ctx)
      const policy = await sharedPolicy(ctx)
      const current = policy.current()
      return await run(ctx, store, FILES, current.sources[FILES], { principal: current.principal })
    } catch (error) {
      ctx.logger?.warn?.(`superagent-wish: the file source could not read its directories: ${String(error)}`)
      return []
    }
  }
  if (ctx.storageDomain && typeof ctx.storageDomain === 'object') pollers.set(ctx.storageDomain, { read })
  ctx.effect(() => {
    const timer = setInterval(() => { void read() }, FILE_POLL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  })
  return read
}
