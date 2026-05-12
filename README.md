# NanoClaw

NanoClaw 是一个面向个人使用的 Agent 工作系统。它把用户主动发起的工作流、桌面个人助手的主动提醒、宿主机上的任务编排，以及容器内的高权限 Agent 执行环境组合在一起，让 Agent 既可以作为用户工作台里的工具，也可以作为常驻的私人助手主动推进问题。

项目当前由四个核心模块组成：

- **Web 工作台客户端**：用户主动操作的 Agent 工作台。它把需求、计划、开发、测试、审批、知识库、记忆、Trace、配置等现有工作流集中到一个工作界面中。这里的 Agent 是被动辅助工具，用户发起任务、查看进度、补充上下文、审批动作。
- **个人助理客户端**：主动型 Agent 入口。它常驻桌面，主动扫描今日计划、工作台任务、定时任务、Agent 执行异常和线上日志，发现问题后提醒用户，并可在策略允许时发起排查、准备修复或推进受控修复。
- **宿主机服务**：本地 Node.js 主进程。它负责频道接入、Web API、SQLite 状态、工作流引擎、任务调度、容器队列、IPC、凭证代理和审计记录。
- **容器 Agent**：隔离执行器。它运行在 Docker 或 Apple Container 中，负责实际调用 Claude Agent SDK、读写挂载目录、执行命令、浏览网页、生成产物，并通过 IPC 把结果交回宿主机。

## 产品定位

NanoClaw 不是一个多用户 SaaS，也不是一个通用低代码平台。它更像一套“个人 Agent 操作系统”：

- 用户在工作台中把日常工作显式建模为任务和流程。
- Agent 在流程中承担开发、测试、排查、文档、知识整理等执行角色。
- 个人助理在后台观察系统状态，把“应该注意的事”推到用户面前。
- 所有高权限执行都被放进容器，通过明确挂载、凭证代理和审计日志限制影响面。

两类交互的边界是项目的关键设计：

| 入口 | 用户意图 | Agent 角色 | 典型场景 |
| --- | --- | --- | --- |
| Web 工作台 | 用户主动 | 被动辅助工具 | 新建需求、推进工作流、审批阶段、查看产物、追踪 Trace |
| 个人助理 | Agent 主动 | 私人助手 | 发现计划缺失、任务卡住、执行失败、线上报错、提醒并排查 |

## 总体架构

```text
┌────────────────────────────────────────────────────────────────────┐
│                           用户界面层                                │
├──────────────────────────────┬─────────────────────────────────────┤
│ Web 工作台客户端              │ 个人助理客户端                       │
│ Electron/Web UI               │ Electron Tray/悬浮窗                 │
│ localhost:3000                │ 主动提醒、Inbox、桌面聊天             │
└───────────────┬──────────────┴──────────────┬──────────────────────┘
                │ HTTP/WebSocket/API           │ HTTP/API/IPC
                ▼                              ▼
┌────────────────────────────────────────────────────────────────────┐
│                         宿主机服务层                                │
│ src/index.ts                                                        │
│                                                                    │
│ Channel Registry  WebChannel  AssistantChannel  FeishuChannel       │
│ Workflow Engine   Workbench Store  Today Plan  Assistant Engine     │
│ Scheduler         Group Queue      IPC Watcher  Credential Proxy    │
│ SQLite DB         Trace Manager    Config/Wiki  MySQL Proxy         │
└───────────────────────────────┬────────────────────────────────────┘
                                │ 启动/复用容器，文件 IPC
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         容器 Agent 层                               │
│ container/agent-runner                                              │
│                                                                    │
│ Claude Agent SDK  Bash/文件工具  WebSearch/WebFetch  Browser        │
│ /workspace/group  /workspace/project(ro)  /workspace/ipc            │
└────────────────────────────────────────────────────────────────────┘
```

## 核心模块

### Web 工作台客户端

