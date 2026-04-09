// electron/renderer/app.js
var ws = null;
var reconnectTimer = null;
var currentGroupJid = "";
var browserNotificationPermissionRequested = false;
var groups = [];
var messages = [];
var unreadCounts = {};
var replyToMsg = null;
var hasMoreHistory = true;
var loadingHistory = false;
var cmdPaletteIndex = -1;
var multiSelectMode = false;
var selectedMsgIds = new Set();
var pendingFiles = []; // files staged for upload on next send
var modelSyncTimer = null;
var INITIAL_MESSAGE_LIMIT = 100;
var LIVE_MESSAGE_BUFFER_LIMIT = 250;

var mainScreen = document.getElementById("main-screen");
var workspace = document.getElementById("workspace");
var workbenchScreen = document.getElementById("workbench-screen");
var memoryManagementScreen = document.getElementById("memory-management-screen");
var traceMonitorScreen = document.getElementById("trace-monitor-screen");
var memoryGroupsList = document.getElementById("memory-groups-list");
var memoryGroupTitle = document.getElementById("memory-group-title");
var memoryGroupFolder = document.getElementById("memory-group-folder");
var memoryGroupSummary = document.getElementById("memory-group-summary");
var memorySearchInput = document.getElementById("memory-search-input");
var memoryStatusFilter = document.getElementById("memory-status-filter");
var memoryDoctorBtn = document.getElementById("memory-doctor-btn");
var memoryMetricsBtn = document.getElementById("memory-metrics-btn");
var memoryCreateBtn = document.getElementById("memory-create-btn");
var memorySearchBtn = document.getElementById("memory-search-btn");
var memoryRefreshBtn = document.getElementById("memory-refresh-btn");
var memoryList = document.getElementById("memory-list");
var memoryEmpty = document.getElementById("memory-empty");
var memoryEditor = document.getElementById("memory-editor");
var memoryEditorTitle = document.getElementById("memory-editor-title");
var memoryLayerSelect = document.getElementById("memory-layer-select");
var memoryTypeSelect = document.getElementById("memory-type-select");
var memoryStatusSelect = document.getElementById("memory-status-select");
var memoryContentInput = document.getElementById("memory-content-input");
var memorySaveBtn = document.getElementById("memory-save-btn");
var memoryCancelBtn = document.getElementById("memory-cancel-btn");
var memoryDoctorPanel = document.getElementById("memory-doctor-panel");
var memoryDoctorSummary = document.getElementById("memory-doctor-summary");
var memoryDoctorLog = document.getElementById("memory-doctor-log");
var memoryDoctorCloseBtn = document.getElementById("memory-doctor-close-btn");
var memoryDuplicatesList = document.getElementById("memory-duplicates-list");
var memoryStaleList = document.getElementById("memory-stale-list");
var memoryConflictsList = document.getElementById("memory-conflicts-list");
var memoryGcDuplicatesBtn = document.getElementById("memory-gc-duplicates-btn");
var memoryGcStaleBtn = document.getElementById("memory-gc-stale-btn");
var memoryModalMask = document.getElementById("memory-modal-mask");
var memoryMetricsModal = document.getElementById("memory-metrics-modal");
var memoryMetricsWindow = document.getElementById("memory-metrics-window");
var memoryMetricsTotal = document.getElementById("memory-metrics-total");
var memoryMetricsList = document.getElementById("memory-metrics-list");
var memoryMetricsCloseBtn = document.getElementById("memory-metrics-close-btn");
var sidebar = document.getElementById("sidebar");
var sidebarCollapse = document.getElementById("sidebar-collapse");
var primaryNav = document.getElementById("primary-nav");
var primaryNavItems = Array.from(document.querySelectorAll(".primary-nav-item"));
var groupsList = document.getElementById("groups-list");
var refreshGroupsBtn = document.getElementById("refresh-groups");
var schedulersPanel = document.getElementById("schedulers-panel");
var schedulersList = document.getElementById("schedulers-list");
var openSchedulersBtn = document.getElementById("open-schedulers");
var closeSchedulersBtn = document.getElementById("close-schedulers");
var deleteAllSchedulersBtn = document.getElementById("delete-all-schedulers");
var agentStatusPanel = document.getElementById("agent-status-panel");
var agentStatusList = document.getElementById("agent-status-list");
var openAgentStatusBtn = document.getElementById("open-agent-status");
var closeAgentStatusBtn = document.getElementById("close-agent-status");
var stoppingAgentIds = new Set();
var workflowsPanel = document.getElementById("workflows-panel");
var workflowsList = document.getElementById("workflows-list");
var openWorkflowsBtn = document.getElementById("open-workflows");
var closeWorkflowsBtn = document.getElementById("close-workflows");
var refreshWorkflowsBtn = document.getElementById("refresh-workflows");
var deleteAllWorkflowsBtn = document.getElementById("delete-all-workflows");
var traceMonitorList = document.getElementById("trace-monitor-list");
var traceMonitorRefreshBtn = document.getElementById("trace-monitor-refresh-btn");
var traceMonitorClearHistoryBtn = document.getElementById("trace-monitor-clear-history-btn");
var traceMonitorScopeBtns = Array.from(document.querySelectorAll(".trace-monitor-scope-btn"));
var traceMonitorDetailEmpty = document.getElementById("trace-monitor-detail-empty");
var traceMonitorDetail = document.getElementById("trace-monitor-detail");
var traceMonitorTitle = document.getElementById("trace-monitor-title");
var traceMonitorMeta = document.getElementById("trace-monitor-meta");
var traceMonitorSummary = document.getElementById("trace-monitor-summary");
var traceMonitorTimeline = document.getElementById("trace-monitor-timeline");
var workbenchSidebar = document.getElementById("workbench-sidebar");
var workbenchSidebarCollapse = document.getElementById("workbench-sidebar-collapse");
var workbenchTaskList = document.getElementById("workbench-task-list");
var workbenchRefreshBtn = document.getElementById("workbench-refresh-btn");
var workbenchCreateTaskBtn = document.getElementById("workbench-create-task-btn");
var workbenchDeleteAllBtn = document.getElementById("workbench-delete-all-btn");
var workbenchDetailEmpty = document.getElementById("workbench-detail-empty");
var workbenchTaskDetail = document.getElementById("workbench-task-detail");
var workbenchTaskTitle = document.getElementById("workbench-task-title");
var workbenchTaskMeta = document.getElementById("workbench-task-meta");
var workbenchTaskActions = document.getElementById("workbench-task-actions");
var workbenchSubtasks = document.getElementById("workbench-subtasks");
var workbenchActionItemsPanel = document.getElementById("workbench-action-items-panel");
var workbenchActionItems = document.getElementById("workbench-action-items");
var workbenchArtifacts = document.getElementById("workbench-artifacts");
var workbenchAssets = document.getElementById("workbench-assets");
var workbenchAddLinkBtn = document.getElementById("workbench-add-link-btn");
var workbenchAddFileBtn = document.getElementById("workbench-add-file-btn");
var workbenchComments = document.getElementById("workbench-comments");
var workbenchCommentInput = document.getElementById("workbench-comment-input");
var workbenchCommentSubmit = document.getElementById("workbench-comment-submit");
var workbenchTimeline = document.getElementById("workbench-timeline");
var connectionStatus = document.getElementById("connection-status");
var chatHeader = document.getElementById("chat-header");
var chatGroupName = document.getElementById("chat-group-name");
var chatGroupFolder = document.getElementById("chat-group-folder");
var messagesEl = document.getElementById("messages");
var messagesEmpty = document.getElementById("messages-empty");
var typingIndicator = document.getElementById("typing-indicator");
var inputArea = document.getElementById("input-area");
var messageInput = document.getElementById("message-input");
var sendBtn = document.getElementById("send-btn");
var attachBtn = document.getElementById("attach-btn");
var fileInput = document.getElementById("file-input");
var fileDropZone = document.getElementById("file-drop-zone");
var replyPreview = document.getElementById("reply-preview");
var replyPreviewContent = document.getElementById("reply-preview-content");
var replyPreviewClose = document.getElementById("reply-preview-close");
var pendingFilesEl = document.getElementById("pending-files-preview");
var pendingFilesContent = document.getElementById("pending-files-content");
var pendingFilesClose = document.getElementById("pending-files-close");
var commandPalette = document.getElementById("command-palette");
var mentionPicker = document.getElementById("mention-picker");
var selectModeBtn = document.getElementById("select-mode-btn");
var originalSelectIcon = selectModeBtn.innerHTML; // preserve the original 4-square grid icon
var multiSelectBar = document.getElementById("multi-select-bar");
var selectedCountEl = document.getElementById("selected-count");
var copySelectedBtn = document.getElementById("copy-selected-btn");
var deleteSelectedBtn = document.getElementById("delete-selected-btn");
var cancelSelectBtn = document.getElementById("cancel-select-btn");
var agentStatusInterval = null;
var agentStatusData = [];
var agentRunTraceByGroup = {};
var activePrimaryNavKey = "agent-groups";
var activeTraceMonitorScope = "active";
var activeMemoryGroupJid = "";
var memoryEntries = [];
var memoryQueryText = "";
var memoryRequestSeq = 0;
var editingMemoryId = "";
var memoryStatusFilterValue = "all";
var memoryDoctorReport = null;
var memoryDoctorMap = {};
var memoryMetricsSummary = null;
var workbenchTasks = [];
var currentWorkbenchDetail = null;
var currentWorkbenchTaskId = "";
var workbenchSelectedSubtaskId = "";
var workbenchAnimatedSubtaskKey = "";
var workbenchFollowCurrentSubtaskOnce = false;
var workbenchRetryComposerSubtaskId = "";
var workbenchRetryComposerDraft = "";
var workbenchRetrySubmitting = false;
var workbenchDetailLoading = false;
var workbenchQueuedDetailTaskId = "";
var workbenchDetailReloadTimer = null;
var mentionSearchInput = null;
var mentionOptionsEl = null;
var mentionPickerVisible = false;
var mentionPickerIndex = -1;
var mentionCandidates = [];
var mentionInsertPos = null;
var commandSearchInput = null;
var commandOptionsEl = null;
var commandPickerVisible = false;
var commandCandidates = [];
var commandInsertPos = null;
var workflowCreateOptionsCache = null;
var workflowCreateOptionsLoading = null;
var traceMonitorActiveRuns = [];
var traceMonitorHistoryRuns = [];
var traceMonitorHistoryOffset = 0;
var traceMonitorHistoryHasMore = false;
var traceMonitorHistoryLoading = false;
var traceMonitorHistoryClearing = false;
var traceMonitorHistoryJustCleared = false;
var currentTraceRunId = "";
var currentTraceRunRecord = null;
var currentTraceRunSteps = [];
var currentTraceRunEvents = [];
var currentTraceRunScope = "active";
var traceMonitorDetailReloadTimer = null;

var TRACE_HISTORY_PAGE_SIZE = 10;

// --- Command palette definitions ---
var commands = [
  { name: "/clear", desc: "Clear conversation context" },
  { name: "/compact", desc: "Compact conversation history" },
];

const MAIN_GROUP_AVATAR = "/assets/doraemon-face.png";
const GROUP_AVATAR_POOL = [
  "/assets/avatar-char-dorami.png",
  "/assets/avatar-char-shizuka.png",
  "/assets/avatar-char-suneo.png",
  "/assets/avatar-char-gounda-takeshi.png",
  "/assets/avatar-char-tamako-nobi-mother.png",
  "/assets/avatar-char-nobisuke-nobi-father.png",
  "/assets/avatar-char-teacher.png",
];

var fixedGroupAvatarMap = null;

function initFixedGroupAvatarMap() {
  if (!Array.isArray(groups) || groups.length === 0) return;
  if (fixedGroupAvatarMap) {
    let stale = false;
    for (const group of groups) {
      if (!group || typeof group.jid !== "string" || group.isMain) continue;
      const assigned = fixedGroupAvatarMap[group.jid];
      if (assigned && !GROUP_AVATAR_POOL.includes(assigned)) {
        stale = true;
        break;
      }
    }
    if (!stale) return;
  }
  fixedGroupAvatarMap = {};
  let poolIndex = 0;
  for (const group of groups) {
    if (!group || typeof group.jid !== "string") continue;
    if (group.isMain) {
      fixedGroupAvatarMap[group.jid] = MAIN_GROUP_AVATAR;
      continue;
    }
    if (poolIndex < GROUP_AVATAR_POOL.length) {
      fixedGroupAvatarMap[group.jid] = GROUP_AVATAR_POOL[poolIndex];
      poolIndex += 1;
    }
  }
}

function getFixedAvatar(group) {
  if (!group || typeof group.jid !== "string") return null;
  if (group.isMain) return MAIN_GROUP_AVATAR;
  if (!fixedGroupAvatarMap) return null;
  return fixedGroupAvatarMap[group.jid] || null;
}

function apiFetch(path, options) {
  const headers = { "Content-Type": "application/json" };
  return fetch(`http://localhost:3000${path}`, { ...options, headers });
}

async function openTextPrompt(message, defaultValue = "", options = {}) {
  const promptFn = typeof window.prompt === "function" ? window.prompt.bind(window) : null;
  if (promptFn) {
    try {
      return promptFn(message, defaultValue);
    } catch (err) {
      console.warn("window.prompt unavailable, falling back to custom prompt:", err);
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "app-prompt-overlay";
    overlay.innerHTML = `
      <div class="app-prompt-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(options.title || "输入")}">
        <div class="app-prompt-title">${escapeHtml(options.title || "请输入内容")}</div>
        <div class="app-prompt-message">${escapeHtml(message)}</div>
        <textarea class="app-prompt-input" rows="${options.multiline ? "5" : "3"}" placeholder="${escapeHtml(options.placeholder || "")}"></textarea>
        <div class="app-prompt-actions">
          <button type="button" class="btn-ghost" data-action="cancel">取消</button>
          <button type="button" class="btn-primary" data-action="confirm">确认</button>
        </div>
      </div>
    `;

    const input = overlay.querySelector(".app-prompt-input");
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    let settled = false;

    function cleanup(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    }

    input.value = defaultValue || "";
    document.body.appendChild(overlay);
    input.focus();
    input.setSelectionRange(0, input.value.length);

    confirmBtn.addEventListener("click", () => cleanup(input.value));
    cancelBtn.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        cleanup(input.value);
        return;
      }
      if (!options.multiline && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        cleanup(input.value);
      }
    });
  });
}

function formatTime(ts) {
  const d = new Date(parseInt(ts));
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const pad = (value) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// --- SVG Icon helpers ---
const SVG = {
  trash: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>',
  pause: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="4" x2="10" y2="20"></line><line x1="14" y1="4" x2="14" y2="20"></line></svg>',
  play: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>',
  file: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
  pdf: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
  paperclip: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>',
  stop: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  checkSquare: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
  square: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  refresh: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
};

function iconBtnHTML(iconSvg, extraClass) {
  return `<button class="icon-btn-sm${extraClass ? ' ' + extraClass : ''}">${iconSvg}</button>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);
  try {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: (code, lang) => {
        if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch {
            return code;
          }
        }
        return code;
      }
    });
    return marked.parse(text);
  } catch {
    return escapeHtml(text);
  }
}

// --- Code block copy buttons ---
function addCopyButtons(container) {
  const pres = container.querySelectorAll("pre");
  pres.forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains("code-block-wrapper")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.textContent || "";
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 2000);
      });
    });
    wrapper.appendChild(btn);
  });
}

// --- File preview detection ---
var IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
var PDF_EXTS = ["pdf"];

function detectFileUpload(content) {
  // Detect "文件地址: /absolute/path" pattern (client upload)
  const pathMatch = content.match(/文件地址:\s*(.+)/);
  if (pathMatch) {
    const filePath = pathMatch[1].trim();
    const filename = filePath.split("/").pop() || filePath;
    const ext = filename.split(".").pop().toLowerCase();
    return { filename, ext, filePath };
  }
  // Legacy: detect "📎 Uploaded: filename" pattern
  const match = content.match(/\u{1F4CE}\s*Uploaded:\s*(.+)/u);
  if (!match) return null;
  const filename = match[1].trim();
  const ext = filename.split(".").pop().toLowerCase();
  return { filename, ext, filePath: null };
}

function renderFilePreview(filename, ext, filePath) {
  const div = document.createElement("div");
  div.className = "file-preview";

  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement("img");
    img.className = "file-preview-image";
    img.loading = "lazy";
    img.decoding = "async";
    // Use file:// for local files, fallback to HTTP for legacy
    img.src = filePath ? `file://${filePath}` : `http://localhost:3000/api/uploads/${encodeURIComponent(filename)}`;
    img.alt = filename;
    img.addEventListener("click", () => openLightbox(img.src));
    div.appendChild(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "file-preview-icon";
    icon.innerHTML = PDF_EXTS.includes(ext) ? SVG.pdf : SVG.file;
    div.appendChild(icon);

    // "打开文件" button
    if (filePath) {
      const btn = document.createElement("button");
      btn.className = "file-open-btn";
      btn.innerHTML = `${SVG.paperclip} ${escapeHtml(filename)}`;
      btn.addEventListener("click", () => {
        if (window.nanoclawApp?.openFile) {
          window.nanoclawApp.openFile(filePath);
        } else {
          window.open(`file://${filePath}`);
        }
      });
      div.appendChild(btn);
    } else {
      const info = document.createElement("div");
      info.className = "file-preview-info";
      const link = document.createElement("a");
      link.className = "file-preview-name";
      link.href = `http://localhost:3000/api/uploads/${encodeURIComponent(filename)}`;
      link.target = "_blank";
      link.textContent = filename;
      info.appendChild(link);
      div.appendChild(info);
    }
  }
  return div;
}

function openLightbox(src) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  const img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

// --- Interactive card detection & rendering ---
function isCardMessage(msg) {
  if (!msg.content || !msg.is_bot_message) return false;
  try {
    const parsed = JSON.parse(msg.content);
    return parsed._type === "card" && parsed.card;
  } catch { return false; }
}

function parseCardContent(msg) {
  try { return JSON.parse(msg.content).card; } catch { return null; }
}

function lockCardInteraction(container, pendingLabel) {
  if (!container || container.dataset.locked === "1") return;
  container.dataset.locked = "1";
  container.classList.add("card-locked");
  const controls = container.querySelectorAll("button, input, select, textarea");
  controls.forEach((el) => {
    el.disabled = true;
  });
  if (pendingLabel) {
    const status = document.createElement("div");
    status.className = "card-submit-status";
    status.textContent = pendingLabel;
    container.appendChild(status);
  }
}

function validateCardFormField(input, value) {
  const text = String(value || "").trim();
  const label = input.placeholder || input.name;

  if (input.required && !text) return `${label} 为必填项`;
  if (!text) return null;

  if (input.type === "integer") {
    if (!/^[-+]?\d+$/.test(text)) return `${label} 必须是整数`;
    const n = Number.parseInt(text, 10);
    if (typeof input.min === "number" && n < input.min) return `${label} 不能小于 ${input.min}`;
    if (typeof input.max === "number" && n > input.max) return `${label} 不能大于 ${input.max}`;
  }
  if (input.type === "number") {
    const n = Number(text);
    if (Number.isNaN(n)) return `${label} 必须是数字`;
    if (typeof input.min === "number" && n < input.min) return `${label} 不能小于 ${input.min}`;
    if (typeof input.max === "number" && n > input.max) return `${label} 不能大于 ${input.max}`;
  }
  if (typeof input.min_length === "number" && text.length < input.min_length) {
    return `${label} 长度不能少于 ${input.min_length}`;
  }
  if (typeof input.max_length === "number" && text.length > input.max_length) {
    return `${label} 长度不能超过 ${input.max_length}`;
  }
  if (input.format === "email") {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!re.test(text)) return `${label} 不是有效邮箱`;
  }
  if (input.format === "uri") {
    try { new URL(text); } catch { return `${label} 不是有效链接`; }
  }
  if (input.format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${label} 日期格式应为 YYYY-MM-DD`;
  }
  if (input.format === "date-time") {
    if (Number.isNaN(new Date(text).getTime())) return `${label} 时间格式无效`;
  }

  return null;
}

function renderCardElement(card, msgId) {
  const container = document.createElement("div");
  container.className = "interactive-card";
  container.setAttribute("data-card-id", msgId);

  // Header
  const header = document.createElement("div");
  const color = card.header.color || "blue";
  header.className = `card-header card-color-${color}`;
  header.textContent = card.header.title;
  container.appendChild(header);

  // Body
  if (card.body) {
    const body = document.createElement("div");
    body.className = "card-body";
    body.innerHTML = renderMarkdown(card.body);
    container.appendChild(body);
  }

  // Buttons
  if (card.buttons && card.buttons.length > 0) {
    const actions = document.createElement("div");
    actions.className = "card-actions";
    for (const btn of card.buttons) {
      const button = document.createElement("button");
      button.className = `card-btn card-btn-${btn.type || "default"}`;
      button.textContent = btn.label;
      button.addEventListener("click", () => {
        lockCardInteraction(container, "已提交，处理中...");
        sendCardAction(btn.value, msgId);
      });
      actions.appendChild(button);
    }
    container.appendChild(actions);
  }

  // Sections (workflow list)
  if (card.sections) {
    for (let i = 0; i < card.sections.length; i++) {
      const section = card.sections[i];
      const sectionEl = document.createElement("div");
      sectionEl.className = "card-section";

      const bodyEl = document.createElement("div");
      bodyEl.className = "card-body";
      bodyEl.innerHTML = renderMarkdown(section.body);
      sectionEl.appendChild(bodyEl);

      if (section.buttons && section.buttons.length > 0) {
        const actions = document.createElement("div");
        actions.className = "card-actions";
        for (const btn of section.buttons) {
          const button = document.createElement("button");
          button.className = `card-btn card-btn-${btn.type || "default"}`;
          button.textContent = btn.label;
          button.addEventListener("click", () => {
            lockCardInteraction(container, "已提交，处理中...");
            sendCardAction(btn.value, msgId);
          });
          actions.appendChild(button);
        }
        sectionEl.appendChild(actions);
      }

      container.appendChild(sectionEl);
      if (i < card.sections.length - 1) {
        const hr = document.createElement("hr");
        hr.className = "card-divider";
        container.appendChild(hr);
      }
    }
  }

  // Form
  if (card.form) {
    const formEl = document.createElement("div");
    formEl.className = "card-form";
    const formError = document.createElement("div");
    formError.className = "card-form-error hidden";
    formEl.appendChild(formError);

    const formInputs = {};
    const clearInputErrors = () => {
      for (const item of Object.values(formInputs)) {
        if (item.errorEl) item.errorEl.remove();
        if (item.container) item.container.classList.remove("card-input-invalid");
      }
    };

    const addInputError = (item, message) => {
      if (!item || !message) return;
      if (item.errorEl) item.errorEl.remove();
      if (item.container) item.container.classList.add("card-input-invalid");
      const errEl = document.createElement("div");
      errEl.className = "card-input-error";
      errEl.textContent = message;
      item.errorEl = errEl;
      formEl.appendChild(errEl);
    };

    for (const input of card.form.inputs) {
      if (input.type === "enum" && Array.isArray(input.options) && input.options.length > 0) {
        const selectEl = document.createElement("select");
        selectEl.className = "card-input";
        selectEl.name = input.name;
        const emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = input.placeholder || "请选择";
        selectEl.appendChild(emptyOpt);
        for (const opt of input.options) {
          const optEl = document.createElement("option");
          optEl.value = opt.value;
          optEl.textContent = opt.label || opt.value;
          selectEl.appendChild(optEl);
        }
        formInputs[input.name] = { el: selectEl, type: "enum", meta: input, container: selectEl };
        formEl.appendChild(selectEl);
        if (input.error) addInputError(formInputs[input.name], input.error);
        continue;
      }

      if (input.type === "boolean") {
        const wrap = document.createElement("label");
        wrap.className = "card-input";
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "8px";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = input.name;
        const text = document.createElement("span");
        text.textContent = input.placeholder || input.name;
        wrap.appendChild(checkbox);
        wrap.appendChild(text);
        formInputs[input.name] = { el: checkbox, type: "boolean", meta: input, container: wrap };
        formEl.appendChild(wrap);
        if (input.error) addInputError(formInputs[input.name], input.error);
        continue;
      }

      const inputEl = document.createElement("input");
      inputEl.className = "card-input";
      inputEl.name = input.name;
      inputEl.placeholder = input.placeholder || "";
      if (input.type === "number") inputEl.type = "number";
      if (input.type === "integer") {
        inputEl.type = "number";
        inputEl.step = "1";
      }
      if (input.format === "date") inputEl.type = "date";
      if (input.format === "date-time") inputEl.type = "datetime-local";
      if (input.required) inputEl.required = true;
      if (typeof input.min === "number") inputEl.min = String(input.min);
      if (typeof input.max === "number") inputEl.max = String(input.max);
      if (typeof input.min_length === "number") inputEl.minLength = input.min_length;
      if (typeof input.max_length === "number") inputEl.maxLength = input.max_length;
      formInputs[input.name] = { el: inputEl, type: input.type || "text", meta: input, container: inputEl };
      formEl.appendChild(inputEl);
      if (input.error) addInputError(formInputs[input.name], input.error);
    }

    const submitBtn = document.createElement("button");
    submitBtn.className = `card-btn card-btn-${card.form.submitButton.type || "default"}`;
    submitBtn.textContent = card.form.submitButton.label;
    submitBtn.addEventListener("click", () => {
      clearInputErrors();
      const formValue = {};
      for (const [name, item] of Object.entries(formInputs)) {
        if (item.type === "boolean") {
          formValue[name] = item.el.checked ? "true" : "false";
        } else {
          formValue[name] = item.el.value;
        }
      }
      for (const [name, item] of Object.entries(formInputs)) {
        const val = item.type === "boolean" ? (item.el.checked ? "true" : "false") : item.el.value;
        const err = validateCardFormField(item.meta || {}, val);
        if (err) {
          addInputError(item, err);
          formError.textContent = `${name}: ${err}`;
          formError.classList.remove("hidden");
          return;
        }
      }
      formError.textContent = "";
      formError.classList.add("hidden");
      lockCardInteraction(container, "表单已提交，处理中...");
      sendCardAction(card.form.submitButton.value, msgId, formValue);
    });
    formEl.appendChild(submitBtn);
    container.appendChild(formEl);
  }

  return container;
}

function sendCardAction(value, cardId, formValue) {
  sendWs({
    type: "card_action",
    cardId: cardId,
    value: value,
    formValue: formValue || undefined,
  });
}

function getMessageAvatarHtml(isUser) {
  const avatarSrc = isUser ? "/assets/nobita.png" : "/assets/doraemon-face.png";
  const avatarAlt = isUser ? "Nobita" : "Doraemon";
  return `<div class="msg-avatar"><img src="${avatarSrc}" alt="${avatarAlt}" /></div>`;
}

// --- Create single message element (factory) ---
function createMessageEl(msg) {
  // Card messages get special rendering
  if (isCardMessage(msg)) {
    const card = parseCardContent(msg);
    if (card) {
      const senderName = msg.sender_name || msg.sender || "Assistant";
      const wrapper = document.createElement("div");
      wrapper.className = "message assistant card-message";
      wrapper.setAttribute("data-msg-id", msg.id);
      wrapper.setAttribute("data-timestamp", msg.timestamp);
      wrapper.innerHTML = `
        <div class="msg-select-check">\u2713</div>
        ${getMessageAvatarHtml(false)}
        <div class="msg-main">
          <div class="msg-header">
            <span class="msg-sender">${escapeHtml(senderName)}</span>
            <span class="msg-time">${formatTime(msg.timestamp)}</span>
          </div>
          <div class="msg-body"></div>
        </div>
      `;
      const body = wrapper.querySelector(".msg-body");
      if (body) body.appendChild(renderCardElement(card, msg.id));
      wrapper.addEventListener("click", (e) => {
        if (!multiSelectMode) return;
        if (e.target.closest(".msg-actions")) return;
        e.preventDefault();
        toggleMessageSelection(msg.id, wrapper);
      });
      return wrapper;
    }
  }

  // File messages: render as file card with icon and filename
  if (msg._filePath) {
    const senderName = msg.sender_name || msg.sender || "Assistant";
    const fileName = msg._filePath.split("/").pop() || msg.content;
    const ext = fileName.split(".").pop().toLowerCase();
    const wrapper = document.createElement("div");
    wrapper.className = "message assistant file-message";
    wrapper.setAttribute("data-msg-id", msg.id);
    wrapper.setAttribute("data-timestamp", msg.timestamp);
    wrapper.innerHTML = `
      <div class="msg-select-check">\u2713</div>
      ${getMessageAvatarHtml(false)}
      <div class="msg-main">
        <div class="msg-header">
          <span class="msg-sender">${escapeHtml(senderName)}</span>
          <span class="msg-time">${formatTime(msg.timestamp)}</span>
        </div>
        <div class="msg-body">
          <div class="file-card" data-ext="${escapeHtml(ext)}">
            <div class="file-card-icon">${getFileIcon(ext)}</div>
            <div class="file-card-name">${escapeHtml(fileName)}</div>
          </div>
        </div>
      </div>
    `;

    const card = wrapper.querySelector(".file-card");
    card.addEventListener("click", () => {
      if (window.nanoclawApp?.openFile) {
        window.nanoclawApp.openFile(msg._filePath);
      } else {
        window.open(`file://${msg._filePath}`);
      }
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showFileContextMenu(e, msg._filePath);
    });
    wrapper.addEventListener("click", (e) => {
      if (!multiSelectMode) return;
      if (e.target.closest(".msg-actions")) return;
      e.preventDefault();
      toggleMessageSelection(msg.id, wrapper);
    });
    return wrapper;
  }

  const div = document.createElement("div");
  const isUser = msg.is_from_me;
  const isSystem = msg.sender === "system";
  div.setAttribute("data-msg-id", msg.id);
  div.setAttribute("data-timestamp", msg.timestamp);

  if (isSystem) {
    div.className = "message system";
    div.textContent = msg.content;
    return div;
  }

  div.className = `message ${isUser ? "user" : "assistant"}`;

  // Reply quote block
  let replyHtml = "";
  if (msg.reply_to_id) {
    const quoted = messages.find((m) => m.id === msg.reply_to_id);
    const quotedText = quoted ? quoted.content.slice(0, 80) : "...";
    replyHtml = `<div class="msg-reply-quote" data-reply-id="${escapeHtml(msg.reply_to_id)}">${escapeHtml(quotedText)}</div>`;
  }

  const renderedContent = isUser ? escapeHtml(msg.content) : renderMarkdown(msg.content);
  const modelTail = isUser && msg.model
    ? `<div class="msg-model-tail">模型：${escapeHtml(msg.model)}</div>`
    : "";

  // Check for file upload
  const fileInfo = detectFileUpload(msg.content);
  const groupFolder = currentGroupJid.replace("web:", "");

  div.innerHTML = `
    <div class="msg-select-check">\u2713</div>
    ${getMessageAvatarHtml(isUser)}
    <div class="msg-main">
      <div class="msg-header">
        ${msg.sender_name ? `<span class="msg-sender">${escapeHtml(msg.sender_name)}</span>` : ""}
        <span class="msg-time">${formatTime(msg.timestamp)}</span>
      </div>
      <div class="msg-body">
        <div class="msg-actions">
          <button class="msg-copy-btn" title="\u590D\u5236"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
          <button class="msg-reply-btn" title="Reply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg></button>
        </div>
        ${replyHtml}
        <div class="msg-content">${renderedContent}</div>
      </div>
      ${modelTail}
    </div>
  `;

  // Add file preview if detected
  if (fileInfo) {
    const preview = renderFilePreview(fileInfo.filename, fileInfo.ext, fileInfo.filePath);
    const contentEl = div.querySelector(".msg-content");
    contentEl.appendChild(preview);
  }

  // Add copy buttons to code blocks
  addCopyButtons(div);

  // Reply button handler
  const replyBtn = div.querySelector(".msg-reply-btn");
  if (replyBtn) {
    replyBtn.addEventListener("click", () => setReplyTo(msg));
  }

  // Copy button handler
  const copyBtn = div.querySelector(".msg-copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => copyMessageContent(msg));
  }

  // Multi-select click handler
  div.addEventListener("click", (e) => {
    if (!multiSelectMode) return;
    if (e.target.closest(".msg-actions")) return;
    e.preventDefault();
    toggleMessageSelection(msg.id, div);
  });

  return div;
}

