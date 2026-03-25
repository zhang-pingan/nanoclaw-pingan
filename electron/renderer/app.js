// electron/renderer/app.js
var ws = null;
var reconnectTimer = null;
var currentGroupJid = "";
var groups = [];
var messages = [];
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
var clearChatBtn = document.getElementById("clear-chat");
var messagesEl = document.getElementById("messages");
var messagesEmpty = document.getElementById("messages-empty");
var typingIndicator = document.getElementById("typing-indicator");
var inputArea = document.getElementById("input-area");
var messageInput = document.getElementById("message-input");
var sendBtn = document.getElementById("send-btn");
var attachBtn = document.getElementById("attach-btn");
var fileInput = document.getElementById("file-input");
var fileDropZone = document.getElementById("file-drop-zone");
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
    el.innerHTML = `
      <span class="item-name">${escapeHtml(group.name)}</span>
      ${group.isMain ? '<span class="item-badge">main</span>' : ""}
    `;
    el.addEventListener("click", () => selectGroup(group.jid));
    groupsList.appendChild(el);
  }
}
function renderMessages() {
  if (messages.length === 0) {
    messagesEmpty.style.display = "flex";
    const existing2 = messagesEl.querySelectorAll(".message");
    existing2.forEach((el) => el.remove());
    return;
  }
  messagesEmpty.style.display = "none";
  const existing = messagesEl.querySelectorAll(".message");
  existing.forEach((el) => el.remove());
  for (const msg of messages) {
    const div = document.createElement("div");
    const isUser = msg.is_from_me;
    const isSystem = msg.sender === "system";
    if (isSystem) {
      div.className = "message system";
      div.textContent = msg.content;
    } else {
      div.className = `message ${isUser ? "user" : "assistant"}`;
      const renderedContent = isUser ? escapeHtml(msg.content) : renderMarkdown(msg.content);
      div.innerHTML = `
        ${msg.sender_name ? `<span class="msg-sender">${escapeHtml(msg.sender_name)}</span>` : ""}
        <div class="msg-content">${renderedContent}</div>
        <span class="msg-time">${formatTime(msg.timestamp)}</span>
      `;
    }
    messagesEl.appendChild(div);
  }
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
      el.textContent = "No active tasks";
      tasksList.appendChild(el);
      return;
    }
    for (const task of data.tasks.slice(0, 10)) {
      const el = document.createElement("div");
      el.className = "list-item";
      el.title = task.prompt;
      el.innerHTML = `<span class="item-name">${escapeHtml(task.prompt.slice(0, 40))}${task.prompt.length > 40 ? "\u2026" : ""}</span>`;
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
    renderMessages();
  } catch (err) {
    console.error("Failed to load messages:", err);
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
        is_bot_message: msg.is_bot_message || false
      };
      if (incoming.chat_jid === currentGroupJid) {
        messages.push(incoming);
        renderMessages();
      }
      if (incoming.chat_jid !== currentGroupJid && !incoming.is_from_me) {
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
  renderMessages();
  updateChatHeader();
  renderGroups();
  await loadMessages();
  await loadTasks();
  sendWs({ type: "select_group", chatJid: jid });
}
async function sendMessage(content) {
  if (!content.trim() || !currentGroupJid) return;
  sendWs({ type: "message", chatJid: currentGroupJid, content: content.trim() });
  const userMsg = {
    id: `opt_${Date.now()}`,
    chat_jid: currentGroupJid,
    sender: "me",
    sender_name: "You",
    content: content.trim(),
    timestamp: Date.now().toString(),
    is_from_me: true,
    is_bot_message: false
  };
  messages.push(userMsg);
  renderMessages();
  messageInput.value = "";
  autoResizeInput();
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
// Auto-start on page load
connectWS();
loadGroups();

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
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(messageInput.value);
  }
});
messageInput.addEventListener("input", autoResizeInput);
attachBtn.addEventListener("click", () => {
  fileInput.click();
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
clearChatBtn.addEventListener("click", () => {
  messages = [];
  renderMessages();
});
mainScreen.addEventListener("transitionend", () => {
  if (!mainScreen.classList.contains("hidden")) {
    messageInput.focus();
  }
});

//# sourceMappingURL=app.js.map
