---
name: dev-bugfix
description: Fix bugs in service code on the existing work branch — use the delegated branch, commit fixes, and update delivery documents.
---

# BUG 修复 Skill

## 工作流程

当收到主群委派的 BUG 修复任务时：

1. 确认本次修复使用的工作分支和相关文档参数
   - 优先使用消息中明确给出的 `工作分支：xxx`
   - 若消息中未给出工作分支，则从交付文档中查找 `工作分支：xxx`
   - 交付文档优先读取：`/workspace/projects/{service}/iteration/{deliverable}/dev.md`
   - 若 `dev.md` 不存在，再检查同目录下其他交付文档：`/workspace/projects/{service}/iteration/{deliverable}/`
   - 若仍无法确定工作分支，不要自行创建新分支，也不要猜测；应停止修改并通过 `complete_delegation` 返回失败，说明“缺少明确工作分支，无法安全修复”
   - 同时确认测试文档路径：`/workspace/projects/{service}/iteration/{deliverable}/test.md`
2. 阅读 BUG 详情，并结合测试文档确认本轮待修复问题
   - 除了读取消息中给出的 BUG、测试报告和补充说明，还要结合 `test.md` 中当前仍待修复的 BUG 列表一起判断
   - 如果两者不一致，应以测试文档中的最新待修复状态为准，并结合消息判断本轮优先级
   - 若无法判断本轮到底应修复哪些 BUG，应停止修改并反馈原因，避免修错问题或遗漏问题
   - 在定位问题代码前，先确认本轮需要处理的 `BUG ID`、标题、关联用例和修复范围
3. 在确认好的工作分支上进行修复
   - 默认在原开发分支上直接修复
   - 不要新建 `fix/*`、`bugfix/*` 等额外分支，除非任务中明确要求
4. 提交并 push 当前工作分支
5. 更新测试文档，在测试文档末尾追加修复记录
   - 测试文档路径优先使用消息中明确给出的 `测试文档：xxx`
   - 若消息中未给出，则使用 `/workspace/projects/{service}/iteration/{deliverable}/test.md`
   - 追加位置应在测试报告之后，作为后续回归测试的修复追踪记录
   - 修复记录中的 `BUG ID` 必须与测试报告中的 BUG 编号保持一致，例如 `BUG-001`
   - 修复记录只记录本轮实际已完成修复并已提交到当前工作分支的 BUG
   - 尚未修复、无法复现、暂缓处理、或仍需进一步确认的问题，不要写成已修复记录
   - 如果本轮只修复了部分 BUG，只追加本轮实际修复的那部分，不要把未完成项一并写入
   - 修复说明应写清楚本轮具体改了什么，而不是只写“已修复”
   - 若测试任务结果里带有 `related_case`，应在修复说明中保留对应的测试用例编号，便于后续回归

```markdown
## 修复记录
### Round {N} - {日期}
| BUG ID | 问题 | 修复说明 |
|--------|------|---------|
| BUG-001 | {问题} | {修复方式} |
```

6. 通过 `complete_delegation` 返回修复结果
   - 成功时需包含：服务名、工作分支、交付目录、测试文档、已修复问题列表、修复概要
   - 失败时需明确说明：失败原因、是否因缺少工作分支而中止
   - 推荐返回字段：`service`、`work_branch`、`deliverable`、`test_doc`、`fixed_bugs`、`summary`
   - `fixed_bugs` 必须与测试报告中的 `BUG ID` 一一对应，不要自行改写 ID
   - `fixed_bugs` 中每个对象建议包含：`id`、`title`、`related_case`、`fix`
   - `fixed_bugs` 只返回本轮实际已完成修复、并已提交到当前工作分支的 BUG
   - 未修复、部分修复但未达到可交付状态、无法复现、暂缓处理、或仍待确认的问题，不要放入 `fixed_bugs`
   - 如果本轮只修复了部分 BUG，`fixed_bugs` 只列出这部分；未完成项应在 `summary` 或 `error` 中单独说明

成功返回示例：

```json
{
  "service": "catstory",
  "work_branch": "feature/user-nickname_20260320",
  "deliverable": "2026-03-20_用户昵称功能",
  "test_doc": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md",
  "fixed_bugs": [
    {
      "id": "BUG-001",
      "title": "昵称长度超限时接口未返回预期错误",
      "related_case": "TC-001",
      "fix": "补充昵称长度校验并返回统一错误码"
    },
    {
      "id": "BUG-002",
      "title": "未登录访问资料接口返回 500",
      "related_case": "TC-004",
      "fix": "增加鉴权判空并返回 401"
    }
  ],
  "summary": "已修复 2 个测试问题，并在测试文档追加 Round 1 修复记录"
}
```

失败返回示例：

```json
{
  "service": "catstory",
  "work_branch": "",
  "deliverable": "2026-03-20_用户昵称功能",
  "test_doc": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md",
  "fixed_bugs": [],
  "summary": "缺少明确工作分支，未执行修复",
  "error": "委派消息和交付文档中都未提供可确认的工作分支，无法安全修改代码"
}
```

## 分支规则

- 本 skill 的目标是在已有工作分支上继续修复，不负责设计新的分支策略
- “工作分支”指该需求当前正在开发/联调/修复的业务分支
- 如果委派消息和交付文档中的工作分支不一致，以委派消息为准，并在结果中说明
- 未拿到明确工作分支时，禁止直接在 `main`、`master`、`staging`、`release` 等主干分支上修改
- 修复记录默认更新到测试文档 `test.md`，而不是开发文档 `dev.md`
