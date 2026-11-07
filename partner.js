/**
 * Partner preset: the collaboration prompt and the four tools that manage a
 * working unit — dispatch, follow up, stop, list.
 *
 * Mounted only by the Partner preset row (ADR-0002), so no Worker Session ever
 * sees these tools. The tools read the worker services inside a child scope that
 * declares them, and the store opens inside a child scope that declares
 * `storageDomain`: a Host without one of those leaves the tool absent instead of
 * failing the preset.
 */

import { advance } from './advance.js'
import { reannotate, setPrincipal } from './judge.js'
import { savePolicy, sharedPolicy } from './policy.js'
import { applySchedule, SOURCE_IDS, sourceBlock } from './sources.js'
import { openPump, slotsFor } from './pump.js'
import { nextToStart, slotsFrom } from './queue.js'
import { turnEnded } from './relay.js'
import { sharedStore } from './working-units.js'
import { deliver, describe, ensureWorker, selectModel, stop, unitDirectory, WORKER_TYPES, workerSessionId } from './sessions.js'

export const inject = ['systemPrompt', 'tools', 'storageDomain']

/** Host services the dispatch chain reads. Cordis refuses a read of an undeclared service. */
export const WORKER_SERVICES = ['sessionController', 'workspaceRegistry', 'permissionPresets', 'agents', 'workingDirectory']

/** Host services the store opens over. */
export const STORE_SERVICES = ['storageDomain']

const quoted = (value) => JSON.stringify(value)

/**
 * A tool result: the sentence the model reads, and the record it describes.
 * `output.render` above turns exactly those content blocks into the result.
 */
function textResult(text, record) {
  return { content: [{ type: 'text', text }], ...(record === undefined ? {} : { record }) }
}

/** One readable sentence for a refusal; the tool reports it as the result text. */
function refused(reason) {
  return { content: [{ type: 'text', text: reason.replace(/\s+/g, ' ').trim() }] }
}

/**
 * The `output` block DSH requires of every registration: the record's schema,
 * and the render that turns it into the blocks the model reads.
 */
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => (Array.isArray(value?.content)
    ? value.content
    : [{ type: 'text', text: String(value) }]),
}

/** The states a working unit holds, with the meaning Partner needs to read them. */
export const STATE_MEANINGS = {
  running: 'the worker is working through the unit\'s input',
  'waiting-for-decision': 'the worker reported ready; the result waits for wish to accept it',
  'waiting-for-input': 'the worker reported blocked or failed, or its turn was stopped; it waits for an input to continue',
  ended: 'the unit is finished; a new piece of the same work needs a new unit',
}

const LIST_STATES = Object.entries(STATE_MEANINGS).map(([state, meaning]) => `${state} — ${meaning}`).join('; ')

/** `2h 10m` for a span between two ISO instants; `0m` inside the first minute. */
export function since(iso, now) {
  const millis = Math.max(0, now - Date.parse(iso))
  const minutes = Math.floor(millis / 60_000)
  if (minutes < 1) return '0m'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes % 60 ? `${minutes % 60}m` : ''].filter(Boolean).join(' ')
}

/** The list line for one unit: name, type, state and how long it has been in that state. */
export function describeUnit(unit, now = Date.now(), { history = false } = {}) {
  const since_ = unit.state === 'ended' ? unit.ended?.at : unit.updatedAt
  const line = {
    id: unit.id,
    name: unit.title,
    type: unit.type,
    state: unit.state,
    since: since_ ? `${since(since_, now)} ${unit.state === 'ended' ? 'ago' : 'in this state'}` : 'unknown',
    sinceAt: since_ ?? null,
  }
  const notices = (unit.inputs ?? [])
    .filter((input) => input.kind === 'policy-changed')
    .map((input) => ({ from: input.from, to: input.to }))
  if (history && notices.length) line.policyNotices = notices
  // What the unit may do, and what it was authorized for before an input widened it.
  line.scope = { current: unit.mandate?.scope ?? '', previous: unit.mandate?.previousScopes ?? [] }
  const report = unit.assignments.at(-1)?.report
  if (report) line.lastReport = { state: report.state, summary: report.summary }
  if (unit.undelivered?.length) line.queuedInputs = unit.undelivered.length
  return line
}

