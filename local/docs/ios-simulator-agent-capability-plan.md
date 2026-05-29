# iOS Simulator Agent Capability 方案

## 背景

现有 `iOS App Product Recon 与 Acceptance Harness` 方案已经确定了一个重要边界：容器 agent 不直接控制 Mac，宿主机通过受控 MCP 工具提供 iOS Simulator 操作、证据采集和报告生成能力。

本方案进一步收敛到更底层的问题：如何把“agent 可以操作 iOS Simulator”做成可复现、可审计、可支撑决策的基础能力。

这项能力要服务三个核心诉求：

- 面对需求时，agent 可以基于真实 App 行为理解业务全貌，而不是只阅读代码库。
- agent 可以基于 App 行为、网络调用、客户端代码和服务端代码判断本次需求是否涉及客户端或服务端改动。
- agent 可以基于真实行为生成完整测试用例，并执行可自动化部分，输出可追溯验收证据。

## 定位

本方案是 iOS App Recon / Acceptance Harness 的前置能力层。

它不先绑定某个 workflow 阶段，而是定义一组稳定的能力契约：

```text
agent
  -> ios simulator capability tools
    -> prepare/session
    -> observe
    -> act
    -> trace
    -> assert/report
  -> structured evidence
  -> claims
  -> product recon / impact analysis / test plan / acceptance report
```

后续 workflow 可以在 plan 前、开发前、测试前或质量门阶段调用这套能力，但第一版重点不是决定接入哪个环节，而是确保能力本身可靠。

## 两层划分：底座能力 vs 编排能力

本方案显式分两层，**本次只实现「底座能力」**：

- **底座能力（本次实现）**：一组无状态、可独立调用的 MCP 工具 + 宿主机执行 + evidence/claim 存储 + 脱敏与引用完整性护栏。它不规定"按什么顺序调、提炼什么结论、判断改哪端"，只保证每个工具可操作、每条产物可追溯、敏感信息已脱敏。
  - 范围：能力分层（Prepare/Observe/Act/Trace/Assert）、MCP 工具草案、Evidence 与 Claim 模型、安全与权限、`clients.ios` 服务配置、技术选型、`src/app-recon/` 模块清单。
- **编排能力（暂不实现，留作设计参考）**：把底座工具按业务意图串成 agent 行为，并嵌入工作流。`Product Recon → Claim → Impact Analysis → Test Plan → Acceptance` 这条链属于此层——它是某个委派节点 + skill prompt 的职责，不是底座。
  - 范围：Product Recon / Impact Analysis / Test Plan 产物、Agent 使用流程、与 Context Pack / Quality Gate 关系、Phase 6 工作流接入。
  - **本次不实现，具体如何嵌入工作流待定。** 文档保留这部分是为了让底座的工具设计不偏离最终用途，不代表本次交付。

底座与编排的护栏边界（贯穿全文）：**凡是"防止 agent 幻觉破坏可追溯性、或泄漏敏感信息"的机械护栏，放底座；凡是需要语义判断的（结论对不对、改哪端、用例怎么设计），归编排。**

下文章节标题会标注 `[底座]` 或 `[编排·暂不实现]`，以示范围。

## 目标

- 让 agent 能稳定启动、观察、操作和恢复 iOS Simulator 中的 App。
- 每个观察和动作都自动生成结构化 evidence。
- 每个业务结论都必须通过 claim 引用 evidence，而不是只依赖自然语言描述。
- 支持从 UI 行为关联到 API 调用、iOS 客户端代码和服务端接口。
- 支持生成端/服影响判断。
- 支持生成测试计划、执行测试用例和输出验收报告。

## 非目标

- 不把 SSH、shell 或通用远程控制能力作为正式 Product Recon / Acceptance Harness 的主路径；调试逃生口只服务 harness 开发和宿主机环境排障。
- 不第一版覆盖 Android、Web、真机。
- 不第一版追求完整 RPA 或复杂视觉推理。
- 不把自由探索结果直接作为测试通过依据。
- 不用未脱敏的网络请求、日志或源码片段作为 evidence 输出。
- 不自动修改 iOS 客户端代码；客户端改动只作为影响判断或 open question 输出。

## 设计原则

- **工具可操作，结论可证明**：tap/type/scroll 只是动作，只有 claim + evidence 才能支撑后续 agent 决策。
- **观察和动作成对记录**：每个 action 都记录前置 observe、执行细节、等待条件、后置 observe 和异常。
- **优先结构化，不依赖截图识别**：优先 accessibility tree、UI tree、network log、app log、源码索引；截图作为补充证据。
- **探索和验收分离**：探索可以自由，但验收通过只能来自明确 test case 和 assertion。
- **端/服影响显式建模**：不让 plan agent 从散乱观察中自行猜测是否需要改客户端或服务端。
- **宿主机执行，容器调用**：Xcode、Simulator、Appium/XCUITest、iOS 源码读取和 evidence 存储均在宿主机侧执行。

## 能力分层 [底座]

### 1. Prepare / Session

负责创建可审计的 iOS App 操作会话。

能力：

- 读取服务配置中的 iOS client 信息。
- 选择、启动和锁定 Simulator。
- 构建、安装、启动 App。
- 注入 launch args、环境、测试 token 或测试账号。
- 清理 App container、Keychain、UserDefaults、缓存和权限。
- 记录 App build、bundle id、scheme、git revision、backend env、base URL。

核心输出：

- `SESSION-*`：会话证据。
- `BUILD-*`：App build 和环境证据。
- `STATE-*`：初始状态或重置状态证据。

### 2. Observe

负责把当前 App 状态转换成 agent 可理解的结构化观察。

