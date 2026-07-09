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
PM Pipeline：独立一级业务应用，复用 Workflow Runtime 和 Workbench Core
```

核心原则：

- 统一执行，不统一页面。
- PM Pipeline 不以现有 Workbench 页面为主入口。
- Workbench 不再承担所有业务的统一操作台角色。
- Workbench 拆成底层能力 `Workbench Core` 和兜底页面 `Execution Console`。
- 各业务应用拥有自己的一级页面和领域交互，但共享 workflow、trace、artifact、human review、permission、audit 等底层协议。

## 目标

- 完整迁移 `ai_workspace_pm` 的 PM 产研包流水线。
- 保持 prompt、agent 文档、skill 文档、模板、脚本、目录、CSV schema、产出包契约不变。
- 把 Claude Code 的 `/command + subagent + skill + hook` 运行模型替换为 Icarus 的 `workflow + container delegation + host action + human review`。
- 为 PM Pipeline 新增一级导航和专属页面，支持丰富交互。
- 让所有执行状态落在统一 workflow runtime 中，避免 PM 页面和通用控制台出现双状态。
- 保留通用 Execution Console 的观察、暂停、重试、取消、trace 排障能力。
- 后续其他复杂 agent 业务也按同一模式扩展：独立业务页面 + 共享底层执行基础设施。

## 非目标

- 不要求 PM 页面兼容现有 Workbench 的页面形态。
- 不把现有 Workbench 继续设计成所有业务的主操作入口。
- 不重写原有 PM prompt 的业务语义。
- 不把 PM 产物转换成 Icarus 私有格式后丢失原文件事实源。
- 不建立第二套独立于 workflow runtime 的 PM 执行状态机。

## 总体架构

```text
PM Pipeline 一级页面
  - 总览
  - 待办 / Gate
  - 需求开发
  - 交付包
  - 评估沉淀
  - Prompt 自进化
  - Agent 轨迹
  - 设置
        |
        v
PM Pipeline Domain API / Projection
  - 将 workflow 通用状态投影成 PM 业务语义
  - 将 PM 页面动作翻译成 workflow command
        |
        v
Workflow Runtime
  - state machine
  - delegation
  - interrupt / human review
  - system action
  - artifact contract
  - retry / pause / cancel / skip
  - trace / event / audit
        |
        v
Container Agent / Host Actions
  - 读取原 .claude/agents
  - 调用原 .claude/skills
  - 执行白名单 scripts
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
```

Execution Console 与 PM Pipeline 平行存在：

```text
Execution Console
  - 所有 workflow 可见
  - 通用 timeline
  - 通用 artifact 列表
  - 通用 action item
  - pause / retry / cancel / skip
  - raw trace / event / payload 排障
        |
        v
