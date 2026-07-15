# Dynamic Workflow Graph Runtime 完整架构方案

> **状态**: 已确认目标架构、部署边界、创建溯源、恢复协议、首发产品下限、精确工具链、首个 Safety/Capacity/SQLite Profile、Command/Golden 治理与开发期 absence baseline（可直接启动 Contract Pack/Spec Stabilization；Store 开工受 Executable DDL Gate 约束，Production Runtime 激活受 certified Supported Limits、静态 absence baseline 与产品 surface coverage 门禁约束）
> **范围**: Icarus core workflow runtime
> **目标**: 统一静态 workflow、并行执行、运行时 DAG、条件路由、局部汇合、持久等待、子图和受约束动态扩图。

## 导航

- [实现索引](#实现索引)
- [已确认决策索引](#已确认决策索引)
- [核心对象与不变量](#核心对象模型)
- [Task Intake、Recipe 与 Workflow 创建](#task-intakerecipe-catalog-与-macro-routing)
- [Scope Interface、Source IR 与 fixture](#scope-interface-与-source-ir)
- [Edge、Port、Node 与 Completion 语义](#control-edgecondition-与-trigger)
- [Capability、Policy 与 Compiler](#capability-catalog-与-effect-contract)
- [状态、Ledger 与持久化模型](#graph-与-node-状态模型)
- [事务、CAS、Cancel 与恢复](#事务边界与-cas)
- [测试策略与模型验证](#测试策略与模型验证)
- [开发期重构约束与验收](#开发期直接重构约束)

## 实现索引

本索引用于把实现任务映射到必须共同阅读的规范章节，不是第二份规范，也不缩减正文约束。工作包的“主要入口”只表示开始阅读的位置；实现者仍必须阅读同一行列出的联读章节、对应核心不变量、已确认决策和验收条款。索引摘要与正文不一致时，以正文中的类型、Logical Schema、事务协议和验收条款为准。

### 使用规则

1. 开始实现前先确定一个或多个工作包，并按索引完成全局必读与工作包联读；不得只根据单个类型、表字段清单或验收条款反推完整行为。
2. 类型/Source IR、Compiler、Logical Schema、T0-T8 事务、Recovery 和测试模型共同构成执行合同。修改任一层时必须检查其他层是否需要同步变更。
3. 示例和 Fixture 用于固定格式、Hash、Error Code 或关键场景，不能覆盖正文的一般规则；持久化字段清单是 Normative Logical Schema，不能代替 executable migration。
4. 实现必须保持 exact version/hash、不可变 snapshot、CAS/fencing、幂等键和 append-only history 等既有约束，不得以临时 fallback、旁路 scheduler/completion 或事后修复原子事实简化工作包。
5. 每个工作包完成时，按其联读章节定位 [测试策略与模型验证](#测试策略与模型验证) 和 [完整验收标准](#完整验收标准) 中的对应门禁；Store 开工受 [Executable DDL Gate](#executable-ddl-gate) 约束，Production Runtime 激活另受 certified Supported Limits、`local_single_user` deployment profile、开发期静态 absence baseline 与 `ProductSurfaceCoverageManifest` 约束。

### 全局必读

所有工作包都必须先阅读：

- [已确认决策索引](#已确认决策索引)、[设计目标](#设计目标) 与 [非目标和硬边界](#非目标与硬边界)，确认实现范围和禁止引入的旁路。
- [核心对象模型](#核心对象模型)、[核心不变量](#核心不变量) 与 [术语](#术语)，确认对象边界、不可变事实和同名概念。
- [模块边界](#模块边界)，确认代码所有权和权威数据源。
- [开发期直接重构约束](#开发期直接重构约束)，确认本阶段不保留的新旧双轨能力。
- [完整验收标准](#完整验收标准) 中与工作包相关的条款，作为实现完成定义。

### 实现工作包

| ID | 实现范围 | 主要入口 | 必须联读 | 关键事务或门禁 |
| --- | --- | --- | --- | --- |
| I0 | Publish、Registry、Recipe 与执行版本固定 | [Task Intake、Recipe Catalog 与 Macro Routing](#task-intakerecipe-catalog-与-macro-routing)、[Versioned Registry 发布与保留](#versioned-registry-发布与保留) | [State 与 Graph 的统一](#state-与-graph-的统一)、[Capability Catalog 与 Effect Contract](#capability-catalog-与-effect-contract)、[Compiler 输入快照](#compiler-输入快照) | Publish compatibility preflight、T0、T1 |
| I1 | Task Intake、Routing、幂等创建、Required Child provenance 与 Domain Claim | [Task Intake、Recipe Catalog 与 Macro Routing](#task-intakerecipe-catalog-与-macro-routing) | [Durable Domain Resource Claims](#durable-domain-resource-claims)、[Intake、Routing 与 Creation](#intakerouting-与-creation)、[Workflow 与 Run](#workflow-与-run)、[与 Domain Recipe 的关系](#与-domain-recipe-的关系) | T0、T0p、T1、T8 |
| I2 | Workflow Definition、State lowering、Context 与外层 transition | [State 与 Graph 的统一](#state-与-graph-的统一) | [Scope Interface 与 Source IR](#scope-interface-与-source-ir)、[Completion Policy、Early Close 与 Named Exit](#completion-policyearly-close-与-named-exit)、[Context、Artifact 与 Quality Gate](#contextartifact-与-quality-gate)、[Snapshot 与 Checkpoint](#snapshot-与-checkpoint) | T1、T8 |
| I3 | Source Schema、IR、Port assignability 与 Graph Compiler | [Scope Interface 与 Source IR](#scope-interface-与-source-ir)、[Compiler](#compiler) | [Compiler Conformance Toolchain](#compiler-conformance-toolchain)、[Control Edge、Condition 与 Trigger](#control-edgecondition-与-trigger)、[Data Edge、Port 与 Input Seal](#data-edgeport-与-input-seal)、[完整 Node Union](#完整-node-union)、[Completion Policy、Early Close 与 Named Exit](#completion-policyearly-close-与-named-exit)、[Capability Catalog 与 Effect Contract](#capability-catalog-与-effect-contract) | Toolchain/Error Catalog/Golden Bundle、T2a、T2b |
| I4 | Runtime Store、SQLite typed relation、Value/Blob 与 executable migration | [持久化字段、时间与 SQLite 约束](#持久化字段时间与-sqlite-约束)、[持久化模型](#持久化模型) | [SQLite 关系展开规则](#sqlite-关系展开规则)、[Immutable Value/Blob Store](#immutable-valueblob-store)、[事务边界与 CAS](#事务边界与-cas)、[SQLite Execution Profile](#sqlite-execution-profile)、[Snapshot 与 Checkpoint](#snapshot-与-checkpoint) | Executable DDL Gate、Schema Manifest、schema-lint/constraint/query-plan fixtures |
| I5 | Graph 状态机、fixed-point reconcile、Scheduler 与 Ledger | [Graph 与 Node 状态模型](#graph-与-node-状态模型)、[Resource Ledger 与调度](#resource-ledger-与调度) | [Control Edge、Condition 与 Trigger](#control-edgecondition-与-trigger)、[Data Edge、Port 与 Input Seal](#data-edgeport-与-input-seal)、[Completion Policy、Early Close 与 Named Exit](#completion-policyearly-close-与-named-exit)、[事务边界与 CAS](#事务边界与-cas) | T2b、T3a、T3b、T4、Supported Limits |
| I6 | Delegation/System Attempt、Capability Effect 与 Outbox | [Capability Catalog 与 Effect Contract](#capability-catalog-与-effect-contract)、[Delegation 与 System](#delegation-与-system) | [Node、Attempt 与 Wait](#nodeattempt-与-wait)、[Inbox、Late Result、Event 与 Effect Journal](#inboxlate-resultevent-与-effect-journal)、[Durable Domain Resource Claims](#durable-domain-resource-claims)、[Outbox、Lease 与恢复](#outboxlease-与恢复) | T4、T5、T6a、T6b、T6d、T7a |
| I7 | Durable Wait、Signal/Timer/Approval 与 Inbox | [Wait](#wait) | [Workflow 级执行 Policy 与 Runtime Safety](#workflow-级执行-policy-与-runtime-safety)、[Node、Attempt 与 Wait](#nodeattempt-与-wait)、[Inbox、Late Result、Event 与 Effect Journal](#inboxlate-resultevent-与-effect-journal)、[Outbox、Lease 与恢复](#outboxlease-与恢复) | T4、T6c、T6d、wait CAS/fault fixtures |
| I8 | Subgraph、Expand、Map 与 child scope lifecycle | [Subgraph 与 Expand](#subgraph-与-expand)、[Map](#map) | [Scope Build 与 Expansion Manifest](#scope-build-与-expansion-manifest)、[Resource Ledger 与调度](#resource-ledger-与调度)、[Completion Policy、Early Close 与 Named Exit](#completion-policyearly-close-与-named-exit)、[Edge Resolution、Candidate 与 Cut](#edge-resolutioncandidate-与-cut) | T2a、T2b、T3、T7a、T7b |
| I9 | Completion、Pause/Cancel、Compensation、Operational Blocker、Root Finalization、Root Coordinator 与 Recovery | [Completion Policy、Early Close 与 Named Exit](#completion-policyearly-close-与-named-exit)、[Retry、Pause、Cancel 与 Compensation](#retrypausecancel-与-compensation) | [Edge Resolution、Candidate 与 Cut](#edge-resolutioncandidate-与-cut)、[Workflow 与 Run](#workflow-与-run)、[事务边界与 CAS](#事务边界与-cas)、[Outbox、Lease 与恢复](#outboxlease-与恢复)、[Snapshot 与 Checkpoint](#snapshot-与-checkpoint) | T3b、T6e、T7a、T7b、T7c、T8、Root Finalization/Recovery/Fault fixtures |
| I10 | Runtime Command、权限、Runtime Center 与 Trace | [Workflow Runtime Command 授权与审计](#workflow-runtime-command-授权与审计)、[Runtime Center（运行中心）与 Trace](#runtime-center运行中心与-trace) | [权限与安全](#权限与安全)、[SQLite Execution Profile](#sqlite-execution-profile)、[Outbox、Lease 与恢复](#outboxlease-与恢复)、[模块边界](#模块边界) | T7c、T8、Command/Trace properties、projection outbox |
| I11 | Contract Pack、测试模型、发布门禁、静态 absence baseline 与开发期交付 | [测试策略与模型验证](#测试策略与模型验证) | [Compiler Conformance Toolchain](#compiler-conformance-toolchain)、[开发期实施顺序](#开发期实施顺序)、[开发期直接重构约束](#开发期直接重构约束)、[完整验收标准](#完整验收标准)、[SQLite Execution Profile](#sqlite-execution-profile) | Contract Pack、Sealed Golden、Fixture/Property/Model/Fault、Product Floor benchmark、absence/coverage gate |

### 变更联动检查

| 发生变化的合同 | 必须同步检查 |
| --- | --- |
| Source IR、Node/Port/Condition 或 Compiled IR | closed schema、canonicalization/hash、assignability proof、Compiler error、plan snapshot、fixture 与 property generator |
| Workflow/Run/Scope/Node 状态或持久化字段 | Logical Schema、CHECK/FK/Index、CAS、T0-T8、Recovery、Checkpoint、projection 与 model/fault test |
| Policy、Safety Limit、Ledger Account 或 Supported Limit | policy intersection、Compiler/materialize preflight、reservation/posting、scheduler admission、root-fence 终止性与 benchmark profile |
| Capability、Wait、外部 Effect 或 Domain Claim | Registry closure、claim binding/fencing token、Attempt/Inbox/Outbox/Effect Journal、retry/reconcile/compensation、权限与 recovery |
| Candidate、Completion、Close Request 或 Cut | route/data fact、eligibility arbitration、subtree fence、child consumption、required compensation barrier、T3/T7/T8 与 checkpoint uniqueness |
| Command、运行中心 Projection 或 Trace correlation | Actor/Delegation/Policy Guard、immutable audit、Runtime Store 写边界、projection outbox、lineage validation 与独立 Trace 语义 |

### Codex 实现检查点

开始编码前：

1. 在任务说明中写明工作包 ID、计划修改的模块以及已经读取的必读章节。
2. 搜索目标类型、表、事务编号和验收关键词在全文中的全部引用，确认不存在未纳入计划的跨章节约束。
3. 若任务涉及 Store，先确认 executable migration 与 Schema Manifest 门禁；若会启动非 test-only Runtime，再确认匹配环境的 certified Supported Limits、`local_single_user` deployment profile、静态 absence baseline 与产品 surface coverage manifest。

完成编码后：

1. 对照变更联动检查确认类型、持久化、事务、恢复、观测和测试没有出现单层实现。
2. 按风险补齐固定 Fixture、Property、Model、Virtual Clock/Fake Adapter、Fault Injection 或真实 SQLite benchmark；不能只用 happy-path unit test 代替对应门禁。
3. 检查旧 scheduler、completion、retry、interrupt、transition、Runtime 表直写或 latest-version fallback 没有形成旁路。
4. 若实现暴露正文未定义的行为，先补齐或修正规范并重新检查受影响工作包，不由代码自行选择未记录语义。

## 已确认决策索引

本索引记录会话 `019f509b-2e43-7592-b47e-34096533bc93`、可实施性审查会话 `019f59f3-d4e5-7ec2-a7a7-9e202fe56254` 及其续接讨论中已经确认并在本文落地的结论；索引不是第二份规范，权威细节仍以对应章节的类型、Logical Schema、事务和验收条款为准。

| ID | 已确认结论 | 主要落点 |
| --- | --- | --- |
| A1 | 副作用拆成 recovery kind 与 impact；Publisher 派生传递闭包 | Recipe、Graph Policy、Capability Catalog |
| A2 | Shared Claim 只读；mutation 使用 exclusive/current token/gateway 与 claim slots | Domain Claims、Effect Journal、T0/T5 |
| A3 | Workflow/dispatch/execution deadline 与 durable Retry Schedule | Safety、Attempt/Retry DDL、T6d |
| A4 | Correlation 唯一 Wait 实例；有限 Pending TTL、分层额度与两阶段授权 | Wait、Inbox、T6c |
| A5 | Ledger 区分 account scope 与 consumer；Posting 原子更新多 Account | Resource Ledger、Scheduler |
| A6 | Safety 按作用域分组；Pinned Quota 与 Live Capacity、logical/physical bytes 分开 | Runtime Safety、Enforcement Matrix |
| A7 | Port 采用受限 Workflow Schema Profile 与 sound assignability proof | Compiler、Data Edge |
| A8 | Immutable Workflow Input、typed Context Contract/Patch、Terminal output binding | State、Workflow/Context DDL、T8 |
| A9 | Intake append-only revisions、selection threshold、intent hash 与 intent-bound confirmation | Creation Plane、T0 |
| A10 | 第一版暂缓 Value 机密性/读取隔离，保留完整性、Retention、容量与 secret-ref | Value/Blob Store、安全 |
| A11 | Work fence 与 close-cleanup authority 分离；Child outcome/Parent consumption 分离 | Close/Cut DDL、T7a/T7b |
| E1 | Child/Map 只发布 Value/Envelope refs 与 sealed manifest | Subgraph/Expand/Map、GC/计账 |
| E2 | Fixture、Property、Model、Virtual Clock/Fake Adapter 与 Fault Injection 并存 | 测试策略与模型验证 |
| E3 | T3/T7 按 versioned Supported Limits 测真实 SQLite 最坏事务 | SQLite Execution Profile、验收 |
| E4 | Workflow 权威数据使用独立 `workflow-runtime.db`，跨库仅 Outbox Projection | SQLite Execution Profile、模块边界 |
| E5 | Outbox 使用 versioned finite Delivery Policy、typed result、Reconcile 与 Effect-specific dead-letter 后果 | Outbox、Attempt History、恢复 |
| E6 | 显式 Publish 生成 Feature Execution Artifact；Run 固定 Core Protocol/ABI、Executor 与 Prompt exact refs | Registry、Executor、Core 升级 |
| E7 | Early Rule first-eligible；Settled Rule priority-first；竞速语义必须显式选择 | Completion Policy、T3/T7 |
| E8 | Blob 使用 Write Intent、file/directory fsync、no-replace install、GC 状态机与 Backup Pin | Value/Blob Store、备份恢复 |
| E9 | 运行中心、Feature、API、Automation 共用 Runtime Command Gateway、Actor/Delegation 与不可变审计 | Runtime Command、运行中心 |
| E10 | 权威时间统一 UTC Unix milliseconds；删除 `control_epoch`，统一 CHECK、Partial Index 与字段命名 | 持久化模型、SQLite DDL |
| E11 | Required compensation 只有成功 terminal 才解除 Cut barrier；`action_required` fail-closed | Completion、T7/T8、Outbox |
| E12 | Safety 与 certified Supported Limits 执行终止性交叉约束，保证合法 Run 一定可原子 root fence | Runtime Safety、SQLite Profile |
| E13 | 持久化清单明确为 Logical Schema；Executable DDL、Manifest、constraint/query-plan fixture 是 Store 前置门禁 | 持久化模型、验收 |
| E14 | Runtime Center 提供统一运行控制与观测入口；Trace 保持独立执行观测模型，Workflow 关联可空 | Runtime Center、Trace |
| S1 | Terminal State 创建 first-class Activation 并计入 activation budget，但不创建 Graph Run；T8 原子完成终态 | State、Workflow/Run Schema、T8 |
| S2 | Definition 使用 closed-world 目标合同；Recipe 固定 Context/Command Policy；旧字段直接拒绝且不兼容 | State、Recipe、Publisher |
| S3 | Direct Child Recipe allowlist 唯一归 Parent Recipe；与 entrypoint 可达集合相等；依赖图无环并共享 root lineage 额度 | Recipe、Compiler、T0/T8 |
| S4 | Value、Registry、Release、Retention 与 Backup 都有 first-class Logical Schema 和确定性 GC reachability | Value/Blob、Registry、DDL Gate |
| S5 | Safety、Ledger、Fact taxonomy、逐字段 Enforcement Matrix 与 SQLite Execution Profile 形成闭环 | Runtime Safety、Ledger、SQLite Profile |
| S6 | Compiled IR 保存 normalized Program、结构化 Proof、复杂度和静态 child closure；Runtime 不 recompile/re-prove | Compiler、Compiled Plan、Recovery |
| S7 | Context Patch 使用 Header + 多 Operation，能原子表达多 Slot set/clear | Workflow/Context Schema、T8 |
| S8 | Child Workflow Effect 固定 port、delivery、principal、creation domain 与 routing scope；required 创建由 Root Finalization Schedule 驱动并在 T8 原子提交 | Transition Effect、Finalization、T8 |
| S9 | 第一版 Executor 属于 Trusted Computing Base；Worker Process 不是 hostile-code sandbox；不可信插件以 Container/OS sandbox 为前置门禁 | Executor、权限与安全 |
| S10 | 实施顺序先冻结合同和 DDL/Store，再实现 durable T0/Runtime；test-only bootstrap 与 production certified-profile gate 分离 | 开发期实施顺序 |
| S11 | Command Header 负责幂等结果，Invocation 逐次追加认证、授权与 duplicate/conflict 审计 | Runtime Command Schema |
| S12 | Compiler 固定 parser/validator/JCS/toolchain manifest、Error Catalog 与完整 Golden Conformance Bundle | Compiler、测试与发布门禁 |
| S13 | Production v1 固定为 `local_single_user + node_service + darwin/arm64`，使用稳定 local-owner principal；Publisher/Executor 均为可信 TCB，不接纳不可信执行代码 | 权限与安全、Executor、Production Gate |
| S14 | 前置清理已建立无旧 Workflow execution/history、关联聊天、artifact/context、表/列、状态标签、代码、配置和兼容路径的开发 baseline；后续 Runtime 不提供导入、读取或恢复路径 | 静态 absence baseline、直接重构约束 |
| S15 | Notification/Card 只写 non-blocking durable Outbox intent，不提供 required delivery；required child 只走 Root Finalization，不进入 Outbox | Transition、Outbox、T8 |
| S16 | T8 原子完成 source Activation；Administrative Abandon 使用独立 `abandoned` Activation 状态且不生成 Cut | Activation Schema、Command、T8 |
| S17 | Child Workflow creation domain/key 由 Run Protocol 根据可信 lineage/close/effect 事实固定派生，不接受自由模板 | Transition Effect、T8、Creation |
| S18 | SQLite Gate/Factory 必须验证完整 database/connection PRAGMA 与 SQLite/native/Node identity，不允许只校验 WAL 三项 | Executable DDL Gate、SQLite Profile |
| S19 | Required Child 在 Schedule 创建时生成真实、确定性的 transition Intake/Revision/Routing/Creation Request；T8 只消费该 provenance 并原子创建 Child | Creation、Root Finalization、T0p/T8 |
| S20 | `action_required/quarantined` 使用 first-class Operational Blocker；Workflow business `status` 与 `operational_state` 分离，T6e 按剩余 blocker 原子恢复 operational state | 状态模型、Operational Blocker、T6e、Recovery |
| S21 | SQLite 权威内部关系禁止不可校验的 polymorphic `kind/id`；使用 typed nullable FK + exactly-one CHECK，外部稳定 ref 明确标注且不得伪装 FK | Executable DDL Gate、Value/Retention/Command Schema |
| S22 | Production v1 首发目标固定为 `local_single_user + node_service + darwin/arm64`，并冻结产品支持下限、事务预算、Retention 与 Blob Capacity baseline | Runtime Safety、SQLite Profile、Retention、Production Gate |
| S23 | `ProductSurfaceCoverageManifest` 与机器生成的 source/API/UI/schema/filesystem negative fixtures 共同证明已删除 surface 保持 absent；removed entry 不要求伪造 replacement | Removed Surface、CI |
| S24 | 实施使用 machine-readable Contract Pack、可并行 gate DAG、独立 sealed Golden oracle 与 `src/workflow-runtime/` 模块边界 | Compiler Toolchain、实施顺序、模块边界 |
| S25 | Core Runtime/Compiler 固定 Node `24.18.0`、npm `11.16.0` 与 exact direct toolchain packages；`.nvmrc`/CI/lock integrity/Executor image identity 一致 | Compiler Toolchain、SQLite Profile、实施顺序 |
| S26 | 首个 `local_single_user_safety@1`、Live Capacity baseline 与 `local_single_user_sqlite@1` 数值冻结；Safety immutable versioned、Capacity 可热调、SQLite restart/re-cert bound | Runtime Safety、SQLite Profile、Production Gate |
| S27 | Runtime Command 使用 closed union、typed target、closed permission/reason/denial catalogs 与 first-class `WorkflowControlOwnership`；Administrative Abandon 强制 intent-bound 二次确认 | Creation、Command、权限与安全 |
| S28 | Golden 由 AI/实现者起草、`human:local-owner` 语义批准、隔离 `golden-review/golden-seal` 打包；AI 和 Production Compiler 均不得批准 expected artifact | Compiler Conformance、发布门禁 |
| S29 | Runtime 实施从静态 absence baseline 开始；Production acceptance 重新验证旧 schema/data/files/code/config/test fixture/import/route 数量为零，且历史资料候选目录不可进入任何可执行闭包 | Absence Baseline、Migration Candidate、完整验收 |
| S30 | Dynamic Runtime v1 的实现、认证和 Production activation 允许 production-launchable Domain Recipe 数量为零；测试只使用隔离 synthetic resources | Recipe Baseline、测试策略、Production Gate |
| S31 | v1 authoring/publish 采用 `scaffold -> validate -> compile -> dry-run -> review -> publish -> activate` 工具链，不恢复通用 Workflow/Card 管理 UI | Authoring/Publish、Registry |
| S32 | Feature Manifest vNext 是 closed schema；旧四个 resource key 直接拒绝，不设 alias、fallback 或 compatibility reader | Feature Manifest vNext、Publisher |
| S33 | Card 展示使用 versioned `CardPresentationContract` 和 typed action binding；Card delivery/UI 不是 Workflow 状态源 | Card Presentation、Outbox、Command |
| S34 | Runtime Center 使用可重建 Projection API、稳定 deep link 和独立 renderer bundle；Feature renderer 保持独立 entry | Runtime Center、Projection、模块边界 |
| S35 | 单 Agent 目标迭代复用同一 logical Node 的 immutable Attempt；`needs_revision` 通过 typed feedback continuation 创建下一 Attempt，耗尽后确定性失败，不新增 loop State/Node 或 Graph cycle | Delegation/System、Attempt、Retry、Recovery |

## 背景

前置清理之前，Icarus 曾把 workflow definition、delegation、system action、interrupt、terminal、context pack、artifact contract、evaluator、host/container/IPC/MCP 混合在一套顺序状态机中；该 Runtime 和 authoring surface 现已移除。下列需求描述新 Dynamic Runtime 必须重新建立的通用能力，不授权复用已删除实现：

- 多分支并行、条件路由、failure fallback 和 quorum join。
- 每个节点独立 handoff、input snapshot、artifact contract、evaluator、retry 和 trace。
- graph 内 signal、timer、approval 等持久等待，同时让无关分支继续执行。
- 预编译 subgraph、collection map，以及根据上游产物创建受约束 child graph。
- early completion、named exit、未完成节点 fencing 和晚到结果审计。
- 跨进程恢复、预算归集、权限收敛，以及运行中心的跨 Feature 观测与图形化操作。

这些都是通用编排能力，不属于 research 或其他领域。core 只理解 graph、scope、node、edge、port、capability、policy 和执行状态；领域 recipe 负责业务节点、artifact schema、evaluator 和 graph planning。

## 设计目标

- 外层 Workflow Instance 保留为可循环、可长期运行的状态机。
- 所有可执行 state activation 使用同一 Graph Runtime；顺序 authoring state 和 dynamic graph 不建立两套执行协议。
- 每次进入 State 都创建一个 State Activation；每个非 terminal activation 恰好对应一个 root Graph Run，terminal activation 在 T8 内完成且不创建 Run。
- 一个 Graph Run 可以追加 child scope，但任何已 materialize 的 Scope Plan 永不修改。
- 支持 `delegation | system | wait | join | subgraph | expand | map | terminal` 完整 node union。
- 分离 control routing、data readiness、node trigger 和 scope completion，避免用“全部前驱成功”承担所有语义。
- 让 runtime graph 在受信任 policy envelope 内选择结构和内部 completion policy，但不能扩大 capability、权限、预算或外层 transition。
- 让自然语言、Feature 页面、schedule 和 API 通过受约束 Recipe Catalog 创建精确 Workflow；Macro Router 只能在入口固定的 routing scope 内选择，不能遍历或自由拼装全局 Workflow Definition。
- 所有条件、路由、输入选择、completion cut、预算消费和 scope expansion 都可确定性重放与审计。
- 物理执行采用 at-least-once，状态效果通过 CAS、幂等键、lease、event log 和 outbox 达到 exactly-once。
- 运行中心统一承载 Workflow、独立 Agent 执行、待处理事项和全局 Trace；Workflow 详情能展示并按策略操作 scope tree、DAG、attempt、wait、edge resolution、budget 和 completion cut。
- Trace 不以 Workflow 为前提；独立对话、Feature Command、Automation 与 System Task 的执行 Trace 可以没有任何 Workflow 标识，已关联 Workflow 的 Trace 则可从 Run/Node/Attempt 双向跳转。

## 非目标与硬边界

- 不把外层长期状态机强制编译成一个无限 graph；循环发生在 state activation 之间。
- 不允许修改已存在的 Scope Plan，也不允许给已创建节点追加前驱。动态能力只能追加 child scope。
- 不允许跨 scope edge；parent/child 只能通过 owner node 的显式 typed ports 通信。
- 不允许 graph spec 注册 capability、role、skill、action、tool、mount、credential 或权限。
- 不允许条件表达式执行任意代码、调用模型或工具、读取时钟/随机数/live workflow context。
- 不允许 detached branch 在 root workflow 已完成后继续运行。真正的后台任务必须创建 child workflow。
- 不把业务 dedupe、scoring、merge、研究判断或报告生成隐藏在 join/compiler/runtime 内。
- 不把 Macro Router 做成可以任意选择全局 Definition、Policy、Schema 或执行权限的超级 Agent；Router 只提出 routing scope 内的 RecipeRef，确定性 resolver 才能创建 Workflow。
- 不保证 agent/action 物理执行 exactly-once；有副作用的 capability 必须提供幂等或 compensation 合同。

## 核心对象模型

```text
Task Intake / Routing Request          原始任务、入口约束与路由审计
  -> Immutable Recipe Descriptor       Definition/Entrypoint/Policy/Schema 的可信绑定
    -> Workflow Creation Request       幂等创建与 domain resource claim
Workflow Instance                     外层状态机，可循环和长期运行
  -> State Activation                 某次进入 state 的实例
    -> Graph Run                      非 terminal activation 的唯一 root run
      -> Graph Scope Instance         root / subgraph / expansion / map_item
        -> Immutable Scope Plan       scope 内有限 DAG，不可修改
        -> Graph Node
          -> Graph Node Attempt       delegation/system 的执行历史
          -> Durable Wait             signal/timer/approval 的等待资源
        -> Control Edge Resolution    路由事实
        -> Data Edge Resolution       值可用性事实
        -> Terminal Candidate         named exit 候选
        -> Close Request              candidate 选择与 fence
        -> Completion Cut             scope 的最终完成切面
      -> Append-only Run Manifest     scope/expansion 审计链
      -> Resource Ledger              run 级资源预留与消费
```

`Graph Scope` 是完整架构的不可变边界：

- Root scope 来自 workflow definition、static authoring sugar、template 或 runtime graph source。
- `subgraph` 使用预编译 template/inline plan 创建 child scope。
- `expand` 消费已冻结的 candidate scope spec，经过相同 compiler 创建 child scope。
- `map` 对冻结 collection 的每个 item 创建一个 child scope。
- Child scope 正常结束后把 named exit envelope 发布给 owner node；只有 root completion coordinator 能推进外层 workflow。

## 核心不变量

1. 每次进入 Workflow State 都创建唯一 State Activation。每个非 terminal activation 恰好对应一个 root Graph Run；terminal activation 不创建 Graph Run，并在 T8 中与 Workflow final outcome 原子提交。一个 run 在任一 committed state 对应一棵有限 scope ownership tree；`max_nesting_depth` 非 null 时额外执行业务深度限制，null 时不注入默认业务深度，但部署级 finite safety depth 始终适用。
2. Scope Plan 创建后不可变；扩图只能 append child scope，不能修改 parent 或 sibling plan。
3. Edge 两端必须属于同一 scope。Child 只能读取 owner node 冻结的输入，不能读取 parent 后续结果。
4. 每个 scope 内 control、data 和 guard readiness dependency 的并集必须无环。
5. Node trigger、input seal、route resolution 和 scope completion 是四套独立协议。
6. Node terminal outcome、edge resolution、published output、close request 和 completion cut 一旦提交就不可变。
7. 每个 child scope 具有唯一 `(parent_scope_id, owner_node_id, child_key)`，恢复不能重复创建。
8. 所有被激活 node 的 sealed input snapshot 记录 selected edge、value ref/hash、resolution seq 和 schema hash；因 trigger/input impossible 被 skip 的 node 保存对应 decision snapshot。Late data 不能修改任何已冻结 snapshot。
9. Normal named exit、engine error 和 cancellation 是不同结果，不能混用一个 `failure` 字段。
10. Root completion coordinator 是唯一允许提交 typed Context Patch、final output binding 和推进外层 transition 的执行单元。
11. 创建 child scope、map item、attempt 或 wait 前必须先在事务型 ledger 中预留额度。
12. Child policy 只能逐层收紧，effective policy 是 global/workflow/state/parent/factory request 的交集。
13. 所有 registry、definition、interface、policy、template 和 capability 引用均固定 version/hash；恢复不读取 latest。
14. Parallel execution 是同一 scope 内多个 ready node 被并发 claim 的原生调度能力，不是 workflow state 或 graph node type；所有 DAG 只使用 `graph` 这一种持久化配置格式。
15. Macro Router 只能从 pinned `WorkflowRoutingScope.allowed_recipe_refs` 中选择一个 exact RecipeRef；Definition、entrypoint、execution policy、Context Contract、Command Policy、input/output schema 和 launch policy 必须由该 Recipe 不可变绑定，不能由 Router 分别自由组合。
16. 同一可信创建域内 `creation_key` 只能绑定一个 `creation_intent_hash`；相同 intent 重放返回原实例，不同 intent 必须 `idempotency_conflict`。
17. Workflow 级累计 activation、Graph Run、transition、duration、usage 与 direct child-workflow 数量由 versioned execution policy 跨全部 state activation 记账，不能通过进入新 State 重置预算。Terminal activation 计入 activation 但不计入 Graph Run；normal/errored terminal 通常满足 `state_activation_count = graph_run_count + 1`，global cancel/administrative abandon 可以相等。
18. Nullable Workflow policy 的 `null` 只表示“不声明业务 ceiling”，绝不关闭部署级 `RuntimeSafetyCeilings`；所有运行时生成的 source、graph、递归、map、fact 和 blob 都受显式、有限、可审计的 safety ceiling 约束。
19. 需要修改共享外部资源的 Workflow 必须在 T0 获得 exclusive durable claim；Capability 以 slot 绑定全部 required claims，所有 mutation 通过 gateway 检查 current fencing token、稳定 operation key、receipt 和 immutable after-snapshot。
20. Workflow Port Schema 使用受限 Profile；相同 hash 默认兼容，不同 hash 必须有 sound subtype proof，转换只能由显式 versioned adapter 完成。
21. `work_fence_epoch` 只拒绝普通工作；Cancel、Reconcile、Compensation 与 Finalizer 绑定 winning `close_request_id`，Ancestor close 不覆盖已有 descendant request。
22. Workflow 权威事实位于独立 `workflow-runtime.db`；运行中心只消费可重建 Projection，`messages.db` 等跨库同步只使用幂等 Outbox。
23. Value/Blob Store 第一版不做机密性与 Value 级权限隔离，但必须保证 Hash/Schema/长度/provenance、有限 retention/physical capacity，且 Credential 原文永不落盘。
24. 只有显式 Publish 产生 Feature/Core/Local Prompt 可执行版本；Authoring Source 和旧 Definition 字段不可执行。Run 固定 exact Protocol、ABI、Artifact、Prompt 与 Registry closure refs/hashes，任何升级都不能 silent fallback。
25. Outbox Delivery Policy 的 delivery/reconcile attempts、attempt timeout、总 duration 与 backoff 均为 finite versioned contract；unknown outcome 先 Reconcile，Dead Letter 后果由可信 Effect Contract 决定。
26. Early Completion 固定 first-eligibility-event 竞速语义，Settled Completion 在候选集合封闭后按 priority；需要高优先级覆盖时不得使用 Early。
27. Blob 在 DB 引用前完成 file fsync、no-replace install 与 directory fsync；GC、Backup 和新引用通过 Write Intent、状态机与 Pin 协调，Referenced Missing Blob 必须 quarantine。
28. 运行中心、Feature、API 与 Automation 共用 Runtime Command Gateway；Actor/Delegation、Permission/Policy/State Guard 与所有命令结果形成不可变审计。
29. 权威时间全部是 UTC Unix milliseconds `*_at_ms`；CAS 使用 `row_version`，Fencing 使用明确 epoch，状态与关键字段组合由 SQLite CHECK/Partial Index 执行。
30. Required compensation 的 `action_required/dead_letter/unknown` 均不算收敛；Scope 保持 closing、Run 保持 action-required并阻止 Child/Root Cut，只有成功 remediation 可继续，administrative abandon 不生成 Cut。
31. Runtime 只能加载与当前 deployment/runtime/platform/arch/release artifact、DDL schema hash、Core build、Node/SQLite binary/compile options/native module、minimum machine class、startup smoke 和 versioned SQLite Execution Profile 逐项匹配的 certified Supported Limits；Safety Ceiling 必须满足 Product Floor 与 root-fence 终止性交叉约束。
32. 本文持久化字段清单是 Normative Logical Schema，不是伪装成 SQL 的缩写 DDL；首个 Store patch 前必须产出并通过真实 SQLite 验证的完整 executable migration 与 Schema Manifest。
33. Trace 是独立于 Workflow Projection 的通用执行观测模型；Workflow correlation 可空，且任一非空的下级标识必须具有完整上级所属链。非 terminal execution 验证 `workflow -> activation -> run -> scope -> node -> attempt`；terminal activation 合法地在 activation 层结束，禁止为其或独立 Agent 对话伪造 Run/Scope/Node。
34. Direct Child Recipe allowlist 唯一归 Parent Recipe 所有，并与该 Recipe entrypoint 可达的 `start_child_workflow` exact refs 集合完全相等；Definition 不声明第二份 allowlist。Child Recipe dependency graph 第一版必须无环。
35. 全部 Child Workflow lineage 共享 root-workflow descendant account；direct child、lineage depth 与 descendant total 均受 finite safety ceiling，创建新 Child Workflow 不能重置家族树额度。
36. Published Definition 使用 closed-world `icarus.workflow-definition/1`；旧 `delegate.role/skill/task_template`、`before_delegate/after_complete`、`system.run.steps`、旧 retry/evaluator/artifact/context 字段和 transition delegate 直接拒绝，不提供兼容执行路径。
37. 每个 Workflow 都必须具有真实 `Task Intake -> Revision -> Routing Attempt -> Creation Request` provenance。Required Child 的 provenance 由 Root Finalization Coordinator 根据 close/effect 的可信事实确定性创建；T8 不得直接插入一个没有 `creation_request_id` 的 Child，也不得伪造 nullable intake 旁路。
38. Run/Workflow 的 `operational_state=action_required/quarantined` 由 open Operational Blocker 集合决定；Workflow business `status=active/completed/errored/cancelled` 不因 post-terminal cleanup blocker 被覆盖。恢复只能通过 T6e 关闭 blocker；只要仍有任一 open blocker，就不得把 operational state 设为 `healthy` 或恢复不符合 lifecycle/control 的普通 scheduler。
39. SQLite 内部权威对象之间不得用无法建立真实 FK 的通用 `kind/id` 表示所有权或目标。多类型关系使用每种目标独立 nullable 列、真实 FK 和 exactly-one CHECK；仅外部 Principal/Provider/Locator 可以使用明确命名的 opaque `*_ref`。
40. Production profile 必须匹配 `deployment_profile/runtime_surface/platform/arch/release_artifact/Node/SQLite/native module/Execution Profile` 完整认证键，并达到本文首发产品支持下限；低于下限不能以“认证值更小”为由静默上线。
41. Runtime 实施和 Production activation 都以机器生成的静态 absence baseline 与 `ProductSurfaceCoverageManifest` 为前提。任一已删除创建/控制/projection surface、旧 schema/resource key、绕过 Runtime Gateway 的直接 import 或候选资料可达路径重新出现时 fail-closed。
42. Golden Conformance Bundle 的 expected diagnostics/Plan bytes/hash 必须来自独立手工审阅并 sealed 的 oracle artifact；生产 Compiler 或 `--accept` 模式不得生成自己的 expected output。
43. 前置清理完成后，旧 Workflow 表/列/行、关联聊天、artifact/context、状态标签、旧代码、配置、Definition/Evaluator/Artifact Contract、测试 fixture、data directory 与兼容路径必须持续 absent；新 Runtime 不建立 archive/tombstone/compatibility reader，也不把任何旧业务资产或历史资料候选导入 Registry、Fixture、Build 或 Runtime。
44. Production Registry 可以没有任何 launchable Domain Recipe。Contract Pack、Compiler、Store、Runtime 与 certification 使用 test-only synthetic Recipe/Definition；它们只存在于隔离测试 root，不得发布到 Production Registry 或形成创建入口。
45. 没有 Published Recipe 时，通用 Intake 返回稳定 `no_route_available`，不得暴露全局 Definition/Capability 选择器；Runtime Center 在零 Recipe、零 Workflow、零 Run 时返回正常空 Projection。
46. 单 Agent 目标迭代不改变 DAG 或 Node input snapshot：每次真实重执行创建一个 immutable Attempt，non-initial Attempt 恰好引用同 Node 的相邻 parent，parent 最多一个后继。`needs_revision`、typed feedback、Schedule 和下一 Attempt reservation 原子提交；只有 pass 发布 logical output，Node/Run/Workflow 三层额度耗尽保持不同结果。

## 术语

| 术语                   | 含义                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Scope Interface        | Scope 的 typed input ports 与 named exits/output ports 合同                                       |
| Scope Spec             | 用户或 planner 产生的 source IR，必须经过 compiler                                                |
| Scope Plan             | 归一化并绑定 capability/policy 后的不可变 executable IR                                           |
| Scope Instance         | 某个 Scope Plan 在 Graph Run 内的一次执行实例                                                     |
| Owner Node             | 创建 child scope 并等待其结束的 `subgraph/expand/map` node                                        |
| Control Edge           | 根据 source terminal fact 和确定性条件解析为 taken/not-taken 的路由边                             |
| Data Edge              | 将 scope input、literal 或 node output 传给目标 input port 的值边                                 |
| Trigger                | 根据 control edge truth 决定 node 是否被激活的三值逻辑表达式                                      |
| Input Seal             | input port 已确定选值，或已确定无法满足的不可逆状态                                               |
| Terminal Candidate     | terminal node 为某个 named exit 提交的不可变候选输出                                              |
| Completion Policy      | 定义 scope 何时可以结束以及多个 candidate 中选择哪一个的确定性规则                                |
| Completion Coordinator | 执行 completion policy、创建 close request/fence/cut 的数据库协调逻辑                             |
| Close Request          | coordinator 选定 candidate、冻结 fact frontier 并 fencing 其余工作                                |
| Completion Cut         | closing 条件满足后提交的最终 scope output/outcome 切面                                            |
| Named Exit             | scope 正常业务出口，例如 `accepted`、`partial`、`manual_review`                                   |
| Compiler               | 对 Source IR 做 strict validation、normalize、binding 并生成 immutable plan 的纯确定性组件        |
| Quiescent              | 没有 ready/active/wait/retry/build 或未来可解析事实、但 scope 尚未结束的 fixed-point 状态         |
| Engine Error           | Schema、condition、capability、dead-end 等编排技术错误，不是业务 named exit                       |
| Versioned Registry     | 按精确 ref/hash 发布和解析 capability/schema/interface/template/policy/wait contract 的不可变目录 |
| Resource Ledger        | 对 scope/node/attempt/wait/output 等资源进行原子预留、消费和释放的账本                            |
| Task Intake            | 将原始自然语言、结构化字段、附件引用、调用来源和 principal 冻结为可审计任务输入                   |
| Recipe Descriptor      | 精确绑定 Definition、entrypoint、policy、schema、launch policy 与 resource claim 的版本化业务配方 |
| Routing Scope          | 某个可信入口允许 Macro Router 选择的 RecipeRef/child routing scope 集合                           |
| Macro Router           | 在受限 routing scope 内判断任务种类并提出 RecipeRef 的领域路由 capability                         |
| Deterministic Resolver | 不调用模型，校验 routing decision、权限、schema、版本、launch policy 和幂等键的创建协调器         |
| Micro Planner          | 在已选 Recipe/Graph State 的 capability allowlist 内生成本次 Scope Spec 的普通 delegation capability |
| Creation Key           | 调用方在可信创建域内提供的稳定幂等键，例如 workspace + 周次                                     |
| Domain Resource Claim  | 跨 Workflow 保护外部 workspace/package/prompt target 的 durable shared/exclusive claim           |
| RuntimeSafetyCeilings  | 部署级显式有限安全上限；不能被 Recipe、Definition、Planner 或 child policy 放宽                   |
| Runtime Center（运行中心） | 顶层控制/观测入口，承载 Workflow、独立 Agent 执行、待处理和 Trace；不继承任何已删除后台的 API、schema 或 projection |
| Trace Correlation      | Trace 到 Workflow lineage、Feature、Conversation、Message 或 Agent Execution 的可选可验证关联    |

## Task Intake、Recipe Catalog 与 Macro Routing

Graph Runtime 是执行面，不负责从任意自然语言中自由寻找 Workflow。Workflow 创建前增加受信任的 Task Intake 与 Recipe Routing 创建面；它们可以由通用入口调用，也可以由 Feature 页面、schedule 或另一个 Workflow 的 trusted transition effect 直接提供精确 RecipeRef。

```text
Raw Task / Feature Command / Schedule
  -> Task Intake snapshot
  -> pinned Routing Scope
  -> Macro Router（显式 task_kind 优先，模型只作受限 fallback）
  -> Deterministic Resolver
  -> exact Recipe Descriptor
  -> idempotent Workflow Creation
  -> Workflow Instance
      -> Definition 固定外层 State/transition
      -> Micro Planner 只为指定 graph state 生成 Scope Spec
      -> Graph Compiler / Runtime
```

Macro Router 可以逻辑上分为 Domain Router 与 Recipe Router，但每一跳仍使用 pinned routing scope：全局入口先选择 `market_research | product_design | pm_pipeline` 等 child scope；Feature 入口通常直接固定领域 scope，只在本领域 Recipe 中选择。显式页面按钮、schedule 或 API 已提供 exact RecipeRef 时不调用模型，仍必须写一条 deterministic routing decision 以统一审计。

```ts
type WorkflowLaunchPolicy = 'auto' | 'confirm' | 'manual_only';

interface WorkflowTaskEnvelope {
  format: 'icarus.workflow-task/1';
  request_id: string;
  creation_key: string;
  source:
    | 'global_assistant'
    | 'feature_ui'
    | 'schedule'
    | 'api'
    | 'workflow_transition';
  principal_ref: string;
  routing_scope_ref: VersionedRef;
  raw_request?: string;
  explicit_task_kind?: string;
  explicit_recipe_ref?: VersionedRef;
  structured_input: JsonValue;
  attachment_refs: string[];
  locale?: string;
}

interface WorkflowRecipeResourceClaimSpec {
  id: string;
  namespace: string;
  mode: 'shared' | 'exclusive';
  key_json_pointers: string[];
  hold_until: 'workflow_terminal';
}

type EffectRecoveryKind = 'pure' | 'idempotent' | 'compensatable';
type EffectImpact = 'read_only' | 'mutable_effects' | 'irreversible';

// Impact order: read_only < mutable_effects < irreversible.

interface DerivedWorkflowEffectSummary {
  max_impact: EffectImpact;
  recovery_kinds: EffectRecoveryKind[];
  permission_refs: string[];
  dependency_closure_hash: string;
}

interface WorkflowRecipeDescriptor {
  ref: VersionedRef;
  owner_feature_id: string | null;
  recipe_family: string;
  task_kinds: string[];
  workflow_definition_ref: VersionedRef;
  entry_point: string;
  workflow_execution_policy_ref: VersionedRef;
  context_contract_ref: VersionedRef;
  workflow_command_policy_ref: VersionedRef;
  input_schema_ref: VersionedRef;
  output_schema_ref: VersionedRef;
  launch_policy: WorkflowLaunchPolicy;
  effect_ceiling: EffectImpact;
  derived_effect_summary: DerivedWorkflowEffectSummary;
  required_permissions: string[];
  allowed_child_recipe_refs: VersionedRef[];
  resource_claims: WorkflowRecipeResourceClaimSpec[];
  recipe_hash: string;
}

interface WorkflowPromptBinding {
  prompt_family_ref: VersionedRef;
  prompt_contract_ref: VersionedRef;
  base_prompt_ref: VersionedRef;
  selection_policy_ref: VersionedRef;
}

interface WorkflowRoutingCapability {
  ref: VersionedRef;
  executor_ref: VersionedRef;
  role_ref?: VersionedRef;
  skill_refs: VersionedRef[];
  prompt_binding: WorkflowPromptBinding;
  input_schema_ref: VersionedRef;
  output_schema_ref: VersionedRef;
  timeout_ms: number;
  max_attempts: number;
  required_tools: [];
  effect: { type: 'pure' };
  capability_hash: string;
}

interface WorkflowRoutingScope {
  ref: VersionedRef;
  owner_feature_id: string | null;
  allowed_recipe_refs: VersionedRef[];
  allowed_child_scope_refs: VersionedRef[];
  router_capability_ref: VersionedRef | null;
  clarification_contract_ref: VersionedRef | null;
  selection_policy: WorkflowRoutingSelectionPolicy;
  scope_hash: string;
}

interface WorkflowRoutingSelectionPolicy {
  allow_model_auto_select: boolean;
  min_auto_select_confidence_micros: number;
  on_low_confidence:
    | 'needs_clarification'
    | 'require_confirmation'
    | 'unsupported';
  require_complete_recipe_input: boolean;
}

interface WorkflowClarificationContract {
  ref: VersionedRef;
  fields: Record<
    string,
    {
      target_json_pointer: string;
      answer_schema_ref: VersionedRef;
      allow_clear: boolean;
      required_actor_scope: string;
      requires_reconfirmation: boolean;
    }
  >;
  contract_hash: string;
}

type WorkflowRoutingDecision =
  | {
      kind: 'recipe_selected';
      recipe_ref: VersionedRef;
      task_kind: string;
      confidence_micros: number;
      reason_codes: string[];
      missing_fields: string[];
    }
  | {
      kind: 'child_scope_selected';
      child_scope_ref: VersionedRef;
      task_kind: string;
      confidence_micros: number;
      reason_codes: string[];
    }
  | {
      kind: 'needs_clarification';
      reason_codes: string[];
      missing_fields: string[];
      question_contract_ref: VersionedRef;
    }
  | { kind: 'unsupported'; reason_codes: string[] };
```

`confidence_micros` 使用 `0..1_000_000` safe integer，避免 float canonicalization 差异。Router output 只是 candidate decision，不是创建授权；分数只根据 pinned `selection_policy` 决定自动选择、澄清或确认，不能绕过 scope、Schema、permission、launch policy 或 claim 校验。阈值和 calibration fixture 与 Router Capability version 一起发布，不比较不同 Router 版本的裸分数。Deterministic Resolver 必须依次校验：decision target 位于当前 scope、scope 链无环且未超过 safety hop limit、Recipe/Definition/Policy/Schema 均为 published exact ref、Feature 可启动新任务、principal permission、input schema、launch policy、resource claim 和 creation key。任何 raw input、Planner output 或 Router reason text 都不能增加候选集。

Macro Router 使用独立 `WorkflowRoutingCapability`，不是 Graph Node，也不能复用拥有 tool/file/effect 权限的业务 capability。它只能读取 frozen Task Envelope 与当前 Routing Scope 的候选 descriptor summaries，输出 strict decision schema；执行历史挂在 intake/routing attempt 上而不是伪造 graph attempt。Deterministic explicit route 的 scope 可以令 `router_capability_ref=null`。

`explicit_recipe_ref` 只在它属于 pinned routing scope 时生效；显式用户选择不得被模型改写。`launch_policy=confirm` 必须在持久化 confirmation 后创建，`manual_only` 只能由允许的 Feature command/API 或 trusted transition effect 启动。`needs_clarification` 保存在 durable intake record 中；回答必须引用 exact Clarification Contract 与 `expected_revision_no`，只修改合同允许的字段，并追加 immutable effective-input revision。Routing attempt 必须引用精确 revision/hash，不能覆盖旧输入或旧 decision，也不能使用 Router 生成的任意 JSON Patch。

Recipe 是一致性绑定单元。Router 不允许选择 Definition A、Policy B、Schema C 的自由组合；资源升级必须发布新 Recipe version。一个 Definition 可以被多个 Recipe 以不同 entrypoint 使用，多个 Recipe 也可以绑定不同 Definition。

Production Registry 允许没有任何 Published Recipe。此时 Feature 单候选入口不得出现，通用 Intake 在验证 envelope、principal 与 routing scope 后返回稳定结果 `no_route_available`，不创建 Workflow、Activation、Run 或 Claim，也不退化为全局 Definition/Capability 浏览器。Contract Pack、Compiler、Store 和 Runtime certification 使用的 synthetic Recipe/Definition 只能位于隔离的 test-only Registry/data root，并携带 `launchability='test_only'`；Publisher 与 Production loader 必须拒绝把该标记转换成 production launchability。Recipe 数量为零不影响 Core Runtime、Runtime Center、Trace、Feature Package Runtime 或独立 Agent/Scheduled Task 能力。

### Workflow 级执行 Policy 与 Runtime Safety

```ts
interface WorkflowExecutionPolicy {
  ref: VersionedRef;
  max_state_activations: number | null;
  max_graph_runs: number | null;
  max_state_transitions: number | null;
  max_child_workflows_per_workflow: number | null;
  max_child_workflow_depth: number | null;
  max_descendant_workflows_total: number | null;
  max_duration_ms: number | null;
  usage_budget: NullableWorkflowUsageBudget;
  policy_hash: string;
}

interface WorkflowRuntimeSafetyCeilings {
  routing: {
    max_task_input_bytes: number;
    max_route_hops: number;
    max_schema_bytes: number;
    max_schema_nodes: number;
    max_schema_ref_depth: number;
    max_schema_union_variants: number;
    max_schema_validation_steps: number;
  };
  workflow: {
    max_duration_ms: number;
    max_state_activations: number;
    max_graph_runs: number;
    max_state_transitions: number;
    max_child_workflows_per_workflow: number;
    max_child_workflow_depth: number;
    max_descendant_workflows_total: number;
    max_required_child_creations_per_transition: number;
  };
  run: {
    max_scopes_total: number;
    max_nodes_total: number;
    max_edges_total: number;
    max_map_items_total: number;
    max_attempts_total: number;
    max_waits_total: number;
    max_builds_total: number;
    max_build_attempts_total: number;
    max_evaluator_attempts_total: number;
    max_effect_operations_total: number;
    max_logical_output_bytes_total: number;
    max_stored_bytes_total: number;
    max_facts_total: number;
  };
  scope: {
    max_nodes_per_scope: number;
    max_edges_per_scope: number;
    max_scope_spec_bytes: number;
    max_nesting_depth: number;
    max_frontier_bytes: number;
  };
  map: {
    max_items_per_map: number;
    max_child_concurrency_per_map: number;
  };
  registry: {
    max_snapshot_entries: number;
    max_dependency_depth: number;
    max_execution_artifact_bytes: number;
    max_total_pinned_execution_bytes_per_run: number;
  };
  execution: {
    max_attempts_per_node: number;
    max_attempt_duration_ms: number;
    max_dispatch_duration_ms: number;
    max_retry_backoff_ms: number;
    max_build_attempts_per_build: number;
    max_build_duration_ms: number;
    max_evaluator_attempts_per_evaluation: number;
    max_evaluator_duration_ms: number;
    max_outbox_attempts_per_message: number;
    max_outbox_reconcile_attempts_per_message: number;
    max_outbox_attempt_duration_ms: number;
    max_outbox_delivery_duration_ms: number;
    max_root_finalization_attempts_per_schedule: number;
    max_root_finalization_duration_ms: number;
    max_operational_remediation_attempts_per_blocker: number;
    max_operational_remediation_duration_ms: number;
  };
  wait: {
    max_finite_wait_duration_ms: number;
    max_pending_signals_per_workflow: number;
    max_pending_signals_per_run: number;
    max_pending_signals_per_principal: number;
    max_pending_signal_age_ms: number;
    max_signal_payload_bytes: number;
    max_correlation_key_bytes: number;
  };
  reconciliation: {
    max_condition_ast_nodes: number;
    max_condition_steps_per_evaluation: number;
    max_facts_per_transaction: number;
  };
  value: {
    max_single_value_bytes: number;
    max_single_artifact_bytes: number;
    max_artifact_files: number;
    max_artifact_manifest_bytes: number;
  };
}

interface DeploymentRuntimeCapacity {
  max_active_executions: number;
  max_active_waits: number;
  max_pending_signals: number;
  max_outbox_inflight: number;
  max_physical_blob_bytes: number;
  soft_blob_high_water_bytes: number;
  minimum_free_disk_bytes: number;
  config_hash: string;
}

interface SQLiteExecutionProfile {
  ref: VersionedRef;
  deployment_profile: 'local_single_user';
  runtime_surface: 'node_service';
  platform: 'darwin';
  arch: 'arm64';
  journal_mode: 'wal';
  synchronous: 'full';
  foreign_keys: true;
  busy_timeout_ms: number;
  page_size: number;
  auto_vacuum: 'none' | 'incremental' | 'full';
  temp_store: 'file' | 'memory';
  wal_autocheckpoint_pages: number;
  journal_size_limit_bytes: number;
  cache_size_kib: number;
  mmap_size_bytes: number;
  trusted_schema: false;
  recursive_triggers: false;
  read_uncommitted: false;
  locking_mode: 'normal';
  read_only_query_only: true;
  sqlite_version: string;
  sqlite_source_id: string;
  sqlite_compile_options_hash: string;
  better_sqlite3_version: string;
  better_sqlite3_native_module_hash: string;
  node_runtime_version: string;
  node_executable_hash: string;
  release_artifact_hash: string;
  profile_hash: string;
}

interface RuntimeSupportedLimits {
  ref: VersionedRef;
  max_scopes_total: number;
  max_nodes_total: number;
  max_edges_total: number;
  max_attempts_total: number;
  max_waits_total: number;
  max_builds_total: number;
  max_effect_operations_total: number;
  max_facts_per_transaction: number;
  max_frontier_bytes: number;
  max_subtree_scopes_per_fence: number;
  max_subtree_nodes_per_fence: number;
  max_subtree_edges_per_fence: number;
  max_subtree_attempts_per_fence: number;
  max_subtree_waits_per_fence: number;
  max_subtree_builds_per_fence: number;
  max_subtree_map_slots_per_fence: number;
  max_subtree_effects_per_fence: number;
  max_t7_derived_facts_per_fence: number;
  max_subtree_fence_manifest_bytes: number;
  max_map_items_total: number;
  max_required_child_creations_per_t8: number;
  certification: {
    status: 'certified';
    deployment_profile: 'local_single_user';
    runtime_surface: 'node_service';
    platform: 'darwin';
    arch: 'arm64';
    release_artifact_hash: string;
    database_schema_hash: string;
    core_build_hash: string;
    sqlite_execution_profile_ref: VersionedRef;
    sqlite_execution_profile_hash: string;
    benchmark_harness_version: string;
    benchmark_harness_hash: string;
    limit_derivation_hash: string;
    reference_machine: string;
    minimum_machine_class_ref: VersionedRef;
    minimum_machine_class_hash: string;
    startup_smoke_harness_hash: string;
    startup_smoke_max_duration_ms: number;
    filesystem_type: 'apfs';
    storage_class: 'internal_ssd';
    t3_max_transaction_duration_ms: number;
    t7_max_transaction_duration_ms: number;
    t8_max_transaction_duration_ms: number;
    certified_at_ms: number;
  };
  profile_hash: string;
}
```

Production v1 固定发布 `local_single_user_safety@1`。下列值是首个目标 Safety Profile，不因机器空闲、业务配置或运行中 reload 改变；G8 只有在 certified Supported Limits 达到或超过这些值后才能激活 Production：

| Group | Exact ceilings |
| --- | --- |
| `routing` | `max_task_input_bytes=1048576`、`max_route_hops=8`、`max_schema_bytes=262144`、`max_schema_nodes=4096`、`max_schema_ref_depth=32`、`max_schema_union_variants=64`、`max_schema_validation_steps=100000` |
| `workflow` | `max_duration_ms=2592000000`、`max_state_activations=128`、`max_graph_runs=127`、`max_state_transitions=127`、`max_child_workflows_per_workflow=32`、`max_child_workflow_depth=4`、`max_descendant_workflows_total=128`、`max_required_child_creations_per_transition=8` |
| `run` object counts | `max_scopes_total=128`、`max_nodes_total=1024`、`max_edges_total=4096`、`max_map_items_total=256`、`max_attempts_total=4096`、`max_waits_total=512`、`max_builds_total=512`、`max_build_attempts_total=1536`、`max_evaluator_attempts_total=8192`、`max_effect_operations_total=2048` |
| `run` bytes/facts | `max_logical_output_bytes_total=1073741824`、`max_stored_bytes_total=2147483648`、`max_facts_total=262144` |
| `scope` | `max_nodes_per_scope=128`、`max_edges_per_scope=512`、`max_scope_spec_bytes=2097152`、`max_nesting_depth=8`、`max_frontier_bytes=16777216` |
| `map` | `max_items_per_map=128`、`max_child_concurrency_per_map=16` |
| `registry` | `max_snapshot_entries=4096`、`max_dependency_depth=32`、`max_execution_artifact_bytes=268435456`、`max_total_pinned_execution_bytes_per_run=1073741824` |
| `execution` attempt/retry | `max_attempts_per_node=4`、`max_attempt_duration_ms=1800000`、`max_dispatch_duration_ms=120000`、`max_retry_backoff_ms=3600000` |
| `execution` build/evaluator | `max_build_attempts_per_build=3`、`max_build_duration_ms=600000`、`max_evaluator_attempts_per_evaluation=3`、`max_evaluator_duration_ms=600000` |
| `execution` outbox | `max_outbox_attempts_per_message=32`、`max_outbox_reconcile_attempts_per_message=16`、`max_outbox_attempt_duration_ms=300000`、`max_outbox_delivery_duration_ms=259200000` |
| `execution` finalization/remediation | `max_root_finalization_attempts_per_schedule=8`、`max_root_finalization_duration_ms=900000`、`max_operational_remediation_attempts_per_blocker=16`、`max_operational_remediation_duration_ms=259200000` |
| `wait` | `max_finite_wait_duration_ms=2592000000`、`max_pending_signals_per_workflow=256`、`max_pending_signals_per_run=128`、`max_pending_signals_per_principal=1024`、`max_pending_signal_age_ms=604800000`、`max_signal_payload_bytes=1048576`、`max_correlation_key_bytes=512` |
| `reconciliation` | `max_condition_ast_nodes=256`、`max_condition_steps_per_evaluation=4096`、`max_facts_per_transaction=16384` |
| `value` | `max_single_value_bytes=16777216`、`max_single_artifact_bytes=268435456`、`max_artifact_files=4096`、`max_artifact_manifest_bytes=4194304` |

`local_single_user_safety@1` immutable；调整任何字段必须发布新 version/hash。已有 Workflow/Run 始终使用创建时 pinned Safety，不因 reload 收紧或放宽。新 Safety 调低只影响新创建对象；调高必须先证明不超过当前完整 certification key 的 Supported Limits，否则 Production loader 拒绝。Test-only bootstrap 可以发布更小的独立 profile，但不得复用 production ref/status。

配置载体固定分离：immutable Safety 位于 `src/workflow-runtime/contracts/safety/local_single_user_safety@1.json`，可热更新 Capacity 位于 `config/workflow-runtime-capacity.json`，immutable SQLite Profile 位于 `src/workflow-runtime/contracts/sqlite/local_single_user_sqlite@1.json`。三者都先 strict parse/closed-schema/hash 再使用；Capacity watcher 只能原子发布完整 validated snapshot，Safety/SQLite 文件变更必须走 Publish/version gate而不是文件监听。

Safety ceilings 是 pinned、确定性的命名配置，不是隐藏默认值；启动时必须提供全部有限正整数并记录 config hash。字段名称必须显式表达 `total/per_*` 作用域。Effective enforcement 取 safety ceiling 与所有 non-null global/Recipe/Definition/State/child business limit 的最小值；业务 `null` 表示不进一步收紧，`0` 表示禁止消费。Plan、Run、routing decision 和运行中心必须同时展示 business policy snapshot 与 safety snapshot/hash。Effective Workflow policy 还必须满足 `max_graph_runs <= max_state_activations - 1`，为最终 terminal activation 保留一个确定额度；不满足时在 Policy Publish/T0 拒绝。Global cancel 或 administrative abandon 未使用该额度是合法的。

`DeploymentRuntimeCapacity` 是可热更新的物理容量，不进入 Plan 语义；不足时产生 backpressure，ready work 保持 ready，不得转成 engine error。Production v1 baseline 固定为 `max_active_executions=5`、`max_active_waits=256`、`max_pending_signals=2048`、`max_outbox_inflight=16`、`max_physical_blob_bytes=21474836480`（20 GiB）、`soft_blob_high_water_bytes=17179869184`（16 GiB）、`minimum_free_disk_bytes=5368709120`（5 GiB）。每次 admission 记录当时 capacity config hash；reload 必须原子替换完整配置，不能逐字段暴露中间值。

Capacity 调低不会 cancel 已 admission 的工作；只停止新 admission，直到使用量回到新值以下。Blob hard limit 调低到当前 allocation 以下时进入可观测 `over_capacity`，阻止新 allocation并触发 GC，不删除仍被引用的数据；`minimum_free_disk_bytes` 只能调高，达到新阈值后立即阻止新 allocation。Capacity 改变不创建新 Safety version，也不能用于放宽 pinned quota。

`RuntimeSupportedLimits` 不是手写默认值；它必须由相同 deployment/runtime/platform/arch/release artifact、DDL/schema hash、Core build、SQLite binary/compile options、完整 `SQLiteExecutionProfile` 和参考机器上的发布 benchmark 生成并以 `status=certified` 发布。Production v1 唯一首发认证目标是 `local_single_user + node_service + darwin/arm64`；Electron Renderer/Main、测试 Node、Rosetta/x64 或其他系统不得复用该认证。Electron 只通过 Runtime API/Command Gateway 访问，不得打开 Runtime DB。缺少 certified profile、profile 与当前完整认证键不匹配，或配置超过认证值时生产 Runtime 启动失败。

启动时先验证 certified profile 达到 `local_single_user_product_floor@1`，再做同名字段比较与下列终止性不等式；它们保证任意被配置允许并成功 materialize 的 Run 都能由一次不可拆 T7 root fence 收敛，不能出现“能创建、不能取消”的合法状态：

```text
safety.run.max_scopes_total            <= supported.max_subtree_scopes_per_fence
safety.run.max_nodes_total             <= supported.max_subtree_nodes_per_fence
safety.run.max_edges_total             <= supported.max_subtree_edges_per_fence
safety.run.max_attempts_total          <= supported.max_subtree_attempts_per_fence
safety.run.max_waits_total             <= supported.max_subtree_waits_per_fence
safety.run.max_builds_total            <= supported.max_subtree_builds_per_fence
safety.run.max_map_items_total         <= supported.max_subtree_map_slots_per_fence
safety.run.max_effect_operations_total <= supported.max_subtree_effects_per_fence
deriveWorstCaseT7Facts(safety)          <= supported.max_t7_derived_facts_per_fence
deriveWorstCaseT7ManifestBytes(safety)  <= supported.max_subtree_fence_manifest_bytes
safety.reconciliation.max_facts_per_transaction
                                          <= supported.max_facts_per_transaction
safety.scope.max_frontier_bytes        <= supported.max_frontier_bytes
safety.workflow.max_required_child_creations_per_transition
                                          <= supported.max_required_child_creations_per_t8
```

同名总量还分别要求 `safety.run.max_scopes_total/max_nodes_total/max_edges_total/max_attempts_total/max_waits_total/max_builds_total/max_effect_operations_total/max_map_items_total` 不超过 Supported 对应字段；`safety.scope.max_nodes_per_scope/max_edges_per_scope` 也不得超过 Supported 的 node/edge 总量。`deriveWorstCaseT7Facts/ManifestBytes` 是 Run Protocol versioned pure function，保守覆盖 scopes/nodes/edges/attempts/waits/builds/map slots/effects、close requests、eligibilities、events、固定 ID/hash 编码和 canonical manifest overhead；函数版本/hash 进入 certification/profile hash，不能由部署配置改写。Compiler 对每个 Plan 计算保守的 `max_reconcile_facts_per_ingress`、最大 source fan-out 和最大 frontier bytes；超过 Safety 或 Supported profile 时在 materialize 前拒绝。T2b、Map Manifest seal、retry/wait/effect 创建必须先在同一事务预留导致未来 root fence 所需的累计对象额度，再插入对象；不得等 T3/T7 已开始后以“事务太大”为业务错误中断。若 benchmark 无法覆盖某个高于 Product Floor 的可选合法形状，可以降低该可选 certified 上限；若 floor shape 也无法覆盖则 Production Gate 保持关闭并修改协议，不能依靠运行时猜测分批 fence。

每个 Safety 字段必须进入规范 Enforcement Matrix，记录作用域、Account、执行组件、检查时点、reserve/consume/release、失败结果、错误码与是否进入 Plan hash。Published Safety Profile 必须把下列分组展开为每个具体字段的一对一记录；存在未映射字段、重复 owner 或缺少检查时点时发布失败：

```ts
interface WorkflowSafetyEnforcementRecord {
  limit_path: string;
  business_limit_path: string | null;
  resource_type: string | null;
  account_scope: string | null;
  consumer_kind: string | null;
  enforcement_component: string;
  reservation_point: string | null;
  settlement_mode: 'consume_on_create' | 'hold_then_release' | 'incremental' | null;
  failure_code: string;
  failure_outcome: string;
  included_in_plan_hash: boolean;
  supported_limit_path: string | null;
  t7_fence_dimension: string | null;
  record_hash: string;
}
```

下表只是阅读分组；可发布的 Enforcement Matrix 必须逐字段保存 `WorkflowSafetyEnforcementRecord`，不能把 `run.*`、`execution.*` 等通配行当成最终记录。Direct validator/watchdog limit 可以令 `resource_type/account_scope=null`，但仍必须有唯一 owner、检查点和失败结果。

| Limit | Owner/对象 | Enforcement | 达限结果 |
| --- | --- | --- | --- |
| `routing.*` | intake/routing/schema object | T0 ingress、registry publish、router step | request/registry 拒绝，独立 `routing_*_limit_exceeded` |
| `workflow.*` | workflow lifetime account/watchdog | T0/T1/T8 reserve/commit、deadline watchdog | creation/transition 拒绝或 global cancel |
| `workflow.max_required_child_creations_per_transition` | trusted transition/root finalizer | Definition Publish、Schedule create、T8 preflight | Definition 拒绝或 Root action-required；不得部分创建 |
| `run.max_scopes/nodes/edges/map_items/builds/build_attempts/attempts/waits/evaluator_attempts/effects/facts_*` | run cumulative account | T2/T3/T4/T6 创建前 reserve/commit | root engine error 或 child owner/node failure；不得部分创建 |
| `run.max_logical_output_bytes_total/max_stored_bytes_total` | run byte account | Value intent/publish 前 reserve，commit 后结算 | output/value contract failure |
| `scope.max_nodes/edges/spec_bytes/nesting_depth/frontier_bytes` | scope/plan | compiler + T2b/T7 preflight | compile/materialize 拒绝 |
| `map.max_items_per_map/max_child_concurrency_per_map` | map node account/controller | seal manifest、scheduler admission | `map_item_limit_exceeded` 或 backpressure |
| `registry.*` | registry closure/artifact | publish + Run snapshot creation | 拒绝发布或创建过宽/过大 closure |
| `execution.max_attempts/build_attempts/evaluator_attempts_*` | node/build/evaluation account | attempt/schedule 创建前 commit | 不再 retry 或 node/build failure |
| `execution.*_duration_ms/max_retry_backoff_ms` | attempt/build/evaluator/outbox deadline | freeze deadline/backoff + watchdog | timeout/failure/dead-letter/action-required |
| `execution.max_root_finalization_*` | Root Finalization Schedule | Policy Publish、Schedule create/attempt watchdog | Policy 拒绝或 schedule exhausted/action-required |
| `execution.max_operational_remediation_*` | Operational Blocker | Command Policy Publish、blocker create、T6e attempt watchdog | Policy 拒绝；blocker 保持 open，耗尽后只允许 receipt/result verification |
| `wait.max_finite_wait_duration_ms` | wait | compiler + arm transaction | compile/arm 拒绝 |
| `wait.max_pending_signals_per_*` | deployment/workflow/run/principal-provider account | inbox ingress reserve、resolve/expire release | ingress rate/limit rejection |
| `wait.max_pending_signal_age/payload/correlation_*` | inbox/wait | ingress + sweeper + arm | `unmatched_expired` 或 payload/correlation rejection |
| `reconciliation.max_condition_ast_nodes/max_condition_steps_per_evaluation` | compiled condition/evaluation | compiler + T3 evaluator | compile rejection 或 condition error |
| `reconciliation.max_facts_per_transaction` | T3 fact wave | compiler conservative proof + T3 preflight | materialize rejection；T3 不允许中途截断 |
| `value.max_single_value/artifact/files/manifest_*` | Value/Artifact intent | snapshot/publish 前 validate + reserve | value/artifact contract failure |
| `DeploymentRuntimeCapacity.max_active_executions` | deployment capacity | scheduler admission | 保持 ready/backpressure |
| `DeploymentRuntimeCapacity.max_active_waits/max_pending_signals/max_outbox_inflight` | deployment live slot | arm/ingress/outbox claim | 保持 pending/backpressure |
| `DeploymentRuntimeCapacity.max_physical_blob_bytes` | blob allocation | blob reservation/GC | backpressure/action-required |
| `DeploymentRuntimeCapacity.soft_blob_high_water_bytes/minimum_free_disk_bytes` | Blob Store Coordinator | allocation preflight/GC | 触发 GC、限流或拒绝新 allocation |

累计 Quota、单对象上限与时间上限产生结构化 terminal/error；可释放 Capacity 只控制 admission。Logical output bytes 在业务值首次发布时计费，Data Edge、Context Slot 或 Child expose 复用同一 ref 不重复计费；Run stored bytes 计本 Run 的逻辑持久对象；physical blob bytes 只在创建新内容文件时分配并在 GC 删除后释放。内容去重不能帮助 Workflow 绕过 logical quota。

## State 与 Graph 的统一

Workflow definition 保留 authoring-friendly state 类型，但 compiler 全部 lower 到 Graph Runtime：

```ts
type WorkflowDefinitionState =
  | WorkflowDefinitionDelegationState
  | WorkflowDefinitionSystemState
  | WorkflowDefinitionInterruptState
  | WorkflowDefinitionGraphState
  | WorkflowDefinitionTerminalState;
```

| State authoring type | Lowering                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `delegation`         | 单 delegation node + success/failure terminal 的 root scope           |
| `system`             | 单 system node + success/failure terminal 的 root scope               |
| `interrupt`          | 单 wait node + action/expire/wait-cancel routes + terminal root scope |
| `graph`              | 从 frozen source 编译完整 root Scope Plan                             |
| `terminal`           | T8 创建并立即完成 terminal activation，不创建 Graph Run               |

这样顺序型 Dynamic Workflow 仍易于书写，但 delegation completion、retry、wait、checkpoint、cancel 和 trace 不再有 graph/sequential 双轨逻辑。Terminal 是唯一不创建 Graph Run 的 State：它仍有独立、可审计的 State Activation，但在 T8 内与 Workflow final outcome 同事务完成，不进入 Scheduler。

State 是受信任的宏观业务阶段，Graph Node 是某次非 terminal State Activation 内更细的执行单元。Workflow Definition 固定 State/transition topology，不一定是线性顺序；只有 `graph` state 的 source 可以由 Micro Planner 动态生成多节点 DAG。普通 `delegation/system/interrupt` state 也由 lowerer 转成最小固定 Graph，但 Planner 不参与；interrupt lower 为 wait node 加 action/expire/cancel terminal nodes，Run 保持 `control=running` 且 Wait 不占 execution slot。常见动态模式是 `*_graph_plan` delegation state 先发布通过 compiler dry-run evaluator 的 Scope Spec，下一 `*_graph_execute` graph state 在 T1/T2 冻结并正式编译同一 source hash；不再增加独立 `*_graph_compile` system state。

单 Agent 围绕同一 frozen input 反复执行、依据质量反馈改进直到通过或耗尽，属于 delegation/system Node 内的 **quality revision loop**：一个 Node 表示一个逻辑目标，每轮真实 Agent/Action 执行创建一个 immutable Attempt。它不增加 `loop` State、`loop` Node 或循环 edge，也不修改已编译 DAG；外层 State 自循环仍只用于需要新 Activation/Run、Context Patch 或 transition effect 的业务返工。需要每轮重复完整多节点 body 的能力不在 v1 单 Node revision 合同内，未来若引入必须建模为受 finite controller/child-scope budget 约束的新 Node 协议，不能把 cycle 放进 scope dependency graph。

受信任 graph state 合同：

```ts
interface VersionedRef {
  id: string;
  version: string;
}

interface WorkflowDefinitionEntryPoint {
  state_key: string;
}

interface WorkflowDefinitionStateBase {
  type: 'delegation' | 'system' | 'interrupt' | 'graph' | 'terminal';
  label?: string;
  description?: string;
}

interface WorkflowDefinition {
  format: 'icarus.workflow-definition/1';
  ref: VersionedRef;
  owner_feature_id: string | null;
  name: string;
  context_contract_ref: VersionedRef;
  entry_points: Record<string, WorkflowDefinitionEntryPoint>;
  states: Record<string, WorkflowDefinitionState>;
  definition_hash: string;
}

interface WorkflowCommandPolicy {
  ref: VersionedRef;
  allow_pause: boolean;
  allow_resume: boolean;
  allowed_cancel_scopes: Array<'local_graph' | 'workflow'>;
  allow_manual_skip: boolean;
  allow_retry_wait_advance: boolean;
  receipt_remediation_contract_ref: VersionedRef | null;
  operational_remediation_policy_ref: VersionedRef;
  administrative_abandon: {
    allowed: boolean;
    require_second_confirmation: true;
    claim_disposition: 'retain' | 'release_with_verified_fence';
  };
  policy_hash: string;
}

interface WorkflowOperationalRemediationPolicy {
  ref: VersionedRef;
  max_attempts: number;
  max_duration_ms: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  allowed_blocker_kinds: Array<
    | 'effect_unknown'
    | 'compensation_dead_letter'
    | 'root_finalization_exhausted'
    | 'claim_release_failed'
    | 'resource_or_credential_unavailable'
    | 'integrity_quarantine'
  >;
  policy_hash: string;
}

interface WorkflowDefinitionNotify {
  contract_ref: VersionedRef;
  input_bindings: Record<string, WorkflowValueBinding>;
}

interface WorkflowRootFinalizationPolicy {
  ref: VersionedRef;
  max_attempts: number;
  max_duration_ms: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  policy_hash: string;
}

interface WorkflowDefinitionCardRef {
  ref: VersionedRef;
}

type CardActionBinding =
  | {
      action_kind: 'wait_signal';
      wait_contract_ref: VersionedRef;
      action_value: string;
      correlation_variable: string;
    }
  | {
      action_kind: 'business_command';
      business_command_contract_ref: VersionedRef;
      command_input_variable: string;
    }
  | {
      action_kind: 'runtime_command';
      command_type: WorkflowRuntimeCommand['command_type'];
      target_binding: 'workflow' | 'run' | 'node' | 'retry_schedule' |
        'effect_operation' | 'operational_blocker';
    };

interface CardPresentationActionContract {
  action_id: string;
  label: string;
  binding: CardActionBinding;
  required_permission: string;
  idempotency_domain: 'card_interaction';
  expires_after_ms: number;
}

interface CardPresentationContract {
  format: 'icarus.card-presentation/1';
  ref: VersionedRef;
  owner_feature_id: string | null;
  template_ref: VersionedRef;
  template_hash: string;
  variable_schema_ref: VersionedRef;
  variable_schema_hash: string;
  supported_channel_adapters: Array<{
    adapter_ref: VersionedRef;
    adapter_hash: string;
    render_profile_ref: VersionedRef;
  }>;
  render_limits: {
    max_payload_bytes: number;
    max_text_bytes: number;
    max_actions: number;
  };
  fallback_text_template_ref: VersionedRef;
  actions: CardPresentationActionContract[];
  snapshot_retention_policy_ref: VersionedRef;
  deterministic_render_fixture_ref: string;
  deterministic_render_fixture_hash: string;
  contract_hash: string;
}

interface CardActionInvocation {
  presentation_ref: VersionedRef;
  presentation_hash: string;
  rendered_snapshot_ref: string;
  rendered_snapshot_hash: string;
  action_id: string;
  idempotency_key: string;
  expected_target_row_version: number;
  submitted_at_ms: number;
  credential_ref: string | null;
}

interface WorkflowGraphPolicyEnvelope {
  allowed_node_types: GraphNodeType[];
  allowed_capabilities: VersionedRef[];
  allowed_templates: VersionedRef[];
  allowed_interface_refs: VersionedRef[];
  allowed_wait_contracts: VersionedRef[];
  allowed_child_policy_refs: VersionedRef[];
  allowed_claim_ids: string[];
  allow_early_close: boolean;
  allow_indefinite_waits: boolean;
  effect_policy: {
    allowed_recovery_kinds: EffectRecoveryKind[];
    max_impact: EffectImpact;
  };
  build_retry: WorkflowGraphBuildRetryPolicy | null;
  limits: NullableWorkflowGraphLimits;
  usage_budget: NullableWorkflowUsageBudget;
}

interface WorkflowGraphBuildRetryPolicy {
  max_attempts: number | null;
  initial_backoff_ms: number;
  max_backoff_ms: number | null;
  max_duration_ms: number | null;
}

interface WorkflowGraphPolicyRequest {
  allowed_node_types: GraphNodeType[] | null;
  allowed_capabilities: VersionedRef[] | null;
  allowed_templates: VersionedRef[] | null;
  allowed_interface_refs: VersionedRef[] | null;
  allowed_wait_contracts: VersionedRef[] | null;
  allowed_child_policy_refs: VersionedRef[] | null;
  allowed_claim_ids: string[] | null;
  allow_early_close: boolean | null;
  allow_indefinite_waits: boolean | null;
  effect_policy: {
    allowed_recovery_kinds: EffectRecoveryKind[] | null;
    max_impact: EffectImpact | null;
  } | null;
  build_retry: Pick<
    WorkflowGraphBuildRetryPolicy,
    'max_attempts' | 'max_duration_ms'
  > | null;
  limits: NullableWorkflowGraphLimits;
  usage_budget: NullableWorkflowUsageBudget;
}

interface WorkflowGraphPolicyProfile {
  ref: VersionedRef;
  request: WorkflowGraphPolicyRequest;
  profile_hash: string;
}

type WorkflowGraphSource =
  | { type: 'inline'; scope: GraphScopeSpec }
  | { type: 'context_slot'; slot: string }
  | { type: 'artifact'; ref: string; json_pointer?: string }
  | { type: 'template'; template_ref: VersionedRef };

type WorkflowValueBinding =
  | { source: 'workflow_input'; pointer?: string }
  | { source: 'context_slot'; slot: string; pointer?: string }
  | { source: 'completed_output'; port: PortName; pointer?: string }
  | { source: 'artifact'; ref: string; json_pointer?: string }
  | { source: 'constant'; value: JsonValue };

type WorkflowGraphInputBinding = Exclude<
  WorkflowValueBinding,
  { source: 'completed_output' }
>;

interface WorkflowContextContract {
  ref: VersionedRef;
  slots: Record<
    string,
    {
      schema_ref: VersionedRef;
      required_initially: boolean;
      write_policy: 'replace' | 'write_once';
      max_bytes: number | null;
    }
  >;
  contract_hash: string;
}

interface WorkflowContextPatchSpec {
  set: Record<string, WorkflowValueBinding>;
  clear: string[];
}

interface WorkflowDefinitionTransition {
  target: string;
  context_patch?: WorkflowContextPatchSpec;
  notify?: WorkflowDefinitionNotify;
  card?: WorkflowDefinitionCardRef;
  effects?: TrustedWorkflowTransitionEffects;
}

type TrustedWorkflowTransitionEffect =
  | ({
      id: string;
      type: 'start_child_workflow';
      recipe_ref: VersionedRef;
      routing_scope_ref: VersionedRef;
      principal_binding: 'inherit_parent_principal';
      creation_domain: 'parent_workflow_lineage';
      relation_kind: 'follow_up' | 'background' | 'validation' | 'domain_defined';
      input_bindings: Record<
        string,
        | { source: 'context_slot'; slot: string; pointer?: string }
        | { source: 'completed_output'; port: PortName; pointer?: string }
        | { source: 'constant'; value: JsonValue }
      >;
    } & WorkflowChildCreationDelivery);

type WorkflowChildCreationDelivery =
  | {
      delivery_requirement: 'required';
      finalization_policy_ref: VersionedRef;
      outbox_delivery_policy_ref?: never;
    }
  | {
      delivery_requirement: 'best_effort';
      finalization_policy_ref?: never;
      outbox_delivery_policy_ref: VersionedRef;
    };

interface TrustedWorkflowTransitionEffects {
  operations: TrustedWorkflowTransitionEffect[];
}

interface WorkflowDefinitionCapabilityStateBase extends WorkflowDefinitionStateBase {
  type: 'delegation' | 'system';
  capability_ref: VersionedRef;
  policy: WorkflowGraphPolicyEnvelope;
  input_bindings: Record<PortName, WorkflowGraphInputBinding>;
  retry_request: {
    max_attempts: number | null;
    retry_on: string[] | null;
  } | null;
  timeout_ms: number | null;
  on_complete: {
    success: WorkflowDefinitionTransition;
    failure: WorkflowDefinitionTransition;
  };
  on_error: WorkflowDefinitionTransition;
  on_local_cancel: WorkflowDefinitionTransition;
}

interface WorkflowDefinitionDelegationState extends WorkflowDefinitionCapabilityStateBase {
  type: 'delegation';
}

interface WorkflowDefinitionSystemState extends WorkflowDefinitionCapabilityStateBase {
  type: 'system';
}

interface WorkflowDefinitionInterruptState extends WorkflowDefinitionStateBase {
  type: 'interrupt';
  wait: WaitSourceSpec;
  policy: WorkflowGraphPolicyEnvelope;
  input_bindings: Record<PortName, WorkflowGraphInputBinding>;
  on_resume: Record<string, WorkflowDefinitionTransition>;
  on_expire: WorkflowDefinitionTransition | null;
  on_wait_cancelled: WorkflowDefinitionTransition | null;
  on_error: WorkflowDefinitionTransition;
  on_local_cancel: WorkflowDefinitionTransition;
}

interface NullableWorkflowGraphLimits {
  max_scopes: number | null;
  max_nodes: number | null;
  max_nodes_per_scope: number | null;
  max_edges_per_scope: number | null;
  max_nesting_depth: number | null;
  max_map_items: number | null;
  max_concurrency: number | null;
  max_total_attempts: number | null;
  max_total_waits: number | null;
  max_total_output_bytes: number | null;
  max_scope_spec_bytes: number | null;
  max_condition_steps: number | null;
  max_wait_duration_ms: number | null;
  max_pending_signals: number | null;
  max_fixed_point_facts: number | null;
  max_frontier_bytes: number | null;
}

interface NullableWorkflowUsageBudget {
  max_total_tool_calls: number | null;
  max_total_input_tokens: number | null;
  max_total_output_tokens: number | null;
  max_total_cost_micros: number | null;
}

interface WorkflowDefinitionGraphState extends WorkflowDefinitionStateBase {
  type: 'graph';
  graph_source: WorkflowGraphSource;
  input_bindings?: Record<string, WorkflowGraphInputBinding>;
  root_interface_ref: VersionedRef;
  policy: WorkflowGraphPolicyEnvelope;
  exit_routes: Record<string, WorkflowDefinitionTransition>;
  on_error: WorkflowDefinitionTransition;
  on_local_cancel: WorkflowDefinitionTransition;
}

type WorkflowDefinitionTerminalState =
  | (WorkflowDefinitionStateBase & {
      type: 'terminal';
      terminal_kind: 'normal';
      output_binding: WorkflowValueBinding;
      error_code?: never;
      error_binding?: never;
    })
  | (WorkflowDefinitionStateBase & {
      type: 'terminal';
      terminal_kind: 'errored';
      output_binding?: never;
      error_code: string;
      error_binding: WorkflowValueBinding | null;
    });
```

`terminal_kind=normal` 必须提供 output binding 并满足 Recipe output schema；`errored` 必须提供结构化 `error_code`，可选 typed error binding，且不得伪造 normal output。Global cancel 不创建 terminal activation，也不经过 Terminal State output binding。

`WorkflowRootFinalizationPolicy.max_attempts/max_duration_ms/initial_backoff_ms/max_backoff_ms` 都是正 safe integer，`max_backoff_ms >= initial_backoff_ms`，并分别不得超过 `safety.execution.max_root_finalization_attempts_per_schedule/max_root_finalization_duration_ms`；attempt count 包含第一次 T8/preflight 尝试，deadline 从 Root Finalization Schedule 创建时计算并冻结，恢复不重新起算。

`WorkflowOperationalRemediationPolicy` 同样全部 finite，`max_backoff_ms >= initial_backoff_ms`，并受 `safety.execution.max_operational_remediation_attempts_per_blocker/max_operational_remediation_duration_ms` 收紧。Command Policy 必须绑定 exact remediation policy，Blocker 创建时冻结 ref/hash、absolute deadline 和 lifetime attempt budget；manual command 不能提供新的数字、替换 policy、重置计数或延长 deadline。预算耗尽后只允许提交已有外部结果/receipt 的无副作用验证，不能再次执行外部 mutation；仍无法关闭时只能 administrative abandon。

Notification/Card 不提供 `required` delivery 语义，也不建立阻塞 T8 的外部投递 barrier。Published Notification Contract 固定 exact Adapter 与 finite Outbox Delivery Policy，生成的 Outbox row 一律归一化为 `delivery_requirement='best_effort'`；T8 必须原子写入 deterministic notification Outbox intent，intent 一旦提交，外部 delivery/dead-letter 只形成 Delivery Failure，不回滚、不重开也不阻塞 Workflow。需要影响业务推进的确认必须建模为显式 Wait/Signal 或 typed Business Command，不能借 Notification delivery 状态隐式控制 transition。

`WorkflowDefinitionCardRef` 必须解析为 exact Published `CardPresentationContract` ref/hash；Publisher 校验 owner Feature、template variable schema、channel adapter、render profile、finite limits、fallback text、typed action binding 与 deterministic render fixture。Render/preview 工具对同一 Contract、变量 snapshot 和 adapter profile 必须产生相同 canonical `InteractiveCard` payload/hash；preview 不投递、不创建 Wait/Command/Outbox，也不写 Active Registry。Rendered Card snapshot 由 immutable Value 保存，并由 active Run retention handle pin 到 Run 关闭；关闭后按 `snapshot_retention_policy_ref` 清理。Channel 不支持结构化 Card 时只能使用合同固定的 fallback text，不得动态发明 action URL 或把 Card 降级为可改变业务状态的自由文本回复。

Card action ingress 只接受 `CardActionInvocation` closed schema。Actor、authenticated session、delegation chain、source channel、permission snapshot 和可信 idempotency domain 由服务端补充，客户端/Card payload 不得自报；Gateway 同时验证 exact presentation/snapshot hash、action id、expiration、actor permission、目标 ownership、`expected_target_row_version` 与绑定合同。重复点击同 key/same request 返回原结果并追加 duplicate audit；同 key/different request 返回 `idempotency_conflict`；过期返回 `action_expired`；row version 变化返回 `row_version_conflict`，都不得改变 Wait 或 Command 状态。`wait_signal` 进入 Durable Wait ingress，`business_command` 进入 Feature typed Business Command Gateway，`runtime_command` 进入 closed Runtime Command Gateway；三者之间不设字符串 alias 或 fallback。Credential 只能以 `credential_ref` 解析，Secret 原文禁止进入 Card payload、rendered snapshot、Value、Trace 或审计。Durable Wait/Business Command/Runtime Command 是权威事实，Card delivery、render 和 action UI 都不是 Workflow 状态源。

`CardPresentationContract` 只覆盖 Dynamic Workflow 发布的展示资源，不替代现有通用 `InteractiveCard` 类型、渠道 `sendCard` 能力、Ask User Question Card、Assistant Card 或其他非 Workflow Card producer；这些受保护能力继续使用自己的 typed callback/authorization contract。

`start_child_workflow` 不接受自由字符串模板。Run Protocol v1 固定派生：`creation_domain = parent_workflow_lineage:<root_workflow_id>`，`creation_key = H("icarus:child-workflow-creation-key:1\n", JCS({ parent_workflow_id, source_state_instance_id, source_close_request_id, transition_effect_id }))`。四个字段都来自可信持久化事实；Definition/Planner/调用方不能覆盖或追加业务模板。实际 Recipe、principal、input 与 attachment 继续进入 `creation_intent_hash`，因此相同 key 的语义漂移会确定性返回 `idempotency_conflict`。

Root interface 的所有 exit 必须被 `exit_routes` 完整覆盖。Runtime spec 可以选择内部 graph 结构、trigger 和 completion policy，但只能引用 envelope 允许的资源；外层 transition、typed context patch、final output binding、权限和 configured limit 永远属于受信任 definition。

`WorkflowGraphPolicyProfile` 是 policy registry 中的 versioned immutable record，不是 source 内联权限对象。Effective business policy 按 global、workflow、state、parent compiled snapshot、child profile request 的顺序逐层求交：所有 allowlist 与 `allowed_recovery_kinds` 取集合交集；boolean permission 使用逻辑 AND；`max_impact` 与 numeric limit 只能逐层收紧并取最小有限值；child build 只能降低 `max_attempts/max_duration_ms`，不能改写 inherited backoff。Root/State envelope 的权限数组和 boolean 必须显式配置，不能用 `null` 表示全部允许；child request 的 `null` 只表示继承 parent。Numeric limit/budget 的 `null` 表示不增加业务 ceiling，`0` 表示禁止消费；child 的 `null` 不能移除 parent 已有的有限限制。不存在隐藏 business limit，配置创建器必须生成全部 numeric 字段并以 `null` 初始化；部署级 finite `RuntimeSafetyCeilings` 始终另行取最小值。Global/workflow Graph Policy 的 exact ref/hash 必须由 trusted Core/Recipe binding 明确提供，不能由 lowerer 注入匿名默认值。

Child request 的 allowlist 表示 ceiling 而不是 required dependency；其中 parent 未允许的 ref 在交集后自然移除，空交集本身可以是合法的“该类资源全部禁止”。只有 child source 实际引用 effective allowlist 外资源时 compiler 才报 `*_not_allowed`。Child profile ref 本身必须位于 parent `allowed_child_policy_refs`，否则不能应用。

`build_retry=null` 的 root/parent policy 表示只 acquisition 一次，child 不能重新启用 retry；child request 的 null 表示继承。Parent 已启用时 child 只能把 non-null `max_attempts/max_duration_ms` 变得更严格，null 表示不增加 ceiling，backoff 继续继承 parent，不能由动态 source 改写。

Published Definition 必须按 closed-world `icarus.workflow-definition/1` 解析。`WorkflowDefinitionStateBase` 只保留 `type/label/description`；旧 `delegate.role/skill/task_template`、`before_delegate/after_complete`、`system.run.steps`、`context_requirements`、旧 `quality_gate/retry_policy/timeout_policy/artifact_contract/evaluator/rollback_hint` 与 `transition.delegate` 均作为 unknown field 直接拒绝，不做兼容 lowering。多个 ready node 的并发 claim 已是 Graph Runtime 原生能力；v1 只由 CLI/API 生成标准 `GraphScopeSpec`，不提供可视化 Definition/Graph 管理 UI 或 public parallel DSL/builder。未来工具可以在不改变合同的前提下批量生成布局。单节点 state 的 `on_complete/on_resume/on_expire/on_wait_cancelled` lower 为 root interface exits 和受信任 route mapping，不能继续由旧 completion handler 单独推进 workflow；需要 output condition、多级 route 或多步骤执行时直接使用 `graph`。

Delegation、system、interrupt authoring state 均保持严格单节点语义：分别 lower 为一个 delegation capability、一个 system capability 或一个 wait node；不保留 `before_delegate`、`after_complete` 或多步骤 `system.run.steps`。任何多节点流程一律使用 `graph` 显式表达。Transition 只决定 target state 及受信任的通知/card/effect，不得内嵌 delegate、capability、role、skill、prompt、retry 或 timeout；路径差异通过 source root 的 typed output 和 T8 trusted context patch 传递。需要不同执行合同的路径使用不同 target state/capability。

所有 executable authoring state 都显式携带完整 `WorkflowGraphPolicyEnvelope`；单节点 state 也不能由 lowerer 注入隐藏 business limits/permissions。配置创建器为其 numeric limits/usage budget 生成全量 null 字段，权限 allowlist/boolean 则必须显式填写；lowerer 同时绑定 run 创建时冻结的 safety snapshot，State 无权移除。

所有 delegation/system node 一律引用精确 `capability_ref: VersionedRef`，不再允许 runtime 直接组合 `role + skill + action`，也不允许 `latest`、版本范围或 runtime fallback。Feature package 在 publish 时注册 versioned capability；definition lowering 只生成 capability reference 和 typed bindings。Capability 固定 executor、Prompt Family/Contract/选择策略、role/skill、权限、port、artifact/evaluator/quality、retry ceiling、effect 和 cancellation contract；受信任创建面把当前有效 Base/Local Prompt 解析为 exact ref/hash 并写 Run Snapshot，node 只能绑定 typed input、收紧 retry/timeout，不能覆盖执行配置。具体任务要求可以作为 capability 声明的 typed input，但不能借 input 扩大权限或替换受保护 Prompt Section。

Root Graph 的四类结果使用独立可信路径：normal named exit 由 `exit_routes` 完整覆盖；engine error 走 `on_error`；local graph cancel 走 `on_local_cancel`；global workflow cancel 固定终止 Workflow Instance、清空 current run，不能执行 state transition。Child 的 `parent_close` 只在 Graph 内部收敛，不触发外层 transition。

`start_child_workflow` 只允许出现在 published Definition 的 trusted transition effect，动态 Scope Spec 和 Planner 不能生成。Definition 只声明 effect 中的 exact Child RecipeRef，不声明第二份 allowlist；Parent Recipe 的 `allowed_child_recipe_refs` 必须与该 entrypoint 可达 transition effects 的 direct Child RecipeRef 集合完全相等。Publisher 拒绝缺失、额外、重复 ref 以及 Child Recipe dependency cycle，并对完整 transitive closure 派生 permission/effect。Required delivery 必须绑定 exact、全部字段 finite 的 `WorkflowRootFinalizationPolicy`，best-effort 必须绑定 exact finite Outbox Delivery Policy；两者不能互换或省略。T8 对 source cut、effect id 和 creation key 做 exactly-once child creation，并写 root lineage/depth/account。Detached/background child 不阻塞 parent；若 parent 必须消费结果，应优先使用 subgraph，或由 child 通过 versioned signal contract 恢复 parent 的显式 wait，不能隐藏同步依赖。Direct child 计入 parent lifetime budget，全部 descendant 同时计入 root-workflow shared lineage account。

## Scope Interface 与 Source IR

```ts
type JsonScalar = null | boolean | number | string;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

type NodeId = string;
type EdgeId = string;
type PortName = string;
type ExitName = string;

interface ValuePortContract {
  schema_ref: VersionedRef;
  max_bytes: number | null;
}

interface ScopeInputPortContract extends ValuePortContract {
  required: boolean;
  default?: JsonValue;
}

interface NamedExitContract {
  output_ports: Record<PortName, ValuePortContract & { required: boolean }>;
}

interface GraphScopeInterfaceContract {
  ref: VersionedRef;
  inputs: Record<PortName, ScopeInputPortContract>;
  exits: Record<ExitName, NamedExitContract>;
}

interface GraphScopeSpec {
  format: 'icarus.workflow-graph-scope/1';
  scope_key: string;
  label?: string;
  interface_ref: VersionedRef;
  nodes: GraphNodeSpec[];
  route_groups?: RouteGroupSpec[];
  control_edges: ControlEdgeSpec[];
  data_edges: DataEdgeSpec[];
  completion: ScopeCompletionPolicySpec;
  requested_limits: NullableWorkflowGraphLimits;
  metadata?: Record<string, JsonValue>;
}
```

`format` 是 source IR compatibility revision，不是能力受限版本。Compiler 对 schema 使用 closed-world 校验，任何未知字段都拒绝。Runtime source 的 `interface_ref` 必须精确匹配 state 或 owner node 固定的 interface；不能在运行时发明下游无法验证的输入或出口。

`requested_limits` 的全部字段必须存在，AI/config creator 未请求进一步收紧时统一写 null；非 null 值只会与 inherited policy 取更严格结果，不能扩大 parent limit，也不改变“null effective limit 不校验”的规则。

### 完整 Source IR Fixture

下面的 JSON 是 compiler fixture 的起点，不是伪代码。Fixture registry 必须同时提供其中引用的 interface、capability、wait contract 与 schema；测试先对 JSON 做 closed-schema parse，再断言 canonical source hash 和 compiled plan hash。

```json
{
  "format": "icarus.workflow-graph-scope/1",
  "scope_key": "report_approval",
  "label": "Report approval",
  "interface_ref": {
    "id": "example.report-approval",
    "version": "1.0.0"
  },
  "nodes": [
    {
      "id": "analyze",
      "type": "delegation",
      "label": "Analyze request",
      "trigger": { "type": "root" },
      "capability_ref": {
        "id": "example.analyze-report",
        "version": "1.0.0"
      },
      "retry_request": { "max_attempts": 2 },
      "timeout_ms": 300000
    },
    {
      "id": "approval",
      "type": "wait",
      "label": "Approval",
      "trigger": {
        "type": "all",
        "edge_ids": ["control.analyze.succeeded"]
      },
      "wait": {
        "type": "approval",
        "contract_ref": {
          "id": "example.report-approval-signal",
          "version": "1.0.0"
        },
        "correlation_input_port": "correlation_key",
        "timeout_ms": 86400000
      }
    },
    {
      "id": "accepted",
      "type": "terminal",
      "trigger": {
        "type": "all",
        "edge_ids": ["control.approval.accepted"]
      },
      "exit": "accepted"
    },
    {
      "id": "rejected",
      "type": "terminal",
      "trigger": {
        "type": "all",
        "edge_ids": ["control.approval.rejected"]
      },
      "exit": "rejected"
    },
    {
      "id": "processing_failed",
      "type": "terminal",
      "trigger": {
        "type": "any",
        "edge_ids": ["control.analyze.default", "control.approval.default"]
      },
      "exit": "processing_failed"
    }
  ],
  "route_groups": [
    {
      "id": "route.analyze",
      "from_node_id": "analyze",
      "mode": "first_matching",
      "no_match": "error"
    },
    {
      "id": "route.approval",
      "from_node_id": "approval",
      "mode": "first_matching",
      "no_match": "error"
    }
  ],
  "control_edges": [
    {
      "id": "control.analyze.succeeded",
      "kind": "control",
      "from_node_id": "analyze",
      "to_node_id": "approval",
      "on": { "statuses": ["succeeded"] },
      "route_group_id": "route.analyze",
      "priority": 100
    },
    {
      "id": "control.analyze.default",
      "kind": "control",
      "from_node_id": "analyze",
      "to_node_id": "processing_failed",
      "route_group_id": "route.analyze",
      "default": true
    },
    {
      "id": "control.approval.accepted",
      "kind": "control",
      "from_node_id": "approval",
      "to_node_id": "accepted",
      "on": { "statuses": ["succeeded"] },
      "when": {
        "op": "eq",
        "left": {
          "ref": {
            "source": "edge_source_output",
            "port": "resolution",
            "pointer": "/action"
          }
        },
        "right": { "literal": "approve" }
      },
      "route_group_id": "route.approval",
      "priority": 100
    },
    {
      "id": "control.approval.rejected",
      "kind": "control",
      "from_node_id": "approval",
      "to_node_id": "rejected",
      "on": { "statuses": ["succeeded"] },
      "when": {
        "op": "eq",
        "left": {
          "ref": {
            "source": "edge_source_output",
            "port": "resolution",
            "pointer": "/action"
          }
        },
        "right": { "literal": "reject" }
      },
      "route_group_id": "route.approval",
      "priority": 90
    },
    {
      "id": "control.approval.default",
      "kind": "control",
      "from_node_id": "approval",
      "to_node_id": "processing_failed",
      "route_group_id": "route.approval",
      "default": true
    }
  ],
  "data_edges": [
    {
      "id": "data.request.analyze",
      "kind": "data",
      "from": { "type": "scope_input", "port": "request" },
      "to": { "node_id": "analyze", "port": "request" }
    },
    {
      "id": "data.approval-key.approval",
      "kind": "data",
      "from": { "type": "scope_input", "port": "approval_key" },
      "to": { "node_id": "approval", "port": "correlation_key" },
      "guard_control_edge_id": "control.analyze.succeeded"
    },
    {
      "id": "data.approval.accepted",
      "kind": "data",
      "from": {
        "type": "node_output",
        "node_id": "approval",
        "port": "resolution"
      },
      "to": { "node_id": "accepted", "port": "decision" },
      "guard_control_edge_id": "control.approval.accepted"
    },
    {
      "id": "data.rejected.literal",
      "kind": "data",
      "from": {
        "type": "literal",
        "value": { "status": "rejected" }
      },
      "to": { "node_id": "rejected", "port": "decision" },
      "guard_control_edge_id": "control.approval.rejected"
    },
    {
      "id": "data.processing-failed.literal",
      "kind": "data",
      "from": {
        "type": "literal",
        "value": { "status": "processing_failed" }
      },
      "to": { "node_id": "processing_failed", "port": "decision" }
    }
  ],
  "completion": {
    "settled_rules": [
      {
        "id": "select_final_exit",
        "priority": 100,
        "when": { "fact": "all_nodes_terminal" },
        "select": {
          "exits": ["accepted", "rejected", "processing_failed"],
          "pick": {
            "type": "exit_priority_then_first",
            "exit_priority": ["processing_failed", "accepted", "rejected"]
          }
        }
      }
    ],
    "no_match": "error",
    "early_close": "cancel_and_fence_remaining"
  },
  "requested_limits": {
    "max_scopes": null,
    "max_nodes": null,
    "max_nodes_per_scope": null,
    "max_edges_per_scope": null,
    "max_nesting_depth": null,
    "max_map_items": null,
    "max_concurrency": null,
    "max_total_attempts": null,
    "max_total_waits": null,
    "max_total_output_bytes": null,
    "max_scope_spec_bytes": null,
    "max_condition_steps": null,
    "max_wait_duration_ms": null,
    "max_pending_signals": null,
    "max_fixed_point_facts": null,
    "max_frontier_bytes": null
  },
  "metadata": { "fixture": "report-approval" }
}
```

## Control Edge、Condition 与 Trigger

```ts
type NodeTerminalStatus = 'succeeded' | 'failed' | 'skipped' | 'cancelled';

interface NodeOutcomeMatch {
  statuses: NodeTerminalStatus[];
  codes?: string[];
  child_exits?: ExitName[];
}

type ConditionRef =
  | { source: 'scope_input'; port: PortName; pointer?: string }
  | {
      source: 'edge_source_output';
      port: PortName;
      pointer?: string;
    }
  | {
      source: 'edge_source_fact';
      field: 'status' | 'code' | 'child_exit';
    };

type ConditionOperand = { literal: JsonValue } | { ref: ConditionRef };

type ConditionExpr =
  | { op: 'and' | 'or'; args: ConditionExpr[] }
  | { op: 'not'; arg: ConditionExpr }
  | { op: 'exists'; value: ConditionOperand }
  | {
      op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      left: ConditionOperand;
      right: ConditionOperand;
    }
  | { op: 'in'; value: ConditionOperand; set: ConditionOperand };

interface RouteGroupSpec {
  id: string;
  from_node_id: NodeId;
  mode: 'all_matching' | 'first_matching';
  no_match: 'allow' | 'error';
}

interface ConditionalControlEdgeSpec {
  id: EdgeId;
  kind: 'control';
  from_node_id: NodeId;
  to_node_id: NodeId;
  on: NodeOutcomeMatch;
  when?: ConditionExpr;
  route_group_id?: string;
  priority?: number;
}

interface DefaultControlEdgeSpec {
  id: EdgeId;
  kind: 'control';
  from_node_id: NodeId;
  to_node_id: NodeId;
  route_group_id: string;
  default: true;
}

type ControlEdgeSpec = ConditionalControlEdgeSpec | DefaultControlEdgeSpec;

type EdgeTruthExpr =
  | {
      op: 'edge_is';
      edge_id: EdgeId;
      state: 'taken' | 'not_taken';
    }
  | { op: 'and' | 'or'; args: EdgeTruthExpr[] }
  | { op: 'not'; arg: EdgeTruthExpr };

type NodeTriggerSpec =
  | { type: 'root' }
  | { type: 'all'; edge_ids: EdgeId[] }
  | { type: 'any'; edge_ids: EdgeId[] }
  | { type: 'quorum'; edge_ids: EdgeId[]; min_taken: number }
  | { type: 'expression'; expression: EdgeTruthExpr };
```

确定语义：

1. Source node terminal 后先用 `on` 匹配技术 outcome，再计算 `when`。
2. Condition 只能读取 frozen scope input、source node 已发布 output 和 source terminal fact。
3. `first_matching` 非 default edge 必须声明 group 内唯一整数 priority，按数值从高到低评估；最多一个 `default`，default 禁止 `on/when/priority`，仅当前面都不匹配时 taken。
4. Default 只允许属于 `first_matching` group；`all_matching` group 禁止 default/priority，独立计算每条 edge。Ungrouped edge 等价于单独的 `all_matching` route，禁止 default/priority。
5. 同一 source node 的全部 route groups 和 ungrouped outgoing control edges 必须在 source terminal transaction 中原子解析。
6. Group 没有匹配且没有 default 时，`no_match=allow` 将组内 edges 全部解析为 not_taken；`no_match=error` 将组解析为 orchestration error。Ungrouped edge 不匹配永远是 not_taken。
7. Control resolution 只能从 `unresolved` 一次进入 `taken | not_taken | error`。
8. `error` 是 orchestration error，不能当作 `not_taken`。
9. 指向 node 的每条 control edge 必须恰好被 trigger 引用；禁止存在不参与 trigger 的隐式依赖。
10. Skipped node 仍必须发布 terminal fact 并解析 outgoing routes，因此可以显式处理 skip code。

`NodeOutcomeMatch` 中已声明的 `statuses/codes/child_exits` 分别做 membership 检查，字段之间是 AND；source 没有可选 code/child_exit 时对应检查为 false，不是 evaluator error。Condition evaluator 是 total、严格类型语义：

- JSON Pointer missing 产生内部 `absent` sentinel；JSON `null` 仍是存在的值。
- `exists` 只判断是否非 absent。
- `eq/ne` 要求双方存在且类型兼容，使用 canonical JSON structural equality；`lt/lte/gt/gte` 只允许 number-number 或 string-string。
- `in` 要求右侧是 array，并用 canonical equality 比较成员。
- 非 `exists` 运算遇到 absent、type mismatch、非有限 number，或超出已配置的 non-null size/step limit 时产生 condition error。
- `and/or` 按 args 顺序做 left-to-right short-circuit；未求值分支不产生 error。空 `and/or` 在 compile 时拒绝。
- `on` 不匹配或 condition=false 解析为 not_taken；condition error 解析为 edge error 并触发 scope orchestration error。

Trigger 真值表固定如下：

| Trigger      | `true`                          | `false`                 | `unknown`                    |
| ------------ | ------------------------------- | ----------------------- | ---------------------------- |
| `root`       | node 无 incoming control edge   | 非法配置                | scope 尚未 materialize       |
| `all`        | 全部引用 edge=taken             | 任一 edge=not_taken     | 其余情况仍有 unresolved      |
| `any`        | 任一 edge=taken                 | 全部引用 edge=not_taken | 尚无 taken 且仍有 unresolved |
| `quorum(N)`  | taken count >= N                | taken + unresolved < N  | 其他情况                     |
| `expression` | Strong Kleene 三值表达式为 true | 表达式为 false          | 表达式为 unknown             |

`all/any/quorum/expression` 必须引用非空 edge set；`1 <= min_taken <= edge_ids.length`。Trigger 首次从 unknown 不可逆变为 true 时立即在 node 上冻结 `trigger_cut`，记录 witness edge、resolution seq 和 truth-program hash，不能等 data input seal 后再选择 witness。Input ports 随后独立 seal；node 只有同时持有 trigger cut 和 input snapshot 才进入 ready。Late taken/not-taken edge 不改变已冻结 trigger cut，但任何 route/data resolution `error` 都是 scope orchestration error，即使目标 node 已 ready/active 也会触发 scope close/fence。

## Data Edge、Port 与 Input Seal

```ts
type DataSourceEndpoint =
  | { type: 'scope_input'; port: PortName; pointer?: string }
  | {
      type: 'node_output';
      node_id: NodeId;
      port: PortName;
      pointer?: string;
    }
  | { type: 'literal'; value: JsonValue };

interface DataEdgeSpec {
  id: EdgeId;
  kind: 'data';
  from: DataSourceEndpoint;
  to: { node_id: NodeId; port: PortName };
  guard_control_edge_id?: EdgeId;
  on_missing?: 'unavailable';
}

type InputAggregation =
  | {
      type: 'single';
      required: boolean;
      select: 'only' | 'first_resolved' | 'lowest_edge_id';
      default?: JsonValue;
    }
  | {
      type: 'list';
      min_items: number;
      seal:
        | { type: 'all_sources_resolved' }
        | { type: 'first_n_available'; count: number };
      order: 'edge_id' | 'resolution_seq';
    };

type NodeInputPortContract =
  | (ValuePortContract & {
      aggregation: Extract<InputAggregation, { type: 'single' }>;
      item_contract?: never;
    })
  | (ValuePortContract & {
      aggregation: Extract<InputAggregation, { type: 'list' }>;
      item_contract: ValuePortContract;
    });

interface NodeOutputPortContract extends ValuePortContract {
  required: boolean;
}

type CompiledPortSchema =
  | { type: 'registry'; ref: VersionedRef; schema_hash: string }
  | {
      type: 'generated';
      generator: 'join_expose' | 'child_completion' | 'map_result';
      parameter_hash: string;
      schema_json?: JsonValue;
      schema_ref?: string;
      schema_hash: string;
    };

type CompiledNodeInputPortContract =
  | {
      schema: CompiledPortSchema;
      max_bytes: number | null;
      aggregation: Extract<InputAggregation, { type: 'single' }>;
    }
  | {
      schema: CompiledPortSchema;
      max_bytes: number | null;
      aggregation: Extract<InputAggregation, { type: 'list' }>;
      item_schema: CompiledPortSchema;
      item_max_bytes: number | null;
    };

interface CompiledNodeOutputPortContract {
  schema: CompiledPortSchema;
  max_bytes: number | null;
  required: boolean;
}

type PublishedNodeOutputPort =
  | {
      state: 'present';
      value_ref: string;
      value_hash: string;
      schema_hash: string;
      byte_length: number;
    }
  | { state: 'absent'; schema_hash: string };

interface NodeOutputEnvelope {
  port_contract_hash: string;
  ports: Record<PortName, PublishedNodeOutputPort>;
  envelope_hash: string;
}
```

- Control edge 决定是否触发；data edge 决定输入值是否可用。
- Guard edge 为 `not_taken` 时 data resolution 变为 `unavailable`，不会无限等待。
- Trigger 为 true 且所有 declared input ports 都 sealed 后 node 才能 claim；optional 只决定无值时 seal 为 absent，而不是允许 open port 被忽略。
- Trigger 为 true 但 required input 已确定不可能满足时，node 进入 `skipped/input_unavailable`。
- 默认使用 `all_sources_resolved + edge_id order`，获得与完成顺序无关的确定性 fan-in。
- `first_resolved` 和 `first_n_available` 明确选择 completion-order semantics；选择的 edge id、resolution seq 和 value hash 必须写入 input snapshot。
- Attempt result 不能直接成为跨 node 隐式输入。Logical node 只从最终成功 attempt 原子发布 typed output 一次。
- Data resolution 只能从 `unresolved` 一次进入 `available | unavailable | error`，并保存 value ref/hash、source attempt、schema hash 和 resolution seq。
- Node 只有在所有 required output port 通过 schema/size 校验后才能 terminalize 为 `succeeded`；缺失 required output 是 attempt/node contract failure。Optional output 未发布，或 source 为 failed/skipped/cancelled 时，相关 data edge 确定性变为 `unavailable`；schema/pointer/value 校验失败则为 `error`。
- Literal 与 scope-input data edge 在 scope materialize 时即可解析；node-output data edge 只能在 source terminal/output publication 后解析。
- `single/only` 最多声明一条 source edge；required=true 且无 default 时必须有一条，required=false 可以零条并 seal 为 absent。`single/first_resolved` 和 `single/lowest_edge_id` 可以声明多条。Default 只有在全部 source resolution 已封闭且没有 available value 时使用。
- `single/first_resolved` 指第一个 `available` value，不是第一条变成 unavailable 的 edge；同一事务可用多个 value 时按 edge id tie-break。`single/lowest_edge_id` 等全部 sources 封闭后选择 id 最小的 available edge。
- `single required=false` 在全部 sources 封闭且没有 available/default 时 seal 为显式 absent；required=true 的同一情况变为 impossible。
- List 的 `min_items` 就是 required 下限。`first_n_available` 达到 N 后立即 seal，并把未选的 late values fencing 于 snapshot 之外；若全部 sources 先封闭且 available count 已达到 `min_items` 但不足 N，则用全部 available values seal；少于 `min_items` 才变为 impossible。同一 resolution seq 按 edge id 排序。
- Compiler 要求 `0 <= min_items <= source_count`；`first_n_available` 还要求 `min_items <= count <= source_count`。零 source 只允许 `min_items=0`，并在 materialize 时 seal 为空列表。
- `NodeInputPortContract.schema_ref/max_bytes` 始终描述 sealed logical port value；list 时 schema 必须描述 array，`max_bytes` 字段必须存在但可以为 null。List aggregation 必须声明 `item_contract`，每条 available data value先按 item schema 和 non-null business item byte limit 校验，seal 后再按 array schema 和 non-null business total byte limit 校验；single aggregation 禁止 `item_contract`。Compiled contract 将这些解析为 `item_schema/item_max_bytes`；null 不注入默认业务值，但 `value.max_single_value_bytes` 与 `run.max_stored_bytes_total` safety ceiling 始终适用。
- Generated compiled schema 必须在 `schema_json/schema_ref` 中恰选一个，并以 generator + parameter hash 形成稳定标识；schema snapshot/hash 和 derived max bytes 都进入 plan hash。
- Logical output publication 使用 canonical `NodeOutputEnvelope`。Envelope 必须包含 compiled contract 的全部 output port；required port 只能是 `present`，optional port 可以是 `absent`。`envelope_hash` 对不含自身 hash 字段的 canonical contract/ports payload 计算。Data edge 按 port 读取 immutable value ref/hash/schema hash，不能把一组多端口 output 压成含义不明的单个 result blob。

## 完整 Node Union

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

interface GraphNodeBase {
  id: NodeId;
  type: GraphNodeType;
  label?: string;
  trigger: NodeTriggerSpec;
  metadata?: Record<string, JsonValue>;
}

interface CapabilityNodeSpec extends GraphNodeBase {
  type: 'delegation' | 'system';
  capability_ref: VersionedRef;
  retry_request?: {
    max_attempts: number;
    retry_on?: string[];
  };
  timeout_ms?: number;
  claim_bindings?: Record<string, string>;
}

type WaitSourceSpec =
  | {
      type: 'signal';
      contract_ref: VersionedRef;
      correlation_input_port: PortName;
      timeout_ms?: number;
    }
  | {
      type: 'timer';
      contract_ref: VersionedRef;
      deadline_input_port: PortName;
    }
  | {
      type: 'approval';
      contract_ref: VersionedRef;
      correlation_input_port: PortName;
      timeout_ms?: number;
    };

interface WorkflowGraphWaitContract {
  ref: VersionedRef;
  kind: 'signal' | 'timer' | 'approval';
  input_ports: Record<PortName, NodeInputPortContract>;
  output_ports: Record<PortName, NodeOutputPortContract>;
  authorization_policy_ref: VersionedRef;
  allow_indefinite: boolean;
  prearm_ttl_ms: number | null;
  contract_hash: string;
}

interface WaitNodeSpec extends GraphNodeBase {
  type: 'wait';
  wait: WaitSourceSpec;
}

interface JoinNodeSpec extends GraphNodeBase {
  type: 'join';
  input_ports: Record<PortName, NodeInputPortContract>;
  expose: Record<PortName, { input_port: PortName }>;
}

type StaticScopeFactorySpec =
  | { type: 'template'; template_ref: VersionedRef }
  | { type: 'inline'; scope: GraphScopeSpec };

type PortBindingSpec =
  | { source: 'node_input'; port: PortName; pointer?: string }
  | { source: 'literal'; value: JsonValue };

interface SubgraphNodeSpec extends GraphNodeBase {
  type: 'subgraph';
  scope: StaticScopeFactorySpec;
  input_ports: Record<PortName, NodeInputPortContract>;
  child_input_bindings: Record<PortName, PortBindingSpec>;
  completion_output_port: PortName;
  expose?: Record<PortName, ChildOutputExposeSpec>;
  child_policy_ref?: VersionedRef;
}

interface ExpandNodeSpec extends GraphNodeBase {
  type: 'expand';
  child_interface_ref: VersionedRef;
  input_ports: Record<PortName, NodeInputPortContract>;
  graph_spec_input_port: PortName;
  child_input_bindings: Record<PortName, PortBindingSpec>;
  completion_output_port: PortName;
  expose?: Record<PortName, ChildOutputExposeSpec>;
  child_policy_ref?: VersionedRef;
}

interface ChildOutputExposeSpec {
  from_exit: ExitName;
  child_port: PortName;
  required: boolean;
}

type MapCompletionPolicy =
  | { type: 'all_settled'; child_error: 'record' | 'fail_node' }
  | {
      type: 'all_accepted';
      accepted_exits: ExitName[];
      on_rejected: 'wait_then_fail' | 'fail_fast';
    }
  | {
      type: 'quorum';
      accepted_exits: ExitName[];
      min_accepted: number;
      on_reached: 'cancel_remaining';
      on_impossible: 'fail_node';
    };

interface MapNodeSpec extends GraphNodeBase {
  type: 'map';
  body: StaticScopeFactorySpec;
  input_ports: Record<PortName, NodeInputPortContract>;
  items_input_port: PortName;
  item_child_input_port: PortName;
  shared_child_input_bindings?: Record<PortName, PortBindingSpec>;
  result_output_port: PortName;
  item_key_pointer?: string;
  requested_max_items: number | null;
  requested_child_concurrency: number | null;
  completion: MapCompletionPolicy;
  child_policy_ref?: VersionedRef;
}

interface TerminalNodeSpec extends GraphNodeBase {
  type: 'terminal';
  exit: ExitName;
}

type GraphNodeSpec =
  | CapabilityNodeSpec
  | WaitNodeSpec
  | JoinNodeSpec
  | SubgraphNodeSpec
  | ExpandNodeSpec
  | MapNodeSpec
  | TerminalNodeSpec;

interface CompiledGraphNodeBase {
  id: NodeId;
  type: GraphNodeType;
  source_config_hash: string;
  trigger_program: CompiledTriggerProgram;
  input_ports: Record<PortName, CompiledNodeInputPortContract>;
  output_ports: Record<PortName, CompiledNodeOutputPortContract>;
  effective_limits: Record<string, number | null>;
}

interface CompiledCapabilityRetryPolicy {
  effective_node_max_attempts: number;
  effective_retry_on: string[];
  backoff: 'fixed' | 'linear' | 'exponential';
  quality_revision: {
    feedback_schema_ref: VersionedRef;
    feedback_schema_hash: string;
    effective_max_feedback_bytes: number;
    context_mode: 'base_input_plus_latest_revision';
  } | null;
  policy_hash: string;
}

interface CompiledCapabilityNode extends CompiledGraphNodeBase {
  type: 'delegation' | 'system';
  capability_binding: WorkflowGraphCapability;
  effective_retry_policy: CompiledCapabilityRetryPolicy;
}

interface CompiledWaitNode extends CompiledGraphNodeBase {
  type: 'wait';
  wait_binding: WaitSourceSpec & {
    contract_snapshot: WorkflowGraphWaitContract;
    effective_max_duration_ms: number | null;
  };
}

interface CompiledJoinNode extends CompiledGraphNodeBase {
  type: 'join';
  expose: JoinNodeSpec['expose'];
}

interface CompiledChildPolicyBinding {
  profile_ref?: VersionedRef;
  effective_policy_snapshot: WorkflowGraphPolicyEnvelope;
  effective_policy_hash: string;
}

interface CompiledStaticScopeFactoryBinding {
  kind: 'template' | 'inline';
  source_ref?: VersionedRef;
  source_snapshot_ref: string;
  source_hash: string;
  precompiled_plan_hash: string;
  interface_snapshot: GraphScopeInterfaceContract;
}

interface CompiledSubgraphNode extends CompiledGraphNodeBase {
  type: 'subgraph';
  factory_binding: CompiledStaticScopeFactoryBinding;
  child_input_bindings: Record<PortName, PortBindingSpec>;
  completion_output_port: PortName;
  expose: Record<PortName, ChildOutputExposeSpec>;
  child_policy: CompiledChildPolicyBinding;
}

interface CompiledExpandNode extends CompiledGraphNodeBase {
  type: 'expand';
  graph_spec_input_port: PortName;
  child_interface_snapshot: GraphScopeInterfaceContract;
  child_input_bindings: Record<PortName, PortBindingSpec>;
  completion_output_port: PortName;
  expose: Record<PortName, ChildOutputExposeSpec>;
  child_policy: CompiledChildPolicyBinding;
}

interface CompiledMapNode extends CompiledGraphNodeBase {
  type: 'map';
  body_binding: CompiledStaticScopeFactoryBinding;
  items_input_port: PortName;
  item_child_input_port: PortName;
  shared_child_input_bindings: Record<PortName, PortBindingSpec>;
  result_output_port: PortName;
  item_key_pointer?: string;
  effective_max_items: number | null;
  effective_child_concurrency: number | null;
  completion: MapCompletionPolicy;
  child_policy: CompiledChildPolicyBinding;
}

interface CompiledTerminalNode extends CompiledGraphNodeBase {
  type: 'terminal';
  exit: ExitName;
}

type CompiledGraphNode =
  | CompiledCapabilityNode
  | CompiledWaitNode
  | CompiledJoinNode
  | CompiledSubgraphNode
  | CompiledExpandNode
  | CompiledMapNode
  | CompiledTerminalNode;
```

Port 的权威来源固定：capability node 从精确 `capability_ref` 对应的 catalog snapshot 派生；wait 从 versioned signal/timer/approval contract 派生；terminal input 从 scope named-exit contract 派生；join 和 child-owner 才允许 source 显式声明 input ports。Join output 由 `expose` 对应 input contract 派生，subgraph/expand result output 由 child interface 的 discriminated exit envelope 派生，map result output 由下述固定 envelope 派生。Compiler 把 factory、bindings、child policy、map controller 和所有 ports 解析为 typed `CompiledGraphNode`，runtime 不重新解释 opaque controller JSON，source 也不能用重复声明覆盖 registry contract。

Capability node compile 还必须把 Capability/State request、Graph Policy 与 Runtime Safety 求交为 typed `CompiledCapabilityRetryPolicy`。`effective_node_max_attempts` 和 `effective_max_feedback_bytes` 因 safety ceiling 始终为 finite 正整数；quality revision non-null 时 feedback schema ref/hash 必须进入 Registry closure、compiled binding 和 plan hash。Runtime 不重新解析 Capability latest 或按当前 Safety 重算这些值。

### Delegation 与 System

- `delegation` 执行 LLM 推理、开放式检索、抽取、综合和报告生成。
- `system` 只执行已注册 deterministic capability。
- 两者都通过 capability catalog 获得 executor、artifact contract、evaluator、quality gate、permissions、retry ceiling、timeout 和 effect contract。
- 每次执行创建 immutable attempt；execution outcome 与 quality decision 分开保存。
- `needs_revision` 只属于 execution succeeded 后的 attempt quality decision，不是 execution failure、Node terminal status 或 Graph cycle。它要求 Capability 显式发布 non-null `quality_revision_policy`，Evaluator 必须同时返回符合 pinned schema/size 的 actionable feedback；缺少、超限或 schema/hash 不匹配是 `evaluation_contract_violation`，不得用空 feedback 猜测下一轮任务。
- Node-level input snapshot 始终不变。下一 Attempt 只通过 attempt-specific Context Pack 获得原始 frozen input、紧邻上一 Attempt 的 candidate/evaluation/feedback refs 和 continuation lineage；v1 不把完整历史正文反复注入，也不允许 Executor 隐式读取 state 级 latest、其他 Attempt 临时文件或 live Workflow Context。完整链仍由 Attempt rows/Trace 可审计。
- execution retry 与 quality revision 都会真实重新执行 Agent/Action 并创建新 Attempt，共享 effective `max_attempts`、Node/Run attempt ledger、deadline 与 usage budget，但 continuation kind 和触发规则不同。`retry_on` 只仲裁 execution failed reason；合法 `needs_revision` 不需要出现在 `retry_on`，也不能借 quality revision 绕过总 Attempt 上限。

```ts
type AttemptContinuationKind =
  | 'initial'
  | 'execution_retry'
  | 'quality_revision';

type TerminalQualityEvaluationResultV1 = {
  format: 'icarus.workflow-terminal-quality-evaluation/1';
} & (
  | {
      decision: 'pass';
      evaluation_ref: string;
      evaluation_hash: string;
      feedback_ref?: never;
      feedback_hash?: never;
    }
  | {
      decision: 'needs_revision';
      evaluation_ref: string;
      evaluation_hash: string;
      feedback_ref: string;
      feedback_hash: string;
      feedback_schema_ref: VersionedRef;
      feedback_schema_hash: string;
    }
  | {
      decision: 'fail';
      evaluation_ref: string;
      evaluation_hash: string;
      rejection_code: string;
      rejection_detail_ref: string | null;
      rejection_detail_hash: string | null;
      feedback_ref?: never;
      feedback_hash?: never;
    }
);

interface QualityRevisionFeedbackEnvelopeV1 {
  format: 'icarus.workflow-quality-revision-feedback/1';
  node_id: NodeId;
  source_attempt_id: string;
  source_attempt_no: number;
  candidate_result_ref: string;
  candidate_result_hash: string;
  candidate_artifact_manifest_ref: string | null;
  candidate_artifact_manifest_hash: string | null;
  evaluation_ref: string;
  evaluation_hash: string;
  feedback_ref: string;
  feedback_hash: string;
  feedback_schema_ref: VersionedRef;
  feedback_schema_hash: string;
  envelope_hash: string;
}

type AttemptContinuationContextV1 =
  | { kind: 'initial' }
  | {
      kind: 'execution_retry';
      parent_attempt_id: string;
      parent_attempt_no: number;
      retry_reason_code: string;
    }
  | {
      kind: 'quality_revision';
      parent_attempt_id: string;
      parent_attempt_no: number;
      feedback_envelope_ref: string;
      feedback_envelope_hash: string;
    };

interface QualityRevisionExhaustionDetailV1 {
  format: 'icarus.workflow-quality-revision-exhaustion/1';
  node_id: NodeId;
  effective_max_attempts: number;
  attempts_created: number;
  last_attempt_id: string;
  last_attempt_no: number;
  last_feedback_envelope_ref: string;
  last_feedback_envelope_hash: string;
  detail_hash: string;
}
```

`TerminalQualityEvaluationResultV1` 是 evaluator-backed Attempt 唯一允许的 terminal decision union；pending/lease retry 是同一 evaluation 的非 terminal 执行状态，不属于该 union。Pass/fail 禁止携带 revision feedback；fail rejection detail 两列必须同 null/非 null。Runtime 必须验证 needs-revision 返回的 schema ref/hash 与 compiled policy 完全相等，再按 schema/byte ceiling 校验 feedback Value。

`QualityRevisionFeedbackEnvelopeV1` 是 immutable Value；candidate artifact 两列必须同 null/非 null，其余 ref/hash 必须成对存在且属于同一 Node/Attempt。`envelope_hash = H("icarus:workflow-quality-revision-feedback:1\n", JCS(payload_without_hash))`，`detail_hash = H("icarus:workflow-quality-revision-exhaustion:1\n", JCS(payload_without_hash))`；两个 ASCII domain separator、format 和字段顺序规则必须进入 Contract Pack/format registry/hash fixture。`source_attempt_no` 必须等于当前 Attempt，非 initial continuation 的 `parent_attempt_no = attempt_no - 1` 且 parent 必须属于同一 Node；`quality_revision` continuation 必须精确引用 parent 的唯一 feedback envelope，`execution_retry` 禁止携带该 envelope。

V1 Context Pack 必须包含 canonical `AttemptContinuationContextV1`，并把它连同 Node input snapshot ref/hash、Attempt identity 和 pinned execution binding 一起纳入 `context_pack_hash`。Quality revision 时 Executor 只能通过 envelope refs 读取上一 candidate、evaluation 和 typed feedback；这些内容按不可信业务 data 处理，不能覆盖 trusted Prompt Section、Capability、Tool/MCP/file allowlist、claim、credential 或 effect key strategy。

### Wait

- `signal`、`timer`、`approval` 统一为 durable wait resource。
- 三种 wait 都必须引用 registry snapshot 中 kind 匹配的 versioned contract；contract ref 同时位于 effective `allowed_wait_contracts`，完整 contract/hash 固化进 compiled node。
- Wait armed 后 node 进入 `waiting`，不占 executor concurrency slot。
- `correlation_key` 唯一标识一个 Wait 实例；同一 `(graph_run_id, contract_ref, correlation_key_hash)` 在整个 Run 生命周期内最多创建一次，不能在后续轮次复用。多轮审批必须加入 generation/nonce。`correlation_key`、外部 `provider_event_id` 与注册操作 `registration_key` 是三个独立字段，不能共用一个 idempotency key。
- Signal 采用 inbox-first：Ingress 先验证 provider、contract、基础权限、payload schema 与 size，即使 Wait 尚未 armed 也按 correlation 保存 `pending`；Wait arm 时再结合 frozen node input、Workflow principal 与目标 action 执行 binding authorization，失败事件标记 rejected 且不阻塞后续合法事件。
- Signal payload 必须通过固定 schema，解析后成为 node typed output。
- Wait 只阻塞依赖它的路径，不自动 pause 整个 Graph Run。
- Signal/approval resolve 和 timer fire 使 node `succeeded` 并发布唯一 required `resolution` output；bounded wait 超时使 node `failed/wait_timeout`，manual cancel 使 node `cancelled/wait_cancelled`。
- 持久化时间统一使用 UTC Unix milliseconds；ISO string 只用于展示。`timeout_ms` 在 arm transaction 中转换为 immutable `deadline_at_ms = armed_at_ms + timeout_ms`，restart/pause 不延长 deadline。Timer typed input 提供 absolute deadline；arm 时已过期则立即成功 fire。任何有限 signal/approval timeout 与 timer deadline 都受 `wait.max_finite_wait_duration_ms` 限制，non-null business `max_wait_duration_ms` 只会进一步收紧。
- 没有 timeout 的 signal/approval 还要求 contract `allow_indefinite=true` 且 effective envelope 显式 `allow_indefinite_waits=true`；numeric max-duration 的 null 不会自动授权 indefinite wait。Indefinite Wait 没有自己的业务 deadline，但仍受有限 Workflow lifetime deadline；Timer 永远必须有 deadline。
- Inbox transaction 分配单调 `inbox_seq` 与 Runtime `received_at_ms`，不信任 provider timestamp。同一 Wait 按 `inbox_seq` 决定先后；timeout 只考虑已提交且 `received_at_ms <= deadline_at_ms` 的 valid event，网络层先到但未提交的请求不能击败已提交 timeout。Signal、timeout 和 cancel 仍竞争同一个 `status=armed + saved work epochs + row_version` CAS。
- Pending Signal 始终受有限部署级 TTL 控制：`expires_at_ms = received_at_ms + min(runtime safety age, non-null contract prearm TTL)`；Contract null 只表示不进一步缩短，不能关闭 Safety TTL。数量按 deployment/workflow/run/principal-provider 分层限制，并限制单 payload 与 correlation bytes。重复 provider event 不重复占额度；rejected/expired/late 使用独立有限审计 retention。Registration delivery 耗尽后 node `failed/wait_registration_failed`。Contract hash/invariant mismatch 是 scope orchestration error。
- Runtime 使用可注入 `Clock` 便于测试，生产读取本机 UTC epoch；保存最近调度时间 watermark 并对明显时钟回拨/跳变写 operational warning，但绝不改写已提交 deadline。

```ts
interface WaitResolutionEnvelope {
  kind: 'signal' | 'approval' | 'timer';
  action?: string;
  payload?: JsonValue;
  resolved_at_ms: number;
  source_event_id?: string;
}
```

### Join

- Join 没有普通 attempt，只在 trigger true 且 inputs sealed 后原子暴露结构化 outputs。
- Join 不执行 dedupe、score、merge、模型推理或业务判断；这些必须是 system/delegation node。
- Join 可表达 all/any/quorum fan-in，但 scope completion 仍由 terminal candidate coordinator 决定。

### Subgraph 与 Expand

- `subgraph` 的 child source/interface 在 parent plan compile 时固定。
- `expand` 不隐藏 planner：先由普通 capability node 生成 candidate Scope Spec，再由 expand node 冻结该 output 并调用 deterministic compiler。
- Owner 的 `child_input_bindings` 在 owner input seal 后冻结并按 child interface 校验；child 不能读取 parent 的 live state。Subgraph/expand 只创建一个 `child_key=single` scope。
- Child binding 只能读取 owner `node_input` 或 literal；需要 parent scope input 时必须先通过 data edge 送入 owner input，禁止绕过 owner seal/provenance 直接引用 scope input。
- Candidate 必须精确实现 pinned `child_interface_ref`，且 effective child policy 只能比 parent 更严格。
- Compiler 使用 run 创建时固定的 registry snapshot，不读取 latest catalog/template/policy。
- Child 正常以任意 named exit 完成时 owner 技术状态为 `succeeded`，并发布 completion envelope；child engine error 才使 owner `failed`。
- Subgraph/expand child `errored` 映射为 owner `failed/child_scope_errored`；非 parent-close 导致的 child cancel 映射为 `cancelled/child_scope_cancelled`。Parent close 导致的 child cancel 只参与 parent fencing，不再发布 owner output。

```ts
interface ChildCompletionEnvelope {
  scope_id: string;
  exit: ExitName;
  output_envelope_ref: string;
  output_envelope_hash: string;
  plan_hash: string;
  cut_event_seq: number;
}
```

Child exit 的统一 immutable output envelope 复用 `NodeOutputEnvelope` 的 port ref/hash/schema/byte-length 结构并精确满足对应 exit contract；Completion Envelope 只引用它，不再次内嵌业务 `JsonValue`。Subgraph/Expand 的 `expose` 可以把指定 exit 的 Child Port 直接发布为 Owner Port，复用原 `value_ref`；不匹配 exit 时按 required/optional contract 处理 absent。Ref 复用不重复收取 logical output bytes。

### Map

- Map claim 时冻结 collection、collection hash、item index 和显式 item key。
- 每个 item 通过 `item_child_input_port` 注入 child；shared bindings 同样在 map input snapshot 中冻结。
- 每个 item 创建唯一 `(owner_node_id, child_key)` child scope。
- Map result envelope 永远按原 index 排序，不依赖 child completion order。
- `quorum` 达成时冻结 selected set，原子 fence 未物化 slot/build，并为已物化 remainder 创建 `parent_close` request；late completion 只审计。
- Map 只负责 child orchestration；业务 reduce 使用后续 join/system/delegation。

```ts
interface MapItemOutcomeBase {
  index: number;
  key: JsonScalar;
}

type MapItemOutcomeEnvelope =
  | (MapItemOutcomeBase & {
      outcome: 'completed';
      scope_id: string;
      completion_seq: number;
      exit: ExitName;
      output_envelope_ref: string;
      output_envelope_hash: string;
      plan_hash: string;
      cut_event_seq: number;
    })
  | (MapItemOutcomeBase & {
      outcome: 'errored';
      scope_id: string | null;
      completion_seq: number;
      error_code: string;
      error_ref?: string;
    })
  | (MapItemOutcomeBase & {
      outcome: 'cancelled';
      scope_id: string;
      completion_seq: number;
      reason: string;
    })
  | (MapItemOutcomeBase & {
      outcome: 'fenced';
      scope_id: string | null;
      fence_event_seq: number;
      reason:
        | 'not_materialized'
        | 'quorum_reached'
        | 'fail_fast'
        | 'parent_close';
    });

interface MapItemResultsManifest {
  items: MapItemOutcomeEnvelope[];
  manifest_hash: string;
}

interface MapResultManifest {
  expansion_manifest_ref: string;
  expansion_manifest_hash: string;
  completion_policy_hash: string;
  selected_indices: number[];
  item_results_manifest_ref: string;
  item_results_manifest_hash: string;
  item_count: number;
}
```

`MapItemResultsManifest.items` 永远覆盖 frozen Expansion Manifest 的全部 index 并按 index 排序，包括尚未 materialize 就被 quorum/fail-fast/parent close 截断的 slot。此类 slot 写 `fenced` 且 `scope_id=null`；build failure 写 `errored` 且 `scope_id=null`。Manifest 在 Map terminal 前一次 seal，之后不可修改；最终 Map output 只发布 `MapResultManifest` 的引用清单，不自动加载或组装全部 Child 业务值。Quorum winner set 按 `(completion_seq, index)` 选择前 N 个 accepted child 并冻结 `selected_indices`；同一事务完成的 child 由 scope 的 durable event sequence 再以 index tie-break。`item_key_pointer` 省略时 key=index；显式 key 必须是唯一 JSON scalar，重复、object/array 或 missing key 使 map node contract failure。

Map child `errored/cancelled` 的处理固定：`all_settled/record` 将其写入 item envelope；`all_settled/fail_node` 等全部 child settled 后失败；`all_accepted` 将其视为 rejected 并按 `on_rejected`；`quorum` 将其视为不可接受 item，并在剩余 child 已不可能达到 `min_accepted` 时失败。所有 fail-fast/quorum cancellation 与 scope early close 使用同一 fence/effect-safety 校验。

Map node 成功时，`all_settled/record` 和成功的 `all_accepted` 将全部 item indices 写入 `selected_indices`；`quorum` 只写 winner set。失败的 map 不发布 logical result output。Empty collection 对 `all_settled` 和 `all_accepted` 产生成功空 manifest；quorum 要求 `min_accepted >= 1`，并在 frozen `item_count < min_accepted` 时立即失败。

业务确实需要完整数组时，必须显式调用 versioned deterministic Materializer/Reducer system Node：它按 index 分页加载成员 ref、验证 hash/schema、执行 item/总字节限制并发布新的普通 Value。该新数组重新收取 logical output bytes；Map manifest 只按元数据字节计费。GC reachability 从 manifest 遍历全部成员 ref，运行中心默认分页展示 slot metadata，仅打开具体 item 时 dereference payload。

Quorum/fail-fast decision 后 controller 进入 durable `closing_remaining`，winner set 与所有 fenced slot 已不可变，但 map owner 尚不 terminal。只有每个已 materialize remainder 都产生 non-publish cut、required compensation 已成功 terminal，且 open build/controller reservation 已清零后，owner 才发布最终 envelope 或 failure。Required compensation 进入 `action_required` 时 Map 保持 `closing_remaining` 并阻止 owner terminal/Cut；可信 remediation 成功后才能继续，无法恢复时只能 administrative abandon，且 abandon 不生成 Cut。这样下游不会在被截断 child 仍可能产生未结 effect 时越过 map 边界。

### Terminal

- Terminal input ports 由 named exit contract 推导。
- 每个 required exit output port 必须恰有一条 data edge，每个 optional port 最多一条；terminal aggregation 固定为 `single/only`。多值、fallback 或 quorum output 必须先由显式 join/system/delegation 归一成单值。
- Terminal ready 后原子冻结 output snapshot 并创建 candidate；它不直接推进 parent 或 workflow。
- 同一 terminal node 只能提交一个 candidate；candidate 使用 scope 内单调 `candidate_seq` 排序。

## Completion Policy、Early Close 与 Named Exit

隐藏的 final join 不存在。业务 fan-in 必须通过显式 join/system/delegation 表达；Completion Coordinator 只从 terminal candidates 中选择一个 scope outcome。

```ts
type CompletionFactExpr =
  | {
      fact: 'candidate_count';
      exits?: ExitName[];
      terminal_node_ids?: NodeId[];
      cmp: 'eq' | 'gte' | 'lte';
      value: number;
    }
  | {
      fact: 'node_count';
      node_ids?: NodeId[];
      statuses: NodeTerminalStatus[];
      codes?: string[];
      cmp: 'eq' | 'gte' | 'lte';
      value: number;
    }
  | { fact: 'all_nodes_terminal' }
  | { op: 'and' | 'or'; args: CompletionFactExpr[] }
  | { op: 'not'; arg: CompletionFactExpr };

interface CompletionCandidateSelector {
  exits?: ExitName[];
  terminal_node_ids?: NodeId[];
  pick:
    | { type: 'first_reached' }
    | {
        type: 'exit_priority_then_first';
        exit_priority: ExitName[];
      }
    | { type: 'lowest_terminal_node_id' };
}

interface CompletionRuleSpec {
  id: string;
  when: CompletionFactExpr;
  select: CompletionCandidateSelector;
}

interface ScopeCompletionPolicySpec {
  early_rules?: Array<
    CompletionRuleSpec & {
      phase: 'early';
      arbitration: 'first_eligible';
      same_event_priority: number;
    }
  >;
  settled_rules: Array<
    CompletionRuleSpec & {
      phase: 'settled';
      priority: number;
    }
  >;
  no_match: 'error';
  early_close: 'cancel_and_fence_remaining';
}
```

`early_rules` 与 `settled_rules` 共享同一个 scope-level rule id namespace；compiler 要求所有 `rule.id` 全局唯一，因此 close request/cut 只需保存 `selected_rule_id` 就能无歧义定位 rule 与 phase。

Completion 规则：

1. Rule 只有在 `when=true` 且 selector 匹配至少一个 persisted candidate 时才适用。每条 Rule 在发布时固定为 `early` 或 `settled`；Run 内不可修改 phase/arbitration。
2. 每个 candidate/node-terminal fact transaction 都必须在分配 durable event seq 后，对 post-state 计算 early rules，并为首次适用的 rule 写 immutable eligibility record。Eligibility 保存 rule、candidate/fact snapshot 和最早 `eligibility_event_seq`。
3. Early Rule 固定使用 `first_eligible`：Run control=running 时，同一 fact transaction 尝试插入唯一 close request，先选最小 eligibility event seq，同 seq 再按 `same_event_priority DESC, rule_id ASC`。它明确接受有效 Fact 的权威数据库提交顺序影响业务结果，但不信任 provider timestamp、worker clock 或网络到达时间。
4. Paused 时只积累 eligibility；resume 仍按 `eligibility_event_seq ASC, same_event_priority DESC, rule_id ASC` 仲裁，不能按恢复时已经存在的全部 candidates 重选。一次已发生执行的恢复结果因此确定，但重新运行 Workflow 时外部物理完成顺序仍可能不同。
5. `first_reached` 在 eligibility fact snapshot 内使用 durable `candidate_seq`；settled transaction 只在候选集合封闭后评估所有 settled rules，按 `priority DESC, rule_id ASC` 选择，并持久化 `phase=settled` eligibility 与 close request。必须保证高优先级结果覆盖低优先级结果时只能使用 settled rule，不能声明“early 但等待未来高优先级”。
6. Early rule 只能使用 compiler 可证明的单调 predicate，例如 `count >= N` 和正向 `and/or`；禁止 `not/eq/lte` 等可能被未来事实推翻的判断。第一版不提供隐藏的 priority grace window；需要等待窗口时使用显式 Timer/Join Node。
7. `lowest_terminal_node_id` 和全局 exit priority 只允许 settled 阶段，除非 compiler 能证明候选集合已经封闭。
8. Coordinator 永远选择一个 candidate，不隐式聚合多个 candidate。Quorum output 必须先由显式 reducer 生成一个 terminal candidate。
9. Close request 冻结 selected candidate/fact frontier，原子递增目标及 descendant fence epoch，并创建 cancel/compensation effects；scope 进入 `closing`，尚未写最终 completion cut。Root request 同时递增 run fence。
10. Close request 后的 late agent result、signal、timer 和 child completion 只能写审计，不能改变 selected candidate 或 frontier。
11. Scope quiescent 后没有 rule/candidate 匹配是 engine error `no_exit_selected`，不能猜成业务 failure。
12. `all_nodes_terminal` 只统计该 scope 自己的 nodes；single child owner 在 child cut 前不是 terminal，map quorum/fail-fast owner 在 materialized remainder 的 cut/compensation 收敛前也不是 terminal，因此 child lifecycle 不会被遗漏。
13. Settled rules 只在 reconciler 达到 fixed point 后运行。Quiescent 要求该 scope 的所有 node 已 terminal、所有 control/data resolution 已封闭、没有尚可 materialize 的 owner child 或 held controller reservation；pending node 必须先被证明 trigger/input impossible 并 terminalize，不能因暂时没有 ready work 就提前结算。Paused/resuming scope 不视为可自动 settled 的 quiescent scope；其事实先积累并在 resume drain 中仲裁。
14. Scope 只有所有逻辑工作已 fenced、required compensation 已成功 terminal 后，才写 completion cut 并进入 closed。Required compensation 的 `action_required` 表示尚未收敛：同一事务创建 `compensation_dead_letter/effect_unknown` Operational Blocker，Scope 保持 `lifecycle=closing`，Run/Workflow 保持 `operational_state=action_required`，继续持有必要 Domain Claim 并阻止 Cut。T6e 可信 remediation 成功并关闭 blocker 后可继续 finalizer；无法恢复时只能 administrative abandon，且 abandon 不生成 Cut。`fence_only/cooperative` 合同已证明可安全丢弃的外部物理 cancel ACK 不阻塞逻辑关闭；其晚到结果受 fence 拒绝。
15. Routing、data resolution、condition、schema、ledger 或 invariant error 绕过正常 completion rules，直接创建 `engine_error` close request、fence scope，并最终产生 `GraphScopeOutcome.kind='errored'`。Root 按 pinned `on_error` 路由；child 按 owner mapping 收敛。

```ts
type GraphScopeOutcome =
  | {
      kind: 'completed';
      exit: ExitName;
      candidate_node_id: NodeId;
      outputs_ref: string;
      outputs_hash: string;
      cut_event_seq: number;
    }
  | { kind: 'errored'; code: string; error_ref?: string }
  | {
      kind: 'cancelled';
      reason: 'local_scope' | 'parent_close' | 'local_graph' | 'workflow';
      detail?: string;
    };
```

`success`、`partial`、`failure` 可以作为业务 exit name，但 snapshot/compiler/invariant error 必须走 `errored`。Child 的 `parent_close/local_scope` 只由 owner/finalizer 消费。Root cancelled outcome 只允许 `reason=local_graph|workflow`，分别归一化为 root `cancel_scope`：local graph cancel 走 `on_local_cancel`；global workflow cancel 直接进入 workflow cancelled terminal，不创建新的 state activation。Root normal outcome 根据 `exit_routes` 推进，root error 走 `on_error`。

## Capability Catalog 与 Effect Contract

```ts
interface CapabilityClaimRequirement {
  slot: string;
  namespace: string;
  access: 'read' | 'write';
}

interface CapabilityDependencyAccess {
  ref: string;
  access: 'read' | 'write';
  impact: EffectImpact;
}

interface CapabilityQualityRevisionPolicy {
  feedback_schema_ref: VersionedRef;
  max_feedback_bytes: number | null;
  context_mode: 'base_input_plus_latest_revision';
}

interface WorkflowGraphCapability {
  ref: VersionedRef;
  node_type: 'delegation' | 'system';
  executor_ref: VersionedRef;
  role_ref?: VersionedRef;
  skill_refs: VersionedRef[];
  prompt_binding?: WorkflowPromptBinding;
  input_ports: Record<PortName, NodeInputPortContract>;
  output_ports: Record<PortName, NodeOutputPortContract>;
  artifact_contract_ref?: VersionedRef;
  no_artifact_expected?: true;
  evaluator_ref?: VersionedRef;
  no_evaluation_expected?: true;
  quality_gate_ref?: VersionedRef;
  quality_revision_policy: CapabilityQualityRevisionPolicy | null;
  required_tools: CapabilityDependencyAccess[];
  required_mcp_methods: CapabilityDependencyAccess[];
  required_file_scopes: CapabilityDependencyAccess[];
  required_claims: CapabilityClaimRequirement[];
  allowed_groups: string[];
  execution_group_ref?: VersionedRef;
  retry_policy: {
    max_attempts: number | null;
    retry_on: string[];
    backoff: 'fixed' | 'linear' | 'exponential';
  };
  timeout_ceiling_ms: number | null;
  effect_impact: EffectImpact;
  effect: CapabilityEffectContract;
  cancellation: CapabilityCancellationContract;
  dependency_closure_hash: string;
}

type CapabilityEffectContract =
  | { type: 'pure' }
  | { type: 'idempotent'; key: CapabilityEffectKeyStrategy }
  | {
      type: 'compensatable';
      operation_key: CapabilityEffectKeyStrategy;
      compensate_action_ref: VersionedRef;
    };

type CapabilityEffectKeyStrategy =
  | { scope: 'attempt' }
  | { scope: 'node' }
  | { scope: 'workflow'; namespace: string }
  | {
      scope: 'business_input';
      namespace: string;
      input_ports: PortName[];
    };

type CapabilityCancellationContract =
  | { type: 'fence_only'; safe_to_abandon: true }
  | {
      type: 'cooperative';
      cancel_action_ref: VersionedRef;
      ack_required_before_close: false;
      safe_if_cancel_lost: true;
    }
  | { type: 'requires_compensation' };
```

- Planner 只能引用 catalog 中已授权 capability，不能声明 executor 或权限。
- Capability 是不可变、版本化的完整执行合同；node 不得覆盖其 executor、role/skill、prompt family/contract、port、permission、artifact/evaluator/quality、effect 或 cancellation。Feature 发布的 Base Prompt 与通过进化门禁的 Local Prompt Variant 都是独立 immutable registry resource；Capability 固定 Prompt Family、Contract 与可信选择策略，Run 创建面解析当前有效 Prompt 后立即固化 exact ref/hash，Planner 和 Executor 均不能改写。
- Capability 可以声明 `task`、`instructions` 等 typed input 供 planner 提供本次业务内容，但这些值始终按 data 处理，不能替换 trusted prompt 骨架、选择额外 tool 或扩大权限。禁止注册允许任意 role/skill/tool/prompt 的 `run-any-agent` 类 capability。
- Capability 必须在 `artifact_contract_ref/no_artifact_expected` 中恰选一个，并在 `evaluator_ref/no_evaluation_expected` 中恰选一个；blocking quality gate 必须与对应 evaluator/artifact contract compatible。Closed Capability schema 要求 `quality_revision_policy` 字段始终存在；non-null 时必须同时具有 `evaluator_ref + quality_gate_ref`，Publisher 必须解析并固定 feedback schema/hash，且 `max_feedback_bytes` 只能是 null 或正 safe integer；null policy 时 Evaluator 返回 `needs_revision` 属于 `evaluation_contract_violation`。`max_feedback_bytes=null` 不注入业务上限，但 Value/Run safety ceiling 始终执行。
- `quality_revision_policy` 不声明第二份次数或 deadline：每次 revision 都是真实 Attempt，统一受 capability `retry_policy.max_attempts`、State/Node `retry_request.max_attempts`、`execution.max_attempts_per_node`、`run.max_attempts_total`、Workflow deadline 和 usage budget 的最小有效上限控制。这样 execution retry 与 quality revision 不能分别重置额度；`retry_on` 仍只允许 execution failure taxonomy。
- Quality revision 会使用新的 Attempt/effect id。Publisher 只允许它绑定 `pure` effect，或 operation key scope 为 `attempt` 的 `idempotent/compensatable` effect；`node/workflow/business_input` key 会把下一轮错误去重为上一轮执行，必须以稳定错误 `quality_revision_effect_key_incompatible` 拒绝。前序 Attempt 已提交的 mutation/receipt 不会因 `needs_revision` 自动回滚；不允许暴露中间副作用的 Capability 必须写 staging，并仅在 pass 后由另一个受信任 capability promote。
- Compiled node 固化完整 binding snapshot/hash；dispatch 不重新解析或 fallback。
- `effect` 描述恢复方式，`effect_impact` 描述业务影响，两者正交。Publisher 为 executor、Tool、MCP method、Action 与 file scope 注册 impact metadata，递归计算 dependency closure；Capability 的 impact 不得低于任一依赖，`pure` 不得引用 write access。State Policy 必须同时允许 recovery kind 与 impact。
- Recipe Publisher 对所有可达 State、动态 allowlist、trusted transition effect 和自动 child Recipe 计算最大 impact、recovery-kind set 与 permission union。派生结果超过 Recipe `effect_ceiling` 时发布失败；Runtime dispatch 再校验 compiled binding 的 dependency closure hash，不能信任手写 `read_only/pure` 声明。
- Run/Event audit 记录实际使用的最大 impact 和 recovery kind，但创建授权始终按“最大可能闭包”完成，不能用历史实际用量降低本次权限检查。
- `pure/idempotent` capability 可以按其 effect contract 恢复或重放，但 `idempotent` 仍可能是 mutation，不能被当作 read-only。
- Effect key strategy 是 trusted capability contract 的一部分。`attempt` 只去重同一 attempt 的 outbox redelivery；`node` 让 node retry 复用同一业务操作；`workflow` 适用于每个 Workflow 只执行一次的操作；`business_input` 对 namespace 与列出的 frozen typed input port 做 canonical hash，适用于 `workspace + package + target_state` 等跨 attempt/workflow 业务幂等。Planner 不能选择 strategy、namespace 或参与 key 的 port。
- `business_input` 的 namespace 在 registry 中全局唯一，所列 port 必须是 required、sealed、非 secret 的 single value；operation key 在 effect intent transaction 中由 Runtime 计算并持久化。Adapter 不能接受调用方自报 key，也不能把不同 frozen input 合并成同一 receipt。
- `compensatable` capability 的外部 operation 必须先写 effect intent，再执行，再写 receipt；compensation 同样通过 outbox、幂等键和 lease。
- `fence_only` 只适用于没有未记录不可逆 effect、可以安全丢弃 late result 的执行；`cooperative` 会发稳定 cancel effect，但物理 ACK 不阻塞逻辑 close，因此 capability 必须显式保证 cancel 丢失/延迟时仍可安全 abandon。不能满足该保证的 effect 必须使用 compensation。
- `requires_compensation` 必须与 `effect.type=compensatable` 配对，并使 scope closing 等待 compensation 成功 terminal；`action_required` 只表示自动处理耗尽并等待可信 remediation，不算收敛且不能放行 Completion Cut。
- 所有 capability 都必须实现上述一种 cancellation contract，因为 global workflow cancel 可以在任意时刻发生；没有安全 fence/cancel/compensation 语义的 capability 不得注册到 Graph Runtime。
- Early close、manual cancel 或 parent cancellation 可能截断 active effectful node。Compiler 必须根据 cancellation/effect contract 证明该组合可 fence、cooperative cancel 或 compensation。
- Compensation failure 不回滚数据库历史；scope/run 进入 `action_required` 并保留 effect journal、必要 Domain Claim 和原 close authority。只有使用相同 effect key 的可信 remediation 成功才能解除 Cut barrier；无法恢复时 administrative abandon 只归档、不生成 Cut。普通 engine error route、manual skip 或数据库手改不能绕过 required compensation。
- Capability 的每个 `required_claims` slot 必须由 Node 绑定到 Recipe 已授权的逻辑 claim spec id。Compiler 校验 namespace、access、State `allowed_claim_ids` 与 mode；Source 不能提供 raw resource key、数据库 claim id 或 fencing token。`read` 可绑定 shared/exclusive，`write` 只能绑定 exclusive。

### Mutable External Resource Mutation

文件 workspace、Git、远端 API、deliverable lifecycle 和 prompt registry 等可变外部资源不能与 SQLite 假装处于一个事务。Mutation capability 必须使用如下 recoverable protocol：

```text
resolve every required claim slot; all write slots hold exclusive claim + current token
  -> persist effect intent + operation-claim rows(operation key, expected-before hash/version)
  -> prepare in staging/shadow resource when supported
  -> apply outside DB transaction through mutation gateway with operation key + claims/tokens
  -> verify authoritative resource after-state
  -> persist receipt(before/after hash, changed paths, external revision)
  -> copy produced files/directory manifest to immutable Value/Blob Store
  -> evaluator/quality gate
  -> publish node output and terminal fact
```

外部成功但 receipt 未知时不得因为新 attempt 直接重复 mutation；adapter 先按 operation key 对账，无法证明结果时进入 `action_required`。Node `succeeded` 前必须同时拥有 schema-valid receipt 与 immutable after-snapshot。Workspace live path 可以继续作为领域事实源和后续 mutation target，但不能成为 Graph recovery 唯一事实。Mutation gateway 在最终提交前逐项验证 held exclusive claim 与 resource head current token；任一 stale/missing claim 都拒绝整个 mutation。

### Versioned Registry 发布与保留

Core 与 Feature package 是 registry resource 的发布者。Feature Manifest vNext 通过 closed `dynamic_workflow_resources` entry union 声明 Recipe、Routing、Definition、Policy、Schema、Interface、Template、Capability、Executor、Prompt/Tool binding、Wait、Notification、Card Presentation、Artifact Contract 与 Evaluator；Core registry 另发布 Compiler Toolchain Manifest/Error Catalog/Golden Bundle、SQLite Execution/Supported Limits、Run Protocol、ABI、Core System Effect 与基础 Adapter 合同。其中 Graph Scope Template 与 capability 内部的 prompt template 是不同概念。加载资源时先做 strict parse/schema validation、canonicalize 和 hash，再写 immutable registry store。

```text
workflow_registry_resources
  - id/resource_type
  - resource_id/resource_version
  - owner_core_ref/owner_feature_id
  - canonical_value_id
  - content_hash
  - publication_state          staged | published | retired
  - created_at_ms/published_at_ms/retired_at_ms/row_version

UNIQUE(resource_type, resource_id, resource_version)
```

这里只展示发布记录摘要；Dependency、Closure、Snapshot、Release activation 与 Retention Handle 的完整 Normative Logical Schema 见“Registry、Release、Retention 与 Backup”。

- 只有显式 Publish 才能生成可执行版本。Authoring Source、Git checkout、安装目录或运行中 Candidate 的变化本身不改变 Registry；Publish 必须依次冻结输入、构建 Artifact、计算 Hash、验证 Schema/permission/effect/ABI/dependency closure、写 immutable records，最后原子切换新 Workflow 创建入口。任一步失败都不能留下 launchable 半成品版本。
- 相同 `(resource_type, id, version)` 的内容发布后不可修改；再次加载相同 ref、不同 hash 必须失败，修改只能发布新 version。Feature Release 与其中各 resource version 相互独立；只修改 Renderer/UI 时可以发布新的 Feature Release 但复用相同 Execution Artifact Hash。
- Workflow definition 发布时解析所有精确 ref，并保存 definition dependency ref/hash；依赖缺失或冲突时不能发布。
- Recipe 发布时解析 Definition/entrypoint、execution policy、Context Contract、input/output schema、child Recipe allowlist 和 resource claim pointer，并从所有可达 Capability/Tool/MCP/Action/file/transition/child Recipe 派生 effect-impact、recovery-kind 与 permission closure；派生结果超过作者 `effect_ceiling` 时拒绝发布。Routing Scope 发布时验证 target 精确存在、scope graph 无环且不存在跨 owner 越权引用。
- Run 创建时固定本次 registry snapshot。由于 `expand` 可以在运行中选择 policy allowlist 内尚未被静态 plan 使用的资源，snapshot 必须覆盖 effective allowlist 的 capability/interface/template/wait/policy、Prompt Family 与全部 schema/Artifact 传递依赖，不能只覆盖当前 nodes。
- Snapshot 使用 content-addressed reusable dependency-closure manifest，只保存 exact refs/hashes、manifest ref/hash 与 retention handle，不为每个 Run 复制合同或 Artifact 字节。相同 Recipe、Policy 与 Allowlist 的 Run 可以共享同一个 closure manifest；某个 Compiled Plan 实际使用的合同仍完整固化进 plan。

第一版执行发布单元固定为 Feature Release 级 Node Bundle，而不是每个 Executor 单独构建复杂依赖闭包：

```ts
interface FeatureExecutionArtifact {
  ref: VersionedRef;
  feature_release_ref: VersionedRef;
  runtime_kind: 'node_bundle';
  artifact_ref: string;
  artifact_hash: string;
  entry_symbols: string[];
  runtime_abi_major: 1;
  dependency_manifest_ref: string;
  dependency_manifest_hash: string;
}

interface ExecutorImplementation {
  ref: VersionedRef;
  provider_feature_ref: VersionedRef;
  execution_artifact_ref: VersionedRef;
  execution_artifact_hash: string;
  entry_symbol: string;
  runtime_abi_major: 1;
  implementation_hash: string;
}

interface ExecutorAbiInvocationV1 {
  executor_abi_major: 1;
  invocation_id: string;
  attempt_id: string;
  capability_ref: VersionedRef;
  capability_hash: string;
  input_snapshot_ref: string;
  input_snapshot_hash: string;
  context_pack_ref: string;
  context_pack_hash: string;
  broker_grant_ref: string;
  broker_grant_hash: string;
  effect_key: string | null;
  execution_deadline_at_ms: number;
  trace_correlation_ref: string;
}

type ExecutorAbiResultV1 =
  | { kind: 'accepted'; external_execution_id?: string }
  | { kind: 'heartbeat'; progress_ref?: string }
  | {
      kind: 'succeeded';
      result_ref: string;
      result_hash: string;
      artifact_manifest_ref?: string;
      artifact_manifest_hash?: string;
      receipt_ref?: string;
      receipt_hash?: string;
    }
  | { kind: 'failed'; code: string; detail_ref?: string }
  | { kind: 'cancelled'; code: string };
```

`ExecutorAbiInvocationV1` 不为 revision 增加可变 prompt 或自由文本字段；每个 Attempt 继续只接收 content-addressed `context_pack_ref/hash`。该 Context Pack 内的 `AttemptContinuationContextV1` 是 Run Protocol v1 的 closed 字段：initial、execution retry 与 quality revision 必须逐类校验，Executor ABI/Host Broker 不得从 Attempt history 猜测或拼接 continuation。这样 revision 语义可以在不扩大 Executor 权限面的前提下通过同一 ABI 执行。

一个 Feature Artifact 可以提供多个 Executor Entry；Graph Node 仍只引用 Capability，Capability 再解析到 exact Executor Record 和 Artifact/Entry。Published Executor 禁止执行当前 `features/{featureId}` workspace 文件；Node Bundle 必须自包含执行依赖并在独立 Worker Process 中加载，旧 Run 不受 Feature Page、Host API 或安装目录升级影响。ABI v1 使用 length-prefixed canonical JSON frame；Core 发 invocation/cancel，Executor 只返回上述 typed result，所有 Tool/MCP/file/mutation/credential 操作通过 `broker_grant_ref/hash` 绑定的 Host Broker，Bundle 不获得 Runtime DB 连接或 credential 原文。

第一版 Threat Model 将已签名/本地批准、能够发布 `workflowCapabilities/ExecutorImplementation` 的 Core/Feature code 纳入 Trusted Computing Base。Worker Process 只提供 crash、version 和 ABI 隔离，不宣称能抵御恶意 Node code；Capability permission、dependency closure、Broker Grant 与 Mutation Gateway 是对可信 Publisher/Executor 的强制执行合同和审计边界。Publish lint 必须拒绝未声明的 Node builtin、dynamic import、native addon、直接 credential/environment 读取和绕过 Broker 的 host path/network access，但 lint 本身不被描述为 hostile-code sandbox。未被标记为 trusted publisher 的 Plugin 不得发布 Workflow Executor。

未来若允许第三方或不可信 Plugin 发布 Executor，必须先引入经验证的 Container/OS sandbox，默认无网络、无 ambient credential、只挂载 staging 与声明的 read-only scope，并通过相同 ABI/Broker 提权；在该门禁落地前不得把 untrusted Bundle 装入 Worker Process。第一版不实现多 Node Runtime、Compatibility Pack 或每 Executor 独立 GC，但 Artifact 抽象保留未来拆分空间。

Icarus Core Release 与 Feature Release 是两个升级面：

```ts
interface IcarusCoreCompatibility {
  core_release_ref: VersionedRef;
  core_build_hash: string;
  supported_run_protocol_majors: number[];   // 第一版仅 1
  supported_executor_abi_majors: number[];   // 第一版仅 1
  registry_schema_version: number;
  database_schema_version: number;
}
```

- `Run Protocol` 约束 Graph lifecycle、Close/Cut、Receipt、Retry 与恢复语义；`Executor ABI` 约束 Core 与 Executor Worker 的通信；两者不是同一版本。Run Snapshot 同时保存 `run_protocol_major=1`、`executor_abi_major=1` 与 Core Build/DB Schema 元数据。
- Core/Feature Release 先进入 `staged`，升级器扫描所有 launchable Published refs 以及 active/closing/action-required/quarantined Run，验证新 Core 的 Protocol/ABI/Registry/DB Compatibility Matrix 后才允许原子激活新创建入口。
- 同一 Major 内只允许向后兼容的新增。未来 breaking v2 若仍有 v1 强引用，必须提供 v1 compatibility runner 或等待/可信取消旧 Run；第一版只预留门禁，不提前实现多 ABI Runner。禁止把旧 Run 自动迁移到新 Executor、Prompt 或 Protocol。
- 新 v1 baseline 投产后的 DB migration 使用 expand-first；旧 Run/旧协议引用归零前不能删除旧字段和语义。该规则只约束未来 Runtime/Core 升级，不要求把前置清理前的 Workflow execution/history 导入 v1 `workflow-runtime.db`。Core 降级也必须通过 DB/Protocol 兼容检查，不能只替换 App 二进制。

Artifact/Resource 至少存在三类强引用：

```text
Published Reference   仍可创建新 Workflow
Active Reference      active/closing/action-required/quarantined Run
Retention Pin         管理员调查或备份恢复窗口
```

Run 关闭事务释放 Active Retention Handle。只有三类强引用全部归零并超过 versioned replay/backup grace period 后，GC 才能删除可执行字节；Closed Run 长期保留 exact ref/hash、contract、closure manifest、evaluation summary 与 tombstone，但超过 replay retention 后不再声称可以重新执行旧代码。Reference Count 只作查询优化，权威清理由 DB roots 的 mark-and-sweep 决定。

Feature 生命周期固定为：

```text
enabled   -> 可以创建新 Workflow，旧 run 正常执行
draining  -> 禁止新建，Feature UI/API 可升级，旧 execution artifact 供 active run 收敛
disabled  -> active run/reference 已清零，不加载业务入口；审计 snapshot 仍保留
deleting  -> 满足 retention、无 active/published/pinned ref，并完成二次确认后清理 feature-owned data
```

`disable` 不能把 active run 变成只读僵尸。Force disable 必须先对全部 active Workflow 发 global cancel，等待 fence/required compensation/cut 收敛；quarantined/action-required run 未被可信处置前禁止删除依赖。Feature Renderer/Page 不需要为旧 Run 保留，但 Execution Artifact、Prompt Variant 与合同按强引用独立保留。Closed run 的审计 contract/blob retention 与 Feature projection/domain data deletion分别计算。

Prompt 自进化使用独立的 Base/Local Variant 模型，禁止改写 Feature Release 文件：

```ts
interface LocalPromptRevision {
  ref: VersionedRef;
  prompt_family_ref: VersionedRef;
  base_prompt_ref: VersionedRef;
  parent_local_ref: VersionedRef | null;
  content_ref: string;
  content_hash: string;
  prompt_contract_hash: string;
  evolution_reason_ref: string;
  evaluator_ref: VersionedRef;
  evaluation_result_ref: string;
  promoted_by_actor_ref: string;
  published_at_ms: number;
}
```

- Feature Publish 产生 immutable Base Prompt；自进化只生成 Candidate，必须通过受信任 Evaluator/Promotion Policy 后执行可审计的 Local Publish，才成为新 Run 可选择的 Local Variant。普通 Executor 不能直接修改 active prompt pointer。
- Prompt 分为受保护 section 与允许进化 section；permission、tool contract、安全约束、变量/输出协议不能由本地进化覆盖。Local Variant 存入 Runtime Registry/Value Store，不写回 `features/{featureId}`。
- Feature 升级遇到 `Base A + Local C + Base B` 时执行 Registry 层结构化三方 Rebase。Contract 相同可自动生成 Candidate 并使用新版 Evaluator 验证；Contract 改变必须迁移或重新进化，禁止直接继承。
- Rebase 未通过时，新 Feature 可以 staged，未受影响 Capability 可以激活；受影响 Capability 继续使用旧 Published execution/prompt，不静默丢弃 Local Variant。官方安全约束变更时受保护 section 以上游为准；用户也可以显式恢复官方 Base，同时保留 Local 历史。
- 任何 current/latest 指针只允许在受信任创建面解析并立即固化 exact ref/hash；Graph build/dispatch/recovery 永远不读取 latest。

### Feature Manifest vNext

Dynamic Runtime 使用 `icarus.feature-manifest/2`，不改变 Feature Package Runtime 对 Feature 启停、动态 API/nav/renderer 以及 `skills/agents/mcp/scripts/templates` 的既有职责。vNext 只是为新 Registry/Publisher 增加 closed、versioned 的发布合同；当前 Feature manifest 不能因文档存在这些字段而提前获得执行语义。

```ts
type FeatureWorkflowResourceKind =
  | 'recipe'
  | 'routing_scope'
  | 'routing_capability'
  | 'clarification_contract'
  | 'execution_policy'
  | 'definition'
  | 'command_policy'
  | 'operational_remediation_policy'
  | 'context_contract'
  | 'schema'
  | 'scope_interface'
  | 'graph_template'
  | 'graph_policy'
  | 'capability'
  | 'executor_implementation'
  | 'prompt'
  | 'tool_binding'
  | 'wait_contract'
  | 'notification_contract'
  | 'card_presentation'
  | 'artifact_contract'
  | 'evaluator'
  | 'root_finalization_policy'
  | 'outbox_policy';

interface FeatureManifestDependencyVNext {
  feature_release_ref: VersionedRef;
  feature_release_hash: string;
  required_resource_refs: VersionedRef[];
}

interface FeatureWorkflowResourceEntry {
  kind: FeatureWorkflowResourceKind;
  ref: VersionedRef;
  source_path: string;
  expected_source_hash: string;
}

interface FeatureManifestVNext {
  format: 'icarus.feature-manifest/2';
  feature_ref: VersionedRef;
  namespace: string;
  owner_principal_ref: string;
  dependencies: FeatureManifestDependencyVNext[];
  package_resources: {
    skills: string[];
    agents: string[];
    mcp: string[];
    scripts: string[];
    templates: string[];
  };
  extension_surfaces: {
    api_entry: string | null;
    nav_entry: string | null;
    renderer_entry: string | null;
  };
  dynamic_workflow_resources: FeatureWorkflowResourceEntry[];
  ownership: {
    feature_source_root: string;
    workflow_source_root: string;
    execution_bundle_owner: 'feature_release';
    registry_namespace: string;
  };
  lifecycle: {
    draining_policy_ref: VersionedRef;
    retention_policy_ref: VersionedRef;
    deletion_policy_ref: VersionedRef;
  };
  manifest_hash: string;
}

interface FeatureReleaseManifestVNext {
  format: 'icarus.feature-release-manifest/2';
  feature_ref: VersionedRef;
  release_ref: VersionedRef;
  source_manifest_hash: string;
  dependency_release_refs: Array<{
    ref: VersionedRef;
    hash: string;
  }>;
  published_resources: Array<{
    kind: FeatureWorkflowResourceKind;
    ref: VersionedRef;
    content_hash: string;
  }>;
  execution_artifact_ref: VersionedRef | null;
  execution_artifact_hash: string | null;
  renderer_artifact_ref: VersionedRef | null;
  renderer_artifact_hash: string | null;
  dependency_closure_ref: string;
  dependency_closure_hash: string;
  draining_policy_ref: VersionedRef;
  retention_policy_ref: VersionedRef;
  release_hash: string;
}
```

Source/Release Schema 对顶层、嵌套对象和每个 discriminated resource entry 都设置 `additionalProperties=false`；namespace、source root 与 resource ref 必须属于同一 Feature ownership boundary，依赖使用 exact release ref/hash，不接受 range、latest 或跨 owner path。Publisher 从 entry union 生成 dependency closure，不从目录名猜资源类型，并要求 Release Manifest 的 published resource set 与 closure/member hash 完全一致。没有 Executor 或 Renderer 的 Feature 可以将对应 ref/hash 成对置 null；一方非 null、另一方 null 必须拒绝。Feature release 进入 draining 时禁止由该 release 创建新 Workflow，但保留 active Run 固定的 Execution Artifact/Registry/Prompt/Card snapshot；retention/deletion 仍按 exact lifecycle policy 与强引用执行。

旧 `workflowDefinitions`、`cards`、`artifactContracts`、`workflowEvaluators` 字段在任何 manifest version 中都返回稳定 `feature_manifest_removed_resource_key`，不映射到 vNext resource kind，不提供 alias、fallback、自动转换或 compatibility reader。其他 unknown field 返回 `feature_manifest_unknown_field`。拒绝发生在资源扫描、路径读取和 Registry 写入之前。

### Authoring、Review 与 Publish 工作流

v1 不提供通用可视化 Workflow/Card 编辑器。Codex/Agent 与开发者通过同一 developer toolchain 把 Feature-owned source 转成可执行版本：

```text
scaffold -> validate -> compile -> dry-run -> review -> publish -> activate
```

标准 CLI 与同名 service API 固定如下；CLI 只是 API client，不直接写 Registry DB：

| Stage | CLI / API | 输入 | 成功输出与写边界 |
| --- | --- | --- | --- |
| scaffold | `icarus workflow scaffold` / `WorkflowAuthoring.scaffold` | Feature ref、resource kinds、namespace、template ref | 在 Feature-owned source root 创建 closed-schema skeleton 与 source manifest；不写 staging/Registry |
| validate | `icarus workflow validate` / `WorkflowAuthoring.validate` | source root、manifest hash | canonical source snapshot、ordered diagnostics、source hash、dependency requests；只读 source |
| compile | `icarus workflow compile` / `WorkflowAuthoring.compile` | validated snapshot/hash、toolchain/policy/safety refs | immutable staged plan/artifact、proof/program/closure hash 与 diagnostics；只写 authoring staging root |
| dry-run | `icarus workflow dry-run` / `WorkflowAuthoring.dryRun` | staged artifact/hash、synthetic input fixture、Fake Adapter profile | deterministic event/result/trace bundle 和 `active_registry_unchanged` proof；只写隔离 dry-run root |
| review | `icarus workflow review` / `WorkflowAuthoring.createReview` | source/plan/artifact/closure hashes、前一 published ref 或 null | human-readable source/hash/closure/permission/effect diff、diagnostics 和 immutable review request |
| publish | `icarus workflow publish` / `WorkflowPublisher.publish` | approved review ref/hash、staged artifact/hash、idempotency key | immutable Registry resources、Feature Release staged record 与 audit；不切换 active pointer |
| activate | `icarus workflow activate` / `FeatureRelease.activate` | staged release ref/hash、expected active release row version、idempotency key | compatibility preflight 后原子切换新创建入口并写 activation audit |

目录与 ownership 边界固定：authoring source 位于 `features/<featureId>/workflow-src/` 并归 Feature/Git 所有；派生 staging 位于忽略版本控制的 `local/workflow-authoring/staging/<sessionId>/`，按 source hash 隔离且不可执行；dry-run 位于独立临时 data/store root；Published resource 只存在于 `workflow-runtime.db` Registry 和 content-addressed Value/Blob Store。Runtime、Feature loader 和 production build 不能从 source/staging/dry-run path 执行或按 latest 读取。Source file 允许修改，staged artifact 按 hash immutable，Published `(type,id,version)` 永不原地修改。

所有 stage 使用同一 closed Error Catalog，输出按 stable pointer/code/object id 排序的 diagnostics。Review 必须同时展示 canonical source diff、source/plan hash diff、dependency closure member diff、permission/effect/claim/Safety diff、Executor/Card renderer bundle diff，以及新增/删除 launch surface；只看格式化文本 diff 不足以批准。首次发布没有 previous ref 时显示完整 closure。`dry-run` 强制使用 test-only Registry、Virtual Clock 和 Fake Adapter，连接 `query_only` Production Registry snapshot；结束时比较 active-release pointer hash、Published resource count/head 与 Runtime event head，生成三者未变化的 proof，任何变化都使 dry-run 失败。

`review` 只创建待批准事实，不能隐式 Publish。Production v1 只有 authenticated `human:local-owner` 可以批准，approval 绑定 source/plan/artifact/closure/review hash、Feature release ref、expiry 与 reviewer session；AI、Compiler、Publisher 不能批准自己的输出。Publish 按 `(feature_ref, release_version, artifact_hash)` 和调用方 idempotency key 幂等：相同请求返回原 staged release，不同 hash 冲突；任一步失败保留不可 launch 的 failed/staged audit并可用相同 key恢复，不能留下部分 Published closure。Activate 按 release ref/hash + expected current row version 幂等；preflight 失败保持旧 pointer，事务 crash 后只能全部切换或完全不变。

scaffold/validate/compile/dry-run/review 是开发工具，不是产品管理 API；它们不出现在 Runtime Center、Feature 用户页面或通用 Web route。未来若建设可视化工具，也必须调用上述 closed API 并遵守相同 source/staging/Publish/Activate 边界，不能恢复已删除的文件写入和直接 Registry mutation surface。

## Compiler

Workflow Definition Compiler、Scope Compiler 和 Static Lowerer 是不同信任边界，但共享 schema、canonical JSON、interface resolver、policy intersection 和 capability binding。

### JSON、Canonicalization 与 Hash

- Source IR、registry contract、typed input/output 和 wait payload 以 JSON Schema Draft 2020-12 为 dialect，但 Workflow Port 只允许 sound、受限的 `icarus.workflow-schema/1` Profile。对象默认 closed-world (`additionalProperties: false`)，`$ref` 只能解析到 pinned registry 中的精确 schema version，禁止 runtime network ref。
- Profile 第一版允许 `type/const/enum/properties/required/items`、closed object、数值/字符串/数组边界、固定 registry `$ref`、受约束 format/pattern，以及以固定 `const` 判别字段组成的 discriminated `oneOf`。禁止 `anyOf/not/if-then-else/$dynamicRef`、递归 ref、`patternProperties/dependentSchemas/contains` 与任意 `allOf`；需要继承时在发布阶段先归一化成普通 closed object。
- Schema 默认只有相同 `schema_hash` 直接兼容。不同 hash 必须由 versioned、sound 的 subtype 算法证明，覆盖 const/enum 集合、integer->number、区间、closed object、array 和 discriminated-union 分支；无法证明即 `schema_not_assignable`，不能乐观放行。重命名、合并、类型转换或版本升级必须使用显式 versioned deterministic system adapter Node。
- Data Edge JSON Pointer 默认必须在 Producer 的所有合法值中存在并推导出唯一兼容 Schema；允许缺失时必须显式 `on_missing='unavailable'`，且目标 aggregation 能处理 unavailable。第一版不根据 control condition 自动 narrowing union。
- JSON 内部寻址统一使用 RFC 6901 JSON Pointer。Condition、data edge 和 artifact binding 不接受 dotted path、JSONPath 或自定义混合语法。
- 输入使用能检测 duplicate object key 的 strict JSON parser；拒绝 duplicate key、`NaN`、`Infinity`、`undefined`、`BigInt` 和非 JSON 对象。结构字段数字必须是 JavaScript safe integer；高精度 decimal、money 和 64-bit integer 使用 string schema。
- Canonical JSON 使用 RFC 8785 JCS 和 UTF-8；不额外做 Unicode normalization，stable id 使用 ASCII pattern。Source hash 对 parsed source 做 JCS 并保留业务 array 顺序；Plan hash 使用 versioned canonical normalizer：object key 排序，nodes/edges/rules/allowlists/recovery-kind 等 set-like collection 按 exact stable key 排序，route priority、selector priority、input aggregation、item order 等有业务顺序的 array 保持原序。Canonical Normalizer version/hash 进入 compiler version 与 golden fixture。
- Hash 统一为 `sha256:<64 lowercase hex>`，并在 canonical bytes 前加入 object type/format domain separator，例如 `icarus:workflow-graph-source:1\n`、`icarus:workflow-graph-plan:1\n`、`icarus:workflow-graph-completion-cut:1\n`，禁止不同对象类型之间混用相同 payload hash。
- Parser、2020-12 Validator、Profile、format registry、assignability checker 和 JCS canonicalizer 的兼容版本进入 `compiler_version`；Validator 禁止 coercion、删除字段或写入 default。相同 compiler version、source、schema、interface、policy 和 catalog snapshot 必须产生逐字节相同的 plan/hash。

### Compiler Conformance Toolchain

#### Machine-readable Contract Pack

本文是评审权威，但实现不得从 Markdown 抽取类型、状态或错误码。Spec Stabilization 必须在 `src/workflow-runtime/contracts/` 提交 versioned、可由 CI 逐字节验证的 Contract Pack：

```text
src/workflow-runtime/contracts/
  schemas/                 Definition/Recipe/Command/Transition/Source/Compiled IR JSON Schema
  catalogs/                Error Catalog、Fact/Event taxonomy、domain separators、format registry
  protocols/               lifecycle/control/operational transition tables、T0-T8/T6e command tables
  safety/                  complete per-field Enforcement Matrix、Product Floor、Retention Policy
  sqlite/                  Logical Schema manifest source、typed relation metadata、query catalog
  conformance/draft/       raw cases + hand-authored semantic assertions
  conformance/sealed/      reviewed expected bytes/diagnostics/hash + bundle manifest
```

每个 artifact 具有 `format/ref/version/hash`；TypeScript 类型从同一 Schema/closed enum 生成或做 compile-time conformance check，禁止另写一份可漂移 union。CI 检查 Markdown 中列出的 format/error/fact/state 值均存在于 Contract Pack，Contract Pack 新增值也必须有正文语义、迁移影响和 fixture。Runtime 只加载 sealed/published Contract Pack，draft 只能用于开发测试。

第一版固定以下实现角色，不允许各模块自行选择替代库或复用现有零散 `canonicalJson`：

| 角色 | 固定实现 | 强制配置/边界 |
| --- | --- | --- |
| Strict JSON lexer/parser | `jsonc-parser` 的 token/visitor API + Core duplicate-key wrapper | `disallowComments=true`、`allowTrailingComma=false`；在对象 materialize 前按 object path 检测重复 key |
| Draft 2020-12 validator | direct dependency `ajv` v8 的 `ajv/dist/2020` entry + pinned `ajv-formats` | `strict=true`、`coerceTypes=false`、`useDefaults=false`、`removeAdditional=false`；禁用 remote/loadSchema 与非 pinned format |
| RFC 8785 JCS | direct dependency `json-canonicalize` | 必须通过 RFC 8785 官方 number/string/object vectors；只负责 JCS，不负责 set-like Plan normalization |
| Hash | Node `crypto` SHA-256 | 输入必须先加本文规定的 ASCII domain separator；输出为 lowercase hex |
| Property generation | dev dependency `fast-check` | seed、path、shrunk counterexample 和 tool version 都进入 CI artifact |

Production v1 的 G0 精确工具链基线固定如下；`package.json` 中这些 direct dependency 不使用 `^`/`~`，`package-lock.json` 固定全部 transitive version 与 integrity：

| Component | Exact version | Ownership |
| --- | --- | --- |
| Node.js | `24.18.0` LTS | Core Runtime/Compiler/CI identity |
| npm | `11.16.0` | `packageManager` 与 lock install identity |
| `better-sqlite3` | `12.11.1` | Runtime/DDL/certification identity |
| `jsonc-parser` | `3.3.1` | Runtime dependency |
| `ajv` | `8.20.0` | Runtime dependency；禁止 transitive Ajv v6 |
| `ajv-formats` | `3.0.1` | Runtime dependency |
| `json-canonicalize` | `2.0.0` | Runtime dependency |
| `fast-check` | `4.9.0` | Dev dependency |
| `@types/node` | `24.13.3` | Dev dependency |
| `@types/better-sqlite3` | `7.6.13` | Dev dependency |

Repository 使用内容为 `24.18.0` 的 exact `.nvmrc` 作为唯一 Node version-manager source；CI 通过 `node-version-file: .nvmrc` 加载同一 patch，`package.json.packageManager` 固定 `npm@11.16.0`。Agent Container 不进入 SQLite certification key，但它的 Executor Artifact 必须固定 `node:24.18.0-slim` 的 immutable image digest，不能保留 moving tag。Electron 内置 Node 只属于 API client，不是 Runtime Node identity。

依赖必须作为 direct dependency 由上述 exact package/lock integrity 固定，不能依赖 transitive Ajv v6 或 semver floating resolution。Repository wrapper、Workflow Schema Profile、format registry、subtype/proof algorithm 和 Plan normalizer 都是 versioned Core source；其源码 hash、Node/npm identity 与 package-lock hash 一并进入下列 Manifest。任何包版本、配置、wrapper source 或 runtime version 变化都产生新的 `compiler_version/toolchain_hash`，必须重跑全部 Golden Bundle；不能在旧 version 下静默改变输出。

```ts
interface LockedPackageRef {
  package_name: string;
  exact_version: string;
  lockfile_integrity: string;
}

interface WorkflowCompilerToolchainManifest {
  format: 'icarus.workflow-compiler-toolchain/1';
  ref: VersionedRef;
  node_runtime_version: string;
  npm_version: string;
  package_lock_hash: string;
  strict_json_parser: LockedPackageRef;
  json_schema_validator: LockedPackageRef;
  json_schema_formats: LockedPackageRef;
  jcs_canonicalizer: LockedPackageRef;
  strict_parser_wrapper_hash: string;
  workflow_schema_profile_hash: string;
  format_registry_hash: string;
  canonical_normalizer_version: string;
  canonical_normalizer_hash: string;
  proof_algorithm_version: string;
  proof_algorithm_hash: string;
  compiler_build_hash: string;
  toolchain_hash: string;
}

interface WorkflowCompilerDiagnostic {
  code: WorkflowCompilerErrorCode;
  phase: 'parse' | 'schema' | 'bind' | 'prove' | 'normalize' | 'hash';
  instance_pointer: string;
  schema_pointer: string | null;
  stable_object_id: string | null;
  detail_ref: string | null;
}

type WorkflowCompilerErrorCode =
  | 'json_syntax_invalid'
  | 'json_duplicate_key'
  | 'schema_unknown_field'
  | 'schema_profile_keyword_unsupported'
  | 'registry_ref_unpinned'
  | 'registry_ref_not_found'
  | 'graph_id_duplicate'
  | 'graph_endpoint_not_found'
  | 'graph_cross_scope_edge'
  | 'graph_dependency_cycle'
  | 'condition_type_mismatch'
  | 'condition_complexity_exceeded'
  | 'json_pointer_non_total'
  | 'schema_not_assignable'
  | 'route_group_ambiguous'
  | 'trigger_contract_invalid'
  | 'completion_contract_invalid'
  | 'early_completion_non_monotone'
  | 'early_completion_cancellation_unsafe'
  | 'capability_not_allowed'
  | 'policy_escalation'
  | 'quality_revision_contract_invalid'
  | 'quality_revision_effect_key_incompatible'
  | 'child_recipe_set_mismatch'
  | 'child_recipe_dependency_cycle'
  | 'runtime_safety_limit_exceeded'
  | 'compiler_integrity_mismatch';

interface WorkflowCompilerErrorCatalog {
  format: 'icarus.workflow-compiler-error-catalog/1';
  ref: VersionedRef;
  entries: Record<WorkflowCompilerErrorCode, {
    retryability: 'source_revision_required' | 'registry_revision_required' | 'never';
    default_phase: WorkflowCompilerDiagnostic['phase'];
  }>;
  catalog_hash: string;
}
```

Error Code、phase、pointer 和 stable object id 是权威输出；本地化 message 只是 Projection。多个 Diagnostic 必须按 `(instance_pointer, code, stable_object_id, schema_pointer)` 排序后 canonicalize，Ajv 的原始错误顺序或文本不得进入契约 Hash。

Compiler 编码前必须提交 Golden Draft Bundle，至少包含全部 raw source、完整 Registry/Policy/Safety 输入、hand-authored expected diagnostics/normalized semantic assertions 和 review owner；Draft 允许 positive case 的 expected Plan bytes/hash 暂为空，但不能用于 Publisher。Compiler 首次 publish/activation 前必须把全部必选 case 独立 seal 成 first-class Golden Conformance Bundle：

```ts
interface WorkflowCompilerConformanceBundle {
  format: 'icarus.workflow-compiler-conformance/1';
  toolchain_manifest_ref: VersionedRef;
  toolchain_hash: string;
  error_catalog_ref: VersionedRef;
  error_catalog_hash: string;
  cases: Array<{
    case_id: string;
    raw_source_bytes_ref: string;
    registry_snapshot_ref: string;
    interface_policy_safety_snapshot_ref: string;
    expected_source_hash: string | null;
    expected_plan_bytes_ref: string | null;
    expected_plan_hash: string | null;
    expected_proof_program_hashes: string[];
    expected_diagnostics: WorkflowCompilerDiagnostic[];
  }>;
  bundle_hash: string;
}
```

正例至少覆盖 static lowering、condition/route、wait、subgraph、expand、map、policy intersection、quality revision capability binding、不同 hash 的 sound subtype proof 与 static child closure；负例至少覆盖 duplicate key、unknown field、unsupported Schema keyword、unpinned/missing ref、cross-scope edge、dependency cycle、non-total pointer、assignability failure、policy escalation、quality revision 缺少 feedback schema/quality gate 或使用不兼容 effect key、ambiguous route、invalid completion 和 Child Recipe set/cycle。Definition negative fixture 还必须固定拒绝 Notification `delivery_requirement`、Child `creation_key_template` 等已删除字段，避免旧草稿合同重新进入 executable schema。Fixture 必须保存 raw bytes、完整 Registry/Policy/Safety 输入、预期 canonical Plan bytes、source/plan/proof/program hash；只断言“编译成功”不构成 conformance。Bundle hash 与 toolchain manifest 必须进入 Compiler 发布门禁和 Runtime compatibility preflight。

Golden seal 的 oracle 固定如下，避免生产实现给自己生成 expected output：

1. Positive expected normalized Plan JSON 由 Draft Author（Codex/实现者可以辅助）按 Contract Pack 手工提交，Negative diagnostics 同样手工声明稳定 code/pointer/object id；Production v1 唯一 Semantic Approver 固定为 `human:local-owner`，AI 与 Production Compiler 均不能批准自己的输出。
2. `golden-seal` 只允许调用 locked strict parser、generic JCS 和 domain-hash helper，不得 import production Compiler、Plan normalizer、assignability/proof 或 lowering module；它只对已审阅 expected bytes 计算 hash和打包。
3. CI/发布环境不提供 `--accept`、snapshot auto-update 或“以当前输出覆盖 expected”路径。变更 expected 必须创建新 Bundle version并 bump 受影响的 compiler contract version；只有 package/wrapper/runtime identity 变化才 bump toolchain version，只有 Run Protocol 语义变化才 bump protocol version。变更必须提交语义说明并显示完整 artifact diff。
4. 至少一个独立 conformance test 从 raw source 调用 production Compiler，再与 sealed bytes/hash 比较；另一个 test 直接验证 sealed artifact 自身 hash chain。两者不能共享生成 expected Plan 的代码路径。

```ts
interface GoldenSemanticReview {
  review_id: string;
  bundle_version: string;
  case_ids: string[];
  draft_manifest_hash: string;
  reviewer_actor_ref: 'human:local-owner';
  decision: 'approved' | 'changes_requested';
  checklist_version: string;
  notes_ref: string | null;
  notes_hash: string | null;
  reviewed_at_ms: number;
}
```

审核流程固定为 `Draft -> golden-review report -> human semantic decision -> immutable GoldenSemanticReview -> golden-seal -> CI replay -> Publish`。`golden-review` 只能从 expected source/Registry/Policy/Safety snapshot 生成可读 normalized Plan、diagnostic pointer 与前一 Bundle semantic diff，不得 import 或调用 Production Compiler/normalizer/lowerer/proof；`golden-seal` 必须验证 exact approved draft hash和全部 case coverage，拒绝 changes-requested、过期或部分不匹配 review。Review 可以逐 case 或按 case group 进行，但 Bundle Manifest 中每个 case 恰好被一个 approved review 覆盖。

Sealed Bundle 永不原地修改；错误 oracle 通过新 version 纠正，旧 Bundle 按 Published/Active/Run retention 保留。Production v1 的本地单用户信任边界不强制 GPG 或外部审批系统，Git commit hash、immutable review record、Release audit 与 `human:local-owner` approval 是充分证据；若未来扩展为多人/远程 Publisher，必须升级为独立双人或签名审批。

```ts
interface RegisteredWorkflowSchema {
  ref: VersionedRef;
  dialect: 'json-schema-2020-12';
  profile: 'icarus.workflow-schema/1';
  schema_hash: string;
  validator_version: string;
  profile_version: string;
}

interface DataEdgeCompatibilityProof {
  proof_algorithm_version: string;
  proof_algorithm_hash: string;
  producer_schema_hash: string;
  canonical_pointer: string | null;
  pointer_totality: 'total' | 'may_be_missing';
  derived_schema_hash: string;
  consumer_schema_hash: string;
  proof_rule:
    | 'identical_schema'
    | 'const_subset'
    | 'enum_subset'
    | 'numeric_range_subset'
    | 'closed_object_subtype'
    | 'array_item_subtype'
    | 'discriminated_union_subtype';
  proof_detail_ref: string;
  proof_detail_hash: string;
  proof_hash: string;
}

interface CompiledConditionProgram {
  normalized_ast: ConditionExpr;
  operand_schema_hashes: Record<string, string>;
  max_steps: number;
  program_hash: string;
}

interface CompiledTriggerProgram {
  normalized_expression: NodeTriggerSpec;
  referenced_edge_ids: EdgeId[];
  max_steps: number;
  truth_program_hash: string;
}

interface CompiledRouteGroup {
  id: string;
  from_node_id: NodeId;
  mode: 'all_matching' | 'first_matching';
  no_match: 'allow' | 'error';
  ordered_edge_ids: EdgeId[];
  group_hash: string;
}

interface CompiledControlEdge {
  id: EdgeId;
  from_node_id: NodeId;
  to_node_id: NodeId;
  outcome_match: NodeOutcomeMatch | null;
  condition_program: CompiledConditionProgram | null;
  route_group_id: string | null;
  priority: number | null;
  is_default: boolean;
  source_config_hash: string;
  compiled_edge_hash: string;
}

interface CompiledDataEdge {
  id: EdgeId;
  from: DataSourceEndpoint;
  to: { node_id: NodeId; port: PortName };
  guard_control_edge_id: EdgeId | null;
  canonical_pointer: string | null;
  pointer_tokens: string[];
  on_missing: 'error' | 'unavailable';
  producer_schema_hash: string;
  derived_schema: CompiledPortSchema;
  consumer_schema_hash: string;
  compatibility_proof: DataEdgeCompatibilityProof;
  source_config_hash: string;
  compiled_edge_hash: string;
}

interface CompletionMonotonicityProof {
  algorithm_version: string;
  classification: 'monotone';
  proof_detail_ref: string;
  proof_detail_hash: string;
  proof_hash: string;
}

interface CancellationSafetyProof {
  algorithm_version: string;
  covered_node_contract_hashes: string[];
  proof_detail_ref: string;
  proof_detail_hash: string;
  proof_hash: string;
}

interface CompiledCompletionRule {
  id: string;
  phase: 'early' | 'settled';
  normalized_fact_expression: CompletionFactExpr;
  fact_program_hash: string;
  max_steps: number;
  selector: CompletionCandidateSelector;
  selector_contract_hash: string;
  priority: number;
  monotonicity_proof: CompletionMonotonicityProof | null;
  cancellation_safety_proof: CancellationSafetyProof | null;
  rule_hash: string;
}

interface CompiledScopeCompletionPolicy {
  early_rules: CompiledCompletionRule[];
  settled_rules: CompiledCompletionRule[];
  no_match: 'error';
  early_close: 'cancel_and_fence_remaining';
  policy_hash: string;
}

interface CompiledComplexitySummary {
  node_count: number;
  control_edge_count: number;
  data_edge_count: number;
  max_source_fan_out: number;
  max_condition_steps: number;
  max_trigger_steps: number;
  max_completion_steps: number;
  max_reconcile_facts_per_ingress: number;
  max_frontier_bytes: number;
  summary_hash: string;
}
```

### Compiler 输入快照

- Exact `WorkflowCompilerToolchainManifest`、Error Catalog、Compiler build、Canonical Normalizer 与 Proof Algorithm ref/hash；进程实际 Node/package integrity 不匹配时拒绝编译。
- Winning Task Intake、Recipe Descriptor、Workflow execution policy 与 routing/creation decision ref/hash；Scope Compiler 不重新路由。
- Published workflow definition version 与 state config hash。
- Root/child Scope Spec canonical bytes/hash。
- Scope Interface、policy envelope、template、capability catalog 和 evaluator registry 的 version/hash snapshot。
- Scope input port schemas；compiler 不读取或按实际 input value 特化 plan。
- Inherited policy ceiling。Parent scope id、owner node id、child key、实际 input snapshot 和 ledger reservation 属于 materialization，不进入 plan。
- RuntimeSafetyCeilings canonical snapshot/hash；任何 compiler/business null limit 都不能移除它。

Compiler CI 必须先以实际 Toolchain 逐字节重放完整 Golden Conformance Bundle，再允许产生新的 published Plan。单个 fixture 的 raw source、Registry/Policy/Safety snapshot、expected diagnostics 或 expected Plan bytes/hash 任一不匹配都阻止发布；不得以更新 expected hash 的方式跳过 toolchain/algorithm version bump 和审查。

### 必须校验

- Strict JSON、duplicate-key rejection、closed schema、format revision、RFC 8785 canonical JSON、配置为非 `null` 时的 size/depth limit 和 stable id。
- Interface 精确匹配，所有 required input/exit output 均有 typed binding。
- Node/edge/route group id 唯一，所有 endpoint 和 port 存在。
- 每条 incoming control edge 恰好被 target trigger 引用。
- Condition 只引用合法 scope/source fact，类型可比较，AST steps 在 limit 内。
- Route group mode/default/priority/no-match 无歧义。
- Data aggregation、guard、schema、pointer 和 selection policy 合法；每条 Data Edge 生成结构化、versioned `DataEdgeCompatibilityProof`，每条 Condition/Trigger/Completion 生成 normalized typed AST、program hash 与复杂度摘要。Profile 复杂度受 routing schema safety ceilings 限制，unsupported keyword、unpinned ref、non-total pointer 与 complexity overflow 使用独立结构化错误码。
- Control、data、guard readiness dependency 并集为 DAG。
- Static template 引用无环；dynamic recursion 先受 finite safety ceiling 约束，再受对应 non-null nesting/scope/node/ledger business limit 收紧；null 不注入默认业务 ceiling。
- Node type、capability、template、interface 和 child policy 位于 effective allowlist。
- Retry、timeout、concurrency、wait、output 和 child request 不超过 inherited non-null business hard limits，也不能超过对应 runtime safety ceiling；业务 limit 为 `null` 时不注入默认业务 ceiling。所有 wait contract ref/kind/hash 位于 pinned registry snapshot 与 effective allowlist，有限 deadline 在 `max_wait_duration_ms` 非 `null` 时受其业务约束。
- Expand 的 `graph_spec_input_port` 必须是 required `single/only` port，schema 是 canonical `GraphScopeSpec` closed schema；Map 的 `items_input_port` 必须 seal 为 array，item schema 可赋值给 body interface 的 `item_child_input_port`，shared binding 必须完整满足其余 required child input。
- Completion rules 可达、selector 与 exit 合同一致，early predicate 单调且 effect cancellation 安全。`allow_early_close` 同时约束 scope early rules、map quorum `cancel_remaining` 和 `all_accepted/fail_fast`，不能通过结构节点绕过。
- Completion 的 early/settled rule id 在整个 scope 内唯一，priority、selector 和 phase 进入 canonical policy hash。
- 拒绝结构上可证明的 dead end，并证明 control/data/guard dependency 终将封闭；不要求 compiler 穷举所有 runtime data/outcome 组合。Runtime reconciler 在 fixed point 检测实际 quiescent dead end，并确定性创建 `engine_error/no_exit_selected` 或更具体的 `graph_deadlock`，不能让 scope 静默保持 active。Armed durable wait、active attempt、retry/build deadline 等具有明确未来唤醒源的状态不属于 quiescent。
- Dynamic source 不能覆盖 workflow owner、transition、Context Contract/Patch、final output binding、credential、mount、execution group 或 security scope。
- Workflow Definition Compiler 必须验证所有 transition target、entrypoint、normal/error/cancel route、trusted child-workflow Recipe allowlist、State bindings、typed Context Contract/Patch 与 Workflow execution policy；Publisher 必须证明每条 normal terminal path 都存在可赋值给 Recipe output schema 的唯一 binding，并验证 effect/permission/child-Recipe dependency closure。

### Compiled Scope Plan

```ts
interface CompiledScopePlan {
  format: 'icarus.workflow-graph-scope-plan/1';
  compiler_version: string;
  compiler_build_hash: string;
  compiler_toolchain_ref: VersionedRef;
  compiler_toolchain_hash: string;
  compiler_error_catalog_hash: string;
  canonical_normalizer_version: string;
  canonical_normalizer_hash: string;
  proof_algorithm_version: string;
  proof_algorithm_hash: string;
  plan_hash: string;
  source_hash: string;
  interface_snapshot_hash: string;
  policy_snapshot_hash: string;
  effective_policy_snapshot: WorkflowGraphPolicyEnvelope;
  capability_catalog_hash: string;
  wait_contract_catalog_hash: string;
  interface_snapshot: GraphScopeInterfaceContract;
  nodes: CompiledGraphNode[];
  route_groups: CompiledRouteGroup[];
  control_edges: CompiledControlEdge[];
  data_edges: CompiledDataEdge[];
  completion: CompiledScopeCompletionPolicy;
  complexity_summary: CompiledComplexitySummary;
  static_child_plan_closure_hash: string;
  effective_limits: NullableWorkflowGraphLimits;
  effective_usage_budget: NullableWorkflowUsageBudget;
  runtime_safety_snapshot: WorkflowRuntimeSafetyCeilings;
  runtime_safety_hash: string;
}
```

Plan 保存完整 effective business policy、runtime safety snapshot、Compiler/Toolchain/Error Catalog、Compiled Programs、Compatibility/Safety Proof、complexity summary 和 static child plan closure hash；hash 只是完整 canonical snapshot 的校验值，不能替代后续 child compile 所需的 allowlist、wait、effect、build、limit 和 safety 字段。`plan_hash` 对排除自身 hash 字段的 canonical payload 计算，并排除 instance id、actual input value/hash、ledger reservation、timestamp、lease 和运行状态。相同 source、input schema、interface、policy、safety、catalog 和 compiler 必须产生相同 plan hash，因此不同 map item 可以复用同一 plan。Actual input values 只在 scope materialize 时校验并写 instance input snapshot/hash 与 Run Manifest entry。

第一版 Runtime 直接解释 normalized typed AST，不引入自定义 bytecode。Runtime 禁止 recompile、re-prove、重新解析 Source Condition 或重新选择 Route 顺序；它只验证 Plan/Proof/Schema Snapshot 完整性以及实际 Value 的 schema/hash/pointer/byte-length。Source Snapshot 仅用于审计，执行唯一来源是 pinned Compiled Plan。Plan、Proof、Program 或 algorithm hash 缺失/不匹配属于 integrity violation，进入 quarantine，Recovery 不得重新生成并覆盖旧结果。

Parent compile 同时产生所有 inline/template static factory 的 content-addressed child plan closure；`CompiledStaticScopeFactoryBinding.precompiled_plan_hash` 必须指向该 closure。T2a 原子保存 parent plan 及缺失的 static child plans；subgraph/map build 直接绑定 pinned precompiled plan，只有 expand 才编译运行时冻结的 candidate spec。

下文 [T1 activation ingress](#事务边界与-cas) 会先创建 `lifecycle=materializing, plan_id=NULL` 的 root scope shell，因此 root snapshot/compiler failure 仍有合法 scope 挂载 engine-error close request/cut，并终结同一个 root run。Subgraph/expand 的 single child build failure 不创建 child scope，直接终结 owner node 为 failed；map item build failure 则原子填写该 item 的 `errored/scope_id=null` result slot 并重新计算 map policy，不能提前 terminalize 整个 map owner。任何 compile failure 都不能部分 materialize executable node。

## Graph 与 Node 状态模型

Run 和 Scope 将执行生命周期与控制状态拆成正交字段：

```ts
type RunLifecycle = 'initializing' | 'executing' | 'closing' | 'closed';
type RunControl = 'running' | 'paused' | 'resuming' | 'cancelling';
type RunOperationalState =
  | 'healthy'
  | 'action_required'
  | 'quarantined'
  | 'administratively_abandoned';

type ScopeLifecycle = 'materializing' | 'active' | 'closing' | 'closed';

type NodePhase =
  | 'pending'
  | 'ready'
  | 'active'
  | 'waiting'
  | 'retry_wait'
  | 'terminal';
```

- Lifecycle 只向前推进；run control 可以 `running -> paused -> resuming -> running`，或从非 closed 状态单向进入 `cancelling`。Scope 不复制 pause/cancel 的全局控制真相，而是读取 run control 并使用自己的 `work_fence_epoch` 拒绝旧普通工作。
- Workflow-level pause 是 scheduling barrier，不是结果丢弃或物理 cancel。它传播到整棵 scope tree，停止新 claim、scope materialize和尚未 dispatch 的外部 execution，但 active completion、signal/timer/timeout、terminal fact、edge resolution、trigger/input seal、`ready/skipped` 与 early eligibility 仍可持久化；pure build 可以保存到 `compiled`，已 ready 的下游在 resume 前不启动。Absolute deadline 和 retry eligibility 不因 pause 延长。
- Resume 先 CAS `paused -> resuming`；`resuming` 仍禁止 claim/materialize/dispatch，并可通过多个短事务按 durable error/eligibility/fixed-point 顺序收敛暂停期间的事实。只有不存在待处理 close/error 且 run 仍需执行时才 CAS 回 `running`。Crash 留在 `resuming` 时由 recovery 继续 drain，不能提前开放 scheduler。
- Wait node 自身 waiting 不改变 run control，也不使 scope 进入 closing。
- Scope early completion 进入 `closing` 并 fencing remaining work；完成后进入 `closed`。
- Scope close 必须在同一事务递增目标 scope 及其全部已存在 descendant scope 的 `work_fence_epoch`；root close 还递增 run `work_fence_epoch`。Attempt、wait、build、controller 与 child-result publisher 都必须比较创建时保存的 run/owner-scope work epoch，不能只检查自身 lease。Pause 不递增 work epoch。
- Run 只有 root scope 完成后才进入 `closed`。
- Operational state 与 lifecycle/control 正交。`action_required` 只允许受限 remediation command；`quarantined` 和 `administratively_abandoned` 都禁止 scheduler/state progression。`action_required/quarantined` 不是可任意切换的展示状态，必须由 `workflow_operational_blockers` 的 open severity 派生并通过 T6e 原子恢复；恢复为 `healthy` 不改变 lifecycle/control/work fence。Administrative abandon 归档 Workflow，但不把不可信 run 伪造成 `closed`，因此不需要伪造 completion cut。
- Root run 在首次外部 cancel CAS 时冻结 `root_cancel_scope=local_graph|workflow`；每个 child scope 的 normal/error/parent-close 原因由自身唯一 close request 保存。不同 child 可以并发 parent-close，不能复用一个 run-level 枚举。

Node outcome：

```ts
interface GraphNodeTerminalOutcome {
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  code?: string;
  child_exit?: ExitName;
}
```

Skip code 至少区分 `route_not_selected`、`input_unavailable`、`early_close`、`manual_skip` 和 `parent_cancelled`。Quality 相关 failed code 至少区分 evaluator 明确不可修订的 `quality_rejected`、最后一次合法 evaluation 仍为 needs-revision 且已达到 effective Node Attempt ceiling 的 `quality_revision_exhausted`、Evaluator/feedback 不符合 pinned contract 的 `evaluation_contract_violation`，以及 Node 尚可修订但 `run.max_attempts_total` 共享额度已被其他工作消费的 `attempt_budget_exhausted`。Workflow deadline 仍走全局 watchdog/cancel，不伪装成这些 Node failure。Node terminal 后不重新打开；retry/revision 创建新 attempt，graph-level rerun 创建新 activation/root run。

## Resource Ledger 与调度

初始节点集合无法覆盖 runtime expansion/map，因此不能用 `sum(max_attempts)` 代替预算执行。Ledger 是唯一资源事实源：

```text
workflow_graph_resource_accounts
  - id
  - deployment_scope_ref/workflow_id/graph_run_id/scope_id/node_id/
    execution_group_ref
  - resource_type        state_activations_total | graph_runs_total |
                         state_transitions_total | child_workflows_total |
                         descendant_workflows_total |
                         scopes_total | nodes_total | edges_total | map_items_total |
                         builds_total | build_attempts_total | attempts_total |
                         evaluator_attempts_total | waits_total |
                         effect_operations_total | facts_total |
                         logical_output_bytes_total | stored_bytes_total |
                         active_waits | active_executions |
                         optional: input_tokens_total | output_tokens_total |
                                   tool_calls_total | cost_micros_total
  - hard_limit           effective finite ceiling；取 runtime safety ceiling 与全部 non-null business limits 的最小值
  - reserved_amount
  - consumed_amount
  - row_version

workflow_graph_resource_reservations
  - id
  - graph_run_id/reservation_group_id
  - consumer_workflow_id/consumer_build_id/consumer_scope_id/consumer_node_id/
    consumer_attempt_id/consumer_wait_id/consumer_effect_id/consumer_fact_id
  - resource_type
  - purpose
  - settlement_mode      consume_on_create | hold_then_release | incremental
  - reserved_remaining/consumed_amount
  - status               held | committed | released
  - created_at_ms/settled_at_ms/row_version

workflow_graph_resource_reservation_postings
  - reservation_id/account_id
  - reserved_remaining/consumed_amount
  - status/row_version

workflow_graph_resource_ledger_entries
  - id
  - graph_run_id/ledger_seq
  - reservation_group_id
  - account_id/reservation_id
  - operation            reserve | commit | release | charge
  - delta_reserved/delta_consumed
  - idempotency_key
  - previous_chain_hash/chain_hash
  - created_at_ms

UNIQUE over the non-null typed account scope + resource_type
UNIQUE over graph_run_id + the non-null typed consumer + resource_type + purpose
UNIQUE(reservation_id, account_id)
UNIQUE(idempotency_key)
UNIQUE(graph_run_id, ledger_seq)

workflow_graph_scheduler_admissions
  - admission_seq INTEGER PRIMARY KEY AUTOINCREMENT
  - graph_run_id/scope_id/node_id/attempt_id
  - eligible_event_seq
  - execution_reservation_id
  - capacity_config_hash/runtime_supported_limits_hash
  - created_at_ms
```

- Account 表示额度作用域，Reservation 表示具体消费者；两者都按 SQLite 关系展开规则使用 typed columns + exactly-one CHECK。Map 使用 `node_id` account scope，不增加 map owner 类型；原 `target group` 统一改成 Capability Catalog 固定的 versioned `execution_group_ref`，Planner/Source 不能选择 group 规避容量。Executable DDL 为每个 typed scope/consumer 建对应 partial UNIQUE index，不能把本行的紧凑说明实现为 expression 拼接 key。
- 一个 Reservation 通过 Posting 在同一事务 CAS 全部相关 Account，例如 deployment/workflow/run/scope/map-node/execution-group。任何 Account 不足则全部不变，不能部分占额。主错误按 `deployment -> workflow -> run -> scope -> node -> execution_group -> account_id` 固定顺序返回 `resource_limit_exceeded` 及 hard/reserved/consumed/requested。
- Account `hard_limit` 是对应 pinned runtime safety ceiling 与所有 non-null business limits 的最小值，因此受 Ledger 管理的结构资源始终 finite。业务 limit 为 `null` 只表示不额外收紧 safety ceiling，不会把 effective `hard_limit` 变成 `null`。Live deployment capacity 单独由 Scheduler admission 执行，暂时不足只 backpressure；`tokens/tool_calls/cost_micros` 只在显式配置 finite business budget且执行网关可可靠归集时创建 account。
- Ledger entries 是事实源；account counters 是可从 hash chain 验证和重建的 cache。Run 保存 `ledger_seq/ledger_head_hash`。
- 一个 logical admission 使用 `reservation_group_id` 聚合，但每种 resource 都创建独立 reservation；不能用一个 header status 同时表示永久 attempt 消费、可释放 executor slot和其他增量 charge。
- Materialize scope 时分别创建并 commit `scopes_total/nodes_total` reservation。
- 创建 Scope Build 时 commit `builds_total`，每次 acquisition/compile attempt 另行 commit `build_attempts_total`，其 hard limit 来自 `run.max_build_attempts_total`；两者不能共用一个 counter。Build 即使失败或被 fence 也不回退累计次数。
- T0/T1/T8 创建 activation、root run、transition 或 direct child workflow 时分别在 Workflow account commit `state_activations_total/graph_runs_total/state_transitions_total/child_workflows_total`；Terminal activation 只消费 activation，非 terminal activation 同时消费 activation/run。每个 descendant creation 还在 root-workflow lineage account commit `descendant_workflows_total`，这些累计额度跨 run/parent completion 不释放。
- T2b materialize 前按 control + data edge 总数 commit `edges_total`；Seal Map Expansion Manifest 前按 frozen item count commit `map_items_total`。额度不足时整个 materialization/seal 失败，不得留下部分 Node/Edge/Slot。
- 创建 attempt 时 commit `attempts_total`，并为执行期创建 held `active_executions` slot；attempt terminal/fenced 后释放 slot。
- 每次真正开始 evaluator invocation 前 commit `evaluator_attempts_total`；同一 Agent/Action Attempt 上的 evaluator retry 不重复执行 Agent，但仍逐次计 evaluator attempt。
- 持久化 quality revision feedback/envelope/exhaustion detail 前按 immutable Value 实际 byte length 预留并计入 `stored_bytes_total`，feedback 同时受 compiled `effective_max_feedback_bytes` 限制；这些审计/continuation Value 不计 `logical_output_bytes_total`。只有最终 pass 发布的 NodeOutputEnvelope 按 logical output 计费。
- Arm wait 时 commit `waits_total` 并 hold `active_waits`；wait terminal 后只释放 `active_waits`，累计次数不会回退。
- 创建 Effect Intent/Outbox operation 前 commit `effect_operations_total`。每条进入 T3 deterministic fixed-point queue、可能派生 Graph 状态变化的 durable ingress/derived fact 在写入前 commit `facts_total`；纯 Projection、Trace、Notification delivery 等审计事件不计 Fact，而由各自 finite attempt/duration/retention/byte ceiling 控制。
- Persist output 前预留 bytes，实际值小于 reservation 时释放差额。
- Map 必须先冻结 item count，再批量或按窗口预留 child scope/node quota；额度不足时确定性失败，不能半创建而不记录 remaining set。
- Map 窗口反复调整同一个 `(consumer_node_id=map_node_id, resource_type, purpose)` incremental reservation，并用新的 ledger idempotency key 记每次 reserve/commit/release；不能为同一 node/resource/purpose 创建第二个 reservation 绕过 typed partial UNIQUE。
- Concurrency admission 统一为 `active_executions` held-slot reservation，并同时检查 workflow/run/scope/map-node/execution-group pinned account 与 deployment live capacity；lease 过期本身不释放 slot，恢复器必须先 fence/settle 对应 execution。
- Graph Ledger 强制管理 Graph 自身创建的 scope、node、attempt、wait、active execution/wait、output 和 effect 资源。Tool allowlist、单次 Agent tool limit、单次模型 token limit 与 credential permission 继续由现有 Agent/Tool/Model Runtime 执行，Graph Runtime 不建设第二套拦截器。
- `tokens/tool_calls/cost_micros` 仅在 effective `usage_budget` 对应字段非 null，且现有 gateway 能以 provider usage id 可靠归集到 run/attempt 时创建 optional incremental account；Graph 复用 gateway usage，不重新计数。无法可靠归集或实时阻断的外部用量只能保存 usage summary，不能声称 hard enforcement。
- Attempt、scope 和 node 等累计资源在创建时 commit，不会因失败或关闭释放。
- Reservation、instance creation 和 event 必须在同一事务提交，防止 crash 后资源漂移。
- 每个 Account 强制 `reserved_amount >= 0`、`consumed_amount >= 0`、`reserved_amount + consumed_amount <= hard_limit`。Ledger entry 是事实源，Account counter 是可重建缓存；`reserve/commit/release/charge` 后的 Posting 汇总必须与 counter 完全一致。

调度器按以下顺序 reconcile：

```text
resolve terminal node outputs
  -> resolve outgoing control route groups atomically
  -> resolve guarded and unguarded data edges
  -> evaluate trigger with three-valued logic
  -> seal input ports deterministically
  -> ready / skipped / error
  -> claim ready node with CAS + ledger reservation + lease
  -> execute outside transaction
  -> persist attempt/wait/child result
  -> publish logical output and repeat
  -> evaluate completion rules
```

Scheduler 只决定 ready node 何时获得本机 execution slot，不改变 route/completion 语义。Root effective `max_concurrency` 约束整个 Graph Run；Child Policy 的 `max_concurrency` 约束对应 Child Scope subtree。一个 descendant execution admission 必须在同一 Reservation Group 同时 Posting 到 Run、当前/所有声明更严格 subtree limit 的 ancestor Scope、Map owner、Capability execution group 和 deployment live capacity，任一不足都保持 Node ready/backpressure，不产生 engine error。本机 executor capacity 是运行环境物理容量，不属于隐藏的 Workflow limit。符合 policy 的 ready nodes 先按 Workflow Run 做持久化 round-robin：优先 `last_admission_seq` 最小或从未获得 slot 的 run；run 内按 `(eligible_event_seq ASC, scope_manifest_seq ASC, node_key ASC)` 选择。每次成功 claim 在同一事务分配 global admission seq、更新 run `last_admission_seq`、reserve slot 并写 admission event，restart 后不能丢失公平游标。Graph Source 不提供 scheduler priority；route group 的 `priority` 只控制条件匹配顺序。Armed wait 可以占 `active_waits` account，但不占 `active_executions` slot。

## Durable Domain Resource Claims

Graph Ledger 管理 Graph 自身资源，但 PM workspace、deliverable、prompt target、Git branch 或其他外部领域对象需要跨 Workflow 互斥。Recipe 的 `resource_claims` 从已通过 input schema 的 frozen task input 解析 claim key；raw string、Graph Spec 和 Planner 不得直接提供最终 key。

```text
workflow_domain_resource_claims
  - id
  - namespace/key_hash
  - mode                         shared | exclusive
  - owner_workflow_id/recipe_ref
  - source_intake_id/creation_key
  - fencing_token                shared 时为 null；exclusive 时固定
  - status                       held | release_pending | released
  - acquired_at_ms/released_at_ms/row_version

workflow_domain_resource_heads
  - namespace/key_hash
  - current_fencing_token
  - row_version

UNIQUE(owner_workflow_id, namespace, key_hash)
UNIQUE(namespace, key_hash)
INDEX(namespace, key_hash, status, mode)
```

T0 创建事务必须在插入 Workflow 前原子检查 shared/exclusive compatibility并写 held claim；冲突返回结构化 `resource_busy` 与现有 owner，不允许先创建 Workflow 再异步抢锁。Shared Claim 只授权读取且不递增 token；mutation 必须持有 exclusive Claim。Exclusive acquire 以 CAS 递增资源头的 `current_fencing_token` 并把新 token 固定到 Claim。Claim 不因进程 lease、pause、human wait 或普通 worker crash 自动过期；只在 Workflow normal/error/cancel terminal、可信 remediation 或 administrative abandon policy 明确允许时释放。

正式 mutation 不能由 Worker 直接写目标资源。Worker 只能写 staging/shadow；受信任 mutation gateway 在最终 promote/commit 前必须同时验证 `claim.status=held`、`mode=exclusive`、owner Workflow、namespace/key 与 `claim.fencing_token=resource_head.current_fencing_token`。Release 后旧 Claim 即因 status 失效，即使尚无新 holder 也不能写。一个 effect 的全部 required claim slot 在 intent transaction 中原子解析；缺少任一 slot 都不得 dispatch。

第一版 Claim 只允许在 T0 根据可信 Task Input 获取。Graph 只能选择 Recipe 已获得的逻辑 claim spec id，不能在运行时发现 raw key 后动态抢锁；需要修改新资源时，由 trusted transition 创建使用新 Recipe/T0 的 child Workflow，避免动态多资源加锁和死锁。Recipe 应使用最细业务 key，避免一个长时间 human wait 用 workspace 全局锁阻塞无关 package。

同一 `creation_key + creation_intent_hash` 重放若已存在 Workflow，返回原 Workflow 和原 claims；同 key 不同 intent 必须返回 `idempotency_conflict`，不得静默复用旧 Workflow，也不得因为当前 claim 冲突创建第二个实例。Claim acquisition/release、Workflow lifecycle event 和 outbox effect 使用稳定 idempotency key。运行中心必须展示 owner、key summary、mode、token、held duration 和解除条件，但不得泄露 secret key material。

## 持久化字段、时间与 SQLite 约束

所有权威时间使用 SQLite `INTEGER` 保存 UTC Unix milliseconds。Absolute instant 统一后缀 `_at_ms`；持续时长按语义使用 `_duration_ms`、`_timeout_ms`、`_backoff_ms`、`_ttl_ms` 或 `_age_ms`。权威 DDL 禁止 `created_at`、ISO string、秒级 Unix timestamp、SQLite `CURRENT_TIMESTAMP` 与含义不明的 `timestamps` 缩写；ISO 8601 只在 API、运行中心 Projection 与日志展示时生成。

Runtime 通过可注入 `RuntimeClock` 获取生产 UTC epoch；一个权威事务只读取一次 `txn_now_ms`。Provider 自报时间必须命名为 `provider_occurred_at_ms`，只用于审计，不能决定 Signal/Timeout/Completion 仲裁。Runtime 保存最近 scheduling watermark 并对明显时钟回拨/跳变写 operational warning，但不修改已冻结 deadline；事实顺序始终使用 `event_seq/inbox_seq`。

字段语义固定：

| 后缀/字段 | 唯一含义 |
| --- | --- |
| `row_version` | 可变行 Optimistic CAS，每次状态修改递增 |
| `revision` | 不可变业务修订号 |
| `epoch` | Fencing generation，使旧工作永久失效 |
| `seq` | Append-only stream 严格顺序 |
| `*_no` | 同一 owner 内逻辑序号，例如 attempt_no |
| `*_count` | 累计数量，不表达顺序 |

原 `workflow_graph_runs.control_epoch` 删除：Pause/Resume 使用 `control + row_version` CAS；Close/Cancel 使用 `work_fence_epoch`；Worker Ownership 使用 lease token。若未来需要调度代数，必须新增语义明确、具有完整递增/校验协议的 `scheduling_generation`，不能保留未使用通用 epoch。

每个 enum/status 必须由 SQLite `CHECK` 执行，不能只靠 TypeScript；terminal/outcome/timestamp 组合也必须在 DDL 中约束。示例：

```sql
CHECK (control IN ('running', 'paused', 'resuming', 'cancelling'));
CHECK (operational_state IN (
  'healthy', 'action_required', 'quarantined', 'administratively_abandoned'
));
CHECK (row_version >= 0);
CHECK (work_fence_epoch >= 0);
CHECK (
  (lifecycle = 'closed'
   AND completion_cut_id IS NOT NULL
   AND outcome_kind IS NOT NULL
   AND finished_at_ms IS NOT NULL)
  OR
  (lifecycle <> 'closed' AND completion_cut_id IS NULL)
);
CHECK (
  operational_state <> 'administratively_abandoned'
  OR (lifecycle <> 'closed' AND completion_cut_id IS NULL AND outcome_kind IS NULL)
);
```

`normal` outcome 要求 exit/output 合同字段，`errored` 要求 error code/ref，`cancelled` 要求 cancel reason；互斥字段必须为空。Wait、Attempt、Build、Retry、Outbox、Blob Intent 各自声明 status/time CHECK，例如 armed wait 必须具有 `armed_at_ms`，scheduled retry 必须具有 `eligible_at_ms`。Boolean 使用 INTEGER 并 `CHECK(value IN (0,1))`；count/seq/epoch/length 非负，attempt_no 从 1 开始；timestamp/duration 必须是 JS safe integer，绝对 deadline 加法必须检查溢出。

只为 Scheduler、Watchdog、Recovery、GC/Retention 的实际扫描建立 partial/composite index，不给所有 `created_at_ms` 盲目建索引：

```sql
CREATE INDEX idx_workflows_deadline
ON workflows(deadline_at_ms, id)
WHERE finished_at_ms IS NULL AND deadline_at_ms IS NOT NULL;

CREATE INDEX idx_attempt_execution_deadline
ON workflow_graph_node_attempts(execution_deadline_at_ms, id)
WHERE phase = 'running';

CREATE INDEX idx_retry_due
ON workflow_graph_retry_schedules(eligible_at_ms, id)
WHERE status = 'scheduled';

CREATE INDEX idx_wait_deadline
ON workflow_graph_waits(deadline_at_ms, id)
WHERE status = 'armed' AND deadline_at_ms IS NOT NULL;

CREATE INDEX idx_outbox_due
ON workflow_outbox(next_attempt_at_ms, id)
WHERE status IN ('pending', 'reconciling');

CREATE INDEX idx_attempt_lease_expiry
ON workflow_graph_node_attempts(lease_expires_at_ms, id)
WHERE lease_owner IS NOT NULL;

CREATE INDEX idx_outbox_lease_expiry
ON workflow_outbox(lease_expires_at_ms, id)
WHERE status IN ('processing', 'reconciling');

CREATE INDEX idx_pending_signal_expiry
ON workflow_graph_inbox_events(expires_at_ms, inbox_seq)
WHERE disposition = 'pending';

CREATE INDEX idx_blob_intent_expiry
ON workflow_blob_write_intents(lease_expires_at_ms, id)
WHERE status IN ('preparing', 'installed');
```

以下持久化清单是 Normative Logical Schema：字段名、状态值、唯一性、关系与事务语义具有约束力，但 `a/b/c` 行是多个独立列的紧凑写法，代码块本身不是可直接交给 SQLite 的 `CREATE TABLE`。不得把逻辑清单误称为 executable DDL，也不得再用 `version/timestamps`、`lease owner/token/expires_at` 等草稿缩写代替真实列。

### Executable DDL Gate

实现 `WorkflowRuntimeStore` 前必须先从本文 Logical Schema 冻结一份 canonical `workflow-runtime-schema-v1`，并满足以下阻塞门禁；DDL 未通过时不得开始 Store、Reconciler 或发布 production Domain Definition：

1. Canonical migration 必须为每个 Logical Schema 对象展开完整 `CREATE TABLE/INDEX/TRIGGER`，明确 SQLite type、`NOT NULL`、default、enum/status CHECK、terminal 字段组合 CHECK、JS safe-integer CHECK、PK、全部单列/复合 FK、UNIQUE 与 Partial Index。禁止 `error fields`、`ref/hash` 或隐含 nullable 等缩写进入 migration。
2. Schema Manifest 逐表列出 column/type/nullability/default、PK/UK/FK/CHECK/index，并计算 domain-separated `schema_hash`。TypeScript contract、Store query、RuntimeSupportedLimits certification 和 Core compatibility record 必须固定同一 hash；文档清单与 Manifest 不一致时以发布失败处理，不能由 Store 猜测。
3. CI 必须在空的真实文件 SQLite 上先按 `SQLiteExecutionProfile` 设置 database-level `page_size/auto_vacuum`，再按顺序执行 migration、切换 WAL 并关闭连接；重新打开后通过 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`，并逐项验证 `journal_mode/synchronous/foreign_keys/busy_timeout/page_size/auto_vacuum/temp_store/wal_autocheckpoint/journal_size_limit/cache_size/mmap_size/trusted_schema/recursive_triggers/read_uncommitted/locking_mode/query_only`。同时校验 `sqlite_version()/sqlite_source_id()`、排序后的 compile options hash、`better-sqlite3` version/native module hash 与 Node runtime version；任一不匹配都使 DDL Gate/Certification 失败。随后从 `sqlite_schema` 与 `pragma_table_info/foreign_key_list/index_list` 重建 Manifest 并逐字节匹配发布快照。
4. Constraint fixture 必须证明每个 enum 非法值、负数/溢出时间、Activation `active/completed/abandoned` 与 `finished_at_ms/state_type/graph_run_id` 的非法组合、Workflow business status/operational state 非法组合、Operational Blocker zero/multi-source 与非法 resolution 组合、typed relation zero/multi-target、Attempt initial/non-initial continuation、parent 同 Node/相邻序号、quality-feedback ref/hash nullability 与单后继的非法组合、terminal 字段互斥错误、cross-run/cross-scope FK、重复 idempotency key、第二个 root scope/cut/close request 和 stale composite lineage 均由 SQLite 拒绝，而不是只由 TypeScript 拒绝。
5. Query-plan fixture 对 Scheduler、Watchdog、Recovery、Operational Blocker/T6e、T3/T7、Root Finalization、GC 和 Outbox 的固定查询运行 `EXPLAIN QUERY PLAN`，断言使用认证 index。任何 Logical Schema 新字段或状态变更必须先更新 migration、Manifest、fixtures 和 `database_schema_version`，再更新 Runtime 代码。
6. 首个可执行 migration 的验收包括本文所有持久化对象，不能只建 Graph happy-path 表；Intake/Creation、Registry/Retention、Value/Blob/typed ownership、Ledger/Claim、Workflow/Activation/Transition/Root Finalization、Run/Scope/Node/Fact/Operational Blocker、Inbox/Outbox/Effect、Command/Confirmation/Audit 和 Checkpoint 同属 v1 原子交付边界。

当前文档中的 SQL index 示例必须引用 Logical Schema 实际存在的列。例如 Workflow deadline 位于 `workflows.deadline_at_ms`，不得在没有该列的 `workflow_graph_runs` 上建索引；Outbox due index 同时覆盖 `pending/reconciling`。DDL Gate 的 empty-database smoke test 必须在提交首个 Runtime Store patch 时先落地并作为后续实现的前置依赖。

### SQLite 关系展开规则

Executable migration 不得照抄 Logical Schema 中为了阅读压缩的 `kind/id`、`ref/hash` 或 `error fields`。首版固定采用以下关系表达规则：

1. **内部多类型目标**：只要候选目标属于 `workflow-runtime.db` 权威表，就为每种目标建立独立 nullable typed FK 列，并用 exactly-one/at-most-one CHECK 约束。例如 Value ownership 使用独立的 `owner_workflow_id/owner_graph_run_id/owner_registry_resource_id/owner_feature_release_id/system_owner_ref`；v1 Command target 只使用 `workflow_id/run_id/node_id/retry_schedule_id/effect_operation_id/operational_blocker_id`，并以 closed command-to-target CHECK 固定映射。`owner_kind/owner_id`、`target_kind/target_id` 只能作为可重建 projection，不能成为权威关系。
2. **外部稳定引用**：Principal、Provider Event、Credential、immutable external locator 等数据库外对象使用语义明确的 `principal_ref/provider_event_id/credential_ref/immutable_external_locator`，并在需要时同时保存 contract/hash/authorization snapshot。它们不是 SQLite FK，Schema Manifest 必须标记 `external_ref=true`，不能伪装成已执行参照完整性。
3. **Value ownership**：`workflow_values` 只保存 payload/schema/provenance metadata；新增 `workflow_value_ownerships` 一对一表保存上述 typed owner columns和 exactly-one CHECK。Registry、Release、Retention、Backup、Manifest membership 继续使用各自领域表与真实 FK，不通过通用 Value owner 反向替代领域关系。
4. **Retention root**：`workflow_registry_retention_handles` 把 `root_kind/root_id` 展开为 `feature_release_id/graph_run_id/backup_id/external_actor_ref`；前三者为真实 FK，`external_actor_ref` 只允许 `manual_pin/investigation` 并由 Command Actor snapshot 证明。Handle CHECK 必须保证与 `handle_kind` 匹配且恰有一个 root。
5. **错误与摘要字段**：所有 `error fields` 统一展开为 `error_code TEXT`、`error_detail_value_id TEXT`、`error_detail_hash TEXT`；detail 两列同 null/非 null且 Value FK/hash 一致。Attempt 的紧凑行固定展开为 `retry_reason_code/error_code/error_detail_value_id/error_detail_hash/usage_summary_value_id/usage_summary_hash`；Build 的 `error_json` 删除并使用同一 error detail 合同。不得新增任意 raw exception text 作为权威错误语义。
6. **`ref/hash` 展开**：内部 Value 使用 `*_value_id/*_hash` 并建立复合或触发校验；Registry resource 使用 `*_resource_id/*_resource_hash`；外部 immutable resource 使用 `*_ref/*_hash`。每一对的 nullability 与状态组合进入 CHECK，禁止存在 ref 非空而 hash 为空。
7. **跨表状态约束**：SQLite 只有 deferred FK，没有 deferred CHECK/trigger。文中“Deferred constraint/trigger”统一解释为在状态跃迁的最后一条 UPDATE 上执行 immediate trigger：事务必须先插入依赖事实，再更新 lifecycle/status；trigger 在该 UPDATE 时查询依赖事实并拒绝非法跃迁。不得假设 trigger 会在 COMMIT 时自动延迟执行。

Schema Manifest 为每个 typed relation 记录 `target_table/target_columns/on_delete/deferrable`，为每个 external ref 记录 validator owner。CI 增加 schema lint：发现内部表名对应对象仍以裸 `kind/id`、`*_ref` 无 target metadata、或 `error_json/error_text/error fields` 出现在 migration 中即失败。

## 持久化模型

Graph Store 是恢复事实源，不依赖 checkpoint 复制完整图。

### Immutable Value/Blob Store

Graph 中的 source、plan、input/output snapshot、artifact、effect receipt 和 event payload 统一通过 storage resolver 持久化，不能直接引用 source spec 提供的 host path。小型 canonical JSON 可以 inline SQLite；大型 JSON、text、binary 和 artifact snapshot 使用 content-addressed blob。统一引用类型：

```ts
type StoredValueRef =
  | {
      storage: 'inline';
      canonical_json: JsonValue;
      hash: string;
      byte_length: number;
    }
  | {
      storage: 'blob';
      blob_hash: string;
      byte_length: number;
      media_type: string;
    }
  | {
      storage: 'immutable_external';
      locator: string;
      expected_hash: string;
      byte_length: number;
      media_type: string;
    };

type RetentionClass =
  | 'transient'
  | 'run_recovery'
  | 'workflow_audit'
  | 'user_artifact'
  | 'pinned';

interface StoredValueMetadata {
  value_ref: string;
  schema_ref: VersionedRef;
  schema_hash: string;
  content_hash: string;
  byte_length: number;
  media_type: string;
  ownership_ref: string;
  provenance_ref: string;
  retention_class: RetentionClass;
  payload_state: 'live' | 'pruned' | 'corrupt';
  payload_pruned_at_ms: number | null;
}
```

Logical Value 与物理 Blob 分开建模；相同 Blob bytes 可以被多个具有不同 owner/provenance/schema 的 Value 引用：

```text
workflow_values
  - id/value_ref PRIMARY KEY
  - storage_kind                 inline | blob | immutable_external
  - inline_canonical_json
  - blob_hash
  - immutable_external_locator/expected_hash
  - content_hash/byte_length/media_type
  - schema_ref/schema_version/schema_hash
  - provenance_ref
  - retention_class             transient | run_recovery | workflow_audit |
                                  user_artifact | pinned
  - payload_state               live | pruned | corrupt
  - payload_pruned_at_ms/created_at_ms/row_version

workflow_value_edges
  - parent_value_id/child_value_id
  - relation_kind               manifest_member | artifact_file |
                                  registry_dependency | map_result_member
  - member_key/member_index
  - child_expected_hash
  - created_at_ms

UNIQUE(parent_value_id, relation_kind, member_key)
UNIQUE(parent_value_id, relation_kind, member_index)

workflow_value_ownerships
  - value_id PRIMARY KEY
  - owner_workflow_id/owner_graph_run_id/owner_registry_resource_id
  - owner_feature_release_id/system_owner_ref
  - created_at_ms

CHECK (exactly one owner column is non-null)
```

Storage CHECK 必须保证 `inline/blob/immutable_external` 只填写各自字段；`payload_state=pruned` 必须具有 `payload_pruned_at_ms` 且不再声称 payload 可读，metadata/hash/schema/provenance 仍保留。`workflow_value_ownerships` 按 SQLite 关系展开规则使用 typed FK，`system_owner_ref` 只允许 versioned Core subsystem id。`workflow_value_edges` 是所有 immutable Manifest 的通用成员边，但 Registry、Release、Retention 和 Backup 仍使用具有真实 FK 的领域表，不使用 polymorphic 万能引用表。

第一版威胁模型限定为本地单用户、本机账号与数据目录可信、已加载 Feature/Plugin 处于同一读取信任域；暂不实现应用层加密、Value 级多用户/跨 Feature 授权、数据分类、HMAC 或 cryptographic erasure。这只延期机密性与读取隔离，不削弱 Capability permission、Domain Claim、fencing 和 mutation gateway。

Blob path 由内容 SHA-256 决定，例如 `data/workflow-runtime/blobs/sha256/ab/cd/<full-hash>`；相同 bytes 复用相同 blob，已发布内容永不原地覆盖。所有 Value 无论 inline/blob 都保存并在读取/恢复时验证 Schema、Hash、byte length、typed ownership 与 provenance。Credential、Cookie、private key、数据库密码等秘密原文禁止写入 Value/Blob Store，只保存 `credential_ref`；带 token 的 URL 也必须改为 opaque locator ref。

SQLite 与 filesystem 不能组成一个事务，因此 Blob 写入使用持久 Write Intent 与固定的 file-first 顺序：

```text
workflow_blob_write_intents
  - id
  - expected_hash/expected_byte_length
  - reserved_physical_bytes
  - status                 preparing | installed | committed | abandoned
  - lease_owner/lease_token/lease_expires_at_ms
  - created_at_ms/updated_at_ms
```

```text
1. DB 预留 physical blob capacity，创建 Write Intent
2. 在 Blob Store 同一 filesystem 创建唯一 temp file
3. 写入完整 canonical bytes，同时计算 hash/length
4. 校验 schema、hash、length 与 safety/business byte limits
5. fsync temp file
6. install-if-absent 到 content-hash final path
7. fsync final parent directory
8. SQLite transaction 原子提交 blob metadata、Value、业务引用与 Intent=committed
9. 结算实际 physical allocation，释放差额
```

首次创建 hash fan-out 目录时必须 fsync 新目录的父目录；实现可以在 Store 初始化时预创建并持久化全部分片目录。删除或安装 final path 后都必须 fsync parent directory，仅 `fsync(file)+rename` 不构成完整掉电保证。

相同 Hash 的并发 Writer 使用 no-replace install：一个成功安装，其他 Writer 得到 already-exists 后验证现有 Hash/Length、删除自己的 temp 并释放预留。禁止普通 rename 静默覆盖已发布 Blob。Rename/install 后、DB commit 前 crash 只产生 final orphan；DB 绝不能先提交尚未 durable 的文件引用。

Workspace artifact 是可变文件，node succeeded 前必须复制/提交为 immutable blob snapshot，或绑定具有 immutable/versioned 保证的 external locator 与 expected hash。目录型 artifact 保存按安全相对 path 排序的 file manifest/hash，禁止 hard link 充当 immutable snapshot。

Immutable 不等于永久保存。`transient` 在短 grace 后清理；`run_recovery` 在 Active/closing/action-required/quarantined 期间强制保留，Closed 后按有限期限清理；`workflow_audit` 长期保留 Hash/Schema/Cut/receipt summary，payload 可到期删除；`user_artifact` 按 Recipe/用户策略；`pinned` 必须人工解除。Payload 删除后保留 value id/hash/length/schema/provenance、`payload_pruned_at_ms` 与 tombstone，不能伪造仍可完整重放。

Production v1 固定发布 `local_single_user_retention@1`，所有 duration 从对象进入对应 eligible 状态时起算，使用 UTC milliseconds；Feature/Recipe 只能延长 `user_artifact`，不能缩短 active recovery、审计或安全 grace：

| 对象/类别 | Baseline |
| --- | --- |
| `transient` payload | 24 小时 |
| `run_recovery` payload | Run active/closing/action-required/quarantined 期间强保留；Closed 后 30 天 |
| `workflow_audit` payload / metadata+tombstone | 90 天 / 365 天 |
| `user_artifact` payload | 默认 365 天；用户删除或 Feature policy 可延长，不能早于 Workflow Closed |
| Retired Execution Artifact/Registry replay bytes | 无 active/published/pinned ref 后 90 天 |
| temp file、expired Write Intent、final orphan grace | 24 小时 |
| rejected/late/unmatched Inbox payload / audit metadata | 7 天 / 30 天 |
| Closed Workflow/Command/Runtime Event audit metadata | 365 天 |
| Backup default expiry | 30 天；显式 manual pin 可延长 |

Pending Signal 的绝对 Safety TTL 为 7 天，Wait Contract 可以进一步缩短。GC/Retention 每次决策固定 exact Retention Policy ref/hash；修改任何数字必须发布新版本，只影响新创建对象，既有对象继续使用创建时冻结的 policy，除非用户显式执行只延长不缩短的 pin。

Blob Object 使用权威状态机：

```text
workflow_blob_objects
  - blob_hash PRIMARY KEY
  - byte_length
  - state                  live | gc_candidate | deleting | deleted | corrupt
  - gc_epoch
  - created_at_ms/deleted_at_ms
```

业务引用只能绑定 `state=live`。GC 的 Mark Transaction 从 Value、Manifest 成员、Published/Active Registry、Retention、Write Intent 与 Backup Pin 计算 Reachability，把超过 grace 且无 Root 的 `live -> gc_candidate`；Sweep Transaction 再次确认无引用并 CAS `gc_candidate -> deleting`，随后删除文件、fsync parent directory，最后事务提交 `deleting -> deleted`、释放 physical allocation 并保留 tombstone。新引用可以在删除前事务性恢复 `gc_candidate -> live`，但进入 `deleting` 后禁止绑定。

Crash Recovery 固定处理：

- temp + 有效 Write Intent：继续或重建同一写入；过期 Intent 的 temp 在 temp grace 后删除。
- final file 存在但无 Blob Object/有效 Intent：校验 path/hash/length，超过 orphan grace 后删除。
- `gc_candidate`：重新计算 Reachability；`deleting`：根据文件是否仍存在继续删除或完成 tombstone。
- `live` 且有引用但文件缺失，或路径 Hash 与内容不符：标记 `corrupt` 并 quarantine；禁止重新生成相似内容伪装成原 Blob，只能从可信备份恢复相同 Hash。

Orphan Scanner、GC 与 Blob Writer 必须共用一个 Blob Store Coordinator。Deployment physical blob capacity 使用可释放 allocation：写前预留预计物理字节；soft high-water 触发 GC/限流，hard limit 或 minimum-free-disk reserve 触发 backpressure/action-required。Closed Run Reachability 按 retention class 计算，不永久保留全部 payload。

Runtime DB 与 Blob Store 使用一致备份协议：WorkflowRuntimeStore 建立短暂 Backup Barrier，暂停新的权威写事务与 GC；使用 SQLite Backup API 生成 DB Snapshot，从该 Snapshot 枚举 Reachable Blob 并在 Live DB 创建 Backup Pins，随后解除 Barrier、复制被 Pin Blob、写 Backup Manifest 并原子提交备份。备份完成前 GC 不得删除 Pin；备份过期/删除后释放。恢复必须校验 Manifest 中所有 Hash/Length，执行 missing-blob 与 orphan scan，通过后才开放 Runtime。

### Registry、Release、Retention 与 Backup

Authoring Source 可以位于 Git/Feature 目录，但不能直接执行。只有通过 Publish 写入下列 Runtime Registry、完成 dependency/permission/effect/ABI 校验并进入 active release 的 exact resource 才能创建新 Workflow：

```text
workflow_registry_resources
  - id PRIMARY KEY
  - resource_type/resource_id/resource_version
  - owner_core_ref/owner_feature_id
  - canonical_value_id/content_hash
  - publication_state                staged | published | retired
  - created_at_ms/published_at_ms/retired_at_ms/row_version

workflow_registry_resource_dependencies
  - resource_id/dependency_resource_id
  - dependency_kind
  - expected_content_hash
  - created_at_ms

workflow_registry_closure_manifests
  - id/closure_hash
  - manifest_value_id/manifest_hash
  - created_at_ms

workflow_registry_closure_members
  - closure_manifest_id/resource_id
  - resource_type/resource_ref/content_hash
  - member_index

workflow_registry_snapshots
  - id/snapshot_hash
  - closure_manifest_id/closure_hash
  - compiler_version/core_build_hash/database_schema_hash
  - created_at_ms

UNIQUE(resource_type, resource_id, resource_version)
UNIQUE(resource_id, dependency_resource_id, dependency_kind)
UNIQUE(closure_hash)
UNIQUE(closure_manifest_id, resource_id)
UNIQUE(snapshot_hash)
CHECK (exactly one of owner_core_ref/owner_feature_id is non-null)
```

Feature Release 与新创建入口的激活指针必须独立持久化，不能用安装目录或当前文件内容代替：

```text
workflow_feature_releases
  - id/feature_id/release_ref/release_version
  - execution_artifact_resource_id/execution_artifact_hash
  - status                          staged | active | draining |
                                    disabled | deleting
  - compatibility_snapshot_ref/hash
  - staged_at_ms/activated_at_ms/disabled_at_ms/row_version

workflow_feature_release_resources
  - release_id/resource_id/content_hash
  - resource_role

workflow_feature_active_releases
  - feature_id PRIMARY KEY
  - release_id/release_hash
  - row_version/activated_at_ms

UNIQUE(feature_id, release_ref, release_version)
UNIQUE(release_id, resource_id)
```

Retention Handle 是 Registry/Execution Artifact 的强 GC Root：

```text
workflow_registry_retention_handles
  - id
  - handle_kind                    published | active_run | manual_pin |
                                    investigation
  - feature_release_id/graph_run_id/backup_id/external_actor_ref
  - closure_manifest_id/closure_hash
  - status                         held | released
  - created_at_ms/released_at_ms/row_version

workflow_registry_retention_handle_members
  - handle_id/resource_id/content_hash

UNIQUE(handle_kind, feature_release_id, closure_manifest_id)
UNIQUE(handle_kind, graph_run_id, closure_manifest_id)
UNIQUE(handle_kind, backup_id, closure_manifest_id)
UNIQUE(handle_kind, external_actor_ref, closure_manifest_id)
UNIQUE(handle_id, resource_id)
CHECK (exactly one root column is non-null and matches handle_kind)
```

Run 创建时获得 `active_run` Handle，关闭后释放；Published Active Release、Active/closing/action-required/quarantined Run、Manual Pin 和 Investigation 均阻止清理。Reference count 只作 cache，权威 Reachability 由 Handle/Member FK 与 Registry dependency closure 重建。

Backup 状态和 Pin 必须 durable，保证进程在复制期间崩溃后 Recovery 可以继续或清理：

```text
workflow_backups
  - id
  - status                         preparing | copying | completed |
                                    failed | expired
  - database_snapshot_ref/hash
  - manifest_value_id/manifest_hash
  - started_at_ms/completed_at_ms/expires_at_ms/row_version

workflow_backup_blob_pins
  - backup_id/blob_hash/expected_byte_length
  - status                         pinned | copied | released
  - pinned_at_ms/copied_at_ms/released_at_ms/row_version

UNIQUE(backup_id, blob_hash)
```

GC Root 固定为 Live Workflow/Run Value refs、Published Release refs、Active Run/Manual/Investigation Retention Handle、Backup Pin、有效 Write Intent，以及 retention window 内的 Closed Workflow refs。GC 先沿 Registry Snapshot -> Closure Member -> Registry Resource Value，再沿 Value -> Value Edge -> Child Value -> Blob Object 遍历；只有不可达且超过 grace 的对象才能进入 `gc_candidate`。所有现有 `value_ref/blob_hash/registry_snapshot_ref/retention_handle_id/backup pin` 在 executable DDL 中必须具有明确 FK 目标。

### Intake、Routing 与 Creation

```text
workflow_task_intakes
  - id/request_id
  - creation_domain/creation_key
  - source/principal_ref
  - routing_scope_ref/hash
  - raw_request_ref/hash
  - initial_input_ref/hash
  - attachment_manifest_ref/hash
  - explicit_task_kind/explicit_recipe_ref
  - status                  routing | needs_clarification | awaiting_confirmation |
                            ready_to_create | created | unsupported | rejected
  - selected_recipe_ref/hash
  - current_revision_id/no/hash
  - workflow_id
  - next_attempt_no/row_version
  - created_at_ms/updated_at_ms

workflow_task_intake_revisions
  - id/intake_id/revision_no/parent_revision_id
  - amendment_ref/hash
  - effective_input_ref/hash
  - attachment_manifest_ref/hash
  - clarification_contract_ref/hash
  - source_routing_attempt_id
  - actor/principal_ref
  - idempotency_key
  - created_at_ms

UNIQUE(intake_id, revision_no)
UNIQUE(intake_id, idempotency_key)

workflow_routing_attempts
  - id/intake_id/attempt_no
  - intake_revision_id/input_hash
  - parent_scope_ref/scope_ref/hash
  - router_capability_ref/hash       nullable for deterministic explicit route
  - input_snapshot_ref/hash
  - decision_ref/hash
  - decision_kind/target_ref
  - confidence_micros
  - reason_codes_json/missing_fields_json
  - created_at_ms

workflow_creation_requests
  - id/intake_id
  - creation_mode            direct | required_finalization |
                             best_effort_delivery
  - creation_domain/creation_key
  - recipe_ref/hash
  - definition_ref/hash/entry_point
  - execution_policy_ref/hash
  - input_snapshot_ref/hash
  - attachment_manifest_ref/hash
  - creation_intent_hash
  - runtime_safety_hash
  - launch_confirmation_ref/hash
  - status                  pending | blocked_retryable | awaiting_confirmation |
                            created | rejected_permanent | cancelled
  - workflow_id/error_code
  - created_at_ms/updated_at_ms

workflow_launch_confirmations
  - id/intake_id/intake_revision_id/input_hash
  - routing_decision_id/hash
  - recipe_ref/hash
  - creation_intent_hash
  - actor_ref/action        approve | decline
  - expires_at_ms/idempotency_key/created_at_ms

workflow_creation_attempts
  - id/creation_request_id/attempt_no
  - status/error_code/retry_at_ms
  - created_at_ms

UNIQUE(creation_domain, creation_key)
UNIQUE(intake_id, attempt_no)
UNIQUE(intake_id) WHERE status='created'
UNIQUE(creation_request_id, attempt_no)
UNIQUE(intake_id, idempotency_key)
```

`creation_domain` 是受信任入口确定的 namespace，例如 `feature:pm-pipeline`、`api:<principal-scope>` 或 `parent_workflow_lineage:<root_workflow_id>`；调用方不能用不同 domain 绕过同一业务幂等键。Revision 0 保存初始完整输入；后续 revision 同时保存受合同约束的 amendment、完整 effective-input snapshot 与 parent hash。并发回答必须携带 `expected_revision_no`，旧 revision 返回 conflict，不自动 merge。Router attempt 可以多次追加但不能覆盖，且必须引用 exact revision/hash。`creation_mode` 只描述创建协调协议，不改变 provenance 要求：三种 mode 均必须具有非空 Intake、revision 0、Routing Attempt 和 Creation Request；required-finalization 的特殊点只是 Workflow/Claim 的最终写入延迟到 Parent T8。

控制归属是 T0 根据已认证入口生成的 first-class immutable snapshot，不从 Recipe owner 或幂等 domain 临时推断：

```ts
interface WorkflowControlOwnership {
  owner_principal_ref: string;
  controlling_feature_id: string | null;
  creator_automation_ref: string | null;
  ownership_hash: string;
}
```

Human 的 `own` 要求认证 principal 等于 `owner_principal_ref`；Feature Service 的 `own` 要求服务端认证 Feature ID 等于 `controlling_feature_id` 且通过 Feature Manifest command ceiling；Automation 的 `own` 要求认证 automation ref 等于 `creator_automation_ref`。`creation_domain` 只负责幂等 namespace，Recipe `owner_feature_id` 只表示发布者，两者都不自动授予控制权。客户端不能提交或覆盖 ownership 字段；Production v1 的 `human:local-owner` 是全部本地 Workflow 的 owner principal。

最终创建前计算 `creation_intent_hash = H(creation_domain, creation_key, principal_scope, ownership_hash, routing_scope_ref/hash, recipe_ref/hash, entry_point, effective_input_hash, attachment_manifest_hash)`。相同 key 与相同 intent 返回原 request/Workflow；相同 key 与不同 intent 返回 `idempotency_conflict`，因此同一 key 不能在重放时改变控制归属。Confirmation 绑定 exact revision、decision、Recipe、intent、actor、expiry 与 nonce；任一绑定改变都使旧确认失效。`resource_busy` 等临时失败进入 `blocked_retryable` 并追加 attempt，不改变 intent 或要求新 key；永久拒绝与取消仍永久占用原 key。

### Workflow 与 Run

```text
workflows
  - id
  - status                  active | completed | errored | cancelled |
                            administratively_abandoned
  - operational_state       healthy | action_required | quarantined |
                            administratively_abandoned
  - recipe_ref/recipe_version/recipe_hash
  - creation_request_id/creation_domain/creation_key
  - owner_principal_ref/controlling_feature_id/creator_automation_ref/ownership_hash
  - root_workflow_id/parent_workflow_id/workflow_depth
  - lineage_budget_account_id
  - workflow_execution_policy_ref/hash
  - workflow_command_policy_ref/hash
  - workflow_input_ref/hash/schema_ref/schema_hash
  - context_contract_ref/hash
  - current_context_snapshot_id/hash
  - runtime_safety_hash
  - state_activation_count/graph_run_count/state_transition_count/child_workflow_count
  - started_at_ms/deadline_at_ms
  - workflow_definition_version
  - state_instance_id                     当前或最终 terminal activation
  - current_graph_run_id
  - final_outcome_kind
  - final_output_ref/hash/schema_hash
  - final_error_code/error_ref
  - final_cancel_reason
  - workflow_revision/row_version
  - created_at_ms/updated_at_ms/finished_at_ms

UNIQUE(creation_domain, creation_key)
CHECK ((status='active' AND finished_at_ms IS NULL) OR
       (status IN ('completed','errored','cancelled','administratively_abandoned') AND
        finished_at_ms IS NOT NULL))
CHECK ((status='administratively_abandoned') =
       (operational_state='administratively_abandoned'))

workflow_state_activations
  - id
  - workflow_id/state_key/state_type
  - activation_no
  - workflow_definition_ref/version/hash
  - state_config_ref/hash
  - status                                active | completed | abandoned
  - graph_run_id                          terminal activation 为 null
  - entered_via_transition_id             initial activation 为 null
  - terminal_kind                         normal | errored | null
  - terminal_output_ref/hash/schema_hash
  - terminal_error_code/error_ref
  - started_at_ms/finished_at_ms/row_version

UNIQUE(workflow_id, activation_no)
UNIQUE(graph_run_id) WHERE graph_run_id IS NOT NULL
CHECK ((state_type='terminal' AND graph_run_id IS NULL AND status='completed' AND
        finished_at_ms IS NOT NULL AND terminal_kind IS NOT NULL)
       OR
       (state_type!='terminal' AND graph_run_id IS NOT NULL AND terminal_kind IS NULL))
CHECK ((status='active' AND finished_at_ms IS NULL)
       OR (status IN ('completed','abandoned') AND finished_at_ms IS NOT NULL))
CHECK (status!='abandoned' OR state_type!='terminal')
CHECK ((terminal_kind='normal' AND terminal_output_ref IS NOT NULL AND
        terminal_error_code IS NULL AND terminal_error_ref IS NULL)
       OR (terminal_kind='errored' AND terminal_output_ref IS NULL AND
           terminal_error_code IS NOT NULL)
       OR (terminal_kind IS NULL AND terminal_output_ref IS NULL AND
           terminal_error_code IS NULL AND terminal_error_ref IS NULL))

workflow_graph_runs
  - id
  - workflow_id
  - state_key
  - state_instance_id                    FK workflow_state_activations(id)
  - workflow_definition_version
  - state_config_json/hash
  - registry_snapshot_ref/hash       覆盖 effective allowlist 与传递依赖
  - registry_retention_handle_id
  - runtime_safety_snapshot_ref/hash
  - runtime_supported_limits_ref/hash
  - sqlite_execution_profile_ref/hash
  - compiler_toolchain_ref/hash
  - core_release_ref/core_build_hash
  - run_protocol_major
  - executor_abi_major
  - database_schema_version
  - database_schema_hash
  - source_seed_hash
  - root_scope_id
  - root_build_id
  - root_plan_hash          nullable until root materialize
  - manifest_seq
  - manifest_head_hash
  - ledger_seq
  - ledger_head_hash
  - lifecycle
  - control
  - operational_state      healthy | action_required | quarantined |
                           administratively_abandoned
  - root_cancel_scope       nullable；local_graph | workflow
  - root_close_request_id
  - completion_cut_id
  - work_fence_epoch
  - outcome_kind
  - exit_name
  - output_ref/hash
  - error_code/error_ref
  - next_event_seq
  - last_admission_seq
  - row_version
  - started_at_ms/finished_at_ms/created_at_ms/updated_at_ms

UNIQUE(workflow_id, state_instance_id)
CHECK ((lifecycle='closed' AND completion_cut_id IS NOT NULL AND
        outcome_kind IS NOT NULL AND finished_at_ms IS NOT NULL)
       OR (lifecycle!='closed' AND completion_cut_id IS NULL))
CHECK (operational_state!='administratively_abandoned' OR
       (lifecycle!='closed' AND completion_cut_id IS NULL AND outcome_kind IS NULL))

workflow_operational_blockers
  - id/workflow_id/graph_run_id
  - blocker_kind             effect_unknown | compensation_dead_letter |
                             root_finalization_exhausted | claim_release_failed |
                             resource_or_credential_unavailable | integrity_quarantine
  - severity                 action_required | quarantine
  - source_effect_operation_id/source_outbox_id
  - source_root_finalization_schedule_id/source_claim_id/source_event_seq
  - error_code
  - evidence_manifest_value_id/evidence_manifest_hash
  - status                   open | resolved | abandoned
  - remediation_policy_ref/remediation_policy_hash
  - remediation_attempt_count/next_remediation_at_ms/remediation_deadline_at_ms
  - opened_event_seq/resolved_event_seq
  - resolution_command_id
  - resolution_value_id/resolution_hash
  - row_version
  - opened_at_ms/resolved_at_ms/abandoned_at_ms

UNIQUE(graph_run_id, blocker_kind, source_effect_operation_id)
UNIQUE(graph_run_id, blocker_kind, source_outbox_id)
UNIQUE(graph_run_id, blocker_kind, source_root_finalization_schedule_id)
UNIQUE(graph_run_id, blocker_kind, source_claim_id)
UNIQUE(graph_run_id, blocker_kind, source_event_seq)
INDEX(graph_run_id, severity, status, id) WHERE status='open'
CHECK (exactly one typed source column is non-null)
CHECK ((status='open' AND resolved_at_ms IS NULL AND abandoned_at_ms IS NULL) OR
       (status='resolved' AND resolved_at_ms IS NOT NULL AND abandoned_at_ms IS NULL) OR
       (status='abandoned' AND abandoned_at_ms IS NOT NULL AND resolved_at_ms IS NULL))

workflow_operational_blocker_remediation_attempts
  - id/blocker_id/attempt_no/attempt_key
  - command_id                       automatic continuation 时 nullable
  - remediation_policy_ref/remediation_policy_hash
  - attempt_kind                    reconcile | compensate | finalization |
                                    claim_release | resource_preflight |
                                    integrity_restore
  - request_value_id/request_hash
  - result                          retry_wait | resolved | rejected
  - result_value_id/result_hash/error_code
  - next_eligible_at_ms
  - started_at_ms/finished_at_ms

UNIQUE(blocker_id, attempt_no)
UNIQUE(attempt_key)

workflow_state_transition_history
  - id
  - workflow_id
  - source_state_instance_id
  - source_run_id
  - completion_cut_id
  - target_state_key
  - target_state_instance_id          terminal activation 也 required；global cancel 为 null
  - target_run_id                     nullable for workflow terminal
  - workflow_revision
  - context_patch_hash
  - created_at_ms

UNIQUE(source_state_instance_id)
UNIQUE(completion_cut_id)

workflow_relations
  - id
  - parent_workflow_id/child_workflow_id
  - root_workflow_id/workflow_depth/lineage_budget_account_id
  - source_state_instance_id/source_run_id/source_completion_cut_id
  - transition_effect_id/relation_kind
  - recipe_ref/creation_key
  - created_at_ms

UNIQUE(parent_workflow_id, source_completion_cut_id, transition_effect_id)
UNIQUE(child_workflow_id)

workflow_root_finalization_schedules
  - id/workflow_id/source_state_instance_id/source_run_id/root_scope_id
  - close_request_id/transition_effect_id
  - transition_intake_id/creation_request_id
  - effect_type                         required_child_workflow
  - recipe_ref/hash/routing_scope_ref/hash
  - principal_ref/hash
  - input_snapshot_ref/hash
  - creation_domain/creation_key/creation_intent_hash
  - finalization_policy_ref/hash
  - status                              pending | retry_wait | ready |
                                        succeeded | exhausted | cancelled
  - attempt_count/max_attempts
  - next_eligible_at_ms/deadline_at_ms
  - child_workflow_id/last_error_code/last_error_ref
  - row_version/created_at_ms/updated_at_ms/completed_at_ms

workflow_root_finalization_attempts
  - schedule_id/attempt_no
  - attempt_key
  - frozen_resolution_ref/hash
  - claim_preflight_ref/hash
  - result                              ready | retryable_conflict |
                                        permanent_rejection | applied
  - error_code/error_ref
  - started_at_ms/finished_at_ms

UNIQUE(close_request_id, transition_effect_id)
UNIQUE(creation_domain, creation_key)
UNIQUE(transition_intake_id)
UNIQUE(creation_request_id)
UNIQUE(schedule_id, attempt_no)
UNIQUE(attempt_key)
INDEX(status, next_eligible_at_ms, id)
  WHERE status IN ('pending', 'retry_wait')
CHECK (attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts)
CHECK ((status='succeeded' AND child_workflow_id IS NOT NULL AND completed_at_ms IS NOT NULL)
       OR (status!='succeeded' AND child_workflow_id IS NULL))

workflow_context_snapshots
  - id/workflow_id/revision
  - contract_ref/hash
  - previous_snapshot_id/hash
  - slots_manifest_ref/hash
  - snapshot_hash
  - created_at_ms

workflow_context_slot_values
  - snapshot_id/slot_name
  - value_ref/hash
  - schema_ref/hash
  - byte_length/provenance_ref

workflow_context_patches
  - id/workflow_id/source_run_id/completion_cut_id
  - patch_ref/hash
  - operation_count
  - created_at_ms

workflow_context_patch_operations
  - patch_id/operation_index
  - operation                         set | clear
  - source_kind/source_port/source_slot/pointer
  - target_slot
  - old_value_hash/new_value_ref/new_value_hash
  - operation_hash

UNIQUE(workflow_id, revision)
UNIQUE(snapshot_id, slot_name)
UNIQUE(completion_cut_id)
UNIQUE(patch_id, operation_index)
UNIQUE(patch_id, target_slot)
```

State Activation 是 first-class record，不能继续由 Graph Run 间接代替。T1 创建 `active` non-terminal activation + 唯一 run；T8 在消费 root cut 的同一事务把 source activation `active -> completed` 并写 `finished_at_ms`，包括 normal exit、engine error、local cancel 和 global workflow cancel。T8 进入 Terminal State 时创建并立即完成 terminal activation，`target_state_instance_id` 非空而 `target_run_id/current_graph_run_id` 为空。Administrative Abandon 不生成 Cut/T8，而是在同一 Command transaction 把当前 non-terminal activation `active -> abandoned`，同时标记 Run/Workflow administratively abandoned；terminal activation 永不 abandoned。Recipe entrypoint 禁止直接指向 Terminal State。Run 只缓存 `root_close_request_id`，完整 canonical request 与 `request_hash` 只存在 close-request row；`close_reason/frontier/cancel payload` 不在 run 上复制第二份。Transition history 的两个 unique key 分别证明一个 activation 只推进一次、一个 root cut 只消费一次。`workflow_revision` 在 T0 初始化、只在 T8 外层 state/context commit 时递增并进入 history/checkpoint；`row_version` 在包括 Operational Blocker trigger 在内的每次 Workflow row update 时递增，用于普通 CAS。Workflow counters 是 Ledger 可验证 cache；T0/T1/T8 在同一事务检查 execution policy、safety、lineage budget 和 duration deadline。`workflow_relations` 只表达已成功创建的 lineage，不把 child 状态复制到 parent；尚未提交的 required child intent 只存在 Root Finalization Schedule 中，不能提前伪造 relation。

Operational Blocker 是 `action_required/quarantined` 的权威原因集合，不允许只改 Run/Workflow operational state。创建第一个 `action_required` blocker 时，同一事务把 Run/Workflow `operational_state=action_required`；创建任一 `quarantine` blocker 时升级为 `quarantined`。多个 blocker 可以并存，effective state 取 `quarantine > action_required > healthy`。Workflow `status` 继续表达业务 lifecycle：active Run 的 blocker 不把 status 改成终态，已 completed/errored/cancelled Workflow 的 Claim-release blocker 也不抹掉 final outcome；best-effort Projection failure 仍只属于独立 projection degradation，不创建 Workflow blocker。Blocker source 必须通过 exactly-one typed source column 引用真实 Effect Operation、Outbox、Root Finalization Schedule、Claim 或完整性检测 Event；外部 provider ref 仅作 evidence manifest 内容，不能成为唯一 blocker identity。

Run/Workflow `operational_state` 是由 open blocker 集合维护的数据库 cache：migration 为 blocker INSERT、`open -> resolved/abandoned` 建 immediate trigger，在同一事务按 `quarantine > action_required > healthy` 更新两级 cache 和 row version；普通 Store API 不提供 operational-state setter，且唯一 Runtime DB write connection 不暴露 raw SQL。唯一例外是 Administrative Abandon transaction：先把 open blocker 标成 abandoned，再把 Run/Workflow operational state 与 Workflow status 设为 `administratively_abandoned`。Constraint/trigger fixture 必须证明 insert/resolve/abandon、多 blocker severity 和两级 cache 更新原子一致；API boundary test 证明不存在普通 setter。Recovery 仍做双向扫描以检测磁盘损坏或被绕过的非法写入。

T6e remediation/restoration 只能通过 Runtime Command Gateway 执行。`action_required` blocker 必须沿原 effect key、schedule 或 claim 协议追加有限 Attempt/Receipt/Reconcile 事实；`integrity_quarantine` 只能从可信备份或重新验证的同 hash 数据恢复，禁止 recompile/re-prove 或用“等价”新内容覆盖原事实。单个 blocker 成功时以 `status=open + row_version` CAS 转为 `resolved` 并写 resolution evidence；事务内按剩余最高 severity 同时更新 Run/Workflow operational state，无 open blocker 才恢复为 `healthy`，但绝不改写 Workflow business status。恢复不回退 lifecycle/control/work fence，不清零 attempts/ledger/deadline；Run 已 closing/cancelling/closed 时只重新开放适用的 close-cleanup 或 claim-release lane，不开放 ordinary scheduler。Administrative Abandon 把剩余 open blocker 标成 `abandoned` 并保留证据，绝不把它们伪装为 resolved。

Blocker 关闭证明固定如下；“已追加新预算/已补 credential/已点击重试”本身都不算 resolved：

| Blocker kind | T6e 可关闭条件 |
| --- | --- |
| `effect_unknown` | Adapter reconcile 证明 `not_applied`，或取得 schema-valid receipt + immutable after-snapshot |
| `compensation_dead_letter` | 原 operation 已证明 not-applied，或同 effect key compensation 成功 terminal |
| `root_finalization_exhausted` | 同 Schedule 的 remediation preflight 已达到 `ready`、不存在其他 open blocker，并在关闭本 blocker、trigger 恢复 healthy 后于同一 SQLite transaction 成功执行 T8；任一步失败全部回滚，blocker 继续 open |
| `claim_release_failed` | Claim 已 `released`，或经 Published Abandon Policy 验证的新 fencing disposition 已提交 |
| `resource_or_credential_unavailable` | 资源/credential preflight 在原 frozen contract 下成功，且下一步稳定 attempt 已 durable scheduled |
| `integrity_quarantine` | 相同 expected hash 的可信数据恢复并完成全链验证；不得接受语义相似替代物 |

T6e 自身使用独立 finite remediation attempt/deadline policy和原 blocker id 作为 idempotency domain；等待 backoff 时 Run 仍保持 action-required/quarantined，remediation watchdog 只推进该 blocker，不开放 Scheduler。失败 Attempt append-only；耗尽后 blocker 继续 open，不创建第二个同 source blocker，也不清零历史。

Root Finalization Schedule 是 required `start_child_workflow` 的 durable barrier，不是第二套 Outbox。Schedule 创建事务先执行 T0p：根据 `root_workflow_id + parent_workflow_id + source_state_instance_id + close_request_id + transition_effect_id` 派生稳定 request/intake/revision/routing/creation ids，创建真实 `source=workflow_transition,status=ready_to_create` Task Intake、revision 0、`router_capability_ref=null` 的 deterministic exact-Recipe Routing Attempt，以及 `creation_mode=required_finalization,status=pending` 的 Creation Request，再由 Schedule 以真实 FK 绑定 `transition_intake_id/creation_request_id`。这些 provenance row 是 append-only 审计，不是 synthetic nullable placeholder。

Schedule 在 Root closing 后冻结 exact Recipe/routing scope/principal/input/creation intent 和 finite policy；Attempt 只做确定性解析、授权、额度与 Claim preflight，不在 T8 之外创建 Child、Relation 或 Claim。`status=ready` 仅表示可以尝试原子提交；T8 必须在一个 SQLite transaction 中重新验证 schedule/claim/fencing/额度，并一次性提交 Root Cut、外层 transition、全部 required Child Workflow、relations、Claim handoff、Intake/Creation Request `created` 和 `schedule=succeeded`。任一 transient conflict 时整个业务提交保持不变，只追加 Attempt 并转为有限 `retry_wait`；永久拒绝或耗尽在同一事务写 `schedule=exhausted`、`root_finalization_exhausted` Operational Blocker 和 operational state=`action_required`，并阻止 Cut。相同 `(close_request_id, transition_effect_id)`、Intake request id 和 creation key 重放只返回原 Schedule/Child，不重复创建。Parent 被 administrative abandon 时尚未成功的 Schedule 原子转为 `cancelled`、transition Intake 转为 `rejected`、Creation Request 转为 `cancelled`，仍永久占用原 creation key。

Best-effort Child 不在 Parent T8 内创建上述 provenance row；T8 只写带完整 frozen `WorkflowTaskEnvelope(source=workflow_transition)` 的 deterministic Outbox intent。Delivery 调用普通 T0，创建 `creation_mode=best_effort_delivery` 的真实 Intake/Revision/Routing/Creation Request。Outbox 重投复用同一 request id/domain/key；不能因为 best-effort 而省略创建溯源。

Workflow Input 永久不可变；Context 只保存 State 间中间结果。Definition 固定 exact `WorkflowContextContract`，Recipe 必须绑定同一 ref，Planner 不能增加 Slot。Context Snapshot 和 Slot 只保存 Value ref/hash/schema/provenance，不内嵌大业务值；运行中心 summary 是 projection。读取 `context_slot` 时 Runtime 校验合同、hash/schema，dereference 业务值后应用 pointer，并冻结到 State/Node input snapshot。Transition patch 只允许 typed `set/clear`，禁止隐藏 merge/append/任意 JSON Patch；业务合并使用显式 system adapter。`write_once` slot 一旦出现非空历史值就禁止 set/clear，`required_initially` 只约束初始 Snapshot；允许后续 clear 的 slot 必须是 `write_policy=replace`，且目标 State 的 required binding 仍需在 T8 校验。一个 Patch Header 可以包含多个 Operation，但同一 patch 不得重复写同一 target slot。

所有从 Recipe entrypoint 可达的 normal terminal path 都必须有可赋值给 Recipe `output_schema_ref` 的 `output_binding`。T8 在终结 Workflow 前重新验证实际 value ref/hash/schema 并写 final output；global cancel 与未恢复 engine error 使用独立字段，不伪造 normal output。业务 `rejected/insufficient_evidence` 可以作为正常 output discriminant，不能混成 Runtime error。

### Scope Plan、Instance 与 Run Manifest

```text
workflow_graph_scope_plans
  - id PRIMARY KEY
  - graph_run_id
  - plan_hash
  - format/compiler_version
  - source_json/ref/hash
  - compiled_plan_json/ref
  - interface_snapshot_json/hash
  - policy_snapshot_json/hash
  - capability_catalog_hash
  - created_at_ms

UNIQUE(graph_run_id, plan_hash)

workflow_graph_scopes
  - id
  - graph_run_id
  - parent_scope_id
  - owner_node_id
  - child_key
  - scope_kind              root | subgraph | expansion | map_item
  - depth
  - plan_id/plan_hash       materializing root shell 可以为 null
  - input_snapshot_json/ref/hash
  - materialization_reservation_group_id
  - owner_run_work_fence_epoch/owner_scope_work_fence_epoch
  - lifecycle
  - work_fence_epoch
  - outcome_kind/exit_name
  - candidate_node_id
  - output_ref/hash
  - error_code/error_ref
  - close_request_id
  - completion_cut_id
  - next_resolution_seq
  - next_candidate_seq
  - row_version
  - created_at_ms/finished_at_ms/updated_at_ms

UNIQUE(graph_run_id, parent_scope_id, owner_node_id, child_key)
UNIQUE(graph_run_id) WHERE parent_scope_id IS NULL
CHECK(plan_id IS NOT NULL OR
      (scope_kind='root' AND parent_scope_id IS NULL AND
       lifecycle IN ('materializing', 'closing', 'closed')))

workflow_graph_run_manifest
  - graph_run_id
  - manifest_seq
  - entry_kind              scope_materialized | expansion_sealed
  - scope_id/expansion_manifest_id
  - parent_scope_id/owner_node_id/child_key
  - scope_kind
  - source_hash/plan_hash/interface_hash/input_hash/policy_hash
  - expansion_hash/item_count
  - previous_manifest_hash
  - manifest_hash
  - created_at_ms

UNIQUE(graph_run_id, manifest_seq)
```

Root scope shell 在 activation transaction 与 run、root build 同事务创建。`plan_id=NULL` 只允许 root scope 处于 materializing，或因 setup error 直接 closing/closed；scope 进入 active 前 plan 必须非空。Child scope 只有 build compiled 并 materialize 成功后才创建。Scope ownership 只保存 immutable `parent_scope_id + depth`；descendant 查询使用认证的 Recursive CTE 和临时 subtree-id table。Parent close 必须在一个事务更新完整 descendant set，不能异步传播 fence，也不维护第二份可漂移的 materialized lineage path。

Deferred constraint/trigger 还必须保证 `plan_id=NULL` 且 lifecycle 为 closing/closed 的 root scope，具有同 scope 的 setup `engine_error` 或 local/workflow cancel close request；普通 normal completion 不能关闭一个从未 materialize 的 root。

Run 不保存一个虚假的“最终 compiled graph”。`root_plan_hash + manifest_head_hash` 覆盖所有 immutable scope 和 sealed expansion/map intent。Run Manifest entry 使用 `H(previous_hash || manifest_seq || entry_kind || canonical payload hashes)`；scope materialize 或 Expansion Manifest seal 必须与 entry 插入、run seq/head CAS 和 event 同事务。这样即使 map slots 尚未 materialize，冻结 collection 和 child intent 也已进入 run 审计链。

### Scope Build 与 Expansion Manifest

Root、subgraph、expand 和 map item 统一通过可恢复的 build 边界获取 snapshot、compile 和 materialize：

```text
workflow_graph_scope_builds
  - id
  - graph_run_id/owner_scope_id/owner_node_id
  - target_scope_id         root shell 初始即绑定；child materialize 后绑定
  - invocation_key
  - scope_kind              root | subgraph | expansion | map_item
  - item_key/item_index
  - source_seed_json/ref/hash
  - source_snapshot_json/ref/hash
  - input_snapshot_json/ref/hash
  - compiler_snapshot_hash
  - run_work_fence_epoch/owner_scope_work_fence_epoch
  - status                  pending_snapshot | ready_to_compile | compiling |
                            compiled | materialized | failed | fenced
  - compiled_plan_id/hash
  - scope_id
  - materialization_reservation_group_id
  - attempt_count/next_attempt_at_ms/deadline_at_ms
  - lease_owner/lease_token/lease_expires_at_ms
  - error_code/error_detail_value_id/error_detail_hash
  - row_version
  - created_at_ms/updated_at_ms

UNIQUE(graph_run_id, owner_node_id, invocation_key)
UNIQUE(graph_run_id) WHERE scope_kind='root'

workflow_graph_expansion_manifests
  - id
  - graph_run_id/scope_id/owner_node_id
  - producer_attempt_id
  - mode                    subgraph | expand | map
  - source_artifact_ref/hash
  - manifest_json/ref/hash
  - item_count
  - child_completion_policy_json/hash
  - sealed_at_ms/row_version

UNIQUE(owner_node_id)
```

Owner 必须先完整冻结 Expansion Manifest，再创建任何 child build。Map Expansion Manifest 固定 collection hash、每个 item 的 index/key/input hash 和 ordered result slot；crash recovery 只能从 sealed Expansion Manifest 补齐缺失 build，不能重新读取 planner output 或追加 item。Paused run 可以完成 snapshot/compile 并保存 `compiled` build，但 resume 前不得 materialize 或消费 scope/node ledger。

Root source 的冻结规则固定：inline 来自 published definition snapshot；`context_slot` 在 T1 对同一 workflow revision 解析 exact Slot value ref、校验 contract/hash/schema 并冻结 canonical source bytes/hash；artifact 在 T1 冻结 immutable locator、expected hash 与 JSON Pointer，随后在事务外获取；template 从 pinned registry snapshot 解析精确 `VersionedRef`。任何后续 Context Snapshot、file 或 latest-registry 变化都不能影响已创建 build。

Compiler 是 pure deterministic component，不能调用模型修复 frozen source。Closed-schema、interface、policy、DAG、condition、completion 或 permission error 立即进入 `failed`，不得对同一 build 静默改写 source。需要 AI 修正时，使用显式 planner capability：每个 planner attempt 生成 candidate，evaluator 使用同一 Scope Compiler dry-run 并把 structured diagnostics 作为 `needs_revision` 反馈；只有最终 pass attempt 才发布 Graph Spec output。Root context/artifact source 编译失败走本次 activation `on_error`；需要新 source 时创建新的 activation/run。Expand 同样只消费 owner 已 seal 的最终 candidate。

`build_retry=null` 表示只做一次 acquisition；非 null build retry 的 `max_attempts` 包含首次 acquisition，`max_attempts=null` 表示不设置业务次数 ceiling，`max_duration_ms=null` 表示不设置业务总时长 ceiling，启用 retry 时必须显式配置 `initial_backoff_ms`，不注入默认业务值。实际 attempt count 与 duration 仍受 `execution.max_build_attempts_per_build/max_build_duration_ms` 和 run total safety ceiling。只有 immutable locator 获取等 transient error 可以按该策略重试；compile error 永不 retry。Build 创建事务写 `attempt_count=1` 和配置存在时的 absolute deadline，restart/pause 不能延长。每次外部 snapshot/compile 都必须持有 build lease，并以 `build_id + status + lease_token + source/input/compiler hashes + saved run/owner-scope work epochs + row_version` CAS 提交，stale compiler 不能覆盖新状态。

```text
workflow_graph_map_item_results
  - id
  - graph_run_id/owner_scope_id/owner_node_id
  - expansion_manifest_id
  - item_index/item_key_json/hash
  - build_id
  - scope_id                         nullable
  - outcome_state                   open | completed | errored | cancelled | fenced
  - exit_name/error_code/reason
  - output_ref/hash
  - completion_seq/fence_event_seq
  - row_version/created_at_ms/resolved_at_ms

UNIQUE(owner_node_id, item_index)
UNIQUE(owner_node_id, item_key_hash)
```

Seal map Expansion Manifest 时同时创建覆盖全部 index 的 `open` result slots。每个 slot 只允许一次 `open -> terminal outcome` CAS；尚未 materialize 的 quorum/fail-fast remainder 写 `fenced/scope_id=null`，build failure 写 `errored/scope_id=null`。Completed slot 的 `output_ref/hash` 指向 Child exit output envelope。Map owner 只能从这些有序 slots seal `MapItemResultsManifest` 并发布 `MapResultManifest`，不得内嵌成员业务值。

### Node、Attempt 与 Wait

```text
workflow_graph_nodes
  - id
  - graph_run_id/scope_id/node_key
  - node_type/capability_ref/capability_version/capability_hash
  - normalized_node_json
  - phase
  - trigger_state          unknown | true | false | error
  - input_state            open | sealed | impossible | error
  - trigger_cut_json/hash
  - input_snapshot_json/ref/hash
  - selected_edges_json
  - activation_event_seq
  - run_work_fence_epoch_at_activation/scope_work_fence_epoch_at_activation
  - terminal_status/code/child_exit
  - published_output_envelope_ref/hash/port_contract_hash
  - current_attempt_id/no
  - active_wait_id
  - controller_state       nullable；sealing | running | closing_remaining | settled
  - controller_decision_json/hash
  - controller_remaining_count
  - controller_reservation_group_id
  - row_version
  - ready_at_ms/terminal_at_ms/created_at_ms/updated_at_ms

UNIQUE(scope_id, node_key)

workflow_graph_node_attempts
  - id
  - graph_run_id/scope_id/node_id/attempt_no
  - continuation_kind      initial | execution_retry | quality_revision
  - parent_attempt_id/parent_attempt_no
                            initial 时均 null；其余为同 Node 前一 Attempt 的 typed composite self FK
  - phase                  preparing | dispatch_pending | running |
                           evaluating | terminal
  - execution_outcome      succeeded | failed | cancelled | null
  - quality_decision       pass | needs_revision | fail | pending | null
  - input_snapshot_json/ref/hash
  - selected_edges_json
  - context_pack_ref/hash
  - delegation_id/external_execution_id/action_name/query_id
  - dispatch_started_at_ms/dispatch_deadline_at_ms
  - execution_started_at_ms/execution_deadline_at_ms
  - timeout_event_id
  - artifact_refs/result_ref/hash
  - evaluation_ref/hash
  - quality_revision_feedback_ref/hash
  - retry_reason_code/error_code/error_detail_value_id/error_detail_hash
  - usage_summary_value_id/usage_summary_hash
  - acceptance_state       open | fenced
  - run_work_fence_epoch/scope_work_fence_epoch
  - resource_reservation_group_id
  - lease_owner/lease_token/lease_expires_at_ms/heartbeat_at_ms
  - evaluation_lease_owner/evaluation_lease_token/evaluation_lease_expires_at_ms
  - evaluation_attempt_count/evaluation_next_attempt_at_ms/evaluation_deadline_at_ms
  - row_version
  - created_at_ms/updated_at_ms/finished_at_ms

UNIQUE(node_id, attempt_no)
UNIQUE(delegation_id) WHERE delegation_id IS NOT NULL
UNIQUE(parent_attempt_id) WHERE parent_attempt_id IS NOT NULL
UNIQUE(graph_run_id, scope_id, node_id, id, attempt_no)

workflow_graph_retry_schedules
  - id
  - graph_run_id/scope_id/node_id
  - source_attempt_id/source_attempt_no/next_attempt_no
  - continuation_kind      execution_retry | quality_revision
  - quality_revision_feedback_ref/hash
  - retry_reason_code/retry_policy_hash
  - backoff_ms/eligible_at_ms
  - attempt_reservation_id
  - status                 scheduled | consumed | cancelled
  - row_version/created_at_ms/updated_at_ms

UNIQUE(node_id, next_attempt_no)
UNIQUE(source_attempt_id)

workflow_graph_waits
  - id
  - graph_run_id/scope_id/node_id
  - wait_type/contract_ref/contract_hash
  - correlation_key/correlation_key_hash/registration_key
  - payload_ref/hash
  - status                 registering | armed | resolved | timed_out | cancelled
  - armed_at_ms/deadline_at_ms/resolved_at_ms
  - registration_lease_owner/registration_lease_token/registration_lease_expires_at_ms
  - run_work_fence_epoch/scope_work_fence_epoch
  - resource_reservation_group_id
  - row_version/created_at_ms/updated_at_ms

UNIQUE(graph_run_id, contract_ref, correlation_key_hash)
UNIQUE(node_id)
```

Node-level `trigger_cut` 和 input snapshot 是所有 node type 的恢复事实源。Delegation/system attempt 只引用并复制对应 hash，不能重新选择 edge；join/wait/subgraph/expand/map/terminal 即使没有普通 attempt，也必须基于 node snapshot 执行。

Attempt continuation 组合必须由 SQLite CHECK 与 composite FK 同时约束：`attempt_no=1` 恰为 `initial + parent_attempt_id/parent_attempt_no=NULL`；`attempt_no>1` 恰为 non-initial、`parent_attempt_no=attempt_no-1`，且 composite self FK 证明 parent 属于相同 `(graph_run_id, scope_id, node_id)`。Schedule 保存 `source_attempt_id/source_attempt_no`，以同一 Attempt composite key 绑定同 Node，并以 CHECK 强制 `next_attempt_no=source_attempt_no+1`。`quality_revision` Attempt/Schedule 必须携带 parent/source 产生的同 ref/hash feedback envelope，`execution_retry` 必须为空；Attempt 恰在 `quality_decision=needs_revision` 时具有 feedback envelope，pass/fail/其他状态必须为空。Quality Schedule 的 `retry_reason_code` 固定为 closed code `quality_needs_revision`，不能由 Evaluator 提供。`UNIQUE(parent_attempt_id)` 与 `UNIQUE(source_attempt_id)` 分别保证一个 Attempt 最多产生一个实际后继和一个 Schedule；Schedule unique 与 CAS 保证 crash/recovery 不分叉 continuation chain。Context Pack ref/hash 必须与 canonical continuation、Node input snapshot 和 pinned binding 一致；同 Attempt 重建得到不同 hash 属于 integrity violation。

Dispatch timeout 与 execution timeout 分开持久化：前者从开始交给 provider 计时，后者只从 provider 接受或内部 worker 正式 `running` 时计时，不能让 pause/排队误耗执行时间。Watchdog 以 CAS fence `acceptance_state=open`，写 `attempt_execution_timeout` fact，再按 effect contract 创建 cancel/reconcile/compensation；late callback 不能发布 Node output，但经验证 receipt 仍可用于对账或补偿。

Retry 决策在失败事务中冻结绝对 `eligible_at_ms`、policy hash、reason、backoff，并为下一 Attempt 预留累计额度；重启后禁止重算 backoff，pause 不延长时间。到期后 schedule 以 CAS `scheduled -> consumed` 创建 exact next attempt。Lease expiry 只表示 Worker 失去提交权，不代表 execution timeout；有 external execution id 时必须先 reconcile。Effectful timeout 只有 pure、可证明幂等、已确认未执行，或已完成必要 compensation 时才能重试；外部状态未知进入 `action_required`。

Quality revision 使用同一 durable Schedule/CAS 协议，但不是 execution failure：T6a 必须先持久化 evaluator 的 `needs_revision`、validated feedback envelope、`continuation_kind=quality_revision` Schedule 和下一 Attempt 的 ledger reservation，随后才能结束当前 Attempt。Schedule 的 feedback ref/hash 是下一 Context Pack 的唯一 continuation 输入；重复 evaluator callback 若 decision/envelope hash 相同视为 duplicate，若不同则是 integrity violation。Quality revision 的 trusted backoff/eligible time 按 Capability 固定 Retry Policy 计算并冻结，不能由 Evaluator feedback 提供或延长 deadline。

Signal、timeout 和 cancel 只竞争同一个 `status=armed + saved work epochs + row_version` CAS，不要求外部 signal sender 持有 registration lease。首次成功者写 resolution event 并 terminalize node；相同 provider event 为 duplicate，不同事件竞争同一 Wait 时首个成功、其余 conflict，Wait 关闭后到达为 late。Arm 前 valid event 按 correlation pending，arm transaction 只消费最小 `inbox_seq`，其余按不可变 winner 归类。

### Edge Resolution、Candidate 与 Cut

```text
workflow_graph_edges
  - id/scope_id/edge_key
  - edge_kind              control | data
  - compiled_edge_json/hash

UNIQUE(scope_id, edge_key)

workflow_graph_control_edge_resolutions
  - edge_id PRIMARY KEY
  - state                  unresolved | taken | not_taken | error
  - decision_input_hash
  - decision_json/error_code
  - resolution_seq
  - resolved_at_ms/row_version

workflow_graph_data_edge_resolutions
  - edge_id PRIMARY KEY
  - state                  unresolved | available | unavailable | error
  - value_ref/hash/schema_hash/source_attempt_id
  - resolution_seq
  - resolved_at_ms/row_version

workflow_graph_terminal_candidates
  - id/scope_id/terminal_node_id
  - exit_name
  - output_snapshot_ref/hash
  - candidate_seq
  - created_at_ms

UNIQUE(scope_id, terminal_node_id)

workflow_graph_completion_eligibilities
  - id/scope_id/rule_id
  - phase                  early | settled
  - eligibility_event_seq
  - selected_candidate_id
  - fact_snapshot_json/hash
  - created_at_ms

UNIQUE(scope_id, rule_id)

workflow_graph_scope_close_requests
  - id/graph_run_id/scope_id
  - selected_rule_id/candidate_id       nullable for error/cancel
  - eligibility_event_seq               nullable for error/cancel
  - fact_snapshot_json/hash
  - node_frontier_json/hash
  - edge_frontier_json/hash
  - trigger_event_seq
  - fenced_work_epoch_at_creation
  - reason                 normal | engine_error | local_cancel |
                           workflow_cancel | parent_close
  - error_code/error_ref
  - cancel_payload_json/hash
  - request_hash
  - created_at_ms

UNIQUE(scope_id)
UNIQUE(scope_id, id)

workflow_graph_completion_cuts
  - id/graph_run_id/scope_id
  - close_request_id
  - selected_rule_id/candidate_id
  - outcome_kind/exit_name
  - output_ref/hash
  - completion_policy_hash
  - cut_event_seq
  - cut_hash
  - created_at_ms

UNIQUE(scope_id)
UNIQUE(close_request_id)

workflow_graph_child_completion_consumptions
  - id
  - child_scope_id/child_completion_cut_id
  - parent_scope_id/owner_node_id/map_slot_id
  - disposition            owner_output_published | map_slot_completed |
                           map_slot_fenced | non_publish_parent_fenced |
                           non_publish_owner_fenced
  - parent_work_fence_epoch
  - disposition_event_seq/created_at_ms

workflow_graph_subtree_fence_manifests
  - id/graph_run_id/source_close_request_id
  - scope_epochs_manifest_ref/hash
  - fenced_work_manifest_ref/hash
  - cleanup_effect_keys_manifest_ref/hash
  - subtree_fence_hash/created_at_ms

UNIQUE(child_scope_id)
UNIQUE(source_close_request_id)
```

Close request 是不再吸收 late ordinary fact 的 canonical 不可变观察面，`request_hash` 覆盖 reason、candidate、fact/frontier、trigger seq、创建时 work fence 与 payload；`fenced_work_epoch_at_creation` 只是历史事实，不要求永远等于 Scope 当前 epoch。Ancestor close 对尚无 request 的 descendant 创建 `parent_close`，对已有 normal/error/local request 只递增 work fence，不覆盖 candidate/reason/request hash。Cancel、Compensation 与 Finalizer 绑定该 Scope 唯一 winning `close_request_id`，不使用 work epoch equality 作为 cleanup authority。

Child outcome 与 Parent consumption 分开持久化。Child 可以完成自己的 cleanup/cut，但 Parent 已 fenced 时 disposition 为 non-publish；Child cut 与唯一 consumption disposition 同事务。Subgraph/expand 在 accepting owner 上发布 output，map 仅在 `controller=running + slot=open` 时填写 slot；`closing_remaining + slot=fenced` 只递减 barrier。SQLite 提交顺序唯一决定 Child Cut 与 Parent Fence 的竞态，已写 disposition 永不覆盖。Root cut 必须与 run close、context patch、workflow transition/history 和 checkpoint 同事务。

`cut_hash` 覆盖 scope/run id、close-request id/hash、selected rule/candidate、outcome/exit、output hash、completion policy hash 与 cut event seq 的 canonical payload；checkpoint 保存的 completion-cut hash 必须逐字节匹配该 row。

关系约束不能只靠应用层检查：`scope(plan_id, graph_run_id)` 必须引用同 run plan；child scope 的 `(owner_node_id, parent_scope_id, graph_run_id)` 必须引用 parent scope 内 owner node；build 的 compiled plan、target scope、owner node 必须属于同 run；edge/node/candidate/eligibility/request/cut 必须属于同 scope/run。`completion_cut(scope_id, close_request_id)` 复合引用 `close_request(scope_id, id)`；run 的 `root_close_request_id/completion_cut_id` 必须属于 `root_scope_id`。所有复合引用列都建立对应 unique key，禁止通过合法单列 id 拼出 cross-run lineage。

### Inbox、Late Result、Event 与 Effect Journal

```text
workflow_graph_inbox_events
  - inbox_seq INTEGER PRIMARY KEY AUTOINCREMENT
  - provider/provider_event_id/principal_ref
  - workflow_id/graph_run_id
  - contract_ref/correlation_key/correlation_key_hash
  - target_wait_id                 wait 尚未 arm 时 nullable；非空时真实 FK
  - payload_ref/hash/byte_length
  - ingress_authorization_ref/hash
  - binding_authorization_ref/hash
  - disposition            pending | accepted | rejected | duplicate |
                           conflict | late | unmatched_expired
  - received_at_ms/expires_at_ms/resolved_at_ms

workflow_graph_late_results
  - graph_run_id/scope_id/node_id/attempt_id/wait_id
  - source_event_id
  - payload_ref/hash
  - fence_reason
  - received_at_ms

workflow_graph_effect_operations
  - id
  - graph_run_id/scope_id/node_id/attempt_id
  - operation_key
  - key_strategy_json/hash
  - execution_lane         normal | close_cleanup
  - close_request_id       close_cleanup 时 required
  - effect_type
  - status                 intended | dispatched | succeeded | failed |
                           compensation_pending | compensated |
                           compensation_not_required | action_required
  - request_ref/hash
  - receipt_ref/hash
  - before_state_ref/hash
  - after_state_ref/hash
  - immutable_output_snapshot_ref/hash
  - compensation_ref/hash
  - lease_owner/lease_token/lease_expires_at_ms
  - row_version/created_at_ms/updated_at_ms

workflow_graph_effect_operation_claims
  - operation_id/claim_id/claim_spec_id
  - access                 read | write
  - fencing_token          write 时 required

UNIQUE(operation_id, claim_id)

workflow_graph_facts
  - id
  - graph_run_id/scope_id
  - event_seq
  - causal_event_seq/causal_wave
  - fact_kind
  - stable_object_kind/stable_object_id
  - fact_key
  - payload_ref/hash
  - created_at_ms

workflow_graph_events
  - graph_run_id/seq
  - scope_id/node_id/attempt_id
  - event_type/idempotency_key
  - payload_json/ref/hash
  - occurred_at_ms/created_at_ms

UNIQUE(provider, provider_event_id)
INDEX(graph_run_id, contract_ref, correlation_key_hash, disposition, inbox_seq)
UNIQUE(operation_key)
UNIQUE(graph_run_id, fact_key)
UNIQUE(graph_run_id, event_seq)      -- workflow_graph_facts
INDEX(graph_run_id, scope_id, event_seq)
INDEX(graph_run_id, causal_wave, fact_kind, stable_object_id)
UNIQUE(graph_run_id, seq)
UNIQUE(idempotency_key)
```

`workflow_graph_facts` 是 T3 fixed-point 的 immutable 权威输入/派生事实，不等同于通用审计 Event。`fact_kind` 的 Run Protocol v1 closed taxonomy 固定为 `node_terminal | node_output_published | wait_resolved | build_failed | control_edge_resolved | data_edge_resolved | trigger_decided | input_sealed | node_ready | node_skipped | terminal_candidate | completion_eligibility | orchestration_error`；增加或改变 kind 语义必须发布新 Run Protocol。每条 Fact 先消费 `facts_total`，再与对应 Event 使用同一 `event_seq` 原子插入，Fact 的 `(graph_run_id,event_seq)` 复合 FK 指向 Event 的 `(graph_run_id,seq)`；Projection delivery、Trace span、Command viewed、Notification attempt 等纯审计只写各自 Event/History，不创建 Fact。`fact_key` 按产生它的 immutable source fact/object/decision 派生，重复 T3 ingress 返回原 Fact，不重复计费。Event、effect journal、outbox 和 ledger 都使用稳定 idempotency key，并通过 run 的 `next_event_seq` 分配有序审计事件。

## 事务边界与 CAS

长操作不得在 SQLite transaction 中 await。关键事务如下：

```text
T0  task intake, routing and idempotent creation:
    strict-parse/freeze task envelope under a trusted creation domain;
    append immutable input revision; route against that exact revision/hash;
    append deterministic or capability routing attempt within pinned scope;
    resolver validates exact Recipe/Definition/entrypoint/execution-policy/
    Context Contract/Command Policy/schema/permission and rejects terminal entrypoint;
    freeze creation_intent_hash and intent-bound launch confirmation;
    derive and freeze WorkflowControlOwnership from authenticated principal/Feature/Automation;
    same creation key + same intent returns existing result; different intent conflicts;
    enforce workflow lifetime policy/runtime safety and freeze workflow deadline_at_ms;
    create workflow status=active/operational_state=healthy/workflow_revision=0/row_version=0,
    atomically acquire Recipe
    domain claims and invoke T1 core setup

T0p required-child provenance and preflight shell:
    require trusted transition effect + winning root close request;
    derive stable intake/revision/routing/creation ids and lineage creation domain/key;
    insert or verify exact workflow_transition Intake + revision 0 + deterministic
    Routing Attempt + creation_mode=required_finalization Creation Request;
    bind one Root Finalization Schedule to that Intake/Creation Request by real FK;
    do not create Child Workflow/Relation or acquire/handoff Claim before T8

T1  standalone activation ingress:
    require T0-created Workflow or trusted internal transition;
    require workflow.operational_state=healthy; CAS workflow status/current binding/row_version
    and lifetime counters while preserving current workflow_revision;
    create non-terminal activation +
    its unique initializing run and bind activation.graph_run_id;
    freeze definition/registry/source seed and create run ledger accounts;
    create materializing root scope shell(plan=null) + root scope build;
    bind run.root_scope_id/root_build_id and workflow.current_graph_run_id;
    allocate one initial checkpoint_version and write current-run watermark

T2a compile result persistence:
    outside tx resolve frozen locator and run pinned pure compiler;
    CAS build lease + source/input/compiler hashes + saved work epochs + row_version;
    insert immutable parent/static-child plan closure; set build=compiled;
    non-retryable failure sets build=failed and records the appropriate fact

T2b scope materialization:
    require run.control=running, operational_state=healthy, open work epochs and compiled build;
    root branch requires target shell=materializing; child requires active owner;
    reserve/commit scopes_total + nodes_total and other admission resources;
    root updates its existing shell; child inserts a new scope exactly once;
    insert nodes/edges + Run Manifest entry, bind build.scope_id=materialized;
    root run -> executing or child owner remains active awaiting child outcome

T3a fact and fixed-point reconcile:
    ingest one terminal/output/wait/build fact and reserve consecutive event seqs;
    in the same tx publish NodeOutputEnvelope, resolve all affected routes/data,
    freeze trigger/input cuts, create ready/skipped/error facts to fixed point;
    evaluate every early rule on each post-state fact, persist first eligibility;
    if control=running and operational_state=healthy, arbitrate unique close request
    in the same transaction

T3b settled close:
    require control=running, operational_state=healthy, scope active and fixed point;
    allocate one event seq and freeze the complete quiescent fact frontier;
    evaluate all settled rules together and insert the selected close request;
    if none applies, insert engine_error/no_exit_selected request in the same tx

T4  activate by node kind:
    require control=running + operational_state=healthy + scope active + matching work epochs;
    delegation/system -> separate attempt + active slot/usage reservations;
    wait -> waits_total + active_waits reservations, arm wait/register outbox;
    join/terminal -> publish structural envelope/candidate, no ordinary attempt;
    child owner -> seal Expansion Manifest + map slots + child builds, no attempt

T5  dispatch capability:
    require run.control=running + operational_state=healthy before external start;
    persist frozen context/input; resolve all claim slots and create delegation outbox
    or effect intent + operation-claim rows atomically;
    paused/resuming after claim leaves dispatch_pending held until running;
    execute outside tx using stable attempt/effect idempotency key

T6a internal worker result:
    CAS attempt phase + worker lease_token + saved work epochs + row_version;
    validate artifact/evaluation and branch on pass/fail/needs_revision;
    pass terminalizes attempt/node and publishes logical output once;
    fail terminalizes node as failed/quality_rejected without publishing candidate;
    needs_revision validates and persists typed feedback, then atomically either
    creates one quality_revision Schedule + next-attempt reservation and moves Node
    active->retry_wait, or terminalizes
    failed/quality_revision_exhausted with immutable exhaustion detail at Node ceiling;
    invalid/missing feedback terminalizes failed/evaluation_contract_violation;
    shared run attempt reservation failure terminalizes failed/attempt_budget_exhausted

T6b delegation callback:
    CAS delegation_id/external_execution_id + acceptance=open + saved work epochs
    + row_version; never require the external callback to possess a worker lease

T6c wait resolution:
    signal/timeout/cancel compete on status=armed + saved work epochs + row_version;
    registration lease only protects registration work, not external delivery

T6d durable deadline and retry timers:
    attempt watchdog fences acceptance=open at dispatch/execution deadline;
    write timeout fact and required cancel/reconcile/compensation effects atomically;
    execution-retry or quality-revision timer CAS scheduled->consumed at frozen
    eligible_at_ms, creates exact next attempt with canonical continuation/context hash,
    and moves Node retry_wait->active without re-sealing Node input;
    workflow watchdog submits stable T7c command
    workflow-deadline:<workflow_id>:<deadline_at_ms>

T6e operational remediation and integrity restoration:
    require Runtime Command authorization + expected blocker/run/workflow versions;
    append same-effect-key receipt/reconcile/claim/finalization or integrity evidence;
    CAS exactly one blocker open->resolved only after source-specific verification;
    blocker trigger recomputes highest remaining severity and atomically updates
    run/workflow operational_state without changing workflow.status;
    verify resulting cache equals remaining open blocker set;
    root_finalization_exhausted resolution must invoke and commit T8 in this same tx;
    preserve lifecycle/control/work epochs/deadline/ledger and resume only the lane
    permitted by the existing close/control state

T7a scope close primitive:
    normal eligibility, settled result, engine error and cancel all compete on
    UNIQUE(scope_id); allow materializing root shell only for setup error/cancel;
    insert target request; create parent_close request for every open descendant;
    set subtree closing, increment all scope work epochs, fence attempts/waits/builds;
    fill open map slots as fenced and release held controller reservations;
    root close sets run.lifecycle=closing and increments run work fence;
    write subtree fence manifest and deterministic close_cleanup effects keyed by
    each winning close_request_id in the same transaction

T7b child DB finalizer/consumer:
    after logical fences and required compensation successfully settle, insert child cut;
    action_required compensation keeps child closing and blocks the cut;
    subgraph/expand + accepting owner -> close child and terminalize owner;
    map running + slot open -> close child, fill slot + seq, reconcile policy;
    decision tx freezes selected set/slots and batch-T7a closes materialized losers;
    closing_remaining + slot fenced -> child cut + non-publish barrier decrement only;
    never overwrite a fenced slot with the loser's late child outcome;
    last loser cut/comp/reservation settles -> terminalize map owner;
    fenced parent/owner -> record immutable non-publish disposition without changing output

T7c cancel ingress:
    CAS workflow/current run/root scope and invoke T7a once with cancel reason;
    winner sets control=cancelling and freezes root_cancel_scope in that tx;
    T7a writes fence/cancel/compensation effects; T7c writes command audit;
    loser leaves control/cancel scope unchanged and records late command only

T8  root commit and outer transition:
    require workflow/run operational_state=healthy, root/run closing, matching request and subtree compensation successfully
    settled; action_required compensation blocks this transaction;
    insert unique root cut; close root/run; CAS row_version and increment workflow_revision;
    CAS source activation active->completed and freeze finished_at_ms;
    commit trusted context patch + transition history + checkpoint + outbox;
    if target is non-terminal, reuse T1 activation/run/root core setup in this tx:
    freeze target definition/registry/source seed, create ledger accounts,
    activation + initializing run + root shell/build and all root bindings;
    include old completed/new current watermarks in T8's single checkpoint row;
    terminal target creates + immediately completes a terminal activation, retains
    workflow.state_instance_id, clears current run and commits final workflow status;
    every required start_child_workflow effect must have a ready Root Finalization Schedule
    bound to a real transition Intake/Revision/Routing/Creation Request;
    revalidate exact pinned Recipe/routing scope/principal/input/creation key, Parent Recipe
    exact child set, Claim fencing and direct/depth/root-descendant budgets; atomically create
    all required children + relations + Intake/Creation=Request created + schedule success
    in this tx; any conflict leaves Cut, transition and child creation unchanged and
    advances the finite schedule attempt;
    best-effort child effect writes deterministic outbox and does not block parent T8
```

“T1 core setup”只指 non-terminal activation、run、ledger accounts、root shell/build、frozen snapshots 与 workflow binding。Standalone T1 在 core setup 后写自己的 initial checkpoint；T8 复用 core setup 时不得执行该 checkpoint 子步骤，而是把新 current watermark 合并进消费旧 cut 的同一个 transition checkpoint/version。Terminal activation 不调用 T1 core setup。T8 无论是否创建 target activation，都必须先以 source activation `status=active + row_version` CAS 完成 source activation；重复 T8 只能命中既有 cut/history/checkpoint，不能再次完成或改写 activation。外部入口不得绕过 T0 直接拼接 definition/state；Feature 明确按钮也使用单候选 routing scope 生成 deterministic decision。

T8 的 route source 由 root outcome kind 唯一决定：`completed` 使用 selected named exit 对应的 `exit_routes`；`errored` 使用 `on_error`；`cancelled/local_graph` 使用 `on_local_cancel`；`cancelled/workflow` 不读取 definition transition，不创建 terminal activation，固定终止 Workflow、清空 current run并写 final checkpoint/history。四种路径不能互相 fallback。Normal completed path 按 published Transition 的 typed Context Patch 更新 slots；error/local-cancel 默认 canonical no-op patch，除非其受信任 transition 明确定义 typed patch。Terminal target 必须创建 exact Definition/version 的 terminal activation；normal terminal 验证唯一 final output binding，errored terminal 验证 error code/binding，然后与 Workflow final fields、history 和 checkpoint 同事务提交。

Required Child Workflow creation 是 T8 的原子前置条件：Root 进入 closing 后按 close request/effect id 创建 durable、finite Root Finalization Schedule；Schedule Attempt 只运行 local T0/T1 的 pure resolution/preflight，不提前写 Workflow、Relation 或 Claim acquisition。全部 required schedule `ready` 后，T8 才在提交 Root Cut/transition 的同一事务中 exactly-once 创建 Child 并标记 schedule succeeded；冲突时不写 Cut/Child，只追加有限 retry，耗尽进入 `action_required` 并阻止 Root Cut。Best-effort child creation 随 T8 写 Outbox，失败只记录 delivery failure。Parent 在 terminal T8 需要把本地 authoritative Claim 交给 Child 时，先在同一事务将 Parent Claim released，再由 Child T0 acquire 并递增 fencing token；事务失败则 Parent Claim 仍 held。Parent 进入另一个 non-terminal State 时仍持有 Claim，Child 冲突按 required/best-effort 合同处理，不能隐式共享 exclusive token。

`T2a` 只持久化 immutable compile result，不消费 scope/node quota；`T2b` 才 materialize。Root build failure 在 shell 上走 `T7a(engine_error)`，随后由 T8 生成 root cut；paused 时先保存 failed build，resume transaction 再创建 request。Subgraph/expand build failure terminalize single owner；map item build failure 必须先填写对应 `errored/scope_id=null` slot，再运行 map policy。

`T3a` 的 “fact” 包括 candidate 与 node-terminal fact。同一事务内每个 ingress/derived durable fact 按确定性 fixed-point queue 分配不同的连续 event seq；queue key 固定为 `(causal_wave, fact_kind_rank, stable_object_id)`，`fact_kind_rank` 是 runtime format 常量。每写一个 fact 就基于该 post-state 计算 eligibility。Fact、由它首次产生的全部 early eligibility、以及 running 时的 close arbitration 是不可拆分原子单元；不存在异步补 eligibility 的正确实现。`T3b` 只在全部 node/edge/controller reservation 已按 quiescent 定义封闭时运行，并把 settled frontier 与 close request 绑定到同一个 event seq。

同一 T3a post-state 同时产生 engine error 与 normal eligibility 时，两者都保留审计事实，但 `engine_error` 先调用 T7a；只有不存在 error fact 时才按 eligibility 排序创建 normal request。这样 schema/routing/invariant error 不会被同事务内恰好出现的业务 candidate 掩盖。

`T7a` 对 target 插入 winning request；对每个尚无 request 的 open descendant 插入 canonical `parent_close` request，已有 close request 只保留并参与同一 subtree work fence，绝不覆盖其 candidate/reason。事务同时把 pending/ready/active controller work 收敛为 fenced terminal fact、关闭 open map slots、释放可释放 held reservation，并保存每个 Scope old/new epoch、被 fenced 对象与 cleanup effect key 的可验证 manifest。此后 finalizer 可以为每个 descendant 生成 cut，target cut 必须等待 descendant cut 与 required compensation 成功收敛，不能仅凭 epoch 已递增或 compensation 进入 `action_required` 就关闭 parent。Epoch 已更新但 manifest/cleanup 集不完整属于 quarantine，Recovery 不得猜测补齐原子事实。

普通 execution lane 只在 `running + active` 下凭 saved work epochs 执行；`close_cleanup` lane 在 `closing/cancelling` 下凭 winning `close_request_id` 执行 Cancel、Reconcile、Compensation 与 Finalizer。Ancestor 再次 fence 不会使已有 cleanup 失效。Cleanup 仍受 Claim、operation key、attempt ceiling 和 Outbox policy 约束，不能借 lane 绕过资源控制。

核心 CAS/fence 至少包含：

```text
workflow: id + status + operational_state + state_instance_id + current_graph_run_id +
          workflow_revision + row_version
activation:
          id + status + graph_run_id + row_version
run:      id + lifecycle + control + operational_state + work_fence_epoch + manifest_seq + row_version
scope:    id + lifecycle + work_fence_epoch + close_request_id + row_version
node:     id + phase + current_attempt_no + row_version
build submit:
          id + status + lease_token + source_hash + input_hash +
          compiler_snapshot_hash + saved run/owner-scope epochs + row_version
materialize root:
          build=compiled + run.control=running + root shell=materializing + epochs
materialize child:
          build=compiled + run.control=running + owner scope/node active + epochs
worker submit:
          attempt id + phase + lease_token + saved run/scope epochs + row_version
delegation callback:
          delegation_id + external_execution_id + acceptance=open +
          saved run/scope epochs + row_version
wait delivery:
          wait id + status=armed + saved run/scope epochs + row_version
child consumption:
          child cut + owner/controller state + map slot state/row_version +
          saved run/owner-scope epochs + owner row_version
edge:     id + state=unresolved + row_version
ledger:   account ids + row_versions + reservation idempotency key
eligibility: UNIQUE(scope_id, rule_id)
close:    UNIQUE(scope_id)
cut:      UNIQUE(scope_id)
```

Worker lease 只证明内部 worker 所有权，不能成为 delegation provider 或 signal sender 的凭据。任何 epoch/version CAS 失败者都在同一事务归类为 duplicate/late/conflict 并写 inbox/late-result audit，不能绕过 fence 再试一次状态写入。Build、attempt、wait 和 child callback 检查的是持久化创建时 epoch 与当前 run/owner scope epoch；仅比较 callback 自带值没有 fencing 意义。

Route group resolution、logical output publication、outgoing edge resolution、node terminal event 和 early eligibility evaluation 必须处于同一 fact transaction，不能暴露一半路由事实，也不能交给恢复器事后补齐。发现某个 persisted fact 缺少按当时 post-state 应有的 eligibility 时属于 invariant violation，必须 quarantine。Root completion cut、workflow transition history 和 source activation 分别有 unique constraint，作为 exactly-once transition 的数据库证明。

### SQLite Execution Profile

当前部署边界是本地单机、独立 Workflow Runtime 数据库、一个主 Runtime writer。权威存储固定为：

```text
data/workflow-runtime/workflow-runtime.db
data/workflow-runtime/blobs/
```

Production v1 固定发布 `local_single_user_sqlite@1`：`busy_timeout_ms=5000`、`page_size=4096`、`auto_vacuum=incremental`、`temp_store=memory`、`wal_autocheckpoint_pages=4096`、`journal_size_limit_bytes=67108864`、`cache_size_kib=32768`、`mmap_size_bytes=0`、`trusted_schema=false`、`recursive_triggers=false`、`read_uncommitted=false`、`locking_mode=normal`、`read_only_query_only=true`，并沿用类型中固定的 `journal_mode=wal/synchronous=full/foreign_keys=true`。Node/SQLite/source/compile-options/native module/release artifact 等 identity 字段在 exact Node `24.18.0` + `better-sqlite3@12.11.1` release build 上生成，不能手写或从开发机复制；G8 前该 Profile 只有 candidate 状态，不得伪造 `certified`。

`page_size/auto_vacuum` 是建库属性；修改必须新建/迁移数据库并重新认证。其他 PRAGMA 即使 SQLite 允许在连接上修改，Production 也只能通过新 immutable Profile、进程重启、DDL/smoke/benchmark 和新 certification key 应用，不能 hot reload。`auto_vacuum=incremental` 必须由 Blob/Store Coordinator 执行 bounded incremental-vacuum maintenance，禁止在普通请求事务内做无界 vacuum。

Task Intake/Revision、Routing/Creation、Registry Snapshot、Workflow/Run/Scope/Node/Attempt/Wait、Edge/Candidate/Close/Cut、Context/Checkpoint、Ledger、Domain Claim、Inbox/Outbox、Effect、Scheduler、Relation、Runtime Event 与 Value metadata 全部位于同一个 `workflow-runtime.db`，以保留 T0/T8 和全局 Claim/Ledger 的单事务约束。不得采用每 Workflow 一个数据库。

现有 `messages.db` 只保存 Chat、Wiki、Memory、Schedule、Feature UI 数据、运行中心 Projection/Comment 等非权威数据。两个数据库之间禁止原子双写或 attach-based 业务事务；Runtime 事务先写幂等 projection outbox，Projection Worker 再更新 `messages.db`。失败只使 UI 短暂 `syncing`，不回滚 Workflow，Projection 可由 Runtime Event 重建。独立 Agent/Tool Trace 可以继续使用专用 Trace Store；顶层 UI 合并不要求把非 Workflow Trace 写入 `workflow-runtime.db`。

只有 `WorkflowRuntimeStore` 可以获得 Runtime DB 写连接；API、Scheduler、Watchdog、Outbox Worker、Recovery、运行中心与外部 Worker 都通过 Command/Callback API 提交。耗时 Agent/tool/file/network work 一律在 transaction 外执行，SQLite 只串行提交短 CAS/fixed-point/fence transaction。首次创建空数据库时，Bootstrap 必须在创建任何 table/index 之前设置并验证 Profile 的 `page_size/auto_vacuum`，migration 完成后再由写连接切换并验证 `journal_mode=WAL`；这些 database-level 值不得由普通只读连接修改。所有生产、测试、只读/写连接都必须由统一 Connection Factory 创建，并按已验证的 `SQLiteExecutionProfile` 逐连接设置、读取回验完整 Profile PRAGMA；写连接还必须确保 `journal_mode=WAL`，只读连接只读取并验证已经是 WAL且强制 `query_only=ON`：

```ts
if (!readOnly) database.pragma('journal_mode = WAL');
assertPragma(database, 'journal_mode', 'wal');
database.pragma('synchronous = FULL');
database.pragma('foreign_keys = ON');
database.pragma(`busy_timeout = ${profile.busy_timeout_ms}`);
database.pragma(`temp_store = ${profile.temp_store.toUpperCase()}`);
database.pragma(`wal_autocheckpoint = ${profile.wal_autocheckpoint_pages}`);
database.pragma(`journal_size_limit = ${profile.journal_size_limit_bytes}`);
database.pragma(`cache_size = -${profile.cache_size_kib}`);
database.pragma(`mmap_size = ${profile.mmap_size_bytes}`);
database.pragma('trusted_schema = OFF');
database.pragma('recursive_triggers = OFF');
database.pragma('read_uncommitted = OFF');
database.pragma('locking_mode = NORMAL');
if (readOnly) database.pragma('query_only = ON');
```

Profile loader 必须先验证 numeric 字段为有限 JS safe integer；除显式允许 `mmap_size_bytes=0` 的字段外均为正整数，enum/boolean 为 closed value，再允许上述 interpolation。Connection Factory 还要读取并回验全部 Profile PRAGMA 和 database-level `page_size/auto_vacuum`，并验证 deployment profile、runtime surface、`process.platform/process.arch`、release artifact hash、Node executable hash/version、SQLite version/source id、compile options hash、`better-sqlite3` version/native module hash 与 Profile/Certification 完全一致；Production activation 还要验证 minimum machine class，并在同一数据卷临时目录运行 certification 固定的 startup smoke harness，保存结果 hash/duration。不能只设置 PRAGMA 而忽略 identity fields，也不能自动改写数据库来迎合不匹配的 Profile。Repository 使用 exact `.nvmrc=24.18.0`、`packageManager=npm@11.16.0` 和 CI release image 固定 Node/npm patch identity；`package.json engines` 只能表达开发兼容性，不能作为 certification identity。

关键 CAS transaction 使用 `BEGIN IMMEDIATE`，避免读取状态后才在写阶段失败；所有 composite FK/unique constraint 必须由 SQLite 实际执行。需要 WAL、durability、Writer 竞争或 crash 行为的测试必须使用真实文件 SQLite，不能用 `:memory:`。Runtime DB 与 Blob 目录作为一组恢复资产，备份使用 SQLite Backup API/一致性快照；恢复后执行 blob length/hash 与 orphan scan。

T3/T7 继续保持不可拆分原子协议。T3 只增量处理本次影响的 Node/Edge/Fact，索引 source node/source port/target port/guard，使用确定性 fixed-point queue，目标复杂度接近 `O(affected nodes + edges + facts)`；禁止每个 Fact 重扫全 Scope或每 Edge 一次全表查询。T7 使用 indexed `parent_scope_id + Recursive CTE`、临时 subtree-id 表与 set-based UPDATE/INSERT，禁止 JavaScript 递归逐 Scope 查询、超长动态 `IN (...)`、逐 descendant transaction 或事务内等待 cancel ACK。Closure Table 只有真实 benchmark 证明必要时才引入。

发布门禁按 versioned `RuntimeSupportedLimits` 测试，而不是固定 100 nodes/items。T3 至少覆盖长链、宽 fan-out/fan-in、diamond、route-group、completion-heavy、condition-heavy；T7 至少覆盖 deep/wide tree、large/nested map、mixed lifecycle 与 effect-heavy subtree；Root Finalization/T8 至少覆盖最大 required-child 集合、Claim handoff 竞争、retry/exhaustion 和全成或全不变。使用真实文件 SQLite、上述生产 PRAGMA/索引，记录 transaction duration、读写行、derived facts、subtree scopes、required-child 数量、WAL 增量与内存峰值。

Benchmark 分为 Smoke、Supported Limit、Beyond Limit 与 25/50/100% Scaling；同时设置复杂度曲线、正确性不变量和参考机器上的绝对短事务预算。若合法最坏事务超出预算，第一版只能降低高于下述 Product Floor 的 Safety/Supported Limit，不能跌破 floor，也不能静默拆分 T3 fixed point、T7 subtree fence 或 T8 required-child 原子提交。未来需要超大 Graph 时必须另行设计不可见 generation barrier，而不是作为普通性能补丁。

Production v1 的 `local_single_user_product_floor@1` 是发布最低能力，不是建议配置；certified profile 可以更高，不能更低：

| Dimension | Minimum certified value |
| --- | ---: |
| `max_scopes_total` | 128 |
| `max_nodes_total` / `max_nodes_per_scope` | 1024 / 128 |
| `max_edges_total` / `max_edges_per_scope` | 4096 / 512 |
| `max_map_items_total` / `max_items_per_map` | 256 / 128 |
| `max_attempts_total` | 4096 |
| `max_waits_total` | 512 |
| `max_builds_total` | 512 |
| `max_effect_operations_total` | 2048 |
| `max_facts_per_transaction` | 16384 |
| `max_frontier_bytes` | 16777216（16 MiB） |
| `max_nesting_depth` | 8 |
| `max_required_child_creations_per_t8` | 8 |

基准参考等级固定为 Apple Silicon M2 或更高、16 GiB RAM、internal APFS SSD、AC power、release build、无并发 benchmark 干扰。每个形状先 warmup 10 次，再测量至少 100 次；记录 p50/p95/p99/max、WAL bytes、peak RSS 和受影响行。Supported Limit 必须满足 `T3 p99 <= 250 ms`、`T7 root-fence p99 <= 1000 ms`、`T8 required-child p99 <= 500 ms`，且 max 不超过对应预算的 2 倍；Beyond Limit 必须在原子写入前确定性拒绝。Certification 固定 versioned minimum-machine-class 与 startup-smoke harness；Production activation 在同一数据卷的临时 DB 上运行 bounded smoke，不接触 Runtime DB，结果超过 `startup_smoke_max_duration_ms` 时 fail-closed。参考机器更快不能降低功能 floor，生产机器未通过 machine-class/smoke preflight 则使用针对该机器另行认证的 profile。

若任何 floor shape 无法在预算内通过，Production Gate 保持关闭并重新审查 schema/index/protocol；不能再按原文的“直接降低到更小认证值”静默上线。只有高于 floor 的可选上限可以根据 benchmark 下调。未来需要突破不可拆 T3/T7/T8 的规模时，必须发布新 Run Protocol，而不是牺牲原子性。

## Retry、Pause、Cancel 与 Compensation

- `max_attempts` 包含首次 Attempt；每次 execution retry 或 quality revision 都创建新 immutable Attempt。
- Workflow 在 T0 冻结 `deadline_at_ms = started_at_ms + effective_max_duration_ms`。Durable watchdog 到期后用稳定 command key 调用 T7c 全局策略取消；若 normal close request 先提交则 deadline 是 late command，反之 deadline 先赢则后续 normal completion 只审计。Workflow deadline 不走业务 `on_error/on_local_cancel`。
- Retry reason 使用 catalog 定义的结构化 taxonomy。`retry_request` 省略时使用 capability trusted policy；显式 request 的 `max_attempts` 与所有 non-null global/state/capability business ceiling及 `execution.max_attempts_per_node` safety ceiling 取最小值，形成 frozen `effective_node_max_attempts`；null business ceiling 不注入默认次数，但 safety ceiling 始终 finite。`run.max_attempts_total` 是多个 Node 共享的独立累计 account，不预先并入单 Node 数字。`retry_on` 省略时继承 capability allowlist，显式空数组禁用 execution retry，但不改变 Capability 是否允许 quality revision；把总 `max_attempts` 收紧为 1 可以同时禁止任何真实重执行。Backoff 只来自 trusted capability，并受 `execution.max_retry_backoff_ms` 限制。
- execution failed 只有 reason 位于 effective `retry_on` 且仍有 Node/Run 额度时才创建 `continuation_kind=execution_retry` Schedule。Evaluator `fail` 表示候选确定性不可接受，立即以 `failed/quality_rejected` terminalize Node，不进入 retry；Evaluator `needs_revision` 只由 non-null `quality_revision_policy` 仲裁，并创建 `continuation_kind=quality_revision` Schedule。
- 合法 `needs_revision` 到达 `attempt_no = effective_node_max_attempts` 时，T6a 在同一事务保存最后一个 feedback envelope、创建 `QualityRevisionExhaustionDetailV1` 作为 Attempt error detail、terminalize Attempt 和 Node 为 `failed/quality_revision_exhausted`，并按正常 T3 发布 Node terminal fact/解析 failure route；candidate result/artifact 继续作为 Attempt 审计事实，但不得发布为 logical Node output。该结果是预期业务 failure，不走 root `on_error`，也不能由 manual retry 重新打开。
- 若 `attempt_no < effective_node_max_attempts`，但下一 Attempt 对 `run.max_attempts_total` 的原子 reservation 失败，则 terminalize `failed/attempt_budget_exhausted` 并保存结构化 resource limit detail；它不能谎报 `quality_revision_exhausted`。Workflow deadline、global cancel、effect unknown/action-required 与 integrity quarantine 继续使用各自既有协议，均不得改写为 quality exhaustion。
- Evaluator pending 在同一 attempt 上使用独立 lease/retry/deadline，不重复 agent/action；capability 中 non-null business次数/deadline 进一步收紧 `execution.max_evaluator_attempts_per_evaluation/max_evaluator_duration_ms` 与 run total safety ceiling，不注入隐藏默认业务 ceiling。
- Node terminal 后不重开；重新运行 root graph 通过外层 transition 创建新 activation/run。
- Pause CAS workflow/run 并传播 scheduling barrier；paused 时允许 result、signal/timer/timeout、terminal fact、edge resolution、trigger/input seal、`ready/skipped` 和 early eligibility，禁止 claim、scope materialize、尚未 dispatch 的 execution 与普通 completion close request。显式 local/global cancel 仍可通过 T7c 抢占 paused run。Ready node 可以形成但不能启动；already-running external work 不因 pause 自动取消。
- Resume command CAS `paused -> resuming`。Resuming barrier 内先按 `(error_event_seq, scope_depth, stable_fact_id)` 处理 setup/orchestration error，再对全 run early eligibility 按 `(eligibility_event_seq ASC, same_event_priority DESC, rule_id ASC, scope_id ASC)` 竞争，最后执行 settled arbitration，循环到 fixed point 后才 CAS `resuming -> running`。每个 winning request 仍在其 T7a 事务完成 subtree fence；整个 drain 可以拆成多个短事务，crash 后从 `resuming` 恢复，期间不得 claim/materialize/dispatch。较早 child eligibility 不会被较晚 ancestor request 改写。
- Manual node skip 与 retry-wait advance 只允许 graph paused 且携带 expected versions；Cancel 不要求先 Pause，而是直接通过 T7c/T7a 的 Close Request CAS 和 subtree fence 原子抢占。Skip 只允许 Published Command Policy 明确授权、Node 尚未 terminal 且不存在 outcome-unknown effect；它发布 `skipped/manual_skip` fact 并按正常 T3 协议收敛，不能伪造 output。Active effect 必须先 fence/cancel/reconcile，不能直接 skip。Manual retry 只能消费已有 schedule、追加同 effect-key remediation 或重新 reconcile，不能重新打开 terminal node，也不能绕过原 Policy/Safety/Ledger ceiling。
- Runtime 不提供任意 `returnWorkflowToStage` 或“重开 terminal State/Node”命令。业务返工、回炉和回退必须由 published Definition 的 named exit/transition 明确授权，并创建新的 State Activation/Graph Run；旧 activation、cut 和 artifact 保持不可变。Console 只能触发 Definition 声明的 remediation/rework command，不能指定任意 target state。
- Local graph cancel 与 global workflow cancel 使用 T7c 原子入口；parent early close 使用 T7a 的 subtree fence。Normal/error/local/global cancel 竞争同一个 close-request unique CAS，输家只写已晚到的 command audit，不能改写已冻结路由。
- Active compensatable effect 在 cancellation policy 要求时创建 compensation outbox；scope 只有所有 required compensation terminal 后才能完成 closing。
- Required compensation 的成功 terminal 状态只有 `compensated`，以及合同证明原 operation `not_applied` 时的 `compensation_not_required`。`failed/dead_letter/action_required/unknown` 均不满足 Cut barrier。普通 retry、skip、engine-error route 或数据库手改不能跳过 barrier；无法恢复时只能走不生成 Cut/outcome 的 administrative abandon。
- Workflow terminal transaction 在全部 required effect/compensation 收敛后把 held domain claims 标记 `release_pending` 并写 deterministic release effect；本地 claim 可同事务 released。`action_required/quarantined` 默认继续持有 claim，人工 abandon 是否释放必须由 Recipe risk policy 显式允许并保留 fencing audit。
- 晚到 completion、signal 或 outbox delivery 只记录 audit，不得越过 completion fence。

## Workflow Runtime Command 授权与审计

运行中心、Feature Page、Feature Host API、External API 与 Automation 都只是入口，统一调用 Workflow Runtime Command Gateway；任何入口都不得直接写 Runtime 表或通过 Projection 改变权威状态。Feature UI 负责领域任务发起、领域产出解释和 typed Business Command；运行中心负责跨 Feature 查询、统一待处理、通用 Runtime Command、诊断和审计，不复制 Feature 的完整业务工作面。

```ts
type WorkflowCommandActorKind =
  | 'human'
  | 'feature_service'
  | 'automation'
  | 'system';

interface WorkflowRuntimeCommandBase {
  command_id: string;
  idempotency_key: string;
  expected_row_version: number;
  reason_code: WorkflowRuntimeCommandReasonCode;
  reason_text?: string;
  evidence_refs: string[];
}

type WorkflowRuntimeCommand = WorkflowRuntimeCommandBase & (
  | { command_type: 'pause_run'; target: { run_id: string } }
  | { command_type: 'resume_run'; target: { run_id: string } }
  | { command_type: 'cancel_run'; target: { run_id: string } }
  | { command_type: 'cancel_workflow'; target: { workflow_id: string } }
  | { command_type: 'skip_node'; target: { node_id: string } }
  | { command_type: 'advance_retry_schedule'; target: { retry_schedule_id: string } }
  | { command_type: 'reconcile_effect'; target: { effect_operation_id: string } }
  | { command_type: 'submit_effect_receipt'; target: { effect_operation_id: string } }
  | { command_type: 'verify_effect_not_applied'; target: { effect_operation_id: string } }
  | {
      command_type: 'remediate_operational_blocker';
      target: { operational_blocker_id: string };
    }
  | { command_type: 'restore_integrity'; target: { operational_blocker_id: string } }
  | { command_type: 'request_administrative_abandon'; target: { workflow_id: string } }
  | {
      command_type: 'confirm_administrative_abandon';
      target: { workflow_id: string };
      confirmation_ref: string;
    }
);

type WorkflowRuntimeCommandReasonCode =
  | 'operator_requested'
  | 'investigation'
  | 'superseded'
  | 'invalid_input'
  | 'no_longer_needed'
  | 'dependency_recovered'
  | 'credential_restored'
  | 'receipt_recovered'
  | 'provider_reconciled'
  | 'not_applied_verified'
  | 'backup_restored'
  | 'hash_revalidated'
  | 'deadline_enforced'
  | 'safety_enforced'
  | 'unrecoverable_state'
  | 'external_effect_unverifiable'
  | 'data_loss_accepted';
```

Actor、权限、认证 Session 与 Delegation Chain 由服务端生成，客户端不得自报 `actor_ref/roles`。本地单用户部署使用稳定 `human:local-owner`，不能把所有人工操作记为 system。Feature Page 中的用户点击仍以 Human Actor 记录，并保存 `entrypoint=feature_page/source_feature_id`；Feature 后台自动操作使用独立 `feature_service:<id>`。Feature 代表用户调用时保存 `actor=human` 与 `delegated_via=feature_service`，有效权限取用户权限、Feature Manifest command ceiling、Published Recipe/Command Policy 与当前状态 guard 的交集，避免 confused deputy。

Runtime permission catalog 固定为：

```text
workflow.operate
workflow.cancel.own
workflow.cancel.any
workflow.node.skip
workflow.retry.advance
workflow.effect.remediate
workflow.blocker.remediate
workflow.integrity.restore
workflow.administrative_abandon
```

`pause_run/resume_run` 要求 `workflow.operate`；`cancel_run/cancel_workflow` 要求服务端 ownership resolver 证明 `workflow.cancel.own`，否则要求 `workflow.cancel.any`；`skip_node`、`advance_retry_schedule`、三种 Effect remediation、普通 T6e、integrity restore 和两阶段 abandon 分别要求同名最小权限。`human:local-owner` 拥有全部上述权限但仍受 Published Command Policy、Feature ceiling、state guard 与 expected version 约束。Feature 代表 Human 时 Manifest ceiling 可以声明 operate/cancel-own/skip/retry/effect/blocker remediation，不能声明 integrity restore 或 abandon；后台 Feature Service/Automation 默认无控制权限，只能显式获得 `cancel.own`。Deadline Watchdog 使用绑定 `cancel_workflow + deadline_enforced + due-target predicate` 的专用 System Grant，不获得通用 admin authority。

Command Catalog 还固定 denial code 为 `permission_denied | feature_ceiling_denied | command_policy_denied | state_guard_failed | target_not_found | target_kind_invalid | row_version_conflict | evidence_invalid | confirmation_required | idempotency_conflict | late_command`。每个 command type 的 allowed reason code、required evidence schema、target kind、permission 和 state guard 都在 Contract Pack 逐项列出；任意开放字符串或模块私有 reason fallback 都非法。

Definition/Recipe 固定 versioned `WorkflowCommandPolicy`，声明 manual skip、retry advance、允许的 cancel scope、receipt remediation contract、administrative abandon 与 claim disposition。UI 根据 Projection 展示按钮仅是提示；Gateway 必须在权威事务内重新检查 Actor permission、resource scope、Feature ceiling、Published Policy、expected row version 与当前状态。

```text
workflow_runtime_commands
  - command_id
  - idempotency_domain/idempotency_key
  - command_type
  - workflow_id/run_id/node_id/retry_schedule_id
  - effect_operation_id/operational_blocker_id
  - expected_row_version
  - reason_code/reason_text_ref/evidence_manifest_ref
  - request_hash
  - canonical_result_ref/hash
  - created_at_ms/finalized_at_ms

workflow_runtime_command_invocations
  - id/command_id/invocation_no
  - submitted_request_hash
  - actor_ref/actor_kind/auth_session_ref
  - entrypoint/source_feature_id/delegation_chain_ref
  - required_permission
  - command_policy_ref/command_policy_hash
  - authorization_result      allowed | denied
  - execution_result          applied | denied | conflict | duplicate | late
  - target_before_hash/target_after_hash
  - resulting_event_seq/close_request_id/effect_ref
  - requested_at_ms/decided_at_ms/applied_at_ms

workflow_runtime_command_confirmations
  - id/request_command_id/workflow_id
  - actor_ref/auth_session_ref
  - expected_workflow_row_version
  - request_hash/evidence_manifest_ref/evidence_manifest_hash
  - status                  pending | consumed | expired
  - expires_at_ms/consumed_at_ms/row_version

UNIQUE(idempotency_domain, idempotency_key)
UNIQUE(command_id, invocation_no)
UNIQUE(request_command_id)
CHECK (exactly one typed target column is non-null)
CHECK (command_type and non-null target column match the closed Command Catalog)
CHECK (Confirmation status/time fields are consistent and expires_at_ms is request time + 300000)
```

`scope_id/attempt_id/wait_id/root_finalization_schedule_id` 第一版不是 Runtime Command target；相关恢复通过 Effect Operation 或 source-typed Operational Blocker/T6e 执行。API 的 discriminated target 由 Gateway 展开为上述真实 FK，权威 Schema 不保存开放 `target_ref`。

`idempotency_domain` 由 Gateway 根据 Actor/Feature/API credential 的可信 namespace 派生，客户端不能自报。相同 domain/key/request hash 返回 Header 的 canonical 原结果，并追加 `duplicate` Invocation；同 domain/key 不同请求追加 `conflict` Invocation 并返回 `idempotency_conflict`。首次 applied/denied/late 结果同样写 Invocation，Header 只保存 canonical request/final result，不覆盖历史。这样唯一幂等请求与“每次 authenticated 调用都追加不可变审计”可以同时成立。

命令语义固定：

- Manual Skip 不能跳过 required compensation、outcome-unknown effect 或填写虚假 Output。
- Retry 不能重开 terminal Node/Attempt；业务返工使用 Definition 发布的 typed Rework Command 创建新 Activation/Run。
- Receipt Remediation 只能按原 effect key/external id Reconcile、提交 Adapter 可验证 Receipt 或 immutable before/after snapshot、或证明 not-applied 后重投；人工文字只能是审计备注，不能直接把 Mutable Effect 改成 succeeded。
- Operational Remediation 必须以 `operational_blocker_id` 为 target，并调用 T6e；命令成功只关闭已完成 source-specific verification 的 blocker。关闭最后一个 blocker 时才原子恢复 operational state=`healthy`，但不改写 Workflow business status；存在 quarantine blocker 时不得因较低严重度 remediation 降级为 `action_required`。
- Administrative Abandon 只允许专门权限、强制 reason/evidence 与 intent-bound 二次确认。`request_administrative_abandon` 只创建绑定 actor/session、Workflow/expected row version、canonical request hash 与 evidence hash 的单次 Confirmation，TTL 固定 `300000 ms`，不修改 Workflow；`confirm_administrative_abandon` 必须由同一 authenticated Human Session 在 TTL 内消费且只能成功一次。AI、Feature Service、Automation 与 System Actor 均不能批准。成功事务停止 scheduler、将当前 non-terminal activation `active -> abandoned` 并标记 Run/Workflow `administratively_abandoned`，但不生成 Completion Cut、不伪造 normal/error/cancel、不触发正常 transition。Held Claim 默认保留；只有 Published Abandon Policy 允许且已建立可信新 Fence/处置证明时才可释放。
- Feature 自定义“批准、拒绝、重新生成、接受交付物”等业务操作必须发布 typed Business Command Contract，并 lower 为 Signal、新 Activation 或 Published Rework；不得映射成任意状态跳转或 Admin 数据修改。

## Outbox、Lease 与恢复

Outbox 是 at-least-once，但 Delivery Policy 必须是可信、版本化、所有次数与时长均有限的 Registry Resource；Graph/Planner 不能选择 Adapter、Policy、Lane 或 Dead-letter 后果。Capability、Wait Contract、Notification Contract、best-effort Child Transition Effect 与 Core System Effect 等所有 Outbox producer 在 Publish 时固定 exact Policy Ref；Effect 创建时把有效 Policy Snapshot/Hash 写入 Outbox，恢复不读取 latest。Required Child Transition Effect 只绑定 Root Finalization Policy，不属于 Outbox producer。

```ts
interface WorkflowOutboxDeliveryPolicy {
  ref: VersionedRef;
  max_delivery_attempts: number;      // 包含第一次调用
  max_reconcile_attempts: number;
  delivery_duration_ms: number;
  attempt_timeout_ms: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  backoff: 'fixed' | 'exponential';
  deterministic_jitter_micros: number;
  honor_retry_after: boolean;
  retryable_error_codes: string[];
  permanent_error_codes: string[];
  policy_hash: string;
}

interface OutboxEffectContract {
  effect_type: string;
  adapter_ref: VersionedRef;
  delivery_policy_ref: VersionedRef;
  delivery_lane: 'normal_execution' | 'close_cleanup' | 'system_projection';
  reconciliation:
    | { type: 'not_required' }
    | { type: 'by_effect_key'; reconcile_action_ref: VersionedRef };
  idempotency: 'provider_key' | 'external_lookup' | 'best_effort';
  delivery_requirement: 'required' | 'best_effort';
}
```

第一版发布五个基线 Profile；修改数字只能发布新 Policy Version，不改变已有 Effect：

| Profile | delivery/reconcile attempts | duration / attempt timeout | exponential backoff | 典型用途 |
| --- | --- | --- | --- | --- |
| `normal_delivery@1` | 8 / 4 | 15 min / 60 sec | 1 sec -> 60 sec | dispatch、wait registration |
| `notification@1` | 5 / 2 | 15 min / 30 sec | 2 sec -> 120 sec | notification、card |
| `control_cleanup@1` | 16 / 8 | 24 h / 60 sec | 2 sec -> 10 min | cooperative cancel、普通 cleanup |
| `critical_cleanup@1` | 32 / 16 | 72 h / 5 min | 5 sec -> 30 min | required compensation、claim release |
| `projection@1` | 20 / 4 | 24 h / 30 sec | 5 sec -> 5 min | 运行中心/Feature projection |

所有 Profile 使用 `deterministic_jitter_micros=200000`（±20%）。Effective attempts/duration 取 exact Policy Snapshot 与 finite Runtime Safety Ceiling 的更严格值并在创建时冻结。Normal lane 还受 Workflow deadline 限制；close-cleanup 使用独立 cleanup deadline，可以在 Workflow deadline 后继续；system projection 不回滚权威 Workflow。Backoff 固定为 `min(max_backoff, initial_backoff * 2^(attempt_no-1))` 加由 `effect_key + attempt_no` 决定的 deterministic jitter。Provider `Retry-After` 是最短等待时间；若超出最终 deadline 则停止自动投递。Circuit Breaker 未实际调用 Provider 时不增加 attempt，但 deadline 继续流逝。

```ts
type OutboxDeliveryResult =
  | { kind: 'delivered'; receipt_ref?: string; external_id?: string }
  | { kind: 'retryable_failure'; code: string; retry_after_ms?: number }
  | { kind: 'permanent_failure'; code: string }
  | { kind: 'unknown_outcome'; code: string; external_id?: string };
```

Adapter 禁止让 Runtime 解析异常字符串。`unknown_outcome` 表示外部可能已成功，必须进入 `reconciling` 并按 effect key/external id 查询，禁止立即重投；有限 Reconcile 耗尽后进入 `action_required`。Worker Crash 若已开始外部调用但无结果同样按 unknown outcome 处理，只有合同明确证明同 key 安全重放时才能直接 redeliver。

```text
workflow_outbox
  - id/effect_key UNIQUE
  - workflow_id/attempt_id/wait_id/effect_operation_id/domain_claim_id/
    projection_target_ref
  - aggregate_row_version             external projection target 时为 null
  - effect_type/adapter_ref
  - delivery_policy_ref/delivery_policy_hash/policy_snapshot_ref
  - delivery_lane/delivery_requirement
  - payload_ref/payload_hash
  - status                 pending | processing | reconciling |
                           succeeded | dead_letter | action_required
  - delivery_attempt_count/reconcile_attempt_count
  - next_attempt_at_ms/deadline_at_ms
  - lease_owner/lease_token/lease_expires_at_ms
  - last_result_kind/last_error_code
  - created_at_ms/delivered_at_ms/updated_at_ms

workflow_outbox_attempts
  - id/outbox_id/history_seq
  - attempt_kind           deliver | reconcile
  - kind_attempt_no
  - adapter_ref/adapter_hash/policy_hash
  - lease_owner/lease_token
  - request_ref/request_hash
  - result_kind/result_code
  - receipt_ref/receipt_hash/external_id
  - started_at_ms/finished_at_ms/next_attempt_at_ms

UNIQUE(outbox_id, history_seq)
UNIQUE(outbox_id, attempt_kind, kind_attempt_no)
CHECK (exactly one typed aggregate target is non-null)
```

`history_seq` 给完整 Attempt History 排序；`kind_attempt_no` 分别对应 `delivery_attempt_count/reconcile_attempt_count`。两种 attempt 都从 1 开始，但不会因共用一个 `attempt_no` namespace 发生唯一键冲突。

Dead Letter 只表示自动投递停止，不统一决定 Graph 状态，也不移动/删除原 Outbox Row。业务后果由可信 `effect_type` 固定：

| Effect | Dead-letter/action-required 后果 |
| --- | --- |
| Capability dispatch | 原子生成 Attempt failure，再由 Node Retry Policy 仲裁；unknown outcome 保持 action-required |
| Wait registration | Wait/Node `failed/wait_registration_failed`；Signal 已赢得 CAS 时迟到失败只审计 |
| Best-effort child creation | 只记录 delivery failure；Parent Workflow 不回滚、不重开 |
| Cooperative cancel | 不重开 Graph，创建 operational action/warning |
| Required compensation | Run action-required，阻止 Cut 并继续持有 Domain Claim |
| Notification/Card | Workflow 不回滚，只记录 Delivery Failure |
| 运行中心/Feature Projection | Projection degraded，可由 Runtime Event 重建 |
| Domain claim release | Claim 保持 `release_pending`，不得错误授权新 holder |

Dead-letter 与相应 attempt/wait/effect/ledger 推进必须同事务完成；表中后果为 action-required 或 quarantine 时还必须在该事务幂等创建 source-typed Operational Blocker 并更新 operational state，不能只改 Outbox status。暂停时不领取新的 normal-delivery；close-cleanup 与 system-projection 继续。Manual remediation 只能在原 Attempt History 后使用 blocker 创建时冻结的剩余有限预算和相同 effect key，不能清零历史、替换 policy 或延长 deadline；预算耗尽后只允许验证已存在 receipt/result，不再执行外部 mutation。成功后由 T6e 关闭对应 blocker。

Required `start_child_workflow` 不创建 Outbox row，也不进入本表的 dead-letter 协议；它只通过 Root Finalization Schedule/Attempt 的 finite `ready -> succeeded | exhausted` 协议收敛，`exhausted` 令 Root 保持 `action_required` 并阻止 Cut。Best-effort child 才使用 Outbox，且 delivery failure 不影响已提交的 Parent Cut/transition。

Delegation/action/wait/cancel/compensation adapter 必须接受稳定 effect key。Delegation id 从 graph attempt 确定性派生；相同 attempt 重投使用相同 delegation/effect id，adapter 应按 idempotency key 返回已有 execution 或允许按 external id 对账。Crash 发生在外部成功、outbox 标记成功之前时允许同 key 对账/重放；物理执行可能重复，Runtime 只承诺外部投递 at-least-once，以及通过 provider event id inbox 去重、attempt acceptance CAS 和 unique key 使数据库 node/output/edge/cut/transition effect exactly-once。无法幂等、无法补偿且存在不可逆 effect 的 capability 不得注册。

恢复顺序：

在 Graph 恢复前先恢复 creation plane：校验 Task Intake/routing attempt/creation request hash、Recipe/Definition/execution-policy exact refs、`creation_key -> workflow_id` 唯一性和 domain claim fencing token；`needs_clarification/awaiting_confirmation` intake 保持 durable pending，`created` intake 不重复创建。Pinned executor implementation 不可用时幂等创建 `resource_or_credential_unavailable` Operational Blocker并进入 `action_required`，不能 fallback 到新版本。

1. 校验 workflow activation/current run、definition/registry snapshot、root build/nullable root plan、Run Manifest hash chain、ledger chain 和 completion-cut uniqueness。
2. 优先处理已有 close request 的 scope/run：验证 request transaction 已持久化完整 subtree work-fence manifest 与 close-cleanup effects，只重放已存在 key 的 outbox delivery；若原子 manifest/effect 缺失则 quarantine，恢复器不能事后“重建”原始事务。
3. Run control 为 `resuming` 时先继续 deterministic resume drain；在 pending error/eligibility/settled fact fixed point 前不得 claim/materialize/dispatch。随后回收 Scope Build snapshot/compiler lease，只读取 frozen seed/locator，相同 source/input/compiler hashes 重跑 pinned pure compiler。Paused/resuming run 可以停在 `compiled`，不能 materialize。
4. 验证 scope ownership tree、unique child key、plan/input hash、sealed Expansion Manifest、map result slots 和 ledger account cache 守恒。
5. 回收 preparing attempt；基于 node-level trigger cut/input snapshot、continuation kind、parent composite FK 和已保存 feedback envelope 在同一 Attempt 下重建完全相同的 Context Pack。Quality revision 缺失 parent envelope、parent 不相邻/不属于同一 Node 或重建 hash 不同均进入 quarantine，不能退化为 initial/retry 或重新调用 Evaluator 生成 feedback。
6. `dispatch_pending` 仅在 run.control=running 时重投同一个 outbox effect；paused/resuming 时保持 pending。Running delegation 先按 external id 对账，不因普通 worker lease 过期重复 dispatch。
7. Pure/idempotent system action 可按同一 attempt key 重放；compensatable action 先对账 effect receipt，再决定继续或补偿。
   Mutable mutation 还必须比较 domain claim fencing token、external before/after revision 与 immutable snapshot；外部状态不确定时进入 action-required，不得盲目产生新 operation key。
8. 回收 evaluator lease，在同一 Attempt 基于 frozen result 继续 evaluation。已提交 `needs_revision` 必须与唯一 feedback envelope、唯一 scheduled/consumed quality-revision continuation 全部同时存在；因为它们属于同一 T6a transaction，部分存在是 integrity violation 而不是待补偿工作。Consumed Schedule 与 next Attempt 也必须同事务存在，Recovery 不能再创建第二个后继。
9. 回收 wait registration；signal、timeout、cancel 继续竞争同一 armed CAS，重复 payload 按 inbox idempotency key 归类。
10. 对 `subgraph/expand/map` 从 sealed Expansion Manifest 按 unique invocation key 补齐 build/materialization，或以 T7b 消费已完成 child outcome；不能重读 planner live output。
11. 从 persisted edge resolution 验证 trigger/input fixed point；已有 trigger cut/input snapshot 的 node 不重新选 edge。任何 terminal/candidate fact 缺少应原子生成的 eligibility 都是 invariant violation，禁止事后补齐。
12. Close request 已存在时不得重选 rule/candidate。Paused/resuming run 可以合法存在 eligibility 而无 request；running run 出现该状态说明 resume/fact transaction 被破坏，必须 quarantine，不能恢复仲裁。
13. Completion cut 已存在时只验证 child consumption disposition，或 root workflow transition/history/checkpoint 的同事务事实；不重建新的 cut。
14. 回收 outbox lease；child/root finalizer 是纯数据库事务，不持有独立租约。Closed run 只补外部 projection，不重做 workflow transition。

普通可解释且状态仍可信的编排失败使用 `engine_error` 并走 `on_error`。外部资源/credential 暂时不可用、compensation dead-letter 或需要核验 receipt 等状态可信但需要人工介入的情况，在同一事务创建 source-typed Operational Blocker 并进入 `action_required`，只允许使用相同 effect key、Schedule 或 Claim 协议收敛。Plan/artifact hash mismatch、不同 edge decision hash、ledger chain mismatch、cross-run lineage、成功 node 必要 immutable artifact 缺失，或 root cut 与 workflow transition/history 不匹配属于事实完整性不可信，在同一事务创建 `integrity_quarantine` blocker 并进入 run-level `quarantine`：停止 claim/materialize/close/transition，late callback 只审计，禁止手改 edge/candidate/ledger 或伪造 cut。Quarantine 只能通过恢复可信数据解除；无法恢复时允许写独立审计的 `administrative_abandon` 并归档 Workflow，但它不是 normal/error/cancel outcome。

Recovery 启动时必须双向验证 Operational Blocker 与缓存状态：存在 open blocker 但 Run/Workflow operational state 仍为 `healthy`，或不存在 open blocker 却仍为 `action_required/quarantined`，都属于完整性错误并先进入 quarantine，不能由启动代码静默修正。T6e 成功事务同时写 blocker resolution、Command Invocation、Runtime Event 和 Run/Workflow operational state；crash 后只可能全部存在或全部不存在。Integrity restore 必须保存恢复来源、expected/actual hash、Backup Manifest 或重新验证证明，且同一 incident 的失败尝试仍 append-only 保留。

## Snapshot 与 Checkpoint

State activation 的 context/constant 值在 T1 冻结；artifact/template 使用 versioned immutable locator 和 expected hash。恢复不能重读 live workflow context 或 latest registry。

Checkpoint row 与 workflow revision 一起 CAS：

```text
workflow_checkpoints
  - id/workflow_id
  - checkpoint_version
  - workflow_revision
  - source_state_instance_id/source_run_id/completion_cut_id
  - snapshot_json/ref/hash
  - created_at_ms

UNIQUE(workflow_id, checkpoint_version)
UNIQUE(completion_cut_id)
```

`checkpoint_version` 在 workflow CAS 内分配，不能用进程内计数或事后插入。Checkpoint 只保存引用和完整恢复水位：

```json
{
  "schemaVersion": 7,
  "checkpointVersion": 34,
  "workflowId": "...",
  "stateKey": "target_graph_state",
  "stateInstanceId": "state-instance:new",
  "workflowRevision": 22,
  "creationRequestId": "create:request",
  "creationKeyHash": "sha256:creation-key",
  "recipeRef": "example.recipe@1.0.0",
  "recipeHash": "sha256:recipe",
  "workflowExecutionPolicyHash": "sha256:workflow-policy",
  "runtimeSafetyHash": "sha256:runtime-safety",
  "lifetimeCounters": {
    "stateActivations": 4,
    "graphRuns": 4,
    "stateTransitions": 3,
    "childWorkflows": 0
  },
  "domainClaimRefs": ["claim:workspace"],
  "graph": {
    "current": {
      "runId": "run:new",
      "lifecycle": "initializing",
      "control": "running",
      "operationalState": "healthy",
      "rowVersion": 0,
      "workFenceEpoch": 0,
      "rootScopeId": "scope:new-root",
      "rootBuildId": "build:new-root",
      "sourceSeedHash": "sha256:new-source-seed",
      "registrySnapshotHash": "sha256:new-registry-snapshot",
      "rootPlanHash": null,
      "manifestSeq": 0,
      "manifestHeadHash": "sha256:manifest-genesis",
      "ledgerSeq": 0,
      "ledgerHeadHash": "sha256:ledger-genesis",
      "lastEventSeq": 1,
      "lastAdmissionSeq": null,
      "rootCloseRequestId": null,
      "rootCloseRequestHash": null,
      "completionCutId": null,
      "completionCutHash": null,
      "outcomeKind": null,
      "exitName": null,
      "outputHash": null
    },
    "completed": {
      "runId": "run:previous",
      "lifecycle": "closed",
      "control": "running",
      "operationalState": "healthy",
      "rowVersion": 17,
      "workFenceEpoch": 2,
      "rootScopeId": "scope:previous-root",
      "rootBuildId": "build:previous-root",
      "sourceSeedHash": "sha256:previous-source-seed",
      "registrySnapshotHash": "sha256:previous-registry-snapshot",
      "rootPlanHash": "sha256:previous-plan",
      "manifestSeq": 12,
      "manifestHeadHash": "sha256:previous-manifest-head",
      "ledgerSeq": 41,
      "ledgerHeadHash": "sha256:previous-ledger-head",
      "lastEventSeq": 324,
      "lastAdmissionSeq": 19,
      "rootCloseRequestId": "close:previous-root",
      "rootCloseRequestHash": "sha256:previous-close-request",
      "completionCutId": "cut:previous-root",
      "completionCutHash": "sha256:previous-cut",
      "outcomeKind": "completed",
      "exitName": "accepted",
      "outputHash": "sha256:previous-output"
    }
  },
  "updatedAtMs": 1783684800000
}
```

Graph-to-Graph transition 时 `completed` 保存旧 run 的完整水位，`current` 指向同一 T8 创建的新 activation/root run。首次 activation 时 `completed=null`；terminal transition 时 `current=null`。Initializing current 的 `rootScopeId/rootBuildId/sourceSeedHash` 已存在，`rootPlanHash` 合法为 null。Checkpoint 不保存已删除的 `controlEpoch`；`rowVersion` 只用于定位该水位对应的 Run 行，不充当调度 generation。Checkpoint 内权威时间同样使用 Unix millisecond `*AtMs`，只有 API/运行中心 projection 可以派生 ISO string。T6e/Operational Blocker 可以在不增加 `workflow_revision/checkpoint_version` 的情况下更新 live operational cache；恢复必须读取 Blocker/Run/Workflow 当前行，不能把 checkpoint 中旧 `operationalState/rowVersion` 当成现状。Checkpoint 不复制 scope/node/edge/attempt；Graph Store 才是执行事实源。

## Context、Artifact 与 Quality Gate

- Workflow Input 是 immutable value ref；Definition 固定 versioned Context Contract 与 typed slots。Scope input、node input、Context Slot 和 output 都必须匹配 versioned Workflow Schema Profile；`max_bytes` 字段必须存在，non-null 时作为业务 byte limit，null 时不注入默认业务上限，分组 runtime value/run safety ceiling 始终执行。
- Delegation context pack 基于 frozen input 和显式 provenance 构建；不能隐式读取 sibling 或 live workflow context。
- Artifact、evaluation、effect receipt 和 result 按 run/scope/node/attempt 隔离，不覆盖 state 级 `latest.json`。
- Capability 必须恰好声明 artifact/evaluator binding 或受信任的 `no_*_expected`。
- Quality gate 决定 attempt pass/needs_revision/fail；只有最终 pass attempt 能发布 logical node output。`needs_revision` 必须生成符合 Capability pinned feedback schema/hash/size 的 immutable Value 和 `QualityRevisionFeedbackEnvelopeV1`；下一 Attempt 只消费紧邻 parent envelope，禁止用未 seal 的 evaluator stdout、Trace summary 或可变文件代替。
- 每个 Attempt 的 Context Pack 都保存 Node input snapshot ref/hash 和 canonical continuation。Initial 没有 parent；execution retry 只携带结构化 retry reason；quality revision 携带 parent candidate/evaluation/feedback refs。Context Pack builder 对同一 pinned facts 必须产生相同 hash，Recovery 只可重建缺失的相同 bytes/hash，不能重新调用模型总结 feedback。
- Quality revision exhaustion 只发布 Node failed fact 和 immutable error detail，不发布最后 candidate。后续业务 State 若需要显式接收“不合格候选”必须另行发布 typed remediation/rework 合同，不能把 failed Attempt result 伪装成 `completed_output`。
- 普通 node 不能修改共享 workflow context。Child completion 只发布 owner output refs；root coordinator 仅在 T8 按受信任 Transition 的 typed Context Patch 创建新的 immutable Context Snapshot。Slot 复用原 Value Ref，不复制业务字节；summary 只属于 projection。Error/cancel transition 使用 canonical no-op patch，除非 published transition 明确定义兼容的 typed patch。Terminal state 的 final output binding 与 Context Patch 分开校验。

## 权限与安全

- Production v1 的确认部署边界是 `local_single_user + node_service + darwin/arm64`：唯一人工主体为稳定 `human:local-owner`，不存在相互不信任 tenant，也不把 Runtime API 暴露为远程多用户服务。Electron 仅是 API client，不持有 Runtime DB write/read connection；其他 platform/arch/runtime surface 必须单独认证。Publisher、Feature Execution Artifact 与 Executor 均来自已签名或本地批准的可信 TCB；未受信任 Plugin/Executor 在 Container/OS hostile-code sandbox 门禁落地前一律不能发布或装载。
- 在上述边界内明确接受第一版不提供 Value payload 机密性/Value 级读取隔离；完整性、hash/schema/provenance、secret-ref、有限 retention/容量与 Credential 原文不落盘仍是强制合同。部署边界一旦扩大，必须先增加 Value 访问控制/加密与不可信执行 sandbox，并重新认证 Runtime，不能仅修改配置开启远程或多用户模式。
- Source spec 只能选择 policy allowlist 中的 capability/template/interface/policy。
- Compiler 解析的 capability binding 固化到 plan；dispatch 只检查资源仍可用，不重新解析或 fallback。
- 权限收紧、resource uninstall 或 schema hash 不匹配产生结构化 non-retryable engine error。
- File/artifact path 必须通过 storage resolver；graph spec 不能提供 host path 或 mount。
- Condition evaluator 使用 typed AST；trusted business step/depth/input-byte limit 为 non-null 时进一步收紧，runtime safety step/value ceiling 始终执行且进入 snapshot，不存在隐藏默认值。
- Scope spec、map collection、scope count、nesting、node、attempt、wait 和 output 由 Graph Ledger 按 non-null policy limit 控制；token/tool/cost 默认由现有执行层限制，只有显式 Run usage budget 且 gateway 可可靠归集时才进入 optional Ledger account。
- Event payload 只保存受限 summary、ref、hash 和 policy decision，不复制 secret 或无限结果。
- External signal 必须验证 workflow/scope/node correlation、contract、authorization、expiry 和 idempotency key。

## Runtime Center（运行中心）与 Trace

Runtime Center 是新 Runtime 的顶层控制面和观测面，不继承任何已删除后台的 route、API、table、label 或 projection。它不把所有执行强制建模为 Workflow，也不把不同 Trace Store 合并进 `workflow-runtime.db`。Feature UI 负责领域任务发起、产出解释与 typed Business Command；Runtime Center 负责跨 Feature 的执行索引、统一待处理、通用运行控制、诊断、审计和到 Feature 的深链。

运行中心至少提供四个一级视图：

- `工作流`：展示所有入口创建的 Workflow/Run，包括 Feature、通用 Intake、Schedule、API、Automation 和 child Workflow。
- `Agent 执行`：展示独立对话或其他非 Workflow 入口触发的 Agent execution；不得为了进入该视图而创建伪 Workflow。
- `待处理`：聚合 approval、durable wait、credential、action-required、receipt remediation 与 quarantine 等跨 Feature 事项；业务动作优先深链回 Feature，只有已发布 typed Business Command Contract 且存在通用 renderer 时才允许原地处理。
- `Trace`：保留全局 Trace 列表和详情展示，覆盖 Workflow 与非 Workflow 执行，并增加来源类型、Feature、Workflow、会话和 Agent execution 过滤条件。

通用 Intake 可以作为运行中心的可选入口，但仍必须使用 pinned Routing Scope 与 deterministic resolver；运行中心不得暴露一个可任意选择全局 Definition/Policy/Capability 的创建器。

### Projection API 与重建边界

Runtime Center 只读取可重建 Projection 或通用 Trace Store，不获得 Runtime DB write connection。Projection Worker 以 Runtime Event/Outbox 的 `(source_stream, source_seq)` 幂等推进 `projection_head`；同一事件重复投递不重复写，发现 seq gap、hash mismatch 或 rebuild 中断时把对应 view 标记 degraded，并从可信 Runtime query/export 重新生成。Projection row 永远携带 `source_row_version/source_event_seq/projected_at_ms`，用于显示 freshness 和生成 Command 的 expected-version hint；它不是授权或 CAS 的权威值，Command Gateway 必须重新读取 Runtime Store。

```ts
type RuntimeCenterView = 'workflows' | 'agent_executions' | 'pending' | 'trace';
type RuntimeCenterSort =
  | 'updated_desc'
  | 'started_desc'
  | 'deadline_asc'
  | 'severity_desc';

interface RuntimeCenterListRequest {
  view: RuntimeCenterView;
  page_size: number;
  cursor: string | null;
  filters: {
    feature_id?: string;
    workflow_status?: string;
    operational_state?: string;
    source_kind?: string;
    pending_kind?: string;
    trace_root_kind?: ExecutionTraceRootKind;
    started_from_at_ms?: number;
    started_to_at_ms?: number;
  };
  sort: RuntimeCenterSort;
}

interface RuntimeCenterProjectionStatus {
  state: 'ready' | 'rebuilding' | 'degraded';
  projection_version: string;
  source_head_seq: number;
  projected_head_seq: number;
  last_success_at_ms: number | null;
  degradation_code: string | null;
}

interface RuntimeCenterListResponse<T> {
  items: T[];
  next_cursor: string | null;
  snapshot_head_seq: number;
  projection: RuntimeCenterProjectionStatus;
}
```

API 固定为 `GET /api/runtime-center/{workflows|agent-executions|pending|trace}`、`GET /api/runtime-center/workflows/:workflowId`、`GET /api/runtime-center/runs/:runId` 和 `POST /api/runtime-center/projections/:view/rebuild`。`page_size` 为 `1..200`；cursor 是 server-signed opaque token，绑定 view、normalized filters、sort、snapshot head 与最后一行稳定 sort tuple，客户端不得拼 offset 或修改过滤条件。每种 view 只允许上面 closed filter/sort catalog 中适用的组合；unknown filter/sort 返回稳定 400。详情 API 返回 Projection 状态、source row version 和 typed link，不把原始 Runtime row 暴露为开放 JSON。

Rebuild API 只允许有诊断权限的 Human 调用，返回幂等 rebuild job ref；它删除/替换的只有可重建 Projection generation，不改 Runtime、Trace、Feature domain data 或 Command audit。新 generation 追平 frozen source head、通过 row-count/hash/referential fixture 后原子切换；失败继续服务上一 generation并标记 degraded。Projection lag/degraded 时列表和详情仍返回最后可信 snapshot及显式 freshness，Command 按钮默认 disabled；用户经详情重新读取权威 target 后仍可提交的命令必须由 Gateway 独立判断，不能由前端绕过。

零 Published Recipe、零 Workflow、零 Run 与零 pending item 是正常产品状态：四个 view 返回 `items=[]/next_cursor=null/state=ready`，页面展示无创建器、无迁移提示的稳定空状态；Trace view 仍可展示非 Workflow Trace。`rebuilding/degraded` 不是空状态，必须显示 projection status、last success 和诊断入口。Projection 指向已被 retention 清理的合法对象时展示 `target_retained_metadata_only`；ID/hash 所属链不一致时展示 `broken_link_integrity_error` 并触发 integrity audit，不能静默隐藏或拼接近似对象。

### Workflow 视图

Workflow 以 state activation 为一个顶层阶段，内部展示：

- Task Intake、routing scope/attempt、selected Recipe/Definition/entrypoint、confidence/reason code、launch confirmation 与 creation key replay。
- Workflow lifetime counters/deadline、runtime safety snapshot、supported-limit/capacity hash、domain resource claims/fencing token 和 parent/child Workflow lineage。
- Root run lifecycle/control、named exit、budget 和 registry snapshot。
- 可折叠 scope ownership tree，以及每个 scope 的 immutable plan hash。
- Scope 内 control/data edge、实时 resolution、trigger 和 sealed input。
- Node phase/outcome、attempt history、每个 Attempt 的 `initial/execution_retry/quality_revision` continuation、effective attempt ceiling、quality feedback chain、exhaustion detail、wait deadline、child exit、artifact/evaluation/effect journal。界面可以显示 `Attempt 2/5` 和最近 feedback summary，但 summary 只来自 immutable envelope 的可重建 Projection，不成为下一轮 Context Pack 或权威评价事实。
- Effect operation key strategy、mutable resource before/after receipt、immutable after-snapshot 和 pinned executor implementation version。
- Terminal candidates、selected completion rule、completion cut 和被 early-close fencing 的节点。
- Map item progress、稳定 item key/index、selected quorum set、sealed result manifest 和按需 dereference 的 item output。
- 与 Run/Node/Attempt 关联的 Trace 摘要和双向跳转；完整 Trace 仍由全局 Trace 视图查询。

运行中心可以按权限提供 pause、resume、cancel、策略允许的 manual skip/retry-wait advance，以及 receipt reconcile/remediation 等通用 Runtime Command。批准、拒绝、重新生成、接受交付物等领域动作仍属于 Feature 的 typed Business Command；运行中心不得把它们降级为任意状态跳转。操作请求必须携带目标 `expected_row_version + idempotency_key`，并统一通过 Workflow Runtime Command Gateway。Manual skip/retry-wait advance 要求 paused；cancel 不要求预先 pause。运行中心与 Feature UI 都不得直接更新 Projection 或 Runtime 表，Actor、Delegation、授权决定和 applied/denied/conflict/duplicate/late 结果均按上述合同审计。

Projection 中的 `available_commands` 只是 server-computed hint，包含 command type、typed target、expected row version、permission/policy/state guard result 和 denial code；Renderer 不自行推断按钮。点击时 Gateway 必须重新认证 actor/session/delegation、重新检查 Feature ceiling、Command Policy、ownership、当前 state guard 与 row version。提示为 enabled 但提交时状态已变，返回 conflict/late 并刷新详情；提示为 disabled 时客户端不得通过构造请求获得授权。

### Deep Link 与 Renderer Bundle

Deep link 使用 closed、versioned locator，不接受任意 path/query：

```ts
type RuntimeCenterDeepLink =
  | { format: 'icarus.runtime-link/1'; target: 'workflow'; workflow_id: string }
  | { format: 'icarus.runtime-link/1'; target: 'run'; workflow_id: string; run_id: string }
  | { format: 'icarus.runtime-link/1'; target: 'node'; workflow_id: string; run_id: string; scope_id: string; node_id: string }
  | { format: 'icarus.runtime-link/1'; target: 'attempt'; workflow_id: string; run_id: string; scope_id: string; node_id: string; attempt_id: string }
  | { format: 'icarus.runtime-link/1'; target: 'trace'; trace_id: string }
  | { format: 'icarus.runtime-link/1'; target: 'feature'; feature_id: string; feature_route_id: string; subject_ref: string };
```

Runtime Center 到 Feature 的 link 必须命中 Feature Manifest 发布的 closed `feature_route_id` 并把 opaque `subject_ref` 交给 Feature renderer；Feature 到 Workflow/Trace 的 link 必须携带完整 lineage，服务端验证所属关系后再导航。Trace -> Attempt、Attempt -> Trace、Workflow -> parent/child Workflow 与 Workflow -> owning Feature 都提供双向 typed link；目标被删除或 Feature disabled 时返回 typed unavailable reason，不 fallback 到字符串搜索。

前端构建边界固定为：Core `runtime-center` 独立 renderer entry/bundle，只依赖 Runtime Center API client、通用 design system 和 typed deep-link/command client；每个 Feature UI 使用自己的 renderer entry/bundle 与 Feature Host API。Runtime Center 不 import Feature 页面实现，Feature renderer 不 import Runtime Center store/state，二者只通过 typed link 和 Gateway 协作。禁止把新 Runtime Center、DAG viewer、projection client 或 Feature 业务页面继续追加到当前 monolithic `electron/renderer/app.js`；Host shell 只负责导航、bundle loading、auth session 与 deep-link dispatch。Bundle boundary 由 import-graph test、独立 build artifact和空状态 renderer fixture 验证。

### Trace 模型与关联

Trace 是通用执行遥测，不以 Workflow 为根对象。Trace root 至少支持：

```ts
type ExecutionTraceRootKind =
  | 'workflow_attempt'
  | 'standalone_agent_execution'
  | 'feature_command'
  | 'automation'
  | 'system_task';

interface ExecutionTraceCorrelation {
  trace_id: string;
  root_kind: ExecutionTraceRootKind;
  root_ref: string;
  feature_id?: string;
  workflow_id?: string;
  state_instance_id?: string;
  run_id?: string;
  scope_id?: string;
  node_id?: string;
  attempt_id?: string;
  conversation_id?: string;
  message_id?: string;
  agent_execution_id?: string;
}
```

关联规则固定：

- `workflow_graph_events` 是 Workflow 编排事实，记录 materialize、route/data resolution、input seal、claim、retry、wait、child scope、candidate、cut、cancel、compensation 和 recovery。
- Agent/tool/effect Trace 使用通用 Trace Store；属于 Workflow 时携带可验证的 `state_instance_id/run_id/scope_id/node_id/attempt_id`，并在 Workflow 详情和全局 Trace 中同时可见。
- 独立对话触发的 Agent Trace 使用 `conversation_id/message_id/agent_execution_id`，Workflow 字段保持为空（null/omitted）；不能为了统一展示伪造 Workflow、Run、Node 或 Attempt。
- 对话发起 Workflow 时，Trace 以实际执行根确定 `root_kind`，同时允许保存 conversation/message 作为 causation correlation；“由对话发起”和“属于 Workflow Attempt”不是互斥的查询维度。
- 任一 non-null Workflow correlation 都必须验证完整所属关系；局部 ID 拼接、跨 Run Node/Attempt 关联或 orphan correlation 必须拒绝并记录 integrity error。
- Tool/Effect span 作为对应 Trace 的 child span，不因是否属于 Workflow 改变 span、retention、redaction 或查询协议。

全局 Trace 的数据源、列表/详情布局和独立保留策略保持不变；UI 合并只增加统一入口、公共筛选和双向跳转。Workflow 详情默认过滤当前 Run/Node/Attempt 的关联 Trace，独立 Agent 执行详情默认过滤当前 conversation/message/agent execution 的 Trace。

## 与 Domain Recipe 的关系

Domain recipe 负责：

- 发布 Recipe Descriptor 与 Feature 内 routing scope，把任务种类绑定到精确 Definition/entrypoint/execution policy/input-output schema；不得把全局 Definition catalog 暴露给一个无界 Router。
- 注册 capability、scope interface、template、artifact contract 和 evaluator。
- 让 Micro Planner 产生满足已选 Recipe、固定 graph-state interface/policy 的 Scope Spec；Planner 不修改 Workflow Definition、State transition 或 capability 内部执行合同。
- 定义业务 named exits、node schema、评分、报告和质量要求。
- 选择哪些分支、join、subgraph、map 或 expand 用于某次执行。

一个 Feature 可以有多个 Recipe：例如 `industry_opportunity_discovery` 和 `concept_market_validation` 可以复用 capability，但使用不同 Definition、entrypoint、policy、interface 和 report schema。Feature 页面已显式选择 Recipe 时直接走 deterministic routing；通用自然语言入口先通过受限 Domain/Recipe Router。Recipe selection 属于 Workflow 创建面，Graph planning 属于 State 内执行面，两者不能合并成一个拥有全局权限的 Planner。

例如调研 recipe 可以在一个 root run 中表达：

```text
root scope
  -> discovery map/subgraph
  -> explicit evidence join
  -> gap-analysis delegation
  -> conditional expand(child interface = followup research)
  -> synthesis
  -> review approval wait
  -> accepted | revision_required | insufficient_evidence terminal
```

领域名称不进入 core node type。`review_mining`、`market_size`、`counter_evidence` 是 capability 或 template，不是 runtime 特例。

## 模块边界

全部新实现位于 `src/workflow-runtime/`，禁止继续向 `src/` 顶层增加 `workflow-*.ts`。目录与职责固定如下：

| Module | 职责 |
| --- | --- |
| `contracts/` | Machine-readable Schema/Catalog/Protocol/Safety/DDL metadata 与生成类型 |
| `creation/recipe-registry.ts` | Recipe/routing scope/execution policy 发布、依赖、版本与 owner 校验 |
| `creation/task-intake.ts` | Task envelope、clarification/confirmation、transition intake 与 routing attempt |
| `creation/routing-resolver.ts` | 受限 Macro Router、deterministic resolution、T0/T0p 与幂等创建 |
| `creation/domain-claims.ts` | 外部资源 shared/exclusive claim、fencing token 与释放 |
| `registry/resource-store.ts` | Core/Feature versioned resource、dependency、snapshot、hash 与 retention |
| `registry/release-publisher.ts` | staged Publish、Execution Artifact 构建与原子激活 |
| `registry/execution-artifacts.ts` | Node Bundle、Executor Entry、Protocol/ABI 与 GC |
| `registry/prompt-registry.ts` | Base/Local Prompt、Promotion、Rebase 与 active pointer |
| `registry/core-upgrade.ts` | Protocol/ABI/Registry/DB compatibility preflight |
| `registry/feature-manifest.ts` | Feature Manifest vNext closed parse、ownership、dependency 与 removed-key rejection |
| `registry/production-activation.ts` | certified key、deployment profile、absence/coverage gate 与原子激活 |
| `authoring/workflow-authoring.ts` | scaffold/validate/compile/dry-run/review 的 staged source 工具 API |
| `authoring/workflow-publisher.ts` | human approval、幂等 Publish/Activate 与失败恢复 |
| `compiler/schema-registry.ts` | strict JSON、2020-12 Profile、RFC 6901 与 snapshot |
| `compiler/interface-registry.ts` | Versioned scope interface 与 compatibility proof |
| `compiler/policy-registry.ts` | Child policy intersection 与 snapshot |
| `compiler/wait-contract-registry.ts` | Signal/timer/approval contract 与 authorization schema |
| `compiler/capability-catalog.ts` | Capability/effect/claim contract 与 permission closure |
| `compiler/conformance.ts` | Toolchain、Draft/Sealed Golden、diagnostic 与 oracle isolation |
| `compiler/graph-compiler.ts` | Pure normalize/binding/DAG/condition/completion/proof |
| `compiler/definition-lowering.ts` | authoring state 到统一 root Scope Source/Plan |
| `store/runtime-store.ts` | 独立 DB Connection Factory、唯一写入口、PRAGMA 与 transaction host |
| `store/schema/` | canonical migration、Schema Manifest、constraint/query-plan fixtures |
| `store/graph-store.ts` | Run/Manifest/scope/node/edge/wait/fact/cut CAS query |
| `store/value-store.ts` | Value ownership、Blob Intent/no-replace/fsync、GC、Backup Pin |
| `runtime/ledger.ts` | reservation/posting/consumption/release 与 invariant |
| `runtime/reconciler.ts` | Fact fixed point、edge/trigger/input/readiness/completion |
| `runtime/node-execution.ts` | attempt、artifact/evaluation、effect/receipt journal |
| `runtime/child-runtime.ts` | subgraph/expand/map materialization 与 owner completion |
| `runtime/root-finalizer.ts` | Required Child provenance/Schedule、T8 preflight 与 Claim handoff |
| `runtime/waits.ts` | Signal/timer/approval registration、delivery、timeout |
| `runtime/outbox.ts` | finite Delivery/Reconcile、Attempt History、Dead Letter |
| `runtime/operational-blockers.ts` | blocker creation、T6e remediation/integrity restoration |
| `runtime/commands.ts` | Actor/Delegation、授权、typed command 与 immutable audit |
| `runtime/card-presentation.ts` | CardPresentationContract、deterministic render 与 typed action ingress |
| `runtime/graph-runtime.ts` | lifecycle、pause/cancel、claim、closing 与 recovery coordination |
| `projection/workflow-projection.ts` | Runtime Center read model、projection generation/rebuild 与 outbox consumer |
| `projection/runtime-center-api.ts` | closed list/detail cursor/filter/sort、status 与 typed deep link API |
| `projection/runtime-center-renderer/` | 独立 Runtime Center renderer entry/bundle；不得 import Feature renderer |

依赖方向固定为 `contracts <- compiler/registry/store <- creation/runtime <- projection/host adapters`。`contracts` 不 import DB、Feature 或 Runtime；Compiler 只读 immutable contract/registry snapshot，不 import Store transaction；Store 不 import Compiler 或业务 Adapter；Projection/Renderer 不获得 write connection；外部 Worker/Adapter 只能调用 Callback/Broker/Command API。CI 使用 dependency test 扫描 import graph，发现逆向依赖或 Runtime DB 直写即失败。

新的 outer workflow coordinator 只负责 activation 边界和 root completion 后的外层 transition；开发 baseline 已不存在可复用的旧 orchestration implementation。Graph Runtime 不依赖 Runtime Center UI；UI 通过 projection/query 和 command API 交互。全局 Trace 查询依赖通用 Trace Store 与 correlation query，不把独立 Agent execution 反向写成 Workflow Projection。

## 测试策略与模型验证

固定 Fixture、Property-based Test 与 Model-based Test 三类必须并存：Fixture 固定 Hash、Error Code、关键案例和历史回归；Property Test 对生成输入检查不变量；Model Test 把真实 SQLite Runtime 的事件序列结果与独立 reference state machine 比较。Reference Model 只表达 Workflow/Activation/Run/Scope/Node/Attempt/quality-continuation/Edge/Wait/Fact/Close/Cut/Ledger/Root-Finalization/Operational-Blocker/T6e 语义，不调用生产 Reconciler，也不复制 Lease/Outbox 实现细节，避免同一 Bug 同时污染实现和 oracle。

第一版使用 Vitest + `fast-check` 生成小型但高组合度的合法 DAG 与事件序列：

```text
nodes 1..6; edges 0..10; scope depth 0..2; map items 0..4;
attempts per node 1..3; wait events 0..4;
quality decision pass/needs_revision/fail; initial/execution_retry/quality_revision continuation;
all/any/quorum trigger; optional/required input; early/settled completion;
subgraph/map; signal/timer/cancel; pure/idempotent/compensatable effect;
required/best-effort child effect; finalization conflict/retry/exhaustion;
action-required/quarantine blocker; remediation success/retry/exhaustion
```

另建 invalid generator，确保 cycle、Schema/Profile 不兼容、越权 Capability/Claim、非法 completion 等总被 Compiler 拒绝。生成器必须保存 seed 并支持 shrinking；发现的最小 counterexample 修复后转成永久 Fixture。

核心 properties 至少包括：

| Area | 必须始终成立 |
| --- | --- |
| Compiler | pinned Toolchain 重放 Golden Bundle 逐字节一致；canonicalization 幂等；set-like 顺序不改 plan hash；accepted graph 无依赖环；无法证明 assignability 必须拒绝 |
| Runtime | Node terminal 不重开；Edge/Cut/Close 只提交一次；Trigger/Input snapshot 不变；Close 后普通结果不 publish |
| Quality revision | Node input snapshot 跨轮不变；每个 non-initial Attempt 恰有一个同 Node 相邻 parent且 parent 最多一个后继；needs-revision/feedback/Schedule/reservation 全成或全不变；下一 Context Pack 只引用 exact latest envelope；pass 只发布一次；fail 不 retry；Node ceiling、Run shared budget 与 Workflow deadline 产生不同终态 |
| Ledger | non-negative/under-limit；multi-account reservation 全成或全不变；重复 idempotency key 不重复计费 |
| Wait | Signal/timeout/cancel 最多一个 winner；provider event 不重复消费；correlation 只绑定一个 Wait；expired pending 不再匹配 |
| Creation | same key+intent 同实例；same key+different intent conflict；confirmation 不能跨 revision；三种 creation mode 均具有完整 provenance；required Child 的 provenance/T8 commit exactly-once |
| Child/Close | Parent fence 后 Child Cut 只能 non-publish；Ancestor 不覆盖已有 Child request；Map slot 只有一个 terminal outcome；required child 的 Cut/transition/Child/Relation/Claim handoff 全成或全不变；固定 creation key 派生可重放且 input 漂移冲突 |
| Registry/Upgrade | Publish 后 ref/hash 不变；旧 Run 固定旧 Artifact/Prompt/Protocol；不兼容 Core/Feature Release 无法激活 |
| Outbox | delivery/reconcile 尝试有限；unknown outcome 不盲重投；Dead Letter 不会按错误 Effect 语义推进 Graph；required child 永不进入 Outbox；notification failure 不回滚 Workflow |
| Blob | DB 引用只指向 durable live Blob；GC 不删除新引用/Backup Pin；Crash 后只产生可识别 orphan 或 quarantine |
| Command | Feature/运行中心提交同一 closed command 得到相同授权；Actor/WorkflowControlOwnership 不可伪造；command-to-target/permission/reason 映射封闭；Header 幂等且每次调用追加 Invocation；denied/duplicate/late 不改变目标状态；Administrative Abandon Confirmation 绑定同一 Human Session/request/evidence/version、5 分钟过期且最多消费一次 |
| Absence/Coverage | source/API/UI/schema/filesystem/resource absence 全部匹配同一 source build；removed surface 具有 negative fixture 且 replacement=null；候选资料 source/build/release/runtime reachability 全部为零 |
| Operational | open blocker severity 与 Run/Workflow operational state 双向一致且不覆盖 Workflow business status；T6e 不能提前恢复、非法降级 quarantine、重置 fence/ledger/deadline 或丢失失败 restoration attempt |
| Trace | 独立 Agent Trace 不要求 Workflow；non-null Workflow correlation 所属链完整；对话发起 Workflow 可同时按 causation 与 Attempt 查询；禁止 orphan/伪造关联 |
| Time/DDL | 权威时间均为 safe-integer `*_at_ms`；Activation/Finalization/Fact/Blocker/Command 的状态 CHECK、row version、typed FK/exactly-one 与 partial-index 查询覆盖一致；database/connection PRAGMA 与完整 certification key 逐项匹配 Profile |

所有时间测试使用 Virtual Clock，禁止真实 `sleep()`；Fake Adapter 可确定性返回 `not_applied/applied_with_receipt/applied_but_receipt_lost/still_running/unknown/cancelled/compensated`。Fault Injection 覆盖 intent、dispatch、external apply、receipt、Evaluator decision/feedback envelope/quality-revision Schedule/next Attempt、quality exhaustion detail、Node output、Fact/Event、Close Request、T0p transition provenance、Root Finalization preflight/retry、T8 required-child + Intake/Creation Request + source-activation completion原子提交、Operational Blocker create/T6e resolve/last-blocker state restore、Administrative Abandon request/expiry/confirm/consume、Notification intent/delivery failure、Completion Cut、Workflow transition，以及 Blob file fsync/install/directory fsync/DB commit、GC mark/delete/finalize和backup pin/copy边界；SQLite 事务内 crash 必须全回滚，外部 effect 边界按 operation key/receipt/reconciliation 收敛。Upgrade fixture 覆盖 Core Protocol/ABI 兼容与拒绝、Prompt Rebase pass/fail、安全 section 覆盖和旧 Run exact snapshot。

CI 分层：普通提交运行 Contract Pack conformance、Sealed Compiler Golden Bundle、固定 seed、小型 exhaustive、数百组 property、真实 data/store root write boundary、静态 absence baseline、removed surface negative fixtures 与候选目录不可达证明；完整回归扩大 seed、事件长度和 crash point；发布门禁另运行真实 SQLite 的 Supported Limit T3/T7/Root Finalization benchmark，并对同一 source build 重新生成 absence/coverage hash。所有随机失败都必须能由 seed + shrunk event list 完整重放。

## 开发期实施顺序

前置清理已在开发期建立静态 baseline：不存在需要收敛的旧 Workflow instance、writer、interrupt、outbox、schema、UI/API 或业务数据。Dynamic Runtime 从这个干净 baseline 开始，不实现运行期切换状态机、旧 writer 协调器、历史导入器或数据删除 executor。Spec Stabilization 只验证并固定 source/API/UI/schema/filesystem/resource absence、测试 data/store root 隔离、removed surface coverage 和 migration candidate 不可达证明；同一证明在普通 CI 与 Production activation 前重新生成。

本文批准即授权从第 1 步开始实施，不再等待额外架构确认。Contract Pack、Executable DDL、Schema Manifest、Sealed Golden Bundle 与 certified Supported Limits 是对应 gate 必须实际生成并由 CI/benchmark 证明的 exit artifact，不是批准本文前要伪造的附件，也不能因目标架构已确认而跳过。下列编号表示 capability gate，不表示所有工作必须串行；只有依赖 gate 通过后才能合并依赖它的实现。当前“可直接执行”指可以从 Contract Pack/Spec Stabilization 开工，不表示 Store 或 Production 已提前通过后续门禁。

1. **Spec Stabilization / Contract Pack Gate**：在 `src/workflow-runtime/contracts/` 冻结 Definition/Recipe/Command/Transition、Feature Manifest vNext、Card Presentation、Source/Compiled IR、Logical Schema typed relation metadata、Operational Blocker/T6e、`local_single_user_safety@1`/Capacity baseline/Product Floor/Retention、`local_single_user_sqlite@1`、Compiler Toolchain Manifest、Command/Permission/Reason/Denial Catalog 和 Golden Draft/Review；按本文 S25 固定工具链 identity；生成并通过静态 absence、surface coverage 与 candidate boundary manifest，不实现 durable T0。
2. **DDL 与 Store 基座 Gate**：产出覆盖全部持久化对象的 canonical executable migration、Schema Manifest、typed-FK/schema-lint、constraint/query-plan fixtures 和 empty-file SQLite DDL Gate；通过后实现独立 `workflow-runtime.db`、Connection Factory、短事务/CAS 与基础 query API。
3. **确定性 Compiler / Sealed Golden Gate**：可在第 1 步通过后与第 2 步并行；按 pinned Toolchain 实现 strict parser、Schema/Profile、RFC 8785/domain hash、Definition/Scope Compiler、binding、DAG、condition/trigger/input、completion、policy/safety、Proof/Program 与 static child closure。Expected Plan/diagnostics 由独立 oracle review + `golden-seal` 生成 sealed artifact；逐字节通过完整 Sealed Golden Bundle 后才允许 Publisher 激活 executable resource。
4. **Value/Registry/Authoring/Publish 基座**：实现 Value/Blob Write Intent/GC/Backup、Registry/Closure/Snapshot/Retention、Feature Manifest vNext、staged Publish、Execution Artifact 与 Core Protocol/ABI compatibility preflight；实现 `scaffold -> validate -> compile -> dry-run -> review -> publish -> activate` developer toolchain。此时尚不开放 Workflow 创建入口。
5. **Test-only bootstrap**：提供只允许固定 fixture、Fake Adapter、临时数据目录且禁止 Feature/API/Automation 入口的 benchmark/bootstrap profile，用于开发 Store/T0-T8 和生成首个认证数据。它不是 `certified`，必须在 production build/startup 中 fail-closed，不能成为“开发默认配置”。
6. **Durable Creation 与基础 Runtime**：在 Store/Registry/Compiler 已存在后实现 Task Intake、durable T0/T0p、claims/ledger、State Activation、T1/T2、delegation/system/wait/join/terminal、T3/T4/T5/T6a-e、Operational Blocker、effect key/mutable receipt、versioned Outbox Policy、typed adapter 与 Inbox/Outbox。
7. **动态结构与关闭协议**：实现 subgraph/expand/map、quorum/fail-fast、hierarchical fence、Fact Store、Root Finalization Schedule、required/best-effort child Workflow effect、T7/T8 与 compensation barrier。
8. **控制、Card、Projection 与恢复**：实现 pause/resuming/cancel、root coordinator、checkpoint、domain claim handoff/release、T6e、Recovery、Runtime Command Gateway、Card Presentation/typed action、Runtime Center Projection/API/deep link 与独立 renderer bundle；仍只在 test-only bootstrap 下执行未认证 Runtime。
9. **认证门禁**：完成独立 Reference Model、Property/Model/Fault tests 与真实 SQLite Supported Limit T3/T7/Root-Finalization benchmark，达到 Product Floor/transaction budget，并发布与完整 certification key 精确绑定的首个 certified profile。
10. **Production Activation**：对同一 release build 重新生成并校验 `WorkflowRuntimeAbsenceBaseline`、`ProductSurfaceCoverageManifest` 与 `MigrationCandidateBoundaryManifest`，加载 G8 certified profile并运行 startup smoke；随后原子激活 Core/Feature Registry pointer 与 Runtime Center Projection generation。Production Recipe inventory 可以为空；为空时验证通用 Intake=`no_route_available`、Runtime Center Workflow/待处理空状态和非 Workflow Trace 正常。存在 Published Recipe 时只验证其标准 Publish/Activate 合同，不增加任何历史候选特例。

Gate 依赖与可并行关系固定如下：

| Gate | Depends on | 可并行工作 | Exit artifact |
| --- | --- | --- | --- |
| G0 Contract Pack/Static Baseline | 无 | 无 | schemas/catalogs/protocols/safety/draft bundle + absence/coverage/candidate hashes |
| G1 DDL/Store | G0 | G2 Compiler | migration + Schema Manifest + SQLite fixtures |
| G2 Compiler/Golden | G0 | G1 DDL | sealed Golden Bundle + compiler/toolchain hash |
| G3 Registry/Authoring/Publish | G1 + G2 | Reference Model skeleton | manifest/authoring/publish/retention/ABI fixtures |
| G4 Test Bootstrap | G1 + G2 + G3 | Reference Model skeleton | isolated bootstrap profile |
| G5 Basic Runtime | G4 | optional Domain Recipe authoring | T0-T6e model/fault fixtures |
| G6 Dynamic/Close | G5 | projection query model | T7/T8/child/compensation fixtures |
| G7 Control/Card/Projection/Recovery | G6 | Runtime Center renderer | command/card/projection/recovery/operational blocker fixtures |
| G8 Certification | G7 | optional Domain Recipe release | certified profile meeting Product Floor |
| G9 Production Activation | G8 + fresh G0 manifests | 无 | activation audit + startup/empty-state or launchable-Recipe smoke |

```ts
interface WorkflowRuntimeAbsenceBaseline {
  format: 'icarus.workflow-runtime-absence-baseline/1';
  source_core_build_hash: string;
  generated_by_tool_hash: string;
  production_source_absence_hash: string;
  removed_api_negative_fixture_hash: string;
  removed_ui_negative_fixture_hash: string;
  schema_absence_hash: string;
  filesystem_absence_hash: string;
  active_resource_absence_hash: string;
  protected_capability_fixture_hash: string;
  test_data_root_isolation_hash: string;
  migration_candidate_boundary_hash: string;
  baseline_hash: string;
}

interface ProductSurfaceCoverageManifest {
  format: 'icarus.product-surface-coverage/1';
  source_core_build_hash: string;
  generated_by_tool_hash: string;
  entries: Array<{
    surface_id: string;
    surface_kind:
      | 'launch'
      | 'control'
      | 'projection'
      | 'authoring'
      | 'resource_schema';
    owner_feature_id: string | null;
    status: 'active' | 'removed';
    replacement_ref: string | null;
    contract_fixture_hash: string | null;
    removal_fixture_hash: string | null;
    entry_hash: string;
  }>;
  active_surface_count: number;
  removed_surface_count: number;
  manifest_hash: string;
}

interface MigrationCandidateBoundaryManifest {
  format: 'icarus.migration-candidate-boundary/1';
  source_core_build_hash: string;
  candidate_root: 'local/migration-candidates/';
  archive_manifest_hash: string;
  checksum_manifest_hash: string;
  archived_file_count: number;
  production_import_reachability_hash: string;
  test_helper_reachability_hash: string;
  setup_reachability_hash: string;
  feature_registry_reachability_hash: string;
  compiler_fixture_reachability_hash: string;
  build_context_reachability_hash: string;
  release_artifact_reachability_hash: string;
  boundary_hash: string;
}
```

Absence generator 使用 TypeScript AST/import graph、Web route enumeration、Electron DOM inventory、Feature manifest parser、SQLite schema inspection 和 configured filesystem roots，不使用手写文件列表代替机器证明。它只检查已删除 surface 的 absence，不读取历史资料候选内容来判定 source 命中。Baseline 必须证明：旧 Runtime/authoring/projection import 与 route 为零；removed API 返回 404；removed nav/screen 不存在；fresh/existing DB 的旧 table/column/index 为零；活动 Definition/Card/Evaluator/Artifact Contract root 为零；旧 data root absent；受保护的 delegation、Scheduled Task、Agent/Container、Trace、Feature Runtime、InteractiveCard/渠道、Ask User Question、Assistant、Today Plan、Memory、Wiki、Chat fixture 仍通过。任何回归都阻止 G0 和 G9。

`ProductSurfaceCoverageManifest` 只描述当前产品 surface，不承担历史迁移义务。流程管理、卡片管理、旧 Workbench 创建/控制/projection、旧资源字段和 migration-candidate launch entry 都必须记录为 `status='removed'`、`replacement_ref=null`、`removal_fixture_hash=<negative API/UI/source/schema bundle>`；不得为了让 manifest 看起来“完整”而制造 Recipe、Card editor、兼容 route 或空白替代页面。Active Runtime Center、Feature typed launch/command、Trace 等新 surface 使用 `status='active'` 和自己的 contract fixture。Schema fixture 强制 removed entry 的 replacement 为 null、removal fixture 非 null；active entry 则相反。

`local/migration-candidates/**` 允许保存历史领域材料、原始 bytes 和 checksum manifest，但不是 authoring source、test fixture、Registry resource、Feature package resource、Compiler input、compatibility reader 或 release asset。普通 content absence scan排除候选目录，独立 boundary gate 则从 production source、test helper、setup、Feature registry、Compiler fixture discovery、container/build context、package/release artifact 和 Runtime file access 两个方向证明不可达；任一 import、read、copy、glob discovery 或 Registry ref 都使 CI 失败。候选内容只能由显式人工文档审阅或 checksum verifier 读取，Runtime/Core/Feature/Assistant/Container code 不得引用。

`dev_test/fix_test` 资源已作为不可执行 migration candidate 独立保存；是否迁移由 Runtime v1 完成后的独立产品决策决定，不属于本文实现、认证、Product Floor 或 Production Activation。

所有测试使用临时 `DATA_DIR/STORE_DIR`，不得写真实用户数据或把候选资料复制到 fixture root。Pure resolver/Compiler 与 test-only benchmark 可以在没有 certified profile 时运行；任何真实 ingress/Adapter 的 Runtime 必须通过 G8/G9。Production v1 仍固定本地单用户 `node_service + darwin/arm64`；真实文件 SQLite 的 T3/T7/Root Finalization Supported Limit、WAL、复杂度和绝对事务时长是发布门禁。若未来部署边界变为多用户、远程服务、多机或分布式 scheduler，必须重新打开 Threat Model、权限隔离、Value 机密性和存储选型，不得沿用本版本认证结论。

## 开发期直接重构约束

本文全部对象、表、事务和 node type 属于同一个交付边界，不存在可省略的降级 runtime：

- 直接落地本文 target schema、IR 与状态机；不保留旧 graph 表、双写链路、旧 completion handler 或并行的新旧 scheduler。
- 所有非 terminal authoring state 一次性 lower 到统一 Graph Runtime。Delegation/system/interrupt/graph 的 completion、retry、wait 与 transition 不再保留旁路；不存在 parallel state/node/builder，多个 ready node 即原生并行。
- Source IR、Compiled IR、policy/wait/capability registry、Graph Store、Run/Expansion Manifest、ledger、reconciler、executor、durable wait、child runtime、root coordinator 和 recovery 必须作为同一套 contract 实现。
- Task Intake、Recipe/routing/execution-policy registry、T0 deterministic resolver、creation idempotency、runtime safety、domain claims 与 Feature draining/executor retention 同样属于交付边界；不能让 Feature API 继续绕过它们直接按任意 workflow type 创建。
- 数据库 schema、composite FK、unique/CAS、outbox 和 checkpoint 以本文最终模型建立开发期 baseline；不存在需要兼容的历史执行记录。
- 前置清理前的 Workflow execution/history、关联聊天、projection、audit、artifact/context/business asset 一律不导入 `workflow-runtime.db`，也不归档。静态 absence baseline 必须持续证明旧表/列/行、filesystem tree、route、resource 与 writer 不存在；不建立双写、compatibility reader、archive、tombstone 或恢复副本。
- Contract Pack 是类型、closed enum、protocol、Safety/Retention 和 DDL metadata 的唯一机器权威；新代码全部位于 `src/workflow-runtime/` 并通过 import boundary test，禁止在 `src/` 顶层继续堆叠新 Runtime 模块。
- Sealed Compiler Golden Bundle 固定 raw bytes、完整 Registry/Policy/Safety、hand-reviewed diagnostics、canonical Plan 与 source/plan/proof/program hash，覆盖 static lowering、condition、wait、nested subgraph、expand、map 和 policy intersection；production Compiler 不能生成 expected artifact。Crash fixtures 覆盖 T1-T8/T6e、Fact/Event、Operational Blocker 与 Root Finalization 每个 commit 前后。
- 旧 Workbench/Workflow 表、计数、状态标签、旧 state 字段、API/UI 分支和 projection 代码保持 absent；新 Runtime Center Projection 从 Graph Store/Event 在新 schema 中全量重建，不复用旧表、旧列、旧 label 或兼容 alias。UI 聚合不得把独立 Agent Trace 写成 Workflow 权威事实。
- Migration candidate 只受独立不可达与 checksum gate 管理；新 Recipe/Capability、test fixture、Feature loader、Compiler、Build 和 Runtime 不读取候选文件，也不为候选内容建立特判。
- 全部测试使用隔离临时 data/store root；AST/schema/filesystem absence gate 对旧 symbol、route、table、column、config 和 data path 全部为零，最终 source 不包含临时清理 executor 或兼容扫描器。
- 完整验收门禁通过前，不以 feature flag 绕过 effect cancellation、ledger、hierarchical fence、settled arbitration 或 recovery invariant。

## 完整验收标准

- Feature UI 单候选、Feature 内多 Recipe 和全局 Domain->Recipe 两跳 routing fixture 均只能选择 pinned scope 内 exact Recipe；低置信度按 versioned selection policy 进入 clarification/confirmation，Router confidence 不构成授权。
- Production Registry 中没有 Published Recipe 时，Runtime certification/activation 仍通过；通用 Intake 稳定返回 `no_route_available`，不创建 Workflow/Claim 且不暴露全局选择器，Runtime Center 返回零 Workflow/Recipe 的 ready 空状态。Synthetic Recipe/Definition 只存在于隔离 test-only Registry 且不能发布。
- Intake clarification 只追加合同允许的 input revision；Routing/Confirmation 都绑定 exact revision/hash。相同 `(creation_domain, creation_key, creation_intent_hash)` 的并发请求只创建一个 Workflow/activation/claims，同 key 不同 intent 返回 conflict。
- Direct、required-finalization 与 best-effort-delivery 三种 creation mode 都具有真实 Intake/revision 0/Routing Attempt/Creation Request。Required Child Schedule 绑定 deterministic transition provenance，T8 原子把 Request/Intake 标成 created；不存在 nullable/synthetic intake 旁路。
- Recipe 固定 Definition/entrypoint/execution policy/Context Contract/input-output schema/child allowlist；Publisher 从 Capability/Tool/MCP/file/transition/child Recipe 闭包派生 impact/recovery/permission，超过 effect ceiling 时拒绝。Micro Planner 只能生成指定 graph state 的 Scope Spec。
- Published Definition 只接受 closed-world `icarus.workflow-definition/1`；State Base 只有 `type/label/description`，旧 role/skill/steps/context/retry/evaluator/artifact/transition delegate 字段均以稳定 Error Code 拒绝，不存在兼容执行或静默 lowering。
- 所有非 terminal state authoring type lower 到同一 Graph Runtime，不存在 sequential/graph 双轨 completion。
- Definition/Source 只有 `graph` 一种 DAG 配置格式；多个 ready node 在 executor capacity 内并发 claim，不存在 parallel state、node、builder、table 或 scheduler。
- 单 Agent 目标迭代只使用 delegation/system Node 的 quality-revision Attempt chain；Definition/Source/Compiled IR/Logical Schema 不出现 `loop` State、`loop` Node 或循环 edge。外层 transition cycle 仍只表示新 Activation/Run 的业务返工。
- Capability、interface、template、policy、wait contract、Prompt 与 schema 使用 immutable exact VersionedRef；Run Snapshot 使用可复用 dependency-closure manifest，并为 effective Allowlist 全部依赖建立 Retention Handle，不复制 Artifact 字节。
- 只有显式 Publish 生成 Feature Release/Execution Artifact。第一版一个 Feature Release 对应一个 immutable Node Bundle、多个 exact Executor Entry、单一 Run Protocol v1/Executor ABI v1；Feature Page/UI 更新不会使 active run 丢失执行内容。
- 第一版 signed/local-approved Executor 属于 Trusted Computing Base；Worker Process 只提供 crash/version/ABI 隔离。Publish lint、Broker Grant 和 Mutation Gateway 必须强制执行，但不得宣称抵御恶意 Node code；未受信任 Plugin 在 Container/OS sandbox 门禁实现前不能发布 Executor。
- Core/Feature Release 经过 staged install、Published/Active 引用扫描、Run Protocol/Executor ABI/Registry/DB compatibility preflight 后才原子激活新创建入口；breaking Major 不会静默迁移旧 Run。
- `icarus.feature-manifest/2` 对 namespace、exact dependency、package resource、extension surface、Dynamic Workflow resource union、ownership、draining 与 retention 做 closed-schema 校验；旧四个 resource key 在路径扫描前以稳定错误拒绝，不存在 alias、fallback 或自动转换。Feature Package Runtime 的普通 skills/agents/mcp/scripts/templates 与 API/nav/renderer extension point 保持可用。
- Authoring/Publish 必须完整通过 `scaffold -> validate -> compile -> dry-run -> review -> publish -> activate`；每个 stage 的 input/output/hash/diagnostics 可审计，source/staging/dry-run/Published ownership 分离，dry-run 证明 Active Registry/Event head 不变，`human:local-owner` approval 绑定完整 diff，Publish/Activate crash 后幂等恢复。v1 不暴露通用可视化 Workflow/Card 编辑器。
- Base Prompt 与 Local Published Variant 分离；自进化 Candidate 只有通过 Promotion Policy/Evaluator 后才能 Local Publish。Feature 升级对旧 Base、本地 Variant、新 Base 做结构化 Rebase，Contract 变化或评估失败时受影响 Capability 不切换。
- Strict JSON 拒绝 duplicate key/unknown field/非标准值；受限 `icarus.workflow-schema/1`、RFC 6901、RFC 8785 与 domain-separated SHA-256 fixture 产生稳定 source/plan hash。不同 Schema 连接必须保存 sound subtype proof，non-total pointer/无法证明/隐藏转换均拒绝。
- Contract Pack 对 Schema/Catalog/Protocol/Safety/Retention/typed relation metadata 提供唯一 machine-readable truth，并与 TypeScript/Markdown conformance；Core/Compiler 使用 Node `24.18.0`、npm `11.16.0`、`better-sqlite3@12.11.1`、`jsonc-parser@3.3.1`、Ajv `8.20.0` Draft 2020-12、`ajv-formats@3.0.1`、`json-canonicalize@2.0.0`、`fast-check@4.9.0` 与 exact lock integrity。`.nvmrc`/CI/packageManager/Executor image identity 不一致时失败。Sealed Golden Bundle 的 expected artifact 由 AI/实现者起草、`human:local-owner` 通过隔离 `golden-review` 语义批准、`golden-seal` 打包；Production Compiler/AI 无 auto-accept/approval 路径，raw bytes、Registry/Policy/Safety、diagnostics、canonical Plan bytes 与全部 Hash 逐字节重放。Toolchain/Node/wrapper 改变但 version/hash 未改变时发布失败。
- 每次进入 State 都创建唯一 Activation；每个 non-terminal activation 唯一对应 root run，T8 对 normal/error/local/global-cancel 路径都原子执行 source activation `active -> completed`。Terminal activation 不创建 Run、在 T8 原子完成并保留为 Workflow 最终 `state_instance_id`；Administrative Abandon 则把当前 non-terminal activation `active -> abandoned`，不生成 Cut。Child scope 只以 append-only Run Manifest 增加，已存在 plan 永不修改。
- Compiler 对 control/data/guard dependency 并集做无环检查，并拒绝跨 scope edge。
- Condition 只读取允许的 frozen fact，route group 解析原子、确定且可重放。
- Trigger 三值逻辑能正确区分 ready、`route_not_selected` 和 unresolved，不会提前 skip。
- Data port aggregation/seal 能确定性选择 value；completion-order 模式完整记录选择事实。
- Delegation/system execution retry 与 quality revision 都保留 immutable Attempt history 和 durable Schedule，但使用 closed continuation kind；`needs_revision` 必须原子保存 typed latest feedback envelope 并成为下一 Context Pack 的唯一 revision 输入。`pass` 只发布最终 output，`fail` 不 retry；Node ceiling 得到 `quality_revision_exhausted` + immutable exhaustion detail，Run shared attempt 不足得到 `attempt_budget_exhausted`，Workflow deadline 仍走 global cancel。Dispatch/execution deadline、eligible time 与 Workflow deadline 均可在 crash 后恢复，任何 crash/replay 都不能分叉 parent/child Attempt 或重复执行同一 Schedule。
- Wait contract 必须来自 pinned allowlist；correlation 在 Run 内唯一且不复用，provider event/registration key 分离。Pre-arm signal 受有限 TTL、分层容量和 ingress/binding 两阶段授权；signal/timeout/cancel 由 `inbox_seq`、received time 与 CAS 唯一决定。
- Explicit join 不隐藏业务计算，all/any/quorum fan-in 均可通过 typed port 表达。
- Subgraph 精确实现固定 interface；Child Completion 只保存 output envelope ref/hash，需要的 Child Port 可直接 expose 为 Owner Port且不复制/重复计费。
- Expand 使用 frozen candidate、pinned registry/policy 编译 child scope，无法修改 parent plan 或扩大权限。
- Map 冻结 collection并预建全部 result slot；最终发布 sealed ordered Result Manifest，不内嵌成员 payload。完整数组只能由显式 Materializer/Reducer 生成；quorum cut 后 late child 不能改写 selected set。
- Terminal candidate 与 completion rule 支持 settled arbitration 和安全 early close；Early 固定 first-eligibility event、同 event 用 same-event priority，Settled 在候选封闭后按 priority；第一版无隐藏 grace window，completion cut 只写一次。
- Root normal exit、engine error、local cancel 和 global cancel 使用不同可信路由。
- Early close/cancel 对 active effectful node 执行 fencing，并按 effect contract 完成幂等取消或 compensation。Required compensation 的 `action_required/dead_letter/unknown` 阻止 Map owner、Child Cut 和 Root Cut；只有 `compensated/compensation_not_required` 可通过 barrier，administrative abandon 不伪造 Cut。
- Parent/root close 在同一事务为整个 subtree 建立 request/work fence manifest；stale ordinary work 无法穿越 saved work epoch，cleanup 按 winning close request 和独立 lane 收敛。Ancestor 不覆盖已有 Child request，Child Cut 与 Parent consumption disposition 分开且只写一次。
- Child policy profile 对 allowlist/recovery-kind 取交集、boolean AND、impact 与 numeric ceiling 逐层收紧；null child request 只表示继承。Compiled plan 保存完整 effective snapshot。
- Ledger 明确区分 account scope 与 consumer；一个 Reservation 通过 Posting 原子更新 deployment/workflow/run/scope/node/execution-group accounts，保持 non-negative/under-limit/守恒与确定性失败顺序。
- 每条进入 T3 fixed-point 的 ingress/derived Fact 都先消费 `facts_total`，再与同 seq Event 原子持久化；closed taxonomy、fact key 和 causal wave 可重放。纯 Projection/Trace/Notification 审计不计入 Fact。
- RuntimeSafetyCeilings 按 workflow/run/scope/map/execution/wait/value 等作用域分组、全部显式 finite并进入 hash；首个 Production target 必须逐字段等于 `local_single_user_safety@1`，Pinned Safety immutable versioned，Live Capacity 使用已确认的 `5/256/2048/16 + 20/16/5 GiB` baseline并可原子热调，logical/stored/physical bytes 分开计账，每项均有一对一 Enforcement Matrix。已有 Run 不受新 Safety version影响，Capacity 调低只背压；Safety 调高超过 certified Supported Limits 时启动拒绝。启动必须验证 run total 不超过一次 T7 root fence 的 scopes/nodes/edges/attempts/waits/builds/map slots/effects认证上限。
- Workflow lifetime ledger 跨 activation/run 强制 activation、transition、child workflow、duration 与 usage budget；业务循环不能通过新 activation 重置累计额度。
- Shared claim 只读、mutation 必须 exclusive；Capability claim slot 原子绑定全部 required claims，mutation gateway 在最终提交前逐项验证 held/current fencing token。第一版禁止 Graph 运行时动态抢锁。
- Inline value、large output 和 artifact 统一经 immutable Value/Blob Store；Blob 使用 Write Intent、容量预留、file fsync、no-replace install、directory fsync、最后 DB ref commit。GC 使用 `live -> gc_candidate -> deleting -> deleted` 与 Backup Pin；temp/final orphan、missing/corrupt 与一致备份均有 crash fixture。
- Outbox Policy exact version、delivery/reconcile attempts、attempt timeout、总 duration 和 backoff 全部 finite并固化；unknown outcome 先 Reconcile，不同 Effect 的 dead-letter 后果按合同验证，Attempt History 不覆盖。
- Notification/Card 只使用 Published Notification Contract 固定的 finite Outbox Policy，不暴露 `required` delivery；T8 原子写 intent 后，delivery failure 只形成审计/待处理，不回滚或重开 Workflow。Required child creation 不进入 Outbox，只通过 Root Finalization Schedule 收敛。
- `CardPresentationContract` 固定 exact ref/hash、owner Feature、template/variable schema、channel render profile/limits、fallback text、snapshot retention、deterministic render fixture 和 typed Wait/Business/Runtime action binding。Action ingress 重验 actor/session/delegation/permission/idempotency/expected row version/expiry；duplicate/conflict/expired 不改变权威状态，Secret 原文不进入 Card/Value/审计。通用 InteractiveCard、渠道、Ask User Question 和 Assistant Card 不受此合同替代。
- Duplicate completion/signal/outbox/finalizer 不会重复发布 output、解析 edge、创建 child、写 cut 或推进 workflow。
- Mutable mutation 的 crash fixture 覆盖 intent 前后、外部 apply 前后、receipt/snapshot 前后；跨 attempt 使用 node/business key 时不会重复 promote/commit，stale fencing token 被拒绝，结果不确定进入 action-required。
- Run/Workflow operational state=`action_required/quarantined` 与 open Operational Blocker 双向一致；Workflow business status 不被 post-terminal blocker 覆盖。T6e 逐 blocker 验证和关闭，只有最后一个 open blocker 消失才恢复 operational state=`healthy`；恢复不回退 lifecycle/control/fence/ledger/deadline，quarantine 不能通过普通 remediation 降级绕过。
- Pause 不丢弃 active result、signal 或 timeout，也不延长 deadline；resume 先进入 recoverable `resuming` barrier，drain pending error/eligibility/settled fact 后才开放 scheduler。
- Scheduler 按 durable Run round-robin admission，再按 eligible event/scope manifest/node key 排序；Graph Source 不能声明 scheduler priority，wait 不占 execution slot。
- Recovery 能覆盖 snapshot/compile/materialize、attempt preparation/execution/evaluation、wait、child scope、route resolution、cut、compensation 和 outbox lease。
- 普通 node 不写共享 workflow context；只有 root coordinator 在 T8 提交受信任 typed Context Patch 和 terminal output binding。一个 Patch Header 可以原子包含多个 set/clear Operation，同一 Patch 不得重复 target slot，任一 Operation 失败时全部不提交。
- Transition history 与 checkpoint unique key 证明 root cut 只推进一次；checkpoint 的 nullable root plan、Run Manifest、ledger、close/cut/output hashes 能定位完整动态执行历史。
- Trusted child-workflow effect 固定 completed-output port、delivery requirement、principal binding、creation domain 与 routing scope。Required effect 通过 finite Root Finalization Schedule/Attempt preflight，并与 Root Cut/transition/Claim handoff/Child/Relation 在 T8 原子提交；best-effort 只写 Outbox。两者的 creation domain/key 由 Run Protocol 根据 root lineage、Parent、source activation/close request 与 effect id 固定派生，Definition 不含自由模板；相同 key 的 Recipe/principal/input 漂移由 `creation_intent_hash` 拒绝。两者均受 Parent Recipe exact allowlist、direct/depth/root-descendant budget 约束；需要同步结果的流程使用 subgraph 或显式 wait/signal。
- Runtime Center、Feature Page、API 与 Automation 共用 Runtime Command Gateway；只接受本文 closed Command Union、六种 typed target、closed Permission/Reason/Denial Catalog，不存在开放 `command_type/target_ref`。T0 冻结 first-class `WorkflowControlOwnership`，`creation_domain`/Recipe owner 不直接授予 `own`；Command Header 对 `(idempotency_domain,key)` 保存 canonical request/result，每次 authenticated 调用都追加 Invocation，Human/Feature Service/System Actor、Delegation Chain、Permission/Policy/State Guard 和 applied/denied/conflict/duplicate/late 审计均可验证。Receipt remediation 不能人工改成功，Administrative Abandon 必须由 `human:local-owner` 以 5 分钟 intent-bound Confirmation 二次确认且不伪造 cut/outcome。
- Runtime Center 提供工作流、Agent 执行、待处理和 Trace 四类视图；Projection API 使用 closed cursor/filter/sort、generation rebuild 和 ready/rebuilding/degraded 状态，零数据空状态与断链原因可区分。Workflow 详情展示 scope tree、DAG、edge resolution、input seal、attempt/wait、ledger、candidate 和 completion cut；typed deep link 双向验证 lineage，Projection button 只作提示且 Command Gateway 重验 expected row version/权限/state guard。
- Core Runtime Center 与每个 Feature UI 使用独立 renderer entry/bundle，只通过 typed deep link、API client 与 Gateway 协作；import/build fixture 阻止 Runtime Center、DAG viewer、projection client 或 Feature 业务继续进入 monolithic `electron/renderer/app.js`。
- 全局 Trace 保留 Workflow 与非 Workflow 执行；独立对话 Trace 只要求 conversation/message/agent execution correlation，Workflow Trace 的 activation/run/scope/node/attempt 所属链可验证。对话发起 Workflow 时支持 causation 与 Attempt 双向查询，禁止为了统一展示创建伪 Workflow。
- Feature UI 负责领域任务发起、产出解释和 typed Business Command；Runtime Center 只提供跨 Feature 索引、统一待处理、通用 Runtime Command、诊断、审计和深链，不重复实现完整领域工作面。
- Engine error、action-required 与 quarantine 边界明确；integrity quarantine 停止所有状态推进且不能伪造 cut，只能恢复可信数据或写独立审计的 administrative abandon。
- Workflow 权威事实只写独立 `workflow-runtime.db`，`messages.db` 仅保存可重建的新 Projection；跨库只走幂等 Outbox。Bootstrap 在建表前固定 database-level `page_size=4096/auto_vacuum=incremental`；所有 Runtime 连接由统一 Factory 按 `local_single_user_sqlite@1` 设置并回验 WAL/FULL/FK、timeout/temp/checkpoint、journal/cache/mmap 与 trusted-schema/trigger/read/locking/query-only 全部 PRAGMA，启动同时核对 SQLite/source/compile-options、`better-sqlite3@12.11.1` native module 与 Node `24.18.0` identity。SQLite Profile 只能通过新 version、重启和重新认证修改，不能 production hot reload。
- Logical Schema 不含 `control_epoch`、无后缀时间或 `version/timestamps` 缩写；absolute time 全部是 UTC Unix millisecond `*_at_ms`，CAS 使用 `row_version`，状态组合由 SQLite CHECK，Deadline/Retry/Lease/Outbox/TTL 使用 Partial Index。内部多类型关系全部展开为 typed nullable FK + exactly-one CHECK，external ref 在 Manifest 显式标注；migration 不含 polymorphic `kind/id`、`error fields/error_json` 或无 target metadata 的裸 ref。Executable DDL Gate 必须覆盖 Value ownership、Registry/Retention/Backup、Activation/Transition/Root Finalization、Fact/Operational Blocker、Command/Confirmation/Invocation 等全部持久化对象，并通过真实文件 SQLite migration、reopen、integrity/foreign-key check、Schema Manifest、constraint/schema-lint fixture 与固定查询的 query-plan fixture。
- Checkpoint schema v7 不含 `controlEpoch`，只保存用于水位定位的 `rowVersion`；权威更新时间使用 `updatedAtMs` safe integer，ISO 时间只能由 API/运行中心 projection 派生。
- Fixture、Property Test、独立 Reference Model、Virtual Clock/Fake Adapter 与 Fault Injection 同为强制门禁；随机失败保存 seed、shrinking 后转成永久回归 Fixture。
- T3/T7/Root Finalization 使用真实文件 SQLite 在 versioned Supported Limit 上覆盖最坏 Graph/Scope/required-child 形状；certified profile 达到 `local_single_user_product_floor@1`，并通过 T3/T7/T8 p99 250/1000/500 ms、复杂度和正确性预算；配置不得超过认证上限。
- 未认证阶段只有 fixture/Fake Adapter/test-data-dir 隔离的 test-only bootstrap 可以执行；任何真实 ingress/Adapter 的 Production Runtime 都必须加载与 DDL/Core/SQLite binary+compile options/Execution Profile/benchmark harness 精确匹配的 certified profile。
- Production v1 只允许 `local_single_user + node_service + darwin/arm64` 完整 certification key、稳定 `human:local-owner` 与可信 Publisher/Executor；Electron/其他架构不能复用 profile，未受信任执行代码和远程多用户模式必须 fail-closed。Activation 对同一 source build 验证 `WorkflowRuntimeAbsenceBaseline`、`ProductSurfaceCoverageManifest` 与 `MigrationCandidateBoundaryManifest`：旧 table/column/row、旧关联字段、artifact/context asset、旧 data root、代码/route/config/Definition/Evaluator/Artifact Contract/fixture/import 全部 absent，removed surface 不得恢复，候选目录不得进入可执行闭包；不允许 archive/tombstone/compatibility reader 或历史导入路径。
- Domain recipe 能组合完整 graph 能力而无需修改 core runtime。