// --- File icon by extension ---
function getFileIcon(ext) {
  const icons = {
    pdf: "📄", doc: "📝", docx: "📝", txt: "📃",
    sql: "🗃️", db: "🗃️",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
    mp4: "🎬", mov: "🎬", avi: "🎬",
    mp3: "🎵", wav: "🎵", flac: "🎵",
    zip: "📦", rar: "📦", tar: "📦", gz: "📦",
    js: "⚡", ts: "⚡", py: "🐍", java: "☕", go: "🔵", rs: "🦀",
    json: "📋", xml: "📋", csv: "📊",
    xls: "📊", xlsx: "📊",
    ppt: "📑", pptx: "📑",
    html: "🌐", css: "🎨",
  };
  return icons[ext] || "📎";
}

// --- File context menu ---
function showFileContextMenu(e, filePath) {
  // Remove existing menu if any
  document.querySelector(".file-context-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "file-context-menu";

  const items = [
    { label: "打开", icon: "📂", action: () => window.nanoclawApp?.openFile?.(filePath) },
    { label: "打开方式…", icon: "🔀", action: () => window.nanoclawApp?.openFileWith?.(filePath) },
    { label: "在文件夹中显示", icon: "📁", action: () => window.nanoclawApp?.showInFolder?.(filePath) },
    { label: "复制路径", icon: "📋", action: () => navigator.clipboard?.writeText(filePath) },
  ];

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "file-context-item";
    el.innerHTML = `<span class="file-context-icon">${item.icon}</span>${escapeHtml(item.label)}`;
    el.addEventListener("click", () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(el);
  }

  // Position at cursor
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  // Adjust if menu overflows viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  // Close on click outside
  const closeHandler = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  requestAnimationFrame(() => document.addEventListener("click", closeHandler));
}

function scheduleModelSync() {
  if (!currentGroupJid) return;
  if (modelSyncTimer) clearTimeout(modelSyncTimer);
  modelSyncTimer = setTimeout(async () => {
    if (!currentGroupJid) return;
    try {
      const res = await apiFetch(`/api/messages?jid=${encodeURIComponent(currentGroupJid)}&since=0`);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.messages)) return;
      messages = data.messages.map(m => ({ ...m, _filePath: m.file_path || undefined }));
      renderMessages();
    } catch {
      // Best effort only.
    }
  }, 900);
}

// --- Skeleton loading ---
function showSkeleton() {
  messagesEmpty.style.display = "none";
  const existing = messagesEl.querySelectorAll(".message, .skeleton-message");
  existing.forEach((el) => el.remove());
  for (let i = 0; i < 5; i++) {
    const skel = document.createElement("div");
    skel.className = "skeleton-message";
    const widths = ["sender", i % 2 === 0 ? "long" : "medium", "short"];
    widths.forEach((w) => {
      const line = document.createElement("div");
      line.className = `skeleton-line ${w}`;
      skel.appendChild(line);
    });
    messagesEl.appendChild(skel);
  }
}

function clearSkeleton() {
  const skeletons = messagesEl.querySelectorAll(".skeleton-message");
  skeletons.forEach((el) => el.remove());
}

function setConnectionStatus(status) {
  connectionStatus.className = `conn-status ${status}`;
  const label = connectionStatus.querySelector(".conn-label");
  label.textContent = status === "connected" ? "Connected" : status === "connecting" ? "Connecting..." : "Disconnected";
}

function setPrimaryNav(navKey) {
  if (navKey === null || navKey === void 0) return;
  activePrimaryNavKey = navKey;
  primaryNavItems.forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-nav-key") === navKey);
  });
  const showWorkbench = navKey === "workbench";
  const showWorkspace = navKey === "agent-groups";
  const showMemoryManagement = navKey === "memory-management";
  const showTraceMonitor = navKey === "trace-monitor";
  if (workbenchScreen) {
    workbenchScreen.classList.toggle("active", showWorkbench);
  }
  if (workspace) {
    workspace.classList.toggle("active", showWorkspace);
  }
  if (memoryManagementScreen) {
    memoryManagementScreen.classList.toggle("active", showMemoryManagement);
  }
  if (traceMonitorScreen) {
    traceMonitorScreen.classList.toggle("active", showTraceMonitor);
  }
  if (showMemoryManagement) {
    renderDoctorPanel();
    renderMemoryList();
    loadMemories();
  }
  if (showWorkbench) {
    loadWorkbenchTasks();
  }
  if (showTraceMonitor) {
    loadTraceMonitorData({ force: false });
  }
}

function cyclePrimaryNav(step) {
  if (!primaryNavItems.length) return;
  const currentIndex = primaryNavItems.findIndex((item) => item.getAttribute("data-nav-key") === activePrimaryNavKey);
  const baseIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (baseIndex + step + primaryNavItems.length) % primaryNavItems.length;
  const nextNavKey = primaryNavItems[nextIndex] && primaryNavItems[nextIndex].getAttribute("data-nav-key");
  if (nextNavKey) {
    setPrimaryNav(nextNavKey);
  }
}

function openSchedulersPanel() {
  agentStatusPanel.classList.remove("open");
  workflowsPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
  schedulersPanel.classList.add("open");
  loadSchedulers();
}

function openAgentStatusPanel() {
  schedulersPanel.classList.remove("open");
  workflowsPanel.classList.remove("open");
  agentStatusPanel.classList.add("open");
  loadAgentStatus();
  if (agentStatusInterval) clearInterval(agentStatusInterval);
  agentStatusInterval = setInterval(updateAgentDurations, 1000);
}

function openWorkflowsPanel() {
  schedulersPanel.classList.remove("open");
  agentStatusPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
  workflowsPanel.classList.add("open");
  loadWorkflows();
}

function renderGroups() {
  initFixedGroupAvatarMap();
  groupsList.innerHTML = "";
  for (const group of groups) {
    const el = document.createElement("div");
    el.className = `list-item${group.jid === currentGroupJid ? " active" : ""}`;

    const avatar = getFixedAvatar(group);
    const initial = (group.name || "?")[0].toUpperCase();
    const unread = unreadCounts[group.jid] || 0;
    const iconHtml = avatar
      ? `<span class="item-icon item-avatar"><img src="${avatar}" alt="Group avatar" /></span>`
      : `<span class="item-icon">${escapeHtml(initial)}</span>`;

    el.innerHTML = `
      ${iconHtml}
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ""}
      ${unread > 0 ? `<span class="item-unread">${unread > 99 ? "99+" : unread}</span>` : ""}
    `;
    el.addEventListener("click", () => selectGroup(group.jid));
    groupsList.appendChild(el);
  }
}

function getDefaultMemoryGroupJid() {
  if (!Array.isArray(groups) || groups.length === 0) return "";
  const mainGroup = groups.find((g) => g.isMain);
  return (mainGroup && mainGroup.jid) || groups[0].jid || "";
}

function updateMemoryGroupHeader() {
  if (!memoryGroupTitle || !memoryGroupFolder || !memoryGroupSummary) return;
  const group = groups.find((g) => g.jid === activeMemoryGroupJid);
  if (!group) {
    memoryGroupTitle.textContent = "记忆管理";
    memoryGroupFolder.textContent = "";
    memoryGroupSummary.textContent = "请先在左侧选择一个 Group。记忆管理按 Group（group_folder）隔离。";
    return;
  }
  memoryGroupTitle.textContent = group.name;
  memoryGroupFolder.textContent = group.isMain ? "(main)" : `@ ${group.folder}`;
  memoryGroupSummary.textContent = `当前 Group: ${group.folder}。可在此范围内进行记忆检索、整理与维护。`;
}

function selectMemoryGroup(jid) {
  activeMemoryGroupJid = jid;
  closeMemoryEditor();
  closeDoctorPanel();
  closeMemoryMetricsModal();
  memoryDoctorReport = null;
  memoryDoctorMap = {};
  memoryMetricsSummary = null;
  renderDoctorPanel();
  setDoctorLog("");
  renderMemoryGroups();
  updateMemoryGroupHeader();
  loadMemories();
}

function renderMemoryGroups() {
  if (!memoryGroupsList) return;
  initFixedGroupAvatarMap();
  memoryGroupsList.innerHTML = "";
  for (const group of groups) {
    const el = document.createElement("div");
    el.className = `list-item${group.jid === activeMemoryGroupJid ? " active" : ""}`;
    const avatar = getFixedAvatar(group);
    const initial = (group.name || "?")[0].toUpperCase();
    const iconHtml = avatar
      ? `<span class="item-icon item-avatar"><img src="${avatar}" alt="Group avatar" /></span>`
      : `<span class="item-icon">${escapeHtml(initial)}</span>`;
    el.innerHTML = `
      ${iconHtml}
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ""}
    `;
    el.addEventListener("click", () => selectMemoryGroup(group.jid));
    memoryGroupsList.appendChild(el);
  }
}

function formatDateTime(ts) {
  if (ts === null || ts === undefined || ts === "") return "--";
  const parsedMs = parseTimestamp(ts);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return "--";
  const parsed = new Date(parsedMs);
  return parsed.toLocaleString();
}

