# RFC: 并行研究 Workflow 架构与行业 App 创业机会调研 Agent

> **状态**: 提案
> **作者**: 社区贡献者
> **创建日期**: 2026-07-01
> **目标版本**: 待定

## 概述

该设计方案从第三方架构视角描述两层内容：

1. Icarus 需要新增 first-class parallel/fan-in workflow 能力，使它可以支撑完整的多分支 RAG、调研、评审和综合流程。
2. 在该能力之上，定义一个面向“某个行业 App 方向”的创业机会调研 Agent Workflow。

方案同时涉及 GPT Researcher 与 Icarus 两个项目，但不以任一仓库作为唯一叙述主体。

关联仓库：

- Icarus 仓库：`/Users/chelaile/IdeaProjects/icarus`
- GPT Researcher 仓库：`/Users/chelaile/IdeaProjects/gpt-researcher`

创业机会 Agent 不是通用 deep research，也不是直接让模型基于一个行业方向生成候选创业点，而是通过多条明确的调研维度并行收集原始证据并留痕，再从证据中提炼 claim、finding 和 insight 等判断层产物，后续基于判断层挖掘候选机会、筛选、合并、补充检索、反证和综合排序，最终输出创业方向排名和专业分析报告。

本方案不按 MVP 分期设计，而是描述一版完整架构。实现时可以按工程风险拆任务，但文档目标是定义完整形态。

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
- 判断依据摘要
- 竞品覆盖度
- 用户满意度缺口
- 市场和商业化判断
- 切入版本建议
- 风险和不确定性
```

## 背景与动机

GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）当前更偏向通用研究报告生成，尤其是 `deep` 模式，重点是围绕一个查询进行初始检索、扩展问题、并发子研究、递归追问、上下文压缩、来源筛选并生成综合报告。实际使用中，GPT Researcher deep 生成的调研报告质量较高，说明它的流程设计有重要参考价值。

Icarus 项目（`/Users/chelaile/IdeaProjects/icarus`）已有 workflow、delegation、skill、artifact contract、evaluator、host/container/IPC/MCP 等基础能力，但当前 workflow runtime 仍以单状态推进和单 `current_delegation_id` 为核心。它可以表达顺序工作流，却不足以自然表达多 lane 调研、多 query 检索、多来源并行 enrichment、多 reviewer 并行复核这类复杂 RAG 图。

因此，本方案的核心动机不是简单新增一个创业机会 workflow，而是补齐 Icarus 的并行研究 workflow 能力，再用创业机会调研作为第一个完整业务实例。

创业机会调研需要更强的业务 workflow 控制：

| 需求 | 通用 deep research | 创业机会 Agent |
|------|--------------------|----------------|
| 输入 | 一个研究问题 | 一个行业或 App 方向 |
| 候选机会 | 可能由模型直接总结 | 必须从多类证据提炼出的判断层中挖掘 |
| 调研维度 | 动态扩展为主 | 预设维度 + 动态补充 |
| 评估方式 | 自然语言综合 | 结构化评分、筛选、排序 |
| 输出 | 一篇报告 | 多个机会方向排名 + 可审计判断链 |
| 决策逻辑 | 隐式 | 显式、可追溯、可调权重 |

因此，该 Agent 服务不应直接把 `GPTResearcher(report_type="deep")` 作为主业务接口，也不应只复刻一次性 deep research prompt。正确方向是：参考 GPT Researcher 的高质量调研流程，抽象出 Icarus 自己的 Research Kernel，并让 workflow runtime 原生支持并行分支、分支质量门、fan-in 汇总和可追踪产物。

## 目标

- 新增 Icarus first-class parallel/fan-in workflow 能力，支撑完整多分支 RAG/调研流程。
- 将并行分支建模为 workflow runtime 的一等状态，而不是藏在 action、agent 子任务或某个外部 service 中。
- 明确 workflow action 只负责确定性系统操作；调研、检索控制、抽取、综合等非确定性任务由 agent delegation 节点完成。
- 参考 GPT Researcher deep 的流程设计，抽象为可被 Icarus lane 复用的 Research Kernel。
- 从行业 App 方向中发现多个候选创业机会。
- 在正式调研前明确市场、平台、商业模式、团队能力、风险偏好和验证周期等 scope assumptions。
- 候选机会必须来自明确调研维度提炼出的 claim、finding 和 insight，而不是先验生成。
- 候选机会必须建模为可被验证或推翻的 opportunity thesis，而不是只有方向标题和摘要。
- 每条调研维度独立、可并行地完成证据留痕、判断提炼、机会提取和维度内筛选。
- 每条调研维度都必须输出支持判断、反对判断、不确定性和 kill conditions，避免只做正向论证。
- 对多维度筛选出的 topN 机会进行去重、聚类和判断依据合并。
- 对合并机会进行并行补充检索、竞品验证、市场/商业化判断、合规风险和反证调查。
- 对合并后的机会进行跨维度综合排序、敏感性分析和排名稳定性判断。
- 输出可解释的创业方向排名和具体分析总结。
- 输出每个推荐机会的验证计划、成功阈值和失败阈值，帮助用户决定下一步是否投入。
- 支持扩展新的调研维度、评分规则和数据源。

## 非目标

- 不直接替代 GPT Researcher 的通用研究报告能力。
- 不把 GPT Researcher 作为黑盒主业务入口；它是流程参考和可选底层能力来源。
- 不把 LLM 的自然语言报告作为唯一决策结果。
- 不把成品服务降级成一次性报告生成；需要保留结构化判断层、评分、反证和可追踪审计产物。
- 不把并行能力做成某个业务 workflow 的特例；并行/fan-in 是 Icarus workflow runtime 的通用能力。
- 不默认“做 App”一定是正确答案；如果非 App 替代方案、线下服务、人工流程或现有工作流更优，需要在报告中说明。
- 不用 MVP 范围定义本方案；本方案描述完整目标形态。
- 不保证生成的方向一定可创业成功，系统输出的是基于公开信息和可获取证据的机会判断。

## 核心设计原则

### 1. 机会来自判断层，而不是先生成

错误流程：

```text
行业方向 -> LLM 直接生成 10 个创业机会 -> 再调研
```

目标流程：

```text
行业方向 -> 多维度调研 -> 原始证据留痕 -> 提炼判断层 -> 从判断层提取机会 -> 筛选排序
```

原始证据只作为留痕、审计和置信度校验的底层材料，不直接作为后续调研结果生成或最终报告写作的语料。后续 workflow 只消费从证据中提炼出的结构化判断层：

```text
Evidence Store -> Claims -> Findings -> Insights -> Opportunities -> Scores -> Report
```

其中：

- `Evidence` 是网页、评论、榜单、报告、帖子等原始材料，保存在 evidence store 中。
- `Claim` 是从原始材料中抽取出的单条事实或判断。
- `Finding` 是对多条 claim 的归纳发现。
- `Insight` 是面向创业决策的洞察。
- `Report` 使用专业报告结构表达判断，不按证据列表展开综述。

### 2. 高质量机会先被定义，再被发现

系统需要先定义什么是“值得推进的创业机会”，再去调研和排序。否则 workflow 可能产出证据充分但创业价值不足的方向。

每个候选机会必须回答以下一组 first-principles 问题：

```text
谁有问题？
问题发生在什么任务或场景？
现在用户用什么替代方案解决？
为什么现有方案不够好？
谁是使用者、购买者、付费者和决策者？
为什么现在愿意付钱或改变行为？
如何低成本触达第一批用户？
小团队能否在 4-8 周内验证核心假设？
第一个切入版本和 beachhead segment 是什么？
什么证据会推翻这个机会？
```

因此，候选机会不是普通摘要，而是 opportunity thesis：

```text
Opportunity = user/job/pain + current alternative + gap + buyer/payer
  + entry wedge + distribution path + why now + risks + validation plan
