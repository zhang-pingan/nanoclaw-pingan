---
name: ops-staging-deploy
description: Deploy service branches to staging environment — merge code, trigger Jenkins builds, verify deployment, and inspect logs.
---

# 预发部署 Skill

## 预发部署流程

当收到预发部署任务时（包含服务名和工作分支名）：

1. 读取 `/workspace/global/services.json`，获取对应服务的 `staging.branch` 和 `staging.jenkins_job`
2. 进入服务仓库目录 `/workspace/repos/{服务名}/`
3. 基于 `staging.branch` 创建预发工作分支，命名为 `staging-deploy/{工作分支名中将 / 替换为 -}`
4. 执行合并：
   - `git fetch origin`
   - `git checkout {staging.branch}`
   - `git pull origin {staging.branch}`
   - `git checkout -B {预发工作分支}`
   - `git merge origin/{工作分支}`
   - `git push -f origin {预发工作分支}`
5. 触发 Jenkins 部署：
   - 使用 `$JENKINS_URL`、`$JENKINS_USER`、`$JENKINS_PASSWORD` 环境变量
   - 先获取 CSRF crumb：`GET /crumbIssuer/api/json`
   - 触发参数化构建，并传入 `BRANCH={预发工作分支}`：`POST /job/{staging.jenkins_job}/buildWithParameters?BRANCH={预发工作分支}`
   - 轮询构建状态直到完成
6. 通过 `complete_delegation` 返回结果：
   - outcome：成功传 `success`，失败传 `failure`
   - result：JSON 格式
     成功：{"service":"xx","branch":"feature/xx","staging_branch":"staging","deploy_branch":"staging-deploy/feature-xx","summary":"预发部署完成"}
     失败：{"service":"xx","branch":"feature/xx","staging_branch":"staging","deploy_branch":"staging-deploy/feature-xx","summary":"预发部署失败","error":"conflict in src/xx.ts"}
