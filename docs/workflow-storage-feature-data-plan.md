# Workflow Storage 与 Feature Data Root 通用化方案

## 背景

当前 Icarus 的 workflow 产物路径带有早期 `dev_test` / `fix_test` 的服务研发模型假设：

- Workbench artifact 展示和索引默认偏向 `projects/{service}/iteration/{deliverable}/...`。
- Context pack 是 workflow runtime 的通用机制，但当前固定写到 `projects/{service}/workflow-context/{workflow_id}/{stage_key}/...`。
- Feature Package Runtime 已经支持 feature 的 API、导航、workflow、agent、skill、artifact contract、migration、独占 agent 等资源动态注册，但运行期业务数据根还没有形成统一约定。

这些假设对服务研发流程可用，但不适合 PM Pipeline、research、ops、knowledge production 等不以 `service` 为中心的 feature workflow。

## 目标

- 将 workflow runtime 通用产物从 `projects/{service}` 中解耦。
- 为所有 workflow 提供通用 `workflow storage root`。
- 为 feature package 提供通用 `feature data root`。
- 让 Workbench artifact 索引支持任意受控 artifact root，而不是只支持 `projects/{service}/iteration/{deliverable}`。
- 让 artifact contract、context pack、container mount、permission、audit、feature deletion 都能识别新的路径模型。
- 将现有 `dev_test` / `fix_test` 的 `projects/{service}` 历史产物迁移到新的受控 root，并移除运行时 legacy 兼容逻辑。

## 非目标

- 不迁移无法归属到 workflow、artifact record 或 context pack 的任意服务文档；这类文件只作为普通项目资料保留在原目录或由业务侧单独整理。
- 不要求 core 规定每个 feature 的业务目录结构。
- 不把 feature 运行期数据写入 `features/{featureId}/` 源码包目录。
- 不让 feature 绕过 core 的路径安全、权限、审计和删除摘要机制。

## 核心结论

新增两类 core 管理的根目录：

```text
data/workflows/{workflowId}/
data/features/{featureId}/
```

语义：

| 根目录 | 归属 | 用途 |
| --- | --- | --- |
| `data/workflows/{workflowId}` | Icarus core | workflow runtime 通用数据，如 context pack、scratch、默认 artifact、logs |
| `data/features/{featureId}` | Icarus core 管理边界，feature 定义业务结构 | feature 运行期业务数据，如 PM workspace、research reports、ops evidence |
| `projects/{service}` | migration source / legacy archive | 历史服务研发产物的迁移输入；迁移完成后不再作为 workflow runtime root |

Feature package 源码目录仍是：

```text
features/{featureId}/
```

它只放 manifest、host、renderer、container resources、模板和代码，不放运行期业务数据。

## 路径模型

### Workflow Storage Root

默认创建：

```text
data/workflows/{workflowId}/
  context/
    {stageKey}/
      latest.json
      context-pack.r{round}.a{attempt}.json
  artifacts/
  scratch/
  logs/
```

容器中建议挂载为：

```text
/workspace/workflows/{workflowId}/
```

默认规则：

```text
runtimeRoot = data/workflows/{workflowId}
contextPackRoot = data/workflows/{workflowId}/context/{stageKey}
artifactRoot = data/workflows/{workflowId}/artifacts
```

### Feature Data Root

core 提供：

```text
data/features/{featureId}/
```

容器中建议挂载为：

```text
/workspace/features/{featureId}/data/
```

feature 自己定义该目录下的业务结构。例如：

```text
data/features/pm-pipeline/workspaces/{workspaceId}/...
data/features/research/reports/{reportId}/...
data/features/ops/incidents/{incidentId}/...
```

core 不理解这些业务目录，只负责：

- 创建 feature data root。
- 校验路径不越界。
- 提供 host path / container path 解析。
- 将路径纳入权限、审计、artifact index、contract、删除摘要。

### Legacy Projects Migration Source

现有 legacy 路径只作为迁移输入识别：

```text
projects/{service}/iteration/{deliverable}/...
projects/{service}/workflow-context/{workflowId}/{stageKey}/...
```

迁移完成后：

- workflow runtime 不再创建、写入或解析 `projects/{service}/workflow-context`。
- Workbench artifact resolver 不再把 `projects/{service}/iteration` 作为 root fallback。
- `projects/{service}` 中无法归属到 workflow 的资料可以继续作为普通项目资料存在，但不属于 workflow storage 模型。

## Workflow Storage 配置

建议在 workflow definition version 增加可选 `storage`：

```json
{
  "storage": {
    "artifact_root": {
      "kind": "workflow_runtime",
      "path": "artifacts"
    },
    "context_pack_root": {
      "kind": "workflow_runtime",
      "path": "context/{{stage_key}}"
    }
  }
}
```

