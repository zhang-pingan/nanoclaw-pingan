# NanoClaw Harness Engineering 改造蓝图

## 目标

将 `nanoclaw` 从“能跑 agent 的系统”升级成“能稳定迭代 agent 的系统”。

核心不是继续堆功能，而是建立 4 个闭环：

- 运行闭环：每次 agent 执行都能被完整追踪
- 回放闭环：关键任务能离线重跑
- 评测闭环：改 prompt、模型、流程后能比较前后效果
- 回归闭环：上线前能知道是否破坏旧能力

---

## 总体思路

建议分 4 层推进：

1. Execution Harness：统一记录一次执行的全链路信息
2. Replay Harness：把线上真实任务沉淀成可离线重跑的数据集
3. Evaluation Harness：为不同任务建立可自动比较的评测器
4. Regression Harness：让每次代码改动都有稳定的保护网

---

## 第一层：Execution Harness

### 目标

先把“每次执行发生了什么”记录清楚。

当前项目已经有一些散点信息：

- 消息存储在 `src/db.ts`
- 任务执行日志在 `src/db.ts` 的 `task_run_logs`
- workflow / delegation / workbench 在 `src/workbench-store.ts`
- 模型选择和实际模型有 `src/model-resolution.ts`
- 调度入口在 `src/task-scheduler.ts`
- 主消息处理在 `src/index.ts`

这些信息还没有形成一个统一 execution object。建议新增统一的 run 视图，底层仍可继续用 SQLite。

### 建议新增表

#### `agent_runs`

建议字段：

```ts
id
run_id
query_id
chat_jid
group_folder
workflow_id
stage_key
source_type           // message | scheduled_task | workflow_delegation | web_action
source_ref_id
session_id
selected_model
selected_model_reason
actual_model
prompt_hash
memory_pack_hash
tools_hash
mounts_hash
status                // success | error | cancelled | timeout
failure_type
error_message
started_at
ended_at
latency_ms
output_digest
output_preview
```

#### `agent_run_steps`

建议字段：

```ts
id
run_id
step_type             // prompt_build | model_select | container_start | tool_call | tool_result | output_chunk | finish
step_name
payload_json
created_at
latency_ms
```

### 建立 failure taxonomy，而不是只存 error string

当前很多系统在失败时最终只留下 `error_message`。这对人工排障有帮助，但对 Harness Engineering 不够。

如果没有结构化 failure taxonomy，后续很难稳定回答：

- 最近失败主要集中在哪类问题
- 是模型问题、工具问题、流程问题，还是 harness 本身问题
- 某次优化到底减少了哪一类失败
- 哪些错误应该自动重试，哪些应该立即打回或暂停

因此建议在 `agent_runs`、`task_run_logs`、`workflow_stage_evaluations` 等记录里，不只存原始错误文本，还要存标准化的 `failure_type`。

### 建议的一级 failure taxonomy

第一版至少覆盖这些类别：

- `model_api_error`
- `model_output_invalid`
- `tool_error`
- `tool_contract_error`
- `sandbox_error`
- `container_runtime_error`
- `timeout`
- `routing_error`
- `state_transition_error`
- `workflow_transition_error`
- `evaluation_failed`
- `invalid_input`
- `invalid_config`
- `permission_error`
- `unknown_error`

### 建议的扩展字段

除了 `error_message`，建议逐步增加：

```ts
failure_type
failure_subtype
failure_origin      // model | tool | scheduler | workflow | router | container | db | web
failure_retryable   // true | false
failure_details_json
```

### 映射策略建议

建议不要让每个模块随意写字符串，而是统一提供分类函数，例如：

