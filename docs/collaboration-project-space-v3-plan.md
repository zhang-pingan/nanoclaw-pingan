# Icarus 协作群组项目空间 v3 方案

## 文档状态

- 状态：Implemented（current-only）
- 日期：2026-08-08
- 实施完成：2026-08-08
- 当前协议：`icarus.collaboration-group/3`
- 实施前代码基线：`main@3eff5302`（历史）
- 当前实现：Collaboration Project Space v3、SQLite v11
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
13. Principal 是 Group 内系统生成的 `principal_<uuid>`，不由 Git SSH key 或 Credential fingerprint 派生；每个安装持久化一个 `client_<uuid>`。
14. 每个 Client 自动生成独立的 Icarus event-signing Credential。公钥和系统校验的 fingerprint 进入共享投影，私钥只留在本机安全目录；轮换或撤销 Credential 不改变 Principal。
15. Git Remote 账号/SSH 仅控制 clone、fetch、push；Icarus Group Permission 由 Host API、签名验证和 Reducer 决定。拥有 Git push 权限不等于拥有业务写权限。
16. 新设备先以 Observer 同步，然后通过 Git Remote 提交严格受限的身份恢复请求。旧 Client、Owner 或 offline Group recovery Credential 批准后，才原子绑定新 Client/Credential 并升级为 Member。
17. Active Member 只表示成员身份有效，不自动获得业务写权限。Host 根据有效 Member/Client/Credential、直接权限、资源 owner/contributor、Work Item 指派和 Workflow 当前负责人投影 `allowedActions`；Reducer 在每次提交时使用同一授权语义重新校验。
18. 固定权限模板只负责生成直接权限集合，权限事件仍是可签名、可回放的事实来源。模板 ID/version 是稳定机器合同，Renderer 不接受或生成未知 permission/template ID。
19. `group_id` 是稳定业务身份；Git Remote URL 仅是 locator。同一 remote 可以迁移，多个 locator 也可以指向同一 `group_id`，本地重新发现时按远端投影中的 `group_id` 恢复原绑定。
20. Archive、Dissolve、Leave 和本机移除是四种独立语义；远端终态事件必须先成功，之后才能隐藏并清理本地群组。

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
  -> per-Client event Credentials
  -> Local Executors (zero or more)

Work Item
  -> optional primary Workflow Instance

Workflow Instance State
  -> resolved Principal
  -> manual by default
  -> optional Principal-owned Action
  -> optional local Executor Binding
