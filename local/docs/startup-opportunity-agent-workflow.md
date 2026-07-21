# RFC: 创业机会调研 Agent Recipe Family

> **状态**: 提案
> **作者**: 社区贡献者
> **创建日期**: 2026-07-01
> **目标版本**: 待定

## 概述

该设计方案描述 `startup-opportunity` Feature 提供的一组创业机会调研 Recipe。首版明确包含两种不同任务：面向宽泛方向发现并排名多个机会的 `opportunity_discovery`，以及面向一个已有产品/功能概念验证市场假设的 `concept_market_validation`。两者共享 Research Kernel、证据模型和受限 capability catalog，但使用不同 Workflow Definition、输入输出合同、Policy、完成条件与报告结构。

`opportunity_discovery` 不再只等同于“行业发现”。它通过 `discovery_profile` 和 `research_axes` 支持一般机会发现、行业优先、AI 能力优先和行业需求 × AI 能力混合发现。AI 能力变化是需求、任务和替代方案研究中的解决方案证据来源；它可以提高 capability seed 和方案候选的优先级，但不再作为独立业务子图产出另一套机会本体。

本文不再承载 Icarus core workflow runtime 的框架改造设计；fan-in、外层 State、运行时动态 DAG、graph compiler、graph execution、checkpoint、Task Intake/Macro Router、Recipe Catalog、Feature lifecycle 和 Workbench/Trace 展示等通用能力统一由以下框架方案定义：

```text
local/docs/dynamic-workflow-dag-framework.md
```

本方案只补充说明创业机会调研如何基于该通用 Dynamic Workflow DAG 框架实现：

- domain Recipe Descriptor、capability、role/skill source、artifact contract 和 evaluator。
- 调研 lane catalog 和默认策略。
- opportunity thesis、判断层模型、评分、反证和报告结构。
- Macro Router 如何在 Feature routing scope 内选择 exact Recipe，以及 Micro Planner 如何为已选 Recipe 的特定 graph state 生成本次 Scope Spec。
- graph 执行后的业务 fan-in、gap analysis、follow-up graph、解决方案比较、综合排序和最终决策建议。

方案同时涉及 GPT Researcher 与 Icarus 两个项目，但不以任一仓库作为唯一叙述主体。

关联仓库：

- Icarus 仓库：`/Users/chelaile/IdeaProjects/icarus`
- GPT Researcher 仓库：`/Users/chelaile/IdeaProjects/gpt-researcher`

创业机会 Agent 不是通用 deep research。机会发现 Recipe 也不是直接让模型基于一个行业或技术方向生成候选创业点，而是通过 Micro Planner 生成本次调研所需的动态 DAG，对需求、任务、替代方案、市场、解决方案证据、反证和复核节点进行并行或条件执行。AI 能力、通用模型和平台能力在相关 lane 或方案评估节点中作为证据来源。概念验证 Recipe 则从用户已给出的 product thesis 出发验证需求、替代方案、竞品饱和度、付费、获客、可行性与反证，不再执行“发现 TopN 机会”的候选生成主线。

本方案不按 MVP 分期设计，而是描述一版完整架构。实现时可以按工程风险拆任务，但文档目标是定义完整形态。

机会发现输入示例：

```text
宠物行业 App
养老护理 App
家庭旅行规划 App
AI 教育 App
本地生活服务 App
目前 AI 创业有哪些机会
多模态和 Agent 能力最近创造了哪些新创业窗口
AI 在家庭旅行场景有哪些值得小团队关注的方向
```

概念验证输入示例：

```text
宠物用药家庭协同 App 有没有市场机会
面向自由行用户的 AI 行程冲突检查功能值得做吗
把家庭票据自动整理成预算记录的 App 是否有付费空间
```

机会发现输出示例：

```text
1. 宠物慢病管理与家庭协同 App
2. 宠物保险比价与理赔辅助 App
3. 上门喂养和临时寄养调度 App

决策建议：优先关注哪个方向、哪些方向接近无法区分、哪些方向应观察或拒绝。

每个方向包含：
- 目标用户
- 核心痛点
- 机会来源
- 判断依据摘要
- 竞品覆盖度
- 用户满意度缺口
- 市场和商业化判断
- Demand Thesis、候选 Solution Hypotheses、selected solution 和 Baseline Option
- 原生 App、小程序、Web/PWA 等消费者交付形态比较
- market motion、buyer model、acquisition motion 和 payment mode
- 切入版本建议
- 风险和不确定性
- discovery profile 和机会来源 research axes
- AI Capability Evidence、通用模型 baseline、评测可靠性和单位经济（适用时）
- 数据/反馈闭环、供应商依赖和平台内置风险（适用时）
- 决策价值区间、关键未知数和可选轻量验证建议
```

概念验证输出为单一 thesis 的 `go | conditional_go | no_go | insufficient_evidence` verdict、置信度、支持/反对判断链、关键缺口、kill criteria、决策建议和可选的轻量验证建议，不输出人为凑数的 TopN 排名。

## 背景与动机

GPT Researcher 项目（`/Users/chelaile/IdeaProjects/gpt-researcher`）当前更偏向通用研究报告生成，尤其是 `deep` 模式，重点是围绕一个查询进行初始检索、扩展问题、并发子研究、递归追问、上下文压缩、来源筛选并生成综合报告。实际使用中，GPT Researcher deep 生成的调研报告质量较高，说明它的流程设计有重要参考价值。

Icarus 项目（`/Users/chelaile/IdeaProjects/icarus`）已有 workflow、delegation、skill、artifact contract、evaluator、host/container/IPC/MCP 等基础能力。通用 workflow runtime 如何把外层 State 与原生并发、runtime-generated DAG、Task Intake/Recipe routing 和统一恢复接入同一 Graph Runtime，由 `local/docs/dynamic-workflow-dag-framework.md` 统一定义。

因此，本方案的核心动机不是新增第二套 Opportunity workflow engine，也不是在业务文档中定义 core framework，而是在通用 Dynamic Workflow DAG 框架之上定义创业机会调研 Recipe Family。

创业机会调研需要更强的业务 workflow 控制：

| 需求 | 通用 deep research | 创业机会 Agent |
|------|--------------------|----------------|
| 输入 | 一个研究问题 | 宽泛行业/技术方向，或一个已有产品/功能 thesis |
| 候选机会 | 可能由模型直接总结 | 机会发现从需求、任务、替代方案、解决方案和市场判断层挖掘；概念验证不重新生成候选池 |
| 调研维度 | 动态扩展为主 | 预设维度 + 动态补充 |
| 评估方式 | 自然语言综合 | 结构化评分、筛选、排序 |
| 输出 | 一篇报告 | 决策建议视图：TopN 机会排序，或单 thesis verdict + 可审计判断链 |
| 决策逻辑 | 隐式 | 显式、可追溯、可调权重 |

因此，该 Agent 服务不应直接把 `GPTResearcher(report_type="deep")` 作为主业务接口，也不应只复刻一次性 deep research prompt。正确方向是：参考 GPT Researcher 的高质量调研流程，抽象出 Icarus 自己的 Research Kernel，并通过通用 Dynamic Workflow DAG 框架执行可追踪的并行、条件和 follow-up 节点。

## 目标

- 作为 `features/startup-opportunity` Feature 发布多个 versioned Recipe，而不是新增业务专用 workflow engine 或把领域代码静态写入 core。
- 通过 Feature routing scope 把 Macro Router 限制在 `opportunity_discovery` 与 `concept_market_validation` 等本领域 Recipe；产品设计、PM Pipeline 等无关 Definition 天然不进入候选集。
- 让各 Recipe 的 Micro Planner 只为指定 graph state 生成本次 Scope Spec；实际启用哪些 lane、节点依赖、并行关系、补充验证和 follow-up 由 Planner 决定，但不能修改外层 State、Capability 合同、Policy 或 output schema。
- 明确 workflow action 只负责确定性系统操作；调研、检索控制、抽取、综合等非确定性任务由 agent delegation 节点完成。
- 参考 GPT Researcher deep 的流程设计，抽象为可被 Icarus lane 复用的 Research Kernel。
- 从行业方向、技术能力变化或两者交叉中发现多个候选创业机会。
- 让需求、任务、替代方案和解决方案证据可以在同一个机会发现 Workflow 内并行执行；AI 能力证据融入相关 lane 和方案评估，不形成独立 capability-demand convergence 阶段。
- 对“目前 AI 创业有哪些机会”这类宽泛问题，输出若干可执行方向及需求、技术、商业、评测、成本、依赖和风险指标，而不是输出模型能力清单或趋势综述。
- 对用户已经给出的 App/功能概念执行 hypothesis-led market validation，输出单一 verdict、置信度、关键反证、决策建议和可选验证建议，而不是强行回到 TopN 发现流程。
- 在正式调研前明确市场、平台、商业模式、团队能力、风险偏好和验证周期等 scope assumptions。
- 从真实用户语言中识别尚未被现有产品占稳的 mental positioning，而不是只生成产品功能或品类名称。
- 所有 profile 都必须先形成 solution-neutral `Demand Thesis`，再生成一个或多个 `Solution Hypothesis`；机会必须由需求、解决方案、买单、交付形态和证据组合而成，而不是由 AI 能力或产品功能直接生成。
- 候选机会必须建模为可被支持或推翻的 `Opportunity Thesis`，而不是只有方向标题和摘要。
- 每条调研维度独立、可并行地完成证据留痕、判断提炼、结构化中间对象/机会提取和维度内筛选。
- 每条调研维度都必须输出支持判断、反对判断、不确定性和 kill conditions，避免只做正向论证。
- 每个候选机会必须说明用户会在什么入口场景、带着哪句自然语言触发使用，以及现有解法为什么在该场景失效。
- 如果机会依赖 AI 能力，必须先与通用模型 + prompt/tool baseline、现有平台原生能力和开源替代比较，判断真实差距、评测可靠性、单位经济和模型升级风险。
- 每个候选机会必须判断核心价值位于 output、workflow 还是 outcome 层，避免把一次性输出误判为创业机会。
- 每个候选机会必须区分用户触发语言和买单方购买语言，验证使用动机能否转化为预算、ROI 或风险降低。
- 对依赖持续指导、协作、个性化或自动化的机会，必须建模用户状态、上下文连续性和可沉淀的数据闭环。
- 对多维度产生的候选需求和解决方案进行去重、聚类、保持多样性并合并判断依据；不能在 lane 内过早截断所有长尾候选。
- 对合并机会进行并行补充检索、竞品验证、市场/商业化判断、合规风险和反证调查。
- 对合并后的机会进行跨维度综合排序、敏感性分析和排名稳定性判断。
- 输出可解释的创业方向排序、推荐档位和具体决策建议。
- 在关键假设不足以支持强推荐时，输出一条或少量轻量验证建议；本 Recipe 不执行验证、不跟踪业务结果，也不建立跨 Run 反馈闭环。
- 支持扩展新的调研维度、评分规则和数据源。

## 非目标

- 不直接替代 GPT Researcher 的通用研究报告能力。
- 不把 GPT Researcher 作为黑盒主业务入口；它是流程参考和可选底层能力来源。
- 不把 LLM 的自然语言报告作为唯一决策结果。
- 不把成品服务降级成一次性报告生成；需要保留结构化判断层、评分、反证和可追踪审计产物。
- 不在本方案中重新定义 core workflow runtime；并行/fan-in、Task Intake、Recipe routing 和动态 DAG 是 `local/docs/dynamic-workflow-dag-framework.md` 的通用能力。
- 不让一个全局 Planner 同时选择 Recipe、Workflow Definition 和图内能力；Macro Router 只选本 routing scope 内 exact Recipe，Micro Planner 只规划已选 Recipe 的 graph state。
- 当前 Feature 以消费者产品为主体；不默认原生 App 一定是首发形态，而是在 `native_app`、`mini_program`、`mobile_web`、`hybrid_app` 和必要时的人工辅助验证之间比较交付形态。SaaS、企业销售和 API/基础设施不是本版本的目标交付形态。
- 不把 AI 作为独立业务 Recipe 或机会本体；AI 是解决方案候选的一类能力证据，也是相关概念验证中的条件性评估维度。
- 不把模型发布、Benchmark 提升、融资热度、Demo 或 Prompt 技巧直接当作创业机会；AI 机会必须回连真实任务、买单方、可部署工作流和可验证结果。
- 不把 `AI Tutor`、`智能助手`、`错题本`、`社区`、`SaaS` 这类功能词或品类词直接当作机会定位；它们必须回到用户自然语言和入口场景中验证。
- 不把基础 LLM 能力、prompt 技巧或单次生成结果直接当作护城河；必须证明产品价值超出通用模型可快速复制的范围。
- 不把“用户会试用”直接等同于“买单方会购买”；购买语言、预算来源和决策标准需要单独验证。
- 不把验证动作执行、实验结果回写、业务结果追踪或自动调权纳入本方案；最终报告可以提供轻量验证建议，但不建立验证执行平台。
- 不用 MVP 范围定义本方案；本方案描述完整目标形态。
- 不保证生成的方向一定可创业成功，系统输出的是基于公开信息和可获取证据的机会判断。

## 核心设计原则

### 1. 机会来自判断层，而不是先生成

错误流程：

```text
宽泛行业/技术方向 -> LLM 直接生成 10 个创业机会 -> 再调研
```

目标流程：

```text
宽泛方向 -> 需求/任务/替代方案/解决方案/市场多维度调研 -> 原始证据留痕 -> 提炼判断层 -> Demand Thesis -> Solution Hypotheses -> Opportunity Thesis -> 决策建议
```

原始证据只作为留痕、审计和置信度校验的底层材料，不直接作为后续调研结果生成或最终报告写作的语料。后续 workflow 只消费从证据中提炼出的结构化判断层：

```text
Evidence Store -> Claims -> Findings -> Insights
  -> Demand Theses
  -> Solution Hypotheses
  -> Opportunity Theses
  -> Decision Recommendation -> Report
```

其中：

- `Evidence` 是网页、评论、榜单、报告、帖子等原始材料，保存在 evidence store 中。
- `Claim` 是从原始材料中抽取出的单条事实或判断。
- `Finding` 是对多条 claim 的归纳发现。
- `Insight` 是面向创业决策的洞察。
- `Demand Thesis` 是方案中立的需求/任务假设，记录用户、场景、当前替代、失败损失、买单和 outcome。
- `Solution Hypothesis` 是针对同一需求的候选解决方式，可使用 AI，也可以使用普通软件、人工服务、平台能力或其他消费者交付形态。
- `Capability Evidence` 是对某项能力边界、baseline、可靠性、成本和商品化风险的结构化证据，不直接构成机会。
- `Baseline Option` 是当前方案或继续维持现状的对照项，不进入机会 TopN，但所有方案必须与它比较增量价值。
- `Report` 使用专业报告结构表达判断，不按证据列表展开综述。

### 2. 高质量机会先被定义，再被发现

系统需要先定义什么是“值得进入下一步决策的机会假设”，再去调研和排序。否则 workflow 可能产出证据充分但创业价值不足的方向，也可能把某个 AI 能力或产品功能误当成机会。

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
第一个切入版本和 beachhead segment 是什么？
在消费者范围内，原生 App、小程序、Web 或人工辅助哪种交付形态更适合入口和验证？
当前方案或维持现状的 baseline 是什么？新方案必须产生什么增量价值才值得迁移？
核心价值在 output、workflow 还是 outcome 层？
产品是否需要持续用户状态、上下文记忆或协作闭环？
如果依赖 AI，通用模型 + prompt/tool、平台原生能力或开源方案是否已经足够解决？
能力本身是否会被模型升级、平台内置或竞品功能更新快速商品化？
什么证据会推翻这个机会？
```

因此，候选机会不是普通摘要，而是由需求和方案组合形成的 `Opportunity Thesis`：

```text
Demand Thesis = user/job/context + current alternative + failure/loss
  + buyer/payer + outcome metrics

Solution Hypothesis = delivery form + solution behavior + workflow change
  + baseline delta + distribution/payment motion
  + required capabilities + risks

Opportunity Thesis = Demand Thesis + selected Solution Hypothesis
  + entry wedge + why now + defensibility hypothesis
  + supporting/opposing evidence + kill criteria
```

没有明确买单方、买单语言、切入楔子、baseline 对比、交付形态、价值层判断或可被推翻的假设，应降级为 `watchlist` 或 `insufficient_evidence`，不能直接进入强推荐。只有声明依赖 AI 的 Solution Hypothesis 才必须具备 AI baseline、评测、单位经济、数据权利和依赖风险判断。

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

### 6. 先做 AI 能力基线，而不是假设 AI 就是机会

如果候选机会依赖 AI 能力，workflow 必须先回答：通用模型加上高质量 prompt、tool use、现成插件、开源组件或现有平台功能，是否已经能完成用户任务。这里的 AI 不只包括文本 LLM，也包括多模态、语音、视觉、Agent、传统 ML 和端侧模型。

基线测试不是为了否定 AI 机会，而是避免把已经商品化的生成能力包装成创业方向。每个 AI 相关机会至少要产出：

```text
baseline_task
baseline_models_and_tools
prompt_tool_baseline_result
mainstream_ai_solved_level
evaluation_dataset_and_metric
quality_latency_cost_result
product_required_capability
remaining_gap_after_baseline
human_review_requirement
model_upgrade_risk
```

如果通用模型 + prompt/tool baseline 或平台原生功能已经能以足够低成本完成核心任务，且产品没有工作流嵌入、专有数据、分发渠道、执行闭环或结果责任，机会应降级为 `watchlist` 或 `reject`。

### 6.1 AI 能力融入解决方案候选，而不是独立机会分支

AI 机会不能只从用户痛点出发后强行添加 AI，也不能只从模型能力变化出发生成技术找场景的清单。启用 `ai_capability` research axis 时，能力变化只改变 seed、查询优先级和 Solution Hypothesis 评估，不改变机会对象的基本本体：

```text
需求/任务/替代方案研究 -> Demand Thesis
AI、平台、开源和人工能力证据 -> Capability Evidence
Demand Thesis + 多种 Solution Hypotheses
  -> baseline / delivery form / outcome 比较
  -> Opportunity Thesis
