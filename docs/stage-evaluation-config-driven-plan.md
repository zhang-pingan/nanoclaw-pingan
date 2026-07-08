# Stage 评估器配置化 + 交付物体系去 Markdown 化方案

> 本方案覆盖四块改造，全部为确定执行项：
> - **主体**：stage 评估器去硬编码，退化为无 stageKey 分支的通用解释器。
> - **①**：交付物目录扫描去 `.md` 化，让工作流可声明非 `.md` 交付物。
> - **②**：JSON 交付物文件体字段存在性校验，挂在 `artifact` evaluator，与 `schema` evaluator 正交。
> - **③**：handoff/Trace 把 JSON artifact path 纳入校验与 Trace（工作台展示/打开本就与文件类型无关，见 ③ 节核查结论）。
>
> 主体 + ① 是通用去硬编码债，对所有工作流即时受益；②③ 让非 Markdown（JSON）交付物成为一等公民。四块可分批合入，建议顺序见"实施步骤"。

## 背景

`src/workflow-stage-evaluation.ts` 是阶段评估流水线中唯一仍然硬编码的 evaluator。它把"某个阶段的交付物长什么样"写死在 TypeScript 里：

- 写死角色到文档的映射：`evaluatePlanStage` 取 `'planner'`、`evaluateDevStage` 取 `'dev'`、`evaluateTestingStage` 取 `'test'`。
- 写死 stageKey 大 switch：`plan / plan_examine / dev / dev_examine / fixing / bug_fix / ops_deploy / testing`。
- 写死 front matter 必填字段：`['service', 'deliverable', 'doc_type']`（`workflow-stage-evaluation.ts:819`）。
- 写死文档小节正则：plan.md 要有"验收标准/范围/风险"（`:834-863`），dev.md 要引用方案/有影响范围/有自测（`:1013-1049`）。
- 写死 payload 必填字段：`getStagePayloadFieldRequirements`（`:268`）。
- 写死文本兜底关键词：`inferStatusFromText`（`:406`）。
- 报错信息里硬写 `plan.md / dev.md / test.md` 字面量（`:797`、`:992`、`:1250`），即使文件名被 `deliverable_file` 覆盖也对不上。

同源的另一处硬编码在交付物目录扫描（**本方案 ① 一并处理**）：

- `readDeliverableDir`（`src/workflow.ts:1426`）用 `fs.readdirSync().filter(f => f.endsWith('.md'))` 写死只认 `.md`，再由入口校验检查 `required_deliverable_file` 是否在列表中（`:4307`）。任何工作流若以非 `.md` 文件作为入口交付物，会在此被过滤掉，入口直接报"未找到"。这与 stage 评估的 `.md` 字面量是同一类去硬编码债，且是独立于评估器的另一条代码路径，评估方案的契约 `path` 定位机制绕不过它。

这违背了 CLAUDE.md 与 TECHNOLOGY.md 声明的"工作流引擎配置驱动"原则：`plan.md / dev.md / test.md` 只是 `dev_test` 这一条工作流的特定产物，不应作为统一评估逻辑的前提；交付物扫描也不应写死扩展名。

评估器应当只负责**统一流程和非个性化判定**（执行失败收敛、verdict 归一、score 计算、status 收敛）；**个性化校验规则**（哪些文件、哪些 front matter、哪些小节、哪些数值阈值）应由工作流配置决定。

## 当前相关实现

阶段评估实际上已经有一套**配置驱动的设施**，只有 `stage_rules` 这一类还在硬编码。主要代码位置：

- `src/workflow.ts:5201` — 主链路调用 `evaluateWorkflowStage`，随后交给质量门聚合。
- `src/workflow-stage-evaluation.ts` — 本次改造主体（约 1450 行，硬编码 evaluator）。
- `src/workflow-quality-gate.ts`
  - `buildWorkflowQualityGateEvaluation`（`:1418`）按配置编排 8 类 evaluator。
  - `:1469` 把硬编码 `stageEvaluation` 原样塞进 `stage_rules` 这一类。
  - `evaluateSchema` / `evaluateContextCoverage` / `evaluateEvidence` / `evaluateConsistency` / `evaluateExecution` 已是通用、配置驱动。
- `src/workflow-artifact-contract.ts` + `container/artifact-contracts/workflow-stage-core.json`
  - 已声明每阶段文件 `path`、`frontmatter_required`、`payload.required`、`max_bytes`、`allowed_artifact_roots`。
  - 与 `workflow-stage-evaluation.ts` 的 frontmatter/payload 校验**重复定义**。
