# dev_test / fix_test 待迁移说明

## 状态

- 决策：延期，尚未批准迁移。
- 所属范围：独立迁移候选，不属于 Dynamic Workflow Graph Runtime v1 的实现、认证或验收范围。
- 当前用途：保存原始字节、行为线索和未来重新设计所需的输入材料。
- 执行约束：本目录不得被 Icarus、Feature Runtime、Registry、Compiler、测试 fixture discovery 或打包流程读取。

未来只有在重新确认产品需求后，才能由独立任务把这些材料翻译成新的 Feature、Recipe、Definition、Capability、Wait、Notification/Card、Artifact 和 Evaluator 资源。不得把原 JSON 直接接入新 Runtime，也不得恢复 legacy loader。

## 原始资源

原始文件位于 `raw/`，完整哈希见 `SHA256SUMS`：

- Workflow Definition：`dev_test.json`、`fix_test.json`
- Card：`dev_test.json`
- Artifact Contract：`workflow-stage-core.json`
- Evaluator：`workflow-stage-core.json`
- Workflow 专属 Skill：10 个 `SKILL.md`
- 隐式 System Action：`service.test_token` 源码快照
- 原 Skill 到 group 的绑定：`extracted/skill-bindings.json`

原 Definition 中已经包含 create form、entrypoint、role、task template、handoff、transition、notification、card ref 和 context requirement；这些内容以原始 JSON 为准，本文不复制完整 payload。

## dev_test 行为概览

入口：

- `plan -> plan`
- `dev -> dev`，要求已有 `plan.md`
- `testing -> awaiting_confirm`，要求已有 `dev.md`，`plan.md` 可选

主要路径：

```text
plan -> plan_examine
  -> dev
  -> dev_examine
  -> awaiting_confirm
  -> ops_deploy
  -> testing_token_router
  -> testing_confirm? -> testing
  -> passed
                 \\-> fixing -> ops_deploy -> ...
```

人工分支：

- `plan_examine_confirm`: `approve -> dev`, `revise -> plan`
- `dev_examine_confirm`: `approve -> awaiting_confirm`, `revise -> dev`
- `awaiting_confirm`: `approve -> ops_deploy`
- `testing_confirm`: `submit/skip -> testing`

终态：`passed`、`ops_failed`、`cancelled`。旧 `paused` 是业务状态伪装的控制状态，未来不得原样迁移。

## fix_test 行为概览

入口：`fix -> bug_fix`

```text
bug_fix -> ops_deploy -> testing_token_router -> bug_test -> passed
                                                  \\-> bug_refix
                                                       -> ops_deploy -> ...
```

终态：`passed`、`ops_failed`、`cancelled`。旧 `paused` 同样不得原样迁移。

## Card 与人工动作

原 Card 资源包含：

- `plan_examine_confirm`: `approve`, `revise`, `cancel_workflow`
- `dev_examine_confirm`: `approve`, `revise`, `cancel_workflow`
- `deploy_confirm`: `approve`, `pause_workflow`, `cancel_workflow`
- `testing_confirm`: `submit`, `skip`, `pause_workflow`, `cancel_workflow`，字段 `access_token`

未来如迁移，Durable Wait/Signal 或 typed Business Command 必须成为权威事实；Card 只能是可重建、best-effort 的展示和输入投影。Pause/Cancel 必须走 Runtime Command Gateway。`access_token` 必须替换为 Credential Ref，不得作为普通 Card payload 或 Workflow Value 落盘。

## Artifact 与 Evaluator

Artifact Contract：

- `dev_test.plan.v1`
- `dev_test.dev.v1`
- `dev_test.ops_deploy.v1`
- `dev_test.testing.v1`
- `fix_test.bug_fix.v1`
- `fix_test.ops_deploy.v1`
- `fix_test.bug_test.v1`

Evaluator 另含：

- `dev_test.plan_review.v1`
- `dev_test.dev_review.v1`

原 Artifact/Evaluator 文件只服务这两个 Workflow，已整体归档。

## 隐式行为与兼容特判

详见 `extracted/source-special-cases.md`。未来迁移不能只读取 Definition JSON，还必须重新判断这些旧行为是否仍有产品价值：

- `service.test_token` 读取 `groups/global/services.json`
- plan/dev result 的 traceability 特判
- `workflow_type = dev_test` 的数据库默认值
- inline transition delegation
- self-loop retry/refix
- old pause/retry/return/card action semantics

这些行为只是迁移输入，不是新实现要求。

## 场景索引

详见 `extracted/test-scenario-index.md`。该索引从旧测试中提取产品行为；旧测试代码本身属于 legacy Runtime，将随 legacy 实现删除。

## 未来决策门

未来迁移前必须重新回答：

1. 这两个流程是否仍对应真实高频产品入口。
2. 应合并为一个 Feature，还是拆成开发与修复两个 Feature。
3. 三个 `dev_test` entrypoint 是否应成为三个 exact Recipe。
4. 原 Skill、Prompt、Artifact 和 Evaluator 是否仍满足当前工程实践。
5. 预发部署和代码修改需要哪些 Domain Claim、Effect、Receipt 与 Compensation。
6. 原 Card 是否仍需要，还是应由 Feature UI 直接承载业务操作。
7. 哪些旧循环应变成 Definition rework，哪些应变成 Node retry。

批准迁移后，应从这些材料重新生成 closed-world source，并通过当时版本的 Contract Pack、Compiler Golden、Runtime scenario 和 Feature UI/API tests。Dynamic Runtime 的实现不得提前为本候选包加入特例。
