# Human Review 人类确认协议标准化方案

## 背景

Icarus 已经有多条人类介入链路：

- Workflow interrupt：流程进入审批、补充输入、凭证确认、外部阻塞等状态后，等待用户恢复。
- Ask question：容器 agent 通过 IPC 向用户提出结构化问题，并等待回答。
- Feishu/Web 交互卡片：用户在移动端或工作台处理 approve、revise、skip、retry、continue 等动作。
- Assistant Inbox：个人助理主动发现问题后，提醒用户查看、忽略、稍后、排查或修复。

这些能力的方向是对的，但协议语义分散在多个模块中。每条链路都需要处理相似问题：谁能确认、在哪个渠道确认、确认什么动作、payload 怎么校验、重复提交怎么处理、状态变化后怎么办、风险如何展示、审计怎么记录。

本方案目标是把所有“需要人类确认或输入”的场景统一成一个标准协议：`HumanReviewRequest`。

## 当前相关实现

主要代码位置：

- `src/types.ts`
  - `WorkflowInterruptKind`
  - `WorkflowInterruptRecord`
  - `WorkflowInterruptResumeAttemptRecord`
- `src/db.ts`
  - `workflow_interrupts`
  - `workflow_interrupt_resume_attempts`
  - `ask_questions`
- `src/workflow.ts`
  - `createWorkflowInterrupt`
  - `resumeWorkflowInterrupt`
  - `handleCardAction`
- `src/ask-user-question.ts`
  - `createPendingAskQuestion`
  - `dispatchCurrentAskQuestion`
  - `handleAskQuestionResponse`
- `src/card-action-router.ts`
  - Workflow card action
  - Ask question card action
  - Assistant inbox broadcast card action
- `src/workbench-store.ts`
  - Workbench action item 和 timeline 同步
- `src/assistant/assistant-actions.ts`
  - Assistant inbox item action handling

当前 `resumeWorkflowInterrupt()` 已经具备很多关键能力：

- interrupt 是否存在。
- workflow 是否存在。
- interrupt 是否仍为 pending。
- workflow 是否已经终态。
- workflow 当前状态是否仍匹配 interrupt state。
- action 是否在允许列表。
- actor channel 是否允许。
- payload 是否符合 schema。
- idempotency key 去重。
- 重复提交、冲突提交、非法提交记录到 resume attempt。

这部分能力应保留，并抽象为通用确认协议的基础。

## 问题

### 1. 语义分散

`workflow_interrupts`、`ask_questions`、Assistant Inbox 都在表达“需要用户决策”，但每个模块都有自己的 action、payload、校验和状态记录方式。

结果是新增一个高风险能力时，容易重新写一套卡片按钮、handler、schema 校验和审计逻辑。

### 2. 风险表达不统一

当前审批主要表达“可选动作”，但没有统一表达：

- 风险等级。
- 影响资源。
- 是否不可逆。
- 为什么需要人工确认。
- 是否需要显式输入确认文本。
- 超时后默认行为。

这会影响主动助理的安全边界。

### 3. 跨渠道一致性成本高

同一个确认请求可能同时出现在 Web、Feishu、Assistant。每个渠道如果各自解释 action，容易出现状态分裂：

- 飞书已经批准，工作台仍显示待审批。
- 工作台已退回，移动端旧卡片仍能提交。
- Assistant 执行动作后，workflow interrupt 没有一致记录。

### 4. Ask question 和 workflow interrupt 没有统一

Ask question 更像“结构化输入”，workflow interrupt 更像“流程状态恢复”。两者底层都可以统一成人类确认请求：

- `provide_input`：请求用户补充信息。
- `approve_action`：请求用户批准操作。
- `revise_request`：请求用户给修改意见。
- `credential_confirm`：请求用户确认凭证或权限。

### 5. 高风险能力缺少统一闸门

自动修复、部署、数据库变更、重启服务等动作都应该走同一种高风险确认协议，而不是各模块自行判断。

## 目标

- 建立统一的 `HumanReviewRequest` 数据模型。
- 用同一套协议表达审批、输入、凭证确认、风险接受和外部等待。
- 保留当前 workflow interrupt 的幂等、冲突、schema 校验能力。
- 让 Web、Feishu、Assistant 使用同一份 request 渲染确认 UI。
- 让所有用户提交进入同一个 submit handler。
- 将风险等级、影响资源、证据、超时策略、渠道限制、actor 权限纳入协议。
- 让高风险自动化能力必须通过标准确认闸门。
- 确保确认过程可追踪、可恢复、可审计。

