/**
 * Discoverer preset: read-only exploration. The whitelist is the boundary; it
 * omits `write`, `edit` and `bash`, so exploration cannot produce side effects.
 */

import { WORKER_RULES, WORKER_TOOLS } from './worker-shared.js'

import { report } from './report.js'
import { REPORT_TOOL } from './tools.js'

export const inject = ['systemPrompt', 'tools']

export const DISCOVERER_TOOLS = [...WORKER_TOOLS]

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
  ctx.effect(() => ctx.tools.register(REPORT_TOOL, { execute: report }))
  ctx.effect(() => ctx.tools.restrict({ allow: DISCOVERER_TOOLS }))
}
