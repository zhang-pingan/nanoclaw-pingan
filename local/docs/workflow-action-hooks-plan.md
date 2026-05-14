# Workflow Action Hooks Implementation Plan

## 背景

`system` 节点已经支持通过 `run.steps` 调用 workflow action handler，用程序执行确定性能力。后续希望把 `dev_test` 等工作流中部分 agent 周边动作拆出来，例如服务配置解析、分支准备、文档校验、测试报告统计、部署触发等，以降低 agent 不确定性并提升效率。

直接把这些动作拆成多个独立 workflow 节点会让链路变碎，例如 `dev` 阶段被拆成 checkout、pull、create branch、collect diff、validate doc 等节点。主流程图会变成执行日志，不再表达业务阶段。

因此采用 hook 方案：workflow 节点继续表达业务阶段，action handler 作为节点内部生命周期 hook 执行。

## 设计原则

1. Workflow 节点只表达业务可理解的阶段，例如 `plan`、`dev`、`ops_deploy`、`testing`。
2. Action handler 表达阶段内部的确定性步骤，不直接污染主流程图。
3. `system.run.steps`、`delegation.before_delegate.steps`、`delegation.after_complete.steps` 复用同一套 action handler 注册与执行机制。
4. Hook 执行详情通过 workflow event 记录，可在 UI 中作为节点执行明细展示。
5. 现有工作流定义保持兼容；不配置 hook 时行为不变。

## 配置形态

Delegation 节点新增两个可选字段：

```json
{
  "type": "delegation",
  "label": "开发",
  "before_delegate": {
    "steps": [
      {
        "id": "prepare_workspace",
        "uses": "dev.prepare_workspace",
        "with": {
          "service": "{{service}}",
          "work_branch": "{{work_branch}}"
        }
      }
    ]
  },
  "delegate": {
    "role": "dev",
    "skill": "dev-requirement"
  },
  "after_complete": {
    "steps": [
      {
        "id": "finalize_delivery",
        "uses": "dev.finalize_delivery"
      }
    ]
  },
  "on_complete": {
    "success": { "target": "dev_examine" },
    "failure": { "target": "dev" }
  }
}
```

当前只先实现能力层，`dev_test` 暂不实际配置这些 hook。

## 生命周期语义

### `before_delegate`

执行时机：创建 delegation 之前。

用途：
- 补齐 workflow context，例如 `main_branch`、`work_branch`、`deliverable`。
- 校验前置条件，例如服务配置存在、仓库可访问、方案文档存在。
- 准备环境，例如 checkout 或创建工作分支。

行为：
- hook 成功后，context patch 会参与后续任务模板渲染和 handoff 输入。
- hook 失败时，不创建 delegation，当前阶段停止自动推进并记录失败事件。
- 未配置或 `steps` 为空时视为 no-op success。

### `after_complete`

执行时机：agent 调用 `complete_delegation` 后，阶段 evaluator 和 transition 之前。

用途：
- 读取 `latest_delegation_result`，做结构化归一化。
- 从文档或报告中提取统计字段。
- 校验并补齐 context，例如 `test_doc`、`staging_work_branch`。
- 将 agent 回传结果转换成稳定的后续流程输入。

行为：
- hook 成功后，context patch 会参与 evaluator 和后续 transition。
- hook 失败时，不继续 evaluator/transition，当前阶段停止自动推进并记录失败事件。
- 未配置或 `steps` 为空时视为 no-op success。

## Runtime 实现

核心实现方向：

1. 保留 `WorkflowActionHandler` 注册机制不变。
2. 将原 `runSystemSteps` 泛化为通用 action steps runner。
3. `system` 节点继续调用同一 runner，但事件名保持兼容：
   - `system_step_started`
   - `system_step_completed`
   - `system_step_pending`
   - `system_step_failed`
4. delegation hook 调用同一 runner，并记录 hook 事件：
   - `workflow_hook_started`
   - `workflow_hook_completed`
   - `workflow_hook_pending`
   - `workflow_hook_failed`
   - `workflow_hook_step_started`
   - `workflow_hook_step_completed`
   - `workflow_hook_step_pending`
   - `workflow_hook_step_failed`
5. 所有创建 delegation 的路径统一走 `before_delegate`：
   - 入口即 delegation
   - transition 进入 delegation
   - 手动 retry stage
   - evaluator pending retry
6. `onDelegationComplete` 在 evaluation 前执行 `after_complete`。

## 可程序化候选能力

优先做粗粒度 composite handler，避免把底层操作直接暴露成主流程节点。

### 通用准备能力

- `service.resolve`：读取 `services.json`，解析 `repo_path`、`default_branch`、`staging` 配置。
- `artifact.resolve`：计算 `plan_doc`、`dev_doc`、`test_doc` 路径。
- `artifact.require`：校验文档存在、frontmatter、大小和必填字段。
- `branch.resolve_work`：确定工作分支。
- `branch.resolve_staging`：确定预发基线和预发工作分支。

### Dev 阶段

- `dev.prepare_workspace`：服务解析、仓库存在校验、工作分支准备。
- `dev.finalize_delivery`：收集 diff、校验 `dev.md`、运行配置化验证、补齐 handoff 字段。

代码实现本身仍由 agent 负责。

### Ops 阶段

- `ops.deploy_staging`：合并工作分支到预发工作分支、push、触发 Jenkins、轮询结果、返回部署 evidence。

这是最适合优先程序化的完整阶段能力。若 merge 冲突或配置缺失，可失败或 fallback 到 ops agent。

### Testing 阶段

- `test.finalize_report`：解析 `test.md`，统计 `total/passed/failed/blocked`，提取 `BUG-xxx`，生成稳定 verdict。
- 后续如果服务具备标准 API collection 或测试脚本，再考虑将测试执行也程序化。

测试判断和复杂验证仍由 agent 负责。

### Review 阶段

- `review.static_gate`：检查文档完整性、风险/回滚/测试章节、实现与计划文件列表是否一致。

语义 code review 和方案合理性判断仍由 agent 负责。

## 迁移顺序

1. 先保留当前 `dev_test` 主流程图不变，只落地 hook 能力。
2. 增加通用 handler：`service.resolve`、`artifact.resolve`、`artifact.require`、`branch.resolve_*`。
3. 在 `dev` / `fixing` 上配置 `before_delegate` 做前置准备。
4. 在 `dev` / `testing` 上配置 `after_complete` 做结构化归一化和文档校验。
5. 将 `ops_deploy` 优先改造成程序化部署能力，必要时保留 agent fallback。
6. 最后再考虑 review/static gate 和测试执行的进一步程序化。

## 成功标准

- 主 workflow 图不增加零碎技术节点。
- 不配置 hook 时现有流程行为完全兼容。
- 配置 hook 后，agent 收到的任务上下文更稳定，分支和文档路径不再依赖 agent 自行推断。
- 失败原因可分类、可审计、可重试。
- action handler 输出能通过 context patch 稳定影响后续模板、evaluator 和 transition。

