---
name: deep-research-write
description: Use only in the deep_research workflow write stage. Build structured report.json from verified evidence and findings.
---

# Deep Research Write Skill

本技能仅用于 `deep_research` workflow 的 `write` 阶段。

目标：只基于已审核的结构化证据生成 `report.json`。`report.json` 是主产物，Markdown 只由系统导出生成。不要输出任意 HTML/CSS/JS。

## 必须读取

- `research_plan.json`
- `sources.json`
- `source_review.json`
- `evidence.json`
- `findings.json`
- `evidence_review.json`
- `traceability.json`

## 必须写出的文件

在交付目录下写出：

- `report.json`

`report.json` 必须是 JSON object，至少包含：

```json
{
  "schema_version": 1,
  "title": "研究标题",
  "subtitle": "",
  "status": "draft",
  "language": "zh",
  "generated_at": "2026-06-25T00:00:00.000Z",
  "summary": {
    "headline": "一句话结论",
    "bullets": [
      {
        "text": "关键结论",
        "citations": ["SRC-001"]
      }
    ]
  },
  "sections": [
    {
      "id": "sec-001",
      "type": "narrative",
      "title": "章节标题",
      "blocks": [
        {
          "type": "paragraph",
          "text": "正文内容。",
          "citations": ["SRC-001"]
        }
      ]
    }
  ],
  "visuals": {
    "source_graph": { "nodes": [], "edges": [] },
    "claim_coverage": { "covered": 0, "partial": 0, "missing": 0 }
  },
  "limitations": [],
  "source_ids": ["SRC-001"]
}
```

允许的 block type：

- `paragraph`
- `insight_card`
- `metric_grid`
- `timeline`
- `source_cluster`

## 规则

1. `citations` 只能引用 `sources.json` 中存在的 source id。
2. 每个关键 claim 必须能追溯到 `findings.json` / `evidence.json`。
3. 不确定、冲突或低置信度结论必须在正文或 `limitations` 中说明。
4. 不写 HTML、CSS、JS、script、iframe。
5. 不把 Markdown 当主产物。
6. 不直接从 `sources.json` 临场发明新的关键 claim；如果某个结论不在 `findings/evidence` 中，应写为限制或等待 analyze 回修。
7. 历史研究上下文只能作为背景和对比线索，不得替代本次 `findings/evidence`。

## complete_delegation

必须调用 `complete_delegation`。成功时 `result` 至少包含：

```json
{
  "deliverable": "...",
  "verdict": "passed",
  "summary": "已生成结构化 report.json。",
  "report": "/workspace/projects/research/iteration/.../report.json",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "ART-REPORT",
      "path": "/workspace/projects/research/iteration/.../report.json",
      "summary": "结构化报告已写入"
    }
  ]
}
```