```

Capability Evidence 可以由能力 frontier、成本曲线、工作流自动化、平台生态、数据评测和信任等 lane 提供，但不得单独进入正式机会排名。`capability_only` 只能作为观察信号或待研究线索。

只有当一个 Solution Hypothesis 声明依赖 AI 时，才强制检查：

- 存在可验证的用户任务、当前成本、失败损失或未消费需求。
- AI 相对通用模型、平台原生能力和开源方案带来可测量的质量、成本、速度或覆盖增量。
- AI 能力可以进入真实工作流，并有明确的人机边界、异常处理和 outcome metric。
- 买单方愿意为结果、效率或风险降低付费，而不只是对 AI 功能感兴趣。
- 数据、评测、单位经济、供应商依赖和平台替代风险在可接受范围内。

### 6.2 需求发现保持方案中立

所有 profile 的需求发现都不直接生成产品方案，而是描述用户任务本身及其运行条件。它需要记录任务频率、输入输出形态、上下文依赖、变化程度、异常比例、错误成本、延迟容忍度、人工审核容忍度、数据痕迹和 ground truth 来源，由后续 Solution Hypothesis 评估判断适合普通软件、AI、人工服务还是其他交付形态。

用户表示“想要 AI”不构成需求证据；用户已经用 ChatGPT、Claude、Copilot、RPA、模板或人工外包解决问题，则必须作为 current alternative/workaround 记录。

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

消费者场景中的个人自付、家庭代付、赞助支付、渠道推荐和交易撮合买单语言差异很大。机会 thesis 必须同时保留用户原话和买单方购买语言；如果只有用户喜欢但买单方无法用家庭支出、风险、效率、便利或体验改善解释购买理由，应降低 `payer_clarity` 和 `monetization`。

### 11. 输入方向必须先被约束和假设化

“宠物行业 App”或“目前 AI 创业有哪些机会”这类输入过宽，不同市场、团队能力、产品层、部署方式、平台约束和风险偏好会得到不同结论。正式调研前必须先做 `scope_framing`：

- 目标地区和语言，例如中国、美国、跨境市场。
- 消费者交付形态，例如原生 Mobile、Web/PWA、小程序或人工辅助验证；SaaS、企业销售和 API/基础设施不作为本版本默认目标形态。
- 消费者商业模式偏好，例如 ToC 订阅、交易撮合、家庭代付、渠道推荐或赞助支付。
- 团队能力和资源约束，例如是否能做线下运营、是否有行业资源、是否能接入供应链。
- 验证周期和预算，例如 7 天、30 天或 90 天验证。
- 风险偏好，例如是否接受医疗、金融、未成年人、隐私或平台依赖风险。
- 是否必须是原生 App；如果小程序、Web/PWA 或人工辅助方案更合理，应允许报告给出“不建议首发独立 App”的结论。
- `market_motion=consumer` 作为当前默认市场动作；`acquisition_motion` 使用 `direct|community|channel|marketplace`，`buyer_model` 使用 `self_payer|household_payer|sponsor_payer|provider_channel`。
- discovery profile，例如 `general`、`industry_first`、`ai_first` 或 `hybrid`。
- research axes，例如 `industry_demand`、`cross_industry_demand`、`solution_evidence`、`buyer_market`；`ai_capability` 只表示解决方案证据检索 lens，不表示独立机会分支。
- AI 解决方案偏好和部署边界，例如应用内 AI、工作流辅助、云端、端侧或开源优先；不将 AI 基础设施作为本 Feature 的默认交付形态。

如果用户没有显式提供这些约束，workflow 应生成默认假设，并在最终报告和 JSON artifact 中明确记录。

### 12. 调研维度既是发现通道，也是筛选通道

每个调研维度不是只负责收集材料，而是完整产出结构化判断。所有 profile 都沿着需求、方案和对照项形成统一对象；AI 能力只在相关 lane 或方案评估节点中提供 capability evidence：

```text
Evidence refs -> Claims -> Findings -> Insights
  -> Demand Theses
  -> Solution Hypotheses + Baseline Options
  -> Lane judgment / pre-kill
  -> Opportunity Theses
  -> Decision context
```

例如“已有产品 Top 排名挖掘”维度需要：

- 找到排行榜头部产品。
- 总结产品覆盖的人群、场景、功能、商业模式。
- 挖掘用户评论、低星反馈、功能请求。
- 判断是否存在覆盖不足、满意度不足、差异化缺口。
- 生成该维度下的 Demand Thesis 或 Solution Hypothesis，不要求每个 lane 直接生成完整机会。
- 输出支持 claims、反对 claims、不确定性和 kill conditions。
- 按证据阈值、候选多样性和 pre-kill 条件保留候选，不能只按固定 topN 过早裁剪。

### 13. 先维度内筛选，再跨维度综合排序

不同调研维度的判断质量和含义不同，不能在早期简单混合。每个维度先独立提炼判断和候选对象，再以证据阈值、对象多样性和 cross-lane 支持情况进行合并；只有合并后才做全局评分和决策建议。候选保留应优先避免早期丢失长尾，而不是固定输出每 lane 的 topN。

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

高质量机会不仅要判断用户是否愿意试用，还要判断用户是否能自然复述产品定位。必要时最终报告可以提供一条轻量验证建议；本 Recipe 不执行验证动作，也不追踪验证结果。建议可以包含 natural restatement test：

```text
用户是否会说：“我遇到 X 时会用它。”
用户是否能区分：“它不是 Y，而是帮我解决 Z。”
用户是否会用 trigger phrase 主动描述这个产品。
```

如果目标用户不能自然复述 mental positioning，或者复述成已有大厂/竞品已经占领的功能词，说明该机会的入口心智仍未成立，应降级为 `quick_validation` 或 `watchlist`，并把该问题写入 `next_validation_suggestion`。

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

证据数量和模型 confidence 不能直接等价于决策充分性。Evidence/Claim/Finding/Insight 之外，每个关键判断还应记录：

```text
evidence_tier:
  stated_preference | public_behavior_proxy | observed_behavior
  | payment_or_commitment | repeat_usage | expert_or_market_proxy
evidence_status:
  supported | opposed | mixed | no_signal | source_unavailable
  | not_applicable | stale
representativeness
independence
decision_sufficiency
what_would_change_it
```

`confidence` 只表达当前判断的可信程度，不等于统计概率。公开资料、搜索量、评论和厂商 benchmark 可以支撑探索性判断，但在没有直接行为或付费证据时，最高推荐档位和 verdict 必须受 profile-specific rule 限制。`insufficient_evidence` 还应区分没有信号、信号冲突、来源不可用和证据过期，不能把不同原因混成一个状态。

### 16.1 研究规划以决策价值驱动

Planner 和 follow-up 不只判断某个 lane 是否“相关”，还必须判断它是否可能改变最终决策。每个 open question 应记录：

```text
decision_impact
uncertainty
research_cost
stop_condition
```

follow-up 优先选择以下比值较高的问题：

```text
expected_decision_impact * uncertainty / research_cost
```

当新增证据不会改变推荐档位、关键 hard gate 或下一步建议时，应停止继续研究。这个规则用于控制研究预算和避免把研究深度误当成研究质量。

### 16.2 决策建议不是虚假的精确排名

全局评分仍可以作为排序辅助，但不能把多个相关维度和未经校准的 0-10 分包装成客观事实。评分阶段应按以下顺序执行：

```text
hard gates
  -> calibrated evidence / uncertainty bands
  -> expected decision value
  -> downside / upside / speed-to-learn
  -> ranking or partial-order recommendation
```

当多个机会的区间高度重叠时，报告应输出“稳健领先”“接近无法区分”或“证据不足”，而不是强行给出精确名次。需求强度、用户语言、解法失效、入口场景等相关维度必须避免重复计分；scoring profile 的 rule version 需要保留专家审阅/benchmark fixture 的校准依据和输入快照，不依赖后续创业成败自动调权。

### 16.3 人工控制边界与 Agent 输出质量

本 Feature 负责提供决策建议，不负责替用户执行创业验证。人工控制只在以下边界介入：

- scope assumptions 或高影响约束缺失时请求澄清。
- 用户主动要求高成本 follow-up 时确认范围和预算。
- 未来若触发外部副作用操作，再使用 durable approval；当前报告生成本身不要求人工批准。

Agent 质量评估分为两层：

```text
execution quality:
  schema、引用、反证、freshness、字段完整性和 artifact evaluator

decision readiness:
  是否满足推荐档位、verdict、hard gate 和 limitation 的证据门槛
```

这些评估可以在当前 Runtime 内触发 `retry`、`needs_revision`、`follow_up`、`needs_clarification` 或 `insufficient_evidence`。本方案不把后续创业成败、用户长期付费或实验结果作为当前 Recipe 的业务反馈闭环，也不自动据此修改历史报告或 scoring profile。

### 16.4 TopN 之外还要给出组合决策

单独给每个机会打分不能表达多个方向是否共享渠道、能力和用户，也不能表达它们是否争夺同一团队资源或暴露于相同平台风险。决策建议应在 TopN 之后增加轻量 portfolio view：

```text
recommended_first_bet
alternative_bets
shared_distribution_or_capabilities
resource_conflicts
risk_correlation
learning_reuse
```

这不是通用投资组合优化器，也不改变消费者 App 的产品定位；它只是在用户给定团队、预算和周期约束下，说明应优先关注一个方向还是保留一组互补候选。`Baseline Option` 仍然是每个方案的对照项，不参与 portfolio 排名。

### 16.5 证据和机会具有时间有效性

freshness 不能只用于 AI 模型、价格和平台政策。竞品功能、评论、渠道、价格、法规和市场规模也应记录 `valid_as_of`、`freshness_policy` 和失效原因。机会对象应使用以下研究生命周期：

```text
proposed -> screened -> recommended
         -> watchlist | rejected | stale
```

`stale` 表示支撑当前判断的关键证据已过期或市场状态发生重大变化，不表示机会被证伪。跨 Run 可以复用带 provenance 的 evidence、claim、negative finding 和 canonical entity，但必须按市场、地区、时间和来源独立性重新校验；本方案不利用后续商业成败做自动学习。

### 17. 并行和动态 DAG 来自通用 workflow 框架

多 lane 调研、多 query 搜索、多机会 enrichment、多 reviewer 复核都不应被隐藏在一个 agent 节点内部。隐藏并行会降低 workflow 层可观测性、可恢复性和质量门控制。

本方案基于 `local/docs/dynamic-workflow-dag-framework.md` 的通用能力表达这些执行关系。不存在 `parallel` state；固定并行结构使用 static Graph Scope Template，动态结构由 Micro Planner 生成 Scope Spec，多个 ready Graph Node 由 Runtime 原生并发执行。

```text
startup opportunity recipe
  -> planner generated graph spec
  -> generic graph compiler
  -> generic graph execution
  -> node-level artifact/evaluator
  -> fan-in context
  -> domain synthesis
```

### 18. Action 只做确定性系统操作

本文保留 `action` 作为领域口语，落地时它必须是 versioned `system` capability 的 executor，不再由 Definition/Graph 直接引用旧 action name。职责边界：

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

### 19. Macro Router 选择 Recipe，Micro Planner 只规划 graph state

Task Intake 先冻结 raw query、显式 `analysis_mode`、结构化约束、附件引用和 principal。Feature 使用 pinned routing scope：

```text
startup-opportunity.market-research@1.0.0
  allowed recipes:
    startup-opportunity.opportunity-discovery@1.0.0
    startup-opportunity.concept-validation@1.0.0
```

`product-design`、`pm_new_feature` 等无关 Recipe 不在候选集，即使 Router 模型输出也由 deterministic resolver 拒绝。`analysis_mode=opportunity_discovery|concept_validation` 是显式用户选择，直接产生 deterministic routing decision；`analysis_mode=auto` 才调用 Macro Router。`discovery_profile` 和 `research_axes` 是机会发现 Recipe 的 typed input，不参与 Recipe 竞争。输入既包含宽泛方向又包含明确产品 thesis、或缺少足以改变宏观目标的关键信息时返回 `needs_clarification`，不能静默选择高成本流程。

Macro Router 只输出 exact RecipeRef。Recipe Descriptor 不可变绑定 Definition、entrypoint、Workflow execution policy、input/output schema、launch policy 和 resource claim；Router 不允许自由混配。Workflow 创建后，Definition 固定外层 State/transition，Micro Planner 只为 `discovery_graph_execute`、`validation_graph_execute`、`followup_graph_execute` 或 `enrichment_graph_execute` 等指定 graph state 生成 Scope Spec。

### 20. Planner 只能实例化受信任 capability

Planner 可以选择 node、edge、condition、input binding、subgraph/map/expand 和 completion policy，但每个 delegation/system node 只能引用 Feature 发布且 Recipe policy allowlist 允许的 exact `capability_ref`。Planner 不能在 node 内声明 role、skill、prompt、tool、artifact contract、evaluator 或 quality gate。

行业特定维度不能通过“任意 Agent”逃逸。需要开放式行业扩展时使用受限 capability `startup-opportunity.bounded-domain-research-lane`：它固定 executor、role/skill、Research Kernel、工具、文件范围、artifact/evaluator 和输出 schema，只把 `lane_kind`、`research_goal`、query/source preference 等作为 typed data input。新增真正不同的工具或执行合同必须先发布新 capability version 并更新 Recipe allowlist。

## 总体 Workflow

### 架构层 Workflow

通用 workflow 框架不在本文定义，详见：

```text
local/docs/dynamic-workflow-dag-framework.md
```

本文只假设该框架已经提供外层 Workflow State、统一 Graph lowering、static/dynamic Graph、原生 ready-node 并发、graph compiler、node-level artifact/evaluator、fan-in、Task Intake/Recipe routing、checkpoint 和 Workbench/Trace 可观测性。

### 机会发现 Workflow

```text
Macro Router 已选择 opportunity_discovery
  -> 行业、技术能力或宽泛创业方向输入
  -> Scope Framing
      -> 市场/地区/语言
      -> 平台和交付形态
      -> 商业模式偏好
      -> 团队能力和验证周期约束
      -> 风险偏好和默认假设
      -> discovery_profile 和 research_axes
      -> AI solution lens、能力范围和部署约束（适用时）
  -> 研究策略规划
  -> 调研种子探测
      -> 用户/场景 seed
      -> 问题/痛点 seed
      -> 关键词 seed
      -> 产品 seed
      -> 数据源 seed
      -> capability/model/ecosystem seed（启用 AI axis 时）
  -> 机会空间和任务流地图
      -> 用户角色
      -> 高频任务
      -> 当前替代方案
      -> baseline option / status quo
      -> 工作流摩擦点
      -> 可软件化节点
      -> task operating profile
  -> 解决方案空间地图
      -> native app / mini program / mobile web / hybrid / assisted validation
      -> ordinary software / platform / human / AI-assisted solution candidates
      -> capability evidence、baseline gap 和 deployment constraints（适用时）
  -> 生成 discovery graph spec
  -> 执行动态 discovery graph
      -> 需求、任务、替代方案和用户语言 lanes
          -> 用户自然语言、JTBD、trigger phrase 和现有解法失效
          -> non-consumption、当前 AI workaround 和 task operating profile
          -> solution-neutral demand thesis
          -> 支持/反对 claims、kill conditions 和候选保留
      -> 解决方案证据 lanes（按候选方案条件启用）
          -> 竞品、平台、通用模型、开源和人工替代
          -> capability delta / baseline / reliability / cost
          -> workflow automation / human-in-the-loop 边界
          -> data/evaluation/deployment/commoditization conditions
          -> solution hypotheses 和 baseline comparison
  -> graph node artifact/evaluator 校验
  -> gap analysis 和 follow-up graph 规划
  -> 需求与解决方案合成
      -> Demand Theses
      -> Solution Hypotheses
      -> selected solution / delivery form / baseline delta
  -> 机会 thesis 与 mental positioning 合成
  -> 机会去重与聚类
  -> 生成 enrichment graph spec
  -> 执行动态 enrichment graph
      -> 竞品缺口
      -> 市场空间
      -> 商业化
      -> 获客路径
      -> 合规和平台风险
      -> 反证与替代方案
      -> 可行性和早期单位经济
      -> AI baseline、评测可靠性、推理单位经济、数据权利和供应商依赖（AI 方案适用时）
  -> 跨维度综合评分
  -> 敏感性分析和排名稳定性判断
  -> 决策建议与推荐档位
  -> 对抗式质量复核
  -> 可选轻量验证建议
      -> 自然复述 / 买单语言 / baseline 差距
      -> 低成本用户访谈、价格承诺或技术 spike 建议
  -> JSON + Markdown 最终报告生成
```

### 具体概念市场验证 Workflow

```text
Macro Router 已选择 concept_market_validation
  -> Concept Framing
      -> product thesis / target user / entry scene / claimed value
      -> market、platform、business model、team/budget constraints
      -> assumptions、unknowns、kill criteria
  -> Validation Strategy Planning
  -> 生成 validation graph spec
  -> 执行动态 validation graph
      -> target user / JTBD / user language
      -> current alternatives / solution failure
      -> demand and behavior signals
      -> competitor saturation / differentiation
      -> willingness to pay / buyer language
      -> acquisition / distribution feasibility
      -> delivery feasibility / compliance / unit economics
      -> AI baseline / evaluation reliability / unit economics / capability commoditization（适用时）
      -> counter evidence
  -> hypothesis evidence reduce
  -> evidence gap / bounded follow-up planning
  -> adversarial review
  -> deterministic verdict gate
      -> go
      -> conditional_go
      -> no_go
      -> insufficient_evidence
  -> optional validation suggestions
  -> JSON + Markdown concept validation report
```

该 Recipe 不执行 lane 内候选机会生成、跨 lane opportunity clustering 或 TopN global ranking。它可以复用机会发现的 Research Kernel、user-language、solution-failure、competitor、monetization、acquisition、compliance、AI baseline 和 counter-evidence capabilities，但使用 `concept_hypothesis` 作为中心对象，所有 branch output 必须回连同一 hypothesis id。AI 相关 concept 由 `validation_profile=ai|regulated_ai` 在声明依赖 AI 的 Solution Hypothesis 上启用对应评估 bundle，不新增 AI Recipe，也不执行外部验证动作。

两套 Recipe 的 Definition/entrypoint、Workflow execution policy、Graph interface、named exit 和最终 report schema 分开版本化。不能用一个“超级 Planner”根据输入临时改变宏观目标；Macro Router 在 Workflow 创建前完成 Recipe selection，Micro Planner 只改变各自 graph state 内的节点拓扑。

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
- 消费者服务流程、使用教程、家庭协作和人工服务说明
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
| 软件化潜力 | 原生 App、小程序或 Web/PWA 是否能比现有方案更低成本、更稳定或更可扩展 |
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
  -> 生成 Demand Thesis / Solution Hypothesis
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
- 消费者产品评论站和应用评测社区
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
  -> 生成 Demand Thesis / Solution Hypothesis
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
  -> 生成 Demand Thesis / Solution Hypothesis
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

目标：识别政策、行业结构、平台规则、预算和消费/组织行为变化带来的需求窗口。启用 AI axis 时，模型能力、推理成本和开源生态变化作为 Solution Hypothesis 的 capability evidence；本 lane 只记录它们对用户行为、购买、监管和工作流采用的需求侧影响，避免重复研究。

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
  -> 生成 Demand Thesis / Solution Hypothesis
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
- 家庭分工、个人工作流和人工服务页面
- 竞品评论中提到的替代产品和流失原因
- ChatGPT、Claude、Copilot、通用 Agent、RPA、Prompt 模板和内部 AI 工具

处理流程：

```text
行业方向或候选机会
  -> 当前替代方案枚举，包括通用 AI workaround
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
| App 必要性 | 原生 App 是否比小程序、Web/PWA、hybrid app 或人工辅助验证更合理 |
| 服务依赖度 | 机会是否依赖重运营、供应链、线下交付或人工服务 |
| 防御性 | 如果用通用工具或现有平台也能快速复制，差异化是否不足 |
| 否定风险 | 替代方案证据是否足以触发 kill condition |

