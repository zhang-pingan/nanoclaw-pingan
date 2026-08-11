# Workflow Pack 当前架构

> **状态**：Implemented / Current
> **日期**：2026-08-08
> **范围**：Task Workspace、Workflow Runtime Registry、Core System Recipe、Workflow Pack、Personal Workflow、Temporary Workflow
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

## 2. 当前实现

当前代码已完成 latest-only 收敛：

1. `src/features/`、旧 Feature Manifest、Host entry、renderer/nav/API dispatch、Feature migration/provisioning 和相关主库表已删除。
2. `local/workflow-packs.json` 只保存期望状态；`workflow_pack_active_releases` 是公开 Catalog 和新执行的唯一 Pack authority。
3. Core 只发布 `system_only` 的 `ad_hoc_personal_task` 内部协议。公开 `listRecipes()`/`refreshRecipeSelection()` 只返回 Pack/Personal；Temporary/Personal 内部路径使用 Host-only `resolveSystemRecipe(purpose)`。
4. Core、Pack、Personal 都通过 `WorkflowBundlePublisher` 完成 Registry persistence、exact collision、publication state 与 receipt；owner-specific Release/active pointer 仍保持 typed 表。
5. Pack loader 校验 `icarus.workflow-pack/1` Manifest、portable path、source byte hash、Host lifecycle absence、Core binding allowlist 和 execution resource inventory。它基于已发布 Core System compiler authority 构造 production compiler snapshot，对 Pack Definition 做 activation 前编译，并把 compiler evidence 与 exact Core binding hashes 固定到 execution artifact。
6. Pack v1 对非空跨 Pack `dependencies` fail closed；不会静默接受尚无 exact dependency authority 的声明。
7. execution artifact 固定 Pack id/version、Manifest hash 和逐文件 hash。Run resolver 按 exact Registry snapshot、active-run retention、published retention、Pack Release 和 artifact 顺序解析 staging copy，且每次执行前验证目录与字节。
8. Disable 删除 active pointer；Uninstall 只归档源码；Purge 只删除 managed Pack data/staging，并在 active Run pin 存在时拒绝。TaskSession、Runtime history、共享 Artifact、audit 和 external workspace 始终保留。
9. Workflow Runtime Store 当前 schema 为 v16，只创建/打开 v16；旧 schema fail closed 并要求显式 backup/reset/reinitialize，不保留旧 Feature/Pack 双读或 migration compatibility。

公开 Pack Recipe 已由测试覆盖从 startup reconcile、Catalog selection 到统一 `launchPublished()`/`createWorkflowT0` 的真实路径；compile 失败时旧 active pointer 保持不变。

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

当前 `ad_hoc_personal_task` 已是隐藏 System Recipe。Task Workspace 的 `Temporary Workflow` 是 UI launch mode，不是对该 Recipe 的直接 Catalog 展示。

Host 应提供与公开 Catalog 分离的 system-only resolver，例如：

```ts
resolveSystemRecipe({
  purpose: 'temporary_workflow' | 'personal_workflow',
  principal_ref,
  now_ms,
});
```

该 resolver 只接受 Core 定义的有限 `purpose`，返回 exact Recipe、snapshot 和内部启动凭据，并验证当前 Core release；不得接受任意 Recipe id。公开 `listRecipes()` 和 `refreshRecipeSelection()` 永不返回或刷新 System Recipe，System Recipe 也不签发面向用户选择的 selection token。

### 5.3 Workflow Pack

Workflow Pack 是开发者维护、Git 管理、可整体启停的声明式 Workflow 分发单元。它可以包含多个 Recipe 及其共享资源。

Workflow Pack 负责：

- Manifest v1 closed surface 中的 Recipe、Definition、Policy、Schema、Scope Interface、Graph Template 和 Card；
- 对 Core allowlist 中 exact Capability/Executor/Adapter binding 的引用；
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

