# Dynamic Workflow Runtime 实施进度

> **状态**: IN_PROGRESS
> **当前 Gate**: G1 DDL / Store（DONE；G2 READY）
> **下一施工切片**: G2 Compiler / Sealed Golden
> **最后更新**: 2026-07-16
> **规范权威**: `local/docs/dynamic-workflow-dag-framework.md`

## 文档职责

本文是 Dynamic Workflow Runtime 的实施状态账本，用于跨会话记录已经完成的施工切片、实际交付物、验证证据、提交和下一步。本文不定义 Runtime 语义，也不替代架构规范；类型、状态、事务、Logical Schema、Gate 和验收条款冲突时，始终以 `local/docs/dynamic-workflow-dag-framework.md` 为权威，并先修正规范或 Contract Pack，不能由实现自行选择语义。

下一会话 Prompt 不写入本文。每个施工切片完成并提交后，由当前会话在最终回复中根据实际 commit 和验证结果生成下一会话 Prompt。

## 强制会话协议

每个新会话开始施工前必须：

1. 完整阅读 `local/docs/dynamic-workflow-dag-framework.md`，不得用本文或局部摘要代替全文。
2. 阅读本文，确认当前 Gate、下一施工切片、已完成证据和未解决风险。
3. 执行 `git status --short`、`git branch --show-current`、`git log -5 --oneline`，并阅读本文记录的最后一个施工提交。
4. 根据规范“实现索引”确定工作包 ID，重点复读其主要入口、必须联读、核心不变量和完整验收标准。
5. 使用 `rg` 搜索本次涉及的类型、表、事务编号、Error Code、状态值和验收关键词在规范全文与仓库中的全部引用。
6. 明确本次允许修改的模块、禁止越过的 Gate 和验收命令后再编辑文件。

每个施工切片结束前必须：

1. 完成本切片定义的代码、Contract、fixture 和测试，不把必要测试推迟到未记录的后续工作。
2. 运行与风险相称的验证，并在本文记录命令和结果；未运行的验证必须明确说明原因。
3. 更新 Gate、工作包、切片状态、交付物、风险、决策和下一施工切片。
4. 检查 `git diff --check` 和 `git status --short`，确认没有混入无关改动或生成物。
5. 将实现、测试和本文作为一个原子施工提交；提交信息必须能定位 Gate/切片。
6. 在会话最终回复中报告 commit、验证结果，并直接给出下一会话 Prompt。

若实现发现规范歧义、跨章节冲突、不可执行的 SQLite 约束或无法满足的事务预算，当前切片标记为 `BLOCKED_BY_SPEC`，记录最小复现和受影响章节；先修正规范并重新检查联动合同，不以临时 fallback、旁路或自行推断继续施工。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `READY` | 依赖已满足，可以开始，但尚无本项交付物 |
| `IN_PROGRESS` | 当前会话正在施工，尚未满足全部退出条件 |
| `BLOCKED_BY_SPEC` | 已发现必须先修改规范或确认语义的阻塞问题 |
| `BLOCKED_BY_ENV` | 已连续验证存在工具链、平台或外部环境阻塞 |
| `DONE` | 交付物、验证证据和提交均已记录，全部退出条件满足 |
| `NOT_READY` | 上游 Gate 尚未完成，不允许开始 |

状态只能根据仓库事实和验证证据更新。创建目录、类型 skeleton、mock、跳过测试或只通过 happy-path unit test 均不构成 `DONE`。

## 固定实施原则

- 单次会话只限制施工范围，不限制规范上下文；每次都完整阅读规范。
- 架构规范是语义权威，Contract Pack 是落地后的机器权威，本文只记录进度。
- 所有新 Runtime 语义实现位于 `src/workflow-runtime/`；不得向 `src/` 顶层增加新的 Workflow Runtime 模块。无 Node 前置依赖的 managed toolchain bootstrap/launcher 与既有 setup/launchd renderer 是唯一 host-infrastructure 例外，不得包含 Runtime 语义。
- 严格遵守 G0-G9 依赖。G0.1-G0.9 的历史完成 identity 保持不变；current Contract Pack root 必须完成 G0.10 Capacity control-plane addendum 后才能开始 G1 Store/DDL。G2 Compiler/Golden 不依赖 Capacity control-plane 语义，仍可基于 G0.1-G0.9 开始；Executable DDL Gate 完成前不得实现 `WorkflowRuntimeStore`、Reconciler 或 production Domain Definition。
- G0 后只有规范声明可并行的工作并行；并行工作必须拥有不重叠的文件边界和独立退出证据。
- 每个提交对应一个可独立复核、可独立回退的施工切片，不以一个巨大提交跨越多个 Gate。
- 不恢复 legacy Workflow、Workbench、Card authoring 或兼容读取路径；migration candidate 保持不可执行、不可达。
- 未通过 G8/G9 前，任何 Runtime 只能使用隔离 test-only bootstrap、Fake Adapter 和临时 data/store root。

## 初始仓库基线

初始审查基于：

- 分支：`main`
- 架构基线提交：`cc155573977c989e08f6663df1db856e1ae336d6`
- 初始工作树：clean
- `src/workflow-runtime/`：不存在
- Contract Pack、Executable DDL、Schema Manifest、Golden Bundle、Supported Limits certification：均未生成

2026-07-14 已验证：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npx vitest run setup/legacy-workflow-boundary.test.ts` | PASS，6 tests |
| legacy migration candidate boundary | 当前定向测试通过；G0 仍需机器生成的完整 absence/coverage/candidate manifests |

2026-07-15 工具链目标按本机默认开发环境重新冻结为 Node `26.5.0`、npm `11.17.0`、`darwin/arm64`。G0.1 不要求用户手工安装或切换系统 Node；项目 bootstrap 自动安装已验证的 official distribution 到 Icarus runtime home，最终 lock/native/build/test 和 Core service 只使用该 managed runtime，系统默认环境保持不变。

已知 G0 工具链差距：

| 项目 | 当前仓库 | 规范目标 |
| --- | --- | --- |
| `.nvmrc` | `22` | exact `26.5.0` |
| CI Node | hard-coded `20` | `node-version-file: .nvmrc` |
| `packageManager` | 缺失 | exact `npm@11.17.0` |
| `better-sqlite3` | `^11.8.1` | exact `12.11.1` |
| `jsonc-parser` | 缺失 | exact `3.3.1` direct dependency |
| `ajv` | 缺失 | exact `8.20.0` direct dependency |
| `ajv-formats` | 缺失 | exact `3.0.1` direct dependency |
| `json-canonicalize` | 缺失 | exact `2.0.0` direct dependency |
| `fast-check` | 缺失 | exact `4.9.0` dev dependency |
| `@types/node` | `^22.10.0` | exact `26.1.1` |
| `@types/better-sqlite3` | `^7.6.12` | exact `7.6.13` |
| Managed Node distribution | 不存在 | official `node-v26.5.0-darwin-arm64.tar.gz` + pinned archive/executable hash |
| Core service Node source | launchd 直接执行 `/opt/homebrew/bin/node` moving symlink | launchd 只执行 stable Icarus Runtime Launcher，由其选择并验证 active managed runtime |

这些差距是 G0.1 的施工输入，不是已发现的架构冲突。

Agent Container 运行于独立 VM，Node identity 由 VM image gate 保证；它不进入本机 Core launcher、SQLite certification key 或 G0.1 修改范围。Electron 内置 Node 同样不属于 Core Runtime identity。

## Gate 总览

| Gate | 状态 | 依赖 | 退出证据 | 完成提交 |
| --- | --- | --- | --- | --- |
| G0 Contract Pack / Static Baseline | `DONE` | 无 | G0.1-G0.9 historical root + G0.10 additive Capacity Admin/publication/CAP/Logical Schema/coverage root | 本原子提交 |
| G1 DDL / Store | `DONE` | G0.10 | frozen executable migration/Schema Manifest + unified Connection Factory + Store lifecycle/transaction host + real-file SQLite/identity gates | 本原子提交（G1.2） |
| G2 Compiler / Golden | `READY` | G0.1-G0.9；G0.10 不改变 Compiler/Plan 语义 | sealed Golden Bundle + compiler/toolchain hash | - |
| G3 Registry / Authoring / Publish | `NOT_READY` | G1 + G2 | manifest/authoring/publish/retention/ABI fixtures | - |
| G4 Test Bootstrap | `NOT_READY` | G1 + G2 + G3 | isolated bootstrap profile | - |
| G5 Basic Runtime | `NOT_READY` | G4 | T0-T6e model/fault fixtures | - |
| G6 Dynamic / Close | `NOT_READY` | G5 | T7/T8/child/compensation fixtures | - |
| G7 Control / Card / Projection / Recovery | `NOT_READY` | G6 | command/card/projection/recovery/blocker fixtures | - |
| G8 Certification | `NOT_READY` | G7 | certified profile meeting Product Floor | - |
| G9 Production Activation | `NOT_READY` | G8 + fresh current G0/G0.10 manifests | activation + Capacity genesis/preservation audit + startup/empty-state or Recipe smoke | - |

## 工作包总览

| 工作包 | 范围 | 状态 | 当前 Gate/切片 |
| --- | --- | --- | --- |
| I0 | Publish、Registry、Recipe 与执行版本固定 | `NOT_READY` | G3 起 |
| I1 | Intake、Routing、幂等创建、Child provenance、Claim | `NOT_READY` | G5 起 |
| I2 | Definition、State lowering、Context、transition | `READY` | G2 Definition lowering 起；Runtime 仍从 G5 起 |
| I3 | Source/Compiled IR、Port、Compiler | `READY` | G2 实现 |
| I4 | Runtime Store、SQLite relation、Value/Blob、migration | `IN_PROGRESS` | G1 migration/Schema Manifest/Store Base/Connection Factory DONE；Value/Blob 从 G3 起 |
| I5 | Graph 状态机、reconcile、Scheduler、Ledger | `NOT_READY` | G5 起 |
| I6 | Delegation/System、Capability Effect、Outbox | `NOT_READY` | G5 起 |
| I7 | Durable Wait、Signal/Timer/Approval、Inbox | `NOT_READY` | G5 起 |
| I8 | Subgraph、Expand、Map、child scope | `NOT_READY` | G6 起 |
| I9 | Completion、Cancel、Compensation、Finalization、Recovery | `NOT_READY` | G6/G7 |
| I10 | Runtime Command、Capacity Admin、Runtime Center、Trace | `NOT_READY` | G5 实现 Capacity Gateway/Publisher/Watcher，G7 实现管理 UI；当前只做 G0.10 合同 |
| I11 | Contract Pack、managed runtime toolchain/launcher、测试模型、发布门禁、absence baseline | `DONE` | G0.1-G0.10 DONE |

## G0 施工切片

G0.1-G0.9 已按当时规范完成并保留历史 identity。后续确认的 Capacity control-plane 缺口以 additive G0.10 current root 补齐，不改写或冒充既有完成 hash；current G0 只有 G0.10 满足退出条件后才能重新标记 `DONE`。

| 切片 | 内容 | 状态 | 主要退出条件 | 完成提交 |
| --- | --- | --- | --- | --- |
| G0.1 | Toolchain Identity | `DONE` | Node/npm/direct dependency/lock/CI/managed distribution/launcher identity 一致，基础构建与测试通过 | 本原子提交 |
| G0.2 | Contract Pack Foundation | `DONE` | artifact envelope、VersionedRef、hash/domain、strict parse、目录与 CI 骨架 | 本原子提交 |
| G0.3 | Closed Schemas | `DONE` | Definition/Recipe/Command/Transition/Feature/Card/Source/Compiled IR schemas 与 negative fixtures | 本原子提交 |
| G0.4 | Catalogs and Protocol Tables | `DONE` | Error/Fact/Event/Permission/Reason/Denial、状态与 T0-T8/T6e 表机器化 | 本原子提交 |
| G0.5 | Safety / Retention / SQLite Contracts | `DONE` | Safety、Capacity schema/baseline、Product Floor、Retention、SQLite Profile、Enforcement Matrix | 本原子提交 |
| G0.6 | Logical Schema Metadata | `DONE` | 全对象 Logical Schema manifest source、typed relation metadata、query catalog | 本原子提交 |
| G0.7 | Static Absence and Surface Gates | `DONE` | absence、surface coverage、candidate boundary generator/manifest/negative fixtures | 本原子提交 |
| G0.8 | Golden Draft and Review Input | `DONE` | raw cases、hand-authored semantic assertions、review request；不得伪造 sealed expected output | 本原子提交 |
| G0.9 | G0 Conformance Exit | `DONE` | Markdown/Contract 双向覆盖、完整 G0 CI、artifact hashes 和 Gate review | 本原子提交 |
| G0.10 | Capacity Control-Plane Addendum | `DONE` | Capacity Admin/publication/CAP/Logical Schema delta、Admission lineage、additive coverage/inventory/root manifest 与正反/fault-model fixtures；pin G0.9 historical root | 本原子提交 |

## G1 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 | 完成提交 |
| --- | --- | --- | --- | --- |
| G1.1 | Executable DDL / Schema Manifest | `DONE` | G0.6 + G0.10 全量 canonical SQLite migration、closed introspected Manifest、schema lint、constraint/trigger/query-plan fixtures、真实文件与 managed identity gate | 本原子提交 |
| G1.2 | Store Base / Connection Factory | `DONE` | production-target Store 基础、连接生命周期/完整 PRAGMA/read-only policy、identity gate、参数化 query API 与短写事务 host 的 candidate 开发验证 | 本原子提交 |

## 已完成切片：G1.2 Store Base / Connection Factory

**状态**：`DONE`

**工作包**：I4；只实现独立 `workflow-runtime.db` 的统一 Connection Factory、`WorkflowRuntimeStore` 基座、连接/Profile/identity gate、参数化基础查询与同步短写事务 host。没有实现 Graph Store 领域操作、Runtime、Scheduler、Watchdog、Recovery、Outbox Worker、Capacity Gateway/Publisher/Watcher、Compiler/Golden、Registry、Runtime Center/UI、Supported Limits certification 或 production activation。

I4/G1.2 把 G1.1 migration、Schema Manifest 与发布 hashes 当作 frozen 数据库结构输入。loader 精确 pin G0.10 root、G1.1 root、schema hash、migration SHA-256、deterministic digest、Schema Manifest、Executable DDL 和 SQLite Profile artifact；启动时同时重渲染 migration、重建 introspected Manifest 并逐字节比较，任一 drift 都 fail-closed，未改写任何 G0 published JSON 或 G1.1 artifact。

Store/Factory contracts：

- 所有测试、只读和写连接都由 `WorkflowRuntimeConnectionFactory` 创建；拒绝 `:memory:`、SQLite URI、非 `workflow-runtime.db` 文件名和 symlink database。Factory 区分显式 `create` 与 `open_existing`，现有数据库绝不自动 bootstrap 或迁移。
- fresh bootstrap 先设置并回验 `page_size=4096`、`auto_vacuum=incremental`，再执行 frozen migration，切换 WAL 后关闭并以正式 writer/read-only 连接重开。已有数据库在发出任何 Profile setting PRAGMA 前先验证 WAL/page size/auto vacuum，不为迎合 Profile 自动修改 database-level 属性。
- strict Profile loader 使用 closed keyset/literal enum/boolean；全部 numeric 字段必须是 finite safe positive integer，唯一例外是明确固定为 `0` 的 `mmap_size_bytes`。验证完成前没有 Profile 值进入 PRAGMA。
- writer 设置并回验 WAL/FULL/FK、busy timeout、temp store、WAL checkpoint、journal/cache/mmap、trusted schema、recursive trigger、read-uncommitted、locking mode 和 `query_only=OFF`。read-only 连接使用 SQLite readonly open，先只读验证已有 WAL/database-level Profile，再设置 connection-local Profile 和强制 `query_only=ON`；写入与关闭后查询均被拒绝。
- `WorkflowRuntimeStore` 私有持有唯一 in-process raw writer，并为基础查询持有独立 Factory read-only connection；公开 API 只有显式生命周期、参数化 row-returning query 和受限 DML transaction surface，未来 API/Scheduler 调用方拿不到 raw `better-sqlite3` writer。
- `withImmediateTransaction` 使用 `BEGIN IMMEDIATE`，拒绝 nested/concurrent、`async` function 和 thenable 返回值；callback 异常或违规完整 rollback。transaction surface 只接受参数化 INSERT/UPDATE/DELETE/REPLACE 与 readonly query，拒绝 DDL、PRAGMA、ATTACH、VACUUM、transaction control 和 row-returning write；Agent/tool/file/network 工作禁止进入 callback。

真实文件 SQLite 测试使用临时目录下的 `workflow-runtime.db`，不以 `:memory:` 替代 WAL/durability/competition：覆盖 fresh bootstrap/reopen、78-table frozen schema、已有 schema 和 WAL Profile mismatch、只读写拒绝/`query_only`、唯一 writer lifecycle、跨进程 writer contention、`BEGIN IMMEDIATE` commit/rollback、async/DDL 拒绝、连接 close，以及 production/platform identity 在数据库创建前 fail-closed。R-005 的 executable DDL feasibility 已由 G1.1 的全量 migration/constraint/trigger/query-plan/真实 SQLite Gate 实际关闭；G1.2 不修改其 artifact identity。

Frozen inputs 保持不变：

| Input                        | Identity                                                                  |
| ---------------------------- | ------------------------------------------------------------------------- |
| G0.10 current root           | `sha256:c9649b31acc99a4cb0d98e558d2be9ee4be840be2c4289803f8f5e0c7c0ce1f7` |
| G1.1 executable schema root  | `sha256:54c120e211ed28a9c2dcc2907ec728b39ce68748a07dc631d307c9aa59693f78` |
| domain-separated schema hash | `sha256:33f843e57ddc1cdae80e67d5f0254653985cd7062017a9ecee9409b389fdd26e` |
| canonical migration SHA-256  | `sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61` |
| deterministic digest         | `sha256:b97c8075984dc2ffb741dfa5b218155af28e5067d44ab2032de54f3258281dcb` |
| SQLite Profile artifact      | `sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af` |

Identity evidence：

| Identity                         | Observed value                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment/runtime surface       | `local_single_user` / `node_service`；`darwin/arm64`                                                                                                                                                                               |
| Managed Node                     | `v26.5.0`；distribution `nodejs.node-v26.5.0-darwin-arm64@1.0.0` / `sha256:0824f5044057d6ff26dc45022b842342f148b2dda2f0dd0feb17dd0b045f6cad`；executable `sha256:cbee2298aee5cc476bf8d5441e7348b627254a39d869743a5b04489028c729d4` |
| `better-sqlite3` / native module | `12.11.1` / `sha256:0000d73c6e2e94318ed2b9339139623d5a0908b195f1e761c16cfd98f9cc6229`                                                                                                                                              |
| SQLite version / source id       | `3.53.2` / `2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24`                                                                                                                                  |
| SQLite compile-options           | `sha256:b7145e6588d91dfdd16bd436e94007463fd4d69b6644beacc3d11ab111625d12`                                                                                                                                                          |
| Runtime Launcher                 | installed/checked-in bytes match；observed `sha256:70377ade0ba2f3e969c62bab240a91549e1173270354e1d3f815282dd5213ae0`                                                                                                               |
| Core release/certification       | development checkout binding 可验证；Profile release/launcher certification identity 保持 `null`，`release_identity_status=missing_until_g8`，整体为 `candidate/not_certified`                                                     |

规范可明确区分 G1.2 candidate 开发验证与 G8 production identity enforcement：candidate 模式验证当前可用 managed Node/native SQLite/installed Launcher/development Core binding，production 模式在创建或打开数据库前因 Profile 未认证且 release/launcher identity 缺失而 fail-closed，没有伪造 G8 identity 或放宽 gate。

最终退出验证证据（全部命令均通过 `./scripts/runtime-toolchain.sh exec -- <command>` 串行执行）：

| 命令/证据                              | 结果                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run contracts:check`              | PASS；含 deterministic/read-only `store:check`，fresh real-file bootstrap + reopen、frozen schema/Profile/identity 全通过；仅有既有 R-010 DEP0205 非阻塞告警                                    |
| `npm run test:g1.1`                    | PASS，1 file / 8 tests；G1.1 historical executable schema verification 保持通过                                                                                                                 |
| `npm run test:g1.2`                    | PASS，1 file / 10 tests；覆盖 strict Profile/drift、bootstrap/reopen/mismatch、readonly/query-only、writer ownership/contention、transaction/close/identity fail-closed                         |
| `npm run typecheck`                    | PASS                                                                                                                                                                                            |
| `npm run test:g0`                      | PASS，15 files / 109 tests；G0 historical verification 全部通过                                                                                                                                 |
| `npm test`（连续两次串行复核）         | 两次均为 78/79 files、716/717 tests；G1.2 两次 10/10、G1.1/G0.6/toolchain 及其余 716 tests 通过，唯一失败均为范围外 R-012 `credential-proxy` 250ms async trace intermittent；未修改或放宽该测试 |
| `npm run build`                        | PASS                                                                                                                                                                                            |
| targeted Prettier / `git diff --check` | PASS                                                                                                                                                                                            |
| frozen/boundary scan                   | PASS；G0 published JSON、G1.1 JSON/SQL/Schema source 无 diff；无 Graph Store 领域操作、Runtime/Scheduler/Recovery/Outbox/Capacity/Compiler/Registry/UI/certification/activation 越界实现        |

