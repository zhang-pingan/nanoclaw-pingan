# 个人助手自我进化方案

## 目标

个人助手新增一个受控的自我进化能力：系统可以基于项目模块定位、当前代码实现、历史运行状态和必要的网上资料，自动选择一个优化方向，先写方案，再在独立工作分支中实现、检查、复核。实现完成后进入待采纳状态，用户通过“采纳方案”按钮把工作分支合并到主分支。

第一版目标是让系统可以稳定地“小步自改”，而不是让 agent 无限制修改主分支。

## 模块定位

模块定位应放入自我进化技能中，作为每次选题、写方案、复核时必须读取的基准。

```text
Web 客户端
  - 透明控制台
  - 任务管理
  - 状态审计
  - 方案查看
  - diff、检查结果、复核结论展示
  - 采纳方案入口

个人助手
  - 主动发现优化方向
  - 写方案
  - 推进状态机
  - 生成提醒和摘要
  - 根据策略决定是否自动实现

移动端渠道
  - 轻量通知
  - 查看摘要
  - 暂停、继续、采纳等轻操作
  - 不承载复杂 diff 审查

容器 Agent
  - 隔离执行
  - 资料查询
  - 代码实现
  - 测试和检查
  - 复核和 bug 排查
```

## 开关模型

建议拆成三个开关，避免“开启自我进化”直接等价于“自动合并主分支”。

```json
{
  "evolution": {
    "enabled": false,
    "autoImplementEnabled": false,
    "autoAdoptEnabled": false,
    "scanIntervalMinutes": 60,
    "maxConcurrentItems": 1,
    "maxReviewRounds": 2,
    "allowedRiskLevel": "medium"
  }
}
```

语义：

- `enabled=false`：不运行自我进化。
- `enabled=true` 且 `autoImplementEnabled=false`：可以自动发现方向、写方案、评估方案，但实现前等待用户确认。
- `autoImplementEnabled=true`：可以自动创建分支、实现、检查、复核，但默认不合并主分支。
- `autoAdoptEnabled=true`：在低风险、检查通过、复核通过时允许自动合并主分支。第一版默认关闭。

推荐第一版默认策略：

```text
自动写方案：允许
自动实现到工作分支：可选
自动合并主分支：默认禁止
```

## Skill 设计

自我进化应做成一个技能，技能定义方法论和边界，核心程序负责状态机和权限控制。

建议目录：

```text
container/skills/self-evolution/
  SKILL.md
  references/
    module-positioning.md
    risk-policy.md
    proposal-template.md
    review-checklist.md
```

`SKILL.md` 只放核心流程：

- 每次只选择一个优化方向。
- 必须先写方案，再实现。
- 实现必须使用独立工作分支。
- 实现后必须运行检查和复核。
- 未进入采纳流程前不得合并主分支。
- 高风险事项必须标记为 `blocked_by_policy`。

详细内容放到 references：

- `module-positioning.md`：模块定位。
- `risk-policy.md`：低、中、高风险边界和禁止自动化事项。
- `proposal-template.md`：方案输出结构。
- `review-checklist.md`：实现度、bug、测试、回归风险复核清单。

## 能力边界

核心边界：

```text
程序控制流程和权限。
Skill 控制方法论和判断标准。
Agent 控制方案内容和代码实现。
```

程序负责：

- 读取设置。
- 定时触发。
- 获取 DB lease。
- 查询当前自我进化 item。
- 创建和更新状态。
- 创建工作分支。
- 调用内部 evolution runner。
- 固定检查命令。
- 记录事件、日志、trace。
- 采纳按钮触发合并。
- 标记完成、失败、暂停或策略阻断。

Skill 负责：

- 模块定位。
- 优化方向选择规则。
- 方案模板。
- 风险策略。
- 实现约束。
- 复核 checklist。
- 什么情况下必须停止或进入 `blocked_by_policy`。

Agent 负责：

- 读取代码和技能资料。
- 必要时查询网上资料。
- 选择一个优化方向。
- 写方案。
- 评估和完善方案。
- 在工作分支实现。
- 根据检查和复核反馈修复。
- 输出结构化结果。

分支控制、状态推进、主分支合并不交给 agent 自由处理，应由程序执行。

## 触发方式

第一版使用“轮询 + 手动触发”，不做复杂事件驱动。

触发源：

