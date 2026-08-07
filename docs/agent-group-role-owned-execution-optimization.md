# Agent Group 角色自治执行模型优化方案

## 文档状态

- 状态：Implemented
- 日期：2026-08-06
- 最后更新：2026-08-06
- 适用范围：Agent Group Collaboration Runtime 的身份、角色、FSM、Action、Turn、人工执行、交接和 Web 工作台
- 基线：[Icarus Agent Group Collaboration Runtime 方案](agent-group-collaboration-runtime-plan.md)
- 兼容策略：当前没有已创建群组，不迁移旧群组，不保留 v1 群组协议兼容层

## 实施记录与实际差异

2026-08-06 已按 Phase 1-7 完成协议 v2、系统身份、Role-owned State
Implementation、Manual/Handoff、Artifact、Assisted/Automatic Executor、通知、Web API
和响应式工作台，并补齐双 deadline、超时提醒、Turn 审计链与 JSON 导出。实现入口位于 `src/collaboration/`、`electron/renderer/app.js` 和
`electron/renderer/collaboration-*.js`。

实际实现与方案文字有以下收敛差异：

- `result_schema` 物化在可选 Action 上。Assisted/Automatic 的 Executor result 和最终
  Handoff `data` 都按该 schema 校验；Manual 没有 Action，因此只应用 Handoff 的严格
  Envelope、类型和 1 MiB 数据上限。
- Turn 直接保存完整 incoming Handoff 及 canonical hash，而不是再增加只包含路径的
  `incoming_handoff_ref`；同时固定 `machine_hash`、Implementation/Action/Prompt hash、
  `created_at`、principal+agent claimant、attempt 和 fencing token。
- Executor 返回的 provider-local `artifacts[]` 只作为本地 Observation 证据，不会被远端
  文本自动提升为可信 Git Artifact。共享 Artifact 必须经过受控 staged upload、bytes/hash/size
  校验，并与 Completion 同 commit；Automatic Completion 当前不自动发布 provider-local 文件。
- 本地 SQLite 当前 schema 为 v4。因为没有历史群组或 receipt，fresh/v4 之外的 schema
  一律 fail closed，不实现 v1-v3 数据迁移或双模型兼容。
- Web 工作台显示当前与历史 Turn、创建时间/等待时长、完整 incoming Handoff refs、合法
  Outcome 路由预览和 staged Artifact；桌面 1440px 与移动 390px 已完成无溢出检查。
- `turn_created` 固定 start deadline，`turn_started` 固定 execution deadline；两者进入签名
  payload、Turn snapshot 和 input hash。共享 lifecycle/timeout 事实来自 Git sequence 和
  `occurred_at`，Provider/通知观测与重复提醒去重留在本地 SQLite。
- 超时第一阶段只做 `notify_only`；共享 observation 按 turn+attempt+deadline kind 幂等，
  本地提醒覆盖 Role Owner/claimant 与 creator。审计 API/UI 聚合签名事件和脱敏本地证据，
  不导出凭据、本地路径或私有 Provider metadata。
- 没有单独增加 timeout schedule 或 audit evidence 表；reminder schedule/ordinal 归入
  `collaboration_notification_deliveries`，审计器从 event cache、Turn Projection、execution、
  notification 和 integrity incident 组合本地 evidence，避免不可重建数据的第二套事实模型。
- 创建体验已从逐个 State 表单替换为图形 FSM 编辑器。新草稿只有一个可配置的 initial
  State；用户从节点上的“添加执行结果”进入 Outcome-first 流程，先选择预设或自定义
  Outcome，再新建下一节点、连接已有节点、自环或进入 terminal。常用结果只填充输入，
  协议仍允许任意合法 Outcome ID。
- State 画布支持自由布局和角色泳道、自动整理、缩放/适配、选中定位、拖动节点、撤销/重做，
  并在右侧 inspector 编辑名称、稳定 ID、描述、`owner_role`、terminal、timeout policy 和
  Outcome。删除或改变连线、删除 State、转换 terminal 都会先显示受影响连线并确认。
- `machine_revised` 只允许 creator 在 `FORMING`/`PAUSED` 发布，并使业务 epoch 前进；
  `machine_layout_updated` 只物化 creator-owned `layout.yaml`，不改变 Machine canonical hash、
  Turn snapshot 或 epoch。`RUNNING`/`CLOSING`/`CLOSED` 复用只读图，突出当前 State、历史路径、
  terminal 和超时节点。
- 图模型提供实时及发布前校验，覆盖 initial、owner、Outcome 唯一性、terminal 出边、未知
  target/role、不可达 State、可达 terminal 和 timeout policy。没有 terminal 的纯循环是需要
  显式确认的 warning，不会被硬编码成非法 FSM。

## 摘要

当前 Agent Group 模型由创建者一次性定义角色、FSM、Transition、Action 和 Prompt。Transition 同时承担“选择执行者”“选择执行逻辑”和“决定执行结果流向”三种职责，导致创建者必须理解并配置其他参与者的本地工作方式，也导致 Action、Executor Binding、Prompt 和状态流转的所有权边界不清晰。

本方案将群组协议调整为两层：

1. **创建者拥有工作流骨架**：定义角色、State、每个 State 的责任角色、允许的 Outcome 和目标 State。
2. **角色所有者拥有执行实现**：角色认领者为自己负责的 State 声明人工、辅助或自动执行模式，并可选择发布 Action、Prompt 和 Executor 要求。

Action 不再是每个 State 的必需字段。没有 Action 的 State 是合法的人工节点；角色成员收到通知后确认开始，执行完成后选择当前 State 允许的 Outcome，填写摘要和交接说明，并上传产物。存在 Action 时，可以由用户确认后调用 Agent，也可以按角色所有者声明自动执行。

核心关系调整为：

```text
创建者定义：State -> owner_role -> allowed outcomes -> target State
角色所有者定义：State -> execution mode -> optional Action
运行时负责：Turn、通知、抢占、执行、交接、文件、校验和状态推进
```

## 1. 优化目标

### 1.1 产品目标

- 创建者只规定协作流程、责任边界和合法流向，不替其他角色编写实际执行 Prompt。
- 每个角色只能定义自己已认领角色对应 State 的执行逻辑。
- 创建者如果也认领了角色，只能为该角色负责的 State 定义 Action。
- Action 和本地 Executor Binding 都不是人工节点的启动前置条件。
- 同一套协议同时支持人工执行、Agent 辅助执行和 Agent 自动执行。
- 上一个 State 可以向下一个 State 提交结构化交接命令、数据和产物。
- 角色成员只能选择创建者允许的 Outcome，不能直接跳转到任意 State。
- 所有跨实例共享决策继续通过 Git 签名事件审计，本地路径、凭据和 Provider 连接继续留在本机。

### 1.2 工程目标

- 分离 Creator-owned Workflow Skeleton 与 Role-owned State Implementation。
- 将 Transition 收缩为纯路由边，去掉 `actor_role` 和 `action_ref`。
- 将一次 State 执行统一建模为 Turn，不以 Action 是否存在决定 Turn 是否成立。
- 对人工和自动完成使用同一个结果、Outcome、Handoff 和 Artifact 协议。
- Turn 创建时固定 FSM、角色执行清单、Action、Prompt 和输入上下文哈希。
- 防止运行期间修改 Prompt 或 Action 导致同一幂等键执行不同任务。
- 将 Executor Binding 从单纯按 Role 保存调整为按具体 State Implementation/Action 保存。

### 1.3 非目标

