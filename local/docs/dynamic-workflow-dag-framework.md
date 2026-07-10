# Dynamic Workflow Graph Runtime 完整架构方案

> **状态**: 完整目标架构提案
> **范围**: Icarus core workflow runtime
> **目标**: 统一静态 workflow、并行执行、运行时 DAG、条件路由、局部汇合、持久等待、子图和受约束动态扩图。

## 导航

- [核心对象与不变量](#核心对象模型)
- [Scope Interface、Source IR 与 fixture](#scope-interface-与-source-ir)
- [Edge、Port、Node 与 Completion 语义](#control-edgecondition-与-trigger)
- [Capability、Policy 与 Compiler](#capability-catalog-与-effect-contract)
- [状态、Ledger 与持久化模型](#graph-与-node-状态模型)
- [事务、CAS、Cancel 与恢复](#事务边界与-cas)
- [开发期重构约束与验收](#开发期直接重构约束)

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
- 所有可执行 state activation 使用同一 Graph Runtime；顺序 state、parallel state 和 dynamic graph 不建立三套执行协议。
- 一个 state activation 恰好对应一个 root Graph Run。
- 一个 Graph Run 可以追加 child scope，但任何已 materialize 的 Scope Plan 永不修改。
- 支持 `delegation | system | wait | join | subgraph | expand | map | terminal` 完整 node union。
- 分离 control routing、data readiness、node trigger 和 scope completion，避免用“全部前驱成功”承担所有语义。
- 让 runtime graph 在受信任 policy envelope 内选择结构和内部 completion policy，但不能扩大 capability、权限、预算或外层 transition。
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
- 不保证 agent/action 物理执行 exactly-once；有副作用的 capability 必须提供幂等或 compensation 合同。

## 核心对象模型

```text
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

1. 一个 activation 恰好对应一个 root Graph Run；一个 run 对应一棵有限、深度受限的 scope ownership tree。
2. Scope Plan 创建后不可变；扩图只能 append child scope，不能修改 parent 或 sibling plan。
3. Edge 两端必须属于同一 scope。Child 只能读取 owner node 冻结的输入，不能读取 parent 后续结果。
4. 每个 scope 内 control、data 和 guard readiness dependency 的并集必须无环。
5. Node trigger、input seal、route resolution 和 scope completion 是四套独立协议。
6. Node terminal outcome、edge resolution、published output、close request 和 completion cut 一旦提交就不可变。
7. 每个 child scope 具有唯一 `(parent_scope_id, owner_node_id, child_key)`，恢复不能重复创建。
8. 所有被激活 node 的 sealed input snapshot 记录 selected edge、value ref/hash、resolution seq 和 schema hash；因 trigger/input impossible 被 skip 的 node 保存对应 decision snapshot。Late data 不能修改任何已冻结 snapshot。
9. Normal named exit、engine error 和 cancellation 是不同结果，不能混用一个 `failure` 字段。
10. Root completion coordinator 是唯一允许提交 workflow context 和推进外层 transition 的执行单元。
11. 创建 child scope、map item、attempt 或 wait 前必须先在事务型 ledger 中预留额度。
12. Child policy 只能逐层收紧，effective policy 是 global/workflow/state/parent/factory request 的交集。
13. 所有 registry、definition、interface、policy、template 和 capability 引用均固定 version/hash；恢复不读取 latest。
14. `parallel` 只是 authoring sugar，lower 后与其他 scope 使用同一 runtime、store、ledger 和恢复协议。

## 术语

| 术语               | 含义                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| Scope Interface    | Scope 的 typed input ports 与 named exits/output ports 合同            |
| Scope Spec         | 用户或 planner 产生的 source IR，必须经过 compiler                     |
| Scope Plan         | 归一化并绑定 capability/policy 后的不可变 executable IR                |
| Scope Instance     | 某个 Scope Plan 在 Graph Run 内的一次执行实例                          |
| Owner Node         | 创建 child scope 并等待其结束的 `subgraph/expand/map` node             |
| Control Edge       | 根据 source terminal fact 和确定性条件解析为 taken/not-taken 的路由边  |
| Data Edge          | 将 scope input、literal 或 node output 传给目标 input port 的值边      |
| Trigger            | 根据 control edge truth 决定 node 是否被激活的三值逻辑表达式           |
| Input Seal         | input port 已确定选值，或已确定无法满足的不可逆状态                    |
| Terminal Candidate | terminal node 为某个 named exit 提交的不可变候选输出                   |
| Close Request      | coordinator 选定 candidate、冻结 fact frontier 并 fencing 其余工作     |
| Completion Cut     | closing 条件满足后提交的最终 scope output/outcome 切面                 |
| Named Exit         | scope 正常业务出口，例如 `accepted`、`partial`、`manual_review`        |
| Resource Ledger    | 对 scope/node/attempt/wait/output 等资源进行原子预留、消费和释放的账本 |

## State 与 Graph 的统一

Workflow definition 保留 authoring-friendly state 类型，但 compiler 全部 lower 到 Graph Runtime：

```ts
type WorkflowDefinitionState =
  | WorkflowDefinitionDelegationState
  | WorkflowDefinitionSystemState
  | WorkflowDefinitionInterruptState
  | WorkflowDefinitionParallelState
  | WorkflowDefinitionGraphState
  | WorkflowDefinitionTerminalState;
```

| State authoring type | Lowering                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `delegation`         | 单 delegation node + success/failure terminal 的 root scope         |
| `system`             | 单 system node + routes + terminal 的 root scope                    |
| `interrupt`          | 单 wait node + action/expire/cancel routes + terminal 的 root scope |
| `parallel`           | 多节点 + 显式 join/terminal 的 root scope                           |
| `graph`              | 从 frozen source 编译完整 root Scope Plan                           |
| `terminal`           | 不创建 Graph Run，直接终结 Workflow Instance                        |

这样现有顺序 workflow 仍易于书写，但 delegation completion、retry、wait、checkpoint、cancel 和 trace 不再有 graph/sequential 双轨逻辑。

受信任 graph state 合同：

```ts
interface VersionedRef {
  id: string;
  version: string;
}

interface WorkflowGraphPolicyEnvelope {
  allowed_node_types: GraphNodeType[];
  allowed_capabilities: string[];
  allowed_templates: VersionedRef[];
  allowed_interface_refs: VersionedRef[];
  allowed_wait_contracts: VersionedRef[];
  allowed_child_policy_refs: VersionedRef[];
  allow_early_close: boolean;
  allow_indefinite_waits: boolean;
  effect_policy: 'idempotent_only' | 'allow_compensatable';
  build_policy: WorkflowGraphBuildPolicy;
  limits: WorkflowGraphLimits;
}

interface WorkflowGraphBuildPolicy {
  max_attempts: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  deadline_ms: number;
}

interface WorkflowGraphPolicyRequest {
  allowed_node_types?: GraphNodeType[];
  allowed_capabilities?: string[];
  allowed_templates?: VersionedRef[];
  allowed_interface_refs?: VersionedRef[];
  allowed_wait_contracts?: VersionedRef[];
  allowed_child_policy_refs?: VersionedRef[];
  allow_early_close?: boolean;
  allow_indefinite_waits?: boolean;
  effect_policy?: 'idempotent_only' | 'allow_compensatable';
  build_policy?: Pick<WorkflowGraphBuildPolicy, 'max_attempts' | 'deadline_ms'>;
  limits?: Partial<WorkflowGraphLimits>;
}

interface WorkflowGraphPolicyProfile {
  ref: VersionedRef;
  request: WorkflowGraphPolicyRequest;
  profile_hash: string;
}

type WorkflowGraphSource =
  | { type: 'inline'; scope: GraphScopeSpec }
  | { type: 'context'; path: string }
  | { type: 'artifact'; ref: string; json_pointer?: string }
  | { type: 'template'; template_ref: VersionedRef };

type WorkflowGraphInputBinding =
  | { source: 'context'; path: string }
  | { source: 'artifact'; ref: string; json_pointer?: string }
  | { source: 'constant'; value: JsonValue };

interface WorkflowGraphLimits {
  max_scopes: number;
  max_nodes: number;
  max_nesting_depth: number;
  max_map_items: number;
  max_concurrency: number;
  max_total_attempts: number;
  max_total_waits: number;
  max_total_output_bytes: number;
  max_scope_spec_bytes: number;
  max_condition_steps: number;
  max_wait_duration_ms: number;
}

interface WorkflowDefinitionGraphState extends WorkflowDefinitionStateBase {
  type: 'graph';
  graph_source: WorkflowGraphSource;
  input_bindings?: Record<string, WorkflowGraphInputBinding>;
  root_interface_ref: VersionedRef;
  policy: WorkflowGraphPolicyEnvelope;
  exit_routes: Record<string, WorkflowDefinitionTransition>;
  on_error: WorkflowDefinitionTransition;
  on_cancel: WorkflowDefinitionTransition;
  output: { context_key: string };
}
```

Root interface 的所有 exit 必须被 `exit_routes` 完整覆盖。Runtime spec 可以选择内部 graph 结构、trigger 和 completion policy，但只能引用 envelope 允许的资源；外层 transition、context output key、权限和硬 limit 永远属于受信任 definition。

`WorkflowGraphPolicyProfile` 是 policy registry 中的 versioned immutable record，不是 source 内联权限对象。Effective policy 按 global、workflow、state、parent compiled snapshot、child profile request 的顺序逐层求交：所有 allowlist 取集合交集；boolean capability 使用逻辑 AND；numeric limit 取最小值；`idempotent_only` 比 `allow_compensatable` 更严格；child build 只能降低 `max_attempts/deadline_ms`，不能改写 inherited backoff。任何空交集或无法满足的 request 都在 compile/build 阶段确定性失败，profile 不能扩大 parent 已失去的权限。

`WorkflowDefinitionStateBase.type` 要扩展为上述完整 union。`parallel` branch 可以使用 delegation/system/subgraph 等受信任 authoring 配置，但 lower 后不保留 branch 专用状态。顺序 state 原有 `on_complete/on_resume/routes` 也要 lower 为 root interface exits 和受信任 route mapping，不能继续由旧 completion handler 单独推进 workflow。

目标 authoring contract 中 delegation/system/parallel branch 一律引用 `capability_id`，不再允许 runtime 直接组合 `role + skill + action`。Feature package 在 publish 时注册 versioned capability；definition lowering 只生成 capability reference 和 typed bindings。

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
  max_bytes: number;
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
  requested_limits?: Partial<WorkflowGraphLimits>;
  metadata?: Record<string, JsonValue>;
}
```

`format` 是 source IR compatibility revision，不是能力受限版本。Compiler 对 schema 使用 closed-world 校验，任何未知字段都拒绝。Runtime source 的 `interface_ref` 必须精确匹配 state 或 owner node 固定的 interface；不能在运行时发明下游无法验证的输入或出口。

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
      "capability_id": "example.analyze-report",
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
- 非 `exists` 运算遇到 absent、type mismatch、非有限 number 或超出 size/step limit 时产生 condition error。
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
      max_bytes: number;
      aggregation: Extract<InputAggregation, { type: 'single' }>;
    }
  | {
      schema: CompiledPortSchema;
      max_bytes: number;
      aggregation: Extract<InputAggregation, { type: 'list' }>;
      item_schema: CompiledPortSchema;
      item_max_bytes: number;
    };

interface CompiledNodeOutputPortContract {
  schema: CompiledPortSchema;
  max_bytes: number;
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
- `NodeInputPortContract.schema_ref/max_bytes` 始终描述 sealed logical port value；list 时它必须是 array schema 和整个数组的 byte limit。List aggregation 必须声明 `item_contract`，每条 available data value 先按 item schema/bytes 校验，seal 后再按 array schema/total bytes 校验；single aggregation 禁止 `item_contract`。Compiled contract 将这些解析为 `item_schema/item_max_bytes`。
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
  capability_id: string;
  retry_request?: {
    max_attempts: number;
    retry_on?: string[];
  };
  timeout_ms?: number;
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
  result_output_port: PortName;
  child_policy_ref?: VersionedRef;
}

interface ExpandNodeSpec extends GraphNodeBase {
  type: 'expand';
  child_interface_ref: VersionedRef;
  input_ports: Record<PortName, NodeInputPortContract>;
  graph_spec_input_port: PortName;
  child_input_bindings: Record<PortName, PortBindingSpec>;
  result_output_port: PortName;
  child_policy_ref?: VersionedRef;
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
  requested_max_items?: number;
  requested_child_concurrency?: number;
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
  effective_limits: Record<string, number>;
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
    effective_max_duration_ms: number;
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
  result_output_port: PortName;
  child_policy: CompiledChildPolicyBinding;
}

interface CompiledExpandNode extends CompiledGraphNodeBase {
  type: 'expand';
  graph_spec_input_port: PortName;
  child_interface_snapshot: GraphScopeInterfaceContract;
  child_input_bindings: Record<PortName, PortBindingSpec>;
  result_output_port: PortName;
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
  effective_max_items: number;
  effective_child_concurrency: number;
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

Port 的权威来源固定：capability node 从 catalog 派生；wait 从 versioned signal/timer/approval contract 派生；terminal input 从 scope named-exit contract 派生；join 和 child-owner 才允许 source 显式声明 input ports。Join output 由 `expose` 对应 input contract 派生，subgraph/expand result output 由 child interface 的 discriminated exit envelope 派生，map result output 由下述固定 envelope 派生。Compiler 把 factory、bindings、child policy、map controller 和所有 ports 解析为 typed `CompiledGraphNode`，runtime 不重新解释 opaque controller JSON，source 也不能用重复声明覆盖 registry contract。

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
- Registration、signal delivery 和 timeout 使用稳定 correlation/idempotency key 与 CAS。
- Signal payload 必须通过固定 schema，解析后成为 node typed output。
- Wait 只阻塞依赖它的路径，不自动 pause 整个 Graph Run。
- Signal/approval resolve 和 timer fire 使 node `succeeded` 并发布唯一 required `resolution` output；bounded wait 超时使 node `failed/wait_timeout`，manual cancel 使 node `cancelled/wait_cancelled`。
- `timeout_ms` 在 arm transaction 中转换为 immutable absolute `deadline_at`；restart 不延长 deadline。任何有限 timeout，以及 timer input 给出的绝对 deadline，都必须满足 `deadline_at - armed_at <= max_wait_duration_ms`，不能用有限但超长的值绕过 policy。没有 timeout 的 signal/approval 还要求 contract `allow_indefinite=true` 且 effective envelope `allow_indefinite_waits=true`。
- Invalid external payload 记录 rejected inbox event，wait 保持 armed；registration delivery 耗尽后 node `failed/wait_registration_failed`。Contract hash/invariant mismatch 是 scope orchestration error。

```ts
interface WaitResolutionEnvelope {
  kind: 'signal' | 'approval' | 'timer';
  action?: string;
  payload?: JsonValue;
  resolved_at: string;
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
  outputs: Record<PortName, JsonValue>;
  plan_hash: string;
  cut_event_seq: number;
}
```

`outputs` 必须精确满足 child interface 对应 exit 的 required/optional port contract，因此该 envelope 的 compiled schema 是按 exit 判别的 union。

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
      outputs: Record<PortName, JsonValue>;
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

interface MapResultEnvelope {
  collection_hash: string;
  completion_policy_hash: string;
  selected_indices: number[];
  items: MapItemOutcomeEnvelope[];
}
```

`items` 永远覆盖 frozen Expansion Manifest 的全部 index 并按 index 排序，包括尚未 materialize 就被 quorum/fail-fast/parent close 截断的 slot。此类 slot 写 `fenced` 且 `scope_id=null`；build failure 写 `errored` 且 `scope_id=null`。Quorum winner set 按 `(completion_seq, index)` 选择前 N 个 accepted child 并冻结 `selected_indices`；同一事务完成的 child 由 scope 的 durable event sequence 再以 index tie-break。`item_key_pointer` 省略时 key=index；显式 key 必须是唯一 JSON scalar，重复、object/array 或 missing key 使 map node contract failure。

Map child `errored/cancelled` 的处理固定：`all_settled/record` 将其写入 item envelope；`all_settled/fail_node` 等全部 child settled 后失败；`all_accepted` 将其视为 rejected 并按 `on_rejected`；`quorum` 将其视为不可接受 item，并在剩余 child 已不可能达到 `min_accepted` 时失败。所有 fail-fast/quorum cancellation 与 scope early close 使用同一 fence/effect-safety 校验。

Map node 成功时，`all_settled/record` 和成功的 `all_accepted` 将全部 item indices 写入 `selected_indices`；`quorum` 只写 winner set。失败的 map 不发布 logical result output。Empty collection 对 `all_settled` 和 `all_accepted` 产生成功空 envelope；quorum 要求 `min_accepted >= 1`，并在 frozen `item_count < min_accepted` 时立即失败。

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
12. Settled rules 只在 reconciler 达到 fixed point 后运行。Quiescent 要求该 scope 的所有 node 已 terminal、所有 control/data resolution 已封闭、没有尚可 materialize 的 owner child 或 held controller reservation；pending node 必须先被证明 trigger/input impossible 并 terminalize，不能因暂时没有 ready work 就提前结算。Paused scope 不视为 quiescent。
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
  | { kind: 'cancelled'; reason: string };
```

`success`、`partial`、`failure` 可以作为业务 exit name，但 snapshot/compiler/invariant error 必须走 `errored`。Root normal outcome 根据 `exit_routes` 推进 workflow；root error 走 `on_error`；local cancel 走 `on_cancel`；global workflow cancel 直接进入 workflow cancelled terminal。

## Capability Catalog 与 Effect Contract

```ts
interface WorkflowGraphCapability {
  ref: VersionedRef;
  node_type: 'delegation' | 'system';
  executor_ref: VersionedRef;
  input_ports: Record<PortName, NodeInputPortContract>;
  output_ports: Record<PortName, NodeOutputPortContract>;
  artifact_contract_ref?: VersionedRef;
  no_artifact_expected?: true;
  evaluator_ref?: VersionedRef;
  no_evaluation_expected?: true;
  quality_gate_ref?: VersionedRef;
  required_tools: string[];
  required_mcp_servers: string[];
  required_file_scopes: string[];
  allowed_groups: string[];
  retry_policy: {
    max_attempts: number;
    retry_on: string[];
    backoff: 'fixed' | 'linear' | 'exponential';
  };
  timeout_ceiling_ms: number;
  effect: CapabilityEffectContract;
  cancellation: CapabilityCancellationContract;
}

type CapabilityEffectContract =
  | { type: 'pure' }
  | { type: 'idempotent'; key: 'graph_attempt_id' }
  | {
      type: 'compensatable';
      operation_key: 'graph_attempt_id';
      compensate_action_ref: VersionedRef;
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
- Capability 必须在 `artifact_contract_ref/no_artifact_expected` 中恰选一个，并在 `evaluator_ref/no_evaluation_expected` 中恰选一个；blocking quality gate 必须与对应 evaluator/artifact contract compatible。
- Compiled node 固化完整 binding snapshot/hash；dispatch 不重新解析或 fallback。
- `pure/idempotent` capability 可以安全恢复或重放。
- `compensatable` capability 的外部 operation 必须先写 effect intent，再执行，再写 receipt；compensation 同样通过 outbox、幂等键和 lease。
- `fence_only` 只适用于没有未记录不可逆 effect、可以安全丢弃 late result 的执行；`cooperative` 会发稳定 cancel effect，但物理 ACK 不阻塞逻辑 close，因此 capability 必须显式保证 cancel 丢失/延迟时仍可安全 abandon。不能满足该保证的 effect 必须使用 compensation。
- `requires_compensation` 必须与 `effect.type=compensatable` 配对，并使 scope closing 等待 compensation terminal 或 action-required。
- 所有 capability 都必须实现上述一种 cancellation contract，因为 global workflow cancel 可以在任意时刻发生；没有安全 fence/cancel/compensation 语义的 capability 不得注册到 Graph Runtime。
- Early close、manual cancel 或 parent cancellation 可能截断 active effectful node。Compiler 必须根据 cancellation/effect contract 证明该组合可 fence、cooperative cancel 或 compensation。
- Compensation failure 不回滚数据库历史；scope/run 进入结构化 engine error 或 action-required 状态并保留 effect journal。

## Compiler

Workflow Definition Compiler、Scope Compiler 和 Static Lowerer 是不同信任边界，但共享 schema、canonical JSON、interface resolver、policy intersection 和 capability binding。

### Compiler 输入快照

- Published workflow definition version 与 state config hash。
- Root/child Scope Spec canonical bytes/hash。
- Scope Interface、policy envelope、template、capability catalog 和 evaluator registry 的 version/hash snapshot。
- Scope input port schemas；compiler 不读取或按实际 input value 特化 plan。
- Inherited policy ceiling。Parent scope id、owner node id、child key、实际 input snapshot 和 ledger reservation 属于 materialization，不进入 plan。

### 必须校验

- Closed schema、format revision、canonical JSON、size/depth 和 stable id。
- Interface 精确匹配，所有 required input/exit output 均有 typed binding。
- Node/edge/route group id 唯一，所有 endpoint 和 port 存在。
- 每条 incoming control edge 恰好被 target trigger 引用。
- Condition 只引用合法 scope/source fact，类型可比较，AST steps 在 limit 内。
- Route group mode/default/priority/no-match 无歧义。
- Data aggregation、guard、schema、pointer 和 selection policy 合法。
- Control、data、guard readiness dependency 并集为 DAG。
- Static template 引用无环；dynamic recursion 受 nesting/scope/node/ledger limit 限制。
- Node type、capability、template、interface 和 child policy 位于 effective allowlist。
- Retry、timeout、concurrency、wait、output 和 child request 不超过 inherited hard limits；所有 wait contract ref/kind/hash 位于 pinned registry snapshot 与 effective allowlist，有限 deadline 也受最大 duration 约束。
- Expand 的 `graph_spec_input_port` 必须是 required `single/only` port，schema 是 canonical `GraphScopeSpec` closed schema；Map 的 `items_input_port` 必须 seal 为 array，item schema 可赋值给 body interface 的 `item_child_input_port`，shared binding 必须完整满足其余 required child input。
- Completion rules 可达、selector 与 exit 合同一致，early predicate 单调且 effect cancellation 安全。`allow_early_close` 同时约束 scope early rules、map quorum `cancel_remaining` 和 `all_accepted/fail_fast`，不能通过结构节点绕过。
- Completion 的 early/settled rule id 在整个 scope 内唯一，priority、selector 和 phase 进入 canonical policy hash。
- 每个可能 quiescent 的路径最终能产生 candidate 或确定 engine error，不能永久悬挂。
- Dynamic source 不能覆盖 workflow owner、transition、output key、credential、mount、group 或 security scope。

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
  effective_limits: WorkflowGraphLimits;
}
```

Plan 保存完整 effective policy snapshot；hash 只是完整 canonical snapshot 的校验值，不能替代后续 child compile 所需的 allowlist、wait、effect、build 和 limit 字段。Plan hash 排除 instance id、actual input value/hash、ledger reservation、timestamp、lease 和运行状态；objects 按 key、nodes/edges/rules 按稳定 id canonicalize，业务数组保持定义顺序。相同 source、input schema、interface、policy、catalog 和 compiler 必须产生相同 plan hash，因此不同 map item 可以复用同一 plan。Actual input values 只在 scope materialize 时校验并写 instance input snapshot/hash 与 Run Manifest entry。

Parent compile 同时产生所有 inline/template static factory 的 content-addressed child plan closure；`CompiledStaticScopeFactoryBinding.precompiled_plan_hash` 必须指向该 closure。T2a 原子保存 parent plan 及缺失的 static child plans；subgraph/map build 直接绑定 pinned precompiled plan，只有 expand 才编译运行时冻结的 candidate spec。

下文 [T1 activation ingress](#事务边界与-cas) 会先创建 `lifecycle=materializing, plan_id=NULL` 的 root scope shell，因此 root snapshot/compiler failure 仍有合法 scope 挂载 engine-error close request/cut，并终结同一个 root run。Subgraph/expand 的 single child build failure 不创建 child scope，直接终结 owner node 为 failed；map item build failure 则原子填写该 item 的 `errored/scope_id=null` result slot 并重新计算 map policy，不能提前 terminalize 整个 map owner。任何 compile failure 都不能部分 materialize executable node。

## Graph 与 Node 状态模型

Run 和 Scope 将执行生命周期与控制状态拆成正交字段：

```ts
type RunLifecycle = 'initializing' | 'executing' | 'closing' | 'closed';
type RunControl = 'running' | 'paused' | 'cancelling';

type ScopeLifecycle = 'materializing' | 'active' | 'closing' | 'closed';

type NodePhase =
  | 'pending'
  | 'ready'
  | 'active'
  | 'waiting'
  | 'retry_wait'
  | 'terminal';
```

- Lifecycle 只向前推进；run control 可以 `running <-> paused`，或单向进入 `cancelling`。Scope 不复制 pause/cancel 的全局控制真相，而是读取 run control 并使用自己的 `fence_epoch` 表达局部 closing。
- Workflow-level pause 传播到整棵 scope tree，停止新 claim 和 scope materialize，但 active completion、terminal fact、edge resolution、trigger/input seal、`ready/skipped` 与 early eligibility 仍可持久化；已 ready 的下游在 resume 前不启动。
- Wait node 自身 waiting 不改变 run control，也不使 scope 进入 closing。
- Scope early completion 进入 `closing` 并 fencing remaining work；完成后进入 `closed`。
- Scope close 必须在同一事务递增目标 scope 及其全部已存在 descendant scope 的 `fence_epoch`；root close 还递增 run `fence_epoch`。Attempt、wait、build 与 child-result consumer 都必须比较创建时保存的 run/owner-scope epoch，不能只检查自身 lease。
- Run 只有 root scope 完成后才进入 `closed`。
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
  - owner_kind/id        workflow | run | scope
  - resource_type        scopes_total | nodes_total | attempts_total | waits_total |
                         active_waits | output_bytes | active_executions |
                         tokens | tool_calls | cost_micros | effect_ops
  - hard_limit
  - reserved_amount
  - consumed_amount
  - version

workflow_graph_resource_reservations
  - id
  - graph_run_id/reservation_group_id
  - owner_kind/owner_id  build | scope | node | attempt | wait | output | effect
  - resource_type
  - reservation_key
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

UNIQUE(owner_kind, owner_id, resource_type)
UNIQUE(reservation_key)
UNIQUE(idempotency_key)
UNIQUE(graph_run_id, ledger_seq)
```

- Reserve 在同一事务 CAS workflow/run/scope ancestor accounts，并验证每个 account 的 `consumed + reserved + request <= hard_limit`。
- Ledger entries 是事实源；account counters 是可从 hash chain 验证和重建的 cache。Run 保存 `ledger_seq/ledger_head_hash`。
- 一个 logical admission 使用 `reservation_group_id` 聚合，但每种 resource 都创建独立 reservation；不能用一个 header status 同时表示永久 attempt 消费、可释放 executor slot 和增量 token charge。
- Materialize scope 时分别创建并 commit `scopes_total/nodes_total` reservation。
- 创建 attempt 时 commit `attempts_total`，并为执行期创建 held `active_executions` slot；attempt terminal/fenced 后释放 slot。
- Arm wait 时 commit `waits_total` 并 hold `active_waits`；wait terminal 后只释放 `active_waits`，累计次数不会回退。
- Persist output 前预留 bytes，实际值小于 reservation 时释放差额。
- Map 必须先冻结 item count，再批量或按窗口预留 child scope/node quota；额度不足时确定性失败，不能半创建而不记录 remaining set。
- Map 窗口反复调整同一个 `(owner_kind=node, owner_id=map_node_id, resource_type)` incremental reservation，并用新的 ledger idempotency key 记每次 reserve/commit/release；不能为同一 node/resource 创建第二个 reservation 绕过 unique constraint。
- Concurrency admission 统一为 `active_executions` held-slot reservation，并同时过 global、workflow、run、scope、map 和 target group account 的最小 ceiling；lease 过期本身不释放 slot，恢复器必须先 fence/settle 对应 execution。
- `tokens/tool_calls/cost_micros` 使用各自 incremental reservation：proxy 按 provider usage id 幂等 charge，结束时 release 未消费余量。Attempt、scope 和 node 累计资源在创建时 commit，不会因失败或关闭释放。
- Token/tool/cost 必须由 credential/tool proxy 使用 provider usage id 增量 charge 并能在超限时中止；做不到实时阻断的资源只能记账，不能声称 hard enforcement。
- Reservation、instance creation 和 event 必须在同一事务提交，防止 crash 后资源漂移。

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

## 持久化模型

Graph Store 是恢复事实源，不依赖 checkpoint 复制完整图。

### Workflow 与 Run

```text
workflows
  - workflow_definition_version
  - state_instance_id
  - current_graph_run_id
  - revision

workflow_graph_runs
  - id
  - workflow_id
  - state_key
  - state_instance_id
  - workflow_definition_version
  - state_config_json/hash
  - registry_snapshot_ref/hash
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
  - root_cancel_scope       nullable；local_graph | workflow
  - root_close_request_id
  - completion_cut_id
  - control_epoch
  - fence_epoch
  - outcome_kind
  - exit_name
  - output_ref/hash
  - error_code/error_ref
  - next_event_seq
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
```

Run 只缓存 `root_close_request_id`，完整 canonical request 与 `request_hash` 只存在 close-request row；`close_reason/frontier/cancel payload` 不在 run 上复制第二份。Transition history 的两个 unique key 分别证明一个 activation 只推进一次、一个 root cut 只消费一次。

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
  - owner_run_fence_epoch/owner_scope_fence_epoch
  - lifecycle
  - fence_epoch
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
  - run_fence_epoch/owner_scope_fence_epoch
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

Build policy 的 `max_attempts` 包含首次 acquisition；build 创建事务同时写 `attempt_count=1` 和固定 absolute deadline，restart 不能延长。只有 immutable locator 获取等 transient error 可以按 backoff 重试；closed-schema、interface、policy、DAG 或 permission compile error 立即进入 `failed`。每次外部 snapshot/compile 都必须持有 build lease，并以 `build_id + status + lease_token + source/input/compiler hashes + saved run/owner-scope epochs + version` CAS 提交，stale compiler 不能覆盖新状态。

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

Seal map Expansion Manifest 时同时创建覆盖全部 index 的 `open` result slots。每个 slot 只允许一次 `open -> terminal outcome` CAS；尚未 materialize 的 quorum/fail-fast remainder 写 `fenced/scope_id=null`，build failure 写 `errored/scope_id=null`。Map owner 只能从这些有序 slots 生成 `MapResultEnvelope`。

### Node、Attempt 与 Wait

```text
workflow_graph_nodes
  - id
  - graph_run_id/scope_id/node_key
  - node_type/capability_id
  - normalized_node_json
  - phase
  - trigger_state          unknown | true | false | error
  - input_state            open | sealed | impossible | error
  - trigger_cut_json/hash
  - input_snapshot_json/ref/hash
  - selected_edges_json
  - activation_event_seq
  - run_fence_epoch_at_activation/scope_fence_epoch_at_activation
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
  - artifact_refs/result_ref/hash
  - evaluation_ref/hash
  - retry_reason/error fields/usage_json
  - acceptance_state       open | fenced
  - run_fence_epoch/scope_fence_epoch
  - resource_reservation_group_id
  - lease owner/token/expires/heartbeat
  - evaluation lease/retry/deadline
  - version/timestamps

UNIQUE(node_id, attempt_no)
UNIQUE(delegation_id) WHERE delegation_id IS NOT NULL

workflow_graph_waits
  - id
  - graph_run_id/scope_id/node_id
  - wait_type/contract_ref/contract_hash
  - correlation_key/idempotency_key
  - payload_ref/hash
  - status                 registering | armed | resolved | timed_out | cancelled
  - deadline_at
  - registration_lease owner/token/expires
  - run_fence_epoch/scope_fence_epoch
  - resource_reservation_group_id
  - version/timestamps

UNIQUE(graph_run_id, contract_ref, correlation_key, idempotency_key)
```

Node-level `trigger_cut` 和 input snapshot 是所有 node type 的恢复事实源。Delegation/system attempt 只引用并复制对应 hash，不能重新选择 edge；join/wait/subgraph/expand/map/terminal 即使没有普通 attempt，也必须基于 node snapshot 执行。

Signal、timeout 和 cancel 只竞争同一个 `status=armed + saved epochs + version` CAS，不要求外部 signal sender 持有 registration lease。首次成功者写 resolution event 并 terminalize node；其他 payload 进入 inbox/late-result audit，不能覆盖 wait outcome。

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
  - fence_epoch
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
```

Close request 是不再吸收 late fact 的 canonical 不可变观察面，`request_hash` 覆盖 reason、candidate、fact/frontier、trigger seq、fence 与 payload；completion cut 引用同 scope request 并保存最终 output binding、technical outcome 和 policy hash。Child cut 必须与 parent consumption disposition 同事务：subgraph/expand 在 accepting owner 上可以直接完成 owner；map 仅在 `controller=running + slot=open` 时填写 slot 并 reconcile policy；`closing_remaining + slot=fenced` 只写 non-publish consumption 并递减 barrier，parent/owner 已 fenced 时也只写 non-publish disposition。Root cut 必须与 run close、context patch、workflow transition/history 和 checkpoint 同事务。

`cut_hash` 覆盖 scope/run id、close-request id/hash、selected rule/candidate、outcome/exit、output hash、completion policy hash 与 cut event seq 的 canonical payload；checkpoint 保存的 completion-cut hash 必须逐字节匹配该 row。

关系约束不能只靠应用层检查：`scope(plan_id, graph_run_id)` 必须引用同 run plan；child scope 的 `(owner_node_id, parent_scope_id, graph_run_id)` 必须引用 parent scope 内 owner node；build 的 compiled plan、target scope、owner node 必须属于同 run；edge/node/candidate/eligibility/request/cut 必须属于同 scope/run。`completion_cut(scope_id, close_request_id)` 复合引用 `close_request(scope_id, id)`；run 的 `root_close_request_id/completion_cut_id` 必须属于 `root_scope_id`。所有复合引用列都建立对应 unique key，禁止通过合法单列 id 拼出 cross-run lineage。

### Inbox、Late Result、Event 与 Effect Journal

```text
workflow_graph_inbox_events
  - provider/event_id
  - target_kind/target_id
  - payload_ref/hash
  - disposition            accepted | duplicate | conflict | late | unmatched
  - created_at

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
  - effect_type
  - status                 intended | dispatched | succeeded | failed |
                           compensation_pending | compensated | action_required
  - request_ref/hash
  - receipt_ref/hash
  - compensation_ref/hash
  - lease owner/token/expires_at
  - version/timestamps

workflow_graph_events
  - graph_run_id/seq
  - scope_id/node_id/attempt_id
  - event_type/idempotency_key
  - payload_json/ref/hash
  - occurred_at/created_at

UNIQUE(provider, event_id)
UNIQUE(operation_key)
UNIQUE(graph_run_id, seq)
UNIQUE(idempotency_key)
```

Event、effect journal、outbox 和 ledger 都使用稳定 idempotency key，并通过 run 的 `next_event_seq` 分配有序审计事件。

## 事务边界与 CAS

长操作不得在 SQLite transaction 中 await。关键事务如下：

```text
T1  standalone activation ingress:
    CAS workflow revision/state; create state activation + initializing run;
    freeze definition/registry/source seed and create run ledger accounts;
    create materializing root scope shell(plan=null) + root scope build;
    bind run.root_scope_id/root_build_id and workflow.current_graph_run_id;
    allocate one initial checkpoint_version and write current-run watermark

T2a compile result persistence:
    outside tx resolve frozen locator and run pinned pure compiler;
    CAS build lease + source/input/compiler hashes + saved epochs + version;
    insert immutable parent/static-child plan closure; set build=compiled;
    non-retryable failure sets build=failed and records the appropriate fact

T2b scope materialization:
    require run.control=running, open epochs and compiled build;
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
    if control=running, arbitrate unique close request in the same transaction

T3b settled close:
    require control=running, scope active and reconciler fixed point;
    allocate one event seq and freeze the complete quiescent fact frontier;
    evaluate all settled rules together and insert the selected close request;
    if none applies, insert engine_error/no_exit_selected request in the same tx

T4  activate by node kind:
    require control=running + scope active + matching run/scope epochs;
    delegation/system -> separate attempt + active slot/usage reservations;
    wait -> waits_total + active_waits reservations, arm wait/register outbox;
    join/terminal -> publish structural envelope/candidate, no ordinary attempt;
    child owner -> seal Expansion Manifest + map slots + child builds, no attempt

T5  dispatch capability:
    persist frozen context/input; create delegation outbox or effect intent;
    execute outside tx using stable attempt/effect idempotency key

T6a internal worker result:
    CAS attempt phase + worker lease_token + saved epochs + version;
    validate artifact/evaluation, retry or terminalize and publish once

T6b delegation callback:
    CAS delegation_id/external_execution_id + acceptance=open + saved epochs
    + version; never require the external callback to possess a worker lease

T6c wait resolution:
    signal/timeout/cancel compete on status=armed + saved epochs + version;
    registration lease only protects registration work, not external delivery

T7a scope close primitive:
    normal eligibility, settled result, engine error and cancel all compete on
    UNIQUE(scope_id); allow materializing root shell only for setup error/cancel;
    insert target request; create parent_close request for every open descendant;
    set subtree closing, increment all scope epochs, fence attempts/waits/builds;
    fill open map slots as fenced and release held controller reservations;
    root close sets run.lifecycle=closing and increments run fence;
    write deterministic cancel/compensation outbox in the same transaction

T7b child DB finalizer/consumer:
    after logical fences and required compensation settle, insert child cut;
    subgraph/expand + accepting owner -> close child and terminalize owner;
    map running + slot open -> close child, fill slot + seq, reconcile policy;
    decision tx freezes selected set/slots and batch-T7a closes materialized losers;
    closing_remaining + slot fenced -> child cut + non-publish barrier decrement only;
    never overwrite a fenced slot with the loser's late child outcome;
    last loser cut/comp/reservation settles -> terminalize map owner;
    fenced parent/owner -> record non-publish disposition without changing output

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
```

“T1 core setup”只指 activation、run、ledger accounts、root shell/build、frozen snapshots 与 workflow binding。Standalone T1 在 core setup 后写自己的 initial checkpoint；T8 复用 core setup 时不得执行该 checkpoint 子步骤，而是把新 current watermark 合并进消费旧 cut 的同一个 transition checkpoint/version。

`T2a` 只持久化 immutable compile result，不消费 scope/node quota；`T2b` 才 materialize。Root build failure 在 shell 上走 `T7a(engine_error)`，随后由 T8 生成 root cut；paused 时先保存 failed build，resume transaction 再创建 request。Subgraph/expand build failure terminalize single owner；map item build failure 必须先填写对应 `errored/scope_id=null` slot，再运行 map policy。

`T3a` 的 “fact” 包括 candidate 与 node-terminal fact。同一事务内每个 ingress/derived durable fact 按确定性 fixed-point queue 分配不同的连续 event seq；queue key 固定为 `(causal_wave, fact_kind_rank, stable_object_id)`，`fact_kind_rank` 是 runtime format 常量。每写一个 fact 就基于该 post-state 计算 eligibility。Fact、由它首次产生的全部 early eligibility、以及 running 时的 close arbitration 是不可拆分原子单元；不存在异步补 eligibility 的正确实现。`T3b` 只在全部 node/edge/controller reservation 已按 quiescent 定义封闭时运行，并把 settled frontier 与 close request 绑定到同一个 event seq。

同一 T3a post-state 同时产生 engine error 与 normal eligibility 时，两者都保留审计事实，但 `engine_error` 先调用 T7a；只有不存在 error fact 时才按 eligibility 排序创建 normal request。这样 schema/routing/invariant error 不会被同事务内恰好出现的业务 candidate 掩盖。

`T7a` 对 target 插入 winning request；对每个尚无 request 的 open descendant 插入 canonical `parent_close` request，已有 close request 只保留并参与同一 subtree fence，绝不覆盖其 candidate/reason。事务同时把 pending/ready/active controller work 收敛为 fenced terminal fact、关闭 open map slots 并释放可释放的 held reservation。此后 finalizer 可以为每个 descendant 生成 cut，target cut 必须等待 descendant cut 与 required compensation 收敛，不能仅凭 epoch 已递增就关闭 parent。

核心 CAS/fence 至少包含：

```text
workflow: id + status + state_instance_id + current_graph_run_id + revision
run:      id + lifecycle + control + fence_epoch + manifest_seq + version
scope:    id + lifecycle + fence_epoch + close_request_id + version
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

## Retry、Pause、Cancel 与 Compensation

- `max_attempts` 包含首次 attempt；每次 retry 创建新 immutable attempt。
- Retry reason 使用 catalog 定义的结构化 taxonomy。`retry_request` 省略时使用 capability trusted policy；显式 request 的 `max_attempts` 与 global/state/capability ceiling 取最小值，`retry_on` 省略时继承 capability allowlist，显式空数组禁用 retry 并归一为一次。Backoff 只来自 trusted capability，source 不能选择算法。
- Evaluator pending 在同一 attempt 上使用独立 bounded lease/retry/deadline，不重复 agent/action。
- Node terminal 后不重开；重新运行 root graph 通过外层 transition 创建新 activation/run。
- Pause CAS workflow/run，并传播 scheduling barrier；paused 时允许 result、terminal fact、edge resolution、trigger/input seal、`ready/skipped` 和 early eligibility，禁止 claim、scope materialize 与普通 completion close request。显式 local/global cancel 仍可通过 T7c 抢占 paused run。Ready node 可以形成但不能启动。
- Resume transaction 在暴露 `control=running` 前处理全部 pending close fact：先按 `(error_event_seq, scope_depth, stable_fact_id)` 选择 setup/orchestration error，再对全 run 的 early eligibility 按 `(eligibility_event_seq ASC, priority DESC, rule_id ASC, scope_id ASC)` 依次竞争，最后对已达 fixed point 的 scope 执行 settled arbitration。较早 child eligibility 因而不会被较晚 ancestor resume request 改写；已有 request 仍按 T7a 规则保留。每个 winning request 都在同一事务完成 subtree fencing；commit 之前不得 claim 或 materialize。
- Manual node skip/cancel 只允许 graph paused 且携带 expected versions；随后仍按正常 terminal/edge resolution 协议收敛。
- Local graph cancel 与 global workflow cancel 使用 T7c 原子入口；parent early close 使用 T7a 的 subtree fence。Normal/error/local/global cancel 竞争同一个 close-request unique CAS，输家只写已晚到的 command audit，不能改写已冻结路由。
- Active compensatable effect 在 cancellation policy 要求时创建 compensation outbox；scope 只有所有 required compensation terminal 后才能完成 closing。
- 晚到 completion、signal 或 outbox delivery 只记录 audit，不得越过 completion fence。

## Outbox、Lease 与恢复

Outbox 是 at-least-once。每条 effect 具有 deterministic message id、lease owner/token/expiry、attempt ceiling 和 dead-letter policy。Dead-letter 与相应 attempt/wait/effect state 推进必须同事务完成。

```text
workflow_outbox
  - effect_key UNIQUE
  - aggregate_type/id/version
  - effect_type
  - payload_ref/hash
  - status                 pending | processing | succeeded | dead_letter
  - attempt_count/max_attempts
  - next_attempt_at/deadline_at
  - lease owner/token/expires_at
  - last_error
  - created_at/delivered_at
```

Delegation/action/wait/cancel/compensation adapter 必须接受稳定 effect key。Crash 发生在外部成功、outbox 标记成功之前时允许同 key 重放；外部执行可能重复，但 state effect 由 inbox idempotency、CAS 和 unique key 去重。Dispatch dead-letter 必须与 attempt failure/retry、ledger release 同事务；cancel/notification dead-letter 不能重开已 closed graph，只能创建 action item。

恢复顺序：

1. 校验 workflow activation/current run、definition/registry snapshot、root build/nullable root plan、Run Manifest hash chain、ledger chain 和 completion-cut uniqueness。
2. 优先处理已有 close request 的 scope/run：验证 request transaction 已持久化完整 hierarchical epoch fence，只重放缺失的 cancel/compensation outbox effect；若 DB fence 缺失则 quarantine，恢复器不能事后“重建”原子事实。
3. 回收 Scope Build snapshot/compiler lease；只读取 frozen seed/locator，相同 source/input/compiler hashes 重跑 pinned pure compiler。Paused run 可以停在 `compiled`，不能 materialize。
4. 验证 scope ownership tree、unique child key、plan/input hash、sealed Expansion Manifest、map result slots 和 ledger account cache 守恒。
5. 回收 preparing attempt；基于 node-level trigger cut/input snapshot 在同一 attempt 下重建 context pack。
6. `dispatch_pending` 只重投同一个 outbox effect；running delegation 先按 external id 对账，不因普通 worker lease 过期重复 dispatch。
7. Pure/idempotent system action 可按同一 attempt key 重放；compensatable action 先对账 effect receipt，再决定继续或补偿。
8. 回收 evaluator lease，在同一 attempt 基于 frozen result 继续 evaluation。
9. 回收 wait registration；signal、timeout、cancel 继续竞争同一 armed CAS，重复 payload 按 inbox idempotency key 归类。
10. 对 `subgraph/expand/map` 从 sealed Expansion Manifest 按 unique invocation key 补齐 build/materialization，或以 T7b 消费已完成 child outcome；不能重读 planner live output。
11. 从 persisted edge resolution 验证 trigger/input fixed point；已有 trigger cut/input snapshot 的 node 不重新选 edge。任何 terminal/candidate fact 缺少应原子生成的 eligibility 都是 invariant violation，禁止事后补齐。
12. Close request 已存在时不得重选 rule/candidate。Paused run 可以合法存在 eligibility 而无 request；running run 出现该状态说明 resume/fact transaction 被破坏，必须 quarantine，不能恢复仲裁。
13. Completion cut 已存在时只验证 child consumption disposition，或 root workflow transition/history/checkpoint 的同事务事实；不重建新的 cut。
14. 回收 outbox lease；child/root finalizer 是纯数据库事务，不持有独立租约。Closed run 只补外部 projection，不重做 workflow transition。

Plan/artifact hash mismatch、不同 edge decision hash、ledger chain mismatch、cross-run lineage、成功 node 必要 artifact 缺失，或 root cut 与 workflow transition/history 不匹配时进入 quarantine/action-required pause，不得猜测性重跑或补 transition。

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
  "schemaVersion": 4,
  "checkpointVersion": 34,
  "workflowId": "...",
  "stateKey": "target_graph_state",
  "stateInstanceId": "state-instance:new",
  "workflowRevision": 22,
  "graph": {
    "current": {
      "runId": "run:new",
      "lifecycle": "initializing",
      "control": "running",
      "controlEpoch": 0,
      "fenceEpoch": 0,
      "rootScopeId": "scope:new-root",
      "rootBuildId": "build:new-root",
      "sourceSeedHash": "sha256:new-source-seed",
      "rootPlanHash": null,
      "manifestSeq": 0,
      "manifestHeadHash": "sha256:manifest-genesis",
      "ledgerSeq": 0,
      "ledgerHeadHash": "sha256:ledger-genesis",
      "lastEventSeq": 1,
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
      "controlEpoch": 1,
      "fenceEpoch": 2,
      "rootScopeId": "scope:previous-root",
      "rootBuildId": "build:previous-root",
      "sourceSeedHash": "sha256:previous-source-seed",
      "rootPlanHash": "sha256:previous-plan",
      "manifestSeq": 12,
      "manifestHeadHash": "sha256:previous-manifest-head",
      "ledgerSeq": 41,
      "ledgerHeadHash": "sha256:previous-ledger-head",
      "lastEventSeq": 324,
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

- Scope input、node input 和 output 都必须匹配 versioned port schema，并有 byte limit。
- Delegation context pack 基于 frozen input 和显式 provenance 构建；不能隐式读取 sibling 或 live workflow context。
- Artifact、evaluation、effect receipt 和 result 按 run/scope/node/attempt 隔离，不覆盖 state 级 `latest.json`。
- Capability 必须恰好声明 artifact/evaluator binding 或受信任的 `no_*_expected`。
- Quality gate 决定 attempt pass/needs_revision/fail；只有最终 pass attempt 能发布 logical node output。
- 普通 node 不能修改共享 workflow context。Child completion 只发布 owner output；root coordinator 仅在 normal completed outcome 的 T8 向受信任 `output.context_key` replace 一次 result ref/hash/summary。Error/cancel transition 使用 canonical no-op context patch，除非外层受信任 transition 明确定义其他 patch。

## 权限与安全

- Source spec 只能选择 policy allowlist 中的 capability/template/interface/policy。
- Compiler 解析的 capability binding 固化到 plan；dispatch 只检查资源仍可用，不重新解析或 fallback。
- 权限收紧、resource uninstall 或 schema hash 不匹配产生结构化 non-retryable engine error。
- File/artifact path 必须通过 storage resolver；graph spec 不能提供 host path 或 mount。
- Condition evaluator 使用 typed AST、step limit、depth limit 和 total input byte limit。
- Scope spec、map collection、scope count、nesting、node、attempt、wait、output、token/tool usage 均由 hard limit/ledger 控制。
- Event payload 只保存受限 summary、ref、hash 和 policy decision，不复制 secret 或无限结果。
- External signal 必须验证 workflow/scope/node correlation、contract、authorization、expiry 和 idempotency key。

## Workbench 与 Trace

Workbench 以 state activation 为一个顶层阶段，内部展示：

- Root run lifecycle/control、named exit、budget 和 registry snapshot。
- 可折叠 scope ownership tree，以及每个 scope 的 immutable plan hash。
- Scope 内 control/data edge、实时 resolution、trigger 和 sealed input。
- Node phase/outcome、attempt history、wait deadline、child exit、artifact/evaluation/effect journal。
- Terminal candidates、selected completion rule、completion cut 和被 early-close fencing 的节点。
- Map item progress、稳定 item key/index、selected quorum set 和 ordered results。

操作请求必须携带 `run/scope/node/attempt/wait expected version + idempotency_key`。Pause 后才允许 manual skip/cancel/retry-wait advance；所有操作通过 runtime command API，不直接更新投影表。

Trace 分两层：

- `workflow_graph_events` 记录 materialize、route/data resolution、input seal、claim、retry、wait、child scope、candidate、cut、cancel、compensation 和 recovery。
- Agent/tool/effect trace 通过 `state_instance_id/run_id/scope_id/node_id/attempt_id` 关联具体执行。

## 与 Domain Recipe 的关系

Domain recipe 负责：

- 注册 capability、scope interface、template、artifact contract 和 evaluator。
- 让 planner 产生满足固定 interface/policy 的 Scope Spec。
- 定义业务 named exits、node schema、评分、报告和质量要求。
- 选择哪些分支、join、subgraph、map 或 expand 用于某次执行。

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
| `workflow-graph-types.ts`              | Source/compiled IR、ports、condition、state 和 error types            |
| `workflow-graph-interface-registry.ts` | Versioned scope interface 加载、hash 和兼容校验                       |
| `workflow-graph-policy-registry.ts`    | Versioned child policy profile、逐层 intersection 与 snapshot         |
| `workflow-wait-contract-registry.ts`   | Signal/timer/approval contract、authorization 与 schema snapshot      |
| `workflow-capability-catalog.ts`       | Capability/effect contract 加载、权限解析和 snapshot                  |
| `workflow-graph-compiler.ts`           | Pure normalize、binding、DAG、condition、completion 和 policy 校验    |
| `workflow-graph-store.ts`              | Run Manifest、Expansion Manifest、scope/node/edge/wait/cut CAS store  |
| `workflow-graph-ledger.ts`             | 原子 reservation、consumption、release 和 invariant check             |
| `workflow-graph-reconciler.ts`         | Edge resolution、trigger、input seal、readiness 和 completion         |
| `workflow-node-execution.ts`           | Delegation/system preparation、artifact、evaluation 和 effect journal |
| `workflow-graph-child-runtime.ts`      | Subgraph/expand/map materialization 与 owner completion               |
| `workflow-graph-waits.ts`              | Signal/timer/approval registration、delivery 和 timeout               |
| `workflow-graph-runtime.ts`            | Run lifecycle、pause/cancel、claim、closing 和 recovery coordination  |
| `workflow-definition-lowering.ts`      | 顺序/parallel authoring state 到统一 root Scope Plan                  |
| `workflow-graph-projection.ts`         | Workbench/read model 与 graph event projection                        |

现有 workflow orchestration 只负责 activation 边界和 root completion 后的外层 transition。Graph Runtime 不依赖 Workbench UI；UI 通过 store/query 和 command API 交互。

## 开发期直接重构约束

本文全部对象、表、事务和 node type 属于同一个交付边界，不存在可省略的降级 runtime：

- 直接落地本文 target schema、IR 与状态机；不保留旧 graph 表、双写链路、旧 completion handler 或并行的新旧 scheduler。
- 所有非 terminal authoring state 一次性 lower 到统一 Graph Runtime。Delegation/system/interrupt/parallel 的 completion、retry、wait 与 transition 不再保留旁路。
- Source IR、Compiled IR、policy/wait/capability registry、Graph Store、Run/Expansion Manifest、ledger、reconciler、executor、durable wait、child runtime、root coordinator 和 recovery 必须作为同一套 contract 实现。
- 数据库 schema、composite FK、unique/CAS、outbox 和 checkpoint 以本文最终模型建立开发期 baseline；不存在需要兼容的历史执行记录。
- Compiler fixtures 覆盖 static lowering、condition、wait、nested subgraph、expand、map 和 policy intersection；crash fixtures 覆盖 T1-T8 每个 commit 前后。
- Workbench 表、计数、状态标签和旧 state 字段只能是 Graph Store/event 的 projection，不能成为调度、恢复或 transition 的事实源。
- 完整验收门禁通过前，不以 feature flag 绕过 effect cancellation、ledger、hierarchical fence、settled arbitration 或 recovery invariant。

## 完整验收标准

- 所有非 terminal state authoring type lower 到同一 Graph Runtime，不存在 sequential/graph 双轨 completion。
- 每个 activation 唯一 root run；child scope 只以 append-only Run Manifest 增加，已存在 plan 永不修改。
- Compiler 对 control/data/guard dependency 并集做无环检查，并拒绝跨 scope edge。
- Condition 只读取允许的 frozen fact，route group 解析原子、确定且可重放。
- Trigger 三值逻辑能正确区分 ready、`route_not_selected` 和 unresolved，不会提前 skip。
- Data port aggregation/seal 能确定性选择 value；completion-order 模式完整记录选择事实。
- Delegation/system retry 保留 attempt 历史，evaluation pending 不重复执行 capability。
- Wait contract 必须来自 pinned allowlist，有限 deadline 受最大 duration 约束；wait 不占 executor slot，signal/timeout/cancel 竞态由 correlation、idempotency 和 CAS 唯一决定。
- Explicit join 不隐藏业务计算，all/any/quorum fan-in 均可通过 typed port 表达。
- Subgraph 精确实现固定 interface；child named exit 通过 owner envelope 路由。
- Expand 使用 frozen candidate、pinned registry/policy 编译 child scope，无法修改 parent plan 或扩大权限。
- Map 冻结 collection 并预建全部 result slot；未物化/build-failed item 也有稳定 outcome，quorum cut 后 late child 不能改写 selected set，owner 等 remainder cut/compensation 后才发布。
- Terminal candidate 与 completion rule 支持 settled arbitration 和安全 early close；completion cut 只写一次。
- Root normal exit、engine error、local cancel 和 global cancel 使用不同可信路由。
- Early close/cancel 对 active effectful node 执行 fencing，并按 effect contract 完成幂等取消或 compensation。
- Parent/root close 在同一事务为整个 subtree 建立 request/fence；stale attempt、wait、build 和 child callback 均无法穿越 saved epoch。
- Child policy profile 只能取 allowlist 交集、boolean AND 与 numeric min；compiled plan 保存完整 effective snapshot。
- Ledger 为累计资源、held slot 与 incremental usage 使用独立 reservation，在并发 claim、child materialize、crash/recovery 后保持 hard limit 与守恒不变量。
- Duplicate completion/signal/outbox/finalizer 不会重复发布 output、解析 edge、创建 child、写 cut 或推进 workflow。
- Recovery 能覆盖 snapshot/compile/materialize、attempt preparation/execution/evaluation、wait、child scope、route resolution、cut、compensation 和 outbox lease。
- 普通 node 不写共享 workflow context；只有 root coordinator 一次性提交受信任 output key。
- Transition history 与 checkpoint unique key 证明 root cut 只推进一次；checkpoint 的 nullable root plan、Run Manifest、ledger、close/cut/output hashes 能定位完整动态执行历史。
- Workbench 展示 scope tree、DAG、edge resolution、input seal、attempt/wait、ledger、candidate 和 completion cut，并用 expected version fencing 操作。
- Domain recipe 能组合完整 graph 能力而无需修改 core runtime。
