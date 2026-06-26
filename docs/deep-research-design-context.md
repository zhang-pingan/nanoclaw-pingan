# Deep Research 成品版设计上下文

更新时间：2026-06-25

本文档用于在 Icarus 仓库中新开 Codex 会话后继续讨论和实现 Deep Research 功能方案。上下文来自一次围绕“个人本地版 Deep Research 网页，只检索公开网页，复用现有 Icarus agent/workflow 框架，并做成独立一级产品入口”的讨论。

## 目标边界

用户想做一个类似 OpenAI Deep Research 的本地网页功能。当前边界为：

- 个人本地版，不做在线多人 SaaS。
- 检索范围先只支持公开网页。
- 优先复用现有 Icarus 项目，不另起独立 FastAPI/React 项目。
- Deep Research 要有独立一级导航页面，作为主要触发和交互入口。
- Workbench 仍要正常展示底层 workflow、阶段、Trace、产物和待处理项，但不是 Deep Research 的主体验入口。
- 最终报告的主产物不应是 Markdown，而应是结构化 report bundle，由专属页面渲染成交互式报告。
- 页面提供导出按钮，支持导出 PDF 和 Markdown。

目标体验：

```text
用户打开 Deep Research 一级页面
  -> 输入研究问题、深度、语言、约束和报告风格
  -> 页面调用 Deep Research API 创建 deep_research workflow
  -> workflow 生成研究计划
  -> Collector 使用公开网页检索、WebFetch、agent-browser 和 SDK agent team 并行探索来源
  -> Analyst 抽取证据、发现、来源关系和知识缺口
  -> Writer 基于结构化证据生成 report.json
  -> Reviewer 校验主张、来源、覆盖度和引用可靠性
  -> 不通过则回到 collector / analyst / writer 补查或重写
  -> 通过后生成交互式报告 bundle，并按需导出 PDF / Markdown
  -> Deep Research 页面实时展示进度、来源、证据、Trace、报告和导出入口
  -> Workbench 同步展示同一个 workflow 的状态、Trace、产物和待处理项
```

## 开源 Deep Research 项目调研

前期检索了多个开源实现，结论是成品级 Deep Research 通常不是“搜索 + 总结”，而是一个长任务工作流：

```text
澄清问题
  -> 规划研究方向
  -> 并行搜索
  -> 阅读网页/文档
  -> 摘要与证据卡片
  -> 反思信息缺口
  -> 继续检索
  -> 生成大纲
  -> 分章节写作
  -> 引用校验
  -> 最终报告/导出
```

参考项目：

- GPT Researcher: https://github.com/assafelovic/gpt-researcher
  - 产品化较完整。
  - 常见结构是 planner、execution agents、publisher。
  - 支持报告、引用、导出、API 和前端。
- LangChain Open Deep Research: https://github.com/langchain-ai/open_deep_research
  - 更像 LangGraph 参考架构。
  - 适合学习可配置 workflow、多个模型角色、搜索工具抽象。
- dzhng/deep-research: https://github.com/dzhng/deep-research
  - 极简 TypeScript 实现。
  - 核心是 breadth/depth 递归搜索，适合理解递归搜索框架。
- STORM: https://github.com/stanford-oval/storm
  - 更偏 Wikipedia 式长文写作。
  - 亮点是多视角提问、访谈式探索、先大纲后成文。
- DeerFlow: https://github.com/bytedance/deer-flow
  - 更像通用 agent harness，不只是 research。
  - 有多 agent、工具、沙盒、长期记忆等能力。
- Local Deep Research: https://github.com/LearningCircuit/local-deep-research
  - 主打本地、隐私、自有知识库。
  - 支持本地 LLM、SearXNG、学术源、本地文档、WebSocket 进度、导出。
- Salesforce Enterprise Deep Research: https://github.com/SalesforceAIResearch/enterprise-deep-research
  - 企业级思路。
  - 有 Master Planning Agent、专用搜索 agent、MCP、文件分析、可视化、人工 steering。
- Alibaba Tongyi DeepResearch: https://github.com/Alibaba-NLP/DeepResearch
  - 更偏训练专门 Deep Research 模型。
  - 不适合作为本地网页产品的第一阶段工程基础。

## 个人本地版与在线多人版区别

个人本地版：

- 不需要账号系统，最多本地密码。
- SQLite 和本地文件夹即可。
- 成本、额度、隐私由单用户自己控制。
- 任务失败后重启即可，稳定性要求低于在线多人版。
- 文件可以直接存在本地 workspace。
- 适合快速验证、接私有资料、个人效率工具。

在线多人版：

- 必须有注册、登录、权限、用户隔离。
- 要有任务队列、并发控制、失败恢复。
- 要做额度、限流、计费或成本控制。
- 文件需要对象存储、容量限制、安全隔离。
- 要有 HTTPS、监控、审计、告警。
- 适合 SaaS 或团队产品，但外围工程量明显更大。

