# Dynamic Workflow Runtime 前置清理 Continuation Handoff

## 文档用途

本文汇总以下两个 Codex 会话的实际执行结果，并作为下一会话的续做状态权威：

- 原会话：`019f5f9a-ca36-7402-8870-e8da5e6c9b7c`
- 当前会话：`019f5ff1-8f80-7e30-95da-79696db0ea40`

原始范围、删除边界和 D0-D8 规范修订要求仍以以下文档为准：

- `local/docs/pre-dynamic-workflow-runtime-cleanup-handoff.md`
- `local/docs/dynamic-workflow-dag-framework.md`

本文不替代目标架构规范，也不重新定义清理范围；它只回答：两个会话已经做了什么、当前代码处于什么状态、下一会话从哪里继续、完成标准是什么。

重要：原始 handoff 中“尚未执行”一节已经过时。执行进度以本文为准，需求边界仍以原始 handoff 为准。

## 目标与已确认边界

本次任务的目标是形成一个“无 legacy Workflow Runtime、无旧 Workbench、无旧 Workflow/Card authoring surface”的可编译开发 baseline，为后续 `src/workflow-runtime/` Contract Pack 和 Dynamic DAG Runtime 实施清除语义冲突。

已经确认：

1. 新 Dynamic Runtime 不复用顶层 `src/workflow.ts`、旧 Definition/Compiler/Registry、旧 Workbench 或 `messages.db` 中的旧 Workflow schema。
2. 新实现将位于 `src/workflow-runtime/`，并使用独立 `workflow-runtime.db`。
3. `better-sqlite3` 必须保留；它不是 legacy Workflow 专属依赖。
4. 通用 Agent、Container、Trace、Scheduled Task、Feature Package Runtime、渠道、`InteractiveCard`、Assistant、Today Plan、Memory、Wiki、Chat 必须保留。
5. `dev_test/fix_test` 只作为不可执行 migration candidate 保存，不属于 Dynamic Runtime v1 的强制迁移范围。
6. 不为旧 UI/API/Runtime 建兼容层、隐藏入口、alias 或 fallback。
7. 当前开发期不迁移 legacy Workflow/Workbench 数据；最终直接建立干净 baseline schema。

## 当前工作树概况

截至 2026-07-14：

- tracked 变更：108 个文件。
- `git diff --stat`：`6219 insertions / 65216 deletions`。
- 未 stage、未 commit、未 push。
- `git diff --check` 通过。
- 工作树中的所有变更都属于本清理任务；不要 reset、checkout 或回滚。

当前未跟踪文件：

- `local/docs/pre-dynamic-workflow-runtime-cleanup-handoff.md`
- `local/docs/pre-dynamic-workflow-runtime-cleanup-continuation-handoff.md`
- `setup/legacy-workflow-boundary.test.ts`
- `src/features/data-roots.ts`

## 两个会话已完成的工作

### 1. 迁移候选包与 P0 boundary

已确认并继续保留：

- `local/migration-candidates/dev-test-fix-test/` 保存 16 份原始 legacy 资料。
- 活动 Definition/Card/Artifact Contract/Evaluator/10 个专属 Skill 已解除注册。
- `container/skills/skills.json` 已移除专属 binding，共享 Skill 保留。
- 新增 `setup/legacy-workflow-boundary.test.ts`。

boundary test 当前验证：

- migration candidate 不进入 production/build/test-helper/setup 可执行闭包。
- 活动资源中不得再出现 `dev_test/fix_test`。
- SHA-256 manifest 必须匹配。

最新验证：

```text
npx vitest run setup/legacy-workflow-boundary.test.ts
6 tests passed

cd local/migration-candidates/dev-test-fix-test
shasum -a 256 -c SHA256SUMS
16 files OK
```

### 2. P1 Electron 旧 UI 物理删除

已从 `electron/renderer/index.html` 删除：

- Workflow Definition 管理导航和 Screen。
- Card 管理导航和 Screen。
- Workbench 导航、列表、详情、创建 Screen。

已从 `electron/renderer/app.js` 删除：

- Workflow Definition form/json/graph/version/diff/editor。
- Artifact Contract 编辑。
- Card CRUD、预览、drag/drop、引用反查。
- Workbench list/detail/create/action/retry/comment/asset/realtime。
- Workflow 创建器、create options、预热、旧 WebSocket 分支和 listener。
- Today Plan 的 Workbench 选择、待处理 Card 和旧任务展示。

