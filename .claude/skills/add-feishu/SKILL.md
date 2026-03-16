---
name: add-feishu
description: Add Feishu (飞书) as a channel. Supports message send/receive and group chat trigger. Use when adding Feishu as a messaging channel for NanoClaw.
---

# Add Feishu Channel

This skill adds Feishu (飞书) support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/feishu.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Create Feishu Channel

Create `src/channels/feishu.ts` with the following structure:

```typescript
import axios from 'axios';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel } from './registry.js';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const FEISHU_API_BASE_V2 = 'https://open.feishu.cn/open-apis/v2';

interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
}

class FeishuChannel implements Channel {
  name = 'feishu';
  private config: FeishuConfig;
  private token: string | null = null;
  private tokenExpiry: number = 0;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private connected = false;

  constructor(
    config: FeishuConfig,
    opts: { onMessage: OnInboundMessage; onChatMetadata: OnChatMetadata; registeredGroups: () => Record<string, RegisteredGroup> }
  ) {
    this.config = config;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    await this.getTenantAccessToken();
    this.connected = true;
  }

  async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiry) {
      return this.token;
    }

    const response = await axios.post(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to get tenant access token: ${response.data.msg}`);
    }

    this.token = response.data.tenant_access_token;
    this.tokenExpiry = now + response.data.expire * 1000 - 60000; // 1 minute buffer
    return this.token!;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const receiveIdType = jid.startsWith('ou_') ? 'user_id' : 'chat_id';

    await axios.post(
      `${FEISHU_API_BASE_V2}/im/v1/messages`,
      {
        receive_id_type: receiveIdType,
        receive_id: jid,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ou_') || jid.startsWith('oc_');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  // Handle inbound messages from Feishu webhook
  handleWebhook(payload: any): void {
    // Event types: im.message.receive_v1
    const event = payload.event;
    if (!event || event.type !== 'im.message.receive_v1') {
      return;
    }

    const message = event.message;
    const chatJid = message.chat_id;
    const senderId = message.sender_id?.user_id;
    const content = JSON.parse(message.content || '{}');

    // Skip bot's own messages
    const groups = this.registeredGroups();
    const isMainGroup = Object.values(groups).some(g => g.isMain && g.jid === chatJid);
    if (!isMainGroup) {
      // Check for trigger pattern
      const triggerPattern = /^@[^ ]+/;
      if (!triggerPattern.test(content.text || '')) {
        return; // No trigger, skip
      }
    }

    this.onMessage(chatJid, {
      sender: senderId || 'unknown',
      content: (content.text || '').replace(/^@[^ ]+\s*/, ''), // Remove trigger
      timestamp: message.create_time,
    });

    this.onChatMetadata(chatJid, message.create_time);
  }
}

export function createFeishuChannel(
  config: FeishuConfig,
  opts: { onMessage: OnInboundMessage; onChatMetadata: OnChatMetadata; registeredGroups: () => Record<string, RegisteredGroup> }
): Channel | null {
  if (!config.appId || !config.appSecret) {
    return null;
  }
  return new FeishuChannel(config, opts);
}

// Self-registration
registerChannel('feishu', (opts) => {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY;

  if (!appId || !appSecret) {
    return null;
  }

  return createFeishuChannel(
    { appId, appSecret, verificationToken, encryptKey },
    opts
  );
});
```

### Add import to barrel file

Add to `src/channels/index.ts`:

```typescript
// feishu
```

### Add environment variables

Add to `.env.example`:

```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
FEISHU_VERIFICATION_TOKEN=xxxxx
FEISHU_ENCRYPT_KEY=xxxxx (optional)
```

### Install dependencies

```bash
npm install axios
npm run build
```

## Phase 3: Setup

### Create Feishu App

Tell the user:

> 你需要创建一个飞书企业自建应用：
>
> 1. 打开 https://open.feishu.cn/ 并登录
> 2. 进入"应用管理" -> "创建应用"
> 3. 输入应用名称（如 "NanoClaw Assistant"）
> 4. 创建后，在"应用凭证"页面获取 App ID 和 App Secret
> 5. 在"权限管理"中添加以下权限：
>    - `im:message:send_as_bot` - 发送消息
>    - `im:message:receive` - 接收消息
>    - `im:chat:readonly` - 获取群聊信息
> 6. 在"发布管理"中发布应用
> 7. 在群聊中添加入应用（需要管理员权限）

Wait for the user to provide App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<their-app-id>
FEISHU_APP_SECRET=<their-app-secret>
FEISHU_VERIFICATION_TOKEN=<their-verification-token>
```

### Set up webhook

Tell the user:

> 你需要配置消息接收 webhook：
>
> 1. 在飞书应用管理中，进入"事件订阅"页面
> 2. 点击"添加事件"，选择 `im.message.receive_v1`
> 3. 设置请求 URL 为你的服务器地址：`https://your-domain.com/webhook/feishu`
> 4. 点击"发布"保存

### Sync to container environment

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. 将应用添加到飞书群聊
> 2. 在群聊中发送一条消息
> 3. 查看应用收到的 webhook 消息，chat_id 就是群聊 ID（格式：oc_xxxxx）

Wait for the chat ID (format: `oc_xxxxxxxx`).

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "feishu:<chat-id>" --name "<chat-name>" --folder "feishu_main" --trigger "@${ASSISTANT_NAME}" --channel feishu --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "feishu:<chat-id>" --name "<chat-name>" --folder "feishu_<group-name>" --trigger "@${ASSISTANT_NAME}" --channel feishu
```

## Phase 5: Verify

### Test the connection

Tell the user:

> 发送一条消息到你的飞书群聊：
> - 主聊天：任何消息都可以
> - 非主聊天：需要 @机器人名字

The bot should respond within a few seconds.

### Check logs

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite
3. For non-main chats: message includes trigger pattern
4. Service is running

### Webhook not working

Verify:
1. URL is accessible from the internet (需要公网可访问)
2. Verification token matches
3. Events are properly subscribed

## After Setup

If running `npm run dev` while the service is active:

```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts`
2. Remove `// feishu` from `src/channels/index.ts`
3. Remove `FEISHU_*` from `.env`
4. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"`
5. Uninstall: `npm uninstall axios`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
