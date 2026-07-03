# RFC: 行业 App 创业机会调研 Agent Workflow

> **状态**: 提案
> **作者**: 社区贡献者
> **创建日期**: 2026-07-01
> **目标版本**: 待定

## 概述

该设计方案从第三方架构视角描述一个面向“某个行业 App 方向”的创业机会调研 Agent 服务。方案同时涉及 GPT Researcher 与 Icarus 两个项目，但不以任一仓库作为唯一叙述主体。

关联仓库：

- GPT Researcher 仓库：`/Users/chelaile/IdeaProjects/gpt-researcher`
- Icarus 仓库：`/Users/chelaile/IdeaProjects/icarus`

该 Agent 服务不是通用 deep research，也不是直接让模型基于一个行业方向生成候选创业点，而是通过多条明确的调研维度收集证据，从证据中挖掘候选机会，再经过维度内筛选、跨维度合并、综合排序，最终输出创业方向排名和分析报告。

输入示例：

```text
宠物行业 App
养老护理 App
跨境电商工具 App
AI 教育 App
本地生活服务 App
```

输出示例：

```text
1. 宠物慢病管理与家庭协同 App
2. 宠物保险比价与理赔辅助 App
3. 上门喂养和临时寄养调度 App

每个方向包含：
- 目标用户
- 核心痛点
- 机会来源
- 证据摘要
- 竞品覆盖度
- 用户满意度缺口
- 市场和商业化判断
- 切入版本建议
- 风险和不确定性
```

## 背景与动机

GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）当前更偏向通用研究报告生成，尤其是 `deep` 模式，重点是围绕一个查询进行递归搜索、扩展问题、聚合上下文并生成综合报告。这个能力适合回答开放式研究问题，但不完全适合“创业机会发现和排序”。

创业机会调研需要更强的业务 workflow 控制：

| 需求 | 通用 deep research | 创业机会 Agent |
|------|--------------------|----------------|
| 输入 | 一个研究问题 | 一个行业或 App 方向 |
| 候选机会 | 可能由模型直接总结 | 必须从多类证据中挖掘 |
| 调研维度 | 动态扩展为主 | 预设维度 + 动态补充 |
| 评估方式 | 自然语言综合 | 结构化评分、筛选、排序 |
| 输出 | 一篇报告 | 多个机会方向排名 + 证据链 |
| 决策逻辑 | 隐式 | 显式、可追溯、可调权重 |

因此，该 Agent 服务不应直接把 `GPTResearcher(report_type="deep")` 作为主业务接口，而应建立领域化 workflow。GPT Researcher 的搜索、抓取、query expansion、source curation、摘要和报告生成能力可以作为某些环节的工具或参考实现。

## 目标

- 从行业 App 方向中发现多个候选创业机会。
- 候选机会必须来自明确的调研维度和证据，而不是先验生成。
- 每条调研维度独立完成证据收集、机会提取和维度内筛选。
- 对多维度筛选出的 topN 机会进行去重、聚类和证据合并。
- 对合并后的机会进行跨维度综合排序。
- 输出可解释的创业方向排名和具体分析总结。
- 支持后续扩展新的调研维度、评分规则和数据源。

## 非目标

- 不直接替代 GPT Researcher 的通用研究报告能力。
- 不把 LLM 的自然语言报告作为唯一决策结果。
- 不把成品服务降级成一次性报告生成；需要保留结构化证据、评分、反证和可追踪产物。
- 不保证生成的方向一定可创业成功，系统输出的是基于公开信息和可获取证据的机会判断。

## 核心设计原则

### 1. 机会来自证据，而不是先生成

错误流程：

```text
行业方向 -> LLM 直接生成 10 个创业机会 -> 再调研
```

目标流程：

```text
行业方向 -> 多维度调研 -> 从证据中提取机会 -> 筛选排序
```

### 2. 调研维度既是发现通道，也是筛选通道

每个调研维度不是只负责收集材料，而是完整产出：

```text
Evidence -> Findings -> Opportunities -> Lane Scores -> TopN
```

例如“已有产品 Top 排名挖掘”维度需要：

- 找到排行榜头部产品。
- 总结产品覆盖的人群、场景、功能、商业模式。
- 挖掘用户评论、低星反馈、功能请求。
- 判断是否存在覆盖不足、满意度不足、差异化缺口。
- 生成该维度下的候选机会。
- 按该维度规则筛出 topN。

