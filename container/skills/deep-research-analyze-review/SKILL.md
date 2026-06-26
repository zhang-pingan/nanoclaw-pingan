---
name: deep-research-analyze-review
description: Use only in the deep_research workflow analyze_review stage. Validate evidence extraction, finding support, conflict handling, and route analysis or collection revisions.
---

# Deep Research Analyze Review Skill

本技能仅用于 `deep_research` workflow 的 `analyze_review` 阶段。

目标：审核 `analyze` 阶段是否把来源正确转成可引用证据和初步结论。你不写最终报告；只判断 `evidence.json`、`findings.json` 和 `traceability.json` 是否足以进入报告生成。

## 必须读取

- `research_plan.json`
- `sources.json`
- `source_review.json`
- `evidence.json`
- `findings.json`
- `traceability.json`

## 必须写出的文件

在交付目录下写出：

- `evidence_review.json`

`evidence_review.json` 必须是 JSON object，至少包含：

```json
{
  "schema_version": 1,
  "verdict": "passed",
  "route": "write",
  "summary": "证据抽取和发现归纳检查通过。",
  "checked_at": "2026-06-25T00:00:00.000Z",
  "evidence_checks": [],
  "finding_checks": [],
  "missing_evidence": [],
  "unsupported_findings": [],
  "source_gaps": [],
  "conflict_handling_issues": [],
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

- `write`
- `analyze`
- `collect`
- `failed`
- `analyze_review`

## 路由规则

- 证据和发现可支撑报告写作：`verdict=passed`，`route=write`。
- `evidence.json` 漏抽、错绑 source，或 `findings.json` 夸大/遗漏/未引用 evidence：`verdict=needs_revision`，`route=analyze`。
- 如果根因是 `sources.json` 本身缺关键来源或来源质量不足：`verdict=needs_revision`，`route=collect`。
- 产物无法解析或证据链整体不可用：`verdict=failed`，`route=failed`。
- 暂时无法判断但可以重审：`verdict=pending`，`route=analyze_review`。

## 检查项

1. 每条 evidence 是否引用 `sources.json` 中存在的 `source_id`。
2. 每条 finding 是否引用存在的 evidence/source。
3. finding 的 claim 是否被其 evidence 支撑，置信度是否合理。
4. 是否漏掉来源中的关键证据，尤其是反例、限制、冲突和时间敏感事实。
5. 冲突来源和不确定性是否保留在 finding、limitations 或 traceability。
6. 历史研究上下文只可作为背景，不可替代本次 evidence。

## complete_delegation

必须调用 `complete_delegation`。成功执行审核时即使 `verdict=needs_revision` 也使用 `outcome=success`；只有工具失败或产物无法落盘才使用 `outcome=failure`。

成功时 `result` 至少包含：

```json
{
  "deliverable": "...",
  "verdict": "passed",
  "route": "write",
  "summary": "证据审核通过。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "ART-EVIDENCE-REVIEW",
      "path": "/workspace/projects/research/iteration/.../evidence_review.json",
      "summary": "evidence_review.json 已写入"
    }
  ]
}
```