- 不把 Agent Group 改造成中心化多租户服务。
- 不允许角色所有者修改创建者定义的 State 拓扑或目标 State。
- 不允许上一节点的交接文本覆盖系统指令、权限策略或 Executor 安全上限。
- 不在本阶段实现多人共同编辑同一个角色 Action 的投票或合并协议。
- 不在本阶段为大文件引入 Git LFS 或外部对象存储。
- 不让第三方 Agent 绕过 Icarus 直接写协议事件。

## 2. 当前模型的问题

### 2.1 创建者承担了不属于自己的执行设计

当前创建者必须在群组初始化时定义所有 Action、Executor 类型和 Prompt，包括尚未加入群组的其他角色。这与“每个用户拥有自己的本地 Agent 和工作方式”的协作目标冲突。

### 2.2 Transition 混合了三类概念

当前 Transition 包含：

```yaml
actor_role: developer
action_ref: actions/implement.yaml
outcomes:
  succeeded: review
  failed: development
```

它同时表达：

- 谁执行；
- 执行什么；
- 执行后去哪里。

因此一个 State 存在多个 Transition 时，运行时无法仅根据当前状态知道先执行哪个 Action。当前实现只能在单 Transition 时自动选择，多 Transition 时由创建者手工选择。

### 2.3 Action 和 Executor Binding 的边界不清晰

Action 已经固定 `kind/adapter`，但本地角色设置仍允许重新选择 `run_once/workflow/codex-task`。选错不会在配置时失败，而会在 Turn 执行时因为 Binding 与 Action 不匹配而阻塞。

当前 Binding 以 `(group_id, role)` 为键，同一角色如果负责不同 Executor 类型的 Action，无法为每个 Action 配置不同本地实现。

### 2.4 Prompt 没有形成交接链

当前 Action Prompt 是创建者写入 Git 的静态执行指令。上一 Turn 的执行结果只以结果哈希和产物引用参与事件，不会自动进入下一 Turn 的 Prompt。

当前本地 `Prompt override` 还可以替换共享 Prompt，但替换内容没有进入 Turn 的输入哈希，破坏了幂等身份与实际执行内容的一致性。

### 2.5 强制 Action 排除了人工协作

当前非终态 State 必须引用 Action，本地角色必须配置 Executor。实际协作中存在大量无需 Agent 的节点，例如人工讨论、线下验证、外部审批、设计确认或手工操作。这些节点仍然需要通知、认领、开始、完成、产物和审计，而不应该伪造一个 Action。

### 2.6 Role 字段部分没有形成真实运行约束

- `min/max` 已经分别参与 READY 判定和认领上限，语义明确。
- `capability` 当前是成员自声明的资格标签，不是受证明的安全能力。
- `interaction` 只进入协议元数据，没有实际约束 Executor 行为。

优化后应保留有效字段，移除或重定义未生效字段。

## 3. 核心设计原则

### 3.1 创建者拥有拓扑，角色所有者拥有实现

创建者可以定义：

- 群组名称和生命周期策略；
- 角色列表和人数约束；
- State 列表和初始 State；
- 每个 State 的 `owner_role`；
- 每个 State 允许提交的 Outcome；
- 每个 Outcome 对应的目标 State；
- 终态和必要的群组级安全限制。

创建者不能为未认领角色发布或修改 State Implementation、Action 和 Prompt。

角色所有者可以定义：

- 自己角色负责的 State 使用 `manual`、`assisted` 或 `automatic`；
- 可选 Action 的 Executor 类型；
- Action Prompt；
- Workflow Ref；
- 输入和结果 schema；
- 本地 Executor Binding 和权限上限。

角色所有者不能修改：

- State 的责任角色；
- 可用 Outcome 名称；
- Outcome 对应的目标 State；
- 其他角色的 State Implementation；
- 群组生命周期命令。

### 3.2 State 表示责任阶段，Transition 只表示合法流向

新模型中，State 不再通过 Transition 选择待执行 Action。进入 State 后只创建一个属于 `owner_role` 的 Turn；该 Turn 的执行方式由角色所有者的 State Implementation 决定。

执行完成时，完成者从当前 State 允许的 Outcome 中选择一个。Reducer 根据 Outcome 确定目标 State。

```text
State entered
  -> resolve owner role implementation
  -> create Turn
  -> execute manually or through optional Action
  -> submit allowed Outcome
  -> reducer resolves target State
```

### 3.3 Action 是可选实现，不是流程存在的前提

- `manual`：没有 Action，用户手工开始和完成。
- `assisted`：有 Action，用户确认开始后启动 Executor，Executor 结果由用户确认后完成 Turn。
- `automatic`：有 Action，运行时自动认领、分发和完成 Turn。

人工节点和自动节点必须生成相同结构的 Completion Result，保证下游只依赖协议结果，不依赖执行来源。

### 3.4 Handoff 是结构化输入，不是高权限 Prompt

上一 State 可以提交面向下一 State 的 `instruction`，但运行时必须把它标记为上一执行者提供的不可信上下文。它不能覆盖：

- Icarus 系统指令；
- 角色所有者定义的 Action Prompt；
- 本地权限上限；
- 审批策略；
- Workspace 边界；
- Creator-owned FSM。

### 3.5 运行时固定执行快照

每个 Turn 创建时固定：

- group epoch；
- machine hash；
- State ID 和 Role ID；
- State Implementation hash；
- Action hash，可为空；
- Prompt hash，可为空；
- incoming handoff hash，可为空；
- data/artifact refs；
- attempt 和 fencing token。

同一个 Turn 的执行内容不能因运行期间文件更新或本地 Prompt override 改变。

## 4. 所有权模型

| 对象                     | 创建者                | State 对应角色所有者  | 普通成员 | 本地运行时           |
| ------------------------ | --------------------- | --------------------- | -------- | -------------------- |
| Group Definition         | 创建、版本升级        | 只读                  | 只读     | 校验                 |
| Role Definition          | 创建、暂停后调整      | 只读                  | 只读     | 校验人数和能力       |
| Machine/State/Outcome    | 创建、暂停后升级      | 只读                  | 只读     | 确定性归约           |
| State Implementation     | 仅限自己认领的角色    | 创建、修改、撤回      | 否       | 校验归属和版本       |
| Action/Prompt            | 仅限自己认领的角色    | 创建、修改、撤回      | 否       | 固定哈希并执行       |
| Local Executor Binding   | 仅限本机自己的 Action | 仅限本机自己的 Action | 否       | 本地保存             |
| Turn Start               | 持有对应角色时        | 是                    | 否       | CAS、fencing         |
| Turn Completion          | 当前 Turn claimant    | 当前 Turn claimant    | 否       | 校验 Outcome 和结果  |
| Artifact Upload          | 当前 Turn claimant    | 当前 Turn claimant    | 否       | 路径和哈希校验       |
| Start/Pause/Resume/Close | 是                    | 否                    | 否       | 执行生命周期命令     |
| Stalled Turn Recovery    | 是                    | 否                    | 否       | 生成新 attempt/fence |

## 5. 协议模型

### 5.1 Group Definition

```yaml
format: icarus.agent-group/2
protocol_version: 2
group_id: ag_example
name: Example Group
creator:
  principal_id: principal_sha256_xxx
  signing_key_ref: ssh-ed25519:SHA256:xxx
control_branch: refs/heads/icarus/control
machine_ref: machine.yaml
required_roles:
  - role: developer
    min_members: 1
    max_members: 1
  - role: reviewer
    min_members: 1
    max_members: 1
lifecycle_policy:
  active_turn_pause: drain
  stalled_turn_recovery: creator_command
```

当前没有旧群组，协议直接升级为 v2；Runtime 对其他协议版本 fail closed，不实现 v1 到 v2 的 Git 历史迁移。