### 3. 先维度内筛选，再跨维度综合排序

不同调研维度的证据质量和含义不同，不能在早期简单混合。每个维度先独立判断，产出本维度 topN；然后再做机会合并、证据聚合和全局评分。

### 4. 所有结论保留证据链

每个机会方向的评分和结论都应能追溯到：

- 来自哪个调研维度。
- 使用了哪些来源。
- 提取了哪些事实、痛点或缺口。
- 哪些证据支持，哪些证据反驳。
- 置信度如何。

## 总体 Workflow

```text
行业 App 方向输入
  -> 研究规划
  -> 多调研维度并行执行
      -> 证据收集
      -> 事实/痛点/竞品信息提取
      -> 候选机会生成
      -> 维度内评分
      -> 维度内 topN 筛选
  -> 机会去重与聚类
  -> 证据合并与补充检索
  -> 跨维度综合评分
  -> 排名与推荐
  -> 最终报告生成
```

## 调研维度设计

### 1. 受众需求痛点 Lane

目标：从用户群体和真实场景出发，发现强需求和未满足痛点。

典型数据源：

- 搜索引擎结果
- Reddit、知乎、小红书、贴吧、论坛等社区内容
- Quora、StackExchange 等问答内容
- 行业报告和用户调研文章
- App 评论中的痛点表达

处理流程：

```text
行业方向
  -> 用户群体拆解
  -> 使用场景拆解
  -> 痛点查询生成
  -> 证据收集
  -> 痛点聚类
  -> 候选机会提取
  -> 按痛点强度、频率、付费意愿、可解决性评分
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 痛点强度 | 用户表达是否强烈，是否影响效率、金钱、健康、安全或情绪 |
| 出现频率 | 多个来源中是否反复出现 |
| 目标用户清晰度 | 是否能明确谁在痛、为什么痛 |
| 付费意愿 | 是否存在明显付费动机或替代支出 |
| 可解决性 | App 是否能实际缓解该痛点 |
| 证据置信度 | 来源数量、质量和一致性 |

### 2. 已有产品 Top 排名挖掘 Lane

目标：从排行榜头部产品中识别主流需求、产品覆盖范围和仍然存在的机会缺口。

典型数据源：

- App Store 排行榜
- Google Play 排行榜
- Product Hunt
- SimilarWeb、Sensor Tower、data.ai 等第三方榜单或公开摘要
- 媒体和行业文章中的 top app list

处理流程：

```text
行业方向
  -> 识别相关榜单和关键词
  -> 提取头部产品
  -> 总结产品定位、功能、目标用户、商业模式
  -> 分析产品覆盖度
  -> 分析满意度和差评
  -> 识别未覆盖场景和低满意场景
  -> 生成候选机会
  -> 按覆盖缺口、满意度缺口、差异化空间评分
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 产品覆盖度缺口 | 头部产品是否没有覆盖该场景 |
| 满意度缺口 | 用户评分、低星评论、抱怨是否显示现有方案不足 |
| 差异化空间 | 新产品是否能形成清晰差异 |
| 竞争集中度 | 头部产品是否过于强势 |
| 迁移阻力 | 用户从现有产品切换是否困难 |
| 商业模式验证 | 头部产品是否证明用户愿意付费或有变现空间 |

### 3. 用户评论与差评挖掘 Lane

目标：从现有 App 评论中提取未满足需求、功能请求和体验缺陷。

典型数据源：

- App Store 评论
- Google Play 评论
- G2、Capterra 等 SaaS 评论站
- Chrome Extension 评论
- Product Hunt 评论
- 社区讨论和投诉内容

处理流程：