结论：当前按个人本地版设计，但保留以后升级多人版的空间，例如 task/job 模型、产物按 workspace/job_id 组织、context 中提前保留 user/workspace 概念。

## 搜索入口说明

讨论过三类搜索入口：

### Tavily

专门给 AI Agent 用的搜索 API。

优点：

- Agent 友好。
- 返回摘要、URL、内容片段比较直接。
- 接入快。

缺点：

- 需要 API key。
- 有额度或费用。

### Serper

Google Search 的第三方 API 包装。

优点：

- 搜索覆盖面强。
- 返回结构化标题、摘要、链接、排名。

缺点：

- 需要 API key。
- 依赖第三方服务和网络可达性。

### SearXNG

开源元搜索引擎，可自部署。

优点：

- 免费、开源、可控。
- 可聚合多个搜索源。

缺点：

- 要部署和维护。
- 稳定性受搜索源限制，可能限流或失效。

当前针对 Icarus 的结论：

- 第一阶段可以先使用容器 Agent 已有的 `WebSearch`、`WebFetch` 和 `agent-browser`。
- 成品架构上应保留统一 `SearchProvider` / MCP / workflow action 抽象，后续可接 Tavily、Serper、SearXNG 或自定义搜索源。
- Collector 不应该把搜索入口写死在提示词里，而应把搜索来源记录到 `search_log.json` 和 `sources.json`。

统一接口可以设计为：

```text
search(query) -> [
  {
    title,
    url,
    snippet,
    source,
    published_at?
  }
]
```

## Icarus 现状观察

Icarus 是 TypeScript/Node 项目，定位天然适合个人本地版 Deep Research。

关键文件与能力：

- `README.md`
  - 明确 Icarus 是“面向个人使用的 Agent 工作系统”，不是多用户 SaaS。
  - 核心模块包括 Web 工作台、本地宿主机服务、SQLite、workflow engine、容器 Agent。
- `electron/renderer/index.html`
  - 现有 Web/Electron renderer 已有一级导航。
  - 可新增 Deep Research 一级导航项和专属页面，不需要另起前端项目。
- `electron/renderer/app.js`
  - 现有 SPA 前端逻辑集中在这里。
  - 可新增 Deep Research 页面状态、API 调用、实时刷新、报告渲染和导出按钮。
- `electron/renderer/styles/main.css`
  - 现有主导航、Workbench、Trace、配置等页面样式都在这里。
  - Deep Research 页面应复用整体布局语言，但需要独立的报告画布、来源侧栏和进度视图。
- `src/workflow-definition.ts`
  - Workflow definition 支持 `delegation`、`interrupt`、`terminal`、`system` 状态。
  - 创建表单支持 `text`、`textarea`、`choice`、`requirement_select`、`file_uploads`。
- `src/workflow.ts`
  - 通过 workflow definition 加载配置。
  - 根据 source group 的 channel 前缀解析角色 group folder。
  - `createNewWorkflow` 要求 `workflowType`、`startFrom`、`service`、`sourceJid`。
  - `getAvailableWorkflowTypes` 会把 workflow 类型、入口点、角色、create_form 暴露给 Workbench。
  - 当前 workflow 状态进入 delegation 时只创建一个 delegation，并用 `current_delegation_id` 跟踪；不支持 workflow 层原生 fan-out / fan-in。
  - 阶段是否继续流转依赖 delegation 返回的结构化 `verdict`。`passed` 走 success，`failed` / `needs_revision` 走 failure，`pending` 默认停在当前阶段等待处理，除非配置 evaluator transition。
- `src/channels/web.ts`
  - Web API 已支持创建 Workbench workflow task。
  - 创建任务接口需要 `title`、`service`、`source_jid`、`start_from`、`workflow_type`、`context`。
  - 可新增 `/api/deep-research/*` 专用 API，内部复用 `createWorkbenchTask` / `createNewWorkflow`。
- `src/workbench.ts` / `src/workbench-store.ts`
  - Workbench 可以继续展示 workflow、subtasks、timeline、artifacts、action items。
  - Deep Research 页面不替代 Workbench，而是给同一个 workflow 增加产品化交互入口。
- `container/agent-runner/src/index.ts`
  - 容器 Agent 允许 `WebSearch`、`WebFetch`、`Task`、`TaskOutput`、`TaskStop`、`TeamCreate`、`TeamDelete`、`SendMessage`、`Skill`、`mcp__icarus__*` 等工具。
  - SDK 层支持 agent team / subagent 能力，可用于 Collector 阶段内部并行探索。
  - SDK agent team 不等价于 Icarus workflow 层并行 delegation；Workbench 默认只看到外层 delegation。
- `container/skills/agent-browser/SKILL.md`
  - 已提供浏览器自动化能力，可用于需要交互、截图或复杂网页阅读的公开网页。