```

没有明确买单方、切入楔子、替代方案对比或可验证假设的候选方向，应降级为 `watchlist` 或 `insufficient_evidence`，不能直接进入强推荐。

### 3. 输入方向必须先被约束和假设化

“宠物行业 App”这类输入过宽，不同市场、团队能力、平台约束和风险偏好会得到不同结论。正式调研前必须先做 `scope_framing`：

- 目标地区和语言，例如中国、美国、跨境市场。
- 平台形态，例如 Mobile、Web、小程序、插件、B2B SaaS。
- 商业模式偏好，例如 ToC 订阅、交易撮合、B2B、B2B2C。
- 团队能力和资源约束，例如是否能做线下运营、是否有行业资源、是否能接入供应链。
- 验证周期和预算，例如 7 天、30 天或 90 天验证。
- 风险偏好，例如是否接受医疗、金融、未成年人、隐私或平台依赖风险。
- 是否必须是纯 App；如果非 App 方案更合理，应允许报告给出“不建议做独立 App”的结论。

如果用户没有显式提供这些约束，workflow 应生成默认假设，并在最终报告和 JSON artifact 中明确记录。

### 4. 调研维度既是发现通道，也是筛选通道

每个调研维度不是只负责收集材料，而是完整产出：

```text
Evidence refs -> Claims -> Findings -> Insights -> Opportunities -> Lane Scores -> Kill Gate -> TopN
```

例如“已有产品 Top 排名挖掘”维度需要：

- 找到排行榜头部产品。
- 总结产品覆盖的人群、场景、功能、商业模式。
- 挖掘用户评论、低星反馈、功能请求。
- 判断是否存在覆盖不足、满意度不足、差异化缺口。
- 生成该维度下的候选机会。
- 输出支持 claims、反对 claims、不确定性和 kill conditions。
- 按该维度规则筛出 topN。

### 5. 先维度内筛选，再跨维度综合排序

不同调研维度的判断质量和含义不同，不能在早期简单混合。每个维度先独立判断，产出本维度 topN；然后再做机会合并、判断依据聚合和全局评分。

### 6. 反证前置，而不是只在末尾复核

反证不应只在 enrichment 阶段才出现。每条 discovery lane 都必须主动寻找与本 lane 候选机会相反的证据，包括：

- 用户痛点是否只属于小众极端样本。
- 用户是否已有足够好的免费替代方案。
- 用户是否表达需求但缺乏付费意愿。
- 现有产品是否已经在快速补齐缺口。
- App 是否不是最佳交付形态。
- 合规、平台、供应链或获客成本是否足以否定机会。

lane 内筛选前必须执行 pre-kill gate。触发 kill condition 的机会可以进入附录或观察池，但不能作为正式 top opportunity 输出。

### 7. 所有结论保留可审计判断链

每个机会方向的评分和结论都应能追溯到：

- 来自哪个调研维度。
- 使用了哪些 claim、finding 和 insight。
- 这些判断层产物背后有哪些 evidence refs。
- 哪些判断支持机会，哪些判断构成反证。
- 证据是否独立、是否近期、是否来自目标地区、是否存在样本偏差。
- 置信度如何。

但最终报告不应围绕 evidence ref 展开写作，也不应把原始证据片段作为主要内容。证据只在审计链、附录、traceability artifact 或必要的脚注位置出现。

### 8. 并行是 workflow 一等能力

多 lane 调研、多 query 搜索、多机会 enrichment、多 reviewer 复核都不应被隐藏在一个 agent 节点内部。隐藏并行会降低 workflow 层可观测性、可恢复性和质量门控制。

目标形态：

```text
workflow state: parallel
  -> branch delegation A
  -> branch delegation B
  -> branch delegation C
  -> branch artifact/evaluator per branch
  -> join policy
  -> fan-in context
```

### 9. Action 只做确定性系统操作

workflow action 的职责边界：

```text
适合 action:
  schema validation
  evidence ref validation
  deterministic dedupe
  deterministic scoring
  context patch
  routing decision

不适合 action:
  LLM 规划
  开放式调研判断
  LLM 信息抽取
  LLM 机会合并
  LLM 报告生成
```

检索和调研需要进一步拆分：

- agent delegation 节点负责决定查什么、为什么查、读哪些来源、如何抽取。
- host MCP tool 负责执行可审计的数据获取、落盘、归一化和 evidence record。
- workflow action 只在阶段边界做确定性校验、评分和路由。

## 总体 Workflow

### 架构层 Workflow

```text
Icarus workflow runtime
  -> delegation/system/interrupt/terminal
  -> 新增 parallel/fan-in state
  -> branch-level delegation + artifact contract + evaluator
  -> join policy
  -> fan-in context pack
  -> downstream delegation/system states
```

### 创业机会业务 Workflow

```text
行业 App 方向输入
  -> Scope Framing
      -> 市场/地区/语言
      -> 平台和交付形态
      -> 商业模式偏好
      -> 团队能力和验证周期约束
      -> 风险偏好和默认假设
  -> 研究规划
  -> 调研种子探测
      -> 用户/场景 seed
      -> 问题/痛点 seed
      -> 关键词 seed
      -> 产品 seed
      -> 数据源 seed
  -> 机会空间和任务流地图
      -> 用户角色
      -> 高频任务
      -> 当前替代方案
      -> 工作流摩擦点
      -> 可软件化节点
  -> 并行发现 lanes
      -> 原始证据留痕
      -> claim/finding/insight 提炼
      -> 候选机会生成
      -> 支持/反对 claims 和 kill conditions
      -> 维度内评分
      -> pre-kill gate
      -> 维度内 topN 筛选
  -> lane artifact/evaluator 校验
  -> 机会 thesis 合成
  -> 机会去重与聚类
  -> 并行 enrichment lanes
      -> 竞品缺口
      -> 市场空间
      -> 商业化
      -> 获客路径
      -> 合规和平台风险
      -> 反证与替代方案
      -> 可行性和早期单位经济
  -> 跨维度综合评分
  -> 敏感性分析和排名稳定性判断
  -> 排名与推荐
  -> 对抗式质量复核
  -> 验证计划生成
  -> JSON + Markdown 最终报告生成
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
  -> 原始证据留痕
  -> claim/finding/insight 提炼
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
| 判断置信度 | claim/finding/insight 是否有足够来源支撑，来源质量和一致性如何 |

### 2. JTBD 与任务流拆解 Lane

目标：从用户要完成的任务和实际工作流出发，识别流程断点、信息不对称、协作摩擦和可软件化节点。

典型数据源：

- 行业流程文章、教程和操作指南
- 用户访谈、问答平台、社区长帖
- B2B/SaaS 案例、岗位职责、服务流程说明
- 线下服务商、代理、中介和人工服务页面
- 现有产品 onboarding、帮助中心和用户手册

处理流程：

```text
行业方向
  -> 用户角色拆解
  -> 高频 job/task 识别
  -> 当前工作流地图
  -> 当前替代方案和 workaround 记录
  -> 流程摩擦点提取
  -> 可软件化/自动化/协同化节点判断
  -> 候选机会 thesis 生成
  -> 按任务频率、任务价值、流程摩擦、切入可行性评分
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 任务频率 | 用户是否反复执行该任务 |
| 任务价值 | 任务是否影响收入、成本、效率、安全、健康或情绪 |
| 流程摩擦 | 当前流程是否存在明显断点、重复录入、信息不透明或协作成本 |
| 替代方案劣势 | Excel、微信群、人工服务、线下中介、通用工具等替代方案是否明显不足 |
| 软件化潜力 | App/Web/SaaS 是否能比现有方案更低成本、更稳定或更可扩展 |
| 切入楔子清晰度 | 是否能定义一个足够小、足够痛、可验证的 beachhead segment |

### 3. 已有产品 Top 排名挖掘 Lane

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
| 买单方清晰度 | 现有产品是否揭示了使用者、购买者、付费者和决策者之间的关系 |

### 4. 用户评论与差评挖掘 Lane

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
| 反证密度 | 正面评论、替代方案满意度或产品近期更新是否削弱该机会 |

### 5. 搜索需求与内容缺口 Lane

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
| 工具转化风险 | 用户是否只是寻求一次性答案，而不是愿意持续使用工具 |

### 6. 趋势变化 Lane

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

### 7. 替代方案与非 App 竞争 Lane

目标：判断目标用户当前如何解决问题，App 是否真的优于现有替代方案，以及机会是否被非软件因素限制。

典型数据源：

- 用户社区中的 workaround 分享
- Excel/Notion/微信群/小程序/表单模板等轻量工具
- 线下服务商、代理、中介、咨询和人工代办
- 企业内部流程、岗位职责和外包服务页面
- 竞品评论中提到的替代产品和流失原因

处理流程：

```text
行业方向或候选机会
  -> 当前替代方案枚举
  -> 替代方案成本、体验和可获得性分析
  -> 用户切换阻力判断
  -> 非 App 交付形态比较
  -> App 解法必要性判断
  -> 候选机会降级、改写或保留
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 替代方案强度 | 当前替代方案是否已经足够便宜、方便、可信 |
| 切换阻力 | 用户迁移数据、习惯、关系链或工作流的成本 |
| App 必要性 | 独立 App 是否比小程序、插件、SaaS、服务撮合或线下服务更合理 |
| 服务依赖度 | 机会是否依赖重运营、供应链、线下交付或人工服务 |
| 防御性 | 如果用通用工具或现有平台也能快速复制，差异化是否不足 |
| 否定风险 | 替代方案证据是否足以触发 kill condition |