能力：

- 截图。
- 获取 accessibility tree / UI tree / page source。
- 提取可交互元素。
- 识别 screen/page。
- 记录键盘、系统弹窗、权限弹窗、loading、toast、网络请求游标。
- 给元素生成稳定 ref。

核心输出：

```json
{
  "id": "OBS-001",
  "session_id": "SESSION-001",
  "screen": {
    "id": "SCREEN-001",
    "name": "ProfileEdit",
    "title": "编辑资料",
    "route_hint": "catstory://profile/edit"
  },
  "artifacts": {
    "screenshot": "SCREENSHOT-001",
    "ui_tree": "UI-001"
  },
  "elements": [
    {
      "ref": "@ios-12",
      "type": "XCUIElementTypeTextField",
      "label": "昵称",
      "identifier": "profile.nickname.input",
      "enabled": true,
      "visible": true,
      "clickable": true,
      "frame": {"x": 24, "y": 160, "width": 320, "height": 44}
    }
  ],
  "network_cursor": "NET-CURSOR-001",
  "app_state": {
    "keyboard_visible": false,
    "system_alert_visible": false,
    "loading": false
  },
  "evidence": ["SCREEN-001", "SCREENSHOT-001", "UI-001"]
}
```

### 3. Act

负责执行可复现动作，并自动关联动作前后的观察。

基础动作：

- `tap`
- `type`
- `scroll`
- `back`
- `home`
- `terminate`
- `relaunch`
- `deeplink`
- `wait`
- `dismiss_keyboard`
- `handle_system_alert`

动作目标：

- accessibility identifier。
- observe 中的 element ref。
- label/text。
- element path。
- 坐标兜底。

每个动作必须记录：

- action 前 observe。
- 使用的 locator 和 locator 是否唯一。
- fallback 过程。
- 输入内容的脱敏摘要。
- 等待条件。
- action 后 observe。
- action 时间窗口。
- 失败原因。

示例输出：

```json
{
  "id": "ACT-003",
  "type": "tap",
  "target": {
    "strategy": "accessibility_id",
    "value": "profile.save.button",
    "matched_count": 1
  },
  "before": "OBS-002",
  "after": "OBS-003",
  "wait": {
    "type": "network_idle",
    "timeout_ms": 5000,
    "result": "satisfied"
  },
  "time_window": {
    "started_at": "2026-05-28T10:00:00.000Z",
    "ended_at": "2026-05-28T10:00:02.200Z"
  },
  "status": "success",
  "evidence": ["ACT-003", "OBS-002", "OBS-003"]
}
```

### 4. Trace

负责把 UI 行为和工程实现关联起来。

能力：

- 读取 Debug/Staging build 输出的网络 JSONL。
- 读取 App log。
- 收集 crash log。
- 搜索 iOS 客户端源码。
- 搜索服务端 route/controller/service。
- 将 action 时间窗口和 network event 关联。
- 将 network event 和客户端 API client、ViewModel、服务端 route 关联。

网络日志要求：

- 包含 request id 或 trace id。
- 包含 method、path、status、latency、base URL、env。
- 包含脱敏后的 request / response summary。
- 能按 session、flow、action、时间窗口过滤。
- 不记录 token、cookie、完整手机号、身份证、精确定位等敏感字段。

核心输出：

- `NET-*`：网络请求证据。
- `APPLOG-*`：App 日志证据。
- `CRASH-*`：崩溃证据。
- `CLIENT_CODE-*`：iOS 客户端代码证据。
- `SERVER_CODE-*`：服务端代码证据。

### 5. Assert / Report

负责把执行结果转换成测试断言、业务结论和报告。

能力：

- UI 断言：文本出现/消失、元素存在/不存在、按钮 enabled/disabled、输入值、页面标题。
- 网络断言：API 是否触发、method/path/status、请求字段、响应字段、不应触发的 API。
- 状态断言：重启后状态、刷新后状态、缓存状态。
- 崩溃断言：用例执行期间无 crash。
- 报告生成：product recon、impact analysis、test plan、acceptance report。

## MCP 工具草案 [底座]

第一版继续采用“agent 可见具名 MCP，宿主机内部统一 dispatcher”的设计。

> 承载层设计取舍（有意偏离现有模式）：现有宿主机工具是“一工具一 IPC type”，每个工具在 `src/ipc.ts` 有独立 case 和独立结果目录（如 `desktop_capture`、`run_local_host_script`、`ai_image_generate_image`）。本方案有意收敛为单一 `ios_app_request` 承载协议，用 `action` 区分动作。原因是这一组工具共享 session、Simulator 资源锁、evidence store 和脱敏逻辑；若拆成十余个独立 IPC type，这些公共状态会被复制十余份。容器侧仍按具名工具暴露（保留清晰语义、独立 schema、可读 Trace 和按工具授权），只有宿主机承载层统一。这是相对 CLAUDE.md “优先现有模式”的刻意例外。

```text
Agent 可见工具（底座，本次实现）
  ios_app_prepare_session
  ios_app_observe
  ios_app_act
  ios_app_run_flow
  ios_app_read_trace
  ios_app_search_code
  ios_app_write_claims        # 存 claim + 校验 evidence 引用（内容由编排决定）
  ios_app_run_test_case       # 执行给定用例 + 断言（用例内容由编排提供）
  ios_app_write_report        # 通用结构化写盘 + 脱敏 + 字段/引用校验
  ios_host_debug_shell

编排层工具（暂不实现）
  ios_app_generate_test_plan  # 生成 ios-test-plan.json 的"内容"，属语义判断

宿主机内部
  ios_app_request dispatcher
    -> prepare_session
    -> observe
    -> act
    -> read_trace
    -> search_code
    -> write_report
    -> debug_shell
```