```

### 权限与 allowed actions

授权关系按以下顺序解释：

1. `Member.status=active`、active Client 和 active event-signing Credential 是业务写入的身份前置条件，不是业务权限本身。
2. Owner 拥有内置管理能力；其他成员的 `permission_granted` / `permission_revoked` 事件形成直接权限事实，`group:admin` 扩展为内置管理能力。
3. 固定模板 `member.v1`、`contributor.v1`、`project_manager.v1`、`workflow_manager.v1`、`group_manager.v1` 只生成一组已知 permission；投影通过集合精确匹配解释“来源模板”或“自定义差异”，不把模板当作第二套授权事实。
4. Group 概览 action 与资源 action 分开投影。例如 `createWorkItem` 需要 `work_item:create`，而 `workItems[id].editDetails/changeAssignment/changeRelations/archive/changeStatus` 分别表达当前资源和目标状态的能力；Discussion 消息、Workflow Definition layout/retire、owned Action revise、own Executor revoke，以及 Workflow Instance start/pause/resume/close/withdraw execution 同样使用对应资源 action，不能回退到 Active Member 判断。
5. Web API 返回当前本机 Principal 的 `allowedActions`，Renderer 据此隐藏不适用入口。资源状态也是 decision 的一部分，例如 draft Workflow Instance 的 `start` 返回 `RESOURCE_STATE_BLOCKED`，只提供补齐参与者。同步后权限或状态可能变化，因此 command/API/Reducer 仍在提交时重新校验，并以稳定错误码拒绝过期操作。
6. 归档 Group 的普通业务 decision 继续返回 `GROUP_ARCHIVED`；`reopen` 是显式生命周期例外，但仍要求 Active Member、Active Client、Active Credential 和 `group:archive`。Renderer 只在该 decision 允许时提供恢复入口。
7. Workflow Instance 将 `reassignStates[stateId]` 和 `turns[turnId].cancel` 分别投影。活动 Turn 所在的当前 State 不可重分配；多个 State 变更以一个有序事件 batch、一次 Git commit 和一次 CAS push 原子提交。有活动 Turn 时 Instance 不可 close，必须由 claimant 或 Instance authority 先取消 Turn。

群组保存 `default_permission_template_id`。开放加入与审批/邀请批准都在一次远端 CAS 和一个签名 Git commit 中追加有序的 `member_registered` 与 `permission_granted` / `permission_revoked` 事件；batch manifest 固定事件顺序，replay 对每条事件逐一校验 commit signer 与 actor/Credential，并分别记录审计。任一事件构建、提交或 push 失败都不会留下 Active 无权限成员。审批人可在提交前选择模板或自定义集合；修改默认模板只影响以后加入或批准的成员，不改写既有 permission history。

## 0. 实施结果

v3 已按本文的 current-only 边界端到端落地：

- Git 控制分支只接受 v3 Group/Event/Projection 和 JSON materialization，按 canonical JSON hash、active Credential signature、Credential/Principal/Client actor mapping、aggregate revision、previous hash、commit order、路径、sidecar 和文件 hash/size 完整校验；
- 本地 SQLite v11 保存 retained Group binding、Observer/Member subscription、Principal/Client/Credential、身份恢复请求、直接权限、投影、file index、精确 Action revision/commit 索引、本机 Executor profile、State Executor Binding、execution receipt/observation、notification、analysis、audit evidence、staged Artifact 和临时初始化恢复记录，非 v11 store 启动时 fail closed；
- Group、Credential rotation/revocation、Client revocation、identity/owner/offline recovery、Workspace、Work Item、Discussion、Workflow Definition/Instance、State Execution、Turn、timeout、Artifact、审计、备份/恢复和 verified virtual file tree 已进入 service 与 Web API；
- Work Item progress 与 Turn completion 通过 staged upload 在一个签名事件和 Git commit 中物化原始业务文件及 `metadata.json`，同时验证 scope、Principal/Client、attempt 和 fence；`/3` 备份联合保护 DB 与尚未提交的 staged bytes；
- Web/Electron `/groups` 已提供项目空间页面、Observer 受限申请状态、Work Item board/list、Discussion、文件树、Principal/Client/Credential/权限、恢复请求审批、Git Remote SSH 设置、offline recovery Credential 备份/导入、Workflow Definition/Instance、Outcome-first 编辑器、Turn、Artifact、审计和诊断；
- v2 Role/Claim、Group-level Machine/active Turn、YAML machine/layout、旧 API、旧 store、兼容 reducer、迁移、双写和旧事件回放均已从当前实现与正向测试删除。

## 1. 实施前代码基线（历史）

### 1.1 已实现能力

截至 `main@3eff5302`，当前 Collaboration Runtime 已完成：

- 系统派生 Principal 和本机持久 Agent ID；
- Git SSH key 同时承担 transport 与事件签名的旧耦合、严格线性回放、revision/CAS、增量验证、quarantine 和恢复；
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
| 历史 SQLite v4 store 和本地 evidence                  | `src/collaboration/store.ts`                    |
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

### 3.1 Principal 是 Group 内的稳定业务身份

`principal_id` 由 Host 生成，格式为 `principal_<uuid>`：

- Principal 的稳定范围是 Group；创建 Group 时生成 Owner Principal，新成员首次加入时生成该 Group 内的新 Principal；
- Git Remote 账号、SSH key、Credential 公钥和 fingerprint 都不是 Principal ID；
- 更换设备或轮换 Credential 保持同一 Principal；身份恢复只能选择 verified Projection 中已存在的 Principal；
- display name 可以改变和重名，UI 必须同时显示稳定短 ID，且 display name 不能用于路径、权限、Actor 或恢复授权；
- Group Membership、Work Item ownership、Workflow State assignment 和权限 grant 都绑定 Principal。

### 3.2 Client 与 Executor 分离

v2 的 `agent_id` 同时接近“本机 Icarus 安装”和“执行 Agent”两个语义。v3 明确拆分：

| 概念       | 含义                                        | 是否进入共享 Git                                 |
| ---------- | ------------------------------------------- | ------------------------------------------------ |
| Principal  | Group 内稳定成员和权限主体                  | 是                                               |
| Client     | 持久 `client_<uuid>` 标识的 Icarus 安装实例 | 公开描述进入，私有配置不进入                     |
| Credential | Client 的 Icarus event-signing 验证材料     | ID、绑定、公钥、fingerprint、purpose/status 进入 |
| Executor   | Codex、Workflow、Run-once 等可选执行工具    | 仅可选公开 descriptor 进入，Binding/凭据留本地   |

一个 Principal 可以：

- 有多个 Client；
- 每个 Client 有一个或多个可轮换 Credential；
- 有零个 Executor，只进行人工协作；
- 有多个 Executor，并按 Workflow State 选择；
- 在不同 Client 上接收通知，但一个 Turn attempt 只能由一个 Client claim。

Client ID 由安装级 Identity Service 生成并持久化，不由用户填写。Credential 使用系统生成的 `credential_<uuid>`；私钥文件存放在本机安全目录并使用仅当前用户可访问的权限，绝不写入 Git、审计导出或 API 响应。共享 Credential 的 fingerprint 必须由 Host 从公钥重新计算并校验，不能接受调用方声明值。

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
  "principal_id": "principal_2d9023b8-73e3-41bf-bb96-d52c0cb15bb3",
  "display_name": "Alice",
  "status": "active",
  "joined_at_event": "evt_xxx"
}
```

Client 单独注册：

```json
{
  "format": "icarus.collaboration-client/1",
  "principal_id": "principal_2d9023b8-73e3-41bf-bb96-d52c0cb15bb3",
  "client_id": "client_c27e7db4-6e5a-4d61-8109-3487dcec56f0",
  "display_name": "Alice MacBook",
  "capabilities": [],
  "status": "active",
  "registered_at_event": "evt_xxx"
}
```

每个 Client 使用独立 Credential 签署 Icarus control commit：

```json
{
  "format": "icarus.collaboration-credential/1",
  "credential_id": "credential_e5680d84-bba6-4bba-b244-cbdd914ac77b",
  "principal_id": "principal_2d9023b8-73e3-41bf-bb96-d52c0cb15bb3",
  "client_id": "client_c27e7db4-6e5a-4d61-8109-3487dcec56f0",
  "public_key": "ssh-ed25519 AAAA...",
  "fingerprint": "SHA256:...",
  "purpose": "event_signing",
  "status": "active",
  "created_at_event": "evt_xxx",
  "revoked_at_event": null
}
```

Client ID 是本机 Icarus 安装标识，不由用户填写。Credential ID 和 Ed25519 keypair 也由 Host 生成；fingerprint 必须从 `public_key` 计算并校验。Client 的本地路径、Credential 私钥、通知系统句柄、Provider 配置和 token 不得进入 Git、API 响应或审计导出。

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
- 默认不拥有 Principal、Client 或 Credential 绑定；
- 不能写 Work Item、Workflow、Discussion、Permission、Workspace 等业务事件；
- 可以 fetch、验签、增量归约、浏览文件和审计；
- 可以设置本地自动刷新和只读通知；
- 即使 Git 账号有 push 权限，也只允许发布 schema 严格限定的新成员请求、身份恢复请求和请求取消；
- 请求批准并同步后可以原地升级为正式 Member。

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

- `open`：Host 生成新 Principal/Client/Credential，候选 Credential 自签注册，Reducer 原子建立绑定；
- `approval`：候选提交申请，Owner/Admin 签名批准；
- `invite_only`：申请必须引用有效一次性 Invite，随后仍进入 requested 状态等待批准；
- transport 写权限与协议 Membership 是两层独立授权。

Invite 是独立 Aggregate 和经 Schema 校验的 JSON 对象，不使用可转发 bearer token：