## 候选机会数据模型

候选机会必须是结构化对象，避免只保存自然语言摘要。

```json
{
  "id": "opp_001",
  "title": "面向独居老人的用药提醒与家庭协同 App",
  "description": "帮助独居老人管理用药、复诊和家庭成员远程确认。",
  "opportunity_thesis": "异地子女需要低成本确认独居老人慢病用药和复诊执行情况；现有个人提醒工具缺少家庭协同和长期健康记录，因此可以从家庭协同用药提醒切入。",
  "target_users": ["独居老人", "异地子女", "慢病患者家庭"],
  "buyer": ["异地子女"],
  "payer": ["异地子女", "慢病患者家庭"],
  "decision_maker": ["家庭照护负责人"],
  "budget_source": "家庭健康管理和慢病照护支出",
  "purchase_trigger": "老人漏服、复诊延误、子女无法远程确认照护状态",
  "primary_scenarios": ["每日用药提醒", "漏服告警", "复诊记录", "家庭协同"],
  "job_to_be_done": "让家庭成员在不频繁打电话的情况下确认老人是否按时用药、复诊和记录慢病信息。",
  "pain_points": [
    "老人容易忘记用药",
    "子女无法确认是否按时服药",
    "慢病复诊和药品记录分散"
  ],
  "current_alternatives": ["电话确认", "微信提醒", "普通闹钟", "纸质用药记录", "通用用药提醒 App"],
  "alternative_gap": "普通提醒工具解决个人提醒，但不能稳定完成家庭确认、复诊协同和长期记录沉淀。",
  "beachhead_segment": "异地子女照护的独居慢病老人家庭",
  "entry_wedge": "家庭协同用药提醒、漏服确认和复诊记录",
  "why_now": "远程家庭照护需求增加，老年慢病管理数字化工具成熟，但通用提醒工具仍偏个人使用。",
  "initial_distribution_channel": ["慢病社区内容", "子女照护人群社群", "药店/基层诊所合作"],
  "expansion_path": ["复诊档案", "检查报告归档", "家庭健康日历", "护理服务和保险导流"],
  "defensibility_hypothesis": "通过家庭协同记录、长期健康数据和照护工作流沉淀提高迁移成本。",
  "source_lanes": ["audience_pain", "job_to_be_done", "top_products_gap", "review_mining"],
  "supporting_insights": [
    {
      "insight_id": "ins_001",
      "summary": "现有用药提醒产品更偏个人提醒，家庭协同和长期慢病流程覆盖不足。",
      "confidence": 0.78
    }
  ],
  "opposing_claims": [
    {
      "claim_id": "claim_009",
      "summary": "部分家庭可能继续使用微信和电话完成低频照护确认。"
    }
  ],
  "audit_refs": ["claim_001", "claim_002", "ev_001"],
  "lane_scores": {
    "audience_pain": 8.4,
    "job_to_be_done": 8.1,
    "top_products_gap": 7.2,
    "review_mining": 8.8
  },
  "score_band": "strong_candidate",
  "global_score": 8.1,
  "rank_stability": 0.74,
  "sensitivity": {
    "most_sensitive_dimensions": ["acquisition_feasibility", "payer_clarity"],
    "downside_case_score": 6.4,
    "upside_case_score": 8.7
  },
  "confidence": 0.76,
  "risks": ["老年用户使用门槛", "医疗健康合规边界"],
  "kill_criteria": [
    "目标家庭不愿为远程确认功能付费",
    "微信/电话等轻量替代方案已经足够满足需求",
    "健康数据合规成本超过早期团队可承受范围"
  ],
  "entry_version": "家庭协同用药提醒、复诊记录和漏服通知。",
  "validation_plan": {
    "7_day_test": "访谈 10 个异地照护家庭，验证漏服确认和复诊记录是否是高频痛点。",
    "30_day_mvp": "用微信小程序或轻量 Web 原型测试提醒、确认和家庭共享流程。",
    "success_threshold": "30% 以上访谈对象愿意留下联系方式或试用，至少 5 个家庭愿意为高级功能付费。",
    "failure_threshold": "多数用户表示电话/微信已经足够，或只愿免费使用提醒功能。"
  }
}
```

## Evidence / Claim / Finding / Insight 分层模型

原始证据只进入 evidence store，用于留痕、审计、来源校验和置信度计算。后续调研、合并、评分和报告生成不直接消费 `raw_text`，而是消费 `claim`、`finding` 和 `insight`。

### Evidence Record

Evidence record 记录来源和原始材料，不作为最终报告的写作语料。

```json
{
  "id": "ev_001",
  "lane": "review_mining",
  "source_type": "app_store_review",
  "source_name": "App Store",
  "url": "https://example.com",
  "published_at": "2026-06-01",
  "retrieved_at": "2026-07-01T10:20:00Z",
  "query": "用药提醒 App 家庭协同 差评",
  "research_goal": "验证现有提醒工具是否存在家庭同步和长期慢病流程缺口",
  "geo": "CN",
  "language": "zh-CN",
  "sample_size": 120,
  "source_independence": "primary",
  "source_bias": "negative-review-heavy",
  "evidence_role": "support",
  "raw_text": "用户原始评论或网页摘要，仅保存在 evidence store 中",
  "claim_refs": ["claim_001", "claim_002"],
  "sentiment": "negative",
  "relevance": 0.86,
  "credibility": 0.72
}
```

证据置信度不能只按 evidence 数量累加。多个转载、互相引用或来自同一评论样本的来源，应按低独立性处理；目标地区、发布时间、样本规模和样本偏差都应进入 confidence 计算。

### Claim

Claim 是从 evidence 中抽取出的单条事实、痛点、缺口或反证判断。Claim 可以引用 evidence id，但不携带原始证据全文。

```json
{
  "id": "claim_001",
  "lane": "review_mining",
  "claim_type": "pain_point",
  "statement": "部分用户对用药提醒稳定性和家庭成员同步能力不满意。",
  "stance": "support",
  "opportunity_refs": ["opp_001"],
  "evidence_refs": ["ev_001"],
  "evidence_independence": 0.72,
  "sample_bias": "评论样本可能偏向强不满用户",
  "confidence": 0.78,
  "limitations": ["评论样本可能偏向负面用户"]
}
```

### Finding

Finding 是对多条 claim 的归纳发现，用于 lane 内候选机会生成。

```json
{
  "id": "finding_001",
  "lane": "review_mining",
  "summary": "宠物或老人慢病管理场景中，提醒、记录和家庭协同经常被拆散在多个工具中。",
  "claim_refs": ["claim_001", "claim_002"],
  "confidence": 0.74
}
```

### Insight

Insight 是面向创业决策的洞察，用于跨 lane 合并、enrichment、评分和最终报告。

```json
{
  "id": "ins_001",
  "source_lanes": ["review_mining", "top_products"],
  "summary": "围绕长期照护流程的一体化协同工具可能比单点提醒工具更有差异化空间。",
  "finding_refs": ["finding_001", "finding_002"],
  "decision_relevance": "opportunity_definition",
  "confidence": 0.76
}
```

## 维度内筛选

每条 lane 独立输出 topN 候选机会：

```text
LaneResult
  - lane_name
  - findings
  - claims
  - supporting_claims
  - opposing_claims
  - insights
  - opportunities
  - scored_opportunities
  - kill_conditions
  - pre_kill_decisions
  - top_opportunities
  - audit_refs
```

lane 内筛选前必须执行 pre-kill gate。每个机会至少有一个明确的可推翻条件；如果反证强度超过支持证据，或者买单方、替代方案、触达路径、合规边界无法说明，应进入 `rejected_opportunities` 或 `watchlist`，而不是进入 topN。

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
    "competition_risk": 6.2,
    "payer_clarity": 7.8,
    "alternative_weakness": 7.1,
    "pre_kill_risk": 4.4
  },
  "opposing_claim_refs": ["claim_009"],
  "kill_conditions": ["用户继续使用微信/电话即可满足低频确认需求"],
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
  -> 合并目标用户、场景、痛点、claim/finding/insight 引用
  -> 生成统一机会描述
