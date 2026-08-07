# Workflow Pack 架构优化方案

> **状态**：Proposed
> **日期**：2026-08-06
> **范围**：Task Workspace、Workflow Runtime Registry、Core System Recipe、Feature Package Runtime、Personal Workflow、Temporary Workflow
> **项目边界**：Icarus 是本地单用户内部实验工具。当前没有必须兼容的历史业务 Workflow 数据，本方案遵循 [`internal-experimental-scope.md`](internal-experimental-scope.md) 的 latest-only 策略。

## 1. 决策摘要

本方案确认以下架构决策：

1. Workflow Runtime 可以在没有任何用户 Workflow 模板时独立启动和正常运行。
2. Core 不再提供用户可选择的业务 Workflow 模板。
3. Core 只保留 Runtime、Catalog、Task Workspace、发布能力，以及 Temporary/Personal Workflow 所需的隐藏 System Recipe。
4. 所有开发者维护、可选安装的 Workflow 模板由 Workflow Pack 发布。
5. 用户从 Temporary Workflow 沉淀的模板由 Personal Workflow 发布。
6. Temporary Workflow 是 TaskSession 内的未发布计划，不属于 Core、Pack 或 Personal Catalog 资源。
7. Core、Pack、Personal Workflow 使用同一个 Catalog、Workspace Gateway 和 Workflow Runtime 执行路径。
8. 原 Feature Package 收缩并重命名为 Workflow Pack，不再提供独立 renderer、导航、业务页面或任意 Host 模块加载能力。
9. Pack 配置只是期望状态；Workflow Runtime 中的 active Pack Release 是 Recipe Catalog 的唯一可执行权威。
10. Disable、Uninstall 和 Purge Data 是三个不同动作，不再用一个“停用并删除”动作混合处理。

最终产品路径固定为：

```text
Workflow Pack templates ----\
                              \
Personal Workflow templates ---> Unified Recipe Catalog
                                  -> Task Workspace
                                  -> Runtime Workspace Gateway
                                  -> Workflow Runtime

Temporary Workflow
  -> Task Workspace Draft
  -> Human Confirmation
  -> hidden Core System Recipe
  -> Workflow Runtime
```

## 2. 背景与当前代码结论

Task Workspace 合入后，Core、Feature、Personal Recipe 已通过统一 Catalog 返回，并最终进入同一个 `createWorkflowT0`。当前 `recipe_kind` 由 Registry resource ownership 推导，不代表不同的执行引擎。

当前代码同时保留了两套互不连通的 Feature 控制面。

第一套位于 `src/features/`：

- 扫描 `features/{featureId}/feature.json`；
- 读取 `local/features.json` 或 `ICARUS_FEATURES`；
- 动态加载 `hostEntry`；
- 注册 Feature API、nav 和 renderer；
- Provision 独立 Agent；
- 注册 skill、agent、MCP、script 和 template 目录；
- 运行 Feature migration；
- 在 Web 设置页执行进程内 enable/disable/reload。

第二套位于 `src/workflow-runtime/`：

- 解析 `icarus.feature-manifest/2`；
- 发布 Workflow Registry resources 和 closure snapshot；
- 维护 Feature Release；
- 维护 `workflow_feature_active_releases`；
- 通过 active pointer 控制 Feature Recipe 是否进入 Workspace Catalog；
- 维护 draining、retention 和运行中资源引用。

两套控制面没有共同的 activation transaction。`activateConfiguredFeatures()` 不持有 Workflow Runtime Store，也不发布或激活 Feature Release；Workspace Catalog 则不读取 `local/features.json`。因此当前可能出现：

```text
local/features.json = enabled
  but
Workflow Feature Release = inactive
  -> 设置页显示已启用，Task Workspace 没有 Recipe
```

也可能出现反向状态：

```text
Workflow Feature Release = active
  but
local/features.json = disabled
  -> Catalog 仍可能持有 Pack Recipe，但容器资源已被卸载
```

Personal Workflow 已经扩展 Registry ownership，并拥有独立 Release、active pointer 和发布流程。这解决了 principal ownership，但 Core、Feature、Personal 仍分别使用 bootstrap、Feature Publisher/Activation 和 Personal Publisher/Activation 三条作者路径。

## 3. 目标

