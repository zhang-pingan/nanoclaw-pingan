# Icarus 核心技术介绍

Icarus 是一套面向个人内部使用的实验性 Agent 工作系统。它不是需要对外交付或承诺稳定服务的产品，而是把 Agent 执行、安全隔离、工作流编排、跨机器角色协作、长期记忆、知识库、产物评估和多端交互组合成一个可持续迭代的本地工具。

项目的核心价值可以概括为：让 Agent 有足够强的执行能力，同时把执行边界、权限边界、会话边界和本地状态边界做清楚。Agent 可以读代码、写文档、跑命令、调用工具、推进流程；但密钥、宿主机权限、跨会话上下文和高风险操作都由宿主机可信控制面统一约束。合同、冻结和激活机制是内部防返工护栏，不是客户合同、生产认证或发布承诺。

## 1. 安全性：容器化沙箱和宿主机代理

Icarus 的首要设计原则是“高权限能力必须运行在隔离环境内”。Agent 不直接在宿主机进程里执行命令，而是由宿主机服务按需启动容器 Agent，容器只看到明确挂载的目录、工具和 IPC 命名空间。

核心安全设计包括：

- **容器化沙箱执行**：Agent 的 Bash、文件读写、浏览器自动化、WebFetch/WebSearch 等能力都在容器内执行。即使 Agent 拿到强工具权限，影响面也被限制在容器挂载目录内。
- **按需启动、用完销毁**：容器通过 `run --rm` 模式按任务启动，空闲或关闭后销毁。系统不会长期保留一个混杂多任务上下文的执行进程。
- **最小挂载原则**：Agent 工作目录、附件目录、图片目录、IPC 目录按需挂载；项目根目录和额外挂载有明确规则，`.env`、私钥、云厂商凭证、Kube 配置等敏感路径默认阻止进入容器。
- **外部挂载白名单**：额外挂载由项目外部的 `~/.config/icarus/mount-allowlist.json` 控制，容器无法修改自己的安全策略。
- **会话目录隔离**：每个 Agent 拥有独立的 `.claude` 会话目录，避免不同用户、不同任务、不同角色之间发生上下文串扰。
- **IPC 授权**：容器通过 `/workspace/ipc` 向宿主机请求发送消息、创建任务、查询记忆、查询 Wiki 或执行受控宿主机脚本；宿主机根据来源 Agent 和主 Agent/非主 Agent 身份做权限判断。
- **凭证代理**：真实模型 API Key 和 OAuth Token 不进入容器。容器只拿到占位凭证，请求被转发到宿主机 `credential-proxy`，由宿主机注入真实认证头后访问上游模型服务。

这种模型把“Agent 能力强”和“宿主机安全”拆开处理：Agent 在容器里可以大胆使用工具，敏感数据和宿主机权限则通过受控 IPC 或凭证代理留在宿主机执行。

## 2. Agent 蜂窝架构：主调度与子 Agent 能力边界

Icarus 的 Agent 架构更接近蜂窝系统，而不是一个无限权限的单体 Agent。宿主机服务和主调度 Agent 负责统一编排，多个角色子 Agent 分别承担方案、开发、复核、部署、测试、知识库等职责。

蜂窝架构的关键点是：

- **主 Agent 统一调度**：工作流引擎、任务队列、频道路由和个人助理主动引擎都运行在宿主机控制面。它们负责决定何时启动哪个角色 Agent、传入什么上下文、接收什么产物、如何进入下一阶段。
- **子 Agent 有明确能力边界**：角色通过工作流定义、Skill 分配、MCP 工具、挂载目录和任务模板共同限定。例如开发 Agent 获得代码修复 Skill，测试 Agent 获得测试验证 Skill，知识库 Agent 获得项目知识库 Skill。
- **Agent 独立容器化**：每个 Agent 或角色执行单元拥有自己的容器实例、会话目录、IPC 目录和工作目录。执行时启动，不需要时销毁。
- **会话隔离**：`data/sessions/{agent}/.claude` 将不同角色、Agent 和渠道的 Claude 会话分开保存。工作流需要共享的信息通过结构化 handoff、产物和数据库传递，而不是依赖隐式聊天历史。
- **Skill 隔离**：`container/skills/skills.json` 按角色文件夹分配 Skill。Agent 只加载当前角色需要的方法论包，减少提示污染，也让角色职责更稳定。
- **MCP 和工具隔离**：容器内统一挂载 `icarus` MCP 服务，但每次执行都会带上 `ICARUS_AGENT_FOLDER`、`ICARUS_IS_MAIN`、`ICARUS_WORKFLOW_ID`、`ICARUS_STAGE_KEY` 等上下文，宿主机按来源做授权。
- **并发队列控制**：`AgentQueue` 管理活跃容器数量、等待队列、空闲状态、后续消息注入和停止请求，避免 Agent swarm 把本机资源耗尽。