```text
1. 服务启动后延迟 tick 一次。
2. 定时轮询，比如每 30 到 60 分钟 tick 一次。
3. Web 或助手按钮手动“立即运行一次”。
4. 后续再扩展事件触发，比如测试失败、任务失败、用户反馈、长期未处理 inbox。
```

自我进化是低频长任务，不适合挂到普通消息循环里实时触发。建议新增独立的 `src/assistant/evolution-engine.ts`，结构可参考 `src/assistant/proactive-engine.ts`，但不要和普通提醒扫描耦合。

每次 tick 只推进一小步：

```text
tick
  -> 读取 assistant settings
  -> 如果 evolution.enabled=false，退出
  -> 尝试获取 evolution lock
  -> 如果 lock 被占用且未过期，退出
  -> 查询 active item
  -> 如果没有 active item，创建新方案
  -> 如果有 active item，按 status 推进一步
  -> 写事件和状态
  -> 释放或续约 lock
```

## 并发和跳过规则

默认同一时间只允许一个自我进化 item 被推进。

每次轮询开始：

```text
1. 如果 evolution.enabled=false，退出。
2. 尝试获取 evolution lock。
3. 如果 lock 已被占用且未过期，退出。
4. 查询 active item。
5. 如果 active item.status 属于 running 状态，退出。
6. 如果 active item.status 属于 waiting 或 retryable 状态，按规则推进它。
7. 如果没有 active item，创建新方案。
8. 释放 lock。
```

第一版不做 backlog。只要存在非 terminal item，就不创建新方案。

推荐 active item 查询：

```sql
SELECT *
FROM assistant_evolution_items
WHERE status NOT IN ('completed', 'failed', 'cancelled')
ORDER BY created_at ASC
LIMIT 1;
```

状态分类：

```text
running
  - discovering
  - proposal_drafting
  - proposal_evaluating
  - proposal_refining
  - branch_preparing
  - implementing
  - checking
  - reviewing
  - fixing
  - adopting

waiting
  - waiting_user_approval
  - ready_for_adoption
  - paused
  - blocked_by_policy
  - adoption_failed

terminal
  - completed
  - failed
  - cancelled
```

如果上一次轮询拉起的 agent 仍在运行，本次轮询必须跳过。lock 需要 TTL，比如 2 小时，避免进程崩溃后永久卡住。

## 状态机

推荐状态流转：

```text
idle
  -> discovering
  -> proposal_drafting
  -> proposal_evaluating
  -> proposal_refining
  -> waiting_user_approval
  -> branch_preparing
  -> implementing
  -> checking
  -> reviewing
  -> fixing
  -> checking
  -> reviewing
  -> ready_for_adoption
  -> adopting
  -> completed
```

自动实现开启时：

```text
proposal_refining
  -> branch_preparing
```

自动实现关闭时：

```text
proposal_refining
  -> waiting_user_approval
```

实现完成不等于完成。实现、检查、复核通过后进入 `ready_for_adoption`，只有采纳合并成功后才进入 `completed`。

异常流转：

```text
任意状态 -> paused
任意状态 -> failed
任意状态 -> blocked_by_policy
adopting -> adoption_failed
checking -> fixing
reviewing -> fixing
fixing 超过最大轮数 -> failed
```

复核轮数：

- 默认 `maxReviewRounds=2`。
- agent 可以返回 `review_complete=true` 提前结束。
- 达到最大复核轮数仍有问题，进入 `failed` 或 `ready_for_adoption_with_warnings`。第一版建议直接 `failed`。

## 数据库设计

主表：