```

合并规则：

- 如果目标用户、核心场景、主要痛点高度一致，则合并。
- 如果目标用户一致但场景差异明显，可保留为同一机会下的子方向。
- 如果商业模式、获客路径、切入版本差异很大，应拆分。

## 综合评分与排序

综合评分不应简单平均所有 lane 分数，而应基于创业判断维度重新评估。最终排序也不应只输出一个 `global_score`，还应输出置信度、排名稳定性、敏感性分析和推荐档位。

建议全局评分维度：

| 维度 | 权重示例 | 说明 |
|------|----------|------|
| 需求强度 | 20% | 用户痛点是否真实且强烈 |
| 市场空间 | 15% | 用户规模、消费能力、增长趋势 |
| 现有产品缺口 | 15% | 头部产品是否存在覆盖或满意度缺口 |
| 买单方明确度 | 8% | 使用者、购买者、付费者和决策者是否清楚 |
| 付费和商业化 | 10% | 是否有付费意愿、订阅、交易或 B2B 变现 |
| 获客可行性 | 10% | 是否有清晰低成本触达渠道 |
| 切入版本可行性 | 8% | 小团队是否能在合理时间内验证 |
| 验证可行性 | 7% | 7-30 天内是否能用访谈、落地页、原型或人工服务验证 |
| 差异化空间 | 8% | 是否能建立清晰定位或壁垒 |
| 时机窗口 | 6% | 为什么现在是较好的进入时点 |
| 替代方案风险 | -6% | 用户当前替代方案是否已经足够好 |
| 竞争风险 | -5% | 竞争强度、巨头风险、同质化风险 |
| 合规和平台风险 | -5% | 政策、医疗、金融、数据隐私等风险 |
| 判断置信度 | 10% | claim/finding/insight 的来源质量、一致性和覆盖度 |

示例公式：

```text
global_score =
  demand_strength * 0.20
  + market_potential * 0.15
  + product_gap * 0.15
  + payer_clarity * 0.08
  + monetization * 0.10
  + acquisition_feasibility * 0.10
  + entry_version_feasibility * 0.08
  + validation_feasibility * 0.07
  + differentiation * 0.08
  + timing_window * 0.06
  + judgment_confidence * 0.10
  - substitute_risk * 0.06
  - competition_risk * 0.05
  - compliance_risk * 0.05
```

评分输出必须包含解释、档位、敏感性分析和排名稳定性：

```json
{
  "opportunity_id": "opp_001",
  "score_band": "strong_candidate",
  "global_score": 8.1,
  "confidence_score": 7.6,
  "rank_stability": 0.74,
  "rank": 1,
  "score_breakdown": {
    "demand_strength": 8.8,
    "market_potential": 7.5,
    "product_gap": 8.2,
    "payer_clarity": 8.0,
    "monetization": 7.4,
    "acquisition_feasibility": 7.8,
    "entry_version_feasibility": 8.6,
    "validation_feasibility": 8.2,
    "differentiation": 7.9,
    "timing_window": 7.2,
    "substitute_risk": 5.8,
    "competition_risk": 5.2,
    "compliance_risk": 6.4,
    "judgment_confidence": 7.6
  },
  "sensitivity_analysis": {
    "most_sensitive_dimensions": ["acquisition_feasibility", "payer_clarity", "substitute_risk"],
    "downside_case_score": 6.4,
    "expected_case_score": 8.1,
    "upside_case_score": 8.7,
    "rank_range": [1, 4]
  },
  "recommendation": "值得快速验证",
  "rationale": "该方向痛点明确、切入版本较轻、评论和竞品缺口相关判断一致，但存在健康数据和老年用户使用门槛。"
}
```

推荐档位建议：

| 档位 | 含义 |
|------|------|
| `strong_candidate` | 证据、买单方、切入版本和验证路径都较清晰，建议优先验证 |
| `quick_validation` | 方向有潜力，但关键假设需要低成本快速验证 |
| `watchlist` | 趋势或需求存在，但证据、时机或商业化不足 |
| `reject` | 反证、替代方案、合规风险或获客成本足以否定当前机会 |

## 系统模块划分

这一节是领域模型说明，不代表在 Icarus 项目中新增第二套 workflow engine。落地到 Icarus 仓库（`/Users/chelaile/IdeaProjects/icarus`）时，下面这些模块应映射为 workflow delegation、skill、host 侧 MCP 工具和少量 deterministic action。

```python
class IndustryAppOpportunityWorkflow:
    async def run(self, direction: str):
        scope = await self.frame_scope(direction)
        plan = await self.plan_research(direction, scope)
        seeds = await self.probe_research_seeds(direction, scope, plan)
        opportunity_space = await self.map_opportunity_space(direction, scope, seeds)
        discovery = await self.run_discovery_parallel(plan, seeds, opportunity_space)
        validated = await self.validate_discovery_fan_in(discovery)
        thesis = await self.synthesize_opportunity_theses(validated)
        merged = await self.merge_and_cluster(thesis)
        enrichment = await self.run_enrichment_parallel(merged)
        normalized = await self.normalize_judgment_context(enrichment)
        enriched = await self.build_scoring_context(normalized)
        ranked = await self.global_rank(enriched)
        sensitivity = await self.analyze_score_sensitivity(ranked)
        validation_plan = await self.build_validation_plan(sensitivity)
        report = await self.write_final_report(direction, validation_plan)
        return report
```

### Scope Framer

负责把宽泛输入转成明确的研究边界和默认假设：

```python
class ScopeFramer:
    async def frame(self, direction: str, user_constraints: dict | None) -> ScopeFrame:
        ...
```

输出包括：

- 目标市场、地区、语言和平台。
- 商业模式偏好和是否必须是 App。
- 团队能力、预算和验证周期。
- 风险偏好和行业限制。
- 默认 assumptions 和 open questions。

### Planner

负责将输入方向转成研究计划：

```python
class ResearchPlanner:
    async def plan(self, direction: str, scope: ScopeFrame) -> ResearchPlan:
        ...
```

输出包括：

- 启用哪些 lane。
- 每条 lane 的搜索关键词。
- 每条 lane 的数据源优先级。
- 每条 lane 的 topN 数量。
- 是否需要行业特定维度。
- 好机会判定标准、kill gate 规则、评分权重和敏感性分析参数。

### Seed Probe

负责在 discovery lane 并行前做轻量调研种子探测。这里的 seed 是“后续调研的起点”，不是最终结论，也不是要求所有 lane 都围绕已有产品展开。

`seed_probe` 产出多类 seed：

```json
{
  "audience_seeds": ["新手宠物主", "高龄宠物家庭", "多宠家庭"],
  "scenario_seeds": ["慢病管理", "走失寻回", "行为训练", "临终照护"],
  "problem_seeds": ["用药提醒不可靠", "夜间急诊信息不足", "家庭成员协同困难"],
  "keyword_seeds": ["宠物用药提醒", "猫咪应激", "宠物走失怎么办"],
  "product_seeds": ["宠物健康 App", "宠物社区 App", "宠物电商 App"],
  "source_seeds": ["App Store", "Google Play", "小红书", "知乎", "Reddit", "宠物论坛"]
}
```

### Opportunity Space Mapper

负责在 discovery 并行前建立粗粒度机会空间地图，避免所有研究都围绕现有产品或搜索热词展开：

```python
class OpportunitySpaceMapper:
    async def map(
        self,
        direction: str,
        scope: ScopeFrame,
        seed_context: SeedProbe,
    ) -> OpportunitySpaceMap:
        ...