### ios_host_debug_shell

`ios_host_debug_shell` 是调试逃生口，不是正式业务能力接口。

适用场景：

- 验证 `xcrun simctl`、`xcodebuild`、Appium/XCUITest、网络日志和 evidence store 是否可用。
- 排查宿主机环境问题，例如 Simulator 启动失败、Appium session 创建失败、DerivedData 异常、App 安装失败。
- 临时读取 harness 自身日志或宿主机侧调度器日志。
- 在 MCP schema 尚未覆盖某个底层能力时，快速验证是否值得产品化为正式 `ios_app_*` 工具。

不适用场景：

- 不作为 Product Recon 的常规观察手段。
- 不作为 Acceptance Harness 的常规执行手段。
- 不直接产出 `CLAIM-*`。
- 不直接让 test case passed。
- 不绕过 `ios_app_observe`、`ios_app_act`、`ios_app_read_trace` 生成正式 evidence。

输入：

```json
{
  "session_id": "SESSION-001",
  "purpose": "debug_appium_session",
  "command": "xcrun simctl list devices",
  "timeout_ms": 10000,
  "capture": {
    "stdout": true,
    "stderr": true,
    "max_bytes": 20000
  }
}
```

输出：

```json
{
  "status": "success",
  "debug_id": "DEBUG-001",
  "exit_code": 0,
  "stdout_summary": "Booted simulator iPhone 16 is available",
  "stderr_summary": "",
  "artifact": "debug/DEBUG-001.json",
  "usable_as_formal_evidence": false
}
```

规则：

- 返回值必须标记 `usable_as_formal_evidence=false`。
- 如需把调试发现转成正式证据，必须再调用对应的正式工具，例如 `ios_app_observe`、`ios_app_read_trace` 或 `ios_app_search_code`。
- 如果某类 debug shell 操作被反复使用，应沉淀为具名 `ios_app_*` MCP，而不是长期依赖 shell。

### ios_app_prepare_session

输入：

```json
{
  "service": "catstory",
  "purpose": "product_recon",
  "clean_install": true,
  "build": true,
  "simulator": "iPhone 16",
  "launch_args": ["-UITestMode", "1", "-Environment", "staging"],
  "auth": {
    "mode": "test_account",
    "account_ref": "profile_editor"
  }
}
```

输出：

```json
{
  "status": "ready",
  "session_id": "SESSION-001",
  "simulator_udid": "...",
  "bundle_id": "com.example.catstory",
  "app_version": "1.2.3",
  "build": "BUILD-001",
  "state": "STATE-001",
  "evidence": ["SESSION-001", "BUILD-001", "STATE-001"]
}
```

### ios_app_observe

输入：

```json
{
  "session_id": "SESSION-001",
  "record": ["screenshot", "ui_tree", "network_cursor", "app_state"]
}
```

输出为 `OBS-*` 结构化观察。

### ios_app_act

输入：

```json
{
  "session_id": "SESSION-001",
  "action": "tap",
  "target": {
    "strategy": "accessibility_id",
    "value": "profile.save.button"
  },
  "wait_for": {
    "type": "network_idle",
    "timeout_ms": 5000
  },
  "snapshot_after": true
}
```

输出为 `ACT-*`，自动引用前后 `OBS-*`。

### ios_app_run_flow

用于执行可复现流程。自由探索成功后，应沉淀为 flow。

输入：

```json
{
  "session_id": "SESSION-001",
  "flow_id": "FLOW-EDIT-PROFILE",
  "steps": [
    {"action": "deeplink", "url": "catstory://profile/edit"},
    {"action": "type", "target": "profile.nickname.input", "text": "test_name", "clear": true},
    {"action": "tap", "target": "profile.save.button", "wait_for": {"type": "network_idle"}}
  ]
}
```

输出：

```json
{
  "status": "success",
  "flow_id": "FLOW-001",
  "steps": ["ACT-001", "ACT-002", "ACT-003"],
  "observations": ["OBS-001", "OBS-002", "OBS-003"],
  "evidence": ["FLOW-001", "ACT-001", "ACT-002", "ACT-003"]
}
```

### ios_app_read_trace

输入：

```json
{
  "session_id": "SESSION-001",
  "after_action": "ACT-003",
  "types": ["network", "app_log", "crash"],
  "filters": {
    "path_contains": "/api/user/profile"
  }
}
```

输出：

```json
{
  "network_events": [
    {
      "id": "NET-001",
      "method": "PATCH",
      "path": "/api/user/profile",
      "status": 200,
      "latency_ms": 130,
      "triggered_by": "ACT-003",
      "request_summary": {"nickname": "test_name"},
      "response_summary": {"nickname": "test_name"}
    }
  ],
  "app_logs": [],
  "crashes": [],
  "evidence": ["NET-001"]
}
```

### ios_app_search_code

输入：

```json
{
  "service": "catstory",
  "scope": ["ios_client", "backend"],
  "queries": [
    {"type": "api_path", "value": "/api/user/profile"},
    {"type": "accessibility_id", "value": "profile.nickname.input"},
    {"type": "screen_title", "value": "编辑资料"}
  ],
  "max_results": 20
}
```

输出：

```json
{
  "matches": [
    {
      "id": "CLIENT_CODE-001",
      "repo": "catstory-ios",
      "path": "ProfileEditViewModel.swift",
      "symbols": ["ProfileEditViewModel", "save"],
      "summary": "编辑资料页保存时调用 UserProfileAPI.updateProfile"
    },
    {
      "id": "SERVER_CODE-001",
      "repo": "catstory",
      "path": "src/user/UserProfileController.ts",
      "symbols": ["updateProfile"],
      "summary": "PATCH /api/user/profile 的服务端入口"
    }
  ],
  "evidence": ["CLIENT_CODE-001", "SERVER_CODE-001"]
}
```

