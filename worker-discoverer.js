/**
 * Discoverer preset: read-only exploration.
 *
 * The tool set is the preset's own `plugins` rows, not a restriction on an
 * inherited set (ADR-0003): a preset that does not list `dsh-tool-bash` cannot
 * run it. There is no write tool here, so exploration cannot produce side effects.
 */

import { report } from './report.js'
import { WORKER_RULES } from './worker-shared.js'
import { REPORT_TOOL } from './tools.js'

export const inject = ['systemPrompt', 'tools']

/** The Host tool plugins a worker preset mounts; the two roles differ by this list. */
export const DISCOVERER_TOOL_PLUGINS = [
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-todo',
]

/** Tool names these plugins provide, for tests and for documentation. */
export const DISCOVERER_TOOLS = ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'partner_report']

export const DISCOVERER_PROMPT = `${WORKER_RULES}

### 你的职责

探索选项、发散思路、挑战假设，不产出文件。没有写入工具，不要尝试写文件或跑命令。

回答遵循 exploratory prompt 的三段结构：背景、焦点、要求。给出选项时要列出每个选项的代价，不只列好处。`

export function apply(ctx) {
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'superagent-wish-discoverer',
      order: 50,
      text: DISCOVERER_PROMPT,
    }),
  )
  ctx.effect(() => ctx.tools.register({ ...REPORT_TOOL, execute: (args, exec) => report(ctx, args, exec) }))
}
