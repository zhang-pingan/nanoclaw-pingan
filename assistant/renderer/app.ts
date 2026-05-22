import { AssistantScene } from './assistant-scene.js';

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
  extra?: Record<string, unknown>;
};

type AssistantTriggerRuleSetting = {
  enabled: boolean;
  investigationEnabled: boolean;
  autoEnabled: boolean;
  selectedServices?: string[];
};

type AssistantTriggerRuleCapability = {
  key: string;
  supportsInvestigation: boolean;
  supportsRepair: boolean;
};

type AssistantSettings = {
  enabled: boolean;
  triggerRules?: Record<string, AssistantTriggerRuleSetting>;
  desktopAssistant: {
    alwaysOnTop: boolean;
    allowMovement: boolean;
  };
};

type AssistantState = {
  settings: AssistantSettings;
  triggerRuleCapabilities?: AssistantTriggerRuleCapability[];
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
      setMousePassthrough: (enabled: boolean) => Promise<void>;
      moveBy: (dx: number, dy: number) => Promise<void>;
      hide: () => Promise<void>;
      platform: string;
    };
  }
}

const API_BASE = 'http://localhost:3000';
const ASSISTANT_CHAT_JID = 'assistant:main';
const CHAT_AUTO_HIDE_DELAY_MS = 5_000;
const CHAT_PANEL_TRANSITION_MS = 110;
const COLLAPSED_CHAT_MESSAGE_BUBBLE_TTL_MS = 5_000;
const MASCOT_DRAG_START_DISTANCE_PX = 4;
const BUBBLE_KICKER_TEXT_LIMIT = 36;
const BUBBLE_TITLE_TEXT_LIMIT = 42;
const BUBBLE_BODY_TEXT_LIMIT = 96;
const MOUSE_CAPTURE_SELECTOR =
  '.assistant-mascot-wrap, .assistant-bubble, .assistant-chat, .image-preview-overlay';
const shell = document.getElementById('assistant-shell') as HTMLElement;
const bubble = document.getElementById('bubble') as HTMLElement;
const bubbleKicker = document.getElementById('bubble-kicker') as HTMLElement;
const bubbleTitle = document.getElementById('bubble-title') as HTMLElement;
const bubbleBody = document.getElementById('bubble-body') as HTMLElement;
const bubbleActions = document.getElementById('bubble-actions') as HTMLElement;
const assistantChat = document.getElementById('assistant-chat') as HTMLElement;
const mascotTrigger = document.getElementById(
  'assistant-mascot-trigger',
) as HTMLElement;
const assistantSceneEl = document.getElementById(
  'assistant-scene',
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
let sceneChatOpen = false;
let collapsedChatMessage: AssistantChatMessage | null = null;
let collapsedChatMessageTimer: number | null = null;
let chatTransitionToken = 0;
let chatAutoHideTimer: number | null = null;
let mousePassthrough = false;
let lastMouseClientX = -1;
let lastMouseClientY = -1;
let mascotPointerId: number | null = null;
let mascotPressStartScreenX = 0;
let mascotPressStartScreenY = 0;
let mascotLastScreenX = 0;
let mascotLastScreenY = 0;
let mascotDragging = false;
let suppressNextMascotClick = false;
let pendingFiles: File[] = [];
let dragDepth = 0;
const pendingInboxActionItemIds = new Set<string>();
const pendingInboxActionByItemId = new Map<string, string>();
const inboxActionErrorsByItemId = new Map<string, string>();

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);
let scene: AssistantScene | null = null;
try {
  scene = new AssistantScene(assistantSceneEl, {
    onReady: (ready) => {
      shell.classList.toggle('scene-fallback', !ready);
    },
  });
  void scene.loadManifest('./assets/scifi-scene.manifest.json');
} catch {
  shell.classList.add('scene-fallback');
}

function syncScene(): void {
  scene?.update({
    connected: shell.classList.contains('connected'),
    attention: shell.classList.contains('attention'),
    chatOpen: sceneChatOpen,
    typing: chatTyping,
  });
}