export const DISPATCH_TOOL = {
  name: 'partner_dispatch',
  description: [
    'Start a working unit: hand one job to a Worker that keeps its own directory and session.',
    'Use it only after wish agrees to the job. Returns the working unit id; every later call names that id, never a session id.',
    'The worker type decides how the job is done: discoverer explores open questions and writes its findings to its own directory; implementer delivers a task spec.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: [...WORKER_TYPES],
        description: 'Worker type: discoverer while the options are still open, implementer once the direction is agreed.',
      },
      title: {
        type: 'string',
        description: 'Short name of the job, in wish\'s words. It names the Worker session; the directory is named after the working unit id and never changes.',
      },
      body: {
        type: 'string',
        description: 'What the Worker reads first: the exploratory prompt for a discoverer, or the task spec for an implementer, already written out.',
      },
      model: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: 'Model provider, such as deepseek.' },
          model: { type: 'string', description: 'Model id at that provider.' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort id for that model.' },
        },
        required: ['provider', 'model'],
        description: 'Optional model for this Worker. Omit it to use the session default.',
      },
    },
    required: ['type', 'title', 'body'],
  },
  output,
}

export const FOLLOWUP_TOOL = {
  name: 'partner_followup',
  description: [
    'Add input to an existing working unit and send it to that unit\'s Worker.',
    'The Worker keeps its session, its directory and what it already did; the input arrives after what it was already given. Partner does not confirm again and no directory is made.',
    'Use it whenever wish refines, corrects or adds to a job that is already running or waiting. It also continues a unit that was stopped.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      unitId: { type: 'string', description: 'The working unit id partner_dispatch returned, such as unit-3.' },
      text: { type: 'string', description: 'The addition, in wish\'s words: what to change, add or answer.' },
    },
    required: ['unitId', 'text'],
  },
  output,
}

export const STOP_TOOL = {
  name: 'partner_stop',
  description: [
    'Stop the current assignment of a working unit by cancelling the Worker\'s turn.',
    'The unit itself stays: what was delivered remains in its directory, and a later partner_followup continues the same unit in the same session.',
    'Use it when wish wants this round to end without discarding the work.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      unitId: { type: 'string', description: 'The working unit id partner_dispatch returned.' },
      reason: { type: 'string', description: 'Optional short reason, kept with the assignment.' },
    },
    required: ['unitId'],
  },
  output,
}

export const LIST_TOOL = {
  name: 'partner_list',
  description: [
    'List the working units and what each one is doing, and the external events the Secretary judged not worth a unit. Read-only: it changes nothing.',
    'Each unit reports its name, type, state, and how long it has been in that state.',
    `States: ${LIST_STATES}.`,
    'A unit is waiting for wish when its state is waiting-for-decision or waiting-for-input; the last report it sent is shown with it.',
    'Ended units are left out unless includeEnded is true: the open work is what Partner needs, and a unit that has ended shows its result and when it ended when asked for.',
    'The dropped events are the files and patrols the Secretary judged and opened nothing for, newest first. Each shows when it was dropped, which source and file it was, and the reason as the Secretary gave it.',
    'A Secretary that judged wrongly is visible here: wish sets the rules with partner_setup and the next event is judged by the new ones.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeEnded: {
        type: 'boolean',
        description: 'Include the units that ended. Defaults to false, which lists only the open work.',
      },
      droppedLimit: {
        type: 'integer',
        description: 'How many dropped events to show at most. Defaults to 20.',
      },
    },
    required: [],
  },
  output,
}