- 让 Task Workspace 成为所有用户 Workflow 的唯一交互和启动界面。
- 让 Runtime 执行逻辑完全忽略模板来自 Core、Pack 还是 Personal。
- 保留 Workflow Pack 的仓库隔离、整体启停、快速移除和资源归属能力。
- 删除不再需要的 Feature App Plugin 扩展面。
- 用一个 Pack activation authority 同时控制 Catalog 和执行资源可用性。
- 保证 Disable 后禁止新 Run，但不破坏已经创建的 Run。
- 让 Pack、Personal 和隐藏 Core System Recipe 复用共同的 Registry publication primitives。
- 明确 Template、Release、Execution 和 TaskSession 的数据所有权，避免删除时跨领域误删。

## 4. 非目标

- 不建设第三方插件市场或远程下载安装协议。
- 不支持 Feature 独立业务页面、Artifact renderer 或领域命令 UI。
- 不允许 Pack 动态加载任意 Host 代码。
- 不让 Pack 自建 Workflow 状态机、任务数据库或执行队列。
- 不要求第一版支持无重启的 Pack 热加载或热卸载。
- 不让 Pack 删除共享 TaskSession、Runtime audit 或其他 owner 的资源。
- 不把 Temporary Workflow 发布到共享 Catalog。
- 不把 Personal Workflow 自动写入 Git。

## 5. 术语与所有权边界

### 5.1 Runtime Core

Runtime Core 包含：

- Registry 和 Recipe Catalog；
- Compiler；
- Workflow、Run、Scope、Node 和 Wait 状态机；
- Scheduler、Outbox 和 Execution Adapter；
- Permission、effect、claim、audit 和 retention；
- Runtime Workspace Gateway；
- Task Workspace 所依赖的通用 Runtime query/command。

Runtime Core 不依赖任何用户可选 Workflow 模板。空 Catalog 是合法状态。

### 5.2 Core System Recipe

Core System Recipe 是实现平台协议的隐藏 Registry resource，不是用户模板。例如：

- Temporary Workflow 的受控 outer Recipe；
- Personal Workflow 启动时复用的受控 outer Recipe；
- 未来确实需要 Runtime Graph 表达的内部恢复协议。

System Recipe 必须满足：

- `catalog_visibility = system_only`；
- 不出现在 Workspace Recipe selector；
- 只能由 Host 内部明确协议解析；
- 不承载 PM、Research、Ops 等业务语义；
- 删除后只会关闭相应平台能力，不会导致 Runtime 无法启动。

当前 `ad_hoc_personal_task` 应从普通 Core Recipe 调整为隐藏 System Recipe。Task Workspace 的 `Temporary Workflow` 是 UI launch mode，不是对该 Recipe 的直接 Catalog 展示。

### 5.3 Workflow Pack

Workflow Pack 是开发者维护、Git 管理、可整体启停的声明式 Workflow 分发单元。它可以包含多个 Recipe 及其共享资源。

Workflow Pack 负责：

- Recipe、Definition、Policy 和 Schema；
- Capability、Executor binding、Prompt 和 Tool binding；
- Wait、Card 和 Artifact contract；
- Agent prompt、Skill、MCP、Script 和 Template 资源；
- Pack namespace、依赖、permission 和 effect ceiling；
- Pack Release 与 Catalog activation。

Workflow Pack 不负责：

- 页面和导航；
- 自有任务状态机；
- 任意 Host API；
- 任意数据库 migration；
- 后台常驻服务；
- 直接推进 Workflow 状态。

### 5.4 Personal Workflow

Personal Workflow 是 principal-owned 的本地 Published Workflow：

- 来源于成功的 Temporary Workflow Run；
- 经 sanitize、compile、review、publish 和 activate 后进入 Catalog；
- 仅对 owner principal 可见；
- 默认只存在本地 Store，不进入 Git；
- 复用隐藏 Core System Recipe 的安全 envelope。

### 5.5 Temporary Workflow

Temporary Workflow 是 Task Workspace 内的未发布计划：

- Draft 和 revision 属于 Task Workspace；
- 用户确认后才创建 Runtime Workflow；
- Runtime 使用隐藏 Core System Recipe 承载 Dynamic Child；
- 成功后可以显式沉淀为 Personal Workflow；
- 不产生 Workflow Pack，也不修改原 Run。

### 5.6 分类矩阵

