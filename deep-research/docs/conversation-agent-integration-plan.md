# Deep Research Conversation Agent Integration Plan

## 背景

当前 `deep-research` 以 `tasks.json` 作为核心状态存储，页面语义接近“一个对话框只有一个 research task”。这会限制后续围绕同一主题连续产出多个调研报告、对报告进行追问、让 agent 辅助优化下一轮调研提示词等工作流。

目标是把 Deep Research 改造成“研究对话”形态：

- 一个 conversation/session 对应一个页面对话框。
- 一个 conversation 内可以包含多个 research task，也就是多个调研报告。
- 同一个 conversation 内可以通过 `@agent` 和 Icarus 提供的行业分析师 agent 对话。
- conversation 与 Icarus agent session 一对一绑定，后续 `@agent` 调用继续同一个 agent session。
- agent 不直接接收全部 task 内容，而是通过只读挂载目录按需读取报告，实现渐进式加载。

## 目标

1. 支持一个 Deep Research conversation 内管理多个 task。
2. 支持用户在同一个输入框中通过 `@agent` 路由到 Icarus agent。
3. 支持 conversation 与 Icarus agent session 一对一绑定。
4. 支持 report task 的“引用”交互，用户可在调用 agent 时显式引用一个或多个 task。
5. 避免把所有报告内容直接塞进 LLM 上下文，改为通过容器只读挂载和文件索引按需读取。
6. 旧 `tasks.json` 数据不做迁移；切换到 v2 后发现旧结构即重置为空 store。

## 非目标

- 第一阶段不做报告章节级引用，只做 task 级引用。
- 第一阶段不改 Deep Research 报告生成 provider 的核心逻辑。
- 第一阶段不让 agent 修改 Deep Research 原始运行数据。
- 第一阶段不直接把整个 `deep-research` 项目目录挂载给 agent。

## 数据模型

建议把状态从单一 `tasks` 演进为：

- `conversations`: 研究对话列表。
- `tasks`: 调研报告任务，归属于某个 conversation。
- `messages`: conversation 内的消息流，包括用户输入、agent 回复、task 创建事件、task 完成事件等。

示例结构：

```json
{
  "version": 2,
  "updated_at": "2026-06-29T00:00:00.000Z",
  "conversations": [
    {
      "id": "drs_xxx",
      "title": "AI 教育产品行业分析",
      "created_at": "2026-06-29T00:00:00.000Z",
      "updated_at": "2026-06-29T00:00:00.000Z",
      "agent_session_id": "optional-icarus-agent-session-id",
      "task_ids": ["dr_task_1", "dr_task_2"],
      "message_ids": ["msg_1", "msg_2"]
    }
  ],
  "tasks": [
    {
      "id": "dr_task_1",
      "conversation_id": "drs_xxx",
      "provider": "openai",
      "model": "o3-deep-research",
      "prompt": "...",
      "title": "...",
      "status": "completed",
      "created_at": "2026-06-29T00:00:00.000Z",
      "updated_at": "2026-06-29T00:00:00.000Z"
    }
  ],
  "messages": [
    {
      "id": "msg_1",
      "conversation_id": "drs_xxx",
      "role": "user",
      "kind": "research_prompt",
      "content": "...",
      "task_id": "dr_task_1",
      "created_at": "2026-06-29T00:00:00.000Z"
    },
    {
      "id": "msg_2",
      "conversation_id": "drs_xxx",
      "role": "assistant",
      "kind": "agent_reply",
      "content": "...",
      "referenced_task_ids": ["dr_task_1"],
      "created_at": "2026-06-29T00:00:00.000Z"
    }
  ]
}
```

## 输入路由

页面仍保留一个输入框。

- 普通输入：创建新的 research task，挂到当前 conversation。
- 以 `@agent` 开头：不创建 research task，转发给 Icarus 行业分析师 agent。

示例：

```text
分析中国 AI 教育硬件市场的主要玩家
```

创建一个 Deep Research task。

```text
@agent 看一下我刚引用的两个报告，它们的结论有没有冲突？帮我优化下一轮调研提示词。
```

调用 Icarus agent，并把引用 task id 作为本轮 runtime context 传入。

## Agent Session 设计

Icarus 当前已有对外调用 agent 的 run-once 类接口，但该接口没有 session 能力，且现有实现偏向一次性隔离执行：

- `isolatedSession: true`
- 不传 `sessionId`
- 每次调用都是新的 session

Deep Research 场景需要新增 session-capable agent chat API，避免改变 run-once 的既有语义。

