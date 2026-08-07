# Icarus 协作群组项目空间 v3 方案

## 文档状态

- 状态：Implemented（current-only）
- 日期：2026-08-06
- 实施完成：2026-08-07
- 当前协议：`icarus.collaboration-group/3`
- 实施前代码基线：`main@3eff5302`（历史）
- 当前实现：Collaboration Project Space v3、SQLite v5
- 适用范围：Group、Principal、Client、Executor、Observer、Workspace、Work Item、Discussion、Workflow Definition、Workflow Instance、图形化 FSM、Git 协议、权限、同步和审计
- 前提：方案仍处于开发迭代期，没有真实群组、不可丢弃业务数据或旧签名历史；每次迭代发布的新协议直接成为唯一 current version，不实现旧版本迁移、双写、兼容读取或兼容回放
- 相关文档：
  - [Agent Group Collaboration Runtime 方案](agent-group-collaboration-runtime-plan.md)
  - [Agent Group 角色自治执行模型优化方案](agent-group-role-owned-execution-optimization.md)

本文档定义并记录当前 v3 模型。上述两份文档仅保留 v1/v2 历史设计基线；v2 的“群组必须拥有一个 Machine/Role 集合”不再是现行语义，当前代码、API、Git replay、SQLite store 和测试均对旧版本 fail closed。

## 摘要

实施前的 Agent Group Runtime 将一个群组直接等同于一个 FSM：创建群组必须同时定义 Machine、Role 和创建者初始 Role；群组只有在 Role 认领和 State Implementation 完整后才能 READY。该模型已经实现 Role-owned Action、Manual/Assisted/Automatic Turn、Handoff、Artifact、节点计时、超时提醒、审计和 Outcome-first 图形化 FSM 编辑器，但它仍然只能表达“按一个流程推进的一组人”。

v3 将 Group 提升为长期存在的协作项目空间：

1. Group 创建后立即可用，即使没有 Work Item 和 Workflow。
2. Principal 是群组成员和权限主体；一个 Principal 可以使用多个 Icarus Client，并可以配置零个或多个本地 Executor。
3. 每个 Principal 拥有群组内可见、本人可写的发布空间，可以发布进度、文件和自动化产物。
4. Group 可以创建多个 Work Item，用于任务、问题、决策和里程碑管理。
5. Group 可以拥有零到多个 Workflow Definition 和 Workflow Instance。
6. Workflow Instance 可以绑定一个 Work Item，也可以作为 Group 级持续流程独立运行。
7. 删除群组级 Role 和 Role Claim。具体 Workflow Instance 的每个可执行 State 最终解析到一个 Principal。
8. 被指派 Principal 自己决定 State 使用人工通知、Agent 辅助还是 Agent 自动执行；Action 和 Executor 均可选。
9. 未正式加入的用户可以作为本地 Observer 只读订阅、验证和浏览群组，不写入成员协议。
10. Git 原始路径在客户端映射为友好的虚拟项目树，支持定时同步和手动刷新；稳定 ID 不因显示名称变化而改写。
11. v3 机器协议和结构化事实统一使用 JSON；人类文档和 Prompt 使用 Markdown；业务文件保持自身格式并使用 JSON sidecar 描述。
12. 开发期采用 latest-only：新 schema、事件或 API 版本落地后立即替换旧版本，不保留兼容分支和迁移链。

核心关系：

```text
Group
  -> Principals
  -> Shared Workspace
  -> Principal Spaces
  -> Work Items
  -> Discussions
  -> Workflow Definitions (optional)
  -> Workflow Instances (optional)

Principal
  -> Icarus Clients (one or more while participating)
  -> Local Executors (zero or more)

Work Item
  -> optional primary Workflow Instance

Workflow Instance State
  -> resolved Principal
  -> manual by default
  -> optional Principal-owned Action
  -> optional local Executor Binding
```

## 0. 实施结果

v3 已按本文的 current-only 边界端到端落地：

- Git 控制分支只接受 v3 Group/Event/Projection 和 JSON materialization，按 canonical JSON hash、SSH signature、aggregate revision、previous hash、commit order、路径、sidecar 和文件 hash/size 完整校验；
- 本地 SQLite v5 保存 Observer/Member subscription、Principal/Client、直接权限、投影、file index、Executor Binding、execution receipt/observation、notification、audit evidence 和 staged Artifact，非 v5 store 启动时 fail closed；
- Group、Workspace、Work Item、Discussion、Workflow Definition/Instance、State Execution、Turn、timeout、Artifact、审计、备份/恢复和 verified virtual file tree 已进入 service 与 Web API；
- Work Item progress 与 Turn completion 通过 staged upload 在一个签名事件和 Git commit 中物化原始业务文件及 `metadata.json`，同时验证 scope、Principal/Client、attempt 和 fence；`/3` 备份联合保护 DB 与尚未提交的 staged bytes；
- Web/Electron `/groups` 已提供十个项目空间页面、Observer 只读状态、Work Item board/list、Discussion、文件树、Principal/Client/权限、Workflow Definition/Instance、Outcome-first 编辑器、Turn、Artifact、审计和诊断；
- v2 Role/Claim、Group-level Machine/active Turn、YAML machine/layout、旧 API、旧 store、兼容 reducer、迁移、双写和旧事件回放均已从当前实现与正向测试删除。

## 1. 实施前代码基线（历史）

### 1.1 已实现能力

截至 `main@3eff5302`，当前 Collaboration Runtime 已完成：

- 系统派生 Principal 和本机持久 Agent ID；
- Git SSH 签名事件、严格线性回放、revision/CAS、增量验证、quarantine 和恢复；
- 强制 Machine、Role、Role Claim 和 Role-owned State Implementation；
- Manual、Assisted、Automatic 三种 Turn；
- Handoff、Artifact、共享 `data/`、Executor Binding 和 durable receipt；
- 节点 `start_timeout_ms`、`execution_timeout_ms`、超时提醒和 `turn_timeout_observed`；
- 完整 Turn 审计、脱敏 JSON 导出和本地证据关联；
- Outcome-first 图形化 FSM 创建和编辑；
- `machine_revised` 与 `machine_layout_updated`；
- 自由布局、角色泳道、自动整理、节点拖动、撤销/重做、实时校验和只读 Runtime 图；
- 当前 v2 Machine 业务 hash 与 `layout.yaml` 展示布局隔离；v3 对应文件改为 JSON。

图形化编辑器的现有实现应作为 v3 Workflow Definition Editor 的基础继续复用，而不是推倒重写。

### 1.2 当前强制耦合

当前 `groupDefinitionSchema` 强制：

```text
machine_ref
required_roles.length >= 1
```

当前 `createGroup` 同时要求：

```text
roles
initialRole
machine
creator role claim
```

当前 `FORMING/READY/RUNNING/PAUSED/CLOSED` 同时承担群组和 Workflow 生命周期；`businessState` 和 `activeTurnId` 也直接保存在 Group Projection 上。这意味着：

- 没有 FSM 就不能创建 Group；
- 未认领 Role 时不能把 Group 当作公共空间使用；
- 一个 Group 只能表达一个活动 Machine；
- 无法并行运行多个互不相关的任务流程；
- 无法表达只发布进度、讨论和文件的自由协作群组。

### 1.3 当前 Git 空间缺口

当前 Git 有：

```text
groups/members/{principal}/{agent}.json
data/
artifacts/{turn-id}/
```

但没有：

- Principal 自己的群组发布空间；
- Work Item；
- Discussion；
- Group 下多个 Workflow Definition/Instance；
- Observer 本地订阅语义；
- 面向用户的完整虚拟文件索引。

当前 `data/` 是公共小型数据区，`artifacts/` 只围绕 Turn。它们不能直接替代项目空间、成员进度和任务管理模型。

### 1.4 当前实现落点

v3 实施应优先演进而不是重复实现这些模块：

| 当前能力                                              | 代码位置                                        |
| ----------------------------------------------------- | ----------------------------------------------- |
| v2 schema、Machine、timeout、layout、event            | `src/collaboration/protocol/schema.ts`          |
| deterministic reducer、Turn、deadline                 | `src/collaboration/protocol/reducer.ts`         |
| Git 签名回放和 materialization 校验                   | `src/collaboration/protocol/git-chain.ts`       |
| Group command、Machine/Layout revision、Artifact/Data | `src/collaboration/service.ts`                  |
| Scheduler、Executor、通知和 timeout observation       | `src/collaboration/scheduler.ts`                |
| SQLite v4 和本地 evidence                             | `src/collaboration/store.ts`                    |
| Web API                                               | `src/collaboration/web-api.ts`                  |
| 图模型、校验、自动布局和 draft conversion             | `electron/renderer/collaboration-fsm.js`        |
| 图画布和 State Inspector                              | `electron/renderer/collaboration-fsm-editor.js` |

图形化功能由 `c70c72c1`、`9b69853f`、`3eff5302` 三个提交形成当前基线。

## 2. 产品定位

### 2.1 Group 是协作容器

Group 的职责是：

- 维护群组身份、成员和权限；
- 提供共享项目空间；
- 汇总成员进度和文件；
- 管理 Work Item、Discussion 和通知；
- 承载可选 Workflow；
- 通过 Git 签名事实提供跨实例同步和审计。

Group 不再要求：

- 创建时定义 Role；
- 创建时认领 Role；
- 创建时定义 Machine；
- 等待 Workflow READY 才能使用；
- 只有一个 `businessState` 或一个 `activeTurnId`。

### 2.2 两种协作模式并存

| 模式          | 核心行为                                                | 是否需要 Workflow |
| ------------- | ------------------------------------------------------- | ----------------- |
| 自由协作      | 发布个人进度、文件、任务、问题、评论和同步信息          | 否                |
| Workflow 推进 | State、Outcome、Turn、超时、Handoff、Action 和 Executor | 是                |

二者共享 Principal、Workspace、Work Item、Discussion、通知和审计。Workflow 的状态变化进入群组活动流；自由协作中发现的问题可以创建 Work Item，并在需要时启动 Workflow Instance。

### 2.3 非目标

