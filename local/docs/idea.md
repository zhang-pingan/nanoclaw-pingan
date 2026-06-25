# Agent 工程热点与 Icarus 优化想法

日期：2026-06-25

扫描窗口：最近一个月，重点关注 agent 工程生产化相关方向，包括 MCP、A2A、ARD、OpenTelemetry GenAI、Agent SDK、长流程恢复、评测闭环、subagents 和 agent UI。

## 结论

最近一个月的热点不是“换一个 agent 框架”，而是 agent 工程的生产化控制面：

- 能力发现：让 tools、skills、agents、workflows 可以被声明、发现、校验和审计。
- 工具权限：从静态 profile 走向集中授权、风险分级、按上下文动态 allow/deny/ask。
- 长流程恢复：workflow 必须能 pause、resume、checkpoint、重试，并且不能依赖完整上下文重放。
- Trace 到 Eval 闭环：把失败 trace、人工 revise、quality gate finding 自动沉淀为评测样本。
- 上下文治理：显式记录 context pack 的来源、新鲜度、缺失项、冲突项和 diff。
- Agent UI 标准化：用 schema/action declaration 统一 Web、移动端、桌面助手的交互表单。

Icarus 已经有较强的底座：宿主机可信编排、容器隔离、MCP stdio、workflow checkpoint/interrupt/outbox、agent query trace、quality gate、LLM judge、context pack、assistant proactive/evolution。优化重点应是把这些能力标准化和闭环化，而不是整体迁移到 ADK、LangGraph 或 OpenAI Agents SDK。

## 外部热点

### MCP 企业授权与工具治理

MCP 方向近期重点是企业托管授权、集中策略和 OAuth 流程，核心价值是避免每个 agent 或 MCP server 自己维护一套权限逻辑。

对 Icarus 的启发：

- 当前 `container/mcp/mcp.json` 已经有 profile/group 级工具白名单。
- 当前 MCP server 通过 `BUILTIN_TOOL_VISIBILITY` 区分 `main`、`non_main`、`all`。
- 下一步应加入工具风险分级、workflow/stage 范围、审批策略、审计字段，而不是只靠 group profile。

参考：

- https://blog.modelcontextprotocol.io/posts/enterprise-managed-auth/

### ARD / Agent Capability Discovery

Google 发布 Agentic Resource Discovery，强调 agentic resource 的发现、验证和组合。它适合用来统一描述 tools、skills、agents、workflows、schemas、UI actions。

对 Icarus 的启发：

- 当前能力散在 `container/skills/`、`container/workflow-definitions/`、`container/mcp/mcp.json`、channel registry 和 workflow evaluator 配置里。
- 可以生成一个内部 `agent-capabilities.json`，作为 Icarus 的本地能力目录。
- Workbench 可以展示能力目录，workflow 启动前也可以校验引用的 skill/tool/evaluator 是否存在且权限足够。

参考：

- https://developers.googleblog.com/announcing-the-agentic-resource-discovery-specification/

### A2A 与跨 agent 协作

A2A v1.0 方向强调 agent 间互操作、任务交接、能力声明和协作协议。Icarus 当前已经有主群、worker group、delegation、complete_delegation 等内部协作模型。

对 Icarus 的启发：

- 短期不需要实现完整 A2A server。
- 可以先把内部 delegation envelope 做得更标准：任务 ID、能力声明、输入 schema、输出 contract、trace ref、权限边界、恢复语义。
- 未来如果要让外部 agent 接入，A2A 适合作为边界协议。

参考：

- https://developers.googleblog.com/en/how-a2a-is-building-a-world-of-collaborative-agents/

### 长流程 agent 的 pause/resume

近期 ADK 相关实践强调长流程 agent 应通过事件、checkpoint 和 resume condition 恢复，而不是靠重放整个历史上下文。

对 Icarus 的启发：

- Icarus 已经有 `workflow_interrupts`、`workflow_checkpoints`、`workflow_outbox`。
- 还缺一个启动恢复 worker，把 stale workflow、pending outbox、expired interrupt、running delegation 系统化处理。
- checkpoint 里应增加 `next_wake_condition`、`resume_command`、`state_summary`，让恢复更像明确状态机，而不是人工读 trace。

