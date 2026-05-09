# Human Input 统一渲染方案

## 背景

当前 Human Input 有三类入口：

1. 通用交互卡片：已有 `InteractiveCard` 抽象，由不同渠道渲染。
2. 工作台广播卡片：把 Workbench 待办广播到目标群或远程渠道。
3. Web 工作站 action item：任务详情中的待处理项面板。

目标不是再增加一套独立实现，而是收敛成：

```text
workflow_interrupt / request_human_input / ask_user_question / send_message
  -> WorkbenchActionItem
  -> HumanInputCard / InteractiveCard
  -> channel renderer 或 Web surface renderer
```

核心原则：

- 渠道实现负责投递和平台适配。
- surface wrapper 负责挂载位置和上下文。
- 卡片 DOM 渲染与 Human Input 模型只保留一套。

## 统一模型

所有人工输入、审批、提问都先归一化为同一个交互模型。模型应表达：

- approve / reject / revise
- 文本输入
- 文件上传
- token 输入
- enum 选择
- checkbox
- 日期时间
- 数字输入
- 表单校验错误
- submit action / resume action
- allowed actions / allowed channels

字段来源优先级：

1. workflow card DSL：负责文案、按钮标签、表单布局。
2. interrupt `resume_payload_schema`：负责字段结构和校验约束。
3. 默认生成逻辑：当没有 card DSL 时，根据 `allowed_actions + schema` 生成基础 UI。

runtime 仍是最终裁决方：

- `allowed_actions` 决定动作是否合法
- `allowed_channels` 决定渠道是否合法
- `resume_payload_schema` 决定 payload 是否有效
- UI 只负责渲染、收集输入、展示校验错误

## Web 复用方式

Web 工作站 action item 属于 Web 应用里的一个 surface，不需要伪装成聊天消息，也不需要强行走 `WebChannel.sendCard()` 投递链路。

但 Web 工作站和 Web 聊天应复用同一套核心 DOM renderer：

```text
InteractiveCard / HumanInputCard
  -> renderInteractiveCard(card, callbacks)
  -> buttons / fields / validation / loading / payload collection
```

Web 聊天 wrapper：

```text
WebSocket card event
  -> chat message wrapper
  -> renderInteractiveCard(card, {
       onAction: sendWs(card_action)
     })
```

Web 工作站 wrapper：

```text
task-detail.action_items
  -> workbench action item wrapper
  -> renderInteractiveCard(card, {
       onAction: POST /api/workbench/action-item
     })
```

两者复用：

- 按钮渲染
- 表单字段渲染
- enum / checkbox / date / datetime / number 校验
- submit payload 收集
- loading / disabled / error 状态

两者保留不同 wrapper：

- 聊天卡片保留消息气泡、消息 ID、聊天流状态
- 工作站 action item 保留待办标题、badge、排序、处理后刷新或移除

## 广播卡片

工作台广播卡片不应拥有独立业务分支。它应复用同一个 Human Input 模型：

```text
WorkbenchActionItem
  -> HumanInputCard / InteractiveCard
  -> sendCard(jid, card)
  -> 对应渠道 renderer
```

广播目标由 `WORKBENCH_BROADCAST_TARGETS` 决定。当前可以只配置飞书，但代码层面应保持多渠道：

- 飞书：`InteractiveCard -> Feishu native card`
- Web：`InteractiveCard -> Web card event`
- 不支持卡片的渠道：`InteractiveCard -> fallback text`

## 迁移步骤

1. 新增 `buildHumanInputCard(actionItem, task)` 适配层。
   - workflow interrupt 优先读取 card DSL 和 `resume_payload_schema`
   - request_human_input / ask_user_question 读取 `current_question`
   - send_message 生成确认/已读类动作
2. 抽出 Web 前端 `renderInteractiveCard(card, callbacks)`。
   - 复用现有聊天卡片 DOM 渲染逻辑
   - 将 `sendCardAction` 改成可注入 callback
3. Web 聊天使用 shared renderer。
4. Web 工作站 action item 使用 shared renderer。
   - 删除 `testing_confirm -> access_token` 等硬编码分支
   - action item wrapper 只负责外壳、排序、刷新
5. 工作台广播卡片改为调用同一个适配层。
   - 删除广播卡片里的 workflow state 特判
   - 保留文本 fallback
6. 飞书 card action 继续进入统一 action router。
   - `Feishu card action -> card action router -> resumeWorkflowInterrupt()`

## 验收标准

新增 workflow interrupt state 时，Web 前端不需要新增业务分支。只要配置：

```text
allowed_actions
resume_payload_schema
card/form
on_resume
```

即可在以下位置一致渲染和提交：

- Web 聊天卡片
- Web 工作站 action item
- 飞书广播卡片
- 文本 fallback

