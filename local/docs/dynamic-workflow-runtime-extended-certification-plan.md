# Dynamic Workflow Runtime Extended Certification Plan

> **状态**：未来独立方案；默认不执行。
> **启用条件**：只有用户明确决定启动本方案时，才为当次独立工作建立 authority、实现、运行与验收任务。
> **非依赖声明**：本方案不是 current G8、G9、默认 CI、release build、Runtime Launcher startup smoke、Production activation 或任何 automation 的前置条件。current G8 的唯一正式边界以 `local/docs/dynamic-workflow-dag-framework.md` 为准。

## 目标与边界

本方案保存原 G8 全量发布认证设计：在固定参考机器等级、exact managed release 环境和完整 SQLite identity 下，对 T3、T7、T8/Root Finalization 的所有要求形状执行 90-case、10 warmup + 100 measurement、25/50/100% scaling 统计认证，并生成与完整 certification key 精确绑定的 certified SQLite Profile、RuntimeSupportedLimits、benchmark observation 和 certification pack。

它不得被 current readiness evidence 冒充，也不得从历史开发机 observation、`.nvmrc`、shell `PATH`、candidate SQLite Profile 或 current G8 的 `not_certified` report 推导 certified 声明。若未来执行失败，不得通过降低 Product Floor、删除 required shape、拆分 T3/T7/T8 原子协议或修改统计口径取得通过。

## 固定执行环境

- deployment/runtime/platform/arch：`local_single_user + node_service + darwin/arm64`。
- Runtime：stable Icarus Runtime Launcher 启动 active content-addressed managed Node installation。
- Node/npm/native：Node `26.5.0`、npm `11.17.0`、`better-sqlite3` `12.11.1`，release build 加载同一 active installation 的 native module。
- SQLite：真实临时文件 `workflow-runtime.db`，Schema 11，完整 Production PRAGMA/索引，`BEGIN IMMEDIATE`，每次运行后执行 `integrity_check` 与 `foreign_key_check`。
- storage：隔离临时 `DATA_DIR/STORE_DIR`，不得读取或写入用户数据；reference run 使用 internal APFS SSD。
- 参考机器最低等级：Apple Silicon M2、16 GiB RAM、AC power、release build、无并发 benchmark 干扰。
- 所有 Node/npm/npx 命令必须经 `./scripts/runtime-toolchain.sh exec --`。

## 90-case 矩阵

每个 shape 固定六种 profile：`smoke`、`scaling_25`、`scaling_50`、`scaling_100`、`supported_limit`、`beyond_limit`。15 个 shape 乘 6 个 profile，共 90 cases。

| Transaction family | Required shapes |
| --- | --- |
| T3 | `long_chain`、`wide_fan_out_in`、`diamond`、`route_group`、`completion_heavy`、`condition_heavy` |
| T7 | `deep_tree`、`wide_tree`、`large_nested_map`、`mixed_lifecycle`、`effect_heavy_subtree` |
| T8 / Root Finalization | `maximum_required_child`、`claim_handoff_competition`、`retry_exhaustion`、`all_or_nothing` |

T3/T7/T8 必须调用 production transaction entry，不得用模型、mock 或手写 SQL 代替。

## 规模与 Product Floor

`local_single_user_product_floor@1` 是完整认证的最低功能能力；certified profile 可以更高，不能更低：

| Dimension | Minimum certified value |
| --- | ---: |
| `max_scopes_total` | 128 |
| `max_nodes_total` / `max_nodes_per_scope` | 1024 / 128 |
| `max_edges_total` / `max_edges_per_scope` | 4096 / 512 |
| `max_map_items_total` / `max_items_per_map` | 256 / 128 |
| `max_attempts_total` | 4096 |
| `max_waits_total` | 512 |
| `max_builds_total` | 512 |
| `max_effect_operations_total` | 2048 |
| `max_facts_per_transaction` | 16384 |
| `max_frontier_bytes` | 16777216 |
| `max_nesting_depth` | 8 |
| `max_required_child_creations_per_t8` | 8 |

