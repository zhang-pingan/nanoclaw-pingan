# Icarus

Icarus 是一个面向个人使用的内部实验性 Agent 工作系统。它把用户主动发起的工作流、桌面个人助手的主动提醒、移动端补充入口、企微员工私人客服、宿主机上的任务编排，以及容器内的高权限 Agent 执行环境组合在一起，让 Agent 既可以作为用户工作台里的工具，也可以作为常驻的私人助手主动推进问题。

本项目不是需要对外交付或承诺稳定服务的产品，不提供 SLA、长期兼容性、无中断升级或合规认证保证。项目中的冻结检测、发布/激活、合同、审计和审批机制，目的仅是降低开发返工、保护本机已有状态，并避免开发中的变更影响日常使用；它们不代表面向客户的生产发布流程。术语边界和减重原则见 [`docs/internal-experimental-scope.md`](docs/internal-experimental-scope.md)。

项目当前处于无真实历史业务数据的开发迭代期，采用全项目 **latest-only** 版本策略：新的协议、Schema、API、事件、Git 目录或 SQLite Schema 合入后立即成为唯一 current version；不保留旧版本迁移、双写、兼容读取、兼容回放或旧客户端协商。显式版本字段用于识别并拒绝陈旧输入，不代表兼容承诺。旧开发数据通过精确、显式的重建流程处理，不能借此静默删除源码、配置、凭据或用户文件；完整边界见 [`docs/internal-experimental-scope.md`](docs/internal-experimental-scope.md#development-version-policy)。

项目当前由七个核心模块组成：

- **Web 工作台客户端**：用户主动操作的 Agent 工作台。它把需求、计划、开发、测试、审批、知识库、记忆、Trace、配置等现有工作流集中到一个工作界面中。这里的 Agent 是被动辅助工具，用户发起任务、查看进度、补充上下文、审批动作。
- **Collaboration Project Space Runtime**：多个用户各自在本地运行 Icarus，通过 Git 签名事件链共享项目空间、Principal Workspace、Work Item、Discussion、可选 Workflow、Turn、Handoff 和 Artifact；同一 Principal 可使用多个 Client，并为被指派 State 选择 manual、assisted 或 automatic 执行。
- **个人助理客户端**：主动型 Agent 入口。它常驻桌面，主动扫描今日计划、工作台任务、定时任务、Agent 执行异常和线上日志，发现问题后提醒用户，并可在策略允许时发起排查、准备修复或推进受控修复。
- **移动端渠道**：当前由飞书承载。它不是完整工作台，而是用户不在电脑前的补充操作入口，主要用于任务查询、处理审批项、接收提醒、简单任务下发和补充说明。
- **企微员工私人渠道**：当前由企业微信自建应用承载。它是 Icarus 和企微员工之间的一对一私人客服，通过私聊从员工处获取解决 Icarus 运行问题所需的信息，也可以作为 Icarus 的私人客服处理员工提出的要求或问题。
- **宿主机服务**：本地 Node.js 主进程。它负责频道接入、Web API、SQLite 状态、工作流引擎、任务调度、容器队列、IPC、凭证代理和审计记录。
- **容器 Agent**：隔离执行器。它运行在 Docker 或 Apple Container 中，负责实际调用 Claude Agent SDK、读写挂载目录、执行命令、浏览网页、生成产物，并通过 IPC 把结果交回宿主机。

## 产品定位

Icarus 不是一个多用户 SaaS，也不是一个通用低代码平台。它更像一套“个人 Agent 操作系统”：

- 用户在工作台中把日常工作显式建模为任务和流程。
- Agent 在流程中承担开发、测试、排查、文档、知识整理等执行角色。
- 个人助理在后台观察系统状态，把“应该注意的事”推到用户面前。
- 移动端渠道让用户离开电脑时仍能查询任务、处理审批点和下发简单任务。
- 企微员工私人渠道让 Icarus 可以通过一对一私聊向员工收集运行问题上下文，或代表 Icarus 响应员工请求。
- 所有高权限执行都被放进容器，通过明确挂载、凭证代理和审计日志限制影响面。

四类交互入口的边界是项目的关键设计：

| 入口               | 用户意图           | Agent 角色             | 典型场景                                                 |
| ------------------ | ------------------ | ---------------------- | -------------------------------------------------------- |
| Web 工作台         | 用户主动           | 被动辅助工具           | 新建需求、推进工作流、审批阶段、查看产物、追踪 Trace     |
| 个人助理           | Agent 主动         | 私人助手               | 发现计划缺失、任务卡住、执行失败、线上报错、提醒并排查   |
| 移动端渠道（飞书） | 用户碎片化补充操作 | 轻量任务入口和审批触达 | 查询任务、处理待审批项、接收提醒、简单任务下发、补充说明 |
| 企微员工私人渠道   | 员工一对一沟通     | 私人客服和信息收集员   | 询问运行问题上下文、补充排查信息、处理员工请求或问题     |

## 总体架构

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                      用户界面层                                       │
├────────────────────┬────────────────────┬────────────────────┬──────────────────────┤
│ Web 工作台客户端    │ 个人助理客户端      │ 移动端渠道（飞书）  │ 企微员工私人渠道      │
│ Electron/Web UI    │ Electron Tray/悬浮窗│ Feishu Bot/Card    │ WeCom App 私聊        │
│ localhost:3000     │ 主动提醒、Inbox     │ 任务查询、审批、下发│ 信息收集、私人客服    │
└─────────┬──────────┴─────────┬──────────┴─────────┬──────────┴──────────┬───────────┘
          │ HTTP/WebSocket/API │ HTTP/API/IPC       │ Webhook/API        │ Webhook/API
          ▼                    ▼                    ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                    宿主机服务层                                       │
│ src/index.ts                                                                         │
│                                                                                      │
│ Channel Registry  WebChannel  AssistantChannel  FeishuChannel  WeComChannel          │
│ Workflow Engine   Workbench Store  Today Plan  Assistant Engine                      │
│ Collaboration Project Spaces  Git signed events  Local Executor bindings             │
│ Scheduler         Agent Queue      IPC Watcher  Credential Proxy                     │
│ SQLite DB         Trace Manager    Config/Wiki  MySQL Proxy                          │
└───────────────────────────────────────┬──────────────────────────────────────────────┘
                                        │ 启动/复用容器，文件 IPC
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                    容器 Agent 层                                      │
│ container/agent-runner                                                               │
│                                                                                      │
│ Claude Agent SDK  Bash/文件工具  WebSearch/WebFetch  Browser                         │
│ /workspace/agent  /workspace/project(ro)  /workspace/ipc                             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 核心模块

### Web 工作台客户端

Web 工作台由 `src/channels/web.ts` 启动本地 HTTP/WebSocket 服务，默认监听 `127.0.0.1:3000`，前端资源位于 `electron/renderer/`。Electron 客户端由 `electron/main.ts` 包装，也可以直接通过浏览器访问本地工作台。

工作台的定位是“用户主动控制台”。它提供：

- **Agent 会话**：按 Agent 查看消息、文件、上下文和回复。
- **工作台任务**：创建任务、查看阶段进度、待处理项、产出物、上下文资产、评论和执行时间线。
- **流程定义**：维护流程状态机、角色映射、卡片和阶段配置。
- **今日计划**：聚合工作台任务、群聊会话、服务分支变更，生成并发送计划邮件。
- **个人助手控制面板**：配置主动扫描和触发源，查看 Agent Inbox 和动作日志。
- **记忆管理**：管理长期记忆、冲突处理、指标和清理。
- **知识库管理**：导入材料、生成草稿、发布 Wiki 页面。
- **Trace 监控**：查看 Agent Query、步骤、事件、失败类型和执行输出。
- **配置管理**：维护服务配置、流程定义、卡片配置等运行时资产。
- **协作项目空间**：在 `/groups` 创建、观察或加入 Git 项目空间，管理 Principal/Client 与直接权限、Workspace、Work Item、Discussion、可选 Workflow Definition/Instance、本地 Executor Binding、Turn、Artifact、审计和恢复诊断。

用户在工作台中发起动作，宿主机服务再把任务拆解给流程引擎和容器 Agent。Agent 不直接接管用户界面，而是把结果、问题和审批点同步回工作台。

### Collaboration Project Space Runtime

Collaboration Project Space 是与本地 Dynamic Workflow Runtime 分离的跨机器协作模式。Group 创建后立即可用，不要求预先创建 Workflow。共享事实只存在于 Git 控制分支上的 Icarus Credential 签名事件和物化文件；SQLite 保存本机订阅、Credential 私钥引用、Executor Binding、durable receipt、staged upload、通知投递、Provider observation、诊断和可重建缓存。

- Principal 是 Group 内的稳定成员与权限主体，使用系统生成的 `principal_<uuid>`，不从 SSH key 或 Credential fingerprint 派生。每个 Icarus 安装持久化一个 `client_<uuid>`，同一 Principal 可通过批准的身份恢复绑定多个 Client。
- 每个 Client 的 Icarus event-signing Credential 由 Host 自动生成；共享 Git 只保存 `credential_id`、Principal/Client 绑定、公钥、系统校验的 fingerprint、purpose、status 和生命周期事件，私钥仅保存在本机安全目录。Credential 可以轮换或单独撤销而不改变 Principal。
- Git Remote 账号/SSH 只控制 clone、fetch、push。Git SSH Key 路径是可选本地 transport 设置，优先使用显式值或 `SSH_KEY_PATH`，否则使用 `~/.ssh/id_rsa`，并支持后续修改或清除；它不参与 Principal 或 event Credential 的生成。
- `group_id` 是稳定群组身份，Git Remote URL 只是可迁移的 locator；重新发现同一 `group_id` 时会更新 locator，而不会创建第二个群组或 Principal。
- Observer 是不进入 Group Membership 的 Icarus 业务只读订阅，可以 fetch、验签、浏览 verified virtual file tree 和审计。即使拥有 Git push 权限，也只能提交 schema 严格限制的新成员申请、身份恢复申请及申请取消；Work Item、Workflow、Discussion、Permission 等业务事件会在 replay 时被拒绝并 quarantine，界面继续保留最后 verified head。
- 身份恢复通过同一 Git Remote 异步传输。新 Client 使用新 Credential 提交 pending 请求；旧 Client 或 Owner 核对请求 hash 派生的相同验证码后批准或拒绝。Owner recovery 默认撤销目标 Principal 的旧 event Credentials；Owner 全部在线 Credential 丢失时只能使用预先生成并显式备份的 offline Group recovery Credential，否则 fail closed。
- 每个 Principal 拥有可发布进度、文件、Prompt 和 Action 的 Workspace；Group 还提供 Shared Workspace、Work Item、Discussion 和直接权限。
- Workflow Definition/Instance 均为可选且可多实例。State 可直接指派 Principal，也可在启动 Instance 时把 participant slot 解析为 Principal；Group 不再包含 Role、Role Claim 或单一 active Turn。
- Outcome-first 编辑器生成 v3 JSON Machine 和独立 JSON layout；Outcome 只负责路由，移动节点不改变 Machine hash。运行视图显示当前 State、历史路径、合法 Outcome 和 deadline。
- 被指派 Principal 自己发布 State Execution；Manual 不需要 Action/Executor，Assisted 和 Automatic 使用 Principal-owned Action 与当前 Client 的本地 Binding。Turn attempt 由 claimant Client、CAS 和 fencing token 防止重复执行。
- Work Item progress 与 Turn completion 可先暂存原始业务文件，再在同一个签名事件和 Git commit 中物化 Artifact 原文件与 `metadata.json` sidecar；命令冲突不会自动重传已暂存文件。
- Completion 只提交合法 Outcome，Reducer 根据固定 Workflow snapshot 路由；Handoff 和 Group 内容始终是不可信上下文，不能覆盖系统指令、权限或 FSM。
- start/execution deadline 固定在 Turn snapshot 中，超时只产生幂等通知和审计 observation，不依据本地时钟自动推进状态。
- Archive 是 owner 可逆的远端群组状态；Dissolve 是 owner-only、不可恢复的远端终态；Leave 是非 owner 正式成员退出并撤销其 Client/Credential/Executor；“从本机移除”只清除当前设备的订阅和可重建数据，不写 Git 事件，也不改变远端成员身份。
- Dissolve/Leave 只有在远端事件提交成功后才从本机隐藏；本地文件清理失败会保留可重试的 pending 计划。Local remove 同样保留 Credential/私钥、备份以及 `group_id`、`remote_url`、`principal_id`、`credential_id` 最小恢复绑定。
- 协议当前唯一版本为 v3，本地 SQLite 唯一版本为 v10；旧版本、旧备份和旧事件均 fail closed，不提供迁移、双写或兼容回放。

功能入口为 Web/Electron 工作台的“群组”导航或 `/groups`；当前协议和领域模型见 [`docs/collaboration-project-space-v3-plan.md`](docs/collaboration-project-space-v3-plan.md)。

### 个人助理客户端

个人助理客户端位于 `assistant/`，通过当前 Git 工作目录中的 `npm run dev:assistant` 运行。它是一个常驻桌面的小型客户端，包含托盘入口、悬浮窗、聊天面板、主动提醒和工作台跳转能力。

个人助理的定位是“Agent 主动层”。它不替代工作台，而是在工作台之上做主动感知和推进：

- **主动扫描**：周期扫描今日计划、工作台、定时任务、Agent Runs、线上日志。
- **Agent Inbox**：把发现的问题转换为待处理事项，支持标记已读、忽略、稍后、完成。
- **排查与修复入口**：对任务失败、执行异常、日志错误等事项发起调查、准备修复或自动流程。
- **策略控制**：支持 `quiet`、`balanced`、`active` 主动等级、扫描间隔、触发源、静默时段和服务范围。
- **桌面体验**：支持开机启动、置顶、移动、隐藏、打开工作台等桌面行为。

主动性受 `src/assistant/types.ts` 中的 `AssistantSettings` 控制。调查和修复能力按触发规则显式开启，避免把“发现问题”直接升级成高风险操作。

### 移动端渠道

移动端渠道当前由 `src/channels/feishu.ts` 承载，通过飞书 Bot、Webhook 和交互卡片接入宿主机服务。它的定位是“离开电脑时的轻量补充入口”，不是 Web 工作台的完整移动版，也不是主动个人助理的替代品。

移动端主要承担：

- **任务查询**：查看任务状态、阶段进度、待处理项、产出物摘要和最近动态。
- **审批处理**：处理流程中的 approve、revise、skip、retry、continue 等待办动作。
- **简单任务下发**：通过飞书消息快速创建轻量任务、补充上下文或追加指令。
- **提醒触达**：接收工作流中断、执行失败、待审批项、个人助理 Inbox 等需要及时关注的信息。
- **状态同步**：用户在移动端完成的审批、回复和简单下发应回写宿主机状态，并同步到工作台 Trace、时间线和动作日志。

移动端设计要保持轻量：复杂配置、长文档编辑、多产物审查、知识库维护和高风险操作仍以 Web 工作台为主。飞书只是当前实现渠道，后续其他移动 IM 或通知渠道应保持相同的“补充操作入口”边界。

### 企微员工私人渠道

企微员工私人渠道当前由 `src/channels/wecom.ts` 承载，通过企业微信自建应用、Webhook 和应用消息接入宿主机服务。它的定位是“Icarus 和企微员工之间的一对一私人客服”，不是移动工作台、公开群聊入口，也不是无权限限制的管理控制面。

企微员工私人渠道主要承担：

- **运行问题信息收集**：当 Icarus 运行过程中遇到需要员工补充的信息、确认或现场上下文时，通过私聊向对应员工询问。
- **员工请求处理**：作为 Icarus 的私人客服，接收并处理企微员工提出的要求、问题、反馈或补充材料。
- **一对一上下文隔离**：每个授权员工映射到独立的 `wecom:user:{userid}` 会话和 Agent 目录，避免员工私聊上下文互相串扰。
- **附件交换**：支持员工通过私聊提交截图、文件、语音转写等排查材料，必要时由 Icarus 返回处理结果或产物。
- **受控委派**：需要跨频道向企微员工收集信息时，应保留原始任务、Trace 和工作台状态的关联，避免形成脱离宿主机审计的私聊任务状态。

企微员工私人渠道要保持一对一客服边界：它可以收集信息和解决员工请求，但复杂配置、批量管理、高风险操作、跨员工隐私信息查看仍应回到 Web 工作台或宿主机授权流程。

### 宿主机服务

宿主机服务是 `src/index.ts` 启动的单进程 Node.js 服务。它是整个系统的可信编排层，主要职责包括：

- **频道接入**：通过 `src/channels/registry.ts` 自注册机制加载 Web、Feishu、WeCom、Assistant 等频道。
- **消息路由**：接收频道消息，按已注册 Agent、触发词和权限规则进入队列。
- **工作流引擎**：读取 `container/workflow-definitions/*.json` 和卡片配置，驱动流程状态、委派、审批、中断恢复和产物索引。
- **工作台同步**：把 workflow、delegation、interrupt、artifact、evaluation 等运行态同步为工作台任务视图。
- **群组协作**：验证 Icarus Credential 签署的 Git control commit 与 Principal/Client/权限映射并归约 v3 Project Space Projection，调度 Principal-owned Workflow Turn，并管理本地 Credential、Binding、receipt、通知、staged Artifact 和联合备份/恢复。
- **主动助手运行时**：运行 proactive scan、Agent Inbox 和动作日志。
- **任务调度**：支持 cron、interval、once 类型定时任务，并复用容器执行链路。
- **容器队列**：限制并发容器数，复用活跃会话，通过 IPC 推送后续消息。
- **凭证代理**：真实 API Key 只存在宿主机，容器通过本地代理访问模型服务。
- **数据库与审计**：使用 SQLite 保存消息、会话、任务、工作流、Trace、工作台、助理和知识库数据。

### 容器 Agent

容器 Agent 位于 `container/agent-runner/`，镜像由 `container/Dockerfile` 构建。它是实际执行环境，而不是控制平面。

容器内能力包括：

- 调用 `@anthropic-ai/claude-agent-sdk`。
- 使用 Bash、文件读写、搜索、浏览器自动化、WebSearch、WebFetch 等工具。
- 读取 `/workspace/agent` 的 Agent 工作目录和必要的只读项目上下文。
- 通过 `/workspace/ipc` 与宿主机通信，发送消息、创建任务或接收后续输入。
- 使用宿主机凭证代理访问模型 API，容器环境中不包含真实密钥。

默认挂载遵循最小可见原则：

| 主机路径                        | 容器路径                 | 说明                    |
| ------------------------------- | ------------------------ | ----------------------- |
| 项目根目录                      | `/workspace/project`     | 只读，且 `.env` 被隐藏  |
| `agents/{agent}`                | `/workspace/agent`       | 当前 Agent 可写工作目录 |
| `agents/global`                 | `/workspace/global`      | 非主 Agent 只读全局记忆 |
| `data/sessions/{agent}/.claude` | `/home/node/.claude`     | Agent 隔离会话          |
| `data/ipc/{agent}`              | `/workspace/ipc`         | 宿主机与容器通信        |
| `data/attachments`              | `/workspace/attachments` | 附件共享                |
| `data/ai-images`                | `/workspace/ai-images`   | 图片产物共享            |

## 关键运行链路

### 1. 用户主动工作流

```text
用户在 Web 工作台新建任务
  -> 宿主机创建 workflow/workbench_task
  -> Workflow Engine 按状态机推进
  -> 需要 Agent 执行时创建 delegation
  -> AgentQueue 启动或复用容器 Agent
  -> 容器产出代码、文档、测试结果或调查结论
  -> 宿主机写入 Trace、产物、阶段评估和待处理项
  -> 工作台实时刷新，用户审批、退回、跳过、重试或继续
```

### 2. 个人助理主动发现

```text
Proactive Engine 周期扫描数据源
  -> 今日计划、工作台任务、定时任务、Agent Runs、线上日志
  -> 生成或更新 Agent Inbox
  -> 桌面个人助理提醒用户
  -> 用户选择查看、稍后、忽略、排查、修复
  -> 必要时调用容器 Agent 调查或准备修复
  -> 动作日志、Trace、工作台和 Inbox 同步更新
```

### 3. 消息频道执行

```text
Feishu/WeCom/Web/Assistant 消息进入频道
  -> 写入 SQLite messages
  -> 消息轮询发现新消息
  -> 检查已注册 Agent、触发词、发送者 allowlist
  -> 格式化上下文和记忆包
  -> 容器 Agent 执行
  -> 输出流回宿主机
  -> 频道 sendMessage / sendCard 返回给用户
```

其中飞书承担当前移动端渠道：普通消息适合轻量任务下发和上下文补充，交互卡片适合任务查询、审批项处理和提醒确认。移动端动作必须回写工作台状态，避免形成只存在于聊天里的第二套任务状态。

其中企微承担员工私人客服渠道：普通私聊适合向特定员工收集 Icarus 运行问题所需的信息、接收员工反馈和处理员工请求。企微员工私聊必须保持一对一隔离，并通过宿主机消息、Trace、动作日志或工作台任务保留可追溯上下文。

## 目录结构

```text
.
├── src/                         # 宿主机服务核心代码
│   ├── channels/                # Web、Feishu、WeCom、Assistant 等频道
│   ├── assistant/               # 主动助手、Inbox、动作执行
│   ├── index.ts                 # 主进程入口
│   ├── workflow.ts              # 工作流引擎
│   ├── workbench.ts             # 工作台 API/视图模型
│   ├── container-runner.ts      # 容器启动、复用、输出解析
│   └── db.ts                    # SQLite schema 和数据访问
├── electron/                    # Web 工作台 Electron 客户端
│   ├── main.ts
│   └── renderer/
├── assistant/                   # 桌面个人助理 Electron 客户端
│   ├── main.ts
│   └── renderer/
├── container/                   # 容器镜像、Agent Runner、Skills、工作流定义
│   ├── Dockerfile
│   ├── agent-runner/
│   ├── workflow-definitions/
│   ├── cards/
│   └── skills/
├── agents/                      # Agent 工作目录和 Agent 级 CLAUDE.md
├── data/                        # 运行时数据、附件、会话、IPC、上传文件
├── store/                       # SQLite 数据库
├── docs/                        # 架构、启动流程、安全、调试文档
├── setup/                       # 安装和服务管理脚本
└── launchd/                     # macOS launchd 服务模板
```

## 数据模型概览

核心运行状态保存在 SQLite 中，主要表包括：

- `messages`、`chats`：频道消息和聊天元数据。
- `registered_agents`、`sessions`、`router_state`：Agent 注册、会话和路由游标。
- `scheduled_tasks`：定时任务。
- `agent_queries`、`agent_query_steps`、`agent_query_events`：Agent 执行 Trace。
- `workflows`、`delegations`、`workflow_interrupts`、`workflow_events`：流程运行态。
- `workbench_tasks`、`workbench_subtasks`、`workbench_action_items`、`workbench_artifacts`：工作台视图数据。
- `today_plans`、`today_plan_items`、`today_plan_mail_drafts`：今日计划。
- `agent_inbox_items`、`assistant_settings`、`assistant_action_logs`：个人助理。
- `memories`、`wiki_*`：记忆和知识库。

## 本地 Git 工作目录运行

Icarus Host 唯一支持的运行拓扑是本地 Git checkout，也就是 `git clone` 后展开的项目工作目录。依赖、构建、配置、launchd/systemd 服务和可选 Host Core Snapshot 都围绕这个目录工作。移动目录后需要重新执行 setup，让服务管理器记录新的绝对路径。

浏览器、Web 工作台 Electron 客户端和个人助理 Electron 客户端都连接该工作目录启动的 Host。项目不提供独立 `.app`、DMG/PKG、内嵌 Host 的 Electron 应用、打包安装状态迁移或自动更新。

### 环境要求

- Node.js `>=26 <27`，不兼容时 setup 可安装受支持的 fallback
- npm
- Docker 或 Apple Container
- macOS 上可使用 launchd 常驻运行
- 可访问模型 API 的凭证

### 初始化

```bash
./setup.sh
cp .env.example .env
```

编辑 `.env`，至少配置模型访问相关变量。项目支持通过凭证代理把真实密钥保留在宿主机：

```env
ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=https://api.anthropic.com
WEB_PORT=3000
WEB_TOKEN=...
```

如使用 Feishu、WeCom、线上日志、图片生成、模型选择器、MySQL 代理等能力，再按 `.env.example` 补充对应变量。

### 构建容器

Docker：

```bash
npx tsx setup/index.ts --step container --runtime docker
```

Apple Container：

```bash
npx tsx setup/index.ts --step container --runtime apple-container
```

### 开发运行

启动宿主机服务：

```bash
npm run dev
```

启动 Web 工作台 Electron 客户端：

```bash
npm run dev:electron
```

启动个人助理客户端：

```bash
npm run dev:assistant
```

浏览器访问工作台：

```text
http://localhost:3000/
```

如果配置了 `WEB_TOKEN`，API 和 WebSocket 需要携带对应 token，Electron 客户端会从环境中读取。

### Host Core 启动与本地稳定快照

宿主机启动时需要显式选择当前检出或本地稳定快照：

```bash
local/shell/start.sh --mode current
local/shell/start.sh --mode active
```

`current` 构建并运行当前检出；`active` 校验并运行 `active-core` 指向的本地快照，不重建或改变选择。`publish` 只是显式创建一个可回退快照，`activate` 只是选择该快照，两者不是对外发布和部署。启动前的只读 schema 检查、重置前备份和指针原子替换用于保护本机状态；其他发布级完整性校验属于可简化的历史机制。完整行为见 [`docs/host-core-lifecycle.md`](docs/host-core-lifecycle.md)。

### 本地构建

```bash
npm run build
npm run build:electron
npm run build:assistant
```

这些命令只在当前 Git 工作目录中生成构建结果，不生成可独立安装的应用包。

### 测试与检查

```bash
npm test
npm run typecheck
npm run format:check
```

## 安全模型

Icarus 的核心安全边界是容器隔离，而不是让 Agent 在宿主机上直接运行。

关键约束：

- 容器只看到明确挂载的目录。
- 项目根目录默认只读挂载。
- `.env` 不挂载给容器，真实密钥不进入容器环境。
- 模型 API 通过宿主机凭证代理转发。
- 每个 Agent 有独立 `.claude` 会话目录，避免上下文串扰。
- IPC 操作按主 Agent 和非主 Agent 区分权限。
- 额外挂载由 `~/.config/icarus/mount-allowlist.json` 控制，该文件位于项目外，容器不可修改。
- 默认阻止 `.ssh`、`.aws`、`.kube`、`.env`、私钥、credential 等敏感路径挂载。

主 Agent 通常代表用户本人，拥有管理权限；非主 Agent 被视为不可信输入，只能操作自己的上下文和有限资源。

## 扩展方式

### 新增频道

频道通过自注册机制接入：

1. 在 `src/channels/<name>.ts` 实现 `Channel` 接口。
2. 调用 `registerChannel(name, factory)`。
3. 在凭证缺失时让 factory 返回 `null`。
4. 在 `src/channels/index.ts` 添加 import，触发模块加载。

当前 `src/channels/index.ts` 已注册 Web、Assistant、Feishu、WeCom，其他频道可以按同样模式接入。

### 新增工作流

工作流定义位于 `container/workflow-definitions/`，卡片位于 `container/cards/`。新增工作流通常需要：

- 定义状态机、角色、阶段类型和转换。
- 配置角色到不同频道 Agent folder 的映射。
- 配置交互卡片和审批/输入表单。
- 按需要补充产物契约、评估器和工作台展示字段。

### 新增容器技能

容器技能位于 `container/skills/`。它们用于约束 Agent 的方法论，例如需求分析、问题修复、测试修复和运维部署等。技能不是宿主机权限系统，权限仍由宿主机服务和容器挂载控制。

## 相关文档

- `docs/SPEC.md`：系统规格和频道架构。
- `docs/internal-experimental-scope.md`：项目边界、latest-only 版本策略、术语解释和工程机制减重清单。
- `docs/startup-flow.md`：启动流程、消息链路、IPC、数据库表。
- `docs/host-core-lifecycle.md`：Host Core 本地快照、选择、启动和独立 Workflow Runtime 状态维护。
- `docs/SECURITY.md`：安全模型、挂载策略、凭证隔离。
- `docs/DEBUG_CHECKLIST.md`：调试检查清单。
- `docs/docker-sandboxes.md`：容器沙箱说明。
- `local/docs/personal-assistant-runtime-refactor.md`：个人助手主动运行时设计。

## 设计原则

- **内部实验工具优先**：只为当前使用者和本地环境优化，不把内部流程扩展成对外交付、SLA、合规或长期兼容承诺。
- **开发期 latest-only**：每次迭代只实现最新协议、Schema、API 和存储模型；旧版本 fail closed 并显式重建，不维护迁移链或兼容分支。
- **护栏必须减少净返工**：冻结、合同、发布选择和检查只有在能保护本机状态或更早发现高概率回归时才保留；低频、重复或维护成本更高的门禁退出默认开发路径。
- **用户主动和 Agent 主动分层**：工作台承载用户主动工作流，个人助理承载 Agent 主动发现和提醒。
- **移动端只做补充入口**：飞书等移动端渠道用于任务查询、审批处理、提醒触达和简单任务下发，复杂编排和高风险操作回到工作台。
- **企微私聊保持一对一客服边界**：企微员工私人渠道用于收集运行问题上下文和处理员工请求，不扩展成公开群聊、完整工作台或无审计的高权限控制面。
- **宿主机可信，容器高权限但隔离**：控制面留在宿主机，执行面放进容器。
- **工作流可审计**：每次 Agent 执行都有 Query、Step、Event、产物和动作记录。
- **配置服务于流程，不制造配置泥潭**：复杂行为优先用代码、工作流定义和技能表达。
- **小步自动化**：自动排查和自动修复都应有策略、审批和回滚边界。