```json
{
  "format": "icarus.collaboration-invite/1",
  "invite_id": "invite_uuid",
  "issued_by_principal_id": "principal_owner_uuid",
  "status": "active",
  "issued_at": "2026-08-06T12:00:00.000Z",
  "expires_at": null,
  "used_at_event": null,
  "revoked_at_event": null
}
```

- 只有 Owner、`group:admin` 或 `member:approve` Principal 可以签发和撤销；
- 新成员 Invite 不包含 Principal 字段，因为 Principal 只能由加入方 Host 在提交请求时生成；已有 Principal 的新设备必须使用身份恢复；
- `membership_requested` 必须由请求中携带的新 Credential 自签并引用 `invite_id`，同一事件原子注册 requested Member、Client、Credential 并把 Invite 变为 USED；
- requested Principal 的 Client 可以同步和处理自己的申请，但在 `member_registered` 批准前仍不能写任何其他业务事件；
- 已过期、已撤销、已使用、目标不匹配或不存在的 Invite fail closed；
- Invite 只能在 ACTIVE 时撤销，不能撤销 USED Invite，也不能复用；
- `approval` request 的 `invite_id` 固定为 `null`，`open` 注册不携带该字段。

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

`members_only` 必须由 Git 服务 read ACL 配合实现；已经 clone 的内容无法远程收回。Credential 公钥/fingerprint/status 是必要的共享验证材料；Git transport key、任何私钥/token、私有 Prompt override、本地绝对路径和完整 Agent transcript 都不得写入 Group Git。

### 5.5 多设备身份恢复

新设备先 Observe 并从 verified Member 列表选择原 Principal；名称重名时必须显示稳定短 ID。Host 为当前安装生成新的 event Credential，然后通过 Git Remote 提交 `identity_recovery_requested` 或 `owner_recovery_requested`。请求包含新 Client/Credential 的公开材料、创建/过期时间和按不可变字段计算的 `request_hash`，状态机固定为：

```text
pending -> approved | rejected | expired | cancelled
```

- pending 请求不注册新 Client/Credential，也不授予任何业务权限；只有请求 Credential 可以取消自己的 pending 请求；
- `recovery_expired` 只能由 identity recovery 的目标 Principal 或 owner recovery 的 Group Owner 在本地时钟到达固定 `expires_at` 后签署；普通 Member 不能通过 future-dated event 提前终结他人的请求；
- request hash 派生六位短验证码，新旧设备展示同一值；验证码只用于防止批准错请求，不证明现实身份；
- `identity_recovery` 由目标 Principal 的现有 active Client/Credential 批准或拒绝，批准者必须属于同一 Principal；
- `owner_recovery` 要求申请原因，由 Group Owner 在完成线下核实后填写必填决策原因；批准默认撤销目标 Principal 的全部旧 event Credentials，也可显式选择撤销范围；
- 批准事件原子添加新 Client/Credential并终结请求，CAS、request hash 和 pending 状态保证只能终结一次；新设备下一次 verified replay 后由 Observer 升级为该 Principal 的 Member Client；
- Group genesis 自动生成 purpose 为 `group_recovery` 的 offline Credential。私钥只在 Owner 本机保存，可显式安全导出/导入；它只能批准 Owner recovery，不能替代普通业务 Credential；
- offline Credential 导出使用完整三件套的排他发布，任一目标文件或 symlink 已存在时拒绝且不覆盖，发布中途失败会回滚本次已创建的目标；
- Owner 丢失全部在线 Credential 时必须使用预先备份的 offline Credential。没有 active approver 或有效备份时 fail closed，不能按 Principal ID 或 display name 恢复。

同步调度器为目标 Principal 的 active Clients 和 Group Owner 生成本地通知，详情显示请求类型、新设备名称、Credential fingerprint、申请/过期时间、request hash 和验证码，并明确区分 self-device approval、Owner recovery 和 offline Owner recovery。

### 5.6 Git Remote Access 与本地 SSH Key

Git Remote 服务账号与 SSH key 只决定 clone、fetch、push 能否成功。创建、观察、加入和恢复表单中的 `gitSshKeyPath` 都是可选本地 transport 设置：显式值优先，其次 `SSH_KEY_PATH`，最后 `~/.ssh/id_rsa`；`~` 必须展开。设置页可查看、修改或清除该值，清除后重新解析默认值。本地绝对路径不写入 Group Git 或审计导出，也不参与 Principal、Client、Credential 或 event actor 的生成。

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

文档和 UI 中的 Owner/Admin/Member/Workflow Designer 是常用权限集合的显示名称，不是重新引入 Group Role。协议授权只校验 Principal、直接 grant 和资源所有权；除唯一 Owner 身份外，不依赖可认领的角色对象。普通成员管理自己负责的 Work Item 时，资源 owner 身份与 `work_item:manage_owned` 直接权限必须同时成立；撤销该权限会立即关闭 allowed action 并由 Reducer 拒绝写入。Owner、`group:admin` 或 `work_item:manage_all` 的全局管理能力不受此限制。

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