Web 工作台由 `src/channels/web.ts` 启动本地 HTTP/WebSocket 服务，默认监听 `127.0.0.1:3000`，前端资源位于 `electron/renderer/`。Electron 客户端由 `electron/main.ts` 包装，也可以直接通过浏览器访问本地工作台。

工作台的定位是“用户主动控制台”。它提供：

- **Agent 群组会话**：按群组查看消息、文件、上下文和 Agent 回复。
- **工作台任务**：创建任务、查看阶段进度、待处理项、产出物、上下文资产、评论和执行时间线。
- **流程定义**：维护流程状态机、角色映射、卡片和阶段配置。
- **今日计划**：聚合工作台任务、群聊会话、服务分支变更，生成并发送计划邮件。
- **个人助手控制面板**：配置主动扫描、触发源、自我进化策略，查看 Agent Inbox 和动作日志。
- **记忆管理**：管理长期记忆、冲突处理、指标和清理。
- **知识库管理**：导入材料、生成草稿、发布 Wiki 页面。
- **Trace 监控**：查看 Agent Query、步骤、事件、失败类型和执行输出。
- **配置管理**：维护服务配置、流程定义、卡片配置等运行时资产。

用户在工作台中发起动作，宿主机服务再把任务拆解给流程引擎和容器 Agent。Agent 不直接接管用户界面，而是把结果、问题和审批点同步回工作台。

### 个人助理客户端

个人助理客户端位于 `assistant/`，通过 `npm run dev:assistant` 或打包后的 Electron 入口运行。它是一个常驻桌面的小型客户端，包含托盘入口、悬浮窗、聊天面板、主动提醒和工作台跳转能力。

个人助理的定位是“Agent 主动层”。它不替代工作台，而是在工作台之上做主动感知和推进：

- **主动扫描**：周期扫描今日计划、工作台、定时任务、Agent Runs、线上日志。
- **Agent Inbox**：把发现的问题转换为待处理事项，支持标记已读、忽略、稍后、完成。
- **排查与修复入口**：对任务失败、执行异常、日志错误等事项发起调查、准备修复或自动流程。
- **策略控制**：支持 `quiet`、`balanced`、`active` 主动等级、扫描间隔、触发源、静默时段和服务范围。
- **自我进化**：可在受控策略下发现优化方向、生成方案、创建工作分支、实现、检查、复核，并等待用户采纳。
- **桌面体验**：支持开机启动、置顶、移动、隐藏、打开工作台等桌面行为。

主动性受 `src/assistant/types.ts` 中的 `AssistantSettings` 控制。默认自我进化关闭，自动实现和自动采纳也默认关闭，避免把“发现问题”直接升级成“自动修改主分支”。

### 宿主机服务

宿主机服务是 `src/index.ts` 启动的单进程 Node.js 服务。它是整个系统的可信编排层，主要职责包括：

- **频道接入**：通过 `src/channels/registry.ts` 自注册机制加载 Web、Feishu、Assistant 等频道。
- **消息路由**：接收频道消息，按注册群组、触发词和权限规则进入队列。
- **工作流引擎**：读取 `container/workflow-definitions/*.json` 和卡片配置，驱动流程状态、委派、审批、中断恢复和产物索引。
- **工作台同步**：把 workflow、delegation、interrupt、artifact、evaluation 等运行态同步为工作台任务视图。
- **主动助手运行时**：运行 proactive scan、Agent Inbox、动作日志、自我进化状态机。
- **任务调度**：支持 cron、interval、once 类型定时任务，并复用容器执行链路。
- **容器队列**：限制并发容器数，复用活跃会话，通过 IPC 推送后续消息。
- **凭证代理**：真实 API Key 只存在宿主机，容器通过本地代理访问模型服务。
- **数据库与审计**：使用 SQLite 保存消息、会话、任务、工作流、Trace、工作台、助理和知识库数据。

### 容器 Agent

容器 Agent 位于 `container/agent-runner/`，镜像由 `container/Dockerfile` 构建。它是实际执行环境，而不是控制平面。