| 类型                 | Owner       | 用户可选                  | 发布位置               | 可整体禁用    | 执行路径        |
| -------------------- | ----------- | ------------------------- | ---------------------- | ------------- | --------------- |
| Core System Recipe   | Core        | 否                        | Core bootstrap release | 否            | Unified Runtime |
| Workflow Pack Recipe | Pack        | 是                        | Pack Release           | 是            | Unified Runtime |
| Personal Workflow    | Principal   | 是，仅 owner              | Personal Release       | 是，仅 owner  | Unified Runtime |
| Temporary Workflow   | TaskSession | `Temporary Workflow` mode | 不发布                 | 按 Draft 丢弃 | Unified Runtime |

## 6. 目标架构

```text
Icarus Core
  |
  +-- Task Workspace
  |     - Session / Conversation
  |     - Temporary Draft
  |     - Recipe Selector
  |     - Generic Timeline / DAG / Artifact / Human Input
  |
  +-- Workflow Runtime
  |     - Registry Publisher primitives
  |     - Catalog
  |     - Compiler / Scheduler / Execution
  |     - Active Release and Retention
  |
  +-- Workflow Pack Reconciler
        - scan manifests
        - validate desired enabled state
        - publish exact resource closure
        - activate/deactivate Pack Release

workflow-packs/{packId}
  - pack manifest
  - workflow source
  - declarative execution resources

store/workflow-runtime.db
  - Core System resources
  - Pack resources/releases/active pointers
  - Personal resources/releases/active pointers
  - Runtime execution state

store/task-workspace.db
  - TaskSession / messages / drafts / links
  - Personal authoring draft state
```

## 7. Workflow Pack 目录与 Manifest

原 `features/` 建议 latest-only 重命名为 `workflow-packs/`：

```text
workflow-packs/{packId}/
  pack.json
  workflow-src/
    recipes/
    definitions/
    policies/
    schemas/
    capabilities/
    prompts/
    tool-bindings/
    waits/
    cards/
    artifact-contracts/
  resources/
    agents/
    skills/
    mcp/
    scripts/
    templates/
  README.md
```

建议 Manifest：

```json
{
  "format": "icarus.workflow-pack/1",
  "pack_ref": {
    "id": "pm-pipeline",
    "version": "1.0.0"
  },
  "display_name": "PM Pipeline",
  "description": "Product delivery workflows",
  "namespace": "pm_pipeline",
  "owner_principal_ref": "human:local-owner",
  "dependencies": [],
  "workflow_resources": [
    {
      "kind": "recipe",
      "ref": {
        "id": "pm_pipeline.new_feature",
        "version": "1.0.0"
      },
      "source_path": "workflow-src/recipes/new-feature.json",
      "expected_source_hash": "sha256:..."
    }
  ],
  "execution_resources": {
    "agents": "resources/agents",
    "skills": "resources/skills",
    "mcp": "resources/mcp",
    "scripts": "resources/scripts",
    "templates": "resources/templates"
  },
  "permissions": {
    "host_actions": [],
    "file_scopes": [],
    "mcp_servers": [],
    "effect_ceiling": "workspace_write"
  }
}
```

Manifest 不再包含：

- `hostEntry`；
- `rendererEntry`；
- `apiPrefix`；
- `nav`；
- `requiredAgents`；
- migration、projection 或 background service entry。

Agent 应作为 Workflow execution resource 被具体 Capability/Executor 引用，而不是因为 Pack enabled 就注册一个全局聊天 Agent。

## 8. Catalog 与可见性

### 8.1 Catalog 项目

`WorkspaceRecipeCatalogItem` 建议将 `recipe_kind` 重命名为更准确的 `distribution_kind`：

```ts
type WorkflowDistributionKind = 'pack' | 'personal';

interface WorkspaceRecipeCatalogItem {
  distribution_kind: WorkflowDistributionKind;
  distribution_ref: VersionedRef;
  recipe_ref: VersionedRef;
  recipe_hash: Sha256Hash;
  display_name: string;
  description: string | null;
  launch_policy: 'auto' | 'confirm' | 'manual_only';
  input_summary: JsonObject;
  selection_token: string;
}
```

Core System Recipe 不进入这个 union，因为它不应出现在用户 Catalog。

产品文案使用：

- Pack：`Installed` / `已安装`；
- Personal：`Mine` / `我的`；
- Temporary：独立固定选项。

不向用户显示 `Core / Feature / Personal` 这组实现术语。

### 8.2 Selection Token

Selection token 继续绑定：

