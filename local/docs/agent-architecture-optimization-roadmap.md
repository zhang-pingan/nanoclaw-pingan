# NanoClaw Agent 架构优化路线图

## 目标

将 NanoClaw 从“以群聊 agent 为核心的多渠道执行系统”升级成“以工作流、工作站和主动助手协同的个人 Agent OS”。

核心方向不是替换现有架构，而是在当前已经存在的群聊 agent、Web 工作站、飞书渠道、workflow、trace、memory、assistant inbox 基础上，补齐以下能力：

- 长任务可恢复：workflow 重启后可继续执行
- 多渠道一致：Web、飞书、个人助手都操作同一套任务和审批语义
- 主动助手可控：主动发现问题，但通过策略、反馈和审批降低噪音与风险
- 执行可审计：每次 agent 运行、工具调用、审批、产物和失败原因都可追踪
- 工具可治理：工具、资源、权限、上下文和副作用都有明确边界

---

## 1. 当前定位

### 1.1 群聊 Agent

当前底层以群聊 agent 作为核心大脑。群聊承担了：

- 用户自然语言入口
- Agent 执行上下文
- 多角色委派入口
- workflow 推进入口
- 历史消息与 session 载体

这个设计适合快速构建个人 agent 系统，但如果所有状态和决策都隐含在聊天上下文中，后续会遇到几个问题：

- 长任务中断后难以恢复
- 同一任务在 Web、飞书、助手三个入口之间语义不一致
- 审批、修复、委派、失败重试容易散落在渠道逻辑里
- 多 agent 委派容易变成自由文本协议，难以验收和回放

优化方向是：**保留群聊作为自然语言入口和 agent context，但把任务状态、工作流状态、审批状态、执行 trace 下沉到结构化运行时。**

### 1.2 Web 工作站

Web 客户端是本地工作站，定位应该是 Agent Cockpit，而不是单纯聊天窗口。

它应该承载：

- 所有进行中任务
- workflow 状态与阻塞点
- 审批与人工输入
- trace、日志、产物、diff、截图
- 今日计划、知识库、记忆、调度任务
- 高风险操作的本地确认

自然语言仍然重要，但在工作站中更理想的形态是：用户输入自然语言后，系统先生成可预览的执行计划、风险等级和需要的权限，再进入执行。

### 1.3 飞书渠道

飞书是远程移动端渠道，定位应是轻控制面。

适合放在飞书中的能力：

- 远程下命令
- 查看任务状态
- 接收异常通知
- 处理审批卡片
- 暂停、继续、取消、重试任务
- 触发排查或打开工作站链接

不建议让飞书承载复杂配置、长上下文讨论或完整工作台功能。飞书应该是 Web 工作站的移动补充，而不是第二个工作站。

### 1.4 个人助手

个人助手的目标是主动型 agent。当前方向可以理解为：

- 工作站：用户主动给 agent 下命令
- 个人助手：系统主动发现风险、机会和待处理事项

当前实现已经有规则扫描、assistant inbox、action log、调查/修复入口。下一步应从“规则扫描器”升级成“主动信号引擎”：

```text
sensors -> signal extraction -> priority scoring -> policy -> inbox -> investigation -> approval -> action
```

主动助手不能只追求多提醒，而应该追求：

- 提醒少但准
- 可解释为什么触发
- 可被用户反馈训练
- 自动动作有风险边界
- 所有动作可审计和可撤销

---

## 2. 总体架构优化

### 2.2 多 Agent 协作从自由文本转向类型化 handoff

当前群聊委派适合快速启动，但随着工作流增多，建议将委派协议结构化。

每个 handoff 应明确：

- 角色：developer / tester / reviewer / ops / researcher
- 输入 schema
- 可用技能或工具
- 预期产物
- 验收标准
- 失败分类
- 是否允许自动重试

示例：

```json
{
  "role": "developer",
  "skill": "dev-requirement",
  "input_schema": "dev_task_input_v1",
  "artifact_contract": "dev_output_v1",
  "allowed_tools": ["bash", "edit", "test_runner"],
  "success_criteria": [
    "代码改动完成",
    "相关测试通过",
    "产物文档写入指定路径"
  ],
  "failure_taxonomy": ["requirement_unclear", "test_failed", "blocked_by_dependency"]
}
```

---

## 4. Web 工作站优化

