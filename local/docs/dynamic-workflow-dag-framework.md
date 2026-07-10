# Dynamic Workflow DAG 与 Parallel/Fan-in 框架方案

> **状态**: 提案
> **范围**: Icarus core workflow runtime
> **目标**: 让 workflow runtime 同时支持静态定义流程、静态并行分支和运行时生成的受约束 DAG。

## 背景

Icarus 当前已经具备 workflow definition、delegation、system action、interrupt、terminal、context pack、artifact contract、evaluator、host/container/IPC/MCP 等基础能力。现有模型适合顺序或少量固定分支的流程，但对以下任务表达不足：

- 多分支并行执行与 fan-in 汇总。
- 每个分支独立 handoff、context pack、artifact contract、evaluator、retry。
- 根据上游结果在运行时生成新的执行图。
- 条件分支、局部重试、局部 fan-in、补充执行和可审计动态扩展。
- 工作台、trace、checkpoint、pause/cancel/resume 对并行与动态节点的可观测性。

并行调研只是一个触发场景。底层能力不应命名为 research graph，也不应理解 research lane、evidence 或行业业务语义。core 应提供通用的 Dynamic Workflow DAG 能力；research、创业机会分析、诊断、文档生成、代码迁移、运营排障等任务都可以基于它实现自己的 domain recipe。

## 目标

- 保留现有静态 workflow definition 模式。
- 新增 first-class parallel/fan-in 能力，支持固定分支并行执行。
- 新增 runtime-generated workflow graph 能力，支持由 planner、用户模板或上游节点产出 DAG spec，再由 deterministic compiler 校验后执行。
- 将静态 workflow、静态 parallel 和动态 graph 统一到同一套执行协议、状态模型、artifact/evaluator、trace 和 checkpoint 中。
- 让 LLM 只生成候选 graph spec，不直接修改 workflow definition，不绕过 compiler、权限、预算和质量门。
- 让动态 DAG 能表达 parallel、dependency、conditional、join、fan-in、retry、skip、partial success 和 follow-up subgraph。
- 让 Workbench 和 Trace 能展示 graph run、node 状态、依赖、artifact、evaluation、limitations 和重试记录。

## 非目标

- 不把 research、创业机会、代码审查或任何领域逻辑写入 core workflow runtime。
- 不让 action 承载 LLM 推理、开放式调研、信息抽取、机会判断或报告生成。
- 不允许 LLM 直接注册任意 role、skill、tool、action、mount 或文件权限。
- 不要求所有 workflow 都动态化；审批流、固定研发流和简单任务仍可使用静态 workflow definition。
- 不把动态 DAG 做成第二套独立 workflow engine；它必须复用现有 workflow、delegation、artifact contract、quality gate、context pack 和 MCP/IPC 链路。

## 核心结论

底层统一为：

```text
Workflow Runtime
  -> static workflow definition
  -> static parallel state
  -> dynamic graph state
  -> generic DAG execution protocol
```

区别只是 graph spec 的来源不同：

| 来源 | 用途 |
| --- | --- |
| workflow definition file | 固定流程，适合确定任务流 |
| static parallel state | 固定 fan-out/fan-in，适合已知分支集合 |
| planner generated artifact | 运行时动态 DAG，适合探索、诊断、调研和复杂编排 |
| user-selected template + parameters | 模板化动态流程 |
| previous node output | 根据执行结果生成 follow-up graph |

静态 workflow 可以被视为预先写好的 DAG；动态 workflow graph 是运行时生成、编译、校验并 materialize 的 DAG。core 不关心 graph 节点的领域含义，只关心节点类型、依赖、权限、预算、artifact contract、quality gate 和执行状态。

## 术语

