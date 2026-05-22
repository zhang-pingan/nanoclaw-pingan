# 群组服务仓库工作区方案

## 背景

当前服务代码仓库由宿主机本地目录直接挂载进容器：

```text
host:      {REPOS_DIR}/{repo_path}
container: /workspace/repos/{repo_path}
```

`repo_path` 来自 `groups/global/services.json`，群组通过 `containerConfig.services` 声明需要哪些服务。这个模型能复用本机已有仓库，但会让多个群组共享同一份工作区，隔离边界不够清晰。

目标是改为根据群组配置的 services，为每个群组准备独立服务仓库副本：

```text
host:      groups/{group}/projects/{repo_path}
container: /workspace/repos/{repo_path}
```

容器内路径保持不变，避免影响现有 workflow、skills 和任务文案。

## 目标

- 群组只看到自己 `containerConfig.services` 声明的服务仓库。
- 服务仓库宿主机位置改为群组私有目录 `groups/{group}/projects`。
- 容器内服务仓库路径继续保持 `/workspace/repos/{repo_path}`。
- 保留 `/workspace/projects` 作为流程交付物、方案、测试文档和知识库文档目录。
- 首次使用时自动 clone 缺失仓库；已存在仓库不自动 pull。
- 后续通过显式“同步服务仓库”动作更新已有仓库，避免容器启动时隐式改变工作区。

## 非目标

- 不把服务源码挂到容器内 `/workspace/projects`。
- 不在每次容器启动时自动 `git pull`。
- 不用本地 `REPOS_DIR` 作为自动回退来源。
- 不在第一版引入 bare mirror、共享缓存或跨群组仓库复用。
- 不改变现有交付物路径 `/workspace/projects/{service}/iteration/...`。

## 当前相关实现

主要代码位置：

- `src/container-runner.ts`
  - `buildVolumeMounts()` 负责构建容器挂载。
  - 当前根据 `group.containerConfig?.services` 读取 `groups/global/services.json`。
  - 当前服务仓库 host path 为 `path.join(REPOS_DIR, svc.repo_path)`。
  - 当前容器路径为 `/workspace/repos/{svc.repo_path}`。
- `src/types.ts`
  - `ContainerConfig.services?: string[]` 表示群组可用服务。
- `groups/global/services.json`
  - 服务配置包含 `repo_path`、`git_url`、`default_branch` 等字段。
- `container/skills/*.md`
  - 多数技能已约定服务仓库在 `/workspace/repos/{repo_path}`。
- `src/workflow.ts`、`src/channels/web.ts`
  - 流程交付物仍大量使用 `PROJECT_ROOT/projects` 和 `/workspace/projects`。

## 目录设计

### 宿主机目录

每个群组拥有自己的服务仓库目录：

```text
groups/
  web_dev/
    projects/
      catstory/
      user-platform/
  web_test/
    projects/
      catstory/
  feishu_ops/
    projects/
      push-service/
```

`repo_path` 可以包含子目录，例如：

```text
repo_path: custom/icarus
host: groups/{group}/projects/custom/icarus
container: /workspace/repos/custom/icarus
```

实现时必须校验 `repo_path`，防止 `..`、绝对路径或空字符串逃逸出群组 projects 目录。

### 容器目录

服务源码路径保持：

```text
/workspace/repos/{repo_path}
```

流程交付物路径保持：

```text
/workspace/projects/{service}/iteration/{deliverable}/...
```

两者语义不同：

- `/workspace/repos`：真实代码仓库，用于读代码、改代码、测试、commit、push。
- `/workspace/projects`：流程产物目录，用于方案、开发文档、测试文档、知识库文档。

## 仓库准备策略

容器启动前，宿主机根据群组服务配置准备仓库。

### 输入

- `group.folder`
- `group.containerConfig.services`
- `groups/global/services.json`

### 服务展开

- `services: ["catstory", "user-platform"]`：只准备指定服务。
- `services: ["*"]`：准备 `services.json` 中所有服务。
- 未配置 services 或空数组：不准备服务仓库。

### 自动 clone

当目标目录不存在时：

```text
groups/{group}/projects/{repo_path}
```

宿主机执行：