- `container/workflow-definitions/*.json`
  - 当前已有 `dev_test`、`fix_test`、`ios_dev_test` 等流程定义，可作为配置格式参考。
- `container/artifact-contracts/workflow-stage-core.json`
  - 如果 workflow definition 引用 `artifact_contract.ref`，对应 contract 必须存在，否则编译失败。
- `container/workflow-evaluators/workflow-stage-core.json`
  - 可为 Deep Research 各阶段新增 evaluator 配置。
- `container/skills/skills.json`
  - 控制不同 group folder 能拿到哪些 skills。
- `container/mcp/mcp.json`
  - 控制不同 group folder 能拿到哪些 MCP 工具 profile。

已观察到的现有 group folder 包括：

- `web_main`
- `web_plan`
- `web_plan_examine`
- `web_dev`
- `web_dev_examine`
- `web_test`
- `web_ops`
- `web_ios_recon`
- `web_ios_acceptance`

Deep Research 不应复用 `web_plan`。研究任务的提示词、会话记忆、工具策略、产物格式和评审逻辑都应与需求方案设计隔离。

## 产品形态

Deep Research 应作为 Icarus 的独立一级导航页面，而不是只作为 Workbench 里的一个任务类型。

建议一级页面结构：

```text
左侧：研究历史 / 当前任务列表 / 状态筛选
中间：研究输入、实时进度、交互式报告画布
右侧：来源、证据、Trace、缺口、引用检查
顶部：新建研究、暂停、继续、导出 PDF、导出 Markdown、打开 Workbench
```

主要交互：

- 新建研究：
  - 输入研究问题。
  - 选择深度、语言、报告风格、来源限制、排除项。
  - 时间口径应写入研究问题或约束中，不作为独立表单字段。
  - 提交后创建 `deep_research` workflow。
- 进行中：
  - 展示当前阶段、子任务摘要、检索轮次、已选来源、知识缺口。
  - 支持中途 steering，例如补查某个方向、排除某类来源、提高来源质量门槛。
  - Steering 可以先以 Workbench comment/context patch 形式落地，后续再做专用 interrupt。
- 报告展示：
  - 页面渲染 `report.json`，而不是渲染 Markdown。
  - 固定组件库支持图标、指标卡、时间线、来源聚类、引用 hover、证据抽屉、覆盖度图。
  - Agent 不允许直接输出任意 HTML/CSS/JS，避免安全、样式和维护问题。
- 导出：
  - Markdown 和 PDF 都从 `report.json` 派生。
  - Markdown 是便携格式。
  - PDF 用打印样式或后端浏览器渲染生成，保证视觉一致。
- Workbench 联动：
  - 每个 Deep Research task 仍是一个 Workbench task。
  - Deep Research 页面提供“打开 Workbench”入口，查看底层阶段、Trace、原始 delegation 和 action items。

## 推荐落地架构

不要另起一个新的 FastAPI/React 项目。把 Deep Research 做成 Icarus 的新 workflow 类型和专属 Web 页面。

高层结构：

```text
Deep Research Page
  -> /api/deep-research/tasks
  -> create deep_research workflow task
  -> Workbench task / workflow engine
  -> multi-stage research delegations
  -> report bundle files
  -> Deep Research page renders report.json
  -> exports/report.md and exports/report.pdf
```

### 多 agent 与多 group

成品版建议使用多 agent，并拆成多个 group。拆 group 的原因不是“agent 多所以 group 多”，而是这些角色需要稳定的提示词、记忆、技能、权限和失败处理边界。

建议角色：

```text
web_research_planner
  -> 输出 research_plan.json

web_research_collector
  -> 搜索、抓取、筛选来源
  -> 可使用 SDK agent team 在一个 delegation 内部并行探索
  -> 输出 sources.json / search_log.json

web_research_analyst
  -> 阅读来源、抽取证据、形成发现
  -> 输出 evidence.json / findings.json

web_research_writer
  -> 只基于证据写结构化报告
  -> 输出 report.json

web_research_reviewer
  -> 校验引用、主张覆盖、来源质量和缺口
  -> 输出 review.json
  -> 通过则进入 publish，不通过则路由回 collector / analyst / writer
```

拆 group 的判断原则：

- 需要不同提示词人格：拆 group。
- 需要不同工具权限或 MCP profile：拆 group。
- 需要独立重试、回滚、评测：拆 group。
- 需要独立长期记忆：拆 group。
- 只是同一阶段里的并行搜索分支：先不要拆 group，用 SDK agent team 或 `Task` 在 collector delegation 内部完成。

### SDK agent team 与 workflow 并行

当前 Icarus workflow 层不支持真正的并行 fan-out / fan-in。一个 delegation state 创建一个 delegation，workflow 用 `current_delegation_id` 跟踪当前执行。