function setSceneChatOpen(open: boolean): void {
  if (sceneChatOpen === open) return;
  sceneChatOpen = open;
  syncScene();
}

function updateAlertLayout(): void {
  const shouldReserveAlert =
    chatOpen &&
    !shell.classList.contains('bubble-hidden') &&
    bubble.getAttribute('aria-hidden') !== 'true';
  const alertHeight = shouldReserveAlert
    ? Math.ceil(bubble.getBoundingClientRect().height)
    : 0;
  shell.style.setProperty('--assistant-alert-height', `${alertHeight}px`);
}

const alertResizeObserver = new ResizeObserver(() => {
  updateAlertLayout();
});
alertResizeObserver.observe(bubble);

function shouldCaptureMouse(target: Element | null): boolean {
  return Boolean(target?.closest(MOUSE_CAPTURE_SELECTOR));
}

function setMousePassthrough(enabled: boolean): void {
  if (mousePassthrough === enabled) return;
  mousePassthrough = enabled;
  void window.assistantHost?.setMousePassthrough?.(enabled);
}

function syncMousePassthrough(event?: MouseEvent): void {
  if (chatOpen || primaryItem()) {
    setMousePassthrough(false);
    return;
  }
  if (event) {
    lastMouseClientX = event.clientX;
    lastMouseClientY = event.clientY;
  }
  const hasKnownMousePosition = lastMouseClientX >= 0 && lastMouseClientY >= 0;
  const target = hasKnownMousePosition
    ? document.elementFromPoint(lastMouseClientX, lastMouseClientY)
    : null;
  setMousePassthrough(!shouldCaptureMouse(target));
}

function setConnectionState(connected: boolean): void {
  shell.classList.toggle('connected', connected);
  syncScene();
}

function clearChatAutoHideTimer(): void {
  if (!chatAutoHideTimer) return;
  window.clearTimeout(chatAutoHideTimer);
  chatAutoHideTimer = null;
}

function clearCollapsedChatMessageTimer(): void {
  if (!collapsedChatMessageTimer) return;
  window.clearTimeout(collapsedChatMessageTimer);
  collapsedChatMessageTimer = null;
}

