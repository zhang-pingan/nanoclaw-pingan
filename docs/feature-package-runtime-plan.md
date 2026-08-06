# Icarus Feature Package Runtime 方案

> **项目边界**：本文描述内部实验工具的仓库内模块化机制。`contract` 是当前内部接口，`activate` 是本地进程加载，`audit` 是安全/排障记录；它们不构成第三方插件兼容承诺、产品发布流程或合规审计。门禁只在防止半加载、越权、数据破坏或明显返工时阻断。详见 [`internal-experimental-scope.md`](internal-experimental-scope.md)。

## 背景

Icarus 作为底座版，已经承载 Web 工作台、个人助手、移动渠道、企微员工私聊、workflow runtime、container agent、知识库、记忆、Trace、配置管理等基础能力。后续会持续出现独立业务功能，例如专项 workflow 应用、行业 agent 包、内部工具包、数据分析包等。如果这些功能继续直接写进主服务、主前端和固定的 `container/` 资源目录，Icarus core 会逐步变成所有业务功能的集合体。

因此需要先实现一套通用 Feature Package Runtime。具体业务功能不直接耦合进 core，而是作为仓库内 feature package 存放在 `features/{featureId}` 下，并通过主配置启用。只有启用后，Icarus 才动态加载该功能包的前端资源、后端接口、workflow、agent、skill、MCP、DB migration、projection 和后台任务。

本文档只定义通用功能包机制，不讨论任何具体业务功能的方案或迁移细节。具体业务功能应在本机制实现后，基于这些扩展点独立设计。

## 目标

- 支持在 Icarus 主配置中声明启用的功能包。
- 未启用的功能包不注册 API、不出现在导航、不加载 workflow/skill/MCP/DB 资源、不启动后台任务。
- 功能包代码可以放在当前仓库下，但 core 不静态 import 任何具体 feature 的业务模块。
- Icarus core 只提供当前功能包实际需要的明确扩展点：API route registry、frontend nav registry、workflow asset source registry、container resource registry、MCP registry、DB migration registry、event/subscription registry、permission/audit registry；不承诺面向第三方的长期兼容性。
- 后续所有独立业务功能都按同一模型接入，避免继续膨胀 `src/channels/web.ts`、`electron/renderer/app.js`、`container/skills` 等核心目录。

## 非目标

- 不把 Icarus 改造成第三方插件市场。
- 不要求第一阶段支持远程下载安装 feature package。
- 不要求第一阶段做到构建产物完全不包含未启用 feature 的代码。
- 不让 feature package 绕过 Icarus 的权限、审计、workflow runtime、container isolation。
- 不让 feature package 维护第二套独立于 core runtime 的执行状态机。
- 不在本文中设计任何具体业务包。

## 核心结论

采用仓库内 feature package：

```text
features/
  {featureId}/
    feature.json
    host/
    renderer/
    container/
```

Icarus core 只扫描 manifest，并在主配置启用后动态加载 feature 的 host entry、renderer entry 和资源目录。

```text
Icarus Core
  - feature registry
  - api route registry
  - frontend shell/nav registry
  - workflow/resource source registry
  - db migration registry
  - permission/audit/runtime services
        |
        v
Enabled Feature Packages
  - feature-a
  - feature-b
  - feature-c
```

core 不应该出现类似下面的具体业务 import：

```ts
import { registerFeatureA } from '../features/feature-a/host/index.js';
```

而应该是：

```ts
const enabledFeatures = loadEnabledFeatures();
for (const feature of enabledFeatures) {
  await featureRuntime.activate(feature.id);
}
```

## 功能包目录约定

通用目录结构：

```text
features/{featureId}/
  feature.json
  host/
    index.ts
    api.ts
    projection.ts
    permissions.ts
    migrations/
      001_initial.sql
  renderer/
    index.ts
    routes.ts
    styles.css
    components/
  container/
    agents/
      {agentKey}/
        CLAUDE.md
    workflow-definitions/
    cards/
    skills/
    agents/
    mcp/
    artifact-contracts/
    workflow-evaluators/
    scripts/
    templates/
  README.md
```