```text
git clone {git_url} {targetPath}
```

如果 `default_branch` 存在，第一版可以选择：

- clone 后保持远端默认分支；或
- clone 后 checkout `default_branch`。

建议第一版保持远端默认分支，减少额外失败点。后续同步动作中再显式支持 checkout 默认分支。

### 已存在仓库

如果目标目录已存在：

- 不自动 pull。
- 不自动 fetch。
- 不自动 checkout。
- 只校验目录存在并挂载到容器。

原因是容器启动不应隐式改变 agent 上次留下的工作区状态。

### 配置缺失

如果服务配置缺少 `repo_path`：

- 跳过该服务。
- 记录 warn 日志。

如果服务配置缺少 `git_url` 且目标目录不存在：

- 不回退到 `REPOS_DIR`。
- 返回明确错误或记录失败状态：服务无法自动准备仓库。

如果目标目录已存在，即使缺少 `git_url`，仍可挂载。

## 显式同步服务仓库动作

显式同步是后续能力，不属于容器启动隐式行为。

可支持三类入口：

- Web 配置页按钮：同步某个群组的某个服务。
- Web 配置页按钮：同步某个群组的全部服务。
- 主控群命令：同步服务仓库 `catstory` 或同步当前群组全部服务。

同步动作建议流程：

```text
1. 找到 group 和 services。
2. 确认目标仓库存在；不存在则执行 clone。
3. 执行 git status --porcelain。
4. 如果工作区不干净，停止并提示用户提交、stash 或放弃改动。
5. 如果工作区干净，执行 git fetch --all --prune。
6. 根据策略更新当前分支或 default_branch。
7. 返回同步结果、当前分支、HEAD commit 和失败原因。
```

第一版同步策略建议保守：

- 已存在仓库且工作区干净：`git fetch --all --prune`。
- 不自动 merge 或 rebase。
- 如果用户明确选择“更新到远端默认分支”，再执行 checkout/pull。

这样能先提供“拉取远端引用”的能力，同时避免自动改变当前工作分支。

## 挂载策略

`buildVolumeMounts()` 中服务仓库挂载逻辑调整为：

```text
source: groups/{group}/projects/{repo_path}
target: /workspace/repos/{repo_path}
mode:   read-write
```

主群组如果配置 services，也使用同样规则。

`/workspace/projects` 的现有挂载保持不变，继续指向宿主机共享 `projects` 目录，用于流程交付物。

## 安全边界

需要新增或复用路径校验：

- `group.folder` 继续使用已有 `isValidGroupFolder` 约束。
- `repo_path` 必须是相对路径。
- `repo_path` 不能包含空 path segment、`.`、`..`。
- 解析后的目标路径必须位于 `groups/{group}/projects` 内。
- clone 目标目录如果存在但不是 git 仓库，应该报错，不应覆盖。
- clone 失败时不能创建半初始化状态；如果产生空目录，需谨慎清理或标记失败。

SSH key 仍沿用当前容器挂载策略：

- 宿主机 clone 需要使用宿主机 git/ssh 环境。
- 容器内 commit/push 继续依赖当前合成 `.ssh` 挂载。

## 实施步骤

### 1. 抽取服务仓库路径解析

新增 helper，例如：

```text
resolveGroupServiceProjectsDir(groupFolder)
resolveGroupServiceRepoHostPath(groupFolder, repoPath)
validateServiceRepoPath(repoPath)
```

建议放在独立模块，避免 `container-runner.ts` 继续膨胀。

### 2. 抽取服务配置读取

把读取 `groups/global/services.json` 的逻辑收敛为公共函数：

```text
readServiceConfigRegistry()
resolveGroupServiceNames(groupServices, allServices)
```

注意 `src/channels/web.ts` 里已有私有实现，后续可以逐步复用，但第一版不要扩大重构范围。

### 3. 实现 ensure clone

在容器挂载前执行：

```text
ensureGroupServiceRepo(group, serviceName, serviceConfig)
```

行为：

- 目标目录不存在：需要 `git_url`，执行 clone。
- 目标目录存在且是目录：直接返回。
- 目标目录存在但不是目录：失败。
- 目标目录存在但不是 git 仓库：失败或 warn 后仍挂载，由产品策略决定。