```text
头部产品列表
  -> 评论抓取或搜索
  -> 低星评论提取
  -> 高频抱怨聚类
  -> 功能请求提取
  -> 与现有产品能力对比
  -> 生成候选机会
  -> 按差评密度、需求明确度、改进空间评分
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 差评密度 | 低星评论中相关问题出现比例 |
| 需求明确度 | 用户是否清楚表达想要什么 |
| 影响程度 | 问题是否影响核心流程 |
| 可修复性 | 新产品或垂直产品是否能更好解决 |
| 现有产品惯性 | 头部产品是否因体量、架构或定位难以修复 |

### 4. 搜索需求与内容缺口 Lane

目标：从搜索行为和内容供给中发现需求旺盛但产品供给不足的方向。

典型数据源：

- Google Trends
- 搜索联想词
- SEO 工具公开数据
- 问答平台高频问题
- 内容平台热门主题

处理流程：

```text
行业方向
  -> 关键词扩展
  -> 搜索需求收集
  -> 高频问题聚类
  -> 现有工具/产品匹配
  -> 识别内容需求向工具需求转化的机会
  -> 生成候选机会
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 搜索需求强度 | 需求是否有持续搜索量或讨论量 |
| 问题重复性 | 用户是否反复问类似问题 |
| 工具化潜力 | 内容答案是否可以被产品流程替代 |
| 获客可行性 | SEO、内容、社区渠道是否可触达用户 |

### 5. 趋势变化 Lane

目标：识别政策、技术、平台、消费习惯变化带来的新窗口。

典型数据源：

- 行业新闻
- 政策文件
- 平台规则更新
- 技术趋势文章
- 投融资新闻
- 消费趋势报告

处理流程：

```text
行业方向
  -> 识别关键变化因素
  -> 搜索近期变化
  -> 判断变化影响的人群和流程
  -> 识别旧产品无法适配的新需求
  -> 生成候选机会
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 趋势确定性 | 变化是否真实、持续、影响广泛 |
| 时机窗口 | 是否处于早期但需求开始显现 |
| 旧方案失配 | 现有产品是否难以适配新变化 |
| 进入窗口 | 新进入者是否有机会建立优势 |
| 风险 | 政策、平台或技术不确定性 |

## 候选机会数据模型

候选机会必须是结构化对象，避免只保存自然语言摘要。

```json
{
  "id": "opp_001",
  "title": "面向独居老人的用药提醒与家庭协同 App",
  "description": "帮助独居老人管理用药、复诊和家庭成员远程确认。",
  "target_users": ["独居老人", "异地子女", "慢病患者家庭"],
  "primary_scenarios": ["每日用药提醒", "漏服告警", "复诊记录", "家庭协同"],
  "pain_points": [
    "老人容易忘记用药",
    "子女无法确认是否按时服药",
    "慢病复诊和药品记录分散"
  ],
  "source_lanes": ["audience_pain", "top_products_gap", "review_mining"],
  "evidence": [
    {
      "claim": "现有用药提醒产品家庭协同能力不足",
      "source_type": "app_review",
      "url": "https://example.com/review",
      "confidence": 0.78
    }
  ],
  "lane_scores": {
    "audience_pain": 8.4,
    "top_products_gap": 7.2,
    "review_mining": 8.8
  },
  "global_score": 8.1,
  "confidence": 0.76,
  "risks": ["老年用户使用门槛", "医疗健康合规边界"],
  "mvp": "先做家庭协同用药提醒、复诊记录和漏服通知。"
}
```

## 证据数据模型

```json
{
  "id": "ev_001",
  "lane": "review_mining",
  "source_type": "app_store_review",
  "source_name": "App Store",
  "url": "https://example.com",
  "published_at": "2026-06-01",
  "raw_text": "用户原始评论或网页摘要",
  "extracted_claims": [
    "用户抱怨提醒不稳定",
    "用户希望家庭成员可以收到提醒状态"
  ],
  "sentiment": "negative",
  "relevance": 0.86,
  "credibility": 0.72
}
```

## 维度内筛选

每条 lane 独立输出 topN 候选机会：

```text
LaneResult
  - lane_name
  - evidence_items
  - findings
  - opportunities
  - scored_opportunities
  - top_opportunities
```

维度内评分可采用 0-10 分，并保留理由：

```json
{
  "opportunity_id": "opp_001",
  "lane": "top_products_gap",
  "score": 7.8,
  "dimensions": {
    "coverage_gap": 8.5,
    "satisfaction_gap": 7.4,
    "differentiation": 7.6,
    "competition_risk": 6.2
  },
  "rationale": "头部产品覆盖通用提醒，但家庭协同、长期慢病管理和复诊记录不足。"
}
```

## 机会去重与聚类

多条 lane 可能产出语义相近的机会，例如：

```text
宠物健康档案
宠物疫苗提醒
宠物慢病管理
宠物用药提醒
```

系统需要判断它们应该合并为一个机会簇，还是拆成多个细分方向。

推荐流程：

```text
所有 lane topN 机会
  -> 标题和描述 embedding
  -> 语义聚类
  -> LLM 判断是否同类
  -> 合并目标用户、场景、痛点和证据
  -> 生成统一机会描述