因此 Collector 阶段的并行分两层处理：

```text
workflow 层：
plan -> collect -> analyze -> write -> review -> publish

collect delegation 内部：
collector main
  -> TeamCreate
  -> Task(name="official_sources", team_name="research")
  -> Task(name="news_searcher", team_name="research")
  -> Task(name="technical_sources", team_name="research")
  -> Task(name="case_studies", team_name="research")
  -> TaskOutput / SendMessage 收敛
  -> 输出 sources.json + search_log.json
```

这样可以先得到真实并行研究体验，但 Workbench 默认只看到 `collect` 一个阶段。后续如要让每个搜索分支在 Workbench 中独立可见、可单独重试，需要扩展 workflow 引擎：

```text
plan
  -> collect_parallel
      -> collector[official]
      -> collector[news]
      -> collector[technical]
      -> collector[case_studies]
  -> collect_join
  -> analyze
```

workflow 并行扩展需要新增能力：

- 一个 state 创建多个 delegation。
- 每个 delegation 有 `branch_id`。
- workflow 不再只依赖单个 `current_delegation_id`。
- join 策略支持 `all_success`、`quorum`、`min_sources`、`timeout_with_partial`。
- Workbench 展示并行子阶段。
- Reviewer 可以只要求某些 branch 补查。

第一阶段不要求 workflow 层并行，但文档和命名不要把 SDK agent team 误写成 workflow fan-out。

## Workflow 设计

建议 workflow 类型：`deep_research`。

推荐状态图：

```text
plan
  -> collect
  -> analyze
  -> write
  -> review
      -> publish -> passed
      -> collect  （需要补充来源）
      -> analyze  （证据抽取或发现不充分）
      -> write    （报告结构或表达需要重写）
      -> failed   （不可恢复失败）
```

`publish` 可以是 system state 或 publisher delegation。推荐优先做 system state，因为 Markdown/PDF 导出应该从 `report.json` 确定性生成，不应再让 agent 自由改写。

### 状态职责

`plan`：

- 输入用户研究问题和约束。
- 输出 `research_plan.json`。
- 包含子问题、搜索方向、来源类型、质量标准、停止条件。
- 如研究问题中带有时间口径，作为问题语义的一部分处理，不作为全局收集窗口。

`collect`：

- 输入 `research_plan.json`。
- 使用 WebSearch/WebFetch/agent-browser 和 SDK agent team 查找公开网页来源。
- 输出 `sources.json` 和 `search_log.json`。
- 记录查询词、候选 URL、入选来源、剔除来源、剔除原因、知识缺口。

`analyze`：

- 输入 `sources.json`、`search_log.json`。
- 抽取证据卡片、发现、冲突点、不确定性。
- 输出 `evidence.json`、`findings.json`。

`write`：

- 输入 `research_plan.json`、`sources.json`、`evidence.json`、`findings.json`。
- 输出 `report.json`。
- 不直接输出任意 HTML。
- 不把 Markdown 当主产物。

`review`：

- 输入全部结构化产物。
- 校验每个关键主张是否有来源支撑。
- 校验来源质量、引用覆盖、事实冲突、未解决缺口。
- 输出 `review.json`。
- `review.json` 必须可驱动 workflow 路由。

示例：

```json
{
  "verdict": "needs_revision",
  "route": "collect",
  "summary": "关键市场份额结论缺少高质量来源。",
  "missing_claims": [
    {
      "claim": "2026 年企业采用率超过 40%",
      "reason": "当前只有二手博客来源，缺少官方或研究机构来源"
    }
  ],
  "weak_sources": ["SRC-007"],
  "followup_queries": [
    "2026 enterprise adoption report official"
  ],
  "required_changes": [
    "补充官方报告或研究机构来源后重跑 analyze 和 write"
  ]
}
```

`publish`：

- 输入 `report.json`。
- 生成 `exports/report.md`。
- 生成或准备 `exports/report.pdf`。
- 索引 Workbench artifacts。
- 可生成 `report-summary.json` 供列表页快速展示。

## 产物模型

主产物是结构化 report bundle，不是 Markdown。

推荐目录：

```text
projects/research/iteration/{deliverable}/
  research_plan.json
  search_log.json
  sources.json
  evidence.json
  findings.json
  report.json
  review.json
  traceability.json
  assets/
  exports/
    report.md
    report.pdf
```

### report.json

`report.json` 是 Deep Research 页面渲染源。它可以表达文字、引用、卡片、图表、时间线、指标、来源聚类等结构化内容。

示例：