已从 `electron/renderer/styles/main.css` 删除大量旧 selector，并把 Knowledge/Configuration 仍使用的共享样式改为中性 `management-*`。

注意：Renderer 中仍有 Knowledge 页面使用的 `workflow-wizard-*` 共享 class。不能仅按字符串批量删除；若最终 absence gate 要求归零，必须先做 DOM selector inventory 并中性化重命名。

P7 完成后已重新验证 Electron build 通过。

### 3. P2 管理 API 与 authoring/resource 链

已从 `src/channels/web.ts` 删除旧路由与 handler，包括：

- `/api/workflow-definitions*`
- `/api/workflow-artifact-contracts*`
- `/api/workflow-actions`
- `/api/cards*`
- `/api/workflow/create-options`
- `/api/workflow/requirement`
- `/api/workbench/*`

保留：

- `/api/card-action` 通用 Card action dispatch。
- Today Plan、Wiki、Assistant、Feature、Trace 等非 legacy API。

已删除 authoring/resource 实现：

- `src/workflow-definition*.ts`
- `src/workflow-compiler.ts`
- `src/workflow-config.ts`
- `src/workflow-actions/`
- `src/workflow-artifact-contract.ts`
- `src/workflow-evaluator-registry.ts`
- `src/card-files.ts`
- `src/card-config.ts`
- `src/card-builder.ts`
- `src/schema-card.ts`
- `src/human-input-card.ts`

旧 API 404 negative tests 已补齐；未知 `/api/*` 不再回退到 SPA，而是返回 JSON 404。

### 4. P3 legacy Workflow Runtime 主体删除

已物理删除：

- `src/workflow.ts`
- `src/workflow-interrupt-command.ts`
- `src/workflow-handoff.ts`
- `src/workflow-quality-gate.ts`
- `src/workflow-stage-evaluation.ts`
- `src/workflow-evidence.ts`
- `src/workflow-llm-judge.ts`
- `src/workflow-context-pack.ts`
- `src/workflow-context.ts`
- `src/workflow-storage.ts`
- `src/workflow-requirements.ts`
- 旧 artifact/context/evaluation/handoff 专属实现及其专属测试

已完成的共享模块解耦：

- `src/card-action-router.ts` 只保留 Ask User Question、Assistant Evolution 和 Assistant Inbox Card action。
- `src/ask-user-question.ts` 不再写 Workbench projection，也不再通过旧 Runtime 完成 delegation。
- `src/container-runner.ts` 删除 Workflow runtime root 和 Feature data root 的 Workflow 专属挂载。
- `src/group-queue.ts` 停止 Agent 时不再 cancel Workflow，也不再显示 active Workflow count。
- `setup/index.ts` 删除 `workflow-groups` step。
- `src/index.ts` 删除 Runtime 初始化、interrupt text command、Workbench event/broadcast 和 Workflow-aware execution wiring。
- `src/ipc.ts` 删除 Workflow completion hook、handoff validation、Ask/Message 到 Workbench projection 和 Workbench query IPC。

普通 delegation 仍保留：

- `delegate_task`
- `request_delegation`
- `complete_delegation`
- `list_delegations`

`src/index.ts` 的 execution context 已收敛为中性的 `delegationId`，Trace source type 从 `workflow_delegation` 改为 `delegation`。

### 5. P4 Workbench 主体与 Projection 删除

已物理删除：

- `src/workbench.ts`
- `src/workbench-store.ts`
- `src/workbench-query.ts`
- `src/workbench-events.ts`
- `src/workbench-broadcast*.ts`
- `src/workbench-store.test.ts`

已删除或解耦：

- Web route/handler。
- Electron Screen、listener、WebSocket branch。
- Ask Question projection。
- Assistant Workbench trigger、主动扫描、自动 action handler。
- Today Plan Workbench task source。

P5-P7 已清除剩余 Workbench 类型、schema、渠道、MCP 和测试尾部。

### 6. Feature Runtime legacy resource 字段已部分完成

新增中性模块：

- `src/features/data-roots.ts`

它从已删除的 `workflow-storage.ts` 中抽出并保留：

- managed Feature data root。
- external Feature data root registration/listing。
- safe ID/path segment 校验。

