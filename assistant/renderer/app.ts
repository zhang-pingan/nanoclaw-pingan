type AgentInboxItem = {
  id: string;
  kind: string;
  status: string;
  priority: string;
  title: string;
  body: string | null;
  action_kind: string | null;
  action_label: string | null;
  action_url: string | null;
};

type AssistantSettings = {
  enabled: boolean;
  desktopAssistant: {
    alwaysOnTop: boolean;
    allowMovement: boolean;
  };
};

type AssistantState = {
  settings: AssistantSettings;
  latestInboxItems: AgentInboxItem[];
};

type AssistantChatMessage = {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
};

declare global {
  interface Window {
    assistantHost?: {
      getWebToken: () => Promise<string>;
      openWorkstation: (target?: string) => Promise<void>;
      setAlwaysOnTop: (enabled: boolean) => Promise<void>;
      moveBy: (dx: number, dy: number) => Promise<void>;
      hide: () => Promise<void>;
      platform: string;
    };
  }
}

const API_BASE = 'http://localhost:3000';
const shell = document.getElementById('assistant-shell') as HTMLElement;
const bubbleKicker = document.getElementById('bubble-kicker') as HTMLElement;
const bubbleTitle = document.getElementById('bubble-title') as HTMLElement;
const bubbleBody = document.getElementById('bubble-body') as HTMLElement;
const bubbleActions = document.getElementById('bubble-actions') as HTMLElement;
const assistantStatus = document.getElementById('assistant-status') as HTMLElement;
const hideBtn = document.getElementById('hide-btn') as HTMLButtonElement;
const chatLog = document.getElementById('chat-log') as HTMLElement;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
const chatSend = document.getElementById('chat-send') as HTMLButtonElement;
const chatStatus = document.getElementById('chat-status') as HTMLElement;

let webToken = '';
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let state: AssistantState | null = null;
let movingTimer: number | null = null;
let chatMessages: AssistantChatMessage[] = [];
let chatTyping = false;

function setConnectionState(connected: boolean): void {
  shell.classList.toggle('connected', connected);
  assistantStatus.textContent = connected ? 'online' : 'offline';
}

function activeInboxItems(): AgentInboxItem[] {
  return (state?.latestInboxItems || []).filter(
    (item) => item.status !== 'done' && item.status !== 'dismissed',
  );
}

function primaryItem(): AgentInboxItem | null {
  const items = activeInboxItems().filter((item) => item.status !== 'snoozed');
  return items[0] || null;
}

async function headers(): Promise<Record<string, string>> {
  if (!webToken && window.assistantHost?.getWebToken) {
    webToken = await window.assistantHost.getWebToken();
  }
  return {
    'Content-Type': 'application/json',
    ...(webToken ? { Authorization: `Bearer ${webToken}` } : {}),
  };
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(await headers()),
      ...(options.headers || {}),
    },
  });
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.className = className;
  el.addEventListener('click', onClick);
  return el;
}

function renderIdle(): void {
  shell.classList.remove('attention');
  bubbleKicker.textContent = 'Personal Assistant';
  bubbleTitle.textContent = state?.settings.enabled ? '当前没有新的主动事项' : '个人助手已暂停';
  bubbleBody.textContent = state?.settings.enabled
    ? '我会继续观察今日计划、工作台任务、定时任务和 Agent 执行状态。'
    : '可以在 Web 工作站的个人助手页重新启用。';
  bubbleActions.innerHTML = '';
  bubbleActions.append(
    button('打开工作站', 'primary', () =>
      window.assistantHost?.openWorkstation(`${API_BASE}/?assistantTarget=assistant`),
    ),
  );
}

function renderItem(item: AgentInboxItem): void {
  shell.classList.add('attention');
  bubbleKicker.textContent = `${item.kind} · ${item.priority}`;
  bubbleTitle.textContent = item.title || '新的主动事项';
  bubbleBody.textContent = item.body || '我发现了一条需要关注的信息。';
  bubbleActions.innerHTML = '';

  if (item.action_url) {
    bubbleActions.append(
      button('查看', 'primary', () => {
        window.assistantHost?.openWorkstation(item.action_url || undefined);
        void runInboxAction(item.id, 'mark_read');
      }),
    );
  }

  if (item.action_kind === 'create_today_plan' || item.action_kind === 'continue_today_plan') {
    bubbleActions.append(
      button(item.action_label || '执行', '', () => {
        void runInboxAction(item.id, 'execute');
      }),
    );
  }

  bubbleActions.append(
    button('稍后', '', () => {
      void runInboxAction(item.id, 'snooze', { minutes: 60 });
    }),
    button('忽略', '', () => {
      void runInboxAction(item.id, 'dismiss');
    }),
  );
}

