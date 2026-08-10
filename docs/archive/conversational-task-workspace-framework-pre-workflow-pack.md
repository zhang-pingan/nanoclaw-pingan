# Icarus 对话式任务工作台框架方案

> **状态**：已确认方案，待实施
> **核对基线**：2026-08-06 当前代码
> **实施基础**：[Dynamic Workflow Runtime](../../docs/dynamic-workflow-runtime.md) 的领域事务、Runtime Outbox、Projection、Runtime Center 和 `WorkflowExecutionWorker` 已实现
> **范围**：Host Runtime 推进服务、Core Task Workspace、TaskSession Coordinator、Published/Temporary/Personal Workflow 启动、运行干预、通用 Runtime Inspector
> **设计原则**：项目和数据均在用户本机运行；在不破坏 Runtime 权威性、幂等和可恢复性的前提下，优先采用最少服务、最少持久化层和最少跨进程协议的实现
> **项目边界**：本文中的 publish、activate、合同、审计和 readiness 只表示当前内部基线、本地启用、机器接口与排障要求，不要求复制 G0-G9 认证流程。详见 [`internal-experimental-scope.md`](../../docs/internal-experimental-scope.md)

## 导航

- [背景与代码结论](#背景与代码结论)
- [目标](#目标)
- [非目标](#非目标)
- [已确认架构决策](#已确认架构决策)
- [产品与系统边界](#产品与系统边界)
- [总体架构](#总体架构)
- [Runtime Readiness](#runtime-readiness)
- [核心对象模型](#核心对象模型)
- [TaskSession 与 Conversation](#tasksession-与-conversation)
- [Composer 与 Workflow 选择](#composer-与-workflow-选择)
- [Published Workflow 启动](#published-workflow-启动)
- [Temporary Workflow](#temporary-workflow)
- [WorkflowRuntimeService](#workflowruntimeservice)
- [Session Coordinator](#session-coordinator)
- [Timeline 与 Runtime 事件](#timeline-与-runtime-事件)
- [Human Input](#human-input)
- [Runtime Inspector](#runtime-inspector)
- [运行控制与 Replan](#运行控制与-replan)
- [Personal Workflow](#personal-workflow)
- [与 Runtime Center 的关系](#与-runtime-center-的关系)
- [与 Feature Workflow 的关系](#与-feature-workflow-的关系)
- [持久化与一致性](#持久化与一致性)
- [Gateway、API 与事件协议](#gatewayapi-与事件协议)
- [权限、安全与审计](#权限安全与审计)
- [前端布局与模块边界](#前端布局与模块边界)
- [失败、恢复与降级](#失败恢复与降级)
- [测试策略](#测试策略)
- [实施顺序](#实施顺序)
- [验收标准](#验收标准)
- [后续议题](#后续议题)

## 背景与代码结论

Dynamic Workflow Runtime 已经实现了 Workflow 创建、编译结果持久化、materialize、reconcile、schedule、retry/watchdog、close/finalize、Runtime Outbox、Execution Worker 和 Projection 等领域能力，但这些能力目前主要以事务函数和独立组件存在。

Host 已持续启动 [`WorkflowExecutionWorker`](../../src/workflow-execution/worker.ts)，因此 Runtime Outbox 中已经形成的执行任务能够被消费；但 Host 没有一个持续调用其余 Runtime 事务函数的服务。结果是 Runtime 可以被创建，却没有完整的宿主中控持续把它从待编译推进到 materialize、调度、收敛和结束。

这不是再设计一套 Workflow Engine，而是补齐现有 Engine 的 Host 驱动层。

同时，Runtime 当前对外边界只允许连接、Execution Worker 和 Host Core 使用：

- [`gateway/connection.ts`](../../src/workflow-runtime/gateway/connection.ts)
- [`gateway/execution.ts`](../../src/workflow-runtime/gateway/execution.ts)
- [`gateway/host-core.ts`](../../src/workflow-runtime/gateway/host-core.ts)
- [`gateway-boundary.ts`](../../src/workflow-runtime/contracts/gateway-boundary.ts)

Task Workspace 不应直连 Runtime Store，也不需要新建一个与现有 Runtime Gateway 平行的 Client 体系。方案确定扩展 `src/workflow-runtime/gateway/`，增加 Workspace 专用公共边界。

本文的“Runtime Gateway”始终特指 `src/workflow-runtime/gateway/`。它不是 Host Core 中负责容器 Agent 与外界交互的 Gateway；Host HTTP/WebSocket 只负责把 Workspace 请求适配到 Runtime Gateway。

当前代码还存在三项直接影响本方案的正确性缺口：

1. Compiler 固定读取 `entry_points.default`，见 [`compiler/compiler.ts`](../../src/workflow-runtime/compiler/compiler.ts)。
2. T0 创建意图和 `workflow_creation_requests.entry_point` 固定写入 `default`，见 [`creation/task-intake.ts`](../../src/workflow-runtime/creation/task-intake.ts)。
3. 根 T2a 只接受已发布 Definition 中具有 `golden_corpus` provenance 的 `compiled_plan_pin`，见 [`runtime/reconciler.ts`](../../src/workflow-runtime/runtime/reconciler.ts)。因此用户临时生成的 DAG 不能直接替换根 Plan。

这些缺口必须在 Task Workspace 正式启动 Workflow 前修复或按本文结构接入。

## 目标

- 提供一个本地三栏 Task Workspace：左侧 TaskSession，中间 Conversation Timeline，右侧 Runtime Inspector。
- TaskSession 在 Workflow 创建前即可存在，并能在一次任务中关联多个 Workflow。
- 用户只在 Published Core、Feature、Personal Workflow 和 `Temporary Workflow` 之间明确选择。
- Composer 明确区分普通对话 `Send` 与启动执行 `Run`。
- Published Workflow 以一次明确选择和 `Run` 作为启动授权，不再增加第二次确认。
- Temporary Workflow 先在 Workspace 内形成 immutable Draft，用户确认 exact revision 后才进入 Runtime。
- Host 内持续推进 Runtime，不要求用户操作页面或手动调用事务函数。
- Timeline 能在 Runtime commit 后快速更新，同时可在通知丢失、重启和断线后补齐。
- Human Input 只在 Task Workspace 的 Timeline 和 Inspector Pending 中处理。
- Coordinator 复用现有主 Agent 能力和会话恢复能力，不新增受限 Agent 运行环境。
- 成功的 Temporary Workflow 可以经过审查发布为本地 Personal Workflow。
- Runtime Center 保留全局诊断能力；Task Workspace 提供 task-scoped 操作面。
- 第一版用通用 UI 启动并展示 Feature Workflow，不建设 Feature 专用操作页面。

## 非目标

- 不重写 Dynamic Workflow Runtime 的状态机、事务函数或 Runtime Outbox。
- 不为 compile、materialize、reconcile、schedule、retry、close 分别创建 Worker 或队列。
- Task Workspace service 和 Renderer 不直接操作 Runtime 数据表；Coordinator 的正常 Workflow mutation 必须走 Gateway，但不把这条约定描述成技术性能力隔离。
- 不提供自动匹配 Workflow 的产品选项，也不让模型从自由文本直接选择并启动 Published Recipe。
- 不提供脱离 Workflow 的任务执行路径；实际工作必须进入 Published Workflow 或 Temporary Workflow。
- 不让用户选择 Definition entrypoint、Policy、Capability、Executor 或 Registry closure。
- 不修改已经 materialize 的 Plan、Node、Edge、sealed input、Artifact provenance 或 terminal fact。
- 不保证 Published Workflow 支持通用 Replan。
- 不复制 Runtime Center 的全局运维、Capacity、Projection rebuild 和完整 Trace 页面。
- 不建设新的事件端口、独立事件服务器或额外的 Timeline 投影进程。
- 不建设通用 Workspace 值对象/二进制对象存储。
- 不在第一版提供 Session 物理删除、复杂跨库 GC、多设备同步或多用户 RBAC。
- 不在第一版接入 Feature 专用启动页、专业 Artifact renderer、任务预设或领域命令表单。
- 不在飞书、移动端或其他外部渠道呈现 Task Workspace 可操作卡片。

## 已确认架构决策

### 1. TaskSession 是顶层产品对象

TaskSession 不是 Workflow 的别名。它先承载需求澄清和普通对话，再按用户明确操作关联零个或多个 Workflow。

```text
TaskSession
  -> ConversationThread
  -> Workflow ExecutionLink 0..N
  -> LaunchIntent 0..N
  -> Temporary Draft 0..N
  -> Timeline Entry 0..N
  -> Pending Interaction Link 0..N
  -> Artifact Link 0..N
```

Coordinator 自身的 Agent 执行只记录为 Trace，并由消息上的 `query_id` 关联，不属于 ExecutionLink。

### 2. `Send` 和 `Run` 是两个明确动作

- `Send`：只追加普通 TaskSession 消息并触发 Coordinator 对话。
- `Run`：启动当前选中的 Published Recipe，或创建/继续 Temporary Workflow Draft。

Coordinator 可以解释用户应选择哪个 Workflow，但不能仅根据消息文本直接启动某个 Published Recipe。

### 3. Workflow 选择完全显式

选择器只有：

- active Published Core Workflow；
- active Published Feature Workflow；
- active Published Personal Workflow；
- `Temporary Workflow`。

新 Session 第一次进入运行模式时默认选择 `Temporary Workflow`。同一 Session 内当前选择可以保持，直到用户主动切换；新 Session 不继承上一个 Session 选择的 Published Workflow。

Runtime 中已有的 `routing_scope` 和 `routing_decision` 保留，用于记录“本次明确选择被允许并解析为哪个 exact Recipe”，不是自动匹配结果。

### 4. Host 拥有一个 Runtime 推进服务

新增一个 Host-owned `WorkflowRuntimeService`。Host 只负责 `start()`、`stop()`、`wake()` 和生命周期装配；待处理发现、批次选择、事务输入构造和具体状态推进仍属于 `workflow-runtime`。

### 5. 扩展现有 Runtime Gateway

新增 `src/workflow-runtime/gateway/workspace.ts`，并将它加入 `gateway-boundary.ts` allowlist。

调用链固定为：

```text
Task Workspace
  -> existing Host HTTP/WebSocket Gateway
  -> Runtime Workspace Gateway
  -> Runtime domain transactions and queries
```

### 6. Coordinator 直接复用现有 Agent

Coordinator 直接复用 `InternalAgentChatService`，允许拥有与其他主 Agent 相同的实际能力。不增加专用容器、tool allowlist、mount 限制或只读执行 profile。

“Workflow mutation 走 Runtime Gateway”是为了正确性、幂等和审计的工程约定，不宣称 Coordinator 在技术上绝对无法写其他数据。

### 7. Runtime 事实只能来自权威结果

Agent 文本可以解释“看起来已经暂停”，但 UI 只有收到 Runtime receipt/event 后才能显示为 applied。聊天内容永远不能代替命令结果、Wait resolution、Artifact provenance 或 terminal fact。

### 8. Temporary Workflow 使用固定外层 Plan

平台发布固定 Core Recipe `ad_hoc_personal_task`。它的根 Plan 是静态、已 pin 的 Published Plan，内部提供受控 Expand。用户确认的临时 DAG 作为 Dynamic Child Scope 进入 Runtime，不替换根 Plan。

### 9. 通用 Replan 只属于 Temporary Workflow

Temporary Workflow 可以通过 Core Ad Hoc 协议生成新的确认 revision 和新 Run。Published Core、Feature、Personal Workflow 不提供通用 Replan；它们只能使用自身预定义、typed 的 Rework entrypoint。

### 10. Personal Workflow 是受审查的本地发布物

Personal Workflow 从成功的 Temporary Run 提取 Dynamic Child DAG，经 sanitize、validate、compile、dry-run、review、publish、activate 后进入用户自己的 Catalog。它不会修改原 Run，也不会自动进入 Git。

### 11. Timeline 不需要独立投影 Worker

Runtime commit 后通过 Host `RuntimeEventHub` 发出 best-effort wake notification。Workspace 按 cursor 拉取并持久化 Timeline；启动、打开 Session、WebSocket 重连和低频轮询负责补漏。

### 12. Workspace 使用独立、简单的数据边界

保留 `store/task-workspace.db`。消息和 Draft JSON/TEXT 直接放业务表并保存 hash；附件放 `data/task-workspace/attachments/`。不增加通用对象存储和 Workspace outbox。

### 13. Human Input 只有两个可操作位置

同一个卡片组件出现在：

- Conversation Timeline inline card；
- Runtime Inspector `Pending`。

Runtime Center 只显示 linked pending 摘要并深链回 Task Workspace。没有 TaskSession link 的旧 Runtime 请求继续使用 Runtime Center 已有通用处理能力。

### 14. Feature Workflow 第一版没有专用页面

Feature Package 可以发布 Recipe、Definition、Policy、Capability 和 Artifact contract，但 Feature Workflow 第一版只从 Task Workspace 选择并启动，使用通用 Timeline、卡片、DAG 和 Artifact 展示。

## 产品与系统边界

### Task Workspace

Task Workspace 是用户完成单个任务的主要工作面：

- 创建、继续、完成和归档 TaskSession；
- 普通对话；
- 选择并启动 Published Workflow；
- 生成、修改、确认和启动 Temporary Workflow；
- 查看执行进度、DAG、Artifact、Pending 和 Runtime 摘要；
- 提交 Human Input 和运行控制；
- 对 Temporary Workflow 发起 Replan；
- 将成功 Temporary Run 保存为 Personal Workflow draft。

### Runtime Center

Runtime Center 继续负责：

- 全局 Workflow/Run 索引；
- 全局 pending 摘要；
- diagnostic、quarantine、remediation 和 audit；
- Capacity Admin 和 Runtime Projection rebuild；
- 完整 Trace 与底层运行排障。

它不承载 TaskSession Conversation，也不复制 Workspace 的可操作卡片。

### Host Core

Host Core 负责进程生命周期和现有 HTTP/WebSocket 入口：

- 初始化 Runtime Store；
- 启动/停止 `WorkflowRuntimeService`；
- 启动/停止现有 `WorkflowExecutionWorker`；
- 承载 Runtime Gateway、Task Workspace API 和 `RuntimeEventHub`；
- 将 Timeline delta 通过现有 `/ws` 连接推送给 Renderer。

### Feature Package

第一版 Feature Package 与本方案的关系只到 Runtime 发布资源和通用展示合同，不增加：

- Feature 侧 Workflow 启动入口；
- Feature 独立任务操作台；
- Feature 专用 Artifact renderer；
- Feature 任务预设；
- Feature 领域命令 UI；
- 从 Feature 页面深链创建 TaskSession 的协议。

## 总体架构

```text
Electron Renderer
  |
  +-- existing app.js bundle
        |
        +-- Task Workspace module
              - Task List
              - Conversation Timeline
              - Composer / Workflow Selector
              - Inline Human Input
              - Runtime Inspector
                    |
                    v
Host HTTP API + existing /ws
  |
  +-- TaskWorkspaceService ----------> store/task-workspace.db
  |        |
  |        +-- InternalAgentChatService ----> Agent session + Trace
  |        |
  |        +-- Runtime Workspace Gateway ---> workflow-runtime.db
  |
  +-- WorkflowRuntimeService --------> Runtime transactions
  |
  +-- WorkflowExecutionWorker -------> Runtime Outbox / executors
  |
  +-- RuntimeEventHub
           |
           +-- wake TaskWorkspaceService
           +-- task_workspace_timeline_delta
```

依赖方向：

```text
task-workspace contracts
  <- task-workspace store/services
  <- Host API/WebSocket adapters
  <- Renderer module

workflow-runtime/gateway/workspace
  <- Task Workspace service

workflow-runtime domain/store
  <- workflow-runtime/gateway/workspace
  <- WorkflowRuntimeService internals

Task Workspace implementation
  X<- Workflow Runtime
```

Runtime 不 import Workspace。`RuntimeEventHub` 属于 Host；Runtime 只产生自己的权威事件，Host 在事务完成后发送通知。

## Runtime Readiness

Task Workspace 实施前先补齐以下 Runtime/Host 能力。

### 1. Host Runtime 推进

新增 `WorkflowRuntimeService`，覆盖：

- root/dynamic build compile；
- compiled build materialize；
- graph reconcile；
- runnable work schedule；
- retry、lease/watchdog recovery；
- scope/run close；
- activation/workflow finalize。

现有 `WorkflowExecutionWorker` 保留，继续只负责消费 Runtime Outbox 和回写 Execution result。

### 2. Runtime Workspace Gateway

新增 [`gateway/workspace.ts`](../../src/workflow-runtime/gateway/) 并扩展 [`gateway-boundary.ts`](../../src/workflow-runtime/contracts/gateway-boundary.ts)。

Gateway 至少提供：

- Recipe Catalog query；
- selection token 解析；
- Published/Temporary/Personal 创建；
- creation key 查询；
- task-scoped Runtime Detail query；
- Runtime event cursor query；
- Human Input submission；
- Runtime command；
- Temporary Replan 所需的 closed command。

Workspace 不通过 `gateway/connection.ts` 获取 Store 后自行查询。

### 3. Task Intake source

Runtime 现有 source 保持不变，并增加 `task_workspace`：

```ts
type TaskIntakeSource =
  | 'global_assistant'
  | 'feature_ui'
  | 'schedule'
  | 'api'
  | 'task_workspace';
```

Actor catalog 不新增 Workspace 专用 actor：

```ts
type WorkflowActor =
  | 'human'
  | 'feature_service'
  | 'automation'
  | 'system';
```

Task Workspace 用户点击 `Run` 时使用 `source = 'task_workspace'`、`actor = 'human'`。

### 4. Recipe entrypoint

Publisher 必须把 exact `entry_point` 绑定进 Recipe Release。用户只选 Recipe，不看也不选 entrypoint。

Runtime 修复要求：

- Compiler 按调用方传入且已由 Recipe 绑定的 `entry_point` 解析 `definition.entry_points`；
- creation intent hash 使用 exact entrypoint；
- `workflow_creation_requests.entry_point` 保存 exact entrypoint；
- initial Activation 验证并使用同一个 entrypoint；
- exact replay 对 entrypoint drift 返回 conflict。

### 5. launch policy

保留三种 `launch_policy`：

- `auto`：被授权的 automation 可以直接启动；
- `confirm`：需要 Human launch authorization；
- `manual_only`：只能由 Human 明确选择启动。

这里的 `auto` 是 Registry 中约束 automation 的启动策略，不是 Workspace selector 选项，也不会为 Human 自动选择 Recipe。

在 Task Workspace 中，用户明确选择 Recipe 并点击 `Run` 已经构成 Human launch authorization，`confirm` 和 `manual_only` 不再弹第二个确认框。

T0 必须同时校验 `source + actor + launch_policy + authorization`。当前 T0 尚未完成这项强制校验，属于 readiness blocker。

### 6. Personal Registry

当前 Registry/Publisher 主要覆盖 Core 和 Feature。Personal Workflow 需要新增 principal-owned：

- Recipe namespace；
- Graph Template resource；
- Release；
- active pointer；
- ownership query 和 Catalog filtering。

Publisher/Activation 底层实现必须接入 Host API，不能只停留在可调用库函数。

### 7. Runtime Detail 和事件读取

Runtime Center 的全局 Projection API 不直接等于 Task Workspace 查询。增加 task-scoped query，一次返回 Workspace Inspector 需要的 closed snapshot；增加按 execution/event cursor 拉取 Runtime 事件的接口。

## 核心对象模型

```text
TaskSession
  -> ConversationThread
      -> ConversationMessage
      -> MessageAttachment
  -> LaunchIntent
      -> Published Selection
      -> TemporaryWorkflowDraft
          -> TemporaryWorkflowDraftRevision
      -> ExecutionLink
  -> CoordinatorTurn
      -> Agent query_id
  -> TimelineEntry
  -> RuntimeCursor
  -> PendingInteractionLink
  -> ArtifactLink
  -> RuntimeCommandProposal
  -> ReplanRequest
  -> PersonalWorkflowDraft
```

核心不变量：

1. TaskSession ID 与 chat JID、Agent session ID、Workflow ID、Run ID 相互独立。
2. TaskSession 可以没有 Workflow；一个 Session 可以关联多个 Workflow。
3. ExecutionLink 只表示导航和 correlation，不授予 Runtime 权限。
4. Message、LaunchIntent effective input、Draft revision 和确认 hash 不原地改写。
5. Runtime status、Wait、Command、Artifact 和 terminal 结果不复制为 Workspace 权威字段。
6. 每个跨库 mutation 使用稳定 idempotency key；响应丢失后 query/replay，不凭 UI 状态猜测。
7. Timeline Runtime entry 可删除重建，不影响 Runtime 事件。
8. Agent 文本无 receipt 时不得投影为 applied。
9. Temporary Run 固定 exact confirmed source hash 和 compiled child plan hash。
10. Personal 发布不反向改变来源 Run。
11. Replan 创建新 Activation/Run，旧 Run 和旧 Plan 保持不可变。

## TaskSession 与 Conversation

### TaskSession

```ts
type TaskSessionStatus = 'open' | 'completed' | 'cancelled' | 'archived';
type TaskAttentionState =
  | 'none'
  | 'waiting_user'
  | 'action_required'
  | 'failed';

type TaskRunSelection =
  | {
      kind: 'temporary_workflow';
    }
  | {
      kind: 'published_recipe';
      recipe_ref: VersionedRef;
      recipe_hash: Sha256Hash;
      recipe_kind: 'core' | 'feature' | 'personal';
    };

interface TaskSessionV1 {
  format: 'icarus.task-session/1';
  session_id: string;
  owner_principal_ref: string;
  title: string;
  status: TaskSessionStatus;
  attention_state: TaskAttentionState;
  primary_thread_id: string;
  coordinator_agent_session_id: string | null;
  current_run_selection: TaskRunSelection;
  source:
    | 'task_workspace'
    | 'global_assistant'
    | 'runtime_deep_link'
    | 'api';
  created_at_ms: number;
  updated_at_ms: number;
  row_version: number;
}
```

`current_run_selection` 的新 Session 默认值是 `temporary_workflow`。Published selection 保存 exact identity 供 UI 恢复；真正启动前仍重新获取/校验 selection token。

`attention_state` 是可重建摘要。完成或归档 Session 不会自动 pause/cancel Runtime；若仍有 active Workflow，UI 必须明确提示。

### ConversationThread

第一版每个 TaskSession 只有一个 primary thread，不做分支、多人协作或跨 Session merge。

### ConversationMessage

```ts
type TaskMessageRole = 'human' | 'coordinator' | 'system';

interface TaskConversationMessageV1 {
  format: 'icarus.task-conversation-message/1';
  message_id: string;
  session_id: string;
  thread_id: string;
  message_seq: number;
  role: TaskMessageRole;
  body_json: JsonValue | null;
  body_text: string | null;
  body_hash: Sha256Hash;
  reply_to_message_id: string | null;
  causation_ref: string | null;
  query_id: string | null;
  created_at_ms: number;
}
```

Human 和 Coordinator 消息在追加时，同一个 Workspace transaction 内创建对应 Timeline Entry。

Runtime event 不写成 `system` message。`system` 只用于 Workspace 自己的稳定通知，例如 Coordinator turn 在 Host 重启后被标记 interrupted。

### MessageAttachment

```ts
interface TaskMessageAttachmentV1 {
  attachment_id: string;
  message_id: string;
  relative_path: string;
  content_hash: Sha256Hash;
  mime_type: string;
  size_bytes: number;
  created_at_ms: number;
}
```

只允许 Workspace 管理目录下的相对路径。Runtime Artifact 不复制到该目录。

### ExecutionLink

```ts
interface TaskExecutionLinkV1 {
  link_id: string;
  session_id: string;
  workflow_id: string;
  intake_id: string;
  creation_request_id: string;
  launch_intent_id: string;
  created_at_ms: number;
}
```

创建 Link 时通过 Runtime Gateway 验证四个 identity 属于同一 creation lineage。Session 打开或刷新时懒校验一次。

第一版不保存 last verified hash/version/status，不运行周期 link validator。Link 失效时显示 typed unavailable state；不能把 Link 当作 authorization。

## Composer 与 Workflow 选择

### 交互

Composer 包含：

- 文本输入；
- 附件入口；
- Workflow selector；
- `Send`；
- `Run`；
- Coordinator 正在生成时的停止按钮。

选择器显示产品名称、来源类型、版本摘要和可用状态，不显示技术 entrypoint、Registry ref、Policy ref 或 closure。

### `Send`

`Send` 在一个 Workspace transaction 中：

1. 追加 Human message；
2. 追加同源 Timeline Entry；
3. 创建 pending Coordinator turn；
4. 若该 Session 没有正在运行的 Coordinator turn，则开始调用 `InternalAgentChatService`。

它不创建 LaunchIntent，也不启动 Workflow。

### `Run`

`Run` 把当前输入和附件冻结为 immutable effective input：

- 当前选择 Published Recipe：创建 Published LaunchIntent，并立即调用 Runtime Gateway；
- 当前选择 `Temporary Workflow`：创建或修订 Temporary Draft，进入规划/编译/确认流程。

`Run` 同时把用户输入作为 Human message 写入 Conversation，保证启动输入可在 Timeline 中追溯。

```ts
type TaskLaunchMode = 'published_recipe' | 'temporary_workflow';
type TaskLaunchStatus =
  | 'drafting'
  | 'awaiting_confirmation'
  | 'creating'
  | 'linked'
  | 'unsupported'
  | 'failed'
  | 'cancelled';

interface TaskLaunchIntentV1 {
  launch_intent_id: string;
  session_id: string;
  source_message_id: string;
  mode: TaskLaunchMode;
  selected_recipe_ref: VersionedRef | null;
  selected_recipe_hash: Sha256Hash | null;
  effective_input_json: JsonValue;
  effective_input_hash: Sha256Hash;
  attachment_manifest_hash: Sha256Hash;
  confirmed_draft_revision_id: string | null;
  status: TaskLaunchStatus;
  creation_domain: string;
  creation_key: string;
  idempotency_key: string;
  row_version: number;
}
```

Published LaunchIntent 直接从 `creating` 进入 `linked/failed`。Temporary LaunchIntent 才使用 `drafting/awaiting_confirmation`。恢复时如果原 selection token 已过期，只能在 Catalog 仍返回同一个 exact Recipe version/hash 时换取新 token；否则返回 `selection_stale`。

### Recipe Catalog

`GET recipes` 通过 Runtime Workspace Gateway 返回：

```ts
interface WorkspaceRecipeCatalogItemV1 {
  recipe_kind: 'core' | 'feature' | 'personal';
  recipe_ref: VersionedRef;
  recipe_hash: Sha256Hash;
  display_name: string;
  description: string | null;
  launch_policy: 'auto' | 'confirm' | 'manual_only';
  input_summary: JsonObject;
  selection_token: string;
}
```

Gateway 内部完成：

- principal/ownership 过滤；
- active Release 解析；
- Recipe、Definition、Policy、Schema、entrypoint 和依赖 closure 解析；
- token 与 exact Recipe version/hash、principal、有效期绑定。

Renderer 只提交 `selection_token`，不能提交任意 Registry closure ref。

启动前做一次简单 active check。若 Recipe 已切换版本、禁用或 token 过期，返回 `selection_stale`，刷新 Catalog 后由用户重试。

本地单用户场景不增加 active-pointer transaction lock 或跨库 CAS。检查和 T0 之间的极小竞争窗口可接受；若 T0 已成功，exact replay 保留已创建的旧版本。

## Published Workflow 启动

Published Core、Feature、Personal Recipe 都从同一个 selector 和 `Run` 入口启动。

```text
User selects Recipe + Run
  -> Workspace commits LaunchIntent(status=creating)
  -> Runtime Workspace Gateway resolves selection token
  -> active check
  -> resolve exact Recipe closure and entrypoint
  -> enforce source + actor + launch_policy + authorization
  -> T0 atomically creates Intake + CreationRequest + Workflow + initial Run
  -> Workspace commits ExecutionLink
```

Published 启动不经过 Planner，也没有 Plan 确认卡。Recipe 的发布、review 和 activation 已经承担了 Plan 可信边界。

如果创建调用响应丢失：

1. LaunchIntent 保持 `creating`；
2. Workspace 使用 stable creation domain/key 查询 Runtime；
3. 已创建则补建 ExecutionLink；
4. 未创建则使用原请求 exact replay；
5. 同 key 不同 intent 返回 conflict。

`routing_scope` 固定为 selector 返回的允许范围快照，`routing_decision` 固定为用户选择解析到 exact Recipe 的审计事实。

## Temporary Workflow

### 适用场景

Temporary Workflow 用于用户没有选择 Published Workflow，且任务需要多步骤、并行、等待、Artifact、人工审查或后续 Replan 的场景。

它不是权限扩张机制。平台发布一个 Core `ad_hoc_personal_task` Recipe，固定：

- outer Definition 和 exact entrypoint；
- static pinned root Plan；
- controlled Expand node；
- Planner/Compiler version；
- 可用 Capability、Template、Wait 和 Artifact Contract closure；
- Execution/Command/Context policy；
- Node、Edge、Scope、Attempt、duration、token、Artifact bytes 和 effect ceiling；
- Human review 和 Replan envelope。

### Runtime 前 Draft

用户确认前，全部状态属于 Task Workspace：

- LaunchIntent；
- clarification；
- immutable Draft revision；
- source JSON/hash；
- compile result/hash；
- risk summary；
- confirmation card。

Runtime 中不创建 Intake、Workflow、Run 或临时 Registry resource。

```ts
interface TemporaryWorkflowDraftRevisionV1 {
  format: 'icarus.temporary-workflow-draft-revision/1';
  revision_id: string;
  draft_id: string;
  revision_no: number;
  parent_revision_id: string | null;
  source_message_id: string;
  source_json: JsonObject;
  source_hash: Sha256Hash;
  compiled_plan_json: JsonObject;
  compiled_plan_hash: Sha256Hash;
  compiler_version: string;
  resource_closure_hash: Sha256Hash;
  policy_ceiling_hash: Sha256Hash;
  risk_summary_json: JsonObject;
  created_at_ms: number;
}
```

每次 clarification 或修改生成新 revision。旧 revision 不改写。

### 确认

确认卡至少展示：

- 任务目标和预期交付；
- 主要步骤、并行分支和等待点；
- 外部 effect 摘要；
- 人工输入点；
- 资源预算和 policy ceiling；
- exact revision、source hash 和 compiled plan hash。

用户操作：

- `Run`：确认 exact revision；
- `Revise`：生成新 revision；
- `Discard`：终止 Draft。

确认后 Runtime T0 必须原子持久化：

- Intake 及 input revision；
- launch authorization；
- `workflow_launch_confirmations`；
- Workflow；
- initial Activation/Run；
- exact outer Recipe/Definition closure；
- confirmed child source hash；
- confirmed compiled child plan hash；
- Registry/resource closure hash；
- policy ceiling hash。

### 固定外层与 Dynamic Child

当前根 T2a 要求 Published Definition 的 `golden_corpus` plan pin，因此执行结构固定为：

```text
ad_hoc_personal_task Published Recipe
  -> static pinned root Plan
      -> controlled Expand
          -> user-confirmed Dynamic Child Scope
```

推进过程：

1. Runtime 按 Published outer Definition 编译根 Plan并校验 `compiled_plan_pin`。
2. Root materialize 后，controlled Expand 创建 `ready_to_compile` 的 child build。
3. Runtime 从确认记录读取 exact child source snapshot。
4. Runtime 使用正式 Compiler 重新编译，禁止直接信任 Workspace 的 compiled bytes。
5. 重新编译结果必须匹配用户确认的 `source_hash + compiled_plan_hash + closure + policy ceiling`。
6. 通过现有 [`persistDynamicCompileResultT2a`](../../src/workflow-runtime/runtime/child-runtime.ts) 持久化 Dynamic Child。
7. UI 隐藏通用 outer wrapper，把 Child DAG 作为主要任务 DAG 展示。

如果临时 DAG 超出 Capability、effect、interface、Node、budget 或 policy envelope，返回稳定错误 `unsupported_by_temporary_workflow`。用户应改用 Published Workflow，或发布新的 Core Ad Hoc 版本；不能动态扩大 outer Definition。

## WorkflowRuntimeService

### 定位

`WorkflowRuntimeService` 是 Host 内的 Runtime 驱动循环，不是产品 Agent，也不是新领域状态机。

Host 只控制：

```ts
interface WorkflowRuntimeService {
  start(): Promise<void>;
  stop(): Promise<void>;
  wake(reason?: string): void;
}
```

Runtime 模块内部负责：

- 查询下一批可推进 rows；
- 使用稳定顺序和 bounded batch；
- 构造 exact transaction inputs；
- 调用已有 Runtime 事务函数；
- 处理 CAS conflict、exact replay、retryable error 和 terminal error；
- 返回本轮是否仍有工作。

Host 不查询 Runtime 表再拼事务输入。

### 推进循环

每轮按依赖顺序执行 bounded work：

```text
compile
  -> materialize
  -> reconcile
  -> schedule
  -> retry/watchdog recovery
  -> close/finalize
```

一轮达到 batch/iteration 上限时立即安排下一轮，但要让出 event loop，避免 Runtime backlog 阻塞 Host HTTP/WebSocket 和 Agent。

### 唤醒与轮询

`wake()` 来源：

- Runtime Workspace Gateway mutation commit；
- `WorkflowExecutionWorker` result commit；
- Runtime command/Wait submission commit；
- Runtime service 自己发现仍有工作；
- Host startup scan。

同时保留约 1 秒 fallback poll，处理通知丢失、未知调用路径和时钟到期任务。`wake()` 合并重复信号，不为每个事件创建并发循环；任意时刻最多一个推进循环运行。

### Compiler orchestration

`workflow_graph_scope_builds.status = 'ready_to_compile'` 已是 durable work queue，不增加 compiler queue 或 artifact service。

按 build 类型处理：

- Published root：从 pinned Registry snapshot 加载 Definition，用 Recipe 绑定的 entrypoint 编译，与 `compiled_plan_pin` 比较。
- Temporary child：加载用户确认的 Dynamic Child source snapshot，编译并比较确认 hash。
- Personal child：加载 active Personal Release 中的 reviewed Graph Template，编译并比较发布 hash。

所有结果使用现有 T2a 路径持久化。

### 与 Execution Worker 的边界

- `WorkflowRuntimeService`：决定什么工作现在应该进入 Runtime Outbox，以及结果回来后状态如何继续收敛。
- `WorkflowExecutionWorker`：消费已经存在的 Runtime Outbox，调用 Executor，再通过 Execution Gateway 回写结果。

两者都在 Host 进程运行，但职责不合并。

## Session Coordinator

### 能力与职责

Coordinator 直接调用现有 [`InternalAgentChatService`](../../src/internal-agent-run-once/chat-service.ts)，可以使用与主 Agent 相同的实际能力。

它负责：

- 普通对话和需求澄清；
- 解释 Recipe、Runtime 状态和 Artifact；
- 为 Temporary Workflow 生成/修改 Draft；
- 生成 Runtime command 或 Replan proposal；
- 提示用户使用明确的 selector 和 `Run`；
- 汇总 authoritative Runtime events。

它不能把自然语言回复当作 Runtime 成功事实，也不能绕过 Published Recipe 的明确选择。

### Agent session

每个 TaskSession 持久化一个 `coordinator_agent_session_id`：

- 已存在时正常 resume；
- 缺失时创建新 Agent session；
- 原 session 无法恢复时，用 Workspace 已保存的近期消息和 Runtime summary 启动新 session；
- 不把 TaskSession ID 当 Agent session ID。

Coordinator response 返回的 `query_id` 写入对应 Coordinator message，用于打开 Trace。

### 并发

每个 TaskSession 同时最多一个 Coordinator turn：

```ts
type CoordinatorTurnStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';
```

新 Human message 可以先持久化；如果已有 running turn，则 pending turn 按 message_seq 串行执行。

### Host 重启恢复

- `pending` 且从未开始：Host startup/open Session 时可自动开始。
- `running` 但 Host 重启后结果未知：标记 `interrupted`，不自动重试。
- `interrupted`：由用户点击重试，避免重复外部副作用。
- 已有 partial display 不是完整 Coordinator message；只有 terminal response commit 才写完整消息。

### Mutation 约定

Coordinator 即使拥有广泛工具，也应通过 Runtime Workspace Gateway 提交 Workflow mutation。这一约定提供：

- closed input；
- source/actor；
- target lineage；
- expected row version；
- idempotency；
- canonical receipt；
- Runtime audit。

这是一条应用正确性规则，不作为 Agent 沙箱安全证明。

## Timeline 与 Runtime 事件

### Timeline Entry

```ts
type TaskTimelineEntryKind =
  | 'human_message'
  | 'coordinator_message'
  | 'launch_status'
  | 'workflow_progress'
  | 'node_progress'
  | 'pending_interaction'
  | 'command_result'
  | 'artifact_published'
  | 'workflow_completed'
  | 'system_notice';

interface TaskTimelineEntryV1 {
  entry_id: string;
  session_id: string;
  session_seq: number;
  kind: TaskTimelineEntryKind;
  source_kind: 'workspace' | 'runtime';
  source_id: string;
  source_event_seq: number | null;
  payload_json: JsonObject;
  payload_hash: Sha256Hash;
  occurred_at_ms: number;
  created_at_ms: number;
}
```

消息 Entry 与消息在同一个 Workspace transaction 中写入。Runtime Entry 对 `execution identity + source_event_seq` 建唯一约束。`session_seq` 是增量交付 cursor；`occurred_at_ms` 与稳定 source tie-breaker 决定完整 Timeline 的展示顺序。

### RuntimeEventHub

`RuntimeEventHub` 只传“可能有新 Runtime 事件”的轻量通知，不传权威业务状态。

```text
Runtime transaction commits
  -> Host RuntimeEventHub.notify(execution/cursor hint)
  -> TaskWorkspaceService pulls events after stored cursor
  -> commit Runtime Timeline entries + cursor
  -> existing WebSocket sends task_workspace_timeline_delta
```

通知丢失不影响正确性，因为 cursor pull 是恢复依据。

### Catch-up

执行 catch-up 的时机：

- Host 启动；
- TaskSession 打开；
- Renderer WebSocket 重连；
- RuntimeEventHub 通知；
- 低频 fallback poll。

HTTP `GET timeline?after_session_seq=...` 在响应前也先执行 bounded catch-up，避免页面只依赖推送。

### Rebuild

Runtime Timeline rebuild：

1. 删除指定 Session 的 Runtime-derived Timeline entries；
2. 将对应 Runtime cursor 置 0；
3. 从 Runtime event seq 0 重放；
4. 保留 Human/Coordinator message entries；
5. 重放的 Runtime entries 分配新的单调 `session_seq`，完整列表仍按 `occurred_at_ms + source identity` 稳定显示。

Rebuild 不修改 Runtime Store。

### 展示粒度

- 连续 Node progress 可以折叠；
- retry、Wait、Artifact、Command result 和 terminal event 不丢失；
- Runtime progress 使用紧凑事件行，不伪装成 Agent message；
- 完整 Trace 只通过 deep link 打开 Runtime Center。

## Human Input

### 统一组件

以下请求可以复用同一个 Workspace Card renderer：

- Runtime Wait `signal | approval`；
- Temporary Draft clarification；
- Temporary exact revision confirmation；
- Runtime command confirmation；
- Temporary Replan diff confirmation；
- Personal publish review。

### 可操作 surface

只允许：

- Conversation Timeline inline card；
- Runtime Inspector `Pending`。

两处引用同一 interaction identity 和权威状态。处理后原卡保留但 disabled，并显示 canonical result。

Runtime Center 对 linked request 只显示摘要和“打开 Task Workspace”；无 link 的 Runtime request 维持现有通用处理方式。

### 提交合同

```ts
interface TaskInteractionSubmissionV1 {
  interaction_id: string;
  rendered_snapshot_hash: Sha256Hash;
  action_id: string;
  payload_json: JsonValue;
  payload_hash: Sha256Hash;
  expected_target_row_version: number;
  idempotency_key: string;
}
```

Workspace 校验 Session/link/snapshot 后，通过 Runtime Gateway 交给权威 domain handler。accepted、duplicate、conflict、expired、denied 由目标事务决定。

## Runtime Inspector

Runtime Inspector 使用 task-scoped Runtime Detail Query，不读取 Runtime DB。

第一版只有五个一级面板：

1. `Overview`：linked Workflow、Run 状态、budget、deadline、pending、最近错误和上下文摘要。
2. `DAG`：主要 DAG、scope tree、Node、Edge、Attempt、Wait 和 completion cut。
3. `Artifacts`：Workspace attachments 和 Runtime Artifact links。
4. `Pending`：当前 TaskSession 可操作的 Wait、审批和 action-required。
5. `Trace`：只显示相关性摘要，并深链 Runtime Center 的完整 Trace。

不设置独立上下文面板。

### DAG

- 默认显示当前选中的 linked Workflow/current Run。
- Temporary Workflow 隐藏固定 outer wrapper，Child DAG 为主视图，可展开查看 Runtime wrapper。
- Replan 前后 Run 用 lineage switcher 切换，不合并成一张伪 DAG。
- Node、Edge、Plan 和 sealed input 只读。
- 可用 command hint 由 Runtime Detail Query 返回，点击时 Gateway 再校验。
- Projection/cursor degraded 时标注 freshness，并禁用依赖最新状态的操作。

### Artifact

第一版只提供 generic rendering：

- text/markdown；
- image/audio/video；
- JSON/table；
- diff；
- archive metadata；
- download。

Artifact bytes 继续由原 Store 和权限控制。Workspace 只保存 typed link 和少量 display metadata，不复制 Runtime Artifact。

## 运行控制与 Replan

### 意图到协议

| 用户意图 | 协议 | 是否改变已存在 Plan |
| --- | --- | --- |
| 查询进度、解释失败 | Runtime Detail/Trace query | 否 |
| pause/resume/cancel/允许的 retry | Runtime Command | 否 |
| 回答 Wait、审批、选择 | Human Input submission | 否 |
| 增加独立工作 | 新 Workflow | 否 |
| 使用已发布 Expand 增加 child work | Dynamic Child Scope | 否，新增 child |
| 修改 Temporary 剩余流程 | Temporary Replan | 旧 Plan 不变，创建新 Run |
| 修改已完成外部 effect | 补偿/修复 Workflow | 否 |

普通 Conversation 消息不会进入已经 sealed 的 Node input。它必须明确成为 Wait payload、新 Workflow input、Replan input 或纯 Conversation context。

Pause 只建立 scheduling barrier；已 dispatch 的外部工作可能继续。Replan 前必须处理 running Attempt、unknown effect、cancel capability、fence 和 compensation。

### Temporary Replan

只有以 `Temporary Workflow` 模式启动的 Core Ad Hoc Run 提供通用 Replan：

```text
user requests change
  -> Coordinator builds Replan proposal
  -> freeze source frontier
  -> build new Temporary Draft revision
  -> compile + policy/effect checks
  -> show exact DAG diff
  -> user confirms
  -> fence source Run as required
  -> create new Activation/Run
  -> static outer Plan expands new Dynamic Child
```

Replan 必须保存：

- source Workflow/Activation/Run；
- source frontier；
- active Attempt 和 Wait；
- known/unknown effect receipts；
- input/context snapshot；
- old/new child source and plan hashes；
- policy/budget continuity；
- confirmation；
- supersession lineage。

旧 Run 不改写为新 Plan。若 source effect 状态不明、需要 compensation 未完成或处于 integrity quarantine，则拒绝 apply。

### Published Workflow

Published Core、Feature、Personal Workflow 不开放通用 Replan。

如果发布方预先定义了 typed Rework entrypoint，Workspace 可以把它显示为明确动作并按 Published Workflow 启动合同创建新执行。Coordinator 不能临时生成新 DAG 替换 Published root Plan。

当固定 Core Ad Hoc outer Plan 本身不足以表达任务时，不扩张当前实例；应选择合适 Published Workflow，或发布新的 `ad_hoc_personal_task` Core 版本。

## Personal Workflow

### 定位

Personal Workflow 是用户本地、principal-owned 的 Published Workflow。它来源于成功 Temporary Run，但不是“把当前 Run 改成模板”。

### 保存与发布

```text
successful Temporary Run
  -> Save as draft
  -> extract Dynamic Child DAG
  -> sanitize instance-only data
  -> validate
  -> compile
  -> dry-run
  -> human review
  -> publish inactive Personal Release
  -> activate
  -> appear in Workspace selector
```

Sanitize 至少移除：

- 当前 TaskSession/Workflow/Run/Node ID；
- 临时文件绝对路径；
- Credential、secret 和 session token；
- 一次性 Wait response；
- instance-only Artifact value；
- 临时 deadline 和不可复用 external object identity。

### Release 结构

Personal Release 包含：

- Personal Recipe；
- reviewed Graph Template source/hash；
- compiled child plan hash/compiler version；
- resource closure；
- policy/effect envelope；
- principal ownership；
- active pointer。

Personal Recipe 复用 Core `ad_hoc_personal_task` outer Definition。启动时：

1. 用户从 selector 选择 Personal Recipe 并点击 `Run`；
2. T0 创建固定 outer Run；
3. controlled Expand 加载该 Personal Release 的 Graph Template；
4. Runtime 正式重编译并匹配发布 hash；
5. 使用 Dynamic Child T2a 持久化；
6. 不运行 Planner，也不要求每次确认 DAG。

保存时只提取 Dynamic Child DAG，不保存通用 wrapper。

### 更新

编辑 Personal Workflow 创建新 Draft/Release/version。旧 active Release 保持不变，直到新 Release 成功 activate；旧 Run 始终 pin 原 snapshot。

### 本地与 Git

Personal Workflow 数据位于：

- `store/task-workspace.db`；
- `store/workflow-runtime.db`；
- `data/task-workspace/`。

仓库当前已 ignore `store/` 和 `data/`，所以 clone 后本地创建的 Personal Workflow 不进入 Git。

需要进入 Git 时必须显式：

- export/import 为可审查文件；或
- promotion 为 Feature Package resource。

## 与 Runtime Center 的关系

### Runtime Center 保留

- 全局 Workflow/Run/Pending 索引；
- 完整 Trace；
- diagnostic/quarantine/remediation；
- Capacity；
- Projection rebuild；
- Runtime 审计和 schema 运维。

### Task Workspace 提供

- TaskSession Conversation；
- Workflow 选择和启动；
- task-scoped Timeline；
- inline Human Input；
- 五面板 Runtime Inspector；
- Temporary Draft/Replan；
- Personal Workflow 保存入口。

### 双向导航

- Workspace 的 Trace 打开 Runtime Center exact target。
- Runtime Center 的 linked pending/Workflow 打开对应 TaskSession。
- Runtime Center 没有 link 时继续显示 generic Runtime target，不自动创建 Session。

两侧只传 typed identity，不共享 page store。

## 与 Feature Workflow 的关系

Feature Workflow 的 v1 产品路径固定为：

```text
Feature Package publishes Runtime resources
  -> Runtime Recipe Catalog
  -> Task Workspace selector
  -> user selects Feature Recipe + Run
  -> generic Timeline / cards / DAG / Artifacts
```

第一版不从 Feature 页面启动，也不向 Feature 提供单独 Task Workspace 组件。

Feature disabled 后：

- 新 selection token 不再签发；
- 已拿到 token 的新启动在 active check 时返回 `selection_stale` 或 disabled；
- 历史 TaskSession、ExecutionLink 和通用 Runtime metadata 保持可读；
- 历史 Artifact 使用 generic renderer；
- 需要 disabled Feature resource 的新运行或 Rework 被拒绝。

## 持久化与一致性

### 数据库和文件

新增：

```text
store/task-workspace.db
data/task-workspace/attachments/
```

不复用现有 `messages.db` 的 channel/chat 表。TaskSession Conversation 有不同 identity、sequence、LaunchIntent 和 Runtime correlation 约束。

### Logical Schema

第一版建议：

```text
task_workspace_sessions
task_workspace_threads
task_workspace_messages
task_workspace_message_attachments
task_workspace_coordinator_turns
task_workspace_launch_intents
task_workspace_launch_input_revisions
task_workspace_temporary_drafts
task_workspace_temporary_draft_revisions
task_workspace_execution_links
task_workspace_artifact_links
task_workspace_pending_interaction_links
task_workspace_runtime_command_proposals
task_workspace_replan_requests
task_workspace_personal_workflow_drafts
task_workspace_timeline_entries
task_workspace_runtime_cursors
task_workspace_idempotency_records
task_workspace_audit_events
```

明确不新增：

- Workspace 自建事件日志表；
- Timeline projection head 表；
- 通用 value record 表；
- 通用 blob record 表；
- Workspace mutation 转发表。

### JSON/TEXT 和附件

- Message body、Launch input、Draft source、compiled result、risk summary 和 proposal payload 直接存对应业务表 JSON/TEXT 列。
- 每份结构化内容保存 canonical hash。
- 大附件写 `data/task-workspace/attachments/`，表中保存 relative path、hash、MIME 和 size。
- Runtime Artifact 只保存 typed link，不复制 bytes。

### 跨库创建

不使用额外转发队列，流程为：

```text
commit durable LaunchIntent(status=creating)
  -> direct Host Runtime Gateway call with stable idempotency key
  -> commit ExecutionLink on success
```

Host startup、Session open 和手动 refresh 扫描 `creating`：

- 按 creation key 查询 Runtime；
- 已存在则 link；
- 不存在则 exact retry；
- intent hash 不同则 conflict。

LaunchIntent 自身就是恢复锚点。

### Runtime Timeline 一致性

只保留：

- `task_workspace_timeline_entries`；
- `task_workspace_runtime_cursors`。

Runtime entry unique key 使用 `workflow_id + runtime_event_seq`，或 Runtime contract 返回的等价 execution identity。cursor 更新和 Timeline entries 在同一 Workspace transaction 中提交。

### Retention

- Session archive 不删除 Runtime、Trace 或 Artifact。
- 第一版不提供 Session 物理 delete。
- 第一版不做跨库引用扫描和复杂 GC。
- Workspace attachment 只在未来明确删除协议中处理。
- Timeline Runtime entries可以 rebuild；消息和 Draft 不随 rebuild 删除。

## Gateway、API 与事件协议

### Runtime Workspace Gateway

`gateway/workspace.ts` 暴露 closed request/response，不暴露 Store：

```ts
interface RuntimeWorkspaceGateway {
  listRecipes(request: WorkspaceRecipeCatalogRequest): WorkspaceRecipeCatalog;
  createPublished(request: WorkspacePublishedCreationRequest): T0CreationReceipt;
  createTemporary(request: WorkspaceTemporaryCreationRequest): T0CreationReceipt;
  findCreation(request: WorkspaceCreationLookup): WorkspaceCreationResult;
  getRuntimeDetail(request: WorkspaceRuntimeDetailRequest): WorkspaceRuntimeDetail;
  listRuntimeEvents(request: WorkspaceRuntimeEventRequest): WorkspaceRuntimeEventPage;
  submitInteraction(request: WorkspaceInteractionRequest): RuntimeReceipt;
  submitCommand(request: WorkspaceRuntimeCommandRequest): RuntimeReceipt;
  applyTemporaryReplan(request: WorkspaceReplanRequest): RuntimeReceipt;
}
```

实际导出可以拆成函数，但边界必须同等封闭。

### Session API

```text
POST /api/task-workspace/sessions
GET  /api/task-workspace/sessions
GET  /api/task-workspace/sessions/:sessionId
POST /api/task-workspace/sessions/:sessionId/complete
POST /api/task-workspace/sessions/:sessionId/reopen
POST /api/task-workspace/sessions/:sessionId/archive

GET  /api/task-workspace/sessions/:sessionId/messages
POST /api/task-workspace/sessions/:sessionId/messages
POST /api/task-workspace/sessions/:sessionId/coordinator-turns/:turnId/retry
GET  /api/task-workspace/sessions/:sessionId/timeline
```

`POST messages` 的 action 必须是 closed `send | run`，不能让服务端根据文本猜测。

### Launch API

```text
GET  /api/task-workspace/recipes
PUT  /api/task-workspace/sessions/:sessionId/run-selection
POST /api/task-workspace/sessions/:sessionId/launch-intents
GET  /api/task-workspace/launch-intents/:launchIntentId
POST /api/task-workspace/launch-intents/:launchIntentId/revise
POST /api/task-workspace/launch-intents/:launchIntentId/confirm
POST /api/task-workspace/launch-intents/:launchIntentId/cancel
```

Published `Run` 不调用 `confirm`；该接口只用于 Temporary exact revision。

### Runtime 和 Interaction API

```text
GET  /api/task-workspace/sessions/:sessionId/runtime-detail
POST /api/task-workspace/interactions/:interactionId/submit
POST /api/task-workspace/sessions/:sessionId/runtime-command-proposals
POST /api/task-workspace/runtime-command-proposals/:proposalId/confirm
POST /api/task-workspace/sessions/:sessionId/replans
POST /api/task-workspace/replans/:replanId/confirm
POST /api/task-workspace/replans/:replanId/cancel
```

### Personal Workflow API

```text
POST /api/task-workspace/sessions/:sessionId/personal-workflow-drafts
GET  /api/personal-workflows
GET  /api/personal-workflows/drafts/:draftId
POST /api/personal-workflows/drafts/:draftId/revise
POST /api/personal-workflows/drafts/:draftId/validate
POST /api/personal-workflows/drafts/:draftId/dry-run
POST /api/personal-workflows/drafts/:draftId/review
POST /api/personal-workflows/drafts/:draftId/publish
POST /api/personal-workflows/releases/:releaseId/activate
POST /api/personal-workflows/releases/:releaseId/export
POST /api/personal-workflows/import
```

Export/import 可以延后实现，但 promotion to Git 必须走显式接口，不直接读取本地 DB 生成仓库文件。

### WebSocket

复用现有 `/ws`：

```ts
interface TaskWorkspaceTimelineDeltaV1 {
  type: 'task_workspace_timeline_delta';
  session_id: string;
  after_session_seq: number;
  entries: TaskTimelineEntryV1[];
  next_session_seq: number;
  source_state: 'ready' | 'catching_up' | 'degraded';
}
```

WebSocket 是低延迟提示；HTTP cursor query 是断线恢复路径。

### 统一约束

- Mutation 使用 authenticated local principal、idempotency key、expected row version 和 closed schema。
- Runtime actor/source 由 Host 根据已认证操作构造，不接受 Renderer 自报。
- Error 使用稳定 `code`、`target`、`retryable`、canonical receipt 和 freshness。
- 任意 Recipe ref、entrypoint、command type、SQL、filesystem path 或 Registry closure passthrough 都拒绝。

## 权限、安全与审计

### 本地信任模型

第一版产品下限是本地单用户：

- Human 操作记录为 `human`，不伪装为 `system`。
- Host service 操作记录为 `system`。
- 自动任务使用 `automation`。
- Feature 已有调用保持 `feature_service`。

不为 Coordinator 新增技术性能力隔离。安全和正确性主要依靠：

- Runtime Gateway closed schema；
- Runtime 自身 policy/permission/state guard；
- selection token；
- exact identity/hash；
- idempotency；
- receipt/event；
- UI 明确确认。

### 不可信内容

Conversation、Artifact、Trace、tool result 和 Runtime error 都可能包含 prompt injection。Coordinator 可以读取和解释，但这些内容不能改变：

- Recipe selection；
- actor/source；
- launch authorization；
- target lineage；
- Runtime policy；
- exact confirmation hash；
- Credential 提供方式。

Coordinator 具有广泛能力不代表 Agent 文本可以成为权威 Runtime 状态。

### 审计

至少记录：

- Session create/complete/reopen/archive；
- Human/Coordinator message、attachment 和 `query_id`；
- Workflow selection 和 token 解析结果；
- LaunchIntent、creation key 和 Runtime receipt；
- Temporary Draft revision、compile、risk 和 confirmation；
- Runtime command/Human Input result；
- Temporary Replan frontier、effect safety、diff、confirmation 和 lineage；
- Personal draft/review/publish/activation/export/import；
- permission denial、selection stale、conflict、interrupted turn、cursor degraded 和 integrity failure。

审计正文避免复制 secret 和大 Artifact bytes，优先保存 typed ref、hash 和 redacted summary。

## 前端布局与模块边界

### Desktop

```text
+------------------+--------------------------------+----------------------+
| Task Sessions    | Conversation Timeline          | Runtime Inspector    |
|                  |                                |                      |
| Active           | messages                       | Overview             |
| Waiting          | runtime progress               | DAG                  |
| Completed        | inline cards                   | Artifacts            |
| Archived         | artifacts/completion           | Pending              |
|                  |                                | Trace                |
| Search / Filter  | Selector + Input + Send / Run  |                      |
+------------------+--------------------------------+----------------------+
```

- 中栏是主工作面，Composer 固定在底部。
- Workflow selector 与 linked Workflow/Run selector 不是同一个控件。
- Inspector 可折叠，不覆盖 Composer。
- DAG、Artifact、Pending 详情在右栏切换，不嵌套页面卡片。
- 文本、按钮和 selector 在窄宽度下换行或截断，不改变工具栏高度。

### Renderer 接入

保留现有 build：

```text
electron/renderer/app.js
  -> imports electron/renderer/task-workspace/index.ts
  -> existing esbuild
  -> electron/renderer/dist/app.js
```

`app.js` 只增加导航和 `mount/unmount`。Task Workspace 源码保持拆分，但第一版不增加第二 entry/bundle，不引入 React、Vite 或新 dev server。

### 建议目录

```text
src/task-workspace/
  contracts/
    types.ts
    schemas/
  store/
    task-workspace-store.ts
    migrations/
  sessions/
    session-service.ts
    message-service.ts
    execution-link-service.ts
  coordinator/
    coordinator-service.ts
    context-builder.ts
  launch/
    launch-intent-service.ts
    temporary-draft-service.ts
  interactions/
    interaction-service.ts
  interventions/
    runtime-command-service.ts
    replan-service.ts
  personal-workflows/
    draft-service.ts
    extraction.ts
    publishing-service.ts
  timeline/
    runtime-event-consumer.ts
    timeline-service.ts
    rebuild.ts
  runtime-inspector/
    detail-service.ts
  api/

src/workflow-runtime/
  gateway/
    workspace.ts
  service/
    workflow-runtime-service.ts
    runtime-work-discovery.ts

electron/renderer/task-workspace/
  index.ts
  state.ts
  api-client.ts
  task-list/
  conversation/
  composer/
  interactions/
  runtime-inspector/
```

约束：

- Renderer 不 import Node DB 或 Runtime implementation。
- Task Workspace 不 import Runtime Store internals。
- Runtime 不 import Task Workspace。
- `workflow-runtime/service` 内部可以使用 Runtime Store 和事务函数，但只向 Host 暴露生命周期接口。
- Coordinator prompt、Workspace persistence 和 Runtime mutation contract 分离。

## 失败、恢复与降级

### Runtime service

- Host 启动：先执行 startup scan，再进入正常 wake/poll。
- 单项 CAS conflict：重新发现最新 row，不回滚其他已提交事务。
- retryable error：按 Runtime 现有 deadline/backoff 记录处理。
- 某一 phase 连续失败：记录 Host error，其他 bounded phase 仍可继续；integrity error 按 Runtime 规则 quarantine。
- stop：停止接收新 wake，等待当前 bounded transaction 返回，不中断已提交 Outbox work。

### Coordinator

- pending 未启动：自动恢复。
- running 结果未知：标记 interrupted，用户决定是否重试。
- Agent session 丢失：以持久化消息和 Runtime summary 创建新 session。
- Agent 声称 mutation 成功但无 receipt：只显示文本，不改变 Runtime UI 状态。

### selection stale

- 刷新 Catalog；
- 保留 Composer input；
- 清除失效 token；
- 不自动切换到其他 Recipe；
- 不自动改用 Temporary Workflow。

### Workflow 创建响应丢失

- 保持 LaunchIntent `creating`；
- 用 creation key 查询；
- 补 Link 或 exact replay；
- intent mismatch 显示 conflict，不创建第二个 Workflow。

### Temporary compile/confirmation

- Workspace compile 失败：保留 diagnostics，允许新 revision。
- 确认后 Runtime recompile hash 不一致：进入 `integrity_violation`，不 materialize child。
- 超出 outer envelope：返回 `unsupported_by_temporary_workflow`。
- 确认 revision 已 supersede：返回 expired/conflict，不迁移用户确认。

### Timeline

- Hub 通知丢失：poll/open/reconnect catch-up。
- cursor gap/hash mismatch：标记 degraded，从最后可信 cursor 重拉。
- rebuild：只替换 Runtime-derived entries。
- WebSocket 断线：HTTP after_session_seq 补拉。

### Human Input

- 相同 idempotency key：返回 canonical result。
- 另一个 Workspace surface 已处理：当前卡刷新为 disabled。
- expected row version 过期：显示 conflict，不自动套用 payload。

### Temporary Replan

- Compiler 失败：不 fence source Run。
- unknown effect 或 compensation 未完成：拒绝 apply。
- source fence 成功但 target response 丢失：按 replan creation key reconcile。
- 新 Run 未创建：不能把 source Run 标成成功完成。

### Personal publish

- validate/dry-run/review 失败：保留 draft，active Release 不变。
- publish 成功但 activate 失败：新 Release 保持 inactive。
- activation response 丢失：按 operation key 查询。
- 不完整 Release 不进入 selector。

### Feature disabled

- 新启动拒绝；
- 历史 Session 和 generic Runtime detail 只读；
- 不尝试加载 Feature 专用代码；
- 缺失资源显示 typed unavailable reason。

## 测试策略

### Runtime Service Test

- startup scan 可以推进已有 `ready_to_compile` build。
- wake coalescing 保证单循环。
- bounded batch 不饿死 Host event loop。
- fallback poll 能恢复丢失通知。
- compile -> materialize -> schedule -> result -> close 端到端。
- Worker result commit 会唤醒下一轮。
- stop/restart 不重复创建 Outbox work。

### Runtime Gateway Test

- `gateway-boundary` 只新增 `gateway/workspace`。
- Workspace 不能通过 connection 获取 Store。
- source/actor/launch_policy/authorization 组合校验。
- entrypoint 非 `default` 的 Recipe 能正确 compile、T0 和 replay。
- selection token principal/version/hash/expiry 校验。
- `selection_stale` 不创建 Workflow。

### Launch Test

- Core、Feature、Personal Recipe 都由明确 selection + `Run` 启动。
- `Send` 永不创建 LaunchIntent。
- Coordinator 文本永不直接启动 Published Recipe。
- 新 Session 默认 Temporary，且不继承其他 Session 的 Recipe。
- creation response loss 只创建一个 Workflow。
- ExecutionLink 四个 identity 必须同 lineage。

### Temporary Workflow Test

- 确认前 Runtime 没有任何 Intake/Workflow row。
- Draft revision immutable。
- T0 原子写 launch confirmation、Workflow 和 initial Run。
- root 使用 static Published pin。
- child 使用 `persistDynamicCompileResultT2a`。
- Runtime recompile 必须匹配 confirmed hash。
- 超出 envelope 返回 `unsupported_by_temporary_workflow`。
- UI 以 Child DAG 为主。

### Coordinator Test

- 每 TaskSession resume 同一个 Agent session。
- `query_id` 写入 message。
- Coordinator turn 串行。
- pending 自动恢复，unknown running 标记 interrupted。
- receipt 缺失时 Agent success 文本不改变 applied 状态。
- prompt injection 不能改变 selector、actor、target 或 confirmation hash。

### Timeline Test

- Message 与 Timeline Entry 原子提交。
- Runtime event duplicate 不重复 entry。
- Hub 通知、poll、open、reconnect 都能从 cursor 补齐。
- rebuild 保留消息 entries。
- WebSocket delta 与 HTTP `after_session_seq` 一致。

### Human Input 和 Inspector Test

- Timeline/Pending 两处状态一致。
- Runtime Center linked pending 只深链 Workspace。
- unlinked Runtime pending 保持现有处理。
- Overview、DAG、Artifacts、Pending、Trace 查询不越过 TaskSession link。
- 只有 generic Artifact renderer。

### Personal Workflow Test

- 从 Dynamic Child 提取，不包含 outer wrapper。
- sanitize 移除 instance-only/secret/path。
- publish/activate 失败不改变旧 active。
- Personal selector 只显示当前 principal active Release。
- launch 不调用 Planner、不二次确认 DAG。
- 本地数据不出现在 Git status。

### UI Test

- Desktop、narrow desktop 无遮挡、溢出和 composer 跳动。
- 长 Recipe 名、长 Task title、流式 Coordinator response 和大卡片。
- `Send`/`Run` 可清楚区分且键盘可访问。
- Task Workspace mount/unmount 不破坏现有 `app.js` 页面和 WebSocket。
- Feature disabled、Timeline degraded 和 Coordinator interrupted 状态可理解。

## 实施顺序

### W0：Runtime Readiness

- 实现并接入 `WorkflowRuntimeService`。
- 增加 `gateway/workspace.ts` 和 boundary test。
- 增加 `task_workspace` source。
- 修复 Recipe entrypoint 从 Publisher 到 Compiler/T0/Activation 的完整绑定。
- 在 T0 强制 source/actor/launch_policy/authorization。
- 增加 Recipe Catalog、Runtime Detail 和 Runtime event cursor query。
- 发布固定 `ad_hoc_personal_task` outer Recipe/Definition/root pin。

退出条件：Host 能从 T0 持续推进一个非 `default` entrypoint 的 Published Workflow 到 terminal，且无需测试代码手动调用 Runtime 事务函数。

### W1：Task Workspace Store 与 Session

- 实现 `task-workspace.db` migration。
- 实现 Session、Thread、Message、Attachment、CoordinatorTurn。
- 实现 Timeline Entry 和 Runtime Cursor。
- 实现 Task List、Session detail 和 message API。

退出条件：没有 Workflow 的 Session 可以 `Send`、恢复、完成和归档；Host 重启不丢消息和 Coordinator 状态。

### W2：Renderer Shell 与 Coordinator

- 新增 `electron/renderer/task-workspace/` 源码。
- 从现有 `app.js` import 并 mount/unmount。
- 实现三栏布局、Composer 和现有 WebSocket delta。
- 直接接入 `InternalAgentChatService` session resume 和 Trace `query_id`。

退出条件：普通 TaskSession 对话稳定工作，不增加第二 bundle 或新前端框架。

### W3：Published Workflow

- 实现 Recipe Catalog selector 和 session selection。
- 实现 `Send`/`Run` closed action。
- 接入 Published Core/Feature 启动。
- 实现 LaunchIntent recovery 和 ExecutionLink。
- 接入 task-scoped Runtime Detail。

退出条件：明确 selection + `Run` 能启动并追踪 Published Workflow；token stale 和 response loss 行为确定。

### W4：Temporary Workflow

- 实现 Draft/Revision/clarification/compile/confirmation。
- 扩展 T0 launch confirmation。
- 将 confirmed source 送入 outer controlled Expand。
- 接入 Dynamic Child compile/hash match/T2a。
- 实现 Child DAG 主视图。

退出条件：确认前 Runtime 零写入；确认后 static root + confirmed Dynamic Child 能运行到 terminal。

### W5：Timeline、Human Input 与控制

- 实现 `RuntimeEventHub` wake。
- 实现 Runtime cursor catch-up、低频 poll、rebuild。
- 通过现有 WebSocket 推送 delta。
- 实现 Timeline/Pending 共享卡片。
- 接入 Runtime command。
- 完成五面板 Inspector。

退出条件：通知丢失、断线和重启后 Timeline 可恢复；同一 Human Input 只有一个权威结果。

### W6：Temporary Replan

- 实现 frontier/effect safety/diff/confirmation。
- 复用 fixed outer + new Dynamic Child 创建新 Run。
- 实现 source fence、response-loss reconcile 和 lineage。

退出条件：成功 Replan 不修改旧 Plan，失败不会产生两个普通 running Run 竞争同一 claim。

### W7：Personal Workflow

- 增加 principal-owned Registry/Publisher/Activation Host 接入。
- 实现 extract/sanitize/validate/compile/dry-run/review。
- 发布 Personal Recipe + Graph Template。
- 实现 Personal selector 和 launch。
- 验证本地 ignore、export/import 边界。

退出条件：Personal Workflow 可复用启动，旧 Run/Release 不受更新影响，本地创建不进入 Git。

### W8：Hardening

- 完成 performance、accessibility、security、backup/restore 和 migration tests。
- 验证 Feature disable 和历史 generic display。
- 验证 Runtime Center 双向 typed navigation。
- 删除所有临时测试 ingress 和手动推进脚本依赖。

退出条件：Core、Feature、Personal、Temporary 四种路径都只通过 Task Workspace 和 Runtime Gateway 公共合同运行。

## 验收标准

### Runtime

- Host 启动一个 `WorkflowRuntimeService` 并能优雅停止。
- Runtime mutation/Execution result 后能快速推进，通知丢失后约 1 秒内由 fallback poll 恢复。
- 每一 phase 使用 bounded batch，没有独立 phase Worker。
- `ready_to_compile` 是唯一持久化编译队列。
- 非 `default` Recipe entrypoint 端到端正确。
- T0 强制 launch source、actor、policy 和 authorization。

### TaskSession

- Session 可在没有 Workflow 时创建和对话。
- 一个 Session 可关联多个 Workflow，不存在 Workflow 外的 task execution link。
- `Send` 只聊天，`Run` 才启动/规划 Workflow。
- 新 Session 默认 Temporary，不复用其他 Session 的 Published selection。
- complete/archive 不隐式控制 Runtime。

### Workflow Launch

- selector 只显示 active Core/Feature/Personal Recipe 和 `Temporary Workflow`。
- Renderer 不提交任意 Registry ref 或 entrypoint。
- Published selection + `Run` 不弹第二个 launch confirmation。
- selection stale 不静默切换 Recipe。
- exact replay 不产生第二个 Workflow。

### Temporary Workflow

- 用户确认前 Runtime 零写入。
- 用户确认 exact Draft revision/source/plan hash。
- Runtime 使用 Published static outer root 和 Dynamic Child。
- Runtime 重新编译 child 并匹配确认 hash。
- envelope 超限稳定失败，不扩大权限。
- 只有 Temporary Workflow 提供通用 Replan。

### Coordinator

- 直接复用现有 Agent 会话能力。
- 每个 TaskSession 一个 Agent session，同一时间一个 turn。
- pending/unknown-running restart 语义明确。
- message 保存 `query_id` 并可打开 Trace。
- Agent 文本不替代 Runtime receipt/event。

### Timeline、Human Input 和 Inspector

- Runtime commit 后快速通知，丢失通知可 cursor catch-up。
- 只有 Timeline Entry 和 Runtime Cursor 两类投影持久化。
- Runtime-derived entries 可独立 rebuild。
- Human Input 只在 Timeline 和 Inspector Pending 可操作。
- Inspector 只有 Overview、DAG、Artifacts、Pending、Trace。
- 只使用 generic Artifact renderer。

### Personal Workflow

- 保存成功 Temporary Run 时提取 Child DAG，不保存 wrapper。
- sanitize/validate/compile/dry-run/review/publish/activate 边界完整。
- launch 不运行 Planner，不要求逐次 Plan 确认。
- 新版本只影响后续 launch。
- 本地 Personal 数据默认不进入 Git。

### Feature 与 Runtime Center

- Feature Workflow 只从 Task Workspace selector 启动。
- 第一版没有 Feature 专用启动、renderer、任务预设或领域命令 UI。
- disabled Feature 的历史数据使用 generic readonly display。
- Runtime Center 保留全局诊断；linked pending 深链 Workspace。
- Runtime 和 Task Workspace 不互相 import implementation。

## 后续议题

以下事项不阻塞第一版：

1. Personal Workflow sharing、签名 export/import 和 promotion contract。
2. Published Workflow typed Rework entrypoint 的通用展示 schema。
3. TaskSession 多人协作、跨 Session secondary link 和 merge。
4. Session 物理删除、attachment GC、跨 Store retention/legal hold。
5. 多设备同步、远程访问和多用户 RBAC。
6. Feature 专业 Artifact renderer 或领域操作页的未来插件合同。
7. Runtime advance fallback poll 和 Timeline low-frequency poll 的最终配置值。
8. Coordinator turn 流式 partial message 的持久化与恢复体验。
