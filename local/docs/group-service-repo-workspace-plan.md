# Workflow Delegation 服务仓库 Worktree 方案

## 背景

当前服务代码仓库由宿主机本地目录直接挂载进容器：

```text
host:      {REPOS_DIR}/{repo_path}
container: /workspace/repos/{repo_path}
```

`repo_path` 来自 `groups/global/services.json`，群组通过 `containerConfig.services` 声明需要哪些服务。这个模型对普通群聊是合理的：用户在群聊里让 agent 改代码，本质上就是直接操作本机已有仓库。

问题主要出现在 workflow delegation：

- 多个 workflow 可能同时使用同一个服务仓库。
- 某个 workflow 中 agent 留下的未提交代码，可能污染另一个 workflow。
- delegation 容器重启后，如果直接挂载共享仓库，很难判断 dirty code 属于当前 workflow 还是历史遗留。
- 如果为每个群组 clone 一份仓库，能提升隔离，但改动面和磁盘成本都更大。

因此第一版不改变普通群聊挂载逻辑，只为 workflow delegation 引入 per-workflow service worktree。

## 最终方向

```text
普通群聊：
host:      {REPOS_DIR}/{repo_path}
container: /workspace/repos/{repo_path}

workflow delegation：
base repo: {REPOS_DIR}/{repo_path}
worktree:  data/workflow-workspaces/{workflowId}/repos/{repo_path}
container: /workspace/repos/{repo_path}
```

关键点：

- 容器内路径保持 `/workspace/repos/{repo_path}` 不变。
- 普通群聊继续按当前逻辑直接挂载本地服务仓库。
- workflow delegation 在宿主机挂载前创建或复用 workflow 专属 worktree。
- 同一个 workflow 的后续 delegation 继续复用同一个 service worktree。
- `/workspace/projects` 继续只作为流程交付物目录，不承载服务源码。

## 目标

- 降低改动面：普通群聊和现有服务仓库挂载行为不变。
- 隔离 workflow 修改：不同 workflow 不共享同一份 dirty working tree。
- 保持容器内路径兼容：skills、workflow 文案继续使用 `/workspace/repos/{repo_path}`。
- 支持同一 workflow 内跨阶段延续：dev、dev-examine、test、refix 可以看到同一条 work branch 的代码状态。
- 避免容器启动后再创建 worktree：宿主机在 `docker run -v` 前完成工作区准备。

## 非目标

- 不为普通群聊创建 worktree。
- 不把服务源码挂到容器内 `/workspace/projects`。
- 不在每次容器启动时自动 `git pull`。
- 不为每个群组 clone 一份 services 仓库。
- 不在第一版自动清理 workflow worktree。
- 不解决普通群聊共享本地仓库带来的历史 dirty code 问题；普通群聊继续承担“直接操作本地 repo”的语义。

## 当前相关实现

主要代码位置：

- `src/container-runner.ts`
  - `buildVolumeMounts()` 当前负责构建容器挂载。
  - 当前根据 `group.containerConfig?.services` 读取 `groups/global/services.json`。
  - 当前服务仓库 host path 为 `path.join(REPOS_DIR, svc.repo_path)`。
  - 当前容器路径为 `/workspace/repos/{svc.repo_path}`。
- `src/types.ts`
  - `ContainerInput.executionContext` 已包含 `workflowId`、`stageKey`、`delegationId`。
  - `ContainerConfig.services?: string[]` 表示群组可用服务。
- `src/workflow.ts`
  - workflow 已有 service、context、main branch、work branch 等运行上下文。
- `groups/global/services.json`
  - 服务配置包含 `repo_path`、`git_url`、`default_branch` 等字段。
- `container/skills/*.md`
  - 多数技能已约定服务仓库在 `/workspace/repos/{repo_path}`。

## Worktree 原理

`git worktree` 允许一个 Git 仓库挂出多个独立工作目录：

