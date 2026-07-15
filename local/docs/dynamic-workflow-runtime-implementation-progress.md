# Dynamic Workflow Runtime 实施进度

> **状态**: IN_PROGRESS
> **当前 Gate**: G0 Contract Pack / Static Baseline
> **下一施工切片**: G0.4 Catalogs and Protocol Tables
> **最后更新**: 2026-07-15
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
- 严格遵守 G0-G9 依赖。G0 完成前不得开始 Store、Compiler 或 durable T0；Executable DDL Gate 完成前不得实现 `WorkflowRuntimeStore`、Reconciler 或 production Domain Definition。
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
| G0 Contract Pack / Static Baseline | `IN_PROGRESS` | 无 | managed distribution/Launcher proof + schemas/catalogs/protocols/safety/draft bundle + absence/coverage/candidate hashes | - |
| G1 DDL / Store | `NOT_READY` | G0 | executable migration + Schema Manifest + SQLite fixtures | - |
| G2 Compiler / Golden | `NOT_READY` | G0 | sealed Golden Bundle + compiler/toolchain hash | - |
| G3 Registry / Authoring / Publish | `NOT_READY` | G1 + G2 | manifest/authoring/publish/retention/ABI fixtures | - |
| G4 Test Bootstrap | `NOT_READY` | G1 + G2 + G3 | isolated bootstrap profile | - |
| G5 Basic Runtime | `NOT_READY` | G4 | T0-T6e model/fault fixtures | - |
| G6 Dynamic / Close | `NOT_READY` | G5 | T7/T8/child/compensation fixtures | - |
| G7 Control / Card / Projection / Recovery | `NOT_READY` | G6 | command/card/projection/recovery/blocker fixtures | - |
| G8 Certification | `NOT_READY` | G7 | certified profile meeting Product Floor | - |
| G9 Production Activation | `NOT_READY` | G8 + fresh G0 manifests | activation audit + startup/empty-state or Recipe smoke | - |

## 工作包总览

| 工作包 | 范围 | 状态 | 当前 Gate/切片 |
| --- | --- | --- | --- |
| I0 | Publish、Registry、Recipe 与执行版本固定 | `NOT_READY` | G3 起 |
| I1 | Intake、Routing、幂等创建、Child provenance、Claim | `NOT_READY` | G5 起 |
| I2 | Definition、State lowering、Context、transition | `NOT_READY` | G0 Contract + G2/G5 实现 |
| I3 | Source/Compiled IR、Port、Compiler | `NOT_READY` | G0 Contract + G2 实现 |
| I4 | Runtime Store、SQLite relation、Value/Blob、migration | `NOT_READY` | G0 Contract + G1/G3 实现 |
| I5 | Graph 状态机、reconcile、Scheduler、Ledger | `NOT_READY` | G5 起 |
| I6 | Delegation/System、Capability Effect、Outbox | `NOT_READY` | G5 起 |
| I7 | Durable Wait、Signal/Timer/Approval、Inbox | `NOT_READY` | G5 起 |
| I8 | Subgraph、Expand、Map、child scope | `NOT_READY` | G6 起 |
| I9 | Completion、Cancel、Compensation、Finalization、Recovery | `NOT_READY` | G6/G7 |
| I10 | Runtime Command、Runtime Center、Trace | `NOT_READY` | G7 起 |
| I11 | Contract Pack、managed runtime toolchain/launcher、测试模型、发布门禁、absence baseline | `IN_PROGRESS` | G0.1/G0.2/G0.3 DONE；G0.4 READY |

## G0 施工切片

G0 只有全部切片满足退出条件后才能标记 `DONE`。切片编号描述推荐施工边界，不修改规范中的 Gate 依赖。

