---
name: ios-recon-requirement
description: Use only in the ios_dev_test workflow. Explore real iOS app behavior before planning, collect formal iOS evidence, and publish product-recon.json plus impact-analysis.json for downstream planning.
---

# iOS Product Recon Skill

本技能仅用于 `ios_dev_test` 工作流的 `ios_recon` 阶段。

目标：在方案设计前，用真实 iOS App 行为、网络 trace、客户端/服务端源码搜索和 formal claims 生成可追踪上下文。你只做分析和产物化，不写业务代码。

## 必须先读

1. 委派消息中的服务、需求描述、附件文件、主分支、工作分支。
2. Context Pack `latest` 文件；后续结论优先引用其中的 `INPUT-*`、`ART-*`、`CODEBASE-*`。
3. `/workspace/global/services.json` 中当前服务的 `clients.ios` 配置，确认 scheme、bundle_id、simulator、automation 配置。
4. 需求附件中的 UI 原型图、设计稿、截图、PDF 或说明文档。无法解析的附件写入 `limitations` 或 `open_questions`，不要阻断整个阶段。
5. 委派消息中的 `iOS 工作分支`：如果非空，调用 `ios_app_prepare_session` 时传 `ios_branch`；如果为空，不要猜测或复用服务端 `work_branch`，由工具使用 `clients.ios.default_branch`。

## 工具使用规则

- 必须调用 `ios_app_prepare_session` 准备 session。
- `ios_app_prepare_session` 的分支规则：`ios_branch` 只来自任务消息中的 iOS 工作分支；为空时不传，让底座使用 `clients.ios.default_branch` 并在 evidence 中记录。
- 必须用 `ios_app_observe`、`ios_app_act` 或 `ios_app_run_flow` 探索需求相关路径；无法到达时记录 blocked/limitations。
- 必须根据需求读取 `ios_app_read_trace`，并用 `ios_app_search_code` 搜索 iOS 客户端和服务端相关实现。
- 所有业务结论必须先通过 `ios_app_write_claims` 写入 `CLAIM-*`，再由 JSON 产物引用。
- JSON 产物必须通过 `ios_app_write_report` 写盘。
- `ios_host_debug_shell` 只允许排障；`DEBUG-*` 不得支撑正式 claim、plan decision 或 acceptance passed。

## 需要写出的产物

在 `/workspace/projects/{service}/iteration/{deliverable}/` 下写出：

- `product-recon.json`，必填字段：`version`、`platform`、`service`、`session_id`、`flows`、`evidence`
- `impact-analysis.json`，必填字段：`version`、`service`、`platform`、`client_impact`、`server_impact`、`evidence`
- `prototype-analysis.json` 可选；当需求附件包含 UI 原型、设计稿、截图或 PDF 且可以分析时写出

`impact-analysis.json` 规则：

- `client_impact.required` 和 `server_impact.required` 只能是 `true`、`false`、`unknown`。
- 任一 `unknown` 必须进入 `open_questions`。
- `client_impact.required=true` 必须引用 `CLIENT_CODE-*`、`OBS-*`、`FLOW-*` 或相关 `CLAIM-*`。
- `server_impact.required=true` 必须引用 `SERVER_CODE-*`、`NET-*` 或相关 `CLAIM-*`。

## complete_delegation

无论成功或失败，都必须调用 `complete_delegation`。成功时 `result` 必须是 JSON object，至少包含：

```json
{
  "service": "catstory",
  "deliverable": "2026-06-01_example",
  "main_branch": "main",
  "work_branch": "feature/example",
  "client_impact_required": true,
  "product_recon": "/workspace/projects/catstory/iteration/2026-06-01_example/product-recon.json",
  "impact_analysis": "/workspace/projects/catstory/iteration/2026-06-01_example/impact-analysis.json",
  "verdict": "passed",
  "summary": "已完成 iOS Product Recon。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "EVID-IOS-RECON-001",
      "path": "/workspace/projects/catstory/iteration/2026-06-01_example/product-recon.json",
      "summary": "已写入 product-recon.json"
    }
  ]
}
```

`outcome=failure` 只用于执行层失败或阻塞，例如缺少 iOS service 配置、Simulator 不可用、App build 不可用、关键工具调用失败、产物无法安全落盘。执行阻塞时 result 仍尽量返回 `verdict=pending`、`summary`、`findings`、`evidence` 和已知分支/交付目录。
