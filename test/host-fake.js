/**
 * Records every Host service call the plugin makes through `apply(ctx)`.
 * Tests assert on this record and on nothing below the plugin entry points.
 */

/**
 * @param {{ services?: string[] }} [options] services beyond the always-present ones
 * @returns a fake Context plus the log of calls made against it
 */
export function createHost(options = {}) {
  const calls = []
  const listeners = new Map()
  const agents = new Map()

  const record = (name, args) => calls.push({ name, args })

  const ctx = {
    agentPresets: {
      register(definition) {
        record('agentPresets.register', definition)
        return Promise.resolve(async () => {})
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
        return Promise.resolve({ error: { code: 'session/not-found' } })
      },
      create(input) {
        record('sessionController.create', input)
        return Promise.resolve(undefined)
      },
      rename(input) {
        record('sessionController.rename', input)
        return Promise.resolve()
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
    on(name, handler) {
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
    },
    /** Fires a Context event, awaiting every handler. */
    async emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) await handler(payload)
    },
  }
}
