---
name: deep-research-review
description: Use only in the deep_research workflow review stage. Validate report claims, citations, source quality, and route revisions.
---

# Deep Research Review Skill

本技能仅用于 `deep_research` workflow 的 `review` 阶段。

目标：校验 `report.json` 的主张、引用、来源质量、覆盖度和未解决缺口，输出可驱动 workflow 路由的 `review.json`。

## 必须读取

- `research_plan.json`
- `sources.json`
- `evidence.json`
- `findings.json`
- `report.json`
- `traceability.json`

## 必须写出的文件

在交付目录下写出：

- `review.json`

`review.json` 必须是 JSON object，至少包含：

```json
{
  "schema_version": 1,
  "verdict": "passed",
  "route": "publish",
  "summary": "引用和覆盖度检查通过。",
  "checked_at": "2026-06-25T00:00:00.000Z",
  "claim_checks": [],
  "missing_claims": [],
  "weak_sources": [],
  "citation_errors": [],
  "followup_queries": [],
  "required_changes": [],
  "limitations": []
}
```

`verdict` 只能是：

- `passed`
- `needs_revision`
- `failed`
- `pending`

`route` 只能是：

- `publish`
- `collect`
- `analyze`
- `write`
- `failed`
- `review`

当前第一阶段 evaluator 只粗略映射 `verdict`，`needs_revision` 会回到 `collect`；仍要在 `review.json.route` 写清理想回跳目标，便于后续增强。

## 检查项

1. 每个关键 claim 是否有 evidence/source 支撑。
2. `report.json` 的 citations 是否都存在于 `sources.json`。
3. `findings.json` 的 evidence/source 是否存在。
4. 来源质量是否足以支撑结论。
5. 是否存在冲突来源或未解决缺口。
6. report 是否包含任意 HTML/CSS/JS。
7. 时间敏感结论是否记录检索时间和时效限制。

## complete_delegation

必须调用 `complete_delegation`。成功执行 review 时即使 `verdict=needs_revision` 也使用 `outcome=success`；只有工具失败或产物无法落盘才使用 `outcome=failure`。

成功时 `result` 至少包含：

```json
{
  "deliverable": "...",
  "verdict": "passed",
  "route": "publish",
  "summary": "引用检查通过。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "ART-REVIEW",
      "path": "/workspace/projects/research/iteration/.../review.json",
      "summary": "review.json 已写入"
    }
  ]
}
```
