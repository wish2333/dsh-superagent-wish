/**
 * Records every Host service call the plugin makes through `apply(ctx)`.
 * Tests assert on this record and on nothing below the plugin entry points.
 */

/**
 * @param {{ services?: string[], resolvablePresets?: string[], missing?: string[], storageDomain?: unknown }} [options]
 *   `services` beyond the always-present ones; `resolvablePresets` are the
 *   preset ids a Session may be created with, which `create` then echoes; the
 *   `storageDomain` medium the plugin opens; `missing` names services a test
 *   wants `inject` to report absent
 * @returns a fake Context plus the log of calls made against it
 */
export function createHost(options = {}) {
  const calls = []
  const listeners = new Map()
  const agents = new Map()
  const composed = new Map()
  const disposers = []
  const presets = new Map()
  const workingDirectories = new Map()
  // The tasks `ctx.schedule` holds, by id, as the real service stores them.
  const tasks = new Map()

  const record = (name, args) => calls.push({ name, args })

  /**
   * A live Agent as `sessionController.resolveAgent` returns it. It records the
   * messages it is handed, the way a real Agent's inbox takes them, so a test
   * can assert what reached the worker and in which mode.
   */
  const liveAgent = (id, extra = {}) => {
    const delivered = []
    const agent = {
      id,
      delivered,
      status: 'idle',
      followup: (message) => { delivered.push({ mode: 'followup', message }) },
      steer: (message) => { delivered.push({ mode: 'steer', message }) },
      cancel: (cause, cancelOptions) => { delivered.push({ mode: 'cancel', cause, options: cancelOptions }) },
      ...extra,
    }
    return agent
  }

  const ctx = {
    agentPresets: {
      register(definition) {
        record('agentPresets.register', definition)
        return Promise.resolve(async () => {})
      },
      /**
       * The recorded preset of a Session, as `presetForSession(session)` reports
       * it: `null` when none was selected. A Session registered with
       * `setPreset` whose preset a test marked unreadable makes this throw, the
       * way a registry read fails.
       */
      presetForSession(session) {
        record('agentPresets.presetForSession', session)
        const preset = presets.get(session)
        if (preset === undefined) return null
        if (preset.unreadable) throw new Error('read failed')
        return preset.id
      },
      /**
       * The preset an Agent is composed with, read from its own context. The
       * real registry answers this at `agent/created`, before the Session
       * records its selection; a Host without the call falls back to the record.
       */
      composedPreset(agentCtx) {
        record('agentPresets.composedPreset', agentCtx)
        return composed.get(agentCtx)
      },
    },
    systemPrompt: {
      section(section) {
        record('systemPrompt.section', section)
        return () => {}
      },
    },
    tools: {
      register(definition, toolOptions) {
        record('tools.register', { definition, options: toolOptions })
        return () => {}
      },
      restrict(filter) {
        record('tools.restrict', filter)
        return () => {}
      },
    },
    agents: {
      get(id) {
        record('agents.get', id)
        return agents.get(id)
      },
    },
    workspaceRegistry: {
      create(cwd) {
        record('workspaceRegistry.create', cwd)
        return Promise.resolve({ id: 'workspace-1', cwd })
      },
    },
    sessionController: {
      resolveAgent(sessionId) {
        record('sessionController.resolveAgent', sessionId)
        const agent = agents.get(sessionId)
        return Promise.resolve(agent ? { agent } : { error: { code: 'session/not-found' } })
      },
      /**
       * Creates the Session and, like the real controller, leaves it resolvable
       * through `resolveAgent`. Returns `{ sessionId, agentPreset }`, where
       * `agentPreset` echoes the requested preset only if a test marked it
       * resolvable in the registry.
       */
      create(input) {
        record('sessionController.create', input)
        const session = { id: input.sessionId ?? 'session-created' }
        agents.set(session.id, liveAgent(session.id, { session }))
        return Promise.resolve({
          sessionId: session.id,
          ...(input.agentPreset === undefined || !options.resolvablePresets?.includes(input.agentPreset) ? {} : { agentPreset: input.agentPreset }),
        })
      },
      rename(input) {
        record('sessionController.rename', input)
        return Promise.resolve()
      },
      prompt(input) {
        record('sessionController.prompt', input)
        return Promise.resolve({})
      },
      updateQueue(input) {
        record('sessionController.updateQueue', input)
        return Promise.resolve({})
      },
      cancel(input) {
        record('sessionController.cancel', input)
        return {}
      },
      events(request) {
        record('sessionController.events', request)
        return Promise.resolve({ records: [], hasMore: false })
      },
    },
    permissionPresets: {
      set(session, preset) {
        record('permissionPresets.set', { session, preset })
        return undefined
      },
    },
    effect(run) {
      const result = run()
      // A disposer the effect returned releases its resource when the host unloads;
      // tests call `dispose()` to simulate the plugin unmounting.
      if (typeof result === 'function') disposers.push(result)
      return () => {}
    },
    /**
     * Mirrors Cordis: the callback runs only when every named service is
     * present, and the child context is the parent. `missing` lists the
     * services a test wants to be absent. A plugin that declares its services
     * with `ctx.inject(NAMES, callback)` never mounts its callback when one is
     * absent, so those tests must not expect a child either.
     */
    inject(names, callback) {
      if (typeof names === 'function') {
        const missing = (options.missing ?? []).filter((name) => !(name in ctx))
        if (missing.length > 0) {
          record('inject.pending', { names: Object.keys(ctx), missing })
          return
        }
        names(ctx)
        return
      }
      const missing = (options.missing ?? []).filter((name) => names.includes(name))
      if (missing.length > 0) {
        record('inject.pending', { names, missing })
        return
      }
      callback(ctx)
    },
    /**
     * The Schedule service, as `@deepseek-ai/dsh-schedule` exposes it to a
     * plugin: `create(request, actorSessionId, signal)` returns the stored
     * task, `edit` updates or deletes one, `view` reads one. A test registers a
     * task or reads the stored ones through `tasks()` on the returned host.
     */
    schedule: {
      create(request, actorSessionId, signal) {
        record('schedule.create', { request, actorSessionId, signal })
        const id = `schedule-${tasks.size + 1}`
        const task = {
          id,
          ...structuredClone(request),
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        tasks.set(id, task)
        return Promise.resolve(structuredClone(task))
      },
      edit(request) {
        record('schedule.edit', request)
        const task = tasks.get(request.id)
        if (!task) return Promise.reject(Object.assign(new Error(`no schedule ${request.id}`), { code: 'schedule/not-found' }))
        if (request.action === 'delete') {
          tasks.delete(request.id)
          return Promise.resolve({ deleted: true })
        }
        if (request.action === 'pause' || request.action === 'resume') {
          task.status = request.action === 'pause' ? 'paused' : 'active'
        }
        if (request.patch) {
          for (const [key, value] of Object.entries(request.patch)) {
            if (key === 'active') task.status = value ? 'active' : 'paused'
            else if (value === undefined) delete task[key]
            else task[key] = structuredClone(value)
          }
        }
        task.updatedAt = new Date().toISOString()
        return Promise.resolve(structuredClone(task))
      },
      view(request) {
        record('schedule.view', request)
        const task = tasks.get(request.id)
        return Promise.resolve(task ? structuredClone(task) : undefined)
      },
      list() {
        record('schedule.list', {})
        return Promise.resolve([...tasks.values()].map((task) => structuredClone(task)))
      },
    },
    on(name, handler, eventOptions) {
      // A listener without `global` sees only its own scope; record the option so
      // a test can assert the plugin asked for cross-scope delivery.
      record('on', { name, options: eventOptions })
      const set = listeners.get(name) ?? new Set()
      set.add(handler)
      listeners.set(name, set)
      return () => set.delete(handler)
    },
  }

  // A test that needs the domain passes its medium as `storageDomain`; without
  // one the plugin sees the service missing, as it would on a Host without it.
  const storageDomain = 'storageDomain' in options ? options.storageDomain : undefined
  if (storageDomain) ctx.storageDomain = storageDomain.service

  for (const name of options.services ?? []) {
    if (name === 'storageDomain') continue
    if (!(name in ctx)) ctx[name] = { record: (args) => record(name, args) }
  }
  // The two services the dispatch path reads that no other test uses yet: the
  // Partner's own directory and its model selection default, one shared by the
  // Host rather than the Session.
  if ('workingDirectory' in options) {
    ctx.workingDirectory = {
      defaultDirectory: options.workingDirectory,
      get(session) {
        record('workingDirectory.get', session)
        return workingDirectories.get(session) ?? session?.header?.cwd
      },
    }
  }
  if ('defaultModel' in options) {
    ctx.agentDefaultModel = {
      currentSelection() {
        record('agentDefaultModel.currentSelection')
        return { ...options.defaultModel }
      },
    }
  }

  return {
    ctx,
    calls,
    /** Calls recorded under one Host service method. */
    callsTo(name) {
      return calls.filter((call) => call.name === name)
    },
    /** Registers a live agent the fake `agents.get` returns. */
    setAgent(id, agent) {
      agents.set(id, agent)
      return agent
    },
    /**
     * Records the preset `agentPresets.presetForSession` reports for `session`:
     * `id` is the preset id, `null` for none selected, and `{ unreadable: true }`
     * for a read that fails.
     */
    setPreset(session, preset) {
      presets.set(session, typeof preset === 'string' || preset === null ? { id: preset } : preset)
    },
    /**
     * Records the preset `agentPresets.composedPreset(agent.ctx)` reports: the
     * preset the Agent runs, as the real registry answers it from the Agent's
     * own composition.
     */
    setComposedPreset(agentCtx, preset) {
      composed.set(agentCtx, preset)
    },
    /** Runs every disposer an effect registered, as unloading the plugin would. */
    dispose() {
      for (const disposer of disposers.splice(0)) disposer()
    },
    /** Records the directory `workingDirectory.get` reports for `session`. */
    setWorkingDirectory(session, directory) {
      workingDirectories.set(session, directory)
    },
    /**
     * Deletes a Session the way DSH does when the user removes it: `resolveAgent`
     * then reports `session/not-found`. It returns whether the Session existed.
     */
    removeSession(sessionId) {
      return agents.delete(sessionId)
    },
    /** The fake storage domain: `snapshot()` for a reload, `contents()` to read it. */
    storageDomain,
    /** The scheduled tasks the fake Schedule service holds, by id. */
    tasks() {
      return Object.fromEntries([...tasks].map(([id, task]) => [id, structuredClone(task)]))
    },
    /** Fires a Context event, awaiting every handler. */
    async emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) await handler(payload)
    },
    /**
     * Moves an Agent between `idle` and `running` the way the real loop does: a
     * woken delivery enters `running` first, and the turn's end emits
     * `agent/status` with `{ agent, status: 'idle' }`.
     * @param agent the live Agent the event carries
     * @param status the status just entered
     */
    async setStatus(agent, status) {
      agent.status = status
      record('agent/status', { agent: agent.id, status })
      await this.emit('agent/status', { agent, status })
    },
  }
}

