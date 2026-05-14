# Group-Isolated Service Repo Workspaces

## 背景

当前服务仓库通过 `groups/global/services.json` 的 `repo_path` 映射到宿主机仓库目录，并挂载到容器内：

```text
host: {REPOS_DIR}/{repo_path}
container: /workspace/repos/{repo_path}
```

这个模式下，多个 agent 如果同时访问同一个服务，会共享同一个 working tree、Git index、HEAD、未提交修改和构建产物。任意一个 agent 执行 `git checkout`、修改文件或生成构建产物，都会影响其他 agent。

目标是让不同 agent 对同一个服务仓库的修改和分支切换互相隔离，同时保持容器内路径不变，避免改动现有 skill 和 agent 记忆说明。

## 方案

不再保留或依赖 `REPOS_DIR/{repo_path}` 挂载。服务仓库统一放到 NanoClaw 项目数据目录下，按 group 隔离：

```text
host: data/repo-workspaces/{group.folder}/{repo_path}
container: /workspace/repos/{repo_path}
```

示例：

```text
host: data/repo-workspaces/dev/catstory
container: /workspace/repos/catstory
```

容器内路径继续是 `/workspace/repos/{repo_path}`，因此已有 skill、`CLAUDE.md` 和操作习惯无需调整。

## 挂载范围

是否为某个 group 准备和挂载服务仓库，继续由 `register_groups` 中的 `containerConfig.services` 决定。

规则：

- `containerConfig.services` 不存在或为空：不准备服务仓库。
- `containerConfig.services: ["catstory", "push-service"]`：只准备这些服务。
- `containerConfig.services: ["*"]`：准备 `groups/global/services.json` 中配置的全部服务。
- 服务名必须能在 `services.json` 中找到。
- 服务配置必须包含 `repo_path` 和 `git_url`，否则跳过并记录日志。

这样服务访问授权、容器挂载范围和仓库初始化范围保持同一套语义。

## 初始化策略

启动容器前检查每个目标 workspace：

```text
data/repo-workspaces/{group.folder}/{repo_path}
```

如果目录不存在：

1. 根据 `services.json` 中的 `git_url` 执行 clone。
2. clone 到 `data/repo-workspaces/{group.folder}/{repo_path}`。
3. checkout `default_branch`，如果未配置则使用仓库默认分支。
4. 初始化成功后挂载到 `/workspace/repos/{repo_path}`。

如果目录已存在：

- 不自动 `git pull`。
- 不自动 `git reset`。
- 不自动 `git checkout default_branch`。
- 直接复用当前 workspace 状态。

原因是 group 级 workspace 是该 agent 的长期工作区，里面可能包含未提交修改、临时分支、半成品修复或排查产物。容器启动时自动同步远端会破坏工作上下文。

## 隔离模型

隔离粒度为：

```text
group + service
```

同一个 group 内的 query 由现有队列和容器内 query loop 串行处理，因此复用同一个服务 workspace 是合理的：后续 query 可以继续看到前一次留下的修改、分支和上下文。

不同 group 即使操作同一个服务，也会使用不同目录：

```text
data/repo-workspaces/agent-a/catstory
data/repo-workspaces/agent-b/catstory
```

因此分支切换、未提交修改和构建产物互不影响。

## 不采用的方案

### 按 runId 隔离

```text
data/repo-workspaces/{runId}/{repo_path}
```

隔离性更强，但每次任务都会创建新仓库，无法自然继承同一个 agent 的上下文，磁盘增长也更快。当前需求中，同一容器或同一 group 内 query 串行，不需要 runId 级隔离。

### 直接挂载 `REPOS_DIR/{repo_path}`

这是当前问题来源。多个 agent 会共享同一个 Git working tree，不满足隔离目标。

### 使用 `git worktree`

`git worktree` 可以减少磁盘占用，但会引入额外限制：

- 同一分支默认不能被多个 worktree 同时 checkout。
- worktree 的 `.git` 文件和主仓库元数据路径需要处理宿主机路径与容器路径差异。
- agent 自由切分支时更容易触发 Git worktree 限制。

独立 clone 更直观，故障边界更清晰。

## 后续能力

可以在后续增加显式维护操作，而不是在容器启动时自动修改 workspace：

- 重置某个 group 的某个服务 workspace。
- 备份后重建 workspace。
- 手动拉取远端更新。
- 展示 workspace 当前分支、dirty 状态和最近提交。
- 将 workspace 的修改生成 patch 或推送到指定远端分支。

示例操作：

```text
reset service workspace: group=dev service=catstory
```

执行策略可以是先移动旧目录：

```text
data/repo-workspaces/dev/catstory
data/repo-workspaces-archive/dev/catstory-{timestamp}
```

然后下次容器启动时重新 clone。

## 实现位置建议

主要修改点：

- `src/config.ts`
  - 增加 `REPO_WORKSPACES_DIR = path.resolve(DATA_DIR, 'repo-workspaces')`。
  - 移除服务仓库挂载对 `REPOS_DIR` 的依赖。

- `src/container-runner.ts`
  - 在处理 `group.containerConfig?.services` 时读取 `services.json`。
  - 根据 group 和 service 解析目标 workspace。
  - 不存在时根据 `git_url` clone。
  - 将 workspace 挂载到 `/workspace/repos/{repo_path}`。

- 测试
  - 覆盖 `services: ["*"]`、指定服务列表、缺失 `git_url`、已存在 workspace、不存在 workspace 首次 clone 等场景。

## 关键原则

- 容器内路径保持稳定：`/workspace/repos/{repo_path}`。
- 隔离维度是 group + service。
- clone 只在 workspace 不存在时发生。
- 启动容器不自动改变已有 workspace 的 Git 状态。
- 服务挂载范围由 `containerConfig.services` 决定。
- 不再把共享的宿主机服务仓库作为 agent 可写工作区。
