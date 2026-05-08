# Workflow Durable Runtime Full Migration Plan

## 目标

一次性将 workflow runtime 从旧的 `confirmation` 兼容模型迁移到新的 durable interrupt runtime。

本方案的约束是：

- 已完成的 Workbench 历史任务不做兼容迁移。
- 现有 workflow 配置文件需要一次性迁移为新格式。
- 迁移完成后，definition / compiler / runtime / Web 客户端均不再接受 `confirmation`。
- 所有人工暂停、审批、补充输入、外部阻塞点都统一建模为 `interrupt`。
- `resumeWorkflowInterrupt()` 是唯一恢复入口。

目标形态：

```text
definition state: delegation | interrupt | system | terminal
runtime state:    delegation | interrupt | system | terminal
pending input:    workflow_interrupts
event log:        workflow_events
checkpoint:       workflow_checkpoints
resume API:       resumeWorkflowInterrupt()
card action:      workflow_interrupt_resume
```

---

## 0. 计划审查修订决策

本节记录本次计划审查后统一确认的 8 个修订点，后续实现与拆分任务以此为准。

1. `resumeWorkflowInterrupt()` 必须在同一次持久化事务中完成校验、记录提交内容、关闭待办、按 `on_resume[action]` 推进 workflow、更新当前 state、写 checkpoint，并创建下一 state 所需的 durable 记录。
2. 外部通知、飞书卡片刷新、assistant inbox 更新不放在核心事务内，只通过 event / outbox 幂等执行。
3. `testing_confirm` 的 `skip` 保留为 credential interrupt 的独立动作，不再映射成 `approve`。
4. 现有 card 里的 `cancel` 全部迁移为 workflow control action：`cancel_workflow`，保持当前“取消整个 workflow”的真实行为。
5. 新增 `workflow_interrupt_resume_attempts` 表，记录每次 resume 请求的 idempotency key、actor、action、payload、结果，用于区分重复回调、重复点击和冲突提交。
6. `allowed_channels` 缺省为 `web | feishu | assistant`；`system` 不属于普通用户恢复入口，只用于 timeout、expire、cancel 等内部控制流。
7. Workbench action item 的 `item_type` 直接等于 interrupt `kind`，完整支持 `approval | revision_request | credential | human_input | external_blocker`。
8. Artifact Contract、Evaluator Registry、Rollback Hint 本次作为必做范围，不拆出；需要明确接入 delegation 完成后的验收和失败流转。同时，上线前对 active workflow 设置硬门禁：如果存在未完成 workflow 且未执行专门迁移，部署 / 启动失败，要求人工终止或迁移。

---

## 1. 核心设计决策

### 1.1 删除运行时 confirmation 语义

`confirmation` 不再是一种 runtime state。

迁移后：

- `src/workflow-definition.ts` 不再声明 `WorkflowDefinitionConfirmationState`。
- `src/workflow-compiler.ts` 不再编译 `confirmation`。
- `src/workflow-config.ts` validator 遇到 `confirmation` 直接报错。
- `src/workflow.ts` 不再有 `approveWorkflow()` / `reviseWorkflow()` 作为业务入口。
- Web definition editor 不再提供 `confirmation` 类型。

如果需要审批、修改意见、token 输入、人工选择，统一使用 `interrupt`。

### 1.2 一次性迁移配置

新增一次性迁移脚本，将现有配置改写为新格式：

```text
container/workflow-definitions/*.json
container/cards/*.json
```

迁移完成后，旧格式不可继续提交。

建议脚本：

```text
scripts/migrate-workflow-confirmation-to-interrupt.ts
```

脚本职责：

- 将所有 `type: "confirmation"` state 改成 `type: "interrupt"`。
- 将 `on_approve` / `on_revise` 改成 `on_resume`。
- 为每个 interrupt 补齐 `kind`、`allowed_actions`、`resume_payload_schema`。
- 将旧 card action 改写为 `workflow_interrupt_resume` 语义。
- 输出迁移报告，列出需要人工确认的 action 映射。

### 1.3 运行时只处理 canonical 配置

迁移后 runtime 不做旧配置兼容判断。

这意味着 runtime 可以保持简单不变量：

- 进入 `interrupt` state 必定创建或复用一个 pending interrupt。
- 所有 Web / 飞书 / assistant inbox 输入都必须带 `interrupt_id`。
- 只有 `resumeWorkflowInterrupt()` 能推进 interrupt state。
- workflow terminal/cancel 时必须关闭所有 pending interrupt。

---

## 2. Definition Schema

### 2.1 State base

```ts
export interface WorkflowDefinitionStateBase {
  type: 'delegation' | 'interrupt' | 'terminal' | 'system';
  label?: string;
  description?: string;
  retry_policy?: WorkflowDefinitionRetryPolicy;
  timeout_policy?: WorkflowDefinitionTimeoutPolicy;
  artifact_contract?: WorkflowDefinitionArtifactContractRef;
  evaluator?: WorkflowDefinitionEvaluatorRef;
  rollback_hint?: WorkflowDefinitionRollbackHintRef;
}
```

### 2.2 Interrupt state