/**
 * An in-memory stand-in for `ctx.storageDomain` (the real contract is
 * `@deepseek-ai/dsh-storage-domain`): `open(spec)` returns a handle whose
 * `table(name)` reads synchronously and writes durably, and `close()` releases
 * it. Each handle keeps its records, so `createStorageDomain(snapshot)` replays
 * them into a second host the way a restart would.
 * @param snapshot records from `snapshot()`, or nothing for a fresh medium
 */
export function createStorageDomain(snapshot) {
  const medium = new Map(
    Object.entries(snapshot ?? {}).map(([table, records]) => [table, new Map(Object.entries(records))]),
  )
  const writes = []
  const opened = []

  const tableHandle = (name) => ({
    get: (key) => medium.get(name)?.get(key),
    entries: () => (medium.get(name) ?? new Map()).entries(),
    keys: () => (medium.get(name) ?? new Map()).keys(),
    get size() {
      return medium.get(name)?.size ?? 0
    },
    put(key, value) {
      writes.push({ table: name, key, value })
      if (!medium.has(name)) medium.set(name, new Map())
      medium.get(name).set(key, value)
      return Promise.resolve()
    },
    update(key, transform) {
      if (!medium.get(name)?.has(key)) {
        const error = new Error(`domain has no record '${key}' to update`)
        error.code = 'missing-key'
        return Promise.reject(error)
      }
      const next = transform(medium.get(name).get(key))
      return this.put(key, next).then(() => next)
    },
    delete(key) {
      const deleted = medium.get(name)?.delete(key) ?? false
      return Promise.resolve(deleted)
    },
  })

  return {
    service: {
      async open(spec) {
        const handle = {
          spec,
          closed: false,
          table: (name) => {
            if (!(name in spec.tables)) throw new Error(`domain '${spec.name}' declares no table '${name}'`)
            if (!medium.has(name)) medium.set(name, new Map())
            return tableHandle(name)
          },
          close() {
            handle.closed = true
            return Promise.resolve()
          },
        }
        opened.push(handle)
        return handle
      },
    },
    /** The handles `open()` returned, so a caller can close the domain it opened. */
    opened,
    /** True once a `close()` released the opened domain. */
    get closed() {
      return opened.some((handle) => handle.closed)
    },
    /** The specs opened through this service, in order. */
    specs() {
      return opened.map((handle) => handle.spec)
    },
    /** Every `put` in order, so a test can count writes and read their values. */
    writes,
    writesOf(table) {
      return writes.filter((write) => write.table === table)
    },
    /** Every stored record, for replaying into another host. */
    snapshot() {
      return Object.fromEntries([...medium].map(([table, records]) => [table, Object.fromEntries(records)]))
    },
    contents(table) {
      return Object.fromEntries(medium.get(table) ?? new Map())
    },
  }
}
