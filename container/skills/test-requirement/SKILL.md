---
name: test-requirement
description: Use only in the dev_test workflow. Test implemented features in first-pass or regression mode — analyze delivery docs, execute staging verification, and update test reports.
---

# 需求测试 Skill

本技能仅用于 `dev_test` 工作流，不用于其他流程类型。

## 模式说明

本 skill 同时支持两种模式：

- 首测模式：首次对该需求进行完整测试，负责建立测试基线，生成或补全 `test.md`，并产出首轮测试报告
- 复测模式：在开发修复问题后，基于已有 `test.md`、历史 BUG 和修复记录执行回归验证，并追加新一轮测试结果

模式判断规则：

1. 如果任务上下文中包含历史 BUG、修复记录、`Round N`、或明确提到“修复后重新测试/回归测试/复测”，按复测模式执行
2. 如果测试文档 `test.md` 已存在，且其中已经包含测试报告或历史修复记录，优先按复测模式执行
3. 其他情况按首测模式执行

## 首测工作流程

### 1. 文档分析

1. 从任务描述中获取交付文档路径，阅读 `/workspace/projects/{服务名}/iteration/{文件夹名}/dev.md`，提取：
   - 需求描述与实现方案
   - 变更文件列表
   - 接口和数据库变更
   - 文档中的测试要点
   - 如任务中提供了 `access_token`，提取该值，并在后续接口测试中统一拼装为 `Authorization: Bearer {access_token}` 请求头
   - 优先采用任务消息中明确给出的 `主分支`、`预发分支`、`工作分支`、`预发工作分支`；若文档中的分支信息与消息不一致，以消息为准，并在测试报告中说明
2. 确认测试文档路径，优先使用任务中明确给出的 `测试文档：xxx`；若未给出，则默认使用 `/workspace/projects/{服务名}/iteration/{文件夹名}/test.md`
3. 阅读项目代码中对应的变更文件，理解实际实现
4. 如有不清楚或者缺失测试信息(比如接口需要登录鉴权，则需要提供 `access_token`，需要具体的业务id等)的地方，优先使用提问工具向用户确认：
   - 有明确选项的决策题（如是否继续测试、是否接受已知问题、是否覆盖某类回归范围）使用 `mcp__nanoclaw__ask_user_question`
   - 需要用户补充测试信息、验收口径等自由文本时，使用 `request_human_input`
   - 不要仅用 `mcp__nanoclaw__send_message` 做阻塞型确认

### 2. 测试用例生成

1. 根据文档和代码生成测试用例，并写入 `test.md`
2. 若 `test.md` 已存在但内容不完整，可在原文件内补全，不要创建多个测试文档
3. 测试用例格式如下，每条用例前必须有 `[ ]`

```text
*测试用例*

📋 测试需求：{需求名称}
📅 日期：{日期}

🔹 功能测试
- [ ] TC-001: {测试标题}
  前置条件：{条件}
  操作步骤：
  1. {步骤1}
  2. {步骤2}
  预期结果：{预期}
  优先级：P0/P1/P2

- [ ] TC-002: {测试标题}
  ...

🔹 边界测试
- [ ] TC-101: {测试标题}
  ...

🔹 异常测试
- [ ] TC-201: {测试标题}
  ...

🔹 兼容性/回归测试（如需）
- [ ] TC-301: {测试标题}
  ...
```

4. 测试用例生成并写入 `test.md` 后，使用 `mcp__nanoclaw__ask_user_question` 向用户确认是否按当前用例开始执行；若用户需要补充说明，可改用 `request_human_input`

### 3. 测试执行

1. 按用例逐条执行，综合以下手段验证：
   - *代码审查*：阅读变更代码确认逻辑正确性
   - *接口测试*：通过 `curl` 调用预发环境接口（`staging.domain`）验证请求和响应；若接口需要登录鉴权，优先使用任务中提供的 `access_token`，并显式拼装 `Authorization: Bearer {access_token}` 请求头。
   - *日志验证*：SSH 到 `staging.log_hosts`，查看 `staging.logs_info` 和 `staging.logs_error`
   - *数据库验证*：通过 MySQL 代理查询 `staging.mysql` 预发数据库，验证数据变更是否符合预期，注意预发表后缀加 `_gray`
2. 对每条用例记录结果，在 `[ ]` 框内直接标记：
   - 通过：`[x]`
   - 失败：`[!]`
   - 阻塞：`[-]`