这个设计的巧妙之处在于：系统保留了多 Agent 协作的弹性，但没有让所有 Agent 共享一个混乱的上下文池。每个蜂窝单元都可以强执行、可追踪、可销毁，跨单元协作通过结构化协议完成。

## 3. Harness 工程应用：把 Agent 变成可运行、可观测、可评估的执行单元

Icarus 的 harness 不是单独的目录，而是一组工程化封装：容器 runner、Agent SDK 调用、MCP 工具面、Trace、产物契约、工作流评估和失败分类共同构成 Agent Harness。

它解决的是工程落地中最关键的问题：同一个 Agent 任务不能只是“聊完了”，而要能被启动、监控、回放、评价、失败归因和继续推进。

主要能力包括：

- **标准化输入**：宿主机把 prompt、sessionId、model、runId、queryId、agentFolder、workflowId、stageKey、delegationId 等执行元数据打包传给容器。
- **标准化执行环境**：容器 runner 统一挂载目录、注入占位凭证、配置模型代理、加载 Skill、启动 MCP、设置允许工具。
- **流式输出解析**：容器 Agent 用固定 marker 输出结构化结果，宿主机实时解析 success/error/event，写入 Query Trace 和工作台状态。
- **Agent Harness**：容器内通过 Claude Agent `query()` 执行，配置工具白名单、MCP server、hooks、session resume、isolated session、PreToolUse/PostToolUse 事件。
- **工程产物契约**：`container/artifact-contracts/` 定义不同阶段建议稳定返回的字段、文档路径、front matter、文件大小和允许根目录，避免 Agent 只给自然语言结论。这里的“契约”是内部机器接口，不是对外兼容承诺。
- **阶段评估器**：`workflow-stage-evaluation` 和 `workflow-evaluator-registry` 对交付结果做结构化判定，区分 passed、needs_revision、failed、pending 等结果。
- **失败分类**：`failure-taxonomy` 把模型错误、工具错误、沙箱错误、超时、配置错误、权限错误、部署失败、测试失败等分类，方便重试、提醒和复盘。
- **可观测 Trace**：`agent_queries`、`agent_query_steps`、`agent_query_events` 记录 Agent 查询、工具步骤、系统事件、模型解析和错误上下文。

这套 harness 将 Agent 从“不可控的聊天模型”提升为“工程执行器”。它可以失败，但失败会被归类；可以中断，但能恢复；产物也可以用轻量内部契约检查。检查深度应与本地状态风险匹配，而不是追求交付级认证。

## 4. 记忆机制和 LLM Wiki

Icarus 同时维护两类长期上下文：面向行为偏好的结构化记忆，以及面向项目知识的 LLM Wiki。两者互补，避免把所有历史都塞进对话上下文。

### 结构化记忆

记忆系统按层级和类型组织：

- **canonical**：稳定事实、规则、长期偏好。
- **episodic**：阶段性事件、任务经验、过往决策。
- **working**：近期上下文、短期状态。
- **memory_type**：preference、rule、fact、summary。

`memory-pack` 会根据检索分数、直接匹配次数、记忆层级、记忆类型和更新时间排序，并按层级配额打包进 Agent 上下文。新用户指令优先于旧记忆，冲突记忆可通过 doctor/gc/resolve 机制清理。

### LLM Wiki

Wiki 面向更稳定、更可引用的项目知识，核心对象包括：