| 切片 | 内容 | 状态 | 主要退出条件 | 完成提交 |
| --- | --- | --- | --- | --- |
| G0.1 | Toolchain Identity | `DONE` | Node/npm/direct dependency/lock/CI/managed distribution/launcher identity 一致，基础构建与测试通过 | 本原子提交 |
| G0.2 | Contract Pack Foundation | `DONE` | artifact envelope、VersionedRef、hash/domain、strict parse、目录与 CI 骨架 | 本原子提交 |
| G0.3 | Closed Schemas | `DONE` | Definition/Recipe/Command/Transition/Feature/Card/Source/Compiled IR schemas 与 negative fixtures | 本原子提交 |
| G0.4 | Catalogs and Protocol Tables | `READY` | Error/Fact/Event/Permission/Reason/Denial、状态与 T0-T8/T6e 表机器化 | - |
| G0.5 | Safety / Retention / SQLite Contracts | `NOT_READY` | Safety、Capacity schema/baseline、Product Floor、Retention、SQLite Profile、Enforcement Matrix | - |
| G0.6 | Logical Schema Metadata | `NOT_READY` | 全对象 Logical Schema manifest source、typed relation metadata、query catalog | - |
| G0.7 | Static Absence and Surface Gates | `NOT_READY` | absence、surface coverage、candidate boundary generator/manifest/negative fixtures | - |
| G0.8 | Golden Draft and Review Input | `NOT_READY` | raw cases、hand-authored semantic assertions、review request；不得伪造 sealed expected output | - |
| G0.9 | G0 Conformance Exit | `NOT_READY` | Markdown/Contract 双向覆盖、完整 G0 CI、artifact hashes 和 Gate review | - |

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
| R-003 | Static proof | OPEN | 当前只有定向 legacy boundary test，尚无规范要求的 AST/API/UI/schema/filesystem/resource manifests | G0.7 |
| R-004 | Contract drift | PARTIALLY_MITIGATED | G0.2 foundation 与 G0.3 closed Domain Schema 已原子交付；Catalog/Protocol/Safety/DDL metadata 及 Markdown 双向覆盖仍未完成 | G0.4-G0.9 |
| R-005 | DDL feasibility | DEFERRED | Logical Schema 尚未转换为 executable migration；不代表已发现冲突，但 G1 必须以真实 SQLite Gate 验证 | G1 |
| R-006 | Certification | DEFERRED | Product Floor 和 profile 已冻结；Launcher/Core Release/Managed Node executable/native module 完整 key、Supported Limits 与事务预算尚未 benchmark 认证 | G8 |
| R-007 | Dependency audit | OPEN_OUT_OF_SCOPE | exact lock 的 `npm ci` 报告 30 项 transitive dependency audit 告警；G0.1 不运行会漂移规范 pinned identity 的自动修复，需独立依赖维护评审 | 独立维护 |
| R-008 | Formatting baseline | OPEN_OUT_OF_SCOPE | 仓库既有 `npm run format:check` 对 34 个 G0.2 外旧 TypeScript 文件报差异；G0.2 新文件 targeted Prettier 通过，未把无关批量格式化混入原子提交 | 独立维护 |
| R-009 | Concurrent repository change | CLOSED | `32f3c51` 只新增范围外 evaluation 文档；G0.2 最终 HEAD/边界和 staged set 已验证，提交保留且未混入 G0.2 内容 | G0.2 |
| R-010 | Node loader deprecation | OPEN_OUT_OF_SCOPE | Node 26 下 pinned `tsx` loader 在 `contracts:generate/check` 报 `DEP0205 module.register()` deprecation warning，但命令退出码为 0；G0.2 不升级非规范依赖或替换工具链 | 独立工具链维护 |

## 下一步

下一会话开始 `G0.4 Catalogs and Protocol Tables`。先完整阅读架构规范和本文，复核本次 G0.3 原子提交及其八个 closed Schema/fixtures/conformance，再按 G0.4 范围机器化 Error/Fact/Event/Permission/Reason/Denial、状态与 T0-T8/T6e 表。G0 总 Gate 继续为 `IN_PROGRESS`；不得越过 G0.4 开始 G0.5、G1 Store/DDL、G2 Compiler lowering/normalization/proof、Golden sealing、Registry、T0-T8 Runtime 语义、Runtime Center 或 UI。
