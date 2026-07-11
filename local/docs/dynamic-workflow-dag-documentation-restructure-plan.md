# Dynamic Workflow Graph Runtime 文档规范化与拆分方案

> **状态**: 已确认方案，待后续执行
> **源文档**: [Dynamic Workflow Graph Runtime 完整架构方案](./dynamic-workflow-dag-framework.md)
> **本次边界**: 只建立拆分方案，不移动、不删减、不改写源文档，不创建目标 SQL、JSON Schema、fixture 或实现代码
> **执行前提**: 当前架构问题与工程优化全部讨论完成，源文档按最终决策更新并冻结一个可追踪版本

## 1. 背景

当前 `dynamic-workflow-dag-framework.md` 同时承担以下职责：

- 架构背景、目标、非目标和核心不变量。
- Task Intake、Recipe、Routing 与 Workflow 创建协议。
- Source IR、Compiled IR、Schema、Compiler 和 Hash 规范。
- Run、Scope、Node、Wait、Map、Completion 与恢复状态机。
- Ledger、Value/Blob Store、Domain Claim 与 Effect 合同。
- 持久化表、T0-T8 事务、CAS 和 SQLite 执行约束。
- 错误语义、Workbench 命令、实施顺序和验收标准。
- 设计理由、示例和被排除的替代方案。

单文档便于完整阅读，但随着方案进入实现阶段会产生以下风险：

1. 同一概念分散在类型、表结构、事务和验收章节，修改时容易出现遗漏或冲突。
2. 伪 SQL 和示例 JSON 看起来接近可执行规范，但无法直接由工具验证。
3. 硬性协议与设计解释混在一起，实施者难以判断某段文字是否属于必须满足的不变量。
4. 错误码、限制字段和状态转换散落在自然语言中，Runtime、Workbench 和测试可能形成不同解释。
5. 章节标题和行号不稳定，无法作为长期需求追踪标识。

因此后续将源文档规范化为一个总览入口和一组职责单一、相互引用的规范文档与可执行工件。

## 2. 目标

- 保留一个适合架构评审和完整导航的稳定入口。
- 明确区分 Normative Spec 和 Rationale。
- 让每个核心定义只有一个 Source of Truth。
- 让 SQL、JSON Schema 和 compiler fixture 可以被工具直接验证。
- 为核心不变量、事务、错误、限制和命令分配稳定 Requirement ID。
- 建立从 Requirement 到实现模块、数据库约束和测试的 Conformance Matrix。
- 在不改变已确认运行语义的前提下完成文档重组。

## 3. 非目标

本方案不授权或包含以下工作：

- 本次不拆分现有源文档。
- 本次不修改任何已确认的 Runtime、Compiler、Ledger、Claim、Effect、Context 或恢复语义。
- 本次不创建正式数据库表或迁移。
- 本次不选择 TypeScript、JSON Schema 或代码生成工具链。
- 本次不实现 Graph Runtime。
- 本次不删除源文档中的重复定义；实际去重只在拆分阶段进行。
- 本次不改变现有 `local/docs` 中其他方案文档的结构。

## 4. 规范用语

拆分后的所有文档统一使用以下强度：

| 用语 | 英文 | 含义 |
| --- | --- | --- |
| 必须 | MUST | 实现不可违反；违反即不符合规范 |
| 禁止 | MUST NOT | 实现不可执行该行为 |
| 应该 | SHOULD | 除非记录明确理由，否则必须遵守 |
| 不应该 | SHOULD NOT | 除非记录明确理由，否则不得采用 |
| 可以 | MAY | 可选能力，不影响基础符合性 |

包含 `MUST/MUST NOT` 的条目必须具有稳定 Requirement ID，并在 Conformance Matrix 中关联至少一种验证方式。

示例、设计理由、性能建议和未来扩展不得使用未编号的“必须”来引入新协议。

## 5. 目标文件结构

保留现有文件作为稳定入口：

```text
local/docs/dynamic-workflow-dag-framework.md
```

未来新增规范目录：

```text
local/docs/dynamic-workflow-dag/
  01-core-model.md
  02-source-ir-and-compiler.md
  03-runtime-protocol.md
  04-persistence-and-transactions.md
  05-errors-and-commands.md
  06-security-limits-and-operations.md
  07-rationale-and-decisions.md
  08-conformance-matrix.md

  schema/
    workflow-graph.sql
    workflow-task.schema.json
    workflow-graph-scope.schema.json
    workflow-registry.schema.json

  catalog/
    error-codes.json
    requirements.json

  fixtures/
    compiler/
    transactions/
    recovery/
```

