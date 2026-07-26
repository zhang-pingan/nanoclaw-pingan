# Dynamic Workflow Runtime 实施进度

> **状态**: `G2_G5_STATIC_CHILD_PLAN_PREREQUISITE_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION/NOT_DONE`
> **当前 Gate**: R-019/Schema 7/Store/G3/G4保持`DONE`；Compiler 3.0.5/G2与G5因static child Plan prerequisite repair显式reopen为`IN_PROGRESS`；G6-G9=`NOT_READY`
> **下一独立会话**: 只能由中控创建fresh independent local G2/G5 affected-chain regression；通过前不得恢复G2/G5 closure或开始G6
> **最后更新**: 2026-07-25
> **规范权威**: `local/docs/dynamic-workflow-dag-framework.md`

## 文档职责

本文是 Dynamic Workflow Runtime 的实施状态账本，用于跨会话记录已经完成的施工切片、实际交付物、验证证据、提交和下一步。本文不定义 Runtime 语义，也不替代架构规范；类型、状态、事务、Logical Schema、Gate 和验收条款冲突时，始终以 `local/docs/dynamic-workflow-dag-framework.md` 为权威，并先修正规范或 Contract Pack，不能由实现自行选择语义。Machine Contract只绑定自己拥有的规范章节或closed contract values，不得以整份持续编辑的主规范raw hash作为无关领域identity输入。

下一会话 Prompt 不写入本文。每个施工切片完成并提交后，由当前会话在最终回复中根据实际 commit 和验证结果生成下一会话 Prompt。

## 强制会话协议

每个新会话开始施工前必须：

1. 完整阅读 `local/docs/dynamic-workflow-dag-framework.md`，不得用本文或局部摘要代替全文。
2. 阅读本文，确认当前 Gate、下一施工切片、已完成证据和未解决风险。
3. 执行 `git status --short`、`git branch --show-current`、`git log -5 --oneline`，并阅读本文记录的最后一个施工提交。
4. 根据规范“实现索引”确定工作包 ID，重点复读其主要入口、必须联读、核心不变量和完整验收标准。
5. 使用 `rg` 搜索本次涉及的类型、表、事务编号、Error Code、状态值和验收关键词在规范全文与仓库中的全部引用。
6. 明确本次允许修改的模块、禁止越过的 Gate 和验收命令后再编辑文件。

执行冻结RC fresh independent review的新会话不适用上面的进度账本与Git历史读取要求。该会话的输入必须且只能是current架构规范语义、current machine Contract、Contract README和唯一冻结RC bundle；不得读取本文、`git log`/`git show`、archive review artifacts、历史worksheet或任何历史review结果。review prompt不得包含历史判断、逐case结果、finding来源或review结论。

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
- Runtime v1施工遵循`WORKING -> RC_REVIEW -> BASELINE_ACCEPTED -> CONSTRUCTION_ARCHIVED`临时生命周期。未Seal/未Published的Working Contract、Schema、Compiler、Fixture与生成物可以原路径重建；identity用于current一致性，不形成生产兼容承诺。被拒中间候选只由Git commit history保留，不进入active Contract graph或默认current验证；current checkout不保留独立review工作表，Production Runtime与current/archive checks不读取`.git`或调用`git log`。
- 只有显式`prepare-rc`产生的单一RC需要完整fresh independent review；RC绑定输入变化即失效并退回`WORKING`。Working修正不得按v5/v6递增、不得每版重置40-case judgment，也不得创建approval/seal。生产`PUBLISHED/ACTIVE/DRAINING/RETIRED`、旧Run exact version pinning、Retention与compatibility规则不受该施工政策影响。
- 所有新 Runtime 语义实现位于 `src/workflow-runtime/`；不得向 `src/` 顶层增加新的 Workflow Runtime 模块。无 Node 前置依赖的 managed toolchain bootstrap/launcher 与既有 setup/launchd renderer 是唯一 host-infrastructure 例外，不得包含 Runtime 语义。
- 严格遵守 G0-G9 依赖。Gate完成允许下游消费current输出；真实finding需要改变上游时必须显式reopen并重建受影响下游evidence，而不是为未发布施工候选维护additive链。G0.1-G0.10/G1/R-016既有历史identity作为construction provenance保留；current Contract Pack root必须包含Capacity control-plane后才能支撑G1 Store/DDL。G2 Compiler/Golden不依赖Capacity control-plane语义；Executable DDL Gate完成前不得实现`WorkflowRuntimeStore`、Reconciler或production Domain Definition。
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
| G1 DDL / Store | `DONE` | G0.10 | additive Schema 7、6到7 upgrade与NodeOutputEnvelope Value boundary已通过独立affected-chain regression；Schema 5/6冻结 | 本原子闭合提交 |
| G2 Compiler / Golden | `IN_PROGRESS` | G1 + R-019 | Compiler 3.0.5 additive static-child-Plan bundle candidate已构建；冻结G2 v6仍40/40 exact，当前candidate必须通过fresh independent affected-chain regression后才能恢复closure | - |
| G3 Registry / Authoring / Publish | `DONE` | G1 + G2 | G3.1/3.3/G3.5/G3.6/G3.7/G3.9 current pins已级联重建并通过独立affected-chain regression；G3.8A冻结 | 本原子闭合提交 |
| G4 Test Bootstrap | `DONE` | G1 + G2 + G3 | additive G4 authority successor绑定Schema 7/G2 v6/current G3并通过独立affected-chain regression；历史G4 bootstrap全树冻结且不可重写 | 本原子闭合提交 |
| G5 Basic Runtime | `IN_PROGRESS` | current G1-G4 authority + G2 static-child-Plan bundle repair | T2a parent/child Plan与generated-schema authority原子持久化candidate已重建；fresh independent affected-chain regression尚未执行 | - |
| G6 Dynamic / Close | `NOT_READY` | G5 | T7/T8/child/compensation fixtures | - |
| G7 Control / Card / Projection / Recovery | `NOT_READY` | G6 | Deadline Watchdog -> Gateway -> T7c stable-key/System Grant/audit + authorized manual retry handoff + T6e/resolution/recovery/card/projection fixtures | - |
| G8 Certification | `NOT_READY` | G7 | certified profile meeting Product Floor | - |
| G9 Production Activation | `NOT_READY` | G8 + fresh current G0/G0.10 manifests | activation + Capacity genesis/preservation audit + startup/empty-state or Recipe smoke | - |

## 工作包总览

| 工作包 | 范围 | 状态 | 当前 Gate/切片 |
| --- | --- | --- | --- |
| I0 | Publish、Registry、Recipe 与执行版本固定 | `IN_PROGRESS` | G3 current exact closure已随Schema 7/G2 v6重建并由G5 exact execution binding消费且通过独立whole-gate regression；G6+继续使用固定版本authority |
| I1 | Intake、Routing、幂等创建、Child provenance、Claim | `IN_PROGRESS` | G5 intake/routing/domain claim production语义与closed fixture evidence已通过独立whole-gate regression；Child provenance继续属于G6+ |
| I2 | Definition、State lowering、Context、transition | `IN_PROGRESS` | Compiler 3.0.5 static-child-Plan bundle candidate保持既有lowering；冻结G2 v6仍40/40 exact，fresh independent affected-chain regression待执行 |
| I3 | Source/Compiled IR、Port、Compiler | `IN_PROGRESS` | Compiler 3.0.5在unchanged parent Plan之外返回closed content-addressed static child Plan bundle；current G2重新开启且未closure |
| I4 | Runtime Store、SQLite relation、Value/Blob、migration | `IN_PROGRESS` | Schema 7与独立NodeOutputEnvelope Value write/read/reopen/recovery boundary已通过回归；Blob/GC仍未实现 |
| I5 | Graph 状态机、reconcile、Scheduler、Ledger | `IN_PROGRESS` | G5 T2a prerequisite candidate原子持久化parent/child Plans与generated-schema authority；G5重新开启，G6仍`NOT_READY` |
| I6 | Delegation/System、Capability Effect、Outbox | `IN_PROGRESS` | G5 T5 exact execution binding与T6a/T6b已通过独立whole-gate regression；G6+未开始 |
| I7 | Durable Wait、Signal/Timer/Approval、Inbox | `IN_PROGRESS` | G5 wait/inbox与automatic retry timers已通过独立whole-gate regression；Workflow deadline继续归未来G7 |
| I8 | Subgraph、Expand、Map、child scope | `NOT_READY` | G2/G5 prerequisite candidate独立回归通过前不得开始G6 |
| I9 | Completion、Cancel、Compensation、Finalization、Recovery | `NOT_READY` | G5历史blocker行为保持；G6 close/T7/T8与G7 T6e resolution/abandon/Recovery均不得开始 |
| I10 | Runtime Command、Capacity Admin、Runtime Center、Trace | `IN_PROGRESS` | G5 Capacity Admin与Operational Blocker open/cache已通过独立whole-gate regression；Workflow Deadline/Gateway/T7c/manual authorization仍归G7且未开始 |
| I11 | Contract Pack、managed runtime toolchain/launcher、测试模型、发布门禁、absence baseline | `IN_PROGRESS` | additive G2/G5 static-child-Plan prerequisite candidate已构建，fresh independent affected-chain regression待执行 |

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
| G1.3 | Dependency Identity Repair | `DONE` | closed exact-member dependency manifest；physical identity与Gate provenance分离；Store不扫描Contract目录；migration bytes/78 tables/行为不变 | 本原子提交 |
| G1.4 | Publisher Idempotency / Audit Schema Prerequisite | `DONE` | additive physical input；3张first-class Publisher表；schema-bound Value、typed FK、caller UK、invocation/event hash chain；Database Schema 2；G1/G3 identity cascade；无Publisher业务事务 | 本原子提交 |
| G1.5 | Feature Release Activation Schema Prerequisite | `DONE` | additive physical input；3张Activation表；pointer owner/CAS、Release lifecycle、held Retention binding、recovery queries；Database Schema 3；无Activation DML | 本原子提交 |
| G1.6 | Activation Failure / Replay Persistence Schema Prerequisite | `DONE` | 消费G3.8A；重建Activation command/invocation/event、分离caller claims/verified facts、canonical terminal result binding；Database Schema 4；empty-only Schema 3 upgrade；无Activation DML | 本原子提交 |
| G1.7 | Capacity Admin Prepared Invocation Schema Repair | `DONE` | 历史Schema 4不变；current Schema 5增加immutable CAP1 `prepared`、拒绝新`applied`、保留全部合法Schema 4 terminal历史并严格约束current insert；无Capacity或G5业务DML | `37a9792` candidate + 本原子提交独立回归 |

## G2 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 | 完成提交 |
| --- | --- | --- | --- | --- |
| G2.1 | R-016 Spec/Contract Repair | `DONE` | lowering outcome、Compiled IR v2、完整 case result target、exact input binding requirement与 blocked Draft v2冻结 | 本原子提交（历史） |
| G2.2 | Production Compiler / Exact Case-Input Identity | `DONE` | locked strict parser、closed validation、snapshot binding、static lowering、Plan normalization、program/proof/hash/diagnostic、真实 toolchain与40个actual candidate results | 本原子提交 |
| G2.3 | Working Correction / RC Review / Seal | `DONE` | phase=`BASELINE_ACCEPTED`；前序四个Working root、RC、Draft、review、GoldenSemanticReview和157-artifact seal未变；additive successor Draft/report已批准，versioned GoldenSemanticReview与157-artifact seal完整，current replay 40/40 | 本原子提交（successor approval/seal） |
| G2.4 | Static Child Plan Bundle Prerequisite Repair | `IN_PROGRESS` | Compiler在unchanged parent Plan外返回closed child Plan bundle；T2a exact验证并原子持久化全部Plan/schema authority；冻结v6 40/40 exact；fresh independent affected-chain regression待执行 | - |

## Runtime v1施工治理调整

**状态**：`DONE`。本切片只调整未Seal、未Published、Production不可达的施工期identity/review规则，没有修改生产Registry、Feature/Core Release、Execution Artifact、Run Snapshot、Retention、compatibility preflight或G9 activation语义。

生效后的临时施工生命周期：

```text
WORKING -> RC_REVIEW -> BASELINE_ACCEPTED -> CONSTRUCTION_ARCHIVED
```

- 当前G2处于`BASELINE_ACCEPTED`。前序R-017 Working/RC/Draft/review/seal作为immutable lineage保留；additive replay-repair successor以独立versioned Working/RC/Draft/report/GoldenSemanticReview/seal完成3.0.1 identity级联，current replay 40/40后关闭R-017。G3仍未开始。
- 历史review evidence只存在于Git commits，不是current dependency；旧施工artifact的独立复验属于archive入口，不进入默认current链。
- Current Working Contract重新实时读取完整R-017段落并计算raw/domain-separated hash；Contract及全部受影响下游Working artifact已由现有generator级联重建，定向/完整G2机械测试通过。
- 新四个Working root连续两轮一致后，显式独立`prepare-rc`已冻结单一前序RC；任一绑定source/toolchain/compiler/Contract/input/candidate/working-review identity变化都使其check fail-closed。前序owner-approved seal因3.0.0 identity与3.0.1实现不一致保留29/40历史复验；修复未伪造旧identity，而是建立additive successor。successor exact Draft/report经owner批准后生成immutable GoldenSemanticReview与seal，current 3.0.1 replay为40/40，因此G2进入`BASELINE_ACCEPTED`。
- G0-G9与同一release验收完成后归档本施工生命周期；长期保留的是生产资源版本控制和旧Run exact artifact pinning，而不是G0-G9施工Draft链。

Current Working identity：

| Artifact | Hash / status |
| --- | --- |
| G2 Working Contract root | `sha256:a2d8bcab971d1db75aad17d152c7c616371a4ceeb8d52f408674d744cf7866b8` / `WORKING_MUTABLE_NOT_PUBLISHABLE` / `history_owner=git_history_only` |
| G2 Working input manifest | `sha256:83080db01627d5b42046ce0a2e229ee3f4099208a8bfa2b028fc9b6241272dc8` / `WORKING_INPUTS_CURRENT` |
| G2 Working actual candidate root | `sha256:54ba5b80b92a9c053e4439964fbea03326c9c8b7fc3cc3fe244dffa2144d341a` / `WORKING_COMPILER_COMPARISON` |
| G2 Working review bundle root | `sha256:a254eec500006f1c7210835607cf0c20c9c6cc0647ae06a43ef2943d169d5c92` / `working_not_review_candidate` |

Current Review Candidate identity：

| Artifact | Hash / status |
| --- | --- |
| RC root | `sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577` / `RC_REVIEW` |
| RC cases | `sha256:1f374fd89cdfb90a98eb88372e8552e9eda96ffe486a68c65e1e9966631555b0` / 40 cases |
| Fresh-review handoff | `sha256:4a80964b5af42ea83c049c9a9fe5e0b33606ad738423f221ee2f8ed0dba6ad9f` / review not requested |
| RC leaf inventory | `sha256:dd28f3ffbef73e26cedaae30b512a5d8af5e1d6cd78b671a742f184b226be359` / 2 exact leaf entries |
| RC artifact tree | `conformance/review-candidate/g2-semantic-correction/` / 4 artifacts / tree digest `sha256:f521c8ceb3cbb8362faef3270ce3d5bec8cfa0bbd28a4fa95cab0c40ea52e613` |

验证与边界证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g2:contract` | PASS；1 file / 6 tests；独立读取current R-017、独立计算raw/domain-separated hash、machine字段逐字匹配，模拟段落变化时check检测drift；Contract source不读取Git metadata |
| managed `npm run test:g2:working` | PASS；3 files / 24 tests；40-case replay保持11 compiled / 29 rejected |
| managed `npm run test:g2` | PASS；5 files / 42 tests；40-case replay保持11 compiled / 29 rejected |
| managed `npm run test:g2:prepare-rc` | PASS；1 file / 15 tests；覆盖无RC WORKING、合法RC、损坏RC、冲突RC、identity drift、重复冻结及顶层/嵌套/draft前缀v5/v6路径 |
| 无RC lifecycle checks | PASS；strict `npm run prepare-rc:check`按预期失败并报告RC未准备；默认`npm run contracts:check`验证四个Working roots、`WORKING` lifecycle、Schema/Store后成功 |
| managed Working generators（连续两轮） | PASS；两轮Contract/input/candidate/review roots均为`a2d8bc...66b8` / `83080d...72dc8` / `54ba5b...341a` / `a254ee...5c92`，四树合并digest均为`sha256:489362c6328cbb34a15564a46c14aa23b2e557f696f756c0a3f3931024c43fb3` |
| managed `npm run prepare-rc` + `npm run prepare-rc:check`（连续两轮） | PASS；两轮RC root均为`sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577`，artifact tree digest均为`sha256:f521c8ceb3cbb8362faef3270ce3d5bec8cfa0bbd28a4fa95cab0c40ea52e613` |
| current R-017 identity | PASS；独立实算raw=`sha256:b7988bea9205120fc071d900d48e4f76fd2805b45d6669661a6b6e8e09acf527`、semantic=`sha256:7b198f61df2bb321837937c44bbb442dd99215a6dd68fa20f4b0f3c6a9df8f38`，与machine Contract字段完全相等 |
| `git_history_only` governance scan | PASS；current规范/账本不保存历史review判断、逐case结果、finding来源或review结论；Working Contract仅在施工期generate/check读取current R-017正文，不读取`.git`、`git log`或`git show`，Production Runtime不读取Markdown；fresh reviewer不读取账本、Git history或archive review artifacts |
| 新RC managed `npm run contracts:check` | PASS；默认链报告`RC_REVIEW`并严格验证current machine artifacts、四个Working roots、唯一RC、全部绑定、Schema与Store |
| managed `npm run contracts:archive:check` | PASS；历史G0/G0.8/G0.9/R-016/Draft v3通过显式archive入口复验 |
| managed `npm run test:g2:archive` | PASS；2 files / 13 tests |
| existing managed `npm test` baseline（本切片未重跑） | 83/85 files、754/756 tests通过；失败仅为既有R-012 `credential-proxy` 250ms async trace断言与并发负载下R-013 G0.6 5s timeout；R-015 toolchain 5s同样保留为已登记范围外timing baseline |
| managed standalone G0.6 | PASS；1 file / 8 tests，确认完整suite中的G0.6失败仍为既有负载timing基线 |
| managed standalone `credential-proxy` | 20/21通过；同一R-012 async trace断言在257ms失败，未修改该模块或放宽测试 |
| `git diff --check` | PASS |
| active Working/RC publication scan | PASS；四个Working root为`WORKING`；唯一RC为`RC_REVIEW`；全部`publishable=false`、`production_reachable=false`；无Contract v2、Draft v5/v6、additive RC或第二current RC |
| expected/review/seal boundary | PASS；40/40 expected full result/Plan/proof/program bytes/hash为null；human judgment 0/40/not requested；approval/signature/seal absent；sealed artifact count=0 |
| production boundary | PASS；Production Compiler root保持`sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77`，Schema root/hash保持`sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756` / `sha256:4d8c373387ad515c36fd292b705665e6c197c73021c1b7e55da5317bc140efbd`，Store/Profile identity保持不变；未修改Production Registry/Feature Release/Core Release、Run exact pinning、Retention/compatibility preflight；`conformance/sealed/`仍只有`.gitkeep` |
| prepare-rc时点的fresh-review machine precondition | PASS；唯一RC strict check、current `RC_REVIEW` check、四个Working root binding、40-case coverage与全部absence边界均一致；该prepare-rc切片结束时review尚未执行 |

## G2 RC Fresh Independent Review

**状态**：`PASS`；这是唯一RC的fresh independent review施工证据，不是machine judgment、human semantic approval、`GoldenSemanticReview`或seal。

审查严格绑定RC root `sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577`。开始语义审查前，managed `npm run prepare-rc:check`与managed `npm run contracts:check`均PASS，并独立确认唯一RC、4/4 artifact inventory和40-case coverage。

审查从current规范与machine Contract独立覆盖全部40 cases；Production Compiler actual只作为comparison input，不作为expected oracle。结果为40/40 cases通过，其中11 compiled、29 rejected；29/29 diagnostics、120/120 source/snapshot/actual bindings，以及全部Result/Plan/proof/program/hash与R-017语义检查通过，无finding。

审查会话未读取本账本、Git history、archive review artifacts、历史worksheet、历史judgment或review结论；未修改Working/RC identity，未生成approval、signature、immutable `GoldenSemanticReview`、seal或`conformance/sealed/`内容，也未开始G3+。因此current machine state有意保持`RC_REVIEW`、human judgment 0/40/not requested、expected bytes 0/40、approval/signature/seal absent；fresh review的aggregate PASS仅作为本账本中的非规范施工进度证据，未进入active Contract dependency graph。

## G2 review history boundary

prepare-rc前的历史review evidence只存在于Git commits，不是current dependency。Current checkout不保存历史逐casejudgment、finding来源或独立review worksheet；本账本只记录上方唯一current RC fresh review的aggregate PASS与覆盖数，它不是machine Contract、默认current检查或Production Runtime的输入，未来任何fresh reviewer仍不得读取本账本。

`contracts:archive:check`只复验施工artifact的机器identity，不向fresh reviewer提供历史review内容。Current G2 machine状态、Working roots、唯一RC identity、机械验证和未越过边界仍以current machine artifacts为准；本账本不把aggregate PASS冒充已持久化judgment或approval。

## 已完成切片：G2.2 Production Compiler / Exact Case-Input Identity

**状态**：`DONE`；G2总Gate为`IN_PROGRESS`，仅Production Compiler vertical slice完成，Golden review/seal仍未开始。

**工作包**：I2/I3，合同验证联动I11。本切片实现Production Compiler与actual candidate证据，不修改G0.3/G0.8 historical artifacts或R-016 repair Draft v2，不由Compiler生成或批准expected oracle；没有执行`GoldenSemanticReview`、`golden-seal`、conformance/sealed写入、G3+、SQLite certification、Core Release、G8/G9 identity或production activation。

交付内容：

- `src/workflow-runtime/compiler/`实现locked strict JSON parser接入、closed Graph Source/Workflow Definition与locked Workflow Schema profile、Registry/Interface/Policy/Safety snapshot binding、Definition delegation/system static lowering、八类Graph node lowering、route/trigger/completion/safety/policy/quality/child recipe检查、Compiled IR v2 normalization及完整Plan hash；Recipe owner/closure解析只依赖snapshot exact refs，不依赖fixture/case命名。
- condition program固定left-to-right operand evaluation order、`operand_types`、schema hashes、steps与program hash；data edge生成canonical pointer tokens、totality/assignability proof和proof hash，支持不同schema hash的sound `enum_subset`；Map固定`result_order=item_index`，static child closure按parent-before-descendant完整嵌入并重算member/closure hash。
- 发布真实`WorkflowCompilerToolchainManifest`，绑定managed Node/npm、exact lock/integrity、strict parser wrapper、Graph/Definition schema profile、normalizer/proof/compiler源码集、Error Catalog、IR v2与result schema exact identity；frozen G0.8 snapshot中的三个`absent`只保留为历史事实，不参与resolved G2 identity。
- 发布`g2-case-input-binding@1.json`新版本，对40个frozen raw/snapshot pair逐项绑定14个exact identity字段并计算effective input hash；发布40份由真实Compiler生成的完整actual case result（10 compiled / 30 rejected）及candidate manifest/root。candidate disposition明确为`actual_compiler_output_not_golden_oracle`。
- G0.8与R-016旧live generator都包含当时“Compiler不存在”的构造边界；本切片未改其generator/source/artifact bytes，新增frozen root/inventory verifier并让日常Contract入口只读验证历史identity。G2 generator/checker作为独立package步骤运行，保持`contracts/`不反向依赖`compiler/`。

关键identity：

| Artifact | Identity |
| --- | --- |
| G2 Production Compiler root | `sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77` |
| WorkflowCompilerToolchainManifest | `sha256:8bbbdf888bc531ed135adbd3641ea5bdd8aa605e332ab7ac3ac919a45a90ef45` |
| Production Compiler build | `sha256:acfeea59ca1e8ad117642152f51043dd1c581f1153942efaded44e9dc165c7ee` |
| Canonical Normalizer | `sha256:7d08408f780ca4350e153d99fd60810554daefe3826b39fe5e2fa5abee340b60` |
| Proof Algorithm | `sha256:e1f32fc4ceec2efa7cb9c19bbf91abd0487d044fa62aee682de836c0b2c03a5b` |
| resolved exact case-input binding | `sha256:538e77e33aeb8ca684388a83ee5a5a63a1b70aaa5cacc239be5f65814e9c18dc` |
| actual candidate results manifest | `sha256:c471bcf03ea23ce2d84d5a785b026ae222ec47f7d5fd5948bb8e19c89904b1d2` |

验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run compiler:g2:generate` / `npm run compiler:g2:check` | PASS；生成后read-only replay逐字节一致，G2 root=`c78a12…013a77` |
| managed `npm run test:g2` | PASS，1 file / 8 tests；40-case deterministic replay、30个hand-authored diagnostic tuple、10个positive semantic assertions、Plan/result/program/proof/toolchain/binding identity、额外literal/nested-condition/recipe-name-independence负例与boundary全通过 |
| managed `npm run test:g2:contract` | PASS，1 file / 7 tests；R-016 root=`776d51…50b324`与全部repair artifacts保持冻结 |
| managed `npm run contracts:generate` / `npm run contracts:check` | PASS；G0.8、G0.10、R-016、G1、G2 roots与Store candidate/not-certified状态逐项通过 |
| managed `npm run test:g0` | PASS，15 files / 109 tests；historical G0.8 verifier替代已过期absence construction check，Draft bytes未改 |
| managed `npm run test:g1.1` / `npm run test:g1.2` | PASS，12/12与11/11；G1 identity、78-table migration与Store行为未漂移 |
| managed `npm run typecheck` / `npm run build` | PASS |
| managed `npm test` | 最终79/81 files、735/737 tests通过；仅R-012 credential trace与R-013 logical-schema 5s既有范围外timing baseline失败，R-015 runtime-toolchain本次5/5通过；G2 8/8通过。前一run另命中R-015与G0.7 5s，G0.7随后定向18/18且最终全量通过；未放宽测试 |
| targeted Prettier / `git diff --check` / boundary scan | PASS；sealed仅`.gitkeep`，无Golden approval/seal、G3+、certification/release/activation文件；G0.3/G0.8/R-016/G1/migration identities保持 |

## 已完成切片：G1.3 Dependency Identity Repair

**状态**：`DONE`

**工作包**：I4；合同验证联动I11。本切片只修复current G1 Schema/DDL dependency identity、重新基线current G1 artifacts并更新G1.2 Store pins；没有实现Production Compiler、Golden review/approval/seal、Core Release Manifest、G3+、G8/G9 identity、Runtime业务逻辑或conformance sealed内容。

Current G1不再递归扫描`contracts/**/*.json`，也没有目录排除列表。新发布的closed `icarus.workflow-runtime-schema-dependency-manifest/1`固定8个required members，并逐项记录`role/path/format/ref/version/semantic_hash/raw_sha256`：G0.6 Logical Schema Manifest、Logical Schema Source、Typed Relation Catalog、Query Catalog、G0.10 Capacity Logical Schema Delta、SQLite Profile、Schema Manifest和canonical migration。G0.6 manifest明确标为`construction_provenance`；其余5个真实输入和2个物理输出形成`physical_schema_identity`。G0.10 current root继续只作为本账本中的施工来源记录，不进入Schema Manifest、physical identity、current G1 root或Store启动校验。

Schema Manifest的`logical_inputs`现在只包含Logical Source、Typed Relation、Query Catalog、Capacity delta和SQLite Profile semantic hashes；删除了上游Gate root/pack root字段。Store启动读取并验证8个exact members及其semantic/raw identity，新增无关Compiler/Golden/Registry JSON不影响启动或任何G1 identity。未来Core Release Manifest绑定schema/migration/profile的最终迁移仍只按规范S39规划，本切片没有创建release identity。

正反测试覆盖：任意新增无关Contract JSON不改变dependency manifest或current G1 root binding；required member raw-byte变化产生新的显式manifest/physical identity，same-ref semantic drift fail-closed；删除required file/member、duplicate role/path、unknown field、member hash mismatch全部失败；contract明确`path_model=exact_required_members_only`且`directory_exclusions=forbidden`，不能靠增加排除规则绕过。

Current identities：

| Artifact | Identity |
| --- | --- |
| G1.3 Schema Dependency Manifest | `sha256:ea039f582f0ebff2fb9bc7e512825612cf8f0f93ccdd4c5e43345f56ca2b7b89` |
| Physical schema identity | `sha256:8c667d62f69a8c67ba1edde467562e370377342a058b6dc4673ab9a383fe05a1` |
| G1 executable schema root | `sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756` |
| Domain-separated Schema Manifest hash | `sha256:4d8c373387ad515c36fd292b705665e6c197c73021c1b7e55da5317bc140efbd` |
| Schema Manifest artifact | `sha256:02e8d7511386c82458120d65ea6eb97f3ed26941abd757d2314e58ccc91fcb3b` |
| Executable DDL artifact | `sha256:d25fdd25fee0d1cd579c7229237ad4dddd0f0a80779505012a6743b656b84ec5` |
| Deterministic digest | `sha256:f3dc5f3364a31c153cbf78ac0276d6467627c547e0939ac8e56e6f1ce8e65f15` |
| Canonical migration raw SHA-256 | `sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61` |

Physical evidence保持不变：canonical migration与HEAD逐字节相同且Git diff为零；真实文件SQLite仍重建78张表，并通过相同constraint/trigger/query-plan、bootstrap/reopen、WAL/Profile、transaction和read-only行为测试。G0.10 construction root保持`sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec`，R-016 root保持`sha256:776d516ba6c8c73a7da33895a4f4f3680054a1e93fbf056acdfc3ec36550b324`；二者都不是physical schema identity。

最终验证均通过managed runtime串行执行；Node 26 `DEP0205 module.register()`告警保持既有R-010。完整suite只保留既有R-012/R-013/R-015 timing baseline，没有修改或放宽相关实现、测试或timeout：

| 命令/证据 | 结果 |
| --- | --- |
| managed `npm run schema:generate` / `npm run contracts:check` | PASS；deterministic/read-only Schema与Store checks通过，G0.10、R-016和current G1 roots逐项匹配 |
| managed `npm run test:g0` | 最终PASS，15 files / 109 tests；首次仅复现R-015 toolchain 5s timing，原测试不变后复跑全通过 |
| managed `npm run test:g1.1` | PASS，1 file / 12 tests；包含closed manifest及required/unrelated/duplicate/unknown/hash正反验证 |
| managed `npm run test:g1.2` | PASS，1 file / 11 tests；包含无关Contract JSON启动、78-table bootstrap/reopen和Store行为验证 |
| managed `npm run test:g2:contract` | PASS，1 file / 7 tests；R-016 root与Compiler/Golden/G3+ absence boundary保持 |
| managed `npm run typecheck` / `npm run build` | PASS |
| managed `npm test` | 77/80 files、726/729 tests；失败仅为R-012 trace 250ms、R-013 G0.6 5s、R-015 toolchain 5s；G0.6定向8/8、toolchain定向5/5通过，R-012定向维持既有20/21 baseline |
| targeted Prettier / `git diff --check` | PASS；只检查本切片TS/README，生成JSON与大型规范/账本保持仓库既有格式 |
| migration/schema/boundary proof | PASS；migration=`d89829…9f61`且无diff，Manifest=78 tables，G0.10=`21d06c…a0a7ec`，R-016=`776d51…50b324`，无sealed/Compiler/G3+越界文件 |

## G2 R-016 Spec/Contract Repair：DONE

**状态**：`DONE`；R-016 `CLOSED`，G2/I2/I3 由 `BLOCKED_BY_SPEC` 转为 `READY`。

**工作包**：I2/I3 Contract 边界。本切片只修改主架构规范、Contract Pack、Golden Draft v2、定向测试和本账本；没有实现 Compiler、normalizer、lowerer、proof/program，没有创建 Golden approval/seal、`conformance/sealed/` artifact、`test:g2`，也没有开始 G3+、G8/G9 identity、SQLite certification 或 production activation。

R-016最初以独立addendum交付，原因是G0.10错误地把整份主规范raw hash纳入Capacity identity。后续开发审查确认该绑定范围过宽：Compiler正文变化不应级联改变Capacity语义。当前已完成开发期有意重新基线，删除独立addendum，把S38和完整R-016决议合并回`dynamic-workflow-dag-framework.md`，并同步修正原文中的Compiled IR、Map、condition和Golden target定义。主规范恢复为唯一规范入口。

G0.10 Markdown coverage不再保存整份架构文档`architecture_sha256`，而以`spec_binding_scope=capacity_contract_values_only`只绑定33个Capacity closed contract values及coverage结果。定向测试证明追加无关Compiler正文不改变Capacity coverage hash，删除Capacity permission value会进入`contract_values_without_markdown`并失败。R-016 repair pack只绑定主规范的`### R-016：Compiler/Golden Contract 决议`章节raw bytes，不绑定整份主规范。

1. Normalized semantic assertions 的唯一 target 固定为 closed `icarus.workflow-compiler-conformance-case-result/1`。Canonical bytes 是包含 `result_hash` 的完整 UTF-8 RFC 8785 JCS；`result_hash` 使用 domain `icarus:workflow-compiler-conformance-case-result:1\n` 对去除自身字段的 result JCS 计算。Compiled branch 的 static-lowering ref/hash 必须成对 null 或成对 non-null。
2. Delegation/system static lowering 的 normal named exits 只允许 `success/failure`。Engine error 产生 `errored -> on_error`；local graph cancel 产生 `cancelled/local_graph -> on_local_cancel`；global workflow cancel 产生 `cancelled/workflow` 并终止 Workflow、不得读取 state transition。Error/cancel 都没有 named exit。
3. Current Compiled IR bump 为 `icarus.workflow-graph-scope-plan/2`。`CompiledConditionProgramV2.operand_types`、Map `result_order:'item_index'` 和 embedded hashed `static_child_plan_closure.members` 全部进入 Plan canonical bytes/hash；Child Plan bytes继续是独立 content-addressed Plan refs，不创建第二份 sealed oracle。
4. `icarus.workflow-compiler-g2-case-input-binding/1` additive binding 精确包含 Toolchain Manifest、Compiler build/version、Canonical Normalizer、Proof Algorithm、Error Catalog、Compiled IR schema与 Conformance Result schema ref/version/hash，并为每个 frozen G0.8 raw/snapshot pair计算 effective input hash。Historical snapshot 的三个 `absent` 只表示 G0 stage fact，不是 G2 identity。
5. G0.3 Compiled IR v1与 G0.8 Draft v1/published snapshots保持原 bytes/hash。R-016 发布隔离的 Draft v2，复用全部 40 个 historical raw/snapshot refs/hashes但保持 `blocked_pending_exact_g2_identity`；真实实现 identity/expected results 只能由未来新 Draft version发布，不能覆盖 v1或 repair v2。

新增机器 Contract 位于 `src/workflow-runtime/contracts/conformance/compiler-contract-repair/`，根目录与 `conformance/sealed/` 完全分离：

| Artifact | Identity |
| --- | --- |
| R-016 repair root | `sha256:776d516ba6c8c73a7da33895a4f4f3680054a1e93fbf056acdfc3ec36550b324` |
| Repair decision | `sha256:de8aa61350073001dd8835bcdceb63ba490729acdd32fbdc3e2aaa716299e5c7` |
| Integrated R-016 spec section raw bytes | `sha256:dfb1fdf45a5858f52a39f0dd10e382a4f2b2dfe6e35eddc4d9637a99497c84d5` |
| Compiled Scope Plan schema v2 | `sha256:4d4e325f94b55a6767f3e8596e1e9b880df2b402d3c89f587a10a23f0eadbd46` |
| Conformance Case Result schema v1 | `sha256:019a4ba80ed8ae57b6c862d9fda62d9edcb8aca9c4910fde6bbb580c09af8706` |
| Static lowering Contract v1 | `sha256:9e78643e882446209207cd42da8b635a143d4ef74a859941f5faaca4322184e5` |
| G2 binding requirement v1 | `sha256:1a5af203e39516b21ae12d598be37be5c70b9599e27b4acb73443b52cefab0d5` |
| Golden Draft cases v2 | `sha256:049bb1ff11a03b038f0128497511e4b10c8e70ff283a2bb70309f323a49c251b` |
| Golden Draft manifest v2 | `sha256:6b3d3e337c2486b71508f2b6d37f0ce4d2f475d24229f5b87af4f96fec8215e1` |

`contracts:generate/check` 现在在 G0.10 后生成或只读验证隔离 repair root；CI 新增 `test:g2:contract`，只验证 Contract repair，不冒充 G2 Compiler Gate。7 个定向测试覆盖 deterministic generation/read-only check、G0.3/G0.8 semantic/raw byte pins、IR v2 closed positive/negative shape、result canonical/hash target、lowering outcome disjointness、40-case additive identity binding和 Compiler/Golden/G3+/G8/G9 absence boundary。

G0.10 current root有意重新基线为`sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec`。后续G1.3 dependency identity repair已把该Gate root和旧目录快照从current physical identity移除；current G1 root为`sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756`，physical schema identity为`sha256:8c667d62f69a8c67ba1edde467562e370377342a058b6dc4673ab9a383fe05a1`。Physical SQLite migration raw hash始终为`sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61`，78-table executable SQL未改变。

最终验证全部通过 managed runtime串行执行；Node 26 `DEP0205 module.register()`告警保持既有 R-010：

| 命令/证据 | 结果 |
| --- | --- |
| managed Contract generation | PASS；G0.2-G0.9 identities保持，G0.10=`21d06c…a0a7ec`，R-016=`776d51…50b324` |
| managed G1 generation | PASS；G1.1 root=`8950c4…ba4c52`，physical migration hash保持`d89829…9f61` |
| managed `npm run test:g0.10` | PASS，1 file / 10 tests；包含spec-binding scope正反验证 |
| managed `npm run contracts:check` / `npm run test:g0` | PASS；read-only全链通过，15 files / 109 tests |
| managed `npm run test:g1.1` / `npm run test:g1.2` | PASS；8/8与10/10，真实文件SQLite bootstrap/reopen和identity gate通过 |
| managed `npm run test:g2:contract` | PASS，1 file / 7 tests |
| managed `npm run typecheck` | PASS |
| managed `npm run build` | PASS |
| managed `npm test` | 77/80 files、721/724 tests；失败仅为已登记R-012 trace 250ms、R-013 G0.6 5s与R-015 toolchain 5s；三者对应定向套件均通过，未修改范围外timeout或测试 |

### 2026-07-16：G2 开工审计（historical blocker record）

**当时状态**：`BLOCKED_BY_SPEC`；上述 R-016 repair 已关闭该 blocker，本段保留最小复现与审计证据，不再表示 current Gate 状态。

**工作包**：I2/I3；本次只完成 G2 开工前规范/Contract Pack 一致性审计，没有实现 Compiler、normalizer、lowerer、proof/program、Golden review/seal，也没有修改任何 G0 published JSON、G1.1 schema artifact 或 G1.2 Store/Factory contract。

2026-07-16 从 clean `main@b893b6b` 开始，完整阅读架构规范和本账本，并复核 `b893b6b`、`64923ca` 与范围外介绍文档提交 `61f6685`。G0.3 closed Source/Compiled IR、G0.4 Error Catalog、G0.8 全部 40 个 raw case/hand-authored assertions/input snapshots 和 G0.9 identity 均保持 frozen。开工审计发现下列最小冲突；任一项都无法在不扩展 closed schema、发明未定义 artifact 或改变 frozen Golden Draft 语义的情况下唯一实现：

1. **Static lowering result-set conflict**：规范 `State 与 Graph 的统一` 明确 delegation/system lower 为“单 capability node + success/failure terminal”，并在 `Root Graph 的四类结果` 中规定 engine error 与 local graph cancel 走 named exit 之外的 `on_error/on_local_cancel` 独立路径。G0.8 `positive.static-lowering` 却要求 `/normalized/interface/exits` 精确包含 `success/failure/error/local_cancel`。若把 error/cancel 加入 `GraphScopeInterfaceContract.exits`，会把独立 outcome 错写成 normal named exit；若不加入则 frozen assertion 失败。
2. **Condition program shape conflict**：规范 `CompiledConditionProgram` 和 G0.3 `compiled-scope-plan-schema.json` 只允许 `normalized_ast/operand_schema_hashes/max_steps/program_hash`。G0.8 `positive.condition-route` 要求 `/normalized/control_edges/0/condition_program/operand_types=[boolean,boolean]`。把 `operand_types` 写入 Plan 会被 closed schema 拒绝；规范没有定义包含该字段的第二个 normalized artifact、canonicalization 或 hash domain。
3. **Map normalized field conflict**：G0.3 `CompiledMapNode` 没有 `result_order`，Map 顺序语义由正文固定为 item index。G0.8 `positive.map` 要求 `/normalized/nodes/map_items/result_order=item_index`。规范没有说明该 assertion 指向 Plan、review projection 还是其他 sealed bytes，也没有定义该额外字段进入哪个 hash。
4. **Static child closure representation conflict**：规范/G0.3 Plan 只包含 `static_child_plan_closure_hash`，static child plans 作为 content-addressed closure 单独持久化；G0.8 `positive.static-child-closure` 要求 `/normalized/static_child_plan_closure/members` 包含 `nested_child/leaf_child`。Golden Bundle contract 只声明 expected Plan bytes/ref/hash 与 proof/program hashes，没有定义 closure member artifact 的 schema、bytes ref、domain separator、排序或它与 `static_child_plan_closure_hash` 的覆盖关系。

此外，G0.8 frozen input snapshot 按其 G0 阶段职责把 `production_compiler_status/canonical_normalizer_status/proof_algorithm_status` 固定为 `absent`，而规范的 G2 Compiler input 又要求 exact `WorkflowCompilerToolchainManifest`、Compiler build、Normalizer 与 Proof ref/hash。G2 可以新增 top-level toolchain artifact，但正文没有定义如何在不改写 G0.8 snapshot bytes/hash 的前提下形成该 exact per-case Compiler input identity。

禁止的临时处理包括：给 G0.3 Plan 增加字段、把 error/cancel 冒充 named exit、由 Production Compiler 生成一个自定义 `/normalized` review projection、只为 fixture 特判 assertion、修改 G0.8 expected assertion 或 snapshot、以当前 Compiler 输出反向生成 oracle、伪造 `human:local-owner` approval。按强制会话协议，必须先由规范明确唯一方案并发布相应 additive/bumped Contract Pack + Golden Draft version，再恢复 G2；当前不得创建 `conformance/sealed/` artifact 或 `test:g2` 成功门禁。

受影响退出条件：production Compiler 的 normalized bytes、Definition lowering、program/proof hash、独立 GoldenSemanticReview、sealed Bundle byte identity、deterministic replay 和 G2 Gate 状态。G3-G9 继续 `NOT_READY`，SQLite Profile 继续 `candidate/not_certified`，release identity 继续 `missing_until_g8`。

开工审计验证全部通过 `./scripts/runtime-toolchain.sh exec -- <command>` 串行执行：

| 命令/证据                 | 结果                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run contracts:check` | PASS；G0.2-G0.10、G1.1 schema 与 G1.2 Store read-only check 全通过；G0.10/G1.1/schema/migration/deterministic identity 未漂移，SQLite 仍为 candidate/not-certified、release identity 仍 missing-until-G8 |
| `npm run test:g0`         | PASS，15 files / 109 tests；包含 G0.8 frozen Draft 与 G0.9 historical verification                                                                                                                       |
| `npm run test:g1.1`       | PASS，1 file / 8 tests                                                                                                                                                                                   |
| `npm run test:g1.2`       | PASS，1 file / 10 tests                                                                                                                                                                                  |
| `npm run test:g2`         | FAIL，npm 明确报告 `Missing script: "test:g2"`；G2 因上述规范冲突尚未合法建立，未增加空测试、skip 或伪绿色门禁                                                                                           |
| `npm run typecheck`       | PASS                                                                                                                                                                                                     |
| `npm test`                | 77/79 files、715/717 tests；仅复现范围外既有 R-012 credential-proxy 250ms async trace intermittent 与 R-013 G0.6 5s timing intermittent；其余 715 tests 通过，未修改或放宽两项测试                       |
| `npm run build`           | PASS                                                                                                                                                                                                     |

Targeted Prettier 对本次 G2 blocker section 的独立 Markdown snippet 为 PASS；整份账本的 `prettier --check` 在修改前 HEAD 与当前版本均为既有 FAIL，因此没有批量格式化历史账本。`git diff --check` 为 PASS。Frozen/boundary scan 为 PASS：G0 published contracts/config、G1.1 schema tree 与 G1.2 Store/Factory tree 均无 diff，`conformance/sealed/` 仍只有 `.gitkeep`，没有 G2 Compiler 或 G3+ artifact，范围外提交 `61f6685` 仍为 HEAD 祖先。

## 已完成切片：G1.2 Store Base / Connection Factory

**状态**：`DONE`

**工作包**：I4；只实现独立 `workflow-runtime.db` 的统一 Connection Factory、`WorkflowRuntimeStore` 基座、连接/Profile/identity gate、参数化基础查询与同步短写事务 host。没有实现 Graph Store 领域操作、Runtime、Scheduler、Watchdog、Recovery、Outbox Worker、Capacity Gateway/Publisher/Watcher、Compiler/Golden、Registry、Runtime Center/UI、Supported Limits certification 或 production activation。

I4/G1.2 把 G1 migration、Schema Manifest 与发布 hashes 当作 frozen 数据库结构输入。后续G1.3已把loader pins有意重新基线为closed Schema Dependency Manifest、physical schema identity、current G1 root、schema hash、migration SHA-256、deterministic digest、Schema Manifest、Executable DDL和SQLite Profile artifact；启动时只读取manifest声明的8个exact members，同时重渲染migration、重建introspected Manifest并逐字节比较，任一真实dependency drift都fail-closed，无关Contract目录变化不影响启动。

Store/Factory contracts：

- 所有测试、只读和写连接都由 `WorkflowRuntimeConnectionFactory` 创建；拒绝 `:memory:`、SQLite URI、非 `workflow-runtime.db` 文件名和 symlink database。Factory 区分显式 `create` 与 `open_existing`，现有数据库绝不自动 bootstrap 或迁移。
- fresh bootstrap 先设置并回验 `page_size=4096`、`auto_vacuum=incremental`，再执行 frozen migration，切换 WAL 后关闭并以正式 writer/read-only 连接重开。已有数据库在发出任何 Profile setting PRAGMA 前先验证 WAL/page size/auto vacuum，不为迎合 Profile 自动修改 database-level 属性。
- strict Profile loader 使用 closed keyset/literal enum/boolean；全部 numeric 字段必须是 finite safe positive integer，唯一例外是明确固定为 `0` 的 `mmap_size_bytes`。验证完成前没有 Profile 值进入 PRAGMA。
- writer 设置并回验 WAL/FULL/FK、busy timeout、temp store、WAL checkpoint、journal/cache/mmap、trusted schema、recursive trigger、read-uncommitted、locking mode 和 `query_only=OFF`。read-only 连接使用 SQLite readonly open，先只读验证已有 WAL/database-level Profile，再设置 connection-local Profile 和强制 `query_only=ON`；写入与关闭后查询均被拒绝。
- `WorkflowRuntimeStore` 私有持有唯一 in-process raw writer，并为基础查询持有独立 Factory read-only connection；公开 API 只有显式生命周期、参数化 row-returning query 和受限 DML transaction surface，未来 API/Scheduler 调用方拿不到 raw `better-sqlite3` writer。
- `withImmediateTransaction` 使用 `BEGIN IMMEDIATE`，拒绝 nested/concurrent、`async` function 和 thenable 返回值；callback 异常或违规完整 rollback。transaction surface 只接受参数化 INSERT/UPDATE/DELETE/REPLACE 与 readonly query，拒绝 DDL、PRAGMA、ATTACH、VACUUM、transaction control 和 row-returning write；Agent/tool/file/network 工作禁止进入 callback。

真实文件 SQLite 测试使用临时目录下的 `workflow-runtime.db`，不以 `:memory:` 替代 WAL/durability/competition：覆盖 fresh bootstrap/reopen、78-table frozen schema、已有 schema 和 WAL Profile mismatch、只读写拒绝/`query_only`、唯一 writer lifecycle、跨进程 writer contention、`BEGIN IMMEDIATE` commit/rollback、async/DDL 拒绝、连接 close，以及 production/platform identity 在数据库创建前 fail-closed。R-005 的 executable DDL feasibility 已由 G1.1 的全量 migration/constraint/trigger/query-plan/真实 SQLite Gate 实际关闭；G1.2 不修改其 artifact identity。

G1.2完成时的pins已由后续G1.3 dependency identity repair有意重新基线；current Store inputs如下，G0.10 root只保留为construction provenance记录：

| Input | Identity |
| --- | --- |
| Schema Dependency Manifest | `sha256:ea039f582f0ebff2fb9bc7e512825612cf8f0f93ccdd4c5e43345f56ca2b7b89` |
| physical schema identity | `sha256:8c667d62f69a8c67ba1edde467562e370377342a058b6dc4673ab9a383fe05a1` |
| G1 executable schema root | `sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756` |
| domain-separated Schema Manifest | `sha256:4d8c373387ad515c36fd292b705665e6c197c73021c1b7e55da5317bc140efbd` |
| canonical migration SHA-256 | `sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61` |
| deterministic digest | `sha256:f3dc5f3364a31c153cbf78ac0276d6467627c547e0939ac8e56e6f1ce8e65f15` |
| SQLite Profile artifact | `sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af` |

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
| G1.1 executable schema root | `sha256:8950c4be872f34b1e048fe28fd1c267ed2da97a685e0e874eba1dc14deba4c52` |
| domain-separated schema hash | `sha256:9e75471258a4fa4d28c67859b39b7fb36ce9142eacb91d38a70b45b155ba79ce` |
| canonical migration SHA-256 | `sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61` |
| deterministic digest | `sha256:6e88f0618e94294647d7ff72bb64a20dddb490a6bdee4da6ee38d06fd7a7fcb2` |
| Schema Manifest / contract | `sha256:50219aa0bfe410763d07c7f0d340eb372c166957ee8039c28f4ed4eb010a009e` / `sha256:2c2394f481fc9b57d8d8f396e1e2a9ce5319f1ea59a214c915b2a330a86b4afd` |
| Executable DDL artifact | `sha256:05bc24ca63d1b770c3248b9f0b15de9952c9e8ef08a14967aec0a274d5fdd7aa` |
| Query plan / constraint-trigger fixtures | `sha256:35b7a27e241d32436de70dc937ce9b20c7bfd46041835ac8c4712b85a27dc076` / `sha256:71b738b6bd63dfadd5e960665767c5f191c60de12f81a46380604f6a900cce61` |
| Schema lint / domain separator catalog | `sha256:fd6c4381d3c3012325bfbd2a780ce6514289360dd86f4038337b9d74e3981905` / `sha256:49065b8d9063e25754a80d731b47b1088bcb67fc71720487c909b11a26147eaf` |

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
| G0.10 Capacity Control-Plane Addendum root | `sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec` |
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
| R-012 | Full regression baseline | OPEN_OUT_OF_SCOPE | G1.2 两次串行完整 suite均只失败 `credential-proxy` async trace 250ms；R-016 full suite为 79/80 files、723/724 tests，单文件20/21，同一断言继续失败。R-016/G0/G1与其余723 tests通过，未修改 credential-proxy/trace文件或测试 | 独立测试稳定性维护 |
| R-013 | Contract test timing baseline | OPEN_OUT_OF_SCOPE | G1.1 曾在并发负载下复现 G0.6 5s timing；G1.2 串行 `test:g0` 15/15 files、109/109 tests 和两次完整 suite 均未复现。G1.2 不调整 timeout 或 G0.6 既有实现 | 独立测试稳定性维护 |
| R-014 | Capacity governance | CLOSED | G0.10 已机器化 closed publication/command、权限/Actor/entrypoint/delegation、revision/hash CAS、reason/denial、immutable audit tables、唯一 Publisher/Watcher protocol、Admission lineage、crash recovery 与 additive Gate evidence；G1 DDL 可开始 | G0.10 |
| R-015 | Toolchain test timing | OPEN_OUT_OF_SCOPE | G1.1 曾复现 runtime-toolchain 5s timing；G1.2 串行 `test:g0` 和两次完整 suite 均未复现，toolchain tests 通过。G1.2 不调整 timeout 或 managed toolchain 既有实现 | 独立测试稳定性维护 |
| R-016 | Compiler/Golden contract | CLOSED | S38与additive repair root已冻结唯一Case Result target/hash、lowering outcome、IR v2与exact binding；G2 Production Compiler已消费该Contract并发布真实identity/actual candidates，repair Draft v2仍冻结blocked且未越过Golden review/seal边界 | G2 spec/Contract repair + Compiler slice |
| R-017 | G2 semantic correction | CLOSED | phase=`BASELINE_ACCEPTED`；前序RC/Working/Draft/review/GoldenSemanticReview/sealed bundle identities未变；Compiler 3.0.1修复、owner-approved successor GoldenSemanticReview/seal与current 40/40 replay已完成 | successor bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`；G3+仍未开始 |
| R-018 | Feature Release Activation persistence | `DONE` | G1.6按G3.8A重建Schema 4 failure/replay persistence；G3.9已实施closed Activation transaction/replay/recovery | G1.6与G3.9原子提交 |
| R-019 | Generated Schema、Join Expose 与 NodeOutputEnvelope Authority | `CLOSED/DONE` | closed Draft 2020-12 envelope schema、exact port-set/present-absent union、Schema 7 first-class Stored Value authority、Compiler 3.0.4/G2 v6及Value全边界已machine-close并通过fresh independent affected-chain regression；G1-G4 current closure恢复`DONE` | `NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_DONE` |

## v1完成后的归档计划：PLANNED

主规范S39已定义G9和完整验收后的生命周期切换。当前仍处于G2施工期，`dynamic-workflow-dag-framework.md`继续作为完整规范权威并保持会话全文必读；只有G0-G9、Sealed Golden、certified Profile、Core Release/G9 activation和“无关键规则只存在于Markdown”审计全部通过后才能冻结归档。

归档切片必须完成：将主规范移出默认CI/identity与agent必读；退役G0.9/G0.10 Markdown coverage、R-016章节hash、阶段状态/absence断言的活动验证；保留其历史artifact并提供可选archive audit；保留Contract/Schema/DDL/Store/Compiler/Golden/Runtime/Release/startup长期验证。G1.3已用closed exact-member dependency manifest完成施工期修复，旧目录快照只保留在Git历史和未来可选archive audit背景，不进入普通CI或Runtime startup；Production Store identity最终仍由Core Release Manifest绑定schema/migration/profile，不永久依赖施工阶段`FROZEN_G1_1_IDENTITIES`。

## G2 Current Golden Draft、Semantic Review 与 Seal

**状态**：Draft与隔离report已冻结，`human:local-owner`已明确批准exact Draft，immutable `GoldenSemanticReview`与sealed bundle已生成；local single-user trust boundary不要求GPG/外部签名。Seal artifact hash-chain通过，但Production Compiler replay仅29/40 exact equal，因此Bundle为`sealed_pending_ci_replay`，生命周期仍为`RC_REVIEW`且G2未通过。

| Artifact | Ref | Hash / evidence |
| --- | --- | --- |
| Golden Draft manifest | `conformance/golden-draft/g2-semantic-correction/golden-draft-manifest@1.json` | artifact `sha256:1be05809900b1cab2af1382cef861c190abdc425654fd8b4c71289fb42c4324c`; exact `draft_manifest_hash=sha256:fb94f5e65425b482eee369bb115e46e884b249978e0f408832574d5be41dccbd` |
| Golden Draft cases | `conformance/golden-draft/g2-semantic-correction/golden-draft-cases@1.json` | artifact `sha256:be4872007f7083adf052b78b9cc07c93b78ff1dbdc87b7b7ae6494ad8158b23d`; payload `cases_hash=sha256:4b2f07f4a78abb8ba0f880793b4538a2a1c0d9edf4f2fef8bee601509ce6bf5f` |
| Golden Draft inventory | `conformance/golden-draft/g2-semantic-correction/artifact-inventory@1.json` | artifact `sha256:3bfecf95ed57cf840388a03028ac05105064f2280032f530a3ed8ffa003072d9`; payload `inventory_hash=sha256:715dc9e7984a2066522669046a1f43c0650a5064841323445df35a2d483babfd`; 77 entries |
| Golden Draft schemas | `conformance/golden-draft/g2-semantic-correction/schemas/` | cases `sha256:7e380ee316dd85703dace132bfa8619b7e883fae27578a239de9012b373f9b20`; inventory `sha256:163a3c0258e5c43c5195eacac070a38187c405ccc949be23bd7c40c176184bc8`; manifest `sha256:7574dd701f3515a5117d29cf357a95774b6324a42ab7dc945ea61c57dbc93222` |
| Golden review report | `conformance/golden-review/g2-semantic-correction/golden-review-report@1.json` | artifact `sha256:b4970615096e056e75d08fbde18a122bb48aeb0fbed35ecda8c478d5d0e0d999`; report `sha256:d8b2164b0d8e8b6ab7a3fe50559327e7f944312194251bc72a4330845969ad91` |
| Golden review schema | `conformance/golden-review/g2-semantic-correction/schemas/golden-review-report-schema@1.json` | artifact `sha256:d88cad966d4b96ec982502817fa3c8100f61d9c621b853c41498be0fdc03e3d2` |
| GoldenSemanticReview | `conformance/golden-semantic-review/g2-semantic-correction/golden-semantic-review@1.json` | artifact `sha256:f50faa521d676397b04ad1dfaf9c5560be56714e38d7e33ba2a2e0eb39edd47b`; review `sha256:b12442ce6bdefba73a6b7377006f2aa841d30d78a3060416bbe21048d07abea4`; decision=`approved`; 40/40; reviewed_at_ms=`1784604172000` |
| Sealed inventory | `conformance/sealed/g2-semantic-correction/artifact-inventory@1.json` | artifact `sha256:54c5082b13131dfe3a45453b4e402b2e5705814baa48d152997b43ef27f971ff`; payload `sha256:ab771114fc29aa0ff93e7d0d2fabe658354bae38099637e9a3d1a8b25ad6f80a`; 155 leaf entries |
| Sealed Golden Bundle | `conformance/sealed/g2-semantic-correction/golden-conformance-bundle@1.json` | artifact `sha256:4d874857ba4c91505c57979d3954ba4bf5e18c806a77f389b37c9ca9162b8c5c`; bundle `sha256:d00dc96d90ccfadd6081a77d7c4a16024e188b9a77a123743bc601f971219555`; 157 artifacts; status=`sealed_pending_ci_replay` |

Draft coverage is 40/40 expected results, 11/11 compiled Plan/proof/program byte sets, and 29/29 rejected diagnostics with stable pointer/object identity. Isolated review coverage is 40/40, semantic assertions 85/85 with zero assertion failures; actual comparison is read-only: 29/40 results are byte/semantic equal (all 29 rejected cases), while 11 compiled cases remain in the report with 622 pointer-level differences. No difference was used to mutate, overwrite, or accept expected bytes.

The Draft manifest binds RC root `sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577`, Working roots `sha256:a2d8bcab971d1db75aad17d152c7c616371a4ceeb8d52f408674d744cf7866b8` / `sha256:83080db01627d5b42046ce0a2e229ee3f4099208a8bfa2b028fc9b6241272dc8` / `sha256:54ba5b80b92a9c053e4439964fbea03326c9c8b7fc3cc3fe244dffa2144d341a` / `sha256:a254eec500006f1c7210835607cf0c20c9c6cc0647ae06a43ef2943d169d5c92`, source set `sha256:76d0c59584c33fc47e22f3f81dea3b6da7048549c1cb136e4750f0f05cd5b6bd`, exact G2 toolchain/compiler/normalizer/proof/schema identity and case-input binding `sha256:f59893f564de430caf7375c47ff82888e20339886aec06efa5abb9625c259329`. `conformance/sealed/`现在只新增exact `g2-semantic-correction/`不可变树并保留`.gitkeep`；G3-G9仍为`not_started`。

| Verification | Result |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g2` | PASS; 5 files / 38 tests; pre-seal rebuild tests replaced by sealed-era exact Working/RC read-only checks，Production candidate remains 11 compiled / 29 rejected |
| managed `npm run test:g2:golden-current` | PASS; 3 files / 17 tests; determinism、approval伪造/partial/changes-requested、hash-chain、sealed drift、isolation与replay failure covered |
| managed `npm run test:g0` | PASS; 15 files / 109 tests; historical artifact identities remain frozen while current boundary recognizes the exact G2 sealed root |
| managed `npm run prepare-rc:check` | PASS; RC root unchanged |
| managed `npm run contracts:check` | PASS; includes exact Draft/report/immutable review/seal read-only checks plus unchanged Contract/Compiler/Schema/Store roots |
| predecessor 3.0.0 seal replay diagnostic | 29/40 exact equal，11个compiled case identity mismatch；该结果保留为immutable predecessor历史证据，不再是current gate |
| Draft/review generate round 1 and round 2 | PASS; both Draft rounds returned `sha256:fb94f5e65425b482eee369bb115e46e884b249978e0f408832574d5be41dccbd`; both report rounds returned `sha256:d8b2164b0d8e8b6ab7a3fe50559327e7f944312194251bc72a4330845969ad91` with identical artifact hashes |
| `git diff --check` | PASS |

## G2 Production Compiler Replay Repair Successor v2

**状态**：`BASELINE_ACCEPTED / R-017 CLOSED`。本切片没有修改任何approved expected、sealed input、前序Draft/review/GoldenSemanticReview/seal或历史Working/RC identity。Production Compiler在前序sealed 3.0.0 exact identity下对11个compiled case的只读行为复验从622个pointer differences收敛为11/11 exact、0 differences；由于真实Compiler source identity发生变化，Compiler/Toolchain升级到3.0.1、Canonical Normalizer与Proof Algorithm升级到2.0.1，并新增additive `g2-production-compiler-replay-repair-v2` Working/RC/Draft/report lineage。owner已批准exact Draft/report，versioned GoldenSemanticReview与157-artifact seal已生成；current replay为40/40 exact、85/85 semantic assertions、0 pointer differences。Publisher与G3-G9均未开始。

原始622个pointer differences的case分布与根因分类：

| Case | 原始pointer数 | 根因与修复 |
| --- | ---: | --- |
| `positive.compiler-integrity-match-control` | 40 | policy canonicalization、business effective limits与Runtime Safety ceiling分离、completion fact-program及catalog/interface hash domain修复；全部derived Plan/program/result hash随之收敛 |
| `positive.condition-route` | 55 | condition step计数、operand key/schema hash与literal/selected-schema处理修复；共同policy/completion/complexity/hash级联收敛 |
| `positive.expand` | 66 | generated child schema、literal data proof、inline factory snapshot/content-addressed refs与structural limits修复 |
| `positive.map` | 68 | generated map result schema、item assignability proof、map child closure与structural limits修复 |
| `positive.policy-intersection` | 40 | requested/inherited limit intersection、policy排序与Runtime Safety ceiling错误注入`effective_limits`修复 |
| `positive.quality-revision-binding` | 45 | capability retry/timeout/quality-revision lowering、effective retry policy与hash修复 |
| `positive.sound-subtype-different-hash` | 57 | producer/consumer schema assignability、proof rule/domain/detail ref/derived schema hash修复 |
| `positive.static-child-closure` | 73 | nested static-child closure owner path、parent ownership、member key/hash与content-addressed plan/source refs修复 |
| `positive.static-lowering` | 62 | Definition lowering topology、node/edge IDs、generated interface、completion、limits与catalog hash修复 |
| `positive.subgraph` | 67 | child interface/output schema、inline factory snapshot ref、static closure member与nested plan hash修复 |
| `positive.wait` | 49 | Wait required input data proof、capability/wait catalog hash、complexity reconcile与common lowering修复 |
| **合计** | **622** | **前序identity只读复验0 differences；successor 40/40 exact、0 differences** |

successor构建时额外发现`negative.schema-not-assignable`曾因producer schema在解析后未回写proof validation state而被错误地用consumer schema自证；该Production Compiler缺陷已修复，最终29/29 negative cases和11/11 compiled cases全部exact。Early Completion合法compensatable路径的non-null cancellation safety proof亦经专项回归保留，没有为匹配当前11个无early-rule的oracle而削弱规范语义。

精确Compiler与successor identities：

| Identity | Hash / lineage |
| --- | --- |
| Compiler Toolchain | version=`3.0.1`; `toolchain_hash=sha256:4e16227bf723a41207d94a8619f8b6bb50731c412cb5b298869e265097dcaccf` |
| Compiler build | version=`3.0.1`; `sha256:4cb84d57dee323723ed60dc22394100b37cc76a3bfde793ef95ba707cd21a976` |
| Canonical Normalizer | version=`2.0.1`; `sha256:e32946d0d20cc92344a72d04e488951cc4a64be82d36384db26dfbf420e469ff` |
| Proof Algorithm | version=`2.0.1`; `sha256:6a49827e2c039b95c42c94a607acbf6ae7c088d0510fe7fd93cc0eb87f302308` |
| Successor Working roots | contract=`sha256:c5ca1c15b3e0d525b1ed75200c18f63195cb13e442431730ca1a828e84a7fe67`; input=`sha256:5cb730ad620a3ba702891cdd2118e5828c5a799aed729ad5d0beefbe5f0ac061`; candidate=`sha256:a1693ea8a5c4a6987f447357407c55201a1790efafd285af5584564fade4f78f`; review=`sha256:ee58f9f58059020db070a20772b370c8cf121ae3b012cdf98e535e92c82892f5` |
| Successor RC | artifact/root=`sha256:85572b113f80e9552aa7f129def39f03ae8d94bc1dab9bbcc2bb78067dddda94`; source set=`sha256:fbd497e001e5210acdd8bdd0229ebc4c12cba5035d746337fc50f99019d34534`; binding=`sha256:42ca9bbb0fda0180e2299fb260bd232e29d1a507f066bb45f5f11b93f5be490b` |
| Successor Draft | artifact=`sha256:164f6f0962e2005f8e4c3573aa9f9f14d3eba62322ae464eca927ac2eae98fc9`; exact manifest=`sha256:29fdd70ea872f9d4e52d49fbd988fff306d95820989920f5f1ecf2bc87019d2b` |
| Successor review report | artifact=`sha256:781d33faefa4d77d210d293ffea97cc9c712f2a3c23690abf4f2ead135f43435`; report=`sha256:2f9edba7af3715f4d5d64328a9fd1a601505bafd1129cee603e87aacf80d92d7` |
| Successor GoldenSemanticReview | artifact=`sha256:4f12999eabdb2a65f8782aa1010430b0cf1140ef3cc945d4a30d31894aeb03e5`; review=`sha256:88c5412d1bd97d52a7f9bf41e17bd1db1e19b4a2e5466b3b25384fbdeb7cac0c`; decision=`approved`; reviewed_at_ms=`1784617297000` |
| Successor sealed inventory | artifact=`sha256:85eb44b6216891107ca359e3b6a2b00600c55c1509b036febf388127054b1fcb`; payload=`sha256:671a4c0c8cbc00703cee4abbb22587bf49ee5467f44f02069bc892114c2b3ee4`; 155 leaf entries |
| Successor sealed bundle | artifact=`sha256:037009dcd6c5d6bd2888c484fe1adacded68da5c55e17ba12eb722092e4faced`; bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`; 157 artifacts |

前序immutable lineage继续精确绑定Working roots `sha256:a2d8bcab971d1db75aad17d152c7c616371a4ceeb8d52f408674d744cf7866b8` / `sha256:83080db01627d5b42046ce0a2e229ee3f4099208a8bfa2b028fc9b6241272dc8` / `sha256:54ba5b80b92a9c053e4439964fbea03326c9c8b7fc3cc3fe244dffa2144d341a` / `sha256:a254eec500006f1c7210835607cf0c20c9c6cc0647ae06a43ef2943d169d5c92`、RC `sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577`、Draft `sha256:fb94f5e65425b482eee369bb115e46e884b249978e0f408832574d5be41dccbd`、report `sha256:d8b2164b0d8e8b6ab7a3fe50559327e7f944312194251bc72a4330845969ad91`、GoldenSemanticReview `sha256:b12442ce6bdefba73a6b7377006f2aa841d30d78a3060416bbe21048d07abea4`与sealed bundle `sha256:d00dc96d90ccfadd6081a77d7c4a16024e188b9a77a123743bc601f971219555`。默认check在sealed era按这些冻结inventory只读验证，不用3.0.1重算或覆盖3.0.0 artifact。

显式前序replay仍以当前3.0.1 identity对3.0.0 sealed snapshot执行，按exact identity contract合法报告29/40；伪造3.0.0 identity会违反版本化规则。`golden:current:replay:check`现绑定owner-approved 3.0.1 successor seal并通过40/40，因此G2进入`BASELINE_ACCEPTED`。Publisher、Registry/Authoring、G3-G9、SQLite certification、Core Release与production activation均未开始。

| Verification | Result |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g2` | PASS；7 files / 47 tests；含Production Compiler回归、sealed-era predecessor inventory、successor approval/seal determinism、lineage与absence |
| managed `npm run test:g2:golden-current` | PASS；5 files / 26 tests；前序Draft/review/seal immutable checks与successor approval/seal/current 40/40 replay同时通过 |
| managed `npm run test:g0` | PASS；15 files / 109 tests；Contract Pack import boundary、historical identities、absence、toolchain与legacy boundary均通过 |
| managed `npm run contracts:check` | PASS；旧Working/RC/Draft/review/GoldenSemanticReview/seal只读identity与新successor strict rebuild全部通过 |
| managed `npm run contracts:archive:check` | PASS；历史G0/R-016/resolved Draft roots未变 |
| managed `npm run prepare-rc:check` | PASS；前序RC仍为`sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577` |
| managed `npm run g2:replay-repair:check` | PASS；40/40 exact、85/85 assertions、0 differences |
| managed successor semantic-review/seal checks | PASS；exact owner approval、GoldenSemanticReview、155-leaf inventory与157-artifact bundle均byte-idempotent |
| 前序3.0.0 exact identity只读行为复验 | PASS；11/11原mismatch cases exact、0 pointer differences |
| managed `npm run golden:current:replay:check` | PASS；owner-approved successor bundle `sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`，40/40 exact |
| predecessor path diff / `git diff --check` | PASS；所有前序immutable artifact路径相对golden-seal commit零diff；无whitespace error |

## G3.1 Registry Publish Preflight Foundation

**状态**：`DONE`；G3整体为`IN_PROGRESS`。本切片只建立read-only Registry publish-preflight机器合同，不执行Registry写入、真实Publisher、Feature/Core Release、Publish或Activation。Production Registry零Published Recipe为合法正例；所有synthetic Definition/Executor资源仅存在于`conformance/g3-registry-publish-foundation/`并显式标记`launchability=test_only`，Production target fail-closed拒绝提升。`scaffold -> validate -> compile -> dry-run -> review -> publish -> activate`七阶段全部明确记录为`not_implemented`。

preflight输入和结果均为Draft 2020-12 closed schema。输入只接受exact VersionedRef与`sha256:<64 lowercase hex>` identity，拒绝moving ref、unknown field、缺失Compiled Plan/Execution Artifact pin、G2/compiler/retention/ABI drift、dependency缺失/重复/乱序/环、test-only越界、Production Compiler actual充当expected oracle以及任何Registry write/Activation请求。Compiled Plan正例只引用current G2 successor seal内独立批准的expected Plan；Production Compiler actual固定为`comparison_only`。

| Artifact | Version / exact hash |
| --- | --- |
| G3.1 Contract Pack | ref=`icarus.workflow-contract-pack-g3-registry-publish-foundation@1.0.0`; artifact=`sha256:fad831fb9c5142422635c18b8e1b7207aec6ac92a5f42f6bd99739aff85eafa4`; 7 members |
| Preflight input schema | ref=`icarus.workflow-registry-publish-preflight-schema@1.0.0`; artifact=`sha256:08c516629f1470f25bfa14e162091c670d7b94c5dea7a1a3fb91476b5e321023` |
| Preflight result schema | ref=`icarus.workflow-registry-publish-preflight-result-schema@1.0.0`; artifact=`sha256:a1cd8235c981ad23fe723673bb13673dfc8d8ac850c5ef1e3cae5065631553ec` |
| Foundation schema | ref=`icarus.workflow-registry-publish-foundation-schema@1.0.0`; artifact=`sha256:1e29a2ccf758303b3135c5c4973ad867704d0a3c2aa25ef9ae4a0423cab7485d` |
| Foundation | ref=`icarus.workflow-registry-publish-foundation@1.0.0`; artifact=`sha256:0ef908d142640b3e12fa1abb51087419405949eea505f9612e6cd882c021970e`; internal foundation=`sha256:da5af1b3c6e8b31b80cea5aa4084f7331f8779ca8b05628568713296397ee1a4` |
| Positive fixtures | ref=`icarus.workflow-g3-registry-publish-positive-cases@1.0.0`; artifact=`sha256:5e2001d5a6c9c4d5bf75081dc7e8d474927c421da882271e537074e1e93598a6`; 2 cases |
| Negative fixtures | ref=`icarus.workflow-g3-registry-publish-negative-cases@1.0.0`; artifact=`sha256:e35fd220d0182346a733928dd84aa49a1af8734d84d1031e084aa2e651acdd7b`; 19 cases |
| Domain catalog | ref=`icarus.workflow-g3-registry-publish-domain-separators@1.0.0`; artifact=`sha256:a59b0cc19c21f8eb9e5fb25b4dbc1127b15f17b167a31b852dc6ba21cb878e23` |

G3.1 lineage exact绑定G1 root `sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756`、current G2 sealed bundle artifact/bundle `sha256:037009dcd6c5d6bd2888c484fe1adacded68da5c55e17ba12eb722092e4faced` / `sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`、Compiler Toolchain/Build `sha256:4e16227bf723a41207d94a8619f8b6bb50731c412cb5b298869e265097dcaccf` / `sha256:4cb84d57dee323723ed60dc22394100b37cc76a3bfde793ef95ba707cd21a976`、Compiled IR/Conformance Result schema `sha256:4d4e325f94b55a6767f3e8596e1e9b880df2b402d3c89f587a10a23f0eadbd46` / `sha256:019a4ba80ed8ae57b6c862d9fda62d9edcb8aca9c4910fde6bbb580c09af8706`、Retention `sha256:3adc19f9a8ee92421faa349ec12e706f2d9862e90c0c74e53eb041794e2b805d`、Feature Manifest vNext schema `sha256:e47344ea2f4bebde3688f76b3450d5143adfd99ab4cc30eb6fc48a9d5a398e2d`与Recipe schema `sha256:c2768894c7fe6aab492f11d2948a4c92ccefbadc44cb094e103df4a8cdca9bb2`。

明确未完成范围：Registry Store/Closure/Snapshot/Retention Handle、Feature Manifest parser/ownership、Recipe/Definition publish validation、Publisher effect/capability/permission closure、Execution Artifact构建与lint、Core Protocol/ABI/Registry/DB compatibility scanner、Authoring七阶段、human review/approval、staged Publish、Production loader、Feature/Core Release与Activation。G4-G9没有实现或状态提升。

| Verification | Result |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run contracts:g3:check` | PASS；root=`sha256:fad831fb9c5142422635c18b8e1b7207aec6ac92a5f42f6bd99739aff85eafa4`；2 positive / 19 negative；Registry write=false；Activation=false |
| managed `npm run test:g3` | PASS；1 file / 6 tests；closed schema、zero-Recipe、test-only isolation、exact lineage/pinning、negative matrix与G4+ absence covered |
| managed `npm run test:g2` | PASS；7 files / 47 tests |
| managed `npm run test:g2:golden-current` | PASS；5 files / 26 tests |
| managed `npm run test:g0` | PASS；15 files / 109 tests；内部再次执行完整`contracts:check` |
| managed `npm run contracts:check` | PASS；G0/G1/G2 identities与G3.1 deterministic pack同时通过 |
| managed `npm run contracts:archive:check` | PASS；历史G0/R-016/resolved Draft roots未变 |
| managed `npm run prepare-rc:check` | PASS；前序RC仍为`sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577` |
| managed `npm run golden:current:replay:check` | PASS；current successor bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`；40/40 exact |
| G2 immutable path diff vs `e6e127b5aea9d5ee8ef01660364bf512ffb0da03` | PASS；candidate/Working/RC/Draft/report/GoldenSemanticReview/sealed trees zero diff；baseline仍为HEAD ancestor |
| G3+/legacy absence scan | PASS；无executable Registry/Authoring/Runtime/Projection新增，无legacy resource key alias或compatibility fallback |
| `git diff --check` | PASS |

## G3.2 Feature Manifest vNext Strict Intake Preflight（历史阻塞记录）

**历史状态**：`BLOCKED_BY_SPEC`。该阻塞已由下方 G3.2A 原子切片关闭；当前 G3.2 strict intake implementation 为 `READY`。历史阻塞时没有新增或修改intake实现、Schema、fixture、artifact、CLI或package script，没有读取resource `source_path`，没有执行Registry操作、Publisher、Publish或Activation。

最小阻塞证据：

1. 架构规范“Feature Manifest vNext”只规定“namespace、source root与resource ref必须属于同一Feature ownership boundary”，没有定义从`feature_ref.id`、`namespace`和resource ref判定owner的closed算法。既有G0.3正例同时使用`feature_ref.id=example.feature`、`namespace=example`、`registry_namespace=example`和resource ref `example.workflow`，证明“保持一致”不能实现为三者字符串相等；规范也没有规定允许的namespace分隔符、resource ref前缀或Feature identity派生规则。
2. `icarus.feature-manifest/2` Schema只要求`manifest_hash`匹配通用SHA-256字符串格式。规范“JSON、Canonicalization与Hash”要求每种对象使用exact object-type/format domain separator，但没有为Feature Manifest source定义domain separator，也没有明确hash payload是否为`manifest_without_manifest_hash`。现有`icarus:workflow-feature-manifest-v2-schema:1\n`只拥有Schema artifact，不能被实现擅自复用为source manifest identity。
3. Schema只对dependencies、`required_resource_refs`和`dynamic_workflow_resources`声明array/unique约束；规范未定义三个集合的canonical tuple/comparator。G3.2要求拒绝乱序，因此必须先冻结dependency identity、required resource ref与`(kind, ref)`的exact ASCII排序键。
4. 规范固定authoring目录为`features/<featureId>/workflow-src/`并拒绝lexical absolute/parent traversal，但没有定义`<featureId>`如何从manifest identity派生，也没有定义symlink/moving-root的read-only snapshot合同、稳定root identity或检查与实际读取之间的TOCTOU判定。实现不能自行选择`realpath`、device/inode或目录manifest作为权威。
5. 规范只固定strict parse/schema/hash/path-read的大阶段顺序，并规定removed key与其他unknown field先于path read/Registry write；没有固定同一输入同时包含removed key、unknown field、moving ref、order drift或hash drift时的exact error precedence。要发布稳定单码结果或有序diagnostics，必须先冻结phase内优先级与排序键。

需要最小规范reopen：只补充Feature Manifest vNext source-intake子合同，不修改G2或G3.1 identity。该补充必须冻结ownership predicate、root/path snapshot与symlink/moving-root规则、source manifest domain-separated hash公式、三个ordered collection comparator，以及phase内error precedence/diagnostic ordering。以上语义冻结并补入machine Contract后，G3.2可重新开始；在此之前不得通过fixture反向发明规则。

阻塞时只读验证证据：

| Verification | Result |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g3` | PASS；G3.1保持1 file / 6 tests；G3.2未产生可运行实现或定向测试 |
| managed `npm run test:g2` | PASS；7 files / 47 tests |
| managed `npm run test:g2:golden-current` | PASS；5 files / 26 tests |
| managed `npm run contracts:check` | PASS；G3.1 root保持`sha256:fad831fb9c5142422635c18b8e1b7207aec6ac92a5f42f6bd99739aff85eafa4`，Registry write=false，Activation=false |
| managed `npm run contracts:archive:check` | PASS |
| managed `npm run prepare-rc:check` | PASS；前序RC保持`sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577` |
| managed `npm run golden:current:replay:check` | PASS；successor bundle保持`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`，40/40 exact |
| managed `npm run test:g0` | PASS；15 files / 109 tests；内部再次执行完整`contracts:check` |
| G2 immutable path diff vs `e6e127b5aea9d5ee8ef01660364bf512ffb0da03` | PASS；零diff |
| G3.1 immutable path diff vs `728ad83f9ed69d9826d67a4b1471cf43071b1b7e` | PASS；零diff |
| G3+/legacy/Production surface absence scan | PASS；没有新增`src/workflow-runtime/`文件或Production Registry/Authoring/Publisher/loader/Activation surface |
| `git diff --check` | PASS |

## G3.2A Feature Manifest vNext Strict Intake Semantics Freeze

**状态**：`DONE`；G3保持`IN_PROGRESS`，G3.2 strict intake implementation提升为`READY`，G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。本切片只冻结 G3.2 source-intake 的 ownership、source-root/path snapshot、manifest hash、deterministic ordering 和 error precedence；没有实现实际 source reader、Registry persistence、Publisher、Publish、Production loader、Feature/Core Release 或 Activation。

交付的独立 closed Draft 2020-12 Contract Pack 位于 G3.2A 隔离 root：`conformance/g3.2a-feature-manifest-intake/` 仅保存 2 个 positive 与 18 个 negative test-only fixtures。Profile、结果 schema 和 pack 均通过 G0.2 artifact envelope、JCS、domain-separated SHA-256 与 byte-exact generator/check；所有 schema object 使用 `additionalProperties=false`，没有 default/coercion/fallback。G3.2A 评估器只接受 bytes 和可选的 supplied snapshot observation，`reader_invoked=false`、`resolver_invoked=false`，不读取 manifest `source_path`。

| Artifact | Version / exact hash |
| --- | --- |
| G3.2A Contract Pack | `icarus.workflow-contract-pack-g3-2a-feature-manifest-intake@1.0.0`; `sha256:c9c273b6d294d512a3578203d91d4bdce7863a3ccb561fdd7da08d072b3d8cd9` |
| Strict Intake Profile | `sha256:643f6907c7723b8c77aa2a1b1dc51fcf5dac2e16404d2cd862909f43f7c75de4` |
| Profile Schema | `sha256:ead0a25980c695ecc4564044f98359cdefb76780b959f2a98361a0b5d0c0b614` |
| Result Schema | `sha256:95e444fbaf0c64c4a89c2b1ee6aa348a11ace85fbd57e8a3d1b63a16416ef8f3` |
| Domain catalog | `sha256:2e3865d2a2aa70148b2615ab643b86c38f161e801bd314b3a203c24f29c30e13` |
| Positive fixtures | `sha256:b8280197763f6741e69540748a943d5975f0c0999ecbca04b2ceee484b7cf39f`; `2` cases |
| Negative fixtures | `sha256:77ced4c1ba39632c2e662aa247593c68fac96e6068832abb4081fbf8e9030be1`; `18` cases |

冻结语义的规范落点为架构规范 `Feature Manifest vNext -> G3.2A Feature Manifest vNext Strict Intake Semantics Freeze`，machine source 为 `g3-2a-feature-manifest-intake.ts` 与其 profile/result schema。Feature id 固定为 `feature_ref.id` 去掉最终 `.feature` suffix；namespace/registry_namespace 必须等于该 id；Feature-owned ref 必须为 `<featureId>.<localId>`；dependency release 允许跨 owner 但必须 exact immutable ref+hash。Roots 固定为 `features/<featureId>` 与 `features/<featureId>/workflow-src`，`source_path` 相对前者且必须在后者下；absolute、空段、`.`、`..`、平台分隔符和 root escape 拒绝；symlink、hard-link、moving-root 拒绝，并冻结 root/file device+inode snapshot、no-follow open、前后 identity TOCTOU 检查。Manifest hash 使用 ASCII `icarus:feature-manifest-source:2\n`、删除 `manifest_hash` 后的完整 object、RFC 8785 JCS 与 UTF-8 SHA-256，业务 array 原序保留。Dependencies、required refs 和 dynamic resources 的 tuple/comparator 与 unique identity 分别固定为 `(release.id, release.version, release.hash)`、`(id, version)`、`(kind, id, version)` 的 unsigned ASCII byte order。错误顺序固定为 strict bytes parse -> removed/unknown structural intake -> full closed schema -> manifest hash -> ownership/duplicate/order/path -> root snapshot/path read -> source hash -> dependency resolution；removed key 稳定为 `feature_manifest_removed_resource_key`，其他 unknown field 稳定为 `feature_manifest_unknown_field`。

| Verification | Result |
| --- | --- |
| managed `npm run contracts:g3.2a:generate` | PASS；deterministic artifact generation |
| managed `npm run contracts:g3.2a:check` | PASS；read-only byte/identity check |
| managed `npm run test:g3` | PASS；G3.1 6 tests + G3.2A 4 tests / 10 total；18 negative fixtures |
| source/Registry/Publisher/Activation absence assertion | PASS；pack records all false，未创建 production surface |

## G3.2 Feature Manifest vNext Strict Intake Preflight

**状态**：`DONE`；G3保持`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。本切片只执行 G3.2A 已冻结的 strict intake contract：bytes parse、removed/unknown structural intake、closed schema、manifest hash、ownership/order/path lexical validation、canonical root/path preflight、source bytes hash verification 和 exact dependency resolution preflight。它不实现 Registry persistence、Publisher、Publish、Production loader、Feature/Core Release 或 Activation，也不读取 legacy resource source。

实现入口为 `g3-2-feature-manifest-intake.ts`，G3.2A 的 `g3-2a-*` 文件未改动。Preflight 在进入文件系统前完整复用 G3.2A 的 phase/error precedence；root 阶段使用 `lstat`，拒绝 root/path symlink，使用 `O_NOFOLLOW` 打开 declared source，`fstat` 与 open 前后 identity 比较，拒绝 hard-link device/inode 重用，并在每次读取前后比较 root identity。Source hash 对实际读取的原始 UTF-8/bytes 做 SHA-256，并以 expected hash 精确比较。Dependency resolver 是显式注入的 read-only function，只接受 exact `feature_release_ref` + `feature_release_hash`，并验证每个 required resource ref 属于该 exact release closure；没有 resolver 或出现任何 ref/hash/member drift 都稳定返回 `feature_manifest_dependency_unresolved`。

| Artifact | Version / exact hash |
| --- | --- |
| G3.2 Contract Pack | `icarus.workflow-contract-pack-g3-2-feature-manifest-intake@1.0.0`; `sha256:1eb0b81f488f4a37fa4503ddfef0dfa8a56d40fdeb535c9758d9d21fd39bb92b` |
| Preflight profile | `sha256:abadb6a36d45c3871df1f925cb3a71eb18fd4d4930ed5b1af2b43da194aade19` |
| Preflight profile schema | `sha256:dedea0ace5b9aaf6788de15196b3c6db09cff42b2bc33aeca5eed62b14c6ea5f` |
| Preflight result schema | `sha256:5f23aaa79e9efa3f4624b590e9d85140939a966435c6d4fd8ba94a40f62ffa16` |
| Positive fixtures | `sha256:9ff18cfb69c148f39cfc43ae3c3b6f20631fc68b89c21c4be00e9a4012bea843`; `1` case |
| Negative fixtures | `sha256:d8e9c4bcb2d4c74591843b182ecf5ce16b8ab86632863e9dfcc0d8dea4e43464`; `2` cases |
| Domain catalog | `sha256:be33c5e8de5d1ec2e1f48327ee0112e8bd1e4608cac91c56260aae4e0a14a8a3` |

| Verification | Result |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run contracts:g3.2:generate` | PASS；pack=`sha256:1eb0b81f488f4a37fa4503ddfef0dfa8a56d40fdeb535c9758d9d21fd39bb92b` |
| managed `npm run contracts:g3.2:check` | PASS；byte-exact deterministic artifacts |
| managed `npm run test:g3` | PASS；3 files / 15 tests；含 G3.2A 18 negatives 与 G3.2 filesystem/dependency cases |
| G3.2A pack identity | PASS；`sha256:c9c273b6d294d512a3578203d91d4bdce7863a3ccb561fdd7da08d072b3d8cd9` |
| G3.1 pack identity | PASS；`sha256:fad831fb9c5142422635c18b8e1b7207aec6ac92a5f42f6bd99739aff85eafa4` |
| G2 sealed bundle identity | PASS；`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |

## G3.3 Registry Persistence / Dependency Closure / Snapshot Preflight

**状态**：`DONE`；G3继续为`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。本切片只实现 G1 executable DDL/Store 已提供的 Registry resource、exact dependency edge、dependency closure manifest、immutable Registry snapshot 的 persistence contract 和 read-only snapshot preflight。没有修改 G2、G3.1、G3.2A、G3.2 identity/语义，没有读取 authoring/legacy source，没有实现 Publisher、Publish、Feature/Core Release、Activation、Production loader、Retention/GC 或 G4-G9。

实现入口为 `src/workflow-runtime/store/registry-persistence.ts`。所有写入经过现有 `WorkflowRuntimeStore.withImmediateTransaction()` 的同步 `BEGIN IMMEDIATE` host；batch 只写 `publication_state=staged`，以 inline canonical `workflow_values` 满足现有 deferred exact `(id, content_hash)` FK。资源 ID、Value ID、closure ID/Value ID 和 snapshot ID 都由 exact VersionedRef/type 派生，属于内部行定位，不进入 semantic resource/closure/snapshot hash。若 G1 DDL 不能表达 value/schema/resource 或 closure/snapshot 的 exact FK，本切片应记录 `BLOCKED_BY_SPEC`；本次验证确认现有 DDL 已能表达，未创建旁路表或隐式字段。

Resource content hash 使用 `icarus:workflow-registry-resource-content:1\n` 和 `{format, resource_type, ref, content}`；dependency kind 只冻结为 `registry_exact`。Closure builder 从 root 沿 exact dependency edges 计算闭包，排除 root 自身、按 unsigned ASCII `(resource_type, ref.id, ref.version)` 排序，并拒绝 missing/extra/duplicate/out-of-order members、hash drift 与 cycle。Closure hash 复用 G2 的 `icarus:workflow-registry-dependency-closure:1\n` payload `{format, root_resource_type, root_ref, members, member_count}`；manifest value 另用 `icarus:workflow-registry-closure-manifest:1\n` 得到 `manifest_hash`。Snapshot hash 使用 `icarus:workflow-registry-snapshot:1\n` 绑定 snapshot ref、closure ref/hash、compiler version、Core build hash 和 G1 schema hash。

Read-only snapshot preflight 只接受 Store read/query boundary，按 snapshot -> closure row/value -> schema/resource Value -> exact member/index -> transitive dependency 顺序检查，并返回 closed `read_only=true` result。它复算 canonical JSON、resource/content hash、closure/member count/order/hash、manifest hash、snapshot hash 和 compiler/Core/DB bindings；任何缺失、别名、hash mismatch、cycle 或 schema drift 都 fail closed，不执行写入、source read、fallback、alias 或 snapshot update。

| Artifact | Version / exact hash |
| --- | --- |
| G3.3 Contract Pack | `icarus.workflow-contract-pack-g3-registry-persistence@1.0.0`; `sha256:adcaa77339512650d8aa8af1c027d6e145419ada47e44733c424db2b0cb923da` |
| Resource schema | `icarus.workflow-registry-resource-schema@1.0.0`; `sha256:bbc52a0d8c694ed1632fca6c8a11c5a7c0cec8528e8fccff547cefecd5bb6b16` |
| Closure manifest schema | `icarus.workflow-registry-dependency-closure-manifest-schema@1.0.0`; `sha256:ebe0391d186e84a2adcc0310186c3dd89d2946f91e17684c57b2764fccf43cdd` |
| Snapshot schema | `icarus.workflow-registry-snapshot-schema@1.0.0`; `sha256:a1108bb80d73224db50d5f1af6ac382e990b2f008f9a1b463ffe9cf38f6627b3` |
| Snapshot preflight input/result schemas | `sha256:f071c8153da168c8c5d7dd856c36db4ac012b92259d5398d5f138f6a144bccb7` / `sha256:27de0eb21b849c7616f714b01936204337fa59ba3056322bd2b85f326f5ecd78` |
| Positive / negative fixtures | `sha256:1e16d3d458f8225f7b0346ffb036e7c8e975ffffe8005a893b8f8c4acb262ee3` / `sha256:9ad1369da11836fd023e3956f01221ff47b67827e121c9b0d562004d6ff61334`; `1` / `4` cases |
| Domain catalog | `sha256:3ead0400c4d909822b41c05339582ab251163f6f5b6a70fe43f544052ab1eeb3` |

G3.3 pack exact lineage固定G3.2A `sha256:c9c273b6d294d512a3578203d91d4bdce7863a3ccb561fdd7da08d072b3d8cd9`、G3.1 `sha256:fad831fb9c5142422635c18b8e1b7207aec6ac92a5f42f6bd99739aff85eafa4`、G3.2 `sha256:1eb0b81f488f4a37fa4503ddfef0dfa8a56d40fdeb535c9758d9d21fd39bb92b`、G2 sealed bundle `sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`，并记录 G1 root/schema/migration `sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756` / `sha256:4d8c373387ad515c36fd292b705665e6c197c73021c1b7e55da5317bc140efbd` / `sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61`。`conformance/sealed/` 未新增 Production surface。

| Verification | Result |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run contracts:check` | PASS；G0/G1/G2 与 G3.1/G3.3/G3.2A/G3.2 deterministic checks |
| managed `npm run contracts:archive:check` | PASS；historical G0/R-016/resolved Draft roots unchanged |
| managed `npm run contracts:g3:check` | PASS；G3.1 pack=`sha256:fad831fb9c5142422635c18b8e1b7207aec6ac92a5f42f6bd99739aff85eafa4` |
| managed `npm run contracts:g3.registry:check` | PASS；G3.3 pack=`sha256:adcaa77339512650d8aa8af1c027d6e145419ada47e44733c424db2b0cb923da` |
| managed `npm run contracts:g3.2a:check` / `contracts:g3.2:check` | PASS；G3.2A=`sha256:c9c273b6d294d512a3578203d91d4bdce7863a3ccb561fdd7da08d072b3d8cd9`; G3.2=`sha256:1eb0b81f488f4a37fa4503ddfef0dfa8a56d40fdeb535c9758d9d21fd39bb92b` |
| managed `npm run test:g3` | PASS；5 files / 22 tests；G3.3 Contract + Store persistence/preflight 与 G3.1/G3.2A/G3.2 回归 |
| managed `npm run schema:check` / `store:check` | PASS；G1 schema root/hash unchanged; SQLite profile remains candidate/not_certified |
| managed `npm run test:g0` | PASS；15 files / 109 tests |
| managed `npm run test:g2` | PASS；7 files / 47 tests |
| managed `npm run test:g2:golden-current` | PASS；5 files / 26 tests |
| managed `npm run golden:current:replay:check` | PASS；current G2 sealed bundle `sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`; 40/40 exact |
| managed `npm run prepare-rc:check` | PASS；RC root=`sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577` |
| G2/G3.1/G3.2A/G3.2 immutable path diff | PASS；empty |
| G3+/legacy/Production absence scan | PASS；forbidden paths absent; `conformance/sealed/` unchanged with only existing bundles |
| `git diff --check` | PASS |

## G3.4 Registry Immutable Replay / Collision Preflight

**状态**：`DONE`；G3继续为`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。本切片只补齐 G3.3 staged persistence 的 immutable collision 与 idempotent replay 行为；没有修改 G3.1/G3.2A/G3.2/G3.3 Contract Pack、schema、fixture 或 hash，没有修改 G1 DDL/Schema/Store boundary，也没有实现 Publisher、Publish、Feature/Core Release、Retention/GC、Activation、Production loader 或 G4-G9。

`persistRegistryPersistenceBatch()` 在 closed batch 验证通过后进入原有同步 `BEGIN IMMEDIATE` transaction，并在任何 DML 前按已冻结的 resource ASCII 顺序、closure、snapshot 顺序查询派生 identity。Value canonical payload/metadata、resource exact ref/hash/owner/staged state、dependency set、closure ref/hash/manifest/member index、snapshot ref/hash/compiler/Core/DB binding 必须逐项相等；不存在的 exact identity 才进入 insert plan。已有 exact resource/closure 可以被新 snapshot 复用；完整 exact batch 返回相同派生 receipt 和 `disposition=exact_replay`，执行零 DML。`created_at_ms` 只是首次安装 metadata，replay 保留首次值且不覆盖。

稳定 collision code 为 `registry_value_identity_collision`、`registry_resource_identity_collision`、`registry_dependency_set_collision`、`registry_closure_identity_collision`、`registry_closure_member_set_collision`、`registry_snapshot_identity_collision`。任一 collision 在同一 transaction 内抛出并整体回滚；同 `(resource_type, ref)` 的合法 different-hash batch 定向测试证明原 Registry 行与计数保持不变。Receipt 对首次或含新 identity 的写入返回 `disposition=inserted`。

| Verification | Result |
| --- | --- |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g3` | PASS；5 files / 25 tests；新增 exact replay zero-row-growth、shared exact closure reuse 与 same-ref/different-hash atomic collision cases |
| managed `npm run contracts:g3.registry:check` | PASS；G3.3 pack仍为`sha256:adcaa77339512650d8aa8af1c027d6e145419ada47e44733c424db2b0cb923da` |
| managed `npm run contracts:check` / `contracts:archive:check` | PASS；G0/G1/G2 与 G3.1/G3.2A/G3.2/G3.3 exact checks 全部通过 |
| managed `npm run test:g0` | 14/15 files、108/109 tests PASS；唯一失败为既有 `setup/runtime-toolchain.test.ts` 5s timing case（5.107s），未修改 timeout/toolchain；随后该文件定向复跑 5/5 PASS（目标 case 4.442s） |
| managed `npm run test:g2` / `test:g2:golden-current` | PASS；7 files / 47 tests 与 5 files / 26 tests |
| managed `npm run golden:current:replay:check` / `prepare-rc:check` | PASS；40/40 exact，sealed bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`，RC=`sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577` |
| managed `npm run build` / authored TS/config/README targeted Prettier check | PASS |
| G1 DDL / immutable Contract artifacts | 相对`18ea03e`零diff；G1 root/schema保持`sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756` / `sha256:4d8c373387ad515c36fd292b705665e6c197c73021c1b7e55da5317bc140efbd` |
| changed-path / forbidden-surface / `git diff --check` | PASS；仅5个计划内文件，无 Publisher/Release/Retention/Activation/Production loader implementation |

## G3.5 Registry Exact Resource Read / Query Preflight

**状态**：`DONE`；G3继续为`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。本切片只冻结并实现单个 Registry resource 的 exact read/query preflight；没有修改 G3.1/G3.2A/G3.2/G3.3 Contract Pack 或 G3.4 replay/collision 语义，没有修改 G1 DDL/Schema/Store boundary，也没有实现 Publisher、Publish、Feature/Core Release、Retention/GC、Activation、Production loader 或 G4-G9。

规范新增的唯一 query identity 是显式 `(resource_type, ref.id, ref.version, content_hash)`。Closed input 同时携带 exact schema ref/hash、owner、publication state 和完整 direct `registry_exact` dependency rows；全部 VersionedRef 使用 immutable exact token。`current/latest`、range、alias、fallback、active pointer、launchability 和 owner/state inference 均不属于合同。依赖 expectation 按 unsigned ASCII `(resource_type, ref.id, ref.version)` 唯一排序。

错误优先级固定为 `query_input_invalid -> resource_missing -> resource_hash_mismatch -> resource_value_missing -> resource_value_mismatch -> resource_schema_binding_mismatch -> resource_owner_mismatch -> resource_publication_state_mismatch -> resource_dependency_mismatch`。实现入口 `src/workflow-runtime/store/registry-resource-query.ts` 只接受 Store `queryOne/queryAll` surface，验证 G3.3 canonical inline Value 的 JCS/hash/length/metadata、exact schema resource 与 schema Value、owner columns、state、完整 dependency row set 及每个 target identity/hash。Accepted result 返回 verified canonical content；accepted/rejected 都由 closed schema约束并固定 `read_only=true`，不返回安装时间、row version、活动指针或 launchability。

| Artifact | Version / exact hash |
| --- | --- |
| G3.5 Contract Pack | `icarus.workflow-contract-pack-g3-registry-exact-resource-query@1.0.0`; `sha256:516f0fffdab8e05438649e8936a78e0fedac5eb9300abcb0ff232f5204e793dd` |
| Exact query profile | `sha256:958069493061be7fd7bfb2ea84d1e604e2f57738d2316d0b8c30412b8dd97aa7` |
| Profile schema | `sha256:e163de5bf6c1cd6e523e47f616fbf556a699ecd5bc58e5838166f6c853bde247` |
| Input / result schemas | `sha256:e3937b6f03f624f80d883abef0458ec56321787aa15692d4a2aa9e6355fba2cd` / `sha256:a8f3bb4befbdd4e22c4d5ce27c36fa10b2be3b012f211e977fcbf4f052a5196b` |
| Positive / negative fixtures | `sha256:1f05ca7fd6824307bc5ae134f9df7ef9b2bc2822fd84c4dd41b9847b454c0be2` / `sha256:3a06af87c002ebcf3063ac289e5556cc78e4482ba3bbec98013436b16ff12643`; `1` / `5` cases |
| Domain catalog | `sha256:dad2612bccfadf799592a4aec798d31f458a2109a6837c6b9b5c66a80f50a247` |

Store tests use real temporary `workflow-runtime.db` files and the existing G3.3 persistence path. They prove byte-equivalent repeated results and unchanged row counts, reject input before any query call, and cover missing exact ref, requested resource hash drift, missing/non-canonical Value, schema/owner/publication drift, and missing/extra/hash-drifted dependency expectations/rows. A multi-drift case proves Value precedes owner, and schema precedes owner/state. The existing composite dependency FK correctly prevents constructing a stored row whose target hash does not exist; expected-hash drift is therefore exercised through a valid query expectation, while missing/extra persisted row drift is injected through legal Store transactions.

| Verification | Result |
| --- | --- |
| managed `npm run contracts:g3.query:generate` / `contracts:g3.query:check` | PASS；pack=`sha256:516f0fffdab8e05438649e8936a78e0fedac5eb9300abcb0ff232f5204e793dd`；1 positive / 5 negative；generate 后 read-only check byte-exact |
| managed `npm run typecheck` | PASS |
| managed `npm run test:g3` | PASS；7 files / 36 tests；含 G3.5 Contract/Store 11 tests 与 G3.1/G3.2A/G3.2/G3.3/G3.4 回归 |
| managed `npm run contracts:check` / `contracts:archive:check` | PASS；current G0/G1/G2/G3 chain、historical G0/R-016/Draft roots 与 new G3.5 pack均通过 |
| managed `npm run test:g0` | PASS；15 files / 109 tests；内部再次执行完整 `contracts:check` |
| managed `npm run test:g2` / `test:g2:golden-current` | PASS；7 files / 47 tests 与 5 files / 26 tests |
| managed `npm run golden:current:replay:check` | PASS；40/40 exact，bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| managed `npm run build` / targeted Prettier check | PASS |
| G1/G2/G3.1/G3.2A/G3.2/G3.3/G3.4 immutable path diff | 相对基线 `c36a6e3` empty；G1 root/schema与G3.3 pack保持原 identity |
| changed-path / forbidden-surface / `git diff --check` | PASS；无 Registry/Authoring/Runtime/Projection forbidden directory、无 query implementation moving selector/launchability/write transaction/DML/Publisher/Release/Retention/Activation surface |

## G3.6 Retention / Executor ABI Compatibility Preflight

**状态**：`DONE`；G3保持`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。本切片完成最后一个独立纯read-only preflight，并在施工前完成Publisher persistence feasibility audit；审计结论为`PUBLISHER_BLOCKED_BY_SCHEMA`。本切片没有修改G1 DDL、Logical Schema、migration、Schema Manifest或Store transaction boundary，也没有创建Retention Handle、执行GC/delete、更新publication state、创建Feature/Core Release或实现Publisher/Publish/Activation。

G3.6 closed input exact绑定Feature Release、可空primary Execution Artifact、Registry Snapshot、Closure root/member set、Closure内全部typed Execution Artifact/Executor、Core Compatibility snapshot、G0.4 Run Protocol、Executor ABI v1、G1 Database Schema和`local_single_user_retention@1`。所有ref只接受immutable `VersionedRef`，所有hash只接受lowercase SHA-256；schema拒绝latest/range/alias/fallback/active pointer/launchability推断和unknown field。Store入口组合调用G3.3 `preflightRegistrySnapshot`和G3.5 `queryExactRegistryResource`，没有复制Registry SQL、Value/schema/owner/state/dependency或Closure traversal语义。

新增比较只覆盖规范已经冻结的事实：caller Closure root/member计算值、Closure ref/hash到Snapshot hash绑定、typed Artifact/Executor集合与Closure完整相等、Executor到Artifact ref/hash/entry symbol/provider release绑定、Core build和G1 schema一致、Registry/DB Schema version `1`、Run Protocol/Executor ABI major `1`及exact identity、Retention Policy identity，以及`published -> feature_release` typed root的member set等于Closure root加全部members。Run Protocol exact identity为G0.4 pack `sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607`；Executor ABI v1 identity为`sha256:a111ddc602dfce1894eeb09951fb250dff41984ad2e67c9eb316beb698946902`。结果closed、deterministic、固定`read_only=true`；accepted返回完整verified bindings，rejected返回`bindings=null`。

错误precedence固定为input -> side-effect -> Snapshot missing/hash/binding -> Closure root missing/hash/closure completeness -> Execution Artifact missing/hash/content -> Executor missing/hash/content -> artifact binding -> Core compatibility -> Run Protocol -> Executor ABI -> Retention Policy -> Retention eligibility。真实SQLite tests覆盖missing/hash/closure/ABI/retention drift、multi-drift ABI优先于Retention、重复调用byte-equivalent结果和全部Registry/Value/Closure/Snapshot/Retention/Release row count不变。

| Artifact | Version / exact hash |
| --- | --- |
| G3.6 Contract Pack | `icarus.workflow-contract-pack-g3-retention-executor-abi-preflight@1.0.0`; `sha256:4331a1941a2e53d4c214b947bcc004d55502ed2decee94fac53d227e0d989508` |
| Preflight Profile | `sha256:257eb47d398159d83b3dc43d554fc9838e4a6023a1e41e9b7b178db128648a81` |
| Profile Schema | `sha256:00213f6594d5ad3f4177d67c5699ab87d1d1b54b0bb9d3ce5ceb29be7bb13466` |
| Input / Result Schema | `sha256:0815fda4db829f569e65b89fca97aa4850bac2935e0d579deb86a9cea48c3920` / `sha256:12078f40c83a7c8086bb064631d298f334587571f091c87dd57336e67b0ec320` |
| Positive / Negative Fixtures | `sha256:1d96578aac593f8720e8578617a2766adb3e8f6498fd4b8e07e60550a2ee197a` / `sha256:79f9c9cafef80ed7650370c3d8bf5950d66ebdb81b56aa9e718bd7a1043158b6`; `1` / `5` cases |
| Domain Catalog | `sha256:0010bcf5ffda3be3a99f7ddfa0596d5dd692815a6c2ba8fb2d18f526fa3e1377` |

| Verification | Result |
| --- | --- |
| managed `npm run contracts:g3.6:generate` / `contracts:g3.6:check` | PASS；两次pack均为`sha256:4331a1941a2e53d4c214b947bcc004d55502ed2decee94fac53d227e0d989508`；1 positive / 5 negative；generate后byte-exact check |
| managed 新G3.6 Contract/Store targeted tests | PASS；2 files / 9 tests；真实文件SQLite、deterministic replay、closed schemas、missing/hash/closure/ABI/retention与read-only row counts |
| managed G3.1/G3.3/G3.5 direct checks | PASS；roots保持`fad831...eafa4` / `adcaa7...23da` / `516f0f...3dd` |
| managed `npm run test:g3` | PASS；9 files / 45 tests；G3.1-G3.6及G3.2A/G3.2分层回归 |
| managed `npm run schema:check` / `store:check` | PASS；G1 schema/root保持`sha256:4d8c373387ad515c36fd292b705665e6c197c73021c1b7e55da5317bc140efbd` / `sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756` |
| managed `npm run typecheck` / `npm run build` | PASS |
| authored source targeted Prettier | PASS；all matched files use Prettier style |
| frozen root/hash read-only check | PASS；G0.10 root=`sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec`；G2 current bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`；未运行G0/G2/Golden全量回归 |
| G1/G2 sealed/G3.1/G3.3-G3.5 immutable path diff | PASS；相对基线`4d10ac6` empty |
| changed-path / forbidden-surface scan / `git diff --check` | PASS；仅G3.6 contract/store/docs/scripts；production preflight无transaction/DML、Feature Release/Retention Handle table mutation、Publisher/Publish/Activation/G4-G9 surface |

### Publisher Persistence Readiness Audit

G3.6完成当时的审计结论唯一为`PUBLISHER_BLOCKED_BY_SCHEMA`，不是`BLOCKED_BY_SPEC`。现有G1可精确承载下列Publisher最终事实：

| Required fact | Existing exact G1 mapping |
| --- | --- |
| canonical resource/source payload | `workflow_values(id, inline_canonical_json, content_hash, schema_resource_id/schema_resource_hash)`；只能作为schema-bound Value，不能代替command header |
| resource/ref/hash/dependency identity | `workflow_registry_resources` + `workflow_registry_resource_dependencies`及`type/ref`、`id/hash` UK/FK |
| Closure/member/Snapshot/Core/DB identity | `workflow_registry_closure_manifests`、`workflow_registry_closure_members`、`workflow_registry_snapshots`及typed hash FK |
| Feature Release与Execution Artifact | `workflow_feature_releases(release_ref,release_version,release_hash,execution_artifact_resource_id/hash,compatibility_snapshot_ref/hash,status)` |
| exact release resource set | `workflow_feature_release_resources(release_id,resource_id,content_hash,resource_role)`及typed Resource FK |
| published Retention root/member set | `workflow_registry_retention_handles(feature_release_id,closure_manifest_id/hash,handle_kind,status)` + `workflow_registry_retention_handle_members(handle_id,resource_id,content_hash)`及kind/root CHECK与typed FKs |

最小blocker为G1没有Publisher专属command boundary。`workflow_runtime_commands`的13种command和六种typed target、`runtime_capacity_admin_commands`的两种Capacity command均为closed union，不能合法复用。当前没有任何表能同时约束和持久化caller `(idempotency_domain,idempotency_key)`、canonical Publish request hash、approved review ref/hash与reviewer actor/session/expiry、source/plan/artifact/closure/target release identities、deterministic receipt、每次authenticated invocation的`applied | duplicate | conflict | failed`结果，以及crash/retry后可恢复的append-only Publisher phase facts。内存map、自由JSON、无约束side table、derived guess或忽略caller key均被规范禁止。

后继任务的最小schema delta固定为三个first-class对象：`workflow_publisher_commands` header、`workflow_publisher_command_invocations`和`workflow_publisher_events`。Header必须拥有caller idempotency UK、schema-bound canonical request/result Value+hash、domain request hash、approved review/actor/session/expiry、source/plan/Execution Artifact/Closure/target release exact列与typed FK、final applied release FK和lifecycle/finalization CHECK；Invocation必须保存monotonic invocation、submitted request hash、authenticated actor/session、closed disposition与exact result；Event必须保存append-only attempt/phase/failure/recovery事实与稳定ordering/uniqueness/hash chain。现有Feature Release resource set和Retention member表继续作为authoritative typed graph，不新增副本。

该prerequisite必须以additive physical-schema input保留G0.6/G0.10历史identity，并同步Normative Logical Schema coverage、typed relation/CHECK/UK/index/query intent、canonical migration与`database_schema_version`、Schema Manifest/dependency manifest/lint/constraint/query-plan fixtures。G1 root/physical/schema/migration identity将改变；G3.1、G3.3、G3.5、G3.6中pin旧G1 identity的pack必须确定性重建或显式successor，G2 sealed artifacts不变。下方G1.4已完成这一前置切片。

## 已完成切片：G1.4 Publisher Idempotency / Audit Schema Prerequisite

**状态**：`DONE`；Publisher readiness由历史`PUBLISHER_BLOCKED_BY_SCHEMA`推进为`PUBLISHER_SCHEMA_PREREQUISITE_READY`。G3保持`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。本切片只补足G3.7 staged Publisher transaction所需的持久化Schema，不实现`WorkflowPublisher.publish`、Publisher业务DML/transaction、Registry staged-to-published mutation、Feature Release创建、Retention Handle写入、Execution Artifact build/install、receipt执行、Activation/active pointer、Production loader、GC/delete或G4-G9 Runtime。

新增G1-owned additive physical input `icarus.workflow-publisher-schema-prerequisite/1`，artifact=`sha256:93ca47fc61812061c77400b78c2285790a86ea852e1358d5369f95db55ba4330`，delta=`sha256:b30a8991d8a2563b07f3ade59d212488c791274c96b7c636835df7a86fafae84`。它精确绑定并保留G0.6 Logical Source `sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214`与G0.10 Capacity delta `sha256:5d9e79b5f9330a5111e6f61b8d04164c87839a60d55ea350c0aa87b8b1559e66`，没有修改两者的source或generated artifact。

Normative Logical Schema从78表additive扩展到81表并把`database_schema_version`推进到`2`：

- `workflow_publisher_commands`以`UNIQUE(idempotency_domain,idempotency_key)`固定caller key；request/source manifest/compiled plan/canonical receipt全部使用`Value id + content hash + schema resource id + schema hash`四列复合FK；approved review ref/hash、reviewer actor/auth session、`approved_at_ms <= created_at_ms < expires_at_ms`、Execution Artifact、Closure、target/applied Feature Release exact identities均为显式列和typed FK。`pending | applied | failed` CHECK固定receipt/finalized/applied-release组合，applied release必须等于target；identity字段不可更新，terminal lifecycle不可重开，Header不可删除。
- `workflow_publisher_command_invocations`按`UNIQUE(command_id,invocation_no)`保存每次authenticated actor/session、submitted request hash、schema-bound exact result与`applied | duplicate | conflict | failed` disposition。Invocation保存command-bound domain request hash；CHECK证明applied/duplicate/failed请求相等、conflict请求不等，只有applied具有`applied_at_ms`。相邻`previous_invocation_hash/invocation_hash`由trigger验证，hash全局唯一，UPDATE/DELETE被拒绝。
- `workflow_publisher_events`以`PRIMARY KEY(command_id,event_no)`和`UNIQUE(command_id,attempt_no,phase,event_type)`保存authenticate/validate/review/preflight/publish transaction/recovery/finalize事实。typed related Feature Release和schema-bound detail Value不使用kind/id或自由JSON；phase/type/failure CHECK区分pre-transaction failure、committed Publish、recovery success/failure与terminal failure。相邻Event hash chain由trigger验证，UPDATE/DELETE被拒绝。
- `workflow_values`新增`UNIQUE(id,content_hash,schema_resource_id,schema_resource_hash)`作为所有Publisher canonical Value的复合FK parent。现有Registry resource/dependency、Closure/Snapshot、Feature Release/resource set、Retention Handle/member与Value表仍是唯一权威，没有复制member graph或创建无约束side table。
- 四个query intent与固定EXPLAIN fixture覆盖caller idempotency lookup、Invocation history、Event replay和pending recovery partial scan；Schema Manifest/lint/constraint-trigger/query-plan artifact同步覆盖caller UK、review expiry、typed FK、terminal lifecycle、两个append-only hash chain和immutability。

Current G1 identities：

| Artifact | Identity |
| --- | --- |
| Schema Dependency Manifest | `sha256:00bbf7a38a294e9d7f867df70b9db3c7ca0fc7cfe777902fb531e363b678c4e0` |
| Physical schema identity | `sha256:e6150805b5c26dfc6ba0886da88b79345cfd5838d8da05d1ca011e371f390616` |
| G1 executable schema root | `sha256:d4796f1fbae16e05a2d19ce1be0a65d9c00439814dec97940aea20effaa6d244` |
| Domain-separated Schema Manifest hash | `sha256:0c00cd859c3ab6a8cd36c9ea8f81c80de000b845eb5758d442cb1830cea877f9` |
| Schema Manifest artifact | `sha256:fe97803fe8d91c5e6beb59892fdf612d4bf1963def75028dece50f3393edbd89` |
| Executable DDL artifact | `sha256:df1f9bf333e2e247c20331bb5058af365d5fe04d5e59f4cde1e55ea51c0cc90c` |
| Canonical migration raw SHA-256 | `sha256:fb6c820a0f646148cbd9f54476917802bc208c84070f005fc24871be46ecae89` |
| Deterministic digest | `sha256:d2e025b72f7da307406a9a9194f32d53021f8c92b4f92c6e8df422208da7e132` |

Physical manifest现为81 tables / 1,354 columns / 143 UK / 369 FK / 867 CHECK / 36 logical indexes / 19 triggers / 35 query fixtures。Store仍只有既有generic synchronous `withImmediateTransaction` boundary；只更新其frozen G1 pins和81-table bootstrap/check，不增加Publisher方法或业务事务。

受G1 identity影响的current construction packs按现有可重建治理依序更新，G2 sealed trees零diff：G3.1=`sha256:264ec0b6c7b3431acb3a556de5ad666248f320835f7d7ba4b7c255a041eac01a`，G3.3=`sha256:8abadf0f85d8d88e3559e84834badaaa36b224f9f115cd5dd4e2bec45690a8bb`，G3.5=`sha256:73493f9919891fd7164ec7e77a31282a7e386f8447134ec266085bcb7a0e01f4`，G3.6=`sha256:8150113af596f59ec08dd612f1092d9c7a5d72f61958367a825f7574b9727f76`。G3.6 Core Compatibility/current profile同步固定Database Schema `2`，read-only preflight语义不变。

验证全部通过managed runtime：targeted Publisher Schema tests 2/2，`test:g1.1` 14/14，deterministic `schema:generate/check`、`store:check`、四个受影响G3 direct checks、`test:g3` 45/45、`typecheck`与`build`。G2 sealed immutable diff、G0.6/G0.10 exact identity、changed-path/forbidden-surface、targeted Prettier和`git diff --check`均PASS；按切片约束没有机械运行`test:g0`、`test:g2`或Golden replay。

## G3.7 WorkflowPublisher Staged Publish Vertical Slice

**状态**：`DONE`；G3继续为`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`与40/40 exact replay，G4-G9保持`NOT_READY`。本切片只实现`WorkflowPublisher.publish`的closed request/receipt/result与单一staged Publish事务；没有实现Feature Release Activation、`workflow_feature_active_releases`写入、Production loader、Execution Artifact build/install、authoring source compile、GC/delete、Runtime Command/Capacity Command复用或G4-G9 Runtime。

机器合同：

- `g3-workflow-publisher-types.ts`与`g3-workflow-publisher.ts`冻结canonical request、approved review、receipt和invocation result；request/review/target release/receipt/result/invocation/event/command id均有独立domain-separated hash。request显式绑定caller`idempotency_domain + idempotency_key`、source manifest Value、Compiled IR v2 Value、G3.1 preflight、完整ordered G3.5 release-resource query set、G3.6 input和目标Feature Release，拒绝latest/current/active pointer/free JSON side table或derived identity。
- approved review exact hash绑定`human:local-owner` reviewer、authentication session、approval/expiry、source/plan、Execution Artifact、Closure和target release。新命令要求authenticated invocation actor/session逐字等于reviewer并满足`approved_at_ms <= requested_at_ms < expires_at_ms`；terminal exact replay不重新提升或修改approval。
- Publisher直接执行G3.1、对全部release resources调用G3.5，并调用一次G3.6；G3.6继续组合G3.3 snapshot/Closure preflight与G3.5 Artifact/Executor query，没有复制三者的canonical Value、dependency traversal、error precedence或SQL lookup语义。Source manifest复用G3.2A hash/closed validation但不读取source path；Compiled Plan复用sealed IR v2 schema与Plan hash，不编译或猜测authoring source。
- Contract Pack为`icarus.workflow-contract-pack-g3-workflow-publisher@1.0.0` / `sha256:5deba1546ce7754eecb4b553c7ce357b9702b44b763a45b2324923a5337a06d3`，包含3个closed schema、1 positive / 3 negative fixtures与domain catalog。独立入口为`contracts:g3.7:generate/check`；默认`contracts:check`增加read-only G3.7 check，G2 generator不隐式生成G3.7 artifacts。

事务实现：

- `authoring/workflow-publisher.ts`只使用现有`WorkflowRuntimeStore.withImmediateTransaction`。一个`BEGIN IMMEDIATE`内重新运行所有Store-backed preflight，然后原子写canonical source/plan/request/receipt/result Values、Publisher command/invocation/event、Registry exact `staged -> published` CAS、`status=staged` Feature Release、exact release-resource rows、held `published -> feature_release` Retention root/member set和command terminalization；Store base、G1 schema和transaction surface没有修改。
- first success=`applied`；same key/same domain request=`duplicate`并返回原canonical receipt；same key/different domain request=`conflict`；fully FK-bindable composed-preflight rejection=`failed`，保留不可launch的failed/staged audit但不发布Registry resource、不写release resource或Retention root。Invocation/Event按command adjacent编号、append-only并使用相邻hash chain。
- 事务内任一fault/collision完整rollback。transaction rollback后相同key以`invocation_kind=recovery`从原staged facts重新apply；commit后进程关闭/重开则返回canonical duplicate并追加`recovery_started/recovery_succeeded`。Activation pointer count始终为0，receipt固定`active_pointer_changed=false`。

定向验证证据（全部通过`./scripts/runtime-toolchain.sh exec -- <command>`）：

| 命令/证据 | 结果 |
| --- | --- |
| `npm run contracts:g3.7:generate` / `contracts:g3.7:check` | PASS；pack两次为`sha256:5deba154…a06d3`，artifact bytes deterministic |
| `npm run test:g3.7` | PASS；2 files / 14 tests；closed contracts、applied/duplicate/conflict/failed、approval expiry、release collision、adjacent hash chains、5个transaction fault boundary、rollback/reopen recovery与双real-file DB semantic determinism |
| `schema:check` / `store:check` / `test:g1.1` / `test:g1.2` | PASS；G1 root/schema hash保持`d4796f…d244` / `0c00cd…77f9`，14/14 schema tests与11/11 Store tests通过 |
| G3.1/G3.3/G3.5/G3.6/G3.7 direct checks / `test:g3` | PASS；既有pack hashes不变，G3.7=`5deba154…a06d3`；11 files / 59 tests |
| `typecheck` / `build` | PASS；按切片约束未运行`test:g0`、`test:g2`或Golden全量回归 |
| G2 sealed artifact diff / forbidden surface / targeted Prettier / `git diff --check` | PASS；只读sealed positive plan fixture，G2 sealed trees零diff；无active-pointer/Production loader/Runtime/Capacity command DML或越界实现 |

## G3.8 Feature Release Activation Persistence Readiness Audit

**状态**：`DONE`；审计结论唯一为`ACTIVATION_BLOCKED_BY_SCHEMA`，不是`BLOCKED_BY_SPEC`。G3继续为`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`与40/40 exact replay，G4-G9保持`NOT_READY`。本切片只审计并冻结下一项最小G1 prerequisite；没有新增Activation Contract/Schema、active-pointer DML、Release lifecycle mutation、Production loader、Execution Artifact build/install、GC/delete或G4-G9 Runtime，也没有修改G2 sealed artifacts。

现有Database Schema `2`的承载能力与最小缺口：

| Activation required fact | Existing exact authority | Blocking field / constraint / query gap |
| --- | --- | --- |
| closed request/receipt/result | `workflow_values`可保存schema-bound canonical Value | 没有Activation command header或request/compatibility result/receipt/result schema identity FK，不能用自由JSON或Publisher Value列代替 |
| caller idempotency | Publisher有自己的`(idempotency_domain,idempotency_key)`UK | Activation没有独立caller UK/domain request hash；Publisher、Runtime、Capacity三个closed command union都不可复用 |
| target staged release | `workflow_feature_releases`可保存exact ref/id/hash、Artifact、compatibility snapshot；resource set已由G3.7发布 | 没有Activation request到target的typed binding，也没有`feature_id,id,release_hash`复合owner parent |
| expected active pointer CAS | `workflow_feature_active_releases`有feature/release/hash/row-version基础列 | 没有expected `absent | present`、expected row version/previous release command binding、adjacent row-version trigger或固定CAS lookup intent |
| pointer/Release owner与lifecycle | Release status closed为`staged | active | draining | disabled | deleting` | pointer FK仅绑定`release_id,release_hash`，允许跨Feature；无每Feature单active partial UK、target-active/pointer immutability/delete约束或合法lifecycle/timestamp/row-version transition trigger |
| G3.6 compatibility | G3.6组合G3.3 Snapshot/Closure与G3.5 exact resource query，并验证Artifact/Executor/Core Protocol/ABI/Retention eligibility | 没有Activation compatibility input/result durable binding；Activation必须查询`publication_state=published`，不能逐字复用G3.7 staged input |
| target/previous Retention | held `published -> feature_release` Handle/member graph已是GC权威 | G3.6只证明eligibility；没有typed command FK证明target与previous exact Handle均为held且Closure一致，也没有对应preflight query intent |
| Invocation/Event audit | Publisher拥有自己的applied/duplicate/conflict/failed Invocation与Event streams | Activation没有每次authenticated Invocation、phase Event、adjacent numbering、append-only immutability/hash chain或schema-bound result/detail |
| crash/retry/recovery | generic `BEGIN IMMEDIATE` host与Publisher recovery pattern可用 | 没有Activation pending scan、canonical terminal receipt lookup、Invocation history或Event replay query，因此不能durable恢复pointer/lifecycle结果 |

closed request必须绑定caller key、actor/session/time、Feature与target staged Release exact ref/id/hash、expected pointer absent/present + nullable row version/previous Release、G3.6 input/result及target/previous held Retention/Closure。closed receipt必须绑定command/domain request、Feature、target/previous Release、expected/applied pointer versions、active/draining lifecycle、compatibility result、held Retention、activation time、`active_pointer_changed=true`和receipt hash。closed invocation result必须绑定command/submitted/domain request hash、四种disposition、applied/duplicate的canonical receipt、conflict的expected/observed pointer state/version、failed的closed phase/code及result hash。以上Value和Event detail均需schema-bound canonical Value，不能落入自由JSON。

G3.6复用边界保持不变：Activation继续调用G3.6，G3.6继续组合G3.3与G3.5；不得复制Snapshot/Closure/resource SQL、canonical Value验证、dependency traversal、error precedence或result semantics。Activation另行验证target/previous Release owner、exact published resource set、current lifecycle、held Retention Handle与expected pointer CAS。G3.6的Retention eligibility result不冒充held Handle事实，既有Release resource和Retention member表继续是唯一权威，不复制member graph。

下一最小前置切片固定为G1.5 `icarus.workflow-feature-release-activation-schema-prerequisite/1`，将current executable Database Schema从`2`推进到`3`。它只增加三个first-class对象并加固既有Release/pointer/Retention relation：

- `workflow_feature_release_activation_commands`：caller key/domain request hash；schema-bound request、compatibility input/result、canonical receipt；Feature id与target staged release ref/id/hash；expected pointer `absent | present`、nullable expected row version和previous release ref/id/hash的closed组合；target/previous published Retention Handle与Closure immutable identity、observed held state/row version；applied pointer row version；`pending | applied | failed` lifecycle、timestamps和row version。
- `workflow_feature_release_activation_invocations`：per-command adjacent invocation number、command-bound/submitted request hash、authenticated actor/session/time、`applied | duplicate | conflict | failed`、schema-bound result Value、previous/current invocation hash与UPDATE/DELETE prohibition。
- `workflow_feature_release_activation_events`：adjacent event/attempt number；closed authenticate/validate/preflight/activation-transaction/recovery/finalize phase；`attempt_started | phase_succeeded | pre_transaction_failed | activation_transaction_started | activation_committed | recovery_started | recovery_succeeded | recovery_failed | terminal_failed` event type；typed target/previous release identity、schema-bound detail Value、previous/current event hash与UPDATE/DELETE prohibition。
- 既有relation加固：Release增加`(feature_id,id,release_hash)`复合parent、每Feature至多一个active的partial UK、identity immutability和合法lifecycle/timestamp/adjacent row-version trigger；active pointer改用owner-consistent复合FK并增加target-active、CAS adjacency、immutability/delete保护；Retention提供不可变published root/Release/Closure identity复合parent，Activation insert/transition trigger验证observed held/row-version，并禁止Release处于`active | draining`时释放Handle，但历史audit row不永久阻止未来合法release。
- 固定query intents：caller idempotency lookup、Invocation history、Event replay、pending recovery、expected-pointer CAS lookup、target/previous Release+held Retention preflight。Schema Manifest/dependency manifest/migration/lint/constraint-trigger/query-plan fixtures必须覆盖全部新增字段与约束。

G1 physical/schema/migration/root identities和pin它们的G3.1/G3.3/G3.5/G3.6/G3.7 current construction packs需要确定性级联重建；G0.6/G0.10 historical source和G2 sealed artifacts保持byte-unchanged。G1.5只交付持久化prerequisite，仍不实现Activation或active-pointer DML。

prerequisite就绪后，Activation事务模型固定为一个`BEGIN IMMEDIATE`：重跑G3.6组合和Activation-specific Release/resource/Retention/pointer preflight；验证expected pointer absent或exact row version；有旧active时执行`active -> draining`，target执行`staged -> active`；pointer首次insert为row version `1`，后续只允许`N -> N+1`；target和旧Release的published Retention Handle保持held；canonical receipt/result、Invocation/Event和command terminalization与上述事实全成或全不变。CAS mismatch为`conflict`，compatibility/lifecycle/resource/Retention拒绝为`failed`，两者都不修改pointer/lifecycle。首次成功为`applied`；terminal exact replay返回canonical result并追加`duplicate`；same-key domain drift追加`conflict`。

commit前crash使pointer、lifecycle、receipt与audit全部rollback，同key可在不变事实上重试；commit后crash从canonical receipt恢复，只追加duplicate或recovery Invocation/Event，不重复切换pointer。Invocation/Event必须为adjacent、append-only、domain-separated hash chain，Recovery验证链后才能信任terminal result。

定向验证证据（全部通过`./scripts/runtime-toolchain.sh exec -- <command>`）：

| 命令/证据 | 结果 |
| --- | --- |
| `npm run schema:check` / `store:check` | PASS；current Database Schema 2 root/hash保持`sha256:d4796f…d244` / `sha256:0c00cd…77f9`，Store candidate identity未漂移 |
| `npm run test:g1.publisher` | PASS；1 file，2/2 targeted Publisher prerequisite tests（12 skipped） |
| `npm run contracts:g3.6:check` / `contracts:g3.7:check` | PASS；pack保持`sha256:8150113…7f76`（1 positive / 5 negative）与`sha256:5deba154…a06d3` |
| `npm run test:g3.7` | PASS；2 files / 14 tests；closed contract、applied/duplicate/conflict/failed、5个rollback boundary、reopen recovery和real-file determinism |
| `npm run typecheck` / `npm run build` | PASS；按切片约束未运行`test:g0`、`test:g2`或Golden全量回归 |
| changed-path / G2 sealed / `git diff --check` | PASS；仅三份规范/进度/README文档变化；G2 sealed artifact diff为空；无Activation Contract、Schema、migration、DML或实现文件 |

## 已完成切片：G1.5 Feature Release Activation Schema Prerequisite

**状态**：`DONE`；G1在本切片开始时从`DONE`临时reopen为`IN_PROGRESS`，交付与验证完成后恢复为`DONE`。G3始终保持`IN_PROGRESS`，G2保持`DONE / BASELINE_ACCEPTED`与40/40 exact replay，G4-G9保持`NOT_READY`。本切片只实现G1-owned `icarus.workflow-feature-release-activation-schema-prerequisite/1`与Database Schema `3`；没有实现Activation Contract、Activation业务DML、active-pointer mutation、Production loader、GC/delete、Execution Artifact build/install、Publisher/Runtime/Capacity command union复用或G4-G9 Runtime。

新增additive physical input artifact=`sha256:2e2e98cd8276d3b42b796afb34508be44800619d3781ddd88f10022c55a7a46e`，delta=`sha256:abdaa6c00ce2832fafb0273936489470fa3176dbe8891a7bd6be2db21e2336d1`。它逐字绑定并保留G0.6 Logical Source、G0.10 Capacity delta与G1.4 Publisher prerequisite，不修改G0.6/G0.10 historical source或G2 sealed artifacts。

Database Schema从81表扩展到84表：

- `workflow_feature_release_activation_commands`持久化独立caller idempotency、schema-bound request/G3.6 compatibility input+result/canonical receipt、exact target/previous owner Release、expected pointer absent/present CAS、exact published Retention/Closure与held row-version observation，以及`pending | applied | failed`终结事实。
- `workflow_feature_release_activation_invocations`和`workflow_feature_release_activation_events`分别持久化authenticated `applied | duplicate | conflict | failed` Invocation和closed phase Event；两条stream均按command相邻编号、domain hash绑定、append-only且由SQLite trigger验证相邻hash。
- `workflow_feature_releases`新增`(feature_id,id,release_hash)`owner parent、per-Feature single-active partial UK、closed timestamp shape、identity/delete保护和`staged -> active -> draining -> disabled -> deleting`相邻row-version trigger。
- `workflow_feature_active_releases`新增owner-consistent composite FK、row version从1开始、target-active insert/update、相邻CAS、Feature identity immutability与delete protection。
- `workflow_registry_retention_handles`新增published Release/Closure immutable复合parent、Activation preflight index、held observation trigger，以及Release为`active | draining`时禁止release/delete；历史Activation audit FK不包含mutable status/row-version，因此不会永久阻止Release进入`disabled`后的合法Handle release。
- 7个固定query intents覆盖caller idempotency、Invocation history、Event replay、pending recovery、expected-pointer CAS、target/previous Release preflight和published held Retention preflight。Schema Manifest、typed relations、lint、constraint/trigger和query-plan fixtures同步覆盖全部新增对象。

Current G1 identities：

| Artifact | Identity |
| --- | --- |
| Activation Schema prerequisite / delta | `sha256:2e2e98cd8276d3b42b796afb34508be44800619d3781ddd88f10022c55a7a46e` / `sha256:abdaa6c00ce2832fafb0273936489470fa3176dbe8891a7bd6be2db21e2336d1` |
| Schema Dependency Manifest | `sha256:2cd580b39b88c425e2bd1ff58a058756806daed1a790cff8accce0e6aa8e7508` |
| Physical schema identity | `sha256:b6b034224202d9673e177d4fb10144c5568f5d848a1dd6f75837d0eb1d52cf9b` |
| G1 executable schema root | `sha256:39f7aef4e28d3466f49832edda8ed3fd193eb4abb73b39287119ecb8247948b7` |
| Domain-separated Schema Manifest hash | `sha256:9761bf8df83ace49b61c7dfce3f3523ecf7a69dacdccdd09837aa110ac021be6` |
| Schema Manifest artifact | `sha256:6e2fb3d19a9f0368b4dc330761addeda9e33f8f20437cdf204f58833390ff86e` |
| Executable DDL artifact | `sha256:dd6b5b5db5fbe556fdf76cd693c382e5503931bd5b3b1cc5ef6c13bf5faeb34a` |
| Canonical migration raw SHA-256 | `sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345` |
| Deterministic digest | `sha256:81f4ba0bb7b2deb8bffaf04fcbc2c0901d3ae2577a1084de98bb5c1d03133e3f` |

Physical Manifest为84 tables / 1,442 columns / 152 UK / 385 FK / 929 CHECK / 43 logical indexes / 39 triggers / 42 query fixtures。受G1 identity影响的current construction packs已确定性重建：G3.1=`sha256:8ee8268a6407f097a5455bfd4eb6b04d46efde80bd7d76341a70286ef6b11f7e`，G3.3=`sha256:9dc2aaccfe904258822b98c30fa38893035360fb773eb97fc944013e2505369e`，G3.5=`sha256:1634fec5441eb6694b09ea8b7fc8b7501e1cf291fb934cb81b572c36bb3eb824`，G3.6=`sha256:4bea9b044c5dabe78d0d2b23353216f9a11b9265fea2a0004c9b811336cffadc`，G3.7=`sha256:a1c6807f10d832876c63516687ce1965cff32ddcedd58d51ee8d24e18c4c21a3`。G3.6 current compatibility固定Database Schema `3`，read-only组合边界不变。

定向验证证据（全部通过`./scripts/runtime-toolchain.sh exec -- <command>`）：

| 命令/证据 | 结果 |
| --- | --- |
| `schema:generate` / `schema:check` / `store:check` | PASS；Schema 3 artifacts byte-deterministic，真实文件SQLite migration/reopen/integrity/FK/introspection/query-plan与Store identity通过 |
| `test:g1.activation` / `test:g1.1` / `test:g1.2` | PASS；G1.5定向3/3、完整Schema 17/17、Store 11/11 |
| G3.1/G3.3/G3.5/G3.6/G3.7 direct checks / `test:g3` | PASS；current pack hashes逐项匹配；11 files / 59 tests |
| `typecheck` / `build` | PASS |
| G0.6/G0.10 historical source、G2 sealed、forbidden surface、targeted Prettier、`git diff --check` | PASS；历史/sealed bytes零diff；无Activation Contract/DML、pointer mutation、loader、GC/delete、Artifact install或G4-G9实现 |
| 未运行项 | 按切片约束未机械运行`test:g0`、`test:g2`或Golden全量回归 |

## 2026-07-22：G1 DDL / Store独立整体回归

**结论**：`PASS`；G1.1-G1.5作为Database Schema `3`完整阶段继续维持`DONE`，G3维持`IN_PROGRESS`，G4-G9维持`NOT_READY`。回归基线为`main` / `8c6da3dc393d7d222f4060999eb85eb9273140c0`，parent=`10a390f2446ebb64372e1b406f2bcd843f8c3fb7`，初始工作树clean。没有实现G3.9、Activation业务DML、Production loader、GC/delete、Execution Artifact或G4-G9 Runtime。

阶段闭合证据：

- G1.1：`schema:generate`后Git零漂移，随后`schema:check`通过；schema input、10-member dependency manifest、root、physical identity、canonical migration、Manifest、executable DDL与Profile pins逐项一致。真实文件SQLite migration/reopen/introspection固定84 tables / 1,442 columns / 152 UK / 385 FK / 929 CHECK / 43 logical indexes / 39 triggers / 42 query-plan fixtures / 319 statements，118个enum CHECK逐个动态执行，全部constraint/trigger/query-plan fixture通过。
- G1.2：11项Store测试覆盖closed Profile校验、G1 identity与migration drift fail-closed、无Contract目录扫描、真实文件bootstrap/reopen与完整PRAGMA、单writer ownership/close、existing schema/profile mismatch、强制read-only `query_only`与write rejection、同步`BEGIN IMMEDIATE` commit/rollback、async/DDL callback rejection、跨进程writer lock及host/certification identity fail-closed。
- G1.3：closed exact-member dependency manifest固定10 members（9 physical + 1 construction provenance）；unrelated Contract JSON不影响identity，raw-byte、semantic、missing member、duplicate role/path、unknown field与hash drift均有正反测试；Store只消费frozen pins。
- G1.4：Publisher定向2项通过，覆盖caller idempotency、schema-bound Value与typed Registry/Release FK、command lifecycle、Invocation/Event相邻hash chain、immutability及query-plan；没有新增Publisher Store API。
- G1.5：Activation定向3项通过，覆盖独立caller idempotency、typed request/compatibility/receipt/Release/Retention binding、command terminalization、Invocation/Event chain、single-active Release lifecycle、active-pointer owner/CAS、held Retention与后续合法release；仍无Activation业务DML。

Current identity保持：G1 root=`sha256:39f7aef4e28d3466f49832edda8ed3fd193eb4abb73b39287119ecb8247948b7`，Schema Manifest hash=`sha256:9761bf8df83ace49b61c7dfce3f3523ecf7a69dacdccdd09837aa110ac021be6`，dependency manifest=`sha256:2cd580b39b88c425e2bd1ff58a058756806daed1a790cff8accce0e6aa8e7508`，physical identity=`sha256:b6b034224202d9673e177d4fb10144c5568f5d848a1dd6f75837d0eb1d52cf9b`，migration=`sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345`，Profile=`sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af`，SQLite=`3.53.2`。

受影响边界回归：G0 SQLite/logical tree=`0da80769666843708e54563a1651160478a7daff`、G0.6 conformance tree=`8f8b856d2c91ecddef5c70b10144df86c9eebcd3`、G0.10 tree=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed tree=`26155e8850f4abaaa04bac7a2ee35fd75b2ff21e`在parent与基线HEAD间完全相同。G3.1/G3.3/G3.5/G3.6/G3.7 current packs保持`8ee8268a…b11f7e` / `9dc2aacc…5369e` / `1634fec5…3eb824` / `4bea9b04…cffadc` / `a1c6807f…c21a3`；G3.7 staged Publish的5个transaction fault point、rollback、reopen recovery、collision、duplicate/conflict/failed和双real-file database determinism通过，active pointer始终未写。

| 命令/证据 | 结果 |
| --- | --- |
| `git diff --check`；`schema:generate`后Git drift check；`schema:check`；`store:check` | PASS；generate/check幂等，Schema 3与Store identity一致 |
| `test:g1.1` / `test:g1.2` | PASS；1 file / 17 tests；1 file / 11 tests |
| `test:g1.publisher` / `test:g1.activation` | PASS；2 passed / 15 skipped；3 passed / 14 skipped |
| `test:g0.6` / `test:g0.10` | PASS；1 file / 8 tests；1 file / 10 tests |
| `contracts:g3:check` / `contracts:g3.registry:check` / `contracts:g3.query:check` / `contracts:g3.6:check` / `contracts:g3.7:check` | PASS；2 positive + 19 negative；1 + 4；1 + 5；1 + 5；G3.7 exact pack check |
| `test:g3` | PASS；11 files / 59 tests |
| `golden:current:replay:check` / current `test:g2` | PASS；40/40 exact；7 files / 47 tests |
| `contracts:check` | 初次发现并修复过期G2 boundary assertion后PASS；完整current G0/G1/G2/G3 chain、Schema与Store均通过 |
| `typecheck` / `build` | PASS |
| historical tree diff / forbidden surface scan | PASS；G0.6/G0.10与G2 sealed零diff；schema目录外无Activation/active-pointer DML，无Production loader、GC/delete、Artifact install或G4-G9实现 |

额外全链检查发现一个真实回归：G2 Production Compiler的current boundary仍把整个`authoring/`目录视为G3+越界，因此G3.7合法`authoring/workflow-publisher.ts`会使`contracts:check`失败。修复将该construction-era断言收窄为精确authoring allowlist，只允许G3.7的`workflow-publisher.ts`与测试文件，任何G3.9/Activation或其他authoring entry继续fail-closed；`registry`、`runtime/graph-runtime.ts`和`projection/runtime-center-api.ts`也继续禁止。current compiler与R-016重复断言同步验证该exact tree。定向2 files / 10 tests、`compiler:g2:check`、完整`test:g2`与`contracts:check`均通过，G2 Production Compiler root和sealed artifacts未改变。历史`test:g2:archive`中的resolved Draft重建仍按其旧G1 frozen identity拒绝current Schema 3；seal后current gate已明确改用frozen inventory checks，本回归不改写construction-era Draft或sealed bytes。

## G3.8A Activation Failure / Replay Contract Repair

**状态**：`DONE / SCHEMA_REPAIR_REQUIRED`。G3保持`IN_PROGRESS`，G3.9固定为`BLOCKED_BY_G1_6`；G1 current Schema `3`基线仍为`DONE`，下一切片G1.6开始时才临时reopen；G2保持`DONE / BASELINE_ACCEPTED`与40/40 exact replay，G4-G9保持`NOT_READY`。本切片只冻结规范、Contract Pack、fixtures、真实Schema 3最小复现与G1.6实施交接；没有修改executable DDL、Schema Manifest、Store、G3.9 service、active-pointer DML、Publisher或任何production-reachable surface。

G3.9独立实施审计确认Schema 3仍有四个真实缺口：failed command要求canonical receipt为null但旧G3.8把所有exact replay概括为duplicate + receipt；command header没有schema-bound canonical terminal result/Invocation identity；Retention observation insert trigger在status/row-version/identity rejection前abort；caller-requested owner mismatch被required typed Release binding拒绝。这些缺口通过真实文件SQLite Schema 3 migration复现，不使用暂停会话摘要作为权威。

G3.8A把receipt固定为“已提交pointer transition的证明”：first applied与其exact replay使用同一个原receipt；first failed、failed exact replay、same-key domain drift、pointer CAS conflict及其exact replay均为null。Exact replay只对command-bound domain request成立并返回`duplicate`，typed引用header canonical terminal result；重复domain drift始终为`conflict`并追加独立Invocation/Event。Pointer CAS conflict是bound request的canonical terminal `conflict`，因此其后exact replay为`duplicate`但无receipt。

Caller claims只保存在schema-bound canonical request Value。G1.6必须将Release/Retention/compatibility/pointer改为nullable `verified_*` typed groups，只在各自preflight成功后出现；owner/lifecycle/resource/G3.6/Retention rejection以已验证事实前缀terminalizefailed audit，不伪造缺失事实。Command header新增`terminal_disposition`、canonical terminal result Value quartet和canonical terminal Invocation id/no/hash，并通过完整deferred composite FK绑定immutable Invocation terminal UK。

Database Schema `4` prerequisite要求重建3张Activation关系，删除insert-time Retention observation rejection，增加applied-only terminalization验证、failed/conflict closed terminal shape、duplicate terminal-result reference、nullable verified Event release binding及replay/conflict event types；Release/active-pointer lifecycle/CAS与active/draining Retention保护保持不变。Schema `3 -> 4`只允许Activation三表与active-pointer表均为空，否则fail closed，不迁移或解释construction-only Activation audit。新增terminal result lookup并保留idempotency/history/pending/pointer/Release/Retention query intents。G1 identity与current G3 construction packs需确定性级联，G0.6/G0.10 historical source和G2 sealed artifacts必须byte-unchanged。

Machine artifacts：

| Artifact | Identity |
| --- | --- |
| G3.8A Contract Pack | `icarus.workflow-contract-pack-g3-8a-activation-contract-repair@1.0.0` / `sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f` |
| Repair Contract | artifact=`sha256:94cb2c390bb44298238b1ffac4184b04f59efbbeae6f268fbce7618104ec406b`; internal contract=`sha256:70d4b9ef47c83711415636737292450538acaf5cc4547d3130b04b101e6707ae` |
| Repair / Scenario / Negative schemas | `sha256:19d633d8f7c9b0086b644edcb3c4c499c9307c005da381fbff987dc00a927178` / `sha256:1d3ab9b50d2c5576cf903075b53daeac74577491f677d2bdcc569b34a1450ee6` / `sha256:bddef326e2d1baa4fdd521a629e506635236d1b4ed0a838b8974cfbe1a592170` |
| Positive / Negative / Fault fixtures | `sha256:78b8dcfee6e8a03bf094f26148f8a7f6e98880495f346a4fbabd18509b8077d2` / `sha256:e98b1e4482579fe10fba5e961a347d5f54929e348383580c0aed0983cc8ddf96` / `sha256:3e1fa27c098701fa3efe870fe1044a067656cc2f0785d23ee593843383751c78`；9 / 59（12 mutation + 47 domain/error） / 17 cases |

验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| `contracts:g3.8a:generate/check`连续两轮 | PASS；两轮pack均=`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`，8-member artifact bytes稳定；62 column / 12 FK / 7 UK requirements闭合 |
| `test:g3.8a` | PASS；1 file / 4 tests；9 positive、59 negative（12 mutation + 47 error classification，含20项G3.6 nested precedence）、17 fault；真实文件Schema 3四缺口复现 |
| `test:g1.activation` / G3.6/G3.7 direct checks / `test:g3.7` | PASS；G1.5 3/3；G3.6/G3.7 identities保持`4bea9b04…cffadc` / `a1c6807f…c21a3`；G3.7 14/14 rollback/reopen tests |
| `contracts:check` | PASS；current G0/G1/G2/G3/Schema/Store全链通过，Schema root/hash保持`39f7aef4…948b7` / `9761bf8d…1be6` |
| `test:g3` / `test:g2` | PASS；12 files / 63 tests；7 files / 47 tests，current successor保持40/40 exact |
| `typecheck` / `build` | PASS |
| historical/forbidden boundary / targeted Prettier / `git diff --check` | PASS；G0.6/G0.10 historical source、完整G1 Schema 3目录与G2 sealed tree相对基线零diff；无Schema/Store/authoring/Activation DML变化 |

## G1.6 Activation Failure / Replay Persistence Schema Prerequisite

**状态**：`DONE`。G1已重新闭合为`DONE`，current Database Schema为`4`。G3继续`IN_PROGRESS`，G3.9从`BLOCKED_BY_G1_6`提升为`READY`但本切片没有实施；G2保持`DONE / BASELINE_ACCEPTED`，G4-G9保持`NOT_READY`。

独立physical input `icarus.workflow-feature-release-activation-failure-replay-schema-prerequisite/1`（`sha256:d1fd091aedae1d8d6d51e3442c074050ab57ab5330e18bf37adef628b8dcba9d`）逐项消费frozen G3.8A `62 column / 12 composite FK / 7 UK`及relation/check/trigger/query requirements。Current Schema重建command/invocation/event三表：canonical request Value保留唯一caller claims；nullable `verified_*`只形成合法preflight前缀；command terminal header以完整deferred composite FK绑定immutable Invocation与schema-bound result Value；receipt仅属于`applied`；failed/conflict没有receipt或applied pointer版本。Exact terminal replay只允许`duplicate`并引用header result，same-key domain drift继续`conflict`且不改header。

Schema 3 construction source仍可逐字节重建旧migration `sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345`。Canonical `Schema 3 -> 4` upgrade为`sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf`：Production Store在同一个`BEGIN IMMEDIATE`内、任何DDL之前验证frozen Schema 3 `sqlite_schema` identity和Activation command/invocation/event及active-pointer四表全空；任一非空、identity drift或DDL/target verification失败均rollback。Store current schema校验只消费frozen Profile/root/dependency/DDL/Manifest/migration/upgrade artifacts，不重建source或扫描construction Contract目录。

Current identities：

| Artifact | Identity |
| --- | --- |
| G1 executable schema root | `sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` |
| Schema Dependency Manifest | `sha256:8ed4d092c0822fe06b154117d3fc2d6d74c9041644b0883ab2e978c4a2abe35d` |
| Physical schema identity | `sha256:61ca572ff0f8551ff67f5529753610012fd6027a484e77cc8e63716f4814e04f` |
| Domain-separated Schema Manifest hash | `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a` |
| Schema Manifest artifact | `sha256:87f6787dd5c6382df97120c2e10dc6624143c67efc35e57cb92ea22f16fa666b` |
| Canonical Schema 4 migration | `sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43` |
| Schema 3 -> 4 upgrade | `sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf` |
| Schema 3 / Schema 4 SQLite identities | `sha256:a4bc69f3bbf8f6cf00c32c835596eed4a73036941276a3175d550faba2d2f5ee` / `sha256:e46f58e49b42ad53e3d744de86b6d8fb6299236258459c35d9ca3affa440932c` |

Physical Manifest固定84 tables / 1,462 columns / 153 UK / 389 FK / 951 CHECK / 44 logical indexes / 41 triggers / 43 query fixtures / 323 statements。受G1 identity影响的current construction packs依次重建为G3.1=`sha256:152fc9bd4ecbc4fb5a395d06698c81142befa294466ffbd665cfb2a9b874c71d`、G3.3=`sha256:839338a8d2bccfbacd8fd395640f4c79ce31a35d1ec5421bc752a98961514fc2`、G3.5=`sha256:74cb66b4e2c3d244a45de70c9f236df112c83fabf1f8230afbd046394c8d0b49`、G3.6=`sha256:730daac9db4bcfb645374b12e10e3962ddacbebc2828875cb00133c8ada195a8`、G3.7=`sha256:2fae2da648d6da5969e6c5c57b2342f6f15b3084b39e7acfc43b010b48517e74`；G3.6 compatibility提升到Database Schema `4`。G3.8A frozen pack继续保持`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`，没有级联改写。

验证覆盖fresh Schema 4 real-file bootstrap/reopen/introspection；empty Schema 3升级；四个nonempty relation分别fail closed且main DB hash/user_version/schema identity/row count零修改；request-only pending、nullable verified prefix、owner/Retention rejection facts、applied-only receipt、failed/conflict null receipt、terminal Invocation/result binding、exact replay/domain drift、Invocation/Event adjacency/immutability/tamper，以及八个Activation query plan。G1.5 Release lifecycle/single-active、pointer CAS/immutability/delete/target-active和active/draining Retention保护继续回归通过。范围内没有新增Activation service/业务DML、active-pointer业务mutation、Production loader、GC/delete、Artifact build/install或G4-G9 Runtime。

| G1.6 verification gate | Evidence |
| --- | --- |
| 两轮 `schema:generate` + `schema:check` | PASS；两轮root/schema/migration/upgrade固定为`6f494518…d591` / `f517a5e7…106a` / `4a8ddeb1…be43` / `5ac263fe…a3cf` |
| `store:check` / `test:g1.1` / `test:g1.2` | PASS；Store frozen identity通过；G1 schema 20/20；Store 17/17，含fresh、empty upgrade和四个nonempty fail-closed真实文件case |
| `test:g1.publisher` / `test:g1.activation` | PASS；Publisher 2/2；Activation 5/5，逐项映射62 columns / 12 FK / 7 UK及全部relation/check/trigger/query requirements，并覆盖缺失pointer observation拒绝 |
| G3.1/G3.3/G3.5/G3.6/G3.7 direct checks | PASS；current pins为`152fc9bd…c71d` / `839338a8…4fc2` / `74cb66b4…0b49` / `730daac9…95a8` / `2fae2da6…7e74` |
| `contracts:g3.8a:check` / `test:g3.8a` | PASS；frozen pack保持`d8412111…722f`；1 file / 4 tests；9 positive、59 negative、17 fault fixtures不变 |
| `test:g3` / `contracts:check` / `test:g2` | PASS；G3 12 files / 63 tests；全Contract/Schema/Store chain通过；G2 7 files / 47 tests且successor 40/40 exact |
| `typecheck` / `build` / `git diff --check` | PASS |
| protected-tree / forbidden-surface | PASS；G0 SQLite=`0da80769…47a8`、G0.10=`2bf94fb4…9fb1`、G2 sealed=`26155e88…5fd7`、G3.8A repair/fixtures/pack Git identities=`5b63164e…f157` / `a358e690…e6f` / `e6ccc030…7ebd`；无Production Activation DML/service/loader/GC/Artifact build-install surface |

## 2026-07-22：G1 Database Schema 4独立整体回归

**结论**：`PASS`。独立回归从clean `main`基线`dfa25e7fba8b19757101af7c658be8eb2ed88e17`开始，parent=`04aaa70e7ef55db7192e920ace6d19b5f51e8888`；运行环境为local checkout、filesystem `disabled/unrestricted`、sandbox `danger-full-access`、approval policy `never`，全部Node/npm命令均通过`./scripts/runtime-toolchain.sh exec -- <command>`。G1/G1.1-G1.6继续`DONE`，current Database Schema继续为`4`；G3继续`IN_PROGRESS`，G3.9继续`READY`且本回归没有实施；G2继续`DONE / BASELINE_ACCEPTED`与40/40 exact replay，G4-G9继续`NOT_READY`。

独立审阅完整覆盖规范/进度/Contract README、`dfa25e7`相对parent的提交diff、G1.1-G1.6 source/DDL/Manifest/dependency/database identity/migration/fixtures/Store/Profile/tests、frozen G3.8A handoff、受G1 identity影响的G3 current packs，以及G0.6/G0.10/G2 sealed/current边界。Production Store只读取frozen SQLite Profile、G1 root、dependency Manifest、executable DDL、Schema Manifest、canonical migration和Schema 3-to-4 upgrade；其生产open路径不加载`loadExecutableSchemaSource`、不重建Manifest/DDL、不扫描construction Contract目录。

确定性与物理闭合证据：

- 连续两轮`schema:generate` + `schema:check`均PASS；第一轮后clean worktree零漂移，补充Gate测试后的最终两轮只保留预先存在的测试diff，整个`store/schema`树零diff。两轮root/dependency Manifest/Schema Manifest/executable DDL raw SHA-256分别保持`04a89cc9e06c17d71c6ab71aa35d106105728f5d40488ededcad1e849f4dc7cc` / `2b9bedde9e14ce2ee1a5d648590c2a1ee3f878221333a5694be12f5adbd7552c` / `d38e182a33e93e12f4cacf72b18eddcf38e0762e9b71f407a84443108b24e2c7` / `a0dc2a9a210d315d637d04d50632cce116fdfd6623a2060254943b96978e6c32`；migration/upgrade raw SHA-256保持`4a8ddeb1…be43` / `5ac263fe…a3cf`。因此全部generated member bytes、root、Manifest、migration、upgrade与SQLite identities均byte-stable。
- Fresh real-file Schema 4 bootstrap/reopen、database/connection Profile、`integrity_check`、`foreign_key_check`、introspection和fixed EXPLAIN plans全部通过；Physical Manifest固定84 tables / 1,462 columns / 153 UK / 389 FK / 951 CHECK / 44 logical indexes / 41 triggers / 43 query fixtures / 323 statements。
- Empty frozen Schema 3 Activation/active-pointer数据库原子升级到Schema 4。Store在同一`BEGIN IMMEDIATE`内、首条DDL前验证Schema 3 `sqlite_schema` identity和四张required-empty relation；升级后验证`user_version=4`、Schema 4 identity、integrity与FK后才commit。
- 四张required-empty relation逐一注入单行均fail closed。回归将断言增强为失败前后主数据库原始bytes和SHA-256、`user_version`、`sqlite_schema` identity、全部84张表row counts逐项完全相同，而不是只核对触发relation。
- 新增三个严格属于G1 Store upgrade Gate的独立故障测试：合法额外index造成Schema 3 identity drift时在首条upgrade DDL前拒绝；复制frozen schema root并篡改upgrade SQL时artifact loader在打开数据库前拒绝；在Schema 3 preserved relation注入FK violation后，upgrade DDL执行至target verification并因`foreign_key_check`失败，完整rollback到原Schema 3。三者均证明main DB bytes/hash、`user_version`、source schema identity与全表row counts零修改；没有修改生产实现或任何frozen artifact。
- G3.8A机器映射固定62 column / 12 composite FK / 7 UK / 6 relation requirements / 9 trigger intents / 8 Activation query intents / 12 constraint fixture cases。真实Schema 4测试覆盖request-only pending、nullable verified合法前缀与孔洞拒绝、owner/Retention rejection audit、applied-only receipt、failed/conflict null receipt、terminal Invocation/result binding、exact replay/domain drift、Invocation/Event adjacency/immutability/tamper；G1.5 Release lifecycle/single-active、active-pointer owner/CAS/immutability/delete/target-active及active/draining Retention保护继续通过。

Current identities逐项保持：

| Artifact | Identity |
| --- | --- |
| G1 executable schema root | `sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` |
| Schema Dependency Manifest | `sha256:8ed4d092c0822fe06b154117d3fc2d6d74c9041644b0883ab2e978c4a2abe35d` |
| Physical schema identity | `sha256:61ca572ff0f8551ff67f5529753610012fd6027a484e77cc8e63716f4814e04f` |
| Domain-separated Schema Manifest hash | `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a` |
| Canonical Schema 4 migration | `sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43` |
| Schema 3 -> 4 upgrade | `sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf` |
| Schema 3 / Schema 4 SQLite identities | `sha256:a4bc69f3bbf8f6cf00c32c835596eed4a73036941276a3175d550faba2d2f5ee` / `sha256:e46f58e49b42ad53e3d744de86b6d8fb6299236258459c35d9ca3affa440932c` |
| SQLite Profile | `sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af` |
| G3.1 / G3.3 / G3.5 / G3.6 / G3.7 current packs | `sha256:152fc9bd4ecbc4fb5a395d06698c81142befa294466ffbd665cfb2a9b874c71d` / `sha256:839338a8d2bccfbacd8fd395640f4c79ce31a35d1ec5421bc752a98961514fc2` / `sha256:74cb66b4e2c3d244a45de70c9f236df112c83fabf1f8230afbd046394c8d0b49` / `sha256:730daac9db4bcfb645374b12e10e3962ddacbebc2828875cb00133c8ada195a8` / `sha256:2fae2da648d6da5969e6c5c57b2342f6f15b3084b39e7acfc43b010b48517e74` |
| Frozen G3.8A Contract Pack | `sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`；9 positive / 59 negative / 17 fault |

Managed Gate结果：

| 命令/证据 | 结果 |
| --- | --- |
| 两轮`schema:generate` + `schema:check` / `store:check` | PASS；生成树零漂移，root/schema/profile identities逐项匹配 |
| `test:g1.1` / `test:g1.2` | PASS；2 files / 20 tests；1 file / 20 tests（新增3项upgrade fault Gate，四类nonempty全量零修改断言） |
| `test:g1.publisher` / `test:g1.activation` | PASS；2/2；5/5 |
| `contracts:g3.8a:check` / `test:g3.8a` | PASS；frozen pack=`d8412111…722f`；1 file / 4 tests；9/59/17 fixtures不变 |
| G3.1/G3.3/G3.5/G3.6/G3.7 direct checks / `test:g3` | PASS；五个current pins逐项匹配；12 files / 63 tests |
| `contracts:check` | PASS；完整current G0/G1/G2/G3、Schema与Store chain通过 |
| `test:g2` / `golden:current:replay:check` | PASS；7 files / 47 tests；successor exact replay 40/40，sealed bundle=`sha256:d99647d8…2145` |
| `test:g0.6` / `test:g0.10` | PASS；1 file / 8 tests；1 file / 10 tests |
| `typecheck` / `build` / changed TypeScript targeted Prettier / `git diff --check` | PASS |
| protected-tree / forbidden-surface | PASS；G0 SQLite=`0da80769666843708e54563a1651160478a7daff`、G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`26155e8850f4abaaa04bac7a2ee35fd75b2ff21e`、G3.8A repair/fixtures/pack=`5b63164e5f4bcf40b81af0fdd564107150baf157` / `a358e690e90294f0ad08ec47992ff9f645df7e6f` / `e6ccc030633464ae712cadd85d295a2c37bd98a4`；parent到baseline及当前worktree均零diff |

Changed paths仅为本回归记录与G1 Store Gate测试。没有新增G3.9 Activation Contract/service/业务DML、active-pointer业务mutation、Production loader、GC/delete、Execution Artifact build/install或G4-G9 Runtime，也没有改写frozen G3.8A semantics/identity、G2 sealed bytes或G0.6/G0.10 historical source。下一独立施工任务固定为G3.9。

## G3.9 Feature Release Activation

**状态**：`DONE`。本切片从clean `main`基线`0f7b73301aeccc0e688ae2f6994b5c8ec4aced8e`开始，parent=`dfa25e7fba8b19757101af7c658be8eb2ed88e17`；运行环境为local checkout、filesystem `disabled/unrestricted`、sandbox `danger-full-access`、approval policy `never`，全部Node/npm命令均通过`./scripts/runtime-toolchain.sh exec -- <command>`。G3.1-G3.9现均完成，G3 Gate进入`EXIT_CANDIDATE_PENDING_INDEPENDENT_G3_REGRESSION`；G1/G1.1-G1.6继续`DONE`，G2继续`DONE / BASELINE_ACCEPTED`与40/40 exact replay，G4-G9继续`NOT_READY`。

独立Contract Pack为`icarus.workflow-contract-pack-g3-feature-release-activation@1.0.0` / `sha256:2ef0997982483a6da4c6c6cfd3e26b7934f7fcffce4fdae160f94f4e9d600b38`。Request / receipt / result schema resource hashes分别为`sha256:18b6b621ed172999a2d9a677e1adfd66790079089751562c4317c08747704921` / `sha256:68049e60a9febc4c65a162c930f93757386503ee054ce64046e562b134c85ffe` / `sha256:c99c78fb1a7701264e20ae1d29824bafac183787ba79ab22398d4d5045f80f1a`，G3.6 input/result schema resource hashes为`sha256:547403ae41a7eeca5ca10b0c2d58bd6e3a13640949c20ef85eb0d86548900150` / `sha256:8488f2903938a2f46d85efe7ccb9312093d8a3629f0beb7f8d616725e80c73e6`，fixture digest=`sha256:13bcfd0730c3b08af1d7345bf8fa04d6e4fb90cfea5d3d8eb2e5d7b41d5d61e3`。Pack包含9 positive、53 negative（6 structural/admission + 完整Activation precedence并展开20项G3.6 nested code）、17 fault cases；frozen G3.8A自身的9/59/17和62 column / 12 composite FK / 7 UK映射继续零漂移。

Canonical request Value是caller claims唯一exact权威；third command boundary只使用`workflow_feature_release_activation_commands/invocations/events`。实现严格执行bytes/removed/unknown/schema/hash/auth/domain drift/terminal integrity及Release/G3.6/lifecycle/Retention/pointer/persistence precedence，G3.3/G3.5只经G3.6组合调用。一个同步`BEGIN IMMEDIATE`重跑Store-backed preflight并原子提交previous `active -> draining`、target `staged -> active`、pointer `absent -> 1`或`N -> N+1`、held Retention observation、canonical Values、command/Invocation/Event与terminalization，不复制Retention member graph。

行为证据逐项闭合：first applied仅执行一次pointer transition并返回receipt；present pointer保持adjacent CAS且previous进入draining；resource/G3.6/lifecycle/Retention rejection形成failed，pointer mismatch形成conflict，两类均零Release/pointer mutation且receipt为null；applied/failed/pointer-conflict exact replay均追加duplicate，applied duplicate返回原receipt，其余为null；pending和terminal same-key drift及其重复调用始终conflict。First terminal result JSON不自引用，Invocation typed quartet按Schema 4自指本次result；terminal header完整绑定canonical Invocation/result。Invocation/Event严格相邻、domain-separated且immutable。

Recovery先做bounded pending scan和stored request/command strict binding，再重算canonical result/receipt和完整Invocation/Event chain。Clean pending可恢复；pending存在不一致transition evidence时拒绝。9个pre-commit fault点全部证明request/verified Values、Release/pointer、receipt/result、Invocation/Event和terminalization整体rollback；commit后丢响应的真实文件数据库reopen只追加recovery duplicate与`recovery_started/recovery_succeeded/terminal_replayed`，pointer row version保持不变。Command terminal hash、result Value schema、receipt hash binding、Invocation hash/schema、Event hash/attempt binding等7类tamper全部fail closed且Invocation/Event count不增加。双独立真实文件数据库产生相同result和Activation semantic rows；active Release删除与held Retention release保护继续拒绝。

Gate结果：

| 命令/证据 | 结果 |
| --- | --- |
| 两轮`contracts:g3.9:generate` + `contracts:g3.9:check` | PASS；两轮pack均=`sha256:2ef0997982483a6da4c6c6cfd3e26b7934f7fcffce4fdae160f94f4e9d600b38`，全部member bytes稳定 |
| `test:g3.9` | PASS；2 files / 33 tests；strict-bytes precedence及真实SQLite applied/failed/conflict/replay/drift/rollback/reopen/recovery/tamper/determinism/protection全覆盖 |
| `contracts:g3.8a:check` / `test:g3.8a` | PASS；frozen pack=`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`；1 file / 4 tests；9/59/17与62/12/7保持 |
| `contracts:g3.6:check` / `contracts:g3.7:check` / `test:g3.7` | PASS；pins=`sha256:730daac9db4bcfb645374b12e10e3962ddacbebc2828875cb00133c8ada195a8` / `sha256:2fae2da648d6da5969e6c5c57b2342f6f15b3084b39e7acfc43b010b48517e74`；G3.7 2 files / 14 tests |
| `test:g3` | PASS；14 files / 96 tests |
| `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；G1 root/schema=`sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` / `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a`；Activation 5/5；Store 20/20 |
| `contracts:check` | PASS；完整current G0/G1/G2/G3/Schema/Store chain包含G3.9 direct check |
| `test:g2` / `golden:current:replay:check` | PASS；7 files / 47 tests；successor 40/40 exact，sealed bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| `test:g0.6` / `test:g0.10` | PASS；1 file / 8 tests；1 file / 10 tests |
| `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS |
| protected-tree / forbidden-surface | PASS；只扩展current G2精确authoring allowlist以容纳G3.9 service/test；G2 sealed、G0.6/G0.10、G3.8A和G1 Schema/Store production identities零修改；无loader/resolver、Artifact build/install、GC/delete、新authoring stage或G4-G9 surface |

## G3 Whole-Gate Independent Regression

**结论**：`PASS / G3 DONE`。独立回归从clean `main`基线`0bd9a2c25f778ec4442346c8897fe95ac5cbabad`开始，parent=`0f7b73301aeccc0e688ae2f6994b5c8ec4aced8e`；运行环境为local checkout、`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、切换或创建worktree、push、amend或重写历史。交接前曾有一次只读`node -e`包脚本查看未经过managed wrapper；该偏差没有写入或生成输出，之后全部Node/npm生成、检查、测试、typecheck、build和Prettier命令均严格通过`./scripts/runtime-toolchain.sh exec -- <command>`。

回归完整复读G3.1-G3.9 machine packs、closed schemas、fixtures、generator/checker、Store/authoring实现和测试，并审阅baseline完整diff及Schema 4 DDL/Manifest/upgrade/Store边界。全仓检索确认Activation继续只使用第三command boundary `workflow_feature_release_activation_commands/invocations/events`；G3.6仍是G3.3/G3.5唯一组合边界并保持20项内部precedence；G3.7仍为单个`BEGIN IMMEDIATE` staged Publisher；frozen G3.8A保持9 positive / 59 negative / 17 fault与62 column / 12 composite FK / 7 UK；G3.9保持9 positive / 53 negative / 17 fault和closed request/receipt/result authority。

独立审阅发现并修复一个真实恢复完整性回归：原verifier验证Event hash adjacency、detail binding及每个Invocation至少具有started/terminal Event，但会接受攻击者追加的schema-valid `integrity_failed` Event，只要为该后缀重新计算正确hash。新增真实文件SQLite测试先复现恢复调用错误接受该tamper并追加audit；实现随后改为让写入与恢复共享同一frozen Event profile，并精确验证每个Invocation对应Event的数量、全局相邻顺序、phase/type/failure、occurred time、detail Value quartet及verified Release facts。修复后该tamper以`terminal_integrity_mismatch` fail closed，Invocation/Event counts不增加；正常applied/failed/pointer-conflict、submit/recovery replay与same-key drift profile不变。没有修改G3.9 Contract或Schema identity。

关键identity全部保持：G1 root=`sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591`；Schema 4 manifest=`sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a`；migration=`sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43`；Schema 3->4 upgrade=`sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf`；G3.6=`sha256:730daac9db4bcfb645374b12e10e3962ddacbebc2828875cb00133c8ada195a8`；G3.7=`sha256:2fae2da648d6da5969e6c5c57b2342f6f15b3084b39e7acfc43b010b48517e74`；G3.8A=`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`；G3.9=`sha256:2ef0997982483a6da4c6c6cfd3e26b7934f7fcffce4fdae160f94f4e9d600b38`；G3.9 request/receipt/result schema resources=`sha256:18b6b621ed172999a2d9a677e1adfd66790079089751562c4317c08747704921` / `sha256:68049e60a9febc4c65a162c930f93757386503ee054ce64046e562b134c85ffe` / `sha256:c99c78fb1a7701264e20ae1d29824bafac183787ba79ab22398d4d5045f80f1a`；G2 sealed successor=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`。G3.9连续两轮generate/check及前置快照的8-member tree digest均为`5ba064d318ef36dbda1d3eb2fae527b5d388352518531b1b5d7095f0ca80ba30`。

Gate结果：

| 命令/证据 | 结果 |
| --- | --- |
| G3.1-G3.9全部direct Contract checks | PASS；current G3.1/G3.2A/G3.2/G3.3/G3.5/G3.6/G3.7/G3.8A/G3.9 identities逐项匹配；G3.9两轮generate/check member bytes稳定 |
| `test:g3.7` / `test:g3.8a` / `test:g3.9` | PASS；2 files / 14 tests；1 file / 4 tests；2 files / 34 tests |
| `test:g3` | PASS；14 files / 97 tests；包含新增semantic Event tamper fail-closed用例 |
| `schema:check` / `store:check` | PASS；current G1 root、Schema 4 Manifest、migration、upgrade与managed SQLite/Profile identities不变 |
| `test:g1.activation` / `test:g1.2` | PASS；5/5 targeted Activation/Release/Retention tests；20/20 Store tests覆盖fresh/reopen、empty-only upgrade、四类nonempty、source identity drift与fault rollback |
| `contracts:check` | PASS；完整current G0/G1/G2/G3/Schema/Store chain通过 |
| `test:g2` / `golden:current:replay:check` | PASS；7 files / 47 tests；successor 40/40 exact且sealed bundle不变 |
| `test:g0.6` / `test:g0.10` | PASS；1 file / 8 tests；1 file / 10 tests |
| `typecheck` / `build` / changed TypeScript targeted Prettier / `git diff --check` | PASS |
| transaction/recovery/fault | PASS；absent/present pointer adjacent CAS、previous draining、target active、applied-only receipt、failed/conflict null receipt、strict verified-fact prefix、9个pre-commit全rollback、post-commit real-file reopen只追加recovery duplicate、clean pending恢复与inconsistent evidence拒绝全部闭合 |
| tamper/determinism/protection | PASS；command/result/receipt/Invocation/Event hash/schema/binding及重算hash的schema-valid Event suffix均fail closed且不追加伪造audit；双real-file semantic rows一致；active/draining Release删除和held Retention release保护保持 |
| protected-tree / forbidden-surface | PASS；G0.6/G0.10 historical source、G2 sealed/current、frozen G3.8A与G1 Schema/Store相对baseline零diff；无Production loader/current/latest resolver、Artifact build/install、GC/delete、新authoring stage、legacy alias/fallback/compatibility reader或G4-G9实现 |

G3.1-G3.9各pack中的`g3_status=IN_PROGRESS`或`EXIT_CANDIDATE_PENDING_INDEPENDENT_G3_REGRESSION`是各切片生成时的冻结事实，不为Gate关闭而重写；本进度账本、架构规范和Contract README共同记录whole-gate结论。G3现为`DONE`。G4只提升为下一独立任务`READY`，本回归没有创建G4 bootstrap profile、Runtime implementation或任何G4-G9 surface。

## G4 Test Bootstrap

**实现切片期状态**：`EXIT_CANDIDATE_PENDING_INDEPENDENT_G4_REGRESSION`。本切片从clean `main`基线`c9bfc3ddaa6893962f054e59ce05749b978c7ccc`开始，parent=`0bd9a2c25f778ec4442346c8897fe95ac5cbabad`；运行环境为local checkout、`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、Handoff、切换或创建worktree、push、amend或重写历史；全部Node/npm命令均通过`./scripts/runtime-toolchain.sh exec -- <command>`。

**工作包与边界**：I11为主、I4仅消费既有Connection Factory/Schema 4 Store。新增`src/workflow-runtime/bootstrap/`中的唯一显式test factory、Fake Adapter和Virtual Clock，以及`src/workflow-runtime/contracts/bootstrap/`、`conformance/g4-test-bootstrap/`、generator/checker/types/tests。没有修改G1 Schema/DDL/Store identity、G2 sealed、G3.8A/G3.9 Contract或G0.6/G0.10 historical source；没有实现G5-G9 Runtime、T0-T8、Workflow/Run/Activation创建或业务表写入、Reconciler/Scheduler/Ledger/Wait/Inbox/Outbox、Runtime Command/Projection、Production loader/current/latest resolver/launchability、Execution Artifact build/install、Retention/Blob GC/delete、Feature/API/Automation ingress、真实Adapter或legacy fallback/compatibility reader。

**切片期 Machine authority**：

- Contract Pack `icarus.workflow-contract-pack-g4-test-bootstrap@1.0.0`=`sha256:ac95824616a0a8e1fa9b8a1f6d90a6fee298b4e37581609f9fa01bad780c9d93`。
- Profile `icarus.workflow-test-bootstrap-profile@1.0.0`=`sha256:568c5ba1c61c7d8659031ff57d97bd821d02b1e086b31b39ef8121c396cd1ce7`；fixture set=`sha256:f0578f90adfa6d5def7a3acfcec03edfd91e4d32279a6dde1e6de36088179e80`；Fake Adapter profile=`sha256:dd7de6ad9d3388d7aab310e719e3df8348ee86328d134c2480ce652cf2e406a8`；Virtual Clock profile=`sha256:1f37b9d07a7c3b667d60eb489a3ed78017cb7d42072f065d551a5839a29ce73c`。
- Bootstrap implementation hash=`sha256:24161276558b6953d1414982ae193b6ab8ddad16ed2522e10c0732c4e01df456`；implementation artifact=`sha256:73ec7f37cffcd22ccce9e75afc7b8393a0c23bcb687b1fbd0c59d60622fed95c`；isolation boundary=`sha256:648dab69be05f5bd9c15637d895ea45433fd7f876bb47ff621e8c4c079e618ad`。
- Profile schema / Fake invocation schema / Fake result schema / isolation receipt schema=`sha256:df0af39cd0b8fd12b0ae53bbea4447021d5d46e8caa54bb0c6e25f0a562f4787` / `sha256:d32f0197077f0cb423246b83a211893cdb07eb560c31443c3570e66e4c0d053a` / `sha256:6c84dacc63281cb9be56c3eb0cf92a778be208b2c1bc821c42539683e66db74c` / `sha256:80db91304a878be14a2002b07ce7ca532643f06a811f3a31ce1ffc14e1d8ab9f`。
- Fixtures为7 positive / 21 negative / 13 fault，artifact identities=`sha256:6223b5e3e45f4e4889b8ae14dc656425dbfde4b1cf55d1f27040ff247d9d77a1` / `sha256:1fb3c5fc811e6869ba5e52972d4bfbb07771b9d668529343bc58e4ab6678147b` / `sha256:a4b0e195036be92de071447a086ba2bf8149ef5ba40f3fec1920a49c984d8b00`。

Factory没有缺省入口，必须显式传入exact profile/fixture ref+hash、instance key与canonical data root。Root必须是canonical `os.tmpdir()`下按instance key派生的exclusive新目录，并由owner marker、device/inode、receipt共同绑定；relative/alias/path escape/symlink、pre-existing empty/nonempty、concurrent reuse、permission/create失败、Production collision及删除后同路径替换全部fail closed。每个实例只通过`WorkflowRuntimeConnectionFactory`以`candidate_development`打开独立`workflow-runtime.db`，fresh/reopen均执行current G1 Schema 4/Profile/PRAGMA/identity gate。测试逐表证明全部84个Runtime业务/Registry/audit关系保持0 rows；receipt另证明Published Registry与active Release pointer为0，Production/Feature/API/Automation ingress、真实Adapter/network、Production/user data均不可达或未触碰。

Fake Adapter只接受七条exact invocation hash，固定逐字节replay `not_applied/applied_with_receipt/applied_but_receipt_lost/still_running/unknown/cancelled/compensated`；任一input、operation key、attempt、outcome或response drift拒绝。Virtual Clock固定seed=`g4-virtual-clock-seed-0001`、initial time=`1784764800000`，只允许显式单调advance，rollback/drift/invalid advance拒绝；源码静态Gate与抛错的`Date.now` spy证明没有wall-clock、real sleep或fallback。初始化在root-create/Store-open后中断均关闭Store并清理root，cleanup failure留下可识别residual marker；Store open与Schema/Profile拒绝不留下可消费数据库。Profile固定`not_certified/default_enabled=false/production_acceptance=reject`；由于Production loader/startup尚不存在，只以closed build/startup/loader negative Contract和263-file static surface inventory证明`test_bootstrap_profile_forbidden`，没有越界新增Production入口。

切片期 Gate结果：

| 命令/证据 | 结果 |
| --- | --- |
| 两轮`contracts:g4:generate` + `contracts:g4:check` | PASS；pack/profile/implementation三项hash连续一致，全部14个member artifacts byte-stable |
| `test:g4` | PASS；2 files / 17 tests；closed Contract/profile、真实文件Schema 4 bootstrap/reopen/isolation/cleanup、所有root/fault/tamper、七种Fake outcomes/replay及Virtual Clock完整覆盖 |
| `test:g3.9` / `test:g3` | PASS；2 files / 34 tests；14 files / 97 tests |
| `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；G1 root/Schema 4/Profile identities不变；Activation 5/5；Store 20/20 |
| `contracts:check` | PASS；完整current G0/G1/G2/G3/Schema/Store链及G4 direct check通过 |
| `test:g2` / `golden:current:replay:check` | PASS；7 files / 47 tests；successor 40/40 exact，sealed bundle不变 |
| `test:g0.6` / `test:g0.10` | PASS；1 file / 8 tests；1 file / 10 tests |
| `typecheck` / `build` / changed TypeScript targeted Prettier / `git diff --check` | PASS |
| isolation/fault/forbidden/protected-tree | PASS；临时roots全部清理或留下指定residual后由test teardown移除；production imports/ingress/startup/loader为0/absent；G0.6/G0.10、G2 sealed、G3.8A/G3.9和G1 Schema tree相对baseline零diff；无G5-G9 forbidden surface |

### G4 whole-gate independent regression

**状态**：`DONE`。独立回归从clean `main`基线`ab411b970898cb18fa3e88fc0cd62eed66ae714b`开始，parent=`c9bfc3ddaa6893962f054e59ce05749b978c7ccc`；运行环境为local checkout、`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、Handoff、创建或切换worktree、push、amend或重写历史；全部Node/npm命令均通过`./scripts/runtime-toolchain.sh exec -- <command>`。

独立审计发现并最小修复两个真实G4隔离缺口。第一，`validateRequestedRoot`与exclusive `mkdir`之间的跨进程竞争会使失败方进入通用cleanup并删除胜方root；现在只有确认成功创建root的实例拥有cleanup权，实际`EEXIST`、权限和create失败映射为稳定G4 error，确定性race测试证明胜方数据保留。第二，旧receipt只绑定database path，Store关闭后以另一份exact Schema 4空库替换`workflow-runtime.db`仍可通过Factory schema gate；receipt现在同时绑定database device/inode，reopen在Factory之前拒绝同字节换inode、symlink、missing或非文件成员。测试另将当前Schema 4关系数直接锁定为84，并逐表证明全部业务/Registry/audit关系为0 rows。没有新增G5事务fault或任何Production入口。

**Current machine authority**：pack=`sha256:4aff06c8170ffa533320e4180a76a169e6815217d3d86dacfa5f7f5448e18e9e`；profile=`sha256:7f88ff930cb4b9d9d348d7d6803a54831b146be069dd77318014f13a47390e6e`；bootstrap implementation=`sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad`；implementation artifact=`sha256:d0d04a99202f4d7ec86bd9893901db5dd2139aaad731d334408e627be4acb928`；isolation receipt schema=`sha256:14de3af0e2c40ac549418ad067c71b749b0ea076adb5c3733c26737b484333e9`。Fixture set=`sha256:f0578f90adfa6d5def7a3acfcec03edfd91e4d32279a6dde1e6de36088179e80`、Fake Adapter=`sha256:dd7de6ad9d3388d7aab310e719e3df8348ee86328d134c2480ce652cf2e406a8`、Virtual Clock=`sha256:1f37b9d07a7c3b667d60eb489a3ed78017cb7d42072f065d551a5839a29ce73c`、isolation boundary=`sha256:648dab69be05f5bd9c15637d895ea45433fd7f876bb47ff621e8c4c079e618ad`及7 positive / 21 negative / 13 fault fixtures保持不变。Pack中切片期`EXIT_CANDIDATE_PENDING_INDEPENDENT_G4_REGRESSION`是冻结machine事实，不为whole-gate关闭而重写。

| 独立回归证据 | 结果 |
| --- | --- |
| 两轮`contracts:g4:generate` / 独立member bytes与tree digest / `contracts:g4:check` | PASS；14 members与pack两轮逐字节一致；tree digest均为`0fd45778888a9f69d9647f514716ac0d68b3bf6210baee73e94992226356bb6e` |
| `test:g4` | PASS；2 files / 19 tests；84表零行、fresh/reopen、mkdir race ownership、root/database replacement、marker/receipt/member tamper、cleanup/residual、Fake/clock/Production rejection完整覆盖 |
| `test:g3.9` / `test:g3` | PASS；2 files / 34 tests；14 files / 97 tests；G3 Event profile修复继续通过 |
| `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；current Schema 4/root/migration/upgrade/SQLite Profile不变；Activation 5 passed / 15 skipped；Store 20/20 |
| `contracts:check` / `test:g2` / `golden:current:replay:check` | PASS；完整current链；G2 7 files / 47 tests；successor 40/40 exact |
| `test:g0.6` / `test:g0.10` / `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS；8 tests / 10 tests；编译、格式与diff均通过 |
| inventory/isolation/fault/forbidden scan | PASS；独立production inventory=263与machine artifact一致；未声明bootstrap source mutation被G4 check拒绝；production imports/Feature/API/Automation/startup/loader为0/absent；13 fault后root均清理或只留可识别residual；无真实Adapter/network/user/Production data |
| protected trees | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A fixtures=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`均零diff；G3.6/G3.7/G3.8A/G3.9 current identities不变 |

G4 whole-gate结论为`DONE`，只将G5提升为`READY`。本回归没有实现G5-G9、T0-T8、Workflow/Run/Activation创建或业务DML、Reconciler/Scheduler/Ledger/Wait/Inbox/Outbox、Runtime Command/Projection、Production loader/current/latest resolver/startup/activation、Execution Artifact build/install、Retention/Blob GC/delete、真实Adapter、Feature/API/Automation ingress或legacy alias/fallback/compatibility reader。

### G4 downstream-extensibility prerequisite reopen

**当前状态**：`EXIT_CANDIDATE_PENDING_INDEPENDENT_G4_REGRESSION`。本任务从clean local `main`基线`005241262568135f02ace4de97c3fa3eacb49131`开始，parent=`ab411b970898cb18fa3e88fc0cd62eed66ae714b`；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、Handoff、创建/切换worktree、push、amend或重写历史；全部Node/npm命令均通过`./scripts/runtime-toolchain.sh exec -- <command>`。在准备G5时发现真实上游finding：`0052412`中的G4 isolation boundary把`src/electron/features/setup/scripts`全部非测试JS/TS的file count与逐文件hash纳入G4 identity，并显式要求规范预留的`registry/production-activation.ts`、`runtime/graph-runtime.ts`和`projection/runtime-center-api.ts`不存在。因此即使合法下游模块完全不引用G4，新增文件本身也会使G4 artifact漂移或直接失败；这把“test-only bootstrap不可被Production消费”错误实现成了“冻结未来Production source tree”。按Gate治理显式重开G4；`0052412`中的旧identity仍是历史construction evidence，不作为current proof，也没有被冒充为新语义。

**选定设计**：current isolation authority升级为`icarus.workflow-test-bootstrap-isolation-boundary/2`。`src/workflow-runtime/bootstrap/`的递归非测试JS/TS集合必须与四个声明owned source exact相等，implementation artifact继续逐文件绑定bytes；除此之外，isolation artifact只保存稳定policy，不保存整个Production tree的count/hash。Checker每个独立进程实时枚举当前`src/electron/assistant/features/setup/scripts`，使用TypeScript AST解析static import/export、literal `require`与literal dynamic import，以relative/root和TypeScript resolver构造graph，并拒绝任意非测试非G4-authority source到bootstrap/profile authority的直接或间接可达路径。Feature、API、Automation、host/entrypoint按结构化规则单独分类；`package.json`的Production entry/default字段与start/dev/build/package/setup/auth scripts，以及host JSON/YAML/shell/plist/HTML和`tsconfig.json`不得引用或选择G4 authority。Contract/test scripts仍可显式运行G4 checker，但不会成为Production默认。未来G5-G9 source存在或数量变化不影响G4 identity；只有非法reachability、selection或ownership drift失败。

**Current machine authority与历史映射**：

| Authority | `0052412` historical | Current after reopen | 影响 |
| --- | --- | --- | --- |
| G4 pack | `sha256:4aff06c8170ffa533320e4180a76a169e6815217d3d86dacfa5f7f5448e18e9e` | `sha256:41fa8a427ee935669283fe119e04e1384df6d305eddff7396c4efb816ba3eaa8` | 重建current 14-member pack |
| test-only profile | `sha256:7f88ff930cb4b9d9d348d7d6803a54831b146be069dd77318014f13a47390e6e` | `sha256:1c7249c5a53f658db130447117116919f0f7258abbcddd77e092b528860f7798` | 只因isolation binding更新 |
| bootstrap implementation | `sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad` | `sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad` | 功能实现与四文件bytes未变 |
| implementation artifact | `sha256:d0d04a99202f4d7ec86bd9893901db5dd2139aaad731d334408e627be4acb928` | `sha256:d0d04a99202f4d7ec86bd9893901db5dd2139aaad731d334408e627be4acb928` | exact ownership/bytes继续有效 |
| isolation boundary | v1 `sha256:648dab69be05f5bd9c15637d895ea45433fd7f876bb47ff621e8c4c079e618ad` | v2 `sha256:2802b9cc93f91531d45c6ae53da554e077455f1b67271edea3e4fe7357ee0073` | 删除未来路径absence与全树identity，改为live graph/policy proof |

专项mutation fixture使用隔离临时repo并调用Production checker同一analyzer：新增无关downstream source及空`runtime/graph-runtime.ts`后source count增加而boundary bytes/identity稳定；修改G4-owned source使implementation hash变化；新增未声明bootstrap sibling失败；Production entrypoint的间接路径、Feature/API/Automation/host/G5 runtime直接import均失败；package start/default、launcher shell与tsconfig alias选择均失败。Fixtures现为9 positive / 31 negative / 13 fault，G4测试为2 files / 32 tests。本任务没有创建任何G5业务模块、事务、T0-T8、Capacity gateway、Scheduler、Reconciler或Production入口；root/database replacement、race ownership、84表零行、Fake Adapter、Virtual Clock与Production数据隔离语义保持不变。

| 本次退出证据 | 结果 |
| --- | --- |
| 两轮`contracts:g4:generate` / 14-member raw-byte digest / `contracts:g4:check` | PASS；两轮pack/profile/implementation一致；member digest均为`09c06981b03b40c543303f2b0f93e8b86ebe7cc4a422f84119c4604a789e3df5` |
| `test:g4` | PASS；2 files / 32 tests；原有bootstrap功能、84表零行、root/database replacement、race ownership、Fake/clock和新增10类isolation mutation全部通过 |
| `contracts:check` | PASS；完整current G0/G1/G2/G3/Schema/Store链及G4 v2 direct check通过 |
| `test:g3.9` / `test:g3` | PASS；2 files / 34 tests；14 files / 97 tests |
| `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；Schema 4/root/profile identities不变；5 passed + 15 skipped；20/20 Store tests |
| `test:g2` / `golden:current:replay:check` | PASS；7 files / 47 tests；successor exact replay 40/40 |
| `test:g0.6` / `test:g0.10` | PASS；8/8与10/10 |
| `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS |
| protected-tree / forbidden-surface / live import graph | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`均零diff；275 source / 38 roots / 9 G4 authority / 4 owned bootstrap / 0 violation；真实checkout无G5 production module |

本任务完成专项与上游回归后只把G4恢复到退出候选，不恢复G5施工。下一独立任务必须从本提交clean tree重新执行G4 whole-gate independent regression，复核两轮14-member bytes/tree digest、全部G4功能与mutation、完整上游链和protected trees；通过并另行记录`DONE`前，G5固定为`NOT_READY/BLOCKED_BY_G4_REGRESSION`。

### G4 downstream-safe whole-gate independent regression closure

**结论**：`PASS / G4 DONE`，G5 Basic Runtime=`READY`。本轮从clean local checkout `main@945e21283a46accfd175356cd4640805e420199c`开始，parent=`005241262568135f02ace4de97c3fa3eacb49131`；启动环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、创建或切换worktree、Handoff、push、amend或重写历史；所有Node/npm生成、检查、测试、typecheck、build和Prettier均通过`./scripts/runtime-toolchain.sh exec -- <command>`。

独立回归首先完整复核`945e212` candidate：两轮14-member raw bytes逐项相等，digest都为冻结值`09c06981b03b40c543303f2b0f93e8b86ebe7cc4a422f84119c4604a789e3df5`；pack/profile/bootstrap implementation/implementation artifact/isolation分别为`sha256:41fa8a427ee935669283fe119e04e1384df6d305eddff7396c4efb816ba3eaa8` / `sha256:1c7249c5a53f658db130447117116919f0f7258abbcddd77e092b528860f7798` / `sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad` / `sha256:d0d04a99202f4d7ec86bd9893901db5dd2139aaad731d334408e627be4acb928` / `sha256:2802b9cc93f91531d45c6ae53da554e077455f1b67271edea3e4fe7357ee0073`。

独立host-config probe发现一个真实G4回归：fixture中的Production `src/index.ts`以真实JSON module import加载`src/runtime-config.json`，该配置选择`icarus.workflow-test-bootstrap-profile`，但candidate analyzer返回`violations=[]`。原因是source graph枚举包含`src`，host JSON/YAML/shell/plist/HTML扫描却只覆盖`electron/assistant/features/setup/scripts`。最小修复让host configuration实时扫描全部六个既有source roots，不新增目录白名单；同时以15个exact current G4 artifact paths声明合法machine authority config，并把它们加入module-resolution authority targets，防止Production通过导入G4 artifact绕过。新增`production-imported-host-config` negative fixture与直接复现测试；fixture现为9 positive / 32 negative / 13 fault，G4 tests为2 files / 33 tests。没有修改四个owned bootstrap source、Store、Schema、Fake Adapter或Virtual Clock实现。

**Final current machine authority**：

| Authority | Identity |
| --- | --- |
| G4 Contract Pack | `sha256:1136d6d379b6d821175046449ec58cd7ba72e6ef72441be45d522e2a6a56e3ba` |
| test-only profile artifact | `sha256:15cbda14e581cbfb499dc8c0f20a297d695da9bd59af4051e9e3b72de97a5fcf` |
| bootstrap implementation | `sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad` |
| implementation artifact | `sha256:d0d04a99202f4d7ec86bd9893901db5dd2139aaad731d334408e627be4acb928` |
| isolation boundary v2 | `sha256:883f8f2d4040fd03ea5a49bd38826ce6c37d5556175219b66f335793087f9188` |
| final 14-member raw-byte digest | `8266a7a963d7f3a5b59cd0e12cfcb150992bf821e8498359bd60a8b8b07a0e47`，修复后连续两轮一致 |

最终验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| 修复前后各两轮managed `contracts:g4:generate`、14-member逐项raw hash、digest、`contracts:g4:check` | PASS；修复前两轮=`09c06981...e3df5`并匹配冻结基线；修复后两轮=`8266a7a9...0e47`，final pack/profile/implementation/isolation连续一致 |
| focused imported-`src`-JSON reproduction / managed `test:g4` | PASS；复现测试1 passed / 17 skipped；完整2 files / 33 tests，84表零行、fresh/reopen、mkdir race ownership、root/database replacement、cleanup/residual、Fake七结果、Virtual Clock及Production/user/network/real-adapter isolation全部保持 |
| 独立post-fix mutation matrix | PASS；53 assertions；24项六surface x static import/export-from/literal require/literal dynamic import，加上indirect re-export、真实tsconfig alias、cache write/restore invalidation、4 package fields、11 Production scripts、6 host config extensions与Production-imported source-root JSON |
| managed `contracts:check` | PASS；current G0/G1/G2/G3/Schema/Store与final G4 direct check完整通过 |
| managed `test:g3.9` / `test:g3` | PASS；2 files / 34 tests；14 files / 97 tests |
| managed `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；G1 root/Schema 4/Profile identities不变；Activation 5 passed / 15 skipped；Store 20/20 |
| managed `test:g2` / `golden:current:replay:check` | PASS；7 files / 47 tests；successor exact replay 40/40，bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| managed `test:g0.6` / `test:g0.10` | PASS；8/8与10/10 |
| managed `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS |
| live graph / protected-tree / forbidden-surface / changed-path | PASS；275 source / 38 roots / 9 G4 source authority / 4 owned bootstrap / 0 violation；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 successor sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`相对baseline零diff；changed paths仅G4 checker/test/fixture/generated artifacts与三份治理文档；无G5-G9 module或Production入口 |

Machine pack中的`EXIT_CANDIDATE_PENDING_INDEPENDENT_G4_REGRESSION`与`NOT_READY_BLOCKED_BY_G4_REGRESSION`是artifact生成时冻结事实，本轮没有为关闭Gate伪造改写。治理层G4现为`DONE`，只把G5提升为`READY`；本任务没有实现G5-G9、T0-T8、Workflow/Run/Activation业务DML、Capacity gateway、Reconciler、Scheduler、Ledger、Wait/Inbox/Outbox、Runtime Command/Projection、Production loader/current/latest resolver/startup/activation、Execution Artifact build/install、Retention/Blob GC/delete、真实Adapter、Feature/API/Automation ingress或legacy alias/fallback/compatibility reader。

### G5 Basic Runtime startup audit: T6e Gate ownership blocker（历史阻塞记录）

**状态**：`BLOCKED_BY_SPEC`。本轮从clean local checkout `main@2904f81592b9bd83f5d837f521f2eb026ce2d439`开始，parent=`945e21283a46accfd175356cd4640805e420199c`；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、创建或切换worktree、Handoff、push、amend或重写历史；全部Node/npm检查均通过`./scripts/runtime-toolchain.sh exec -- <command>`。

该历史启动审计发现当时的current规范无法同时满足。开发期顺序第6步和Gate表要求G5实现`T6a-e`并以`T0-T6e model/fault fixtures`退出；第8步又把T6e与Runtime Command Gateway一起归G7。T6e正文和machine protocol不是可无授权执行的内部primitive：正文要求“只能通过 Runtime Command Gateway执行”，transaction protocol以`authorized_runtime_command`为前置并要求原子写`command_invocation_and_runtime_event`，command protocol把五个Effect/Blocker remediation command绑定T6e。Schema 4进一步要求resolved blocker具有非空`resolution_command_id`并FK到`workflow_runtime_commands`。因此：

- G5不实现Gateway时，不能合法测试或提交任一blocker `open -> resolved`，无法满足T6e exit。
- G5实现最小Gateway/authorization/command audit时，会直接越过明确的G7 Runtime Command Gateway与command surface禁区。
- 伪造command row、接受预授权boolean、test-only直写或让resolution command为空都会放宽authorization/audit/FK不变量，禁止作为临时fallback。

最小复现只读取current authority：

```bash
nl -ba local/docs/dynamic-workflow-dag-framework.md | sed -n '4794,4813p;5408,5417p;5612,5750p;6298,6323p'
jq '.payload.entries[] | select(.transaction_id == "T6e") | {preconditions, atomic_writes}' src/workflow-runtime/contracts/protocols/workflow-run-transaction-protocol-table.json
jq '[.payload.entries[] | select(.transaction_protocol == "T6e") | {command_type,target_kind,permission_rule,allowed_actor_kinds}]' src/workflow-runtime/contracts/protocols/workflow-runtime-command-protocol-table.json
nl -ba src/workflow-runtime/contracts/logical-schema-source.ts | sed -n '2326,2392p;4951,5137p'
```

所需独立前置修复必须明确选择并级联machine authority。与当前G5/G7禁止边界一致的最小方向是：G5只退出`T0-T6d + Operational Blocker open/cache creation semantics`，T6e authorization/remediation/model/fault ownership完整留到G7；同步修改开发期顺序、Gate exit、I9/I10索引、完整验收分期以及任何G5 pack schema/fixture要求。另一方向是把最小Runtime Command Gateway、permission/policy/state guard、Command/Invocation audit正式下沉G5，但这会扩大G5边界，不能由本implementation任务自行选择。修复任务还必须决定G5是否仅验证Schema既有T6e FK/trigger而不生成G5 T6e implementation identity，并证明G0.4/G1 frozen bytes是否保持历史provenance或需要显式reopen。

本轮没有创建G5 Contract Pack、Runtime module、fixture、test或业务DML，也没有实现G6-G9任何surface。只读`contracts:g4:check`与完整`contracts:check`均PASS，确认G4 pack/profile/bootstrap implementation、G1 Schema 4/root、G2 successor seal和G3.9 current identities无漂移；protected trees仍为G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`。

受影响上游回归全部通过：`test:g4` 2 files / 33 tests；`test:g3.9` 2 files / 34 tests；`test:g3` 14 files / 97 tests；`test:g2` 7 files / 47 tests；`golden:current:replay:check` 40/40 exact；`test:g1.activation` 5 passed / 15 skipped；`test:g1.2` 20/20；`test:g0.6` 8/8；`test:g0.10` 10/10；`typecheck`、`build`、`git diff --check`均PASS。Targeted Prettier对`src/workflow-runtime/contracts/README.md` PASS；两份历史中文长文以未修改`HEAD` bytes通过stdin检查时同样返回非零，完整`--write`会重排约1300行既有表格，因此本轮不保留该无关格式churn。G5 generate/check、positive/negative/fault fixtures、T0-T6e targeted/model/property/crash tests不存在且未运行，这是本`BLOCKED_BY_SPEC`结论的直接结果，不能报告为PASS或用skeleton伪造。

### G5/G7 T6e Gate ownership spec/Contract repair（历史候选记录）

**历史候选状态**：`G5_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION`；当时G5 Basic Runtime=`NOT_READY/BLOCKED_BY_OWNERSHIP_REGRESSION`。该轮从clean local checkout `main@88a61ce07f05f4eeabed9c1aaf1719555c1faa18`开始，parent=`2904f81592b9bd83f5d837f521f2eb026ce2d439`；启动环境与最终记录均为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、创建或切换worktree、Handoff、push、amend或重写历史；全部Node/npm命令经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

唯一ownership决策已经同步到实现索引、模块ownership、测试分期、开发顺序第6/8步、Gate exit和完整验收：G5 transaction set exact为`T0/T0p/T1/T2a/T2b/T3a/T3b/T4/T5/T6a/T6b/T6c/T6d`，只拥有Operational Blocker create/open集合与Run/Workflow cache一致性；G7 exact拥有T6e、Runtime Command Gateway、source-specific remediation/integrity restoration、resolution Command/Invocation/Event、last-blocker state restoration、administrative abandon和Recovery。G5不得消费`open -> resolved/abandoned`，不得生成T6e identity、预授权boolean、test-only直写或伪造command audit。

新增current construction authority为`src/workflow-runtime/contracts/governance/workflow-runtime-gate-ownership@1.json`，identity=`sha256:36289416db3c8898d9b50c04c5ad43fc6b74ef53bbd3a3c99f9d5f5b72786fa8`。它绑定transaction protocol=`sha256:7c55b3eff2f29e5dfcbb057d5ff014697ba2e9a421287afa19ec850540cce5f0`、command protocol=`sha256:b12b07b29e9335593c969033c133d221b244798fc079db5fb398b23fbae10789`、logical schema source=`sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214`、G1 root/schema=`sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` / `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a`与Schema Manifest=`sha256:87f6787dd5c6382df97120c2e10dc6624143c67efc35e57cb92ea22f16fa666b`。Checker强制T6e继续要求`authorized_runtime_command`并原子写`command_invocation_and_runtime_event`、五类remediation command继续绑定T6e、resolved blocker继续具有真实`resolution_command_id -> workflow_runtime_commands.command_id` FK与non-null CHECK、两条cache trigger继续存在。该authority不进入G0.4/G1/G4 pack，不改变冻结Runtime/Schema语义，也不授权G5 implementation。

机器fixture为1 positive / 18 negative，覆盖transaction与semantic ownership的missing/duplicate/unknown/cross-Gate、T6e回流G5、G5越权resolution、T6e authorization/audit/command mapping漂移、Schema 4 version/FK/non-null resolution/trigger漂移。Generator连续两轮authority/positive/negative raw bytes分别稳定为`f5fc6daa9049ba81222aadce64323fe6fd6a2a8e409c6e2e6aa79d100a89de8a` / `b17371327de5e740f0a52dd5ed6a138dc4e98edcead2a165c0b319087f36ec49` / `4197e54c118828cbf3a1086e49c2b7068f52d776b545c637d741f4a92d009422`。

最终验证证据：

| 命令/证据 | 结果 |
| --- | --- |
| 两轮managed `contracts:gate-ownership:generate` / `contracts:gate-ownership:check` / `test:gate-ownership` | PASS；authority identity与3个raw bytes连续一致；1 positive + 18 negative全部执行；4/4 tests |
| 两轮managed `contracts:g4:generate` / `contracts:g4:check` / `test:g4` | PASS；pack/profile/isolation继续为`sha256:1136d6d...e3ba` / `sha256:15cbda14...fcf` / `sha256:883f8f2d...9188`，14-member identities连续一致且既有raw-byte digest仍为`8266a7a9...0e47`；2 files / 33 tests；live graph 0 violation |
| managed `contracts:check` | PASS；完整current G0/G1/G2/G3/Schema/Store/G4链及新增ownership checker通过 |
| managed `test:g3.9` / `test:g3` | PASS；2 files / 34 tests；14 files / 97 tests |
| managed `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；G1 root/Schema 4保持冻结；Activation 5 passed / 15 skipped；Store 20/20 |
| managed `test:g2` / `golden:current:replay:check` | PASS；7 files / 47 tests；successor 40/40 exact，bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| managed `test:g0.6` / `test:g0.10` | PASS；8/8与10/10 |
| managed `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS |
| protected-tree / changed-path / forbidden-surface / dependency-direction | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`均零diff；changed paths仅两份规范/进度文档、Contracts README、package scripts、新governance checker/test/fixtures/artifact；无G5-G9 Runtime module、业务DML、Production入口、Adapter/network/user data或逆向Runtime import |

本修复只闭合ownership spec/Contract，不创建G5 pack、Runtime skeleton、Task Intake/Creation/Graph/Scheduler/Ledger/Claim/Wait/Inbox/Outbox/Capacity业务实现或DML，也不实现G6-G9、Runtime Center、Projection、Production loader/activation、真实Adapter/network/user data。冻结`protocol-table-types`、transaction/command artifacts、Logical Schema source、Schema 4 DDL/artifacts/tests和G0-G4 identities均未修改。

### G5 ownership / affected-chain independent regression closure

**结论**：`PASS / G5_OWNERSHIP_REPAIR_DONE`，G5 Basic Runtime=`READY`。本轮从clean local checkout `main@d9119cb2f6d94ff20a89c89c4c2ef6c2d43f71d8`开始，parent=`88a61ce07f05f4eeabed9c1aaf1719555c1faa18`；启动与结束环境均为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、创建或切换worktree、Handoff、sub-agent、push、amend或重写历史；全部Node/npm命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

独立复核确认G5 transaction/semantic ownership exact为T0-T6d与Operational Blocker create/open/cache，G7 exact拥有T6e/Gateway/source-specific remediation/integrity restoration/resolution audit/last-blocker restoration/abandon/Recovery。T6e继续要求`authorized_runtime_command`和原子`command_invocation_and_runtime_event`，五类remediation command mapping不变；Schema 4继续要求resolved blocker的真实non-null`resolution_command_id -> workflow_runtime_commands.command_id`，insert/update cache trigger与open-blocker query不变。Authority只属于current construction governance，不进入G0.4/G1/G4 identity，也不授权G5 implementation。

独立审阅发现一个可在ownership checker/test内闭合的覆盖缺口：原4个测试只从TypeScript常量取得1+18 fixture，且没有直接probe ordered-set重排、missing/extra Gate、excluded semantics、protocol source/generated分叉、resolution CHECK、insert trigger、update-trigger body、真实dependency/fixture artifact drift与package aggregate chain。最小修复保留冻结1+18 fixture和三份artifact raw bytes不变，让测试直接读取落盘fixture执行oracle，并新增5组非artifact audit probes；`test:gate-ownership`现为9/9。没有修改ownership决策、Runtime/Schema/protocol语义或任何G0-G4 identity。

最终机器证据：

| 命令/证据 | 结果 |
| --- | --- |
| 两轮managed `contracts:gate-ownership:generate` / `contracts:gate-ownership:check` / `test:gate-ownership` | PASS；authority=`sha256:36289416db3c8898d9b50c04c5ad43fc6b74ef53bbd3a3c99f9d5f5b72786fa8`；落盘1+18 fixtures全部执行；9/9 tests |
| ownership authority/positive/negative raw bytes | 两轮均为`f5fc6daa9049ba81222aadce64323fe6fd6a2a8e409c6e2e6aa79d100a89de8a` / `b17371327de5e740f0a52dd5ed6a138dc4e98edcead2a165c0b319087f36ec49` / `4197e54c118828cbf3a1086e49c2b7068f52d776b545c637d741f4a92d009422` |
| managed `contracts:generate` continuity / `contracts:check` | PASS；aggregate generate与check均实际接入ownership generator/checker，生成后仅预期checker/test/docs差异 |
| 两轮managed `contracts:g4:generate` / `contracts:g4:check` / 14-member digest / `test:g4` | PASS；pack/profile/isolation=`sha256:1136d6d379b6d821175046449ec58cd7ba72e6ef72441be45d522e2a6a56e3ba` / `sha256:15cbda14e581cbfb499dc8c0f20a297d695da9bd59af4051e9e3b72de97a5fcf` / `sha256:883f8f2d4040fd03ea5a49bd38826ce6c37d5556175219b66f335793087f9188`；两轮digest=`8266a7a963d7f3a5b59cd0e12cfcb150992bf821e8498359bd60a8b8b07a0e47`；33/33，live graph 0 violation |
| managed `test:g3.9` / `test:g3` | PASS；34/34与97/97；G3.9 pack=`sha256:2ef0997982483a6da4c6c6cfd3e26b7934f7fcffce4fdae160f94f4e9d600b38` |
| managed `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；G1 root/Schema=`sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` / `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a`；Activation 5 passed / 15 skipped；Store 20/20 |
| managed `test:g2` / `golden:current:replay:check` | PASS；47/47；successor 40/40 exact，seal=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| managed `test:g0.6` / `test:g0.10` | PASS；8/8与10/10 |
| managed `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS |
| protected-tree / changed-path / dependency-direction / forbidden-surface | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`均零diff；无G5-G9 Runtime module、业务DML、Production入口、compatibility旁路、真实Adapter/network/user data或逆向Runtime import |

Authority artifact仍保存其生成时`G5_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION`、`implementation_authorized=false`与`next_required_gate=independent_ownership_and_affected_chain_regression`事实，三份artifact bytes未为关闭而改写。治理层ownership repair现为`DONE`，只把G5 Basic Runtime提升为`READY`；本任务没有实现G5 pack、T0-T6d Runtime、T6e/Gateway、G6-G9或Production surface。

### G5 Basic Runtime implementation readiness blocker

**结论**：`BLOCKED_BY_SPEC`。本轮从clean local checkout `main@42a785b800b1bc5cf2eda43148d4dea6a091a740`开始，parent=`d9119cb2f6d94ff20a89c89c4c2ef6c2d43f71d8`；启动与结束环境均为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、创建或切换worktree、Handoff、sub-agent、push、amend或重写历史；全部Node/npm命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

施工前完整审计确认原计划的G5-owned surface如下；这些是阻塞前的完整工作包，不是已创建的skeleton或可拆分交付：

| 类别 | 原计划G5 exact scope |
| --- | --- |
| Modules | `creation/recipe-registry.ts`、`creation/task-intake.ts`、`creation/routing-resolver.ts`、`creation/domain-claims.ts`、`store/graph-store.ts`、`runtime/ledger.ts`、`runtime/reconciler.ts`、`runtime/node-execution.ts`、`runtime/waits.ts`、`runtime/outbox.ts`、`runtime/operational-blockers.ts`、`runtime/capacity-admin.ts`、`runtime/capacity-publication.ts`及G5-owned `runtime/graph-runtime.ts` lifecycle/activation/scheduling slice；明确不创建`runtime/commands.ts`、`runtime/child-runtime.ts`、`runtime/root-finalizer.ts`或projection/Production surface |
| Contract members | closed G5 pack、protocol/schema bindings、typed Task/Creation/Launch/Activation/Manifest/Fact/Event/Attempt/Wait/Effect/Inbox/Outbox/Claim/Ledger/Capacity/Blocker records、deterministic generator/checker、positive/negative/fault fixtures、implementation/source inventory与identity；exact绑定ownership authority `sha256:36289416db3c8898d9b50c04c5ad43fc6b74ef53bbd3a3c99f9d5f5b72786fa8`，不重定义Gate集合 |
| Transaction boundary | 唯一writer为`WorkflowRuntimeStore.withImmediateTransaction()`；T0/T0p/T1/T2a-CAS/T2b/T3a/T3b/T4/T5/T6a/T6b/T6c/T6d各自为短同步`BEGIN IMMEDIATE`，compile、Adapter/tool/file/network与其他external work全部在transaction外；每一边界要求CAS/fence/idempotency、commit前rollback及commit后reopen/replay证据 |
| Model/property/fault | 固定fixture + `fast-check` property + 不调用Production Reconciler的独立reference model三类并存；覆盖static delegation/system/wait/join/terminal、Fact/Event fixed point、claim/ledger/admission、receipt unknown/lost、late callback、wait race、retry/deadline、quality continuation/exhaustion、open blocker/cache，以及T0-T6d每个commit前后crash、same-key duplicate/conflict、stale lease/work epoch/hash/schema/tamper |
| Regression impact | G5 direct generate/check/tests后必须运行ownership、G4 isolation、contracts aggregate、G3.9/G3、Schema/Store/G1、G2/replay、G0.6/G0.10、typecheck/build、protected-tree/dependency/forbidden-surface/temporary-root审计；G5退出原计划只能为`EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_REGRESSION` |
| 禁区 | T6e open-to-resolved/abandoned、Runtime Command Gateway、预授权boolean或伪造Command/Invocation/Event、G6 subgraph/expand/map/T7/T8/child/compensation、G7 control/Card/Projection/Recovery、G8 certification、G9 Production activation/loader/ingress、真实Adapter/network/user data，以及修改冻结G0.10/G2/G3.8A/G1 Schema树 |

最小机器复现位于`src/workflow-runtime/contracts/g5-runtime-readiness-audit.test.ts`，由managed `npm run test:g5:readiness`执行。它直接读取冻结artifact并证明：

1. ownership authority把`T6d`精确归G5，同时把`runtime_command_gateway`精确排除出G5并归G7。
2. T6d `durable_deadline_and_retry_timers`要求原子写`stable_workflow_deadline_t7c_command`，以`stable_workflow_deadline_command_key`幂等，并定义`late_deadline_command`。
3. `cancel_workflow` command映射T7c，Deadline Watchdog只能使用`deadline_enforced/safety_enforced + due_target + cancel_workflow_only`的System Grant；T7c前置条件是`authorized_cancel_command`且原子写`command_invocation_audit`。
4. `advance_retry_schedule`也属于Gateway command union并映射T6d；query catalog把deadline due scan交给`workflow_watchdog`，把command idempotency lookup交给`command_gateway`。
5. Schema 4只有`workflow_runtime_commands`与`workflow_runtime_command_invocations`承载该路径，没有独立的deadline handoff/intent/watchdog relation。G5若直接写command即实现或模拟被禁止的Gateway/audit authority；若不写则无法满足T6d；若省略workflow deadline则无法关闭exact G5 Gate。

因此本轮没有创建G5 pack、Runtime module、业务DML、fixture corpus或partial T0-T6d实现，也没有测试T6e成功路径。必须由独立上游repair选择并机器化以下一种方案，不能由implementation自行推断：新增G5-owned durable deadline-handoff relation/protocol并显式reopen G1 Schema；或把严格限于System deadline submission/audit的最小command slice正式转移给G5且同步ownership/permission/protocol/schema binding；或拆分T6d与G5 exit，使Gateway-bound deadline command延后到拥有Gateway的Gate。repair须级联更新架构索引、transaction/command/query/schema Contract、ownership authority/checker/fixtures、Gate exit与测试分期，并重新执行受影响全链回归。

本轮实测证据：

| 命令/证据 | 结果 |
| --- | --- |
| managed `test:g5:readiness` | PASS；2/2，直接验证T6d/T7c/Gateway/query/Schema 4最小冲突，不执行Gateway或T6e |
| 两轮managed `contracts:g4:generate` + `contracts:g4:check` / `test:g4` | PASS；pack/profile/bootstrap implementation=`sha256:1136d6d379b6d821175046449ec58cd7ba72e6ef72441be45d522e2a6a56e3ba` / `sha256:15cbda14e581cbfb499dc8c0f20a297d695da9bd59af4051e9e3b72de97a5fcf` / `sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad`连续稳定；既有14-member digest=`8266a7a963d7f3a5b59cd0e12cfcb150992bf821e8498359bd60a8b8b07a0e47`且生成后零artifact diff；33/33，live isolation 0 violation |
| managed `contracts:gate-ownership:check` / `test:gate-ownership` | PASS；authority=`sha256:36289416db3c8898d9b50c04c5ad43fc6b74ef53bbd3a3c99f9d5f5b72786fa8`；9/9 |
| managed `contracts:check` | PASS；完整current G0/G1/G2/G3/Schema/Store/G4/ownership链通过 |
| managed `test:g3.9` / `test:g3` | PASS；34/34与97/97；G3.9 pack=`sha256:2ef0997982483a6da4c6c6cfd3e26b7934f7fcffce4fdae160f94f4e9d600b38` |
| managed `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；G1 root/Schema=`sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` / `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a`；Activation 5 passed / 15 skipped；Store 20/20 |
| managed `test:g2` / `golden:current:replay:check` | PASS；47/47；successor 40/40 exact，seal=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| managed `test:g0.6` / `test:g0.10` | PASS；8/8与10/10 |
| managed `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS |
| protected-tree / changed-path / dependency-direction / forbidden-surface / temporary-root | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`均零diff；changed paths只含三份文档、package script和readiness test；无G5 Runtime/业务DML/T6e/G6-G9/Production surface，G4 temporary roots为0 |
| G5 generate/check、G5 positive/negative/fault corpus、T0-T6d target/reference-model/property/crash tests | **未运行/不存在**；规范冲突发生在任何G5 Contract或Runtime施工之前，不能以partial pack、空测试或skeleton伪造G5 identity与Gate PASS |

### T6d / Runtime Command ownership Contract repair candidate

**状态**：`T6D_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION`；G5 Basic Runtime=`NOT_READY`，G6-G9=`NOT_READY`。本轮从clean local checkout `main@627d0bc483a971f0d5bdbd59c7fb40c994f90097`开始，parent=`42a785b800b1bc5cf2eda43148d4dea6a091a740`；启动与最终记录环境均为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有申请approval/escalation、创建或切换worktree、Handoff、sub-agent、push、amend或重写历史；全部Node/npm生成、检查、测试、typecheck、build和Prettier均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

本repair选择既定的split ownership语义。G5-owned T6d改为`attempt_watchdog_and_retry_timers`，只拥有automatic attempt dispatch/execution watchdog、execution retry、quality revision durable timer与既有retry-schedule consumption primitive；exact automatic writes为`attempt_timeout_fence_and_fact`、`cancel_reconcile_or_compensation_effects`、`schedule_consumed_and_exact_next_attempt`、`node_retry_wait_to_active`。T6d不得包含`workflow_deadline_current_run`、`stable_workflow_deadline_t7c_command`、`stable_workflow_deadline_command_key`、`late_deadline_command`，不得创建Runtime Command或写Command/Invocation audit，也不得让manual retry绕过G7 authorization。

Workflow deadline完整留在G7：Deadline Watchdog消费`query:workflow_deadline_due`，Runtime Command Gateway消费`query:command_idempotency_lookup`，使用`system:deadline-watchdog`、`deadline_enforced | safety_enforced + due_target + cancel_workflow_only`专用System Grant和稳定key `workflow-deadline:<workflow_id>:<deadline_at_ms>`提交既有`cancel_workflow -> T7c`。T7c继续要求`authorized_cancel_command`并原子写`command_invocation_audit`；duplicate返回canonical结果并追加Invocation，late只审计且不覆盖winning close。`advance_retry_schedule -> T6d`继续存在，但machine Contract要求未来G7 Gateway先完成permission/policy/state guard与Command/Invocation audit，再调用G5 primitive；G5 model/fault只能覆盖automatic timer与“无G7 authorization不可调用manual path”的negative evidence。

Current authority `src/workflow-runtime/contracts/governance/workflow-runtime-gate-ownership@1.json`为`sha256:0d1e0ffda6f17c637616192e3ddcbf51af55207cd011672317b3a7eb231c5e8e`，执行4 positive / 40 negative fixtures，positive/negative fixture identities为`sha256:bf524f00778d1c2ea1299f3dd135f87cf8a5e57c057fb43d662d958b312cd40c` / `sha256:eff355a591d065fa4c42b59c7d8d60c347c8c36c65a3dbbff5ab9bb29380c3db`。Checker绑定source/generated一致、closed field set、fixture oracle、artifact raw bytes、10-member affected-current-root inventory与tree digest `sha256:2efe85fb51757cfa9d4cbe59ec4dfcc02b6c0c95ed1b56638935e11657950b28`；T6d重新引入deadline、G5拥有Gateway/Command audit、T7c丢失System Grant/due target/stable key/Invocation audit、manual retry绕过G7、unknown/duplicate/cross-gate或Schema drift均fail closed。

真实identity级联如下；左侧值保留为`627d0bc`历史provenance，不伪造成未改变：

| Authority | `627d0bc` identity | repair candidate identity | 原因 |
| --- | --- | --- | --- |
| Run transaction protocol | `sha256:7c55b3eff2f29e5dfcbb057d5ff014697ba2e9a421287afa19ec850540cce5f0` | `sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79` | T6d/T7c source与generated语义修复 |
| Runtime Command protocol | `sha256:b12b07b29e9335593c969033c133d221b244798fc079db5fb398b23fbae10789` | `sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba` | deadline System Grant/stable key与manual retry handoff闭合 |
| G0.4 catalog/protocol pack | `sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607` | `sha256:a648dc9326255b109690cb47d58032775825ae065caf8f7cbb0ef73efcf984f7` | 直接绑定transaction/command artifacts |
| safety matrix / G0.5 pack | `sha256:fcd51e0f36865f34dcd03641754116db872d791c4d9362110a7a1548e76a545d` / `sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428` | `sha256:9143ae6f043c6bc9389af848604070e4cfad6dcea8d293256cb802b01439bc3a` / `sha256:4f756c9427a9e5fd8f034c2abdab3c614b675af8b8bbb350fc4219917159cd8d` | deadline enforcement owner从T6d移至G7 Gateway/T7c |
| static absence pack | `sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2` | `sha256:dc7b987416c3c1baed5a5a666960bfd2411a3e3bf76d173bd8ab0a550e51b21a` | exact current G0.4/G0.5/tool-source bindings |
| G3.6 / G3.7 / G3.9 packs | `sha256:730daac9db4bcfb645374b12e10e3962ddacbebc2828875cb00133c8ada195a8` / `sha256:2fae2da648d6da5969e6c5c57b2342f6f15b3084b39e7acfc43b010b48517e74` / `sha256:2ef0997982483a6da4c6c6cfd3e26b7934f7fcffce4fdae160f94f4e9d600b38` | `sha256:8cfd7b030e5a1953578410caa349b62f3c38131859e9be5a3ada1bfe4e249e2c` / `sha256:4fc65c77265c226b7abcb6f17aeaab3af3e7f7e13d5117705cb3872f3dce6933` / `sha256:f5ddf7eb07b4f54431e612f5f6bbaf9df87d7ed6672f4a400b05fc53c7067f4e` | G3.6 exact Run Protocol后依次级联；业务语义不变 |
| G4 pack / profile | `sha256:1136d6d379b6d821175046449ec58cd7ba72e6ef72441be45d522e2a6a56e3ba` / `sha256:15cbda14e581cbfb499dc8c0f20a297d695da9bd59af4051e9e3b72de97a5fcf` | `sha256:fec4f3fa5ee3cee253606ce75d079ffc3a7a77132edc32bb9bbdd3d7f5de6ed3` / `sha256:1797a52cb6bcee6d53734f038098ce651e895013cd2a296fd3666c4b72f79d80` | exact current G3 identities；14-member digest `8266a7a9...0e47 -> abb4117ddea6fe8f13f012e4f4c578891b929ec5b215a92ef85e2b684c9aa4b5` |
| construction ownership authority | `sha256:36289416db3c8898d9b50c04c5ad43fc6b74ef53bbd3a3c99f9d5f5b72786fa8` | `sha256:0d1e0ffda6f17c637616192e3ddcbf51af55207cd011672317b3a7eb231c5e8e` | 显式reopen T6d/T7c ownership与affected-root evidence |

无关或受保护authority不级联：G1 root/schema/manifest继续为`sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` / `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a` / `sha256:87f6787dd5c6382df97120c2e10dc6624143c67efc35e57cb92ea22f16fa666b`；G2 seal=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`；G3.8A=`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`；G4 isolation=`sha256:883f8f2d4040fd03ea5a49bd38826ce6c37d5556175219b66f335793087f9188`，bootstrap implementation=`sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad`。Database Schema 4、DDL、Manifest逐字节不变，没有新增deadline handoff relation，也没有放宽G5对`workflow_runtime_commands`/`workflow_runtime_command_invocations`的写权限。

本轮实测证据：

| 命令/证据 | 结果 |
| --- | --- |
| 两轮managed `contracts:gate-ownership:generate` / `check`、all-member raw bytes/tree digest、`test:gate-ownership` | PASS；authority两轮均=`sha256:0d1e0ffd...c5e8e`，10 affected members及3份ownership artifacts逐字节一致，tree digest=`sha256:2efe85fb...50b28`；9/9，全部4 positive / 40 negative oracle执行 |
| managed `test:g5:readiness` | PASS；3/3，从blocker复现转换为T6d无Gateway atomic write、T7c closed deadline command path、Schema 4无需新handoff relation的ready Contract shape |
| targeted catalog/safety/logical-schema/static conformance | PASS；4 files / 42 tests；source/generated、closed fields、query/safety owner与artifact continuity通过 |
| managed aggregate `contracts:generate` / `contracts:check` | PASS；generate前后完整diff digest一致；current G0/G1/G2/G3/Schema/Store/G4/ownership链全部通过 |
| 两轮managed `contracts:g4:generate` / `check`、14-member raw-byte digest、`test:g4` | PASS；pack/profile/isolation=`sha256:fec4f3fa...e6ed3` / `sha256:1797a52c...9d80` / `sha256:883f8f2d...9188`；两轮digest=`abb4117ddea6fe8f13f012e4f4c578891b929ec5b215a92ef85e2b684c9aa4b5`；33/33，live isolation 0 violation |
| managed `test:g3.7` / `test:g3.9` / `test:g3` | PASS；14/14、34/34、97/97；affected-chain regression修正唯一旧G3.7 current-hash断言，不改业务实现 |
| managed `schema:generate` / `schema:check` / `store:check` / `test:g1.activation` / `test:g1.2` | PASS；schema tree diff digest为空SHA-256，G1 identities不变；Activation 5 passed / 15 skipped；Store 20/20 |
| managed `test:g2` / `golden:current:replay:check` | PASS；47/47；successor 40/40 exact，seal不变 |
| managed `test:g0.6` / `test:g0.10` | PASS；8/8与10/10；G0.10 current test机器化历史G0.9 checker在reopened G0.4 identity处先fail-closed，protected G0.10 artifact不变 |
| managed `typecheck` / `build` / targeted Prettier / `git diff --check` | PASS |
| protected-tree / changed-path / dependency-direction / forbidden-surface / temporary-root | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`均零diff；changed paths仅Contracts/fixtures/tests与三份文档；无G5 Runtime、业务DML、Gateway、T6e implementation、G6-G9、Production入口、compatibility fallback、运行期`.git`读取或临时root残留 |

Authority payload保留`implementation_authorized=false`与`next_required_gate=independent_t6d_ownership_and_affected_chain_regression`。本轮只形成Contract repair candidate，不创建G5 pack、Runtime module、partial skeleton或Command row，不把候选误记为G5 Gate PASS。

### T6d ownership / affected-chain independent regression

**结论**：`PASS / T6D_OWNERSHIP_REPAIR_DONE`，G5 Basic Runtime=`READY`但不是`DONE`，G6-G9继续`NOT_READY`。本轮从clean local `main@fde5c2f82f5153195614007d66cb42984385d768`开始，并完整复核parent `627d0bc483a971f0d5bdbd59c7fb40c994f90097`与candidate提交；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有创建或切换worktree、Handoff、sub-agent、approval/escalation、push、amend或重写历史；全部Node/npm命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

独立复核确认T6d exact只拥有automatic attempt dispatch/execution watchdog、execution retry/quality revision timer及retry-schedule consumption primitive，且四项automatic atomic writes不变。T6d不创建Runtime Command、不写Command/Invocation audit；workflow deadline exact归`G7 Deadline Watchdog -> Runtime Command Gateway -> cancel_workflow -> T7c`，domain=`system:deadline-watchdog`，stable key=`workflow-deadline:<workflow_id>:<deadline_at_ms>`。`advance_retry_schedule -> T6d`仍是G5 primitive，但未来G7必须先授权并审计。Schema 4未增加deadline handoff relation，G1 root/schema/manifest与既有Command/Invocation relations逐字节不变。

完整G0首次运行暴露并修复两个affected-chain测试缺口：G0.8仍冻结旧G0.4/G0.5/static identities，以及foundation import boundary遗漏既有exact G4 construction checker到G1 frozen Store profile的依赖。修复只更新测试pin与该exact construction allowlist，不改任何Contract artifact、G1 Schema、G2 seal、G3.8A、G0.10、Runtime业务代码或Production surface；修复后全部affected chain从readiness起完整重跑。

| 独立证据 | 结果 |
| --- | --- |
| 两轮managed ownership generate/check、独立JCS/raw/tree复算、`test:gate-ownership`、`test:g5:readiness` | PASS；authority=`sha256:0d1e0ffda6f17c637616192e3ddcbf51af55207cd011672317b3a7eb231c5e8e`；3份ownership artifact、10 affected members、tree=`sha256:2efe85fb51757cfa9d4cbe59ec4dfcc02b6c0c95ed1b56638935e11657950b28`稳定；4 positive / 40 negative，9/9与3/3 |
| affected catalog/safety/logical-schema/static + aggregate `contracts:generate/check` | PASS；7/7、9/9、8/8、18/18；G0.4/G0.5/static=`sha256:a648dc93...5915` / `sha256:4f756c94...cd8d` / `sha256:dc7b9874...1b21`，完整current aggregate通过且生成零artifact drift |
| 两轮G4 generate/check、独立14-member digest、完整G4/live isolation | PASS；pack/profile/isolation=`sha256:fec4f3fa...e6ed3` / `sha256:1797a52c...9d80` / `sha256:883f8f2d...9188`；两轮digest=`abb4117ddea6fe8f13f012e4f4c578891b929ec5b215a92ef85e2b684c9aa4b5`；33/33；277 source / 38 production roots / 9 authority / 4 bootstrap / 0 violation |
| G3.7 / G3.9 / whole G3 | PASS；14/14、34/34、97/97；G3.6/G3.7/G3.9=`sha256:8cfd7b03...49e2c` / `sha256:4fc65c77...e6933` / `sha256:f5ddf7eb...067f4e` |
| G1 Schema/Store、G2/replay、G0.10/whole G0 | PASS；G1 Schema 20/20、Activation 5 passed / 15 skipped、Store 20/20；G2 47/47、replay 40/40；G0.10 10/10、whole G0 15 files / 109 tests |
| protected trees / Schema 4 / forbidden surface | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`零diff；无deadline handoff table、G5/G6/G7业务实现、Gateway/T6e或Production入口 |
| typecheck / build / formatting / diff | managed `typecheck`与`build` PASS；本任务TypeScript文件targeted Prettier与`git diff --check` PASS。仓库级`format:check`仍报告起点已有的48个无关文件，不包含本任务改动，未批量改写范围外源码 |

Candidate authority继续原样保存生成时`T6D_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION`、`implementation_authorized=false`与`next_required_gate=independent_t6d_ownership_and_affected_chain_regression`，不能为了关闭治理步骤伪造重写。治理层T6d ownership repair现为`DONE`，只把G5施工状态恢复为`READY`；本轮没有创建G5 Contract Pack、Runtime module、Command row、业务DML、Gateway/T6e、G6-G9或Production surface。

### G5 Basic Runtime implementation startup blocker: Capacity Admin allowed Invocation

**结论**：`BLOCKED_BY_SPEC`；G5 Basic Runtime=`BLOCKED_BY_SPEC`，G6-G9继续`NOT_READY`。本轮从clean local `main@1ce8a764622076749b0884e34ab936e57788e7ad`开始；启动环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有创建或切换worktree、Handoff、sub-agent、approval/escalation、push、amend或重写历史；全部Node/npm命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

完整G5必须交付Scheduler、Wait/Signal、Inbox/Outbox、Ledger/Admission并消费一个Watcher-published immutable Capacity pointer；规范开发顺序第6步明确规定这些组件开始消费Live Capacity前必须实现独立Capacity Admin Gateway、唯一Publisher、CAP recovery和Admission revision/change/hash lineage。因此不能通过固定capacity、内存pointer、test-only seed或跳过Capacity Admin把T0-T6d partial slice标成G5完成。

施工前的machine/DDL联读发现当前CAP1与冻结Schema 4没有共同可执行状态：

1. current Capacity protocol `CAP1 Prepare`要求同一个`BEGIN IMMEDIATE`原子写`Command Header and allowed Invocation`、pending head与`prepared` hash-chain Event，然后才由事务外CAP2安装文件、CAP3提交head、CAP4发布Watcher pointer并finalize canonical Command result。
2. `runtime_capacity_admin_invocations.execution_result`的closed enum只有`applied | denied | conflict | duplicate | failed`。`ck:capacity_invocations:result_consistency`要求allowed+applied已经具有非空`applied_at_ms`；allowed且`applied_at_ms IS NULL`只能声称`conflict | duplicate | failed`。不存在`pending/prepared`。
3. CAP2-CAP4的atomic writes没有Invocation update/finalize动作；CAP4只finalize canonical Command result。把CAP1 Invocation暂写`failed`、提前写`applied`，或CAP4原地改写结果都会伪造审计或新增未授权事务语义。
4. 该冲突无法在G5范围内修复：Capacity protocol/closed union属于受保护G0.10 affected tree，Invocation物理shape属于冻结G1 Schema 4。按本任务边界不得自行reopen或重建这两棵authority。

最小机器复现为`src/workflow-runtime/contracts/g5-capacity-runtime-readiness-audit.test.ts`，由managed `npm run test:g5:blocker`与扩展后的`test:g5:readiness`执行。它直接绑定current CAP1-CAP4 artifact与Schema Manifest，证明CAP1写入时序、closed result enum/result CHECK以及后续无Invocation transition；不实现Capacity Admin、不打开Runtime Store、不写任何业务行。

本轮曾在发现阻塞前本地起草Runtime文件，但已全部删除且未进入最终diff。current checkout不包含G5 pack、production Runtime、Task Intake、Graph Store、Scheduler、Reconciler、Ledger、Adapter、Inbox/Outbox、Operational Blocker DML、Gateway、T6e、G6-G9或Production入口。G5保持真实`BLOCKED_BY_SPEC`，不能标记`DONE`，G6不能提升为`READY`。

下一独立前置必须显式选择并全链修复一种machine语义：为Capacity Invocation增加真实`pending/prepared` lifecycle并reopen G0.10/G1 Schema；或把allowed Invocation的创建正式移动到CAP4，同时为CAP1授权/恢复定义另一种durable audit authority；或增加独立prepare authorization journal。任一方案都必须同步架构正文、Capacity protocol/fixtures/model、Logical Schema、Executable DDL/Manifest/Store、affected G0-G4 identities和完整回归，不能由G5 implementation自行推断。

| 阻塞审计证据 | 结果 |
| --- | --- |
| managed `test:g5:blocker` / `test:g5:readiness` | PASS；2/2与5/5；直接绑定current CAP1-CAP4 artifact、Schema 4 Manifest closed execution result与CAP2-CAP4 write set，不打开Store或写业务行 |
| 两轮managed `contracts:generate` / `contracts:check` | PASS；两轮生成bytes稳定且零额外artifact drift；ownership=`sha256:0d1e0ffda6f17c637616192e3ddcbf51af55207cd011672317b3a7eb231c5e8e`，transaction/command=`sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79` / `sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba`，affected-root=`sha256:2efe85fb51757cfa9d4cbe59ec4dfcc02b6c0c95ed1b56638935e11657950b28` |
| managed ownership / Schema / Store checks | PASS；`contracts:gate-ownership:check`、`test:gate-ownership` 9/9、Schema 4与Store check；Schema/root=`sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a` / `sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` |
| G4 generation identity / complete live isolation | PASS；pack/profile/isolation=`sha256:fec4f3fa5ee3cee253606ce75d079ffc3a7a77132edc32bb9bbdd3d7f5de6ed3` / `sha256:1797a52cb6bcee6d53734f038098ce651e895013cd2a296fd3666c4b72f79d80` / `sha256:883f8f2d4040fd03ea5a49bd38826ce6c37d5556175219b66f335793087f9188`；独立14-member raw-byte digest=`abb4117ddea6fe8f13f012e4f4c578891b929ec5b215a92ef85e2b684c9aa4b5`；33/33，live isolation 0 violation |
| affected G0 / G1 / G2 / G3 regressions | PASS；G0 15 files / 109 tests；G1 Schema 20/20、Store 20/20；G2 47/47、current replay 40/40；G3 whole 97/97，G3.7 14/14，G3.9 34/34 |
| managed `typecheck` / `build` / formatting / `git diff --check` | PASS；new blocker test targeted Prettier通过；全局`format:check`仍只报告进度账本已登记的48个起点baseline debt，失败列表不含本任务文件；diff check通过 |
| protected tree / changed path / forbidden surface | PASS；G0.10=`2bf94fb4ec0142bcb5348168525f67b348cedda4`、G2 sealed=`cf9270f9ec71fa2134de0987b5fe55b5425e399b`、G3.8A=`a358e690e90294f0ad08ec47992ff9f645df7e6f`、G1 Schema=`161d6041bc56368bc3fd821a37f5a6a58a8eea1b`相对起点零diff；changed paths只含两份文档、Contract README、package scripts与blocker test；无G5 Runtime/DML、Capacity implementation、Gateway/T6e、G6-G9或Production入口 |
| G5 Contract pack、fixtures、production implementation、reference/model/property/fault与T0-T6d专项测试 | **未创建/未运行**；CAP1/Schema冲突发生在可执行G5 Contract与Runtime施工之前，按退出规则不得以partial pack、mock、空fixture或skeleton形成identity或Gate PASS |

### Capacity Admin CAP1 Invocation Contract / Schema repair candidate

**结论**：`CAPACITY_CONTRACT_SCHEMA_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION`；G5 Basic Runtime=`NOT_READY/BLOCKED`，G6-G9继续`NOT_READY`。本轮从clean local `main@2cecf11854ea82e8a908547344626c2cb2b4eab5`开始，parent=`1ce8a764622076749b0884e34ab936e57788e7ad`；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有创建或切换worktree、Handoff、sub-agent、approval/escalation、push、amend或重写历史；全部Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

修复选择唯一的immutable prepared lifecycle。首个authenticated、authorized且通过CAP1的Invocation固定为`invocation_no=1`、`authorization_result=allowed`、`execution_result=prepared`、`decided_at_ms=CAP1 txn now`、`applied_at_ms=null`，并与exact Command request、pending head和`prepared` Event在同一个`BEGIN IMMEDIATE`提交。该Invocation以后禁止UPDATE/DELETE；CAP2-CAP4没有Invocation transition，CAP4只追加`watcher_published` Event并finalize Command canonical result。CAP4完成后的same-request retry追加新的`duplicate` Invocation并返回canonical result；CAP4前的recovery继续唯一publication，不伪造duplicate。`prepared`不能用于denied/conflict/failed/duplicate、未认证、未授权、非初始Invocation或已terminal Command。

历史Database Schema 4 migration、SQLite identity及Schema 3到4 upgrade保持逐字节不变。Current Database Schema 5在fresh migration中增加三个INSERT guard：`trg:capacity_invocations:prepared_insert`要求上述CAP1唯一组合，`trg:capacity_invocations:applied_insert`拒绝Schema 5新写Capacity `applied`，`trg:capacity_invocations:duplicate_insert`要求exact request与已finalized Command。Schema 4到5 upgrade先在旧约束下复制全部既有数据，再安装Schema 5 guard，因此历史合法`applied`审计可保留但不能在Schema 5新建；任一source identity、CHECK/FK/UK/index/trigger、copy、foreign-key/integrity或commit fault均全事务回滚。Store create/open/reopen只接受closed current identity，upgrade不丢Command/Invocation/Event/head或Activation/Registry数据。

Current与历史identity级联如下；历史值保留为`2cecf118` provenance，不伪造成未改变：

| Authority | historical Schema 4 / pre-repair | repair candidate current |
| --- | --- | --- |
| G0.10 Capacity root | `sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec` | `sha256:12f9fdfe9739b767440b56b0e55fedb431b27c546326da90285e96e1fc2ea15c` |
| Capacity Logical artifact / delta | `sha256:5d9e79b5f9330a5111e6f61b8d04164c87839a60d55ea350c0aa87b8b1559e66` / `sha256:e8917c737b1eae0f62abfa2de2dec6dc71875122a763882a46aee34c5c84cae6` | `sha256:8160dea544586e02b3429dcc1bb044a40a330cb69920c4d1d2231fbed28866c5` / `sha256:749bdfe16195a1762427aed9d98ff8e7d9c2633d22b6d8e3d31bf9aeaf9d589c` |
| G1 root / Schema | `sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591` / `sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a` | `sha256:f49781e161e00815e08841b2bc3b2b09ee83d60476220c398c9c0824ee4bcfa9` / `sha256:adfcd0462b50991cceb9497412f8af4e0271f6769a9d810ff9e4d58011952cf1` |
| dependency manifest / physical identity | `sha256:8ed4d092c0822fe06b154117d3fc2d6d74c9041644b0883ab2e978c4a2abe35d` / `sha256:61ca572ff0f8551ff67f5529753610012fd6027a484e77cc8e63716f4814e04f` | `sha256:8acbfe7b71e43ccb6b093d1c72f973ed27c54a8f04b03e8a8dc4fdc858de5d6e` / `sha256:20006150a0be02a34a636a238fe706e96d3da3b9808911f4475224e93fae7933` |
| fresh migration / SQLite identity | Schema 4 `sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43` / `sha256:e46f58e49b42ad53e3d744de86b6d8fb6299236258459c35d9ca3affa440932c` | Schema 5 `sha256:11e69e3d82c3963c3eac7d75be67ac16575e43685fdd8e5b392e97152f734e9b` / `sha256:c771e311172974b6b1c43e5fce8db35bca84ef4c3af9392d37efff2c4aa0dd47` |
| upgrade / Manifest artifact | Schema 3到4 `sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf` / Schema 4 Manifest `sha256:87f6787dd5c6382df97120c2e10dc6624143c67efc35e57cb92ea22f16fa666b` | Schema 4到5 `sha256:b443b201131cc1a26bd2401b784f7b4672c5f80828e6df31c23fb518c93e59e1` / Schema 5 Manifest `sha256:6ce20c518c13a47bb50f9f884f5faec506b2e50100a92ec3d3eb84f2649147e4` |
| G3.1 / G3.3 / G3.5 | `sha256:152fc9bd4ecbc4fb5a395d06698c81142befa294466ffbd665cfb2a9b874c71d` / `sha256:839338a8d2bccfbacd8fd395640f4c79ce31a35d1ec5421bc752a98961514fc2` / `sha256:74cb66b4e2c3d244a45de70c9f236df112c83fabf1f8230afbd046394c8d0b49` | `sha256:de020bca9ffb54ac8cf7e8fd9166d1a26eef5d2b7fa79427c4fe47755f22caa3` / `sha256:f14adf777d92cbaf00275e5ad77b04746c1c9a42848d29cad0786d33a54cf52c` / `sha256:d38bdd8578efa8d1e4e8b7c6c9e4384d3b764b0cee18fe7f1d951752fad63cac` |
| G3.6 / G3.7 / G3.9 | `sha256:8cfd7b030e5a1953578410caa349b62f3c38131859e9be5a3ada1bfe4e249e2c` / `sha256:4fc65c77265c226b7abcb6f17aeaab3af3e7f7e13d5117705cb3872f3dce6933` / `sha256:f5ddf7eb07b4f54431e612f5f6bbaf9df87d7ed6672f4a400b05fc53c7067f4e` | `sha256:03131d78800718ac1bd326f932e33ca677d9ac617ff00fc090fc7aaefedd85a9` / `sha256:8a67b2516d46da89524045297b261e32305d0803546089048b19d70384e23282` / `sha256:7c192a3a4dd10004c2a7bf6da2cf81a38d5745e145717796f86acfc2025fdf91` |
| G4 pack / profile / implementation | `sha256:fec4f3fa5ee3cee253606ce75d079ffc3a7a77132edc32bb9bbdd3d7f5de6ed3` / `sha256:1797a52cb6bcee6d53734f038098ce651e895013cd2a296fd3666c4b72f79d80` / `sha256:a8bea5690d9e0e66ba93cec4ebb5e8a5d471ed160ecb6371effd6cbe18bf56ad` | `sha256:d55623b512d154018c78adadeaa66ae092db61f8efb1a2caeb1ae5f218fe5539` / `sha256:b79c3fbc1fb612a28e975805ab55e65c7bdbeb2fc17df4dd6fbd583334a0e2a6` / `sha256:28a920856d26325ec14c976a9e1da668c1302e06fd3e2e05abb890dff830f018` |
| construction ownership authority / affected tree | `sha256:0d1e0ffda6f17c637616192e3ddcbf51af55207cd011672317b3a7eb231c5e8e` / `sha256:2efe85fb51757cfa9d4cbe59ec4dfcc02b6c0c95ed1b56638935e11657950b28` | `sha256:4e973c234ddd2c37079b32f33df7780da0b8cbdda3f5eba091d314c7947ef2a8` / `sha256:c1e1ff5d27410c497cf614458b7bb273e3aedaa9af879d7dd75423674219ccb5` |

Capacity protocol semantic artifact保持`sha256:0e06b38b98bfd2193dbad24297e75b1422fdcc8f11e297835c87d4baf03aea9b`，但closed logical lifecycle、fixture/inventory/review/root按真实语义重建为9 positive / 31 negative / 14 fault。G2 Compiler/Golden与G3.8A不消费Capacity lifecycle：相对`2cecf118`的compiler、candidate/draft/golden/review/sealed trees及G3.8A source/artifacts保持零diff；没有生成approval或seal。

专项与完整affected-chain candidate验收全部通过；这只形成独立回归输入，不能在同一任务把G5标成`READY/DONE`：

| Candidate证据 | 结果 |
| --- | --- |
| 两轮post-format managed Capacity/G1/G3/G4/ownership generators | PASS；按固定9-command顺序两轮全部current identities一致；完整binary diff SHA-256两轮=`60582c7659a2d05a2e636786b536e161e4a1cad10d30c8d5f47c8e6e6e7ac103`，受影响artifact tree两轮=`2a4ab4067c7789c95ef4bae82f2bcf4e3722fdb7ef7542d48b5dbf3f0905737d`，生成后零额外drift |
| `contracts:capacity-repair:check` / `test:g1.capacity` | PASS；Capacity Contract与Schema check闭合；4 files / 56 tests（Capacity 10、Schema 20、Store 23、G5 blocker 3） |
| Schema fresh/upgrade/constraints/Store | PASS；G1.1 23/23、G1.2 23/23、`store:check`；Schema 5为84 tables / 1462 columns / 153 UK / 389 FK / 951 CHECK / 44 indexes / 46 triggers；fresh/reopen、empty Schema 3经4到5、nonempty Schema 4到5保留数据、identity/copy/constraint/fault rollback全部通过 |
| aggregate Contract / G0 | PASS；`contracts:generate/check`完整current chain且aggregate generate后G2/G3.8A仍为0 changed file；G0.10 10/10，whole G0 15 files / 109 tests |
| G3.8A / G3.9 / whole G3 | PASS；G3.8A frozen check保持`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`；G3.9 34/34；whole G3 14 files / 97 tests |
| G4 / live isolation | PASS；2 files / 33 tests，Schema 5 fresh/reopen与replacement checks通过，Production/Feature/API/Automation live isolation 0 violation |
| ownership / G5 readiness | PASS；ownership 9/9；blocker 3/3与readiness 6/6已经从旧不可执行复现转换为prepared immutable lifecycle、CAP4-only finalization与post-CAP4 duplicate验证 |
| G2 / sealed replay | PASS；7 files / 47 tests，successor replay 40/40 exact，seal继续`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| historical/protected identities | PASS；相对`2cecf118`的Compiler及G2 candidate/draft/golden/review/sealed paths为0 changed file；G3.8A source/artifacts及其G1.6 handoff input为0 changed file；base Schema 4 migration与current reproducible provenance同为`sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43`，SQLite identity=`sha256:e46f58e49b42ad53e3d744de86b6d8fb6299236258459c35d9ca3affa440932c`，Schema 3到4=`sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf` |
| boundary / formatting / build | PASS；changed paths中的G5文件仅2个readiness tests，production changes仅Schema/Store与test-only Bootstrap exact binding；无Capacity Gateway/Publisher/Watcher、T0-T6d、Operational Blocker DML、T6e、deadline、Runtime Command Gateway、G6-G9或Production activation；managed `typecheck`、`build`、37个changed TS targeted Prettier与`git diff --check`通过 |

### Capacity repair affected-chain independent regression

**结论**：`PASS / CAPACITY_CONTRACT_SCHEMA_REPAIR_DONE`，G5 Basic Runtime=`READY`而不是`DONE`，G6-G9继续`NOT_READY`。本轮从clean local `main@37a979215d15c7f3f4021ecfd2a92aa7a2f176e9`开始，环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`；没有worktree、Handoff、sub-agent、approval/escalation、push、amend或历史重写，全部Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

独立审阅确认CAP1-CAP4的immutable prepared语义、CAP4-only Command finalization与post-CAP4 exact duplicate链正确，同时发现并修复candidate的一个Schema 4到5数据兼容缺陷：candidate Schema 5 CHECK把`decided_at_ms < requested_at_ms`、历史`applied_at_ms < decided_at_ms`以及带non-null历史denial code的合法`conflict | duplicate | failed`行错误地排除，导致Schema 4合法数据库可能在copy阶段失败。Current CHECK恢复Schema 4完整terminal shape并只新增严格`prepared`分支；4到5 upgrade在安装Schema 5 INSERT guards前复制旧行，因此五类历史terminal row逐字段保留。Fresh/current Schema 5另增加`trg:capacity_invocations:terminal_insert`，与prepared/applied/duplicate guards共同保持新写的decision chronology、allowed denial-null、初始prepared与exact finalized duplicate约束；没有把历史兼容放宽为新写旁路。

Current identities（`37a9792` candidate表保持上一节provenance，不回写）：

| Authority | Independent regression current identity |
| --- | --- |
| Capacity root / Logical artifact / Logical delta / protocol semantic artifact | `sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6` / `sha256:b15daf99f68f8447aff1da5a9411460497ae29e7067a3802ac588d790066fe30` / `sha256:ca81abe11e332890bde7420fdf8f040856e8076bba9bbc4a03d15ffedb439e3a` / `sha256:0e06b38b98bfd2193dbad24297e75b1422fdcc8f11e297835c87d4baf03aea9b` |
| G1 root / Schema / dependency / physical | `sha256:baa39d55cac34133a29b461466aa450fec59bd2fd6df72334e8b33d1d1619869` / `sha256:49aaee7c8f046cd9a15b3bc5b77fbcf1713be2a1872078941043f5ccdca29024` / `sha256:d08cfaae72c003b11a05cb1fbfa546f7cce7fad9ecb56d0746f33de294b8088c` / `sha256:ba025b32bb028f2ffe5df45d9440cd0a897e0a06c076b10b6f641c265ae02090` |
| Schema 5 migration / 4到5 upgrade / Manifest artifact / SQLite identity | `sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6` / `sha256:97479810c2c079d71270d5a714faa4b8fa8ebd6af629ef2f7d772af270c2bb0a` / `sha256:c9bce166112023cf5e09d41901938f74efbc69cff36da9428a3c21c3064d8439` / `sha256:5ee3c119cc6a0e0552e2a6fe45b51c8ffd08ec7acdbac66748978ed0d21fdb0a` |
| G3.1 / G3.3 / G3.5 | `sha256:3f385f1f91353a19fedfd347c93dbea190c97de0f267697bc6dd7536ebfb6024` / `sha256:65f675da51c030424c0f56ccb28a2490759e438d40624ded3af1e4ad23bde92a` / `sha256:bbc4e2cb402c8058a6412da0ebd5a284c2c7af831453cafaa84738a391c15718` |
| G3.6 / G3.7 / G3.9 | `sha256:c43416c9ca085553bea5ebf2294f594ce434ee275cb14d4954e11374521278a2` / `sha256:9865cf0aafa37b4f44dc293aea6c59221d0f445c2e67fa87dfe53e6be71c9fbb` / `sha256:871ded236e5e8fead95d28b365f9802792213c16d1f8517caf030ab9cc9865f8` |
| G4 pack / profile / implementation / implementation artifact / isolation | `sha256:9bf5c84032f8475ff1879ed88d64b686279b285dee1b02425dcb162e4ce949db` / `sha256:81dd4ed2e116c46b2c4a7b0057242409c4478ca55f2df34676a9e07eb942baaf` / `sha256:28a920856d26325ec14c976a9e1da668c1302e06fd3e2e05abb890dff830f018` / `sha256:74803b081571df002b900dc6ed23b9c7fc83f86bcb8f096a331cf2011805825e` / `sha256:883f8f2d4040fd03ea5a49bd38826ce6c37d5556175219b66f335793087f9188` |
| ownership / affected tree / transaction / command | `sha256:7627be1b36c04cc785e05fa8585a33eb933cb95a8ca98b824b4ae931d0ee343a` / `sha256:59c2079ca1d9bfe033d858bd169600e76eee35d93d01bbce1402f2e83a04f965` / `sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79` / `sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba` |

Independent regression evidence：

| Gate | Result |
| --- | --- |
| 两轮完整`contracts:generate` + `contracts:check` | PASS；两轮current identities一致；全Workflow Runtime JSON/SQL byte-tree digest均为`dd6c61aa82b29c5edf8d9fc9266727f28ddbd5fff31766dc926f766cf2ac1b6a`，生成后无额外drift |
| Capacity / G1 | PASS；fixture 9 positive / 31 negative / 14 fault；`test:g1.capacity` 56/56，G1.1 23/23，G1.2 23/23；Schema 5为84 tables / 1462 columns / 153 UK / 389 FK / 951 CHECK / 44 indexes / 47 triggers / 43 queries / 329 statements |
| Upgrade与rollback | PASS；fresh/create/reopen、empty Schema 3串行3到4到5、nonempty Schema 4五类terminal历史逐字段保留；source identity、DDL drift、copy constraint、FK/integrity和target verification fault均原子rollback |
| G0 / G2 | PASS；whole G0 109/109且G0.10 10/10；G2 47/47，sealed successor replay 40/40 exact，bundle=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145` |
| G3 / G4 | PASS；G3.9 34/34，whole G3 97/97；G4 33/33，14-member digest两轮=`a649e0a1cdc60536a4ea30e08f722fb539f6c9daf71925070604a951953b1606`，live analyzer=`278 source / 38 production roots / 9 authority / 4 bootstrap / 0 violation` |
| Ownership / readiness | PASS；ownership 9/9，G5 blocker 3/3，readiness 6/6；T6d/G7 transaction与Command ownership不变 |
| Protected provenance | PASS；Schema 4 migration=`sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43`、SQLite identity=`sha256:e46f58e49b42ad53e3d744de86b6d8fb6299236258459c35d9ca3affa440932c`、Schema 3到4=`sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf`、G2 sealed bundle与G3.8A=`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`保持；对应protected paths相对`37a9792`零diff |
| Boundary / build | PASS；managed `typecheck`、`build`、changed TypeScript targeted Prettier与`git diff --check`；无新增Runtime/creation/projection文件，无Capacity Gateway/Publisher/Watcher、T0-T6d、Operational Blocker DML、T6e、deadline/Gateway、G6-G9或Production surface |

## G5 BLOCKED_BY_SPEC：Capability / Outbox execution binding

**结论**：`BLOCKED_BY_SPEC`。本轮从clean local `main@ca31a5a7353ad2a059b4c9113f38377e74b0ae5a`开始，parent=`37a979215d15c7f3f4021ecfd2a92aa7a2f176e9`；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有worktree、Handoff、sub-agent、approval/escalation、push、amend或历史重写；全部Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

施工审计发现完整G5 T5/typed Outbox在current规范与冻结machine Contract上不可唯一实现：

1. 规范`WorkflowGraphCapability`与closed `compiled-scope-plan-v2`只包含Capability/Executor/effect/retry/cancellation/dependency closure；没有`adapter_ref`或`delivery_policy_ref`。Current sealed G2 `positive.static-lowering.plan.json`的`capability_binding` exact keys同样不含这两项。
2. 同一规范“Outbox、Lease 与恢复”要求Capability等producer在Publish时固定exact Adapter与finite versioned Delivery Policy，Effect创建必须冻结Policy Snapshot/Hash，恢复不得读取latest；`OutboxEffectContract`明确要求`adapter_ref + delivery_policy_ref`。
3. Current Schema 5 `workflow_outbox`强制非空`adapter_resource_id/hash`、`delivery_policy_resource_id/hash`、`policy_snapshot_value_id/hash`，并以deferred FK绑定Published Registry Resource/Value。T5无法从current Compiled Plan得到这些必填exact identities。
4. 从G4 test-only fixture任意注入Adapter/Policy可以让happy-path测试通过，但不是Production authority，会形成prompt明确禁止的mock-only/test-only bypass。自建`icarus.workflow-g5-compiled-plan/1`简化格式或手工`planHash`同样越过冻结G2 machine authority，不能形成G5 Contract identity。

最小复现命令（read-only）：

```bash
rg -n "adapter_ref|delivery_policy_ref" \
  src/workflow-runtime/contracts/schemas/compiled-scope-plan-schema.json \
  src/workflow-runtime/contracts/conformance/compiler-contract-repair/schemas/compiled-scope-plan-v2-schema.json
jq '.nodes[] | select(.capability_binding != null) | .capability_binding | keys' \
  src/workflow-runtime/contracts/conformance/sealed/g2-production-compiler-replay-repair-v2/expected/positive.static-lowering.plan.json
rg -n "adapter_resource_id|delivery_policy_resource_id|policy_snapshot_hash" \
  src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v1.sql
```

第一条返回0个member；第二条closed key set没有Adapter/Delivery Policy；第三条证明Schema强制保存这些exact bindings。唯一可接受的解阻路径是先由规范明确Capability producer到`OutboxEffectContract`的唯一Published Registry binding，把它加入closed source/snapshot/Compiled Plan或另一个被Compiled Plan exact引用的immutable execution binding，并重建受影响Compiler/Golden review/seal、G3 Publish closure与下游identity/evidence。因为这会触碰本任务明确冻结的G2 seal，当前任务不得自行reopen。

阻塞收尾回归：G5 blocker 5/5、G0 109/109、G1 Capacity 56/56、G2 47/47与sealed replay 40/40 exact、G3 97/97、G4 33/33、ownership 9/9、readiness 6/6、managed typecheck/build与changed-file format/diff checks均PASS；`contracts:check`无生成drift。

发现冲突后已移除全部未完成`creation/`、`runtime/`、Graph Store、G5 Contract/generator/tests与package/CLI handoff；没有提交partial Runtime、Capacity implementation、mock fixture、custom Plan格式或G5 identity。Current Capacity/G1/G3/G4/ownership identities、Schema 4/5、G2 sealed bundles与G3.8A均保持`ca31a5a`字节；G5不是`DONE`，G6仍为`NOT_READY`。

## G5 Capability / Outbox execution-binding repair exit candidate

**结论**：`G5_EXECUTION_BINDING_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION`。本轮开始时核验clean local `main@3d5728a26e44536c6f51a91c5a98c5725a4b4811`；施工期间另一个本地任务把`main`推进到无workflow文件交集的`439fc0d5c96cbcaf1089e1c8ce3c37ab21de0987`，本轮没有回退或改写该提交，并按新parent重建static/ownership exact identity。环境始终为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`；没有worktree、Handoff、sub-agent、approval/escalation、push、amend或历史重写，全部Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

规范现在唯一规定Published `WorkflowGraphCapability.outbox_effect`固定exact Adapter、finite versioned Delivery Policy、`normal_execution` lane、reconciliation、`provider_key | external_lookup` idempotency与`required` delivery。Compiler只从同一pinned Published snapshot解析这些资源，验证ref/content/internal hash、publication state与能力兼容性，把Policy与pinned Runtime Safety的attempt/duration/timeout/backoff ceilings求交，并lower为Compiled Plan v2 `outbox_execution_binding`；G3 Publish preflight再验证Capability、Adapter与Policy launchability一致，并拒绝test-only资源晋升Production。T5未来只能exact查询这些Registry identities，把Plan内effective Policy snapshot保存为schema-bound immutable Value，再把Registry row/value IDs与hash写入Schema 5 `workflow_outbox` exact FKs；latest、G4 fixture authority、test-only promotion和旁路Plan格式全部fail closed。

Machine authority是`conformance/capability-outbox-execution-binding/`，root=`sha256:48f63ae7be30c61f056f78f713591f34431336cc722d6928fbc6e2783a062088`。它发布closed capability snapshot、Compiled Plan、conformance result与Schema 5 handoff schemas，以及missing/mismatched/unpublished/latest/test-only/non-finite/drift/unknown-field negatives。Compiler与独立Golden authoring均实现同一lowering；current sealed positive result已经同时通过new Plan/result closed schemas，unknown fields被拒绝；Schema 5 real SQLite fixture证明exact Registry/Value FK handoff提交成功且Adapter hash drift在deferred commit时失败。

Current affected identities：

| Authority | Exit candidate identity |
| --- | --- |
| Compiler version / toolchain / build | `3.0.2` / `sha256:90bc7c99cacaf58217dd6d07781788c844385d3c70644c4086d6c997312f60a1` / `sha256:698af607955463f01a404d626586420f3dd8f7a208da87c1e138075b1518ba05` |
| Compiled Plan schema / conformance result schema | `sha256:f5bc0a43d5723096295b9a6fcd5a0965c3b98ca810ae8b6dc1a7072996608e06` / `sha256:021da33556e677984b767f99b12800be8454c7516221ec63bb16e1cb26f867f7` |
| G2 v3 Draft / review report / GoldenSemanticReview / sealed bundle / sealed artifact | `sha256:b8ca7c91839b88b5591daf19f17a30e70b85e441d9dd4905807ef57bc37f7591` / `sha256:5b3b5c721e6cda298da468566eb97da3423fcb86595de4f46dc66f79ebb55e99` / `sha256:ceddcefcab8ff41a5e9b5d2ceb89dabcd3f9199639bb247d132a7c79c33dc15b` / `sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb` / `sha256:967437bb9f91e32e5014b2af90a23f5646e491eb427bdf55accb345ead70db8f` |
| G3.1 / G3.3 / G3.5 | `sha256:aae22ae7f5ea1fa06a5c9b6c63eeadbb61b32d3510f503754ef5d8617cab0227` / `sha256:ff5d40589df9bc78e2e7f4f0e2fdcd5f0a7b7f34e0d0592e5308c1230425f1b3` / `sha256:04506acde71f4c03e081f310265df521515327caee37cc820c56fa2162ad4ffb` |
| G3.6 / G3.7 / G3.8A / G3.9 | `sha256:4dd52b4f38da315ba0194fd23a9c681ffdba6aac37291100dd6d6b944178acd9` / `sha256:e80038f09ad841de630d961f137f15a2de14a487a74afb6b1d8b36edea689ba0` / protected `sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f` / `sha256:eb3d316be520e68fe53b6be826046d3f8fa1cf97db298d5703886d1dcb97b70f` |
| G4 pack / profile / implementation / isolation | `sha256:b79b15801b11535b0b8d9c310a9680ef10754d73e0563a867a7c204a97248298` / `sha256:e005c384396b48e7c96f64ee74e185c8230cb65d09f655a3909d16f3d3b91eed` / protected `sha256:28a920856d26325ec14c976a9e1da668c1302e06fd3e2e05abb890dff830f018` / protected `sha256:883f8f2d4040fd03ea5a49bd38826ce6c37d5556175219b66f335793087f9188` |
| ownership authority / affected tree | `sha256:6ba952bf7761f249fa16c0c44a37d48a67c9f5f21c3667a5c966ac59e8affb38` / `sha256:9e290b8a9fe583942b6389f294366a698b606cf8e3ddd827cd27588b83b98323` |

Protected semantic identities保持：Canonical Normalizer 2.0.1=`sha256:e32946d0d20cc92344a72d04e488951cc4a64be82d36384db26dfbf420e469ff`，Proof Algorithm 2.0.1=`sha256:6a49827e2c039b95c42c94a607acbf6ae7c088d0510fe7fd93cc0eb87f302308`，G1 root/Schema=`sha256:baa39d55cac34133a29b461466aa450fec59bd2fd6df72334e8b33d1d1619869` / `sha256:49aaee7c8f046cd9a15b3bc5b77fbcf1713be2a1872078941043f5ccdca29024`，Capacity root=`sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6`，G2 v2 predecessor seal=`sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145`，transaction/command=`sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79` / `sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba`。没有修改Schema 5、Capacity runtime、G4 isolation语义、T6d/G7 ownership、Runtime Command Gateway、T6e、deadline、G6+或Production activation。

本任务construction-time的两轮完整`contracts:generate` + `contracts:check`有效，Workflow Runtime JSON/SQL byte-tree digest均为`c081656e53a3c849dcadac65177322d08cbe45a647bf1179f2c0d538aa23970f`且第二轮前后零artifact drift；G0 109/109、G2 52/52、current sealed replay 40/40 exact、G3 97/97、G4 33/33、ownership 9/9、G5 execution-binding blocker 5/5、Capacity blocker 3/3、G5 readiness 3/3及其共享Capacity audit 3/3当时均PASS。但是最终`build`发生在最后一次Development Core bind之后，改变了`dist/index.js`而没有刷新宿主active binding；因此`2dbf70714405bff5d5b389df6f1563e2b2a34ad6`中声称post-build仍有效的G3 97/97与完整final evidence无效，不能作为独立affected-chain regression证据。该缺口由下述定向修复收束。在独立affected-chain regression另行通过并提交前，G2/G3/G4保持`IN_PROGRESS` exit candidate，G5保持`NOT_READY`，G6-G9保持`NOT_READY`。

### Development Core active-binding directed repair

**结论**：`DEVELOPMENT_CORE_BINDING_REPAIR_PASS / G5_EXECUTION_BINDING_EXIT_CANDIDATE_UNCHANGED`。本轮从clean local `main@2dbf70714405bff5d5b389df6f1563e2b2a34ad6`开始，保留其parent `439fc0d5c96cbcaf1089e1c8ce3c37ab21de0987`且没有amend、rebase、回退或历史改写；环境仍为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。全部Node/npm/npx命令继续经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

中控在candidate提交后的clean tree复现`test:g3`仅41/97：56个真实Store/authoring tests在打开数据库前统一失败于`Development Core entry hash mismatch`。`439fc0d`删除personal assistant self-evolution并修改`src/index.ts`，最终build使`dist/index.js`从active binding固定的`sha256:11848f85176747fe1914d7f3193a4cf47f58a3590aa7f53ed2e099440a846155`变为`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3`。`bind-core`本应创建并切换到新的immutable development binding，但macOS `mv -f temporary-symlink active-core`会跟随指向目录的destination symlink，把temporary pointer移入旧binding目录；active pointer因此仍停留在旧`sha256:f0e74f405b34d1ca4026b9e1e3fe9be6032421799019b71db97d025695330c11`。

Current修复把pointer replace改为macOS明确的`mv -f -h` symlink语义，不修改或放宽`verifyDevelopmentCoreBinding`、Store identity、hash或path校验。隔离toolchain regression在同一runtime home连续绑定两组Core bytes，证明active pointer切换到新目录、旧binding bytes保持不变且旧目录没有temporary pointer残留。真实宿主在final managed build后重新bind；current Development Core entry/binding分别为`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`，第二次post-build bind byte-idempotent。

修复后回归：targeted runtime-toolchain 5/5、G0 109/109、post-build G3 97/97、G4 33/33、ownership 9/9、G5 blocker 8/8、readiness 6/6、`contracts:check`、typecheck、build、targeted Prettier与`git diff --check`全部PASS。`contracts:check`证明execution-binding root、G2 v3 seal、G3.1/G3.3/G3.5/G3.6/G3.7/G3.9、G4 pack/profile、static absence与ownership identities均相对`2dbf707`零漂移；Development Core binding不进入这些semantic pack hashes，因此没有伪造Workflow identity cascade。没有修改Schema 5、G2 sealed artifacts、G3.8A、G4 isolation/implementation、T6d/G7 ownership，也没有新增G5 Runtime/T0-T6d DML、Gateway、T6e、deadline、G6+或Production activation。

### Capability / Outbox execution-binding affected-chain independent regression closure

**结论**：`PASS / G5_EXECUTION_BINDING_AFFECTED_CHAIN_DONE`。本轮从clean local `main@28dfc27026d2c9aedd38038d2ba949d234a3f81b`开始，本原子提交parent固定为`28dfc27026d2c9aedd38038d2ba949d234a3f81b`，candidate predecessor为`2dbf70714405bff5d5b389df6f1563e2b2a34ad6`。环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`；没有worktree、Handoff、sub-agent、approval/escalation、amend、rebase、reset、回退或历史改写，全部Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。

独立审查确认Compiler与Golden authoring只从同一pinned Published snapshot解析exact Adapter/finite Delivery Policy，并lower相同Plan v2 `outbox_execution_binding`；G3 Publish closure拒绝missing/mismatch/latest/test-only promotion；Schema 5真实SQLite通过六个Registry/Value deferred FK保存exact handoff。回归发现并修复两个affected-chain证据缺口：G4 checker虽验证current G3.9 pack=`sha256:eb3d316be520e68fe53b6be826046d3f8fa1cf97db298d5703886d1dcb97b70f`，但profile仍写旧`871ded...`，现改为current exact pin并在built-profile validation中显式比较；execution-binding negative pack的部分case只声明未执行，现新增mismatched Adapter/Policy、latest/unpublished Policy、non-finite Policy、unknown binding field与Policy snapshot hash deferred-FK drift的直接测试。没有改变业务语义、Schema 5、G2 seal、G3.8A、G4 implementation/isolation、ownership authority或Runtime surface。

Current independent-regression identities：

| Authority | Identity |
| --- | --- |
| execution-binding root / Compiler toolchain / build | `sha256:48f63ae7be30c61f056f78f713591f34431336cc722d6928fbc6e2783a062088` / `sha256:90bc7c99cacaf58217dd6d07781788c844385d3c70644c4086d6c997312f60a1` / `sha256:698af607955463f01a404d626586420f3dd8f7a208da87c1e138075b1518ba05` |
| G2 v3 Draft / report / review / seal / sealed artifact | `sha256:b8ca7c91839b88b5591daf19f17a30e70b85e441d9dd4905807ef57bc37f7591` / `sha256:5b3b5c721e6cda298da468566eb97da3423fcb86595de4f46dc66f79ebb55e99` / `sha256:ceddcefcab8ff41a5e9b5d2ceb89dabcd3f9199639bb247d132a7c79c33dc15b` / `sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb` / `sha256:967437bb9f91e32e5014b2af90a23f5646e491eb427bdf55accb345ead70db8f` |
| G3.1 / G3.3 / G3.5 / G3.6 / G3.7 / G3.9 | `sha256:aae22ae7f5ea1fa06a5c9b6c63eeadbb61b32d3510f503754ef5d8617cab0227` / `sha256:ff5d40589df9bc78e2e7f4f0e2fdcd5f0a7b7f34e0d0592e5308c1230425f1b3` / `sha256:04506acde71f4c03e081f310265df521515327caee37cc820c56fa2162ad4ffb` / `sha256:4dd52b4f38da315ba0194fd23a9c681ffdba6aac37291100dd6d6b944178acd9` / `sha256:e80038f09ad841de630d961f137f15a2de14a487a74afb6b1d8b36edea689ba0` / `sha256:eb3d316be520e68fe53b6be826046d3f8fa1cf97db298d5703886d1dcb97b70f` |
| G4 pack / profile / implementation artifact / implementation / isolation | `sha256:4d2ca7bc3095ae5ac208da8918eabc6d3b7c62e9fab029439f6b01c275f7b8cd` / `sha256:71e0aba29c1ec34cd4d9fa0515409576bdc8fd7f90b9c258bbe0a614b3f0fa3d` / protected `sha256:74803b081571df002b900dc6ed23b9c7fc83f86bcb8f096a331cf2011805825e` / protected `sha256:28a920856d26325ec14c976a9e1da668c1302e06fd3e2e05abb890dff830f018` / protected `sha256:883f8f2d4040fd03ea5a49bd38826ce6c37d5556175219b66f335793087f9188` |
| ownership authority / affected tree | protected `sha256:6ba952bf7761f249fa16c0c44a37d48a67c9f5f21c3667a5c966ac59e8affb38` / protected `sha256:9e290b8a9fe583942b6389f294366a698b606cf8e3ddd827cd27588b83b98323` |

验证证据：

| Command / evidence | Result |
| --- | --- |
| 两轮完整`contracts:generate` + `contracts:check` | PASS；两轮Workflow Runtime JSON/SQL byte-tree digest均为`c99769568a3fed62995d97d954b32a8818f59ca029b6ddbeaa5cb622a0a0d76b`，无额外artifact drift |
| `test:g0` / `test:g2` / `golden:current:replay:check` | PASS；109/109；57/57；40/40 exact，历史三代sealed lineage read-only |
| `test:g3` / `test:g4` | PASS；97/97；33/33；G4 14-member digest=`sha256:d101cc1e105cb89049548a2d38377d8647697256aa8e548af0c0d737b465754c`；live isolation=`275 source / 38 production roots / 9 authority / 4 bootstrap / 0 violation` |
| `test:g1.1` / `test:g1.2` / Schema 5 handoff | PASS；23/23 + 23/23；Adapter与Policy snapshot hash drift均在deferred commit失败 |
| `test:gate-ownership` / `test:g5:blocker` / `test:g5:readiness` | PASS；9/9；9/9（Capability 6 + Capacity 3）；6/6 |
| final `typecheck` / `build` / `bind-core` / post-build G0/G3 | PASS；Development Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`；post-build 109/109 + 97/97 |

Protected boundaries相对`28dfc270`：G2三代sealed trees、G3.8A source/artifacts、G1 Schema 5 source/migration/Manifest、Capacity authority、transaction/command protocols与ownership authority均0 changed file；Canonical Normalizer/Proof Algorithm、G1 root/Schema、Capacity root、G2 v2 predecessor seal、Schema 5 migration/4-to-5 upgrade/SQLite identity保持既有exact值。Changed paths只含G4 current upstream pin、execution-binding负向测试、Contract README与本账本。没有G5 Runtime、T0-T6d业务DML、Capacity runtime、Operational Blocker create/open/cache、Runtime Command Gateway、T6e、deadline、G6+、Production activation或无关产品模块。

## G5 Basic Runtime Gate exit candidate

**结论**：`EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION`。本轮从clean local `main@4f7087fc841158b445a90edc88c432c3c93944e9`开始；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有创建worktree、Handoff或sub-agent，没有approval/escalation、amend、rebase、reset、回退或历史改写，全部Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec -- <command>`执行。G2/G3/G4保持`DONE`；G5只形成原子退出候选，不标`DONE`；G6-G9保持`NOT_READY`，Production activation未启用。

新增G5 production-target实现包括独立Capacity Admin CAP0-CAP4、task intake/Recipe exact registry/routing/domain claim、Graph Store、lifetime与active-slot ledger、Reconciler、basic scheduler、node result/callback/retry/watchdog、wait/inbox、outbox与Operational Blocker create/open/cache。Capacity使用immutable `prepared` Invocation，CAP4-only Command finalization，CAP2文件原子发布、CAP3 head CAS、CAP4 watcher publication；same-key exact duplicate/conflict、rename/head/crash/reopen/replay与文件/lineage tamper均fail closed。实现没有连接真实Adapter、网络或用户数据，也没有新增Capacity Gateway/Publisher/Watcher之外的产品面或Production ingress。

所有G5业务事务只经`WorkflowRuntimeStore.withImmediateTransaction()`执行短同步`BEGIN IMMEDIATE`；compile、Adapter、tool、文件和网络工作留在事务外。实现覆盖exact `T0/T0p/T1/T2a/T2b/T3a/T3b/T4/T5/T6a/T6b/T6c/T6d`，逐事务在commit前fault injection时全量rollback，并验证commit后reopen/replay、same-key duplicate/conflict、CAS、row version、lease、work fence epoch、Schema/hash/Plan/tamper边界。T5只消费sealed Compiled Plan v2 `outbox_execution_binding`，exact查询Published Adapter与finite Delivery Policy，将immutable effective Policy写为Schema-bound Value，并写入Schema 5现有六个deferred-FK列；latest、G4 test authority、test-only promotion、custom Plan和fallback均被拒绝。T6d只实现automatic attempt dispatch/execution watchdog、execution retry、quality revision durable timer和retry-schedule consumption primitive；manual retry不获授权。

G5 closed Contract Pack为`icarus.workflow-contract-pack-g5-basic-runtime@1.0.0`，identity=`sha256:2cda6c4b920cb682f016a9cabdcb46d9482774894e6aefada229b88cc973d970`，member tree=`sha256:e50efbce0b898422cc63da4d6ab0bbebccfc23b8311c9a019aac7fadeb8000ec`；protocol/record schema/implementation分别为`sha256:bb5753ea10dcf164b588cd2b9a0d0c1da760d3268bc3843a28ceedf7a2d8c9f4` / `sha256:a3f356b74a7db2f9b6d01fa6df259be08d3206e167b697eb669911940b8bf3d1` / `sha256:ad5284c68443477bc8ef8ef407c3996c638f65ef5940c32a5dda996484c34a3b`，15-source tree=`sha256:f347a97de96a4e7975db4a3d970ad8425ee8f9e92884c3da00f0b01351a0f08d`。它冻结Task/Creation/Launch/Activation/Manifest/Fact/Event/Attempt/Wait/Effect/Inbox/Outbox/Claim/Ledger/Capacity/CapacityPublication/Blocker typed records，9 positive / 14 negative / 16 fault fixed fixtures、deterministic generator/checker与source inventory。独立reference model不导入Production Reconciler或Store；fixed和fast-check property覆盖static/delegation/system/wait/join/terminal、Fact/Event fixed point、late wait winner、automatic retry、quality continuation/exhaustion与blocker cache，并与真实SQLite terminal state比较。

Current protected bindings保持：ownership=`sha256:6ba952bf7761f249fa16c0c44a37d48a67c9f5f21c3667a5c966ac59e8affb38`，transaction=`sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79`，command=`sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba`，Capacity=`sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6`，execution binding=`sha256:48f63ae7be30c61f056f78f713591f34431336cc722d6928fbc6e2783a062088`，G1 root/Schema=`sha256:baa39d55cac34133a29b461466aa450fec59bd2fd6df72334e8b33d1d1619869` / `sha256:49aaee7c8f046cd9a15b3bc5b77fbcf1713be2a1872078941043f5ccdca29024`，G2 sealed artifact/bundle=`sha256:967437bb9f91e32e5014b2af90a23f5646e491eb427bdf55accb345ead70db8f` / `sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb`。相对起点，Capacity addendum tree `8e8e7455fbedafa88616ebdb854b0c9e45b06d3c`、G2 sealed tree `15959786bfce16aa98996fa5774f54795daec7cf`、Schema tree `29dff169a95ecf8ca847156b85ccefda6fdb9789`均为零diff。

Construction/exit-candidate证据：`contracts:g5:generate/check`与`test:g5` PASS（4 files / 10 tests）；Capacity/G1 PASS（4 files / 56 tests），ownership 9/9，G4 33/33，G3.9 34/34，whole G3 97/97，G1.1 23/23，G1.2 23/23，`schema:check`、`store:check`、aggregate `contracts:check`均PASS；G2 57/57，current Golden path 26/26并40/40 exact replay；G0.6 8/8、G0.10 10/10、whole G0 15 files / 109 tests；managed typecheck/build、G5 scoped Prettier与`git diff --check`通过。Boundary audit为0条Runtime Command/Invocation/Event audit DML、0条T6e/blocker resolve/abandon/workflow deadline/Completion Cut/Relation DML、0个G6-G9或Production activation surface、0个G4 bootstrap production import、0个lockfile change、0个G4 temporary root残留。最终build后重新执行Development Core `bind-core`，并重跑G0/G3/Store/G5以排除active-binding假阳性。

### G5 Basic Runtime targeted blocker repair exit candidate

**结论**：`G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION`，不是`DONE`。本轮从上一轮独立whole-gate回归确认失败后的clean local `main@9ed29f171ac015065d5654986a35240511cc8934`开始，保留implementation candidate `baf16df2bd910e507bbfaefe5f75a9a6effc6c70`与其parent `4f7087fc841158b445a90edc88c432c3c93944e9`历史；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有worktree、Handoff、sub-agent、approval/escalation、amend、rebase、reset、回退或历史改写，也没有开始G6。

定向修复建立了不可由调用方替换的`Published Definition compiled_plan_pin -> persisted Compiled Plan v2 -> Scope plan hash -> exact normalized node -> T4/T5/T6`链。T2b写入exact Published capability row ID/hash；T4只从Plan恢复execution/wait/structural字段；T5 API已移除caller `outboxExecutionBinding`与context，事务内复核Runtime Safety、Published Adapter、finite Delivery Policy和Schema 5六个deferred FK；custom/self-consistent/latest/test-only/tampered Plan或node以及Run/Scope fence drift均fail closed。T3不再接受调用方制造terminal node，补齐scope-input/data-only target、failed data unavailable、all-edge join、current ready epoch和Plan-derived settled rule/policy。T6a/watchdog不再接收retry policy；T6d必须读取live Capacity head，检查physical active slot，新增active reservation和带revision/change/config lineage的scheduler admission。T6b绑定Plan delegation与已持久化external execution identity，T6c绑定Plan wait Contract并要求distinct typed ingress/binding authorization Values。

新增`runtime/plan-authority.ts`，G5 production inventory由15增至16 sources。repaired pack=`sha256:90060da961df14dfb9970c9f08619b406c0cff36ea8bff5326f2d950391099bb`，member tree=`sha256:4093ef602b345e247e192f0ff76ee7e561a979fb123eaf21153eacb184beb6be`，protocol=`sha256:87543c7cd905d47fa493f9558ea39b5be54ff0aafc5927c9237423de9f6c6ee3`，record schema保持`sha256:a3f356b74a7db2f9b6d01fa6df259be08d3206e167b697eb669911940b8bf3d1`，implementation=`sha256:1ee9bf84017c2fa5675a798d224121448ef1d268527b6de75b80c3ff721b1b80`，source tree=`sha256:c64f8941bef066e4cccd242cb1b1d830b0d25b2033e5defcde45185c55267c22`。ownership=`sha256:6ba952bf7761f249fa16c0c44a37d48a67c9f5f21c3667a5c966ac59e8affb38`与execution binding=`sha256:48f63ae7be30c61f056f78f713591f34431336cc722d6928fbc6e2783a062088`保持不变。

冻结G0.10 checker仍保存其历史sealed-directory假设且未修改；新增additive current Capacity compatibility checker，逐字节重建旧Capacity addendum、校验manifest members与历史G0.9，并只允许current `g2-capability-outbox-binding-v3`加入既有sealed集合。Schema 5、G2 sealed trees、G3.8A与G0.10 generated artifacts均未修改。production differential fast-check现在实际创建SQLite candidate并比较独立model terminal state，同时检查Fact/Event单写、active ledger释放与blocker状态，不再仅比较reference model自身顺序。

最终repair exit-candidate证据全部通过：

| Command / evidence | Result |
| --- | --- |
| 两轮`contracts:g5:generate` + `contracts:g5:check` | PASS；两轮pack均为`sha256:90060da961df14dfb9970c9f08619b406c0cff36ea8bff5326f2d950391099bb`，selected generated-file manifest digest均为`a158cdb23750affd5db3da5541e40dadf03cbbcbc28f4fa8397c82bd5283abd0`，第二轮byte-identical |
| fixture-driven G5 / readiness / blocker | PASS；`test:g5` 4 files / 50 tests，实际驱动9 positive / 14 negative / 16 fault fixed fixtures及production SQLite fast-check differential；readiness 6/6，blocker 9/9 |
| Capacity current / G1 / ownership / G4 | PASS；`contracts:capacity-repair:check` current Capacity hash=`sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6`；Capacity/G1 56/56，ownership 9/9，G4 33/33 |
| aggregate / G3 / Schema / Store / G1 | PASS；aggregate `contracts:check`；G3.9 34/34，whole G3 97/97；`schema:check`、`store:check`；G1.1 23/23、G1.2 23/23 |
| G2 / current sealed / replay | PASS；G2 57/57，current sealed path 26/26，current exact replay 40/40，sealed bundle=`sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb` |
| G0 / build / post-build | PASS；G0.6 8/8、冻结G0.10 10/10、whole G0 109/109；managed `typecheck`、`build`、`bind-core`后再通过G0 109/109、G3 97/97、Store check、G5 50/50；Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab` |
| Boundary / dependency / temporary roots | PASS；protected G0.10/G2 sealed/G3.8A/ownership/Schema trees 0 diff；forbidden Command/Invocation/Event audit DML、T6e/blocker resolve/abandon/deadline/manual bypass/G6+/Production activation surface及runtime network import均0；`package-lock.json` 0 diff，`package.json`仅切换additive current checker；Prettier与`git diff --check`通过。本轮没有遗留temporary root；`.tmp-wfcheck`为2026-04-10已有且本轮未修改的ignored用户目录 |

一次错误的本地格式化入口触发`pnpm exec`兼容安装并生成两个未跟踪pnpm文件；它们已删除，随后严格依据tracked `package-lock.json`执行`npm ci`恢复依赖，lockfile与dependency declarations均零漂移。其后两次bare `npm run test:g5`均按设计在Store bootstrap fail closed于Homebrew Node executable identity（5/50只包含不打开Store的纯Contract/model tests）；这不是产品回归失败。所有authoritative生成、检查、测试、typecheck、build与Prettier证据均重新经`./scripts/runtime-toolchain.sh exec -- <command>`获得，未放宽timeout或断言。

无论construction checks通过，本提交状态仍只允许是repair exit candidate；下一任务仍只能是新的独立G5 whole-gate regression。

### G5 Basic Runtime second targeted repair exit candidate

**结论**：`G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION`，不是`DONE`。本轮从中控拒绝上一轮候选后的clean local `main@7d605200a0e9410f2e010b5509c884d4591f4414`继续，保留上一轮候选提交及上节完整记录；本原子提交parent固定为`7d605200a0e9410f2e010b5509c884d4591f4414`。环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`；没有worktree、Handoff、sub-agent、approval/escalation、amend、rebase、reset、回退或历史改写，也没有开始G6。

第二轮定向修复新增`runtime/fixed-point-authority.ts`并使persisted sealed Plan/normalized node成为T3a/T3b唯一语义权威。Control route完整执行status/code/child-exit outcome、condition program、`first_matching/default/all_matching/no_match`；target trigger按Strong Kleene三值语义执行`root/all/any/quorum/expression`，首次true时持久化不可变真实witness、resolution sequence和program hash；input seal按Plan `input_ports`执行required/optional/default、single/list aggregation、select/seal/order与missing guard。每个post-state fact都执行early rule并持久化首次eligibility，再在live running/healthy fence下仲裁；调用方不能注入route/trigger/join/input/completion authority。

T3b现在验证persisted completion policy/rule/fact/selector hashes，先计算`normalized_fact_expression/when`再按priority fall-through；selector同时支持`exits`与`terminal_node_ids`，并分别实现`first_reached`、`exit_priority_then_first`、`lowest_terminal_node_id`。高优先级when=false或selector空集会继续评估低优先级适用rule；无适用rule/candidate时在同一事务写`engine_error/no_exit_selected`，不再返回precondition failure。正常settled completion同步推进Run/Scope work fence；T4 terminal candidate只消费Plan-pinned named exit。新增SQLite fixed/property/reference-model证据覆盖any/quorum/expression、condition/default/all/first/no-match、required/optional/default/list/literal input、early arbitration、三种selector、fallback、no-exit、rollback/reopen/replay；12-run fast-check直接比较production target rows、Fact/Event keys、ledger和blocker状态。

第二轮G5 closed pack identity=`sha256:7e89802e0de82baf3149f85f448e749e6df96041089d5519b0217e43592e37b2`，member tree=`sha256:66e23693e10867d77c1f4edf98d03f658e5a52be11a40bf6d87af19cc8bc69e2`，protocol=`sha256:87543c7cd905d47fa493f9558ea39b5be54ff0aafc5927c9237423de9f6c6ee3`，record schema=`sha256:a3f356b74a7db2f9b6d01fa6df259be08d3206e167b697eb669911940b8bf3d1`，implementation=`sha256:5d14d68e983809c731f5483b013c455a306c7d1154e2f66e9861c6663bff537c`，17-source tree=`sha256:e832c84114c5481375523c92b4b9132164e3e101539b9942af26e792dc48a9bc`，selected generated-file manifest digest=`f6ccc276b78481a75fa473c920902d50c95f2a270474d6ebbab579e763b520a1`。ownership=`sha256:6ba952bf7761f249fa16c0c44a37d48a67c9f5f21c3667a5c966ac59e8affb38`与execution binding=`sha256:48f63ae7be30c61f056f78f713591f34431336cc722d6928fbc6e2783a062088`保持不变。

第二轮repair exit-candidate证据全部通过：两轮完整`contracts:g5:generate/check` byte-identical；`test:g5` 4 files / 55 tests，readiness 6/6，blocker 9/9；`contracts:capacity-repair:check`、Capacity/G1 56/56、ownership 9/9、G4 33/33、aggregate `contracts:check`、G3.9 34/34、whole G3 97/97、Schema/Store checks、G1.1 23/23、G1.2 23/23、G2 57/57、current sealed 26/26、exact replay 40/40、G0.6 8/8、冻结G0.10 10/10、whole G0 109/109、managed typecheck/build均PASS。final build后执行Development Core `bind-core`，entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`，再通过G0 109/109、G3 97/97、Store check和G5 55/55。

Boundary audit相对parent证明冻结G0.10 generated artifacts、G2 sealed trees、G3.8A、Schema 5、ownership和G4 bootstrap trees均为0 diff；forbidden Workflow Runtime Command/Invocation/Event audit DML、T6e、blocker resolve/abandon、workflow deadline、manual retry bypass、G6+/Production activation surface、runtime network import、G4 bootstrap production import均为0；dependency declarations与`package-lock.json`零漂移，`git diff --check`通过。没有新增temporary root；`.tmp-wfcheck`仍是本轮前已存在且未修改的ignored用户目录。无论这些construction checks通过，G5仍只允许保持repair exit candidate，G6-G9继续`NOT_READY`；下一任务仍只能是新的独立G5 whole-gate regression。

### G5 Basic Runtime third targeted repair exit candidate

**结论**：`G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION`，不是`DONE`。本轮从中控拒绝第二轮候选后的clean local `main@174bfd5257758378add6b65cc0a28103be4c62c3`继续，保留前两轮候选提交与上文完整记录；本原子提交parent固定为`174bfd5257758378add6b65cc0a28103be4c62c3`。环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`；没有worktree、Handoff、sub-agent、approval/escalation、amend、rebase、reset、回退或历史改写，也没有开始G6。

第三轮定向修复使node-output与scope-input data edge冻结真正选中的immutable Value authority。无pointer时复用sealed envelope port内经ID/hash/schema/byte-length复核的Value；pointer、literal及embedded值按persisted Plan hash、edge与source identity确定性写`selected-data-value`，data resolution与input snapshot不再引用整个多端口envelope。default与list聚合值同样按Plan/node/port/aggregation确定性写`input-port-value`，snapshot显式记录`logical_value`。

T3 input seal现在从persisted compiled input-port authority加载exact Published Registry schema，以Draft 2020-12校验single value、default、list item与最终sealed array，并同时执行port `max_bytes`、list `item_max_bytes`及Runtime Safety `max_single_value_bytes`。schema/hash/byte metadata、single/list schema、item/aggregate大小任一不满足均fail closed。初始化阶段的scope-input/literal pointer、data authority、trigger或input orchestration error不再普通throw并回滚已写edge/fact，而是在同一`BEGIN IMMEDIATE`事务创建`engine_error/fixed_point_resolution_error` close request，推进Run/Scope closing并递增work fence；`before_commit` fault仍完整rollback，重跑提交exact evidence。

新增可直接击穿旧实现的production SQLite证据：scope/node direct edge必须引用envelope内真实Value而非envelope，pointer必须引用canonical派生Value；invalid single schema、single max bytes、list item schema/item max bytes、sealed array schema/total max bytes分别提交engine-error；初始化missing pointer覆盖fault rollback、commit、edge error、orchestration/close Event及Run/Scope fence，selected-value terminal case覆盖before-commit rollback与exact replay，既有T0-T3a case继续覆盖Store reopen/replay。独立有界reference model不导入Ajv或runtime helper；12-run fast-check随机组合single/list、string/integer及item/aggregate byte limit，逐例驱动真实Plan materialization/T3a并比较Node/close终态，同时复核Fact/Event key、facts ledger与blocker cache。

第三轮G5 closed pack identity=`sha256:73db71fbfe4ffbb41fc40181eb94d9d6f3fdbcff19a1f1e2180e427fdab6f348`，member tree=`sha256:17bdfbac49c858084cc1b47f60eb56dc096a4b6289a7050cc2fdb2bf55d57b26`，protocol=`sha256:87543c7cd905d47fa493f9558ea39b5be54ff0aafc5927c9237423de9f6c6ee3`，record schema=`sha256:a3f356b74a7db2f9b6d01fa6df259be08d3206e167b697eb669911940b8bf3d1`，implementation=`sha256:867643cf2dfdb3e25b72d50023248a0aa8d49b388ff83e94236d6286b98ec842`，17-source tree=`sha256:7eb638cbe84c65b38511b9e699eab62f4b08ca2801e519498d052287156555c7`。两轮generate后G5 conformance tree digest均为`87f2295310c4d5aac4fdc35de43e030e6aac30303b17e6d5a38954bb1cba5dd6`，第二轮byte-identical；ownership=`sha256:6ba952bf7761f249fa16c0c44a37d48a67c9f5f21c3667a5c966ac59e8affb38`与execution binding=`sha256:48f63ae7be30c61f056f78f713591f34431336cc722d6928fbc6e2783a062088`保持不变。

第三轮受影响前置证据：`test:g5` 4 files / 64 tests；`contracts:capacity-repair:check`、Capacity/G1 56/56、ownership 9/9、G4 33/33、aggregate `contracts:check`、G3.9 34/34、whole G3 97/97、Schema/Store checks、G1.1 23/23、G1.2 23/23、G2 57/57、current sealed 26/26、exact replay 40/40、G0.6 8/8及冻结G0.10 10/10均PASS。第一次whole G0并行run为108/109，唯一失败是既有R-015 `runtime-toolchain` launcher case在5.113s命中5s timeout；未放宽timeout，立即单文件串行复现5/5 PASS，该case为4.159s。final managed typecheck/build均PASS；重新`bind-core`后Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`，post-build whole G0 109/109、whole G3 97/97、Store check与G5 64/64全部PASS。

Boundary保持不变：相对parent仅8个预期文件有差异；冻结G0.10 generated artifacts、G2三代sealed trees、G3.8A、G1 Schema 5、ownership与G4 bootstrap均不修改；没有Workflow Runtime Command/Invocation/Event audit写、T6e、blocker resolve/abandon、workflow deadline、manual retry bypass、G6+、Production activation、runtime network/process import或依赖/lockfile漂移。`.tmp-wfcheck`是本轮前已存在且未修改的ignored用户目录，本轮测试未遗留temporary root。G5 scoped Prettier与`git diff --check`通过。G6-G9继续`NOT_READY`；下一任务仍只能是新的独立G5 whole-gate regression。

### G5 Basic Runtime fourth targeted review: generated schema / join expose blocker

**结论**：`BLOCKED_BY_SPEC`；第三轮`a17ae86e260daf0530fd93108ba2e2ad2740af1f`仍作为历史repair candidate保留，但不是可送独立whole-gate的current exit candidate。第四轮从clean local `main@a17ae86e260daf0530fd93108ba2e2ad2740af1f`开始；环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有worktree、Handoff、sub-agent、approval/escalation、amend、rebase、reset、回退或历史改写，也没有开始G6。

Applicability/authority审查证明current Spec、sealed Plan与Schema 5没有共同定义可执行的generated-schema Value authority：

1. Spec 1822-1830、1886与current closed Compiled Plan schema允许`type=generated`在`schema_json`和`schema_ref`中恰选一个；`schema_ref`的machine约束只有non-empty string。Current Spec、G5 Contract、Compiler、Registry和Store均没有定义该字符串的命名空间、content lookup、canonical bytes、hash验证或到Published Registry Resource的映射。Current sealed G2只有4个generated `schema_json`实例，没有generated `schema_ref` oracle。
2. `workflow_values.schema_resource_id/schema_resource_hash`在Schema 5均为non-null，并通过deferred composite FK绑定`workflow_registry_resources(id, content_hash)`；`StoredValueMetadata.schema_ref`同样是`VersionedRef`。Plan-local generated schema无合法槽位。`loadCompiledSchemaAuthority()`无条件读取`schema_json`，而`persistPlanSelectedValue()`与`materializeSealedInputValues()`又拒绝`resourceId=null`，因此schema-valid generated `schema_ref`会被误报authority invalid，generated `schema_json`也不能为新派生/聚合Value提供合法schema-bound FK。Runtime自行插入或声称一个Registry schema会伪造Published authority，明确禁止。
3. Source join只声明`input_ports + expose`。Current Compiler `nodeBase()`从source `node.output_ports`编译输出，而join source schema不允许该字段；`compileGraphNode(join)`只透传`expose`。实际managed Compiler最小复现得到`join_input_ports.source_value`和`expose.renamed.input_port=source_value`，但`join_output_ports={}`。加入`join.renamed -> consumer.value` data edge后，Compiler在`/data_edges/1`以`schema_not_assignable`拒绝，stable object id为`data.from-join`。因此不存在可供G5消费的sealed typed join-output Plan。
4. 即使Runtime从`input_ports + expose`能猜出一个近似contract，也会在sealed Plan的`output_ports={}`之外自行创造compiled output contract、required/max/schema和`port_contract_hash`，违反Spec 2037-2109的Plan authority与1887的canonical envelope要求。`basic-scheduler.ts`当前直接把input snapshot Value标成published envelope；snapshot port保存的是`logical_value`，而downstream reader只接受`value_ref/value_hash`。这不是可在G5内用fallback补齐的单点publication bug。

最小复现输入的关键部分如下；去掉第二条data edge时Compiler成功但join `output_ports={}`，保留第二条时得到上述确定性拒绝：

```json
{
  "join": {
    "id": "join",
    "type": "join",
    "input_ports": {
      "source_value": {
        "schema_ref": { "id": "fixture.schema.string-narrow", "version": "1.0.0" },
        "max_bytes": 4096,
        "aggregation": { "type": "single", "required": true, "select": "only" }
      }
    },
    "expose": { "renamed": { "input_port": "source_value" } }
  },
  "data_edges": [
    { "id": "data.into-join", "from": { "type": "node_output", "node_id": "producer", "port": "value" }, "to": { "node_id": "join", "port": "source_value" } },
    { "id": "data.from-join", "from": { "type": "node_output", "node_id": "join", "port": "renamed" }, "to": { "node_id": "consumer", "port": "value" } }
  ]
}
```

唯一可接受的解阻范围是先完成additive authority repair：规范必须定义generated `schema_ref`解析与hash规则，并明确Plan-local generated schema如何获得Schema 5可接受的Stored Value schema identity，或以受治理Schema successor提供等价first-class binding；Compiler必须为每个join expose从对应compiled input contract确定性lower完整typed `output_ports`、`join_expose` generator/parameter hash与data-edge proof；随后重建受影响Plan schema、Compiler/Golden review/G2 successor seal及G3/G5 identity/evidence。冻结G2三代sealed trees和current Schema 5不得原地修改或伪造。

本轮按阻塞协议没有修改Runtime、Compiler、Schema、G5 Contract Pack、fixtures、reference model或package scripts，也没有增加mock-only test掩盖缺口。read-only managed Compiler复现执行两次并得到上述exact结果；current G5 pack/Capacity compatibility checks、文档diff与protected-tree审计在提交前复核。G6-G9继续`NOT_READY`；在authority repair及其独立affected-chain regression完成前，不得恢复G5施工、不得把G5标`DONE`或开始G6。

### Generated schema / join expose authority repair exit candidate

**结论**：`GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION`，不是G5 repair candidate或`DONE`。原候选从clean local `main@0a48f6007588064cd3ffb5e288cb9aa7dedcf031`开始并形成`1a7cf69d3e01bc38e3f1e427e4d777bc5c4940ae`；本次最小定向返修以该已审候选为固定parent，保留其提交与全部历史，新增additive successor。环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`。没有worktree、Handoff、sub-agent、approval/escalation、amend、rebase、reset、回退或历史改写；没有继续实现G5 Runtime或开始G6。

R-019与closed machine pack唯一规定generated descriptor必须同时携带等价的RFC8785-JCS `schema_json`与`icarus-generated-schema:sha256:<raw-hash>`，并闭合raw hash、`icarus:workflow-generated-schema:2\n` domain hash、`icarus:workflow-generated-schema-parameter:2\n` generator parameter hash、byte length和Plan hash binding。仅允许persisted exact content resolution，unknown scheme、missing pair、hash/bytes drift、latest/network/Runtime fallback全部fail closed。Decision/pack identities为`sha256:b53f8a77e51adba5d1b8f41766336bae2a59a05e5ced1959996218d745d5ebd4` / `sha256:0c9b1a04a013bf6284b36c550ead6d81cffecacbe4a9d6495d6153b2335a04fc`；R-018唯一保留Feature Release Activation persistence原义。

Database Schema 6新增`workflow_generated_schema_contents`与`workflow_plan_generated_schemas`，并把`workflow_values` schema authority重建为严格互斥且完整的`registry | plan_generated`。Generated identity通过exact sealed Plan/content composite FK取得first-class Stored Value合法性，不伪造Published Registry resource。5到6 upgrade原样迁移全部Schema 5合法Value及其inbound FK targets并标记`registry`；fresh/reopen/upgrade/FK/CHECK/query-plan/before-commit rollback均由真实SQLite测试覆盖。冻结Schema 5 migration继续位于`migration/workflow-runtime-schema-v1.sql`，identity=`sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6`、`user_version=5`、SQLite=`sha256:5ee3c119cc6a0e0552e2a6fe45b51c8ffd08ec7acdbac66748978ed0d21fdb0a`且相对`0a48f60`零diff；fresh Schema 6使用独立`migration/workflow-runtime-schema-v6.sql`、identity=`sha256:16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41`与`user_version=6`，5到6 upgrade=`sha256:dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d`。Current G1 root/dependency manifest/schema/Schema manifest为`sha256:3cc206a6dfb1bbaed1bb0f4305323729db23d839652d8a0e020a9a6c4d3e3dd6` / `sha256:0e4e38f3e31e53bcc9687f1928c44c4c57dc1c443fff774a3107ba057193120e` / `sha256:37f0102a9d6b0077f0d44f20182a7d5768ce32b1c0c2c3998937178b06c9b474` / `sha256:30b88b9df7dc7f8318ce8fcb5c38ca94c585d8585deff83235b8a8b8f582e0e2`。

Compiler 3.0.3从每个Source join expose对应的compiled input contract确定性lower完整typed output port。rename、optional/default single、list item/max/required全部进入`join_expose` parameter hash；caller `output_ports`被closed Source schema拒绝；downstream data edge使用generated schema canonical content完成assignability proof。Toolchain/build/proof/Plan/result schema identities为`sha256:acc4bd6e6444f9903e3054bf637dee28ee8b25fbfc5eebd49b9aaf37582ff493` / `sha256:eae5b2002226b9110dddba57dce528af91439ae760c5d30636631bcb464d86b2` / `sha256:b6fda13a0acddf052cae5ed6f1bc89f2b9cfa91affbfcbb80aa44365f78c35d9` / `sha256:e582abc7a221f4d1afd66d12c2a87816cb228f6139a77d9abfaa1a397844f947` / `sha256:ee41b9dff7eb2c97a75c81a7c15ec3bcf935ce233c29468a4ef7b7bfa047987e`。

G2 v4作为`1a7cf69`已审候选完整保留，RC/Draft/report/semantic review/seal internal/seal artifact仍为`sha256:b0a8d7599073b9f4ae222fac799a9923b14c0762aa70a88746adfc2953809996` / `sha256:5f8eb14f6566379bc0047b72b991f76030f12c116f3cb09d1d0649ef9e18ae3e` / `sha256:304e029a42f720d3994ff1f6147678c5c9fba0d96c71c4e645d19ea4386ea967` / `sha256:056151bf316cc526db1b77393524c79532cc6706c88efd3d29394d76a8d2f39b` / `sha256:b7d26b8622b1ceadff419430f443a9b0ceb377cbd47af20e9109ea878046abf9` / `sha256:591e2fdd083b2b3c4aea2e85edf9e052bad2e1c89908853d2eb6d912befaea76`，真实历史重放40/40。R-019与Schema 5/6路径返修通过additive v5绑定v4唯一predecessor；v5 working contract/input/candidate/review roots为`sha256:8bcbef902859b406f99101b996e6c8ccc07785b05f1935d145a30f7f79f1ec19` / `sha256:ecd9c3d889c6b0ce7d3ae7f1f59046b5950e24f1f17a38f2a55b25626d85e6aa` / `sha256:9e217fad5593715ddadbf93a33e20d4caf8bf43386e86ceec22acf0fb654b0ce` / `sha256:a448daa01c55cb98804e6d29bd9db214f596a75818230dbe47481a7a640cb92a`；RC/Draft/report/semantic review/semantic artifact/seal internal/seal artifact为`sha256:6fe9c6804237ea00dfb73c50dcd9a5dd658956b54e67db554817067433c584f6` / `sha256:965b1af2c4688c827a9d63f6b939a130271ab0e8b0fcf85a614cdd2620cb757e` / `sha256:96f6d0feee0e4a7d77349e0d8210875dc518a40ada167785c0859193a0246180` / `sha256:4481515b905ca062e3d028e17bb13ed2d4080059e844efa6c609ef292967e0de` / `sha256:f5c07ae45d93124cda1247aeca1cdb4df8d2cc7398e2129cd7d90f4ab529526b` / `sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05` / `sha256:f59040be6f71d8655afcb11ab4527a6683125a7a4e683f1e734b44448f7bb72e`；40/40 exact，95 assertions。

Affected current closure已重建：G3.1/G3.3/G3.5/G3.6/G3.7/G3.9=`sha256:c9364171a3d28a752d4510f59e5e45016cd86be14d7e151b483fc0c6c7a2807d` / `sha256:590acdd52626838bf30ae14bb04b6f0ee59a95e1efadc4911ff850acc2970763` / `sha256:b6a4ec1dac738c6036869c763708f8aa144d0a864c8c392ee18cb3aba8c83417` / `sha256:7f807ae53e13bcec7712f77c1ebaba7aab5f72d2779ed5d99d33b0e6c54e98d3` / `sha256:5d023a5323aec482781b0e992197571db9a09481a394eaf955d4598c249e4ec1` / `sha256:cbb6b355819b1eefefa7af5289b10b367c42bbe32b09f003151bc7f9ebf475d7`；G3.8A保持`sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f`不变。G4 pack/profile/implementation=`sha256:bd7b944c66181e05add3618e6355a1acc64ff452dc4c027d4556c776a4402046` / `sha256:87956027bca69d9fcdb1891298dc2a083a9e413c4530d7aff71473b74a58c106` / `sha256:1a04adf90718c7ad7f53caf93fd2a02ca00857e86ab96bfcf81ae137aef1a552`，implementation artifact=`sha256:4ced1df4314038474b41c19b313531b25bc31671969529caa33876f18d448275`；ownership=`sha256:712a7440e83f087e4bbb1e465a1a677a16708429f46766029baa0f90734e5017`，affected tree=`sha256:3d68cf3c084bee62077d5561545919a9abfc9d0ba6f3d649bb4b8ffd52cd827a`；Capacity root仍为`sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6`。

Publication/Store handoff只允许future G5消费persisted/hash-verified sealed Plan、generated content和Plan binding rows构造canonical`NodeOutputEnvelope`并持久化derived/aggregated `plan_generated` Values。本轮没有修改G5 Runtime source或业务DML；历史G5 pack退出active aggregate generate/check，不构成current候选。Gateway/Command/Invocation audit、T6e、blocker resolve/abandon、workflow deadline、manual bypass、G6+、certification与Production activation均未授权。

Construction验证全部通过：R-019/generated authority 4/4；G1.1 26/26、G1.2 24/24、Capacity/G1 60/60；G2 62/62，v4与v5真实replay均40/40 exact；G3 101/101；G4 33/33；ownership 9/9、readiness 7/7、blocker 9/9；whole G0 109/109。两轮managed `contracts:generate` + `contracts:check`均通过，生成前与两轮后的完整Contract+Schema JSON/SQL文件树摘要均为`4d241e95c63bedf121d960c2c674af632f594eb85111a178662f02222ca20481`，byte-identical。Managed `typecheck`、`build`通过；final build后`bind-core`的Core entry/binding为`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`，post-build whole G0 109/109、whole G3 101/101、Store check、readiness 7/7与blocker 9/9再次通过。

未运行完整仓库`npm test`、历史`contracts:g5:generate/check`与`test:g5`：它们包含被本轮明确禁止继续施工或重新生成的历史G5 Runtime候选，不属于current active aggregate；未运行G6+、certification或Production测试。全部实际Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec --`执行。

### Generated schema / join expose authority independent affected-chain regression

**结论**：`PASS / GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DONE`。本轮从clean local `main@866232da5a8b07a8f137282e4b133d5935c8520a`开始，parent=`1a7cf69d3e01bc38e3f1e427e4d777bc5c4940ae`；独立审阅candidate与predecessor后确认R-019、Schema 6 lineage、Compiler 3.0.3和G2 v5 successor均闭合，未沿用construction结论。环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`；没有worktree、Handoff、sub-agent、approval/escalation或历史改写，也没有恢复G5 Runtime施工或开始G6。

两轮完整managed `contracts:generate` + `contracts:check`均通过；生成前和每轮generate/check后的全Contract/Schema JSON/SQL tree digest始终为`4d241e95c63bedf121d960c2c674af632f594eb85111a178662f02222ca20481`。R-019/generated authority 16/16（其中repair Contract 4/4）、G1.1 26/26、G1.2 24/24、Capacity/G1 60/60、G2 62/62、G3 101/101、G4 33/33、ownership 9/9、readiness 7/7、blocker 9/9、whole G0 109/109、managed typecheck/build全部通过。final build后使用专用`bind-core --project-root "$PWD" --entry dist/index.js`刷新Development Core，entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`；随后whole G0 109/109、G3 101/101、Store、readiness 7/7与blocker 9/9再次通过。

Schema 5 migration相对`0a48f60`逐字节零diff，raw=`sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6`、`user_version=5`；fresh Schema 6独立migration raw=`sha256:16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41`、`user_version=6`，5到6 upgrade=`sha256:dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d`。真实SQLite覆盖fresh/reopen、3/4/5到6、非空Schema 5 Value与全部inbound FK、Registry循环、generated content/Plan binding/Value互斥authority、所有missing/ref/hash/scheme/bytes/parameter/binding drift、before-commit rollback与exact replay，并比较fresh/upgraded identity。Current G1 root/schema保持`sha256:3cc206a6dfb1bbaed1bb0f4305323729db23d839652d8a0e020a9a6c4d3e3dd6` / `sha256:37f0102a9d6b0077f0d44f20182a7d5768ce32b1c0c2c3998937178b06c9b474`。

G2 v4与current v5分别独立真实重放40/40 exact，semantic assertions 95项零失败；v5 bundle=`sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05`。专用v4/v5 replay逐项核对RC、Draft、report、GoldenSemanticReview、seal与artifact bytes/hash；aggregate输出中旧`golden:current:*`对更早predecessor保留29/40是历史预期，不作为v4/v5 replay证据。

Protected boundary：相对`0a48f60`，冻结G0.10 artifacts、G2 v1-v3完整历史Contract/review/sealed trees、G3.8A source/artifacts及Schema 5 migration均零diff；相对`1a7cf69`，G2 v4完整历史树零diff。两套`package-lock.json`及根/agent-runner dependency sections零漂移；无G5 Runtime/creation或历史G5 pack修改，无Gateway/audit/T6e/blocker resolve/abandon/deadline/manual bypass/G6+、certification或Production activation施工。`git diff/show --check`通过。历史G5 pack继续退出active aggregate，不构成current candidate。

R-019现为`CLOSED/DONE`，G1-G4 current状态恢复`DONE`；G5只提升为`READY_FOR_G5_REPAIR`，不是repair candidate或`DONE`。G6-G9继续`NOT_READY`。

### G5 Basic Runtime current Schema 6 repair exit candidate

**结论**：`G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION`，不是`DONE`。本轮从clean local `main@7005ca45b0dbe2dd0915baaab7e86c2041b1428d`开始，固定parent=`7005ca45b0dbe2dd0915baaab7e86c2041b1428d`，只消费current R-019、Database Schema 6、G2 v5 sealed Compiler/Plan、G3 publication closure、G4 bootstrap、ownership与Capacity authority重新构造current G5 repair；历史G5 Contract Pack、fixtures与reference artifacts继续只读且不进入current aggregate。没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset或历史改写，也没有开始G6。

Runtime现以persisted sealed Plan、exact generated content与`workflow_plan_generated_schemas` binding共同解析generated schema；missing pair、unknown scheme、raw/domain hash、canonical bytes、byte length、generator parameter、Plan binding、Schema authority与join shape任一漂移均稳定fail closed，不存在Registry latest、network或Runtime fallback。T2a原子持久化并exact replay generated content/binding，T2b校验output port contract hash，T3把derived/aggregated Value以Schema 6 `plan_generated` authority持久化且不伪造Published Registry resource。T4从canonical sealed input snapshot按expose rename、required/optional/default single与list aggregation生成独立port Values和canonical`NodeOutputEnvelope`；downstream data edge解析exposed port Value而非input snapshot或envelope carrier。fresh/reopen/replay、response-loss、before-commit rollback、fault injection、schema/max/port contract与idempotent replay均由真实SQLite/Runtime覆盖；既有T0-T6d、CAP0-CAP4、fencing、Fact/Event、ownership/readiness及Operational Blocker open/cache语义保持。

Current G5 closed pack=`sha256:2c9f98f135ed4ee7186aa1f8ae15528d90ca2710d674b84e04eb0e25dac68ad4`，member tree=`sha256:2d755557b235f46caabbb267f21b09833a89243420eadff7aa32d77e798df075`，protocol=`sha256:c63f4683d640a437e17c89285915e0cd47b3bdb31ea42f82c2944ce2a956d250`，reference authority=`sha256:5ba26544170e95280d4d2a9eea50a244732fa0db73c35ae07b3fad55c0d043bb`，implementation=`sha256:d874eafbd58a056d116cd9e695281374b615c7a5e4539fe1eac6f8351634bd51`，18-source tree=`sha256:e0408dcd371add87cda89546a986850e70d96bca19fc436b0440df54312faa2c`，G5 conformance JSON tree digest=`9757c8ef1dbdfada87d789d8cd5cb8ff588eae0febf2c55ad7213d69c703f936`。生成前及两轮完整managed `contracts:generate` + `contracts:check`后的全Contract/Schema JSON/SQL tree digest均为`12f03e59f56a55551ba671987f66ace3a4a8ca75709bba1015e63945ded603aa`；final aggregate check保持同一pack与Schema identities。

Construction验证全部通过：current G5 4 files / 65 tests，其中Runtime 51/51、Capacity 9/9、Contract/reference/property 5/5；readiness 7/7、blocker 9/9；R-019 repair Contract 4/4；Capacity/Schema/Store 60/60；G2 62/62且v5专用replay 40/40 exact；G3 101/101；G4 33/33；ownership 9/9；whole G0 109/109。基线`7005ca`已把R-019账本状态闭合为`CLOSED/DONE`但对应只读测试仍断言前一阶段状态，本轮只把该断言同步到current账本，不修改R-019 machine pack。Managed typecheck/build通过；final build后执行`bind-core --project-root "$PWD" --entry dist/index.js`，Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`；post-build whole G0 109/109、G3 101/101、Store、readiness 7/7、blocker 9/9与current G5 65/65再次通过。

Protected boundary相对`7005ca`为零diff：冻结G0.10 artifacts、G2 v1-v5 sealed/review trees、G3.8A、Schema 5 migration、G4 bootstrap与ownership authority均未修改；Schema 5 raw仍为`sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6`。根与agent-runner dependency sections及两套lockfile零漂移；新增production行中Gateway、Command/Invocation audit DML、T6e、blocker resolve/abandon、workflow deadline、manual retry bypass、G6+、certification、Production activation、runtime network import/fallback扫描均为0；targeted Prettier、`git diff --check`通过。G6-G9继续`NOT_READY`，下一任务只能是新的独立G5 whole-gate regression。

### G5 Basic Runtime NodeOutputEnvelope schema authority blocker

**结论**：`BLOCKED_BY_SPEC`。独立G5 whole-gate regression `019f9793-9dfb-7e91-8d72-002bd9427218`已明确拒绝current candidate；`60140018541dd02cda44a0dc2f83c5236403321f`及账本事实返修`479ec461560958308caea49bddf09e0fef00f75d`完整保留。本轮从clean local `main@479ec461560958308caea49bddf09e0fef00f75d`开始，parent=`479ec461560958308caea49bddf09e0fef00f75d`；没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset、历史改写或G6施工。

Current规范与machine authority没有共同定义canonical `NodeOutputEnvelope`自身的合法、exact、可持久化Schema authority：

1. Spec 1866-1890定义canonical envelope shape并要求T4发布完整compiled port set；Spec 4007同时要求所有inline/blob Value在写入、读取和恢复时验证Schema、Hash、byte length、typed ownership与provenance。Envelope通过`workflow_graph_nodes.published_output_envelope_value_id/hash`引用`workflow_values`，因此不能成为无Schema的例外。
2. R-019 3103-3134只为`join_expose | child_completion | map_result`定义generated descriptor、parameter shape、persisted content与Plan binding；其future G5 handoff只授权derived/aggregated Value使用`plan_generated` identity，没有定义`NodeOutputEnvelope` descriptor、generator参数或Schema bytes。Current sealed G2 v5 Plan也只携带这三类业务port schema。
3. Schema 6 `workflow_values`强制`registry | plan_generated`二选一；`plan_generated` tuple通过deferred FK绑定sealed Plan row，`generated_schema_generator` CHECK同样只接受上述三类。借用任一业务port、input snapshot或carrier Value authority会声明错误Schema；伪造Published Registry、Registry latest、network或Runtime fallback均被R-019显式禁止。
4. `generated-schema-runtime.ts:764-780`选择ASCII首个exposed业务port的authority作为`carrierAuthority`，`:874-889`却以该authority持久化整个envelope object。单string output的managed Draft 2020-12最小复现使用真实`buildCanonicalNodeOutputEnvelope()`，稳定得到`{"valid":false,"schemaPath":"#/type","message":"must be string","envelopeType":"object"}`并以exit `42`结束。
5. `graph-store.ts:106-228`的`insertInlineValue()`只验证canonical bytes和immutable tuple后写行；`generated-schema-runtime.ts:612-708`与`reconciler.ts:695-803`的读取路径也只复核JSON bytes/length与authority shape，没有加载exact schema验证payload。现有`g5-basic-runtime.test.ts:3592-3638`只断言envelope hash与各port Value authority，因此65/65不能证明envelope Value满足Spec 4007。直接补上读写Schema校验只会使现有T4稳定fail closed，不能产生合法envelope authority。

最小复现命令全部经managed toolchain执行：

```bash
./scripts/runtime-toolchain.sh exec -- npx tsx --eval '
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildCanonicalNodeOutputEnvelope } from "./src/workflow-runtime/runtime/generated-schema-runtime.ts";
const schemaHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const envelope = buildCanonicalNodeOutputEnvelope(
  { value: { schema: { schema_hash: schemaHash }, max_bytes: 4096, required: true } },
  { value: { state: "present", value_ref: "value:1", value_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111", schema_hash: schemaHash, byte_length: 3 } },
);
const validate = new Ajv2020({ strict: true, allErrors: true }).compile({ type: "string" });
const valid = validate(envelope);
const first = validate.errors?.[0];
console.log(JSON.stringify({ valid, schemaPath: first?.schemaPath, message: first?.message, envelopeType: typeof envelope }));
process.exit(valid ? 0 : 42);
'
# {"valid":false,"schemaPath":"#/type","message":"must be string","envelopeType":"object"}
# exit 42
```

唯一可接受的解阻路径是先由规范定义canonical `NodeOutputEnvelope`的closed Draft 2020-12 schema、content/hash/parameter规则与exact Stored Value binding，再以受治理successor重建受影响R-019、Schema/Plan/Compiler machine authority及下游G5 pack/evidence。若选择新的Plan-generated generator，必须同步闭合Schema CHECK/FK、sealed Plan descriptor、Publisher/Store handoff、写入与读取/恢复Schema验证、fresh/reopen/replay/rollback/fault测试；不得复用业务port schema或自行发明Registry资源。

定向验证进一步确认这是authority与coverage缺口而非flakiness：managed完整只读`contracts:check`与单独`contracts:g5:check`仍对invalid candidate pack返回PASS，readiness仍为7/7；managed `test:g5`仍为4 files / 65 tests PASS，其中Runtime 51/51包含名为`publishes canonical generated join outputs across rename, optional, default, list, rollback, reopen, and response loss`的case，却没有执行envelope row自身的Draft 2020-12校验。Managed probe则稳定exit `42`并返回上述`#/type`错误。整份历史中文账本的targeted Prettier check返回既有非零，`HEAD`原文通过stdin执行相同check也返回非零，因此未运行`--write`制造无关全文件排版churn；`git diff --check`通过。

本轮按阻塞协议不修改Runtime、Contract、fixtures、reference model、package/dependency/lockfile、G0.10、G2 v1-v5 sealed/review trees、G3.8A、Schema 5、G4 bootstrap或ownership authority，也不运行会重写current machine artifacts的generate入口。现有candidate不是current可验收authority，G5不是`DONE`，G6-G9继续`NOT_READY`。

## 下一步

下一唯一任务是新的、独立的**NodeOutputEnvelope schema authority规范/R-019/Schema/Plan定向修复**。它必须先machine-close envelope schema bytes/hash/parameter与Stored Value identity，再重建受影响Compiler/Plan/Publisher/Store/G5 authority及完整affected-chain evidence；不得在G5 Runtime内猜测fallback，不得原地改写冻结G2 v1-v5、Schema 5或其他protected trees。该repair及其独立affected-chain regression通过后，才能重新构造G5 repair candidate并安排新的独立whole-gate regression。

历史fresh review evidence只存在于Git commits，不是current dependency；current immutable semantic approval只绑定exact Draft/report identities。显式`prepare-rc`冻结的四个Working roots与唯一Review Candidate未变；current expected full case-result/Plan/proof/program bytes/hash已独立冻结、审计、owner批准并seal。local single-user签名策略为`not_required_local_single_user`，没有伪造GPG或远程签名。

G2终点继续满足`Draft -> human semantic decision -> GoldenSemanticReview -> seal -> CI replay`：current successor replay为40/40，R-017保持关闭。G3.1只消费其exact sealed/compiler identities并执行纯preflight；没有创建Published Recipe、Registry row、Release或Production launchability，也没有执行production activation。

作为历史prepare-rc切片记录，该切片只修复当时的R-017 spec identity实时绑定、级联重建Working artifacts并执行`prepare-rc`及其确定性check；在该历史切片结束时，G5为`READY`且Runtime尚未开始。后续owner approval、immutable review、successor seal与40/40 replay、R-019 authority repair及其独立affected-chain regression均已完成；G3.1-G3.9和G4既有完成证据保留，Capability/Outbox execution-binding affected chain也已独立回归闭合。Current G5因NodeOutputEnvelope Stored Value schema authority未定义而为`BLOCKED_BY_SPEC`，不是candidate或`DONE`；SQLite certification、Core Release、G6-G9 Runtime和production activation仍未开始。R-010 Node loader deprecation与R-012/R-013/R-015 timing继续作为既有范围外baseline，不升级工具链、不放宽测试。

### NodeOutputEnvelope schema authority repair exit candidate

**结论**：`NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION`，不是G5 repair candidate或`DONE`。本次定向返修从clean local `main@e218bc25c8c9c174363c696a306424c9476813b7`开始，唯一parent保持`e218bc25c8c9c174363c696a306424c9476813b7`；前一NodeOutputEnvelope authority candidate `494690a603e70da46c4e91ae4d50e599b05c81f4`及docs correction `e218bc2`完整保留。独立affected-chain regression `019f985a-e016-7530-80c7-73e5aeeec34d`已按首个失败停止并证明旧v6 Golden authority不成立；本轮只形成修复后的新candidate，不复用该失败任务，也不声称新回归通过。环境为`permission_profile=disabled/unrestricted`、filesystem unrestricted、approval policy `never`；没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset或历史改写，没有继续G5 Runtime施工或开始G6。

R-019现在唯一规定每个compiled Plan node携带closed Draft 2020-12 canonical `NodeOutputEnvelope` schema：schema的property集合与compiled output port集合exact相等，每个port只能是closed `present | absent` union；present绑定Value ref/hash/schema hash/byte length，absent不伪造Value，required port不得absent。Envelope canonical bytes、raw/domain hash、`node_output_envelope` generator parameter hash、schema ref、byte length与exact sealed Plan binding全部machine-close，不得借用业务port/input snapshot schema，不得使用Registry latest、network/fallback或伪造Published Registry。

Schema 7不新增表或列；它在单一事务中rebuild既有`workflow_plan_generated_schemas`与`workflow_values`，只把两处generator CHECK的closed catalog扩展为第四个`node_output_envelope`。`workflow_values.schema_authority_kind`仍严格只有`registry | plan_generated`两种；NodeOutputEnvelope是`plan_generated`下的`generated_schema_generator`，通过既有deferred composite FK绑定exact `workflow_plan_generated_schemas` row。6到7 upgrade保留全部Schema 6合法row与inbound FK。专用Store边界在write/read/replay/reopen/recovery逐次验证canonical payload、Draft 2020-12 schema、raw/domain/parameter hash、schema ref、length、ownership、provenance、Plan/port-set binding与Value tuple，任一missing、wrong authority、payload/schema pair tamper或hash/length/ownership/provenance drift均fail closed；fault点完整rollback，exact replay不增写。

Compiler 3.0.4与G2 v6为additive successor，每个Plan node确定性lower exact envelope descriptor。失败根因是successor实际import/invoke `src/workflow-runtime/contracts/node-output-envelope-golden-authoring.ts`，raw=`sha256:a574091ca544a7b838936403d1bd55d3f1757468d453d5205aaa6f8a11f897ec`，旧Draft却声明v5 generator `generated-schema-join-authority-golden-authoring.ts`，raw=`sha256:6c5b9d0387b4535731b9d9029f503c2b08703cfa4ed3dcb2af7ad3b91087f031`。新增AST exact checker要求三个authoring helper来自同一import且expected-result generator恰好调用一次，并把resolved import/ref/raw hash绑定到Draft与semantic approval。`positive.static-lowering`证明旧generator envelope descriptor为0/3、result=`sha256:707cc336c6b96732d9c3bf96e42ee21d46db4b636912e50598dffdcb974a4ea4`，新generator为3/3、result=`sha256:a09b8c0ef277d3a71cd486ccb96fedb2afe32ac15f05a86d2cbf5e071c95d394`；新result/Plan/proof/program bytes与v6 expected exact一致，旧generator不能冒充v6 authority。

v5保持真实40/40 exact replay；v6 Working contract/input/candidate/review roots仍为`sha256:19abd5ba1470e9583fd9fa747a3a2aa65ffa710c6607e5a1c7c15e43cdda8ed9` / `sha256:a744a61c0feac29abdf089c36996593423f559f48c45503167f2cf4f70a8657d` / `sha256:2d8920c8c68d9022184d65d63dd0283040781f77e136f6bdc0ef56118a152bfe` / `sha256:02afbf8dcfa994579f9180047fe7a13d919027f324d71fc5db0bd8bfe300f314`，RC=`sha256:64fec8c48d3c6685f83bce980b8f85c03ce0d989aaa944e85e6a0d61c40297f1`；重建后的Draft internal/artifact=`sha256:56538abb3748d134b25e1eee26e2d6198784b456412a60a3ce1c34ee5d79c804` / `sha256:b43960ab002a49d918bddbce057e51e1055b65e2e7a1d10e44fed25c28ea66c4`，review internal/artifact=`sha256:b909526bc8d4c76d3a1079bee54de072eb6dd7bdd16ee3ae91b27d1f9a6954b1` / `sha256:4ebc90aa4028f68580fa2aaaaaf23ef7e27bd61c9e285a8f648a42278b0e9aa0`，GoldenSemanticReview internal/artifact=`sha256:0d1c4f636ef7c819aa62cd255dca9e67d6a27bbca689d88e0a791338b463fbb9` / `sha256:09725beed1ff8370eec5a095968bf1ac8c3d8dcb68c1a8b01e36f102528a6db5`，seal internal/artifact=`sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7` / `sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11`；current replay为40/40 exact。R-019=`sha256:7a852ff21a77a767b708ab8a4fc5c329024ca954422b26d71210b0385ce05441`；G1 root/schema=`sha256:b60e3c7fe91d1cfab341d487102c7bff13ad73a320444b45fb6ea71d8b914306` / `sha256:27a212831d2abd8898eb8becbfd714d96b1bfb15d818d471cfc58fdc36196e65`；Schema 7/6到7=`sha256:b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497` / `sha256:225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062`。

受影响current closure已级联重建但保持reopened/pending independent regression：G3.1/G3.3/G3.5/G3.6/G3.7/G3.9=`sha256:54355b3c74eb311e495ea31effcbfca6e3ce7547f2ccae663805556060b0b685` / `sha256:746280b172ab970a953a20aaaf3dbff557fa7aaecfad6e20bcedc0a0171d72cb` / `sha256:0ef337e5b94dcbd279589a7522744462e7a5240e12be54cd47f6afd413675ed1` / `sha256:207c7604cf8157dc6e17fe4440bdb6651fed22018e094d0a4342e4dce3c1117d` / `sha256:d25e7842961ee76b5736b3217628daf5adf7cd00b52d64c15020b7a2bde3f622` / `sha256:5411955aa8cd10888fb1ca3df38f311d0a0310d2bd5570ef1f7a9ed41fe08d95`；G4 successor=`sha256:2b27a8fad1e9a690922186d11bc173f4242174efc843c3eb35e8dfeb94f5c34f`；frozen ownership checker=`sha256:712a7440e83f087e4bbb1e465a1a677a16708429f46766029baa0f90734e5017`；current readiness=`sha256:df8fddc636ac9e4eb0835a26e88c47f7565969f04e95ac33b59d7f16bc5cd2e8`。

Construction与post-build验证全部通过：两轮完整managed `contracts:generate` + `contracts:check`均PASS，Contract+Schema JSON/SQL摘要在生成前及两轮后均为`fbf34441ee0f1584c608ff1858d0711d57d5af869d4c63bb7694299e94e60b10`且byte-identical。R-019 4/4；G1.1 27/27；current Capacity/Schema/Store aggregate 64 passed / 2 frozen historical assertions skipped；Runtime Store 25/25；NodeOutputEnvelope Store 14/14；G2 65/65，current/historical Golden suite 29/29，并v5/v6各40/40 exact replay；G3 101/101；G4 successor 2/2；ownership 1/1；readiness 2/2；blocker 8/8；whole G0 104 passed / 7 frozen historical absence assertions skipped。package `test:g1.capacity`与`test:g0`的精确negative filters均按现有入口执行并通过，没有修改测试过滤规则。

Managed `typecheck`、`build`与`git diff --check`通过；final build后执行`./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js`，Development Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`。随后再次通过whole G0 104/7、whole G3 101/101、Store check、readiness 2/2、blocker 8/8与NodeOutputEnvelope Store 14/14，排除旧active binding假阳性。

Protected boundary相对`e218bc2`为零diff：G0.10/G0.3 source/artifacts、G2 v1-v5 review/semantic-review/sealed trees、G3.8A、Schema 5与Schema 6 fresh/upgrade migrations、历史G4 bootstrap source/member tree、既有ownership authority、根与agent-runner dependency sections、两套`package-lock.json`全部冻结。明确的408-path protected tree在base/current摘要均为`fb8eb6fa76cbda4f1f342ad0759b5fc03ca6282477235dfa65afaa9925268d53`；根/agent-runner dependency摘要=`a5601c1631b0232361c3a50b8661218d3674a6c0bb7f0d363d903ded3e308b3a` / `6267f1954ff0de74ca00074d1c1dfe15f47f34179f8cdb93c64c8805f804b624`，lockfile raw=`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`。`generated-schema-runtime.ts`与`basic-scheduler.ts`保持baseline raw SHA-256 `01f3118ade3563d1b06ad053d760bc175896454fd6ba23c3c84c192683f6dd9c` / `c80144ecef8efd58de2730ea6623bfd42a8adf9fa452c64352557a9bcdb354de`；Runtime目录零changed path。Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual bypass、certification、G6-G9、Production activation及对应新增路径扫描均为0。

无论construction全部PASS，本提交只形成repair exit candidate。Current G1-G4不得提前恢复`DONE`；G5继续`BLOCKED_BY_SPEC/NOT_READY`，G6-G9继续`NOT_READY`。下一任务只能由中控从本candidate创建新的独立NodeOutputEnvelope authority affected-chain regression；任何candidate或authority identity变化都必须重新创建该独立回归。

### NodeOutputEnvelope authoring local-binding directed successor

**结论**：`NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION`。本次独立施工从clean `main@94f50cbeba6a349003aa0d8612c65fe360a860c1`开始；前一独立regression已FAIL且没有修改仓库。本轮只修复`authoringGeneratorIdentity()`的TypeScript binding checker并补齐定向测试，不复用失败回归、不声称新回归通过，不修改或开始G5 Runtime/G6+，也没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset或历史改写。

Checker现在为successor source创建内存TypeScript Program，通过TypeChecker symbol identity把三个named helper分别唯一绑定到exact `../contracts/node-output-envelope-golden-authoring.js`。三个helper可以位于同一或拆分的exact-module import declaration，并接受合法local alias；expected-result helper只能通过该import symbol direct call恰好一次且不得逸出。Wrong module、missing/type-only/namespace helper、duplicate export import、local-name conflict、zero/two/optional/indirect call、declared-ref drift、equivalent-path source drift、unrelated same-export-name local、lexical shadow和其他非唯一形式全部fail closed。GoldenSemanticReview继续把实际authoring source raw bytes绑定到approved Draft，source-byte drift不能进入approval/seal链。

受治理生成结果证明本修复不改变任何G2 v6语义或current artifact identity。`positive.static-lowering`仍为v5 envelope descriptor 0/3、result `sha256:707cc336c6b96732d9c3bf96e42ee21d46db4b636912e50598dffdcb974a4ea4`，v6为3/3、result `sha256:a09b8c0ef277d3a71cd486ccb96fedb2afe32ac15f05a86d2cbf5e071c95d394`；v6 result/Plan/proof/program bytes与Draft/review/semantic-review/seal/replay exact。R-019/G1/Schema 7/6到7、v6 RC/Draft/review/GoldenSemanticReview/seal、G3.1/3.3/3.5/3.6/3.7/3.9、G4、ownership与readiness identities全部保持上一candidate记录值。

两轮完整managed `contracts:generate` + `contracts:check`均PASS；Contract+Schema JSON/SQL digest在生成前和两轮后均为`fbf34441ee0f1584c608ff1858d0711d57d5af869d4c63bb7694299e94e60b10`，v6 tree digest均为`2d7c0f5f31877df8cf87bf7f5bd3a55f7e22a8cdef4758981bcbd91e11e877df`，无JSON/SQL或generated artifact diff。AST/source-byte矩阵与G2 successor合计32/32；R-019/generated-schema 16/16；Schema 7/6到7 27/27；Capacity/package compatibility 64 passed / 2 frozen-history skipped；Runtime Store 25/25；NodeOutputEnvelope Store 14/14；G2 92/92、Golden current/historical 56/56并v5/v6各40/40 exact；G3 101/101；G4 2/2；ownership 1/1；readiness 2/2；blocker 8/8；whole G0 104 passed / 7 frozen-history skipped。真实SQLite、Ajv、managed toolchain与package compatibility路径均已执行。

Managed `typecheck`、`build`与targeted Prettier check通过；final build后Development Core entry/binding为`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`。Post-build再次通过whole G0 104/7、G3 101/101、Store check，以及readiness/blocker/NodeOutputEnvelope Store合计22/22。

Protected boundary相对`94f50cb`保持零diff：G0.10/G0.3、G2 v1-v5 review/semantic-review/sealed、G3.8A、Schema 5/6、历史G4、ownership authority、dependencies/两套lockfile、`generated-schema-runtime.ts`、`basic-scheduler.ts`均冻结；Runtime目录无changed path。Gateway/audit/T6e、blocker resolve/abandon、deadline、manual bypass、certification、Production、G6-G9新增surface为0。Current G1-G4继续`REOPENED/PENDING`，G5继续`BLOCKED_BY_SPEC/NOT_READY`，G6-G9继续`NOT_READY`；下一任务仍只能由中控创建新的独立NodeOutputEnvelope authority affected-chain regression。

### NodeOutputEnvelope authoring alternate-module-access directed successor

**结论**：`NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION`。本轮从clean local `main@946d326bf178aae65a1af0f04857498221efbd61`开始，唯一parent为`94f50cbeba6a349003aa0d8612c65fe360a860c1`。前一独立回归在clean `946d326`以498-byte source fixture（raw=`sha256:6858643389865d79803ce763bcbd87158d06387744341eaa5c4d26a9874a3ed3`）证明`import("../contracts/node-output-envelope-golden-authoring.js", {})`会被错误接受并返回authoring ref `src/workflow-runtime/contracts/node-output-envelope-golden-authoring.ts`与raw `sha256:a574091ca544a7b838936403d1bd55d3f1757468d453d5205aaa6f8a11f897ec`；该回归按首个失败停止且没有修改仓库。本轮施工前又以等价486-byte fixture（raw=`sha256:e194d54909295205fdee72337101fa5ff5f9c2a4d46ab6d1e0dc1fb1e8bdcb0e`）独立复现同一错误identity。

Checker现在只要CallExpression首个参数是exact authoring module string literal或no-substitution template literal，就不再依赖参数个数而拒绝dynamic import与direct `require`；specifier和direct require callee的合法parentheses会先规范化。因此`import(specifier)`、trailing comma、empty options、import attributes/options、template/parenthesized exact specifier，以及one/two-argument、parenthesized或template-specifier direct require均fail closed。TypeScript Program/TypeChecker symbol identity、三个unique named helper、exact module/ref/raw binding与direct expected-result call规则未放宽；普通named import、合法alias和exact-module split import继续接受。Wrong/equivalent module、missing/type-only/namespace/default/dynamic/require、duplicate/conflict、zero/two/optional/indirect/direct-plus-indirect call、declared-ref/source-byte drift、unrelated same-export-name local与lexical shadowing继续拒绝。

定向AST/source-byte与G2 successor矩阵为39/39；其中新增empty options、import attributes、template/parenthesized dynamic specifier、extra-argument require、parenthesized require与template require negatives全部实际执行。`positive.static-lowering`继续证明v5 descriptor=0/3、v6=3/3，v6 result=`sha256:a09b8c0ef277d3a71cd486ccb96fedb2afe32ac15f05a86d2cbf5e071c95d394`且result/Plan/proof/program bytes exact。R-019/generated-schema为16/16，compatibility 2/2；Schema 7/6到7为27/27；Capacity/Schema/Store为64 passed / 2 frozen-history skipped；NodeOutputEnvelope Store为14/14；G2为99/99且v5/v6各40/40 exact replay；G3为101/101；G4 2/2；ownership 1/1；readiness 2/2；blocker 8/8；whole G0为104 passed / 7 frozen-history skipped。完整managed `contracts:check`两次PASS，managed `typecheck`与changed TypeScript targeted Prettier PASS；没有运行任何generate入口。

Contract+Schema JSON/SQL tree digest在施工前后均为`fbf34441ee0f1584c608ff1858d0711d57d5af869d4c63bb7694299e94e60b10`，无generated artifact漂移。R-019/G1/Schema 7/v6 Draft-review-GoldenSemanticReview-seal、G3/G4/ownership/readiness identities保持上一candidate全部exact值；`generated-schema-runtime.ts`与`basic-scheduler.ts` raw继续为`01f3118ade3563d1b06ad053d760bc175896454fd6ba23c3c84c192683f6dd9c` / `c80144ecef8efd58de2730ea6623bfd42a8adf9fa452c64352557a9bcdb354de`。相对`946d326`，只允许checker、directed test、Contract README与本账本四个changed paths；G0.10/G0.3、G2 v1-v5 review/semantic-review/sealed、G3.8A、Schema 5/6、历史G4、ownership、dependencies/两套lockfile及完整Runtime保持零diff。Gateway/audit/T6e、blocker resolve/abandon、deadline/manual bypass、certification、Production与G6+新增surface为0。

本提交仍只形成新的directed repair exit candidate，不复用或关闭失败的独立回归。Current G1-G4继续`REOPENED/PENDING`，G5继续`BLOCKED_BY_SPEC/NOT_READY`，G6-G9继续`NOT_READY`；下一任务只能由中控从本candidate创建fresh independent NodeOutputEnvelope authority affected-chain regression。

### NodeOutputEnvelope authoring transparent-expression directed successor

**结论**：`NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION`。本轮从clean local `main@06d6512a5324de205f56375a3e0e7938aa7b03ee`开始，唯一parent为`946d326bf178aae65a1af0f04857498221efbd61`。已关闭的失败回归`019f99b9-0094-74b3-a261-cb4af914684c`没有被查询、复用或误记为PASS；没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset、历史改写、generate入口、G5 Runtime续工或G6+施工，全部Node/npm/npx命令均经`./scripts/runtime-toolchain.sh exec --`执行。

Checker现在使用单一递归AST may-evaluate predicate识别exact authoring module access。它先规范化parentheses、`as`、angle-bracket type assertion、`satisfies`、non-null与`await`，再按运行期结果检查comma/sequence的右值、conditional两支、logical-and右值以及logical-or/nullish两侧可能结果；leaf只接受exact string literal或no-substitution template。Dynamic import不受argument count影响，因此plain、trailing comma、options/import attributes及上述任意嵌套组合均fail closed。Direct `require`对specifier复用同一predicate，并对callee应用相同透明/result表达式识别，因此parenthesized、`as`、type assertion、`satisfies`、non-null、sequence/conditional与optional wrapped callee同样拒绝；plain、template与extra arguments保持拒绝。Wrapped unrelated-module dynamic import/require继续通过positive control，没有把规则扩大为禁止任意动态加载。

TypeChecker symbol identity、三个unique named helper、exact module/ref/raw source binding与expected-result helper恰好一次direct call规则均未放宽。Normal、alias与split same-module named import positives继续接受；wrong/equivalent module、missing/type-only/namespace/default/dynamic/require、duplicate/conflict、zero/two/optional/indirect/direct-plus-indirect call、declared ref/source-byte drift、unrelated same-export local与shadowing negatives继续拒绝。

定向AST/source-byte与successor suite为69/69，其中binding矩阵63/63实际覆盖已确认的`as const`、`satisfies`、non-null、comma/sequence以及相邻conditional/logical/await和wrapped callee形式。`positive.static-lowering`仍证明v5 descriptor=0/3、v6=3/3，v5/v6 result分别为`sha256:707cc336c6b96732d9c3bf96e42ee21d46db4b636912e50598dffdcb974a4ea4` / `sha256:a09b8c0ef277d3a71cd486ccb96fedb2afe32ac15f05a86d2cbf5e071c95d394`；v6 result/Plan/proof/program bytes与approved Draft/review/GoldenSemanticReview/seal/replay exact。

Affected-chain验证全部通过：R-019/generated-schema 16/16；Capacity/Schema/Store 64 passed / 2 frozen-history skipped；NodeOutputEnvelope Store 14/14；G2 129/129；current/historical Golden 93/93；v5/v6 current replay 40/40 exact；G3 101/101；G4 successor 2/2；ownership 1/1；readiness 2/2；blocker 8/8；whole G0 104 passed / 7 frozen-history skipped。两次完整managed `contracts:check`、managed `typecheck`、changed TypeScript targeted Prettier与`git diff --check`通过；没有运行generate。

Contract+Schema JSON/SQL digest保持`fbf34441ee0f1584c608ff1858d0711d57d5af869d4c63bb7694299e94e60b10`，无JSON/SQL/generated artifact drift。`generated-schema-runtime.ts`与`basic-scheduler.ts` raw保持`01f3118ade3563d1b06ad053d760bc175896454fd6ba23c3c84c192683f6dd9c` / `c80144ecef8efd58de2730ea6623bfd42a8adf9fa452c64352557a9bcdb354de`。两套lockfile raw保持`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`，根与agent-runner dependency sections相对`06d6512`逐字节不变。相对`06d6512`只允许checker、directed test与本账本三个changed paths；G0.10/G0.3、G2 v1-v5 review/semantic-review/sealed、G3.8A、Schema 5/6、历史G4、ownership、完整Runtime、dependencies/lockfiles及全部forbidden surface保持零diff。

本提交仍只形成新的directed repair exit candidate，不声称fresh independent regression PASS。Current G1-G4继续`REOPENED/PENDING`，G5继续`BLOCKED_BY_SPEC/NOT_READY`，G6-G9继续`NOT_READY`；下一任务只能由中控从本candidate创建fresh independent NodeOutputEnvelope authority affected-chain regression，不得开始G5或G6+。

### NodeOutputEnvelope schema authority fresh independent affected-chain regression

**结论**：`PASS / NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_DONE`。本轮从clean local `main@8d7a4c5aeba9d38ebfc32cbf79cfa51da6b00198`开始，唯一parent为`06d6512a5324de205f56375a3e0e7938aa7b03ee`；独立复读完整规范、进度账本、candidate exact三路径diff、checker/测试矩阵、authority identity与protected/forbidden boundary，没有沿用construction结论。初次final build后的`bind-core`只因child-host sandbox无法在本机Runtime Home创建`mktemp`而在产品执行前中断；中控在同一clean candidate上复跑成功，本次在`permission_profile=disabled/unrestricted`、filesystem unrestricted、sandbox `danger-full-access`、approval policy `never`的resumed local环境再次执行同一exact命令并exit 0，确认该中断不是candidate或product failure。没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset、历史改写或G5/G6+施工；candidate code与全部machine authority始终只读。

独立AST/source-byte矩阵为63/63：normal、alias、split exact-module named import与wrapped unrelated-module access均返回exact authoring identity；dynamic import/direct require的literal、no-substitution template、trailing/options/import attributes、extra args、parentheses、`as const`、angle assertion、`satisfies`、non-null、`await`、two/multi-comma、conditional、logical/nullish、nested wrapper、wrapped/optional/generic require callee及import-equals全部fail closed。原始相邻`as const`复现fixture为491 bytes、raw=`sha256:0ce867ae68932edabf060a4116ac160d77b278efb6f8a20e5af2eadc601df825`，expected/actual均为拒绝；authoring ref/raw exact为`src/workflow-runtime/contracts/node-output-envelope-golden-authoring.ts` / `sha256:a574091ca544a7b838936403d1bd55d3f1757468d453d5205aaa6f8a11f897ec`。Checked-in current/historical Golden suite为93/93，G2 aggregate为129/129；TypeChecker symbol identity、exact三个unique helpers、ref/raw source binding、一个direct expected-result call与全部wrong/equivalent/missing/type-only/namespace/default/duplicate/conflict/call-count/escape/shadow/source-drift negatives保持闭合。

`positive.static-lowering`继续证明v5 descriptor=0/3、v6=3/3，v5/v6 result分别为`sha256:707cc336c6b96732d9c3bf96e42ee21d46db4b636912e50598dffdcb974a4ea4` / `sha256:a09b8c0ef277d3a71cd486ccb96fedb2afe32ac15f05a86d2cbf5e071c95d394`，v6 result/Plan/proof/program bytes与approved Draft/review/GoldenSemanticReview/seal/replay exact。v6 Working contract/input/candidate/review roots=`sha256:19abd5ba1470e9583fd9fa747a3a2aa65ffa710c6607e5a1c7c15e43cdda8ed9` / `sha256:a744a61c0feac29abdf089c36996593423f559f48c45503167f2cf4f70a8657d` / `sha256:2d8920c8c68d9022184d65d63dd0283040781f77e136f6bdc0ef56118a152bfe` / `sha256:02afbf8dcfa994579f9180047fe7a13d919027f324d71fc5db0bd8bfe300f314`，RC=`sha256:64fec8c48d3c6685f83bce980b8f85c03ce0d989aaa944e85e6a0d61c40297f1`，Draft/review/GoldenSemanticReview/seal internal=`sha256:56538abb3748d134b25e1eee26e2d6198784b456412a60a3ce1c34ee5d79c804` / `sha256:b909526bc8d4c76d3a1079bee54de072eb6dd7bdd16ee3ae91b27d1f9a6954b1` / `sha256:0d1c4f636ef7c819aa62cd255dca9e67d6a27bbca689d88e0a791338b463fbb9` / `sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7`，对应artifact=`sha256:b43960ab002a49d918bddbce057e51e1055b65e2e7a1d10e44fed25c28ea66c4` / `sha256:4ebc90aa4028f68580fa2aaaaaf23ef7e27bd61c9e285a8f648a42278b0e9aa0` / `sha256:09725beed1ff8370eec5a095968bf1ac8c3d8dcb68c1a8b01e36f102528a6db5` / `sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11`。Approval固定`human:local-owner`、`approved`、`reviewed_at_ms=1784970823000`，exact绑定上述Draft/review；没有stale actor/time/id。G3.1/3.3/3.5/3.6/3.7/3.9、G4 successor与readiness checks均消费current v6 seal，无旧seal pin。

完整affected chain全部通过：R-019/generated-schema 16/16，package compatibility 2/2，Schema 7/6到7 27/27，Capacity/Schema/Store 64 passed / 2 frozen-history skipped，NodeOutputEnvelope Store 14/14，v5/v6各40/40 exact replay，G3 101/101，G4 successor 2/2，ownership 1/1，readiness 2/2，blocker 8/8，whole G0 104 passed / 7 frozen-history skipped。真实SQLite 3.53.2、Ajv、managed Node 26.5.0/native module、package compatibility与既有exact negative filters均实际执行。两轮完整managed `contracts:generate` + `contracts:check`均PASS；Contract+Schema JSON/SQL digest在生成前、两轮generate/check之间及最终均为`fbf34441ee0f1584c608ff1858d0711d57d5af869d4c63bb7694299e94e60b10`，checkout每轮均byte-clean。Managed `typecheck`、targeted Prettier、`build`与`git diff --check`通过。

Final build后exact `./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js`成功，Runtime Launcher为`/Users/chelaile/Library/Application Support/Icarus/bin/icarus-runtime`，active binding kind=`development_checkout`，Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`。Post-build再次通过whole G0 104/7、whole G3 101/101、Store check、NodeOutputEnvelope Store 14/14、readiness 2/2与blocker 8/8，排除stale active binding假阳性；post-build whole G0内嵌完整`contracts:check`并重验R-019、Schema、v5/v6 replay、G3/G4/ownership/readiness identities。

最终protected boundary相对`06d6512`为零diff：G0.10/G0.3 source/artifacts、G2 v1-v5 review/semantic-review/sealed trees、G3.8A、Schema 5/6 fresh及upgrade migrations、历史G4 bootstrap、ownership authority、根与agent-runner dependency sections、两套lockfile及完整Runtime tree全部冻结。Contract+Schema digest保持`fbf34441ee0f1584c608ff1858d0711d57d5af869d4c63bb7694299e94e60b10`；Runtime tree=`a12b35b18f8650444001d7a66bd6c4bf256212df41605f4a25e2e9dc22fe233f`；`generated-schema-runtime.ts` / `basic-scheduler.ts`=`01f3118ade3563d1b06ad053d760bc175896454fd6ba23c3c84c192683f6dd9c` / `c80144ecef8efd58de2730ea6623bfd42a8adf9fa452c64352557a9bcdb354de`；root/agent-runner lockfile=`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`。相对parent仍只有checker、directed test与本账本三个changed paths；Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual bypass、certification、Production、dependencies/lockfiles、G6+及其他forbidden新增或changed surface均为0。

R-019与NodeOutputEnvelope schema authority repair现为`CLOSED/DONE`、`NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_DONE`，G1-G4 current closure恢复`DONE`。G5只提升到`READY_FOR_G5_REPAIR/NOT_DONE`，不是repair candidate或`DONE`，本轮没有实现G5；G6-G9继续`NOT_READY`。下一任务只能是新的G5 repair construction，之后仍需独立G5 whole-gate regression。

### 2026-07-25：G5 Basic Runtime NodeOutputEnvelope repair exit candidate

**结论**：`G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION`，不是`DONE`。本次独立G5 repair从clean local `main@a75076f3c6ff140616c8002da6d6bd1599e0dbe9`开始，唯一parent=`a75076f3c6ff140616c8002da6d6bd1599e0dbe9`。施工前完整复读架构规范、本进度账本、G5实现索引主要入口/必须联读/验收条款，并记录`git status --short`、branch、五条log及`a75076f3` stat/精确diff；历史G5 Runtime/Contract/fixtures/reference只作为失效输入审计，没有复用其identity或测试结论。没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset或历史改写，没有开始G6。

Current G5 Contract Pack被独立重建为`sha256:84b6de036a9ef137ed0db6b5a715c440fa4d0b93eab7dc5f96984f43ab273582`，member tree=`sha256:3abd116319e0f3fac16be4135a43297f02ff156e47fe3f8a7ee5e8f31bff8406`；protocol/positive/negative/fault=`sha256:d269db10b7e4ae10de2cc52e01ae08df525b59f574b88ecb633dddae08d70667` / `sha256:67f1a94acf041beed1bf6b230c6e1e6ea3beace1c17e6244bf18f373de9c8e57` / `sha256:2f05e5472f7416358c9bc1369874eca1977ac766fd96e15533c34fbda195ab9d` / `sha256:172324f37d126ed84e52d846d691bc1dcdef9d345d0930c2f186f6233db79d9e`，reference/evidence tree=`sha256:f1a78a4e6d64940de3088162d04775f5135b7f8764d640ac77369620539f4efb` / `sha256:aebacebbbd2dab4e78f7ec28c3a3fd3d7a2119dfa2b44ac36fb4ad889d66b81d`，implementation/18-source tree=`sha256:8107311c6ca5c26b1da2410200f94410b0fdc6c9f08323b2d04b356418ffec71` / `sha256:700921bd70425d5448316444263dcbb08a1fcb409a54b37fd186aac82646c206`。Pack exact绑定closed R-019=`sha256:7a852ff21a77a767b708ab8a4fc5c329024ca954422b26d71210b0385ce05441`、Schema 7=`sha256:b60e3c7fe91d1cfab341d487102c7bff13ad73a320444b45fb6ea71d8b914306`、G2 v6 sealed artifact/bundle=`sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11` / `sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7`及current G3/G4、ownership、Capacity identity。Closed fixtures为21 positive / 28 negative / 17 fault，覆盖G5-owned T0-T6d、Capacity、blocker与Store envelope recovery；历史candidate pack/member/reference/implementation不进入current aggregate。

Runtime现在由一个`persistNodeOutputEnvelope()`边界统一完成T4、terminal T6a与durable-wait T6c输出。Envelope只消费sealed Plan node的exact `output_envelope_schema`；present member仍绑定各自business-port schema，envelope自身绝不复用业务port/input/carrier schema。所有derived/aggregated member与canonical envelope逐项验证schema ref/hash、canonical payload bytes/content hash/length、exact Plan和port-set、graph-run ownership、Store provenance与`row_version=0`，并通过Schema 7 `NodeOutputEnvelopeValueStore.write/read/exact replay/reopen/recovery`。T6a必须提供并只可发布Plan exact output-port set，T6c只发布typed `{resolution: payload}`；reconciler删除root-property、inline Value、implicit result与Plan/Schema fallback并逐项验证immutable port tuple，不能自行猜测或fabricate authority。

静态闭环继续覆盖intake/routing/domain claim、state lowering/context/transition、static graph reconcile/scheduler/ledger、exact execution binding、Capability Effect/Outbox、durable wait/signal/timer/approval/inbox、automatic retry timers、Capacity Admin及Operational Blocker create/open/cache。Fixed SQLite/fault/property/differential evidence覆盖rollback、response loss、reopen/replay/recovery、same-key duplicate/conflict、stale lease/epoch/fence、schema/hash/length/tamper、unknown/lost receipt、late callback、wait race、automatic retry与Capacity lineage；T6e、blocker resolve/abandon、workflow deadline、manual retry bypass、Gateway/audit、certification、Production及G6+均未实现。

生成与identity证据闭合：施工前Contract/Schema JSON/SQL tree digest=`fbf34441ee0f1584c608ff1858d0711d57d5af869d4c63bb7694299e94e60b10`，历史失效G5 pack/member/protocol/reference/implementation/source tree分别为`2c9f98f135ed4ee7186aa1f8ae15528d90ca2710d674b84e04eb0e25dac68ad4` / `2d755557b235f46caabbb267f21b09833a89243420eadff7aa32d77e798df075` / `c63f4683d640a437e17c89285915e0cd47b3bdb31ea42f82c2944ce2a956d250` / `5ba26544170e95280d4d2a9eea50a244732fa0db73c35ae07b3fad55c0d043bb` / `d874eafbd58a056d116cd9e695281374b615c7a5e4539fe1eac6f8351634bd51` / `e0408dcd371add87cda89546a986850e70d96bca19fc436b0440df54312faa2c`，历史G5 conformance tree=`9757c8ef1dbdfada87d789d8cd5cb8ff588eae0febf2c55ad7213d69c703f936`。首两轮完整managed aggregate generate/check后的Contract/Schema tree均为`5618e6de04e046ce2dbf686879db72acb4533552ab20fda8f11fc1f446edf4f5`；scoped Prettier改变implementation source bytes后又完成两轮完整managed aggregate generate/check，最终两轮Contract/Schema tree均为`502fc7f0f37dfb4c62c93a345a50851f7069a6ffc2c9f1066f2fb68b6655c39f`、G5 conformance tree均为`c8ddd686ac5e07cca31771d0af25b525398c81e1e3079ed2a7cd39a3a8616b5a`及上述最终pack/member/reference/implementation/source identities，证明最终byte identity。

Construction affected chain全部通过：NodeOutputEnvelope Store 14/14；G5 90/90（Runtime 76、Capacity 9、Contract/reference 5）；readiness 7/7；blocker 6/6；R-019与package compatibility 6/6；Schema 7和6到7 27/27；Runtime Store 25/25；Capacity/Schema/Store aggregate 63 passed / 1 frozen skip；G2 129/129；current/historical Golden 93/93；v5与v6各40/40 exact replay；G3 101/101；G4 2/2；ownership 1/1；whole G0 104 passed / 7 frozen skips。两轮完整managed aggregate generate/check、managed `typecheck`均PASS；真实SQLite 3.53.2、Ajv、managed Node 26.5.0/native module及必要property/differential paths实际执行。

Final managed `build`通过，随后exact执行`./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js`，Runtime Launcher=`/Users/chelaile/Library/Application Support/Icarus/bin/icarus-runtime`，binding kind=`development_checkout`，Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`。Post-build再次通过whole G0 104/7、G3 101/101、Store check、NodeOutputEnvelope Store 14/14、G5 90/90、readiness 7/7与blocker 6/6，排除stale active binding假阳性。

最终scoped Prettier、独立账本新增snippet Prettier、`git diff --check`与28-path exact changed-path audit均PASS。相对`a75076f3`，G0.10/G0.3、G2 v1-v5 review/semantic-review/sealed trees、G3.8A、Schema 5/6 fresh及upgrade、历史G4 bootstrap、ownership authority，以及current R-019/Schema 7/G2 v6/G3/G4 authority的精确`git diff --exit-code`全部为0；production source forbidden scan没有Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual retry bypass、certification、Production或G6+新增实现。Root/agent-runner dependency section digest=`6fb340eddb33436284777f1c4d86a3c76a7d4ac29cf03cc3609ce291abd0f177` / `141fc7778ca0fca4d66bcabc76c9794cd170b1184f7987093b6f481214784116`且相对base逐字节一致；两套lockfile raw=`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`且零diff。最终Contract/Schema、G5 conformance与pack/member/reference/implementation/source identities保持上文exact值。

本提交只允许形成G5 repair exit candidate。G5不标记`DONE`；G6-G9保持`NOT_READY`。下一步只能由中控基于本candidate exact bytes创建fresh independent G5 whole-gate regression，且在该独立回归通过前不得开始G6或扩大到任何forbidden surface。

### 2026-07-25：G5 fixture-execution false-positive directed repair candidate

**结论**：`G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION/NOT_DONE`。本轮从clean local `main@1eac421abad44d6bc95894faee8f498b8612cbd1`开始，本原子提交唯一parent固定为`1eac421abad44d6bc95894faee8f498b8612cbd1`；前序G5 candidate `2f52212d22cf01ddee47c45249961416e286def8`及其parent `a75076f3c6ff140616c8002da6d6bd1599e0dbe9`只作为精确diff审计输入。Fresh independent regression `019f9add-028d-73a3-ba81-cbe8138b09ba`的结论保持`FAIL`且任务已closed，本轮没有查询、恢复或发送消息，也不把其失败结果改记为PASS。没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset或历史改写，没有开始G6。

Confirmed finding已关闭：21 positive / 28 negative / 17 fault records现在携带closed `category/surface/handler/operation.kind/operation.input/operation.fault/oracle/binding_hash`；16个concrete Production handler覆盖T0-T6d、Capacity Admin、Operational Blocker和NodeOutputEnvelope Store。独立`behavior`参数不得等于`case_id`。Harness验证closed keyset、artifact category、operation/surface/transaction/input、fault presence/boundary/point、handler、binding、checked-in bytes与inventory；missing、duplicate、unknown、unhandled、multiply handled、重复执行或非checked-in execution record均fail closed。旧`fixtureEvidence`/`capacityFixtureEvidence` Map、bulk-fill循环、字符串`it.each`和共享generic `workflow_values` probe已删除。

每个checked-in record由managed `test:g5`单独exact-once执行，自身scenario、fixture token、idempotency key、operation、behavior、durable relation、time、mode、rejection、reopen/replay与fault数据直接驱动对应Production/model boundary。Generated-output rows先执行独立reference join publication model，再把exact结果写入真实Schema 7 Store。每行在target operation前后、close/reopen后及exact replay后比较声明relation与全部application tables的canonical digest；rollback全库不变，accepted/replayed提交并持久，callback/wait/Capacity conflict/tamper预期提交exact audit evidence。missing referenced binding、referenced parameter drift与unsupported canonicalizer由真实Schema 7 FK/CHECK拒绝。Adversarial tests对expected oracle、operation/behavior、fault、category/surface、handler、inventory和execution binding变异，包含诚实重算binding hash后的攻击；checker只证明closed structure/identity/bytes，pack固定`fixture_count_is_not_runtime_execution_proof=true`。

Current identities：pack/member tree=`sha256:545ca1a8550901b4ffba61e2b06888b2537e65faa6caf7a4192ff4938665c677` / `sha256:9db22cbf1caa39205aff758c65b82f8a10192d7f98cc5c69312e5c5a47b13bac`；protocol=`sha256:bd72e28685e09870bac59c3a543d6180e39208d2ce029ca49bb61ee9fddc38cb`；positive/negative/fault=`sha256:4d3c3847b862c4d41909ff06c36209cd6b59506d31a53ccc64a2f4112c25686c` / `sha256:b5291f72047fdd4e6cc9f7de3767b66c75b9671ad550bb216faac01563262779` / `sha256:0b973b6b2d297df0afbd6b8b3a4f9ce748bda2f6c65333b1b012c64f0e6606d3`；reference/evidence tree=`sha256:d03cabfe7782cf315ffb0c24358ef21c77ef73b959da5a55e24692dcdc307717` / `sha256:dfa084bda9b48df486cd2a92a51a782923e1b9dbda3ce37a7b5ca5be7176e21a`；Production implementation/18-source tree保持`sha256:8107311c6ca5c26b1da2410200f94410b0fdc6c9f08323b2d04b356418ffec71` / `sha256:700921bd70425d5448316444263dcbb08a1fcb409a54b37fd186aac82646c206`。

Managed verification：individual fixtures 66/66 exact once（21/28/17）；`test:g5` 5 files / 109 tests（66 closed fixture + 18 existing Production Runtime + 3 Capacity + 14 NodeOutputEnvelope Store + 3 independent model + 5 Contract/adversarial）；两轮完整`contracts:generate` + `contracts:check` byte-identical，生成前及两轮后Contract/Schema JSON/SQL digest均为`2c3566c872681d5a7ec30acb2957f9ca3de67ee07b4f4c0a73b07832fc2ccb64`。R-019/package 6/6；Schema 7/upgrade 27/27；Capacity/Schema/Store 63 passed / 1 frozen skip；Runtime Store 25/25；NodeOutputEnvelope Store 14/14；G2 129/129；Golden current/historical 93/93与v5/v6各40/40 exact replay；G3 101/101；G4 2/2；ownership 1/1；readiness 7/7；blocker 6/6；whole G0 104 passed / 7 frozen skips；typecheck/build/bind及post-build gates全部PASS。SQLite 3.53.2、Ajv、managed Node 26.5.0/native module均实际执行。

Protected boundary相对`1eac421`为零diff：G0.10/G0.3、G2全部review/semantic-review/sealed、G3.8A、Schema 5/6 fresh及upgrade、G4 bootstrap、ownership、18个Production sources、root/container agent-runner dependency sections与两套lockfile不变。Root/agent-runner dependency sections逐字节diff为0；两套lockfile raw=`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`且diff为0。Forbidden Gateway/Command audit/T6e/blocker resolve-abandon/workflow deadline/manual bypass/G6+/certification/Production loader-activation-ingress/network/real Adapter/user-data新增surface为0。

本提交不创建closure、不声称fresh independent whole-gate regression PASS。G5保持`NOT_DONE`，G6-G9保持`NOT_READY`；下一任务只能由中控基于本candidate exact bytes创建新的fresh independent local G5 whole-gate regression。

### 2026-07-25：G5 `join_optional_absent` directed repair candidate

**结论**：`G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION/NOT_DONE`。本轮从clean local `main@2600bc459b16141a2ee33f82612c524c8e068781`开始，该起点唯一parent=`1eac421abad44d6bc95894faee8f498b8612cbd1`，本原子directed-repair提交唯一parent固定为`2600bc459b16141a2ee33f82612c524c8e068781`。施工前完整复读架构规范和本进度账本，审计candidate exact diff、checked-in fixture、generator/checker、independent reference model、Harness、Schema 7 `NodeOutputEnvelopeValueStore`、`persistNodeOutputEnvelope()`及production callers。没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset或历史改写，没有修改18个Production implementation sources或开始G6+。

中控确认的false positive已关闭。`join_optional_absent`现在以sealed Plan `result.required=false`执行，真实Store输入和持久化`ports.result`均为exact `{state:"absent",schema_hash:<compiled result schema hash>}`，不存在`value_ref`、`value_hash`或`byte_length`，也不创建member Value、member provenance或member ownership。Write、immediate exact replay、read、recovery scan、Store reopen后的read/recovery及response-loss replay均逐次验证同一个Plan ID/hash、graph run、node、actual generated `node_output_envelope` schema ref/hash/parameter binding与canonical Stored Value bytes。Independent reference publication只在outer port语义层比较state/schema/length；不再作为present member payload写入Store。Adversarial mutation明确证明“present outer port + payload描述absent publication”的旧形状不能满足`join_optional_absent`，并证明required/optional Plan drift会被检测。

直接耦合的generated-envelope positives也已逐项审计并修复已证实的同类substitution：rename member现在是`"renamed-value"`，default是`"fallback"`，list是`["first","second"]`，downstream selection是`{selected_port:"result",value:"immutable"}`，reopen/response-loss是其声明logical fixture Value；各member content与independent model envelope保持分离。Required-absent negative同样不再预造无引用member。21 positive / 28 negative / 17 fault的66-record exact-once gate、missing/duplicate/unknown/unhandled/multiply-handled/重复执行/非checked-in record防护与16个Production handler binding均保持闭合。

Current identities：pack/member tree=`sha256:158b2f2750f681eb3e411c3c7fbc654fc33c105219fccc9df2c1c5f101aa5693` / `sha256:0ce20f82b9151fafe26a11cfcb0d83025f71c1c201db3835d2593a419e4cb31e`；protocol/positive/negative/fault保持`sha256:bd72e28685e09870bac59c3a543d6180e39208d2ce029ca49bb61ee9fddc38cb` / `sha256:4d3c3847b862c4d41909ff06c36209cd6b59506d31a53ccc64a2f4112c25686c` / `sha256:b5291f72047fdd4e6cc9f7de3767b66c75b9671ad550bb216faac01563262779` / `sha256:0b973b6b2d297df0afbd6b8b3a4f9ce748bda2f6c65333b1b012c64f0e6606d3`；reference/evidence tree=`sha256:caae9af7b7310b7d044728b1f4d6f5f18f87f3d66d161969ff17443c4290522f` / `sha256:568f61d324b1a166e8e671bc33a3e715f7bdd4e3f9d4918dc1abc9020c9eb699`；repaired Runtime test raw=`sha256:670d767cbcffa7965e56c3ba7b236985d7799f94bb3d52ac2111c20ded1b43cd`。Production implementation/18-source tree保持`sha256:8107311c6ca5c26b1da2410200f94410b0fdc6c9f08323b2d04b356418ffec71` / `sha256:700921bd70425d5448316444263dcbb08a1fcb409a54b37fd186aac82646c206`。

Managed verification全部通过：完整Runtime file 85/85，其中66 fixtures exact once及新增model-as-member/Plan optionality adversarial；`test:g5` 5 files / 110 tests；focused actual NodeOutputEnvelope present/absent schema、write/read/replay/reopen/recovery与compiled optional/default/list/rename 3 passed / 11 filtered；NodeOutputEnvelope Store 14/14；readiness 7/7；blocker 6/6；R-019/package 6/6；Schema 7/upgrade 27/27；Capacity/Schema/Store 63 passed / 1 frozen skip；Runtime Store 25/25；G2 129/129；current/historical Golden 93/93及v5/v6 40/40 exact replay；G3 101/101；G4 2/2；ownership 1/1；whole G0 104 passed / 7 frozen skips。Managed `typecheck`、targeted Prettier、`build`与`git diff --check`通过，真实SQLite 3.53.2、Ajv、managed Node 26.5.0/native module实际执行。

两轮完整managed `contracts:generate` + `contracts:check`均PASS：生成前旧identity Contract/Schema JSON/SQL digest=`2c3566c872681d5a7ec30acb2957f9ca3de67ee07b4f4c0a73b07832fc2ccb64`；第一轮只更新current G5 reference authority和pack后，两轮post-generate/check digest均byte-identical为`83a50fda17e6ae44f2b1655bf5cb85be8c354ae86d0cb7a857d9a13793c7d18c`。Final build后exact `./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js`成功，Runtime Launcher=`/Users/chelaile/Library/Application Support/Icarus/bin/icarus-runtime`，binding kind=`development_checkout`，Core entry/binding=`sha256:626b57523d0c96d8c3e1d2608b36a5c144037ef2639b5bfafcb3d2932899eef3` / `sha256:ec5666f6004fa52f51e8b47aca6fbd074fc2659ac3de18501d3b256be5a67fab`。Post-build再次通过whole G0 104/7、G3 101/101、Store check、NodeOutputEnvelope Store 14/14、G5 110/110、readiness 7/7与blocker 6/6。

Protected/forbidden boundary相对`2600bc4`保持精确：除本账本、current G5 reference authority、current G5 pack与G5 Runtime test四路径外无changed path；G0.10/G0.3、R-019/Schema 7/G2 v6/G3/G4 authority、G2历史review/semantic-review/sealed、G3.8A、Schema 5/6 fresh及upgrade、历史G4 bootstrap、ownership、18个Production sources均零diff。Root/agent-runner dependency section digest=`6fb340eddb33436284777f1c4d86a3c76a7d4ac29cf03cc3609ce291abd0f177` / `141fc7778ca0fca4d66bcabc76c9794cd170b1184f7987093b6f481214784116`；两套lockfile raw=`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`，全部相对parent零diff。Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual bypass、certification、Production loader/activation/ingress/network、real Adapter、G6+新增或changed surface均为0。

本提交不是G5 closure，不声称fresh independent whole-gate regression PASS。G5保持repair exit candidate pending fresh independent G5 whole-gate regression，G6-G9保持`NOT_READY`；只有中控可以基于本candidate exact bytes创建下一次fresh independent regression。

### 2026-07-25：G5 fresh independent whole-gate regression closure

**结论**：`PASS / G5_DONE`。本轮从clean local `main@b67265de8432702ab40432d80e8166a30eb2f3e5`开始，唯一parent=`2600bc459b16141a2ee33f82612c524c8e068781`；完整复读架构规范和本进度账本，独立审阅candidate exact四路径diff、current authority、21 positive / 28 negative / 17 fault records、closed bindings、generator/checker、reference/model/property evidence、exact-once harness、16个concrete handler、NodeOutputEnvelope Store与18个Production implementation sources，没有复用construction判断。Candidate代码、Contract authority和generated artifacts在回归中保持只读；没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset、历史改写、repair或G6+施工。闭合只允许本账本一个changed path；本原子ledger-only closure commit的唯一parent固定为`b67265de8432702ab40432d80e8166a30eb2f3e5`，exact Git object ID在提交创建后由最终回归证据报告。

独立审阅确认T0-T6d、CAP0-CAP4、Operational Blocker create/open/cache、Store recovery/fencing/tamper/duplicate/conflict与完整affected chain闭合。T4、terminal T6a和durable-wait T6c共同调用Production `persistNodeOutputEnvelope()`，只接受exact persisted sealed Plan node、exact compiled output-port key set和Plan-generated `node_output_envelope` descriptor，不存在moving Registry/schema fallback。Reconciler重新验证envelope schema authority、canonical envelope hash和member tuple，只从immutable member Value解析下游数据。

`join_optional_absent`独立边界审阅与执行均PASS：sealed Plan `result.required=false`；真实outer `ports.result`为exact `{state:"absent",schema_hash:<compiled hash>}`，没有`value_ref`、`value_hash`或`byte_length`，没有fabricated member Value/provenance/ownership。Write、immediate exact replay、read、Store reopen、recovery scan和response-loss replay均绑定同一Plan ID/hash、graph run、node及actual generated envelope schema ref/hash/parameter hash并保持absence。Present outer member加上描述absent publication的payload会因state comparison失败；Plan required drift会失败。Rename/default/list/downstream selected immutable Value、Store recovery及SQLite reopen/response-loss positives保存各自logical member content，reference/model object没有被替代为member payload。

Fixture与adversarial boundary同样PASS：66个checked-in record逐条exact once执行；missing、duplicate、unknown、unhandled、multiply handled、重复执行、非checked-in record及诚实重算binding hash后的oracle/operation/behavior/fault/category/surface/handler/inventory变异均fail closed。Missing generated binding、parameter drift、unsupported canonicalizer、schema/raw/domain/binding/port/provenance/max-byte/required drift继续由真实Schema 7 FK/CHECK、Store或Plan authority拒绝。

Independent executable evidence：managed `test:g5`为5 files / 110 tests，独立Runtime fixture execution为85/85并明确列出66/66 records；NodeOutputEnvelope Store 14/14；readiness 7/7；blocker 6/6；R-019/package 6/6；Schema 7/upgrade 27/27；Runtime Store 25/25；Capacity/Schema/Store aggregate 63 passed / 1 frozen skip；G2 129/129；current/historical Golden 93/93；historical/current replay各40/40 exact；G3 101/101；G4 2/2；ownership 1/1；whole G0 104 passed / 7 frozen skips。两轮连续managed `contracts:generate` + `contracts:check`全部PASS，每次generate与check后worktree均clean，证明final tracked bytes与candidate HEAD byte-identical。Managed `typecheck`与`build` PASS；随后exact `./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js` exit 0，Runtime Launcher=`/Users/chelaile/Library/Application Support/Icarus/bin/icarus-runtime`、binding kind=`development_checkout`。Post-build再次PASS whole G0 104/7、G3 101/101、Store check、NodeOutputEnvelope Store 14/14、G5 110/110、readiness 7/7与blocker 6/6。Managed Node/npm=`26.5.0` / `11.17.0`，Ajv=`8.20.0`，`better-sqlite3=12.11.1`，real SQLite=`3.53.2`及native module checks实际执行。

Final candidate identities全部exact：pack/member tree=`sha256:158b2f2750f681eb3e411c3c7fbc654fc33c105219fccc9df2c1c5f101aa5693` / `sha256:0ce20f82b9151fafe26a11cfcb0d83025f71c1c201db3835d2593a419e4cb31e`；reference/evidence tree=`sha256:caae9af7b7310b7d044728b1f4d6f5f18f87f3d66d161969ff17443c4290522f` / `sha256:568f61d324b1a166e8e671bc33a3e715f7bdd4e3f9d4918dc1abc9020c9eb699`；Runtime evidence raw=`sha256:670d767cbcffa7965e56c3ba7b236985d7799f94bb3d52ac2111c20ded1b43cd`；Production implementation/source tree=`sha256:8107311c6ca5c26b1da2410200f94410b0fdc6c9f08323b2d04b356418ffec71` / `sha256:700921bd70425d5448316444263dcbb08a1fcb409a54b37fd186aac82646c206`；root/agent-runner lockfiles=`sha256:2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `sha256:d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`。

Protected/forbidden boundary相对candidate parent `2600bc459b16141a2ee33f82612c524c8e068781`保持exact：candidate只有账本、current G5 reference、current G5 pack、G5 Runtime test四个changed paths；G0.10/G0.3、R-019、Schema 7、G2 v6、current G3/G4、G2历史review/semantic-review/sealed、G3.8A、Schema 5/6 fresh及upgrade、历史G4 bootstrap、ownership、dependencies/package sections、两套lockfile和18个Production sources全部零diff。Production sources相对parent为18/18 raw-byte equal；Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual bypass、certification、Production activation/loader/ingress/network、real Adapter、user-data与G6+新增或changed surface均为0。

G5现在为`DONE`；G6为`READY/NOT_DONE`；G7-G9保持`NOT_READY`。下一任务只能由中控创建fresh independent local G6 Dynamic / Close construction task；本轮没有开始G6。

### 2026-07-25：G6 static child Plan prerequisite directed repair candidate

**结论**：`G2_G5_STATIC_CHILD_PLAN_PREREQUISITE_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION/NOT_DONE`。本轮从clean local `main@ac1f373578bee524561d5e8862b3a52ea99cf372`开始，唯一parent=`b67265de8432702ab40432d80e8166a30eb2f3e5`；前序G0-G5 closure仅作为施工输入。没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset或历史改写。G2与G5因confirmed prerequisite defect显式reopen；G6-G9均为`NOT_READY`，本轮没有实现任何G6 Dynamic/Close或G7+行为。

Confirmed defect已按架构权威关闭在最小边界内。Pure Compiler 3.0.5在unchanged parent `CompiledScopePlan v2`之外返回closed `icarus.workflow-compiler-static-child-plan-bundle/1`；entries只含`closureKey/source/plan`，按parent closure的parent-before-descendant/ASCII顺序保留每个inline/template factory的exact source与独立canonical child Plan。Bundle不进入parent Plan canonical bytes/hash、不从hash manifest重建、不读取moving Registry、不在Runtime recompile，也不成为第二份Golden oracle。固定3.0.4 identity的nested parent仍为`sha256:042a4243db0e7c3263b9582bc991365efb53fe663208d3077634ae86257998e7`，冻结G2 v6 bundle仍为`sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7`并40/40 exact。

Production T2a在SQLite事务前验证bundle/entry closed keyset、完整membership/order、closure key、source/scope/source hash、Plan ref/hash/canonical bytes、interface/member/closure hash、nested global lineage及Compiler/Toolchain/Normalizer/Proof/Error Catalog/Runtime Safety/Catalog authority。Schema 7 `BEGIN IMMEDIATE`内按`graph_run_id + plan_hash`保存或exact验证parent与所有unique static child Plans，并为每个Plan保存generated-schema contents/bindings；全部成功后才CAS build compiled。Same identity/different bytes、existing partial schema binding、missing/extra/duplicate/alias/unknown/tamper、stale build row、exact lease owner/token/expiry（`expires_at_ms <= now_ms`）、live Run/Scope work fence均fail closed。Compiled replay只验证、零DML且不能补缺；pre-first-write与pre-commit faults均完整rollback。T2b语义未改，仍拒绝`subgraph/expand/map`为G6-owned surface。

Current Compiler version/build/toolchain为`3.0.5` / `sha256:7eb0e64d00e79d3684f401a46549568f8997d2e02a6cffd0b573326dfb08bcc6` / `sha256:a48c43917d27271bf2edfc0b9a8625519e098917f2768ea447ffda7eb0d19c4e`。Additive bridge pack/member tree=`sha256:0f4bba85f8d25a16024877a236724dc119393d87aa773ca791253bbbfcd8ee90` / `sha256:c1c292e46a57caf7f190965d10960cf3bc4525669b9ba07e35ce2921e213b02d`，production/evidence source tree=`sha256:8103a9b1061c265cb0fd1c62e8383a9825cf3b193f1f1d703606588a2b372e0b` / `sha256:ab46b3ac9b4e6e57a1a13739a43a772dfacd42f9e3dd877e4a8070b9264d1cd5`，closed fixtures为4 positive / 12 negative / 6 fault。Rebuilt G5 pack/member tree=`sha256:07a19052c602ca26abd93ac7a8294fd69a0ab087ac0a84e9e73feecdb84108ea` / `sha256:845b9289a36ecc056d28337b94d565cfc26b422907dbb62d6acdacfd42bbb446`，reference/evidence tree=`sha256:0aaec6340219926f94c1b262f092fddffb07131153c851ea5cdac886b406ce5b` / `sha256:50b71e64d89f3661b45bbaff2f4013ce15e0fbd7f6414ec4c280f50413a2e31f`，implementation/19-source tree=`sha256:efb0b516d7a27d602ef44ef2743b94f8af6f5e3b596cb4ad33e3924ed76600be` / `sha256:72f81daa7e819d2633597df42da6fc8f6edb1f35944727f8728d4d031de386e2`；既有21 positive / 28 negative / 17 fault records保持closed。

Managed verification全部通过：Compiler bundle 2/2；`test:g2` 9 files / 66 tests；冻结v6与historical replay各40/40 exact；`test:g1.1` 27/27，`test:g1.2` 25/25，Capacity/Schema/Store 63 passed / 1 frozen skip；G3 101/101；G4 2/2；ownership 1/1；whole G0 104 passed / 7 frozen skips。G5为5 files / 113 tests，其中real-file SQLite Runtime 88/88、NodeOutputEnvelope Store 14/14、Capacity 3/3、reference model 3/3、Contract/adversarial 5/5；readiness 7/7、blocker 6/6。Nested/shared Plan hashes、unique child schema bindings、exact replay、response loss、before-first-write/before-commit rollback、reopen、Plan collision、missing binding、unknown/partial/extra/duplicate/order/alias/source/Plan/nested/toolchain/safety tamper、live lease与Run/Scope fence均由direct production SQLite或Compiler tests执行。

两轮连续完整managed `contracts:generate` + `contracts:check`均PASS；生成前、第一轮与第二轮后的Contract/Schema JSON/SQL tree digest均byte-identical为`56ff31107ca23c50af727a81bc4fab25bd3e4df0bef707b9a848ee8c664bc759`。Managed `typecheck`与`build` PASS；随后exact `./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js`成功，Runtime Launcher=`/Users/chelaile/Library/Application Support/Icarus/bin/icarus-runtime`，binding kind=`development_checkout`。Post-build再次PASS whole G0 104/7、G3 101/101、Store check、NodeOutputEnvelope Store 14/14、G5 113/113、readiness 7/7与blocker 6/6。Managed Node 26.5.0、Ajv、better-sqlite3 native module与real SQLite 3.53.2检查实际执行。

本提交只形成directed-repair construction candidate，不创建semantic approval、seal、independent review或ledger-only closure，不声称G2/G5 `DONE`，也不恢复G6 readiness。下一任务只能由中控基于本candidate exact bytes创建fresh independent local G2/G5 affected-chain regression；只有该独立回归可以确认authority/candidate、恢复G2/G5 closure并决定G6是否重新`READY`。

Final exact changed-path audit为34 paths。相对`ac1f373`，全部sealed/review/Golden artifact、完整Schema tree（含历史/current Schema 5/6/7 migration与upgrade）、G3.8A、current G3/G4、frozen gate ownership及两套lockfile均零diff；没有历史artifact覆盖或新的approval/seal。Root dependency section base/current digest同为`4c07645d4d4e47e92252dc90f477ef002f818f02e127807171169b10169d3089`，root/agent-runner lockfile raw分别保持`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`。Foundation production-import boundary 11/11 PASS，只对`static-child-plan-bundle-repair.ts -> compiler.ts/identity.ts`两个exact construction evidence imports增加file-and-target allowlist；无directory-wide exemption。Added-production diff scan没有Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual retry、T7/T8、child creation/finalization、compensation、certification、Production activation/loader/ingress/network、real Adapter或G6+实现；`git diff --check` PASS。

### 2026-07-25：Static child Plan bridge executable-fixture directed repair candidate

**结论**：`G2_IN_PROGRESS / G5_IN_PROGRESS / PENDING_NEW_INDEPENDENT_AFFECTED_CHAIN_REGRESSION`。本轮从clean local `main@4466681ee7183f18e34bfcfa22adfea280fb7a1f`开始，唯一parent固定为该commit；只修复checked-in static-child bridge的22行fixture没有一对一Production执行绑定这一confirmed defect及其transitive current G2/G5 authority/evidence。没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset、独立affected-chain回归、closure或G6/G7+施工。G2与G5保持`IN_PROGRESS`，G6-G9保持`NOT_READY`。

4 positive / 12 negative / 6 fault记录现在全部是closed exact `{case_id,assertion,category,surface,handler,operation,input,fault,oracle,binding_hash}`。每个`binding_hash`覆盖除自身外的完整记录，domain separator为exact newline-terminated `icarus:workflow-static-child-plan-bundle-fixture-binding:1\n`。Checked-in bytes先由closed registry与generator inventory逐行及顺序比对，再允许exactly-one handler dispatch；missing、duplicate、unknown、order drift、unknown/missing nested field、binding drift、unhandled、multiply handled、重复执行、non-checked-in execution record和oracle drift全部fail closed。Adversarial Contract test另以44-run property对22个记录做honestly rehashed semantic drift，证明重算binding hash不能绕过current inventory。

Directed managed execution明确逐条打印并通过22/22 bridge records：两个Compiler记录调用Production `compileWorkflow`，20个T2a记录调用Production `persistCompileResultT2a`和real-file Schema 7 `WorkflowRuntimeStore`。每个checked-in row只由bridge harness领取一次并产生exact receipt；不是由case count或inventory冒充执行。Compiler rows证明fixed parent canonical bytes、nested membership/order/key/ref/hash、source/Plan canonical bytes与lineage，以及重复factory descendant的同hash/同Plan bytes/同source bytes。T2a rows分别证明parent+3 unique child Plans+每Plan generated-schema authority atomic persistence、4 closure entries中的shared child content-address去重、canonical persisted bytes、same-connection及reopen replay的SQLite `total_changes()` literal zero-DML、response-loss recovery；missing/extra/duplicate/order/alias/unknown/source/Plan/nested lineage/toolchain/safety drift；persisted Plan collision及missing child schema binding无repair失败；before-first-write/before-commit rollback；stale row version、lease owner/token/expiry、Run/Scope fence；以及reopen后的Plan/schema-binding tamper detection与no-repair recovery。Fault多variant仍由其单一checked-in record和单一handler receipt闭合。

Bridge positive/negative/fault artifact identities分别为`sha256:aaf88ea336274c1fed6b7c3c16077c72b5d792ac4c7e805b13a5374914b98726` / `sha256:962350e7bdbae8e24cd998f454ab891e676ef98ca69058872413d4a6cbd54777` / `sha256:9cea07206887b9429ca9db16eeb1da4202ccd54279e968c3bb130f2873edfa89`；protocol/evidence/pack/member tree为`sha256:0f2fba2ea6bc739bfc1642e1e748c58611350a76cb2028a5cf93b8e5d46566f2` / `sha256:9056977fb26e716868fbda2636e082c35d4b08c5bf2d75e1fc5ceb310ae39e44` / `sha256:f4429d7243739a24ff7199c82f18e4e7d7eff791c3e5b4d3032675bee889e8b3` / `sha256:798f393e90b4e99bbc3032b3ede155b7f11c9054b73279ce4c5dc47d5f052bb5`。Production source tree保持`sha256:8103a9b1061c265cb0fd1c62e8383a9825cf3b193f1f1d703606588a2b372e0b`，新增closed harness、adversarial/property test、Compiler、G5 Runtime及independent reference/model/property evidence后的evidence tree为`sha256:fdc542f4901e280da6b87ae48f7775850e2cb2851b1847d4cf57b7a98845b718`。Compiler version/build/toolchain保持`3.0.5` / `sha256:7eb0e64d00e79d3684f401a46549568f8997d2e02a6cffd0b573326dfb08bcc6` / `sha256:a48c43917d27271bf2edfc0b9a8625519e098917f2768ea447ffda7eb0d19c4e`。

Rebuilt current G5 pack/member tree为`sha256:e4183a829b87a4ea061956e1e792f49e234887d1018e6dea4bef48fb2f0c7bd5` / `sha256:b5590579232d09fc525f25beeed7c57b3acd35ded9b788060103f5c72281089b`，reference/evidence tree为`sha256:ca8afe2675bfb681d0ca99354b745e86a912e1a41471f0e6725353ea803fa85e` / `sha256:057bd7299ce34a121680299ef00039c67ddc2c38d88dd365f18f29945dc50ac6`。Production implementation/source tree保持`sha256:efb0b516d7a27d602ef44ef2743b94f8af6f5e3b596cb4ad33e3924ed76600be` / `sha256:72f81daa7e819d2633597df42da6fc8f6edb1f35944727f8728d4d031de386e2`，证明没有借本修复改变Runtime Production surface。

Managed verification全部PASS：bridge Contract/adversarial/property 5/5，Compiler static-child 2/2，directed bridge records 22/22；full G2 67/67；Schema 7/frozen upgrade 27/27，Runtime Store 25/25，Capacity/Schema/Store aggregate 63 passed / 1 frozen skip；G3 101/101；G4 2/2；ownership 1/1；full G5 5 files / 135 tests，其中Runtime 110/110、NodeOutputEnvelope Store 14/14、reference model 3/3、Contract 5/5、Capacity 3/3；readiness 7/7、blocker 6/6；whole G0 104 passed / 7 frozen skips。两轮连续managed `contracts:generate` + `contracts:check`全部PASS，round 1/2 Contract+Schema JSON/SQL tree digest均为`146815e39f15c238472e92bf1e5f1deb5823735a10d2faf9c41f009a81355aa1`。Managed typecheck/build PASS；exact `./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js` PASS，Runtime Launcher=`/Users/chelaile/Library/Application Support/Icarus/bin/icarus-runtime`且binding kind=`development_checkout`。Post-build再次PASS whole G0 104/7、G3 101/101、Store check、NodeOutputEnvelope Store 14/14、G5 135/135、readiness 7/7和blocker 6/6。Managed Node/npm=`26.5.0` / `11.17.0`，Ajv=`8.20.0` compile PASS，`better-sqlite3=12.11.1`与real SQLite=`3.53.2` native load PASS。

Final boundary只允许本ledger、bridge generator/harness/test与6 generated artifacts、G5 generator与3 current generated artifacts、G5 Runtime test共15 paths。相对`4466681`，全部sealed/review/Golden history、完整Schema authority/migration/upgrade tree、G3.8A、current G3/G4、frozen ownership、root/container agent-runner package与两套lockfile、全部Production Compiler/Store/Runtime sources均零diff。Root/agent-runner package raw分别保持`c46a24893850ae858798f5a9dd3e9a67cc5dc34f8f168114f2de51af3ea354f8` / `bf97cfb12f26b9cbf8f9b9edba2b039e8e771bd53ae5f3c8b227c744dcf02764`，lockfile raw保持`2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085` / `d9b4b5d77dc6478348b81d74d65e2af1d3596ce45eea6742cae20cf105db379c`。Forbidden scan没有Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual retry、T7/T8、child creation/finalization、compensation、certification、Production activation/loader/ingress/network、real Adapter或G6+新增/changed surface。本commit只是atomic directed-repair successor candidate；新的独立affected-chain regression仍是G2/G5重新闭合的必要后续条件。

### 2026-07-26：Focused bridge execution gate directed repair successor candidate

**结论**：`G2_IN_PROGRESS / G5_IN_PROGRESS / G6_G9_NOT_READY`。本轮从clean local `main@f0c4dbae737a7f9be67c8aa420d5392f6ae18fb0`开始，该起点唯一parent为`4466681ee7183f18e34bfcfa22adfea280fb7a1f`，本atomic successor唯一parent固定为`f0c4dbae737a7f9be67c8aa420d5392f6ae18fb0`。只修复中控与独立回归共同确认的focused bridge execution-boundary缺陷；没有worktree、Handoff、sub-agent、approval/escalation、push、amend、rebase、reset、Production行为修改、regression或closure，也没有开始G6+。

Confirmed defect位于`g5-basic-runtime.test.ts`的root `afterAll`：focused `-t 'bridge '`真实执行并通过22条bridge records后，仍错误调用未选择的G5 66-record harness completeness。修复把22条bridge row放入独立checked-in suite，在该suite内只执行bridge `assertComplete()`；G5 66条和其余Runtime tests保留在独立G5 suite，并在该suite内只执行G5 `assertComplete()`。没有filter检测、环境变量、catch/ignore、条件旁路或completeness降级。Full file进入两套suite，仍分别强制bridge 4 positive / 12 negative / 6 fault和G5 21 positive / 28 negative / 17 fault exact complete。

Exact focused command `./scripts/runtime-toolchain.sh exec -- npx vitest run src/workflow-runtime/runtime/g5-basic-runtime.test.ts -t 'bridge ' --reporter=verbose`为`22 passed / 88 skipped / suite PASS`。两个Compiler rows逐条调用Production `compileWorkflow`；其余20个T2a rows逐条进入Production `persistCompileResultT2a`和real-file Schema 7 SQLite。Full managed G5为5 files / 135 passed：Runtime 110/110明确包含bridge 22/22及G5 66/66，另有NodeOutputEnvelope Store 14/14、reference model 3/3、Contract 5/5、Capacity 3/3。新增双向negative self-test证明bridge complete时未执行G5仍由其自身`assertComplete()` fail closed，G5 complete时未执行bridge仍由其自身`assertComplete()` fail closed；两套harness不共享handled state或completeness authority。

Mechanical identities已按evidence source raw bytes重建。Bridge pack/member tree为`sha256:777dd67bb51be338136a9478d3122a35159c422110ddbe7c6e54582010c572ee` / `sha256:c14ee1d21fed9cb30b3203feeeb1c580de36bcedb74b85dda45adaec7aad0057`，evidence/evidence tree为`sha256:b4996780c7eb56a37effec4d1f932db096c7c6d72778f2dbbe7d1e6f2be4b4ba` / `sha256:e4e8368c29b9eca7506e7aa3aaa4ee1bf6a1f9c1a3647353fb1c1cb26d593f22`；Production source tree保持`sha256:8103a9b1061c265cb0fd1c62e8383a9825cf3b193f1f1d703606588a2b372e0b`。G5 pack/member tree为`sha256:0adb31e5ebca15cefccf688d6f672b9f067484bf3504f2b84f5fe6d1e7e41af1` / `sha256:61dcf1b607610e95ff0b4df0d65159fe382d4e8006a9054fe978b192b0b0bcbf`，reference/evidence tree为`sha256:3f51774d3846d61bc8ec0ae814a6bf5bed2e79ed768e6067a30728e54a19bb50` / `sha256:37fe6ec7c5691fd7643938372bb2a8521ddce77d97204944145a154c010724da`；Production implementation/source tree保持`sha256:efb0b516d7a27d602ef44ef2743b94f8af6f5e3b596cb4ad33e3924ed76600be` / `sha256:72f81daa7e819d2633597df42da6fc8f6edb1f35944727f8728d4d031de386e2`。

Managed affected-chain全部PASS：bridge Contract/adversarial/property 6/6，Compiler static-child 2/2，full G2 68/68，冻结v6与historical Golden replay各40/40 exact；Schema 7/upgrade 27/27，Runtime Store 25/25，Capacity/Schema/Store 63 passed / 1 frozen skip，NodeOutputEnvelope Store 14/14；G3 101/101，G4 2/2，ownership 1/1，readiness 7/7，blocker 6/6，whole G0 104 passed / 7 frozen skips。连续两轮完整managed `contracts:generate` + `contracts:check`全部PASS；生成前及round 1/2后的Contract+Schema JSON/SQL tree digest均byte-identical为`eb661e1e6ce1c800dec2678c8ea6216d31b1c1abaa1b390dc02d50bcdcdc996e`。

Managed Node/npm为`26.5.0` / `11.17.0`，Ajv `8.20.0`实际compile PASS，`better-sqlite3=12.11.1` native load与real SQLite `3.53.2`读写PASS。Managed typecheck/build PASS；exact `./scripts/runtime-toolchain.sh bind-core --project-root "$PWD" --entry dist/index.js` PASS，Runtime Launcher为`/Users/chelaile/Library/Application Support/Icarus/bin/icarus-runtime`且binding kind为`development_checkout`。Post-build再次PASS whole G0 104/7、G3 101/101、Store check、NodeOutputEnvelope Store 14/14、full G5 135/135、readiness 7/7、blocker 6/6及focused bridge 22/22。

Final boundary相对`f0c4dbae`仅允许本ledger、bridge Contract test、G5 Runtime test、bridge evidence/pack、G5 generator exact binding及G5 protocol/reference/pack共9 paths。全部sealed/review/Golden、完整Schema authority/migration/upgrade、G3.8A、current G3/G4、ownership、Production Compiler/Store/Runtime source、package dependency sections与两套lockfile保持byte-exact。Forbidden Gateway/audit/T6e、blocker resolve/abandon、workflow deadline、manual bypass、T7/T8、certification、Production loader/activation/ingress/network、real Adapter/user data及G6+新增/changed surface为0。G2/G5保持`IN_PROGRESS`，G6-G9保持`NOT_READY`。
