# Dynamic Workflow Graph Runtime 完整架构方案

> **状态**: 已确认目标架构（开发期实现基线）
> **范围**: Icarus core workflow runtime
> **目标**: 统一静态 workflow、并行执行、运行时 DAG、条件路由、局部汇合、持久等待、子图和受约束动态扩图。

## 导航

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

## 已确认决策索引

本索引记录会话 `019f509b-2e43-7592-b47e-34096533bc93` 已确认并在本文落地的 11 个架构细节点与 4 个工程优化点；索引不是第二份规范，权威细节仍以对应章节的类型、DDL、事务和验收条款为准。

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

## 背景

Icarus 已有 workflow definition、delegation、system action、interrupt、terminal、context pack、artifact contract、evaluator、host/container/IPC/MCP 等能力。现有状态机适合顺序流程，但无法完整表达和恢复以下执行形态：

- 多分支并行、条件路由、failure fallback 和 quorum join。
- 每个节点独立 handoff、input snapshot、artifact contract、evaluator、retry 和 trace。
- graph 内 signal、timer、approval 等持久等待，同时让无关分支继续执行。
- 预编译 subgraph、collection map，以及根据上游产物创建受约束 child graph。
- early completion、named exit、未完成节点 fencing 和晚到结果审计。
- 跨进程恢复、预算归集、权限收敛和 Workbench 图形化操作。

这些都是通用编排能力，不属于 research 或其他领域。core 只理解 graph、scope、node、edge、port、capability、policy 和执行状态；领域 recipe 负责业务节点、artifact schema、evaluator 和 graph planning。

## 设计目标

- 外层 Workflow Instance 保留为可循环、可长期运行的状态机。
- 所有可执行 state activation 使用同一 Graph Runtime；顺序 authoring state 和 dynamic graph 不建立两套执行协议。
- 一个 state activation 恰好对应一个 root Graph Run。
- 一个 Graph Run 可以追加 child scope，但任何已 materialize 的 Scope Plan 永不修改。
- 支持 `delegation | system | wait | join | subgraph | expand | map | terminal` 完整 node union。
- 分离 control routing、data readiness、node trigger 和 scope completion，避免用“全部前驱成功”承担所有语义。
- 让 runtime graph 在受信任 policy envelope 内选择结构和内部 completion policy，但不能扩大 capability、权限、预算或外层 transition。
- 让自然语言、Feature 页面、schedule 和 API 通过受约束 Recipe Catalog 创建精确 Workflow；Macro Router 只能在入口固定的 routing scope 内选择，不能遍历或自由拼装全局 Workflow Definition。
- 所有条件、路由、输入选择、completion cut、预算消费和 scope expansion 都可确定性重放与审计。
- 物理执行采用 at-least-once，状态效果通过 CAS、幂等键、lease、event log 和 outbox 达到 exactly-once。
- Workbench 能展示并操作 scope tree、DAG、attempt、wait、edge resolution、budget 和 completion cut。

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
    -> Graph Run                      activation 的唯一 root run
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

1. 一个 activation 恰好对应一个 root Graph Run；一个 run 在任一 committed state 对应一棵有限 scope ownership tree；`max_nesting_depth` 非 null 时额外执行业务深度限制，null 时不注入默认业务深度，但部署级 finite safety depth 始终适用。
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
15. Macro Router 只能从 pinned `WorkflowRoutingScope.allowed_recipe_refs` 中选择一个 exact RecipeRef；Definition、entrypoint、policy、input/output schema 和 launch policy 必须由该 Recipe 不可变绑定，不能由 Router 分别自由组合。
16. 同一可信创建域内 `creation_key` 只能绑定一个 `creation_intent_hash`；相同 intent 重放返回原实例，不同 intent 必须 `idempotency_conflict`。
17. Workflow 级累计 activation、Graph Run、transition、duration、usage 与 child-workflow 数量由 versioned execution policy 跨全部 state activation 记账，不能通过进入新 State 重置预算。
18. Nullable Workflow policy 的 `null` 只表示“不声明业务 ceiling”，绝不关闭部署级 `RuntimeSafetyCeilings`；所有运行时生成的 source、graph、递归、map、fact 和 blob 都受显式、有限、可审计的 safety ceiling 约束。
19. 需要修改共享外部资源的 Workflow 必须在 T0 获得 exclusive durable claim；Capability 以 slot 绑定全部 required claims，所有 mutation 通过 gateway 检查 current fencing token、稳定 operation key、receipt 和 immutable after-snapshot。
20. Workflow Port Schema 使用受限 Profile；相同 hash 默认兼容，不同 hash 必须有 sound subtype proof，转换只能由显式 versioned adapter 完成。
21. `work_fence_epoch` 只拒绝普通工作；Cancel、Reconcile、Compensation 与 Finalizer 绑定 winning `close_request_id`，Ancestor close 不覆盖已有 descendant request。
22. Workflow 权威事实位于独立 `workflow-runtime.db`；Workbench/messages 只保存可重建 Projection，跨库同步只使用幂等 Outbox。
23. Value/Blob Store 第一版不做机密性与 Value 级权限隔离，但必须保证 Hash/Schema/长度/provenance、有限 retention/physical capacity，且 Credential 原文永不落盘。

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

interface WorkflowRoutingCapability {
  ref: VersionedRef;
  executor_ref: VersionedRef;
  role_ref?: VersionedRef;
  skill_refs: VersionedRef[];
  prompt_template_snapshot: {
    template: string;
    template_hash: string;
  };
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

### Workflow 级执行 Policy 与 Runtime Safety

```ts
interface WorkflowExecutionPolicy {
  ref: VersionedRef;
  max_state_activations: number | null;
  max_graph_runs: number | null;
  max_state_transitions: number | null;
  max_child_workflows: number | null;
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
    max_child_workflows: number;
  };
  run: {
    max_scopes_total: number;
    max_nodes_total: number;
    max_edges_total: number;
    max_map_items_total: number;
    max_attempts_total: number;
    max_waits_total: number;
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
    max_outbox_delivery_duration_ms: number;
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

interface RuntimeSupportedLimits {
  max_scopes_total: number;
  max_nodes_total: number;
  max_edges_total: number;
  max_facts_per_transaction: number;
  max_subtree_scopes_per_fence: number;
  max_map_items_total: number;
  profile_hash: string;
}
```

Safety ceilings 是 pinned、确定性的命名配置，不是隐藏默认值；启动时必须提供全部有限正整数并记录 config hash。字段名称必须显式表达 `total/per_*` 作用域。Effective enforcement 取 safety ceiling 与所有 non-null global/Recipe/Definition/State/child business limit 的最小值；业务 `null` 表示不进一步收紧，`0` 表示禁止消费。Plan、Run、routing decision 和 Workbench 必须同时展示 business policy snapshot 与 safety snapshot/hash。

`DeploymentRuntimeCapacity` 是可动态调整的物理容量，不进入 Plan 语义；不足时产生 backpressure，ready work 保持 ready，不得转成 engine error。每次 admission 记录 capacity config hash。启动时还必须逐字段验证 configured safety ceiling 不超过当前版本认证的 `RuntimeSupportedLimits`；不满足时启动失败，不能运行到中途才发现 T3/T7 无法原子处理合法规模。

每个 Safety 字段必须进入规范 Enforcement Matrix，至少记录作用域、Account、执行组件、检查时点、reserve/consume/release、失败结果、错误码与是否进入 Plan hash。最低映射如下：

| Limit | Owner/对象 | Enforcement | 达限结果 |
| --- | --- | --- | --- |
| `run.max_nodes_total` | run account | T2b materialize | root engine error 或 child owner failure |
| `map.max_items_per_map` | map node account | seal manifest | `map_item_limit_exceeded` |
| `run.max_attempts_total` | run account | retry schedule/attempt create | Node 不再重试 |
| `execution.max_attempt_duration_ms` | attempt | deadline watchdog | timeout + work fence |
| `wait.max_pending_signal_age_ms` | inbox event | ingress/sweeper | `unmatched_expired` |
| `DeploymentRuntimeCapacity.max_active_executions` | deployment capacity | scheduler admission | 保持 ready/backpressure |
| `DeploymentRuntimeCapacity.max_physical_blob_bytes` | blob allocation | blob reservation/GC | backpressure/action-required |

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
| `terminal`           | 不创建 Graph Run，直接终结 Workflow Instance                          |

这样现有顺序 workflow 仍易于书写，但 delegation completion、retry、wait、checkpoint、cancel 和 trace 不再有 graph/sequential 双轨逻辑。

State 是受信任的宏观业务阶段，Graph Node 是某次 State Activation 内更细的执行单元。Workflow Definition 固定 State/transition topology，不一定是线性顺序；只有 `graph` state 的 source 可以由 Micro Planner 动态生成多节点 DAG。普通 `delegation/system/interrupt` state 也由 lowerer 转成最小固定 Graph，但 Planner 不参与。常见动态模式是 `*_graph_plan` delegation state 先发布通过 compiler dry-run evaluator 的 Scope Spec，下一 `*_graph_execute` graph state 在 T1/T2 冻结并正式编译同一 source hash；不再增加独立 `*_graph_compile` system state。

受信任 graph state 合同：

```ts
interface VersionedRef {
  id: string;
  version: string;
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
  deadline_ms: number | null;
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
    'max_attempts' | 'deadline_ms'
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
  | {
      id: string;
      type: 'start_child_workflow';
      recipe_ref: VersionedRef;
      relation_kind: 'follow_up' | 'background' | 'validation' | 'domain_defined';
      input_bindings: Record<
        string,
        | { source: 'context_slot'; slot: string; pointer?: string }
        | { source: 'completed_output'; json_pointer?: string }
        | { source: 'constant'; value: JsonValue }
      >;
      creation_key_template: string;
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

interface WorkflowDefinitionTerminalState extends WorkflowDefinitionStateBase {
  type: 'terminal';
  terminal_kind: 'normal' | 'errored';
  output_binding: WorkflowValueBinding | null;
}
```

`terminal_kind=normal` 必须提供 non-null output binding 并满足 Recipe output schema；`errored` 必须使用独立 error binding/fields，不得伪造 normal output。Global cancel 不经过 Terminal State output binding。

Root interface 的所有 exit 必须被 `exit_routes` 完整覆盖。Runtime spec 可以选择内部 graph 结构、trigger 和 completion policy，但只能引用 envelope 允许的资源；外层 transition、typed context patch、final output binding、权限和 configured limit 永远属于受信任 definition。

`WorkflowGraphPolicyProfile` 是 policy registry 中的 versioned immutable record，不是 source 内联权限对象。Effective business policy 按 global、workflow、state、parent compiled snapshot、child profile request 的顺序逐层求交：所有 allowlist 与 `allowed_recovery_kinds` 取集合交集；boolean permission 使用逻辑 AND；`max_impact` 与 numeric limit 只能逐层收紧并取最小有限值；child build 只能降低 `max_attempts/deadline_ms`，不能改写 inherited backoff。Root/State envelope 的权限数组和 boolean 必须显式配置，不能用 `null` 表示全部允许；child request 的 `null` 只表示继承 parent。Numeric limit/budget 的 `null` 表示不增加业务 ceiling，`0` 表示禁止消费；child 的 `null` 不能移除 parent 已有的有限限制。不存在隐藏 business limit，配置创建器必须生成全部 numeric 字段并以 `null` 初始化；部署级 finite `RuntimeSafetyCeilings` 始终另行取最小值。

Child request 的 allowlist 表示 ceiling 而不是 required dependency；其中 parent 未允许的 ref 在交集后自然移除，空交集本身可以是合法的“该类资源全部禁止”。只有 child source 实际引用 effective allowlist 外资源时 compiler 才报 `*_not_allowed`。Child profile ref 本身必须位于 parent `allowed_child_policy_refs`，否则不能应用。

`build_retry=null` 的 root/parent policy 表示只 acquisition 一次，child 不能重新启用 retry；child request 的 null 表示继承。Parent 已启用时 child 只能把 non-null `max_attempts/deadline_ms` 变得更严格，null 表示不增加 ceiling，backoff 继续继承 parent，不能由动态 source 改写。

`WorkflowDefinitionStateBase.type` 要扩展为上述完整 union，但不增加 `parallel` state。多个 ready node 的并发 claim 已是 Graph Runtime 原生能力；Workbench 可以批量创建并行布局，但保存结果仍是标准 `GraphScopeSpec`，不提供 public parallel DSL/builder。单节点 state 的 `on_complete/on_resume/on_expire/on_wait_cancelled` lower 为 root interface exits 和受信任 route mapping，不能继续由旧 completion handler 单独推进 workflow；需要 output condition、多级 route 或多步骤执行时直接使用 `graph`。

Delegation、system、interrupt authoring state 均保持严格单节点语义：分别 lower 为一个 delegation capability、一个 system capability 或一个 wait node；不保留 `before_delegate`、`after_complete` 或多步骤 `system.run.steps`。任何多节点流程一律使用 `graph` 显式表达。Transition 只决定 target state 及受信任的通知/card/effect，不得内嵌 delegate、capability、role、skill、prompt、retry 或 timeout；路径差异通过 source root 的 typed output 和 T8 trusted context patch 传递。需要不同执行合同的路径使用不同 target state/capability。

所有 executable authoring state 都显式携带完整 `WorkflowGraphPolicyEnvelope`；单节点 state 也不能由 lowerer 注入隐藏 business limits/permissions。配置创建器为其 numeric limits/usage budget 生成全量 null 字段，权限 allowlist/boolean 则必须显式填写；lowerer 同时绑定 run 创建时冻结的 safety snapshot，State 无权移除。

所有 delegation/system node 一律引用精确 `capability_ref: VersionedRef`，不再允许 runtime 直接组合 `role + skill + action`，也不允许 `latest`、版本范围或 runtime fallback。Feature package 在 publish 时注册 versioned capability；definition lowering 只生成 capability reference 和 typed bindings。Capability 固定 executor、prompt 骨架、role/skill、权限、port、artifact/evaluator/quality、retry ceiling、effect 和 cancellation contract；node 只能绑定 typed input，并收紧 retry/timeout，不能覆盖执行配置。具体任务要求可以作为 capability 声明的 typed input，但不能借 input 扩大权限或替换 trusted prompt 骨架。

Root Graph 的四类结果使用独立可信路径：normal named exit 由 `exit_routes` 完整覆盖；engine error 走 `on_error`；local graph cancel 走 `on_local_cancel`；global workflow cancel 固定终止 Workflow Instance、清空 current run，不能执行 state transition。Child 的 `parent_close` 只在 Graph 内部收敛，不触发外层 transition。

`start_child_workflow` 只允许出现在 published Definition 的 trusted transition effect，动态 Scope Spec 和 Planner 不能生成。T8 对 source cut、effect id 和 creation key 做 exactly-once child creation，并写 `workflow_relations`。Detached/background child 不阻塞 parent；若 parent 必须消费结果，应优先使用 subgraph，或由 child 通过 versioned signal contract 恢复 parent 的显式 wait，不能隐藏同步依赖。Child Recipe 必须位于 Definition 声明的 child-recipe allowlist，且计入 Workflow 级 `max_child_workflows` 与 safety ceiling。

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
  trigger_program: NodeTriggerSpec;
  input_ports: Record<PortName, CompiledNodeInputPortContract>;
  output_ports: Record<PortName, CompiledNodeOutputPortContract>;
  effective_limits: Record<string, number | null>;
}