目录和文件可以在实际拆分前根据最终架构小幅调整，但职责边界不得重新合并为单一大文档。

## 6. 文件职责

### 6.1 现有入口文档

`dynamic-workflow-dag-framework.md` 后续缩减为：

- 状态、范围、目标和非目标。
- 架构总览图与核心对象关系。
- 最高层核心不变量摘要。
- 各规范文档导航。
- 当前实现/验收状态摘要。
- 规范版本与变更记录入口。

入口文档不得再次完整复制 IR、表结构、状态转换或错误码。

### 6.2 `01-core-model.md`

权威负责：

- 术语和核心对象。
- Workflow、Activation、Run、Scope、Node、Attempt、Wait 的所有权关系。
- Recipe、Definition、Context 和 Final Output Contract。
- Effect 的恢复方式与业务影响双维度模型。
- Domain Claim slot 与逻辑 Claim binding。
- 核心不变量及其 Requirement ID。

### 6.3 `02-source-ir-and-compiler.md`

权威负责：

- Source IR 与 Compiled IR。
- Node、Control Edge、Data Edge、Trigger 和 Port 合同。
- `icarus.workflow-schema/1` Profile。
- Schema assignability、JSON Pointer 和 compatibility proof。
- Policy intersection、Capability binding 和 Compiler validation。
- Canonical JSON、domain-separated hash 和 compiler version。

### 6.4 `03-runtime-protocol.md`

权威负责：

- Run、Scope、Node、Attempt、Wait 和 Controller 状态机。
- Route/Data resolution、Input Seal 和 fixed-point reconcile。
- Completion arbitration、Close Request 和 Completion Cut。
- Retry Schedule、Deadline Watchdog、Pause 和 Resume。
- `work_fence_epoch`、close cleanup lane 和 hierarchical close。
- Subgraph、Expand、Map 和 Child consumption disposition。
- Recovery 协议。

### 6.5 `04-persistence-and-transactions.md`

权威负责：

- 持久化对象与关系约束说明。
- T0-T8 事务边界和 CAS 条件。
- Resource Account、Reservation、Posting 和 Ledger entry。
- Value/Blob Store 完整性、容量和 Retention。
- Inbox、Outbox、Effect Journal、Manifest 和 Checkpoint。
- SQLite transaction profile 与 composite FK 要求。

完整可执行 DDL 以 `schema/workflow-graph.sql` 为唯一权威来源。本文档只解释表的职责、关键约束和事务使用方式，不复制整份 SQL。

### 6.6 `05-errors-and-commands.md`

权威负责：

- Error taxonomy 和稳定错误码。
- retryable、non-retryable、engine error、action-required 和 quarantine 分类。
- Runtime command envelope、expected version 和 idempotency。
- Workbench command、HTTP/IPC 状态和错误映射。
- Manual skip、cancel、retry advance 和 administrative abandon 边界。

错误码的机器可读权威来源为 `catalog/error-codes.json`。

### 6.7 `06-security-limits-and-operations.md`

权威负责：

- Capability permission、Effect 和 Cancellation Contract。
- Domain Claim、exclusive write、fencing token 和 mutation gateway。
- Pinned Safety Ceiling 与 Live Capacity。
- Enforcement Matrix。
- Logical/physical byte、GC、Backpressure 和 Retention。
- Registry/Executor retention 与 Feature lifecycle。

### 6.8 `07-rationale-and-decisions.md`

只负责非规范性内容：

- 关键设计为什么成立。
- 被否决方案及其代价。
- 当前评审逐条确认的决策。
- 未来扩展条件。
- 已知权衡和部署假设。

Rationale 不得成为唯一包含 MUST 规则的位置。

### 6.9 `08-conformance-matrix.md`

负责把规范映射到实现和验证：

```text
Requirement ID
规范链接
实现模块
数据库约束
Fixture/Test
当前状态
```

Conformance Matrix 是覆盖检查入口，不复制 Requirement 的完整内容。

## 7. Source of Truth 规则

