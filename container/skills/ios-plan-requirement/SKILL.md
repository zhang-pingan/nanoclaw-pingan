---
name: ios-plan-requirement
description: Use only in the ios_dev_test workflow. Design backend implementation plans using iOS Product Recon artifacts, explicitly separating server changes, iOS coordination, and unknown impact.
---

# iOS Recon 驱动方案设计 Skill

本技能仅用于 `ios_dev_test` 工作流的 `plan` 阶段。

本技能只做方案设计，不写代码。你的方案必须消费 `product-recon.json` 和 `impact-analysis.json`，并明确区分服务端实现、iOS 配合事项和未知项。

## 必须先读

1. Context Pack `latest` 文件。
2. `/workspace/projects/{service}/iteration/{deliverable}/product-recon.json`。
3. `/workspace/projects/{service}/iteration/{deliverable}/impact-analysis.json`。
4. 如存在，读取 `prototype-analysis.json`。
5. 委派消息中的需求描述、附件、主分支、工作分支。
6. `/workspace/global/services.json` 与服务端仓库 `/workspace/repos/{repo_path}` 中的相关代码。

若缺少 `product-recon.json` 或 `impact-analysis.json`，不能臆测 iOS 影响；应返回执行阻塞或 `verdict=pending`，说明缺失产物。

## 方案规则

- `impact-analysis.json` 中 `client_impact.required=true` 时，`plan.md` 必须有 “iOS 配合事项” 章节，列出 iOS 团队需要二次开发或联调的内容；不要默认由服务端 dev 完成。
- `client_impact.required=false` 时，必须说明不需要 iOS 改动的证据依据。
- 任一影响项为 `unknown` 时，不能当成 `false`；必须进入 `traceability.json.open_questions`，必要时向用户确认。
- 服务端改动必须具体到接口、数据结构、文件、配置、迁移或下游依赖。
- iOS 产物只作为上下文和验收证据来源；不要把 `ios_host_debug_shell` 或 `DEBUG-*` 当成 plan decision 依据。

## 写盘要求

在 `/workspace/projects/{service}/iteration/{deliverable}/` 下写出：

- `plan.md`
- `traceability.json`

`plan.md` 必须包含：

- 需求概述
- 输入资料，明确列出 `product-recon.json`、`impact-analysis.json` 和可选 `prototype-analysis.json`
- 服务端改动范围
- iOS 配合事项或无需 iOS 改动的证据说明
- 验收标准
- 风险、限制与回滚/发布注意事项

`traceability.json` 必须至少包含：

- `statements`
- `decisions`
- `actions`
- `acceptance_criteria`
- `evidence`
- `coverage`
- `open_questions`

`coverage` 必须覆盖 Context Pack 里的 required `INPUT-*`，并引用 iOS recon artifact 的 `ART-*` 或产物路径。`CODEBASE-*` 只表示仓库位置，不能作为业务或实现结论证据；基于代码得出的结论必须新增 `EVID-CODE-*`。

## complete_delegation

无论成功或失败，都必须调用 `complete_delegation`。成功时 result JSON 至少包含：

```json
{
  "service": "catstory",
  "deliverable": "2026-06-01_example",
  "main_branch": "main",
  "work_branch": "feature/example",
  "verdict": "passed",
  "summary": "方案文档已产出，可以进入方案审核。",
  "traceability_path": "/workspace/projects/catstory/iteration/2026-06-01_example/traceability.json",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "EVID-PLAN-001",
      "path": "/workspace/projects/catstory/iteration/2026-06-01_example/plan.md",
      "summary": "已写入 plan.md"
    }
  ]
}
```

`deliverable` 是文件夹名，不含 `.md` 后缀。若委派消息已提供 `主分支`、`工作分支`，回传时必须原样保留。

