# Personal Assistant 主动运行时重构方案

## 背景

当前 Web 客户端应定位为个人工作台：用户主动打开、查看、配置、审批和追踪任务。它是被动型控制台，不应承担持续打扰用户、主动发现问题、主动排查问题的职责。

桌面个人助手应定位为主动型 agent：常驻、观察系统状态、合并上下文、判断是否需要提醒用户，并在权限策略允许时发起排查、准备修复或执行安全修复。容器 agent 可以拥有高权限，但个人助手必须在调用容器 agent 前建立清晰的策略边界、审批边界和审计闭环。

## 现状判断

当前代码已经有主动助手雏形：

- `src/assistant/proactive-engine.ts`：周期扫描今日计划、工作台、定时任务、agent run 和线上日志，并生成 agent inbox。
- `src/assistant/types.ts`：已有 `AgentInbox`、`AssistantSettings`、`proactiveLevel`、`quietHours`、`triggerRules` 等概念。
- `src/assistant/assistant-auto-flow.ts`：已有自动排查和自动修复链路。
- `src/assistant/assistant-actions.ts`：已有 mark read、dismiss、snooze、resolve、execute、investigate、repair、auto 等动作。
- `assistant/renderer/app.ts`：桌面助手可以展示一条主动事项，并提供查看、排查、修复、稍后、忽略等操作。
- `container/agent-runner/src/index.ts`：容器 agent 权限较高，具备多工具执行能力。

主要问题是：主动逻辑、规则扫描、inbox 生成、权限判断和执行策略耦合在一起。系统更像“规则提醒器”，还不是“主动运行时”。

## 目标架构

```text
Web 工作台
  - 被动控制台
  - 配置中心
  - 审批中心
  - 审计和追踪入口

Personal Assistant
  - 主动感知
  - 情境聚合
  - 打扰策略
  - 行动规划
  - 权限调度
  - 反馈学习

Container Agent
  - 高权限执行器
  - 排查器
  - 修复器
  - 工具调用环境
```

目标不是让桌面助手替代工作台，而是让助手成为工作台之上的主动层。助手负责发现和推进，工作台负责控制和透明化。

## 核心重构

将 `src/assistant/proactive-engine.ts` 从规则扫描器重构为 orchestrator，主动逻辑拆成五层。

### 1. Signals

目录建议：

```text
src/assistant/signals/
  types.ts
  today-plan-signals.ts
  workbench-signals.ts
  scheduler-signals.ts
  agent-run-signals.ts
  online-log-signals.ts
  index.ts
```

职责：把不同数据源统一转换为 `AssistantSignal`。

示例类型：

```ts
export interface AssistantSignal {
  id: string;
  source: 'today_plan' | 'workbench' | 'scheduler' | 'agent_run' | 'online_log';
  kind: 'missing_plan' | 'pending_action' | 'failure' | 'stale' | 'error_spike' | 'opportunity';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  title: string;
  body: string;
  occurredAt: string;
  dedupeKey: string;
  refs: {
    service?: string;
    taskId?: string;
    workflowId?: string;
    runId?: string;
    queryId?: string;
    chatJid?: string;
  };
  evidence: Array<{ label: string; value: string }>;
  raw: Record<string, unknown>;
}
```

好处：

- 每个数据源只负责感知，不负责决定是否提醒。
- 后续可以同时支持扫描式 signal 和事件式 signal。
- 容易测试，每个 signal collector 单独验证。

### 2. Situations

目录建议：

```text
src/assistant/situations/
  types.ts
  correlator.ts
  store.ts
  renderer.ts
```

职责：把相关 signal 合并成一个 `AssistantSituation`。

例如：

```text
workbench.task_failed
agent_runs.query_failed
online.error_logs
```

如果它们指向同一个 `service`、`workflowId`、`runId` 或时间窗口，应合并成一个 situation，而不是生成三条独立提醒。

示例类型：

```ts
export interface AssistantSituation {
  id: string;
  status: 'open' | 'investigating' | 'waiting_approval' | 'resolved' | 'dismissed';
  category: 'planning' | 'workbench' | 'ops' | 'agent_run' | 'system';
  severity: 'low' | 'normal' | 'high' | 'urgent';
  title: string;
  summary: string;
  primaryRefs: {
    service?: string;
    taskId?: string;
    workflowId?: string;
    runId?: string;
    queryId?: string;
  };
  signalIds: string[];
  evidence: Array<{ label: string; value: string }>;
  createdAt: string;
  updatedAt: string;
}
```