```

合并规则：

- 如果目标用户、核心场景、主要痛点高度一致，则合并。
- 如果目标用户一致但场景差异明显，可保留为同一机会下的子方向。
- 如果商业模式、获客路径、切入版本差异很大，应拆分。

## 综合评分与排序

综合评分不应简单平均所有 lane 分数，而应基于创业判断维度重新评估。

建议全局评分维度：

| 维度 | 权重示例 | 说明 |
|------|----------|------|
| 需求强度 | 20% | 用户痛点是否真实且强烈 |
| 市场空间 | 15% | 用户规模、消费能力、增长趋势 |
| 现有产品缺口 | 15% | 头部产品是否存在覆盖或满意度缺口 |
| 付费和商业化 | 12% | 是否有付费意愿、订阅、交易或 B2B 变现 |
| 获客可行性 | 10% | 是否有清晰低成本触达渠道 |
| 切入版本可行性 | 10% | 小团队是否能在合理时间内验证 |
| 差异化空间 | 8% | 是否能建立清晰定位或壁垒 |
| 竞争风险 | -5% | 竞争强度、巨头风险、同质化风险 |
| 合规和平台风险 | -5% | 政策、医疗、金融、数据隐私等风险 |
| 证据置信度 | 10% | 来源质量、一致性、证据数量 |

示例公式：

```text
global_score =
  demand_strength * 0.20
  + market_potential * 0.15
  + product_gap * 0.15
  + monetization * 0.12
  + acquisition_feasibility * 0.10
  + entry_version_feasibility * 0.10
  + differentiation * 0.08
  + evidence_confidence * 0.10
  - competition_risk * 0.05
  - compliance_risk * 0.05
```

评分输出必须包含解释：

```json
{
  "opportunity_id": "opp_001",
  "global_score": 8.1,
  "rank": 1,
  "score_breakdown": {
    "demand_strength": 8.8,
    "market_potential": 7.5,
    "product_gap": 8.2,
    "monetization": 7.4,
    "acquisition_feasibility": 7.8,
    "entry_version_feasibility": 8.6,
    "differentiation": 7.9,
    "competition_risk": 5.2,
    "compliance_risk": 6.4,
    "evidence_confidence": 7.6
  },
  "rationale": "该方向痛点明确、切入版本较轻、评论和竞品缺口证据一致，但存在健康数据和老年用户使用门槛。"
}
```

## 系统模块划分

这一节是领域模型说明，不代表在 Icarus 项目中新增第二套 workflow engine。落地到 Icarus 仓库（`/Users/chelaile/IdeaProjects/icarus`）时，下面这些模块应映射为 workflow delegation、skill、host 侧 MCP 工具和少量 deterministic action。

```python
class IndustryAppOpportunityWorkflow:
    async def run(self, direction: str):
        plan = await self.plan_research_lanes(direction)
        lane_results = await self.run_lanes(plan)
        merged = await self.merge_and_cluster(lane_results)
        enriched = await self.retrieve_supporting_evidence(merged)
        ranked = await self.global_rank(enriched)
        report = await self.write_final_report(direction, ranked)
        return report
```

### Planner

负责将输入方向转成研究计划：

```python
class ResearchPlanner:
    async def plan(self, direction: str) -> ResearchPlan:
        ...
```

输出包括：

- 启用哪些 lane。
- 每条 lane 的搜索关键词。
- 每条 lane 的数据源优先级。
- 每条 lane 的 topN 数量。
- 是否需要行业特定维度。

### Discovery Lane

每个调研维度实现统一接口：

```python
class DiscoveryLane:
    name: str

    async def collect_evidence(self, direction: str, plan: LanePlan) -> list[EvidenceItem]:
        ...

    async def extract_findings(self, evidence: list[EvidenceItem]) -> list[Finding]:
        ...

    async def generate_opportunities(self, findings: list[Finding]) -> list[Opportunity]:
        ...

    async def score_opportunities(self, opportunities: list[Opportunity]) -> list[LaneScoredOpportunity]:
        ...
```

### OpportunityClusterer

负责跨 lane 去重、聚类、合并：

```python
class OpportunityClusterer:
    async def merge(self, lane_results: list[LaneResult]) -> list[MergedOpportunity]:
        ...