```

输出包括：

- 用户角色和买单角色。
- 高频任务和 JTBD。
- 当前替代方案、workaround 和非 App 竞争。
- 工作流摩擦点和可软件化节点。
- 初始机会 thesis 假设和待推翻问题。

依赖规则：

- `product_seed` 主要供 `top_products`、`review_mining`、`competitor_gap` 等产品相关 lane 使用。
- `audience_pain`、`search_demand`、`trend_change` 不应依赖 `product_seed` 才能启动，它们可以从用户心智、搜索问题、社区讨论、政策和技术变化中发现尚未被产品充分覆盖的需求。
- 已有产品在非产品 lane 中更多是 coverage gap 的佐证，而不一定是机会来源。
- 如果 `product_seed` 不足，产品相关 lane 应继续做产品发现或返回 `insufficient_evidence`，不能用猜测产品列表支撑正式结论。

### Discovery Lane

每个调研维度实现统一接口：

```python
class DiscoveryLane:
    name: str

    async def collect_and_record_evidence(
        self,
        direction: str,
        plan: LanePlan,
        seed_context: SeedProbe,
        opportunity_space: OpportunitySpaceMap,
    ) -> list[EvidenceRef]:
        ...

    async def extract_claims(self, evidence_refs: list[EvidenceRef]) -> list[Claim]:
        ...

    async def synthesize_findings(self, claims: list[Claim]) -> list[Finding]:
        ...

    async def synthesize_insights(self, findings: list[Finding]) -> list[Insight]:
        ...

    async def generate_opportunities(self, insights: list[Insight]) -> list[Opportunity]:
        ...

    async def score_opportunities(self, opportunities: list[Opportunity]) -> list[LaneScoredOpportunity]:
        ...

    async def pre_kill_opportunities(self, opportunities: list[Opportunity]) -> list[PreKillDecision]:
        ...
```

每个 Discovery Lane 必须输出支持 claims、反对 claims、uncertainties 和 kill conditions。反证强或关键字段缺失的机会应被降级，不应进入 topN。

### Opportunity Thesis Synthesizer

负责把 lane 产出的候选机会转成可验证的 opportunity thesis：

```python
class OpportunityThesisSynthesizer:
    async def synthesize(self, lane_results: list[LaneResult]) -> list[OpportunityThesis]:
        ...
```

每个 thesis 必须包含 `user`、`job_to_be_done`、`pain`、`current_alternatives`、`gap`、`buyer`、`payer`、`entry_wedge`、`why_now`、`distribution_path`、`kill_criteria` 和 `validation_hypotheses`。

### OpportunityClusterer

负责跨 lane 去重、聚类、合并：

```python
class OpportunityClusterer:
    async def merge(self, theses: list[OpportunityThesis]) -> list[MergedOpportunity]:
        ...
```

### JudgmentEnricher

负责对合并后的机会做并行补充验证，并把新增材料提炼为 claim、finding、insight 和 score input。落地时它对应 `enrichment_parallel` state，而不是单个串行服务：

```python
class JudgmentEnricher:
    async def run_parallel(self, opportunities: list[MergedOpportunity]) -> EnrichmentFanIn:
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
- 可行性和早期单位经济

### GlobalRanker

负责全局评分和排序：

```python
class GlobalRanker:
    async def rank(self, opportunities: list[EnrichedOpportunity]) -> list[RankedOpportunity]:
        ...
```

### Sensitivity Analyzer

负责判断排名对权重、证据置信度和关键假设变化是否稳定：

```python
class SensitivityAnalyzer:
    async def analyze(self, ranked: list[RankedOpportunity]) -> list[RankedOpportunityWithSensitivity]:
        ...
```

输出包括 `downside_case_score`、`expected_case_score`、`upside_case_score`、`rank_range`、`rank_stability` 和 `most_sensitive_dimensions`。

### Validation Planner

负责把推荐机会转成可执行的验证计划：

```python
class ValidationPlanner:
    async def plan(self, ranked: list[RankedOpportunityWithSensitivity]) -> ValidationPlan:
        ...
```

每个机会至少包含 7 天验证动作、30 天 MVP、访谈对象、落地页或原型测试方式、成功阈值、失败阈值和最关键待验证假设。

### Reporter

负责最终报告生成：

```python
class OpportunityReporter:
    async def write(self, direction: str, validation_plan: ValidationPlan) -> str:
        ...
```

报告结构建议：

```text
# 行业 App 创业机会调研报告

## 结论摘要
## Scope Assumptions
## 排名总览
## 研究方法
## Top 机会详解
  - 机会 thesis
  - 目标用户、买单方、付费方和决策者
  - JTBD 和当前工作流
  - 核心痛点
  - 当前替代方案和非 App 竞争
  - 切入楔子、beachhead segment 和 why now
  - 关键判断依据
  - 竞品覆盖和满意度缺口
  - 商业模式
  - 获客路径
  - 切入版本建议
  - 综合评分、推荐档位、敏感性分析和排名稳定性
  - 风险和反证
  - kill criteria
  - 7 天验证动作和 30 天 MVP 建议
## 被筛掉的机会
## 观察池机会
## 不确定性、关键假设和后续验证建议
## 审计追踪和参考来源
```

最终报告的正文应围绕创业判断展开，避免按证据逐条综述。原始 evidence 只通过 traceability、附录、脚注或审计追踪出现；正文主要使用 opportunity thesis、insight、score breakdown、risk、counter evidence、sensitivity analysis 和 validation plan 等结构化结果。报告必须允许给出“不建议做独立 App，建议从服务、插件、小程序或人工验证切入”的结论。

## Icarus 落地设计

### 已确认的 Icarus 架构边界

Icarus 项目（`/Users/chelaile/IdeaProjects/icarus`）已经有完整 workflow 编排层，不需要再做一个独立的 Opportunity workflow engine；但需要把 workflow runtime 从“单状态单委派”升级为能表达并行研究图：

- workflow definition 位于 `/Users/chelaile/IdeaProjects/icarus/container/workflow-definitions/*.json`，由 `/Users/chelaile/IdeaProjects/icarus/src/workflow.ts` 驱动。
- workflow state 类型在 `/Users/chelaile/IdeaProjects/icarus/src/workflow-definition.ts` 中固定为 `delegation`、`system`、`interrupt`、`terminal`。
- delegation 会构建 handoff contract，委派给 container agent 执行 skill，并要求通过 `complete_delegation` 回传结构化结果。
- action registry 在 `/Users/chelaile/IdeaProjects/icarus/src/workflow-actions/registry.ts` 中，目前 action handler 是同步 `run(input): WorkflowActionResult`，适合 deterministic 系统操作，不适合隐藏 LLM 推理。
- 现有 workflow delegation、handoff contract、context pack、artifact contract 和 MCP/IPC 分发链路已经提供了可复用的参考实现。
- container agent 的 allowed tools 已包含 `WebSearch`、`WebFetch` 和 `mcp__icarus__*`。在本方案中，agent/skill 负责研究意图、来源选择、claim/finding/insight 提炼和业务判断；host MCP tool 负责可审计的数据获取、归一化、写盘和 evidence record；通用 WebSearch/WebFetch 可以作为探索补充，但不替代领域 MCP 工具和 evidence store。

需要新增的通用能力：

- workflow definition state 新增 `parallel` 类型。
- workflow runtime 支持一个 parallel state 下创建多个 branch delegation。
- 每个 branch 有独立 handoff、context pack、artifact contract、evaluator、retry 和执行结果。
- 主 workflow 停留在 parallel state，直到 join policy 满足后才 fan-in 到下一状态。
- workbench、Trace、checkpoint、pause/cancel/resume 都能感知 parallel run。

因此，该设计方案在 Icarus 中的正确形态是：

```text
Icarus workflow = 唯一编排层
  delegation state = LLM 推理、规划、抽取、综合、报告
  parallel state = 多 branch delegation/fan-in
  skill = 每类 agent 节点的执行规约
  host MCP tool = 可审计、可复用、确定性的领域工具
  workflow action = context/schema/score/validate 等非 LLM 系统动作
  artifact contract + evaluator = 每阶段质量门
```

### Parallel Runtime 设计

新增 state 类型：

```ts
type WorkflowDefinitionState =
  | WorkflowDefinitionDelegationState
  | WorkflowDefinitionParallelState
  | WorkflowDefinitionInterruptState
  | WorkflowDefinitionTerminalState
  | WorkflowDefinitionSystemState;
```

`parallel` state 建议结构：

```json
{
  "type": "parallel",
  "label": "多维度机会发现",
  "max_concurrency": 6,
  "join_policy": {
    "type": "all_completed",
    "min_success": 5,
    "allow_failed_branches": true
  },
  "branches": [
    {
      "key": "audience_pain",
      "label": "受众需求痛点",
      "delegate": {
        "role": "audience_pain_researcher",
        "skill": "opportunity-audience-pain-recon",
        "task_template": "..."
      },
      "artifact_contract": {
        "ref": "startup_opportunity.discovery_lane_result.v1"
      },
      "evaluator": {
        "ref": "startup_opportunity.discovery_lane_result.v1"
      },
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
  ],
  "on_join": {
    "success": { "target": "lane_result_validate" },
    "partial": { "target": "quality_review" },
    "failure": { "target": "quality_review" }
  }
}
```