```ts
classifyFailure(err, context): {
  failureType: string;
  failureSubtype?: string;
  failureOrigin: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

### 代码落点建议

- `src/index.ts`
  - 主对话执行开始时创建 `agent_runs`
  - 收到流式输出时写 `output_chunk`
  - 完成时回填 `status`、`latency_ms`、`actual_model`
  - 失败时写入结构化 `failure_type`
- `src/task-scheduler.ts`
  - scheduled task 走同一套 run 记录，不要只落 `task_run_logs`
  - 将非法输入、运行超时、容器失败归类为稳定 taxonomy
- `src/workflow.ts`
  - delegation 创建/完成时挂上 `workflow_id`、`stage_key`
  - stage 失败时区分 `workflow_transition_error`、`evaluation_failed` 等类别
- `src/model-resolution.ts`
  - 把 `actual_model` 回填到 `agent_runs`
- `src/container-runner.ts`
  - 记录 container 生命周期、timeout、exit code
  - 对退出异常、超时、runtime 异常做 failure taxonomy 分类

### 这一层完成后的收益

可以直接回答这些问题：

- 哪些任务最慢
- 哪些 stage 最容易失败
- 哪类失败正在上升
- 哪些模型选择经常效果不好
- 哪些 group 的 memory/context 特别重

---

## 第二层：Replay Harness

### 目标

把线上真实任务沉淀成可离线重跑的数据集。

没有 replay，后面的优化大多只能靠感觉。

### 建议目录结构

```text
evals/
  datasets/
    main-admin.jsonl
    scheduler.jsonl
    workflow-dev-test.jsonl
    group-chat.jsonl
  fixtures/
    groups/
    memories/
    tasks/
  runners/
    replay-runner.ts
    compare-results.ts
