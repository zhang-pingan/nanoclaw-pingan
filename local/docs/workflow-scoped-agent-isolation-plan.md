# Workflow-Scoped Agent Isolation Plan

## 背景

当前同一个 agent group（例如 `web_dev`）由 `GroupQueue` 按 `groupJid` 串行调度。工作台的 workflow delegation 会被注入为目标 group 的 synthetic message，然后走普通 group message 处理路径。

这带来几个问题：

- 两个工作台任务都委派到 `web_dev` 时，会串行复用同一个 group session，后一个任务可能继承前一个任务的 Claude 对话上下文。
- 如果未来引入 per-workflow workspace，但仍复用同一个活跃容器，普通群聊或另一个 workflow 可能被 pipe 进错误容器，看到错误的 `/workspace/repos/{repo_path}` 挂载。
- 当前 IPC 目录按 group folder 共享，不能支持同一个 group 的多个容器并行运行。
- workflow delegation 的临时对话如果自动归档并提取 memory，可能污染 `web_dev` 的长期 group memory。

目标是让普通群聊和不同 workflow delegation 可以按 scope 并行运行，同时明确隔离 IPC、工作区、输入来源和记忆沉淀边界。

## 最终方案

采用 scope 级 agent run：

```text
scope = group-chat:web_dev
scope = workflow:{workflowId}:delegation:{delegationId}:target:web_dev
```

调度按 scope 并行，而不是按 `groupJid` 全局互斥。

核心策略：

- scope 并行：普通群聊、workflow A、workflow B 可以同时启动各自容器。
- scoped IPC：每个 scope 使用独立 IPC 目录，避免并行容器抢同一个 `/workspace/ipc/input`。
- workflow `isolatedSession=true`：workflow delegation 不读取、不写回 `sessions[group.folder]`。
- workflow 禁用归档/记忆：workflow delegation 默认不写 `groups/{folder}/conversations`，不触发 group memory extraction。
- 防 pipe 串台：只有同 scope 的后续输入才能 pipe 进 active container；scope 不匹配时启动/排队到对应 scope。
- per-workflow workspace：workflow delegation 挂载 workflow 专属 repo workspace，普通群聊继续挂 group/default workspace。

暂不做：

- `.claude` session 目录按 scope 隔离。

理由：workflow delegation 使用 `isolatedSession=true`，不 resume group session，也不 persist session。先避免 session 上下文污染；如果后续观察到 `.claude` 目录并发写、Claude memory、skills 同步等文件级竞争，再升级为 scope session directory。

## Scope 语义

### 普通群聊 scope

```text
scopeKey: group-chat:{groupFolder}
groupFolder: web_dev
chatJid: original group jid
sessionMode: group
workspaceMode: group/default
memoryArchiveMode: group
```

行为：

- 继续使用 `sessions[group.folder]`。
- 新 `newSessionId` 继续写回 group session 表。
- 可以使用 group memory pack。
- 可以归档到 `groups/{groupFolder}/conversations` 并触发 memory extraction。
- 使用普通 group/default repo workspace。

### Workflow delegation scope

```text
scopeKey: workflow:{workflowId}:delegation:{delegationId}:target:{groupFolder}
groupFolder: web_dev
chatJid: target group jid
sessionMode: isolated
workspaceMode: workflow
memoryArchiveMode: disabled
```

行为：

- 强制 `isolatedSession=true`。
- 不读取 `sessions[group.folder]`。
- 不把 `newSessionId` 写回 `sessions[group.folder]`。
- 不注入 group memory pack，或至少默认关闭 workflow delegation 的 group memory 注入。
- 不归档到 group conversations，不触发 archive memory extraction。
- 完成 delegation 后尽快关闭容器，不进入通用 idle 等待。
- 使用 `data/workflow-workspaces/{workflowId}/repos/{repo_path}`。

## 调度模型

现有 `GroupQueue` 的 active state 以 `groupJid` 为 key。新模型需要引入 `AgentScopeKey`：

```ts
type AgentScopeKind = 'group-chat' | 'workflow-delegation';

interface AgentScope {
  key: string;
  kind: AgentScopeKind;
  groupJid: string;
  groupFolder: string;
  workflowId?: string;
  delegationId?: string;
}
```

调度状态改为按 `scope.key` 维护 active/pending/process/containerName。

仍然保留 `groupJid` 和 `groupFolder`：