## 已完成切片：G1.1 Executable DDL / Schema Manifest

**状态**：`DONE`

**工作包**：I4；只实现 executable SQLite migration、closed Schema Manifest、introspection/environment gate、schema lint 与 fixtures。没有实现 production `WorkflowRuntimeStore`、Connection Factory、query API、Runtime、Scheduler、Compiler/Golden、Registry、Runtime Center/UI、production activation 或 Supported Limits certification。

I4/G1.1 以 immutable G0.6 Logical Schema 与 additive G0.10 Capacity Logical Schema delta 为唯一逻辑输入，生成覆盖全部 v1 持久化对象的 canonical migration。最终包含 78 tables、1,283 columns、78 PK、136 UK、355 FK、814 CHECK、32 logical indexes、10 immediate triggers、46 external references、31 fixed query-plan fixtures，共 257 条 migration statements；不是 Graph happy path 子集。

closed Schema Manifest 固定逐表 SQL、column/type/nullability/default、PK/UK/FK/CHECK/index、typed relation target metadata、external reference validator owner 与 query fixtures，并使用 `icarus:workflow-runtime-schema:1\n` 计算 domain-separated `schema_hash`。真实 SQLite 文件在 migration 前设置 `page_size=4096` 与 `auto_vacuum=incremental`，migration 后切换 WAL、关闭并重开，再验证 database/connection PRAGMA、writer/read-only `query_only`、`integrity_check` 和 `foreign_key_check`。Manifest 从 `sqlite_schema`、`pragma_table_info`、`foreign_key_list`、`index_list` 重建后与发布快照逐字节一致。

内部多类型关系全部展开为 typed nullable FK 加 exactly-one CHECK；lint 拒绝裸 polymorphic kind/id、无 target metadata 的 internal `*_ref`、generic `error_json/error_text/error` 字段和 `ref/hash` 缩写。Capacity Head/Admin Command/Invocation/Change Event 的 CHECK/FK/UK/index/hash-chain intent 已进入 DDL 与 fixtures，并明确验证重复 `recovered`、`failed`、`unauthorized_file_rejected` 不受错误的全局 UNIQUE 限制。

SQLite 可执行性判定：G0.10 的 nullable lineage parent keys `assigned_change` 与 `assigned_lineage` 不能作为 SQLite partial UNIQUE index 的 FK parent，因此 migration 使用普通 UNIQUE index；SQLite 对多个 NULL 的既有语义保持等价，同时 parent key 对 FK 合法。Confirmation TTL 依赖 parent Command 的 `created_at_ms`，无法由 row-local CHECK 精确表达，因此由命名 INSERT/UPDATE immediate triggers 强制 `expires_at_ms = command.created_at_ms + 300000`，未放宽约束。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G1.1 executable schema root | `sha256:54c120e211ed28a9c2dcc2907ec728b39ce68748a07dc631d307c9aa59693f78` |
| domain-separated schema hash | `sha256:33f843e57ddc1cdae80e67d5f0254653985cd7062017a9ecee9409b389fdd26e` |
| canonical migration SHA-256 | `sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61` |
| deterministic digest | `sha256:b97c8075984dc2ffb741dfa5b218155af28e5067d44ab2032de54f3258281dcb` |
| Schema Manifest / contract | `sha256:42db16f9f104c5a6ebc7570baced9049a80dbfb047ddfcb46f478a62b04091b0` / `sha256:2c2394f481fc9b57d8d8f396e1e2a9ce5319f1ea59a214c915b2a330a86b4afd` |
| Executable DDL artifact | `sha256:61d3e32bfb5733d8adcc3b5b93c7f61462b836eb69fb04df0a5dbcb834bd5d58` |
| Query plan / constraint-trigger fixtures | `sha256:35b7a27e241d32436de70dc937ce9b20c7bfd46041835ac8c4712b85a27dc076` / `sha256:71b738b6bd63dfadd5e960665767c5f191c60de12f81a46380604f6a900cce61` |
| Schema lint / domain separator catalog | `sha256:fd6c4381d3c3012325bfbd2a780ce6514289360dd86f4038337b9d74e3981905` / `sha256:49065b8d9063e25754a80d731b47b1088bcb67fc71720487c909b11a26147eaf` |
| G1 historical Contract JSON verification digest | `241f17fa352b15b198cfcb5c28cb892b669d22ca1d3736a90c99622a0431f2f3` |

SQLite / runtime identity：