### 9. 现有解法失效场景 Lane

目标：识别用户已经尝试现有解决方案但仍然失败的具体场景，以及失败后的 next action。它关注迁移动机，不只是竞品缺口。AI/hybrid profile 下还需要记录现有 AI workaround 为什么失败，以及过去因成本、技能或不可行而直接放弃的 non-consumption。

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
  -> abandoned task / non-consumption 识别
  -> 当前 AI workaround 及其失败模式识别
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

如果用户没有 next action，一般应降低机会优先级；但如果证据表明任务过去因为人工成本过高、专业技能不足、处理规模过大或技术不可行而被放弃，则可作为 `non_consumption` 进入 Demand Thesis。此类方向必须额外证明 outcome 价值和买单意愿，不能仅凭“AI 现在能做”进入强推荐。

### 9.1 AI/hybrid Profile 下需求发现 lane 的适配

原有需求发现能力继续复用，但 prompt、typed output 和 evaluator 需要切换到 AI-aware demand profile。目标不是寻找“用户想要什么 AI”，而是让 Demand Thesis 携带足够的 task/workflow join keys：

| 原有 Lane | AI/hybrid 下的补充要求 |
|-----------|------------------------|
| `user_language_mining` | 挖掘“处理不过来、信息太散、每次情况不同、需要反复判断”等任务语言；用户主动提到 AI 只能作为 workaround/expectation，不能直接证明需求 |
| `audience_pain` | 量化频率、工作量、周期、人工成本、等待时间、错误损失和当前放弃率 |
| `job_to_be_done` | 拆到具体 task step，记录输入输出模态、上下文依赖、变化程度、异常分支、审核节点和 outcome metric |
| `top_products` | 覆盖消费者 App、小程序、Web、通用模型、平台原生能力和人工服务，不以 App 榜单为唯一产品空间 |
| `review_mining` | 增加准确性、幻觉、延迟、上下文丢失、不可控、无法集成、审核负担等现有 AI 功能失败反馈 |
| `search_demand` | 同时研究问题型搜索和用户如何使用通用 AI 自助解决；区分一次性答案需求与持续工作流需求 |
| `trend_change` | 只研究消费行为、家庭预算、数字化、平台和监管变化；模型能力与成本变化作为解决方案证据加入相关候选评估 |
| `substitutes_workarounds` | 强制加入通用模型、Prompt、RPA、模板、外包、内部运营和平台原生功能 |
| `solution_failure` | 区分传统解法失败、现有 AI 解法失败和 non-consumption，定位失败发生的具体 task step |

需求侧 lane 只评价需求强度、当前成本、失败损失、迁移/付费意愿和任务条件，不对 `AI fit` 打分。`ai_fit_score`、`capability_delta`、`automation_or_augmentation_fit`、`data_readiness` 和 `evaluation_feasibility` 只能作为声明依赖 AI 的 Solution Hypothesis 的方案评估输入。

### 10. AI 能力证据与解决方案评估

AI 能力变化不是一个单独 Recipe 或独立业务子图。它是 `opportunity_discovery` 在 `research_axes` 包含 `ai_capability` 时启用的解决方案证据 lens：可以先作为 capability seed 探测，也可以在候选方案 enrichment 中按需深挖，但最终必须回连同一 Demand Thesis 和 Solution Hypothesis。

默认 AI capability lane catalog：

| Lane | 核心问题 | 典型来源 |
|------|----------|----------|
| `ai_capability_frontier` | 哪些任务最近从不可行变为可行，真实边界和失败模式是什么 | 模型文档、release note、独立 benchmark、论文、复现实验 |
| `ai_cost_curve_access` | 质量、延迟、上下文、推理成本、端侧/云端部署和开源可用性是否支持产品化 | API 定价、模型卡、部署文档、硬件成本、服务限制 |
| `ai_workflow_automation` | 哪些 task step 可自动化或增强，哪些必须 human-in-the-loop | 工作流材料、操作手册、现有 Copilot/Agent 使用反馈 |
| `ai_ecosystem_platform` | 分发入口、集成生态、协议、平台内置和 incumbent bundling 风险如何 | 平台 changelog、应用市场、集成目录、开发者生态 |
| `ai_data_eval_flywheel` | 数据来源、权利、ground truth、评测集和反馈闭环能否成立 | 数据政策、隐私条款、行业数据规范、评测实践 |
| `ai_adoption_trust` | 安全、隐私、可解释性、家庭责任和消费者信任是否阻碍使用 | 安全/合规文档、应用市场政策、用户和家庭决策者反馈 |

AI 能力证据具有较短时效性。Evidence Record 除通用字段外还应记录：

```text
valid_as_of
provider / model_id / model_version
pricing_snapshot
license
benchmark_setup
deployment_region
vendor_claim_or_independent_test
reproducibility
freshness_policy
```

模型发布或融资新闻只能作为 seed，不能直接成为 Capability Evidence。每条能力证据至少需要说明适用任务、能力边界、失败模式、质量/延迟/成本范围、可部署条件、预期能力半衰期和审计引用。它最终只能支撑某个 Solution Hypothesis 的 `required_capabilities`、`capability_delta`、`baseline_gap` 和风险判断。

## Demand Thesis / Solution Hypothesis / Capability Evidence 数据模型

所有 profile 都先输出 solution-neutral `DemandThesis`：

```json
{
  "demand_id": "demand_001",
  "user": "目标使用者",
  "buyer": "目标买单方",
  "job_to_be_done": "用户需要完成的任务",
  "workflow_step": "任务发生的具体步骤",
  "trigger_phrase": "用户自然语言",
  "current_alternatives": ["人工", "消费者 App/小程序", "通用 AI"],
  "current_ai_workarounds": ["复制上下文到通用模型"],
  "task_operating_profile": {
    "frequency": "daily",
    "volume": "high",
    "input_modality": ["text", "image"],
    "output_modality": ["structured_decision"],
    "task_variability": "medium",
    "exception_rate": "unknown",
    "context_fragmentation": "high",
    "judgment_intensity": "high"
  },
  "execution_constraints": {
    "latency_tolerance": "minutes",
    "quality_threshold": "待验证",
    "error_cost": "medium",
    "auditability_requirement": "high",
    "human_review_tolerance": "medium",
    "privacy_security_constraints": ["敏感业务数据"]
  },
  "data_conditions": {
    "existing_digital_trace": true,
    "context_sources": ["业务系统", "历史文档"],
    "possible_ground_truth": ["人工审核结果"],
    "feedback_frequency": "weekly"
  },
  "outcome_metrics": ["处理时间", "错误率", "人工成本"],
  "audit_refs": ["claim_001"],
  "limitations": []
}
```

相关 lane 或方案评估节点可以输出 `CapabilityEvidence`：

```text
capability_id
capability_name
applicable_solution_refs
newly_feasible_tasks
supported_modalities
quality_latency_cost_boundary
failure_modes
deployment_constraints
human_in_the_loop_boundary
data_and_evaluation_requirements
provider_and_open_source_landscape
platform_bundle_risk
capability_half_life
baseline_gap
evidence_tier
audit_refs
limitations
```

`CapabilityEvidence` 不能单独成为正式机会，必须通过 `SolutionHypothesis` 回连 `DemandThesis`。

### Solution Hypothesis

同一 `DemandThesis` 可以对应多个解决方案，不限定为 AI 或原生 App：

```json
{
  "solution_id": "sol_001",
  "demand_id": "demand_001",
  "delivery_form": "mini_program",
  "solution_type": "consumer_workflow",
  "selected": true,
  "current_baseline_ref": "baseline_001",
  "workflow_change": "把提醒、确认、异常补救和家庭同步串成持续闭环。",
  "required_capabilities": ["notification", "shared_state", "optional_ai_anomaly_detection"],
  "capability_evidence_refs": [],
  "why_this_form": "低频使用且需要家庭分享，免安装入口优先。",
  "why_ai": "not_required",
  "outcome_metrics": ["漏服确认闭环率", "家庭重复沟通次数下降"],
  "incremental_value_over_baseline": "异步确认、状态同步和异常补救。",
  "risks": ["用户仍认为电话和微信足够"],
  "kill_criteria": ["无法证明持续使用或愿意付费"],
  "audit_refs": ["claim_001"]
}
```

声明 `uses_ai=true` 的 Solution Hypothesis 必须额外引用 AI baseline、评测可靠性、推理单位经济、数据权利和依赖风险 artifact；不声明 AI 的方案不因缺少这些字段而被抬高或降低。

### Baseline Option

`BaselineOption` 是当前方案或维持现状的正式对照项，不参与机会 TopN 排名，但所有 Solution Hypothesis 必须回答相对它的增量价值：

```text
baseline_id
current_workflow
current_cost
current_failure_modes
switching_cost
why_users_continue
minimum_incremental_value_required
audit_refs
limitations
```

## 候选机会数据模型

候选机会必须是结构化对象，避免只保存自然语言摘要。

```json
{
  "id": "opp_001",
  "discovery_profile": "industry_first",
  "research_axes": ["industry_demand", "buyer_market"],
  "title": "面向独居老人的用药提醒与家庭协同 App",
  "description": "帮助独居老人管理用药、复诊和家庭成员远程确认。",
  "opportunity_thesis": "异地子女需要低成本确认独居老人慢病用药和复诊执行情况；现有个人提醒工具缺少家庭协同和长期健康记录，因此可以从家庭协同用药提醒切入。",
  "demand_thesis_ref": "demand_001",
  "selected_solution_ref": "sol_001",
  "solution_alternatives": ["native_app", "mini_program", "mobile_web", "service_assisted"],
  "selected_delivery_form": "mini_program",
  "baseline_option_ref": "baseline_001",
  "incremental_value_over_baseline": "异步确认、家庭状态同步、漏服异常补救和长期记录。",
  "market_motion": "consumer",
  "acquisition_motion": "community",
  "buyer_model": "household_payer",
  "payment_mode": "subscription",
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
  "baseline_option": {
    "current_workflow": "电话确认、微信提醒和普通闹钟组合",
    "current_cost": "反复沟通时间和漏服风险",
    "current_failure_modes": ["无法异步确认", "记录分散", "异常后没有补救闭环"],
    "switching_cost": "家庭成员建立新记录习惯并持续同步",
    "why_users_continue": "已有工具可获得、学习成本低",
    "minimum_incremental_value_required": "持续确认和异常补救必须明显降低沟通或漏服风险"
  },
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
  "ai_capability_baseline": {
    "applies": false,
    "baseline_task": "生成用药提醒建议或照护清单",
    "prompt_tool_baseline_result": "通用模型可以生成提醒建议，但不能持续追踪执行、同步家庭状态或形成漏服补救闭环。",
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
  "decision_recommendation": {
    "decision": "prioritize",
    "decision_value_band": "high",
    "uncertainty_band": "medium",
    "recommended_next_action": "优先作为消费者家庭照护方向继续决策",
    "what_would_change_the_decision": "若电话/微信 baseline 已足够，或家庭不愿为增量价值付费，则降级为 watchlist"
  },
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
  "next_validation_suggestion": {
    "critical_assumption": "异地子女认为异步确认和异常补救的增量价值高于电话/微信的迁移成本。",
    "suggested_action": "访谈目标家庭并用轻量小程序或人工流程演示确认、同步和异常补救。",
    "success_signal": "用户能自然复述入口场景，并明确表达愿意持续使用或支付。",
    "failure_signal": "多数用户认为电话/微信已经足够，或只愿免费使用提醒功能。",
    "estimated_effort": "低成本、约 7 天"
  }
}
```

当选中的 `Solution Hypothesis` 声明依赖 AI 时，机会对象还必须包含 `ai_system_profile`：

```text
capability_enablers
demand_thesis_ref
newly_feasible_job
required_ai_capabilities
baseline_run_manifest
evaluation_dataset_and_metrics
quality_reliability_threshold
latency_and_cost_budget
human_in_the_loop_boundary
failure_cost_and_recovery
data_access_and_rights
evaluation_and_monitoring_boundary
provider_dependency_and_portability
platform_bundle_risk
inference_unit_economics
capability_half_life
defensibility_beyond_model_access
```

AI 字段不能只由模型进行文字判断。`baseline_run_manifest` 至少应记录模型/provider/version、prompt/tool setup、评测样本、指标、重复次数、失败案例、延迟、单次成本、人工审核成本和测试时间；无法实测时必须标记 `desk_research_only` 并降低置信度。

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
  "evidence_tier": "public_behavior_proxy",
  "evidence_status": "supported",
  "representativeness": "评论样本偏向主动反馈用户，不能代表全体用户",
  "evidence_role": "support",
  "user_language_role": "trigger_phrase",
  "solution_failure_role": "current_solution_failed",
  "raw_text": "用户原始评论或网页摘要，仅保存在 evidence store 中",
  "claim_refs": ["claim_001", "claim_002"],
  "sentiment": "negative",
  "relevance": 0.86,
  "credibility": 0.72,
  "valid_as_of": "2026-07-01",
  "freshness_policy": "revalidate_when_market_or_product_state_changes"
}
```

证据置信度不能只按 evidence 数量累加。多个转载、互相引用或来自同一评论样本的来源，应按低独立性处理；目标地区、发布时间、样本规模和样本偏差都应进入 confidence 计算。所有 Evidence Record 都必须有 `valid_as_of` 和 `freshness_policy`；竞品、评论、价格、法规、渠道和市场数据过期时同样触发 follow-up、limitation 或 `stale`，不能只对 AI 证据检查时效。

AI capability evidence 还必须使用同一 Evidence Record 的可选扩展字段：`valid_as_of`、`provider`、`model_id`、`model_version`、`pricing_snapshot`、`license`、`benchmark_setup`、`deployment_region`、`vendor_claim_or_independent_test`、`reproducibility` 和 `freshness_policy`。source manifest evaluator 应按 evidence type 检查 freshness；模型价格、API 限制、平台政策或 capability benchmark 过期时触发 follow-up 或 limitation，不能继续支撑强推荐。

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

每条 lane 独立输出结构化候选和保留决策，不固定输出 topN：

```text
LaneResult
  - lane_name
  - findings
  - claims
  - supporting_claims
  - opposing_claims
  - insights
  - demand_theses
  - solution_hypotheses
  - baseline_options
  - scored_candidates
  - kill_conditions
  - pre_kill_decisions
  - retained_candidates
  - candidate_diversity_summary
  - audit_refs