- **materials**：原始材料，支持 Markdown、代码、日志、CSV、PDF 等输入。
- **drafts**：由 LLM 基于材料生成的页面草稿。
- **pages**：正式 Wiki 页面，保存 slug、标题、类型、摘要和正文。
- **claims**：页面中的关键断言。
- **evidence**：断言对应的材料证据和 excerpt。
- **relations**：页面之间的关系图谱。
- **jobs**：异步生成、重试和状态管理。

LLM Wiki 的价值不只是“能搜索文档”，而是把非结构化材料沉淀为可检索、可引用、可追溯证据的知识网络。Agent 在执行任务时可以通过 `wiki_search` 和 `wiki_get_page` 获取稳定知识，而不是依赖模糊记忆或历史聊天。

## 5. 工作流机制：配置驱动的 Agent 协作状态机

Icarus 的工作流引擎把复杂研发活动建模为配置驱动的状态机。工作流定义位于 `container/workflow-definitions/`，卡片、产物契约、评估器和角色映射独立配置。

一个工作流通常包含：

- **roles**：定义 planner、dev、reviewer、ops、test 等角色，并按渠道映射到具体 agent folder。
- **entry_points**：支持从方案、开发、测试、Bug 修复等不同入口开始。
- **states**：状态类型包括 delegation、interrupt、system、terminal。
- **delegation**：把任务交给某个角色 Agent，附带 Skill、任务模板、输入输出 schema、允许工具、成功标准和失败分类。
- **interrupt**：需要人类审批、补充输入、凭证确认或外部条件时中断，并通过 Web、飞书或 Assistant 恢复。
- **checkpoint**：保存 workflowId、stateKey、round、context、delegationId 和 pending interrupt，支持中断恢复和异常重启。
- **outbox**：把通知、卡片刷新、工作台 action item、助手 inbox、产物索引等副作用放入 outbox 异步处理，降低状态迁移和外部发送的耦合。
- **evaluation**：阶段完成后运行产物契约和评估器，决定进入下一阶段、退回修改、等待人工确认或失败终止。

这让需求开发、Bug 修复、预发部署、测试验证等流程从“一次性 prompt”变成可审计的工程闭环。Agent 可以负责执行，但流程所有权在宿主机状态机手里。

## 6. Agent Group：基于 Git 的跨机器角色协作

Agent Group Collaboration Runtime 是独立于本地 Dynamic Workflow Runtime 的长期、可循环协调层。多个用户各自在自己的 Icarus 实例上运行角色任务，通过 Git 控制分支上的 SSH 签名提交共享流程事实；任何单机的 SQLite、working tree 或 Executor 状态都不能单独推进群组。

协议把流程边界与执行实现分开：

- **创建者拥有流程骨架**：创建者只定义 Role、State、每个非终态的 `owner_role`、合法 Outcome 和目标 State，并保留启动、暂停、恢复和关闭权限。Transition 是纯路由，不绑定执行角色或 Action。
- **Role Owner 拥有执行实现**：认领 Role 的 principal+agent 才能为该 Role 负责的 State 发布、修订或撤回 State Implementation，并选择 manual、assisted 或 automatic。Action、Prompt 和 Workflow ref 归 Role Owner；本地 Binding 只收窄 Workspace、Provider、权限和审批策略，不能改写 Action 类型或 Prompt。
- **Turn 固定执行快照**：进入 State 时生成 Turn，并固定 Machine、Implementation、Action、Prompt、incoming Handoff、attempt 和 fencing token 的哈希与身份。完成者只能选择当前 State 的合法 Outcome，Reducer 再确定目标 State，不能直接指定跳转。
- **节点计时与超时不越权**：Creator 可配置 start/execution 双 deadline 和 reminder interval；deadline 在 Turn 创建/开始时固定。超时第一阶段仅 `notify_only`，按 turn+attempt+kind 经 Git CAS 幂等记录，并提醒 Role Owner/claimant 与 creator，不依据本地时钟推进 FSM。
- **人工和 Agent 共用完成协议**：manual 由当前角色用户确认开始和完成；assisted 在用户确认开始后调用 Executor，并等待用户确认业务完成；automatic 可自动执行和完成，但 Result Schema、Outcome、claim 和 fencing 任一不合法都会进入恢复路径。
- **交接和产物受控共享**：Handoff 是有大小和 schema 限制的不可信输入，不能覆盖系统指令、权限或 FSM。Artifact 先在本机按 Turn 暂存并校验路径、hash 和大小，再与 Completion 在同一个签名 commit 中发布。