支持的 root kind：

| kind | 说明 |
| --- | --- |
| `workflow_runtime` | `data/workflows/{workflowId}` 下的路径 |
| `feature_data` | `data/features/{featureId}` 下的路径，需要 workflow 属于某个 feature 或显式声明 feature id |
| `external_feature_data` | feature 注册的外部数据根，用于接入已有 workspace |

`dev_test` / `fix_test` 不再声明 legacy storage。它们可以使用默认 `workflow_runtime`：

```json
{
  "storage": {
    "artifact_root": {
      "kind": "workflow_runtime",
      "path": "artifacts/{{deliverable}}"
    },
    "context_pack_root": {
      "kind": "workflow_runtime",
      "path": "context/{{stage_key}}"
    }
  }
}
```

新 workflow 默认走 `workflow_runtime`。

Feature workflow 可以声明：

```json
{
  "storage": {
    "artifact_root": {
      "kind": "feature_data",
      "feature_id": "pm-pipeline",
      "path": "workspaces/{{workspace_id}}/deliverables/{{package_id}}"
    },
    "context_pack_root": {
      "kind": "feature_data",
      "feature_id": "pm-pipeline",
      "path": "workspaces/{{workspace_id}}/workflow-context/{{workflow_id}}/{{stage_key}}"
    }
  }
}
```

模板变量来自 workflow context。缺少必需变量时，workflow create 或 stage prepare 必须失败并给出明确错误。

## Workbench Artifact 索引通用化

当前 `workbench_artifacts.path` 是文本路径，并且展示 resolver 偏向：

```text
projects/{service}/iteration/{deliverable}/...
```

需要演进为 artifact location 模型。

建议扩展表结构：

```sql
ALTER TABLE workbench_artifacts ADD COLUMN location_kind TEXT;
ALTER TABLE workbench_artifacts ADD COLUMN location_uri TEXT;
ALTER TABLE workbench_artifacts ADD COLUMN host_path TEXT;
ALTER TABLE workbench_artifacts ADD COLUMN container_path TEXT;
ALTER TABLE workbench_artifacts ADD COLUMN feature_id TEXT;
ALTER TABLE workbench_artifacts ADD COLUMN metadata_json TEXT;
```

迁移规则：

- 历史记录必须由迁移脚本补齐 `location_kind`、`location_uri`、`host_path` 或可解析 metadata。
- 新记录写 `location_kind`、`location_uri`，同时可冗余 `path` 作为展示路径。
- 迁移完成后 resolver 不再把 `path` 当成权威位置；发现只有 `path` 的记录应报出“需要运行迁移”的明确错误。
- `host_path` 可以为空，按需解析；如写入则必须经过 core path resolver。

建议 location URI：

```text
workflow://{workflowId}/artifacts/plan.md
feature://pm-pipeline/workspaces/ws1/deliverables/pkg1/01-需求范围与边界.md
external-feature://pm-pipeline/{workspaceId}/deliverables/pkg1/...
```

Workbench artifact resolver 职责：

- 根据 workflow definition 的 `artifacts` 声明和 workflow storage roots 生成 artifact index。
- 支持相对路径相对于 `artifactRoot` 解析。
- 支持显式 root URI。
- 校验路径不越界。
- 将 resolved location 写入 `workbench_artifacts`。

Workflow definition artifact 示例：

```json
{
  "artifacts": [
    {
      "artifact_type": "plan_doc",
      "title": "方案文档",
      "path": "plan.md",
      "root": "artifact_root",
      "source_role": "planner"
    }
  ]
}
```

`root` 省略时默认 `artifact_root`。`dev_test` / `fix_test` 的历史 artifact 在迁移后统一解析为 `workflow://{workflowId}/artifacts/...` 或对应的 feature data URI，不再解析为 `projects/{service}/iteration/{deliverable}`。

## Artifact Contract 通用化

Artifact contract 当前支持 `/workspace/projects` 作为 allowed root。需要扩展为 root-aware 解析。

建议 contract 支持：

```json
{
  "allowed_artifact_roots": [
    "root:artifact_root",
    "root:context_pack_root",
    "feature://pm-pipeline",
    "workflow://current"
  ],
  "files": [
    {
      "path": "01-需求范围与边界.md",
      "root": "artifact_root",
      "required": true
    }
  ]
}
```

迁移规则：

- 历史 contract、workflow definition、技能提示中的 `/workspace/projects/...` 路径必须迁移为 `root` + relative path 或新的 container root。
- 新 contract 必须优先使用 `root` + relative path。
- absolute `/workspace/...` 路径仍可支持，但必须映射到已声明 allowed root；迁移后 `/workspace/projects` 不再是默认 allowed root。