```

lane 内筛选前必须执行 pre-kill gate。每个候选至少有一个明确的可推翻条件；如果反证强度超过支持证据，或者买单方、替代方案、触达路径、合规边界无法说明，应进入 rejected/watchlist。其他候选按证据阈值和多样性保留到 cross-lane 合并阶段，不能只因 lane 内相对分数较低而过早删除。

维度内评分可以采用 0-10 分作为 lane 内 triage 信号，但不能跨 lane 直接比较，也不能解释为概率；每个分数必须保留理由、证据充分性和不确定性：

```json
{
  "candidate_ref": "demand_001",
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
所有 lane retained Demand/Solution candidates
  -> user/job/scene/baseline/solution embedding
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

综合评分不应简单平均所有 lane 分数，也不应把单一 `global_score` 当成创业价值的客观真值。排序应先执行 hard gate，再结合证据充分性、baseline 增量价值、交付形态、决策价值、下行风险和关键未知数输出推荐档位。`global_score` 只作为可解释的辅助排序输入；当机会区间重叠时，应输出部分序或“接近无法区分”，而不是强行制造精确名次。

建议全局评分维度：

| 维度 | 参考重要性 | 说明 |
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
| 付费和商业化 | 7% | 是否有付费意愿、订阅、交易、家庭代付、赞助支付或渠道变现 |
| 获客可行性 | 7% | 是否有清晰低成本触达渠道 |
| 切入版本可行性 | 6% | 小团队是否能在合理时间内验证 |
| 验证可行性 | 6% | 7-30 天内是否能用访谈、落地页、原型或人工服务验证 |
| 自然复述可验证性 | 5% | 是否能通过用户复述确认 mental positioning 成立 |
| AI 基线差距 | 6% | 若依赖 AI，是否明显优于通用模型 + prompt/tool baseline 和平台原生能力；不依赖时标记 `not_applicable` 并按 profile 重新归一化权重 |
| 差异化空间 | 6% | 是否能建立清晰定位或壁垒 |
| 时机窗口 | 4% | 为什么现在是较好的进入时点 |
| 替代方案风险 | -6% | 用户当前替代方案是否已经足够好 |
| 能力商品化风险 | -7% | 核心能力是否会被模型升级、平台内置、API 降价或竞品功能快速抹平 |
| 竞争风险 | -5% | 竞争强度、巨头风险、同质化风险 |
| 合规和平台风险 | -5% | 政策、医疗、金融、数据隐私等风险 |
| 判断置信度 | 10% | claim/finding/insight 的来源质量、一致性和覆盖度 |

上表只表达候选判断维度，不要求所有 profile 使用相同权重，也不要求各项线性相加为 100%。需求强度、用户语言、解法失效、入口场景等相关维度必须由 scoring profile 处理去重或相关性折减；`selected_solution` 必须与 `baseline_option` 比较增量价值。

实际 system capability 应按以下顺序计算：

```text
hard gates
  -> evidence sufficiency / uncertainty band
  -> baseline delta and outcome value
  -> expected decision value
  -> downside / upside / speed-to-learn
  -> robust rank or partial-order recommendation
```

`scoring_profile` 必须记录 rule version、输入快照、hard gate 触发原因、相关性处理、区间扰动和推荐档位上限。没有证据支持的维度不得用默认中性高分补齐。

评分输出必须包含解释、档位、决策价值区间、敏感性分析和排名稳定性；`rank` 只在结果稳健时提供：

```json
{
  "opportunity_id": "opp_001",
  "score_band": "strong_candidate",
  "global_score": 8.1,
  "confidence_score": 7.6,
  "decision_value_band": "high",
  "uncertainty_band": "medium",
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
    "ai_baseline_gap": null,
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
  "recommendation": "建议优先投入研究/决策",
  "next_validation_suggestion": {
    "critical_assumption": "baseline 方案无法低成本完成异步确认",
    "suggested_action": "对目标家庭做低成本访谈和轻量流程演示",
    "success_signal": "能自然复述入口场景并表达持续使用/付费意愿",
    "failure_signal": "多数用户认为电话或微信已经足够"
  },
  "rationale": "该方向痛点明确、切入版本较轻、评论和竞品缺口相关判断一致，但存在健康数据和老年用户使用门槛。"
}
```

AI profile 还必须输出以下详细指标；它们由独立 score input 生成，不能藏在 `differentiation` 或自然语言 rationale 中：

| AI 指标 | 说明 |
|---------|------|
| `capability_delta` | 相比通用模型、现有平台和开源方案，质量、成本、速度或覆盖范围的真实增量 |
| `technical_reliability` | 在目标任务分布上的成功率、稳定性、异常率和可恢复性 |
| `evaluation_feasibility` | 是否有代表性评测集、ground truth、可重复指标和上线监控 |
| `data_readiness` | 数据是否存在、可授权、可持续更新并能形成反馈闭环 |
| `human_review_dependency` | 人工复核比例、专业要求、处理时延和成本负担 |
| `inference_unit_economics` | 推理、检索、存储、工具调用、人工审核和支持成本后的毛利空间 |
| `provider_portability` | 是否可跨模型/provider/开源方案迁移，关键接口和数据是否被锁定 |
| `platform_bundle_risk` | 模型厂商、操作系统、头部消费者 App 或平台原生内置的替代风险 |
| `open_source_substitution_risk` | 开源模型和组件达到可接受水平后，能力差异是否快速消失 |
| `data_feedback_moat` | 使用数据、纠错、评测和工作流状态是否形成可授权的持续改进闭环 |
| `capability_half_life` | 当前能力窗口预计能维持多久，模型升级对机会是增强还是替代 |
| `ai_adoption_trust` | 安全、隐私、可解释性、家庭责任和消费者信任是否允许进入目标工作流 |

这里的 `data_feedback_moat` 指候选产品自身是否能从用户授权数据、纠错和工作流状态中形成持续改进条件，不表示本 Feature 要追踪创业结果或建立跨 Run Business Outcome 反馈闭环。

AI hard gate 在加权排序前执行：

- 通用模型、平台原生能力或低成本开源方案已达到目标质量，且没有工作流、数据、分发或结果责任差异时，判为 `reject` 或 `watchlist`。
- 高错误成本任务缺少可重复评测、审计、异常检测、人工兜底或责任边界时，不能进入 `strong_candidate`。
- 关键数据无法合法、持续获取，或没有可用 ground truth/反馈机制时，不能把“数据壁垒”计入正向得分。
- 推理、工具调用和人工审核后的单位经济不成立时，触发 kill condition。
- 单一 provider/platform 可在短窗口内内置核心能力，且缺少可迁移性、渠道或系统壁垒时，限制最高推荐档位。
- AI 只改变 output 样式，没有改善 workflow/outcome 指标时，不能进入强推荐。

推荐档位建议：

| 档位 | 含义 |
|------|------|
| `strong_candidate` | 证据、买单方、selected solution、baseline 增量和决策依据较清晰，建议优先关注 |
| `quick_validation` | 方向有潜力，但关键假设仍不足；报告提供轻量验证建议 |
| `watchlist` | 趋势或需求存在，但证据、时机或商业化不足 |
| `reject` | 反证、替代方案、合规风险或获客成本足以否定当前机会 |

## 系统模块划分

这一节是领域模型说明，不代表在 Icarus 项目中新增第二套 workflow engine。落地到 Icarus 仓库（`/Users/chelaile/IdeaProjects/icarus`）时，下面这些模块应映射为 workflow delegation、skill、host 侧 MCP 工具和少量 deterministic action。

```python
class OpportunityDiscoveryWorkflow:
    async def run(self, direction: str):
        scope = await self.frame_scope(direction)
        plan = await self.plan_research(direction, scope)
        seeds = await self.probe_research_seeds(direction, scope, plan)
        opportunity_space = await self.map_opportunity_space(direction, scope, seeds)
        solution_space = await self.map_solution_space_if_enabled(scope, seeds, opportunity_space)
        discovery_graph = await self.plan_discovery_graph(plan, seeds, opportunity_space, solution_space)
        discovery = await self.execute_workflow_graph(discovery_graph)
        followup_graph = await self.plan_followup_graph(discovery)
        followup = await self.execute_workflow_graph(followup_graph)
        discovery = await self.merge_graph_results(discovery, followup)
        validated = await self.validate_discovery_fan_in(discovery)
        solutions = await self.evaluate_solution_hypotheses(validated, solution_space)
        thesis = await self.synthesize_opportunity_theses(validated, solutions)
        merged = await self.merge_and_cluster(thesis)
        enrichment_graph = await self.plan_enrichment_graph(merged)
        enrichment = await self.execute_workflow_graph(enrichment_graph)
        normalized = await self.normalize_judgment_context(enrichment)
        enriched = await self.build_scoring_context(normalized)
        ranked = await self.global_rank(enriched)
        sensitivity = await self.analyze_score_sensitivity(ranked)
        decision = await self.build_decision_recommendation(sensitivity)
        suggestions = await self.build_validation_suggestions(decision)
        report = await self.write_final_report(direction, decision, suggestions)
        return report
```

概念验证是独立宏观流程，不继承上述 TopN discovery pipeline：

```python
class ConceptMarketValidationWorkflow:
    async def run(self, concept: ProductConcept):
        hypothesis = await self.frame_hypothesis(concept)
        plan = await self.plan_validation(hypothesis)
        validation_graph = await self.plan_validation_graph(hypothesis, plan)
        evidence = await self.execute_workflow_graph(validation_graph)
        followup_graph = await self.plan_bounded_followup(hypothesis, evidence)
        evidence = await self.execute_and_merge_if_needed(evidence, followup_graph)
        reviewed = await self.adversarial_review(hypothesis, evidence)
        verdict = await self.calculate_verdict(reviewed)
        suggestions = await self.build_validation_suggestions(verdict)
        return await self.write_concept_report(hypothesis, verdict, suggestions)
```

以上 Python 只表达领域阶段，不是第二套执行器；每个宏观阶段映射到 Workflow Definition State，每个动态调研或 enrichment 集合映射到 graph state 内的 Graph Node。验证建议只是最终报告字段，不创建验证执行 Graph。

### Scope Framer

负责把宽泛输入转成明确的研究边界和默认假设：

```python
class ScopeFramer:
    async def frame(self, direction: str, user_constraints: dict | None) -> ScopeFrame:
        ...
```

输出包括：

- 目标市场、地区、语言和平台。
- 消费者交付形态、商业模式偏好、market motion 和 buyer model。
- 团队能力、预算和验证周期。
- 风险偏好和行业限制。
- `discovery_profile`、`research_axes`、解决方案能力范围和部署偏好。
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
- 每条 lane 的候选保留阈值、多样性约束和预算边界，而不是固定 topN 截断。
- 是否需要行业特定维度。
- 是否启用 AI capability evidence lens，以及哪些候选 Solution Hypothesis 需要 AI baseline 评估。
- 好机会判定标准、baseline 对照、mental positioning 规则、kill gate 规则、评分 profile、证据充分性和敏感性分析参数。

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
  "source_seeds": ["App Store", "Google Play", "小红书", "知乎", "Reddit", "宠物论坛"],
  "capability_seeds": [],
  "model_ecosystem_seeds": []
}
```

seed 只用于扩大检索入口，不能成为候选机会的先验真值。Planner 必须保留一部分 seed-independent exploration budget：至少一个需求/任务 lane 只读取 scope，不读取 product/capability seed；至少一个 counterfactual lane 主动寻找与初始假设不同的人群、任务或替代方案。`initial_demand_hypotheses` 只能作为待推翻问题，不能约束所有后续 query，也不能直接进入正式评分。

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
- 当前替代方案、workaround、Baseline Option 和消费者交付形态候选。
- 工作流摩擦点、task step、task operating profile 和可软件化节点。
- 任务频率、规模、输入输出模态、变化程度、异常率、上下文碎片、错误成本、延迟和人工审核容忍度。
- 用户状态、上下文连续性、协作对象和数据沉淀机会。
- 用户触发语言、买单方购买语言和 purchase trigger 假设。
- 初始 Demand Thesis、Solution Hypothesis 和待推翻问题；不能直接生成正式机会。

### Solution Space Mapper

负责在 discovery 并行前建立解决方案空间地图。`ai_capability` lens 启用时，额外把近期 AI 能力、成本、部署和生态变化整理为候选 Solution Hypothesis 的 Capability Evidence：

```python
class SolutionSpaceMapper:
    async def map(
        self,
        direction: str,
        scope: ScopeFrame,
        seed_context: SeedProbe,
    ) -> SolutionSpaceMap:
        ...
```

输出包括 native app / mini program / mobile web / hybrid / assisted validation 等消费者交付形态、普通软件/平台/人工/AI-assisted 方案候选，以及适用时的 capability frontier、newly feasible tasks、质量/延迟/成本边界、失败模式、部署条件、human-in-the-loop 边界、数据和评测要求、provider/open-source/platform landscape、capability half-life 和待推翻问题。它不得直接输出“创业机会”。

### User Language Miner

作为 `user_language_mining` discovery lane node 的实现，负责从 UGC、评论、问答和访谈材料中挖掘用户真实语言和候选 mental positioning：

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

作为 `solution_failure` discovery lane node 的实现，负责识别现有解法在哪些场景失效，以及用户失败后的 next action：

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

    async def generate_demand_and_solution_hypotheses(
        self,
        insights: list[Insight],
    ) -> list[DemandThesis | SolutionHypothesis]:
        ...

    async def score_candidates(
        self,
        candidates: list[DemandThesis | SolutionHypothesis],
    ) -> list[LaneScoredCandidate]:
        ...

    async def pre_kill_candidates(
        self,
        candidates: list[DemandThesis | SolutionHypothesis],
    ) -> list[PreKillDecision]:
        ...
```

每个 Discovery Lane 必须输出支持 claims、反对 claims、uncertainties、kill conditions、trigger phrase refs 和 solution failure refs。所有 profile 的 lane 都可以输出 Demand Thesis 或 Solution Hypothesis；声明依赖 AI 的方案才携带 Capability Evidence。反证强、证据不足或与 baseline 没有明确增量的对象应被降级，不应进入正式推荐。

### Solution Hypothesis Evaluator

负责把 Demand Thesis 下的多个 Solution Hypothesis 与 Baseline Option 进行显式比较，避免由 Opportunity Thesis Synthesizer 隐式把 AI 套到所有痛点上：

```python
class SolutionHypothesisEvaluator:
    async def evaluate(
        self,
        demands: list[DemandThesis],
        solutions: list[SolutionHypothesis],
        baselines: list[BaselineOption],
    ) -> SolutionEvaluationResult:
        ...
```

输出 `selected_solutions`、`alternative_solutions`、`baseline_comparison`、`rejected_solutions`、`solution_rationale`、`critical_unknowns` 和审计引用。每个 AI 方案必须说明 capability delta、baseline gap、可自动化/增强的 task step、剩余人工边界、预期 outcome、失败成本、单位经济和平台/商品化风险；非 AI 方案不需要伪造 AI 字段。

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

每个 thesis 必须包含 `demand_thesis_ref`、`selected_solution_ref`、`solution_alternatives`、`baseline_option_ref`、`selected_delivery_form`、`user`、`job_to_be_done`、`pain`、`current_alternatives`、`incremental_value_over_baseline`、`buyer`、`payer`、`buyer_purchase_language`、`marketing_bridge`、`mental_positioning`、`trigger_phrase`、`entry_scene`、`solution_failure_scene`、`next_action_after_failure`、`mental_position_occupation`、`value_layer`、`user_state_context_model`、`entry_wedge`、`why_now`、`distribution_path`、`capability_commoditization_risk`、`kill_criteria` 和 `next_validation_suggestion`。只有声明依赖 AI 的 selected solution 才必须包含 `ai_system_profile`。

### OpportunityClusterer

负责跨 lane 去重、聚类、合并：

```python
class OpportunityClusterer:
    async def merge(self, theses: list[OpportunityThesis]) -> list[MergedOpportunity]:
        ...
```

### JudgmentEnricher

负责对合并后的机会规划补充判断和风险核验节点，并把新增材料提炼为 claim、finding、insight 和 score input。落地时它对应 dynamic enrichment graph 中的一组可并行、可依赖、可条件跳过的 graph node，而不是单个串行服务：

```python
class JudgmentEnricher:
    async def plan_graph(self, opportunities: list[MergedOpportunity]) -> WorkflowGraphSpec:
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
- AI capability benchmark 和 prompt/tool baseline
- 评测可靠性、错误检测、人工审核边界和失败恢复
- 推理、检索、工具调用、存储和人工审核后的单位经济
- 数据权利、ground truth、可监控性、provider 可迁移性和平台依赖
- 能力商品化风险，包括模型升级、平台内置、API 降价和开源替代
- output/workflow/outcome 价值层判断
- 用户状态、上下文连续性、数据闭环和隐私边界
- 买单语言、预算来源、决策标准和用户语言到购买语言的映射

### AI Capability Benchmarker

作为 `ai_capability_benchmark` enrichment node 的实现，负责验证 AI 相关机会是否真的超出通用模型、prompt/tool baseline、平台原生能力和开源替代的能力范围：

```python
class AICapabilityBenchmarker:
    async def benchmark(self, opportunities: list[MergedOpportunity]) -> list[AIBaselineResult]:
        ...
```

输出包括：

- 每个机会的 AI 依赖点和目标 task step。
- baseline models/tools、prompt/tool setup 和代表性 evaluation dataset。
- 质量、成功率、失败类型、方差、延迟、单次成本和人工审核成本。
- 通用模型、现有平台或开源方案是否已经足够解决核心任务。
- 产品需要补足的工作流、数据、执行、合规或分发能力。
- model upgrade risk、capability half-life 和剩余差距。

无法进行可复现实测时必须设置 `desk_research_only=true`，不能用厂商自报 benchmark 直接替代目标任务评测。

### Value, Context and Buyer Language Enricher

作为 `workflow_outcome_value`、`state_context_continuity` 和 `buyer_purchase_language` enrichment node 的通用能力说明，负责把候选机会从“用户喜欢的功能”转成可购买、可留存、可验证的产品假设：

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

### Validation Suggestion Builder

负责把推荐机会转成报告中的轻量验证建议，不执行或追踪验证动作：

```python
class ValidationSuggestionBuilder:
    async def build(
        self,
        ranked: list[RankedOpportunityWithSensitivity],
    ) -> list[ValidationSuggestion]:
        ...
```

每个机会只在关键假设仍不足以支持强推荐时提供一条或少量建议，包含 `critical_assumption`、`suggested_action`、`target`、`success_signal`、`failure_signal` 和 `estimated_effort`。它可以建议访谈、自然复述、价格承诺、轻量流程演示或 AI baseline spike，但不创建 Experiment、执行验证或回写业务结果。

### Reporter

负责最终报告生成：

```python
class OpportunityReporter:
    async def write(
        self,
        direction: str,
        decision_recommendation: DecisionRecommendation,
        validation_suggestions: list[ValidationSuggestion],
    ) -> str:
        ...
```

报告结构建议：

```text
# 创业机会调研报告

## 结论摘要
## Scope Assumptions
## Discovery Profile 与 Research Axes
## 决策建议
## 组合建议：first bet、alternative bets、资源冲突和共享渠道
## 排名总览
## 研究方法
## Top 机会详解
  - 机会 thesis
  - mental positioning、trigger phrase 和 entry scene
  - 目标用户、买单方、付费方和决策者
  - market motion、buyer model、acquisition motion 和 payment mode
  - JTBD 和当前工作流
  - 核心痛点
  - 现有解法失效场景和 next action
  - 当前替代方案、Baseline Option 和增量价值
  - 消费者交付形态比较：原生 App、小程序、Web/PWA、hybrid 或人工辅助验证
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
  - 决策建议、关键未知数和可选轻量验证建议
  - AI capability evidence 与 selected solution 评估（适用时）
  - 通用模型/平台/开源 baseline 实测（适用时）
  - 质量、可靠性、延迟、推理与人工审核单位经济（适用时）
  - 数据权利、评测可监控性、provider 可迁移性和平台内置风险（适用时）
## 被筛掉的机会
## 观察池机会
## 用户自然语言和心智定位摘要
## 现有解法失效场景地图
## AI 能力证据与解决方案评估摘要（适用时）
## 不确定性、关键假设和可选验证建议
## 审计追踪和参考来源
```

最终报告的正文应围绕创业判断展开，避免按证据逐条综述。原始 evidence 只通过 traceability、附录、脚注或审计追踪出现；正文主要使用 Demand Thesis、Solution Hypothesis、baseline comparison、opportunity thesis、mental positioning、trigger phrase、entry scene、solution failure map、insight、score breakdown、risk、counter evidence、sensitivity analysis、decision recommendation 和可选 validation suggestion 等结构化结果。报告必须允许给出“不建议首发独立 App，建议从小程序、Web/PWA、人工辅助流程或继续维持现有方案”的结论。

## Icarus 落地设计

### 框架依赖

本方案不新增第二套 Opportunity workflow engine。通用 workflow runtime 的改造，包括：

- Task Intake、Recipe Catalog、受限 Macro Router 与幂等 Workflow 创建。
- 外层 State 到统一 Graph Runtime 的 lowering；不存在 parallel state。
- runtime-generated graph state。
- pure graph compiler 与 planner dry-run evaluator。
- graph run/node/edge 持久化。
- node-level delegation、artifact contract、evaluator、quality gate。
- join policy、fan-in context、branch/node retry、checkpoint。
- Workflow lifetime budget、RuntimeSafetyCeilings、Feature draining/version retention。
- Workbench/Trace 对 ready-node concurrency 和 dynamic DAG 的可观测性。

统一由 `local/docs/dynamic-workflow-dag-framework.md` 定义。

创业机会调研 recipe 只负责在该框架之上定义业务节点、skill、artifact、evaluator、评分规则和报告结构。执行形态是：

```text
Icarus workflow = 唯一编排层
  trusted states = scope、planning、synthesis、report 等外层控制
  dynamic graph state = 本次调研的发现、补充验证、反证、复核和 follow-up DAG
  delegation capability node = LLM 推理、规划、抽取、综合、报告
  system capability node = schema/score/validate/dedupe/reduce 等确定性操作
  capability = 固定 executor、role/skill、prompt、ports、权限、artifact/evaluator/effect
  host MCP tool = 可审计、可复用、确定性的领域工具
  artifact contract + evaluator = capability 固定的节点质量门
