# Dynamic Workflow Runtime 实施进度

> **状态**: READY
> **当前 Gate**: G0 Contract Pack / Static Baseline
> **下一施工切片**: G0.1 Toolchain Identity
> **最后更新**: 2026-07-14
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
- 所有新 Runtime 实现位于 `src/workflow-runtime/`；不得向 `src/` 顶层增加新的 Workflow Runtime 模块。
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

已知 G0 工具链差距：

| 项目 | 当前仓库 | 规范目标 |
| --- | --- | --- |
| `.nvmrc` | `22` | exact `24.18.0` |
| CI Node | hard-coded `20` | `node-version-file: .nvmrc` |
| `packageManager` | 缺失 | exact `npm@11.16.0` |
| `better-sqlite3` | `^11.8.1` | exact `12.11.1` |
| `jsonc-parser` | 缺失 | exact `3.3.1` direct dependency |
| `ajv` | 缺失 | exact `8.20.0` direct dependency |
| `ajv-formats` | 缺失 | exact `3.0.1` direct dependency |
| `json-canonicalize` | 缺失 | exact `2.0.0` direct dependency |
| `fast-check` | 缺失 | exact `4.9.0` dev dependency |
| `@types/node` | `^22.10.0` | exact `24.13.3` |
| `@types/better-sqlite3` | `^7.6.12` | exact `7.6.13` |
| Agent Container base | `node:22-slim` | `node:24.18.0-slim` immutable digest，需按规范区分 Agent Container 与 Executor Artifact identity |

这些差距是 G0.1 的施工输入，不是已发现的架构冲突。

## Gate 总览

| Gate | 状态 | 依赖 | 退出证据 | 完成提交 |
| --- | --- | --- | --- | --- |
| G0 Contract Pack / Static Baseline | `READY` | 无 | schemas/catalogs/protocols/safety/draft bundle + absence/coverage/candidate hashes | - |
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
| I11 | Contract Pack、测试模型、发布门禁、absence baseline | `READY` | G0.1 |

## G0 施工切片

G0 只有全部切片满足退出条件后才能标记 `DONE`。切片编号描述推荐施工边界，不修改规范中的 Gate 依赖。

| 切片 | 内容 | 状态 | 主要退出条件 | 完成提交 |
| --- | --- | --- | --- | --- |
| G0.1 | Toolchain Identity | `READY` | Node/npm/direct dependency/lock/CI identity 一致，基础构建与测试通过 | - |
| G0.2 | Contract Pack Foundation | `NOT_READY` | artifact envelope、VersionedRef、hash/domain、strict parse、目录与 CI 骨架 | - |
| G0.3 | Closed Schemas | `NOT_READY` | Definition/Recipe/Command/Transition/Feature/Card/Source/Compiled IR schemas 与 negative fixtures | - |
| G0.4 | Catalogs and Protocol Tables | `NOT_READY` | Error/Fact/Event/Permission/Reason/Denial、状态与 T0-T8/T6e 表机器化 | - |
| G0.5 | Safety / Retention / SQLite Contracts | `NOT_READY` | Safety、Capacity schema/baseline、Product Floor、Retention、SQLite Profile、Enforcement Matrix | - |
| G0.6 | Logical Schema Metadata | `NOT_READY` | 全对象 Logical Schema manifest source、typed relation metadata、query catalog | - |
| G0.7 | Static Absence and Surface Gates | `NOT_READY` | absence、surface coverage、candidate boundary generator/manifest/negative fixtures | - |
| G0.8 | Golden Draft and Review Input | `NOT_READY` | raw cases、hand-authored semantic assertions、review request；不得伪造 sealed expected output | - |
| G0.9 | G0 Conformance Exit | `NOT_READY` | Markdown/Contract 双向覆盖、完整 G0 CI、artifact hashes 和 Gate review | - |

## 当前施工切片：G0.1 Toolchain Identity

**状态**：`READY`

**工作包**：I11