## Context Pack 通用化

Context pack 是 workflow runtime 通用机制，不属于某个业务 artifact。

当前路径：

```text
projects/{service}/workflow-context/{workflowId}/{stageKey}/
```

推荐默认路径：

```text
data/workflows/{workflowId}/context/{stageKey}/
```

容器路径：

```text
/workspace/workflows/{workflowId}/context/{stageKey}/
```

如果 workflow storage 配置了 `context_pack_root`，则写入配置根：

```text
data/features/pm-pipeline/workspaces/{workspaceId}/workflow-context/{workflowId}/{stageKey}/
```

Context pack 写入规则：

- `context-pack.r{round}.a{attempt}.json` 是不可变审计快照。
- `latest.json` 是稳定入口，指向最新快照。
- context pack path 和 hash 写入 workflow context。
- context pack 相关 evaluation evidence 使用 location URI，而不是硬编码 `projects/{service}`。
- 历史 `projects/{service}/workflow-context/{workflowId}/{stageKey}` 由迁移脚本搬到 `data/workflows/{workflowId}/context/{stageKey}`，迁移后运行时不再读取 legacy context path。

## Feature Data Root 支持

core 新增 API / utilities：

```ts
interface FeatureDataRoot {
  featureId: string;
  mode: 'managed' | 'external';
  rootPath: string;
  readonly?: boolean;
}

function getFeatureDataRoot(featureId: string): FeatureDataRoot;
function resolveFeatureDataPath(featureId: string, relativePath: string): ResolvedPath;
function assertPathInsideFeatureData(featureId: string, hostPath: string): void;
```

默认 managed root：

```text
data/features/{featureId}
```

Feature 可以在自己的 projection/config 表里登记 external root，例如 PM Pipeline 注册已有 `ai_workspace_pm`。core 需要提供 path safety helper，但 external root 的业务语义由 feature 负责。

删除规则：

- `managed` feature data root 可以在“停用并删除”时由 core 删除。
- `external` feature data root 默认不删除，只在删除摘要中展示，并要求 feature 明确提供清理策略后才允许删除。

## 权限与审计

新增 file scope 建议：

```text
workflowRuntime
featureData:{featureId}
externalFeatureData:{featureId}:{rootId}
migrationSourceProjects
```

规则：

- Container mount feature data root 前必须检查 feature 权限和 workflow 归属。
- Host action 写 feature data 必须声明对应 file scope。
- Artifact index、context pack 写入、contract 校验都要记录 source root 和 resolved path。
- Feature API 如果返回文件内容或路径，必须走 core path resolver。
- 删除 feature data、清理 workflow storage、修改 artifact index 必须写 audit。
- `migrationSourceProjects` 只允许迁移命令在 dry-run / migrate 阶段读取和搬迁 legacy 文件，不能授予普通 workflow runtime、container 或 Workbench resolver。

审计字段至少包括：

```text
feature_id
workflow_id
action
root_kind
location_uri
host_path_hash
status
created_at
```

## Container Mount 改造

建议新增 mount：

```text
data/workflows/{workflowId} -> /workspace/workflows/{workflowId}
```

当 workflow 属于 feature 且需要 feature data：

```text
data/features/{featureId} -> /workspace/features/{featureId}/data
```

对于 external feature data：

```text
{externalRoot} -> /workspace/features/{featureId}/external/{rootId}
```

Mount 必须由 workflow storage roots 和 file scope 决定，不能对所有 agent 默认暴露所有 feature data。

## 历史产物迁移策略

不保留运行时兼容分支。上线前提供一次性、可重复执行的迁移命令，将可归属的 legacy workflow 产物迁入新的 root，并把数据库记录改成 root-aware location。

迁移输入：

```text
projects/{service}/iteration/{deliverable}/...
projects/{service}/workflow-context/{workflowId}/{stageKey}/...
workbench_artifacts.path
workflow context / evaluation evidence 中的 legacy path
container skill prompt / workflow definition / artifact contract 中的 legacy path 模板
```

迁移目标：

```text
projects/{service}/workflow-context/{workflowId}/{stageKey}/...
  -> data/workflows/{workflowId}/context/{stageKey}/...

projects/{service}/iteration/{deliverable}/...
  -> data/workflows/{workflowId}/artifacts/{deliverable}/...
```

如果 workflow 已归属某个 feature，并且 workflow definition 显式声明 artifact root 为 `feature_data`，则 artifact 迁移到对应 `data/features/{featureId}/...`；否则 `dev_test` / `fix_test` 历史 artifact 默认迁到 `data/workflows/{workflowId}/artifacts/{deliverable}`。

迁移流程：

