# Workflow Definition Web 管理现状与下一步计划

## 1. 当前现状

### 1.1 Card 层

当前 card 相关能力已经完成了从 workflow 代码特判到独立配置资源的拆分，现状如下：

- card 配置独立存放在 `container/skills/cards.json`
- card schema 已独立定义在 `src/card-config.ts`
- card 运行时构建逻辑已独立在 `src/card-builder.ts`
- workflow / workbench 运行时已通过 `getCardConfig(workflowType, cardKey)` 访问 card，而不是直接依赖 workflow config 内嵌字段
- card 当前已支持 pattern + action + form 的显式 schema，替代了原有基于 `workflow.status` 的按钮文案和表单特判
- Web 渲染端已补充 `textarea` 支持，能够承接 revise 类卡片表单

当前 card 已具备“独立资源 + 独立 schema + 独立访问接口”的基础能力。

### 1.2 Workflow Definition 层

workflow 相关配置已从“直接手写 runtime config”升级为“definition + compiler + runtime config”的结构，现状如下：

- 新的编辑态 workflow definition schema 定义在 `src/workflow-definition.ts`
- `src/workflow-compiler.ts` 已实现 definition 到 runtime config 的编译
- `src/workflow-config.ts` 现在只读取 `container/skills/workflow-definitions.json`
- definition 会先经过 publish model 选择 published version，再经过 compiler 编译为现有引擎可执行的 runtime config
- 当前 `dev_test` 已迁移到 `container/skills/workflow-definitions.json`

现阶段 runtime engine 基本保持不变，workflow 的主要升级集中在 definition 层和编译层。

### 1.3 Publish Model 层

workflow definition 已具备最小可用的版本发布模型：

- workflow definition 顶层使用 registry 结构：`definitions -> key -> versions[]`
- 每个 version 具备 `version` 与 `status`
- 当前支持三种状态：
  - `draft`
  - `published`
  - `archived`
- runtime loader 只会选择每个 workflow key 的 `published` version
- 发布新版本时，原来的 `published` 会自动切换为 `archived`

这意味着 workflow definition 已经具备了“编辑态版本”和“运行态生效版本”的分离。

### 1.4 Web API 层

web 侧已经具备基础 definition / card 管理 API，现状如下：

#### Workflow Definition API

- `GET /api/workflow-definitions`
  - 返回 workflow definition bundle 摘要列表
- `GET /api/workflow-definitions/:key`
  - 返回单个 workflow bundle、published/draft definition 与 preview
- `POST /api/workflow-definitions/:key`
  - 保存 draft definition
- `POST /api/workflow-definitions/:key/publish`
  - 发布 draft 或指定版本

#### Card API

- `GET /api/cards`
  - 返回 card registry
- `POST /api/cards`
  - 保存 card registry
  - 已包含 card schema 校验

当前 web 后端接口已足以支撑一个最小管理页面。

### 1.5 Web 前端层（已完成部分）

workflow definitions 的 Electron Web 管理页第一阶段已经完成，而且已经超过最初“最小可用”的范围，现状如下：

#### Workflow Definitions 页面已完成

- 已新增 workflow definitions 一级导航入口
- 已完成 workflow definition 列表页
  - 展示 key / label / description / published version / draft version / version count
- 已完成 workflow definition 详情页
  - 展示 bundle 信息
  - 展示 published / draft 摘要
  - 展示各版本列表
  - 可查看选中版本内容
- 已完成 draft 保存
- 已完成 draft 发布
- 已完成“复制 published 到 draft”
- 已完成“复制选中历史 version 到 draft”
- 已完成新建 workflow definition

#### Definition 编辑体验已完成的部分

当前编辑页已经是“表单 + JSON + 结构化 inspector”的混合编辑模式，而不只是原始 JSON：

- 基本信息表单
  - bundle label
  - key
  - name
  - description
  - version 展示
- roles 结构化编辑器
  - 列表 + inspector + JSON
  - 支持新增 / 重命名 / 删除 role
  - 支持编辑 label / description / channels
  - channels 已支持结构化新增 / 删除 / 重命名 key
- entry_points 结构化编辑器
  - 列表 + inspector + JSON
  - 支持新增 / 重命名 / 删除 entry point
  - 支持编辑 state / deliverable_role / requires_deliverable 等字段
- states 结构化编辑器
  - 列表 + inspector + JSON
  - 支持新增 / 重命名 / 删除 state
  - 支持切换 state type
  - delegation / confirmation 两类 state 已支持结构化过渡编辑
- status_labels 结构化编辑器
  - 列表 + inspector + JSON
  - 支持新增 / 删除 / 编辑文案

#### 预览与辅助能力已完成的部分

- 已完成 workflow 只读结构视图
  - 展示 state 节点
  - 展示 transition 摘要
  - 展示 entry / terminal / system 等标识
- 点击结构视图节点后，已可联动到 state inspector 与 `states` JSON 片段
- 已完成 compile preview 展示
- 已完成 draft vs published 的行级 diff 视图
- 已完成版本内容查看面板
- 已完成 role / state / card 引用的基础校验提示

也就是说：

- workflow definitions 的 web 管理页已经可用
- 而且已经具备一版结构化编辑能力
- 当前真正还未完成的重点，已经从“definition 页面从 0 到 1”切换为“cards 页面 + 更强校验/体验完善”

### 1.6 当前仍未完成的部分

虽然 workflow definitions 页面已经落地，但当前还缺少以下内容：

- 还没有 cards 的 web 管理页面
- workflow definitions 页虽然已支持结构化编辑，但还没有真正的拖拽式流程图编排
- transition 仍以表单编辑为主，尚未做图上直接编辑
- 还没有 definition version compare 的更强语义化 diff（当前是行级 diff）
- 还没有发布前的一站式“全量引用校验 / 风险汇总 / 修复建议”
- 还没有与运行实例、workflow version 的绑定展示
- 还没有 card 渲染预览器与所见即所得编辑体验