好处：

- 减少重复打扰。
- 提醒质量更高。
- 桌面助手展示的是“问题”而不是“日志项”。

### 3. Policy

目录建议：

```text
src/assistant/policy/
  types.ts
  notification-policy.ts
  permission-policy.ts
  learning-policy.ts
```

职责：决定是否提醒、何时提醒、是否自动处理、是否需要审批。

必须真正使用现有设置：

- `enabled`
- `proactiveLevel`
- `quietHours`
- `triggerRules`
- `maxInboxItems`
- `selectedServices`

建议权限级别：

```ts
export type AssistantPermissionLevel =
  | 'notify_only'
  | 'investigate'
  | 'prepare_fix'
  | 'auto_fix_safe'
  | 'requires_approval';
```

策略示例：

- `quiet`：只弹 urgent 和 high risk，其余静默进入 inbox。
- `balanced`：弹失败、审批、卡住任务、关键今日计划。
- `active`：允许弹建议类事项和机会类事项。
- quiet hours 内：只允许 urgent 打扰，其他延后。
- 用户多次 dismiss 的同类事项：降级或延长冷却。
- 改代码、部署、重启服务、删除数据、改权限：必须 `requires_approval`。
- 读日志、查 trace、汇总证据：可 `investigate`。

好处：

- 主动性可控。
- 容器 agent 高权限不会直接外溢。
- 用户能理解为什么被打扰。

### 4. Planner

目录建议：

```text
src/assistant/planner/
  types.ts
  plan-builder.ts
  prompt-builder.ts
```

职责：把 situation 和 policy decision 转换成行动计划。

示例类型：

```ts
export interface AssistantPlan {
  id: string;
  situationId: string;
  status: 'draft' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  permissionLevel: AssistantPermissionLevel;
  steps: AssistantPlanStep[];
  requiresApproval: boolean;
  approvalReason?: string;
  createdAt: string;
}

export interface AssistantPlanStep {
  id: string;
  kind: 'notify' | 'investigate' | 'prepare_fix' | 'execute_fix' | 'verify' | 'open_workbench';
  title: string;
  payload: Record<string, unknown>;
}
```

计划链路：

```text
detect situation
  -> policy decision
  -> build plan
  -> request approval if needed
  -> execute
  -> verify
  -> update situation and inbox
```

好处：

- 自动修复不再是黑盒。
- 用户能审批具体 plan，而不是审批一句“修复”。
- 后续可以支持计划回放、失败重试和审计。

### 5. Executor

目录建议：

```text
src/assistant/executor/
  types.ts
  plan-executor.ts
  agent-runner.ts
  verifier.ts
```

职责：执行计划，并强制权限边界。

关键原则：

- executor 是唯一可以调用高权限容器 agent 的地方。
- 调用前检查 permission policy。
- 调用后必须记录 action log。
- 修复类动作必须有验证步骤。
- 验证失败不能 mark done。

当前 `assistant-auto-flow.ts` 可以逐步迁移到 executor：

```text
investigateAgentInboxItem -> execute investigate step
repairAgentInboxItem      -> execute prepare_fix/execute_fix/verify steps
autoProcessAgentInboxItem -> run full plan
```

## 数据模型建议

当前 `agent_inbox_items` 可以保留为用户可见提醒层，但底层建议新增表。

```text
assistant_signals
  id
  source
  kind
  priority
  dedupe_key
  refs_json
  evidence_json
  raw_json
  occurred_at
  created_at

assistant_situations
  id
  status
  category
  severity
  title
  summary
  primary_refs_json
  signal_ids_json
  evidence_json
  created_at
  updated_at
  resolved_at

assistant_decisions
  id
  situation_id
  decision
  permission_level
  reason
  policy_snapshot_json
  created_at

assistant_plans
  id
  situation_id
  status
  permission_level
  steps_json
  requires_approval
  approval_reason
  created_at
  updated_at

assistant_feedback
  id
  situation_id
  inbox_item_id
  action
  reason
  created_at
```

`agent_inbox_items` 建议增加：

```text
situation_id
decision_id
plan_id
```

如果暂时不想迁移数据库，可以先把这些 ID 放入 `extra_json`，等结构稳定后再建列。

## 桌面助手体验优化

桌面助手不应只是弹通知。每条提醒建议展示：