```

Planner state 发布 candidate Scope Spec 时，capability evaluator 使用同一个 Graph Compiler 做 dry-run 并把 structured diagnostics 反馈为 `needs_revision`。下一 graph state 的 T1/T2 冻结该 artifact ref/hash 并正式编译；不设置独立 `*_graph_compile` system state，也不保存两份可漂移 plan。

### Research Kernel

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

它不应该是第二个线程服务或第二个编排器，而是 `startup-opportunity` Feature 内的 host 侧领域工具模块：

```text
features/startup-opportunity/host/opportunity-recon/types.ts
features/startup-opportunity/host/opportunity-recon/evidence-store.ts
features/startup-opportunity/host/opportunity-recon/report-writer.ts
features/startup-opportunity/host/opportunity-recon/request-dispatcher.ts
features/startup-opportunity/host/opportunity-recon/research-kernel.ts
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

### Feature Package 与 Workflow 定义

Startup Opportunity 必须像 PM Pipeline 一样作为 Feature Package 接入，不能把领域 host、workflow、skill 或 contract 静态写进 core：

```text
features/startup-opportunity/
  feature.json
  host/
    index.ts
    api.ts
    opportunity-recon/
  renderer/
  container/
    workflow-definitions/
      startup_opportunity_opportunity_discovery.json
      startup_opportunity_concept_validation.json
    workflow-recipes/
    workflow-routing-scopes/
    workflow-routing-capabilities/
    workflow-execution-policies/
    workflow-capabilities/
    workflow-schemas/
    workflow-graph-interfaces/
    workflow-graph-templates/
    workflow-graph-policies/
    workflow-wait-contracts/
    artifact-contracts/
    workflow-evaluators/
    agents/
    skills/
    mcp/
```

两个 Definition 分别固定机会发现和概念验证的外层 State、named exit、error/cancel route 和 report contract。机会发现 Definition 内允许通过 typed `discovery_profile` / `research_axes` 选择需求、市场和解决方案证据 lane，但不能改变决策建议的宏观目标；概念验证始终输出单 thesis verdict。它们可以共享 exact capability refs，但不能让 Planner 在运行时把一种宏观流程改成另一种。Feature manifest 必须声明上述 Graph resource 目录；这依赖 Dynamic Framework 对 `FeatureResources` parser/registry 的同步扩展。

```json
{
  "id": "startup-opportunity",
  "version": "1.0.0",
  "resources": {
    "workflowDefinitions": "./container/workflow-definitions",
    "workflowRecipes": "./container/workflow-recipes",
    "workflowRoutingScopes": "./container/workflow-routing-scopes",
    "workflowRoutingCapabilities": "./container/workflow-routing-capabilities",
    "workflowExecutionPolicies": "./container/workflow-execution-policies",
    "workflowCapabilities": "./container/workflow-capabilities",
    "workflowSchemas": "./container/workflow-schemas",
    "workflowGraphInterfaces": "./container/workflow-graph-interfaces",
    "workflowGraphTemplates": "./container/workflow-graph-templates",
    "workflowGraphPolicies": "./container/workflow-graph-policies",
    "workflowWaitContracts": "./container/workflow-wait-contracts",
    "artifactContracts": "./container/artifact-contracts",
    "workflowEvaluators": "./container/workflow-evaluators",
    "agents": "./container/agents",
    "skills": "./container/skills",
    "mcp": "./container/mcp"
  }
}
```

建议 capability publisher 使用的 persona roles（不是 Graph Source 字段）：

```text
opportunity_scope_framer
opportunity_planner
opportunity_seed_researcher
opportunity_space_mapper
solution_space_mapper
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
ai_capability_benchmark_researcher
ai_evaluation_reliability_researcher
ai_unit_economics_researcher
ai_data_dependency_researcher
solution_hypothesis_evaluator
opportunity_thesis_synthesizer
opportunity_synthesizer
opportunity_decision_recommender
opportunity_validation_suggestion_builder
opportunity_reviewer
opportunity_reporter
```

建议 artifacts：

```text
scope-frame.json
research-plan.json
seed-probe.json
opportunity-space-map.json
solution-space-map.json
discovery-graph-spec.json
discovery-graph-fan-in.json
demand-theses.json
solution-hypotheses.json
baseline-options.json
user-language-mining.json
audience-pain-lane.json
job-to-be-done-lane.json
top-products-lane.json
review-mining-lane.json
search-demand-lane.json
trend-lane.json
substitutes-workarounds-lane.json
solution-failure-map.json
opportunity-theses.json
merged-opportunities.json
enrichment-graph-spec.json
enrichment-graph-fan-in.json
competitor-gap-enrichment.json
market-size-enrichment.json
monetization-enrichment.json
acquisition-enrichment.json
compliance-risk-enrichment.json
counter-evidence-enrichment.json
feasibility-unit-economics-enrichment.json
ai-capability-benchmark.json
ai-evaluation-reliability.json
ai-inference-unit-economics.json
ai-data-dependency.json
capability-commoditization-risk.json
workflow-outcome-value-enrichment.json
state-context-continuity-enrichment.json
buyer-purchase-language-enrichment.json
enrichment-fan-in.json
normalized-judgment-context.json
ranking.json
sensitivity-analysis.json
decision-recommendation.json
validation-suggestions.json
startup-opportunity-report.md
traceability.json
concept-frame.json
concept-validation-plan.json
concept-validation-graph-spec.json
concept-validation-fan-in.json
concept-hypothesis-evaluation.json
concept-verdict.json
concept-validation-suggestions.json
concept-validation-report.md
```

机会发现 Definition 的建议 workflow states：

```text
scope_framing               delegation  明确市场、消费者交付形态、market/acquisition/payment motion、buyer model、团队能力、风险偏好、discovery profile、research axes 和默认假设
research_plan               delegation  规划需求/市场/解决方案证据 lane、query、数据源、候选保留阈值、多样性、评分 profile、证据充分性和 Research Kernel 参数
seed_probe                  delegation  轻量探测用户、场景、问题、关键词、产品、数据源和 capability/model/ecosystem seed
opportunity_space_map       delegation  建立用户角色、JTBD、工作流、替代方案、Baseline Option、task operating profile、可软件化节点和初始需求假设
solution_space_map          delegation  建立消费者交付形态、普通/人工/平台/AI-assisted 方案候选和适用的 capability evidence；不能直接生成机会
discovery_graph_plan        delegation  基于 scope、seed、opportunity space 和 solution space 生成 discovery DAG spec；capability evaluator 做 compiler dry-run
discovery_graph_execute     graph       执行本次 discovery DAG，可能包含并行、依赖、条件、join 和局部 retry
discovery_gap_analysis      delegation  基于 fan-in context 识别证据缺口、冲突、弱判断和需要补充的机会
followup_graph_plan         delegation  按缺口生成可选 follow-up DAG spec；capability evaluator 做 compiler dry-run
followup_graph_execute      graph       执行补充调研、反证或复核节点；无补充需求时可跳过
lane_result_validate        system      校验 Demand Thesis/Solution Hypothesis、Baseline Option、evidence ref、support/opposition、kill conditions、证据充分性和候选多样性
solution_hypothesis_evaluate delegation  比较候选解决方案与 Baseline Option；AI 方案按声明依赖执行 baseline、可靠性、单位经济和依赖风险检查
opportunity_thesis          delegation  将 Demand Thesis 和 selected Solution Hypothesis 转成可审计 thesis，补齐买单方、定位、交付形态、增量价值、解法失效、entry wedge、why now、kill criteria 和 AI system profile（适用时）
opportunity_merge           delegation  语义合并、拆分判断、判断依据聚合
enrichment_graph_plan       delegation  基于合并机会生成 enrichment / validation DAG spec；capability evaluator 做 compiler dry-run
enrichment_graph_execute    graph       执行竞品、市场、商业化、获客、合规、反证、替代方案、可行性、AI baseline/可靠性/单位经济/依赖、能力商品化、价值层、状态上下文和买单语言等节点
judgment_context_normalize  system      URL/source/product/evidence ref/claim/finding/insight 归一化和 deterministic dedupe
global_score                system      按 versioned scoring profile 执行 hard gate、证据充分性、baseline delta、评分、排序和推荐档位
sensitivity_analysis        system      权重、关键假设、证据区间扰动、rank stability 和 rank range 计算
decision_recommendation     delegation  基于结构化判断、反证、baseline comparison、敏感性分析和不确定性生成决策建议
quality_review              delegation  审核判断链、反证、证据充分性、decision readiness、评分解释、limitations 和报告一致性
validation_suggestions      delegation  只在关键假设不足时生成一条或少量轻量验证建议；不执行、不追踪、不回写业务结果
final_report                delegation  输出 Markdown 报告、JSON 报告和 traceability
done                        terminal
```

概念验证 Definition 的建议 workflow states：

```text
concept_framing             delegation  把已有产品想法规范为单一 hypothesis、assumptions、unknowns 和 kill criteria
validation_plan             delegation  选择本次 desk research 的验证维度、证据标准、预算和 follow-up bound；不是外部实验计划
validation_graph_plan       delegation  生成 hypothesis-led validation Scope Spec；evaluator 做 compiler dry-run
validation_graph_execute    graph       并发执行需求、替代、竞品、付费、获客、可行性、合规和反证节点；AI profile 强制执行 AI validation bundle
validation_gap_analysis     delegation  识别会改变 verdict 的证据缺口
followup_graph_plan         delegation  只为关键缺口生成 bounded follow-up Scope Spec
followup_graph_execute      graph       可选补充验证；无需求时由 Definition route 跳过
hypothesis_reduce           system      按 hypothesis id 归一、去重和生成确定性 completeness metrics
adversarial_review          delegation  检查确认偏误、证据独立性、替代方案和 kill criteria
concept_verdict             system      根据 versioned deterministic rule 输出 go/conditional_go/no_go/insufficient_evidence
validation_suggestions      delegation  生成访谈、定价、落地页、concierge、baseline 等轻量建议，不执行验证动作
concept_report              delegation  输出单 thesis JSON/Markdown 与 traceability
done                        terminal
```

Discovery graph 的默认 lane catalog：

```text
# 需求与市场侧
audience_pain              受众需求痛点
user_language_mining       用户真实语言与心智定位
job_to_be_done             JTBD 与任务流拆解
top_products               已有产品 Top 排名挖掘
review_mining              用户评论与差评挖掘
search_demand              搜索需求与内容缺口
trend_change               趋势变化
substitutes_workarounds    替代方案与非 App 竞争
solution_failure           现有解法失效场景

# 解决方案证据侧，仅相关候选或 research_axes 包含 ai_capability 时可选
ai_capability_frontier     新能力、能力边界、失败模式和 newly feasible tasks
ai_cost_curve_access       质量、延迟、上下文、成本、端侧/云端和开源可用性
ai_workflow_automation     task step 自动化/增强与 human-in-the-loop 边界
ai_ecosystem_platform      provider、平台、集成生态、分发和 bundling 风险
ai_data_eval_flywheel      数据权利、ground truth、评测和反馈闭环
ai_adoption_trust          安全、隐私、可解释性、家庭责任和消费者信任障碍
```

这些 lane 是 Recipe allowlist 内的 capabilities，不是每次固定全量执行。`industry_first` 主要启用需求/市场侧；`ai_first` 和 `hybrid` 可以提高 capability seed、方案证据和 AI baseline 的优先级，但所有正式候选仍必须先有 Demand Thesis，并比较 AI 与非 AI/人工/platform 方案。不能只运行能力证据 lane 生成强推荐。`discovery_graph_plan` 必须根据 scope、profile、research axes、seed、机会空间、数据可得性和预算生成本次 Scope Spec，决定启用哪些 lane、是否实例化 bounded domain-specific lane、节点之间的依赖、并发关系、join policy 和 follow-up 条件；不能声明新 role/skill/tool 或 node-local artifact/evaluator。

`seed_probe` 不应把业务流程变成产品中心调研。`product_seed` 只作为产品相关 node 的输入；非产品 node 仍可独立从用户心智、搜索需求、社区讨论、任务流、替代方案和趋势变化中发现尚未被现有产品覆盖的强需求。后续的产品覆盖分析用于验证 coverage gap，而不是要求所有机会都来自已有产品缺口。

Enrichment graph 的默认 lane catalog：

```text
competitor_gap              竞品覆盖、满意度、迁移阻力
market_size                 市场空间、增长、用户规模
monetization                定价、付费意愿、商业模式
acquisition                 SEO、社区、渠道、平台获客
compliance_risk             政策、医疗、金融、隐私、平台风险
counter_evidence            反证、替代方案、失败案例
feasibility_unit_economics  小团队可行性、交付复杂度和早期单位经济
ai_capability_benchmark     通用模型/平台/开源 + prompt/tool baseline、目标任务实测和模型升级风险
ai_evaluation_reliability   评测集、ground truth、成功率、异常、审计、人工兜底和恢复
ai_inference_unit_economics 推理、检索、工具、存储、人工审核和支持成本后的单位经济
ai_data_dependency          数据权利、反馈闭环、provider portability 和平台依赖
capability_commoditization  模型、平台、API、开源和竞品更新导致的能力商品化风险
workflow_outcome_value      output/workflow/outcome 价值层和 outcome metric
state_context_continuity    用户状态、上下文连续性、数据闭环和隐私边界
buyer_purchase_language     买单语言、预算来源、决策标准和 marketing bridge
```

Enrichment graph 同样不是固定全量 node。planner 应按机会类型、证据缺口和风险选择节点；非 AI 机会可以跳过 AI bundle，AI/hybrid profile 的 AI 候选必须执行 `ai_capability_benchmark`、`ai_evaluation_reliability`、`ai_inference_unit_economics` 和 `ai_data_dependency`，强监管 AI 还必须执行合规和对抗式反证。买单方不清晰时必须增加 buyer purchase language 节点。

所有实际执行的 lane、enrichment、review 和 follow-up 节点都必须落在通用 Dynamic Workflow DAG 框架的 graph run 中，而不是藏在单个 agent 节点内部。内部子任务可以作为 agent 自己的执行优化，但不能替代 workflow 层对 node 状态、产物、评测、retry 和 limitations 的可观测性。

### Graph Interface、Named Exit 与 Capability Bundle

动态结构不等于动态合同。每类 graph state 必须引用固定 versioned interface：

```text
startup-opportunity.opportunity-discovery-graph@1
  inputs: scope_frame, research_plan, seed_probe, opportunity_space_map, solution_space_map
  exits:
    completed(branch_results, demand_theses, solution_hypotheses, baseline_options, candidate_opportunities, judgment_context, source_manifest)
    partial(branch_results, demand_theses, solution_hypotheses, baseline_options, candidate_opportunities, failed_branches, evidence_gaps)
    insufficient_evidence(limitations, attempted_sources)

startup-opportunity.concept-validation-graph@1
  inputs: concept_hypothesis, validation_plan
  exits:
    completed(hypothesis_evidence_matrix, source_manifest)
    partial(hypothesis_evidence_matrix, evidence_gaps)
    insufficient_evidence(limitations, attempted_sources)

startup-opportunity.followup-graph@1
  inputs: subject_kind, subject_ref, bounded_gaps
  exits: completed | partial | no_followup_needed | insufficient_evidence
```

Definition 必须完整覆盖 named exits：opportunity discovery `completed -> lane_result_validate -> solution_hypothesis_evaluate/opportunity_thesis`、`partial -> discovery_gap_analysis`、`insufficient_evidence -> manual_review/report limitation`；概念 validation `completed -> hypothesis_reduce`、`partial -> validation_gap_analysis`、`insufficient_evidence -> concept_verdict`。Engine error、local cancel 和 global cancel 使用框架独立可信路径，不能伪装成业务 `insufficient_evidence`。

Feature 发布的每个 capability 固定 exact executor/role/skills/prompt skeleton、typed ports、artifact/evaluator/quality gate、tool/MCP/file scope、retry/timeout、effect/cancellation contract。Research capability 原则上 `pure` 或只通过幂等 evidence MCP 写入 session；evidence record operation key 由 `session_id + canonical source/query/content hash` 生成。Graph source 示例只能写 `capability_ref`、typed bindings 和更严格 retry/timeout。

### Skill 设计

新增 skills：

```text
features/startup-opportunity/container/skills/
  opportunity-scope-framing/SKILL.md
  opportunity-concept-framing/SKILL.md
  opportunity-research-plan/SKILL.md
  opportunity-concept-validation-plan/SKILL.md
  opportunity-seed-probe/SKILL.md
  opportunity-space-map/SKILL.md
  opportunity-solution-space-map/SKILL.md
  opportunity-solution-hypothesis-evaluation/SKILL.md
  opportunity-user-language-mining/SKILL.md
  opportunity-audience-pain-recon/SKILL.md
  opportunity-job-to-be-done-recon/SKILL.md
  opportunity-top-products-recon/SKILL.md
  opportunity-review-mining-recon/SKILL.md
  opportunity-search-demand-recon/SKILL.md
  opportunity-trend-recon/SKILL.md
  opportunity-substitutes-recon/SKILL.md
  opportunity-solution-failure-recon/SKILL.md
  opportunity-ai-capability-frontier/SKILL.md
  opportunity-ai-cost-curve-access/SKILL.md
  opportunity-ai-workflow-automation/SKILL.md
  opportunity-ai-ecosystem-platform/SKILL.md
  opportunity-ai-data-eval-flywheel/SKILL.md
  opportunity-ai-adoption-trust/SKILL.md
  opportunity-thesis-synthesis/SKILL.md
  opportunity-merge-synthesis/SKILL.md
  opportunity-competitor-gap-recon/SKILL.md
  opportunity-market-size-recon/SKILL.md
  opportunity-monetization-recon/SKILL.md
  opportunity-acquisition-recon/SKILL.md
  opportunity-compliance-risk-recon/SKILL.md
  opportunity-counter-evidence/SKILL.md
  opportunity-feasibility-unit-economics/SKILL.md
  opportunity-ai-capability-benchmark/SKILL.md
  opportunity-ai-evaluation-reliability/SKILL.md
  opportunity-ai-inference-unit-economics/SKILL.md
  opportunity-ai-data-dependency/SKILL.md
  opportunity-capability-commoditization/SKILL.md
  opportunity-workflow-outcome-value/SKILL.md
  opportunity-state-context-continuity/SKILL.md
  opportunity-buyer-purchase-language/SKILL.md
  opportunity-decision-recommendation/SKILL.md
  opportunity-quality-review/SKILL.md
  opportunity-validation-suggestions/SKILL.md
  opportunity-concept-report/SKILL.md
  opportunity-report-writer/SKILL.md
```

并在 Feature 自己的 agent/skill resource 中新增 role 映射；这些 role/skill 仅供 capability publisher 解析，Workflow Definition 和 Graph Spec 不直接组合它们。例如：

