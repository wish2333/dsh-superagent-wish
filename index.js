/**
 * Manager role: registers the Partner, Secretary and two Worker presets.
 *
 * Each preset's `plugins` rows name subpaths of this package (ADR-0002) plus the
 * Host tool plugins that preset may use (ADR-0003). A preset that does not list
 * a tool plugin does not get its tools, so the whitelist is the row list itself;
 * no restriction is applied to an inherited global set.
 */

import { openWorkingUnits } from './working-units.js'

export const inject = ['agentPresets', 'storageDomain']

export const PRESETS = [
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
export function openStore(ctx) {
  if (!ctx.storageDomain) return undefined
  // Returned rather than awaited, so `apply` stays synchronous like every other
  // insert; the opening closes its own domain when it fails.
  return openWorkingUnits(ctx).catch((error) => {
    ctx.logger?.warn(`superagent-wish: the working unit tables did not open: ${error.message}`)
    throw error
  })
}

export function apply(ctx) {
  // `apply` stays synchronous like every other insert, so the opening runs on
  // its own; a caller that needs the store awaits `openStore(ctx)` itself.
  openStore(ctx)?.catch(() => {})
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
}