## 非目标

- 第一版不替换所有现有表。
- 第一版不重写 workflow engine。
- 第一版不改变普通群聊的基础消息处理链路。
- 第一版不做复杂 RBAC 系统，只做 channel、actor、risk、assigned target 的基础校验。
- 第一版不让 WeCom 员工私聊承担高风险审批入口。
- 第一版不实现独立审批中心产品，只在现有工作台、飞书和 Assistant 中复用。

## 总体设计

```text
Workflow / Assistant / IPC
  -> create HumanReviewRequest
  -> persist request
  -> render to Web / Feishu / Assistant
  -> user submits HumanReviewSubmission
  -> common validator
  -> common idempotency and conflict handling
  -> domain adapter applies result
  -> write events, timeline, trace, inbox/action status
```

核心原则：

- request 是事实源，卡片和 UI 只是渲染。
- submission 必须通过统一校验，不允许渠道 handler 直接执行高风险动作。
- domain adapter 只在确认被 accepted 后执行业务恢复逻辑。
- risk policy 决定哪些渠道能处理哪些动作。
- 所有状态变化必须写审计事件。

## 协议模型

### HumanReviewKind

```ts
export type HumanReviewKind =
  | 'approve_action'
  | 'revise_request'
  | 'provide_input'
  | 'credential_confirm'
  | 'risk_acceptance'
  | 'external_wait';
```

含义：

- `approve_action`：批准继续、执行、发布、修复等动作。
- `revise_request`：要求 agent 修改方案、代码、测试或文档。
- `provide_input`：用户补充结构化信息。
- `credential_confirm`：确认凭证、登录态、权限或外部系统访问。
- `risk_acceptance`：用户明确接受风险。
- `external_wait`：等待外部条件，用户可标记已完成或继续等待。

### RiskLevel

```ts
export type HumanReviewRiskLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';
```

风险定义：

| 风险 | 示例 | 默认渠道 |
| --- | --- | --- |
| low | 标记已读、继续只读调查、生成草稿 | Web, Feishu, Assistant |
| medium | 重试 agent、跳过非关键阶段、写入 Wiki 草稿 | Web, Feishu, Assistant |
| high | 修改代码、执行修复、触发 Jenkins、访问敏感日志 | Web 优先，Feishu 可跳转 |
| critical | 生产发布、删除数据、数据库写入、权限变更 | Web only，强确认 |

### HumanReviewRequest

```ts
export interface HumanReviewRequest {
  id: string;
  status: HumanReviewStatus;
  sourceType: HumanReviewSourceType;
  sourceRefId: string | null;

  workflowId?: string | null;
  taskId?: string | null;
  delegationId?: string | null;
  stageKey?: string | null;
  groupFolder?: string | null;
  chatJid?: string | null;

  kind: HumanReviewKind;
  title: string;
  body: string | null;

  risk: HumanReviewRisk;
  actions: HumanReviewAction[];
  inputSchema?: Record<string, unknown> | null;

  allowedChannels: HumanReviewActorChannel[];
  assignedTo?: HumanReviewAssignee | null;

  evidence: HumanReviewEvidence[];
  actionPayload?: Record<string, unknown> | null;

  defaultActionOnTimeout: 'expire' | 'reject' | 'continue' | 'none';
  expiresAt?: string | null;

  version: number;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | null;
  completedAt?: string | null;
}
```

### Supporting Types