| 对象 | 唯一权威来源 | 其他位置允许内容 |
| --- | --- | --- |
| 核心不变量 | `01-core-model.md` / `catalog/requirements.json` | ID、摘要和链接 |
| Source/Compiled IR | `02-source-ir-and-compiler.md` | 示例和引用 |
| 状态转换 | `03-runtime-protocol.md` | 状态摘要和链接 |
| T0-T8/CAS | `04-persistence-and-transactions.md` | 高层流程引用 |
| SQL 表/索引/CHECK/FK | `schema/workflow-graph.sql` | 解释和局部示例 |
| JSON Schema | `schema/*.schema.json` | TypeScript 派生类型或链接 |
| Error code | `catalog/error-codes.json` | 人类可读解释和映射 |
| Safety Enforcement | `06-security-limits-and-operations.md` | 字段引用 |
| 设计理由 | `07-rationale-and-decisions.md` | 简短摘要和链接 |
| 验收映射 | `08-conformance-matrix.md` | 状态摘要 |

若实现需要 TypeScript 类型，必须从权威 Schema 生成或通过一致性测试证明逐字段等价，不能维护两份无人校验的手写合同。

## 8. 稳定 Requirement ID

建议使用以下前缀：

| 前缀 | 范围 | 示例 |
| --- | --- | --- |
| `INV` | 核心不变量 | `INV-001` |
| `CREATE` | Intake、Routing、Creation | `CREATE-012` |
| `IR` | Source/Compiled IR | `IR-021` |
| `COMP` | Compiler/Schema | `COMP-018` |
| `RUN` | Runtime 状态机 | `RUN-034` |
| `WAIT` | Wait/Signal/Timer | `WAIT-009` |
| `TX` | 事务/CAS | `TX-T7A-004` |
| `DB` | 数据库约束 | `DB-027` |
| `ERR` | 错误语义 | `ERR-023` |
| `CMD` | Command API | `CMD-011` |
| `LIM` | Safety/Capacity | `LIM-014` |
| `OPS` | Recovery/Operations | `OPS-019` |
| `DEC` | 架构决策 | `DEC-006` |

编号规则：

- ID 发布后不得改变含义或分配给另一要求。
- 删除的要求保留为 `deprecated`，编号不复用。
- 纯文字重排不得改变 ID。
- 一个 Requirement 可以对应多个测试，但每个 MUST Requirement 至少有一个验证入口。
- 事务编号保留现有 `T0-T8` 名称，并在其下增加稳定子编号。

## 9. 当前章节迁移映射

| 当前内容 | 目标位置 |
| --- | --- |
| 背景、目标、非目标、对象总览 | 入口文档 + `01-core-model.md` |
| Task Intake、Recipe、Macro Routing | `01-core-model.md` + `06-security-limits-and-operations.md` |
| State 与 Graph 统一 | `01-core-model.md` + `03-runtime-protocol.md` |
| Scope Interface、Source IR、Fixture | `02-source-ir-and-compiler.md` + `fixtures/compiler/` |
| Control/Data Edge、Trigger、Input Seal | `02-source-ir-and-compiler.md` |
| Node Union、Map、Subgraph、Expand | IR 定义进入 `02`，运行语义进入 `03` |
| Completion Policy、Early Close | `03-runtime-protocol.md` |
| Capability、Effect、Mutable Mutation | `06-security-limits-and-operations.md` |
| Registry、Compiler、Hash | `02-source-ir-and-compiler.md` |
| Graph/Node 状态模型 | `03-runtime-protocol.md` |
| Ledger、调度、Domain Claim | `06` 定义限制，`04` 定义持久化与事务 |
| Value/Blob Store、表结构 | `04-persistence-and-transactions.md` |
| T0-T8、CAS、SQLite | `04-persistence-and-transactions.md` |
| Retry、Pause、Cancel、Recovery | `03-runtime-protocol.md` |
| Outbox、Checkpoint | `04-persistence-and-transactions.md` |
| Context、Artifact、Quality | `01` 定义合同，`03/04` 定义运行和存储 |
| Workbench、Command | `05-errors-and-commands.md` |
| 设计选择和非目标解释 | `07-rationale-and-decisions.md` |
| 实施顺序、验收标准 | 入口文档 + `08-conformance-matrix.md` |

跨文件主题必须指定一个定义 Owner，其他文件只描述自身阶段的使用方式并链接回 Owner。

## 10. 后续执行阶段

### Phase 0: 冻结输入

- 完成本轮全部架构问题和工程优化讨论。
- 按最终决策更新源文档。
- 记录源文档 hash、日期和规范版本。
- 建立完整章节迁移清单。

Phase 0 未完成前禁止开始实际拆分。

### Phase 1: 建立骨架

- 创建目标目录和空白规范文件。
- 将现有入口文档改为导航，但暂不删除原内容备份。
- 建立相对链接和 Requirement catalog 骨架。