interface CompiledCapabilityNode extends CompiledGraphNodeBase {
  type: 'delegation' | 'system';
  capability_binding: WorkflowGraphCapability;
  effective_retry_policy: Record<string, JsonValue>;
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

### Delegation 与 System

- `delegation` 执行 LLM 推理、开放式检索、抽取、综合和报告生成。
- `system` 只执行已注册 deterministic capability。
- 两者都通过 capability catalog 获得 executor、artifact contract、evaluator、quality gate、permissions、retry ceiling、timeout 和 effect contract。
- 每次执行创建 immutable attempt；execution outcome 与 quality decision 分开保存。
- `needs_revision` 只属于 attempt quality decision，可创建下一 attempt，不是 node terminal status。

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
- Inbox transaction 分配单调 `inbox_seq` 与 Runtime `received_at_ms`，不信任 provider timestamp。同一 Wait 按 `inbox_seq` 决定先后；timeout 只考虑已提交且 `received_at_ms <= deadline_at_ms` 的 valid event，网络层先到但未提交的请求不能击败已提交 timeout。Signal、timeout 和 cancel 仍竞争同一个 `status=armed + saved work epochs + version` CAS。
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

业务确实需要完整数组时，必须显式调用 versioned deterministic Materializer/Reducer system Node：它按 index 分页加载成员 ref、验证 hash/schema、执行 item/总字节限制并发布新的普通 Value。该新数组重新收取 logical output bytes；Map manifest 只按元数据字节计费。GC reachability 从 manifest 遍历全部成员 ref，Workbench 默认分页展示 slot metadata，仅打开具体 item 时 dereference payload。

Quorum/fail-fast decision 后 controller 进入 durable `closing_remaining`，winner set 与所有 fenced slot 已不可变，但 map owner 尚不 terminal。只有每个已 materialize remainder 都产生 non-publish cut、required compensation 已 terminal/action-required，且 open build/controller reservation 已清零后，owner 才发布最终 envelope 或 failure。这样下游不会在被截断 child 仍可能产生未结 effect 时越过 map 边界。

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
  priority: number;
  when: CompletionFactExpr;
  select: CompletionCandidateSelector;
}

interface ScopeCompletionPolicySpec {
  early_rules?: CompletionRuleSpec[];
  settled_rules: CompletionRuleSpec[];
  no_match: 'error';
  early_close: 'cancel_and_fence_remaining';
}
```

`early_rules` 与 `settled_rules` 共享同一个 scope-level rule id namespace；compiler 要求所有 `rule.id` 全局唯一，因此 close request/cut 只需保存 `selected_rule_id` 就能无歧义定位 rule 与 phase。

Completion 规则：

1. Rule 只有在 `when=true` 且 selector 匹配至少一个 persisted candidate 时才适用。Priority 数值越大优先级越高。
2. 每个 candidate/node-terminal fact transaction 都必须在分配 durable event seq 后，对 post-state 计算 early rules，并为首次适用的 rule 写 immutable eligibility record。Eligibility 保存 rule、candidate/fact snapshot 和最早 `eligibility_event_seq`。
3. Run control=running 时，同一 fact transaction 尝试插入唯一 close request：先选最小 eligibility event seq，同 seq 再按 `priority DESC, rule_id ASC`；paused 时只积累 eligibility，resume 使用相同排序，不能按恢复时的当前 candidates 重选。
4. `first_reached` 在 eligibility fact snapshot 内使用 durable `candidate_seq`；settled transaction 在同一个 fixed-point event seq 上评估所有 rules，按 `priority DESC, rule_id ASC` 选择，并持久化 `phase=settled` eligibility 与 close request。
5. Early rule 只能使用 compiler 可证明的单调 predicate，例如 `count >= N` 和正向 `and/or`；禁止 `not/eq/lte` 等可能被未来事实推翻的判断。
6. `lowest_terminal_node_id` 和全局 exit priority 只允许 settled 阶段，除非 compiler 能证明候选集合已经封闭。
7. Coordinator 永远选择一个 candidate，不隐式聚合多个 candidate。Quorum output 必须先由显式 reducer 生成一个 terminal candidate。
8. Close request 冻结 selected candidate/fact frontier，原子递增目标及 descendant fence epoch，并创建 cancel/compensation effects；scope 进入 `closing`，尚未写最终 completion cut。Root request 同时递增 run fence。
9. Close request 后的 late agent result、signal、timer 和 child completion 只能写审计，不能改变 selected candidate 或 frontier。
10. Scope quiescent 后没有 rule/candidate 匹配是 engine error `no_exit_selected`，不能猜成业务 failure。
11. `all_nodes_terminal` 只统计该 scope 自己的 nodes；single child owner 在 child cut 前不是 terminal，map quorum/fail-fast owner 在 materialized remainder 的 cut/compensation 收敛前也不是 terminal，因此 child lifecycle 不会被遗漏。
12. Settled rules 只在 reconciler 达到 fixed point 后运行。Quiescent 要求该 scope 的所有 node 已 terminal、所有 control/data resolution 已封闭、没有尚可 materialize 的 owner child 或 held controller reservation；pending node 必须先被证明 trigger/input impossible 并 terminalize，不能因暂时没有 ready work 就提前结算。Paused/resuming scope 不视为可自动 settled 的 quiescent scope；其事实先积累并在 resume drain 中仲裁。
13. Scope 只有所有逻辑工作已 fenced、required compensation 已 terminal 或转为 action-required 后才写 completion cut 并进入 closed。外部物理 cancel ACK 不阻塞逻辑关闭；其晚到结果受 fence 拒绝。
14. Routing、data resolution、condition、schema、ledger 或 invariant error 绕过正常 completion rules，直接创建 `engine_error` close request、fence scope，并最终产生 `GraphScopeOutcome.kind='errored'`。Root 按 pinned `on_error` 路由；child 按 owner mapping 收敛。

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

interface WorkflowGraphCapability {
  ref: VersionedRef;
  node_type: 'delegation' | 'system';
  executor_ref: VersionedRef;
  role_ref?: VersionedRef;
  skill_refs: VersionedRef[];
  prompt_template_snapshot?: {
    template: string;
    template_hash: string;
  };
  input_ports: Record<PortName, NodeInputPortContract>;
  output_ports: Record<PortName, NodeOutputPortContract>;
  artifact_contract_ref?: VersionedRef;
  no_artifact_expected?: true;
  evaluator_ref?: VersionedRef;
  no_evaluation_expected?: true;
  quality_gate_ref?: VersionedRef;
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
- Capability 是不可变、版本化的完整执行合同；node 不得覆盖其 executor、role/skill、prompt template、port、permission、artifact/evaluator/quality、effect 或 cancellation。Prompt template 初期直接固化在 capability snapshot 中，不单独建立 registry；出现明确跨 capability 复用需求后再提升为独立 versioned resource。
- Capability 可以声明 `task`、`instructions` 等 typed input 供 planner 提供本次业务内容，但这些值始终按 data 处理，不能替换 trusted prompt 骨架、选择额外 tool 或扩大权限。禁止注册允许任意 role/skill/tool/prompt 的 `run-any-agent` 类 capability。
- Capability 必须在 `artifact_contract_ref/no_artifact_expected` 中恰选一个，并在 `evaluator_ref/no_evaluation_expected` 中恰选一个；blocking quality gate 必须与对应 evaluator/artifact contract compatible。
- Compiled node 固化完整 binding snapshot/hash；dispatch 不重新解析或 fallback。
- `effect` 描述恢复方式，`effect_impact` 描述业务影响，两者正交。Publisher 为 executor、Tool、MCP method、Action 与 file scope 注册 impact metadata，递归计算 dependency closure；Capability 的 impact 不得低于任一依赖，`pure` 不得引用 write access。State Policy 必须同时允许 recovery kind 与 impact。
- Recipe Publisher 对所有可达 State、动态 allowlist、trusted transition effect 和自动 child Recipe 计算最大 impact、recovery-kind set 与 permission union。派生结果超过 Recipe `effect_ceiling` 时发布失败；Runtime dispatch 再校验 compiled binding 的 dependency closure hash，不能信任手写 `read_only/pure` 声明。
- Run/Event audit 记录实际使用的最大 impact 和 recovery kind，但创建授权始终按“最大可能闭包”完成，不能用历史实际用量降低本次权限检查。
- `pure/idempotent` capability 可以按其 effect contract 恢复或重放，但 `idempotent` 仍可能是 mutation，不能被当作 read-only。
- Effect key strategy 是 trusted capability contract 的一部分。`attempt` 只去重同一 attempt 的 outbox redelivery；`node` 让 node retry 复用同一业务操作；`workflow` 适用于每个 Workflow 只执行一次的操作；`business_input` 对 namespace 与列出的 frozen typed input port 做 canonical hash，适用于 `workspace + package + target_state` 等跨 attempt/workflow 业务幂等。Planner 不能选择 strategy、namespace 或参与 key 的 port。
- `business_input` 的 namespace 在 registry 中全局唯一，所列 port 必须是 required、sealed、非 secret 的 single value；operation key 在 effect intent transaction 中由 Runtime 计算并持久化。Adapter 不能接受调用方自报 key，也不能把不同 frozen input 合并成同一 receipt。
- `compensatable` capability 的外部 operation 必须先写 effect intent，再执行，再写 receipt；compensation 同样通过 outbox、幂等键和 lease。
- `fence_only` 只适用于没有未记录不可逆 effect、可以安全丢弃 late result 的执行；`cooperative` 会发稳定 cancel effect，但物理 ACK 不阻塞逻辑 close，因此 capability 必须显式保证 cancel 丢失/延迟时仍可安全 abandon。不能满足该保证的 effect 必须使用 compensation。
- `requires_compensation` 必须与 `effect.type=compensatable` 配对，并使 scope closing 等待 compensation terminal 或 action-required。
- 所有 capability 都必须实现上述一种 cancellation contract，因为 global workflow cancel 可以在任意时刻发生；没有安全 fence/cancel/compensation 语义的 capability 不得注册到 Graph Runtime。
- Early close、manual cancel 或 parent cancellation 可能截断 active effectful node。Compiler 必须根据 cancellation/effect contract 证明该组合可 fence、cooperative cancel 或 compensation。
- Compensation failure 不回滚数据库历史；scope/run 进入结构化 engine error 或 action-required 状态并保留 effect journal。
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

Core 与 Feature package 是 registry resource 的发布者。Feature manifest 可以声明 `workflowRecipes`、`workflowRoutingScopes`、`workflowRoutingCapabilities`、`workflowExecutionPolicies`、`workflowCapabilities`、`workflowSchemas`、`workflowGraphInterfaces`、`workflowGraphTemplates`、`workflowGraphPolicies` 和 `workflowWaitContracts` 资源目录；其中 Graph Scope Template 与 capability 内部的 prompt template 是不同概念。加载资源时先做 strict parse/schema validation、canonicalize 和 hash，再写 immutable registry store。当前 `src/features/manifest.ts` 的 `FeatureResources` 只支持旧资源目录，Graph Runtime 实施必须同步扩展 manifest parser、resource registry、management deletion summary 与测试，不能只在文档或 Feature JSON 中声明新字段。

```text
workflow_registry_resources
  - resource_type
  - resource_id/resource_version
  - owner_kind/owner_id        core | feature
  - canonical_payload/ref
  - content_hash
  - published_at

