---
name: ios-backend-dev-requirement
description: Use only in the ios_dev_test workflow. Implement backend changes from an iOS Recon-driven plan while preserving iOS coordination boundaries.
---

# iOS 联调服务端开发 Skill

本技能仅用于 `ios_dev_test` 工作流的 `backend_dev` 阶段。

本技能负责按照已确认的方案实现服务端改动。默认不做正式 iOS 开发；如方案包含 iOS 配合事项，只在 `dev.md` 中记录联调依赖和待 iOS 团队处理事项。

## 必须先读

1. Context Pack `latest` 文件。
2. `plan.md`、`product-recon.json`、`impact-analysis.json`，以及可选 `prototype-analysis.json`。
3. 委派消息中的服务、主分支、工作分支、需求描述和附件。
4. `/workspace/global/services.json` 中当前服务的 `repo_path`，进入 `/workspace/repos/{repo_path}` 实现服务端改动。

## 实现边界

- 只实现服务端改动。
- 不直接修改 iOS 正式代码。
- 如确实需要 iOS 团队或联调分支配合，在 `dev.md` 中明确列出：
  - 受影响页面/flow
  - API contract 或字段变化
  - deeplink、feature flag、测试账号、seed data 或 locator 依赖
  - 仍需 iOS 团队确认的事项

## 交付要求

写出：

- `/workspace/projects/{service}/iteration/{deliverable}/dev.md`
- `/workspace/projects/{service}/iteration/{deliverable}/traceability.json`

`traceability.json` 必须覆盖 Context Pack required `INPUT-*`，并引用 plan/recon artifacts。基于代码或测试得到的新事实必须新增可校验证据，不要把 `CODEBASE-*` 当成业务结论依据。

## complete_delegation

无论成功或失败，都必须调用 `complete_delegation`。成功 result JSON 至少包含：

```json
{
  "service": "catstory",
  "main_branch": "main",
  "work_branch": "feature/example",
  "deliverable": "2026-06-01_example",
  "verdict": "passed",
  "summary": "服务端开发完成，可以进入开发复核。",
  "traceability_path": "/workspace/projects/catstory/iteration/2026-06-01_example/traceability.json",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "EVID-DEV-001",
      "path": "/workspace/projects/catstory/iteration/2026-06-01_example/dev.md",
      "summary": "已写入 dev.md"
    }
  ]
}
```

