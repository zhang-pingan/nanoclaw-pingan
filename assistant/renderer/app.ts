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
  filePath?: string | null;
  fileUrl?: string | null;
};

declare global {
  interface Window {
    assistantHost?: {
      getWebToken: () => Promise<string>;
      openWorkstation: (target?: string) => Promise<void>;
      setAlwaysOnTop: (enabled: boolean) => Promise<void>;
      setChatOpen: (open: boolean) => Promise<void>;
      moveBy: (dx: number, dy: number) => Promise<void>;
      hide: () => Promise<void>;
      platform: string;
    };
  }
}

const API_BASE = 'http://localhost:3000';
const ASSISTANT_CHAT_JID = 'assistant:main';
const CHAT_AUTO_HIDE_DELAY_MS = 5_000;
const MASCOT_DRAG_HOLD_MS = 200;
const MASCOT_DRAG_CANCEL_DISTANCE_PX = 6;
const shell = document.getElementById('assistant-shell') as HTMLElement;
const bubbleKicker = document.getElementById('bubble-kicker') as HTMLElement;
const bubbleTitle = document.getElementById('bubble-title') as HTMLElement;
const bubbleBody = document.getElementById('bubble-body') as HTMLElement;
const bubbleActions = document.getElementById('bubble-actions') as HTMLElement;
const assistantChat = document.getElementById('assistant-chat') as HTMLElement;
const mascotTrigger = document.getElementById(
  'assistant-mascot-trigger',
) as HTMLElement;
const assistantStatus = document.getElementById(
  'assistant-status',
) as HTMLElement;
const hideBtn = document.getElementById('hide-btn') as HTMLButtonElement;
const chatLog = document.getElementById('chat-log') as HTMLElement;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
const chatSend = document.getElementById('chat-send') as HTMLButtonElement;
const chatStatus = document.getElementById('chat-status') as HTMLElement;
const pendingFilesEl = document.getElementById(
  'pending-files-preview',
) as HTMLElement;
const pendingFilesContent = document.getElementById(
  'pending-files-content',
) as HTMLElement;
const pendingFilesClose = document.getElementById(
  'pending-files-close',
) as HTMLButtonElement;
const fileDropZone = document.getElementById('file-drop-zone') as HTMLElement;

let webToken = '';
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let state: AssistantState | null = null;
let movingTimer: number | null = null;
let chatMessages: AssistantChatMessage[] = [];
let chatTyping = false;
let chatOpen = false;
let chatAutoHideTimer: number | null = null;
let mascotDragHoldTimer: number | null = null;
let mascotPointerId: number | null = null;
let mascotPressStartScreenX = 0;
let mascotPressStartScreenY = 0;
let mascotLastScreenX = 0;
let mascotLastScreenY = 0;
let mascotDragging = false;
let suppressNextMascotClick = false;
let pendingFiles: File[] = [];
let dragDepth = 0;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

function setConnectionState(connected: boolean): void {
  shell.classList.toggle('connected', connected);
  assistantStatus.textContent = connected ? 'online' : 'offline';
}

function clearChatAutoHideTimer(): void {
  if (!chatAutoHideTimer) return;
  window.clearTimeout(chatAutoHideTimer);
  chatAutoHideTimer = null;
}

function setChatOpen(open: boolean): void {
  if (chatOpen === open) {
    if (open) clearChatAutoHideTimer();
    return;
  }

  chatOpen = open;
  shell.classList.toggle('chat-open', chatOpen);
  assistantChat.setAttribute('aria-hidden', chatOpen ? 'false' : 'true');
  mascotTrigger.setAttribute('aria-expanded', chatOpen ? 'true' : 'false');
  void window.assistantHost?.setChatOpen(chatOpen);

  if (chatOpen) {
    clearChatAutoHideTimer();
    renderChat();
    void loadChat();
  } else {
    clearChatAutoHideTimer();
  }
}

function scheduleChatAutoHide(): void {
  if (!chatOpen) return;
  clearChatAutoHideTimer();
  chatAutoHideTimer = window.setTimeout(() => {
    setChatOpen(false);
  }, CHAT_AUTO_HIDE_DELAY_MS);
}

function clearMascotDragHoldTimer(): void {
  if (!mascotDragHoldTimer) return;
  window.clearTimeout(mascotDragHoldTimer);
  mascotDragHoldTimer = null;
}

function beginMascotWindowDrag(): void {
  if (mascotPointerId === null) return;
  clearMascotDragHoldTimer();
  clearChatAutoHideTimer();
  mascotDragging = true;
  suppressNextMascotClick = true;
  mascotTrigger.classList.add('dragging');
}