export const SETUP_TOOL = {
  name: 'partner_setup',
  description: [
    'Read or change how external events are judged. Read-only when nothing is passed; every rule and every source configuration changes here.',
    'Two sources feed the Secretary: files put into watched directories, and a schedule that patrols those directories on a period.',
    'For a file source, config holds directories (absolute paths), types (a list of { match, defaultHandling, note }), and for a schedule, everySeconds.',
    'Rules are the text the Secretary judges by, one per judgement. A change takes effect on the next judgement, without a restart.',
    'A change is made for the conversation you are in: its Secretary judges the events the new setup lets in, so name no Session.',
    'Read it before changing it, and change one source or the rules at a time. A configuration that cannot run is refused and nothing is saved.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      settings: {
        type: 'object',
        additionalProperties: false,
        description: 'Omit the whole object to read the current setup. One of source or rules per call.',
        properties: {
          source: {
            type: 'string',
            enum: ['files', 'schedule'],
            description: 'The source whose config to save: files watches directories, schedule patrols them on a period.',
          },
          config: {
            type: 'object',
            additionalProperties: true,
            description: 'The source config. files: { directories, types: [{ match, defaultHandling, note }] }. schedule: { everySeconds, report }. enabled is set with the block.',
          },
          enabled: { type: 'boolean', description: 'Whether the source runs. Defaults to keeping what was stored.' },
          rules: {
            type: 'array',
            description: 'The judging rules, replacing all of them. Each is { id, name, enabled, instruction }: the instruction is the rule text the Secretary reads.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: 'Short stable id, such as inbox-notes. A later notice names the rule by it.' },
                name: { type: 'string', description: 'Optional short name for the rule.' },
                enabled: { type: 'boolean', description: 'Whether the rule is in force. Defaults to true.' },
                instruction: { type: 'string', description: 'The rule text: when a working unit is opened, and what to do when it is not.' },
              },
              required: ['id', 'instruction'],
            },
          },
        },
        required: [],
      },
    },
    required: [],
  },
  output,
}

export const TOOLS = [DISPATCH_TOOL, FOLLOWUP_TOOL, STOP_TOOL, LIST_TOOL, SETUP_TOOL]

/**
 * A Partner tool body: errors become one readable sentence, never a thrown
 * failure, and every result carries text content blocks only.
 */
function guarded(body) {
  return async (args, exec) => {
    try {
      return await body(args ?? {}, exec)
    } catch (error) {
      return refused(describe(error))
    }
  }
}

/**
 * `partner_dispatch`: steps 0–6 of the chain, then the unit is recorded.
 *
 * Refused before anything is created: an unknown worker type, a call from a
 * Session that Partner cannot read, and a model the Host does not have. The
 * unit is recorded only after the Worker opened, so a failed dispatch leaves no
 * unit behind.
 */
export async function dispatch(ctx, store, policy, slots, args, exec, options = {}) {
  // A dispatch from Partner's own conversation names wish as its origin; one a
  // judgement opens names the external event that asked for it.
  const origin = options.origin ?? 'wish'
  const session = exec?.agent?.id
  if (!session) {
    return refused('Dispatch refused: this call carries no calling session, so a Worker would have no one to report to.')
  }
  const type = String(args.type ?? '')
  if (!WORKER_TYPES.includes(type)) {
    return refused(`Dispatch refused: unknown worker type "${type}". Use ${WORKER_TYPES.join(' or ')}.`)
  }
  const title = String(args.title ?? '').trim()
  const body = String(args.body ?? '').trim()
  if (!title) return refused('Dispatch refused: a working unit needs a title.')
  if (!body) return refused('Dispatch refused: a working unit needs its first input.')

  const serviceMissing = WORKER_SERVICES.find((name) => !ctx[name])
  if (serviceMissing) return refused(`Dispatch refused: the Host provides no ${serviceMissing} service, so no Worker session can be opened.`)

  const id = store.nextId()
  const unit = {
    id,
    type,
    title,
    partnerSessionId: session,
    workerSessionId: workerSessionId(id),
    directory: unitDirectory(ctx, exec.agent.session, id),
  }

  // The model is chosen before the Session is opened, so a model the Host does
  // not have is refused without creating an unusable Worker. A queued unit
  // records it, and the pump selects it when the unit starts.
  let model
  if (args.model) {
    model = { provider: String(args.model.provider ?? ''), model: String(args.model.model ?? '') }
    if (args.model.reasoningEffort) model.reasoningEffort = String(args.model.reasoningEffort)
    if (typeof ctx.sessionController.selectModel !== 'function') {
      return refused('Dispatch refused: this Host cannot select a model, so omit model and use the session default.')
    }
  }

  // Whether this unit may start now is the queue's answer, given the units the
  // store holds. A dispatch that may start is started by this call, so a Host
  // that refuses the Worker leaves no unit behind and Partner reads why; one
  // that may not is recorded and waits, and the pump starts it on a free slot.
  const units = store.list()
  const candidate = { ...unit, type, assignments: [{ state: 'pending' }], state: 'running' }
  const mayStart = nextToStart([candidate], units, slots)?.id === id
  const created = mayStart
    ? await startNow(ctx, store, { ...unit, text: body, model, policyVersion: policy.version(), source: origin }, { session: exec.agent.session })
    : await store.dispatch({
      ...unit,
      text: body,
      source: origin,
      // The authorization is what the Worker was told to do. The title only
      // names the unit, and says nothing about what it may do.
      scope: body,
      strength: 'explicit',
      // The version the policy has now, so a later rule change can tell which
      // units were opened under rules the current policy no longer states.
      policyVersion: policy.version(),
      basis: 'wish',
      ...(model ? { model } : {}),
    })

  if (mayStart) {
    // A dispatch that started may have freed nothing, but a queued unit ahead
    // of it can go on a slot this one did not take (a discoverer).
    await advance(ctx, () => openPump(ctx, store, () => slots))
    return textResult(id, describeUnit(created, Date.now(), 'started'))
  }
  await advance(ctx, () => openPump(ctx, store, () => slots))
  return textResult(id, describeUnit(store.get(id) ?? created, Date.now(), 'queued'))
}