3. 发现问题时，附上日志片段或数据库查询结果作为证据
4. 如果是缺失鉴权、业务id等非代码bug，使用 `request_human_input` 获取用户反馈后继续进行测试
5. 接口测试对于返回不报错，但某些预期应该有值但字段值为空的情况，不能全部视为通过，自行判断哪些字段是预期有值的情况；如果实在不确认的情况下使用`ask_user_question` 询问用户

### 4. 测试报告

1. 测试完成后，不新建独立测试报告文档，而是在同一个 `test.md` 中补充首轮“测试报告”
2. 示例路径：`/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md`
3. 测试报告格式示例：

```markdown
---
service: {服务名}
deliverable: {日期}_{需求简称}
main_branch: {主分支}
work_branch: {工作分支}
staging_base_branch: {预发分支}
staging_work_branch: {预发工作分支}
doc_type: test
---

# 测试报告

## 基本信息
- 需求名称：{名称}
- 测试日期：{日期}
- 测试环境：{staging.domain}
- 主分支：{主分支}
- 工作分支：{工作分支}
- 预发分支：{预发分支}
- 预发工作分支：{预发工作分支}
- 测试依据：{需求实现文档名}

## 测试概况
- 总用例数：{N}
- 通过：{N} ✅
- 失败：{N} ❌
- 阻塞：{N} ⚠️
- 通过率：{百分比}

## 失败用例详情

### BUG-001: {问题标题}
- 关联用例：TC-{xxx}
- 严重程度：严重/一般/轻微
- 问题描述：{具体描述}
- 复现步骤：
  1. {步骤}
- 预期行为：{预期}
- 实际行为：{实际}
- 涉及文件：{文件路径}
- 涉及代码：{关键代码片段或行号}

### BUG-002: ...

## 通过用例清单
| 编号 | 标题 | 结果 |
|------|------|------|
| TC-001 | {标题} | ✅ |
| TC-002 | {标题} | ❌ |

## 测试结论
{整体评估：是否可以发布，还需要修复哪些问题}
```

### 5. 返回结果

1. 保存报告后，在群内发送测试概况和失败用例摘要
2. 如果存在失败用例，告知用户：“共发现 {N} 个问题，详见测试报告。建议将问题反馈给开发群进行修复。”
3. 调用 `complete_delegation` 返回结果：
   - 测试已执行完成并得出业务结论时，统一使用 `outcome=success`
   - `outcome=failure` 只用于执行层失败或阻塞，例如：缺少关键鉴权信息且无法继续、预发环境不可用、工具异常、测试报告无法形成
4. result JSON 应包含：`total`、`passed`、`failed`、`blocked`、`bugs`、`deliverable`、`main_branch`、`work_branch`、`staging_base_branch`、`staging_work_branch`、`test_doc`、`verdict`、`summary`、`findings`、`evidence`
   - `deliverable` 是文件夹名，不含 `.md` 后缀
   - `bugs` 中每个对象建议包含：`id`、`title`、`severity`、`related_case`
   - `id` 必须与测试报告中的 BUG 编号一致，例如 `BUG-001`
   - `related_case` 建议填写对应测试用例编号，例如 `TC-001`
   - `severity` 使用 `critical | high | medium | low`
   - 全部通过时使用 `verdict=passed`
   - 只要存在失败用例或 bug，使用 `verdict=failed`
   - 信息不足、环境阻塞但已经形成结构化阶段结论时，使用 `verdict=pending`

全部通过返回示例：

```json
{
  "total": 10,
  "passed": 10,
  "failed": 0,
  "blocked": 0,
  "bugs": [],
  "deliverable": "2026-03-20_用户昵称功能",
  "main_branch": "已确认主分支",
  "work_branch": "已确认工作分支",
  "staging_base_branch": "已确认预发分支",
  "staging_work_branch": "已确认预发工作分支",
  "test_doc": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md",
  "verdict": "passed",
  "summary": "共 10 条，通过 10 条，失败 0 条，阻塞 0 条",
  "findings": [],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md",
      "summary": "已写入测试报告"
    }
  ]
}
```

存在失败用例返回示例：