UNIQUE(resource_type, resource_id, resource_version)
```

- 相同 `(resource_type, id, version)` 的内容发布后不可修改；再次加载相同 ref、不同 hash 必须失败，修改只能发布新 version。Feature version 与其中各 resource version 相互独立。
- Workflow definition 发布时解析所有精确 ref，并保存 definition dependency ref/hash；依赖缺失或冲突时不能发布。
- Recipe 发布时解析 Definition/entrypoint、execution policy、Context Contract、input/output schema、child Recipe allowlist 和 resource claim pointer，并从所有可达 Capability/Tool/MCP/Action/file/transition/child Recipe 派生 effect-impact、recovery-kind 与 permission closure；派生结果超过作者 `effect_ceiling` 时拒绝发布。Routing Scope 发布时验证 target 精确存在、scope graph 无环且不存在跨 owner 越权引用。
- Run 创建时固定本次 registry snapshot。由于 `expand` 可以在运行中选择 policy allowlist 内尚未被静态 plan 使用的资源，snapshot 必须覆盖所有 allowlisted capability/interface/template/wait/policy 及 schema 传递依赖，不能只覆盖当前 nodes。
- Snapshot 可以引用 immutable registry rows，不必重复 payload；某个 Compiled Plan 实际使用的 capability/interface/policy/wait/schema 合同必须完整固化进 plan，而不是只保存 package 文件路径。
- Published definition 或 active run 仍引用 resource 时禁止删除该 version；active run 仍依赖 executor 时禁止 disable/uninstall 提供实现的 Feature。升级顺序固定为发布新 resource、发布引用新 ref 的 definition、等待旧 run closed、archive 旧 definition，最后才允许清理旧 resource。
- Closed run 保留完整 contract snapshot 用于审计，即使对应 Feature 之后已卸载。

Capability 的 `executor_ref` 必须解析到 versioned executable implementation record，至少保存 provider Feature/release、entry symbol、implementation artifact hash、runtime compatibility 和 availability status。仅保存 capability JSON 而覆盖本地 JS/skill/script 文件不能保证旧 run 可恢复。实现必须二选一：保留多版本 executable artifact 并按 pinned ref dispatch；或在旧 active run 关闭前阻止 Feature upgrade。长时间 approval/wait 场景推荐前者。

Feature 生命周期固定为：

```text
enabled   -> 可以创建新 Workflow，旧 run 正常执行
draining  -> 禁止新建，保留 API/executor/resource 供 active run 收敛
disabled  -> active run/reference 已清零，不加载业务入口；审计 snapshot 仍保留
deleting  -> 满足 retention、无 active/published ref，并完成二次确认后清理 feature-owned data
```

`disable` 不能把 active run 变成只读僵尸。Force disable 必须先对全部 active Workflow 发 global cancel，等待 fence/required compensation/cut 收敛；quarantined/action-required run 未被可信处置前禁止删除依赖。Closed run 的审计 contract/blob retention 与 Feature projection/domain data deletion分别计算，不能因删除页面数据破坏 completion cut 的可验证性。

Prompt/skill/script 自进化不得原地覆盖 published resource。Regression 通过后固定顺序为：提交新的 authoring source、发布新的 executor/capability version、发布引用新 ref 的 Definition/Recipe version、原子切换新创建请求使用的 RecipeRef；已有 intake/run 继续使用旧 snapshot。任何 `latest` 解析只允许发生在受信任创建面，并立即固化 exact ref，Graph build/dispatch/recovery 永远不读取 latest。

## Compiler

Workflow Definition Compiler、Scope Compiler 和 Static Lowerer 是不同信任边界，但共享 schema、canonical JSON、interface resolver、policy intersection 和 capability binding。

### JSON、Canonicalization 与 Hash

- Source IR、registry contract、typed input/output 和 wait payload 以 JSON Schema Draft 2020-12 为 dialect，但 Workflow Port 只允许 sound、受限的 `icarus.workflow-schema/1` Profile。对象默认 closed-world (`additionalProperties: false`)，`$ref` 只能解析到 pinned registry 中的精确 schema version，禁止 runtime network ref。
- Profile 第一版允许 `type/const/enum/properties/required/items`、closed object、数值/字符串/数组边界、固定 registry `$ref`、受约束 format/pattern，以及以固定 `const` 判别字段组成的 discriminated `oneOf`。禁止 `anyOf/not/if-then-else/$dynamicRef`、递归 ref、`patternProperties/dependentSchemas/contains` 与任意 `allOf`；需要继承时在发布阶段先归一化成普通 closed object。
- Schema 默认只有相同 `schema_hash` 直接兼容。不同 hash 必须由 versioned、sound 的 subtype 算法证明，覆盖 const/enum 集合、integer->number、区间、closed object、array 和 discriminated-union 分支；无法证明即 `schema_not_assignable`，不能乐观放行。重命名、合并、类型转换或版本升级必须使用显式 versioned deterministic system adapter Node。
- Data Edge JSON Pointer 默认必须在 Producer 的所有合法值中存在并推导出唯一兼容 Schema；允许缺失时必须显式 `on_missing='unavailable'`，且目标 aggregation 能处理 unavailable。第一版不根据 control condition 自动 narrowing union。
- JSON 内部寻址统一使用 RFC 6901 JSON Pointer。Condition、data edge 和 artifact binding 不接受 dotted path、JSONPath 或自定义混合语法。
- 输入使用能检测 duplicate object key 的 strict JSON parser；拒绝 duplicate key、`NaN`、`Infinity`、`undefined`、`BigInt` 和非 JSON 对象。结构字段数字必须是 JavaScript safe integer；高精度 decimal、money 和 64-bit integer 使用 string schema。
- Canonical JSON 使用 RFC 8785 JCS 和 UTF-8；不额外做 Unicode normalization，stable id 使用 ASCII pattern。Source hash 对 parsed source 做 JCS 并保留业务 array 顺序；Plan hash 先把 nodes/edges/rules 等 set-like collections 按 stable id normalize，再做 JCS。
- Hash 统一为 `sha256:<64 lowercase hex>`，并在 canonical bytes 前加入 object type/format domain separator，例如 `icarus:workflow-graph-source:1\n`、`icarus:workflow-graph-plan:1\n`、`icarus:workflow-graph-completion-cut:1\n`，禁止不同对象类型之间混用相同 payload hash。
- Parser、2020-12 Validator、Profile、format registry、assignability checker 和 JCS canonicalizer 的兼容版本进入 `compiler_version`；Validator 禁止 coercion、删除字段或写入 default。相同 compiler version、source、schema、interface、policy 和 catalog snapshot 必须产生逐字节相同的 plan/hash。

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
  producer_schema_hash: string;
  pointer: string | null;
  derived_schema_hash: string;
  consumer_schema_hash: string;
  compatibility_rule: string;
  proof_hash: string;
}
```

### Compiler 输入快照

- Winning Task Intake、Recipe Descriptor、Workflow execution policy 与 routing/creation decision ref/hash；Scope Compiler 不重新路由。
- Published workflow definition version 与 state config hash。
- Root/child Scope Spec canonical bytes/hash。
- Scope Interface、policy envelope、template、capability catalog 和 evaluator registry 的 version/hash snapshot。
- Scope input port schemas；compiler 不读取或按实际 input value 特化 plan。
- Inherited policy ceiling。Parent scope id、owner node id、child key、实际 input snapshot 和 ledger reservation 属于 materialization，不进入 plan。
- RuntimeSafetyCeilings canonical snapshot/hash；任何 compiler/business null limit 都不能移除它。

### 必须校验

- Strict JSON、duplicate-key rejection、closed schema、format revision、RFC 8785 canonical JSON、配置为非 `null` 时的 size/depth limit 和 stable id。
- Interface 精确匹配，所有 required input/exit output 均有 typed binding。
- Node/edge/route group id 唯一，所有 endpoint 和 port 存在。
- 每条 incoming control edge 恰好被 target trigger 引用。
- Condition 只引用合法 scope/source fact，类型可比较，AST steps 在 limit 内。
- Route group mode/default/priority/no-match 无歧义。
- Data aggregation、guard、schema、pointer 和 selection policy 合法；每条 Data Edge 保存 `DataEdgeCompatibilityProof`。Profile 复杂度受 routing schema safety ceilings 限制，unsupported keyword、unpinned ref、non-total pointer 与 complexity overflow 使用独立结构化错误码。
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
  plan_hash: string;
  source_hash: string;
  interface_snapshot_hash: string;
  policy_snapshot_hash: string;
  effective_policy_snapshot: WorkflowGraphPolicyEnvelope;
  capability_catalog_hash: string;
  wait_contract_catalog_hash: string;
  interface_snapshot: GraphScopeInterfaceContract;
  nodes: CompiledGraphNode[];
  route_groups: RouteGroupSpec[];
  control_edges: ControlEdgeSpec[];
  data_edges: DataEdgeSpec[];
  completion: ScopeCompletionPolicySpec;
  effective_limits: NullableWorkflowGraphLimits;
  effective_usage_budget: NullableWorkflowUsageBudget;
  runtime_safety_snapshot: WorkflowRuntimeSafetyCeilings;
  runtime_safety_hash: string;
}
```

Plan 保存完整 effective business policy 与 runtime safety snapshot；hash 只是完整 canonical snapshot 的校验值，不能替代后续 child compile 所需的 allowlist、wait、effect、build、limit 和 safety 字段。Plan hash 排除 instance id、actual input value/hash、ledger reservation、timestamp、lease 和运行状态；objects 按 key、nodes/edges/rules 按稳定 id canonicalize，业务数组保持定义顺序。相同 source、input schema、interface、policy、safety、catalog 和 compiler 必须产生相同 plan hash，因此不同 map item 可以复用同一 plan。Actual input values 只在 scope materialize 时校验并写 instance input snapshot/hash 与 Run Manifest entry。

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
- Operational state 与 lifecycle/control 正交。`action_required` 只允许受限 remediation command；`quarantined` 和 `administratively_abandoned` 都禁止 scheduler/state progression。Administrative abandon 归档 Workflow，但不把不可信 run 伪造成 `closed`，因此不需要伪造 completion cut。
- Root run 在首次外部 cancel CAS 时冻结 `root_cancel_scope=local_graph|workflow`；每个 child scope 的 normal/error/parent-close 原因由自身唯一 close request 保存。不同 child 可以并发 parent-close，不能复用一个 run-level 枚举。

Node outcome：

```ts
interface GraphNodeTerminalOutcome {
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  code?: string;
  child_exit?: ExitName;
}
```

Skip code 至少区分 `route_not_selected`、`input_unavailable`、`early_close`、`manual_skip` 和 `parent_cancelled`。Node terminal 后不重新打开；retry 创建新 attempt，graph-level rerun 创建新 activation/root run。

## Resource Ledger 与调度

初始节点集合无法覆盖 runtime expansion/map，因此不能用 `sum(max_attempts)` 代替预算执行。Ledger 是唯一资源事实源：

```text
workflow_graph_resource_accounts
  - id
  - account_scope_kind/id  deployment | workflow | run | scope | node |
                           execution_group
  - resource_type        state_activations_total | graph_runs_total |
                         state_transitions_total | child_workflows_total |
                         scopes_total | nodes_total | attempts_total | waits_total |
                         active_waits | logical_output_bytes | stored_bytes |
                         active_executions | effect_ops |
                         optional: tokens | tool_calls | cost_micros
  - hard_limit           effective finite ceiling；取 runtime safety ceiling 与全部 non-null business limits 的最小值
  - reserved_amount
  - consumed_amount
  - version

workflow_graph_resource_reservations
  - id
  - graph_run_id/reservation_group_id
  - consumer_kind/consumer_id  build | scope | node | attempt | wait | output | effect
  - resource_type
  - purpose
  - settlement_mode      consume_on_create | hold_then_release | incremental
  - reserved_remaining/consumed_amount
  - status               held | committed | released
  - created_at/settled_at/version

workflow_graph_resource_reservation_postings
  - reservation_id/account_id
  - reserved_remaining/consumed_amount
  - status/version

workflow_graph_resource_ledger_entries
  - id
  - graph_run_id/ledger_seq
  - reservation_group_id
  - account_id/reservation_id
  - operation            reserve | commit | release | charge
  - delta_reserved/delta_consumed
  - idempotency_key
  - previous_chain_hash/chain_hash
  - created_at

UNIQUE(account_scope_kind, account_scope_id, resource_type)
UNIQUE(graph_run_id, consumer_kind, consumer_id, resource_type, purpose)
UNIQUE(reservation_id, account_id)
UNIQUE(idempotency_key)
UNIQUE(graph_run_id, ledger_seq)

workflow_graph_scheduler_admissions
  - admission_seq INTEGER PRIMARY KEY AUTOINCREMENT
  - graph_run_id/scope_id/node_id/attempt_id
  - eligible_event_seq
  - execution_reservation_id
  - capacity_config_hash/runtime_supported_limits_hash
  - created_at
