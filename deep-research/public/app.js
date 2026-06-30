const state = {
  config: null,
  activeConversation: null,
  pollTimer: null,
  conversations: [],
  referencedTaskIds: new Set(),
  contextMenuConversationId: null,
  agentPickerOpen: false,
  activeAgentIndex: 0,
};

const VISIBLE_PROVIDER_IDS = new Set(['gpt-researcher']);

const AGENT_PENDING_MESSAGE_ID = 'local-agent-pending';

const els = {
  providerSelect: document.getElementById('provider-select'),
  modelSelect: document.getElementById('model-select'),
  reportTypePicker: document.getElementById('report-type-picker'),
  reportTypeSelect: document.getElementById('report-type-select'),
  conversationList: document.getElementById('task-list'),
  thread: document.getElementById('thread'),
  emptyState: document.getElementById('empty-state'),
  composer: document.getElementById('composer'),
  promptInput: document.getElementById('prompt-input'),
  sendBtn: document.getElementById('send-btn'),
  newConversationBtn: document.getElementById('new-task-btn'),
  referenceBar: document.getElementById('reference-bar'),
  agentPicker: document.getElementById('agent-picker'),
  agentTriggerBtn: document.getElementById('agent-trigger-btn'),
  viewer: document.getElementById('viewer'),
  viewerTitle: document.getElementById('viewer-title'),
  viewerContent: document.getElementById('viewer-content'),
  closeViewer: document.getElementById('close-viewer'),
  downloadMd: document.getElementById('download-md'),
  downloadPdf: document.getElementById('download-pdf'),
  conversationMenu: document.getElementById('conversation-menu'),
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
      const safeUrl = escapeHtml(url);
      return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a>`;
    });
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listOpen = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listOpen) return;
    html.push('</ul>');
    listOpen = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(trimmed.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html.join('\n');
}

function isTerminal(task) {
  return ['completed', 'failed', 'cancelled', 'incomplete'].includes(task?.status);
}

function isReportReady(task) {
  return task?.status === 'completed' && !!task.output_text;
}

function taskStatusText(task) {
  if (!task) return '';
  if (task.status === 'completed') return '研究完成';
  if (task.status === 'failed') return '研究失败';
  if (task.status === 'cancelled') return '已取消';
  if (task.status === 'incomplete') return '未完整完成';
  if (task.status === 'queued') return '排队中';
  return '研究进行中';
}

function conversationTasks() {
  return Array.isArray(state.activeConversation?.tasks)
    ? state.activeConversation.tasks
    : [];
}

function taskById(id) {
  return conversationTasks().find((task) => task.id === id) || null;
}

function providerConfigs() {
  const providers = Array.isArray(state.config?.providers) ? state.config.providers : [];
  return providers.filter((provider) => VISIBLE_PROVIDER_IDS.has(provider.id));
}

function getProviderConfig(providerId) {
  return (
    providerConfigs().find((provider) => provider.id === providerId) ||
    providerConfigs()[0] ||
    null
  );
}

function agentConfigs() {
  const configuredAgents = Array.isArray(state.config?.agents)
    ? state.config.agents
    : [];
  if (configuredAgents.length > 0) return configuredAgents;
  return [
    {
      id: 'agent',
      mention: '@agent',
      label: '行业分析师',
      description: '检查报告矛盾、补充调研方向、优化下一轮提示词',
      chat_jid: state.config?.agent_chat_jid || 'web:deep-research-analyst',
      configured: !!state.config?.agent_configured,
    },
  ];
}

function isAgentPrompt(prompt) {
  return agentConfigs().some((agent) => {
    const mention = agent.mention || '@agent';
    const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}(?:\\s|$)`, 'i').test(prompt);
  });
}

function syncModelOptions() {
  const provider = getProviderConfig(els.providerSelect.value);
  const models = Array.isArray(provider?.models) ? provider.models : [];
  els.modelSelect.innerHTML = models
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join('');
  els.modelSelect.value = provider?.default_model || models[0] || '';

  const reportTypes = Array.isArray(provider?.report_types) ? provider.report_types : [];
  const showReportType = provider?.id === 'gpt-researcher' && reportTypes.length > 0;
  els.reportTypePicker.hidden = !showReportType;
  if (showReportType) {
    els.reportTypeSelect.innerHTML = reportTypes
      .map(
        (reportType) =>
          `<option value="${escapeHtml(reportType.id)}">${escapeHtml(reportType.label || reportType.id)}</option>`,
      )
      .join('');
    els.reportTypeSelect.value = provider.default_report_type || reportTypes[0]?.id || '';
  } else {
    els.reportTypeSelect.innerHTML = '';
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'request failed');
    error.data = data;
    throw error;
  }
  return data;
}