### 5.2 系统身份

创建和加入群组不再要求用户填写 `principal_id` 和 `agent_id`。

- `principal_id` 由 SSH 签名公钥指纹稳定派生。
- `agent_id` 在本机首次使用时生成 `agent_<uuid>` 并持久化到 Collaboration store directory。
- API 拒绝客户端传入 `principalId/agentId`，避免调用方误以为可以覆盖本机身份。
- `signingKeyPath` 本阶段仍由用户提供。

身份生成由独立的 Collaboration Identity Service 负责，Group Service 只消费已经解析和校验的本地身份。

### 5.3 Role Definition

```yaml
format: icarus.agent-group-role/2
role: developer
display_name: Developer
cardinality:
  min: 1
  max: 1
required_capabilities:
  - coding_task
owned_states:
  - development
```

字段语义：

- `required_capabilities` 是角色资格匹配标签。v2 仍然是成员签名自声明，不将其描述为强安全证明。
- `min` 决定群组何时具备形成条件。
- `max` 决定角色认领上限。
- `owned_states` 必须与 Machine 中所有引用该 Role 的 State 完全一致。
- 删除 Role 级 `interaction`；交互方式由每个 State Implementation 的 execution mode 表达。

#### 多人角色约束

v2 第一阶段要求所有拥有非终态 State 的 Role 使用 `max: 1`。原因是 Action、Prompt 和 State Implementation 需要一个明确的签名所有者。

未来如果需要一个 Role 多人执行，应新增独立的 `implementation_owner` 和 worker claims，不能默认允许多个 claimant 共同覆盖同一个 Action 文件。

### 5.4 Machine Definition

```yaml
format: icarus.agent-group-machine/2
initial_state: development
states:
  development:
    label: Development
    owner_role: developer
    terminal: false
    timeout_policy:
      start_timeout_ms: 86400000
      execution_timeout_ms: 259200000
      reminder_interval_ms: 21600000
      on_timeout: notify_only
    transitions:
      - outcome: ready_for_review
        target_state: review
      - outcome: needs_retry
        target_state: development
      - outcome: blocked
        target_state: waiting

  review:
    label: Review
    owner_role: reviewer
    terminal: false
    timeout_policy:
      start_timeout_ms: 43200000
      execution_timeout_ms: 86400000
      reminder_interval_ms: 14400000
      on_timeout: notify_only
    transitions:
      - outcome: approved
        target_state: completed
      - outcome: changes_requested
        target_state: development
      - outcome: blocked
        target_state: waiting

  waiting:
    label: Waiting
    owner_role: developer
    terminal: false
    transitions:
      - outcome: resumed
        target_state: development

  completed:
    label: Completed
    terminal: true
    transitions: []
```

约束：

- 非终态 State 必须有 `owner_role`。
- 终态不能有 `owner_role` 或 outgoing Transition。
- Transition ID 不再承担 Action identity；Outcome 在当前 State 内唯一即可。
- `target_state` 必须存在。
- Runtime 不能接受 Completion 中任意指定的 State，只接受当前 State 中定义的 Outcome。
- 循环继续合法，例如 `development -> review -> development`。
- `timeout_policy` 由创建者定义并在 Turn 创建时固定；各时限使用正整数毫秒，`null` 或省略表示不启用对应超时。
- `start_timeout_ms` 从 `turn_created` 的规范时间开始计算，`execution_timeout_ms` 从成功的 `turn_started` 开始计算。
- `reminder_interval_ms` 控制首次超时后的重复提醒；第一阶段 `on_timeout` 只允许 `notify_only`，不得自动完成、取消或选择 Outcome。
- 终态不能声明 `timeout_policy`；修改时限与修改 Machine 一样，只能在允许升级 Machine 的生命周期阶段生效。

### 5.5 Role-owned State Implementation

角色认领者必须为自己负责的每个非终态 State 发布一个执行清单。即使选择人工执行，也要显式声明，避免“尚未配置”和“有意人工执行”无法区分。

人工执行示例：

```yaml
format: icarus.agent-group-state-implementation/2
role: reviewer
state_id: review
owner:
  principal_id: principal_sha256_reviewer
  agent_id: agent_xxx
mode: manual
action_ref: null
published_at_event: evt_xxx
```

辅助执行示例：

```yaml
format: icarus.agent-group-state-implementation/2
role: developer
state_id: development
owner:
  principal_id: principal_sha256_developer
  agent_id: agent_xxx
mode: assisted
action_ref: actions/developer/development/implement.yaml
published_at_event: evt_xxx
```

自动执行示例只需将 `mode` 改为 `automatic`。

授权规则：

- 发布者必须持有 `state.owner_role`。
- `role/state_id/owner` 不能由文件内容越权声明，必须与签名事件 Actor 和 Projection 一致。
- 创建者只有在自己持有对应 Role 时才能发布该 State 的 Implementation。
- Implementation 只能在 `FORMING` 或 `PAUSED` 修改。
- Role 释放后，旧 Implementation 保留审计记录但不再 active；新角色所有者必须显式采用或发布新版本。

### 5.6 Optional Action Definition

```yaml
format: icarus.agent-group-action/2
action_id: implement
role: developer
state_id: development
kind: external
adapter: codex-task
input:
  prompt_ref: prompts/developer/development/implement.md
requirements:
  filesystem_access: workspace_write
result_schema:
  ref: collaboration-state-result@2
```

约束：

- `manual` Implementation 必须使用 `action_ref: null`。
- `assisted/automatic` Implementation 必须引用 Action。
- Action 的 `role/state_id` 必须与 Implementation 一致。
- Role Owner 定义 `kind/adapter`，本地 Binding 不能覆盖，只能提供具体运行参数。
- `workflow` Action 必须提供 `workflow_ref`；其他 Action 禁止提供。
- 删除本地 `Prompt override`。需要修改 Prompt 时发布新 Action/Prompt 版本。

Workflow Action 示例：

```yaml
kind: workflow
input:
  workflow_ref: code_review_workflow_v1
  prompt_ref: prompts/reviewer/review/workflow.md
```

`workflow_ref` 是本地 Workflow launch profile 的逻辑引用，不是文件路径。Role Owner 的本地 Binding 必须解析到匹配该 ref 和 Prompt hash 的 launch profile。

### 5.7 Prompt 和最终执行输入

Action Prompt 是 Role Owner 定义的静态执行规则，例如：

```markdown
检查当前交付是否满足需求和测试标准。
输出一个允许的 review outcome，并提供具体修改意见。
```

运行时构造的最终输入由四层组成：

```text
1. Icarus 固定系统安全指令
2. Creator-owned State/Outcome 约束
3. Role-owned Action Prompt
4. Previous Turn Handoff、Data 和 Artifact 上下文（不可信数据）
```

对于 `manual` 节点，工作台展示第 2 层和第 4 层，不需要生成 Agent Prompt。

## 6. Turn 模型

### 6.1 Turn 数据

```text
turn_id
group_id
epoch
state_id
role
mode                         manual | assisted | automatic
implementation_ref
implementation_hash
action_ref                   nullable
action_hash                  nullable
prompt_hash                  nullable
incoming_handoff_ref         nullable
incoming_handoff_hash        nullable
timeout_policy_snapshot      nullable
attempt
idempotency_key
state
created_at
start_deadline_at            nullable
claimant_principal_id        nullable
claimant_agent_id            nullable
claim_event_id               nullable
fencing_token                nullable
started_at                   nullable
execution_deadline_at        nullable
execution_ref                nullable
dispatch_accepted_at         nullable
provider_completed_at        nullable
awaiting_confirmation_at     nullable
completed_at                 nullable
state_advanced_at            nullable
cancelled_at                 nullable
recovery_requested_at        nullable
recovered_at                 nullable
timeout_observations[]
completion_result_hash       nullable
artifact_refs[]
```

