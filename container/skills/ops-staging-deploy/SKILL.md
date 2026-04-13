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
   - `工作分支` = 当前需求开发/修复所在业务分支，如果未提供，则需要和用户确认
   - `预发分支` = 预发基线分支；若消息未提供，则使用 `staging.branch`
   - `预发工作分支` = 用于部署预发的分支；如果消息未提供，并且`主分支`和`预发分支`不一致，则要基于`预发分支`新建分支，命名为 `staging-deploy/{工作分支名中将 / 替换为 -}`，如果`主分支`=`预发分支`，则`预发工作分支`=`工作分支`
4. 将`工作分支` merge到 `预发工作分支` 中并推送（注意：如果`主分支`和`预发分支`一样，那么`预发工作分支`=`工作分支`，此时不需要merge）：
   - 如果 `git merge` 出现冲突，必须自行分析并完成冲突解决，然后继续提交合并结果；不要因为冲突直接中止任务或返回失败，除非确认无法安全解决
5. 触发 Jenkins 部署：
   - 使用 `$JENKINS_URL`、`$JENKINS_USER`、`$JENKINS_PASSWORD` 环境变量
   - 先获取 CSRF crumb：`GET /crumbIssuer/api/json`
   - 触发参数化构建，并传入 `BRANCH={预发工作分支}`：`POST /job/{staging.jenkins_job}/buildWithParameters?BRANCH={预发工作分支}`
   - 轮询构建状态直到完成
6. 通过 `complete_delegation` 返回结果：
   - outcome：成功传 `success`，失败传 `failure`
   - result：JSON 格式
     成功：{"service":"xx","main_branch":"main","work_branch":"feature/xx","staging_base_branch":"staging","staging_work_branch":"staging-deploy/feature-xx","summary":"预发部署完成"}
     失败：{"service":"xx","main_branch":"main","work_branch":"feature/xx","staging_base_branch":"staging","staging_work_branch":"staging-deploy/feature-xx","summary":"预发部署失败","error":"conflict in src/xx.ts"}