### Phase 2: 提取规范

- 按 Owner 顺序迁移 Core、IR、Runtime、Persistence、Operations。
- 迁移时先复制，再对照去重。
- 每迁移一个定义即指定唯一 Source of Truth。
- 不在迁移过程中改变运行语义；发现新冲突时暂停并单独评审。

### Phase 3: 提取可执行工件

- 将伪 SQL 转成可在空 SQLite 数据库执行的 DDL。
- 将 Source IR 和 Registry 合同转成 strict JSON Schema。
- 将文档 Fixture 转成独立文件并固定 expected hash/diagnostic。
- 确认 TypeScript 类型与 Schema 的单一来源策略。

### Phase 4: 建立 Catalog 与 Matrix

- 为所有 MUST Requirement 分配稳定 ID。
- 建立 error code catalog。
- 建立 Requirement 到模块、DDL、fixture 和测试的映射。
- 标记未实现项，但不得因未实现而删除规范。

### Phase 5: 去重和验证

- 删除非 Owner 文档中的重复完整定义。
- 检查链接、ID、Schema、SQL 和 Fixture。
- 对照源文档逐节确认没有语义遗漏。
- 记录所有有意的文字澄清和零语义变更。

### Phase 6: 切换入口

- 保留原路径作为正式总览入口。
- 在入口中标记规范版本和各文档状态。
- 将后续架构修改流程切换到新的 Source of Truth。
- 保留拆分前源文档的 Git 历史，不额外维护第二份冻结副本。

## 11. Drift 防护

- 新增协议字段时必须同时更新 Owner 文档、Requirement catalog 和 Conformance Matrix。
- 修改 SQL 约束时必须更新对应 DB/TX Requirement 和 transaction fixture。
- 修改 JSON Schema 时必须更新 canonical hash fixture 和 TypeScript 一致性验证。
- 新增错误码必须先进入 error catalog，再由 Runtime/Workbench 引用。
- Rationale 可以补充解释，但不能独立修改 Normative 语义。
- Review checklist 必须包含“是否产生第二个 Source of Truth”。

## 12. 验证要求

实际拆分完成前必须通过以下检查：

1. 现有入口路径和所有相对链接有效。
2. 当前源文档的每个二级/三级章节都已映射到目标 Owner。
3. 所有 Requirement ID 唯一且没有悬空引用。
4. `workflow-graph.sql` 可以在空 SQLite 数据库完整执行。
5. Foreign key、partial unique index、CHECK 和 trigger 由 SQLite 实际验证。
6. 所有 JSON Schema 可以由固定版本 Validator 加载。
7. Compiler fixture 的 canonical source hash、plan hash 和 diagnostic 稳定。
8. Error catalog 中每个 code 都有 category、retryability 和 projection mapping。
9. 每个 MUST Requirement 在 Conformance Matrix 中至少有一个验证入口。
10. 拆分前后核心对象、状态转换、事务和错误语义逐项等价。

## 13. 风险与控制

| 风险 | 控制方式 |
| --- | --- |
| 拆分时遗漏段落 | Phase 0 建立逐章节迁移清单，Phase 5 逐项核对 |
| 多文档重复定义 | 强制 Owner 和 Source of Truth Matrix |
| 为了整理文字顺便改变语义 | 语义变化必须暂停拆分并单独形成 DEC 评审 |
| SQL/Schema 与文档不一致 | 可执行工件作为权威来源并纳入验证 |
| Requirement ID 大量重排 | ID 永不复用，与章节顺序解耦 |
| 总览过度简化导致难以理解 | 保留对象图、不变量摘要和完整导航 |
| 目录过细增加阅读成本 | 固定八份主文档，不按每个类型继续拆小文件 |

## 14. 完成标准

只有同时满足以下条件，文档拆分才算完成：

- 原入口仍可作为完整架构导航使用。
- Normative 与 Rationale 已明确分离。
- 每个核心定义只有一个 Source of Truth。
- DDL、JSON Schema、Error Catalog 和 Fixture 已成为可验证工件。
- 所有 MUST Requirement 具有稳定 ID 和验证映射。
- 源文档内容已全部迁移或明确标记为废弃理由。
- 没有因拆分引入新的协议差异。
- 新结构已经成为后续实现和评审的正式基线。

## 15. 当前决定

本方案文档只固定未来拆分方法。本轮继续在现有架构文档上完成剩余讨论；全部决策确认并统一更新源文档后，再根据本方案启动实际拆分。