```

### EvidenceEnricher

负责对合并后的机会补充证据，尤其是综合评分前的关键缺口：

```python
class EvidenceEnricher:
    async def enrich(self, opportunities: list[MergedOpportunity]) -> list[EnrichedOpportunity]:
        ...
```

可补充检索：

- 市场规模
- 竞品情况
- 定价和商业模式
- 用户获取渠道
- 合规风险
- 替代方案
- 反证信息

### GlobalRanker

负责全局评分和排序：

```python
class GlobalRanker:
    async def rank(self, opportunities: list[EnrichedOpportunity]) -> list[RankedOpportunity]:
        ...
```

### Reporter

负责最终报告生成：

```python
class OpportunityReporter:
    async def write(self, direction: str, ranked: list[RankedOpportunity]) -> str:
        ...
```

报告结构建议：

```text
# 行业 App 创业机会调研报告

## 结论摘要
## 排名总览
## 研究方法
## Top 机会详解
  - 机会定义
  - 目标用户
  - 核心痛点
  - 支持证据
  - 竞品覆盖和满意度缺口
  - 商业模式
  - 切入版本建议
  - 风险和反证
## 被筛掉的机会
## 不确定性和后续验证建议
## 参考来源
```

## Icarus 落地设计

### 已确认的 Icarus 架构边界

Icarus 项目（`/Users/chelaile/IdeaProjects/icarus`）已经有完整 workflow 编排层，不需要再做一个独立的 Opportunity workflow engine：

- workflow definition 位于 `/Users/chelaile/IdeaProjects/icarus/container/workflow-definitions/*.json`，由 `/Users/chelaile/IdeaProjects/icarus/src/workflow.ts` 驱动。
- workflow state 类型在 `/Users/chelaile/IdeaProjects/icarus/src/workflow-definition.ts` 中固定为 `delegation`、`system`、`interrupt`、`terminal`。
- delegation 会构建 handoff contract，委派给 container agent 执行 skill，并要求通过 `complete_delegation` 回传结构化结果。
- action registry 在 `/Users/chelaile/IdeaProjects/icarus/src/workflow-actions/registry.ts` 中，目前 action handler 是同步 `run(input): WorkflowActionResult`，适合 deterministic 系统操作，不适合隐藏 LLM 推理。
- `ios_dev_test` 已经提供了最接近的参考实现：`ios_recon` 是 workflow delegation，`ios-recon-requirement` skill 负责分析任务，host 侧 `/Users/chelaile/IdeaProjects/icarus/src/app-recon/*` 通过 MCP/IPC 提供受控工具和产物写盘。
- container agent 的 allowed tools 已包含 `WebSearch`、`WebFetch` 和 `mcp__icarus__*`，因此 exploratory web research 可以由 skill 内 agent 使用工具完成，不必强行做成 action。

因此，该设计方案在 Icarus 中的正确形态是：

```text
Icarus workflow = 唯一编排层
  delegation state = LLM 推理、规划、抽取、综合、报告
  skill = 每类 agent 节点的执行规约
  host MCP tool = 可审计、可复用、确定性的领域工具
  workflow action = context/schema/score/validate 等非 LLM 系统动作
  artifact contract + evaluator = 每阶段质量门
```

### 不单独做 Opportunity Service

术语上，`Opportunity service` 应改名为 `opportunity-recon host toolkit` 或 `opportunity-recon domain module`，避免误解。

它不应该是第二个线程服务或第二个编排器，而是在 Icarus 仓库内新增一个 host 侧领域工具模块，类似现有 `/Users/chelaile/IdeaProjects/icarus/src/app-recon/*`：

```text
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/types.ts
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/evidence-store.ts
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/report-writer.ts
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/request-dispatcher.ts
```

职责只包括：

- 创建调研 session。
- 记录搜索结果、网页、榜单、评论、claim、反证等 evidence。
- 校验 evidence ref 是否存在。
- 写入 JSON/Markdown 产物。
- 调用确定性外部 API，例如 App Store lookup、榜单 API、评论 API、趋势 API。
- 做确定性归一化、去重、评分公式计算。

它不负责：

- 决定 workflow 下一步。
- 自己规划 lane。
- 隐藏 LLM 调用。
- 直接生成最终创业结论。

### Workflow 定义

新增 workflow definition：

```text
/Users/chelaile/IdeaProjects/icarus/container/workflow-definitions/startup_opportunity_research.json
```

建议 roles：

```text
opportunity_planner
audience_pain_researcher
top_products_researcher
review_mining_researcher
search_demand_researcher
trend_researcher
opportunity_synthesizer
opportunity_reviewer
opportunity_reporter
```

建议 artifacts：

```text
research-plan.json
audience-pain-lane.json
top-products-lane.json
review-mining-lane.json
search-demand-lane.json
trend-lane.json
merged-opportunities.json
counter-evidence.json
ranking.json
startup-opportunity-report.md
traceability.json
```

建议 workflow states：

```text
research_plan            delegation  LLM 规划 lane、关键词、数据源、topN、评分权重
audience_pain_recon      delegation  受众/痛点 lane 调研、抽取、维度内筛选
top_products_recon       delegation  头部产品 lane 调研、覆盖度/满意度缺口分析
review_mining_recon      delegation  评论/差评 lane 调研、抱怨聚类、机会提取
search_demand_recon      delegation  搜索需求/内容缺口 lane 调研
trend_recon              delegation  趋势变化 lane 调研
lane_result_validate     system      schema、evidence ref、必填字段、topN 数量校验
opportunity_merge        delegation  语义合并、拆分判断、证据聚合
counter_evidence_recon   delegation  对 top 机会查找反证、替代方案、竞争/合规风险
global_score             system      确定性评分公式、排序、阈值过滤
ranking_rationale        delegation  基于结构化分数生成排名解释
quality_review           delegation  审核证据链、反证、评分解释是否一致
final_report             delegation  输出 Markdown 报告和 traceability
done                     terminal
```

当前 Icarus workflow runtime 是单状态推进，`current_delegation_id` 也是单值；definition 中没有原生并行 fan-out/fan-in 状态。因此在不改 runtime 的落地方案中，不要假设 workflow JSON 能天然并行多 lane。产品化可以有两种实现选择：

1. 保持现有 runtime：把 lane 作为多个连续 delegation state，换取最好的可追踪性和最少 runtime 改动。
2. 扩展 runtime：新增 first-class parallel delegation/fan-in 能力，让多个 lane delegation 同时运行并在全部完成后进入 merge。这个扩展应属于 workflow runtime，而不是藏进 action 或 Opportunity toolkit。

如果短期只是为了提速，可以在某个 lane skill 内使用 agent 子任务或工具批量请求，但这会降低 workflow 层对每条 lane 的可观测性；成品设计更推荐 runtime 层支持 fan-out。

### Skill 设计

新增 skills：

```text
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-research-plan/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-audience-pain-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-top-products-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-review-mining-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-search-demand-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-trend-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-merge-synthesis/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-counter-evidence/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-ranking-rationale/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-quality-review/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-report-writer/SKILL.md
```

并在 `/Users/chelaile/IdeaProjects/icarus/container/skills/skills.json` 中新增 web role 映射，例如：

```json
{
  "web_opportunity_planner": ["opportunity-research-plan"],
  "web_opportunity_research": [
    "opportunity-audience-pain-recon",
    "opportunity-top-products-recon",
    "opportunity-review-mining-recon",
    "opportunity-search-demand-recon",
    "opportunity-trend-recon",
    "opportunity-counter-evidence"
  ],
  "web_opportunity_synthesis": [
    "opportunity-merge-synthesis",
    "opportunity-ranking-rationale",
    "opportunity-report-writer"
  ],
  "web_opportunity_review": ["opportunity-quality-review"]
}
```

每个 skill 必须要求：

- 读取 Context Pack。
- 使用 handoff contract 中的输入和成功标准。
- 所有业务结论写成结构化 artifact。
- evidence 引用必须可追踪。
- 无论成功/失败都调用 `complete_delegation`。
- result 至少包含 `verdict`、`summary`、`findings`、`evidence`。

这与 `/Users/chelaile/IdeaProjects/icarus/container/skills/ios-recon-requirement/SKILL.md` 的模式一致。

### MCP 工具与 action 的边界

搜索、抓取、API 调用不应按工具形态一刀切。判断标准是“它是 agent 探索的一部分，还是确定性系统动作”。

适合放在 skill/agent 工具中的：

- 开放式 WebSearch/WebFetch。
- 根据调研进展临时扩展关键词。
- 判断哪些来源值得读。
- 从网页中抽取痛点、功能、反证。
- 对语义相近机会做合并/拆分判断。

适合做成 host MCP tool 的：

- `opportunity_create_session`
- `opportunity_record_evidence`
- `opportunity_write_claims`
- `opportunity_write_report`
- `opportunity_fetch_url_batch`
- `opportunity_app_store_lookup`
- `opportunity_google_play_lookup`
- `opportunity_collect_reviews`
- `opportunity_normalize_product`

这些工具通过 `/Users/chelaile/IdeaProjects/icarus/container/agent-runner/src/ipc-mcp-stdio.ts` 暴露，再通过 `/Users/chelaile/IdeaProjects/icarus/src/ipc.ts` 分发到 `/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/request-dispatcher.ts`，模式参考现有 `ios_app_request`。

适合 workflow action 的：

- `context.set`、`context.require` 这类已有上下文操作。
- lane artifact schema validation。
- evidence ref validation。
- deterministic dedupe，例如 URL canonicalization、product id 归一化。
- deterministic global scoring。
- 阈值过滤和路由。

不适合 workflow action 的：

- LLM lane planning。
- LLM 信息抽取。
- LLM 机会合并判断。
- LLM 排名理由生成。
- LLM 报告生成。

如果需要 action 支持异步并行，应先把 `WorkflowActionHandler.run` 扩展为允许 `Promise<WorkflowActionResult>`，并让 `runWorkflowActionSteps` await。这个扩展只用于长耗时 deterministic 操作或 fan-out 状态管理，不用于把 LLM 调用塞进 action。

### Artifact Contract 与 Evaluator

新增 artifact contracts：

```text
startup_opportunity.plan.v1
startup_opportunity.lane_result.v1
startup_opportunity.merge.v1
startup_opportunity.counter_evidence.v1
startup_opportunity.ranking.v1
startup_opportunity.report.v1
```

放在：

```text
/Users/chelaile/IdeaProjects/icarus/container/artifact-contracts/startup-opportunity.json
```

新增 evaluator：

```text
/Users/chelaile/IdeaProjects/icarus/container/workflow-evaluators/startup-opportunity.json
```

每个 delegation state 配置：

```json
{
  "artifact_contract": { "ref": "startup_opportunity.lane_result.v1" },
  "evaluator": { "ref": "startup_opportunity.lane_result.v1" },
  "quality_gate": {
    "pass_policy": "all_blocking_pass",
    "evaluators": [
      { "type": "schema", "blocking": true },
      { "type": "artifact", "blocking": true },
      { "type": "evidence", "blocking": true },
      { "type": "consistency", "blocking": true },
      { "type": "llm_judge", "blocking": false }
    ]
  }
}
```

### 输入不是机会，而是方向

Workflow create input 应使用方向字段，而不是候选机会字段：

```json
{
  "direction": "宠物行业 App",
  "market": "中国",
  "platform": ["iOS", "Android", "Web"],
  "language": "zh-CN",
  "target_rank_count": 10,
  "lane_top_n": 8,
  "constraints": ["不做医疗诊断", "优先 ToC 订阅或交易撮合"]
}
```

Icarus 的 `WorkflowContext` 是 `Record<string, unknown>`，`createNewWorkflow` 会 merge `opts.context`，template rendering 也支持从 context 中取值。因此可以先通过 `context.direction` 等字段进入 workflow template；后续如果前端创建表单要更友好，再扩展 `create_form` 字段配置。

### 最终推荐结构

不要把创业机会调研做成：

```text
workflow action -> 调 GPTResearcher deep -> 产出报告
```

也不要做成：

```text
Opportunity service -> 自己规划/执行/评分/报告 -> Icarus 只展示结果
```

应做成：

```text
Icarus workflow
  -> delegation: research_plan skill
  -> delegation: lane recon skills
  -> system/action: lane result validation
  -> delegation: merge/counter-evidence/rationale/report skills
  -> system/action: deterministic scoring
  -> artifact contract + evaluator + quality gate
  -> final report artifacts
```

这种结构既满足“LLM 调用是委托节点”的架构约束，也符合 Icarus 当前的 host/container/MCP/skill 架构。

## GPT Researcher 项目关系

该 Agent 服务可以复用或借鉴 GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）的以下能力：

- query expansion
- retriever/search
- web scraping
- source curation
- context summarization
- deep research 的递归追问思路
- markdown report generation

但不建议直接把以下接口作为主业务入口：

```python
researcher = GPTResearcher(query=direction, report_type="deep")
await researcher.conduct_research()
report = await researcher.write_report()
```

原因：

- `deep` 的目标是围绕一个 query 做递归研究，不负责多 lane 机会挖掘。
- `write_report()` 生成的是自然语言报告，不负责结构化评分和排序。
- 创业机会判断需要固定 schema、权重、证据链和反证逻辑。
- 不同 lane 的筛选规则不同，不能交给通用报告 prompt 隐式完成。

推荐方式是将 GPT Researcher 的底层能力封装为工具或 Icarus 可调用的 host/MCP 能力：

```python
class EvidenceResearchTool:
    async def search(self, query: str, domains: list[str] | None = None) -> list[SearchResult]:
        ...

    async def scrape(self, urls: list[str]) -> list[Document]:
        ...

    async def summarize(self, query: str, docs: list[Document]) -> str:
        ...
```

创业机会调研 workflow 自己控制候选机会生成、评分、聚类和排序。

## 成品化实施范围

成品版本应覆盖完整 lane，而不是只做最小可用版本：

1. 受众需求痛点 Lane
2. 已有产品 Top 排名挖掘 Lane
3. 用户评论与差评挖掘 Lane
4. 搜索需求与内容缺口 Lane
5. 趋势变化 Lane
6. 反证与风险 Lane

最终输出 top 10 创业机会，每个机会包含：

- 标题和一句话定义
- 目标用户
- 关键痛点
- 机会来源 lane
- 主要证据
- 竞品缺口
- 综合评分
- 切入版本建议
- 主要风险

### 成品 Workflow

```text
direction
  -> planner
  -> run all lanes
  -> each lane topN
  -> validate lane artifacts
  -> cluster/merge
  -> counter-evidence research
  -> deterministic global score
  -> ranking rationale
  -> quality review
  -> markdown + JSON report
```

### 后续增强

- 引入人工可调权重。
- 支持多国家/地区市场比较。
- 支持输出结构化 JSON + Markdown 双格式。
- 支持用户在报告后追问某个机会，进入二次深挖。

## 示例：宠物行业 App

输入：

```text
宠物行业 App
```

可能的 lane 发现：

| Lane | 发现方向 |
|------|----------|
| 受众需求痛点 | 宠物慢病管理、上门喂养、宠物训练 |
| Top 产品挖掘 | 宠物社区、电商、健康记录已有产品多，但垂直慢病协同不足 |
| 评论挖掘 | 用户抱怨提醒不准、记录分散、服务质量不稳定 |

合并后机会：

```text
宠物慢病管理与家庭协同 App
```

综合判断：

- 目标用户：高龄宠物主人、多宠家庭、慢病宠物家庭。
- 痛点：长期用药、复诊、检查记录、家庭成员协同。
- 竞品缺口：通用宠物记录产品存在，但围绕慢病流程的深度不足。
- 切入版本：健康档案、用药提醒、复诊提醒、检查报告归档、家庭共享。
- 风险：宠物医疗数据标准化、与线下宠物医院合作难度。

## 风险与注意事项

- 公开数据可能不完整，尤其是 App 榜单和评论数据。
- LLM 提取痛点和机会时可能过度概括，需要 schema 和证据校验约束。
- 排名不能只看高分，也要看证据置信度和反证。
- 不同行业的权重应允许配置，例如医疗健康类应提高合规风险权重。
- 最终报告应明确不确定性，避免把研究结论包装成确定性商业建议。

## 结论

行业 App 创业机会 Agent 应定位为：

```text
multi-lane opportunity mining
  + structured evaluation
  + evidence-backed ranking
  + decision-oriented reporting
```

该 Agent 服务可以借鉴 GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）的搜索、抓取、摘要、递归追问和报告生成能力，但主流程应落在 Icarus 项目（`/Users/chelaile/IdeaProjects/icarus`）的 workflow、delegation、skill、MCP tool、artifact contract 和 evaluator 体系内。候选机会应来自多条调研维度的证据挖掘，每条维度先独立筛选 topN，再通过聚类、补充检索和综合评分生成最终创业方向排名。