```ts
export interface WorkflowDefinitionInterruptState
  extends WorkflowDefinitionStateBase {
  type: 'interrupt';
  kind:
    | 'approval'
    | 'revision_request'
    | 'credential'
    | 'human_input'
    | 'external_blocker';
  card?: WorkflowDefinitionCardRef;
  title?: string;
  body?: string;
  resume_payload_schema: WorkflowDefinitionJsonSchemaRef;
  allowed_actions: string[];
  allowed_channels?: Array<'web' | 'feishu' | 'assistant'>;
  on_resume: Record<string, WorkflowDefinitionTransition>;
  on_cancel?: WorkflowDefinitionTransition;
  on_expire?: WorkflowDefinitionTransition;
}
```

### 2.3 Policy / contract / evaluator refs

```ts
export interface WorkflowDefinitionRetryPolicy {
  max_attempts: number;
  backoff?: 'fixed' | 'linear' | 'exponential';
  initial_delay_ms?: number;
  max_delay_ms?: number;
  retry_on?: Array<
    | 'timeout'
    | 'transient_error'
    | 'agent_retryable_error'
    | 'evaluator_pending'
  >;
  on_exhausted?: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionTimeoutPolicy {
  duration_ms: number;
  notify?: Array<'web' | 'feishu' | 'assistant' | 'main_group'>;
  on_timeout: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionJsonSchemaRef {
  ref?: string;
  schema?: Record<string, unknown>;
}

export interface WorkflowDefinitionArtifactContractRef {
  ref: string;
}

export interface WorkflowDefinitionEvaluatorRef {
  ref: string;
  on_pass?: WorkflowDefinitionTransition;
  on_needs_revision?: WorkflowDefinitionTransition;
  on_fail?: WorkflowDefinitionTransition;
  on_pending?: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionRollbackHintRef {
  ref: string;
}
```

Evaluator transition 规则：

- 如果 state 配置了 `evaluator`，delegation / system state 完成后必须先运行 evaluator，再执行业务 transition。
- `on_pass` 表示验收通过后的目标；如果未配置，沿用 state 原有 `on_complete.success`。
- `on_needs_revision` 表示需要返工；如果未配置，沿用 state 原有 `on_complete.failure`。
- `on_fail` 表示无法自动判定或严重失败；如果未配置，进入 `retry_policy.on_exhausted` 或人工 interrupt。
- `on_pending` 表示证据不足或 evaluator 暂时不可用；通常进入 retry 或人工 interrupt。
- 每次 evaluator 结果都必须写 `artifact_evaluated` event，作为 transition 断言来源。

---

## 3. 配置迁移规则

### 3.1 State 迁移

旧配置：

```json
{
  "type": "confirmation",
  "card": { "ref": "plan_confirm" },
  "on_approve": { "target": "dev" },
  "on_revise": { "target": "plan" }
}
```

新配置：

```json
{
  "type": "interrupt",
  "kind": "approval",
  "card": { "ref": "plan_confirm" },
  "title": "确认方案后进入开发",
  "resume_payload_schema": {
    "schema": {
      "type": "object",
      "properties": {
        "revision_text": { "type": "string", "minLength": 1 }
      }
    }
  },
  "allowed_actions": ["approve", "revise"],
  "allowed_channels": ["web", "feishu", "assistant"],
  "on_resume": {
    "approve": { "target": "dev" },
    "revise": { "target": "plan" }
  }
}
```

### 3.2 旧 action 映射

现有 card action 需要一次性迁移到 canonical resume action。

建议默认映射：

| 旧 action | 新动作类型 | canonical action | payload |
| --- | --- | --- | --- |
| `approve` | interrupt resume | `approve` | `{}` |
| `approve_dev` | interrupt resume | `approve` | `{}` |
| `skip` | interrupt resume | `approve` | `{ skipped: true }` |
| `request_revision` | interrupt resume | `revise` | `{ revision_text }` |
| `submit_access_token` | interrupt resume | `submit` 或 `revise` | `{ access_token }` |
| `cancel` | workflow control | `cancel_workflow` | `{ workflow_id }` |
| `pause` | workflow control | `pause_workflow` | `{ workflow_id }` |

`submit_access_token` 建议迁移为独立 action `submit`，不要继续复用 `revise`。这样 `credential` 类型 interrupt 的语义更清晰：

```json
{
  "type": "interrupt",
  "kind": "credential",
  "allowed_actions": ["submit", "skip"],
  "resume_payload_schema": {
    "schema": {
      "type": "object",
      "properties": {
        "access_token": { "type": "string", "minLength": 1 }
      },
      "required": ["access_token"]
    }
  },
  "on_resume": {
    "submit": { "target": "testing" },
    "skip": { "target": "testing" }
  }
}
```

### 3.3 需要人工确认的迁移项

迁移脚本不能盲目处理以下情况：

- 一个旧 card 同时有多个 form submit action。
- action id 不在默认映射表中。
- `on_approve` 或 `on_revise` 缺失，但 card 上存在对应按钮。
- card form 字段与 interrupt schema 无法一一对应。
- `cancel` 需要表达为 cancel interrupt 还是 cancel workflow。

脚本应输出报告并失败退出，要求人工修正。

---

## 4. Card Schema 与卡片管理

### 4.1 Card action 不再直接表达业务动作

旧 card：

```json
{
  "id": "approve_dev",
  "label": "进入开发",
  "type": "primary"
}
```

