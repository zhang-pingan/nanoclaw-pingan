---
name: deep-research-review
description: Use only in the deep_research workflow review stage. Validate final report claims, citations, evidence support, and route revisions.
---

# Deep Research Review Skill

本技能仅用于 `deep_research` workflow 的 `review` 阶段。

目标：校验最终 `report.json` 的主张、引用、证据支撑和未解决缺口，输出可驱动 workflow 路由的 `review.json`。来源充分性和证据抽取质量已由前置 review 阶段审核；本阶段重点判断 writer 是否基于已验证的 `findings/evidence` 正确写作。

## 必须读取

- `research_plan.json`
- `sources.json`
- `source_review.json`
- `evidence.json`
- `findings.json`
- `evidence_review.json`
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

workflow 会执行 `review.json.route` 或 handoff result 里的 `route`。报告乱写、漏引、夸大、误读或乱用历史上下文时回 `write`；证据抽取/发现归纳有问题时回 `analyze`；底层来源不足时回 `collect`。

## 检查项

1. 每个关键 claim 是否有 evidence/source 支撑。
2. `report.json` 的 citations 是否都存在于 `sources.json`。
3. `findings.json` 的 evidence/source 是否存在。
4. `report.json` 是否只基于 `findings.json` / `evidence.json` 中已有证据写作，而不是从 sources 临场扩展新 claim。
5. 是否夸大、误读、遗漏限制，或把低置信度 finding 写成确定事实。
6. 是否存在冲突来源或未解决缺口未在报告中说明。
7. report 是否包含任意 HTML/CSS/JS。
8. 时间敏感结论是否记录检索时间和时效限制。

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