其中 Capability、Executor 和 Adapter 资源需要区分“声明/绑定”与“实现”：Pack 可以声明所需 capability 并引用 Core 允许的 exact binding，但不能携带或动态加载任意 Adapter/Executor implementation。受信任实现属于 Core-owned Host Capability Registry，并由 active execution bundle pin 住兼容身份。

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

当前 Pack source root 为 `workflow-packs/`：

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

当前 Manifest v1 形态：

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

`WorkspaceRecipeCatalogItem` 使用 `distribution_kind` 区分公开分发来源：

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

当前期望状态配置为：

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

当前启动顺序：

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

这已经取代旧的“先 activate source Feature、后打开 Workflow Runtime Store”顺序。

### 9.4 第一版不热卸载

原始需求是“项目启动时插拔”，不要求进程内热加载新 Release。启用和源码更新返回 `restart_required=true`，由下次启动统一 reconcile；Disable 同步删除 Runtime active pointer 以立即阻止新 launch，同时仍返回 restart requirement 完成期望状态收敛。

这样可以删除：

- Feature host cleanup；
- renderer dynamic unmount；
- 运行中 container resource 被 Disable/Uninstall 即时移除的竞态；
- 多个 Store 无法原子 reload 的伪事务。

### 9.5 read_only Pack 的持久文件终态

Manifest 中的 Pack 容器权限 `effect_ceiling` 只在存在 exact `workflowPackExecutionResources` pin 的 Pack Run 上生效；它与 Recipe、Execution Policy 和 compiled plan 中的 Workflow effect impact 不是同一层合同。

`read_only` 不裁剪 Bash、Write/Edit、MCP 或已声明 Host action。Agent 可以在执行中临时修改文件，但必须在最终回答前恢复 Pack 明确声明的持久 `file_scopes`。Host 将这些 scope 挂载为每次 Run 的可写隔离副本，并为该 Run 建立随机 IPC request namespace 和绑定 exact Run、Query、Agent 身份的文件 scope authority。`send_file`、AI Image、desktop capture 和本地 Host script 等 Host 文件入口只能通过 authority 的 canonical-root child API 读取、创建或生成 Host 私有快照；输出创建使用已打开目录 FD 锚定的逐级 `openat(..., O_NOFOLLOW)`，不会在 path 校验后再用可变完整路径创建。它们不信任容器提交的 `runId`、`queryId` 或 Agent folder，也不把 shadow 内可变子目录的 `realpath` 当作新信任根。Host action 仍按 pinned Manifest allowlist 检查。

anchored output helper 的 C 源码位于 `native/anchored-file-helper.c`，只在项目安装、开发启动前或构建阶段为当前 `darwin`/`linux`、`arm64`/`x64` target 编译。源码运行使用 `build/native/{platform}-{arch}`；`npm run build` 和 Host Core snapshot builder 都将同一产物与 platform、arch、SHA-256 manifest 复制到目标 `dist/workflow-packs/native/{platform}-{arch}`，构建后运行只解析该同目录产物。Host 运行时不会调用 `CC`/`cc`，并在执行前拒绝缺失、符号链接、非可执行或 hash 不匹配的 helper。

容器进程关闭是 protected IPC 不再产生合法新请求的确定边界。Host 在该边界停止 watcher 接收新 operation，等待已经开始的 operation，随后同步接管随机 namespace 中所有完整 `messages`/`tasks` JSON。`send_message`、`send_file`、schedule/pause/resume/cancel/update task、request/complete delegation 和 `reload_tools` 共用 requestId-bound receipt：request 文件名必须与内容中的 `requestId` 一致，receipt 内容必须同时匹配 `requestId` 与 action，结果目录在 Pack 容器内只读且 receipt 只由 Host 清理。业务拒绝和超时向工具返回 error；receipt 冲突等单请求/单 authority 故障 fail closed 当前 Run，但被 watcher 隔离，不能终止其他 namespace 的后续扫描。pending request 和 active operation 都清空后才注销 authority，并同时比较 shadow 与初始副本、真实 source 与执行前状态的新增、删除、内容、符号链接目标和权限。任一不一致、关闭 drain 失败或 authority/shadow 清理失败都会覆盖尚未交付的成功结果，返回 retryable error；随后删除 Run IPC namespace 和隔离目录。