建议新增：

```http
POST /internal/agent/chat
```

请求：

```json
{
  "chat_jid": "web:deep-research-analyst",
  "session_id": "optional-existing-agent-session-id",
  "message": "用户 @agent 后面的内容",
  "deep_research": {
    "conversation_id": "drs_xxx",
    "mounted_root": "/workspace/extra/deep-research",
    "referenced_task_ids": ["dr_task_1", "dr_task_2"]
  },
  "metadata": {
    "source": "deep-research"
  }
}
```

响应：

```json
{
  "ok": true,
  "text": "agent 回复内容",
  "session_id": "icarus-agent-session-id",
  "run_id": "...",
  "query_id": "...",
  "model": "..."
}
```

Deep Research 服务端保存返回的 `session_id` 到当前 conversation 的 `agent_session_id`。后续该 conversation 的 `@agent` 调用都带上这个 `session_id`。

## 行业分析师 Agent

Icarus 侧建议增加一个专用 group/agent：

- `chat_jid`: `web:deep-research-analyst`
- `folder`: `deep-research-analyst`
- 角色：行业分析师、报告诊断助手、二次调研建议助手、提示词优化助手。

稳定 system prompt 中应包含：

- 你是 Deep Research 的行业分析师 agent。
- 你可以通过只读挂载目录读取 Deep Research conversation 和 task 文件。
- 不要假设未读取的报告内容。
- 当用户引用 task 时，优先读取被引用 task 的详情和报告。
- 如需要更多上下文，先读取 conversation index，再按需读取 task 文件。
- 回答中明确区分“已从报告读取的信息”和“你的推断或建议”。

## 只读资料挂载

不要把整个 `deep-research` 项目目录挂进 agent 容器，避免暴露 `.env`、运行脚本、内部实现文件等。

建议由 Deep Research 服务维护一个专门给 agent 读取的资料目录：

```text
deep-research/.data/agent-readable/
  sessions/
    drs_xxx.json
  tasks/
    dr_task_1.json
    dr_task_1.md
    dr_task_2.json
    dr_task_2.md
```

Icarus 将该目录配置到 Deep Research analyst group 的 `additionalMounts` 中，容器内路径为：

```text
/workspace/extra/deep-research
```

挂载权限只读，并继续受 `~/.config/icarus/mount-allowlist.json` 控制。agent 只读取索引和报告，不直接修改 Deep Research 状态。

### Session Index

`sessions/{conversation_id}.json` 示例：

```json
{
  "id": "drs_xxx",
  "title": "AI 教育产品行业分析",
  "created_at": "2026-06-29T00:00:00.000Z",
  "updated_at": "2026-06-29T00:00:00.000Z",
  "task_ids": ["dr_task_1", "dr_task_2"],
  "tasks": [
    {
      "id": "dr_task_1",
      "title": "中国 AI 教育硬件市场分析",
      "status": "completed",
      "provider": "openai",
      "model": "o3-deep-research",
      "prompt_preview": "分析中国 AI 教育硬件市场...",
      "metadata_path": "/workspace/extra/deep-research/tasks/dr_task_1.json",
      "report_path": "/workspace/extra/deep-research/tasks/dr_task_1.md"
    }
  ]
}
```

### Task Metadata

`tasks/{task_id}.json` 示例：

```json
{
  "id": "dr_task_1",
  "conversation_id": "drs_xxx",
  "title": "中国 AI 教育硬件市场分析",
  "status": "completed",
  "provider": "openai",
  "model": "o3-deep-research",
  "prompt": "分析中国 AI 教育硬件市场...",
  "created_at": "2026-06-29T00:00:00.000Z",
  "updated_at": "2026-06-29T00:00:00.000Z",
  "report_path": "/workspace/extra/deep-research/tasks/dr_task_1.md",
  "source_count": 24,
  "sources": [
    {
      "title": "...",
      "url": "https://example.com"
    }
  ]
}
```

### Task Report

`tasks/{task_id}.md` 保存完整报告正文，包含 sources。报告未完成时可以不存在，或写入简短占位内容。

## Agent Runtime Context

不建议把所有 task 内容拼进 system prompt，也不建议依赖修改历史 transcript 来实现上下文覆盖。

每次 `@agent` 调用时，在本轮 user prompt 前加入轻量 runtime context：

