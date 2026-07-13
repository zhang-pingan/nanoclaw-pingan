# Dynamic Workflow Graph Runtime 文档规范化与拆分方案

## 1. 背景

当前 `dynamic-workflow-dag-framework.md` 同时承担多种职责

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

新增规范目录