Git 保存群组定义、Role-owned Implementation、线性事件链、Projection、Handoff 引用、deadline/timeout observation 和共享 Artifact；本机 `collaboration.db` 保存 Binding、durable receipt、staged upload、通知/reminder、Provider observation、同步诊断和可重建缓存。Runtime 以 event sequence 为共享事实的权威顺序，`occurred_at` 用于时间线和 duration；跨机器 clock skew 只形成审计告警，不改变 reducer。`principal_id` 从 SSH 签名公钥 fingerprint 稳定派生，`agent_id` 是本机首次生成并持久化的 UUID，创建和加入接口不接受调用方覆盖。这一划分使不同机器可以重放出相同 Projection，同时把绝对路径、Provider 连接、凭据和私有执行记录留在本机。

Web/Electron 工作台的 `/groups` 是完整操作入口，包含 Skeleton Builder、Role Implementation 和 Binding、当前与历史 Turn、manual 确认、合法 Outcome 预览、Handoff、Artifact、节点计时/deadline、审计时间线与脱敏 JSON 导出、事件、共享数据和恢复诊断。协议当前直接使用 v2，本地 SQLite 使用 v4；因为没有存量群组或历史 receipt，旧协议和旧 store 均 fail closed，不保留双模型或迁移兼容层。

## 7. 五大核心模块分工与巧妙设计

### Web 工作台客户端

Web 工作台是用户主动控制台，负责创建任务、查看阶段进度、审批中断、浏览产物、管理知识库、查看 Trace 和配置流程。它的优势是把 Agent 的黑盒执行展开成可操作的工程视图：任务状态、当前阶段、待处理项、产出物、评论、时间线和失败信息都能集中查看。

### 个人助理客户端

个人助理是 Agent 主动入口，常驻桌面，扫描今日计划、工作台任务、定时任务、Agent Runs 和线上日志。它不会替代工作台，而是负责发现“应该被注意”的问题，并在策略允许时发起调查或准备修复。它把 Agent 从被动工具推进到主动协作者。

### 移动端渠道

移动端渠道当前由飞书承载，定位是离开电脑时的轻量补充入口。它适合查询任务、处理审批、接收提醒、补充说明和简单下发任务，不承载复杂配置和高风险操作。这个边界避免移动端变成第二套工作台，也保证状态最终回写宿主机和 Web 工作台。

### 宿主机服务

宿主机服务是可信控制面，负责频道接入、消息路由、SQLite 状态、工作流引擎、任务调度、容器队列、IPC Watcher、凭证代理、MySQL 代理、Wiki、记忆、Trace 和审计。它的设计重点是“控制面不进入容器，执行面不越过控制面”。

### 容器 Agent

容器 Agent 是隔离执行面，负责调用 Claude Agent SDK、使用工具、读写挂载目录、执行命令、浏览网页、生成产物，并通过 IPC 与宿主机通信。它可以强执行，但没有真实模型密钥，也没有直接宿主机控制权限，离开容器挂载边界后无法影响系统。

这五个模块的分工清晰：Web 负责主动操作，Assistant 负责主动发现，移动端负责碎片化处理，宿主机负责可信编排，容器负责隔离执行。每个模块都只做自己最适合做的事。

## 8. 其他核心优点

