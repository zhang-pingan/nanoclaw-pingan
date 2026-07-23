# Icarus 评估与自进化框架技术方案

> **状态**：方案讨论稿
> **实施前置**：[Dynamic Workflow Graph Runtime](./dynamic-workflow-dag-framework.md) 已完整实现并通过 Production Activation Gate
> **范围**：Icarus Core、独立 Agent 执行链路、Core-owned Workflow，以及由一个或多个 Workflow 组成的 Feature Package

## 导航

- [背景与目标](#背景与目标)
- [已确认架构决策](#已确认架构决策)
- [评估对象模型](#评估对象模型)
- [总体架构](#总体架构)
- [核心对象与不变量](#核心对象与不变量)
- [数据集体系](#数据集体系)
- [执行适配器与回放](#执行适配器与回放)
- [实验与对比](#实验与对比)
- [Evaluator 与指标体系](#evaluator-与指标体系)
- [领域扩展合同](#领域扩展合同)
- [自进化闭环](#自进化闭环)
- [触发与单能力调用](#触发与单能力调用)
- [持久化与模块边界](#持久化与模块边界)
- [权限、安全与副作用隔离](#权限安全与副作用隔离)
- [API、CLI 与产品界面](#apicli-与产品界面)
- [测试策略](#测试策略)
- [实施顺序](#实施顺序)
- [验收标准](#验收标准)
- [待确认决策](#待确认决策)

## 背景与目标

Icarus 需要建立一套统一的评估与自进化框架，使 Core 和 Feature 的执行质量可以持续测量、定位、优化和验证。框架既要支持定时发现问题并生成候选，也要支持开发者手动修改某个 Prompt、Skill 或 Workflow 后，单独运行一次 baseline/candidate 对比。

评估对象覆盖：

1. Icarus Core 主服务整体执行链路，包括群聊、私聊、直接 Agent 对话、路由、上下文、记忆、模型选择、工具调用、容器执行、渠道响应和人工交互。
2. Icarus Core Dynamic Workflow Runtime，包括编译、调度、状态推进、恢复、等待、重试、质量修订、完成、预算、权限和副作用协议。
3. Core-owned Workflow 的流程设计和执行效果。
4. Feature-owned Workflow 的运行实现、Workflow 拓扑、Prompt、Skill、Policy、Model 和 Tool Binding。

本方案中的 Feature 不拥有第二套执行框架。就可执行评估对象而言，一个 Feature 是一个或多个 Published Recipe/Workflow 及其领域资源、数据集、Evaluator 和指标定义的集合，全部通过通用 Dynamic Workflow Runtime 执行。Feature 的 API、导航、Renderer 和领域 Projection 仍由 Feature Package Runtime 管理，但它们不形成新的执行 Adapter；Feature Package Runtime 本身的加载、隔离和权限正确性归 Core Conformance 评估。

### 目标

- 建立统一、版本化、可重放的数据集和案例合同。
- 对 baseline 与 candidate 执行同案例成对回放，并输出可解释的多维指标差异。
- 支持独立 Agent 与 Workflow 两类正式执行入口。
- 支持 Core、Feature、Workflow、Prompt、Skill、Executor、Policy、Model 和 Tool 配置的精确版本比较。
- 支持确定性检查、业务规则、LLM Judge、人工评价和真实结果信号的组合评估。
- 允许 Feature 通过受约束、版本化的通用合同接入领域信号、候选约束、发布依赖闭包和推荐触发配置，而不创建 Feature-specific 评估引擎。
- 建立从问题发现、归因、候选生成、评估、审批、发布、观察到回滚的完整自进化闭环。
- 所有阶段既可被完整闭环编排，也可通过 API/CLI/UI 单独调用。
- 在本地、小样本、模型非确定性的条件下提供可靠的成对比较和退化门禁。
- 保证实验不会向真实渠道发送消息、修改真实领域数据或重复执行外部副作用。

### 非目标

- 不实现在线大流量分桶实验平台。
- 不把经典线上 A/B Test 的显著性检验生搬到本地小样本环境。
- 不允许自进化直接修改 active Registry pointer、运行中 Workflow Snapshot 或 Feature 安装目录。
- 不用单个加权总分替代安全、正确性和关键场景门禁。
- 不让 Feature 自己实现另一套回放、实验调度或指标存储系统。
- 不让 Feature 直接写 Evaluation Store、执行 active pointer 切换、注册任意发布脚本或以领域扩展绕过 Candidate/Promotion hard gate。
- 不让 LLM Judge 成为安全、权限、Schema、幂等或副作用正确性的唯一判断者。

## 已确认架构决策

### 1. Dynamic Workflow Runtime 是实施前置

本框架真正实施时，`dynamic-workflow-dag-framework.md` 已经完成。`WorkflowAdapter` 直接依赖正式的 Registry、Recipe、Definition、Compiled Plan、Run Snapshot、Value/Blob、Attempt、Artifact、Evaluator、Trace、Command Gateway、dry-run 和 test-only bootstrap 合同，不实现临时 Workflow 模拟器，也不兼容旧 Workflow。

### 2. 只有两类业务执行适配器

```text
Evaluation Execution Adapters
  - StandaloneAgentAdapter
  - WorkflowAdapter
      - Core-owned Workflow
      - Feature-owned Workflow x N
```

Feature 不是第三类 Adapter。Feature 通过一个或多个 Workflow/Recipe 使用同一个 `WorkflowAdapter`。Feature-specific 的差异由精确 resource refs、Dataset、Evaluator 和 Metric Suite 表达。

### 3. Core Runtime Conformance Harness 不是业务 Adapter

Workflow Runtime 自身的状态机正确性、事务恢复、故障注入、Compiler Golden、Reference Model 和 SQLite benchmark 由独立 `RuntimeConformanceHarness` 执行。它属于 Core 测试与评估基础设施，不暴露为第三类业务执行入口。

### 4. 评估事实与执行事实分离

- Workflow 执行事实仍由 `workflow-runtime.db` 和通用 Trace Store 管理。
- 评估 Dataset、Case、Experiment、Variant、Observation、Metric、Comparison 和 Evolution 证据由独立 Evaluation Store 管理。
- Evaluation Store 不能直接写 Workflow Runtime DB。
- Workflow Runtime 的 Artifact/Trace 可作为来源，但进入 Dataset 的案例必须复制为 Evaluation Store 自己持有的 immutable snapshot，避免 Runtime retention 使数据集失效。

### 5. 评估服务独立，自进化使用 Workflow 编排

Dataset 构建、Replay、Evaluator、Metric、Comparison、Candidate Builder 和 Promotion Gateway 都是可独立调用的服务能力。完整自进化流程使用 Core-owned Dynamic Workflow 编排这些能力，不再创建另一套通用编排状态机。

评估 Core Runtime candidate 时，自进化 Workflow 运行在稳定 active Core 上，通过隔离 runner 启动 baseline/candidate Core Bundle。被评估的 candidate 不能承载自己的评估控制面。

`Evaluation Experiment` 是独立的一等能力，`Evolution Campaign` 只是它的可选自动编排消费者。任何 Candidate 都必须能够脱离 Campaign，直接通过 `stage -> validate -> experiment -> report` 完成一次可重放的 baseline/candidate 对比；Promotion 仍是评估完成后的可选后续动作，不能隐含在 Experiment 中。

### 6. A/B Test 固定为 Paired Replay Experiment

本项目的 A/B Test 指同一组 case 在尽可能相同的输入、环境、工具响应和预算下分别运行 baseline 与 candidate，然后按 case 做成对比较。它不依赖真实用户流量分桶。

### 7. 发布与评估解耦

Candidate 可以是 staged、不可生产执行的 Evaluation Variant。通过评估只表示满足 Promotion Policy，不等于已经 Published 或 Activated。最终发布必须继续走 Dynamic Workflow Runtime 已定义的 review/publish/activate、Local Prompt Promotion、Feature Release 或 Core Release 流程。

### 8. 领域差异通过通用闭合合同接入

Feature-specific 的真实结果信号、文件或数据库事实源、候选不可修改区域、依赖闭包发布顺序和默认触发建议，不得散落为 Feature-owned scheduler、Candidate Builder、Promotion Gateway 或 Evaluation Store writer。Core 提供统一的 `DomainSignalSource`、`CandidateConstraint`、`PromotionBinding` 和 `EvaluationTriggerTemplate` 合同；Feature 只能发布 exact ref/hash 的声明和受限实现资源。

这些扩展资源只定义“领域语义和约束”，不取得以下控制权：

- 不创建 Experiment、Campaign 或 Trigger runtime state。
- 不直接接受或写入 Evaluation Store 内部对象。
- 不决定 Promotion Eligibility，也不降低 Core hard gate。
- 不直接 Publish/Activate；发布仍由 Core Promotion Gateway 调用正式 Publisher。
- 不读取其他 owner 的信号、Dataset、Candidate 或发布目标。

## 评估对象模型

评估对象不使用单层目录树，而使用三个正交维度。

### 所有权

```ts
type EvaluationOwner =
  | { kind: 'core'; core_release_ref: VersionedRef; core_build_hash: string }
  | {
      kind: 'feature';
      feature_release_ref: VersionedRef;
      feature_release_hash: string;
    };
```

### 执行形态

```ts
type EvaluationSurface = 'standalone_agent' | 'workflow';
```

### 变更层

```ts
type EvaluationChangeLayer =
  | 'runtime_implementation'
  | 'workflow_topology'
  | 'prompt'
  | 'skill'
  | 'policy'
  | 'model'
  | 'tool_binding'
  | 'evaluator'
  | 'composite';
```

`composite` 只能在变更存在不可分割依赖时使用，并必须列出全部 member diff。默认一个 Candidate 只验证一个优化假设和一个主要变更层，以提高归因可信度。

### 对象映射

| 评估对象 | 执行入口 | 主要 Snapshot |
| --- | --- | --- |
| Core 群聊/私聊/直接 Agent 链路 | `StandaloneAgentAdapter` | Core Bundle、链路配置、Prompt、Skill、Model、Tool、Memory/Context Policy |
| Core-owned Workflow 效果 | `WorkflowAdapter` | Recipe、Definition、Registry Closure、Execution Policy、Prompt/Skill/Capability refs |
| Core Workflow Runtime 正确性 | `RuntimeConformanceHarness` | Core Bundle、Protocol、ABI、DDL、SQLite Profile、Golden/Model/Fault Suite |
| Feature 运行实现 | `WorkflowAdapter` | Feature Execution Artifact、Executor Implementation、Capability 和依赖闭包 |
| Feature 流程设计 | `WorkflowAdapter` | Recipe、Definition、Graph Template、Policy、Artifact/Evaluator Contract |
| Feature Prompt/Skill | `WorkflowAdapter` | Prompt exact ref/hash、Capability `skill_refs` 和 dependency closure |

### EvaluationSubject

```ts
interface EvaluationSubjectV1 {
  format: 'icarus.evaluation-subject/1';
  ref: VersionedRef;
  owner: EvaluationOwner;
  surface: EvaluationSurface;
  change_layers: EvaluationChangeLayer[];

  standalone?: {
    chain_profile_ref: VersionedRef;
    entrypoint_ref: string;
  };

  workflow?: {
    recipe_ref: VersionedRef;
    recipe_hash: string;
    entrypoint: string;
  };

  supported_case_schema_ref: VersionedRef;
  supported_observation_schema_ref: VersionedRef;
  default_metric_suite_ref: VersionedRef;
  default_evaluator_suite_ref: VersionedRef;
  default_candidate_constraint_refs: VersionedRef[];
  default_promotion_binding_ref: VersionedRef | null;
  default_trigger_template_refs: VersionedRef[];
  subject_hash: string;
}
```

顶层与嵌套对象均为 closed schema。`surface='workflow'` 时必须存在 `workflow` 且 `standalone=null`；`standalone_agent` 反之。

## 总体架构

```text
Real Trace / Human Case / Incident / Synthetic Generator
Domain Signal Source / Feature-supplied Seed
                         |
                         v
       Signal Ingestion + Dataset Builder + Redaction
                         |
                         v
                Immutable Dataset Version
                         |
                         v
     Experiment Spec -> Variant Resolver -> Run Matrix
                         |
              +----------+----------+
              |                     |
              v                     v
    StandaloneAgentAdapter     WorkflowAdapter
              |                     |
              +----------+----------+
                         v
              Observation Normalizer
                         |
                         v
      Deterministic / Domain / LLM / Human Evaluators
                         |
                         v
              Metrics + Paired Comparison
                         |
                         v
         Report + Promotion Eligibility Decision
                         |
             +-----------+-----------+
             |                       |
             v                       v
      Manual inspection       Self-evolution Workflow
                                     |
                                     v
                      Publish / Reject / Rollback / Monitor
```

### 组件职责

| 组件 | 职责 |
| --- | --- |
| Subject Registry | 定义可评估对象及其 case/observation/evaluator 合同 |
| Dataset Registry | Dataset、Case、Slice、Partition、来源、脱敏和版本治理 |
| Domain Signal Ingestion | 通过受限只读 source、cursor、dedupe、redaction 和 provenance 合同导入领域 Evidence、Case seed 和 observed outcome |
| Variant Resolver | 解析 baseline/candidate 的 exact refs、hash、Core Bundle 和环境闭包 |
| Experiment Planner | 生成 case x variant x repetition 的固定 Run Matrix |
| Replay Coordinator | lease、预算、并发、顺序随机化、失败恢复和清理 |
| StandaloneAgentAdapter | 隔离运行非 Workflow Agent 链路并产生标准 Observation |
| WorkflowAdapter | 通过正式 dry-run/evaluation execution surface 运行 Core/Feature Workflow |
| RuntimeConformanceHarness | 评估 Core Workflow Runtime 的合同、模型、故障和性能 |
| Observation Store | 保存输入、输出、Trace、Artifact、usage、failure 和 effect 摘要 |
| Evaluator Registry | 版本化外部评估器和组合 Suite |
| Metric Engine | 从 Observation/Evaluation 计算可比较指标 |
| Comparison Engine | 成对差值、切片结果、退化检测、不确定性和决策 |
| Candidate Builder | 生成 staged Candidate，并执行 Core 与 owner-scoped Candidate Constraint，不切换 active pointer |
| Promotion Bundle Planner | 根据 Promotion Binding 解析待发布依赖闭包、authoring commit、inactive publish 和 activation intents |
| Promotion Gateway | 消费 sealed Report、Constraint Result 和 Promotion Bundle，通过正式 Publisher 完成发布/激活 |
| Evaluation Center | Dataset、Experiment、Report、Evolution 和审计产品入口 |

## 核心对象与不变量

### 核心对象

```text
Evaluation Subject
  -> Domain Signal Source
      -> Signal Import Batch
          -> Evidence / Case Seed / Observed Outcome
  -> Dataset
      -> Dataset Version
          -> Evaluation Case Snapshot
  -> Experiment
      -> Baseline Variant
      -> Candidate Variant(s)
      -> Planned Run Matrix
          -> Evaluation Run
              -> Observation
              -> Evaluator Result
              -> Metric Value
      -> Comparison Report
      -> Promotion Decision

Evolution Campaign
  -> Evidence Window
  -> Diagnosis
  -> Optimization Hypothesis
  -> Candidate
  -> Experiment(s)
  -> Promotion / Rejection / Rollback
```

### 核心不变量

1. Dataset Version sealed 后不可修改；Case 内容、Slice、Oracle、Fixture 和 hash 全部冻结。
2. Experiment seal 后 baseline、candidate、dataset、evaluator、metric、budget、repetition、order seed 和 environment 不可修改。
3. Variant 必须解析为 exact ref/hash 或 content-addressed staged artifact；执行期间不读取 `latest`、当前工作区或 active pointer。
4. 同一 `(experiment_id, case_id, variant_id, repetition_no)` 最多产生一个 accepted terminal Observation；物理执行可重试，逻辑结果不能分叉。
5. Baseline 与 candidate 使用相同 Case Snapshot、Fixture Bundle、预算和 Evaluation Policy；任何不对称必须在报告中标记 invalid 或 incomparable。
6. 缺失、超时、Adapter 崩溃和 Evaluator 失败不能被静默过滤；按 Metric missing policy 计为失败、缺失或使实验 inconclusive。
7. 安全、权限、Schema、幂等和副作用合同由确定性 Evaluator 判定，不能被 LLM 分数覆盖。
8. In-workflow Quality Evaluator 属于被评估 Subject Snapshot；Experiment Evaluator 位于 Subject 外部，不能改变被评估 Run 的控制流。
9. Candidate Builder 无权直接 Publish/Activate；Promotion Gateway 只消费 sealed Comparison Report 和 Human Review/Policy decision。
10. Feature 不能注册自己的实验调度器、Candidate Builder、Promotion Gateway 或 Evaluation Store writer，只能发布受约束的 Subject、Dataset seed、Domain Signal Source、Evaluator、Metric、Candidate Constraint、Promotion Binding 和 Trigger Template。
11. 回放默认禁止真实外部副作用；任何允许的 live read 或 approved effect 都必须在 Experiment Spec 中显式声明并进入报告。
12. Evaluation raw data、Prompt、Trace 和 Artifact 遵守 sensitivity、redaction、retention 和容量合同；Credential 原文永不进入 Evaluation Store。
13. 自进化使用的优化集与最终 holdout 分离；Candidate Generator 不获得 locked holdout 的 case 内容或逐 case反馈。
14. Promotion 后继续固定 baseline/candidate refs；历史 Report 不因新版本发布而重新计算或改变结论。
15. 评估 Core candidate 时，控制面运行在稳定 active Core；candidate runner 无法写控制面 Evaluation Store，只能通过受限结果协议返回 Observation。
16. Domain Signal Source 只能通过声明的只读 capability 和 file/data scope 读取 owner 自己的数据；只有 Evaluation control service 可以把规范化结果写入 Evaluation Store。
17. Candidate Constraint 必须在 Candidate seal、Experiment seal 和 Promotion preflight 三个边界使用相同 exact ref/hash 重放；任何失败都不能被总分或人工普通批准覆盖。
18. Promotion Bundle 允许产生 inactive immutable publication，但在全部成员、依赖闭包和 receipt 验证完成前不得改变任何 production ingress 可见的 active catalog root；发布崩溃恢复必须复用相同 bundle id 和 operation key。

## 版本与快照

### EvaluationVariant

```ts
interface EvaluationVariantV1 {
  format: 'icarus.evaluation-variant/1';
  ref: VersionedRef;
  subject_ref: VersionedRef;
  role: 'baseline' | 'candidate';

  core_runtime_bundle: {
    core_release_ref: VersionedRef;
    core_build_hash: string;
    runtime_distribution_ref: VersionedRef;
    runtime_distribution_hash: string;
    protocol_major: number;
    executor_abi_major: number;
    database_schema_hash: string;
  };

  published_snapshot_ref: string | null;
  published_snapshot_hash: string | null;
  staged_overlay_ref: string | null;
  staged_overlay_hash: string | null;

  model_profile_ref: VersionedRef;
  tool_fixture_policy_ref: VersionedRef;
  environment_manifest_ref: string;
  environment_manifest_hash: string;
  dependency_closure_ref: string;
  dependency_closure_hash: string;
  candidate_constraint_closure_ref: string | null;
  candidate_constraint_closure_hash: string | null;
  candidate_constraint_result_refs: string[];
  variant_hash: string;
}
```

`published_snapshot_*` 与 `staged_overlay_*` exactly one。`role='candidate'` 时必须固定 Candidate Constraint closure 和 build-phase result；baseline 对应字段为空。Candidate 可以使用 staged overlay，但 overlay 只能装载到隔离 evaluation root，production Registry 和普通 ingress 必须拒绝。

### StagedVariantOverlay

Overlay 只表达相对 baseline 的 closed diff：

```ts
interface StagedVariantOverlayV1 {
  format: 'icarus.evaluation-variant-overlay/1';
  base_snapshot_ref: string;
  base_snapshot_hash: string;
  hypothesis_ref: string;
  changes: Array<
    | { kind: 'prompt'; base_ref: VersionedRef; candidate_ref: string; candidate_hash: string }
    | { kind: 'skill'; base_ref: VersionedRef; candidate_ref: string; candidate_hash: string }
    | { kind: 'workflow_resource'; resource_kind: string; base_ref: VersionedRef; candidate_ref: string; candidate_hash: string }
    | { kind: 'execution_artifact'; base_ref: VersionedRef; candidate_ref: string; candidate_hash: string }
    | { kind: 'core_bundle'; base_build_hash: string; candidate_build_hash: string }
  >;
  changed_dependency_closure_ref: string;
  changed_dependency_closure_hash: string;
  overlay_hash: string;
}
```

Overlay 发布前必须通过与正式 Publisher 相同的 Schema、dependency closure、permission/effect、ABI 和 ownership 校验。Evaluation 通过不能替代正式 Publish 校验。

## 数据集体系

### Dataset 类型

```ts
type DatasetPurpose =
  | 'discovery'
  | 'optimization'
  | 'validation'
  | 'regression_holdout'
  | 'conformance'
  | 'benchmark';
```

- `discovery`：用于发现高频失败和优化方向，可以持续追加并发布新版本。
- `optimization`：Candidate Generator 可见，用于迭代候选。
- `validation`：用于候选比较，允许返回逐 case 诊断。
- `regression_holdout`：最终门禁，Candidate Generator 不可见；默认只返回汇总结论和被允许披露的稳定 reason code。
- `conformance`：协议、不变量、故障和安全案例。
- `benchmark`：固定机器等级、负载形状和性能预算。

### Case 来源

```ts
type EvaluationCaseOrigin =
  | 'human_authored'
  | 'production_trace_derived'
  | 'incident_regression'
  | 'synthetic_generated'
  | 'property_counterexample'
  | 'feature_supplied';
```

真实 Trace 不能直接成为可执行 Case。Dataset Builder 必须完成：

1. 选择允许采集的输入、上下文、输出、Artifact 和 Tool/Effect facts。
2. 删除 Credential、Token、Cookie、个人敏感信息和无关会话内容。
3. 把外部依赖转换为 immutable Fixture、read-only snapshot 或明确的 live dependency contract。
4. 生成 Case schema、provenance、sensitivity、replayability 和内容 hash。
5. 经人工或策略审查后写入新的 Dataset Version。

### EvaluationCase

```ts
interface EvaluationCaseV1 {
  format: 'icarus.evaluation-case/1';
  case_id: string;
  case_version: number;
  subject_ref: VersionedRef;
  origin: EvaluationCaseOrigin;
  origin_ref: string | null;

  input_ref: string;
  input_hash: string;
  initial_context_ref: string | null;
  initial_context_hash: string | null;
  fixture_bundle_ref: string;
  fixture_bundle_hash: string;

  oracle_ref: string | null;
  oracle_hash: string | null;
  rubric_ref: VersionedRef | null;
  slice_keys: string[];
  difficulty: 'smoke' | 'normal' | 'hard' | 'adversarial';
  sensitivity: 'public' | 'internal' | 'sensitive';
  replayability: 'deterministic' | 'model_nondeterministic' | 'live_dependency';

  max_input_bytes: number;
  max_output_bytes: number;
  case_hash: string;
}
```

### Fixture Bundle

Fixture Bundle 可以包含：

- Tool/MCP 请求到响应的确定性映射。
- 只读文件树 snapshot。
- Memory/Knowledge 检索结果 snapshot。
- Clock、timezone、locale 和随机 seed。
- Model stub 或允许的真实 Model Profile。
- 外部 effect 的 simulated receipt。
- Workflow signal、timer、approval 和 failure injection schedule。

未命中的 Tool/MCP/effect 请求默认 `fixture_miss` 并使 case 失败，不允许静默访问真实环境。

### Slice

所有 Case 至少具有：

- `surface/*`：standalone 或 workflow。
- `owner/core` 或 `owner/feature/<featureId>`。
- `capability/*` 或 `recipe/*`。
- `risk/*`。
- `origin/*`。
- `difficulty/*`。

Feature 可以增加领域 Slice，但不能覆盖保留 namespace。Comparison 必须同时报告 overall 和声明为 critical 的 Slice，避免总体平均值掩盖关键场景退化。

### 数据污染防护

- Dataset Version 记录 Candidate 可见级别。
- `regression_holdout` 的 case bytes 只对 Evaluation Runner 可见。
- Candidate Generator 不能读取 holdout input、expected output、逐 case judge text 或 Trace。
- 同一来源被派生进多个 partition 时按 `origin_ref/content_similarity_hash` 去重。
- 每次失败转成回归 Case 时发布新 Dataset Version，不修改旧实验使用的版本。

## 执行适配器与回放

### 统一 Adapter 合同

```ts
interface EvaluationExecutionAdapter {
  readonly kind: 'standalone_agent' | 'workflow';

  validate(input: AdapterValidationInput): Promise<AdapterValidationResult>;
  prepare(input: AdapterPrepareInput): Promise<PreparedEvaluationRun>;
  execute(input: AdapterExecuteInput): Promise<RawEvaluationResult>;
  collect(input: AdapterCollectInput): Promise<EvaluationObservationV1>;
  cleanup(input: AdapterCleanupInput): Promise<void>;
}
```

Adapter 不能计算最终 Promotion Decision，也不能根据 variant 身份修改执行行为。`collect` 必须输出统一 Observation，并保留 Adapter-specific typed extension。

### EvaluationObservation

两个 Adapter 必须收敛到同一标准 Observation。指标与外部 Evaluator 只依赖标准字段或显式声明的 typed extension，不能解析 Adapter 私有日志文本。

```ts
interface EvaluationObservationV1 {
  format: 'icarus.evaluation-observation/1';
  observation_id: string;
  experiment_id: string;
  planned_run_id: string;
  case_id: string;
  variant_ref: VersionedRef;
  repetition_no: number;
  sampling_seed: string;

  subject_outcome:
    | 'succeeded'
    | 'failed'
    | 'timeout'
    | 'cancelled'
    | 'action_required';
  subject_failure_code: string | null;
  infrastructure_status: 'ok' | 'degraded';
  infrastructure_reason_codes: string[];

  output_ref: string | null;
  output_hash: string | null;
  artifact_manifest_ref: string | null;
  artifact_manifest_hash: string | null;
  trace_export_ref: string;
  trace_export_hash: string;
  effect_summary_ref: string;
  effect_summary_hash: string;

  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    model_requests: number | null;
    tool_calls: number | null;
    failed_tool_calls: number | null;
    attempts: number | null;
    estimated_cost_micros: number | null;
    cost_profile_ref: VersionedRef | null;
  };

  timing: {
    queued_ms: number | null;
    execution_ms: number | null;
    first_output_ms: number | null;
    evaluator_excluded_ms: number | null;
  };

  interaction: {
    clarification_turns: number;
    human_review_requests: number;
    revision_attempts: number;
  };

  standalone_extension_ref: string | null;
  workflow_extension_ref: string | null;
  observation_hash: string;
}
```

`standalone_extension_ref` 与 `workflow_extension_ref` 按 Subject surface exactly one。Workflow extension 至少保存 Workflow/Activation/Run/Scope/Node/Attempt correlation、completion outcome、critical path、wait/retry/revision 和 ledger summary；Standalone extension 至少保存 conversation/message/agent execution correlation、routing、context/memory、model selection 和 response rendering summary。

`subject_outcome` 描述被评估对象的行为，`infrastructure_status` 描述评估设施是否可信。Runner 崩溃且没有形成可验证 Subject 结果时不伪造 Observation，而是在 Planned Run 上记录 infrastructure failure；存在完整 Subject 结果但部分非必要 Trace 丢失时可以生成 `degraded` Observation，由 Experiment missing policy 决定是否可比较。

### StandaloneAgentAdapter

覆盖非 Workflow 链路：

```text
frozen inbound message
  -> routing / group selection
  -> context + memory pack
  -> model selection
  -> container agent execution
  -> tool/MCP/file operations through fixture broker
  -> response rendering
  -> normalized observation
```

必须固定或记录：

- Core Bundle 与 entrypoint。
- channel/group/conversation fixture，不向真实 channel 回发。
- system prompt、task prompt、Skill、Model、Tool、Mount 和 Memory hashes。
- Model request/response、usage 和 latency。
- Tool call、file change、artifact、failure taxonomy 和 output。
- ask-user/card 等交互输出，但不创建真实待办或发送真实卡片。

现有 `agent_queries`/Trace 中的 `prompt_hash`、`memory_pack_hash`、`tools_hash`、`mounts_hash`、token、latency、tool call、artifact 和 failure 字段可以作为 Observation 来源，但 Evaluation Adapter 必须补齐 exact Variant 和 Case correlation。

### WorkflowAdapter

覆盖所有 Core-owned 和 Feature-owned Workflow：

```text
sealed Evaluation Case
  -> resolve Recipe/Definition/Registry closure
  -> build isolated dry-run/evaluation root
  -> install published snapshot or staged overlay
  -> create dry-run-scoped Task Intake / Workflow
  -> execute through real Graph Runtime
  -> inject fixture signal/tool/effect/model results
  -> wait for terminal/cancel/budget outcome
  -> export Run/Scope/Node/Attempt/Artifact/Evaluation/Trace bundle
  -> normalized observation
```

必须满足：

- 使用正式 Compiler、Store、Reconciler、Scheduler、Attempt、Quality Gate、Wait、Close/Cut 和 Recovery 语义。
- 使用正式 authoring dry-run/evaluation execution contract；`test_only` synthetic Recipe 的 production launchability 规则保持不变，不把 Feature 的真实 Recipe 重标记为 test-only。
- 每个 Evaluation Run 使用独立 data/store root；baseline 与 candidate 不共享可变 DB、workspace 或 cache。
- Production ingress、Feature API、Automation、真实 channel 和真实 effect adapter 全部关闭。
- Feature 通过 `feature_release_ref + recipe_ref` 接入，同一 Feature 可以声明任意多个 Workflow Subject。
- Staged candidate 只进入隔离 Registry namespace，不进入 production Registry。
- 运行结果携带完整 Workflow correlation，但不能写入 production Runtime Center Projection。

### RuntimeConformanceHarness

覆盖：

- Contract Pack、strict JSON、canonical hash 和 Compiler Golden。
- 独立 Reference Model 与 property/model-based event sequence。
- T0-T8、retry、quality revision、wait、child、close/cut、outbox、claim 和 recovery fault injection。
- SQLite Supported Limits 与固定机器等级 benchmark。
- Core Bundle、Protocol、ABI、DDL、native module 和 managed Node identity。

Core Runtime candidate 必须同时通过 Conformance Harness 和代表性 Workflow Dataset。Conformance 通过只能证明协议正确，不能证明业务质量；业务评估通过也不能覆盖协议失败。

### 回放级别

```ts
type ReplayMode =
  | 'deterministic_fixture'
  | 'sandbox_model'
  | 'live_readonly_dependency';
```

- `deterministic_fixture`：Model/Tool/Effect 全部 fixture，适合 Runtime、路由和确定性回归。
- `sandbox_model`：允许真实模型调用，Tool/Effect 默认 fixture，适合 Prompt、Skill 和 Workflow 质量评估。
- `live_readonly_dependency`：只允许白名单 read-only 外部数据，必须记录响应 snapshot；用于无法 fixture 的时效性场景。

第一版禁止 evaluation 中的 live mutation。需要验证 mutation 的 case 使用 shadow workspace、Fake Adapter 和 simulated receipt。

### 非确定性控制

- 固定 Model exact id、参数、tool schema、system fingerprint 和超时策略。
- 同一 case/variant 支持 `repetitions > 1`。
- 当 Metric Suite 包含 `pass@k` 时，必须满足 `repetitions >= k`；每个 repetition 是独立采样，Workflow/Adapter 内部的 `attempts`、retry 或 quality revision 不计为外部采样。
- baseline/candidate 执行顺序由 sealed seed 随机化，可使用 AB/BA 或 ABBA 顺序降低时间漂移。
- live dependency case 必须尽可能在同一 captured snapshot 上运行；不能共享 snapshot 时标记 `incomparable_live_drift`。
- 报告同时展示中心趋势和运行间波动，不把单次幸运结果作为提升证据。

## 实验与对比

### Experiment Spec

```ts
interface PairedReplayExperimentSpecV1 {
  format: 'icarus.paired-replay-experiment/1';
  experiment_id: string;
  subject_ref: VersionedRef;
  dataset_ref: VersionedRef;
  dataset_hash: string;

  baseline_variant_ref: VersionedRef;
  candidate_variant_refs: VersionedRef[];
  evaluator_suite_ref: VersionedRef;
  metric_suite_ref: VersionedRef;
  promotion_policy_ref: VersionedRef;

  replay_mode: ReplayMode;
  repetitions: number;
  order_seed: string;
  concurrency: number;
  budget_ref: VersionedRef;
  isolation_profile_ref: VersionedRef;

  required_slice_keys: string[];
  critical_slice_keys: string[];
  experiment_hash: string;
}
```

第一版支持一个 baseline 对一个或多个 candidate，但 Comparison 和 Promotion Decision 始终逐 candidate 与 baseline 比较，不能通过多候选挑选后仍沿用未经校正的置信结论。大量候选搜索使用 optimization Dataset，最终只允许有限候选进入 validation/holdout。

### 状态

```text
draft
  -> validated
  -> sealed
  -> queued
  -> running
  -> evaluating
  -> comparing
  -> completed

queued/running/evaluating/comparing
  -> failed | cancelled
```

`failed` 表示实验基础设施或合同失败；Candidate 的质量差使用 completed report 中的 `reject`，不能混成实验失败。

### Run Matrix

Experiment seal 时一次性生成：

```text
case_id x variant_id x repetition_no -> planned_run_id + execution_order
```

恢复只能继续未完成 planned run。改变 case、variant、repetition、seed 或预算必须创建新 Experiment。

### Comparison Result

```ts
type ComparisonDecision =
  | 'promotable'
  | 'reject'
  | 'inconclusive'
  | 'invalid';

interface CandidateComparisonV1 {
  baseline_variant_ref: VersionedRef;
  candidate_variant_ref: VersionedRef;
  case_count: number;
  paired_case_count: number;
  win_count: number;
  tie_count: number;
  loss_count: number;
  critical_regressions: number;
  metric_deltas: MetricDelta[];
  slice_results: SliceComparison[];
  uncertainty: ComparisonUncertainty;
  hard_gate_results: HardGateResult[];
  decision: ComparisonDecision;
  reason_codes: string[];
  report_hash: string;
}
```

### 小样本决策原则

本地少量样本下不以 `p < 0.05` 作为唯一门禁。固定使用：

1. 逐 case paired delta，而不是两个独立均值。
2. win/tie/loss 和 critical regression 列表。
3. median、trimmed mean、p90/p95 等稳健摘要。
4. paired bootstrap interval，作为不确定性描述而不是伪造大样本保证。
5. 二值结果可补充 exact McNemar/sign test，但仍需满足 practical threshold。
6. 最小实际改善阈值、最大允许退化和 critical Slice 零退化门禁。
7. 模型非确定性场景报告 case 内重复波动。
8. `pass@k` 使用 case-level 聚合和 paired bootstrap；不能把 repetition 当成独立 case，也不能用更高的 `k` 掩盖 `pass@1` 退化。

Candidate 只有同时满足全部 hard gates、覆盖要求和 Promotion Policy 才为 `promotable`。总体均分提高不能抵消安全失败或 critical Slice 退化。

## Evaluator 与指标体系

### 两类 Evaluator 必须分开

1. **Execution Evaluator**：Subject 自己的 Workflow Node Quality Gate，可能决定 `pass/needs_revision/fail`，属于 Variant Snapshot。
2. **Experiment Evaluator**：运行结束后从外部评价 Observation，不得影响 Subject 执行，属于 Experiment Spec。

同一个 Evaluator 实现可以共享纯函数库，但发布 ref、调用身份、输入合同和结果存储必须区分。

### Experiment Evaluator 类型

```ts
type ExperimentEvaluatorKind =
  | 'deterministic_contract'
  | 'reference_oracle'
  | 'domain_rule'
  | 'llm_rubric'
  | 'llm_pairwise_judge'
  | 'human_review'
  | 'observed_outcome';
```

- `deterministic_contract`：Schema、Artifact、权限、Trace、effect、路径和不变量。
- `reference_oracle`：与 expected value、reference model 或 golden artifact 比较。
- `domain_rule`：Feature 发布的领域逻辑，必须是版本化 closed input/output。
- `llm_rubric`：对单个结果按 rubric 评分。
- `llm_pairwise_judge`：盲化比较 baseline/candidate，展示顺序随机化。
- `human_review`：结构化人工标签和理由。
- `observed_outcome`：用户纠正、任务完成、采纳、返工等真实结果信号。

### LLM Judge 约束

- 固定 Judge Model、Prompt、Rubric、temperature、output schema 和版本 hash。
- Judge 输入隐藏 baseline/candidate 身份和版本说明。
- Pairwise Judge 随机交换 A/B 顺序并检测 position bias。
- Judge 先通过人工标注 calibration set，记录一致率和已知失效 Slice。
- Judge failure、invalid JSON 或低置信不得自动当作 tie。
- 不用与 Candidate Generator 完全相同且未经校准的模型作为唯一 Judge。
- Judge 不能判定权限、安全、Schema、幂等或 effect correctness。

### Metric Definition

```ts
interface MetricDefinitionV1 {
  format: 'icarus.metric-definition/1';
  ref: VersionedRef;
  key: string;
  category:
    | 'quality'
    | 'reliability'
    | 'efficiency'
    | 'interaction'
    | 'safety'
    | 'observability'
    | 'workflow_structure';
  value_type: 'boolean' | 'integer' | 'micros' | 'duration_ms' | 'bytes';
  direction: 'higher_is_better' | 'lower_is_better' | 'target_range';
  aggregation: 'rate' | 'sum' | 'mean' | 'median' | 'p90' | 'p95' | 'paired_win_rate' | 'pass_at_k';
  pass_at_k: {
    k: number;
    success_evaluator_ref: VersionedRef;
    sampling_unit: 'repetition';
    sampling_scope: 'case_variant';
    estimator: 'empirical' | 'unbiased';
  } | null;
  missing_policy: 'fail' | 'exclude_and_report' | 'inconclusive';
  hard_gate: boolean;
  practical_improvement_micros: number | null;
  max_regression_micros: number | null;
  metric_hash: string;
}
```

浮点分数持久化为整数 micros；金额使用最小货币单位或 versioned cost unit，避免不可重放的 float canonicalization。

当 `aggregation='pass_at_k'` 时，`pass_at_k` 必须非空；其他聚合方式必须为 `null`。`pass@1` 使用同一聚合逻辑且 `k=1`，不实现单独的计算路径。对每个 `(case_id, variant_id)`，设实际独立采样数为 `n`、通过严格成功 Evaluator 的采样数为 `c`：

```text
pass@k = 1 - C(n-c, k) / C(n, k)
```

当恰好运行 `k` 次时，等价于“至少一次成功”的经验值；当 `n < k` 时，指标按 `missing_policy` 记为缺失或 `inconclusive`，不得静默降低 `k`。`pass@k` 的值是 `[0, 1]` 概率，使用整数 micros 持久化。成功判定必须来自 deterministic、reference 或 domain evaluator；LLM Judge 不能单独定义 hard pass。

`pass@k` 的比较在 case 层完成：先为每个 case 计算 baseline/candidate 的 pass@k，再做 paired delta、critical Slice 检查和 case-level bootstrap。报告必须同时展示 `n`、`c`、有效采样 seed、成本和延迟，避免把更多采样带来的成功率提升误解为单次执行质量提升。

上述字段必须在 Contract Pack seal 前纳入 `icarus.metric-definition/1`；如果该 major 已经发布，则必须发布新的 Metric Definition major，不能通过 closed schema 的 unknown field 旁路兼容。

### 通用指标

| 类别 | 指标示例 |
| --- | --- |
| 质量 | task success、`pass@1`、`pass@k`、correctness、completeness、rubric score、artifact contract pass |
| 可靠性 | timeout、crash、retry、failed tool、unresolved wait、duplicate effect、recovery success |
| 效率 | end-to-end latency、time-to-first-output、tokens、model calls、tool calls、attempts、cost |
| 交互 | clarification turns、unnecessary question、human intervention、user correction、abandonment |
| 安全 | permission violation、secret exposure、path escape、unauthorized effect、missing receipt |
| 可观测性 | Trace completeness、correlation integrity、failure classification、replay completeness |
| Workflow | critical path、idle wait、revision count、handoff loss、skipped/dead node、completion outcome |

### Feature 指标

Feature 不创建独立 Metric Engine，但可以发布：

- 领域成功条件。
- 领域 Artifact/Schema Evaluator。
- Feature-specific Slice。
- 业务质量 Metric Definition。
- Promotion Policy 的额外收紧条件。

Feature 不能降低 Core safety/reliability hard gate，也不能把缺失值配置为静默成功。

### 归因信号

诊断器至少区分：

```ts
type EvaluationFailureAttribution =
  | 'intake_or_routing'
  | 'context_or_memory'
  | 'model_selection'
  | 'prompt'
  | 'skill_or_tool_binding'
  | 'workflow_topology'
  | 'executor_implementation'
  | 'workflow_runtime'
  | 'external_dependency'
  | 'evaluator_instability'
  | 'dataset_or_fixture'
  | 'unknown';
```

归因是带证据的诊断结论，不是 Promotion hard fact。必须保存支持/反对证据、置信区间和未能排除的候选原因。

## 领域扩展合同

领域扩展的目标是让 Core 不理解每个 Feature 的文件、表、业务事件和发布拓扑，同时仍由 Core 统一掌握导入、评估、候选、审批、发布和审计控制面。所有扩展对象均使用 closed schema、exact `VersionedRef`、内容 hash、owner namespace 和 dependency closure 校验。

### Domain Signal Source

`DomainSignalSource` 把 Feature-owned 的追加日志、领域表、结构化文件、业务事件或只读 Projection 映射为 Evaluation 能消费的 Evidence、Case seed 或 observed outcome。它不是新的 Dataset Builder，也无权写 Evaluation Store。

```ts
interface DomainSignalSourceV1 {
  format: 'icarus.domain-signal-source/1';
  ref: VersionedRef;
  owner: EvaluationOwner;

  reader_capability_ref: VersionedRef;
  source_locator_policy_ref: VersionedRef;
  source_schema_ref: VersionedRef;
  normalized_signal_schema_ref: VersionedRef;
  mapping_ref: VersionedRef;
  redaction_policy_ref: VersionedRef;

  cursor_strategy: 'append_offset' | 'event_key' | 'snapshot_diff';
  dedupe_key_json_pointers: string[];
  emits: Array<'evidence' | 'case_seed' | 'observed_outcome'>;
  max_batch_records: number;
  max_batch_bytes: number;
  source_hash: string;
}
```

导入协议固定为：

```text
resolve exact source + reader capability
  -> read owner-scoped data with previous committed cursor
  -> snapshot source revision/hash
  -> strict parse + dedupe + redact
  -> run versioned mapping
  -> validate normalized signal schema
  -> Evaluation control service commits import batch and next cursor
  -> Dataset Builder / Evidence service consumes normalized refs
```

每次导入保存 immutable `SignalImportBatch`，至少包含 source ref/hash、before/after cursor、source revision、record keys、accepted/rejected counts、redaction result、normalized value refs 和 import operation key。同一 source revision、cursor window 和 mapping hash 重放必须返回相同 batch；同一 dedupe key 不得生成两个 accepted logical signal。

`reader_capability_ref` 必须是无 mutation、无任意路径、无任意 SQL 的 typed read capability。Feature 不能把 source locator、查询字符串或脚本路径作为未校验自由文本交给 runner，也不能通过 mapping 返回 Credential、active pointer mutation 或跨 owner 引用。

### Candidate Constraint

`CandidateConstraint` 表达某类 Candidate 的领域不变量，例如受保护区域、必需段落、Schema、命名约束、dependency allowlist、base hash 前置条件或确定性 lint。它补充 Core hard gate，不能替换或放宽 Core hard gate。

```ts
interface CandidateConstraintV1 {
  format: 'icarus.candidate-constraint/1';
  ref: VersionedRef;
  owner: EvaluationOwner;
  applies_to: EvaluationChangeLayer[];
  validator_capability_ref: VersionedRef;
  input_schema_ref: VersionedRef;
  result_schema_ref: VersionedRef;
  protected_region_policy_ref: VersionedRef | null;
  require_expected_base_hash: boolean;
  constraint_hash: string;
}
```

Validator 只能读取 baseline snapshot、staged Candidate、normalized diff 和声明的 dependency metadata，默认禁止 network、production data read 和所有 mutation。结果必须是结构化 `pass | fail`、稳定 reason code、定位信息和 input/output hash。

同一 Candidate 在以下三个边界必须执行并固定同一 Constraint closure：

1. Candidate Builder 生成 staged Candidate 后、seal 前。
2. Experiment seal 前，确认实际 Variant 与已验证 Candidate hash 一致。
3. Promotion preflight 时，基于待发布 bytes 和 expected active/base version 再验证。

任何 hard Constraint 失败都会使 Candidate 不可实验或不可发布；普通 Human Review 不能把失败覆盖为通过。若需要改变约束，必须先独立发布新的 Constraint version，并在新的 Experiment/Campaign 中使用。

### Promotion Binding 与 Promotion Bundle

`PromotionBinding` 声明某类 Evaluation Candidate 如何绑定到正式 Publisher、如何解析依赖闭包、是否需要受控 authoring commit，以及最终通过哪个原子 catalog root 暴露给 production ingress。它不包含任意 shell、路径或动态 Publisher 名称。

```ts
interface PromotionBindingV1 {
  format: 'icarus.promotion-binding/1';
  ref: VersionedRef;
  owner: EvaluationOwner;
  supported_change_layers: EvaluationChangeLayer[];
  closure_resolver_ref: VersionedRef;
  publisher_protocol_ref: VersionedRef;
  authoring_commit_capability_ref: VersionedRef | null;
  activation_catalog_ref: VersionedRef;
  required_constraint_refs: VersionedRef[];
  binding_hash: string;
}
```

Promotion Gateway 根据 sealed Candidate、Comparison Report、Review、Binding 和当前 active row version 生成 immutable `PromotionBundle`：

```ts
interface PromotionBundleV1 {
  format: 'icarus.promotion-bundle/1';
  bundle_id: string;
  candidate_ref: string;
  comparison_report_ref: string;
  promotion_binding_ref: VersionedRef;
  member_manifest_ref: string;
  member_manifest_hash: string;
  dependency_closure_ref: string;
  dependency_closure_hash: string;
  authoring_commit_intent_ref: string | null;
  activation_catalog_ref: VersionedRef;
  expected_catalog_row_version: number;
  activation_value_ref: string;
  activation_value_hash: string;
  constraint_result_refs: string[];
  permission_effect_diff_ref: string;
  bundle_hash: string;
}
```

发布顺序固定为：

```text
validate sealed Report/Review/Candidate/Constraint results
  -> resolve and freeze complete dependency closure
  -> optional authoring commit through effect/outbox/receipt
  -> publish every immutable member as inactive
  -> verify published member hashes and exact internal refs
  -> atomically CAS one production activation catalog root
  -> record activation receipt
  -> start post-promotion observation window
```

成员可以在失败前已经 immutable published，但不得被 production ingress 解析为 active。若一个目标需要同时切换多个内部 pointer，正式 Publisher 必须提供单一原子 catalog root；不能原子暴露完整闭包的 Binding 不得发布。任一步骤 crash 后必须用相同 `bundle_id`、operation key 和 expected row version 对账；无法证明外部结果时进入 `action_required`，不得猜测成功或创建新 Bundle 重做。

### Evaluation Trigger Template

Feature 可以发布 owner-scoped `EvaluationTriggerTemplate`，声明推荐的 schedule、threshold、Dataset/evidence selection、cooldown、dedupe、budget 和是否允许创建 Campaign。Template 本身不是启用中的 Trigger，不创建 scheduler state；安装 Feature 后必须由授权主体或显式 policy materialize 为 Core-owned Trigger instance。

```ts
interface EvaluationTriggerTemplateV1 {
  format: 'icarus.evaluation-trigger-template/1';
  ref: VersionedRef;
  owner: EvaluationOwner;
  subject_ref: VersionedRef;
  trigger_kind: 'schedule' | 'metric_threshold' | 'incident' | 'post_promotion_monitor';
  schedule_ref: VersionedRef | null;
  threshold_policy_ref: VersionedRef | null;
  dataset_selection_policy_ref: VersionedRef | null;
  evidence_selection_policy_ref: VersionedRef | null;
  evaluator_suite_ref: VersionedRef;
  metric_suite_ref: VersionedRef;
  budget_ref: VersionedRef;
  cooldown_ms: number;
  dedupe_key_template_ref: VersionedRef;
  allow_campaign_creation: boolean;
  template_hash: string;
}
```

`trigger_kind` 对应的 schedule/threshold 字段使用 closed discriminated validation：schedule 必须有 `schedule_ref` 且无 threshold；metric threshold 反之；incident 和 post-promotion 使用各自 policy schema，不能通过 nullable 字段组合产生未定义模式。

Template 不能请求自动 sealed 未审查的真实信号，不能降低高风险 Candidate 的 Human Review 要求，也不能指定 Feature-owned scheduler 或 Store writer。

## 自进化闭环

### 定位

自进化不是“让 Agent 修改自己然后直接上线”，而是一个受控优化过程：

```text
Observe
  -> Detect
  -> Diagnose
  -> Form one hypothesis
  -> Build staged candidate
  -> Evaluate on optimization/validation
  -> Final holdout gate
  -> Human/Policy decision
  -> Publish/Activate
  -> Post-promotion monitor
  -> Keep or rollback
```

完整闭环由 Core-owned `evaluation_self_evolution` Workflow 编排。各节点调用 Evaluation Service、Candidate Builder 和 Promotion Gateway，不把 Dataset/Experiment 事实塞进 Workflow Context；Context 只携带 exact refs/hashes。

### EvolutionCampaign

```ts
interface EvolutionCampaignV1 {
  format: 'icarus.evolution-campaign/1';
  campaign_id: string;
  subject_ref: VersionedRef;
  trigger_ref: string;
  evidence_window_ref: string;
  evidence_window_hash: string;
  optimization_policy_ref: VersionedRef;
  max_candidates: number;
  max_rounds: number;
  total_budget_ref: VersionedRef;
  campaign_hash: string;
}
```

Campaign domain status 只记录业务阶段和结果；Workflow Run/Node/Wait/Retry 状态仍由 Dynamic Runtime 管理，不能在 Evaluation Store 复制第二套 node state。

```text
collecting_evidence
diagnosing
candidate_building
evaluating
awaiting_decision
publishing
monitoring
completed | rejected | rolled_back | blocked | failed
```

### 问题发现

来源包括：

- 定时 Dataset 回归出现持续退化。
- 真实 Trace failure taxonomy 或某个 Slice 超过阈值。
- 用户明确差评、纠正、返工或取消。
- Workflow action-required、quality revision exhaustion 或异常人工介入增加。
- Core Conformance/benchmark 退化。
- 人工创建优化任务。

隐式信号只能生成“需要调查”的证据，不能直接证明回答错误。例如用户未回复不等于失败，重复提问也可能是需求变化。

### 优化假设

每个 Candidate 必须绑定一个结构化假设：

```ts
interface OptimizationHypothesisV1 {
  hypothesis_id: string;
  subject_ref: VersionedRef;
  primary_change_layer: EvaluationChangeLayer;
  target_slice_keys: string[];
  observed_problem_metric_refs: VersionedRef[];
  evidence_refs: string[];
  expected_improvements: Array<{
    metric_ref: VersionedRef;
    min_delta_micros: number;
  }>;
  protected_metrics: Array<{
    metric_ref: VersionedRef;
    max_regression_micros: number;
  }>;
  hypothesis_hash: string;
}
```

一次 Candidate 默认只有一个 primary direction。需要同时修改 Workflow 与 Prompt 时必须说明不可分割原因，并按 composite 处理。

### Candidate 类型

- Prompt Candidate：生成 Local Prompt Revision Candidate，保护 permission/tool/safety/output contract section。
- Skill Candidate：生成 immutable Skill artifact 和 Capability dependency diff。
- Workflow Candidate：生成 staged Recipe/Definition/Graph/Policy diff，通过 validate/compile/dry-run。
- Feature Implementation Candidate：生成 Feature Execution Artifact/Executor Candidate，通过 ABI、permission/effect 和 dependency closure gate。
- Core Candidate：生成 Core Bundle/代码变更候选，通过完整 CI、Conformance 和 representative Dataset。

Candidate Builder 只能写 authoring/staging/evaluation root，不能改 active Feature files、Registry pointer 或 production data。

Candidate Builder 必须解析 Subject 默认和本次 Policy 追加的 Candidate Constraint closure。Candidate 只有在 build-phase Constraint 全部通过并保存 immutable result 后才能 seal；Candidate bytes、base hash 或 constraint closure 发生变化都必须创建新 Candidate。

### 多轮优化

- optimization Dataset 可用于多轮候选迭代。
- 每轮 Candidate、Experiment 和 rejected reason 都不可变保存。
- 到达 `max_candidates`、`max_rounds`、预算或 deadline 后结束为 `blocked` 或 `rejected`，不能自动重置额度。
- validation 只允许有限轮数；holdout 默认只在最终候选上运行一次。若 holdout 失败后继续优化，必须创建新 Campaign 或由明确 Policy 扣减 holdout reuse budget并记录污染风险。

### Promotion Policy

固定风险层级：

| Candidate | 默认要求 |
| --- | --- |
| Prompt Local Variant | hard gate + validation/holdout + policy 可允许低风险自动 Promote |
| Skill | hard gate + dependency/permission diff + Human Review |
| Workflow topology/policy | compile/dry-run + hard gate + Human Review |
| Feature Executor/Artifact | ABI/effect/permission + hard gate + Human Review |
| Core Runtime | full CI + Conformance + benchmark + hard gate + Human Review +正式 Release activation |

任何 permission expansion、effect impact 提升、safety ceiling 变化、credential/mount/network 扩大都不能自动 Promote。

### 发布

- Prompt 使用 Runtime `prompt-registry` 的 Candidate/Promotion/Local Publish 协议。
- Workflow/Feature 使用 authoring `review -> publish -> activate`。
- Feature Executor 通过新的 Feature Release/Execution Artifact 发布。
- Core 使用 Core Release、Compatibility、certification 和 Production Activation。

Promotion Gateway 必须把 Comparison Report、Human Review、source/staged hash、Candidate Constraint results、Promotion Binding、Promotion Bundle、dependency/permission/effect diff 和 idempotency key 一并提交。发布失败不改变当前 active catalog root。Promotion Gateway 不接受页面或 Feature 直接提交任意 member list、Publisher 名称、active pointer 或发布顺序。

### 上线观察与回滚

Promotion 后建立固定 Observation Window：

- 新执行固定新 exact refs；旧运行继续使用旧 Snapshot。
- 收集与 baseline 同定义的真实指标，但区分 offline evaluation 与 observed production signal。
- 关键 hard gate 失败可自动停止新入口并回到上一个 active exact ref；涉及 Core Release 时继续遵守 compatibility/DB downgrade gate。
- 业务质量波动默认触发 Human Review，不因少量噪声立即回滚。
- rollback 后保留 Candidate、Report、发布和回滚审计，不删除历史版本。

## 触发与单能力调用

### Trigger 类型

```ts
type EvaluationTriggerKind =
  | 'manual'
  | 'schedule'
  | 'metric_threshold'
  | 'incident'
  | 'candidate_validation'
  | 'publish_preflight'
  | 'post_promotion_monitor';
```

每个 Trigger 固定 subject、dataset/evidence selection policy、cooldown、dedupe key、budget、最大并发和是否允许生成 Candidate。

Feature 安装包可以提供 `EvaluationTriggerTemplate`，但 Template 只有在授权主体显式启用或安装 policy 明确允许时，才由 Evaluation Service 物化为 Core-owned Trigger。后续 schedule state、lease、history、cooldown 和 disable/delete 全部归 Evaluation Store，不归 Feature Projection。

### 定时触发

定时任务可以：

- 只运行固定 Regression Dataset。
- 从最近 Trace 构建新的 discovery Dataset draft。
- 检测 Metric/Slice 漂移。
- 创建自进化 Campaign。

定时触发默认不能自动把真实 Trace 加入 sealed Dataset，也不能自动 Promote 高风险 Candidate。

### 手动触发

典型场景：开发者手动修改 Prompt 后运行对比。

```text
select subject
  -> select baseline exact ref
  -> upload/resolve candidate content
  -> build staged overlay
  -> run candidate constraints and seal candidate
  -> select Dataset + Metric/Evaluator Suite
  -> run paired experiment
  -> inspect report
  -> optional build promotion bundle and request review/promotion
```

不要求创建完整 Evolution Campaign。该路径体现 `Evaluation Experiment` 的独立一等能力；Candidate 必须先变成带 exact ref/hash 的 staged overlay，不能直接读取未提交的工作区或 active Prompt。

### 单能力调用

必须支持：

- `signals.import`：按 exact Domain Signal Source 和已提交 cursor 导入一个 immutable batch。
- `dataset.build`：从 case/trace 生成 draft。
- `dataset.seal`：校验、审查并发布 immutable Dataset Version。
- `variant.stage`：生成 candidate overlay。
- `replay.run`：只运行某个 case/variant。
- `experiment.run`：运行完整 paired matrix。
- `evaluator.run`：对已有 Observation 重跑新的外部 Evaluator。
- `metrics.compute`：按新 Metric Suite 计算，不重跑 Subject。
- `comparison.run`：比较已有兼容结果。
- `diagnosis.run`：只做问题归因。
- `candidate.build`：只生成 staged Candidate。
- `candidate.validate`：按 frozen Constraint closure 校验已有 staged Candidate。
- `promotion.plan`：根据 Binding 生成并校验 immutable Promotion Bundle，不执行发布。
- `promotion.request`：提交已完成 Report 进入 review/publish。
- `trigger.materialize`：从 exact Trigger Template 创建 Core-owned Trigger instance，不启动 Feature scheduler。

重新运行 Evaluator/Metric/Comparison 必须创建新的 immutable derivation，不能覆盖旧结果。只有 Evaluator 输入合同兼容且原始 Observation retention 未过期时才能重算。

## 持久化与模块边界

### 数据库边界

建议新增独立：

```text
evaluation.db
local/evaluation/values/
local/evaluation/blobs/
local/evaluation/runs/
```

`evaluation.db` 是评估领域事实源；大输入、Fixture、Observation、Artifact snapshot 和 Report 使用 content-addressed Value/Blob。它不能复用 `workflow-runtime.db` 的表，也不能直接读取其 write connection。

WorkflowAdapter 通过正式 export/query API 获取隔离 Runtime 的结果，复制必要 bytes 到 Evaluation Store，并保存原 Runtime refs/hashes 作为 provenance。复制后 Case/Report retention 不依赖隔离 Runtime root。

### Logical Schema

至少包含：

```text
evaluation_subjects
evaluation_domain_signal_sources
evaluation_signal_import_batches
evaluation_signal_import_records
evaluation_datasets
evaluation_dataset_versions
evaluation_cases
evaluation_dataset_case_members
evaluation_variants
evaluation_variant_members
evaluation_experiments
evaluation_experiment_variants
evaluation_planned_runs
evaluation_run_attempts
evaluation_observations
evaluation_evaluator_results
evaluation_metric_values
evaluation_comparison_reports
evaluation_promotion_decisions
evaluation_triggers
evaluation_campaigns
evaluation_hypotheses
evaluation_candidates
evaluation_candidate_constraints
evaluation_candidate_constraint_results
evaluation_promotion_bindings
evaluation_promotion_bundles
evaluation_promotion_bundle_members
evaluation_trigger_templates
evaluation_promotion_audits
evaluation_retention_handles
evaluation_value_records
evaluation_blob_records
```

所有时间使用 UTC Unix milliseconds `*_at_ms`，CAS 使用 `row_version`。内部关系使用真实 typed FK；Value/Blob 采用 hash、size、schema 和 provenance 校验。Experiment、Dataset、Variant 和 Report 的 sealed/terminal facts append-only。

### 幂等键

- Dataset seal：`dataset_id + source_revision_hash`。
- Signal import：`domain_signal_source_ref/hash + before_cursor + source_revision_hash + mapping_hash`。
- Variant stage：`subject_ref + base_hash + overlay_hash`。
- Experiment create：调用方 domain + idempotency key + canonical spec hash。
- Planned Run：`experiment_id + case_id + variant_id + repetition_no`。
- Evaluator Result：`observation_id + evaluator_ref/hash`。
- Metric Value：`observation/evaluator_result + metric_ref/hash`。
- Candidate constraint：`candidate_hash + constraint_ref/hash + phase`。
- Promotion Bundle：`candidate_id + comparison_report_hash + binding_ref/hash + target_active_row_version`。
- Promotion execute：`promotion_bundle_id + bundle_hash + target_active_row_version`。
- Trigger materialize：`trigger_template_ref/hash + owner + subject_ref + actor intent key`。

相同 key、不同 intent hash 必须 conflict。

### 模块目录

```text
src/evaluation/
  contracts/
  registry/
    subject-registry.ts
    dataset-registry.ts
    evaluator-registry.ts
    metric-registry.ts
    candidate-constraint-registry.ts
    promotion-binding-registry.ts
    trigger-template-registry.ts
  store/
    evaluation-store.ts
    value-store.ts
    schema/
  datasets/
    builder.ts
    redaction.ts
    partitioning.ts
    contamination.ts
  signals/
    source-registry.ts
    importer.ts
    cursor-store.ts
    normalizer.ts
  variants/
    resolver.ts
    overlay.ts
    candidate-builder.ts
    constraint-runner.ts
  execution/
    coordinator.ts
    standalone-agent-adapter.ts
    workflow-adapter.ts
    observation-normalizer.ts
  evaluators/
    runner.ts
    deterministic.ts
    llm-judge.ts
    human-review.ts
  metrics/
    engine.ts
    comparison.ts
    uncertainty.ts
  evolution/
    diagnosis.ts
    campaign-service.ts
    promotion-bundle-planner.ts
    promotion-gateway.ts
    monitoring.ts
  api/
  cli/
  projection/
```

`src/evaluation/` 可以依赖 Workflow Runtime 的 public contracts/query/authoring/dry-run clients，不能 import `store/runtime-store.ts` 或直接写 Graph Store。Workflow Runtime 不依赖 Evaluation 实现；最多在 contracts 层声明通用 export/correlation extension point。

依赖方向：

```text
evaluation/contracts
  <- registry/store
  <- datasets/variants/evaluators/metrics
  <- execution/evolution
  <- api/cli/projection

workflow-runtime public contracts/query clients
  -> evaluation/execution/workflow-adapter
```

### Feature 扩展点

Feature Manifest vNext 建议新增独立 closed evaluation resource union，或在后续 manifest major 中加入：

```ts
type FeatureEvaluationResourceKind =
  | 'evaluation_subject'
  | 'dataset_seed'
  | 'domain_signal_source'
  | 'experiment_evaluator'
  | 'metric_definition'
  | 'metric_suite'
  | 'candidate_constraint'
  | 'promotion_policy'
  | 'promotion_binding'
  | 'trigger_template';
```

Feature 只能声明 owner namespace 内的资源。`dataset_seed` 进入 Dataset Builder 后才能形成 sealed Dataset；`domain_signal_source` 只能产生待校验的 normalized signal；`trigger_template` 必须经过显式 materialize；`promotion_binding` 只能引用 allowlisted 正式 Publisher。任何 Feature resource 都不能让 Feature 安装包直接写 Evaluation DB、注册 scheduler 或切换 active pointer。

普通 Feature 结构：

```text
Feature Package
  - Workflow/Recipe A
  - Workflow/Recipe B
  - Workflow/Recipe C
  - evaluation subject descriptors
  - dataset seeds
  - domain signal sources
  - domain evaluators
  - metric suites
  - candidate constraints
  - promotion policy/bindings
  - trigger templates
```

## 权限、安全与副作用隔离

### Principal

至少区分：

- `human:local-owner`：创建/审批实验、查看敏感结果、批准发布。
- `service:evaluation-control`：写 Evaluation Store 和调度 Run。
- `service:signal-ingestor`：按 exact Domain Signal Source 调用 owner-scoped readonly capability，只能向 Evaluation control 提交规范化批次。
- `service:evaluation-runner`：读取单次 sealed input，返回 Observation，无 Registry/production DB 写权限。
- `service:candidate-builder`：写 staging root，无 active pointer 权限。
- `service:promotion-gateway`：在有效 Human/Policy 授权下调用正式 Publisher。
- `feature:<id>:evaluation-provider`：发布 Feature-owned evaluation resources，无调度、任意 source read、Store 直写、Publisher 调用和 active pointer 权限。

### Effect Policy

```ts
type EvaluationEffectMode =
  | 'deny'
  | 'fixture'
  | 'shadow'
  | 'readonly_live';
```

- 默认 `deny`。
- `fixture` 返回固定 result/receipt。
- `shadow` 只修改 disposable workspace、临时 DB 或模拟服务。
- `readonly_live` 只允许显式 read capability，并把响应复制到 Observation。

第一版不存在 `live_mutation`。涉及真实 mutation 的 Candidate 只能验证 intent、permission、claim、operation key、Fake Adapter receipt 和 shadow after-snapshot。

Domain Signal import 的 `readonly_live` 只能读取声明的 owner scope，并在进入 Evaluation Store 前执行 snapshot、redaction 和 schema 校验。Promotion 阶段的 authoring commit、inactive publish 和 activation 不属于 Experiment Effect Policy；它们只能在 Experiment 已结束后，由 Promotion Gateway 按正式 Publisher/effect 协议执行，evaluation runner 永远不能获得这些权限。

### 数据保护

- Trace-derived Case 必须经过字段 allowlist 和 redaction。
- Prompt/response/Artifact 可按 sensitivity 限制 UI、API 和 retention。
- Secret、Credential、auth header、Cookie 和原始 token 不落盘。
- LLM Judge 输入遵循相同 redaction，并记录发送给 Judge 的 exact content hash。
- Dataset export 默认不包含 sensitive case bytes，只输出 manifest 和授权后的内容。

### 资源预算

Experiment Budget 至少限制：

- case 数、candidate 数、repetition 数。
- 并发和总 duration。
- model request、input/output/cache tokens 和估算成本。
- tool call、attempt、Workflow Run/Node/Fact。
- Value/Blob logical/physical bytes。
- Evaluator/Judge 调用数。

预算耗尽产生 typed terminal result，不能自动重置或静默缩小 Dataset。

## API、CLI 与产品界面

### API

建议使用 closed command/query API：

```text
POST /api/evaluation/signals/import
GET  /api/evaluation/signals/imports

POST /api/evaluation/datasets/build
POST /api/evaluation/datasets/{id}/seal
GET  /api/evaluation/datasets
GET  /api/evaluation/datasets/{id}

POST /api/evaluation/variants/stage
POST /api/evaluation/candidates/{id}/validate
POST /api/evaluation/replays
POST /api/evaluation/experiments
GET  /api/evaluation/experiments
GET  /api/evaluation/experiments/{id}
GET  /api/evaluation/reports/{id}

POST /api/evaluation/evaluators/run
POST /api/evaluation/metrics/compute
POST /api/evaluation/comparisons

POST /api/evaluation/campaigns
GET  /api/evaluation/campaigns/{id}
POST /api/evaluation/triggers/materialize
GET  /api/evaluation/triggers
POST /api/evaluation/promotions/plan
POST /api/evaluation/promotions
POST /api/evaluation/rollbacks
```

所有 mutation 使用 idempotency key、actor、expected row version 和 audit。列表使用 closed cursor/filter/sort，不能开放任意 SQL 或路径。

### CLI

```text
icarus eval signals import|history
icarus eval dataset build|seal|list|show
icarus eval variant stage|show|validate
icarus eval replay run
icarus eval experiment run|status|cancel
icarus eval report show|export
icarus eval evaluator run
icarus eval compare
icarus eval evolve start|status|cancel
icarus eval trigger materialize|list|disable
icarus eval promote plan|apply
icarus eval rollback
```

CLI 是 API client，不直接写 Evaluation DB、Registry 或 filesystem active pointer。

### Evaluation Center

建议作为 Runtime Center 同级的 Core 页面，提供：

1. **Signals & Datasets**：领域信号导入批次、cursor、版本、partition、Slice、来源、脱敏、污染和覆盖。
2. **Experiments**：baseline/candidate、Run Matrix、进度、预算和失败。
3. **Reports**：hard gate、win/tie/loss、Metric delta、Slice、Trace/Artifact 对比。
4. **Evolution**：证据、归因、假设、Candidate diff、Constraint、Promotion Bundle、评估和发布状态。
5. **Triggers**：定时、阈值、cooldown、预算和最近触发。
6. **Audit**：Dataset seal、Experiment、Human Review、Promotion、Rollback。

Workflow/Standalone Agent 详情通过 typed deep link 跳转到 Runtime Center/Trace；Evaluation Center 不复制完整 DAG 或 Trace viewer。

## 失败、恢复与取消

- Coordinator 使用 lease 和有限 retry；runner crash 后 planned run 可由同 logical id 恢复。
- Adapter prepare 后、execute 前 crash，cleanup/reconcile 能识别 orphan isolation root。
- execute 结果已生成但 Observation 未提交时，通过 result hash 幂等导入。
- Model/Tool timeout 是 Subject Observation；Evaluation infrastructure timeout 是 Run infrastructure failure，两者不能混淆。
- Evaluator failure 不删除 Observation，可以单独重跑 Evaluator。
- Experiment cancel fencing 未开始的 planned runs；active runner 收敛后保留 partial evidence，Report 标记 cancelled，不产生 Promotion Decision。
- Comparison 发现 dataset/variant/evaluator hash 不匹配时为 `invalid`，不能 fallback 到 current version。
- Promotion crash 使用既有 Publisher idempotency/activation CAS；Evaluation Store 根据 receipt 对账，不猜测是否已激活。
- Signal import crash 通过 source revision、before cursor、mapping hash 和 record dedupe key 重放；只有 batch commit 成功后才能推进 cursor。
- Promotion Bundle 在 inactive member publish 后 crash 时保留不可变成员并按 bundle receipt 对账；activation catalog CAS 未成功时旧 active root 保持不变。
- isolation root 在 Report 和审计所需 bytes 复制完成后清理；清理失败形成 operational alert，不改变已提交结果。

## 测试策略

### Contract Fixture

- Subject、Domain Signal Source、Signal Import Batch、Dataset、Case、Variant、Overlay、Candidate Constraint、Promotion Binding/Bundle、Experiment、Observation、Evaluator、Metric、Report schema 的正负例。
- strict parse、canonicalization、hash、duplicate key、unsafe integer 和 unknown field。
- same ref/different hash、latest/range ref、跨 Feature namespace 和不完整 closure 拒绝。

### Adapter Contract Test

同一 contract suite 运行两类 Adapter：

- validate 不产生副作用。
- prepare 使用独立 root。
- duplicate execute 不产生两个 accepted result。
- fixture miss、timeout、cancel、crash 和 cleanup 可恢复。
- Observation schema 和 correlation 完整。
- baseline/candidate 身份不改变执行路径。

### Dataset Test

- signal source cursor、dedupe、snapshot、mapping、redaction 和 crash replay。
- source reader 不能执行 mutation、任意路径/SQL 或跨 owner 读取。
- redaction 不泄漏 Secret/Credential。
- partition 去重和 contamination 检测。
- sealed Dataset 不可修改。
- Runtime source retention 不影响已复制 Case。
- holdout 对 Candidate Generator 不可见。

### Comparison Test

- paired alignment、missing policy、tie epsilon 和 direction 正确。
- 顺序随机化可由 seed 重放。
- bootstrap/sign test 使用固定 fixture 得到稳定结果。
- hard gate 失败不能被总分覆盖。
- critical Slice 退化阻止 promotion。
- 多候选选择和 holdout 使用遵守 Policy。

### Evolution Model Test

- Campaign 不越过 max candidates/rounds/budget/deadline。
- Candidate 不能写 active pointer。
- Candidate Constraint 在 build/seal/promotion 三个边界固定 exact ref/hash，hard failure 不可被普通批准覆盖。
- rejected/inconclusive 不触发 Promotion。
- Prompt/Workflow/Feature/Core 使用正确发布协议。
- permission/effect 扩大总是进入 Human Review。
- Promotion/rollback crash 能按 receipt 和 exact ref 收敛。
- Promotion Bundle 只有全部 inactive member 和 closure 校验完成后才能切换单一 activation catalog root。

### Fault Injection

覆盖：

- Evaluation DB transaction、Value/Blob install 和 fsync。
- runner process crash、lost result、duplicate callback 和 lease expiry。
- Workflow dry-run crash/recovery、Model timeout、Tool fixture miss。
- Evaluator invalid output、Judge disagreement 和 Human Review timeout。
- signal batch commit/cursor advance 前后、authoring commit 前后、inactive member publish 前后、active catalog CAS 前后、monitor/rollback 前后。

### 安全测试

- 真实 channel send、生产 DB write、host path、credential 和 network mutation 全部被拒绝。
- Feature evaluator 不能读取其他 Feature Dataset 或降低 Core hard gate。
- Domain Signal Source、Candidate Constraint 和 Promotion Binding 不能跨 owner、申请任意 capability 或旁路 Evaluation control/Promotion Gateway。
- staged overlay 不能被 production ingress 解析。
- candidate Core Bundle 不能访问 Evaluation control DB。

### 基准

- Experiment Coordinator 在目标 case/run 数下的 admission 和 result import。
- Evaluation DB/Blob 容量与 GC。
- WorkflowAdapter 隔离 root 创建、运行和清理开销。
- LLM Judge/Metric 并发预算。
- Evaluation 不得使 production Agent/Workflow 调度超过明确资源占比。

## 实施顺序

Dynamic Workflow Runtime Production Activation 是所有阶段的前置。本节阶段共同组成评估与自进化框架第一版，不表示 Feature 或 Workflow 留到后续再接入。

### E0：合同与边界

- 冻结 Subject、Domain Signal Source、Signal Import Batch、Dataset、Case、Variant、Candidate Constraint、Promotion Binding/Bundle、Trigger Template、Experiment、Observation、Evaluator、Metric 和 Report closed schema。
- 冻结 Error/Reason/Status Catalog。
- 冻结 Evaluation Store Logical Schema、retention、budget 和 effect policy。
- 定义 Workflow Runtime public dry-run/export/query 扩展，禁止 DB 直连。

退出条件：Contract Pack、negative fixture、module dependency test 完成。

### E1：Evaluation Store 与 Dataset

- 实现 `evaluation.db`、Value/Blob、migration、Schema Manifest 和 GC。
- 实现 Dataset Builder、redaction、partition、Slice、contamination 和 seal。
- 实现 Domain Signal Source registry、readonly ingestion、cursor、dedupe、mapping、snapshot 和 import audit。
- 支持人工 Case、Trace-derived Case 和 Feature-supplied normalized signal。

退出条件：Dataset 可版本化、可审计、可独立导入导出且不依赖 source retention。

### E2：两类 Adapter 与 Replay

- 实现 `StandaloneAgentAdapter`。
- 实现正式 `WorkflowAdapter`，对 Core-owned/Feature-owned Workflow 使用相同合同。
- 接入 RuntimeConformanceHarness 结果引用。
- 实现 isolation、Fixture Broker、Observation Normalizer 和 Run Matrix。

退出条件：相同 sealed Experiment 可完整重放，真实 channel/production data 零副作用。

### E3：Evaluator、Metric 与 Paired Comparison

- 实现 deterministic/reference/domain evaluator。
- 实现 blind LLM Judge 和 calibration。
- 实现 Metric Engine、Slice、paired comparison 和 uncertainty。
- 实现 Promotion Policy 与 immutable Report。

退出条件：手动 Prompt、Skill、Workflow、Feature Executor 和 Core Bundle candidate 都能生成可信对比报告。

### E4：手动评估产品闭环

- 实现 API、CLI、Evaluation Center。
- 支持手动 stage candidate、选 Dataset、运行、查看 diff 和提交 Promotion Review。
- 实现 Candidate Constraint build/seal/preflight 三阶段校验。
- 实现 Promotion Binding 解析、Promotion Bundle planning、inactive publish 和单一 activation catalog CAS。
- 支持各单能力独立调用。

退出条件：开发者手动修改 Prompt 后可端到端完成 A/B 对比，不进入自进化 Campaign。

### E5：自进化闭环

- 发布 Core-owned Self Evolution Recipe/Workflow。
- 实现 evidence collection、diagnosis、hypothesis、Candidate Builder、multi-round evaluation。
- 接入 Human Review、Publisher、Activation、monitor 和 rollback。

退出条件：Prompt、Skill、Workflow、Feature Executor 和 Core Candidate 均遵守各自 Promotion Policy，不存在直写 active pointer。

### E6：定时、漂移与运营门禁

- 实现 schedule、threshold、incident 和 post-promotion trigger。
- 实现 Trigger Template 的校验、授权 materialize 和 owner-scoped 默认配置。
- 实现 cooldown、dedupe、budget、并发和 drift report。
- 建立定期 regression、holdout 治理和 Dataset freshness 流程。

退出条件：定时评估与自进化可以长期运行，且不会因重复触发、样本污染或资源竞争失控。

## 验收标准

### 通用

- 所有执行都固定 exact ref/hash、Dataset、Variant、Evaluator、Metric、Environment 和 seed。
- 同一 sealed Experiment 可以恢复和重放，不能读取 workspace latest。
- Report 可以追溯到每个 Case、Observation、Trace、Artifact、Evaluator 和 Metric。
- 实验基础设施失败、Candidate 质量失败和 hard gate 失败语义分离。

### Standalone Agent

- 群聊、私聊和直接 Agent 案例可以在不发送真实消息的情况下回放。
- Prompt、Skill、Model、Tool、Memory/Context 变体可以成对比较。
- token、latency、tool、artifact、failure 和输出质量指标完整。

### Workflow 与 Feature

- Core-owned 和 Feature-owned Workflow 使用同一个 `WorkflowAdapter`。
- 一个 Feature 可以注册多个 Workflow Subject，不创建 Feature-specific runner。
- Workflow topology、Prompt、Skill、Policy、Evaluator、Executor/Artifact 变体可以被精确隔离。
- 回放使用正式 Dynamic Runtime 语义和独立 root，不写 production Runtime DB/Projection。
- Feature 可以通过通用 Domain Signal Source 导入领域 Evidence/Case seed/observed outcome，但不能直接写 Evaluation Store。
- Feature-specific Candidate Constraint 和 Promotion Binding 在 Core control plane 中执行，不产生 Feature-owned Candidate Builder、Publisher 或 activation state。
- Feature Trigger Template 只有显式 materialize 后才产生 Core-owned Trigger；Feature disable/draining 不留下不可审计的 scheduler state。

### Core Runtime

- Core candidate 同时通过 Conformance Harness 和代表性业务 Dataset。
- candidate Core 由稳定控制面隔离启动，不能承载或修改自己的 Promotion Decision。
- Protocol/ABI/DDL/SQLite/managed Node identity 不兼容时 fail-closed。

### 数据集

- 每个领域信号导入批次都可追溯到 exact source/mapping/redaction ref、source revision、cursor window、record key 和 immutable normalized value。
- Trace-derived Case 全部经过 redaction 和 snapshot。
- sealed Dataset 不受 source Trace/Workflow retention 影响。
- optimization、validation 和 holdout 隔离可验证。
- overall 与 critical Slice 覆盖均达到 Dataset Policy。

### 指标与决策

- safety/reliability hard gate 不能被总分抵消。
- paired win/tie/loss、Metric delta、Slice 和不确定性完整展示。
- `pass@1` 和声明的 `pass@k` 能按 case/variant/repetition 重放和比较；`n < k`、采样不足和 case 内波动都有明确结论，不能静默降级。
- missing/timeout/evaluator failure 不被静默排除。
- LLM Judge 盲化、顺序随机化、版本固定并通过 calibration。

### 自进化

- 问题、证据、归因、假设、Candidate、Experiment、Report、Review、Publish、Monitor 和 Rollback 形成完整 lineage。
- Candidate 无权直接修改 active pointer 或 production data。
- Prompt、Skill、Workflow、Feature Executor 和 Core 使用各自正式发布门禁。
- 高风险或权限/effect 扩大必须 Human Review。
- budget、round、candidate 和 deadline 耗尽后有限终止。
- 多资源 Candidate 通过 immutable Promotion Bundle 发布；任意中间失败都不改变旧 active catalog root，并可按 bundle receipt 恢复。

### 安全

- 第一版 Evaluation Effect Policy 不存在 live mutation。
- Credential/Secret 不进入 Dataset、Observation、Judge 或 Report。
- Feature 不能跨 owner 访问评估资源或降低 Core hard gate。
- staged overlay 对 production ingress 不可达。

## 待确认决策

下列内容不影响总体架构，但进入 Contract Pack 前需要确认：

1. 第一版默认真实模型 repetition 数：建议普通 Case 为 3，昂贵/慢 Case 可由 Dataset Policy 收紧为 1，但报告必须标记低重复置信度。
2. Prompt Local Variant 是否允许低风险自动 Promote：建议默认关闭，仅在用户显式开启且连续通过 validation、holdout 和 post-promotion monitor 后允许。
3. Trace-derived Dataset 的默认 retention：需要结合本地磁盘预算确定 Case bytes、raw Observation 和 Report 的不同保留周期。
4. LLM Judge 默认模型和 calibration 阈值：应在实现期用人工标注集实测后冻结，不在方案阶段指定厂商或型号。
5. Feature evaluation resources 是加入 `icarus.feature-manifest/2` 的兼容扩展，还是发布新的 manifest major：建议根据 v2 closed schema 的兼容规则决定；不得以 unknown field 或目录扫描旁路接入。
6. Promotion 后自动观察窗口的默认大小：建议同时支持固定运行数和最长 duration，以先到者为准。
7. Domain Signal Source 第一版允许的 locator/cursor 组合：建议先支持受控文件 append/event-key 与只读 Projection event-key，任意 SQL 和动态脚本永久不开放。
8. 单一 activation catalog root 的最小 Publisher ABI：需要与 Runtime authoring/prompt/feature publisher 合同一起冻结，避免各资源类型实现不同的半发布恢复语义。
9. `pass@k` 的默认 k 集合：建议第一版固定支持 `k in {1, 3}`；若 Dataset Policy 将 repetition 收紧为 1，则只输出 `pass@1`，`pass@3` 标记为 `inconclusive`。
