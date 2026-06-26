---
name: deep-research-analyze
description: Use only in the deep_research workflow analyze stage. Extract evidence cards and findings from collected public web sources.
---

# Deep Research Analyze Skill

本技能仅用于 `deep_research` workflow 的 `analyze` 阶段。

目标：阅读 `sources.json` 和 `search_log.json`，抽取证据卡片、发现、冲突点、限制和知识缺口。你不新增任意 HTML，不写最终报告。

## 必须读取

- `research_plan.json`
- `sources.json`
- `search_log.json`
- `traceability.json`

## 必须写出的文件

在交付目录下写出：

- `evidence.json`
- `findings.json`
- 更新 `traceability.json`

`evidence.json` 必须是数组，每项至少包含：

```json
{
  "id": "EVID-001",
  "source_id": "SRC-001",
  "quote_or_summary": "...",
  "claim_support": "supports",
  "retrieved_at": "2026-06-25T00:00:00.000Z",
  "notes": "..."
}
```

`findings.json` 必须是数组，每项至少包含：

```json
{
  "id": "FIND-001",
  "claim": "...",
  "confidence": "medium",
  "evidence": ["EVID-001"],
  "sources": ["SRC-001"],
  "notes": "..."
}
```

## 规则

1. 每条 evidence 必须引用 `sources.json` 中存在的 `source_id`。
2. 每条 finding 必须引用存在的 evidence/source。
3. 冲突来源要显式写入 finding 或 traceability。
4. 无法确认的信息写入 `open_questions` 或 `limitations`。
5. 不把二手来源得出的弱结论写成确定事实。

## complete_delegation

必须调用 `complete_delegation`。成功时 `result` 至少包含：

```json
{
  "deliverable": "...",
  "verdict": "passed",
  "summary": "已完成证据抽取和发现归纳。",
  "finding_count": 6,
  "evidence_count": 18,
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "ART-EVIDENCE",
      "path": "/workspace/projects/research/iteration/.../evidence.json",
      "summary": "证据卡片已写入"
    }
  ]
}
```