持久化建议：

```text
workflows
  - current_delegation_id         legacy / non-parallel active delegation
  - current_parallel_run_id       active parallel run

workflow_parallel_runs
  - id
  - workflow_id
  - state_key
  - status                       running | joining | completed | failed | cancelled | paused
  - join_policy_json
  - fan_in_context_json
  - created_at
  - updated_at

workflow_parallel_branches
  - id
  - run_id
  - workflow_id
  - state_key
  - branch_key
  - branch_label
  - delegation_id
  - status                       pending | running | completed | failed | needs_revision | cancelled | skipped
  - attempt
  - result_json
  - evaluation_id
  - artifact_refs_json
  - error
  - created_at
  - updated_at
```

运行时规则：

- 进入 `parallel` state 时创建 `workflow_parallel_run` 和所有 branch 记录。
- 根据 `max_concurrency` 创建或调度 branch delegation。
- branch delegation 完成后只更新 branch 状态和 branch evaluation，不推进主 workflow。
- 每个 branch 仍走现有 handoff contract、artifact contract、quality gate 和 llm judge sidecar。
- parallel state 定期或在 branch 完成事件中检查 join policy。
- join policy 满足时写入 fan-in context，例如 branch results、artifact refs、evaluation summary、failed branches 和 limitations。
- fan-in 后主 workflow 应通过 `on_join.success`、`on_join.partial` 或 `on_join.failure` 转移。
- pause/cancel/resume 应作用于 run 下所有 active branch。
- retry 应支持 branch 级 retry，不能重跑整个 parallel state，除非 workflow definition 明确配置。
- checkpoint 应记录 parallel run id、branch attempts 和 fan-in context hash。

join policy 建议：

| Policy | 含义 |
|--------|------|
| `all_completed` | 所有 branch 到达 completed/failed/cancelled 终态后 join |
| `all_success` | 所有 branch 必须成功，否则 failure |
| `min_success` | 成功 branch 数达到阈值即可 success 或 partial |
| `required_branches` | 指定 branch 必须成功，其他 branch 可失败但进入 limitations |
| `best_effort` | 所有可运行 branch 完成后 join，失败 branch 进入不确定性 |

工作台展示要求：

- parallel state 在任务时间线中显示为一个阶段。
- 阶段内展示 branch 列表、状态、delegation、artifact、evaluation、retry 次数。
- 用户可以对单个 branch retry，也可以对整个 parallel state retry。
- failed/pending branch 必须进入最终报告的 limitations 或 open questions。

### Parallel Research Kernel

为了吸收 GPT Researcher deep 的优势，Icarus 应抽象一个可被 lane skill 调用的研究内核。它不是顶层业务编排器，而是一组可复用流程规范和工具组合。

推荐 Research Kernel：

```text
initial_probe
  -> search initial query
  -> read top sources
  -> summarize initial context
  -> generate queries with research goals
  -> parallel search/fetch
  -> evidence record
  -> extract claims with evidence refs
  -> synthesize findings
  -> synthesize insights
  -> generate follow-up questions
  -> bounded recursive research
  -> source manifest curation
  -> structured judgment context
```

关键约束：

- query 必须带 `research_goal`，避免只有关键词。
- 每轮研究必须记录 `source_url`、`source_title`、`retrieved_at`、`query`、`research_goal`。
- 原始 evidence 只进入 evidence store；后续 context pack 默认只放 claim、finding、insight 和 evidence refs，不放 `raw_text`。
- claim、finding、insight 必须保留 evidence refs，方便审计和置信度校验。
- 递归追问必须有 `depth`、`breadth`、`max_sources`、`max_tokens`、`stop_conditions`。
- 无可用来源时应显式返回 `insufficient_evidence`，不能生成貌似确定的结论。
- Research Kernel 产物不是最终报告，也不是证据综述，而是 lane extraction 使用的结构化判断上下文。

Research Kernel 可以参考 GPT Researcher 的以下流程，但不直接成为业务入口：

- initial search 后再生成 sub-queries。
- 每个 query 带 research goal。
- breadth/depth 递归。
- 并发执行多个 query。
- 抓取后写入 evidence store。
- synthesis 前做 source manifest curation。
- report writer 基于 curated judgment context，而不是基于原始证据片段。
- 无资料时 abstain。

### 不单独做 Opportunity Service

术语上，`Opportunity service` 应改名为 `opportunity-recon host toolkit` 或 `opportunity-recon domain module`，避免误解。

它不应该是第二个线程服务或第二个编排器，而是在 Icarus 仓库内新增一个 host 侧领域工具模块，类似现有 `/Users/chelaile/IdeaProjects/icarus/src/app-recon/*`：

```text
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/types.ts
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/evidence-store.ts
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/report-writer.ts
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/request-dispatcher.ts
/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/research-kernel.ts
```

职责只包括：

- 创建调研 session。
- 记录搜索结果、网页、榜单、评论等 raw evidence。
- 记录 claim、finding、insight 与 evidence refs 的映射关系。
- 校验 evidence ref 是否存在。
- 写入 JSON/Markdown 产物。
- 调用确定性外部 API，例如 App Store lookup、榜单 API、评论 API、趋势 API。
- 做确定性归一化、去重、评分公式计算。
- 提供 Research Kernel 所需的 batch search、fetch、source manifest 和 traceability 工具接口。

它不负责：

- 决定 workflow 下一步。
- 自己规划 lane。
- 隐藏 LLM 调用。
- 直接生成最终创业结论。

### Startup Opportunity Workflow 定义

新增 workflow definition：

```text
/Users/chelaile/IdeaProjects/icarus/container/workflow-definitions/startup_opportunity_research.json
```

建议 roles：

```text
opportunity_planner
opportunity_seed_researcher
audience_pain_researcher
top_products_researcher
review_mining_researcher
search_demand_researcher
trend_researcher
competitor_gap_researcher
market_size_researcher
monetization_researcher
acquisition_researcher
compliance_risk_researcher
counter_evidence_researcher
opportunity_synthesizer
opportunity_reviewer
opportunity_reporter
```

建议 artifacts：

```text
research-plan.json
seed-probe.json
audience-pain-lane.json
top-products-lane.json
review-mining-lane.json
search-demand-lane.json
trend-lane.json
discovery-fan-in.json
merged-opportunities.json
competitor-gap-enrichment.json
market-size-enrichment.json
monetization-enrichment.json
acquisition-enrichment.json
compliance-risk-enrichment.json
counter-evidence-enrichment.json
enrichment-fan-in.json
normalized-judgment-context.json
ranking.json
ranking-rationale.json
startup-opportunity-report.md
traceability.json
```

建议 workflow states：

```text
research_plan              delegation  LLM 规划 lane、关键词、数据源、topN、评分权重、Research Kernel 参数
seed_probe                 delegation  轻量探测用户、场景、问题、关键词、产品和数据源 seed
discovery_parallel         parallel    基于多类 seed 的 discovery lane 并行调研、判断提炼、维度内筛选
lane_result_validate       system      schema、evidence ref、判断层必填字段、topN 数量校验
opportunity_merge          delegation  语义合并、拆分判断、判断依据聚合
enrichment_parallel        parallel    竞品、市场、商业化、获客、合规、反证并行补充检索
judgment_context_normalize system      URL/source/product/evidence ref/claim/finding/insight 归一化和 deterministic dedupe
global_score               system      确定性评分公式、排序、阈值过滤
ranking_rationale          delegation  基于结构化分数生成排名解释
quality_review             delegation  审核判断链、反证、评分解释是否一致
final_report               delegation  输出 Markdown 报告、JSON 报告和 traceability
done                       terminal
```

`discovery_parallel` branches：

```text
audience_pain       受众需求痛点
top_products        已有产品 Top 排名挖掘
review_mining       用户评论与差评挖掘
search_demand       搜索需求与内容缺口
trend_change        趋势变化
```

`seed_probe` 不应把业务流程变成产品中心调研。`product_seed` 只作为产品相关 branch 的输入；非产品 branch 仍可独立从用户心智、搜索需求、社区讨论和趋势变化中发现尚未被现有产品覆盖的强需求。后续的产品覆盖分析用于验证 coverage gap，而不是要求所有机会都来自已有产品缺口。

