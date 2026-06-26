---
name: deep-research-collect
description: Use only in the deep_research workflow collect stage. Search public webpages, fetch candidate sources, and produce sources plus search logs.
---

# Deep Research Collect Skill

本技能仅用于 `deep_research` workflow 的 `collect` 阶段。

目标：基于 `research_plan.json` 检索公开网页来源，筛选、去重并记录检索过程。你只研究公开网页，不读取本地项目源码或私有文件。

## 必须读取

- `/workspace/projects/{service}/iteration/{deliverable}/research_plan.json`
- 当前委派消息中的研究问题和交付目录

## 工具策略

优先使用容器已有公开网页能力：

- `WebSearch`
- `WebFetch`
- `agent-browser` skill
- SDK agent team：`TeamCreate`、`Task`、`TaskOutput`、`SendMessage`

collector delegation 内部应该并行探索，不扩展 workflow 层并行。建议分支：

- `official_sources`
- `news_searcher`
- `technical_sources`
- `case_studies`

## 必须写出的文件

在交付目录下写出：

- `sources.json`
- `search_log.json`
- 更新 `traceability.json`

`sources.json` 必须是数组，每项至少包含：

```json
{
  "id": "SRC-001",
  "title": "...",
  "url": "https://...",
  "publisher": "...",
  "published_at": null,
  "retrieved_at": "2026-06-25T00:00:00.000Z",
  "query": "...",
  "summary": "...",
  "relevance": "high",
  "quality": "high",
  "source_type": "official"
}
```

`search_log.json` 必须记录：

- 查询词
- 候选 URL
- 入选来源
- 剔除来源及原因
- 知识缺口
- 检索时间
- 工具或分支来源

## 规则

1. URL、标题、publisher、published_at 不得编造；无法确认写 null 或 limitations。
2. 来源 id 必须唯一，使用 `SRC-001` 格式。
3. 只保留公开网页来源；登录后、私有文件、本地源码不纳入。
4. 搜索结果质量不足时写入 `knowledge_gaps`，不要用低质量来源伪装高质量。
5. 时间敏感问题必须记录 `retrieved_at`。

## complete_delegation

必须调用 `complete_delegation`。成功时 `result` 至少包含：

```json
{
  "deliverable": "...",
  "verdict": "passed",
  "summary": "已收集公开网页来源。",
  "source_count": 8,
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "ART-SOURCES",
      "path": "/workspace/projects/research/iteration/.../sources.json",
      "summary": "来源清单已写入"
    }
  ]
}
```

`outcome=failure` 只用于搜索/抓取完全不可用或产物无法落盘。