```ts
export type HumanReviewStatus =
  | 'pending'
  | 'delivered'
  | 'viewed'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'conflict'
  | 'expired'
  | 'cancelled';

export type HumanReviewSourceType =
  | 'workflow_interrupt'
  | 'ask_question'
  | 'assistant_inbox'
  | 'ipc'
  | 'scheduled_task';

export type HumanReviewActorChannel =
  | 'web'
  | 'feishu'
  | 'assistant'
  | 'wecom'
  | 'system';

export interface HumanReviewRisk {
  level: HumanReviewRiskLevel;
  reasons: string[];
  affectedResources: string[];
  irreversible: boolean;
  requiresExplicitText?: string | null;
}

export interface HumanReviewAction {
  key: string;
  label: string;
  style?: 'primary' | 'default' | 'danger';
  payloadSchema?: Record<string, unknown> | null;
  requiresComment?: boolean;
}

export interface HumanReviewAssignee {
  role?: string;
  userId?: string;
  channel?: HumanReviewActorChannel;
}

export interface HumanReviewEvidence {
  type:
    | 'artifact'
    | 'trace'
    | 'diff'
    | 'log'
    | 'wiki'
    | 'message'
    | 'workbench_task'
    | 'delegation'
    | 'external';
  title: string;
  summary?: string | null;
  refId?: string | null;
  path?: string | null;
  url?: string | null;
}
```

### HumanReviewSubmission

```ts
export interface HumanReviewSubmission {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  actor: {
    channel: HumanReviewActorChannel;
    userId: string;
    displayName?: string;
  };
  clientRequestId: string;
  requestVersion: number;
  submittedAt: string;
}
```

`clientRequestId` 用于客户端侧幂等。`requestVersion` 用于发现旧卡片、旧页面和旧弹窗提交。

## 状态机

```text
pending
  -> delivered
  -> viewed
  -> submitted
  -> accepted

pending/delivered/viewed
  -> expired

pending/delivered/viewed
  -> cancelled

submitted
  -> rejected
  -> conflict
  -> accepted
```

说明：

- `pending`：已创建但还未确认发到任何渠道。
- `delivered`：至少一个渠道已经发送或展示。
- `viewed`：用户在 Web 或 Assistant 中打开过详情。
- `submitted`：收到提交，正在校验或执行 domain adapter。
- `accepted`：提交生效，业务侧已恢复或执行动作。
- `rejected`：提交不合法，例如 action 不允许、schema 错误、权限不足。
- `conflict`：请求已被其他人处理，或 workflow 状态已经变化。
- `expired`：超过 `expiresAt`。
- `cancelled`：上游 workflow/task 被取消。

第一版可以不显式使用 `submitted`，直接在事务里从 pending CAS 到 accepted/rejected/conflict。但 schema 保留该状态，方便后续异步执行。

## 数据库设计

第一版建议新增两张表，同时保留现有 `workflow_interrupts` 和 `ask_questions`。

### human_review_requests

```sql
CREATE TABLE IF NOT EXISTS human_review_requests (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref_id TEXT,

  workflow_id TEXT,
  task_id TEXT,
  delegation_id TEXT,
  stage_key TEXT,
  group_folder TEXT,
  chat_jid TEXT,

  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,

  risk_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  input_schema_json TEXT,
  allowed_channels_json TEXT NOT NULL,
  assigned_to_json TEXT,
  evidence_json TEXT,
  action_payload_json TEXT,

  default_action_on_timeout TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  submitted_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_human_review_requests_status
  ON human_review_requests(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_human_review_requests_workflow
  ON human_review_requests(workflow_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_human_review_requests_source
  ON human_review_requests(source_type, source_ref_id);
```

### human_review_submissions

```sql
CREATE TABLE IF NOT EXISTS human_review_submissions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT,
  client_request_id TEXT NOT NULL,
  request_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  conflict_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_human_review_submissions_client_request
  ON human_review_submissions(request_id, client_request_id);

CREATE INDEX IF NOT EXISTS idx_human_review_submissions_request
  ON human_review_submissions(request_id, created_at);
```

### 与现有表的关系

第一版采用适配方式：

```text
workflow_interrupts
  -> mirror/create human_review_requests(source_type='workflow_interrupt')
  -> submit human review
  -> accepted 后调用 resumeWorkflowInterrupt()

ask_questions
  -> mirror/create human_review_requests(source_type='ask_question')
  -> submit human review
  -> accepted 后写 ask-results 或 update ask_questions
```

后续稳定后可以反向收敛：

```text
workflow_interrupts 保留 workflow checkpoint 所需字段
ask_questions 变成 provide_input 类型 request 的兼容视图
```

## 模块设计

建议新增：

```text
src/human-review/
  types.ts
  risk-policy.ts
  schema.ts
  store.ts
  service.ts
  adapters/
    workflow-interrupt.ts
    ask-question.ts
    assistant-inbox.ts
  renderers/
    web.ts
    feishu-card.ts
    assistant.ts
  index.ts
```