| 术语 | 含义 |
| --- | --- |
| Workflow Definition | 预先注册的 workflow 定义，可以包含顺序 state、parallel state 或 dynamic graph state |
| Runtime Graph Spec | 运行时生成或加载的 DAG JSON，不直接执行，必须先通过 compiler |
| Graph Compiler | 确定性校验与归一化模块，将 graph spec 编译为可执行 graph plan |
| Graph Run | 某次 dynamic graph 或 static parallel 的执行实例 |
| Graph Node | DAG 中的执行节点，可映射为 delegation、system action、interrupt、join、subgraph 等 |
| Graph Edge | 节点依赖关系和条件路由 |
| Join Policy | 多个上游节点完成后如何 fan-in、是否允许 partial success |
| Materialization | 将静态分支或动态 spec 写入持久化表，生成 node/run 记录并开始调度 |

## State 类型演进

保留现有 state 类型，并新增两个通用 state：

```ts
type WorkflowDefinitionState =
  | WorkflowDefinitionDelegationState
  | WorkflowDefinitionSystemState
  | WorkflowDefinitionInterruptState
  | WorkflowDefinitionTerminalState
  | WorkflowDefinitionParallelState
  | WorkflowDefinitionGraphState;
```

`parallel` 是固定分支 fan-out/fan-in 的便捷表达。它可以编译成一个内部 graph run，但在 workflow definition 中保留独立 state 类型，便于固定流程直接使用。

`graph` 是运行时 DAG 执行 state。它从 workflow context、上游 artifact 或模板中读取 graph spec，经 compiler 通过后 materialize 并执行。

## Static Parallel State

固定 parallel state 示例：

```json
{
  "type": "parallel",
  "label": "并行复核",
  "max_concurrency": 4,
  "join_policy": {
    "type": "required_success",
    "required_nodes": ["schema_review", "risk_review"],
    "allow_failed_nodes": true
  },
  "branches": [
    {
      "key": "schema_review",
      "label": "结构复核",
      "delegate": {
        "role": "schema_reviewer",
        "skill": "schema-review",
        "task_template": "..."
      },
      "artifact_contract": { "ref": "example.schema_review.v1" },
      "evaluator": { "ref": "example.schema_review.v1" }
    },
    {
      "key": "risk_review",
      "label": "风险复核",
      "delegate": {
        "role": "risk_reviewer",
        "skill": "risk-review",
        "task_template": "..."
      },
      "artifact_contract": { "ref": "example.risk_review.v1" },
      "evaluator": { "ref": "example.risk_review.v1" }
    }
  ],
  "on_join": {
    "success": { "target": "next_state" },
    "partial": { "target": "quality_review" },
    "failure": { "target": "quality_review" }
  }
}
```

运行时要求：

- 进入 state 时创建 graph run，并为每个 branch 创建 node 记录。
- branch delegation 完成后只更新对应 node，不推进主 workflow。
- join policy 满足后生成 fan-in context，再按 `on_join` 路由。
- 支持 branch 级 retry、skip、cancel 和 revision。
- checkpoint 记录 graph run id、node attempts、fan-in context hash。

## Dynamic Graph State

动态 graph state 示例：

```json
{
  "type": "graph",
  "label": "执行动态计划",
  "graph_ref": "context.dynamic_graph",
  "compiler": "workflow_dag.v1",
  "max_nodes": 64,
  "max_depth": 8,
  "max_concurrency": 8,
  "allowed_node_types": ["delegation", "system", "join", "interrupt"],
  "allowed_roles": ["planner", "researcher", "reviewer", "reporter"],
  "allowed_actions": ["schema_validate", "dedupe", "score", "context_patch"],
  "required_quality_gates": ["artifact_contract", "schema"],
  "on_complete": {
    "success": { "target": "next_state" },
    "partial": { "target": "quality_review" },
    "failure": { "target": "quality_review" }
  }
}
```

`graph_ref` 指向上游节点写入 workflow context 的 graph spec。graph state 不信任该 spec，必须通过 compiler 校验、补全默认值和归一化后才执行。

## Runtime Graph Spec

通用 graph spec 不包含领域概念。业务侧可以在 `input`、`metadata` 或 artifact schema 中放自己的字段，但 core 只校验通用结构。

