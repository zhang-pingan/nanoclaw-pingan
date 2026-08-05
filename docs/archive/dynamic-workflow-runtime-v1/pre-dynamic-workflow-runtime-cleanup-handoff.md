# Dynamic Workflow Runtime 前置清理与规范修订 Handoff

## 文档用途

本文是后续独立会话的执行清单，不是 Dynamic Workflow Graph Runtime 的第二份架构规范。目标规范仍是 `local/docs/dynamic-workflow-dag-framework.md`；本文件只记录在正式实施前需要删除的 legacy surface，以及目标规范需要同步修正或补充的内容。

## 已确认前提

1. 项目仍处于开发期，不存在需要持续运行、收敛或恢复的 legacy Workflow 实例。
2. 不迁移 legacy Workflow 数据、历史、聊天关联、artifact/context、projection 或运行状态。
3. 新 Runtime 建设期间允许产品暂时没有 Workflow Runtime 和 Workbench。
4. `dev_test/fix_test` 是否迁移尚未决定，不属于 Dynamic Runtime v1 的必交付范围。
5. 流程管理和卡片管理两个通用创作后台删除，未来是否建设新的开发工具另行决策。
6. Feature UI 负责领域操作；未来运行中心只承担跨 Feature 观测、通用控制、诊断和审计。

## 本次会话已经完成

### 不可执行迁移候选包

原 `dev_test/fix_test` 资源已经移到：

```text
local/migration-candidates/dev-test-fix-test/
```

候选包包含：

- 原 Workflow Definition、Card、Artifact Contract、Evaluator 原始字节
- 10 个 Workflow 专属 Skill
- 原 group/skill binding
- `service.test_token` 源码快照
- 旧代码特判说明
- 旧测试场景索引
- `MIGRATION-CANDIDATE.md`
- `SHA256SUMS`

全部 16 份归档文件已通过 `shasum -a 256 -c SHA256SUMS`。

### 活动资源解除注册

- 活动 `container/workflow-definitions/` 不再包含 `dev_test/fix_test`。
- 活动 `container/cards/` 不再包含 `dev_test` Card。
- 活动 Artifact Contract/Evaluator 目录不再包含两者的配置。
- 10 个专属 Skill 已移出 `container/skills/`。
- `container/skills/skills.json` 已移除专属 Skill binding，共享 `devops` 等 Skill 保留。

### 尚未执行

- 未删除任何 Electron UI、API、Runtime、Workbench、数据库 schema 或测试代码。
- 未修改 `local/docs/dynamic-workflow-dag-framework.md`。
- 未增加 absence boundary test。
- 未清理本机 `store/`、`data/` 等 ignored 开发数据。

## 下一会话工作包 P0：保护迁移候选包

1. 增加 boundary test，保证 `local/migration-candidates/**`：
   - 不进入 TypeScript/Electron/Assistant 编译输入。
   - 不进入 Feature Manifest、Registry、Compiler 或 fixture discovery。
   - 不被 container build context、package 或 release artifact 复制。
   - 不允许 production source、test helper 或 build script import/read。
2. Legacy absence scan 对候选目录单独分类为 `inert_migration_candidate`，不得把它误判成活动 legacy source。
3. 除候选目录外，生产代码和活动资源中出现 `dev_test/fix_test` 必须失败。
4. 校验 `SHA256SUMS` 纳入普通 CI；只验证归档完整性，不执行归档资源。

退出条件：候选目录可长期保留，但从任何可执行闭包均不可达。

## 下一会话工作包 P1：删除流程管理与卡片管理前端

### 导航和页面

从 `electron/renderer/index.html` 删除：

- `workflow-definitions` 导航
- `cards-management` 导航
- 旧 `workbench` 导航和 Screen
- Workflow Definition/Artifact Contract 编辑 Screen
- Card 编辑/预览/引用反查 Screen
- Workbench 创建、任务列表和详情 Screen

不建立隐藏入口、feature flag 或空白兼容页面。

### Renderer 逻辑

从 `electron/renderer/app.js` 删除：

- Workflow Definition form/json/graph/version/diff/editor 全部状态和函数
- Artifact Contract 编辑逻辑
- Card CRUD、预览、drag/drop、引用反查逻辑
- Workbench list/detail/create/action/retry/comment/asset/realtime 逻辑
- Workflow create options、create form preview 和任意 workflow type 创建器
- 对应 WebSocket event 分支、事件监听器、快捷入口和启动预热

### 样式

从 `electron/renderer/styles/main.css` 删除专属 selector。`workflow-definition-*` 当前被 Knowledge/Configuration 复用，必须先按 DOM selector inventory 拆分共享样式，不能批量误删其他页面样式。