`enrichment_parallel` branches：

```text
competitor_gap      竞品覆盖、满意度、迁移阻力
market_size         市场空间、增长、用户规模
monetization        定价、付费意愿、商业模式
acquisition         SEO、社区、渠道、平台获客
compliance_risk     政策、医疗、金融、隐私、平台风险
counter_evidence    反证、替代方案、失败案例
```

这两个并行阶段都必须作为 workflow runtime 的 `parallel` state 表达，而不是用单个 agent 节点内部的子任务代替。内部子任务可以作为 agent 自己的执行优化，但不能替代 workflow 层对 branch 状态、产物和评测的可观测性。

### Skill 设计

新增 skills：

```text
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-research-plan/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-seed-probe/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-audience-pain-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-top-products-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-review-mining-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-search-demand-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-trend-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-merge-synthesis/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-competitor-gap-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-market-size-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-monetization-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-acquisition-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-compliance-risk-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-counter-evidence/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-ranking-rationale/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-quality-review/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-report-writer/SKILL.md
```

并在 `/Users/chelaile/IdeaProjects/icarus/container/skills/skills.json` 中新增 web role 映射，例如：

```json
{
  "web_opportunity_planner": [
    "opportunity-research-plan",
    "opportunity-seed-probe"
  ],
  "web_opportunity_research": [
    "opportunity-audience-pain-recon",
    "opportunity-top-products-recon",
    "opportunity-review-mining-recon",
    "opportunity-search-demand-recon",
    "opportunity-trend-recon"
  ],
  "web_opportunity_enrichment": [
    "opportunity-competitor-gap-recon",
    "opportunity-market-size-recon",
    "opportunity-monetization-recon",
    "opportunity-acquisition-recon",
    "opportunity-compliance-risk-recon",
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

branch skill 的职责划分：

| Branch | Skill | 核心职责 |
|--------|-------|----------|
| `research_plan` | `opportunity-research-plan` | 生成 lane 计划、query goals、数据源优先级、Research Kernel 参数和评分权重 |
| `seed_probe` | `opportunity-seed-probe` | 轻量探测用户、场景、问题、关键词、产品和数据源 seed；不把所有 lane 绑定到已有产品 |
| `audience_pain` | `opportunity-audience-pain-recon` | 从人群、场景、社区讨论和评论中挖掘痛点与候选机会 |
| `top_products` | `opportunity-top-products-recon` | 基于 `product_seed` 扩展头部产品、定位、功能覆盖、商业模式和覆盖缺口 |
| `review_mining` | `opportunity-review-mining-recon` | 基于 `product_seed` 抓取低星评论、功能请求、投诉并提取未满足需求 |
| `search_demand` | `opportunity-search-demand-recon` | 从搜索需求、问答和内容缺口中识别工具化机会 |
| `trend_change` | `opportunity-trend-recon` | 从政策、技术、平台和消费变化中识别新窗口 |
| `competitor_gap` | `opportunity-competitor-gap-recon` | 对合并机会验证竞品覆盖、满意度、迁移阻力和差异化空间 |
| `market_size` | `opportunity-market-size-recon` | 补充市场规模、增长、目标用户规模和消费能力相关判断 |
| `monetization` | `opportunity-monetization-recon` | 验证付费意愿、定价、订阅、交易抽佣或 B2B 变现路径 |
| `acquisition` | `opportunity-acquisition-recon` | 验证 SEO、社区、平台、内容和合作获客路径 |
| `compliance_risk` | `opportunity-compliance-risk-recon` | 识别政策、医疗、金融、隐私、平台规则等风险 |
| `counter_evidence` | `opportunity-counter-evidence` | 查找替代方案、失败案例、需求被高估证据和反方观点 |

每个 skill 必须要求：

- 读取 Context Pack。
- 使用 handoff contract 中的输入和成功标准。
- 所有业务结论写成结构化 artifact。
- evidence 引用必须可追踪，但 artifact 面向下游的主体内容应是 claim、finding、insight、opportunity 和 score input，不应携带原始 evidence 正文作为生成语料。
- 无论成功/失败都调用 `complete_delegation`。
- result 至少包含 `verdict`、`summary`、`claims`、`findings`、`insights`、`audit_refs`。

这与现有 delegation skill 通过结构化 handoff 返回结果的模式一致。

### MCP 工具与 action 的边界

搜索、抓取、API 调用不应按工具形态一刀切。判断标准不是“是否联网”，而是“谁负责研究判断，谁负责可审计系统操作”。

agent delegation 负责：

- 决定查什么、为什么查、下一轮追问什么。
- 给每个 query 明确 `research_goal`。
- 判断哪些来源值得阅读和引用。
- 从来源中提炼 claim、finding、insight，再基于判断层生成痛点、功能缺口、反证和机会。
- 对语义相近机会做合并/拆分判断。
- 在 evidence 不足时显式降置信度或返回 `insufficient_evidence`。

host MCP tool 负责：

- `opportunity_create_session`
- `opportunity_record_evidence`
- `opportunity_write_claims`
- `opportunity_write_report`
- `opportunity_search_batch`
- `opportunity_fetch_url_batch`
- `opportunity_app_store_lookup`
- `opportunity_google_play_lookup`
- `opportunity_collect_reviews`
- `opportunity_normalize_product`
- `opportunity_canonicalize_source`
- `opportunity_get_evidence_manifest`

host MCP tool 可以执行联网 search/fetch/API 调用，但它的职责是按 agent 给出的 query、URL、source type 和 research goal 执行可审计数据获取，并把结果写成 evidence record。它不负责决定行业机会、筛选候选方向或生成最终结论。

这些工具通过 `/Users/chelaile/IdeaProjects/icarus/container/agent-runner/src/ipc-mcp-stdio.ts` 暴露，再通过 `/Users/chelaile/IdeaProjects/icarus/src/ipc.ts` 分发到 `/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/request-dispatcher.ts`。通用 `WebSearch`/`WebFetch` 仍可用于探索性补充，但原始来源进入正式判断前必须经 host MCP tool 记录到 evidence store。正式 artifact 中只保留 evidence refs、source manifest、provenance、limitations 和判断层产物，不携带原始证据正文作为下游生成语料。

适合 workflow action 的：

- `context.set`、`context.require` 这类已有上下文操作。
- branch artifact schema validation。
- evidence ref validation 和 source manifest 校验。
- deterministic dedupe，例如 URL canonicalization、product id 归一化。
- deterministic global scoring。
- join policy 检查后的 fan-in context patch。
- 阈值过滤、状态路由和 retry 决策。

不适合 workflow action 的：

- LLM lane planning。
- LLM 信息抽取。
- LLM 机会合并判断。
- LLM 排名理由生成。
- LLM 报告生成。

如果需要 action 支持异步，应把 `WorkflowActionHandler.run` 扩展为允许 `Promise<WorkflowActionResult>`，并让 `runWorkflowActionSteps` await。这个扩展只用于长耗时 deterministic 操作、数据归一化、评分或 fan-in 状态管理，不用于把 LLM 调用、开放式调研或 GPT Researcher deep 流程塞进 action。

### Artifact Contract 与 Evaluator

新增 artifact contracts：

```text
startup_opportunity.plan.v1
startup_opportunity.seed_probe.v1
startup_opportunity.discovery_lane_result.v1
startup_opportunity.discovery_fan_in.v1
startup_opportunity.merge.v1
startup_opportunity.enrichment_branch_result.v1
startup_opportunity.enrichment_fan_in.v1
startup_opportunity.ranking.v1
startup_opportunity.report.v1
startup_opportunity.traceability.v1
```

放在：

```text
/Users/chelaile/IdeaProjects/icarus/container/artifact-contracts/startup-opportunity.json
```

新增 evaluator：

```text
/Users/chelaile/IdeaProjects/icarus/container/workflow-evaluators/startup-opportunity.json
```

branch-level contract 用于约束单个并行分支的输出；fan-in contract 用于约束 join 后给下游 state 的聚合上下文。

`seed_probe.v1` 必须产出：

```text
startup_opportunity.seed_probe.v1
  - audience_seeds
  - scenario_seeds
  - problem_seeds
  - keyword_seeds
  - product_seeds
  - source_seeds
  - seed_evidence_refs
  - limitations