T7 必须在 floor 上证明一次不可拆 root fence 能覆盖 scopes、nodes、edges、attempts、waits、builds、map slots、effects、derived facts 与 canonical manifest bytes；T8 必须在同一事务完成 required-child 创建、Claim handoff 与 workflow transition/cut。

## 采样与统计

- 每个非 Beyond Limit case 先 warmup 10 次，再 measurement 100 次。
- 每个 measurement 使用从已关闭 baseline 复制的独立真实文件数据库，按 Production PRAGMA 重开。
- 记录 p50/p95/p99/max、WAL bytes、peak RSS、affected rows，以及 shape 对应的 facts/scopes/children 等正确性维度。
- Supported Limit 预算：T3 `p99 <= 250 ms`、T7 root fence `p99 <= 1000 ms`、T8 required-child `p99 <= 500 ms`；各 family 的 max 不得超过对应预算 2 倍。
- 25/50/100% scaling 必须保留同一 shape 语义并验证复杂度曲线，没有通过曲线不得只凭绝对时长通过。
- Beyond Limit 不进入业务 transaction 或任何写连接，必须确定性返回 `runtime_supported_limit_exceeded`，`affected_rows=0`，database before/after hash 完全一致。
- T8 `all_or_nothing` 还必须保留 before-commit fault，证明 Cut、Child relation、Claim 与 transition 全成或全不变。

## 完整 Certification Key

完整 key 必须逐项绑定：

- deployment profile、runtime surface、platform、arch；
- Core Release Manifest、release artifact hash、Core build hash、release inventory；
- Database Schema version/hash 与 migration authority；
- stable Runtime Launcher/toolchain hash；
- Managed Node Distribution ref/hash、active installation、Node executable version/hash；
- `better-sqlite3` version/native module hash、SQLite version/source id/compile-options hash；
- certified SQLite Execution Profile ref/hash；
- benchmark harness version/hash、90-case observation hash、limit derivation hash；
- Product Floor ref/hash、minimum-machine-class ref/hash/observation；
- startup-smoke harness/report hash与最大 duration；
- RuntimeSupportedLimits ref/hash、certification timestamp、security validation disposition。

任一字段缺失、不匹配或来自不同 source/release 时必须 fail closed；禁止把 candidate `local_single_user_sqlite@1` 原地重标 certified。

## 产物与检查

未来独立任务至少生成 closed-schema、content-addressed 的：minimum-machine observation、startup-smoke report、90-case benchmark observation、certified SQLite Profile、RuntimeSupportedLimits、certification key 和 certification pack。生成器必须在相同输入与固定 timestamp 下 byte-stable，checker 只读重算 envelope、payload、case、inventory 与交叉引用 hash，并用正负 fixture 验证 unknown/missing field、identity mismatch、floor below minimum、样本不足、预算失败和 Beyond Limit 写入均被拒绝。

完整 run 只有全部 cases、统计、identity、schema 与 checker 一次性通过才可作为该未来任务 evidence。中断、部分输出、preflight、历史 observation 或 current G8 readiness report 都不得计入。

## 失败与变更规则

- floor shape 或预算失败时保持未认证；不得降低 Product Floor。
- 高于 floor 的可选 certified ceiling 只有在完整 shape 仍覆盖 floor 时才可下调，并必须发布新 version/hash。
- 不得把 T3 fixed point、T7 subtree/root fence 或 T8 required-child commit 拆成多个对外可见事务。
- 需要更大 Graph 时发布新 Run Protocol 与新的完整认证，不作为现有协议性能补丁。
- 本方案未来若获明确启动，需重新确认当时的安全验证权限；未获授权的 security-sensitive identity/integrity 动态对抗维度必须记录 `SECURITY_VALIDATION_NOT_RUN`，不能据此声明该维度 PASS。