function resizeComposer() {
  const input = els.promptInput;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function renderConversationList() {
  els.conversationList.innerHTML = state.conversations
    .map((conversation) => {
      const active = state.activeConversation?.id === conversation.id ? ' active' : '';
      const badge = conversation.running_task_count
        ? `<span class="item-badge">${conversation.running_task_count}</span>`
        : '';
      return `<button type="button" class="task-item${active}" data-conversation-id="${escapeHtml(conversation.id)}"><span>${escapeHtml(conversation.title || '研究对话')}</span>${badge}</button>`;
    })
    .join('');

  els.conversationList.querySelectorAll('[data-conversation-id]').forEach((button) => {
    button.addEventListener('click', () => {
      closeConversationMenu();
      loadConversation(button.dataset.conversationId);
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openConversationMenu(
        button.dataset.conversationId,
        event.clientX,
        event.clientY,
      );
    });
  });
}

function openConversationMenu(conversationId, x, y) {
  state.contextMenuConversationId = conversationId;
  els.conversationMenu.hidden = false;
  els.conversationMenu.style.left = '0px';
  els.conversationMenu.style.top = '0px';

  const rect = els.conversationMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  els.conversationMenu.style.left = `${left}px`;
  els.conversationMenu.style.top = `${top}px`;
}

function closeConversationMenu() {
  state.contextMenuConversationId = null;
  els.conversationMenu.hidden = true;
}

function renderAgentPicker() {
  const agents = agentConfigs();
  const activeIndex = Math.min(state.activeAgentIndex, Math.max(agents.length - 1, 0));
  state.activeAgentIndex = activeIndex;
  els.agentPicker.innerHTML = agents
    .map((agent, index) => {
      const active = index === activeIndex ? ' active' : '';
      const configured = agent.configured === false ? '未配置' : agent.chat_jid || '';
      const mention = agent.mention || '@agent';
      return `
        <button
          type="button"
          class="agent-option${active}"
          data-agent-index="${index}"
          data-agent-mention="${escapeHtml(mention)}"
          role="option"
          aria-selected="${index === activeIndex ? 'true' : 'false'}"
        >
          <span class="agent-option-mark">@</span>
          <span class="agent-option-main">
            <strong>${escapeHtml(agent.label || mention)}</strong>
            <span>${escapeHtml(agent.description || configured || mention)}</span>
          </span>
          <span class="agent-option-key">${escapeHtml(configured)}</span>
        </button>
      `;
    })
    .join('');
}

function openAgentPicker() {
  state.agentPickerOpen = true;
  state.activeAgentIndex = 0;
  renderAgentPicker();
  els.agentPicker.hidden = false;
  els.agentTriggerBtn.setAttribute('aria-expanded', 'true');
}

function closeAgentPicker() {
  state.agentPickerOpen = false;
  els.agentPicker.hidden = true;
  els.agentTriggerBtn.setAttribute('aria-expanded', 'false');
}

function selectActiveAgent() {
  const agents = agentConfigs();
  const agent = agents[state.activeAgentIndex] || agents[0];
  if (!agent) return;
  const mention = agent.mention || '@agent';
  let content = els.promptInput.value.trimStart();
  content = content.replace(/^@[^\s]*\s*/i, '').trimStart();
  els.promptInput.value = content ? `${mention} ${content}` : `${mention} `;
  resizeComposer();
  closeAgentPicker();
  els.promptInput.focus();
  els.promptInput.setSelectionRange(
    els.promptInput.value.length,
    els.promptInput.value.length,
  );
}

function moveAgentSelection(delta) {
  const agents = agentConfigs();
  if (agents.length === 0) return;
  state.activeAgentIndex =
    (state.activeAgentIndex + delta + agents.length) % agents.length;
  renderAgentPicker();
}

function renderReferenceBar() {
  const ids = [...state.referencedTaskIds].filter((id) => taskById(id));
  state.referencedTaskIds = new Set(ids);
  els.agentPicker.classList.toggle('with-reference-bar', ids.length > 0);
  if (ids.length === 0) {
    els.referenceBar.hidden = true;
    els.referenceBar.innerHTML = '';
    return;
  }
  els.referenceBar.hidden = false;
  els.referenceBar.innerHTML = ids
    .map((id) => {
      const task = taskById(id);
      return `<button type="button" class="reference-chip" data-remove-reference="${escapeHtml(id)}">${escapeHtml(task?.title || id)} ×</button>`;
    })
    .join('');
  els.referenceBar.querySelectorAll('[data-remove-reference]').forEach((button) => {
    button.addEventListener('click', () => {
      state.referencedTaskIds.delete(button.dataset.removeReference);
      renderReferenceBar();
      renderThread();
    });
  });
}

function renderMessage(message) {
  if (message.kind === 'research_task') {
    const task = taskById(message.task_id);
    return task ? renderTaskBlock(task) : '';
  }
  const isUser = message.role === 'user';
  const refs = Array.isArray(message.referenced_task_ids)
    ? message.referenced_task_ids
        .map((id) => taskById(id)?.title || id)
        .filter(Boolean)
    : [];
  const refHtml = refs.length
    ? `<div class="message-refs">引用：${refs.map(escapeHtml).join('、')}</div>`
    : '';
  const kindClass =
    message.kind === 'agent_error'
      ? ' error-message'
      : message.kind === 'agent_pending'
        ? ' pending-message'
        : '';
  if (isUser) {
    return `<div class="message-row user${kindClass}"><div class="prompt-bubble">${refHtml}<div class="prompt-bubble-content">${escapeHtml(message.content).trim()}</div></div></div>`;
  }
  if (message.kind === 'agent_pending') {
    return `
      <div class="message-row assistant pending-message">
        <div class="agent-bubble">
          ${refHtml}
          <div class="pending-agent-status">
            <span class="pending-dot"></span>
            <span>${escapeHtml(message.content || '正在请求 Agent...')}</span>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="message-row assistant${kindClass}">
      <div class="agent-bubble">
        ${refHtml}
        ${message.kind?.startsWith('agent') ? markdownToHtml(message.content) : escapeHtml(message.content)}
      </div>
    </div>
  `;
}

function renderProgress(task) {
  const provider = task.provider_label || task.provider || 'Deep Research';
  const meta = `${provider} · ${taskStatusText(task)} · ${task.stats?.search_count || 0} 个搜索 · ${task.stats?.source_count || 0} 个引用`;
  const steps = Array.isArray(task.progress) ? task.progress : [];
  const error = task.error?.message || task.error?.error?.message || '';
  return `
    <div class="research-meta">${escapeHtml(meta)}</div>
    <section class="progress-card">
      <h2 class="progress-title">${escapeHtml(task.title || 'Deep Research')}</h2>
      ${
        error
          ? `<div class="error-box">${escapeHtml(error)}</div>`
          : `<div class="progress-list">
              ${steps
                .map(
                  (step) => `
                <div class="progress-step ${escapeHtml(step.status || 'pending')}">
                  <span class="step-dot"></span>
                  <div>
                    <strong>${escapeHtml(step.label || '')}</strong>
                    <span>${escapeHtml(step.detail || '')}</span>
                  </div>
                </div>
              `,
                )
                .join('')}
            </div>`
      }
      ${
        !isTerminal(task)
          ? `<div class="progress-actions"><button type="button" class="secondary-btn" data-cancel-task="${escapeHtml(task.id)}">取消</button></div>`
          : ''
      }
    </section>
  `;
}

function renderDocCard(task) {
  const reportType =
    task.provider === 'gpt-researcher' && task.gpt_researcher_report_type
      ? task.gpt_researcher_report_type
      : task.model;
  const referenced = state.referencedTaskIds.has(task.id);
  const openButton =
    isReportReady(task)
      ? `<button type="button" class="icon-btn" data-open-doc="${escapeHtml(task.id)}">全屏</button>`
      : '';
  const exports =
    isReportReady(task)
      ? `<a class="icon-link" href="/api/research/${encodeURIComponent(task.id)}/export/markdown" download>MD</a>
         <a class="icon-link" href="/api/research/${encodeURIComponent(task.id)}/export/pdf" target="_blank" rel="noreferrer">PDF</a>`
      : '';
  return `
    <section class="doc-card">
      <div class="doc-card-top">
        <div class="doc-title">
          <span class="doc-icon">□</span>
          <span>${escapeHtml(task.title || 'Deep Research Report')}</span>
        </div>
        <div class="doc-actions">
          <button type="button" class="icon-btn${referenced ? ' selected' : ''}" data-reference-task="${escapeHtml(task.id)}">${referenced ? '已引用' : '引用'}</button>
          ${exports}
          ${openButton}
        </div>
      </div>
      <div class="doc-preview">
        <h2>${escapeHtml(task.title || 'Deep Research Report')}</h2>
        <div class="doc-stats">
          <span>${escapeHtml(task.provider_label || task.provider || 'Provider')}</span>
          <span>${escapeHtml(reportType)}</span>
          <span>${escapeHtml(taskStatusText(task))}</span>
          <span>${task.stats?.source_count || 0} 个来源</span>
          <span>${task.usage?.total_tokens || '--'} tokens</span>
        </div>
      </div>
    </section>
  `;
}

function renderTaskBlock(task) {
  const docCard = isReportReady(task)
    ? `<div style="height: 18px"></div>${renderDocCard(task)}`
    : '';
  return `
    <div class="task-block" id="task-${escapeHtml(task.id)}">
      ${renderProgress(task)}
      ${docCard}
    </div>
  `;
}

function renderThread() {
  const conversation = state.activeConversation;
  els.emptyState.hidden = !!conversation;
  if (!conversation) {
    els.thread.innerHTML = '';
    els.thread.appendChild(els.emptyState);
    renderReferenceBar();
    return;
  }

  const messagesHtml = Array.isArray(conversation.messages)
    ? conversation.messages.map(renderMessage).join('')
    : '';
  const renderedTaskIds = new Set(
    (conversation.messages || [])
      .filter((message) => message.kind === 'research_task' && message.task_id)
      .map((message) => message.task_id),
  );
  const orphanTasksHtml = conversationTasks()
    .filter((task) => !renderedTaskIds.has(task.id))
    .map(renderTaskBlock)
    .join('');
  els.thread.innerHTML = `${messagesHtml}${orphanTasksHtml}`;

  els.thread.querySelectorAll('[data-cancel-task]').forEach((button) => {
    button.addEventListener('click', () => cancelTask(button.dataset.cancelTask));
  });
  els.thread.querySelectorAll('[data-open-doc]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = taskById(button.dataset.openDoc);
      if (task) openViewer(task);
    });
  });
  els.thread.querySelectorAll('[data-reference-task]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.referenceTask;
      if (state.referencedTaskIds.has(id)) state.referencedTaskIds.delete(id);
      else state.referencedTaskIds.add(id);
      renderReferenceBar();
      renderThread();
    });
  });
  renderReferenceBar();

  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
}