- 不把 Git 轮询改造成高频即时聊天系统。
- 不实现多人实时共同编辑同一文档。
- 不把 Git 作为大文件仓库；大文件继续使用外部对象引用或后续对象存储。
- 不引入中心化账号服务作为 v3 前置条件。
- 不让客户端直接编辑受控 checkout 绕过签名事件。
- 不让 Executor 获得高于其 Principal 的群组权限。
- 不把 Work Item dependency 实现成另一套 DAG 调度器。
- 不保留 v2 Role/Claim 和 v3 Principal Assignment 两套并行协议。
- 不为开发迭代中已废弃的 schema、事件、API、SQLite 或 Git fixture 保留兼容代码和迁移工具。

## 3. 核心设计原则

### 3.1 Principal 是人的稳定身份

`principal_id` 继续由 SSH 签名公钥 fingerprint 稳定派生：

- 同一个人在不同 Group 中使用同一个 Principal；
- 加入 Group 是注册已有 Principal，不是创建一个 Group 内随机 Principal；
- display name 可以改变和重名，不能用于路径、权限和签名验证；
- Group Membership、Work Item ownership、Workflow State assignment 和权限 grant 都绑定 Principal。

### 3.2 Client 与 Executor 分离

v2 的 `agent_id` 同时接近“本机 Icarus 安装”和“执行 Agent”两个语义。v3 明确拆分：

| 概念      | 含义                                     | 是否进入共享 Git                               |
| --------- | ---------------------------------------- | ---------------------------------------------- |
| Principal | 人、成员和权限主体                       | 是                                             |
| Client    | Principal 使用的某个 Icarus 安装实例     | 公开描述进入，私有配置不进入                   |
| Executor  | Codex、Workflow、Run-once 等可选执行工具 | 仅可选公开 descriptor 进入，Binding/凭据留本地 |

一个 Principal 可以：

- 有多个 Client；
- 有零个 Executor，只进行人工协作；
- 有多个 Executor，并按 Workflow State 选择；
- 在不同 Client 上接收通知，但一个 Turn attempt 只能由一个 Client claim。

### 3.3 Group 默认可用，Workflow 默认可选

Group 创建成功后直接进入 `ACTIVE`。Workflow Definition、Workflow Instance、Work Item 都可以稍后创建。

### 3.4 共享事实追加，展示数据可重建

- 签名事件和不可变内容是权威事实；
- `item.json`、`instance.json` 和 `projections/` 是可验证、可重建的物化视图；
- 删除使用 archive/tombstone 事件，不抹除审计历史；
- 客户端虚拟树从同一个 verified Git Head 和本地 Projection 构建。

### 3.5 默认人工，自动执行显式选择

State 解析到 Principal 后，如果没有发布执行实现，则默认：

```text
mode = manual
behavior = notify_only
action_ref = null
executor = null
```

因此未配置 Agent 或 Action 不阻止 Workflow Instance 启动。只有 Principal 显式选择 Assisted/Automatic 时，才要求 Action 和本地 Executor Binding。

### 3.6 数据格式边界

v3 使用以下统一规则：

| 内容类型                 | 权威格式     | 示例                                                    |
| ------------------------ | ------------ | ------------------------------------------------------- |
| 机器协议和结构化业务事实 | JSON         | Group、Member、Work Item、Machine、Instance、Event      |
| API 请求和响应           | JSON         | command、query result、validation error                 |
| 人类文档和 Agent Prompt  | Markdown     | 项目说明、Action Prompt、设计说明、验收报告             |
| 业务文件                 | 保持自身格式 | 源码、PNG、PDF、DOCX、XLSX、PPTX、ZIP                   |
| 业务文件的结构化描述     | JSON sidecar | uploader、media type、size、hash、业务引用、content ref |

这是一条存储和协议边界，不是新的手工配置要求：

- 普通用户不直接填写 JSON；固定 UI、Host API 或 Agent command 生成结构化对象；
- 所有权威 JSON 在写入事件或 Git 前必须通过版本化 JSON Schema；
- 协议对象使用 UTF-8 JSON，拒绝重复 Key、非有限数值和 Schema 未声明字段；扩展只能进入显式 `extensions` 字段；
- Git 中物化两空格缩进、文件末尾换行的 pretty JSON，便于 review；
- 业务 hash、事件 hash 和签名输入使用 RFC 8785 JSON Canonicalization Scheme（JCS），不得直接 hash pretty JSON 原始字节；
- JSON 字段顺序、缩进和换行不影响业务 hash；Markdown 和业务文件则按其内容字节计算 content hash；
- Prompt 的 ID、版本、引用、权限和 hash 属于 Action JSON，正文存放在独立 `.md` 文件，不使用 YAML front matter 承载权威字段；
- 业务文件保留原始文件名和扩展名，旁置 `metadata.json` 固定 `content_ref`、media type、size、hash、uploader 和业务引用；
- YAML 不是 v3 权威格式，也不由系统生成或写回。若未来需要兼容外部模板，可作为可选导入格式，导入后必须转换、校验并持久化为 JSON。

每个协议对象必须包含稳定的 `format` 标识；当同一格式发生不兼容变化时发布新 format/version，而不是根据文件内容猜测版本。

### 3.7 开发期 latest-only

当前没有真实历史数据，兼容性会增加双模型、分支逻辑和无效测试成本，因此开发期只实现最新目标版本：

- 新 schema、事件、API、Git 目录或 SQLite schema 合入后，立即成为唯一可运行版本；
- 删除被替代的 parser、reducer 分支、API endpoint、materializer、migration、feature flag、fixture 和兼容测试；
- 不双写新旧格式，不从旧事件回放到新 Projection，不接受旧客户端降级协商；
- 发现非 current `format`、protocol version、Git fixture 或本地数据库时 fail closed，开发环境通过显式 reset、重新初始化或重新 clone current fixture 处理；
- `format` 和 `protocol_version` 仍必须存在，用于确定性识别 current version 和拒绝陈旧输入，而不是承诺兼容；
- 文档只描述最新目标模型；旧文档可以作为历史设计记录，但不能继续定义现行行为。

该原则仅适用于尚无不可丢弃数据的开发阶段。在首次真实群组或不可丢弃签名历史产生前，必须设置明确的 compatibility freeze point；此后任何破坏性升级都需要单独的迁移、回放和版本支持方案，不能默认继续 latest-only。

## 4. 领域模型

```text
Group
├── Memberships (Principal)
│   ├── Clients
│   └── optional Executor descriptors
├── Permission Grants
├── Workspace
│   ├── Shared Space
│   └── Principal Spaces
├── Work Items
│   ├── Progress Updates
│   ├── Relations
│   └── optional primary Workflow Instance
├── Discussions
├── Workflow Definitions
│   ├── Machine
│   └── Layout
└── Workflow Instances
    ├── Scope
    ├── Principal Assignments
    ├── State Executions
    ├── Turns
    └── Audit Timeline
```

### 4.1 Aggregate 边界

| Aggregate           | 主键            | 独立 revision | 主要写入者                     |
| ------------------- | --------------- | ------------: | ------------------------------ |
| Group               | `group_id`      |            是 | Owner/Admin                    |
| Membership          | `principal_id`  |            是 | Principal + Admin              |
| Principal Space     | `principal_id`  |        追加流 | 对应 Principal                 |
| Work Item           | `work_item_id`  |            是 | 创建者、负责人、Admin          |
| Discussion          | `thread_id`     |            是 | 成员追加消息                   |
| Workflow Definition | `definition_id` |            是 | Workflow Designer/Publisher    |
| Workflow Instance   | `instance_id`   |            是 | Instance 管理者和当前 assignee |

不同 Aggregate 不共享业务 revision，避免多个成员在不同 Work Item 或 Discussion 上发布内容时争用同一个全局序号。

## 5. 身份、加入和观察

### 5.1 Membership

Membership 只以 Principal 为唯一成员键：

```json
{
  "format": "icarus.collaboration-member/3",
  "principal_id": "principal_sha256_xxx",
  "display_name": "Alice",
  "signing_key_ref": "ssh-ed25519:SHA256:...",
  "signing_public_key": "ssh-ed25519 ...",
  "status": "active",
  "joined_at_event": "evt_xxx"
}
```

Client 单独注册：

```json
{
  "format": "icarus.collaboration-client/1",
  "principal_id": "principal_sha256_xxx",
  "client_id": "client_uuid",
  "display_name": "Alice MacBook",
  "capabilities": [],
  "registered_at_event": "evt_xxx"
}
```

Client ID 是本机 Icarus 安装标识，不由用户填写。Client 的本地路径、通知系统句柄、Provider 配置和凭据不得进入 Git。

### 5.2 Observer

Observer 是本机只读订阅，不是 Group Membership：

```text
remote URL
group ID
subscription_mode = observer
poll interval
last verified head
local notification preference
```

Observer：

- 不出现在 `members/`；
- 不发布 Principal、Client 或 Executor；
- 不能写签名业务事件；
- 可以 fetch、验签、增量归约、浏览文件和审计；
- 可以设置本地自动刷新和只读通知；
- 后续可以原地升级为正式 Member。

### 5.3 加入流程

用户输入 Git URL 后先进入只读 Inspect：

```text
Inspect remote
  -> verify group definition and signatures
  -> show creator/member/work item/workflow summary
  -> choose Observe or Join
```

正式 Join 支持：

```json
{
  "membership_policy": {
    "join": "approval"
  }
}
```

`join` 的合法枚举为 `open`、`approval` 和 `invite_only`。

- `open`：候选 Principal 自签注册，协议验证 Principal 与公钥 fingerprint 一致；
- `approval`：候选提交申请，Owner/Admin 签名批准；
- `invite_only`：申请还必须引用有效邀请；
- transport 写权限与协议 Membership 是两层独立授权。

### 5.4 Git 可见性边界

只要用户拥有 Git Remote read 权限，就可以读取已推送的完整历史。客户端的 Observer/Member 按钮不是保密边界。

```json
{
  "visibility_policy": {
    "observer_access": "allowed"
  }
}
```

`observer_access` 的合法枚举为 `allowed` 和 `members_only`。

`members_only` 必须由 Git 服务 read ACL 配合实现；已经 clone 的内容无法远程收回。任何凭据、私有 Prompt override、本地绝对路径和完整 Agent transcript 都不得写入 Group Git。

## 6. 权限模型

### 6.1 删除 Group Role，保留直接 Grant

v3 删除：

```text
groups/roles/
groups/claims/
Role cardinality
Role capability claim
```

Group 权限直接授予 Principal：