`src/features/management.ts` 已删除：

- Workflow Definition 扫描。
- Workflow/Workbench 级联数据删除。
- legacy Workflow registry/cache reload。

保留：

- Feature 启停。
- Feature group stop/reload。
- Feature 自有 data root。
- external data root 报告但不删除。
- Feature migration、projection table、Chat/Session/Memory/Scheduled Task 等 group-owned 数据清理。

`src/features/manifest.ts` 和 `src/features/runtime.ts` 已：

- 移除 `workflowDefinitions`。
- 移除 `cards`。
- 移除 `artifactContracts`。
- 移除 `workflowEvaluators`。
- 对以上字段返回明确 `is no longer supported` 校验错误。
- 保留 `skills/agents/mcp/scripts/templates`。

Feature Runtime 测试已按新合同更新，验证通用 resources activation 和四个 removed resource key 被拒绝。

### 7. Assistant Workbench 耦合删除

`src/assistant/assistant-auto-flow.ts` 已减少约 900 行，删除：

- Workbench task/action context builder。
- Workbench action decision/prompt/execution。
- Workbench auto-action runtime。
- Workbench trigger 的 investigate/repair/auto-process 分支。

`src/assistant/proactive-engine.ts` 已删除：

- Workbench pending action scan。
- Workbench failed/cancelled/stale scan。

`src/assistant/types.ts` 已删除三个 Workbench trigger rule。

保留：

- Scheduled Task failure investigation。
- Agent Run failure investigation。
- Online error log scan/investigation。
- Today Plan coding anomaly scan/repair。
- Assistant Inbox/Evolution 非 Workbench 能力。

相关 legacy 测试已删除或改写，非 Workbench investigation/repair/evolution 场景继续覆盖。

### 8. Today Plan 已收敛为 Chat + Service Branch

`src/today-plan.ts` 已删除：

- `workbench_task_ids` association。
- `related_tasks`。
- Workbench task description/stage/action Card。
- Workbench-derived service branch。
- Recent Today Plan task aggregation和 `task_ids`。
- 邮件 prompt 中的 Workbench task section。

保留：

- manual plan items。
- chat selections。
- manual service/branch selections。
- Git commit aggregation。
- Today Plan mail generation。

`src/channels/web.ts` 的 Today Plan patch payload 已同步删除 `workbench_task_ids`。

相关测试和 container MCP response 类型已更新。

## P5-P7 最终完成状态

### P5：类型、schema、Trace 与渠道 surface

已完成：

- `src/types.ts` 删除全部 legacy Workflow/Workbench 类型，以及 message、delegation、agent query/trace、Card action 中的旧字段。
- `src/db.ts` 删除 legacy schema 创建、migration、normalizer、hydrator、accessor 和 Workflow/Workbench 级联删除 API。
- `src/db.ts` 保留一次性启动清理边界：删除已存在的 legacy table/index/column；它不提供兼容读取、alias 或 fallback。
- `src/web-db.ts` 删除 `workflow_*` DTO/read/write/schema，并能先删除引用旧列的 index，再安全删除旧列。
- 普通 Delegation、Chat、Scheduled Task、Ask User Question、Feature、Today Plan、Memory、Wiki、Agent Query/Trace schema 和 accessor 均保留。
- Trace API/UI 删除 workflow/stage filter、highlight、slow stage 与 failure metadata，保留通用 delegation、tool/file/model/container/error Trace。
- Feishu 删除 Workbench compact action 推断、pending action fallback 和旧 payload；保留 typed Ask/Assistant Card callback。
- `src/card-action-payload.ts` 删除 Workbench/Workflow reserved key，保留通用 nested payload 解析。
- `WORKBENCH_BROADCAST_TARGETS` 配置入口和 Feature context 的 `workflowAssets` alias 已删除。
- 仅由旧 Artifact Contract/Workflow Trace 使用的 CSS 已删除；Knowledge 正在使用的 `workflow-wizard-*` 共享 class 经 DOM/path inventory 后保留。

### P6：Container Agent、MCP 与 Feature migration

已完成：