与 v1 不同，Turn 必须同时保存 claimant principal 和 agent，后续完成事件不能只按 Principal 判断所有权。

所有协议时间使用 UTC RFC 3339 毫秒精度。`created_at`、`started_at`、人工确认和各终止时间来自对应签名事件的 `occurred_at`；Executor 的 dispatch accepted、Provider completed 和通知首次发现等本地观测留在 SQLite，并通过 Turn、attempt 和 execution ref 关联。Projection 按协议 `sequence` 还原权威顺序，不以跨机器 wall clock 排序或决定 reducer 结果。

Projection 从原始事件派生待开始、执行阶段和节点总耗时。若签名 Actor 的时钟偏差导致时间倒序，duration 标记为 `unreliable` 并保留 clock-skew 诊断，不通过取绝对值改变事实，也不影响 FSM 归约。

### 6.2 Turn 状态

```text
PENDING_START
  -> IN_PROGRESS             manual
  -> DISPATCHING             assisted/automatic
  -> RUNNING                 executor accepted
  -> WAITING_INPUT
  -> WAITING_APPROVAL
  -> AWAITING_CONFIRMATION    assisted executor terminal
  -> COMPLETED
  -> CANCELLED
  -> RECOVERY_REQUIRED
```

状态含义：

| 状态                    | 含义                                                    |
| ----------------------- | ------------------------------------------------------- |
| `PENDING_START`         | State 已进入，等待符合角色的用户开始或自动调度          |
| `IN_PROGRESS`           | 人工节点已确认开始                                      |
| `DISPATCHING`           | 已获得 claim，正在调用 Executor                         |
| `RUNNING`               | Executor 已接受并持有 durable receipt                   |
| `WAITING_INPUT`         | Executor 等待角色成员输入                               |
| `WAITING_APPROVAL`      | Executor 等待角色成员审批                               |
| `AWAITING_CONFIRMATION` | assisted Action 已返回，等待用户确认 Outcome 和交接内容 |
| `COMPLETED`             | Completion 已验证，业务 State 已推进                    |
| `CANCELLED`             | 当前 attempt 已取消                                     |
| `RECOVERY_REQUIRED`     | 无法安全判断外部执行状态，需要创建者恢复                |

### 6.3 Turn 创建

创建者的 Icarus 在群组处于 `RUNNING`、不存在活动 Turn 且当前 State 非终态时创建 Turn：

1. 读取当前 State 和 `owner_role`。
2. 读取 active State Implementation。
3. 固定 Implementation/Action/Prompt/Handoff hash 和 State timeout policy。
4. 写入 `created_at`；配置了 `start_timeout_ms` 时同时写入不可变的 `start_deadline_at`。
5. 根据 mode 创建 `PENDING_START` Turn。
6. 推送签名 `turn_created` 事件。

如果 State Implementation 缺失，群组不能进入 READY，因此 RUNNING 中不应出现无法解析执行方式的 State。

成功的 `turn_started` 必须在同一个签名事件中写入 `started_at`；配置了 `execution_timeout_ms` 时，同时写入不可变的 `execution_deadline_at = started_at + execution_timeout_ms`。两个 deadline 都进入签名 payload、Turn snapshot 和 input hash，运行期间修改 State policy 不影响已有 Turn。恢复产生新 attempt 时保留旧 attempt 时间线，并为新 attempt 重新固定适用 deadline。

## 7. 人工、辅助和自动执行

### 7.1 Manual

1. 本地 Icarus 同步到 `PENDING_START` Turn。
2. 如果本机身份持有 Turn Role，产生一次本地通知。
3. 用户打开群组并点击“确认开始”。
4. Runtime 使用 Git CAS 提交 `turn_started`，同时设置 claimant 和 fencing token。
5. 用户在线下或外部系统完成工作。
6. 用户点击“确认完成”，选择 Outcome、填写摘要和 Handoff、上传文件。
7. Runtime 校验 Completion 并原子推进业务 State。

### 7.2 Assisted

1. 用户点击“确认开始”并获得 Turn claim。
2. Runtime 检查本地 Action Binding 和权限上限。
3. Runtime dispatch Executor 并保存 durable receipt。
4. Executor 完成后进入 `AWAITING_CONFIRMATION`，不立即推进 FSM。
5. 用户查看 Executor 结果，编辑摘要/Handoff、补充文件并选择合法 Outcome。
6. 用户确认后推进 State。

Assisted 模式下 Executor 结果是建议和证据，不拥有最终业务流转权。

### 7.3 Automatic

1. 持有 Role 的本地 Runtime 对 Turn 执行 preflight。
2. Git claim 成功后 dispatch Executor。
3. Executor 返回满足 Result Schema 的结果，其中包含合法 Outcome。
4. Runtime 自动发布 Completion 并推进 State。

Automatic 模式失败、阻塞或无法映射到合法 Outcome 时不得猜测目标 State，应进入 `RECOVERY_REQUIRED` 或角色人工确认。

## 8. 通知和操作界面

### 8.1 通知

当本地同步到新的 `turn_created` 且本机持有对应 Role 时：

- 发送桌面通知；
- 在群组列表显示“待开始”；
- 在角色任务列表增加待办；
- 点击通知打开 `/groups/{groupId}/runtime?turn={turnId}`；
- 使用 `(group_id, turn_id, local_agent_id)` 做本地通知去重。

通知投递记录只保存在本地 SQLite，不写 Git，避免每个参与者的展示副作用污染共享协议。

超时提醒分为两类：

- `start_timeout`：Turn 仍为 `PENDING_START` 且超过 `start_deadline_at`，提醒该 State 的当前 Role Owner/执行者和群组创建者。
- `execution_timeout`：Turn 已开始但未终止且超过 `execution_deadline_at`，提醒当前 claimant 和群组创建者；`IN_PROGRESS`、`RUNNING`、`WAITING_INPUT`、`WAITING_APPROVAL` 和 `AWAITING_CONFIRMATION` 都属于未完成执行。

创建者 Runtime 正常情况下通过 CAS 发布一次签名 `turn_timeout_observed`。Service 按 `(turn_id, attempt, deadline_kind)` 幂等返回已有 observation，Reducer 拒绝第二条有效事件进入链；创建者离线时不妨碍执行者本地先收到提醒，之后同步共享观察事实。本地通知按 `(group_id, turn_id, attempt, deadline_kind, recipient, reminder_ordinal)` 持久去重，重复提醒窗口由 Turn 中固定的 `reminder_interval_ms` 派生。超时只产生提醒和审计事实，不改变 Turn/FSM，不自动重派 Executor。

### 8.2 当前节点界面

节点标题区至少显示：

- 当前 State；
- 责任 Role；
- 执行模式；
- 当前 claimant；
- 创建、发现、开始、dispatch accepted、Provider 完成、等待确认、确认完成和状态推进等阶段时间与耗时；
- 待开始或执行 deadline、剩余时间和已超时标记；
- 上一节点摘要、Handoff 和 Artifact；
- 当前 State 允许的 Outcome。

`PENDING_START` 且本机持有 Role 时显示：

```text
[确认开始]
```

`IN_PROGRESS/AWAITING_CONFIRMATION` 且本机是 claimant 时显示：

```text
[上传文件] [确认完成]
```

其他成员只能查看，不显示可执行按钮。