```

- Account 表示额度作用域，Reservation 表示具体消费者；两者不得再共用 `owner_kind/id`。Map 使用 `account_scope_kind=node`，不增加 map owner 类型；原 `target group` 统一改成 Capability Catalog 固定的 versioned `execution_group_ref`，Planner/Source 不能选择 group 规避容量。
- 一个 Reservation 通过 Posting 在同一事务 CAS 全部相关 Account，例如 deployment/workflow/run/scope/map-node/execution-group。任何 Account 不足则全部不变，不能部分占额。主错误按 `deployment -> workflow -> run -> scope -> node -> execution_group -> account_id` 固定顺序返回 `resource_limit_exceeded` 及 hard/reserved/consumed/requested。
- Account `hard_limit` 是对应 pinned runtime safety ceiling 与所有 non-null business limits 的最小值，因此受 Ledger 管理的结构资源始终 finite。业务 limit 为 `null` 只表示不额外收紧 safety ceiling，不会把 effective `hard_limit` 变成 `null`。Live deployment capacity 单独由 Scheduler admission 执行，暂时不足只 backpressure；`tokens/tool_calls/cost_micros` 只在显式配置 finite business budget且执行网关可可靠归集时创建 account。
- Ledger entries 是事实源；account counters 是可从 hash chain 验证和重建的 cache。Run 保存 `ledger_seq/ledger_head_hash`。
- 一个 logical admission 使用 `reservation_group_id` 聚合，但每种 resource 都创建独立 reservation；不能用一个 header status 同时表示永久 attempt 消费、可释放 executor slot和其他增量 charge。
- Materialize scope 时分别创建并 commit `scopes_total/nodes_total` reservation。
- T0/T1/T8 创建 activation、root run、transition 或 child workflow 时分别在 Workflow account commit `state_activations_total/graph_runs_total/state_transitions_total/child_workflows_total`；这些累计额度跨 run 不释放。
- 创建 attempt 时 commit `attempts_total`，并为执行期创建 held `active_executions` slot；attempt terminal/fenced 后释放 slot。
- Arm wait 时 commit `waits_total` 并 hold `active_waits`；wait terminal 后只释放 `active_waits`，累计次数不会回退。
- Persist output 前预留 bytes，实际值小于 reservation 时释放差额。
- Map 必须先冻结 item count，再批量或按窗口预留 child scope/node quota；额度不足时确定性失败，不能半创建而不记录 remaining set。
- Map 窗口反复调整同一个 `(consumer_kind=node, consumer_id=map_node_id, resource_type, purpose)` incremental reservation，并用新的 ledger idempotency key 记每次 reserve/commit/release；不能为同一 node/resource/purpose 创建第二个 reservation 绕过 composite unique。
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

Scheduler 只决定 ready node 何时获得本机 execution slot，不改变 route/completion 语义。`max_concurrency` 是 nullable Workflow policy；本机 executor capacity 是运行环境物理容量，不属于隐藏的 Workflow limit。符合 policy 的 ready nodes 先按 Workflow Run 做持久化 round-robin：优先 `last_admission_seq` 最小或从未获得 slot 的 run；run 内按 `(eligible_event_seq ASC, scope_manifest_seq ASC, node_key ASC)` 选择。每次成功 claim 在同一事务分配 global admission seq、更新 run `last_admission_seq`、reserve slot 并写 admission event，restart 后不能丢失公平游标。Graph Source 不提供 scheduler priority；route group 的 `priority` 只控制条件匹配顺序。Armed wait 可以占 `active_waits` account，但不占 `active_executions` slot。

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
  - acquired_at/released_at/version

workflow_domain_resource_heads
  - namespace/key_hash
  - current_fencing_token
  - version

UNIQUE(owner_workflow_id, namespace, key_hash)
INDEX(namespace, key_hash, status, mode)
```

T0 创建事务必须在插入 Workflow 前原子检查 shared/exclusive compatibility并写 held claim；冲突返回结构化 `resource_busy` 与现有 owner，不允许先创建 Workflow 再异步抢锁。Shared Claim 只授权读取且不递增 token；mutation 必须持有 exclusive Claim。Exclusive acquire 以 CAS 递增资源头的 `current_fencing_token` 并把新 token 固定到 Claim。Claim 不因进程 lease、pause、human wait 或普通 worker crash 自动过期；只在 Workflow normal/error/cancel terminal、可信 remediation 或 administrative abandon policy 明确允许时释放。

正式 mutation 不能由 Worker 直接写目标资源。Worker 只能写 staging/shadow；受信任 mutation gateway 在最终 promote/commit 前必须同时验证 `claim.status=held`、`mode=exclusive`、owner Workflow、namespace/key 与 `claim.fencing_token=resource_head.current_fencing_token`。Release 后旧 Claim 即因 status 失效，即使尚无新 holder 也不能写。一个 effect 的全部 required claim slot 在 intent transaction 中原子解析；缺少任一 slot 都不得 dispatch。

第一版 Claim 只允许在 T0 根据可信 Task Input 获取。Graph 只能选择 Recipe 已获得的逻辑 claim spec id，不能在运行时发现 raw key 后动态抢锁；需要修改新资源时，由 trusted transition 创建使用新 Recipe/T0 的 child Workflow，避免动态多资源加锁和死锁。Recipe 应使用最细业务 key，避免一个长时间 human wait 用 workspace 全局锁阻塞无关 package。

同一 `creation_key + creation_intent_hash` 重放若已存在 Workflow，返回原 Workflow 和原 claims；同 key 不同 intent 必须返回 `idempotency_conflict`，不得静默复用旧 Workflow，也不得因为当前 claim 冲突创建第二个实例。Claim acquisition/release、Workflow lifecycle event 和 outbox effect 使用稳定 idempotency key。Workbench 必须展示 owner、key summary、mode、token、held duration 和解除条件，但不得泄露 secret key material。

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
  owner_workflow_id: string;
  provenance_ref: string;
  retention_class: RetentionClass;
  payload_pruned_at_ms: number | null;
}
```

第一版威胁模型限定为本地单用户、本机账号与数据目录可信、已加载 Feature/Plugin 处于同一读取信任域；暂不实现应用层加密、Value 级多用户/跨 Feature 授权、数据分类、HMAC 或 cryptographic erasure。这只延期机密性与读取隔离，不削弱 Capability permission、Domain Claim、fencing 和 mutation gateway。

Blob path 由内容 SHA-256 决定，例如 `data/workflow-runtime/blobs/sha256/ab/cd/<full-hash>`；相同 bytes 复用相同 blob，已发布内容永不原地覆盖。所有 Value 无论 inline/blob 都保存并在读取/恢复时验证 Schema、Hash、byte length、owner 与 provenance。Credential、Cookie、private key、数据库密码等秘密原文禁止写入 Value/Blob Store，只保存 `credential_ref`；带 token 的 URL 也必须改为 opaque locator ref。SQLite 与 filesystem 不能组成一个事务，因此写入顺序固定：先生成 canonical bytes、校验 schema/non-null byte limit、计算 hash，写同 filesystem temp file，`fsync + atomic rename` 到 hash path，最后在 SQLite transaction 中提交 blob metadata 与业务引用。Rename 后、DB commit 前 crash 只产生 orphan blob；DB 绝不能先提交尚未 durable 的文件引用。Recovery 逐字节校验 length/hash。

Workspace artifact 是可变文件，node succeeded 前必须复制/提交为 immutable blob snapshot，或绑定具有 immutable/versioned 保证的 external locator 与 expected hash。目录型 artifact 保存按安全相对 path 排序的 file manifest/hash，禁止 hard link 充当 immutable snapshot。

Immutable 不等于永久保存。`transient` 在短 grace 后清理；`run_recovery` 在 Active/closing/action-required/quarantined 期间强制保留，Closed 后按有限期限清理；`workflow_audit` 长期保留 Hash/Schema/Cut/receipt summary，payload 可到期删除；`user_artifact` 按 Recipe/用户策略；`pinned` 必须人工解除。Payload 删除后保留 value id/hash/length/schema/provenance、`payload_pruned_at_ms` 与 tombstone，不能伪造仍可完整重放。

无引用 temp/blob 通过带 grace period 的 mark-and-sweep GC 清理。Deployment physical blob capacity 使用可释放 allocation：写前预留预计物理字节；soft high-water 触发 GC/限流，hard limit 或 minimum-free-disk reserve 触发 backpressure/action-required，不得写完后才发现磁盘耗尽，也不得删除 Active Run 必需数据。Closed Run reachability 必须按 retention class 而不是永久保留全部 payload。

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
  - next_attempt_no/version/timestamps

workflow_task_intake_revisions
  - id/intake_id/revision_no/parent_revision_id
  - amendment_ref/hash
  - effective_input_ref/hash
  - attachment_manifest_ref/hash
  - clarification_contract_ref/hash
  - source_routing_attempt_id
  - actor/principal_ref
  - idempotency_key
  - created_at

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
  - created_at

workflow_creation_requests
  - id/intake_id
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
  - created_at/updated_at

workflow_launch_confirmations
  - id/intake_id/intake_revision_id/input_hash
  - routing_decision_id/hash
  - recipe_ref/hash
  - creation_intent_hash
  - actor_ref/action        approve | decline
  - expires_at_ms/idempotency_key/created_at

workflow_creation_attempts
  - id/creation_request_id/attempt_no
  - status/error_code/retry_at_ms
  - created_at

UNIQUE(creation_domain, creation_key)
UNIQUE(intake_id, attempt_no)
UNIQUE(intake_id) WHERE status='created'
UNIQUE(creation_request_id, attempt_no)
UNIQUE(intake_id, idempotency_key)
```

`creation_domain` 是受信任入口确定的 namespace，例如 `feature:pm-pipeline` 或 `api:<principal-scope>`；调用方不能用不同 domain 绕过同一业务幂等键。Revision 0 保存初始完整输入；后续 revision 同时保存受合同约束的 amendment、完整 effective-input snapshot 与 parent hash。并发回答必须携带 `expected_revision_no`，旧 revision 返回 conflict，不自动 merge。Router attempt 可以多次追加但不能覆盖，且必须引用 exact revision/hash。

最终创建前计算 `creation_intent_hash = H(creation_domain, creation_key, principal_scope, routing_scope_ref/hash, recipe_ref/hash, entry_point, effective_input_hash, attachment_manifest_hash)`。相同 key 与相同 intent 返回原 request/Workflow；相同 key 与不同 intent 返回 `idempotency_conflict`。Confirmation 绑定 exact revision、decision、Recipe、intent、actor、expiry 与 nonce；任一绑定改变都使旧确认失效。`resource_busy` 等临时失败进入 `blocked_retryable` 并追加 attempt，不改变 intent 或要求新 key；永久拒绝与取消仍永久占用原 key。

### Workflow 与 Run

```text
workflows
  - recipe_ref/version/hash
  - creation_request_id/creation_domain/creation_key
  - workflow_execution_policy_ref/hash
  - workflow_input_ref/hash/schema_ref/schema_hash
  - context_contract_ref/hash
  - current_context_snapshot_id/hash
  - runtime_safety_hash
  - state_activation_count/graph_run_count/state_transition_count/child_workflow_count
  - started_at_ms/deadline_at_ms
  - workflow_definition_version
  - state_instance_id
  - current_graph_run_id
  - final_outcome_kind
  - final_output_ref/hash/schema_hash
  - final_error_code/error_ref
  - final_cancel_reason
  - revision

UNIQUE(creation_domain, creation_key)

workflow_graph_runs
  - id
  - workflow_id
  - state_key
  - state_instance_id
  - workflow_definition_version
  - state_config_json/hash
  - registry_snapshot_ref/hash       覆盖 effective allowlist 与传递依赖
  - runtime_safety_snapshot_ref/hash
  - runtime_supported_limits_hash
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
  - control_epoch
  - work_fence_epoch
  - outcome_kind
  - exit_name
  - output_ref/hash
  - error_code/error_ref
  - next_event_seq
  - last_admission_seq
  - version
  - started_at/finished_at/created_at/updated_at

UNIQUE(workflow_id, state_instance_id)
CHECK lifecycle!='closed' OR completion_cut_id IS NOT NULL
CHECK lifecycle!='closed' OR outcome_kind IS NOT NULL

workflow_state_transition_history
  - id
  - workflow_id
  - source_state_instance_id
  - source_run_id
  - completion_cut_id
  - target_state_key
  - target_state_instance_id          nullable for workflow terminal
  - target_run_id                     nullable for workflow terminal
  - workflow_revision
  - context_patch_hash
  - created_at

UNIQUE(source_state_instance_id)
UNIQUE(completion_cut_id)

workflow_relations
  - id
  - parent_workflow_id/child_workflow_id
  - source_state_instance_id/source_run_id/source_completion_cut_id
  - transition_effect_id/relation_kind
  - recipe_ref/creation_key
  - created_at

UNIQUE(parent_workflow_id, source_completion_cut_id, transition_effect_id)
UNIQUE(child_workflow_id)

workflow_context_snapshots
  - id/workflow_id/revision
  - contract_ref/hash
  - previous_snapshot_id/hash
  - slots_manifest_ref/hash
  - snapshot_hash
  - created_at

workflow_context_slot_values
  - snapshot_id/slot_name
  - value_ref/hash
  - schema_ref/hash
  - byte_length/provenance_ref

workflow_context_patches
  - id/workflow_id/source_run_id/completion_cut_id
  - source_port/pointer/target_slot
  - old_value_hash/new_value_hash
  - patch_ref/hash
  - created_at

UNIQUE(workflow_id, revision)
UNIQUE(snapshot_id, slot_name)
UNIQUE(completion_cut_id)
```

Run 只缓存 `root_close_request_id`，完整 canonical request 与 `request_hash` 只存在 close-request row；`close_reason/frontier/cancel payload` 不在 run 上复制第二份。Transition history 的两个 unique key 分别证明一个 activation 只推进一次、一个 root cut 只消费一次。Workflow counters 是 Ledger 可验证 cache；T0/T1/T8 在同一事务检查 execution policy、safety 和 duration deadline。`workflow_relations` 只表达 lineage，不把 child 状态复制到 parent。