目录语义：

| 目录 | 说明 |
| --- | --- |
| `host/` | 宿主机侧代码：API、projection、migrations、后台任务、事件订阅 |
| `renderer/` | 前端页面、组件、样式、路由入口 |
| `container/agents/` | 功能包声明的独占 Agent 模板，例如 `CLAUDE.md` |
| `container/workflow-definitions/` | 功能包贡献的 workflow definitions |
| `container/cards/` | 功能包贡献的交互卡片 |
| `container/skills/` | 容器 agent 可使用的 skills |
| `container/agents/` | 功能包专属 agent prompt/subagent 定义 |
| `container/mcp/` | 功能包专属 MCP 资源或 server 配置 |
| `container/artifact-contracts/` | 功能包贡献的产物契约 |
| `container/workflow-evaluators/` | 功能包贡献的评估器配置 |
| `container/scripts/` | 白名单脚本，必须经 host action/permission 约束 |
| `container/templates/` | 模板文件、提示词片段、领域静态资源 |

目录是约定，不是强制每个功能包都必须包含所有子目录。manifest 中声明了什么资源，core 才加载什么资源。

## Manifest

`features/{featureId}/feature.json` 示例：

```json
{
  "id": "example-feature",
  "name": "Example Feature",
  "version": "0.1.0",
  "description": "Example feature package",
  "hostEntry": "./host/index.js",
  "rendererEntry": "./renderer/index.js",
  "apiPrefix": "/api/features/example",
  "nav": [
    {
      "key": "example-feature",
      "label": "Example",
      "order": 300
    }
  ],
  "requiredAgents": [
    {
      "key": "main",
      "jid": "feature:example-feature:main",
      "name": "Example Feature",
      "folder": "example_feature_main",
      "requiresTrigger": false,
      "description": "Example feature dedicated Agent",
      "claudeMd": "./container/agents/main/CLAUDE.md"
    }
  ],
  "resources": {
    "workflowDefinitions": "./container/workflow-definitions",
    "cards": "./container/cards",
    "skills": "./container/skills",
    "agents": "./container/agents",
    "mcp": "./container/mcp",
    "artifactContracts": "./container/artifact-contracts",
    "workflowEvaluators": "./container/workflow-evaluators",
    "scripts": "./container/scripts",
    "templates": "./container/templates"
  },
  "permissions": {
    "hostActions": ["example.runScript"],
    "fileScopes": ["exampleWorkspace"],
    "mcpServers": ["example-server"]
  }
}
```

Manifest 是 core 和 feature package 之间的主要内部接口。core 通过 manifest 发现功能包，不通过业务 import 认识功能包。只有 persisted data 或独立演进边界确有需要时才增加版本，不为普通实现调整引入发布审批链。

Manifest 规则：

- `id` 全局唯一，建议使用 kebab-case。
- `apiPrefix` 必须属于 `/api/features/{featureId}` 或明确声明的唯一 prefix。
- `nav.key` 全局唯一。
- `requiredAgents[].key` 在当前 feature 内唯一。
- `requiredAgents[].jid` 建议使用 `feature:{featureId}:{agentKey}` 格式。
- `requiredAgents[].folder` 必须通过 core agent folder 校验。
- `requiredAgents[].claudeMd` 必须位于 feature 根目录内。
- 所有资源路径必须位于 feature 根目录内。
- 权限需求必须显式声明，不能在 activate 阶段临时扩权。

## 主配置

建议新增本地配置：

```text
local/features.json
```

内容：

```json
{
  "enabled": ["example-feature"]
}
```

也可以支持环境变量覆盖：

```bash
ICARUS_FEATURES=example-feature,another-feature
```

配置解析规则：

- 默认只启用 core 内置能力。
- `enabled` 只影响 feature package，不影响 core 必需模块。
- 未安装但被配置启用的 feature 应启动失败并给出明确错误。
- manifest 解析失败或 feature activate 失败，应阻止该 feature 注册，避免半启用状态。
- 同一个 feature 重复启用时应去重。

