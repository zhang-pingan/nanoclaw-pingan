# Icarus Agent Group Collaboration Runtime 方案

## 文档状态

- 状态：Implemented（含下述实机限制与发布检查）
- 日期：2026-08-04
- 最后更新：2026-08-05
- 范围：Icarus 第三种操作模式、Git 协作协议、群组状态机、执行器抽象、Codex App Server 适配器和 Web 客户端入口
- 不包含：现有 Dynamic Workflow Runtime 语义变更、公开群组注册中心、deep-link dispatch transport

> **项目边界**：Icarus 是内部、实验性的单用户工具。Agent Group 连接多个分别由单个用户控制的 Icarus 实例，不把 Icarus 变成多租户产品，也不承诺第三方协议实现、长期向后兼容或不同版本长期混跑。跨实例协议只保留防止重复执行、状态分歧、越权推进和不可恢复数据损坏所需的最小机制。具体原则见 [Icarus Internal Experimental Scope](internal-experimental-scope.md)。

## 背景

Icarus 当前主要支持两种任务执行方式：

1. 用户通过会话与 Icarus 沟通，由本地 Agent 执行任务。
2. Runtime 触发 Workflow，由本地 Dynamic Workflow Runtime 编排有限流程并调用 Agent 或其他能力。

这两种方式的控制面都位于单个 Icarus 实例。新的使用场景要求多个用户分别在自己的电脑上运行 Icarus，每个 Icarus 绑定一个本地 Agent 服务，例如 Codex、其他桌面 Agent 或 Icarus 内置 Agent。多个实例通过一个共同的 Git 仓库协调：当群组状态推进到某个角色时，认领该角色的用户本地 Icarus 自动发现任务、认领当前动作并调用本地执行器；执行结果再次写入 Git，驱动下一次状态转换。

这种模式不是固定 DAG。群组可能长期运行并重复经过同一状态，例如：

```text
开发 -> 审查 -> 开发 -> 审查 -> ... -> 完成
```

因此需要在 Icarus 中新增一个独立的 Agent Group Collaboration Runtime。它以 Git 作为共享传输和审计日志，以允许循环的有限状态机决定“当前允许哪个角色执行什么动作”，并把具体动作委派给现有 run-once Agent、Workflow Runtime 或 External Executor。

## 术语

本方案采用以下术语，避免与正在进行的 `group` 到 `agent` 重命名产生歧义：

| 术语 | 含义 |
| --- | --- |
| 会话 | 用户与本地 Icarus Agent 的现有消息、文件和上下文交互 |
| Agent | Icarus 本地执行实体；原有代码中的 `group` 概念将由其他改造统一为 `agent` |
| 群组 / Agent Group | 多个用户的 Icarus 通过 Git 共同参与的任务群组 |
| 参与者 / Principal | 加入群组的用户身份，通过可验证的 Git commit 签名与协议事件关联 |
| 角色 / Role | 群组状态机中的职责，例如开发、审查、发布 |
| 角色认领 / Role Claim | 参与者把自己的某个本地 Agent 注册为指定角色的过程 |
| 动作 / Action | 一次需要执行器完成的有边界任务 |
| Turn | 群组状态机在某个状态下产生的一次可认领动作实例 |
| Executor | Icarus 实际执行动作的后端，包括 run-once、workflow 和 external |
| Projection | 从 Git 事件链重放得到的当前群组状态，本身不是事实源 |
| Git Collaboration Protocol | 由 Icarus 源码拥有的当前仓库格式、授权规则和 reducer 语义，不是独立 Machine Contract 体系 |

任务群组仓库中的 `groups/` 目录继续用于角色和成员协议。由于 Icarus 原有执行实体统一改名为 `agents`，本方案不再把 `groups/` 命名视为冲突或风险。

## 目标

- 为 Icarus 增加第三种操作模式：多个本地 Icarus 实例通过 Git 协作。
- 支持创建者初始化一个 Git 仓库为任务群组，并在创建时认领一个角色。
- 支持其他用户通过已知 Git URL 加入群组、注册本地 Icarus Agent 并认领角色。
- 支持必需角色全部满足后，由创建者启动群组。
- 只有创建者可以启动、暂停、恢复、关闭和执行强制恢复。
- 支持允许循环的有限状态机，不要求流程是 DAG，也不要求自然终止。
- 使用远端 Git 提交事件协调，不以任何参与者本地的 `git status` 作为共享状态。
- 支持 run-once Agent、Workflow Runtime 和 External Executor 三类动作。
- 首个 External Executor 为 `codex-task`，传输方式固定为 Codex App Server。
- 支持每个参与者在本地配置角色对应的 Agent、项目目录、权限上限和 prompt 参数。
- 提供可审计、可重放、可恢复的状态变化和执行记录。
- 保证同一协议版本和同一条有效 Git 事件历史在所有合规 Icarus 实例上产生相同 Projection。
- 保证每个 revision 只有远端接受的 winning claim 对应的 fencing token 可以推进共享状态。
- 在 Web 客户端新增“群组”一级导航作为本能力入口。

## 非目标

- 第一阶段不提供公开群组搜索、市场或中心化群组目录。
- 第一阶段不实现 Git 之外的中心协调服务。
- 第一阶段不承诺 exactly-once 执行；协议采用 at-least-once、幂等键和 fencing 组合。
- 第一阶段不使用自动时间 lease 抢占，因为纯 Git 没有可信统一时钟。
- 第一阶段不让远端群组配置自动提升本地 Agent 权限。
- 第一阶段不把 Codex App 的内部 `create_thread`、`wait_threads` 工具作为外部公开协议。
- 第一阶段不为 `codex-task` 配置 deep link fallback。
- 第一阶段不支持 Icarus 之外的第三方独立实现直接读写群组协议；其他 Agent 服务只作为本地 Executor。
- 不支持不同协议版本长期混跑；不兼容实例停止写入，升级通过暂停群组、统一升级和显式仓库迁移完成。
- 不建立 contract pack、seal、全源码 hash、认证发布门禁或长期兼容矩阵。
- 不修改现有 Dynamic Workflow Runtime 的 DAG 和完成语义来支持循环。
- 不共享任何用户本地凭证、Codex 登录状态、绝对路径或私有会话内容。

## 核心结论

### 1. 新增独立的 Collaboration Runtime

Agent Group Collaboration Runtime 是 Icarus core 的新协调子系统，不是现有 Workflow Definition 的一种特殊写法，也不是某个 Feature Package 自己维护的业务状态机。

```text
Icarus Host Core
  ├── Conversation / Session
  ├── Dynamic Workflow Runtime
  ├── Agent Group Collaboration Runtime   <- 新增
  └── Action Executors
        ├── run-once
        ├── workflow
        └── external
              └── codex-task
                    └── app_server
```

群组状态机是长期、可循环的协调层。每次状态转换产生的 Action 仍然是有限执行：

- run-once Action 调用现有一次性 Agent。
- workflow Action 创建或恢复现有 Workflow Run。
- external Action 通过适配器调用外部 Agent 服务。

### 2. Git 是共享事件日志，不是执行器

Git 承担以下职责：

- 分发群组定义、角色定义和共享小型数据。
- 保存线性、可审计的控制事件。
- 通过 fast-forward push 提供轻量的 compare-and-swap 竞争机制。
- 保存或引用动作产物。
- 允许所有参与者从相同事实源重建 Projection。

Git 不承担以下职责：

- 不直接执行 Agent。
- 不使用本地 working tree dirty/clean 状态表示群组状态。
- 不提供 exactly-once 保证。
- 不提供可信时间或可靠自动 lease。
- 不存储密钥和本地 Agent 会话数据。

