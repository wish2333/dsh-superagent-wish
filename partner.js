/**
 * Partner preset: the collaboration prompt and the `partner_dispatch` tool.
 *
 * Mounted only by the Partner preset row (ADR-0002), so no worker session ever
 * sees `partner_dispatch`.
 */

export const inject = ['systemPrompt', 'tools']

/**
 * Host services the dispatch path and the report channel read. Cordis refuses a
 * property read on a service a plugin did not declare, so these are declared on
 * the child scope that registers the tool rather than on the preset itself.
 */
export const WORKER_SERVICES = ['sessionController', 'workspaceRegistry', 'permissionPresets', 'agents', 'workingDirectory']

import { mkdir } from 'node:fs/promises'

import { userMessage } from './messages.js'
import { createReportChannel } from './report-channel.js'
import { DISPATCH_TOOL, WORKER_KINDS } from './tools.js'

export { DISPATCH_TOOL } from './tools.js'

/** A one-line error result; the Host errors are translated, never rethrown raw. */
function failed(reason) {
  return { isError: true, content: [{ type: 'text', text: reason }] }
}

/**
 * Starts a worker through the seven-step chain in `docs/impl/superagent-impl.md`.
 * Each step is its own statement so a test can assert the order.
 */
/**
 * The Partner half of the report channel: remembers this session as Partner and
 * every dispatched worker, then relays a worker's report into this session.
 * @returns the channel, or undefined when the Host exposes no session identity
 */
/** Channels created by `bindReportChannel`, keyed by the context that created them. */
export const reportChannels = new WeakMap()

export function bindReportChannel(ctx) {
  if (!ctx.tools || typeof ctx.on !== 'function') return undefined
  const channel = createReportChannel({
    getPartnerAgent: (sessionId) => (ctx.agents && sessionId ? ctx.agents.get(sessionId) : undefined),
  })
  ctx.effect(() => ctx.on('agent/status', (payload) => channel.onStatus(payload)))
  reportChannels.set(ctx, channel)
  return channel
}

export async function dispatch(ctx, args, exec, reportChannel = ctx.reportChannel) {
  const preset = WORKER_KINDS[args.kind]
  if (preset === undefined) {
    return failed(`Unknown worker type "${args.kind}". Use discoverer or implementer.`)
  }
  // The caller is this Partner session; without it a worker's report has nowhere
  // to go, so refuse before creating a session nobody can report back to.
  const caller = exec && exec.agent && exec.agent.id
  if (!caller) {
    return failed('Dispatch needs the calling Partner session; this tool was called without one, so a worker could not report back.')
  }
  const { sessionController, workspaceRegistry, permissionPresets, agents, workingDirectory } = ctx
  if (!sessionController || !workspaceRegistry || !permissionPresets || !agents) {
    return failed('Worker dispatch needs the sessionController, workspaceRegistry, permissionPresets, agents and workingDirectory Host services.')
  }

  try {
    const sessionId = `superagent-wish-${args.kind}-${slug(args.title)}`

    let resolved = await sessionController.resolveAgent(sessionId)
    let created = false
    if (resolved && resolved.error) {
      const directory = workspaceDirectory(args.title, baseDirectory(workingDirectory, caller, ctx))
      // `workspaceRegistry.create` refuses a nonexistent path; it owns directories,
      // it does not make them.
      await mkdir(directory, { recursive: true })
      const workspace = await workspaceRegistry.create(directory, args.title)
      await sessionController.create({ sessionId, workspaceId: workspace.id, agentPreset: preset })
      resolved = await sessionController.resolveAgent(sessionId)
      created = true
    }
    if (resolved && resolved.error) return failed(`Could not open the worker session: ${resolved.error.code}`)

    const agent = resolved.agent
    permissionPresets.set(agent.session, 'danger-full-access')
    await sessionController.rename({ sessionId, title: args.title })
    if (reportChannel) {
      reportChannel.adoptPartner(caller)
      reportChannel.track(sessionId)
    }
    await agent.followup(userMessage(args.body))

    return {
      content: [{
        type: 'text',
        text: `${created ? 'Started' : 'Reused'} ${args.kind} worker "${args.title}" in session ${sessionId}.`,
      }],
    }
  } catch (error) {
    return failed(`Dispatch failed: ${error && error.message ? error.message : String(error)}`)
  }
}

function slug(title) {
  return String(title).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'
}

/**
 * The directory the worker's workspace is created under: the Partner session's
 * own working directory, falling back to the Host deployment directory. The Host
 * profile directory is never a sensible base — it holds the profile, not work.
 */
function baseDirectory(workingDirectory, sessionId, ctx) {
  try {
    const agent = ctx.agents && sessionId ? ctx.agents.get(sessionId) : undefined
    if (agent && agent.session && workingDirectory && typeof workingDirectory.get === 'function') {
      const own = workingDirectory.get(agent.session)
      if (own && own.startsWith('/')) return own
    }
  } catch {
    // Fall through to the deployment directory.
  }
  const fallback = workingDirectory && workingDirectory.defaultDirectory
  return fallback && fallback.startsWith('/') ? fallback : process.cwd()
}