参考：

- https://developers.googleblog.com/build-long-running-ai-agents-that-pause-resume-and-never-lose-context-with-adk/

### Trace / Eval / 改进闭环

OpenAI Agents SDK、Agent Evals 和 Jules 相关实践都在强调把真实 agent 运行、失败、人工修正转化为可重复评测数据。OpenTelemetry GenAI 也在标准化模型调用、工具调用、usage、agent span 等字段。

对 Icarus 的启发：

- `agent_queries` 已经保存 token、cost、failure、tool count、artifact count、hash 等关键字段。
- `workflow_stage_evaluations`、`workflow-quality-gate`、`workflow-llm-judge` 已经能表达阶段质量。
- 应补一个 OTLP/JSONL exporter，并把失败 trace、人工 revise、quality gate finding 自动转为 eval cases。

参考：

- https://openai.github.io/openai-agents-python/tracing/
- https://developers.openai.com/api/docs/guides/agent-evals
- https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
- https://developers.googleblog.com/measuring-what-matters-with-jules/

### Subagents 与专门化执行

Claude Code、Gemini CLI、OpenAI Agents 等生态都在强化 subagents、handoffs、specialized agents。趋势是用更小、更专门的 agent 承担局部任务，而不是一个 agent 扛完整流程。

对 Icarus 的启发：

- Icarus 现有 workflow role 和 worker group 已经接近 subagent 架构。
- 可以继续强化 role/skill 的输入输出 contract，让每个 worker 更像一个可测、可替换的专门 agent。
- 对复杂阶段可以允许主 agent 启动 subagent，但 subagent 结果必须回到宿主机 trace 和 artifact contract。

## 项目现状映射

### 已具备的优势

- 产品边界清晰：Web 工作台、个人助理、飞书移动补充、企微员工私聊、宿主机、容器 agent 边界明确。
- 安全边界清晰：真实凭证留在宿主机，容器通过 credential proxy，项目根目录只读挂载。
- Workflow 底座扎实：配置驱动状态机、interrupt、checkpoint、outbox、action item、artifact、evaluation 都已经存在。
- Trace 数据模型比较完整：`agent_queries`、`agent_query_steps`、`agent_query_events` 已经能支撑可观测性。
- Context pack 已有雏形：readiness、query plan、evidence index、hash 都已存在。
- Quality gate 已有雏形：deterministic evaluator + LLM judge sidecar 的方向正确。

### 当前主要缺口

- MCP 权限还是静态 profile，没有工具风险分级、按 workflow/stage 动态策略和审批语义。
- 能力目录分散，缺少统一 capability registry。
- Trace 还偏内部展示，没有对齐 OpenTelemetry GenAI，也没有稳定导出为 eval dataset。
- Workflow checkpoint 存了状态，但恢复 worker 和恢复语义还可以加强。
- Context pack 能生成，但缺少强制的新鲜度、diff、冲突处理和缺失项自动 interrupt。
- Quality gate 主要用于单次阶段判断，还没有形成跨时间的质量指标和回归分析。
- Web、Feishu、Assistant 的 action UI 可以进一步统一为 schema-driven action renderer。

## 优先优化点

### P0：MCP 工具策略引擎

目标：从 group profile 升级为 host-side policy engine。

建议设计：

- 为每个 MCP 工具增加元数据：
  - `risk_level`: `low | medium | high | critical`
  - `scopes`: 例如 `memory:read`、`memory:write`、`host:script`、`desktop:capture`
  - `allowed_groups`
  - `allowed_workflow_types`
  - `allowed_stage_keys`
  - `requires_approval`
  - `audit_payload_fields`
- `ipc-mcp-stdio.ts` 只做工具声明和请求转发，最终 allow/deny/ask 由宿主机判断。
- 高风险工具默认走 interrupt/action item：
  - `memory_delete`
  - `memory_resolve_conflict`
  - `cancel_task`
  - `run_local_host_script`
  - `desktop_capture`
  - `ios_host_debug_shell`
  - 涉及部署、删除、重启、权限变化的工具