| 操作                     |          Owner/Admin |           Member |  Work Item Owner | Workflow Assignee |
| ------------------------ | -------------------: | ---------------: | ---------------: | ----------------: |
| 创建 Work Item           |                   是 |           按策略 |               是 |                是 |
| 发布个人进度             |                   是 |               是 |               是 |                是 |
| 写共享空间               |                   是 |         按 grant |         按 grant |          按 grant |
| 修改任意 Work Item       |                   是 |               否 | 负责项且有 grant |                否 |
| 提议 Workflow Definition |                   是 |         按 grant |         按 grant |          按 grant |
| 发布 Workflow Definition |                   是 |               否 |               否 |                否 |
| 启动已允许 Workflow      |                   是 | 按 launch policy |         通常允许 |                否 |
| 修改 State Execution     | 仅自己被指派的 State |             同左 |             同左 |                是 |

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
- 创建和 `work_item_relation_changed` 统一校验 self、重复引用和 Group 内存在性；`work_item_details_updated` 必须保持全部 relation 字段不变，不能绕过专用关系事件；
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
  "last_completed_turn_id": "turn_previous",
  "last_handoff_hash": "sha256:...",
  "epoch": 1,
  "revision": 12,
  "created_by_principal_id": "principal_bob"
}
```

Instance 创建时固定 Definition hash、slot mapping 和每个 State 的 resolved Principal。Definition 后续发布新版本不改变已运行 Instance。

业务 UI 不直接编辑 `participant_bindings` JSON。实例创建向导先选择已发布 Definition 和 Group/Work Item scope，再从 Machine 自动提取 participant slots，并用可搜索的 Active Principal 选择器生成底层 JSON 合同。向导展示每个 slot 负责的 State、最终 `State -> Principal` 解析、缺失/失效绑定和启动规则；同一 Principal 可以绑定多个 slot。Work Item 级实例还必须逐一选择所有 terminal State 的 `work_item_status_mapping`。

自动建议只使用可可靠判断的 Work Item owner/contributor 和当前 Principal；无法可靠判断时保持待选择。draft 或绑定失效的实例通过“补齐参与者 / 重新分配”入口调用现有 `workflow_state_assignee_changed` 能力，服务端重新校验 Active Principal、实例管理权限和并发 revision。

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
- 多个 State 的 reassignment 必须作为一个原子事件 batch 提交，任一 State 校验或 CAS 失败不得留下部分分配；
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
- 桌面/API 创建 Turn 只允许 Instance creator、拥有 `workflow_instance:manage_all`/`group:admin` 的 Principal，或当前 State resolved assignee；普通活跃 Member 不能替别人的 State 启动 deadline、通知或审计链。
- State Execution 只允许当前 business State 的 resolved Principal 在 `ready/running/paused` 生命周期配置或清除；清除后删除本机 State Binding，后续 Turn 回到协议默认 `manual`。
- Renderer 只从当前 Principal 在该 Group 注册、状态 active、且当前 Client 有本机 profile 的 Executor 中选择；State 配置请求不携带本地路径、Provider 凭据或任意配置 JSON。

### 12.3 Principal Automation Library

```text
workspace/principals/{principal-id}/automations/
  actions/
    {action-id}.json
  prompts/
    {prompt-id}.md
```

Action 可以被同一 Principal 在多个 Definition/Instance State 中复用。Action JSON 保存 Prompt ID、`prompt_ref`、版本和 content hash，Prompt 的人类可读正文保存在被引用的 Markdown 文件中。其他 Principal 可读和审计，但不能修改。

业务创建合同不接受 `executor_id`、`action_id`、Action version、Prompt ref/hash 或 State Execution revision。Host 使用 UUID 生成 Group scoped `executor_<uuid>` 和 `action_<uuid>`；新 Action 固定从 v1 开始，修订沿路径中的 Action ID 从当前 Projection 自动计算 vN+1，Prompt ref/hash 从生成 ID 与 Markdown 内容推导。Renderer 只编辑显示名称、平台/类型、Prompt、执行权限、结果格式、本地工作目录和审批策略。机器 ID 仅在详情和审计中只读展示，不从显示名称派生。

Executor 注册同时写入两类边界清晰的数据：Git 只保存当前 Principal 的公共 descriptor；本机 SQLite profile 保存 Client、工作目录、权限上限和 Provider 配置。同一底层本机平台注册到不同 Group 时生成不同 executor ID，State Execution 配置再从 profile 派生精确的 Instance/State/Action-hash Binding。`executor_registered` / `executor_revoked` 必须进入 actor Principal 自己的 membership Aggregate；descriptor 的 `registered_at_event` 必须引用当前注册事件。同一 Principal 下的 executor ID 一经使用即永久保留，撤销后不得重注册或复活。

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
executor_result_hash        nullable
completion_hash             nullable
```

Claimant Principal 必须等于 assignee Principal；Client、attempt 和 fence 共同防止同一人的多个本机实例重复执行。

三种模式的终态语义不同：

- `manual`：用户确认开始，用户选择合法 Outcome 并确认完成，不生成或伪造 Action result hash；
- `assisted`：用户确认开始；经校验的 Executor Result 通过 `action_completed` 固定为 `executor_result`/`executor_result_hash`，Turn 进入 `awaiting_confirmation`，不推进 Machine；原 claimant Client 可查看建议、选择合法 Outcome、编辑 Handoff/Data/Artifact 后确认，`turn_completed.result_hash` 必须引用已固定 Executor hash；
- `automatic`：只有经 schema 和当前 State Outcome 校验的 Executor Result 才能自动完成，`turn_completed.result_hash` 必须精确等于 `action_completed.result_hash`；最终 Outcome、summary、instruction、markers、data、空 `data_refs` 和 Artifact refs 必须全部由已冻结的 Executor Result 确定性派生，Reducer 对任一事实漂移 fail closed；Provider `failed`、`cancelled`、`blocked` 或结果解析失败进入 recovery/technical terminal，不能冒充业务 Outcome。
- Automatic 的 `action_completed` 与 `turn_completed` 是两个独立持久事实。若前者成功而后者因进程退出、CAS 或 Git 错误失败，Scheduler 必须从 Projection 中的 `executor_result`/`executor_result_hash` 幂等续写 `turn_completed`，不得重新 dispatch、observe 或追加第二个 `action_completed`；该恢复不依赖 Executor 的进程内状态。
- Instance 存在 active Turn 时不能关闭；Turn Cancel 清除 `active_turn_id` 后才能 close。`turn_completed` 只接受仍处于 `running` lifecycle 的 Instance，避免已关闭流程被迟到完成事件继续推进。

`turn_completed.completion_hash` 独立覆盖最终 Outcome、Handoff hash、Artifact refs 和可空 Result hash，因此 Assisted 的人工编辑与原 Executor 建议同时保留在审计链中。

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

该输入的机器合同为经 Schema 校验的 `icarus.collaboration-action-input/3` JSON；RunOnce、Codex Task 和 Workflow Executor 复用同一确定性构造与 Markdown 呈现，不各自推导 Outcome。Executor 成功输出必须是 `icarus.collaboration-action-result/3` JSON，`outcome` 必须属于当前 State transitions，Action 自己的 `result_schema` 继续约束 `data`。

