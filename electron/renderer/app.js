// electron/renderer/app.js
var ws = null;
var reconnectTimer = null;
var currentGroupJid = "";
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

var mainScreen = document.getElementById("main-screen");
var workspace = document.getElementById("workspace");
var memoryManagementScreen = document.getElementById("memory-management-screen");
var memoryGroupsList = document.getElementById("memory-groups-list");
var memoryGroupTitle = document.getElementById("memory-group-title");
var memoryGroupFolder = document.getElementById("memory-group-folder");
var memoryGroupSummary = document.getElementById("memory-group-summary");
var memorySearchInput = document.getElementById("memory-search-input");
var memoryStatusFilter = document.getElementById("memory-status-filter");
var memoryDoctorBtn = document.getElementById("memory-doctor-btn");
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
var memoryDuplicatesList = document.getElementById("memory-duplicates-list");
var memoryStaleList = document.getElementById("memory-stale-list");
var memoryConflictsList = document.getElementById("memory-conflicts-list");
var memoryGcDuplicatesBtn = document.getElementById("memory-gc-duplicates-btn");
var memoryGcStaleBtn = document.getElementById("memory-gc-stale-btn");
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
var workflowsPanel = document.getElementById("workflows-panel");
var workflowsList = document.getElementById("workflows-list");
var openWorkflowsBtn = document.getElementById("open-workflows");
var closeWorkflowsBtn = document.getElementById("close-workflows");
var refreshWorkflowsBtn = document.getElementById("refresh-workflows");
var deleteAllWorkflowsBtn = document.getElementById("delete-all-workflows");
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
var activePrimaryNavKey = "agent-groups";
var activeMemoryGroupJid = "";
var memoryEntries = [];
var memoryQueryText = "";
var memoryRequestSeq = 0;
var editingMemoryId = "";
var memoryStatusFilterValue = "all";
var memoryDoctorReport = null;
var memoryDoctorMap = {};
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

// --- Command palette definitions ---
var commands = [
  { name: "/clear", desc: "Clear conversation context" },
  { name: "/compact", desc: "Compact conversation history" },
  { name: "/create-workflow", desc: "Create workflow with guided selections" },
];

function apiFetch(path, options) {
  const headers = { "Content-Type": "application/json" };
  return fetch(`http://localhost:3000${path}`, { ...options, headers });
}

