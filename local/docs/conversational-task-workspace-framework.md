# Icarus 对话式 Task Workspace 当前框架

> **状态**：Implemented/current
> **历史设计**：实施前完整方案归档于 [`../../docs/archive/conversational-task-workspace-framework-pre-workflow-pack.md`](../../docs/archive/conversational-task-workspace-framework-pre-workflow-pack.md)。

## 产品模型

TaskSession 是顶层工作对象，承载 Conversation、Launch Intent、Workflow Execution Link、Timeline、Pending Interaction 与 Artifact Link。`Send` 只进行对话，`Run` 才创建 Workflow。

用户选择器只有：

- `Temporary Workflow` 固定模式；
- active Workflow Pack Recipe；
- 当前 principal 的 active Personal Workflow Recipe。

Core System Recipe 使用 `system_only` visibility，不出现在公开 Catalog。Temporary/Personal 流程只能由 Host 调用 `resolveSystemRecipe(purpose)` 获得短期 internal credential，再走相同的 Runtime Workspace Gateway 和 T0 创建路径。

## 执行边界

```text
Task Workspace
  -> Host HTTP/WebSocket adapter
  -> RuntimeWorkspaceGateway
  -> createWorkflowT0
  -> Workflow Runtime service / execution worker
```

公开 Catalog selection token 固定 principal、Recipe ref/hash、active Release、pointer row version、Registry snapshot/hash 和 expiry。Pack Disable 或 Release 切换后旧 token 返回 `selection_stale`。

所有 Task Workspace 创建来源使用 `task_workspace`，actor 使用 `human`。Pack 不拥有额外的 launch source 或 service actor，也不提供专用页面、renderer、导航或 API dispatch；所有运行使用通用 Timeline、Inspector、Human Input、DAG 和 Artifact 展示。

## 四类 Workflow 对象

- **Core System Recipe**：隐藏的平台内部执行协议，不是用户模板。
- **Workflow Pack**：开发者维护、可选安装、Pack-owned 的 selectable 模板。
- **Personal Workflow**：principal-owned、由已审查 Temporary Run 发布的 selectable 模板。
- **Temporary Workflow**：TaskSession-owned 未发布 Draft，确认前不进入 Registry Catalog。

Core 可以在零 Pack、零 Personal Workflow 时运行，公开 Catalog 为空是合法状态。

## 数据与恢复

Task Workspace 使用独立 `store/task-workspace.db` 保存 Session 和链接；Workflow Runtime v16 保存 Registry、Release、Run 与执行事实。旧 schema 不自动迁移，Host 返回 `RESET_REQUIRED`，由显式 backup/reset/reinitialize 流程处理。

Pack Disable/Uninstall/Purge 不删除 TaskSession、Runtime history、共享 Artifact、audit 或 external workspace。已创建 Run 依赖 exact Registry snapshot、retention handle 和 staged execution bundle pin。
