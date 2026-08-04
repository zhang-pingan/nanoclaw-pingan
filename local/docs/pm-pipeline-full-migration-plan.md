# PM 产研包流水线完整迁移方案

## 背景

`/Users/chelaile/IdeaProjects/ai_workspace_pm` 是一套基于 Claude Code 的 PM 产研包流水线。它通过 `.claude/commands`、subagents、skills、hooks、脚本和目录契约，把一句话需求推进到研发可直接施工的 `.draft` 交付包，再经过 `.active`、`.done`、验收、归档、evals 和 prompt 优化形成闭环。

继续基于 Claude Code 做产品化会遇到几个边界：

- 编排依赖主对话记忆和 command 文档，状态机不够显式。
- Gate、hook、script、agent 调用分散，难以做强审计和可视化。
- 产物、trace、human decision、retry、pause/cancel 没有统一产品界面。
- PM 复杂交互如视觉 demo、终审报告、prompt diff、知识沉淀不适合塞进通用聊天窗口。

Icarus 已经有 workflow runtime、container agent、artifact contract、interrupt、trace、workbench store、host action 等基础能力。迁移目标不是把 `.claude` 目录简单复制进 Icarus，而是把 PM 流水线作为 Icarus 的一个完整业务应用，同时保留原有 prompt、文档、契约、约束和产出包结构。

## 结论

采用以下定位：

```text
Workflow Runtime：统一执行内核
Workbench Core：通用执行基础设施、数据协议、组件能力
Execution Console：通用调试、观察、兜底控制台
Feature Package Runtime：功能包启用、资源注册、独占 group、API/nav 动态加载
Evaluation Framework：统一 Dataset、Experiment、Evaluator、Metric、Campaign、Candidate 与 Promotion 控制面
PM Pipeline：`features/pm-pipeline` 功能包，启用后成为独立一级业务应用
```

核心原则：

- 统一执行，不统一页面。
- PM Pipeline 不以现有 Workbench 页面为主入口。
- Workbench 不再承担所有业务的统一操作台角色。
- Workbench 拆成底层能力 `Workbench Core` 和兜底页面 `Execution Console`。
- PM Pipeline 不直接写进 Icarus core，而是作为仓库内 feature package 接入。
- 各业务应用拥有自己的一级页面和领域交互，但通过 Feature Package Runtime 共享 workflow、trace、artifact、human review、permission、audit 等底层协议。
- PM Pipeline 不实现 Feature-owned Evaluation Store、Experiment runner、Metric Engine、评估 scheduler、Candidate Builder、Promotion Gateway 或自进化状态机；只作为 Evaluation Framework 的领域 Provider。
- PM 的运行中质量门禁、领域信号和知识库仍归 PM；离线评估、自进化、候选验证、依赖闭包发布、观察与回滚归 Icarus Core。

本文以 `docs/dynamic-workflow-runtime.md` 索引的current machine Contracts与Runtime实现为 PM 业务执行合同：Workflow Definition 固定外层 State/transition，每个 non-terminal State Activation 统一 lower 到 Graph Run；复杂阶段使用多节点 graph state，简单 delegation/system/interrupt state lower 为单节点 Graph。不存在 parallel state、旧 completion handler、多步骤 `system.run.steps`、transition 内嵌 delegate 或 graph/sequential 双轨 Runtime。

PM 的离线评估与自进化以 `local/docs/evaluation-self-evolution-framework.md` 为唯一目标合同。两个 Activation Gate 分开：

```text
PM Core Pipeline Activation
  depends on Dynamic Workflow Runtime Production Activation

PM Full Migration Activation
  depends on:
    - PM Core Pipeline Activation
    - Evaluation Framework Production Activation
    - PM Evaluation Provider Integration Gate
```

因此 PM 主业务流水线可以先实现；但在 Evaluation Framework 和 PM Provider 集成完成前，只能声明 `PM Core Pipeline Activation`，不能宣称完整迁移已经覆盖原 weekly evaluation 和 prompt optimization 闭环。

## 目标

- 完整迁移 `ai_workspace_pm` 的 PM 产研包流水线。
- 保持 prompt、agent 文档、skill 文档、模板、脚本、目录、CSV schema、产出包契约不变。
- 把 Claude Code 的 `/command + subagent + skill + hook` 运行模型替换为 Icarus 的 `workflow + container delegation + host action + human review`。
- 以 `features/pm-pipeline` 新增 PM Pipeline 一级导航和专属页面，支持丰富交互。
- 让所有 PM 业务 Workflow 执行状态落在统一 Workflow Runtime 中；Evaluation domain facts 落在 Core Evaluation Store，自进化编排仍使用 Core-owned Workflow，避免 PM 页面复制任一状态机。
- 保留通用 Execution Console 的观察、暂停、重试、取消、trace 排障能力。
- 将原 weekly evaluation、regression、prompt optimization 迁移为 Core Evaluation Framework 中 owner-scoped 的 Trigger、Experiment、Campaign、Candidate、Promotion Bundle 和 Report。
- 保留 `runs/loops/escapes` 等 PM 领域信号、运行中 Artifact/Schema quality gate 和 `knowledge` 领域知识，并通过通用 Evaluation Provider 合同接入 Core。
- 后续其他复杂 agent 业务也按同一模式扩展：feature package + 独立业务页面 + 共享底层执行基础设施。

## 非目标

- 不要求 PM 页面兼容现有 Workbench 的页面形态。
- 不把现有 Workbench 继续设计成所有业务的主操作入口。
- 不把 PM Pipeline 的 API、页面、workflow、agent、skill、脚本直接静态写入 core 目录或 `src/channels/web.ts`。
- 不重写原有 PM prompt 的业务语义。
- 不把 PM 产物转换成 Icarus 私有格式后丢失原文件事实源。
- 不建立第二套独立于 workflow runtime 的 PM 执行状态机。
- 不在 PM Feature 内建立第二套 Evaluation Store、Dataset Builder、Replay Coordinator、Metric Engine、自进化 Workflow、评估 scheduler 或 Prompt 发布事务。
- 不让 Core 直接理解 PM CSV 列、目录、知识 pattern 或 prompt authoring 约束；这些差异由 PM 发布的通用领域扩展资源表达。

## 总体架构

```text
features/pm-pipeline
  - feature.json
  - host/
  - renderer/
  - container/
        |
        v
Feature Package Runtime
  - 启用配置 local/features.json / ICARUS_FEATURES
  - feature manifest 校验
  - PM Pipeline 一级导航动态注册
  - feature API prefix 动态注册
  - workflow / card / artifact contract / skill / agent / script 资源注册
  - requiredGroups 独占 group provisioning
        |
        v
PM Pipeline 一级页面
  - 总览
  - 待办 / Gate
  - 需求开发
  - 交付包
  - 质量与知识
  - Agent 轨迹
  - 设置
        |
        v
PM Pipeline Domain API / Projection
  - 将 workflow 通用状态投影成 PM 业务语义
  - 将 PM 业务执行动作翻译成 workflow command
  - 将评估动作提交到 Core Evaluation closed API
  - 展示 owner=pm-pipeline 的 Evaluation 摘要和 typed deep link
        |
        v
Workflow Runtime
  - trusted outer State/transition + unified Graph Runtime
  - exact Recipe/Capability/Interface/Policy/Wait Contract
  - durable approval wait / human review
  - domain resource claim + effect/outbox/receipt
  - immutable artifact snapshot + evaluator/quality gate
  - retry / pause / cancel / explicit rework transition
  - trace / event / audit / recovery
        |
        v
Container Agent / Host Actions
  - 按 pinned capability/executor snapshot 读取 versioned agent/skill source
  - 不在 active run 中读取 live/latest PM workspace prompt
  - 通过独立 typed system capability 执行每个 allowlisted script
  - 写入原目录结构和产物
        |
        v
PM Workspace 文件事实源
  - PROJECT-PROFILE.md
  - product-docs/
  - deliverables/
  - test/
  - evals/
  - knowledge/
  - optimization/
  - pipeline-state.json
        |
        v
PM Evaluation Provider Resources
  - evaluation subjects / dataset seeds
  - domain signal sources
  - domain evaluators / metrics / slices
  - candidate constraints / promotion binding
  - trigger templates
        |
        v
Icarus Evaluation Framework / Evaluation Center
  - signal ingestion / Dataset / Experiment / Report
  - Campaign / Candidate / Promotion Bundle
  - schedule / threshold / monitor / rollback
```

Execution Console 与 PM Pipeline 平行存在：

```text
Execution Console
  - 所有 workflow 可见
  - 通用 timeline
  - 通用 artifact 列表
  - 通用 action item
  - pause / retry-wait / cancel / policy-authorized manual skip
  - raw trace / event / payload 排障
        |
        v
Workflow Runtime
```

Execution Console 是兜底和调试工具，不是 PM 的主使用界面。

## 作为 Feature Package 实现

PM Pipeline 必须按已实现的 Feature Package Runtime 接入 Icarus，而不是继续向 core 追加业务代码。

功能包 id：

```text
pm-pipeline
```

推荐目录：

```text
features/pm-pipeline/
  feature.json
  host/
    index.ts
    api.ts
    projection.ts
    evaluation-projection.ts
    host-actions.ts
    migrations/
      001_pm_pipeline_projection.sql
  renderer/
    index.ts
    routes.ts
    styles.css
    components/
  container/
    groups/
      main/
        CLAUDE.md
    workflow-definitions/
      pm_new_feature.json
      pm_init_project.json
      pm_init_docs.json
      pm_promote_deliverable.json
      pm_dev_verify.json
      pm_knowledge_maintenance.json
      pm_iterate_a2.json
      pm_iterate_a7.json
    workflow-recipes/
    workflow-routing-scopes/
    workflow-execution-policies/
    workflow-capabilities/
    workflow-schemas/
    workflow-graph-interfaces/
    workflow-graph-templates/
    workflow-graph-policies/
    workflow-wait-contracts/
    cards/
    agents/
    skills/
    artifact-contracts/
    workflow-evaluators/
    evaluation-subjects/
    evaluation-dataset-seeds/
    evaluation-domain-signal-sources/
    evaluation-experiment-evaluators/
    evaluation-metrics/
    evaluation-metric-suites/
    evaluation-candidate-constraints/
    evaluation-promotion-policies/
    evaluation-promotion-bindings/
    evaluation-trigger-templates/
    scripts/
    templates/
  README.md
```

`feature.json` 草案：