- authenticated principal；
- exact Recipe ref/hash；
- exact entrypoint；
- launch policy；
- exact active Release identity；
- active pointer row version；
- Registry snapshot/hash；
- expiry。

Pack disable 或 Release 切换后，旧 token 必须返回 `selection_stale`，不能自动切换版本或回退到 Temporary Workflow。

## 9. 单一启用权威

### 9.1 Desired State

建议配置改为：

```text
local/workflow-packs.json
```

```json
{
  "enabled": ["pm-pipeline"]
}
```

该文件只表示期望状态，不直接代表 Pack 已可执行。

### 9.2 Runtime Authority

Pack 是否能进入 Catalog，只由 Workflow Runtime active Pack Release pointer 决定。

```text
desired enabled config
  -> scan pack source
  -> validate manifest and paths
  -> compile and publish exact closure
  -> activate Pack Release
  -> active pointer becomes authoritative
  -> Recipe appears in Catalog
```

设置页应显示 reconciliation 状态：

- `enabled`：desired enabled 且 active Release 一致；
- `pending_restart`：配置已改变，等待 Host 重启；
- `invalid`：Manifest、compile 或 permission validation 失败；
- `draining`：已禁止新启动，仍有 active execution refs；
- `disabled`：无 active Catalog pointer；
- `source_missing`：配置启用但源码包不存在。

### 9.3 Startup 顺序

目标启动顺序：

```text
initialize Core database
  -> open Workflow Runtime Store
  -> publish/verify hidden Core System Recipe
  -> read desired Workflow Pack config
  -> reconcile Pack Releases and active pointers
  -> start Runtime service and Execution Worker
  -> start Task Workspace
  -> expose Catalog and settings API
```

这取代当前“先 activate source Feature、后打开 Workflow Runtime Store”的顺序。

### 9.4 第一版不热卸载

原始需求是“项目启动时插拔”，不要求进程内热卸载。第一版 Pack 设置变更应返回 `restart_required=true`，由下次启动统一 reconcile。

这样可以删除：

- `activate -> deactivate -> reactivate` 回滚链；
- Feature host cleanup；
- renderer dynamic unmount；
- 运行中 container resource 被即时移除的竞态；
- 多个 Store 无法原子 reload 的伪事务。

## 10. Disable、Uninstall 与 Purge

### 10.1 Disable

Disable 的语义只有：

- 立即从新 Catalog selection 中移除 Pack Recipe；
- 已签发 token 在 active check 时失效；
- 不允许新 Workflow、Rework 或新 child scope 引用该 Pack；
- 已创建 Run 继续使用 pinned Registry snapshot 和 execution bundle；
- TaskSession、ExecutionLink、Timeline、Artifact metadata 和 audit 保持可读。

如果当前实现无法让 active Run 脱离 Pack 源码目录执行，则 Disable 必须进入 `draining`，直到 active refs 归零，不能直接卸载目录。

### 10.2 Uninstall

Uninstall 负责移除 Pack 源码或允许用户删除 `workflow-packs/{packId}`：

- Pack 必须已 disabled；
- 不得存在仍读取源码目录的 active execution；
- pinned Registry snapshot 和历史 metadata 可以保留；
- settings 中显示 source removed；
- 不删除 TaskSession 和 Workflow history。

### 10.3 Purge Data

Purge 是独立、显式、可预览的破坏性动作，只处理 Pack-owned 数据：

- managed Pack data root；
- Pack 专有 cache；
- 可重建 projection；
- 未被 Run、Personal Release 或 investigation pin 的 Registry resources；
- Pack execution resource staging copy。

Purge 不得自动删除：

- TaskSession 和 Conversation；
- 通用 Runtime event/audit；
- 共享 Artifact；
- 其他 Pack 或 Personal Workflow 引用的 resource；
- external workspace；
- 用户显式导出的文件。

旧 `deleteFeatureData()` 不应直接扩展成跨三个数据库的递归删除器。它应被拆成 owner-aware query、disable/uninstall/purge 三个服务边界。

## 11. 发布模型统一

### 11.1 共享 Publisher Primitives

Core System、Pack 和 Personal 发布应复用一个内部 `WorkflowBundlePublisher`，统一处理：

- closed-schema validation；
- exact ref/hash collision；
- dependency closure；
- Registry resource persistence；
- compiler validation；
- snapshot publication；
- retention handle；
- idempotent publication receipt。

Owner-specific 逻辑只处理：

