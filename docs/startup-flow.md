# NanoClaw 启动和消息处理流程

## 1. 启动顺序

```
launchd 启动 dist/index.js  (plist: ~/Library/LaunchAgents/com.nanoclaw.plist)
  │
  ├─ 1. 容器系统检查
  │     ensureContainerSystemRunning()  → 检查 Docker 是否运行
  │     cleanupOrphans()                → 清理孤立容器
  │
  ├─ 2. 数据库初始化
  │     initDatabase()                  → 初始化 SQLite (store/messages.db)
  │     loadState()                     → 恢复消息游标、会话 ID 等
  │
  ├─ 3. 凭证代理启动 (端口 3001)
  │     从 .env 读取 ANTHROPIC_API_KEY / BASE_URL
  │     容器通过代理访问 API，永远看不到真实密钥
  │
  ├─ 4. 频道连接
  │     遍历已注册频道 → 从 .env 读取凭据 → 创建实例 → connect()
  │     飞书：启动 Webhook 服务器 (端口 3002)
  │
  ├─ 5. 子系统启动
  │     任务调度器   → 每 60s 检查到期任务
  │     IPC 监听器   → 每 1s 扫描 IPC 文件
  │     恢复待处理消息
  │
  └─ 6. 消息轮询循环 (每 2s)
        永久运行，检查新消息
```

## 2. 消息处理链路

```
用户在飞书发消息
  ↓
飞书服务器 → Cloudflare Tunnel → localhost:3002/webhook/feishu
  ↓
FeishuChannel.handleWebhook() → 存入 SQLite messages 表
  ↓
消息轮询 (每 2s) → getNewMessages() 发现新消息
  ↓
检查触发词 (主群不需要，非主群需要 @Andy)
  ↓
格式化为 XML → 入队到 GroupQueue
  ↓
┌─ 容器已活跃？ → 通过 IPC 管道消息（复用容器）
└─ 否 → 启动新容器
         docker run nanoclaw-agent:latest
         挂载: 项目(ro), 群组目录(rw), .claude(rw), IPC(rw)
         环境: ANTHROPIC_BASE_URL=http://host.docker.internal:3001
  ↓
容器内 agent-runner 启动
  读取 stdin JSON → 加载 CLAUDE.md → 调用 Claude Agent SDK query()
  模型由 data/sessions/{group}/.claude/settings.json 决定
  API 请求经凭证代理转发到实际 API 端点
  ↓
流式输出 (---NANOCLAW_OUTPUT_START/END---)
  ↓
宿主机实时解析 → channel.sendMessage() → 飞书 API → 用户收到回复
```

## 3. 凭证代理

容器从不接触真实密钥。请求链路：

```
容器 SDK (ANTHROPIC_BASE_URL=http://host.docker.internal:3001)
  ↓ 携带 placeholder API key
凭证代理 (127.0.0.1:3001)
  ↓ 注入真实 x-api-key，转发到上游
上游 API (ANTHROPIC_BASE_URL，默认 https://api.anthropic.com)
  ↓ 响应
凭证代理 → 容器 SDK
```

## 4. 频道自注册机制

```typescript
// src/channels/index.ts — barrel 文件，导入时触发注册
import './feishu.js';

// src/channels/feishu.ts — 自注册
registerChannel('feishu', (opts) => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET', ...]);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return null; // 凭据缺失则跳过
  return new FeishuChannel(env, opts);
});
```

启动时遍历所有已注册频道，工厂函数返回 null 则跳过，否则调用 `channel.connect()`。

## 5. 容器挂载结构

```
主机路径                                    容器路径                 权限
─────────────────────────────────────────────────────────────────────
项目根目录/                                 /workspace/project       ro
项目根目录/.env → /dev/null                 /workspace/project/.env  ro (隐藏)
groups/{folder}/                            /workspace/group         rw
data/sessions/{folder}/.claude/             /home/node/.claude       rw
data/ipc/{folder}/                          /workspace/ipc           rw
data/sessions/{folder}/agent-runner-src/    /app/src                 rw
```

容器入口 entrypoint.sh 在运行时从 /app/src 编译 TypeScript → /tmp/dist，然后执行。

## 6. 容器队列管理

- 最大并发容器数：5（`MAX_CONCURRENT_CONTAINERS`）
- 容器活跃时新消息通过 IPC 管道发送，避免重新启动
- 容器空闲超时：30 分钟（`IDLE_TIMEOUT`）
- 容器硬超时：30 分钟（`CONTAINER_TIMEOUT`）
- 超出并发限制的请求排队等待

```
容器生命周期：
启动 → 处理消息 → 收到 notifyIdle
  ├─ 有待处理消息？ → 通过 IPC 发送，继续处理
  ├─ 有待处理任务？ → 关闭 stdin，容器结束
  └─ 无 → 等待 IDLE_TIMEOUT 后自动关闭
```

## 7. IPC 通信

容器通过文件系统与宿主机通信：

| 目录 | 方向 | 用途 |
|------|------|------|
| `/workspace/ipc/input/` | 宿主机 → 容器 | 新消息推送 |
| `/workspace/ipc/messages/` | 容器 → 宿主机 | 发送消息到其他群组 |
| `/workspace/ipc/tasks/` | 容器 → 宿主机 | 创建/管理定时任务 |

宿主机每 1 秒扫描一次 IPC 目录。非主群只能操作自己的群组，主群可以操作任何群组。

## 8. 任务调度器

每 60 秒检查 `scheduled_tasks` 表中到期的任务（`next_run <= now && status = 'active'`）。

支持三种调度类型：
- `cron`: cron 表达式（如 `0 9 * * *`）
- `interval`: 毫秒间隔
- `once`: 一次性任务

任务执行与消息处理共用容器队列和并发限制。

## 9. 关键配置文件

| 文件 | 控制什么 | 修改后需要 |
|------|----------|-----------|
| `.env` | API 密钥、频道凭据、BASE_URL | 重启服务 |
| `data/sessions/{group}/.claude/settings.json` | 容器内模型、SDK 环境变量 | 下次容器启动生效 |
| `groups/{group}/CLAUDE.md` | 群组记忆（容器内可读写） | 下次容器启动生效 |
| `store/messages.db` | 消息历史、已注册群组、定时任务 | 实时生效 |
| `~/Library/LaunchAgents/com.nanoclaw.plist` | launchd 服务配置 | unload + load |

## 10. 关键超时和常量

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `POLL_INTERVAL` | 2s | 消息轮询间隔 |
| `SCHEDULER_POLL_INTERVAL` | 60s | 任务调度检查 |
| `IPC_POLL_INTERVAL` | 1s | IPC 文件检查 |
| `CONTAINER_TIMEOUT` | 30 min | 容器硬超时 |
| `IDLE_TIMEOUT` | 30 min | 容器空闲超时 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 最大并发容器数 |
| `CREDENTIAL_PROXY_PORT` | 3001 | 凭证代理端口 |
| `MAX_RETRIES` | 5 | 消息处理重试上限（指数退避） |

## 11. 数据库核心表

```sql
chats              -- 聊天元数据（JID、名称、频道）
messages           -- 消息历史（按 timestamp 排序，游标查询）
registered_groups  -- 已注册群组（JID、文件夹、触发词、是否主群）
scheduled_tasks    -- 定时任务（cron/interval/once）
task_run_logs      -- 任务执行日志
router_state       -- 路由状态（消息游标等）
sessions           -- Claude 会话 ID 持久化
```

## 12. 服务管理

```bash
# 重启
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 停止
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# 启动
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# 查看日志
tail -f logs/nanoclaw.log
```