- `src/workflow-evaluator-registry.ts` + `container/workflow-evaluators/*.json` — evaluator 注册表（deterministic checks + ai rubric）。
- `src/workflow-artifacts.ts` — `getDeliverableFileNameForRole`，文件名已半可配（`deliverable_file` 覆盖）。
- 工作流定义 `container/workflow-definitions/dev_test.json`、`fix_test.json` — 每个 state 已带 `artifact_contract.ref`、`evaluator.ref`、`quality_gate.evaluators[]`。

### 关键结论

改造不是另起炉灶，而是把 `stage_rules` 从"硬编码 evaluator"对齐到已有的 artifact-contract 体系。`workflow-stage-evaluation.ts` 里的硬编码分三类：

1. **已被 artifact 契约覆盖（冗余）**：文件存在性、frontmatter 字段、payload 必填字段。→ 删除，交给 `artifact` evaluator。
2. **真正的个性化规则（目前只有它在管）**：文档小节正则、testing 的 `failed>0`、ops 的分支信息、`inferStatusFromText` 关键词。→ 搬进契约配置。
3. **通用流程编排**：`outcome=failure → failed`、verdict 归一、score 计算、status 收敛。→ 保留。

## 改造目标

- `stage_rules` evaluator 变成**无 stageKey 分支的通用规则解释器**，规则从配置读。
- `.md` 文件名、`plan/dev/test` 角色、frontmatter 字段、文档小节、数值阈值全部从配置来。
- 评估器只保留统一流程 + 收敛逻辑；个性化规则归工作流配置。
- 新增工作流 / 新文档格式 / 改文件名 / 改小节要求 → 只改 JSON，不碰 TS。

## 设计

### 1. 扩展 artifact-contract schema，容纳"文档内容规则"

`container/artifact-contracts/*.json` 的 `files[]` 已有 `path` 和 `frontmatter_required`。新增声明式字段：

```jsonc
// dev_test.plan.v1.files[0]
{
  "path": "projects/{{service}}/iteration/{{deliverable}}/plan.md",
  "required": true,
  "frontmatter_required": ["service", "deliverable", "doc_type"],
  "content_checks": [
    { "code": "missing_acceptance_criteria", "severity": "high",
      "any_of": ["验收标准", "acceptance criteria"],
      "message": "plan.md 缺少验收标准说明。" },
    { "code": "missing_scope_definition", "severity": "medium",
      "any_of": ["范围", "scope", "边界"],
      "message": "plan.md 缺少范围或边界定义。" },
    { "code": "missing_risk_assessment", "severity": "medium",
      "any_of": ["风险", "约束", "限制"],
      "message": "plan.md 缺少风险或约束说明。" }
  ]
}
```

要点：

- 文件名 `plan.md` 本就在 `path` 字面量里（`{{service}}`/`{{deliverable}}` 之外都是字面量），评估器永不自己拼 `plan.md`。"写死 .md" 靠契约 `path` 天然解决。
- `code`/`severity`/`message`/`any_of` 全进配置，换语言/换流程不碰代码。

阶段级数值/状态规则（testing 的失败用例、ops 的分支信息）也下沉为契约顶层的声明式规则：

```jsonc
// dev_test.testing.v1
{
  "payload_rules": [
    { "code": "test_cases_failed", "severity": "high",
      "field": "failed", "gt": 0, "then_status": "failed",
      "message": "测试未通过，失败用例数 {{failed}}。" }
  ]
}
```

### 2. `workflow-artifact-contract.ts` 执行 content_checks / payload_rules

在已有的契约求值里增加：

- 读到文件内容后，对每个 `content_checks` 跑 `any_of` 正则；命中失败则 push finding（用配置里的 code/severity/message）。
- 对 `payload_rules` 做数值/字段判定，命中则改写 status / push finding，支持 `{{field}}` 插值。

这样第 2 类个性化规则全部归 `artifact` evaluator，由契约驱动。

### 3. `stage_rules` 退化为通用解释器

`evaluateWorkflowStage` 去掉所有 `case 'plan'`/`case 'dev'`/... 分支，只保留通用收敛：

- `normalizeDelegationOutcome`：`outcome=failure → failed`。
- `coerceStatus`：verdict 归一。
- `computeScore`：基于 status + findings 算分。
- status 收敛：综合 verdict / findings 得最终 status。