```json
{
  "id": "pm-pipeline",
  "name": "PM Pipeline",
  "version": "0.1.0",
  "description": "PM product-delivery pipeline feature package",
  "hostEntry": "./host/index.js",
  "rendererEntry": "./renderer/index.js",
  "apiPrefix": "/api/features/pm-pipeline",
  "nav": [
    {
      "key": "pm-pipeline",
      "label": "PM Pipeline",
      "order": 300
    }
  ],
  "requiredGroups": [
    {
      "key": "main",
      "jid": "feature:pm-pipeline:main",
      "name": "PM Pipeline",
      "folder": "pm_pipeline_main",
      "requiresTrigger": false,
      "description": "PM Pipeline dedicated agent group",
      "claudeMd": "./container/groups/main/CLAUDE.md"
    }
  ],
  "resources": {
    "workflowDefinitions": "./container/workflow-definitions",
    "workflowRecipes": "./container/workflow-recipes",
    "workflowRoutingScopes": "./container/workflow-routing-scopes",
    "workflowExecutionPolicies": "./container/workflow-execution-policies",
    "workflowCapabilities": "./container/workflow-capabilities",
    "workflowSchemas": "./container/workflow-schemas",
    "workflowGraphInterfaces": "./container/workflow-graph-interfaces",
    "workflowGraphTemplates": "./container/workflow-graph-templates",
    "workflowGraphPolicies": "./container/workflow-graph-policies",
    "workflowWaitContracts": "./container/workflow-wait-contracts",
    "cards": "./container/cards",
    "agents": "./container/agents",
    "skills": "./container/skills",
    "artifactContracts": "./container/artifact-contracts",
    "workflowEvaluators": "./container/workflow-evaluators",
    "evaluationSubjects": "./container/evaluation-subjects",
    "evaluationDatasetSeeds": "./container/evaluation-dataset-seeds",
    "evaluationDomainSignalSources": "./container/evaluation-domain-signal-sources",
    "evaluationExperimentEvaluators": "./container/evaluation-experiment-evaluators",
    "evaluationMetrics": "./container/evaluation-metrics",
    "evaluationMetricSuites": "./container/evaluation-metric-suites",
    "evaluationCandidateConstraints": "./container/evaluation-candidate-constraints",
    "evaluationPromotionPolicies": "./container/evaluation-promotion-policies",
    "evaluationPromotionBindings": "./container/evaluation-promotion-bindings",
    "evaluationTriggerTemplates": "./container/evaluation-trigger-templates",
    "scripts": "./container/scripts",
    "templates": "./container/templates"
  },
  "permissions": {
    "hostActions": [
      "pmPipeline.nextId",
      "pmPipeline.deliverableFinalCheck",
      "pmPipeline.readDomainSignals",
      "pmPipeline.validateDomainSignals",
      "pmPipeline.validatePromptCandidate",
      "pmPipeline.commitPromptAuthoringSource",
      "pmPipeline.validatePipelineState",
      "pmPipeline.lintCases",
      "pmPipeline.promoteDeliverable",
      "pmPipeline.syncWorkspace"
    ],
    "fileScopes": ["pmWorkspace"],
    "mcpServers": []
  }
}
```

启用方式：

```json
{
  "enabled": ["pm-pipeline"]
}
```

或：

```bash
ICARUS_FEATURES=pm-pipeline
```

实现边界：

- `features/pm-pipeline/host/index.ts` 只通过 `FeatureContext` 注册 API、projection、event subscription、host action adapter 和 Evaluation Provider resources，不静态修改 `src/channels/web.ts`。
- PM API 全部挂在 `/api/features/pm-pipeline/*`，只做 projection 查询、workspace registry 管理、workflow command 包装、设置读写和 owner-scoped Evaluation deep link；Experiment/Campaign/Promotion mutation 直接调用 Core Evaluation API，不由 PM API 复制一层状态机。
- PM 一级导航来自 manifest 的 `nav`，renderer 入口通过 `/features/pm-pipeline/renderer/index.js` 动态加载。
- PM Recipe、workflow definitions、capabilities、schemas、graph interfaces/templates/policies、wait contracts、cards、artifact contracts、workflow evaluators、agents、skills、scripts、templates 和 Evaluation Provider resources 都通过 manifest 的 `resources` 注册。当前 `src/features/manifest.ts` 尚未支持的 Graph/Evaluation resource 字段，必须分别按 Dynamic Framework 和 Evaluation Framework 扩展 parser/registry/management/test。
- `workflowEvaluators` 只包含运行中 Execution Evaluator/quality gate；离线 Experiment Evaluator 必须放在 `evaluationExperimentEvaluators`，两者不能通过目录或 ref 混用。
- `pmPipeline.readDomainSignals` 只能由 `service:signal-ingestor` 通过 exact Domain Signal Source 调用；`pmPipeline.validatePromptCandidate` 只能读取 baseline/staged diff；`pmPipeline.commitPromptAuthoringSource` 只能由 `service:promotion-gateway` 在 sealed Promotion Bundle 下调用。PM 页面、PM Workflow 和普通 Agent 均无权直接调用这三个 capability。
- PM workflow definitions 使用目标 Runtime 的 versioned Definition bundle；旧 `.json` `WorkflowDefinitionVersionBundle` 只作为迁移输入，不能把旧多步骤 system action、transition delegate 或 completion handler 原样保留成旁路。
- 启用 feature 时由 core provisioning 创建 `feature:pm-pipeline:main` 独占 group 和 `groups/pm_pipeline_main/CLAUDE.md`。
- Feature migration 只能创建 `feature_pm_pipeline_*` 前缀表，例如 `feature_pm_pipeline_workspaces`、`feature_pm_pipeline_projection_cache`。PM Feature 不创建 schedule、experiment、campaign、candidate 或 promotion 状态表；这些事实归 `evaluation.db`。
- Feature projection 可以缓存 PM 业务视图，但不能成为执行事实源或评估事实源。workflow DB、human review、trace、PM workspace 文件事实源和 Core Evaluation Store/query API 各自在自己的领域内权威。
- Feature `draining` 后不允许新建 PM Workflow，也不允许新的 Experiment/Campaign/Promotion 选择 PM-owned Evaluation resource；但必须继续加载 pinned executor/resource 让 active Workflow 和 sealed Evaluation run 收敛。Workflow/Evaluation active refs 清零后才能 `disabled`。选择“停用并删除”时还必须满足 retention、无 published/active ref、无 action-required/quarantined run，并由 deletion service 分开清理 feature-owned domain data、可验证的 Graph audit snapshot 和 Evaluation retention handle。

### PM Task Intake 与 Recipe 选择

PM 业务页面按钮已经明确表达任务种类，因此默认不调用 LLM Macro Router，而是使用单候选 routing scope 产生 deterministic decision：

```text
发起新需求       -> pm-pipeline.new-feature@1
初始化项目       -> pm-pipeline.init-project@1
初始化文档       -> pm-pipeline.init-docs@1
promote          -> pm-pipeline.promote-deliverable@1
维护知识 pattern -> pm-pipeline.knowledge-maintenance@1
```

评估、回归、自进化和发布不属于 PM Recipe intake：手动动作调用 Core Evaluation API，周期动作由 owner-scoped Core Evaluation Trigger 创建 Experiment/Campaign。PM Feature 只提供 Subject、Dataset/evidence selection、Metric/Evaluator Suite、Constraint、Promotion Binding 和 Trigger Template。

PM Feature 因此有意不发布 `workflowRoutingCapabilities` 资源目录：所有 Feature-local routing scope 的 `router_capability_ref=null`，由 deterministic resolver 校验显式 RecipeRef。若通用聊天入口需要识别 PM 任务，使用 core/global scope 发布并固定的 Domain Router；PM Feature 只提供其 bounded child scope，不能复用业务 capability 充当 Router。未来只有在 PM scope 内确实出现多个自然语言意图且确定性字段无法区分时，才新增独立、pure、无 tool 权限的 routing capability 及对应 manifest 目录。

每个 Recipe 固定 exact Definition/entrypoint、Workflow execution policy、input/output schema、launch policy 和 domain resource claims。通用聊天入口如果允许识别 PM 任务，必须先经过 global Domain Router 再进入 PM routing scope，不能把 Startup Opportunity、产品设计等 Definition 与 PM Recipe 放入同一个无界候选集合。

所有创建请求使用稳定 `creation_key`：

```text
new feature:     pm:new-feature:{workspace_id}:{request_id}
promote:         pm:promote:{workspace_id}:{package_id}:{target_state}
knowledge:       pm:knowledge:{workspace_id}:{pattern_id}:{expected_hash}:{action}
```

重复点击、API retry 或 transition effect 必须返回同一个 Workflow。`promote` 和其他有写副作用的 Recipe 使用 `confirm` 或 `manual_only` launch policy，不能仅凭模糊自然语言自动启动。Evaluation Trigger、Experiment、Campaign 和 Promotion Bundle 使用 Evaluation Framework 自己的 dedupe/idempotency key，不复用 PM Workflow creation key。

PM workspace 和 PM feature 的关系：

```text
features/pm-pipeline/
  功能包代码、页面、workflow definition、agent/skill 模板、artifact contract、host action adapter

data/features/pm-pipeline/workspaces/{workspaceId}/ 或已注册 external workspace
  项目事实源：PROJECT-PROFILE.md、CLAUDE.md、product-docs、deliverables、evals、knowledge、optimization、scripts、pipeline-state.json
```

也就是说，feature package 提供“产品和运行时能力”，PM workspace 保存“某个项目的真实产物和长期记忆”。

PM feature 产物路径由 PM feature 自己定义，不由 Icarus core 规定。Icarus core 只提供 `data/features/{featureId}` feature data root、workflow storage root、artifact index、contract、权限、审计和删除机制。

## 分层职责

### Workflow Runtime

Workflow Runtime 是真正的底层执行面。

职责：

- 保存 Task Intake/Recipe、workflow instance、State Activation、Graph Run/Scope/Node、lifetime counter 和 immutable context/output snapshot。
- 将 delegation/system/interrupt/graph state 统一 lower/执行为 Graph，并只由 root completion cut 推进外层 transition。
- 创建和恢复 versioned approval wait/human review。
- 记录 agent trace、event、checkpoint、stage evaluation。
- 执行 retry、pause、resume、cancel、definition-authorized rework/manual skip。
- 调用 capability 固定的 artifact contract、evaluator 和 quality gate。
- 通过 effect/outbox/domain claim 调用 host system capability 和 container delegation capability。

不承担：

- 不表达 PM 领域页面布局。
- 不关心视觉 demo 怎么展示。
- 不关心交付包树如何分组。
- 不关心 PM 决策文案如何业务化呈现。

### Workbench Core

Workbench Core 是共享基础设施，不是一个具体页面。

职责：

- Workflow projection 基础查询。
- Timeline、trace、artifact、action item、human review 的通用协议。
- Artifact preview registry。
- Command dispatch：`createWorkflowFromRecipe`、`resolveWorkflowWait`、`pause/resume/cancelWorkflow`、Definition-authorized rework/remediation 等。
- Permission、risk、audit、idempotency。
- 前端通用组件，如 trace viewer、timeline、artifact viewer、action panel。

不承担：

- 不强迫各业务页面使用同一个通用任务详情 UI。
- 不限制 PM Pipeline 增加领域组件。
- 不让通用数据模型取代业务投影模型。

### Feature Package Runtime

