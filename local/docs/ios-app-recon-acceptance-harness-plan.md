# iOS App Product Recon 与 Acceptance Harness 方案

## 背景

在 App 服务端需求中，后端 agent 仅阅读服务端代码和需求文档，往往无法稳定理解：

- App 当前真实入口和交互路径。
- App 端实际调用的 API、字段、错误处理和状态刷新方式。
- 需求影响的是哪个页面、哪个 ViewModel、哪个 API client、哪个后端接口。
- 测试阶段是否真的从用户视角验证了目标行为。

本方案只考虑 macOS 宿主机上的 iOS 移动端 App，先不考虑 Web App、Android App 和真机。

核心方向：

- 容器 agent 不直接控制 Mac。
- 宿主机提供一组受控 MCP 工具，负责 iOS Simulator 操作、证据采集和报告生成。
- 方案设计前通过 `Product Recon` 理解当前产品行为。
- 测试验收阶段通过 `Acceptance Harness` 执行明确测试用例和断言。
- 所有观察和测试结论都输出结构化 evidence，供 Context Pack 和 Quality Gate 使用。

## 目标

- 让方案设计 agent 能基于真实 iOS App 行为、客户端代码和 API 调用设计方案。
- 让测试验收不只依赖自然语言描述，而是具备可复现测试用例、断言和证据。
- 支持把 App 行为证据纳入 `Context Pack`。
- 支持把验收证据纳入 `Quality Gate`。
- 第一版以可落地、可审计为优先，不追求完整 RPA 能力。

## 非目标

- 不直接让容器内 agent SSH 到 Mac 任意执行命令。
- 不覆盖 Android、Web、真机。
- 不第一版支持复杂视觉推理；优先使用 UI tree、accessibility identifier、网络日志和源码索引。
- 不把 App 探索结果直接当业务目标；需求目标不明确时仍要形成 open questions。
- 不用自由探索结果直接判定测试通过；测试通过必须来自明确测试用例和断言。

## 设计原则

- **操作可以探索，结论必须可追溯**：任何进入方案或测试报告的结论都要引用 evidence id。
- **Product Recon 和 Acceptance Harness 分离**：前者理解现状，后者验证目标行为。
- **宿主机执行，容器调用**：Xcode、Simulator、Appium/Maestro 运行在宿主机，容器通过 MCP 调受控接口。
- **优先结构化接口**：优先 UI tree、accessibility id、网络日志、源码引用；截图用于补充证据。
- **先最小闭环，再扩展能力**：先实现 prepare/snapshot/tap/type/network/source/report，再做录屏、性能、崩溃分析等增强。

## 技术选型

第一版推荐：

- iOS 运行环境：Xcode + iOS Simulator。
- 模拟器管理：`xcrun simctl`。
- App 构建安装：`xcodebuild` + `simctl install/launch`。
- UI 自动化：Appium + XCUITest driver。
- Flow 沉淀：后续接 Maestro。
- 网络采集：优先 iOS Debug/Staging build 内置网络日志。
- iOS 源码索引：第一版用 `rg` 搜 screen/API/model/deeplink；后续可接 SwiftSyntax。

不建议第一版直接依赖 mitmproxy 做 HTTPS 抓包。iOS 证书信任、证书 pinning 和环境差异会明显增加维护成本。

## 系统架构

```text
workflow delegation
  -> container agent
    -> MCP ios_app_* tool
      -> host IosAppReconService
        -> xcrun simctl
        -> Appium / XCUITest
        -> iOS client repo search
        -> app debug network log
        -> evidence files
        -> product-recon.json / acceptance-report.json
```

建议新增代码模块：

```text
src/app-recon/
  types.ts
  ios-simulator.ts
  ios-appium.ts
  ios-source-index.ts
  ios-network-log.ts
  ios-evidence-store.ts
  ios-product-recon.ts
  ios-acceptance-harness.ts
```

## 服务配置

在服务配置中增加 iOS client 信息。示例：

```json
{
  "services": {
    "catstory": {
      "repo_path": "catstory-backend",
      "default_branch": "main",
      "clients": {
        "ios": {
          "repo_path": "catstory-ios",
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
}
```

## iOS 工程配合要求

为了让自动化稳定，iOS App Debug/Staging build 应尽量支持：

- 关键控件设置 `accessibilityIdentifier`。
- 支持测试环境 launch args，例如 `-UITestMode 1`、`-Environment staging`。
- 支持测试账号或 token 注入。
- 支持 deep link 直达关键页面。
- 支持禁用真实支付、真实推送、真实生产写操作。
- 支持网络请求脱敏日志。
- 支持稳定 seed data 或测试后端环境。

