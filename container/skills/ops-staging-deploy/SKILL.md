---
name: ops-staging-deploy
description: Deploy service branches to staging environment — merge code, trigger Jenkins builds, verify deployment, and inspect logs.
---

# 预发部署 Skill

## 预发部署流程

当收到预发部署任务时：

1. 读取 `/workspace/global/services.json`，获取对应服务的 `staging.branch` 和 `staging.jenkins_job`
2. 从消息中读取以下字段并严格区分：
   - `工作分支` = 当前需求开发/修复所在业务分支
   - `预发分支` = 预发基线分支；若消息未提供，则使用 `staging.branch`
   - `预发工作分支` = 用于部署预发的分支；若消息未提供，则基于 `预发分支` 和 `工作分支` 创建
3. 如果消息中已明确提供 `预发工作分支`，则跳过创建流程，直接使用该分支执行 Jenkins 部署
4. 如果消息中未提供 `预发工作分支`，继续执行下面的 Git 流程，基于工作分支创建并推送预发工作分支
5. 进入服务仓库目录 `/workspace/repos/{服务名}/`
6. 基于 `预发分支` 创建预发工作分支，命名为 `staging-deploy/{工作分支名中将 / 替换为 -}`
7. 执行合并：
   - `git fetch origin`
   - `git checkout {预发分支}`
   - `git pull origin {预发分支}`
   - `git checkout -B {预发工作分支}`
   - `git merge origin/{工作分支}`
   - 如果 `git merge` 出现冲突，必须自行分析并完成冲突解决，然后继续提交合并结果；不要因为冲突直接中止任务或返回失败，除非确认无法安全解决
   - `git push -f origin {预发工作分支}`
8. 触发 Jenkins 部署：
   - 使用 `$JENKINS_URL`、`$JENKINS_USER`、`$JENKINS_PASSWORD` 环境变量
   - 先获取 CSRF crumb：`GET /crumbIssuer/api/json`
   - 触发参数化构建，并传入 `BRANCH={预发工作分支}`：`POST /job/{staging.jenkins_job}/buildWithParameters?BRANCH={预发工作分支}`
   - 轮询构建状态直到完成
9. 通过 `complete_delegation` 返回结果：
   - outcome：成功传 `success`，失败传 `failure`
   - result：JSON 格式
     成功：{"service":"xx","work_branch":"feature/xx","staging_base_branch":"staging","staging_work_branch":"staging-deploy/feature-xx","summary":"预发部署完成"}
     失败：{"service":"xx","work_branch":"feature/xx","staging_base_branch":"staging","staging_work_branch":"staging-deploy/feature-xx","summary":"预发部署失败","error":"conflict in src/xx.ts"}