Feature Package Runtime 是功能包扩展层，负责让 PM Pipeline 作为可启用/停用的业务包接入 Icarus。

职责：

- 扫描 `features/*/feature.json`。
- 根据 `local/features.json` 或 `ICARUS_FEATURES` 启用功能包。
- 校验 manifest、资源路径、API prefix、nav key、required group、permissions。
- Provision feature 独占 group。
- 注册 feature API、nav、renderer entry、Recipe/routing/execution policy、workflow definitions、capabilities、schemas、graph interfaces/templates/policies、wait contracts、cards、artifact contracts、workflow evaluators、Evaluation Provider resources、agents、skills、scripts、templates。
- 运行 feature migrations。
- 支持 feature `enabled -> draining -> disabled -> deleting`，并按 active executable/evaluation refs 与 retention 阻止不安全停用/删除。

不承担：

- 不理解 PM 业务阶段和 Gate 语义。
- 不保存 PM 执行状态。
- 不替 feature 实现页面、projection 或 host action。
- 不允许 feature 绕过 core workflow、permission、audit 和 container isolation。

### Execution Console

Execution Console 是通用兜底控制台。

职责：

- 查看所有 workflow。
- 查看通用 timeline、trace、artifact、interrupt。
- 做通用 pause、retry-wait、cancel 和 policy-authorized manual skip。
- 排查失败 stage、agent output、contract validation。
- 当业务页面没有覆盖某类异常时，提供兜底操作。

限制：

- 不承载 PM Pipeline 的主要工作流体验。
- 不展示完整 PM 领域操作，例如视觉改图、交付包终审决策和知识 pattern 维护。

### PM Pipeline

PM Pipeline 是 `pm-pipeline` feature package 启用后注册出来的独立一级业务应用。

职责：

- 通过 manifest 提供 PM 专属导航、页面、交互和数据视图。
- 把一句话需求、初始化、交付包、Gate、领域信号和知识沉淀做成产品化体验。
- 将 PM 操作翻译成 workflow command。
- 从 workflow 和文件事实源生成 PM projection。
- 注册 PM-owned Evaluation Subject、Dataset seed、Domain Signal Source、Experiment Evaluator、Metric/Slice、Candidate Constraint、Promotion Policy/Binding 和 Trigger Template。
- 查询并展示 owner=`pm-pipeline` 的 Evaluation Report/Campaign/Promotion 摘要，并通过 typed deep link 进入 Core Evaluation Center。
- 保留原流水线的文档、脚本、产物和目录契约。

限制：

- 不维护独立执行状态机。
- 不绕过 workflow runtime 直接推进阶段。
- 不绕过 script/hook/contract 做危险状态变更。
- 不保存 Experiment、Campaign、Candidate、Promotion Bundle 或 Trigger runtime state，不实现 prompt regression runner 或发布事务。
- 不通过 core 静态 import、硬编码路由或硬编码导航接入。

## PM Pipeline 页面设计

页面按 PM 业务组织，不按底层 workflow 或 Experiment 名称组织。二级导航只放长期稳定工作区；一次性初始化和 promote 放在业务详情，评估/自进化通过 Core Evaluation Center 的 owner-scoped 视图承载。

推荐二级导航：

```text
PM Pipeline
├─ 总览
├─ 待办 / Gate
├─ 需求开发
├─ 交付包
├─ 质量与知识
├─ Agent 轨迹
└─ 设置
```

不单独设置 `初始化` 二级导航。`init-project` / `init-docs` 是 workspace bootstrap 动作，放在总览的初始化卡片中；执行完成后主按钮置灰，保留查看记录、重新校验、修复缺失项等次级动作。

不单独设置 `Prompt 自进化` 或 `周期任务` 二级导航。Experiment、Campaign、Trigger、Candidate Review、Promotion 和 Rollback 的权威产品入口是 Core Evaluation Center；PM 页面只显示 owner-scoped 摘要、领域信号/知识和 deep link，避免复制第二套评估状态与操作面。

### 1. 总览

展示：

- 当前 workspace 健康状态。
- 进行中的 PM workflow：需求开发、promote、初始化修复等。
- 待 PM 处理：业务 Gate、retrospect 漏登处置，以及来自 Evaluation Center 的 owner-scoped Review/Promotion 摘要。
- 最新 `.draft`、`.active`、`.done` 包。
- 最近 Evaluation Report、领域信号导入状态、pending optimization evidence、下一个 owner-scoped Trigger 时间。
- Workspace 初始化卡片：`init-project`、`init-docs` 是否已完成。

主要动作：

- `发起新需求`：创建 `pm_new_feature` workflow。
- `继续最近需求`：跳转需求详情。
- `查看全部需求`：进入需求开发二级页。
- `开始 init-project` / `开始 init-docs`：仅未完成时可点，完成后置灰。
- `查看初始化记录`、`重新校验`、`修复缺失项`。
- `运行回归评估`：调用 Core Evaluation API 创建 sealed Experiment。
- `发起优化`：调用 Core Evaluation API 创建 owner-scoped Evolution Campaign。
- `打开 Evaluation Center`：进入预过滤的 PM Subject/Report/Campaign 页面。
- `打开 Execution Console`：排障入口。

总览只做状态摘要、初始化提示和高频快捷入口，不承载完整编辑、审批、promote、Experiment 或 Candidate 发布能力。

### 2. 待办 / Gate

集中展示 PM 业务 human review / workflow interrupt，并可展示 Core Evaluation action item 的只读摘要。

能力：

- 需求 Gate：Gate 1、1.5a、1.5b、2、3。
- A2 soft gate 警告逐条裁决。
- D1 模块拆分确认、D2 存量基线裁决。
- retrospect 漏登处置。
- 初始化失败后的修复确认。
- Evaluation Candidate/Promotion Review 摘要；点击后进入 Evaluation Center 完成决策。

详情页动作：

- `批准`、`拒绝`、`要求修改`、`跳过`。
- `重试等待`、`要求修改`、`启动 allowlisted follow-up workflow`；不得传任意 target State/Workflow。
- `查看上下文`、`打开原产物`、`打开 trace`。

要求：

- 每个问题必须用业务语言呈现。
- 每个选项带业务后果。
- PM 业务 Gate 决策最终调用 `resolveWorkflowWait`，携带 wait expected version、action、typed payload 和 idempotency key。
- Wait CAS 只发布 typed resolution；对应 Markdown/`pipeline-state.json` 由下游 mutation capability 写回并保存 receipt/snapshot。
- Evaluation Review 不调用 `resolveWorkflowWait`，而调用 Core Evaluation command，携带 evaluation object expected row version 和 idempotency key；PM Projection 不复制其状态。

### 3. 需求开发

对应原 `/new-feature`。

能力：

- 需求列表和状态筛选。
- 一句话需求输入。
- 附件上传。
- kebab-case slug 确认。
- CHG/OPT/FIX 编号确认。
- A1 到 A7 阶段视图。
- Gate 1、1.5a、1.5b、2、3 决策。
- UI 类需求 demo 截图预览、改图反馈、before/after 对比。
- A2 soft gate 警告逐条裁决。
- A5 建议业务化展示。
- 打包前终审报告展示。

详情页动作：

- `新建需求`、`继续流程`、`暂停`、`取消`。
- `提前 retry-wait`、`执行 Definition 声明的返工命令`、`paused 后按 policy 跳过允许节点`。
- `生成 .draft`、`运行 final check`。
- `打开 trace`、`打开 Console`。

底层仍然推进一个 `pm_new_feature` workflow。

需求详情只放本需求相关动作，不放全局评估、自进化、workspace 设置等跨需求入口。

### 4. 交付包

对应 `.draft/.active/.done/archive` 管理。

能力：

- 包列表和状态筛选。
- 包文档树。
- 12 个根文档预览。
- test-cases snapshot 预览。
- `deliverable-final-check.sh` 报告。
- promote 状态机动作。
- dev-verify 和 PM 灰度体验记录。
- retrospect 是否完成。
- baseline backflow 状态。

详情页动作：

- `promote 到 .active`。
- `promote 到 .done`。
- `归档`。
- `运行 dev-verify`。
- `补跑 retrospect`。
- `校验领域信号文件`。
- `同步 baseline backflow`。
- `查看 99-状态`。
- `查看提交记录`。
- `打开包目录`。

promote 必须调用原 `scripts/promote.sh` 或等价 host action，不能直接改名移动目录。

### 5. 质量与知识

对应：

- `evals/runs.csv`
- `evals/loops.csv`
- `evals/escapes.csv`
- `knowledge/cases.csv`
- `knowledge/patterns/`
- owner=`pm-pipeline` 的 Evaluation Signal Import、Dataset、Report、Campaign 和 Promotion 摘要

能力：

- PM 领域信号文件的 schema、source revision、cursor 和最近导入批次。
- Core Evaluation Report 的趋势摘要和 critical Slice。
- escape 分析。
- loop 收敛指标。
- case 索引查看。
- pattern 查看。
- optimization evidence 与 Candidate/Promotion 状态摘要。

建议内部 tabs：

- `Evaluation 摘要`
- `信号导入`
- `runs`
- `loops`
- `escapes`
- `cases`
- `patterns`
- `Optimization Evidence`

详情页动作：

- `导入最新领域信号`：调用 Core `signals.import`，不直接写 Evaluation Store。
- `运行回归评估`：调用 Core `experiment.run`。
- `发起优化 Campaign`：调用 Core `evolve start`。
- `打开 Evaluation Center`。
- `标记 pattern dormant`：创建 `pm_knowledge_maintenance` workflow。
- `恢复 pattern active`：创建 `pm_knowledge_maintenance` workflow。
- `导出 CSV`。
- `打开关联交付包`。
- `打开关联 trace`。
- `打开关联 Evaluation Report/Campaign`。

`质量与知识` 页面不是第二套 Evaluation Center：它不保存 Dataset/Experiment/Campaign/Candidate/Promotion 状态，不执行评估或发布，也不提供 prompt 文件直接编辑。`evals/weekly/`、`patches-pending/applied/rejected`、`agent-versions.json` 和 `PROMPT-CHANGELOG.md` 可作为历史兼容导入或导出视图，但不再是评估、自进化和发布的权威状态。

### 6. Agent 轨迹

能力：

- 按 workflow、stage、agent 筛选调用记录。
- 查看 A1/A1.5/A2/A3/A4/A5/A6/A7 每次调用。
- 查看 prompt、agent definition、handoff envelope。
- 查看输出、结构化 result、耗时、模型。
- 查看失败原因、retry 记录、artifact contract 校验。

详情页动作：

- `按 workflow 筛选`。
- `按 agent 筛选`。
- `查看 prompt`。
- `查看原始输出`。
- `提前 retry-wait` 或执行 Definition 声明的 rework command。
- `打开关联 artifact`。
- `打开 Execution Console`。

Agent 轨迹是排障和审计页，不承担业务审批。

### 7. 设置

设置负责 workspace 的持续维护，不负责承载日常业务流程。

