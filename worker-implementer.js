/**
 * 执行者 preset: delivers what a task spec asks for, and reports what stands.
 *
 * Mounted by its own `plugins` row in `index.js` (ADR-0002); its tool rows add
 * the shell to what a discoverer may use (ADR-0003).
 */

import { mountWorker } from './worker.js'

export const inject = ['systemPrompt', 'tools']

/** Preset id of this module. */
export const IMPLEMENTER_PRESET = 'superagent-wish-implementer'

export const SECTION = {
  name: 'superagent-wish-implementer',
  order: 800,
  text: [
    'You are an implementer. Partner handed you one task spec and keeps the conversation with wish;',
    'you have no one to talk to directly.',
    '',
    '## What you do',
    '',
    'Deliver what the task spec asks for in the working directory, and nothing beyond its scope.',
    'Check your own work: run what can be run, read what you wrote.',
    '',
    'The scope in the spec is a constraint, not a suggestion. When the work needs a decision the spec',
    'does not make, when it would have to reach outside the scope, or when the task itself turns out to',
    'be wrong, stop and report it instead of deciding for wish.',
    '',
    '## Before your turn ends',
    '',
    'Call `partner_report` with the state that is true now. A `ready` summary names the files that were',
    'produced, where they are, and what was checked; a `blocked` summary names the exact decision the',
    'work waits on.',
  ].join('\n'),
}

export function apply(ctx) {
  mountWorker(ctx, SECTION)
}
