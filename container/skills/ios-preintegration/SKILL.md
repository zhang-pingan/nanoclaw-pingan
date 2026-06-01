---
name: ios-preintegration
description: Use only in the ios_dev_test workflow. Prepare an iOS client work branch for preintegration when client impact is required and no existing iOS branch was supplied.
---

# iOS 预联调 Skill

本技能仅用于 `ios_dev_test` 工作流的 `ios_preintegration` 阶段。

目标：在端侧影响已确认且任务未提供现成 iOS 工作分支时，基于 `clients.ios.default_branch` 准备 iOS 联调分支并完成最小必要客户端代码处理。该阶段不是完整正式 iOS 交付。

## 必须先读

1. Context Pack `latest` 文件。
2. `plan.md`、`product-recon.json`、`impact-analysis.json`，以及可选 `prototype-analysis.json`。
3. 委派消息中的服务、服务端主分支、服务端工作分支、iOS 工作分支。
4. `/workspace/global/services.json` 中当前服务的 `clients.ios` 配置，特别是 `repo_path`、`default_branch`、scheme、bundle_id、simulator。
5. iOS 客户端仓库 `/workspace/repos/{clients.ios.repo_path}`。

## 分支规则

- 如果委派消息里的 iOS 工作分支非空：直接 checkout 该分支，不新建分支。
- 如果 iOS 工作分支为空：必须从 `clients.ios.default_branch` 创建新的 iOS 工作分支。
- 如果 `clients.ios.default_branch` 为空或仓库不可用：停止执行，返回 `verdict=pending`，说明阻塞原因。
- 不得把服务端 `work_branch` 当作 iOS 分支，除非它已经作为 iOS 工作分支明确提供。

建议新分支命名：`preintegration/{deliverable}`；若已存在则复用并说明。

## 工作边界

- 只做联调所需的最小 iOS 改动，例如临时开关、字段接入、locator/deeplink/日志埋点、测试环境配置。
- 不做大范围 UI 重构、正式产品化交互或无关代码清理。
- 修改前先确认影响面；修改后至少执行可证明的本地检查或说明无法执行的原因。
- 如需要真实 App 验证，可调用 `ios_app_prepare_session`，此时传入最终 `ios_work_branch` 作为 `ios_branch`。

## 交付要求

可写出：

- `/workspace/projects/{service}/iteration/{deliverable}/ios-preintegration.md`
- `/workspace/projects/{service}/iteration/{deliverable}/ios-preintegration-report.json`

文档应记录：

- 最终 iOS 工作分支
- 基于哪个 `clients.ios.default_branch` 创建或复用
- 修改文件和原因
- 已执行验证或阻塞原因

`ios-preintegration-report.json` 必填字段：

- `version`
- `platform`
- `service`
- `ios_work_branch`
- `base_branch`
- `changes`
- `verdict`
- `evidence`

## complete_delegation

无论成功或失败，都必须调用 `complete_delegation`。成功 result JSON 至少包含：

```json
{
  "service": "catstory",
  "deliverable": "2026-06-01_example",
  "main_branch": "main",
  "work_branch": "feature/example",
  "ios_work_branch": "preintegration/2026-06-01_example",
  "ios_preintegration_report": "/workspace/projects/catstory/iteration/2026-06-01_example/ios-preintegration-report.json",
  "verdict": "passed",
  "summary": "已完成 iOS 预联调分支准备。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "EVID-IOS-PRE-001",
      "path": "/workspace/projects/catstory/iteration/2026-06-01_example/ios-preintegration.md",
      "summary": "已写入 iOS 预联调记录"
    }
  ]
}
```

如果无法创建或确认 iOS 分支，返回 `verdict=pending`，`summary` 说明阻塞原因，并尽量保留 `service`、`deliverable`、`main_branch`、`work_branch`。