| Owner         | 特有逻辑                                                   |
| ------------- | ---------------------------------------------------------- |
| Core System   | system-only visibility、Host bootstrap authority           |
| Workflow Pack | Pack manifest、Pack active pointer、source reconciliation  |
| Personal      | principal ownership、personal workflow id、reviewed source |

不要求三类 Release 强行使用同一张 polymorphic 表。可以继续使用 typed nullable owner columns 和 owner-specific active pointer 表，但 publication implementation、receipt 和 Catalog resolution 必须共享。

### 11.2 Temporary 不进入 Publisher

Temporary Draft 只在确认时产生 Runtime creation input：

```text
Workspace Draft
  -> compile preview
  -> user confirms exact revision/hash
  -> Host resolves hidden Core System Recipe
  -> T0 creates Workflow
```

只有显式 `Save as Personal Workflow` 才进入 Bundle Publisher。

## 12. 数据模型调整

由于当前没有需要保留的历史业务 Workflow 数据，本方案使用 latest-only 替换，不保留旧 Feature/Pack 双模型兼容层。

建议调整：

1. `owner_feature_id` 重命名为 `owner_pack_id`。
2. `workflow_feature_releases` 重命名为 `workflow_pack_releases`。
3. `workflow_feature_release_resources` 重命名为 `workflow_pack_release_resources`。
4. `workflow_feature_active_releases` 重命名为 `workflow_pack_active_releases`。
5. Manifest format 从 `icarus.feature-manifest/2` 替换为 `icarus.workflow-pack/1`。
6. 删除 `extension_surfaces.api_entry/nav_entry/renderer_entry`。
7. Registry resource ownership 保持 exactly-one typed columns：Core、Pack、Principal。
8. Recipe publication metadata 增加 `catalog_visibility = system_only | selectable`。
9. `recipe_kind` 替换为 `distribution_kind = pack | personal`。
10. 删除 T0 `feature_ui` source；保留 `task_workspace`、`schedule`、`api`、`workflow_transition` 和确有调用者的 system source。
11. 删除不再需要的 `feature_service` launch actor；Pack Recipe 从 Task Workspace 启动时 actor 仍是 `human`。
12. 修正所有 Runtime TaskRecord/source union，使 `task_workspace` 与当前 T0/DDL 一致。

开发 Store 使用精确、显式 reset/reinitialize 切换到 current schema，不新增旧 Feature schema migration 或双读逻辑。

## 13. Host Capability 边界

移除 `hostEntry` 不代表 Workflow Pack 不能调用宿主能力。目标方式是：

```text
Pack Workflow Capability
  -> exact capability ref
  -> Core-owned Host Capability Registry
  -> typed args + permission + effect policy
  -> Host adapter
  -> receipt
```

Pack 只能引用已注册的 Host Capability，不能动态 import Host implementation。

新增 Host Capability 必须回答：

- 是否可被多个 Pack 复用；
- typed input/output 是什么；
- 需要哪些 file scope、credential 和 external effect；
- 如何产生幂等 receipt；
- 如何在 container/Host 边界验证调用者；
- active Run 如何 pin adapter compatibility。

如果某项能力只为一个 Pack 服务，adapter implementation 仍放在明确的 Host adapter 模块中，由 Core registry 静态注册；这表示它是受信任宿主能力，不伪装成可随意加载的 Pack 代码。

## 14. 需要删除或替换的现有扩展面

### 14.1 后端

删除或替换：

- `src/features/manifest.ts` 旧 Feature Manifest；
- `src/features/runtime.ts` host/nav/renderer activation；
- `src/features/context.ts` arbitrary Feature API/event/db context；
- `src/features/registry.ts` API route 和 Navigation registry；
- `src/features/migrations.ts` Feature 隐式 migration；
- `src/features/provisioning.ts` enabled 即 provision 全局 Agent；
- `/api/features/enabled`；
- `/api/features/{id}/*` arbitrary Feature route dispatch；
- `/features/{id}/renderer/*` static serving；
- `feature_ui` launch source；
- Feature renderer metadata 和 nav count management fields。

保留并重构：

- Feature data root 中仍有价值的 Pack-managed data root 能力；
- container skill/agent/MCP/script/template 收集逻辑，但其输入改为 active Pack execution bundle；
- permission、path containment 和 resource conflict validation；
- Registry Feature Release 中可复用的 closure、retention 和 active-run safety；
- owner-aware audit。

### 14.2 Renderer

删除：

