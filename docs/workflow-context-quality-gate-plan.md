# Workflow Context Pack 与质量门通用方案

## 背景

当前 workflow delegation 的质量主要依赖：

- workflow definition 中的 `task_template`。
- skill 文档中要求 agent 自行阅读代码和附件。
- artifact contract 检查产物是否存在、字段是否齐全。
- stage evaluator 检查少量章节或结构化字段。
- LLM judge sidecar 做补充语义判断。

这套机制可以保证“产物大致存在且格式合规”，但不能稳定保证：

- 委托 agent 拥有足够业务上下文。
- agent 没有把其他服务经验混入当前任务。
- 方案、实现、测试或其他阶段产物完整覆盖了输入需求。
- 产物结论可由证据追溯，而不是模型推测。
- 不同 workflow 能以统一方式声明上下文、产物和质量门。

本方案目标是引入系统级能力：`Context Pack`、`Context Readiness Gate`、`Traceability Coverage` 和 `Quality Gate Pipeline`。它们应服务所有 workflow，而不是为某个流程硬编码。

## 目标

- 在每次 delegation 前，由系统构建可审计、可复现的上下文包，而不是让 agent 随机检索。
- 通过 workflow 配置声明阶段需要哪些上下文，不把业务逻辑写死在系统代码里。
- 对输入和历史产物做范围过滤、证据检查和污染隔离。
- 要求阶段产物输出结构化覆盖关系，使系统能检查“输入是否被处理、决策是否有证据、风险是否有验证”。
- 将质量门抽象为可配置 evaluator pipeline，支持不同 workflow 复用。
- LLM judge 作为语义补充，不作为唯一事实来源。

## 非目标

- 不让系统理解所有业务细节后替代 agent 设计方案。
- 不要求第一版支持复杂向量数据库或语义召回。
- 不把所有召回内容无差别塞进 prompt。
- 不取消人工审批；本方案只减少低质量产物进入人工环节的概率。

## 核心概念

### Context Requirement

workflow stage 对上下文的声明。它描述“本阶段需要哪些来源、最低完整性要求、污染过滤策略和缺失处理方式”。

示例：

```json
{
  "context_requirements": {
    "readiness_policy": "block_if_required_missing",
    "on_block": {
      "target": "context_input",
      "retry_action": "submit"
    },
    "sources": [
      {
        "id": "user_input",
        "type": "workflow_input",
        "required": true
      },
      {
        "id": "prior_artifacts",
        "type": "artifact",
        "required": false,
        "refs": ["plan_doc", "dev_doc"]
      },
      {
        "id": "service_codebase_location",
        "type": "codebase_location",
        "required": true,
        "service": "{{service}}",
        "fields": ["repo_path", "container_path"],
        "verify_exists": true,
        "verify_mounted_for_role": true
      }
    ]
  }
}
```

第一版只允许三类 source：`workflow_input`、`artifact`、`codebase_location`。`codebase_location` 只表示代码库位置、宿主机路径存在性和目标 role 容器挂载可达性，不能携带代码摘要、搜索结果、调用链、影响文件或业务结论。

### Context Pack

系统在 delegation 前生成的上下文包。它不是搜索结果列表，而是经过整理和证据化后的阶段材料。

建议结构：

```json
{
  "version": 1,
  "workflow_id": "wf-xxx",
  "stage_key": "plan",
  "round": 1,
  "attempt": 1,
  "service": "catstory",
  "generated_at": "2026-05-26T10:00:00.000Z",
  "pack_path": "/workspace/projects/catstory/workflow-context/wf-xxx/plan/latest.json",
  "immutable_pack_path": "/workspace/projects/catstory/workflow-context/wf-xxx/plan/context-pack.r1.a1.json",
  "hash": "sha256:...",
  "readiness": {
    "status": "ready",
    "missing_required_sources": [],
    "open_questions": [],
    "conflicts": []
  },
  "prompt_summary": "",
  "query_plan": [],
  "input_refs": [],
  "prior_artifacts": [],
  "codebase_location_refs": [],
  "excluded_candidates": [],
  "evidence_index": []
}
```

### Traceability Coverage

阶段产物必须输出的结构化覆盖关系。系统评估的核心不是文档是否“看起来完整”，而是输入、决策、动作、验收和证据是否形成闭环。

通用结构：

