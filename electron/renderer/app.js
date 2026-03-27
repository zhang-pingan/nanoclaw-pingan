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

var mainScreen = document.getElementById("main-screen");
var sidebar = document.getElementById("sidebar");
var sidebarCollapse = document.getElementById("sidebar-collapse");
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
var selectModeBtn = document.getElementById("select-mode-btn");
var originalSelectIcon = selectModeBtn.innerHTML; // preserve the original 4-square grid icon
var multiSelectBar = document.getElementById("multi-select-bar");
var selectedCountEl = document.getElementById("selected-count");
var copySelectedBtn = document.getElementById("copy-selected-btn");
var cancelSelectBtn = document.getElementById("cancel-select-btn");
var agentStatusInterval = null;
var agentStatusData = [];

// --- Command palette definitions ---
var commands = [
  { name: "/clear", desc: "Clear conversation context" },
  { name: "/compact", desc: "Compact conversation history" },
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
async function loadGroups() {
  try {
    const res = await apiFetch("/api/groups");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    groups = data.groups;
    renderGroups();
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
        reply_to_id: msg.reply_to_id || null
      };
      if (incoming.chat_jid === currentGroupJid) {
        messages.push(incoming);
        appendSingleMessage(incoming);
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
function showCommandPalette(filter) {
  const filtered = commands.filter((c) => c.name.includes(filter.toLowerCase()));
  if (filtered.length === 0) {
    hideCommandPalette();
    return;
  }
  commandPalette.innerHTML = "";
  cmdPaletteIndex = 0;
  filtered.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = `cmd-item${i === 0 ? " active" : ""}`;
    item.innerHTML = `<span class="cmd-item-name">${escapeHtml(cmd.name)}</span><span class="cmd-item-desc">${escapeHtml(cmd.desc)}</span>`;
    item.addEventListener("click", () => {
      messageInput.value = cmd.name + " ";
      hideCommandPalette();
      messageInput.focus();
      autoResizeInput();
    });
    commandPalette.appendChild(item);
  });
  commandPalette.classList.add("visible");
}

function hideCommandPalette() {
  commandPalette.classList.remove("visible");
  cmdPaletteIndex = -1;
}

function navigateCommandPalette(direction) {
  const items = commandPalette.querySelectorAll(".cmd-item");
  if (items.length === 0) return;
  items[cmdPaletteIndex]?.classList.remove("active");
  cmdPaletteIndex = (cmdPaletteIndex + direction + items.length) % items.length;
  items[cmdPaletteIndex]?.classList.add("active");
  items[cmdPaletteIndex]?.scrollIntoView({ block: "nearest" });
}

function selectCommandPaletteItem() {
  const items = commandPalette.querySelectorAll(".cmd-item");
  if (cmdPaletteIndex >= 0 && cmdPaletteIndex < items.length) {
    items[cmdPaletteIndex].click();
  }
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

function autoResizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
}

// Auto-start on page load
connectWS();
loadGroups();

// --- Event listeners ---

sidebarCollapse.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});
refreshGroupsBtn.addEventListener("click", () => {
  refreshGroupsBtn.classList.add("spinning");
  setTimeout(() => refreshGroupsBtn.classList.remove("spinning"), 700);
  loadGroups();
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
    const pos = messageInput.selectionStart;
    const text = "@Andy ";
    messageInput.value = messageInput.value.substring(0, pos) + text + messageInput.value.substring(pos);
    messageInput.selectionStart = messageInput.selectionEnd = pos + text.length;
    autoResizeInput();
    e.preventDefault();
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
  const ta = messageInput;
  const pos = ta.selectionStart;
  ta.value = ta.value.substring(0, pos) + "@Andy " + ta.value.substring(pos);
  ta.selectionStart = ta.selectionEnd = pos + 6;
  ta.focus();
  autoResizeInput();
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
cancelSelectBtn.addEventListener("click", exitMultiSelect);
document.addEventListener("keydown", (e) => {
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