容器内能力包括：

- 调用 `@anthropic-ai/claude-agent-sdk`。
- 使用 Bash、文件读写、搜索、浏览器自动化、WebSearch、WebFetch 等工具。
- 读取 `/workspace/group` 群组工作目录和必要的只读项目上下文。
- 通过 `/workspace/ipc` 与宿主机通信，发送消息、创建任务或接收后续输入。
- 使用宿主机凭证代理访问模型 API，容器环境中不包含真实密钥。

默认挂载遵循最小可见原则：

| 主机路径 | 容器路径 | 说明 |
| --- | --- | --- |
| 项目根目录 | `/workspace/project` | 只读，且 `.env` 被隐藏 |
| `groups/{group}` | `/workspace/group` | 当前群组可写工作目录 |
| `groups/global` | `/workspace/global` | 非主群只读全局记忆 |
| `data/sessions/{group}/.claude` | `/home/node/.claude` | 群组隔离会话 |
| `data/ipc/{group}` | `/workspace/ipc` | 宿主机与容器通信 |
| `data/attachments` | `/workspace/attachments` | 附件共享 |
| `data/ai-images` | `/workspace/ai-images` | 图片产物共享 |

## 关键运行链路

### 1. 用户主动工作流

```text
用户在 Web 工作台新建任务
  -> 宿主机创建 workflow/workbench_task
  -> Workflow Engine 按状态机推进
  -> 需要 Agent 执行时创建 delegation
  -> GroupQueue 启动或复用容器 Agent
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
Feishu/Web/Assistant 消息进入频道
  -> 写入 SQLite messages
  -> 消息轮询发现新消息
  -> 检查注册群组、触发词、发送者 allowlist
  -> 格式化上下文和记忆包
  -> 容器 Agent 执行
  -> 输出流回宿主机
  -> 频道 sendMessage / sendCard 返回给用户
```

### 4. 自我进化

```text
Evolution Engine 定时或手动触发
  -> 检查 assistant.evolution 设置和运行锁
  -> 选择一个优化方向
  -> 生成方案和风险判断
  -> 等待用户批准或按策略进入实现
  -> 在工作分支实现、检查、复核
  -> 进入 ready_for_adoption
  -> 用户点击采纳后由宿主机合并
```

自我进化的边界是：程序控制状态机和权限，Skill 控制方法论，Agent 负责方案和实现。默认不自动合并主分支。

## 目录结构

```text
.
├── src/                         # 宿主机服务核心代码
│   ├── channels/                # Web、Feishu、Assistant 等频道
│   ├── assistant/               # 主动助手、Inbox、自我进化、动作执行
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
├── groups/                      # 群组工作目录和群组级 CLAUDE.md
├── data/                        # 运行时数据、附件、会话、IPC、上传文件
├── store/                       # SQLite 数据库
├── docs/                        # 架构、启动流程、安全、调试文档
├── setup/                       # 安装和服务管理脚本
└── launchd/                     # macOS launchd 服务模板
```

## 数据模型概览

核心运行状态保存在 SQLite 中，主要表包括：

- `messages`、`chats`：频道消息和聊天元数据。
- `registered_groups`、`sessions`、`router_state`：群组注册、会话和路由游标。
- `scheduled_tasks`：定时任务。
- `agent_queries`、`agent_query_steps`、`agent_query_events`：Agent 执行 Trace。
- `workflows`、`delegations`、`workflow_interrupts`、`workflow_events`：流程运行态。
- `workbench_tasks`、`workbench_subtasks`、`workbench_action_items`、`workbench_artifacts`：工作台视图数据。
- `today_plans`、`today_plan_items`、`today_plan_mail_drafts`：今日计划。
- `agent_inbox_items`、`assistant_settings`、`assistant_action_logs`：个人助理。
- `assistant_evolution_items`、`assistant_evolution_events`、`assistant_evolution_artifacts`：自我进化。
- `memories`、`wiki_*`：记忆和知识库。