/**
 * Record the unit and start its Worker in one call: the unit is written only
 * after the Worker opened, so a Host that refuses the Worker leaves no unit.
 *
 * @param ctx the Partner context
 * @param store the open tables
 * @param unit the dispatch's fields, with `text`, `model` and `policyVersion`
 * @param options `session`, the Partner Session
 * @returns the started unit
 */
async function startNow(ctx, store, unit, { session }) {
  const { agent } = await ensureWorker(ctx, unit, { session })
  ctx.permissionPresets.set(agent.session, 'danger-full-access')
  await ctx.sessionController.rename({ sessionId: unit.workerSessionId, title: unit.title })
  if (unit.model) {
    try {
      await selectModel(ctx, unit.workerSessionId, unit.model)
    } catch (error) {
      throw new Error(`the model ${unit.model.provider}/${unit.model.model} is not available (${describe(error)})`)
    }
  }
  const created = await store.dispatch({
    ...unit,
    source: unit.source ?? 'wish',
    // The dispatch's first input is what a queued unit was authorized for too.
    scope: unit.text,
    strength: 'explicit',
    basis: 'wish',
  })
  // The first input reaches the Worker only after its unit exists, so a report
  // cannot arrive before the unit it belongs to.
  const first = created.undelivered.map((inputId) => created.inputs.find((input) => input.id === inputId)).find(Boolean)
  if (first) await deliver(ctx, created, first, session)
  // The first input is on its way, so the assignment it runs is running, and
  // the report or the turn end that answers it has a round to belong to.
  const started = await store.start(created.id)
  if (first) await store.deliver(started.id, [first.id])
  return store.get(started.id)
}

/** Record one dispatch's working unit under the policy now in force. */
function record(store, policy, unit) {
  return {
    ...unit,
    text: body,
  }
}



/**
 * `partner_followup`: queue one input and send it to the unit's current Worker.
 *
 * No confirmation and no directory work: the unit already has both. A Worker
 * Session deleted outside the plugin is opened again from the unit id.
 *
 * An ended unit is not continued either way, but the refusal says which of the
 * two it is: the policy that holds the unit's mandate still holds it, so the
 * unit is simply finished, or the policy no longer holds it, so the mandate
 * would not be valid even if the unit were opened again.
 */
export async function followup(ctx, store, policy, args, exec) {
  const unitId = String(args.unitId ?? '').trim()
  const text = String(args.text ?? '').trim()
  if (!text) return refused('Follow-up refused: there is no text to send.')
  const unit = store.get(unitId)
  if (!unit) return refused(`Follow-up refused: there is no working unit ${unitId}.`)
  if (unit.state === 'ended') {
    if (!policy.revalidate(unit.mandate)) {
      return refused(`Follow-up refused: working unit ${unitId} ended, and the policy no longer holds its mandate, so it stays ended. Start a new working unit for this work.`)
    }
    return refused(`Follow-up refused: working unit ${unitId} has ended. Start a new working unit for new work.`)
  }

  // Input on a unit that was waiting reopens it: the tables move it to running
  // and open the assignment the new input will run under.
  const updated = await store.followup(unitId, { text, source: 'wish' })
  const input = updated.inputs.at(-1)
  await deliver(ctx, updated, input, exec?.agent?.session)
  await store.start(unitId)
  return textResult(`Sent to ${unitId}. It now holds ${updated.undelivered.length} input${updated.undelivered.length === 1 ? '' : 's'} waiting for the Worker.`, describeUnit(updated))
}

