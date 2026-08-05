# 未闭合叶子 / 合成 close 级联（空回复排查与修复）

> 适用症状：**个人助手（或任意 agent）调用多次、回复全为空、用户收不到任何回应，但 Trace Monitor 上这些 query 全记 `success`、无 error、无告警。**
>
> 本文记录根因、诊断步骤、已实施修复，以及一个**已知残留**（Skill-load 留叶子）的条件化改法。后续再遇到"跑完没回复"先按本文排查。

相关条目见 [DEBUG_CHECKLIST.md](./DEBUG_CHECKLIST.md) 第 1 条（resume 锚定到 stale tree）——本问题与之同属"SDK 会话叶子"层面的故障族。

---

## 1. 名词：什么是"未闭合叶子"

Claude Agent SDK 把一次会话存成消息树（`data/sessions/{agent}/.claude/projects/-workspace-agent/{sessionId}.jsonl`，每行一个节点）。resume 时从树的**最末节点（叶子）**接着走。

- **已闭合**：末端是一条 **`stop_reason ∈ {end_turn, stop_sequence, max_tokens}`** 的 assistant 消息 —— 稳定静止态。
- **未闭合**：末端停在 user / `tool_result` 节点之后无 assistant，或最后一条 assistant 是 `stop_reason=tool_use`（在等工具/待续）却没有后续闭合回合。

**关键认知：未闭合叶子在 SDK 侧不是异常。** SDK 自带 resume 恢复（注入合成 `Continue from where you left off.`），`SDKUserMessage.shouldQuery:false` 还允许"故意追加消息不触发回合"。被打断 / abort / mid-turn 接新消息也会合法地留下未闭合叶子。它只是一个可恢复的正常中间态。

但在 **host 侧**（职责是"用户那次请求有没有完成"）——一轮**未被打断**就结束、却既没产出回答又留下悬空叶子 = **一个被起头又被丢弃的未完成任务**，属于异常。两个判断主体的结论不同，这点要分清。

---

## 2. 根因：合成 close 把级联踩起来

真实 transcript 复盘（`8bb6126e…jsonl`，#653-#662）：

1. agent 调 `Skill`(devops) 工具加载技能（#653 `stop_reason=tool_use`），技能正文作为 user 注入（#655），**该轮没产出回答就结束** → 留下未闭合叶子。
2. 下一条消息 resume 时，SDK 先注入合成 user `Continue from where you left off.`（`SDKUserMessage.isSynthetic===true`，#660），模型回 `No response requested.`（#661，`stop_reason=stop_sequence`）→ 发出一条 **`SDKResultSuccess`**（subtype=success）。
3. `iterateQuery` 在**第一个** `result` 上就 `stream.end()`（旧逻辑，`container/agent-runner/src/index.ts`）——于是这条**合成 close 被当成了"对新消息的回答"**，SDK 还没处理真正排队的新消息就退出 → **新消息变成下一个未闭合叶子**。级联自我延续，条条为空。
4. host 侧：该轮无可下发文本（`result=null`），随后正常的会话标记 `{status:'success', result:null}` 触发 `finishMessageQueryTrace(...,'success')`（`src/index.ts`）→ 全记 **success / `output_preview="Completed without channel output"`**，`failure_type` 空，监控看不出来。

### 为什么 trace 不报 error（务必理解，否则会误判"系统正常"）

| 子情况 | 触发 | trace 表现 |
| --- | --- | --- |
| **完全没 result**（`resultCount===0`） | SDK stream 直接结束 | 走 `missingSdkResult` → 发 `model_request_failed` + `writeOutput({status:'error'})` → **红** |
| **发了合成空 result**（`resultCount≥1`） | resume 闭合旧叶子的 `No response requested.` | 不算 missingSdkResult，文本空不下发；会话标记把 trace 收成 **success** → **绿、看不出** |

同样是"跑完没回复"，会不会红，取决于 SDK 这次是"发了合成空 result"还是"啥都没发"——这是**时灵时不灵**的来源。

---

## 3. 诊断步骤（命令可直接跑）

```bash
cd /Users/chelaile/IdeaProjects/icarus

# A. DB：找"绿着的空回复" —— success 但从未下发 channel 文本
sqlite3 -header -column store/messages.db "
  SELECT substr(id,1,8) id, status, failure_type,
         substr(output_preview,1,32) output_preview, current_phase
  FROM agent_queries
  WHERE agent_folder='assistant_main'
  ORDER BY created_at DESC LIMIT 15;"
# 信号：连续多条 status=success / output_preview='Completed without channel output' / failure_type 空

# B. 日志：合成 close 被当答复的特征
grep -nE "Result #1: subtype=success.*No response requested|Skipping (event|output) for inactive query trace" logs/icarus.log | tail

# C. transcript：直接看末节点闭没闭合
f=$(ls -t data/sessions/assistant_main/.claude/projects/-workspace-agent/*.jsonl | head -1)
python3 - "$f" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
for o in rows[-8:]:
    m=o.get('message',{}) if isinstance(o.get('message'),dict) else {}
    print(o.get('type'), '| role=',m.get('role'),'| stop_reason=',m.get('stop_reason'))
PY
# 信号：末尾出现 user "Continue from where you left off." → assistant "No response requested.";
#       或最后一条 assistant 是 stop_reason=tool_use / 末节点是 user 无后续 assistant = 未闭合
```

