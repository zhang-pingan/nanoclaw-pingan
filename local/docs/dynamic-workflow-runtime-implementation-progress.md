# Dynamic Workflow Runtime 实施进度

> **状态**: IN_PROGRESS
> **当前 Gate**: G3 Registry / Authoring / Publish（`IN_PROGRESS`；G3.1-G3.8 与 G1.5 Schema prerequisite 均 `DONE`；G2保持`DONE / BASELINE_ACCEPTED`与40/40 exact replay）
> **下一施工切片**: G3.9 Feature Release Activation Vertical Slice；消费Database Schema 3，实现closed Activation与单一原子Activation事务
> **最后更新**: 2026-07-21
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
| G1 DDL / Store | `DONE` | G0.10 | closed Schema Dependency Manifest + Schema 3 migration/Manifest + Store base + Publisher/Activation prerequisites + real-file SQLite/identity gates | 本原子提交（G1.5 Activation schema prerequisite） |
| G2 Compiler / Golden | `DONE` | G0.1-G0.9；R-016 spec/Contract repair；G0.10 不改变 Compiler/Plan 语义 | phase=`BASELINE_ACCEPTED`；前序immutable lineage未变；owner-approved successor GoldenSemanticReview/seal完整，current replay 40/40 exact、0 differences | 本原子提交（replay-repair successor seal） |
| G3 Registry / Authoring / Publish | `IN_PROGRESS` | G1 + G2 | G3.1-G3.8 DONE；G1.5已关闭Schema blocker；下一切片G3.9实现Activation，当前仍禁止Activation DML | 本原子提交（G1.5）；G3.1-G3.8见下文 |
| G4 Test Bootstrap | `NOT_READY` | G1 + G2 + G3 | isolated bootstrap profile | - |
| G5 Basic Runtime | `NOT_READY` | G4 | T0-T6e model/fault fixtures | - |
| G6 Dynamic / Close | `NOT_READY` | G5 | T7/T8/child/compensation fixtures | - |
| G7 Control / Card / Projection / Recovery | `NOT_READY` | G6 | command/card/projection/recovery/blocker fixtures | - |
| G8 Certification | `NOT_READY` | G7 | certified profile meeting Product Floor | - |
| G9 Production Activation | `NOT_READY` | G8 + fresh current G0/G0.10 manifests | activation + Capacity genesis/preservation audit + startup/empty-state or Recipe smoke | - |

## 工作包总览

| 工作包 | 范围 | 状态 | 当前 Gate/切片 |
| --- | --- | --- | --- |
| I0 | Publish、Registry、Recipe 与执行版本固定 | `IN_PROGRESS` | G3.1-G3.8与G1.5 prerequisite DONE；staged Publisher已完成；下一切片G3.9实现closed Activation vertical slice |
| I1 | Intake、Routing、幂等创建、Child provenance、Claim | `NOT_READY` | G5 起 |
| I2 | Definition、State lowering、Context、transition | `IN_PROGRESS` | approved static lowering语义已由Compiler 3.0.1实现、批准并seal；G2 lowering部分完成，Runtime transition仍从G5起 |
| I3 | Source/Compiled IR、Port、Compiler | `DONE` | Production Compiler 3.0.1 successor已批准并seal；current replay 40/40 exact、0 differences |
| I4 | Runtime Store、SQLite relation、Value/Blob、migration | `IN_PROGRESS` | G1 Database Schema 3/Store Base/Publisher与Activation prerequisites DONE；Activation DML、Blob/GC仍未实现 |
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
| G1.3 | Dependency Identity Repair | `DONE` | closed exact-member dependency manifest；physical identity与Gate provenance分离；Store不扫描Contract目录；migration bytes/78 tables/行为不变 | 本原子提交 |
| G1.4 | Publisher Idempotency / Audit Schema Prerequisite | `DONE` | additive physical input；3张first-class Publisher表；schema-bound Value、typed FK、caller UK、invocation/event hash chain；Database Schema 2；G1/G3 identity cascade；无Publisher业务事务 | 本原子提交 |
| G1.5 | Feature Release Activation Schema Prerequisite | `DONE` | additive physical input；3张Activation表；pointer owner/CAS、Release lifecycle、held Retention binding、recovery queries；Database Schema 3；无Activation DML | 本原子提交 |