**目标**：把 Core Runtime/Compiler/CI 的工具链输入固定到规范 S25 与 Compiler Conformance Toolchain 指定的 exact identity，为后续 Contract Pack hash、Golden 和 SQLite certification 建立可重放基线；本切片不创建 Runtime Store、Compiler 语义实现或 production activation。

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
- 与 Node base identity 直接相关的 Container/Executor build 配置；修改前必须先区分规范中的 Core Runtime、Agent Container 和 Executor Artifact，不得把 SQLite certification identity 错误传播到无关 Electron runtime
- `src/workflow-runtime/contracts/` 下仅限表达 toolchain identity 所必需的最小目录或 manifest schema；若其完整语义属于 G0.2，应留到下一切片
- 与本切片直接相关的定向测试
- 本进度文档

**禁止越界**：

- 不实现 Workflow Runtime、Store、DDL、Compiler lowering/normalization/proof、Registry、T0-T8 或 UI。
- 不生成或宣称 Sealed Golden Bundle、certified SQLite Profile 或 Supported Limits。
- 不使用 floating semver、moving container tag 或手写伪造的 native/release identity。
- 不顺手升级规范未要求的依赖；若 Node 24 导致其他依赖不兼容，记录最小问题并按规范联动评审。

**退出条件**：

1. `.nvmrc`、CI Node source 和 `packageManager` 与规范 exact identity 一致。
2. 规范列出的 direct runtime/dev dependencies 使用 exact version，无 `^`/`~`，lockfile integrity 更新完成。
3. 实际运行时 `node --version` 与 `npm --version` 可验证；若当前 shell 未切换到 pinned toolchain，不得用旧 Node 生成最终 lock 或 native-module 证据。
4. Agent Container/Executor identity 按规范正确处理；immutable digest 无法在本环境可靠确认时，不能伪造，必须记录为本切片 blocker 或明确拆分并证明不影响 Core G0.1 退出条件。
5. `npm ci`、typecheck、基础测试和 legacy boundary test 在 pinned toolchain 下通过。
6. CI 使用 `.nvmrc`，并执行 lockfile install；任何新增 toolchain conformance check 有稳定失败信息。
7. 本文记录实际命令、版本输出、测试结果和 commit。

**最低验证命令**：

```bash
node --version
npm --version
npm ci
npm run typecheck
npm test
npx vitest run setup/legacy-workflow-boundary.test.ts
git diff --check
```

如果完整 `npm test` 存在与本切片无关的已知失败，必须保存具体失败并证明不是工具链变更导致；不得只运行定向测试后宣称完成。

## 施工记录

尚无完成的 Dynamic Workflow Runtime 施工切片。

## 当前风险与待验证项

| ID | 类型 | 状态 | 描述 | 处理 Gate/切片 |
| --- | --- | --- | --- | --- |
| R-001 | Toolchain | OPEN | 当前 Node/npm/依赖/CI 与规范 exact identity 不一致 | G0.1 |
| R-002 | Container identity | OPEN | 当前 Agent Container 使用 `node:22-slim` moving tag；需按规范确认 Core、Agent Container、Executor Artifact 的正确固定边界和可验证 digest | G0.1 |
| R-003 | Static proof | OPEN | 当前只有定向 legacy boundary test，尚无规范要求的 AST/API/UI/schema/filesystem/resource manifests | G0.7 |
| R-004 | Contract drift | OPEN | 规范尚未转换为 Machine-readable Contract Pack，Markdown 与未来机器合同的一致性尚未由 CI 证明 | G0.2-G0.9 |
| R-005 | DDL feasibility | DEFERRED | Logical Schema 尚未转换为 executable migration；不代表已发现冲突，但 G1 必须以真实 SQLite Gate 验证 | G1 |
| R-006 | Certification | DEFERRED | Product Floor 和 profile 已冻结，Supported Limits 与事务预算尚未 benchmark 认证 | G8 |

## 下一步

开始 `G0.1 Toolchain Identity`。完成并提交后，把 G0.1 标为 `DONE`，把 G0.2 标为 `READY`，更新 Gate/工作包证据、施工记录和风险表；随后由会话最终回复生成 G0.2 的新会话 Prompt。