Action Result 中用于 Handoff 的 `data` 不得超过 1 MiB；Artifact ref 必须是规范化仓库相对路径、保持唯一且最多 100 个。这样任何被 `action_completed` 接受的结果都能确定性派生 Automatic Handoff，不会先成为权威结果后再因 Handoff schema 更严格而永久无法完成。

首个 Turn 的 incoming Handoff 必须为空。后续 Turn 不能接受 API/UI 提交的任意 Handoff；Service 从 Instance 的 `last_completed_turn_id`/`last_handoff_hash` 解析使 Instance 进入当前 State 的上一 completed Turn，Reducer 校验对象、hash、Instance 边界并重算完整 `input_hash`。该规则同样适用于 self-loop。

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

invites/
  {invite-id}.json

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
  invites/
    {invite-id}/
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
  invites/
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

| 路径                                  | 合法写入者                          | 约束                                 |
| ------------------------------------- | ----------------------------------- | ------------------------------------ |
| `group.json`                          | Owner/Admin                         | Group event 物化                     |
| `invites/{invite}.json`               | member approval authority           | 目标 Principal、有效期、一次性状态   |
| `members/{principal}/member.json`     | 受限加入请求、Admin 状态管理        | 系统生成 Principal 与 Aggregate 一致 |
| `members/{principal}/clients/`        | 受限加入/恢复、对应 Principal       | Client、Credential 与 Actor 一致     |
| `members/{principal}/credentials/`    | 受限加入/恢复、对应 Principal       | 公钥 fingerprint、purpose、状态校验  |
| `members/{principal}/executors/`      | 对应 Principal                      | 只允许公开 descriptor                |
| `recovery-requests/{request}.json`    | 请求方、同 Principal 或 Owner       | request hash、CAS、单次终结          |
| `permissions/{principal}.json`        | permission grant authority          | 禁止自我提权                         |
| `workspace/principals/{principal}/`   | 对应 Principal                      | actor path ownership                 |
| `workspace/shared/`                   | `workspace:write_shared`            | revision、hash、size                 |
| `work-items/{id}/`                    | Item creator/owner/Admin            | 字段级授权和 item revision           |
| `discussions/{id}/messages/{message}` | 消息作者追加                        | 修改使用 revision event              |
| `workflow-definitions/{id}`           | Designer/Publisher                  | publish grant、definition revision   |
| `workflow-instances/{id}`             | Instance authority/current assignee | 生命周期、assignment、fence          |
| `execution/{state}.json`              | resolved assignee Principal         | state/principal 必须匹配             |
| Work Item Artifact                    | 授权 Item contributor               | metadata/hash/path 校验              |
| Turn Artifact                         | 当前 claimant Client                | instance/turn/attempt/fence 校验     |
| `projections/`                        | Runtime                             | 必须与合法事件归约一致               |

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
- “初始化群组”是唯一例外：它不追加事件，不使用 expected old head、CAS 或 force-with-lease，而是把一个已完整验证的孤立 Genesis 通过无条件 force refspec 覆盖到同名 control branch；
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
group_dissolved
invite_issued
invite_revoked
membership_requested
membership_rejected
member_registered
member_suspended
member_reactivated
member_removed
member_left
client_revoked
credential_rotated
credential_revoked
identity_recovery_requested
owner_recovery_requested
recovery_approved
recovery_rejected
recovery_expired
recovery_cancelled
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
workspace/principals/principal_2d9023b8-73e3-41bf-bb96-d52c0cb15bb3/
```

display name：

- 由 `member.json` 映射；
- 可以修改和重名；
- 重名时附短 Principal ID；
- 不能用于路径、授权、事件 Actor 或引用；
- 详情页可查看完整 Principal、Client、公开 Credential fingerprint/status 和验证状态。

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

- 只创建 schema 限定的加入、恢复或取消请求，不能创建其他签名业务命令；
- 不显示普通成员业务 mutation 控件；
- 可以设置本地刷新频率；
- 可以订阅 Group 级公开活动提醒；
- pending recovery Client 可以接收自己的请求状态，普通 Observer 不能接收只面向某个 Member 的任务或 State 通知；
- 升级为 Member 后复用已验证本地 cache，不重复全量 clone。

## 18. 生命周期

### 18.1 Group

```text
ACTIVE
  -> ARCHIVED
  -> DISSOLVED
ARCHIVED
  -> ACTIVE (reopen, explicit policy)
  -> DISSOLVED
DISSOLVED
  -> terminal
```

Group 不使用 `FORMING/READY/RUNNING`。Archive 后普通业务写入默认禁止，但仍可读取、导出审计、由 Owner reopen 或 dissolve。`group_dissolved` 只能由 Owner 签署；Dissolved 拒绝包括 reopen、恢复和重新加入在内的全部后续事件。

### 18.2 Membership

```text
REQUESTED
  -> ACTIVE
  -> REJECTED

ACTIVE
  -> SUSPENDED
  -> REMOVED
  -> LEFT (self, non-Owner only)

SUSPENDED
  -> ACTIVE
  -> REMOVED

LEFT / REJECTED
  -> REQUESTED or ACTIVE (current join policy, same principal_id)