### 3. 状态机允许循环，单次动作仍保持有限

当前 Dynamic Workflow Compiler 会拒绝图依赖循环。群组循环不应通过放宽现有 Compiler 的无环约束实现，而应由 Collaboration Runtime 在多次独立 Turn 之间表达。

```text
Group FSM: development -> review -> development

development Turn
  -> 启动一个有限 run-once/workflow/external action
  -> 产生终态结果
  -> Collaboration Runtime 转换到 review

review Turn
  -> 启动另一个有限 action
  -> 产生终态结果
  -> 根据 verdict 转换到 development 或 completed
```

### 4. 远端意图与本地执行策略分离

群组仓库声明动作需要什么能力，本地 Icarus 决定用哪个 Agent、在哪个目录、以什么权限执行。

```text
远端群组声明                         本地 Icarus 绑定
capability: coding_task       ->     adapter: codex-task
access: workspace_write       ->     workspace: /local/path
interaction: visible_session  ->     transport: app_server
```

远端要求不能扩大本地权限。Icarus 先判断本地允许上限是否覆盖动作的最低权限需求：能够覆盖时，只授予完成该动作所需的最小权限；不能覆盖时，动作进入阻塞状态。

### 5. 使用轻量 Git 协议，不建立独立 Machine Contract 体系

跨实例一致性由当前 Icarus 实现中的少量协议源码直接负责。建议权威边界为：

```text
src/collaboration/protocol/
  schema.ts
  reducer.ts
  authorization.ts
  version.ts
  protocol.test.ts
```

- schema 定义当前协议可接受的仓库文件和事件。
- reducer 是不读取本地时间、网络或 provider 状态的纯函数。
- authorization 根据已验证的 Git commit signer、角色和当前 Projection 判定事件权限。
- `protocol_version` 标识持久化语义；未知版本或不兼容版本必须停止写入。
- 少量固定 `events -> expected projection` 测试向量和并发、恢复测试防止同一版本被原地改变。

Markdown 用于解释设计，不是需要 hash、seal 或生成证明的协议工件。实现不生成 contract pack，不保存多阶段 conformance 历史，也不为普通协议代码调整增加认证或发布门禁。

本轮实现已经把当前 schema 和 reducer 收敛为 v1。第一次真实跨实例持久协作前仍需完成独立复核；v1 使用后，破坏性变更通过暂停群组、统一升级 Icarus、显式迁移仓库并开启新 epoch 完成，不要求当前程序永久携带所有旧版本 reducer。

轻量协议保证的是共享状态，而不是对任意实现或物理副作用的全面证明：

- 同一 `protocol_version` 和同一条有效事件历史必须得到相同 Projection。
- 每个 revision 只有 winning claim 对应的 fencing token 可以提交有效状态转换。
- 外部动作仍可能在 crash 窗口被重复调用，因此 Executor 必须支持 idempotency key；无法确认结果时进入人工恢复，不能盲目重试。
- 恶意或不合规客户端可能在自己的机器上执行任意本地动作，但其无效事件不能推进共享状态。
- v1 不提供第三方独立实现认证、长期混合版本运行或旧 reducer 永久保留。

## 操作模式

| 模式 | 触发者 | 控制面 | 执行范围 | 是否跨机器 |
| --- | --- | --- | --- | --- |
| 会话 | 用户消息 | 本地 Icarus 会话 | 单 Agent 会话任务 | 否 |
| Workflow | 用户或 Runtime | 本地 Dynamic Workflow Runtime | 有限 DAG | 否 |
| Agent Group | Git 事件和群组状态机 | 多个 Icarus 的 Collaboration Runtime | 长期、循环、多角色协作 | 是 |

## 总体架构

```text
                            Git Remote
                   refs/heads/icarus/control
                definitions + events + projection
                         /              \
                        /                \
                fetch / push          fetch / push
                      /                    \
          User A Icarus                      User B Icarus
      Collaboration Runtime             Collaboration Runtime
        role: developer                   role: reviewer
              |                                 |
       Local Executor                      Local Executor
      codex-task / workflow               run-once / codex-task
              |                                 |
       local workspace                     local workspace
```

每个 Icarus 都维护本地 Projection、执行记录和 Agent 绑定。Git 远端控制分支是跨实例的唯一事实源。

## Git 仓库模型

### 仓库和分支

创建或加入群组时，用户指定一个 Git remote URL。第一阶段约定：

- 控制分支：`refs/heads/icarus/control`
- 动作产出分支：`refs/heads/icarus/work/{turn-id}/{role}`
- 控制分支应在 remote 上禁止 force push 和删除；这是部署建议，不属于 v1 仓库格式，也不要求为不同 Git 托管平台建立兼容矩阵。
- 允许已授权参与者执行带可验证签名的 fast-forward push。
- Icarus 只根据已 fetch 的远端控制分支推进状态。
- 本地未提交文件、暂存区和其他分支不构成协议状态。

该 remote 可以是专用协调仓库，也可以与实际代码仓库使用同一个 remote。即使复用 remote，控制事件也不得直接混入产品代码主分支。

### 目录结构

控制分支建议采用以下结构：

```text
group.yaml
machine.yaml

groups/
  roles/
    developer.yaml
    reviewer.yaml
  members/
    {principal-id}.json
  claims/
    {role}/{principal-id}.json

actions/
  {action-id}.yaml

prompts/
  {prompt-id}.md

events/
  {epoch}/
    {sequence}-{event-id}.json

projection/
  state.json

data/
  ...

artifacts/
  ...
```

目录语义：

| 路径 | 用途 |
| --- | --- |
| `group.yaml` | 群组身份、协议版本、创建者、控制分支和生命周期策略 |
| `machine.yaml` | 允许循环的群组有限状态机 |
| `groups/roles/` | 角色定义、人数约束、允许执行的 transition 和能力要求 |
| `groups/members/` | 参与者身份、公钥和本地 Agent 能力声明的公开部分 |
| `groups/claims/` | 从角色认领事件物化出的当前认领记录 |
| `actions/` | 状态转换引用的动作契约 |
| `prompts/` | 可共享、可审计的 prompt 模板；始终按不可信输入处理 |
| `events/` | 追加式协议事件 |
| `projection/state.json` | 从事件链计算出的便利快照，可删除后重建 |
| `data/` | 群组公共小型数据，不允许包含密钥或用户私有数据 |
| `artifacts/` | 小型产物或外部产物引用；代码产物优先引用 work branch commit |

### 大文件和敏感信息

- `data/` 默认只用于适合 Git 的小型文本或结构化数据。
- 第一阶段可以直接拒绝超过本地配置上限的大文件。确有需要时再启用 Git LFS 或外部对象存储，并在事件中保存 content hash 和 locator；具体阈值和存储实现不是协议兼容条件。
- `.gitignore` 不是安全边界。
- 凭证、Codex auth、SSH 私钥、本地配置、绝对路径和完整 Agent transcript 不得写入群组仓库。

## 群组定义

`group.yaml` 示例：

```yaml
format: icarus.agent-group/1
protocol_version: 1
group_id: ag_01H...
name: Example Engineering Group
creator:
  principal_id: user_alice
  signing_key_ref: ssh-ed25519:SHA256:...
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

创建者初始化仓库时必须同时：

1. 生成 `group_initialized` 事件。
2. 注册自己的 Principal 和本地 Agent 公开能力。
3. 认领一个允许的角色。
4. 使用创建者密钥创建并 fast-forward push 一个签名 Git commit。

## 角色和成员

角色定义示例：

```yaml
format: icarus.agent-group-role/1
role: developer
display_name: Developer
cardinality:
  min: 1
  max: 1
allowed_transitions:
  - implement