| Identity | Observed value |
| --- | --- |
| Managed Node | `v26.5.0`；active content-addressed `darwin/arm64` executable，非 Homebrew/system Node |
| `better-sqlite3` / native module | `12.11.1` / `sha256:0000d73c6e2e94318ed2b9339139623d5a0908b195f1e761c16cfd98f9cc6229` |
| SQLite version / source id | `3.53.2` / `2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24` |
| SQLite compile-options hash | `sha256:b7145e6588d91dfdd16bd436e94007463fd4d69b6644beacc3d11ab111625d12` |
| SQLite profile / certification | `candidate` / `not_certified` |

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate`（连续两次） | PASS；G1 root、schema hash、migration hash 与 deterministic digest 两次逐字节一致；先只读验证 immutable G0，再只生成 additive G1 artifact |
| managed `npm run contracts:check` / `npm run schema:check` | PASS；read-only check，真实 SQLite 文件、完整 PRAGMA/identity/integrity/FK/introspection gate 全通过；仅有 R-010 DEP0205 非阻塞告警 |
| managed `npm run test:g1.1` | PASS，1 file / 8 tests；覆盖递归 closed keyset、快照重建、全部 enum CHECK、typed exactly-one relation、Capacity 重复结果/hash chain/TTL trigger、query-plan fixtures 与 lint |
| managed `npm run test:g0` | 首次 PASS，15 files / 109 tests；最终串行重跑为 14/15 files、108/109 tests，G0.6 8/8 与所有 Contract gates 通过，唯一失败为 R-015 launcher case 5.484s 超过默认 5s；紧随其后的完整 suite 中同一 toolchain file 5/5 PASS |
| managed `npm run typecheck` / `npm run build` | PASS |
| managed `npm test` | 最终串行 run 为 77/78 files、706/707 tests；G1.1 8/8、G0.6 8/8、toolchain 5/5 与其余 706 tests 通过，唯一失败为范围外 R-012。更早一次 full-suite run 为 75/78 files、702/706 tests，另命中 R-013 与 R-015 timing；未修改这些范围外测试 |
| targeted Prettier / `git diff --check` | PASS |
| historical/boundary scan | PASS；G0.1-G0.10 published JSON 无 diff，G0.10 root 仍为 `sha256:c964...1f7`；无 Store/Connection Factory/query API/Runtime/Scheduler/Compiler/Golden/Registry/Runtime Center/UI 实现 |

## 已完成切片：G0.10 Capacity Control-Plane Addendum

**状态**：`DONE`

**工作包**：I11；合同联动 I4/I5/I10。只补齐 Capacity Admin 控制面机器合同、Logical Schema metadata delta 和 conformance，不实现 executable DDL、Store、Capacity Gateway/Publisher/Watcher、Scheduler、Runtime Center 或 UI。

架构规范已确认：Production v1 普通修改只允许认证 `human:local-owner + runtime.capacity.manage`；部署工具/CLI/Runtime Center 只是 entrypoint。修改使用 closed full-snapshot Command、expected revision+config hash CAS、必填 reason、immutable Command/Invocation/Event audit、唯一 Publisher、file/directory fsync + atomic rename、committed-head Watcher validation 与 crash recovery。checked-in `config/workflow-runtime-capacity.json` 保持 bootstrap baseline，活动 publication 位于 `data/workflow-runtime/workflow-runtime-capacity.json`；Admission 必须保存 `capacity_revision/capacity_change_id/capacity_config_hash`。

必须交付：

- 新增 closed `DeploymentRuntimeCapacityPublication` 与 `CapacityAdminCommand` union（一次性 `InitializeDeploymentCapacityCommand` + 普通 `ReplaceDeploymentCapacityCommand`）schema/type/domain hash/positive-negative fixtures，不修改既有 7-field Capacity payload 和 G0.5 checked-in baseline bytes/hash。
- 新增独立 `runtime.capacity.manage` Permission、Capacity Reason/Denial Catalog 与 CAP0-CAP4 declarative protocol；不得把 Capacity 扩展成 Workflow Runtime Command target，不改变既有 Workflow Command union/catalog bytes。
- 以 additive Logical Schema delta 定义 `runtime_capacity_head`、`runtime_capacity_admin_commands`、`runtime_capacity_admin_invocations`、`runtime_capacity_change_events`，并扩展 Scheduler Admission metadata 为 revision/change id/config hash；固定 CHECK/FK/UK/index/query intents 与 transition/hash-chain invariants。
- 新增授权、stale CAS、相同 hash 新 revision、minimum-free-disk increase-only、idempotency duplicate/conflict、direct-file tamper、CAP crash/restart recovery、genesis/upgrade-preservation 的 fixture/model manifest；本切片不实现实际 filesystem writer 或 SQLite transaction。
- 新增 G0.10 additive manifest、Markdown/Contract delta coverage、artifact inventory 与 Gate review，精确 pin 住 G0.9 root 和 G0.1-G0.9 historical identities；current G0 root 只包含显式 prior-root + addendum closure，不回写既有 G0.9 artifact inventory 冒充原始完成证据。
- 接入 deterministic generate/read-only check、TypeScript conformance、targeted Vitest 与完整 `test:g0`；更新静态边界，保证本切片没有创建 DDL/Store/Runtime/Runtime Center/UI 或 `conformance/sealed/` artifact。

规范修改后的预期红灯基线：managed `npm run test:g0.9` 为 6/8 tests PASS，2 tests 因 `markdown_values_without_contract` 拒绝新增 `semantic_format:icarus.deployment-runtime-capacity-publication/1`。这证明 G0.9 drift gate 正常工作；G0.10 必须通过 additive coverage/manifest 关闭该红灯，不能通过删除正文格式、放宽 closed schema 或改写既有 G0.9 expected artifact 绕过。

### 2026-07-16：G0.10 施工暂停检查点（IN_PROGRESS）

本次从规范提交 `4f51b7913e54a1316e63a2ab6d4a28dc0d7449dc` 开始，已完整阅读架构规范和本进度账本，复核其父提交为 G0.9 原子提交 `b8d1b7f95bba26f825b588c466379c2f529c9aa4`，并复现 managed `npm run test:g0.9` 的预期 6/8 PASS 红灯。暂停时工作树只有 6 个未跟踪 TypeScript 草稿；没有 G0.10 JSON、没有修改 G0.1-G0.9 historical JSON、没有创建提交。

暂停前 managed `npm run typecheck` 为 FAIL，共 8 个错误：3 个 readonly catalog array 与 mutable `JsonValue` 不兼容；mapped Capacity reason entry 的 `reason_code` 扩大为 `string` 并引发 3 个关联错误；historical hash 的 literal-union `includes` 不接受一般 `sha256` 值；historical inventory entry 的 `owning_slice/artifact_class` 扩大为 `string`。当时 Gate 状态保持 current G0/I11 `IN_PROGRESS`、G1 `NOT_READY`、G2 `READY`，R-014 保持 `OPEN_BLOCKING_G1`。

### 2026-07-16：G0.10 最终完成

I11/G0.10 已交付 additive Capacity control-plane machine contract，并保持 G0.1-G0.9 published JSON 和 G0.9 generator source 的 historical identity。closed publication 与 command union 精确复用 G0.5 七字段 Capacity schema；独立 permission/reason/denial catalog、CAP0-CAP4 声明协议、四表 Logical Schema delta、三字段 Admission lineage、coverage/inventory/Gate review/root manifest 与 7 positive / 23 negative / 13 fault cases 均已闭合。授权模型在幂等判定前拒绝 delegation chain、Feature、Automation、Workflow 和 business API proxy。

G0.10 仅在 `src/workflow-runtime/contracts/conformance/capacity-control-plane-addendum/` 生成 26 个 JSON（25 个 manifest member + root）；没有 executable DDL、Store/Connection Factory、Capacity Gateway/Publisher/Watcher、Scheduler、Runtime Center/UI、Golden review/seal 或 `conformance/sealed/` 写入。current G0/I11 恢复 `DONE`，G1 转为 `READY`，G2 保持 `READY`，R-014 关闭。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G0.10 Capacity Control-Plane Addendum root | `sha256:c9649b31acc99a4cb0d98e558d2be9ee4be840be2c4289803f8f5e0c7c0ce1f7` |
| Generator tool | `sha256:cf6979d2dedb52923f37028e71636522c0e6bbc32eefb456a016aec3ac51f513` |
| Markdown delta coverage | `sha256:42ac7e849edd0a7a84ba0ab1d272fa27e22d780f883768741e69aa619a1e5b52` |
| Artifact inventory | `sha256:c74237dbd60acc7fa9059323b5bd5c38e360c3ffc0b333ad075d94b2907ea23b` |
| Gate review | `sha256:e29e0fbee09aef914ed60a83960e1944db2460490f00c526c37549f130fbe86b` |
| CAP0-CAP4 protocol | `sha256:ce4276b4a5902ffb646d22b834ff8cf07cddd619afa51096c510305e0b27e3a0` |
| Logical Schema delta | `sha256:e8917c737b1eae0f62abfa2de2dec6dc71875122a763882a46aee34c5c84cae6` |
| Full Contract JSON tree / G0.10 isolated tree digest | `2bcc69bdcf2853e4158cc656d39fec5b721914d48282687777cb53e0517b6464` / `c6921a6e7fb1b51ace3004cfcce2fee82f9cd68d1552fb814aae194c86056067` |

Historical identities 精确保持：G0.9 `sha256:df3058a93eaeb85bdb3eeadc7923148a9a543f63c33d0ede2cc7be0a758c9f5e`、G0.2-G0.8 均保持原 manifest hash、Capacity schema `sha256:30aa123506c8f37a3d0c291d20feab150e7103c3f83c12775c49d323f9de7ec4`、Capacity baseline `sha256:970a63fdba1e263189c3070201a543f01508180abb1e8c15cf649a3780c17542`。

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate`（连续两次） | PASS；完整 Contract JSON tree 与 G0.10 isolated tree 两次 digest 分别一致为 `2bcc69bd...6464` / `c6921a6e...6067`；仅有 R-010 DEP0205 非阻塞告警 |
| managed `npm run contracts:check` | PASS；check 前后两个 tree digest 和 `git status --short` 完全一致，证明只读 |
| managed `npm run typecheck` | PASS |
| managed G0.2-G0.10 directed tests | PASS，9 files / 80 tests |
| managed `npm run test:g0` | PASS，15 files / 109 tests；包含 Contract check、G0.1-G0.10、legacy boundary 与 run-once isolation |
| managed `npm test` | 75/77 files、697/699 tests；只复现范围外既有 R-012 与 R-013。G0.10 和其余 697 tests 通过；R-012 单文件仍为 20/21，R-013 单文件 8/8 PASS（4.635s）；未修改相关文件 |
| managed legacy boundary / run-once root isolation | PASS，1 file / 6 tests；2 files / 10 tests |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` / `git diff --check` | PASS |
| historical identity / absence / sealed / DDL-Store-Runtime-UI scan | PASS；G0.1-G0.9 JSON 无 diff，sealed 仅 `.gitkeep`，G0.10 26 个隔离 JSON，无越界实现或活动 publication |

## 已完成切片：G0.9 G0 Conformance Exit

**状态**：`DONE`

**工作包**：I11；只完成 G0 Contract Pack/Static Baseline 的机器化退出证明、完整 conformance/CI 入口和 Gate 状态收敛，不创建或批准 Golden 语义审核，不执行 sealing，不实现 G1/G2 或后续 Runtime/UI。

I11/G0.9 已完成 Markdown/Contract 双向 coverage、G0.1-G0.8 完整 artifact hash inventory、G0 Gate review、absence/status/identity exit proof、closed schema、TypeScript conformance、正反例和确定性 generate/read-only check。全部 G0 exit criteria 已满足，因此 G0/I11 转为 `DONE`；依赖 G0 的 G1/G2 同时转为 `READY`，G3-G9 仍为 `NOT_READY`。

已完成交付：

- Markdown/Contract coverage 对架构规范中的 19 个 semantic format、27 个 `WorkflowCompilerErrorCode`、13 个 Runtime Fact、39 个 Runtime Event 和 22 组状态机的 101 个 state value 建立 199 条双向记录；每条记录固定 Contract pointer、规范章节/anchor、变更影响和 fixture。检查只存在于 conformance 工具，Runtime 不读取 Markdown。
- artifact inventory 覆盖 9 份 G0.1 toolchain identity、7 份 G0.2-G0.8 pack manifest、76 份 manifest member artifact、40 份完整 raw source bytes 和 1 份 Capacity baseline，共 133 项；逐项保存 path、slice、format/class、byte length、raw SHA-256 和 semantic hash。G0.9 自身 9 份 leaf artifact 由根 manifest hash closure 所有，避免 self-reference。
- G0 Gate review exact pin G0.1 Managed Distribution/locked inputs/lock identity 与 G0.2-G0.8 原 manifest hash；9 条 exit criterion 全部为 pass，并固定 absence、Product surface、candidate boundary、Golden pending/unsealed、SQLite candidate/not-certified 和 G1/G2 dependency status。
- 新增 3 个 Draft 2020-12 closed schema、8 positive / 20 negative fixtures。反例覆盖 Markdown forward/reverse drift、state/fixture/change-impact drift、prior/toolchain identity drift、inventory missing/duplicate/raw/semantic hash drift、raw source missing、Golden approval/sealed write、SQLite false certification、DDL 越界、exit criterion 缺失和 downstream Gate 状态越权。
- 新增 `test:g0.9` 和完整 `test:g0`；CI 在 format/typecheck/full test 前执行完整 G0 conformance，统一覆盖只读 Contract Pack check、G0.1 toolchain/Launcher、G0.2-G0.9、legacy boundary 与 run-once root isolation。
- G0.4 catalog directory boundary 仅允许新增已知 `g0-conformance-domain-separators.json`；G0.4 manifest bytes/hash 未改变。G0.1-G0.8 identity 全部精确保持进度账本原值。
- `conformance/sealed/` 仍只有 `.gitkeep`；未创建 `GoldenSemanticReview`、approval、reviewed expected Plan/proof/program bytes/hash、Golden Bundle 或 `golden-seal`。`local_single_user_sqlite@1` 继续为 `candidate/not_certified`；没有 executable DDL、Schema Manifest、Store/Connection Factory、Production Compiler/normalizer/lowerer/proof、Registry/Runtime、Runtime Center/UI 或 certification artifact。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G0.9 G0 Conformance Exit manifest | `sha256:df3058a93eaeb85bdb3eeadc7923148a9a543f63c33d0ede2cc7be0a758c9f5e` |
| Markdown/Contract coverage semantic / artifact | `sha256:f9820ff3c702eb6cd90f7b182e7083e1e705ca32ba0e9100034a199bfcc10cf3` / `sha256:67fd65c6a14cf94afc042582f4fe07da8f4c4127ec7971b03dfc95205aab626a` |
| Artifact inventory semantic / artifact | `sha256:aa19a6dd77da2889d0a397898f2e546dbc87b84b4e8cb2e650b53a571ec52d0f` / `sha256:1e525d38e59d374b8304351b398b289485bc725a5bfa81a1c9ffd5fb46afc94f` |
| G0 Gate review semantic / artifact | `sha256:6857ee91eb64e615c010036b7c11d9e1200ad1140d6b3ad90b879372df6ff2df` / `sha256:cdc4426a3d4d4d94029c5d53c2c0905b04630a04d9be8f2cc643808bbb9b9388` |
| Coverage / inventory / Gate review schemas | `sha256:b4bfd409d3f201c966a69339dae1135cacac9cbc50f1edbac08841b30a4acb67` / `sha256:c8a5ec915f39e39a2962fa1f362cef67e1e8dba019d2179d296ee9f0a52d1687` / `sha256:25d535765586e3f4ff1452647f6a24790bb65808348dee5bfe9ce8fac0720555` |
| Positive / negative fixture artifacts | `sha256:bf10c671fe0552637be40642b8def8bc4ee0f04c5eb4416d5c11862a38923efc` / `sha256:9c4de554af1763d6889bc46d87feccf9c583b0959325975a0ae7771836e84678` |
| G0 Conformance domain separators / generator tool | `sha256:f41aa416190c5d670e02f0ff15940461a5250e82d69a234b00e93ee56b432238` / `sha256:a2cc8711054a26598fedfb50beec6089dc8694d3e6e86ff7fe6cb861086bf233` |

Prior identity 精确保持：G0.1 Managed Distribution `sha256:0824f5044057d6ff26dc45022b842342f148b2dda2f0dd0feb17dd0b045f6cad`、locked inputs `sha256:3ad720b0283ec45be37acb596f8afb1e50a40f177fbc0c3ee2ff419aba43557b`、package lock `sha256:2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085`；G0.2 `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d`、G0.3 `sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8`、G0.4 `sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607`、G0.5 `sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428`、G0.6 `sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520`、G0.7 `sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2`、G0.8 `sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22`。

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate`（连续两次） | PASS；两次 G0.9 manifest 均为 `sha256:df3058a...c9f5e`，G0.2-G0.8 manifest identity 精确不变；仅有 R-010 DEP0205 非阻塞告警 |
| managed `npm run contracts:check` | PASS；G0.2-G0.9 完整合同只读检查通过 |
| managed `npm run test:g0` | PASS，14 files / 104 tests；包含 G0.1 toolchain/Launcher、G0.2-G0.9、legacy boundary 和 run-once isolation |
| managed `npm run typecheck` | PASS |
| managed G0.2-G0.9 directed tests | PASS，8 files / 75 tests；分别为 11 / 5 / 7 / 9 / 8 / 18 / 9 / 8 tests |
| managed `npm test` | 75/76 files、693/694 tests；唯一失败为范围外 R-012 `credential-proxy` 250ms async trace intermittent，G0.9 与其余 693 tests 全部通过。R-013 本次未复现，G0.6 全量与定向均通过 |
| managed legacy boundary | PASS，1 file / 6 tests |
| managed run-once root isolation | PASS，2 files / 10 tests |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` | PASS；全部 Contract Pack TypeScript、README、package script 与 CI YAML 符合 pinned Prettier |
| final absence/status/identity/boundary scan | PASS；199 coverage、133 inventory、8 slice identity、9 exit criteria、40 raw source、2 snapshot、5 G0.8 schema、10/30 Compiler cases、8/25 G0.8 fixtures均闭合；sealed 仅 `.gitkeep`，无 Golden approval/seal、DDL/Store/Compiler/Registry/Runtime/UI/certification artifact |
| `git diff --check` | PASS |

## 已完成切片：G0.8 Golden Draft and Review Input

**状态**：`DONE`

**工作包**：I11；只实现未 sealed 的 Compiler Golden Draft、完整 test-only Compiler 输入 snapshot、手写 diagnostics/normalized semantic assertions 与 immutable review input，不实现 Golden approval/sealing、Production Compiler、DDL/Store、Registry、Runtime 或 UI。

I11/G0.8 已完成规范要求的全部 Compiler positive/negative conformance draft case、raw source bytes、Registry/Interface/Policy/Safety snapshot、closed schema、domain hash、TypeScript conformance、review request/report input、正反例和确定性 generate/read-only check。G0 总 Gate 继续为 `IN_PROGRESS`，仅 G0.9 转为 `READY`；G1-G9 未推进。

已完成交付：

- `conformance/draft/cases/` 保存 40 份完整 raw source bytes；10 个正例覆盖 static lowering、condition/route、wait、subgraph、expand、map、policy intersection、quality revision capability binding、不同 hash 的 sound subtype proof 与 static child closure。
- 30 个负例覆盖全部 27 个 `WorkflowCompilerErrorCode`、quality revision 缺少 feedback schema/quality gate，以及 Definition Notification `delivery_requirement` 和 Child `creation_key_template` 两个 removed field；diagnostic code/phase/pointer/stable object id 与 normalized semantic assertions 均为 hand-authored 输入。
- 两份完整、`test_only` 的 Compiler 输入 snapshot 冻结 Registry resources、Interface、complete Policy、`local_single_user_safety@1` 和 Compiler/toolchain/error-catalog identity；integrity mismatch 使用独立 snapshot，snapshot 不可用于 production launch。
- 新增 5 个 Draft 2020-12 closed schema、TypeScript keyset/enum conformance、独立 domain-separator registry，以及 8 positive / 25 negative Contract Pack fixtures；正反例覆盖 hash/coverage/snapshot/diagnostic/review/sealed/oracle isolation/candidate certification 边界。
- review owner 固定为 `human:local-owner`；immutable review request 与 golden-review report input 均为 `pending/not_run`。所有 case 的 expected Plan bytes/ref/hash、proof hash 和 program hash 保持 `null`，未创建或伪造 `GoldenSemanticReview`、approval record、review report、reviewed expected bytes/hash 或 Golden Bundle。
- generate/check 只使用 strict parse、generic JCS/domain hash 和 Draft source；未 import 或调用 Production Compiler、normalizer、lowerer 或 proof 实现。`conformance/sealed/` 仍只有 `.gitkeep`，未运行或创建 `golden-seal`。
- CLI、public export、Contract Pack README 与 `test:g0.8` 已接入；G0.2-G0.7 manifest identity 精确 pin 住。`local_single_user_sqlite@1` 继续为 `candidate/not_certified`，没有 executable DDL、Schema Manifest、Store/Connection Factory、Registry/Runtime、Runtime Center/UI 或 certification。

最终 Artifact hashes：

| Artifact                                                                 | Hash                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0.8 Golden Draft Contract Pack manifest                                 | `sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22`                                                                                                                                                                                                                                                                                                                 |
| Golden Draft manifest / case catalog                                     | `sha256:b6cc1dc5512b4a7d50973304ba81e1b6f05ce6a3c684559194b2b3bf4e02e72b` / `sha256:20be39783a5c775c0d804ce16db683540b72bcc2aa1750f9f1b93c9b7c1c4aa3`                                                                                                                                                                                                                                     |
| Complete base / integrity-mismatch input snapshot                        | `sha256:0c251df1bb92f331c953ac00938d9a0903a07270d25525a372683bd17e58a6e9` / `sha256:bfd174e78250899dc3a3e7c4de43684f75b8d3ec01ee307d9da3bdda87eef3c1`                                                                                                                                                                                                                                     |
| Review request / review report input                                     | `sha256:9c3946f938f2f3589abdc6d2c24eb1692d1534bac3ddbbf2160fc523cbe49722` / `sha256:be2369a273934d1eec07bc3425a1818bd4091ce9d911710dca7dcd60ed88e855`                                                                                                                                                                                                                                     |
| Snapshot / case / Draft manifest / review request / report input schemas | `sha256:9d6931c548a8a9d7159bc44a733975cc1a750e8fb91d60a671427ede163d0aab` / `sha256:6ab497a13787ade61fd27dbf251d4b7de73f8fe14700b26783fd3612a1bf7528` / `sha256:05b4a30921e4caccb4dd69d834780121e49f159a415b50d85897130969112261` / `sha256:b3c616080fa8fc744af528e546caa592b2283e57fdc47280d873746161d9f2a1` / `sha256:ee8f9f66c4f10fbb3a8b99d5d7916a91084fd11f6c52451511750f252b21d46b` |
| Positive / negative fixture artifacts                                    | `sha256:f551fce0959cd400108405c17cbe9f4ba8e12cdf03cf7a376c9d09bc5ed78a2f` / `sha256:02d430cfa7b4c3d27d99f4fba948d9c5066b35ee05d64609f859f7e3897c9b6c`                                                                                                                                                                                                                                     |
| Golden Draft domain separators                                           | `sha256:9e689283712159e9613bc603a2d4f1cec6fb026b89def13aedccc802f2395377`                                                                                                                                                                                                                                                                                                                 |
| Raw source aggregate / generator tool                                    | `sha256:6e091c253086ed3df9a7dddeb90c0d1ef5c5038e92688c5f08a9e5ff847b40c5` / `sha256:154b8beb4e2e498b168548a606a10c6ec9c6510029892a7c05e6fc79fcce2060`                                                                                                                                                                                                                                     |

Prior Contract Pack identity 保持不变：G0.2 `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d`、G0.3 `sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8`、G0.4 `sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607`、G0.5 `sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428`、G0.6 `sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520`、G0.7 `sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2`。

最终退出验证证据：

| 命令/证据                                        | 结果                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| managed `npm run contracts:generate`（重复执行） | PASS；G0.8 manifest 稳定为 `sha256:52fc026...fd22`，G0.2-G0.7 identity 均精确不变；仅有 R-010 DEP0205 非阻塞告警                                                                                                                                                                                                                                                                               |
| managed `npm run contracts:check`                | PASS；G0.2-G0.8 完整合同只读检查通过，hash 与 generate 一致                                                                                                                                                                                                                                                                                                                                    |
| managed `npm run typecheck`                      | PASS                                                                                                                                                                                                                                                                                                                                                                                           |
| managed G0.2-G0.8 directed tests                 | PASS，7 files / 67 tests；分别为 11 / 5 / 7 / 9 / 8 / 18 / 9 tests，G0.8 check 内执行 8 positive / 25 negative Contract Pack fixtures并验证 10 positive / 30 negative Compiler cases                                                                                                                                                                                                           |
| managed `npm test`                               | 首次 74/75 files、685/686 tests，仅命中范围外 R-012；最终复跑 73/75 files、684/686 tests，除 R-012 外，既有 G0.6 deterministic test 在并发负载下以 5.011s 超过默认 5s timeout，随后单文件 8/8 tests、4.29s PASS。G0.8 全部通过；未修改 credential-proxy/trace 或 G0.6 timeout/实现                                                                                                               |
| managed run-once root isolation tests            | PASS，2 files / 10 tests                                                                                                                                                                                                                                                                                                                                                                       |
| managed legacy boundary                          | PASS，1 file / 6 tests；继续消费 G0.7 machine proof                                                                                                                                                                                                                                                                                                                                            |
| managed `npm run build`                          | PASS                                                                                                                                                                                                                                                                                                                                                                                           |
| managed targeted Prettier `--check`              | PASS；全部本切片 TypeScript/README/package 符合 pinned Prettier                                                                                                                                                                                                                                                                                                                        |
| final draft/review/absence/boundary scan         | PASS；40 raw source、2 snapshot、5 schema、10/30 Compiler case 全覆盖；sealed 目录只有 `.gitkeep`，无 GoldenSemanticReview/approval/golden-seal/Golden Bundle、Compiler/normalizer/lowerer/proof、DDL/Store/Registry/Runtime/UI/certification artifact，16 candidate archive files、12 active/10 removed surfaces 和 credential-proxy/container/Electron/assistant/setup/build/lock 边界无改动 |
| `git diff --check`                               | PASS                                                                                                                                                                                                                                                                                                                                                                                           |

## 已完成切片：G0.7 Static Absence and Surface Gates

**状态**：`DONE`

**工作包**：I11；只实现静态 absence、Product surface coverage、migration-candidate boundary 与测试 root 隔离证明，不实现 Golden Draft、DDL、Store、Compiler、Registry、Runtime 语义、Runtime Center 或 UI。

I11/G0.7 已完成 `WorkflowRuntimeAbsenceBaseline`、`ProductSurfaceCoverageManifest` 与 `MigrationCandidateBoundaryManifest` 的 closed schema、机器生成 artifact、TypeScript conformance、正反例、确定性 generate/read-only check 和 legacy boundary 接入。G0 总 Gate 继续为 `IN_PROGRESS`，仅 G0.8 转为 `READY`；G1-G9 未推进。

已完成交付：

- 机器 proof 从 TypeScript AST/import graph、Web route enumeration、Electron DOM inventory、Feature manifest parser、fresh/configured-existing SQLite schema inspection 和 configured filesystem roots 生成；不以手写文件列表替代 source/API/UI/schema/filesystem/resource reachability 证明。
- absence baseline 对 removed production source、API、UI、legacy schema/filesystem/resource root 和 12 个受保护的非 Workflow 产品能力建立 domain-separated evidence hash；两个 run-once 测试套件改用隔离临时 `DATA_DIR`，test data/store root 不与 production 或 migration-candidate root 相交。
- Product Surface Coverage 冻结 12 个 active protected surface 与 10 个 removed surface；active 项必须有 contract fixture 且不得有 removal fixture，removed 项反向约束，surface status、replacement 与 owner 采用 closed contract。
- migration candidate 的 16 个归档文件只由 checksum verifier 读取；source-hit scan 的 candidate content read count 固定为 0。production import、test helper、setup、Feature registry、Compiler fixture、build context、release artifact 和 Runtime file access 均生成双向不可达证明。
- 新增 3 个 Draft 2020-12 closed schema、10 positive / 30 negative fixtures。反例在内存 proof state 上分别覆盖 removed API/UI/source/schema/filesystem/resource、protected capability、test root leakage、candidate 八类 reachability、candidate content source scan、surface status/fixture 和 prior identity drift。
- CLI、public export、Contract Pack README 与 `test:g0.7` 已接入；legacy workflow boundary test 改为消费同一机器 proof。G0.2 import boundary 只扩展 G0.7 实际使用的 pinned dependency/Node 标准库 allowlist。
- `local_single_user_sqlite@1` 继续为 `candidate/not_certified`；G0.7 manifest 显式声明 executable DDL、SQLite Runtime execution、Golden、Store/Connection Factory、Compiler sealing、Registry/Runtime、Runtime Center/UI 和 Supported Limits certification 均不存在。`conformance/draft/` 与 `sealed/` 仍各自只有 `.gitkeep`。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G0.7 Static Absence manifest | `sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2` |
| Absence baseline schema / artifact / semantic baseline | `sha256:2282610bd544aaf7514ef81274ccb9669a4d206afe91fa9663921281f45b9571` / `sha256:8331ba82daaa2e4950e9e02cf4c637e3d6ecf2c78dbbcb2038ea154d8d01e697` / `sha256:16d5919ffab06dbdf4f6f3e962175883ba2cd785ef4f33f4cd19e2eb9ba576b7` |
| Product surface schema / artifact / semantic manifest | `sha256:a4ed8a846786367937cb5573fcb936a484236eb638f7a99bbf23e06118e17373` / `sha256:27f7f3f99d0485732953972e35181f48491aa058ba7e468c06352330bc64cd19` / `sha256:156d76d01e3fa2bfd99c689b1440436f2f149c441704c8e7552e39511e95b6c8` |
| Migration candidate schema / artifact / semantic boundary | `sha256:191b9e501b9c9fd0770f9e88642d056d0614b1483e99d0fdb4edcba3a8bda842` / `sha256:4e17809710d91d72e1537533ef036109ebe9c50496e3492813d13a3896d80890` / `sha256:3c191ffb10f9c8c11564f88dd0b36f6305526c70076648f7df3a1c7c8f7b101f` |
| Positive / negative fixture artifacts | `sha256:5b46ba9d21db6302d600abd91a0ab5e22a5b7e96acc9a9e7ff36ef3c805254be` / `sha256:08287f8b30ec6bacb2aaa2632463b516b4b004f8f22c723bc195e059abcc2247` |
| Static absence domain separators | `sha256:c58bf739f48a51d60c2b57d78096929706ed2a827fbe2a808d7054488ab323ea` |
| Source/core/build evidence / generator tool | `sha256:e30c683e8c9c444738bca81892ff12a4048e396dd5cba01c9b374b4562b22bf6` / `sha256:665ed737637c65ba80a0ff6255338a22c81c07f9a3f833d323071e1c94315ef1` |

Prior Contract Pack identity 保持不变：G0.2 `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d`、G0.3 `sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8`、G0.4 `sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607`、G0.5 `sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428`、G0.6 `sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520`。

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate`（连续两次） | PASS；两次 G0.7 manifest 均为 `sha256:a75736b...f7d2`，G0.2-G0.6 identity 均精确不变；仅有 R-010 DEP0205 非阻塞告警 |
| managed `npm run contracts:check` | PASS；G0.2-G0.7 完整合同只读检查通过，hash 与 generate 一致 |
| managed `npm run typecheck` | PASS |
| managed G0.2-G0.7 directed tests | PASS，6 files / 58 tests；分别为 11 / 5 / 7 / 9 / 8 / 18 tests，G0.7 check 内执行 10 positive / 30 negative fixtures |
| managed `npm test` | 73/74 files、676/677 tests；唯一失败为范围外 R-012 `credential-proxy` 250ms async trace intermittent baseline，G0.7 与其余 676 tests 全部通过；未修改 credential-proxy/trace 文件或测试 |
| managed run-once root isolation tests | PASS，2 files / 10 tests |
| managed legacy boundary | PASS，1 file / 6 tests；消费 G0.7 machine proof |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` | PASS；全部本切片 TypeScript/README/package script 符合 pinned Prettier |
| final absence/boundary/status scan | PASS；candidate source scan count 为 0、八类 candidate reachability 为空、12 active/10 removed surface 全覆盖；无 G0.8/Golden/DDL/Store/Compiler/Registry/Runtime/UI/certification artifact，reserved Golden 目录未写入，`credential-proxy`、container、Electron、assistant、build/setup/lock 边界无改动 |
| `git diff --check` | PASS |

施工期间用户先后提交 `025d422`、`1df249f`，只新增并修订范围外 `local/docs/dynamic-workflow-dag-framework-introduction.md`。本切片保留两次提交及其历史，不修改该文档，也不把它纳入 G0.7 暂存集。

## 已完成切片：G0.6 Logical Schema Metadata

**状态**：`DONE`

**工作包**：I11；合同联动 I2/I4/I5/I7/I9/I10，仅冻结 Normative Logical Schema metadata contract，不生成或执行 SQL/DDL，不实现 migration、Store、SQLite Connection Factory、Compiler、Registry、Runtime 或 UI。

I11/G0.6 已完成全部 74 个唯一 Normative Logical Schema 对象的 canonical manifest source、逐表逐列 metadata、typed relation/external reference、CHECK/UK/FK/index intent、query catalog、TypeScript/Schema conformance、正反例和确定性生成/只读检查。G0 总 Gate 继续为 `IN_PROGRESS`，仅 G0.7 转为 `READY`；G1-G9 未推进。

已完成交付：

- `workflow-runtime-logical-schema-source@1` 按规范顺序冻结 74 张表和 1,221 个展开列的 ordinal、logical/SQLite type intent、nullability、default/safe-integer/enum、relation ownership、PK/UK/CHECK/FK/index intent；禁止 bare internal `*_ref`、polymorphic `owner_kind/id`/`target_kind/id`、`control_epoch`、generic error 字段和歧义时间列。
- 345 条 internal typed FK 与 43 条 explicit external reference 逐项声明 source/target column、delete/deferrability 或 validator owner/reference domain；Value 关系固定使用 `(value_id, hash) -> workflow_values(id, content_hash)`，所有 FK target 必须是已声明 PK/UK。
- 74 张表共同冻结 345 FK、129 UK、759 CHECK 与 25 index intent；状态/nullable payload、lineage、exactly-one/all-or-none、closed target mapping 和有序值约束均进入机器 metadata，不包含可执行 constraint expression 或 DDL。
- Query Catalog 固定 24 条 scheduler/watchdog/timer/outbox/recovery/remediation/finalizer/reconciler/fencer/blob/retention/command/checkpoint query intent；每条 query 与 required index 双向引用，明确 equality/range/order/cardinality，但 `sql_text_status=absent`、`execution_status=intent_only`。
- 新增 3 个 Draft 2020-12 closed schema，以及完整的 TypeScript/Schema object keyset 与 G0.4 state-machine enum conformance；6 positive / 34 negative fixtures 覆盖 closed object、全部对象/列、计数、typed relation、external validator、PK/UK target、constraint/index/query reference、禁止列、metadata-only 和 exact baseline drift。
- 新增独立 `logical-schema-domain-separators` registry 与 `contract-pack-logical-schema` manifest；CLI `generate/check` 和 CI 统一检查 G0.2-G0.6，并 exact pin G0.2-G0.5 manifest identity。
- `local_single_user_sqlite@1` 保持 `candidate/not_certified` 且 observation/certification identity 未填充；本切片没有 SQL text、executable migration、Schema Manifest、Connection Factory、SQLite open/PRAGMA、Supported Limits、Compiler/Golden、Registry/Runtime 语义或 UI，`conformance/draft/` 与 `sealed/` 仍只含 `.gitkeep`。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G0.6 Logical Schema Metadata manifest | `sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520` |
| Logical Schema source schema / metadata | `sha256:6ffb28049db3064532ed1c60d809f33c379b393a73c3b3c4ff4c611cda0f47eb` / `sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214` |
| Typed Relation Catalog schema / metadata | `sha256:06001e856248e9a5d4a0b5dcda928dc56d6c71408a4ef245a9b1396bdd5895f0` / `sha256:20babbfc787ac8a6006243180ef6e867bef8b454c41a527f4b8f20c8f6dd0d99` |
| Query Catalog schema / metadata | `sha256:591b50d9acd00e625f93c7fc0f53a631afcde34e70d51723f9798c1b2ca3c25a` / `sha256:6a6368f1300a5d732a6a63b73f593b9dd930880beafdd14958517bc92463ed2d` |
| Positive / negative fixture artifacts | `sha256:bf29a3e5bb8da0dadf5d293532218b224d74cc13835b7361e86016a85975b1e5` / `sha256:02f82b1e365bafcf031f928fd9fa950b1b8890719a07aee8d24a45f37e8280cc` |
| Logical Schema domain separators | `sha256:fedfca88cad19f9ddb4711188c5e22a25db10779abd8eb1f0c6d3c72cfd49871` |

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate` | PASS；G0.6 manifest 稳定为 `sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520`；G0.2/G0.3/G0.4/G0.5 分别保持 `sha256:e85b654...637d`、`sha256:c5ea281...a3a8`、`sha256:e4947c5...607`、`sha256:76b8e11...b428`；仅有 R-010 DEP0205 非阻塞告警 |
| managed `npm run contracts:check` | PASS；G0.2-G0.6 完整合同只读检查全部通过，hash 与 generate 一致 |
| managed `npm run typecheck` | PASS |
| managed G0.2-G0.6 directed tests | PASS，5 files / 40 tests；分别为 11 / 5 / 7 / 9 / 8 tests，G0.6 check 内执行 6 positive / 34 negative fixtures |
| managed `npm test` | 72/73 files、658/659 tests；唯一失败为范围外 R-012 `credential-proxy` 250ms async trace intermittent baseline，G0.6 与其余 658 tests 全部通过；未修改 credential-proxy/trace 文件或测试 |
| managed legacy boundary | PASS，1 file / 6 tests |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` | PASS；全部本切片 TypeScript/README/package script 符合 pinned Prettier |
| final metadata/boundary/status scan | PASS；无 SQL/DDL/migration/Schema Manifest/Store/SQLite open/PRAGMA/Compiler/Golden/Registry/Runtime/UI 实现，SQLite profile 仍为 candidate，reserved Golden 目录未写入，范围外 introduction 文档未暂存 |
| `git diff --check` | PASS |

## 已完成切片：G0.5 Safety / Retention / SQLite Contracts

**状态**：`DONE`

**工作包**：I11；合同联动 I4/I5/I9，仅冻结 Safety/Capacity/Retention/SQLite/Enforcement 机器合同，不实现 DDL、Store、Compiler、Registry、Runtime 或认证语义。

I11/G0.5 已完成 `local_single_user_safety@1`、Deployment Capacity closed schema/checked-in baseline、`local_single_user_product_floor@1`、`local_single_user_retention@1`、`local_single_user_sqlite@1` candidate 与完整逐字段 Enforcement Matrix 的机器化、TypeScript conformance、正反例、确定性生成/只读检查和 CI 接入。G0 总 Gate 继续为 `IN_PROGRESS`，仅 G0.6 转为 `READY`；G1-G9 未推进。

已完成交付：

- `local_single_user_safety@1` 逐项冻结规范的 10 组 69 个有限正 safe-integer ceiling；closed schema 与 TypeScript group/leaf keyset 双向校验，Workflow `max_graph_runs <= max_state_activations - 1`、Product Floor 对齐和既有 Run pinning 语义进入机器检查。
- `config/workflow-runtime-capacity.json` 固定 `5/256/2048/16 + 20/16/5 GiB` baseline，使用独立 domain-separated `config_hash`；Capacity closed schema 拒绝 unknown/missing/zero/unsafe 字段，G0.5 manifest 冻结 atomic full-snapshot reload、existing admission 不 cancel、Blob over-capacity/GC、minimum-free-disk increase-only 与不得放宽 pinned Safety 的合同。
- `local_single_user_product_floor@1` 冻结 15 个 minimum certified dimension，以及 M2/16 GiB/APFS/internal SSD/AC/release、禁止并发 benchmark 干扰、10 次 warmup、至少 100 次 measurement、25/50/100% scaling、p50/p95/p99/max/WAL/RSS/affected-row 必报指标、Beyond Limit 原子写前拒绝和 T3/T7/T8 p99 `250/1000/500 ms`、max 不超过 p99 budget 2 倍的发布下限。
- `local_single_user_retention@1` 将 24 小时、7/30/90/365 天窗口全部换算为 UTC millisecond safe integer，固定 active/closing/action-required/quarantined 强 retention root、user artifact only-extend、manual backup pin 与 existing-object exact policy pinning；Pending Signal 7 天 TTL 与 Safety 一致。
- `local_single_user_sqlite@1` 固定 WAL/FULL/FK、全部 database/connection PRAGMA、managed Node `26.5.0` Distribution ref/hash/executable hash和 `better-sqlite3@12.11.1` target，但显式保持 `certification_status=candidate`；SQLite/source/compile-options/native module/release artifact/Launcher observation 字段全部为 null，并由 schema/negative fixture 阻止伪装 `certified` 或抄入开发机 identity。
- Enforcement Matrix 展开为 76 条 concrete record：69 个 Safety 叶字段与 7 个 Capacity 字段恰好各一条，无通配行、重复 owner 或缺失 checkpoint。每条记录固定 business limit、resource/account/consumer、component/checkpoint、settlement、failure、Plan hash、Supported Limit 与 T7 fence mapping，并具有独立 `record_hash`；Safety 全部进入 Plan hash，Capacity 全部不进入且不伪造 Supported/T7 mapping。
- 新增 6 个 Draft 2020-12 closed schema artifact，内嵌 `VersionedRef` 与 G0.2 standalone schema canonical 语义一致；7 positive / 30 negative fixtures 覆盖 exact baseline、unknown/missing/zero、mutable ref、terminal activation reserve、Capacity hash/watermark、Product Floor 下调/并发 benchmark 干扰、Retention 缩短、SQLite candidate identity spoof、Enforcement 漏项/重复/wildcard/checkpoint/Plan/hash drift。
- 新增独立 `safety-sqlite-domain-separators` registry 与 `contract-pack-safety-sqlite` manifest；CLI `generate/check` 和 CI 统一检查 G0.2-G0.5。G0.2 foundation、G0.3 closed-schema 与 G0.4 catalog/protocol manifest 被 exact hash pin 住，既有 JSON bytes 未改。
- `sqlite/` 只包含 candidate profile/schema；没有 Logical Schema metadata、typed relation/query catalog、executable migration、Schema Manifest、Connection Factory、真实 SQLite open/PRAGMA、Supported Limits 或 certification。`conformance/draft/` 与 `sealed/` 仍只含 `.gitkeep`，没有开始 G0.6、G1、G2 或 Golden。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G0.5 Safety/Retention/SQLite manifest | `sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428` |
| `local_single_user_safety@1` | `sha256:822bf524138d5283e1b94b709765a913a0d6a94f5190efcd55bb7ba546453491` |
| Deployment Capacity schema / baseline config | `sha256:30aa123506c8f37a3d0c291d20feab150e7103c3f83c12775c49d323f9de7ec4` / `sha256:970a63fdba1e263189c3070201a543f01508180abb1e8c15cf649a3780c17542` |
| `local_single_user_product_floor@1` | `sha256:370e01e401d98a25ca89088560edbb88d1a5cdb19d3409a877f9be5f39004521` |
| `local_single_user_retention@1` | `sha256:3adc19f9a8ee92421faa349ec12e706f2d9862e90c0c74e53eb041794e2b805d` |
| Enforcement Matrix | `sha256:fcd51e0f36865f34dcd03641754116db872d791c4d9362110a7a1548e76a545d` |
| `local_single_user_sqlite@1` candidate | `sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af` |
| Positive / negative fixture artifacts | `sha256:7aaa6b5f6465d30ad359cac36d86a33c3ef4321f0901e65b8485be938c94b814` / `sha256:77dbd01c5db61eaecfc80fc3654f8b2d207f400a58c30b54ecfb6a24225c7f8e` |

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm ci` | PASS；554 packages installed；`package-lock.json` SHA-256 保持 `2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085`；30 项既有 audit 告警保持 R-007 |
| managed `npm run contracts:generate`（连续两次） | PASS；两次 G0.5 manifest 均为 `sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428`，G0.2/G0.3/G0.4 保持指定 hash；完整 JSON/config/reserved tree 初始、第一次、第二次 digest 均为 `a854a43f39394b310df32c3080d0757af924feb215505d2783ea9b32bef7533c`；仅有 R-010 DEP0205 非阻塞告警 |
| managed `npm run contracts:check` | PASS；四个 pack 均只读通过，check 后 tree digest 仍为 `a854a43f39394b310df32c3080d0757af924feb215505d2783ea9b32bef7533c` |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g0.2` / `test:g0.3` / `test:g0.4` / `test:g0.5` | PASS；11 / 5 / 7 / 9 tests；G0.5 check 内执行 7 positive / 30 negative fixtures |
| managed legacy boundary | PASS，1 file / 6 tests |
| managed `npm test` | 最终 post-expansion run 为 71/72 files、650/651 tests；唯一失败为范围外 R-012 `credential-proxy` 250ms async trace intermittent baseline，G0.5 与其余测试全部通过；此前同会话完整 run 曾为 72 files / 651 tests PASS |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` | PASS；全部 `src/workflow-runtime/contracts/*.ts` 符合 pinned Prettier |
| R-012 定向复核 | 会话开始时单文件与最终 post-expansion 完整 suite 均只观察到 `model_request_started`，分别为 20/21 与总计 650/651 tests；中间完整 suite 曾全部通过，确认其为范围外 intermittent baseline。G0.5 未修改 credential-proxy/trace 文件或测试 |
| prior-pack/boundary scan | PASS；G0.4 原子提交 `6483be9`、六类 Catalog、13 Command、22 状态机、18 transaction、9/20 fixtures 已复核；G0.2/G0.3/G0.4 manifests 和 `package-lock.json` identity 未改；无 DDL/Store/Compiler/Golden/Registry/Runtime/UI artifact |
| `git diff --check` | PASS |