- Workbench 增加工具策略页，展示最近高风险工具调用和审批结果。

落点文件：

- `container/mcp/mcp.json`
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `src/ipc.ts`
- `src/workflow-interrupt-command.ts`
- `src/workbench.ts`

收益：

- 明确降低 agent 工具误用风险。
- 为后续引入外部 MCP server 打基础。
- 让权限控制从容器内配置上移到可信宿主机。

### P0：Trace / Eval Exporter

目标：把 Icarus 运行数据变成可查询、可导出、可回归的 agent eval 资产。

建议设计：

- 增加 `agent_trace_exporter`：
  - 输出 JSONL，后续可接 OTLP。
  - 每条 query 包含 prompt hash、memory pack hash、tools hash、mounts hash、model、usage、failure、tool events、artifact contract status。
- 增加 `eval_cases` 表：
  - 来源：失败 query、人工 revise、quality gate finding、LLM judge finding、用户 negative feedback。
  - 字段：input、expected behavior、rubric、source trace、workflow type、stage、service、created_at。
- Workbench Trace 页增加“加入评测集”动作。
- Assistant proactive 每周生成“本周 agent 质量报告”。

落点文件：

- `src/agent-query-trace.ts`
- `src/agent-query-trace-summary.ts`
- `src/workflow-quality-gate.ts`
- `src/workflow-llm-judge.ts`
- `src/db.ts`
- `src/assistant/proactive-engine.ts`

收益：

- 把失败转成资产。
- 模型路由、prompt、skill、workflow 改动可以用历史样本回归。
- 自我进化不再只靠一次性主观判断。

### P0：Workflow 恢复 worker

目标：让 workflow 在服务重启、容器异常、中断过期、outbox 卡住后可自动进入可解释状态。

建议设计：

- 启动时扫描：
  - pending/processing outbox
  - running workflow 但 delegation stale
  - pending interrupt 且 expired
  - active container 记录不存在或 query timeout
- 为 checkpoint 增加：
  - `state_summary`
  - `next_wake_condition`
  - `resume_command`
  - `last_effect_ids`
  - `blocking_reason`
- 恢复结果写入 workflow event 和 workbench timeline。
- 对不可自动恢复的状态创建 action item，提醒用户选择 retry/skip/cancel。

落点文件：

- `src/workflow.ts`
- `src/db.ts`
- `src/workbench-store.ts`
- `src/assistant/proactive-engine.ts`
- `src/group-queue.ts`

收益：

- 长流程可靠性明显提升。
- 服务重启后不会留下“看起来还在跑”的幽灵任务。
- Assistant 主动提醒会更精准。

### P1：本地 Capability Registry

目标：统一描述 Icarus 内部可用能力。

建议生成 `local/generated/agent-capabilities.json` 或 `data/capabilities/agent-capabilities.json`，包含：

- skills：名称、路径、说明、输入要求、产出文件、风险。
- workflows：类型、状态、角色、入口、interrupt、artifact contract。
- MCP tools：schema、risk、scope、allowed group。
- channels：可支持的 action、card、attachment、reply。
- evaluators：deterministic/llm judge 配置和 rubric。

Workbench 可用它做能力页面，workflow compiler 可用它做静态校验。

落点文件：

- `container/skills/`
- `container/workflow-definitions/`
- `container/artifact-contracts/`
- `container/workflow-evaluators/`
- `src/workflow-compiler.ts`
- `src/channels/web.ts`

收益：

- 降低新增 workflow/skill 时的隐性错误。
- 为未来 A2A/ARD 对外暴露能力做准备。

### P1：Context Pack 治理增强

目标：把 context pack 从“材料包”升级为“上下文治理机制”。

建议设计：

- 每个 source 增加 freshness policy。
- 每次 delegation 记录 context diff：
  - 新增来源
  - 删除来源
  - stale 来源
  - 冲突字段
- 对 `readiness.status = needs_input | blocked` 自动创建 interrupt。
- 对敏感字段保持 redact，同时记录 redaction reason。
- 在 trace 中记录 context pack hash 和 diff summary。