### `types.ts`

定义 request、submission、risk、action、evidence、result 等类型。

### `risk-policy.ts`

职责：

- 根据 risk level 决定是否允许某渠道直接提交。
- 判断是否需要显式确认文本。
- 判断是否需要跳转工作台。
- 判断 Assistant 是否只能通知不能执行。

建议规则：

```text
low:
  - web, feishu, assistant 可直接提交

medium:
  - web, feishu, assistant 可直接提交
  - 如果 action.style=danger，Assistant 只能跳转

high:
  - web 可提交
  - feishu 默认只能打开工作台，除非 request 显式 allowMobileHighRisk=true
  - assistant 只能打开工作台或创建 investigation
  - wecom 不允许

critical:
  - web only
  - 必须 requiresExplicitText
  - 必须展示 evidence
  - 必须记录 actor 和 requestVersion
```

### `schema.ts`

职责：

- 复用或迁移 `workflow.ts` 中的 `validateJsonSchemaSubset`、`normalizeJsonSchemaPayload`。
- 支持 action-level payload schema。
- 支持 request-level input schema。
- 产出字段级错误，方便 Web/飞书表单渲染。

### `store.ts`

职责：

- create request。
- get/list request。
- mark delivered/viewed。
- record submission。
- CAS complete request。
- expire pending requests。

### `service.ts`

核心入口：

```ts
export function createHumanReviewRequest(input: CreateHumanReviewInput): HumanReviewRequest;

export function submitHumanReview(input: HumanReviewSubmission):
  | { ok: true; requestId: string; result: HumanReviewAcceptedResult }
  | { ok: false; requestId?: string; error: string; status: 'rejected' | 'conflict' };

export function expireHumanReviewRequests(now: string): number;
```

`submitHumanReview()` 校验顺序：

1. request 是否存在。
2. request 是否处于 pending/delivered/viewed。
3. requestVersion 是否匹配。
4. clientRequestId 是否重复。
5. actor channel 是否允许。
6. actor user 是否匹配 assignedTo。
7. risk policy 是否允许此渠道执行该 action。
8. action 是否在允许列表。
9. payload 是否符合 schema。
10. critical 风险是否满足 explicit text。
11. CAS 标记 request accepted/rejected/conflict。
12. 调用 domain adapter。
13. 写 submission、workflow event、workbench timeline、assistant action log。

如果 domain adapter 失败：

- 可恢复错误：request 标记 conflict 或保持 pending，并记录 rejected submission。
- 不可恢复错误：request 标记 conflict，并要求用户刷新。

第一版建议 adapter 在同一事务内只做状态恢复，不做外部副作用。外部副作用仍通过 workflow outbox 执行。

## Domain Adapters

### Workflow Interrupt Adapter

输入：

```text
source_type = workflow_interrupt
source_ref_id = workflow_interrupts.id
```

处理：

1. Human review submit 校验通过。
2. 调用 `resumeWorkflowInterrupt()`。
3. 传入 actor、action、payload、clientRequestId 作为 idempotency key。
4. 根据返回结果更新 human review request。

注意：

- 不复制 `resumeWorkflowInterrupt()` 的所有业务逻辑。
- 第一版保留 `resumeWorkflowInterrupt()` 作为 workflow 真正恢复入口。
- human review 层负责统一渠道、风险、显式确认和 UI 提交。

### Ask Question Adapter

输入：

```text
source_type = ask_question
source_ref_id = ask_questions.id
```

处理：

1. Human review submit 校验通过。
2. 将 payload 转换为 ask answer。
3. 调用或复用 `handleAskQuestionResponse()` 的校验逻辑。
4. 写 `ask-results/{requestId}.json`。
5. 更新 `ask_questions` 状态。

后续可以逐步让 ask question 直接创建 `provide_input` 类型 request，不再维护单独状态机。

### Assistant Inbox Adapter

适用场景：

- 用户批准自动排查。
- 用户批准准备修复。
- 用户确认忽略/稍后/完成高风险提醒。

处理：

- 低风险 action 可直接由 Assistant handler 处理。
- 中高风险 action 先创建 human review request。
- accepted 后再调用 `assistant-actions` 里的业务处理。

## 渠道渲染

### Web 工作台

Web 是完整确认入口。