- UI 展示同一个 group 下有多个 active scopes。
- stop agent 可以按 scope 停，也可以按 group 批量停。
- workflow cancellation 可以定位并停止对应 workflow delegation scope。

并发限制仍由全局 `MAX_CONCURRENT_CONTAINERS` 控制。

## DB Migration

为让 Agent Status、Trace 历史和活跃 trace 都能稳定关联 scope，需要对 `agent_queries` 做显式 schema migration，而不是只在运行时从 workflow 字段临时推导。

`agent_queries` 增加字段：

```sql
ALTER TABLE agent_queries ADD COLUMN scope_key TEXT;
ALTER TABLE agent_queries ADD COLUMN scope_kind TEXT;
```

新增索引：

```sql
CREATE INDEX IF NOT EXISTS idx_agent_queries_scope_status
  ON agent_queries(scope_key, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_queries_scope_kind
  ON agent_queries(scope_kind, started_at DESC);
```

字段语义：

- `scope_key`：本次 agent run 的唯一运行域，例如 `group-chat:web_dev` 或 `workflow:wf-1:delegation:del-1:target:web_dev`。
- `scope_kind`：`group-chat` 或 `workflow-delegation`。

迁移兼容策略：

- 历史 `source_type='message'` 且 `group_folder` 非空的记录回填为 `group-chat:{group_folder}`。
- 历史 `source_type='workflow_delegation'` 且 `workflow_id`、`delegation_id`、`group_folder` 非空的记录回填为 `workflow:{workflow_id}:delegation:{delegation_id}:target:{group_folder}`。
- 其他历史记录可回填为 `legacy:{source_type}:{query_id}`，或保持 null。UI 对 null scope 使用 queryId 作为 fallback key。

`AgentQueryRecord`、`AgentQueryTraceManager.startQuery`、`createMessageQueryTrace`、scheduled task trace、workflow delegation trace 都需要传入并持久化 scope 字段。

## 防 Pipe 串台

任何 IPC pipe 前必须比较 incoming scope 与 active scope。

允许：

```text
group-chat:web_dev -> group-chat:web_dev
workflow:wf-a:delegation:del-a:target:web_dev -> same exact scope
```

禁止：

```text
group-chat:web_dev -> workflow:wf-a:delegation:del-a:target:web_dev
workflow:wf-b:delegation:del-b:target:web_dev -> workflow:wf-a:delegation:del-a:target:web_dev
workflow:wf-a:delegation:del-c:target:web_dev -> workflow:wf-a:delegation:del-a:target:web_dev
```

scope 不匹配时：

- 普通群聊消息进入 `group-chat:{groupFolder}` scope 队列。
- workflow delegation 进入自己的 workflow delegation scope 队列。
- 不向其他 scope 的 `/workspace/ipc/input` 写 message。

## Scoped IPC

当前 IPC host path：

```text
data/ipc/{group.folder}
```

新 IPC host path：

```text
data/ipc/scopes/{safeScopeKey}
```

容器内路径保持：

```text
/workspace/ipc
```

这样 agent runner 和 MCP 工具不需要知道宿主机 scope 路径。

需要调整：

- `resolveGroupIpcPath` 增加 scope 版本，或新增 `resolveAgentScopeIpcPath(scopeKey)`。
- `GroupQueue.sendMessage`、`closeStdin` 根据 scope 写入 scoped IPC。
- `buildVolumeMounts` 根据 `ContainerInput.scopeKey` 挂载 scoped IPC。
- Host 侧 IPC task/result 处理需要携带 `groupFolder` 与 `scopeKey`。对 group-scoped 能力仍可按 groupFolder 鉴权和写 DB。

## Session 策略

第一阶段不隔离 `.claude` session directory。

普通群聊：

```text
host: data/sessions/{groupFolder}/.claude
container: /home/node/.claude
isolatedSession: false
```

Workflow delegation：

```text
host: data/sessions/{groupFolder}/.claude
container: /home/node/.claude
isolatedSession: true
```

`isolatedSession=true` 必须保证：

- SDK options 不传 `resume`。
- SDK options 不传 `resumeSessionAt`。
- `persistSession=false`。
- Host 不写回 `sessions[group.folder]`。

风险：

- 并行容器仍共享同一个 `.claude` 目录中的 settings、skills、Claude memory 等文件。
- `persistSession=false` 降低 transcript/session 写入风险，但不能证明 `.claude` 完全无并发写。