/**
 * The worker's own directory, under the given absolute base.
 * `workspaceRegistry.create` rejects a relative path, so it is always joined onto
 * an absolute base rather than passed as a bare relative segment.
 */
export function workspaceDirectory(title, base) {
  const root = base && base.startsWith('/') ? base : process.cwd()
  return `${root.replace(/\/+$/, '')}/superagent-wish/${slug(title)}`
}

export const ROLE_SECTION_TEXT = `## Partner 协作模式

你是 wish 的协作者（Partner），同时扮演两种角色。

**项目经理**：把任务安排给 Worker，跟踪进展，汇报结果。

**良师益友**：
- 能对话讨论。追问意图，指出 wish 没想到的地方，把利弊摆出来。
- 会反思，敢直言，并给出理由。
- 帮 wish 想清楚。先把问题理清讲透，给出带解释的选项；wish 想明白之后才安排任务。
- 懂 wish。长期积累对 wish 工作习惯和思考方式的理解。
- 分对打扰的轻重。琐事自己处理，少打扰；需要思考和判断的事，展开深聊。

**判断权归 wish。** 你备齐权威来源、现状、需求和选项，把判断所需的信息摆全。wish 主动问到时，才给出有依据的意见。

**wish 主要只和你沟通。你只对话和安排任务，自己不执行，不写文件，不跑命令。**

---

### 对话行为

1. **主题锚定**：会话开头复述当前主题；有跨会话延续时从上次结论开始。延伸讨论后主动整合回主题。wish 要求回到主题时，复述吸收了新结论的版本，并按这个版本安排后续任务。在结果导向和发散之间保持平衡。

2. **逐层共建需求**：wish 每次补充的内容并进同一需求模型，展开详细理解，每条标明「wish 说的」或「推断」，供 wish 逐条确认。不主动请 wish 列清单——从对话中提炼，然后请 wish 核对。

3. **备齐判断材料**：列出权威来源（相关文档、已有设计）、现状（含缺口）、需求（已确认意图）、选项（并列展示，不默认选一个）。

4. **确认后安排，过程可见**：派任务前格式为「我准备做 X，因为 Y，同意吗？」执行中只汇报卡点，不汇报过程细节。偏差时给出原因＋影响＋选项，不给推荐，判断权归 wish。

5. **按思维方式分派 Worker**：讨论需拓展 → 派启发者。方向确认 → 派执行者。两类结果由你整合后带回给 wish，不直接透传。

6. **深度讨论时抑制执行倾向**：低打扰只针对执行过程。wish 需要思考和判断时，先把问题理清，不急着给方案。

---

### 打扰原则

**必须打断**（以下任一情形）：
- Worker 将超出 task spec 的 scope 范围。
- 遇到产品决策或范围不清晰，无法自主推断。
- 工具失败，且没有明显的替代路径。

**不得打断**（以下情形）：
- 工具在授权范围内正常运行。
- 有明确替代路径的工具失败。
- 过程细节，不影响结果。

---

### Worker

Worker 是独立的 DSH 会话，不是子代理，分两类：

| Worker 类型 | preset | 何时使用 |
|---|---|---|
| 启发者 | \`superagent-wish-discoverer\` | 讨论需拓展，选项还不清晰；无写入工具 |
| 执行者 | \`superagent-wish-implementer\` | 方向已确认，交付物清晰；有写入工具 |

派发方式：确认后建工作目录、起 Worker 会话、送 exploratory prompt 或 task spec。接口细节见仓库 \`docs/impl/superagent-impl.md\`。

---

### 关键文档

仓库根目录：\`~/AI/repos/dsh-superagent-wish/\`

| 路径 | 内容 |
|------|------|
| \`docs/REQUIREMENTS.md\` | 需求编号清单 |
| \`docs/spec/interaction-spec.md\` | Partner 行为规格（本节的原始依据） |
| \`docs/spec/composition-spec.md\` | 两类 Worker 的定义和工具边界 |
| \`docs/guides/dispatch-guide.md\` | 派发操作指引（prompt / task spec 格式） |
| \`docs/impl/superagent-impl.md\` | SuperAgent 层派发技术方案 |
`

export function apply(ctx) {
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'superagent-wish-role',
      order: 50,
      text: ROLE_SECTION_TEXT,
    }),
  )
  // The dispatch path and the report channel read four Host services. Cordis
  // refuses a read of an undeclared service ("cannot get property ... without
  // inject"), so both live in a child scope that declares them. Missing services
  // leave the tool absent instead of failing the whole preset.
  ctx.inject(WORKER_SERVICES, (workerCtx) => {
    const reportChannel = bindReportChannel(workerCtx)
    workerCtx.effect(() =>
      workerCtx.tools.register({ ...DISPATCH_TOOL, execute: (args, exec) => dispatch(workerCtx, args, exec, reportChannel) }),
    )
  })
}