分组：

- `Workspace`：名称、路径、项目 profile、目录健康检查。
- `Git / Repo`：业务仓路径、默认分支、hooks 安装状态、push policy、只读/写保护规则。
- `Evaluation 集成`：PM Evaluation Provider resource 健康状态、最近 signal import、owner-scoped Trigger 摘要和打开 Evaluation Center 的入口；Trigger 的启用、schedule、history 和重跑归 Core Evaluation Center。
- `执行策略`：host action allowlist、container mount、脚本权限。
- `Artifact / Projection`：contract 开关、文件事实源对账、重建 projection。
- `审计`：初始化记录、配置变更记录、执行日志。

详情页动作：

- `切换 workspace`。
- `打开 Evaluation Triggers`。
- `校验 workspace`。
- `同步文件事实源`。
- `重建 projection`。
- `查看审计日志`。

`init-project` 负责 bootstrap：创建 workspace 初始结构、写 `PROJECT-PROFILE.md` / `CLAUDE.md` / `.claude` assets、初始化 scripts/hooks/git policy 默认值并做首次校验。初始化后，git、repo、hooks、allowlist、mount policy 等配置修改归 PM 设置页；Evaluation Trigger 配置归 Core Evaluation Center。

## 执行状态与页面状态

禁止 PM 页面维护独立执行状态。

PM 业务 Workflow 的唯一执行状态来自 Graph Store 及其通用协议：

- Task Intake/Recipe/Workflow/State Activation/Graph Run tables。
- workflow graph events、completion cuts 和 checkpoints。
- durable waits / human review。
- node attempts、agent query trace、effect receipt 和 immutable artifact records。

`pipeline-state.json`、deliverable 目录名和 CSV 是领域文件事实，不是 scheduler/transition 的执行状态。Projection 同时读取 Graph Store、最新成功 snapshot 和 live workspace hash，显示一致、待同步或 external drift；它不能从 live file 推断并直接推进 Workflow。

Evaluation Dataset/Experiment/Campaign/Candidate/Promotion/Trigger state 只来自 `evaluation.db` 和 Core Evaluation query API。PM Projection 可以缓存其 owner-scoped 摘要，但不得从 PM workspace 文件推断 Evaluation 状态，也不得在 `feature_pm_pipeline_*` 表复制可写状态机。

PM 页面通过 projection 转换为领域视图。

示例：

```text
workflow:
  status = a5_secondary_review
  pending_interrupt = gate2_pm_decision
  artifacts = 03-技术方案.md, 05-A5-二次校验报告.md

pm projection:
  当前需求包卡在 Gate 2
  A5 建议需要 PM 决策
  可选动作：采纳 A5、坚持原方案、让 A3 重写
  关联材料：A5 报告、A4 范围审核、A3 技术方案
```

PM 页面动作翻译成 versioned workflow command；文件更新由 resume 后的 system capability 完成。

示例：

```text
PM 页面动作：
  通过 Gate 1.5b，进入 A2

底层 command：
  resolveWorkflowWait({
    workflowId,
    waitId,
    expectedVersion,
    idempotencyKey,
    action: "approve",
    payload: {
      gate: "gate_1_5b",
      screenshot_decision: "approved"
    }
  })
```

## 原 Claude Code 能力映射

| Claude Code 资产/能力 | Icarus 迁移后 |
| --- | --- |
| `.claude/commands/*.md` | `features/pm-pipeline/container/workflow-definitions` 的编译输入 + PM 页面入口参考 |
| `Agent(subagent_type=...)` | exact versioned delegation capability node |
| `.claude/agents/*.md` | prompt authoring source；发布为 versioned agent/executor/capability snapshot，active run 不读取 live path |
| `.claude/skills/*` | skill authoring source；发布为 capability dependency，路径 adapter 只服务 publisher/staging |
| `.claude/settings.json deny` | feature permissions + host/container policy + mount policy + tool guard |
| Claude Code PreToolUse hook | container runner tool policy / host hook |
| Claude Code PostToolUse hook | artifact/csv write validator |
| Claude Code SessionStart hook | workflow/session context injection |
| `AskUserQuestion` | human review / workflow interrupt |
| `.claude/workflows/*.js` | 单操作迁为 exact system capability；多步骤/Agent/等待流程迁为 Graph/Workflow |
| `scripts/*.sh` | 一脚本一 system capability，固定 hash、typed args、cwd resolver、effect/cancellation contract |
| `pipeline-state.json` | 兼容领域文件保留，通过 effect receipt/snapshot 与 Graph Store 对账，不作为执行状态镜像 |
| `/pipeline-review` | PM-owned Trigger Template + Domain Signal Source + Metric/Evaluator Suite；由 Core Evaluation Experiment/Report 替代，不迁为 PM Workflow |
| `/optimize-prompts` | PM-owned Candidate Constraint + Promotion Binding；由 Core Evolution Campaign/Candidate/Promotion Bundle 替代，不迁为 PM Workflow |
| `evals/runs.csv`、`loops.csv`、`escapes.csv` | PM 领域信号事实源；通过 Domain Signal Source 导入 immutable Signal Import Batch，不作为 Evaluation Store |
| `evals/regression-set` | 迁为 Dataset seed/immutable Dataset Version，由 WorkflowAdapter 执行 paired replay |
| `patches-pending/applied/rejected` | 历史兼容 evidence/import/export；Candidate、Review 和 Promotion 的权威事实归 Evaluation Store 与正式 Registry/Publisher |

## PM Workspace 设计

迁移后需要支持多个 PM workspace。

每个 PM workspace 保留原目录结构，但物理根分两种模式：

- `managed`：由 PM feature 管理，默认在 `data/features/pm-pipeline/workspaces/{workspaceId}`。
- `external`：注册已有目录，例如 `/Users/chelaile/IdeaProjects/ai_workspace_pm`，core 不默认删除该目录。

Managed workspace：

```text
data/features/pm-pipeline/workspaces/{workspaceId}/
  PROJECT-PROFILE.md
  CLAUDE.md
  .claude/
  code/
  product-docs/
  deliverables/
  test/
  knowledge/
  evals/
  optimization/
  scripts/
```

External workspace：

```text
/Users/chelaile/IdeaProjects/ai_workspace_pm
```

PM workspace 目录结构是 PM feature 的领域契约，不是 Icarus core 的通用契约。其他 feature 可以在 `data/features/{featureId}` 下定义完全不同的业务结构。

`pm-pipeline` feature 保存 workspace registry。实现上使用 feature-owned 表，表名必须带 `feature_pm_pipeline_` 前缀，例如 `feature_pm_pipeline_workspaces`。

```ts
interface PmWorkspace {
  id: string;
  name: string;
  storageMode: 'managed' | 'external';
  rootPath: string;
  status: 'ready' | 'needs_init' | 'disabled';
  projectProfilePath: string;
  artifactRoot: string;
  contextPackRoot: string;
  createdAt: string;
  updatedAt: string;
}
```

所有 PM workflow 都必须绑定 `pmWorkspaceId`。

PM workflow 的 storage root 由 PM feature 设置：

```text
artifactRoot = {workspace.rootPath}/deliverables/{packageId}
contextPackRoot = {workspace.rootPath}/workflow-context/{workflowId}/{stageKey}
```

Workbench 可以解析 PM feature live 产物路径用于打开/编辑，但每个成功 node 的权威执行 artifact 必须是 immutable snapshot，例如 live path：

```text
data/features/pm-pipeline/workspaces/ws1/deliverables/PKG/01-需求范围与边界.md
```

Artifact contract 由 PM feature 定义，例如 `pm.deliverable_package.v1`、`pm.evals_runs.v1`，负责校验 PM workspace 下的业务文件结构和 immutable directory manifest。Icarus core 不解释 PM 目录语义，只做 path safety、live locator、immutable snapshot/index、contract evaluation、permission、audit 和 deletion summary。

### 强协议 1：PM Workspace Mutation 与 Immutable Snapshot

SQLite 与 workspace filesystem 不能假装处于同一个事务。权威边界固定为：Graph Store 是执行状态事实源；PM workspace 是可移植领域文件事实源；Graph Value/Blob Store 中的 immutable snapshot 是某次 node 成功和恢复审计事实；`pipeline-state.json` 是由受控 capability 维护的兼容领域文件，不是第二套 scheduler。

所有 PM Workflow 内写文件、移动 deliverable、写 CSV 或同步 baseline 的 system capability 必须执行：

```text
持有匹配的 domain resource claim + fencing token
  -> DB persist effect intent(operation key, expected-before hash/version)
  -> staging/shadow workspace prepare（支持时）
  -> transaction 外 apply
  -> validate script + authoritative after-state verify
  -> DB persist receipt(before/after hash, changed paths, external revision)
  -> 复制文件/目录 manifest 到 immutable blob snapshot
  -> artifact/evaluator/quality gate
  -> node succeeded + outer transition
```

外部 apply 成功但 receipt 未知时先按 operation key/文件 revision 对账；无法证明时进入 `action_required`，不得创建新 attempt 盲目重做。Node success、Gate 展示和后续 context pack 引用 immutable snapshot/hash；用户打开编辑时才解析 live workspace path，并显示 live hash 是否仍与 snapshot 一致。目录 snapshot 按安全相对路径排序保存 manifest，禁止 hard link 充当 immutable 历史。

`pipeline-state.json` 更新也是 effect，不与 root cut 假装原子：对应 node 只有 receipt + snapshot 成功后才完成；若 DB 已提交 intent 而文件未完成，由 recovery 使用同 operation key 补齐。外部人工改文件导致 expected-before mismatch 时拒绝覆盖并进入 reconcile action，不能以最后写入者获胜。

### 强协议 2：跨 Workflow Domain Resource Claims

所有 PM Recipe 在创建 Workflow 的 T0 transaction 原子获得最细粒度 durable claim；冲突返回 `resource_busy`，不能先创建 Workflow 再异步抢锁：

```text
pm:workspace-bootstrap:{workspace_id}                    exclusive
pm:package:{workspace_id}:{package_id}                   exclusive
pm:deliverable-lifecycle:{workspace_id}                  exclusive
pm:knowledge:{workspace_id}:{pattern_id}                 exclusive
pm:workspace-read:{workspace_id}                         shared
```

Evaluation signal import、Experiment、Campaign、Candidate 和 Promotion 使用 Evaluation Framework 的 lease、dedupe、operation key、Promotion Bundle 和 activation catalog CAS，不占用或复制 PM Workflow domain claim。若 Promotion Binding 声明可选 authoring commit，该 mutation 由正式 Publisher/effect 协议取得目标资源 claim，不由 PM Recipe 持有。

Claim key 由 Recipe 对 schema-valid frozen input 的 JSON Pointer 计算，不接受页面/Planner 自报最终 key。每次 acquisition 产生单调 fencing token并传给 host adapter；stale token mutation 必须被拒绝。Claim 不因 worker lease、pause、crash 或 human wait 自动过期，只在 Workflow terminal/可信 cancel compensation 后释放；`action_required/quarantined` 默认继续持有。Recipe 必须避免用 workspace 全局 exclusive claim 包住长人工等待，除非业务确实要求阻断所有写入。