Runtime 页面还提供审计时间线和 JSON 导出入口，按 Group/Epoch/Turn 展示共享签名事件与本地证据。时间同时显示本地时区和 UTC 原值；敏感路径、凭据和私有 Provider metadata 不进入普通视图或导出。

### 8.3 确认完成表单

```text
执行结果 *       当前 State 允许的 Outcome 下拉框
完成摘要 *       本节点完成内容
交接说明          下一节点应继续处理的内容
标记              risk / blocked / needs-review 等普通标签
结构化数据         可选 JSON，受 schema 和大小限制
文件               已上传 Artifact 列表
```

界面可以同时展示 Outcome 对应的下一 State，但提交值必须是 Outcome，不能接受客户端直接提交目标 State。

## 9. Handoff 协议

### 9.1 标准 Envelope

```json
{
  "format": "icarus.agent-group-handoff/2",
  "source_turn_id": "turn_development_1",
  "outcome": "ready_for_review",
  "summary": "已实现登录和 token 刷新",
  "instruction": "重点检查并发刷新和过期 token 回收",
  "markers": ["security-sensitive", "needs-load-test"],
  "data_refs": ["data/auth/spec.json"],
  "artifact_refs": ["artifacts/turn_development_1/changes.patch"],
  "data": {
    "commit": "abc123"
  }
}
```

约束：

- `source_turn_id/outcome` 由 Runtime 固定，客户端不能覆盖。
- `summary` 必填并限制长度。
- `instruction` 是普通不可信上下文，不是 system prompt。
- `markers` 是普通标签，不触发未声明的高权限自动操作。
- refs 必须指向已经验证、属于当前群组的路径。
- `data` 必须满足 State Implementation 声明的 Result Schema。
- 完整 Envelope 计算 canonical hash 并固定到 Completion Event。

### 9.2 下一 Turn 输入

进入下一 State 时，Runtime 将上一 Turn 的 Handoff hash 和 refs 写入新 Turn。Executor 只能读取 Turn 明确授权的 Handoff/Data/Artifact，不应默认扫描整个 Git 仓库。

如果群组从初始 State 启动，没有上一 Handoff，则使用创建者启动时提供的 Initial Handoff；Initial Handoff 同样经过 schema、大小和引用校验。

## 10. Artifact 上传

### 10.1 路径

上传文件只能进入运行时生成的路径：

```text
artifacts/{turn-id}/{artifact-id}-{safe-filename}
```

用户不能提交绝对路径、`..`、符号链接、子模块或自定义目标 Git 路径。

### 10.2 Metadata

每个 Artifact 记录：

```text
artifact_id
turn_id
original_name
repository_path
sha256
size
content_type
uploaded_by_principal_id
uploaded_by_agent_id
created_at
```

### 10.3 提交流程

1. Web 客户端通过受控上传接口把文件写入本地临时目录。
2. Host 检查文件名、大小、regular file 和内容哈希。
3. Host 将文件放入临时 Git checkout 的受控 Artifact 路径。
4. Completion Event 在同一 Git commit 中引用并物化 Artifact。
5. Push 成功后删除临时上传；失败时保留短期 staged upload 供同一 Turn 重试。

第一阶段默认限制建议：

- 单文件不超过 10 MiB；
- 单 Turn 累计不超过 50 MiB；
- 数量不超过 20；
- 超限时提示使用外部仓库并提交受控引用。

## 11. READY 和生命周期

### 11.1 FORMING -> READY

群组进入 READY 必须同时满足：

1. 每个 required Role 的有效认领数量达到 `min`。
2. 每个非终态 State 都有且只有一个有效 `owner_role`。
3. 每个非终态 State 都存在 active State Implementation。
4. `manual` Implementation 明确使用 `action_ref: null`。
5. `assisted/automatic` Implementation 引用的 Action、Prompt 和 Result Schema 完整有效。
6. Role/State/Implementation 所有权和签名一致。
7. 所有 Outcome 都能解析到存在的目标 State。

READY 不要求共享协议知道每台机器的绝对 Workspace 或凭据。本地 Executor preflight 结果在 Roles 页面单独展示；创建者启动前可以检查，但不能把本地秘密写入 Git。

### 11.2 修改执行实现

- `FORMING`：Role Owner 可以发布和修改 Implementation/Action。
- `READY`：启动前允许修改，但任何修改使 READY revision 更新，创建者必须基于最新 revision 启动。
- `RUNNING/PAUSING/CLOSING`：禁止修改。
- `PAUSED`：允许修改；恢复时增加 epoch，旧 Turn fence 和执行快照失效。
- `CLOSED`：不可修改。

### 11.3 暂停和关闭

- Manual Turn 已开始时，pause 进入 `PAUSING` 并等待完成或创建者处置。
- 创建者可以对长期人工 Turn 执行 recover/cancel，但必须记录原因。
- Close 默认 drain；强制关闭必须显式标记未完成 Turn disposition。

## 12. 事件模型

建议的 v2 共享事件：

```text
group_initialized
member_registered
role_claimed
role_released

state_implementation_published
state_implementation_revised
state_implementation_withdrawn

group_started
group_pause_requested
group_paused
group_resumed
group_close_requested
group_closed

turn_created
turn_started
action_dispatched
action_waiting_input
action_waiting_approval
action_completed
turn_timeout_observed
turn_completed
turn_cancelled
turn_recovery_requested
turn_recovered

data_updated
protocol_recovery
```

每个共享事件使用统一 Envelope，包含 `event_id/group_id/epoch/sequence/event_type/actor/occurred_at/expected revision/payload`。实现不在事件内重复保存 `previous_event_hash` 或 `payload_hash`：Git commit parent 已构成前序链，审计器从 canonical payload 派生 hash，并连同 revision、commit hash 和已验证 signer 导出。`occurred_at` 是签名 Actor 声明的 UTC 时间，不是第三方可信时间证明。Reducer 以 sequence 为权威顺序，各实例另存首次 `observed_at`，时钟偏差只能形成诊断，不能改变归约结果。

### 12.1 Completion 原子性

`turn_completed` 必须包含或引用经过验证的：

- Turn attempt 和 fencing token；
- Outcome；
- Result hash；
- Handoff hash；
- Artifact refs。

Reducer 在归约 `turn_completed` 时直接根据当前 State 的 Outcome 更新 `businessState`。不再要求另一个参与者随后提交可丢失的 `state_transitioned` 事件；状态迁移仍可物化为 Projection 中的 transition history。

### 12.2 Assisted Action

`action_completed` 只表示 Provider 已返回结果，不推进 FSM。角色用户执行确认完成命令后，Runtime 直接生成 `turn_completed`；不增加一个可能与最终完成分离的中间确认事件。

Artifact metadata 和文件 bytes 与 `turn_completed` 在同一个签名 commit 中物化，不使用独立的 `artifact_published` 事件，避免文件已发布但 FSM 完成失败的半状态。

如果用户修改了 Executor 建议的 Outcome 或 Handoff，最终 Turn Result 必须以用户确认后的内容重新计算 hash。

### 12.3 Timeout Observation

`turn_timeout_observed` payload 包含 `turn_id`、`attempt`、`deadline_kind`、固定 `deadline_at`、观察者声明的 `observed_at` 和关联 snapshot hash。正常情况下由创建者 Runtime 发布；Reducer 只校验当前 Turn/attempt、deadline kind 和 snapshot 一致、对应 deadline 存在且节点尚未结束，不读取本地 wall clock，也不依据时间自动推进。