- `feature-runtime-screen`；
- `feature-runtime-outlet`；
- Feature nav dynamic injection；
- renderer module import/mount/unmount cache；
- Feature page loading status；
- Feature renderer static URL；
- Feature API/nav/renderer 详情展示。

设置页改为 Workflow Pack 管理，只展示：

- Pack identity/version；
- desired state；
- active Release；
- Recipe 列表；
- permissions/effect ceiling；
- active Run/pin 摘要；
- disable、uninstall、purge 可用性。

## 15. 文档权威调整

本方案实现后：

- 本文成为 Workflow Pack 当前架构说明；
- `feature-package-runtime-plan.md` 移入 archive，不能继续指导实现；
- `local/docs/pm-pipeline-full-migration-plan.md` 删除一级页面、renderer、Feature API/projection migration 设计，改为 Task Workspace Recipe + generic artifact/timeline；
- `local/docs/conversational-task-workspace-framework.md` 删除“未来 Feature 专用页面”开放项；
- `workflow-storage-feature-data-plan.md` 将 Feature Data Root 术语替换为 Pack Data Root；
- README、SPEC 和 TECHNOLOGY 统一使用 Workflow Pack、Personal Workflow、Temporary Workflow 和 Core System Recipe。

历史设计由 Git 保留，不在 active source tree 维护两个相反方向。

## 16. 实施阶段

### Phase 0：冻结术语和删除边界

- 确认 Core System Recipe、Workflow Pack、Personal、Temporary 四类对象。
- 确认 Core 无用户可选模板。
- 确认第一版 Pack 只在启动时 reconcile，不热加载。
- 确认当前开发 Store 可 latest-only reset。
- 更新当前权威文档，归档冲突设计。

退出条件：新代码和文档不再把 Feature 当作独立 App/UI。

### Phase 1：Catalog 与 Core System Recipe

- 增加 system-only Recipe visibility。
- 从 Workspace Catalog 隐藏 `ad_hoc_personal_task`。
- Temporary mode 由 Host 内部解析 exact System Recipe。
- 将 `recipe_kind` 调整为 `distribution_kind`。
- 删除 `feature_ui` source 和遗留 source union 不一致。
- 用正式 Core resource bundle 替换运行时对 compiler Golden fixture 的读取。

退出条件：Selector 只显示 Temporary、Pack 和 Personal；Runtime 可在无 Pack/Personal 时正常运行。

### Phase 2：统一 Bundle Publisher

- 提取共享 Registry publication、closure、snapshot、compile 和 receipt primitives。
- Core System、Pack、Personal 使用共享实现。
- 保留必要的 typed owner-specific activation policy。
- 为 active Run 建立 self-contained execution bundle/pin 验证。

退出条件：三类 Published owner 不再复制 Registry publication 主流程。

### Phase 3：Workflow Pack Loader 与 Reconciler

- 新增 `workflow-packs/{packId}/pack.json`。
- 新增 `local/workflow-packs.json`。
- Host 打开 Runtime Store 后执行 Pack reconciliation。
- desired enabled 成功后才能形成 active Pack pointer。
- Settings API 从 Runtime authority 返回状态。
- disabled Pack 不再签发 selection token。

退出条件：配置、Catalog 和执行资源只有一个 enable authority。

### Phase 4：删除旧 Feature App Runtime

- 删除 hostEntry、renderer、nav、arbitrary API、event bus、migration 和 required Agent provisioning。
- 删除 Renderer Feature outlet 和动态页面加载。
- 删除旧 `/api/features` 与 `/features/*` surfaces。
- 将 container resource logic 改接 active Pack bundle。
- 将 Feature management UI 改为 Pack management UI。

退出条件：静态搜索不存在 Feature renderer/nav/API/runtime loader。

### Phase 5：生命周期和清理

- 实现 Disable、draining、Uninstall 和 Purge 分离。
- 增加 active Run/retention/personal dependency preflight。
- 删除旧 `deleteFeatureData()` 跨领域语义。
- 使用 current schema 重建开发 Store。
- 更新所有 active docs 和测试。

退出条件：Pack 源码移除不会破坏已创建 Run，Purge 不会误删共享 Task 数据。

## 17. 验收标准

### 17.1 Core 与 Catalog