退出条件：Electron 中不存在三个旧导航/页面，Renderer 不再请求 legacy Workflow/Card/Workbench API，非 Workflow 页面仍正常构建。

## 下一会话工作包 P2：删除管理 API 与 legacy 资源链

从 `src/channels/web.ts` 删除：

- `/api/workflow-definitions*`
- `/api/workflow-artifact-contracts*`
- 仅供旧编辑器使用的 `/api/workflow-actions`
- `/api/cards*`
- `/api/workflow/create-options`
- `/api/workflow/requirement`
- `/api/workbench/*`
- 对应 handler、parser、validator、cache reload 和 response DTO

删除 legacy authoring/resource 实现：

- `workflow-definition-store.ts`
- `workflow-definition-files.ts`
- `workflow-definition-registry.ts`
- `workflow-definition.ts`
- `workflow-compiler.ts`
- `workflow-config.ts`
- `card-files.ts`
- legacy Artifact Contract/Evaluator loader、writer 和 cache
- legacy `workflow-actions/*`

`CardConfig`、`card-builder`、`schema-card`、`human-input-card` 只有 legacy 调用时一并删除；通用 `InteractiveCard` 类型、渠道 `sendCard` 和 Assistant 自有 Card 保留。

退出条件：旧管理 API 返回 404，活动 source 不存在旧 Definition/Card registry 或写文件路径。

## 下一会话工作包 P3：删除 legacy Workflow Runtime

删除：

- `workflow.ts`
- legacy scheduler/watchdog/outbox/checkpoint/completion/transition
- interrupt/retry/return/manual skip/pause/resume/cancel 实现
- handoff、quality gate、stage evaluation、evidence、LLM judge、context pack 等只服务旧 Runtime 的实现
- legacy workflow requirement staging
- legacy Workflow artifact/context 特判
- `service.test_token` Workflow Action 实现

保留独立 Scheduled Task 的 `task-scheduler.ts`；它不是 Workflow Runtime。

同步清理：

- `src/index.ts` 的 Runtime 初始化、watchdog、Workbench broadcast 和 Workflow command wiring
- `src/ipc.ts` 的 delegation completion、Workbench query 和 legacy handoff validation
- `src/agent-queue.ts` 的 legacy cancel callback
- `src/card-action-router.ts` 的 Workflow/Workbench action 分支
- `src/ask-user-question.ts`、Assistant、Today Plan 中的 Workbench/Workflow 耦合
- `src/container-runner.ts` 中只服务 legacy Workflow 的执行上下文字段

退出条件：主应用可在完全没有 Workflow Runtime 的情况下启动，聊天、独立 Agent、Scheduled Task、Assistant 非 Workflow 能力和 Trace 不依赖 legacy 模块。

## 下一会话工作包 P4：删除旧 Workbench 与 Projection

删除：

- `workbench.ts`
- `workbench-store.ts`
- `workbench-query.ts`
- `workbench-events.ts`
- `workbench-broadcast*.ts`
- `workflow-interrupt-command.ts`
- Workbench Action Item、Subtask、Artifact、Comment、Context Asset 的旧 projection 写入和查询

Today Plan 当前可关联 Workbench task；应删除该来源和关联字段，只保留 manual/chat/service branch 等仍有效来源。Assistant 自动排查/修复如果依赖 Workbench，应暂时移除该执行入口，不得建立新的临时 Workflow 旁路。

退出条件：不存在旧 Workbench table/API/UI/event/card action，Trace 仍保持独立观测能力。

## 下一会话工作包 P5：数据库与类型物理清理

从开发期 baseline schema 直接删除，不编写 legacy 数据 migration：

- `workflows`
- `workflow_stage_evaluations`
- `workflow_interrupts`
- `workflow_events`
- `workflow_interrupt_resume_attempts`
- `workflow_checkpoints`
- `workflow_outbox`
- 全部 `workbench_*` 表、索引和 accessor
- messages/delegations/agent query 中只服务 legacy 的 `workflow_id/workflow_type/stage_key` 等列
- `workflow_type DEFAULT 'dev_test'`
- `types.ts` 中 legacy Workflow/Workbench record、state、event、interrupt、outbox 类型

删除本机 ignored 开发数据时先输出路径清单，仅删除仓库配置明确拥有的 legacy DB row/file/tree；不得删除独立聊天、Trace、Assistant、Memory、Wiki 或 Feature 数据。

退出条件：新建空数据库和已存在的开发数据库重建路径都不产生 legacy table/column/index；schema absence test 通过。

## 下一会话工作包 P6：Feature Runtime 旧资源字段

