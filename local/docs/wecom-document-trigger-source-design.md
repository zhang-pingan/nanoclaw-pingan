# 个人助手企微/腾讯文档触发源方案

## 背景

个人助手当前的触发源主要分两类：

- 纯提醒类：例如今日计划缺失、工作台待处理项。
- 异常排查类：例如工作台任务失败、Agent 执行异常、线上 error 日志。

企微/腾讯文档触发源不适合直接归入这两类。新增或更新的文档可能代表一个需求、会议结论、设计方案、待确认事项或普通资料。个人助手不应该只提醒“有新文档”，也不应该把它当成异常自动排查，而应该把它定义成第三类：

**信息摄入 / 机会识别类触发源**。

核心目标是主动判断“这个文档是不是一件需要用户处理的事”，并给用户一个低成本确认入口，再接入今日计划、工作台任务或持续跟踪。

## 官方 API 可行性结论

优先考虑腾讯文档官方 Open API，而不是企业微信服务端 `wedoc` 接口。

### 腾讯文档 Open API

普通腾讯文档 Open API 支持 OAuth2 用户授权，接口调用需要用户维度的鉴权信息，适合实现“与我相关”的个人视角扫描。

可用能力包括：

- 文件列表、过滤、搜索。
- 文档元信息。
- 协作成员查询。
- 未读通知数量。
- 用户授权 token 获取和刷新。

相关官方文档：

- Open API 说明：https://docs.qq.com/open/document/app/openapi/v2
- OAuth 授权：https://docs.qq.com/open/document/app/oauth2/authorize.html
- 文件接口索引：https://docs.qq.com/open/document/app/openapi/v2/file/
- 列表过滤：https://docs.qq.com/open/document/app/openapi/v2/file/filter/filter.html
- 关键字搜索：https://docs.qq.com/open/document/app/openapi/v2/file/search/search.html
- 协作成员：https://docs.qq.com/open/document/app/openapi/v2/file/files/collaborators/get.html

### 腾讯文档 SaaS Open API

如果企业实际使用的是腾讯文档 SaaS/企业版，SaaS Open API 更贴近企业内文档中心场景。它支持企业自建应用操作企业下用户文档数据，并提供更直接的列表类型，例如 `MY_DOC`、`RECENT`、`STAR`、`COLLABORATION_LIST`、`SHARED`。

相关官方文档：

- SaaS 开放接口：https://docs.qq.com/open/document/saas/
- SaaS 文件接口：https://docs.qq.com/open/document/saas/openapi/file/
- SaaS 拉取文件列表：https://docs.qq.com/open/document/saas/openapi/file/list.html

### 企业微信 `wedoc` 接口

企业微信服务端 `wedoc` 接口更偏应用创建、管理文档、权限、分享链接和智能表等能力，不适合作为“枚举我相关文档”的主入口。这个触发源需要的是用户视角或企业用户视角的文档关系，因此更适合腾讯文档 Open API 或 SaaS Open API。

## “与我相关”的定义

MVP 中可以把“与我相关”定义为以下任一条件：

- 我拥有的文档。
- 我参与协作的文档。
- 最近共享给我的文档。
- 最近浏览或最近修改的文档。
- 文档评论、通知或待办中涉及我。
- 标题、目录或正文命中配置关键词，例如需求、PRD、评审、排期、验收、接口、方案、待确认。
- 文档协作者包含我负责的服务、项目或团队关键词。

后续可以根据用户反馈给不同来源加权，而不是硬编码所有文档都提醒。

## 完整流程

### 1. 发现

由宿主机程序实现。

宿主机负责：

- 定时扫描腾讯文档 API。
- 管理 OAuth token、刷新 token、调用频率和错误重试。
- 读取文档元信息、协作者、更新时间、未读通知等轻量信息。
- 按文档 ID、更新时间、版本号或通知 ID 去重。
- 记录已见过的文档状态。
- 决定是否进入预处理和分类。