落点文件：

- `src/workflow-context-pack.ts`
- `src/workflow-context.ts`
- `src/workflow.ts`
- `src/agent-query-trace.ts`

收益：

- 减少 agent 猜需求、用过期材料、忽略冲突上下文。
- 调试失败时可以快速判断是不是上下文问题。

### P1：质量指标与回归看板

目标：从单次 quality gate 升级为趋势指标。

建议指标：

- workflow type / stage 成功率。
- revise 次数。
- 平均 token 和成本。
- 平均耗时。
- failure taxonomy 分布。
- artifact contract pass rate。
- LLM judge finding 类型分布。
- 人工审批通过率。

Assistant proactive 可以基于这些指标生成异常提醒，例如：

- “最近 7 天 `dev_test.dev` 阶段 revise 率上升。”
- “`web_test` worker 的 artifact contract pass rate 下降。”
- “某个模型在 plan-examine 上成本升高但通过率没有提升。”

落点文件：

- `src/workflow-quality-gate.ts`
- `src/workflow-stage-evaluation.ts`
- `src/assistant/proactive-engine.ts`
- `src/channels/web.ts`
- `electron/renderer/`

收益：

- 能知道 agent 系统是在变好还是变差。
- 自我进化可以基于真实指标选择优化方向。

### P1：Schema-driven Action UI

目标：Web、Feishu、Assistant Inbox 统一使用 action schema 渲染表单和按钮。

当前 `src/schema-card.ts` 已经能把 JSON schema 转成 card inputs。建议继续抽象：

- `ActionDefinition`
  - action id
  - title
  - description
  - input schema
  - allowed channels
  - risk level
  - submit endpoint
  - success/failure render
- Web 使用完整表单。
- Feishu 使用轻量卡片。
- Assistant Inbox 使用同一 action schema 的桌面版。

落点文件：

- `src/schema-card.ts`
- `src/workbench-broadcast-render.ts`
- `src/channels/feishu.ts`
- `src/assistant/assistant-inbox-broadcast-render.ts`
- `electron/renderer/`

收益：

- 避免同一个 action 在多个入口逻辑分叉。
- 新增 interrupt/action item 时更快、更安全。

### P2：模型路由闭环化

目标：模型选择不只靠规则，而是基于 stage 历史质量和成本动态调整。

建议设计：

- 对每个 workflow type / stage 统计：
  - 模型
  - 成功率
  - revise 率
  - 平均 token
  - 平均耗时
  - artifact contract pass rate
- 引入 champion/challenger：
  - 默认模型是 champion。
  - 少量流量试 challenger。
  - 定期由质量指标决定是否切换。
- 对高风险 stage 强制 heavy 或人工确认。

落点文件：

- `src/model-selector.ts`
- `src/agent-query-trace.ts`
- `src/workflow-stage-evaluation.ts`

收益：

- 降成本且不牺牲质量。
- 模型升级、降级、替换有数据支撑。

## 不建议现在做

- 不建议整体迁移到 Google ADK、LangGraph 或 OpenAI Agents SDK。Icarus 当前的宿主机状态机、容器隔离、channel 边界和本地数据模型都比较贴合产品定位，整体迁移成本高且收益不确定。
- 不建议把 A2A 作为近期主线。内部 delegation 先标准化即可，等有真实外部 agent 接入需求时再实现协议边界。
- 不建议把所有 MCP server 直接暴露给容器 agent。应先完成 host-side policy engine，否则工具扩展会放大风险。
- 不建议让 self-evolution 自动合并主分支。可以让它自动发现、自动提案、受控实现，但 adoption 仍应由用户确认。

## 建议实施顺序

1. MCP 工具策略引擎。
2. Workflow 恢复 worker。
3. Trace / Eval Exporter。
4. 本地 Capability Registry。
5. Context Pack 治理增强。
6. 质量指标与回归看板。
7. Schema-driven Action UI。
8. 模型路由闭环化。

前三项是基础设施级收益，能直接提升安全性、可靠性和可持续优化能力。后续几项适合在基础打稳后逐步产品化。