```text
{REPOS_DIR}/catstory/                     # base repo，保存对象库和 refs
data/workflow-workspaces/wf-1/repos/catstory/
data/workflow-workspaces/wf-2/repos/catstory/
```

这些 worktree 共享 base repo 的 Git 对象库，但各自拥有独立的 checkout、index 和 HEAD。不同 workflow 可以在不同分支上并行修改同一个服务，不会共享同一份 working tree。

对容器来说，worktree 看起来就是一个普通 Git 工作目录。agent 不需要知道它来自 worktree。

## 目录设计

### Base Repo

普通群聊和 worktree 的 base repo 都使用现有本地仓库：

```text
{REPOS_DIR}/{repo_path}
```

第一版要求 base repo 已存在。如果不存在，workflow delegation 直接失败并提示用户配置或 clone 本地仓库。

### Workflow Worktree

建议放在 `data` 下，避免污染 `groups` 目录：

```text
data/workflow-workspaces/
  {workflowId}/
    repos/
      {repo_path}/
```

示例：

```text
data/workflow-workspaces/wf_20260522_001/repos/catstory
data/workflow-workspaces/wf_20260522_001/repos/custom/icarus
```

如果 `repo_path` 包含子目录，保留相对结构。实现时必须校验 `repo_path`，防止 `..`、绝对路径或空字符串逃逸出 workspace 根目录。

### 容器路径

保持不变：

```text
/workspace/repos/{repo_path}
```

流程交付物路径也保持不变：

```text
/workspace/projects/{service}/iteration/{deliverable}/...
```

## 创建时机

worktree 必须在宿主机挂载前准备，而不是容器启动后执行。

推荐链路：

```text
准备启动 workflow delegation 容器
  -> 宿主机读取 services.json，找到 repo_path
  -> 宿主机确认 base repo: {REPOS_DIR}/{repo_path}
  -> 宿主机确认/创建 workflow service worktree
  -> 宿主机将 worktree host path 挂载到 /workspace/repos/{repo_path}
  -> 启动容器
  -> agent 在 /workspace/repos/{repo_path} 内正常开发
```

原因：

- Docker bind mount 的 host path 必须在 `docker run` 前确定。
- 容器内创建 worktree 会要求额外暴露 base repo `.git`，边界更复杂。
- 宿主机更适合做路径校验、分支命名、并发锁和错误处理。
- 容器只需要看到一个普通 Git 工作目录。

## 挂载策略

### 普通群聊

如果没有 `executionContext.workflowId`：

```text
hostPath:      {REPOS_DIR}/{repo_path}
containerPath: /workspace/repos/{repo_path}
readonly:      false
```

这就是当前行为。

### Workflow Delegation

如果存在 `executionContext.workflowId`：

```text
hostPath:      ensureWorkflowServiceWorktree(...)
containerPath: /workspace/repos/{repo_path}
readonly:      false
```

同一个 workflow、同一个 service、同一个 `repo_path` 复用同一个 worktree。

## 分支策略

workflow delegation 应该尽量使用 workflow context 中已有工作分支。

建议优先级：

1. 如果 workflow context 已有 `work_branch`，使用它。
2. 如果当前任务显式传入工作分支，使用它，并写回 workflow context。
3. 如果没有工作分支，基于 `main_branch` 或服务 `default_branch` 创建 workflow 专属分支。

自动创建分支命名建议：

```text
feature/icarus-{workflowId}-{service}
```

如果分支名需要更可读，可以加入 deliverable：

```text
feature/{service}-{deliverable}-{shortWorkflowId}
```

要求：

- 分支名必须经过 Git ref 安全校验。
- 同一个 workflow/service 必须复用同一个分支和 worktree。
- 不同 workflow 不应默认复用同一工作分支。

## Worktree 准备策略

伪流程：