function formatTime(ts) {
  const d = new Date(parseInt(ts));
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// --- SVG Icon helpers ---
const SVG = {
  trash: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>',
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
      button.addEventListener("click", () => sendCardAction(btn.value, msgId));
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
          button.addEventListener("click", () => sendCardAction(btn.value, msgId));
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

    const formInputs = {};
    for (const input of card.form.inputs) {
      const inputEl = document.createElement("input");
      inputEl.className = "card-input";
      inputEl.name = input.name;
      inputEl.placeholder = input.placeholder || "";
      formInputs[input.name] = inputEl;
      formEl.appendChild(inputEl);
    }

    const submitBtn = document.createElement("button");
    submitBtn.className = `card-btn card-btn-${card.form.submitButton.type || "default"}`;
    submitBtn.textContent = card.form.submitButton.label;
    submitBtn.addEventListener("click", () => {
      const formValue = {};
      for (const [name, el] of Object.entries(formInputs)) {
        formValue[name] = el.value;
      }
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

// --- Create single message element (factory) ---
function createMessageEl(msg) {
  // Card messages get special rendering
  if (isCardMessage(msg)) {
    const card = parseCardContent(msg);
    if (card) {
      const wrapper = document.createElement("div");
      wrapper.className = "message assistant";
      wrapper.setAttribute("data-msg-id", msg.id);
      wrapper.setAttribute("data-timestamp", msg.timestamp);
      wrapper.appendChild(renderCardElement(card, msg.id));
      return wrapper;
    }
  }

  // File messages: render with "打开文件" button
  if (msg._filePath) {
    const div = document.createElement("div");
    div.className = "message assistant";
    div.setAttribute("data-msg-id", msg.id);
    div.setAttribute("data-timestamp", msg.timestamp);

    const openBtn = document.createElement("button");
    openBtn.className = "file-open-btn";
    openBtn.innerHTML = `${SVG.paperclip} ${escapeHtml(msg.content)}`;
    openBtn.addEventListener("click", () => {
      if (window.nanoclawApp?.openFile) {
        window.nanoclawApp.openFile(msg._filePath);
      } else {
        window.open(`file://${msg._filePath}`);
      }
    });

    div.appendChild(openBtn);
    return div;
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

  const senderInitial = (msg.sender_name || msg.sender || "?")[0].toUpperCase();
  const senderColor = isUser ? "#2563eb" : "#7c3aed";

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
    <div class="msg-avatar" style="background:${senderColor}">${senderInitial}</div>
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
      messages = data.messages;
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
  const showWorkspace = navKey === "agent-groups";
  const showMemoryManagement = navKey === "memory-management";
  if (workspace) {
    workspace.classList.toggle("active", showWorkspace);
  }
  if (memoryManagementScreen) {
    memoryManagementScreen.classList.toggle("active", showMemoryManagement);
  }
  if (showMemoryManagement) {
    renderDoctorPanel();
    renderMemoryList();
    loadMemories();
  }

  if (!showWorkspace) {
    schedulersPanel.classList.remove("open");
    agentStatusPanel.classList.remove("open");
    workflowsPanel.classList.remove("open");
    if (agentStatusInterval) {
      clearInterval(agentStatusInterval);
      agentStatusInterval = null;
    }
  }
}

function renderGroups() {
  groupsList.innerHTML = "";
  for (const group of groups) {
    const el = document.createElement("div");
    el.className = `list-item${group.jid === currentGroupJid ? " active" : ""}`;

    // First letter avatar icon
    const initial = (group.name || "?")[0].toUpperCase();
    const unread = unreadCounts[group.jid] || 0;

    el.innerHTML = `
      <span class="item-icon">${escapeHtml(initial)}</span>
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
  memoryDoctorReport = null;
  memoryDoctorMap = {};
  renderDoctorPanel();
  setDoctorLog("");
  renderMemoryGroups();
  updateMemoryGroupHeader();
  loadMemories();
}

function renderMemoryGroups() {
  if (!memoryGroupsList) return;
  memoryGroupsList.innerHTML = "";
  for (const group of groups) {
    const el = document.createElement("div");
    el.className = `list-item${group.jid === activeMemoryGroupJid ? " active" : ""}`;
    const initial = (group.name || "?")[0].toUpperCase();
    el.innerHTML = `
      <span class="item-icon">${escapeHtml(initial)}</span>
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ""}
    `;
    el.addEventListener("click", () => selectMemoryGroup(group.jid));
    memoryGroupsList.appendChild(el);
  }
}

function formatDateTime(ts) {
  const ms = Number(ts);
  if (Number.isNaN(ms)) return "--";
  return new Date(ms).toLocaleString();
}

function getActiveMemoryGroup() {
  return groups.find((g) => g.jid === activeMemoryGroupJid) || null;
}

function closeMemoryEditor() {
  editingMemoryId = "";
  if (memoryEditor) memoryEditor.classList.add("hidden");
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

function renderDoctorPanel() {
  if (!memoryDoctorPanel || !memoryDoctorSummary || !memoryDuplicatesList || !memoryStaleList || !memoryConflictsList) return;
  if (!memoryDoctorReport) {
    memoryDoctorPanel.classList.add("hidden");
    return;
  }
  memoryDoctorPanel.classList.remove("hidden");
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
          const keepId = (prompt(`输入 keep_id（候选：${allowed.join(", ")}）`, keepDefaultId) || "").trim();
          const deprecateId = (prompt(`输入 deprecate_id（候选：${allowed.join(", ")}）`, depDefaultId) || "").trim();
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
          const raw = (prompt(`输入两个 merge_ids（逗号分隔，候选：${allowed.join(", ")}）`) || "").trim();
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
          const mergedContent = (prompt("输入 merged_content") || "").trim();
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
  if (memoryEditor) memoryEditor.classList.remove("hidden");
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
  if (memoryEditor) memoryEditor.classList.remove("hidden");
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
    const statusLabel = agent.isIdle ? "idle" : "active";
    const typeLabel = agent.isTask ? "task" : "chat";

    const el = document.createElement("div");
    el.className = "agent-status-item";
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
      <div class="agent-status-meta">
        <span class="agent-status-duration">${formatDuration(elapsed)}</span>
        <span class="agent-status-type">${typeLabel}</span>
        ${agent.pendingTaskCount > 0 ? `<span class="agent-status-pending">${agent.pendingTaskCount} pending</span>` : ""}
        ${agent.isTask && agent.runningTaskId ? `<span class="agent-status-task-id">${escapeHtml(agent.runningTaskId.slice(0, 8))}…</span>` : ""}
      </div>
    `;
    agentStatusList.appendChild(el);
  }
}

async function loadAgentStatus() {
  try {
    const res = await apiFetch("/api/agent-status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAgentStatus(data.agents || []);
  } catch (err) {
    console.error("Failed to load agent status:", err);
    agentStatusList.innerHTML = `<div class="agent-status-empty">Failed to load</div>`;
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

async function loadMessages() {
  if (!currentGroupJid) return;
  const since = "0";
  try {
    const res = await apiFetch(`/api/messages?jid=${encodeURIComponent(currentGroupJid)}&since=${since}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    messages = data.messages;
    hasMoreHistory = messages.length >= 200;
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
    messages = [...data.messages, ...messages];
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
function handleWsMessage(msg) {
  switch (msg.type) {
    case "connected":
      console.log("WS connected:", msg.message);
      break;
    case "groups":
      groups = msg.groups || [];
      renderGroups();
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
        appendSingleMessage(incoming);
        if (!incoming.is_from_me) {
          scheduleModelSync();
        }
      } else if (!incoming.is_from_me) {
        // Increment unread count
        unreadCounts[incoming.chat_jid] = (unreadCounts[incoming.chat_jid] || 0) + 1;
        renderGroups();
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
        appendSingleMessage(cardMsg);
      }
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
        appendSingleMessage(fileMsg);
      } else {
        unreadCounts[fileMsg.chat_jid] = (unreadCounts[fileMsg.chat_jid] || 0) + 1;
        renderGroups();
        notifyAgent(fileMsg);
      }
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
    window.nanoclawApp.notify(title, body);
  }
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
  appendSingleMessage(userMsg);
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
  commandSearchInput.placeholder = "搜索命令，如 create-workflow";
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
  if (cmd.name === "/create-workflow") {
    if (!isCurrentGroupMain()) {
      alert("仅主群支持 /create-workflow。请切换到主群后再试。");
      return;
    }
    await launchCreateWorkflowWizard();
    return;
  }
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
    console.error("Failed to prefetch workflow create options:", err);
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

function closeWorkflowWizard() {
  const el = document.getElementById("workflow-wizard-overlay");
  if (el) el.remove();
}

function openWorkflowWizard(optionsData) {
  closeWorkflowWizard();

  const workflowTypes = Array.isArray(optionsData.workflow_types) ? optionsData.workflow_types : [];
  const services = Array.isArray(optionsData.services) ? optionsData.services : [];
  const requirementsByService = optionsData.requirements_by_service || {};

  if (workflowTypes.length === 0) {
    alert("没有可用的流程类型");
    return;
  }
  if (services.length === 0) {
    alert("没有可用的服务（groups/global/services.json 为空或缺失）");
    return;
  }

  const state = {
    workflowType: workflowTypes[0].type,
    entryPoint: "",
    service: services[0],
    requirementMode: "preset",
    requirementPreset: "",
    requirementCustom: "",
    requirementSearch: "",
  };

  const overlay = document.createElement("div");
  overlay.id = "workflow-wizard-overlay";
  overlay.className = "workflow-wizard-overlay";
  overlay.innerHTML = `
    <div class="workflow-wizard-modal">
      <div class="workflow-wizard-header">
        <div class="workflow-wizard-title">创建工作流</div>
        <button type="button" class="icon-btn" id="workflow-wizard-close" title="关闭">×</button>
      </div>
      <div class="workflow-wizard-body">
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">1. 流程类型</div>
          <div id="wf-type-options" class="workflow-wizard-options"></div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">2. 入口点</div>
          <div id="wf-entry-options" class="workflow-wizard-options"></div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">3. 服务名称</div>
          <div id="wf-service-options" class="workflow-wizard-options"></div>
        </div>
        <div class="workflow-wizard-section">
          <div class="workflow-wizard-label">4. 需求名称</div>
          <div id="wf-requirement-mode" class="workflow-wizard-options compact"></div>
          <div id="wf-requirement-preset-wrap" class="workflow-wizard-subsection"></div>
          <div id="wf-requirement-custom-wrap" class="workflow-wizard-subsection"></div>
          <div id="wf-requirement-deliverable-hint" class="workflow-wizard-hint"></div>
        </div>
      </div>
      <div class="workflow-wizard-footer">
        <button type="button" id="wf-cancel-btn" class="btn-ghost">取消</button>
        <button type="button" id="wf-submit-btn" class="btn-primary">发送创建命令</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const typeOptionsEl = overlay.querySelector("#wf-type-options");
  const entryOptionsEl = overlay.querySelector("#wf-entry-options");
  const serviceOptionsEl = overlay.querySelector("#wf-service-options");
  const reqModeEl = overlay.querySelector("#wf-requirement-mode");
  const reqPresetWrapEl = overlay.querySelector("#wf-requirement-preset-wrap");
  const reqCustomWrapEl = overlay.querySelector("#wf-requirement-custom-wrap");
  const reqDeliverableHintEl = overlay.querySelector("#wf-requirement-deliverable-hint");
  const submitBtn = overlay.querySelector("#wf-submit-btn");

  function getSelectedWorkflowType() {
    return workflowTypes.find((t) => t.type === state.workflowType) || workflowTypes[0];
  }

  function getEntryPoints() {
    const wt = getSelectedWorkflowType();
    return Array.isArray(wt.entry_points) ? wt.entry_points : [];
  }

  function getRequirements() {
    const rows = requirementsByService[state.service];
    return Array.isArray(rows) ? rows : [];
  }

  function getRequirementName() {
    if (state.workflowType === "dev_test") {
      if (state.entryPoint === "plan") return state.requirementCustom.trim();
      return state.requirementPreset;
    }
    return state.requirementMode === "custom"
      ? state.requirementCustom.trim()
      : state.requirementPreset;
  }

  function getRequirementDeliverables(reqName) {
    const req = getRequirements().find((r) => r.requirement_name === reqName);
    return Array.isArray(req?.deliverables) ? req.deliverables : [];
  }

  function stripRequirementDatePrefix(name) {
    return (name || "").replace(/^\d{4}-\d{2}-\d{2}_/, "").trim();
  }

  function isDeliverableRequired() {
    const wt = getSelectedWorkflowType();
    return !!wt.entry_points_detail?.[state.entryPoint]?.requires_deliverable;
  }

  function getRequiredDeliverableFile() {
    const wt = getSelectedWorkflowType();
    const detail = wt.entry_points_detail?.[state.entryPoint];
    if (!detail?.requires_deliverable) return "";
    const role = detail.deliverable_role || "dev";
    return `${role}.md`;
  }

  function updateRequirementValidation() {
    const reqs = getRequirements();
    const isDevTest = state.workflowType === "dev_test";
    const isPlanEntry = state.entryPoint === "plan";
    const planNameDuplicate =
      isDevTest &&
      isPlanEntry &&
      !!state.requirementCustom.trim() &&
      reqs.some((r) => stripRequirementDatePrefix(r.requirement_name) === stripRequirementDatePrefix(state.requirementCustom));

    const required = isDeliverableRequired();
    const requirementName = getRequirementName();
    const deliverableFiles = getRequirementDeliverables(requirementName);
    const requiredFile = getRequiredDeliverableFile();
    const deliverableOk = !required || deliverableFiles.includes(requiredFile);

    if (planNameDuplicate) {
      reqDeliverableHintEl.textContent = `需求名称重复：已存在同名需求（按去前缀后比较）`;
    } else if (required) {
      reqDeliverableHintEl.textContent = deliverableOk
        ? `已校验必需交付物文件：${requiredFile}`
        : `当前入口点要求交付物文件 ${requiredFile}，但该需求目录下未找到`;
    } else {
      reqDeliverableHintEl.textContent = "";
    }

    const canSubmit =
      !!state.workflowType &&
      !!state.entryPoint &&
      !!state.service &&
      !!requirementName &&
      deliverableOk &&
      !planNameDuplicate;
    submitBtn.disabled = !canSubmit;
  }

  function refresh() {
    renderSingleOptions(
      typeOptionsEl,
      workflowTypes.map((t) => ({ value: t.type, label: `${t.type} (${t.name})` })),
      state.workflowType,
      (v) => {
        state.workflowType = v;
        const eps = getEntryPoints();
        state.entryPoint = eps[0] || "";
        refresh();
      }
    );

    const eps = getEntryPoints();
    if (!state.entryPoint || !eps.includes(state.entryPoint)) {
      state.entryPoint = eps[0] || "";
    }
    renderSingleOptions(
      entryOptionsEl,
      eps.map((ep) => ({
        value: ep,
        label: getSelectedWorkflowType().entry_points_detail?.[ep]?.requires_deliverable ? `${ep} (需要交付物)` : ep,
      })),
      state.entryPoint,
      (v) => {
        state.entryPoint = v;
        refresh();
      }
    );

    renderSingleOptions(
      serviceOptionsEl,
      services.map((s) => ({ value: s, label: s })),
      state.service,
      (v) => {
        state.service = v;
        const reqs = getRequirements();
        state.requirementPreset = reqs[0]?.requirement_name || "";
        refresh();
      }
    );

    const reqs = getRequirements();
    if (!state.requirementPreset && reqs.length > 0) {
      state.requirementPreset = reqs[0].requirement_name;
    }
    const isDevTest = state.workflowType === "dev_test";
    const isPlanEntry = state.entryPoint === "plan";

    reqModeEl.innerHTML = "";
    reqPresetWrapEl.innerHTML = "";
    reqCustomWrapEl.innerHTML = "";

    if (isDevTest) {
      if (isPlanEntry) {
        const input = document.createElement("input");
        input.className = "workflow-wizard-input";
        input.placeholder = "输入需求名称";
        input.value = state.requirementCustom;
        input.addEventListener("input", () => {
          state.requirementCustom = input.value;
          updateRequirementValidation();
        });
        reqCustomWrapEl.appendChild(input);
      } else {
        const search = document.createElement("input");
        search.className = "workflow-wizard-input";
        search.placeholder = "搜索需求名称";
        search.value = state.requirementSearch;
        search.addEventListener("input", () => {
          state.requirementSearch = search.value;
          refresh();
        });
        reqModeEl.appendChild(search);

        const filteredReqs = reqs.filter((r) =>
          !state.requirementSearch || r.requirement_name.includes(state.requirementSearch.trim()),
        );
        const opts = document.createElement("div");
        opts.className = "workflow-wizard-options";
        reqPresetWrapEl.appendChild(opts);
        renderSingleOptions(
          opts,
          filteredReqs.map((r) => ({ value: r.requirement_name, label: r.requirement_name })),
          state.requirementPreset,
          (v) => {
            state.requirementPreset = v;
            refresh();
          }
        );
      }
    } else {
      renderSingleOptions(
        reqModeEl,
        [
          { value: "preset", label: "已有需求" },
          { value: "custom", label: "自定义需求" },
        ],
        state.requirementMode,
        (v) => {
          state.requirementMode = v;
          refresh();
        }
      );

      if (state.requirementMode === "preset") {
        const opts = document.createElement("div");
        opts.className = "workflow-wizard-options";
        reqPresetWrapEl.appendChild(opts);
        renderSingleOptions(
          opts,
          reqs.map((r) => ({ value: r.requirement_name, label: r.requirement_name })),
          state.requirementPreset,
          (v) => {
            state.requirementPreset = v;
            refresh();
          }
        );
      }

      if (state.requirementMode === "custom") {
        const input = document.createElement("input");
        input.className = "workflow-wizard-input";
        input.placeholder = "输入需求名称";
        input.value = state.requirementCustom;
        input.addEventListener("input", () => {
          state.requirementCustom = input.value;
          refresh();
        });
        reqCustomWrapEl.appendChild(input);
      }
    }

    updateRequirementValidation();
  }

  overlay.querySelector("#workflow-wizard-close").addEventListener("click", closeWorkflowWizard);
  overlay.querySelector("#wf-cancel-btn").addEventListener("click", closeWorkflowWizard);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeWorkflowWizard();
  });

  overlay.querySelector("#wf-submit-btn").addEventListener("click", async () => {
    const requirementName = getRequirementName();
    const required = isDeliverableRequired();
    if (!requirementName) return;
    const reqs = getRequirements();
    const planNameDuplicate =
      state.workflowType === "dev_test" &&
      state.entryPoint === "plan" &&
      reqs.some((r) => stripRequirementDatePrefix(r.requirement_name) === stripRequirementDatePrefix(requirementName));
    if (planNameDuplicate) {
      alert("需求名称重复：已存在同名需求（按去时间前缀后比较），无法创建流程。");
      return;
    }
    const requiredFile = getRequiredDeliverableFile();
    const deliverableFiles = getRequirementDeliverables(requirementName);
    if (required && !deliverableFiles.includes(requiredFile)) {
      alert(`当前入口点要求交付物文件 ${requiredFile}，但所选需求目录下未找到，无法创建流程。`);
      return;
    }

    const data = {
      name: requirementName,
      service: state.service,
      workflow_type: state.workflowType,
      start_from: state.entryPoint,
    };
    if (required) {
      data.deliverable = requirementName;
    }

    const content = JSON.stringify({
      command: "/create-workflow",
      data,
    });

    await sendMessage(content);
    closeWorkflowWizard();
  });

  // init defaults
  const initReqs = getRequirements();
  state.requirementPreset = initReqs[0]?.requirement_name || "";
  state.entryPoint = getEntryPoints()[0] || "";
  refresh();
}

async function launchCreateWorkflowWizard() {
  if (!currentGroupJid) {
    alert("请先选择一个群聊");
    return;
  }
  if (!isCurrentGroupMain()) {
    alert("仅主群支持 /create-workflow。请切换到主群后再试。");
    return;
  }
  try {
    const optionsData = await loadWorkflowCreateOptions();
    openWorkflowWizard(optionsData);
  } catch (err) {
    console.error("Failed to load workflow create options:", err);
    alert("加载创建流程选项失败");
  }
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
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.textContent = "\u5DF2\u590D\u5236";
    document.body.appendChild(toast);
  }
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

// Auto-start on page load
connectWS();
loadGroups();
warmWorkflowCreateOptions();

// --- Event listeners ---
if (primaryNav) {
  setPrimaryNav(activePrimaryNavKey);
}
primaryNavItems.forEach((item) => {
  item.addEventListener("click", () => {
    const navKey = item.getAttribute("data-nav-key") || "";
    setPrimaryNav(navKey);
  });
});
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
if (memoryCreateBtn) {
  memoryCreateBtn.addEventListener("click", () => {
    openCreateMemoryEditor();
  });
}
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

sidebarCollapse.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});
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
  // Close other panels first
  agentStatusPanel.classList.remove("open");
  workflowsPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
  schedulersPanel.classList.add("open");
  loadSchedulers();
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
  // Close other panels first
  schedulersPanel.classList.remove("open");
  workflowsPanel.classList.remove("open");
  agentStatusPanel.classList.add("open");
  loadAgentStatus();
  // Update durations every second
  if (agentStatusInterval) clearInterval(agentStatusInterval);
  agentStatusInterval = setInterval(updateAgentDurations, 1000);
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
  // Close other panels first
  schedulersPanel.classList.remove("open");
  agentStatusPanel.classList.remove("open");
  if (agentStatusInterval) {
    clearInterval(agentStatusInterval);
    agentStatusInterval = null;
  }
  workflowsPanel.classList.add("open");
  loadWorkflows();
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
  // Cmd/Ctrl+1 — toggle agent status
  if ((e.metaKey || e.ctrlKey) && e.key === "1") {
    if (agentStatusPanel.classList.contains("open")) {
      agentStatusPanel.classList.remove("open");
      if (agentStatusInterval) clearInterval(agentStatusInterval);
    } else {
      schedulersPanel.classList.remove("open");
      workflowsPanel.classList.remove("open");
      agentStatusPanel.classList.add("open");
      loadAgentStatus();
      if (agentStatusInterval) clearInterval(agentStatusInterval);
      agentStatusInterval = setInterval(updateAgentDurations, 1000);
    }
  }
});

//# sourceMappingURL=app.js.map