function openViewer(task) {
  els.viewerTitle.textContent = task.title || 'Deep Research Report';
  els.viewerContent.innerHTML = markdownToHtml(task.output_text || '');
  els.downloadMd.href = `/api/research/${encodeURIComponent(task.id)}/export/markdown`;
  els.downloadPdf.href = `/api/research/${encodeURIComponent(task.id)}/export/pdf`;
  els.viewer.classList.add('open');
  els.viewer.setAttribute('aria-hidden', 'false');
}

function closeViewer() {
  els.viewer.classList.remove('open');
  els.viewer.setAttribute('aria-hidden', 'true');
}

async function loadConfig() {
  state.config = await api('/api/config');
  const providers = providerConfigs();
  els.providerSelect.innerHTML = providers
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label || provider.id)}</option>`,
    )
    .join('');
  const defaultProvider = providers.find(
    (provider) => provider.id === state.config.default_provider,
  );
  els.providerSelect.value = defaultProvider?.id || providers[0]?.id || '';
  syncModelOptions();
}

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations || [];
  renderConversationList();
}

async function loadConversation(id) {
  if (!id) return;
  closeConversationMenu();
  const data = await api(`/api/conversations/${encodeURIComponent(id)}`);
  state.activeConversation = data.conversation;
  await loadConversations();
  renderThread();
  syncPolling();
}

async function deleteConversation(id) {
  if (!id) return;
  const conversation = state.conversations.find((item) => item.id === id);
  const title = conversation?.title || '这个对话';
  closeConversationMenu();
  if (!window.confirm(`删除“${title}”及其所有研究文件？`)) return;

  const wasActive = state.activeConversation?.id === id;
  await api(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

  if (wasActive) {
    state.activeConversation = null;
    state.referencedTaskIds.clear();
    closeViewer();
    syncPolling();
  }

  await loadConversations();
  if (wasActive) {
    if (state.conversations[0]) {
      await loadConversation(state.conversations[0].id);
    } else {
      renderThread();
    }
  }
}

async function ensureConversation() {
  if (state.activeConversation) return state.activeConversation;
  const data = await api('/api/conversations', {
    method: 'POST',
    body: '{}',
  });
  state.activeConversation = data.conversation;
  await loadConversations();
  renderThread();
  return state.activeConversation;
}

function syncPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  const conversation = state.activeConversation;
  if (!conversation) return;
  const hasRunningTask = conversationTasks().some((task) => !isTerminal(task));
  if (!hasRunningTask) return;
  state.pollTimer = setInterval(async () => {
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(state.activeConversation.id)}`);
      state.activeConversation = data.conversation;
      renderThread();
      await loadConversations();
      if (!conversationTasks().some((task) => !isTerminal(task))) syncPolling();
    } catch (error) {
      console.error(error);
    }
  }, 3000);
}