```json
{
  "web_opportunity_planner": [
    "opportunity-scope-framing",
    "opportunity-research-plan",
    "opportunity-seed-probe",
    "opportunity-space-map",
    "opportunity-solution-space-map"
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
    "opportunity-solution-failure-recon",
    "opportunity-ai-capability-frontier",
    "opportunity-ai-cost-curve-access",
    "opportunity-ai-workflow-automation",
    "opportunity-ai-ecosystem-platform",
    "opportunity-ai-data-eval-flywheel",
    "opportunity-ai-adoption-trust"
  ],
  "web_opportunity_enrichment": [
    "opportunity-competitor-gap-recon",
    "opportunity-market-size-recon",
    "opportunity-monetization-recon",
    "opportunity-acquisition-recon",
    "opportunity-compliance-risk-recon",
    "opportunity-counter-evidence",
    "opportunity-feasibility-unit-economics",
    "opportunity-ai-capability-benchmark",
    "opportunity-ai-evaluation-reliability",
    "opportunity-ai-inference-unit-economics",
    "opportunity-ai-data-dependency",
    "opportunity-capability-commoditization",
    "opportunity-workflow-outcome-value",
    "opportunity-state-context-continuity",
    "opportunity-buyer-purchase-language"
  ],
  "web_opportunity_synthesis": [
    "opportunity-solution-hypothesis-evaluation",
    "opportunity-thesis-synthesis",
    "opportunity-merge-synthesis",
    "opportunity-decision-recommendation",
    "opportunity-validation-suggestions",
    "opportunity-report-writer"
  ],
  "web_opportunity_review": ["opportunity-quality-review"]
}
```

Graph node skill 的职责划分：

| Node | Skill | 核心职责 |
|--------|-------|----------|
| `scope_framing` | `opportunity-scope-framing` | 明确市场、平台、商业模式、团队能力、验证周期、风险偏好、discovery profile、research axes 和默认假设 |
| `research_plan` | `opportunity-research-plan` | 生成需求/市场/解决方案证据 lane、query goals、数据源、候选保留阈值、多样性、Research Kernel 参数、评分 profile 和 kill gate |
| `seed_probe` | `opportunity-seed-probe` | 轻量探测用户、场景、问题、关键词、产品、数据源和 capability/model/ecosystem seed |
| `opportunity_space_map` | `opportunity-space-map` | 建立用户角色、JTBD、替代方案、Baseline Option、task operating profile、工作流摩擦点、状态上下文和买单语言假设 |
| `solution_space_map` | `opportunity-solution-space-map` | 建立消费者交付形态、普通/人工/平台/AI-assisted 方案候选和适用的 capability evidence |
| `user_language_mining` | `opportunity-user-language-mining` | 从真实 UGC 中挖掘用户自然语言、trigger phrase、mental positioning 和入口场景 |
| `audience_pain` | `opportunity-audience-pain-recon` | 从人群、场景、社区讨论和评论中挖掘痛点与候选机会 |
| `job_to_be_done` | `opportunity-job-to-be-done-recon` | 从任务流、流程断点、协作摩擦和工作流价值中挖掘机会 |
| `top_products` | `opportunity-top-products-recon` | 基于 `product_seed` 扩展头部产品、定位、功能覆盖、商业模式和覆盖缺口 |
| `review_mining` | `opportunity-review-mining-recon` | 基于 `product_seed` 抓取低星评论、功能请求、投诉并提取未满足需求 |
| `search_demand` | `opportunity-search-demand-recon` | 从搜索需求、问答和内容缺口中识别工具化机会 |
| `trend_change` | `opportunity-trend-recon` | 从政策、技术、平台和消费变化中识别新窗口 |
| `substitutes_workarounds` | `opportunity-substitutes-recon` | 验证当前替代方案、非 App 竞争、切换阻力和 App 必要性 |
| `solution_failure` | `opportunity-solution-failure-recon` | 识别传统/AI 解法失效、non-consumption、失败原因、next action 和迁移动机 |
| `solution_hypothesis_evaluate` | `opportunity-solution-hypothesis-evaluation` | 比较 Demand Thesis 下的解决方案、Baseline Option 和 outcome 增量；AI 方案按声明依赖执行 AI bundle |
| `opportunity_thesis` | `opportunity-thesis-synthesis` | 将 Demand Thesis 和 selected Solution Hypothesis 转为可审计 thesis，补齐 baseline comparison、买单语言、定位、价值层、entry wedge、why now 和 kill criteria |
| `competitor_gap` | `opportunity-competitor-gap-recon` | 对合并机会验证竞品覆盖、满意度、迁移阻力和差异化空间 |
| `market_size` | `opportunity-market-size-recon` | 补充市场规模、增长、目标用户规模和消费能力相关判断 |
| `monetization` | `opportunity-monetization-recon` | 验证付费意愿、定价、订阅、交易抽佣、家庭代付、赞助支付或渠道变现路径 |
| `acquisition` | `opportunity-acquisition-recon` | 验证 SEO、社区、平台、内容和合作获客路径 |
| `compliance_risk` | `opportunity-compliance-risk-recon` | 识别政策、医疗、金融、隐私、平台规则等风险 |
| `counter_evidence` | `opportunity-counter-evidence` | 查找替代方案、失败案例、需求被高估证据和反方观点 |
| `feasibility_unit_economics` | `opportunity-feasibility-unit-economics` | 判断小团队交付复杂度、运营依赖、毛利结构和早期单位经济 |
| `ai_capability_benchmark` | `opportunity-ai-capability-benchmark` | 对目标任务执行通用模型/平台/开源 + prompt/tool baseline，验证能力增量、失败和成本 |
| `ai_evaluation_reliability` | `opportunity-ai-evaluation-reliability` | 验证评测集、ground truth、成功率、异常检测、审计、人工兜底和恢复 |
| `ai_inference_unit_economics` | `opportunity-ai-inference-unit-economics` | 计算推理、检索、工具、存储、人工审核和支持成本后的单位经济 |
| `ai_data_dependency` | `opportunity-ai-data-dependency` | 验证数据权利、反馈闭环、provider portability、平台依赖和 capability half-life |
| `capability_commoditization` | `opportunity-capability-commoditization` | 判断核心能力被模型升级、平台内置、API 降价、开源或竞品更新抹平的风险 |
| `workflow_outcome_value` | `opportunity-workflow-outcome-value` | 区分 output、workflow 和 outcome 价值，定义 outcome metric |
| `state_context_continuity` | `opportunity-state-context-continuity` | 建模用户状态、上下文来源、状态更新触发器、数据闭环和隐私边界 |
| `buyer_purchase_language` | `opportunity-buyer-purchase-language` | 验证买单语言、预算来源、决策标准和用户语言到购买语言的映射 |
| `decision_recommendation` | `opportunity-decision-recommendation` | 基于 hard gate、证据充分性、baseline comparison、敏感性和 portfolio view 生成决策建议 |
| `validation_suggestions` | `opportunity-validation-suggestions` | 为推荐机会生成自然复述、买单语言、baseline 差距或轻量技术 spike 建议；不执行、不追踪验证 |

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
- 判断 AI baseline、prompt/tool baseline、评测可靠性、单位经济、model upgrade risk 和能力商品化风险是否成立。
- 比较 Demand Thesis 下的 Solution Hypothesis 与 Baseline Option；AI capability evidence 只能支撑声明依赖 AI 的方案，不能单独生成机会。
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
- `opportunity_validate_ai_baseline`
- `opportunity_validate_ai_benchmark_manifest`
- `opportunity_validate_solution_hypothesis_refs`
- `opportunity_validate_baseline_comparison`
- `opportunity_calculate_ai_unit_economics`
- `opportunity_validate_buyer_language_refs`

host MCP tool 可以执行联网 search/fetch/API 调用，但它的职责是按 agent 给出的 query、URL、source type 和 research goal 执行可审计数据获取，并把结果写成 evidence record。它不负责决定创业机会、选择 Solution Hypothesis、比较业务 baseline、筛选候选方向或生成最终结论。

这些工具由 Feature 的 MCP resource/host adapter 注册，经 core IPC/MCP extension point 分发到 `features/startup-opportunity/host/opportunity-recon/request-dispatcher.ts`，不能在 `src/ipc.ts` 静态增加 Startup Opportunity 业务分支。通用 `WebSearch`/`WebFetch` 仍可用于探索性补充，但原始来源进入正式判断前必须经 host MCP tool 记录到 evidence store。正式 artifact 中只保留 evidence refs、source manifest、provenance、limitations 和判断层产物，不携带原始证据正文作为下游生成语料。

适合 workflow action 的：

- `context.set`、`context.require` 这类已有上下文操作。
- graph node artifact schema validation。
- evidence ref validation 和 source manifest 校验。
- user language refs、trigger phrase refs 和 solution failure refs 校验。
- AI baseline/benchmark、capability-demand refs、buyer language、value layer 和 state context 字段完整性校验。
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

在目标 Runtime 中，上述 action 必须注册为 exact versioned `system` capability，由 Graph node/单节点 State 引用；长耗时操作在 DB transaction 外通过 outbox/lease 执行，不能通过扩展旧 `runWorkflowActionSteps` 建立旁路。LLM 调用、开放式调研或 GPT Researcher deep 只能进入 delegation capability。

### Artifact Contract 与 Evaluator

新增 artifact contracts：

```text
startup_opportunity.task_intake.v1
startup_opportunity.routing_decision.v1
startup_opportunity.scope_frame.v1
startup_opportunity.plan.v1
startup_opportunity.seed_probe.v1
startup_opportunity.opportunity_space_map.v1
startup_opportunity.solution_space_map.v1
startup_opportunity.demand_thesis.v1
startup_opportunity.solution_hypothesis.v1
startup_opportunity.baseline_option.v1
startup_opportunity.capability_evidence.v1
startup_opportunity.solution_evaluation.v1
startup_opportunity.user_language_map.v1
startup_opportunity.solution_failure_map.v1
startup_opportunity.discovery_lane_result.v1
startup_opportunity.discovery_fan_in.v1
startup_opportunity.opportunity_thesis.v1
startup_opportunity.merge.v1
startup_opportunity.enrichment_branch_result.v1
startup_opportunity.enrichment_fan_in.v1
startup_opportunity.ai_capability_benchmark.v1
startup_opportunity.ai_evaluation_reliability.v1
startup_opportunity.ai_inference_unit_economics.v1
startup_opportunity.ai_data_dependency.v1
startup_opportunity.capability_commoditization_risk.v1
startup_opportunity.value_layer_analysis.v1
startup_opportunity.user_state_context_model.v1
startup_opportunity.buyer_purchase_language.v1
startup_opportunity.ranking.v1
startup_opportunity.sensitivity.v1
startup_opportunity.decision_recommendation.v1
startup_opportunity.validation_suggestions.v1
startup_opportunity.report.v1
startup_opportunity.traceability.v1
startup_opportunity.concept_frame.v1
startup_opportunity.concept_validation_plan.v1
startup_opportunity.concept_validation_branch_result.v1
startup_opportunity.concept_validation_fan_in.v1
startup_opportunity.concept_verdict.v1
startup_opportunity.concept_validation_suggestions.v1
startup_opportunity.concept_report.v1
```

放在：

```text
features/startup-opportunity/container/artifact-contracts/startup-opportunity.json
```

新增 evaluator：

```text
features/startup-opportunity/container/workflow-evaluators/startup-opportunity.json
```

branch-level contract 用于约束单个并行分支的输出；fan-in contract 用于约束 join 后给下游 state 的聚合上下文。

`scope_frame.v1` 必须产出：

```text
startup_opportunity.scope_frame.v1
  - direction
  - discovery_profile                 general | industry_first | ai_first | hybrid
  - research_axes
  - ai_scope
  - market
  - language
  - platform
  - market_motion                     consumer
  - acquisition_motion                direct | community | channel | marketplace
  - buyer_model                       self_payer | household_payer | sponsor_payer | provider_channel
  - payment_mode
  - delivery_form_preferences         native_app | mini_program | mobile_web | hybrid_app | service_assisted
  - business_model_preferences
  - team_capability_constraints
  - validation_budget
  - validation_timeline
  - risk_preferences
  - native_app_required
  - assumptions
  - open_questions
```

`plan.v1` 除 lane/query/source/budget 外，还必须包含：

```text
candidate_retention_threshold
candidate_diversity_policy
seed_independent_exploration_budget
counterfactual_lane_requirement
open_questions
  - question
  - decision_impact
  - uncertainty
  - research_cost
  - stop_condition
followup_priority_rule
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
  - capability_seeds
  - model_ecosystem_seeds
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
  - task_operating_profiles
  - current_alternatives
  - baseline_options
  - workaround_patterns
  - workflow_friction_points
  - software_leverage_points
  - state_context_opportunities
  - buyer_purchase_language_hypotheses
  - initial_demand_hypotheses
  - disconfirming_questions
  - audit_refs
  - limitations
```

`solution_space_map.v1` 必须产出：

```text
startup_opportunity.solution_space_map.v1
  - delivery_form_candidates
  - ordinary_software_solutions
  - platform_solutions
  - human_or_service_assisted_solutions
  - ai_assisted_solutions
  - capability_frontier
  - capability_evidence
  - newly_feasible_tasks
  - quality_latency_cost_boundaries
  - failure_modes
  - deployment_constraints
  - human_in_the_loop_boundaries
  - data_and_evaluation_requirements
  - provider_open_source_platform_landscape
  - capability_half_life
  - disconfirming_questions
  - source_manifest
  - audit_refs
  - limitations
```

`demand_thesis.v1` 必须产出 solution-neutral 需求对象，包括 `demand_id`、user/buyer/payer、JTBD、workflow step、trigger phrase、当前传统/AI alternatives、task operating profile、execution constraints、data conditions、outcome metrics、付费/迁移判断、supporting/opposing refs、kill conditions 和 limitations。

`solution_hypothesis.v1` 必须产出 solution id、demand ref、delivery form、solution type、workflow change、required capabilities、baseline ref、baseline delta、market/acquisition/payment motion、expected outcomes、risks、kill criteria、capability evidence refs 和 limitations。

`baseline_option.v1` 必须产出 baseline id、current workflow/cost/failure modes、switching cost、why users continue、minimum incremental value required、审计引用和 limitations。Baseline Option 不参与机会 TopN 排名。

`capability_evidence.v1` 必须产出 capability id/name、applicable solution refs、newly feasible tasks、supported modalities、质量/延迟/成本边界、失败模式、部署约束、人机边界、数据/评测要求、provider/open-source/platform landscape、bundle risk、capability half-life、baseline gap、evidence tier、审计引用和 limitations。

`solution_evaluation.v1` 必须包含：

```text
selected_solutions
alternative_solutions
baseline_comparisons
rejected_solutions
solution_rationale
critical_unknowns
capability_only_signals
audit_refs
limitations
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
  - current_ai_workarounds
  - solution_failure_scenes
  - failure_modes
  - current_ai_failure_modes
  - non_consumption_cases
  - abandonment_reasons
  - user_language_refs
  - next_actions_after_failure
  - migration_intent
  - current_solution_inertia
  - opportunity_entry_candidates
  - source_manifest
  - audit_refs
  - limitations
```

Discovery graph 中每个 lane node 必须产出：

```text
startup_opportunity.discovery_lane_result.v1
  - node_key
  - lane_type
  - research_goals
  - queries
  - evidence_refs
  - evidence_tiers
  - evidence_statuses
  - representativeness
  - decision_sufficiency
  - claims
  - supporting_claims
  - opposing_claims
  - findings
  - insights
  - task_operating_profiles
  - candidate_opportunities
  - demand_theses
  - solution_hypotheses
  - baseline_options
  - capability_evidence
  - user_language_refs
  - trigger_phrase_refs
  - solution_failure_refs
  - scored_candidates
  - kill_conditions
  - pre_kill_decisions
  - rejected_opportunities
  - watchlist_opportunities
  - retained_candidates
  - candidate_diversity_summary
  - insufficient_evidence
  - audit_refs
  - limitations
```

`discovery_fan_in.v1` 必须包含：

```text
branch_results
branch_evaluation_summary
evidence_sufficiency_summary
failed_or_partial_branches
retained_candidate_opportunities
all_demand_theses
all_solution_hypotheses
all_baseline_options
all_capability_evidence
judgment_context
source_manifest
user_language_summary
solution_failure_summary
opposing_claims_summary
pre_kill_summary
solution_evaluation_required
audit_refs
limitations
```

`opportunity_thesis.v1` 必须包含：

```text
opportunity_theses
  - id
  - lifecycle_state                 proposed | screened | recommended | watchlist | rejected | stale
  - valid_as_of
  - freshness_policy
  - discovery_profile
  - research_axes
  - title
  - opportunity_thesis
  - demand_thesis_ref
  - selected_solution_ref
  - solution_alternatives
  - selected_delivery_form
  - baseline_option_ref
  - incremental_value_over_baseline
  - user
  - buyer
  - payer
  - decision_maker
  - market_motion
  - acquisition_motion
  - buyer_model
  - payment_mode
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
  - capability_evidence_refs
  - ai_system_profile
  - capability_commoditization_risk
  - supporting_claim_refs
  - opposing_claim_refs
  - user_language_refs
  - solution_failure_refs
  - kill_criteria
  - next_validation_suggestion
  - confidence
  - audit_refs
```

Enrichment graph 中每个 enrichment node 必须产出：

```text
startup_opportunity.enrichment_branch_result.v1
  - node_key
  - enrichment_type
  - opportunity_refs
  - evidence_refs
  - claims
  - findings
  - insights
  - counter_claims
  - score_inputs
  - ai_capability_baseline
  - ai_evaluation_reliability
  - ai_inference_unit_economics
  - ai_data_dependency
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
ai_capability_baselines_by_opportunity
ai_evaluation_reliability_by_opportunity
ai_inference_unit_economics_by_opportunity
ai_data_dependency_by_opportunity
commoditization_risk_by_opportunity
value_layer_by_opportunity
state_context_models_by_opportunity
buyer_purchase_language_by_opportunity
failed_or_partial_branches
audit_refs
limitations
```

`ai_capability_benchmark.v1` 必须包含：

```text
opportunity_id
ai_dependency_points
baseline_task
baseline_models_and_tools
prompt_tool_setup
evaluation_dataset
evaluation_metrics
repeated_run_summary
quality_result
failure_cases
latency_result
cost_per_task
human_review_cost
desk_research_only
mainstream_ai_solved_level
remaining_gap_after_baseline
model_upgrade_risk
capability_half_life
score_input
audit_refs
limitations
```

`ai_evaluation_reliability.v1` 必须包含评测集代表性、ground truth、success/failure metrics、异常检测、审计、human-in-the-loop、失败恢复、上线监控、score input、审计引用和 limitations。

