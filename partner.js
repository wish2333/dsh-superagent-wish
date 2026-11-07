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

import { openWorkingUnits } from './working-units.js'
import { openPolicy } from './policy.js'
import { deliver, describe, ensureWorker, selectModel, stop, unitDirectory, WORKER_TYPES, workerSessionId } from './sessions.js'

export const inject = ['systemPrompt', 'tools']

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
export function describeUnit(unit, now = Date.now()) {
  const since_ = unit.state === 'ended' ? unit.ended?.at : unit.updatedAt
  const line = {
    id: unit.id,
    name: unit.title,
    type: unit.type,
    state: unit.state,
    since: since_ ? `${since(since_, now)} ${unit.state === 'ended' ? 'ago' : 'in this state'}` : 'unknown',
  }
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
    'List the working units and what each one is doing. Read-only: it changes nothing.',
    'Each unit reports its name, type, state, and how long it has been in that state.',
    `States: ${LIST_STATES}.`,
    'A unit is waiting for wish when its state is waiting-for-decision or waiting-for-input; the last report it sent is shown with it.',
    'Ended units are listed too, so wish can see what was finished and when.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeEnded: {
        type: 'boolean',
        description: 'Include the units that have ended. Defaults to true; pass false to see only the open work.',
      },
    },
    required: [],
  },
  output,
}

export const TOOLS = [DISPATCH_TOOL, FOLLOWUP_TOOL, STOP_TOOL, LIST_TOOL]

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
export async function dispatch(ctx, store, policy, args, exec) {
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
  // not have is refused without creating an unusable Worker.
  let model
  if (args.model) {
    model = { provider: String(args.model.provider ?? ''), model: String(args.model.model ?? '') }
    if (args.model.reasoningEffort) model.reasoningEffort = String(args.model.reasoningEffort)
    if (typeof ctx.sessionController.selectModel !== 'function') {
      return refused('Dispatch refused: this Host cannot select a model, so omit model and use the session default.')
    }
  }

  // Steps 0–5 of the chain, in the order docs/impl/superagent-impl.md §2 lists them.
  const { agent } = await ensureWorker(ctx, unit, { session: exec.agent.session })
  ctx.permissionPresets.set(agent.session, 'danger-full-access')
  await ctx.sessionController.rename({ sessionId: unit.workerSessionId, title })
  if (model) {
    try {
      await selectModel(ctx, unit.workerSessionId, model)
    } catch (error) {
      // The Session opened but cannot run the chosen model, and it has no unit and
      // no input yet; Partner retries without the model rather than leaving a
      // Worker behind that nothing records.
      throw new Error(`the model ${model.provider}/${model.model} is not available (${describe(error)})`)
    }
  }

  const created = await store.dispatch({
    ...unit,
    text: body,
    source: 'wish',
    scope: title,
    strength: 'explicit',
    // The version the policy has now, so a later rule change can tell which
    // units were opened under rules the current policy no longer states.
    policyVersion: policy.version(),
    basis: 'wish',
  })

  // The first input reaches the Worker only after its unit exists, so a report
  // cannot arrive before the unit it belongs to.
  await deliver(ctx, created, created.inputs.at(-1), exec.agent.session)
  return textResult(id, describeUnit(created))
}

/**
 * `partner_followup`: queue one input and send it to the unit's current Worker.
 *
 * No confirmation and no directory work: the unit already has both. A Worker
 * Session deleted outside the plugin is opened again from the unit id.
 */
export async function followup(ctx, store, args, exec) {
  const unitId = String(args.unitId ?? '').trim()
  const text = String(args.text ?? '').trim()
  if (!text) return refused('Follow-up refused: there is no text to send.')
  const unit = store.get(unitId)
  if (!unit) return refused(`Follow-up refused: there is no working unit ${unitId}.`)
  if (unit.state === 'ended') {
    return refused(`Follow-up refused: working unit ${unitId} has ended. Start a new working unit for new work.`)
  }

  // Input on a unit that was waiting reopens it: the tables move it to running
  // and open the assignment the new input will run under.
  const updated = await store.followup(unitId, { text, source: 'wish' })
  const input = updated.inputs.at(-1)
  await deliver(ctx, updated, input, exec?.agent?.session)
  return textResult(`Sent to ${unitId}. It now holds ${updated.undelivered.length} input${updated.undelivered.length === 1 ? '' : 's'} waiting for the Worker.`, describeUnit(updated))
}