```json
{
  "statements": [],
  "decisions": [],
  "assumptions": [],
  "risks": [],
  "actions": [],
  "acceptance_criteria": [],
  "evidence": [],
  "coverage": [
    {
      "source_id": "INPUT-001",
      "covered_by": ["DEC-001", "ACT-001", "CHECK-001"],
      "evidence": ["EVID-001"]
    }
  ],
  "open_questions": []
}
```

### Evidence Ref 来源

证据编号不应只来自 Context Pack。Context Pack 中的 `INPUT-*`、`ART-*`、`EVID-*` 表示委派前系统已知、已过滤、已编号的证据；agent 在执行阶段通过阅读代码、检索 wiki、运行命令、查看日志或调用专项工具获得的新事实，也必须写入阶段产物的 `evidence`，生成新的 evidence ref 后再被 decision、action、test result 引用。

建议区分两类证据：

- 预置证据：来自 Context Pack，例如 `INPUT-001`、`ART-001`、`EVID-001`。
- 运行时新增证据：来自 agent 执行过程，例如 `EVID-CODE-001`、`EVID-WIKI-001`、`EVID-CMD-001`、`EVID-EXEC-001`。

运行时新增 evidence 必须包含可校验来源：

- 代码证据：代码库 ref、分支或 commit、文件路径、函数/符号、行号范围、摘要。
- wiki 或外部文档证据：URL、标题、retrieved_at、所属 scope、摘要。
- 命令或测试证据：命令、工作目录、退出码、关键输出摘要、日志或报告路径。
- 日志或观测证据：来源系统、时间范围、查询条件、关键片段或报告路径。

`CODEBASE-*` 只表示代码库位置或路径存在性，不能直接支撑业务或实现结论。agent 基于代码得出的结论，必须新增 `EVID-CODE-*` 等证据并接受 Evidence Evaluator 校验。无法提供证据的内容只能进入 `assumptions` 或 `risks`，不能作为 blocking decision 的依据。

当前项目的 `WorkflowEvalEvidence` 只能表达少量 `type/path/summary` 字段，不能直接承载上述证据。实现时必须先扩展证据类型和字段，再启用 blocking Evidence Evaluator。第一版允许 Context Pack 写入扩展 evidence JSON，但 workflow stage evaluation 只记录摘要；Phase 3 后再要求阶段产物输出完整 evidence ref。

## 系统如何知道收集什么

系统不应自行猜测要收集什么。Context Pack builder 只读取 workflow definition 中当前 stage 的 `context_requirements`。

第一版只支持显式 source，因此不需要搜索词预填充。`query_plan` 只记录本阶段按配置解析出的 source 计划：

- workflow 元数据：`workflow_type`、`stage_key`、`role`、`skill`、`service`。
- 配置声明的 source 第一版仅允许：`workflow_input`、`artifact`、`codebase_location`。
- 每个 source 的 `required`、`refs`、`fields`、`required_when`、`on_missing`。
- 服务配置中用于解析 `codebase_location.repo_path` 和 `codebase_location.container_path` 的字段。

代码类上下文第一版统一命名为 `codebase_location`，只用于定位代码库，不用于替代 coding agent 阅读代码。当前项目服务仓库来自 `agents/global/services.json` 的 `repo_path`，容器路径为 `/workspace/repos/{repo_path}`；`icarus` 等特殊服务如已有明确约定，可由 provider 解析为 `/workspace/project`。Context Pack 只提供 `repo_path`、`host_path`、`container_path`、路径存在性和目标 role 所在 agent 是否具备该服务挂载能力；不应预先做代码搜索、代码摘要、调用链推断、受影响文件判断或分支状态判断。分支字段继续通过 workflow context 和 `context.require` 校验。

示例 Query Plan：

```json
{
  "sources": [
    {
      "id": "user_input",
      "type": "workflow_input",
      "fields": ["requirement_description", "requirement_files"]
    },
    {
      "id": "plan_artifacts",
      "type": "artifact",
      "refs": ["plan_doc", "plan_coverage"]
    },
    {
      "id": "service_codebase_location",
      "type": "codebase_location",
      "fields": ["repo_path", "container_path"]
    }
  ]
}
```

Query Plan 必须写入 trace，便于审计“为什么收集这些材料”。

## 上下文防污染机制

### 1. Scope Gate

候选必须满足作用域：

- 当前服务 scope：`service:{service}`。
- 当前 workflow context 目录；若已有 deliverable，再允许当前 deliverable 目录。
- 显式声明的跨服务依赖或外部 evidence source。

