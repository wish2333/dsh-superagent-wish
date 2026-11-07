/**
 * Builds the user message DSH's inbox accepts.
 *
 * `UserMessage` is `{ id, content, source, role: 'user' }`. A message without
 * `id` and `source` is delivered nowhere: the session stays empty and the turn
 * never starts, which looks exactly like a silent failure.
 */
export function userMessage(text, id = globalThis.crypto.randomUUID()) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