function render(): void {
  const item = primaryItem();
  if (!item) {
    renderIdle();
    return;
  }
  renderItem(item);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderChat(): void {
  chatLog.innerHTML = chatMessages
    .map((message) => {
      const klass = message.isFromMe ? 'user' : 'bot';
      return `<div class="chat-message ${klass}">${escapeText(message.content)}</div>`;
    })
    .join('');
  chatStatus.textContent = chatTyping ? 'Agent 正在回复...' : '';
  chatLog.scrollTop = chatLog.scrollHeight;
}

function upsertChatMessage(message: AssistantChatMessage): void {
  const index = chatMessages.findIndex((item) => item.id === message.id);
  if (index >= 0) chatMessages[index] = message;
  else chatMessages.push(message);
  if (chatMessages.length > 80) {
    chatMessages = chatMessages.slice(-80);
  }
  renderChat();
}

async function loadState(): Promise<void> {
  try {
    const res = await apiFetch('/api/assistant/state');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = (await res.json()) as AssistantState;
    setConnectionState(true);
    void window.assistantHost?.setAlwaysOnTop(
      state.settings.desktopAssistant.alwaysOnTop,
    );
    render();
    scheduleMovement();
  } catch {
    setConnectionState(false);
    bubbleKicker.textContent = 'Connection';
    bubbleTitle.textContent = '无法连接 NanoClaw';
    bubbleBody.textContent = '请确认主服务和 Web 工作站正在运行。';
    bubbleActions.innerHTML = '';
    bubbleActions.append(button('重试', 'primary', () => void loadState()));
  }
}

async function loadChat(): Promise<void> {
  try {
    const res = await apiFetch('/api/assistant/chat?limit=80');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { messages?: AssistantChatMessage[] };
    chatMessages = Array.isArray(data.messages) ? data.messages : [];
    renderChat();
  } catch {
    chatStatus.textContent = '聊天记录加载失败';
  }
}

async function sendChatMessage(content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  chatSend.disabled = true;
  try {
    const res = await apiFetch('/api/assistant/chat/message', {
      method: 'POST',
      body: JSON.stringify({ content: trimmed }),
    });
    const data = (await res.json()) as {
      message?: AssistantChatMessage;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.message) upsertChatMessage(data.message);
    chatInput.value = '';
    chatStatus.textContent = '已发送';
  } catch (err) {
    chatStatus.textContent =
      err instanceof Error ? err.message : '发送失败';
  } finally {
    chatSend.disabled = false;
  }
}

async function runInboxAction(
  itemId: string,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const res = await apiFetch('/api/agent-inbox/action', {
    method: 'POST',
    body: JSON.stringify({ item_id: itemId, action, payload }),
  });
  if (!res.ok) {
    bubbleBody.textContent = '动作执行失败，请到工作站查看详情。';
  }
  await loadState();
}

async function connectWs(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const token = webToken || (await window.assistantHost?.getWebToken?.()) || '';
  webToken = token;
  const wsUrl = token
    ? `ws://localhost:3000/ws?token=${encodeURIComponent(token)}`
    : 'ws://localhost:3000/ws';
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setConnectionState(true);
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
  ws.onclose = () => {
    setConnectionState(false);
    ws = null;
    reconnectTimer = window.setTimeout(() => void connectWs(), 3000);
  };
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        state?: AssistantState;
        event?: {
          type?: string;
          message?: AssistantChatMessage;
          typing?: boolean;
        };
      };
      if (message.type === 'assistant_state' && message.state) {
        state = message.state;
        render();
      }
      if (message.type === 'assistant_event') {
        if (message.event?.type === 'data_cleared') {
          chatMessages = [];
          chatTyping = false;
          renderChat();
          void loadState();
          return;
        }
        if (
          message.event?.type === 'chat_message' &&
          message.event.message
        ) {
          upsertChatMessage(message.event.message);
          chatTyping = false;
          renderChat();
          return;
        }
        if (message.event?.type === 'chat_typing') {
          chatTyping = Boolean(message.event.typing);
          renderChat();
          return;
        }
        void loadState();
      }
    } catch {
      // Ignore malformed realtime payloads.
    }
  };
}

function scheduleMovement(): void {
  if (movingTimer) window.clearInterval(movingTimer);
  if (!state?.settings.desktopAssistant.allowMovement) return;
  movingTimer = window.setInterval(() => {
    if (document.body.matches(':hover')) return;
    const dx = Math.round((Math.random() - 0.5) * 48);
    const dy = Math.round((Math.random() - 0.5) * 30);
    void window.assistantHost?.moveBy(dx, dy);
  }, 18_000);
}

hideBtn.addEventListener('click', () => {
  void window.assistantHost?.hide();
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendChatMessage(chatInput.value);
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  void sendChatMessage(chatInput.value);
});

void loadState();
void loadChat();
void connectWs();
window.setInterval(() => void loadState(), 60_000);