### 强协议 3：跨 Attempt 业务幂等与独立 Script Capability

`graph_attempt_id` 只足以处理同一 attempt 的 outbox redelivery。PM mutation capability 必须选择 trusted effect key strategy：

```text
promote:
  namespace = pm.promote-deliverable
  business_input = workspace_id + package_id + expected_state + target_state

package generation revision:
  scope = node             # node retry 对同一逻辑输出对账
```

删除 `pmPipeline.runScript` 泛化权限。每个 script/adapter 注册独立 exact system capability，固定 executable hash、typed args、cwd resolver、file scope、artifact/evaluator、effect/cancellation contract。Planner、页面和 Agent 不能传任意 script path、shell fragment 或 cwd；workspace script 只有在 capability allowlist、相对路径 resolver、content hash/version 和 tool guard 全部通过后执行。

初始 effect/cancellation 分类：

| Capability | Effect | Cancellation |
| --- | --- | --- |
| workspace scan / final check / lint | `pure` | `fence_only` |
| write requirement/test/report | `idempotent`，node 或 business-input key | cooperative staging abandon；apply 后对账完成 |
| promote deliverable | `idempotent`，package transition business key | active mutation 不允许 early close；未知结果 action-required |
| git push/外部不可逆发布 | 默认 `manual_only` + idempotent provider key；无法幂等时不得注册 | 必须有可证明 compensation，否则禁止进入 Runtime |

Compiler 对含 active mutable effect 的 scope 禁止不安全 early close/fail-fast；Definition 应把 mutation 放在短、单一职责 State，先完成人工确认，再开始 effect，避免在不可中断 mutation 中等待用户。

### Workflow Lifetime Policy 与 Runtime Safety

每个 PM Recipe 发布 finite Workflow execution policy，至少约束 `max_state_activations`、`max_graph_runs`、`max_state_transitions`、`max_child_workflows`、总 attempts/tool/token/cost 和业务 deadline。A2/A7 回炉、Gate revision 和 follow-up 跨 activation 累计，不能通过进入新 State 重置。Human approval 可以按 wait contract 显式 indefinite，但这不取消 node/spec/map/attempt/outbox/blob 的部署级 finite RuntimeSafetyCeilings。

`pm_new_feature`、`pm_init_docs` 等长流程使用不同 policy；`pm_promote_deliverable` 等短流程使用更小 ceiling。Workbench/PM 页面展示已消费预算、剩余回炉次数、held claims 和 deadline，超限走 Definition 固定 `escalate/manual_review` named exit，不由 Planner 猜测继续。Evaluation Experiment/Campaign 的预算与 lifetime 由 Evaluation Framework 单独管理。

## 完整 workflow 清单

下列列表描述 Workflow Definition 的宏观 State/transition topology，不表示每个名称都必须是一个旧式 handler。稳定业务阶段和人工 Gate 保留为 State boundary；阶段内部需要并行、output condition、fan-in 或多步骤时使用 graph state，其内部单位是 Graph Node。简单 delegation/system/interrupt state 由 lowerer 自动成为单节点 Graph。UI/non-UI、A5 是否需要、soft gate 和 pass/fail 路由必须由 typed node output + named exit 表达，不能继续使用 transition 内嵌 delegate、`system.run.steps` 或旧 completion handler。

本清单只包含 PM 业务执行 Workflow。Weekly evaluation、prompt regression、自进化、Candidate Review 和 Promotion 不属于 PM Workflow 清单，由 Evaluation Framework 的 Experiment、Core-owned Campaign 和 Promotion Bundle 承担。

Planner 不是 PM Workflow 的默认必需组件。A1-A7 主拓扑固定；只有测试矩阵、模块扫描等确实需要按输入动态生成节点时，才由专用 Micro Planner capability 为指定 graph state 生成 Scope Spec。Planner 无权删除 Gate、改变 promote 规则或扩大 script/file 权限。Regression case matrix 由 Evaluation Experiment Planner 生成，不进入 PM Workflow Graph。

### pm_init_project

迁移原 `/init-project`：

```text
collect_prerequisites
-> gate_confirm_prerequisites
-> clone_or_fetch_code
-> scan_stack_arch_terms_visual
-> scan_dual_axis_capability
-> gate_confirm_project_profile
-> write_project_profile
-> wire_guardrails
-> completed
```

### pm_init_docs

迁移原 `/init-docs`：

```text
precheck
-> module_split_proposal
-> gate_d1_confirm_modules
-> write_overview_skeleton
-> excavate_module_docs
-> gate_d2_pm_decision
-> generate_module_cases
-> lint_cases
-> next_module_or_publish
-> publish_baseline
-> completed
```

### pm_new_feature

迁移原 `/new-feature`：

```text
prepare_draft_workspace
-> a1_gap_questions
-> gate1_pm_qa
-> a1_write_requirement
-> classify_ui_need
-> gate1_5_materials_or_skip
-> a1_5_clarify
-> gate1_5a_pm_qa
-> a1_5_demo_spec
-> gate1_5b_pm_confirm
-> a2_requirement_review
-> a2_soft_gate_router
-> a3_tech_architecture
-> a4_scope_review
-> a5_secondary_review_if_needed
-> gate2_pm_decision_if_needed
-> a6_test_cases
-> a7_test_case_review
-> gate3_packaging_confirm
-> generate_draft_package
-> deliverable_final_check
-> draft_completed
```

### pm_promote_deliverable

迁移 `promote-deliverable`：

```text
precheck_single_active
-> run_promote_script
-> if_done_run_retrospector
-> validate_domain_signal_files
-> sync_baseline_backflow
-> completed
```

### pm_dev_verify

迁移 `/dev-verify`：

```text
load_package
-> run_dev_gray_verify
-> capture_evidence
-> write_99_status
-> completed_or_best_effort_failed
```

### pm_knowledge_maintenance

维护 `knowledge/patterns/` 的 active/dormant 状态，不承担 Dataset、Experiment 或 Candidate 状态：

```text
load_pattern_with_expected_hash
-> validate_requested_transition
-> apply_pattern_status_mutation
-> validate_knowledge_contract
-> persist_receipt_and_immutable_snapshot
-> completed
```

页面只能提交 `pattern_id + expected_hash + activate|dormant` typed action。Workflow 使用 `pm:knowledge:{workspace_id}:{pattern_id}` claim；expected-before mismatch 进入 reconciliation，不允许页面直接改文件。

### PM Evaluation Provider 集成

原 `/pipeline-review` 和 `/optimize-prompts` 不迁移为 PM-owned Workflow。它们分别由 Core Evaluation Experiment/Report 和 Core-owned `evaluation_self_evolution` Campaign 替代。PM Feature 通过 manifest 注册领域资源，不能创建 Feature-owned Evaluation scheduler、Store writer、Candidate Builder、Promotion Gateway 或评估状态表。

#### Evaluation Subjects 与 Dataset

PM 至少为以下对象发布 owner-scoped Evaluation Subject：

- `pm_new_feature` Recipe/Workflow 整体质量。
- A1-A7 delegation capability 的 Prompt/Skill/Model/Tool Binding。
- deliverable final check、retrospect 和 promote 前后的业务结果。
- PM Feature executor/artifact 与 Workflow topology/policy。

`evals/regression-set/cases.csv` 和 `expected/<case_id>/<agent>/` 迁为 `dataset_seed`。Dataset Builder 完成 strict parse、snapshot、redaction、fixture、Slice、partition 和 seal 后形成 immutable Dataset Version；PM workspace CSV 不直接成为 Experiment 的 live input。

#### Domain Signal Sources

`evals/runs.csv`、`evals/loops.csv`、`evals/escapes.csv` 和允许进入优化证据的 `patches-pending` 通过 PM-owned `DomainSignalSource` 接入：

```text
typed readonly reader capability
  -> validate-evals-csv.sh / artifact schema preflight
  -> source revision + before cursor snapshot
  -> PM mapping: row -> evidence / case_seed / observed_outcome
  -> Core redaction + dedupe + normalized schema validation
  -> immutable SignalImportBatch + committed next cursor
```

PM mapping 必须固定 exact ref/hash，并为每类记录定义稳定 dedupe key、source provenance、workspace/package/agent correlation、critical Slice 和 sensitivity。Feature reader 只能读取声明的 `pmWorkspace` scope，不能直接写 Evaluation Store；只有 Core signal ingestor 可以提交 import batch。

`knowledge/cases.csv` 和 `knowledge/patterns/` 仍是 PM 领域知识事实源。只有明确选入 Dataset/evidence 的内容才通过独立 source/mapping 导入；Evaluation Store 不取代 pattern active/dormant 等 PM 知识生命周期。

#### Trigger Templates

PM Feature 可以发布推荐 Trigger Template：

- weekly regression：选择固定 regression Dataset、PM Metric/Evaluator Suite 和 budget，创建 Core Experiment/Report。
- monthly optimization：选择 evidence window、optimization/validation/holdout policy 和 candidate budget，创建 Core Evolution Campaign。
- post-promotion monitor：按新 exact ref 收集与 baseline 同定义的 PM observed outcome。

Template 安装后默认不等于启用。授权用户在 Evaluation Center materialize 为 Core-owned Trigger；schedule state、cooldown、dedupe、history、rerun 和 disable/delete 全部归 Evaluation Store。定时 Trigger 不得自动 seal 未审查的真实信号，也不得自动 Promote 需要 Human Review 的 Candidate。

#### Prompt Candidate Constraint

PM 发布 versioned `CandidateConstraint`，至少强制：

- `.claude/agents/*.md` 目标路径和 agent id 在 allowlist 内。
- baseline exact ref/hash 与 expected-before hash 一致。
- `LOCKED` 锚点和受保护段落逐字节保持不变。
- permission/tool/safety/output contract 不被删除或放宽。
- Candidate diff、目标版本和 dependency metadata 通过 closed schema。

Constraint 使用 pure、无 network、无 production mutation 的 validator capability，在 Candidate build、Experiment seal 和 Promotion preflight 三个边界固定同一 exact ref/hash 执行。任一 hard failure 直接阻断 Candidate，不能由普通 Prompt 审批覆盖。

#### Paired Regression 与 Review

Prompt Candidate 由 Core Candidate Builder 写入 staging/evaluation root，不先修改真实 PM workspace。WorkflowAdapter 使用相同 sealed Dataset、Fixture、预算和 environment 对 baseline/candidate 运行 paired replay；结果使用标准 Observation、Evaluator Result、Metric、Comparison Report 和 PM typed extension，不再定义 `PmPromptRegressionResult` 或“全部 case pass 即发布”的 PM 私有判定。

