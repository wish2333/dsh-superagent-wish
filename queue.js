/**
 * Which implementer may start now.
 *
 * A discoverer never takes a slot: it reads and writes in its own directory and
 * asks nothing of the machine. An implementer takes one while its worker runs,
 * and a wish follow-up never waits behind one: wish's own words are not work
 * the limit is meant to bound.
 *
 * Two rules decide a placement:
 *
 * - no more implementers than the configured slots, and
 * - one directory runs one implementer: two workers writing the same files
 *   would overwrite each other.
 *
 * The store holds the queue, so a restart continues it; this module only
 * decides, from the units the store holds, which queued unit may start.
 */

/** Slots an implementer may occupy at once; the default the manager applies. */
export const DEFAULT_IMPLEMENTER_SLOTS = 2

/** The most slots a configuration may ask for; beyond this a personal setup is not the use case. */
export const MAX_IMPLEMENTER_SLOTS = 16

/**
 * Read a slot count from configuration. A number must be a whole number in
 * range; anything else falls back to the default, so a bad value cannot stop
 * dispatch.
 * @param value the configured value, or undefined
 * @returns the slot count to use
 */
export function slotsFrom(value) {
  const count = typeof value === 'string' && value.trim() ? Number(value) : value
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMPLEMENTER_SLOTS) return DEFAULT_IMPLEMENTER_SLOTS
  return count
}

/**
 * Whether `unit` occupies a slot: an implementer whose worker was started and
 * has not ended. A unit waiting in the queue is `running` in its own state —
 * its first assignment is open — but its worker was never told, so it takes
 * nothing.
 */
export function takesSlot(unit) {
  if (unit.type !== 'implementer' || unit.state === 'ended') return false
  return unit.assignments.some((assignment) => assignment.state === 'running')
}

/**
 * The units whose implementer holds a slot now: those running, oldest first.
 * A waiting unit holds no slot even before its worker is told, because it has
 * no work in hand.
 * @param units every unit the store holds
 * @returns the units holding a slot
 */
export function occupying(units) {
  return units.filter(takesSlot).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * The next unit that may start, from the queue `queued`.
 *
 * A queued unit starts when a slot is free and no unit occupies its directory.
 * Queue order is the order the units were opened, so a unit is not passed over
 * for a later one in another directory; a unit whose directory is busy waits
 * while the ones behind it may go.
 *
 * @param queued the units waiting to start, oldest first
 * @param units every unit the store holds
 * @param slots the implementer slot count
 * @returns the first unit that may start, or undefined when none may
 */
export function nextToStart(queued, units, slots) {
  const holding = occupying(units)
  const busyDirectories = new Set(holding.map((unit) => unit.directory))
  const free = Math.max(0, slots - holding.length)
  return queued.find((unit) => {
    // A discoverer takes no slot, but its directory still runs one worker.
    if (busyDirectories.has(unit.directory)) return false
    return unit.type === 'discoverer' || free > 0
  })
}

/**
 * The units waiting to start: open implementers whose worker was never told.
 * @param units every unit the store holds
 * @returns the queued units, oldest first
 */
export function queued(units) {
  return units
    .filter((unit) => unit.state !== 'ended' && hasPending(unit) && !takesSlot(unit))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * Whether `unit` has an assignment waiting to start. A unit whose last
 * assignment ended has nothing to start: it waits for an input, which opens a
 * new assignment, and it is not in the queue until then.
 */
export function hasPending(unit) {
  return unit.assignments.some((assignment) => assignment.state === 'pending')
}