stageKey 不再决定"查什么文件、什么字段"，这些已由 artifact 契约负责。`stage_rules` 只对 delegation 自身结果做通用判定。

### 4. 交付物目录扫描去 `.md` 化（①）

`readDeliverableDir`（`src/workflow.ts:1426`）不再写死 `.endsWith('.md')`：

- 扫描时按工作流契约声明的交付文件名/扩展集合判定，而非固定 `.md`；无契约约束时退化为"接受目录内全部常规文件"或一个可配置的扩展白名单。
- 入口校验（`:4307`）继续用 `required_deliverable_file`（已由 `deliverable_file` 可配）判断必需交付物是否存在，逻辑不变，只是不再被 `.md` 过滤提前丢弃非 `.md` 文件。
- `readMetadataFromFile` 对非 frontmatter 文件（如 JSON）安全降级：取不到 branch 元数据时返回空串，不报错。

这样任何工作流都可声明非 `.md` 交付物（JSON/YAML/CSV/SVG…），不再被扩展名绑死。此项不依赖 ②③，与主体同批交付。

### 5. 删除冗余 + 收口

- 删除 `workflow-stage-evaluation.ts` 第 1 类（frontmatter/文件存在性/payload 必填）与第 2 类（小节正则、`inferStatusFromText`、`getStagePayloadFieldRequirements`）。
- `getWorkflowDeliverableFileName` 在 stage_rules 内的用途消失（文件由契约 `path` 定位）。
- 文件从约 1450 行缩到数百行。

## 实施步骤

1. **契约 schema 扩展**：在 `workflow-artifact-contract.ts` 定义 `content_checks`、`payload_rules` 类型与求值逻辑；先不接线，单测覆盖。
2. **迁移 plan/dev 规则**：把 `workflow-stage-core.json` 的 plan/dev 文件补上 `content_checks`；把 `workflow-stage-evaluation.ts:834-863`、`:1013-1049` 的小节规则搬过去。
3. **迁移 testing/ops 规则**：testing 的 `failed>0`、ops 的分支信息转为 `payload_rules` / context 规则。
4. **重写 stage_rules**：`evaluateWorkflowStage` 去 switch，改为通用收敛解释器。
5. **目录扫描去 `.md` 化（①）**：泛化 `readDeliverableDir`（`workflow.ts:1426`）的扩展过滤；`readMetadataFromFile` 对非 frontmatter 文件安全降级；入口校验逻辑保持。
6. **JSON 文件体字段校验（②）**：在 `artifact` evaluator 增加 `body_required_fields` check 类型，解析 JSON 文件体做字段存在性校验；单测覆盖。
7. **handoff/Trace 纳入 JSON artifact（③）**：handoff 校验、evaluator、Trace 对 `.json` artifact 与 markdown 同等处理（前端无改动）。
8. **删冗余**：移除被契约覆盖的硬编码与未用 helper。
9. **回归**：更新依赖测试，全链路验证两条工作流——一条现有 `.md`，一条声明 JSON 交付物 + `body_required_fields` 的最小用例。

建议合入顺序：步骤 1–5（主体 + ①，通用去硬编码债，可独立先合）→ 步骤 6–7（②③，JSON 一等公民）→ 步骤 8–9（收口 + 回归）。

## 受影响文件

- `container/artifact-contracts/workflow-stage-core.json` — 新增 content_checks / payload_rules。
- `src/workflow-artifact-contract.ts` — 执行新规则（content_checks / payload_rules / **② `body_required_fields` JSON 文件体校验**）。
- `src/workflow-stage-evaluation.ts` — 重写为通用解释器，删冗余。
- `src/workflow.ts:1426`（`readDeliverableDir`）— **①** 泛化扩展过滤；`readMetadataFromFile` 非 frontmatter 安全降级；入口校验（`:4307`）逻辑不变。
- `src/workflow-quality-gate.ts:1469` — `stage_rules` 接缝保持不变（仍消费 stageEvaluation，但其语义收窄）。
- `src/workflow.ts:5201` — 调用签名不变，行为对齐。
- **③ handoff / Trace 纳入 JSON artifact**：`src/workflow.ts` 与 `src/workbench.ts:630`（`buildArtifacts`）等对 `.json` artifact 与 markdown 同等处理；**前端 `electron/renderer/app.js` 无改动**（artifact 展示/打开与文件类型无关，已核查）。
- 相关测试：`src/workflow.test.ts`、`src/db.test.ts`、`src/workbench-store.test.ts` 中依赖 stage 评估的断言。

