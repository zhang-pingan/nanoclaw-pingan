# Dynamic Workflow Graph Runtime 入门讲解

> **定位**：本文是 [`dynamic-workflow-dag-framework.md`](./dynamic-workflow-dag-framework.md) 的非规范性介绍文档，用于先建立心智模型，再阅读完整执行合同。
>
> **权威性**：本文只负责解释，不新增或修改 Runtime 语义。若本文与完整规范中的类型、Logical Schema、事务协议或验收条款不一致，以完整规范为准。
>
> **实现状态**：架构“已确认”不等于全部代码“已实现”。实际进度以 [`dynamic-workflow-runtime-implementation-progress.md`](./dynamic-workflow-runtime-implementation-progress.md) 和仓库代码为准。

## 阅读方法

完整规范同时覆盖产品语义、Graph IR、Compiler、Runtime、SQLite、恢复协议和发布门禁。如果直接按原文逐行阅读，很容易把不同层次的同名概念混在一起。本文按十个部分重新组织：

1. 先认识对象和生命周期。
2. 再理解 Workflow 如何被可信地创建。
3. 再理解 State 如何统一进入 Graph Runtime。
4. 然后学习 Graph 的静态合同和 Compiler。
5. 再学习 Edge、Condition、Trigger、Input Aggregation 和 Input Seal 的运行语义。
6. 再展开八类 Node 和动态 Child Scope。
7. 再理解 Candidate、Close Request、Cut 和 T8。
8. 然后进入重试、副作用、资源和安全上限。
9. 最后理解持久化、CAS、事务和恢复。
10. 以控制面、运行中心、测试与实施 Gate 收尾。

本文使用以下标记：

- **已展开**：已经给出可独立阅读的详细解释。
- **部分展开**：已解释核心概念，后续仍需补充完整规范中的高级语义。
- **导读**：当前只给出学习目标和原规范入口。

## 十部分总索引