```

`discovery_parallel` 的每个 branch 必须产出：

```text
startup_opportunity.discovery_lane_result.v1
  - branch_key
  - research_goals
  - queries
  - evidence_refs
  - claims
  - findings
  - insights
  - candidate_opportunities
  - scored_opportunities
  - top_opportunities
  - insufficient_evidence
  - audit_refs
  - limitations
```

`discovery_fan_in.v1` 必须包含：

```text
branch_results
branch_evaluation_summary
failed_or_partial_branches
all_top_opportunities
judgment_context
source_manifest
audit_refs
limitations
```

`enrichment_parallel` 的每个 branch 必须产出：

```text
startup_opportunity.enrichment_branch_result.v1
  - branch_key
  - opportunity_refs
  - evidence_refs
  - claims
  - findings
  - insights
  - counter_claims
  - score_inputs
  - confidence
  - audit_refs
  - limitations
```

`enrichment_fan_in.v1` 必须包含：

```text
opportunity_enrichment_matrix
judgment_context
source_manifest
counter_evidence_summary
score_inputs_by_opportunity
failed_or_partial_branches
audit_refs
limitations
```

示例 branch 配置：

```json
{
  "artifact_contract": { "ref": "startup_opportunity.discovery_lane_result.v1" },
  "evaluator": { "ref": "startup_opportunity.discovery_lane_result.v1" },
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
  "platform": ["Mobile", "Web"],
  "language": "zh-CN",
  "target_rank_count": 10,
  "lane_top_n": 8,
  "constraints": ["不做医疗诊断", "优先 ToC 订阅或交易撮合"]
}
```

Icarus 的 `WorkflowContext` 是 `Record<string, unknown>`，`createNewWorkflow` 会 merge `opts.context`，template rendering 也支持从 context 中取值。因此可以通过 `context.direction` 等字段进入 workflow template；如果前端创建表单要更友好，再扩展 `create_form` 字段配置。

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
  -> delegation: seed_probe skill
  -> parallel: discovery branch delegations
  -> system/action: discovery fan-in validation
  -> delegation: opportunity merge
  -> parallel: enrichment branch delegations
  -> system/action: judgment context normalization + deterministic scoring
  -> delegation: ranking rationale
  -> delegation: quality review
  -> delegation: final report
  -> artifact contract + evaluator + quality gate
  -> final report artifacts
```

这种结构既满足“并行 lane 是 workflow runtime 一等状态”的架构要求，也保留了 Icarus 当前 host/container/MCP/skill 的职责边界。

## GPT Researcher 项目关系

GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）在本方案中是流程参考，不是黑盒依赖，也不是创业机会 workflow 的主业务入口。需要重点参考的是它为什么能生成更高质量 deep research，而不是直接调用它生成最终报告。

应参考的流程机制：

- initial search before query planning：先做初始检索和上下文探测，再生成更有目标的 sub-queries。
- query + research goal：每个 query 都带明确研究目标，而不是只有关键词。
- breadth/depth recursion：用可配置 breadth/depth 做递归追问，并有停止条件。
- concurrent sub-research：多个子问题并发执行，最后聚合上下文。
- context compression with citations：压缩上下文时保留 evidence refs，不丢审计追踪。
- source curation before synthesis：综合前先筛选来源质量、去重和记录 limitations。
- abstain on no evidence：证据不足时明确拒绝确定性结论。

但不建议直接把以下接口作为主业务入口：

```python
researcher = GPTResearcher(query=direction, report_type="deep")
await researcher.conduct_research()
report = await researcher.write_report()
```

原因：

- `deep` 的目标是围绕一个 query 做递归研究，不负责多 lane 机会挖掘。
- `write_report()` 生成的是自然语言报告，不负责结构化评分和排序。
- 创业机会判断需要固定 schema、权重、可审计判断链和反证逻辑。
- 不同 lane 的筛选规则不同，不能交给通用报告 prompt 隐式完成。

在 Icarus 中，推荐把这些机制沉淀为 `Parallel Research Kernel`：

```text
Research Kernel
  -> 接收 branch 的 research goals、query seeds、source preferences 和 bounds
  -> 由 agent 控制 query expansion、source selection、follow-up 判断
  -> 通过 host MCP tool 执行 batch search/fetch/source record
  -> 输出 structured judgment context，而不是最终业务报告或证据综述
```

如果确实复用 GPT Researcher 的某些底层实现，也应限制在 Research Kernel 的内部实现细节，例如 search adapter、scraper adapter、context compressor 或 source curation helper。复用边界必须满足：

- 不让 GPT Researcher 决定创业机会 schema、评分或排序。
- 不让 GPT Researcher report writer 直接产出最终业务报告。
- 所有来源必须进入 Icarus evidence store。
- 所有 branch 输出必须通过 Icarus artifact contract 和 evaluator。

创业机会调研 workflow 自己控制候选机会生成、合并、反证、评分、排序和最终报告。

## 完整方案范围

本方案描述完整目标形态，不按 MVP 或先后顺序拆范围。完整方案包含两层范围。

架构层范围：

- workflow definition 支持 `parallel` state。
- runtime 支持 branch delegation、branch retry、join policy、fan-in context 和 checkpoint。
- workbench/trace 能展示 parallel run、branch 状态、artifact、evaluation 和 limitations。
- workflow action 支持必要的异步 deterministic 操作，但不承载 LLM 调研。
- host MCP tool/evidence store 支持可审计 search/fetch/API 数据记录。
- Research Kernel 支持 query goal、并行检索、上下文压缩、递归追问、source curation 和 insufficient evidence。

业务 workflow 范围：

- `research_plan` 规划完整 discovery/enrichment research plan。
- `seed_probe` 探测多类调研 seed，包括用户、场景、问题、关键词、产品和数据源；其中 `product_seed` 只作为产品相关 branch 的输入。
- `discovery_parallel` 覆盖 5 条发现 branch：
  - 受众需求痛点。
  - 已有产品 Top 排名挖掘。
  - 用户评论与差评挖掘。
  - 搜索需求与内容缺口。
  - 趋势变化。
- `opportunity_merge` 对 discovery topN 做语义聚类、拆分和判断依据合并。
- `enrichment_parallel` 覆盖 6 条补充验证 branch：
  - 竞品缺口。
  - 市场空间。
  - 商业化。
  - 获客路径。
  - 合规和平台风险。
  - 反证与替代方案。
- `global_score` 使用确定性公式计算综合评分和排序。
- `quality_review` 审核判断链、反证、评分解释、limitations 和报告一致性。
- `final_report` 输出 JSON、Markdown 和 traceability artifact。

最终输出 top 10 创业机会，每个机会包含：

- 标题和一句话定义
- 目标用户
- 关键痛点
- 机会来源 lane
- 关键判断依据
- 竞品缺口
- 综合评分
- 切入版本建议
- 主要风险

### 完整 Workflow

```text
direction
  -> research_plan
  -> seed_probe
  -> discovery_parallel
      -> audience_pain
      -> top_products
      -> review_mining
      -> search_demand
      -> trend_change
  -> lane_result_validate
  -> opportunity_merge
  -> enrichment_parallel
      -> competitor_gap
      -> market_size
      -> monetization
      -> acquisition
      -> compliance_risk
      -> counter_evidence
  -> judgment_context_normalize
  -> global_score
  -> ranking_rationale
  -> quality_review
  -> final_report
  -> done
```

### 可配置扩展点

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
- LLM 提取痛点和机会时可能过度概括，需要 schema、evidence ref 和判断链校验约束。
- 排名不能只看高分，也要看判断置信度和反证。
- 不同行业的权重应允许配置，例如医疗健康类应提高合规风险权重。
- 最终报告应明确不确定性，避免把研究结论包装成确定性商业建议。

## 结论

行业 App 创业机会 Agent 应定位为：

```text
multi-lane opportunity mining
  + structured evaluation
  + judgment-backed ranking
  + decision-oriented reporting
```

该 Agent 服务应借鉴 GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）的初始探测、query goal、并发子研究、递归追问、上下文压缩、来源筛选和证据不足时 abstain 等流程机制，并在 Icarus 项目（`/Users/chelaile/IdeaProjects/icarus`）中沉淀为 Research Kernel。主流程应落在 Icarus 的 workflow、parallel state、delegation、skill、MCP tool、artifact contract 和 evaluator 体系内。候选机会应来自多条调研维度提炼出的 claim、finding 和 insight，每条维度先独立筛选 topN，再通过聚类、补充检索、反证调查和综合评分生成最终创业方向排名。