后续升级触发条件：

- 发现 `.claude/projects/sessions-index.json` 并发写损坏。
- workflow isolated run 仍产生不可接受的 Claude memory 或 transcript 文件竞争。
- skills 同步与并行容器启动出现文件级冲突。

升级方向：

```text
data/sessions/scopes/{safeScopeKey}/.claude
```

但升级前必须同步处理 archive/memory scope，否则 workflow 归档可能污染 group memory。

## 工作台任务启动变化

当前工作台新建任务时提供“直接开始任务”和“初始化群组 session 后开始任务”两种模式。初始化模式会逐个调用 `/api/sessions/reset`，效果等价于对相关目标群组执行 `/new`，目的是让 workflow delegation 不继承目标 group 的旧 Claude session。

按本方案改造后，这个工作台专用初始化流程不再需要：

- workflow delegation 强制 `isolatedSession=true`，不会读取目标 group 的旧 session。
- workflow delegation 不会把新 session 写回目标 group session。
- workflow delegation 按自己的 workflow/delegation scope 运行，不再依赖 group chat session。
- 普通群聊与 workflow delegation 通过 scope 和 pipe 检查隔离。

因此工作台创建任务时应直接启动 workflow，不再重置相关目标群组 session。继续保留 `/api/sessions/reset` 和 `/new`，但只作为普通群聊 session 管理能力，而不是 workflow 启动前置步骤。

需要移除或废弃的工作台专用逻辑：

- 新建任务弹窗中的“直接开始任务 / 初始化群组 session 后开始任务”选择。
- 相关群组 session 初始化进度弹窗。
- 创建任务前调用 `/api/sessions/reset` 的工作台流程。
- 对应的 `workbench-session-*` 前端样式。

需要保留的能力：

- 普通群聊 `/new` slash command。
- 全局“重置 Session”按钮。
- 后端 `/api/sessions/reset`、`resetGroupSession`、`resetSessionsForScope` 等 group session 管理能力。

## 记忆与归档策略

普通群聊：

```text
memoryArchiveMode = group
archive path = /workspace/group/conversations
host path = groups/{groupFolder}/conversations
memory group_folder = groupFolder
```

Workflow delegation：

```text
memoryArchiveMode = disabled
```

行为：

- agent runner 退出时不调用 group conversation archive。
- 不写 `groups/{groupFolder}/conversations`。
- 不 enqueue `memory_extract_from_archive`。
- workflow 输出只通过 `complete_delegation`、handoff result、artifact contract、workflow events 和工作台 timeline 沉淀。

原因：

- workflow delegation 是临时执行上下文，不应自动成为 `web_dev` 长期记忆。
- 如果确实需要沉淀记忆，应由 workflow 主控在结束时基于最终结构化结果显式写入，而不是从中间 delegation transcript 自动提取。

## Per-Workflow Workspace

普通群聊继续使用 group/default workspace：

```text
host: REPOS_DIR/{repo_path}
or:   data/repo-workspaces/{groupFolder}/{repo_path}
container: /workspace/repos/{repo_path}
```

Workflow delegation 使用 workflow workspace：

```text
host: data/workflow-workspaces/{workflowId}/repos/{repo_path}
container: /workspace/repos/{repo_path}
```

初始化策略：

1. 根据 `groups/global/services.json` 解析 service、`repo_path`、`git_url`、`default_branch`。
2. workflow workspace 不存在时 clone。
3. 基于默认分支或 workflow 指定基线创建/checkout workflow 工作分支。
4. 同一个 workflow 的多个 delegation 可以共享同一个 workflow workspace。
5. 不同 workflow 即使 target 都是 `web_dev`，也使用不同 workspace。

容器内路径保持 `/workspace/repos/{repo_path}`，避免修改现有 skills。

清理策略：

- workflow completed/cancelled 后保留一段时间以便排查。
- 可提供手动归档、生成 patch、删除 workspace 的维护操作。
- 不在容器启动时自动 reset 已存在 workspace。

## Workflow Delegation 输入路径

为了真正支持 scope 并行，workflow delegation 不应继续依赖普通 group message cursor。

现有路径：

```text
workflow inject synthetic message
-> messages table
-> processGroupMessages()
-> getMessagesSince(lastAgentTimestamp[groupJid])
```

问题：