executor_requirements:
  capability: coding_task
  interaction: visible_session
```

成员注册只公开协调需要的信息：

```json
{
  "format": "icarus.agent-group-member/1",
  "principal_id": "user_alice",
  "signing_key_ref": "ssh-ed25519:SHA256:...",
  "signing_public_key": "ssh-ed25519 AAAA...",
  "agent_id": "local-agent-01",
  "capabilities": ["coding_task", "visible_session"],
  "registered_at_event": "evt_01H..."
}
```

本地 Agent 的命令、服务地址、项目绝对路径、模型、凭证和权限配置只保存在本地 Icarus 数据库中，不进入成员注册文件。

### 角色认领规则

- 一个角色是否允许多人认领由 `min/max` 明确决定。
- 所有必需角色达到 `min` 后，Projection 从 `FORMING` 进入 `READY`。
- 创建者只能在 `READY` 状态执行 `start`。
- 群组运行时默认禁止直接修改角色定义或成员归属。
- 需要调整角色时，创建者先暂停并 drain 当前 Turn，再提交新 epoch 的成员变更。
- 每次 epoch 变化都会使旧 Turn 的 fencing token 失效。

## 状态模型

### 群组生命周期

```text
FORMING -> READY -> RUNNING
                    |   |
                    |   -> PAUSING -> PAUSED -> RUNNING
                    -> CLOSING -> CLOSED
```

| 状态 | 含义 |
| --- | --- |
| `FORMING` | 等待必需角色注册和认领 |
| `READY` | 必需角色满足，等待创建者启动 |
| `RUNNING` | 可以产生和认领新 Turn |
| `PAUSING` | 已停止产生新 Turn，等待已认领 Turn drain |
| `PAUSED` | 当前没有需要继续调度的活动 Turn，等待创建者恢复或关闭 |
| `CLOSING` | 停止新工作，等待活动 Turn 和必要清理结束 |
| `CLOSED` | 终态，只读保留历史 |

只有位于创建者签名 Git commit 中的命令可以触发：

- `start`
- `pause`
- `resume`
- `close`
- `recover_stalled_turn`
- `reassign_role`

### Turn 生命周期

```text
WAITING
  -> CLAIMED
  -> DISPATCHING
  -> RUNNING
  -> WAITING_INPUT / WAITING_APPROVAL
  -> SUCCEEDED / FAILED / CANCELLED / RECOVERY_REQUIRED
```

一个 Turn 至少包含：

```text
turn_id
group_id
epoch
state_revision
transition_id
action_id
role
attempt
idempotency_key
claim_event_id
fencing_token
input_hash
execution_ref
result_hash
artifact_refs
```

### 业务状态机

`machine.yaml` 允许 transition 回到已经访问过的状态：

```yaml
format: icarus.agent-group-machine/1
initial_state: development
states:
  development:
    transitions:
      - id: implement
        actor_role: developer
        action_ref: actions/implement.yaml
        outcomes:
          succeeded: review
          failed: development
  review:
    transitions:
      - id: review
        actor_role: reviewer
        action_ref: actions/review.yaml
        outcomes:
          approved: completed
          revise: development
  completed:
    terminal: true
```

状态机 Definition 可以存在终态，但群组不要求一定存在终态。创建者可以关闭一个仍处于非终态业务状态的群组，关闭事件必须记录原因。

## 事件协议

### 事件是事实源

控制分支上的事件链是唯一事实源。每个控制 commit：

- 必须以当前远端 HEAD 为父 commit。
- 必须具有可映射到事件 actor 的有效 Git commit 签名。
- 必须且只能追加一个通过当前协议 schema 的事件。
- 可以同时更新该事件明确授权的物化文件，例如成员、角色认领、`data/` 或 artifact 引用。
- 物化文件由同一个 Git tree 固定，不再在事件 payload 中重复维护一套文件 hash 清单。
- 可以同步更新可验证 Projection，但 Projection 不是独立写入权限。
- Git parent commit 构成事件链，不再重复维护 `previous_event_hash`。
- 事件包含协议版本、epoch、sequence、actor 和预期状态 revision；签名属于 Git commit，不在 payload 中重复签名。
- 通过普通 fast-forward push 提交。

事件 envelope 示例：

```json
{
  "format": "icarus.agent-group-event/1",
  "protocol_version": 1,
  "group_id": "ag_01H...",
  "event_id": "evt_01H...",
  "epoch": 1,
  "sequence": 42,
  "event_type": "turn_claimed",
  "actor": {
    "principal_id": "user_alice",
    "agent_id": "local-agent-01"
  },
  "expected": {
    "state_revision": 7
  },
  "payload": {
    "turn_id": "turn_01H...",
    "role": "developer",
    "attempt": 1,
    "fencing_token": "sha256:..."
  },
  "occurred_at": "2026-08-04T12:00:00Z"
}
```

`occurred_at` 只用于审计和展示，不能作为自动 lease 过期的唯一依据。

### 核心事件类型

```text
group_initialized
member_registered
role_claimed
role_released
group_ready
group_started
group_pause_requested
group_paused
group_resumed
group_close_requested
group_closed
turn_created
turn_claimed
action_dispatched
action_waiting_input
action_waiting_approval
action_succeeded
action_failed
action_cancelled
data_updated
artifact_published
state_transitioned
stalled_turn_recovery_requested
turn_recovered
protocol_recovery
```

### Projection

每个 Icarus 从 genesis 事件顺序重放：

```text
Git event commits
  -> protocol version validation
  -> event schema validation
  -> Git commit signature validation
  -> authorization validation
  -> parent / sequence / state revision validation
  -> deterministic reducer
  -> local Projection
```

`projection/state.json` 可以随 commit 更新以加速 UI，但必须能从事件链重新计算并验证。Projection 不一致时，以重放结果为准并生成完整性告警。

### 非法提交恢复

遇到以下情况时，本地实例不得继续执行：

- 控制分支被 force push 或历史重写。
- 仓库协议版本不受当前 Icarus 支持。
- 事件 schema 无效。
- Git commit 签名无效、signer 与 actor 不匹配或 actor 无权限。
- parent、sequence 或 state revision 不连续。
- Projection 与事件重放结果不一致。

不支持的协议版本进入 `PROTOCOL_VERSION_UNSUPPORTED`，其他完整性错误进入 `PROTOCOL_QUARANTINED`。第一阶段通过创建者签名 Git commit 中的 `protocol_recovery` 事件显式确认最后有效事件和处置方式；不能静默忽略完整性失败。

## 并发认领

多个 Icarus 可能同时发现同一个 `WAITING` Turn。认领算法：

1. `git fetch` 控制分支。
2. 校验并重放到远端 HEAD。
3. 确认 Turn 仍为 `WAITING`，且本地 Principal 持有所需角色。
4. 基于当前 HEAD 创建包含 `turn_claimed` 事件的签名 Git commit。
5. 普通 push 到控制分支。
6. push 成功者获得执行权。
7. non-fast-forward 失败者重新 fetch 和重放，不得执行动作。

这提供 claim 之前的单赢家语义，但不能提供外部副作用的 exactly-once。执行器必须使用稳定 `idempotency_key`，并在恢复时先查询已有 execution receipt。

## Poller 和调度

每个已加入群组的 Icarus 启动本地 Poller：

```text
timer tick
  -> fetch remote control branch
  -> validate + reduce
  -> update local Projection/UI
  -> detect actionable Turn for local roles
  -> attempt claim
  -> dispatch executor only after push succeeds
  -> observe execution
  -> append result and transition events