修复后应看到（容器 `[agent-runner]` 日志，debug 级别）：

```
Synthetic "Continue from where you left off" user message observed ...
Skipping synthetic leaf-close result (skips=1/1, detectedBy=synthetic_user|result_shape); ...
Result #N: subtype=success ...   ← 第二条、对新消息的真答复
```

---

## 4. 已实施的修复（2026-05）

### ① 止级联 —— `container/agent-runner/src/index.ts`

`iterateQuery` 不再"见第一个 result 就 `stream.end()`"，而是先识别"合成 leaf-close result"并跳过：

- **新增 `isSyntheticUserMessage(m)`**：`m.type==='user' && m.isSynthetic===true`（运行时对象带 `isSynthetic`，本地窄接口不必动）。
- **`iterateQuery` 加 `type==='user'` 分支**：见到合成 user → 置 `syntheticCloseSeen=true`。
- **result 分支判"合成 close"**：
  - 主判据：`syntheticCloseSeen===true`；
  - 兜底判据（防 push 模式下消费循环收不到 synthetic user，**独立启用**）：`subtype==='success' && num_turns<=1 && stop_reason==='stop_sequence' && /^no response requested\.?$/i.test(result)`。
  - 命中且 `syntheticSkips < MAX_SYNTHETIC_SKIPS(=1)`：发 `unclosed_leaf_resumed` 信息事件、**不下发、不 end_stream、`continue`**，让 SDK 继续回答真正的新消息。
  - **hang-safety**：最多跳过 1 次；第二条仍像 close 的 result 落到正常分支结束，循环不挂死。
- 真答复（非空文本的 success result）置 `deliveredGenuineAnswer=true`，并在其上 `stream.end()`。

### ② unclosed_leaf 观测 —— agent-runner 检测 + host 复用错误链路

- **`readTranscriptTail(sessionId)`**：读 .jsonl 末节点判闭合（终态 stop_reason 集合 `TERMINAL_STOP_REASONS`）。
- **`unclosed_leaf_left`**：`runQuery` 在 `!closedDuringQuery && !missingSdkResult && !deliveredGenuineAnswer && tail.unclosed` 时，`writeOutput({status:'error', failure:{failureType:'unclosed_leaf', failureSubtype:'abandoned_incomplete_task', failureOrigin:'model', retryable:true}})`。走 host 既有 error 链路 → `status='error'` + `failure_type='unclosed_leaf'`。
- **`unclosed_leaf_resumed`**：①里 skip 分支发的 `writeEvent`（lifecycle, status=success）。**纯信息**，当前 query 仍 success（它其实成功回答了新消息）。
- **`src/failure-taxonomy.ts`**：`FailureType` 加 `'unclosed_leaf'`。其余复用既有链路——**不需要新列、不需要改 `queryPatchFromTraceEvent`、不需要改概览 SQL**（用 `status='error'` 天然不双重计数；新 failure_type 自动进 `topFailureTypes`、可被 `failureType` 过滤）。

### 定性约定（很重要，别破坏）

- **正常"没话说"的空回复**以 `end_turn` 收尾 = 已闭合 → `readTranscriptTail` 判 closed → **不**触发 `unclosed_leaf`、**不**标 error。所以本方案**不会误伤正常空回复**（这也是当初否掉"empty_output 兜底"的原因——那个分不清正常空回复）。
- `leaf_left` = host 侧真异常（任务起头即弃）→ error + failure_type。
- `leaf_resumed` = 已自愈（新消息被正常回答）→ 信息事件，不算失败。

---

## 5. 验证

```bash
npm run typecheck && (cd container/agent-runner && npx tsc --noEmit) && npm test
./container/build.sh
# 确认镜像含新代码（防 CLAUDE.md 提到的构建缓存残留）：
docker run --rm --entrypoint sh icarus-agent:latest -c "grep -c unclosed_leaf_resumed /app/src/index.ts /app/dist/index.js"
```

- 修复后：日志 `synthetic ... observed`（或兜底命中）→ `unclosed_leaf_resumed` → **第二条真答复 result** → 仅一次 `stream.end()`；用户收到回复。
- 留下问题叶子的那轮：DB `status='error'` / `failure_type='unclosed_leaf'`；出现在 `getAgentQueriesOverview().topFailureTypes`、`failureType` 可筛。
- 负向：正常 `end_turn` 空回复 → `failure_type` 为 NULL、不标 error。
- 被打断（`closedDuringQuery=true`）→ 不 emit leaf_left。