/**
 * `partner_stop`: cancel the Worker's turn. The unit keeps its state, its
 * directory and its queued input, and the next follow-up continues it.
 */
export async function stopUnit(ctx, store, slots, args) {
  const unitId = String(args.unitId ?? '').trim()
  const unit = store.get(unitId)
  if (!unit) return refused(`Stop refused: there is no working unit ${unitId}.`)
  if (unit.state === 'ended') return refused(`Stop refused: working unit ${unitId} has already ended.`)
  const cancelled = stop(ctx, unit)
  await store.stop(unitId, args.reason ? String(args.reason) : 'stopped by wish')
  // The stop ended the assignment, so it gave a slot back: a queued unit starts.
  await advance(ctx, () => openPump(ctx, store, () => slots))
  return textResult(
    cancelled
      ? `Stopped ${unitId}: its worker's turn was cancelled. The unit and its directory remain; partner_followup continues it.`
      : `Stopped ${unitId}: no worker was running. The unit and its directory remain; partner_followup continues it.`,
    describeUnit(store.get(unitId)),
  )
}

/** The `rules` a call passes, validated, with every field the policy record holds. */
function rulesOf(value) {
  if (!Array.isArray(value)) throw new Error('rules must be a list of rule objects')
  const ids = new Set()
  return value.map((rule, index) => {
    const field = `rules[${index}]`
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${field} must be an object`)
    const id = String(rule.id ?? '').trim()
    const instruction = String(rule.instruction ?? '').trim()
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error(`${field}.id must be a short identifier of letters, digits, '-' or '_'`)
    if (ids.has(id)) throw new Error(`the rule id ${id} appears twice`)
    ids.add(id)
    if (!instruction) throw new Error(`${field}.instruction is the rule text and must not be empty`)
    const rule_ = { id, instruction }
    if (rule.name !== undefined) rule_.name = String(rule.name)
    rule_.enabled = rule.enabled !== false
    return rule_
  })
}

/** One readable line per source block, or one saying the block is not set yet. */
function describeSource(id, block) {
  if (!block) return `${id}: not set (off)`
  const { enabled, config } = block
  if (id === 'files') {
    const directories = config.directories.length ? config.directories.join(', ') : 'none'
    const types = config.types.length
      ? config.types.map((type) => `${type.match} → ${type.defaultHandling}${type.note ? ` (${type.note})` : ''}`).join('; ')
      : 'none'
    return `files: ${enabled ? 'on' : 'off'}; directories ${directories}; types ${types}`
  }
  return `schedule: ${enabled ? 'on' : 'off'}; every ${config.everySeconds}s; reports ${config.report}`
}

/**
 * `partner_setup`: read the setup, or save one part of it.
 *
 * The rules and the two source blocks are the policy's blocks, so they are
 * saved through the policy record and a change moves its version; the working
 * units that are still open hear of the change as they do of any other.
 */
export async function setup(ctx, store, policy, args, exec) {
  const settings = args.settings
  if (settings === undefined) {
    const current = policy.current()
    const lines = [
      'Rules:',
      ...(current.rules.length
        ? current.rules.map((rule) => `- ${rule.id}${rule.name ? ` (${rule.name})` : ''}: ${rule.enabled === false ? 'off — ' : ''}${rule.instruction}`)
        : ['- none']),
      'Sources:',
      ...SOURCE_IDS.map((id) => `- ${describeSource(id, current.sources[id])}`),
    ]
    return textResult(lines.join('\n'))
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be an object')
  const saving = settings.rules !== undefined ? 'rules' : settings.source !== undefined ? 'source' : undefined
  const extra = Object.keys(settings).filter((key) => !['rules', 'source', 'config', 'enabled'].includes(key) && settings[key] !== undefined)
  if (!saving || extra.length) throw new Error('save one thing per call: settings.source with config and enabled, or settings.rules')
  // The conversation is the one the call was made from, as for every other
  // Partner tool: Partner never names a Session, wish never reads one.
  const principal = String(exec?.agent?.id ?? '').trim()
  if (!principal) throw new Error('a change is refused: this call carries no calling session, so no conversation\'s Secretary can judge by the new setup')

  // The setup belongs to this conversation, whichever part of it changes.
  await sharedPolicy(ctx).then((record) => setPrincipal(ctx, record, principal))

  if (saving === 'rules') {
    const rules = rulesOf(settings.rules)
    const { from, to, notified } = await savePolicy(policy, store, ctx, { rules }, exec?.agent?.session)
    const changed = from === to ? 'The rules are unchanged.' : `Saved ${rules.length} rule${rules.length === 1 ? '' : 's'}; the policy version is now ${to}.`
    return textResult(`${changed} ${notified.length ? `${notified.length} open working unit(s) were told the rules changed.` : ''}`.trim(), { from, to, rules: rules.length, notified })
  }
  const id = String(settings.source ?? '')
  if (!SOURCE_IDS.includes(id)) throw new Error(`unknown source ${JSON.stringify(id)}; the sources are ${SOURCE_IDS.join(' and ')}`)
  const previous = policy.current().sources[id]
  let block
  try {
    block = sourceBlock(id, { enabled: settings.enabled, config: settings.config }, previous)
  } catch (error) {
    throw new Error(`the ${id} source was not saved: ${describe(error)}`)
  }
  let scheduled = ''
  if (id === 'schedule') {
    try {
      const taskId = await applySchedule(ctx, block)
      scheduled = taskId ? ` The patrol task is ${taskId}.` : ' Its patrol task is paused.'
    } catch (error) {
      // The block is saved either way; the Host's refusal is what Partner reads, so it can say so.
      scheduled = ` The Host refused the patrol task: ${describe(error)}.`
    }
  }
  // The sources are merged from what is stored now, not from what was read before
  // the Host was awaited: a second save between the two must not be undone.
  const sources = { ...policy.current().sources, [id]: block }
  const { from, to, notified } = await savePolicy(policy, store, ctx, { sources }, exec?.agent?.session)
  // The events read from now on are judged for this conversation, and the ones
  // that waited for a Secretary reach this one; an event judged since stays judged.
  await reannotate(ctx, store, principal)
  const line = `${id} source saved${from === to ? ' (unchanged)' : ''}: ${describeSource(id, block)}`
  return textResult(`${line}.${scheduled}${notified.length ? ` ${notified.length} open working unit(s) were told the policy changed.` : ''}`, { id, from, to, config: block })
}

/** The list line for one dropped event: when, which event, and why it opened nothing. */
export function describeDropped(event, now = Date.now()) {
  const at = event.judgedAt ?? event.at
  const what = event.source === 'files' ? `file ${event.ref}` : event.kind === 'patrol' ? 'patrol' : event.ref
  return {
    at,
    source: event.source,
    what,
    reason: event.reason ?? 'no reason recorded',
    since: `${since(at, now)} ago`,
  }
}

/** `partner_list`: every unit with its state and the events the Secretary dropped, read-only. */
export async function listUnits(store, args) {
  const units = store.list().filter((unit) => args.includeEnded === true || unit.state !== 'ended')
  const now = Date.now()
  const lines = units.map((unit) => describeUnit(unit, now, { history: true }))
  const summary = lines.length ? lines.map((line) => `${line.id} ${quoted(line.name)} — ${line.type}, ${line.state} (${line.since})${line.lastReport ? `: ${line.lastReport.state} — ${line.lastReport.summary}` : ''}`).join('\n')
    : 'No working units yet.'
  const limit = Number.isInteger(args.droppedLimit) && args.droppedLimit >= 0 ? args.droppedLimit : 20
  const dropped = limit === 0 ? [] : store.droppedEvents({ limit }).map((event) => describeDropped(event, now))
  const droppedText = dropped.length
    ? dropped.map((line) => `${line.at} ${line.source}: ${line.what} — dropped ${line.since}: ${line.reason}`).join('\n')
    : 'No external event was dropped.'
  return textResult(`${summary}\n\nDropped external events:\n${droppedText}`, { units: lines, dropped })
}

export function apply(ctx, config) {
  // The queue's slot count: the manager's, or this mount's when there is no manager.
  const slots = slotsFor(ctx.storageDomain, slotsFrom(config?.implementerSlots))

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'superagent-wish-partner',
    order: 50,
    text: PARTNER_SECTION,
  }))

  ctx.inject(WORKER_SERVICES, (workerCtx) => {
    // The store belongs to the resources the tools were registered with: a Host
    // without a storage domain never reaches this line, and the tools are absent.
    workerCtx.inject(STORE_SERVICES, (storeCtx) => {
      // One store and one policy per medium: the manager, the Partner and each
      // Worker preset all read the same rows.
      const store = () => sharedStore(storeCtx)
      const policy = () => sharedPolicy(storeCtx)
      // A Worker runs in its preset's own scope, so only a global listener sees
      // its status change: the listener reads the unit the Session id names,
      // and the turn's end is what its `whenIdle` promises.
      storeCtx.on('agent/status', async ({ agent, status }) => {
        if (status !== 'idle') return
        // The real Agent still finishes closing its turn when the event lands;
        // waiting on it is what makes the turn's own report the one counted.
        const after = () => (typeof agent?.whenIdle === 'function' ? agent.whenIdle() : undefined)
        // Yield once first: a turn writes its report at its own end, and the
        // event must not read the unit before that write lands.
        try {
          await Promise.resolve()
          const { outcome } = await turnEnded(workerCtx, await store(), agent?.id, after)
          // A turn whose round ended here — with its `waiting` report or with
          // none — gave a slot back, and a queued unit starts on it as it would
          // after a report. A Worker that ran on, or had work left, keeps its.
          if (outcome === 'closed') await advance(workerCtx, async () => openPump(workerCtx, await store(), () => slots))
        } catch {
          // The turn end is a best effort: its failure is logged by the relay,
          // and a status listener that threw would starve the next one.
        }
      }, { global: true })
      const bodies = {
        partner_dispatch: guarded((args, exec) => Promise.all([store(), policy()]).then(([handle, rules]) => dispatch(workerCtx, handle, rules, slots, args, exec))),
        partner_followup: guarded((args, exec) => Promise.all([store(), policy()]).then(([handle, rules]) => followup(workerCtx, handle, rules, args, exec))),
        partner_stop: guarded((args) => store().then((handle) => stopUnit(workerCtx, handle, slots, args))),
        partner_list: guarded((args) => store().then((handle) => listUnits(handle, args))),
        partner_setup: guarded((args, exec) => Promise.all([store(), policy()]).then(([handle, rules]) => setup(workerCtx, handle, rules, args, exec))),
      }
      for (const definition of TOOLS) {
        storeCtx.effect(() => workerCtx.tools.register({ ...definition, execute: bodies[definition.name] }))
      }
    })
  })
}

export const PARTNER_SECTION = [
  '## Partner',
  '',
  'You are wish\'s collaborator. You talk, you decide when a job is worth starting, and you hand it to a Worker.',
  'You do not write files, run commands or read the Worker\'s session: the details of how a job is done are not yours to hold.',
  '',
  'A **working unit** is one job. It has its own id, state, input queue and directory, and a Worker session runs it.',
  'Name a unit by its working unit id, never by a session id.',
  '',
  '### Tools',
  '',
  '- `partner_dispatch` starts a unit and returns its id. Only after wish agrees.',
  '- `partner_followup` adds to a unit that already exists: the same session, the same directory.',
  '- `partner_stop` ends the current assignment; the unit stays and a follow-up continues it.',
  '- `partner_list` shows every unit, its state and how long it has been there.',
  '',
  '### When a Worker reports',
  '',
  'A report arrives marked as a Worker message, not as wish\'s words. Read `ready` results and check them',
  'against what wish asked for; relay the conclusion, not the report text. A `blocked` or `failed` report',
  'needs wish\'s decision: give the cause, the effect and the options, and no recommendation unless asked.',
].join('\n')