```

Removed/Left Principal 的历史内容和 Actor 记录不删除；新业务写入拒绝。`member_left` 撤销该 Principal 当前有效的全部 Client、Credential 和 Executor。事件必须携带 Reducer 根据事件发生时 Projection 校验过的 `affected_turn_ids`；若该 Principal 是活动 Turn 的 assignee 或 claimant，这些 Turn 与 Instance 同时进入 `recovery_required`，Owner 的 critical 通知直接绑定事件中的 Turn ID，不得从一次批量同步后的最终 Projection 反推。

`turn_recovered` 必须由 Instance 管理者指定新的 active Principal，并在同一个 Workflow Instance Aggregate 事件中原子更新当前状态的 `resolved_assignments`、活动 Turn 的 `assignee_principal_id`、attempt、输入哈希、幂等键和 deadline snapshot。若负责人发生变化，旧 Principal 的 State Execution 快照失效；新 attempt 至少可按 manual 模式启动，之后由新负责人继续执行。恢复不得依赖已退出 Principal 重新加入。

### 18.3 Archive、Dissolve、Leave 与本机移除

| 操作       | 执行者                 | Git 业务事件      | 远端语义                                 | 当前设备                                                          | 后续恢复                                          |
| ---------- | ---------------------- | ----------------- | ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| Archive    | Owner/授权管理者       | `group_archived`  | Group 只读归档                           | 保留全部本地展示数据                                              | Owner 可 `group_reopened`                         |
| Dissolve   | 仅 Owner               | `group_dissolved` | Group 进入不可恢复终态                   | 远端成功后隐藏并清理可重建数据                                    | 不可 reopen、恢复或重新加入                       |
| Leave      | active 非 Owner Member | `member_left`     | Membership 变为 `left`，撤销身份活动能力 | 远端成功后隐藏并清理可重建数据                                    | 按当前 join policy 使用原 `principal_id` 重新加入 |
| 从本机移除 | Observer/Member/Owner  | 无                | 不改变 Group 或 Membership               | 立即移除 subscription/projection/cache/temp/notification/analysis | 重新发现 remote 后恢复 retained identity          |

Dissolve 和 Leave 的 Git append/push 失败时，本地 subscription、projection 和列表展示必须原样保留。本地 detach 使用事务先写 cleanup plan，再级联删除展示数据；repository cache 或 staged-artifact 文件清理失败时保持 `cleanup_pending`，群组仍不可重新显示为 active，并在启动或显式 API 调用时重试。

本机移除及终态 detach 不删除 Credential 安全目录、私钥材料或备份。长期 binding 只保留身份恢复所需的 `group_id`、当前 `remote_url`、`principal_id`、`credential_id` 和可选 `recovery_credential_id`，以及 detach reason、terminal head 和 pending cleanup 状态。Remote URL 不是唯一键；重新发现以 verified `group_id` 选择 binding 并更新 locator。

### 18.4 Workflow Definition

```text
DRAFT
  -> PROPOSED
  -> PUBLISHED
  -> RETIRED
```

已发布版本不可原地覆盖。业务变更发布新 version；layout 更新独立，不改变 Machine hash。

### 18.5 Workflow Instance

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

### 18.5 Archive、Dissolve、Local Remove 与 Initialize

四个操作的语义不能互换：

| 操作         | Remote 与历史                                                                                                         | 当前设备                                        | 可恢复性            |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------- |
| Archive      | 保留同一 Group 和完整历史                                                                                             | 保留订阅、投影与身份                            | 可以 reopen         |
| Dissolve     | 终止原 Group 业务，但保留历史和终止事实                                                                               | 保留可审计只读状态                              | 不恢复为原业务群组  |
| Local remove | 不修改 Remote                                                                                                         | 仅删除当前设备的订阅、投影、缓存和本地身份绑定  | 可重新 Observe/Join |
| 初始化群组   | 保留 Remote locator 与 `refs/heads/icarus/control` 名称，但以无条件 force push 改写为新 `group_id` 的单一孤立 Genesis | 删除旧 Group 的全部本地数据，注册新 Owner Group | 不可恢复旧 Group    |

初始化仅允许当前 Owner 执行。Host Service/API 在生成新身份和 Genesis 前必须先同步并完整验证 Remote current history，再确认最新 Projection 中的本地 Principal、Client 和 Credential 仍是 active Owner 身份；UI 隐藏入口不构成授权。授权完成后的 push 仍不使用 lease，之后到达 Remote 的提交也可以被覆盖。初始化默认沿用名称、membership policy、visibility policy 和本机 Git Remote SSH 配置，但创建新的 Group、Owner Principal、Client、event-signing Credential 与 recovery Credential。它不是 `group_reinitialized` 事件，不创建 reset/recovery/cancel 事实，不保留 generation/epoch，也不把旧成员身份迁移到新群组。

新 Genesis 先在隔离临时仓库中签名并通过 current v3 history、reducer 与 materialization 全量验证，然后使用 `+HEAD:refs/heads/icarus/control` 推送。该 push 不使用 lease：确认后其他成员刚写入的提交仍会被覆盖；多个 Owner 设备并发时最后一次成功 push 生效。Git 服务端 branch protection 或 hook 可以拒绝 force push，Icarus 权限不能绕过 transport 限制。远端成功前不替换本地旧状态；远端成功后若本地中断，SQLite 临时操作记录会在下次启动重新读取 Remote 并完成替换，清理成功后删除该记录。

其他设备发现 control history 非 fast-forward 且 `group_id` 改变时，必须隔离旧订阅、停止旧身份写入，并要求用户按新群组重新 Observe/Join；系统不能伪造旧事件链对重写的授权。并发初始化失败方仅在新群组 `observer_access=allowed` 时注册 Observer；`members_only` 时删除旧展示状态和仓库缓存，不注册新订阅，只能显式 Join 或恢复身份。初始化只更新 Icarus control ref，不删除无关 branch 或 tag。

初始化会让旧提交从 Icarus 可见 refs 和 `git log icarus/control` 中消失，并删除执行设备持有的旧订阅、Projection、事件、审计、通知、分析、staged Artifact、专属 Credential 和仓库对象缓存。仅包含旧群组的 Icarus 默认备份整体删除；包含多个群组的有效 managed backup 在隔离目录中重建并净化旧群组的全部级联数据和 staged bytes，经 `secure_delete`、`VACUUM`、Artifact 校验及新 manifest size/checksum 后替换原备份，其他群组仍可恢复。Git Remote SSH 私钥、安装级 Client 文件和被其他群组引用的 Credential 不得删除。Icarus 只能使 Git 服务端旧对象不可达；在服务端 GC 或备份过期前不能保证物理擦除，也不能删除其他用户的离线 clone。

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
- Principal/Client/Credential/optional Executor public identity，以及 Credential rotation/revocation；
- identity/owner recovery request hash、验证码所需材料、状态、批准类型、决策原因和撤销范围；
- Work Item 全部字段、assignment、status、progress、relations 和 Artifact refs；
- Discussion message/revision/tombstone；
- Workflow Definition version、Machine/layout hash；
- Workflow Instance scope、assignment、State、Turn、Outcome、Handoff 和 timeout；
- 每条事件的 Aggregate revision、previous hash、commit hash 和签名结果；
- 缺号、断链、未知 signer、hash mismatch、clock skew、missing local evidence；
- raw UTC time 和可派生 duration。

默认导出只提供摘要、metadata 和 hash。Prompt、Handoff data、Discussion 内容、文件内容和 Executor log 使用独立 `include_content` 授权；共享 Credential 公钥/fingerprint/status 属于验证材料并保留，Credential 私钥、Git SSH path、本地绝对路径、token 和 Provider secret 永不导出。

## 21. API 草案

除文件上传和下载外，所有 API 请求、响应和错误体使用 `application/json`。上传使用 `multipart/form-data`，其中 metadata part 是经过同一 JSON Schema 校验的 JSON，file part 保持业务文件原始格式；客户端不能通过 multipart 上传协议 materialization 文件。Host 根据认证 Principal 和 endpoint 补全系统派生字段，调用方不能覆盖 ID、Actor、hash 或 repository path。

### 21.1 Inspect、Observe 和 Join

```text
POST /api/collaboration/groups/inspect
POST /api/collaboration/subscriptions
DELETE /api/collaboration/subscriptions/{groupId}
POST /api/collaboration/local-bindings/{groupId}/cleanup/retry
POST /api/collaboration/groups/{groupId}/join-requests
POST /api/collaboration/groups/{groupId}/join-requests/{requestId}/approve
POST /api/collaboration/groups/{groupId}/join-requests/{requestId}/reject
GET  /api/collaboration/groups/{groupId}/invites
POST /api/collaboration/groups/{groupId}/invites
POST /api/collaboration/groups/{groupId}/invites/{inviteId}/revoke
```

Observer subscription 是本地记录，不写 Group Git。`DELETE subscriptions` 对 Observer/Member/Owner 都只执行本机移除，要求 body 中 `confirmation` 精确匹配 `groupId`；cleanup retry 只处理 retained binding 的本地 pending 文件。Join API 不接受调用方覆盖 `principal_id/client_id/credential_id`，Host 首次加入时生成 Group Principal，并在 retained binding 存在时恢复同一 Principal。`invite_only` 的 Join body 只提交 `inviteId` 引用；默认未绑定 Invite 不预先决定 Principal。

### 21.2 Group、Members 和 Permissions

```text
POST /api/collaboration/groups
GET  /api/collaboration/groups/{groupId}
POST /api/collaboration/groups/{groupId}/sync
POST /api/collaboration/groups/{groupId}/archive
POST /api/collaboration/groups/{groupId}/initialize
POST /api/collaboration/groups/{groupId}/reopen
POST /api/collaboration/groups/{groupId}/dissolve
POST /api/collaboration/groups/{groupId}/leave