## G2 施工切片

| 切片 | 内容 | 状态 | 主要退出条件 | 完成提交 |
| --- | --- | --- | --- | --- |
| G2.1 | R-016 Spec/Contract Repair | `DONE` | lowering outcome、Compiled IR v2、完整 case result target、exact input binding requirement与 blocked Draft v2冻结 | 本原子提交（历史） |
| G2.2 | Production Compiler / Exact Case-Input Identity | `DONE` | locked strict parser、closed validation、snapshot binding、static lowering、Plan normalization、program/proof/hash/diagnostic、真实 toolchain与40个actual candidate results | 本原子提交 |
| G2.3 | Working Correction / RC Review / Seal | `DONE` | phase=`BASELINE_ACCEPTED`；前序四个Working root、RC、Draft、review、GoldenSemanticReview和157-artifact seal未变；additive successor Draft/report已批准，versioned GoldenSemanticReview与157-artifact seal完整，current replay 40/40 | 本原子提交（successor approval/seal） |

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
| R-018 | Feature Release Activation persistence | CLOSED / `ACTIVATION_SCHEMA_PREREQUISITE_READY` | Database Schema 3已提供Activation专属command/invocation/event、caller-key/CAS binding、owner-consistent pointer、Release lifecycle、held target/previous Retention与append-only recovery audit；业务Activation仍由G3.9实现 | G1.5完成；G3.9消费 |

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

## 下一步

G0.1-G0.9 historical identity、G0.10 current root、G1 Database Schema 3/Store Base/Publisher与Activation prerequisites、R-016 spec/Contract repair与G2 Production Compiler/Golden均已完成。Current G2保持`DONE / BASELINE_ACCEPTED`，I3为`DONE`；G3.1-G3.8与G1.5均完成，G3/I0仍为`IN_PROGRESS`。下一切片固定为G3.9 Feature Release Activation Vertical Slice：消费Database Schema 3，实现closed Activation request/receipt/result、复用G3.6 compatibility、caller idempotency、expected active-pointer CAS、Release lifecycle与Retention原子事务，以及`applied | duplicate | conflict | failed` Invocation/Event和crash recovery。不得复用Publisher/Runtime/Capacity closed command union，不得开始Production loader、GC/delete、Execution Artifact build/install或G4-G9 Runtime。

历史fresh review evidence只存在于Git commits，不是current dependency；current immutable semantic approval只绑定exact Draft/report identities。显式`prepare-rc`冻结的四个Working roots与唯一Review Candidate未变；current expected full case-result/Plan/proof/program bytes/hash已独立冻结、审计、owner批准并seal。local single-user签名策略为`not_required_local_single_user`，没有伪造GPG或远程签名。

G2终点继续满足`Draft -> human semantic decision -> GoldenSemanticReview -> seal -> CI replay`：current successor replay为40/40，R-017保持关闭。G3.1只消费其exact sealed/compiler identities并执行纯preflight；没有创建Published Recipe、Registry row、Release或Production launchability，也没有执行production activation。

作为历史prepare-rc切片记录，该切片只修复当时的R-017 spec identity实时绑定、级联重建Working artifacts并执行`prepare-rc`及其确定性check。后续owner approval、immutable review、successor seal与40/40 replay现已完成；当前G3.1-G3.8、Publisher Schema prerequisite与G1.5 Activation Schema prerequisite均已完成，Activation等待G3.9 vertical slice，SQLite certification、Core Release、G4-G9和production activation仍未开始。R-010 Node loader deprecation与R-012/R-013/R-015 timing继续作为既有范围外baseline，不升级工具链、不放宽测试。