```json
{
  "schema_version": 1,
  "title": "研究标题",
  "subtitle": "可选副标题",
  "status": "final",
  "language": "zh",
  "generated_at": "2026-06-25T00:00:00.000Z",
  "summary": {
    "headline": "一句话结论",
    "bullets": [
      {
        "text": "关键结论",
        "citations": ["SRC-001", "SRC-004"]
      }
    ]
  },
  "sections": [
    {
      "id": "sec-001",
      "type": "narrative",
      "title": "市场格局",
      "blocks": [
        {
          "type": "paragraph",
          "text": "正文内容。",
          "citations": ["SRC-001"]
        },
        {
          "type": "insight_card",
          "tone": "warning",
          "title": "需要注意",
          "body": "该结论存在口径限制。",
          "citations": ["SRC-002"]
        },
        {
          "type": "metric_grid",
          "items": [
            {
              "label": "样本量",
              "value": "1,240",
              "note": "来自公开报告",
              "citations": ["SRC-003"]
            }
          ]
        },
        {
          "type": "timeline",
          "events": [
            {
              "date": "2026-01",
              "title": "关键事件",
              "description": "事件描述",
              "citations": ["SRC-004"]
            }
          ]
        },
        {
          "type": "source_cluster",
          "source_ids": ["SRC-001", "SRC-002"]
        }
      ]
    }
  ],
  "visuals": {
    "source_graph": {
      "nodes": [],
      "edges": []
    },
    "claim_coverage": {
      "covered": 0,
      "partial": 0,
      "missing": 0
    }
  },
  "limitations": [
    {
      "text": "无法确认的信息或范围限制。",
      "related_sources": ["SRC-005"]
    }
  ],
  "source_ids": ["SRC-001", "SRC-002"]
}
```

### sources.json

```json
[
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
    "source_type": "official|news|blog|paper|docs|other"
  }
]
```

### evidence.json

```json
[
  {
    "id": "EVID-001",
    "source_id": "SRC-001",
    "quote_or_summary": "...",
    "claim_support": "supports|contradicts|context",
    "retrieved_at": "2026-06-25T00:00:00.000Z",
    "notes": "..."
  }
]
```

### findings.json

```json
[
  {
    "id": "FIND-001",
    "claim": "...",
    "confidence": "medium",
    "evidence": ["EVID-001", "EVID-004"],
    "sources": ["SRC-001", "SRC-004"],
    "notes": "..."
  }
]
```

### traceability.json

`traceability.json` 用于 reviewer 和 evaluator 校验覆盖关系，至少包含：

- research questions
- subquestions
- claims
- findings
- evidence refs
- source refs
- open questions
- limitations
- coverage

## Deep Research 页面与 API

新增一级导航：

```text
Deep Research
```

建议修改：

```text
electron/renderer/index.html
electron/renderer/app.js
electron/renderer/styles/main.css
src/channels/web.ts
src/deep-research.ts
```

专用 API 建议：

```text
GET  /api/deep-research/tasks
POST /api/deep-research/tasks
GET  /api/deep-research/tasks/:id
GET  /api/deep-research/tasks/:id/report
GET  /api/deep-research/tasks/:id/sources
GET  /api/deep-research/tasks/:id/evidence
POST /api/deep-research/tasks/:id/steer
POST /api/deep-research/tasks/:id/export/markdown
POST /api/deep-research/tasks/:id/export/pdf
GET  /api/deep-research/tasks/:id/export/markdown
GET  /api/deep-research/tasks/:id/export/pdf
```

`POST /api/deep-research/tasks` 内部创建 Workbench task：

```json
{
  "title": "研究标题",
  "service": "research",
  "source_jid": "当前 web main group jid",
  "start_from": "plan",
  "workflow_type": "deep_research",
  "context": {
    "research_query": "...",
    "depth": "deep",
    "source_scope": "public_web",
    "language": "zh",
    "report_style": "interactive",
    "constraints": "..."
  }
}
```

Deep Research 页面可以通过现有 WebSocket 的 `workbench_event` 获得实时状态，也可以新增专用事件过滤层。第一阶段可直接基于 Workbench task detail 轮询/刷新，再逐步增加专用实时事件。

## Workbench 关系

Deep Research 页面是主入口，Workbench 是底层可观测和控制面。

要求：

- Deep Research 创建的任务必须同步创建 Workbench task。
- Workbench 中能看到 `deep_research` workflow 的阶段进度、Trace、artifact、timeline、action item。
- Workbench 可以作为 fallback 创建入口，但不是 Deep Research 的主体验。
- Deep Research 页面提供“打开 Workbench”按钮。
- Workbench 产物列表中应展示 `report.json`、`sources.json`、`findings.json`、`evidence.json`、`review.json`、`exports/report.md`、`exports/report.pdf`。

## Workflow 配置文件

新增或修改：

```text
container/workflow-definitions/deep_research.json
container/artifact-contracts/deep-research.json
container/workflow-evaluators/deep-research.json
container/skills/deep-research-plan/SKILL.md
container/skills/deep-research-collect/SKILL.md
container/skills/deep-research-analyze/SKILL.md
container/skills/deep-research-write/SKILL.md
container/skills/deep-research-review/SKILL.md
groups/web_research_planner/CLAUDE.md
groups/web_research_collector/CLAUDE.md
groups/web_research_analyst/CLAUDE.md
groups/web_research_writer/CLAUDE.md
groups/web_research_reviewer/CLAUDE.md
container/skills/skills.json
container/mcp/mcp.json
groups/global/services.json
```

