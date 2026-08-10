# Icarus 待优化点

## 群组 Project Analysis 专用黑盒执行管线

**状态：待评估，暂不实施。**

### 背景

Project Analysis 可能由 Icarus 内部 Agent、托管的第三方 Executor，或外部 Agent 手工接力完成。不同平台拥有不同的工具、权限和执行机制，不适合要求所有 Executor 适配统一的 Agent 工具协议，也不应依赖工具调用检测来约束分析行为。

这里的“黑盒”只描述群组模块中 Project Analysis 对 Executor 的处理方式，不是 Icarus 全局执行模式，对 Workflow、Action、Run Once、普通 Agent 和其他业务模块没有影响。

### 优化目标

- 在群组模块内部建立专用的 `ProjectAnalysisExecutorAdapter` 边界。
- Project Analysis 只向 Executor 提供冻结、脱敏且受分析范围约束的 Analysis Package。
- Executor 只返回原始 Analysis Result；Icarus 不要求、检测或解释其内部使用的工具。
- 内部 Agent 可以通过 Adapter 复用现有 Run Once 基础设施，但不得改变 Run Once 的全局工具、权限、日志或执行语义。
- 外部 Executor 和手工接力使用相同的 Analysis Input/Result Contract，不要求适配 Icarus 专用工具。
- 托管和外部结果进入同一套 Host 校验流程，包括 Schema、run binding、snapshot、context hash、challenge、evidence、action 和 stale 校验。
- Executor 输出只能形成 Finding 和 proposed action，不能直接写入群组业务状态。
- 后续业务操作必须经过用户确认、Principal 权限、CAS、签名以及最终 Git/事件写入门禁。

### 建议边界

```text
Project Analysis
  -> 生成冻结 Analysis Package
  -> ProjectAnalysisExecutorAdapter
  -> 内部 Agent / 第三方 Executor / 外部手工接力
  -> 回收不可信的 Raw Result
  -> Host 统一校验
  -> 用户预览和确认
  -> 群组业务写入门禁
```

Adapter 的公共协议只包含分析运行标识、冻结快照绑定、Prompt、Package、执行状态和原始结果，不包含平台工具名称、Workflow Action、群组写入接口或 Git 提交能力。

### 非目标

- 不新增 Icarus 全局 `blackbox` 执行模式。
- 不统一 Bash、Read、Write、MCP 等平台工具。
- 不根据 Agent 工具调用进行分析级阻断、审计判定或提醒。
- 不修改普通 Executor、Workflow、Action、Run Once 或其他模块的现有行为。
- 不保证 Icarus 无法控制的外部执行环境不存在本地副作用；Icarus 只保证回传结果不能绕过 Host 门禁直接改变群组状态。

### 后续评估项

- Analysis Package 的大小上限、分页或分包策略。
- 内部 Agent 与不同第三方平台的 Adapter 成本。
- 执行超时、取消、重试、恢复和结果回收协议。
- 托管执行所需的最小挂载、临时目录和凭证暴露边界。
- 与现有 Project Analysis 状态机、审计记录和 UI 执行渠道的整合方式。
