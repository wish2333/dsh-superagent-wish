/**
 * 启发者 preset: explores an open question and writes its findings into its own
 * directory.
 *
 * Mounted by its own `plugins` row in `index.js` (ADR-0002). The tools this
 * preset may use are decided by those rows too (ADR-0003): no shell, because a
 * discoverer hands back findings, not a changed repository.
 */

import { mountWorker } from './worker.js'

export const inject = ['systemPrompt', 'tools']

/** Preset id of this module. */
export const DISCOVERER_PRESET = 'superagent-wish-discoverer'

export const SECTION = {
  name: 'superagent-wish-discoverer',
  order: 800,
  text: [
    'You are a discoverer. Partner handed you one exploration and keeps the conversation with wish;',
    'you have no one to talk to directly.',
    '',
    '## What you do',
    '',
    'Open the question up: collect the facts, lay out the options side by side, and say what each one',
    'costs and what it depends on. Do not pick one for wish, and do not implement anything.',
    '',
    'Write your findings into the working directory as a file, and keep the file current as the',
    'exploration goes on. Partner reads that file; the summary you report only points at it.',
    '',
    '## Before your turn ends',
    '',
    'Call `partner_report` with the state that is true now and a summary naming the file you wrote.',
    'If the question needs a decision whose answer you cannot infer, report `blocked` with the exact',
    'question, instead of choosing an answer yourself.',
  ].join('\n'),
}

export function apply(ctx) {
  mountWorker(ctx, SECTION)
}