没有这些能力时仍可通过 UI tree 和截图探索，但可复现性和测试稳定性会下降。

## MCP 工具定义

### ios_app_prepare

准备 iOS App 探索或验收环境。

职责：

- 读取服务 iOS client 配置。
- 选择或启动 Simulator。
- 可选构建 Debug/Staging App。
- 安装并启动 App。
- 注入 launch args。
- 可选清理安装、登录、设置环境。

输入：

```json
{
  "service": "catstory",
  "clean_install": true,
  "build": true,
  "simulator": "iPhone 16",
  "launch_args": ["-UITestMode", "1", "-Environment", "staging"]
}
```

输出：

```json
{
  "status": "ready",
  "simulator_udid": "...",
  "bundle_id": "com.example.catstory",
  "app_version": "1.2.3",
  "evidence": ["PREP-001"]
}
```

### ios_app_snapshot

获取当前 App 状态。

职责：

- 截图。
- 获取 UI tree/page source。
- 提取可交互元素。
- 为元素生成 ref。
- 保存 evidence。

输出：

```json
{
  "screen_id": "SCREEN-001",
  "ui_tree_id": "UI-001",
  "elements": [
    {
      "ref": "@ios-12",
      "type": "XCUIElementTypeTextField",
      "label": "昵称",
      "identifier": "profile.nickname.input",
      "clickable": true
    }
  ]
}
```

### ios_app_tap

点击 UI 元素。

支持目标：

- snapshot ref。
- accessibility id。
- label/text。
- 坐标兜底。

输出应记录 action id 和点击后页面状态。

### ios_app_type

向输入框输入文本。

职责：

- 聚焦目标输入框。
- 清空或追加输入。
- 对 sensitive 字段脱敏记录。
- 可选输入后 snapshot。

### ios_app_run_flow

执行一段预定义或临时 flow。

支持步骤：

- `deeplink`
- `tap`
- `type`
- `scroll`
- `wait`
- `snapshot`
- `assert_text`
- `assert_element`

输出：

```json
{
  "status": "success",
  "flow_id": "FLOW-001",
  "steps": ["ACT-001", "ACT-002"],
  "screens": ["SCREEN-001", "SCREEN-002"],
  "observations": []
}
```

### ios_app_explore

可选增强工具。允许 agent 在目标约束内自由探索。

输入必须包含：

```json
{
  "goal": "找到并观察编辑昵称流程",
  "max_steps": 30,
  "stop_when": ["出现保存成功", "触发 /api/user/profile", "无法继续"],
  "allowed_actions": ["tap", "type", "back", "scroll", "deeplink", "snapshot"],
  "record": ["screenshot", "ui_tree", "network_log", "app_log"]
}
```

输出仍必须结构化，不能只返回自然语言。

### ios_app_read_network_log

读取 iOS Debug build 输出的网络日志。

职责：

- 从 Simulator app container 中读取 JSONL 网络日志。
- 按时间、action、flow、path 过滤。
- 脱敏 header/token。
- 生成 `NET-*` evidence。

输出：

```json
{
  "network_events": [
    {
      "id": "NET-001",
      "method": "PATCH",
      "path": "/api/user/profile",
      "status": 200,
      "request_summary": {
        "nickname": "test_name"
      },
      "response_summary": {
        "nickname": "test_name"
      },
      "triggered_by": "FLOW-001"
    }
  ]
}
```

### ios_app_search_client_code

检索 iOS 客户端源码。

职责：

- 在 iOS repo 中按 screen/API/model/deeplink/文案关键词搜索。
- 返回文件路径、符号、摘要、片段。
- 将 flow、network event 和客户端实现关联。

输出：

```json
{
  "matches": [
    {
      "id": "CODE-IOS-001",
      "path": "/workspace/repos/catstory-ios/ProfileEditViewModel.swift",
      "summary": "编辑资料页保存时调用 updateProfile",
      "symbols": ["ProfileEditViewModel", "updateProfile"]
    }
  ]
}
```

### ios_app_write_recon_report

生成 `product-recon.json`。

职责：

- 汇总 flow、screen、UI tree、network、client code、backend code。
- 记录当前行为和 open questions。
- 写入 deliverable 目录。

### ios_app_reset_state

验收阶段使用。重置 App 和测试环境状态。

职责：

- 卸载/重装 App 或清理 container。
- 清理 keychain/session/UserDefaults/cache。
- 可选重置权限。

### ios_app_seed_test_data

准备测试数据。

职责：

- 创建或重置测试账号。
- 准备业务对象和状态。
- 返回 seed id 和可追踪标识。