Candidate 只有同时通过 Core safety/reliability hard gate、PM critical Slice、validation/holdout、Candidate Constraint 和 Promotion Policy 才可进入 Review。PM Prompt Promotion Policy 固定要求 Human Review，monthly Trigger 不得自动 Promote。Prompt diff、失败 case、Trace/Artifact 对比、permission/effect/dependency diff 和 Review 均在 Evaluation Center 展示与决策；PM 页面只提供摘要和 deep link。

#### Promotion Binding 与依赖闭包发布

`.claude/agents/*.md` 是 prompt authoring source，不是 active run 的 live execution source。每个 PM delegation capability 固化 prompt/role/skill/executor exact ref/hash，Workflow 创建时由 Recipe snapshot pin；active run、retry 和 recovery 不读取 workspace latest prompt。

PM `PromotionBinding` 声明目标 Prompt Candidate 的正式发布闭包：

```text
optional authoring commit with effect receipt
  -> publish new prompt/agent/skill/executor/capability members as inactive
  -> publish new Definition referring to exact capability refs as inactive
  -> publish new Recipe as inactive
  -> verify complete dependency closure and member hashes
  -> atomically CAS PM creation catalog root to the new exact RecipeRef
  -> old active workflows continue on old executable snapshot
```

Promotion Gateway 根据 sealed Report、Review、Constraint Result 和 Binding 生成 immutable Promotion Bundle，并复用同一 bundle id/operation key 完成 authoring commit、inactive publish、activation receipt 和 crash recovery。任何中间失败都保持当前 PM creation catalog root 不变；已经发布的 inactive immutable members 可以保留，但不能被 production ingress 当作 active。禁止覆盖相同 `(resource id, version)`，禁止 Graph dispatch 解析 `latest`，也禁止 PM Feature 自己实现 `PromptPatchTransaction`。

`patches-pending/applied/rejected`、`optimization/agent-versions.json`、`optimization/PROMPT-CHANGELOG.md` 可由 authoring commit/export adapter 继续维护为兼容视图，但 Candidate、Experiment、Review、Promotion 和 active version 的权威事实分别归 Evaluation Store、Registry、Publisher receipt 与 PM creation catalog root。

### pm_iterate_a2 / pm_iterate_a7

迁移尾部和头部自动回炉循环：

```text
load_target_draft
-> run_fix_agent
-> run_review_agent
-> check_round_cap
-> completed_or_escalate
```

每轮 fix/review 使用新的 Node Attempt 或 Definition 明确的 rework State Activation，不能重开已 terminal Node/State。Round cap 同时由业务 rule 与 Workflow execution policy 的 `max_state_activations/max_state_transitions/usage_budget` 强制；进入新 activation 不重置累计预算，超限进入 `escalate` named exit。

### pm_named_case_workflows

迁移：

- `gen-cases`
- `gen-cases-spec`
- `coverage-audit`

单一确定性操作发布为 system capability；包含多 Agent、多步骤、retry 或 human decision 的流程必须成为 Graph/Workflow，不能隐藏在 host action/container adapter 内。结果仍通过 mutation protocol 写回原文件并保存 immutable snapshot。

## PM Capability Catalog

Definition 和 Graph Node 不再直接组合 `agent + skill + action + artifact contract`。Feature publisher 为 A1-A7、review、report、script、promote 等每种不同执行合同发布 exact capability，固定：executor implementation、persona/skill/prompt snapshot、typed ports、artifact/evaluator/quality gate、required tools/MCP/file scopes、retry/timeout、effect key 和 cancellation。

```text
pm.a1-gap-questions@1
pm.a1-write-requirement@1
pm.visual-clarification@1
pm.a2-requirement-review@1
pm.a3-tech-architecture@1
pm.a4-scope-review@1
pm.a6-generate-test-cases@1
pm.a7-test-case-review@1
pm.deliverable-final-check@1
pm.promote-deliverable@1
pm.update-knowledge-pattern@1
```

Node 只能提供 `capability_ref`、typed input binding 和更严格 retry/timeout。通用 `run-any-agent`、`run-any-script`、允许动态 prompt/tool/path 的 capability 禁止发布。不同 PM workspace 的 prompt 变体若改变执行合同，必须成为独立 versioned capability/Recipe dependency；不能把 workspace path 当作运行时 prompt override。

Prompt regression 使用 Evaluation `WorkflowAdapter` 调用这些正式 PM capability 的 baseline/candidate overlay；Candidate Constraint、Domain Signal reader 和 Promotion Binding 引用的 validator/reader/publisher protocol 属于 Evaluation Provider resources，不得伪装成 PM Workflow Node capability。

## Artifact Contract

需要把原 PM 文件契约补成 Icarus artifact contract。

关键 contract：

- `pm.pipeline_state.v1`
- `pm.a1_requirement.v1`
- `pm.visual_spec.v1`
- `pm.a2_review.v1`
- `pm.tech_architecture.v1`
- `pm.scope_review.v1`
- `pm.secondary_review.v1`
- `pm.test_cases_csv.v1`
- `pm.a7_review.v1`
- `pm.deliverable_package.v1`
- `pm.final_check_report.v1`
- `pm.retrospect.v1`
- `pm.evals_runs.v1`
- `pm.evals_loops.v1`
- `pm.evals_escapes.v1`
- `pm.knowledge_cases.v1`
- `pm.prompt_patch.v1`

Contract 不替代原脚本。脚本仍是权威机械检查之一，contract 用于 Icarus 统一展示、阻断、trace 和质量门。

上述名称在文档中是简写，registry 中统一使用 `{ id, version }` exact VersionedRef。Artifact/evaluator/quality gate 由 capability 固定；成功记录同时引用 live workspace locator、expected after hash 和 immutable snapshot。脚本 validation fail 属于 attempt quality decision，不直接改写外层 State。

`pm.evals_runs/loops/escapes` 是 PM Domain Signal Source 的输入合同，不是 Evaluation Observation/Metric/Report schema；`pm.prompt_patch.v1` 只用于兼容历史 evidence/candidate suggestion 导入。Prompt regression 结果使用 Evaluation Framework 标准 Observation、Evaluator Result、Metric 和 Comparison Report。

## Human Review 统一协议

PM Gate 不应该只是页面表单，而应该统一进入 human review/interrupt 协议。

目标 Runtime 中每类 Gate 发布 exact versioned approval wait contract，固定 correlation、payload/output schema、authorization、allowed channels、timeout/indefinite policy 和 action names。Interrupt authoring state lower 为一个 wait node；approval resolution 只发布 typed output，后续写 Markdown/`pipeline-state.json` 的 mutation 必须由独立 system capability 按 effect protocol 完成，不能把 DB wait CAS 与 filesystem write 假装成一个事务。

Gate 类型：

```ts
type PmGateKind =
  | 'gate_1_pm_qa'
  | 'gate_1_5_materials'
  | 'gate_1_5a_visual_qa'
  | 'gate_1_5b_visual_confirm'
  | 'gate_2_a5_decision'
  | 'gate_3_packaging_confirm'
  | 'gate_d1_module_split'
  | 'gate_d2_baseline_decision'
  | 'promote_confirmation';
```

Prompt Candidate/Promotion Review 使用 Evaluation Framework 的 Review/Promotion command 和 audit，不作为 `PmGateKind` 或 PM Workflow wait contract。

每个 Gate 需要：

- title。
- business impact。
- evidence links。
- actions。
- payload schema。
- allowed channels。
- audit fields。
- idempotency key。

每个 action 映射 Definition 中固定 named exit/transition，例如 `approve -> a2`、`request_revision -> 新的 a1 activation`、`reject -> cancelled/rejected terminal`。页面不能提交任意 target State；“回退”总是创建新的 State Activation 并保留旧 cut/artifact，不重开旧 Node。

PM 页面负责领域渲染，Execution Console 可用通用 action item 兜底展示。

## Hook 与防护迁移

原 `.claude/settings.json` 有三类能力：

- deny rules。
- PreToolUse `guard-bash.sh`。
- PostToolUse `post-csv-validate.sh`。
- SessionStart `session-start-brief.sh`。

迁移方式：

### deny rules

下沉到：

- container mount policy。
- file write policy。
- host script allowlist。
- system capability/effect permission。

例如：

- `code/**` 默认只读。
- 禁止直接 `mv deliverables/*.draft`，必须调用 promote action。
- archive 默认只读。
- git push 通过白名单 action 或原脚本。

### guard-bash

迁移为 container runner tool guard。

所有 bash/tool use 经过 policy 检查：

- 允许普通只读命令。
- 阻断绕过 promote 的 mv。
- 阻断危险 git push。
- 阻断写 code。
- 输出修复建议给 agent。

### post-csv-validate

迁移为对应 CSV mutation capability 固定的 blocking evaluator：

- mutation receipt 前执行对应 validate script 并保存 stdout/stderr/hash。
- validation pass 后才生成 immutable CSV snapshot并允许 node succeeded。
- validation fail 产生 attempt quality `needs_revision/fail`，不由异步 observer 直接改 State。
- 外部人工写入由 reconciliation scanner 发现 hash drift，只创建 action item，不越过 Graph CAS 修改已完成 node。

### session-start-brief

迁移为 workflow context pack：

- 在每个 PM delegation 前注入当前 workspace brief。
- 基于本次 node frozen input、immutable workspace manifest 和显式 provenance 生成，包含 active/draft/done 状态、pending gates、ledger 对账；active attempt 不重读 live brief。

## Script Runner

PM 脚本必须一脚本一 capability 白名单执行；下面的列表是 publisher 输入，不是 runtime 接受任意 path 的通用 runner。

允许列表初始包括：

- `scripts/next-id.sh`
- `scripts/promote.sh`
- `scripts/deliverable-final-check.sh`
- `scripts/validate-evals-csv.sh`
- `scripts/validate-pipeline-state.sh`
- `scripts/lint-skeleton.sh`
- `scripts/selftest.sh`
- `test/tools/lint-cases.js`
- `.claude/workflows/gen-cases.js`
- `.claude/workflows/gen-cases-spec.js`
- `.claude/workflows/coverage-audit.js`

所有执行记录写入 workflow event：

- capability/executor exact ref 与 implementation hash。
- operation key、domain claim id 和 fencing token。
- script path。
- schema-valid typed args。
- resolver 计算出的安全 cwd。
- exit code。
- stdout/stderr 摘要。
- duration。
- produced artifacts。
- before/after state hash、effect receipt 与 immutable snapshot ref。

## PM Pipeline Domain Projection

需要新增 PM 专属投影层。该投影层属于 `pm-pipeline` feature，由 `features/pm-pipeline/host/projection.ts` 维护，通过 `/api/features/pm-pipeline/*` 查询 API 暴露给 renderer。

示例接口：