```

建议配置：

- 默认轮询间隔由本地配置决定。
- 增加 deterministic jitter，避免所有参与者同时 fetch。
- 网络失败指数退避。
- 用户可手动执行“立即同步”。
- 后续可以增加 Git provider webhook 作为加速信号，但 webhook 不能取代 fetch 和协议校验。
- 同一机器上的多个 Icarus 进程必须通过本地锁避免对同一群组重复调度。

## Pause、Close 和恢复语义

### Pause

默认策略为 drain：

- 创建者提交 `group_pause_requested`。
- Projection 进入 `PAUSING`。
- 不再创建或认领新 Turn。
- 已经处于 `CLAIMED/RUNNING` 的 Turn 允许完成。
- 活动 Turn 终止后提交 `group_paused`。

强制取消不是普通 pause 的隐含行为。如未来支持，必须作为单独高风险命令并记录每个执行器的取消结果。

### Close

- `group_close_requested` 后停止新工作。
- 等待活动 Turn 完成、取消或被显式处置。
- `group_closed` 是不可逆终态；重新开展工作应创建引用原群组的 successor 群组，而不是删除历史或在原群组创建新 epoch。

### Stalled Turn

纯 Git 没有可信统一时钟，第一阶段不根据参与者提交时间自动抢占执行权。

- 卡死 Turn 进入 `RECOVERY_REQUIRED`。
- 创建者人工确认后提交 `recover_stalled_turn`。
- 新 attempt 获得新的 fencing token。
- 旧 attempt 后续提交结果时因 fencing token 失效被拒绝。
- 恢复前必须查询外部执行器是否已经产生结果或副作用。

## Action Executor 抽象

### 通用接口

Collaboration Runtime 只依赖统一 Action Executor 契约：

```ts
interface ActionExecutor {
  prepare(request: ActionRequest): Promise<PreparedAction>;
  dispatch(action: PreparedAction): Promise<DispatchReceipt>;
  observe(executionRef: string): Promise<ActionObservation>;
  cancel(executionRef: string, reason: string): Promise<CancelResult>;
  recover(executionRef: string): Promise<ActionObservation>;
}
```

共同要求：

- `dispatch` 接受稳定 `idempotency_key`。
- 返回 Icarus 自己的 `execution_ref`，不把 provider 主键作为通用主键。
- 状态统一映射为通用 Turn 状态。
- provider 私有字段存入 namespaced metadata。
- 完成结果必须满足 Action 声明的 `result_schema`。
- Executor 不能直接推进群组状态；只能提交执行观察，由 Collaboration Runtime 验证后生成 transition 事件。

### Executor 类型

| kind | 实现 | 说明 |
| --- | --- | --- |
| `run_once` | 现有 internal agent run-once service | 一次性本地 Agent 任务 |
| `workflow` | Dynamic Workflow Runtime adapter | 创建有限 Workflow Run 并观察其终态 |
| `external` | External Executor adapter registry | 调用 Codex 或其他外部 Agent 服务 |

Action 示例：

```yaml
format: icarus.agent-group-action/1
action_id: implement_feature
kind: external
adapter: codex-task
input:
  prompt_ref: prompts/implement-feature.md
  workspace_ref: role_workspace
requirements:
  capability: coding_task
  interaction: visible_session
  filesystem_access: workspace_write
result_schema:
  ref: code-change-result@1
```

## External Executor 协议

通用 External Executor 只定义：

- dispatch、observe、cancel、recover。
- 通用状态和错误分类。
- 幂等键、execution ref、输入输出 hash。
- 权限需求和本地权限上限比较。
- 轻量结果 schema 和 artifact refs。

以下内容不能进入通用协议本体：

- Codex `thread_id`、`turn_id`。
- `thread/start`、`turn/start`、`wait_threads`。
- `codex://` deep link。
- Codex sandbox 或 approval policy 的具体 wire enum。
- App Server 的 stdio、Unix socket 或 WebSocket 参数。

这些字段属于具体 adapter 的 provider metadata。

## `codex-task` External Adapter

### 分层

```text
External Executor Protocol
  └── CodexTaskExecutorAdapter (`codex-task`)
        └── transport: app_server
```

`codex-task` 是 `external` 下的正式适配器。`codex-desktop-bridge` 可以作为内部模块描述，但不是另一种协议类型。

### 复用现有 Codex 实现

当前项目已经存在以下实现：

```text
src/workflow-execution/codex/app-server-client.ts
  ├── existing Workflow CodexTaskAdapter
  └── Collaboration CodexTaskExecutorAdapter
```

Collaboration 的 `codex-task` 保持 `external` 语义，但实现必须复用现有 `CodexAppServerClient` 的 initialize、thread start/name、turn start、recover、interrupt 和事件解析，不再创建第二套 App Server JSON-RPC client。可以在实现时把 provider-neutral 的状态与结果映射提取为共享 helper，由 Workflow 和 Collaboration 两个薄 adapter 使用。

现有 `CodexTaskAdapter`、`WorkflowAdapterExecutionContext` 和 `WorkflowAdapterExecutionStore` 包含 Workflow graph、scope、outbox 和 lease 字段，不能通过填充虚假 Workflow identity 直接作为 Collaboration 执行记录。Collaboration 使用自己的 `collaboration_action_executions` 保存 operation key、provider metadata 和 receipt，只复用 provider client、能力 preflight、结果 schema 和错误映射。

群组仓库中的 `adapter: codex-task` 在本地映射到现有 `icarus.adapter.codex-task` provider capability；该内部 ID 和源码目录不进入共享 Git 协议。

后续如明确变更方案，可以新增：

```text
codex-task
  ├── app_server
  └── deep_link
```

当前版本只允许 `app_server`，没有自动 fallback。Web UI 中“在 Codex 中打开”可使用
`codex://threads/{thread_id}` 导航到已经由 App Server 创建的任务；该导航不创建任务，也不是
dispatch transport 或 fallback。

### App Server 映射

根据 Codex App Server 的公开接口，适配器按以下方式映射：

| External Executor 操作 | Codex App Server |
| --- | --- |
| `dispatch` | `thread/start`、`thread/name/set`、`turn/start` |
| `observe` | `turn/*`、`thread/status/changed`、必要时 `thread/read` |
| `cancel` | `turn/interrupt` |
| `recover` | `thread/read`、`thread/resume`、运行态事件重建 |
| provider execution identity | `thread_id` + `turn_id` |

v1 直接复用现有 client，通过 `codex app-server --listen stdio://` 通信。SDK、Unix socket 和实验性 WebSocket 都不作为第一阶段实现路径；后续只有出现明确需求时才增加新的 provider transport。