```json
{
  "format": "icarus.collaboration-permission-grant/1",
  "principal_id": "principal_bob",
  "grants": [
    "work_item:create",
    "work_item:manage_owned",
    "workflow_definition:propose",
    "workflow_instance:start_allowed"
  ]
}
```

文档和 UI 中的 Owner/Admin/Member/Workflow Designer 是常用权限集合的显示名称，不是重新引入 Group Role。协议授权只校验 Principal、直接 grant 和资源所有权；除唯一 Owner 身份外，不依赖可认领的角色对象。

### 6.2 建议权限集合

```text
group:admin
group:archive
member:approve
permission:grant

workspace:write_shared
workspace:publish_owned

work_item:create
work_item:manage_owned
work_item:manage_all

discussion:create
discussion:post
discussion:moderate

workflow_definition:propose
workflow_definition:publish
workflow_instance:start_allowed
workflow_instance:manage_all
```

### 6.3 默认策略

| 操作                     |          Owner/Admin |           Member | Work Item Owner | Workflow Assignee |
| ------------------------ | -------------------: | ---------------: | --------------: | ----------------: |
| 创建 Work Item           |                   是 |           按策略 |              是 |                是 |
| 发布个人进度             |                   是 |               是 |              是 |                是 |
| 写共享空间               |                   是 |         按 grant |        按 grant |          按 grant |
| 修改任意 Work Item       |                   是 |               否 |        仅负责项 |                否 |
| 提议 Workflow Definition |                   是 |         按 grant |        按 grant |          按 grant |
| 发布 Workflow Definition |                   是 |               否 |              否 |                否 |
| 启动已允许 Workflow      |                   是 | 按 launch policy |        通常允许 |                否 |
| 修改 State Execution     | 仅自己被指派的 State |             同左 |            同左 |                是 |

Executor 始终继承 Principal 权限，不能因为运行在本地就绕过 Git 事件授权。

## 7. Workspace 和个人进度

### 7.1 Shared Space

`workspace/shared/` 用于适合 Git 的公共文本、结构化数据和小文件：

- 只允许规范化相对路径；
- 更新使用 expected revision；
- event 声明 media type、size 和 content hash；
- 拒绝符号链接、路径穿越和超限内容；
- 大文件只保存 metadata 和外部 locator。

上传的业务文件保持自身格式；结构化属性放在同目录 sidecar：

```json
{
  "format": "icarus.collaboration-file-metadata/1",
  "file_id": "file_contract_v2",
  "original_filename": "续费接口协议.pdf",
  "content_ref": "续费接口协议.pdf",
  "media_type": "application/pdf",
  "size": 483921,
  "sha256": "sha256:...",
  "uploader_principal_id": "principal_alice",
  "work_item_refs": ["wi_101"]
}
```

`content_ref` 只能是已规范化的同目录 basename，不能包含路径分隔符或 `..`；外部对象则使用显式 locator 类型，不伪装成本地内容文件。

### 7.2 Principal Space

`workspace/principals/{principal-id}/` 对群组可见、对应 Principal 可写。它不是私有空间。

Principal 的进度使用追加结构：

```json
{
  "format": "icarus.collaboration-progress-update/1",
  "update_id": "update_xxx",
  "principal_id": "principal_alice",
  "summary": "支付接口已完成",
  "completed": ["完成续费签约接口"],
  "in_progress": ["接入支付回调"],
  "next_steps": ["与前端联调"],
  "blockers": ["缺少测试商户"],
  "work_item_refs": ["wi_101"],
  "workflow_instance_refs": [],
  "artifact_refs": [],
  "origin": "human",
  "actor_client_id": "client_xxx",
  "executor_id": null,
  "created_at": "2026-08-06T12:00:00.000Z"
}
```

`origin` 的合法枚举为 `human`、`agent` 和 `workflow`。

不要用一个不断覆盖的 `status.md` 作为权威事实。客户端可以投影“最新状态”，但必须保留全部更新和 Actor。

### 7.3 Executor 产物

Executor 可以代表 Principal 发布进度或文件，但共享事件必须同时记录：

```text
actor_principal_id
actor_client_id
executor_id nullable
origin = agent | workflow
```

用户界面显示“Alice via Codex”，不能把 Agent 产出伪装为没有来源的人工内容。

## 8. Work Item

### 8.1 定位

Work Item 是 Group 中一个可管理任务对象，回答：

```text
要完成什么
由谁负责
当前进展如何
有什么阻塞和依赖
是否需要 Workflow
最终是否完成
```

一个 Group 可以有多个并行 Work Item。典型研发项目中，每次需求、缺陷或独立交付都可以创建一个 Work Item。

### 8.2 类型

```text
task
issue
decision
milestone
```

第一阶段必须完整支持 `task` 和 `issue`；`decision/milestone` 使用相同 Aggregate 和事件扩展，不创建平行存储模型。

### 8.3 数据模型

```json
{
  "format": "icarus.collaboration-work-item/1",
  "work_item_id": "wi_101",
  "type": "task",
  "title": "增加会员自动续费",
  "description": "支持续费开关、失败通知和支付回归",
  "status": "in_progress",
  "priority": "high",
  "creator_principal_id": "principal_bob",
  "owner_principal_id": "principal_bob",
  "preferred_executor_id": null,
  "contributors": ["principal_alice", "principal_carol"],
  "acceptance_criteria": [
    "支持续费开关",
    "支持续费失败通知",
    "通过支付回归测试"
  ],
  "labels": ["payment"],
  "due_at": "2026-08-20T23:59:59.000Z",
  "parent_id": null,
  "blocked_by": [],
  "related_items": [],
  "primary_workflow_instance_id": "wfi_201",
  "created_at": "2026-08-06T12:00:00.000Z",
  "updated_at": "2026-08-06T12:00:00.000Z",
  "closed_at": null,
  "revision": 1
}
```

Work Item owner 绑定 Principal，而不是 Executor。更换本机 Agent 不改变任务责任人。

### 8.4 生命周期

```text
PROPOSED
  -> OPEN
  -> CANCELLED

OPEN
  -> IN_PROGRESS
  -> CANCELLED

IN_PROGRESS
  -> BLOCKED
  -> DONE
  -> CANCELLED

BLOCKED
  -> IN_PROGRESS
  -> CANCELLED

DONE
  -> OPEN (reopen)
```

- 人工从 UI 创建可以直接 `OPEN`；
- Agent 自动发现的问题默认 `PROPOSED`，避免自动制造大量正式任务；
- Group policy 可以允许受信任 Agent 直接创建 `OPEN`；
- `DONE` 后仍保留更新、Discussion、Artifact 和 Workflow 历史。

### 8.5 负责人、参与者和订阅者

```text
owner          唯一直接负责人 Principal
contributors   参与执行或讨论的 Principal
watchers       仅订阅变化
preferred executor 负责人当前偏好的本地执行器，可为空
```

指派可以直接生效，也可以按 Group policy 进入待确认：

```text
assignment_changed
assignment_acknowledged
assignment_declined
```

### 8.6 进度更新

Work Item 的详情字段与进度时间线分离。每次更新追加：

```json
{
  "format": "icarus.collaboration-work-item-progress/1",
  "update_id": "update_wi_101_4",
  "work_item_id": "wi_101",
  "summary": "后端接口完成，等待联调",
  "completed": ["续费签约接口"],
  "next_steps": ["接入支付回调"],
  "blockers": [],
  "artifact_refs": [],
  "actor_principal_id": "principal_alice",
  "actor_client_id": "client_macbook",
  "origin": "agent",
  "created_at": "2026-08-06T18:00:00.000Z"
}
```

个人空间更新可以引用零到多个 Work Item；Work Item 不复制同一份内容，只保留稳定引用。

### 8.7 子任务和依赖

- `parent_id` 表达父子任务；
- `blocked_by` 表达阻塞依赖；
- `related_items` 表达非阻塞关联；
- 第一阶段 dependency 只用于展示、提醒和完成警告，不调度 Executor；
- 父项完成但仍有未完成子项时默认警告，是否阻止由 Group policy 决定；
- 不使用简单“完成子项数量”冒充真实工作量百分比。

### 8.8 Due Date 与 State Timeout

二者必须分离：

| 概念                   | 作用             | 收件人               | 是否改变流程                |
| ---------------------- | ---------------- | -------------------- | --------------------------- |
| Work Item `due_at`     | 业务截止日期     | owner/watchers/Admin | 否                          |
| Workflow State timeout | 当前节点执行时限 | assignee/creator     | 否，v3 第一阶段 notify-only |

## 9. Discussion

Discussion 是异步项目讨论，不是实时聊天：

```json
{
  "format": "icarus.collaboration-discussion/1",
  "thread_id": "thread_12",
  "title": "自动续费失败通知方案",
  "created_by": "principal_bob",
  "scope": {
    "type": "work_item",
    "ref": "wi_101"
  },
  "status": "open"
}
```

Message 追加写入，修改和删除通过新事件表达：

```text
discussion_created
message_posted
message_revised
message_tombstoned
discussion_resolved
discussion_reopened
```

Message 可以引用 Principal、Work Item、Workflow State/Turn、Progress Update 和 Artifact。所有 mention 和通知投递继续使用本地持久去重记录。

## 10. Workflow Definition

### 10.1 定位

Workflow Definition 是可复用流程模板，回答：

```text
有哪些 State
哪个 State 是 initial/terminal
每个 State 允许哪些 Outcome
Outcome 指向哪个 State
State 由哪个 Principal 或参与人槽位负责
State 的 timeout policy
谁可以启动这个 Definition
```

Workflow Definition 不决定：

- 责任 Principal 使用哪个 Executor；
- 责任 Principal 的 Action Prompt；
- 本地 Workspace、Provider 和凭据；
- 某个具体 Instance 当前处于哪个 State。

### 10.2 Definition 数据

```json
{
  "format": "icarus.collaboration-workflow-definition/1",
  "definition_id": "requirement_delivery",
  "name": "需求交付流程",
  "description": "从需求确认到研发、测试和完成",
  "version": 3,
  "created_by_principal_id": "principal_bob",
  "published_by_principal_id": "principal_alice",
  "status": "published",
  "launch_policy": {
    "group_admin": true,
    "work_item_owner": true,
    "principals": []
  },
  "machine_ref": "machine.json",
  "layout_ref": "layout.json",
  "machine_hash": "sha256:...",
  "layout_hash": "sha256:..."
}
```