- **多端一致状态**：Web、Assistant、飞书都不是孤立入口，最终状态统一写入 SQLite、workflow、workbench 和 Trace。
- **人机协作边界清晰**：interrupt/resume 把审批、修改意见、凭证、人类输入建模为正式状态，而不是临时聊天消息。
- **可扩展但不失控**：新增频道走 Channel Registry，新增流程走 workflow definition，新增角色方法论走 Skill，新增知识走 Wiki，避免把扩展全部塞进主流程代码。
- **主动性可控**：个人助理支持 quiet、balanced、active 等策略，调查和修复能力按触发规则独立控制，避免 Agent 主动性越权。
- **交付可审计**：每次 Agent 执行都有 runId/queryId、模型解析、工具事件、产物、评估结果和失败分类。
- **工程上下文稳定**：结构化 handoff、产物契约、Wiki 和 memory pack 共同减少“靠聊天历史猜上下文”的不稳定性。
- **跨机器协作可重放**：Agent Group 通过签名 Git 事件、纯 FSM 路由、revision/CAS、claim 和 fencing 把角色自治执行收敛为可审计的共享状态。
- **支持持续改进**：阶段评估、失败分类、Trace、记忆和 Wiki 为人工分析与迭代提供可追溯证据。

## 9. 与已有 Agent 架构相比的核心优点

以下比较基于 2026-05-12 查询到的公开文档和仓库 README：OpenClaw 官方文档/仓库、Claude Code 文档、OpenAI Codex/Agents 文档，以及 Hermes Agent 官方文档/仓库。

### 相比 OpenClaw

OpenClaw 的公开定位是 local-first 个人 AI 助手：一个长期运行的 Gateway 管理多渠道、客户端、节点、会话和工具；多 Agent 通过 `agentId` 路由到独立 workspace、agentDir 和 session store；沙箱是可配置能力，工具可在 Docker/SSH/OpenShell 等后端中执行，未启用时工具运行在宿主机。它的优势在于多渠道覆盖、个人助理体验、快速接入和丰富技能生态。

Icarus 的核心优势不是“更多渠道”，而是更强的工程控制面：

- **沙箱默认进入执行主路径**：Icarus 把容器 Agent 作为执行面基础设施，而不是只把 sandbox 当成某类工具后端。Agent 的 Bash、文件读写、浏览器和 MCP 调用都在容器边界内完成，宿主机只暴露受控 IPC、凭证代理和明确挂载目录。
- **凭证和执行彻底分离**：OpenClaw 文档强调 Gateway、工具策略、DM pairing、sandbox 等边界；Icarus 进一步把模型 API Key 和 OAuth Token 留在宿主机 `credential-proxy`，容器只拿占位凭证，避免“Agent 读到真实密钥后再约束它不要外泄”的脆弱模式。
- **面向交付的工作流状态机**：OpenClaw 的多 Agent 路由更像“多个隔离人格/账号/渠道”的路由系统；Icarus 的多 Agent 是 planner、dev、reviewer、ops、test 等工程角色围绕 workflow state、artifact contract、stage evaluation、failure taxonomy 和 interrupt/resume 协作。
- **交付边界更可审计**：Icarus 要求阶段产物、handoff envelope、评估结果、Query Trace、失败分类进入统一数据库和工作台视图，目标是让 Agent 任务可以被暂停、复核、退回、重跑和复盘，而不仅是完成一次会话回复。

### 相比 Claude Code、Codex 这类编程 Agent

Claude Code 和 Codex 的公开文档都已经支持 subagent、工具权限、上下文隔离、approval/sandbox、并行工作等能力。Claude Code subagent 强调独立上下文窗口、专门系统提示、独立权限和前台/后台执行；Codex CLI 是本地终端编程 Agent，可以读写代码、运行命令，并可显式 spawn subagents；OpenAI Agents SDK 也有 sandbox、handoff、guardrail 和 eval 文档。

Icarus 的优势在于它不是“一个更会写代码的 CLI”，而是把编程 Agent 放进完整研发运行时：

- **从代码会话升级为工程流程**：Claude Code/Codex 的强项是 repo 内探索、编辑、测试和 review；Icarus 把这些能力作为工作流中的一个阶段，前后还有需求澄清、计划、评审、部署、测试验证、线上日志调查、人类审批和产物归档。
- **跨端入口和统一状态**：编程 CLI 通常围绕终端、IDE 或云任务运行；Icarus 把 Web 工作台、桌面 Assistant、飞书移动端、定时任务和 Agent Trace 收敛到同一个宿主机状态机，用户可以在不同入口继续处理同一任务。
- **角色隔离不只靠提示词**：Claude Code/Codex 的 subagent 主要隔离上下文、提示和工具权限；Icarus 还隔离容器、`.claude` 会话目录、IPC 来源、挂载目录、Skill 包、workflow metadata 和 agent queue 资源配额。
- **评估和失败归因是内建闭环**：OpenAI Agents 文档提供 traces、graders、guardrails 等通用能力；Icarus 在项目层把 artifact contract、stage evaluator、failure taxonomy 和 workbench timeline 固化为研发交付协议，减少“Agent 说完成了，但无法判断是否可交付”的问题。