```sql
CREATE TABLE IF NOT EXISTS assistant_evolution_items (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  module_scope TEXT NOT NULL,
  direction TEXT NOT NULL,
  proposal TEXT,
  proposal_evaluation TEXT,
  implementation_summary TEXT,
  check_summary TEXT,
  review_summary TEXT,
  bug_report TEXT,
  risk_level TEXT NOT NULL DEFAULT 'unknown',
  auto_implement INTEGER NOT NULL DEFAULT 0,
  auto_adopt INTEGER NOT NULL DEFAULT 0,
  review_round INTEGER NOT NULL DEFAULT 0,
  max_review_rounds INTEGER NOT NULL DEFAULT 2,
  base_branch TEXT NOT NULL DEFAULT 'main',
  work_branch TEXT,
  base_commit TEXT,
  head_commit TEXT,
  merge_commit TEXT,
  adoption_status TEXT,
  adoption_error TEXT,
  locked_by TEXT,
  lease_until TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

事件表：

```sql
CREATE TABLE IF NOT EXISTS assistant_evolution_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
```

可选产物表：

```sql
CREATE TABLE IF NOT EXISTS assistant_evolution_artifacts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  content TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
```

产物类型示例：

```text
proposal
proposal_evaluation
diff_summary
check_output
review_output
bugfix_summary
adoption_summary
```

## 分支策略

每个方案实现都使用独立工作分支。

```text
base_branch = main
work_branch = evolution/<itemId>-<slug>
```

程序创建分支：

```text
git status --porcelain
git checkout main
git checkout -b evolution/<itemId>-<slug>
```

规则：

- 一个 item 一个分支。
- 分支名不可复用。
- 实现前必须记录 `base_commit`。
- 实现后记录 `head_commit`。
- agent 只能在工作分支完成方案实现。
- 未采纳前不得合并主分支。
- 第一版不同时推进多个工作分支。

是否允许有用户未提交改动，需要实现时明确策略。推荐第一版保守处理：

- 主分支有未提交改动时，不创建工作分支，进入 `blocked_by_policy` 或 `failed`，提示用户处理。
- 工作分支实现中出现非 agent 预期改动时，停止推进并记录事件。

## 采纳方案

Web 客户端提供“采纳方案”按钮。按钮只对 `ready_for_adoption` 状态可用。

采纳流程由程序执行：

```text
1. 确认 item.status=ready_for_adoption。
2. 确认 work_branch 存在。
3. 确认工作分支没有未提交内容。
4. 切回 base_branch。
5. 合并 work_branch。
6. 在 base_branch 跑固定检查。
7. 成功则记录 merge_commit，标记 completed。
8. 失败则标记 adoption_failed，保留分支和错误日志。
```

推荐合并策略：

```text
git checkout main
git merge --no-ff evolution/<itemId>-<slug>
npm run typecheck
npm test
```

使用非快进合并，方便历史中追踪一次自我进化对应的 merge commit。

采纳失败时不自动强行解决冲突。状态进入 `adoption_failed`，后续可以由 agent 在工作分支合并最新 main、修复冲突、重新检查，再回到 `ready_for_adoption`。

## Agent 触发方式

不建议通过伪造一条助手主群聊天消息来触发自我进化。更合适的是新增内部短任务 runner，复用现有 `runContainerAgent`。

建议新增：

```text
src/assistant/evolution-runner.ts
```

调用路径：

```text
evolution-engine
  -> evolution-runner
  -> runContainerAgent(mainGroup, prompt, ...)
  -> agent 输出 JSON
  -> evolution-store 写 DB