GET  /api/collaboration/groups/{groupId}/members
POST /api/collaboration/groups/{groupId}/clients/{clientId}/revoke
POST /api/collaboration/groups/{groupId}/credentials/rotate
POST /api/collaboration/groups/{groupId}/credentials/{credentialId}/revoke
POST /api/collaboration/groups/{groupId}/recovery-requests
POST /api/collaboration/groups/{groupId}/recovery-requests/{requestId}/approve
POST /api/collaboration/groups/{groupId}/recovery-requests/{requestId}/reject
POST /api/collaboration/groups/{groupId}/recovery-requests/{requestId}/cancel
POST /api/collaboration/groups/{groupId}/recovery-credential/export
POST /api/collaboration/groups/{groupId}/recovery-credential/import
PUT  /api/collaboration/groups/{groupId}/settings/git-remote
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
collaboration_local_group_bindings
collaboration_subscriptions
collaboration_groups
collaboration_principals
collaboration_clients
collaboration_credentials
collaboration_recovery_requests
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
collaboration_action_snapshots
collaboration_staged_artifacts
collaboration_notifications
collaboration_timeout_schedules

collaboration_sync_attempts
collaboration_integrity_incidents
collaboration_local_audit_evidence
```

关键边界：

- subscription、Client private state、Credential 私钥路径、Git SSH path、Executor Binding、receipt、staged upload、notification 和 local evidence 不能依赖 Git 重建；
- local Group binding 以 `group_id` 为主键，并在 detach 后保留当前 remote locator、Principal/Credential 关联、terminal head 与 cleanup 状态；`remote_url` 不得成为 Group 唯一键；
- Group/Member/Client/Credential public record、Recovery Request、Work Item、Discussion、Workflow Projection 和 file index 可以从 verified Git 重建；
- 每个 Aggregate checkpoint 保存 last revision/hash/commit；
- 每个 Action publish/revise 保存 group + owner + action id/hash + prompt hash + commit 的精确索引；Scheduler 和 verified historical read 不依赖任意最近事件窗口；
- global activity feed 是 SQLite read model，不回写一个全局 Git 文件；
- SQLite transaction 与 visible verified head 原子切换；
- detach 事务先写 `cleanup_pending` 计划，再删除 subscription，使 projection、notification、analysis、temp 和其他 Group FK 数据级联清除；文件清理成功后转为 `retained`，失败则记录错误并可幂等重试；
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
Git Remote SSH key path (optional, local only)
owner display name
current Client display name
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

### 23.7 生命周期操作

- Settings 仅向 active/archived Owner 显示“解散群组”，仅向 active/archived 非 Owner Member 显示“退出群组”；服务端仍独立校验 actor、Membership、Credential 和 lifecycle；
- Owner 从成员退出 critical 通知进入活动 Turn 后，恢复对话框只列出 active Principal，并将“重新分配负责人”和“创建新 attempt”作为一次原子提交；
- Group 列表右键菜单向所有本地 subscription 显示“从本机移除”；
- 三种危险操作分别解释远端与本机影响，并要求输入完整 `group_id`；Dissolve 明确标注不可恢复；
- 远端失败时保留详情和列表；远端成功后立即返回群组列表。cleanup pending 以错误提示说明后台会重试，不重新展示已 detach 群组；
- 手动同步若发现远端已 dissolved 或本机 Principal 已 left，直接隐藏本地群组，不再请求已删除的 detail。

## 24. 安全边界

### 24.1 身份与授权

- Principal 必须是 Host 生成的 Group-scoped `principal_<uuid>`，不得从 Git SSH key 或 fingerprint 派生；
- Client ID 必须由安装级 Identity Service 生成并持久化；Client 只能经 genesis、受限加入或批准的恢复事件注册；
- 每个事件 Actor 必须携带 `credential_id`。Replay 使用 Credential 公钥验证 commit signature，定位 active Credential，校验 Credential 的 Principal/Client 与 Actor 完全一致，再执行 Reducer 业务授权；
- 未注册 Credential 只能签署严格 schema 限定的 membership/recovery request 或自己的 recovery cancellation；
- Credential fingerprint 必须由公钥计算；轮换和单 Credential/Client 撤销不改变 Principal；
- Executor descriptor 不授予权限；
- 所有 mutation 在 Host 和 Git replay 两个边界都验证权限；
- 不能依赖 UI 隐藏按钮；
- permission grant 禁止普通 Admin 自我升级为 Owner 或 grant authority；
- removed/suspended/left Principal 的新事件拒绝；dissolved Group 拒绝所有后续事件。

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
- 账号/SSH key 只控制 clone/fetch/push，write ACL 不替代协议授权；Observer 即使可以 push 也不能写 Icarus 业务事件；
- control branch 保持 fast-forward 和签名验证；
- direct manual push 若不能解释为合法 event/materialization 或 Actor 没有业务权限，进入 quarantine 并保留最后 verified head；
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
- Group lifecycle 改为 ACTIVE/ARCHIVED/DISSOLVED，并实现 Owner-only terminal dissolve；
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

- 创建与普通加入均生成 `principal_<uuid>`，调用方不能指定 Principal/Client/Credential ID；
- Git SSH key 或 Credential fingerprint 变化不改变已存在 Principal；
- 每个安装持久化稳定 Client ID，每个 Client 自动生成独立 Credential；
- 同一 Principal 可以注册多个 Client；
- Credential rotation、单独 revoke、Client revoke 连带 Credential revoke 分别通过正反例；
- 不配置 Executor 仍可加入和人工协作；
- API 不能覆盖 Principal/Client/Credential ID、fingerprint 或 Actor；
- Observer 没有业务写权限，但可以使用未注册 Credential 发送受限 membership/recovery 请求；
- Observer 升级 Member 复用 cache；
- open/approval/invite-only 分别通过正反例；
- 未绑定 Invite 的未授权签发、过期、撤销、消费和复用分别通过正反例，Git materialization 可从事件重建；
- identity recovery、Owner recovery、offline Owner recovery、取消、过期、CAS 冲突、二次终结和默认/选择性撤销分别覆盖；
- 旧 Client/Owner 通知、request hash 与双方验证码、审计批准类型、Electron request builder/UI helper 分别覆盖；
- Git read/write ACL 与协议 Membership/Permission 在诊断中明确区分，越权 direct push 保持 verified head 并 quarantine。

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
- 默认导出保留共享 Credential 验证材料，并严格脱敏本地路径、私钥/token 和 Provider metadata。

### 26.10 UI

- Group 创建不出现 Role/Machine 必填；
- 创建、观察、加入和恢复不强制填写 Git SSH key，设置页可查看、修改和清除本地 transport path；
- 创建后立即发布进度、Work Item 和文件；
- Observer 明确业务只读且可以申请加入或恢复已有身份；
- Members 页面分层展示 Principal、Client、Credential 和直接 Permission，重名 Principal 显示稳定短 ID；
- Recovery 列表/详情展示状态、request hash、验证码、设备名、fingerprint、时间和冲突/过期错误，并支持批准、拒绝、取消；
- Owner recovery 显示高风险说明、必填理由和默认撤销全部旧 Credential，offline recovery Credential 可显式导出/导入；
- Work Item Board/List/Detail 在桌面和窄窗口无重叠；
- 图编辑器 Outcome-first 全路径可用；
- Principal/participant lane 正确；
- 不使用拖拽也能完成所有 Workflow 编辑；
- 多 Instance Runtime 图正确选择 scope；
- approval 群组的有权 Principal 可以在 Members 视图批准或拒绝 requested Member；
- running Instance 可以从首个 Turn 连续创建下一 Turn 直到 terminal，manual 与 assisted 路径均可完成；
- assisted Turn 必须从当前 Principal/Client/Action/Prompt 匹配的 Binding 中选择并提交 Executor；
- 虚拟文件树 display mapping、刷新和验证状态清晰；
- 错误定位到具体 Aggregate/State/Outcome/path。

## 27. 验收标准

- 用户可以创建没有 Role、Machine 和 Workflow 的 Group，并立即进入 ACTIVE。
- Observer 可以只读订阅、定时/手动刷新、验签和浏览全部 Git 可见内容，不会出现在成员列表；它只能产生严格限制的加入/恢复请求，不能产生业务事件。
- 正式加入只注册系统派生 Principal；一个 Principal 可以使用多个 Client，也可以不配置 Executor。
- Principal、Client 与 Credential 完全分离；Credential 可轮换/撤销且不改变 Principal，Git Remote SSH key 只负责 transport。
- 新设备可经旧 Client、Owner 或预先备份的 offline Group recovery Credential 恢复原 Principal；没有 active approver/有效恢复凭据时 fail closed。
- invite-only 群组使用不绑定 Principal、可撤销/过期、一次性消费的签名 Invite，并在 UI 中完成签发、申请和审批闭环。
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
| Principal 来源          | Host 在 Group 内生成 `principal_<uuid>`           |
| Client                  | 安装级持久 `client_<uuid>`，Principal 可有多个    |
| Credential              | 每 Client 自动生成、可轮换/撤销的事件签名密钥     |
| Git Remote SSH key      | 仅本地 transport 设置，不参与业务身份或授权       |
| 身份恢复                | 旧 Client、Owner 或 offline Group Credential 审批 |
| Executor                | Principal 的可选执行工具，可为零                  |
| Observer                | 业务只读订阅，仅可提交受限加入/恢复请求           |
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
| 业务授权边界            | Host API + Credential verification + Reducer      |
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