```ts
interface PmPipelineRun {
  workflowId: string;
  workspaceId: string;
  packageName?: string;
  draftDir?: string;
  deliverableDir?: string;
  currentStage: PmStage;
  currentGate?: PmGate;
  agents: PmAgentStageSummary[];
  artifacts: PmArtifactSummary[];
  finalCheck?: PmFinalCheckSummary;
  metrics?: PmRunMetrics;
}

interface PmEvaluationSummary {
  owner: 'pm-pipeline';
  subjectRef: string;
  latestSignalImportRef?: string;
  latestReportRef?: string;
  activeCampaignRef?: string;
  pendingReviewRef?: string;
  nextTriggerAtMs?: number;
  evaluationCenterDeepLink: string;
}
```

Projection 来源：

- Task Intake/Recipe/Workflow/Graph Store。
- workbench/action/human review 表。
- agent query trace。
- effect receipt、domain claims 和 immutable artifact snapshots。
- PM workspace 文件扫描与 live-vs-snapshot hash drift。
- `pipeline-state.json` 及其最后成功 receipt/snapshot。
- script capability output 和 artifact contract evaluation。
- Core Evaluation query API 返回的 owner-scoped immutable refs/status summary。

Projection 可以缓存到 `feature_pm_pipeline_*` 表，但不能成为执行事实源或评估事实源。缓存必须可从 Graph Store、human review、trace、effect receipt、immutable artifact、PM workspace 领域文件和 Core Evaluation query API 重建；重建只恢复视图，不补写或猜测 Workflow transition、Experiment、Campaign、Candidate、Promotion 或 Trigger 状态。

## 与 Execution Console 的关系

PM Pipeline 每个 workflow 都能在 Execution Console 被看到，但 Console 只提供通用排障视图。

Console 应展示：

- workflow id。
- workflow type。
- current state。
- timeline。
- delegations。
- pending interrupts。
- artifacts。
- traces。
- raw payload。
- pause/retry-wait/cancel/policy-authorized skip。

Console 不需要展示：

- PM Gate 的完整业务化选择 UI。
- visual demo before/after 对比。
- deliverable 12 文档领域结构。

PM 页面可以提供“打开 Console”链接，用于排障。

Evaluation Center 与 Execution Console 分工：Console 展示 PM production Workflow 的 DAG/Trace/Artifact；Evaluation Center 展示 PM Evaluation Dataset/Experiment/Report/Campaign/Candidate/Promotion。两者通过 typed ref/deep link 关联，不互相复制状态。

## 一致性原则

### 不建双状态

错误模式：

```text
PM 页面保存 currentStep=A3
Workflow 保存 status=A2_review
pipeline-state.json 保存 current_step=A4
```

正确模式：

- Graph Store/cut 是执行事实。
- `pipeline-state.json` 和 deliverable 文件是 PM 领域事实，每次受控 mutation 保存 receipt 与 immutable snapshot。
- PM projection 展示 Graph 状态、最后成功 snapshot 与 live file hash 的三方关系。
- expected-before mismatch、receipt 不确定或 external drift 进入 `action_required/reconciliation`，修复动作使用同 operation key/fencing token，不能直接改 Graph 状态。

### 领域动作必须落回通用 command

PM 页面所有业务执行动作最终调用：

- `createWorkflowFromRecipe`（包含 creation key 与 claim acquisition）
- `resolveWorkflowWait`（approval contract + expected version + idempotency key）
- `pauseWorkflow`
- `resumeWorkflow`
- `cancelWorkflow`
- `advanceRetryWait`（只提前未 terminal 的 retry-wait）
- `executeDefinitionCommand`（只能选择 Definition 声明的 rework/remediation named command）
- `requestManualNodeSkip`（仅 paused、expected version、且 Definition/policy 明确允许）

不得直接改 workflow 表或直接移动包状态。

不提供任意 `returnWorkflowToStage`、`retryWorkflowStage` 或通用 `runWorkflowAction` 旁路。业务“回退”通过 Gate/Review named exit 进入 Definition 固定 target，并创建新的 State Activation/Graph Run；旧 cut、attempt 和 artifact 永不重开。页面若需要“让 A3 重写”，必须调用 Definition 已发布的 `request_a3_revision` command，而不是传入自由 target=`a3`。

PM 页面中的评估动作直接调用 Core Evaluation closed command，例如 `signals.import`、`experiment.run`、`evolve.start`、`promotion.request`，并携带 actor、idempotency key、expected row version 和 exact resource refs。PM API 不把这些命令翻译成 PM Workflow，也不直接写 `evaluation.db`、Registry 或 active catalog root。

### 文件事实源保持原样

原有文件仍是可移植产物事实：

- `PROJECT-PROFILE.md`
- `product-docs/_drafts/...`
- `deliverables/*.draft|active|done`
- `pipeline-state.json`
- `evals/*.csv`
- `knowledge/*.csv`
- `optimization/*`

Icarus Graph Store 是执行事实，不替代这些 live 文件产物；但每次 node success 必须保存对应 immutable snapshot/manifest/hash，确保 retry、恢复和审计不依赖后来已被修改的 live path。`evals/*.csv` 和 `optimization/*` 是 PM 领域/兼容文件，不是 Evaluation Dataset、Experiment、Candidate 或 Promotion 的权威事实；进入 Evaluation Framework 的内容必须经过 signal import 或 Dataset seal。

## 迁移资产清单

从 `ai_workspace_pm` 迁移时分两类处理。

进入 `features/pm-pipeline` 的功能包运行资产：

```text
.claude/agents/
.claude/commands/
.claude/skills/
.claude/workflows/
.claude/settings.json
deliverables/_template/
deliverables/_交付包终审清单.md
scripts/
docs/服务说明/
evaluation subject/dataset seed/domain signal/evaluator/metric/constraint/promotion/trigger definitions
README.md
```

保留在 PM workspace 的项目事实源。Managed 模式下根目录是 `data/features/pm-pipeline/workspaces/{workspaceId}`；external 模式下根目录是注册的现有目录：

```text
PROJECT-PROFILE.md
CLAUDE.md
product-docs/
deliverables/
test/
evals/
knowledge/
optimization/
pipeline-state.json
code/
scripts/
README.md
```

其中：

- `.claude/commands` 作为 workflow 编译输入或人工参考，不直接作为运行入口。
- `.claude/agents` 原文进入 `features/pm-pipeline/container/agents`，同时运行时兼容 PM workspace 原路径。
- `.claude/skills` 进入 `features/pm-pipeline/container/skills`，同时保持路径兼容。
- `.claude/workflows` 中 PM 业务操作迁成 exact host/container capability；原 pipeline review 和 prompt optimization 编排迁成 Evaluation Provider resources，不迁成 PM-owned Workflow。
- `scripts` 一部分作为 feature 提供的通用脚本模板和 allowlist runner，一部分作为 PM workspace 项目脚本事实源保留。
- `deliverables/_template` 进入 feature templates，同时初始化时复制或同步到 PM workspace。
- `evals/knowledge/optimization/product-docs/test/deliverables` 的项目实例数据保留在 PM workspace，不进入 feature 包；需要参与评估的内容通过 Dataset seed、Domain Signal Source 或历史 import 工具进入 Evaluation Store 的 immutable snapshot。

`features/pm-pipeline` 的资源目录应尽量保存通用模板、prompt、workflow definition、contract、adapter 和 Evaluation Provider definition；具体项目沉淀和交付产物必须留在 workspace。Evaluation Dataset/Experiment/Campaign/Candidate/Report/Promotion runtime facts 留在 Core `evaluation.db`，既不进入 feature 包，也不回写成 PM 私有状态机。

历史完整资产清单参考：

```text
.claude/agents/
.claude/commands/
.claude/skills/
.claude/workflows/
.claude/settings.json
deliverables/_template/
deliverables/_交付包终审清单.md
docs/服务说明/
evals/
knowledge/
optimization/
product-docs/
scripts/
test/
PROJECT-PROFILE.md
CLAUDE.md
README.md
```

## 验收标准

完整迁移的验收不以自然语言输出逐字一致为标准，而以流程、契约、状态和产物一致为标准。

必须满足：

- `features/pm-pipeline/feature.json` 可被 Feature Package Runtime 扫描、校验和启用。
- `PM Core Pipeline Activation` 只有在 Dynamic Workflow Runtime Production Activation 后才能通过；`PM Full Migration Activation` 还必须等待 Evaluation Framework Production Activation 和 PM Evaluation Provider Integration Gate。
- 未启用 `pm-pipeline` 时，PM 导航、PM API、PM workflow create option、PM container resources、PM migrations 和 PM Evaluation Provider resources 都不可用于新执行。
- 启用 `pm-pipeline` 后，一级导航出现 PM Pipeline，API prefix 为 `/api/features/pm-pipeline`。
- 启用 `pm-pipeline` 后，core 自动 provision `feature:pm-pipeline:main` 独占 group 和 `groups/pm_pipeline_main/CLAUDE.md`。
- PM Recipe/routing scope/execution policy、workflow definitions、capabilities、schemas、graph interfaces/templates/policies、wait contracts、cards、artifact contracts、workflow evaluators、agents、skills、scripts、templates，以及 Evaluation Subject/Dataset seed/Domain Signal Source/Experiment Evaluator/Metric Suite/Candidate Constraint/Promotion Policy/Binding/Trigger Template 均通过 feature resources 注册，不静态写入 core 资源目录。
- PM projection/config/cache 表均使用 `feature_pm_pipeline_` 前缀。
- PM Feature 不创建 schedule、dataset、experiment、campaign、candidate、promotion 或 trigger runtime state 表，不直接写 `evaluation.db`。
- `src/channels/web.ts`、core renderer 主文件和 core workflow registry 不出现 PM 业务静态 import 或 PM 业务硬编码路由。
- Managed PM workspace 默认创建在 `data/features/pm-pipeline/workspaces/{workspaceId}`；external workspace 可注册已有目录。
- PM workflow 的 artifact root 指向 PM workspace 的 `deliverables/{packageId}`，不依赖 `projects/{service}/iteration/{deliverable}`。
- PM workflow 的 context pack root 指向 PM workspace 的 `workflow-context/{workflowId}/{stageKey}`，不依赖 `projects/{service}/workflow-context`。
- Workbench artifact 能索引 PM workspace 下的 PM 业务文件，并通过 PM artifact contract 校验。
- 每个成功 mutation node 都有 operation key、claim/fencing token、before/after receipt 和 immutable file/directory snapshot；live workspace 后续变化不改写历史 artifact。
- 原 `/new-feature` 的 A1-A7 顺序和条件分支一致。
- 所有 Gate 均显式暂停，PM 不确认不继续。
- UI 类需求触发 A1.5，非 UI 类跳过并留痕。
- A4 触发 A5 的条件一致。
- A6/A7 CSV schema 和 lint 行为一致。
- 生成的 `.draft` 包目录和文件结构一致。
- `deliverable-final-check.sh` 能被调用并阻断 BLOCKER。
- `.draft -> .active -> .done -> archive` 必须通过 promote action。
- `.done` 后 retrospector 写入 `runs.csv`、`loops.csv`、`cases.csv`、`patches-pending`。
- `runs/loops/escapes` 通过 exact Domain Signal Source、cursor、dedupe、redaction 和 PM mapping 进入 immutable Signal Import Batch；同一 source revision/cursor window 重放不重复生成 logical signal。
- `evals/regression-set` 通过 Dataset Builder seal 为 immutable optimization/validation/holdout Dataset，不在 Experiment 中读取 live workspace CSV。
- `pipeline-state.json` 保留并被持续更新。
- 同一 PM Workflow API/button creation key 的并发或重复请求只产生一个 Workflow；同一 package 冲突 Workflow 在 T0 原子返回 `resource_busy`。Evaluation Trigger/Experiment/Campaign/Promotion 使用 Evaluation Framework 自己的 dedupe/idempotency key。
- PM 页面和 Execution Console 看到同一个 workflow 状态。
- retry、pause、cancel、skip 不产生状态分裂。
- Definition-authorized rework 创建新 activation，不重开 terminal State/Node；任意 target 回退和通用 action 旁路被拒绝。
- Prompt Candidate 在 build、Experiment seal 和 Promotion preflight 三个边界通过同一 exact PM Candidate Constraint，`LOCKED`、expected-before hash 和 Core safety/tool/output contract hard failure 不可被普通批准覆盖。
- Prompt baseline/candidate 使用同一 sealed Dataset/Fixture/budget/environment 做 paired replay，并生成标准 Comparison Report；PM 不创建私有 regression runner/result/store。
- Promotion Gateway 按 PM Promotion Binding 生成 immutable Promotion Bundle，先发布 inactive capability/Definition/Recipe 闭包，再原子 CAS PM creation catalog root；旧 active run 继续使用旧 executable snapshot，新 run 使用新 exact RecipeRef。
- Promotion Bundle 任意中间失败保持旧 catalog root 不变，并可用相同 bundle id/operation key 和 receipt 恢复；PM Feature 无 `PromptPatchTransaction` 或 active pointer 权限。
- Feature draining 阻止新 Workflow 但不卸载 active run executor；action-required/quarantined run 未处置前不能 disable/delete。
- Feature draining 同时阻止选择新的 PM Evaluation Subject/Provider resource；已 sealed Experiment/Campaign/Promotion Bundle 使用 pinned refs 收敛后，相关 active evaluation refs 清零才允许 disable/delete。
- Crash fixture 覆盖 promote/CSV write、signal batch commit/cursor advance、authoring commit、inactive member publish 和 creation catalog CAS 各边界；外部结果不确定时不重复写并进入 action-required。
- 原 `code/` 写保护和 archive 写保护仍生效。