该门禁不应用于普通 Agent、非 Pack `external_system_once`、Core Workflow、`workspace_write` 或 `external_write` Pack Run。`/workspace/run-once`（包括 `outputs/{runId}`）、session、IPC 和只读 Pack execution bundle 不属于持久业务文件比较范围。

这个机制只保证声明的持久文件在 Run 结束时与初始状态一致，不保证或宣称阻止 MCP、Host action、网络、数据库、消息发送或其他非文件副作用。MCP server 和 Host action 仍分别受 Manifest allowlist 约束。它不获取跨域 writer lease，也不阻止、等待或降级普通 Agent、Core、非 Pack、可写 Pack 或渠道附件写入；如果其他合法模块在当前 Run 期间改变共享真实 source，只有当前 `read_only` Pack 的真实 source 二次检查 fail closed 并要求重试，Host 不回滚或归因成其他模块错误。

## 10. Disable、Uninstall 与 Purge

### 10.1 Disable

Disable 的语义只有：

- 立即从新 Catalog selection 中移除 Pack Recipe；
- 已签发 token 在 active check 时失效；
- 不允许新的顶层 Workflow launch 引用该 Pack；
- 已创建 Run 继续使用 pinned Registry snapshot 和 execution bundle；
- 已创建 Run 的恢复、重试和 child scope 继续受同一 exact Run pin 约束；
- TaskSession、ExecutionLink、Timeline、Artifact metadata 和 audit 保持可读。

当前 Run 从 staging bundle 执行，不读取 Pack source。Disable 可以立即删除 active pointer；staging bundle 在 active Run pin 释放前不得 Purge。

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

用户仍可以在 Task Workspace 中通过独立的 `Delete Task` 命令删除自己拥有的 TaskSession；该命令遵循 Task Workspace 自己的鉴权、确认和清理合同。Pack Purge 无权代替用户调用或批量复用该命令，也不能将“由此 Pack 启动过 Run”解释为 Pack 对 Session 的所有权。

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

Core 1.2 的自包含 resource bundle 已通过共享 Publisher primitives 完成 collision、closure、snapshot、publication 和 receipt。Core bootstrap authority 与 system-only policy 保持独立，Core System Recipe 没有被转换成 Pack。

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

## 12. 当前数据模型

Runtime schema v16 只保留 Pack 模型：Registry owner 使用 exactly-one Core、Pack 或 Principal typed column；Pack Release、Release Resource 和 active pointer 使用 `workflow_pack_*` 表。Manifest 只有 `icarus.workflow-pack/1`。

Recipe visibility 为 `system_only | selectable`，公开 Catalog distribution 为 `pack | personal`。T0 的 Task Workspace 创建来源是 `task_workspace`，Pack Recipe actor 是 `human`。

开发 Store 通过精确、显式 backup/reset/reinitialize 切换到 current schema。Store 不提供旧模型 migration、双读或兼容 view。

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

当前 Temporary Workflow 使用的 `codex-task` Capability/Executor/Adapter 是该边界的基线案例：协议资源可以随 Core System bundle 自包含发布，但 Adapter/Executor implementation 仍由 Core 静态注册和托管。Workflow Pack 只能引用经过 allowlist、permission 和 compatibility 校验的 binding，不能用同名 Registry resource 替换宿主实现。

新增 Host Capability 必须回答：

- 是否可被多个 Pack 复用；
- typed input/output 是什么；
- 需要哪些 file scope、credential 和 external effect；
- 如何产生幂等 receipt；
- 如何在 container/Host 边界验证调用者；
- active Run 如何 pin adapter compatibility。