默认拒绝其他服务的产物。跨服务材料必须由 workflow 配置、服务依赖映射或上游产物中的依赖事实触发。

### 2. Evidence Gate

关键结论必须有证据。对于不同 source 类型，证据可以是：

- workflow input 的字段路径或附件路径。
- artifact 的文件路径和片段。
- codebase_location 的容器路径和路径存在性校验记录；它只能证明代码库位置，不能直接证明业务或实现结论。
- agent 阅读代码后在阶段产物中新增的代码 evidence，例如文件、符号、行号范围和摘要。
- agent 执行 command、测试、脚本或 API 调用后新增的执行 evidence。
- agent 检索 wiki、日志或其他授权 provider 后新增的外部 evidence。
- 授权 provider 产出的截图、结构化状态、网络、日志、case/assert 记录。

### 3. Freshness Gate

对易变信息做时效控制：

- 发布、部署、环境、API、依赖版本、组织流程等过期后降权或阻断。
- workflow 配置可按 source 设置 `max_age_days`。

### 4. Conflict Gate

若多个 source 互相冲突：

- 不自动选择其一。
- 记录到 `readiness.conflicts`。
- 若冲突影响 required context，则 readiness 为 `blocked` 或 `needs_input`。
- 可生成 human input 或 review 请求。

### 5. Budget Gate

上下文包应有 token/字节预算：

- workflow input、required artifact 和 required evidence 优先。
- excluded candidates 只保留 reason，不注入 prompt。
- 超预算时按 required、source priority、stage intent 排序。

## Context Pack 构建流程

```text
workflow state prepared
  -> load context_requirements
  -> extract signals from workflow input / artifacts / service config
  -> build query plan
  -> retrieve candidates from configured sources
  -> apply gates: scope/evidence/freshness/conflict/budget
  -> write versioned context pack json and latest.json
  -> patch workflow.context with context_pack metadata
  -> readiness gate decides continue / block / ask human
  -> delegate with context_pack injected
```

### Context Pack 文件写入规则

第一版固定生成两个文件：

```text
projects/{service}/workflow-context/{workflow_id}/{stage_key}/context-pack.r{round}.a{attempt}.json
projects/{service}/workflow-context/{workflow_id}/{stage_key}/latest.json
```

`context-pack.r{round}.a{attempt}.json` 是不可变审计文件；`latest.json` 是 prompt 中传给 agent 的稳定入口。二者内容可以相同，但 `latest.json` 必须包含 `immutable_pack_path` 和 `hash`，让 agent 和 reviewer 能确认它指向哪一次生成结果。

写入步骤：

1. 校验 `service`、`workflow_id`、`stage_key` 为安全 path segment。
2. 在目标目录写入临时文件，例如 `.context-pack.r1.a1.json.tmp-{pid}`。
3. fsync 或完成写入后 rename 为不可变文件。
4. 再用同样方式写入并 rename `latest.json`。
5. 计算 hash 后写入 workflow context。hash 以不可变文件内容为准。

### Readiness Gate 状态语义

`readiness.status` 取值：

- `ready`：可继续委派。
- `warning`：存在非阻断缺口，继续委派，但 prompt 注入 warning。
- `needs_input`：缺少用户或上游系统必须补充的信息，应进入 human input。
- `blocked`：当前配置要求的 source 缺失、冲突或 scope 不合法，不能创建 delegation。

阻断时不得只复用当前 `before_delegate` hook failure 的行为。当前 hook failure 会清空 `current_delegation_id` 并同步一条失败提示，但没有天然 human input 和 resume retry 语义。Readiness Gate 必须显式产生以下其一：

- 转入 workflow definition 中配置的 `human_input` interrupt。
- 转入专门的 `context_blocked` 状态，并提供补充上下文后重试当前 stage 的 resume action。

Blocking readiness 必须在 `context_requirements.on_block` 中显式声明恢复路径：

```json
{
  "context_requirements": {
    "readiness_policy": "block_if_required_missing",
    "on_block": {
      "target": "context_input",
      "retry_action": "submit"
    }
  }
}
```

编译期校验规则：