发现阶段不调用群聊 Agent，也不启动工作台流程。

### 2. 预处理

建议通过轻量模型能力实现，但由宿主机编排。

输入可以包括：

- 文档标题。
- 文档 URL。
- owner、最近编辑人、协作者。
- 最近更新时间。
- 文档类型。
- 所在目录。
- 文档正文前几段或结构化标题。
- 评论或通知摘要。
- 是否直接 @ 我。

输出应为结构化 JSON，不做任何副作用。

示例字段：

```json
{
  "summary": "一句话摘要",
  "key_points": ["要点 1", "要点 2"],
  "mentioned_user": true,
  "possible_services": ["catstory"],
  "signals": ["shared_to_me", "contains_acceptance_criteria"]
}
```

### 3. 分类

建议走 client-api / 轻量模型结构化分类，而不是直接交给群聊 Agent。

分类目标是回答：这个文档是不是值得进入用户工作面？

输出示例：

```json
{
  "relevance": "high",
  "doc_kind": "requirement",
  "confidence": 0.86,
  "summary": "这是一个会员权益配置改版需求，包含背景、范围和验收项。",
  "why_related_to_me": "你是协作者，文档今天新增了验收标准。",
  "suggested_actions": ["create_workbench_draft", "add_to_today_plan", "watch_document"],
  "questions_for_user": ["是否按新需求进入评审流程？"],
  "candidate_services": ["catstory"]
}
```

分类枚举建议：

- `requirement`：需求候选。
- `meeting_notes`：会议纪要。
- `design`：设计或技术方案。
- `decision`：待确认或审批。
- `task_list`：任务清单。
- `reference`：普通资料。
- `unknown`：不确定。

client-api 与群聊 Agent 的边界：

- client-api 负责“这是不是一件事”。
- 群聊 Agent / 工作台 Agent 负责“这件事怎么推进”。

### 4. Inbox 生成

由宿主机程序实现。

Inbox 不应该只是“发现新文档”，而应该展示分类后的判断。

示例：

```text
标题：发现疑似新需求：会员权益配置改版
正文：张三今天 10:21 共享给你，文档中包含“需求背景 / 验收标准 / 排期”，可能需要进入需求处理。
```

可用动作：

- 查看摘要。
- 作为需求处理。
- 加入今日计划。
- 持续跟踪此文档。
- 标记为无关。
- 以后类似不提醒。

默认策略：

- 普通文档只进入 Inbox，不弹强提醒。
- 高置信需求、评论 @ 我、明确待确认事项可以触发个人助手气泡。
- 不自动创建工作台任务。
- 不自动启动研发流程。

### 5. 意图确认

意图确认先做成 Inbox 动作卡，不需要先设计复杂对话系统。

用户看到的是：

```text
我发现一个可能与你相关的新文档《会员权益配置改版》。
它看起来像需求文档，包含背景、范围和验收项。
要我把它纳入今天的工作面吗？
```

动作：

- `先总结`
- `作为需求处理`
- `只加入今日计划`
- `持续跟踪更新`
- `忽略`

这一步的原则是：个人助手可以主动发现和归纳，但“把它当作需求推进”的意图必须由用户确认。

### 6. 后续动作

MVP 先实现三条路径。

#### 作为需求处理

创建 Workbench 草稿，而不是直接启动流程。

草稿字段建议：

- `requirement_description`：模型摘要、关键点、待确认问题、原始文档链接。
- `requirement_files`：腾讯文档 URL。
- `source_type`：`tencent_document` 或 `wecom_document`。
- `source_ref_id`：文档 ID。
- `service`：模型候选服务，用户可修改。
- `workflow_type`：默认候选，例如 `dev_test`，用户确认后启动。

用户确认后再进入现有工作台流程。

#### 加入今日计划

新增今日计划 item。

字段建议：

- 标题来自文档标题。
- 描述来自模型摘要。
- 关联文档 URL。
- 关联文档 ID。
- 状态默认 `todo`。
- 来源标记为 `tencent_document`。