### ios_app_write_claims

把 agent 提炼的结论落盘为可追溯的 `CLAIM-*`。

> 底座/编排边界：**claim 的内容（statement 写什么、confidence 给多高、该不该提炼）由 agent 决定，属编排。** 底座只做两件机械事：
> - 分配 `CLAIM-*` id 并落盘；
> - **校验 `supported_by` 引用的 evidence id 真实存在于本 session 的 evidence store**，否则报错。这是"结论可证明"的护栏——防止 agent 幻觉出引用了不存在证据的 claim。

输入：

```json
{
  "claims": [
    {
      "statement": "编辑昵称保存会触发 PATCH /api/user/profile",
      "supported_by": ["ACT-003", "NET-001", "CLIENT_CODE-001"],
      "confidence": "high"
    }
  ]
}
```

输出：

```json
{
  "claims": [
    {
      "id": "CLAIM-001",
      "statement": "编辑昵称保存会触发 PATCH /api/user/profile",
      "supported_by": ["ACT-003", "NET-001", "CLIENT_CODE-001"],
      "confidence": "high"
    }
  ],
  "evidence": ["CLAIM-001"]
}
```

### ios_app_write_report

通用的结构化产物写盘工具，是**所有 JSON 产物（product-recon / impact-analysis / ios-test-plan / acceptance-report）落盘的唯一底座出口**。

> 底座/编排边界：**产物里写什么内容、是哪种产物、字段如何定义，由调用方（编排）决定。** 底座只提供通用机制：
> - 把 `body` 写到 deliverable 目录；
> - **脱敏出口**：写盘前统一脱敏（token/cookie/手机号/身份证/定位等），不允许 agent 用通用文件工具绕过；
> - **字段存在性校验**：按调用方传入的 `required_fields` 校验（与 `stage-evaluation-config-driven-plan.md` 的 `body_required_fields` 同源，等于"生产端先验、质量门再验"）；
> - **evidence 引用完整性校验**：body 中引用的 `FLOW-*`/`NET-*`/`CLAIM-*` 等 id 必须真实存在。
>
> 底座**不内置**各产物的字段定义——`required_fields` 由调用方传入，产物形态随编排演进，底座不绑定。

输入：

```json
{
  "session_id": "SESSION-001",
  "kind": "product_recon",
  "path": "projects/{{service}}/iteration/{{deliverable}}/product-recon.json",
  "required_fields": ["version", "platform", "flows", "evidence"],
  "body": {}
}
```

输出：

```json
{
  "status": "success",
  "path": "projects/catstory/iteration/2026-05-29_nickname/product-recon.json",
  "redacted_fields": ["app_log.0.token"],
  "missing_fields": [],
  "unresolved_evidence_refs": []
}
```

`generate_test_plan` 等"生成具体产物内容"的工具属编排层，本次不实现；底座只提供 `write_report` 这个通用写盘出口。

## Evidence 与 Claim 模型 [底座]

### Evidence

Evidence 是原始证据或可校验材料。

建议类型：

- `SESSION`
- `BUILD`
- `STATE`
- `OBS`
- `SCREEN`
- `SCREENSHOT`
- `UI_TREE`
- `ACT`
- `FLOW`
- `NET`
- `APP_LOG`
- `CRASH`
- `CLIENT_CODE`
- `SERVER_CODE`
- `CASE`
- `ASSERT`

每个 evidence 必须包含：

- `id`
- `type`
- `created_at`
- `session_id`
- `source`
- `summary`
- `artifact_path` 或结构化 payload
- `redaction`

### Claim

Claim 是可以被后续 agent 用来设计方案、判断影响或输出测试结果的结论。

Claim 必须引用 evidence。

```json
{
  "id": "CLAIM-001",
  "type": "current_behavior",
  "statement": "当前编辑昵称保存成功后会返回资料页并刷新昵称",
  "supported_by": ["FLOW-001", "OBS-003", "NET-001"],
  "confidence": "high",
  "limitations": []
}
```

Claim 类型：

- `current_behavior`
- `api_behavior`
- `client_implementation`
- `server_implementation`
- `impact`
- `test_requirement`
- `test_result`
- `risk`
- `open_question`

规则：

- plan、impact、test report 优先引用 `CLAIM-*`。
- `CLAIM-*` 再追溯到 `FLOW-*`、`ACT-*`、`NET-*`、`CLIENT_CODE-*` 等原始 evidence。
- 没有 evidence 的内容只能进入 assumption 或 open question。

## Product Recon 产物 [编排·暂不实现]

> 本节及之后的 Impact Analysis、Test Plan、Agent 使用流程、Context Pack/Quality Gate 接入，均属**编排层**：它们描述 agent 如何用底座工具产出业务结论与如何嵌入工作流。**本次不实现**，保留作为底座工具设计的目标参照。产物的字段定义即底座 `ios_app_write_report` 的 `required_fields` 来源。

Product Recon 用来理解当前业务行为。

输出 `product-recon.json`：