Definition 草稿和已发布版本必须区分。普通成员可以按 grant 提案，只有 `workflow_definition:publish` 可以发布可运行版本。

### 10.3 State Assignment

Definition 支持两种 assignment：

```json
{
  "assignee": {
    "type": "principal",
    "principal_id": "principal_alice"
  }
}
```

适用于 Group 内专用流程。

```json
{
  "assignee": {
    "type": "participant_slot",
    "slot": "developer"
  }
}
```

适用于可复用模板。`participant_slot` 不是 v2 Group Role：

- 不存在 Group 级认领；
- 没有 min/max；
- 没有 capability claim；
- 不拥有群组权限；
- 只是创建 Workflow Instance 时必须解析的参数。

### 10.4 Machine 示例

```json
{
  "format": "icarus.collaboration-machine/3",
  "initial_state": "requirement",
  "states": {
    "requirement": {
      "label": "需求确认",
      "assignee": {
        "type": "participant_slot",
        "slot": "product"
      },
      "terminal": false,
      "timeout_policy": {
        "start_timeout_ms": 86400000,
        "execution_timeout_ms": 172800000,
        "reminder_interval_ms": 21600000,
        "on_timeout": "notify_only"
      },
      "transitions": [
        {
          "outcome": "confirmed",
          "label": "已确认",
          "target_state": "development"
        },
        {
          "outcome": "rejected",
          "label": "已拒绝",
          "target_state": "cancelled"
        }
      ]
    },
    "development": {
      "label": "研发实现",
      "assignee": {
        "type": "participant_slot",
        "slot": "developer"
      },
      "terminal": false,
      "transitions": [
        {
          "outcome": "ready_for_test",
          "label": "提交测试",
          "target_state": "testing"
        },
        {
          "outcome": "blocked",
          "label": "阻塞",
          "target_state": "development"
        }
      ]
    },
    "testing": {
      "label": "测试验收",
      "assignee": {
        "type": "participant_slot",
        "slot": "tester"
      },
      "terminal": false,
      "transitions": [
        {
          "outcome": "passed",
          "label": "通过",
          "target_state": "completed"
        },
        {
          "outcome": "changes_requested",
          "label": "需要修改",
          "target_state": "development"
        }
      ]
    },
    "completed": {
      "label": "完成",
      "terminal": true,
      "transitions": []
    },
    "cancelled": {
      "label": "取消",
      "terminal": true,
      "transitions": []
    }
  }
}
```

Outcome 是 State 的业务执行结果，不是 Executor 技术状态。Executor crash、Provider unavailable 和 receipt 不确定继续进入 `RECOVERY_REQUIRED`，不能自动映射为 `failed` Outcome。

## 11. Workflow Instance

### 11.1 Scope

每个 Workflow Instance 必须属于一个 Group，但 Work Item 绑定可选：

```json
{
  "scope": {
    "type": "work_item",
    "work_item_id": "wi_101"
  }
}
```

或：

```json
{
  "scope": {
    "type": "group"
  }
}
```

Work Item 级 Instance 服务一个明确任务；Group 级 Instance 用于持续巡检、每周汇总、发布准备、需求分诊等跨任务流程。

一个 Instance 可以引用多个相关 Work Item，但最多一个 primary Work Item。覆盖多个任务的发布或汇总流程应使用 Group scope 和 related refs，不应随意选择一个任务充当 owner。

### 11.2 Instance 数据

```json
{
  "format": "icarus.collaboration-workflow-instance/1",
  "instance_id": "wfi_201",
  "definition_id": "requirement_delivery",
  "definition_version": 3,
  "definition_hash": "sha256:...",
  "scope": {
    "type": "work_item",
    "work_item_id": "wi_101"
  },
  "participant_bindings": {
    "product": "principal_bob",
    "developer": "principal_alice",
    "tester": "principal_carol"
  },
  "resolved_assignments": {
    "requirement": "principal_bob",
    "development": "principal_alice",
    "testing": "principal_carol"
  },
  "lifecycle": "running",
  "business_state": "development",
  "active_turn_id": "turn_xxx",
  "epoch": 1,
  "revision": 12,
  "created_by_principal_id": "principal_bob"
}
```

Instance 创建时固定 Definition hash、slot mapping 和每个 State 的 resolved Principal。Definition 后续发布新版本不改变已运行 Instance。

### 11.3 Work Item 状态映射

绑定 Work Item 时必须固定 Workflow terminal 到 Work Item status 的映射：

```json
{
  "work_item_status_mapping": {
    "completed": "done",
    "cancelled": "cancelled"
  }
}
```

Workflow 运行期间：

- Work Item 仍保存目标、负责人、验收条件和 due date；
- Workflow 保存执行阶段、Turn 和 Handoff；
- Work Item status 由 Workflow binding 事件更新；
- 客户端不能同时手工将 Work Item 设为 `DONE` 而 Workflow 仍在运行；
- Workflow timeout 只提醒，不自动将 Work Item 设为 `BLOCKED`。

第一阶段一个 Work Item 同时最多拥有一个活动 primary Workflow Instance；历史 Instance 全部保留。

### 11.4 Group 级 Instance

Group 级 Instance：

- 不映射任何 Work Item status；
- 可以读取多个 Work Item 的受控 Projection；
- 可以发布 Group Progress Update；
- 可以发现并提议新 Work Item；
- Agent 自动创建的 Work Item 默认 `PROPOSED`；
- 自己拥有独立 business state、Turn、deadline 和审计链。

### 11.5 Reassignment

- 尚未进入的 State 可以由 Instance 管理者重新指派 Principal，并记录 `workflow_state_assignee_changed`；
- 当前 State 已产生 Turn 后不能直接替换 Principal；
- 更换当前负责人必须 cancel/recover 当前 attempt，再创建新 Turn；
- 已完成 State 永久保留当时的 assignee、claimant Client 和 Executor；
- reassignment 不能修改 Definition，只影响当前 Instance 的 assignment revision。

## 12. Principal-owned State Execution

### 12.1 默认行为

State 进入后，Runtime 解析 `assignee_principal_id` 并创建 Turn。没有执行配置时：

1. 通知该 Principal 的活动 Client。
2. 用户确认开始，某个 Client 获得 claim 和 fence。
3. 用户人工处理。
4. 用户确认完成、选择合法 Outcome、填写 Handoff、上传 Artifact。

### 12.2 可选执行实现

被指派 Principal 可以为自己负责的 State 发布：

```json
{
  "format": "icarus.collaboration-state-execution/1",
  "instance_id": "wfi_201",
  "state_id": "development",
  "principal_id": "principal_alice",
  "mode": "assisted",
  "action_ref": "workspace/principals/principal_alice/automations/actions/implement.json",
  "published_at_event": "evt_xxx"
}
```

约束：

- `manual` 使用 `action_ref: null`；
- `assisted/automatic` 必须引用 Principal 自己拥有的 Action；
- Definition 发布者和 Group Owner 不能替其他 Principal 编写 Action；
- Action 类型和 Prompt 是共享可审计定义；
- Executor Binding、Workspace path、Provider 和凭据只保存在本地；
- 同一 Principal 的不同 Client 可以拥有不同 Executor，但 Turn claim 最终固定一个 Client；
- Turn 创建后固定 execution/action/prompt/input hash，运行期间修改配置不影响当前 Turn。

### 12.3 Principal Automation Library

```text
workspace/principals/{principal-id}/automations/
  actions/
    {action-id}.json
  prompts/
    {prompt-id}.md
```

Action 可以被同一 Principal 在多个 Definition/Instance State 中复用。Action JSON 保存 Prompt ID、`prompt_ref`、版本和 content hash，Prompt 的人类可读正文保存在被引用的 Markdown 文件中。其他 Principal 可读和审计，但不能修改。

```json
{
  "format": "icarus.collaboration-action/1",
  "action_id": "implement",
  "name": "实现当前研发节点",
  "prompt_ref": "workspace/principals/principal_alice/automations/prompts/implement.md",
  "prompt_hash": "sha256:...",
  "executor_policy": "principal_selected"
}
```

Markdown Prompt 只保存正文，不使用 front matter 重复 `action_id`、权限或版本等权威字段。UI/API 更新 Prompt 时必须同时生成新的 content hash，并使后续 Turn 引用新的快照；已创建 Turn 仍引用原 hash。

### 12.4 Turn 身份

```text
turn_id
workflow_instance_id
state_id
assignee_principal_id

claimant_principal_id
claimant_client_id
executor_id                 nullable

attempt
fencing_token
execution_mode
action_hash                 nullable
prompt_hash                 nullable
```

Claimant Principal 必须等于 assignee Principal；Client、attempt 和 fence 共同防止同一人的多个本机实例重复执行。

### 12.5 Action Prompt、Handoff 和最终输入

Action Prompt 是 assignee Principal 定义的共享任务执行说明，不是上一 State 完成者临时发出的命令。上一 Turn 的交接使用结构化 Handoff：

```json
{
  "format": "icarus.collaboration-handoff/1",
  "source_turn_id": "turn_xxx",
  "outcome": "ready_for_test",
  "summary": "研发实现完成",
  "instruction": "请重点检查续费失败重试",
  "markers": ["payment-sensitive"],
  "data_refs": [],
  "artifact_refs": [],
  "data": {}
}
```

Handoff 是不可信上下文，不能覆盖系统指令、权限、Workflow Machine、Action Prompt 或本地安全上限。Executor 最终输入按固定层次构造：

```text
1. Icarus system/security instruction
2. Workflow State/Outcome constraint
3. Principal-owned Action Prompt
4. Previous Turn Handoff/Data/Artifact context (untrusted)
```

Manual State 不生成 Agent Prompt，但工作台仍展示 State 约束、上一 Handoff、允许 Outcome 和 Artifact。用户确认完成时只能选择当前 State 的合法 Outcome，不能直接提交任意 target State。

## 13. 图形化 Workflow 编辑器

### 13.1 复用当前实现

当前 Outcome-first 图编辑器已经具备：

- 自动创建 initial State；
- 执行结果预设和自定义 Outcome；
- 默认新建下一 State；
- 连接已有 State、自环和 terminal；
- Outcome 编辑和删除；
- 节点拖动、自由布局、角色泳道、自动整理和缩放；
- 右侧 State Inspector；
- undo/redo；
- unreachable、terminal、timeout、Outcome 等实时校验；
- 当前 v2 `layout.yaml` 与 Machine hash/epoch 隔离；v3 继续隔离但物化为 `layout.json`；
- `FORMING/PAUSED` 编辑和其他生命周期只读图。