#### 持续跟踪

记录 watched document。

字段建议：

- 文档 ID。
- 文档 URL。
- 标题。
- watch reason。
- last seen updated_at / version。
- notify_on：`updated`、`comment`、`mention`、`ownership_change`。
- 用户反馈标签。

后续扫描时只有实质变化才生成新的 Inbox，例如：

- 文档新增验收标准。
- 有人评论 @ 我。
- owner 或协作者变化。
- 文档标题从草稿变成正式需求。
- 文档新增排期、风险、接口或服务名。

## 状态机

建议新增信息摄入类状态：

```text
detected
  -> classified
  -> awaiting_user_intent
  -> accepted
  -> converted_to_task

awaiting_user_intent
  -> watching
  -> dismissed

watching
  -> update_detected
  -> awaiting_user_intent
```

状态说明：

- `detected`：宿主机发现文档或文档更新。
- `classified`：模型完成预处理和分类。
- `awaiting_user_intent`：已生成 Inbox，等待用户选择。
- `accepted`：用户确认它是需要处理的事项。
- `converted_to_task`：已转为工作台任务草稿或正式任务。
- `watching`：持续跟踪，不立即处理。
- `dismissed`：用户标记无关。
- `update_detected`：被跟踪文档出现实质变化。

## 架构边界

### 宿主机程序负责

- API 调用。
- token 管理。
- 定时扫描。
- 去重。
- 状态持久化。
- 调用模型分类。
- Inbox 生成。
- 用户动作路由。
- 今日计划和工作台草稿创建。

### client-api / 轻量模型负责

- 文档摘要。
- 相关性判断。
- 文档类型分类。
- 提取候选服务、风险、待确认问题。
- 返回严格 JSON。

### 群聊 Agent / 工作台 Agent 负责

- 用户确认后的深入分析。
- 读取完整文档和上下文。
- 结合代码仓库、服务配置、历史工作台任务。
- 生成需求方案、评审问题或执行计划。
- 进入现有工作流。

## MVP 范围建议

第一阶段只做：

1. 腾讯文档 OAuth 授权和 token 保存。
2. 扫描“最近 / 协作 / 共享 / 关键词搜索”文档列表。
3. 读取文档元信息和有限正文摘要。
4. 通过轻量模型输出结构化分类。
5. 生成信息摄入类 Inbox。
6. 支持三个用户动作：
   - 作为需求处理：创建工作台草稿。
   - 加入今日计划。
   - 持续跟踪。
7. 支持忽略和负反馈。

暂不做：

- 自动启动工作台研发流程。
- 自动修改文档。
- 自动回复评论。
- 全量同步所有企业文档。
- RPA 抓网页。

## 待决策问题

- 当前企业实际使用的是普通腾讯文档 Open API，还是腾讯文档 SaaS/企业版？
- 是否允许个人用户 OAuth 授权？token 存储位置和加密策略是什么？
- “与我相关”的初始规则以哪些列表为准：最近、协作、共享、未读、关键词？
- 文档正文是否允许读取？如果允许，读取范围和脱敏策略是什么？
- 是否需要配置关注关键词、服务名、团队名、owner 白名单/黑名单？
- Workbench 草稿是否需要新增状态，还是复用现有创建任务弹窗？
- 今日计划 item 当前数据结构是否支持关联外部文档？
- 负反馈要按标题模式、owner、文件夹还是文档类型生效？

## 结论

这个触发源应该被设计为主动助手的信息摄入入口。它的价值不在于提醒“有新文档”，而在于主动判断文档是否代表一件事，并把它转成用户可确认、可跟踪、可进入工作台的工作对象。

最稳妥的实现路径是：

```text
宿主机发现和去重
  -> client-api 做摘要和分类
  -> 宿主机生成 Inbox
  -> 用户确认意图
  -> 今日计划 / Workbench 草稿 / 持续跟踪
  -> 必要时再启动 Agent 深入处理
```