```json
{
  "version": 1,
  "session_id": "SESSION-001",
  "app": {
    "bundle_id": "com.example.catstory",
    "version": "1.2.3",
    "environment": "staging"
  },
  "requirement": {
    "summary": "调整昵称编辑规则"
  },
  "flows": [
    {
      "id": "FLOW-001",
      "name": "编辑昵称",
      "steps": ["ACT-001", "ACT-002", "ACT-003"],
      "observations": ["OBS-001", "OBS-002", "OBS-003"],
      "network": ["NET-001"],
      "claims": ["CLAIM-001", "CLAIM-002"]
    }
  ],
  "code_refs": {
    "ios_client": ["CLIENT_CODE-001"],
    "backend": ["SERVER_CODE-001"]
  },
  "claims": [
    {
      "id": "CLAIM-001",
      "type": "current_behavior",
      "statement": "编辑昵称保存会触发 PATCH /api/user/profile",
      "supported_by": ["ACT-003", "NET-001", "CLIENT_CODE-001"]
    }
  ],
  "open_questions": [],
  "evidence": ["SESSION-001", "FLOW-001", "NET-001", "CLIENT_CODE-001"]
}
```

## Impact Analysis 产物 [编排·暂不实现]

Impact Analysis 用来回答“这次需求是否涉及客户端或服务端改动”。

建议输出 `impact-analysis.json`，也可以第一版合并在 `product-recon.json` 的 `impact` 字段中。

```json
{
  "version": 1,
  "requirement": {
    "summary": "昵称为空时不允许保存"
  },
  "current_behavior": {
    "summary": "当前空昵称可以触发保存请求，服务端返回 200",
    "claims": ["CLAIM-001", "CLAIM-002"]
  },
  "client_impact": {
    "required": true,
    "confidence": "high",
    "reason": "保存按钮和本地输入校验位于 ProfileEditViewModel，需求要求提交前禁止保存",
    "evidence": ["CLIENT_CODE-001", "OBS-002", "CLAIM-003"]
  },
  "server_impact": {
    "required": "unknown",
    "confidence": "medium",
    "reason": "当前服务端允许空昵称，但需求未说明是否需要服务端兜底校验",
    "evidence": ["NET-001", "SERVER_CODE-001"],
    "open_questions": ["Q-001"]
  },
  "recommended_work": [
    {
      "area": "ios_client",
      "summary": "增加空昵称本地校验和保存按钮状态控制",
      "evidence": ["CLIENT_CODE-001", "OBS-002"]
    },
    {
      "area": "backend",
      "summary": "确认是否增加服务端兜底校验",
      "evidence": ["SERVER_CODE-001", "Q-001"]
    }
  ]
}
```

判断规则：

- `required=true` 表示已有证据能支撑该端必须修改。
- `required=false` 表示已有证据能支撑该端不需要修改。
- `required=unknown` 表示需求或证据不足，必须进入 open question 或 human review。

## Test Plan 生成 [编排·暂不实现]

测试计划生成位于 Product Recon 之后、Acceptance Harness 之前。

输入：

- 需求描述和验收标准。
- `product-recon.json`。
- `impact-analysis.json`。
- 相关代码 evidence。

输出 `ios-test-plan.json`：

```json
{
  "version": 1,
  "requirement": {
    "summary": "昵称为空时不允许保存"
  },
  "coverage_model": {
    "positive": ["TC-001"],
    "negative": ["TC-002"],
    "boundary": ["TC-003", "TC-004"],
    "regression": ["TC-005"],
    "network_failure": ["TC-006"]
  },
  "cases": [
    {
      "case_id": "TC-001",
      "title": "合法昵称可以保存",
      "automatable": true,
      "preconditions": ["已登录测试账号", "已进入编辑资料页"],
      "steps": [
        {"action": "deeplink", "url": "catstory://profile/edit"},
        {"action": "type", "target": "profile.nickname.input", "text": "test_name", "clear": true},
        {"action": "tap", "target": "profile.save.button"}
      ],
      "assertions": [
        {"type": "ui_text", "contains": "保存成功"},
        {"type": "network", "method": "PATCH", "path": "/api/user/profile", "status": 200}
      ],
      "acceptance_criteria": ["昵称保存成功后资料页刷新"],
      "derived_from": ["CLAIM-001"]
    },
    {
      "case_id": "TC-002",
      "title": "空昵称不允许保存",
      "automatable": true,
      "steps": [],
      "assertions": [
        {"type": "ui_text", "contains": "请输入昵称"},
        {"type": "network_absent", "path": "/api/user/profile"}
      ],
      "derived_from": ["CLAIM-002"]
    }
  ],
  "manual_cases": [],
  "open_questions": []
}
```

生成规则：

- 每条需求验收标准至少映射到一个 case。
- 涉及输入规则时必须生成边界值和非法值 case。
- 涉及 API 时必须生成网络断言。
- 涉及状态刷新时必须生成刷新、返回、重启或重新进入页面的状态断言。
- 无法自动化的 case 必须标记 `automatable=false` 并说明原因。

## Acceptance Harness 产物 [编排·暂不实现]

Acceptance Harness 执行 `ios-test-plan.json` 中可自动化的 case。

输出 `acceptance-report.json`：

```json
{
  "version": 1,
  "session_id": "SESSION-002",
  "test_plan": "ios-test-plan.json",
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1,
    "blocked": 0
  },
  "cases": [
    {
      "case_id": "TC-001",
      "result": "passed",
      "steps": ["ACT-101", "ACT-102", "ACT-103"],
      "assertions": [
        {
          "id": "ASSERT-001",
          "type": "ui_text",
          "status": "passed",
          "evidence": ["OBS-103"]
        },
        {
          "id": "ASSERT-002",
          "type": "network",
          "status": "passed",
          "evidence": ["NET-101"]
        }
      ],
      "claims": ["CLAIM-TEST-001"],
      "evidence": ["ACT-101", "ACT-102", "ACT-103", "ASSERT-001", "ASSERT-002"]
    }
  ],
  "bugs": [
    {
      "id": "BUG-001",
      "case_id": "TC-002",
      "summary": "空昵称仍触发保存请求",
      "evidence": ["ASSERT-004", "NET-104", "OBS-108"]
    }
  ],
  "evidence": []
}
```