### 部署注意

- host 用 `docker run icarus-agent:latest`，**下一条消息的新容器即用新镜像**，①②容器侧行为即时生效，无需重启 host。
- `FailureType` 是**纯类型改动（运行时擦除）**，现行 host 进程已能把 `failure_type='unclosed_leaf'` 直接写库，不依赖重建 dist / 重启。

---

## 6. 已知残留：Skill-load 本身仍会留叶子（条件化改法）

① 只"事后恢复"级联，**没有消除 Skill-load 留叶子本身**：被 Skill 起头的那条原始问题（如 catstory 41006）在它自己那轮仍可能没被回答（合成 close 把它放弃了）。现在它会以 `leaf_left`(error/`failure_type=unclosed_leaf`) **可见**。result 分支已埋 `stop_reason/num_turns/synthSeen` 调查日志。

**要不要进一步改、怎么改，取决于线上复现确认的机制**：

### 先取证（看 Skill tool_use 之后）

- **分支 A**：Skill tool_use 后**紧跟一个 `result`**（subtype=success，text 多为空/寒暄）→ "技能加载即收尾"的 result 被 `stream.end()` 砍断。（最可能：历史上 `Agent marked idle` ~22s 就触发，说明发过会话标记 = 收到过 result。）
- **分支 B**：Skill tool_use 后**没有 result**、循环空转等 IPC → 技能正文以 `shouldQuery:false` 追加，SDK 不自动起回合。

### 分支 A 改法（推荐，最小延伸现有 ①）

`iterateQuery` 追踪"最近一次 assistant 是否调了 `Skill`"（现在只读 `.uuid`，要顺带读 content 的 tool_use 名）：

```ts
// assistant 分支：
const blocks = (message as any).message?.content;
if (Array.isArray(blocks))
  for (const b of blocks)
    if (b?.type === 'tool_use' && b?.name === 'Skill') skillJustLoaded = true;

// result 分支，与合成 close 并列：
const isSkillLoadBoundary =
  message.subtype === 'success' && skillJustLoaded && !(textResult && textResult.trim());
if ((isSyntheticClose || isSkillLoadBoundary) && nonGenuineSkips < MAX_NONGENUINE_SKIPS) {
  nonGenuineSkips++; skillJustLoaded = false;
  writeEvent({ name: isSkillLoadBoundary ? 'skill_load_continued' : 'unclosed_leaf_resumed', ... });
  continue;                       // 不下发、不 end_stream
}
// 产出真答复时 skillJustLoaded = false;
```

**待日志确认的关键点**：A 分支下，光"不 end_stream"够不够让 agent 接着用技能把话说完？
- 若 SDK 在 result 之后、流仍开着时会自动续上 → `continue` 就够。
- 若 SDK 只是干等下一条 push → 还要主动顶一脚：`stream.push('继续，使用刚加载的技能完成上面的请求。')`（封顶 1 次）。
看 `continue` 之后日志里还有没有新的 assistant/result 冒出来即可判定。

### 分支 B 改法

检测到"技能刚加载、N 个 poll 周期内没新回合"后，主动 `stream.push('继续，使用刚加载的技能…')` 触发回合，`skillNudges` 封顶 1 次防无限 nudge。

### 备选（更彻底但动架构）

不让 devops 走会产生回合边界的 `Skill` 工具，而是把核心入口说明 append 进 `buildQueryOptions` 的 `systemPrompt.append`，细节按需读文件——从源头消除 skill-load 回合边界。代价：丢掉懒加载省 token 的好处；改 `container/skills/devops` 的暴露方式。留作 A/B 都不稳时的后手。

---

## 7. 信号速查

| 信号 | 含义 | 处理 |
| --- | --- | --- |
| DB `status=success` + `output_preview='Completed without channel output'`（连续多条） | 正在级联、空回复 | 按 §3 取证，确认 ①是否生效 |
| 日志 `Result #1: subtype=success ... No response requested.` 紧跟 `stream.end()` | 旧 bug 特征（未修） | 镜像是否含 ① 修复（§5 校验） |
| 日志 `Skipping synthetic leaf-close result ... detectedBy=...` | ① 生效，正在恢复 | 正常；看 detectedBy 是 `synthetic_user`(主) 还是 `result_shape`(兜底) |
| DB `failure_type='unclosed_leaf'` | 某轮起头即弃（含 Skill-load 残留） | 若频繁→按 §6 取证决定是否扩 ① |
| 日志 `SDK query ended without result message` / `failure_type=model_output_invalid`(`agent_result_missing`) | `missingSdkResult`：SDK 一条 result 都没发 | 另一类未闭合，已是 error，可直接定位 |
