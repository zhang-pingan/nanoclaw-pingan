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
- 从真实用户语言中识别尚未被现有产品占稳的 mental positioning，而不是只生成产品功能或品类名称。
- 候选机会必须来自明确调研维度提炼出的 claim、finding 和 insight，而不是先验生成。
- 候选机会必须建模为可被验证或推翻的 opportunity thesis，而不是只有方向标题和摘要。
- 每条调研维度独立、可并行地完成证据留痕、判断提炼、机会提取和维度内筛选。
- 每条调研维度都必须输出支持判断、反对判断、不确定性和 kill conditions，避免只做正向论证。
- 每个候选机会必须说明用户会在什么入口场景、带着哪句自然语言触发使用，以及现有解法为什么在该场景失效。
- 如果机会依赖 AI/LLM 能力，必须先与通用 LLM + prompt-only baseline 比较，判断真实差距和模型升级风险。
- 每个候选机会必须判断核心价值位于 output、workflow 还是 outcome 层，避免把一次性输出误判为创业机会。
- 每个候选机会必须区分用户触发语言和买单方购买语言，验证使用动机能否转化为预算、ROI 或风险降低。
- 对依赖持续指导、协作、个性化或自动化的机会，必须建模用户状态、上下文连续性和可沉淀的数据闭环。
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
- 不把 `AI Tutor`、`智能助手`、`错题本`、`社区`、`SaaS` 这类功能词或品类词直接当作机会定位；它们必须回到用户自然语言和入口场景中验证。
- 不把基础 LLM 能力、prompt 技巧或单次生成结果直接当作护城河；必须证明产品价值超出通用模型可快速复制的范围。
- 不把“用户会试用”直接等同于“买单方会购买”；购买语言、预算来源和决策标准需要单独验证。
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
用户触发语言如何翻译成买单方购买语言？
为什么现在愿意付钱或改变行为？
如何低成本触达第一批用户？
小团队能否在 4-8 周内验证核心假设？
第一个切入版本和 beachhead segment 是什么？
核心价值在 output、workflow 还是 outcome 层？
产品是否需要持续用户状态、上下文记忆或协作闭环？
如果依赖 AI/LLM，通用 LLM + prompt-only 是否已经足够解决？
能力本身是否会被模型升级、平台内置或竞品功能更新快速商品化？
什么证据会推翻这个机会？
```

因此，候选机会不是普通摘要，而是 opportunity thesis：

```text
Opportunity = user/job/pain + current alternative + gap + buyer/payer
  + buyer language + value layer + state/context + entry wedge
  + distribution path + why now + LLM baseline/commoditization risk
  + risks + validation plan
```

没有明确买单方、买单语言、切入楔子、替代方案对比、价值层判断、AI/LLM baseline 或可验证假设的候选方向，应降级为 `watchlist` 或 `insufficient_evidence`，不能直接进入强推荐。

### 3. 心智定位不是功能，而是用户会想起你的那句话

创业机会需要找到用户脑子里已经存在、但还没有被现有产品稳固占领的 mental positioning。它不是功能名、技术名或产品品类。

错误定位：

```text
AI Tutor
智能错题本
行业工具 App
一对一助手
视频讲解
```

目标定位：

```text
用户自然语言 -> 具体入口场景 -> 当前解法失效 -> 新产品被想起
```

例如教育场景里，“AI 讲题”是功能，“辅助线想不到”才是学生会在卡住时自然说出的入口心智。通用到其他行业，也应优先寻找类似表达：

- “我每次都不知道从哪开始。”
- “现在这个流程太乱，没人知道最新状态。”
- “表格能记，但一到多人协作就崩。”
- “平台给了答案，但我还是不知道下一步怎么做。”

每个高优先级机会必须产出：

```text
mental_positioning
trigger_phrase
entry_scene
solution_failure_scene
next_action_after_failure
mental_position_occupation
```

如果一个机会只能被描述为功能，而无法被目标用户用自然语言复述为“我在 X 时会用它解决 Y”，则不能作为强推荐。

### 4. 真实用户语言先于需求总结

workflow 应先挖用户原话，再做需求抽象。不要一开始就问“用户有什么需求”，而要先问：

```text
用户反复怎么说？
这些话出现在哪些场景？
哪些话是自然语言，哪些只是产品经理词汇？
哪句话对应一个可打开产品的瞬间？
```

`user_language_mining` 的目标不是生成机会，而是形成可审计的语言材料：

- 高频自然表达。
- 原话所属人群和场景。
- 情绪强度和频率。
- 是否是用户自己的话，而不是媒体、厂商、老师、顾问或模型总结。
- 对应的 mental model：用户真正认为自己哪里卡住。

后续 opportunity thesis 必须能回连到这些自然表达，否则说明机会可能是模型概括出来的，而不是市场里已有的心智。

### 5. 找机会要看现有解法何时失效

创业机会往往不是出现在“用户完全没有解决方案”的地方，而是出现在“用户已经用了现有方案，但仍然失败”的地方。

每个高质量机会都应回答：

```text
用户当前用什么解决？
这个解法在哪个具体场景失效？
用户怎么抱怨这个失效？
失效后用户下一步去哪里？
这个 next action 是否代表迁移动机？
```

`solution_failure` 与普通竞品分析不同。普通竞品分析看竞品功能和差评；solution failure 关注：

- 答案有了，但无法完成任务。
- 工具能用，但不能处理关键边界情况。
- 流程存在，但在复盘、协作、交接或异常时断链。
- 用户继续换 App、找真人、问社区、做表格、手工补救。

如果现有解法失效后用户没有明显 next action，或者用户只是轻微抱怨但不迁移，机会优先级应降低。

### 6. 先做 LLM 能力基线，而不是假设 AI 就是机会

如果候选机会依赖 AI/LLM 能力，workflow 必须先回答：通用 LLM 加上高质量 prompt、现成插件或现有平台功能，是否已经能完成用户任务。

基线测试不是为了否定 AI 机会，而是避免把已经商品化的生成能力包装成创业方向。每个 AI 相关机会至少要产出：

```text
baseline_task
prompt_only_baseline_result
mainstream_llm_solved_level
product_required_capability
remaining_gap_after_baseline
model_upgrade_risk
```

如果通用 LLM + prompt-only 已经能以足够低成本完成核心任务，且产品没有工作流嵌入、专有数据、分发渠道、执行闭环或结果责任，机会应降级为 `watchlist` 或 `reject`。

### 7. 能力会商品化，机会要落在不可轻易复制的系统价值上

能力商品化风险不只来自 LLM。OCR、语音识别、推荐、搜索、支付、身份认证、模板生成、数据抓取、自动摘要等能力，都可能被模型升级、平台内置、开源组件、API 降价或头部产品功能更新快速抹平。

每个候选机会都应检查：

```text
核心能力是谁控制的？
这个能力是否正在快速降价或开源化？
平台或头部产品是否有强动机内置它？
用户是否只为能力本身付费，而不是为结果或流程闭环付费？
产品是否拥有专有数据、工作流嵌入、渠道、信任、合规资质或网络效应？
```

如果机会的差异化只来自“比别人多调用一次模型/接口/模板”，而没有可沉淀的系统价值，应提高 `capability_commoditization_risk` 并降低推荐档位。

### 8. 机会价值要区分 output、workflow 和 outcome

一次性输出通常最容易被替代，工作流嵌入和结果改善才更接近可创业的价值。workflow 需要判断机会主要创造哪一层价值：

```text
output value: 生成一段内容、答案、计划、摘要或建议。
workflow value: 改变任务流、协作流、审核流、交付流或决策流。
outcome value: 降低成本、提高转化、减少风险、节省时间、提升成功率。
```

强机会不一定完全没有 output value，但必须说明 output 如何进入用户真实工作流，并通过可观测指标改善 outcome。例如“生成报告”不是机会，“把报告变成审批、交付、追踪和复盘闭环，并让团队少返工”才可能是机会。

### 9. 用户状态和上下文连续性是重要机会资产

许多高质量产品不是因为单次回答更好，而是因为它长期知道用户当前状态、历史行为、约束、偏好、协作关系和待完成任务。对持续指导、自动化、协作、运营、健康、金融、教育、招聘、销售等方向，必须明确用户状态模型。

每个相关机会应产出：

```text
state_variables
context_sources
state_update_triggers
memory_retention_boundary
personalization_or_automation_logic
privacy_and_permission_boundary
```

如果一个机会可以被用户每次重新打开通用工具、复制上下文并得到相同效果，说明状态和上下文壁垒弱，评分应主要看获客、品牌、价格或服务能力，而不能把“个性化”空泛地当作壁垒。

### 10. 用户语言和买单语言必须分开验证

用户触发语言回答“什么时候会想起这个产品”，买单语言回答“为什么愿意为它付钱或批准预算”。两者经常不是同一句话。

```text
user trigger phrase: 我现在卡在哪里？
buyer purchase language: 这件事为什么值得花钱解决？
decision criteria: 买单方用什么标准判断值不值？
budget source: 预算来自哪里？
marketing bridge: 如何把用户痛点翻译成买单方认可的结果、风险或 ROI？
```

ToC、B2B、B2B2C、家庭决策、企业采购和平台生态的买单语言差异很大。机会 thesis 必须同时保留用户原话和买单方购买语言；如果只有用户喜欢但买单方无法用预算、风险、效率或收益解释购买理由，应降低 `payer_clarity` 和 `monetization`。

### 11. 输入方向必须先被约束和假设化

“宠物行业 App”这类输入过宽，不同市场、团队能力、平台约束和风险偏好会得到不同结论。正式调研前必须先做 `scope_framing`：

- 目标地区和语言，例如中国、美国、跨境市场。
- 平台形态，例如 Mobile、Web、小程序、插件、B2B SaaS。
- 商业模式偏好，例如 ToC 订阅、交易撮合、B2B、B2B2C。
- 团队能力和资源约束，例如是否能做线下运营、是否有行业资源、是否能接入供应链。
- 验证周期和预算，例如 7 天、30 天或 90 天验证。
- 风险偏好，例如是否接受医疗、金融、未成年人、隐私或平台依赖风险。
- 是否必须是纯 App；如果非 App 方案更合理，应允许报告给出“不建议做独立 App”的结论。

如果用户没有显式提供这些约束，workflow 应生成默认假设，并在最终报告和 JSON artifact 中明确记录。

### 12. 调研维度既是发现通道，也是筛选通道

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

### 13. 先维度内筛选，再跨维度综合排序

不同调研维度的判断质量和含义不同，不能在早期简单混合。每个维度先独立判断，产出本维度 topN；然后再做机会合并、判断依据聚合和全局评分。

### 14. 反证前置，而不是只在末尾复核

反证不应只在 enrichment 阶段才出现。每条 discovery lane 都必须主动寻找与本 lane 候选机会相反的证据，包括：

- 用户痛点是否只属于小众极端样本。
- 用户是否已有足够好的免费替代方案。
- 用户是否表达需求但缺乏付费意愿。
- 现有产品是否已经在快速补齐缺口。
- App 是否不是最佳交付形态。
- 合规、平台、供应链或获客成本是否足以否定机会。

lane 内筛选前必须执行 pre-kill gate。触发 kill condition 的机会可以进入附录或观察池，但不能作为正式 top opportunity 输出。

### 15. 自然复述测试是定位验证的一部分

高质量机会不仅要验证用户是否愿意试用，还要验证用户是否能自然复述产品定位。验证计划应包含 natural restatement test：

```text
用户是否会说：“我遇到 X 时会用它。”
用户是否能区分：“它不是 Y，而是帮我解决 Z。”
用户是否会用 trigger phrase 主动描述这个产品。
```

如果目标用户不能自然复述 mental positioning，或者复述成已有大厂/竞品已经占领的功能词，说明该机会的入口心智仍未成立，应降级为 `quick_validation` 或 `watchlist`。

### 16. 所有结论保留可审计判断链

每个机会方向的评分和结论都应能追溯到：

- 来自哪个调研维度。
- 使用了哪些 claim、finding 和 insight。
- 这些判断层产物背后有哪些 evidence refs。
- 机会对应哪些 user language samples 和 trigger phrases。
- 哪些现有解法失效场景支撑该机会。
- 哪些判断支持机会，哪些判断构成反证。
- 证据是否独立、是否近期、是否来自目标地区、是否存在样本偏差。
- 置信度如何。

但最终报告不应围绕 evidence ref 展开写作，也不应把原始证据片段作为主要内容。证据只在审计链、附录、traceability artifact 或必要的脚注位置出现。

### 17. 并行是 workflow 一等能力

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

### 18. Action 只做确定性系统操作

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
      -> 用户自然语言和 trigger phrase 挖掘
      -> 现有解法失效场景和 next action 挖掘
      -> claim/finding/insight 提炼
      -> 候选机会生成
      -> mental positioning 和 entry scene 识别
      -> 支持/反对 claims 和 kill conditions
      -> 维度内评分
      -> pre-kill gate
      -> 维度内 topN 筛选
  -> lane artifact/evaluator 校验
  -> 机会 thesis 与 mental positioning 合成
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
      -> 自然复述测试
      -> 付费/试用/迁移动作测试
  -> JSON + Markdown 最终报告生成
```

