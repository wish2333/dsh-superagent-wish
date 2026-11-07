# Worker 插件清单（runtime-common）

来源：`~/.agents/HARNESS.md` Worker 边界表。双轨共用；换运行时只改接线，不改本清单业务含义。  
更新日期：2026-11-06（memory 后端：Xinference → oMLX）

| id | 能力 | 本机落点 | 状态 |
|---|---|---|---|
| skills-local | 自研技能（软链） | `~/.agents/skills/` + 库内 life/场景-求职 | 完成 |
| skills-third | 第三方技能 | `~/.agents/skills/` + `.skill-lock.json` | 完成 |
| browser-detect | 浏览器探测 | Edge + `browser-ops/scripts/detect.py` | 完成 |
| browser-runtime | 浏览器自动化 | browser-harness + bsk | 完成 |
| memory-hindsight | 记忆 | Hindsight slim + **oMLX**（embed/rerank :8000） | 完成 |
| office-skills | 文档办公 | pdf/pptx/xlsx/docx 等 | 完成 |
| mcp-builder | MCP 构建参考 | `mcp-builder` 技能 | 完成 |

接线约定：

- retain/recall 前：`hooks/pre-retain.sh` → 探 `<omlx-service>/health`（调用方 A）
- 嵌入/重排：Hindsight env → `host.docker.internal:8000`（模型 id 见 cutover 方案）
- 自动记忆验证期：S1（任务结束钩子 → retain；钩子脚本见 `hooks/`）
- 已退役：Xinference Metal :9997、ensure/idle-release LaunchAgent（见 `archive/2026-11-06/xinference-retired/`）