function scheduleCollapsedChatMessageAutoHide(messageId: string): void {
  clearCollapsedChatMessageTimer();
  collapsedChatMessageTimer = window.setTimeout(() => {
    if (collapsedChatMessage?.id !== messageId) return;
    collapsedChatMessage = null;
    collapsedChatMessageTimer = null;
    render();
  }, COLLAPSED_CHAT_MESSAGE_BUBBLE_TTL_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function setChatOpen(open: boolean): void {
  if (chatOpen === open) {
    if (open) clearChatAutoHideTimer();
    return;
  }

  const transitionToken = ++chatTransitionToken;
  chatOpen = open;
  mascotTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (open) {
    clearCollapsedChatMessageTimer();
    collapsedChatMessage = null;
    render();
    clearChatAutoHideTimer();
    assistantChat.setAttribute('aria-hidden', 'false');
    renderChat();
    void loadChat();
    void (async () => {
      await window.assistantHost?.setChatOpen(true);
      await afterNextPaint();
      if (transitionToken !== chatTransitionToken || !chatOpen) return;
      setSceneChatOpen(true);
      shell.classList.add('chat-open');
      updateAlertLayout();
      setMousePassthrough(false);
      chatInput.focus();
    })();
  } else {
    clearChatAutoHideTimer();
    shell.classList.remove('chat-open');
    updateAlertLayout();
    assistantChat.setAttribute('aria-hidden', 'true');
    void (async () => {
      await delay(CHAT_PANEL_TRANSITION_MS);
      if (transitionToken !== chatTransitionToken || chatOpen) return;
      await window.assistantHost?.setChatOpen(false);
      await afterNextPaint();
      if (transitionToken !== chatTransitionToken || chatOpen) return;
      setSceneChatOpen(false);
      syncMousePassthrough();
    })();
  }
}

function scheduleChatAutoHide(): void {
  if (!chatOpen) return;
  clearChatAutoHideTimer();
  chatAutoHideTimer = window.setTimeout(() => {
    setChatOpen(false);
  }, CHAT_AUTO_HIDE_DELAY_MS);
}

function beginMascotWindowDrag(): void {
  if (mascotPointerId === null || mascotDragging) return;
  clearChatAutoHideTimer();
  mascotDragging = true;
  suppressNextMascotClick = true;
  mascotTrigger.classList.add('dragging');
}

function resetMascotPointerState(): void {
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
  const items = activeInboxItems().filter((item) => item.status === 'unread');
  return items[0] || null;
}

function localStatusForInboxAction(action: string): string | null {
  if (action === 'snooze') return 'snoozed';
  if (action === 'dismiss') return 'dismissed';
  if (action === 'mark_read') return 'read';
  if (action === 'resolve') return 'done';
  return null;
}

function inboxItemRuleKey(item: AgentInboxItem): string {
  return typeof item.extra?.ruleKey === 'string' ? item.extra.ruleKey : '';
}

function triggerRuleCapability(
  item: AgentInboxItem,
): AssistantTriggerRuleCapability | null {
  const ruleKey = inboxItemRuleKey(item);
  if (!ruleKey) return null;
  return (
    state?.triggerRuleCapabilities?.find((rule) => rule.key === ruleKey) ||
    null
  );
}

function triggerRuleSetting(
  item: AgentInboxItem,
): AssistantTriggerRuleSetting | null {
  const ruleKey = inboxItemRuleKey(item);
  if (!ruleKey) return null;
  return state?.settings.triggerRules?.[ruleKey] || null;
}

function canInvestigate(item: AgentInboxItem): boolean {
  const capability = triggerRuleCapability(item);
  const setting = triggerRuleSetting(item);
  return Boolean(
    capability?.supportsInvestigation && setting?.investigationEnabled,
  );
}

function canRepair(item: AgentInboxItem): boolean {
  const capability = triggerRuleCapability(item);
  const investigation = item.extra?.investigation;
  return Boolean(
    capability?.supportsRepair &&
      investigation &&
      typeof investigation === 'object' &&
      !Array.isArray(investigation) &&
      (investigation as Record<string, unknown>).repairable === true,
  );
}

function patchLocalInboxItemStatus(itemId: string, status: string): void {
  if (!state) return;
  state = {
    ...state,
    latestInboxItems: state.latestInboxItems.map((item) =>
      item.id === itemId ? { ...item, status } : item,
    ),
  };
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
  options: { disabled?: boolean } = {},
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.className = className;
  el.disabled = Boolean(options.disabled);
  el.addEventListener('click', onClick);
  return el;
}

function pendingInboxActionLabel(action: string): string {
  if (action === 'investigate') return '排查中';
  if (action === 'repair') return '修复中';
  if (action === 'execute') return '执行中';
  if (action === 'snooze') return '稍后处理中';
  if (action === 'dismiss') return '忽略处理中';
  if (action === 'mark_read') return '标记中';
  return '处理中';
}

function inboxItemBody(item: AgentInboxItem): string {
  const pendingAction = pendingInboxActionByItemId.get(item.id) || '';
  if (pendingAction) {
    return `${pendingInboxActionLabel(pendingAction)}，完成后会自动更新。`;
  }

  const actionError = inboxActionErrorsByItemId.get(item.id);
  if (actionError) {
    return `动作执行失败：${actionError}`;
  }

  const extra = item.extra || {};
  const investigation = extra.investigation;
  if (
    investigation &&
    typeof investigation === 'object' &&
    !Array.isArray(investigation)
  ) {
    const summary = (investigation as Record<string, unknown>).summary;
    if (typeof summary === 'string' && summary.trim()) {
      return `排查：${summary.trim()}`;
    }
  }

  const lastInvestigationError = extra.lastInvestigationError;
  if (
    typeof lastInvestigationError === 'string' &&
    lastInvestigationError.trim()
  ) {
    return `排查失败：${lastInvestigationError.trim()}`;
  }

  const lastAutoFlowError = extra.lastAutoFlowError;
  if (typeof lastAutoFlowError === 'string' && lastAutoFlowError.trim()) {
    return `自动处理失败：${lastAutoFlowError.trim()}`;
  }

  return item.body || '我发现了一条需要关注的信息。';
}

function normalizePreviewText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function truncatePreviewText(text: string, maxLength: number): string {
  const normalized = normalizePreviewText(text);
  const chars = Array.from(normalized);
  if (chars.length <= maxLength) return normalized;
  return `${chars
    .slice(0, Math.max(0, maxLength - 3))
    .join('')
    .trimEnd()}...`;
}

function chatMessagePreviewBody(message: AssistantChatMessage): string {
  const content = normalizePreviewText(message.content);
  if (content) {
    return truncatePreviewText(content, BUBBLE_BODY_TEXT_LIMIT);
  }

  const fileInfo = chatFileInfo(message);
  const fileName = truncatePreviewText(fileInfo?.fileName || '未命名附件', 54);
  if (fileInfo && IMAGE_EXTENSIONS.has(fileInfo.extension)) {
    return `收到图片：${fileName}`;
  }
  if (fileInfo) {
    return `收到附件：${fileName}`;
  }
  return '收到一条新消息。';
}

function renderIdle(): void {
  shell.classList.remove('attention');
  const hideIdleBubble = Boolean(state?.settings.enabled);
  shell.classList.toggle('bubble-hidden', hideIdleBubble);
  bubble.setAttribute('aria-hidden', hideIdleBubble ? 'true' : 'false');
  syncScene();
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
  updateAlertLayout();
}

function renderChatMessageBubble(message: AssistantChatMessage): void {
  shell.classList.add('attention');
  shell.classList.remove('bubble-hidden');
  bubble.setAttribute('aria-hidden', 'false');
  syncScene();
  bubbleKicker.textContent = truncatePreviewText(
    message.senderName || 'Personal Assistant',
    BUBBLE_KICKER_TEXT_LIMIT,
  );
  bubbleTitle.textContent = '收到新的助手消息';
  bubbleBody.textContent = chatMessagePreviewBody(message);
  bubbleActions.innerHTML = '';
  updateAlertLayout();
}

function renderItem(item: AgentInboxItem): void {
  shell.classList.add('attention');
  shell.classList.remove('bubble-hidden');
  bubble.setAttribute('aria-hidden', 'false');
  syncScene();
  bubbleKicker.textContent = truncatePreviewText(
    `${item.kind} · ${item.priority}`,
    BUBBLE_KICKER_TEXT_LIMIT,
  );
  bubbleTitle.textContent = truncatePreviewText(
    item.title || '新的主动事项',
    BUBBLE_TITLE_TEXT_LIMIT,
  );
  bubbleBody.textContent = truncatePreviewText(
    inboxItemBody(item),
    BUBBLE_BODY_TEXT_LIMIT,
  );
  bubbleActions.innerHTML = '';
  const pendingAction = pendingInboxActionByItemId.get(item.id) || '';

  if (item.action_url) {
    bubbleActions.append(
      button('查看', 'primary', () => {
        window.assistantHost?.openWorkstation(item.action_url || undefined);
        void runInboxAction(item.id, 'mark_read');
      }, { disabled: Boolean(pendingAction) }),
    );
  }

  if (item.action_kind === 'continue_today_plan') {
    bubbleActions.append(
      button(item.action_label || '执行', '', () => {
        void runInboxAction(item.id, 'execute');
      }, { disabled: Boolean(pendingAction) }),
    );
  }

  bubbleActions.append(
    button('稍后', '', () => {
      void runInboxAction(item.id, 'snooze', { minutes: 60 });
    }, { disabled: Boolean(pendingAction) }),
    button('忽略', '', () => {
      void runInboxAction(item.id, 'dismiss');
    }, { disabled: Boolean(pendingAction) }),
  );
  updateAlertLayout();
}

function render(): void {
  const item = primaryItem();
  if (!item) {
    if (!chatOpen && collapsedChatMessage) {
      renderChatMessageBubble(collapsedChatMessage);
      setMousePassthrough(false);
      return;
    }
    renderIdle();
    syncMousePassthrough();
    return;
  }
  renderItem(item);
  setMousePassthrough(false);
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
  syncScene();
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

function handleIncomingChatMessage(message: AssistantChatMessage): void {
  upsertChatMessage(message);
  if (message.isFromMe || chatOpen || message.chatJid !== ASSISTANT_CHAT_JID) {
    return;
  }
  collapsedChatMessage = message;
  scheduleCollapsedChatMessageAutoHide(message.id);
  render();
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
    shell.classList.remove('bubble-hidden');
    bubble.setAttribute('aria-hidden', 'false');
    bubbleKicker.textContent = 'Connection';
    bubbleTitle.textContent = '无法连接 Icarus';
    bubbleBody.textContent = '请确认主服务和 Web 工作站正在运行。';
    bubbleActions.innerHTML = '';
    bubbleActions.append(button('重试', 'primary', () => void loadState()));
    updateAlertLayout();
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

function withClipboardImageName(
  file: File,
  index: number,
  count: number,
): File {
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
    imageFiles.length > 1 ? `已暂存 ${imageFiles.length} 张图片` : '已暂存图片';
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

  const names = pendingFiles
    .map((file) => file.name || '未命名附件')
    .join(', ');
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
  if (pendingInboxActionItemIds.has(itemId)) return;
  pendingInboxActionItemIds.add(itemId);
  pendingInboxActionByItemId.set(itemId, action);
  inboxActionErrorsByItemId.delete(itemId);

  const previousItems = state ? [...state.latestInboxItems] : null;
  const localStatus = localStatusForInboxAction(action);
  if (localStatus) {
    patchLocalInboxItemStatus(itemId, localStatus);
  } else {
    render();
  }

  try {
    const res = await apiFetch('/api/agent-inbox/action', {
      method: 'POST',
      body: JSON.stringify({ item_id: itemId, action, payload }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: unknown;
    };
    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string' && data.error.trim()
          ? data.error.trim()
          : `HTTP ${res.status}`,
      );
    }
    inboxActionErrorsByItemId.delete(itemId);
    await loadState();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    inboxActionErrorsByItemId.set(itemId, message || '未知错误');
    if (previousItems && state) {
      state = { ...state, latestInboxItems: previousItems };
      render();
    }
    bubbleBody.textContent = truncatePreviewText(
      `动作执行失败：${message || '未知错误'}`,
      BUBBLE_BODY_TEXT_LIMIT,
    );
  } finally {
    pendingInboxActionItemIds.delete(itemId);
    pendingInboxActionByItemId.delete(itemId);
    render();
  }
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
          handleIncomingChatMessage(message.event.message);
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
});

mascotTrigger.addEventListener('pointermove', (event) => {
  if (event.pointerId !== mascotPointerId) return;

  const startDx = event.screenX - mascotPressStartScreenX;
  const startDy = event.screenY - mascotPressStartScreenY;
  const movedFromPress = Math.hypot(startDx, startDy);

  if (!mascotDragging) {
    if (movedFromPress < MASCOT_DRAG_START_DISTANCE_PX) return;
    beginMascotWindowDrag();
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
window.addEventListener('mousemove', syncMousePassthrough);
window.addEventListener('mouseleave', () => {
  if (chatOpen || primaryItem()) return;
  setMousePassthrough(true);
});
setMousePassthrough(true);
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