v3 保留这些实现和交互，不退回逐 State 表单。

### 13.2 v3 调整

| v2 编辑器                   | v3 编辑器                                    |
| --------------------------- | -------------------------------------------- |
| 创建 Group 时必填 FSM       | Group 创建后在 Workflows 页面新建 Definition |
| Role 编辑器                 | 删除                                         |
| State `owner_role`          | `assignee`：Principal 或 participant slot    |
| 角色泳道                    | 参与人/Principal 泳道                        |
| 当前 v2 `machine.yaml` 根级 | `workflows/definitions/{id}/machine.json`    |
| 当前 v2 `layout.yaml` 根级  | Definition 自己的 `layout.json`              |
| 一个 Group 一个当前 State   | 每个 Workflow Instance 独立当前 State        |

### 13.3 Outcome-first 创建

```text
选中 State
  -> 添加执行结果
  -> 选择 succeeded/failed/blocked/cancelled 或自定义 Outcome
  -> 选择新建下一节点 / 连接已有 / 返回当前 / terminal
  -> 自动创建连线和必要 State
  -> 打开新 State Inspector
```

常用结果只是输入预设，不限制业务枚举。已添加 Outcome 在 Definition 草稿中可修改 label、stable ID 和 target；已发布 Definition 的业务修改产生新 Definition version。

### 13.4 State Inspector

```text
State label
stable state ID
description
assignee type
Principal / participant slot
terminal
start timeout
execution timeout
reminder interval
Outcome list
```

State Execution/Action/Executor 不放进 Definition Inspector。Instance 运行页对当前 assignee 提供单独的“配置我的执行方式”入口。

### 13.5 Definition 校验

- 唯一 initial State；
- 非 terminal State 必须有 assignee；
- participant slot 名称唯一；
- 非 terminal State 至少一个 Outcome；
- 同一 State Outcome ID 唯一；
- target State 存在；
- terminal 无 assignee、timeout 和 outgoing Outcome；
- timeout 数值合法；
- unreachable State 报错；
- 无可达 terminal 默认 warning，允许显式确认纯循环流程；
- layout 节点必须对应 Machine State，多余坐标忽略或清理。

## 14. v3 Git 目录

```text
group.json

members/
  {principal-id}/
    member.json
    clients/
      {client-id}.json
    executors/
      {executor-id}.json

permissions/
  {principal-id}.json

workspace/
  shared/
    data/
    documents/

  principals/
    {principal-id}/
      updates/
        {update-id}.json
      files/
        {file-id}/
          metadata.json
          {original-file-name.ext}
      automations/
        actions/
          {action-id}.json
        prompts/
          {prompt-id}.md

work-items/
  {work-item-id}/
    item.json
    updates/
      {update-id}.json

discussions/
  {thread-id}/
    thread.json
    messages/
      {message-id}.json

workflows/
  definitions/
    {definition-id}/
      workflow.json
      machine.json
      layout.json

  instances/
    {instance-id}/
      instance.json
      execution/
        {state-id}.json
      turns/
        {turn-id}.json

artifacts/
  work-items/
    {work-item-id}/
      {artifact-id}/
        metadata.json
        {original-file-name.ext}

  workflows/
    {instance-id}/
      {turn-id}/
        {artifact-id}/
          metadata.json
          {original-file-name.ext}

events/
  group/
  members/
    {principal-id}/
  workspace/
    {principal-id}/
  work-items/
    {work-item-id}/
  discussions/
    {thread-id}/
  workflow-definitions/
    {definition-id}/
  workflow-instances/
    {instance-id}/

projections/
  group.json
  members/
  work-items/
  discussions/
  workflow-definitions/
  workflow-instances/
```

### 14.1 目录调整

v3 删除或移动：

```text
machine.yaml                              -> workflows/definitions/{id}/machine.json
layout.yaml                               -> workflows/definitions/{id}/layout.json
groups/roles/                             -> 删除
groups/claims/                            -> 删除
groups/implementations/                   -> workflows/instances/{id}/execution/
actions/                                  -> workspace/principals/{principal}/automations/actions/
prompts/                                  -> workspace/principals/{principal}/automations/prompts/
artifacts/{turn}/                         -> artifacts/workflows/{instance}/{turn}/
```

`groups/members/` 调整为根级 `members/`，因为 Group 自身已经是仓库根上下文，不需要 `groups/groups` 式命名。

### 14.2 Materialization 原则

- 一个签名命令只物化该事件授权的精确路径；
- Work Item/Instance JSON 是当前 Projection，可从 event stream 重建；
- Progress Update 和 Message 使用唯一 ID 追加，不覆盖旧内容；
- Artifact 内容按 ID 分目录并保留原始文件名与格式，`metadata.json` 固定 `content_ref`、size/hash/uploader/ref；
- 所有结构化 materialization 只写 JSON；Prompt 和人类文档写 Markdown，不把 Markdown 中的描述当作权威状态；
- `projections/` 可删除后重建；
- 不提交全局 `activity.json`，避免每次评论争用同一文件；
- 全局 Activity Feed 在本地 SQLite 从多个 Aggregate stream 投影。

## 15. 路径授权

| 路径                                  | 合法写入者                          | 约束                               |
| ------------------------------------- | ----------------------------------- | ---------------------------------- |
| `group.json`                          | Owner/Admin                         | Group event 物化                   |
| `members/{principal}/member.json`     | 本人注册、Admin 状态管理            | Principal 与签名 fingerprint 一致  |
| `members/{principal}/clients/`        | 对应 Principal                      | Client ID 与事件一致               |
| `members/{principal}/executors/`      | 对应 Principal                      | 只允许公开 descriptor              |
| `permissions/{principal}.json`        | permission grant authority          | 禁止自我提权                       |
| `workspace/principals/{principal}/`   | 对应 Principal                      | actor path ownership               |
| `workspace/shared/`                   | `workspace:write_shared`            | revision、hash、size               |
| `work-items/{id}/`                    | Item creator/owner/Admin            | 字段级授权和 item revision         |
| `discussions/{id}/messages/{message}` | 消息作者追加                        | 修改使用 revision event            |
| `workflow-definitions/{id}`           | Designer/Publisher                  | publish grant、definition revision |
| `workflow-instances/{id}`             | Instance authority/current assignee | 生命周期、assignment、fence        |
| `execution/{state}.json`              | resolved assignee Principal         | state/principal 必须匹配           |
| Work Item Artifact                    | 授权 Item contributor               | metadata/hash/path 校验            |
| Turn Artifact                         | 当前 claimant Client                | instance/turn/attempt/fence 校验   |
| `projections/`                        | Runtime                             | 必须与合法事件归约一致             |

Git signer 是成员不代表可以修改任意成员空间、Work Item 或 Workflow 路径。Validator 必须按 event type、actor、Aggregate 和具体路径逐项校验。

## 16. 事件与并发模型

### 16.1 从全局 sequence 调整为 Aggregate stream

v2 所有事件共享 Group `sequence`。当 Progress、Message、Work Item 和多个 Workflow 同时写入时，这会制造无意义冲突。

v3 每个 Aggregate 使用独立 revision 和 previous event hash：

```text
events/work-items/wi_101/000008-evt_xxx.json
events/discussions/thread_12/000021-evt_xxx.json
events/workflow-instances/wfi_201/000014-evt_xxx.json
```

统一 Envelope：

```json
{
  "format": "icarus.collaboration-event/3",
  "protocol_version": 3,
  "group_id": "group_payment",
  "event_id": "evt_xxx",
  "aggregate_type": "work_item",
  "aggregate_id": "wi_101",
  "aggregate_revision": 8,
  "previous_event_hash": "sha256:...",
  "event_type": "work_item_progress_posted",
  "actor": {
    "principal_id": "principal_alice",
    "client_id": "client_macbook",
    "executor_id": "codex_primary"
  },
  "occurred_at": "2026-08-06T18:00:00.000Z",
  "causation_id": null,
  "correlation_id": "wi_101",
  "payload_hash": "sha256:...",
  "payload": {}
}
```

### 16.2 顺序和 CAS

- 同一 Aggregate 必须满足 expected revision 和 previous hash；
- 不同 Aggregate 可以独立生成 revision；
- control branch 继续要求 fast-forward 线性 Git ancestry；
- 并发 push 失败方 fetch/revalidate，只重建自己的 commit；
- 同一 Work Item 的冲突不能无脑自动重放字段覆盖；
- 不同 Work Item/Discussion 的追加事件可以在验证后自动重试；
- Git commit ancestry 提供 Group 级观察顺序，Aggregate hash chain 提供对象级完整性。

### 16.3 事件集合

Group/Membership：

```text
group_initialized
group_settings_updated
group_archived
group_reopened
membership_requested
member_registered
member_suspended
member_removed
client_registered
client_revoked
permission_granted
permission_revoked
```

Workspace/Work Item/Discussion：

```text
progress_update_posted
shared_file_published
shared_file_revised
work_item_created
work_item_details_updated
work_item_assignment_changed
work_item_assignment_acknowledged
work_item_status_changed
work_item_progress_posted
work_item_relation_changed
work_item_archived
discussion_created
message_posted
message_revised
message_tombstoned
discussion_resolved
```

Workflow：

```text
workflow_definition_proposed
workflow_definition_published
workflow_layout_updated
workflow_instance_created
workflow_instance_started
workflow_instance_paused
workflow_instance_resumed
workflow_instance_closed
workflow_state_assignee_changed
state_execution_published
state_execution_revised
state_execution_withdrawn
turn_created
turn_started
action_dispatched
action_waiting_input
action_waiting_approval
action_completed
turn_timeout_observed
turn_completed
turn_cancelled
turn_recovery_requested
turn_recovered
```

### 16.4 Clock 和审计

签名证明 Actor 声明了 `occurred_at`，不证明第三方可信绝对时间。各 Client 继续记录本地首次 `observed_at` 和 clock skew incident。时钟异常不改变 Work Item status、Workflow State 或 Outcome。

## 17. 客户端虚拟文件系统

### 17.1 友好映射

客户端不能把 raw Principal ID 和协议目录作为主要用户体验。它应将 verified Git Head 映射为：