Workflow Input 永久不可变；Context 只保存 State 间中间结果。Definition 固定 exact `WorkflowContextContract`，Planner 不能增加 Slot。Context Snapshot 和 Slot 只保存 Value ref/hash/schema/provenance，不内嵌大业务值；Workbench summary 是 projection。读取 `context_slot` 时 Runtime 校验合同、hash/schema，dereference 业务值后应用 pointer，并冻结到 State/Node input snapshot。Transition patch 只允许 typed `set/replace/clear`，禁止隐藏 merge/append/任意 JSON Patch；业务合并使用显式 system adapter。

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
  - created_at

UNIQUE(graph_run_id, plan_hash)

workflow_graph_scopes
  - id
  - graph_run_id
  - parent_scope_id
  - owner_node_id
  - child_key
  - scope_kind              root | subgraph | expansion | map_item
  - depth/lineage_path      用于原子 fence descendant
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
  - version
  - created_at/finished_at/updated_at

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
  - created_at

UNIQUE(graph_run_id, manifest_seq)
```

Root scope shell 在 activation transaction 与 run、root build 同事务创建。`plan_id=NULL` 只允许 root scope 处于 materializing，或因 setup error 直接 closing/closed；scope 进入 active 前 plan 必须非空。Child scope 只有 build compiled 并 materialize 成功后才创建。`lineage_path` 是由 immutable scope ids 组成的 materialized path；实现也可使用等价 recursive CTE，但 parent close 必须在一个事务更新完整 descendant set，不能异步传播 fence。

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
  - attempt_count/next_attempt_at/deadline_at
  - lease owner/token/expires_at
  - error_code/error_json
  - version/timestamps

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
  - sealed_at/version

UNIQUE(owner_node_id)
```

Owner 必须先完整冻结 Expansion Manifest，再创建任何 child build。Map Expansion Manifest 固定 collection hash、每个 item 的 index/key/input hash 和 ordered result slot；crash recovery 只能从 sealed Expansion Manifest 补齐缺失 build，不能重新读取 planner output 或追加 item。Paused run 可以完成 snapshot/compile 并保存 `compiled` build，但 resume 前不得 materialize 或消费 scope/node ledger。

Root source 的冻结规则固定：inline 来自 published definition snapshot；`context_slot` 在 T1 对同一 workflow revision 解析 exact Slot value ref、校验 contract/hash/schema 并冻结 canonical source bytes/hash；artifact 在 T1 冻结 immutable locator、expected hash 与 JSON Pointer，随后在事务外获取；template 从 pinned registry snapshot 解析精确 `VersionedRef`。任何后续 Context Snapshot、file 或 latest-registry 变化都不能影响已创建 build。

Compiler 是 pure deterministic component，不能调用模型修复 frozen source。Closed-schema、interface、policy、DAG、condition、completion 或 permission error 立即进入 `failed`，不得对同一 build 静默改写 source。需要 AI 修正时，使用显式 planner capability：每个 planner attempt 生成 candidate，evaluator 使用同一 Scope Compiler dry-run 并把 structured diagnostics 作为 `needs_revision` 反馈；只有最终 pass attempt 才发布 Graph Spec output。Root context/artifact source 编译失败走本次 activation `on_error`；需要新 source 时创建新的 activation/run。Expand 同样只消费 owner 已 seal 的最终 candidate。

`build_retry=null` 表示只做一次 acquisition；非 null build retry 的 `max_attempts` 包含首次 acquisition，`max_attempts=null` 表示不设置业务次数 ceiling，`deadline_ms=null` 表示不设置业务总时长 ceiling，启用 retry 时必须显式配置 `initial_backoff_ms`，不注入默认业务值。实际 attempt count 与 duration 仍受 `execution.max_build_attempts_per_build/max_build_duration_ms` 和 run total safety ceiling。只有 immutable locator 获取等 transient error 可以按该策略重试；compile error 永不 retry。Build 创建事务写 `attempt_count=1` 和配置存在时的 absolute deadline，restart/pause 不能延长。每次外部 snapshot/compile 都必须持有 build lease，并以 `build_id + status + lease_token + source/input/compiler hashes + saved run/owner-scope work epochs + version` CAS 提交，stale compiler 不能覆盖新状态。

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
  - version/created_at/resolved_at

UNIQUE(owner_node_id, item_index)
UNIQUE(owner_node_id, item_key_hash)
```

Seal map Expansion Manifest 时同时创建覆盖全部 index 的 `open` result slots。每个 slot 只允许一次 `open -> terminal outcome` CAS；尚未 materialize 的 quorum/fail-fast remainder 写 `fenced/scope_id=null`，build failure 写 `errored/scope_id=null`。Completed slot 的 `output_ref/hash` 指向 Child exit output envelope。Map owner 只能从这些有序 slots seal `MapItemResultsManifest` 并发布 `MapResultManifest`，不得内嵌成员业务值。

### Node、Attempt 与 Wait

```text
workflow_graph_nodes
  - id
  - graph_run_id/scope_id/node_key
  - node_type/capability_ref/version/hash
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
  - version
  - ready_at/terminal_at/created_at/updated_at

UNIQUE(scope_id, node_key)

workflow_graph_node_attempts
  - id
  - graph_run_id/scope_id/node_id/attempt_no
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
  - retry_reason/error fields/usage_json
  - acceptance_state       open | fenced
  - run_work_fence_epoch/scope_work_fence_epoch
  - resource_reservation_group_id
  - lease owner/token/expires/heartbeat
  - evaluation lease/retry/deadline
  - version/timestamps

UNIQUE(node_id, attempt_no)
UNIQUE(delegation_id) WHERE delegation_id IS NOT NULL

workflow_graph_retry_schedules
  - id
  - graph_run_id/scope_id/node_id
  - failed_attempt_id/next_attempt_no
  - retry_reason_code/retry_policy_hash
  - backoff_ms/eligible_at_ms
  - attempt_reservation_id
  - status                 scheduled | consumed | cancelled
  - version/created_at/updated_at

UNIQUE(node_id, next_attempt_no)

workflow_graph_waits
  - id
  - graph_run_id/scope_id/node_id
  - wait_type/contract_ref/contract_hash
  - correlation_key/correlation_key_hash/registration_key
  - payload_ref/hash
  - status                 registering | armed | resolved | timed_out | cancelled
  - armed_at_ms/deadline_at_ms/resolved_at_ms
  - registration_lease owner/token/expires
  - run_work_fence_epoch/scope_work_fence_epoch
  - resource_reservation_group_id
  - version/timestamps

UNIQUE(graph_run_id, contract_ref, correlation_key_hash)
UNIQUE(node_id)
```

Node-level `trigger_cut` 和 input snapshot 是所有 node type 的恢复事实源。Delegation/system attempt 只引用并复制对应 hash，不能重新选择 edge；join/wait/subgraph/expand/map/terminal 即使没有普通 attempt，也必须基于 node snapshot 执行。

Dispatch timeout 与 execution timeout 分开持久化：前者从开始交给 provider 计时，后者只从 provider 接受或内部 worker 正式 `running` 时计时，不能让 pause/排队误耗执行时间。Watchdog 以 CAS fence `acceptance_state=open`，写 `attempt_execution_timeout` fact，再按 effect contract 创建 cancel/reconcile/compensation；late callback 不能发布 Node output，但经验证 receipt 仍可用于对账或补偿。

Retry 决策在失败事务中冻结绝对 `eligible_at_ms`、policy hash、reason、backoff，并为下一 Attempt 预留累计额度；重启后禁止重算 backoff，pause 不延长时间。到期后 schedule 以 CAS `scheduled -> consumed` 创建 exact next attempt。Lease expiry 只表示 Worker 失去提交权，不代表 execution timeout；有 external execution id 时必须先 reconcile。Effectful timeout 只有 pure、可证明幂等、已确认未执行，或已完成必要 compensation 时才能重试；外部状态未知进入 `action_required`。

Signal、timeout 和 cancel 只竞争同一个 `status=armed + saved work epochs + version` CAS，不要求外部 signal sender 持有 registration lease。首次成功者写 resolution event 并 terminalize node；相同 provider event 为 duplicate，不同事件竞争同一 Wait 时首个成功、其余 conflict，Wait 关闭后到达为 late。Arm 前 valid event 按 correlation pending，arm transaction 只消费最小 `inbox_seq`，其余按不可变 winner 归类。

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
  - resolved_at/version

workflow_graph_data_edge_resolutions
  - edge_id PRIMARY KEY
  - state                  unresolved | available | unavailable | error
  - value_ref/hash/schema_hash/source_attempt_id
  - resolution_seq
  - resolved_at/version

workflow_graph_terminal_candidates
  - id/scope_id/terminal_node_id
  - exit_name
  - output_snapshot_ref/hash
  - candidate_seq
  - created_at

UNIQUE(scope_id, terminal_node_id)

workflow_graph_completion_eligibilities
  - id/scope_id/rule_id
  - phase                  early | settled
  - eligibility_event_seq
  - selected_candidate_id
  - fact_snapshot_json/hash
  - created_at

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
  - created_at

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
  - created_at

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
  - disposition_event_seq/created_at

workflow_graph_subtree_fence_manifests
  - id/graph_run_id/source_close_request_id
  - scope_epochs_manifest_ref/hash
  - fenced_work_manifest_ref/hash
  - cleanup_effect_keys_manifest_ref/hash
  - subtree_fence_hash/created_at

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
  - target_kind/target_id          wait 尚未 arm 时 nullable
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
  - received_at

workflow_graph_effect_operations
  - id
  - graph_run_id/scope_id/node_id/attempt_id
  - operation_key
  - key_strategy_json/hash
  - execution_lane         normal | close_cleanup
  - close_request_id       close_cleanup 时 required
  - effect_type
  - status                 intended | dispatched | succeeded | failed |
                           compensation_pending | compensated | action_required
  - request_ref/hash
  - receipt_ref/hash
  - before_state_ref/hash
  - after_state_ref/hash
  - immutable_output_snapshot_ref/hash
  - compensation_ref/hash
  - lease owner/token/expires_at
  - version/timestamps

workflow_graph_effect_operation_claims
  - operation_id/claim_id/claim_spec_id
  - access                 read | write
  - fencing_token          write 时 required

UNIQUE(operation_id, claim_id)

workflow_graph_events
  - graph_run_id/seq
  - scope_id/node_id/attempt_id
  - event_type/idempotency_key
  - payload_json/ref/hash
  - occurred_at/created_at

UNIQUE(provider, provider_event_id)
INDEX(graph_run_id, contract_ref, correlation_key_hash, disposition, inbox_seq)
UNIQUE(operation_key)
UNIQUE(graph_run_id, seq)
UNIQUE(idempotency_key)
```

Event、effect journal、outbox 和 ledger 都使用稳定 idempotency key，并通过 run 的 `next_event_seq` 分配有序审计事件。

## 事务边界与 CAS

长操作不得在 SQLite transaction 中 await。关键事务如下：

```text
T0  task intake, routing and idempotent creation:
    strict-parse/freeze task envelope under a trusted creation domain;
    append immutable input revision; route against that exact revision/hash;
    append deterministic or capability routing attempt within pinned scope;
    resolver validates exact Recipe/Definition/entrypoint/policy/schema/permission;
    freeze creation_intent_hash and intent-bound launch confirmation;
    same creation key + same intent returns existing result; different intent conflicts;
    enforce workflow lifetime policy/runtime safety and freeze workflow deadline_at_ms;
    atomically acquire Recipe domain claims and invoke T1 core setup

T1  standalone activation ingress:
    require T0-created Workflow or trusted internal transition;
    CAS workflow revision/state and lifetime counters; create activation + initializing run;
    freeze definition/registry/source seed and create run ledger accounts;
    create materializing root scope shell(plan=null) + root scope build;
    bind run.root_scope_id/root_build_id and workflow.current_graph_run_id;
    allocate one initial checkpoint_version and write current-run watermark

T2a compile result persistence:
    outside tx resolve frozen locator and run pinned pure compiler;
    CAS build lease + source/input/compiler hashes + saved work epochs + version;
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
    CAS attempt phase + worker lease_token + saved work epochs + version;
    validate artifact/evaluation, retry or terminalize and publish once

T6b delegation callback:
    CAS delegation_id/external_execution_id + acceptance=open + saved work epochs
    + version; never require the external callback to possess a worker lease

T6c wait resolution:
    signal/timeout/cancel compete on status=armed + saved work epochs + version;
    registration lease only protects registration work, not external delivery

T6d durable deadline and retry timers:
    attempt watchdog fences acceptance=open at dispatch/execution deadline;
    write timeout fact and required cancel/reconcile/compensation effects atomically;
    retry timer CAS scheduled->consumed at frozen eligible_at_ms and creates exact next attempt;
    workflow watchdog submits stable T7c command
    workflow-deadline:<workflow_id>:<deadline_at_ms>

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
    after logical fences and required compensation settle, insert child cut;
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
    require root/run closing, matching request and subtree compensation settled;
    insert unique root cut; close root/run; CAS workflow revision;
    commit trusted context patch + transition history + checkpoint + outbox;
    if target is non-terminal, reuse T1 activation/run/root core setup in this tx:
    freeze target definition/registry/source seed, create ledger accounts,
    activation + initializing run + root shell/build and all root bindings;
    include old completed/new current watermarks in T8's single checkpoint row;
    terminal target clears current run and commits final workflow status
    trusted start_child_workflow effects resolve pinned Recipe/input/creation key,
    enforce parent child-recipe allowlist and lifetime budget, create relation + child T0/T1
    exactly once in the same DB transaction when local; otherwise write deterministic outbox
```