验收通过规则：

- `passed` 只能来自明确 test case 和 assertion。
- 每个 passed case 必须有至少一个 UI 或状态断言。
- 涉及 API 的 case 必须有 network assertion。
- 用例执行期间出现 crash 时，该 case 不能 passed。
- 自由探索结果只能作为补充 evidence，不能直接让 case passed。

## Agent 使用流程 [编排·暂不实现]

### 面对需求时理解业务全貌

```text
prepare_session
  -> observe
  -> explore or run_flow
  -> read_trace
  -> search_code
  -> write_claims
  -> product-recon.json
```

输出：

- 当前用户路径。
- 当前页面和关键控件。
- 当前 API 调用和字段摘要。
- iOS ViewModel / API client 代码引用。
- 服务端 route / service 代码引用。
- open questions。

### 判断客户端或服务端影响

```text
product-recon.json
  -> compare requirement with current behavior
  -> map flow to client code and server code
  -> write impact claims
  -> impact-analysis.json
```

输出：

- client_impact：`true | false | unknown`。
- server_impact：`true | false | unknown`。
- 每个判断的 reason 和 evidence。
- 无法判断时的 open questions。

### 生成测试用例并自动化执行

```text
product-recon.json + impact-analysis.json + requirement
  -> ios-test-plan.json
  -> prepare_session for testing
  -> reset_state / seed / login
  -> run_test_case
  -> assert_ui / assert_network / collect_crash_logs
  -> acceptance-report.json
```

输出：

- 完整测试计划。
- 自动化执行报告。
- case/assert/evidence/claim 追溯链。

## 技术选型 [底座]

第一版：

- iOS 运行环境：Xcode + iOS Simulator。
- 模拟器管理：`xcrun simctl`。
- App 构建安装：`xcodebuild` + `simctl install/launch`。
- UI 自动化：Appium + XCUITest driver。
- 网络采集：优先 iOS Debug/Staging build 内置网络 JSONL 日志（路径见 `clients.ios.automation.network_log_path`）。
- iOS / 服务端源码索引：第一版用 `rg` 搜 screen/API/model/deeplink；后续可接 SwiftSyntax。

不建议第一版用 mitmproxy 做 HTTPS 抓包：iOS 证书信任、证书 pinning 和环境差异会明显增加维护成本。

## 服务配置：clients.ios [底座]

在现有 `groups/global/services.json` 中为服务增加 iOS client 信息。该配置是"顶层 service name 为 key"的结构，不额外包一层 `services`。

```json
{
  "catstory": {
    "repo_path": "catstory",
    "git_url": "git@tx.git.chelaile.net.cn:dev/catstory.git",
    "default_branch": "master",
    "clients": {
      "ios": {
        "repo_path": "catstory-ios",
        "git_url": "git@tx.git.chelaile.net.cn:client/catstory-ios.git",
        "workspace": "Catstory.xcworkspace",
        "scheme": "CatstoryDebug",
        "bundle_id": "com.example.catstory",
        "simulator": "iPhone 16",
        "configuration": "Debug",
        "automation": {
          "driver": "appium",
          "launch_args": ["-UITestMode", "1", "-Environment", "staging"],
          "deep_links": {
            "profile_edit": "catstory://profile/edit"
          },
          "network_log_path": "Library/Caches/IcarusNetworkLog/network.jsonl"
        }
      }
    }
  }
}
```

配置规则：

- `clients.ios.repo_path` 必须是相对路径，不能为空，不能含绝对路径、`.`、`..` 或空 path segment，解析后必须位于 `REPOS_DIR` 下（与现有 service `repo_path` 同规则）。
- iOS client repo 第一版由宿主机读取和搜索（`ios_app_search_code`），**不默认挂载给容器**；容器只通过工具获取受控源码片段。
- 若后续需容器直接读取 iOS repo，复用现有 service mount 安全规则，并显式声明 `clients.ios.mount_to_container: true`，默认 `false`。
- `git_url` 可选；若本地 `REPOS_DIR/{clients.ios.repo_path}` 不存在，**第一版直接返回配置错误，不自动 clone**。
- `network_log_path` 是相对 Simulator app container 的路径，由 `ios_app_read_trace` 通过 `simctl get_app_container` 解析后读取。

## iOS 工程配合要求 [底座依赖]

为了让能力稳定，Debug/Staging App 应配合：

- 关键控件设置 `accessibilityIdentifier`。
- 支持测试环境 launch args。
- 支持 deeplink 直达关键页面。
- 支持测试账号或 token 注入。
- 支持禁用真实支付、真实推送和真实生产写操作。
- 支持清理本地状态。
- 支持稳定 seed data。
- 支持网络 JSONL 日志。
- 网络日志支持字段脱敏和 request/action 关联。
- 关键业务日志能输出 request id 或 trace id。

没有这些配合时仍可探索，但工具返回中必须降低 confidence，并在报告中标记自动化稳定性风险。

## 安全与权限 [底座]

### 工具可见性即授权

第一版直接复用现有 MCP 授权模型：`container/mcp/mcp.json` 用 profile→group 授权工具，与 `delegation-worker` 让非主 worker 组（`web_dev`、`web_test` 等）获得能力的方式完全一致。

