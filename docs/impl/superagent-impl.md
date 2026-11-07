# 总控实现方案

本文件描述在 DeepSeek Harness（DSH）上实现总控的具体方案。
规格来源：`framework.md`（四层结构）、`interaction-spec.md`（总控行为）、`composition-spec.md`（Worker 授权）、`dispatch-guide.md`（派发操作）。

---

## 一、架构决策

**总控运行在 desktop profile 的标准 DSH 会话中，不使用 dsh-superagent 服务。**

dsh-superagent 设计用于团队工作流自动化（GitHub PR、飞书消息），其 Router 是精简的派发机器（路由备注不超过 30 词）。总控要求深度对话（良师益友角色）。两者的会话模型根本不同。

dsh-superagent 的 `wish/a1-local-assistant` 分支，用于后续 Phase B——无人值守的后台自动化（文件入口、定时任务）。Phase A 不依赖它。

---

## 二、概念映射

| dsh-superagent 概念 | DSH 原生能力 | 说明 |
|---|---|---|
| Main Session（Router） | desktop profile 当前会话 | 对话即界面 |
| Executor Session（Worker） | `subagent` / `subagent_fork` | 下节说明选择规则 |
| Source | 对话 + `schedule_create` | 触发事件来源 |
| Trigger | wish 的消息 / cron 事件 | — |
| Eval | 总控 in-context 决策 | wish 唯一用户，gate 隐式通过 |
| Mandate | task spec `authorization` 节 | 见 `composition-spec.md` |
| Ticket | YAML 文件 + `todo_write` | `~/AI/workspace/tickets/` |
| Assignment | `subagent` 返回的 agent_id | 追踪运行中的 Worker |
| Subscription | 不适用 | Worker 从 task spec 获得完整上下文 |
| Channel | `subagent` 完成通知自动回流 | — |
| Watchdog | 无（已知缺口） | Worker 自报卡点 |
| Panel | DSH Web GUI 对话界面 | 总控在主界面工作 |

---

## 三、Worker 派发工具选择

### 启发者 → `subagent_fork`

`subagent_fork` 继承当前会话的全部对话历史。启发者需要这份上下文才能做有意义的探索，无需在 exploratory prompt 里重复背景。

### 执行者 → `subagent`

`subagent` 从全新会话开始，只看到总控写入的 task spec。执行者只管实现，不参与讨论，隔离度更高能防止 Worker 被对话历史里的无关信息干扰。

task spec 须包含执行者需要的全部上下文（目标、范围、相关文件路径、交付物、authorization 节）。格式见 `dispatch-guide.md`。

---

## 四、工单（Ticket）

### 文件路径

`~/AI/workspace/tickets/<id>.yaml`

id 格式：`t-YYYYMMDD-NNN`（例：`t-20261107-001`）

### YAML 结构

```yaml
id: t-20261107-001
title: 一句话说明任务
type: discoverer          # discoverer | implementer
status: open              # open | ended | stopped
created_at: 2026-11-07T12:00:00+08:00
mandate:                  # 仅 implementer 填写；discoverer 为空列表
  - capability: file-write-standard
    scope: 写入 ../spec/composition-spec.md
worker_agent_id: null     # subagent 启动后填入
ended_at: null
result_summary: null      # 总控整合结果后填入
```

### 生命周期

1. 总控决定派 Worker → 写入 Ticket YAML（status: open）+ `todo_write` 标为 in_progress
2. 派发确认点 → wish 确认 → 启动 `subagent` / `subagent_fork`
3. 填入 `worker_agent_id`
4. Worker 完成 → 总控整合结果 → 更新 YAML（status: ended，填 result_summary）+ `todo_write` 标为 completed

---

## 五、触发来源（Source）

| 来源 | 实现方式 |
|---|---|
| wish 的消息 | 直接对话 |
| 定时任务 | `schedule_create`（target: this_session） |
| 独立后台任务 | `schedule_create`（target: new_once） |
| 文件夹巡查 | 待实现（Phase B，使用 dsh-superagent Local Source） |

cron 触发时，总控收到 prompt，在当前 session 里走 Eval（判断要不要派 Worker，还是直接处理）。

---

## 六、总控行为载体

总控的行为规格通过 **`总控` skill** 注入。

- skill 路径：`~/AI/repos/skill-dev/wish/总控/SKILL.md`
- 安装后软链：`~/.agents/skills/总控/`
- 触发：wish 要求总控模式时，agent 加载 `总控` skill

skill 包含：角色定义、5 条对话行为、打扰判断规则、Worker 派发操作（引用 `dispatch-guide.md`）、工单管理操作。

---

## 七、已知缺口（Phase A 接受）

| 缺口 | 影响 | 备注 |
|---|---|---|
| 无 Watchdog | Worker 失败时无自动告警 | Worker 自报卡点 |
| Mandate 靠 prompt 纪律 | 无架构强制 | Worker 须遵守 task spec |
| Worker 结果回流主 session | 长对话上下文积累 | 手动开新会话 |
| 无 Subscription | Worker 不接收后续触发 | 单次任务足够 |
| 文件夹巡查未实现 | 文件入口不可用 | Phase B 补入 |

---

## 八、实现阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase A1 | 总控 skill + 工单目录 + 对话触发 | 当前 |
| Phase A2 | cron 触发接入（schedule_create） | 近期 |
| Phase B | dsh-superagent `wish/a1-local-assistant` 作为后台自动化 Source | 后续 |