- 一句话结论。
- 为什么提醒我。
- 关键证据。
- 建议动作。
- 权限状态：仅提醒、可排查、需审批、可自动修复。
- 反馈入口：稍后、忽略、不再提醒此类、判断不对。

现有按钮可以演进为：

```text
查看
排查
准备修复
批准执行
稍后
忽略
不再提醒此类
判断不对
```

用户反馈写入 `assistant_feedback`，并进入 `learning-policy`。

## Web 工作台优化

Web 端作为被动控制台，应加强以下能力：

- 主动助手策略配置。
- 每条规则最近命中次数。
- 每条规则误报反馈。
- 自动排查次数。
- 自动修复成功率。
- 当前冷却规则。
- 待审批计划。
- situation 时间线。
- action log 和 agent trace 跳转。

Web 不负责主动弹出，它负责让用户看清助手做了什么、为什么做、下一步要不要批准。

## 安全边界

当前容器 agent 能力强，必须在助手层建立硬边界。不能只依赖 prompt。

建议规则：

- 读操作默认允许排查。
- 写本地临时文件可以允许。
- 修改项目代码需要 plan。
- 删除文件、重置 git、改权限、改密钥、部署、重启线上服务必须审批。
- 发送外部消息或邮件必须审批，除非是用户明确发起。
- 修复完成必须验证。
- 验证失败不能自动关闭 situation。

## 分阶段落地

### 阶段 1：低风险解耦

目标：不改变用户体验，先拆结构。

- 新增 `signals` 类型和 collector。
- 让现有扫描规则先产出 signals。
- 新增 `situations` 聚合器，先做简单一对一映射。
- `proactive-engine.ts` 只负责 orchestrate。
- 继续复用 `agent_inbox_items`。

验收：

- 现有测试通过。
- inbox 行为基本不变。
- 每个 inbox item 的 `extra_json` 中能追溯 signal/situation。

### 阶段 2：打扰策略和解释

目标：让助手更像主动助手，而不是提醒器。

- 实现 `notification-policy.ts`。
- 真正使用 `proactiveLevel` 和 `quietHours`。
- 增加 policy decision 记录。
- 桌面提醒展示“为什么提醒我”和证据。
- `dismiss/snooze/resolve` 写入 feedback。

验收：

- quiet hours 内只有 urgent 打扰。
- 多条相关问题合并为一个 situation。
- 用户可以看到提醒原因。

### 阶段 3：权限策略和审批

目标：让高权限 agent 可控。

- 实现 `permission-policy.ts`。
- 引入 `AssistantPlan`。
- 自动修复拆成 `prepare_fix -> approval -> execute_fix -> verify`。
- Web 工作台增加待审批计划入口。
- executor 成为唯一高权限调用入口。

验收：

- 危险动作必须审批。
- 自动修复有 plan 和验证结果。
- 审批、执行、验证都有 action log。

### 阶段 4：反馈学习

目标：降噪和个性化。

- 实现 `learning-policy.ts`。
- 根据 dismiss/snooze/resolve 调整优先级和冷却。
- 支持按 source、rule、service、severity 学习。
- Web 展示规则命中和反馈统计。

验收：

- 同类误报会自动降级。
- 高频处理事项会保持或升级。
- 用户可以重置学习结果。

## 参考依据

本方案结合了当前代码结构和以下 agent/UX 原则：

- Anthropic Engineering: Building effective agents
  - 简单、可组合优先。
  - 区分 workflow 和 autonomous agent。
  - 自主 agent 需要反馈、停止条件、检查点和 guardrails。
- OpenAI Agents SDK: Human-in-the-loop
  - 敏感工具调用应暂停、审批、恢复。
  - 审批项需要可见、可追踪。
- OpenAI Agents SDK: Guardrails
  - 输入、输出和工具调用都应有校验。
  - 高风险工具调用不能只靠 prompt 约束。
- Microsoft Guidelines for Human-AI Interaction / HAX Toolkit
  - 基于上下文选择打扰时机。
  - 支持快速忽略和纠正。
  - 解释系统为什么这么做。
  - 从用户行为学习。
  - 提供全局控制。

## 总结

这次重构的核心不是增加更多规则，而是把个人助手从“扫描规则生成提醒”升级为“主动运行时”。

最终形态应是：

```text
signals -> situations -> policy -> planner -> executor -> feedback
```

Web 工作台保持被动和透明，桌面助手承担主动感知和推进，容器 agent 作为受策略约束的高权限执行器。这样既能提升智能度，也能降低主动 agent 带来的权限和打扰风险。