移除当前 Feature Runtime 对下列 legacy resource kind 的直接加载：

- `workflowDefinitions`
- `cards`
- `artifactContracts`
- `workflowEvaluators`

Feature Package Runtime、Feature 启停、动态 API/nav/renderer 和非 Workflow resources 保留。新 versioned Recipe/Definition/Capability/Schema/Interface/Policy/Wait/Notification/Card/Artifact/Evaluator/Executor manifest 只能在 Dynamic Framework Registry/Publisher 工作包中重新定义，不能提前复用旧字段语义。

退出条件：Feature 启停不会触发旧 Workflow config reload，也不会扫描旧资源目录。

## 下一会话工作包 P7：测试与 absence gate

1. 删除 legacy Runtime/Workbench/UI/API 单元测试和 fixture。
2. 旧测试中的可选领域行为只保存在 migration candidate 的 scenario index，不转成 Dynamic Runtime 必测项。
3. 增加 source absence checks：
   - legacy import/symbol/route/nav key 为零
   - legacy table/column/index/schema 为零
   - 活动 Definition/Card/Evaluator/Artifact Contract 文件为零
   - production source 对 migration candidate 的引用为零
4. 增加 HTTP negative tests，确认旧 API 404。
5. 增加 Electron DOM negative checks，确认旧导航/Screen 不存在。
6. 运行 TypeScript、Electron、Assistant build 和剩余测试。

退出条件：仓库形成“无 Workflow Runtime”的可编译开发 baseline，候选包是唯一允许保存 legacy 领域材料的位置。

## Dynamic Framework 文档修订 D0：移除不适用的切换协议

项目没有需要收敛的 legacy Runtime，因此应从 `dynamic-workflow-dag-framework.md` 删除或改写：

- legacy active-run/data inventory 作为 Runtime 实现门禁的要求
- `draining/fenced/purging/purged/activated` Cutover Fence 状态机
- rollback 条件和 legacy writer drain
- Physical Purge Manifest executor
- G0 中 legacy inventory/purge contract
- G9/G10 中等待旧 Workflow、interrupt、outbox、effect 收敛的步骤
- `migration/legacy-inventory.ts`、`migration/legacy-purge.ts` 目标模块

替换为开发期静态 baseline gate：source/schema/filesystem absence、测试数据隔离和 migration candidate 不可达证明。

## Dynamic Framework 文档修订 D1：移除 dev_test/fix_test 迁移义务

全文搜索 `dev_test|fix_test`，删除所有把它们视为必迁移 Domain Recipe、current surface replacement 或 Production Gate 的内容，包括：

- 已确认决策索引中的具名迁移例子
- 开发期实施顺序中的强制领域迁移
- Physical Purge 中“只迁移行为合同”的口径
- “行为迁移完成后才能删除旧资源”的约束
- 对应验收、fixture、manifest entry 和 clean-release 条件

增加单一说明：

> `dev_test/fix_test` 资源已作为不可执行 migration candidate 独立保存；是否迁移由 Runtime v1 完成后的独立产品决策决定，不属于本文实现、认证、Product Floor 或 Production Activation。

## Dynamic Framework 文档补充 D2：零 Domain Recipe baseline

明确：

- Dynamic Runtime v1 可以在没有任何 production-launchable Domain Recipe 的情况下完成实现和认证。
- Contract Pack/Compiler/Store/Runtime 测试使用 test-only synthetic Recipe/Definition。
- synthetic resource 不进入 Production Registry，不形成通用创建入口。
- 没有 Published Recipe 时，通用 Intake 返回稳定的 no-route 结果，不暴露全局 Definition/Capability 选择器。
- 运行中心在零 Workflow/零 Recipe 时提供正常空状态。

## Dynamic Framework 文档补充 D3：Removed Surface 合同

当前 surface manifest 偏向“旧入口必须迁移”。补充被直接删除的 launch/control/projection surface 表达：

```text
status = removed
replacement_ref = null
removal_fixture_hash = <negative API/UI/source test bundle>
```

流程管理、卡片管理、旧 Workbench 创建器和 `dev_test/fix_test` launch surface 均标为 removed，不得为了满足 manifest 人工制造替代 Recipe。

如果按 D0 删除 legacy migration manifest，则把这一能力保留为更轻量的 `ProductSurfaceCoverageManifest`，只证明新产品表面完整和旧入口已消失。

## Dynamic Framework 文档补充 D4：Migration Candidate 边界

定义 `local/migration-candidates/**`：