```text
支付系统项目
├── 共享空间
│   ├── 项目说明.md
│   └── 接口文档
├── 成员空间
│   ├── Alice · a83f
│   │   ├── 进度更新
│   │   ├── 文件
│   │   └── 自动化产物
│   ├── Bob · 6b21
│   └── Carol · 93c0
├── Work Items
│   ├── WI-101 会员自动续费
│   └── WI-102 退款异常
├── 讨论
├── Workflows
└── 审计记录
```

底层仍使用：

```text
workspace/principals/principal_sha256_a83f.../
```

display name：

- 由 `member.json` 映射；
- 可以修改和重名；
- 重名时附短 Principal ID；
- 不能用于路径、授权、事件 Actor 或引用；
- 详情页可查看完整 Principal、签名 key ref 和验证状态。

### 17.2 文件能力

- 虚拟目录树和面包屑；
- 文本、Markdown、JSON、图片和小型产物预览；作为业务附件上传的 YAML 仍可按普通文本预览，但不解释为 v3 协议；
- Work Item/Discussion/Workflow 结构化业务视图；
- raw file 和 raw path 高级入口；
- 显示 uploader、时间、hash、size、media type 和业务 refs；
- 按 Principal、Work Item、Workflow、类型和时间筛选；
- 下载或用本地程序打开；
- 大文件显示外部 locator 和完整性 metadata。

受控 checkout 不作为普通可写文件夹暴露。所有上传、修改、评论和状态变化都经过 Host API、签名事件和路径授权。

### 17.3 同步

同时支持：

```text
自动同步：poll + jitter + backoff
手动同步：立即刷新
```

刷新流程：

```text
fetch remote
  -> verify Git ancestry and signatures
  -> validate Aggregate revisions and materialization
  -> incrementally reduce events
  -> update SQLite read models and file index
  -> atomically switch visible verified head
```

界面显示：

```text
last synchronized at
verified head
signature/integrity status
behind/retrying/quarantined state
manual refresh
```

如果新远端状态验证失败：

- 保留最后一个 verified snapshot；
- 新状态进入 quarantine；
- 不把未验证文件混入业务视图；
- 管理员可以修复远端后手动触发验证；
- 同一 incident 持久去重并指数退避。

### 17.4 Observer 同步

Observer 使用同一个只读 fetch/verify/project 流程，但：

- 不创建签名写入命令；
- 不显示成员操作按钮；
- 可以设置本地刷新频率；
- 可以订阅 Group 级公开活动提醒；
- 不能接收只面向某个 Member 的任务或 State 通知；
- 升级为 Member 后复用已验证本地 cache，不重复全量 clone。

## 18. 生命周期

### 18.1 Group

```text
ACTIVE
  -> ARCHIVED
ARCHIVED
  -> ACTIVE (reopen, explicit policy)
```

Group 不使用 `FORMING/READY/RUNNING`。Archive 后所有业务写入默认禁止，但仍可读取和导出审计。

### 18.2 Membership

```text
REQUESTED
  -> ACTIVE
  -> REJECTED

ACTIVE
  -> SUSPENDED
  -> REMOVED

SUSPENDED
  -> ACTIVE
  -> REMOVED
```

Removed Principal 的历史内容和 Actor 记录不删除；新业务写入拒绝。

### 18.3 Workflow Definition

```text
DRAFT
  -> PROPOSED
  -> PUBLISHED
  -> RETIRED
```

已发布版本不可原地覆盖。业务变更发布新 version；layout 更新独立，不改变 Machine hash。

### 18.4 Workflow Instance

```text
DRAFT
  -> READY
  -> RUNNING
  -> PAUSING
  -> PAUSED
  -> RUNNING
  -> CLOSING
  -> CLOSED
```

READY 条件：

- Definition version 和 hash 有效；
- 所有可执行 State 已解析到 ACTIVE Principal；
- scope 和可选 Work Item 有效；
- launch policy 满足；
- timeout 和 terminal 约束合法。

State Execution/Action/Executor 不是 READY 必需项，因为默认 manual/notify-only。

## 19. 通知

### 19.1 通知类型

Workspace/Work Item：

```text
mentioned
work_item_assigned
assignment_acknowledgement_required
work_item_blocked
dependency_resolved
due_soon
overdue
discussion_replied
```

Workflow：

```text
state_waiting_to_start
state_execution_timeout
action_waiting_input
action_waiting_approval
assignee_changed
workflow_recovery_required
```

### 19.2 投递

- 共享 Git 只记录需要审计的业务事实，不为每个桌面展示写事件；
- 每个 Client 本地 SQLite 保存 notification、recipient reason、delivery 和 reminder ordinal；
- 同一 Principal 的多个 Client 可以各自接收，当前 claim 后的执行提醒优先精确 claimant Client；
- Principal 同时是 Item owner、mentioned user 和 Admin 时，本机合并展示但保留全部 reason；
- Work Item due reminder 和 Workflow State timeout reminder 使用不同 dedupe key；
- App 重启后恢复未投递提醒，不产生通知风暴。

## 20. 审计

### 20.1 三层审计

1. **Git commit chain**：Group 全局观察顺序、commit signer 和 materialized files。
2. **Aggregate event chain**：对象 revision、previous hash、Actor 和 payload hash。
3. **Local evidence**：首次 observed time、Executor receipt/log hash、通知 delivery、sync attempt 和 integrity incident。

### 20.2 审计导出

JSON 导出至少包含：

- Group definition、Membership 和 Permission history；
- Principal/Client/optional Executor public identity；
- Work Item 全部字段、assignment、status、progress、relations 和 Artifact refs；
- Discussion message/revision/tombstone；
- Workflow Definition version、Machine/layout hash；
- Workflow Instance scope、assignment、State、Turn、Outcome、Handoff 和 timeout；
- 每条事件的 Aggregate revision、previous hash、commit hash 和签名结果；
- 缺号、断链、未知 signer、hash mismatch、clock skew、missing local evidence；
- raw UTC time 和可派生 duration。

默认导出只提供摘要、metadata 和 hash。Prompt、Handoff data、Discussion 内容、文件内容和 Executor log 使用独立 `include_content` 授权；凭据、本地绝对路径和 Provider secret 永不导出。

## 21. API 草案

除文件上传和下载外，所有 API 请求、响应和错误体使用 `application/json`。上传使用 `multipart/form-data`，其中 metadata part 是经过同一 JSON Schema 校验的 JSON，file part 保持业务文件原始格式；客户端不能通过 multipart 上传协议 materialization 文件。Host 根据认证 Principal 和 endpoint 补全系统派生字段，调用方不能覆盖 ID、Actor、hash 或 repository path。

### 21.1 Inspect、Observe 和 Join

```text
POST /api/collaboration/groups/inspect
POST /api/collaboration/subscriptions
DELETE /api/collaboration/subscriptions/{groupId}
POST /api/collaboration/groups/{groupId}/join-requests
POST /api/collaboration/groups/{groupId}/join-requests/{requestId}/approve
POST /api/collaboration/groups/{groupId}/join-requests/{requestId}/reject
```

Observer subscription 是本地记录，不写 Group Git。Join API 不接受调用方覆盖 `principal_id/client_id`，Host 从本机 Identity Service 解析。

### 21.2 Group、Members 和 Permissions

```text
POST /api/collaboration/groups
GET  /api/collaboration/groups/{groupId}
POST /api/collaboration/groups/{groupId}/sync
POST /api/collaboration/groups/{groupId}/archive

GET  /api/collaboration/groups/{groupId}/members
POST /api/collaboration/groups/{groupId}/clients
PUT  /api/collaboration/groups/{groupId}/permissions/{principalId}
```

### 21.3 Workspace 和 Files

```text
GET  /api/collaboration/groups/{groupId}/files
GET  /api/collaboration/groups/{groupId}/files/content
POST /api/collaboration/groups/{groupId}/workspace/shared/files
POST /api/collaboration/groups/{groupId}/workspace/me/updates
POST /api/collaboration/groups/{groupId}/workspace/me/files
```

客户端不能提交任意 repository path。Host 根据 endpoint、local Principal 和对象 ID 生成 canonical path。

### 21.4 Work Items 和 Discussions

```text
GET  /api/collaboration/groups/{groupId}/work-items
POST /api/collaboration/groups/{groupId}/work-items
GET  /api/collaboration/groups/{groupId}/work-items/{workItemId}
PATCH /api/collaboration/groups/{groupId}/work-items/{workItemId}
POST /api/collaboration/groups/{groupId}/work-items/{workItemId}/progress
POST /api/collaboration/groups/{groupId}/work-items/{workItemId}/status
POST /api/collaboration/groups/{groupId}/work-items/{workItemId}/relations

GET  /api/collaboration/groups/{groupId}/discussions
POST /api/collaboration/groups/{groupId}/discussions
POST /api/collaboration/groups/{groupId}/discussions/{threadId}/messages
POST /api/collaboration/groups/{groupId}/discussions/{threadId}/resolve
```

所有 mutation 接受对象级 `expectedRevision`，不使用一个 Group revision 阻塞无关对象。

### 21.5 Workflow

```text
GET  /api/collaboration/groups/{groupId}/workflow-definitions
POST /api/collaboration/groups/{groupId}/workflow-definitions
PUT  /api/collaboration/groups/{groupId}/workflow-definitions/{definitionId}/draft
POST /api/collaboration/groups/{groupId}/workflow-definitions/{definitionId}/publish
PUT  /api/collaboration/groups/{groupId}/workflow-definitions/{definitionId}/layout

GET  /api/collaboration/groups/{groupId}/workflow-instances
POST /api/collaboration/groups/{groupId}/workflow-instances
POST /api/collaboration/groups/{groupId}/workflow-instances/{instanceId}/commands
PUT  /api/collaboration/groups/{groupId}/workflow-instances/{instanceId}/states/{stateId}/execution

GET  /api/collaboration/groups/{groupId}/workflow-instances/{instanceId}/turns/current
POST /api/collaboration/groups/{groupId}/workflow-instances/{instanceId}/turns/{turnId}/start
POST /api/collaboration/groups/{groupId}/workflow-instances/{instanceId}/turns/{turnId}/artifacts
POST /api/collaboration/groups/{groupId}/workflow-instances/{instanceId}/turns/{turnId}/complete
POST /api/collaboration/groups/{groupId}/workflow-instances/{instanceId}/turns/{turnId}/recover
```

### 21.6 Audit

