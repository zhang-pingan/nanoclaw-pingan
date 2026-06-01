---
name: ios-backend-bugfix
description: Use only in the ios_dev_test workflow. Fix backend issues found by iOS Acceptance or centralized testing while preserving the existing work branch.
---

# iOS 联调服务端修复 Skill

本技能仅用于 `ios_dev_test` 工作流的 `fixing` 或测试失败回修阶段。

目标：修复 iOS Acceptance 或集中测试发现的服务端问题，并保持在当前工作分支上。默认不做正式 iOS 开发。

## 必须先读

1. Context Pack `latest` 文件。
2. `plan.md`、`dev.md`。
3. 如存在，读取 `ios-test-plan.json`、`acceptance-report.json`、`test.md`。
4. 委派消息中的失败报告、bugs、主分支、工作分支。
5. `/workspace/global/services.json` 和服务端仓库 `/workspace/repos/{repo_path}`。

## 修复规则

- 优先使用委派消息中的 `工作分支`；不要自行新建额外修复分支。
- 修复范围限于服务端代码、配置、数据迁移或测试辅助数据。
- 如果问题明确属于 iOS 客户端正式开发范围，停止修改并在结果中说明，需要 iOS 团队处理。
- 修复后更新 `dev.md` 或 `test.md`，记录本轮修复内容、验证命令和剩余风险。

## complete_delegation

无论成功或失败，都必须调用 `complete_delegation`。成功 result JSON 至少包含：

```json
{
  "service": "catstory",
  "main_branch": "main",
  "work_branch": "feature/example",
  "deliverable": "2026-06-01_example",
  "verdict": "passed",
  "summary": "已修复 iOS 联调验收发现的服务端问题。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-06-01_example/dev.md",
      "summary": "已追加修复记录"
    }
  ]
}
```

`outcome=failure` 只用于执行层失败或阻塞，例如工作分支缺失、仓库不可访问、无法安全判断问题归属、无法写盘或关键验证无法执行。