### 相比 Hermes Agent

Hermes Agent 的公开定位是自改进、常驻、跨平台个人 Agent：它强调 persistent memory、session search、自动技能创建、技能自我改进、gateway、多 terminal backends、subagents、cron、trajectory/RL 数据生成等能力。它的优势是长期陪伴、自学习和个人自动化生态。

Icarus 与 Hermes 的取舍不同：Icarus 不把“越用越会自己长技能”放在唯一中心，而是把“工程任务可控交付”放在中心。

- **知识沉淀更偏证据化**：Hermes 的 built-in memory 是 bounded、agent-curated 的 `MEMORY.md`/`USER.md` 加 session search，也支持外部 memory provider；Icarus 同时维护结构化 memory 和 LLM Wiki，把 materials、claims、evidence、relations、pages 分开，让项目知识可以被检索、引用和追溯证据。
- **不开放自主改写系统**：Hermes 强调 agent 从经验中自动创建和改进技能；Icarus 把系统能力变更留给显式工程工作流和人工审查，更适合对稳定性要求较高的工程系统。
- **执行权限更集中在可信宿主机控制面**：Hermes 支持多种运行后端和安全机制；Icarus 的设计重点是“控制面不进容器，执行面不越过控制面”，容器通过 IPC 向宿主机申请受控能力，宿主机按 agent/main、workflow、stage 和 allowlist 判定。
- **研发协作对象更明确**：Hermes 是一个泛化常驻个人 Agent；Icarus 把 planner/dev/reviewer/ops/test/wiki/assistant 等角色、产物契约和工作台操作面组合成研发团队语义，更适合需求开发、Bug 修复、预发部署、测试验证和线上故障处理这类多人/多阶段工程任务。

总结来说，OpenClaw 更像多渠道 local-first 个人助手平台，Claude Code/Codex 更像强大的编程 Agent 工作台，Hermes 更像会长期学习的个人自动化 Agent；Icarus 的核心差异是把这些能力收束成“可信宿主机控制面 + 容器化执行面 + 状态机工作流 + 可追踪内部契约”的个人实验运行时。

## 10. 前沿 Agent 技术在本项目中的体现

Icarus 并不是逐字复刻某篇论文，而是把多个前沿 Agent 思路工程化落地：

- **Anthropic Multi-Agent Research / Orchestrator-Workers**：Anthropic 没有以 arXiv 论文形式发布这套架构，但在官方 Engineering 文章 `How we built our multi-agent research system` 中系统介绍过 multi-agent research system：由 lead agent 分析任务、制定策略，并创建 specialized subagents 并行探索不同方向；在 `Building effective agents` 中也把 orchestrator-workers 总结为中心 LLM 动态拆解任务、委派 worker LLM、再综合结果的模式。Icarus 的“蜂窝架构”与这个方向高度一致，但更偏工程交付：主调度在宿主机工作流中完成，子 Agent 以角色、Skill、容器、IPC、会话和工具边界隔离，最终通过 handoff envelope、产物契约和阶段评估回收结果。
- **Claude Code Subagents / Agent Teams**：Anthropic 的 Claude Code 文档强调 subagent 拥有独立上下文窗口、可配置工具权限和专门系统提示，并适合隔离高输出操作、并行研究和链式协作。Icarus 把这一思想进一步运行时化：每个角色 Agent 不只是提示隔离，还拥有独立容器、独立 `.claude` 会话、独立 IPC 命名空间和按角色分配的 Skill。
- **ReAct**：ReAct 强调推理与行动交替进行。Icarus 中 Agent 通过工具调用、MCP、Bash、Web、浏览器和结构化 handoff 在“思考-行动-观察-再行动”的循环里推进任务，同时 Trace 记录过程，提升可解释性。
- **Reflexion**：Reflexion 的核心是利用语言反馈和 episodic memory 改善后续决策。Icarus 的阶段评估、失败分类、记忆提取和 memory pack 提供了类似的反馈沉淀机制。
- **Voyager**：Voyager 强调自动课程、Skill Library 和可组合技能。Icarus 通过工作流入口、角色 Skill 和项目知识库，把方法论沉淀为可复用的执行能力。
- **SWE-agent / ACI**：SWE-agent 证明 Agent-Computer Interface 会显著影响软件工程 Agent 表现。Icarus 的 harness、工作区挂载、工具白名单、产物契约、测试/部署工具、Trace 和工作台视图，本质上是在为工程 Agent 构建专用 ACI。
- **多 Agent 协作框架**：AutoGen、MetaGPT 等工作强调角色化协作和对话式编排。Icarus 采用更工程化的方式：角色 Agent 不靠自由聊天协作，而是通过状态机、handoff envelope、产物契约和评估器协作。

