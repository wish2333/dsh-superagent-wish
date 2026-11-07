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
  const disposers = []

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
      // A disposer the effect returned releases its resource when the host unloads;
      // tests call `dispose()` to simulate the plugin unmounting.
      if (typeof result === 'function') disposers.push(result)
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

  // A test that needs the domain passes its medium as `storageDomain`; without
  // one the plugin sees the service missing, as it would on a Host without it.
  const storageDomain = 'storageDomain' in options ? options.storageDomain : undefined
  if (storageDomain) ctx.storageDomain = storageDomain.service

  for (const name of options.services ?? []) {
    if (name === 'storageDomain' || !(name in ctx)) continue
    ctx[name] = { record: (args) => record(name, args) }
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
    /** Runs every disposer an effect registered, as unloading the plugin would. */
    dispose() {
      for (const disposer of disposers.splice(0)) disposer()
    },
    /** The fake storage domain: `snapshot()` for a reload, `contents()` to read it. */
    storageDomain,
    /** Fires a Context event, awaiting every handler. */
    async emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) await handler(payload)
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