## 调研维度设计

### 1. 用户真实语言与心智定位 Lane

目标：从真实用户原话中发现高频、强情绪、能对应产品打开瞬间的 mental positioning，避免把功能词误判为创业机会。

典型数据源：

- Reddit、知乎、小红书、贴吧、论坛等社区内容
- B站/YouTube/TikTok 等视频评论
- App Store、Google Play、应用市场评论
- 问答社区、产品评论站、客服/投诉公开材料
- 用户访谈逐字稿和公开 UGC

处理流程：

```text
行业方向
  -> 数据源优先级设定
  -> 用户原话采集
  -> 高频自然表达聚类
  -> 剔除功能词、营销词、媒体词和模型总结词
  -> 提取 trigger phrase
  -> 分析用户真正认为自己卡在哪里
  -> 识别候选 mental positioning
  -> 判断是否对应明确入口场景
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 自然语言强度 | 是否是用户真实表达，而不是产品功能词或专家总结 |
| 频率 | 是否在多个独立来源中重复出现 |
| 情绪强度 | 是否带有焦虑、愤怒、急迫、无助、浪费时间或金钱损失 |
| 入口明确度 | 这句话是否对应用户会打开产品的具体时刻 |
| 人群清晰度 | 能否明确谁在说这句话 |
| 心智未占领度 | 现有大厂、内容平台、社区或线下服务是否已经占稳这句话 |
| 可复述性 | 用户是否可能自然说出“遇到 X 就用这个” |

### 2. 受众需求痛点 Lane

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
| 语言可追溯性 | 痛点是否能回连到用户原话和 trigger phrase |

### 3. JTBD 与任务流拆解 Lane

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
| 入口场景清晰度 | 能否明确用户在工作流哪一刻打开产品 |

### 4. 已有产品 Top 排名挖掘 Lane

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
| 心智占领度 | 头部产品是否已经占据该机会对应的用户 trigger phrase 或品类心智 |

### 5. 用户评论与差评挖掘 Lane

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
| 失效后行为 | 用户差评后是否出现换产品、找真人、问社区、手工补救等 next action |

### 6. 搜索需求与内容缺口 Lane

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
| trigger phrase 匹配度 | 搜索词是否是用户自然表达，而不是供给侧内容标题 |

### 7. 趋势变化 Lane

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

### 8. 替代方案与非 App 竞争 Lane

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

### 9. 现有解法失效场景 Lane

目标：识别用户已经尝试现有解决方案但仍然失败的具体场景，以及失败后的 next action。它关注迁移动机，不只是竞品缺口。

典型数据源：

- 竞品差评和流失评论
- 社区求助帖、二次求助帖、追问和补救流程
- “已经用了 X 但还是不行”类用户表达
- 公开客服投诉、论坛问题、产品评论
- 教程、工具、服务使用后的失败反馈

处理流程：

```text
行业方向或候选机会
  -> 当前解决方案枚举
  -> 失效场景识别
  -> 用户原话和 trigger phrase 记录
  -> 失效原因聚类
  -> 失败后的 next action 识别
  -> 判断 next action 是否代表迁移动机
  -> 映射到候选 mental positioning 和 opportunity thesis
