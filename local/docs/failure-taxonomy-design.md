# NanoClaw Failure Taxonomy 设计

## 目标

把系统从“只记录 error string”升级为“记录结构化失败类型”。

目标不是替代原始错误文本，而是让错误具备：

- 可聚合
- 可回归
- 可统计
- 可重试决策
- 可用于 workflow 打回 / 暂停 / 告警

---

## 为什么只存 error string 不够

只存字符串时，会遇到这些问题：

- 同一类错误因为文案不同而无法聚合
- 无法区分“应该重试”还是“不应重试”
- 无法知道最近失败是模型问题还是 harness 问题
- 无法评估某次优化到底减少了哪一类失败
- 无法稳定驱动自动化动作

因此 failure taxonomy 是 Harness Engineering 的基础设施，而不是日志美化。

---

## 设计原则

- 保留原始 `error_message`
- 增加标准化 `failure_type`
- `failure_type` 必须稳定、有限、可统计
- 允许通过 `failure_subtype` 扩展细节
- 区分系统错误与业务 verdict

---

## 一级 failure taxonomy

建议第一版采用以下一级分类：

- `model_api_error`
- `model_output_invalid`
- `tool_error`
- `tool_contract_error`
- `sandbox_error`
- `container_runtime_error`
- `timeout`
- `routing_error`
- `state_transition_error`
- `workflow_transition_error`
- `evaluation_failed`
- `invalid_input`
- `invalid_config`
- `permission_error`
- `db_error`
- `unknown_error`

---

## 分类定义

### `model_api_error`

适用场景：

- 调模型接口返回非 2xx
- 上游 API timeout
- SSE 流异常中断

不适用：

- 模型返回了 200，但内容结构不合法

### `model_output_invalid`

适用场景：

- 模型返回内容无法解析
- 必要结构缺失
- 返回结果违反约定 contract

### `tool_error`

适用场景：

- 工具本身执行失败
- 外部依赖异常

例子：

- Web fetch 超时
- 文件读取失败
- MCP server 执行失败

### `tool_contract_error`

适用场景：

- 工具返回结构不符合预期
- harness 与工具之间 contract 不一致

### `sandbox_error`

适用场景：

- 沙箱拒绝访问
- 权限策略阻止执行
- 容器内外路径访问被拒绝

### `container_runtime_error`

适用场景：

- container 启动失败
- runtime 不可用
- 容器异常退出

### `timeout`

适用场景：

- agent 执行超时
- tool 调用超时
- container idle/overall timeout

### `routing_error`

适用场景：

- 找不到 channel
- JID 归属解析错误
- 消息无法路由到正确 chat/channel

### `state_transition_error`

适用场景：

- 一般状态机迁移错误
- 当前状态下执行了不允许动作

### `workflow_transition_error`

适用场景：

- workflow stage 迁移异常
- stage 配置缺失
- delegation 完成后无法进入预期阶段

### `evaluation_failed`

适用场景：

- stage evaluator 本身执行异常
- 评测器读取 artifact 时出错
- LLM judge 执行异常

注意：这不等于评测“不通过”。  
“不通过”属于业务 verdict，不是系统 failure。

### `invalid_input`

适用场景：

- 非法 group folder
- 缺少必要参数
- 输入结构不完整

### `invalid_config`

适用场景：

- 环境变量缺失
- workflow config / skills config 不完整
- runtime 配置错误

### `permission_error`

适用场景：

- 当前用户或上下文无权限执行操作

### `db_error`

适用场景：

- SQLite 读写失败
- migration 异常
- 事务失败

### `unknown_error`

适用场景：

- 无法归类的兜底错误

---

## 建议扩展字段

在 `agent_runs`、`task_run_logs`、部分 workflow 评测记录中，建议增加：

```ts
failure_type
failure_subtype
failure_origin
failure_retryable
failure_details_json
```

### 字段定义

- `failure_type`
  - 一级分类，必须稳定
- `failure_subtype`
  - 二级分类，用于模块细分