```

### 样本格式建议

```json
{
  "case_id": "workflow_plan_001",
  "scenario": "workflow",
  "input": {
    "chat_jid": "main@g.us",
    "group_folder": "web_main",
    "messages": [
      {
        "sender": "user",
        "content": "创建一个 dev_test workflow ...",
        "timestamp": "2026-04-08T00:00:00.000Z"
      }
    ],
    "registered_groups": {},
    "sessions": {},
    "workflow_state": null,
    "memory_pack": {},
    "available_tools": ["bash", "web", "mcp__nanoclaw__*"]
  },
  "expected": {
    "kind": "state_transition",
    "must_include": ["workflow created"],
    "workflow_status": "plan"
  },
  "tags": ["workflow", "main-group"]
}
```

### 第一批数据集建议

先抓 30~50 条高价值样本，按以下类别组织：

- 主群控制类
- workflow 创建 / 审批 / 委派
- scheduler 单轮任务
- group chat 普通消息
- 容器 / 权限 / 挂载边界场景

### 采样来源

- `messages`
- `workflows`
- `delegations`
- `task_run_logs`
- `workbench_*`

### replay 模式建议

#### `logic-only`

- 不真跑 container
- 只验证状态变化、路由和 DB 变更

#### `stubbed-agent`

- agent 输出由 fixture 提供
- 用于验证 orchestration

#### `full-run`

- 真跑 container
- 用于端到端回放

这样可以把大部分 regression 拦在较便宜的层级。

---

## 第三层：Evaluation Harness

### 目标

不是只“回放”，而是要“比较好坏”。

建议先从 rule-based eval 起步，后续再接 LLM-as-judge。

这里有一个关键升级方向：

- 不再只把 workflow 当作“流程编排器”
- 要把 workflow 升级成“流程评测单元”

也就是：每个 workflow 不只是负责把任务从 `plan -> dev -> test -> ops` 串起来，还要在每个 stage 上产生可比较、可验收、可打回的评测结果。

### workflow 作为“流程评测单元”的定义

建议把每个 workflow stage 都视为一个独立 eval unit，并具备以下能力：

- 明确输入：当前 stage 的上下文、上游产物、委派结果、必要附件
- 明确输出：当前 stage 需要交付的文档、消息、状态迁移、artifact
- 明确 rubric：本 stage 通过的最低标准
- 明确 verdict：`passed` / `failed` / `needs_revision`
- 明确 evidence：为什么通过、为什么打回、证据在哪

这样 workflow 系统就不再只是“把人/agent 推到下一个环节”，而是能判断：

- 这一步做没做完
- 做得够不够好
- 要不要返工
- 是哪个维度没达标

### 建议新增的 workflow 评测模型

建议新增一张表，例如 `workflow_stage_evaluations`：

```ts
id
workflow_id
delegation_id
stage_key
evaluator_type        // rules | llm_judge | hybrid | manual
status                // passed | failed | needs_revision | pending
score                 // 0-100
summary
findings_json
evidence_json
created_at
updated_at
```

其中：

- `findings_json`：结构化问题列表
- `evidence_json`：引用的 artifact、消息、文档路径、测试结果、用户反馈

建议 `findings_json` 结构类似：

```json
[
  {
    "code": "missing_acceptance_criteria",
    "severity": "high",
    "message": "plan.md 缺少明确验收条件"
  },
  {
    "code": "missing_risk_assessment",
    "severity": "medium",
    "message": "方案没有覆盖潜在风险与回滚点"
  }
]
```

### 建议按 stage 定义 rubric

#### `plan` stage

最低评测项建议包括：

- 是否说明目标、范围、非目标
- 是否列出关键风险
- 是否定义验收标准
- 是否引用正确 deliverable / service
- 是否可被下游 dev/test 直接消费

#### `dev` stage

最低评测项建议包括：

- 是否产生了对应变更或实现说明
- 是否引用 plan 产物
- 是否说明影响范围
- 是否包含必要的验证说明
- 是否存在明显未闭环的 TODO / blocker

#### `test` stage

最低评测项建议包括：

- 是否覆盖 happy path
- 是否覆盖 edge case / regression risk
- 是否明确 blocked / failed / passed
- 是否给出证据或结论
- 是否对上游变更形成有效反馈

#### `ops` stage

最低评测项建议包括：

- 是否说明部署环境和分支信息
- 是否给出部署或验证证据
- 是否定义回滚信息
- 是否把状态正确传递到 testing_confirm / release 类后续节点

### workflow 评测的执行方式

建议分三层：

#### 第一层：规则评测

先做 deterministic checks，例如：

- 文件是否存在
- front matter 是否完整
- 是否包含必须字段
- workflow 状态迁移是否符合配置
- 关键文本片段是否出现

#### 第二层：LLM judge

对规则难以覆盖的质量问题做评测，例如：

- plan 是否完整
- test 结论是否可信
- dev 说明是否真正响应了需求

#### 第三层：人工确认

对高风险 stage 保留人工确认入口，尤其是：

- 上线前
- 跨团队委派结果
- LLM judge 低置信度场景

### 与现有 workflow / workbench 的结合方式

当前项目已有：

- `src/workflow.ts`
- `src/workbench-store.ts`
- `workbench_events`
- `workbench_action_items`
- `workbench_artifacts`

这些已经很接近“评测单元”的底座，下一步建议：

- stage 完成时触发 `evaluate<Stage>()`
- 评测结果写入 `workflow_stage_evaluations`
- 同步一条摘要到 `workbench_events`
- 若未通过，生成 `action_item`
- 若需要返工，驱动 workflow 进入 revise / paused / confirm 分支

也就是说，workbench 不只是展示状态，还要展示：

- 本 stage 是否通过
- 不通过的原因
- 对应证据
- 下一步需要谁来处理

### 代码落点建议

- `src/workflow.ts`
  - 在 `onDelegationComplete`、`approveWorkflow`、状态迁移节点插入评测调用
- `src/workbench-store.ts`
  - 增加评测结果到 event / action item 的同步逻辑
- `src/db.ts`
  - 增加 `workflow_stage_evaluations` 表及读写方法
- `src/channels/web.ts`
  - 在 workbench/task detail 接口里返回 stage evaluation 结果

### 最小落地版本

第一版不需要很重，建议先做到：

1. `plan/dev/test/ops` 每个 stage 各 3~5 条 rule-based checks
2. 输出 `passed/needs_revision`
3. 结果进入 workbench 页面
4. 未通过自动生成 action item

只要这个打通，workflow 就已经从“编排器”变成“带验收能力的编排器”了。

### 不同场景的 evaluator

#### `workflow` evaluator

- 是否创建了正确 workflow
- 是否进入正确 stage
- 是否发起 delegation
- 是否写入 artifact / action item
- 失败时是否落到正确的 `failure_type`

#### `scheduler` evaluator

- 是否按时触发
- 是否正确复用或隔离 session
- 是否向正确 chat 回消息
- 非法输入或路径错误时是否标记为正确 failure category

#### `routing` evaluator

- 是否识别正确 group/chat
- 是否正确过滤 DM / sentinel / invalid chat
- 路由异常时是否区分 `routing_error` 与 `invalid_input`

#### `agent response` evaluator

- 是否包含必须信息
- 是否没有泄漏 internal tag
- 是否符合预期动作类型

### 建议统一接口

```ts
interface EvalResult {
  caseId: string;
  passed: boolean;
  score: number;
  checks: Array<{
    name: string;
    passed: boolean;
    detail?: string;
  }>;
}
```

### 命令建议

```bash
npm run eval:replay
npm run eval:workflow
npm run eval:scheduler
```

### LLM-as-judge 的后续接入点

建议后续主要用于：

- plan 文档质量
- dev/test 产出是否完整
- 最终用户回复质量
- memory summary 是否保留关键信息

但第一阶段不要把 judge 做太重，先把结构化指标跑起来。

---

## 第四层：Regression Harness

### 目标

让每次代码改动都有“保护网”。

除了现有单测，还建议补三类测试：

- contract tests
- replay tests
- invariant tests

### 1. contract tests

用于解决 API mock 易碎问题。

例如当前 `src/agent-api.ts` 在非 2xx 时会调用 `response.text()`，测试中的 mock response 如果不完整，就会测偏。

建议统一 fetch mock helper：

```ts
createMockFetchResponse({
  ok: false,
  status: 502,
  text: 'upstream bad gateway',
  json: {}
})
```

所有 API 层测试都走同一 contract。

### 2. replay tests

把真实案例转成回放测试，而不是依赖人脑记忆。

例子：

- 创建 workflow 后，状态必须从 `null -> plan`
- delegation 完成后，必须转到 `plan_examine`
- ops 完成后，必须进入 `testing_confirm`

这类测试在 `src/workflow.test.ts` 已有雏形，但还不够系统。

### 3. invariant tests

这类测试很适合 NanoClaw：

- 非 main group 不可拿到 project root 的危险宿主权限
- `group_folder` 不能逃逸路径
- task invalid folder 必须 pause，不能无限 retry
- `__group_sync__` 不能出现在用户可见 group 列表
- workflow stage transition 必须符合配置定义
- `actual_model` 回填后不得丢失 `selected_model_reason`
- 同一类错误必须被映射到稳定的 `failure_type`

这类测试通常比“输出文本等于某句”更稳。

---

## 面向当前项目的具体模块建议

### 1. `src/index.ts`

建议把这里作为统一 run 入口，新增：

- `createAgentRun(...)`
- `appendAgentRunStep(...)`
- `finishAgentRun(...)`

建议在以下时机打点：

- 收到待处理消息
- 选模型
- 拼 prompt/context
- 启 container
- 收到首个 output chunk
- 收到完成结果
- 写消息回 DB/channel
- 写入 failure taxonomy

### 2. `src/task-scheduler.ts`

建议把 loop 结构改成 “tick + loop”：

- `runSchedulerTick(deps)`
- `startSchedulerLoop(deps)`

测试直接调 `runSchedulerTick`，避免过度依赖 `setTimeout`。

这样可以显著提升可测性和 replay 兼容性。

同时建议把 scheduler 失败区分为：

- `invalid_input`
- `container_runtime_error`
- `timeout`
- `unknown_error`

### 3. `src/workflow.ts` + `src/workbench-store.ts`

这是最适合做 harness 的部分。

建议新增 stage-level evaluator：

- `evaluatePlanStage`
- `evaluateDevStage`
- `evaluateTestStage`
- `evaluateOpsStage`

评估结果可写到：

- `workbench_events`
- 或新增 `workflow_stage_evaluations`

这样 Web 端可以直接展示：

- 当前 workflow 哪一步通过了
- 哪一步卡住
- 为什么被打回
- 对应证据和返工项是什么
- 失败属于哪一类 taxonomy

### 4. `src/container-runner.ts`

建议补“执行环境快照”：

- group mounts
- custom tools 列表
- session dir
- timeout config
- runtime type
- container exit reason

不一定要全量存明文，先存 hash + 摘要也可以。

并建议在这里沉淀几类典型 failure：

- `container_runtime_error`
- `sandbox_error`
- `timeout`
- `tool_contract_error`

### 5. `src/model-selector.ts`

当前更像静态 policy，建议补结果回灌：

- 每次 run 结束后，把 outcome 和所选模型一起记下来
- 定期聚合每类任务：
  - 成功率
  - 平均时延
  - 人工返工率
  - workflow 回退率

这样 selector 才能从“规则路由”逐步升级为“效果驱动路由”。

---

## 建议里程碑

### Milestone 1：可追踪

预计 1 周左右：

- 增加 `agent_runs`
- 主流程和 scheduler 接入 run 记录
- 建立统一 failure taxonomy
- Web 面板先增加简单 run list

产出：

- 可以看到最近 100 次 agent 执行的关键过程，以及失败类型分布

### Milestone 2：可回放

预计 1~2 周：

- 建 `evals/datasets`
- 抽 30 条真实案例
- 做 `logic-only` replay runner
- workflow 和 scheduler 先接入

产出：

- 每次改 workflow / routing / scheduler，都能离线跑回归

### Milestone 3：可评测

预计 1~2 周：

- 把 workflow 从流程编排升级为流程评测单元
- 给 workflow stage 建 rule-based evaluator
- 给响应质量建基础检查
- 输出 eval report

产出：

- 开始知道“哪一个 stage 没过、为什么没过、是否需要返工”

### Milestone 4：可优化

后续持续做：

- 模型路由闭环
- prompt 版本对比
- memory pack 质量评估
- LLM judge

产出：

- 开始做真正的数据驱动优化

---

## 当前最值得优先处理的现实问题

### 1. `getAvailableGroups()` 与测试/规格漂移

当前 `src/index.ts` 的 `getAvailableGroups()` 只返回已注册群组，而旧测试语义更像“从所有 chats 中筛出可用群”。

建议尽快二选一：

- 改实现，回到“基于 chats 枚举可选群”
- 或改测试和 spec，明确“现在只展示 registered groups”

这属于典型 harness drift，需要尽快收敛。

### 2. `agent-api` 的 error contract 不统一

建议统一非 2xx fetch response 的 mock contract，避免测试测到 mock 缺陷，而不是系统行为。

### 3. scheduler 的可测性不足

建议把 `startSchedulerLoop()` 拆成 tick + loop，避免测试依赖时间推进细节。

### 4. 当前错误记录仍偏字符串化

建议尽快从“只记 error string”升级到“error string + failure taxonomy”：

- 否则很难做失败聚类
- 很难做自动打回和自动重试策略
- 很难判断优化到底降低了什么问题

---

## 一句话总结

对 NanoClaw 来说，Harness Engineering 的核心升级路径不是“更强 agent”，而是：

1. 先把每次执行变成可记录对象
2. 再把真实任务变成可回放样本
3. 再把工作流变成可评分单元
4. 最后才做模型、提示词、流程层面的数据驱动优化
