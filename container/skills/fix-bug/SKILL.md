---
name: fix-bug
description: Use only in the fix_test workflow. Fix a user-reported bug on the specified work branch, create a bug-fix deliverable, and return structured workflow results.
---

# Bug 修复 Skill

本技能仅用于 `fix_test` 工作流，不用于其他流程类型。

本技能用于 `fix_test` 工作流的首轮 Bug 修复。

## 工作流程

1. 从任务描述中确认以下信息：
   - 服务名称
   - Bug 描述
   - Bug 附件
   - 工作分支
2. 读取 `/workspace/global/services.json`，确认服务对应的仓库路径、默认分支和预发配置。
3. 进入真实代码仓库 `/workspace/repos/{repo_path}`；如果服务配置没有 `repo_path`，再尝试 `/workspace/repos/{服务名}`。
4. 必须在任务指定的工作分支上修复，不要自行新建其他分支，除非用户明确要求。
5. 先复现或定位 Bug，再做最小必要修改。
6. 完成后执行可行的验证命令，提交并 push 工作分支。
7. 创建或更新修复文档：
   - 路径：`/workspace/projects/{服务名}/iteration/{日期}_bugfix_{简短标题}/fix.md`
   - 文档需要包含 Bug 描述、附件、定位结论、修改文件、验证结果、分支信息。
8. 调用 `complete_delegation` 返回结构化结果。

## 返回结果要求

- 修复完成并形成明确结论时，使用 `outcome=success`。
- 只有仓库不可访问、分支无法确认、无法安全提交、关键工具异常等执行层阻塞，才使用 `outcome=failure`。
- `result` 必须是 JSON，至少包含：
  - `service`
  - `work_branch`
  - `staging_work_branch`
  - `deliverable`
  - `verdict`
  - `summary`
  - `findings`
  - `evidence`
- 如果已从服务配置确认 `main_branch` 或 `staging_base_branch`，也一并返回。
- `verdict=passed` 表示本轮修复已完成，可以部署预发。
- `deliverable` 是目录名，不含文件名。

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
  "summary": "已修复登录态为空时接口返回 500 的问题，并完成本地验证。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-04-27_bugfix_login-500/fix.md",
      "summary": "已写入 Bug 修复文档"
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
  "verdict": "failed",
  "summary": "无法确认服务仓库，未执行修复。",
  "error": "services.json 中未找到服务配置，且 /workspace/repos/catstory 不存在。",
  "findings": [
    {
      "code": "repo_not_found",
      "severity": "critical",
      "message": "无法访问服务仓库。",
      "stageKey": "bug_fix",
      "suggestion": "检查服务配置或仓库挂载。"
    }
  ],
  "evidence": []
}
```