展示内容：

- title/body。
- 风险等级、风险原因、影响资源。
- evidence 列表，支持打开 artifact、trace、diff、log。
- action buttons。
- schema 表单。
- explicit text 输入。
- 历史 submission。
- 冲突/过期状态。

新增 API 建议：

```text
GET  /api/human-reviews
GET  /api/human-reviews/:id
POST /api/human-reviews/:id/view
POST /api/human-reviews/:id/submit
```

Workbench action item 可以引用：

```json
{
  "source_type": "human_review_request",
  "source_ref_id": "hr_..."
}
```

### Feishu

Feishu 是轻量入口。

渲染规则：

- low/medium：展示摘要、风险、核心证据、按钮和简单表单。
- high：默认只展示“打开工作台处理”，除非 request 显式允许移动端高风险处理。
- critical：只展示“需要在工作台确认”。

卡片 action 统一使用：

```json
{
  "action": "human_review_submit",
  "request_id": "hr_...",
  "request_version": "1",
  "review_action": "approve",
  "client_request_id": "feishu:{message_id}:{action}:{user_id}"
}
```

### Assistant

Assistant 是主动提醒入口。

渲染规则：

- low：可直接处理。
- medium：可处理或打开工作台。
- high/critical：只允许打开工作台，或发起只读调查。

Assistant Inbox item 应引用 human review request：

```json
{
  "actionKind": "open_human_review",
  "sourceType": "human_review_request",
  "sourceRefId": "hr_..."
}
```

### WeCom

WeCom 员工私聊仅用于一对一信息收集。

允许：

- `provide_input`
- `external_wait`

禁止：

- `approve_action`
- `risk_acceptance`
- high/critical 风险提交。

## Card Action Router 改造

当前 `src/card-action-router.ts` 按 action 前缀分发到不同 handler。

改造后优先处理统一 action：

```ts
if (action.action === 'human_review_submit') {
  return handleHumanReviewCardAction(action);
}
```

旧 action 保留：

- `workflow_interrupt_resume`
- `ask_question_answer`
- `ask_question_skip`
- `assistant_inbox_*`

迁移期中，旧 action 可以在 handler 内创建或查找对应 human review request，再走 `submitHumanReview()`。

## Workflow Definition 改造

现有 interrupt state 可扩展 `human_review` 字段：

```json
{
  "type": "interrupt",
  "kind": "approval",
  "title": "是否批准进入开发阶段",
  "body": "...",
  "allowed_actions": ["approve", "revise", "skip"],
  "allowed_channels": ["web", "feishu", "assistant"],
  "human_review": {
    "kind": "approve_action",
    "risk": {
      "level": "medium",
      "reasons": ["进入开发后会修改服务代码"],
      "affectedResources": ["service:catstory"],
      "irreversible": false
    },
    "defaultActionOnTimeout": "expire",
    "evidence": [
      { "type": "artifact", "title": "需求方案", "pathTemplate": "{{context.plan_doc}}" }
    ]
  },
  "resume_payload_schema": {
    "schema": {
      "type": "object",
      "properties": {
        "comment": { "type": "string" }
      }
    }
  },
  "on_resume": {
    "approve": { "target": "dev" },
    "revise": { "target": "plan_revision" },
    "skip": { "target": "done" }
  }
}
```

如果没有 `human_review`，系统自动从现有 interrupt 字段生成默认 request：

- `kind` 根据 interrupt kind 映射。
- `risk.level` 默认为 `medium`。
- `allowedChannels` 使用 interrupt allowed channels。
- `actions` 使用 allowed actions。
- `inputSchema` 使用 resume payload schema。

## 风险策略

### Action 风险默认映射

| action | 默认风险 |
| --- | --- |
| view/open | low |
| continue | low |
| retry | medium |
| revise | medium |
| skip | medium |
| approve | medium |
| prepare_fix | medium |
| apply_fix | high |
| deploy | critical |
| delete | critical |
| adopt_branch | critical |

### 资源风险提升

如果 affected resources 包含以下内容，风险至少提升为 high：

- production。
- database write。
- credentials。
- permissions。
- deployment。
- host script。
- external notification。

如果 action 不可逆，风险至少为 high。

## 审计和 Trace

每次 request 创建：

