# Icarus 对话式任务工作台框架方案

> **状态**：方案讨论稿
> **实施前置**：[Dynamic Workflow Runtime](../../docs/dynamic-workflow-runtime.md) 已完整实现、验收并归档施工生命周期
> **范围**：Icarus Core Task Workspace、任务会话中控、临时 Workflow、运行干预、通用运行检查器与 Personal Workflow
> **项目边界**：本文中的 Production Activation、Gate、publish、activate、合同和审计只表示当前内部基线、本地启用、机器接口和排障记录。它们不构成产品交付要求；后续工作不需要复制 G0-G9 认证流程。详见 [`../../docs/internal-experimental-scope.md`](../../docs/internal-experimental-scope.md)。

## 导航

- [背景](#背景)
- [目标](#目标)
- [非目标](#非目标)
- [已确认架构决策](#已确认架构决策)
- [产品与系统边界](#产品与系统边界)
- [总体架构](#总体架构)
- [核心对象模型](#核心对象模型)
- [TaskSession 与 Conversation](#tasksession-与-conversation)
- [输入、意图与 Workflow 选择](#输入意图与-workflow-选择)
- [临时 Workflow](#临时-workflow)
- [Session Coordinator Agent](#session-coordinator-agent)
- [实时 Timeline](#实时-timeline)
- [Human Input 与审批卡片](#human-input-与审批卡片)
- [Runtime Inspector](#runtime-inspector)
- [运行控制与中途干预](#运行控制与中途干预)
- [Replan Protocol](#replan-protocol)
- [Personal Workflow](#personal-workflow)
- [与 Runtime Center 的关系](#与-runtime-center-的关系)
- [与 Feature Package 的关系](#与-feature-package-的关系)
- [持久化与一致性](#持久化与一致性)
- [API 与事件协议](#api-与事件协议)
- [权限、安全与审计](#权限安全与审计)
- [前端布局与交互](#前端布局与交互)
- [模块边界](#模块边界)
- [失败、恢复与降级](#失败恢复与降级)
- [测试策略](#测试策略)
- [实施顺序](#实施顺序)
- [验收标准](#验收标准)
- [后续议题](#后续议题)

## 背景

Dynamic Workflow Graph Runtime 解决 Workflow 的可信创建、编译、执行、等待、恢复、控制、Trace 和 Projection，但它不是以对话为中心的用户工作面。Runtime Center 提供跨 Feature 的运行索引、待处理、诊断和审计，也不负责承载一个用户任务从需求澄清、选择 Workflow、运行、干预到交付的完整上下文。

后续如果每个 Personalized Workflow 都要求 Feature Package 同时开发一套完整操作页面，会出现以下问题：

- 大量页面重复实现任务列表、进度、审批、产物、DAG、Trace 和运行控制。
- 没有专用 Feature 页面的 Core-owned、Personal 或临时 Workflow 缺少统一入口。
- 用户需要在聊天、工作台、Runtime Center 和 Feature 页面之间频繁切换。
- 自然语言任务在进入 Workflow 之前没有稳定的任务容器，Workflow 完成后也缺少继续追问和处理产物的会话上下文。
- 用户中途提出暂停、补充信息、增加步骤或调整剩余流程时，缺少统一、可审计的意图解释和干预协议。

因此新增 Core-owned **Task Workspace**。它以 `TaskSession` 为顶层产品对象，以对话 Timeline 为主要交互面，以受限 `Session Coordinator Agent` 连接 Task Intake、Recipe Routing、Workflow Runtime Command Gateway、Human Input、Artifact、Trace 和 Feature Business Command。

## 目标

- 提供类似 Codex App 的通用三栏任务操作界面：左侧任务、中间对话、右侧运行检查器。
- 一个 TaskSession 可以在 Workflow 创建前存在，并可关联零个或多个 Workflow、Run、独立 Agent execution 和产物。
- 输入框可以显式选择 Published Recipe，也可以使用 `Auto` 模式自动路由；没有匹配 Recipe 时生成受约束临时 Workflow。
- 在对话 Timeline 中实时展示可理解的执行进度、等待、审批、产物和完成结果。
- Human Input 和审批在聊天中以内联卡片处理，同时可在统一待处理视图中访问，二者引用同一权威请求。
- 用户可以通过自然语言或显式控件请求 pause、resume、cancel、补充输入、启动补充工作和调整剩余流程。
- 中控 Agent 只能通过 closed query/command/tool contract 操作，不直接写 Runtime Store、Feature Store 或 Registry。
- 保持已经 materialize 的 Scope Plan 不可变；运行中结构调整通过 child expansion、补充 Workflow 或 Replan 创建新 Run 表达。
- 临时 Workflow 完成后可以创建 Personal Workflow authoring draft，经 validate、compile、dry-run、review、publish、activate 后进入可复用 Catalog。
- 通用工作台覆盖大多数 Workflow 的默认 UI，Feature 只在确有领域交互需求时贡献专业页面或 renderer。
- Runtime Center、Task Workspace 和 Feature UI 共用 typed link、Runtime Command Gateway 和 Card Presentation，不复制执行事实或授权逻辑。

## 非目标

- 不把 Task Workspace 变成新的 Workflow Runtime、Scheduler 或状态机执行器。
- 不让 Session Coordinator Agent 成为可以浏览和任意拼装全局 Definition、Capability、Policy、Tool 或权限的超级 Agent。
- 不允许聊天消息直接修改 Workflow Runtime 表、Projection、Feature domain data 或 active Registry pointer。
- 不修改已经 materialize 的 Scope Plan、Node、Edge、sealed input snapshot 或 terminal fact。
- 不保证所有 Published Workflow 都支持任意 Replan；Workflow 必须通过明确 policy 和 rework/replan entrypoint opt in。
- 不把 Runtime Center 的全局运维、Capacity 管理、Projection rebuild 和完整审计功能全部复制进任务对话。
- 不用通用界面取代所有 Feature 页面；复杂领域表单、数据编辑、对比和运营仪表盘仍可由 Feature 提供。
- 不把现有 channel/group chat 的 `chat_jid` 直接复用为 TaskSession identity。
- 不在 Dynamic Workflow Runtime Production Activation 前实现或启用本文产品 surface。

## 已确认架构决策

### 1. TaskSession 是顶层产品对象

TaskSession 不是 Workflow 的别名。一个任务可以先经历需求澄清，再创建 Workflow；也可能发生 Replan、补充 Workflow、独立 Agent 查询或交付后的追问。因此关系固定为：

```text
TaskSession
  -> Conversation
  -> Workflow 0..N
  -> Standalone Agent Execution 0..N
  -> Artifact Link 0..N
  -> Pending Interaction 0..N
```

Workflow 仍由 Runtime Store 持有，Task Workspace 只保存 typed link 和可重建摘要。

### 2. 产品入口合并，领域事实分离

Task Workspace 在一个页面中组合对话、运行进度、审批、DAG、产物和 Trace，但它不合并这些领域的数据库或服务：

- Task Workspace Store：TaskSession、消息、launch intent、execution link、workspace event 和本地 projection。
- Workflow Runtime Store：Workflow、Run、Node、Wait、Command、Artifact provenance 和执行事件。
- Trace Store：Agent、Tool、Effect 和跨 surface correlation。
- Feature Store：领域 projection、配置和业务数据。

### 3. Session Coordinator 是受限控制 Agent

Session Coordinator 负责解释、建议和编排入口，不拥有底层写权限。它的任何状态改变都必须转成 exact Task Intake、Runtime Command、Wait Signal、Business Command、Authoring Command 或 Personal Workflow Publish 请求。

### 4. Runtime 事实不能被聊天文本替代

“已暂停”“已批准”“节点完成”等状态只能来自权威 receipt/event 的 Projection。Agent 可以生成解释性摘要，但摘要不是命令结果、审批事实、Artifact provenance 或恢复依据。

### 5. Auto 不是无界自动拼装

`Auto` 先在 pinned Routing Scope 中选择 exact Published Recipe。只有返回 `no_route_available` 或确定需要临时流程时，才进入 Core-owned Ad Hoc Recipe；Ad Hoc Planner 仍受固定 capability allowlist、policy envelope、schema、预算和 effect ceiling 约束。

### 6. 临时 Plan 创建后同样不可变

临时 Workflow 的 authoring draft 可以产生多个 immutable revision。用户确认的是某个 exact draft revision/hash；一旦该 revision 创建 Run，其 Compiled Plan 与普通 Published Workflow 一样不可修改。

### 7. 中途改流使用 Replan，不 patch DAG

一般结构调整必须先冻结当前执行前沿，处理 running work 和 effect safety，再创建新的 State Activation/Graph Run。旧 Run、旧 Plan 和旧结果继续保留，使用显式 supersession lineage 关联。

### 8. Personal Workflow 是 Core Catalog，不要求 Feature UI

用户持久化的 Workflow 属于 Personal Workflow Catalog。它可以复用 Registry、Compiler、Authoring 和 Publisher 协议，但产品上不要求创建 Feature Package、导航或专用 renderer。

### 9. 一个 Human Interaction 只有一个事实源

聊天内联卡、右侧待处理、Runtime Center Pending 和外部渠道卡片可以同时呈现同一请求，但不得各自维护审批状态。所有 submission 使用同一 request identity、expected row version 和 idempotency key。

## 产品与系统边界

### Web Task Workspace

用户主动打开和操作的默认工作面：

- 创建、继续、搜索和归档 TaskSession。
- 选择 Workflow 或使用 Auto。
- 输入任务、澄清、补充材料和后续指令。
- 查看进度、审批、产物和运行状态。
- 发起受控运行命令和 Replan。
- 将临时 Workflow 保存为 Personal Workflow draft。

### Runtime Center

跨 TaskSession、Feature、Workflow 和独立 Agent execution 的全局控制面：

- 全局 Workflow/Run/Agent execution 索引。
- 全局 pending、diagnostic、quarantine、remediation 和 audit。
- Capacity Admin 和 Projection rebuild。
- 不以 Conversation 为主要交互模型。

### Feature Page

领域操作面：

- 复杂输入、数据编辑、报表和专业工作流。
- typed Business Command。
- Artifact 专业 renderer。
- 领域 Projection 和配置。

### Personal Assistant

主动感知和提醒层：

- 可以通过 typed link 打开 TaskSession、Pending Interaction 或 Runtime Center target。
- 可以在 policy 允许时创建调查建议或 TaskSession draft。
- 不替代 Task Workspace 的用户驱动中控，也不自动取得 Workflow 控制权限。

## 总体架构

```text
Web / Electron Core Shell
  |
  +-- Task Workspace Renderer
  |     - Task List
  |     - Conversation Timeline
  |     - Composer / Recipe Selector
  |     - Human Input Card Surface
  |     - Runtime Inspector Host
  |
  +-- Runtime Center Renderer
  +-- Feature Renderer Host
          |
          v
Task Workspace API / Event Stream
  |
  +-- Session Service -----------> task-workspace.db
  +-- Coordinator Gateway -------> Standalone Agent Runtime / Trace
  +-- Task Intake Client --------> Workflow Creation API
  +-- Runtime Query Client ------> Runtime Center Projection API
  +-- Runtime Command Client ----> Workflow Runtime Command Gateway
  +-- Card Action Client --------> Wait / Business / Runtime ingress
  +-- Authoring Client ----------> validate / compile / dry-run / review
  +-- Feature Host Client -------> Feature Query / Business Command
```

依赖方向固定为：

```text
task-workspace/contracts
  <- store/session/conversation
  <- coordinator/launch/intervention/personal-workflow
  <- projection/api
  <- renderer

workflow-runtime public clients -> task-workspace adapters
feature-host public clients      -> task-workspace adapters
trace public clients             -> task-workspace adapters
```

Workflow Runtime、Feature Runtime 和 Trace Store 不 import Task Workspace implementation。Runtime 最多发布通用 event/export/query/command contract；Task Workspace 是消费者。

## 核心对象模型

```text
TaskSession
  -> ConversationThread
      -> ConversationMessage
  -> LaunchIntent
      -> Routing Attempt / AdHoc Draft Revision
      -> ExecutionLink
  -> WorkspaceEvent
      -> Timeline Projection
  -> PendingInteractionLink
  -> ArtifactLink
  -> InterventionRequest
      -> Runtime Command Receipt
      -> ReplanRequest
  -> PersonalWorkflowDraft
```

核心不变量：

1. TaskSession identity 与 chat JID、Workflow ID、Run ID、Feature ID 相互独立。
2. TaskSession 可以没有 Workflow；同一 Workflow 第一版最多属于一个 primary TaskSession，但可以被其他 surface 以 typed link 引用。
3. ConversationMessage、LaunchIntent、Draft Revision、ExecutionLink、InterventionRequest 和 WorkspaceEvent 创建后不可原地改写语义内容；可通过新 revision/event 纠正。
4. Runtime status、command result、wait resolution 和 artifact provenance 不复制为 Task Workspace 权威字段。
5. 每个跨库 mutation 使用稳定 causation/idempotency identity；response loss 后只能 exact replay 或 reconcile，不能猜测未发生。
6. Timeline 是多来源 Projection。删除或重建 Timeline 不得删除消息、Runtime event、Trace、Artifact 或 Card request 的权威记录。
7. Session Coordinator 输出只作为消息、提案或 command request；没有 receipt 不得显示为 applied。
8. 用户自然语言不能绕过 explicit confirmation、permission、policy、state guard、expected row version 或 effect safety。
9. 临时 Workflow Run 固定 exact draft/compiled plan hash；Personal Workflow 发布不能反向改变该 Run。
10. Replan 不修改旧 Run。新 Run 启动前必须满足旧 Run 的 fence、effect reconciliation 和 policy guard。

## TaskSession 与 Conversation

### TaskSession

```ts
type TaskSessionStatus = 'open' | 'completed' | 'cancelled' | 'archived';
type TaskAttentionState =
  | 'none'
  | 'waiting_user'
  | 'action_required'
  | 'failed';

interface TaskSessionV1 {
  format: 'icarus.task-session/1';
  session_id: string;
  owner_principal_ref: string;
  title: string;
  status: TaskSessionStatus;
  attention_state: TaskAttentionState;
  primary_thread_id: string;
  default_launch_mode: 'auto' | 'explicit_recipe';
  default_recipe_ref: VersionedRef | null;
  source:
    | 'task_workspace'
    | 'personal_assistant'
    | 'feature_deep_link'
    | 'runtime_deep_link'
    | 'api';
  created_at_ms: number;
  updated_at_ms: number;
  row_version: number;
}
```

`attention_state` 是从当前 linked executions、pending interactions 和 operational blockers 计算的可重建摘要，不替代各来源状态。Session `completed` 只表示用户认为任务已结束；它不能结束、取消或修改任何仍在运行的 Workflow。完成 Session 时如果仍有 active execution，UI 必须要求用户分别选择保持后台运行、提交 cancel 或返回 Session。

### ConversationThread

第一版一个 TaskSession 只有一个 primary thread。Thread 分支、多人协作和跨任务 merge 不在第一版范围。

```ts
interface TaskConversationThreadV1 {
  format: 'icarus.task-conversation-thread/1';
  thread_id: string;
  session_id: string;
  status: 'active' | 'closed';
  next_message_seq: number;
  created_at_ms: number;
  row_version: number;
}
```

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
  content_ref: string;
  content_hash: string;
  attachment_manifest_ref: string | null;
  attachment_manifest_hash: string | null;
  reply_to_message_id: string | null;
  causation_ref: string | null;
  coordinator_execution_id: string | null;
  created_at_ms: number;
}
```

消息正文和附件按 sensitivity、size、retention 与 access policy 存储。Runtime event 不伪装成 `system` message；它进入 Timeline Projection，并保留 source event identity。

### ExecutionLink

```ts
type TaskExecutionLinkV1 =
  | {
      kind: 'workflow';
      workflow_id: string;
      intake_id: string;
      creation_request_id: string;
      launch_intent_id: string;
    }
  | {
      kind: 'standalone_agent';
      conversation_id: string;
      message_id: string;
      agent_execution_id: string;
      coordinator_execution_id: string | null;
    };
```

Link 保存完整 typed identity，不使用开放 `kind + opaque target_ref` 写内部关系。跨数据库无法建立 FK 时，必须保存 target kind、完整 lineage、last verified hash/version 和 verification status，并通过 query API 周期校验。

## 输入、意图与 Workflow 选择

### Composer 模式

输入框顶部使用稳定 selector：

- `Auto`：默认；先走 pinned Routing Scope。
- 明确 Recipe：用户选择 exact Published Recipe 的产品标签，客户端提交 server-issued selection token，不提交任意 ref。
- `Temporary Workflow`：用户显式要求从任务生成临时 DAG。

不向普通用户展示 Definition、Policy、Capability、Executor 或 Registry closure 的自由组合器。

### 消息意图

Session Coordinator 对每条 human message 产生 closed `WorkspaceIntentProposal`：

```ts
type WorkspaceIntentKind =
  | 'conversation_query'
  | 'task_launch'
  | 'human_input_submission'
  | 'runtime_control'
  | 'business_action'
  | 'workflow_intervention'
  | 'artifact_followup';
```

- `conversation_query`：解释状态、回答如何操作、总结结果，不创建新 Workflow。
- `task_launch`：创建 LaunchIntent，走 Recipe Routing 或临时 Workflow。
- `human_input_submission`：必须绑定 pending request/card identity，不能只凭文本猜测目标。
- `runtime_control`：生成 typed Runtime Command proposal。
- `business_action`：生成 Feature/Core published Business Command proposal。
- `workflow_intervention`：创建 InterventionRequest，不直接 patch Run。
- `artifact_followup`：可以启动补充 Workflow、打开 renderer 或进行只读解释。

当一个消息可能对应多个 active target，Coordinator 必须要求用户选择；不能使用“最近 Workflow”静默执行有状态操作。

### LaunchIntent

```ts
interface TaskLaunchIntentV1 {
  format: 'icarus.task-launch-intent/1';
  launch_intent_id: string;
  session_id: string;
  source_message_id: string;
  mode: 'auto' | 'explicit_recipe' | 'temporary_workflow';
  selected_recipe_ref: VersionedRef | null;
  routing_scope_ref: VersionedRef;
  effective_input_ref: string;
  effective_input_hash: string;
  attachment_manifest_ref: string;
  attachment_manifest_hash: string;
  status:
    | 'routing'
    | 'needs_clarification'
    | 'drafting'
    | 'awaiting_confirmation'
    | 'creating'
    | 'linked'
    | 'unsupported'
    | 'failed'
    | 'cancelled';
  idempotency_key: string;
  row_version: number;
}
```

Workflow creation key 至少绑定 `session_id + launch_intent_id + effective_input_hash + selected recipe/draft hash`。创建响应丢失时按 creation key 查询 Task Intake/Creation Request，并补建 ExecutionLink。

### Auto Routing

```text
Human message
  -> immutable effective input revision
  -> pinned Routing Scope
  -> explicit task kind / deterministic route
  -> bounded Macro Router fallback
  -> exact Recipe or no_route_available
```

Router 只能选择 scope 中的 Recipe。用户显式 Recipe 优先，且不能被模型改写。`needs_clarification` 以内联 Human Input 卡展示，提交后创建新的 immutable input revision，再发起新的 routing attempt。

## 临时 Workflow

### 定位

临时 Workflow 用于没有匹配 Published Recipe、但任务需要多步骤执行、并行、等待、Artifact 或用户审查的场景。它不是未注册 source 的直接执行，也不是权限扩张机制。

平台发布一个 Core-owned `ad_hoc_personal_task` Recipe，至少固定：

- 外层 Definition 和 entrypoint。
- Ad Hoc Planner Capability。
- 允许使用的 Capability/Template/Wait/Artifact Contract catalog closure。
- Execution Policy、Command Policy、Context Contract 和 safety ceiling。
- 最大 Node、Edge、Scope、Map item、Attempt、duration、token、artifact bytes 和 effect impact。
- 默认 review、replan 和 terminal behavior。

### Draft 状态机

```text
drafting
  -> validating
  -> validation_failed | awaiting_confirmation
  -> superseded | creating
  -> launched | failed | discarded
```

每次用户修改产生新的 immutable `AdHocWorkflowDraftRevision`：

```ts
interface AdHocWorkflowDraftRevisionV1 {
  format: 'icarus.ad-hoc-workflow-draft-revision/1';
  revision_id: string;
  draft_id: string;
  revision_no: number;
  parent_revision_id: string | null;
  source_message_id: string;
  scope_spec_ref: string;
  scope_spec_hash: string;
  compiled_plan_ref: string;
  compiled_plan_hash: string;
  compiler_proof_ref: string;
  compiler_proof_hash: string;
  policy_snapshot_ref: string;
  policy_snapshot_hash: string;
  risk_summary_ref: string;
  risk_summary_hash: string;
  created_at_ms: number;
}
```

Compiler、Schema、Capability binding、permission/effect closure 和 safety check 必须与普通 Workflow 使用同一正式实现。Draft 只写 Task Workspace/authoring staging root，不能进入 active Registry。

### 确认卡

确认卡至少展示：

- 任务目标和预期交付物。
- 主要步骤、并行分支、等待点和完成条件。
- 可能调用的外部系统和 effect impact。
- 权限、凭证、mount、network 和资源预算摘要。
- 需要人工确认的节点。
- exact draft revision/hash 和过期时间。

用户可以：

- `Run`：确认 exact revision。
- `Revise`：通过新消息生成下一 revision。
- `Discard`：终止 draft。

确认后输入变化、policy/capability closure 变化或 revision 过期都必须重新 compile/review，不能继续使用旧确认。

### 执行

运行时创建真实 Task Intake、Workflow Instance、Activation、Run 和 immutable root Scope Plan。Temporary 只描述 launch provenance，不降低 Runtime contract，也不允许使用 test-only Registry 或 production-unknown resource。

## Session Coordinator Agent

### 生命周期

Session Coordinator 是每次消息或显式操作触发的逻辑 Agent，不要求维持不可恢复的常驻模型进程。Conversation、proposal、tool invocation 和 execution receipt 持久化；模型执行可以失败、重试或由另一个 worker 恢复。

Coordinator execution 使用通用 Trace：

```text
root_kind = standalone_agent_execution
conversation_id = TaskSession thread id
message_id = triggering message id
agent_execution_id = coordinator execution id
workflow correlation = null unless querying a verified linked target
```

当 Coordinator 作为 Workflow Planner Node 执行时，它属于对应 Workflow Attempt，不伪造 standalone root。

### 允许工具

第一版 closed tool catalog：

- `workspace.session.read`
- `workspace.timeline.query`
- `workspace.execution.list`
- `runtime.projection.query`
- `runtime.trace.query`
- `runtime.artifact.query`
- `recipe.catalog.list_allowed`
- `workflow.intake.prepare`
- `workflow.adhoc.draft`
- `workflow.command.propose`
- `workflow.business_command.propose`
- `workflow.human_input.prepare_submission`
- `workflow.intervention.propose`
- `personal_workflow.authoring.prepare`

写操作工具只创建 proposal 或调用受认证 Gateway。工具输入使用 closed schema、target lineage、expected row version 和 server-derived actor；禁止任意 SQL、任意 Registry ref、任意 filesystem path、任意 command type 或客户端自报权限。

### 介入原则

- 查询和解释可以直接执行。
- 无副作用的明确操作可以按 published policy 提交。
- pause/resume/cancel、skip、business action、Replan 和 publish 根据 risk/policy 显示显式 proposal/confirmation。
- Coordinator 不能替用户批准自己的临时 Plan、Personal Workflow publish、Administrative Abandon 或高风险 effect。
- 用户撤销消息不撤销已经提交的外部 effect；必须创建新的 command/intervention。

### 状态解释

Coordinator 可以把多个底层事件合并成自然语言摘要，但必须附带 source refs 和 freshness。Projection degraded、target row version 变化或 link integrity 失败时，必须说明无法确认当前状态，并禁用状态改变建议。

## 实时 Timeline

### Entry 类型

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
  | 'trace_summary'
  | 'intervention_status'
  | 'workflow_completed'
  | 'system_notice';
```

每个 entry 保存：

- `session_seq`：TaskSession 内稳定递增序号。
- source kind 和完整 typed locator。
- source event seq/row version/hash。
- projected timestamp 和 freshness。
- renderer kind/version。
- sensitivity 和 visibility policy。

### 投影原则

- Human/Coordinator message 来自 Task Workspace authoritative message rows。
- Workflow progress、command、wait 和 artifact 来自 Runtime event/outbox/projection。
- Trace summary 来自 Trace query，不复制完整 span。
- Feature business event 只能通过 Feature 发布的 typed projection event 进入。
- 相同 source identity 重投不产生重复 Timeline entry。
- 发现 source seq gap、hash mismatch 或 lineage mismatch 时标记 Timeline source degraded，并触发 rebuild/reconcile。

### 展示粒度

聊天流默认展示面向任务的阶段事件，不把每个 edge resolution、lease renewal 或 tool token 写成消息。高频事件按稳定规则折叠：

- 同一 Node 的连续 progress 合并为一个可展开 entry。
- Attempt、retry、quality revision 保留独立重要状态。
- Tool 调用默认只显示摘要，完整信息在 Trace。
- Artifact、wait、command result 和 terminal outcome 永不被折叠丢失。

折叠只影响 Projection，不能修改 source history。

### 实时传输

使用 WebSocket 或 SSE 发送 typed delta：

```ts
interface TaskTimelineDeltaV1 {
  format: 'icarus.task-timeline-delta/1';
  session_id: string;
  after_session_seq: number;
  entries: TaskTimelineEntryV1[];
  next_session_seq: number;
  projection_state: 'ready' | 'rebuilding' | 'degraded';
}
```

客户端断线后按 `after_session_seq` 补拉。服务端不依赖连接状态判断事件是否已处理。

## Human Input 与审批卡片

### 统一呈现

以下来源统一映射到 Card Presentation：

- Workflow wait `signal | approval`。
- Task Intake clarification/launch confirmation。
- Ad Hoc Plan confirmation。
- Runtime Command confirmation。
- typed Business Command review。
- Replan diff confirmation。
- Personal Workflow authoring/publish review。

卡片可以同时出现在：

- Conversation Timeline inline surface。
- Runtime Inspector `Pending`。
- Runtime Center `Pending`。
- 支持的移动/外部渠道。

### 提交合同

```ts
interface TaskInteractionSubmissionV1 {
  format: 'icarus.task-interaction-submission/1';
  interaction_id: string;
  rendered_snapshot_ref: string;
  rendered_snapshot_hash: string;
  action_id: string;
  payload_ref: string;
  payload_hash: string;
  expected_target_row_version: number;
  idempotency_key: string;
}
```

Workspace ingress 只做 session/link/snapshot 基础校验，再分派到权威 Wait、Business Command、Runtime Command、Authoring 或 Workspace domain handler。最终 accepted/conflict/expired/denied 由目标 Gateway 决定。

处理完成后原卡保留为审计展示，进入 disabled 状态并显示 canonical result。另一个 surface 已处理时，当前页面收到状态更新，不重复提交。

## Runtime Inspector

Task Workspace 右侧提供 task-scoped Runtime Inspector。它不是第二个 Runtime Center Store，也不直接读取 Runtime DB。

### 一级面板

1. `Overview`：linked executions、当前状态、预算、deadline、pending 和最近错误。
2. `DAG`：State Activation、scope tree、Node/Edge、Attempt、Wait、completion cut。
3. `Artifacts`：TaskSession attachments、Workflow artifacts、Agent outputs 和 Feature deliverables。
4. `Pending`：当前 TaskSession 关联的等待、审批、action-required 和 remediation。
5. `Trace`：当前 Session/Workflow/Run/Node/Attempt 的 Trace 摘要与深链。
6. `Context`：用户显式提供的 context revision、attachment 和被采用的 input snapshot；不暴露秘密值。

### DAG

- 默认展示当前 primary Workflow/current Run。
- Replan 前后 Run 使用 lineage switcher 切换，不把多个 Plan 合并成一张伪 DAG。
- Scope Plan、Node、Edge 和 sealed input 只读。
- 可用 command 来自 server-computed hint；按钮点击仍由 Gateway 重验。
- Projection degraded 时显示最后可信 snapshot，禁用依赖 freshness 的操作。

### Artifact

- Generic renderer 支持 text、markdown、image、audio、video、table、JSON、diff、archive metadata 和 download。
- Feature artifact renderer 由 Shell 根据 exact renderer ref/hash 和 typed subject link 加载。
- Runtime Inspector 不 import Feature implementation；Feature disabled 时回退到 generic metadata/readonly renderer。
- Artifact bytes 按原 Store 和权限读取，Task Workspace 只保存 link、display metadata 和用户 pin/order。

### 可复用边界

Task Workspace 与 Runtime Center 可以共用 design system、typed API clients 和独立 `runtime-inspector` renderer package。二者不能 import 对方的 page store，也不能让 Runtime Center renderer import Feature page implementation。

## 运行控制与中途干预

用户在聊天中输入信息后，系统必须先归类，再决定是否影响运行。

| 意图 | 协议 | 是否改变现有 Plan |
| --- | --- | --- |
| 查询进度、解释失败 | Projection/Trace query | 否 |
| pause/resume/cancel/skip/retry advance | Runtime Command | 否 |
| 回答问题、审批、选择 | Wait Signal / Card Action | 否 |
| 补充一个独立任务 | 新 Workflow 或 child Workflow | 否 |
| 使用已有 expansion point 增加工作 | `expand` child scope | 否，append child scope |
| 改变剩余步骤或交付物 | Replan | 旧 Plan 不变，创建新 Run |
| 修改已完成外部 effect | 新补偿/修复 Workflow 或 remediation | 否 |

### 补充信息

普通消息不会进入已经 sealed 的 Node input。它可以：

- 作为尚未 resolve 的 Wait payload。
- 创建 Workflow Context amendment，供下一 Activation/Replan 使用。
- 启动补充 Workflow。
- 仅作为 Conversation context，不影响当前执行。

Coordinator 必须明确告诉用户信息将影响哪个 target。不能把 live Conversation 隐式暴露给所有 running Node。

### Pause 的限制

Pause 只建立 scheduling barrier；已经 dispatch 的 external work 可能继续完成。需要改变其输入或阻止副作用时，系统必须等待结果、执行 cancel capability、fence/reconcile effect，或明确告知无法安全 Replan。

### 补充 Workflow

当用户需求是“在原任务旁增加一项工作”，优先创建 linked child/sibling Workflow，而不是修改当前 DAG。TaskSession 把多个 execution 统一展示；Runtime lineage 只在真实 parent/child creation contract 存在时建立，UI 不能伪造 child Workflow 关系。

## Replan Protocol

### 适用条件

Replan 只允许：

- 当前 Recipe/Definition 发布了允许 Replan 的 policy 和 entrypoint；或
- 当前任务使用 Core Ad Hoc Definition，其内置受限 Replan path 可用。

静态、不可重规划、含不可验证 irreversible effect 或处于 integrity quarantine 的 Workflow 可以拒绝 Replan。拒绝必须返回稳定 reason code，并建议创建补充 Workflow、等待当前 Run 或执行人工 remediation。

### ReplanRequest

```ts
interface WorkflowReplanRequestV1 {
  format: 'icarus.workflow-replan-request/1';
  replan_request_id: string;
  session_id: string;
  workflow_id: string;
  source_run_id: string;
  source_message_id: string;
  expected_workflow_row_version: number;
  expected_run_row_version: number;
  requested_change_ref: string;
  requested_change_hash: string;
  evidence_manifest_ref: string;
  policy_ref: VersionedRef;
  status:
    | 'proposed'
    | 'awaiting_confirmation'
    | 'pausing'
    | 'draining'
    | 'drafting'
    | 'validation_failed'
    | 'ready'
    | 'applying'
    | 'applied'
    | 'rejected'
    | 'failed'
    | 'cancelled';
  row_version: number;
}
```

### 协议

```text
User request
  -> create immutable ReplanRequest
  -> authorization / policy / state guard
  -> pause source Run if needed
  -> freeze execution frontier
  -> wait/cancel active Attempts
  -> reconcile effects and required compensation
  -> build Replan Input Snapshot
  -> generate + compile candidate Plan
  -> show structure/effect/artifact diff
  -> Human confirmation
  -> fence/supersede source Run through published rework protocol
  -> create new Activation/Run
  -> link source/target lineage
  -> resume Timeline projection
```

### Replan Input Snapshot

只允许包含：

- 原始 Task Intake 和 effective input refs。
- 已完成 Node 的 published logical outputs。
- Artifact manifest refs。
- 当前 Workflow Context revision。
- 用户此次 requested change。
- 已确认 effect receipts、external resource after-snapshot 和 unresolved blocker summary。
- Source Run completion/frontier manifest。

不读取 Node 临时工作目录、未发布 candidate output、live Conversation 全文、latest Registry 或其他 Workflow 私有状态。

### 应用边界

- 新 Activation/Run 只能在 source work 被安全 fencing 后开始普通 claim。
- Source Run 不生成虚假 normal Completion Cut；使用正式 cancel/superseded/rework outcome。
- 已发生 effect 不会因为 Replan 消失。新 Plan 必须接收 receipt/after-snapshot，并避免重复 operation。
- Replan 创建新 plan hash、run id、attempt lineage 和 budget account；Workflow lifetime ceiling 继续累计，不能重置。
- Replan 失败时 source Run 保持 paused 或恢复到 policy 允许的状态，不能处于未知“半换图”状态。
- Crash/retry 使用同一 replan request id、draft hash、command id 和 creation key 对账。

## Personal Workflow

### 定位

Personal Workflow 是用户从成功的临时 Workflow、手工 authoring draft 或已有 Personal Workflow revision 创建的可复用 Recipe。它不要求 Feature nav、Feature API 或领域 renderer，但仍使用正式 Registry、Compiler、Publisher 和 Runtime。

### 保存不是直接发布

Workflow 完成后的提示操作固定为：

- `Save as draft`：创建 Personal Workflow authoring draft。
- `Not now`：保留本次 Run，不创建可执行 Catalog entry。
- `Never suggest for this session`：仅保存 Session preference，不修改全局 policy。

保存流程：

```text
Selected successful Run
  -> extract reusable structure
  -> remove instance-only values and secrets
  -> infer explicit input schema
  -> bind allowed exact resources
  -> validate / compile / dry-run
  -> show source/plan/permission/effect diff
  -> Human review
  -> publish immutable resources
  -> activate Personal Catalog version
```

系统不得把 Runtime Compiled Plan bytes直接登记为可编辑 source，也不得把本次输入、Credential、绝对临时路径、effect receipt、private attachment 或 transient Artifact 当作模板默认值。

### 主要对象

```text
PersonalWorkflowCollection
  -> PersonalWorkflowDraft
      -> Draft Revision
      -> Validation / Compile / Dry-run Result
      -> Review Request
  -> PersonalWorkflowRelease
      -> Recipe / Definition / Policy / Schema / Resource closure
      -> Activation audit
```

Personal Workflow 的 Registry owner、namespace、sharing 和 export/import 合同在实施前单独冻结。第一版默认只有 `human:local-owner` 可见和启动，不提供跨用户共享或远程市场。

### 更新

修改已发布 Personal Workflow 必须产生新 version/release。旧 Workflow Run 固定旧 snapshot；新版本激活只影响后续 Task Intake。用户可以回滚 active pointer，但不能删除仍被 Run、Artifact、review 或 retention handle 引用的版本。

## 与 Runtime Center 的关系

### Runtime Center 保留的能力

- 全局 Workflow、Agent Execution、Pending 和 Trace 列表。
- 跨 TaskSession 查询和筛选。
- Operational Blocker、effect remediation、integrity restore 和 administrative abandon。
- Capacity 管理、Projection rebuild 和系统诊断。
- 完整 command invocation、permission denial 和 audit history。

### Task Workspace 提供的能力

- 某个用户任务的 Conversation 和 causation history。
- 从任务输入到 Workflow 创建的连续体验。
- 当前任务的运行摘要、卡片、Artifact 和常用控制。
- Ad Hoc draft、Replan 和 Personal Workflow 保存入口。

### 双向导航

- Task Workspace -> Runtime Center：Workflow/Run/Node/Attempt/Trace typed link。
- Runtime Center -> Task Workspace：如果存在 verified primary ExecutionLink，则返回 TaskSession link；没有 link 时不创建伪 Session。
- Runtime Center 全局 pending 可以深链到 TaskSession inline card。
- Projection retention 后只保留 metadata 时，两侧显示一致的 typed unavailable reason。

## 与 Feature Package 的关系

Task Workspace 是 Core surface，不属于任何 Feature，也不随 Feature disable 而消失。

Feature 可以贡献：

- Published Recipe 和 routing scope。
- Card Presentation、Wait Contract 和 typed Business Command。
- Artifact Contract 与 renderer bundle。
- task creation preset 和 Feature deep link。
- task-scoped read-only domain summary provider。

Feature 不可以：

- 注册自己的 Session Coordinator、Task Workspace Store writer 或 Timeline Scheduler。
- 直接写 TaskSession、Runtime 或其他 Feature 数据。
- 注入任意 HTML/script、开放 command 或未版本化 renderer。
- 覆盖 Core Auto Routing、permission、risk 或 Human Review policy。
- 在 Feature disabled/draining 后继续创建新 Workflow。

Feature 页面已经收集完整 structured input 时，可以创建一个 TaskSession 并附带 explicit Recipe LaunchIntent；也可以直接创建 Workflow，再通过可信 causation receipt 建立 TaskSession link。两条路径使用相同 creation/idempotency contract。

Feature disabled 后：

- 已有 TaskSession 和消息保留。
- 历史 Workflow/Artifact 按 Runtime/Feature retention 只读展示。
- Feature renderer 不再加载，使用 generic renderer 或 unavailable reason。
- 新 launch、Business Command 和 Replan 如果依赖 disabled Feature release，则拒绝。

## 持久化与一致性

### 数据库边界

建议新增：

```text
store/task-workspace.db
data/task-workspace/values/
data/task-workspace/blobs/
```

不把 TaskSession 建立在现有 `messages.db` 的 `chats/messages` 上。现有表以 channel/chat JID 为主，仍用于 Web/group/channel message history；Task Workspace conversation 是用户任务领域，具有 LaunchIntent、ExecutionLink、Intervention 和 Timeline correlation 等不同不变量。

Task Workspace 可以保存 existing chat/message typed source link，但不迁移、复制或删除原 channel history。

### Logical Schema

第一版至少包含：

```text
task_workspace_sessions
task_workspace_threads
task_workspace_messages
task_workspace_message_attachments
task_workspace_launch_intents
task_workspace_launch_input_revisions
task_workspace_adhoc_drafts
task_workspace_adhoc_draft_revisions
task_workspace_execution_links
task_workspace_artifact_links
task_workspace_pending_interaction_links
task_workspace_intervention_requests
task_workspace_replan_requests
task_workspace_personal_workflow_drafts
task_workspace_workspace_events
task_workspace_timeline_projection_heads
task_workspace_timeline_projection_entries
task_workspace_outbox
task_workspace_idempotency_records
task_workspace_audit_events
task_workspace_value_records
task_workspace_blob_records
```

内部对象使用真实 FK 和 exactly-one typed relation。跨 Runtime/Trace/Feature DB 的 target 使用按 target kind 展开的完整 lineage 列和 verification hash，不用一个开放 `target_ref` 表示所有内部对象。

### 权威字段与 Projection 字段

权威：

- Session status/title/owner。
- Conversation message。
- LaunchIntent 和 input revision。
- Ad Hoc draft revision。
- ExecutionLink causation identity。
- Intervention/Replan request intent。
- Personal Workflow draft intent。

可重建 Projection：

- 当前 linked execution status。
- attention state。
- Timeline runtime entries。
- Artifact display summary。
- command hints。
- pending count。

### 跨库一致性

Task Workspace 不持有 Runtime write connection。跨库流程使用 API + outbox/receipt：

```text
commit Workspace intent + outbox
  -> call authoritative Gateway with stable idempotency key
  -> receive canonical receipt
  -> commit receipt/link/event
```

响应丢失时：

- 使用 creation key 查询 Workflow Creation Request。
- 使用 command id/idempotency domain 查询 canonical Command result。
- 使用 interaction request + idempotency key 查询 submission result。
- 使用 publish operation key 查询 authoring/release receipt。

不存在查询能力的外部 mutation 不得由 Task Workspace 调用。

### Retention

- Session archive 不删除 Workflow、Trace、Feature 或 Artifact 数据。
- Session delete 第一版不提供；后续删除必须先生成跨 Store 引用和 retention 摘要。
- Message/attachment retention 与 Runtime/Trace retention 分开。
- Timeline Projection 可以重建和清理；Workspace authoritative event 保持有限 retention。
- Blob GC 必须考虑 message、draft、review、artifact link 和 audit pin。

## API 与事件协议

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
GET  /api/task-workspace/sessions/:sessionId/timeline
GET  /api/task-workspace/sessions/:sessionId/events
```

### Launch API

```text
GET  /api/task-workspace/recipes
POST /api/task-workspace/sessions/:sessionId/launch-intents
GET  /api/task-workspace/launch-intents/:launchIntentId
POST /api/task-workspace/launch-intents/:launchIntentId/clarify
POST /api/task-workspace/launch-intents/:launchIntentId/confirm
POST /api/task-workspace/launch-intents/:launchIntentId/cancel
```

### Interaction 与控制 API

```text
POST /api/task-workspace/interactions/:interactionId/submit
POST /api/task-workspace/sessions/:sessionId/runtime-command-proposals
POST /api/task-workspace/runtime-command-proposals/:proposalId/confirm
POST /api/task-workspace/sessions/:sessionId/interventions
POST /api/task-workspace/interventions/:interventionId/confirm
POST /api/task-workspace/interventions/:interventionId/cancel
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
```

### API 约束

- Mutation 统一使用 authenticated session、idempotency key、expected row version 和 closed request schema。
- Recipe 列表返回 server-filtered、permission-aware selection token，客户端不提交任意 Registry ref。
- 列表使用 server-signed cursor 和 closed filter/sort catalog。
- Runtime/Feature mutation endpoint 不做任意 JSON passthrough；Workspace API 解析为 closed command union 后调用正式 client。
- Error 使用稳定 code、target、retryability、canonical receipt link 和 freshness 信息。

## 权限、安全与审计

### Actor

- 本地单用户默认 `human:local-owner`，但每次 Human 操作仍记录为 Human，不记成 system。
- Coordinator 使用独立 `agent:task-session-coordinator`，只能获得 query/proposal 权限。
- Background projection/reconciliation 使用独立 service actor。
- Feature delegated operation 保存 human actor、feature service delegation chain 和 source feature id。

### Permission

建议新增 Workspace permission catalog：

```text
task_session.create
task_session.read.own
task_session.update.own
task_session.archive.own
task_session.launch_workflow
task_session.propose_intervention
task_session.manage_personal_workflow
```

Runtime operation、Feature Business Command、Artifact read、Trace read、authoring/publish 继续使用各自领域权限。Workspace permission 不能替代目标 Gateway permission。

### Prompt Injection 与不可信数据

- Conversation、Artifact、Trace、Feature text、tool result 和 Runtime error 均作为不可信 data 注入 Coordinator。
- Trusted tool catalog、permission、policy、schema 和 target lineage 不可由消息覆盖。
- Coordinator 不接收 Credential 原文、session token、完整 secret-bearing environment 或未经 redaction 的敏感 Trace。
- Artifact 内容要求高风险操作时只能形成 proposal，不可直接改变工具权限。

### 审计

至少记录：

- Session create/complete/reopen/archive。
- Message actor、attachment、causation 和 coordinator execution。
- Recipe selection、routing result、clarification 和 launch confirmation。
- Ad Hoc draft/compiler/risk/confirmation identity。
- Runtime/Business Command proposal、confirmation 和 canonical receipt。
- Human Interaction submission result。
- Replan frontier、effect safety、diff、confirmation 和 source/target Run lineage。
- Personal Workflow draft/review/publish/activation。
- Permission denial、conflict、late request、projection degraded 和 integrity failure。

审计正文避免复制敏感消息或 Artifact bytes，使用 immutable refs/hashes 和 redacted summary。

## 前端布局与交互

### Desktop

```text
+------------------+--------------------------------+----------------------+
| Task Sessions    | Conversation Timeline          | Runtime Inspector    |
|                  |                                |                      |
| Active           | messages                       | Overview             |
| Waiting          | progress entries               | DAG                  |
| Completed        | inline cards                   | Artifacts            |
| Archived         | artifact/completion entries    | Pending              |
|                  |                                | Trace                |
| Search / Filter  | Composer + Recipe Selector     | Context              |
+------------------+--------------------------------+----------------------+
```

- 左栏宽度稳定，可折叠；展示 title、attention、linked execution summary 和更新时间。
- 中栏是主要工作面，Timeline virtualization 不能影响 composer 位置。
- 右栏默认隐藏或显示最近面板，通过 header inspector button 打开；宽度可调整但不覆盖 composer。
- 用户点击 DAG Node、Artifact、Trace 或 Card 时右栏切换对应详情，不创建多层嵌套 modal。
- 当前 Workflow/Run selector 放在中栏 header 或 inspector header，不和 composer Recipe selector 混淆。

### Composer

- Recipe selector 使用 `Auto`、已允许 Recipe 和 `Temporary Workflow`，不展示 Registry 技术字段。
- 附件、发送、停止 Coordinator response 使用标准 icon button 和 tooltip。
- 有 pending clarification 时 composer 可以继续普通对话，但提交为 answer 必须显式关联 request。
- 有多个 active executions 时，runtime control 必须显示 target selector。
- 输入文本不会因为打开/关闭 inspector、卡片 loading 或流式 response 改变布局尺寸。

### Mobile / Narrow Width

- 左侧 Task List 变为导航 drawer。
- Runtime Inspector 变为 bottom sheet/full-page detail。
- Conversation 和 inline Human Input 保持主 surface。
- 复杂 DAG、Trace、Personal Workflow review 提示回到 Desktop Web Workbench，不强行压缩成不可操作页面。

### Timeline 视觉语义

- Human/Coordinator message 使用对话样式。
- Runtime progress 使用无气泡的紧凑事件行，不伪装成 Agent 发言。
- Human Input 使用共享 Card renderer。
- Error、action-required 和 degraded 明确区分，不能只用同一红色文本。
- Completed Artifact 提供打开 inspector 或 Feature renderer 的明确操作。
- Raw log、schema、hash 和完整 Trace 默认折叠到详情，不淹没任务对话。

## 模块边界

建议目录：

```text
src/task-workspace/
  contracts/
    types.ts
    schemas/
    catalogs/
  store/
    task-workspace-store.ts
    schema/
    value-store.ts
  sessions/
    session-service.ts
    message-service.ts
    execution-links.ts
  coordinator/
    coordinator-gateway.ts
    intent-resolver.ts
    tool-catalog.ts
    context-builder.ts
  launch/
    launch-intent-service.ts
    recipe-catalog-client.ts
    task-intake-client.ts
    adhoc-draft-service.ts
  interactions/
    presentation-adapter.ts
    submission-router.ts
  interventions/
    command-proposal-service.ts
    replan-service.ts
    frontier-builder.ts
  personal-workflows/
    draft-service.ts
    extraction.ts
    authoring-client.ts
    publisher-client.ts
  projection/
    event-consumer.ts
    timeline-projection.ts
    attention-projection.ts
    rebuild.ts
  api/
  events/

electron/renderer/task-workspace/
  entry.ts
  app.ts
  api-client.ts
  event-client.ts
  task-list/
  conversation/
  composer/
  interactions/
  runtime-inspector-host/
```

约束：

- 不继续把 Task Workspace 追加到 monolithic `electron/renderer/app.js`。
- Renderer 不 import Node DB、Runtime Store 或 Feature host implementation。
- `src/task-workspace/` 只能依赖 Workflow Runtime、Trace、Feature Host、Authoring 的 public client/contract。
- Workflow Runtime 不依赖 Task Workspace。
- Feature renderer 通过 Shell mount 和 typed props 通信，不共享可变 global store。
- Coordinator tool implementation 与模型 prompt 分离；tool authorization 不由 prompt 决定。

## 失败、恢复与降级

### Coordinator 失败

- Human message 已提交但 Coordinator 未启动：outbox 重试同 coordinator execution key。
- Coordinator 流式响应中断：保留 partial display，但只有 terminal message commit 才成为完整 Coordinator message；用户可重试。
- Tool proposal 已创建但 message 未完成：proposal 独立可恢复，不根据 partial text 自动执行。

### Workflow 创建响应丢失

- LaunchIntent 保持 `creating`。
- Reconciler 使用 creation domain/key 查询 Runtime。
- 已创建则补建 ExecutionLink；未创建且 safe retry 则 exact replay；intent mismatch 进入 conflict。

### Runtime Projection 失败

- Timeline/Inspector 显示最后可信 snapshot、source seq 和 last success。
- 需要 current state 的命令 disabled。
- 用户从权威详情刷新后仍可调用的命令由 Gateway 独立判断。
- Rebuild 只替换 Workspace projection，不改 Runtime。

### Card 重复或冲突

- 相同 idempotency key 返回 canonical result。
- 不同 surface 已处理时返回 conflict/duplicate 并刷新卡片。
- 过期 snapshot 不自动迁移用户 payload 到新 request。

### Replan 失败

- Compiler 失败：保留 source Run control 和 draft diagnostics，不应用。
- Active effect 无法证明状态：进入 action-required，禁止新 Run claim。
- Source fence 成功、新 Activation 创建响应丢失：按 replan id/creation key reconcile。
- 新 Activation 未创建：不能把 source Run 标成成功完成。
- Replan apply crash 后 recovery 必须得到 old-only 或 old-fenced/new-created 的合法状态，不能出现两个普通 running Run 同时消费同一 claim。

### Feature disabled

- TaskSession 和 generic metadata 可读。
- 新 launch/business action 拒绝。
- Feature renderer unavailable 时不执行旧 bundle。
- 历史 Artifact 使用 generic renderer 或 typed unavailable state。

### Personal Publish 失败

- Authoring staging、review、inactive publication 和 activation 分离。
- activation CAS 失败保持旧 active Personal Catalog。
- response loss 使用相同 operation key 对账。
- 失败 member 不进入普通 Recipe selector。

## 测试策略

### Contract Fixture

- TaskSession、Message、LaunchIntent、Draft Revision、ExecutionLink、Timeline Entry、Interaction Submission、Replan Request closed schema。
- Unknown field、wrong target lineage、unsafe integer、hash drift、same ref/different hash 和 invalid state combination 拒绝。

### Store Test

- Migration、FK、CHECK、partial index、CAS、idempotency 和 reopen。
- Message/session sequence 单调且并发提交不分叉。
- Typed cross-store link exactly-one relation。
- Projection 删除/重建不改变 authoritative rows。

### Coordinator Test

- Query 与 mutation intent 正确分类。
- 多 target 时要求澄清。
- Prompt injection 不能扩展 tool/permission/target。
- Agent 文本声称成功但无 receipt 时 UI 不显示 applied。

### Launch Test

- Explicit Recipe 不被 Router 改写。
- Auto route 只选择 pinned scope。
- `no_route_available` 进入 Ad Hoc，而不是全局 catalog 浏览。
- clarification revision、confirm expiry、creation response loss 和 idempotency conflict。

### Timeline Test

- Runtime/outbox duplicate 不重复 entry。
- seq gap/hash mismatch 进入 degraded。
- WebSocket reconnect 从 cursor 精确补拉。
- 高频 progress 折叠不丢 Artifact、Wait、Command 和 terminal event。

### Human Input Test

- 同一 request 在 Conversation/Pending/Runtime Center 多 surface 一致。
- duplicate/conflict/expired/permission denied/row version conflict。
- schema validation、attachment、enum、checkbox、date、number 和 secret-bearing field。

### Replan Model Test

- running Attempt、paused Run、wait、retry、child scope、effect receipt、unknown effect、required compensation 和 blocker 的状态组合。
- source Run fence 与 target Run create 的 crash boundary。
- 旧 Plan/Input/Artifact/Effect rows byte-exact 不变。
- Workflow lifetime budget 和 domain claim 不被新 Run 重置。

### UI Test

- Desktop、narrow desktop 和 mobile viewport 无遮挡、文本溢出或布局跳动。
- Inspector hidden/open、long task title、long Recipe label、streaming entry 和 large card。
- Keyboard navigation、focus return、screen reader label 和 reduced motion。
- Feature renderer unavailable、Projection degraded 和 offline reconnect。

### Security Test

- Coordinator 无 Runtime DB/Registry/Feature DB write path。
- 任意 Recipe ref、target id、command type、filesystem path 和 SQL 注入拒绝。
- Cross-session/cross-owner link 和 Artifact read 拒绝。
- Secret、Credential、Cookie、Token 不进入 prompt、Timeline、Personal Workflow source 或 audit body。

## 实施顺序

Dynamic Workflow Runtime Production Activation 是全部阶段前置。本文不修改或扩展主 DAG 方案当前 Gate。

### W0：合同与 Runtime Readiness Audit

- 冻结 TaskSession、Conversation、LaunchIntent、ExecutionLink、Timeline、Interaction 和 Workspace Event schema。
- 审核 Runtime public Task Intake、Projection、Trace、Artifact、Card 和 Command clients。
- 明确缺失的只读 query/export/correlation extension，不增加 DB 直连。
- 冻结 Task Workspace permission/error/status catalog。

退出条件：Contract Pack、negative fixture、module dependency test 和 Runtime readiness matrix 完成。

### W1：Task Workspace Store 与 Session API

- 实现 `task-workspace.db`、Value/Blob、migration、Schema Manifest 和 GC。
- 实现 Session、Thread、Message、Attachment、Workspace Event、idempotency 和 audit。
- 实现 Task List、Session detail 和 message API。

退出条件：没有 Workflow 的 TaskSession 可以完整创建、对话、恢复、完成和归档。

### W2：Core Shell 与 Conversation Timeline

- 新增独立 Task Workspace renderer entry/bundle。
- 实现三栏布局、Task List、Conversation、Composer 和 responsive surface。
- 实现 Timeline Projection、event stream、cursor reconnect 和 degraded state。
- 接入 Coordinator query/explanation 最小能力。

退出条件：TaskSession 可以稳定对话，并展示模拟 typed runtime event stream，不依赖 monolithic renderer。

### W3：Recipe Launch 与 ExecutionLink

- 实现 permission-aware Recipe selector。
- 接入 explicit/auto Task Intake、clarification、confirmation 和 creation reconcile。
- 建立 Workflow/Standalone Agent ExecutionLink。
- 接入 Workflow status/completion Timeline。

退出条件：同一 Session 可以启动、追踪和继续讨论多个 execution，response loss 不重复创建。

### W4：Ad Hoc Workflow

- 发布 Core Ad Hoc Recipe、Planner 和 policy envelope。
- 实现 immutable draft revision、compiler、risk summary 和 confirmation card。
- 通过正式 Runtime 创建临时 Workflow。

退出条件：无匹配 Recipe 的任务可以经用户确认后形成可信 Workflow，且不能扩大 Catalog、permission 或 effect ceiling。

### W5：Human Input 与 Runtime Control

- 复用 Card Presentation renderer。
- 接入 Wait Signal、Runtime Command 和 typed Business Command proposal/submission。
- 实现 Conversation/Pending/Runtime Center 多 surface 同步。
- 支持 pause、resume、cancel 和 policy 允许的其他通用 command。

退出条件：审批和控制的 authoritative receipt、幂等、冲突和审计一致。

### W6：Runtime Inspector

- 实现 Overview、DAG、Artifacts、Pending、Trace 和 Context。
- 抽取 Task Workspace/Runtime Center 可复用的 typed client/component boundary。
- 接入 Feature Artifact renderer deep link/fallback。

退出条件：用户不离开 TaskSession 即可完成常规运行检查，复杂诊断仍能深链 Runtime Center。

### W7：Personal Workflow

- 实现从 Run 创建 sanitized authoring draft。
- 冻结 Personal ownership、namespace、Registry 和 Publisher contract。
- 接入 validate、compile、dry-run、review、publish、activate 和 rollback。
- 在 Composer Recipe selector 中展示 active Personal Recipe。

退出条件：保存操作不会直接发布，旧 Run 不受新版本影响，发布失败不改变 active Catalog。

### W8：Intervention 与 Replan

- 冻结 Replan policy、request、frontier、effect safety、diff 和 lineage contract。
- 为 Core Ad Hoc Definition 实现标准 Replan path。
- 为 opt-in Published Recipe 提供 rework/replan adapter。
- 实现 crash recovery、model test 和 UI diff/confirmation。

退出条件：任意成功 Replan 都保留旧 Plan，并且 source/target Run、effect、claim、budget 和 audit lineage 完整。

### W9：Feature 接入与 Production Hardening

- 接入 Feature Recipe、Business Command、Artifact renderer 和 task preset。
- 验证 Feature disable/draining/retention 行为。
- 完成性能、accessibility、security、backup/restore 和 Product Surface Coverage Gate。
- 建立正式 Runtime/Task Workspace/Electron production ingress。

退出条件：Core、Personal 和 Feature Workflow 均使用同一 Task Workspace 合同，不存在私有执行或控制旁路。

## 验收标准

### TaskSession

- TaskSession 可以在没有 Workflow 时创建，并在后续关联多个 execution。
- Session completion/archive 不隐式控制 Runtime。
- Conversation 和 channel chat identity 不混用。
- response loss、restart 和 reconnect 后消息、launch 和 link 不重复不丢失。

### Workflow Launch

- Explicit Recipe、Auto Route 和 Ad Hoc 使用统一 Task Intake provenance。
- Auto 不能浏览 pinned Routing Scope 外的 Recipe。
- 临时 Plan 必须通过正式 Compiler/Policy/Safety gate并由用户确认 exact revision。
- Workflow creation exact replay 不产生第二个 Workflow。

### Coordinator

- Coordinator 没有 Runtime/Feature/Registry 直写能力。
- 所有 applied 状态都有 authoritative receipt。
- 多 target、过期 snapshot 和 degraded Projection 不静默操作。
- Prompt injection 不能扩大能力、权限、资源或 target。

### Timeline 与 UI

- 进度、Human Input、Artifact、Command result 和 completion 实时到达并可断线补拉。
- Runtime event 与 Agent message 在视觉和数据模型上明确区分。
- 三栏 Desktop 和窄屏布局无重叠、溢出和不可恢复 focus。
- Raw Trace/Log 不淹没默认任务流。

### Human Input

- 一个请求在所有 surface 状态一致。
- duplicate/conflict/expired/denied 有稳定结果。
- 卡片 submission 最终由权威目标 Gateway 校验。

### Runtime Control 与 Replan

- pause/resume/cancel 统一走 Runtime Command Gateway。
- 普通消息不改变 sealed Node input。
- 已 materialize Scope Plan 永不修改。
- Replan 只创建新 Activation/Run，旧 Plan、Attempt、Artifact 和 effect history 保持不可变。
- unknown effect、required compensation 或 integrity quarantine 不会被 Replan 绕过。

### Personal Workflow

- 保存先创建 authoring draft，不直接创建 active Recipe。
- instance-only data、Credential 和临时路径不会进入 reusable source。
- validate/compile/dry-run/review/publish/activate 边界完整。
- 新版本只影响后续 launch；旧 Run 固定旧 snapshot。

### Feature 与 Runtime Center

- Feature 不创建第二套 Task Workspace、Coordinator 或 Runtime control path。
- Feature disable 后历史 Session 可读、新操作拒绝、renderer 安全降级。
- Runtime Center 保留全局诊断和管理，Task Workspace 不复制 Capacity/Projection admin。
- 两侧通过 typed link 和公共 clients 协作，无 store/state import。

## 后续议题

以下事项明确延后，不阻塞本文方案编写，但必须在对应实施阶段开始前冻结：

1. Personal Workflow Registry owner/namespace、sharing 和 export/import 的最终合同。
2. Published Workflow opt-in Replan policy 与 outer Definition rework entrypoint 的 closed schema。
3. TaskSession 与 Workflow 的 primary/secondary link 是否支持未来多人协作和跨 Session 引用。
4. Ad Hoc Plan 低风险场景是否允许用户显式开启 auto-launch；第一版默认要求确认。
5. Task Workspace 与 Personal Assistant 的主动创建、提醒和静默策略。
6. Session 删除、数据导出和跨 Store retention/legal hold。
7. 多设备同步、远程访问和多用户 RBAC；第一版仍以本地单用户为产品下限。