- host/container execution context 收敛为仅 `delegationId`，不再注入 Workflow/stage env。
- 删除 `query_workbench_tasks`、`workbench-results` MCP、`workbench-main` profile 及所有 group 引用。
- Today Plan MCP DTO/output 删除 Workbench task、task id 和 workflow 字段，只保留 manual chat/service branch 能力。
- send message / Ask User Question IPC 删除 `workflowId/stageKey`。
- `request_human_input` 文案改为通用用户交互。
- `src/features/migrations.ts` 删除 Workflow/Workbench 表名特判，保留 Feature migration 通用 ownership/safety boundary。
- `container/agent-runner` TypeScript build 已重建，ignored `dist` 中不再含旧 MCP surface。

### P7：测试与 absence gates

已完成 legacy test 删除/改写，并保留以下受保护能力的测试：

- 普通 delegation 与授权。
- Scheduled Task。
- Agent/Container execution。
- 通用 Trace。
- Feature Package Runtime。
- InteractiveCard、Feishu adapter、Ask User Question 和 Assistant Card。
- Today Plan chat/service/mail/coding anomaly。
- Assistant Inbox/Evolution/online log/Agent Run/Scheduled Task investigation。
- Memory、Wiki、Chat。

新增/完善的 gate：

1. HTTP negative tests：全部删除的管理 API 返回 404。
2. Electron DOM negative tests：旧三个 nav key 和 Screen ID 不存在。
3. Source absence gate：旧 import/symbol/route/nav key 不进入 production。
4. Main DB fresh/existing schema gate：legacy table/column/index 为零，且受保护数据保留。
5. Web DB fresh/existing schema gate：legacy column/index 为零，message 保留。
6. Active resource gate：旧 Definition/Card/Evaluator root 和删除模块不存在。
7. migration candidate gate：16 个 SHA-256 保持匹配，且不进入 production/build/test-helper/setup 闭包。

## 最终验证结果（D0-D8 完成后）

2026-07-14 在 D0-D8、全文审计和测试时间源修正完成后，按规定顺序重新执行并全部通过：

```text
git diff --check
# passed

npm run typecheck
# passed, 0 TypeScript errors

npm run build
# passed

npm run build:electron
# passed

npm run build:assistant
# passed

npx vitest run setup/legacy-workflow-boundary.test.ts
# 1 file / 6 tests passed

npm test
# 66 files / 617 tests passed
```

完整测试首次重跑时，`src/assistant/today-plan-coding-anomaly.test.ts` 在 UTC 日期刚跨日后拿当前日期创建 Today Plan，却扫描前一日提交的 `HEAD`，导致 runner 未调用、prompt 为空。仅将该测试的 `planDate/now` 固定到 `HEAD` commit date；production scan 行为未修改。定向 3/3 通过后，以上整套门禁从头重跑并全部通过。

额外验证：

```text
npm --prefix container/agent-runner run build
# passed
```

## 本机 ignored legacy 数据清理结果

删除前已输出 owner/path/table/row 清单。只处理仓库配置和已删除实现明确拥有的 legacy 数据：

- 删除 `data/workflows`：原 `src/workflow-storage.ts` 明确拥有，删除前为 606 files / 773 directories / 2.4 MB。
- 删除空的 `data/ipc/web_main/workbench-results`：原 `query_workbench_tasks` MCP 明确拥有。
- 清理 `store/messages.db` 中 16 个 legacy table、legacy columns/indexes；仅 `workflow_storage_migration_audit` 有 3 rows，其余 legacy table 为 0 rows。
- 清理 `store/web-messages.db` 的 `messages.workflow_id`。
- `data/icarus.sqlite` 无 legacy schema，未修改。

清理后只读复核：

```text
store/messages.db: legacy_objects=0, legacy_columns=0
store/web-messages.db: legacy_objects=0, legacy_columns=0
data/workflows: absent
data/ipc/web_main/workbench-results: absent
```

受保护数据仍在：Chat 20、Messages 503、Delegations 26、Agent Queries 18、Assistant Settings 1、Memories 235。未删除 Chat、Trace、Assistant、Memory、Wiki、Feature 或 Scheduled Task 数据。

## D0-D8 最终完成状态

P0-P7 与 D0-D8 已全部完成；本前置清理任务没有剩余执行断点。`local/docs/dynamic-workflow-dag-framework.md` 已完成 393 insertions / 207 deletions 的结构化修订：