- 写 `human_review_requests`。
- 写 `workflow_events` 或 assistant action log。
- 同步 workbench action item。

每次提交：

- 写 `human_review_submissions`。
- 写 request 状态变化。
- 写 `workflow_interrupt_resume_attempts`，如果来源是 workflow interrupt。
- 写 workbench timeline。
- 写 agent query event，如果 request 关联 queryId/delegationId。

建议事件名：

```text
human_review_created
human_review_delivered
human_review_viewed
human_review_submitted
human_review_accepted
human_review_rejected
human_review_conflict
human_review_expired
human_review_cancelled
```

## 幂等和冲突

幂等维度：

- request id。
- client request id。
- request version。
- actor。
- action。
- canonical payload。

处理规则：

- 同一 `clientRequestId` 重复提交：返回第一次结果。
- request 已 accepted，且 actor/action/payload 完全一致：返回 duplicate success。
- request 已 accepted，但 actor/action/payload 不同：conflict。
- requestVersion 低于当前版本：conflict，提示刷新。
- workflow 状态已变化：conflict。
- request expired/cancelled：rejected 或 conflict，视 UI 需要。

## 超时处理

新增 watchdog：

```text
每 15s 或 60s 扫描 pending/delivered/viewed 且 expires_at < now 的 request
  -> 根据 defaultActionOnTimeout 处理
```

策略：

- `expire`：标记 expired，关闭 workbench action item。
- `reject`：记录 system submission，action=reject。
- `continue`：只允许 low 风险，记录 system submission，action=continue。
- `none`：不处理，仅保留 pending。

第一版建议只实现 `expire` 和 `none`。`reject/continue` 后续再打开。

## API 和 IPC

### Web API

```text
GET /api/human-reviews?status=pending
GET /api/human-reviews/:id
POST /api/human-reviews/:id/view
POST /api/human-reviews/:id/submit
```

提交 payload：

```json
{
  "action": "approve",
  "payload": {
    "comment": "同意进入开发"
  },
  "clientRequestId": "web:uuid",
  "requestVersion": 1
}
```

### IPC / MCP

容器 agent 不应直接执行高风险操作。它可以请求创建 human review：

```json
{
  "type": "human_review_create",
  "kind": "provide_input",
  "title": "需要确认服务分支",
  "body": "请确认本次修复应基于哪个分支。",
  "risk": {
    "level": "low",
    "reasons": ["需要用户补充分支信息"],
    "affectedResources": ["service:catstory"],
    "irreversible": false
  },
  "actions": [
    {
      "key": "submit",
      "label": "提交",
      "payloadSchema": {
        "type": "object",
        "required": ["branch"],
        "properties": {
          "branch": { "type": "string", "minLength": 1 }
        }
      }
    }
  ]
}
```

宿主机校验后创建 request，并返回 request id。容器通过 ask-result 或 follow-up message 接收结果。

## 迁移计划

### Phase 1：协议和存储

新增：

- `src/human-review/types.ts`
- `src/human-review/store.ts`
- `src/human-review/schema.ts`
- `src/human-review/risk-policy.ts`
- `src/human-review/service.ts`

修改：

- `src/db.ts` 增加 `human_review_requests` 和 `human_review_submissions`。
- `src/types.ts` 导出 human review 类型。

验收：

- 可创建 request。
- 可提交 request。
- 可记录 submission。
- 可处理重复 clientRequestId。
- 可处理 expired/cancelled 状态。

### Phase 2：Workflow Interrupt 适配

新增：

- `src/human-review/adapters/workflow-interrupt.ts`

修改：

- `src/workflow.ts` 创建 interrupt 时同步创建 human review request。
- `src/card-action-router.ts` 支持 `human_review_submit`。
- Workflow card renderer 优先使用 human review renderer。

验收：

- 原有 workflow interrupt 流程行为不变。
- Web/Feishu 通过 human review action 可以恢复 workflow。
- 旧卡片 action 仍兼容。
- 重复提交、冲突提交测试通过。

### Phase 3：Ask Question 适配

新增：

- `src/human-review/adapters/ask-question.ts`

修改：

- `src/ask-user-question.ts` 创建 ask question 时同步创建 `provide_input` request。
- Ask card 使用 human review renderer。
- 旧 `/answer` 文本回复继续兼容。

验收：

