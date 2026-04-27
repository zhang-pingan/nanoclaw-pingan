---
name: ops-staging-deploy
description: Deploy service branches to staging environment — merge code, trigger Jenkins builds, verify deployment, and inspect logs.
---

# 预发部署 Skill

## 预发部署流程

当收到预发部署任务时：

1. 优先读取任务消息中的 `主分支`、`工作分支`、`预发分支`、`预发工作分支`；同时读取 `/workspace/global/services.json` 获取对应服务的 `staging.branch`、`staging.jenkins_job`、`default_branch` 作为兜底
2. 服务仓库目录为 `/workspace/repos/{服务名}/`
3. 明确以下参数并严格区分：
   - `主分支` = 当前项目的主分支，如果未提供，则使用 `default_branch`
   - `工作分支` = 当前需求开发/修复所在业务分支；空值、`N/A`、`未提供` 都视为未提供，如果未提供，则需要和用户确认
   - `预发分支` = 预发基线分支；若消息未提供，则使用 `staging.branch`
   - `预发工作分支` = 用于部署预发的分支；空值、`N/A`、`未提供` 都视为未提供。如果消息未提供，并且`主分支`和`预发分支`不一致，则要基于`预发分支`新建分支，命名为 `staging-deploy/{工作分支名中将 / 替换为 -}`，如果`主分支`=`预发分支`，则`预发工作分支`=`工作分支`
4. 将`工作分支` merge到 `预发工作分支` 中并推送（注意：如果`主分支`和`预发分支`一样，那么`预发工作分支`=`工作分支`，此时不需要merge）：
   - 如果 `git merge` 出现冲突，必须自行分析并完成冲突解决，然后继续提交合并结果；不要因为冲突直接中止任务或返回失败，除非确认无法安全解决
   - `merge` 原则: 非冲突部分，各自接受两个分支的全部改动；冲突部分，接受`工作分支`的改动(**注意**:这样处理后，如果冲突部分，`工作分支`用的都是正式仓库和实体，而`预发工作分支`用的是预发仓库和实体(`_gray`后缀)，还需要在接受`工作分支`的改动后把对应的仓库和实体换成预发仓库和实体)。
5. 触发 Jenkins 部署：
   - 使用 `$JENKINS_URL`、`$JENKINS_USER`、`$JENKINS_PASSWORD` 环境变量
   - 先获取 CSRF crumb：`GET /crumbIssuer/api/json`
   - 触发参数化构建，并传入 `BRANCH={预发工作分支}`：`POST /job/{staging.jenkins_job}/buildWithParameters?BRANCH={预发工作分支}`
   - 轮询构建状态直到完成
6. 通过 `complete_delegation` 返回结果：
   - 部署流程已执行完成并得出明确结论时，统一使用 `outcome=success`
   - `outcome=failure` 只用于执行层失败或阻塞，例如：缺少 Jenkins 配置、无法确认分支、无法访问部署环境、工具异常退出
   - `result` 必须是 JSON，至少包含：`service`、`main_branch`、`work_branch`、`staging_base_branch`、`staging_work_branch`、`verdict`、`summary`、`findings`、`evidence`
   - 部署成功时使用 `verdict=passed`
   - 部署完成但失败时使用 `verdict=failed`
   - 成功示例：

```json
{
  "service": "catstory",
  "main_branch": "main",
  "work_branch": "feature/user-nickname_20260320",
  "staging_base_branch": "staging",
  "staging_work_branch": "staging-deploy/feature-user-nickname_20260320",
  "verdict": "passed",
  "summary": "预发部署完成，可以进入测试确认。",
  "findings": [],
  "evidence": [
    {
      "type": "workflow_state",
      "summary": "Jenkins 已基于 staging-deploy/feature-user-nickname_20260320 完成部署"
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
  "staging_base_branch": "staging",
  "staging_work_branch": "staging-deploy/feature-user-nickname_20260320",
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

   - 若执行层失败，`result` 也应尽量返回 JSON，至少包含 `summary`、`error`、已确认的分支字段
   - 若任务消息已提供上述分支参数，返回结果中必须原样沿用；不要替换成新的 `feature/...` 或 `staging-deploy/...`
