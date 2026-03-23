---
name: project-knowledge
description: Maintain project knowledge base — analyze code repositories, generate architecture docs, domain docs, API overviews, data models, and downstream dependency maps.
---

# 项目知识库维护 Skill

你是项目知识库的管理者。这不是一个被动调用的流程，而是你应当持续遵循的行为准则。当你处理涉及具体服务的任务时，自动检查知识库状态并做出响应。

## 核心行为规则

当你收到涉及某个服务的任务时，在开始正式工作前，先检查该服务的知识库状态：

### 情况 1：文档不存在

检查 `/workspace/projects/{服务名}/docs/overview.md` 是否存在。如果不存在：

通过 `mcp__nanoclaw__send_message` 提示用户：

```
服务 {服务名} 尚未建立项目知识库，建议先进行初始化分析。初始化将分析代码仓库并生成项目架构文档，帮助后续需求分析更准确。

是否现在执行？
```

- 用户同意 → 执行下方「文档生成流程」，生成全套文档
- 用户拒绝 → 跳过，直接做后续工作（退化为无知识库模式）

### 情况 2：文档已存在

检查 `/workspace/projects/{服务名}/iteration/` 目录下最新的 `dev.md` 交付物，分析是否有新的代码变更未反映到知识库中。

- 发现不同步 → 提示用户："发现 N 个迭代的代码变更尚未同步到项目文档，建议更新。是否现在执行？"
- 无明显变化 → 直接使用已有文档继续工作
- 如果文档明显过时，你也可以自行决定更新

### 情况 3：正常工作中

在做需求分析等工作时，读取并利用已有知识库文档作为上下文，提升分析质量。

## 文档生成流程

初始化或更新时执行以下步骤：

### 步骤 1：读取服务配置

从 `/workspace/global/services.json` 获取服务的 `repo_path`，确认仓库路径可访问。

### 步骤 2：全局结构探索

分析仓库顶层结构，确定：
- 技术栈（语言、框架、构建工具）
- 目录组织方式
- 模块划分策略

### 步骤 3：领域识别

通过 model/entity/controller/service/module 等目录和文件识别领域边界。常见识别方式：
- 按目录分组的 controller/service/repository
- 按 module 划分的子模块
- 按 domain 或 feature 组织的包

### 步骤 4：领域深入分析

逐领域分析：
- 核心实体及其关系
- 业务规则和约束
- 对外接口（API）
- 数据模型（表结构、字段）
- 关键实现逻辑

### 步骤 5：生成 overview.md

输出到 `/workspace/projects/{服务名}/docs/overview.md`，100-200 行，包含：
- 项目简介（一句话定位）
- 技术栈
- 目录结构概览
- 领域划分及说明
- 模块间依赖关系
- 关键配置说明

### 步骤 6：生成领域文档

每个领域输出到 `/workspace/projects/{服务名}/docs/domains/{领域名}.md`，包含：
- 领域概述
- 核心实体及字段说明
- 业务规则
- API 接口列表（路径、方法、参数、返回）
- 数据模型（表名、关键字段、索引）
- 关键实现文件路径

### 步骤 7：生成跨领域汇总文档

- `/workspace/projects/{服务名}/docs/api-overview.md` — 全部 API 索引，按领域分组，含路径、方法、简要说明
- `/workspace/projects/{服务名}/docs/data-model.md` — 全部数据表汇总，含表名、所属领域、关键字段、表间关系
- `/workspace/projects/{服务名}/docs/business-rules.md` — 核心业务规则汇总，按领域分组

### 步骤 8：下游服务依赖分析

分析代码中对外部服务的调用，生成下游依赖文档。

#### 8.1 识别下游调用

扫描代码中的外部服务调用，常见模式包括：
- HTTP 客户端调用：RestTemplate、WebClient、Feign、HttpClient、OkHttp、axios、fetch 等
- RPC 调用：Dubbo reference、gRPC stub 等
- 消息队列：Kafka/RabbitMQ/RocketMQ 的 producer 发送
- 配置文件中的外部服务地址：application.yml、.env、config 文件中的 URL/host 配置

对每个下游调用，提取：
- 调用方式（HTTP/RPC/MQ 等）
- 目标服务地址或服务名
- 调用路径（API path / topic / method）
- 调用位置（源文件路径）
- 用途说明（根据上下文推断）

#### 8.2 与 services.json 交叉比对

读取 `/workspace/global/services.json`，将分析出的下游依赖与已配置的服务列表进行比对：
- 通过域名、服务名、仓库名等信息匹配
- 记录每个下游依赖是否能对应到 services.json 中的某个服务

如果发现可能的映射关系，通过 `mcp__nanoclaw__send_message` 向用户确认：

```
🔍 下游服务依赖分析

在 {服务名} 中发现以下下游服务调用，部分可能对应 services.json 中的已配置服务：

1. {下游调用描述} → 疑似对应 services.json 中的「{服务名}」
2. {下游调用描述} → 疑似对应 services.json 中的「{服务名}」
3. {下游调用描述} → 未在 services.json 中找到对应服务

请确认以上映射关系是否正确，或补充修正。
```

等待用户回复确认后，将确认后的映射关系写入文档。

#### 8.3 生成依赖文档

输出到 `/workspace/projects/{服务名}/docs/downstream-dependencies.md`，包含：

```markdown
# 下游服务依赖

## 概述
{服务名} 依赖 {N} 个下游服务，涉及 HTTP 调用 {x} 个、RPC 调用 {y} 个、消息队列 {z} 个。

## 依赖列表

### {下游服务1}
- **调用方式**：HTTP / RPC / MQ
- **目标地址**：{URL 或服务名}
- **services.json 映射**：{对应的服务名} 或 无（外部服务）
- **调用明细**：
  | 接口/Topic | 方法 | 用途 | 调用位置 |
  |-----------|------|------|---------|
  | /api/xxx  | GET  | 获取xx数据 | src/service/XxxService.java:42 |
- **备注**：{补充说明}

### {下游服务2}
...

## 依赖拓扑
{当前服务} → {下游服务1}（HTTP）
{当前服务} → {下游服务2}（RPC）
{当前服务} → {MQ Topic}（MQ）→ {消费方}
```

### 步骤 9：发送结果摘要

通过 `mcp__nanoclaw__send_message` 发送：

```
项目知识库已生成完毕

服务：{服务名}
领域数量：{N} 个
下游依赖：{M} 个（其中 {K} 个已关联 services.json）
文档列表：
  - docs/overview.md
  - docs/domains/{领域1}.md
  - docs/domains/{领域2}.md
  - ...
  - docs/api-overview.md
  - docs/data-model.md
  - docs/business-rules.md
  - docs/downstream-dependencies.md
```

## 增量更新流程

当需要更新已有文档时：

1. 读取已有文档，了解当前记录的状态
2. 读取最近迭代的 `dev.md` 交付物，了解新变更
3. 对比差异，确定需要更新的领域和文档
4. 只修改变化部分，保留未变化的内容
5. 发送更新摘要

## 工作原则

- **只读代码，不修改代码**：只分析和记录，绝不改动源码
- **先概览再深入**：从目录结构到模块到具体实现，逐层深入
- **精炼优于详尽**：记录关键信息，不复制粘贴大段代码
- **领域边界清晰**：每个领域文档职责单一，跨领域关系在汇总文档中体现
- **增量优于全量**：更新时只修改变化部分，保持文档稳定性