- 只要 `readiness_policy` 是 blocking，就必须配置 `on_block.target` 和 `on_block.retry_action`。
- `on_block.target` 必须指向 `interrupt.kind=human_input`，或指向专门的 `context_blocked` 状态。
- 若目标是 `human_input` interrupt，则 `retry_action` 必须存在于该 interrupt 的 `allowed_actions` 和 `on_resume` 中。
- 若目标是 `context_blocked` 状态，则该状态必须提供“补充上下文后重试当前 stage”的 resume action，且不能落回普通 hook failure。

若 workflow 未配置合法阻断目标，Phase 2 的编译校验应禁止该 stage 将 readiness policy 配为 blocking。

## Delegation Prompt 注入

委派 prompt 不应注入所有原始候选。Context Pack builder 生成后，必须将以下 key 写入 workflow context，因此它们会通过现有模板变量机制暴露给 prompt：

- `{{context_pack_path}}`
- `{{context_pack_immutable_path}}`
- `{{context_pack_summary}}`
- `{{context_pack_open_questions}}`
- `{{context_pack_hash}}`
- `{{context_readiness_status}}`

为了避免每个 workflow 的 `task_template` 都手动追加同一段指令，第一版应在 delegation task finalization 阶段统一追加 Context Pack 指令。模板可以继续显式引用这些变量，但系统级注入必须覆盖所有 delegation。

agent 指令中要明确：

- 关键结论必须引用 Context Pack 中已有的 `INPUT-*`、`ART-*`、`EVID-*`，或引用阶段产物中新增且可校验的 evidence ref。
- agent 自行阅读代码、检索 wiki、查看日志、运行命令或调用工具得到的事实，必须先写入产物 `evidence`，再被 decision、action、test result 引用。
- `CODEBASE-*` 只表示代码库位置，不能作为业务或实现结论依据。
- 不允许把 excluded candidates 当事实。

## 质量门 Pipeline

每个 stage 可声明 quality gate：

```json
{
  "quality_gate": {
    "pass_policy": "all_blocking_pass",
    "evaluators": [
      {
        "type": "schema",
        "blocking": true
      },
      {
        "type": "artifact",
        "blocking": true
      },
      {
        "type": "context_coverage",
        "blocking": true
      },
      {
        "type": "evidence",
        "blocking": true
      },
      {
        "type": "consistency",
        "blocking": true
      },
      {
        "type": "llm_judge",
        "blocking": false
      }
    ]
  }
}
```

### Schema Evaluator

检查返回 JSON 和结构化产物是否满足 output contract。

### Artifact Evaluator

检查文件存在、路径合法、frontmatter、大小、必填 section。

### Context Coverage Evaluator

检查：

- required input 是否都被 coverage 覆盖。
- decisions/actions/checks 是否引用事实或输入。
- open questions 非空时不能 passed，除非配置允许。

### Evidence Evaluator

检查：

- 关键 decision、action、test result 是否有 evidence。
- evidence ref 是否存在于 Context Pack 或产物中。
- 产物新增 evidence 是否包含来源、路径/URL/命令记录、时间或版本信息、摘要。
- 新增 evidence 是否满足当前服务 scope；跨服务、外部文档或 provider 证据必须来自配置允许的来源或上游产物中的依赖事实。

### Consistency Evaluator

检查：

- workflow context、handoff result、artifact frontmatter 是否一致。
- 分支、服务、deliverable 是否一致。
- 上游产物中的约束是否被当前产物继承或明确变更。

### Execution Evaluator

用于需要真实执行的阶段：

- 命令、脚本、测试、部署、API 调用是否有执行记录。
- 结果计数是否和报告内容一致。
- 失败项是否有 bug 或 finding。

### LLM Judge

LLM judge 只做语义补充：

- 查找遗漏、矛盾、泛泛表述。
- 判断自然语言中的风险是否充分。
- 给出 needs_revision 建议。

第一版建议仍作为 sidecar；当确定性 evaluator 成熟后，再允许特定流程配置为 blocking。

### 与现有 evaluator 的关系

当前项目在 delegation 完成后固定执行 stage rules、artifact contract、结果 merge 和 LLM judge sidecar。Quality Gate Pipeline 不应第一步另起一套并行结论，而应先包装现有链路：

- `schema`：复用 handoff payload 和 artifact contract payload 校验。
- `artifact`：复用现有 artifact contract 文件校验。
- `stage_rules`：复用当前 `evaluateWorkflowStage()` 的阶段规则。
- `llm_judge`：继续作为 sidecar，默认 non-blocking。

