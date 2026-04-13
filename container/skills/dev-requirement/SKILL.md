---
name: dev-requirement
description: Implement features based on approved plans — read design docs, write code, create branches, and produce delivery documents.
---

# 需求开发 Skill

本技能负责**按照已确认的方案执行代码实现**。

## 流程

### 步骤 1：阅读方案

1. 从任务描述中获取方案文件路径，阅读 `/workspace/projects/{服务名}/iteration/{文件夹名}/plan.md` 中的方案内容
2. 优先从任务消息读取 `主分支：xxx`、`工作分支：xxx` 等分支参数；若消息未提供 `主分支`，再读取 `/workspace/global/services.json` 获取服务的 `default_branch`
3. 如有疑问，使用 `mcp__nanoclaw__send_message` 向用户确认

### 步骤 2：创建工作分支

优先使用消息中明确给出的 `工作分支：xxx`。

- 若消息里已有工作分支名，检查该分支是否存在，不存在则新建，并在该分支继续开发，不要自行改名或重建
- 若消息未提供工作分支，则基于已确认的 `主分支`（缺省可回退到 `default_branch`）创建 `feature/{需求名}_{日期}`（如 `feature/user-nickname_20260320`）

### 步骤 3：代码实现

严格按照方案逐步修改代码，完成后提交并 push 工作分支。

### 步骤 4：生成交付文档

生成交付文档并保存到 `/workspace/projects/{服务名}/iteration/{日期}_{需求简称}/dev.md`。

例如：`/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/dev.md`

```markdown
---
service: {服务名}
deliverable: {日期}_{需求简称}
main_branch: {主分支}
work_branch: {分支名}
doc_type: dev
---

# 需求实现报告

## 基本信息
- 需求名称：{名称}
- 完成日期：{日期}
- 工作分支：{分支名}
- 需求描述：{完整的需求描述}

## 实现方案
{方案概述，包含技术选型和设计决策}

## 变更明细

### 修改的文件
| 文件 | 变更类型 | 变更说明 |
|------|---------|---------|
| {路径} | 新增/修改/删除 | {具体说明} |

### 关键代码变更
{每个文件的核心变更逻辑，附关键代码片段}

## 接口变更（如有）
### 新增接口
- {接口路径} — {方法} — {说明}
  - 请求参数：{参数说明}
  - 返回格式：{返回说明}

### 修改的接口
- {接口路径} — {变更说明}

## 数据库变更（如有）
- {表名} — {变更说明}

## 测试要点
- {测试点1}：{预期行为}
- {测试点2}：{预期行为}
- {边界情况}：{预期行为}

## 注意事项
- {部署注意事项}
- {数据迁移注意事项}
- {兼容性注意事项}
```

### 步骤 5：完成委派

1. 将交付文档关键内容通过 `mcp__nanoclaw__send_message` 发送给用户
2. 通过 `complete_delegation` 返回结果：
   - outcome：`success`
   - result：JSON 格式 {"service":"xx","main_branch":"main","work_branch":"feature/xx","deliverable":"2026-03-20_用户昵称功能","summary":"需求开发完成"}
     - **deliverable 是文件夹名**，不含 `.md` 后缀

## 工作原则

- *先读代码再说话*：对任何需求，先浏览相关代码，理解现有架构再给建议
- *最小改动原则*：优先在现有架构上扩展，避免大范围重构
- *可测试性*：实现时考虑如何验证，交付文档中的测试要点要具体可执行