```json
{
  "version": "workflow_dag.v1",
  "graph_id": "example_dynamic_graph",
  "label": "示例动态执行图",
  "defaults": {
    "max_concurrency": 6,
    "retry_policy": {
      "max_attempts": 2,
      "retry_on": ["transient_error", "quality_gate_failed"]
    }
  },
  "nodes": [
    {
      "id": "node_a",
      "type": "delegation",
      "label": "节点 A",
      "depends_on": [],
      "role": "researcher",
      "skill": "some-skill",
      "task_template": "...",
      "input": {
        "topic": "{{context.topic}}"
      },
      "artifact_contract": { "ref": "some.contract.v1" },
      "evaluator": { "ref": "some.contract.v1" },
      "quality_gate": {
        "pass_policy": "all_blocking_pass"
      }
    },
    {
      "id": "node_b",
      "type": "system",
      "label": "归一化",
      "depends_on": ["node_a"],
      "action": "dedupe",
      "input": {
        "source": "{{nodes.node_a.result}}"
      }
    },
    {
      "id": "join_main",
      "type": "join",
      "label": "汇总",
      "depends_on": ["node_a", "node_b"],
      "join_policy": {
        "type": "all_completed",
        "min_success": 2
      }
    }
  ],
  "edges": [
    { "from": "node_a", "to": "node_b" },
    { "from": "node_a", "to": "join_main" },
    { "from": "node_b", "to": "join_main" }
  ],
  "output": {
    "fan_in_context": "join_main"
  }
}
```

允许的 node type：

| Node Type | 含义 |
| --- | --- |
| `delegation` | 创建 agent delegation，适合 LLM 推理、规划、抽取、综合、报告 |
| `system` | 执行 deterministic workflow action |
| `interrupt` | 等待用户输入或人工审批 |
| `join` | 汇总多个上游节点结果，生成 fan-in context |
| `subgraph` | 执行嵌套 graph，必须受最大深度和预算限制 |
| `terminal` | graph 内终止节点 |

`parallel` 不一定作为 graph node type 出现。DAG 中多个无依赖节点天然并行；如果需要 UI 分组或局部并发限制，可以使用 `parallel_group` metadata：

```json
{
  "id": "node_a",
  "type": "delegation",
  "parallel_group": "discovery"
}
```

## Graph Compiler

Graph Compiler 是动态能力的安全边界。它只做确定性校验、归一化和编译，不做业务判断。

必须校验：

- `version` 是否受支持。
- `nodes` 是否非空且不超过 state 配置的 `max_nodes`。
- node id 是否唯一、稳定、可作为数据库 key。
- `depends_on` 和 `edges` 是否一致。
- graph 是否为 DAG，是否无环。
- depth 是否不超过 `max_depth`。
- node type 是否在 allowlist。
- delegation role、skill 是否在 workflow state allowlist 或 package manifest allowlist。
- system action 是否在 action allowlist。
- artifact contract 和 evaluator ref 是否存在。
- quality gate 是否满足 state 要求。
- retry policy、timeout、预算是否不超过 workflow 限制。
- join policy 是否明确，是否不会永久等待不可达节点。
- input template 只能引用允许的 context、artifact、node result 和 constant。
- 不允许 graph spec 声明新工具权限、文件挂载、外部网络权限或 host path。
- 不允许 graph spec 覆盖 workflow owner、feature id、group、security scope。
- 每个 executable node 必须能解析到已注册 capability；不能解析时不得静默降级执行。

compiler 输出：

```json
{
  "compiled_graph_id": "cgraph_001",
  "source_graph_hash": "sha256:...",
  "normalized_nodes": [],
  "normalized_edges": [],
  "limits": {
    "max_nodes": 64,
    "max_depth": 8,
    "max_concurrency": 8
  },
  "warnings": [],
  "limitations": []
}
```

compiler 失败时，graph state 不得部分执行。错误进入 workflow trace，并路由到配置的 failure target 或人工修正 state。

## Node Capability Catalog