是否新增 `container/cards/deep_research.json` 取决于是否要在 workflow 中加入人工确认或 steering interrupt。专属 Deep Research 页面自身可以处理主要交互，不必一开始依赖飞书/Workbench 卡片。

### 虚拟 service

现有 `createNewWorkflow` 要求 `service`，创建 API 也会校验 `groups/global/services.json`。为了少改框架，需要新增虚拟服务：

```json
{
  "research": {
    "repo_path": "",
    "default_branch": ""
  }
}
```

`web_research_*` group 不需要挂载业务仓库，避免研究任务读取本地项目源码。虚拟 service 仅用于 Workbench 创建和产物路径归档。

产物路径：

```text
projects/research/iteration/{deliverable}/...
```

### Group 注册要求

workflow definition 只负责把角色映射到 group folder，例如 `web_research_collector`。实际委派时，Icarus 需要在 registered groups 中找到对应 folder 的 JID。

因此落地时需要：

- 创建 `groups/web_research_*` 文件夹和 `CLAUDE.md`。
- 在 `container/skills/skills.json` 和 `container/mcp/mcp.json` 中配置能力。
- 注册对应 group folder，或确保已有 web group 能映射到这些 folder。
- 如果不注册，workflow 会在委派时报 `target group folder not found`。

## Workflow JSON 草案

以下是结构草案，具体字段需按现有 workflow definition schema 完整补齐。

