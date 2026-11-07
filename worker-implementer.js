/**
 * Implementer preset: delivery work. Carries the write tools the discoverer
 * omits; the whitelist stays the boundary, not a directory restriction.
 */

import { WORKER_RULES, WORKER_TOOLS } from './worker-shared.js'

import { report } from './report.js'
import { REPORT_TOOL } from './tools.js'

export const inject = ['systemPrompt', 'tools']

export const IMPLEMENTER_TOOLS = [...WORKER_TOOLS, 'write', 'edit', 'bash']

export const IMPLEMENTER_PROMPT = `${WORKER_RULES}

### 你的职责

按 task spec 产出交付物。goal、scope、context、deliverables 四段都已给出，照做，不扩大范围。

交付物完成后报 \`ready\`，摘要里写清产出路径。部分完成但受阻塞时报 \`blocked\`，不要报 \`ready\`。`

export function apply(ctx) {
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'superagent-wish-implementer',
      order: 50,
      text: IMPLEMENTER_PROMPT,
    }),
  )
  ctx.effect(() => ctx.tools.register(REPORT_TOOL, { execute: (args, exec) => report(ctx, args, exec) }))
  ctx.effect(() => ctx.tools.restrict({ allow: IMPLEMENTER_TOOLS }))
}
