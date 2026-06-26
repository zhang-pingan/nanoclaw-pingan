---
name: deep-research-collect-review
description: Use only in the deep_research workflow collect_review stage. Validate source coverage, source quality, and search log completeness before evidence analysis.
---

# Deep Research Collect Review Skill

本技能仅用于 `deep_research` workflow 的 `collect_review` 阶段。

目标：审核 `collect` 阶段产出的公开网页来源是否足够进入证据分析。你不新增报告，不抽取最终 findings；只判断来源集是否覆盖研究计划、质量是否足够、检索记录是否可追踪。

## 必须读取

- `research_plan.json`
- `sources.json`
- `search_log.json`
- `traceability.json`

## 必须写出的文件

在交付目录下写出：

- `source_review.json`

`source_review.json` 必须是 JSON object，至少包含：

```json
{
  "schema_version": 1,
  "verdict": "passed",
  "route": "analyze",
  "summary": "来源覆盖和检索记录检查通过。",
  "checked_at": "2026-06-25T00:00:00.000Z",
  "subquestion_coverage": [],
  "missing_sources": [],
  "weak_sources": [],
  "duplicate_sources": [],
  "stale_sources": [],
  "search_log_issues": [],
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

- `analyze`
- `collect`
- `failed`
- `collect_review`

## 路由规则

- 来源覆盖、质量和检索记录足够：`verdict=passed`，`route=analyze`。
- 缺官方/一手/关键来源、覆盖不到研究计划子问题、来源过旧/重复/低质量、search_log 未说明候选或剔除原因：`verdict=needs_revision`，`route=collect`。
- 产物无法解析或来源集合明显不可用：`verdict=failed`，`route=failed`。
- 外部工具/网络状态导致无法判断但产物可能可补：`verdict=pending`，`route=collect_review`。

## 检查项

1. `sources.json` 是否覆盖 `research_plan.json` 的核心子问题和 stop criteria。
2. 是否缺少应优先使用的官方、一手、原始数据或权威来源。
3. 来源是否公开可访问，是否过旧、重复、低质量或只靠二手转述。
4. `search_log.json` 是否记录查询词、候选 URL、入选来源、剔除来源及原因、知识缺口和检索时间。
5. 时间敏感问题是否有检索时间和时效限制。
6. 历史研究上下文只能提示缺口；不得把历史来源当作本次新来源。

## complete_delegation

必须调用 `complete_delegation`。成功执行审核时即使 `verdict=needs_revision` 也使用 `outcome=success`；只有工具失败或产物无法落盘才使用 `outcome=failure`。

成功时 `result` 至少包含：

```json
{
  "deliverable": "...",
  "verdict": "passed",
  "route": "analyze",
  "summary": "来源审核通过。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "ART-SOURCE-REVIEW",
      "path": "/workspace/projects/research/iteration/.../source_review.json",
      "summary": "source_review.json 已写入"
    }
  ]
}
```