## Feature Agent Provisioning

Feature 可以在 manifest 中声明自己需要的独占 Agent：

```json
{
  "requiredAgents": [
    {
      "key": "main",
      "jid": "feature:example-feature:main",
      "name": "Example Feature",
      "folder": "example_feature_main",
      "requiresTrigger": false,
      "description": "Example feature dedicated Agent",
      "claudeMd": "./container/agents/main/CLAUDE.md"
    }
  ]
}
```

这些 agent 视为该 feature 的独占资源。feature 启用时，如果对应 agent 不存在，core 应自动创建：

- `registered_agents` DB 记录。
- `agents/{folder}/` 目录。
- `agents/{folder}/logs/` 目录。
- `agents/{folder}/CLAUDE.md`，内容来自 `requiredAgents[].claudeMd` 模板。
- `feature_agent_bindings` 记录，用于标记该 agent 归属哪个 feature。

建议新增 core 表：

```sql
CREATE TABLE IF NOT EXISTS feature_agent_bindings (
  feature_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  agent_jid TEXT NOT NULL,
  agent_folder TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (feature_id, agent_key),
  UNIQUE (agent_jid),
  UNIQUE (agent_folder)
);
```

Provisioning 规则：

- `requiredAgents[].jid`、`requiredAgents[].folder` 全局唯一。
- `folder` 必须通过 core agent folder 校验。
- `claudeMd` 模板路径必须位于当前 feature 根目录内。
- 如果同名 folder 或 jid 已经被其他 feature 使用，启动失败。
- 如果同名 folder 或 jid 已存在但没有 feature binding，也视为冲突并启动失败。
- 已存在且绑定到同一 feature/agentKey 时，启动不重复创建。
- `CLAUDE.md` 缺失时可以从模板补齐；已存在时默认不覆盖。
- feature 不能通过 migration 或 host code 直接插入 `registered_agents`，必须通过 core provisioning API。

Feature Agent provisioning 应在 feature migration 和 host activation 之前完成：

```text
load enabled features
  -> validate manifests
  -> provision requiredAgents
  -> run feature migrations
  -> register resources
  -> activate host entries
```

## Feature Runtime

新增 core 模块：

```text
src/features/
  manifest.ts
  registry.ts
  runtime.ts
  context.ts
  config.ts
```

核心接口：

```ts
export interface FeatureManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  hostEntry?: string;
  rendererEntry?: string;
  apiPrefix?: string;
  nav?: FeatureNavItem[];
  resources?: FeatureResources;
  permissions?: FeaturePermissions;
}

export interface FeatureModule {
  activate(context: FeatureContext): Promise<void> | void;
  deactivate?(context: FeatureContext): Promise<void> | void;
}

export interface FeatureContext {
  featureId: string;
  featureRoot: string;
  manifest: FeatureManifest;
  logger: unknown;
  api: ApiRouteRegistry;
  nav: NavigationRegistry;
  workflowAssets: WorkflowAssetRegistry;
  containerResources: ContainerResourceRegistry;
  mcp: McpRegistry;
  db: FeatureMigrationRegistry;
  events: EventRegistry;
  permissions: PermissionRegistry;
  audit: AuditService;
}
```

启动流程：

```text
load core config
  -> scan features/*/feature.json
  -> read local/features.json
  -> validate enabled feature ids
  -> validate manifest and permissions
  -> provision requiredAgents
  -> register declared resource sources
  -> build FeatureContext
  -> dynamic import enabled hostEntry
  -> activate(context)
  -> run feature migrations
  -> start host service normally
```

## Web 停用与删除

Feature 的启用/停用应提供 Web 管理入口，而不是只靠手改 `local/features.json`。

从 Web 端停用某个 feature 时，必须弹出确认提示，并提供两个动作：

```text
1. 仅停用
2. 停用并删除该 feature 的 agent 和历史信息
```

