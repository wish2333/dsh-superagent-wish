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

import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

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