async function createTask(prompt) {
  els.sendBtn.disabled = true;
  const conversation = await ensureConversation();
  const provider = els.providerSelect.value;
  const body = {
    prompt,
    provider,
    model: els.modelSelect.value,
    max_tool_calls: 80,
  };
  if (provider === 'gpt-researcher' && els.reportTypeSelect.value) {
    body.gpt_researcher_report_type = els.reportTypeSelect.value;
  }
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(conversation.id)}/research`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.activeConversation = data.conversation;
    els.promptInput.value = '';
    resizeComposer();
    await loadConversations();
    renderThread();
    syncPolling();
  } finally {
    els.sendBtn.disabled = false;
  }
}

function appendPendingAgentMessages(prompt, referencedTaskIds) {
  if (!state.activeConversation) return;
  const now = new Date().toISOString();
  const userText = prompt.replace(/^@agent\b\s*/i, '').trim();
  state.activeConversation.messages = [
    ...(state.activeConversation.messages || []),
    {
      id: `local-agent-prompt-${Date.now()}`,
      role: 'user',
      kind: 'agent_prompt',
      content: userText,
      referenced_task_ids: referencedTaskIds,
      created_at: now,
    },
    {
      id: AGENT_PENDING_MESSAGE_ID,
      role: 'assistant',
      kind: 'agent_pending',
      content: '正在请求 Agent...',
      referenced_task_ids: referencedTaskIds,
      created_at: now,
    },
  ];
}

function replacePendingAgentMessageWithError(error, referencedTaskIds) {
  if (!state.activeConversation) return;
  const messages = state.activeConversation.messages || [];
  const pendingIndex = messages.findIndex(
    (message) => message.id === AGENT_PENDING_MESSAGE_ID,
  );
  const errorMessage = {
    id: `local-agent-error-${Date.now()}`,
    role: 'assistant',
    kind: 'agent_error',
    content: error.message || 'Agent request failed',
    referenced_task_ids: referencedTaskIds,
  };
  if (pendingIndex >= 0) {
    state.activeConversation.messages = messages.map((message, index) =>
      index === pendingIndex ? errorMessage : message,
    );
    return;
  }
  state.activeConversation.messages = [...messages, errorMessage];
}

async function sendAgentMessage(prompt) {
  els.sendBtn.disabled = true;
  const conversation = await ensureConversation();
  const referencedTaskIds = [...state.referencedTaskIds];
  appendPendingAgentMessages(prompt, referencedTaskIds);
  state.referencedTaskIds.clear();
  els.promptInput.value = '';
  resizeComposer();
  renderThread();
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(conversation.id)}/agent`, {
      method: 'POST',
      body: JSON.stringify({
        content: prompt,
        referenced_task_ids: referencedTaskIds,
      }),
    });
    state.activeConversation = data.conversation;
    await loadConversations();
    renderThread();
    syncPolling();
  } catch (error) {
    if (error.data?.conversation) {
      state.activeConversation = error.data.conversation;
      await loadConversations();
    } else {
      replacePendingAgentMessageWithError(error, referencedTaskIds);
    }
    renderThread();
    console.error(error);
  } finally {
    els.sendBtn.disabled = false;
  }
}

