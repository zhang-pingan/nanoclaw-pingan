---
name: fix-test-bug
description: Use only in the fix_test workflow. Verify a fix_test bug fix on staging, record first-pass or regression results, and return structured workflow verdicts.
---

# Bug 测试验证 Skill

本技能仅用于 `fix_test` 工作流，不用于其他流程类型。

本技能用于 `fix_test` 工作流的测试验证阶段，支持首轮验证和复修后的回归验证。

## 模式判断

- 如果 `fix-test.md` 不存在，按首轮验证执行。
- 如果 `fix-test.md` 已存在，或任务中包含 Round、复修结果、重新部署等信息，按回归验证执行。

## 工作流程

1. 从任务描述中读取：
   - Bug 描述
   - Bug 附件
   - 服务名称
   - 主分支
   - 预发分支
   - 工作分支
   - 预发工作分支
   - 修复文档 `fix.md`
   - 测试文档 `fix-test.md`
   - 预发部署结果
2. 读取修复文档和代码变更，确认修复点。
3. 按 Bug 描述和修复点设计验证用例，必要时补充回归用例。
4. 在预发环境执行验证：
   - 接口、页面、日志、数据库等方式按服务实际情况选择。
   - 登录态、需要业务 ID 或其他测试数据时，优先使用提问工具向用户补充。**登录态 优先从服务器日志中获取最新的一条token。获取不到时或获取后调用还有鉴权问题才询问用户**
     - 有明确选项的决策题（如是否继续测试、是否接受已知问题、是否覆盖某类回归范围）使用 `mcp__nanoclaw__ask_user_question`
     - 需要用户补充测试信息、验收口径等自由文本时，使用 `request_human_input`
     - 不要仅用 `mcp__nanoclaw__send_message` 做阻塞型确认
5. 将验证结果写入 `/workspace/projects/{服务名}/iteration/{deliverable}/fix-test.md`。
6. 调用 `complete_delegation` 返回结构化结果。

## 测试文档建议格式

```markdown
---
service: {服务名}
deliverable: {交付目录}
work_branch: {工作分支}
staging_work_branch: {预发工作分支}
doc_type: fix-test
---

# Bug 测试验证报告

## Bug 信息
{Bug 描述}

## 验证范围
- {验证点}

## 验证结果
| 编号 | 验证点 | 结果 | 证据 |
|------|--------|------|------|
| TC-001 | {验证点} | 通过/失败/阻塞 | {证据} |

## 未通过问题
### BUG-001: {问题标题}
- 关联用例：TC-001
- 问题描述：{描述}
- 复现步骤：{步骤}
- 预期行为：{预期}
- 实际行为：{实际}

## 结论
{是否通过}
```

如果已确认 `main_branch` 或 `staging_base_branch`，可以一并写入 front matter，但它们不是 Bug 测试验证阶段的必填字段。

## 返回结果要求

- 已完成测试并形成业务结论时，使用 `outcome=success`。
- 环境不可用、关键测试信息缺失且无法继续、工具异常等执行层阻塞才使用 `outcome=failure`。
- `result` 必须是 JSON，至少包含：
  - `service`
  - `work_branch`
  - `staging_work_branch`
  - `deliverable`
  - `test_doc`
  - `total`
  - `passed`
  - `failed`
  - `blocked`
  - `bugs`
  - `verdict`
  - `summary`
  - `findings`
  - `evidence`
- 如果已确认 `main_branch` 或 `staging_base_branch`，也一并返回，但它们不是 Bug 测试验证阶段的必填字段。
- 全部通过时 `verdict=passed`。
- 只要存在失败用例或仍未修复的问题，`verdict=failed`。
- 信息不足但已形成结构化阶段结论时，`verdict=pending`。

通过返回示例：

```json
{
  "service": "catstory",
  "work_branch": "bugfix/login-500",
  "staging_work_branch": "staging-deploy/bugfix-login-500",
  "deliverable": "2026-04-27_bugfix_login-500",
  "test_doc": "/workspace/projects/catstory/iteration/2026-04-27_bugfix_login-500/fix-test.md",
  "total": 5,
  "passed": 5,
  "failed": 0,
  "blocked": 0,
  "bugs": [],
  "verdict": "passed",
  "summary": "共 5 条验证项，全部通过。",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-04-27_bugfix_login-500/fix-test.md",
      "summary": "已写入 Bug 测试验证报告"
    }
  ]
}
```

不通过返回示例：

```json
{
  "service": "catstory",
  "work_branch": "bugfix/login-500",
  "staging_work_branch": "staging-deploy/bugfix-login-500",
  "deliverable": "2026-04-27_bugfix_login-500",
  "test_doc": "/workspace/projects/catstory/iteration/2026-04-27_bugfix_login-500/fix-test.md",
  "total": 5,
  "passed": 4,
  "failed": 1,
  "blocked": 0,
  "bugs": [
    {
      "id": "BUG-001",
      "title": "登录态为空时仍返回 500",
      "severity": "high",
      "related_case": "TC-001"
    }
  ],
  "verdict": "failed",
  "summary": "共 5 条验证项，通过 4 条，失败 1 条，需要复修。",
  "findings": [
    {
      "code": "bug_still_failing",
      "severity": "high",
      "message": "BUG-001 登录态为空时仍返回 500。",
      "stageKey": "bug_test",
      "path": "/workspace/projects/catstory/iteration/2026-04-27_bugfix_login-500/fix-test.md",
      "suggestion": "继续修复空登录态分支的异常处理。"
    }
  ],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-04-27_bugfix_login-500/fix-test.md",
      "summary": "测试报告中记录 1 个未通过问题"
    }
  ]
}
```