### 仅停用

仅停用时：

- 从 enabled features 中移除该 feature。
- 不注册该 feature 的 API、导航、workflow、cards、skills、agents、MCP、后台任务。
- 保留该 feature 已创建的 DB 数据。
- 保留该 feature 已创建的 agent。
- 保留 `agents/{folder}/` 文件系统目录。
- 历史 workflow 在 Execution Console 中只读可见。

### 停用并删除

用户选择“停用并删除”时，core 应先展示删除摘要：

- 将删除的 feature id。
- 将删除的 agent 列表。
- 将删除的 workflow/task/trace/message 数量。
- 将删除的 feature projection 表或记录。
- 将删除的 `agents/{folder}/` 路径。

用户二次确认后，core 执行删除：

- 停止该 feature 的后台任务和运行中轮询。
- 禁止新建该 feature 的 workflow。
- 删除该 feature 贡献的 workflow 实例、workbench task、action item、artifact index、timeline event。
- 删除该 feature 相关的 agent query trace、workflow event、interrupt、checkpoint、outbox 等历史执行记录。
- 删除该 feature 独占 Agent 的 messages、chats、sessions、registered_agents 记录。
- 删除 `feature_agent_bindings` 中该 feature 的记录。
- 删除该 feature 自己的 projection/config/cache 表数据。
- 删除 `feature_migrations` 中该 feature 的 migration 记录。
- 删除 `agents/{folder}/` 文件系统目录。
- 删除 `data/sessions/{folder}/.claude`、`data/ipc/{folder}` 等 Agent runtime 目录。
- 写入一条最小审计记录，说明用户执行过 feature 数据删除；这条删除审计不再依赖被删除的 feature 数据。

删除必须是 core 提供的受控动作，feature 不能自己递归删除 `agents/` 或直接清 core 表。

如果删除过程中部分文件系统清理失败，应返回明确错误并保留可重试状态；不能静默成功。

## 后端 API 扩展点

当前 `src/channels/web.ts` 的 API 分发是集中式 `if pathname ...`。feature package 接入后，不应继续往这个文件里追加具体业务路由。

建议新增 API route registry：

```ts
api.register({
  method: 'GET',
  path: '/api/features/example/items',
  handler: listItems
});

api.registerPrefix('/api/features/example', exampleRouter);
```

`WebChannel` 只负责：

```text
auth guard
  -> core route registry dispatch
  -> feature route registry dispatch
  -> static renderer fallback
```

路由约束：

- feature API 必须使用自己的 prefix。
- route registry 启动时检测 method + path 冲突。
- feature API 不能直接绕过 permission/audit。
- workflow command 仍调用 core 的 workflow service。
- feature 页面动作应翻译成 workflow command 或 feature projection query，不直接推进底层状态机。

## 前端扩展点

当前前端导航和页面切换写死在 `electron/renderer/index.html` 和 `electron/renderer/app.js`。feature package 接入后，前端 shell 应提供：

```ts
registerNavItem({
  key: 'example-feature',
  label: 'Example',
  order: 300,
  load: () => import('/features/example-feature/renderer/index.js')
});
```

页面加载流程：

```text
打开 Icarus
  -> 加载 core shell
  -> 请求 /api/features/enabled
  -> 渲染 core nav + enabled feature nav
  -> 用户点击 feature nav
  -> dynamic import feature renderer chunk
  -> feature renderer mount 到 shell 提供的 outlet
```

这样未启用 feature 时：

- 不显示该 feature 导航。
- 不加载该 feature renderer。
- 不执行该 feature 前端初始化。

第一阶段可以仍由同一个 Electron shell 服务静态资源，但 feature renderer 必须是独立入口，不继续并入主 `app.js`。

## Workflow 与资源合并

当前 workflow definitions、cards、artifact contracts、skills 等资源从固定目录读取：

```text
container/workflow-definitions
container/cards
container/skills
container/artifact-contracts
```

需要演进为多来源 registry：

