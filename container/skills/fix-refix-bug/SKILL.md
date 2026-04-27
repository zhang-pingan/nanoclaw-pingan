---
name: fix-refix-bug
description: Use only in the fix_test workflow. Re-fix bugs that failed fix_test verification, using the existing work branch and previous test evidence.
---

# Bug 复修 Skill

本技能仅用于 `fix_test` 工作流，不用于其他流程类型。

本技能用于 `fix_test` 工作流中测试未通过后的复修阶段。

## 工作流程

1. 从任务描述中读取：
   - Bug 描述
   - Bug 附件
   - 服务名称
   - 主分支
   - 预发分支
   - 工作分支
   - 预发工作分支
   - 修复文档 `fix.md`
   - 测试文档 `fix-test.md`
   - 本轮测试验证结果
2. 读取 `/workspace/global/services.json`，确认服务仓库路径。
3. 进入真实代码仓库 `/workspace/repos/{repo_path}`；如果服务配置没有 `repo_path`，再尝试 `/workspace/repos/{服务名}`。
4. 必须继续使用任务指定或 `fix.md` 中记录的工作分支，不要创建新的修复分支；空值、`N/A`、`未提供` 都视为缺少工作分支，无法确认时通过 `complete_delegation` 返回失败。
5. 以测试验证结果中的未通过问题为准，复修仍未解决的问题；不要重写与本轮失败无关的大范围逻辑。
6. 提交并 push 工作分支。
7. 在原 `fix.md` 末尾追加复修记录，包含 Round、未通过问题、修复方式、验证命令和提交信息。
8. 调用 `complete_delegation` 返回结构化结果。

## 返回结果要求

- 复修执行完成并形成明确结论时，使用 `outcome=success`。
- 执行层阻塞才使用 `outcome=failure`。
- `result` 必须是 JSON，至少包含：
  - `service`
  - `main_branch`
  - `work_branch`
  - `deliverable`
  - `verdict`
  - `summary`
  - `findings`
  - `evidence`
- 如果已确认 `staging_base_branch` 或 `staging_work_branch`，也一并返回，但它们不是 Bug 复修阶段的必填字段。
- `verdict=passed` 表示复修完成，可以重新部署预发。

成功返回示例：

```json
{
  "service": "catstory",
  "main_branch": "main",
  "work_branch": "bugfix/login-500",
  "staging_base_branch": "staging",
  "staging_work_branch": "staging-deploy/bugfix-login-500",
  "deliverable": "2026-04-27_bugfix_login-500",
  "verdict": "passed",
  "summary": "已按 Round 1 测试反馈完成复修，并追加修复记录。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-04-27_bugfix_login-500/fix.md",
      "summary": "已在 fix.md 追加复修记录"
    }
  ]
}
```

失败返回示例：

```json
{
  "service": "catstory",
  "work_branch": "bugfix/login-500",
  "staging_work_branch": "staging-deploy/bugfix-login-500",
  "deliverable": "2026-04-27_bugfix_login-500",
  "verdict": "failed",
  "summary": "测试反馈缺少可定位的问题描述，未执行复修。",
  "findings": [
    {
      "code": "missing_failed_case",
      "severity": "high",
      "message": "测试验证结果中没有明确的未通过用例或复现证据。",
      "stageKey": "bug_refix",
      "suggestion": "请补充失败用例、实际结果和证据后重跑复修阶段。"
    }
  ],
  "evidence": []
}
```
