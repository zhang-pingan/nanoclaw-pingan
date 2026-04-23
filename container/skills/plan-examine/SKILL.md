---
name: plan-examine
description: Review requirement implementation plans for completeness, feasibility, risk coverage, and testability; provide actionable revision feedback.
---

# 方案审核 Skill

本技能只做方案审核，不写代码。

## 目标

对“需求评估师”输出的方案进行有效评估，明确：
- 是否可执行
- 是否覆盖关键风险与边界
- 是否具备可验证与可回滚能力

## 审核流程

1. 从任务描述中获取方案文件路径，方案文档: `/workspace/projects/{服务名}/iteration/{文件夹名}/plan.md` 
   如果文档缺失则停止进行并使用`complete_delegation` 回传结果（`outcome=failure`）
2. 根据服务名获取服务配置文件路径`repo_path`，进入仓库目录`/workspace/repos/{repo_path}`，检出并更新`主分支`
3. 按以下维度逐项评估并记录结论（通过/需修改/缺失）：
   - 需求理解与范围边界是否清晰
   - 技术方案是否可落地，是否与现有架构一致
   - 涉及文件、接口、数据结构是否具体到位
   - 风险点、兼容性、性能、安全、异常路径是否覆盖
   - 测试策略是否可执行（功能、回归、边界、失败场景）
   - 发布与回滚方案是否明确
4. 给出审核结论：
   - 通过：可进入开发
   - 有条件通过：需先完成少量修订
   - 不通过：存在关键缺陷，必须重做或大改
5. 对“需修改/缺失”项输出可执行修改建议，要求具体到内容与位置
6. 使用 `mcp__nanoclaw__send_message` 发送审核结果
7. 无论审核结论是“通过 / 有条件通过 / 不通过”，都必须调用 `complete_delegation` 回复委派结果，不允许只发普通消息后结束

## 回复委派要求

- 审核已完成并给出业务结论时，统一使用 `outcome=success`
- `outcome=failure` 只用于执行层失败或阻塞，例如：方案文档缺失、仓库无法读取、工具调用失败、结果无法形成结构化评测
- `result` 必须是 JSON，至少包含：
  - `deliverable`
  - `main_branch`
  - `work_branch`
  - `verdict`：`passed` 或 `needs_revision`
  - `summary`
  - `findings`
  - `evidence`
- 审核通过示例：

```json
{
  "deliverable": "2026-03-20_用户昵称功能",
  "main_branch": "main",
  "work_branch": "feature/user-nickname_20260320",
  "verdict": "passed",
  "summary": "方案覆盖范围、风险和测试策略完整，可以进入开发。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/plan.md",
      "summary": "已审阅 plan.md"
    }
  ]
}
```

- 审核不通过示例：

```json
{
  "deliverable": "2026-03-20_用户昵称功能",
  "main_branch": "main",
  "work_branch": "feature/user-nickname_20260320",
  "verdict": "needs_revision",
  "summary": "方案缺少回滚方案和失败场景验证，需修改后再复审。",
  "findings": [
    {
      "code": "missing_rollback_plan",
      "severity": "high",
      "message": "没有说明发布失败后的回滚步骤。",
      "stageKey": "plan_examine",
      "path": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/plan.md",
      "suggestion": "补充回滚触发条件、回滚步骤和数据影响。"
    }
  ],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/plan.md",
      "summary": "plan.md 中未找到回滚章节"
    }
  ]
}
```

- 若委派消息中带有分支信息，回传结果中必须保留并核对这些字段，避免丢失上下文

## 输出格式

```
*方案审核结果*

结论：{通过 / 有条件通过 / 不通过}

总体评价：
• {一句话总结}

关键问题（按优先级）：
1. {问题}
2. {问题}
3. {问题}

修改建议：
1. {建议}
2. {建议}
3. {建议}

复审条件：
• {需要补充或修正后再复审的条件}
```

## 原则

- 先结论后论据，避免泛泛而谈
- 优先指出阻断开发与上线的高风险问题
- 评价必须可追溯到方案中的具体内容
- 不进行代码实现，不替代开发与测试角色