Workflow Runtime
```

Execution Console 是兜底和调试工具，不是 PM 的主使用界面。

## 分层职责

### Workflow Runtime

Workflow Runtime 是真正的底层执行面。

职责：

- 保存 workflow 实例、状态、round、context。
- 推进 delegation、interrupt、system state、terminal state。
- 创建和恢复 human review。
- 记录 agent trace、event、checkpoint、stage evaluation。
- 执行 retry、pause、resume、cancel、skip。
- 调用 artifact contract 和 quality gate。
- 调用 host action 和 container agent。

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
- Command dispatch：`resumeWorkflowInterrupt`、`retryWorkflowStage`、`pauseWorkflow` 等。
- Permission、risk、audit、idempotency。
- 前端通用组件，如 trace viewer、timeline、artifact viewer、action panel。

不承担：

- 不强迫各业务页面使用同一个通用任务详情 UI。
- 不限制 PM Pipeline 增加领域组件。
- 不让通用数据模型取代业务投影模型。

### Execution Console

Execution Console 是通用兜底控制台。

职责：

- 查看所有 workflow。
- 查看通用 timeline、trace、artifact、interrupt。
- 做通用 pause、retry、cancel、skip。
- 排查失败 stage、agent output、contract validation。
- 当业务页面没有覆盖某类异常时，提供兜底操作。

限制：

- 不承载 PM Pipeline 的主要工作流体验。
- 不展示完整 PM 领域操作，例如视觉改图、交付包终审决策、prompt patch 审批。

### PM Pipeline

PM Pipeline 是独立一级业务应用。

职责：

- 提供 PM 专属导航、页面、交互和数据视图。
- 把一句话需求、初始化、交付包、Gate、评估沉淀、prompt 自进化做成产品化体验。
- 将 PM 操作翻译成 workflow command。
- 从 workflow 和文件事实源生成 PM projection。
- 保留原流水线的文档、脚本、产物和目录契约。

限制：

- 不维护独立执行状态机。
- 不绕过 workflow runtime 直接推进阶段。
- 不绕过 script/hook/contract 做危险状态变更。

## PM Pipeline 页面设计

页面按 PM 业务组织，不按底层 workflow 名称组织。二级导航只放长期稳定工作区；一次性初始化、定时触发、promote、regression 等具体动作放在总览卡片、设置或三级详情页按钮中。

推荐二级导航：

```text
PM Pipeline
├─ 总览
├─ 待办 / Gate
├─ 需求开发
├─ 交付包
├─ 评估沉淀
├─ Prompt 自进化
├─ Agent 轨迹
└─ 设置
```

不单独设置 `初始化` 二级导航。`init-project` / `init-docs` 是 workspace bootstrap 动作，放在总览的初始化卡片中；执行完成后主按钮置灰，保留查看记录、重新校验、修复缺失项等次级动作。

不单独设置 `周期任务` 二级导航。weekly/monthly 的 schedule 配置归 `设置`，最近状态和手动快捷触发放在 `总览`，周期评估结果归 `评估沉淀`，prompt patch 审批和版本管理归 `Prompt 自进化`。

### 1. 总览

展示：

- 当前 workspace 健康状态。
- 进行中的 workflow：需求开发、promote、周报、prompt 月更、初始化修复等。
- 待 PM 处理：Gate、rubric 抽样、prompt patch 审批、retrospect 漏登处置、regression fail 决策。
- 最新 `.draft`、`.active`、`.done` 包。
- 最近周报、pending prompt patches、下次 weekly/monthly 定时任务时间。
- Workspace 初始化卡片：`init-project`、`init-docs` 是否已完成。

主要动作：

- `发起新需求`：创建 `pm_new_feature` workflow。
- `继续最近需求`：跳转需求详情。
- `查看全部需求`：进入需求开发二级页。
- `开始 init-project` / `开始 init-docs`：仅未完成时可点，完成后置灰。
- `查看初始化记录`、`重新校验`、`修复缺失项`。
- `立即跑周报`：创建 `pm_pipeline_review` workflow。
- `开始 prompt 月更`：创建 `pm_optimize_prompts` workflow。
- `打开 Execution Console`：排障入口。

总览只做状态摘要、初始化提示和高频快捷入口，不承载完整编辑、审批、promote 或 prompt 合并能力。

### 2. 待办 / Gate

集中展示所有 human review / workflow interrupt。

能力：

- 需求 Gate：Gate 1、1.5a、1.5b、2、3。
- A2 soft gate 警告逐条裁决。
- D1 模块拆分确认、D2 存量基线裁决。
- 周报 rubric 抽样确认。
- retrospect 漏登处置。
- prompt patch approval。
- regression fail 后的保留 pending / reject 决策。
- 初始化失败后的修复确认。

详情页动作：

- `批准`、`拒绝`、`要求修改`、`跳过`。
- `重试`、`回退`、`指派到某 workflow`。
- `查看上下文`、`打开原产物`、`打开 trace`。

要求：

- 每个问题必须用业务语言呈现。
- 每个选项带业务后果。
- 决策最终调用 `resumeWorkflowInterrupt` 或等价 workflow command。
- 决策写回对应 markdown、`pipeline-state.json` 和 workflow interrupt。

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
- `重试当前阶段`、`回退到上一阶段`、`跳过非必要阶段`。
- `生成 .draft`、`运行 final check`。
- `打开 trace`、`打开 Console`。

底层仍然推进一个 `pm_new_feature` workflow。

需求详情只放本需求相关动作，不放周期评估、prompt 自进化、workspace 设置等跨需求入口。

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
- `校验 evals`。
- `同步 baseline backflow`。
- `查看 99-状态`。
- `查看提交记录`。
- `打开包目录`。

promote 必须调用原 `scripts/promote.sh` 或等价 host action，不能直接改名移动目录。

### 5. 评估沉淀

对应：

- `evals/runs.csv`
- `evals/loops.csv`
- `evals/escapes.csv`
- `knowledge/cases.csv`
- `knowledge/patterns/`
- `evals/weekly/`

能力：

- 周报列表和周报详情。
- 趋势图和表格。
- escape 分析。
- loop 收敛指标。
- rubric 抽样状态。
- case 索引查看。
- pattern 查看。

建议内部 tabs：

- `周报`
- `runs`
- `loops`
- `escapes`
- `cases`
- `patterns`
- `rubrics`

详情页动作：

- `查看周报`。
- `生成本周 rubric 骨架`。
- `标记 pattern dormant`。
- `恢复 pattern active`。
- `导出 CSV`。
- `打开关联交付包`。
- `打开关联 trace`。
- `跳转 Prompt 自进化`。

评估沉淀只展示周期评估结果和知识库，不承担 prompt patch 合并。

### 6. Prompt 自进化

对应原 `/optimize-prompts`。

能力：

- pending patch backlog。
- 按 agent、锚点、重复次数、优先级聚合。
- prompt patch diff。
- LOCKED 检查结果。
- transaction 状态。
- regression-set pass/fail。
- applied/rejected 历史。
- `agent-versions.json`。
- `PROMPT-CHANGELOG.md`。

建议内部 tabs：

- `Pending`
- `审批中`
- `Regression`
- `Applied`
- `Rejected`
- `Agent Versions`
- `Changelog`

详情页动作：

- `开始月更`。
- `只看某 agent`。
- `批准 patch`。
- `拒绝 patch`。
- `改写后批准`。
- `保留到下月`。
- `运行 regression`。
- `提交 transaction`。
- `丢弃 transaction`。
- `查看 regression trace`。

底层推进 `pm_optimize_prompts` workflow。

定时月更只能启动 workflow 并停在审批 gate，不能自动合并 prompt patch。

### 7. Agent 轨迹

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
- `重试 stage`。
- `打开关联 artifact`。
- `打开 Execution Console`。

Agent 轨迹是排障和审计页，不承担业务审批。

### 8. 设置

设置负责 workspace 的持续维护，不负责承载日常业务流程。

分组：

- `Workspace`：名称、路径、项目 profile、目录健康检查。
- `Git / Repo`：业务仓路径、默认分支、hooks 安装状态、push policy、只读/写保护规则。
- `自动化 / 定时任务`：weekly `pm_pipeline_review`、monthly `pm_optimize_prompts` 的启用状态、schedule、trigger history、手动重跑指定周期。
- `执行策略`：host action allowlist、container mount、脚本权限。
- `Artifact / Projection`：contract 开关、文件事实源对账、重建 projection。
- `审计`：初始化记录、配置变更记录、执行日志。

详情页动作：

- `切换 workspace`。
- `编辑 schedule`。
- `校验 workspace`。
- `同步文件事实源`。
- `重建 projection`。
- `查看审计日志`。

`init-project` 负责 bootstrap：创建 workspace 初始结构、写 `PROJECT-PROFILE.md` / `CLAUDE.md` / `.claude` assets、初始化 scripts/hooks/git policy 默认值并做首次校验。初始化后，git、repo、hooks、schedule、allowlist、mount policy 等配置修改都归设置页维护。

## 执行状态与页面状态

禁止 PM 页面维护独立执行状态。

唯一执行状态来自：

- workflow table。
- workflow events。
- workflow interrupts / human review。
- delegations。
- agent query trace。
- artifact contract records。
-文件事实源中的 `pipeline-state.json`。

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

PM 页面动作翻译成 workflow command。

示例：

```text
PM 页面动作：
  通过 Gate 1.5b，进入 A2