## 已完成切片：G0.4 Catalogs and Protocol Tables

**状态**：`DONE`

**工作包**：I11；合同联动 I3/I5/I9/I10，仅冻结 closed catalog 与声明性 protocol table，不实现 Compiler、Store、Registry、Runtime Command、T0-T8 或 Runtime Center 语义。

I11/G0.4 已完成 Error/Fact/Event/Permission/Reason/Denial Catalog、Runtime Command Catalog、22 组状态转换表与 18 个 T0-T8/T6e 事务协议的机器化、TypeScript conformance、正反例、确定性生成/只读检查和 CI 接入。G0 总 Gate 继续为 `IN_PROGRESS`，仅 G0.5 转为 `READY`；G1-G9 未推进。

已完成交付：

- `catalogs/` 新增 27-code Compiler Error Catalog，固定 diagnostic phase、retryability 与稳定排序键；Error code TypeScript union 与架构规范逐项一致。
- Run Protocol v1 固定 13 类 Fact、唯一 `fact_kind_rank`、T3 queue ordering，以及 39 类 Runtime Event；13 类 fact-backed Event 与 Fact 同 type/seq 原子映射，26 类 audit-only Event 明确禁止创建 Fact 或消费 `facts_total`。
- Runtime Command 合同固定 9 个 Permission、17 个 Reason、11 个 Denial 与 13 个 Command。每个 Command 逐项绑定六种 typed target、permission/ownership rule、allowed reason/actor、evidence 下限、Published Policy guard、state guard、transaction protocol 与 denial set；Deadline/Safety Watchdog 只通过 `cancel_workflow + due_target` 专用 System Grant，不能获得 `cancel_run` 或通用 admin authority。
- `protocols/workflow-runtime-state-transition-tables.json` 固定 22 个 Workflow/Activation/Run/Scope/Node/Attempt/Build/Wait/Edge/Map/Effect/Outbox/Blocker/Finalization/Confirmation state machine；只允许列出的 transition，terminal reopen 全局禁止，Operational state 只按 open blocker 集合/T6e 或 Administrative Abandon 推进。
- `protocols/workflow-run-transaction-protocol-table.json` 覆盖 18 个 `T0/T0p/T1/T2a/T2b/T3a/T3b/T4/T5/T6a/T6b/T6c/T6d/T6e/T7a/T7b/T7c/T8` 协议，逐项固定 `BEGIN IMMEDIATE`、external-work boundary、precondition、CAS guard、atomic write set、idempotency/unique、failure/late outcome 与 forbidden action；它是声明性机器合同，不包含 Runtime 实现。
- `conformance/catalog-protocols/` 包含 9 个正例与 20 个负例，覆盖 missing/open catalog value、Fact rank/Event mapping、Feature ceiling、Reason actor、Denial mutation、terminal reopen、Command target/reason/evidence/confirmation、T6e coverage、T5 external boundary 与 T8 partial child creation。
- 新增独立 `catalog-protocol-domain-separators` registry 和 `contract-pack-catalog-protocols` manifest，CLI `generate/check` 与 CI 统一校验 G0.2/G0.3/G0.4；G0.2 foundation 与 G0.3 closed-schema manifest 被 exact hash pin 住，旧机器产物逐字节未改。
- 架构规范补齐 Run Protocol v1 的 exact Fact rank 与 Runtime Event taxonomy，使新增 Contract Pack 值具有正文语义；没有开始 G0.5 Safety/Capacity/Retention/SQLite Profile/Enforcement Matrix。
- `safety/`、`sqlite/`、`conformance/draft/` 与 `conformance/sealed/` 仍各自只含 `.gitkeep`；没有创建 Golden、DDL/Store、Registry、Compiler lowering/proof、Runtime、Runtime Center 或 UI artifact。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G0.4 catalog/protocol manifest | `sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607` |
| Compiler Error Catalog | `sha256:a5b27ca8ed6c6ad6ffa018f085c1333f09a7eb380435fd61f03b7f260fdca540` |
| Runtime Fact Catalog | `sha256:69cce4dab2cafd93c9db6836e98782b6a78ca10a5080ef7740371c9557ebd64e` |
| Runtime Event Catalog | `sha256:f06b2cd19314341e64df1dade1d1c497804c79cac1b0fdad5f0f03f57f3e41e5` |
| Runtime Permission Catalog | `sha256:5b28c4f1f6da5e4fd6a8cb37e20a0e09a9547c3acf98fb02aa86f2cbfcfb7b6c` |
| Runtime Command Reason / Denial Catalog | `sha256:124ea820f405134b7c2df016880a5dba2f0b7a546fd931361040d838872b2694` / `sha256:a575624b248184018a14708525b4caf9f8b57ec50c417dd0f2f1142e88c1dfda` |
| State Transition Tables | `sha256:040569c46e94e5c66de4a3327b9f80fb6dba17c78518d019f1c335be4842132f` |
| Runtime Command Protocol Table | `sha256:b12b07b29e9335593c969033c133d221b244798fc079db5fb398b23fbae10789` |
| T0-T8/T6e Transaction Protocol Table | `sha256:7c55b3eff2f29e5dfcbb057d5ff014697ba2e9a421287afa19ec850540cce5f0` |
| Positive / negative fixture artifacts | `sha256:5256999eab702bba4f545abf4e6af7561edc5b73cb1df074a88048395530fd46` / `sha256:89f9fecd0b462459292bfa9fab6ec74393ce0f81ee5d25f9378c81a51d918169` |

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate`（连续两次） | PASS；两次 G0.4 manifest 均为 `sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607`，G0.3/G0.2 均保持指定 hash；仅有 R-010 DEP0205 非阻塞告警 |
| 完整 JSON/reserved tree digest | PASS；初始、第一次 generate、第二次 generate 均为 `fe36b23866a59868f8f626b07f6a0ac8e06011b63c2d2cf3dad44eb9708b9797` |
| managed `npm run contracts:check` | PASS；foundation/closed-schema/catalog-protocol 三个 pack 均只读通过 |
| managed `npm ci` | PASS；554 packages installed；`package-lock.json` SHA-256 仍为 `2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085`；30 项既有 audit 告警保持 R-007 |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g0.2` / `test:g0.3` / `test:g0.4` | PASS；11 / 5 / 7 tests；G0.4 check 内执行 9 positive / 20 negative fixtures |
| managed legacy boundary | PASS，1 file / 6 tests |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` | PASS；全部新增/修改 Contract Pack TypeScript 符合 pinned Prettier |
| managed `npm test` | 70 files / 641 tests PASS，1 file / 1 test FAIL；范围外 `src/credential-proxy.test.ts` 的既有异步 trace assertion 在 250ms 内只观察到 `model_request_started`，未观察到 `model_resolution`；单文件重跑同样为 20 PASS / 1 FAIL。G0.4 未修改 credential proxy/trace 文件，定向 Contract/Boundary/Build 全部通过，记录为 R-012，不改范围外代码 |
| prior-pack/boundary scan | PASS；指定基线 G0.3 commit `f3cb8a8` 已复核；foundation manifest `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d` 与 G0.3 manifest `sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8` 及全部既有 JSON bytes 未改；`package-lock.json`、toolchain/Launcher/setup/launchd/container/Electron 无改动；G0.5+ reserved 目录只有 `.gitkeep` |
| concurrent repository commits | 施工期间出现 `982e3b6` 与 `5989b8e` 两个范围外进度文档措辞提交，第二个逐字回退第一个，净 tree 等于 `f3cb8a8`；G0.4 保留两者并以 `5989b8e` 为父提交，不改写历史 |
| `git diff --check` | PASS |

## 已完成切片：G0.3 Closed Schemas

**状态**：`DONE`

**工作包**：I11；合同联动 I2/I3/I10，仅冻结机器 Schema，不实现对应 Runtime 语义。

I11/G0.3 的八个 closed Domain Schema、TypeScript conformance、正反例、确定性生成/只读检查、CI 和完整退出验证已完成原子交付。G0 总 Gate 继续为 `IN_PROGRESS`，仅 G0.4 转为 `READY`；G0.5-G0.9 与 G1-G9 未推进。

已完成交付：

- `schemas/` 已生成八个 artifact-envelope 包装的 Draft 2020-12 closed schema：Workflow Definition、Recipe、Runtime Command、Transition、Feature Manifest vNext、Card Presentation、Graph Scope Source IR 与 Compiled Scope Plan。
- 顶层及所有嵌套对象默认 `additionalProperties=false`；仅显式 typed Record 与递归 JSON Value 保持受约束开放。Definition State、Graph Node、Runtime Command、Feature resource 和 binding source union 由共享 TypeScript 常量驱动并双向检查；顶层 required/optional keyset 也执行 TypeScript/Schema conformance。
- 所有八个 Schema 内嵌的 `VersionedRef` 与 G0.2 standalone Schema 做 canonical semantic byte comparison，只允许 closed `{id,version}` 与 immutable exact version token。Graph limits、usage budget、`max_bytes` 和 compiled effective limits 保留 `0/null` 语义；Runtime Safety 和 attempt/proof 的正数合同保持分离。
- Transition required/best-effort delivery、Compiled generated `schema_json/schema_ref`、Capability artifact/no-artifact 与 evaluator/no-evaluation 使用 exact-one contract；Command 的 13 个分支只接受对应 typed target，Actor/Session/Delegation 仍由服务端生成。
- 最终审查修复了 Feature Manifest `source_path` 父目录正则的 TypeScript 转义错误，并收紧 Definition graph input 与 Transition child-effect input 的 TypeScript source union，避免 TS 接受 Schema 明确禁止的 binding。
- `conformance/closed-schemas/` 最终包含 8 个正例与 22 个负例；除原 18 个回归外，新增合法两字符路径段/父目录拒绝、delivery exact-one、generated schema source exact-one 和 Capability artifact choice exact-one，并在正例中固定 `0/null` limits 与 Compiled binding。
- G0.3 使用独立 `closed-schema-domain-separators` registry 和 `contract-pack-closed-schemas` manifest，复用 G0.2 envelope、strict JSON、RFC 8785 canonical hash、domain hash 与 generate/check；未修改 G0.2 foundation artifacts，foundation manifest 仍为 `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d`。
- `protocols/`、`safety/`、`sqlite/`、`conformance/draft/` 与 `conformance/sealed/` 仍各自只含 `.gitkeep`；没有写入 G0.4+、Golden、DDL/Store、Registry、T0-T8 或 Runtime Center artifact。

最终 Artifact hashes：

| Artifact | Hash |
| --- | --- |
| G0.3 closed-schema manifest | `sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8` |
| Definition Schema | `sha256:a23f3ce0ebb562bed94e7736651ee8f9f87e659a7fd4640d2802603dae7df804` |
| Recipe Schema | `sha256:c2768894c7fe6aab492f11d2948a4c92ccefbadc44cb094e103df4a8cdca9bb2` |
| Runtime Command Schema | `sha256:859a26bc9d31c0ca3e1246ffde1fc79f5f53da884063c5868b7a82efd519b0e6` |
| Transition Schema | `sha256:9807b8c0100a893d54821f59cfadaa0adb0939b8e2b0ce4c678e408c5f4b9e1f` |
| Feature Manifest vNext Schema | `sha256:e47344ea2f4bebde3688f76b3450d5143adfd99ab4cc30eb6fc48a9d5a398e2d` |
| Card Presentation Schema | `sha256:866cdf382a1cd70cfcd52c2b0173f66ce9aebeecd8b8f79c200ecd5202cde829` |
| Source IR Schema | `sha256:f7eb1d418f9ed4e47f8cfd60d4a8af061e816439c1a2ba6b2e2a8a050c9b2927` |
| Compiled IR Schema | `sha256:7d2371a5df632220ba82ab0739b163134978885b8baaae6d7b247d53623be400` |
| Positive / negative fixture artifacts | `sha256:fe3b4894242ce502e73ca30febf02aad3867885b629919b083220d7418457f78` / `sha256:83b0ce8c333e68281ed54b4ef49d38383375e22fa415a57a6a513236896fc3e2` |

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate`（连续两次） | PASS；两次 G0.3 manifest 均为 `sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8`，foundation manifest 均为 `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d`；仅有 R-010 DEP0205 非阻塞告警 |
| 完整 JSON/reserved tree digest | PASS；初始、第一次 generate、第二次 generate 均为 `4a8725266c7867da45e762f6c11bf75f8764fa00cea566501f9fb5afc892b28e` |
| managed `npm run contracts:check` | PASS；check 前后 tree digest 同为 `4a8725266c7867da45e762f6c11bf75f8764fa00cea566501f9fb5afc892b28e`，证明只读 |
| managed `npm ci` | PASS；554 packages installed；`package-lock.json` SHA-256 `2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085`；30 项既有 audit 告警保持 R-007 |
| managed `npm run typecheck` | PASS |
| managed `npm test` | PASS，70 files / 635 tests |
| managed `npm run test:g0.2` | PASS，1 file / 11 tests |
| managed `npm run test:g0.3` | PASS，1 file / 5 tests；check 内逐项验证 8 positive / 22 negative fixtures |
| managed legacy boundary | PASS，1 file / 6 tests |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` | PASS；全部 `src/workflow-runtime/contracts/*.ts` 符合 pinned Prettier |
| managed runtime/Core binding | PASS；Node `v26.5.0 darwin/arm64` 来自 active content-addressed distribution；Core binding kind 为 `development_checkout` |
| final commit/boundary scan | PASS；HEAD 基线仍为 `65aa8ca`；G0.1 `620863a`、范围外 `32f3c51` 与 G0.2 foundation bytes 未改写；`package-lock.json`、`container/`、Electron、Launcher/toolchain/setup/launchd 无改动；G0.4+ reserved 目录只有 `.gitkeep`；G0.3 路径无 symlink/temp/无关生成物；仓库既有 ignored `.tmp-wfcheck`（2026-04-10）与 `.DS_Store` 未修改、未纳入提交 |
| `git diff --check` | PASS |

## 已完成切片：G0.1 Toolchain Identity

**状态**：`DONE`

**工作包**：I11

**目标**：把 Core Runtime/Compiler/CI 的工具链输入固定到规范 S25 与 Compiler Conformance Toolchain 指定的 exact identity，并交付不修改系统 Node 的 managed distribution bootstrap、exec wrapper、stable Runtime Launcher 与 launchd binding，为后续 Contract Pack hash、Golden 和 SQLite certification 建立可重放基线；本切片不创建 Runtime Store、Compiler 语义实现或 production activation。

**必须重点复读**：

- 已确认决策 S10、S13、S18、S24、S25、S26、S28。
- Compiler Conformance Toolchain。
- SQLite Execution Profile。
- 模块边界。
- 测试策略与模型验证。
- 开发期实施顺序、直接重构约束和完整验收标准。

**允许修改**：

- `.nvmrc`
- `package.json`
- `package-lock.json`
- `.github/workflows/ci.yml` 及确实需要保持 Node/npm identity 一致的 CI 配置
- `src/workflow-runtime/contracts/toolchain/` 下仅限 G0.1 所需的 Managed Node Distribution Manifest/schema/hash fixture 与最小 Compiler toolchain identity；Distribution schema 可以内联 exact ref shape，通用 artifact envelope/VersionedRef/hash helper 仍留到 G0.2
- `setup.sh`、`scripts/runtime-toolchain.sh`、`scripts/runtime-launcher.sh` 及其仅与 managed Node install/verify/exec 直接相关的 helper
- `setup/platform.ts`、`setup/service.ts`、`setup/launchd.ts`、`launchd/`、`local/shell/` 中仅限把 Core service/restart path 从 system Node 切换为 stable Runtime Launcher 的配置
- 与本切片直接相关的定向测试
- 本进度文档

**禁止越界**：

- 不实现 Workflow Runtime、Store、DDL、Compiler lowering/normalization/proof、Registry、T0-T8 或 UI。
- 不生成或宣称 Sealed Golden Bundle、certified SQLite Profile 或 Supported Limits。
- 不调用 Homebrew、nvm/fnm/Volta 或其他 system version manager，不修改系统 Node/npm、shell profile、全局 symlink，或把用户现有 launchd Node path 保留为兼容 fallback。
- 不使用 floating semver、moving system Node path，不手写伪造 native/release/certification identity；Distribution archive/executable hash 必须由 official bytes 实测并与 checked-in Manifest 一致。
- 不修改 Agent Container/VM image 或 Electron Node identity；它们不属于本切片。
- 不顺手升级规范未要求的依赖；若 Node 26 导致其他依赖不兼容，记录最小问题并按规范联动评审。

**退出条件**：

1. `.nvmrc`、CI Node source 和 `packageManager` 与规范 exact identity 一致。
2. 规范列出的 direct runtime/dev dependencies 使用 exact version，无 `^`/`~`，lockfile integrity 更新完成。
3. Checked-in `ManagedNodeRuntimeDistributionManifest` 固定 official Node `26.5.0` darwin/arm64 archive URL、archive hash `sha256:ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9`、executable hash `sha256:cbee2298aee5cc476bf8d5441e7348b627254a39d869743a5b04489028c729d4` 与 bundled npm `11.17.0`；hash 由真实 bytes 验证，不是手写占位。
4. Fresh temporary runtime home 的 bootstrap 能自动、安全、幂等地 side-by-side 安装 managed distribution，且安装前后系统 `command -v node/npm` 与版本完全不变；archive/hash/npm mismatch、unsafe entry、partial install 和 invalid pointer 均有稳定 fail-closed 结果。
5. 本地最终 `npm ci`、typecheck、完整测试、legacy boundary 和 native-module load 全部通过 `scripts/runtime-toolchain.sh exec -- ...` 运行；证据中的 `process.execPath/version` 必须属于 active content-addressed installation，不得使用当前 shell/system Node。
6. launchd `ProgramArguments[0]`、setup service 与 restart script 只调用 stable Icarus Runtime Launcher。Launcher 从自身 `realpath` 推导 runtime root，忽略继承环境中的 root/PATH override，原子读取 active pointer，验证 containment、Manifest、Node executable hash/version 与 Core binding 后 `exec`；managed runtime 缺失/损坏时退出，测试证明不会 fallback 到 PATH、Homebrew 或 system Node。
7. CI 使用 `.nvmrc`，在 lock install 前验证 Node/npm exact identity 并执行 `npm ci`；CI bootstrap/launcher fixture 把 production-identical Launcher 安装到临时布局，由其自身路径解析临时 root，不写用户或系统路径且不依赖 production 环境覆盖，失败信息稳定。
8. Agent Container/VM image 和 Electron 文件无改动；G0.1 证据明确它们不属于 Core managed runtime/SQLite certification identity。
9. 本文记录实际命令、系统环境前后值、managed runtime 版本/路径/hash、测试结果和 commit。

**最低验证命令**：

```bash
command -v node
node --version
command -v npm
npm --version
./scripts/runtime-toolchain.sh install
./scripts/runtime-toolchain.sh verify
./scripts/runtime-toolchain.sh exec -- node --version
./scripts/runtime-toolchain.sh exec -- npm --version
./scripts/runtime-toolchain.sh exec -- npm ci
./scripts/runtime-toolchain.sh exec -- npm run typecheck
./scripts/runtime-toolchain.sh exec -- npm test
./scripts/runtime-toolchain.sh exec -- npx vitest run setup/toolchain-identity.test.ts setup/runtime-toolchain.test.ts setup/service.test.ts
./scripts/runtime-toolchain.sh exec -- npx vitest run setup/legacy-workflow-boundary.test.ts
./scripts/runtime-toolchain.sh exec -- npm run build
./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js
command -v node
node --version
command -v npm
npm --version
git diff --check
```

如果完整 `npm test` 存在与本切片无关的已知失败，必须保存具体失败并证明不是工具链变更导致；不得只运行定向测试后宣称完成。

## 已完成切片：G0.2 Contract Pack Foundation

**状态**：`DONE`

**工作包**：I11

**目标**：建立不包含 Domain Runtime 语义的 Contract Pack 公共底座：通用 closed artifact envelope、closed exact `VersionedRef`、strict JSON parse、RFC 8785 canonical JSON、ASCII domain-separated SHA-256、foundation machine artifacts/fixtures、确定性 generate/check 入口与 CI skeleton；复用并验证 G0.1 toolchain artifact identity，但不把候选 toolchain 输入伪装为完整 Compiler Toolchain、Core Release 或认证 artifact。

**范围边界**：

- 所有实现位于 `src/workflow-runtime/contracts/`，依赖方向保持 `contracts` 不 import Compiler、Store、Registry、Feature 或 Runtime。
- `schemas/`、`protocols/`、`safety/`、`sqlite/`、`conformance/draft/` 与 `conformance/sealed/` 本切片只建立 reserved directory，不包含后续切片 artifact；`.gitkeep` 不构成 G0.3-G0.8 交付证据。
- 没有实现 Definition/Recipe/Command/Transition 等 closed Domain Schema、DDL/Store、Compiler normalizer/proof、Golden sealing、Registry、T0-T8、Runtime Center 或 UI。
- 没有修改 Agent Container/VM image、Electron identity、`package-lock.json` 或 G0.1 managed Node/Launcher/Core binding；Core binding 仍为 `development_checkout`。

**退出条件与最低验证**：

```bash
./scripts/runtime-toolchain.sh exec -- npm ci
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
./scripts/runtime-toolchain.sh exec -- npm run typecheck
./scripts/runtime-toolchain.sh exec -- npm test
./scripts/runtime-toolchain.sh exec -- npm run test:g0.2
./scripts/runtime-toolchain.sh exec -- npx vitest run setup/legacy-workflow-boundary.test.ts
./scripts/runtime-toolchain.sh exec -- npm run build
./scripts/runtime-toolchain.sh exec -- npx prettier --check 'src/workflow-runtime/contracts/*.ts'
./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js
git diff --check
```

## 施工记录

### 2026-07-15：G0.2 Contract Pack Foundation（DONE）

I11/G0.2 的 Contract Pack 公共机器合同、fixture、确定性生成/只读检查和 CI conformance 已完成最终代码/合同审查、完整退出验证与原子交付。审查期间已有提交 `32f3c5193940f7a5dedee14d13e7c736c25fd401` 在 `main` 新增范围外文档 `local/docs/evaluation-self-evolution-framework.md`；最终暂存集以该 HEAD 为父提交，只包含 G0.2 文件，没有撤销、修改或重复纳入该文档。G0.2 为 `DONE`，G0.3 转为 `READY`；G0 总 Gate 继续为 `IN_PROGRESS`，G0.4-G0.9 与 G1-G9 状态未推进。

已完成交付：

- 通用 artifact envelope 固定 closed `format/ref/version/domain_separator/hash/payload`；format revision、envelope version 与 domain revision 必须一致，hash 覆盖去除自身 hash 后的完整 canonical envelope。
- standalone 与 envelope-embedded `VersionedRef` Schema 逐字节语义一致，只允许 closed `{id,version}` 和 immutable exact version token，拒绝 unknown field、`latest/LATEST`、range 与 `1.x`。
- `strict-json.ts` 使用 pinned `jsonc-parser@3.3.1` visitor 先检测 duplicate key/path，再 materialize；comments、trailing comma、empty/invalid UTF-8、non-finite/unsafe integer、string/object-key unpaired surrogate、Proxy、sparse/accessor/cyclic/custom/non-JSON value均 fail-closed。
- `hash.ts` 使用 pinned `json-canonicalize@2.0.0` RFC 8785 JCS、Node `crypto` SHA-256、带终止 LF 的 versioned ASCII domain separator和 `sha256:<64 lowercase hex>`；不同 domain 的相同 payload hash 不相等。
- foundation machine artifacts 包含 envelope/VersionedRef Schema、strict JSON/hash profile、domain separator registry、hand-authored canonical/hash vectors与 negative case manifest；新增 RFC 8785 完整官方 value sample 的 direct JCS conformance、strict-profile-compatible number/string machine vector和官方 UTF-16 property-order vector。Domain registry 一对一覆盖全部 G0.2 artifacts及 G0.1 managed distribution/compiler-input artifact。
- 每个 negative fixture 的 raw bytes 现在以 `source_sha256` 进入 negative-case artifact，再进入 foundation manifest；同类失败内容替换也会改变 hash chain。
- `contracts:generate` 只确定性刷新 foundation hash/vector/negative fixture source hash/manifest；`contracts:check` 不写文件并逐字节校验生成结果、Schema/TypeScript key/pattern/semantic conformance、domain coverage、negative raw bytes、reserved directory 只含 `.gitkeep`、G0.1 artifact/domain hash、真实 package-lock bytes、exact direct package version/integrity 和 Node/npm identity。
- CI 在 `npm ci` 后、format/typecheck/test 前运行 `npm run contracts:check`；`npm run test:g0.2` 提供独立定向入口。11 个定向测试还覆盖固定 seed 的 200 组 object insertion-order property、Proxy/unpaired-surrogate fail-closed和拒绝动态 import/require 的 `contracts` import boundary。

Artifact hashes：

| Artifact | Hash |
| --- | --- |
| Contract Pack foundation manifest | `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d` |
| Artifact envelope schema | `sha256:347656d1f99a293a839250f1f363d609b302c7e881d174c3789981ada67f1546` |
| VersionedRef schema | `sha256:7a22150ce8d6e8127e882a6ed79975e578d2fd6a28dfab002490c17cfdd196bd` |
| Strict JSON profile | `sha256:8b01a0e87b5851b9243d41b07b6883b91de5fe1ab446d019a3f3f62bedf5c28e` |
| Canonical hash profile | `sha256:e023e815062e4534469bc8704284c7f47950c0a52a330a004d8905ccaf66157a` |
| Foundation domain separators | `sha256:637a5bdf3353efba20776c0df1b601f6b2eaba6541a14f6268dbab0a6b972611` |
| Hash vectors | `sha256:ebe286769316c8b7ccad33c94e33c32e7752cc518e355e0e64241827c272889a` |
| Negative cases | `sha256:8b3291d54684d6e4a648ca314dce2827319400609b88d94c23bfdb15b532017e` |

早期暂停会话中、最终审查修复前的验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm ci` | PASS；554 packages installed；30 项既有 audit 告警保持 R-007，不运行会漂移 exact lock 的自动修复 |
| managed `npm run contracts:check` | PASS；manifest hash `sha256:76011bf5d07175015a922aef71b9a56e3681e7e83951560d15df08efc333d6c3` |
| generate -> check idempotence | PASS；重复 generate 前后 JSON/reserved tree digest 均为 `3b20e92caed18b1b2faa051566d14411c7e92b2b6ebb701162e24e05b80df588` |
| managed `npm run typecheck` | PASS |
| managed `npm test` | PASS，69 files / 630 tests |
| managed `npm run test:g0.2` | PASS，1 file / 11 tests；含 200-run fixed-seed property |
| managed legacy boundary | PASS，1 file / 6 tests |
| managed `npm run build` | PASS |
| Contract Pack targeted Prettier | PASS；仓库既有全局 format baseline 仍有 34 个本切片外旧文件差异，记录为 R-008且未混入原子提交 |
| managed runtime/Core binding | PASS；Node `v26.5.0 darwin/arm64` 来自 active content-addressed distribution；binding kind 仍为 `development_checkout` |
| final boundary/generation scan | 暂停会话记录为 PASS；`git diff --check` 通过；`container/`、Electron、build scripts、`package-lock.json` 无改动；原子提交前仍须根据最终 diff 重做边界检查 |

2026-07-15 最终审查会话完成全文/进度文档、I11/S10/S13/S18/S24/S25/S26/S28、Compiler Conformance、模块边界、测试/实施/重构/验收、基线提交 `620863a` 与全部 G0.2 tracked/untracked 文件审查。修复了 programmatic JSON 对象键末尾 high-surrogate 检测、Proxy fail-open、reserved directory 非预期 artifact、G0.1 lock/package replay不足、VersionedRef/Schema/profile 持续一致性、动态 import boundary、RFC 8785 vector coverage、negative fixture raw byte hash chain和进度文档旧 domain hash。

审查修复后的定向证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate` | PASS；foundation manifest `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d` |
| managed `npm run contracts:check` | PASS；同一 manifest hash；仅报告 Node `DEP0205 module.register()` deprecation warning，退出码 0。告警来自 Node 26 下的 `tsx` loader；替换 loader/升级非规范依赖不属于 G0.2，保留为非阻塞已知告警 |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g0.2` | PASS，1 file / 11 tests；含 200-run fixed-seed property和新增 fail-closed/conformance assertions |
| targeted Prettier write | PASS；所有 `src/workflow-runtime/contracts/*.ts` 已按 pinned Prettier 格式化 |
| `git diff --check` | PASS |

最终退出验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run contracts:generate`（连续两次） | PASS；两次 foundation manifest 均为 `sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d` |
| JSON/reserved tree generate 幂等 digest | PASS；初始、第一次 generate 后、第二次 generate 后均为 `c9f1b5e75982901efdd50789cf76e7352433edcf47d2e231798f779eec4435ed` |
| managed `npm ci` | PASS；554 packages installed；`package-lock.json` SHA-256 为 `2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085`；30 项既有 audit 告警保持 R-007 |
| managed `npm run contracts:check` | PASS；foundation manifest hash 不变；check 前后 JSON/reserved tree digest 均为 `c9f1b5e75982901efdd50789cf76e7352433edcf47d2e231798f779eec4435ed`，证明只读；Node `DEP0205 module.register()` 告警保持 R-010 |
| managed `npm run typecheck` | PASS |
| managed `npm test` | PASS，69 files / 630 tests |
| managed `npm run test:g0.2` | PASS，1 file / 11 tests；含 fixed-seed 200-run property 与 fail-closed/conformance assertions |
| managed `npx vitest run setup/legacy-workflow-boundary.test.ts` | PASS，1 file / 6 tests |
| managed `npm run build` | PASS |
| managed targeted Prettier `--check` | PASS；全部 `src/workflow-runtime/contracts/*.ts` 符合 pinned Prettier |
| `runtime-toolchain.sh bind-core` | PASS；Core binding kind 为 `development_checkout` |
| final boundary/status scan | PASS；最终 HEAD 仍为 `32f3c51`；`package-lock.json`、`container/`、Electron、build scripts、G0.1 managed toolchain/launcher/setup/launchd 文件无 G0.2 改动；无 symlink/临时文件/无关生成物；reserved 目录各自只含 `.gitkeep` |
| `git diff --check` | PASS |

G0.1 基线提交 `620863a7f9cf8c08cd00caef3f962bf3755d97ab` 的对象、完整文件清单、diff check、工具链/lock/launcher边界与完整回归均已复核；当前 HEAD 在其后只多出范围外文档提交 `32f3c51`，G0.2 没有修改 G0.1 identity bytes。最终原子提交只包含 G0.2 实现、fixtures、machine artifacts、测试、CI、package scripts 与本文。

本切片没有产生完整 Compiler Toolchain Manifest、closed Domain Schema、Sealed Golden、Core Release、Executor Artifact、SQLite Profile 或 Supported Limits certification。

### 2026-07-15：G0.1 Toolchain Identity（DONE）

I11/G0.1 已完成最终实现审计、fail-closed 加固、完整退出验证和原子交付；G0 总 Gate 仍为 `IN_PROGRESS`，下一切片 G0.2 仅转为 `READY`，没有开始其实现。

已完成交付：

- `.nvmrc=26.5.0`、`packageManager=npm@11.17.0`，CI 改为 `node-version-file: .nvmrc` 并在 `npm ci` 前验证 Node/npm exact identity。
- 规范指定的 direct runtime/dev dependency 已固定 exact version，`package-lock.json` 已由 managed npm `11.17.0` 更新；最小 Compiler locked-input identity 固定 lock hash 与 direct package integrity，不宣称完整 Compiler Toolchain Manifest。
- 已提交候选 `ManagedNodeRuntimeDistributionManifest`/closed schema，固定 official darwin/arm64 archive、archive hash、Node executable hash和 bundled npm identity。
- `scripts/runtime-toolchain.sh` 已实现 download/local-fixture、archive/executable/npm verify、安全 entry/link 检查、同 filesystem 临时安装、side-by-side content-addressed layout、原子 active pointer、verify/exec 和 development Core binding；不调用或修改 Homebrew/nvm/fnm/Volta/system Node。
- `scripts/runtime-toolchain.sh` 对 Manifest/Core binding 执行 closed keyset、canonical JSON bytes 和 domain hash 校验，拒绝 archive traversal/unsafe link、安装目录或 active pointer 越界、Node executable 越界、partial install、identity mismatch 与 binding tamper；相同 content-addressed install 重放完整复验。
- `scripts/runtime-launcher.sh` 从自身 realpath 推导 runtime root，固定解析工具 PATH，调用同布局内 toolchain verifier，验证 active distribution/Core binding 后以 absolute managed `bin/node` exec；继承的 `HOME/PATH/ICARUS_*_HOME/NODE_OPTIONS/NODE_PATH` 不能改写 runtime root 或触发 system Node fallback。
- launchd `ProgramArguments`、setup service、systemd/nohup renderer、本地 restart、setup group-sync build 和 `package.json start` 已切换到 stable Runtime Launcher/managed exec；Core binding 明确为 `development_checkout`，没有伪造 Core Release、Feature Executor Artifact、native release certification、SQLite Profile 或 Supported Limits identity。
- 新增 `setup/toolchain-identity.test.ts`、`setup/runtime-toolchain.test.ts` 和重写的 `setup/service.test.ts`，覆盖 exact manifest/lock/native identity、fresh-home 幂等 install、archive/executable/npm mismatch、traversal/unsafe symlink、malformed Manifest/Core binding、partial/external install、invalid pointer、Launcher realpath/PATH 隔离、Core binding tamper 与所有 Core service/restart binding。

当前验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| official archive 手工下载 + `shasum -a 256` | PASS；archive `ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9`，`bin/node` `cbee2298aee5cc476bf8d5441e7348b627254a39d869743a5b04489028c729d4`，Node `v26.5.0`，npm `11.17.0` |
| system identity before/after `./setup.sh` and full exit suite | PASS；两次均为 Node `/opt/homebrew/bin/node v26.5.0`、npm `/opt/homebrew/bin/npm 11.17.0`；setup 输出 `SYSTEM_IDENTITY_UNCHANGED=true` |
| `./scripts/runtime-toolchain.sh install` / `verify` / managed version probes | PASS；active Node `/Users/chelaile/Library/Application Support/Icarus/toolchains/node/26.5.0/darwin-arm64/ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9/bin/node`，Node `v26.5.0`，npm `11.17.0`，Manifest `sha256:0824f5044057d6ff26dc45022b842342f148b2dda2f0dd0feb17dd0b045f6cad` |
| managed `npm ci` | PASS；554 packages installed；lock SHA-256 `2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085`；npm audit 报告 30 项依赖告警，未执行会改变 exact lock 的自动修复 |
| Compiler locked-input conformance | PASS；8 个指定 direct package 的 exact version/integrity 与当前 lock 逐项匹配；identity hash `sha256:3ad720b0283ec45be37acb596f8afb1e50a40f177fbc0c3ee2ff419aba43557b` |
| managed native load | PASS；`process.execPath` 属于 active content-addressed install，`better-sqlite3=12.11.1`；开发机构建的 native binary SHA-256 `0000d73c6e2e94318ed2b9339139623d5a0908b195f1e761c16cfd98f9cc6229`，仅作 G0.1 load 证据，不是 release/SQLite certification |
| managed `npm run typecheck` | PASS |
| managed `npm test` | PASS，68 files / 619 tests |
| managed `npx vitest run setup/toolchain-identity.test.ts setup/runtime-toolchain.test.ts setup/service.test.ts` | PASS，3 files / 13 tests |
| managed `npx vitest run setup/legacy-workflow-boundary.test.ts` | PASS，1 file / 6 tests |
| managed `npm run build` + `bind-core` | PASS；binding kind `development_checkout`，entry SHA-256 `11848f85176747fe1914d7f3193a4cf47f58a3590aa7f53ed2e099440a846155`，binding hash `f0e74f405b34d1ca4026b9e1e3fe9be6032421799019b71db97d025695330c11` |
| final source/installed hashes | Launcher source=installed `70377ade0ba2f3e969c62bab240a91549e1173270354e1d3f815282dd5213ae0`；toolchain source=installed `fbed1cfdc01e7f7915f68ca4f340e2417b7ffc64467555c03a9a83f3b8969824`；package-lock `2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` |
| `bash -n` / `git diff --check` / final fallback and file-boundary scan | PASS；无 Core system-Node launch fallback；`container/` 和 Electron 文件无改动；无无关生成物 |

身份边界证据：本切片没有修改 `container/` 或 Electron 文件。Agent Container Node 继续由独立 VM image gate 所有；Feature Executor Artifact/immutable Node Bundle 属于 G3，尚未创建；Electron 内置 Node 仍只是 API client identity；三者都不进入本机 Core managed distribution、G0.1 Compiler locked inputs 或 SQLite certification key。

G0.1 的实现、测试和本进度账本由同一个原子提交交付。Agent Container/VM image 与 Electron 文件没有改动；Feature Executor Artifact/immutable Node Bundle 仍属于 G3；Core Release、native release identity、SQLite certification 与 Supported Limits 仍属于 G8/G9，当前只存在显式 `development_checkout` binding。

## 当前风险与待验证项

| ID | 类型 | 状态 | 描述 | 处理 Gate/切片 |
| --- | --- | --- | --- | --- |
| R-001 | Toolchain | CLOSED | exact Node/npm/direct dependency/lock/CI/managed distribution 已落地，最终 managed install/ci/typecheck/test/build 全部通过 | G0.1 |
| R-002 | Host launch identity | CLOSED | 所有 Core service/start/restart path 已切到 stable Launcher/managed build；realpath/环境隔离/fail-closed、最终 hash和 Core rebind 已验证 | G0.1 |
| R-003 | Static proof | CLOSED | G0.7 已交付 TypeScript AST/import graph、Web route、Electron DOM、Feature manifest、SQLite schema、filesystem root 的机器生成 absence/surface/candidate manifests、正反例与 legacy boundary 集成 | G0.7 |
| R-004 | Contract drift | CLOSED | G0.9 已完成 199 项 Markdown/Contract 双向 coverage、133 项完整 artifact inventory、G0.1-G0.8 exact identity pin、Gate review 与完整 G0 CI/conformance 入口 | G0.9 |
| R-005 | DDL feasibility | CLOSED | G1.1 已将完整 Logical Schema 转为 frozen executable migration/Schema Manifest，并通过真实文件 SQLite migration/reopen、constraint/trigger/query-plan、integrity/FK/introspection Gate；G1.2 只消费并验证该 identity，没有改写 artifact | G1.1 |
| R-006 | Certification | DEFERRED | G1.2 已验证 candidate 环境的 SQLite/source/compile-options/native module、managed Node、installed Launcher 与 development Core binding；Profile release/launcher identity 仍按规范保持 null，Supported Limits 与事务预算尚未 benchmark 认证，production mode fail-closed 至 G8 | G8 |
| R-007 | Dependency audit | OPEN_OUT_OF_SCOPE | exact lock 的 `npm ci` 报告 30 项 transitive dependency audit 告警；G0.1 不运行会漂移规范 pinned identity 的自动修复，需独立依赖维护评审 | 独立维护 |
| R-008 | Formatting baseline | OPEN_OUT_OF_SCOPE | 仓库既有 `npm run format:check` 对 34 个 G0.2 外旧 TypeScript 文件报差异；G0.2 新文件 targeted Prettier 通过，未把无关批量格式化混入原子提交 | 独立维护 |
| R-009 | Concurrent repository change | CLOSED | `32f3c51` 只新增范围外 evaluation 文档；G0.2 最终 HEAD/边界和 staged set 已验证，提交保留且未混入 G0.2 内容 | G0.2 |
| R-010 | Node loader deprecation | OPEN_OUT_OF_SCOPE | Node 26 下 pinned `tsx` loader 在 `contracts:generate/check` 报 `DEP0205 module.register()` deprecation warning，但命令退出码为 0；G0.2 不升级非规范依赖或替换工具链 | 独立工具链维护 |
| R-011 | Concurrent repository change | CLOSED | G0.4 施工期间新增 `982e3b6/5989b8e`，只对进度文档同一句措辞修改后逐字回退，净 tree 未改变；G0.4 保留提交并在其上原子交付 | G0.4 |
| R-012 | Full regression baseline | OPEN_OUT_OF_SCOPE | G1.2 两次串行完整 suite 均为 78/79 files、716/717 tests，唯一失败继续是 `credential-proxy` async trace 250ms intermittent；G1.2 10/10 与其余 716 tests 均通过，未修改 credential-proxy/trace 文件或测试 | 独立测试稳定性维护 |
| R-013 | Contract test timing baseline | OPEN_OUT_OF_SCOPE | G1.1 曾在并发负载下复现 G0.6 5s timing；G1.2 串行 `test:g0` 15/15 files、109/109 tests 和两次完整 suite 均未复现。G1.2 不调整 timeout 或 G0.6 既有实现 | 独立测试稳定性维护 |
| R-014 | Capacity governance | CLOSED | G0.10 已机器化 closed publication/command、权限/Actor/entrypoint/delegation、revision/hash CAS、reason/denial、immutable audit tables、唯一 Publisher/Watcher protocol、Admission lineage、crash recovery 与 additive Gate evidence；G1 DDL 可开始 | G0.10 |
| R-015 | Toolchain test timing | OPEN_OUT_OF_SCOPE | G1.1 曾复现 runtime-toolchain 5s timing；G1.2 串行 `test:g0` 和两次完整 suite 均未复现，toolchain tests 通过。G1.2 不调整 timeout 或 managed toolchain 既有实现 | 独立测试稳定性维护 |

## 下一步

G0.1-G0.9 historical identity、G0.10 additive current root 与 G1.1/G1.2 executable schema/Store Base 均已完成；current G0/I11 与 G1 为 `DONE`，G2 为 `READY`。下一会话实施 `G2 Compiler / Sealed Golden`：只按规范完成 Production Compiler/normalizer/lowerer/proof、Golden semantic review/approval/sealing 与 compiler/toolchain identity，不开始 G3 Registry/Authoring/Publish、G4 bootstrap、Runtime/Scheduler/Capacity、Runtime Center/UI、Supported Limits certification 或 production activation，并继续保留 R-012/R-013/R-015 为范围外基线。