```text
[Deep Research Runtime Context]
conversation_id: drs_xxx
mounted_root: /workspace/extra/deep-research
referenced_task_ids:
- dr_task_1
- dr_task_2

File structure:
- sessions/{conversation_id}.json contains the task index for this conversation.
- tasks/{task_id}.json contains task metadata and report_path.
- tasks/{task_id}.md contains the full report.
[/Deep Research Runtime Context]

User request:
看一下我引用的两个报告，它们的结论有没有冲突？帮我优化下一轮调研提示词。
```

这样做的效果：

- token 成本低。
- agent 可以渐进式读取需要的报告。
- 每次调用都传入当前 conversation id 和引用 task id，避免依赖过期上下文。
- 历史里即使存在旧 runtime context，也由当前最新 runtime context 覆盖语义。

## 引用交互

每个报告卡片增加“引用”按钮。

推荐交互：

1. 用户点击一个或多个报告卡片的“引用”按钮。
2. composer 上方显示已引用报告 chips。
3. 用户输入 `@agent ...`。
4. 前端请求中发送 `referenced_task_ids`。
5. 服务端调用 Icarus agent API 时把这些 task id 写入 runtime context。
6. 发送成功后可清空引用列表，或保留到用户手动取消。第一版建议发送成功后清空，避免误引用。

请求示例：

```json
{
  "conversation_id": "drs_xxx",
  "content": "@agent 对比这些报告，指出矛盾点并给下一轮调研问题",
  "referenced_task_ids": ["dr_task_1", "dr_task_2"]
}
```

## Conversation 与 Agent Session 绑定

绑定关系存储在 conversation 上：

```json
{
  "id": "drs_xxx",
  "agent_session_id": "icarus-agent-session-id"
}
```

调用流程：

1. 用户在 conversation 中输入 `@agent ...`。
2. Deep Research 查询当前 conversation 的 `agent_session_id`。
3. 如果为空，调用 Icarus agent chat API 时不传 `session_id`。
4. Icarus 创建新 agent session 并返回 `session_id`。
5. Deep Research 保存该 `session_id`。
6. 后续同一 conversation 的 `@agent` 调用都带上这个 `session_id`。

## 旧数据处理

旧版本只有 `tasks.json`，没有 conversation 概念。最终实现不迁移旧数据，直接丢弃旧 store。

处理规则：

1. 如果 store version 不是 v2，或缺少 `conversations/tasks/messages` 数组，启动时重置为空 v2 store。
2. 不创建默认 conversation。
3. 不为旧 task 生成 message。
4. 同步清空并重建 `.data/agent-readable`。

## 安全边界

- 只通过 `additionalMounts` 挂载 `.data/agent-readable`，不要挂载整个项目根目录。
- 挂载为只读。
- host root 继续由 `~/.config/icarus/mount-allowlist.json` 放行。
- 不把 `.env`、API key、服务启动脚本暴露给容器。
- task metadata 中不要写入 provider 原始 response 的敏感字段。
- agent-readable 文件应是可审计的导出视图，不是内部状态原件。

## 失败处理

- Icarus agent API 不可用：在 conversation 中写入一条 `agent_error` message，前端显示错误。
- 引用的 task id 不存在或不属于当前 conversation：服务端拒绝请求，返回 400。
- task 报告未完成：runtime context 仍可传入 task id，agent 读取 metadata 后应能看到状态为 running/failed/cancelled。
- agent 未读取报告就做结论：通过 system prompt 约束“不读取不结论”，但实现上不强制。

## 建议实施顺序

1. 增加 conversation/task/message 的 store v2 结构；旧 store 直接重置为空。
2. 增加 `.data/agent-readable` 导出器，同步 conversation index 和 task report 文件。
3. 前端改造为 conversation 列表和单 conversation 内多 task thread。
4. 报告卡片增加“引用”按钮和 composer 引用 chips。
5. Icarus 增加 session-capable `/internal/agent/chat` API。
6. Deep Research 增加 `@agent` 路由，调用 Icarus agent chat API。
7. Icarus 通过 analyst group 的 `additionalMounts` 挂载 agent-readable 目录为 `/workspace/extra/deep-research`。
8. 增加端到端验证：创建多个报告、引用报告、`@agent` 追问、刷新页面后继续同一 agent session。

## 关键决策

- task 内容不直接塞入上下文。
- agent 通过只读挂载目录渐进式读取 task。
- `@agent` 调用每轮传入 conversation id 和 referenced task ids。
- system prompt 只放稳定角色和文件结构说明。
- conversation 与 Icarus agent session 一对一绑定。
- run-once 接口保持原语义，新增 session-capable chat 接口。