同一 `(turn_id, attempt, deadline_kind)` 只归约一个共享观察事实。并发观察通过 revision/CAS 收敛；失败方 fetch/reduce 后不得污染事件链。stale attempt、已完成/取消 Turn 或自造 deadline 被拒绝。事件只增加审计事实和超时标记，不改变 `businessState`、Turn state、claimant 或 fencing token。

## 13. 授权规则

### 13.1 Creator-only

- 启动、暂停、恢复和关闭群组；
- 创建下一 Turn；
- 恢复卡死 Turn；
- 在 PAUSED 状态发布新 Machine epoch；
- 调整 Role Definition；
- 执行 protocol recovery。

### 13.2 Role-owner-only

- 为自己认领 Role 拥有的 State 发布 Implementation；
- 为这些 State 发布 Action 和 Prompt；
- 修改或撤回自己的 Implementation；
- 配置对应 Action 的本地 Executor Binding。

### 13.3 Turn-claimant-only

- 开始当前 Turn；
- 为当前 Turn 上传 Artifact；
- 回报 Action 状态；
- 提交或确认 Completion；
- 填写 Handoff。

所有 claimant-only 事件同时校验 `principal_id + agent_id + attempt + fencing_token`，不能在 Turn claim 后退化为只校验 Principal。

## 14. Executor Binding

### 14.1 Binding Key

从：

```text
(group_id, role)
```

调整为：

```text
(group_id, state_id, implementation_hash, action_hash)
```

或使用等价的稳定 `binding_id` 引用上述身份。这样同一 Role 的不同 State 可以使用不同 Executor 类型和 Workspace。

### 14.2 Binding 内容

```text
executor kind/adapter        从 Action 只读继承
workspace path               本地配置
agent JID                    run_once 可选/必需字段
approval policy              本地配置，但不能弱于 Host 上限
filesystem access cap        本地上限
provider config              本地配置
enabled                      本地开关
```

UI 不再允许角色成员改变 Action 的 Executor 类型。配置页显示所需类型，只收集本地实现参数。

### 14.3 Manual State

Manual State 没有 Executor Binding。工作台不能因为缺少 Binding 将其显示为错误。

## 15. Git 仓库结构

```text
group.yaml
machine.yaml

groups/
  roles/
    {role}.yaml
  members/
    {principal-id}.json
  claims/
    {role}/{principal-id}.json
  implementations/
    {role}/{state-id}.yaml

actions/
  {role}/{state-id}/{action-id}.yaml

prompts/
  {role}/{state-id}/{action-id}.md

events/
  {epoch}/{sequence}-{event-id}.json

projection/
  state.json

data/
artifacts/
  {turn-id}/{artifact-id}-{safe-filename}
```

Creator-owned 文件和 Role-owned 文件必须通过路径和签名事件授权分别校验。不能仅因为 Git signer 是已注册成员就允许修改任意 `actions/` 或 `prompts/` 文件。

## 16. API 草案

```text
POST /api/collaboration/groups
POST /api/collaboration/groups/inspect
POST /api/collaboration/groups/join

POST /api/collaboration/groups/{id}/roles/{role}/claim
PUT  /api/collaboration/groups/{id}/states/{state}/implementation
DELETE /api/collaboration/groups/{id}/states/{state}/implementation

PUT  /api/collaboration/groups/{id}/states/{state}/binding
POST /api/collaboration/groups/{id}/commands

GET  /api/collaboration/groups/{id}/turns/current
POST /api/collaboration/groups/{id}/turns/{turn}/start
POST /api/collaboration/groups/{id}/turns/{turn}/artifacts
POST /api/collaboration/groups/{id}/turns/{turn}/complete
POST /api/collaboration/groups/{id}/turns/{turn}/recover

GET  /api/collaboration/groups/{id}/audit
```

`GET .../audit` 返回按 Group/Epoch/Turn 聚合且已脱敏的 JSON；Web 工作台直接下载该响应，不增加一条会产生不同过滤语义的 export 协议端点。

### 16.1 Start 请求

```json
{
  "expectedRevision": 17,
  "expectedTurnId": "turn_xxx"
}
```

客户端不提交 Principal、Agent、Role 或 fencing token。Host 从本地身份和当前 Projection 解析这些值。

### 16.2 Complete 请求

```json
{
  "expectedRevision": 20,
  "expectedTurnId": "turn_xxx",
  "outcome": "ready_for_review",
  "summary": "实现和测试已完成",
  "handoff": {
    "instruction": "请重点检查 token 刷新",
    "markers": ["security-sensitive"],
    "data": {}
  },
  "artifactIds": ["artifact_xxx"]
}
```

Host 根据 Turn 查找 Role、claimant、allowed outcomes、target State 和 staged artifacts，不接受客户端覆盖。

## 17. 本地存储调整

建议新增或调整：

```text
collaboration_groups
collaboration_memberships
collaboration_role_claims
collaboration_state_implementations
collaboration_turns
collaboration_executor_bindings
collaboration_action_executions
collaboration_staged_artifacts
collaboration_notification_deliveries
collaboration_sync_attempts
collaboration_integrity_incidents
```

关键持久化要求：

- State Implementation 和 Turn Projection 可从 Git 重建。
- Executor Binding、Provider receipt、staged upload 和通知投递记录不可依赖 Git 重建。
- 共享事件缓存可从 Git 重建；本地首次发现、Provider observation/receipt、通知 delivery、reminder ordinal 和 clock-skew 诊断只作为 SQLite 证据关联到共享链。
- Timeout scheduler 在 notification delivery 中持久保存 Turn/attempt/deadline kind、recipient 和 reminder window，应用重启后补扫但不重复已投递提醒。
- Action dispatch 开始后没有 durable receipt 时继续进入 `RECOVERY_REQUIRED`，禁止盲目重派。
- staged upload 必须有 TTL 和按精确路径清理，不能递归清理宽泛目录。

## 18. Web 工作台调整

### 18.1 创建群组

创建者只配置：

- Git Remote；
- 群组名称；
- SSH signing key；
- Role 和人数；
- 创建者初始 Role；
- State、owner_role、Outcome、target State 和可选 timeout policy。

创建界面不再配置其他 Role 的 Action、Prompt、Workflow Ref 或 Executor。

### 18.2 Roles 页面

展示：

- Role 人数和认领者；
- Role 拥有的 State；
- 每个 State 的 mode；
- Implementation 发布者和版本；
- 本地 Binding/preflight；
- “配置执行方式”入口，只对本机认领 Role 可见。

### 18.3 配置执行方式

```text
执行方式：Manual / Assisted / Automatic
Action 类型：Run once / Workflow / Codex task（非 Manual）
Workflow Ref：仅 Workflow
Action Prompt：非 Manual
文件权限要求：非 Manual
Result Schema：可选高级项
本地 Workspace/Provider：独立本地配置区
```

共享 Implementation 和本地 Binding 应分两步保存，避免用户误以为本地路径会写入 Git。

### 18.4 Runtime 页面

以“当前节点”而不是“当前 Executor”为中心，显示：

- incoming Handoff；
- 节点生命周期时间线、deadline、剩余时间和超时状态；
- 确认开始；
- Action 运行状态；
- 确认完成；
- Outcome；
- Artifact；
- 历史 Turn；
- 按 Group/Epoch/Turn 的完整审计链查看和 JSON 导出。

## 19. 失败和恢复