- `lastAgentTimestamp[groupJid]` 是 group 维度游标，不适合多个 workflow delegation 并行。
- 多条 delegation 或普通群聊消息可能被同一次 prompt 聚合。

目标路径：

```text
workflow creates delegation record
-> build delegation prompt directly
-> enqueue scope workflow:{workflowId}:delegation:{delegationId}:target:{groupFolder}
-> runAgent/runOneShotAgent with explicit prompt and executionContext
```

synthetic message 可以保留为审计记录或 UI timeline，但不作为 workflow delegation 的执行输入来源。

## ContainerInput 扩展建议

```ts
interface ContainerInput {
  scopeKey?: string;
  scopeKind?: 'group-chat' | 'workflow-delegation';
  memoryArchiveMode?: 'group' | 'disabled';
  workspaceMode?: 'group' | 'workflow';
  isolatedSession?: boolean;
  executionContext?: {
    workflowId?: string;
    stageKey?: string;
    delegationId?: string;
  };
}
```

语义：

- `scopeKey`：调度、IPC、status 的唯一运行域。
- `scopeKind`：决定能否 pipe、是否 idle 等待。
- `memoryArchiveMode`：决定 agent runner exit archive 行为。
- `workspaceMode`：决定 `/workspace/repos/*` 的宿主机挂载源。
- `isolatedSession`：workflow delegation 固定为 true。

后续可以用更明确的 `sessionMode` 替代 boolean：

```ts
sessionMode: 'group' | 'isolated' | 'workflow' | 'ephemeral'
```

第一阶段保留 `isolatedSession`，减少改动。

## 状态面板和停止语义

Agent Status 和 Trace 监控都必须以 scope 为关联维度，不能继续用 `groupJid` 聚合。否则同一个 `web_dev` 同时运行普通群聊和 workflow delegation 时，前端 trace 会互相覆盖。

`AgentStatusInfo` 扩展建议：

```ts
interface AgentStatusInfo {
  scopeKey: string;
  scopeKind: 'group-chat' | 'workflow-delegation';
  groupJid: string;
  groupName: string;
  groupFolder: string;
  workflowId?: string | null;
  delegationId?: string | null;
  activeQueryId?: string | null;
  activeRunId?: string | null;
  promptSummary: string;
  startedAt: number;
  isIdle: boolean;
  isTask: boolean;
}
```

`ActiveAgentQueryTrace` 扩展建议：

```ts
interface ActiveAgentQueryTrace {
  scopeKey: string | null;
  scopeKind: 'group-chat' | 'workflow-delegation' | null;
  queryId: string;
  runId: string | null;
  groupJid: string | null;
  groupFolder: string | null;
  workflowId: string | null;
  delegationId: string | null;
}
```

Agent status 应展示 scope：

```text
web_dev / group chat
web_dev / workflow wf-123 / delegation del-456
```

前端关联规则：

- `agentStatusData` 的 DOM key 使用 `scopeKey`，不要再使用 `groupJid`。
- active trace map 使用 `scopeKey` 或 `queryId`，不要使用 `groupJid`。
- 同一个 group 下多个 active scopes 要渲染为多条 status item。
- 历史 trace 列表继续按 `queryId` 查看详情；可增加 scope 标签用于筛选和辨识。

停止行为：

- 停止某个 scope：只关闭对应 scoped IPC `_close` 或对应 container。
- 停止某个 group：关闭该 group 下所有 active scopes。
- 取消 workflow：关闭该 workflow 下所有 active delegation scopes，并将 delegation/workflow 标记为取消或失败。

API 调整：

- `/api/agent-status` 返回包含 `scopeKey` 的多条 active agent。
- `/api/agent-status/stop` 优先接受 `scopeKey`；保留 `groupJid` 作为批量停止某 group 下所有 scopes 或兼容旧客户端。
- WebSocket `agent_status` payload 使用同一结构。
- WebSocket `agent_query_trace` payload 中每条 active query 带 `scopeKey` 和 `scopeKind`。

## 实现步骤

### 第 1 步：DB migration 和类型扩展

- 给 `agent_queries` 增加 `scope_key`、`scope_kind` 字段。
- 增加 `idx_agent_queries_scope_status`、`idx_agent_queries_scope_kind` 索引。
- 更新 `AgentQueryRecord`、`ActiveAgentQueryTrace`、`StartQueryInput` 类型。
- 所有 `startQuery` 调用点传入 scope 信息。
- 历史记录按兼容策略回填或提供 null fallback。