也就是说：

- workflow definitions 主管理页已经从 0 到 1 完成
- 下一步的主轴应切到 cards 管理页
- workflow definitions 页后续更多是增强项，而不是阻塞项

---

## 2. 下一步实施建议

后续建议按三个阶段推进，优先把 cards 管理页补齐，然后再继续提升 definition 页的高级体验。

### 2.1 第一步：完成 Cards 的 Web 管理页

目标：让 card 作为独立资源被查看、编辑、校验，而不是继续靠改 `cards.json`。

建议页面能力：

#### A. Card 列表页

建议按 workflow type 分组展示：

- workflow type
- card key
- pattern
- header title
- 是否含 form
- action 数量

对应接口：

- `GET /api/cards`

#### B. Card 编辑页

建议支持：

- 选择 workflow type
- 新建/编辑 card key
- 编辑 pattern
- 编辑 header
- 编辑 body template
- 编辑 actions
- 编辑 form fields

第一版建议仍用表单式编辑，不做 card 所见即所得设计器。

#### C. Card 校验与预览

前端建议在保存前展示：

- schema 校验结果
- 渲染预览（后续可补）

当前后端已支持保存时做 schema 校验：

- `POST /api/cards`

建议后续可补充更细粒度接口，例如：

- 单张 card 保存
- 单张 card 预览
- 按 workflow type 增量保存

---

### 2.2 第二步：继续增强 Workflow Definitions 页面

目标：在已经可用的基础上，把 definition 管理页做得更稳、更顺手，而不是推倒重来。

建议优先增强：

#### A. 更强的发布前校验总览

当前已有局部字段级提示，但还缺：

- 全 definition 的引用校验摘要
- role / state / card / entry point 的统一错误列表
- 发布前风险汇总
- 更直接的定位入口

#### B. 更强的版本对比能力

当前已有行级 diff，但后续可以补：

- 结构级 diff
- 只看 states diff
- 只看 entry_points diff
- 只看 roles diff
- 指定两个历史版本对比

#### C. 更好的结构图能力

当前已有只读结构图，但后续可以补：

- transition 高亮
- 主链路与分支链路区分
- 从图上反向定位 transition inspector
- 节点布局优化

#### D. 更细的结构化编辑能力

当前 `roles / entry_points / states / status_labels` 已经结构化，但后续还可以补：

- channels 的更丰富编辑体验
- metadata 结构化编辑
- transition 子项拆分得更细
- 一键补默认模板

---

### 2.3 第三步：做可视化编辑器（先增强，再决定是否拖拽）

目标：在 workflow 管理页里提高编辑效率和可理解性，但仍控制复杂度。

建议不要立刻上 BPMN 式拖拽图编辑器，而是先继续把当前“结构化 + 图形只读”的模式打磨成熟。

建议演进路径：

#### A. Workflow 结构视图增强

在现有只读结构图基础上继续补：

- 更清晰的节点层次
- 过渡关系高亮
- entry point 标识强化
- terminal/system 节点语义强化

#### B. Transition Inspector / Graph 联动

让图和编辑器进一步联动：

- 点击 transition 直接编辑对应 transition
- 点击 entry point 定位到 entry point inspector
- 点击 role 使用点定位到 role inspector

#### C. 再评估是否需要拖拽

只有当下面这些都成熟后，再考虑是否上拖拽：

- cards 管理页完成
- definition 结构化编辑稳定
- 图与 inspector 联动顺手
- 校验与发布流程顺畅

否则过早上拖拽，复杂度会大于收益。

---

## 3. 推荐执行顺序

建议按下面顺序推进，不建议跳步：

### Phase 1

先完成 cards 管理页：

- 列表
- 编辑
- 校验
- 预览（至少预留位置）

原因：workflow definitions 管理页已经能用了，当前最大的缺口已经切换到 cards。

### Phase 2

继续增强 workflow definitions 管理页：

- 发布前校验总览
- 更强 diff
- 更细结构图联动
- 更强结构化编辑体验

原因：definition 页现在是“可用但仍可增强”的状态，适合在 cards 页面补完后继续打磨。

### Phase 3

最后再评估可视化编辑器：

- 先强化结构化 + 图形联动
- 暂不急于做拖拽图形编排

原因：现在最重要的是把资源管理与发布体验跑通，而不是过早挑战最复杂的 UI。

---

## 4. 当前建议的近期目标

如果下一会话继续执行，我建议直接从下面顺序开始：

1. 做 cards web 管理页
   - 列表 / 编辑 / 校验
2. 补 cards 预览能力
   - schema 校验结果
   - card 渲染预览
3. 回到 workflow definitions 页做增强
   - 发布前校验总览
   - 更强 version compare
   - 图与 inspector 联动增强

这三步做完之后，再考虑更进一步的：

- definition 结构级 diff
- compiled preview 更细粒度展示
- 运行实例与 definition version 绑定展示
- transition 图上编辑
- 拖拽式编辑器

---

## 5. 一句话总结

当前底层已经具备：

- card 独立资源化
- workflow definition 独立化
- compiler 编译层
- publish 版本模型
- web 管理 API

当前前端已经具备：

- workflow definitions 管理页
- draft 保存 / 发布 / 版本复制
- roles / entry_points / states / status_labels 结构化编辑
- compile preview
- diff 视图
- 只读结构图

所以下一步不该再从 workflow definitions 页面重新起步，而应该转向：

1. cards 管理页
2. cards 预览与校验体验
3. workflow definitions 页的增强项