```text
GET /api/collaboration/groups/{groupId}/activity
GET /api/collaboration/groups/{groupId}/audit
GET /api/collaboration/groups/{groupId}/audit/export?format=json
```

## 22. 本地存储

建议 fresh schema 新增或调整：

```text
collaboration_subscriptions
collaboration_groups
collaboration_principals
collaboration_clients
collaboration_permission_grants

collaboration_aggregate_checkpoints
collaboration_event_cache
collaboration_file_index
collaboration_progress_updates

collaboration_work_items
collaboration_work_item_updates
collaboration_work_item_relations
collaboration_discussions
collaboration_messages

collaboration_workflow_definitions
collaboration_workflow_instances
collaboration_state_executions
collaboration_turns

collaboration_executor_bindings
collaboration_action_executions
collaboration_staged_artifacts
collaboration_notifications
collaboration_timeout_schedules

collaboration_sync_attempts
collaboration_integrity_incidents
collaboration_local_audit_evidence
```

关键边界：

- subscription、Client private state、Executor Binding、receipt、staged upload、notification 和 local evidence 不能依赖 Git 重建；
- Group/Member/Work Item/Discussion/Workflow Projection 和 file index 可以从 verified Git 重建；
- 每个 Aggregate checkpoint 保存 last revision/hash/commit；
- global activity feed 是 SQLite read model，不回写一个全局 Git 文件；
- SQLite transaction 与 visible verified head 原子切换；
- 由于没有存量 Group，直接创建最新 current schema；任何旧 collaboration store fail closed，不实现 migration chain，由开发者显式重建本地数据库和 current fixture。

## 23. Web 工作台

### 23.1 一级结构

```text
/groups
/groups/{groupId}/overview
/groups/{groupId}/activity
/groups/{groupId}/work-items
/groups/{groupId}/discussions
/groups/{groupId}/files
/groups/{groupId}/workflows
/groups/{groupId}/members
/groups/{groupId}/audit
/groups/{groupId}/settings
/groups/{groupId}/diagnostics
```

### 23.2 Group 创建

Group 创建表单只配置：

```text
name
Git remote
signing key
membership policy
visibility hint
poll interval
```

不再要求 Role、initial Role、Machine 或 State。创建成功直接进入 Overview，并提供：

```text
发布第一条进度
创建 Work Item
新建 Workflow Definition
邀请成员
上传共享文件
```

### 23.3 Overview

- Group 状态和 verified sync；
- Principal 最新进度；
- OPEN/IN_PROGRESS/BLOCKED Work Item；
- overdue 和长期无更新项；
- 活动 Workflow Instance；
- waiting input/approval/timeout；
- 最近 Discussion 和 mention；
- 最近共享文件；
- 当前 Observer/Member 本地模式。

### 23.4 Work Item 页面

- Board：Proposed、Open、In Progress、Blocked、Done；
- List：按 owner、type、priority、label、due date 和 Workflow 筛选；
- My Work：我负责、我参与、提到我、待确认、即将到期；
- Detail：目标、验收、owner、contributors、relations、progress、Discussion、Artifact 和 Workflow；
- 创建/指派/状态变化均显示预期权限和 revision；
- Workflow 绑定时清晰展示状态来源，禁止双重写入。

### 23.5 Workflows 页面

- Definition 列表、版本、发布者和 launch policy；
- Outcome-first 图形化 Definition Editor；
- Principal/participant lane；
- 从 Definition 创建 Work Item scope 或 Group scope Instance；
- Instance 列表各自显示 lifecycle、business state、assignee 和 active Turn；
- Runtime 图展示当前/历史路径、deadline、timeout 和 terminal；
- 当前 assignee 独立配置自己的 manual/assisted/automatic execution。

### 23.6 Observer UI

Observer 使用相同浏览和验证界面，但：

- 顶部明确显示“只读观察”；
- 不渲染 mutation 控件；
- 提供“申请加入”入口；
- 显示 Git read visibility 警告；
- 本地刷新、文件预览和审计仍完整可用。

## 24. 安全边界

### 24.1 身份与授权

- Principal 必须由 signing public key fingerprint 派生；
- Client 必须由 Principal 签名注册；
- Executor descriptor 不授予权限；
- 所有 mutation 在 Host 和 Git replay 两个边界都验证权限；
- 不能依赖 UI 隐藏按钮；
- permission grant 禁止普通 Admin 自我升级为 Owner 或 grant authority；
- removed/suspended Principal 的新事件拒绝。

### 24.2 路径与内容

- canonical relative path；
- 禁止 `..`、反斜杠、空 segment、绝对路径和符号链接；
- JSON 解析拒绝重复 Key、非法数字、未知 format 和 Schema 不匹配；
- JSON materialization 与 JCS canonical bytes 必须解析为同一对象，hash/signature 只基于 canonical bytes；
- Principal path 与 Actor 精确匹配；
- file size、hash、media type 和 regular file mode 校验；
- Artifact immutable，修订产生新 version/ref；
- Prompt、Handoff、Message 和共享文件均作为不可信内容处理；
- Executor 不得因为读取 Group 内容获得系统指令权限。

### 24.3 Git Remote

- read ACL 决定保密边界；
- write ACL 不替代协议授权；
- control branch 保持 fast-forward 和签名验证；
- direct manual push 若不能解释为合法 event/materialization，进入 quarantine；
- 不在产品代码主分支混入 Group control event；
- 本地 uncommitted file、其他 branch 和 working tree 不构成协议事实。

## 25. 实施阶段

### Phase 0：冻结 v3 Contract

- 将本文档作为唯一 v3 产品/协议目标；
- 冻结 Group、Identity、Aggregate Event、Work Item、Workflow Definition/Instance schema；
- 冻结 JSON Schema registry、`format` 版本规则、pretty materialization 和 RFC 8785 canonical hash 规则；
- 建立 JSON 协议、Markdown Prompt 和原格式业务文件 + JSON sidecar 的 fixture；v3 不生成或回放 YAML 协议；
- 明确开发期 latest-only：v2 及后续被替代迭代均无迁移、无双写、无兼容读取、无旧回放；
- 删除旧 parser/reducer/API/materializer/schema/fixture 和兼容测试，只保留最新目标实现；
- 非 current 协议、Git fixture 和 SQLite schema fail closed，提供显式开发环境 reset/reinitialize 流程；
- 建立 fresh v3 fixture 和临时 Git remote 测试基线；
- 实施时只把 v2 测试作为行为参考；当前测试和 API 不保留 v2 兼容路径。

### Phase 1：Group Container 和 Identity

- Group schema 移除 machine/required roles；
- Group lifecycle 改为 ACTIVE/ARCHIVED；
- Membership 改为 Principal 主体，拆分 Client 和 optional Executor descriptor；
- 删除 Role/Claim schema、事件、Projection 和 UI；
- 增加 direct permission grants；
- 增加 Observer local subscription、Inspect 和 Join policy；
- SQLite fresh schema 升级并 fail closed。

### Phase 2：Aggregate Event 和 Workspace

- 事件从全局 sequence 调整为 Aggregate revision/hash chain；
- Git transport 支持 per-Aggregate checkpoint 和增量重放；
- 增加 Shared Space、Principal Space、Progress Update 和 path authorization；
- 增加虚拟文件索引、友好 Principal 映射、手动/自动刷新；
- Observer 使用相同只读 verified projection。

### Phase 3：Work Item 和 Discussion

- 实现 Work Item schema、状态、assignment、progress、relation 和 due reminder；
- 实现 Board/List/My Work/Detail；
- 实现 Discussion、Message、mention 和 tombstone；
- 增加 Artifact scope 和 Activity Feed；
- 增加 Agent-created PROPOSED policy。

### Phase 4：Workflow Definition 和 Instance

- 将根 Machine/Layout 下沉到 Definition；
- 将 Group 生命周期和业务 State 拆成每个 Instance 独立 Projection；
- 增加 Group/Work Item scope；
- 增加 participant slot、direct Principal assignment 和 resolved assignment；
- 增加 Definition version、launch policy 和 Work Item terminal mapping；
- 保留现有 Turn/Handoff/timeout/audit 语义。

### Phase 5：图形化编辑器适配

- 移除 Group creation Role/FSM 必填；
- 图编辑器移动到 Workflows 页面；
- owner Role 改为 Principal/participant slot；
- 角色泳道改为参与人泳道；
- 保留 Outcome-first、自环、汇合、terminal、layout isolation、undo/redo 和验证；
- Runtime 图按 Instance 展示。

### Phase 6：Principal Execution 和 Executor

- Role-owned Implementation 改为 Principal-owned State Execution；
- 无配置默认 manual/notify-only；
- Action/Prompt 移到 Principal automation library；
- claimant agent 改为 claimant Client + optional Executor；
- Binding 保持本地，Turn snapshot/fencing/receipt 继续 fail closed；
- 多 Client claim、stale callback 和 reassignment 覆盖完整并发测试。

### Phase 7：审计、诊断和文档收敛

- 聚合 Group/Aggregate/local evidence 审计；
- 更新 JSON export 和严格脱敏；
- 完成 quarantine、backup/restore、sync metrics 和 UI diagnostics；
- 更新 README、TECHNOLOGY 和 Runtime 文档；
- 将 v2 文档标为历史实现基线；
- 删除所有未使用 v2 Role/Claim/API/UI 代码和 fixture。

## 26. 测试矩阵

### 26.1 Identity、Join 和 Observer

- 同一 signing key 在多个 Group 派生同一 Principal；
- 同一 Principal 可以注册多个 Client；
- 不配置 Executor 仍可加入和人工协作；
- API 不能覆盖 Principal/Client ID；
- Observer 不写 members/event，不需要 signing identity；
- Observer 升级 Member 复用 cache；
- open/approval/invite-only 分别通过正反例；
- Git read ACL 与协议 Membership 在诊断中明确区分。

### 26.2 Permission 和路径

- Principal 只能写自己的 space/automation；
- 普通成员不能修改 permission grant；
- Admin 不能越权自我升级；
- suspended/removed Principal 的新事件拒绝；
- Work Item owner/Admin 字段级权限正确；
- Discussion author revision/tombstone 权限正确；
- path traversal、symlink、hash/size mismatch 和越权 materialization quarantine。

### 26.3 Aggregate Event