function parseTimestamp(ts) {
  if (ts === null || ts === undefined || ts === "") return NaN;
  const numeric = Number(ts);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getPayloadTimestamp(payload) {
  return payload.createdAt || payload.created_at || payload.updatedAt || payload.updated_at || new Date().toISOString();
}

function getActiveMemoryGroup() {
  return groups.find((g) => g.jid === activeMemoryGroupJid) || null;
}

function closeMemoryEditor() {
  editingMemoryId = "";
  if (memoryEditor) memoryEditor.classList.add("hidden");
  syncMemoryModalMask();
}

function openMemoryEditor() {
  if (memoryEditor) memoryEditor.classList.remove("hidden");
  syncMemoryModalMask();
}

function closeDoctorPanel() {
  if (memoryDoctorPanel) memoryDoctorPanel.classList.add("hidden");
  syncMemoryModalMask();
}

function openDoctorPanel() {
  if (memoryDoctorPanel) memoryDoctorPanel.classList.remove("hidden");
  syncMemoryModalMask();
}

function closeMemoryMetricsModal() {
  if (memoryMetricsModal) memoryMetricsModal.classList.add("hidden");
  syncMemoryModalMask();
}

function openMemoryMetricsModal() {
  if (memoryMetricsModal) memoryMetricsModal.classList.remove("hidden");
  syncMemoryModalMask();
}

function syncMemoryModalMask() {
  if (!memoryModalMask) return;
  const editorVisible = memoryEditor && !memoryEditor.classList.contains("hidden");
  const doctorVisible = memoryDoctorPanel && !memoryDoctorPanel.classList.contains("hidden");
  const metricsVisible = memoryMetricsModal && !memoryMetricsModal.classList.contains("hidden");
  memoryModalMask.classList.toggle("hidden", !(editorVisible || doctorVisible || metricsVisible));
}

function setDoctorLog(text) {
  if (memoryDoctorLog) {
    memoryDoctorLog.textContent = text || "";
  }
}

function getMemoryBrief(id) {
  const m = memoryDoctorMap && memoryDoctorMap[id];
  if (!m) return id;
  const content = (m.content || "").replace(/\s+/g, " ").slice(0, 80);
  return `${id}: ${content}`;
}

function renderMemoryMetricsModal() {
  if (!memoryMetricsWindow || !memoryMetricsTotal || !memoryMetricsList) return;
  const group = getActiveMemoryGroup();
  const groupLabel = group ? group.folder : "--";
  if (!memoryMetricsSummary) {
    memoryMetricsWindow.textContent = `${groupLabel} | 加载中...`;
    memoryMetricsTotal.textContent = "正在获取统计数据...";
    memoryMetricsList.innerHTML = "";
    return;
  }
  const summary = memoryMetricsSummary;
  memoryMetricsWindow.textContent = `${groupLabel} | 最近 ${summary.hours}h`;
  memoryMetricsTotal.textContent = `总事件数: ${summary.total}`;
  const rows = Array.isArray(summary.byEvent) ? summary.byEvent : [];
  if (rows.length === 0) {
    memoryMetricsList.innerHTML = '<div class="memory-metrics-item"><span>暂无事件</span><span class="count">0</span></div>';
    return;
  }
  memoryMetricsList.innerHTML = rows
    .map(
      (row) =>
        `<div class="memory-metrics-item"><span>${escapeHtml(row.event || "")}</span><span class="count">${escapeHtml(String(row.count || 0))}</span></div>`,
    )
    .join("");
}

function renderDoctorPanel() {
  if (!memoryDoctorPanel || !memoryDoctorSummary || !memoryDuplicatesList || !memoryStaleList || !memoryConflictsList) return;
  if (!memoryDoctorReport) {
    memoryDoctorSummary.textContent = "暂无报告";
    memoryDuplicatesList.innerHTML = '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    memoryStaleList.innerHTML = '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    memoryConflictsList.innerHTML = '<div class="memory-doctor-item">请点击 Doctor 按钮生成报告</div>';
    return;
  }
  const report = memoryDoctorReport;
  memoryDoctorSummary.textContent =
    `total=${report.total}, duplicate=${report.duplicateGroups.length}, conflict=${report.conflictGroups.length}, stale=${report.staleWorkingIds.length}`;

  memoryDuplicatesList.innerHTML = "";
  if (report.duplicateGroups.length === 0) {
    memoryDuplicatesList.innerHTML = '<div class="memory-doctor-item">无重复组</div>';
  } else {
    for (const g of report.duplicateGroups) {
      const el = document.createElement("div");
      el.className = "memory-doctor-item";
      el.innerHTML = `
        <div><strong>${escapeHtml(g.key)}</strong></div>
        <div>${g.ids.map((id) => escapeHtml(getMemoryBrief(id))).join("<br/>")}</div>
      `;
      memoryDuplicatesList.appendChild(el);
    }
  }

  memoryStaleList.innerHTML = "";
  if (report.staleWorkingIds.length === 0) {
    memoryStaleList.innerHTML = '<div class="memory-doctor-item">无过期 working</div>';
  } else {
    for (const id of report.staleWorkingIds) {
      const el = document.createElement("div");
      el.className = "memory-doctor-item";
      el.textContent = getMemoryBrief(id);
      memoryStaleList.appendChild(el);
    }
  }

  memoryConflictsList.innerHTML = "";
  if (report.conflictGroups.length === 0) {
    memoryConflictsList.innerHTML = '<div class="memory-doctor-item">无冲突组</div>';
  } else {
    for (const g of report.conflictGroups) {
      const ids = [...g.positiveIds, ...g.negativeIds];
      const keepDefault = g.positiveIds[0] || ids[0] || "";
      const depDefault = g.negativeIds[0] || ids[1] || "";
      const el = document.createElement("div");
      el.className = "memory-doctor-item";
      el.innerHTML = `
        <div><strong>${escapeHtml(g.key)}</strong></div>
        <div>Positive: ${g.positiveIds.map((id) => escapeHtml(getMemoryBrief(id))).join("<br/>") || "-"}</div>
        <div>Negative: ${g.negativeIds.map((id) => escapeHtml(getMemoryBrief(id))).join("<br/>") || "-"}</div>
        <div class="memory-doctor-actions">
          <button class="memory-action-btn" data-action="keep" data-keep-default="${escapeHtml(keepDefault)}" data-deprecate-default="${escapeHtml(depDefault)}" data-ids="${escapeHtml(ids.join(','))}">Keep</button>
          <button class="memory-action-btn" data-action="merge" data-ids="${escapeHtml(ids.join(','))}">Merge</button>
        </div>
      `;
      const keepBtn = el.querySelector('button[data-action="keep"]');
      const mergeBtn = el.querySelector('button[data-action="merge"]');
      if (keepBtn) {
        keepBtn.addEventListener("click", async () => {
          const allowed = (keepBtn.getAttribute("data-ids") || "").split(",").filter(Boolean);
          const keepDefaultId = keepBtn.getAttribute("data-keep-default") || "";
          const depDefaultId = keepBtn.getAttribute("data-deprecate-default") || "";
          const keepId = ((await openTextPrompt(`输入 keep_id（候选：${allowed.join(", ")}）`, keepDefaultId, { title: "冲突处理" })) || "").trim();
          const deprecateId = ((await openTextPrompt(`输入 deprecate_id（候选：${allowed.join(", ")}）`, depDefaultId, { title: "冲突处理" })) || "").trim();
          if (!keepId || !deprecateId || keepId === deprecateId) return;
          if (!allowed.includes(keepId) || !allowed.includes(deprecateId)) {
            alert("所选 ID 不在该冲突组内");
            return;
          }
          await resolveConflictKeep(keepId, deprecateId);
        });
      }
      if (mergeBtn) {
        mergeBtn.addEventListener("click", async () => {
          const allowed = (mergeBtn.getAttribute("data-ids") || "").split(",").filter(Boolean);
          const raw = ((await openTextPrompt(`输入两个 merge_ids（逗号分隔，候选：${allowed.join(", ")}）`, "", { title: "冲突合并" })) || "").trim();
          if (!raw) return;
          const picks = raw.split(",").map((s) => s.trim()).filter(Boolean);
          if (picks.length !== 2 || picks[0] === picks[1]) {
            alert("请提供两个不同的 ID");
            return;
          }
          if (!allowed.includes(picks[0]) || !allowed.includes(picks[1])) {
            alert("所选 ID 不在该冲突组内");
            return;
          }
          const mergedContent = ((await openTextPrompt("输入 merged_content", "", { title: "冲突合并", multiline: true })) || "").trim();
          if (!mergedContent) return;
          await resolveConflictMerge([picks[0], picks[1]], mergedContent);
        });
      }
      memoryConflictsList.appendChild(el);
    }
  }
}

async function runDoctor(staleDays) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  const safeDays = Number.isFinite(Number(staleDays)) ? Number(staleDays) : 7;
  openDoctorPanel();
  renderDoctorPanel();
  setDoctorLog("Doctor 执行中...");
  try {
    const res = await apiFetch("/api/memory/doctor", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        staleDays: safeDays,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    memoryDoctorReport = data.report || null;
    memoryDoctorMap = data.memoryMap || {};
    renderDoctorPanel();
    setDoctorLog(`Doctor 完成（staleDays=${safeDays}）`);
  } catch (err) {
    console.error("Doctor failed:", err);
    setDoctorLog(`Doctor 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function showMemoryMetrics(hours) {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert("请先选择 Group");
    return;
  }
  const safeHours = Number.isFinite(Number(hours)) ? Number(hours) : 24;
  memoryMetricsSummary = null;
  openMemoryMetricsModal();
  renderMemoryMetricsModal();
  try {
    const res = await apiFetch("/api/memory/metrics", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        hours: safeHours,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    memoryMetricsSummary = data.summary || { hours: safeHours, total: 0, byEvent: [] };
    renderMemoryMetricsModal();
  } catch (err) {
    console.error("Load memory metrics failed:", err);
    memoryMetricsSummary = { hours: safeHours, total: 0, byEvent: [] };
    renderMemoryMetricsModal();
    if (memoryMetricsTotal) {
      memoryMetricsTotal.textContent = `获取失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

async function runGcByMode(mode) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const dryRunRes = await apiFetch("/api/memory/gc", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        mode,
        dryRun: true,
      }),
    });
    const dryRunData = await dryRunRes.json();
    if (!dryRunRes.ok) throw new Error(dryRunData?.error || `HTTP ${dryRunRes.status}`);
    const r = dryRunData.result || {};
    const dup = (r.duplicateDeletedIds || []).length;
    const stale = (r.staleDeletedIds || []).length;
    const total = Number(r.totalCandidates || 0);
    if (total === 0) {
      setDoctorLog(`GC 预演完成：无需清理（mode=${mode}）`);
      return;
    }
    if (!confirm(`GC预演结果：重复=${dup}，过期=${stale}，共=${total}。确认执行真实清理？`)) {
      setDoctorLog("GC 已取消");
      return;
    }
    const runRes = await apiFetch("/api/memory/gc", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        mode,
        dryRun: false,
      }),
    });
    const runData = await runRes.json();
    if (!runRes.ok) throw new Error(runData?.error || `HTTP ${runRes.status}`);
    setDoctorLog(`GC 完成：mode=${mode}, 删除=${runData.result?.totalCandidates || 0}`);
    loadMemories(memorySearchInput?.value || "");
    runDoctor(7);
  } catch (err) {
    console.error("GC failed:", err);
    setDoctorLog(`GC 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolveConflictKeep(keepId, deprecateId) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const res = await apiFetch("/api/memory/conflict/keep", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        keep_id: keepId,
        deprecate_id: deprecateId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setDoctorLog(`冲突已 Keep：${keepId} 保留，${deprecateId} 废弃`);
    loadMemories(memorySearchInput?.value || "");
    runDoctor(7);
  } catch (err) {
    console.error("Conflict keep failed:", err);
    setDoctorLog(`Keep 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolveConflictMerge(mergeIds, mergedContent) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  try {
    const res = await apiFetch("/api/memory/conflict/merge", {
      method: "POST",
      body: JSON.stringify({
        folder: group.folder,
        merge_ids: mergeIds,
        merged_content: mergedContent,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setDoctorLog(`冲突已 Merge：${mergeIds.join(",")} -> ${data?.result?.merged?.id || "new"}`);
    loadMemories(memorySearchInput?.value || "");
    runDoctor(7);
  } catch (err) {
    console.error("Conflict merge failed:", err);
    setDoctorLog(`Merge 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function openCreateMemoryEditor() {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert("请先选择 Group");
    return;
  }
  editingMemoryId = "";
  if (memoryEditorTitle) memoryEditorTitle.textContent = "新增记忆";
  if (memoryLayerSelect) memoryLayerSelect.value = "working";
  if (memoryTypeSelect) memoryTypeSelect.value = "fact";
  if (memoryStatusSelect) memoryStatusSelect.value = "active";
  if (memoryContentInput) memoryContentInput.value = "";
  openMemoryEditor();
  memoryContentInput?.focus();
}

function openEditMemoryEditor(mem) {
  editingMemoryId = mem?.id || "";
  if (!editingMemoryId) return;
  if (memoryEditorTitle) memoryEditorTitle.textContent = "编辑记忆";
  if (memoryLayerSelect) memoryLayerSelect.value = mem.layer || "working";
  if (memoryTypeSelect) memoryTypeSelect.value = mem.memory_type || "fact";
  if (memoryStatusSelect) memoryStatusSelect.value = mem.status || "active";
  if (memoryContentInput) memoryContentInput.value = mem.content || "";
  openMemoryEditor();
  memoryContentInput?.focus();
}

async function saveMemoryEditor() {
  const group = getActiveMemoryGroup();
  if (!group) {
    alert("请先选择 Group");
    return;
  }
  const content = (memoryContentInput?.value || "").trim();
  if (!content) {
    alert("记忆内容不能为空");
    return;
  }
  const payload = {
    folder: group.folder,
    content,
    layer: memoryLayerSelect?.value || "working",
    memory_type: memoryTypeSelect?.value || "fact",
    memory_status: memoryStatusSelect?.value || "active",
  };

  try {
    if (editingMemoryId) {
      const res = await apiFetch("/api/memory", {
        method: "PATCH",
        body: JSON.stringify({
          memoryId: editingMemoryId,
          ...payload,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
    } else {
      const res = await apiFetch("/api/memory", {
        method: "POST",
        body: JSON.stringify({
          folder: payload.folder,
          content: payload.content,
          layer: payload.layer,
          memory_type: payload.memory_type,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
    }
    closeMemoryEditor();
    loadMemories(memorySearchInput?.value || "");
  } catch (err) {
    console.error("Failed to save memory:", err);
    alert("保存记忆失败");
  }
}

async function deleteMemoryById(memoryId) {
  const group = getActiveMemoryGroup();
  if (!group) return;
  if (!confirm("确认删除该记忆？")) return;
  try {
    const res = await apiFetch(
      `/api/memory?id=${encodeURIComponent(memoryId)}&folder=${encodeURIComponent(group.folder)}`,
      { method: "DELETE" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    loadMemories(memorySearchInput?.value || "");
  } catch (err) {
    console.error("Failed to delete memory:", err);
    alert("删除记忆失败");
  }
}

function renderMemoryList() {
  if (!memoryList || !memoryEmpty) return;
  memoryList.innerHTML = "";
  const visibleMemories =
    memoryStatusFilterValue === "all"
      ? memoryEntries
      : memoryEntries.filter((m) => (m.status || "active") === memoryStatusFilterValue);
  if (!activeMemoryGroupJid) {
    memoryEmpty.textContent = "请先在左侧选择 Group";
    memoryEmpty.classList.remove("hidden");
    return;
  }
  if (!Array.isArray(visibleMemories) || visibleMemories.length === 0) {
    if (memoryEntries.length > 0 && memoryStatusFilterValue !== "all") {
      memoryEmpty.textContent = `当前筛选（${memoryStatusFilterValue}）下无记忆`;
    } else {
      memoryEmpty.textContent = memoryQueryText
        ? `没有匹配“${memoryQueryText}”的记忆`
        : "当前 Group 暂无记忆";
    }
    memoryEmpty.classList.remove("hidden");
    return;
  }

  memoryEmpty.classList.add("hidden");
  for (const mem of visibleMemories) {
    const item = document.createElement("div");
    item.className = "memory-item";
    const statusClass = `status-${mem.status || "active"}`;
    item.innerHTML = `
      <div class="memory-item-header">
        <span class="memory-tag">${escapeHtml(mem.layer || "")}</span>
        <span class="memory-tag">${escapeHtml(mem.memory_type || "")}</span>
        <span class="memory-tag ${statusClass}">${escapeHtml(mem.status || "active")}</span>
        <span class="memory-item-time">${escapeHtml(formatDateTime(mem.updated_at))}</span>
      </div>
      <p class="memory-item-content">${escapeHtml(mem.content || "")}</p>
      <div class="memory-item-actions">
        <button class="memory-action-btn" data-action="edit" data-memory-id="${escapeHtml(mem.id || "")}">编辑</button>
        <button class="memory-action-btn danger" data-action="delete" data-memory-id="${escapeHtml(mem.id || "")}">删除</button>
      </div>
    `;
    const editBtn = item.querySelector('button[data-action="edit"]');
    const deleteBtn = item.querySelector('button[data-action="delete"]');
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        openEditMemoryEditor(mem);
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        deleteMemoryById(mem.id);
      });
    }
    memoryList.appendChild(item);
  }
}

async function loadMemories(queryOverride) {
  const group = groups.find((g) => g.jid === activeMemoryGroupJid);
  if (!group) {
    memoryEntries = [];
    renderMemoryList();
    return;
  }

  const query =
    typeof queryOverride === "string"
      ? queryOverride.trim()
      : (memorySearchInput?.value || "").trim();
  memoryQueryText = query;

  const reqSeq = ++memoryRequestSeq;
  if (memoryRefreshBtn) {
    memoryRefreshBtn.classList.add("spinning");
  }
  try {
    const params = new URLSearchParams({
      folder: group.folder,
      limit: "200",
    });
    if (query) params.set("query", query);
    const res = await apiFetch(`/api/memories?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (reqSeq !== memoryRequestSeq) return;
    memoryEntries = Array.isArray(data.memories) ? data.memories : [];
    renderMemoryList();
  } catch (err) {
    if (reqSeq !== memoryRequestSeq) return;
    console.error("Failed to load memories:", err);
    memoryEntries = [];
    if (memoryEmpty) {
      memoryEmpty.textContent = "记忆加载失败";
      memoryEmpty.classList.remove("hidden");
    }
    if (memoryList) {
      memoryList.innerHTML = "";
    }
  } finally {
    if (reqSeq === memoryRequestSeq && memoryRefreshBtn) {
      memoryRefreshBtn.classList.remove("spinning");
    }
  }
}

function renderMessages() {
  clearSkeleton();
  if (messages.length === 0) {
    messagesEmpty.style.display = "flex";
    messagesEmpty.innerHTML = '<span>Select a group to initiate session</span>';
    const existing2 = messagesEl.querySelectorAll(".message");
    existing2.forEach((el) => el.remove());
    return;
  }
  messagesEmpty.style.display = "none";
  const existing = messagesEl.querySelectorAll(".message");
  existing.forEach((el) => el.remove());
  for (const msg of messages) {
    messagesEl.appendChild(createMessageEl(msg));
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Append a single message without full re-render
function appendSingleMessage(msg) {
  messagesEmpty.style.display = "none";
  clearSkeleton();
  // Avoid duplicate
  if (messagesEl.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`)) return;
  const el = createMessageEl(msg);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function trimLiveMessageBuffer() {
  if (messages.length <= LIVE_MESSAGE_BUFFER_LIMIT) return 0;

  const removedMessages = messages.slice(0, messages.length - LIVE_MESSAGE_BUFFER_LIMIT);
  const removedIds = new Set(removedMessages.map((msg) => msg.id));
  messages = messages.slice(-LIVE_MESSAGE_BUFFER_LIMIT);

  if (replyToMsg && removedIds.has(replyToMsg.id)) {
    clearReplyTo();
  }

  if (selectedMsgIds.size > 0) {
    removedIds.forEach((id) => selectedMsgIds.delete(id));
    updateSelectedBar();
  }

  return removedMessages.length;
}

function updateChatHeader() {
  if (!currentGroupJid) {
    chatGroupName.textContent = "Select a group";
    chatGroupFolder.textContent = "";
    return;
  }
  const group = groups.find((g) => g.jid === currentGroupJid);
  if (group) {
    chatGroupName.textContent = group.name;
    chatGroupFolder.textContent = group.isMain ? "(main)" : `@ ${group.folder}`;
  }
}

function getCurrentGroup() {
  if (!currentGroupJid) return null;
  return groups.find((g) => g.jid === currentGroupJid) || null;
}

function isCurrentGroupMain() {
  return getCurrentGroup()?.isMain === true;
}

async function loadGroups() {
  try {
    const res = await apiFetch("/api/groups");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    groups = data.groups;
    renderGroups();
    if (!groups.some((g) => g.jid === activeMemoryGroupJid)) {
      activeMemoryGroupJid = getDefaultMemoryGroupJid();
    }
    renderMemoryGroups();
    updateMemoryGroupHeader();
    renderMemoryList();
    if (activePrimaryNavKey === "memory-management") {
      loadMemories();
    }
  } catch (err) {
    console.error("Failed to load groups:", err);
  }
}
async function loadSchedulers() {
  try {
    const res = await apiFetch("/api/tasks");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    schedulersList.innerHTML = "";

    if (data.tasks.length === 0) {
      schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
      return;
    }

    // Group by group_folder
    const byGroup = {};
    for (const task of data.tasks) {
      const g = task.group_folder || "Unknown";
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(task);
    }

    for (const [group, tasks] of Object.entries(byGroup)) {
      const header = document.createElement("div");
      header.className = "scheduler-group-header";
      header.textContent = group;
      schedulersList.appendChild(header);

      for (const task of tasks) {
        const el = document.createElement("div");
        el.className = "scheduler-item";
        const status = task.status === "active" ? "active" : "paused";
        const statusIcon = task.status === "active" ? "\u25CF" : "\u25CB";
        const nextRun = task.next_run ? new Date(task.next_run).toLocaleString() : "—";
        const scheduleValue = task.schedule_type === 'once' && task.schedule_value
          ? new Date(task.schedule_value).toLocaleString()
          : task.schedule_value;
        el.innerHTML = `
          <div class="scheduler-prompt">${escapeHtml(task.prompt)}</div>
          <div class="scheduler-meta">
            <span class="scheduler-status ${status}">${statusIcon} ${task.status}</span>
            <span>${task.schedule_type}: ${scheduleValue}</span>
            <span>Next: ${nextRun}</span>
            <span class="scheduler-id">${escapeHtml(task.id)}</span>
            <button class="scheduler-delete-btn" title="Delete task">${SVG.trash}</button>
          </div>
        `;
        const deleteBtn = el.querySelector(".scheduler-delete-btn");
        deleteBtn.addEventListener("click", () => deleteSchedulerTask(task.id, el));
        schedulersList.appendChild(el);
      }
    }
  } catch (err) {
    console.error("Failed to load schedulers:", err);
    schedulersList.innerHTML = `<div class="schedulers-empty">Failed to load schedulers</div>`;
  }
}

async function deleteSchedulerTask(taskId, el) {
  if (!confirm("Delete this task?")) return;
  try {
    const res = await apiFetch(`/api/task?id=${encodeURIComponent(taskId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.remove();
    // Show empty message if no tasks left
    if (schedulersList.querySelectorAll(".scheduler-item").length === 0) {
      schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
    }
  } catch (err) {
    console.error("Failed to delete scheduler:", err);
    alert("Failed to delete task");
  }
}

async function deleteAllSchedulers() {
  if (!confirm("Delete all scheduled tasks?")) return;
  try {
    const res = await apiFetch("/api/tasks", { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    schedulersList.innerHTML = `<div class="schedulers-empty">No scheduled tasks</div>`;
  } catch (err) {
    console.error("Failed to delete all schedulers:", err);
    alert("Failed to delete all tasks");
  }
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function updateAgentDurations() {
  const now = Date.now();
  for (const agent of agentStatusData) {
    const elapsed = now - agent.startedAt;
    const el = document.querySelector(`[data-agent-jid="${CSS.escape(agent.groupJid)}"] .agent-status-duration`);
    if (el) {
      el.textContent = formatDuration(elapsed);
    }
  }
}

function updateAgentRunTraces(runs) {
  agentRunTraceByGroup = {};
  for (const run of runs) {
    if (run && run.groupJid) {
      agentRunTraceByGroup[run.groupJid] = run;
    }
  }
}

function parseAgentEventPayload(event) {
  if (!event || !event.payload_json) return null;
  if (typeof event.payload_json === "object") return event.payload_json;
  try {
    return JSON.parse(event.payload_json);
  } catch {
    return null;
  }
}

function renderAgentTraceEvent(event) {
  const payload = parseAgentEventPayload(event) || {};
  const summary = escapeHtml(event.summary || event.event_name || "event");
  const kind = escapeHtml(event.event_type || "event");
  const highlightVariant =
    event.event_name === "file_edit_complete"
      ? "edit"
      : event.event_name === "file_write_complete"
        ? "write"
        : "";
  const isHighlightedFileChange = Boolean(highlightVariant);
  const highlightTitle =
    highlightVariant === "edit"
      ? "Edited File"
      : highlightVariant === "write"
        ? "Wrote File"
        : "";
  let details = "";
  const filePath = typeof payload.path === "string" ? payload.path : "";
  const normalizedFilePath = filePath
    .replace(/^\/workspace\/group\//, "")
    .replace(/^\/workspace\/project\//, "")
    .replace(/^\/workspace\//, "");
  const hasDiffStats = payload.additions || payload.deletions;
  const collapsedDiffLines = Array.isArray(payload.patchPreview)
    ? payload.patchPreview.slice(0, 6)
    : [];
  const hiddenDiffLines = Array.isArray(payload.patchPreview)
    ? payload.patchPreview.slice(6)
    : [];

  if (collapsedDiffLines.length > 0) {
    details += `
      <div class="agent-trace-diff">
        <div class="agent-trace-diff-header">
          ${normalizedFilePath ? `<span class="agent-trace-diff-file">${escapeHtml(normalizedFilePath)}</span>` : `<span class="agent-trace-diff-file">Modified file</span>`}
          ${hasDiffStats ? `<span class="agent-trace-diff-badge plus">+${escapeHtml(String(payload.additions || 0))}</span><span class="agent-trace-diff-badge minus">-${escapeHtml(String(payload.deletions || 0))}</span>` : ""}
        </div>
        ${collapsedDiffLines.map((line) => `<div class="agent-trace-diff-line ${line.startsWith("+") ? "add" : "del"}">${escapeHtml(line)}</div>`).join("")}
        ${hiddenDiffLines.length > 0 ? `
          <details class="agent-trace-disclosure">
            <summary>Show ${hiddenDiffLines.length} more diff lines</summary>
            <div class="agent-trace-disclosure-body">
              ${hiddenDiffLines.map((line) => `<div class="agent-trace-diff-line ${line.startsWith("+") ? "add" : "del"}">${escapeHtml(line)}</div>`).join("")}
            </div>
          </details>
        ` : ""}
      </div>
    `;
  }

  if (Array.isArray(payload.filenames) && payload.filenames.length > 0) {
    details += `
      <div class="agent-trace-files">
        ${payload.filenames.map((name) => `<span class="agent-trace-file">${escapeHtml(name)}</span>`).join("")}
      </div>
    `;
  }

  if (typeof payload.contentPreview === "string" && payload.contentPreview.trim()) {
    const previewText = String(payload.contentPreview);
    const collapsedPreview = previewText.length > 320 ? previewText.slice(0, 320) : previewText;
    const hiddenPreview = previewText.length > 320 ? previewText.slice(320) : "";
    details += `
      <div class="agent-trace-preview-wrap">
        ${normalizedFilePath ? `<div class="agent-trace-preview-header">${escapeHtml(normalizedFilePath)}</div>` : ""}
        <pre class="agent-trace-preview">${escapeHtml(collapsedPreview)}${hiddenPreview ? "..." : ""}</pre>
      </div>
      ${hiddenPreview ? `
        <details class="agent-trace-disclosure">
          <summary>Show more matches</summary>
          <div class="agent-trace-preview-wrap">
            ${normalizedFilePath ? `<div class="agent-trace-preview-header">${escapeHtml(normalizedFilePath)}</div>` : ""}
            <pre class="agent-trace-preview agent-trace-preview-expanded">${escapeHtml(previewText)}</pre>
          </div>
        </details>
      ` : ""}
    `;
  }

  if (hasDiffStats && collapsedDiffLines.length === 0) {
    details += `<div class="agent-trace-stats">+${escapeHtml(String(payload.additions || 0))} / -${escapeHtml(String(payload.deletions || 0))}</div>`;
  }

  return `
    <div class="agent-trace-event${isHighlightedFileChange ? ` agent-trace-event-highlight agent-trace-event-highlight-${highlightVariant}` : ""}">
      ${highlightTitle ? `<div class="agent-trace-highlight-title">${escapeHtml(highlightTitle)}</div>` : ""}
      <div class="agent-trace-event-head${isHighlightedFileChange ? " agent-trace-event-head-highlight" : ""}">
        <span class="agent-trace-kind">${kind}</span>${summary}
      </div>
      ${details}
    </div>
  `;
}

function renderAgentStatus(agents) {
  agentStatusData = agents;
  if (agents.length === 0) {
    agentStatusList.innerHTML = `<div class="agent-status-empty">No active agents</div>`;
    return;
  }
  agentStatusList.innerHTML = "";
  for (const agent of agents) {
    const now = Date.now();
    const elapsed = now - agent.startedAt;
    const statusDot = agent.isIdle ? "agent-status-dot idle" : "agent-status-dot active";
    const typeLabel = agent.isTask ? "task" : "chat";
    const isStopping = stoppingAgentIds.has(agent.groupJid);
    const trace = agentRunTraceByGroup[agent.groupJid] || null;
    const currentAction = trace?.currentAction || "";
    const currentStep = trace?.currentStepType || "";
    const recentEvents = Array.isArray(trace?.recentEvents) ? trace.recentEvents.slice(-3).reverse() : [];

    const el = document.createElement("div");
    el.className = `agent-status-item${isStopping ? " is-stopping" : ""}`;
    el.setAttribute("data-agent-jid", agent.groupJid);
    // Format last message time
    let lastTimeStr = "";
    if (agent.lastTime) {
      const t = new Date(isNaN(Number(agent.lastTime)) ? agent.lastTime : Number(agent.lastTime));
      if (!isNaN(t.getTime())) {
        lastTimeStr = t.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }
    }

    el.innerHTML = `
      <div class="agent-status-name">
        <span class="${statusDot}"></span>
        ${escapeHtml(agent.groupName)}
      </div>
      <div class="agent-status-last-msg">
        <span class="agent-status-sender">${escapeHtml(agent.lastSender || "—")}</span>
        <span class="agent-status-time">${escapeHtml(lastTimeStr)}</span>
      </div>
      <div class="agent-status-content">${escapeHtml(agent.lastContent || "—")}</div>
      ${currentAction ? `<div class="agent-trace-current">${escapeHtml(currentAction)}</div>` : ""}
      ${currentStep ? `<div class="agent-trace-step">${escapeHtml(currentStep)}</div>` : ""}
      ${recentEvents.length > 0 ? `
        <div class="agent-trace-events">
          ${recentEvents.map((event) => renderAgentTraceEvent(event)).join("")}
        </div>
      ` : ""}
      <div class="agent-status-meta">
        <span class="agent-status-duration">${formatDuration(elapsed)}</span>
        <span class="agent-status-type">${typeLabel}</span>
        ${agent.activeWorkflowCount > 0 ? `<span class="agent-status-workflow-count">workflow ${escapeHtml(String(agent.activeWorkflowCount))}</span>` : ""}
        ${agent.pendingTaskCount > 0 ? `<span class="agent-status-pending">${agent.pendingTaskCount} pending</span>` : ""}
        ${agent.isTask && agent.runningTaskId ? `<span class="agent-status-task-id">${escapeHtml(agent.runningTaskId.slice(0, 8))}…</span>` : ""}
      </div>
      <div class="agent-status-actions">
        <button type="button" class="workflow-action-btn stop icon-text-btn agent-stop-btn"${isStopping ? " disabled" : ""}>
          ${isStopping ? "Stopping..." : `${SVG.stop} Stop`}
        </button>
      </div>
    `;
    const stopBtn = el.querySelector(".agent-stop-btn");
    if (!isStopping) {
      stopBtn.addEventListener("click", () => stopAgent(agent.groupJid, stopBtn));
    }
    agentStatusList.appendChild(el);
  }
}

async function stopAgent(groupJid, btn) {
  const agent = agentStatusData.find((item) => item.groupJid === groupJid);
  const activeWorkflowCount = Number(agent?.activeWorkflowCount || 0);
  const confirmMessage =
    activeWorkflowCount > 0
      ? `确认停止这个 agent 吗？\n\n这会同时取消 ${activeWorkflowCount} 个关联 workflow。`
      : agent?.isTask
        ? "确认停止这个任务 agent 吗？\n\n对应任务会被标记为暂停。"
        : "确认停止这个 agent 吗？\n\n当前会话会被中止，排队中的消息和任务也会清空。";
  if (!confirm(confirmMessage)) return;
  stoppingAgentIds.add(groupJid);
  renderAgentStatus(agentStatusData);
  try {
    const res = await apiFetch("/api/agent-status/stop", {
      method: "POST",
      body: JSON.stringify({ groupJid }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadAgentStatus();
    await loadWorkflows();
    const toastMessage =
      data.cancelledWorkflowIds?.length > 0
        ? `已停止 agent，并取消 ${data.cancelledWorkflowIds.length} 个 workflow`
        : data.stoppedTaskId
          ? "已停止任务 agent，任务已暂停"
          : "已停止 agent";
    showToast(toastMessage);
  } catch (err) {
    console.error("Failed to stop agent:", err);
    stoppingAgentIds.delete(groupJid);
    renderAgentStatus(agentStatusData);
    alert("Failed to stop agent: " + err.message);
  }
}

async function loadAgentStatus() {
  try {
    const [statusRes, traceRes] = await Promise.all([
      apiFetch("/api/agent-status"),
      apiFetch("/api/agent-queries/active")
    ]);
    if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
    if (!traceRes.ok) throw new Error(`HTTP ${traceRes.status}`);
    const data = await statusRes.json();
    const traceData = await traceRes.json();
    updateAgentRunTraces(traceData.queries || []);
    const activeIds = new Set((data.agents || []).map((agent) => agent.groupJid));
    stoppingAgentIds.forEach((groupJid) => {
      if (!activeIds.has(groupJid)) {
        stoppingAgentIds.delete(groupJid);
      }
    });
    renderAgentStatus(data.agents || []);
  } catch (err) {
    console.error("Failed to load agent status:", err);
    agentStatusList.innerHTML = `<div class="agent-status-empty">Failed to load</div>`;
  }
}

function formatRelativeTime(ts) {
  const ms = parseTimestamp(ts);
  if (!Number.isFinite(ms)) return "--";
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  if (abs < 60 * 1000) return "刚刚";
  if (abs < 60 * 60 * 1000) return `${Math.round(abs / (60 * 1000))} 分钟前`;
  if (abs < 24 * 60 * 60 * 1000) return `${Math.round(abs / (60 * 60 * 1000))} 小时前`;
  return `${Math.round(abs / (24 * 60 * 60 * 1000))} 天前`;
}

function getGroupDisplayNameByJid(groupJid) {
  if (!groupJid) return "未关联群组";
  const group = groups.find((item) => item.jid === groupJid);
  return group?.name || groupJid;
}

function normalizeTraceRun(run, scope) {
  if (!run) return null;
  if (scope === "active") {
    return {
      id: run.queryId,
      scope,
      groupJid: run.groupJid || null,
      groupFolder: run.groupFolder || null,
      workflowId: run.workflowId || null,
      stageKey: run.stageKey || null,
      selectedModel: run.selectedModel || null,
      actualModel: run.actualModel || null,
      status: run.status || "running",
      currentAction: run.currentAction || null,
      currentStepType: run.currentStepType || null,
      currentStepName: run.currentStepName || null,
      promptSummary: run.promptSummary || null,
      startedAt: run.startedAt || null,
      lastEventAt: run.lastEventAt || null,
      endedAt: null,
      latencyMs: null,
    };
  }
  return {
    id: run.query_id || run.id,
    scope,
    groupJid: run.chat_jid || null,
    groupFolder: run.group_folder || null,
    workflowId: run.workflow_id || null,
    stageKey: run.stage_key || null,
    selectedModel: run.selected_model || null,
    actualModel: run.actual_model || null,
    status: run.status || "idle",
    currentAction: run.current_action || null,
    currentStepType: null,
    currentStepName: null,
    promptSummary: run.output_preview || null,
    startedAt: run.started_at || null,
    lastEventAt: run.last_event_at || null,
    endedAt: run.ended_at || null,
    latencyMs: run.latency_ms || null,
  };
}

function getTraceRunCollection(scope) {
  return scope === "history" ? traceMonitorHistoryRuns : traceMonitorActiveRuns;
}

function sortTraceRunsByLatest(runs) {
  return [...runs].sort((a, b) => {
    const aTs = parseTimestamp(a.lastEventAt || a.startedAt || a.endedAt) || 0;
    const bTs = parseTimestamp(b.lastEventAt || b.startedAt || b.endedAt) || 0;
    return bTs - aTs;
  });
}

async function loadTraceHistoryPage(options) {
  const reset = Boolean(options && options.reset);
  if (traceMonitorHistoryLoading) return;
  traceMonitorHistoryLoading = true;
  if (activePrimaryNavKey === "trace-monitor" && activeTraceMonitorScope === "history") {
    renderTraceMonitorList();
  }
  try {
    const offset = reset ? 0 : traceMonitorHistoryOffset;
    const res = await apiFetch(`/api/agent-queries?limit=${TRACE_HISTORY_PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const activeRunIds = new Set(traceMonitorActiveRuns.map((run) => run.id));
    const nextRuns = (data.queries || [])
      .map((run) => normalizeTraceRun(run, "history"))
      .filter((run) => run && !activeRunIds.has(run.id));
    if (reset) {
      traceMonitorHistoryRuns = sortTraceRunsByLatest(nextRuns);
      if (nextRuns.length > 0) {
        traceMonitorHistoryJustCleared = false;
      }
    } else {
      const merged = [...traceMonitorHistoryRuns];
      const seen = new Set(merged.map((run) => run.id));
      for (const run of nextRuns) {
        if (!seen.has(run.id)) {
          merged.push(run);
          seen.add(run.id);
        }
      }
      traceMonitorHistoryRuns = sortTraceRunsByLatest(merged);
    }
    traceMonitorHistoryOffset = offset + (data.queries || []).length;
    traceMonitorHistoryHasMore = Boolean(data.hasMore);
  } finally {
    traceMonitorHistoryLoading = false;
  }
}

async function loadMoreTraceHistory() {
  if (traceMonitorHistoryLoading || !traceMonitorHistoryHasMore) return;
  try {
    await loadTraceHistoryPage({ reset: false });
    if (activePrimaryNavKey === "trace-monitor" && activeTraceMonitorScope === "history") {
      renderTraceMonitorList();
    }
  } catch (err) {
    console.error("Failed to load more trace history:", err);
    showToast("加载更多活动历史失败");
  }
}

function getTraceRunListEmptyText(scope) {
  if (scope === "history" && traceMonitorHistoryJustCleared) {
    return "活动历史已清空";
  }
  return scope === "history" ? "暂无历史 Agent Trace" : "暂无正在活动的 Agent Trace";
}

function buildTraceRunSummary(run) {
  return run.currentAction || run.currentStepName || run.currentStepType || run.promptSummary || "等待更多执行数据...";
}

function renderTraceHistoryLoadingSkeleton() {
  return `
    <div class="trace-monitor-history-skeleton" aria-hidden="true">
      <div class="trace-monitor-history-skeleton-line title"></div>
      <div class="trace-monitor-history-skeleton-line summary"></div>
      <div class="trace-monitor-history-skeleton-line meta"></div>
    </div>
  `;
}

function syncTraceMonitorHeaderActions() {
  if (!traceMonitorClearHistoryBtn) return;
  const isHistoryScope = activeTraceMonitorScope === "history";
  const hasHistoryRuns = traceMonitorHistoryRuns.length > 0;
  traceMonitorClearHistoryBtn.style.display = isHistoryScope ? "" : "none";
  traceMonitorClearHistoryBtn.disabled =
    !isHistoryScope || !hasHistoryRuns || traceMonitorHistoryClearing;
  traceMonitorClearHistoryBtn.title = traceMonitorHistoryClearing
    ? "正在删除活动历史"
    : "一键删除所有活动历史";
}

function renderTraceMonitorList() {
  if (!traceMonitorList) return;
  syncTraceMonitorHeaderActions();
  const runs = getTraceRunCollection(activeTraceMonitorScope);
  if (!runs.length) {
    traceMonitorList.innerHTML = `<div class="trace-monitor-list-empty">${getTraceRunListEmptyText(activeTraceMonitorScope)}</div>`;
    return;
  }
  traceMonitorList.innerHTML = "";
  for (const run of runs) {
    const runId = String(run.id || "");
    const item = document.createElement("button");
    item.type = "button";
    item.className = `trace-monitor-list-item${runId === currentTraceRunId ? " active" : ""}`;
    const statusClass = String(run.status || "idle").toLowerCase();
    const primaryTime = run.startedAt ? formatDateTime(run.startedAt) : "--";
    const secondaryTime = run.lastEventAt ? formatRelativeTime(run.lastEventAt) : "--";
    item.innerHTML = `
      <div class="trace-monitor-list-head">
        <div class="trace-monitor-list-title">${escapeHtml(getGroupDisplayNameByJid(run.groupJid))}</div>
        <span class="trace-monitor-status ${escapeHtml(statusClass)}">${escapeHtml(run.status || "unknown")}</span>
      </div>
      <div class="trace-monitor-list-summary">${escapeHtml(buildTraceRunSummary(run))}</div>
      <div class="trace-monitor-list-meta">
        <span>${escapeHtml(runId.slice(0, 8))}...</span>
        <span>${escapeHtml(primaryTime)}</span>
        <span>${escapeHtml(secondaryTime)}</span>
      </div>
    `;
    item.addEventListener("click", () => {
      loadTraceRunDetail(runId, activeTraceMonitorScope);
    });
    traceMonitorList.appendChild(item);
  }
  if (activeTraceMonitorScope === "history") {
    const footer = document.createElement("div");
    footer.className = "trace-monitor-list-footer";
    if (traceMonitorHistoryLoading) {
      footer.innerHTML = renderTraceHistoryLoadingSkeleton();
    } else {
      const status = document.createElement("div");
      status.className = "trace-monitor-list-footer-status";
      status.textContent = traceMonitorHistoryHasMore
        ? "继续下滑加载更多"
        : traceMonitorHistoryRuns.length
          ? "已加载全部"
          : "暂无更多";
      footer.appendChild(status);
    }
    traceMonitorList.appendChild(footer);
  }
}

function renderTraceMonitorDetailEmpty() {
  currentTraceRunRecord = null;
  currentTraceRunSteps = [];
  currentTraceRunEvents = [];
  if (traceMonitorDetail) traceMonitorDetail.classList.add("hidden");
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.remove("hidden");
}

function renderTraceSummaryPills(run) {
  const pills = [];
  pills.push(`<span class="trace-monitor-pill"><strong>Status</strong>${escapeHtml(run.status || "--")}</span>`);
  if (run.started_at) {
    pills.push(`<span class="trace-monitor-pill"><strong>Started</strong>${escapeHtml(formatDateTime(run.started_at))}</span>`);
  }
  if (run.ended_at) {
    pills.push(`<span class="trace-monitor-pill"><strong>Ended</strong>${escapeHtml(formatDateTime(run.ended_at))}</span>`);
  }
  if (run.latency_ms || run.latency_ms === 0) {
    pills.push(`<span class="trace-monitor-pill"><strong>Duration</strong>${escapeHtml(formatDuration(run.latency_ms))}</span>`);
  }
  if (run.selected_model) {
    pills.push(`<span class="trace-monitor-pill"><strong>Selected</strong>${escapeHtml(run.selected_model)}</span>`);
  }
  if (run.actual_model) {
    pills.push(`<span class="trace-monitor-pill"><strong>Actual</strong>${escapeHtml(run.actual_model)}</span>`);
  }
  if (run.workflow_id) {
    pills.push(`<span class="trace-monitor-pill"><strong>Workflow</strong>${escapeHtml(run.workflow_id)}</span>`);
  }
  if (run.stage_key) {
    pills.push(`<span class="trace-monitor-pill"><strong>Stage</strong>${escapeHtml(run.stage_key)}</span>`);
  }
  if (run.group_folder) {
    pills.push(`<span class="trace-monitor-pill"><strong>Folder</strong>${escapeHtml(run.group_folder)}</span>`);
  }
  return pills.join("");
}

function renderTraceMetaPills(run) {
  const pills = [];
  pills.push(`<span class="trace-monitor-pill"><strong>Run</strong>${escapeHtml(run.query_id || run.id)}</span>`);
  pills.push(`<span class="trace-monitor-pill"><strong>Source</strong>${escapeHtml(run.source_type || "--")}</span>`);
  if (run.chat_jid) {
    pills.push(`<span class="trace-monitor-pill"><strong>Group</strong>${escapeHtml(getGroupDisplayNameByJid(run.chat_jid))}</span>`);
  }
  if (run.current_action) {
    pills.push(`<span class="trace-monitor-pill"><strong>Action</strong>${escapeHtml(run.current_action)}</span>`);
  }
  if (run.error_message) {
    pills.push(`<span class="trace-monitor-pill"><strong>Error</strong>${escapeHtml(run.error_message)}</span>`);
  }
  return pills.join("");
}

function stringifyTracePayload(payload) {
  if (!payload) return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function classifyTraceTimelineItem(item) {
  const status = String(item?.status || "").toLowerCase();
  const stepType = String(item?.step_type || "").toLowerCase();
  const eventType = String(item?.event_type || "").toLowerCase();
  const eventName = String(item?.event_name || "").toLowerCase();
  const payload = "event_type" in item ? parseAgentEventPayload(item) || {} : parseAgentEventPayload({ payload_json: item.payload_json }) || {};
  const summaryText = String(item?.summary || "").toLowerCase();

  const isError =
    status === "error" ||
    status === "failed" ||
    stepType === "error" ||
    eventType === "error" ||
    eventName.includes("error") ||
    eventName.includes("failed") ||
    summaryText.includes("error") ||
    summaryText.includes("failed");
  if (isError) {
    return {
      key: "error",
      label: "错误事件",
      className: "error",
      payload,
    };
  }

  const isFileChange =
    eventName.startsWith("file_") ||
    Object.prototype.hasOwnProperty.call(payload, "patchPreview") ||
    Object.prototype.hasOwnProperty.call(payload, "contentPreview") ||
    Object.prototype.hasOwnProperty.call(payload, "additions") ||
    Object.prototype.hasOwnProperty.call(payload, "deletions") ||
    (typeof payload.path === "string" && payload.path.length > 0);
  if (isFileChange) {
    return {
      key: "file",
      label: "文件改动",
      className: "file",
      payload,
    };
  }

  const isToolCall =
    stepType === "tool" ||
    eventType === "tool" ||
    eventName.includes("tool") ||
    eventName.includes("search") ||
    eventName.includes("grep") ||
    eventName.includes("apply_patch") ||
    eventName.includes("write_file") ||
    eventName.includes("edit_file") ||
    eventName.includes("exec") ||
    eventName.includes("command");
  if (isToolCall) {
    return {
      key: "tool",
      label: "工具调用",
      className: "tool",
      payload,
    };
  }

  return {
    key: "general",
    label: "",
    className: "general",
    payload,
  };
}

function renderTraceHighlightSummary(items) {
  const counts = { file: 0, tool: 0, error: 0 };
  for (const item of items) {
    if (item.category && counts[item.category.key] !== undefined) {
      counts[item.category.key] += 1;
    }
  }
  return `
    <div class="trace-monitor-highlight-strip">
      <button type="button" class="trace-monitor-highlight-card file" data-trace-jump="file">
        <span class="trace-monitor-highlight-label">文件改动</span>
        <strong>${escapeHtml(String(counts.file))}</strong>
      </button>
      <button type="button" class="trace-monitor-highlight-card tool" data-trace-jump="tool">
        <span class="trace-monitor-highlight-label">工具调用</span>
        <strong>${escapeHtml(String(counts.tool))}</strong>
      </button>
      <button type="button" class="trace-monitor-highlight-card error" data-trace-jump="error">
        <span class="trace-monitor-highlight-label">错误事件</span>
        <strong>${escapeHtml(String(counts.error))}</strong>
      </button>
    </div>
  `;
}

function bindTraceHighlightCardJumps() {
  if (!traceMonitorTimeline) return;
  const cards = traceMonitorTimeline.querySelectorAll("[data-trace-jump]");
  cards.forEach((card) => {
    card.addEventListener("click", () => {
      const category = card.getAttribute("data-trace-jump");
      if (!category) return;
      const target = traceMonitorTimeline.querySelector(`.trace-monitor-timeline-item-${CSS.escape(category)}`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function renderTraceTimeline() {
  if (!traceMonitorTimeline || !currentTraceRunRecord) return;
  const timelineItems = [];
  for (const step of currentTraceRunSteps) {
    const category = classifyTraceTimelineItem(step);
    timelineItems.push({
      kind: "step",
      sortAt: parseTimestamp(step.started_at) || 0,
      category,
      html: renderTraceStepTimelineItem(step, category),
    });
  }
  for (const event of currentTraceRunEvents) {
    const category = classifyTraceTimelineItem(event);
    timelineItems.push({
      kind: "event",
      sortAt: parseTimestamp(event.created_at || event.started_at) || 0,
      category,
      html: renderTraceEventTimelineItem(event, category),
    });
  }
  timelineItems.sort((a, b) => a.sortAt - b.sortAt);
  if (!timelineItems.length) {
    traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">当前 Trace 还没有可展示的时间线数据</div>`;
    return;
  }
  traceMonitorTimeline.innerHTML = renderTraceHighlightSummary(timelineItems) + timelineItems.map((item) => item.html).join("");
  bindTraceHighlightCardJumps();
}

function renderTraceStepTimelineItem(step, category) {
  const payload = category?.payload || parseAgentEventPayload({ payload_json: step.payload_json }) || null;
  const payloadBlock = payload ? `<pre class="trace-monitor-json">${escapeHtml(stringifyTracePayload(payload))}</pre>` : "";
  return `
    <div class="trace-monitor-timeline-item step trace-monitor-timeline-item-${escapeHtml(category.className)}">
      <span class="trace-monitor-timeline-dot"></span>
      <div class="trace-monitor-timeline-card">
        <div class="trace-monitor-timeline-head">
          <div class="trace-monitor-timeline-title">
            <span class="trace-monitor-timeline-kind">Step</span>
            <strong>${escapeHtml(step.step_name || step.step_type || "Step")}</strong>
            ${category.label ? `<span class="trace-monitor-category-badge ${escapeHtml(category.className)}">${escapeHtml(category.label)}</span>` : ""}
            <span class="trace-monitor-status ${escapeHtml(String(step.status || "idle").toLowerCase())}">${escapeHtml(step.status || "--")}</span>
          </div>
          <div class="trace-monitor-timeline-time">
            <div>${escapeHtml(formatDateTime(step.started_at))}</div>
            <div>${escapeHtml(step.latency_ms || step.latency_ms === 0 ? formatDuration(step.latency_ms) : "--")}</div>
          </div>
        </div>
        ${step.summary ? `<div class="trace-monitor-timeline-summary">${escapeHtml(step.summary)}</div>` : ""}
        ${payloadBlock}
      </div>
    </div>
  `;
}

function renderTraceEventTimelineItem(event, category) {
  const payload = category?.payload || parseAgentEventPayload(event) || null;
  const payloadBlock = payload ? `<pre class="trace-monitor-json">${escapeHtml(stringifyTracePayload(payload))}</pre>` : "";
  return `
    <div class="trace-monitor-timeline-item event trace-monitor-timeline-item-${escapeHtml(category.className)}">
      <span class="trace-monitor-timeline-dot"></span>
      <div class="trace-monitor-timeline-card">
        <div class="trace-monitor-timeline-head">
          <div class="trace-monitor-timeline-title">
            <span class="trace-monitor-timeline-kind">${escapeHtml(event.event_type || "event")}</span>
            <strong>${escapeHtml(event.summary || event.event_name || "Event")}</strong>
            ${category.label ? `<span class="trace-monitor-category-badge ${escapeHtml(category.className)}">${escapeHtml(category.label)}</span>` : ""}
            ${event.status ? `<span class="trace-monitor-status ${escapeHtml(String(event.status).toLowerCase())}">${escapeHtml(event.status)}</span>` : ""}
          </div>
          <div class="trace-monitor-timeline-time">
            <div>${escapeHtml(formatDateTime(event.created_at || event.started_at))}</div>
            <div>${escapeHtml(event.latency_ms || event.latency_ms === 0 ? formatDuration(event.latency_ms) : "--")}</div>
          </div>
        </div>
        ${renderAgentTraceEvent(event)}
        ${payloadBlock}
      </div>
    </div>
  `;
}

function renderTraceRunDetail() {
  if (!currentTraceRunRecord) {
    renderTraceMonitorDetailEmpty();
    return;
  }
  if (traceMonitorDetail) traceMonitorDetail.classList.remove("hidden");
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.add("hidden");
  if (traceMonitorTitle) {
    traceMonitorTitle.textContent = getGroupDisplayNameByJid(currentTraceRunRecord.chat_jid);
  }
  if (traceMonitorMeta) {
    traceMonitorMeta.innerHTML = renderTraceMetaPills(currentTraceRunRecord);
  }
  if (traceMonitorSummary) {
    traceMonitorSummary.innerHTML = renderTraceSummaryPills(currentTraceRunRecord);
  }
  renderTraceTimeline();
}

async function loadTraceRunDetail(runId, scope) {
  currentTraceRunId = runId;
  currentTraceRunScope = scope || activeTraceMonitorScope;
  renderTraceMonitorList();
  if (traceMonitorTimeline) {
    traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">正在加载 Trace 详情...</div>`;
  }
  if (traceMonitorDetail) traceMonitorDetail.classList.remove("hidden");
  if (traceMonitorDetailEmpty) traceMonitorDetailEmpty.classList.add("hidden");
  try {
    const [runRes, stepsRes, eventsRes] = await Promise.all([
      apiFetch(`/api/agent-queries/${encodeURIComponent(runId)}`),
      apiFetch(`/api/agent-queries/${encodeURIComponent(runId)}/steps`),
      apiFetch(`/api/agent-queries/${encodeURIComponent(runId)}/events`),
    ]);
    if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
    if (!stepsRes.ok) throw new Error(`HTTP ${stepsRes.status}`);
    if (!eventsRes.ok) throw new Error(`HTTP ${eventsRes.status}`);
    const runData = await runRes.json();
    const stepsData = await stepsRes.json();
    const eventsData = await eventsRes.json();
    currentTraceRunRecord = runData.query || null;
    currentTraceRunSteps = Array.isArray(stepsData.steps) ? stepsData.steps : [];
    currentTraceRunEvents = Array.isArray(eventsData.events) ? eventsData.events : [];
    renderTraceRunDetail();
  } catch (err) {
    console.error("Failed to load trace detail:", err);
    if (traceMonitorTimeline) {
      traceMonitorTimeline.innerHTML = `<div class="trace-monitor-list-empty">Trace 详情加载失败</div>`;
    }
  }
}

function ensureTraceSelectionVisible(scope) {
  const runs = getTraceRunCollection(scope);
  if (!runs.length) {
    currentTraceRunId = "";
    renderTraceMonitorDetailEmpty();
    return;
  }
  const hasSelected = runs.some((run) => run.id === currentTraceRunId);
  if (!hasSelected) {
    loadTraceRunDetail(runs[0].id, scope);
    return;
  }
  renderTraceMonitorList();
}

function setTraceMonitorScope(scope) {
  activeTraceMonitorScope = scope === "history" ? "history" : "active";
  traceMonitorScopeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-trace-scope") === activeTraceMonitorScope);
  });
  const runs = getTraceRunCollection(activeTraceMonitorScope);
  const hasSelected = runs.some((run) => run.id === currentTraceRunId);
  if (!hasSelected) {
    currentTraceRunId = "";
    currentTraceRunRecord = null;
    currentTraceRunSteps = [];
    currentTraceRunEvents = [];
  }
  renderTraceMonitorList();
  syncTraceMonitorHeaderActions();
  ensureTraceSelectionVisible(activeTraceMonitorScope);
  if (activeTraceMonitorScope === "history" && traceMonitorHistoryRuns.length === 0 && !traceMonitorHistoryLoading) {
    loadTraceHistoryPage({ reset: true })
      .then(() => {
        renderTraceMonitorList();
        syncTraceMonitorHeaderActions();
        ensureTraceSelectionVisible("history");
      })
      .catch((err) => {
        console.error("Failed to load trace history:", err);
      });
  }
}

function scheduleTraceDetailReload() {
  if (activePrimaryNavKey !== "trace-monitor") return;
  if (activeTraceMonitorScope !== "active") return;
  if (!currentTraceRunId) return;
  const isActiveSelected = traceMonitorActiveRuns.some((run) => run.id === currentTraceRunId);
  if (!isActiveSelected) return;
  if (traceMonitorDetailReloadTimer) {
    clearTimeout(traceMonitorDetailReloadTimer);
  }
  traceMonitorDetailReloadTimer = setTimeout(() => {
    traceMonitorDetailReloadTimer = null;
    loadTraceRunDetail(currentTraceRunId, "active");
  }, 350);
}

async function loadTraceMonitorData(options) {
  const force = Boolean(options && options.force);
  try {
    const activeRes = await apiFetch("/api/agent-queries/active");
    if (!activeRes.ok) throw new Error(`HTTP ${activeRes.status}`);
    const activeData = await activeRes.json();
    traceMonitorActiveRuns = sortTraceRunsByLatest((activeData.queries || [])
      .map((run) => normalizeTraceRun(run, "active"))
      .filter(Boolean));
    if (force || traceMonitorHistoryRuns.length === 0) {
      await loadTraceHistoryPage({ reset: true });
    } else {
      traceMonitorHistoryRuns = traceMonitorHistoryRuns.filter(
        (run) => !traceMonitorActiveRuns.some((activeRun) => activeRun.id === run.id),
      );
    }
    renderTraceMonitorList();
    syncTraceMonitorHeaderActions();
    if (force || !currentTraceRunId) {
      ensureTraceSelectionVisible(activeTraceMonitorScope);
      return;
    }
    const runs = getTraceRunCollection(activeTraceMonitorScope);
    if (runs.some((run) => run.id === currentTraceRunId)) {
      loadTraceRunDetail(currentTraceRunId, activeTraceMonitorScope);
    } else {
      ensureTraceSelectionVisible(activeTraceMonitorScope);
    }
  } catch (err) {
    console.error("Failed to load trace monitor:", err);
    if (traceMonitorList) {
      traceMonitorList.innerHTML = `<div class="trace-monitor-list-empty">Trace 列表加载失败</div>`;
    }
    syncTraceMonitorHeaderActions();
    renderTraceMonitorDetailEmpty();
  }
}

async function clearAllTraceHistory() {
  if (traceMonitorHistoryClearing) return;
  if (!confirm("确认删除所有 agent 活动历史吗？\n\n当前仍在运行的活跃 Trace 不会被删除。")) return;
  traceMonitorHistoryClearing = true;
  syncTraceMonitorHeaderActions();
  try {
    const res = await apiFetch("/api/agent-queries", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    traceMonitorHistoryRuns = [];
    traceMonitorHistoryOffset = 0;
    traceMonitorHistoryHasMore = false;
    traceMonitorHistoryJustCleared = true;
    if (currentTraceRunScope === "history") {
      currentTraceRunId = "";
      currentTraceRunScope = "history";
      renderTraceMonitorDetailEmpty();
    }
    await loadTraceHistoryPage({ reset: true });
    renderTraceMonitorList();
    syncTraceMonitorHeaderActions();
    showToast(`已删除 ${Number(data.deleted || 0)} 条活动历史`);
  } catch (err) {
    console.error("Failed to clear trace history:", err);
    alert("删除活动历史失败");
  } finally {
    traceMonitorHistoryClearing = false;
    syncTraceMonitorHeaderActions();
  }
}
// --- Workflows panel ---
var TERMINAL_STATUSES = ["passed", "ops_failed", "cancelled"];

async function loadWorkflows() {
  try {
    const res = await apiFetch("/api/workflows");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderWorkflows(data.workflows || []);
  } catch (err) {
    console.error("Failed to load workflows:", err);
    workflowsList.innerHTML = `<div class="workflows-empty">Failed to load workflows</div>`;
  }
}

function renderWorkflows(workflows) {
  workflowsList.innerHTML = "";

  if (workflows.length === 0) {
    workflowsList.innerHTML = `<div class="workflows-empty">No workflows</div>`;
    return;
  }

  for (const wf of workflows) {
    const isTerminal = TERMINAL_STATUSES.includes(wf.status);
    const isPaused = wf.status === "paused";
    const isActive = !isTerminal && !isPaused;

    const statusClass = isTerminal
      ? "workflow-status-terminal"
      : isPaused
        ? "workflow-status-paused"
        : "workflow-status-active";

    const statusText = isPaused
      ? "\u23F8 " + wf.status
      : wf.status;

    const created = new Date(wf.created_at).toLocaleString();
    const updated = new Date(wf.updated_at).toLocaleString();

    const el = document.createElement("div");
    el.className = "workflow-item";
    el.innerHTML = `
      <div class="workflow-item-header">
        <span class="workflow-item-name">${escapeHtml(wf.name)}</span>
        <span class="workflow-item-status ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      <div class="workflow-item-id">${escapeHtml(wf.id)}</div>
      <div class="workflow-item-meta">
        <span>\u{1F4E6} ${escapeHtml(wf.service)}</span>
        ${wf.branch ? `<span>\u{1F33F} ${escapeHtml(wf.branch)}</span>` : ""}
        ${wf.workflow_type ? `<span>\u{1F4CB} ${escapeHtml(wf.workflow_type)}</span>` : ""}
        ${wf.round > 0 ? `<span>\u{1F504} Round ${wf.round}</span>` : ""}
      </div>
      <div class="workflow-item-meta">
        <span>Created: ${created}</span>
        <span>Updated: ${updated}</span>
      </div>
      <div class="workflow-item-actions"></div>
    `;

    const actionsEl = el.querySelector(".workflow-item-actions");

    if (isActive) {
      // Running workflow: show stop button
      const stopBtn = document.createElement("button");
      stopBtn.className = "workflow-action-btn stop icon-text-btn";
      stopBtn.innerHTML = `${SVG.stop} Stop`;
      stopBtn.addEventListener("click", () => stopWorkflow(wf.id, el));
      actionsEl.appendChild(stopBtn);
    }

    if (isTerminal || isPaused) {
      // Stopped / terminal workflow: show delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "workflow-action-btn delete icon-text-btn";
      deleteBtn.innerHTML = `${SVG.trash} Delete`;
      deleteBtn.addEventListener("click", () => deleteWorkflow(wf.id, el));
      actionsEl.appendChild(deleteBtn);
    }

    workflowsList.appendChild(el);
  }
}

async function stopWorkflow(id, el) {
  if (!confirm("Stop this workflow?")) return;
  try {
    const res = await apiFetch("/api/workflow/stop", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    loadWorkflows();
  } catch (err) {
    console.error("Failed to stop workflow:", err);
    alert("Failed to stop workflow: " + err.message);
  }
}

async function deleteWorkflow(id, el) {
  if (!confirm("Delete this workflow?")) return;
  try {
    const res = await apiFetch(`/api/workflow?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.remove();
    if (workflowsList.querySelectorAll(".workflow-item").length === 0) {
      workflowsList.innerHTML = `<div class="workflows-empty">No workflows</div>`;
    }
  } catch (err) {
    console.error("Failed to delete workflow:", err);
    alert("Failed to delete workflow");
  }
}

async function deleteAllWorkflows() {
  if (!confirm("Delete all workflows?")) return;
  try {
    const res = await apiFetch("/api/workflows", { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    workflowsList.innerHTML = `<div class="workflows-empty">No workflows</div>`;
  } catch (err) {
    console.error("Failed to delete all workflows:", err);
    alert("Failed to delete all workflows");
  }
}

async function loadWorkbenchTasks(preferredTaskId, autoSelect = true, refreshDetail = true) {
  try {
    const res = await apiFetch("/api/workbench/tasks");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    workbenchTasks = Array.isArray(data.tasks) ? data.tasks : [];
    renderWorkbenchTaskList();

    const nextTaskId = preferredTaskId && workbenchTasks.some((task) => task.id === preferredTaskId)
      ? preferredTaskId
      : currentWorkbenchTaskId && workbenchTasks.some((task) => task.id === currentWorkbenchTaskId)
        ? currentWorkbenchTaskId
        : autoSelect && workbenchTasks[0]
          ? workbenchTasks[0].id
          : "";

    if (nextTaskId && refreshDetail) {
      loadWorkbenchTaskDetail(nextTaskId);
    } else if (!nextTaskId) {
      currentWorkbenchTaskId = "";
      currentWorkbenchDetail = null;
      workbenchTaskDetail.classList.add("hidden");
      workbenchDetailEmpty.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Failed to load workbench tasks:", err);
    workbenchTaskList.innerHTML = `<div class="workbench-empty">任务加载失败</div>`;
  }
}

async function deleteAllWorkbenchTaskData() {
  if (!confirm("确认删除所有任务相关数据？这会清空工作台中的任务、阶段、审批和产出记录。")) return;
  try {
    const res = await apiFetch("/api/workbench/tasks", { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    workbenchTasks = [];
    currentWorkbenchTaskId = "";
    currentWorkbenchDetail = null;
    renderWorkbenchTaskList();
    workbenchTaskDetail.classList.add("hidden");
    workbenchDetailEmpty.classList.remove("hidden");
  } catch (err) {
    console.error("Failed to delete all workbench task data:", err);
    alert("删除任务数据失败");
  }
}

function renderWorkbenchTaskList() {
  workbenchTasks = sortWorkbenchTaskItems(workbenchTasks);
  workbenchTaskList.innerHTML = "";
  if (workbenchTasks.length === 0) {
    workbenchTaskList.innerHTML = `<div class="workbench-empty">暂无任务，点击“新建任务”开始。</div>`;
    return;
  }

  for (const task of workbenchTasks) {
    const el = document.createElement("div");
    el.className = `workbench-task-item${task.id === currentWorkbenchTaskId ? " active" : ""}`;
    el.innerHTML = `
      <div class="workbench-task-title">${escapeHtml(task.title)}</div>
      <div class="workbench-task-badges">
        <span class="workbench-badge">${escapeHtml(task.service)}</span>
        <span class="workbench-badge">${escapeHtml(task.status_label || task.status)}</span>
      </div>
      <div class="workbench-task-snippet">
        当前阶段：${escapeHtml(task.current_stage_label || task.current_stage)}<br />
        ${task.branch ? `分支：${escapeHtml(task.branch)}` : "尚未生成开发分支"}
      </div>
    `;
    el.addEventListener("click", () => loadWorkbenchTaskDetail(task.id));
    workbenchTaskList.appendChild(el);
  }
}

function sortWorkbenchTaskItems(tasks) {
  if (!Array.isArray(tasks)) return [];
  return [...tasks].sort((a, b) => {
    const aTs = parseTimestamp(a?.updated_at || a?.created_at || "");
    const bTs = parseTimestamp(b?.updated_at || b?.created_at || "");
    const safeATs = Number.isFinite(aTs) ? aTs : 0;
    const safeBTs = Number.isFinite(bTs) ? bTs : 0;
    if (safeATs !== safeBTs) return safeBTs - safeATs;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

async function loadWorkbenchTaskDetail(taskId) {
  if (!taskId) return;
  if (workbenchDetailLoading) {
    workbenchQueuedDetailTaskId = taskId;
    return;
  }
  workbenchDetailLoading = true;
  try {
    const res = await apiFetch(`/api/workbench/task?id=${encodeURIComponent(taskId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    currentWorkbenchTaskId = detail.task && detail.task.id ? detail.task.id : taskId;
    renderWorkbenchTaskList();
    renderWorkbenchTaskDetail(detail);
  } catch (err) {
    console.error("Failed to load workbench task detail:", err);
    alert("任务详情加载失败");
  } finally {
    workbenchDetailLoading = false;
    const queuedTaskId = workbenchQueuedDetailTaskId;
    workbenchQueuedDetailTaskId = "";
    if (queuedTaskId) {
      loadWorkbenchTaskDetail(queuedTaskId);
    }
  }
}

function scheduleWorkbenchTaskDetailReload(taskId, delay = 250) {
  if (!taskId) return;
  if (workbenchDetailReloadTimer) clearTimeout(workbenchDetailReloadTimer);
  workbenchDetailReloadTimer = setTimeout(() => {
    workbenchDetailReloadTimer = null;
    loadWorkbenchTaskDetail(taskId);
  }, delay);
}

async function refreshWorkbenchView() {
  const activeTaskId = currentWorkbenchTaskId;
  await loadWorkbenchTasks(activeTaskId, true, false);
  if (activeTaskId && workbenchTasks.some((task) => task.id === activeTaskId)) {
    await loadWorkbenchTaskDetail(activeTaskId);
  }
}

function renderWorkbenchTaskDetail(detail) {
  const task = detail.task;
  if (!task) return;
  currentWorkbenchDetail = detail;

  workbenchDetailEmpty.classList.add("hidden");
  workbenchTaskDetail.classList.remove("hidden");
  workbenchTaskTitle.textContent = task.title;
  workbenchTaskMeta.innerHTML = `
    <span class="workbench-badge">${escapeHtml(task.service)}</span>
    <span class="workbench-badge">${escapeHtml(task.workflow_type)}</span>
    ${task.branch ? `<span class="workbench-badge">${escapeHtml(task.branch)}</span>` : ""}
    ${task.round > 0 ? `<span class="workbench-badge">Round ${escapeHtml(String(task.round))}</span>` : ""}
    <span class="workbench-badge">${escapeHtml(task.status_label || task.status)}</span>
  `;

  renderWorkbenchActions(task);
  renderWorkbenchSubtasks(detail.subtasks || []);
  renderWorkbenchActionItems(detail.action_items || [], task);
  renderWorkbenchArtifacts(detail.artifacts || []);
  renderWorkbenchAssets(detail.assets || []);
  renderWorkbenchComments(detail.comments || []);
  renderWorkbenchTimeline(detail.timeline || []);
}

function renderWorkbenchActions(task) {
  workbenchTaskActions.innerHTML = "";
  const buttons = [];
  if (task.status === "paused") {
    buttons.push({ title: "恢复任务", action: "resume", icon: SVG.play });
  } else if (!TERMINAL_STATUSES.includes(task.status)) {
    buttons.push({ title: "暂停任务", action: "pause", icon: SVG.pause });
  }
  if (!TERMINAL_STATUSES.includes(task.status)) {
    buttons.push({ title: "取消任务", action: "cancel", icon: SVG.trash, danger: true });
  }

  buttons.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = `icon-btn workbench-task-action-btn${item.danger ? " danger" : ""}`;
    btn.type = "button";
    btn.title = item.title;
    btn.setAttribute("aria-label", item.title);
    btn.setAttribute("data-tooltip", item.title);
    btn.innerHTML = item.icon;
    btn.addEventListener("click", () => triggerWorkbenchAction(task.id, item.action));
    workbenchTaskActions.appendChild(btn);
  });
}

function renderWorkbenchSubtasks(subtasks) {
  workbenchSubtasks.innerHTML = "";
  if (subtasks.length === 0) {
    workbenchSubtasks.innerHTML = `<div class="workbench-empty">暂无阶段数据</div>`;
    return;
  }
  function getDisplaySubtasks(items) {
    const currentItems = items.filter((item) => item.status === "current");
    if (currentItems.length <= 1) {
      return items;
    }

    const taskCurrentStage = currentWorkbenchDetail && currentWorkbenchDetail.task
      ? currentWorkbenchDetail.task.current_stage
      : "";
    const preferredCurrent = currentItems.find((item) => item.stage_key === taskCurrentStage)
      || currentItems[currentItems.length - 1];

    return items.map((item) => {
      if (item.status !== "current" || item.id === preferredCurrent.id) {
        return item;
      }
      return {
        ...item,
        status: "completed",
      };
    });
  }
  function isAwaitingStage(item) {
    return typeof item.stage_key === "string" && item.stage_key.startsWith("awaiting_");
  }
  function getSubtaskStatusLabel(item) {
    if (item.status === "current" && isAwaitingStage(item)) {
      return "待确认";
    }
    if (item.manually_skipped && item.status === "completed") {
      return "已跳过";
    }
    const statusLabelMap = {
      pending: "未开始",
      current: "进行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
    };
    return statusLabelMap[item.status] || item.status;
  }
  const displaySubtasks = getDisplaySubtasks(subtasks);
  const currentSubtask = displaySubtasks.find((item) => item.status === "current") || null;
  const persistedSelection = displaySubtasks.find((item) => item.id === workbenchSelectedSubtaskId) || null;
  const shouldAutoFollowCurrent =
    workbenchFollowCurrentSubtaskOnce &&
    currentSubtask &&
    (!persistedSelection || currentSubtask.id !== persistedSelection.id);
  const selectedId = shouldAutoFollowCurrent
    ? currentSubtask.id
    : persistedSelection
      ? persistedSelection.id
      : (currentSubtask || subtasks[0]).id;
  workbenchSelectedSubtaskId = selectedId;
  if (shouldAutoFollowCurrent) {
    workbenchFollowCurrentSubtaskOnce = false;
  }
  const animationKey = `${currentWorkbenchTaskId}:${selectedId}`;
  const shouldAnimateSelection = workbenchAnimatedSubtaskKey !== animationKey;
  workbenchAnimatedSubtaskKey = animationKey;

  const chainEl = document.createElement("div");
  chainEl.className = "workbench-subtasks-chain";

  displaySubtasks.forEach((item) => {
    const stepIndex = displaySubtasks.findIndex((subtask) => subtask.id === item.id) + 1;
    const el = document.createElement("button");
    el.type = "button";
    el.className = `workbench-subtask-step ${item.status}${item.id === selectedId ? " active" : ""}`;
    if (item.id === selectedId && shouldAnimateSelection) {
      el.classList.add("animate-in");
    }
    const stepHint = item.status === "current"
      ? (isAwaitingStage(item) ? "等待确认" : "正在处理")
      : item.manually_skipped && item.status === "completed"
        ? "已手动跳过"
      : item.status === "failed"
        ? "需处理"
        : item.status === "cancelled"
          ? "已取消"
        : item.status === "completed"
          ? "已通过"
          : "待开始";
    el.innerHTML = `
      <div class="workbench-subtask-card">
        ${item.status === "current" ? '<span class="workbench-subtask-spotlight"></span>' : ""}
        <div class="workbench-subtask-title">
          <span class="workbench-subtask-index">0${stepIndex}</span>
          ${escapeHtml(item.stage_label || item.title)}
          ${item.status === "current" ? '<span class="workbench-current-chip">当前</span>' : ""}
          ${item.manually_skipped ? '<span class="workbench-badge">已手动跳过</span>' : ""}
        </div>
        <div class="workbench-subtask-caption">${escapeHtml(stepHint)}</div>
      </div>
      <div class="workbench-subtask-marker">
        <span class="workbench-subtask-dot"></span>
        <span class="workbench-subtask-line"></span>
      </div>
    `;
    el.addEventListener("click", () => {
      workbenchSelectedSubtaskId = item.id;
      renderWorkbenchSubtasks(subtasks);
    });
    chainEl.appendChild(el);
  });

  const selected = displaySubtasks.find((item) => item.id === selectedId) || displaySubtasks[0];
  const selectedIndex = displaySubtasks.findIndex((item) => item.id === selected.id) + 1;
  const selectedBody = selected.result
    ? `结果摘要：${escapeHtml(selected.result)}`
    : selected.manually_skipped
      ? "该阶段已由人工按成功处理跳过，流程直接进入下一阶段"
    : selected.status === "current" && isAwaitingStage(selected)
      ? "等待审批确认后进入下一阶段"
      : "等待执行或审批推进";
  const detailHint = selected.manually_skipped
    ? `
      <div class="workbench-subtask-hint current">
        <div class="workbench-subtask-hint-title">已手动跳过</div>
        <div class="workbench-subtask-hint-body">
          这个阶段未按原路径完成，而是由人工按“成功处理”跳过；当前仅保留历史记录，不提供重跑入口。
        </div>
      </div>
    `
    : selected.status === "failed"
    ? `
      <div class="workbench-subtask-hint failed">
        <div class="workbench-subtask-hint-title">处理建议</div>
        <div class="workbench-subtask-hint-body">
          优先查看结果摘要中的报错信息；如果不再处理这个阶段，也可以点击“跳过此节点”，按该节点成功处理并直接进入下一阶段。
        </div>
      </div>
    `
    : selected.status === "cancelled"
      ? `
        <div class="workbench-subtask-hint cancelled">
          <div class="workbench-subtask-hint-title">阶段已取消</div>
          <div class="workbench-subtask-hint-body">
            这个阶段因手动取消或流程终止而停止；如需继续流程，可点击“跳过此节点”，按该节点成功处理并直接进入下一阶段。
          </div>
        </div>
      `
    : selected.status === "current"
      ? `
        <div class="workbench-subtask-hint current">
          <div class="workbench-subtask-hint-title">当前焦点</div>
          <div class="workbench-subtask-hint-body">
            ${escapeHtml(isAwaitingStage(selected) ? "这个阶段正在等待审批确认。" : "这个阶段正在执行中，可关注结果摘要与时间线更新。")}
          </div>
        </div>
      `
      : "";
  const detailEl = document.createElement("div");
  detailEl.className = `workbench-subtask-detail-card ${selected.status}${shouldAnimateSelection ? " animate-in" : ""}`;
  detailEl.innerHTML = `
    <div class="workbench-item-row">
      <div class="workbench-item-title">
        <span class="workbench-subtask-detail-index">阶段 ${selectedIndex}</span>
        ${escapeHtml(selected.stage_label || selected.title)}
        <span class="workbench-badge">${escapeHtml(getSubtaskStatusLabel(selected))}</span>
        ${selected.manually_skipped ? '<span class="workbench-badge">已手动跳过</span>' : ""}
      </div>
    </div>
    <div class="workbench-item-body">
      ${selected.target_folder ? `执行群组：${escapeHtml(selected.target_folder)}\n` : ""}
      ${selectedBody}
    </div>
    ${detailHint}
  `;

  const activeTask = currentWorkbenchDetail && currentWorkbenchDetail.task
    ? currentWorkbenchDetail.task
    : null;
  const isRetryComposerOpen = workbenchRetryComposerSubtaskId === selected.id;

  if (selected.role && !selected.manually_skipped && (selected.status === "failed" || selected.status === "cancelled")) {
    const actions = document.createElement("div");
    actions.className = "workbench-subtask-actions";
    if (selected.status === "failed") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn-ghost";
      retryBtn.textContent = isRetryComposerOpen ? "收起补充" : "重跑";
      retryBtn.addEventListener("click", () => toggleWorkbenchRetryComposer(selected.id));
      actions.appendChild(retryBtn);
    }
    if (activeTask) {
      const labels = getWorkbenchApprovalLabels(activeTask, {
        approval_type: selected.stage_key,
        action_mode: "approve_only",
      });
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn-ghost";
      skipBtn.textContent = labels.skip || "跳过此节点";
      skipBtn.addEventListener("click", () => {
        if (!confirm(`确认按“成功处理”跳过“${selected.stage_label || selected.title}”并直接进入下一步吗？`)) return;
        triggerWorkbenchAction(activeTask.id, "skip", selected.id);
      });
      actions.appendChild(skipBtn);
    }
    detailEl.appendChild(actions);

    if (selected.status === "failed" && isRetryComposerOpen) {
      const retryComposer = document.createElement("div");
      retryComposer.className = "workbench-retry-composer";
      retryComposer.innerHTML = `
        <label class="workbench-retry-label" for="workbench-retry-note">
          给 agent 补充一些信息，重跑时会一起注入提示词
        </label>
        <textarea
          id="workbench-retry-note"
          rows="4"
          placeholder="例如：报错的复现条件、期望修复方式、不能修改的范围、需要重点关注的文件"
        >${escapeHtml(workbenchRetryComposerDraft)}</textarea>
        <div class="workbench-retry-actions">
          <button type="button" class="btn-primary" ${workbenchRetrySubmitting ? "disabled" : ""}>确认重跑</button>
          <button type="button" class="btn-ghost" data-action="cancel-retry" ${workbenchRetrySubmitting ? "disabled" : ""}>取消</button>
        </div>
      `;
      const retryTextarea = retryComposer.querySelector("#workbench-retry-note");
      if (retryTextarea) {
        retryTextarea.addEventListener("input", (event) => {
          workbenchRetryComposerDraft = event.target.value;
        });
      }
      const retryConfirmBtn = retryComposer.querySelector(".btn-primary");
      if (retryConfirmBtn) {
        retryConfirmBtn.addEventListener("click", () =>
          triggerWorkbenchSubtaskRetry(currentWorkbenchTaskId, selected.id, workbenchRetryComposerDraft)
        );
      }
      const retryCancelBtn = retryComposer.querySelector('[data-action="cancel-retry"]');
      if (retryCancelBtn) {
        retryCancelBtn.addEventListener("click", () => closeWorkbenchRetryComposer());
      }
      detailEl.appendChild(retryComposer);
      requestAnimationFrame(() => {
        if (document.activeElement !== retryTextarea) {
          retryTextarea?.focus();
          if (typeof retryTextarea?.selectionStart === "number") {
            const end = retryTextarea.value.length;
            retryTextarea.setSelectionRange(end, end);
          }
        }
      });
    }
  }

  workbenchSubtasks.appendChild(chainEl);
  workbenchSubtasks.appendChild(detailEl);

  const activeStep = chainEl.querySelector(".workbench-subtask-step.active");
  if (activeStep) {
    const targetLeft =
      activeStep.offsetLeft -
      Math.max(0, (chainEl.clientWidth - activeStep.clientWidth) / 2);
    chainEl.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: "auto",
    });
  }
}

function getWorkbenchApprovalLabels(task, approval) {
  const approvalType = approval.approval_type || task.status;
  switch (approvalType) {
    case "plan_confirm":
      return { approve: "进入开发", revise: "返回方案修改", skip: "跳过此节点" };
    case "plan_examine_confirm":
      return { approve: "继续开发", revise: "返回方案修改", skip: "跳过此节点" };
    case "dev_examine_confirm":
      return { approve: "继续后续流程", revise: "返回开发修正", skip: "跳过此节点" };
    case "awaiting_confirm":
      return { approve: "开始预发部署", revise: "", skip: "跳过此节点" };
    case "testing_confirm":
      return { approve: "", revise: "填写 access_token 并开始测试", skip: "跳过鉴权直接测试" };
    default:
      return {
        approve: "通过",
        revise: approval.action_mode === "approve_or_revise" ? "驳回并修改" : "",
        skip: "跳过此节点",
      };
  }
}

function renderWorkbenchActionItems(actionItems, task) {
  workbenchActionItems.innerHTML = "";
  if (actionItems.length === 0) {
    if (workbenchActionItemsPanel) workbenchActionItemsPanel.classList.add("hidden");
    workbenchActionItems.innerHTML = `<div class="workbench-empty">当前没有待处理项</div>`;
    return;
  }
  if (workbenchActionItemsPanel) workbenchActionItemsPanel.classList.remove("hidden");
  actionItems.forEach((item) => {
    const el = document.createElement("div");
    el.className = "workbench-approval-item";
    const badge = item.item_type === "approval"
      ? "待确认"
      : item.source_type === "request_human_input"
        ? "人工输入"
        : item.source_type === "ask_user_question"
          ? "提问"
          : "消息";
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.title)}</div>
        <span class="workbench-badge">${escapeHtml(badge)}</span>
      </div>
      <div class="workbench-item-body">${escapeHtml(item.body)}</div>
    `;
    const actions = document.createElement("div");
    actions.className = "workbench-task-actions";
    if (item.item_type === "approval") {
      const labels = getWorkbenchApprovalLabels(task, {
        approval_type: item.stage_key || task.status,
        action_mode: item.action_mode || "approve_only",
      });
      if (item.action_mode !== "input_required") {
        const approveBtn = document.createElement("button");
        approveBtn.className = "btn-primary";
        approveBtn.textContent = labels.approve;
        approveBtn.addEventListener("click", () => triggerWorkbenchAction(task.id, "approve"));
        actions.appendChild(approveBtn);
      }
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn-ghost";
      skipBtn.textContent = labels.skip || "跳过此节点";
      skipBtn.addEventListener("click", () => {
        if (!confirm(`确认跳过“${item.title}”并进入下一步吗？`)) return;
        triggerWorkbenchAction(task.id, "skip");
      });
      actions.appendChild(skipBtn);
      if (item.action_mode === "approve_or_revise" || item.action_mode === "input_required") {
        const reviseBtn = document.createElement("button");
        reviseBtn.className = item.action_mode === "input_required" ? "btn-primary" : "btn-ghost";
        reviseBtn.textContent = labels.revise || "驳回并修改";
        reviseBtn.addEventListener("click", () =>
          triggerWorkbenchAction(task.id, item.action_mode === "input_required" ? "submit_access_token" : "revise")
        );
        actions.appendChild(reviseBtn);
      }
    } else {
      if (item.replyable) {
        const replyBtn = document.createElement("button");
        replyBtn.className = "btn-primary";
        replyBtn.textContent = "回复";
        replyBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "reply"));
        actions.appendChild(replyBtn);
      }
      const approveBtn = document.createElement("button");
      approveBtn.className = "btn-ghost";
      approveBtn.textContent = "确认";
      approveBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "confirm"));
      actions.appendChild(approveBtn);
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn-ghost";
      skipBtn.textContent = "跳过";
      skipBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "skip"));
      actions.appendChild(skipBtn);
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn-ghost";
      cancelBtn.textContent = "取消";
      cancelBtn.addEventListener("click", () => triggerWorkbenchActionItem(task.id, item.id, "cancel"));
      actions.appendChild(cancelBtn);
    }
    el.appendChild(actions);
    workbenchActionItems.appendChild(el);
  });
}

function sortWorkbenchItemsByCreatedAt(items) {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    const aTs = parseTimestamp(a?.created_at || "");
    const bTs = parseTimestamp(b?.created_at || "");
    const safeATs = Number.isFinite(aTs) ? aTs : 0;
    const safeBTs = Number.isFinite(bTs) ? bTs : 0;
    if (safeATs !== safeBTs) return safeBTs - safeATs;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

function applyWorkbenchActionItemRealtimeUpdate(payload) {
  if (!currentWorkbenchDetail || !Array.isArray(currentWorkbenchDetail.action_items)) {
    return false;
  }
  const itemId = typeof payload.id === "string" ? payload.id : "";
  if (!itemId) return false;

  const nextStatus = typeof payload.status === "string" ? payload.status : "";
  const existingIdx = currentWorkbenchDetail.action_items.findIndex((item) => item.id === itemId);
  const shouldRemove = ["resolved", "confirmed", "skipped", "cancelled", "expired"].includes(nextStatus);
  if (shouldRemove) {
    if (existingIdx < 0) return true;
    currentWorkbenchDetail.action_items.splice(existingIdx, 1);
    renderWorkbenchActionItems(currentWorkbenchDetail.action_items, currentWorkbenchDetail.task);
    return true;
  }

  if (nextStatus && nextStatus !== "pending") {
    return false;
  }

  const nextItem = existingIdx >= 0
    ? { ...currentWorkbenchDetail.action_items[existingIdx] }
    : {
        id: itemId,
        item_type: payload.itemType === "approval" ? "approval" : "interactive",
        source_type: typeof payload.sourceType === "string" ? payload.sourceType : "workflow",
        title: "",
        body: "",
        status: "pending",
        stage_key: typeof payload.stageKey === "string" ? payload.stageKey : undefined,
        delegation_id: typeof payload.delegationId === "string" ? payload.delegationId : undefined,
        group_folder: typeof payload.groupFolder === "string" ? payload.groupFolder : undefined,
        source_ref_id: typeof payload.sourceRefId === "string" ? payload.sourceRefId : undefined,
        replyable: Boolean(payload.replyable),
        action_mode: typeof payload.actionMode === "string" ? payload.actionMode : undefined,
        created_at: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
      };

  if (typeof payload.title === "string") nextItem.title = payload.title;
  if (typeof payload.body === "string") nextItem.body = payload.body;
  if (typeof payload.stageKey === "string") nextItem.stage_key = payload.stageKey;
  if (typeof payload.delegationId === "string") nextItem.delegation_id = payload.delegationId;
  if (typeof payload.groupFolder === "string") nextItem.group_folder = payload.groupFolder;
  if (typeof payload.sourceRefId === "string") nextItem.source_ref_id = payload.sourceRefId;
  if (typeof payload.replyable === "boolean") nextItem.replyable = payload.replyable;
  if (typeof payload.actionMode === "string") nextItem.action_mode = payload.actionMode;
  if (typeof payload.itemType === "string") {
    nextItem.item_type = payload.itemType === "approval" ? "approval" : "interactive";
  }
  if (typeof payload.sourceType === "string") nextItem.source_type = payload.sourceType;
  if (typeof payload.createdAt === "string") nextItem.created_at = payload.createdAt;
  nextItem.status = "pending";

  if (existingIdx >= 0) {
    currentWorkbenchDetail.action_items[existingIdx] = nextItem;
  } else {
    currentWorkbenchDetail.action_items.push(nextItem);
  }
  currentWorkbenchDetail.action_items = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.action_items);
  renderWorkbenchActionItems(currentWorkbenchDetail.action_items, currentWorkbenchDetail.task);
  return true;
}

function renderWorkbenchArtifacts(artifacts) {
  const sortedArtifacts = sortWorkbenchItemsByCreatedAt(artifacts);
  workbenchArtifacts.innerHTML = "";
  if (sortedArtifacts.length === 0) {
    workbenchArtifacts.innerHTML = `<div class="workbench-empty">暂无产出物</div>`;
    return;
  }
  sortedArtifacts.forEach((item) => {
    const el = document.createElement("div");
    const canOpen = Boolean(item.exists && item.absolute_path);
    el.className = `workbench-artifact-item${canOpen ? " is-clickable" : ""}`;
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.title)}</div>
        <span class="workbench-badge">${item.exists ? "ready" : "missing"}</span>
      </div>
      <div class="workbench-item-body">${escapeHtml(item.path)}</div>
    `;
    if (canOpen) {
      el.title = "点击打开产出物";
      el.addEventListener("click", () => {
        if (window.nanoclawApp?.openFile) {
          window.nanoclawApp.openFile(item.absolute_path);
        } else {
          window.open(`file://${item.absolute_path}`);
        }
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showFileContextMenu(e, item.absolute_path);
      });
    }
    workbenchArtifacts.appendChild(el);
  });
}

function renderWorkbenchAssets(assets) {
  const sortedAssets = sortWorkbenchItemsByCreatedAt(assets);
  workbenchAssets.innerHTML = "";
  if (sortedAssets.length === 0) {
    workbenchAssets.innerHTML = `<div class="workbench-empty">暂无上下文资产</div>`;
    return;
  }
  sortedAssets.forEach((item) => {
    const el = document.createElement("div");
    el.className = "workbench-artifact-item";
    const href = item.url || (item.path ? `file://${item.path}` : "");
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.title)}</div>
        <span class="workbench-badge">${escapeHtml(item.asset_type)}</span>
      </div>
      <div class="workbench-item-body">${escapeHtml(item.note || item.path || item.url || "")}</div>
    `;
    if (href) {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => window.open(href));
    }
    workbenchAssets.appendChild(el);
  });
}

function renderWorkbenchComments(comments) {
  const sortedComments = sortWorkbenchItemsByCreatedAt(comments);
  workbenchComments.innerHTML = "";
  if (sortedComments.length === 0) {
    workbenchComments.innerHTML = `<div class="workbench-empty">暂无备注评论</div>`;
    return;
  }
  sortedComments.forEach((item) => {
    const el = document.createElement("div");
    el.className = "workbench-event-item";
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">${escapeHtml(item.author)}</div>
        <span class="workbench-badge">${escapeHtml(formatDateTime(item.created_at))}</span>
      </div>
      <div class="workbench-item-body">${escapeHtml(item.content)}</div>
    `;
    workbenchComments.appendChild(el);
  });
}

function renderWorkbenchTimeline(timeline) {
  const sortedTimeline = sortWorkbenchTimeline(timeline);
  workbenchTimeline.innerHTML = "";
  if (sortedTimeline.length === 0) {
    workbenchTimeline.innerHTML = `<div class="workbench-empty">暂无执行记录</div>`;
    return;
  }
  sortedTimeline.forEach((item) => {
    const el = document.createElement("div");
    el.className = `workbench-event-item ${item.type || ""}`;
    const eventTypeLabel = item.type === "manual"
      ? "手动处理"
      : item.type === "approval"
        ? "审批"
        : item.type === "artifact"
          ? "产物"
          : item.type === "lifecycle"
            ? "流程"
            : "执行";
    el.innerHTML = `
      <div class="workbench-item-row">
        <div class="workbench-item-title">
          ${escapeHtml(item.title)}
          <span class="workbench-badge">${escapeHtml(eventTypeLabel)}</span>
        </div>
        <span class="workbench-badge">${escapeHtml(formatDateTime(item.created_at))}</span>
      </div>
      <div class="workbench-item-body">${escapeHtml(item.body || "")}</div>
    `;
    workbenchTimeline.appendChild(el);
  });
}

function sortWorkbenchTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return [...timeline].sort((a, b) => {
    const aTs = parseTimestamp(a?.created_at || "");
    const bTs = parseTimestamp(b?.created_at || "");
    const safeATs = Number.isFinite(aTs) ? aTs : 0;
    const safeBTs = Number.isFinite(bTs) ? bTs : 0;
    if (safeATs !== safeBTs) return safeATs - safeBTs;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

async function triggerWorkbenchAction(taskId, action, subtaskId = "") {
  let revisionText = "";
  let accessToken = "";
  if (action === "revise") {
    revisionText = await openTextPrompt("请输入修改意见", "", {
      title: "修改意见",
      multiline: true,
    }) || "";
    if (!revisionText.trim()) return;
  } else if (action === "submit_access_token") {
    accessToken = await openTextPrompt("请输入 access_token", "", {
      title: "填写 access_token",
      placeholder: "请输入测试 token",
    }) || "";
    if (!accessToken.trim()) return;
  }
  try {
    const res = await apiFetch("/api/workbench/task/action", {
      method: "POST",
      body: JSON.stringify({
        task_id: taskId,
        subtask_id: subtaskId || undefined,
        action,
        revision_text: revisionText,
        access_token: accessToken,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (action === "skip") {
      workbenchSelectedSubtaskId = "";
      workbenchFollowCurrentSubtaskOnce = true;
    }
    await loadWorkbenchTasks(taskId);
  } catch (err) {
    console.error("Failed to run workbench action:", err);
    alert(err.message || "任务操作失败");
  }
}

async function triggerWorkbenchActionItem(taskId, actionItemId, action) {
  let replyText = "";
  if (action === "reply") {
    replyText = await openTextPrompt("请输入回复内容", "", {
      title: "回复待处理项",
      multiline: true,
    }) || "";
    if (!replyText.trim()) return;
  }
  try {
    const res = await apiFetch("/api/workbench/action-item", {
      method: "POST",
      body: JSON.stringify({
        task_id: taskId,
        action_item_id: actionItemId,
        action,
        reply_text: replyText || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadWorkbenchTaskDetail(taskId);
  } catch (err) {
    console.error("Failed to handle workbench action item:", err);
    alert(err.message || "待处理项操作失败");
  }
}

function toggleWorkbenchRetryComposer(subtaskId) {
  if (workbenchRetryComposerSubtaskId === subtaskId) {
    closeWorkbenchRetryComposer();
    return;
  }
  workbenchRetryComposerSubtaskId = subtaskId;
  workbenchRetryComposerDraft = "";
  renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
}

function closeWorkbenchRetryComposer() {
  workbenchRetryComposerSubtaskId = "";
  workbenchRetryComposerDraft = "";
  workbenchRetrySubmitting = false;
  renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
}

async function triggerWorkbenchSubtaskRetry(taskId, subtaskId, retryNote = "") {
  workbenchRetrySubmitting = true;
  renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
  try {
    const res = await apiFetch("/api/workbench/subtask/retry", {
      method: "POST",
      body: JSON.stringify({
        task_id: taskId,
        subtask_id: subtaskId,
        retry_note: retryNote || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    closeWorkbenchRetryComposer();
  } catch (err) {
    console.error("Failed to retry subtask:", err);
    alert(err.message || "子任务重跑失败");
    workbenchRetrySubmitting = false;
    renderWorkbenchSubtasks(currentWorkbenchDetail?.subtasks || []);
  }
}

async function submitWorkbenchComment() {
  if (!currentWorkbenchTaskId || !workbenchCommentInput.value.trim()) return;
  try {
    const res = await apiFetch("/api/workbench/task/comment", {
      method: "POST",
      body: JSON.stringify({
        task_id: currentWorkbenchTaskId,
        author: "Web User",
        content: workbenchCommentInput.value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    workbenchCommentInput.value = "";
  } catch (err) {
    console.error("Failed to add workbench comment:", err);
    alert(err.message || "添加备注失败");
  }
}

async function addWorkbenchLinkAsset() {
  if (!currentWorkbenchTaskId) return;
  const url = await openTextPrompt("输入链接 URL", "https://", {
    title: "添加链接",
    placeholder: "https://",
  });
  if (!url || !url.trim()) return;
  const title = await openTextPrompt("链接标题", "参考链接", {
    title: "添加链接",
  }) || "参考链接";
  const note = await openTextPrompt("补充说明", "", {
    title: "添加链接",
    multiline: true,
  }) || "";
  try {
    const res = await apiFetch("/api/workbench/task/asset", {
      method: "POST",
      body: JSON.stringify({
        task_id: currentWorkbenchTaskId,
        title,
        asset_type: "link",
        url: url.trim(),
        note,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    console.error("Failed to add workbench link asset:", err);
    alert(err.message || "添加链接失败");
  }
}

async function addWorkbenchFileAsset() {
  if (!currentWorkbenchTaskId) return;
  const picker = document.createElement("input");
  picker.type = "file";
  picker.onchange = async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch(
        `http://localhost:3000/api/upload?jid=${encodeURIComponent(currentGroupJid || groups.find((g) => g.isMain)?.jid || "")}`,
        { method: "POST", body: formData }
      );
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || `HTTP ${uploadRes.status}`);
      const uploaded = uploadData.files && uploadData.files[0];
      if (!uploaded) throw new Error("上传结果为空");
      const note = await openTextPrompt("补充说明", "", {
        title: "添加文件",
        multiline: true,
      }) || "";
      const assetRes = await apiFetch("/api/workbench/task/asset", {
        method: "POST",
        body: JSON.stringify({
          task_id: currentWorkbenchTaskId,
          title: file.name,
          asset_type: "file",
          path: uploaded.hostPath,
          note,
        }),
      });
      const assetData = await assetRes.json();
      if (!assetRes.ok) throw new Error(assetData.error || `HTTP ${assetRes.status}`);
    } catch (err) {
      console.error("Failed to add workbench file asset:", err);
      alert(err.message || "添加文件失败");
    }
  };
  picker.click();
}

async function openWorkbenchCreateTaskModal() {
  const optionsData = await loadWorkflowCreateOptions();
  const workflowTypes = Array.isArray(optionsData.workflow_types) ? optionsData.workflow_types : [];
  const services = Array.isArray(optionsData.services) ? optionsData.services : [];
  const requirementsByService = optionsData.requirements_by_service || {};
  const mainGroup = groups.find((group) => group.isMain) || groups[0];

  if (!mainGroup) {
    alert("未找到可用主群，无法创建任务");
    return;
  }
  if (workflowTypes.length === 0 || services.length === 0) {
    alert("当前没有可用流程类型或服务配置");
    return;
  }

  const existing = document.getElementById("workbench-create-overlay");
  if (existing) existing.remove();

  const state = {
    workflowType: workflowTypes[0].type,
    entryPoint: workflowTypes[0].entry_points[0] || "",
    service: services[0],
    requirementMode: "preset",
    requirementPreset: "",
    requirementCustom: "",
    requirementSearch: "",
    deployBranch: "",
    workBranch: "",
  };

  const overlay = document.createElement("div");
  overlay.id = "workbench-create-overlay";
  overlay.className = "workflow-wizard-overlay";
  overlay.innerHTML = `
    <div class="workflow-wizard-modal">
      <div class="workflow-wizard-header">
        <div class="workflow-wizard-title">新建工作台任务</div>
        <button type="button" class="icon-btn" id="workbench-create-close" title="关闭">×</button>
      </div>
      <div class="workflow-wizard-body">
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">1. 流程类型</div>
          <div id="wb-type-options" class="workflow-wizard-options"></div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">2. 入口点</div>
          <div id="wb-entry-options" class="workflow-wizard-options"></div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">3. 服务名称</div>
          <div id="wb-service-options" class="workflow-wizard-options"></div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">4. 任务名称</div>
          <div id="wb-requirement-mode" class="workflow-wizard-options compact"></div>
          <div id="wb-requirement-preset-wrap" class="workflow-wizard-subsection"></div>
          <div id="wb-requirement-custom-wrap" class="workflow-wizard-subsection"></div>
          <div id="wb-requirement-hint" class="workflow-wizard-hint"></div>
        </div>
        <div class="workflow-wizard-section" id="wb-deploy-branch-section">
          <div class="workflow-wizard-label">5. staging_work_branch（预发工作分支，可选）</div>
          <div id="wb-deploy-branch-wrap" class="workflow-wizard-subsection"></div>
        </div>
        <div class="workflow-wizard-section" id="wb-work-branch-section">
          <div class="workflow-wizard-label">6. work_branch（工作分支，可选）</div>
          <div id="wb-work-branch-wrap" class="workflow-wizard-subsection"></div>
        </div>
      </div>
      <div class="workflow-wizard-footer">
        <button type="button" id="wb-cancel-btn" class="btn-ghost">取消</button>
        <button type="button" id="wb-submit-btn" class="btn-primary">创建任务</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const typeOptionsEl = overlay.querySelector("#wb-type-options");
  const entryOptionsEl = overlay.querySelector("#wb-entry-options");
  const serviceOptionsEl = overlay.querySelector("#wb-service-options");
  const reqModeEl = overlay.querySelector("#wb-requirement-mode");
  const reqPresetWrapEl = overlay.querySelector("#wb-requirement-preset-wrap");
  const reqCustomWrapEl = overlay.querySelector("#wb-requirement-custom-wrap");
  const reqHintEl = overlay.querySelector("#wb-requirement-hint");
  const deployBranchSectionEl = overlay.querySelector("#wb-deploy-branch-section");
  const deployBranchWrapEl = overlay.querySelector("#wb-deploy-branch-wrap");
  const workBranchSectionEl = overlay.querySelector("#wb-work-branch-section");
  const workBranchWrapEl = overlay.querySelector("#wb-work-branch-wrap");
  const submitBtn = overlay.querySelector("#wb-submit-btn");

  function closeWorkbenchCreateModal() {
    overlay.remove();
  }

  function getSelectedWorkflowType() {
    return workflowTypes.find((item) => item.type === state.workflowType) || workflowTypes[0];
  }

  function getEntryPoints() {
    return Array.isArray(getSelectedWorkflowType().entry_points) ? getSelectedWorkflowType().entry_points : [];
  }

  function getRequirements() {
    const rows = requirementsByService[state.service];
    return Array.isArray(rows) ? rows : [];
  }

  function getRequirementName() {
    const selectedType = getSelectedWorkflowType();
    if (selectedType.type === "dev_test") {
      if (state.entryPoint === "plan") return state.requirementCustom.trim();
      return state.requirementPreset;
    }
    return state.requirementMode === "custom" ? state.requirementCustom.trim() : state.requirementPreset;
  }

  function getRequirementDeliverables(reqName) {
    const req = getRequirements().find((item) => item.requirement_name === reqName);
    return Array.isArray(req?.deliverables) ? req.deliverables : [];
  }

  function getRequiredDeliverableFile() {
    const detail = getSelectedWorkflowType().entry_points_detail?.[state.entryPoint];
    if (!detail?.requires_deliverable) return "";
    return `${detail.deliverable_role || "dev"}.md`;
  }

  function updateValidation() {
    const requirementName = getRequirementName();
    const detail = getSelectedWorkflowType().entry_points_detail?.[state.entryPoint];
    const deliverableRequired = !!detail?.requires_deliverable;
    const requiredFile = getRequiredDeliverableFile();
    const deliverableFiles = getRequirementDeliverables(requirementName);
    const deliverableOk = !deliverableRequired || deliverableFiles.includes(requiredFile);

    if (!requirementName) {
      reqHintEl.textContent = "请输入或选择一个任务名称";
    } else if (deliverableRequired) {
      reqHintEl.textContent = deliverableOk
        ? `已校验交付物文件：${requiredFile}`
        : `当前入口点要求存在 ${requiredFile}，所选需求暂不满足`;
    } else {
      reqHintEl.textContent = "将使用当前名称创建新的工作流任务";
    }

    submitBtn.disabled = !requirementName || !state.entryPoint || !state.service || !deliverableOk;
  }

  function refreshWorkbenchCreateModal() {
    renderSingleOptions(
      typeOptionsEl,
      workflowTypes.map((item) => ({ value: item.type, label: `${item.type} (${item.name})` })),
      state.workflowType,
      (value) => {
        state.workflowType = value;
        state.entryPoint = getEntryPoints()[0] || "";
        refreshWorkbenchCreateModal();
      }
    );

    const entryPoints = getEntryPoints();
    if (!state.entryPoint || !entryPoints.includes(state.entryPoint)) {
      state.entryPoint = entryPoints[0] || "";
    }
    renderSingleOptions(
      entryOptionsEl,
      entryPoints.map((entry) => ({
        value: entry,
        label: getSelectedWorkflowType().entry_points_detail?.[entry]?.requires_deliverable ? `${entry} (需要交付物)` : entry,
      })),
      state.entryPoint,
      (value) => {
        state.entryPoint = value;
        refreshWorkbenchCreateModal();
      }
    );

    renderSingleOptions(
      serviceOptionsEl,
      services.map((service) => ({ value: service, label: service })),
      state.service,
      (value) => {
        state.service = value;
        const reqs = getRequirements();
        state.requirementPreset = reqs[0]?.requirement_name || "";
        refreshWorkbenchCreateModal();
      }
    );

    const reqs = getRequirements();
    if (!state.requirementPreset && reqs.length > 0) {
      state.requirementPreset = reqs[0].requirement_name;
    }

    reqModeEl.innerHTML = "";
    reqPresetWrapEl.innerHTML = "";
    reqCustomWrapEl.innerHTML = "";
    deployBranchWrapEl.innerHTML = "";
    workBranchWrapEl.innerHTML = "";

    const isDevTest = getSelectedWorkflowType().type === "dev_test";
    const isPlanEntry = state.entryPoint === "plan";
    const showDeployBranch = isDevTest && state.entryPoint === "testing";
    const showWorkBranch = isDevTest && state.entryPoint === "testing";

    deployBranchSectionEl.style.display = showDeployBranch ? "" : "none";
    if (showDeployBranch) {
      const input = document.createElement("input");
      input.className = "workflow-wizard-input";
      input.placeholder = "例如：staging-deploy/feature-xxx";
      input.value = state.deployBranch;
      input.addEventListener("input", () => {
        state.deployBranch = input.value;
      });
      deployBranchWrapEl.appendChild(input);
    } else {
      state.deployBranch = "";
    }

    workBranchSectionEl.style.display = showWorkBranch ? "" : "none";
    if (showWorkBranch) {
      const input = document.createElement("input");
      input.className = "workflow-wizard-input";
      input.placeholder = "例如：feature/xxx";
      input.value = state.workBranch;
      input.addEventListener("input", () => {
        state.workBranch = input.value;
      });
      workBranchWrapEl.appendChild(input);
    } else {
      state.workBranch = "";
    }

    if (isDevTest) {
      if (isPlanEntry) {
        const input = document.createElement("input");
        input.className = "workflow-wizard-input";
        input.placeholder = "输入新需求名称";
        input.value = state.requirementCustom;
        input.addEventListener("input", () => {
          state.requirementCustom = input.value;
          updateValidation();
        });
        reqCustomWrapEl.appendChild(input);
      } else {
        const search = document.createElement("input");
        search.className = "workflow-wizard-input";
        search.placeholder = "搜索已有需求";
        search.value = state.requirementSearch;
        search.addEventListener("input", () => {
          state.requirementSearch = search.value;
          refreshWorkbenchCreateModal();
        });
        reqModeEl.appendChild(search);

        const filteredReqs = reqs.filter((item) => !state.requirementSearch || item.requirement_name.includes(state.requirementSearch.trim()));
        const opts = document.createElement("div");
        opts.className = "workflow-wizard-options";
        reqPresetWrapEl.appendChild(opts);
        renderSingleOptions(
          opts,
          filteredReqs.map((item) => ({ value: item.requirement_name, label: item.requirement_name })),
          state.requirementPreset,
          (value) => {
            state.requirementPreset = value;
            refreshWorkbenchCreateModal();
          }
        );
      }
    } else {
      renderSingleOptions(
        reqModeEl,
        [
          { value: "preset", label: "已有需求" },
          { value: "custom", label: "自定义任务" },
        ],
        state.requirementMode,
        (value) => {
          state.requirementMode = value;
          refreshWorkbenchCreateModal();
        }
      );

      if (state.requirementMode === "preset") {
        const opts = document.createElement("div");
        opts.className = "workflow-wizard-options";
        reqPresetWrapEl.appendChild(opts);
        renderSingleOptions(
          opts,
          reqs.map((item) => ({ value: item.requirement_name, label: item.requirement_name })),
          state.requirementPreset,
          (value) => {
            state.requirementPreset = value;
            refreshWorkbenchCreateModal();
          }
        );
      } else {
        const input = document.createElement("input");
        input.className = "workflow-wizard-input";
        input.placeholder = "输入任务名称";
        input.value = state.requirementCustom;
        input.addEventListener("input", () => {
          state.requirementCustom = input.value;
          updateValidation();
        });
        reqCustomWrapEl.appendChild(input);
      }
    }

    updateValidation();
  }

  overlay.querySelector("#workbench-create-close").addEventListener("click", closeWorkbenchCreateModal);
  overlay.querySelector("#wb-cancel-btn").addEventListener("click", closeWorkbenchCreateModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeWorkbenchCreateModal();
  });
  submitBtn.addEventListener("click", async () => {
    const name = getRequirementName();
    const detail = getSelectedWorkflowType().entry_points_detail?.[state.entryPoint];
    const deliverableRequired = !!detail?.requires_deliverable;
    const requiredFile = getRequiredDeliverableFile();
    const deliverableFiles = getRequirementDeliverables(name);
    if (!name) return;
    if (deliverableRequired && !deliverableFiles.includes(requiredFile)) {
      alert(`当前入口点要求交付物文件 ${requiredFile}，所选需求不满足。`);
      return;
    }

    try {
      const res = await apiFetch("/api/workbench/task", {
        method: "POST",
        body: JSON.stringify({
          name,
          service: state.service,
          source_jid: mainGroup.jid,
          start_from: state.entryPoint,
          workflow_type: state.workflowType,
          deliverable: deliverableRequired ? name : void 0,
          staging_work_branch: state.deployBranch.trim() || void 0,
          work_branch: state.workBranch.trim() || void 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      closeWorkbenchCreateModal();
      const createdDetail = data.detail && data.detail.task ? data.detail : null;
      const selectedTaskId = data.task_id || (createdDetail && createdDetail.task && createdDetail.task.id) || data.workflow_id || "";

      if (createdDetail) {
        currentWorkbenchTaskId = createdDetail.task.id;
        currentWorkbenchDetail = createdDetail;
        const taskIdx = workbenchTasks.findIndex((item) => item.id === createdDetail.task.id);
        if (taskIdx >= 0) {
          workbenchTasks[taskIdx] = { ...workbenchTasks[taskIdx], ...createdDetail.task };
        } else {
          workbenchTasks.unshift(createdDetail.task);
        }
        renderWorkbenchTaskList();
        renderWorkbenchTaskDetail(createdDetail);
      }

      await loadWorkbenchTasks(selectedTaskId, false, !createdDetail);
      if (selectedTaskId) {
        scheduleWorkbenchTaskDetailReload(selectedTaskId, createdDetail ? 400 : 0);
      }
    } catch (err) {
      console.error("Failed to create workbench task:", err);
      alert(err.message || "任务创建失败");
    }
  });

  refreshWorkbenchCreateModal();
}

async function loadMessages() {
  if (!currentGroupJid) return;
  try {
    const res = await apiFetch(
      `/api/messages?jid=${encodeURIComponent(currentGroupJid)}&since=0&limit=${INITIAL_MESSAGE_LIMIT}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messages = data.messages.map(m => ({ ...m, _filePath: m.file_path || undefined }));
    hasMoreHistory = messages.length >= INITIAL_MESSAGE_LIMIT;
    renderMessages();
  } catch (err) {
    console.error("Failed to load messages:", err);
  }
}

// --- Infinite scroll: load older messages ---
async function loadMoreHistory() {
  if (!currentGroupJid || !hasMoreHistory || loadingHistory) return;
  if (messages.length === 0) return;

  loadingHistory = true;
  const oldestTs = messages[0].timestamp;
  const prevScrollHeight = messagesEl.scrollHeight;

  try {
    const res = await apiFetch(
      `/api/messages?jid=${encodeURIComponent(currentGroupJid)}&before=${oldestTs}&limit=50`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.messages.length === 0) {
      hasMoreHistory = false;
      return;
    }
    // Prepend older messages
    const olderMessages = data.messages.map(m => ({ ...m, _filePath: m.file_path || undefined }));
    messages = [...olderMessages, ...messages];
    // Rebuild DOM and restore scroll position
    renderMessages();
    const newScrollHeight = messagesEl.scrollHeight;
    messagesEl.scrollTop = newScrollHeight - prevScrollHeight;
  } catch (err) {
    console.error("Failed to load history:", err);
  } finally {
    loadingHistory = false;
  }
}

function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  setConnectionStatus("connecting");
  const wsUrl = "ws://localhost:3000/ws";
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setConnectionStatus("connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (currentGroupJid) {
      sendWs({ type: "select_group", chatJid: currentGroupJid });
    }
  };
  ws.onclose = () => {
    setConnectionStatus("disconnected");
    ws = null;
    reconnectTimer = setTimeout(connectWS, 3e3);
  };
  ws.onerror = (err) => {
    console.error("WS error:", err);
    setConnectionStatus("disconnected");
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWsMessage(msg);
    } catch {
      console.error("Failed to parse WS message:", e.data);
    }
  };
}
function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function isAppForeground() {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

function shouldIncrementUnread(chatJid) {
  if (!chatJid) return false;
  if (chatJid !== currentGroupJid) return true;
  // Current group should also become unread if app is not in foreground.
  return !isAppForeground();
}

function clearUnreadForGroup(chatJid) {
  if (!chatJid) return;
  if (!unreadCounts[chatJid]) return;
  unreadCounts[chatJid] = 0;
  renderGroups();
}

function clearCurrentGroupUnreadIfForeground() {
  if (!currentGroupJid) return;
  if (!isAppForeground()) return;
  clearUnreadForGroup(currentGroupJid);
}

function handleWorkbenchRealtimeEvent(event) {
  if (!event || activePrimaryNavKey !== "workbench") return;
  applyWorkbenchRealtimeEvent(event);
}

function applyWorkbenchRealtimeEvent(event) {
  if (!event) return;
  const payload = event.payload || {};
  const taskIdx = workbenchTasks.findIndex((item) => item.id === event.taskId);

  if (taskIdx >= 0) {
    const existing = workbenchTasks[taskIdx];
    if (event.type === "task_created") {
      workbenchTasks[taskIdx] = { ...existing, ...payload };
    } else if (event.type === "task_updated") {
      workbenchTasks[taskIdx] = {
        ...existing,
        status: payload.status || existing.status,
        status_label: payload.statusLabel || existing.status_label,
        current_stage: payload.currentStage || existing.current_stage,
        current_stage_label: payload.currentStageLabel || existing.current_stage_label,
        updated_at: payload.updatedAt || existing.updated_at,
      };
    }
    workbenchTasks = sortWorkbenchTaskItems(workbenchTasks);
    renderWorkbenchTaskList();
  } else if (event.type === "task_created" && payload.id) {
    workbenchTasks.push({
      id: event.taskId,
      title: payload.title || "新任务",
      service: payload.service || "",
      workflow_type: payload.workflowType || "",
      status: payload.status || "created",
      status_label: payload.statusLabel || payload.status || "created",
      current_stage: payload.currentStage || payload.status || "created",
      current_stage_label: payload.currentStageLabel || payload.currentStage || payload.status || "created",
      branch: "",
      deliverable: "",
      round: 0,
      source_jid: payload.sourceJid || "",
      created_at: getPayloadTimestamp(payload),
      updated_at: getPayloadTimestamp(payload),
      pending_approval: false,
      active_delegation_id: "",
    });
    workbenchTasks = sortWorkbenchTaskItems(workbenchTasks);
    renderWorkbenchTaskList();
  }

  if (!currentWorkbenchDetail || currentWorkbenchTaskId !== event.taskId) return;

  if (event.type === "task_updated") {
    currentWorkbenchDetail.task = {
      ...currentWorkbenchDetail.task,
      status: payload.status || currentWorkbenchDetail.task.status,
      status_label: payload.statusLabel || currentWorkbenchDetail.task.status_label,
      current_stage: payload.currentStage || currentWorkbenchDetail.task.current_stage,
      current_stage_label: payload.currentStageLabel || currentWorkbenchDetail.task.current_stage_label,
      updated_at: payload.updatedAt || currentWorkbenchDetail.task.updated_at,
    };
    renderWorkbenchTaskDetail(currentWorkbenchDetail);
  } else if (event.type === "subtask_updated") {
    const subtask = currentWorkbenchDetail.subtasks.find((item) => item.id === payload.id);
    if (subtask) {
      if (payload.status && ["completed", "current", "pending", "failed", "cancelled"].includes(payload.status)) {
        subtask.status = payload.status;
      }
      if (typeof payload.manuallySkipped === "boolean") {
        subtask.manually_skipped = payload.manuallySkipped;
      }
      if (payload.groupFolder) subtask.target_folder = payload.groupFolder;
      renderWorkbenchSubtasks(currentWorkbenchDetail.subtasks);
    }
  } else if (event.type === "event_created") {
    const nextId = payload.id || `rt-${Date.now()}`;
    const existingIdx = currentWorkbenchDetail.timeline.findIndex((item) => item.id === nextId);
    const nextItem = {
      id: nextId,
      type: payload.status === "manual_skip" ? "manual" : "delegation",
      title: payload.title || "任务更新",
      body: payload.body || "",
      created_at: getPayloadTimestamp(payload),
      status: payload.status || ""
    };
    if (existingIdx >= 0) {
      currentWorkbenchDetail.timeline[existingIdx] = nextItem;
    } else {
      currentWorkbenchDetail.timeline.push(nextItem);
    }
    currentWorkbenchDetail.timeline = sortWorkbenchTimeline(currentWorkbenchDetail.timeline);
    renderWorkbenchTimeline(currentWorkbenchDetail.timeline);
  } else if (event.type === "artifact_created") {
    const exists = currentWorkbenchDetail.artifacts.some((item) => item.id === payload.id);
    if (!exists) {
      currentWorkbenchDetail.artifacts.push({
        id: payload.id,
        title: payload.title || "新产出",
        artifact_type: payload.artifactType || "artifact",
        path: payload.path || "",
        absolute_path: payload.absolutePath || "",
        exists: true,
        created_at: getPayloadTimestamp(payload),
      });
      currentWorkbenchDetail.artifacts = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.artifacts);
      renderWorkbenchArtifacts(currentWorkbenchDetail.artifacts);
    }
  } else if (event.type === "action_item_updated") {
    if (!applyWorkbenchActionItemRealtimeUpdate(payload)) {
      scheduleWorkbenchTaskDetailReload(currentWorkbenchTaskId);
    }
  } else if (event.type === "comment_created") {
    currentWorkbenchDetail.comments.push({
      id: payload.id,
      author: payload.author || "Web User",
      content: payload.content || "",
      created_at: getPayloadTimestamp(payload),
    });
    currentWorkbenchDetail.comments = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.comments);
    renderWorkbenchComments(currentWorkbenchDetail.comments);
  } else if (event.type === "asset_created") {
    currentWorkbenchDetail.assets.push({
      id: payload.id,
      title: payload.title || "新资产",
      asset_type: payload.assetType || "asset",
      path: payload.path || null,
      url: payload.url || null,
      note: payload.note || null,
      created_at: getPayloadTimestamp(payload),
    });
    currentWorkbenchDetail.assets = sortWorkbenchItemsByCreatedAt(currentWorkbenchDetail.assets);
    renderWorkbenchAssets(currentWorkbenchDetail.assets);
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "connected":
      console.log("WS connected:", msg.message);
      break;
    case "groups":
      groups = msg.groups || [];
      renderGroups();
      if (activePrimaryNavKey === "trace-monitor") {
        renderTraceMonitorList();
        if (currentTraceRunRecord) {
          renderTraceRunDetail();
        }
      }
      break;
    case "message": {
      const incoming = {
        id: msg.id,
        chat_jid: msg.chatJid,
        sender: msg.sender,
        sender_name: msg.sender_name || msg.sender,
        content: msg.content,
        timestamp: msg.timestamp,
        is_from_me: msg.is_from_me || false,
        is_bot_message: msg.is_bot_message || false,
        reply_to_id: msg.reply_to_id || null,
        model: msg.model || null
      };
      if (incoming.chat_jid === currentGroupJid) {
        messages.push(incoming);
        const dropped = trimLiveMessageBuffer();
        if (dropped > 0) {
          renderMessages();
        } else {
          appendSingleMessage(incoming);
        }
        if (!incoming.is_from_me) {
          scheduleModelSync();
        }
      }
      if (!incoming.is_from_me && shouldIncrementUnread(incoming.chat_jid)) {
        unreadCounts[incoming.chat_jid] = (unreadCounts[incoming.chat_jid] || 0) + 1;
        renderGroups();
      }
      if (!incoming.is_from_me) {
        notifyAgent(incoming);
      }
      break;
    }
    case "card": {
      const cardMsg = {
        id: msg.cardId,
        chat_jid: msg.chatJid,
        sender: "assistant",
        sender_name: "Assistant",
        content: JSON.stringify({ _type: "card", card: msg.card }),
        timestamp: msg.timestamp,
        is_from_me: false,
        is_bot_message: true,
      };
      if (cardMsg.chat_jid === currentGroupJid) {
        messages.push(cardMsg);
        const dropped = trimLiveMessageBuffer();
        if (dropped > 0) {
          renderMessages();
        } else {
          appendSingleMessage(cardMsg);
        }
      }
      if (shouldIncrementUnread(cardMsg.chat_jid)) {
        unreadCounts[cardMsg.chat_jid] = (unreadCounts[cardMsg.chat_jid] || 0) + 1;
        renderGroups();
      }
      notifyAgent(cardMsg);
      break;
    }
    case "file": {
      const content = msg.caption || `文件: ${msg.filePath.split("/").pop()}`;
      const fileMsg = {
        id: `file_${msg.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: msg.chatJid,
        sender: msg.sender || "assistant",
        sender_name: msg.sender || "Assistant",
        content,
        timestamp: msg.timestamp,
        is_from_me: false,
        is_bot_message: true,
        _filePath: msg.filePath,
      };
      if (fileMsg.chat_jid === currentGroupJid) {
        messages.push(fileMsg);
        const dropped = trimLiveMessageBuffer();
        if (dropped > 0) {
          renderMessages();
        } else {
          appendSingleMessage(fileMsg);
        }
      }
      if (shouldIncrementUnread(fileMsg.chat_jid)) {
        unreadCounts[fileMsg.chat_jid] = (unreadCounts[fileMsg.chat_jid] || 0) + 1;
        renderGroups();
      }
      notifyAgent(fileMsg);
      break;
    }
    case "typing":
      typingIndicator.className = msg.isTyping ? "" : "hidden";
      break;
    case "agent_status":
      if (agentStatusPanel.classList.contains("open")) {
        renderAgentStatus(msg.agents || []);
      }
      break;
    case "agent_query_trace":
      updateAgentRunTraces(msg.queries || []);
      traceMonitorActiveRuns = (msg.queries || [])
        .map((run) => normalizeTraceRun(run, "active"))
        .filter(Boolean);
      if (agentStatusPanel.classList.contains("open")) {
        renderAgentStatus(agentStatusData);
      }
      if (activePrimaryNavKey === "trace-monitor") {
        if (activeTraceMonitorScope === "active") {
          renderTraceMonitorList();
        }
        scheduleTraceDetailReload();
      }
      break;
    case "workbench_event":
      handleWorkbenchRealtimeEvent(msg.event);
      break;
    case "error":
      console.error("WS error from server:", msg.message);
      showError(`Server error: ${msg.message}`);
      break;
  }
}
function notifyAgent(msg) {
  const group = groups.find((g) => g.jid === msg.chat_jid);
  const title = `${group?.name || "Support Group Agent"}`;
  const body = `${msg.sender_name}: ${msg.content.slice(0, 100)}`;
  if (typeof window !== "undefined" && window.nanoclawApp) {
    window.nanoclawApp.notify(title, body, { chatJid: msg.chat_jid });
    return;
  }

  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") {
    ensureBrowserNotificationPermission();
    return;
  }

  const notification = new Notification(title, {
    body,
    tag: `nanoclaw-${msg.chat_jid}`,
  });
  notification.onclick = () => {
    window.focus();
    if (msg.chat_jid && msg.chat_jid !== currentGroupJid) {
      selectGroup(msg.chat_jid).catch((err) => {
        console.error("Failed to switch group from browser notification click:", err);
      });
    }
  };
}

function ensureBrowserNotificationPermission() {
  if (typeof window === "undefined" || window.nanoclawApp) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  if (browserNotificationPermissionRequested) return;

  browserNotificationPermissionRequested = true;
  Notification.requestPermission().catch((err) => {
    console.error("Failed to request browser notification permission:", err);
  });
}

function bindNotificationPermissionPrimer() {
  if (typeof window === "undefined" || window.nanoclawApp) return;
  const requestOnce = () => ensureBrowserNotificationPermission();
  window.addEventListener("pointerdown", requestOnce, { once: true, capture: true });
  window.addEventListener("keydown", requestOnce, { once: true, capture: true });
}

function bindNotificationClickHandler() {
  if (typeof window === "undefined" || !window.nanoclawApp?.onNotificationClick) return;
  window.nanoclawApp.onNotificationClick(({ chatJid }) => {
    if (typeof chatJid !== "string" || !chatJid) return;
    if (chatJid === currentGroupJid) {
      clearUnreadForGroup(chatJid);
      return;
    }
    selectGroup(chatJid).catch((err) => {
      console.error("Failed to switch group from notification click:", err);
    });
  });
}
async function selectGroup(jid) {
  if (multiSelectMode) exitMultiSelect();
  // Clear staged files when switching groups
  pendingFiles = [];
  renderPendingFiles();
  currentGroupJid = jid;
  messages = [];
  hasMoreHistory = true;

  // Clear unread for this group
  unreadCounts[jid] = 0;

  // Show skeleton while loading
  showSkeleton();
  updateChatHeader();
  renderGroups();

  await loadMessages();
  sendWs({ type: "select_group", chatJid: jid });
}
async function sendMessage(content) {
  if (!content.trim() && pendingFiles.length === 0) return;
  if (!currentGroupJid) return;

  // Upload pending files first and prepend their container paths
  let filePrefix = "";
  if (pendingFiles.length > 0) {
    try {
      filePrefix = await uploadPendingFiles();
    } catch (err) {
      showError(`附件上传失败: ${err}`);
      return;
    }
  }

  const fullContent = filePrefix + content.trim();
  const payload = {
    type: "message",
    chatJid: currentGroupJid,
    content: fullContent,
  };

  // Include reply reference if set
  if (replyToMsg) {
    payload.replyToId = replyToMsg.id;
  }

  sendWs(payload);

  const userMsg = {
    id: `opt_${Date.now()}`,
    chat_jid: currentGroupJid,
    sender: "me",
    sender_name: "You",
    content: fullContent,
    timestamp: Date.now().toString(),
    is_from_me: true,
    is_bot_message: false,
    reply_to_id: replyToMsg ? replyToMsg.id : null
  };
  messages.push(userMsg);
  const dropped = trimLiveMessageBuffer();
  if (dropped > 0) {
    renderMessages();
  } else {
    appendSingleMessage(userMsg);
  }
  messageInput.value = "";
  autoResizeInput();
  clearReplyTo();
  hideCommandPalette();
  hideMentionPicker(false);
}

// --- Reply handling ---
function setReplyTo(msg) {
  replyToMsg = msg;
  replyPreviewContent.textContent = `${msg.sender_name || msg.sender}: ${msg.content.slice(0, 80)}`;
  replyPreview.classList.add("visible");
  messageInput.focus();
}

function clearReplyTo() {
  replyToMsg = null;
  replyPreview.classList.remove("visible");
  replyPreviewContent.textContent = "";
}

// --- Command palette ---
function ensureCommandPaletteElements() {
  if (!commandPalette || commandSearchInput || commandOptionsEl) return;

  const searchWrap = document.createElement("div");
  searchWrap.className = "command-search-wrap";
  commandSearchInput = document.createElement("input");
  commandSearchInput.id = "command-search-input";
  commandSearchInput.type = "text";
  commandSearchInput.placeholder = "搜索命令";
  searchWrap.appendChild(commandSearchInput);
  commandPalette.appendChild(searchWrap);

  commandOptionsEl = document.createElement("div");
  commandOptionsEl.id = "command-options";
  commandPalette.appendChild(commandOptionsEl);

  commandSearchInput.addEventListener("input", () => {
    cmdPaletteIndex = 0;
    renderCommandOptions();
  });

  commandSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateCommandPalette(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateCommandPalette(1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (commandCandidates.length > 0) {
        e.preventDefault();
        executeCommand(commandCandidates[Math.max(cmdPaletteIndex, 0)]);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideCommandPalette();
    }
  });
}

function getCommandCandidates(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return commands.slice();
  return commands.filter((c) => fuzzyMatch(c.name.replace(/^\//, ""), q) || fuzzyMatch(c.desc, q));
}

function renderCommandOptions() {
  if (!commandOptionsEl || !commandSearchInput) return;
  const query = commandSearchInput.value || "";
  commandCandidates = getCommandCandidates(query);
  commandOptionsEl.innerHTML = "";

  if (commandCandidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = "没有匹配命令";
    commandOptionsEl.appendChild(empty);
    cmdPaletteIndex = -1;
    return;
  }

  if (cmdPaletteIndex < 0 || cmdPaletteIndex >= commandCandidates.length) {
    cmdPaletteIndex = 0;
  }

  commandCandidates.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = `cmd-item${i === cmdPaletteIndex ? " active" : ""}`;
    item.innerHTML = `<span class="cmd-item-name">${escapeHtml(cmd.name)}</span><span class="cmd-item-desc">${escapeHtml(cmd.desc)}</span>`;
    item.addEventListener("click", () => executeCommand(cmd));
    commandOptionsEl.appendChild(item);
  });
}

async function executeCommand(cmd) {
  hideCommandPalette(false);
  if (!cmd) return;
  messageInput.value = cmd.name + " ";
  messageInput.focus();
  autoResizeInput();
}

function showCommandPalette(filter) {
  if (mentionPickerVisible) hideMentionPicker(false);
  if (!commandPalette) return;
  ensureCommandPaletteElements();
  commandInsertPos = messageInput.selectionStart;
  commandPickerVisible = true;
  commandPalette.classList.add("visible");
  cmdPaletteIndex = 0;
  const initial = (filter || "").replace(/^\//, "");
  if (commandSearchInput) commandSearchInput.value = initial;
  renderCommandOptions();
  commandSearchInput?.focus();
}

function hideCommandPalette(restoreFocus = true) {
  if (!commandPalette) return;
  commandPickerVisible = false;
  commandPalette.classList.remove("visible");
  cmdPaletteIndex = -1;
  commandCandidates = [];
  commandInsertPos = null;
  if (restoreFocus) messageInput.focus();
}

function loadWorkflowCreateOptions(forceReload = false) {
  if (!forceReload && workflowCreateOptionsCache) {
    return Promise.resolve(workflowCreateOptionsCache);
  }
  if (!forceReload && workflowCreateOptionsLoading) {
    return workflowCreateOptionsLoading;
  }
  workflowCreateOptionsLoading = apiFetch("/api/workflow/create-options")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      workflowCreateOptionsCache = data;
      return data;
    })
    .finally(() => {
      workflowCreateOptionsLoading = null;
    });
  return workflowCreateOptionsLoading;
}

function invalidateWorkflowCreateOptionsCache() {
  workflowCreateOptionsCache = null;
}

function warmWorkflowCreateOptions(forceReload = false) {
  if (forceReload) {
    invalidateWorkflowCreateOptionsCache();
  }
  loadWorkflowCreateOptions(forceReload).catch((err) => {
    console.error("Failed to prefetch task create options:", err);
  });
}

function renderSingleOptions(container, options, selected, onPick) {
  container.innerHTML = "";
  if (!Array.isArray(options) || options.length === 0) {
    const empty = document.createElement("div");
    empty.className = "workflow-wizard-empty";
    empty.textContent = "暂无可选项";
    container.appendChild(empty);
    return;
  }
  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "workflow-wizard-option" + (selected === opt.value ? " selected" : "");
    btn.textContent = opt.label;
    btn.addEventListener("click", () => onPick(opt.value));
    container.appendChild(btn);
  });
}

function navigateCommandPalette(direction) {
  if (!commandOptionsEl || commandCandidates.length === 0) return;
  const items = commandOptionsEl.querySelectorAll(".cmd-item");
  items[cmdPaletteIndex]?.classList.remove("active");
  cmdPaletteIndex = (cmdPaletteIndex + direction + commandCandidates.length) % commandCandidates.length;
  items[cmdPaletteIndex]?.classList.add("active");
  items[cmdPaletteIndex]?.scrollIntoView({ block: "nearest" });
}

function selectCommandPaletteItem() {
  if (cmdPaletteIndex >= 0 && cmdPaletteIndex < commandCandidates.length) {
    executeCommand(commandCandidates[cmdPaletteIndex]);
  }
}

function fuzzyMatch(text, query) {
  const source = (text || "").toLowerCase();
  const target = (query || "").trim().toLowerCase();
  if (!target) return true;
  if (source.includes(target)) return true;
  let j = 0;
  for (let i = 0; i < source.length && j < target.length; i++) {
    if (source[i] === target[j]) j++;
  }
  return j === target.length;
}

function getMentionTargets() {
  const targets = [{ name: "Andy", kind: "assistant" }];
  const seen = new Set(["andy"]);
  const folders = groups
    .filter((g) => g && typeof g.jid === "string" && g.jid.startsWith("web:") && typeof g.folder === "string" && g.folder.trim())
    .map((g) => g.folder.trim());
  folders.sort((a, b) => a.localeCompare(b, "zh-CN"));

  for (const folder of folders) {
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ name: folder, kind: "groupfolder" });
  }
  return targets;
}

function ensureMentionPickerElements() {
  if (!mentionPicker || mentionSearchInput || mentionOptionsEl) return;

  const searchWrap = document.createElement("div");
  searchWrap.className = "mention-search-wrap";
  mentionSearchInput = document.createElement("input");
  mentionSearchInput.id = "mention-search-input";
  mentionSearchInput.type = "text";
  mentionSearchInput.placeholder = "搜索 Andy 或 group folder";
  searchWrap.appendChild(mentionSearchInput);
  mentionPicker.appendChild(searchWrap);

  mentionOptionsEl = document.createElement("div");
  mentionOptionsEl.id = "mention-options";
  mentionPicker.appendChild(mentionOptionsEl);

  mentionSearchInput.addEventListener("input", () => {
    mentionPickerIndex = 0;
    renderMentionOptions();
  });

  mentionSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateMentionPicker(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateMentionPicker(1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (mentionCandidates.length > 0) {
        e.preventDefault();
        selectMention(mentionCandidates[Math.max(mentionPickerIndex, 0)].name);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideMentionPicker();
    }
  });
}

function renderMentionOptions() {
  if (!mentionOptionsEl || !mentionSearchInput) return;
  const query = mentionSearchInput.value || "";
  mentionCandidates = getMentionTargets().filter((item) => fuzzyMatch(item.name, query));
  mentionOptionsEl.innerHTML = "";

  if (mentionCandidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = "没有匹配项";
    mentionOptionsEl.appendChild(empty);
    mentionPickerIndex = -1;
    return;
  }

  if (mentionPickerIndex < 0 || mentionPickerIndex >= mentionCandidates.length) {
    mentionPickerIndex = 0;
  }

  mentionCandidates.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = `mention-item${i === mentionPickerIndex ? " active" : ""}`;
    el.innerHTML = `<span class="mention-name">${escapeHtml("@" + item.name)}</span><span class="mention-kind">${escapeHtml(item.kind)}</span>`;
    el.addEventListener("click", () => selectMention(item.name));
    mentionOptionsEl.appendChild(el);
  });
}

function navigateMentionPicker(direction) {
  if (!mentionOptionsEl || mentionCandidates.length === 0) return;
  mentionPickerIndex = (mentionPickerIndex + direction + mentionCandidates.length) % mentionCandidates.length;
  const items = mentionOptionsEl.querySelectorAll(".mention-item");
  items.forEach((el, i) => el.classList.toggle("active", i === mentionPickerIndex));
  items[mentionPickerIndex]?.scrollIntoView({ block: "nearest" });
}

function showMentionPicker() {
  if (!mentionPicker) return;
  hideCommandPalette();
  ensureMentionPickerElements();
  mentionInsertPos = messageInput.selectionStart;
  mentionPickerVisible = true;
  mentionPicker.classList.add("visible");
  mentionPickerIndex = 0;
  if (mentionSearchInput) mentionSearchInput.value = "";
  renderMentionOptions();
  mentionSearchInput?.focus();
}

function hideMentionPicker(restoreFocus = true) {
  if (!mentionPicker) return;
  mentionPickerVisible = false;
  mentionPicker.classList.remove("visible");
  mentionCandidates = [];
  mentionPickerIndex = -1;
  mentionInsertPos = null;
  if (restoreFocus) messageInput.focus();
}

function selectMention(name) {
  const ta = messageInput;
  const pos = typeof mentionInsertPos === "number" ? mentionInsertPos : ta.selectionStart;
  const mentionText = `@${name} `;
  ta.value = ta.value.substring(0, pos) + mentionText + ta.value.substring(pos);
  ta.selectionStart = ta.selectionEnd = pos + mentionText.length;
  hideMentionPicker(false);
  ta.focus();
  autoResizeInput();
}

// Stage a file for upload on next send
function stageFile(file) {
  if (!currentGroupJid) return;
  pendingFiles.push(file);
  renderPendingFiles();
}

// Render the pending files preview bar
function renderPendingFiles() {
  if (pendingFiles.length === 0) {
    pendingFilesEl.classList.remove("visible");
    return;
  }
  const names = pendingFiles.map((f) => f.name).join(", ");
  pendingFilesContent.innerHTML = `${SVG.paperclip} ${pendingFiles.length} 个附件: ${names}`;
  pendingFilesEl.classList.add("visible");
}

// Remove a staged file by index
function removePendingFile(index) {
  pendingFiles.splice(index, 1);
  renderPendingFiles();
}

// Upload all pending files and return the prefix string to prepend to the message
async function uploadPendingFiles() {
  if (pendingFiles.length === 0) return "";

  const hostPaths = [];
  for (const file of pendingFiles) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(
      `http://localhost:3000/api/upload?jid=${encodeURIComponent(currentGroupJid)}`,
      { method: "POST", body: formData }
    );
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    if (data.files && data.files[0]) {
      hostPaths.push(data.files[0].hostPath);
    }
  }
  pendingFiles = [];
  renderPendingFiles();

  if (hostPaths.length === 0) return "";
  return (
    "【附件】\n" +
    hostPaths.map((p) => `文件地址: ${p}`).join("\n") +
    "\n"
  );
}
function showError(msg) {
  const el = document.createElement("div");
  el.className = "message system";
  el.textContent = `\u26A0 ${msg}`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  setTimeout(() => el.remove(), 5e3);
}
// --- Single message copy ---
function copyMessageContent(msg) {
  navigator.clipboard.writeText(msg.content).then(() => showCopyToast());
}

function showCopyToast() {
  showToast("\u5DF2\u590D\u5236");
}

function showToast(message) {
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove("visible");
  void toast.offsetWidth;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 1500);
}

// --- Multi-select ---
function enterMultiSelect() {
  multiSelectMode = true;
  messagesEl.classList.add("multi-select");
  multiSelectBar.classList.add("visible");
  selectModeBtn.classList.add("active");
  selectModeBtn.innerHTML = SVG.checkSquare;
  inputArea.style.display = "none";
  selectedMsgIds.clear();
  updateMultiSelectBar();
}

function exitMultiSelect() {
  multiSelectMode = false;
  messagesEl.classList.remove("multi-select");
  multiSelectBar.classList.remove("visible");
  selectModeBtn.classList.remove("active");
  selectModeBtn.innerHTML = originalSelectIcon;
  inputArea.style.display = "";
  messagesEl.querySelectorAll(".message.selected").forEach((el) => el.classList.remove("selected"));
  selectedMsgIds.clear();
}

function toggleMultiSelectMode() {
  if (multiSelectMode) exitMultiSelect();
  else enterMultiSelect();
}

function toggleMessageSelection(msgId, el) {
  if (selectedMsgIds.has(msgId)) {
    selectedMsgIds.delete(msgId);
    el.classList.remove("selected");
  } else {
    selectedMsgIds.add(msgId);
    el.classList.add("selected");
  }
  updateMultiSelectBar();
}

function updateMultiSelectBar() {
  const count = selectedMsgIds.size;
  selectedCountEl.textContent = "\u5DF2\u9009 " + count + " \u6761";
  copySelectedBtn.disabled = count === 0;
  deleteSelectedBtn.disabled = count === 0;
}

function copySelectedMessages() {
  const selected = messages.filter((m) => selectedMsgIds.has(m.id));
  if (selected.length === 0) return;
  const text = selected.map((m) => {
    const sender = m.sender_name || m.sender || "Unknown";
    const time = formatTime(m.timestamp);
    return `[${sender}] ${time}\n${m.content}`;
  }).join("\n\n");
  navigator.clipboard.writeText(text).then(() => {
    showCopyToast();
    exitMultiSelect();
  });
}

async function deleteSelectedMessages() {
  if (!currentGroupJid) return;
  const ids = Array.from(selectedMsgIds);
  if (ids.length === 0) return;
  if (!confirm(`删除已选的 ${ids.length} 条消息？`)) return;

  try {
    const res = await apiFetch("/api/messages", {
      method: "DELETE",
      body: JSON.stringify({ jid: currentGroupJid, ids }),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    await res.json();
    await loadMessages();
    exitMultiSelect();
  } catch (err) {
    console.error("Failed to delete selected messages:", err);
    alert("删除失败");
  }
}

function autoResizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
}

function isTextCursorTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'textarea, input[type="text"], input[type="search"], input[type="password"], input[type="email"], input[type="url"], input[type="number"], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    )
  );
}

function initTakeCopterCursor() {
  if (!window.matchMedia || !window.matchMedia("(pointer:fine)").matches) return;
  const el = document.createElement("div");
  el.className = "take-copter-cursor";
  const glyph = document.createElement("div");
  glyph.className = "take-copter-cursor-glyph";
  el.appendChild(glyph);
  document.body.appendChild(el);
  document.body.classList.add("take-copter-cursor-on");
  let isHoveringActionable = false;

  const hoverSelector = 'button, a, [role="button"], .list-item, .primary-nav-item, .icon-btn, .icon-btn-sm, .btn-primary, .btn-ghost, .btn-tool, input[type="button"], input[type="submit"], input[type="checkbox"], input[type="radio"], select, summary';

  function setCursorState(target) {
    const onText = isTextCursorTarget(target);
    document.body.classList.toggle("take-copter-cursor-text", onText);
    if (onText) {
      el.classList.remove("visible");
      return;
    }

    el.classList.add("visible");
    isHoveringActionable = target instanceof Element && Boolean(target.closest(hoverSelector));
    el.classList.toggle("hovering", isHoveringActionable);
  }

  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      const x = e.clientX - 16;
      const y = e.clientY - 9;
      if (isHoveringActionable) {
        el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.04)`;
      } else {
        el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1)`;
      }
    },
    { passive: true }
  );

  document.addEventListener("mouseover", (e) => {
    setCursorState(e.target);
  });

  document.addEventListener("mouseleave", () => {
    el.classList.remove("visible");
  });

  window.addEventListener("blur", () => {
    el.classList.remove("visible");
  });
}

function initChatBgParticleNudge() {
  const chatAreaEl = document.getElementById("chat-area");
  const bgEl = document.getElementById("chat-animated-bg");
  if (!chatAreaEl || !bgEl) return;

  const targets = Array.from(
    bgEl.querySelectorAll(".bg-particle, .bg-star, .bg-copter, .bg-bell")
  );
  if (targets.length === 0) return;

  function applyNudge(clientX, clientY) {
    const areaRect = chatAreaEl.getBoundingClientRect();
    const radius = 190;
    const maxPush = 16;

    targets.forEach((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - clientX;
      const dy = cy - clientY;
      const d = Math.hypot(dx, dy);

      if (d <= 0.01 || d > radius) {
        el.style.translate = "0 0";
        return;
      }

      const force = (1 - d / radius) * maxPush;
      const nx = (dx / d) * force;
      const ny = (dy / d) * force;

      // Constrain tiny elements inside chat area while nudging.
      const safeX = Math.max(-20, Math.min(20, nx));
      const safeY = Math.max(-16, Math.min(16, ny));
      const inArea =
        cx >= areaRect.left &&
        cx <= areaRect.right &&
        cy >= areaRect.top &&
        cy <= areaRect.bottom;
      el.style.translate = inArea ? `${safeX}px ${safeY}px` : "0 0";
    });
  }

  chatAreaEl.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      applyNudge(e.clientX, e.clientY);
    },
    { passive: true }
  );

  chatAreaEl.addEventListener("pointerleave", () => {
    targets.forEach((el) => {
      el.style.translate = "0 0";
    });
  });
}

// Auto-start on page load
initTakeCopterCursor();
initChatBgParticleNudge();
bindNotificationClickHandler();
bindNotificationPermissionPrimer();
window.addEventListener("focus", clearCurrentGroupUnreadIfForeground);
document.addEventListener("visibilitychange", clearCurrentGroupUnreadIfForeground);
connectWS();
loadGroups();
warmWorkflowCreateOptions();

// --- Event listeners ---
if (primaryNav) {
  setPrimaryNav(activePrimaryNavKey);
}
if (window.nanoclawApp && typeof window.nanoclawApp.onCyclePrimaryNav === "function") {
  window.nanoclawApp.onCyclePrimaryNav(() => {
    cyclePrimaryNav(1);
  });
}
primaryNavItems.forEach((item) => {
  item.addEventListener("click", () => {
    const navKey = item.getAttribute("data-nav-key") || "";
    setPrimaryNav(navKey);
  });
});
if (workbenchRefreshBtn) {
  workbenchRefreshBtn.addEventListener("click", async () => {
    await refreshWorkbenchView();
  });
}
if (workbenchCreateTaskBtn) {
  workbenchCreateTaskBtn.addEventListener("click", async () => {
    try {
      await openWorkbenchCreateTaskModal();
    } catch (err) {
      console.error("Failed to open workbench create dialog:", err);
      alert(err.message || "打开创建任务失败");
    }
  });
}
if (workbenchDeleteAllBtn) {
  workbenchDeleteAllBtn.addEventListener("click", () => {
    deleteAllWorkbenchTaskData();
  });
}
if (workbenchCommentSubmit) {
  workbenchCommentSubmit.addEventListener("click", () => {
    submitWorkbenchComment();
  });
}
if (workbenchAddLinkBtn) {
  workbenchAddLinkBtn.addEventListener("click", () => {
    addWorkbenchLinkAsset();
  });
}
if (workbenchAddFileBtn) {
  workbenchAddFileBtn.addEventListener("click", () => {
    addWorkbenchFileAsset();
  });
}
if (memorySearchBtn) {
  memorySearchBtn.addEventListener("click", () => {
    loadMemories(memorySearchInput?.value || "");
  });
}
if (memoryDoctorBtn) {
  memoryDoctorBtn.addEventListener("click", () => {
    runDoctor(7);
  });
}
if (memoryMetricsBtn) {
  memoryMetricsBtn.addEventListener("click", () => {
    showMemoryMetrics(24);
  });
}
if (memoryDoctorCloseBtn) {
  memoryDoctorCloseBtn.addEventListener("click", () => {
    closeDoctorPanel();
  });
}
if (memoryMetricsCloseBtn) {
  memoryMetricsCloseBtn.addEventListener("click", () => {
    closeMemoryMetricsModal();
  });
}
if (memoryCreateBtn) {
  memoryCreateBtn.addEventListener("click", () => {
    openCreateMemoryEditor();
  });
}
if (traceMonitorRefreshBtn) {
  traceMonitorRefreshBtn.addEventListener("click", () => {
    loadTraceMonitorData({ force: true });
  });
}
if (traceMonitorClearHistoryBtn) {
  traceMonitorClearHistoryBtn.addEventListener("click", () => {
    clearAllTraceHistory();
  });
}
if (traceMonitorList) {
  traceMonitorList.addEventListener("scroll", () => {
    if (activePrimaryNavKey !== "trace-monitor" || activeTraceMonitorScope !== "history") return;
    if (traceMonitorHistoryLoading || !traceMonitorHistoryHasMore) return;
    const threshold = 80;
    const distanceToBottom =
      traceMonitorList.scrollHeight - traceMonitorList.scrollTop - traceMonitorList.clientHeight;
    if (distanceToBottom <= threshold) {
      loadMoreTraceHistory();
    }
  });
}
traceMonitorScopeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const scope = btn.getAttribute("data-trace-scope") || "active";
    setTraceMonitorScope(scope);
  });
});
if (memoryRefreshBtn) {
  memoryRefreshBtn.addEventListener("click", () => {
    loadMemories(memorySearchInput?.value || "");
  });
}
if (memorySaveBtn) {
  memorySaveBtn.addEventListener("click", () => {
    saveMemoryEditor();
  });
}
if (memoryCancelBtn) {
  memoryCancelBtn.addEventListener("click", () => {
    closeMemoryEditor();
  });
}
if (memorySearchInput) {
  memorySearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadMemories(memorySearchInput.value || "");
    }
  });
}
if (memoryStatusFilter) {
  memoryStatusFilter.addEventListener("change", () => {
    memoryStatusFilterValue = memoryStatusFilter.value || "all";
    renderMemoryList();
  });
}
if (memoryGcDuplicatesBtn) {
  memoryGcDuplicatesBtn.addEventListener("click", () => {
    runGcByMode("duplicates");
  });
}
if (memoryGcStaleBtn) {
  memoryGcStaleBtn.addEventListener("click", () => {
    runGcByMode("stale");
  });
}
if (memoryModalMask) {
  memoryModalMask.addEventListener("click", () => {
    closeMemoryEditor();
    closeDoctorPanel();
    closeMemoryMetricsModal();
  });
}

sidebarCollapse.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});
if (workbenchSidebarCollapse && workbenchSidebar) {
  workbenchSidebarCollapse.addEventListener("click", () => {
    workbenchSidebar.classList.toggle("collapsed");
  });
}
refreshGroupsBtn.addEventListener("click", () => {
  refreshGroupsBtn.classList.add("spinning");
  setTimeout(() => refreshGroupsBtn.classList.remove("spinning"), 700);
  loadGroups();
  warmWorkflowCreateOptions(true);
  if (currentGroupJid) loadMessages();
});
openSchedulersBtn.addEventListener("click", () => {
  if (schedulersPanel.classList.contains("open")) {
    schedulersPanel.classList.remove("open");
    return;
  }
  openSchedulersPanel();
});
deleteAllSchedulersBtn.addEventListener("click", deleteAllSchedulers);
closeSchedulersBtn.addEventListener("click", () => {
  schedulersPanel.classList.remove("open");
});
openAgentStatusBtn.addEventListener("click", () => {
  if (agentStatusPanel.classList.contains("open")) {
    agentStatusPanel.classList.remove("open");
    if (agentStatusInterval) {
      clearInterval(agentStatusInterval);
      agentStatusInterval = null;
    }
    return;
  }
  openAgentStatusPanel();
});
closeAgentStatusBtn.addEventListener("click", () => {
  agentStatusPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
});
openWorkflowsBtn.addEventListener("click", () => {
  if (workflowsPanel.classList.contains("open")) {
    workflowsPanel.classList.remove("open");
    return;
  }
  openWorkflowsPanel();
});
closeWorkflowsBtn.addEventListener("click", () => {
  workflowsPanel.classList.remove("open");
});
refreshWorkflowsBtn.addEventListener("click", loadWorkflows);
deleteAllWorkflowsBtn.addEventListener("click", deleteAllWorkflows);
sendBtn.addEventListener("click", () => {
  sendMessage(messageInput.value);
});
messageInput.addEventListener("keydown", (e) => {
  // Command palette navigation
  if (commandPalette.classList.contains("visible")) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateCommandPalette(-1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateCommandPalette(1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (cmdPaletteIndex >= 0) {
        e.preventDefault();
        selectCommandPaletteItem();
        return;
      }
    }
    if (e.key === "Escape") {
      hideCommandPalette();
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(messageInput.value);
  }

  // Shift+Enter: insert newline, auto-continue list if current line is a list
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    const ta = messageInput;
    const pos = ta.selectionStart;
    const before = ta.value.substring(0, pos);
    const after = ta.value.substring(pos);
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineContent = before.substring(lineStart);

    const olMatch = lineContent.match(/^(\d+)\.\s/);
    const ulMatch = lineContent.match(/^-\s/);

    if (olMatch) {
      const nextNum = parseInt(olMatch[1]) + 1;
      ta.value = before + "\n" + nextNum + ". " + after;
      ta.selectionStart = ta.selectionEnd = pos + 1 + String(nextNum).length + 2;
      autoResizeInput();
    } else if (ulMatch) {
      ta.value = before + "\n- " + after;
      ta.selectionStart = ta.selectionEnd = pos + 3;
      autoResizeInput();
    } else {
      ta.value = before + "\n" + after;
      ta.selectionStart = ta.selectionEnd = pos + 1;
      autoResizeInput();
    }
  }

  if (e.key === "@") {
    e.preventDefault();
    showMentionPicker();
    return;
  }

  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    showCommandPalette("");
    return;
  }

  // Cmd+Shift+7 = ordered list, Cmd+Shift+8 = unordered list
  if (e.metaKey && e.shiftKey) {
    if (e.key === "7") {
      e.preventDefault();
      insertListPrefix("1. ");
    } else if (e.key === "8") {
      e.preventDefault();
      insertListPrefix("- ");
    }
  }
});

messageInput.addEventListener("input", () => {
  autoResizeInput();
  if (mentionPickerVisible) hideMentionPicker(false);
  // Command palette trigger
  const val = messageInput.value;
  if (val.startsWith("/") && !val.includes(" ")) {
    showCommandPalette(val);
  } else {
    hideCommandPalette();
  }
});

// Reply preview close
replyPreviewClose.addEventListener("click", clearReplyTo);
pendingFilesClose.addEventListener("click", () => {
  pendingFiles = [];
  renderPendingFiles();
});

attachBtn.addEventListener("click", () => {
  fileInput.click();
});
document.getElementById("at-btn").addEventListener("click", () => {
  showMentionPicker();
});

document.addEventListener("mousedown", (e) => {
  if (commandPickerVisible && commandPalette) {
    const target = e.target;
    if (!(commandPalette.contains(target) || (target && target.closest && target.closest("#message-input")))) {
      hideCommandPalette(false);
    }
  }

  if (!mentionPickerVisible || !mentionPicker) return;
  const target = e.target;
  if (mentionPicker.contains(target)) return;
  if (target && target.closest && target.closest("#at-btn")) return;
  hideMentionPicker(false);
});

// Format toolbar - insert list prefix at beginning of current line
function insertListPrefix(prefix) {
  const ta = messageInput;
  const pos = ta.selectionStart;
  const before = ta.value.substring(0, pos);
  const after = ta.value.substring(pos);
  // Find start of current line
  const lineStart = before.lastIndexOf("\n") + 1;
  ta.value = before.substring(0, lineStart) + prefix + before.substring(lineStart) + after;
  ta.selectionStart = ta.selectionEnd = lineStart + prefix.length;
  ta.focus();
  autoResizeInput();
}

document.getElementById("format-toggle-btn").addEventListener("click", () => {
  document.getElementById("format-sub-btns").classList.toggle("hidden");
});
document.getElementById("fmt-ol-btn").addEventListener("click", () => insertListPrefix("1. "));
document.getElementById("fmt-ul-btn").addEventListener("click", () => insertListPrefix("- "));

fileInput.addEventListener("change", () => {
  for (const file of fileInput.files || []) {
    stageFile(file);
  }
  fileInput.value = "";
});
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (currentGroupJid) fileDropZone.classList.remove("hidden");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) fileDropZone.classList.add("hidden");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  fileDropZone.classList.add("hidden");
  if (!currentGroupJid) return;
  for (const file of e.dataTransfer?.files || []) {
    stageFile(file);
  }
});

// Infinite scroll
messagesEl.addEventListener("scroll", () => {
  if (messagesEl.scrollTop < 100 && hasMoreHistory && !loadingHistory) {
    loadMoreHistory();
  }
});

// Multi-select
selectModeBtn.addEventListener("click", toggleMultiSelectMode);
copySelectedBtn.addEventListener("click", copySelectedMessages);
deleteSelectedBtn.addEventListener("click", deleteSelectedMessages);
cancelSelectBtn.addEventListener("click", exitMultiSelect);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mentionPickerVisible) {
    hideMentionPicker();
    return;
  }
  if (e.key === "Escape" && multiSelectMode) {
    exitMultiSelect();
  }
  // Cmd/Ctrl+1 — toggle schedulers
  if ((e.metaKey || e.ctrlKey) && e.key === "1") {
    e.preventDefault();
    if (schedulersPanel.classList.contains("open")) {
      schedulersPanel.classList.remove("open");
    } else {
      openSchedulersPanel();
    }
    return;
  }
  // Cmd/Ctrl+2 — toggle agent status
  if ((e.metaKey || e.ctrlKey) && e.key === "2") {
    e.preventDefault();
    if (agentStatusPanel.classList.contains("open")) {
      agentStatusPanel.classList.remove("open");
      if (agentStatusInterval) {
        clearInterval(agentStatusInterval);
        agentStatusInterval = null;
      }
    } else {
      openAgentStatusPanel();
    }
    return;
  }
  // Cmd/Ctrl+3 — toggle workflows
  if ((e.metaKey || e.ctrlKey) && e.key === "3") {
    e.preventDefault();
    if (workflowsPanel.classList.contains("open")) {
      workflowsPanel.classList.remove("open");
    } else {
      openWorkflowsPanel();
    }
  }
});

//# sourceMappingURL=app.js.map