动态 DAG 可以新增 node instance，但不能在运行时凭空新增 agent 能力。每个 executable node 都必须映射到已注册、已授权、可执行的 capability。

Capability catalog 由 core、feature package 或 domain recipe 注册，描述 node 能力与 runtime 资源之间的映射：

```json
{
  "capability_id": "opportunity.review_mining",
  "node_type": "delegation",
  "role": "web_opportunity_research",
  "skill": "opportunity-review-mining-recon",
  "artifact_contract": "startup_opportunity.discovery_lane_result.v1",
  "evaluator": "startup_opportunity.discovery_lane_result.v1",
  "required_tools": ["web_search", "opportunity_collect_reviews"],
  "allowed_groups": ["web"],
  "fallbacks": ["generic.research"],
  "capability_level": "specialized"
}
```

planner 生成 graph spec 时应优先引用 `capability_id`，或引用能被 compiler 唯一解析为 capability 的 `role + skill + node_type`。compiler 必须检查：

- capability 是否存在。
- 当前 workflow、feature、group 是否允许使用该 capability。
- role、skill、action、artifact contract、evaluator 是否已注册。
- required tools 是否已授权且在目标 group agent/container 中可用。
- capability 的 artifact contract 是否与 node 输出要求一致。
- fallback 是否允许用于该 node，fallback 后的 quality gate、limitations 和 confidence 降权是否明确。

缺少 capability 时的处理规则：

| 情况 | 处理 |
| --- | --- |
| 同类任务已有 capability | 复用同一 capability 创建多个 node instance |
| 只有通用 fallback capability | 允许 fallback，但必须写入 `limitations`、降低置信度，并在 fan-in context 中保留 `capability_level: generic` |
| 无 capability 或缺少 required tool | compile failed，不能执行该 node |
| 需要新增权限、mount、tool 或 group agent | compile failed，路由到 capability setup、人工处理或 workflow failure target |
| node 非必需且 join policy 允许 | 可标记 `skipped: capability_missing`，并进入 limitations |

graph spec 可以声明期望能力，但不能自己注册 capability，也不能扩大权限：

```json
{
  "id": "review_mining_pet_apps",
  "type": "delegation",
  "capability_id": "opportunity.review_mining",
  "input": {
    "target_products": "{{context.product_seed}}"
  }
}
```

compiler 对缺失能力的结构化错误示例：

```json
{
  "error": "capability_missing",
  "node_id": "app_store_review_collection",
  "required_capability": "opportunity.app_store_review_collection",
  "missing": ["skill", "required_tool"],
  "suggested_resolution": "enable capability or skip node with limitation",
  "can_skip": true
}
```

这条规则是动态 DAG 的关键边界：动态的是节点组合、参数、依赖和执行路径；能力集合本身必须由已安装、已授权的 catalog 提供。

## 执行模型

执行调度规则：

```text
materialize graph run
  -> create node records
  -> mark nodes with no unmet dependency as ready
  -> dispatch ready nodes up to max_concurrency
  -> node complete/fail/skip
  -> evaluate quality gate
  -> update dependent readiness
  -> join nodes generate fan-in context
  -> graph complete when terminal/join policy satisfied
```

节点状态：

| Status | 含义 |
| --- | --- |
| `pending` | 已创建，等待依赖 |
| `ready` | 依赖满足，等待调度 |
| `running` | 正在执行 |
| `completed` | 执行成功且质量门通过 |
| `needs_revision` | 执行完成但质量门未通过，可重试或修订 |
| `failed` | 执行失败 |
| `skipped` | 条件不满足或被 join policy 跳过 |
| `cancelled` | 被取消 |

graph run 状态：

| Status | 含义 |
| --- | --- |
| `compiling` | 正在编译 graph spec |
| `running` | graph 正在执行 |
| `joining` | 正在生成 fan-in context |
| `completed` | 成功完成 |
| `partial` | 达到 partial success |
| `failed` | 未满足最低 join policy |
| `paused` | 暂停 |
| `cancelled` | 取消 |

