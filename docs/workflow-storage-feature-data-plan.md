# Workflow Storage 与 Pack Data Root

> **状态**：Current
> **替代历史设计**：旧 Feature Data Root 方案已归档到 [`archive/workflow-storage-feature-data-plan-pre-workflow-pack.md`](archive/workflow-storage-feature-data-plan-pre-workflow-pack.md)。

## 当前边界

Workflow Pack 只有一个 Core 管理的数据根：

```text
data/workflow-packs/{packId}/
```

路径由 `getWorkflowPackManagedDataRoot()` 返回。`packId` 必须是安全的单一路径段；Pack 不能声明任意 Host 根目录，也不能通过 Manifest 注册 migration、projection table 或后台服务。

Pack 的执行资源不直接从源码目录运行。startup reconciler 校验并发布 Pack Release 后，将 Manifest 指定的 `agents/skills/mcp/scripts/templates` 复制到：

```text
data/workflow-pack-execution/{packId}/{manifestHashWithoutPrefix}/
```

`bundle.json` 固定 Pack ref/version、Manifest hash、execution artifact ref/hash 和逐文件 byte hash。Run 通过 Registry snapshot 与 active-run retention handle 解析 exact staging copy；Disable 后旧 Run 仍可使用该 pin，staging byte drift 会 fail closed。

## 生命周期

- **Disable**：删除 active Catalog pointer，不删除 managed root、staging、TaskSession 或 Runtime history。
- **Uninstall**：要求 Pack 已 disabled，将源码目录移入显式 archive；不删除 Registry history。
- **Purge**：要求没有 active Run pin，只删除 managed Pack data root 和该 Pack 的 execution staging copy。

Purge preview 明确保留 `task_sessions`、`runtime_history`、`shared_artifacts`、`audit` 和 `external_workspaces`。当前实现也保留 immutable Pack Release/Registry history；未实现跨领域递归删除或外部 workspace 删除。

## 非目标

- Pack 不拥有 TaskSession、通用 Runtime event、共享 Artifact 或 external workspace。
- Pack Purge 不代理用户的 `Delete Task`。
- Pack 不提供 `feature_data`、`external_feature_data`、隐式 DB migration 或 owner table prefix。
- Container file scope 必须来自发布的 execution bundle 和 Host policy，不能由业务源码动态扩大。