新增 `context_coverage`、`evidence`、`consistency`、`execution` evaluator 在 Phase 3/4 接入。接入前，`quality_gate` 配置可以声明这些 evaluator，但编译校验必须阻止将未实现 evaluator 配为 blocking。

Pipeline 必须保留 evaluator 分项结果，不能只写一个最终 `hybrid` verdict。当前 `workflow_stage_evaluations.evaluator_type` 是文本列，可直接存新 evaluator type；TypeScript 的 `WorkflowStageEvaluatorType` union 需要同步扩展为 `schema`、`artifact`、`stage_rules`、`context_coverage`、`evidence`、`consistency`、`execution`、`llm_judge`、`quality_gate` 等类型。Phase 4 的推荐记录方式：

- 每个 evaluator 产出独立 result，包含 `status`、`score`、`summary`、`findings`、`evidence`、`blocking`、`source_evaluation_ids`。
- blocking evaluator 失败时，最终 `quality_gate` result 负责聚合并驱动 transition，但原始分项 result 必须可审计。
- 第一版包装现有链路时，`artifact`、`stage_rules`、`llm_judge` 应保留独立 evaluation record；如暂不拆 record，也必须在 `quality_gate` result 的 findings/evidence 中保留 evaluator type 和原始 evaluation id。
- UI/trace 展示应能定位“哪个 evaluator 阻断”，而不是只展示 `hybrid` 或 `pending`。

## 数据存储

第一版使用 JSON 文件作为权威存储，不建表，不依赖 deliverable，不做路径 fallback。Context Pack 是 workflow 运行态材料，统一写到 service 级目录：

```text
projects/{service}/workflow-context/{workflow_id}/{stage_key}/context-pack.r{round}.a{attempt}.json
projects/{service}/workflow-context/{workflow_id}/{stage_key}/latest.json
```

容器内路径对应：

```text
/workspace/projects/{service}/workflow-context/{workflow_id}/{stage_key}/context-pack.r{round}.a{attempt}.json
/workspace/projects/{service}/workflow-context/{workflow_id}/{stage_key}/latest.json
```

约束：

- `service`、`workflow_id`、`stage_key` 只能使用安全 path segment，禁止空字符串、`.`、`..`、斜杠、反斜杠和绝对路径。
- 写入时先写临时文件，再原子 rename，避免 delegated agent 读到半截 JSON。
- `latest.json` 作为 prompt 中的稳定入口，同时内容中必须记录实际 `round`、`attempt`、`immutable_pack_path` 和 `hash`。
- `context-pack.r{round}.a{attempt}.json` 保留历史，支持审计和复现。
- Context Pack 不收集敏感上下文值，尤其不能把 `access_token` 等凭据写入 JSON。需要引用时只写 redacted 标记和字段路径。
- 大文件、日志、截图和长文档不直接内嵌，只写来源 ref、摘要、hash 或报告路径。

同时将以下元数据写入 workflow context：

```json
{
  "context_pack_path": "/workspace/projects/catstory/workflow-context/wf-xxx/plan/latest.json",
  "context_pack_immutable_path": "/workspace/projects/catstory/workflow-context/wf-xxx/plan/context-pack.r1.a1.json",
  "context_pack_hash": "sha256:...",
  "context_pack_summary": "...",
  "context_pack_open_questions": "无",
  "context_readiness_status": "ready",
  "context_pack_generated_at": "2026-05-26T10:00:00.000Z"
}
```

后续如果需要更强查询能力，可以再加 DB 索引，但 DB 不是第一版的一部分。

## 当前代码落点

主要改动位置：

- `src/workflow-definition.ts`
  - 增加 `context_requirements`、`quality_gate` 类型。
- `src/workflow-compiler.ts`
  - `CompiledWorkflowState` 必须保留 `context_requirements`、`quality_gate`。
  - `validateWorkflowDefinition()` 必须校验 source type、evaluator type、blocking evaluator 是否已实现、重复 source id、非法字段组合。
  - `validateWorkflowDefinition()` 必须校验 blocking readiness 的 `on_block.target` 和 `retry_action` 指向合法 resume 路径。
- `src/workflow-config.ts`
  - `StateConfig` 必须暴露 `context_requirements`、`quality_gate`，否则运行时无法读取。