底层 command：
  resumeWorkflowInterrupt({
    workflowId,
    interruptId,
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
| `.claude/commands/*.md` | workflow definition + PM 页面入口 |
| `Agent(subagent_type=...)` | workflow delegation |
| `.claude/agents/*.md` | container agent persona/source prompt |
| `.claude/skills/*` | container skills，路径兼容或 adapter 映射 |
| `.claude/settings.json deny` | host/container policy + mount policy + tool guard |
| Claude Code PreToolUse hook | container runner tool policy / host hook |
| Claude Code PostToolUse hook | artifact/csv write validator |
| Claude Code SessionStart hook | workflow/session context injection |
| `AskUserQuestion` | human review / workflow interrupt |
| `.claude/workflows/*.js` | host action 或 container workflow adapter |
| `scripts/*.sh` | allowlisted host script runner |
| `pipeline-state.json` | 文件事实源保留，workflow DB 做镜像 |

## PM Workspace 设计

迁移后需要支持多个 PM workspace。

每个 PM workspace 保留原目录结构：

```text
pm-workspaces/{workspaceId}/
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

也可以直接注册现有目录：

```text
/Users/chelaile/IdeaProjects/ai_workspace_pm
```

Icarus 保存 workspace registry：

```ts
interface PmWorkspace {
  id: string;
  name: string;
  rootPath: string;
  status: 'ready' | 'needs_init' | 'disabled';
  projectProfilePath: string;
  createdAt: string;
  updatedAt: string;
}
```

所有 PM workflow 都必须绑定 `pmWorkspaceId`。

## 完整 workflow 清单

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
-> validate_evals
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

### pm_pipeline_review

迁移 `/pipeline-review`：

触发方式：

- 定时任务：按 workspace 配置的 weekly schedule 创建 `pm_pipeline_review` workflow。
- PM 手动按钮：PM Pipeline「评估沉淀 / 周报」入口手动创建同一个 workflow，可指定周次。
- 两种触发都只发 workflow command，不直接调用 evaluator 或写周报。
- 同一 workspace + 同一周次只允许一个运行中的 `pm_pipeline_review`；重复触发进入已有 workflow 或提示 PM 重跑确认。

```text
load_evals
-> run_pipeline_evaluator
-> write_weekly_report
-> completed
```

### pm_optimize_prompts

迁移 `/optimize-prompts`：

触发方式：

- 定时任务：按 workspace 配置的 monthly schedule 创建 `pm_optimize_prompts` workflow。
- PM 手动按钮：PM Pipeline「Prompt 自进化」入口手动创建同一个 workflow，可选择全量 pending 或指定 agent。
- 两种触发都必须进入 `gate_prompt_change_approval`，不得定时自动应用 prompt patch。
- 同一 workspace + 同一月度周期只允许一个运行中的 `pm_optimize_prompts`；手动重跑必须复用 pending/applied/rejected 文件事实源做幂等检查。

```text
load_pending_patches
-> evaluate_patch_set
-> gate_prompt_change_approval
-> begin_prompt_patch_transaction
-> apply_patch_to_shadow_workspace
-> run_regression_set_in_container
-> if_pass_commit_prompt_transaction
-> if_fail_discard_transaction_and_write_rejected
-> completed
```

`pm_optimize_prompts` 的 regression-set 和回滚推荐采用事务工作区方案，不在真实 PM workspace 上先改后回滚。

关键约束：

- `gate_prompt_change_approval` 只批准候选 patch 和目标 diff，不直接修改 `.claude/agents/*.md`。
- regression 通过前，真实文件事实源保持不变，包括 `.claude/agents/*.md`、`optimization/agent-versions.json`、`optimization/PROMPT-CHANGELOG.md`、`patches-pending/applied/rejected`。
- Host action 创建 `PromptPatchTransaction`，在 workflow execution storage 中准备 shadow workspace。实现上可以复制受控文件，也可以在具备条件时用 git worktree，但协议不依赖 git。
- Host action 在 shadow workspace 内执行确定性文件操作：LOCKED 锚点校验、应用 diff、生成 patch id、预写版本变更、预写 changelog、标记 pending 处理结果。
- Container adapter 挂载 shadow workspace 跑 regression-set：加载修改后的目标 agent prompt，读取 `evals/regression-set/cases.csv` 和 `expected/<case_id>/<agent>/`，逐 case 调用目标 agent，输出结构化 pass/fail 结果和 trace。
- regression 全 pass 后，Host action 才把 shadow workspace 中的受控变更提交回真实 PM workspace，并落盘 `patches-applied`、`PROMPT-CHANGELOG.md`、`agent-versions.json`、pending 处理标记。
- regression fail 时，不需要回滚真实文件；直接丢弃 transaction workspace，并按 PM 决策写 `patches-rejected` 或保留 pending。失败 case、actual/expected 摘要和 trace 必须记录到 workflow artifact。
- 页面只展示 patch diff、审批 gate、regression 结果和 commit/reject 状态；页面无权直接编辑 prompt 文件。

结构化 regression result 示例：

```ts
interface PmPromptRegressionResult {
  transactionId: string;
  workspaceId: string;
  agent: string;
  oldVersion: string;
  proposedVersion: string;
  cases: Array<{
    caseId: string;
    result: 'pass' | 'fail';
    expected: string;
    actual: string;
    reason?: string;
    traceId?: string;
  }>;
}
```

### pm_iterate_a2 / pm_iterate_a7

迁移尾部和头部自动回炉循环：

```text
load_target_draft
-> run_fix_agent
-> run_review_agent
-> check_round_cap
-> completed_or_escalate
```

### pm_named_case_workflows

迁移：

- `gen-cases`
- `gen-cases-spec`
- `coverage-audit`

作为 host action 或 container workflow adapter 调用，结果仍写回原文件。

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
- `pm.prompt_regression_result.v1`

Contract 不替代原脚本。脚本仍是权威机械检查之一，contract 用于 Icarus 统一展示、阻断、trace 和质量门。

## Human Review 统一协议

PM Gate 不应该只是页面表单，而应该统一进入 human review/interrupt 协议。

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
  | 'prompt_patch_approval'
  | 'promote_confirmation';
```

每个 Gate 需要：

- title。
- business impact。
- evidence links。
- actions。
- payload schema。
- allowed channels。
- audit fields。
- idempotency key。

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
- workflow action permission。

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

迁移为 write observer：

- 监听 evals/test CSV 写入。
- 写后自动执行对应 validate script。
- 失败时标记当前 stage needs_revision 或 failure。

### session-start-brief

迁移为 workflow context pack：

- 在每个 PM delegation 前注入当前 workspace brief。
- 包含 active/draft/done 状态、pending gates、ledger 对账。

## Script Runner

PM 脚本必须白名单执行。

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

- script path。
- args。
- cwd。
- exit code。
- stdout/stderr 摘要。
- duration。
- produced artifacts。

## PM Pipeline Domain Projection

需要新增 PM 专属投影层。

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
```

Projection 来源：

- workflow DB。
- workbench/action/human review 表。
- agent query trace。
- PM workspace 文件扫描。
- `pipeline-state.json`。
- script 输出和 artifact contract evaluation。

Projection 可以缓存，但不能成为执行事实源。

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
- pause/retry/cancel/skip。

Console 不需要展示：

- PM Gate 的完整业务化选择 UI。
- visual demo before/after 对比。
- deliverable 12 文档领域结构。
- prompt patch 产品化审批。

PM 页面可以提供“打开 Console”链接，用于排障。

## 一致性原则

### 不建双状态

错误模式：

```text
PM 页面保存 currentStep=A3
Workflow 保存 status=A2_review
pipeline-state.json 保存 current_step=A4
```

正确模式：

- workflow 是执行事实。
- `pipeline-state.json` 是原流水线兼容事实。
- PM projection 负责对账。
- 对账不一致时进入异常状态，由 Console 或 PM 修复动作处理。

### 领域动作必须落回通用 command

PM 页面所有动作最终调用：

- `createWorkflow`
- `resumeWorkflowInterrupt`
- `retryWorkflowStage`
- `returnWorkflowToStage`
- `pauseWorkflow`
- `cancelWorkflow`
- `runWorkflowAction`

不得直接改 workflow 表或直接移动包状态。

### 文件事实源保持原样

原有文件仍是可移植产物事实：

- `PROJECT-PROFILE.md`
- `product-docs/_drafts/...`
- `deliverables/*.draft|active|done`
- `pipeline-state.json`
- `evals/*.csv`
- `knowledge/*.csv`
- `optimization/*`

Icarus 的 DB 是执行和索引事实，不替代这些文件产物。

## 迁移资产清单

从 `ai_workspace_pm` 迁移：

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

其中：

- `.claude/commands` 作为 workflow 编译输入或人工参考，不直接作为运行入口。
- `.claude/agents` 原文作为 stage persona。
- `.claude/skills` 保持路径兼容，供 agent 读取。
- `scripts` 保持原样，外层加 allowlist runner。
- `deliverables/_template` 保持原样。

## 验收标准

完整迁移的验收不以自然语言输出逐字一致为标准，而以流程、契约、状态和产物一致为标准。

必须满足：

- 原 `/new-feature` 的 A1-A7 顺序和条件分支一致。
- 所有 Gate 均显式暂停，PM 不确认不继续。
- UI 类需求触发 A1.5，非 UI 类跳过并留痕。
- A4 触发 A5 的条件一致。
- A6/A7 CSV schema 和 lint 行为一致。
- 生成的 `.draft` 包目录和文件结构一致。
- `deliverable-final-check.sh` 能被调用并阻断 BLOCKER。
- `.draft -> .active -> .done -> archive` 必须通过 promote action。
- `.done` 后 retrospector 写入 `runs.csv`、`loops.csv`、`cases.csv`、`patches-pending`。
- `pipeline-state.json` 保留并被持续更新。
- PM 页面和 Execution Console 看到同一个 workflow 状态。
- retry、pause、cancel、skip 不产生状态分裂。
- 原 `code/` 写保护和 archive 写保护仍生效。

## 风险与处理

### 风险 1：PM 页面过强，绕开 workflow

处理：

- 所有业务动作只能调用 workflow command。
- 页面无权直接推进 stage。
- 所有 stage transition 由 workflow runtime 写 event。

### 风险 2：为了兼容 Console 限制 PM 页面

处理：

- 只兼容底层协议，不兼容页面形态。
- PM 页面可自由扩展领域组件。
- Console 只做 raw fallback。

### 风险 3：文件事实源与 DB 不一致

处理：

- 每个关键 state 增加 reconciliation action。
- Projection 显示对账异常。
- `pipeline-state.json`、deliverable 状态、workflow status 三方对账。

### 风险 4：原 prompt 路径依赖强

处理：

- PM workspace 保留原目录结构。
- container 内尽量挂载成与原工作区一致的路径。
- 对 `.claude/skills` 和 `scripts` 做路径兼容。

### 风险 5：LLM 输出无法逐字一致

处理：

- 验收改用结构、contract、script、Gate、产物一致。
- 对关键字段使用 artifact contract 和脚本硬闸。
- 对 golden case 做语义和结构 diff。

## 推荐落地顺序

虽然本方案按完整迁移设计，不以 MVP 为目标，但工程落地仍建议按依赖顺序实现，避免循环返工：

1. PM workspace registry。
2. Workbench Core / Execution Console 分层整理。
3. Human review 通用协议。
4. PM asset adapter：agents、skills、scripts、templates。
5. PM workflow definitions。
6. PM Pipeline Domain API / Projection。
7. PM Pipeline 一级页面。
8. Hook/policy 等价层。
9. Golden replay 验收集。
10. 完整迁移验收和旧 Claude Code 入口冻结。

这不是功能裁剪，只是实现依赖顺序。

## 最终形态

最终 Icarus 中会形成一套可复用模式：

```text
业务一级页面
  -> 业务 Domain Projection
  -> Workflow Runtime
  -> Container Agent / Host Action
  -> 文件或外部系统事实源

Execution Console
  -> 同一个 Workflow Runtime
```

PM Pipeline 是第一套复杂业务应用。后续其他 agent team、运维流程、自我进化、员工支持、知识生产等，都可以复用这套结构：独立业务页面，不共享页面上限；统一执行内核，不分裂状态和审计。