| 部分 | 主题 | 当前深度 | 主要问题 |
| --- | --- | --- | --- |
| [第一部分](#part-1) | 全局心智模型 | 已展开 | Workflow、Run、Scope、Node、Attempt 分别是什么？ |
| [第二部分](#part-2) | Task Intake、Recipe 与创建入口 | 已展开 | 一个请求怎样安全地变成 Workflow？ |
| [第三部分](#part-3) | State 与 Graph 的统一 | 已展开 | 五类 State 怎样 lower 到统一 Runtime？ |
| [第四部分](#part-4) | Graph 静态合同与 Compiler | 部分展开 | Interface、Port、Registry、Source 和 Plan 怎样配合？ |
| [第五部分](#part-5) | DAG 执行语义 | 部分展开 | Condition、Edge、Trigger、Input Aggregation和 Input Seal如何决定 Ready？ |
| [第六部分](#part-6) | Node 与动态结构 | 部分展开 | 八类 Node 以及 Subgraph、Expand、Map 如何工作？ |
| [第七部分](#part-7) | Completion 与外层推进 | 部分展开 | Candidate 如何变成 Cut，T8 如何推进 State？ |
| [第八部分](#part-8) | 可靠性、资源与副作用 | 导读 | Retry、Outbox、Compensation、Ledger、Safety 如何闭环？ |
| [第九部分](#part-9) | 持久化、事务与恢复 | 导读 | SQLite、CAS、T0-T8、Checkpoint 如何保证恢复？ |
| [第十部分](#part-10) | 控制面、产品化与实施 | 导读 | Command、Runtime Center、Trace、测试和 Gate 如何落地？ |

---

<a id="part-1"></a>

## 第一部分：全局心智模型

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [1.1](#part-1-1) | 这套 Runtime 解决什么问题 |
| [1.2](#part-1-2) | 核心对象层级 |
| [1.3](#part-1-3) | 外层状态机与 Scope Tree |
| [1.4](#part-1-4) | Scope Tree 与 Scope 内 DAG |
| [1.5](#part-1-5) | Child Scope 与 Child Workflow |
| [1.6](#part-1-6) | Detached Branch 为什么被禁止 |
| [1.7](#part-1-7) | 第一部分记忆公式 |

原规范入口：

- [背景](./dynamic-workflow-dag-framework.md#背景)
- [设计目标](./dynamic-workflow-dag-framework.md#设计目标)
- [非目标与硬边界](./dynamic-workflow-dag-framework.md#非目标与硬边界)
- [核心对象模型](./dynamic-workflow-dag-framework.md#核心对象模型)
- [核心不变量](./dynamic-workflow-dag-framework.md#核心不变量)

<a id="part-1-1"></a>

### 1.1 这套 Runtime 解决什么问题

旧式顺序状态机很难同时正确表达：

- 多分支并行和条件路由。
- All/Any/Quorum 汇合。
- Signal、Timer、Approval 等持久等待。
- 运行时生成但受约束的 Child Graph。
- Early Completion、晚到结果和副作用清理。
- 跨进程恢复、资源预算和权限收敛。

目标架构把问题拆成两层：

> 外层 Workflow State Machine 管理长期业务生命周期；内层有限 Graph Scope 管理某一次业务阶段的具体执行。

外层可以持续数天、等待人工、返回旧 State 或进入新 State。内层必须是有限、不可变、可关闭和可恢复的 DAG。

<a id="part-1-2"></a>

### 1.2 核心对象层级

```text
Task Intake / Routing Request
  -> Recipe Descriptor
    -> Workflow Creation Request
      -> Workflow Instance
        -> State Activation
          -> Graph Run                    非 terminal activation 才有
            -> Graph Scope Instance
              -> Immutable Scope Plan
              -> Graph Node
                -> Graph Node Attempt     delegation/system
                -> Durable Wait           signal/timer/approval
              -> Edge Resolution
              -> Terminal Candidate
              -> Close Request
              -> Completion Cut
            -> Run Manifest
            -> Resource Ledger
```

| 对象 | 含义 |
| --- | --- |
| Workflow Definition | 业务流程蓝图，定义 State 和 Transition |
| Workflow Instance | 一次真实业务任务，可以长期运行和循环 |
| State | 受信任的宏观业务阶段 |
| State Activation | 某一次进入 State；再次进入同一 State 会创建新 Activation |
| Graph Run | 一个非终态 Activation 的执行容器 |
| Scope | 一个不可变、有限、无环的 DAG 边界 |
| Node | 一个逻辑执行目标 |
| Attempt | Node 的一次物理执行；重试不会创建新 Node |
| Durable Wait | 一个可跨进程恢复的 Signal、Timer 或 Approval 等待实例 |

几个关键区分：

- `State` 是业务阶段，`Node` 是该阶段内部的执行单元。
- `State Activation` 是一次进入 State，不是 State 定义本身。
- `Node` 是逻辑目标，`Attempt` 是一次真实执行。
- 业务返工创建新 Activation/Run；执行重试在同一 Node 下创建新 Attempt。

<a id="part-1-3"></a>

### 1.3 外层状态机与 Scope Tree

外层 Workflow Definition 可以包含 Transition Cycle：

```text
planning -> implementation -> review
   ^                            |
   |-------- revision ----------|
```

每次重新进入 `planning` 都创建新的 Activation 和新的 Root Graph Run。旧 Run、Attempt、Candidate 和 Cut 保持不可变。

单个 Graph Run 不会被建模成无限 Graph。它拥有一棵有限 Scope Ownership Tree：

```text
Root Scope
├─ Child Scope A
│  └─ Grandchild Scope A1
├─ Child Scope B
└─ Child Scope C
```

树表示“谁创建、拥有并等待谁”，不是 Node 之间的数据依赖。

<a id="part-1-4"></a>

### 1.4 Scope Tree 与 Scope 内 DAG

一个 Run 的准确模型是：

> 一棵 Scope 所有权树，每个 Scope 内部装着一个独立 DAG。

```text
Scope Ownership Tree                 某个 Scope 内的 DAG

Root Scope                           A ──┬──> B
├─ Child Scope 1                        └──> C ──> D
│  └─ Grandchild Scope
└─ Child Scope 2
```

Edge 两端必须属于同一个 Scope。Parent 和 Child 不能直接建立跨 Scope Edge，只能通过 Owner Node 的 typed inputs/outputs 通信。

```text
Parent Node output
  -> Parent 内 Data Edge
  -> Owner Node sealed input
  -> Child Scope typed input
  -> Child named exit/output envelope
  -> Owner Node output
  -> Parent 内 Data/Control Edge
```

这类似函数调用：Scope 是函数，Scope Interface 是函数签名，Owner Node 是调用点。调用者不能跳进函数内部连接某一行代码。

这种边界带来四个直接收益：

1. Parent Plan 创建后永不修改，动态能力只追加 Child Scope。
2. Child 只能读取 Owner 冻结的输入，不能读取 Parent live state。
3. Child 唯一键 `(parent_scope_id, owner_node_id, child_key)` 可以防止恢复时重复创建。
4. Parent Close 可以沿 Ownership Tree 原子 fence 整棵 subtree。

<a id="part-1-5"></a>

### 1.5 Child Scope 与 Child Workflow

| 维度 | Child Scope | Child Workflow |
| --- | --- | --- |
| 本质 | 当前 Run 内的嵌套 DAG | 全新的 Workflow Instance |
| Parent | `parent_scope_id` | `parent_workflow_id` |
| Owner | Parent Scope 内的 Subgraph/Expand/Map Node | 没有 Owner Node |
| 创建时机 | Owner Node 在 Graph 执行中激活 | Root 结果选中带 `start_child_workflow` 的 Transition |
| 生命周期 | 必须在当前 Run 内收敛 | 有自己的 State、Activation、Run 和 Snapshot |
| Parent 是否等待最终结果 | Owner 必须等待 Child Scope | 默认不等待 Child Workflow 执行完成 |
| 用途 | 当前阶段需要同步结果 | 后台、后续、验证或独立业务任务 |

Child Scope 使用：

```text
Owner Trigger=true + inputs sealed
  -> Owner激活
  -> 创建/物化 Child Scope
  -> Child Cut
  -> Owner terminal并发布 output
  -> Parent继续
```

Child Workflow 使用：

```text
Root Terminal Candidate
  -> Completion Policy选中结果
  -> Root Close Request和清理
  -> 选中外层 Transition
  -> T8创建 Child Workflow或写创建 Outbox
```

`required` Child Workflow 表示 T8 前必须保证“创建动作”成功，不表示 Parent 等待 Child 最终执行结果。`best_effort` 则由 T8 写确定性 Outbox intent，Parent 不因后续创建失败而回滚。

如果 Parent 必须同步消费结果，应优先使用 Child Scope；跨 Workflow 同步只能使用显式 Wait/Signal 合同，不能隐藏在 Parent/Child relation 中。

<a id="part-1-6"></a>

### 1.6 Detached Branch 为什么被禁止

Detached Branch 指 Graph 中某条分支在 Parent Scope、Run 或 Workflow 已完成后，仍脱离 Parent 继续运行：

```text
              ┌──> generate_report -> completed
start --------┤
              └──> monitor_for_7_days          仍继续运行
```

这会使 late output、副作用、预算、Claim、取消、Retention 和错误归属失去明确边界。因此 Scope 开始关闭后，所有剩余工作都必须：

```text
fence -> cancel/reconcile/compensate -> required cleanup收敛 -> Completion Cut
```

真正需要在 Parent 完成后继续运行的 `monitor_for_7_days` 应建模为独立 Child Workflow。禁止的不是后台任务，而是没有独立生命周期、却逃离原 Run 的后台分支。

<a id="part-1-7"></a>

### 1.7 第一部分记忆公式

```text
Workflow = 长期状态机
Activation = 一次进入 State
Graph Run = 这次 State 的执行
Scope = 一个不可变 DAG边界
Node = 一个逻辑目标
Attempt = 一次物理尝试
Child Scope = 当前 Run 内同步子调用
Child Workflow = Transition启动的独立任务
```

---

<a id="part-2"></a>

## 第二部分：Task Intake、Recipe 与 Workflow 创建入口

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [2.1](#part-2-1) | 创建面的准确链路 |
| [2.2](#part-2-2) | Task Intake 与 Revision |
| [2.3](#part-2-3) | Routing Scope 与 Macro Router |
| [2.4](#part-2-4) | Deterministic Resolver |
| [2.5](#part-2-5) | Definition、Policy 与 Recipe |
| [2.6](#part-2-6) | Entrypoint、Feature 与 Principal |
| [2.7](#part-2-7) | Creation Key 与 Intent Hash |
| [2.8](#part-2-8) | Provenance、Domain Claim、Deadline 与 Ownership |
| [2.9](#part-2-9) | T0/T1 最终创建什么 |

原规范入口：

- [Task Intake、Recipe Catalog 与 Macro Routing](./dynamic-workflow-dag-framework.md#task-intakerecipe-catalog-与-macro-routing)
- [Workflow 级执行 Policy 与 Runtime Safety](./dynamic-workflow-dag-framework.md#workflow-级执行-policy-与-runtime-safety)
- [Durable Domain Resource Claims](./dynamic-workflow-dag-framework.md#durable-domain-resource-claims)
- [Intake、Routing 与 Creation](./dynamic-workflow-dag-framework.md#intakerouting-与-creation)
- [Workflow 与 Run](./dynamic-workflow-dag-framework.md#workflow-与-run)

<a id="part-2-1"></a>

### 2.1 创建面的准确链路

Recipe 在请求到来前已经由 Publisher 发布。Router 和 Resolver 都不会创建 Recipe。

发布阶段：

```text
Publisher
  -> 发布 Recipe Descriptor A/B/C
  -> 发布 Routing Scope.allowed_recipe_refs = [A, B, C]
```

请求阶段：

```text
用户请求
  -> Task Intake Revision
  -> 加载 pinned Routing Scope和候选 Recipe summaries
  -> Macro Router提出一个 candidate RecipeRef
  -> Deterministic Resolver
       + Published Recipe Registry
  -> validated exact Recipe binding
  -> Creation Request
  -> T0
  -> T1
```

更准确的信任关系是：

```text
用户输入：提供任务意图
Routing Scope：提供有限候选集
Router：从候选集中提出一个 RecipeRef
Recipe Registry：保存预先发布的固定执行合同
Resolver：解析并校验 Recipe，做最终创建授权
```

<a id="part-2-2"></a>

### 2.2 Task Intake 与 Revision

Task Intake 冻结一次请求的入口事实，包括：

- 来源：自然语言、Feature UI、Schedule、API 或 Workflow Transition。
- 已认证 Principal。
- Raw Request、Structured Input 和 Attachment refs。
- Pinned Routing Scope。
- Request ID、Creation Key、显式 Task Kind 或 RecipeRef。

输入补充不会覆盖旧数据，而是创建 immutable Revision：

```text
Revision 0：用户说“帮我做市场调研”
Revision 1：补充“目标市场是日本”
Revision 2：补充“预算上限为 5 万”
```

Routing Attempt 和 Launch Confirmation 都必须绑定 exact revision number/hash。Revision 改变后，旧 Routing Decision 和旧确认不能自动复用。

这里的 Revision 是 Task Intake 的业务修订，不是 Registry Resource version，也不是数据库 CAS 使用的 `row_version`。

<a id="part-2-3"></a>

### 2.3 Routing Scope 与 Macro Router

Routing Scope 是当前入口的 Recipe 白名单：

```ts
{
  ref: { id: 'pm-pipeline-routing', version: '1.0.0' },
  allowed_recipe_refs: [
    { id: 'pm-new-feature', version: '3.0.0' },
    { id: 'pm-pipeline-review', version: '2.0.0' }
  ],
  allowed_child_scope_refs: []
}
```

“RecipeRef 属于当前 Scope”表示 exact `id + version` 出现在 `allowed_recipe_refs` 中。即使某个 Recipe 存在于全局 Registry并已 Published，只要不在当前白名单中，Resolver 仍必须拒绝。

显式页面按钮也不能绕过该检查。显式 Recipe只表示“不需要模型判断”，不表示“获得全局选择权限”。

Macro Router 的输入候选可以有多个，但每一跳最多输出一个目标：

```text
recipe_selected：一个 RecipeRef
child_scope_selected：一个 Child Routing ScopeRef
needs_clarification：需要补充字段
unsupported：当前 Scope不支持
```

它不输出 Top-K 列表让 Resolver猜测。模型内部可以比较候选，但权威 Routing Decision 只能选择一个目标。

分层 Routing 示例：

```text
global-routing@1
  -> child_scope_selected: pm-routing@1

pm-routing@1
  -> recipe_selected: pm-new-feature@3
```

每次进入 Child Routing Scope 算一跳。Routing Scope 链必须无环：

```text
禁止：scope-A -> scope-B -> scope-C -> scope-A
```

同时不能超过部署级 Safety Hop Limit。Production v1 的 `max_route_hops=8`，避免配置错误、Prompt loop 或恶意输入造成无界路由。

<a id="part-2-4"></a>

### 2.4 Deterministic Resolver

Resolver 不调用模型。它把 Router 的 candidate decision 当作不可信输入，并重新校验：

- Target 是否位于当前 Routing Scope。
- Recipe、Definition、Policy、Schema 是否为 exact Published ref/hash。
- Entrypoint 是否存在且不是 Terminal State。
- Feature 是否处于允许启动新任务的状态。
- Principal 是否具有所需权限。
- Effective Input 是否满足 Recipe Input Schema。
- Launch Policy 是否满足。
- Domain Claim 是否可以获得。
- Creation Key 是否冲突。
- Routing Scope 链是否无环且未超过 Safety Hop Limit。

只有 Resolver 通过后，才形成 Creation Request。Prompt 中“只允许选择这些候选”的文字不能替代服务端确定性校验。

<a id="part-2-5"></a>

### 2.5 Definition、Policy 与 Recipe

一句话区分：

> Definition 定义流程怎么走；Policy 定义允许怎么运行和最多能做什么；Recipe 把 Definition、Policy、Entrypoint、Schema 和权限绑定成可启动业务任务。

#### Definition

Workflow Definition 定义：

- Entrypoints。
- State 集合和 State 类型。
- State 的 Graph Source、Capability 或 Wait Contract。
- Named Exit 到 Transition 的映射。
- Transition target、Context Patch、Notification、Card 和 Child Workflow Effect。

#### Policy

Policy 是一类限制合同，不是单一对象：

| Policy | 控制内容 |
| --- | --- |
| Workflow Execution Policy | Workflow 总时长、Activation、Run、Transition、Child 和 Usage |
| Workflow Graph Policy Envelope | State Graph允许的 Node、Capability、Template、Wait、Effect和额度 |
| Workflow Command Policy | Pause、Resume、Cancel、Manual Skip和 Remediation |
| Routing Selection Policy | Router阈值和低置信度处理 |
| Root Finalization Policy | Required Child创建重试和期限 |
| Outbox Delivery Policy | 外部投递、Backoff、Reconcile和 Deadline |
| Runtime Safety Ceilings | 部署级不可放宽上限 |

#### Recipe

Recipe 是不可拆分的创建绑定：

```text
Recipe
├─ Workflow Definition + Entrypoint
├─ Workflow Execution Policy
├─ Context Contract
├─ Workflow Command Policy
├─ Input / Output Schema
├─ Launch Policy
├─ Required Permissions
├─ Effect Ceiling
├─ Domain Resource Claims
└─ Allowed Child Recipes
```

Router只能选择 Recipe，不能拼装 `Definition A + Policy B + Schema C`。Definition 或 Policy升级后，旧 Recipe不会自动切换；必须发布新的 Recipe version。

<a id="part-2-6"></a>

### 2.6 Entrypoint、Feature 与 Principal

#### Entrypoint

Entrypoint 决定 Workflow 从 Definition 的哪个 State开始：

```ts
entry_points: {
  default: { state_key: 'collect_requirements' },
  revalidate: { state_key: 'validation' }
}
```

Recipe固定其中一个 Entrypoint。调用方不能临时更换，新 Workflow也不能从 Terminal State直接启动。

#### Feature

Feature 是 Icarus 中有明确 Owner、Manifest、Release和 UI/API边界的功能包，例如 `pm-pipeline`。它可以发布 Recipe、Definition、Capability、Schema和页面。Recipe 的 `owner_feature_id` 表示发布者，不自动代表 Workflow控制者。

Resolver需要确认 Feature 已安装、激活、未处于禁止新启动的状态，并且入口没有跨 Feature越权。

#### Principal

Principal 是本次创建依赖的已认证身份，例如：

- `human:local-owner`
- Feature Service
- Automation
- Parent Workflow继承的 Principal

Principal决定启动权限和控制归属。它必须来自服务端认证上下文，不能信任客户端自报字符串。

<a id="part-2-7"></a>

### 2.7 Creation Key 与 Intent Hash

Creation Key 是可信创建域中的稳定幂等键，不是 Workflow ID，也不是一次 HTTP Request ID。

```text
creation_key = workspace:icarus:week:2026-W29
```

`creation_domain` 是服务端确定的命名空间，例如：

```text
feature:pm-pipeline
api:<principal-scope>
parent_workflow_lineage:<root_workflow_id>
```

它不是 dev/test/prod 环境名。不同部署通常通过不同 `workflow-runtime.db` 或 data root隔离。

最终创建前计算：

```text
creation_intent_hash = H(
  creation_domain,
  creation_key,
  principal_scope,
  ownership_hash,
  routing_scope_ref/hash,
  recipe_ref/hash,
  entry_point,
  effective_input_hash,
  attachment_manifest_hash
)
```

T0 在同一个权威 Runtime DB 中执行：

```text
相同 creation_domain + creation_key
  ├─ intent hash相同 -> 返回原 Creation Result / Workflow
  └─ intent hash不同 -> idempotency_conflict
```

Intent Hash 是幂等和审计指纹，不是权限令牌或加密密钥。它防止重试时偷换 Recipe、输入、附件、Principal或 Control Ownership。

<a id="part-2-8"></a>

### 2.8 Provenance、Domain Claim、Deadline 与 Ownership

#### Provenance

Workflow必须具有真实、append-only、由 FK连接的创建溯源：

```text
Task Intake
  -> Revision
  -> Routing Attempt
  -> Creation Request
  -> Workflow Instance
```

它回答“谁、从哪个入口、基于哪版输入、为什么选择哪个 Recipe、是否确认以及如何重放”。Required Child Workflow也不能绕过这条链直接插入。

#### Domain Claim

Domain Claim 是对 workspace、package、Git target等外部业务资源的持久 Claim：

- `shared` 只允许读取，可以并存。
- `exclusive` 允许修改，同一资源只能有一个持有者。
- Exclusive Claim带 current fencing token。
- Claim在 T0 中与 Workflow创建原子提交。
- 冲突返回 `resource_busy`，不会先创建 Workflow再异步抢锁。

它不同于 Graph Ledger：Ledger管理 Runtime内部额度；Domain Claim保护外部业务资源。

#### Workflow Deadline

T0 冻结绝对截止时间：

```text
deadline_at_ms = started_at_ms + effective_max_duration_ms
```

有效时长取 Workflow Execution Policy与 Runtime Safety Ceiling中更严格的值。Production v1 Safety上限为 30 天。Deadline跨全部 Activation/Run，不因 Pause、重启、人工等待或进入新 State延长。到期后 Watchdog提交稳定的 global cancel command，不走业务 `on_error`。

#### Workflow Control Ownership

```ts
interface WorkflowControlOwnership {
  owner_principal_ref: string;
  controlling_feature_id: string | null;
  creator_automation_ref: string | null;
  ownership_hash: string;
}
```

Ownership由 T0 根据已认证入口生成，决定谁可以按 `own` 权限 Pause、Resume或 Cancel。Recipe Owner和 Creation Domain都不自动授予控制权，客户端也不能覆盖 Ownership字段。

<a id="part-2-9"></a>

### 2.9 T0/T1 最终创建什么

```text
T0
├─ 冻结 Creation Intent、Deadline和 Control Ownership
├─ 原子获取 Domain Claims
├─ 创建 Workflow Instance
└─ 调用 T1 Core Setup

T1
├─ 创建首个非 terminal State Activation
├─ 创建唯一 Graph Run
├─ 冻结 Definition、Registry Snapshot、Safety和 Source Seed
├─ 创建 Run Ledger Accounts
├─ 创建 plan=null 的 Root Scope Shell
├─ 创建 Root Scope Build
└─ 写初始 Checkpoint Watermark
```

此时只建立可恢复执行骨架；T2才编译并 materialize Root Scope。

---

<a id="part-3"></a>

## 第三部分：State 与 Graph 的统一

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [3.1](#part-3-1) | Lowering 的含义和目标 |
| [3.2](#part-3-2) | 五类 State 的统一映射 |
| [3.3](#part-3-3) | Delegation 与 System State |
| [3.4](#part-3-4) | Interrupt State |
| [3.5](#part-3-5) | Graph State |
| [3.6](#part-3-6) | Terminal State |
| [3.7](#part-3-7) | 四种 Graph Source |
| [3.8](#part-3-8) | T2a Compile 与 T2b Materialize |
| [3.9](#part-3-9) | Attempt、质量门禁与 Typed Output |

原规范入口：

- [State 与 Graph 的统一](./dynamic-workflow-dag-framework.md#state-与-graph-的统一)
- [Scope Interface 与 Source IR](./dynamic-workflow-dag-framework.md#scope-interface-与-source-ir)
- [Compiler](./dynamic-workflow-dag-framework.md#compiler)
- [Scope Plan、Instance 与 Run Manifest](./dynamic-workflow-dag-framework.md#scope-planinstance-与-run-manifest)
- [Scope Build 与 Expansion Manifest](./dynamic-workflow-dag-framework.md#scope-build-与-expansion-manifest)
- [Context、Artifact 与 Quality Gate](./dynamic-workflow-dag-framework.md#contextartifact-与-quality-gate)

<a id="part-3-1"></a>

### 3.1 Lowering 的含义和目标

`lower` 表示把 Authoring-friendly State翻译为统一的底层 Graph表示：

```text
Workflow Definition State
  -> Definition Lowerer
  -> Graph Scope Source/Plan
  -> Graph Runtime
```

这样简单顺序 State和复杂 Graph不会分别拥有两套 Retry、Wait、Cancel、Checkpoint、Trace和 Recovery协议。简单 State只是 Authoring Sugar，不是另一套 Runtime。

<a id="part-3-2"></a>

### 3.2 五类 State 的统一映射

```ts
type WorkflowDefinitionState =
  | 'delegation'
  | 'system'
  | 'interrupt'
  | 'graph'
  | 'terminal';
```

| State | Lower后的 Root Scope |
| --- | --- |
| Delegation | 一个 Delegation Node + Success/Failure Terminal Nodes |
| System | 一个 System Node + Success/Failure Terminal Nodes |
| Interrupt | 一个 Wait Node + Action/Expire/Cancel Terminal Nodes |
| Graph | 从 Frozen Graph Source编译完整 Root Scope |
| Terminal | 不创建 Graph Run；T8直接创建并完成 Terminal Activation |

每次进入非 Terminal State都创建新的 Activation和唯一 Root Graph Run。Terminal State仍有可审计 Activation，但没有 Run、Scope或 Scheduler Work。

<a id="part-3-3"></a>

### 3.3 Delegation 与 System State

Delegation State：

```text
draft_proposal (delegation Node)
  ├─ succeeded -> success Terminal Node
  └─ failed    -> failure Terminal Node
```

System State：

```text
validate_workspace (system Node)
  ├─ succeeded -> success Terminal Node
  └─ failed    -> failure Terminal Node
```

二者都引用 exact versioned Capability。State不能直接拼装 Role、Skill、Tool、Prompt或任意脚本。

区别主要是执行合同：Delegation通常调用 Agent Executor；System通常调用确定性系统 Capability。两者都严格是单 Node语义。多步骤处理必须使用 Graph State，不能隐藏在 `steps[]` 中。

单 Agent反复修改属于同一 Node的 immutable Attempt Chain：

```text
Node draft_proposal
├─ Attempt 1 -> needs_revision
├─ Attempt 2 -> needs_revision
└─ Attempt 3 -> pass
```

它不会创建 Loop State、Loop Node或 Graph Cycle。

<a id="part-3-4"></a>

### 3.4 Interrupt State

Interrupt State lower为 Durable Wait Graph：

```text
approval (wait Node)
  ├─ action=approve -> approved Terminal
  ├─ action=reject  -> rejected Terminal
  ├─ timeout        -> expired Terminal
  └─ wait cancelled -> cancelled Terminal
```

Wait armed后 Node进入 `waiting`，Run仍为 `control=running`，并且 Wait不占 Executor slot。它阻塞的只是依赖该 Wait的路径，不是整个 Workflow。

<a id="part-3-5"></a>

### 3.5 Graph State

Graph State承载完整多节点 DAG：

```text
analyze ──┬──> backend
          ├──> frontend
          └──> tests
                  |
                  v
                review
                  |
                  v
        completed | revision_required
```

它固定：

- Graph Source来源。
- Root Interface。
- Workflow Graph Policy Envelope。
- 所有 Named Exit的 `exit_routes`。
- `on_error` 和 `on_local_cancel`。

Micro Planner可以在前一个 Delegation State中生成 GraphScopeSpec，但 Graph State不会隐式调用 Planner。

<a id="part-3-6"></a>

### 3.6 Terminal State

Terminal State结束整个 Workflow：

- `terminal_kind=normal` 必须有满足 Recipe Output Schema的 Final Output Binding。
- `terminal_kind=errored` 必须有结构化 Error Code，可选 Typed Error Binding。
- Global Workflow Cancel不创建 Terminal Activation。

三个容易混淆的 Terminal层次：

| 概念 | 含义 |
| --- | --- |
| Node Terminal Outcome | 任意 Node 的 succeeded/failed/skipped/cancelled |
| Graph Terminal Node | 为 Scope提交 Named Exit Candidate |
| Workflow Terminal State | 结束整个 Workflow，不创建 Graph Run |

完整链路可能是：

```text
Delegation Node succeeded
  -> accepted Graph Terminal Node
  -> Root Scope exit=accepted
  -> Transition target=completed
  -> Workflow Terminal State
```

<a id="part-3-7"></a>

### 3.7 四种 Graph Source

Graph Source是 GraphScopeSpec的来源，不是 Compiled Plan：

```ts
type WorkflowGraphSource =
  | { type: 'inline'; scope: GraphScopeSpec }
  | { type: 'context_slot'; slot: string }
  | { type: 'artifact'; ref: string; json_pointer?: string }
  | { type: 'template'; template_ref: VersionedRef };
```

| Source | 场景 |
| --- | --- |
| Inline | 小型固定 Graph直接写在 Definition中 |
| Context Slot | 上游阶段针对本次任务动态生成 GraphScopeSpec |
| Artifact | 不可变产物包中某一部分携带 GraphScopeSpec |
| Template | Registry中正式发布、可复用的 Graph模板 |

#### Context Slot 的典型链路

```text
Planning State
  -> Planner生成 Candidate GraphScopeSpec
  -> Compiler Dry-run / Evaluator验证
  -> Attempt pass并发布 typed graph_spec output
  -> T8 Context Patch写入 implementation_graph Slot
  -> 下一个 Graph State从 Slot冻结 Source
  -> T2a正式编译
```

普通 Node不能直接修改 Workflow Context；必须经过 Root Completion和 T8 Trusted Context Patch。

#### Artifact 与 Template

Template类似已发布库函数：有 exact `id + version + hash`，适合多个 Definition长期复用的标准流程。

Artifact类似冻结构建产物：可以同时包含说明、Schema和多个 Graph，Definition用 immutable locator和 JSON Pointer选择其中一个 Graph。

```text
artifact:compliance-audit-package-2026q3
├─ README.md
├─ evidence-schema.json
└─ graphs.json
   ├─ /securityAudit
   └─ /privacyAudit
```

当前 v1 的 Artifact Source直接在 Definition中声明 `ref: string`，没有“从 Context Slot动态读取 Artifact Ref”的 binding。如果 Graph Ref由上一个 State每次动态产生，最明确的 v1表达是把 GraphScopeSpec本身写入 Context Slot；不能读取某个 `latest artifact` 猜测来源。

无论 Source来自哪里，都必须先冻结 canonical bytes/hash，再经过同一个 Strict Compiler。Compiler不会调用模型偷偷修复失败 Source。

<a id="part-3-8"></a>

### 3.8 T2a Compile 与 T2b Materialize

T1只创建 Root Scope Shell：

```text
lifecycle = materializing
plan_id = null
```

T2a 在数据库事务外获取 Frozen Source并运行 Pinned Pure Compiler：

- Strict JSON和 Closed Schema。
- Interface、Port和 Schema校验。
- DAG无环校验。
- Condition、Trigger、Completion编译。
- Capability、Policy、Safety校验。
- Assignability Proof和 Plan Hash。
- Static Subgraph/Map Child Plan Closure。

T2a原子保存 immutable Plan并设置 Build=`compiled`，但不创建 Node，也不消费 Scope/Node quota。

T2b 在短 SQLite事务中：

```text
验证 Run running/healthy和 Work Fence
  -> 验证 Plan/Input/Safety/Supported Limits
  -> 原子预留 Ledger
  -> 把 Plan绑定 Root Scope Shell
  -> 插入 Node和 Edge实例
  -> 写 Run Manifest
  -> Scope active
  -> Run executing
  -> Build materialized
```

Materialize不是执行 Node，而是把不可变蓝图变成这次 Run的权威实例行。Compile和 Materialize分开可以避免在长 SQLite事务中运行 Compiler，并防止 Pause、Cancel或 stale Build重新激活 Graph。

<a id="part-3-9"></a>

### 3.9 Attempt、质量门禁与 Typed Output

Attempt产生候选结果，不直接成为 Node的逻辑输出：

```text
Executor Result
  -> Result/Artifact Contract验证
  -> Mutable Effect Receipt/After Snapshot验证
  -> Evaluator
  -> Quality Gate：pass | needs_revision | fail
```

- `pass`：构造并发布唯一 NodeOutputEnvelope。
- `needs_revision`：保存 Typed Feedback，创建下一 Attempt，不发布 Node Output。
- `fail`：Node=`failed/quality_rejected`，不发布 Node Output。
- Revision耗尽：`quality_revision_exhausted`。
- Run共享 Attempt额度耗尽：`attempt_budget_exhausted`。

Typed Output按 Port发布：

```ts
ports: {
  report: {
    state: 'present',
    value_ref: 'value:report-123',
    value_hash: 'sha256:...',
    schema_hash: 'sha256:...',
    byte_length: 42000
  },
  warning: {
    state: 'absent',
    schema_hash: 'sha256:...'
  }
}
```

Required Output在 Node成功时必须 `present` 且通过 Schema/Hash/Size验证。Optional Output可以 `present`，也可以显式 `absent`。`absent` 不等于漏字段，也不等于 JSON `null`；它表示该 Port已经最终确认无值。

这样多个 Attempt最终只产生一个不可变 NodeOutputEnvelope，下游 Data Edge不会看到中间稿。

---

<a id="part-4"></a>

## 第四部分：Graph 静态合同与 Compiler

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [4.1](#part-4-1) | Scope Interface |
| [4.2](#part-4-2) | Port |
| [4.3](#part-4-3) | Named Exit |
| [4.4](#part-4-4) | Versioned Registry |
| [4.5](#part-4-5) | Registry Snapshot 生命周期 |
| [4.6](#part-4-6) | Source、Plan 与 Compiler边界 |
| [4.7](#part-4-7) | Compiler Proof |
| [4.8](#part-4-8) | Program Hash |
| [4.9](#part-4-9) | 后续需要补充的 Compiler主题 |

原规范入口：

- [Scope Interface 与 Source IR](./dynamic-workflow-dag-framework.md#scope-interface-与-source-ir)
- [Data Edge、Port 与 Input Seal](./dynamic-workflow-dag-framework.md#data-edgeport-与-input-seal)
- [Versioned Registry 发布与保留](./dynamic-workflow-dag-framework.md#versioned-registry-发布与保留)
- [Compiler](./dynamic-workflow-dag-framework.md#compiler)
- [Compiler 输入快照](./dynamic-workflow-dag-framework.md#compiler-输入快照)
- [Compiled Scope Plan](./dynamic-workflow-dag-framework.md#compiled-scope-plan)

<a id="part-4-1"></a>

### 4.1 Scope Interface

Scope Interface是 Scope对外暴露的版本化 typed函数签名：

```ts
interface GraphScopeInterfaceContract {
  ref: VersionedRef;
  inputs: Record<PortName, ScopeInputPortContract>;
  exits: Record<ExitName, NamedExitContract>;
}
```

例如：

```text
researchScope(request, locale)
  -> accepted(report, confidence)
  | revision_required(feedback)
  | rejected(reason)
```

Interface只描述 Scope Input和正常业务 Exits，不暴露内部 Node/Edge。Graph Source的 `interface_ref` 必须精确匹配 State或 Owner固定的 Interface。

Root Scope用 Interface连接外层 Definition；Child Scope用 Interface连接 Owner Node。Parent不能跨 Scope连接内部 Edge。

<a id="part-4-2"></a>

### 4.2 Port

Port是 Scope或 Node上的命名 typed数据接口；Data Edge负责连接兼容 Port。

```text
analyze.report Output Port
  -> Data Edge
  -> review.report Input Port
```

主要 Port类型：

| Port | 作用 |
| --- | --- |
| Scope Input Port | Scope从外部接收的参数 |
| Node Input Port | Node执行时使用的 sealed输入 |
| Node Output Port | Node成功后唯一发布的 typed输出 |
| Named Exit Output Port | Scope从某个正常出口返回的数据 |

每个 Port至少绑定 Schema和可选业务字节上限。Compiler证明 Producer Schema可以赋值给 Consumer Schema；不同 Schema不能隐式转换，必须有 sound proof或显式 Versioned Adapter Node。

`request`、`locale` 这类名称不是 Runtime预置枚举，而是具体 Interface声明的业务 `PortName`：

```ts
type PortName = string;

interface ScopeInputPortContract {
  schema_ref: VersionedRef;
  max_bytes: number | null;
  required: boolean;
  default?: JsonValue;
}
```

| 字段 | 含义 |
| --- | --- |
| `schema_ref` | 输入必须满足的 exact versioned Schema |
| `max_bytes` | 该 Port的业务字节上限；`null` 表示不额外收紧部署级 Safety |
| `required` | 最终 Scope Input Snapshot是否必须具有该值 |
| `default` | 调用方没有提供值时使用的 typed默认值 |

Root Scope的输入可以绑定 Workflow Input、Context Slot、Artifact或 Constant；Child Scope的输入只能来自 Owner Node已经 Sealed的 Input或 Plan中的 Literal。Map Item还可以通过固定的 `item_child_input_port` 注入。无论来源如何，Materialize都会校验实际值的 Schema、Hash和大小，再冻结 Scope Input Snapshot。

Scope Input Port本身没有聚合策略，因为它在 Scope边界处已经是一个冻结参数。Node Input Port可以由多条 Data Edge提供值，因此额外定义以下聚合策略，详见[5.4](#part-5-4)：

```text
single/only
single/first_resolved
single/lowest_edge_id
list/all_sources_resolved
list/first_n_available
```

Port不同于 Context Slot：Port属于 Scope/Run内的数据接口；Context Slot属于跨 State持久 Workflow Context，只能由 T8 Context Patch更新。

<a id="part-4-3"></a>

### 4.3 Named Exit

一个 Named Exit是一个具名正常返回分支；`exits` 是全部 Named Exit合同的集合：

```ts
exits: {
  accepted: { output_ports: { report: ... } },
  revision_required: { output_ports: { feedback: ... } },
  rejected: { output_ports: { reason: ... } }
}
```

这里 `accepted`、`revision_required`、`rejected` 各自是一个 Named Exit。

Named Exit不是 UI文案，而是稳定合同标识符，会被以下对象引用：

```text
Scope Interface.exits
Graph Terminal Node.exit
Terminal Candidate.exit
Completion Cut.exit
Root Definition.exit_routes
```

一次正常 Scope执行最终只选择一个 Named Exit。运行中可以出现多个 Candidate，但 Completion Policy只选一个。

Named Exit只表示正常业务结果。Engine Error和 Cancel是独立 Outcome Kind。即使出口名叫 `failure`，它仍是业务出口，不等于 `outcome.kind=errored`。

<a id="part-4-4"></a>

### 4.4 Versioned Registry

Registry是部署级可信资源总目录，保存已经 Staged、Published或 Retired的：

- Recipe、Routing Scope和 Definition。
- Execution/Command/Graph Policy。
- Interface、Schema和 Graph Template。
- Capability、Executor、Prompt、Artifact Contract和 Evaluator。
- Wait、Notification、Card Contract。
- Compiler Toolchain、Protocol、Safety和 SQLite Profile。

资源使用 exact `resource type + id + version + content hash`。相同 `id + version` 一旦 Published，内容不可修改；更新只能发布新版本。

只有显式 Publish产生可执行资源。Git文件、Authoring Draft或安装目录变化不会自动改变 Registry。

Recipe Catalog是 Registry中可用于创建 Workflow的 Recipe视图；Routing Scope进一步限制当前入口能选哪些 Recipe；Graph Template只是 Registry中的一种资源。

<a id="part-4-5"></a>

### 4.5 Registry Snapshot 生命周期

Registry回答“系统中有哪些已发布资源”；Registry Snapshot回答“这个 Run只允许使用哪些精确版本”。

Snapshot以 Graph Run为边界：

```text
T1/T8创建新 Run
  -> 创建或复用 Dependency Closure Manifest
  -> 为 Run创建 Active Retention Handle
  -> Run整个生命周期固定使用 Snapshot
  -> Run可信关闭后释放 Active Handle
  -> 所有 Strong Reference和 Grace归零后才允许 GC
```

Snapshot不是整个 Registry的数据库复制，而是当前 Run可能使用资源的 exact dependency closure：

```text
当前 Plan已经引用的资源
+ Dynamic Expand未来可能从 Allowlist引用的资源
+ 它们的传递依赖
```

多个依赖完全相同的 Run可以共享 content-addressed Closure Manifest，但每个 Run拥有自己的 Retention Handle。

同一个 Run中的 Root、Subgraph、Expand和 Map Item Scope共享同一个 Registry Snapshot。Child Workflow拥有自己的 Run和 Snapshot。

Pause、Retry、Wait、Recovery和 Feature升级都不会刷新旧 Run Snapshot。Snapshot资源缺失或 Hash不匹配时必须 Quarantine，不能 fallback到 `latest`。

<a id="part-4-6"></a>

### 4.6 Source、Plan 与 Compiler边界

```text
GraphScopeSpec / Source IR
  -> Strict Parse
  -> Bind exact Registry Snapshot
  -> Validate Interface/Policy/DAG/Port/Completion
  -> Generate Proof和 Program Hash
  -> Compiled Scope Plan
  -> T2b Materialize Scope Instance
```

Source是 Authoring/Planner输入；Plan是 normalized、bound、immutable executable IR；Scope Instance是本次 Run中的实际状态对象。

Plan Hash排除 Instance ID、时间、Lease、实际 Input Value和 Runtime状态，因此相同 Source、Interface、Policy、Safety、Registry Snapshot和 Compiler会产生相同 Plan Hash。

Runtime只解释 Compiled Plan，不重新解析 Source Condition、不重新证明 Schema兼容，也不重新选择 Route顺序。

<a id="part-4-7"></a>

### 4.7 Compiler Proof

Compiler Proof不是自然语言解释、运行日志或通用形式化证明，而是结构化、版本化、可哈希的静态安全证书。它回答“为什么这项执行合同可以被接受”，而不证明 Agent业务结果一定正确。

主要 Proof包括：

| Proof | 证明内容 |
| --- | --- |
| Data Edge Compatibility Proof | Producer全部合法值是否都是 Consumer可接受值 |
| Completion Monotonicity Proof | Early Completion一旦成立，未来新增事实是否不会推翻它 |
| Cancellation Safety Proof | Early Close后剩余 Node是否都可安全 Fence、Cancel、Reconcile或 Compensate |

Data Edge Compatibility的核心命题是：

```text
Producer Value Set ⊆ Consumer Accepted Value Set
```

例如 Producer输出 `integer [0, 100]`，Consumer接受 `number [0, 1000]`，Compiler可以用 `numeric_range_subset` 规则生成 Proof。反过来若 Producer允许 `[0, 1000]` 而 Consumer只接受 `[0, 100]`，就必须返回 `schema_not_assignable`，不能因为部分值可用而放行。

第一版允许的结构化证明规则包括：

```text
identical_schema
const_subset
enum_subset
numeric_range_subset
closed_object_subtype
array_item_subtype
discriminated_union_subtype
```

重命名、字段合并或类型转换不属于 Proof；这类变化必须使用显式 Versioned Adapter Node。

Early Completion还必须同时具有：

```text
Monotonicity Proof
+ Cancellation Safety Proof
= 允许 Early Close
```

`accepted_count >= 2` 随事实增加只会保持 True，因此可以证明单调；`error_count == 0` 可能被晚到 Error Fact推翻，不能用于 Early Rule。即使 Predicate单调，仍要证明所有可能被截断的 effectful Node具有可信的 cancellation contract，否则返回 `early_completion_cancellation_unsafe`。

生成过程是：

```text
冻结 Source/Schema/Policy/Safety/Registry Snapshot
  -> 构造待证明命题
  -> 使用 pinned Proof Algorithm和有限 Proof Rule推导
  -> 成功：保存 Proof Detail/Hash并写入 Plan
  -> 失败：返回稳定 Compiler Diagnostic
```

Proof保存 Algorithm Version/Hash、输入 Schema或 Node Contract Hash、采用的规则、Detail Ref/Hash和最终 Proof Hash。Runtime只验证完整性并执行 Plan，不在 Recovery时重新证明；Proof或 Algorithm Hash缺失、不匹配时进入 Quarantine。

<a id="part-4-8"></a>

### 4.8 Program Hash

Program是 Compiler从 Source表达式生成的一小段 normalized executable logic，例如 Condition、Trigger、Completion Fact或 Input Selection程序。Program Hash回答：

> Runtime这次究竟按照哪一段确定性逻辑做出了判断？

Condition Program典型包含：

```ts
interface CompiledConditionProgram {
  normalized_ast: ConditionExpr;
  operand_schema_hashes: Record<string, string>;
  max_steps: number;
  program_hash: string;
}
```

概念上的计算过程是：

```text
canonical program payload
  = normalized AST
  + bound schema hashes
  + execution limits
  + program format/version

program_hash
  = SHA-256(domain separator + canonical program payload)
```

精确字段和 Domain Separator由 Contract Pack固定。Program Hash基于编译结果而不是原始 JSON，因为同一 AST在不同 Operand Schema、Short-circuit顺序或 Limit下可能具有不同执行合同。

Runtime在 Trigger Cut、Input Snapshot和 Completion Eligibility等权威决策中保存对应 Program Hash。恢复时可以验证“这个结果确实由当前 Pinned Plan中的同一程序产生”，而不是从 Source重新编译并猜测旧逻辑。

几个 Hash的边界：

| Hash | 标识内容 |
| --- | --- |
| Source Hash | 原始 Graph Source的 canonical内容 |
| Program Hash | 一小段已编译可执行逻辑 |
| Proof Hash | 某项静态安全证明和证明细节 |
| Compiled Edge Hash | 一条完整 Compiled Edge |
| Plan Hash | 整个 Compiled Scope Plan |
| Value Hash | 一次实际输入或输出值 |

Program Hash证明内容身份和完整性，不证明逻辑在业务上正确，也不是签名、权限令牌或结果 Hash。两段人类看来等价的表达式也不保证具有相同 Hash，除非 Pinned Normalizer明确把它们归一化为同一 Program。尤其 `and/or` 采用从左到右 Short-circuit，参数顺序可能改变 Error语义，不能随意排序。

<a id="part-4-9"></a>

### 4.9 后续需要补充的 Compiler主题

本部分后续讲解需要继续覆盖：

- Strict JSON、Duplicate Key和 Closed Schema。
- RFC 8785 Canonicalization和 Domain-separated Hash。
- Policy Intersection和 Safety Enforcement Matrix。
- Static Child Plan Closure。
- Compiler Toolchain Manifest、Error Catalog和 Sealed Golden Bundle。

---

<a id="part-5"></a>

## 第五部分：DAG 执行语义

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [5.1](#part-5-1) | Control Edge 与 Data Edge |
| [5.2](#part-5-2) | Condition 与 Route Group |
| [5.3](#part-5-3) | Trigger |
| [5.4](#part-5-4) | Node Input Aggregation |
| [5.5](#part-5-5) | Input Seal |
| [5.6](#part-5-6) | Node Ready/Skip判断 |
| [5.7](#part-5-7) | 后续需要补充的执行语义 |

原规范入口：

- [Control Edge、Condition 与 Trigger](./dynamic-workflow-dag-framework.md#control-edgecondition-与-trigger)
- [Data Edge、Port 与 Input Seal](./dynamic-workflow-dag-framework.md#data-edgeport-与-input-seal)
- [Graph 与 Node 状态模型](./dynamic-workflow-dag-framework.md#graph-与-node-状态模型)
- [Resource Ledger 与调度](./dynamic-workflow-dag-framework.md#resource-ledger-与调度)

<a id="part-5-1"></a>

### 5.1 Control Edge 与 Data Edge

最核心的区别：

> Control Edge传递“这条路径走不走”；Data Edge传递“目标 Node拿到什么值”。

Control Edge状态：

```text
unresolved -> taken | not_taken | error
```

后三种都是不可逆解析结果：

| 状态 | 含义 | 对 Trigger的影响 |
| --- | --- | --- |
| `unresolved` | 还没有权威路由结论，通常是 Source Node尚未 Terminal | 对应事实尚未知，Trigger可能保持 Unknown |
| `taken` | `on`、Condition和 Route Group仲裁后确定选择该路径 | 向 Trigger贡献 True |
| `not_taken` | 已确定不走该路径，不是暂时没有选中 | 向 Trigger贡献 False |
| `error` | Condition、Route合同或完整性校验无法可信完成 | 触发 Scope Orchestration Error |

`unresolved` 不等于 False。Source Node仍在执行时，未来可能将 Edge解析为任一最终状态。Edge一旦变成 `taken/not_taken/error`，就不能被 Late Fact或 Recovery改写。

`not_taken` 的常见原因包括：Source Outcome与 `on` 不匹配、Condition=False、`first_matching` 中更高优先级 Edge已经胜出、Default前已有匹配项，或 `no_match=allow`。`error` 不能降级为 `not_taken`，否则 Schema错误、Pointer拼错或非法路由会被伪装成正常业务分支未命中。

Source Node=`failed` 也不等于 Edge=`error`。前者是正常 Terminal Fact，可以被 `on.statuses=['failed']` 的 Failure Fallback Edge匹配为 `taken`；后者表示路由机制自身失败。

Data Edge状态：

```text
unresolved -> available | unavailable | error
```

它从 Scope Input、Literal或 Node Output读取 typed Value，送到目标 Node Input Port。

```text
Control Edge -> Trigger       回答“要不要执行”
Data Edge    -> Input Seal    回答“执行时用什么数据”
```

Data Edge可以绑定 `guard_control_edge_id`。Guard=`not_taken` 时 Data Edge确定为 `unavailable`，避免未选分支永远等待不可能到达的数据。

<a id="part-5-2"></a>

### 5.2 Condition 与 Route Group

Condition挂在单条 Control Edge上，回答“Source Node已经结束后，这条 Edge是否匹配”。执行顺序固定为：

```text
Source Node Terminal
  -> on匹配 status/code/child_exit
  -> when Condition求值
  -> Route Group仲裁
  -> Edge = taken | not_taken | error
```

Condition只能读取：

```text
frozen Scope Input
Edge Source Node已经发布的 Output
Edge Source Node的 terminal status/code/child_exit
```

它不能读取其他任意 Node、Live Workflow Context、时钟、随机数、模型、Tool或外部 API。支持的受限 typed AST操作包括：

```text
and / or / not
exists
eq / ne
lt / lte / gt / gte
in
```

Evaluator采用 Total、严格类型语义：

- JSON Pointer缺失产生内部 `absent` Sentinel；JSON `null` 仍是存在的值。
- `exists` 只判断 Operand是否非 Absent。
- `eq/ne` 要求双方存在且类型兼容，使用 Canonical JSON结构相等。
- 大小比较只允许 Number-Number或 String-String，禁止隐式类型转换。
- `in` 要求右侧为 Array。
- 非 `exists` 操作遇到 Absent、类型不匹配、非有限 Number或 Safety Limit溢出时产生 Condition Error。
- `and/or` 按参数顺序从左到右 Short-circuit，未求值分支不产生 Error。

因此检查可选字段时应先写 `exists(score) AND score >= 80`。如果直接比较缺失字段，结果是 Error而不是 False；这可以防止字段拼错被静默当成业务不匹配。

Route Group决定同一 Source Node的多条 Edge如何共同解析：

| Mode | 语义 |
| --- | --- |
| `all_matching` | 每条 Edge独立求值，可以同时有多条 `taken` |
| `first_matching` | 按唯一整数 Priority从高到低求值，只取第一条匹配 Edge |

`first_matching` 最多有一个 Default Edge。Default不允许声明 `on/when/priority`，只在前面的 Edge都不匹配时 `taken`；如果已有匹配，Default=`not_taken`。`all_matching` 禁止 Default和 Priority。

没有匹配且没有 Default时，`no_match=allow` 将组内 Edge全部解析为 `not_taken`；`no_match=error` 产生 Orchestration Error。同一 Source Node的全部 Route Group和 Ungrouped Edge在 Source Terminal事务中原子解析，避免部分 Edge看到不同事实。

Compiler把 Condition绑定 Operand Schema、校验 Pointer和类型、固定 Short-circuit顺序与最大步骤，再生成 Normalized Condition Program和 Program Hash。Runtime只执行该 Pinned Program。

<a id="part-5-3"></a>

### 5.3 Trigger

Trigger根据 Incoming Control Edge的三值状态决定 Node是否激活：

```text
root
all(edge_ids)
any(edge_ids)
quorum(edge_ids, min_taken)
expression(EdgeTruthExpr)
```

Trigger与 Condition不同：Condition判断一条 Edge，Trigger组合进入同一个 Node的多条 Edge。

| Trigger | True | False | Unknown |
| --- | --- | --- | --- |
| `root` | Node没有 Incoming Control Edge | 非法配置 | Scope尚未 Materialize |
| `all` | 全部 Edge=`taken` | 任一 Edge=`not_taken` | 其余情况仍有 `unresolved` |
| `any` | 任一 Edge=`taken` | 全部 Edge=`not_taken` | 尚无 `taken` 且仍有 `unresolved` |
| `quorum(N)` | Taken数量达到 N | Taken + Unresolved已不足 N | 其他情况 |
| `expression` | Strong Kleene三值表达式为 True | 表达式为 False | 表达式为 Unknown |

Trigger首次从 Unknown不可逆变为 True时立即冻结 Trigger Cut，记录 Witness Edge、Resolution Sequence和 Truth Program Hash。它不会等待 Data Input Seal才选择 Witness，Late Edge也不会改变已冻结 Cut。任何 Incoming Edge=`error` 都是 Scope Orchestration Error，不能由 Trigger忽略。

<a id="part-5-4"></a>

### 5.4 Node Input Aggregation

Scope Input Port在 Materialize时已经是单个冻结参数；Node Input Port可以接收多条 Data Edge，因此必须声明“选择哪些值”和“何时封闭”的聚合策略：

```text
single/only
single/first_resolved
single/lowest_edge_id
list/all_sources_resolved
list/first_n_available
```

`single` 表示最终选择一个来源，不表示业务值只能是 Scalar；选中的值仍然可以是 Object或 Array。

| Single策略 | 语义 |
| --- | --- |
| `only` | 最多一条 Source Edge；适合普通唯一参数 |
| `first_resolved` | 选择第一条变为 `available` 的 Edge，显式接受完成顺序影响结果 |
| `lowest_edge_id` | 等全部 Source封闭后，选择 ID最小的 Available Edge |

`first_resolved` 不是第一条变成 `unavailable` 的 Edge；同一事务有多个 Available值时按 Edge ID Tie-break。`lowest_edge_id` 与物理完成顺序无关，适合要求稳定重放的场景。

Single Port还声明 `required` 和可选 Default：

```text
有 Available值                         -> 选择真实值
全部 Source封闭且没有值，但有 Default -> 使用 Default
没有值/Default且 required=false       -> Seal为显式 Absent
没有值/Default且 required=true        -> Input Impossible
```

Default只在全部 Source Resolution封闭且没有 Available值后使用，不与真实值竞争。

`list` 收集多个来源，使用 `min_items` 表示最低可用数量：

| List策略 | 语义 |
| --- | --- |
| `all_sources_resolved` | 等全部来源封闭，再收集所有 Available值 |
| `first_n_available(N)` | 收到 N个 Available值后立即 Seal，不等待其余来源 |

如果所有来源先封闭而 `first_n_available` 尚未达到 N，只要 Available数量仍满足 `min_items`，就用全部 Available值 Seal；少于 `min_items` 才是 Input Impossible。Seal之后的 Late Value只保留审计，不能进入 Snapshot。

List顺序必须显式选择：

| Order | 含义 |
| --- | --- |
| `edge_id` | 按稳定 Edge ID排序，不依赖完成顺序 |
| `resolution_seq` | 按 Runtime持久化的权威解析顺序排序，同 Sequence再按 Edge ID Tie-break |

聚合只负责选择、封闭和排序，不执行 Dedupe、Score、Merge、Reduce或业务判断。这些计算必须由显式 System、Delegation或其他业务 Node完成。

<a id="part-5-5"></a>

### 5.5 Input Seal

Input Seal表示一个 Input Port的最终选择已经确定，或者已经确定 Required Input不可能满足。它不是简单的“某个值到了”。

Input Snapshot保存：

- 被选择的 Data Edge。
- Value Ref/Hash和 Schema Hash。
- Resolution Sequence。
- Aggregation/Selection Program Hash。
- Optional Absent或 Default使用事实。

Seal后 Late Value不能重新选择输入。

例如 List Port使用 `first_n_available(count=3)`，达到三个 Available Value后立即 Seal。其余 Late Value保留审计，但不能进入 Snapshot。

Optional只表示全部来源封闭且没有值时可以 Seal为 Absent，不表示 Runtime可以忽略仍为 `unresolved` 的 Source Edge。Data Edge=`error` 也不能被聚合策略跳过，而是触发 Scope Orchestration Error。

<a id="part-5-6"></a>

### 5.6 Node Ready/Skip判断

```text
Trigger Cut = true
+ 所有 Input Port已 Seal
= Node ready
```

| Trigger | Input状态 | Node结果 |
| --- | --- | --- |
| True | 全部 Sealed | Ready |
| False | 任意 | Skipped/route_not_selected |
| True | Required Input Impossible | Skipped/input_unavailable |
| Unknown | 任意 | 继续等待 Control Edge |
| True | Input尚未封闭 | 继续等待 Data Edge |

Control/Data/Trigger/Input Seal分离后，系统可以明确表达无数据控制依赖、带数据但未选中的分支、Any/Quorum路由、确定性 Fan-in和 Failure Fallback。

<a id="part-5-7"></a>

### 5.7 后续需要补充的执行语义

本部分后续讲解需要继续覆盖：

- Fixed-point Reconcile顺序。
- Scheduler Fairness、Admission和 Backpressure。

---

<a id="part-6"></a>

## 第六部分：Node 与动态结构

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [6.1](#part-6-1) | 八类 Node完整枚举 |
| [6.2](#part-6-2) | Subgraph |
| [6.3](#part-6-3) | Expand |
| [6.4](#part-6-4) | Map |
| [6.5](#part-6-5) | 三者对比和触发时机 |
| [6.6](#part-6-6) | 后续需要补充的 Node语义 |

原规范入口：

- [完整 Node Union](./dynamic-workflow-dag-framework.md#完整-node-union)
- [Delegation 与 System](./dynamic-workflow-dag-framework.md#delegation-与-system)
- [Wait](./dynamic-workflow-dag-framework.md#wait)
- [Join](./dynamic-workflow-dag-framework.md#join)
- [Subgraph 与 Expand](./dynamic-workflow-dag-framework.md#subgraph-与-expand)
- [Map](./dynamic-workflow-dag-framework.md#map)
- [Terminal](./dynamic-workflow-dag-framework.md#terminal)

<a id="part-6-1"></a>

### 6.1 八类 Node完整枚举

```ts
type GraphNodeType =
  | 'delegation'
  | 'system'
  | 'wait'
  | 'join'
  | 'subgraph'
  | 'expand'
  | 'map'
  | 'terminal';
```

| 分组 | Node | 作用 |
| --- | --- | --- |
| 执行 | Delegation | 调用 Agent/Delegation Capability |
| 执行 | System | 调用 System Capability |
| 等待 | Wait | Durable Signal、Timer或 Approval |
| 结构 | Join | 只暴露已 Sealed输入，不做业务计算 |
| Child Owner | Subgraph | 创建一个固定结构 Child Scope |
| Child Owner | Expand | 创建一个运行时结构 Child Scope |
| Child Owner | Map | 为集合 Item创建同构 Child Scope |
| 出口 | Terminal | 提交 Named Exit Candidate |

`parallel`、`loop`、`retry`、`router`、`planner` 和 `approval` 都不是额外 Node类型：Parallel是 Scheduler行为；Retry创建 Attempt；Planner是 Delegation Capability；Approval是 Wait Contract的一种。

<a id="part-6-2"></a>

### 6.2 Subgraph

Subgraph类似调用一个预编译函数：

```text
Parent: prepare -> verify_package(Subgraph Owner) -> publish

Child: check_files -> run_tests -> security_review -> passed|rejected
```

Child Source、Interface和 Plan在 Parent Compile时已经确定。Owner Input Seal后创建唯一 `child_key=single` 的 Child Scope，等待 Child Cut，再发布 Child Completion Envelope和可选 Exposed Ports。

适用于固定审批、固定质量检查和可复用标准子流程。

<a id="part-6-3"></a>

### 6.3 Expand

Expand用于执行到当前时刻才知道 Child DAG结构的场景：

```text
analyze_gaps
  -> planner生成 Candidate GraphScopeSpec
  -> expand Owner冻结 Spec
  -> Pinned Compiler校验
  -> 创建一个 Child Scope
```

Planner只是普通 Capability，不能自己创建 Child。Expand只接受满足固定 Child Interface、Policy Allowlist和 Safety Ceiling的 Source。它不能修改 Parent Plan或扩大权限。

<a id="part-6-4"></a>

### 6.4 Map

Map对 Frozen Collection中的每个 Item创建同构 Child Scope：

```text
analyze_competitors(Map Owner)
├─ Child Scope: company-a
├─ Child Scope: company-b
└─ Child Scope: company-c
```

Map先冻结 Collection Hash、Item Index/Key和所有 Result Slot，再按 Concurrency和 Ledger额度物化 Child。

完成策略包括：

- `all_settled`
- `all_accepted`
- `quorum`

结果按原始 Index封装成 immutable Result Manifest。Map不负责 Dedupe、Score、Merge或 Reduce；这些业务计算必须由后续 Join/System/Delegation显式完成。

<a id="part-6-5"></a>

### 6.5 三者对比和触发时机

| Node | Child结构 | Child数量 | 触发时机 |
| --- | --- | ---: | --- |
| Subgraph | Parent Compile时固定 | 1 | Owner Trigger=True且 Inputs Sealed |
| Expand | 运行时 Frozen Spec决定 | 1 | Graph Spec Input Sealed后编译创建 |
| Map | Body固定，Item不同 | 0..N | Collection Input Sealed后冻结 Manifest并创建 |

三者都是 Child Scope Owner Node，不是 Child Workflow创建器。Child Workflow只能由 Published Definition Transition中的 `start_child_workflow` Effect触发。

<a id="part-6-6"></a>

### 6.6 后续需要补充的 Node语义

本部分后续讲解需要继续覆盖：

- Delegation/System Continuation Context和 Effect Key。
- Wait Inbox-first、Authorization和 Deadline竞争。
- Join的结构化 Fan-in边界。
- Child Completion Envelope和 Expose Port。
- Map Quorum Winner、Closing Remaining和 Result Manifest。
- Terminal Node Candidate Sequence。

---

<a id="part-7"></a>

## 第七部分：Completion 与外层推进

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [7.1](#part-7-1) | Terminal Candidate |
| [7.2](#part-7-2) | Completion Coordinator |
| [7.3](#part-7-3) | Close Request 与 Completion Cut |
| [7.4](#part-7-4) | Transition |
| [7.5](#part-7-5) | T8 如何推进外层 State |
| [7.6](#part-7-6) | 后续需要补充的 Completion主题 |

原规范入口：

- [Completion Policy、Early Close 与 Named Exit](./dynamic-workflow-dag-framework.md#completion-policyearly-close-与-named-exit)
- [Edge Resolution、Candidate 与 Cut](./dynamic-workflow-dag-framework.md#edge-resolutioncandidate-与-cut)
- [事务边界与 CAS](./dynamic-workflow-dag-framework.md#事务边界与-cas)
- [Retry、Pause、Cancel 与 Compensation](./dynamic-workflow-dag-framework.md#retrypausecancel-与-compensation)

<a id="part-7-1"></a>

### 7.1 Terminal Candidate

Graph Terminal Node Ready后：

1. 校验对应 Named Exit的 Required Output Ports。
2. 冻结 Exit Output Snapshot。
3. 创建 immutable Terminal Candidate。
4. 分配单调 `candidate_seq`。

Candidate表示“Scope可以从这个 Named Exit正常结束”的提议，不表示 Scope已经结束。多个并行 Terminal Node可能产生多个 Candidate，Completion Policy最终只选择一个。

Engine Error和 Cancel不伪装成 Candidate。

<a id="part-7-2"></a>

### 7.2 Completion Coordinator

Completion Coordinator是确定性数据库协调逻辑，不是 Agent或隐藏 Join。它负责：

- 观察 Candidate和 Node Terminal Fact。
- 计算 Completion Rule是否 Eligible。
- 按 Early或 Settled规则仲裁。
- 从匹配 Candidate中选择一个。
- 创建唯一 Close Request并冻结 Fact Frontier。

它不会合并 Candidate、做业务评分或直接推进 Workflow。业务聚合必须由显式 Node完成。

Early Rule使用 First Eligibility Event竞速语义，允许在全部 Node结束前选择结果；Settled Rule等 Candidate集合封闭和 Scope达到 Fixed Point后按 Priority仲裁。

<a id="part-7-3"></a>

### 7.3 Close Request 与 Completion Cut

二者含义不同：

```text
Close Request：结果已选中，开始关闭，Cleanup可能未完成
Completion Cut：最终结果和关闭边界已不可逆提交
```

Close Request会冻结 Candidate、递增 Work Fence、Fence普通 Work、取消 Active Execution，并按 Effect Contract执行 Reconcile或 Compensation。

Required Compensation处于 Failed、Unknown、Dead Letter或 Action Required时，Scope保持 Closing，不能写 Cut。

对于 Root Scope，Completion Coordinator先创建 Root Close Request；T7a完成 Subtree Fence；Cleanup/Child Cut收敛后，T8才创建 Root Cut。之前将其简写为“Coordinator创建 Root Cut”是不准确的。

<a id="part-7-4"></a>

### 7.4 Transition

Transition是外层 Workflow State Machine中，从当前 State进入目标 State的受信任规则：

```ts
interface WorkflowDefinitionTransition {
  target: string;
  context_patch?: WorkflowContextPatchSpec;
  notify?: WorkflowDefinitionNotify;
  card?: WorkflowDefinitionCardRef;
  effects?: TrustedWorkflowTransitionEffects;
}
```

Graph Edge推进同一个 Activation内的 Node；Transition推进不同 State Activation。Transition不能内嵌任意 Capability、Prompt或动态目标 State。

Root正常 Named Exit选择 `exit_routes` 或简单 State的 `on_complete`；Engine Error走 `on_error`；Local Graph Cancel走 `on_local_cancel`；Global Workflow Cancel不走 Transition。

<a id="part-7-5"></a>

### 7.5 T8 如何推进外层 State

T8要求 Root和 Run处于 Closing、Operational State Healthy、Winning Close Request匹配且 Required Cleanup全部收敛，然后在一个事务中：

- 插入唯一 Root Completion Cut。
- 关闭 Root Scope和 Graph Run。
- 把 Source Activation从 Active改为 Completed。
- 应用 Trusted Typed Context Patch。
- 写 Transition History、Checkpoint和 Outbox Intent。
- 增加 Workflow Revision。
- 为目标非 Terminal State创建新 Activation、Run、Snapshot和 Root Shell。
- 或创建并立即完成 Terminal Activation和 Workflow Final Outcome。

简单 Delegation/System State的成功链路：

```text
Input Seal
  -> Attempt pass
  -> Node succeeded并发布 Typed Output
  -> Success Terminal Candidate
  -> Completion Coordinator选择 Success
  -> Root Close Request
  -> T7 Fence/Cleanup
  -> T8 Root Cut
  -> on_complete.success Transition
  -> 下一个 State Activation/Run
```

<a id="part-7-6"></a>

### 7.6 后续需要补充的 Completion主题

本部分后续讲解需要继续覆盖：

- Early Monotonicity Proof和 Cancellation Safety Proof。
- Eligibility Event Sequence和 Paused Resume Arbitration。
- Settled Quiescence和 `no_exit_selected`。
- Parent/Child Close Request不覆盖规则。
- Subtree Fence Manifest和 Close Cleanup Lane。
- Required Child Finalization与 Root Cut Barrier。

---

<a id="part-8"></a>

## 第八部分：可靠性、资源与副作用

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [8.1](#part-8-1) | 本部分学习目标 |
| [8.2](#part-8-2) | 已建立的基础概念 |
| [8.3](#part-8-3) | 后续讲解路线 |

原规范入口：

- [Capability Catalog 与 Effect Contract](./dynamic-workflow-dag-framework.md#capability-catalog-与-effect-contract)
- [Mutable External Resource Mutation](./dynamic-workflow-dag-framework.md#mutable-external-resource-mutation)
- [Resource Ledger 与调度](./dynamic-workflow-dag-framework.md#resource-ledger-与调度)
- [Durable Domain Resource Claims](./dynamic-workflow-dag-framework.md#durable-domain-resource-claims)
- [Retry、Pause、Cancel 与 Compensation](./dynamic-workflow-dag-framework.md#retrypausecancel-与-compensation)
- [Outbox、Lease 与恢复](./dynamic-workflow-dag-framework.md#outboxlease-与恢复)

<a id="part-8-1"></a>

### 8.1 本部分学习目标

本部分解释“外部物理执行只能 At-least-once，Runtime如何让逻辑状态 Exactly-once”：

- Attempt、Execution Retry和 Quality Revision。
- Effect Recovery Kind与 Effect Impact。
- Idempotent Operation Key、Receipt和 Reconcile。
- Compensation和 Cut Barrier。
- Outbox Delivery Policy、Lease和 Dead Letter。
- Resource Ledger、Safety Ceiling和 Live Capacity。
- Domain Claim与 Fencing Token。

<a id="part-8-2"></a>

### 8.2 已建立的基础概念

前文已经建立：

- Node是逻辑目标，Attempt是物理尝试。
- 只有最终 Pass Attempt发布 Node Typed Output。
- Workflow Deadline跨全部 Activation/Run且不可延期。
- Domain Claim保护外部业务资源，Graph Ledger管理 Runtime内部额度。
- Scope关闭后普通 Late Work必须被 Fence。
- Required Compensation未成功时不能写 Completion Cut。

<a id="part-8-3"></a>

### 8.3 后续讲解路线

后续按以下顺序展开：

```text
Capability完整执行合同
  -> Attempt和 Retry Schedule
  -> External Effect Intent/Receipt
  -> Outbox Delivery/Reconcile
  -> Compensation
  -> Ledger Reservation/Posting
  -> Safety与 Capacity
  -> Pause/Cancel/Operational Blocker
```

---

<a id="part-9"></a>

## 第九部分：持久化、事务与恢复

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [9.1](#part-9-1) | 本部分学习目标 |
| [9.2](#part-9-2) | T0-T8事务地图 |
| [9.3](#part-9-3) | 后续讲解路线 |

原规范入口：

- [持久化字段、时间与 SQLite 约束](./dynamic-workflow-dag-framework.md#持久化字段时间与-sqlite-约束)
- [持久化模型](./dynamic-workflow-dag-framework.md#持久化模型)
- [事务边界与 CAS](./dynamic-workflow-dag-framework.md#事务边界与-cas)
- [SQLite Execution Profile](./dynamic-workflow-dag-framework.md#sqlite-execution-profile)
- [Snapshot 与 Checkpoint](./dynamic-workflow-dag-framework.md#snapshot-与-checkpoint)

<a id="part-9-1"></a>

### 9.1 本部分学习目标

本部分解释权威事实如何进入独立 `workflow-runtime.db`，以及 Crash为什么不能造成半个 Graph、重复 Cut或重复 Transition：

- Logical Schema与 Executable DDL Gate。
- UTC Unix Milliseconds、Row Version、Epoch和 Sequence。
- Short Transaction、CAS、Lease和 Work Fence。
- Immutable Value/Blob Store。
- Fact/Event、Inbox/Late Result和 Effect Journal。
- Checkpoint Watermark和 Recovery Decision。

<a id="part-9-2"></a>

### 9.2 T0-T8事务地图

| 事务 | 核心职责 |
| --- | --- |
| T0/T0p | Intake、Routing、Idempotent Creation和 Required Child Provenance |
| T1 | Activation、Run、Snapshot、Root Shell和 Build |
| T2a/T2b | Compile Result Persistence和 Scope Materialization |
| T3a/T3b | Fact Fixed Point、Early Eligibility和 Settled Close |
| T4 | 按 Node Kind激活 Attempt、Wait、Join、Terminal或 Child Build |
| T5 | 冻结 Dispatch Context、Claim Binding和 Effect Intent |
| T6a-e | Worker/Callback/Wait/Timer/Remediation结果 |
| T7a-c | Scope Close、Child Finalize和 Cancel Ingress |
| T8 | Root Cut、Context Patch、Transition和 Next Activation |

已经展开的 T0/T1/T2和 T8分别见[第二部分](#part-2)、[第三部分](#part-3)和[第七部分](#part-7)。

<a id="part-9-3"></a>

### 9.3 后续讲解路线

后续按以下顺序展开：

```text
Logical Schema对象关系
  -> Value/Blob耐久性
  -> CAS与 Work Fence
  -> T3 Fixed Point
  -> T7 Subtree Fence
  -> T8 Exactly-once Transition
  -> Checkpoint和 Recovery
  -> SQLite Profile与 Supported Limits
```

---

<a id="part-10"></a>

## 第十部分：控制面、产品化与实施

### 本部分索引

| 小节 | 内容 |
| --- | --- |
| [10.1](#part-10-1) | 本部分学习目标 |
| [10.2](#part-10-2) | 产品和模块边界 |
| [10.3](#part-10-3) | 实施 Gate |
| [10.4](#part-10-4) | 后续讲解路线 |

原规范入口：

- [Workflow Runtime Command 授权与审计](./dynamic-workflow-dag-framework.md#workflow-runtime-command-授权与审计)
- [Runtime Center（运行中心）与 Trace](./dynamic-workflow-dag-framework.md#runtime-center运行中心与-trace)
- [模块边界](./dynamic-workflow-dag-framework.md#模块边界)
- [测试策略与模型验证](./dynamic-workflow-dag-framework.md#测试策略与模型验证)
- [开发期实施顺序](./dynamic-workflow-dag-framework.md#开发期实施顺序)
- [完整验收标准](./dynamic-workflow-dag-framework.md#完整验收标准)

<a id="part-10-1"></a>

### 10.1 本部分学习目标

本部分解释 Runtime如何被用户、Feature、API和 Automation安全控制并形成可观测产品：

- Runtime Command Gateway和 Immutable Command Audit。
- Actor、Delegation、Permission、Policy和 State Guard。
- Runtime Center Workflow/Agent/Pending/Trace四类视图。
- Projection、Rebuild、Deep Link和独立 Renderer Bundle。
- Workflow与非 Workflow Trace关联。
- 模块依赖方向和 Runtime DB写边界。

<a id="part-10-2"></a>

### 10.2 产品和模块边界

关键边界：

```text
Runtime Store = 权威执行事实
Projection = 可重建读模型
Runtime Command Gateway = 唯一通用控制入口
Feature UI = 领域任务和 Typed Business Command
Runtime Center = 跨 Feature索引、通用控制、诊断和审计
Trace = 独立执行观测，Workflow Correlation可空
```

Runtime Center、Feature Page、API和 Automation都不能直接写 Runtime表。Projection提供按钮提示，但 Gateway必须重新读取权威状态并校验 Expected Row Version和权限。

<a id="part-10-3"></a>

### 10.3 实施 Gate

目标实施顺序为：

```text
G0 Contract Pack / Static Baseline
  -> G1 DDL / Store
  -> G2 Compiler / Sealed Golden
  -> G3 Registry / Authoring / Publish
  -> G4 Test-only Bootstrap
  -> G5 Basic Runtime
  -> G6 Dynamic / Close
  -> G7 Control / Card / Projection / Recovery
  -> G8 Certification
  -> G9 Production Activation
```

G1和 G2可在 G0后并行，但依赖后续 Gate的实现不能提前绕过。目标架构已确认不代表 DDL、Golden、Store、Runtime或 Production Certification已完成。

<a id="part-10-4"></a>

### 10.4 后续讲解路线

后续按以下顺序展开：

```text
Command Union和授权
  -> Operational Remediation
  -> Projection和 Runtime Center
  -> Trace Correlation
  -> Module Boundary
  -> Fixture/Property/Model/Fault Test
  -> Supported Limit Benchmark
  -> G0-G9交付和 Production Activation
```

---

## 跨部分速查

| 问题 | 入口 |
| --- | --- |
| State、Node、Attempt有什么区别？ | [1.2](#part-1-2) |
| Scope Tree为什么不是全局 DAG？ | [1.4](#part-1-4) |
| Child Scope与 Child Workflow有什么区别？ | [1.5](#part-1-5) |
| 为什么不允许 Detached Branch？ | [1.6](#part-1-6) |
| Router输出一个还是多个候选？ | [2.3](#part-2-3) |
| RecipeRef属于当前 Scope是什么意思？ | [2.3](#part-2-3) |
| Definition、Policy、Recipe是什么关系？ | [2.5](#part-2-5) |
| Creation Key和 Intent Hash如何幂等？ | [2.7](#part-2-7) |
| Workflow Deadline和 Control Ownership是什么？ | [2.8](#part-2-8) |
| 五类 State如何 Lower？ | [3.2](#part-3-2) |
| Context Slot如何传递动态 Graph？ | [3.7](#part-3-7) |
| Artifact和 Template有什么区别？ | [3.7](#part-3-7) |
| T2a和 T2b分别做什么？ | [3.8](#part-3-8) |
| Attempt何时发布 Typed Output？ | [3.9](#part-3-9) |
| Port、Required和 Optional是什么意思？ | [4.2](#part-4-2) |
| `request`、`locale` 是固定 Scope Input枚举吗？ | [4.2](#part-4-2) |
| Scope Interface和 Named Exit是什么？ | [4.1](#part-4-1)、[4.3](#part-4-3) |
| Registry和 Snapshot有什么区别？ | [4.4](#part-4-4)、[4.5](#part-4-5) |
| Compiler生成的 Proof证明什么？ | [4.7](#part-4-7) |
| Program Hash标识什么？ | [4.8](#part-4-8) |
| Control Edge和 Data Edge有什么区别？ | [5.1](#part-5-1) |
| Control Edge四种状态分别是什么？ | [5.1](#part-5-1) |
| Condition和 Trigger有什么区别？ | [5.2](#part-5-2)、[5.3](#part-5-3) |
| Node Input的 Single/List如何聚合？ | [5.4](#part-5-4) |
| Trigger、Input Seal和 Ready如何配合？ | [5.3](#part-5-3)、[5.5](#part-5-5)、[5.6](#part-5-6) |
| Subgraph、Expand、Map分别是什么？ | [6.2](#part-6-2)、[6.3](#part-6-3)、[6.4](#part-6-4) |
| Candidate、Close Request和 Cut是什么关系？ | [7.1](#part-7-1)、[7.2](#part-7-2)、[7.3](#part-7-3) |
| Transition和 Graph Edge有什么区别？ | [7.4](#part-7-4) |
| T8如何推进外层 State？ | [7.5](#part-7-5) |

## 最终总览

```text
Creation Plane
  Task Intake -> Revision -> Routing -> Recipe -> Resolver -> T0

Outer Workflow
  Workflow -> State Activation -> Transition -> Next Activation

Unified Execution
  Non-terminal State -> Graph Run -> Scope Tree -> Local DAG

Static Contract
  Registry Snapshot + Interface + Policy + Source
  -> Compiler -> Proof/Program Hash -> Plan

Runtime Dataflow
  Condition -> Control Edge -> Trigger
  Data Edge -> Input Aggregation -> Input Seal
  Trigger + Inputs -> Ready

Execution
  Node -> Attempt/Wait/Child Scope -> Typed Output

Completion
  Terminal Candidate -> Completion Coordinator -> Close Request
  -> Fence/Cleanup -> Completion Cut -> T8 Transition

Reliability
  CAS + Idempotency + Lease + Work Fence + Ledger + Outbox + Compensation

Product Surface
  Runtime Store -> Projection/Trace
  Runtime Command Gateway -> Authorized Control
```