```text
ensureWorkflowServiceWorktree(workflowId, service, repoPath, branch, baseBranch)
  baseRepo = {REPOS_DIR}/{repoPath}
  target = data/workflow-workspaces/{workflowId}/repos/{repoPath}

  validate repoPath
  assert baseRepo exists and is a git repo

  if target exists:
    assert target is a git worktree or git repo
    return target

  acquire lock for baseRepo + branch + target

  if branch exists:
    git -C baseRepo worktree add target branch
  else:
    git -C baseRepo worktree add -b branch target baseBranch

  return target
```

第一版建议不自动 `fetch`，避免启动 delegation 时隐式改变本地仓库状态。如果 base branch 或 work branch 不存在，返回明确错误。后续可以加显式同步动作。

## Dirty Code 处理

### 普通群聊

保持当前语义：普通群聊直接使用本地共享仓库。如果仓库 dirty，agent 应视为当前本地仓库真实状态。

为了降低误判，后续可以在 agent prompt 中注入 dirty 摘要，但这不是本方案第一阶段必须项。

### Workflow Delegation

workflow worktree dirty 是可接受的，因为它天然属于该 workflow。

处理规则：

- 同一 workflow 后续 delegation 复用 worktree，允许看到未提交修改。
- 不同 workflow 使用不同 worktree，不会看到彼此 dirty code。
- workflow 完成后不自动删除 worktree，避免误删未提交成果。
- 清理或归档 worktree 作为后续显式动作实现。

## 显式同步动作

第一版不在容器启动时自动 fetch/pull。

后续可以提供显式动作：

- 同步 base repo：对 `{REPOS_DIR}/{repo_path}` 执行 `git fetch --all --prune`。
- 更新 workflow worktree：在用户确认后 checkout/pull/rebase 指定分支。
- 清理 workflow worktree：列出已完成 workflow 的 worktree，由用户选择删除。

同步动作必须先检查 dirty 状态：

```text
git status --porcelain
```

dirty 时不自动 reset、clean、stash。需要用户明确选择。

## 安全边界

需要新增或复用路径校验：

- `repo_path` 必须是相对路径。
- `repo_path` 不能包含空 path segment、`.`、`..`。
- 解析后的 base repo 必须位于 `REPOS_DIR` 内。
- 解析后的 worktree path 必须位于 `data/workflow-workspaces/{workflowId}/repos` 内。
- `workflowId` 用于路径时必须做安全编码或只使用系统生成的安全 ID。
- worktree 目标路径已存在但不是 Git 工作目录时，应失败，不应覆盖。

并发控制：

- 同一个 base repo、同一个 branch 创建 worktree 时需要加宿主机锁。
- 同一个 workflow/service 重复启动时应复用已有 target。
- 同一个 branch 不能同时 checkout 到多个 worktree；因此 workflow 分支应唯一。

## 实施步骤

### 1. 抽取服务仓库路径解析

新增 helper，例如：

```text
validateServiceRepoPath(repoPath)
resolveBaseServiceRepoPath(repoPath)
resolveWorkflowServiceWorktreePath(workflowId, repoPath)
```

建议放在独立模块，避免 `container-runner.ts` 继续膨胀。

### 2. 抽取 worktree 管理模块

建议新增：

```text
src/service-worktree.ts
src/service-worktree.test.ts
```

职责：

- 校验 base repo。
- 判断 target 是否已存在。
- 创建 worktree。
- 返回 hostPath。
- 记录日志和错误原因。

### 3. 调整 container mount 选择

`buildVolumeMounts()` 当前只有 `group` 和 `isMain` 参数。为了根据 workflow delegation 切换挂载来源，需要让 mount 构建逻辑拿到 execution context。

可选方案：

- 扩展 `buildVolumeMounts(group, isMain, input)`。
- 或在调用 `buildVolumeMounts()` 前先计算 service repo mount plan。

第一版建议直接扩展参数，保持改动集中。

### 4. 传入 workflow 分支上下文

worktree 创建需要知道：