`ai_inference_unit_economics.v1` 必须包含目标价格、推理/检索/工具/存储/人工审核/支持成本、使用量假设、毛利区间、成本敏感性、break-even 条件、score input、审计引用和 limitations。

`ai_data_dependency.v1` 必须包含数据来源和权利、更新频率、ground truth、反馈闭环、provider dependency、portability、platform bundle risk、open-source substitution risk、capability half-life、mitigation、score input、审计引用和 limitations。

AI-dependent Solution Hypothesis 的 evaluator/quality gate 还必须执行以下确定性检查：

- `ai_first`/`hybrid` Scope Spec 至少包含一个需求侧根节点和一个 Solution Hypothesis 评估节点；AI capability lane 只是条件性证据来源，不是独立业务根。
- 每个正式 Opportunity Thesis 必须回连同一 immutable discovery snapshot 内的 Demand Thesis、selected Solution Hypothesis 和 Baseline Option；Capability Evidence 不能单独进入 `opportunity_thesis`。
- `capability_only` 只能进入观察池或 limitations；没有 Demand Thesis 的能力信号不能进入正式 TopN。
- 每个 `uses_ai=true` 的 Solution Hypothesis 必须存在 baseline、evaluation reliability、unit economics 和 data dependency artifact；缺一项不能进入 AI scoring。
- `desk_research_only=true`、评测集无代表性或 freshness 过期时，confidence 和最高 score band 必须按 versioned rule 限制。
- hard gate 的 rule version、input snapshot hash、触发原因和最终 band cap 必须进入 ranking/traceability artifact。

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

`ranking.v1` 必须包含：

```text
scoring_profile
rule_version
ranked_opportunities
  - opportunity_id
  - rank                              optional when ranking is robust
  - score_band
  - global_score
  - confidence_score
  - decision_value_band
  - uncertainty_band
  - rank_relation                     robust_leader | comparable | dominated | unknown
  - baseline_delta
  - evidence_sufficiency
  - common_score_breakdown
  - ai_score_breakdown
      - capability_delta
      - technical_reliability
      - evaluation_feasibility
      - data_readiness
      - human_review_dependency
      - inference_unit_economics
      - provider_portability
      - platform_bundle_risk
      - open_source_substitution_risk
      - data_feedback_moat
      - capability_half_life
      - ai_adoption_trust
  - hard_gate_results
  - triggered_kill_criteria
  - band_caps
  - rationale_inputs
correlation_adjustments
input_snapshot_hash
audit_refs
limitations
```

非 AI 机会的 `ai_score_breakdown` 为 `not_applicable`，不能用中性高分抬高总分；AI 候选缺少任一强制 score input 时不得进入最终排序。

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

`decision_recommendation.v1` 必须包含：

```text
recommendations
  - opportunity_id
  - decision                         prioritize | quick_validation | watch | reject
  - decision_value_band
  - uncertainty_band
  - decisive_evidence
  - decisive_gaps
  - baseline_comparison
  - selected_solution_ref
  - alternative_solution_refs
  - what_would_change_the_decision
  - recommended_next_action
  - rule_version / input_snapshot_hash / audit_refs
portfolio_view
  - recommended_first_bet
  - alternative_bets
  - shared_distribution_or_capabilities
  - resource_conflicts
  - risk_correlation
  - learning_reuse
```

`validation_suggestions.v1` 只是最终报告中的轻量建议，不是验证执行合同：

```text
suggestions
  - subject_ref
  - critical_assumption
  - suggested_action
  - target
  - success_signal
  - failure_signal
  - estimated_effort
  - rationale
```

Runtime 不为该 artifact 创建 Experiment、外部执行、结果回写或 Business Outcome 反馈状态。

`concept_frame.v1` 必须包含：

```text
hypothesis_id
concept_name
target_user / buyer / payer
job_to_be_done / entry_scene / claimed_problem
claimed_solution / claimed_value_proposition
current_alternative_hypotheses
business_model_hypothesis / acquisition_hypothesis
market / platform / team / budget / timeline constraints
assumptions / unknowns / kill_criteria
validation_profile          general | ai | regulated_ai
```

`concept_validation_branch_result.v1` 的每条记录必须带同一个 `hypothesis_id`、validation dimension、supporting/opposing claims、evidence refs、confidence、limitations 和 kill-condition impact，禁止在 branch 内生成无关机会池。

当 `validation_profile=ai|regulated_ai` 时，fan-in 必须包含 `ai_capability_benchmark`、`ai_evaluation_reliability`、`ai_inference_unit_economics` 和 `ai_data_dependency`。`regulated_ai` 还必须包含合规、隐私、安全、审计、人工责任边界和高错误成本 kill gate。缺少强制 bundle 时，deterministic verdict 只能输出 `insufficient_evidence`，不能由 reviewer 绕过。

`concept_verdict.v1` 必须包含：

```text
hypothesis_id
verdict                    go | conditional_go | no_go | insufficient_evidence
confidence_micros
dimension_decisions
supporting_claim_refs / opposing_claim_refs
decisive_evidence / decisive_gaps
triggered_kill_criteria
conditions_for_go
what_would_change_the_verdict
recommended_next_action
rule_version / input_snapshot_hash / audit_refs
```

Verdict 由 versioned deterministic system capability 根据已验证字段和阈值计算；delegation reviewer 可以提出结构化 disagreement，但不能直接覆盖 rule result。该 deterministic gate 表达的是“当前证据是否满足既定决策规则”，不是市场真相或创业最终成功概率。只有公开网页、评论、搜索量或厂商资料等 desk research 时，最高 verdict 默认为 `conditional_go`；只有用户提供了可审计的观察行为、支付/承诺或重复使用证据，profile rule 才可以允许 `go`。需要改变规则时发布新 rule/capability/Recipe version。

AI profile 的 `dimension_decisions` 至少包含 demand、generic baseline gap、technical reliability、evaluation feasibility、data rights/monitoring、inference unit economics、human review burden、provider/platform dependency、commoditization、workflow outcome value、buyer/monetization、acquisition、security/compliance。每项都必须给出 decision、confidence、supporting/opposing refs、kill-condition impact 和 what-would-change-it。

`concept_validation_suggestions.v1` 与通用 `validation_suggestions.v1` 使用相同轻量字段，只提供 `critical_assumption`、`suggested_action`、`success_signal`、`failure_signal` 和 `estimated_effort`；它不创建外部验证执行或结果反馈状态。

Artifact/evaluator/quality gate 属于 versioned capability，不属于 Planner 生成的 node。Capability resource 示例：

```json
{
  "ref": { "id": "startup-opportunity.review-mining", "version": "1.0.0" },
  "node_type": "delegation",
  "executor_ref": { "id": "container-agent", "version": "1.0.0" },
  "role_ref": { "id": "review-mining-researcher", "version": "1.0.0" },
  "skill_refs": [{ "id": "opportunity-review-mining-recon", "version": "1.0.0" }],
  "artifact_contract_ref": { "id": "startup-opportunity.discovery-lane-result", "version": "1.0.0" },
  "evaluator_ref": { "id": "startup-opportunity.discovery-lane-result", "version": "1.0.0" },
  "quality_gate_ref": { "id": "startup-opportunity.discovery-blocking", "version": "1.0.0" },
  "effect": { "type": "pure" },
  "cancellation": { "type": "fence_only", "safe_to_abandon": true }
}
```

Planner 生成的 Graph Node 只允许：

```json
{
  "id": "review_mining",
  "type": "delegation",
  "trigger": { "type": "root" },
  "capability_ref": { "id": "startup-opportunity.review-mining", "version": "1.0.0" },
  "retry_request": { "max_attempts": 2 },
  "timeout_ms": 600000
}
```

### Task Intake、Discovery Profile 与两类输入合同

Feature create form 提供 `analysis_mode = auto | opportunity_discovery | concept_validation`。显式模式直接选择对应 Recipe；`auto` 才在 Feature routing scope 内调用 Macro Router。机会发现输入使用方向字段，并通过 `discovery_profile` / `research_axes` 选择调研维度，而不是新增 Recipe：

三层标识使用以下固定映射，不能靠字符串变形隐式推导：

| Task kind | Exact Recipe resource id | `analysis_mode` |
| --- | --- | --- |
| `opportunity_discovery` | `startup-opportunity.opportunity-discovery@1.0.0` | `opportunity_discovery` |
| `concept_market_validation` | `startup-opportunity.concept-validation@1.0.0` | `concept_validation` |

`Task kind` 是 Macro Router 的分类输出，RecipeRef 是 deterministic resolver 唯一接受的创建目标，`analysis_mode` 只是 Feature 表单/API 的稳定判别字段。版本升级由 routing scope 发布新的 exact RecipeRef，不修改上述 task kind 或表单枚举的业务语义。

`discovery_profile` 的固定语义：

| Profile | 必需 research axes | 输出约束 |
|---------|--------------------|----------|
| `general` | 由 Scope Framer 根据方向选择需求/市场/solution evidence axes | 输出一般 TopN，所有候选使用统一 Demand/Solution/Opportunity 模型 |
| `industry_first` | `industry_demand` + `buyer_market` | 从指定行业需求出发；AI 只是候选的条件性解法和验证维度 |
| `ai_first` | `ai_capability` + `cross_industry_demand` + `buyer_market` | capability seed 优先，但正式候选仍必须回连 Demand Thesis、Solution Hypothesis 和 Baseline Option；非 AI 替代必须参与比较 |
| `hybrid` | `industry_demand` + `ai_capability` + `buyer_market` | 在指定行业内同时研究需求与 capability evidence；AI 能力不形成独立机会分支 |

`discovery_profile=auto` 由 `scope_framing` 解析为上述固定 profile 并写入 immutable scope artifact；Micro Planner 不能自定义第五种 profile 或改变其输出约束。

```json
{
  "analysis_mode": "opportunity_discovery",
  "discovery_profile": "industry_first",
  "research_axes": ["industry_demand", "buyer_market"],
  "direction": "宠物行业 App",
  "market": "中国",
  "platform": ["Mobile", "Web"],
  "language": "zh-CN",
  "market_motion": "consumer",
  "acquisition_motion": ["direct", "community", "marketplace"],
  "buyer_model": ["self_payer", "household_payer"],
  "delivery_form_preferences": ["native_app", "mini_program", "mobile_web"],
  "business_model_preferences": ["ToC 订阅", "交易撮合"],
  "team_capability_constraints": ["小团队", "无重线下运营能力", "可做内容获客"],
  "validation_timeline": "30 days",
  "validation_budget": "low",
  "risk_preferences": ["不做医疗诊断", "避免强监管金融"],
  "native_app_required": false,
  "target_rank_count": 10,
  "candidate_retention_threshold": "medium",
  "candidate_diversity_minimum": 3,
  "constraints": ["不做医疗诊断", "优先 ToC 订阅或交易撮合"]
}
```

“目前 AI 创业有哪些机会”使用同一个机会发现 Recipe：

```json
{
  "analysis_mode": "opportunity_discovery",
  "discovery_profile": "ai_first",
  "research_axes": ["ai_capability", "cross_industry_demand", "buyer_market"],
  "direction": "目前 AI 创业有哪些机会",
  "ai_scope": {
    "capability_focus": ["multimodal", "agentic_workflow", "voice", "vision"],
    "product_layers": ["consumer_application", "consumer_workflow"],
    "deployment_preferences": ["cloud", "open_source_optional"]
  },
  "market": "中国和可服务的跨境市场",
  "language": "zh-CN",
  "team_capability_constraints": ["小团队", "可快速做软件原型", "无自研基础模型预算"],
  "validation_timeline": "30 days",
  "validation_budget": "medium",
  "target_rank_count": 8,
  "constraints": ["不把模型 API wrapper 直接视为壁垒"]
}
```

“AI 在教育行业有哪些机会”使用 `hybrid`，需求 lane 和 AI solution evidence lane 可以并行，但最终使用统一的 Demand/Solution/Opportunity 对象：

```json
{
  "analysis_mode": "opportunity_discovery",
  "discovery_profile": "hybrid",
  "research_axes": ["industry_demand", "ai_capability", "buyer_market"],
  "direction": "AI 在教育行业有哪些创业机会",
  "industry_scope": ["K12", "职业教育", "教师工作流"],
  "ai_scope": {
    "capability_focus": ["multimodal", "agentic_workflow"]
  },
  "market": "中国",
  "risk_preferences": ["未成年人数据谨慎", "不替代高风险教育决策"]
}
```

概念验证输入使用明确 thesis，而不是把它塞进 `direction`：

```json
{
  "analysis_mode": "concept_validation",
  "validation_profile": "general",
  "concept": {
    "name": "宠物用药家庭协同 App",
    "claimed_user": "慢病宠物家庭",
    "claimed_problem": "用药、复诊和家庭同步分散",
    "claimed_solution": "提醒、确认、记录和家庭协同闭环",
    "claimed_business_model": "ToC subscription"
  },
  "market": "中国",
  "platform": ["Mobile", "Web"],
  "language": "zh-CN",
  "team_capability_constraints": ["小团队", "无医院渠道"],
  "validation_timeline": "30 days",
  "validation_budget": "low",
  "constraints": ["不做医疗诊断"]
}
```

AI 具体方向仍进入同一个概念验证 Recipe，但设置 `validation_profile=ai|regulated_ai`。例如“面向自由行用户的 AI 行程冲突检查是否可行”应使用 `ai`；医疗诊断、金融决策等高错误成本消费者方向使用 `regulated_ai`。

`auto` 输入同时保留 `raw_request` 与可选结构字段。Router 只输出 exact RecipeRef；deterministic resolver 校验 routing scope、Feature status、Recipe input schema、launch policy 和 creation key。Workflow 创建后由 `scope_framing` 在 Recipe 内解析/确认 profile 和 axes。`AI 教育 App` 这类既可能表示“教育行业、AI 优先”，也可能表示“从 AI 能力变化反推教育场景”的输入，如果 profile 会显著改变成本和方法，应返回 `needs_clarification`。Workflow 创建后冻结 validated input snapshot，后续 State 通过 typed bindings 读取；不再依赖任意 `WorkflowContext` merge 或 live template context 作为 contract。

### 最终推荐结构

不要把创业机会调研做成：

```text
workflow action -> 调 GPTResearcher deep -> 产出报告
```

也不要做成：

```text
Opportunity service -> 自己规划/执行/评分/报告 -> Icarus 只展示结果
```

机会发现 Recipe 应做成：

```text
Task Intake + selected opportunity-discovery Recipe
  -> scope_framing capability state
  -> research_plan / seed_probe / opportunity_space_map / solution_space_map
  -> discovery_graph_plan capability + compiler dry-run evaluator
  -> discovery graph state（需求/任务/替代方案 lanes + 条件性 solution evidence lanes；T1/T2 正式 compile）
  -> discovery_gap_analysis + optional follow-up graph
  -> solution_hypothesis_evaluate / opportunity_thesis / merge
  -> enrichment_graph_plan capability + compiler dry-run evaluator
  -> enrichment graph state（只有 uses_ai=true 的方案强制 AI bundle）
  -> deterministic normalize / hard gate / evidence sufficiency / score / sensitivity capabilities
  -> decision recommendation / quality review / optional validation suggestions / report capabilities
  -> Definition terminal
```

概念验证 Recipe 使用前文独立的 concept workflow，不经过 candidate generation、opportunity merge 和 TopN ranking。这种结构既把动态 DAG 交给通用 workflow 框架执行，也保留 host/container/MCP/skill 的职责边界；Recipe 只发布 Definition、capability、interface、schema、policy 和领域产物契约，不定义第二套 runtime。

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

在 Icarus 中，推荐把这些机制沉淀为 `Research Kernel`：

```text
Research Kernel
  -> 接收 graph node 的 research goals、query seeds、source preferences 和 bounds
  -> 由 agent 控制 query expansion、source selection、follow-up 判断
  -> 通过 host MCP tool 执行 batch search/fetch/source record
  -> 输出 structured judgment context，而不是最终业务报告或证据综述
```

如果确实复用 GPT Researcher 的某些底层实现，也应限制在 Research Kernel 的内部实现细节，例如 search adapter、scraper adapter、context compressor 或 source curation helper。复用边界必须满足：

- 不让 GPT Researcher 决定创业机会 schema、评分或排序。
- 不让 GPT Researcher report writer 直接产出最终业务报告。
- 所有来源必须进入 Icarus evidence store。
- 所有 graph node 输出必须通过 Icarus artifact contract 和 evaluator。

Startup Opportunity Recipe Family 自己控制领域判断：机会发现负责需求、任务、替代方案、Solution Hypothesis、Capability Evidence、合并、反证、评分和决策建议；概念验证负责单 hypothesis 的证据矩阵、反证、verdict 和可选轻量验证建议。GPT Researcher 不决定 Recipe、schema、score 或最终业务结论。

## 完整方案范围

本方案描述完整目标形态，不按 MVP 或先后顺序拆范围。完整方案包含架构层、机会发现 Recipe 和概念验证 Recipe 三层范围。

架构层范围：

- 通用 Task Intake/Recipe routing、State-to-Graph lowering、ready-node concurrency、graph compiler/execution、join/fan-in、checkpoint、lifetime budget、Feature lifecycle 和 Workbench/Trace 由 `local/docs/dynamic-workflow-dag-framework.md` 定义。
- 本方案只声明创业机会调研对该框架的使用方式和业务契约。

机会发现 workflow 范围：

