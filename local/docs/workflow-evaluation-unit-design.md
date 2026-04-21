# NanoClaw Workflow 评测单元设计

## 目标

将 workflow 从“流程编排器”升级为“流程评测单元”。

升级后的 workflow 不只是负责推进状态流转，还负责：

- 定义每个 stage 的验收标准
- 产出结构化评测结果
- 在不通过时生成返工依据
- 将评测结果沉淀到 workbench 和后续回归体系中

---

## 设计原则

- 每个 stage 都是独立 eval unit
- 先做 rule-based checks，再逐步增加 LLM judge
- 评测结果必须结构化，可用于 UI、回放、统计和回归
- 评测失败不等于系统异常，属于业务 verdict
- 评测过程要能产出 evidence，而不是只有一句结论

---

## 范围

第一期先覆盖以下 workflow stage：

- `plan`
- `dev`
- `test`
- `ops`

暂不追求：

- 通用化到所有未来 workflow type
- 自动生成复杂评分模型
- 完整替代人工审核

---

## 核心概念

### Stage Eval Unit

每个 stage 在结束时触发一次评测，输入包括：

- `workflow`
- `delegation`
- 当前 stage 对应 artifact / 文档
- 上下游 stage 的必要上下文
- 相关 action item / workbench event

输出包括：

- `status`: `passed` | `failed` | `needs_revision` | `pending`
- `score`: 0-100
- `summary`
- `findings`
- `evidence`

### Eval Verdict

- `passed`
  - 当前 stage 达到最低验收标准，可以进入后续流程
- `needs_revision`
  - 当前 stage 没有达到标准，但可以返工修复
- `failed`
  - 当前 stage 存在明确失败结论，通常用于测试失败或部署失败
- `pending`
  - 尚未有足够信息完成评测

---

## 数据模型

建议在 `src/db.ts` 中新增 `workflow_stage_evaluations` 表。

### 建议表结构

```sql
CREATE TABLE IF NOT EXISTS workflow_stage_evaluations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  delegation_id TEXT,
  stage_key TEXT NOT NULL,
  evaluator_type TEXT NOT NULL,
  status TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  summary TEXT,
  findings_json TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_stage_evals_workflow_stage
  ON workflow_stage_evaluations(workflow_id, stage_key, updated_at);
```

### TypeScript 类型建议

```ts
export interface WorkflowStageEvaluation {
  id: string;
  workflow_id: string;
  delegation_id?: string | null;
  stage_key: string;
  evaluator_type: 'rules' | 'llm_judge' | 'hybrid' | 'manual';
  status: 'passed' | 'failed' | 'needs_revision' | 'pending';
  score: number;
  summary?: string | null;
  findings_json?: string | null;
  evidence_json?: string | null;
  created_at: string;
  updated_at: string;
}
```

### findings 结构建议

```ts
export interface WorkflowEvalFinding {
  code: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  stageKey: string;
  path?: string;
  suggestion?: string;
}
```

### evidence 结构建议

```ts
export interface WorkflowEvalEvidence {
  type: 'artifact' | 'message' | 'workflow_state' | 'test_result' | 'user_feedback';
  refId?: string;
  path?: string;
  summary: string;
}
```

---

## 评测入口

建议新增统一接口：

```ts
export interface EvaluateWorkflowStageInput {
  workflowId: string;
  stageKey: string;
  delegationId?: string;
}

export interface WorkflowStageEvalResult {
  status: 'passed' | 'failed' | 'needs_revision' | 'pending';
  score: number;
  summary: string;
  findings: WorkflowEvalFinding[];
  evidence: WorkflowEvalEvidence[];
  evaluatorType: 'rules' | 'llm_judge' | 'hybrid' | 'manual';
}

export async function evaluateWorkflowStage(
  input: EvaluateWorkflowStageInput,
): Promise<WorkflowStageEvalResult>
```

建议 dispatch 到具体 stage：

```ts
evaluatePlanStage(...)
evaluateDevStage(...)
evaluateTestStage(...)
evaluateOpsStage(...)
```

---

## 各 stage 的第一版 rubric

## `plan`

### 最低通过标准

- 存在 `plan.md`
- front matter 包含必要字段
- 明确目标 / 范围 / 验收标准
- 有风险或约束说明
- 内容足够支持下游 dev/test

### rule-based checks

- 文件存在
- front matter 包含 `service`、`deliverable`、`doc_type`
- 文本包含 “验收标准” 或等价 section
- 文本包含 “风险” / “约束” / “边界” 之一

