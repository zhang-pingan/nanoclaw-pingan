---
name: deep-research-plan
description: Use only in the deep_research workflow plan stage. Turn a research question into a bounded public-web research plan and initial traceability matrix.
---

# Deep Research Plan Skill

本技能仅用于 `deep_research` workflow 的 `plan` 阶段。

目标：把用户研究问题转成可执行的公开网页研究计划。你只输出结构化 JSON 产物，不写 Markdown 报告，不读取本地项目源码。

## 输入

优先读取委派消息中的：

- `研究问题`
- `研究深度`
- `来源范围`
- `报告语言`
- `报告风格`
- `来源限制`
- `约束与排除`
- `交付目录`

`来源范围` 当前只支持 `public_web`。如果用户要求本地文件、私有资料或登录后页面，写入 `limitations` / `open_questions`，不要尝试读取本地源码或私有文件。

## 必须写出的文件

在 `/workspace/projects/{service}/iteration/{deliverable}/` 下写出：

- `research_plan.json`
- `traceability.json`

`research_plan.json` 必须是 JSON object，至少包含：

```json
{
  "schema_version": 1,
  "research_question": "...",
  "scope": {
    "source_scope": "public_web",
    "language": "zh",
    "depth": "standard",
    "constraints": ""
  },
  "subquestions": [
    {
      "id": "RQ-001",
      "question": "...",
      "priority": "high",
      "source_types": ["official", "news", "paper", "docs", "other"]
    }
  ],
  "source_strategy": {
    "preferred_sources": ["official", "primary", "reputable analysis"],
    "search_queries": ["..."],
    "collector_branches": ["official_sources", "news_searcher", "technical_sources", "case_studies"]
  },
  "quality_criteria": ["..."],
  "stop_criteria": ["..."],
  "open_questions": [],
  "limitations": []
}
```

`traceability.json` 初始版本至少包含：

```json
{
  "schema_version": 1,
  "research_question": "...",
  "subquestions": [],
  "claims": [],
  "findings": [],
  "evidence_refs": [],
  "source_refs": [],
  "open_questions": [],
  "limitations": [],
  "coverage": []
}
```

## 规则

1. 不编造来源、URL、发布时间或数据。
2. 不输出任意 HTML/CSS/JS。
3. 不把 Markdown 当主产物。
4. 时间敏感研究必须在计划中要求记录 `retrieved_at`。
5. 研究计划要给 collector 可直接执行的查询词和来源类型。

## complete_delegation

必须调用 `complete_delegation`。成功时 `result` 是 JSON object，至少包含：

```json
{
  "deliverable": "...",
  "verdict": "passed",
  "summary": "已生成 Deep Research 研究计划。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "ART-RESEARCH-PLAN",
      "path": "/workspace/projects/research/iteration/.../research_plan.json",
      "summary": "研究计划已写入"
    }
  ]
}
```

`outcome=failure` 只用于执行层失败或阻塞，例如交付目录无法写入。