```json
{
  "total": 10,
  "passed": 8,
  "failed": 2,
  "blocked": 0,
  "bugs": [
    {
      "id": "BUG-001",
      "title": "昵称长度超限时接口未返回预期错误",
      "severity": "high",
      "related_case": "TC-001"
    },
    {
      "id": "BUG-002",
      "title": "未登录访问资料接口返回 500",
      "severity": "medium",
      "related_case": "TC-004"
    }
  ],
  "deliverable": "2026-03-20_用户昵称功能",
  "main_branch": "已确认主分支",
  "work_branch": "已确认工作分支",
  "staging_base_branch": "已确认预发分支",
  "staging_work_branch": "已确认预发工作分支",
  "test_doc": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md",
  "verdict": "failed",
  "summary": "共 10 条，通过 8 条，失败 2 条，阻塞 0 条",
  "findings": [
    {
      "code": "bug_detected",
      "severity": "high",
      "message": "BUG-001 昵称长度超限时接口未返回预期错误。",
      "stageKey": "testing",
      "path": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md",
      "suggestion": "修复昵称长度校验与错误码返回。"
    }
  ],
  "evidence": [
    {
      "type": "artifact",
      "path": "/workspace/projects/catstory/iteration/2026-03-20_用户昵称功能/test.md",
      "summary": "测试报告中记录了 2 个失败用例"
    }
  ]
}
```

返回结果中的 `main_branch`、`work_branch`、`staging_base_branch`、`staging_work_branch` 必须沿用当前任务已确认的真实值；若任务消息已提供，则优先原样返回，不要替换成示例里的默认命名。

## 复测工作流程

### 1. 复测准备

1. 从任务描述中确认：
   - 交付文档 `dev.md`
   - 测试文档 `test.md`
   - 主分支、预发分支、工作分支、预发工作分支（若消息中提供）
   - 如有提供，读取 `access_token`
   - 如有提供，读取历史测试结果中的 BUG 列表和修复记录
2. 读取已有 `test.md`，重点提取：
   - 上一轮失败的 BUG 列表
   - 每个 BUG 的 `BUG ID`、`关联用例`、严重程度、复现步骤
   - 开发写回的“修复记录”
   - 需要优先回归的受影响功能点
3. 阅读最新代码变更，确认开发实际修复内容

### 2. 复测用例整理

1. 不要推翻已有测试用例
2. 优先复用已有 `test.md` 中的失败用例和关键回归用例
3. 如修复影响到新的模块或边界场景，可在原 `test.md` 中补充新的回归用例
4. 复测关注重点应依次为：
   - 上一轮失败用例对应的回归验证
   - 开发已声明修复的 `BUG ID` 对应验证
   - 与修复点直接相关的影响面回归
   - 必要的冒烟测试

### 3. 复测执行

1. 使用与首测相同的验证手段执行回归验证：
   - 代码审查
   - 接口测试
   - 日志验证
   - 数据库验证
2. 对复测涉及的用例更新执行结果
3. 若“旧问题未修复”，必须沿用原 `BUG ID`
4. 若发现“新的问题”，再新增新的 `BUG ID`
5. 所有结论都要有可追溯证据

### 4. 复测报告

1. 保留原有 `test.md` 内容，不覆盖上一轮报告
2. 在原文件末尾追加新的“Round N 复测结果”或“Round N 回归结果”
3. 建议格式如下：

```markdown
# Round {N} 复测结果

## 回归范围
- BUG-001 / TC-001
- BUG-002 / TC-004

## 回归结果
- BUG-001：已修复 / 未修复
- BUG-002：已修复 / 未修复

## 新发现问题
- 无

## 本轮结论
{是否通过复测，是否还需继续修复}
```

### 5. 返回结果

1. 保存复测结果后，在群内发送本轮回归概况和未通过问题摘要
2. 调用 `complete_delegation` 返回结果：
   - 复测已执行完成并得出结论时，统一使用 `outcome=success`
   - `outcome=failure` 只用于执行层失败或阻塞
3. result JSON 仍应包含：`total`、`passed`、`failed`、`blocked`、`bugs`、`deliverable`、`main_branch`、`work_branch`、`staging_base_branch`、`staging_work_branch`、`test_doc`、`verdict`、`summary`、`findings`、`evidence`
4. 复测模式下的额外要求：
   - 对“旧问题未修复”的情况，必须继续使用原 `BUG ID`
   - 对“已修复”的问题，不要继续保留在 `bugs` 中
   - `bugs` 只返回本轮仍未通过或新发现的问题

## 通用规则

- *基于代码验证*：不仅看文档描述，要读实际代码确认实现是否正确
- *覆盖边界情况*：空值、极端值、并发、权限等边界场景必须覆盖
- *鉴权不可省略*：涉及受保护接口时，执行接口测试前先从任务描述中提取 `access_token`，并在所有相关 `curl` 请求中携带拼装后的 `Authorization: Bearer {access_token}` 请求头
- *问题描述精准*：每个 bug 都要有明确的复现步骤和预期/实际对比
- *回归意识*：关注变更是否影响已有功能，必要时补充回归用例
- *首测复测一体化*：首测负责建立基线，复测负责沿用基线并验证修复结果，不要把复测当成全新需求测试