```json
{
  "key": "deep_research",
  "label": "Deep Research",
  "description": "基于公开网页检索、证据抽取和引用校验生成交互式研究报告。",
  "versions": [
    {
      "key": "deep_research",
      "name": "Deep Research",
      "description": "多阶段公开网页研究流程。",
      "version": 1,
      "status": "published",
      "roles": {
        "planner": {
          "label": "研究规划",
          "deliverable_file": "research_plan.json",
          "channels": { "web": "web_research_planner" }
        },
        "collector": {
          "label": "来源收集",
          "deliverable_file": "sources.json",
          "channels": { "web": "web_research_collector" }
        },
        "analyst": {
          "label": "证据分析",
          "deliverable_file": "findings.json",
          "channels": { "web": "web_research_analyst" }
        },
        "writer": {
          "label": "报告生成",
          "deliverable_file": "report.json",
          "channels": { "web": "web_research_writer" }
        },
        "reviewer": {
          "label": "引用审查",
          "deliverable_file": "review.json",
          "channels": { "web": "web_research_reviewer" }
        }
      },
      "artifacts": [
        { "artifact_type": "research_plan", "title": "研究计划", "path": "research_plan.json", "source_role": "planner" },
        { "artifact_type": "research_sources", "title": "来源清单", "path": "sources.json", "source_role": "collector" },
        { "artifact_type": "research_search_log", "title": "检索记录", "path": "search_log.json", "source_role": "collector" },
        { "artifact_type": "research_evidence", "title": "证据卡片", "path": "evidence.json", "source_role": "analyst" },
        { "artifact_type": "research_findings", "title": "发现清单", "path": "findings.json", "source_role": "analyst" },
        { "artifact_type": "research_report_bundle", "title": "交互式报告数据", "path": "report.json", "source_role": "writer" },
        { "artifact_type": "research_review", "title": "引用审查", "path": "review.json", "source_role": "reviewer" },
        { "artifact_type": "traceability", "title": "追踪矩阵", "path": "traceability.json" },
        { "artifact_type": "research_markdown_export", "title": "Markdown 导出", "path": "exports/report.md" },
        { "artifact_type": "research_pdf_export", "title": "PDF 导出", "path": "exports/report.pdf" }
      ],
      "entry_points": {
        "plan": {
          "label": "开始研究",
          "state": "plan"
        }
      },
      "states": {
        "plan": {
          "type": "delegation",
          "label": "研究规划",
          "delegate": {
            "role": "planner",
            "skill": "deep-research-plan",
            "task_template": "流程类型：{{workflow_type}}\n研究问题：{{research_query}}\n研究深度：{{depth}}\n来源范围：{{source_scope}}\n报告语言：{{language}}\n报告风格：{{report_style}}\n限制条件：{{constraints}}\n\n请输出 research_plan.json，并调用 complete_delegation。"
          },
          "on_complete": {
            "success": { "target": "collect" },
            "failure": { "target": "failed" }
          }
        },
        "collect": {
          "type": "delegation",
          "label": "来源收集",
          "delegate": {
            "role": "collector",
            "skill": "deep-research-collect"
          },
          "on_complete": {
            "success": { "target": "analyze" },
            "failure": { "target": "failed" }
          }
        },
        "analyze": {
          "type": "delegation",
          "label": "证据分析",
          "delegate": {
            "role": "analyst",
            "skill": "deep-research-analyze"
          },
          "on_complete": {
            "success": { "target": "write" },
            "failure": { "target": "failed" }
          }
        },
        "write": {
          "type": "delegation",
          "label": "报告生成",
          "delegate": {
            "role": "writer",
            "skill": "deep-research-write"
          },
          "on_complete": {
            "success": { "target": "review" },
            "failure": { "target": "failed" }
          }
        },
        "review": {
          "type": "delegation",
          "label": "引用审查",
          "delegate": {
            "role": "reviewer",
            "skill": "deep-research-review"
          },
          "evaluator": {
            "ref": "deep_research.review.v1",
            "on_pass": { "target": "publish" },
            "on_needs_revision": { "target": "collect" },
            "on_fail": { "target": "failed" },
            "on_pending": { "target": "review" }
          },
          "on_complete": {
            "success": { "target": "publish" },
            "failure": { "target": "failed" }
          }
        },
        "publish": {
          "type": "system",
          "label": "导出发布",
          "run": {
            "steps": [
              {
                "id": "export_report",
                "uses": "deep_research.export"
              }
            ]
          },
          "on_complete": {
            "success": { "target": "passed" },
            "failure": { "target": "failed" }
          }
        },
        "passed": { "type": "terminal", "label": "研究完成" },
        "failed": { "type": "terminal", "label": "研究失败" }
      },
      "status_labels": {
        "plan": "研究规划",
        "collect": "来源收集",
        "analyze": "证据分析",
        "write": "报告生成",
        "review": "引用审查",
        "publish": "导出发布",
        "passed": "研究完成",
        "failed": "研究失败"
      },
      "create_form": {
        "fields": [
          {
            "key": "research_query",
            "label": "研究问题",
            "type": "textarea",
            "required": true
          },
          {
            "key": "depth",
            "label": "研究深度",
            "type": "choice",
            "default_value": "standard",
            "options": [
              { "value": "quick", "label": "快速" },
              { "value": "standard", "label": "标准" },
              { "value": "deep", "label": "深入" }
            ]
          },
          {
            "key": "source_scope",
            "label": "来源范围",
            "type": "choice",
            "default_value": "public_web",
            "options": [
              { "value": "public_web", "label": "公开网页" }
            ]
          },
          {
            "key": "language",
            "label": "报告语言",
            "type": "choice",
            "default_value": "zh",
            "options": [
              { "value": "zh", "label": "中文" },
              { "value": "en", "label": "英文" },
              { "value": "auto", "label": "自动" }
            ]
          },
          {
            "key": "report_style",
            "label": "报告风格",
            "type": "choice",
            "default_value": "interactive",
            "options": [
              { "value": "interactive", "label": "交互式报告" },
              { "value": "deep_report", "label": "深度报告" },
              { "value": "comparison", "label": "对比分析" }
            ]
          },
          {
            "key": "constraints",
            "label": "限制条件",
            "type": "textarea",
            "required": false
          }
        ]
      }
    }
  ]
}
```

注意：

- 如果 workflow definition 引用 `artifact_contract.ref` 或 handoff 的 `artifact_contract_ref`，必须先新增对应 contract，否则 workflow 编译会失败。
- 上面 `deep_research.export` 是建议新增的 workflow action，需要在 `src/workflow-actions` 中实现或先改成 publisher delegation。
- `review.route` 的精细路由需要 evaluator 或 system state 支持读取 review payload。第一阶段可先用 reviewer 的 `verdict` 控制通过/失败，后续再做按 `route` 回跳。

## Skill 行为建议

所有 Deep Research skill 的通用规则：

1. 只用于 `deep_research` workflow。
2. 只研究公开网页，不读取本地项目源码，除非任务显式要求并且 workflow context 允许。
3. 不编造来源、标题、发布时间、URL。
4. 对无法确认的信息必须写入 `limitations`、`open_questions` 或 `review.json`。
5. 每个关键结论必须能映射到 `sources.json` 和 `evidence.json`。
6. 最终必须写结构化文件，并调用 `complete_delegation`。
7. `complete_delegation.result` 必须包含 `verdict`、`summary`、`findings`、`evidence`。
8. `outcome=failure` 只用于执行层失败或阻塞，不用于表达“研究结论不支持用户预期”。

### deep-research-plan

输出：

```text
research_plan.json
traceability.json 初始版本
```

必须包含：

- research question
- scope
- subquestions
- source strategy
- quality criteria
- stop criteria
- planned collector branches

### deep-research-collect

输出：

```text
sources.json
search_log.json
traceability.json 更新
```

必须记录：