“T1 core setup”只指 activation、run、ledger accounts、root shell/build、frozen snapshots 与 workflow binding。Standalone T1 在 core setup 后写自己的 initial checkpoint；T8 复用 core setup 时不得执行该 checkpoint 子步骤，而是把新 current watermark 合并进消费旧 cut 的同一个 transition checkpoint/version。外部入口不得绕过 T0 直接拼接 definition/state；Feature 明确按钮也使用单候选 routing scope 生成 deterministic decision。

T8 的 route source 由 root outcome kind 唯一决定：`completed` 使用 selected named exit 对应的 `exit_routes`；`errored` 使用 `on_error`；`cancelled/local_graph` 使用 `on_local_cancel`；`cancelled/workflow` 不读取 definition transition，固定终止 Workflow、清空 current run并写 final checkpoint/history。四种路径不能互相 fallback。Normal completed path 按 published Transition 的 typed Context Patch 更新 slots；error/local-cancel 默认 canonical no-op patch，除非其受信任 transition 明确定义 typed patch。Terminal target 还必须解析并验证唯一 final output binding 后才提交 Workflow terminal。

`T2a` 只持久化 immutable compile result，不消费 scope/node quota；`T2b` 才 materialize。Root build failure 在 shell 上走 `T7a(engine_error)`，随后由 T8 生成 root cut；paused 时先保存 failed build，resume transaction 再创建 request。Subgraph/expand build failure terminalize single owner；map item build failure 必须先填写对应 `errored/scope_id=null` slot，再运行 map policy。

`T3a` 的 “fact” 包括 candidate 与 node-terminal fact。同一事务内每个 ingress/derived durable fact 按确定性 fixed-point queue 分配不同的连续 event seq；queue key 固定为 `(causal_wave, fact_kind_rank, stable_object_id)`，`fact_kind_rank` 是 runtime format 常量。每写一个 fact 就基于该 post-state 计算 eligibility。Fact、由它首次产生的全部 early eligibility、以及 running 时的 close arbitration 是不可拆分原子单元；不存在异步补 eligibility 的正确实现。`T3b` 只在全部 node/edge/controller reservation 已按 quiescent 定义封闭时运行，并把 settled frontier 与 close request 绑定到同一个 event seq。

同一 T3a post-state 同时产生 engine error 与 normal eligibility 时，两者都保留审计事实，但 `engine_error` 先调用 T7a；只有不存在 error fact 时才按 eligibility 排序创建 normal request。这样 schema/routing/invariant error 不会被同事务内恰好出现的业务 candidate 掩盖。

`T7a` 对 target 插入 winning request；对每个尚无 request 的 open descendant 插入 canonical `parent_close` request，已有 close request 只保留并参与同一 subtree work fence，绝不覆盖其 candidate/reason。事务同时把 pending/ready/active controller work 收敛为 fenced terminal fact、关闭 open map slots、释放可释放 held reservation，并保存每个 Scope old/new epoch、被 fenced 对象与 cleanup effect key 的可验证 manifest。此后 finalizer 可以为每个 descendant 生成 cut，target cut 必须等待 descendant cut 与 required compensation 收敛，不能仅凭 epoch 已递增就关闭 parent。Epoch 已更新但 manifest/cleanup 集不完整属于 quarantine，Recovery 不得猜测补齐原子事实。

普通 execution lane 只在 `running + active` 下凭 saved work epochs 执行；`close_cleanup` lane 在 `closing/cancelling` 下凭 winning `close_request_id` 执行 Cancel、Reconcile、Compensation 与 Finalizer。Ancestor 再次 fence 不会使已有 cleanup 失效。Cleanup 仍受 Claim、operation key、attempt ceiling 和 Outbox policy 约束，不能借 lane 绕过资源控制。

核心 CAS/fence 至少包含：

```text
workflow: id + status + state_instance_id + current_graph_run_id + revision
run:      id + lifecycle + control + operational_state + work_fence_epoch + manifest_seq + version
scope:    id + lifecycle + work_fence_epoch + close_request_id + version
node:     id + phase + current_attempt_no + version
build submit:
          id + status + lease_token + source_hash + input_hash +
          compiler_snapshot_hash + saved run/owner-scope epochs + version
materialize root:
          build=compiled + run.control=running + root shell=materializing + epochs
materialize child:
          build=compiled + run.control=running + owner scope/node active + epochs
worker submit:
          attempt id + phase + lease_token + saved run/scope epochs + version
delegation callback:
          delegation_id + external_execution_id + acceptance=open +
          saved run/scope epochs + version
wait delivery:
          wait id + status=armed + saved run/scope epochs + version
child consumption:
          child cut + owner/controller state + map slot state/version +
          saved run/owner-scope epochs + owner version
edge:     id + state=unresolved + version
ledger:   account ids + versions + reservation idempotency key
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

Task Intake/Revision、Routing/Creation、Registry Snapshot、Workflow/Run/Scope/Node/Attempt/Wait、Edge/Candidate/Close/Cut、Context/Checkpoint、Ledger、Domain Claim、Inbox/Outbox、Effect、Scheduler、Relation、Runtime Event 与 Value metadata 全部位于同一个 `workflow-runtime.db`，以保留 T0/T8 和全局 Claim/Ledger 的单事务约束。不得采用每 Workflow 一个数据库。

现有 `messages.db` 只保存 Chat、Wiki、Memory、Schedule、Feature UI 数据、Workbench Projection/Comment 等非权威数据。两个数据库之间禁止原子双写或 attach-based 业务事务；Runtime 事务先写幂等 projection outbox，Projection Worker 再更新 `messages.db`。失败只使 UI 短暂 `syncing`，不回滚 Workflow，Projection 可由 Runtime Event 重建。

只有 `WorkflowRuntimeStore` 可以获得 Runtime DB 写连接；API、Scheduler、Watchdog、Outbox Worker、Recovery、Workbench 与外部 Worker 都通过 Command/Callback API 提交。耗时 Agent/tool/file/network work 一律在 transaction 外执行，SQLite 只串行提交短 CAS/fixed-point/fence transaction。所有生产、测试、只读/写连接都必须由统一 Connection Factory 创建并逐连接设置、验证：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

关键 CAS transaction 使用 `BEGIN IMMEDIATE`，避免读取状态后才在写阶段失败；所有 composite FK/unique constraint 必须由 SQLite 实际执行。需要 WAL、durability、Writer 竞争或 crash 行为的测试必须使用真实文件 SQLite，不能用 `:memory:`。Runtime DB 与 Blob 目录作为一组恢复资产，备份使用 SQLite Backup API/一致性快照；恢复后执行 blob length/hash 与 orphan scan。

T3/T7 继续保持不可拆分原子协议。T3 只增量处理本次影响的 Node/Edge/Fact，索引 source node/source port/target port/guard，使用确定性 fixed-point queue，目标复杂度接近 `O(affected nodes + edges + facts)`；禁止每个 Fact 重扫全 Scope或每 Edge 一次全表查询。T7 使用 indexed `parent_scope_id + Recursive CTE`、临时 subtree-id 表与 set-based UPDATE/INSERT，禁止 JavaScript 递归逐 Scope 查询、超长动态 `IN (...)`、逐 descendant transaction 或事务内等待 cancel ACK。Closure Table 只有真实 benchmark 证明必要时才引入。

发布门禁按 versioned `RuntimeSupportedLimits` 测试，而不是固定 100 nodes/items。T3 至少覆盖长链、宽 fan-out/fan-in、diamond、route-group、completion-heavy、condition-heavy；T7 至少覆盖 deep/wide tree、large/nested map、mixed lifecycle 与 effect-heavy subtree。使用真实文件 SQLite、上述生产 PRAGMA/索引，记录 transaction duration、读写行、derived facts、subtree scopes、WAL 增量与内存峰值。

Benchmark 分为 Smoke、Supported Limit、Beyond Limit 与 25/50/100% Scaling；同时设置复杂度曲线、正确性不变量和参考机器上的绝对短事务预算。若合法最坏事务超出预算，第一版降低 Safety/Supported Limit，不能静默拆分 T3 fixed point 或 T7 subtree fence。未来需要超大 Graph 时必须另行设计不可见 generation barrier，而不是作为普通性能补丁。

## Retry、Pause、Cancel 与 Compensation

- `max_attempts` 包含首次 attempt；每次 retry 创建新 immutable attempt。
- Workflow 在 T0 冻结 `deadline_at_ms = started_at_ms + effective_max_duration_ms`。Durable watchdog 到期后用稳定 command key 调用 T7c 全局策略取消；若 normal close request 先提交则 deadline 是 late command，反之 deadline 先赢则后续 normal completion 只审计。Workflow deadline 不走业务 `on_error/on_local_cancel`。
- Retry reason 使用 catalog 定义的结构化 taxonomy。`retry_request` 省略时使用 capability trusted policy；显式 request 的 `max_attempts` 与所有 non-null global/state/capability business ceiling及 `execution.max_attempts_per_node/run.max_attempts_total` safety ceiling 取最小值，null business ceiling 不注入默认次数；`retry_on` 省略时继承 capability allowlist，显式空数组禁用 retry并归一为一次。Backoff 只来自 trusted capability，并受 `execution.max_retry_backoff_ms` 限制。
- Evaluator pending 在同一 attempt 上使用独立 lease/retry/deadline，不重复 agent/action；capability 中 non-null business次数/deadline 进一步收紧 `execution.max_evaluator_attempts_per_evaluation/max_evaluator_duration_ms` 与 run total safety ceiling，不注入隐藏默认业务 ceiling。
- Node terminal 后不重开；重新运行 root graph 通过外层 transition 创建新 activation/run。
- Pause CAS workflow/run 并传播 scheduling barrier；paused 时允许 result、signal/timer/timeout、terminal fact、edge resolution、trigger/input seal、`ready/skipped` 和 early eligibility，禁止 claim、scope materialize、尚未 dispatch 的 execution 与普通 completion close request。显式 local/global cancel 仍可通过 T7c 抢占 paused run。Ready node 可以形成但不能启动；already-running external work 不因 pause 自动取消。
- Resume command CAS `paused -> resuming`。Resuming barrier 内先按 `(error_event_seq, scope_depth, stable_fact_id)` 处理 setup/orchestration error，再对全 run early eligibility 按 `(eligibility_event_seq ASC, priority DESC, rule_id ASC, scope_id ASC)` 竞争，最后执行 settled arbitration，循环到 fixed point 后才 CAS `resuming -> running`。每个 winning request 仍在其 T7a 事务完成 subtree fence；整个 drain 可以拆成多个短事务，crash 后从 `resuming` 恢复，期间不得 claim/materialize/dispatch。较早 child eligibility 不会被较晚 ancestor request 改写。
- Manual node skip/cancel 只允许 graph paused 且携带 expected versions；随后仍按正常 terminal/edge resolution 协议收敛。Active cancel 必须遵守 capability cancellation contract；manual retry 只能提前尚未 terminal 的 retry-wait，不能重新打开 terminal node。
- Runtime 不提供任意 `returnWorkflowToStage` 或“重开 terminal State/Node”命令。业务返工、回炉和回退必须由 published Definition 的 named exit/transition 明确授权，并创建新的 State Activation/Graph Run；旧 activation、cut 和 artifact 保持不可变。Console 只能触发 Definition 声明的 remediation/rework command，不能指定任意 target state。
- Local graph cancel 与 global workflow cancel 使用 T7c 原子入口；parent early close 使用 T7a 的 subtree fence。Normal/error/local/global cancel 竞争同一个 close-request unique CAS，输家只写已晚到的 command audit，不能改写已冻结路由。
- Active compensatable effect 在 cancellation policy 要求时创建 compensation outbox；scope 只有所有 required compensation terminal 后才能完成 closing。
- Workflow terminal transaction 在全部 required effect/compensation 收敛后把 held domain claims 标记 `release_pending` 并写 deterministic release effect；本地 claim 可同事务 released。`action_required/quarantined` 默认继续持有 claim，人工 abandon 是否释放必须由 Recipe risk policy 显式允许并保留 fencing audit。
- 晚到 completion、signal 或 outbox delivery 只记录 audit，不得越过 completion fence。

## Outbox、Lease 与恢复

Outbox 是 at-least-once。每条 effect 具有 deterministic message id、lease owner/token/expiry，以及显式配置的 nullable business attempt/deadline ceiling 和 dead-letter policy；null 不注入默认业务 ceiling，但 `execution.max_outbox_attempts_per_message/max_outbox_delivery_duration_ms` safety ceiling 始终适用。Dead-letter 与相应 attempt/wait/effect state 推进必须同事务完成。

```text
workflow_outbox
  - effect_key UNIQUE
  - aggregate_type/id/version
  - effect_type
  - payload_ref/hash
  - status                 pending | processing | succeeded | dead_letter
  - attempt_count/max_attempts       max_attempts nullable
  - next_attempt_at/deadline_at      deadline_at nullable
  - lease owner/token/expires_at
  - last_error
  - created_at/delivered_at