- 每个 Aggregate revision/hash 确定；
- 所有权威结构化文件都是通过对应 JSON Schema 的 JSON；
- 重复 Key、未知字段、非法数字、未知 format 和 YAML 协议输入 fail closed；
- current protocol version 可完整创建和回放，任意旧/未来版本均 fail closed；
- 测试矩阵中不存在要求旧版本继续成功运行的兼容用例；
- 同一 JSON 对象采用不同字段顺序、缩进和换行时得到相同 JCS hash；
- 业务字段发生变化时 canonical hash 必须变化；
- 同 Aggregate stale revision 拒绝；
- 不同 Work Item 并发可以安全重试；
- Git non-fast-forward、非线性 ancestry 和 tamper 被检测；
- checkpoint 损坏可从 genesis 重建；
- 全局 Activity Feed 不要求共享全局 revision；
- canonical serialization 不依赖 locale。

### 26.4 Workspace 和文件浏览

- Principal ID 正确映射 display name，重名带短 ID；
- display name 变化不修改 raw path/ref；
- 文件树只基于一个 verified head；
- 验证失败继续展示最后可信 snapshot；
- manual/automatic refresh 结果一致；
- Observer 和 Member 读视图一致，写控件与 Host 权限不同；
- raw file、structured view 和 external artifact metadata 正确。
- 业务文件保留原始格式和安全文件名，sidecar 的 content ref、size、media type 或 hash 不匹配时 quarantine；
- Markdown Prompt 可独立预览和比较，Action JSON 引用与 prompt hash 必须匹配；
- Markdown front matter 或正文不能覆盖 Action、权限、Workflow 和其他权威 JSON 字段。

### 26.5 Work Item

- Group 可创建多个并行 Work Item；
- PROPOSED/OPEN/IN_PROGRESS/BLOCKED/DONE/CANCELLED 转移正确；
- Agent 默认创建 PROPOSED；
- owner 绑定 Principal，不因 Client/Executor 更换改变；
- assignment acknowledgement、reassignment 和权限正确；
- progress append-only，Projection 可重建；
- parent/dependency/related 引用校验；
- due reminder 与 Workflow timeout 去重键不同；
- DONE/reopen 保留完整审计。

### 26.6 Discussion

- thread scope 可以引用 Group、Work Item、Workflow/Turn；
- message append、revision、tombstone 和 resolve/reopen 正确；
- mention 通知持久去重；
- 消息内容不进入系统 Prompt 高权限槽位；
- 并发不同 thread 不争用同一业务 revision。

### 26.7 Workflow Definition

- Group 可以没有 Definition；
- Group 可以拥有多个 Definition 和 version；
- direct Principal 和 participant slot 校验正确；
- slot 未解析时 Instance 不 READY；
- Outcome/self-loop/merge/multiple terminal 正确；
- layout 更新不改变 Machine hash/version；
- Definition publish grant 和 launch policy 正确；
- Executor 技术失败不映射业务 Outcome。

### 26.8 Workflow Instance

- Work Item scope 和 Group scope 均可运行；
- 一个 Work Item 同时最多一个 primary active Instance；
- 不绑定 Work Item 时不更新任何 Work Item status；
- terminal mapping 原子更新绑定 Work Item；
- 每个 Instance 有独立 State、Turn、deadline、epoch/revision；
- 多个 Instance 并发不共享 activeTurnId；
- 当前 State reassignment 需要 cancel/recover；
- 历史 assignment 和 Turn Actor 永久保留。

### 26.9 Execution、Timeout 和 Audit

- 无 Execution 配置默认 manual/notify-only；
- 只有 assignee Principal 可配置 State Execution；
- 多 Client claim 只有一个 CAS winner；
- assisted/automatic 需要 Principal-owned Action 和 local Binding；
- stale Client/attempt/fence/callback 拒绝；
- start/execution timeout 提醒 assignee 和 Instance creator，不自动流转；
- Work Item due 不触发 Turn timeout event；
- Audit 能串联 Group、Work Item、Workflow、Turn 和 local evidence；
- 默认导出严格脱敏本地路径、凭据和 Provider metadata。

### 26.10 UI

- Group 创建不出现 Role/Machine 必填；
- 创建后立即发布进度、Work Item 和文件；
- Observer 明确只读且可以申请加入；
- Work Item Board/List/Detail 在桌面和窄窗口无重叠；
- 图编辑器 Outcome-first 全路径可用；
- Principal/participant lane 正确；
- 不使用拖拽也能完成所有 Workflow 编辑；
- 多 Instance Runtime 图正确选择 scope；
- 虚拟文件树 display mapping、刷新和验证状态清晰；
- 错误定位到具体 Aggregate/State/Outcome/path。

## 27. 验收标准

- 用户可以创建没有 Role、Machine 和 Workflow 的 Group，并立即进入 ACTIVE。
- Observer 可以只读订阅、定时/手动刷新、验签和浏览全部 Git 可见内容，但不会出现在成员列表或产生写事件。
- 正式加入只注册系统派生 Principal；一个 Principal 可以使用多个 Client，也可以不配置 Executor。
- 客户端将 Principal ID、Work Item ID 和 Workflow ID 映射为友好项目树，同时保留稳定 raw identity。
- 每个 Principal 可以在自己的 Group-visible space 发布进度和文件，不能修改其他 Principal 空间。
- Group 可以创建和并行管理多个 Work Item，支持负责人、进度、阻塞、依赖、Discussion、due date 和 Artifact。
- Group 可以没有 Workflow，也可以同时运行多个互相独立的 Workflow Instance。
- Workflow Instance 可以绑定一个 primary Work Item，也可以使用 Group scope；两种模式共享 Turn、timeout 和 audit 能力。
- 删除 Group Role/Claim；Workflow State 在 Instance 中最终绑定一个 Principal。
- 可复用 Definition 使用 participant slot，但 slot 不承担权限、认领和人数语义。
- State assignee 未配置 Action/Executor 时仍能 manual/notify-only 执行。
- State assignee 可以只修改自己的 Execution，并可选择本地 Client/Executor；Turn 快照和 fence 保证多实例不重复执行。
- 当前 Outcome-first 图编辑器完整迁移到 Workflow Definition，并保持 layout 与业务 hash 隔离。
- Work Item status 与 Workflow State/timeout 没有双重来源或错误映射。
- 每个 Aggregate 独立 revision/hash chain，跨 Work Item/Discussion/Workflow 的并发不会争用一个 Group sequence。
- 所有共享写入保留 Git 签名、path authorization、hash、CAS 和可重建 Projection。
- 所有 v3 机器协议、API payload 和结构化事实使用 Schema 校验后的 JSON；系统不生成 YAML 权威文件。
- 人类文档和 Prompt 使用 Markdown，业务文件保持自身格式并由 JSON sidecar 固定引用和完整性信息。
- 开发期只运行最新协议、schema、API、Git fixture 和 SQLite schema；旧版本不会被迁移、兼容读取、双写或回放。
- 创建首个真实群组或不可丢弃签名历史前必须显式结束 latest-only 阶段并制定正式兼容策略。
- 审计导出可以从 Group 创建追溯到 Principal 更新、Work Item、Discussion、Workflow State、Turn、Outcome、Artifact 和本地证据。
- v3 交付后不存在仍可运行的 v2 Role/Claim 双模型或旧群组迁移路径。

## 28. 最终决策摘要

| 主题                    | 决策                                              |
| ----------------------- | ------------------------------------------------- |
| Group 定位              | 公共项目协作容器                                  |
| Group 是否需要 Workflow | 否，零到多个                                      |
| Group 生命周期          | ACTIVE/ARCHIVED                                   |
| 成员主体                | Principal                                         |
| Principal 来源          | SSH signing key fingerprint                       |
| Client                  | Principal 的 Icarus 安装，可多个                  |
| Executor                | Principal 的可选执行工具，可为零                  |
| Observer                | 本地只读订阅，不注册 Membership                   |
| Group Role/Claim        | 删除                                              |
| 群组权限                | 直接 grant 到 Principal                           |
| 个人空间                | Group-visible、Principal-owned                    |
| Work Item               | 群组内任务/问题等管理对象，可多个                 |
| Work Item owner         | Principal                                         |
| Workflow Definition     | 可复用 State/Outcome/assignment 模板              |
| Workflow Instance       | Definition 的一次独立运行                         |
| Work Item 与 Instance   | 可选绑定，最多一个 primary active Instance        |
| Group 级 Workflow       | 合法，不需要伪造 Work Item                        |
| State 责任人            | Instance 中 resolved Principal                    |
| 可复用人员抽象          | participant slot，不是 Role                       |
| 默认执行                | manual/notify-only                                |
| Action/Prompt 所有者    | State assignee Principal                          |
| Executor Binding        | 本地保存，不写凭据和路径到 Git                    |
| 图形化编辑              | Outcome-first，复用现有实现                       |
| 图布局                  | Definition-scoped，排除 Machine hash/version      |
| 事件并发                | per-Aggregate revision/hash + linear Git ancestry |
| 文件体验                | verified virtual tree + friendly identity mapping |
| 刷新                    | 定时增量同步 + 手动立即刷新                       |
| 保密边界                | Git Remote read ACL，不是客户端 Membership        |
| Work Item due           | 业务日期，独立于 State timeout                    |
| State timeout           | notify-only，不自动改变 Outcome/Work Item         |
| 审计                    | Git chain + Aggregate chain + local evidence      |
| 机器协议与 API          | 版本化 JSON Schema + JSON                         |
| JSON hash               | RFC 8785 JCS；与 pretty materialization 分离      |
| 人类文档与 Prompt       | Markdown；权威 metadata/ref/hash 在 JSON          |
| 业务文件                | 保持原格式；JSON sidecar 固定引用与完整性         |
| YAML                    | 不作为 v3 权威格式；仅可选导入并立即转换          |
| 开发期版本策略          | latest-only；每次迭代的新版本立即成为唯一 current |
| 旧版本处理              | fail closed；不迁移、不双写、不兼容读取或回放     |
| 兼容冻结点              | 首个真实群组/不可丢弃签名历史产生之前             |

该模型将当前“一个群组等于一个 FSM”扩展为“一个群组承载完整项目协作，Work Item 管理要做的事，Workflow 可选地管理怎么推进，Principal 决定自己如何执行”。它保留了现有 v2 已验证的 Git 签名、Turn、Executor、超时、审计和图编辑器能力，同时解除 Role、单 Machine 和单 active Turn 对项目空间的结构性限制。
