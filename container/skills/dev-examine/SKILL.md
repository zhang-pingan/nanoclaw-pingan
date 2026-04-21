---
name: dev-examine
description: Review implemented code against approved plan, perform code review, and return pass/fail with actionable fixes.
---

# 开发复核 Skill

本技能用于“开发完成后”的复核，不负责主实现。

## 目标

对开发产出做独立复核，明确：
- 实际实现是否与方案一致
- 代码质量与可维护性是否达标
- 是否存在阻断上线的风险

## 复核流程

1. 从任务描述中获取方案文件路径，方案文档: `/workspace/projects/{服务名}/iteration/{文件夹名}/plan.md` , 开发交付文档: `/workspace/projects/{服务名}/iteration/{文件夹名}/dev.md`
   确认目标范围与约束；如果文档缺失则停止进行并使用`complete_delegation` 回传结果（`outcome=failure`）
2. 根据服务名获取服务配置文件路径`repo_path`，进入仓库目录`/workspace/repos/{repo_path}`，检出并更新`工作分支`
3. 对照实现进行一致性检查（功能点、接口、数据结构、异常路径）
4. 执行代码审查，重点关注：
   - 明显逻辑缺陷与边界遗漏
   - 可读性与可维护性问题
   - 潜在性能/安全/兼容性风险
   - 测试覆盖是否支撑改动范围
5. 给出复核结论：
   - 通过：可进入部署确认
   - 不通过：需修复后再复核
6. 输出可执行修复建议（尽量定位到文件/模块/问题点）
7. 使用 `complete_delegation` 回传结果，如果通过回复`success`,不通过返回`failure`（`outcome=success` 或 `outcome=failure`）

## 输出格式

```markdown
*开发复核结果*

结论：{通过 / 不通过}

总体评价：
• {一句话总结}

一致性检查：
1. {与方案一致/不一致点}
2. {与方案一致/不一致点}

代码审查问题（按优先级）：
1. {问题}
2. {问题}
3. {问题}

修复建议：
1. {建议}
2. {建议}
3. {建议}
```

## 原则

- 结论先行，问题可追踪，可落地
- 优先暴露阻断部署的高风险问题
- 不替代开发执行，专注审核与把关