- 单选、多选、表单输入都能提交。
- schema 错误能返回字段错误。
- 过期问题能同步关闭 request。

### Phase 4：Assistant 适配

新增：

- `src/human-review/adapters/assistant-inbox.ts`

修改：

- `src/assistant/assistant-actions.ts` 高风险 action 创建 request。
- Assistant Inbox item 支持打开 human review。

验收：

- 低风险 Assistant action 不受影响。
- 高风险 action 不能直接执行。
- critical action 必须 Web 显式确认。

### Phase 5：统一 UI 和清理旧路径

修改：

- Web 工作台增加 Human Review 面板。
- Workbench action item 引用 human review request。
- Feishu/Assistant 卡片统一 renderer。
- 逐步减少 workflow/ask 各自的卡片 action 分支。

验收：

- 用户在任一渠道处理后，其他渠道能看到一致状态。
- 工作台 timeline 能看到完整确认过程。
- Trace 能关联 request/submission。

## 测试计划

### 单元测试

新增：

- `src/human-review/schema.test.ts`
- `src/human-review/risk-policy.test.ts`
- `src/human-review/service.test.ts`
- `src/human-review/adapters/workflow-interrupt.test.ts`
- `src/human-review/adapters/ask-question.test.ts`

覆盖：

- action allowlist。
- channel allowlist。
- assigned actor。
- schema normalize/validate。
- explicit confirmation text。
- duplicate clientRequestId。
- accepted duplicate。
- conflict payload。
- requestVersion stale。
- expired request。

### 集成测试

扩展：

- `src/workflow.test.ts`
- `src/card-action-router.test.ts`
- `src/assistant/assistant-inbox-broadcast-actions.test.ts`

覆盖：

- workflow interrupt 创建 human review。
- human review submit 后 workflow transition。
- Feishu card submit 到 human review。
- Web submit 到 human review。
- Assistant 高风险 action 转工作台确认。

### 回归测试

必须保证：

- 旧 workflow interrupt action 仍可用。
- 旧 ask question card 仍可用。
- `/answer requestId ...` 文本回复仍可用。
- 已有 workflow outbox 行为不变。

## 验收标准

第一版完成标准：

- 所有 workflow interrupt 都能生成 human review request。
- human review request 可在 Web 和 Feishu 至少两个渠道提交。
- submit handler 统一处理 action、channel、schema、risk、idempotency。
- accepted submission 能恢复 workflow。
- duplicate/conflict/rejected 都有记录。
- workbench timeline 能看到 created/submitted/accepted。
- 高风险 request 在 Feishu/Assistant 默认不能直接执行。
- 单元和集成测试覆盖核心状态。

## 风险和应对

### 风险：改动面过大

应对：

- 第一版只做兼容适配，不删除 `workflow_interrupts` 和 `ask_questions`。
- 旧 action 保留。
- 新协议从 workflow interrupt 开始接入。

### 风险：状态双写不一致

应对：

- workflow interrupt 仍是 workflow 恢复的事实源。
- human review request 是用户确认的事实源。
- accepted 后立即调用 `resumeWorkflowInterrupt()`。
- 如果 adapter 失败，request 标记 conflict 或保持 pending，并写 submission result。

### 风险：UI 复杂度上升

应对：

- Web 第一版只做通用详情页和通用提交表单。
- Feishu 第一版只渲染简单按钮和表单。
- Assistant 第一版只做跳转和低风险 action。

### 风险：高风险策略误伤效率

应对：

- risk policy 支持按 request 显式降低或提高风险，但必须记录 reason。
- 先保守默认，后续根据使用数据调整。

## 后续增强

- 对接 OpenTelemetry，将 human review 生命周期写入 trace span/event。
- 为 request 增加 SLA、reminder 和 escalation。
- 为 high/critical 增加二人确认或延迟生效。
- 为 schema 表单生成更丰富的 Web UI。
- 为移动端卡片增加字段级校验反馈。
- 将 MCP elicitation 映射到 `provide_input` 类型 request。
- 将 approval 数据用于评估 Agent 风险判断质量。

## 参考资料

- Model Context Protocol Elicitation: https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
- OpenAI Agents Human-in-the-loop: https://openai.github.io/openai-agents-python/human_in_the_loop/
- Anthropic Building Effective Agents: https://www.anthropic.com/engineering/building-effective-agents