| 场景                                | 行为                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| Role 未认领                         | 群组保持 FORMING                                        |
| Role 已认领但 Implementation 未发布 | 群组保持 FORMING                                        |
| Manual Turn 长期未开始              | 提醒；创建者可暂停、重分配或关闭                        |
| Manual Turn 开始后成员离线          | 保留 claimant；创建者显式 recover                       |
| Assisted Action 完成后无人确认      | 保持 AWAITING_CONFIRMATION 并提醒                       |
| 节点超过 deadline                   | 标记超时并提醒 Role Owner/claimant 与创建者；不自动流转 |
| 应用在 deadline 时离线              | 下次同步后补记首次观察并发送一次持久去重提醒            |
| 多实例同时观察超时                  | CAS 后只保留一个共享观察事实，各收件实例独立持久去重    |
| 本机时间明显偏移                    | 记录 clock-skew 诊断；不改变 reducer 结果或自动流转     |
| Automatic Action 无合法 Outcome     | RECOVERY_REQUIRED，不猜测 State                         |
| 文件上传成功但完成失败              | staged artifact 可按 Turn 重试，TTL 后清理              |
| Completion push 冲突                | fetch/revalidate；过期 revision 不自动重放用户选择      |
| Role Owner 释放角色                 | 旧 Implementation inactive，群组回到 FORMING/PAUSED     |
| Prompt/Action 在运行时改变          | hash 不匹配，拒绝执行或完成                             |
| 旧 claimant 延迟提交                | fencing token 不匹配，拒绝                              |

## 20. 节点计时、超时和审计

### 20.1 时间语义

一个 State 每次进入都会产生新 Turn；恢复执行会产生新 attempt。计时和审计均以 `(group_id, epoch, turn_id, attempt)` 为边界，不能把循环进入同一 State 或恢复后的 attempt 合并。

| 时间                                                           | 权威来源                                   | 用途                         |
| -------------------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| `created_at`                                                   | `turn_created.occurred_at`                 | 节点进入、待开始计时起点     |
| `start_deadline_at`                                            | `turn_created` 固定 payload                | 判断待开始超时               |
| `started_at`                                                   | `turn_started.occurred_at`                 | 当前 attempt 执行计时起点    |
| `execution_deadline_at`                                        | `turn_started` 固定 payload                | 判断节点执行超时             |
| dispatch/action 状态时间                                       | 对应签名事件或 SQLite Provider observation | 还原 Executor 阶段           |
| `completed_at/cancelled_at/recovery_requested_at/recovered_at` | 对应签名事件                               | 终止、处置和新 attempt 边界  |
| 首次发现、投递和 Provider 回调时间                             | 本机 SQLite                                | 补充本地证据，不替代共享事实 |

deadline 是 Turn snapshot 与 input hash 的一部分，不能按最新 State 配置重算。Duration 从上述原始时间派生；协议 sequence 是共享事实的权威顺序。跨机器时间倒序只产生 `unreliable/clock_skew` 标记，不得改变 reducer 的业务状态。

### 20.2 超时检测和提醒

本地 scheduler 在启动、同步、系统唤醒和 deadline 到期时扫描：

1. `PENDING_START` 只检查 `start_deadline_at`，提醒当前 Role Owner/执行者和创建者。
2. 已开始且未终止的 manual、assisted、automatic attempt 检查 `execution_deadline_at`，提醒 claimant 和创建者；等待输入、审批或人工完成确认仍计入执行时限。
3. 创建者 Runtime 尝试以 CAS 发布幂等 `turn_timeout_observed`；创建者离线时执行者仍先收到本地提醒，后续同步共享观察事实。
4. 本地首次和重复提醒先落 SQLite，按 recipient 与 reminder ordinal/window 去重，直到 Turn 终止或 attempt 替换。

第一阶段 `on_timeout` 固定为 `notify_only`。超时不自动选择 Outcome、执行 Transition、取消 Turn、释放 Role、抢占 claimant 或重派 Executor；创建者的 pause、recover、cancel 或 close 仍是独立签名命令。

### 20.3 完整审计链

审计视图与 JSON 导出按 Group/Epoch/Turn 聚合三层信息：

1. Git 共享链：Machine、Role claim/release、Implementation、生命周期、Turn、Action、timeout、Completion 与 recovery 事件，每项包含 sequence、revision、commit hash、signer、actor 和 `occurred_at`。
2. Turn 快照与结果：State/Role/mode、Implementation/Action/Prompt/input hash、incoming/outgoing Handoff、Outcome、Artifact hash、claimant principal+agent、attempt/fence、deadline、所有 lifecycle timestamps 和派生 duration。
3. SQLite 本地证据：首次发现、通知/reminder、durable receipt、公开 Provider/execution ref、Provider observation 和 integrity/clock-skew 诊断。

前两层可从 Git 签名链重建；第三层只代表当前实例持有的证据，导出时明确标为 `local_evidence`。普通导出默认只含受控公开 receipt/ref 和内容 hash，不包含凭据、签名私钥、本地绝对路径、staged upload 路径、私有 Provider metadata 或未经授权的 Prompt/Handoff 原文。

### 20.4 时钟、并发和 stale attempt

没有中心可信时间服务，因此签名只能证明 Actor 声明了某时间。Reducer 不读取 `Date.now()`，不按 wall clock 自动推进；本机时钟仅影响提醒及时性和审计告警。多个实例同时检测超时，以 `(turn_id, attempt, deadline_kind)` 幂等键和 Git CAS 收敛。

任何迟到 timer、Executor callback、通知任务或 timeout event 都必须重新校验当前 `epoch + turn_id + attempt`，涉及执行写入时还必须校验 fencing token。旧 attempt 只能保留为审计证据，不能提醒当前执行者、写入有效 timeout observation 或修改当前 Turn。

## 21. 实施阶段

### Phase 1：身份和协议骨架

- 接入系统生成的 Principal/Agent Identity。
- 升级 group/role/machine/event/projection schema 到 v2。
- Machine Transition 去掉 `actor_role/action_ref`。
- State 增加 `owner_role`。
- 重写确定性 reducer 和授权规则。
- 删除 v1 兼容和旧群组迁移代码。

### Phase 2：Role-owned State Implementation

- 增加 Implementation publish/revise/withdraw 事件。
- 增加 Role/State/Signer 所有权验证。
- Action 和 Prompt 改为 Role-owned 路径。
- 删除 Prompt override。
- READY 加入 Implementation 完整性检查。
- v2 对拥有 State 的 Role 强制 `max=1`。

### Phase 3：Manual Turn 和 Handoff

- Turn 支持 nullable Action。
- 增加 `PENDING_START/IN_PROGRESS/COMPLETED`。
- 实现 start/complete API。
- 实现 allowed Outcome 校验和原子 State 推进。
- 实现标准 Handoff Envelope 和 Initial Handoff。
- 实现本地通知去重。
- 固定 Turn lifecycle timestamp、timeout policy 和 deadline。

### Phase 4：Artifact 上传

- 实现 staged upload、路径规范化、大小和哈希验证。
- Artifact 与 Completion 同 commit 物化。
- 增加工作台上传、列表、移除和重试交互。
- 增加 TTL 清理和恢复测试。

### Phase 5：Assisted 和 Automatic Action

- Binding 改为 State Implementation/Action 维度。
- UI 从 Action 只读继承 Executor 类型。
- Assisted 增加 AWAITING_CONFIRMATION。
- Automatic 根据 Result Schema 选择合法 Outcome。
- 保留 receipt-first、idempotency、fencing 和 recovery 约束。

### Phase 6：节点超时和审计

- 增加持久化 timeout scan、重启补扫和周期提醒。
- 增加 `turn_timeout_observed`、CAS 幂等归约和 stale attempt 校验。
- 向当前 Role Owner/claimant 和创建者发送去重提醒，保持 `notify_only`。
- 增加 Turn timeline、共享 Git 审计链、本地证据聚合和脱敏 JSON 导出。

