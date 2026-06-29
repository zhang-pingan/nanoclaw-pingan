const state = {
  config: null,
  activeTask: null,
  pollTimer: null,
  tasks: [],
};

const els = {
  providerSelect: document.getElementById('provider-select'),
  modelSelect: document.getElementById('model-select'),
  taskList: document.getElementById('task-list'),
  thread: document.getElementById('thread'),
  emptyState: document.getElementById('empty-state'),
  composer: document.getElementById('composer'),
  promptInput: document.getElementById('prompt-input'),
  sendBtn: document.getElementById('send-btn'),
  newTaskBtn: document.getElementById('new-task-btn'),
  viewer: document.getElementById('viewer'),
  viewerTitle: document.getElementById('viewer-title'),
  viewerContent: document.getElementById('viewer-content'),
  closeViewer: document.getElementById('close-viewer'),
  downloadMd: document.getElementById('download-md'),
  downloadPdf: document.getElementById('download-pdf'),
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

function taskStatusText(task) {
  if (!task) return '';
  if (task.status === 'completed') return '研究完成';
  if (task.status === 'failed') return '研究失败';
  if (task.status === 'cancelled') return '已取消';
  if (task.status === 'incomplete') return '未完整完成';
  if (task.status === 'queued') return '排队中';
  return '研究进行中';
}

function providerConfigs() {
  return Array.isArray(state.config?.providers) ? state.config.providers : [];
}

function getProviderConfig(providerId) {
  return (
    providerConfigs().find((provider) => provider.id === providerId) ||
    providerConfigs()[0] ||
    null
  );
}

function syncModelOptions() {
  const provider = getProviderConfig(els.providerSelect.value);
  const models = Array.isArray(provider?.models) ? provider.models : [];
  els.modelSelect.innerHTML = models
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join('');
  els.modelSelect.value = provider?.default_model || models[0] || '';
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
  if (!response.ok) throw new Error(data.error || 'request failed');
  return data;
}

function resizeComposer() {
  const input = els.promptInput;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function renderTaskList() {
  els.taskList.innerHTML = state.tasks
    .map((task) => {
      const active = state.activeTask?.id === task.id ? ' active' : '';
      return `<button type="button" class="task-item${active}" data-task-id="${escapeHtml(task.id)}">${escapeHtml(task.title || task.prompt || 'Deep Research')}</button>`;
    })
    .join('');

  els.taskList.querySelectorAll('[data-task-id]').forEach((button) => {
    button.addEventListener('click', () => loadTask(button.dataset.taskId));
  });
}

function renderPrompt(task) {
  if (!task?.prompt) return '';
  return `
    <div class="message-row user">
      <div class="prompt-bubble">${escapeHtml(task.prompt)}</div>
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
          ? `<div class="progress-actions"><button type="button" class="secondary-btn" id="cancel-task-btn">取消</button></div>`
          : ''
      }
    </section>
  `;
}

function renderDocCard(task) {
  if (task.status !== 'completed' || !task.output_text) return '';
  return `
    <section class="doc-card">
      <div class="doc-card-top">
        <div class="doc-title">
          <span class="doc-icon">□</span>
          <span>${escapeHtml(task.title || 'Deep Research Report')}</span>
        </div>
        <div class="doc-actions">
          <a class="icon-link" href="/api/research/${encodeURIComponent(task.id)}/export/markdown" download>MD</a>
          <a class="icon-link" href="/api/research/${encodeURIComponent(task.id)}/export/pdf" target="_blank" rel="noreferrer">PDF</a>
          <button type="button" class="icon-btn" id="open-doc-btn">全屏</button>
        </div>
      </div>
      <div class="doc-preview">
        <h2>${escapeHtml(task.title || 'Deep Research Report')}</h2>
        <div class="doc-stats">
          <span>${escapeHtml(task.provider_label || task.provider || 'Provider')}</span>
          <span>${escapeHtml(task.model)}</span>
          <span>${task.stats?.source_count || 0} 个来源</span>
          <span>${task.usage?.total_tokens || '--'} tokens</span>
        </div>
      </div>
    </section>
  `;
}

function renderThread() {
  const task = state.activeTask;
  els.emptyState.hidden = !!task;
  if (!task) {
    els.thread.innerHTML = '';
    els.thread.appendChild(els.emptyState);
    return;
  }

  els.thread.innerHTML = `
    ${renderPrompt(task)}
    ${renderProgress(task)}
    <div style="height: 28px"></div>
    ${renderDocCard(task)}
  `;

  const cancelBtn = document.getElementById('cancel-task-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelTask(task.id));
  const openDocBtn = document.getElementById('open-doc-btn');
  if (openDocBtn) openDocBtn.addEventListener('click', () => openViewer(task));

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
  els.providerSelect.innerHTML = providerConfigs()
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label || provider.id)}</option>`,
    )
    .join('');
  els.providerSelect.value = state.config.default_provider || providerConfigs()[0]?.id || 'openai';
  syncModelOptions();
}

async function loadTasks() {
  const data = await api('/api/research/tasks');
  state.tasks = data.tasks || [];
  renderTaskList();
}

async function loadTask(id) {
  if (!id) return;
  const data = await api(`/api/research/${encodeURIComponent(id)}`);
  state.activeTask = data.task;
  await loadTasks();
  renderThread();
  syncPolling();
}

function syncPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (!state.activeTask || isTerminal(state.activeTask)) return;
  state.pollTimer = setInterval(async () => {
    try {
      const data = await api(`/api/research/${encodeURIComponent(state.activeTask.id)}`);
      state.activeTask = data.task;
      renderThread();
      await loadTasks();
      if (isTerminal(state.activeTask)) syncPolling();
    } catch (error) {
      console.error(error);
    }
  }, 3000);
}

async function createTask(prompt) {
  els.sendBtn.disabled = true;
  try {
    const data = await api('/api/research', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        provider: els.providerSelect.value,
        model: els.modelSelect.value,
        max_tool_calls: 80,
      }),
    });
    state.activeTask = data.task;
    els.promptInput.value = '';
    resizeComposer();
    await loadTasks();
    renderThread();
    syncPolling();
  } finally {
    els.sendBtn.disabled = false;
  }
}

async function cancelTask(id) {
  const data = await api(`/api/research/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: '{}',
  });
  state.activeTask = data.task;
  renderThread();
  await loadTasks();
  syncPolling();
}

function resetView() {
  state.activeTask = null;
  renderTaskList();
  renderThread();
  syncPolling();
  els.promptInput.focus();
}

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = els.promptInput.value.trim();
  if (!prompt) return;
  createTask(prompt).catch((error) => {
    state.activeTask = {
      id: 'local-error',
      status: 'failed',
      prompt,
      title: 'Deep Research',
      error: { message: error.message },
      progress: [],
      stats: {},
    };
    renderThread();
  });
});

els.promptInput.addEventListener('input', resizeComposer);
els.promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});
els.closeViewer.addEventListener('click', closeViewer);
els.viewer.addEventListener('click', (event) => {
  if (event.target === els.viewer) closeViewer();
});
els.newTaskBtn.addEventListener('click', resetView);
els.providerSelect.addEventListener('change', syncModelOptions);

await loadConfig();
await loadTasks();
renderThread();
resizeComposer();
