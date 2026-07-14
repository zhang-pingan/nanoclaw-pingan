---
name: ops-staging-deploy
description: Deploy service branches to staging environment — merge code, trigger Jenkins builds, verify deployment, and inspect logs.
---

# 预发部署 Skill

## 预发部署流程

当收到预发部署任务时：

1. 优先读取任务消息中的 `主分支`、`工作分支`；同时读取 `/workspace/global/services.json` 获取对应服务的 `staging.jenkins_job`、`default_branch` 作为兜底
2. 服务仓库目录为 `/workspace/repos/{服务名}/`
3. 明确以下参数并严格区分：
   - `主分支` = 当前项目的主分支，如果未提供，则使用 `default_branch`
   - `工作分支` = 当前需求开发/修复所在业务分支；空值、`N/A`、`未提供` 都视为未提供，如果未提供，则需要和用户确认
4. 确认工作分支已推送到远端；不要创建或维护额外的部署分支。
5. 触发 Jenkins 部署：
   - 使用 `$JENKINS_URL`、`$JENKINS_USER`、`$JENKINS_PASSWORD` 环境变量
   - 先获取 CSRF crumb：`GET /crumbIssuer/api/json`
   - 触发参数化构建，并传入 `BRANCH={工作分支}`：`POST /job/{staging.jenkins_job}/buildWithParameters?BRANCH={工作分支}`
   - 轮询构建状态直到完成
6. 通过 `complete_delegation` 返回结果：
   - 部署流程已执行完成并得出明确结论时，统一使用 `outcome=success`
   - `outcome=failure` 只用于执行层失败或阻塞，例如：缺少 Jenkins 配置、无法确认分支、无法访问部署环境、工具异常退出
   - `result` 必须是 JSON，至少包含：`service`、`main_branch`、`work_branch`、`verdict`、`summary`、`findings`、`evidence`
   - 部署成功时使用 `verdict=passed`
   - 部署完成但失败时使用 `verdict=failed`
   - 成功示例：

```json
{
  "service": "catstory",
  "main_branch": "main",
  "work_branch": "feature/user-nickname_20260320",
  "verdict": "passed",
  "summary": "预发部署完成，可以进入测试确认。",
  "findings": [],
  "evidence": [
    {
      "type": "workflow_state",
      "summary": "Jenkins 已基于 feature/user-nickname_20260320 完成部署"
    }
  ]
}
```

   - 失败示例：

```json
{
  "service": "catstory",
  "main_branch": "main",
  "work_branch": "feature/user-nickname_20260320",
  "verdict": "failed",
  "summary": "预发部署已执行，但 Jenkins 构建失败。",
  "findings": [
    {
      "code": "jenkins_build_failed",
      "severity": "critical",
      "message": "Jenkins 构建返回 failed。",
      "stageKey": "ops_deploy",
      "suggestion": "检查构建日志并修复后重新部署。"
    }
  ],
  "evidence": [
    {
      "type": "message",
      "summary": "Jenkins build #123 最终状态为 FAILED"
    }
  ]
}
```

   - 若执行层失败，`result` 也应尽量返回 JSON，至少包含 `summary`、`error`、已确认的主分支和工作分支
   - 若任务消息已提供上述分支参数，返回结果中必须原样沿用；不要替换成新的 `feature/...`