建议第一版对“存在但不是 git 仓库”直接失败，因为这通常是配置或历史数据问题。

### 4. 调整挂载

把当前：

```text
REPOS_DIR/{repo_path} -> /workspace/repos/{repo_path}
```

改为：

```text
groups/{group}/projects/{repo_path} -> /workspace/repos/{repo_path}
```

移除服务仓库挂载对 `REPOS_DIR` 的依赖。

### 5. 增加日志和错误可见性

记录：

- group folder
- service name
- repo_path
- git_url 是否存在
- clone 目标路径
- clone 成功/失败
- 挂载数量

失败时错误信息应能被用户理解，例如：

```text
服务 catstory 缺少 git_url，无法为群组 web_dev 自动 clone 仓库。
```

### 6. 后续增加同步动作

同步动作可以作为第二阶段实现，先不阻塞仓库工作区切换。

建议后续模块：

```text
src/service-repos.ts
src/service-repos.test.ts
```

再由 Web API 或主控群命令调用。

## 测试建议

### 单元测试

- `repo_path` 校验：
  - 允许 `catstory`
  - 允许 `team/catstory`
  - 拒绝 `../catstory`
  - 拒绝 `/tmp/catstory`
  - 拒绝空字符串
- services 展开：
  - 指定服务
  - wildcard `*`
  - 未知服务跳过或报错策略
- host path 解析必须落在 `groups/{group}/projects` 内。

### 集成测试

- 目标仓库不存在且有 `git_url`：执行 clone 并挂载。
- 目标仓库已存在：不执行 pull/fetch。
- 缺少 `git_url` 且目标不存在：返回明确错误。
- 两个群组配置同一服务：生成两个不同 host path，容器内路径相同。
- `/workspace/projects` 仍保持原流程交付物路径。

### 回归测试

重点覆盖：

- `src/container-runner.test.ts`
- workflow 产物路径相关测试
- today plan 读取 repo 信息相关测试
- skills 文案无需改动，因为 `/workspace/repos/{repo_path}` 不变

## 迁移策略

已有本地仓库不会自动迁移到 `groups/{group}/projects`。

第一版推荐：

- 新逻辑上线后，群组首次使用服务时自动 clone 新副本。
- 用户如需复用旧仓库的未提交改动，可手动复制或提交后再同步。
- 文档中明确旧 `REPOS_DIR` 不再作为服务仓库挂载来源。

如果需要平滑迁移，可以提供一次性脚本：

```text
copy or clone from REPOS_DIR/{repo_path}
to groups/{group}/projects/{repo_path}
```

但默认不建议自动复制，因为旧仓库可能包含未提交改动、私有文件或非预期分支。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| 多群组重复 clone 占磁盘 | 第一版接受；后续可引入本地 mirror/cache |
| clone 依赖 SSH 权限 | 错误直接暴露给用户；不回退到共享本地仓库 |
| 容器启动变慢 | 只在仓库缺失时 clone；已存在不更新 |
| 工作区状态被隐式改变 | 容器启动不 pull；同步必须显式触发 |
| `/workspace/projects` 与源码目录混淆 | 源码继续使用 `/workspace/repos`，交付物继续使用 `/workspace/projects` |
| `repo_path` 路径穿越 | 严格校验相对路径并确认 resolved path 位于群组 projects 内 |

## 推荐落地顺序

1. 新增路径解析和 repo_path 校验。
2. 新增 service repo ensure clone 逻辑。
3. 调整容器服务仓库挂载来源。
4. 补充 container runner 相关测试。
5. 更新 README 或 setup 文档中的服务仓库说明。
6. 第二阶段增加显式同步服务仓库动作。

## 最终判断

该方案可行，且比直接挂载本地 `REPOS_DIR` 更符合群组隔离模型。

关键约束是：

- 宿主机服务仓库变成 `groups/{group}/projects/{repo_path}`。
- 容器内服务仓库仍是 `/workspace/repos/{repo_path}`。
- `/workspace/projects` 继续只承担流程交付物职责。
- 自动 clone 只处理缺失仓库，不自动 pull。
- 同步已有仓库必须是显式、可见、可审计的动作。