- D0：删除运行期切换、旧 writer 协调和数据删除状态机，改为 `WorkflowRuntimeAbsenceBaseline` 静态 gate。
- D1：删除具名领域资源强制迁移义务，只保留单一不可执行候选说明。
- D2：明确零 Published Recipe 也能实现、认证和 Production Activation；Intake 返回 `no_route_available`，Runtime Center 提供正常空状态。
- D3：新增 `ProductSurfaceCoverageManifest`；removed surface 固定 `replacement_ref=null` 并绑定 negative fixture。
- D4：新增 `MigrationCandidateBoundaryManifest`，覆盖 production/test-helper/setup/Registry/Compiler/build/release/runtime 不可达证明。
- D5：定义 `scaffold -> validate -> compile -> dry-run -> review -> publish -> activate` 的 CLI/API、source/staging/published ownership、diagnostics/diff、human approval 和幂等恢复。
- D6：定义 closed Feature Source/Release Manifest vNext、namespace/dependency/ownership/draining/retention；旧四个 resource key 直接拒绝，无 alias/fallback。
- D7：新增 `CardPresentationContract`、render/retention/preview 和 Wait/Business/Runtime typed action contract；明确保留通用 `InteractiveCard` 与渠道能力。
- D8：新增 Runtime Center Projection API、cursor/filter/sort/rebuild、degraded/empty/broken-link、typed deep link、server recheck 和独立 renderer bundle 边界。

全文审计结论：`legacy/cutover/purge` 在目标规范中为零；`rollback` 仅作为 closed Definition 明确拒绝的旧字段名；`dev_test/fix_test` 只出现在不可执行候选说明；旧四字段只出现在 Manifest 拒绝合同；`Workbench` 只出现在 removed surface/absence 合同。剩余 `drain/fence` 均属于 Feature release lifecycle、resume fixed-point 或新 Graph Runtime work fencing，不是旧切换协议。

## 必须保护的能力

后续工作不得误删：

- `task-scheduler.ts` 和 Scheduled Task。
- 普通 delegation IPC 和状态记录。
- 通用 Agent/Container execution。
- 通用 Trace Store/Monitor。
- Feature Package Runtime 启停、API/nav/renderer、skills/agents/mcp/scripts/templates。
- `InteractiveCard`、渠道 `sendCard`、Ask User Question Card、Assistant Card。
- Today Plan 的 manual/chat/service branch。
- Assistant 的非 Workbench Inbox、Evolution、online log、coding anomaly、Agent Run/Scheduled Task investigation。
- Memory、Wiki、Chat。
- migration candidate 原始资料。
- `better-sqlite3`。

## 实施注意事项

1. 工作树不干净，所有现有修改都要保留；不要使用 destructive git 命令。
2. 手工编辑使用 `apply_patch`。
3. 不要为了暂时通过编译恢复任何已删除 legacy 文件。
4. 删除共享模块字段时，先搜索所有生产 consumer，再更新 tests。
5. P0-P7 与 D0-D8 已完成，本清理任务关闭；Contract Pack 或 Runtime 实现需要单独授权并从目标规范 G0 开始。
6. 不要启动 `src/workflow-runtime/` 新实现。
7. 不要升级 `better-sqlite3`；版本升级属于后续 Contract Pack 阶段。

## 最终交付状态

本 handoff 不再提供续做 Prompt：P0-P7、D0-D8、全文一致性审计、ignored owner 数据清理和全部正式验证均已完成。后续工作若获单独授权，应从 `local/docs/dynamic-workflow-dag-framework.md` 的 Contract Pack/Spec Stabilization G0 开始；不得把本清理任务重新解释为恢复旧 Runtime、兼容入口或迁移候选内容。

## 最终完成确认

以下条件均已满足，本清理任务完成：

1. 主应用、Electron、Assistant 在无 legacy Workflow Runtime 下构建通过。
2. 旧 UI/API/route/import/symbol/schema/resource path 为零。
3. `messages.db` 和 Web DB 不再创建旧 Workflow/Workbench table/column/index。
4. 普通 delegation、Chat、Agent、Scheduled Task、Trace、Feature、Assistant、Today Plan、Memory、Wiki 正常。
5. migration candidate hash通过且不可执行。
6. ignored legacy 数据只在明确 owner 清单后清理。
7. D0-D8 修订完成并全文一致。
8. 后续 Dynamic Runtime 实施不需要 legacy compatibility path，也不需要迁移 `dev_test/fix_test`。
