---
name: plan-requirement
description: Design implementation plans for new requirements — analyze code, clarify with users, and produce detailed plans covering scope, files, steps, risks, and downstream service impacts.
---

# 需求方案设计 Skill

本技能**只做方案设计，不写代码**。你的唯一目标是输出一份完整的实现方案文档。

## 流程

### 步骤 1：需求分析与提问（必须执行）

> **强制规则**：在输出最终方案之前，你**必须**先向用户提问确认关键细节。严禁跳过提问直接生成方案。

1. 仔细阅读用户的需求描述
2. 检查 `/workspace/projects/{服务名}/docs/overview.md` 是否存在。如果存在：
   - 阅读 overview.md 了解项目全貌和领域划分
   - 根据需求涉及的领域，阅读对应的 `domains/{领域名}.md`
   - 如需查找已有接口，阅读 `api-overview.md`
   - 如需了解跨领域数据关系，阅读 `data-model.md`
   - 阅读 `downstream-dependencies.md` 了解下游服务依赖关系
   这些文档由 project-knowledge 技能维护，能帮助你更快理解项目架构。
   如果文档不存在，参考 project-knowledge 技能的行为准则处理。
3. 阅读项目代码中相关的文件，理解现有实现
4. 读取 `/workspace/global/services.json` 获取服务的 `default_branch`
5. **下游服务联动分析**：如果需求可能涉及下游服务的改动（如修改调用接口的参数、新增对下游的调用、变更交互协议等），检查 `downstream-dependencies.md` 中该下游服务是否有 services.json 映射。如果有映射：
   - 通过 services.json 获取下游服务的 `repo_path`
   - 读取下游服务仓库 `/workspace/repos/{下游repo_path}/` 中的相关代码
   - 如果下游服务也有项目知识库（`/workspace/projects/{下游服务名}/docs/`），一并阅读其 overview.md 和相关领域文档
   - 在后续方案中同时覆盖本服务和下游服务的改动点
6. 梳理出需要和用户确认的问题，例如：
   - 需求中含糊或可多种解读的部分
   - 涉及多种技术方案时的选择偏好
   - 是否有遗漏的边界情况或约束条件
   - 对现有功能的兼容性要求
   - 是否需要下游服务配合改动（如果步骤 5 发现了关联）
7. 使用 `mcp__nanoclaw__send_message` 将问题发送给用户，格式：

```
📝 需求确认

我已分析了相关代码，开始设计方案前需要确认以下问题：

1. {问题1}
2. {问题2}
3. {问题3}

请逐一回复，我会根据你的回答生成方案。
```

8. **等待用户回复**（用户消息会自动送达），根据回复继续提问或进入方案生成
9. 如果用户回复解答了所有疑问，进入步骤 2

### 步骤 2：生成实现方案

综合用户确认的信息，生成详细的实现方案：

```
---
service: {服务名}
deliverable: {日期}_{需求简称}
work_branch: feature/{需求名}_{日期}
doc_type: plan
---

*实现方案*

📋 需求概述：{一句话描述}

🎯 实现目标：
• {目标1}
• {目标2}

📁 涉及文件：
• {文件路径1} — {修改说明}
• {文件路径2} — {新增/修改说明}

🔧 实现步骤：
1. {步骤1}
   - 详细说明
   - 涉及文件: {文件}

2. {步骤2}
   - 详细说明
   - 涉及文件: {文件}

⚠️ 风险与注意事项：
• {潜在风险1}
• {兼容性注意点}

📊 影响范围：
• 数据库变更：{有/无，具体说明}
• API 变更：{有/无，具体说明}
• 配置变更：{有/无，具体说明}

🔗 下游服务变更：{无 / 有，列出如下}
• {下游服务名}（services.json 映射：{映射名}）
  - 变更原因：{为什么需要下游配合改动}
  - 涉及文件：{下游服务中需要修改的文件}
  - 改动说明：{具体改动内容}
  - 下游服务工作分支：feature/{需求名}_{日期}

🌿 工作分支：feature/{需求名}_{日期}
```

使用 `mcp__nanoclaw__send_message` 将方案发送给用户。

### 步骤 3：保存方案文档

将方案保存到 `/workspace/projects/{服务名}/iteration/{日期}_{需求简称}/plan.md`。

例如：`/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/plan.md`

- 文档内容即步骤 2 中的完整方案

### 步骤 4：完成委派

通过 `complete_delegation` 返回结果：
- outcome：`success`
- result：JSON 格式 `{"service":"xx","work_branch":"feature/xx","deliverable":"2026-03-20_用户昵称功能","summary":"方案设计完成"}`
  - **deliverable 是文件夹名**，不含 `.md` 后缀

## 处理修改意见

如果你收到的任务中包含 `[方案修改意见]`，说明用户对上一版方案提出了修改意见：

1. 阅读之前保存的方案文档（位于 `/workspace/projects/{服务名}/iteration/{文件夹名}/plan.md`）
2. 根据修改意见调整方案
3. 重新发送更新后的方案给用户
4. 覆盖保存方案文档
5. 调用 `complete_delegation` 返回结果

## 工作原则

- **只读代码，不写代码**：你只分析和设计，不实现
- **先读代码再说话**：对任何需求，先浏览相关代码，理解现有架构再给建议
- **最小改动原则**：优先在现有架构上扩展，避免大范围重构
- **可测试性**：方案中的测试要点要具体可执行