### 第 2 步：引入 scope key 和 scoped IPC

- 定义 `AgentScope` / `AgentScopeKey`。
- `GroupQueue` 或新 queue 从 group key 改为 scope key。
- IPC path 改为 `data/ipc/scopes/{safeScopeKey}`。
- `sendMessage`、`closeStdin`、`registerProcess` 都按 scope 操作。
- status 继续带 group 信息。

### 第 3 步：防 pipe 串台

- 普通消息 loop 只 pipe 到 `group-chat:{groupFolder}` active container。
- workflow delegation 只 pipe 到完全相同 workflow delegation scope。
- scope 不匹配时排队到自己的 scope。

### 第 4 步：workflow delegation 直接运行

- workflow delegation 不再依赖 `processGroupMessages` 聚合输入。
- 创建 delegation 后，直接 enqueue workflow delegation scope。
- prompt 使用当前 `buildWorkflowHandoffEnvelope` 和 task template 渲染结果。
- synthetic message 改为审计/UI 记录，不驱动执行。

### 第 5 步：workflow isolated session 和禁用归档

- workflow delegation 调 `runAgent` 时传 `isolatedSession=true`。
- `ContainerInput.memoryArchiveMode='disabled'`。
- agent runner `archiveOnExit` 根据 `memoryArchiveMode` 判断是否跳过。
- workflow delegation 完成后立即 `closeStdin(scopeKey)`。

### 第 6 步：per-workflow workspace

- 增加 `WORKFLOW_WORKSPACES_DIR`。
- 根据 `executionContext.workflowId` 和 `workspaceMode='workflow'` 准备 repo workspace。
- `buildVolumeMounts` 对 workflow delegation 挂 `data/workflow-workspaces/{workflowId}/repos/{repo_path}`。
- 普通群聊保持现有 repo mount 或后续 group workspace mount。

### 第 7 步：Agent Status 和 Trace UI scope 化

- Agent Status DOM key 从 `groupJid` 改为 `scopeKey`。
- active trace map 从 `groupJid` 改为 `scopeKey` 或 `queryId`。
- stop 按钮发送 `scopeKey`。
- 同 group 多 active scopes 渲染多条 status item。
- trace 历史和详情展示 scope 标签。

### 第 8 步：测试和观测

覆盖：

- 普通群聊和 workflow delegation 同 target group 并行，不共享 IPC。
- workflow A 与 workflow B 同 target group 并行，互不 pipe。
- workflow delegation 不读取、不写回 group session。
- workflow delegation 不产生 group archive memory extraction task。
- workflow A/B `/workspace/repos/{repo_path}` 对应不同宿主机目录。
- 停止单个 scope 不影响同 group 其他 active scopes。
- 同一个 group 同时有 group-chat 和 workflow-delegation active 时，Agent Status 展示两条记录。
- 两条 active trace 不按 groupJid 覆盖，能各自展示 currentAction、currentStep 和 recentEvents。

### 第 9 步：移除工作台 session 初始化前置流程

- 工作台新建任务直接创建 workflow，不再弹出“初始化群组 session 后开始任务”选项。
- 删除或隐藏相关群组 session 初始化进度 UI。
- 删除工作台创建任务前调用 `/api/sessions/reset` 的路径。
- 保留普通群聊 `/new` 和全局 session reset 能力。

## 风险和取舍

- 不隔离 `.claude` 目录是有意识的第一阶段取舍。它降低改造面，但保留少量文件级并发风险。
- per-workflow workspace 解决代码 working tree 污染，但会增加磁盘占用和 clone 成本。
- workflow delegation 直接运行会改变当前“委派就是群消息”的模型，需要补足 UI 审计和 trace，避免可观测性下降。
- 禁用 workflow memory extraction 会减少自动记忆沉淀，但这是为了避免把临时任务上下文写入长期 group memory。

## 成功标准

- 两个 workflow 同时委派到 `web_dev` 时，可以并行运行，并使用不同 IPC 和 workspace。
- 普通群聊在 workflow delegation 运行期间触发，不会进入 workflow 容器。
- workflow delegation 不污染 `sessions["web_dev"]`。
- workflow delegation 不向 `web_dev` group memory 自动写入 archive extraction 结果。
- 容器内 repo 路径保持 `/workspace/repos/{repo_path}`，现有 skills 不需要改路径。
