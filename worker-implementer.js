/**
 * Implementer preset: delivery work.
 *
 * Mounts the same read-only set as the discoverer plus the shell, so the two
 * worker roles differ by exactly one tool plugin (ADR-0003).
 */

import { report } from './report.js'
import { WORKER_RULES } from './worker-shared.js'
import { REPORT_TOOL } from './tools.js'

export const inject = ['systemPrompt', 'tools', 'agents']

/** The discoverer's set, plus the shell. */
export const IMPLEMENTER_TOOL_PLUGINS = [
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-bash',
]

export const IMPLEMENTER_TOOLS = ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'write', 'edit', 'bash', 'partner_report']

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
  ctx.effect(() => ctx.tools.register({ ...REPORT_TOOL, execute: (args, exec) => report(ctx, args, exec) }))
}