参考：

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex Desktop deep links](https://learn.chatgpt.com/docs/reference/commands)

### 本地配置

群组仓库只声明 `adapter: codex-task` 和能力需求。每个用户在本地配置：

```yaml
external_adapters:
  codex-task:
    transport: app_server
    codex_binary: /local/path/to/codex
    workspace: /Users/example/project
    desktop_visibility: required
    filesystem_access_cap: workspace_write
    approval_policy: on_request
```

配置文件中的枚举是 Icarus 规范化值。Adapter 必须根据当前安装的 Codex App Server schema 映射成 wire 值，不能假设不同 Codex 版本使用完全相同的字段拼写。安装或升级 Codex 后应重新执行 capability preflight。当前 preflight 在 claim 前调用 App Server `initialize` 并按 cwd 缓存成功结果；它能发现进程启动和初始化错误，但不能保证发现只在 `thread/start` 才出现的 CLI/配置兼容问题。后者在 dispatch 时继续 fail closed。

### Provider metadata

```json
{
  "execution_ref": "external:01H...",
  "adapter": "codex-task",
  "provider_metadata": {
    "transport": "app_server_stdio",
    "thread_id": "thr_123",
    "turn_id": "turn_456",
    "cli_version": "observed-codex-version",
    "ephemeral": false
  }
}
```

完整 provider metadata 保存在本地。共享事件只记录必要的 opaque execution ref、状态、结果 hash 和 artifact refs。

### 无 fallback 决策

当前行为固定为：

```text
App Server dispatch/visibility precondition failed
  -> action BLOCKED
  -> reason = codex_desktop_thread_unavailable
  -> 群组不推进
  -> 不自动打开 deep link
```

如果实机验证表明 App Server 创建的 thread 无法满足桌面 App 可见性要求，应通过新的设计决策和 adapter transport 版本改为 deep link，而不是在运行时静默降级。

### Codex App Server 实机验证

正式实现 `codex-task` 前必须完成独立 Spike：

1. App Server 创建非 ephemeral thread。
2. 设置 thread 名称、项目 cwd、权限和审批策略。
3. 启动 turn 并获取 `thread_id`、`turn_id`。
4. Codex 桌面 App 能发现或通过 `codex://threads/{thread_id}` 打开该 thread。
5. 桌面 App 重启后 thread 仍可见。
6. 用户可以在桌面 App 中继续对话。
7. Icarus 能观察桌面 App 后续 turn 的状态和结果。
8. `turn/interrupt`、等待审批、失败和恢复可以稳定映射。
9. 不同项目目录和权限配置不会串到其他群组或角色。

任何关键条件失败都表示 `codex-task/app_server` 暂不可启用，不进入 fallback。

2026-08-05 的实机验证完成了非 ephemeral thread、名称、cwd、桌面可见性、首轮结果、桌面侧继续会话和 Icarus recover 读取。验证使用 Desktop 内置 `/Applications/ChatGPT.app/Contents/Resources/codex`（`0.146.0-alpha.9.2`）。Homebrew `0.144.5` 可以 initialize，但在 `thread/start` 解析较新的 agent-role 配置时失败。Desktop 重启后的持久可见性未自动验证；当前共享 client 对 App Server approval request 的策略是拒绝并 interrupt，所以 Codex approval 不会进入可由 Icarus 恢复的 `WAITING_APPROVAL`。这些项目保留为明确的发布检查或 provider 能力限制，不增加 deep-link fallback。

## 本地持久化

Git 是共享事实源，本地 SQLite 保存执行和 UI 所需状态。v1 使用独立的 Collaboration Runtime 数据域，不把跨机器状态或本地 receipt 写入现有 Workflow Runtime 数据库。建议使用 `STORE_DIR/collaboration.db`，使迁移、备份和重置范围与 `workflow-runtime.db`、`workflow-adapter-executions.db` 明确分离。

概念表：

```text
collaboration_groups
collaboration_remotes
collaboration_memberships
collaboration_role_bindings
collaboration_projection_heads
collaboration_events_cache
collaboration_turns
collaboration_action_executions
collaboration_executor_bindings
collaboration_sync_attempts
collaboration_integrity_incidents
```

其中：

- Git 事件 cache、Projection 和同步尝试可以删除后重建。
- 本地 executor binding、路径、权限上限和用户审批不能从 Git 重建，也不能上传。
- `collaboration_action_executions` 保存本机 dispatch receipt 和 provider metadata。
- 每条本地执行记录必须关联 group id、epoch、turn id、attempt 和 fencing token。

### 本地 Schema 兼容

Git `protocol_version` 与本地 SQLite schema version 是两个独立版本：前者决定多个实例如何解释共享事件，后者只决定当前 Icarus 如何读取本机执行状态，二者不能互相替代或绑定 hash。

`collaboration.db` 沿用当前 Workflow Store 轻量化后的兼容原则：

- 使用整数 `PRAGMA user_version`。
- 只支持明确的逐版本事务迁移。
- 当前版本启动时检查必要表、列和索引。
- 未知版本、迁移失败或结构缺失时只阻塞 Collaboration Runtime，不带病启动 Scheduler 或 Executor。
- 不生成物理 schema hash、完整文件 manifest、frozen identity 或 contract pack。
- 普通实现修改不升级 schema version；只有持久化结构或语义变化才升级。

Host Core 仍可启动并提供会话等其他能力。Web“群组”页面显示本地数据不兼容和恢复入口，不把 Collaboration 数据错误扩大为整个 Icarus 不可用。

### Receipt 和恢复

以下本地状态不能从 Git 重建，必须跨进程重启保留：

- claim 成功后的 dispatch reservation 和稳定 operation/idempotency key。
- Executor 接受动作的 receipt。
- Codex thread/turn、Workflow execution ref 和其他 provider metadata。
- 终态结果尚未成功 push 时的待提交 Observation。

如果 Git 显示本机持有有效 claim，但 receipt 缺失或状态不确定，Turn 进入 `RECOVERY_REQUIRED`。Icarus 只能在已有 execution ref 足以执行 provider observe/recover 时自动恢复；不能因为本地进程不存在或 receipt 缺失就自动重新 dispatch。

v1 不提供普通的“清空 Collaboration 状态”按钮。未来若增加破坏性 reset，必须复用当前 Workflow state recovery 的最小安全原则：精确限定 DB/WAL/SHM 路径、排除运行进程、显示目标并确认、先复制并校验带 manifest 的备份、再删除 live unit，并提供显式 restore。清理可重建的 event cache/Projection 应使用独立事务，不得同时删除 receipt、binding 或权限配置。

## 身份、签名和授权

### 身份

Git commit author 可以伪造，不能作为协议身份。轻量协议直接复用 Git commit 签名，不再给事件 payload 增加第二层签名 envelope。第一阶段至少要求：

- 创建者在 genesis 中固定 SSH 签名公钥和 fingerprint。
- 成员注册 commit 由成员声明的密钥签名，角色认领沿用该 Principal 身份。
- 生命周期命令 commit 由创建者密钥签名。
- Turn claim 和执行结果 commit 由持有角色的成员密钥签名。
- 每个 Icarus 在重放时独立验证 Git commit 签名、signer 与事件 actor 的映射以及 actor 权限。

v1 只实现 Git SSH signing，复用 Git commit object 已覆盖的 parent、tree 和 message，不再定义独立 canonical bytes 或 domain-separated payload hash。GPG 或其他签名方式只在出现实际兼容需求后作为新协议能力增加，不提前抽象多套签名实现。

### 授权矩阵

| 操作 | 创建者 | 已认领角色成员 | 普通已注册成员 |
| --- | --- | --- | --- |
| 注册自己 | 是 | 是 | 是 |
| 认领允许角色 | 是 | 是 | 是 |
| 启动/暂停/恢复/关闭 | 是 | 否 | 否 |
| 认领当前角色 Turn | 角色匹配时 | 角色匹配时 | 否 |
| 提交自己的执行结果 | 是 | 是 | 否 |
| 强制恢复或重分配 | 是 | 否 | 否 |
| 修改状态机或角色定义 | 暂停后按版本变更 | 否 | 否 |

## 安全边界

### Prompt 和仓库内容不可信

任务群组由多个用户共同写入，仓库中的 prompt、data、commit message 和 artifact 都属于不可信输入。

- Prompt 模板必须经过结构化渲染，不能直接拼接 shell 命令。
- 隐藏文本、路径逃逸、symlink 和恶意仓库内容需要校验。
- 远端 Action 不能指定任意本机绝对路径。
- 远端 Action 不能选择 `danger-full-access` 或关闭本地审批策略。
- 本地用户必须可以查看某个角色的最终有效 prompt 和权限摘要。

### 权限求交

```text
if local configured maximum covers group action requirement:
    effective access = least privilege that satisfies the requirement
else:
    BLOCKED/local_permission_insufficient
```

如果任务要求超过本地上限：

```text
BLOCKED
reason = local_permission_insufficient
```

不能自动请求永久扩权。一次性用户审批只影响当前 execution，且必须写入本地审计。

### 副作用和幂等

- Claim 必须先成功 push，再 dispatch Executor。
- 每次 dispatch 使用稳定 idempotency key。
- 外部副作用必须保存 receipt 并支持 reconcile。
- Crash 后不能仅凭本地进程不存在就判断外部动作未执行。
- 恢复前先 observe/recover，再决定是否创建新 attempt。
- 旧 attempt 的 fencing token 失效后不得提交可推进状态的结果。

## Web 客户端方案

### 一级导航调整

现有一级导航：

```text
群组
```

调整为：

```text
会话   <- 原有 Agent 消息、文件和上下文页面
群组   <- 新的 Agent Group Collaboration Runtime 入口
```

建议 canonical routes：

```text
/sessions                         现有会话入口
/groups                           新群组列表
/groups/{groupId}                 群组详情
/groups/{groupId}/roles           成员和角色
/groups/{groupId}/runtime         状态机和当前 Turn
/groups/{groupId}/events          事件时间线
/groups/{groupId}/data            公共数据和产物
/groups/{groupId}/settings        本地 Executor 配置
/groups/{groupId}/diagnostics     同步、完整性和本地恢复诊断
```

由于 `/groups` 将承载新语义，原有 deep link 和路由应迁移到 `/sessions`，不能继续把旧 `/groups` 同时保留为会话别名。

### 群组列表

群组一级页面提供：

- 创建群组：输入 Git URL、群组名称、状态机定义和创建者角色。
- 加入群组：输入已初始化的 Git URL。
- 展示已加入群组、生命周期、同步状态、当前业务状态和本地角色。
- 手动立即同步。
- 显示协议版本不支持、协议隔离、Git commit 签名失败和远端不可用状态。

第一阶段“加入”依赖已知 URL，不称为“搜索”。真正搜索需要后续注册中心。

### 群组详情

详情页至少包含：

| 视图 | 内容 |
| --- | --- |
| Overview | 生命周期、业务状态、创建者、Git remote、最新同步、当前 Turn |
| Roles | 必需角色、认领情况、本地 Agent 绑定、能力满足情况 |
| Runtime | 状态机、可用 transition、活动 Turn、阻塞和恢复操作 |
| Events | 事件时间线、签名 commit、actor 和校验状态 |
| Data | `data/`、artifact refs 和 work branch commit |
| Settings | 本地 workspace、Executor、权限上限、轮询策略和通知 |
| Diagnostics | 最近同步尝试、Scheduler 错误、完整性事件、本地备份和显式恢复 |

### 操作权限

- 所有成员可以查看群组状态和事件。
- 参与者只能配置自己的本地 Executor 和角色绑定。
- 创建者界面显示启动、暂停、恢复、关闭和强制恢复命令。
- 非创建者不渲染创建者命令为可点击动作；后端仍必须独立鉴权。
- 高风险命令显示预期状态 revision 和将受影响的活动 Turn。

### Codex 任务展示

当 `codex-task` dispatch 成功时，UI 显示：

- Icarus execution ref。
- Codex thread/turn 的本地状态。
- “在 Codex 中打开”动作。
- 当前是否等待审批或输入。
- 最终摘要、artifact refs 和 Git commit。

Codex provider id 不上传到群组仓库；它只在拥有该本地执行的用户 UI 中显示。

## Host API 和服务边界

建议新增 core services：

```text
CollaborationGroupService
CollaborationGitTransport
CollaborationProtocolValidator
CollaborationEventReducer
CollaborationScheduler
CollaborationCommandGateway
ActionExecutorRegistry
CodexTaskExecutorAdapter
```

建议 Web API namespace：

```text
/api/collaboration/groups
/api/collaboration/groups/{id}
/api/collaboration/groups/{id}/sync
/api/collaboration/groups/{id}/roles
/api/collaboration/groups/{id}/commands
/api/collaboration/groups/{id}/events
/api/collaboration/groups/{id}/executors
/api/collaboration/groups/{id}/diagnostics
/api/collaboration/backup
/api/collaboration/restore
```

所有 UI 命令先进入 `CollaborationCommandGateway`，由它执行：

1. 本地身份认证。
2. 群组 actor 授权。
3. expected revision 校验。
4. 事件生成和 Git commit 签名。
5. Git CAS push。
6. 本地 Projection 更新和审计。

Renderer 不直接执行 Git 命令，不直接调用 Codex App Server。

## 与现有 Runtime 的边界

### Dynamic Workflow Runtime

- 不改变其无环 Compiler 语义。
- 不把群组长期状态保存为第二份 Workflow 当前状态。
- 每个 workflow Action 创建一个正常有限 Workflow Run。
- Workflow 终态通过 adapter 转换为 Action Observation。
- Collaboration Runtime 只在验证 Observation 后推进群组 FSM。

Workflow Action 的调用边界固定为：

```text
CollaborationWorkflowExecutor
  -> existing workflow-execution service
  -> workflow-runtime/gateway/connection
  -> workflow-runtime/gateway/execution
```

Collaboration 不能直接 import Workflow Store、runtime、compiler、scheduler 或历史 certification 目录，也不能使用只供 Host Core schema 检查的 `gateway/host-core`。如果当前用途 gateway 缺少创建或观察有限 Workflow Run 所需的操作，应在对应 gateway 增加最小导出，而不是绕过边界或建立聚合 barrel。

实现使用本地 `icarus.collaboration-workflow-launch-profile/1` 描述可复用的有限 Workflow 启动模板。Host service 校验 `workflow_ref` 和 prompt hash，并拥有 request id、creation domain/key、时间与 intent hash 等动态字段；Collaboration 不生成或伪造 Workflow graph、scope、outbox 或 lease 上下文。

Dynamic Workflow Runtime 当前行为见 [Dynamic Workflow Runtime](dynamic-workflow-runtime.md)。群组协议不把其内部接口、SQLite schema version、Registry identity 或 Node runtime identity 纳入群组 v1，也不由本方案隐式改变其无环执行语义。

### Internal Agent run-once

- run-once 是 `ActionExecutor` 的一种实现。
- Collaboration Runtime 为每次 dispatch 生成独立 query trace 和 idempotency key。
- Agent 只能访问 Action 授权的数据和 workspace。
- 显式 workspace 必须先通过现有 mount allowlist；容器内固定挂载到 `/workspace/project`，按有效权限使用只读或读写 mount，并遮蔽 workspace `.env`。未授权路径在 claim 前 fail closed。
- run-once 完成不等于群组已转换；仍需 `result_schema` 和 fencing 校验。

### Feature Package Runtime

Agent Group Collaboration Runtime 属于 core 执行和协调能力。Feature 可以贡献角色模板、FSM 模板、Action 定义或 UI 扩展，但不能维护独立事实源或绕过 Collaboration Command Gateway。

### Host Core 和本地运行时

- Agent Group Collaboration Runtime 随当前 checkout 或已选择的 Host Core local snapshot 运行，不建立自己的 publish、activate、certification 或 release manifest。
- Collaboration 本地 schema 的支持范围是 Host 代码兼容信息，不是 Git `protocol_version`。启用 active snapshot 后若本地 schema 不受支持，只阻塞 Collaboration 子系统并提示恢复，不修改数据库。
- Collaboration 不建立独立 Node distribution identity、可执行文件 hash 或 `active-node` 指针；它使用 Host Core 已配置并通过 major、platform/arch、native ABI smoke 的 Node。
- Codex binary、App Server schema 和桌面可见性仍由 `codex-task` adapter preflight 独立验证，不进入 Host Core snapshot identity。

## 失败模型

| 场景 | 行为 |
| --- | --- |
| Git fetch 失败 | 本地显示离线，指数退避，不执行新 Turn |
| claim push non-fast-forward | 重新 fetch；当前实例不执行 |
| 控制分支被重写 | `PROTOCOL_QUARANTINED` |
| 协议版本不支持 | `PROTOCOL_VERSION_UNSUPPORTED`，停止写入和执行 |
| Git commit 签名或事件无效 | `PROTOCOL_QUARANTINED` |
| 本地 Collaboration schema 不兼容 | 只阻塞 Collaboration Runtime，不迁移或重置未知数据 |
| 本地角色未配置 Executor | `BLOCKED/executor_unconfigured` |
| 本地权限不足 | `BLOCKED/local_permission_insufficient` |
| App Server 不可用 | `BLOCKED/codex_app_server_unavailable` |
| Codex thread 不可桌面显示 | `BLOCKED/codex_desktop_thread_unavailable`，无 fallback |
| Executor 等待审批 | 支持该状态的 Executor 进入 `WAITING_APPROVAL`，不创建新 attempt；当前 Codex client 拒绝 approval request 并 interrupt |
| Icarus crash 后重启 | 从 Git 重放，查询本地 receipt，执行 recover/observe |
| 有效 claim 的本地 receipt 缺失 | `RECOVERY_REQUIRED`，禁止盲目重新 dispatch |
| 执行完成但结果 push 失败 | 保留 receipt，重试同一结果事件，不重新执行 |
| Turn 长期无结果 | 创建者显式 recover，生成新 fencing token |
| 群组 pause 时仍有运行任务 | drain；不产生新 Turn |

## 实施结果

2026-08-05 已在当前分支完成以下实现：

- `src/collaboration/protocol/` 提供 v1 schema、Git SSH 签名验证、授权、严格线性事件链、确定性 reducer、循环 FSM、claim/fencing、materialized member/role claim 校验和 quarantine。
- `CollaborationGroupService`、Git transport 与 Scheduler 提供创建、已知 URL 加入、角色认领、READY 校验、创建者生命周期命令、轮询/jitter/backoff、跨进程 group lock heartbeat、安全 claim 后 dispatch、drain 和人工 recovery。
- run-once、Workflow 和 external/codex-task 三类 Executor 已接入；Workflow 只经过受支持的 host service 与 `workflow-runtime/gateway/connection`、`gateway/execution`，Codex 复用现有 `CodexAppServerClient` 与 provider 映射。
- `STORE_DIR/collaboration.db` 使用整数 schema version、事务迁移和完整结构 smoke；projection、event cache 和同步历史可重建，binding、receipt 与 provider metadata 由精确备份/显式恢复保留。有效 claim 缺 receipt 时进入 `RECOVERY_REQUIRED`，不会盲目重新 dispatch。
- Web 入口为 `/groups`，原会话入口为 `/sessions`，Host API 为 `/api/collaboration/groups`。群组页面提供创建/加入、角色与绑定、生命周期、运行、事件、数据、设置、同步历史、完整性诊断、备份和恢复。
- 所有协议、并发、恢复、Executor、Host/API、桌面路由和响应式 Web 测试均使用临时 Git remote、SQLite 和目录；不依赖或清理用户真实 Collaboration 数据。

## 实施阶段

### Phase 0：Codex App Server Spike

- 验证 thread 持久化和桌面可见性。
- 验证 cwd、权限、审批、继续会话和事件观察。
- 验证当前 Codex CLI 的 App Server methods/fields 和版本 preflight。
- 形成可重复的自动化验证脚本和人工桌面验收步骤。
- 验收条件未满足则停止 `codex-task` 实现，不自动改用 deep link。

2026-08-05 实机结果记录在
[Codex App Server Collaboration Spike](codex-app-server-collaboration-spike.md)。桌面 App 自带的
`codex-cli 0.146.0-alpha.9.2` 已验证非 ephemeral thread 创建、准确 cwd、桌面任务列表可见、
首个 turn 状态/结果获取、桌面侧继续会话以及 Icarus 通过现有 client 恢复读取后续 turn。
独立 Homebrew `codex-cli 0.144.5` 能完成 initialize，但在 `thread/start` 时无法解析当前桌面配置中的
较新 agent-role 结构，因此 dispatch fail closed，不得 fallback。为避免中断其他正在运行的用户任务，本次
没有自动重启桌面 App；重启后的持久可见性保留为新主机/发布时的人工检查。

### Phase 1：Git 协议和 Reducer

- 在 `src/collaboration/protocol/` 定义 `group/machine/role/member/action/event` v1 schemas、版本检查和授权规则。
- 使用 Git commit parent/tree/signature 作为已有完整性机制，不建立第二套事件 hash 链或 payload 签名。
- 实现 Git SSH commit 签名验证和授权矩阵。
- 实现 deterministic reducer 和 Projection 重建。
- 增加少量固定 `events -> expected projection` 测试向量；不生成 contract pack、seal 或 conformance 历史。
- 实现 init、join、role claim、start、pause、resume、close 命令。
- 实现 fast-forward claim 竞争测试。

### Phase 2：Collaboration Scheduler

- 实现 remote fetch/push transport。
- 实现 timer、jitter、backoff 和本地单实例锁。
- 实现 `collaboration.db` 的整数 schema version、事务迁移和必要结构 smoke。
- 区分可重建 Projection/cache 与必须保留的 binding、receipt 和 provider metadata。
- 实现 Turn 创建、认领、fencing、结果提交和人工恢复。
- 接入 run-once Executor。
- 接入 Workflow Executor。

### Phase 3：External Executor 和 Codex

- 实现 `ActionExecutorRegistry` 和 External Executor 通用契约。
- 实现 Collaboration `CodexTaskExecutorAdapter` 薄适配层，复用现有 `CodexAppServerClient`、provider 状态映射和 `result_schema`。
- 不复用带 Workflow graph/outbox context 的 `WorkflowAdapterExecutionStore`，也不复制 App Server JSON-RPC client。
- 保存 thread/turn provider metadata。
- 实现 observe、cancel、recover 和 `result_schema` 校验。
- 只启用 `transport: app_server`。

### Phase 4：Web 客户端

- 原“群组”一级导航更名为“会话”。
- 新增“群组”一级导航。
- 实现创建、加入、角色认领、状态、事件、数据和设置页面。
- 实现创建者控制动作和普通成员权限视图。
- 实现 Codex 本地任务状态和打开入口。

### Phase 5：安全和可运维性

- 提供远端禁止 force push/delete 的配置提示，不为不同 Git provider 实现阻塞式兼容认证。
- 协议 quarantine 和 recovery。
- 在出现实际大文件需求时接入 Git LFS 或外部 artifact locator，不把存储阈值写入协议。
- 为不可重建的本地 receipt 提供精确 DB/WAL/SHM 备份和显式 restore；v1 不提供普通 reset，event cache/Projection 清理保持独立。
- 通知、Trace 和故障诊断导出。

### Future：发现和更多 Adapter

- 可选群组注册中心和搜索。
- Git provider webhook 加速。
- `codex-task/deep_link` transport，前提是单独设计并明确迁移。
- 其他外部 Agent adapter。
- 经过可信时间源支持的自动 lease。
- 只有在真实重放或同步性能成为问题后，才设计 Projection checkpoint 或事件压缩；不得原地重写已签名控制历史。

## 测试和验收

### 协议测试

- 声明同一 `protocol_version` 的 Icarus 构建对固定输入事件得到完全一致 Projection。
- reducer 不读取本地时间、网络、provider 状态或本地 Executor 配置。
- 未知或不兼容协议版本停止写入和执行。
- 两个成员同时 claim 时只有一个 fast-forward push 成功。
- loser 不 dispatch Executor。
- 非法 Git commit 签名、错误角色、错误 revision 和历史重写全部 fail closed。
- `A -> B -> A` 循环可以持续多轮且每个 Turn identity 唯一。
- 旧 epoch 和旧 fencing token 不能提交有效结果。
- Projection 删除后可从 genesis 完整重建。
- 协议测试只产生普通测试结果，不生成 contract pack、sealed baseline 或源码 hash。

### 故障恢复测试

- claim 成功后、dispatch 前 crash。
- dispatch 成功后、receipt 持久化前 crash。
- Executor 完成后、Git result push 前 crash。
- result commit 创建后、push non-fast-forward。
- pause、close 与活动 Turn 竞态。
- 人工 recovery 后旧执行迟到返回。

### 本地持久化测试

- fresh `collaboration.db` 初始化到当前整数 schema version。
- 每个受支持旧版本通过逐版本事务迁移，未知新版本 fail closed。
- 必要表、列或索引缺失时只阻塞 Collaboration Runtime。
- 删除 event cache/Projection 后可从 Git 重建，binding 和 receipt 保持不变。
- claim 后重启可以根据 receipt recover/observe，不重复 dispatch。
- claim 存在但 receipt 缺失时进入 `RECOVERY_REQUIRED`。
- DB/WAL/SHM 备份可以校验并显式 restore，且完整保留未决 receipt。

### Executor 测试

- run-once、workflow、external 产生相同的通用状态映射。
- 每个 Executor 遵守 idempotency key。
- 本地权限小于远端需求时阻塞。
- provider metadata 不进入共享 Git 事件。
- `result_schema` 校验失败不能推进状态机。
- Collaboration Codex adapter 与现有 Workflow Codex adapter 共享 App Server client 行为，不存在第二套 RPC 映射。

### Codex Spike 验收

- `thread/start -> thread/name/set -> turn/start` 全链路成功。
- thread 在桌面 App 中可见、可打开、可继续。
- App 重启后 thread 可恢复。
- Icarus 能捕获完成、失败、等待审批和中断。
- 不同本地 workspace 和 permission policy 正确隔离。
- 失败时产生明确 blocker，不发生 deep link fallback。

本机 spike 已验证完成、桌面继续会话和 recover 读取；未重启 Desktop。当前共享 App Server client 会拒绝 approval request 并 interrupt，因此 Codex 等待审批不是本版本可继续的 waiting 状态。协议和 Workflow Executor 仍保留通用 `WAITING_APPROVAL` 映射。

### UI 验收

- 原会话能力在“会话”导航中完整保留。
- 新“群组”导航与会话语义不混淆。
- 创建者和普通成员看到正确的命令权限。
- 网络离线、协议 quarantine、权限不足、Executor 阻塞均有明确状态。
- 当前 Turn、角色归属和下一步动作无需读取原始 Git 文件即可理解。

## 关键不变量

实现和评审必须持续验证以下不变量：

1. 只有远端控制分支上、位于有效签名 Git commit 中的授权事件可以推进共享状态。
2. Claim push 成功之前不得 dispatch 动作。
3. Executor 结果不能直接修改群组 Projection。
4. 旧 fencing token 永远不能推进新 revision。
5. 远端配置永远不能扩大本地权限。
6. 本地路径、凭证和 provider transcript 永远不进入群组仓库。
7. 群组循环不改变现有 Workflow Runtime 的无环语义。
8. `codex-task` 当前只有 App Server transport，失败时不 fallback。
9. Projection 可以完全从事件链重建。
10. 本地 receipt 不能从 Git 重建；receipt 缺失或不确定时不得盲目重新 dispatch。
11. UI 权限不是安全边界，所有命令必须由 Host Gateway 再鉴权。

## 已确认的设计决策

| 决策 | 结论 |
| --- | --- |
| 第三种操作模式 | Agent Group Collaboration Runtime |
| 协调事实源 | Git 远端控制分支上的签名 commit 事件链 |
| 协议形态 | Icarus 源码拥有的轻量 Git Collaboration Protocol，不建立独立 Machine Contract 体系 |
| 协议兼容 | 版本不匹配时停止写入；暂停群组、统一升级、显式迁移并开启新 epoch |
| 独立实现 | v1 只支持 Icarus 实现协议；其他 Agent 服务通过 Executor 接入 |
| 流程模型 | 允许循环的有限状态机 |
| 具体动作 | run-once、workflow、external |
| Workflow 接入 | 通过现有 host service 和 `gateway/connection`、`gateway/execution`，不直连 Runtime internals |
| Codex 归属 | `external` 下的 `codex-task` adapter |
| Codex transport | App Server only |
| Codex 实现 | Collaboration 薄 adapter 复用现有 `CodexAppServerClient`，不复制 RPC client 或伪造 Workflow context |
| Codex fallback | 不配置；失败后阻塞并重新决策 |
| Deep link | 仅作为未来可能的显式 transport 变更 |
| 本地持久化 | 独立 `collaboration.db`；整数 schema version、事务迁移和结构 smoke |
| 本地恢复 | Projection/cache 可重建；binding、receipt 和 provider metadata 必须备份并显式恢复 |
| Host 生命周期 | 随 current/active Host Core 运行，不建立群组专用 publish、activate、certification 或 Node identity |
| `groups/` 目录 | 保留，不再视为与原有 Icarus group 冲突 |
| 原 Icarus group 概念 | 由另一改造统一重命名为 `agent` |
| Web 原“群组”导航 | 更名为“会话” |
| Web 新“群组”导航 | Agent Group 客户端入口 |
| 卡死 Turn | 第一阶段由创建者人工恢复 |
| 公开群组搜索 | 第一阶段不支持；通过已知 Git URL 加入 |

## v1 Git Collaboration Protocol 收敛边界

本轮实现已根据 Spike 和测试收敛以下 v1 最小语义。第一次真实跨实例持久协作前仍需完成独立复核：

- 仓库根文件、事件和状态机 schema 的必需字段，以及 `protocol_version` 的拒绝规则。
- Git commit parent、事件 sequence、state revision 和 epoch 的顺序规则。
- deterministic reducer 的状态迁移语义。
- Git SSH commit signer、Principal、角色和命令之间的授权规则。
- claim、fencing、idempotency、结果提交和人工恢复语义。
- 协议升级时暂停群组、统一升级、显式迁移和新 epoch 的流程。
- 少量固定事件向量、并发竞争和故障恢复测试。

v1 收敛不包括：

- contract pack、seal、全源码或 Markdown hash、生成式 conformance 和发布认证。
- GitHub、GitLab 或 bare remote 的平台专用分支保护配置。
- `data/` 大小阈值、Git LFS 和外部对象存储的具体选择。
- Codex App Server 支持版本矩阵和 provider schema 字段。
- Web route、deep link、书签、缓存迁移和内部 service/gateway 结构。
- 本地 `collaboration.db` schema version、Host Core snapshot 和 Node toolchain 兼容信息。
- Dynamic Workflow Runtime、run-once Agent 或 Executor adapter 的内部实现。

同一 `protocol_version` 的持久化语义不能原地改变；这只服务于当前群组仓库在多个 Icarus 实例之间的一致解释，不构成长期兼容或第三方实现承诺。破坏性调整通过升级协议版本和显式迁移完成。安全不变量必须保留，其他设计决策可以根据实现证据通过 ADR 调整。
