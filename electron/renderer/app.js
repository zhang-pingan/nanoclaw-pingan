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

var mainScreen = document.getElementById("main-screen");
var sidebar = document.getElementById("sidebar");
var sidebarCollapse = document.getElementById("sidebar-collapse");
var groupsList = document.getElementById("groups-list");
var tasksList = document.getElementById("tasks-list");
var refreshGroupsBtn = document.getElementById("refresh-groups");
var connectionStatus = document.getElementById("connection-status");
var chatHeader = document.getElementById("chat-header");
var chatGroupName = document.getElementById("chat-group-name");
var chatGroupFolder = document.getElementById("chat-group-folder");
var popoutBtn = document.getElementById("popout-btn");
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
var commandPalette = document.getElementById("command-palette");

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
  const match = content.match(/\u{1F4CE}\s*Uploaded:\s*(.+)/u);
  if (!match) return null;
  const filename = match[1].trim();
  const ext = filename.split(".").pop().toLowerCase();
  return { filename, ext };
}

function renderFilePreview(filename, ext, groupFolder) {
  const uploadPath = `/api/uploads/${encodeURIComponent(groupFolder)}/${encodeURIComponent(filename)}`;
  const div = document.createElement("div");
  div.className = "file-preview";

  if (IMAGE_EXTS.includes(ext)) {
    const img = document.createElement("img");
    img.className = "file-preview-image";
    img.src = `http://localhost:3000${uploadPath}`;
    img.alt = filename;
    img.addEventListener("click", () => openLightbox(img.src));
    div.appendChild(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "file-preview-icon";
    icon.textContent = PDF_EXTS.includes(ext) ? "\u{1F4C4}" : "\u{1F4C1}";
    div.appendChild(icon);

    const info = document.createElement("div");
    info.className = "file-preview-info";
    const link = document.createElement("a");
    link.className = "file-preview-name";
    link.href = `http://localhost:3000${uploadPath}`;
    link.target = "_blank";
    link.textContent = filename;
    info.appendChild(link);
    div.appendChild(info);
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

// --- Create single message element (factory) ---
function createMessageEl(msg) {
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

  // Check for file upload
  const fileInfo = detectFileUpload(msg.content);
  const groupFolder = currentGroupJid.replace("web:", "");

  div.innerHTML = `
    <div class="msg-actions">
      <button class="msg-reply-btn" title="Reply">\u21A9</button>
    </div>
    ${replyHtml}
    ${msg.sender_name ? `<span class="msg-sender">${escapeHtml(msg.sender_name)}</span>` : ""}
    <div class="msg-content">${renderedContent}</div>
    <span class="msg-time">${formatTime(msg.timestamp)}</span>
  `;

  // Add file preview if detected
  if (fileInfo) {
    const preview = renderFilePreview(fileInfo.filename, fileInfo.ext, groupFolder);
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
async function loadTasks() {
  if (!currentGroupJid) return;
  const folder = currentGroupJid.replace("web:", "");
  try {
    const res = await apiFetch(`/api/tasks?folder=${encodeURIComponent(folder)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tasksList.innerHTML = "";
    if (data.tasks.length === 0) {
      const el = document.createElement("div");
      el.className = "list-item";
      el.style.color = "var(--text-muted)";
      el.style.cursor = "default";
      el.innerHTML = `<span class="item-icon">\u2610</span><span class="item-name">No active tasks</span>`;
      tasksList.appendChild(el);
      return;
    }
    for (const task of data.tasks.slice(0, 10)) {
      const el = document.createElement("div");
      el.className = "list-item";
      el.title = task.prompt;
      el.innerHTML = `<span class="item-icon">\u2610</span><span class="item-name">${escapeHtml(task.prompt.slice(0, 40))}${task.prompt.length > 40 ? "\u2026" : ""}</span>`;
      tasksList.appendChild(el);
    }
  } catch (err) {
    console.error("Failed to load tasks:", err);
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
    case "typing":
      typingIndicator.className = msg.isTyping ? "" : "hidden";
      break;
    case "error":
      console.error("WS error from server:", msg.message);
      showError(`Server error: ${msg.message}`);
      break;
  }
}
function notifyAgent(msg) {
  const group = groups.find((g) => g.jid === msg.chat_jid);
  const title = `${group?.name || "NanoClaw Agent"}`;
  const body = `${msg.sender_name}: ${msg.content.slice(0, 100)}`;
  if (typeof window !== "undefined" && window.nanoclawApp) {
    window.nanoclawApp.notify(title, body);
  }
}
async function selectGroup(jid) {
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
  await loadTasks();
  sendWs({ type: "select_group", chatJid: jid });
}
async function sendMessage(content) {
  if (!content.trim() || !currentGroupJid) return;

  const payload = {
    type: "message",
    chatJid: currentGroupJid,
    content: content.trim()
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
    content: content.trim(),
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

async function uploadFile(file) {
  if (!currentGroupJid) return;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const headers = {};
    const res = await fetch(
      `http://localhost:3000/api/upload?jid=${encodeURIComponent(currentGroupJid)}`,
      { method: "POST", headers, body: formData }
    );
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    const fileRef = `\u{1F4CE} Uploaded: ${data.files[0]?.name || file.name}`;
    await sendMessage(fileRef);
  } catch (err) {
    showError(`Upload failed: ${err}`);
  }
}
function showError(msg) {
  const el = document.createElement("div");
  el.className = "message system";
  el.textContent = `\u26A0 ${msg}`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  setTimeout(() => el.remove(), 5e3);
}
function autoResizeInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
}

// --- Pop-out window mode detection ---
function checkPopoutMode() {
  const params = new URLSearchParams(window.location.search);
  const jid = params.get("jid");
  if (jid) {
    document.body.classList.add("popout-mode");
    // Auto-select the group after loading
    loadGroups().then(() => {
      selectGroup(jid);
    });
  }
}

// Auto-start on page load
connectWS();
loadGroups();
checkPopoutMode();

// --- Event listeners ---

sidebarCollapse.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
  sidebarCollapse.textContent = sidebar.classList.contains("collapsed") ? "\u203A" : "\u2039";
});
refreshGroupsBtn.addEventListener("click", () => {
  loadGroups();
  if (currentGroupJid) loadMessages();
});
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
fileInput.addEventListener("change", () => {
  for (const file of fileInput.files || []) {
    uploadFile(file);
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
    uploadFile(file);
  }
});

// Pop-out button
popoutBtn.addEventListener("click", () => {
  if (!currentGroupJid) return;
  if (typeof window !== "undefined" && window.nanoclawApp && window.nanoclawApp.openGroupWindow) {
    const group = groups.find((g) => g.jid === currentGroupJid);
    window.nanoclawApp.openGroupWindow(currentGroupJid, group?.name || "Chat");
  } else {
    // Fallback: open in browser tab
    window.open(`http://localhost:3000?jid=${encodeURIComponent(currentGroupJid)}`, "_blank");
  }
});

// Infinite scroll
messagesEl.addEventListener("scroll", () => {
  if (messagesEl.scrollTop < 100 && hasMoreHistory && !loadingHistory) {
    loadMoreHistory();
  }
});

mainScreen.addEventListener("transitionend", () => {
  if (!mainScreen.classList.contains("hidden")) {
    messageInput.focus();
  }
});

//# sourceMappingURL=app.js.map