```text
Core source:
  container/workflow-definitions
  container/cards
  container/skills

Feature source:
  features/{featureId}/container/workflow-definitions
  features/{featureId}/container/cards
  features/{featureId}/container/skills
```

合并规则：

- 每个 workflow type key 全局唯一。
- 每个 card group key 全局唯一，通常和 workflow type 一致。
- artifact contract key 全局唯一。
- skill key 可全局唯一，或通过 feature namespace 约束，例如 `{featureId}/skill-name`。
- MCP server key 全局唯一。
- script action key 全局唯一。
- 冲突时启动失败，不做静默覆盖。
- feature 禁用时，它贡献的 workflow 不可创建，但历史 workflow 需要只读降级处理。

历史 workflow 兼容：

- DB 中应记录 workflow type 与 feature id 的归属关系。
- 如果某个 workflow instance 属于已禁用 feature，Execution Console 应能显示只读状态。
- 禁用 feature 后不允许继续推进该 feature 的业务 workflow，除非重新启用。
- 仅停用 feature 不自动删除历史数据和产物；用户在 Web 端选择“停用并删除”后才执行清理。

## Container 资源

功能包可贡献容器内资源：

```text
skills
agents
mcp
scripts
templates
```

加载原则：

- 只把 enabled feature 的资源同步或挂载进容器。
- 第一阶段 feature-scoped 的 skills、agents、MCP、scripts、templates 默认只对该 feature 通过 `feature_agent_bindings` 绑定的独占 Agent 可见；未绑定 agent 只能看到 core 资源，避免跨功能包资源泄露。后续如需跨 agent 共享，必须在 manifest 中增加显式可见范围。
- 资源进入容器前经过 manifest 和 permission 校验。
- scripts 不直接开放给 agent 任意执行，必须通过 host action 或白名单策略。
- MCP server 必须声明权限、可见目录、凭证来源和审计策略。
- feature 资源应带来源信息，便于排查和审计。

示例：

```text
features/{featureId}/container/skills/{skillName}
  -> enabled 后同步到 data/sessions/{agent}/.claude/skills/{featureId}-{skillName}

features/{featureId}/container/agents/{agentName}.md
  -> enabled 后挂载或复制到容器 agent 可发现目录

features/{featureId}/container/mcp/{serverName}.json
  -> enabled 后注册 MCP server，凭证仍由 host 代理或本地配置控制
```

## DB 与 Projection

Feature package 可以有自己的 projection 表，但不能拥有独立执行状态机。

Feature DB 适合保存：

- 领域 projection。
- 页面查询索引。
- 可重建缓存。
- feature 自有配置。
- feature 后台任务游标。

Feature DB 不应该保存：

- 第二套 workflow 当前状态。
- 第二套 delegation 状态。
- 与 core trace/audit 脱节的审批事实。
- 绕过 core permission 的授权状态。

建议新增 migration registry：

```ts
db.registerMigrations({
  featureId,
  dir: path.join(featureRoot, 'host/migrations')
});
```

所有 migration 记录写入统一表：

```text
feature_migrations
  feature_id
  version
  checksum
  applied_at
```

Feature migration 只能创建或修改当前 feature 拥有的表。表名必须使用 `feature_<normalizedFeatureId>_` 前缀，例如 `feature_example_feature_projection`；禁止 migration 触碰 core 表、其他 feature 表或无归属前缀的表。删除摘要和“停用并删除”也按同一前缀识别 feature projection/config/cache 表。

Projection 构建方式：

```text
workflow/runtime event
  -> feature projection updater
  -> feature projection tables
  -> feature page query API
```

Projection 应可重建，workflow/runtime/file workspace 才是执行事实源。

## 权限与审计

Feature package 不能绕过 Icarus 的安全边界。

必须保持：

- host service 是可信编排层。
- container agent 是隔离执行层。
- real credentials 不进入容器。
- file/mount 权限仍由 core 统一控制。
- risky host action 必须有权限声明、审计和幂等约束。

Feature manifest 中声明权限需求，core 启动时校验：