### Phase 7：Web 完整体验和诊断

- 重做创建群组 Builder，仅保留 Creator-owned Skeleton。
- 增加 Role Implementation Builder。
- 增加当前节点、确认开始、确认完成、Handoff 和 Artifact UI。
- 增加节点计时、deadline、超时标记、审计时间线和导出入口。
- 增加身份、Action ownership、通知、staged artifact 和卡死人工节点诊断。
- 更新 README、TECHNOLOGY 和原 Runtime 方案的 implemented 状态说明。

## 22. 测试矩阵

### 22.1 Schema 和 Reducer

- 非终态 State 缺少 owner_role 被拒绝。
- 终态声明 owner_role 或 Transition 被拒绝。
- Outcome 指向未知 State 被拒绝。
- 循环 FSM 可以持续多轮。
- Completion 只能选择当前 State 允许的 Outcome。
- Reducer 对同一事件历史产生确定 Projection。
- 非法 timeout 数值、终态 timeout policy 和非 `notify_only` 策略被拒绝。

### 22.2 Authorization

- 创建者不能为未认领 Role 发布 Implementation。
- Role Owner 不能修改其他 Role 的 Implementation。
- 普通成员不能 start/complete Turn。
- claimant 的 Principal、Agent、attempt 或 fence 任一不匹配都被拒绝。
- Role 释放后旧 Owner 不能继续修改 Action 或完成新 Turn。

### 22.3 Readiness

- Role 人数不足保持 FORMING。
- Role 已满足但 Implementation 缺失保持 FORMING。
- Manual Implementation 无 Action 仍可 READY。
- Assisted/Automatic 缺少 Action 或 Prompt 不能 READY。
- State-owning Role 的 `max > 1` 在 v2 被拒绝。

### 22.4 Manual Turn

- 角色成员收到一次通知。
- 多个实例同时开始只有一个 CAS winner。
- winner 可以上传、完成和推进 State。
- 非法 Outcome、任意 target State 和越权 Artifact 被拒绝。
- 长期 Turn 可以被创建者显式恢复。

### 22.5 Handoff 和 Artifact

- Handoff canonical hash 稳定。
- Handoff instruction 不进入 system instruction 槽位。
- 下一 Turn 固定上一 Handoff hash。
- 路径穿越、符号链接、超限文件和哈希不一致被拒绝。
- staged upload 在冲突后可安全重试。

### 22.6 Executor

- Manual 不读取 Binding。
- Binding Executor 类型不能覆盖 Action。
- 同一 Role 不同 State 可以绑定不同 Action/Workspace。
- Assisted 完成后不会自动推进。
- Automatic 只有合法 Result Schema 和 Outcome 才推进。
- receipt 缺失继续 fail closed。

### 22.7 Timing、Timeout 和 Audit

- Turn 创建和开始时固定双 deadline，修改 Machine 不影响已有 Turn snapshot/hash。
- manual、assisted 和 automatic 均记录完整生命周期与派生 duration。
- start timeout 提醒 Role Owner/执行者与创建者；execution timeout 提醒 claimant 与创建者。
- 首次提醒持久去重，重复提醒按固定 interval 的 ordinal/window 去重并可跨重启恢复。
- 多实例并发只归约一个 `(turn, attempt, kind)` timeout observation。
- clock skew 不改变 reducer 结果；完成/取消后不再提醒。
- recover 后 stale attempt 不提醒，也不接受迟到 timeout event、callback 或 completion。
- 审计链包含共享事件 sequence/revision/commit/signer、Turn 快照/结果和脱敏本地证据，普通 JSON 导出不泄露路径、凭据或私有 Provider metadata。

### 22.8 UI

- 创建群组不出现其他 Role 的 Action/Prompt 配置。
- 未认领 Role 不能看到配置 Implementation 按钮。
- Manual State 显示确认开始/完成，不提示 Executor 未配置。
- Complete 表单只列出允许 Outcome，并显示目标 State。
- 非 claimant 只能查看当前 Turn。
- 通知点击打开正确群组和 Turn。
- 当前节点和历史 Turn 显示生命周期、duration、deadline、剩余/超时状态。
- 审计入口可以按 Turn 查看链路并导出 JSON。

## 23. 验收标准

- 创建者可以只定义角色和 FSM 骨架并创建群组。
- 每个角色所有者可以独立声明自己 State 的 manual/assisted/automatic 实现。
- 创建者不能为未认领角色定义 Action，角色所有者不能修改其他角色 Action。
- Manual State 无 Action、无 Executor Binding 仍能完成完整 Turn。
- 当前角色成员收到通知，可以确认开始，并在完成时选择合法 Outcome、填写摘要/Handoff、上传文件。
- 下一 Turn 能看到并固定上一 Turn 的 Handoff 和 Artifact refs。
- 客户端不能直接指定任意目标 State。
- Assisted Action 结果必须经过用户确认；Automatic Action 必须通过 schema 和 Outcome 校验。
- 运行期间修改 Implementation/Action/Prompt 不会改变已创建 Turn。
- 每个 Turn/attempt 都能追溯创建、发现、开始/自动 claim、dispatch accepted、Provider 完成、等待确认、完成/推进、取消和恢复时间。
- State 可独立配置 start/execution timeout，deadline 固定后不随策略修改；超时只提醒当前执行者与创建者，不自动推进。
- 超时观察与提醒在并发、重启和重复窗口下幂等，stale attempt 不能污染当前 Turn。
- 可以查看并导出完整共享审计链和当前实例的脱敏本地证据。
- 所有共享操作保持签名、revision、CAS、fencing 和确定性 reducer 约束。
- Principal/Agent Identity 由系统解析，创建和加入表单不再手填。

## 24. 最终决策摘要

| 主题             | 决策                                                                |
| ---------------- | ------------------------------------------------------------------- |
| 工作流所有者     | 创建者                                                              |
| State 责任角色   | 创建者指定                                                          |
| Transition       | 只表达 Outcome 到目标 State                                         |
| Action 所有者    | State 对应 Role Owner                                               |
| Action 是否必需  | 否                                                                  |
| 无 Action 行为   | Manual Turn                                                         |
| Agent 辅助       | Assisted，用户确认完成                                              |
| Agent 自动执行   | Automatic，schema 校验后自动完成                                    |
| 上一节点命令     | 结构化 Handoff，不可信上下文                                        |
| 下一 State 选择  | 只能通过 Creator-defined Outcome 映射                               |
| 文件             | Turn-scoped Artifact，受控 Git 路径                                 |
| Prompt override  | 删除                                                                |
| Executor Binding | 按 State Implementation/Action 保存                                 |
| Role interaction | 从 Role 删除，由 execution mode 表达                                |
| 多人 State Role  | v2 第一阶段限制 max=1                                               |
| 身份             | Principal 由公钥指纹派生，Agent 为本机持久 UUID                     |
| 协议兼容         | 无存量群组，直接使用 v2，不迁移 v1                                  |
| Deadline         | Turn 创建固定 start deadline，开始固定 execution deadline           |
| Timeout 动作     | 第一阶段仅 `notify_only`，不自动改变 FSM                            |
| Timeout 幂等     | `(turn_id, attempt, deadline_kind)` + revision/CAS                  |
| 审计             | Git 共享签名链 + SQLite 本地证据，按 Group/Epoch/Turn 脱敏导出 JSON |

该模型将 Agent Group 从“创建者预先编排所有 Agent 动作”调整为“创建者规定协作边界，角色所有者自治执行，人和 Agent 共用同一个可审计 Turn 协议”。这更符合多个独立用户携带各自本地 Agent、通过 Git 协作的原始目标。
