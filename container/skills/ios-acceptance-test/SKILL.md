---
name: ios-acceptance-test
description: Use only in the ios_dev_test workflow. Build and execute iOS acceptance cases against a real simulator app, then publish ios-test-plan.json and acceptance-report.json with formal evidence.
---

# iOS 联调验收 Skill

本技能仅用于 `ios_dev_test` 工作流的 `ios_acceptance` 阶段。

目标：把 plan/dev 文档和 iOS Recon 产物转成可执行的 iOS test case，使用真实 App flow、UI 状态、网络 trace 和 crash 结果进行验收。

## 必须先读

1. Context Pack `latest` 文件。
2. `plan.md`、`dev.md`。
3. `product-recon.json`、`impact-analysis.json`，以及可选 `prototype-analysis.json`。
4. 委派消息中的测试用例文档、access_token、主分支、工作分支。
5. `/workspace/global/services.json` 中当前服务的 `clients.ios` 自动化配置。

## 工具使用规则

- 必须先生成或读取 `ios-test-plan.json`。
- 必须调用 `ios_app_prepare_session` 准备 staging/debug App。
- 每个 passed case 必须来自 `ios_app_run_test_case` 的执行结果；不能用自由探索结果直接标记 passed。
- 可以用 `ios_app_observe`、`ios_app_act`、`ios_app_run_flow` 辅助定位和排障，但正式验收结果必须落到 test case。
- 必须通过 `ios_app_write_report` 写出 `acceptance-report.json`。
- 如果缺少稳定 locator、deeplink、network log 或 crash log，相关断言必须标记 blocked 或写入 limitations；不得伪造通过。
- `ios_host_debug_shell` 只允许排障；`DEBUG-*` 不得支撑 passed verdict。

## 需要写出的产物

在 `/workspace/projects/{service}/iteration/{deliverable}/` 下写出：

- `ios-test-plan.json`
- `acceptance-report.json`
- 可补充或创建 `test.md` 中的 iOS 联调验收摘要

`ios-test-plan.json` 必填字段：

- `version`
- `platform`
- `service`
- `session_purpose`
- `cases`
- `evidence`

`acceptance-report.json` 必填字段：

- `version`
- `platform`
- `service`
- `session_id`
- `summary.total`
- `summary.passed`
- `summary.failed`
- `summary.blocked`
- `cases`
- `verdict`
- `evidence`

验收规则：

- `verdict=passed` 必须满足 `failed=0` 且 `blocked=0`。
- 每个 passed case 必须引用 `CASE-*` 和至少一个 passed `ASSERT-*`。
- 网络日志或 crash 日志未配置时，相关断言不能伪造通过；应标记 blocked 或在 limitations 中说明未覆盖。
- `failed > 0` 或 `blocked > 0` 时，完整返回结构化问题，workflow 会进入修复链路。

## complete_delegation

无论成功或失败，都必须调用 `complete_delegation`。业务失败或阻塞但报告已形成时使用 `outcome=success`，让工作流依据 `failed/blocked/verdict` 路由；只有执行层无法形成报告时才使用 `outcome=failure`。

成功 result JSON 至少包含：

```json
{
  "service": "catstory",
  "deliverable": "2026-06-01_example",
  "main_branch": "main",
  "work_branch": "feature/example",
  "ios_test_plan": "/workspace/projects/catstory/iteration/2026-06-01_example/ios-test-plan.json",
  "acceptance_report": "/workspace/projects/catstory/iteration/2026-06-01_example/acceptance-report.json",
  "total": 1,
  "passed": 1,
  "failed": 0,
  "blocked": 0,
  "bugs": [],
  "verdict": "passed",
  "summary": "iOS 联调验收通过。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "refId": "EVID-IOS-ACC-001",
      "path": "/workspace/projects/catstory/iteration/2026-06-01_example/acceptance-report.json",
      "summary": "已写入 acceptance-report.json"
    }
  ]
}
```

当缺少 App 配置、Simulator 不可用、iOS build 不可用或测试账号不可用时，返回 `verdict=pending`，`blocked` 计数大于 0，并在 `findings` / `limitations` 中说明阻塞原因。