- search queries
- candidate URLs
- selected sources
- rejected sources and reasons
- source quality
- retrieval timestamp
- knowledge gaps

可以使用 SDK agent team：

```text
TeamCreate("research")
Task(name="official_sources", team_name="research", run_in_background=true)
Task(name="news_searcher", team_name="research", run_in_background=true)
Task(name="technical_sources", team_name="research", run_in_background=true)
TaskOutput(...)
SendMessage(...)
```

### deep-research-analyze

输出：

```text
evidence.json
findings.json
traceability.json 更新
```

必须把每条 finding 绑定到 evidence/source。

### deep-research-write

输出：

```text
report.json
```

必须遵循固定 report schema。不要输出任意 HTML、CSS、JS。Markdown 只作为导出格式，不是主产物。

### deep-research-review

输出：

```text
review.json
```

必须检查：

- 每个关键 claim 是否有来源。
- 来源是否可访问、是否足够权威。
- 是否有冲突来源。
- 是否存在未解决缺口。
- report.json 是否只引用存在的 source/evidence。
- 是否需要回到 collect/analyze/write。

## Artifact Contract 与 Evaluator

成品版建议补齐 artifact contract 和 evaluator，而不是只靠提示词约束。

建议新增：

```text
container/artifact-contracts/deep-research.json
container/workflow-evaluators/deep-research.json
```

建议 contract refs：

```text
deep_research.plan.v1
deep_research.collect.v1
deep_research.analyze.v1
deep_research.write.v1
deep_research.review.v1
deep_research.publish.v1
```

最重要的校验：

- 必需文件存在。
- JSON 可解析。
- `report.json` schema 合法。
- `sources.json` 中 URL 合法且 id 唯一。
- `findings.json` 的 evidence/source 引用存在。
- `report.json` 的 citation 引用存在。
- `review.json` 的 verdict/route 合法。
- `traceability.json` 覆盖 research question、subquestions、findings、evidence、sources。

## 导出设计

Markdown 和 PDF 都从 `report.json` 派生。

Markdown 导出：

```text
report.json -> markdown renderer -> exports/report.md
```

PDF 导出：

```text
report.json -> report page print layout -> exports/report.pdf
```

PDF 实现选项：

- 前端使用浏览器打印，用户手动保存为 PDF。
- 后端使用 Playwright/Chromium 渲染专用 report print URL 并保存 PDF。

推荐成品体验：

- Deep Research 页面展示导出按钮。
- 如果导出文件不存在，点击时触发生成。
- 导出成功后提供下载。
- Workbench artifacts 中同步显示导出文件。

## 安全与质量边界

- Agent 不输出任意 HTML/CSS/JS，只输出结构化 JSON。
- 页面只渲染白名单组件。
- 外链来源点击前显示 URL 和 publisher。
- 不允许把未验证信息写成确定结论。
- 不允许引用不存在的 source id。
- 不允许读取本地源码或私有文件，除非未来显式增加本地资料检索能力。
- 对时间敏感问题，报告必须记录检索时间和信息时效限制。
- 对冲突来源，要在报告和 review 中显式说明。

## 后续增强方向

- 将 Tavily/Serper/SearXNG 做成统一 SearchProvider。
- 新增宿主机 workflow action，例如 `web_search.search`、`web_reader.fetch`、`deep_research.export`。
- 增加 workflow 层并行 fan-out / fan-in。
- 增加来源质量评分与去重。
- 增加引用 hover、来源侧边栏、来源图谱、claim coverage 可视化。
- 增加中途 steering：用户可以要求补查某个方向或排除某类来源。
- 增加可选本地文档和知识库检索。
- 增加报告版本历史和 diff。
- 增加研究模板，例如竞品分析、政策研究、技术选型、市场扫描。

## 新会话建议起点

在 `icarus` 目录下重开 Codex 后，可以从这个问题继续：

```text
请阅读 docs/deep-research-design-context.md，并基于当前 Icarus 代码结构，设计 deep_research 成品版实现方案。要求包含：Deep Research 一级导航页面、/api/deep-research/* API、multi-stage workflow、多 group roles、SDK agent team 在 collector 内部并行、结构化 report bundle、PDF/Markdown 导出、Workbench 联动、artifact contracts/evaluators 和验证步骤。先不要写代码，先给出具体文件清单和实现顺序。
```

如果要直接进入实现，可以改成：

```text
请阅读 docs/deep-research-design-context.md，然后按成品版第一阶段实现 deep_research。要求新增 Deep Research 一级导航页面和 API，创建 deep_research multi-stage workflow，新增 planner/collector/analyst/writer/reviewer groups 和 skills，主产物使用 report.json/sources.json/evidence.json/findings.json/review.json，页面渲染 report.json，并提供 Markdown/PDF 导出入口。Workbench 必须能同步展示同一 workflow 的进度、Trace 和产物。
```
