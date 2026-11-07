/**
 * Manager role: registers the Partner, Secretary and two Worker presets.
 *
 * Each preset's `plugins` rows name subpaths of this package (ADR-0002) plus the
 * Host tool plugins that preset may use (ADR-0003). A preset that does not list
 * a tool plugin does not get its tools, so the whitelist is the row list itself;
 * no restriction is applied to an inherited global set.
 */

import { sharedStore } from './working-units.js'
import { apply as applySources, applySchedule } from './sources.js'
import { applyJudge } from './judge.js'
import { watchPartnerSessions } from './secretary.js'
import { sharedPolicy } from './policy.js'
import { slotsFrom } from './queue.js'
import { configureSlots, openPump, pumpFor, registeringPump } from './pump.js'

export const inject = ['agentPresets', 'storageDomain']

export const PRESETS = [
  {
    id: 'superagent-wish-sources',
    name: '事件源',
    description: 'Reads the watched directories and records what its files and the patrol observe',
    order: 5,
    subpath: 'sources',
    // Reading a directory is all it does; the one tool it calls records the patrol.
    tools: [],
  },
  {
    id: 'superagent-wish-partner',
    name: 'Partner',
    description: 'Partner collaboration mode: talks with wish, dispatches work, keeps the working units',
    order: 10,
    subpath: 'partner',
    tools: [],
  },
  {
    id: 'superagent-wish-secretary',
    name: 'Secretary',
    description: 'Judges whether an incoming file or scheduled event should become a working unit',
    order: 20,
    subpath: 'secretary',
    tools: [],
  },
  {
    id: 'superagent-wish-discoverer',
    name: '启发者',
    description: 'Exploration worker: writes its findings into its own directory and reports back to Partner',
    order: 30,
    subpath: 'worker-discoverer',
    tools: [
      '@deepseek-ai/dsh-tool-fs',
      { name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      '@deepseek-ai/dsh-tool-web',
      { name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    ],
  },
  {
    id: 'superagent-wish-implementer',
    name: '执行者',
    description: 'Delivery worker: produces artifacts for a task spec, reports back to Partner',
    order: 40,
    subpath: 'worker-implementer',
    tools: [
      '@deepseek-ai/dsh-tool-fs',
      { name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      '@deepseek-ai/dsh-tool-web',
      { name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
      '@deepseek-ai/dsh-tool-bash',
    ],
  },
]

/** @returns the `plugins` row that mounts preset subpath `subpath` of this package. */
export function presetRow(subpath) {
  return { name: `@wish2333/dsh-superagent-wish/${subpath}` }
}

/** @returns every `plugins` row preset `preset` mounts, its own module first. */
export function presetRows(preset) {
  return [
    presetRow(preset.subpath),
    ...(preset.tools ?? []).map((tool) => (typeof tool === 'string' ? { name: tool } : { ...tool })),
  ]
}

/**
 * Open the working unit tables on this plugin's scope.
 *
 * The tables are shared by every preset, and a preset's services live in its own
 * realm, so the manager owns the one handle. `ctx.effect` releases it on unload.
 *
 * @param ctx the plugin context, which must provide `storageDomain`
 * @returns a promise of the store, or undefined when the Host has no storage domain
 */
function openStore(ctx) {
  if (!ctx.storageDomain) return undefined
  // Returned rather than awaited, so `apply` stays synchronous like every other
  // insert; the opening closes its own domain when it fails.
  return sharedStore(ctx).catch((error) => {
    ctx.logger?.warn(`superagent-wish: the working unit tables did not open: ${error.message}`)
    throw error
  })
}

/**
 * Run one judgement pass now, as the manager's loop does every period.
 *
 * The loop runs on its own timer; a caller that recorded events and wants them
 * judged without waiting for the next period uses this instead.
 *
 * @param ctx a context that provides `storageDomain` and `sessionController`
 * @returns the event ids this pass woke a Secretary for
 */
export async function judgeNow(ctx) {
  const judge = await openJudge()
  return judge.judge(ctx)
}

/** The judgement module, loaded on first use so the manager stays a thin registration. */
let judgeModule
function openJudge() {
  judgeModule ??= import('./judge.js')
  return judgeModule
}

/**
 * The plugin configuration.
 *
 * `implementerSlots` is how many implementers may run at once; the default is
 * two (`DEFAULT_IMPLEMENTER_SLOTS` in `queue.js`). A discoverer never takes a
 * slot, and a wish follow-up never waits for one. The value is read when the
 * plugin loads; a value outside the accepted range falls back to the default
 * rather than failing the plugin, because a bad number must not stop dispatch.
 *
 * DSH passes the bundle patch's config to `apply(ctx, config)`, so
 * `implementerSlots` is set there:
 *
 *     - name: @wish2333/dsh-superagent-wish
 *       config:
 *         implementerSlots: 3
 */
export function slotsOf(config) {
  return slotsFrom(config?.implementerSlots)
}

/**
 * Put the schedule source's patrol task in line with the policy as it stands.
 *
 * A task survives a restart and a period edited by Partner edits that task, so
 * this runs once on load to resume a paused one or to open the task a policy
 * saved before the Host could open it.
 */
function applyScheduleFromPolicy(ctx) {
  // An `async` body, so a throw before the first await is caught like one after it.
  // The Host may have no Schedule service at all, and then the source is saved
  // and its events are read, but no task opens; the warning says which.
  const open = async () => {
    // The medium is read once, here, so a host without one fails in `open` rather than in `sharedPolicy`.
    if (!ctx.storageDomain) throw new Error('the Host provides no storageDomain service')
    const policy = await sharedPolicy(ctx)
    await applySchedule(ctx, policy.current().sources.schedule)
  }
  open()
    .catch((error) => {
      const message = `superagent-wish: the patrol task could not be opened: ${error?.message ?? String(error)}`
      // The manager's own loader has no logger; a warning here must not become an unhandled rejection.
      if (ctx.logger?.warn) ctx.logger.warn(message)
      else console.warn(message)
    })
}

export function apply(ctx, config) {
  // `apply` stays synchronous like every other insert, so the opening runs on
  // its own; a caller that needs the store awaits `openStore(ctx)` itself.
  const opened = openStore(ctx)
  opened?.catch(() => {})
  const slots = slotsOf(config)
  configureSlots(ctx.storageDomain, slots)
  // The pump starts queued units and re-pumps on load, so a queue left by a
  // restart continues without waiting for the next dispatch.
  const started = opened
    ? opened.then((store) => {
      const pump = openPump(ctx, store, () => slots)
      // Every other scope reaches this pump through the medium it was opened over.
      pumpFor(ctx.storageDomain, pump)
      registeringPump(ctx.storageDomain, Promise.resolve(pump))
      return pump.pump().then(() => pump)
    })
    : undefined
  started?.catch((error) => ctx.logger?.warn(`superagent-wish: the dispatch queue did not start: ${error.message}`))
  // The event sources are mounted by their own preset rows; the manager starts
  // the judgement loop, which wakes a Secretary for an event another scope's
  // source recorded, and the patrol task the policy asks for.
  //
  // The services these two read are named here rather than read off `ctx`:
  // Cordis refuses a read of an injected name it has not provided. A Host
  // without a Schedule service reads no event and opens no task, so the
  // callback waits for one; a save says so where it would need it.
  ctx.inject(['storageDomain', 'sessionController', 'schedule'], (scheduleCtx) => {
    applyJudge(scheduleCtx)
    applyScheduleFromPolicy(scheduleCtx)
  })
  // A Secretary starts beside every new Partner Session. The listener lives
  // here, not in the Secretary module: a preset's rows load only when that
  // preset mounts, so a listener in `secretary.js` could never start the first
  // Secretary — it would run only after one already existed.
  ctx.inject(['agents', 'sessionController'], (secretaryCtx) => {
    watchPartnerSessions(secretaryCtx)
  })
  for (const preset of PRESETS) {
    const registration = ctx.agentPresets.register({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      order: preset.order,
      plugins: presetRows(preset),
    })
    if (registration && typeof registration.then === 'function') {
      ctx.effect(() => registration.then((dispose) => dispose))
    }
  }
  return { store: opened, pump: started }
}