- `scope_framing` 明确市场、消费者交付形态、market/acquisition/payment motion、buyer model、团队能力、风险偏好、discovery profile、research axes、AI solution lens 和默认假设。
- `research_plan` 规划需求/市场/解决方案证据 lane、候选保留阈值、多样性、decision impact、kill gate、证据充分性、评分 profile 和敏感性参数。
- `seed_probe` 探测用户、场景、问题、关键词、产品、数据源和可选 capability/model/ecosystem seed；其中 `product_seed` 只作为产品相关 node 的输入。
- `opportunity_space_map` 建立用户角色、JTBD、当前替代方案、Baseline Option、task operating profile、工作流摩擦点和可软件化节点。
- `solution_space_map` 建立消费者交付形态、普通软件/平台/人工/AI-assisted 方案候选和适用的 Capability Evidence。
- `discovery_graph_plan` 生成本次 discovery DAG spec，按 profile 选择需求/市场/solution evidence lane、行业特定 lane、节点依赖、并发组、join policy 和 follow-up 条件。
- `discovery_graph_execute` 基于通用 graph state 并行执行需求、任务、替代方案和解决方案证据 lane；所有 profile 输出统一的 Demand Thesis、Solution Hypothesis、Baseline Option 和 Capability Evidence。
- `discovery_gap_analysis` 对 fan-in context 识别证据缺口、冲突、弱判断和补充调研需求。
- `followup_graph_plan` / `followup_graph_execute` 按缺口执行补充调研、反证或复核；无补充需求时可跳过。
- `lane_result_validate` 校验 Demand Thesis、Solution Hypothesis、Baseline Option、evidence ref、trigger phrase、solution failure refs、support/opposition、kill conditions、证据充分性和候选多样性。
- `solution_hypothesis_evaluate` 比较候选方案与 Baseline Option；Capability Evidence 只能支撑声明依赖 AI 的方案，不能单独产生机会。
- `opportunity_thesis` 基于 Demand Thesis 和 selected Solution Hypothesis 补齐买单方、mental positioning、entry scene、solution failure、交付形态、baseline 增量、entry wedge、why now、AI system profile（适用时）和 kill criteria。
- `opportunity_merge` 对 opportunity thesis 做语义聚类、拆分和判断依据合并。
- `enrichment_graph_plan` 生成本次 enrichment DAG spec。
- `enrichment_graph_execute` 执行补充判断节点；通用集合包括竞品、市场、商业化、获客、合规、反证、可行性、能力商品化、价值层、状态上下文和买单语言；`uses_ai=true` 的方案强制增加 AI benchmark、评测可靠性、推理单位经济、数据权利和依赖风险。
- `global_score` 使用 versioned profile 执行 hard gate、证据充分性、baseline delta、决策价值、综合评分、稳健排序和推荐档位。
- `sensitivity_analysis` 计算 downside/expected/upside score、rank range、rank stability 和最敏感假设。
- `decision_recommendation` 输出 `prioritize | quick_validation | watch | reject`、决策价值区间、关键证据、关键缺口和下一步建议。
- `quality_review` 审核判断链、反证、评分解释、decision readiness、limitations 和报告一致性。
- `validation_suggestions` 只在关键假设不足时输出一条或少量轻量建议，不创建验证执行、结果回写或业务反馈状态。
- `final_report` 输出 JSON、Markdown 和 traceability artifact。

概念验证 workflow 范围：

- `concept_framing` 将用户已有想法规范为单一 hypothesis、目标用户、问题、方案、价值主张、商业模式、假设和 kill criteria。
- `validation_graph_plan/execute` 围绕同一 hypothesis id 选择需求、替代、竞品、付费、渠道、可行性、合规、AI baseline 和 counter-evidence capabilities；AI/regulated AI profile 强制执行 AI validation bundle。
- `validation_gap_analysis/followup` 只补充会改变 verdict 的关键证据，受 Workflow lifetime budget 和 bounded follow-up interface 约束。
- `hypothesis_reduce/adversarial_review` 归一判断链并检查确认偏误、证据独立性、样本偏差和免费替代。
- `concept_verdict` 使用 versioned deterministic rule 生成 `go | conditional_go | no_go | insufficient_evidence`。
- `validation_suggestions/concept_report` 输出轻量验证建议、JSON/Markdown 和 traceability；不执行或追踪验证。

机会发现最终输出可配置 TopN 创业机会，每个机会包含：

- 标题、一句话定义和 opportunity thesis
- mental positioning、trigger phrase、entry scene 和用户原话样本
- 目标用户、买单方、付费方和决策者
- market motion、buyer model、acquisition motion 和 payment mode
- 买单语言、预算来源、决策标准和 marketing bridge
- JTBD、当前工作流和当前替代方案
- Baseline Option、Solution Hypothesis、候选交付形态和 selected solution
- 相对 baseline 的增量价值和用户迁移成本
- output/workflow/outcome 价值层、outcome metric、用户状态和上下文模型
- 现有解法失效场景、失效原因和 next action
- discovery profile、research axes 和来源子图
- AI capability evidence、baseline、评测、单位经济、数据权利、provider/platform 风险（适用时）
- 关键痛点
- 机会来源 lane
- 关键判断依据
- 竞品缺口
- 综合评分、决策价值区间、推荐档位、敏感性分析和排名稳定性
- beachhead segment、entry wedge 和 why now
- 切入版本建议
- 主要风险、反证和 kill criteria
- 决策建议、关键未知数和可选的轻量验证建议

概念验证最终只输出一个 hypothesis verdict，不复用上述 TopN 结构。

### 完整 Workflow

```text
Task Intake -> opportunity-discovery Recipe
  -> direction
  -> scope_framing
      -> discovery_profile / research_axes / ai_scope
  -> research_plan
  -> seed_probe
  -> opportunity_space_map
  -> solution_space_map
  -> discovery_graph_plan
      -> planner selects allowlisted capability nodes
      -> planner may instantiate bounded-domain-research-lane and conditional solution evidence lanes
      -> planner defines dependencies, ready-node concurrency and join policy
      -> capability evaluator runs compiler dry-run
  -> discovery_graph_execute
      -> demand/task lanes: user_language / audience_pain / JTBD / solution_failure / substitutes
      -> conditional solution evidence lanes: capability_frontier / cost_curve / workflow_automation / ecosystem / data_eval
      -> node-level artifact contract and evaluator
      -> fan-in context
  -> discovery_gap_analysis
  -> optional followup_graph_plan
  -> optional followup_graph_execute
  -> lane_result_validate
  -> solution_hypothesis_evaluate
  -> opportunity_thesis
  -> opportunity_merge
  -> enrichment_graph_plan
      -> planner selects validation/enrichment nodes by opportunity type and evidence gaps
      -> capability evaluator runs compiler dry-run
  -> enrichment_graph_execute
      -> common nodes such as competitor_gap / market_size / counter_evidence / buyer_purchase_language
      -> mandatory AI bundle only for uses_ai=true solutions
      -> node-level artifact contract and evaluator
      -> fan-in context
  -> judgment_context_normalize
  -> hard gate / evidence sufficiency / global_score
  -> sensitivity_analysis
  -> decision_recommendation
  -> quality_review
  -> optional validation_suggestions
  -> final_report
  -> done
```

```text
Task Intake -> concept-validation Recipe
  -> concept_framing
      -> validation_profile = general | ai | regulated_ai
  -> validation_plan
  -> validation_graph_plan + compiler dry-run evaluator
  -> validation_graph_execute（AI profile 强制 AI validation bundle）
  -> validation_gap_analysis
  -> optional followup_graph_plan / followup_graph_execute
  -> hypothesis_reduce
  -> adversarial_review
  -> concept_verdict
  -> optional validation_suggestions
  -> concept_report
  -> done
```

### 可配置扩展点

- 引入人工可调权重。
- 支持多国家/地区市场比较。
- 支持 scope assumptions 模板，例如“小团队低预算”“家庭代付”“只做小程序/Web”。
- 支持 `general`、`industry_first`、`ai_first`、`hybrid` discovery profile，以及 `general`、`ai`、`regulated_ai` validation profile。
- 支持输出结构化 JSON + Markdown 双格式。
- 支持用户在报告后追问某个机会，进入二次深挖。
- 支持用户在报告后追问轻量验证建议的具体做法；本 Recipe 不创建真实验证 child Workflow，也不追踪验证结果。未来若另行建设验证执行 Feature，应使用独立 Recipe 和明确授权边界。

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
- 轻量验证建议：优先确认慢病宠物家庭是否认为小程序/原生 App 相比微信群和备忘录有足够增量价值；可建议访谈目标家庭并展示轻量流程，成功信号是用户能自然复述“宠物慢病记录乱、家里人同步不上时会用它”并表达持续使用或付费意愿。
- kill criteria：用户认为微信/备忘录足够，或宠物医院闭环服务已经覆盖该需求，或用户只愿免费使用提醒功能。
- 风险：宠物医疗数据标准化、与线下宠物医院合作难度。

## 示例：目前 AI 创业有哪些机会

输入：

```text
目前 AI 创业有哪些机会？请给出几个方向和详细指标，适合无自研基础模型预算的小团队。
```

Scope Framing：

```text
analysis_mode = opportunity_discovery
discovery_profile = ai_first
research_axes = ai_capability + cross_industry_demand + buyer_market
product_layers = consumer_application + consumer_workflow
```

执行时，capability seed 可以提高近期能力 frontier、成本和生态变化的研究优先级；需求、任务、替代方案和买单 lane 仍产出统一 Demand Thesis。Solution Space Mapper 同时生成普通软件、平台、人工和 AI-assisted 方案，AI capability evidence 只支撑声明依赖 AI 的 Solution Hypothesis，不能单独生成创业方向。

最终报告输出可配置的 5-10 个方向。每个方向除通用创业指标外，必须包含：

```text
capability_delta
generic_model_platform_open_source_baseline_gap
technical_reliability
evaluation_feasibility
data_readiness
human_review_dependency
inference_unit_economics
provider_portability
platform_bundle_risk
open_source_substitution_risk
data_feedback_moat
capability_half_life
ai_adoption_trust
global_score / confidence / rank_stability
```

报告必须允许出现三类非推荐结果：只有能力变化但没有真实需求的 `capability_only` 信号、需求真实但当前候选方案都无法形成足够 baseline 增量的 `solution_gap`，以及通用模型/平台已经充分解决或单位经济不成立的 `reject`。

## 示例：具体 AI 方向可行性

输入：

```text
面向自由行用户的 AI 行程冲突检查 App 是否可行？
```

路由到 `concept_market_validation`，设置 `validation_profile=ai`。除需求、替代、竞品、付费、获客、合规和反证外，强制执行目标任务 benchmark、评测可靠性、推理与人工审核单位经济、数据权利/可监控性、provider/platform 依赖。最终只输出一个 `go | conditional_go | no_go | insufficient_evidence` verdict、dimension decisions、decisive evidence/gaps、kill criteria、决策建议和可选轻量验证建议，不生成无关 TopN，也不执行验证动作。

## Feature 生命周期、预算与恢复

- `opportunity-discovery` 使用较大的但 finite Workflow execution policy；`ai_first`/`hybrid` profile 可在同一 Recipe policy 的受限 resource claim 内申请额外能力检索、benchmark 和 follow-up 预算，但不能改变部署级 ceiling。`concept-validation` 使用更小的 nodes/scopes/attempts/tool/token/cost ceiling，AI validation bundle 也必须受其 lifetime budget 约束。
- Workflow 级 budget 跨 discovery/follow-up/enrichment 多个 State Activation 累计；进入新 graph state 不重置 token、cost、transition 或 child-workflow 数量。
- API/UI 对同一提交生成稳定 `creation_key`；重复点击、网络重试和 Router outbox 重投返回同一个 Workflow。
- Feature `draining` 时禁止新 intake/Workflow，但已创建 run 继续使用 pinned Recipe/Definition/capability/executor 收敛。Prompt/skill/Research Kernel 更新发布新 capability/Recipe version，旧 run 不读取 live/latest 文件。
- Evidence store 写入必须接受稳定业务 operation key并可对账；node success artifact、source manifest 和 report 必须复制为 immutable snapshot/hash，host live database/path 不能成为 Graph recovery 唯一事实。
- 用户可以基于报告自行采纳或忽略验证建议；本 Feature 不创建验证 child Workflow、不追踪 Business Outcome，也不修改历史决策 artifact。

## 验收标准

- 显式 `analysis_mode` 不被 Router 改写；`auto` 对宽泛机会发现、具体概念、歧义输入和不支持输入分别稳定产生正确 Recipe、clarification 或 unsupported decision。
- Startup Opportunity routing scope 不能选择产品设计、PM Pipeline 或其他 Feature Recipe；伪造 RecipeRef 由 deterministic resolver 拒绝。
- 两个 Recipe 的 Definition/entrypoint/policy/input-output schema/named exits 独立固定；概念验证不会进入 TopN candidate generation，机会发现不会输出单 thesis verdict。`discovery_profile` 只能改变 Recipe 内调研子图、必填 artifact、score profile 和 quality gate，不能改变宏观输出合同。
- Planner 只能引用 allowlisted exact capability；node-local role/skill/tool/artifact/evaluator、任意行业 Agent 和超预算 Scope Spec 均编译失败。
- Planner dry-run 与 graph state 正式 compile 使用同一 source bytes/hash；不存在独立 compile state 或 plan 漂移。
- opportunity discovery fixture 覆盖 `general`、`industry_first`、`ai_first`、`hybrid`、不同 lane DAG、partial/insufficient、follow-up 和 enrichment。
- AI fixture 必须证明 capability seed 和 solution evidence lane 不能单独生成强推荐；正式机会必须回连 Demand Thesis、selected Solution Hypothesis 和 Baseline Option；AI hard gate 能因 baseline 已解决、缺少可靠评测、单位经济失败或平台依赖翻转 uses_ai 方案的结论。
- discovery fixture 必须证明 lane 内固定 topN 不会过早截断候选，并覆盖候选多样性、证据充分性、baseline comparison、稳健排序和“接近无法区分”的 partial-order 输出。
- consumer scope fixture 必须覆盖 native app、mini program、mobile web 和 assisted validation 的交付形态比较，以及 self/household/sponsor/provider buyer model；SaaS/企业销售不进入默认目标方案空间。
- concept fixture 覆盖 go/conditional/no-go/insufficient、强替代方案、反证翻转，以及 `ai`/`regulated_ai` 缺少强制 validation bundle 时只能输出 `insufficient_evidence`。
- evaluator fixture 必须覆盖 schema、引用、反证、freshness、evidence status、decision sufficiency 和 limitation；不以用户后续采纳、付费或创业成功作为 Runtime 验收标准。
- Evidence MCP duplicate delivery、Agent retry、process crash 和 report snapshot recovery 不会重复 evidence、丢失引用或改写已发布 node output。
- Feature upgrade/draining fixture 证明旧 active run 使用旧 executable snapshot，新 Workflow 使用新 Recipe version，disable 不制造不可恢复的只读 run。

## 风险与注意事项

- 公开数据可能不完整，尤其是 App 榜单和评论数据。
- LLM 提取痛点和机会时可能过度概括，需要 schema、evidence ref 和判断链校验约束。
- 排名不能只看高分，也要看判断置信度、证据独立性、反证、敏感性和 rank stability。
- 多个来源可能来自同一转载链或同一评论样本，不能机械累加为高置信度。
- 公开评论、搜索量和媒体讨论属于代理证据，不能与观察行为、支付承诺或重复使用等直接证据等价；模型 confidence 也不等于统计概率。
- 用户表达需求不等于存在付费意愿，必须单独验证买单方、预算来源和 purchase trigger。
- 用户触发语言不等于买单语言；个人自付、家庭代付、赞助支付、渠道推荐和平台交易的决策标准不同，必须分别验证。
- 用户原话不等于 mental positioning 已成立；必须验证用户是否能自然复述“遇到 X 时会用它”。
- `AI`、`助手`、`管理 App`、`平台` 这类供给侧词汇不能直接作为机会定位，必须落回 trigger phrase 和 entry scene。
- 通用模型、平台原生能力或开源方案 + prompt/tool 如果已经能完成核心任务，且产品没有工作流嵌入、专有数据、状态连续性或结果责任，该方向应降级。
- AI 能力、价格、License 和平台政策变化快，必须使用 `valid_as_of`、版本化 benchmark 和 freshness policy；过期证据不能继续支撑强推荐。
- 需求 lane 如果直接生成带方案倾向的“AI 产品”，会污染机会判断；需求侧必须保持 solution-neutral，AI fit 只能在 Solution Hypothesis 与 Baseline Option 的比较中判断。
- 厂商自报 benchmark 不等于目标任务可靠性；无法进行代表性实测时必须降低置信度并标记 `desk_research_only`。
- 推理成本低不代表单位经济成立，还必须计入检索、工具、存储、人工审核、异常处理和客户支持成本。
- 核心能力若高度依赖可商品化 API、平台功能或模型升级，需要单独提高 commodity risk，不能只用“现在体验更好”支撑推荐。
- 一次性 output 容易被替代；缺少 workflow 或 outcome 指标的方向不应被评为强机会。
- 状态和上下文连续性如果无法通过用户授权、数据来源和隐私边界落地，就不能被空泛地当作壁垒。
- 解法失效后如果没有 next action，说明用户可能只是抱怨，不一定有迁移动机。
- 原生 App 不一定是最佳首发形态；小程序、Web/PWA 或人工辅助验证可能更合理。SaaS、企业销售和 API/基础设施不属于本版本默认目标空间。
- 当前方案或维持现状不是一个可排名的创业机会，而是必须显式建模的 Baseline Option；新方案无法证明足够增量时应输出 `watchlist` 或 `reject`。
- Top 机会必须包含 kill criteria、决策建议和必要时的轻量验证建议，否则容易把方向包装成不可执行的商业建议。
- 本 Feature 不执行验证动作、不追踪后续创业成败，也不自动修改历史报告或 scoring profile。
- 不同行业的权重应允许配置，例如医疗健康类应提高合规风险权重。
- 最终报告应明确不确定性，避免把研究结论包装成确定性商业建议。

## 结论

Startup Opportunity Feature 应定位为受限 Macro Routing 下的 Recipe Family：

```text
opportunity_discovery
  = multi-lane opportunity mining
  + general / industry-first / AI-first / hybrid discovery profiles
  + solution-neutral Demand Thesis
  + consumer Solution Hypotheses and delivery-form comparison
  + Baseline Option and incremental-value comparison
  + optional AI Capability Evidence for uses_ai solutions
  + user-language mental positioning
  + buyer-language purchase validation
  + solution-failure mapping
  + AI capability benchmark / reliability / unit economics / dependency gates
  + workflow/outcome value analysis
  + user-state and context-continuity modeling
  + structured evaluation
  + opportunity thesis
  + counter-evidence and kill gates
  + evidence sufficiency and judgment-backed robust ranking
  + sensitivity-aware recommendation
  + decision recommendation
  + optional lightweight validation suggestions
  + decision-oriented reporting

concept_market_validation
  = single hypothesis framing
  + demand / alternative / competition / willingness-to-pay validation
  + feasibility / acquisition / compliance / counter-evidence
  + optional mandatory AI / regulated-AI validation bundle
  + deterministic verdict
  + optional lightweight validation suggestions
```

Feature 应借鉴 GPT Researcher 的初始探测、query goal、并发子研究、递归追问、上下文压缩、来源筛选和证据不足时 abstain，并在 Feature 内沉淀为共享 Research Kernel。Macro Router 只在 `opportunity_discovery` 与 `concept_market_validation` 两个宏观目标之间选择 exact Recipe；`discovery_profile` 和 `research_axes` 只控制机会发现 Recipe 内的 lane 优先级、合同和质量门。执行统一落在 Icarus Graph Runtime、versioned capability、MCP、artifact/evaluator 和 immutable trace 体系内。机会发现从 Demand Thesis、Solution Hypothesis、Baseline Option、Capability Evidence 和市场判断层生成决策建议；概念验证始终围绕用户给定 hypothesis 形成可推翻 verdict。两者不执行外部验证或业务结果反馈，也不得在运行时互相变形。