- 允许保存历史领域材料和原始 hash
- 明确不是 authoring source、fixture、Registry resource 或 compatibility reader
- production build/release 不包含
- 普通 source absence scan 排除内容匹配，但必须验证不可达
- Runtime/Core/Feature 代码引用即 CI 失败

这是一项文档资料保留政策，不是 legacy Runtime 兼容政策。

## Dynamic Framework 文档补充 D5：无管理 UI 的 Authoring/Publish 工作流

定义 Codex/Agent 和开发者从 Feature source 到可执行版本的标准工具链：

```text
scaffold -> validate -> compile -> dry-run -> review -> publish -> activate
```

至少补齐：

- 命令/API 名称和输入输出
- staged source 与 immutable published resource 的目录/ownership 边界
- diagnostics/error catalog 输出
- source/hash/closure diff review
- dry-run 不写 Active Registry 的证明
- Human/local-owner approval 和审计
- publish/activate 的幂等与失败恢复

明确 v1 不提供通用可视化 Workflow/Card 编辑器。

## Dynamic Framework 文档补充 D6：Feature Manifest vNext

补充 Feature source/release manifest 的 closed schema、version、namespace、依赖、ownership、draining 和 retention，覆盖：

- Recipe / Routing Scope / Execution Policy
- Workflow Definition / Command Policy / Context Contract
- Schema / Scope Interface / Template / Graph Policy
- Capability / Executor / Prompt / Tool binding
- Wait / Notification / Card Presentation
- Artifact Contract / Evaluator

旧 `workflowDefinitions/cards/artifactContracts/workflowEvaluators` 字段直接拒绝，不做 alias 或 fallback。

## Dynamic Framework 文档补充 D7：Card Presentation 与 Action Contract

当前规范只明确 Notification/Card 是 best-effort Outbox，尚缺展示资源合同。补充：

- versioned `CardPresentationContract`
- exact ref/hash、owner Feature 和 template variable schema
- supported channel adapter、render limits 和 fallback text
- Card snapshot/retention 与 active Run pinning
- deterministic render fixture/preview tool
- Wait/Business Command/Runtime Command 三种 typed action binding
- actor、auth session、delegation、permission、idempotency key
- target expected row version、过期、重复点击和 conflict 语义
- Credential Ref；Secret 原文不得进入 Card payload、Value 或审计

Durable Wait/Command 是权威事实，Card delivery/action UI 不是 Workflow 状态源。

## Dynamic Framework 文档补充 D8：运行中心产品与前端模块边界

在现有四类视图描述之外补充：

- Projection API schema、pagination/cursor、filter、sort 和 rebuild contract
- degraded projection、空状态和断链提示
- Workflow/Feature/Trace 双向 deep link contract
- Runtime Command button availability 与 server-side recheck
- core Runtime Center 独立 renderer bundle
- Feature UI 独立 renderer entry
- 禁止把新 Runtime Center/Feature 业务继续堆入当前 monolithic `electron/renderer/app.js`

## 推荐执行顺序

```text
P0 candidate boundary
  -> P1 UI removal
  -> P2 management API/resource removal
  -> P3 legacy Runtime removal
  -> P4 Workbench/projection removal
  -> P5 schema/type/data cleanup
  -> P6 Feature legacy resource removal
  -> P7 absence/build/test gate
  -> D0-D8 spec revision and consistency pass
  -> Dynamic Framework Contract Pack implementation
```

D0-D8 可以与 P1-P7 并行起草，但应在 Contract Pack 开工前合并并完成全文一致性检查。

## 明确保留范围

前置删除不得误删：

- 独立 Scheduled Task 及 `task-scheduler.ts`
- 通用 Agent execution 与 Container Runtime
- 通用 Trace Store/Monitor
- 通用渠道、`InteractiveCard` 和 Assistant 自有 Card
- Feature Package Runtime 的启停、API/nav/renderer extension point
- Assistant、Today Plan、Memory、Wiki、Chat 中不依赖 Workflow/Workbench 的能力
- migration candidate 原始材料

## 最终验收

1. 主应用、Electron、Assistant 均可在无 Workflow Runtime 下构建。
2. 旧 UI/API/route/import/symbol/schema/resource path 均为零。
3. 本机 legacy 开发数据已按明确 owner path 清理，无未知路径删除。
4. `local/migration-candidates/dev-test-fix-test` hash 全部匹配且不可执行。
5. `dynamic-workflow-dag-framework.md` 不再要求迁移 `dev_test/fix_test`，不再包含不存在运行实例所需的 cutover 协议。
6. 新增缺失合同与正文类型、模块边界、实施顺序、验收标准一致。
7. Dynamic Runtime 的后续实现不包含任何候选包特例或 legacy compatibility path。
