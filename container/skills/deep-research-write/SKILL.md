---
name: deep-research-write
description: Use only in the deep_research workflow write stage. Build structured report.json from verified evidence and findings.
---

# Deep Research Write Skill

本技能仅用于 `deep_research` workflow 的 `write` 阶段。

目标：只基于已审核的结构化证据生成一份“可直接交付给业务方阅读”的正式研究报告 `report.json`。`report.json` 是主产物，Markdown/PDF 只由系统导出生成。不要输出任意 HTML/CSS/JS。

最终报告要像咨询/产研报告，而不是证据清单或检索记录。正文优先呈现结论、判断、表格、市场/产品洞察和行动建议；来源引用只作为可追溯字段存在，不要在正文 `text/body` 中写“引用：...”“证据：...”“来源显示...”或堆叠 URL。

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
  "subtitle": "口径、对象或时间窗口",
  "status": "final",
  "language": "zh",
  "generated_at": "2026-06-25T00:00:00.000Z",
  "research_question": "原始研究问题",
  "methodology": {
    "scope": "研究范围",
    "data_window": "数据/检索时间窗口",
    "ranking_basis": "排序或判断口径",
    "important_caveat": "关键限制"
  },
  "summary": {
    "headline": "一句话结论",
    "bullets": [
      {
        "text": "关键结论，直接给判断和业务含义",
        "citations": ["SRC-001"]
      }
    ]
  },
  "candidate_top10": [],
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
- `table`

## 规则

1. `citations` 只能引用 `sources.json` 中存在的 source id。
2. 每个关键 claim 必须能追溯到 `findings.json` / `evidence.json`。
3. 不确定、冲突或低置信度结论必须在正文或 `limitations` 中说明。
4. 不写 HTML、CSS、JS、script、iframe。
5. 不把 Markdown 当主产物。
6. 不直接从 `sources.json` 临场发明新的关键 claim；如果某个结论不在 `findings/evidence` 中，应写为限制或等待 analyze 回修。
7. 历史研究上下文只能作为背景和对比线索，不得替代本次 `findings/evidence`。
8. `summary.bullets` 控制在 3-6 条，每条必须是综合判断，不要把每条证据拆成 bullet。
9. 正文 `paragraph` 必须是面向读者的分析段落；不要写证据编号、URL、长引用、检索过程或“根据 SRC-xxx”这类证据话术。证据编号只放在 `citations` 数组。
10. 必须优先组织正式报告结构：`执行摘要`、`方法与数据口径`、`关键表格/TopN 清单`、`产研分析`、`市场分析`、`风险与限制`、`建议/后续补证`。如果研究问题不适合 TopN，也要有等价的关键对象清单或判断矩阵。
11. 对 TopN、榜单、竞品、项目清单类研究，优先写 `candidate_top10` 或 `table` block。每行应包含排名/对象/类别/关键指标/判断依据/置信度/引用，而不是只写散文段落。
12. `status=final` 仅在核心研究问题被证据充分支撑时使用；如果核心指标或口径缺失，使用 `status=draft`，并在 `methodology.important_caveat` 与 `limitations` 中明确缺口，不能伪装成最终结论。

## 正文质量标准

- 干货密度：每个主要章节至少给出明确判断、结构化分组或可执行启示，避免空泛背景介绍。
- 报告感：标题、摘要、口径、表格、分章节分析必须连贯，读者不打开 `sources.json` 也能理解结论。
- 引用克制：同一段落最多使用必要 citations；不要把多个来源标题/URL写进正文。
- 分析优先：解释“为什么重要、对产品/市场意味着什么、下一步如何验证”，而不是复述网页摘要。

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