- 新增两个 profile：`ios-recon`（recon 类工具）与 `ios-acceptance`（验收类工具），授予对应 stage 组（plan 侧 / `web_test`），以及主群（用于能力层独立验证）。
- 在 `container/agent-runner/src/ipc-mcp-stdio.ts` 的 `BUILTIN_TOOL_VISIBILITY` 中为每个 `ios_app_*` 工具登记可见性（`all`），细粒度授权交给 profile 成员关系。
- **可见即授权**：只要工具在某组可见，就视为已授权调用。宿主机 dispatcher **不再**对 workflow / stage / service 做第二次授权校验。dispatcher 仍会用请求中的 `service` 参数解析 `clients.ios` 配置和源码路径，但不与委派反查结果做交叉比对。
- 已知取舍：worker 组按 stage 共享（磁盘上只有一个 `web_test`，不是 `catstory_test`），因此把 `ios-acceptance` 授予 `web_test` 意味着该 stage 下任意 service 的验收都能调用这组工具。第一版接受这一授权粒度。

### 会话、资源与脱敏

- 通用 `ios_app_request` 只作为内部 IPC 承载协议，不作为正式工具暴露给 agent。
- 每个 session 绑定 service、bundle id、simulator、artifact directory，作为资源归属，不作为授权依据。
- **Simulator 资源锁必须是宿主机全局锁。** `GroupQueue` 只保证同一组内串行，组与组之间是并发的；多个 service 同时进入 `testing` 会争抢同一台模拟器。因此锁要跨组、面向有限模拟器池，独立于 GroupQueue 调度。
- 网络日志、App log、截图和源码片段必须脱敏。
- 测试账号、token、cookie、手机号、身份证、定位等敏感信息不得明文写入 evidence。
- 危险操作，例如生产环境写操作、真实支付、真实推送，必须被配置禁止。

### 调试逃生口

- `ios_host_debug_shell` 是具名调试工具，但不属于正式 evidence provider；它的输出只能形成 `DEBUG-*` 记录。
- `DEBUG-*` 可以被人工排障引用，但不能直接支撑 plan decision、impact decision 或 acceptance passed。

## 代码模块清单 [底座]

宿主机侧建议新增的模块。**本次只实现底座文件**；编排文件列出仅作占位，待编排层落地时再加。

```text
src/app-recon/
  types.ts                       # [底座] Session/Evidence/Claim/Action 等类型
  ios-app-request-dispatcher.ts  # [底座] 统一 ios_app_request 入口与分发
  ios-simulator.ts               # [底座] xcrun simctl / xcodebuild：启动/安装/launch/锁
  ios-appium.ts                  # [底座] Appium/XCUITest：observe/act/run_flow
  ios-source-index.ts            # [底座] iOS + 服务端源码搜索（rg）
  ios-network-log.ts             # [底座] 读 Simulator 网络 JSONL、脱敏、关联 action
  ios-evidence-store.ts          # [底座] evidence/claim 落盘、id 分配、脱敏出口、引用校验
  ios-report-writer.ts           # [底座] ios_app_write_report：通用写盘+脱敏+字段/引用校验

  # 以下为编排层，本次不实现，待定如何嵌入工作流：
  ios-product-recon.ts           # [编排] 生成 product-recon.json 的内容
  ios-impact-analysis.ts         # [编排] 生成 impact-analysis.json 的内容
  ios-test-plan.ts               # [编排] 生成 ios-test-plan.json 的内容
  ios-acceptance-harness.ts      # [编排] 串联 run_test_case/assert 产出 acceptance-report.json
```

注：脱敏与 evidence/claim 引用完整性校验集中在 `ios-evidence-store.ts` 与 `ios-report-writer.ts` 两处统一出口，编排层不得绕过。

## 与 Context Pack / Quality Gate 的关系 [编排·暂不实现]

iOS Simulator Capability 是 evidence provider，不直接替代 agent 设计方案。

> 接入方式：`WorkflowContextSourceType` 是封闭联合，仅 `workflow_input | artifact | codebase_location` 三种（见 `src/workflow-definition.ts`，并在 `src/workflow-compiler.ts` 有白名单二次约束）。本方案**不新增 source type**；workflow artifact 系统已支持 JSON deliverable（见 `stage-evaluation-config-driven-plan.md` 的 ①②③），四类 JSON 产物直接作为 `artifact` source 纳入 Context Pack。

Context Pack 可纳入（均为 `artifact` 类型）：

- `product-recon.json`
- `impact-analysis.json`
- `ios-test-plan.json`
- `acceptance-report.json`
- evidence index

Quality Gate 可检查：

- 用户行为改动是否引用 `CLAIM-*`、`FLOW-*` 或说明 iOS recon 不适用。
- API 改动是否引用 `NET-*` 或 `SERVER_CODE-*`。
- 客户端影响判断是否引用 `CLIENT_CODE-*`。
- 服务端影响判断是否引用 `SERVER_CODE-*` 或 `NET-*`。
- plan 中 `unknown` 影响项是否进入 open question 或 human review。
- testing passed 是否引用 `CASE-*`、`ASSERT-*`、`OBS-*`、`NET-*`。

## 分阶段实施

> 范围对照：**本次交付 = 底座（Phase 1–3）。** Phase 4 起属编排层，本次不实现，列出仅供规划。底座工具产出的 JSON 产物落盘走 `ios_app_write_report`，但"产物内容怎么生成、按什么链路编排、如何嵌入工作流"待定。

实施顺序原则：