如果某项能力只为一个 Pack 服务，adapter implementation 仍放在明确的 Host adapter 模块中，由 Core registry 静态注册；这表示它是受信任宿主能力，不伪装成可随意加载的 Pack 代码。

## 14. 当前扩展面

Workflow Pack 只拥有 declarative Workflow source、execution resources、Manifest permission/effect ceiling 和 managed data root。Host module、arbitrary API、navigation、renderer、migration、background service 和 enabled-time Agent provisioning 都不属于 Pack surface。

Settings 通过固定 `/api/workflow-packs` route 集合展示：

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

## 16. 实施记录

Phase 0-5 已完成：术语和 latest-only 边界已冻结；System Recipe 已隐藏；Bundle Publisher 已共享；Pack loader/reconciler、Settings API、execution bundle pin 和单一 active authority 已接入；旧 App/plugin surface 已移除；Disable、Uninstall、Purge 已分离。

`compiled_plan_pin.provenance = golden_corpus` 是现有 Compiler 合同中的“生产编译结果经过 golden corpus authority 验证”标签，不表示 Core bundle 在运行时读取 golden fixture。Core System bundle 的 Registry source、compiler snapshot 和 Plan bytes均为自包含发布内容。

## 17. 验收标准

### 17.1 Core 与 Catalog

- Workflow Runtime 在零 Pack、零 Personal Workflow 时可以启动。
- Task Workspace 可以创建 Session、普通对话和查看空 Catalog。
- `ad_hoc_personal_task` 不出现在用户 selector。
- `listRecipes()` 和 `refreshRecipeSelection()` 永不返回 system-only Recipe。
- Temporary Workflow 可以通过 Host-only resolver 启动 System Recipe，launch 路径不通过公开 Catalog 搜索它，也不使用用户 selection token。
- Core System bundle 不读取 compiler Golden fixture，发布内容足以独立完成 compile、pin 和执行。
- Core 不发布任何用户可选业务 Recipe。

### 17.2 Workflow Pack

- 一个 Pack 可从独立目录被扫描、校验、发布和激活。
- 未配置 enabled 的 Pack 不进入 Catalog，也不注入执行资源。
- 配置 enabled 但 validation/compile 失败时，active pointer 不改变。
- Pack active 后，其 Recipe 出现在 Task Workspace，并走统一 T0/Runtime 路径。
- Core Web/Renderer 不包含具体 Pack id、业务路由或业务页面分支。
- Pack 不能动态加载 Host module 或创建自有 migration。
- Pack 只能引用 Core allowlist 中的 Capability/Adapter binding，不能提供任意 Adapter/Executor implementation。

### 17.3 Disable 与运行中引用

- Disable 后新的 Catalog 请求不返回 Pack Recipe。
- Disable 前签发的 token 返回 `selection_stale`。
- 已创建 Run 可以使用 pinned bundle 收敛。
- Uninstall 可以在 Disable 后归档源码，但 active Run pin 释放前不能 Purge staging bundle。
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
- 用户 `Delete Task` 与 Pack Purge 是两个独立命令；Pack Purge 不能删除关联 TaskSession。
- External workspace 永不由 Pack Purge 自动删除。
- reset/reinitialize 只操作明确的开发 Store 文件，不影响源码、配置、凭据或用户文件。

## 18. 风险与处理

### 风险 1：把 System Recipe 误认为 Core 模板

处理：System Recipe 使用 `system_only` visibility，不进入 Catalog；文档和 UI 不称其为用户模板。

### 风险 2：禁用 Pack 后活跃 Run 丢失脚本或 Skill

处理：执行前发布 self-contained execution bundle 并建立 active-run pin；Disable 只移除新启动权威，Purge 在 pin 释放前拒绝删除 staging 资源。

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