新 card：

```json
{
  "id": "approve",
  "label": "进入开发",
  "type": "primary",
  "action_kind": "interrupt_resume",
  "resume_action": "approve"
}
```

渲染到具体渠道时，统一生成：

```json
{
  "action": "workflow_interrupt_resume",
  "workflow_id": "wf_xxx",
  "interrupt_id": "wi_xxx",
  "resume_action": "approve"
}
```

### 4.2 Workflow control action 单独建模

暂停、取消、重跑、回退不是 interrupt resume action。

建议 card action schema：

```ts
type CardActionKind =
  | 'interrupt_resume'
  | 'workflow_control'
  | 'external_link';

interface CardActionConfig {
  id: string;
  label?: string;
  type?: 'primary' | 'danger' | 'default';
  action_kind: CardActionKind;
  resume_action?: string;
  workflow_control_action?:
    | 'pause_workflow'
    | 'cancel_workflow'
    | 'retry_stage'
    | 'return_to_stage';
}
```

### 4.3 Card builder 输入

`buildInteractiveCard()` 需要接收 interrupt 上下文：

```ts
{
  workflowId: string;
  interruptId?: string;
  allowedActions?: string[];
  payloadSchema?: Record<string, unknown>;
  vars: TemplateVars;
  roleFolders: Record<string, string>;
}
```

如果 card action 是 `interrupt_resume`，但缺少 `interruptId`，builder 应该拒绝构建可提交卡片。

### 4.4 Web 卡片管理改造

Web card manager 需要同步改造：

- action 编辑器不再自由填写平台 action id。
- resume 按钮必须选择当前 interrupt state 的 `allowed_actions`。
- form submit 需要绑定一个 `resume_action`。
- form fields 应与 interrupt `resume_payload_schema` 对齐。
- 预览模式使用 mock `interrupt_id`，但明确标记为不可真实提交。
- workflow control action 与 interrupt resume action 分区展示。

---

## 5. Runtime 架构

建议将现有 `src/workflow.ts` 拆分为以下模块：

```text
src/workflow-runtime.ts
src/workflow-transitions.ts
src/workflow-interrupts.ts
src/workflow-events.ts
src/workflow-checkpoints.ts
src/workflow-watchdog.ts
src/workflow-artifact-contract.ts
src/workflow-evaluator-registry.ts
src/workflow-rollback-hints.ts
```

### 5.1 enterWorkflowState

所有状态进入都走统一入口：

```ts
function enterWorkflowState(input: {
  workflow: Workflow;
  stateKey: string;
  fromStateKey?: string;
  roles: Record<string, string>;
  reason: 'create' | 'transition' | 'resume' | 'retry' | 'timeout';
  transition?: StateTransition;
  contextPatch?: WorkflowContext;
}): void
```

职责：

- 写 `state_entered` event。
- 更新 workflow `status`。
- 写 checkpoint。
- 根据 state type 分派：
  - `delegation` -> create delegation
  - `interrupt` -> create workflow interrupt
  - `system` -> run deterministic action
  - `terminal` -> complete workflow and close active interrupts

### 5.2 applyWorkflowTransition

Transition 只负责纯状态跳转准备：

```text
resolve target
merge context patch
apply effects
write transition_applied event
call enterWorkflowState(target)
```

禁止在 transition 函数中直接发卡片、直接通知、直接创建 Web action item。

### 5.3 Delegation state

进入 delegation state 时：

- 根据 state delegate 配置渲染 task。
- 用幂等 key 创建 delegation。
- 写 checkpoint。
- 写 `delegation_created` event。
- 同步 Workbench subtask。

幂等 key：

```text
workflow_delegation:{workflow_id}:{state_key}:{round}:{attempt}
```

Delegation 完成后：

1. 读取 delegation 输出 payload、artifact 路径、trace id、attempt。
2. 如果 state 配置了 `artifact_contract`，先执行确定性 artifact contract 检查。
3. 如果 state 配置了 `evaluator`，按 evaluator registry 运行 deterministic / AI / hybrid evaluator。
4. 将检查结果写入 workflow context，并写 `artifact_evaluated` event。
5. 根据 evaluator 结果选择 `on_pass` / `on_needs_revision` / `on_fail` / `on_pending` transition。
6. 如果未配置 evaluator，则按原 delegation completion transition 推进。

Artifact / trace 路径必须包含 attempt 或可从 metadata 反查 attempt，避免 retry 后覆盖上一轮证据。

### 5.4 Interrupt state

进入 interrupt state 时：

- 用幂等 key 创建或复用 pending interrupt。
- 写 `interrupt_created` event。
- 创建 Workbench action item。
- 渲染 Web / 飞书 / assistant inbox 表示层。

幂等 key：

```text
workflow_interrupt:{workflow_id}:{state_key}:{round}:{attempt}
```

### 5.5 Terminal state

进入 terminal state 时：

- 关闭 workflow。
- resolve 所有关联 pending interrupt。
- resolve Workbench action item。
- 写 `workflow_completed` event。

### 5.6 Durable side effects / outbox

核心事务内只写 workflow state、event、checkpoint、interrupt、delegation 等 durable 记录，不直接调用外部渠道。

以下副作用统一通过 event -> outbox -> worker 处理：