## Join Policy

通用 join policy：

| Policy | 含义 |
| --- | --- |
| `all_completed` | 所有上游节点到达终态后 join |
| `all_success` | 所有上游节点必须 `completed` |
| `min_success` | 成功节点数达到阈值即可 join |
| `required_success` | 指定节点必须成功，其他节点可失败并进入 limitations |
| `best_effort` | 可运行节点都完成后 join，失败节点进入 limitations |
| `quality_threshold` | evaluation score 或 blocking gate 达到阈值后 join |

fan-in context 必须包含：

- 成功节点列表。
- 失败、跳过、未运行节点列表。
- 每个节点 artifact refs。
- evaluation summary。
- limitations 和 open questions。
- join policy 判定结果。
- source graph hash 和 graph run id。

## 持久化建议

通用表结构建议：

```text
workflows
  - current_delegation_id
  - current_graph_run_id

workflow_graph_runs
  - id
  - workflow_id
  - state_key
  - graph_kind                  static_parallel | dynamic_graph | subgraph
  - status
  - source_graph_hash
  - compiled_graph_json
  - join_policy_json
  - fan_in_context_json
  - limits_json
  - created_at
  - updated_at

workflow_graph_nodes
  - id
  - graph_run_id
  - workflow_id
  - state_key
  - node_key
  - node_type
  - label
  - status
  - attempt
  - delegation_id
  - action_name
  - artifact_refs_json
  - result_json
  - evaluation_id
  - error
  - started_at
  - completed_at
  - created_at
  - updated_at

workflow_graph_edges
  - id
  - graph_run_id
  - from_node_key
  - to_node_key
  - condition_json

workflow_graph_events
  - id
  - graph_run_id
  - node_key
  - event_type
  - payload_json
  - created_at
```

`parallel` state 不需要独立 `workflow_parallel_runs` 表；可以用 `workflow_graph_runs.graph_kind = static_parallel` 表达。若实现阶段为了迁移方便保留 parallel 专用表，也应在语义上向 graph run 收敛。

## Delegation 与 Action 边界

适合 delegation node：

- LLM 规划。
- 开放式调研。
- 代码阅读和方案判断。
- 信息抽取和综合。
- 报告生成。
- 需要模型推理的质量复核。

适合 system node/action：

- schema validation。
- artifact contract validation。
- evidence ref validation。
- deterministic dedupe。
- deterministic scoring。
- context patch。
- routing decision。
- graph compile。
- fan-in context assembly。

不适合 action：

- 隐藏 LLM 调用。
- 开放式检索判断。
- 业务机会判断。
- 自然语言报告生成。
- 需要人工或模型裁量的复杂决策。

如果 action 需要长耗时 deterministic 操作，可以把 `WorkflowActionHandler.run` 扩展为 async，并让 runtime await。async action 仍然不能成为隐藏的 agent。

## Context Pack、Artifact Contract 与 Quality Gate

每个 graph node 都可以声明自己的 context requirements、artifact contract、evaluator 和 quality gate。执行规则与普通 workflow stage 一致：

- delegation node 创建前生成 context pack。
- artifact contract 校验产物是否存在、字段是否齐全、路径是否在 allowed root。
- evaluator 生成结构化 evaluation。
- quality gate 决定 node 是 `completed`、`needs_revision` 还是 `failed`。
- node evaluation summary 进入 fan-in context。

动态 graph 不降低质量门要求。相反，compiler 应要求关键 node 必须声明 artifact contract 或明确 `no_artifact_expected: true`。

## Retry、Pause、Cancel、Resume

- 支持 node 级 retry，不默认重跑整个 graph。
- 支持从失败 node 继续调度依赖节点。
- 支持 graph 级 retry，但必须生成新 attempt 或新 graph run，保留旧 run 审计。
- pause 作用于 graph run，running delegation 按现有机制暂停或等待安全点。
- cancel 作用于 graph run，并传播到 active delegation。
- resume 重新计算 ready nodes，不重复执行已成功且 artifact hash 未变化的节点，除非配置 `rerun_completed`。