```

Delegation/action/wait/cancel/compensation adapter 必须接受稳定 effect key。Delegation id 从 graph attempt 确定性派生；相同 attempt 重投使用相同 delegation/effect id，adapter 应按 idempotency key 返回已有 execution 或允许按 external id 对账。Crash 发生在外部成功、outbox 标记成功之前时允许同 key重放；物理执行可能重复，Runtime 只承诺外部投递 at-least-once，以及通过 provider event id inbox 去重、attempt acceptance CAS 和 unique key 使数据库 node/output/edge/cut/transition effect exactly-once。无法幂等、无法补偿且存在不可逆 effect 的 capability 不得注册。Dispatch dead-letter 必须与 attempt failure/retry、ledger release 同事务；cancel/notification dead-letter 不能重开已 closed graph，只能创建 action item。

恢复顺序：

在 Graph 恢复前先恢复 creation plane：校验 Task Intake/routing attempt/creation request hash、Recipe/Definition/execution-policy exact refs、`creation_key -> workflow_id` 唯一性和 domain claim fencing token；`needs_clarification/awaiting_confirmation` intake 保持 durable pending，`created` intake 不重复创建。Pinned executor implementation 不可用时进入 `action_required`，不能 fallback 到新版本。

1. 校验 workflow activation/current run、definition/registry snapshot、root build/nullable root plan、Run Manifest hash chain、ledger chain 和 completion-cut uniqueness。
2. 优先处理已有 close request 的 scope/run：验证 request transaction 已持久化完整 subtree work-fence manifest 与 close-cleanup effects，只重放已存在 key 的 outbox delivery；若原子 manifest/effect 缺失则 quarantine，恢复器不能事后“重建”原始事务。
3. Run control 为 `resuming` 时先继续 deterministic resume drain；在 pending error/eligibility/settled fact fixed point 前不得 claim/materialize/dispatch。随后回收 Scope Build snapshot/compiler lease，只读取 frozen seed/locator，相同 source/input/compiler hashes 重跑 pinned pure compiler。Paused/resuming run 可以停在 `compiled`，不能 materialize。
4. 验证 scope ownership tree、unique child key、plan/input hash、sealed Expansion Manifest、map result slots 和 ledger account cache 守恒。
5. 回收 preparing attempt；基于 node-level trigger cut/input snapshot 在同一 attempt 下重建 context pack。
6. `dispatch_pending` 仅在 run.control=running 时重投同一个 outbox effect；paused/resuming 时保持 pending。Running delegation 先按 external id 对账，不因普通 worker lease 过期重复 dispatch。
7. Pure/idempotent system action 可按同一 attempt key 重放；compensatable action 先对账 effect receipt，再决定继续或补偿。
   Mutable mutation 还必须比较 domain claim fencing token、external before/after revision 与 immutable snapshot；外部状态不确定时进入 action-required，不得盲目产生新 operation key。
8. 回收 evaluator lease，在同一 attempt 基于 frozen result 继续 evaluation。
9. 回收 wait registration；signal、timeout、cancel 继续竞争同一 armed CAS，重复 payload 按 inbox idempotency key 归类。
10. 对 `subgraph/expand/map` 从 sealed Expansion Manifest 按 unique invocation key 补齐 build/materialization，或以 T7b 消费已完成 child outcome；不能重读 planner live output。
11. 从 persisted edge resolution 验证 trigger/input fixed point；已有 trigger cut/input snapshot 的 node 不重新选 edge。任何 terminal/candidate fact 缺少应原子生成的 eligibility 都是 invariant violation，禁止事后补齐。
12. Close request 已存在时不得重选 rule/candidate。Paused/resuming run 可以合法存在 eligibility 而无 request；running run 出现该状态说明 resume/fact transaction 被破坏，必须 quarantine，不能恢复仲裁。
13. Completion cut 已存在时只验证 child consumption disposition，或 root workflow transition/history/checkpoint 的同事务事实；不重建新的 cut。
14. 回收 outbox lease；child/root finalizer 是纯数据库事务，不持有独立租约。Closed run 只补外部 projection，不重做 workflow transition。

普通可解释且状态仍可信的编排失败使用 `engine_error` 并走 `on_error`。外部资源/credential 暂时不可用、compensation dead-letter 或需要核验 receipt 等状态可信但需要人工介入的情况进入 `action_required`，只允许使用相同 effect key 重试、补充资源或提交可验证 receipt。Plan/artifact hash mismatch、不同 edge decision hash、ledger chain mismatch、cross-run lineage、成功 node 必要 immutable artifact 缺失，或 root cut 与 workflow transition/history 不匹配属于事实完整性不可信，进入 run-level `quarantine`：停止 claim/materialize/close/transition，late callback 只审计，禁止手改 edge/candidate/ledger 或伪造 cut。Quarantine 只能通过恢复可信数据解除；无法恢复时允许写独立审计的 `administrative_abandon` 并归档 Workflow，但它不是 normal/error/cancel outcome。

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
  - created_at

UNIQUE(workflow_id, checkpoint_version)
UNIQUE(completion_cut_id)
```

`checkpoint_version` 在 workflow CAS 内分配，不能用进程内计数或事后插入。Checkpoint 只保存引用和完整恢复水位：

```json
{
  "schemaVersion": 6,
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
      "controlEpoch": 0,
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
      "controlEpoch": 1,
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
  "updatedAt": "2026-07-10T12:00:00.000Z"
}
```

Graph-to-Graph transition 时 `completed` 保存旧 run 的完整水位，`current` 指向同一 T8 创建的新 activation/root run。首次 activation 时 `completed=null`；terminal transition 时 `current=null`。Initializing current 的 `rootScopeId/rootBuildId/sourceSeedHash` 已存在，`rootPlanHash` 合法为 null。Checkpoint 不复制 scope/node/edge/attempt；Graph Store 才是执行事实源。

## Context、Artifact 与 Quality Gate

- Workflow Input 是 immutable value ref；Definition 固定 versioned Context Contract 与 typed slots。Scope input、node input、Context Slot 和 output 都必须匹配 versioned Workflow Schema Profile；`max_bytes` 字段必须存在，non-null 时作为业务 byte limit，null 时不注入默认业务上限，分组 runtime value/run safety ceiling 始终执行。
- Delegation context pack 基于 frozen input 和显式 provenance 构建；不能隐式读取 sibling 或 live workflow context。
- Artifact、evaluation、effect receipt 和 result 按 run/scope/node/attempt 隔离，不覆盖 state 级 `latest.json`。
- Capability 必须恰好声明 artifact/evaluator binding 或受信任的 `no_*_expected`。
- Quality gate 决定 attempt pass/needs_revision/fail；只有最终 pass attempt 能发布 logical node output。
- 普通 node 不能修改共享 workflow context。Child completion 只发布 owner output refs；root coordinator 仅在 T8 按受信任 Transition 的 typed Context Patch 创建新的 immutable Context Snapshot。Slot 复用原 Value Ref，不复制业务字节；summary 只属于 projection。Error/cancel transition 使用 canonical no-op patch，除非 published transition 明确定义兼容的 typed patch。Terminal state 的 final output binding 与 Context Patch 分开校验。

## 权限与安全

- Source spec 只能选择 policy allowlist 中的 capability/template/interface/policy。
- Compiler 解析的 capability binding 固化到 plan；dispatch 只检查资源仍可用，不重新解析或 fallback。
- 权限收紧、resource uninstall 或 schema hash 不匹配产生结构化 non-retryable engine error。
- File/artifact path 必须通过 storage resolver；graph spec 不能提供 host path 或 mount。
- Condition evaluator 使用 typed AST；trusted business step/depth/input-byte limit 为 non-null 时进一步收紧，runtime safety step/value ceiling 始终执行且进入 snapshot，不存在隐藏默认值。
- Scope spec、map collection、scope count、nesting、node、attempt、wait 和 output 由 Graph Ledger 按 non-null policy limit 控制；token/tool/cost 默认由现有执行层限制，只有显式 Run usage budget 且 gateway 可可靠归集时才进入 optional Ledger account。
- Event payload 只保存受限 summary、ref、hash 和 policy decision，不复制 secret 或无限结果。
- External signal 必须验证 workflow/scope/node correlation、contract、authorization、expiry 和 idempotency key。

## Workbench 与 Trace

Workbench 以 state activation 为一个顶层阶段，内部展示：

- Task Intake、routing scope/attempt、selected Recipe/Definition/entrypoint、confidence/reason code、launch confirmation 与 creation key replay。
- Workflow lifetime counters/deadline、runtime safety snapshot、supported-limit/capacity hash、domain resource claims/fencing token 和 parent/child Workflow lineage。
- Root run lifecycle/control、named exit、budget 和 registry snapshot。
- 可折叠 scope ownership tree，以及每个 scope 的 immutable plan hash。
- Scope 内 control/data edge、实时 resolution、trigger 和 sealed input。
- Node phase/outcome、attempt history、wait deadline、child exit、artifact/evaluation/effect journal。
- Effect operation key strategy、mutable resource before/after receipt、immutable after-snapshot 和 pinned executor implementation version。
- Terminal candidates、selected completion rule、completion cut 和被 early-close fencing 的节点。
- Map item progress、稳定 item key/index、selected quorum set、sealed result manifest 和按需 dereference 的 item output。

操作请求必须携带 `run/scope/node/attempt/wait expected version + idempotency_key`。Pause 后才允许 manual skip/cancel/retry-wait advance；所有操作通过 runtime command API，不直接更新投影表。

Trace 分两层：

- `workflow_graph_events` 记录 materialize、route/data resolution、input seal、claim、retry、wait、child scope、candidate、cut、cancel、compensation 和 recovery。
- Agent/tool/effect trace 通过 `state_instance_id/run_id/scope_id/node_id/attempt_id` 关联具体执行。

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

| Module                                 | 职责                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| `workflow-recipe-registry.ts`          | Recipe/routing scope/execution policy 发布、依赖、版本与 owner 校验   |
| `workflow-task-intake.ts`              | Task envelope snapshot、clarification/confirmation 与 routing attempt |
| `workflow-routing-resolver.ts`         | 受限 Macro Router 调用、deterministic resolution 与幂等创建           |
| `workflow-domain-claims.ts`            | 外部领域资源 shared/exclusive claim、fencing token 与释放              |
| `workflow-graph-types.ts`              | Source/compiled IR、ports、condition、state 和 error types            |
| `workflow-registry-store.ts`           | Core/Feature versioned resource 发布、dependency、hash 与 retention   |
| `workflow-schema-registry.ts`          | JSON Schema 2020-12、strict parse、RFC 6901 resolver 与 snapshot      |
| `workflow-graph-interface-registry.ts` | Versioned scope interface 加载、hash 和兼容校验                       |
| `workflow-graph-policy-registry.ts`    | Versioned child policy profile、逐层 intersection 与 snapshot         |
| `workflow-wait-contract-registry.ts`   | Signal/timer/approval contract、authorization 与 schema snapshot      |
| `workflow-capability-catalog.ts`       | Capability/effect contract 加载、权限解析和 snapshot                  |
| `workflow-graph-compiler.ts`           | Pure normalize、binding、DAG、condition、completion 和 policy 校验    |
| `workflow-runtime-store.ts`            | 独立 Runtime DB Connection Factory、唯一写入口、PRAGMA 与事务调度     |
| `workflow-graph-store.ts`              | Run Manifest、Expansion Manifest、scope/node/edge/wait/cut CAS store  |
| `workflow-value-store.ts`              | Inline value、content-addressed blob、immutable artifact 与 GC        |
| `workflow-graph-ledger.ts`             | 原子 reservation、consumption、release 和 invariant check             |
| `workflow-graph-reconciler.ts`         | Edge resolution、trigger、input seal、readiness 和 completion         |
| `workflow-node-execution.ts`           | Delegation/system preparation、artifact、evaluation、effect key/receipt journal |
| `workflow-graph-child-runtime.ts`      | Subgraph/expand/map materialization 与 owner completion               |
| `workflow-graph-waits.ts`              | Signal/timer/approval registration、delivery 和 timeout               |
| `workflow-graph-runtime.ts`            | Run lifecycle、pause/cancel、claim、closing 和 recovery coordination  |
| `workflow-definition-lowering.ts`      | 单节点 authoring state 与 graph state 到统一 root Scope Plan          |
| `workflow-graph-projection.ts`         | Workbench/read model 与 graph event projection                        |

现有 workflow orchestration 只负责 activation 边界和 root completion 后的外层 transition。Graph Runtime 不依赖 Workbench UI；UI 通过 store/query 和 command API 交互。

## 测试策略与模型验证

固定 Fixture、Property-based Test 与 Model-based Test 三类必须并存：Fixture 固定 Hash、Error Code、关键案例和历史回归；Property Test 对生成输入检查不变量；Model Test 把真实 SQLite Runtime 的事件序列结果与独立 reference state machine 比较。Reference Model 只表达 Run/Scope/Node/Edge/Wait/Close/Cut/Ledger 语义，不调用生产 Reconciler，也不复制 Lease/Outbox 实现细节，避免同一 Bug 同时污染实现和 oracle。

第一版使用 Vitest + `fast-check` 生成小型但高组合度的合法 DAG 与事件序列：

```text
nodes 1..6; edges 0..10; scope depth 0..2; map items 0..4;
attempts per node 1..3; wait events 0..4;
all/any/quorum trigger; optional/required input; early/settled completion;
subgraph/map; signal/timer/cancel; pure/idempotent/compensatable effect
```

另建 invalid generator，确保 cycle、Schema/Profile 不兼容、越权 Capability/Claim、非法 completion 等总被 Compiler 拒绝。生成器必须保存 seed 并支持 shrinking；发现的最小 counterexample 修复后转成永久 Fixture。