- 发送或刷新飞书卡片。
- 创建或更新 Web action item。
- 更新 assistant inbox。
- 发送通知。
- 注入委派消息。
- 写 artifact 索引或派生记录。

Outbox worker 必须按 `idempotency_key` 幂等执行；失败只更新 outbox attempt，不回滚 workflow transaction。

---

## 6. DB Schema

### 6.1 workflow_interrupts

```sql
CREATE TABLE IF NOT EXISTS workflow_interrupts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  resume_payload_schema_json TEXT,
  allowed_actions_json TEXT NOT NULL,
  allowed_channels_json TEXT,
  assigned_role TEXT,
  action_payload_json TEXT,
  created_by TEXT NOT NULL,
  resumed_by TEXT,
  resume_action TEXT,
  resume_payload_json TEXT,
  resume_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  resumed_at TEXT,
  cancelled_at TEXT,
  expired_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_interrupts_workflow
  ON workflow_interrupts(workflow_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_workflow_interrupts_status
  ON workflow_interrupts(status, expires_at);
```

### 6.2 workflow_events

```sql
CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state_key TEXT,
  ref_type TEXT,
  ref_id TEXT,
  actor_json TEXT,
  payload_json TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow
  ON workflow_events(workflow_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_idempotency
  ON workflow_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Canonical event types：

| event_type | 触发时机 | 必要 payload |
| --- | --- | --- |
| `state_entered` | 进入任意 state | `from_state_key`, `reason`, `round`, `attempt` |
| `transition_applied` | transition 解析并应用 context patch | `source_state_key`, `target_state_key`, `transition` |
| `delegation_created` | delegation durable record 创建或复用 | `delegation_id`, `idempotency_key`, `attempt` |
| `delegation_completed` | delegation 输出被 runtime 接收 | `delegation_id`, `artifact_refs`, `trace_id`, `attempt` |
| `interrupt_created` | interrupt durable record 创建或复用 | `interrupt_id`, `kind`, `allowed_actions` |
| `interrupt_resumed` | resume 请求校验通过 | `interrupt_id`, `resume_action`, `actor`, `payload` |
| `interrupt_cancelled` | interrupt 被 workflow cancel/terminal 关闭 | `interrupt_id`, `reason` |
| `interrupt_expired` | watchdog 标记 interrupt 过期 | `interrupt_id`, `expires_at` |
| `timeout_fired` | watchdog 触发 state timeout | `timeout_policy`, `attempt` |
| `retry_scheduled` | retry policy 安排下一次尝试 | `next_attempt_at`, `attempt` |
| `artifact_evaluated` | artifact contract / evaluator 完成 | `artifact_contract_ref`, `evaluator_ref`, `result`, `findings`, `evidence` |
| `workflow_completed` | terminal state 完成 | `terminal_state_key`, `result` |

事件 payload 只记录可审计事实；外部通知、卡片刷新、assistant inbox 更新由 outbox 订阅事件后执行。

### 6.3 workflow_interrupt_resume_attempts

```sql
CREATE TABLE IF NOT EXISTS workflow_interrupt_resume_attempts (
  id TEXT PRIMARY KEY,
  interrupt_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  resume_action TEXT NOT NULL,
  resume_payload_json TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  conflict_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_interrupt_resume_attempts_idempotency
  ON workflow_interrupt_resume_attempts(interrupt_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_interrupt_resume_attempts_interrupt
  ON workflow_interrupt_resume_attempts(interrupt_id, created_at);
```

状态：

- `accepted`
- `duplicate`
- `conflict`
- `rejected`

该表只记录 resume 请求与判定结果；workflow 推进仍以 `workflow_interrupts.status` CAS、`workflow_events` 和 checkpoint 为准。

### 6.4 workflow_checkpoints

```sql
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_workflow
  ON workflow_checkpoints(workflow_id, checkpoint_version DESC);
```

Checkpoint 内容：

```ts
interface WorkflowCheckpoint {
  workflowId: string;
  workflowType: string;
  stateKey: string;
  round: number;
  context: Record<string, unknown>;
  currentDelegationId: string | null;
  pendingInterruptId: string | null;
  attempts: Record<string, number>;
  updatedAt: string;
}
```

### 6.5 workflow_outbox

```sql
CREATE TABLE IF NOT EXISTS workflow_outbox (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_id TEXT,
  effect_type TEXT NOT NULL,
  channel TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_outbox_status
  ON workflow_outbox(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_workflow_outbox_workflow
  ON workflow_outbox(workflow_id, created_at);
```

`effect_type` 第一版固定为：

- `send_feishu_card`
- `refresh_feishu_card`
- `sync_workbench_action_item`
- `sync_assistant_inbox`
- `send_notification`
- `inject_delegation_message`
- `index_artifact`

Outbox 状态：

- `pending`
- `processing`
- `succeeded`
- `failed`
- `dead_letter`

---

## 7. Resume API

```ts
export function resumeWorkflowInterrupt(input: {
  interruptId: string;
  action: string;
  payload?: Record<string, unknown>;
  actor: {
    channel: 'web' | 'feishu' | 'assistant' | 'system';
    userId?: string;
    displayName?: string;
  };
  idempotencyKey?: string;
}): { ok: true; workflowId: string } | { ok: false; error: string }
```

### 7.1 Transaction boundary

`resumeWorkflowInterrupt()` 必须在事务中完成：

1. 查询 interrupt。
2. 校验 `status === 'pending'`。
3. 校验 workflow 未 terminal。
4. 校验 action 在 `allowed_actions`。
5. 校验 actor channel 在 `allowed_channels`。
6. 校验 payload schema。
7. 写 `interrupt_resumed` event。
8. 更新 interrupt 为 `resumed`。
9. 写 workflow context patch。
10. 写 checkpoint。

外部副作用通过事件或 outbox 幂等执行，避免事务中直接调用渠道发送。

### 7.2 Duplicate resume

重复 resume 不应再次推进 workflow。

策略：

- 如果 idempotency key 相同，返回上次成功结果。
- 如果 interrupt 已 resumed，返回 `{ ok: true }`，并提示已处理。
- 如果 action 或 actor 不同，返回冲突错误并写安全日志。

### 7.3 Payload schema subset

第一版实现项目内需要的 JSON schema 子集：

- `type: object`
- `required`
- `properties`
- string / number / integer / boolean
- `minLength` / `maxLength`
- `enum`

暂不实现完整 JSON Schema。

---

## 8. Workbench 改造

Workbench 待办不再由 workflow stage 直接推导，而是由 pending interrupt 推导。

Action item：

```text
source_type = workflow_interrupt
source_ref_id = interrupt.id
item_type = approval | human_input | credential | external_blocker
action_kind = resume_workflow_interrupt
```

`extra_json`：

```json
{
  "interruptId": "wi_xxx",
  "allowedActions": ["approve", "revise"],
  "payloadSchema": {},
  "allowedChannels": ["web", "feishu", "assistant"]
}
```

状态同步规则：

- interrupt pending -> action item pending
- interrupt resumed -> action item resolved
- interrupt cancelled -> action item resolved
- interrupt expired -> action item resolved
- workflow terminal -> resolve all pending action items for workflow

现有已完成 Workbench 历史任务不迁移。

对于未完成 workflow：

- 推荐上线前清空或人工终止。
- 如果必须保留，需要启动恢复时基于当前 state 创建 checkpoint 和 pending interrupt。

---

## 9. Web 客户端改造

### 9.1 Workflow definition editor

Web definition editor 必须同步删除 `confirmation`：

- state type 枚举改为 `delegation | interrupt | system | terminal`。
- 新增 interrupt editor。
- `on_resume` 使用动态 action transition 列表。
- `allowed_actions` 与 card action 联动校验。
- `resume_payload_schema` 提供表单式编辑和 JSON 编辑两种模式。
- 状态图按 `on_resume[action]` 渲染边。

校验规则：

- `interrupt.allowed_actions` 非空。
- `interrupt.on_resume` 至少覆盖一个 allowed action。
- card 中所有 `interrupt_resume` action 必须存在于 `allowed_actions`。
- form submit action 的字段必须满足 schema required 字段。
- `confirmation` 直接报错。

### 9.2 Card manager

Card manager 必须区分：

```text
interrupt resume action
workflow control action
external action
```

UI 行为：

- interrupt resume action 只能选择 `resume_action`，不能直接填写平台 action。
- workflow control action 只能选择固定控制命令。
- form submit 必须绑定 resume action。
- preview 使用 mock workflow/interrupt context。
- 保存时执行跨资源校验：card action 与 workflow interrupt state 是否匹配。

### 9.3 Workbench action UI

Workbench 点击待办时：

- 从 action item `extra_json` 读取 interrupt metadata。
- 渲染对应 buttons / form。
- 调用 `resumeWorkflowInterrupt()` API。
- 提交后立即将本地 UI 标记为 processing。
- 收到 interrupt resolved event 后关闭待办。
- 如果服务端返回 already resumed，显示已处理，不重复提交。

---

## 10. Channel 改造

### 10.1 Card action router

新增优先分支：

```ts
if (action.action === 'workflow_interrupt_resume') {
  return handleWorkflowInterruptCardAction(action);
}
```

旧 workflow action switch 中删除：

- `approve`
- `approve_dev`
- `request_revision`
- `submit_access_token`

保留 workflow control：

- `pause_workflow`
- `cancel_workflow`
- `retry_stage`
- `return_to_stage`

### 10.2 Feishu

飞书 channel 只负责：

- 提取 `interrupt_id`
- 提取 `resume_action`
- 提取 form payload
- 调用 `resumeWorkflowInterrupt()`
- 返回 toast 或 replacement card

禁止在飞书 channel 中判断业务 transition。

### 10.3 Web

Web API 只暴露 canonical 操作：

```text
POST /api/workflow-interrupts/:id/resume
POST /api/workflows/:id/pause
POST /api/workflows/:id/cancel
POST /api/workflows/:id/retry-stage
```

---

## 11. Timeout / Retry / Watchdog

### 11.1 Watchdog

Watchdog 扫 DB，不依赖内存 timer。

扫描对象：

- pending interrupt 且 `expires_at <= now`
- running delegation 超过 state timeout
- evaluator pending 超过 timeout
- retry due

扫描对象必须覆盖 active workflow 当前 state，而不是只依赖 delegation / interrupt 派生记录。这样 system state、external API state 或 evaluator pending 状态即使没有独立工作项，也能被 durable timeout 发现。

### 11.2 Timeout event

幂等 key：

```text
workflow_timeout:{workflow_id}:{state_key}:{round}:{attempt}
```

流程：

1. CAS 标记 timeout event。
2. 如果可 retry，写 retry scheduled。
3. 如果不能 retry，执行 `timeout_policy.on_timeout`。
4. 关闭或更新 pending interrupt。
5. 通知配置的渠道。

### 11.3 Retry attempt

Attempt 存 checkpoint：

```json
{
  "attempts": {
    "dev": 1,
    "qa": 2
  }
}
```

Retry exhausted 后执行 `retry_policy.on_exhausted`，通常进入人工 interrupt。

每次 retry 必须创建新的 durable attempt 语义：

- delegation retry 重新创建或复用 `workflow_delegation:{workflow_id}:{state_key}:{round}:{attempt}`。
- system state retry 重新运行 deterministic action，但必须使用 attempt scoped idempotency key。
- evaluator retry 重新读取同一批 artifact evidence，除非前一个 transition 明确要求重新生成 artifact。
- 外部 API retry 不允许复用非幂等请求；必须配置 provider request id 或 workflow idempotency key。
- trace id、artifact evidence、outbox effect 必须记录 attempt，避免覆盖上一轮失败证据。

### 11.4 System / external API state

`system` state 用于 deterministic action 或外部 API 调用，不能依赖内存 promise 表示执行中状态。

进入 system state 时：

1. 写 `state_entered` event 和 checkpoint。
2. 创建 attempt scoped execution record 或 event。
3. 使用 `workflow_system:{workflow_id}:{state_key}:{round}:{attempt}` 作为幂等 key。
4. 执行动作前写 outbox 或 execution intent。
5. 动作完成后写 result 到 workflow context。
6. 如果配置了 `artifact_contract` / `evaluator`，进入同 delegation 一样的验收流程。
7. 如果失败且匹配 `retry_policy.retry_on`，交给 watchdog 安排 retry。
8. 如果失败且不可 retry，执行 `retry_policy.on_exhausted` 或进入人工 interrupt。

外部 API 调用要求：

- provider 支持幂等 key 时必须传递 workflow idempotency key。
- provider 不支持幂等 key 时，只允许调用可安全重试的 GET / read-like 操作；写操作必须改为人工 interrupt 或专门 adapter。
- response、status code、request id、error taxonomy 必须写入 event payload，供 retry / evaluator 判断。

---

## 12. Evaluator / Artifact Contract / Rollback Hint

### 12.1 Artifact contract

新增：

```text
container/artifact-contracts/*.json
```

Contract schema：

```ts
interface WorkflowArtifactContract {
  id: string;
  version: number;
  description?: string;
  files?: Array<{
    path: string;
    required: boolean;
    allowed_roots?: string[];
    must_exist?: boolean;
    frontmatter_required?: string[];
    frontmatter_schema?: Record<string, unknown>;
    max_bytes?: number;
  }>;
  payload?: {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  git?: {
    require_branch?: boolean;
    branch_field?: string;
    forbid_main_branch?: boolean;
    require_clean_worktree?: boolean;
  };
  tests?: Array<{
    name: string;
    required: boolean;
    evidence_field?: string;
    command_ref?: string;
  }>;
  allowed_artifact_roots?: string[];
}
```

第一版 deterministic checks：

- required file 是否存在。
- 文件路径是否落在 `allowed_artifact_roots` 或 `allowed_roots` 内。
- frontmatter 是否存在且包含 `frontmatter_required`。
- frontmatter schema 是否满足项目内 JSON schema 子集。
- payload required 字段是否齐全。
- payload properties 是否满足项目内 JSON schema 子集。
- `work_branch` / branch 字段是否存在。
- 如果 `forbid_main_branch` 为 true，产物不能声明直接修改 main branch。
- required test evidence 是否存在。
- artifact、trace、test evidence 是否能关联当前 workflow/state/attempt。

输出统一结果：

```ts
interface ArtifactEvaluationResult {
  status: 'passed' | 'needs_revision' | 'failed' | 'pending';
  score: number;
  summary: string;
  findings: Finding[];
  evidence: Evidence[];
}
```

Artifact contract 失败映射：

- required artifact 缺失：`pending` 或 `failed`，由 evaluator 配置决定。
- schema / frontmatter 不合法：`failed`。
- evidence 不足但可等待：`pending`。
- required test failed：`needs_revision` 或 `failed`，由 evaluator 配置决定。
- artifact 路径越界：`failed`，并强制进入人工 interrupt 或终止流程。

### 12.2 Evaluator registry

新增：

```text
src/workflow-evaluator-registry.ts
container/workflow-evaluators/*.json
```

Evaluator 类型：

- `deterministic`
- `ai`
- `hybrid`

不变量：

- deterministic failure 优先级高于 AI evaluator。
- AI evaluator 只读上下文。
- AI evaluator 输出必须是 JSON。
- evaluator 不直接执行修复。
- evaluator 必须输出 `status`、`summary`、`findings`、`evidence`。
- evaluator 不能直接推进 workflow，只能返回结果，由 runtime 根据 transition 配置推进。
- evaluator pending / timeout 走 `retry_policy`，超过次数后进入 `on_pending` 或人工 interrupt。

Evaluator 配置 schema：

```ts
interface WorkflowEvaluatorConfig {
  id: string;
  type: 'deterministic' | 'ai' | 'hybrid';
  deterministic?: {
    artifact_contract?: string;
    required_checks?: string[];
  };
  ai?: {
    enabled: boolean;
    model?: string;
    rubric: string;
    max_context_bytes?: number;
  };
  status_mapping?: {
    artifact_missing?: 'pending' | 'failed';
    schema_invalid?: 'failed';
    tests_failed?: 'needs_revision' | 'failed';
    ai_uncertain?: 'pending' | 'needs_revision' | 'failed';
  };
}
```

Runtime transition mapping：

- `passed` -> `evaluator.on_pass` 或 state `on_complete.success`。
- `needs_revision` -> `evaluator.on_needs_revision` 或 state `on_complete.failure`。
- `failed` -> `evaluator.on_fail`、`retry_policy.on_exhausted` 或人工 interrupt。
- `pending` -> `evaluator.on_pending`、retry schedule 或人工 interrupt。

每次 evaluator 完成必须写：

- `artifact_evaluated` event。
- checkpoint context 中的 latest evaluator result。
- 必要时同步 Workbench / assistant inbox 的 rollback hint 与 findings。

### 12.3 Rollback hint

Rollback hint 第一版只记录和展示，不自动执行。

写入位置：

- workflow event
- Workbench action item
- assistant inbox
- investigation prompt context

---

## 13. 启动恢复

启动时执行：

```text
resumeWorkflowRuntime()
  -> scan active workflows
  -> rebuild or verify latest checkpoint
  -> sync pending interrupts to Workbench
  -> re-render missing Web/Feishu cards if needed
  -> scan running delegations
  -> process completed delegations not yet transitioned
  -> start watchdog
```

恢复不变量：

- 如果 workflow 当前 state 是 interrupt，必须存在一个 pending interrupt。
- 如果已有 pending interrupt，不创建新的 interrupt。
- 如果 workflow terminal，不允许 pending interrupt 存活。
- 如果 delegation completed 但 transition 未执行，按 checkpoint/event 幂等推进。

---

## 14. 实施阶段

### Phase 0: 冻结旧语义

- 禁止新增 `confirmation` 配置。
- 梳理现有 workflow definition 与 card action。
- 输出 action mapping 报告。

### Phase 1: Schema / DB / 类型

- 新增 interrupt / event / checkpoint 表。
- 新增 resume attempts / outbox 表。
- 更新 `workflow-definition.ts`。
- 更新 validator，禁止 `confirmation`。
- 更新 definition schema，支持 evaluator transition、artifact contract、rollback hint。
- 新增 DB CRUD。

### Phase 2: 一次性配置迁移

- 编写迁移脚本。
- 迁移 `container/workflow-definitions/*.json`。
- 迁移 `container/cards/*.json`。
- 人工确认 action mapping。
- 删除旧 confirmation 测试或改写为 interrupt 测试。

### Phase 3: Runtime 重构

- 引入 `enterWorkflowState()`。
- 重写 transition / delegation / interrupt / system / terminal 流程。
- 删除 `approveWorkflow()` / `reviseWorkflow()` 业务入口。
- 新增 `resumeWorkflowInterrupt()`。
- delegation / system 完成后接入 artifact contract 和 evaluator transition。
- 所有外部副作用改为 event -> outbox -> worker。

### Phase 4: Web / Card / Channel

- 更新 Web definition editor。
- 更新 Web card manager。
- 更新 Workbench pending interrupt UI。
- 更新 card action router。
- 更新 Feishu/Web channel callback。

### Phase 5: Watchdog / Retry / Timeout

- 新增 durable watchdog。
- 支持 interrupt expire。
- 支持 delegation timeout。
- 支持 system / external API timeout。
- 支持 evaluator pending timeout。
- 支持 retry attempts 和 retry exhausted transition。
- retry trace / artifact / outbox evidence 均按 attempt 隔离。

### Phase 6: Evaluator / Artifact / Rollback

- 抽象 artifact contract。
- 引入 evaluator registry。
- 写入 `artifact_evaluated` event。
- 支持 evaluator `on_pass` / `on_needs_revision` / `on_fail` / `on_pending` transition。
- 接入 rollback hint 展示。
- 不自动执行 rollback。

---

## 15. 测试计划

### 15.1 Migration tests

- 旧 `confirmation` state 迁移为 `interrupt`。
- `on_approve` / `on_revise` 迁移为 `on_resume`。
- `approve_dev` -> `approve`。
- `request_revision` -> `revise`，保留 `revision_text` schema。
- `submit_access_token` -> `submit`，保留 `access_token` schema。
- 未知 action 触发迁移失败。

### 15.2 Definition / compiler tests

- validator 拒绝 `confirmation`。
- interrupt 缺少 `allowed_actions` 报错。
- interrupt 缺少 `on_resume` 报错。
- card resume action 不在 `allowed_actions` 报错。
- 状态图能读取 `on_resume` transition。

### 15.3 Runtime tests

- create workflow -> delegation -> interrupt -> resume -> next delegation。
- interrupt duplicate resume 只推进一次。
- 不同 actor/action 重复提交写 conflict attempt，不推进 workflow。
- terminal workflow resume 被拒绝或返回已结束。
- workflow cancel 关闭 pending interrupts。
- restart 后 pending interrupt 可继续 resume。
- completed delegation after restart 可继续 transition。
- delegation 完成后 artifact contract failed 不会直接进入 success transition。
- evaluator `passed` / `needs_revision` / `failed` / `pending` 分别走正确 transition。
- outbox 失败不会回滚 workflow checkpoint。

### 15.4 Channel tests

- Web action item 调用 `workflow_interrupt_resume`。
- 飞书 card action 调用 `workflow_interrupt_resume`。
- 飞书重复回调幂等。
- 旧 action id 不再被 workflow router 接受。

### 15.5 Watchdog tests

- pending interrupt expire 后执行 `on_expire`。
- delegation timeout 后执行 retry。
- system / external API timeout 后执行 retry 或 `on_timeout`。
- evaluator pending timeout 后执行 retry 或人工 interrupt。
- retry max attempts 后进入人工 interrupt。
- timeout event 幂等。
- retry attempt 生成独立 delegation/system idempotency key。

### 15.6 Evaluator tests

- artifact missing -> pending or failed。
- payload schema invalid -> failure。
- artifact path outside allowed roots -> failed。
- frontmatter required 字段缺失 -> failed。
- required test evidence missing -> pending or failed。
- deterministic passed -> AI evaluator。
- AI evaluator 输出非法 JSON -> pending or failed。
- 每次 evaluator 完成写 `artifact_evaluated` event。

### 15.7 Outbox tests

- 同一 event 重放不会重复发送飞书卡片。
- Workbench action item sync 可重试且最终一致。
- outbox dead letter 不影响 workflow resume 事务。
- outbox effect payload 包含 workflow/state/round/attempt。

---

## 16. 主要风险

### 16.1 配置迁移遗漏

风险：

- 某个旧 action 未映射，导致卡片无法提交。
- 某个旧 confirmation 缺失 schema，导致 Web 表单不完整。

缓解：

- 迁移脚本默认严格失败。
- 输出迁移报告。
- validator 增加 card/action/schema 跨资源校验。

### 16.2 Runtime 重构回归

风险：

- 初始 delegation 未触发。
- delegation complete 后未推进。
- Workbench current stage 与 workflow status 不一致。

缓解：

- 以 `enterWorkflowState()` 为唯一入口。
- 用 event/checkpoint 做断言。
- 补齐端到端 runtime tests。

### 16.3 副作用重复

风险：

- 重启后重复委派。
- 飞书重复回调重复推进。
- watchdog 重复 timeout。
- event 重放导致重复通知、重复卡片或重复 assistant inbox 项。

缓解：

- 所有副作用都有 idempotency key。
- `resumeWorkflowInterrupt()` 使用事务 CAS。
- watchdog 以 DB event 幂等为准。
- 渠道副作用统一通过 outbox worker 幂等执行。

### 16.4 Web 与后端模型不同步

风险：

- Web 继续生成旧 action。
- Card manager 允许保存不可执行卡片。

缓解：

- Web editor 与 card manager 同步禁用旧 action。
- 后端 validator 拒绝旧配置。
- 保存 workflow/card 时执行跨资源校验。

### 16.5 Active workflow 迁移

风险：

- 未完成 workflow 停在旧状态，迁移后无法恢复。

缓解：

- 已完成 Workbench 历史任务不迁移。
- 上线前列出 active workflow。
- 推荐人工终止或重建 active workflow。
- 如果必须保留，单独写 active workflow migration，不混入配置迁移。

### 16.6 Artifact / evaluator 误判

风险：

- artifact contract 过严导致可用产物被阻塞。
- AI evaluator 输出不稳定导致 workflow 错误返工或错误通过。
- retry 覆盖上一轮 artifact evidence，导致审计链断裂。

缓解：

- deterministic checks 只覆盖明确可验证的不变量。
- AI evaluator 只给结构化判断，不直接执行 transition。
- 所有 evaluator 结果写 `artifact_evaluated` event。
- artifact / trace / test evidence 必须带 workflow/state/attempt。

---

## 17. 最终验收标准

完成后应满足：

- 代码库中不再存在 runtime `confirmation` state 分支。
- workflow definition validator 拒绝 `confirmation`。
- 所有现有 workflow 配置已迁移为 `interrupt`。
- 所有 workflow card submit 都使用 `workflow_interrupt_resume`。
- Web / 飞书 / assistant 使用同一个 interrupt id 恢复流程。
- 重复 resume 不会重复推进。
- 服务重启后 pending interrupt 可以继续 resume。
- Workbench action item 由 pending interrupt 派生。
- timeout/retry 由 watchdog 扫 DB 驱动。
- system / external API state 可被 checkpoint、timeout 和 retry 恢复。
- delegation / system 完成后 artifact contract 和 evaluator 能决定后续 transition。
- 每次 artifact / evaluator 验收都会写 `artifact_evaluated` event。
- 所有渠道副作用通过 outbox 幂等执行。
- rollback hint 只记录和展示，不自动执行。