- `workflowId`
- `service`
- `repo_path`
- `work_branch`
- `main_branch` 或 `default_branch`

如果当前 `ContainerInput.executionContext` 不够，需要在 workflow delegation 启动容器时补充必要字段，或在宿主机通过 `workflowId` 查询 workflow record。

### 5. 创建/复用 worktree 并挂载

普通群聊：

```text
{REPOS_DIR}/{repo_path} -> /workspace/repos/{repo_path}
```

workflow delegation：

```text
data/workflow-workspaces/{workflowId}/repos/{repo_path}
  -> /workspace/repos/{repo_path}
```

### 6. 补充日志

记录：

- group folder
- workflowId/delegationId
- service name
- repo_path
- base repo path
- worktree path
- branch/baseBranch
- worktree created/reused

## 测试建议

### 单元测试

- `repo_path` 校验：
  - 允许 `catstory`
  - 允许 `custom/icarus`
  - 拒绝 `../catstory`
  - 拒绝 `/tmp/catstory`
  - 拒绝空字符串
- 普通群聊 mount 仍使用 `REPOS_DIR/{repo_path}`。
- workflow delegation mount 使用 worktree path。
- 同一 workflow/service 重复调用返回同一 target。
- 不同 workflow 返回不同 target。
- target 路径不能逃逸 workspace 根目录。

### Git 行为测试

使用临时本地 Git repo：

- branch 已存在：`git worktree add target branch`。
- branch 不存在：`git worktree add -b branch target baseBranch`。
- target 已存在：复用。
- base repo 不存在：失败。
- base repo 不是 Git repo：失败。
- 同一 branch 已被其他 worktree checkout：返回明确错误。

### 回归测试

重点覆盖：

- `src/container-runner.test.ts`
- workflow delegation 容器启动路径
- workflow 产物路径 `/workspace/projects/...`
- skills 文案无需改动，因为 `/workspace/repos/{repo_path}` 不变

## 迁移策略

无需迁移普通群聊仓库。

上线后：

- 普通群聊继续使用 `{REPOS_DIR}/{repo_path}`。
- 新 workflow delegation 首次执行时创建 worktree。
- 已存在 workflow 如果还没有 worktree，可以按其 `work_branch` 创建。
- 已完成 workflow 的 worktree 默认保留，后续通过显式清理动作处理。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| 同一分支不能被多个 worktree 同时 checkout | workflow 分支唯一；同一 workflow/service 复用同一 worktree |
| base repo 不存在 | 明确失败，提示用户先准备本地仓库 |
| workflow worktree 长期堆积 | 后续增加显式清理列表和 TTL 建议 |
| workflow worktree dirty | 允许，dirty 属于该 workflow；完成后不自动删除 |
| 普通群聊历史 dirty code | 保持当前语义；如需要后续再加 dirty 摘要提示 |
| 容器内路径变化影响 skills | 容器内仍是 `/workspace/repos/{repo_path}`，不影响 |
| 自动 fetch/pull 改变工作区 | 第一版不自动 fetch/pull，后续做显式同步 |

## 推荐落地顺序

1. 新增 repo path 校验和路径解析 helper。
2. 新增 service worktree 管理模块。
3. 让容器 mount 构建逻辑能识别 workflow delegation。
4. workflow delegation 挂载 worktree，普通群聊保留当前挂载。
5. 补充 container runner 和 worktree 单元测试。
6. 后续增加显式同步、清理和 dirty 摘要提示。

## 最终判断

该方案比“按群组 clone services 到 groups/projects”更适合作为第一版：

- 普通群聊行为不变，风险低。
- workflow delegation 获得独立工作区，能解决主要污染问题。
- 容器内路径不变，现有 skills 和流程文案基本不需要改。
- 不需要维护复杂 ownership 元数据。
- 后续仍可扩展为 workflow-scoped 容器、显式同步和 worktree 清理能力。
