/**
 * Records every Host service call the plugin makes through `apply(ctx)`.
 * Tests assert on this record and on nothing below the plugin entry points.
 */

/**
 * @param {{ services?: string[], resolvablePresets?: string[] }} [options]
 *   `services` beyond the always-present ones; `resolvablePresets` are the
 *   preset ids a Session may be created with, which `create` then echoes
 * @returns a fake Context plus the log of calls made against it
 */
export function createHost(options = {}) {
  const calls = []
  const listeners = new Map()
  const agents = new Map()
  const presets = new Map()

  const record = (name, args) => calls.push({ name, args })

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
        agents.set(session.id, { id: session.id, session })
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
      return () => {}
    },
    /**
     * Mirrors Cordis: the callback runs only when every named service is
     * present, and the child context is the parent. `missing` lists the
     * services a test wants to be absent.
     */
    inject(names, callback) {
      const missing = (options.missing ?? []).filter((name) => names.includes(name))
      if (missing.length > 0) {
        record('inject.pending', { names, missing })
        return
      }
      callback(ctx)
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

  for (const name of options.services ?? []) {
    if (!(name in ctx)) ctx[name] = { record: (args) => record(name, args) }
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
    /** Fires a Context event, awaiting every handler. */
    async emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) await handler(payload)
    },
  }
}