### ios_app_login

登录测试账号。

方式：

- UI 登录 flow。
- token/session 注入。
- deeplink 或 debug endpoint。

### ios_app_run_test_case

执行明确测试用例。

输入：

```json
{
  "case_id": "TC-001",
  "title": "昵称长度 2-20 可保存",
  "preconditions": ["已登录测试账号"],
  "steps": [
    {"action": "deeplink", "url": "catstory://profile/edit"},
    {"action": "type", "target": "profile.nickname.input", "text": "test_name", "clear": true},
    {"action": "tap", "target": "profile.save.button"}
  ],
  "assertions": [
    {"type": "ui_text", "contains": "保存成功"},
    {"type": "network", "method": "PATCH", "path": "/api/user/profile", "status": 200}
  ]
}
```

输出：

```json
{
  "case_id": "TC-001",
  "result": "passed",
  "steps": ["ACT-001", "ACT-002", "ACT-003"],
  "assertions": ["ASSERT-001", "ASSERT-002"],
  "evidence": ["SCREEN-003", "NET-001"]
}
```

### ios_app_assert_ui

结构化 UI 断言。

支持：

- 文本出现/消失。
- 元素存在/不存在。
- 按钮 enabled/disabled。
- 输入值等于预期。
- 页面标题正确。

### ios_app_assert_network

结构化网络断言。

支持：

- API 是否触发。
- method/path/status 是否符合预期。
- request/response 摘要是否包含预期字段。
- 不应触发的 API 是否未触发。

### ios_app_collect_crash_logs

收集 crash 和系统异常。

职责：

- 读取 Simulator crash logs。
- 关联当前 case 或 flow。
- 生成 `CRASH-*` evidence。

### ios_app_write_test_report

生成验收执行报告。

输出：

- `acceptance-report.json`
- 可选 `test.coverage.json` 更新。
- 可选 Markdown 摘要。

## Product Recon 模式

Product Recon 用于方案设计前，目标是理解当前产品行为，不是验证目标行为。

输入：

- 需求描述。
- 需求附件摘要。
- 目标服务。
- iOS client 配置。
- 可选目标 flow 或页面。

输出 `product-recon.json`：

```json
{
  "version": 1,
  "platform": "ios_simulator",
  "app": {
    "bundle_id": "com.example.catstory",
    "scheme": "CatstoryDebug"
  },
  "flows": [
    {
      "id": "FLOW-001",
      "name": "编辑用户昵称",
      "steps": ["ACT-001", "ACT-002"],
      "observed_behavior": "保存后返回资料页，昵称刷新为 test_name",
      "evidence": ["SCREEN-001", "UI-001", "NET-001"]
    }
  ],
  "api_calls": [
    {
      "id": "NET-001",
      "method": "PATCH",
      "path": "/api/user/profile",
      "triggered_by": "FLOW-001"
    }
  ],
  "client_call_graph": [
    {
      "flow": "FLOW-001",
      "files": ["ProfileEditViewModel.swift", "UserProfileAPI.swift"],
      "api": "NET-001"
    }
  ],
  "backend_call_graph": [
    {
      "api": "PATCH /api/user/profile",
      "files": ["UserProfileController.ts", "UserProfileService.ts"]
    }
  ],
  "open_questions": [
    {
      "id": "Q-001",
      "question": "昵称为空时目标行为是禁止保存还是允许清空？",
      "reason": "当前行为允许，但需求未说明目标状态"
    }
  ],
  "evidence": []
}
```

## Acceptance Harness 模式

Acceptance Harness 用于测试验收阶段，目标是可重复验证目标行为。

流程：

```text
prepare
  -> reset_state
  -> seed_test_data
  -> login
  -> run_test_case
  -> assert_ui / assert_network / collect_crash_logs
  -> write_test_report
```

验收通过必须来自明确用例和断言。自由探索结果不能直接作为 passed 依据。

输出 `acceptance-report.json`：

```json
{
  "version": 1,
  "platform": "ios_simulator",
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
      "steps": ["ACT-001", "ACT-002"],
      "assertions": [
        {
          "id": "ASSERT-001",
          "type": "ui_text",
          "status": "passed"
        }
      ],
      "evidence": ["SCREEN-003", "NET-001"]
    }
  ],
  "bugs": [],
  "evidence": []
}
```

## Workflow 接入

建议新增两个角色：

```json
{
  "product_recon": {
    "label": "产品行为理解",
    "deliverable_file": "product-recon.json"
  },
  "acceptance_runner": {
    "label": "iOS 验收执行",
    "deliverable_file": "acceptance-report.json"
  }
}
```