## 风险与处理

### 风险 0：名义上是 feature，实际仍耦合进 core

处理：

- PM 业务 API 只能通过 `FeatureContext.api` 注册到 `/api/features/pm-pipeline/*`。
- PM 一级导航只能来自 `feature.json` manifest。
- PM renderer 必须是 feature renderer entry，不能继续并入 core 主 `app.js` 的业务分支。
- PM workflow、card、agent、skill、artifact contract、script 必须通过 feature resource registry 加载。
- PM Evaluation resources 必须通过通用 Evaluation resource union 注册；Core 不出现 PM CSV、LOCKED anchor 或 PM catalog 特判。
- core 只保留通用 extension point、feature management、Execution Console 和 Evaluation Framework 能力。

### 风险 1：PM 页面过强，绕开 workflow

处理：

- 所有 PM 业务执行动作只能调用 workflow command；评估动作只能调用 Core Evaluation command。
- 页面无权直接推进 stage。
- 所有 stage transition 由 workflow runtime 写 event。
- 页面无权直接创建 Evaluation DB row、执行 Candidate validator、调用 Publisher 或切换 catalog root。

### 风险 1.5：PM 产物路径被迫贴合 `projects/{service}`

处理：

- PM feature 自己定义 PM workspace 目录契约。
- PM workflow 明确设置 artifact root 和 context pack root。
- PM artifact contract 校验 PM workspace 下的业务文件。
- Workbench artifact 只做索引，不决定 PM 业务目录结构。

### 风险 2：为了兼容 Console 限制 PM 页面

处理：

- 只兼容底层协议，不兼容页面形态。
- PM 页面可自由扩展领域组件。
- Console 只做 raw fallback。

### 风险 3：文件事实源与 DB 不一致

处理：

- 所有 mutation 使用 intent -> apply -> verify receipt -> immutable snapshot -> node success 协议。
- Projection 显示 Graph cut、最后成功 snapshot 和 live file hash，不以最后写入者获胜。
- `pipeline-state.json`、deliverable 状态、effect receipt、workflow status 四方对账；expected-before mismatch 进入 action-required。

### 风险 3.5：多个 Workflow 并发修改同一 Workspace

处理：

- PM Recipe 在 T0 按 workspace/package 粒度原子获得 durable claim；Evaluation 的 signal/experiment/candidate/promotion 竞争由 Evaluation Framework 的 lease、dedupe 和 Promotion Bundle CAS 管理。
- Host adapter 强制检查单调 fencing token，stale worker 即使仍在运行也不能写入。
- Claim 不靠普通 lease 自动过期，terminal/cancel/abandon 释放均保留审计。

### 风险 4：原 prompt 路径依赖强

处理：

- PM workspace 保留原目录结构作为 authoring/domain source。
- Publisher/staging adapter 可以提供原路径兼容，但 active run 只使用 pinned executable/capability snapshot。
- PM Candidate Constraint 固定目标 allowlist、expected-before hash、LOCKED 和受保护 contract。
- Promotion Binding 通过 inactive dependency closure + atomic creation catalog root 发布新 capability/Definition/Recipe version，不原地改变旧 run 执行合同。

### 风险 4.5：名义接入 Evaluation Framework，实际仍保留 PM 自有评估引擎

处理：

- 不发布 `pm_pipeline_review`、`pm_optimize_prompts` Recipe/Definition。
- 不创建 PM-owned Experiment/Campaign/Candidate/Promotion/Trigger 表或 scheduler。
- 不保留私有 regression result、Metric Engine、Candidate Builder、PromptPatchTransaction 或 active pointer updater。
- PM 页面只查询 owner-scoped Evaluation summary；权威操作跳转或调用 Core Evaluation closed API。
- `evals/*.csv`、`optimization/*` 仅作为领域 source/兼容 view，经 signal import、Dataset seal 或 Publisher receipt 后才进入 Core 事实链。

### 风险 5：LLM 输出无法逐字一致

处理：

- 验收改用结构、contract、script、Gate、产物一致。
- 对关键字段使用 artifact contract 和脚本硬闸。
- 对 golden case 做语义和结构 diff。

## 推荐落地顺序

虽然本方案按完整迁移设计，不以 MVP 为目标，但工程落地仍建议按依赖顺序实现，避免循环返工：

1. 先完成 `docs/dynamic-workflow-runtime.md` 索引的统一 Graph Runtime、T0 Recipe creation、Feature Graph resource manifest、domain claims、effect receipt/snapshot、wait contract 和 draining/executor retention。
2. Dynamic Runtime Production Activation 后并行推进两个工作流：
   - PM Core Track：创建 `features/pm-pipeline` scaffold、workspace registry、required group 和 Feature lifecycle。
   - Evaluation Track：按 `evaluation-self-evolution-framework.md` 完成 E0-E6，尤其是 Domain Signal Source、Candidate Constraint、Promotion Binding/Bundle 和 Trigger Template。
3. PM Core Track 发布 Recipe/routing scope/execution policy/capability/schema/interface/template/wait resources，并以 compiler fixture 验证依赖 closure。
4. Human review 统一为 versioned approval wait contract + Definition named exits；Hook/policy 迁为一脚本一 capability、typed args/cwd resolver、file guard 和 effect receipt。
5. PM asset publisher 将 agents、skills、scripts、templates 迁入 Feature authoring resources并发布 exact executable/capability version。
6. PM 业务 workflow definitions 迁入 `features/pm-pipeline/container/workflow-definitions`，删除旧多步骤 system/transition delegate/任意回退旁路；不迁入 `pm_pipeline_review` 或 `pm_optimize_prompts`。
7. 实现 PM Pipeline Domain API / Projection、renderer 一级页面、Execution Console deep link 和 PM Workspace live-vs-snapshot 对账。
8. 完成 PM Core Pipeline 的 Golden、concurrency、T0 creation、T1-T8 crash 和 mutable effect 验收，通过 `PM Core Pipeline Activation`。
9. 发布 PM Evaluation Subject、Dataset seed、Domain Signal Source、Experiment Evaluator、Metric Suite、Candidate Constraint、Promotion Policy/Binding 和 Trigger Template，并通过 Feature manifest closed-schema 校验。
10. 导入历史 regression cases 与领域信号，验证 cursor/dedupe/redaction/provenance；建立 optimization/validation/holdout partition。
11. 验证 paired baseline/candidate replay、PM critical Slice、LOCKED Candidate Constraint 和 owner-scoped Evaluation Center 投影。
12. 验证 Promotion Bundle 的 authoring commit、inactive capability/Definition/Recipe publish、atomic creation catalog CAS、crash recovery、old active run pinning 和 post-promotion monitor。
13. 验证 Feature `enabled -> draining -> disabled` 同时处理 active Workflow refs 和 active Evaluation refs，不让 active run 直接只读停尸。
14. Evaluation Framework Production Activation 与 PM Evaluation Provider Integration Gate 都通过后，完成 `PM Full Migration Activation`，再冻结旧 Claude Code 的 pipeline review/prompt optimization 入口。

这不是功能裁剪。PM Core Track 可以先交付，但 weekly evaluation、prompt optimization 和完整迁移验收必须等待 Evaluation Track 与 Provider 集成完成。

## 最终形态

最终 Icarus 中会形成一套可复用模式：

```text
features/{featureId}
  -> feature.json
  -> host API / projection / migrations
  -> renderer entry / 业务一级页面
  -> workflow/container resources
  -> evaluation provider resources
        |
        v
Feature Package Runtime
  -> nav / api / Recipe + Graph + Evaluation resources / group provisioning
  -> enabled / draining / disabled / deleting
        |
        v
业务一级页面
  -> 业务 Domain Projection
  -> Task Intake + exact Recipe creation
  -> Unified Graph Runtime + domain claims + effect journal
  -> Versioned Capability / Container Agent / Host Adapter
  -> live 文件领域事实 + immutable execution snapshots

Execution Console
  -> 同一个 Workflow Runtime

Evaluation Center
  -> owner-scoped Domain Signal / Dataset / Experiment / Report
  -> Campaign / Candidate Constraint / Promotion Bundle / Trigger
  -> 同一个 Core Evaluation Framework
```

PM Pipeline 是第一套复杂业务 feature package。后续其他 agent team、运维流程、自我进化、员工支持、知识生产等，都可以复用这套结构：feature package 动态启用；独立业务页面，不共享页面上限；统一执行内核，不分裂状态和审计。
