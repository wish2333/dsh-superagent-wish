/**
 * Manager role: registers the Partner, discoverer and implementer presets.
 *
 * Each preset's `plugins` rows name subpaths of this package (ADR-0002) plus the
 * Host tool plugins that preset may use (ADR-0003). A preset that does not list
 * a tool plugin does not get its tools, so the whitelist is the row list itself;
 * no restriction is applied to an inherited global set.
 */

export const inject = ['agentPresets']

export const PRESETS = [
  {
    id: 'superagent-wish-recruiter',
    name: 'Partner',
    description: 'Partner collaboration mode: topic anchoring, layered requirement building, dispatch by thinking mode',
    order: 10,
    subpath: 'partner',
    tools: [],
  },
  {
    id: 'superagent-wish-discoverer',
    name: '启发者',
    description: 'Exploration worker: read-only, reports options and blind spots back to Partner',
    order: 20,
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
    order: 30,
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

export function apply(ctx) {
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