### 常见 findings

- `missing_plan_doc`
- `missing_acceptance_criteria`
- `missing_scope_definition`
- `missing_risk_assessment`

## `dev`

### 最低通过标准

- 有开发产出或实现说明
- 引用了 plan 产物
- 说明影响范围
- 有基本验证说明

### rule-based checks

- `dev.md` 存在
- front matter 正确
- 内容提到 plan 或 deliverable
- 内容包含“变更”、“实现”、“影响”、“验证”等 section

### 常见 findings

- `missing_dev_doc`
- `missing_plan_reference`
- `missing_impact_analysis`
- `missing_validation_notes`

## `test`

### 最低通过标准

- 有测试报告
- 能区分 passed / failed / blocked
- 说明覆盖范围
- 给出关键结论或证据

### rule-based checks

- `test.md` 存在
- front matter 正确
- 内容包含总数、通过数、失败数、阻塞数或等价描述
- 内容包含结论 section

### 常见 findings

- `missing_test_doc`
- `missing_test_summary`
- `missing_failure_breakdown`
- `missing_regression_coverage`

## `ops`

### 最低通过标准

- 明确部署环境
- 明确分支信息
- 有验证证据
- 有回滚说明或替代措施

### rule-based checks

- 结果中存在 `staging_base_branch` / `staging_work_branch`
- 内容提到环境、验证、部署结果
- 内容包含回滚 / 风险 / 验证之一

### 常见 findings

- `missing_deploy_target`
- `missing_branch_metadata`
- `missing_verification_evidence`
- `missing_rollback_guidance`

---

## 执行时机

建议在 `src/workflow.ts` 这些节点触发：

- `onDelegationComplete`
  - stage 委派完成后立即评测
- `approveWorkflow`
  - 在人工批准前或批准后补充评测
- 自动状态迁移前
  - 若未通过则阻止自动进入下一阶段

建议流程：

1. delegation 完成
2. 读取 stage 上下文
3. 调用 `evaluateWorkflowStage`
4. 写入 `workflow_stage_evaluations`
5. 同步到 workbench
6. 根据 verdict 决定：
   - 进入下一阶段
   - 生成返工 action item
   - 暂停或等待人工确认

---

## 与 workbench 的集成

建议在 `src/workbench-store.ts` 中增加同步函数：

- `syncWorkbenchOnStageEvaluated(workflowId, stageKey)`

同步内容包括：

- 一条 `workbench_event`
- 零个或多个 `workbench_action_items`
- stage 状态摘要

### UI 建议展示字段

每个 stage 展示：

- verdict
- score
- summary
- findings count
- top findings
- evidence links
- 是否需要返工

---

## 与 failure taxonomy 的关系

需要明确区分：

- 评测未通过：业务 verdict，例如 `needs_revision`
- 系统异常：执行失败，例如 `evaluation_failed`

例子：

- `plan.md` 缺少验收标准
  - 这是 stage eval finding，不是系统错误
- 读取 `plan.md` 时文件系统报错
  - 这是 `evaluation_failed` 或 `invalid_input`

不要把所有“不通过”都记成 error。

---

## 第一版实现建议

### Phase 1

- 增加 `workflow_stage_evaluations`
- 只做 rule-based evaluator
- 只覆盖 `plan/dev/test/ops`
- 结果进入 workbench
- 未通过自动生成 action item

### Phase 2

- 增加 LLM judge 作为补充
- 支持混合评分
- 支持 stage score 趋势统计

### Phase 3

- 接入 replay/eval runner
- 对 workflow 改动做自动回归

---

## 建议代码文件

- `src/workflow-evaluator.ts`
  - stage evaluator 主入口
- `src/workflow-evaluator-rules.ts`
  - rule-based checks
- `src/workflow-evaluator-types.ts`
  - 类型定义
- `src/db.ts`
  - 表结构和 CRUD
- `src/workflow.ts`
  - 触发评测
- `src/workbench-store.ts`
  - 同步结果到 workbench
- `src/channels/web.ts`
  - 暴露评测结果给前端

---

## 最小成功标准

如果满足以下条件，就说明 workflow 已经从“流程编排器”升级成“流程评测单元”：

- 每个关键 stage 都能自动产出 verdict
- 未通过时能给出结构化 findings
- findings 能直接进入 workbench
- workflow 是否推进，不再只靠流程配置，还会参考 stage evaluation