- `src/workflow.ts`
  - 在 `createDelegationForState()` 内、实际创建 delegation intent 前运行 Context Pack builder。
  - 生成 context pack 后合并 context patch，再调用 `buildTemplateVars()` 和 task finalization。
  - 若 readiness blocked，不能只复用普通 hook failure；应写入明确的 blocked context，并转入配置指定的 `human_input` interrupt 或 `context_blocked` 状态。
  - 在 delegation task finalization 阶段统一追加 Context Pack 指令，避免逐个 task template 修改。
- `src/workflow-context.ts`
  - 增加 `context_pack_path`、`context_pack_immutable_path`、`context_pack_hash`、`context_pack_summary`、`context_pack_open_questions`、`context_readiness_status`、`context_pack_generated_at` 等 key。
- 新增 `src/workflow-context-pack.ts`
  - 负责 signal extraction、query plan、retrieval、gating、路径安全校验、原子写入、hash 计算、pack summary 生成。
  - 第一版 source provider 仅支持 `workflow_input`、`artifact`、`codebase_location`。
  - codebase_location provider 从 `agents/global/services.json` 解析 `repo_path`，再得到 `/workspace/repos/{repo_path}`；同时检查目标 role 对应 agent 是否挂载该 service。
  - codebase_location provider 禁止做代码搜索、摘要、调用链分析、影响文件推断或分支判断。
- 新增 `src/workflow-quality-gate.ts`
  - 第一版先包装现有 stage rules、artifact contract 和 llm judge sidecar，不产生第二套冲突结论。
  - 每个 evaluator 分项结果必须保留；最终 gate 只做聚合和 transition 判定。
- `src/workflow-stage-evaluation.ts`
  - 后续拆分现有 stage evaluator，接入通用 evaluator result merge。
- `src/types.ts`
  - 扩展 `WorkflowEvalEvidence` 和 `WorkflowStageEvaluatorType`，为 `schema`、`artifact`、`stage_rules`、`context_coverage`、`evidence`、`consistency`、`execution`、`quality_gate` 预留类型。
- `src/db.ts`
  - `workflow_stage_evaluations.evaluator_type` 当前是文本列，可直接存新 evaluator type；TypeScript union 需要同步扩展。
- `electron/renderer/app.js`
  - workflow definition 编辑器和校验 UI 需要支持新增字段；否则通过 UI 保存会丢字段或无法编辑。

## 分阶段实施

### Phase 0：贯穿配置模型

- 在 `WorkflowDefinitionStateBase`、`CompiledWorkflowState`、`StateConfig` 同步增加 `context_requirements`、`quality_gate`。
- compiler 校验新增字段，并确保 editor 保存不会丢字段。
- 扩展 workflow context key 常量。
- 增加端到端配置保真测试：
  - workflow JSON 中写入 `context_requirements`、`quality_gate` 后，`validateWorkflowDefinition()` 不应误删或忽略合法字段。
  - `compileWorkflowDefinitions()` 输出的 `CompiledWorkflowState` 必须保留这两个字段。
  - `getWorkflowTypeConfig()` 返回的 `StateConfig` 必须能读取这两个字段。
  - `createDelegationForState()` 所接收的 `stateConfig` 必须包含这两个字段，保证后续运行时可接入 Context Pack builder。
  - renderer workflow definition 保存草稿时不得丢失这两个字段；若表单 UI 暂不支持编辑，也必须在本地校验和 JSON 模式保存中保留。
- 不改变运行时行为。

### Phase 1：只做可审计 Context Pack

- 增加少量 `context_requirements` 配置，从 `dev_test.plan`、`dev_test.dev` 开始试点。
- 构建 Query Plan。
- 第一版只实现 `workflow_input`、`artifact`、`codebase_location` 三类 source；配置出现其他 source type 时编译校验报错。
- 从 workflow input、artifact 收集候选，并从 service config 解析 codebase_location 元信息。
- 输出 service 级 context pack 文件：
  - `projects/{service}/workflow-context/{workflow_id}/{stage_key}/context-pack.r{round}.a{attempt}.json`
  - `projects/{service}/workflow-context/{workflow_id}/{stage_key}/latest.json`
- 将 context pack summary 和 latest path 通过系统级 prompt 注入 delegation。
- 不阻断流程，只记录 readiness 和 excluded reasons。
- 不要求 agent 输出 traceability coverage。

### Phase 2：启用 Readiness Gate