/**
 * `partner_stop`: cancel the Worker's turn. The unit keeps its state, its
 * directory and its queued input, and the next follow-up continues it.
 */
export async function stopUnit(ctx, store, args) {
  const unitId = String(args.unitId ?? '').trim()
  const unit = store.get(unitId)
  if (!unit) return refused(`Stop refused: there is no working unit ${unitId}.`)
  if (unit.state === 'ended') return refused(`Stop refused: working unit ${unitId} has already ended.`)
  const cancelled = stop(ctx, unit)
  await store.stop(unitId, args.reason ? String(args.reason) : 'stopped by wish')
  return textResult(
    cancelled
      ? `Stopped ${unitId}: its worker's turn was cancelled. The unit and its directory remain; partner_followup continues it.`
      : `Stopped ${unitId}: no worker was running. The unit and its directory remain; partner_followup continues it.`,
    describeUnit(store.get(unitId)),
  )
}

/** `partner_list`: every unit with its state, read-only. */
export async function listUnits(store, args) {
  const units = store.list().filter((unit) => args.includeEnded !== false || unit.state !== 'ended')
  const now = Date.now()
  const lines = units.map((unit) => describeUnit(unit, now))
  const summary = lines.length ? lines.map((line) => `${line.id} ${quoted(line.name)} — ${line.type}, ${line.state} (${line.since})${line.lastReport ? `: ${line.lastReport.state} — ${line.lastReport.summary}` : ''}`).join('\n')
    : 'No working units yet.'
  return textResult(summary, { units: lines })
}

/**
 * The store and the policy the Partner tools read, opened on `ctx`'s medium.
 *
 * The tools open these lazily on first use; a settings path needs them before
 * any tool ran, and needs the same handles so a write is the one the tools then
 * read. A Host without a storage domain gets an error naming the missing
 * service, as a tool would.
 *
 * @param ctx the Partner context, which must provide `storageDomain`
 * @returns `{ store, policy }`
 */
export async function handles(ctx) {
  if (!ctx.storageDomain) throw new Error('the Host provides no storageDomain service')
  const [store, policy] = await Promise.all([openWorkingUnits(ctx), openPolicy(ctx)])
  return { store, policy }
}

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'superagent-wish-partner',
    order: 50,
    text: PARTNER_SECTION,
  }))

  ctx.inject(WORKER_SERVICES, (workerCtx) => {
    // The store belongs to the resources the tools were registered with: a Host
    // without a storage domain never reaches this line, and the tools are absent.
    workerCtx.inject(STORE_SERVICES, (storeCtx) => {
      let opened
      let openedPolicy
      const store = () => (opened ??= openWorkingUnits(storeCtx))
      const policy = () => (openedPolicy ??= openPolicy(storeCtx))
      storeCtx.effect(() => () => { opened?.then((handle) => handle.close()).catch(() => {}) })
      storeCtx.effect(() => () => { openedPolicy?.then((handle) => handle.close()).catch(() => {}) })
      const bodies = {
        partner_dispatch: guarded((args, exec) => Promise.all([store(), policy()]).then(([handle, rules]) => dispatch(workerCtx, handle, rules, args, exec))),
        partner_followup: guarded((args, exec) => store().then((handle) => followup(workerCtx, handle, args, exec))),
        partner_stop: guarded((args) => store().then((handle) => stopUnit(workerCtx, handle, args))),
        partner_list: guarded((args) => store().then((handle) => listUnits(handle, args))),
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
