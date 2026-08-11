# PM Pipeline Workflow Pack 接入说明

> **状态**：Current architecture boundary
> **历史方案**：原 Feature App 全量迁移方案已归档到 [`../../docs/archive/pm-pipeline-full-migration-plan-pre-workflow-pack.md`](../../docs/archive/pm-pipeline-full-migration-plan-pre-workflow-pack.md)。

PM Pipeline 如重新接入，只能作为 `workflow-packs/pm-pipeline/` 下的声明式 Workflow Pack：

```text
workflow-packs/pm-pipeline/
  pack.json
  workflow-src/
    recipes/
    definitions/
    policies/
    schemas/
    capabilities/
  resources/
    agents/
    skills/
    mcp/
    scripts/
    templates/
```

Pack 发布 selectable Recipe、Definition、Policy、Schema 和必要的 execution resources。用户只从 Task Workspace 的统一 Catalog 启动 Recipe，并使用通用 Timeline、DAG、Human Input 和 Artifact UI。

PM Pipeline 不再拥有一级导航、renderer module、arbitrary Feature API、Host entry、后台服务、隐式 migration 或专用 projection lifecycle。领域状态应进入 Workflow Runtime；Task 讨论与链接进入 Task Workspace；交付物使用通用 Artifact metadata。确需外部 I/O 时，Pack 只能引用 Core allowlist 中的 exact Capability/Adapter binding。

启用由 `local/workflow-packs.json` 表达期望状态，但只有已验证并激活的 `workflow_pack_active_releases` pointer 能让 Recipe 进入 Catalog。Manifest/hash/path/permission/compile 任一校验失败都必须保留旧 active pointer。

数据动作固定分为 Disable、Uninstall 和 Purge。任何动作都不得删除 TaskSession、Runtime history、共享 Artifact 或 external workspace。
