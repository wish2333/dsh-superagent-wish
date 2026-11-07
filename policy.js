/**
 * The policy: the rules a Worker works under, the event-source configuration,
 * and the version both of them derive to.
 *
 * The version is a hash of the policy's content, never a counter, so the same
 * rules always give the same version and a restart does not change it. A
 * mandate records the version it was created under, so a later policy can tell
 * which units were opened under other rules.
 *
 * The record has one field per block of the policy, so a later block is added
 * beside the others without a second table or a rewritten version function:
 *
 *   { rules: [], sources: {} }
 *
 * The store keeps the record in the plugin's own domain, which the working unit
 * tables also open.
 */

import { createHash } from 'node:crypto'
import { policyTables } from './schema.js'
import { deliver } from './sessions.js'

/** Domain name; must match the Host's `^[a-z][a-z0-9_]*$`. */
export const POLICY_DOMAIN = 'superagent_wish_policy'

/** The key of the one record the policy is held in. */
const CURRENT = 'current'

/**
 * The blocks the version is derived from, in this order. A block added here joins
 * the version without a change to the store or to the mandate that records it.
 */
export const POLICY_BLOCKS = ['rules', 'sources']

/**
 * The policy a Host with an empty domain starts from: no rules, no sources. A
 * policy record the store has not written yet reads as this one.
 */
export const DEFAULT_POLICY = Object.freeze({ rules: [], sources: {} })

/**
 * A stable serialization: object keys sorted at every depth, so two policies
 * that differ only in key order serialize alike and hash alike.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The version of `policy`: a key over the blocks it is defined by.
 *
 * Changing a block changes the version; changing the order of a block's keys,
 * or anything outside the blocks (a model, a concurrency limit), does not.
 *
 * @param policy the policy record
 * @returns a short hex key, stable across restarts and processes
 */
export function policyVersion(policy) {
  const source = POLICY_BLOCKS.map((block) => `${block}=${canonical(policy?.[block] ?? DEFAULT_POLICY[block])}`).join(';')
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

/** The policy with every block present, so a caller reads `rules` and `sources` without a check. */
export function withDefaults(policy) {
  return Object.fromEntries(POLICY_BLOCKS.map((block) => [block, policy?.[block] ?? DEFAULT_POLICY[block]]))
}

/** The domain specification the policy store opens. */
function declareDomain() {
  const spec = {
    name: POLICY_DOMAIN,
    version: 1,
    tables: Object.fromEntries(Object.entries(policyTables).map(([name, valueSchema]) => [name, { valueSchema }])),
  }
  if (!/^[a-z][a-z0-9_]*$/.test(spec.name)) throw new Error(`domain name '${spec.name}' must be a lower-case identifier`)
  return spec
}

export const policyDomain = declareDomain()

/**
 * Open the policy record over a storage domain and return the accessors.
 *
 * The record is read on every call rather than cached, so a caller in one
 * Session sees the policy another Session saved, and a restart continues from
 * what was stored.
 *
 * @param ctx the plugin context; it must provide `storageDomain`
 * @returns `current()`, `setPolicy(blocks)`, `revalidate(mandate)` and `close()`
 */
export async function openPolicy(ctx) {
  const domain = await ctx.storageDomain.open(policyDomain)
  let closed
  const close = () => (closed ??= Promise.resolve(domain.close()))
  ctx.effect(() => () => close())
  const table = domain.table('policy')

  /** The policy as stored, or the default when nothing was saved yet. */
  const current = () => {
    const record = table.get(CURRENT)
    return record ? withDefaults(record) : withDefaults(DEFAULT_POLICY)
  }

  return {
    /** The policy now in force. */
    current,

    /** The version of the policy now in force. */
    version() {
      return policyVersion(current())
    },

    /**
     * Replace the named blocks of the policy and recompute its version.
     *
     * A block left out keeps its value, which is what a caller editing only the
     * rules relies on; a block named with `undefined` keeps its value too, so a
     * merged object need not spell out every block.
     *
     * @param blocks the blocks to replace, such as `{ rules }`
     * @returns `{ from, to, policy }`: the version before, the version after,
     *   and the policy saved
     */
    async setPolicy(blocks) {
      const from = policyVersion(current())
      const next = { ...current() }
      for (const block of POLICY_BLOCKS) {
        if (blocks?.[block] !== undefined) next[block] = blocks[block]
      }
      const to = policyVersion(next)
      await table.put(CURRENT, { ...next, version: to, updatedAt: new Date().toISOString() })
      return { from, to, policy: next }
    },

    /**
     * Whether `mandate` still holds under the policy now in force.
     *
     * A mandate holds while the policy does not withdraw what it was granted
     * under: the unit was opened under the same rules, or the rules that bear on
     * it stayed the same. A mandate whose rules the current policy no longer has
     * does not hold.
     *
     * @param mandate the unit's mandate, with the `policyVersion` it was opened under
     * @returns `true` when the unit may continue under this policy
     */
    revalidate(mandate) {
      return holds(mandate, current())
    },

    /** Release the domain. Idempotent, and also run by the effect on unload. */
    close,
  }
}

/**
 * Whether a mandate opened under `mandate.policyVersion` still holds under
 * `policy`. The check is the version itself: the version is derived from the
 * rules, so the mandate's version equalling the current one means the rules the
 * unit was opened under are the rules in force.
 */
export function holds(mandate, policy) {
  if (!mandate?.policyVersion) return false
  return mandate.policyVersion === policyVersion(policy)
}

/**
 * Save new rules, then tell every unfinished unit the change bears on.
 *
 * The order is the prototype's: the policy is saved first, so a unit notified
 * of the change already reads the new version when it revalidates. No unit's
 * mandate is revoked and no unit is stopped: a running unit keeps working, and
 * its worker is told what the rules now say.
 *
 * @param policy the open policy record
 * @param store the open working unit tables
 * @param ctx the executor's context, which the delivery reaches the Host through
 * @param blocks the blocks to replace, such as `{ rules }`
 * @param session the Partner Session, whose directory a reopened unit uses
 * @returns `{ from, to, notified }`: the versions and the units told
 */
export async function savePolicy(policy, store, ctx, blocks, session) {
  const { from, to, policy: saved } = await policy.setPolicy(blocks)
  if (from === to) return { from, to, notified: [] }
  const notified = await store.policyChanged({ from, to, rules: saved.rules })
  // Each notice goes to the unit's worker in queue order; a unit whose worker
  // cannot be reached keeps the notice queued, and the next delivery carries it.
  for (const id of notified) {
    const unit = store.get(id)
    const queued = unit.undelivered
      .map((inputId) => unit.inputs.find((item) => item.id === inputId))
      .find((item) => item?.kind === 'policy-changed')
    if (!queued) continue
    await deliver(ctx, unit, queued, session)
  }
  return { from, to, notified }
}