```

维度内评分指标：

| 指标 | 说明 |
|------|------|
| 失效明确度 | 用户是否明确表达“用了现有方案仍然失败” |
| 失效频率 | 该失效是否在多个场景或来源中重复出现 |
| 失败后迁移动机 | 用户是否换 App、找真人、问社区、付费、手工补救或继续追问 |
| 当前解法惯性 | 现有解法是否因产品定位、商业模式、流程或技术限制难以修复 |
| 新产品入口清晰度 | 失效瞬间是否能自然转化为新产品打开场景 |
| 心智空白 | 该失效对应的用户语言是否尚未被明确产品占领 |

## 候选机会数据模型

候选机会必须是结构化对象，避免只保存自然语言摘要。

```json
{
  "id": "opp_001",
  "title": "面向独居老人的用药提醒与家庭协同 App",
  "description": "帮助独居老人管理用药、复诊和家庭成员远程确认。",
  "opportunity_thesis": "异地子女需要低成本确认独居老人慢病用药和复诊执行情况；现有个人提醒工具缺少家庭协同和长期健康记录，因此可以从家庭协同用药提醒切入。",
  "mental_positioning": "远程确认老人是否真的按时用药",
  "trigger_phrase": "我不在身边，不知道老人到底有没有按时吃药",
  "entry_scene": "子女在异地，老人每日用药、漏服或复诊前后需要远程确认时",
  "user_language_samples": [
    {
      "sample_id": "uls_001",
      "text": "我不在家，没法确认老人有没有按时吃药。",
      "source": "社区讨论",
      "confidence": 0.72
    }
  ],
  "target_users": ["独居老人", "异地子女", "慢病患者家庭"],
  "buyer": ["异地子女"],
  "payer": ["异地子女", "慢病患者家庭"],
  "decision_maker": ["家庭照护负责人"],
  "budget_source": "家庭健康管理和慢病照护支出",
  "purchase_trigger": "老人漏服、复诊延误、子女无法远程确认照护状态",
  "buyer_purchase_language": [
    "降低老人漏服和复诊延误风险",
    "不用反复打电话也能确认照护执行情况",
    "让家庭照护记录可追踪、可交接"
  ],
  "marketing_bridge": {
    "user_trigger_phrase": "我不在身边，不知道老人到底有没有按时吃药",
    "buyer_purchase_phrase": "用较低成本确认老人慢病照护是否执行到位，减少漏服和家庭沟通成本",
    "decision_criteria": ["执行确认率", "家庭重复沟通次数", "复诊记录完整度"]
  },
  "primary_scenarios": ["每日用药提醒", "漏服告警", "复诊记录", "家庭协同"],
  "job_to_be_done": "让家庭成员在不频繁打电话的情况下确认老人是否按时用药、复诊和记录慢病信息。",
  "pain_points": [
    "老人容易忘记用药",
    "子女无法确认是否按时服药",
    "慢病复诊和药品记录分散"
  ],
  "current_alternatives": ["电话确认", "微信提醒", "普通闹钟", "纸质用药记录", "通用用药提醒 App"],
  "alternative_gap": "普通提醒工具解决个人提醒，但不能稳定完成家庭确认、复诊协同和长期记录沉淀。",
  "value_layer": {
    "primary": "workflow_outcome",
    "output_value": "提醒文案、用药计划和健康摘要本身价值有限，容易被通用工具替代。",
    "workflow_value": "把提醒、确认、漏服补救、复诊记录和家庭同步串成持续闭环。",
    "outcome_metric": ["漏服确认闭环率", "复诊记录完整率", "家庭重复沟通次数下降"]
  },
  "user_state_context_model": {
    "state_variables": ["老人每日用药状态", "漏服记录", "复诊计划", "家庭成员确认状态"],
    "context_sources": ["提醒确认记录", "家庭成员备注", "复诊记录", "药品清单"],
    "state_update_triggers": ["到点未确认", "家庭成员补记", "复诊日期变更", "漏服补救完成"],
    "memory_retention_boundary": "只保留照护执行和慢病流程相关记录，不做诊断结论。",
    "privacy_and_permission_boundary": "家庭成员授权共享，健康数据导出和删除可控。"
  },
  "solution_failure_scene": "电话、微信和普通提醒可以提示一次，但不能形成可追踪的执行确认、漏服补救和长期记录。",
  "solution_failure_modes": ["无法异步确认", "漏服后缺少闭环", "记录分散", "家庭成员之间状态不同步"],
  "next_action_after_failure": ["反复打电话", "让其他家人确认", "手动记录", "寻找家庭共享提醒工具"],
  "mental_position_occupation": {
    "status": "partially_occupied",
    "occupied_by": ["通用用药提醒 App", "微信/电话"],
    "white_space": "家庭协同确认和长期慢病流程尚未被稳定占领"
  },
  "beachhead_segment": "异地子女照护的独居慢病老人家庭",
  "entry_wedge": "家庭协同用药提醒、漏服确认和复诊记录",
  "why_now": "远程家庭照护需求增加，老年慢病管理数字化工具成熟，但通用提醒工具仍偏个人使用。",
  "initial_distribution_channel": ["慢病社区内容", "子女照护人群社群", "药店/基层诊所合作"],
  "expansion_path": ["复诊档案", "检查报告归档", "家庭健康日历", "护理服务和保险导流"],
  "defensibility_hypothesis": "通过家庭协同记录、长期健康数据和照护工作流沉淀提高迁移成本。",
  "llm_capability_baseline": {
    "applies": false,
    "baseline_task": "生成用药提醒建议或照护清单",
    "prompt_only_baseline_result": "通用 LLM 可以生成提醒建议，但不能持续追踪执行、同步家庭状态或形成漏服补救闭环。",
    "remaining_gap_after_baseline": "真实价值来自状态追踪、多人确认、异常闭环和长期记录，而不是单次生成建议。",
    "model_upgrade_risk": "low"
  },
  "capability_commoditization_risk": {
    "risk_level": "medium",
    "risk_reason": "提醒、摘要和记录功能容易被平台复制，但家庭协同状态、长期照护数据和线下触达不容易被纯模型能力直接替代。",
    "mitigation": ["家庭协同工作流沉淀", "长期照护记录迁移成本", "慢病社区和诊所渠道"]
  },
  "source_lanes": ["user_language_mining", "audience_pain", "job_to_be_done", "top_products_gap", "review_mining", "solution_failure"],
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
    "user_language_mining": 7.9,
    "audience_pain": 8.4,
    "job_to_be_done": 8.1,
    "top_products_gap": 7.2,
    "review_mining": 8.8,
    "solution_failure": 8.0
  },
  "score_band": "strong_candidate",
  "global_score": 8.1,
  "rank_stability": 0.74,
  "sensitivity": {
    "most_sensitive_dimensions": ["workflow_outcome_value", "buyer_language_clarity", "capability_commoditization_risk"],
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
    "natural_restatement_test": "用户能否自然复述为：不在身边时，用它确认老人有没有按时吃药。",
    "prompt_only_baseline_test": "让用户用通用 LLM 生成照护清单，比较其是否能替代持续提醒、多人确认和漏服补救闭环。",
    "buyer_purchase_language_test": "验证异地子女是否会用“降低漏服风险、减少反复沟通、照护记录可追踪”解释付费理由。",
    "state_context_value_test": "验证用户是否愿意持续记录用药确认、复诊和家庭备注，以及这些状态是否降低重复沟通。",
    "workflow_outcome_metric_test": "跟踪 2 周内漏服确认闭环率、家庭重复沟通次数和复诊记录完整度。",
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
  "user_language_role": "trigger_phrase",
  "solution_failure_role": "current_solution_failed",
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
  "trigger_phrase_refs": ["uls_001"],
  "mental_positioning_refs": ["mp_001"],
  "solution_failure_refs": ["sf_001"],
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
| 需求强度 | 16% | 用户痛点是否真实且强烈 |
| 用户语言强度 | 7% | 是否来自真实用户高频自然表达，而不是功能词或营销词 |
| 入口场景清晰度 | 6% | 用户会在什么具体时刻打开产品是否明确 |
| 解法失效强度 | 7% | 用户是否已经尝试现有方案但仍失败，并出现 next action |
| 心智未占领度 | 6% | 该 trigger phrase 是否尚未被大厂、内容平台或线下服务稳固占领 |
| 工作流/结果价值 | 9% | 机会是否从单次 output 进入 workflow 或 outcome 改善 |
| 用户状态/上下文价值 | 6% | 是否能沉淀持续状态、上下文、协作记录或自动化闭环 |
| 市场空间 | 10% | 用户规模、消费能力、增长趋势 |
| 现有产品缺口 | 8% | 头部产品是否存在覆盖或满意度缺口 |
| 买单方明确度 | 7% | 使用者、购买者、付费者和决策者是否清楚 |
| 买单语言清晰度 | 6% | 用户触发语言是否能翻译成预算、ROI、效率、风险或家庭支出理由 |
| 付费和商业化 | 7% | 是否有付费意愿、订阅、交易或 B2B 变现 |
| 获客可行性 | 7% | 是否有清晰低成本触达渠道 |
| 切入版本可行性 | 6% | 小团队是否能在合理时间内验证 |
| 验证可行性 | 6% | 7-30 天内是否能用访谈、落地页、原型或人工服务验证 |
| 自然复述可验证性 | 5% | 是否能通过用户复述确认 mental positioning 成立 |
| LLM 基线差距 | 6% | 若依赖 AI/LLM，是否明显优于通用 LLM + prompt-only baseline；不依赖时按中性或低权重处理 |
| 差异化空间 | 6% | 是否能建立清晰定位或壁垒 |
| 时机窗口 | 4% | 为什么现在是较好的进入时点 |
| 替代方案风险 | -6% | 用户当前替代方案是否已经足够好 |
| 能力商品化风险 | -7% | 核心能力是否会被模型升级、平台内置、API 降价或竞品功能快速抹平 |
| 竞争风险 | -5% | 竞争强度、巨头风险、同质化风险 |
| 合规和平台风险 | -5% | 政策、医疗、金融、数据隐私等风险 |
| 判断置信度 | 10% | claim/finding/insight 的来源质量、一致性和覆盖度 |

权重应按行业和 scope assumptions 做归一化配置；上表用于表达相对重要性，不要求各项在文档中手工合计为 100%。

示例公式：

```text
global_score =
  demand_strength * 0.16
  + user_language_strength * 0.07
  + entry_scene_clarity * 0.06
  + solution_failure_strength * 0.07
  + mental_position_white_space * 0.06
  + workflow_outcome_value * 0.09
  + state_context_value * 0.06
  + market_potential * 0.10
  + product_gap * 0.08
  + payer_clarity * 0.07
  + buyer_language_clarity * 0.06
  + monetization * 0.07
  + acquisition_feasibility * 0.07
  + entry_version_feasibility * 0.06
  + validation_feasibility * 0.06
  + natural_restatement_testability * 0.05
  + llm_baseline_gap * 0.06
  + differentiation * 0.06
  + timing_window * 0.04
  + judgment_confidence * 0.10
  - substitute_risk * 0.06
  - capability_commoditization_risk * 0.07
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
    "user_language_strength": 7.9,
    "entry_scene_clarity": 8.4,
    "solution_failure_strength": 8.0,
    "mental_position_white_space": 7.3,
    "workflow_outcome_value": 8.6,
    "state_context_value": 8.1,
    "market_potential": 7.5,
    "product_gap": 8.2,
    "payer_clarity": 8.0,
    "buyer_language_clarity": 7.7,
    "monetization": 7.4,
    "acquisition_feasibility": 7.8,
    "entry_version_feasibility": 8.6,
    "validation_feasibility": 8.2,
    "natural_restatement_testability": 7.8,
    "llm_baseline_gap": 7.0,
    "differentiation": 7.9,
    "timing_window": 7.2,
    "substitute_risk": 5.8,
    "capability_commoditization_risk": 4.8,
    "competition_risk": 5.2,
    "compliance_risk": 6.4,
    "judgment_confidence": 7.6
  },
  "sensitivity_analysis": {
    "most_sensitive_dimensions": ["workflow_outcome_value", "acquisition_feasibility", "buyer_language_clarity", "capability_commoditization_risk"],
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
- 好机会判定标准、mental positioning 规则、kill gate 规则、评分权重和敏感性分析参数。

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
- 用户状态、上下文连续性、协作对象和数据沉淀机会。
- 用户触发语言、买单方购买语言和 purchase trigger 假设。
- 初始机会 thesis 假设和待推翻问题。

### User Language Miner

作为 `user_language_mining` discovery branch 的实现，负责从 UGC、评论、问答和访谈材料中挖掘用户真实语言和候选 mental positioning：

```python
class UserLanguageMiner:
    async def mine(
        self,
        direction: str,
        scope: ScopeFrame,
        seed_context: SeedProbe,
    ) -> UserLanguageMap:
        ...
```

输出包括：

- 高频自然表达和原话样本。
- trigger phrases。
- 用户真正认为自己卡住的位置。
- 入口场景候选。
- 功能词、营销词和供给侧词汇剔除结果。
- 候选 mental positioning、频率、情绪强度和未占领度。

### Solution Failure Mapper

作为 `solution_failure` discovery branch 的实现，负责识别现有解法在哪些场景失效，以及用户失败后的 next action：

```python
class SolutionFailureMapper:
    async def map(
        self,
        direction: str,
        scope: ScopeFrame,
        seed_context: SeedProbe,
    ) -> SolutionFailureMap:
        ...
```

输出包括：

- 当前解决方案和替代路径。
- solution failure scenes。
- 失效原因聚类。
- 用户原话和 evidence refs。
- next action after failure，例如换产品、问真人、问社区、手工补救、付费或放弃。
- 迁移动机强度和可转化入口。

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

每个 Discovery Lane 必须输出支持 claims、反对 claims、uncertainties、kill conditions、trigger phrase refs 和 solution failure refs。反证强或关键字段缺失的机会应被降级，不应进入 topN。

### Opportunity Thesis Synthesizer

负责把 lane 产出的候选机会转成可验证的 opportunity thesis：

```python
class OpportunityThesisSynthesizer:
    async def synthesize(
        self,
        lane_results: list[LaneResult],
    ) -> list[OpportunityThesis]:
        ...
```

每个 thesis 必须包含 `user`、`job_to_be_done`、`pain`、`current_alternatives`、`gap`、`buyer`、`payer`、`buyer_purchase_language`、`marketing_bridge`、`mental_positioning`、`trigger_phrase`、`entry_scene`、`solution_failure_scene`、`next_action_after_failure`、`mental_position_occupation`、`value_layer`、`user_state_context_model`、`entry_wedge`、`why_now`、`distribution_path`、`llm_capability_baseline`、`capability_commoditization_risk`、`kill_criteria` 和 `validation_hypotheses`。

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
- LLM capability benchmark 和 prompt-only baseline
- 能力商品化风险，包括模型升级、平台内置、API 降价和开源替代
- output/workflow/outcome 价值层判断
- 用户状态、上下文连续性、数据闭环和隐私边界
- 买单语言、预算来源、决策标准和用户语言到购买语言的映射

### LLM Capability Benchmarker

作为 `llm_capability_benchmark` enrichment branch 的实现，负责验证 AI/LLM 相关机会是否真的超出通用模型和 prompt-only 的能力范围：

```python
class LLMCapabilityBenchmarker:
    async def benchmark(self, opportunities: list[MergedOpportunity]) -> list[LLMBaselineResult]:
        ...
```

输出包括：

- 每个机会的 AI/LLM 依赖点。
- baseline task 和 prompt-only baseline result。
- 通用 LLM 是否已经足够解决核心任务。
- 产品需要补足的工作流、数据、执行、合规或分发能力。
- model upgrade risk 和剩余差距。

### Value, Context and Buyer Language Enricher

作为 `workflow_outcome_value`、`state_context_continuity` 和 `buyer_purchase_language` enrichment branch 的通用能力说明，负责把候选机会从“用户喜欢的功能”转成可购买、可留存、可验证的产品假设：

```python
class OpportunityValueContextEnricher:
    async def enrich(self, opportunities: list[MergedOpportunity]) -> list[ValueContextResult]:
        ...
```

输出包括：

- output/workflow/outcome 三层价值判断和 outcome metric。
- state variables、context sources、state update triggers 和 privacy boundary。
- buyer purchase language、budget source、decision criteria 和 marketing bridge。
- 对 `payer_clarity`、`monetization`、`workflow_outcome_value`、`state_context_value` 和 `capability_commoditization_risk` 的 score input。

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

每个机会至少包含 7 天验证动作、30 天 MVP、访谈对象、落地页或原型测试方式、自然复述测试、prompt-only baseline 测试、买单语言测试、状态上下文价值测试、成功阈值、失败阈值和最关键待验证假设。

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
  - mental positioning、trigger phrase 和 entry scene
  - 目标用户、买单方、付费方和决策者
  - JTBD 和当前工作流
  - 核心痛点
  - 现有解法失效场景和 next action
  - 当前替代方案和非 App 竞争
  - 心智是否被已有产品/内容/服务占领
  - 切入楔子、beachhead segment 和 why now
  - 关键判断依据
  - 竞品覆盖和满意度缺口
  - 商业模式
  - 获客路径
  - 切入版本建议
  - 综合评分、推荐档位、敏感性分析和排名稳定性
  - 风险和反证
  - kill criteria
  - 自然复述测试、7 天验证动作和 30 天 MVP 建议
## 被筛掉的机会
## 观察池机会
## 用户自然语言和心智定位摘要
## 现有解法失效场景地图
## 不确定性、关键假设和后续验证建议
## 审计追踪和参考来源
```

最终报告的正文应围绕创业判断展开，避免按证据逐条综述。原始 evidence 只通过 traceability、附录、脚注或审计追踪出现；正文主要使用 opportunity thesis、mental positioning、trigger phrase、entry scene、solution failure map、insight、score breakdown、risk、counter evidence、sensitivity analysis 和 validation plan 等结构化结果。报告必须允许给出“不建议做独立 App，建议从服务、插件、小程序或人工验证切入”的结论。

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
  "max_concurrency": 9,
  "join_policy": {
    "type": "all_completed",
    "min_success": 8,
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
          { "type": "counter_evidence", "blocking": true },
          { "type": "kill_conditions", "blocking": true },
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
- 每轮研究必须记录 `source_url`、`source_title`、`retrieved_at`、`query`、`research_goal`、`geo`、`language`、`source_independence` 和 `source_bias`。
- 原始 evidence 只进入 evidence store；后续 context pack 默认只放 claim、finding、insight 和 evidence refs，不放 `raw_text`。
- claim、finding、insight 必须保留 evidence refs，方便审计和置信度校验。
- 支持 claims 和 opposing claims 必须分开记录；不能只保存正向证据。
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
- 做确定性归一化、去重、评分公式计算、敏感性分析和排名稳定性计算。
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
opportunity_scope_framer
opportunity_planner
opportunity_seed_researcher
opportunity_space_mapper
user_language_researcher
audience_pain_researcher
job_to_be_done_researcher
top_products_researcher
review_mining_researcher
search_demand_researcher
trend_researcher
substitute_researcher
solution_failure_researcher
competitor_gap_researcher
market_size_researcher
monetization_researcher
acquisition_researcher
compliance_risk_researcher
counter_evidence_researcher
opportunity_thesis_synthesizer
opportunity_synthesizer
opportunity_validation_planner
opportunity_reviewer
opportunity_reporter
```

建议 artifacts：

```text
scope-frame.json
research-plan.json
seed-probe.json
opportunity-space-map.json
user-language-mining.json
audience-pain-lane.json
job-to-be-done-lane.json
top-products-lane.json
review-mining-lane.json
search-demand-lane.json
trend-lane.json
substitutes-workarounds-lane.json
solution-failure-map.json
discovery-fan-in.json
opportunity-theses.json
merged-opportunities.json
competitor-gap-enrichment.json
market-size-enrichment.json
monetization-enrichment.json
acquisition-enrichment.json
compliance-risk-enrichment.json
counter-evidence-enrichment.json
feasibility-unit-economics-enrichment.json
llm-capability-benchmark.json
capability-commoditization-risk.json
workflow-outcome-value-enrichment.json
state-context-continuity-enrichment.json
buyer-purchase-language-enrichment.json
enrichment-fan-in.json
normalized-judgment-context.json
ranking.json
sensitivity-analysis.json
ranking-rationale.json
validation-plan.json
startup-opportunity-report.md
traceability.json
```

建议 workflow states：

```text
scope_framing               delegation  明确市场、平台、商业模式、团队能力、验证周期、风险偏好和默认假设
research_plan               delegation  LLM 规划 lane、关键词、数据源、topN、评分权重、kill gate、Research Kernel 参数
seed_probe                  delegation  轻量探测用户、场景、问题、关键词、产品和数据源 seed
opportunity_space_map       delegation  建立用户角色、JTBD、工作流、替代方案、可软件化节点和初始 thesis 假设
discovery_parallel          parallel    基于 seed 和 opportunity space 的 9 条 discovery lane 并行调研
lane_result_validate        system      schema、evidence ref、trigger phrase、solution failure、support/opposition、kill conditions、topN 数量校验
opportunity_thesis          delegation  将 lane topN 机会转成可验证 thesis，补齐买单方、mental positioning、entry scene、solution failure、entry wedge、why now、kill criteria
opportunity_merge           delegation  语义合并、拆分判断、判断依据聚合
enrichment_parallel         parallel    竞品、市场、商业化、获客、合规、反证、替代方案、可行性、LLM 基线、能力商品化、价值层、状态上下文和买单语言并行补充检索
judgment_context_normalize  system      URL/source/product/evidence ref/claim/finding/insight 归一化和 deterministic dedupe
global_score                system      确定性评分公式、排序、阈值过滤和推荐档位
sensitivity_analysis        system      权重扰动、关键假设扰动、置信度扰动、rank stability 和 rank range 计算
ranking_rationale           delegation  基于结构化分数、反证和敏感性分析生成排名解释
quality_review              delegation  审核判断链、反证、评分解释、limitations 和报告一致性
validation_plan             delegation  生成自然复述、prompt-only baseline、买单语言、状态上下文、7 天验证动作、30 天 MVP、成功阈值和失败阈值
final_report                delegation  输出 Markdown 报告、JSON 报告和 traceability
done                        terminal
```

`discovery_parallel` branches：

```text
audience_pain              受众需求痛点
user_language_mining       用户真实语言与心智定位
job_to_be_done             JTBD 与任务流拆解
top_products               已有产品 Top 排名挖掘
review_mining              用户评论与差评挖掘
search_demand              搜索需求与内容缺口
trend_change               趋势变化
substitutes_workarounds    替代方案与非 App 竞争
solution_failure           现有解法失效场景
```

`seed_probe` 不应把业务流程变成产品中心调研。`product_seed` 只作为产品相关 branch 的输入；非产品 branch 仍可独立从用户心智、搜索需求、社区讨论、任务流、替代方案和趋势变化中发现尚未被现有产品覆盖的强需求。后续的产品覆盖分析用于验证 coverage gap，而不是要求所有机会都来自已有产品缺口。

`enrichment_parallel` branches：

```text
competitor_gap              竞品覆盖、满意度、迁移阻力
market_size                 市场空间、增长、用户规模
monetization                定价、付费意愿、商业模式
acquisition                 SEO、社区、渠道、平台获客
compliance_risk             政策、医疗、金融、隐私、平台风险
counter_evidence            反证、替代方案、失败案例
feasibility_unit_economics  小团队可行性、交付复杂度和早期单位经济
llm_capability_benchmark    通用 LLM + prompt-only baseline、模型升级风险
capability_commoditization  模型、平台、API、开源和竞品更新导致的能力商品化风险
workflow_outcome_value      output/workflow/outcome 价值层和 outcome metric
state_context_continuity    用户状态、上下文连续性、数据闭环和隐私边界
buyer_purchase_language     买单语言、预算来源、决策标准和 marketing bridge
```

这两个并行阶段都必须作为 workflow runtime 的 `parallel` state 表达，而不是用单个 agent 节点内部的子任务代替。内部子任务可以作为 agent 自己的执行优化，但不能替代 workflow 层对 branch 状态、产物和评测的可观测性。

### Skill 设计

新增 skills：

```text
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-scope-framing/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-research-plan/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-seed-probe/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-space-map/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-user-language-mining/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-audience-pain-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-job-to-be-done-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-top-products-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-review-mining-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-search-demand-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-trend-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-substitutes-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-solution-failure-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-thesis-synthesis/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-merge-synthesis/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-competitor-gap-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-market-size-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-monetization-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-acquisition-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-compliance-risk-recon/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-counter-evidence/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-feasibility-unit-economics/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-llm-capability-benchmark/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-capability-commoditization/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-workflow-outcome-value/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-state-context-continuity/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-buyer-purchase-language/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-ranking-rationale/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-quality-review/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-validation-plan/SKILL.md
/Users/chelaile/IdeaProjects/icarus/container/skills/opportunity-report-writer/SKILL.md
```

并在 `/Users/chelaile/IdeaProjects/icarus/container/skills/skills.json` 中新增 web role 映射，例如：

```json
{
  "web_opportunity_planner": [
    "opportunity-scope-framing",
    "opportunity-research-plan",
    "opportunity-seed-probe",
    "opportunity-space-map"
  ],
  "web_opportunity_research": [
    "opportunity-user-language-mining",
    "opportunity-audience-pain-recon",
    "opportunity-job-to-be-done-recon",
    "opportunity-top-products-recon",
    "opportunity-review-mining-recon",
    "opportunity-search-demand-recon",
    "opportunity-trend-recon",
    "opportunity-substitutes-recon",
    "opportunity-solution-failure-recon"
  ],
  "web_opportunity_enrichment": [
    "opportunity-competitor-gap-recon",
    "opportunity-market-size-recon",
    "opportunity-monetization-recon",
    "opportunity-acquisition-recon",
    "opportunity-compliance-risk-recon",
    "opportunity-counter-evidence",
    "opportunity-feasibility-unit-economics",
    "opportunity-llm-capability-benchmark",
    "opportunity-capability-commoditization",
    "opportunity-workflow-outcome-value",
    "opportunity-state-context-continuity",
    "opportunity-buyer-purchase-language"
  ],
  "web_opportunity_synthesis": [
    "opportunity-thesis-synthesis",
    "opportunity-merge-synthesis",
    "opportunity-ranking-rationale",
    "opportunity-validation-plan",
    "opportunity-report-writer"
  ],
  "web_opportunity_review": ["opportunity-quality-review"]
}
```

branch skill 的职责划分：

| Branch | Skill | 核心职责 |
|--------|-------|----------|
| `scope_framing` | `opportunity-scope-framing` | 明确市场、平台、商业模式、团队能力、验证周期、风险偏好和默认假设 |
| `research_plan` | `opportunity-research-plan` | 生成 lane 计划、query goals、数据源优先级、Research Kernel 参数、评分权重和 kill gate 规则 |
| `seed_probe` | `opportunity-seed-probe` | 轻量探测用户、场景、问题、关键词、产品和数据源 seed；不把所有 lane 绑定到已有产品 |
| `opportunity_space_map` | `opportunity-space-map` | 建立用户角色、JTBD、当前替代方案、工作流摩擦点、可软件化节点、状态上下文和买单语言假设 |
| `user_language_mining` | `opportunity-user-language-mining` | 从真实 UGC 中挖掘用户自然语言、trigger phrase、mental positioning 和入口场景 |
| `audience_pain` | `opportunity-audience-pain-recon` | 从人群、场景、社区讨论和评论中挖掘痛点与候选机会 |
| `job_to_be_done` | `opportunity-job-to-be-done-recon` | 从任务流、流程断点、协作摩擦和工作流价值中挖掘机会 |
| `top_products` | `opportunity-top-products-recon` | 基于 `product_seed` 扩展头部产品、定位、功能覆盖、商业模式和覆盖缺口 |
| `review_mining` | `opportunity-review-mining-recon` | 基于 `product_seed` 抓取低星评论、功能请求、投诉并提取未满足需求 |
| `search_demand` | `opportunity-search-demand-recon` | 从搜索需求、问答和内容缺口中识别工具化机会 |
| `trend_change` | `opportunity-trend-recon` | 从政策、技术、平台和消费变化中识别新窗口 |
| `substitutes_workarounds` | `opportunity-substitutes-recon` | 验证当前替代方案、非 App 竞争、切换阻力和 App 必要性 |
| `solution_failure` | `opportunity-solution-failure-recon` | 识别现有解法失效场景、失败原因、next action 和迁移动机 |
| `opportunity_thesis` | `opportunity-thesis-synthesis` | 将候选机会转为可验证 thesis，补齐买单语言、mental positioning、entry scene、solution failure、价值层、状态上下文、LLM baseline、能力商品化风险、entry wedge、why now、kill criteria |
| `competitor_gap` | `opportunity-competitor-gap-recon` | 对合并机会验证竞品覆盖、满意度、迁移阻力和差异化空间 |
| `market_size` | `opportunity-market-size-recon` | 补充市场规模、增长、目标用户规模和消费能力相关判断 |
| `monetization` | `opportunity-monetization-recon` | 验证付费意愿、定价、订阅、交易抽佣或 B2B 变现路径 |
| `acquisition` | `opportunity-acquisition-recon` | 验证 SEO、社区、平台、内容和合作获客路径 |
| `compliance_risk` | `opportunity-compliance-risk-recon` | 识别政策、医疗、金融、隐私、平台规则等风险 |
| `counter_evidence` | `opportunity-counter-evidence` | 查找替代方案、失败案例、需求被高估证据和反方观点 |
| `feasibility_unit_economics` | `opportunity-feasibility-unit-economics` | 判断小团队交付复杂度、运营依赖、毛利结构和早期单位经济 |
| `llm_capability_benchmark` | `opportunity-llm-capability-benchmark` | 验证 AI/LLM 相关机会相对通用 LLM + prompt-only baseline 的真实差距 |
| `capability_commoditization` | `opportunity-capability-commoditization` | 判断核心能力被模型升级、平台内置、API 降价、开源或竞品更新抹平的风险 |
| `workflow_outcome_value` | `opportunity-workflow-outcome-value` | 区分 output、workflow 和 outcome 价值，定义 outcome metric |
| `state_context_continuity` | `opportunity-state-context-continuity` | 建模用户状态、上下文来源、状态更新触发器、数据闭环和隐私边界 |
| `buyer_purchase_language` | `opportunity-buyer-purchase-language` | 验证买单语言、预算来源、决策标准和用户语言到购买语言的映射 |
| `validation_plan` | `opportunity-validation-plan` | 为推荐机会生成自然复述、prompt-only baseline、买单语言、状态上下文、7 天验证、30 天 MVP、成功阈值和失败阈值 |

每个 skill 必须要求：

- 读取 Context Pack。
- 使用 handoff contract 中的输入和成功标准。
- 所有业务结论写成结构化 artifact。
- evidence 引用必须可追踪，但 artifact 面向下游的主体内容应是 claim、finding、insight、opportunity 和 score input，不应携带原始 evidence 正文作为生成语料。
- discovery skill 必须分别输出 supporting claims、opposing claims、uncertainties、trigger phrase refs、solution failure refs 和 kill conditions。
- 无论成功/失败都调用 `complete_delegation`。
- result 至少包含 `verdict`、`summary`、`claims`、`findings`、`insights`、`opposing_claims`、`kill_conditions`、`audit_refs`。

这与现有 delegation skill 通过结构化 handoff 返回结果的模式一致。

### MCP 工具与 action 的边界

搜索、抓取、API 调用不应按工具形态一刀切。判断标准不是“是否联网”，而是“谁负责研究判断，谁负责可审计系统操作”。

agent delegation 负责：

- 决定查什么、为什么查、下一轮追问什么。
- 给每个 query 明确 `research_goal`。
- 判断哪些来源值得阅读和引用。
- 从来源中提炼 claim、finding、insight，再基于判断层生成痛点、功能缺口、反证和机会。
- 对语义相近机会做合并/拆分判断。
- 判断买单方、替代方案、entry wedge、why now 和 kill criteria 是否成立。
- 判断 trigger phrase、entry scene、solution failure scene 和 mental position occupation 是否成立。
- 判断 AI/LLM baseline、prompt-only baseline、model upgrade risk 和能力商品化风险是否成立。
- 判断机会价值主要位于 output、workflow 还是 outcome 层，以及 outcome metric 是否可验证。
- 判断用户状态、上下文连续性、买单语言和 marketing bridge 是否能支撑留存与购买。
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
- `opportunity_calculate_score`
- `opportunity_calculate_sensitivity`
- `opportunity_validate_traceability`
- `opportunity_validate_user_language_refs`
- `opportunity_validate_solution_failure_refs`
- `opportunity_validate_llm_baseline`
- `opportunity_validate_buyer_language_refs`

host MCP tool 可以执行联网 search/fetch/API 调用，但它的职责是按 agent 给出的 query、URL、source type 和 research goal 执行可审计数据获取，并把结果写成 evidence record。它不负责决定行业机会、筛选候选方向或生成最终结论。

这些工具通过 `/Users/chelaile/IdeaProjects/icarus/container/agent-runner/src/ipc-mcp-stdio.ts` 暴露，再通过 `/Users/chelaile/IdeaProjects/icarus/src/ipc.ts` 分发到 `/Users/chelaile/IdeaProjects/icarus/src/opportunity-recon/request-dispatcher.ts`。通用 `WebSearch`/`WebFetch` 仍可用于探索性补充，但原始来源进入正式判断前必须经 host MCP tool 记录到 evidence store。正式 artifact 中只保留 evidence refs、source manifest、provenance、limitations 和判断层产物，不携带原始证据正文作为下游生成语料。

适合 workflow action 的：

- `context.set`、`context.require` 这类已有上下文操作。
- branch artifact schema validation。
- evidence ref validation 和 source manifest 校验。
- user language refs、trigger phrase refs 和 solution failure refs 校验。
- llm baseline、buyer language、value layer 和 state context 字段完整性校验。
- deterministic dedupe，例如 URL canonicalization、product id 归一化。
- deterministic global scoring。
- deterministic sensitivity analysis 和 rank stability 计算。
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
startup_opportunity.scope_frame.v1
startup_opportunity.plan.v1
startup_opportunity.seed_probe.v1
startup_opportunity.opportunity_space_map.v1
startup_opportunity.user_language_map.v1
startup_opportunity.solution_failure_map.v1
startup_opportunity.discovery_lane_result.v1
startup_opportunity.discovery_fan_in.v1
startup_opportunity.opportunity_thesis.v1
startup_opportunity.merge.v1
startup_opportunity.enrichment_branch_result.v1
startup_opportunity.enrichment_fan_in.v1
startup_opportunity.llm_capability_benchmark.v1
startup_opportunity.capability_commoditization_risk.v1
startup_opportunity.value_layer_analysis.v1
startup_opportunity.user_state_context_model.v1
startup_opportunity.buyer_purchase_language.v1
startup_opportunity.ranking.v1
startup_opportunity.sensitivity.v1
startup_opportunity.validation_plan.v1
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

`scope_frame.v1` 必须产出：

```text
startup_opportunity.scope_frame.v1
  - direction
  - market
  - language
  - platform
  - business_model_preferences
  - team_capability_constraints
  - validation_budget
  - validation_timeline
  - risk_preferences
  - app_required
  - assumptions
  - open_questions
```

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

`opportunity_space_map.v1` 必须产出：

```text
startup_opportunity.opportunity_space_map.v1
  - user_roles
  - buyer_roles
  - payer_roles
  - decision_makers
  - jobs_to_be_done
  - workflow_maps
  - current_alternatives
  - workaround_patterns
  - workflow_friction_points
  - software_leverage_points
  - state_context_opportunities
  - buyer_purchase_language_hypotheses
  - initial_thesis_hypotheses
  - disconfirming_questions
  - audit_refs
  - limitations
```

`user_language_map.v1` 必须产出：

```text
startup_opportunity.user_language_map.v1
  - user_language_samples
  - natural_expressions
  - trigger_phrases
  - rejected_function_terms
  - mental_model_clusters
  - candidate_mental_positions
  - entry_scene_candidates
  - frequency
  - emotion_intensity
  - source_manifest
  - audit_refs
  - limitations
```

`solution_failure_map.v1` 必须产出：

```text
startup_opportunity.solution_failure_map.v1
  - current_solutions
  - solution_failure_scenes
  - failure_modes
  - user_language_refs
  - next_actions_after_failure
  - migration_intent
  - current_solution_inertia
  - opportunity_entry_candidates
  - source_manifest
  - audit_refs
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
  - supporting_claims
  - opposing_claims
  - findings
  - insights
  - candidate_opportunities
  - user_language_refs
  - trigger_phrase_refs
  - solution_failure_refs
  - scored_opportunities
  - kill_conditions
  - pre_kill_decisions
  - rejected_opportunities
  - watchlist_opportunities
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
user_language_summary
solution_failure_summary
opposing_claims_summary
pre_kill_summary
audit_refs
limitations
```

`opportunity_thesis.v1` 必须包含：

```text
opportunity_theses
  - id
  - title
  - opportunity_thesis
  - user
  - buyer
  - payer
  - decision_maker
  - buyer_purchase_language
  - marketing_bridge
  - job_to_be_done
  - mental_positioning
  - trigger_phrase
  - entry_scene
  - current_alternatives
  - alternative_gap
  - value_layer
  - user_state_context_model
  - solution_failure_scene
  - next_action_after_failure
  - mental_position_occupation
  - entry_wedge
  - beachhead_segment
  - why_now
  - initial_distribution_channel
  - expansion_path
  - defensibility_hypothesis
  - llm_capability_baseline
  - capability_commoditization_risk
  - supporting_claim_refs
  - opposing_claim_refs
  - user_language_refs
  - solution_failure_refs
  - kill_criteria
  - validation_hypotheses
  - confidence
  - audit_refs
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
  - llm_capability_baseline
  - capability_commoditization_risk
  - value_layer
  - user_state_context_model
  - buyer_purchase_language
  - sensitivity_inputs
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
sensitivity_inputs_by_opportunity
llm_capability_baselines_by_opportunity
commoditization_risk_by_opportunity
value_layer_by_opportunity
state_context_models_by_opportunity
buyer_purchase_language_by_opportunity
failed_or_partial_branches
audit_refs
limitations
```

`llm_capability_benchmark.v1` 必须包含：

```text
opportunity_id
ai_dependency_points
baseline_task
prompt_only_baseline_result
mainstream_llm_solved_level
remaining_gap_after_baseline
model_upgrade_risk
score_input
audit_refs
limitations
```

`capability_commoditization_risk.v1` 必须包含：

```text
opportunity_id
core_capabilities
commoditization_vectors
platform_or_model_bundle_risk
api_or_open_source_substitution_risk
incumbent_fast_follow_risk
defensibility_assets
risk_level
mitigation
score_input
audit_refs
limitations
```

`value_layer_analysis.v1` 必须包含：

```text
opportunity_id
output_value
workflow_value
outcome_value
primary_value_layer
outcome_metrics
workflow_embedding_points
score_input
audit_refs
limitations
```

`user_state_context_model.v1` 必须包含：

```text
opportunity_id
state_variables
context_sources
state_update_triggers
memory_retention_boundary
personalization_or_automation_logic
privacy_and_permission_boundary
state_context_moat
score_input
audit_refs
limitations
```

`buyer_purchase_language.v1` 必须包含：

```text
opportunity_id
user_trigger_phrases
buyer_purchase_language
budget_source
decision_criteria
purchase_trigger
marketing_bridge
willingness_to_pay_evidence_refs
score_input
audit_refs
limitations
```

`sensitivity.v1` 必须包含：

```text
ranked_opportunities
  - opportunity_id
  - expected_case_score
  - downside_case_score
  - upside_case_score
  - rank_range
  - rank_stability
  - most_sensitive_dimensions
  - assumptions_to_validate_first
```

`validation_plan.v1` 必须包含：

```text
validation_plans
  - opportunity_id
  - critical_hypotheses
  - interview_targets
  - natural_restatement_test
  - trigger_phrase_test
  - mental_position_test
  - prompt_only_baseline_test
  - model_upgrade_sensitivity_test
  - buyer_purchase_language_test
  - state_context_value_test
  - workflow_outcome_metric_test
  - 7_day_test
  - 30_day_mvp
  - willingness_to_pay_test
  - success_threshold
  - failure_threshold
  - next_decision
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
      { "type": "counter_evidence", "blocking": true },
      { "type": "kill_conditions", "blocking": true },
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
  "business_model_preferences": ["ToC 订阅", "交易撮合"],
  "team_capability_constraints": ["小团队", "无重线下运营能力", "可做内容获客"],
  "validation_timeline": "30 days",
  "validation_budget": "low",
  "risk_preferences": ["不做医疗诊断", "避免强监管金融"],
  "app_required": false,
  "target_rank_count": 10,
  "lane_top_n": 8,
  "constraints": ["不做医疗诊断", "优先 ToC 订阅或交易撮合"]
}
```

Icarus 的 `WorkflowContext` 是 `Record<string, unknown>`，`createNewWorkflow` 会 merge `opts.context`，template rendering 也支持从 context 中取值。因此可以通过 `context.direction` 等字段进入 workflow template；如果前端创建表单要更友好，再扩展 `create_form` 字段配置。用户未提供的 scope 字段应由 `scope_framing` 生成默认 assumptions，并进入最终报告。

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
  -> delegation: scope_framing skill
  -> delegation: research_plan skill
  -> delegation: seed_probe skill
  -> delegation: opportunity_space_map skill
  -> parallel: discovery branch delegations
  -> system/action: discovery fan-in validation
  -> delegation: opportunity_thesis skill
  -> delegation: opportunity merge
  -> parallel: enrichment branch delegations
  -> system/action: judgment context normalization + deterministic scoring + sensitivity analysis
  -> delegation: ranking rationale
  -> delegation: quality review
  -> delegation: validation plan
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
- Research Kernel 支持 query goal、并行检索、上下文压缩、递归追问、source curation、source independence、opposing claims 和 insufficient evidence。

业务 workflow 范围：

- `scope_framing` 明确市场、平台、商业模式、团队能力、验证周期、风险偏好和默认假设。
- `research_plan` 规划完整 discovery/enrichment research plan、kill gate、评分权重和敏感性参数。
- `seed_probe` 探测多类调研 seed，包括用户、场景、问题、关键词、产品和数据源；其中 `product_seed` 只作为产品相关 branch 的输入。
- `opportunity_space_map` 建立用户角色、JTBD、当前替代方案、工作流摩擦点和可软件化节点。
- `discovery_parallel` 覆盖 9 条发现 branch：
  - 用户真实语言与心智定位。
  - 受众需求痛点。
  - JTBD 与任务流拆解。
  - 已有产品 Top 排名挖掘。
  - 用户评论与差评挖掘。
  - 搜索需求与内容缺口。
  - 趋势变化。
  - 替代方案与非 App 竞争。
  - 现有解法失效场景。
- `lane_result_validate` 校验 schema、evidence ref、trigger phrase、solution failure refs、support/opposition、kill conditions 和 topN。
- `opportunity_thesis` 对 discovery topN 补齐买单方、mental positioning、entry scene、solution failure、entry wedge、why now、kill criteria 和验证假设。
- `opportunity_merge` 对 opportunity thesis 做语义聚类、拆分和判断依据合并。
- `enrichment_parallel` 覆盖 12 条补充验证 branch：
  - 竞品缺口。
  - 市场空间。
  - 商业化。
  - 获客路径。
  - 合规和平台风险。
  - 反证与替代方案。
  - 小团队可行性和早期单位经济。
  - LLM capability benchmark 和 prompt-only baseline。
  - 能力商品化风险。
  - output/workflow/outcome 价值层。
  - 用户状态、上下文连续性和数据闭环。
  - 买单语言、预算来源和决策标准。
- `global_score` 使用确定性公式计算综合评分、排序和推荐档位。
- `sensitivity_analysis` 计算 downside/expected/upside score、rank range、rank stability 和最敏感假设。
- `quality_review` 审核判断链、反证、评分解释、limitations 和报告一致性。
- `validation_plan` 输出自然复述测试、prompt-only baseline 测试、买单语言测试、状态上下文价值测试、7 天验证动作、30 天 MVP、访谈对象、成功阈值和失败阈值。
- `final_report` 输出 JSON、Markdown 和 traceability artifact。

最终输出 top 10 创业机会，每个机会包含：

- 标题、一句话定义和 opportunity thesis
- mental positioning、trigger phrase、entry scene 和用户原话样本
- 目标用户、买单方、付费方和决策者
- 买单语言、预算来源、决策标准和 marketing bridge
- JTBD、当前工作流和当前替代方案
- output/workflow/outcome 价值层、outcome metric、用户状态和上下文模型
- 现有解法失效场景、失效原因和 next action
- LLM capability baseline、prompt-only baseline、model upgrade risk 和能力商品化风险
- 关键痛点
- 机会来源 lane
- 关键判断依据
- 竞品缺口
- 综合评分、推荐档位、敏感性分析和排名稳定性
- beachhead segment、entry wedge 和 why now
- 切入版本建议
- 主要风险、反证和 kill criteria
- 自然复述测试、7 天验证动作、30 天 MVP、成功阈值和失败阈值

### 完整 Workflow

```text
direction
  -> scope_framing
  -> research_plan
  -> seed_probe
  -> opportunity_space_map
  -> discovery_parallel
      -> user_language_mining
      -> audience_pain
      -> job_to_be_done
      -> top_products
      -> review_mining
      -> search_demand
      -> trend_change
      -> substitutes_workarounds
      -> solution_failure
  -> lane_result_validate
  -> opportunity_thesis
  -> opportunity_merge
  -> enrichment_parallel
      -> competitor_gap
      -> market_size
      -> monetization
      -> acquisition
      -> compliance_risk
      -> counter_evidence
      -> feasibility_unit_economics
      -> llm_capability_benchmark
      -> capability_commoditization
      -> workflow_outcome_value
      -> state_context_continuity
      -> buyer_purchase_language
  -> judgment_context_normalize
  -> global_score
  -> sensitivity_analysis
  -> ranking_rationale
  -> quality_review
  -> validation_plan
  -> final_report
  -> done
```

### 可配置扩展点

- 引入人工可调权重。
- 支持多国家/地区市场比较。
- 支持 scope assumptions 模板，例如“小团队低预算”“ToB 高客单”“只做小程序/插件”。
- 支持输出结构化 JSON + Markdown 双格式。
- 支持用户在报告后追问某个机会，进入二次深挖。
- 支持用户选择某个机会进入真实验证 workflow，例如访谈脚本、落地页、MVP 任务拆解。

## 示例：宠物行业 App

输入：

```text
宠物行业 App
```

可能的 lane 发现：

| Lane | 发现方向 |
|------|----------|
| 用户真实语言与心智定位 | 用户反复表达“老了以后各种检查、用药、复诊都记不清”“家里人不知道宠物最近吃药和复诊情况” |
| 受众需求痛点 | 宠物慢病管理、上门喂养、宠物训练 |
| JTBD 与任务流拆解 | 长期用药、复诊、检查报告、家庭成员协同和异常提醒是连续任务流 |
| Top 产品挖掘 | 宠物社区、电商、健康记录已有产品多，但垂直慢病协同不足 |
| 评论挖掘 | 用户抱怨提醒不准、记录分散、服务质量不稳定 |
| 替代方案与非 App 竞争 | 微信群、备忘录、宠物医院纸质记录和人工提醒仍是主要替代方案 |
| 现有解法失效场景 | 备忘录/微信群能提醒一次，但复诊、化验单、用药执行和家庭同步无法形成闭环 |

合并后机会：

```text
宠物慢病管理与家庭协同 App
```

综合判断：

- 目标用户：高龄宠物主人、多宠家庭、慢病宠物家庭。
- 买单方：高龄宠物主人、愿意为宠物健康管理付费的家庭成员。
- Mental positioning：宠物长期生病后，家里没人能完整记住和同步“吃了什么药、什么时候复诊、上次检查结果是什么”。
- Trigger phrase：宠物慢病记录太乱了，家里人也同步不上。
- Entry scene：宠物复诊、换药、检查报告出来、家庭成员交接照护时打开。
- JTBD：持续记录病情、用药、复诊和检查报告，并让家庭成员共同确认执行情况。
- 痛点：长期用药、复诊、检查记录、家庭成员协同。
- 当前替代方案：微信提醒、备忘录、纸质记录、宠物医院单次沟通和通用宠物记录 App。
- 现有解法失效：微信/备忘录无法把报告、用药、复诊、异常症状和家庭确认串成长期照护链路。
- Next action：翻聊天记录、问家人、找宠物医院记录、重新拍报告、换 App 或手工整理表格。
- 竞品缺口：通用宠物记录产品存在，但围绕慢病流程的深度不足。
- 切入楔子：高龄猫/犬慢病家庭的用药提醒、复诊提醒、检查报告归档和家庭共享。
- Why now：高龄宠物和宠物医疗消费增长，用户愿意为长期健康管理投入，但现有 App 多偏社区、电商或泛记录。
- 验证计划：7 天内访谈 10-15 个慢病宠物家庭，30 天内用轻量原型测试健康档案、用药提醒和复诊共享；自然复述测试要求用户能说出“宠物慢病记录乱、家里人同步不上时会用它”。
- kill criteria：用户认为微信/备忘录足够，或宠物医院闭环服务已经覆盖该需求，或用户只愿免费使用提醒功能。
- 风险：宠物医疗数据标准化、与线下宠物医院合作难度。

## 风险与注意事项

- 公开数据可能不完整，尤其是 App 榜单和评论数据。
- LLM 提取痛点和机会时可能过度概括，需要 schema、evidence ref 和判断链校验约束。
- 排名不能只看高分，也要看判断置信度、证据独立性、反证、敏感性和 rank stability。
- 多个来源可能来自同一转载链或同一评论样本，不能机械累加为高置信度。
- 用户表达需求不等于存在付费意愿，必须单独验证买单方、预算来源和 purchase trigger。
- 用户触发语言不等于买单语言；家庭、企业、平台和个人购买的决策标准不同，必须分别验证。
- 用户原话不等于 mental positioning 已成立；必须验证用户是否能自然复述“遇到 X 时会用它”。
- `AI`、`助手`、`管理 App`、`平台` 这类供给侧词汇不能直接作为机会定位，必须落回 trigger phrase 和 entry scene。
- 通用 LLM + prompt-only 如果已经能完成核心任务，且产品没有工作流嵌入、专有数据、状态连续性或结果责任，该方向应降级。
- 核心能力若高度依赖可商品化 API、平台功能或模型升级，需要单独提高 commodity risk，不能只用“现在体验更好”支撑推荐。
- 一次性 output 容易被替代；缺少 workflow 或 outcome 指标的方向不应被评为强机会。
- 状态和上下文连续性如果无法通过用户授权、数据来源和隐私边界落地，就不能被空泛地当作壁垒。
- 解法失效后如果没有 next action，说明用户可能只是抱怨，不一定有迁移动机。
- App 不一定是最佳形态；小程序、插件、服务撮合、人工 concierge 或线下服务可能是更合理的切入方式。
- Top 机会必须包含 kill criteria 和验证计划，否则容易把方向包装成不可执行的商业建议。
- 不同行业的权重应允许配置，例如医疗健康类应提高合规风险权重。
- 最终报告应明确不确定性，避免把研究结论包装成确定性商业建议。

## 结论

行业 App 创业机会 Agent 应定位为：

```text
multi-lane opportunity mining
  + user-language mental positioning
  + buyer-language purchase validation
  + solution-failure mapping
  + LLM capability baseline and commoditization risk check
  + workflow/outcome value analysis
  + user-state and context-continuity modeling
  + structured evaluation
  + opportunity thesis
  + counter-evidence and kill gates
  + judgment-backed ranking
  + sensitivity-aware recommendation
  + validation planning
  + decision-oriented reporting
```

该 Agent 服务应借鉴 GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）的初始探测、query goal、并发子研究、递归追问、上下文压缩、来源筛选和证据不足时 abstain 等流程机制，并在 Icarus 项目（`/Users/chelaile/IdeaProjects/icarus`）中沉淀为 Research Kernel。主流程应落在 Icarus 的 workflow、parallel state、delegation、skill、MCP tool、artifact contract 和 evaluator 体系内。候选机会应来自多条调研维度提炼出的 claim、finding 和 insight，每条维度先独立筛选 topN，并在 lane 内完成用户语言挖掘、买单语言验证、解法失效识别、反证和 kill gate，再通过 thesis 合成、聚类、LLM baseline、能力商品化风险、工作流/结果价值、状态上下文建模、敏感性分析、自然复述测试、验证计划和综合评分生成最终创业方向排名。