```

执行目标使用助手主群或主群对应的 main group agent，因为它具备项目根目录访问能力，也符合“自我修改”的权限模型。但不要走聊天消息入口，避免污染消息历史，并且便于单独 trace、限流和结构化输出。

trace 建议：

```text
sourceType = assistant_evolution
sourceRefId = assistant_evolution_items.id
```

runner prompt 必须包含：

- 当前 item 状态。
- 当前分支和 commit 信息。
- 允许执行的任务。
- 必须使用 self-evolution skill。
- 必须输出 JSON。
- 不允许擅自合并主分支。

## Runner 输出契约

方案阶段输出：

```json
{
  "ok": true,
  "module_scope": "assistant",
  "direction": "优化方向",
  "risk_level": "low",
  "proposal": "方案正文",
  "requires_user_approval": false,
  "blocked_by_policy": false,
  "blocked_reason": null
}
```

评估阶段输出：

```json
{
  "ok": true,
  "approved_for_implementation": true,
  "risk_level": "low",
  "evaluation": "评估结论",
  "required_changes": [],
  "blocked_by_policy": false,
  "blocked_reason": null
}
```

实现阶段输出：

```json
{
  "ok": true,
  "implementation_summary": "实现摘要",
  "changed_files": ["src/example.ts"],
  "requires_followup": false
}
```

复核阶段输出：

```json
{
  "ok": true,
  "review_complete": true,
  "implementation_coverage": "方案实现度",
  "bug_report": null,
  "required_fixes": [],
  "risk_level": "low"
}
```

程序应校验 JSON 结构，不接受纯文本作为状态推进依据。

## 检查和复核

固定检查由程序执行，不能完全依赖 agent 自报。

第一版建议固定检查：

```text
npm run typecheck
npm test
```

如果变更只涉及文档，可以允许跳过测试，但必须记录跳过原因。

复核由 agent 执行，但程序控制轮数：

```text
checking 失败 -> fixing
reviewing 发现问题 -> fixing
fixing 完成 -> checking
checking 通过 -> reviewing
reviewing 通过 -> ready_for_adoption
超过 maxReviewRounds -> failed
```

复核重点：

- 方案是否完整实现。
- 是否引入明显 bug。
- 是否偏离模块定位。
- 是否越过权限边界。
- 是否有必要测试覆盖。
- 是否影响启动、构建、渠道、助手 UI。

## 风险策略

低风险可自动实现：

- 文档补充。
- 测试补齐。
- 日志和错误提示优化。
- UI 小修。
- 非核心路径的小 bug 修复。
- 只读分析和状态展示。

中风险可自动实现，但必须通过检查和复核：

- 助手状态机小改。
- Web 控制台交互调整。
- 新增 DB 表但不迁移删除旧数据。
- 新增低权限 API。

高风险必须阻断或等待人工确认：

- 删除数据。
- 修改权限模型。
- 修改容器隔离。
- 开放网络端口。
- 升级核心依赖。
- 修改启动项。
- 修改生产配置。
- 访问外部账号。
- 涉及密钥、凭据、token。
- 自动合并主分支且检查不完整。

高风险状态进入：

```text
blocked_by_policy
```

不应反复打扰用户，只生成 inbox 摘要和 Web 待处理项。

## Web 和助手交互

Web API 建议：

```text
GET  /api/assistant/evolution/state
GET  /api/assistant/evolution/items
GET  /api/assistant/evolution/items/:id
POST /api/assistant/evolution/settings
POST /api/assistant/evolution/tick
POST /api/assistant/evolution/items/:id/approve-implementation
POST /api/assistant/evolution/items/:id/pause
POST /api/assistant/evolution/items/:id/resume
POST /api/assistant/evolution/items/:id/adopt
POST /api/assistant/evolution/items/:id/cancel
```

Web 页面展示：

- 当前开关状态。
- 当前 active item。
- 状态流转时间线。
- 方案。
- 方案评估。
- 工作分支。
- changed files。
- 检查输出。
- 复核结论。
- 采纳按钮。
- 失败和阻断原因。

桌面助手展示：

- 是否有自我进化进行中。
- 是否有方案待确认。
- 是否有方案待采纳。
- 简短摘要。
- 打开 Web 详情。

移动端渠道：

- 接收摘要。
- 暂停、继续、采纳、打开详情。
- 不做复杂 diff 审查。

## 第一版实施步骤

建议分阶段实现。

第一阶段：文档和技能

- 新增 self-evolution skill。
- 固化模块定位、风险策略、方案模板、复核 checklist。
- 新增 settings 字段，但默认关闭。

第二阶段：DB 和状态机

- 新增 `assistant_evolution_items`。
- 新增 `assistant_evolution_events`。
- 新增 `evolution-store`。
- 新增 lock/lease。
- 新增手动 tick API。

第三阶段：runner

- 新增 `evolution-runner`。
- 复用 `runContainerAgent`。
- 绑定 `sourceType=assistant_evolution`。
- 要求 agent 输出 JSON。

第四阶段：分支实现

- 程序创建工作分支。
- agent 在工作分支实现。
- 程序运行检查。
- 程序记录 diff 和 head commit。

第五阶段：采纳

- Web 增加采纳按钮。
- 程序执行 merge。
- merge 后跑检查。
- 成功标记 completed。
- 失败标记 adoption_failed。

第六阶段：全自动扩展

- 开放 `autoImplementEnabled`。
- 严格限制 `autoAdoptEnabled`。
- 增加更多风险策略和回滚策略。

## 关键结论

推荐最终边界：

```text
触发方式：轮询为主，手动 tick 为辅。
并发策略：第一版同一时间只允许一个 active item。
状态判断：程序查表并推进状态。
分支控制：程序创建分支和合并分支。
Skill 边界：定义定位、模板、风险和复核标准。
Agent 边界：写方案、实现、修复、复核，不直接控制主分支采纳。
Agent 触发：内部 short evolution runner 复用主群 agent 能力，不伪造聊天消息。
完成标准：工作分支 ready_for_adoption 不算完成，采纳合并成功才 completed。
```