```json
{
  "permissions": {
    "hostActions": ["example.runScript"],
    "fileScopes": ["exampleWorkspace"],
    "mcpServers": ["example-server"]
  }
}
```

审计事件至少包含：

- feature id
- user/channel/agent
- workflow id
- action name
- request payload hash
- result status
- created_at

## 构建策略

需要区分两个阶段。

### 第一阶段：运行时不加载

Feature 代码在仓库中，开发环境可见，但未启用时：

- host entry 不 import。
- renderer entry 不 import。
- API 不注册。
- workflow/skills/MCP 不加载。
- DB migration 不执行。
- background job 不启动。

这能先解决主服务耦合和运行时膨胀问题。

### 可选阶段：构建产物不包含

只有在本地包体或加载成本已经成为实际问题时，才需要增加构建 profile：

```bash
npm run build -- --features=core
npm run build -- --features=core,example-feature
```

产物形态：

```text
Icarus Base
  - 不包含未选择 feature 的 renderer/host bundle

Icarus With Features
  - 包含构建 profile 指定的 feature bundles
```

这用于解决本地构建不携带未选择功能代码的问题，不是产品交付的必需阶段。

## 实施顺序

该方案应先于任何具体业务功能包实现。具体业务功能后续直接基于 Feature Runtime 接入，不再单独考虑迁移到 core 的路径。

### 阶段 1：Feature Runtime 骨架

- 新增 `src/features`。
- 新增 `local/features.json` 解析。
- 支持扫描 `features/*/feature.json`。
- 定义 `FeatureManifest`、`FeatureContext`、`FeatureModule`。
- 支持 `requiredAgents` manifest 字段。
- 新增 `feature_agent_bindings` core 表。
- 启用 feature 时自动 provision 独占 Agent、`agents/{folder}/logs` 和 `agents/{folder}/CLAUDE.md`。
- 支持动态 import enabled feature 的 `hostEntry`。
- 增加 `/api/features/enabled`。
- 增加 manifest 校验和启动错误提示。

### 阶段 2：后端 API Registry

- 从 `WebChannel.handleHttp` 抽出 route registry。
- 保留 core API 注册。
- 支持 feature API prefix 注册。
- 增加 method/path 冲突检测。
- 统一 auth、错误处理、JSON response、审计入口。
- 为 route registry 增加单元测试。

### 阶段 3：前端 Shell 与动态页面

- 把当前 renderer 拆成 core shell + core apps。
- 导航从静态 HTML 改成 registry 渲染。
- 支持 `/api/features/enabled` 返回 feature nav/renderer metadata。
- 增加 Web 端 feature 管理页面或设置入口。
- Web 端停用 feature 时弹出确认，提供“仅停用”和“停用并删除”两个选项。
- 选择“停用并删除”时展示将删除的 agent、历史记录和文件路径摘要，并要求二次确认。
- 支持点击后 dynamic import feature renderer。
- feature renderer 作为独立 chunk。
- 未启用 feature 不进入主 `app.js`。

### 阶段 4：资源 Registry

- workflow definitions 支持多来源。
- cards 支持多来源。
- artifact contracts/evaluators 支持多来源。
- skills/agents/MCP/scripts/templates 支持 enabled feature 来源。
- 增加 key 冲突检测。
- workflow create options 根据 enabled feature 过滤。
- 历史 disabled-feature workflow 支持只读降级。

### 阶段 5：DB Migration 与 Projection

- 增加 feature migration registry。
- 统一 migration 记录表。
- 支持 feature projection event subscription。
- 明确 projection 可重建，不作为执行事实源。
- 增加启用、禁用、重复启动的 migration 测试。
- 增加 feature 数据删除服务，负责清理 feature projection/config/cache、migration 记录、feature-owned workflow 历史和 agent 相关 DB 记录。

### 阶段 6：Feature 停用与删除