## 安装与运行

### 环境要求

- Node.js `>=20`
- npm
- Docker 或 Apple Container
- macOS 上可使用 launchd 常驻运行
- 可访问模型 API 的凭证

### 初始化

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少配置模型访问相关变量。项目支持通过凭证代理把真实密钥保留在宿主机：

```env
ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=https://api.anthropic.com
WEB_PORT=3000
WEB_TOKEN=...
```

如使用 Feishu、线上日志、图片生成、模型选择器、MySQL 代理等能力，再按 `.env.example` 补充对应变量。

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

### 生产构建

```bash
npm run build
npm run build:electron
npm run build:assistant
```

macOS 打包：

```bash
npm run package:mac
```

### 测试与检查

```bash
npm test
npm run typecheck
npm run format:check
```

## 安全模型

NanoClaw 的核心安全边界是容器隔离，而不是让 Agent 在宿主机上直接运行。

关键约束：

- 容器只看到明确挂载的目录。
- 项目根目录默认只读挂载。
- `.env` 不挂载给容器，真实密钥不进入容器环境。
- 模型 API 通过宿主机凭证代理转发。
- 每个群组有独立 `.claude` 会话目录，避免上下文串扰。
- IPC 操作按主群和非主群区分权限。
- 额外挂载由 `~/.config/nanoclaw/mount-allowlist.json` 控制，该文件位于项目外，容器不可修改。
- 默认阻止 `.ssh`、`.aws`、`.kube`、`.env`、私钥、credential 等敏感路径挂载。

主群通常代表用户本人，拥有管理权限；非主群被视为不可信输入，只能操作自己的上下文和有限资源。

## 扩展方式

### 新增频道

频道通过自注册机制接入：

1. 在 `src/channels/<name>.ts` 实现 `Channel` 接口。
2. 调用 `registerChannel(name, factory)`。
3. 在凭证缺失时让 factory 返回 `null`。
4. 在 `src/channels/index.ts` 添加 import，触发模块加载。

当前 `src/channels/index.ts` 已注册 Web、Assistant、Feishu，其他频道可以按同样模式接入。

### 新增工作流

工作流定义位于 `container/workflow-definitions/`，卡片位于 `container/cards/`。新增工作流通常需要：

- 定义状态机、角色、阶段类型和转换。
- 配置角色到不同频道群组 folder 的映射。
- 配置交互卡片和审批/输入表单。
- 按需要补充产物契约、评估器和工作台展示字段。

### 新增容器技能

容器技能位于 `container/skills/`。它们用于约束 Agent 的方法论，例如需求分析、问题修复、测试修复、运维部署、自我进化等。技能不是宿主机权限系统，权限仍由宿主机服务和容器挂载控制。

## 相关文档

- `docs/SPEC.md`：系统规格和频道架构。
- `docs/startup-flow.md`：启动流程、消息链路、IPC、数据库表。
- `docs/SECURITY.md`：安全模型、挂载策略、凭证隔离。
- `docs/DEBUG_CHECKLIST.md`：调试检查清单。
- `docs/docker-sandboxes.md`：容器沙箱说明。
- `local/docs/personal-assistant-runtime-refactor.md`：个人助手主动运行时设计。
- `local/docs/assistant-self-evolution-plan.md`：个人助手自我进化方案。

## 设计原则

- **用户主动和 Agent 主动分层**：工作台承载用户主动工作流，个人助理承载 Agent 主动发现和提醒。
- **宿主机可信，容器高权限但隔离**：控制面留在宿主机，执行面放进容器。
- **工作流可审计**：每次 Agent 执行都有 Query、Step、Event、产物和动作记录。
- **配置服务于流程，不制造配置泥潭**：复杂行为优先用代码、工作流定义和技能表达。
- **小步自动化**：自动排查、自动修复、自我进化都应有策略、审批和回滚边界。