function resetMascotPointerState(): void {
  clearMascotDragHoldTimer();
  mascotPointerId = null;
  mascotDragging = false;
  mascotTrigger.classList.remove('dragging');
}

function suppressMascotClickForCurrentGesture(): void {
  suppressNextMascotClick = true;
  window.setTimeout(() => {
    suppressNextMascotClick = false;
  }, 0);
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

async function authorizationHeaders(): Promise<Record<string, string>> {
  if (!webToken && window.assistantHost?.getWebToken) {
    webToken = await window.assistantHost.getWebToken();
  }
  return webToken ? { Authorization: `Bearer ${webToken}` } : {};
}

async function headers(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    ...(await authorizationHeaders()),
  };
}

async function apiFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(await headers()),
      ...(options.headers || {}),
    },
  });
}

function button(
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
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
  bubbleTitle.textContent = state?.settings.enabled
    ? '当前没有新的主动事项'
    : '个人助手已暂停';
  bubbleBody.textContent = state?.settings.enabled
    ? '我会继续观察今日计划、工作台任务、定时任务和 Agent 执行状态。'
    : '可以在 Web 工作站的个人助手页重新启用。';
  bubbleActions.innerHTML = '';
  bubbleActions.append(
    button('打开工作站', 'primary', () =>
      window.assistantHost?.openWorkstation(
        `${API_BASE}/?assistantTarget=assistant`,
      ),
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

  if (
    item.action_kind === 'create_today_plan' ||
    item.action_kind === 'continue_today_plan'
  ) {
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

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function fileExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index + 1).toLowerCase() : '';
}

function apiUrl(path: string): string {
  if (!path) return '';
  if (/^(https?:|file:|blob:|data:)/i.test(path)) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

function encodeApiPathSegments(pathValue: string): string {
  return pathValue
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function workspaceFileApiPath(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const webUploadsMarker = '/data/web-uploads/';
  const webUploadsIndex = normalizedPath.lastIndexOf(webUploadsMarker);
  if (webUploadsIndex >= 0) {
    return `/api/uploads/${encodeApiPathSegments(
      normalizedPath.slice(webUploadsIndex + webUploadsMarker.length),
    )}`;
  }
  if (normalizedPath.startsWith('/workspace/uploads/')) {
    return `/api/uploads/${encodeApiPathSegments(
      normalizedPath.slice('/workspace/uploads/'.length),
    )}`;
  }
  return null;
}

function localFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((segment, index) => {
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join('/');
  return normalized.startsWith('/')
    ? `file://${encoded}`
    : `file:///${encoded}`;
}

function fileUrlForPath(filePath: string): string {
  const workspaceApiPath = workspaceFileApiPath(filePath);
  return workspaceApiPath ? apiUrl(workspaceApiPath) : localFileUrl(filePath);
}

function detectFilePathFromContent(content: string): string | null {
  const match =
    content.match(/(?:文件地址|文件路径|file path|path)[:：]\s*(.+)$/im) ||
    content.match(/^\s*文件[:：]\s*(.+)$/im);
  const value = match?.[1]?.trim().replace(/[。.,，\s]+$/, '') || '';
  if (!value || !/[\\/]/.test(value)) return null;
  return value;
}

function chatFileInfo(message: AssistantChatMessage): {
  fileName: string;
  extension: string;
  url: string;
} | null {
  const filePath =
    message.filePath || detectFilePathFromContent(message.content);
  if (!filePath && !message.fileUrl) return null;

  const fileName = basename(filePath || message.fileUrl || 'file');
  const extension = fileExtension(fileName);
  const url = filePath
    ? fileUrlForPath(filePath)
    : /^https?:\/\//i.test(message.fileUrl || '')
      ? message.fileUrl || ''
      : apiUrl(message.fileUrl || '');

  return { fileName, extension, url };
}

function openImagePreview(src: string, alt: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay no-drag';
  overlay.innerHTML = '<button type="button" aria-label="关闭">×</button>';

  const image = document.createElement('img');
  image.src = src;
  image.alt = alt;
  overlay.append(image);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target instanceof HTMLButtonElement) {
      overlay.remove();
    }
  });
  document.body.append(overlay);
}

function renderChat(): void {
  chatLog.innerHTML = '';
  for (const message of chatMessages) {
    const klass = message.isFromMe ? 'user' : 'bot';
    const el = document.createElement('div');
    el.className = `chat-message ${klass}`;

    if (message.content.trim()) {
      const text = document.createElement('div');
      text.className = 'chat-message-text';
      text.textContent = message.content;
      el.append(text);
    }

    const fileInfo = chatFileInfo(message);
    if (fileInfo && IMAGE_EXTENSIONS.has(fileInfo.extension)) {
      const image = document.createElement('img');
      image.className = 'chat-image-preview';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = fileInfo.url;
      image.alt = fileInfo.fileName;
      image.addEventListener('click', () => {
        openImagePreview(image.src, fileInfo.fileName);
      });
      el.append(image);
    } else if (fileInfo) {
      const file = document.createElement('div');
      file.className = 'chat-file-chip';
      file.textContent = fileInfo.fileName;
      el.append(file);
    }

    if (!el.childElementCount) {
      el.textContent = '无内容';
    }

    chatLog.append(el);
  }
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
  if (!trimmed && pendingFiles.length === 0) return;

  chatSend.disabled = true;
  try {
    chatStatus.textContent =
      pendingFiles.length > 0 ? `附件上传中（${pendingFiles.length}）...` : '';
    const filePrefix = await uploadPendingFiles();
    const fullContent = `${filePrefix}${trimmed}`.trim();
    if (!fullContent) return;

    const res = await apiFetch('/api/assistant/chat/message', {
      method: 'POST',
      body: JSON.stringify({ content: fullContent }),
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
    chatStatus.textContent = err instanceof Error ? err.message : '发送失败';
  } finally {
    chatSend.disabled = false;
  }
}

function clipboardImageExtension(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/svg+xml') return 'svg';
  const subtype = normalized
    .split('/')[1]
    ?.replace('+xml', '')
    .replace(/[^a-z0-9]/g, '');
  return subtype || 'png';
}

function clipboardImageTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function isGenericClipboardImageName(name: string): boolean {
  return !name || /^image\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

function withClipboardImageName(file: File, index: number, count: number): File {
  const originalName = typeof file.name === 'string' ? file.name.trim() : '';
  if (!isGenericClipboardImageName(originalName)) return file;

  const suffix = count > 1 ? `-${index + 1}` : '';
  const filename = `clipboard-image-${clipboardImageTimestamp()}${suffix}.${clipboardImageExtension(file.type)}`;
  if (typeof File !== 'function') return file;

  try {
    return new File([file], filename, {
      type: file.type || 'image/png',
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

function getClipboardImageFiles(event: ClipboardEvent): File[] {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return [];

  const itemFiles = Array.from(clipboardData.items || [])
    .filter(
      (item) =>
        item.kind === 'file' && String(item.type || '').startsWith('image/'),
    )
    .map((item) =>
      typeof item.getAsFile === 'function' ? item.getAsFile() : null,
    )
    .filter((file): file is File => Boolean(file));
  const rawFiles =
    itemFiles.length > 0
      ? itemFiles
      : Array.from(clipboardData.files || []).filter((file) =>
          String(file.type || '').startsWith('image/'),
        );

  return rawFiles.map((file, index) =>
    withClipboardImageName(file, index, rawFiles.length),
  );
}

function handleComposerPaste(event: ClipboardEvent): void {
  const imageFiles = getClipboardImageFiles(event);
  if (imageFiles.length === 0) return;

  event.preventDefault();
  imageFiles.forEach(stageFile);
  chatStatus.textContent =
    imageFiles.length > 1
      ? `已暂存 ${imageFiles.length} 张图片`
      : '已暂存图片';
}

function stageFile(file: File): void {
  pendingFiles.push(file);
  renderPendingFiles();
}

function renderPendingFiles(): void {
  if (pendingFiles.length === 0) {
    pendingFilesEl.classList.remove('visible');
    pendingFilesContent.textContent = '';
    return;
  }

  const names = pendingFiles.map((file) => file.name || '未命名附件').join(', ');
  pendingFilesContent.textContent = `${pendingFiles.length} 个附件: ${names}`;
  pendingFilesEl.classList.add('visible');
}

async function uploadPendingFiles(): Promise<string> {
  if (pendingFiles.length === 0) return '';

  const filesToUpload = [...pendingFiles];
  const agentPaths: string[] = [];
  for (const file of filesToUpload) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(
      `${API_BASE}/api/upload?jid=${encodeURIComponent(ASSISTANT_CHAT_JID)}`,
      {
        method: 'POST',
        headers: await authorizationHeaders(),
        body: formData,
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      files?: Array<{ agentPath?: string }>;
    };
    if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
    const agentPath = data.files?.[0]?.agentPath;
    if (agentPath) agentPaths.push(agentPath);
  }

  pendingFiles = pendingFiles.filter((file) => !filesToUpload.includes(file));
  renderPendingFiles();
  if (agentPaths.length === 0) return '';

  return (
    '【附件】\n' +
    agentPaths.map((agentPath) => `文件地址: ${agentPath}`).join('\n') +
    '\n'
  );
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function hideFileDropZone(): void {
  dragDepth = 0;
  fileDropZone.classList.add('hidden');
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
        if (message.event?.type === 'chat_message' && message.event.message) {
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

mascotTrigger.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || mascotPointerId !== null) return;

  mascotPointerId = event.pointerId;
  mascotPressStartScreenX = event.screenX;
  mascotPressStartScreenY = event.screenY;
  mascotLastScreenX = event.screenX;
  mascotLastScreenY = event.screenY;

  try {
    mascotTrigger.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture can fail if the pointer is already released.
  }

  mascotDragHoldTimer = window.setTimeout(() => {
    beginMascotWindowDrag();
  }, MASCOT_DRAG_HOLD_MS);
});

mascotTrigger.addEventListener('pointermove', (event) => {
  if (event.pointerId !== mascotPointerId) return;

  const startDx = event.screenX - mascotPressStartScreenX;
  const startDy = event.screenY - mascotPressStartScreenY;
  const movedFromPress = Math.hypot(startDx, startDy);

  if (!mascotDragging) {
    if (movedFromPress > MASCOT_DRAG_CANCEL_DISTANCE_PX) {
      clearMascotDragHoldTimer();
      suppressNextMascotClick = true;
    }
    mascotLastScreenX = event.screenX;
    mascotLastScreenY = event.screenY;
    return;
  }

  event.preventDefault();
  const dx = Math.round(event.screenX - mascotLastScreenX);
  const dy = Math.round(event.screenY - mascotLastScreenY);
  mascotLastScreenX = event.screenX;
  mascotLastScreenY = event.screenY;

  if (dx !== 0 || dy !== 0) {
    void window.assistantHost?.moveBy(dx, dy);
  }
});

function finishMascotPointerInteraction(event: PointerEvent): void {
  if (event.pointerId !== mascotPointerId) return;
  const shouldSuppressClick = mascotDragging || suppressNextMascotClick;

  try {
    mascotTrigger.releasePointerCapture(event.pointerId);
  } catch {
    // The capture may already be released after pointer cancellation.
  }

  resetMascotPointerState();
  if (shouldSuppressClick) suppressMascotClickForCurrentGesture();
}

mascotTrigger.addEventListener('pointerup', finishMascotPointerInteraction);
mascotTrigger.addEventListener('pointercancel', finishMascotPointerInteraction);
mascotTrigger.addEventListener(
  'lostpointercapture',
  finishMascotPointerInteraction,
);

mascotTrigger.addEventListener('click', (event) => {
  if (suppressNextMascotClick) {
    event.preventDefault();
    event.stopPropagation();
    suppressNextMascotClick = false;
    return;
  }

  setChatOpen(!chatOpen);
});

mascotTrigger.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  setChatOpen(!chatOpen);
});

window.addEventListener('blur', scheduleChatAutoHide);
window.addEventListener('focus', clearChatAutoHideTimer);
document.addEventListener('pointerdown', clearChatAutoHideTimer);
document.addEventListener('keydown', clearChatAutoHideTimer);

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

chatInput.addEventListener('paste', handleComposerPaste);

pendingFilesClose.addEventListener('click', () => {
  pendingFiles = [];
  renderPendingFiles();
  chatInput.focus();
});

document.addEventListener('dragenter', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  fileDropZone.classList.remove('hidden');
});

document.addEventListener('dragover', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  fileDropZone.classList.remove('hidden');
});

document.addEventListener('dragleave', (event) => {
  if (!hasDraggedFiles(event) && dragDepth === 0) return;
  event.preventDefault();
  const relatedTarget = event.relatedTarget;
  if (
    !relatedTarget ||
    !(relatedTarget instanceof Node) ||
    !document.documentElement.contains(relatedTarget)
  ) {
    hideFileDropZone();
    return;
  }
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) fileDropZone.classList.add('hidden');
});

document.addEventListener('drop', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  hideFileDropZone();
  if (files.length === 0) return;
  files.forEach(stageFile);
  chatStatus.textContent =
    files.length > 1 ? `已暂存 ${files.length} 个附件` : '已暂存附件';
  chatInput.focus();
});

void loadState();
void loadChat();
void connectWs();
window.setInterval(() => void loadState(), 60_000);