async function cancelTask(id) {
  const data = await api(`/api/research/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: '{}',
  });
  const task = data.task;
  if (state.activeConversation) {
    const target = conversationTasks().findIndex((item) => item.id === task.id);
    if (target >= 0) state.activeConversation.tasks[target] = task;
  }
  renderThread();
  await loadConversations();
  syncPolling();
}

async function resetView() {
  state.activeConversation = null;
  state.referencedTaskIds.clear();
  renderConversationList();
  renderThread();
  syncPolling();
  els.promptInput.focus();
}

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = els.promptInput.value.trim();
  if (!prompt) return;
  const action = isAgentPrompt(prompt) ? sendAgentMessage : createTask;
  action(prompt).catch((error) => {
    if (error.data?.conversation) {
      state.activeConversation = error.data.conversation;
      loadConversations().catch(console.error);
      renderThread();
      return;
    }
    if (!state.activeConversation) {
      state.activeConversation = {
        id: 'local-error',
        title: 'Deep Research',
        messages: [
          {
            id: 'local-error-message',
            role: 'assistant',
            kind: 'agent_error',
            content: error.message,
            referenced_task_ids: [],
          },
        ],
        tasks: [],
      };
    } else {
      state.activeConversation.messages = [
        ...(state.activeConversation.messages || []),
        {
          id: `local-error-${Date.now()}`,
          role: 'assistant',
          kind: 'agent_error',
          content: error.message,
          referenced_task_ids: [],
        },
      ];
    }
    renderThread();
  });
});

els.promptInput.addEventListener('input', resizeComposer);
els.promptInput.addEventListener('keydown', (event) => {
  if (state.agentPickerOpen) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveAgentSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveAgentSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      selectActiveAgent();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAgentPicker();
      return;
    }
  }
  if (event.key === '@') {
    event.preventDefault();
    openAgentPicker();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});
els.agentTriggerBtn.addEventListener('click', () => {
  if (state.agentPickerOpen) closeAgentPicker();
  else openAgentPicker();
  els.promptInput.focus();
});
els.agentPicker.addEventListener('mousemove', (event) => {
  const button = event.target.closest?.('[data-agent-index]');
  if (!button) return;
  const index = Number(button.dataset.agentIndex);
  if (!Number.isNaN(index) && index !== state.activeAgentIndex) {
    state.activeAgentIndex = index;
    renderAgentPicker();
  }
});
els.agentPicker.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-agent-index]');
  if (!button) return;
  const index = Number(button.dataset.agentIndex);
  if (!Number.isNaN(index)) state.activeAgentIndex = index;
  selectActiveAgent();
});
els.closeViewer.addEventListener('click', closeViewer);
els.viewer.addEventListener('click', (event) => {
  if (event.target === els.viewer) closeViewer();
});
els.newConversationBtn.addEventListener('click', resetView);
els.providerSelect.addEventListener('change', syncModelOptions);
els.conversationMenu.addEventListener('click', (event) => {
  if (!event.target.closest?.('[data-delete-conversation]')) return;
  deleteConversation(state.contextMenuConversationId).catch((error) => {
    console.error(error);
    window.alert(error.message);
  });
});
document.addEventListener('click', (event) => {
  if (
    state.agentPickerOpen &&
    !els.agentPicker.contains(event.target) &&
    !els.agentTriggerBtn.contains(event.target)
  ) {
    closeAgentPicker();
  }
  if (els.conversationMenu.hidden) return;
  if (els.conversationMenu.contains(event.target)) return;
  closeConversationMenu();
});
document.addEventListener('contextmenu', (event) => {
  if (event.target.closest?.('[data-conversation-id]')) return;
  closeConversationMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeConversationMenu();
    closeAgentPicker();
  }
});
window.addEventListener('resize', () => {
  closeConversationMenu();
  closeAgentPicker();
});
window.addEventListener(
  'scroll',
  () => {
    closeConversationMenu();
    closeAgentPicker();
  },
  true,
);

await loadConfig();
await loadConversations();
if (state.conversations[0]) {
  await loadConversation(state.conversations[0].id);
} else {
  renderThread();
}
resizeComposer();