- `failure_origin`
  - 发生源头，如 `model` / `tool` / `workflow` / `container`
- `failure_retryable`
  - 是否适合自动重试
- `failure_details_json`
  - 附加结构化上下文

---

## 建议的来源枚举

`failure_origin` 建议限定为：

- `model`
- `tool`
- `scheduler`
- `workflow`
- `router`
- `container`
- `db`
- `web`
- `system`

---

## 建议的分类函数

统一由分类函数产出，避免各模块手写自由字符串。

```ts
export interface ClassifiedFailure {
  failureType: string;
  failureSubtype?: string;
  failureOrigin: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function classifyFailure(
  err: unknown,
  context: {
    module: string;
    action?: string;
    workflowId?: string;
    stageKey?: string;
  },
): ClassifiedFailure
```

---

## 建议的映射规则

### `src/agent-api.ts`

- 非 2xx -> `model_api_error`
- 返回结构无法解析 -> `model_output_invalid`
- fetch timeout -> `timeout`

### `src/container-runner.ts`

- runtime 启动失败 -> `container_runtime_error`
- sandbox 拒绝 -> `sandbox_error`
- 容器超时 -> `timeout`
- tool 结果结构异常 -> `tool_contract_error`

### `src/task-scheduler.ts`

- 非法 group folder -> `invalid_input`
- 任务执行超时 -> `timeout`
- 运行容器失败 -> `container_runtime_error`

### `src/workflow.ts`

- 缺失目标状态 -> `workflow_transition_error`
- evaluator 崩溃 -> `evaluation_failed`
- 非法 workflow config -> `invalid_config`

### `src/index.ts`

- 找不到 channel -> `routing_error`
- 输入缺字段 -> `invalid_input`

---

## 重试策略建议

可以基于 taxonomy 做统一重试决策。

### 默认可重试

- `model_api_error`
- `timeout`
- `container_runtime_error`（视具体 subtype）
- `tool_error`（部分外部依赖类）

### 默认不可重试

- `invalid_input`
- `invalid_config`
- `permission_error`
- `workflow_transition_error`
- `tool_contract_error`

---

## 与业务 verdict 的边界

要明确区分：

- 系统 failure
- 业务未通过

例如：

- 测试报告显示 5 个 case failed
  - 这是业务结论，不是 `failure_type=failed_tests`
- 测试报告文件不存在，导致 evaluator 无法读取
  - 这是 `evaluation_failed` 或 `invalid_input`

不要把业务失败和系统失败混在一起。

---

## 指标建议

基于 taxonomy，建议增加这些报表：

- 各 `failure_type` 近 7 天趋势
- 各 stage 的 `failure_type` 分布
- 各模型对应的失败类型分布
- 各 group / workflow type 的失败类型分布
- retryable vs non-retryable 占比

---

## 回归测试建议

建议新增 invariant tests，确保同一类错误始终映射到相同 taxonomy。

例子：

- 非法 group folder 总是 -> `invalid_input`
- 找不到 channel 总是 -> `routing_error`
- fetch 非 2xx 总是 -> `model_api_error`
- workflow 缺失状态迁移总是 -> `workflow_transition_error`

---

## 第一版实现顺序

### Phase 1

- 定义枚举和 `classifyFailure()`
- 在 `src/agent-api.ts`、`src/task-scheduler.ts`、`src/container-runner.ts` 接入
- `agent_runs` 增加 `failure_type`

### Phase 2

- 增加 `failure_subtype`、`failure_origin`、`failure_retryable`
- 接入 workflow evaluator
- 增加基础报表

### Phase 3

- replay/eval 使用 taxonomy 做对比
- 自动重试和自动暂停逻辑接入 taxonomy

---

## 最小成功标准

如果满足以下条件，就说明 failure taxonomy 基本落地：

- 主要错误不再只依赖字符串搜索
- 至少 80% 常见失败能归入稳定 `failure_type`
- retryable 与 non-retryable 能区分
- UI 或报表能看到失败类型分布