- **底座先于编排与 workflow 接入。** Phase 1–3 的 prepare/observe/act/trace/search + write_claims/write_report 先作为**独立的主群工具**验证，完全不绑定任何 workflow 阶段。`ios-recon`/`ios-acceptance` profile 先只授予主群，agent 在主群里就能跑通启动、观察、操作、网络关联、产物写盘的完整闭环。
- **先消未知数，再付编排成本。** UI 自动化稳定性、iOS 工程配合（accessibilityIdentifier / launch args / deeplink / JSONL 日志 / seed data）是两个最大的外部不确定项；要在底座独立验证里先压掉。
- **编排与 workflow 接入待定。** Product Recon/Impact/Test Plan 的编排链路、Context Pack、Quality Gate 阻断如何嵌入工作流，本次不决定。其依赖的 JSON deliverable 能力由 `stage-evaluation-config-driven-plan.md` 提供。
- 每个 Phase 都自带可独立验证的成功标准，未达标不进入下一阶段。

### Phase 1：可操作模拟器最小闭环 [底座]

- 实现 host `ios_app_request` dispatcher。
- 实现 session 管理、资源锁、超时和统一错误格式（授权沿用工具可见性，dispatcher 不做二次校验）。
- 实现 `ios_app_prepare_session`。
- 实现 `ios_app_observe`。
- 实现 `ios_app_act` 的 tap/type/scroll/back/deeplink/wait。
- 每个 observe/action 自动写 evidence。

成功标准：

- agent 能启动 App、观察页面、点击输入、跳转页面。
- 每个动作都有前后 observe 和 action evidence。
- 失败时能返回结构化失败原因。

### Phase 2：Trace 与代码关联 [底座]

- iOS Debug build 输出网络 JSONL。
- 实现 `ios_app_read_trace`。
- 实现 `ios_app_search_code`。
- 支持 `ACT -> NET -> CLIENT_CODE -> SERVER_CODE` 关联。

成功标准：

- agent 能证明某个 UI 动作触发了哪个 API。
- agent 能找到相关 iOS ViewModel/API client 和服务端 route。

### Phase 3：Claim 与产物写盘工具 [底座]

> 这里只实现**工具**（存 claim、写盘、校验、断言执行），不实现"按业务链路生成产物内容"——那是编排层。

- 实现 `ios_app_write_claims`（分配 id、落盘、校验 evidence 引用存在）。
- 实现 `ios_app_write_report`（通用写盘 + 脱敏出口 + `required_fields` 字段校验 + evidence 引用校验）。
- 实现 `ios_app_run_test_case`（执行调用方给定的用例 + UI/network/state/crash 断言）。

成功标准：

- agent 可生成至少一个 `CLAIM-*`，引用不存在 evidence 时被拒。
- 通过 `write_report` 写出一个带 `required_fields` 的 JSON 产物，缺字段/坏引用能被报告。
- 给定一个用例可执行并返回结构化断言结果。

### Phase 4 起：编排与工作流接入 [暂不实现]

以下属编排层，本次不实现，待"如何嵌入工作流"想清楚后再排期：

- Product Recon / Impact Analysis / Test Plan 的**内容生成链路**（agent 如何串底座工具产出四类 JSON）。
- 工作流角色/状态接入、plan prompt 注入。
- Context Pack 纳入 iOS 产物（作为 `artifact` source）。
- Quality Gate 从 non-blocking 切到 blocking。

> 依赖说明：上述 JSON 产物作为正式 artifact 所需的 JSON deliverable 能力（目录扫描去 `.md` 化、`body_required_fields` 校验、handoff/Trace 纳入 JSON artifact），由 `stage-evaluation-config-driven-plan.md` 提供，届时为"消费既有能力"。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| UI 自动化不稳定 | 强制关键控件 accessibilityIdentifier；优先 deeplink；locator 记录唯一性和 fallback |
| 探索不可复现 | action 自动记录前后 observe；成功路径沉淀为 flow |
| 网络和 action 难关联 | 网络日志记录 request id、action 时间窗口、session id |
| 测试误判通过 | 只有明确 case + assertion 可以 passed |
| 客户端或服务端影响被猜错 | impact 输出 `true/false/unknown`，unknown 必须进入 open question |
| 敏感信息泄漏 | evidence 写入前统一 redaction；字段白名单优先 |
| 多 agent 并发污染模拟器 | session 级资源锁和独立 simulator/container |
| iOS 工程配合不足 | 降低 confidence，报告 limitations，不把低置信度观察作为 blocking claim |
| 过早接入 workflow 导致复杂度失控 | 先做能力闭环，再接 Product Recon、Impact Analysis、Acceptance Harness |

## 第一版验收标准（底座）

本次验收只覆盖底座能力；产物的"内容生成链路"和工作流接入属编排层，不在本次验收范围。

- agent 可以通过 MCP 启动指定 iOS App 到 staging/debug 环境。
- agent 可以获取包含 screenshot、UI tree、可交互元素和 network cursor 的 observe。
- agent 可以执行 tap/type/scroll/back/deeplink/wait，并自动记录 action 前后 observe。
- agent 可以读取 action 触发的网络事件，并输出脱敏 `NET-*` evidence。
- agent 可以搜索 iOS 客户端和服务端代码，并输出 `CLIENT_CODE-*`、`SERVER_CODE-*` evidence。
- agent 可以生成至少一个 `CLAIM-*`，引用不存在的 evidence 时被底座拒绝。
- agent 可以通过 `ios_app_write_report` 写出一个 JSON 产物：缺 `required_fields` 字段、引用不存在 evidence、含敏感字段时，分别被校验报告 / 脱敏。
- agent 可以执行至少一个给定的 test case，并返回结构化断言结果与证据。

> 注：能否产出语义完整的 `product-recon.json` / `impact-analysis.json` / `ios-test-plan.json` / `acceptance-report.json`，取决于编排层（暂不实现）；底座只保证"写盘工具可用、校验/脱敏护栏生效"。