- required source 缺失时阻断，但必须进入明确的 `human_input` interrupt 或 `context_blocked` 状态，不能只表现为普通 hook failure。
- blocking readiness 必须配置 `context_requirements.on_block.target` 和 `retry_action`；编译期校验目标状态和 resume action 合法。
- required source 冲突时阻断，并把 conflicts 写入 context pack 和 interrupt body。
- open questions 非空时按配置转 human input；允许 workflow 配置 `allow_open_questions: true` 的非阻断阶段。
- 增加“补充上下文后重试当前 stage”的 resume 路径。
- 工作台展示 context pack 和缺失项。

### Phase 3：Traceability Coverage Contract

- 先新增独立 `traceability.json` artifact contract，不强行从 markdown 正文解析。
- 要求阶段产物返回或写入 `statements/decisions/actions/evidence/coverage/open_questions`。
- 扩展 `WorkflowEvalEvidence`，支持 code、command、wiki、log、provider evidence。
- evaluator 检查 evidence ref 是否存在、required input 是否覆盖、open questions 是否允许。
- `CODEBASE-*` 只能作为路径 evidence，不能支撑业务 decision。

### Phase 4：Quality Gate Pipeline

- `workflow-quality-gate.ts` 包装现有 `evaluateWorkflowStage()`、artifact contract、LLM judge sidecar。
- schema、artifact、stage_rules、llm_judge 先接入。
- 保留 evaluator 分项结果；最终 `quality_gate` 只聚合 blocking/non-blocking 结果并驱动 transition。
- context_coverage、evidence、consistency、execution evaluator 逐步接入。
- 支持 workflow 配置 blocking/non-blocking。
- LLM judge 继续默认 sidecar；只有确定性 evaluator 覆盖足够后，才允许特定流程配置为 blocking。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| source 缺失 | readiness 进入 `needs_input` 或 `blocked`，明确缺哪些信息，而不是让 agent 猜 |
| source 污染 | scope/evidence/conflict gate 默认拒绝 |
| 上下文过大 | required source 优先，budget gate 控制 |
| 过度阻断 | 第一版只记录不阻断，成熟后逐步打开 blocking |
| 配置复杂 | 提供默认 preset：`service_task`、`document_review`、`ops_action`、`incident_response` |
| LLM 误判 | LLM judge 不作为唯一质量门，确定性 evaluator 优先 |
| 配置写入但运行时不生效 | definition、compiled config、runtime config、editor 四处同步新增字段，并增加端到端配置保真测试 |
| plan 阶段没有 deliverable 导致 pack 无处落盘 | 不依赖 deliverable，固定写入 `projects/{service}/workflow-context/{workflow_id}/{stage_key}` |
| 单文件覆盖导致不可审计 | 写入版本化 `context-pack.r{round}.a{attempt}.json`，同时维护 `latest.json` |
| agent 读到半截 JSON | 临时文件写入后原子 rename |
| workflow context 泄露凭据 | Context Pack source 过滤敏感 key，只记录 redacted 字段路径 |
| readiness 阻断后流程卡死 | 阻断必须转 `human_input` interrupt 或明确 `context_blocked` 状态，并提供 resume retry |
| codebase path 与容器挂载不一致 | codebase_location provider 从 `services.json.repo_path` 和目标 role agent mount 配置共同验证 |
| Evidence Evaluator 超出现有证据模型 | Phase 3 先扩展 `WorkflowEvalEvidence` 和 traceability artifact，再启用 blocking evidence |
| Quality Gate 与现有 evaluator 双重结论冲突 | Phase 4 先包装现有链路；保留 evaluator 分项结果，由最终 quality_gate result 统一聚合 |

## 成功标准

- 每次 delegation 都能追溯“系统给了 agent 哪些上下文、为什么给、哪些被排除”。
- Context Pack 不依赖 deliverable；plan 阶段开始前也能稳定生成。
- 每次重跑都会保留不可变 pack 文件，并更新 latest 指针。
- agent 关键结论可以引用 `INPUT-*`、`ART-*`、`EVID-*`；`CODEBASE-*` 只作为代码库路径引用。
- required context 缺失时，流程不会静默进入低质量委托。
- readiness 阻断有明确 human input 或 retry 路径，不会只清空 current delegation 后停住。
- workflow 不需要为每种业务单独写代码，只通过配置声明上下文和质量门。
- `dev_test`、`fix_test`、self-evolution、incident/ops 类流程都能复用同一套机制。