## 迁移与兼容

项目处于实验阶段，采用"直接替换"而非"新旧并存"的迁移方式：搬规则的同时直接删除 `workflow-stage-evaluation.ts` 的硬编码，靠跑测试/全链路验证暴露问题再修，不保留旧逻辑作为回退垫。

- 契约缺省时（无 `content_checks`/`payload_rules`/`body_required_fields`）行为退化为"仅通用判定"，不破坏现有未配置工作流。
- `fix_test.json` 等其它工作流按需补规则；未补则不做个性化校验，符合"个性化由配置决定"。
- 合入顺序见"实施步骤"末尾；删硬编码与搬规则同批进行，不单独留并存窗口。

## 非 Markdown（JSON）交付物的一等公民支持（②③）

> 机制保持通用，不绑定某个具体业务；JSON 产物可以由任意 workflow 声明和校验。

### ② JSON 交付物文件体字段校验（挂在 `artifact` evaluator）

环节与定位：

- 文件体校验落在 **`artifact` evaluator**（`workflow-artifact-contract.ts` 的契约求值），即本方案设计 §1/§2 扩展 `content_checks`/`payload_rules` 的同一处，只是**再加一种 check 类型**。
- 与现有 **`schema` evaluator 正交、不重叠**：`schema` evaluator（`workflow-quality-gate.ts:526`）校验的是**委派回传的 handoff payload**（`verdict`/`summary`/`findings`/`evidence` 等流程协议字段），属"委派协议层"；而文件体校验针对**落地的交付文件内容**（如 `product-recon.json` 是否含 `version`/`platform`/`flows`/`evidence`），属"交付内容层"。两者校验对象、数据来源、触发位置均不同，互不影响。

```text
worker 完成委派
  -> 回传 handoff payload(JSON)            ← schema evaluator(已有，不动)
  -> 落地交付文件(plan.md / *.json)        ← ② 文件体校验在这里(artifact evaluator)
  -> quality gate 编排多类 evaluator
```

实现方式（定为 (a) 轻量字段存在性）：

- 契约 `files[]` 新增声明，如 `body_required_fields: ["version", "platform", "flows", "evidence"]`。
- `artifact` evaluator 解析 JSON 文件体，逐个校验字段路径存在；缺失则用配置的 code/severity/message push finding。
- 风格与现有 `content_checks` 一致，**零新依赖**，且不与 `schema` evaluator 撞名/撞概念。
- 不采用完整 JSON Schema 校验（需引入 ajv 等依赖）；待出现复杂结构校验的真实需求再评估升级。

### ③ 工作台 / handoff / Trace 对 JSON artifact 的支持

核查结论（基于 `electron/renderer/app.js:15904` `renderWorkbenchArtifacts` 与 `src/workbench.ts:630` `buildArtifacts`）：

- **工作台展示/打开本就与文件类型无关。** artifact 列表项只渲染 title / path / 存在性 badge / Trace，打开走 `window.icarusApp.openFile(absolute_path)` 或 `file://`，交给系统打开；列表**不做 markdown 内联预览**（`renderMarkdown` 只用于消息正文，未用于 artifact）。因此 JSON artifact 在工作台**天然可展示、可打开**，**前端无改动面**。
- **artifact 是否出现在列表，取决于 ① 是否已去 `.md` 化。** `buildArtifacts` → `resolveWorkflowArtifactDefinitions` 按契约 `path` 列出；只要契约声明 `.json` 且 ① 已放开扩展过滤，JSON 产物即会出现。此项已在地基 ① 覆盖。

因此 ③ 的实际改动收窄为 **handoff / evaluator / Trace 侧**：

- handoff 校验、evaluator 求值、Trace 记录把 JSON artifact path 纳入（与 markdown artifact 同等对待，不因扩展名差异丢弃或误判）。
- 不涉及前端渲染改造。

## 非目标

- 不改 quality-gate 的 evaluator 编排顺序与 pass_policy 语义。
- 不改 handoff/payload 通用 schema（`schema` evaluator）——它校验委派协议层 payload，与 ② 的交付文件体校验正交，二者不可混为一谈。
- 不引入新的 LLM 评估能力（`llm_judge` 仍走 sidecar）。
- 不改工作流状态机转移逻辑。
- ② 只做字段存在性校验，不做完整 JSON Schema 结构校验。
- ③ 不改前端 artifact 渲染（工作台展示/打开本就与文件类型无关，已核查）。
