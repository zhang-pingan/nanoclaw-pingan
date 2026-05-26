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
        "id": "service_codebase",
        "type": "codebase",
        "required": true,
        "service": "{{service}}",
        "fields": ["container_path"],
        "verify_exists": true,
        "include_content": false,
        "search": false
      }
    ]
  }
}
```

### Context Pack

系统在 delegation 前生成的上下文包。它不是搜索结果列表，而是经过整理和证据化后的阶段材料。

建议结构：

```json
{
  "version": 1,
  "workflow_id": "wf-xxx",
  "stage_key": "plan",
  "service": "catstory",
  "readiness": {
    "status": "ready",
    "missing_required_sources": [],
    "open_questions": [],
    "conflicts": []
  },
  "query_plan": [],
  "input_refs": [],
  "prior_artifacts": [],
  "codebase_refs": [],
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

## 系统如何知道收集什么

系统不应自行猜测要收集什么。Context Pack builder 只读取 workflow definition 中当前 stage 的 `context_requirements`。

第一版只支持显式 source，因此不需要搜索词预填充。`query_plan` 只记录本阶段按配置解析出的 source 计划：

- workflow 元数据：`workflow_type`、`stage_key`、`role`、`skill`、`service`。
- 配置声明的 source：`workflow_input`、`artifact`、`codebase`，以及专项 provider 如 `ios_app_recon`。
- 每个 source 的 `required`、`refs`、`fields`、`required_when`、`on_missing`。
- 服务配置中用于解析 `codebase.container_path` 的字段。

代码类上下文只用于定位代码库，不用于替代 coding agent 阅读代码。Context Pack 只提供 `container_path`；不应预先做代码搜索、代码摘要、调用链推断、受影响文件判断或分支状态判断。分支字段继续通过 workflow context 和 `context.require` 校验。

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
      "id": "service_codebase",
      "type": "codebase",
      "fields": ["container_path"]
    }
  ]
}
```

Query Plan 必须写入 trace，便于审计“为什么收集这些材料”。

## 上下文防污染机制

### 1. Scope Gate

候选必须满足作用域：

- 当前服务 scope：`service:{service}`。
- 当前 deliverable 目录。
- 显式声明的跨服务依赖或外部 evidence source。

默认拒绝其他服务的产物。跨服务材料必须由 workflow 配置、服务依赖映射或上游产物中的依赖事实触发。

### 2. Evidence Gate

关键结论必须有证据。对于不同 source 类型，证据可以是：

- workflow input 的字段路径或附件路径。
- artifact 的文件路径和片段。
- codebase 的容器路径和路径存在性校验记录；它只能证明代码库位置，不能直接证明业务或实现结论。
- agent 阅读代码后在阶段产物中新增的代码 evidence，例如文件、符号、行号范围和摘要。
- agent 执行 command、测试、脚本或 API 调用后新增的执行 evidence。
- agent 检索 wiki、日志或其他授权 provider 后新增的外部 evidence。
- iOS provider 产出的 screenshot、UI tree、network、crash、case/assert 记录。

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
  -> write context pack artifact
  -> patch workflow.context with context_pack metadata
  -> readiness gate decides continue / block / ask human
  -> delegate with context_pack injected
```

## Delegation Prompt 注入

委派 prompt 不应注入所有原始候选。建议新增模板变量：

- `{{context_pack_path}}`
- `{{context_pack_summary}}`
- `{{context_pack_open_questions}}`

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

## 数据存储

建议新增或复用以下记录：

```text
workflow_context_packs
  id
  workflow_id
  stage_key
  delegation_id nullable
  status
  pack_json
  pack_path
  hash
  created_at
  updated_at

workflow_context_pack_sources
  pack_id
  source_type
  source_id
  status: included | excluded | conflict | hint
  score
  reason

workflow_stage_evaluations
  继续复用，新增 evaluator_type:
  context_coverage | evidence | consistency | execution
```

第一版也可以不建表，先把 pack 写入：

```text
projects/{service}/iteration/{deliverable}/context/{stage_key}.context-pack.json
```

同时将以下元数据写入 workflow context：

```json
{
  "context_pack_path": "/workspace/projects/.../context/plan.context-pack.json",
  "context_pack_hash": "...",
  "context_readiness_status": "ready"
}
```

## 当前代码落点

主要改动位置：

- `src/workflow-definition.ts`
  - 增加 `context_requirements`、`quality_gate` 类型。
- `src/workflow.ts`
  - 在 `createDelegationForState()` 内、实际创建 delegation intent 前运行 Context Pack builder。
  - 若 readiness blocked，则不要创建 delegation，转入 pending/action needed 或 interrupt。
- `src/workflow-context.ts`
  - 增加 `context_pack_path`、`context_pack_hash`、`context_readiness_status` 等 key。
- 新增 `src/workflow-context-pack.ts`
  - 负责 signal extraction、query plan、retrieval、gating、pack writing。
- 新增 `src/workflow-quality-gate.ts`
  - 统一执行 evaluator pipeline。
- `src/workflow-stage-evaluation.ts`
  - 拆分现有 stage evaluator，接入通用 evaluator result merge。
## 分阶段实施

### Phase 1：只做可审计 Context Pack

- 增加 `context_requirements` 配置。
- 构建 Query Plan。
- 从 workflow input、artifact 收集候选，并从 service config 解析 codebase 元信息。
- 输出 context pack 文件。
- 将 context pack summary 注入 delegation prompt。
- 不阻断流程，只记录 readiness 和 excluded reasons。

### Phase 2：启用 Readiness Gate

- required source 缺失时阻断。
- required source 冲突时阻断。
- open questions 非空时可转 human input。
- 工作台展示 context pack 和缺失项。

### Phase 3：Traceability Coverage Contract

- 要求阶段产物返回 statements/decisions/actions/evidence/coverage/open_questions。
- artifact contract 支持结构化 coverage 文件。
- evaluator 检查引用和覆盖。

### Phase 4：Quality Gate Pipeline

- schema、artifact、context_coverage、evidence、consistency、execution evaluator 全部接入。
- 支持 workflow 配置 blocking/non-blocking。
- LLM judge 继续作为 sidecar 或按配置阻断。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| source 缺失 | readiness 进入 pending，明确缺哪些信息，而不是让 agent 猜 |
| source 污染 | scope/evidence/conflict gate 默认拒绝 |
| 上下文过大 | required source 优先，budget gate 控制 |
| 过度阻断 | 第一版只记录不阻断，成熟后逐步打开 blocking |
| 配置复杂 | 提供默认 preset：`service_task`、`document_review`、`ops_action`、`incident_response` |
| LLM 误判 | LLM judge 不作为唯一质量门，确定性 evaluator 优先 |

## 成功标准

- 每次 delegation 都能追溯“系统给了 agent 哪些上下文、为什么给、哪些被排除”。
- agent 关键结论可以引用 `INPUT-*`、`ART-*`、`EVID-*`；`CODEBASE-*` 只作为代码库路径引用。
- required context 缺失时，流程不会静默进入低质量委托。
- workflow 不需要为每种业务单独写代码，只通过配置声明上下文和质量门。
- `dev_test`、`fix_test`、self-evolution、incident/ops 类流程都能复用同一套机制。