- 增加 feature disable API。
- 增加 feature delete-data API。
- 删除动作只能由 core 执行，feature 不能自己删除 core 表或 `agents/` 文件系统。
- 删除独占 Agent 时同步删除 `registered_agents`、`chats`、`messages`、`sessions`、Agent runtime 目录和 `agents/{folder}`。
- 删除失败时返回可重试状态，不静默成功。
- 删除完成后保留最小审计记录。

### 阶段 7：权限与审计

- 增加 feature permission registry。
- 校验 manifest 中声明的 host action、file scope、MCP server。
- feature API、host action、MCP 调用写入统一审计。
- 未声明权限的资源访问启动失败或调用失败。

### 阶段 8：构建 Profile

- 调整 esbuild 构建脚本。
- 支持 base/with-feature 构建。
- 未选 feature 不打包其 renderer/host bundle。
- checkout 内的 Electron 构建按 profile 生成对应静态资源，不引入独立应用打包拓扑。

## 验收标准

未启用某 feature 时：

- 一级导航没有该 feature。
- 该 feature API prefix 返回 404。
- workflow create options 不出现该 feature 贡献的 workflow。
- container session 不同步该 feature 的 skills/agents/MCP。
- 该 feature DB migration 不执行。
- 该 feature renderer chunk 不被浏览器加载。
- 该 feature 后台任务不启动。

启用某 feature 时：

- 一级导航出现该 feature。
- 该 feature API prefix 可用。
- 该 feature manifest 声明的独占 Agent 被写入 `registered_agents`。
- `agents/{folder}/CLAUDE.md` 从 feature 模板创建。
- `feature_agent_bindings` 记录 feature 与 agent 绑定关系。
- 该 feature workflow definitions/cards 被加载。
- 该 feature skills/agents/MCP/scripts 按权限进入容器资源。
- 该 feature DB migration 执行一次并记录。
- 该 feature 页面动作通过 core command/runtime 推进。
- Execution Console 可观察该 feature 产生的 workflow。

禁用某 feature 后：

- 不允许新建该 feature 贡献的 workflow。
- 该 feature 页面和 API 不可用。
- 如果用户选择“仅停用”，历史 workflow 在 Execution Console 中只读可见，feature projection、独占 Agent 和 `agents/{folder}` 保留。
- 如果用户选择“停用并删除”，Web 端先展示删除摘要并要求二次确认。
- 确认删除后，该 feature 独占 Agent 从 `registered_agents` 和 `feature_agent_bindings` 删除。
- 确认删除后，该 feature 独占 Agent 的 `agents/{folder}`、`data/sessions/{folder}`、`data/ipc/{folder}` 被删除。
- 确认删除后，该 feature 相关 workflow、workbench、trace、messages、projection、migration 记录被删除。
- 删除动作留下最小审计记录。

## 风险与约束

- 如果只是把业务代码放进 `features/{featureId}`，但主服务静态 import 它，仍然是耦合。
- 如果只是隐藏导航，前端 bundle 仍然膨胀。
- 如果 feature API 直接写进 `src/channels/web.ts`，WebChannel 会继续变成所有业务 API 的集合。
- 如果 feature 保存第二套执行状态，会和 core workflow runtime 出现双状态。
- 如果 feature scripts 不走 host action/permission，会破坏安全边界。
- 如果 workflow/card/skill/MCP/action key 不做冲突检测，后续功能包之间会互相覆盖。
- 如果停用 feature 时直接删除数据而不经 Web 二次确认，用户可能误删历史产物和 agent 记忆。
- 如果删除数据由 feature 自己实现，容易绕过 core 权限、审计和路径安全检查。

## 推荐决策

先实现通用 Feature Package Runtime，再在它之上实现具体业务功能包。

短期目标是运行时解耦：功能包在 `features/{featureId}` 下，只有配置启用后才动态注册。

中期目标是构建解耦：支持 base/with-feature 构建 profile，让底座版安装包也不包含未选功能代码。

长期目标是统一功能扩展模型：所有独立业务能力都以 feature package 接入 Icarus，而不是继续修改 core 主服务和主前端。