## Workbench 与 Trace

工作台展示要求：

- workflow 时间线中 graph/parallel state 显示为一个阶段。
- 阶段内展示 DAG 或分组列表，包括 node 状态、依赖、attempt、delegation、artifact、evaluation。
- 支持按 node 查看 context pack、handoff、result、artifact、evaluation 和错误。
- 支持 node 级 retry、skip、cancel。
- fan-in context 显示成功节点、失败节点、limitations、open questions 和 join policy 判定。
- dynamic graph spec、compiled graph hash 和 compiler warnings 必须可审计。

## 权限与安全

- Graph spec 不能声明新权限，只能在 workflow state 和 feature package 已授权范围内选择。
- role、skill、action、artifact contract、evaluator 都必须在 allowlist 或 package manifest 中存在。
- 文件路径和 artifact root 仍由 workflow storage/path resolver 控制。
- container mount 由 workflow、feature 和 group 权限决定，不能由 graph spec 动态扩大。
- dynamic graph 的 node 数、深度、并发、超时、token 预算和外部工具使用必须有上限。
- compiler 和 graph execution 事件必须写 audit。

## 与 Domain Recipe 的关系

core framework 不定义业务流程。领域 recipe 负责：

- 定义可用 role、skill、artifact contract、evaluator。
- 定义 planner 如何产出 graph spec。
- 定义业务 schema、评分规则、报告结构和质量要求。
- 定义哪些 node 是必需的、哪些是可选的、哪些失败会进入 limitations。

例如创业机会调研可以定义：

```text
startup_opportunity_research recipe
  -> scope_framing
  -> strategy_planning
  -> graph_spec artifact
  -> graph_compile via generic compiler
  -> graph_execute via generic runtime
  -> gap_analysis
  -> followup_graph_spec
  -> followup_graph_execute
  -> synthesis / scoring / review / report
```

其中 `user_language_mining`、`review_mining`、`market_size`、`counter_evidence` 等都是 recipe 的 lane type，不是 core node type。

## 推荐实施顺序

1. 在 workflow definition 中新增 `parallel` state 和 `graph` state 类型。
2. 新增通用 graph run/node/edge/event 持久化模型。
3. 将 static parallel 编译为 `graph_kind = static_parallel` 的 graph run。
4. 实现 branch/node delegation 调度、node 级 artifact/evaluator/quality gate 和 fan-in context。
5. 实现 join policy、node retry、pause/cancel/resume、checkpoint。
6. 新增 graph compiler，第一版只支持 allowlist node type、DAG 校验、预算和权限校验。
7. 新增 dynamic graph state，从 context/artifact 读取 graph spec，compile 后执行。
8. 更新 Workbench/Trace 展示 graph run、node、edge、artifact、evaluation 和 compiler warnings。
9. 将领域 workflow 改成外层固定 workflow + 内部 dynamic graph，例如创业机会调研、诊断或代码迁移。

## 验收标准

- 现有静态 workflow 不受影响。
- 固定 `parallel` state 能创建多个 branch delegation，并在 join policy 满足后 fan-in。
- 每个 branch/node 拥有独立 context pack、artifact contract、evaluator、retry 和 trace。
- dynamic `graph` state 能读取上游 graph spec，经 compiler 通过后 materialize 为 graph run。
- compiler 能阻止循环依赖、未知 node type、未授权 role/skill/action、缺失 artifact contract、超预算和非法 context 引用。
- graph run 支持 node 级 retry、pause/cancel/resume 和 checkpoint。
- Workbench 能展示 graph run 和 node 状态，不把并行或动态执行隐藏在单个 agent 节点内部。
- fan-in context 能记录成功、失败、跳过节点、artifact refs、evaluation summary、limitations 和 open questions。
- 领域 recipe 可以基于 dynamic DAG 生成不同结构的执行图，而不需要修改 core runtime。
