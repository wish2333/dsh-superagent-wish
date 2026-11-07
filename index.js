/**
 * Manager role: registers the Partner, discoverer and implementer presets.
 *
 * Each preset's `plugins` row names a subpath of this package (ADR-0002), so a
 * preset's tools are registered on its own scope and cannot leak to another
 * preset. The manager itself registers no model-facing tool.
 */

export const inject = ['agentPresets']

export const PRESETS = [
  {
    id: 'superagent-wish-recruiter',
    name: 'Partner',
    description: 'Partner collaboration mode: topic anchoring, layered requirement building, dispatch by thinking mode',
    order: 10,
    subpath: 'partner',
  },
  {
    id: 'superagent-wish-discoverer',
    name: '启发者',
    description: 'Exploration worker: read-only, reports options and blind spots back to Partner',
    order: 20,
    subpath: 'worker-discoverer',
  },
  {
    id: 'superagent-wish-implementer',
    name: '执行者',
    description: 'Delivery worker: produces artifacts for a task spec, reports back to Partner',
    order: 30,
    subpath: 'worker-implementer',
  },
]

/** @returns the `plugins` row that mounts preset `subpath` of this package. */
export function presetRow(subpath) {
  return { name: `@wish2333/dsh-superagent-wish/${subpath}` }
}

export function apply(ctx) {
  for (const preset of PRESETS) {
    const registration = ctx.agentPresets.register({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      order: preset.order,
      plugins: [presetRow(preset.subpath)],
    })
    if (registration && typeof registration.then === 'function') {
      ctx.effect(() => registration.then((dispose) => dispose))
    }
  }
}