推荐状态：

```text
product_recon -> plan -> plan_examine -> dev -> dev_examine -> ops_deploy -> testing -> acceptance_runner -> testing_result
```

第一版可简化为：

```text
product_recon -> plan -> ... -> testing
```

测试阶段由现有 test agent 调用 Acceptance Harness，后续再拆 `acceptance_runner`。

## Skill 边界

### ios-product-recon

允许工具：

- `ios_app_prepare`
- `ios_app_snapshot`
- `ios_app_tap`
- `ios_app_type`
- `ios_app_run_flow`
- `ios_app_explore`
- `ios_app_read_network_log`
- `ios_app_search_client_code`
- `ios_app_write_recon_report`

职责：

- 探索当前行为。
- 建立 flow/API/iOS code/backend code 关联。
- 输出 open questions。
- 不设计实现方案。

### ios-acceptance-harness

允许工具：

- `ios_app_prepare`
- `ios_app_reset_state`
- `ios_app_seed_test_data`
- `ios_app_login`
- `ios_app_run_test_case`
- `ios_app_assert_ui`
- `ios_app_assert_network`
- `ios_app_collect_crash_logs`
- `ios_app_write_test_report`

职责：

- 执行明确测试用例。
- 记录断言和证据。
- 输出验收报告。
- 不把自由探索结果直接标记为通过。

## 与 Context Pack / Quality Gate 的关系

iOS App 方案是通用 Context Pack 的一个 source/evidence provider。

新增 source type：

```json
{
  "id": "ios_product_recon",
  "type": "ios_app_recon",
  "required": false,
  "platform": "ios_simulator",
  "app": "{{context.ios_app_id}}",
  "client_repo": "{{context.ios_client_repo}}",
  "backend_repo": "{{service}}",
  "on_open_questions": "ask_user"
}
```

新增 evidence type：

- `FLOW`
- `SCREEN`
- `UI_TREE`
- `NET`
- `CLIENT_CODE`
- `CASE`
- `ASSERT`
- `CRASH`
- `APP_LOG`

Quality Gate 示例：

- plan 中用户行为改动必须引用 `FLOW-*` 或说明 App recon 不适用。
- API 改动必须引用 `NET-*` 或后端 route 证据。
- iOS 客户端影响必须引用 `CLIENT_CODE-*`。
- product recon 的 open questions 非空时 plan 不能自动 passed。
- testing passed 必须引用 `CASE-*`、`ASSERT-*` 和必要证据。

## 分阶段实施

### Phase 1：Product Recon 最小闭环

- 实现 `ios_app_prepare`。
- 实现 `ios_app_snapshot`。
- 实现 `ios_app_tap/type/run_flow`。
- 实现 `ios_app_search_client_code`。
- 实现 `ios_app_write_recon_report`。

### Phase 2：网络日志

- iOS Debug build 输出网络 JSONL。
- 实现 `ios_app_read_network_log`。
- `product-recon.json` 关联 `FLOW -> NET -> backend route`。

### Phase 3：工作流接入

- 新增 `product_recon` 角色和 skill。
- plan prompt 注入 `product-recon.json`。
- Context Pack 纳入 `ios_product_recon` source。

### Phase 4：Acceptance Harness

- 实现 reset/seed/login。
- 实现 run_test_case/assert_ui/assert_network。
- 实现 `acceptance-report.json`。

### Phase 5：质量门阻断

- plan quality gate 检查用户行为证据引用。
- testing quality gate 检查 case/assert/evidence。
- 从旁路记录逐步切换到 blocking。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| UI 自动化不稳定 | 要求 accessibilityIdentifier；优先 deeplink 直达 |
| 登录和测试数据不稳定 | 支持 token 注入和 seed data |
| 网络抓包维护成本高 | 第一版用 Debug build 网络日志 |
| agent 探索路径不可复现 | 每次 action 自动记录，成功路径沉淀为 run_flow |
| 测试误判通过 | 只有明确 test case + assertion 可以 passed |
| iOS 客户端代码无法精准索引 | 第一版 `rg`，后续 SwiftSyntax |

## 成功标准

- 对涉及 iOS 用户行为的需求，plan 前能产出 `product-recon.json`。
- `product-recon.json` 至少包含 flow、screen、UI tree、iOS code refs，若有 API 则包含 network event。
- plan 能引用 `FLOW/SCREEN/NET/CLIENT_CODE` 设计后端方案。
- testing 能执行 iOS 验收用例并输出 `acceptance-report.json`。
- 测试通过结论能追溯到 `CASE/ASSERT/SCREEN/NET/LOG` 证据。