- Workflow Runtime 在零 Pack、零 Personal Workflow 时可以启动。
- Task Workspace 可以创建 Session、普通对话和查看空 Catalog。
- `ad_hoc_personal_task` 不出现在用户 selector。
- Temporary Workflow 可以通过 Host 内部 System Recipe 正常启动。
- Core 不发布任何用户可选业务 Recipe。

### 17.2 Workflow Pack

- 一个 Pack 可从独立目录被扫描、校验、发布和激活。
- 未配置 enabled 的 Pack 不进入 Catalog，也不注入执行资源。
- 配置 enabled 但 validation/compile 失败时，active pointer 不改变。
- Pack active 后，其 Recipe 出现在 Task Workspace，并走统一 T0/Runtime 路径。
- Core Web/Renderer 不包含具体 Pack id、业务路由或业务页面分支。
- Pack 不能动态加载 Host module 或创建自有 migration。

### 17.3 Disable 与运行中引用

- Disable 后新的 Catalog 请求不返回 Pack Recipe。
- Disable 前签发的 token 返回 `selection_stale`。
- 已创建 Run 可以使用 pinned bundle 收敛。
- active Run 尚依赖源码时，Pack 只能进入 draining，不能直接卸载。
- 历史 TaskSession、Timeline、Artifact metadata 和 Runtime detail 仍可读取。

### 17.4 Personal 与 Temporary

- Personal Workflow 只对 owner principal 出现在 Catalog。
- Personal、Pack 资源 ref/hash 冲突时 fail closed。
- Temporary Draft 不进入 Registry Catalog。
- Save as Personal 复用共享 Bundle Publisher。
- Personal Release 切换不改变旧 Run 的 pinned snapshot。

### 17.5 删除旧机制

- 不存在 `rendererEntry`、Feature nav 或 Feature runtime outlet。
- 不存在 arbitrary Feature API route dispatch。
- 不存在 Feature host activate/deactivate lifecycle。
- 不存在 Feature implicit migration。
- 不存在 `feature_ui` launch source。
- 不存在同时读取 source Feature enabled 与 Runtime Feature active pointer 的双权威页面。

### 17.6 数据安全

- Disable 不删除数据。
- Uninstall 不删除 TaskSession 或 Runtime history。
- Purge 显示 exact target summary，并拒绝删除 active/pinned/shared resource。
- External workspace 永不由 Pack Purge 自动删除。
- reset/reinitialize 只操作明确的开发 Store 文件，不影响源码、配置、凭据或用户文件。

## 18. 风险与处理

### 风险 1：把 System Recipe 误认为 Core 模板

处理：System Recipe 使用 `system_only` visibility，不进入 Catalog；文档和 UI 不称其为用户模板。

### 风险 2：禁用 Pack 后活跃 Run 丢失脚本或 Skill

处理：执行前发布 self-contained execution bundle并建立 active-run pin；完成前只 draining，不卸载资源。

### 风险 3：为了去掉 hostEntry，把宿主能力重新塞进 Workflow Runtime

处理：保留明确的 Core-owned Host Capability Adapter Registry。Runtime 只保存 exact capability binding、policy 和 receipt，不实现业务 I/O。

### 风险 4：Personal 与 Pack 过度统一

处理：只统一 Registry publication primitives 和 Catalog execution contract；principal review/ownership 与 Pack source reconciliation 保持各自 typed policy。

### 风险 5：Pack 退化成另一个 Feature 名称

处理：以静态 absence 验收禁止 renderer、nav、arbitrary API、hostEntry、migration 和后台服务重新进入 Pack Manifest。

### 风险 6：删除动作重新混合多个领域

处理：Disable、Uninstall、Purge 使用独立命令、独立 preflight 和独立 receipt；共享 Task/Runtime history默认保留。

## 19. 最终形态

```text
Icarus Core
  - Task Workspace
  - Workflow Runtime
  - Unified Catalog and Publisher primitives
  - hidden Core System Recipe
  - Host Capability Adapter Registry

Workflow Packs
  - Git-managed
  - declarative
  - optional
  - user-selectable domain Workflow templates
  - no independent UI or Host lifecycle

Personal Workflows
  - principal-owned
  - locally published
  - created from reviewed Temporary Runs

Temporary Workflow
  - TaskSession-owned Draft
  - explicit confirmation
  - executed through hidden Core System Recipe
```

该形态保留了原 Feature 设计真正需要的价值：业务资源与 Core 解耦、可整体启停、可快速移除；同时删除了在统一 Task Workspace 之后不再成立的独立应用和独立 UI 假设。