核心 properties 至少包括：

| Area | 必须始终成立 |
| --- | --- |
| Compiler | canonicalization 幂等；set-like 顺序不改 plan hash；accepted graph 无依赖环；无法证明 assignability 必须拒绝 |
| Runtime | Node terminal 不重开；Edge/Cut/Close 只提交一次；Trigger/Input snapshot 不变；Close 后普通结果不 publish |
| Ledger | non-negative/under-limit；multi-account reservation 全成或全不变；重复 idempotency key 不重复计费 |
| Wait | Signal/timeout/cancel 最多一个 winner；provider event 不重复消费；correlation 只绑定一个 Wait；expired pending 不再匹配 |
| Creation | same key+intent 同实例；same key+different intent conflict；confirmation 不能跨 revision |
| Child/Close | Parent fence 后 Child Cut 只能 non-publish；Ancestor 不覆盖已有 Child request；Map slot 只有一个 terminal outcome |

所有时间测试使用 Virtual Clock，禁止真实 `sleep()`；Fake Adapter 可确定性返回 `not_applied/applied_with_receipt/applied_but_receipt_lost/still_running/unknown/cancelled/compensated`。Fault Injection 覆盖 intent、dispatch、external apply、receipt、Node output、Close Request、Completion Cut、Workflow transition 各边界的提交前后；SQLite 事务内 crash 必须全回滚，外部 effect 边界按 operation key/receipt/reconciliation 收敛。

CI 分层：普通提交运行固定 seed、小型 exhaustive 和数百组 property；完整回归扩大 seed、事件长度和 crash point；发布门禁另运行真实 SQLite 的 Supported Limit T3/T7 benchmark。所有随机失败都必须能由 seed + shrunk event list 完整重放。

## 开发期实施顺序

项目仍处于无实际用户/历史运行数据的开发阶段，因此不建设上线灰度、双写、旧 checkpoint 恢复或历史 execution migration。开发按以下依赖顺序推进，但最终只保留一套 Runtime：

1. Recipe/routing/execution-policy registry、Task Intake/T0、Feature resource manifest 扩展、RuntimeSafetyCeilings 与 exact executable retention。
2. Graph Source/Compiled IR、strict JSON Schema、RFC 8785/hash 与 versioned registries。
3. Pure Graph Compiler：binding、DAG、condition/trigger/input、completion、policy/safety 与 static child closure。
4. 独立 `workflow-runtime.db`、WorkflowRuntimeStore/Connection Factory、Value/Blob Store、CAS、Manifest、Ledger、domain claims 与 T1-T8 transaction primitives。
5. Delegation/system/wait/join/terminal 基础 Runtime、effect key/mutable receipt 与 external adapter/inbox/outbox。
6. Subgraph/expand/map、quorum/fail-fast、hierarchical fence、child Workflow effect 与 compensation barrier。
7. Pause/resuming/cancel、root coordinator、checkpoint、domain claim release 与 recovery。
8. Reference Model、Property/Model/Fault tests 与真实 SQLite Supported Limit T3/T7 benchmark。
9. Workbench projection/command API，并删除旧 scheduler/completion/retry/interrupt/transition 旁路。
10. 框架稳定后另行迁移现有 `dev_test`、`fix_test` definition 和领域 capability；它们不阻塞 core framework 的实现，但在成为可执行 definition 前必须满足新 contract。

当前不做多机/分布式吞吐目标，但真实文件 SQLite 的 T3/T7 Supported Limit、WAL、复杂度和绝对事务时长是发布门禁；允许配置不得超过已认证 profile。若未来部署边界从本地单机变化，再单独评估 PostgreSQL 或分布式 scheduler。

## 开发期直接重构约束

本文全部对象、表、事务和 node type 属于同一个交付边界，不存在可省略的降级 runtime：

- 直接落地本文 target schema、IR 与状态机；不保留旧 graph 表、双写链路、旧 completion handler 或并行的新旧 scheduler。
- 所有非 terminal authoring state 一次性 lower 到统一 Graph Runtime。Delegation/system/interrupt/graph 的 completion、retry、wait 与 transition 不再保留旁路；不存在 parallel state/node/builder，多个 ready node 即原生并行。
- Source IR、Compiled IR、policy/wait/capability registry、Graph Store、Run/Expansion Manifest、ledger、reconciler、executor、durable wait、child runtime、root coordinator 和 recovery 必须作为同一套 contract 实现。
- Task Intake、Recipe/routing/execution-policy registry、T0 deterministic resolver、creation idempotency、runtime safety、domain claims 与 Feature draining/executor retention 同样属于交付边界；不能让 Feature API 继续绕过它们直接按任意 workflow type 创建。
- 数据库 schema、composite FK、unique/CAS、outbox 和 checkpoint 以本文最终模型建立开发期 baseline；不存在需要兼容的历史执行记录。
- Compiler fixtures 覆盖 static lowering、condition、wait、nested subgraph、expand、map 和 policy intersection；crash fixtures 覆盖 T1-T8 每个 commit 前后。
- Workbench 表、计数、状态标签和旧 state 字段只能是 Graph Store/event 的 projection，不能成为调度、恢复或 transition 的事实源。
- 完整验收门禁通过前，不以 feature flag 绕过 effect cancellation、ledger、hierarchical fence、settled arbitration 或 recovery invariant。

## 完整验收标准

- Feature UI 单候选、Feature 内多 Recipe 和全局 Domain->Recipe 两跳 routing fixture 均只能选择 pinned scope 内 exact Recipe；低置信度按 versioned selection policy 进入 clarification/confirmation，Router confidence 不构成授权。
- Intake clarification 只追加合同允许的 input revision；Routing/Confirmation 都绑定 exact revision/hash。相同 `(creation_domain, creation_key, creation_intent_hash)` 的并发请求只创建一个 Workflow/activation/claims，同 key 不同 intent 返回 conflict。
- Recipe 固定 Definition/entrypoint/execution policy/Context Contract/input-output schema/child allowlist；Publisher 从 Capability/Tool/MCP/file/transition/child Recipe 闭包派生 impact/recovery/permission，超过 effect ceiling 时拒绝。Micro Planner 只能生成指定 graph state 的 Scope Spec。
- 所有非 terminal state authoring type lower 到同一 Graph Runtime，不存在 sequential/graph 双轨 completion。
- Definition/Source 只有 `graph` 一种 DAG 配置格式；多个 ready node 在 executor capacity 内并发 claim，不存在 parallel state、node、builder、table 或 scheduler。
- Capability、interface、template、policy、wait contract 和 schema 使用 immutable exact VersionedRef；definition dependency 与 run allowlist snapshot 固定 hash，active run/published definition 引用期间不能删除 resource/executor。
- Recipe、routing scope、Workflow execution policy 和 executable implementation 同样使用 immutable exact VersionedRef；Feature `enabled -> draining -> disabled -> deleting` 不会使 active run 丢失 executor，prompt/skill/script 更新只通过新版本发布。
- Strict JSON 拒绝 duplicate key/unknown field/非标准值；受限 `icarus.workflow-schema/1`、RFC 6901、RFC 8785 与 domain-separated SHA-256 fixture 产生稳定 source/plan hash。不同 Schema 连接必须保存 sound subtype proof，non-total pointer/无法证明/隐藏转换均拒绝。
- 每个 activation 唯一 root run；child scope 只以 append-only Run Manifest 增加，已存在 plan 永不修改。
- Compiler 对 control/data/guard dependency 并集做无环检查，并拒绝跨 scope edge。
- Condition 只读取允许的 frozen fact，route group 解析原子、确定且可重放。
- Trigger 三值逻辑能正确区分 ready、`route_not_selected` 和 unresolved，不会提前 skip。
- Data port aggregation/seal 能确定性选择 value；completion-order 模式完整记录选择事实。
- Delegation/system retry 保留 attempt 历史和独立 Retry Schedule；dispatch/execution deadline、eligible time 与 Workflow deadline 均可在 crash 后由 watchdog 恢复。Lease expiry 不等于 timeout，effectful retry 必须先 reconcile/compensate。
- Wait contract 必须来自 pinned allowlist；correlation 在 Run 内唯一且不复用，provider event/registration key 分离。Pre-arm signal 受有限 TTL、分层容量和 ingress/binding 两阶段授权；signal/timeout/cancel 由 `inbox_seq`、received time 与 CAS 唯一决定。
- Explicit join 不隐藏业务计算，all/any/quorum fan-in 均可通过 typed port 表达。
- Subgraph 精确实现固定 interface；Child Completion 只保存 output envelope ref/hash，需要的 Child Port 可直接 expose 为 Owner Port且不复制/重复计费。
- Expand 使用 frozen candidate、pinned registry/policy 编译 child scope，无法修改 parent plan 或扩大权限。
- Map 冻结 collection并预建全部 result slot；最终发布 sealed ordered Result Manifest，不内嵌成员 payload。完整数组只能由显式 Materializer/Reducer 生成；quorum cut 后 late child 不能改写 selected set。
- Terminal candidate 与 completion rule 支持 settled arbitration 和安全 early close；completion cut 只写一次。
- Root normal exit、engine error、local cancel 和 global cancel 使用不同可信路由。
- Early close/cancel 对 active effectful node 执行 fencing，并按 effect contract 完成幂等取消或 compensation。
- Parent/root close 在同一事务为整个 subtree 建立 request/work fence manifest；stale ordinary work 无法穿越 saved work epoch，cleanup 按 winning close request 和独立 lane 收敛。Ancestor 不覆盖已有 Child request，Child Cut 与 Parent consumption disposition 分开且只写一次。
- Child policy profile 对 allowlist/recovery-kind 取交集、boolean AND、impact 与 numeric ceiling 逐层收紧；null child request 只表示继承。Compiled plan 保存完整 effective snapshot。
- Ledger 明确区分 account scope 与 consumer；一个 Reservation 通过 Posting 原子更新 deployment/workflow/run/scope/node/execution-group accounts，保持 non-negative/under-limit/守恒与确定性失败顺序。
- RuntimeSafetyCeilings 按 workflow/run/scope/map/execution/wait/value 等作用域分组、全部显式 finite并进入 hash；Pinned Safety 与 Live Capacity 分开，logical/stored/physical bytes 分开计账，每项均有 Enforcement Matrix。
- Workflow lifetime ledger 跨 activation/run 强制 activation、transition、child workflow、duration 与 usage budget；业务循环不能通过新 activation 重置累计额度。
- Shared claim 只读、mutation 必须 exclusive；Capability claim slot 原子绑定全部 required claims，mutation gateway 在最终提交前逐项验证 held/current fencing token。第一版禁止 Graph 运行时动态抢锁。
- Inline value、large output 和 artifact 统一经 immutable Value/Blob Store；第一版暂不做机密性/Value 权限隔离，但强制完整性、有限 Retention、GC/磁盘 backpressure 与 Credential 原文不落盘。
- Duplicate completion/signal/outbox/finalizer 不会重复发布 output、解析 edge、创建 child、写 cut 或推进 workflow。
- Mutable mutation 的 crash fixture 覆盖 intent 前后、外部 apply 前后、receipt/snapshot 前后；跨 attempt 使用 node/business key 时不会重复 promote/commit，stale fencing token 被拒绝，结果不确定进入 action-required。
- Pause 不丢弃 active result、signal 或 timeout，也不延长 deadline；resume 先进入 recoverable `resuming` barrier，drain pending error/eligibility/settled fact 后才开放 scheduler。
- Scheduler 按 durable Run round-robin admission，再按 eligible event/scope manifest/node key 排序；Graph Source 不能声明 scheduler priority，wait 不占 execution slot。
- Recovery 能覆盖 snapshot/compile/materialize、attempt preparation/execution/evaluation、wait、child scope、route resolution、cut、compensation 和 outbox lease。
- 普通 node 不写共享 workflow context；只有 root coordinator 在 T8 提交受信任 typed Context Patch 和 terminal output binding。
- Transition history 与 checkpoint unique key 证明 root cut 只推进一次；checkpoint 的 nullable root plan、Run Manifest、ledger、close/cut/output hashes 能定位完整动态执行历史。
- Trusted child-workflow effect 对 source cut/effect/creation key exactly-once，写 parent-child lineage 并受 child Recipe allowlist/lifetime budget 约束；需要同步结果的流程使用 subgraph 或显式 wait/signal。
- Workbench 展示 scope tree、DAG、edge resolution、input seal、attempt/wait、ledger、candidate 和 completion cut，并用 expected version fencing 操作。
- Engine error、action-required 与 quarantine 边界明确；integrity quarantine 停止所有状态推进且不能伪造 cut，只能恢复可信数据或写独立审计的 administrative abandon。
- Workflow 权威事实只写独立 `workflow-runtime.db`，`messages.db` 仅保存可重建 Projection；跨库只走幂等 Outbox，所有 Runtime 连接由统一 Factory 设置生产 PRAGMA。
- Fixture、Property Test、独立 Reference Model、Virtual Clock/Fake Adapter 与 Fault Injection 同为强制门禁；随机失败保存 seed、shrinking 后转成永久回归 Fixture。
- T3/T7 使用真实文件 SQLite 在 versioned Supported Limit 上覆盖最坏 Graph/Scope 形状；配置不得超过认证上限，并同时通过复杂度、正确性和绝对短事务预算。
- Domain recipe 能组合完整 graph 能力而无需修改 core runtime。