## 参考资料

- 本项目文档：`README.md`、`docs/SECURITY.md`、`docs/SPEC.md`、`docs/SDK_DEEP_DIVE.md`、`docs/agent-group-collaboration-runtime-plan.md`、`docs/agent-group-role-owned-execution-optimization.md`
- 核心实现：`src/container-runner.ts`、`container/agent-runner/src/index.ts`、`src/workflow.ts`、`src/collaboration/`、`src/memory-pack.ts`、`src/wiki.ts`、`src/credential-proxy.ts`、`src/ipc.ts`
- OpenClaw GitHub README, https://github.com/openclaw/openclaw
- OpenClaw Gateway architecture, https://docs.openclaw.ai/concepts/architecture
- OpenClaw Agent runtime, https://docs.openclaw.ai/concepts/agent
- OpenClaw Sandboxing, https://docs.openclaw.ai/gateway/sandboxing
- OpenClaw Multi-Agent Routing, https://docs.openclaw.ai/concepts/multi-agent
- Anthropic Claude Code Docs, Create custom subagents, https://code.claude.com/docs/en/subagents
- OpenAI Codex CLI, https://developers.openai.com/codex/cli
- OpenAI Codex Subagents, https://developers.openai.com/codex/subagents
- OpenAI Agents SDK, Sandbox Agents, https://developers.openai.com/api/docs/guides/agents/sandboxes
- OpenAI Agents SDK, Orchestration and handoffs, https://developers.openai.com/api/docs/guides/agents/orchestration
- OpenAI Agents SDK, Guardrails and human review, https://developers.openai.com/api/docs/guides/agents/guardrails-approvals
- OpenAI Agents SDK, Evaluate agent workflows, https://developers.openai.com/api/docs/guides/agent-evals
- Hermes Agent GitHub README, https://github.com/NousResearch/hermes-agent
- Hermes Agent Documentation, https://hermes-agent.nousresearch.com/docs/
- Hermes Agent Architecture, https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- Hermes Agent Persistent Memory, https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/
- Hermes Agent Security, https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/security
- Hermes Agent Skills Hub, https://hermes-agent.nousresearch.com/docs/skills
- Anthropic, How we built our multi-agent research system, https://www.anthropic.com/engineering/built-multi-agent-research-system
- Anthropic, Building effective agents, https://www.anthropic.com/engineering/building-effective-agents
- Anthropic Claude Code Docs, Create custom subagents, https://code.claude.com/docs/en/sub-agents
- ReAct: Synergizing Reasoning and Acting in Language Models, arXiv:2210.03629, https://arxiv.org/abs/2210.03629
- Reflexion: Language Agents with Verbal Reinforcement Learning, arXiv:2303.11366, https://arxiv.org/abs/2303.11366
- Voyager: An Open-Ended Embodied Agent with Large Language Models, arXiv:2305.16291, https://arxiv.org/abs/2305.16291
- SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering, arXiv:2405.15793, https://arxiv.org/abs/2405.15793