1. Dry-run 扫描 `projects/{service}`、`workbench_artifacts.path`、workflow context、evaluation evidence，生成 legacy path 到新 location URI 的映射报告。
2. 对可归属文件执行 copy + checksum 校验；同名冲突必须失败并要求人工处理，不能静默覆盖。
3. 在数据库事务中回填 `location_kind`、`location_uri`、`host_path`、`container_path`、`feature_id`、`metadata_json.legacy_source_path`。
4. 更新 workflow context 中的 context pack path、artifact path、evaluation evidence path 为新 container path 或 location URI。
5. 更新 `dev_test` / `fix_test` workflow definition、artifact contract、container skills 和 UI 模板中的 `/workspace/projects/...` 示例与默认路径。
6. 生成迁移审计记录，包含源路径 hash、目标 URI、checksum、迁移状态和失败原因。
7. 校验没有只依赖 `workbench_artifacts.path` 的记录后，运行时切到新 resolver。仍存在未迁移记录时启动或健康检查应失败并提示运行迁移。
8. 迁移完成后可选择删除 legacy workflow 产物，或移动到显式 `archive/projects-migrated/{timestamp}/`；无论是否保留文件，运行时都不能再读取它们。

## 推荐实施顺序

1. 新增 `workflow-storage` path resolver，只支持 workflow runtime root、feature data root、external feature data root。
2. 新增 `data/workflows/{workflowId}` 创建和容器挂载。
3. 扩展 `workbench_artifacts` location 字段，并新增迁移状态 / 审计记录。
4. 实现 legacy 产物迁移命令，支持 dry-run、copy + checksum、事务回填和可重复执行。
5. 将 context pack 默认路径改为 workflow runtime root，不提供 legacy override。
6. 扩展 workflow definition `storage` 配置和 compiler 校验，禁止 legacy root kind。
7. 扩展 Workbench artifact resolver：相对 `artifactRoot` 解析，不再强制或 fallback 到 `projects/{service}/iteration`。
8. 扩展 artifact contract root-aware path 解析，并迁移旧 contract / skill prompt / UI path 模板。
9. 新增 feature data root resolver：`data/features/{featureId}`，支持 managed/external。
10. 将 feature disable/delete summary 纳入 `data/features/{featureId}` 和 workflow-owned runtime storage。
11. 更新 `dev_test` / `fix_test` 默认 artifact/context 配置到 `workflow_runtime`。
12. 执行历史产物迁移并通过完整性校验后，移除 legacy resolver / fallback 代码和测试 fixture。
13. 在 PM Pipeline feature 中试点 feature data root 和 PM artifact contract。

## 验收标准

- 新 workflow 不提供 `service` 也能生成 context pack。
- 新 workflow 默认 context pack 写入 `data/workflows/{workflowId}/context/{stageKey}`。
- Workbench artifact 可以索引 `data/workflows`、`data/features` 和 external feature data 下的文件。
- Artifact contract 能校验 feature data root 下的业务文件。
- Container agent 能读取被授权的 workflow runtime root 和 feature data root。
- 未授权 feature data 不会被挂载到无关 agent。
- `dev_test` / `fix_test` 历史 workflow 和历史 artifact 迁移后仍可展示，展示来源为 `workflow://...` 或 `feature://...`，不是 `project://...` 或 raw `projects/{service}` path。
- `dev_test` / `fix_test` 新 workflow 写入 `data/workflows/{workflowId}` 或声明的 feature data root，不再写入 `projects/{service}/iteration/{deliverable}`。
- 运行时搜索不到 `legacy_service_*` root kind、`/workspace/projects` 默认 allowed root、`workbench_artifacts.path` fallback。
- 存在未迁移 legacy artifact 记录时，启动检查或迁移检查会失败并给出具体记录和源路径。
- Feature 停用并删除时，删除摘要包含 managed feature data root、feature projection 表、feature-owned workflow 历史和独占 agent。
- External feature data root 默认不会被 core 删除。

## 风险

- 如果只改 context pack，不改 Workbench artifact resolver，feature workflow 仍会被 artifact 展示绑回 `projects/{service}`。
- 如果迁移脚本不能准确关联 legacy artifact 与 workflow，可能把服务资料误迁为 workflow artifact；需要 dry-run 报告和人工确认不可归属项。
- 如果 copy 后不做 checksum 和事务回填，可能出现文件已迁移但 DB 仍指向旧路径的半迁移状态。
- 如果 feature data 写进 `features/{featureId}` 源码目录，会污染 git、构建产物和升级流程。
- 如果 artifact index 直接存 host path 而没有 root/URI，后续迁移和跨机器恢复会困难。
- 如果 container 默认挂载所有 feature data，会造成跨 feature 数据泄露。
- 如果删除机制不能区分 managed/external，可能误删用户已有工作区。