### 4.3 Human Input 统一渲染

Web 不应该特判每一种审批卡片，而应根据 interrupt schema 渲染：

- approve / reject / revise
- 文本输入
- 文件上传
- token 输入
- enum 选择
- checkbox
- 日期时间

这样未来新增 workflow state 时，Web 前端不用频繁加业务特判。

---

## 5. 飞书渠道优化

### 5.3 与 Interrupt 统一

飞书卡片按钮不应直接推进 workflow，而应调用统一 resume：

```text
Feishu card action -> card action router -> resumeWorkflowInterrupt()
```

飞书只负责渲染和收集输入，不拥有 workflow 业务逻辑。

---

## 6. 个人助手优化

### 6.1 主动信号引擎

当前 assistant 已有规则扫描。下一步建议拆分为：

1. sensors：采集任务、日志、计划、trace、日程、知识库变化
2. signal extraction：识别异常、机会、缺口、待办
3. priority scoring：计算重要性、紧急性、可信度、重复度
4. policy：根据主动等级、安静时间、用户偏好决定是否提醒
5. inbox：生成可处理卡片
6. investigation：可选自动排查
7. approval：必要时请求确认
8. action：执行低风险动作或创建任务

### 6.2 主动等级

建议让 `proactiveLevel` 真正进入策略：

- quiet：只提醒高风险和明确阻塞
- balanced：提醒高风险、今日计划缺口、长时间卡住、重要审批
- active：允许提出机会型建议，如整理文档、补测试、复盘失败、承接昨日计划

### 6.3 安静时间和冷却时间

建议在主动助手中加入：

- quiet hours
- per-rule cooldown
- per-source cooldown
- max daily notifications
- repeated event suppression
- digest mode

否则主动助手会很快变成通知噪音。

### 6.4 反馈闭环

每条主动建议都应支持用户反馈：

- useful
- not useful
- too often
- wrong priority
- mute this rule
- mute this source
- remind later

这些反馈要写入 assistant settings 或 memory，用于后续调整触发策略。

---

## 7. 安全分级

建议所有动作按风险分级：

| 等级 | 含义 | 示例 | 默认策略 |
| --- | --- | --- | --- |
| L0 | 只读 | 查状态、读日志、总结 trace | 可自动执行 |
| L1 | 草稿 | 生成计划、生成补丁建议、创建未执行任务 | 可自动执行 |
| L2 | 可回滚副作用 | 修改本地文件、重跑测试、创建分支 | Web 确认或低风险自动 |
| L3 | 外部副作用 | 发消息、部署、提交、调用线上系统 | 需要审批 |
| L4 | 高风险或破坏性 | 删除数据、重置分支、改权限、生产变更 | 默认禁止自动执行 |

飞书远程入口默认只允许 L0/L1 和 L3 审批，不直接执行高风险动作。Web 本地工作站可以根据用户确认放宽。

---

## 10. 参考资料

### Agent 架构和上下文工程

- Anthropic: Building effective agents  
  https://www.anthropic.com/engineering/building-effective-agents
- Anthropic: Effective context engineering for AI agents  
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### Durable Workflow / Human-in-the-loop

- LangGraph Durable Execution  
  https://docs.langchain.com/oss/javascript/langgraph/durable-execution
- LangGraph Interrupts  
  https://docs.langchain.com/oss/javascript/langgraph/interrupts
- LangGraph Persistence  
  https://docs.langchain.com/oss/javascript/langgraph/persistence

### Agent SDK 设计参考

- OpenAI Agents SDK: Handoffs  
  https://openai.github.io/openai-agents-js/guides/handoffs/
- OpenAI Agents SDK: Guardrails  
  https://openai.github.io/openai-agents-js/guides/guardrails/
- OpenAI Agents SDK: Tracing  
  https://openai.github.io/openai-agents-js/guides/tracing/
- OpenAI Agents SDK: Sessions  
  https://openai.github.io/openai-agents-js/guides/sessions/

### MCP

- MCP Specification Overview  
  https://modelcontextprotocol.io/specification/2025-06-18/basic/index
- MCP Tools  
  https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP Elicitation  
  https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation

### 主动助手产品形态

- OpenAI: Introducing ChatGPT Pulse  
  https://openai.com/index/introducing-chatgpt-pulse/
- OpenAI Help: Scheduled tasks in ChatGPT  
  https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
