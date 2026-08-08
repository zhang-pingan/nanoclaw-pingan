import {
  buildCollaborationCreateRequest,
  buildCollaborationJoinRequest,
  buildCollaborationWorkflowRequest,
  collaborationDraftFromDefinition,
  defaultCollaborationWorkflowDraft,
} from './collaboration-definition.js';
import {
  collaborationRuntimeGraphHighlights,
  collaborationWorkflowEditable,
  collaborationWorkflowPublishable,
} from './collaboration-fsm.js';
import { mountCollaborationFsmEditor } from './collaboration-fsm-editor.js';
import {
  collaborationAggregateLabel,
  collaborationEventLabel,
  collaborationLabel,
  collaborationPermissionLabel,
  collaborationStatusLabel,
} from './collaboration-labels.js';
import {
  collaborationArtifactName,
  collaborationAuditEventTimeline,
  buildCollaborationCompleteTurnRequest,
  buildCollaborationStartTurnRequest,
  collaborationCanApproveMembers,
  collaborationCanCreateTurn,
  collaborationCanMutate,
  collaborationCurrentTurn,
  collaborationDuration,
  collaborationEligibleTurnExecutors,
  collaborationElapsed,
  collaborationIsObserver,
  collaborationLocalMembershipStatus,
  collaborationOutcomeRoutes,
  collaborationPendingNotifications,
  collaborationPrincipalName,
  stageCollaborationArtifactFiles,
  collaborationTurnAccess,
  collaborationTurnCompletionDraft,
  collaborationTurnDeadline,
  collaborationTurnHistory,
  collaborationTurnLifecycle,
  collaborationVerifiedFileTree,
  collaborationWorkItemColumns,
} from './collaboration-ui.js';

export const collaborationRouteTabs = new Set([
  'overview',
  'activity',
  'work-items',
  'discussions',
  'files',
  'workflows',
  'members',
  'audit',
  'settings',
  'diagnostics',
]);

export function parseCollaborationRoute(pathname) {
  if (pathname === '/groups' || pathname === '/groups/')
    return { groupId: '', tab: 'overview' };
  if (!pathname.startsWith('/groups/')) return null;
  try {
    const segments = pathname
      .slice('/groups/'.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    return {
      groupId: segments[0] || '',
      tab: collaborationRouteTabs.has(segments[1]) ? segments[1] : 'overview',
    };
  } catch {
    return { groupId: '', tab: 'overview' };
  }
}

export function collaborationRoute(groupId, tab = 'overview') {
  const base = groupId ? `/groups/${encodeURIComponent(groupId)}` : '/groups';
  return tab === 'overview' || !groupId ? base : `${base}/${tab}`;
}

const html = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
const attr = html;

function statusTone(value) {
  const normalized = String(value || '').toLowerCase();
  if (
    ['active', 'running', 'ready', 'verified', 'done', 'completed'].includes(
      normalized,
    )
  )
    return 'success';
  if (
    ['blocked', 'failed', 'recovery_required', 'protocol_quarantined'].includes(
      normalized,
    )
  )
    return 'danger';
  if (
    ['paused', 'waiting_input', 'waiting_approval', 'pending'].includes(
      normalized,
    )
  )
    return 'warning';
  return 'neutral';
}

function status(value, label = value) {
  return `<span class="collaboration-status ${statusTone(value)}">${html(collaborationStatusLabel(label || value))}</span>`;
}

function timestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '-';
}

function localDate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric).toLocaleString()
    : '-';
}

function aggregateRevision(projection, type, id) {
  return projection?.aggregateHeads?.[`${type}:${id}`]?.revision ?? 0;
}

function field(label, name, value = '', options = {}) {
  const control = options.multiline
    ? `<textarea name="${attr(name)}" ${options.required === false ? '' : 'required'}>${html(value)}</textarea>`
    : options.options
      ? `<select name="${attr(name)}">${options.options
          .map(
            ([id, text]) =>
              `<option value="${attr(id)}" ${String(value) === String(id) ? 'selected' : ''}>${html(text)}</option>`,
          )
          .join('')}</select>`
      : `<input name="${attr(name)}" value="${attr(value)}" ${options.type ? `type="${attr(options.type)}"` : ''} ${options.multiple ? 'multiple' : ''} ${options.required === false ? '' : 'required'}>`;
  return `<label class="collaboration-field"><span>${html(label)}</span>${control}</label>`;
}

function metric(label, value, tone = '') {
  return `<div class="collaboration-metric ${tone}"><span>${html(label)}</span><strong>${html(value)}</strong></div>`;
}

function empty(label) {
  return `<div class="collaboration-section-empty">${html(label)}</div>`;
}

function renderArtifactRefs(projection, refs) {
  if (!refs?.length) return '';
  return `<div class="collaboration-artifact-refs">${refs
    .map(
      (ref) =>
        `<code title="${attr(ref)}">${html(collaborationArtifactName(projection, ref))}</code>`,
    )
    .join('')}</div>`;
}

function renderTreeNode(node) {
  const directories = Object.values(node.directories || {});
  return `<ul class="collaboration-file-tree">${directories
    .map(
      (directory) =>
        `<li><details open><summary>${html(directory.name)}</summary>${renderTreeNode(directory)}</details></li>`,
    )
    .join('')}${(node.files || [])
    .map(
      (file) =>
        `<li><button type="button" data-collaboration-action="open-file" data-repository-path="${attr(file.repositoryPath)}"><span>${html(file.name)}</span><small>${html(file.metadata?.media_type || '')}</small></button></li>`,
    )
    .join('')}</ul>`;
}

export function createCollaborationWorkspace(options) {
  const state = options.state;
  const elements = {
    banner: document.getElementById('collaboration-runtime-banner'),
    list: document.getElementById('collaboration-list'),
    search: document.getElementById('collaboration-search'),
    empty: document.getElementById('collaboration-empty'),
    detail: document.getElementById('collaboration-detail'),
    title: document.getElementById('collaboration-title'),
    lifecycle: document.getElementById('collaboration-lifecycle'),
    meta: document.getElementById('collaboration-detail-meta'),
    content: document.getElementById('collaboration-content'),
    dialog: document.getElementById('collaboration-dialog'),
    dialogForm: document.getElementById('collaboration-dialog-form'),
    dialogTitle: document.getElementById('collaboration-dialog-title'),
    dialogBody: document.getElementById('collaboration-dialog-body'),
    dialogError: document.getElementById('collaboration-dialog-error'),
    dialogSubmit: document.getElementById('collaboration-dialog-submit'),
    tabs: [...document.querySelectorAll('[data-collaboration-tab]')],
  };
  let workflowEditor = null;

  const selectedGroup = () =>
    state.detail?.group ||
    state.groups.find((group) => group.groupId === state.selectedGroupId) ||
    null;

  const updateRoute = (replace = false) => {
    const path = collaborationRoute(state.selectedGroupId, state.activeTab);
    if (window.location.pathname !== path)
      window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  };

  const setBanner = (message, tone = 'danger') => {
    elements.banner.className = message
      ? `collaboration-runtime-banner ${tone}`
      : 'collaboration-runtime-banner hidden';
    elements.banner.textContent = message || '';
  };

  const openDialog = (dialogOptions) => {
    elements.dialogTitle.textContent = dialogOptions.title;
    elements.dialogBody.innerHTML = dialogOptions.body;
    elements.dialogSubmit.textContent = dialogOptions.submitText || '保存';
    elements.dialogSubmit.className = dialogOptions.danger
      ? 'btn-danger-soft'
      : 'btn-primary';
    elements.dialogError.classList.add('hidden');
    state.dialogSubmit = dialogOptions.onSubmit;
    elements.dialogSubmit.classList.toggle(
      'hidden',
      typeof dialogOptions.onSubmit !== 'function',
    );
    elements.dialog.classList.toggle(
      'collaboration-dialog-wide',
      Boolean(dialogOptions.wide),
    );
    elements.dialog.showModal();
    dialogOptions.onOpen?.();
  };

  const closeDialog = () => {
    workflowEditor?.destroy();
    workflowEditor = null;
    state.dialogSubmit = null;
    elements.dialogSubmit.classList.remove('hidden');
    elements.dialog.close();
    elements.dialog.classList.remove('collaboration-dialog-wide');
  };

  const renderList = () => {
    const query = String(elements.search?.value || '')
      .trim()
      .toLowerCase();
    const groups = state.groups.filter(
      (group) =>
        !query ||
        [group.name, group.groupId, group.remoteUrl].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(query),
        ),
    );
    elements.list.innerHTML = groups.length
      ? groups
          .map(
            (
              group,
            ) => `<button type="button" class="collaboration-list-item ${group.groupId === state.selectedGroupId ? 'active' : ''}" data-collaboration-group-id="${attr(group.groupId)}">
              <span class="collaboration-list-item-head"><strong>${html(group.name)}</strong>${status(group.protocolStatus, group.lifecycle)}</span>
              <span class="collaboration-list-id">${html(group.groupId)}</span>
              <span class="collaboration-list-meta"><span>${html(collaborationLabel(group.subscriptionMode))}</span><span>${html(group.lastVerifiedHead ? group.lastVerifiedHead.slice(0, 8) : '尚未同步')}</span></span>
            </button>`,
          )
          .join('')
      : empty(state.loading ? '正在加载' : '暂无群组');
  };

  const renderShell = () => {
    const group = selectedGroup();
    elements.empty.classList.toggle('hidden', Boolean(group));
    elements.detail.classList.toggle('hidden', !group);
    if (!group) return;
    elements.title.textContent = group.name;
    elements.lifecycle.className = `collaboration-status ${statusTone(group.lifecycle)}`;
    elements.lifecycle.textContent = collaborationStatusLabel(group.lifecycle);
    const membershipStatus = collaborationLocalMembershipStatus(group);
    elements.meta.innerHTML = `<span>${html(group.groupId)}</span><span>${html(group.subscriptionMode === 'member' ? `成员 · ${collaborationStatusLabel(membershipStatus)}` : '观察者')}</span><span>${html(collaborationStatusLabel(group.protocolStatus))}</span><span>${html(localDate(group.lastSyncAtMs))}</span>`;
    elements.tabs.forEach((button) =>
      button.classList.toggle(
        'active',
        button.dataset.collaborationTab === state.activeTab,
      ),
    );
    renderContent();
  };

  const renderObserverBand = (group) => {
    if (collaborationIsObserver(group))
      return `<section class="collaboration-observer-band"><div><strong>只读观察者</strong><span>${html(group.lastVerifiedHead ? `已验证 ${group.lastVerifiedHead.slice(0, 12)}` : '正在等待验证版本')}</span></div><button type="button" class="btn-primary" data-collaboration-action="request-join">申请加入群组</button></section>`;
    const membershipStatus = collaborationLocalMembershipStatus(group);
    return membershipStatus === 'active'
      ? ''
      : `<section class="collaboration-observer-band"><div><strong>成员状态：${html(collaborationStatusLabel(membershipStatus))}</strong><span>成员资格生效前，群组写入功能保持禁用。</span></div></section>`;
  };

  const renderOverview = () => {
    const { group, notifications = [] } = state.detail;
    const projection = group.projection;
    const items = Object.values(projection?.workItems || {});
    const instances = Object.values(projection?.workflowInstances || {});
    const activity = (projection?.activity || []).slice(-8).reverse();
    return `${renderObserverBand(group)}
      <section class="collaboration-metrics">
        ${metric('成员', Object.values(projection?.members || {}).filter((member) => member.status === 'active').length)}
        ${metric('待处理工作', items.filter((item) => !['done', 'cancelled'].includes(item.status)).length)}
        ${metric('运行中的工作流', instances.filter((instance) => instance.lifecycle !== 'closed').length)}
        ${metric('通知', notifications.length, notifications.length ? 'warning' : '')}
      </section>
      <section class="collaboration-section"><div class="collaboration-section-head"><h3>群组动态</h3><button type="button" class="btn-ghost" data-collaboration-action="go-activity">查看全部</button></div>
        <div class="collaboration-timeline">${activity.length ? activity.map((event) => `<article><span class="collaboration-timeline-marker"></span><div><strong>${html(collaborationEventLabel(event.eventType))}</strong><small>${html(collaborationPrincipalName(projection, event.actorPrincipalId))} · ${html(timestamp(event.occurredAt))}</small></div></article>`).join('') : empty('暂无动态')}</div>
      </section>
      <section class="collaboration-section collaboration-two-column"><div><div class="collaboration-section-head"><h3>工作项</h3></div>${
        items
          .slice(0, 5)
          .map(
            (item) =>
              `<button type="button" class="collaboration-row-button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong>${status(item.status)}</button>`,
          )
          .join('') || empty('暂无工作项')
      }</div><div><div class="collaboration-section-head"><h3>工作流实例</h3></div>${
        instances
          .slice(0, 5)
          .map(
            (instance) =>
              `<button type="button" class="collaboration-row-button" data-collaboration-action="open-instance" data-instance-id="${attr(instance.instance_id)}"><strong>${html(instance.definition_id)}</strong>${status(instance.lifecycle, instance.business_state)}</button>`,
          )
          .join('') || empty('暂无实例')
      }</div></section>`;
  };

  const renderActivity = () => {
    const events = [...(selectedGroup().projection?.activity || [])].reverse();
    const projection = selectedGroup().projection;
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>活动</h3><span>${events.length}</span></div><div class="collaboration-timeline">${events.map((event) => `<article><span class="collaboration-timeline-marker"></span><div><strong>${html(collaborationEventLabel(event.eventType))}</strong><p>${html(collaborationAggregateLabel(event.aggregateType))} · ${html(event.aggregateId)} · 修订 ${html(event.aggregateRevision)}</p><small>${html(collaborationPrincipalName(projection, event.actorPrincipalId))} / ${html(event.actorClientId)} · ${html(timestamp(event.occurredAt))}</small></div></article>`).join('') || empty('暂无活动')}</div></section>`;
  };

  const renderWorkItemDetail = (item) => {
    const group = selectedGroup();
    const updates =
      group.projection?.workItemUpdates?.[item.work_item_id] || [];
    const mutable = collaborationCanMutate(group);
    return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-work-item">返回</button>${mutable ? '<button type="button" class="btn-ghost" data-collaboration-action="post-work-progress">发布进展</button>' : ''}</section>
      <section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(item.title)}</h3>${status(item.status)}</div><p class="collaboration-prose">${html(item.description || '')}</p><dl class="collaboration-definition-list"><div><dt>负责人</dt><dd>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</dd></div><div><dt>优先级</dt><dd>${html(collaborationLabel(item.priority))}</dd></div><div><dt>截止时间</dt><dd>${html(timestamp(item.due_at))}</dd></div><div><dt>分配状态</dt><dd>${html(collaborationLabel(item.assignment_status))}</dd></div><div><dt>标签</dt><dd>${(item.labels || []).map((label) => `<code>${html(collaborationLabel(label))}</code>`).join(' ') || '-'}</dd></div><div><dt>阻塞项</dt><dd>${(item.blocked_by || []).map((id) => `<code>${html(id)}</code>`).join(' ') || '-'}</dd></div></dl>${mutable ? `<div class="collaboration-segmented">${['proposed', 'open', 'in_progress', 'blocked', 'done', 'cancelled'].map((value) => `<button type="button" data-collaboration-action="set-work-status" data-status="${value}" class="${item.status === value ? 'active' : ''}">${html(collaborationStatusLabel(value))}</button>`).join('')}</div>` : ''}</section>
      <section class="collaboration-section"><div class="collaboration-section-head"><h3>进展</h3><span>${updates.length}</span></div><div class="collaboration-record-list">${
        updates
          .slice()
          .reverse()
          .map(
            (update) =>
              `<article class="collaboration-record"><div><strong>${html(update.summary)}</strong><small>${html(collaborationPrincipalName(group.projection, update.actor_principal_id))} · ${html(timestamp(update.created_at))}</small>${renderArtifactRefs(group.projection, update.artifact_refs)}</div></article>`,
          )
          .join('') || empty('暂无进展')
      }</div></section>`;
  };

  const renderWorkItems = () => {
    const group = selectedGroup();
    const items = Object.values(group.projection?.workItems || {});
    const selected = items.find(
      (item) => item.work_item_id === state.selectedWorkItemId,
    );
    if (selected) return renderWorkItemDetail(selected);
    const columns = collaborationWorkItemColumns(items);
    const statuses = ['proposed', 'open', 'in_progress', 'blocked', 'done'];
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>工作项</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-work-item">新建</button>' : ''}</div><div class="collaboration-view-toggle"><button type="button" data-collaboration-action="work-view" data-view="board" class="${state.workItemView !== 'list' ? 'active' : ''}">看板</button><button type="button" data-collaboration-action="work-view" data-view="list" class="${state.workItemView === 'list' ? 'active' : ''}">列表</button></div>${state.workItemView === 'list' ? `<div class="collaboration-record-list">${items.map((item) => `<button type="button" class="collaboration-row-button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong><span>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</span>${status(item.status)}</button>`).join('') || empty('暂无工作项')}</div>` : `<div class="collaboration-work-board">${statuses.map((column) => `<section><header><strong>${html(collaborationStatusLabel(column))}</strong><span>${columns[column].length}</span></header>${columns[column].map((item) => `<button type="button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong><small>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</small><span>${html(collaborationLabel(item.priority))}</span></button>`).join('') || empty('暂无内容')}</section>`).join('')}</div>`}</section>`;
  };

  const renderDiscussions = () => {
    const group = selectedGroup();
    const threads = Object.values(group.projection?.discussions || {});
    const selected = threads.find(
      (thread) => thread.discussion.thread_id === state.selectedDiscussionId,
    );
    if (selected) {
      const messages = Object.values(selected.messages || {}).sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-discussion">返回</button>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-message">回复</button>' : ''}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(selected.discussion.title)}</h3>${status(selected.discussion.status)}</div><div class="collaboration-discussion-stream">${messages.map((message) => `<article><header><strong>${html(collaborationPrincipalName(group.projection, message.author_principal_id))}</strong><small>${html(timestamp(message.created_at))}</small></header><p>${message.tombstoned ? '<em>消息已移除</em>' : html(message.body)}</p></article>`).join('') || empty('暂无消息')}</div></section>`;
    }
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>讨论</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-discussion">新建</button>' : ''}</div><div class="collaboration-record-list">${threads.map((thread) => `<button type="button" class="collaboration-row-button" data-collaboration-action="open-discussion" data-thread-id="${attr(thread.discussion.thread_id)}"><strong>${html(thread.discussion.title)}</strong><span>${html(Object.keys(thread.messages || {}).length)} 条消息</span>${status(thread.discussion.status)}</button>`).join('') || empty('暂无讨论')}</div></section>`;
  };

  const renderFiles = () => {
    const group = selectedGroup();
    const files = state.tabData.files || [];
    const tree = collaborationVerifiedFileTree(files);
    return `<section class="collaboration-files-layout"><aside><div class="collaboration-section-head"><h3>已验证文件</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="upload-file">上传</button>' : ''}</div>${renderTreeNode(tree)}</aside><main id="collaboration-file-preview">${state.filePreview ? `<header><strong>${html(state.filePreview.name)}</strong><small>${html(state.filePreview.mediaType)}</small></header>${state.filePreview.text ? `<pre>${html(state.filePreview.text)}</pre>` : `<a class="btn-primary" href="${attr(state.filePreview.url)}" download>下载</a>`}` : empty('请选择文件')}</main></section>`;
  };

  const workflowDefinitionEntries = () =>
    Object.values(selectedGroup().projection?.workflowDefinitions || {});

  const workflowStateLabel = (definition, stateId) =>
    collaborationLabel(
      definition?.machine?.states?.[stateId]?.label || stateId,
      stateId || '未知',
    );

  const renderInstanceDetail = (instance) => {
    const group = selectedGroup();
    const projection = group.projection;
    const definition = workflowDefinitionEntries().find(
      (entry) =>
        entry.definition.definition_id === instance.definition_id &&
        entry.definition.version === instance.definition_version,
    );
    const turn = collaborationCurrentTurn(projection, instance.instance_id);
    const turns = collaborationTurnHistory(projection, instance.instance_id);
    const access = collaborationTurnAccess(group, turn);
    const routes = collaborationOutcomeRoutes(definition, turn);
    const canCreateTurn =
      collaborationCanMutate(group) &&
      collaborationCanCreateTurn(group, instance, definition);
    const currentAssignedToLocal =
      instance.resolved_assignments?.[instance.business_state] ===
      group.localPrincipalId;
    queueMicrotask(() => {
      const host = document.getElementById('collaboration-instance-graph');
      if (host && definition)
        mountCollaborationFsmEditor(host, {
          draft: collaborationDraftFromDefinition(definition),
          readonly: true,
          runtimeHighlights: collaborationRuntimeGraphHighlights(
            projection,
            instance.instance_id,
          ),
        });
    });
    const currentTurn = turn
      ? `<dl class="collaboration-definition-list"><div><dt>状态</dt><dd>${html(workflowStateLabel(definition, turn.state_id))}</dd></div><div><dt>负责人</dt><dd>${html(collaborationPrincipalName(projection, turn.assignee_principal_id))}</dd></div><div><dt>客户端</dt><dd>${html(turn.claimant_client_id || '-')}</dd></div><div><dt>执行模式</dt><dd>${html(collaborationLabel(turn.execution_mode))}</dd></div><div><dt>尝试次数</dt><dd>${html(turn.attempt)}</dd></div><div><dt>截止时间</dt><dd>${html(collaborationTurnDeadline(turn)?.deadlineAt || '-')}</dd></div></dl><div class="collaboration-record-actions">${access.canStart ? '<button type="button" class="btn-primary" data-collaboration-action="start-turn">开始执行</button>' : ''}${access.canComplete ? '<button type="button" class="btn-primary" data-collaboration-action="complete-turn">完成</button>' : ''}${collaborationCanMutate(group) && turn.assignee_principal_id === group.localPrincipalId ? '<button type="button" class="btn-ghost" data-collaboration-action="configure-execution">执行配置</button>' : ''}</div><div class="collaboration-outcome-preview">${routes.map((route) => `<span><strong>${html(collaborationLabel(route.label || route.outcome))}</strong> → ${html(workflowStateLabel(definition, route.target_state))}</span>`).join('')}</div>`
      : `<div class="collaboration-section-empty">${instance.lifecycle === 'running' ? `可以开始：${html(workflowStateLabel(definition, instance.business_state))}` : '当前没有执行轮次'}</div><div class="collaboration-record-actions">${currentAssignedToLocal ? '<button type="button" class="btn-ghost" data-collaboration-action="configure-execution">执行配置</button>' : ''}${canCreateTurn ? `<button type="button" class="btn-primary" data-collaboration-action="create-turn">${turns.length ? '继续执行' : '创建执行轮次'}</button>` : ''}</div>`;
    return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-instance">返回</button>${collaborationCanMutate(group) ? `<button type="button" class="btn-ghost" data-collaboration-action="instance-command" data-command="${instance.lifecycle === 'draft' || instance.lifecycle === 'ready' ? 'start' : instance.lifecycle === 'paused' ? 'resume' : 'pause'}">${instance.lifecycle === 'paused' ? '恢复' : instance.lifecycle === 'running' ? '暂停' : '启动'}</button>` : ''}</section><section class="collaboration-metrics">${metric('生命周期', collaborationStatusLabel(instance.lifecycle))}${metric('当前状态', workflowStateLabel(definition, instance.business_state))}${metric('周期', instance.epoch)}${metric('执行轮次', turns.length)}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(collaborationLabel(definition?.definition?.name || instance.definition_id))} · ${html(instance.instance_id)}</h3>${status(instance.lifecycle)}</div><div id="collaboration-instance-graph"></div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>当前执行轮次</h3>${turn ? status(turn.state) : ''}</div>${currentTurn}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>执行历史</h3><span>${turns.length}</span></div>${turns.map((item) => `<article class="collaboration-record"><div><strong>${html(workflowStateLabel(definition, item.state_id))}</strong><small>${html(timestamp(item.created_at))}${item.outcome ? ` · ${html(collaborationLabel(item.outcome))}` : ''}</small>${renderArtifactRefs(projection, item.artifact_refs)}</div>${status(item.state)}</article>`).join('') || empty('暂无执行记录')}</section>`;
  };

  const renderWorkflows = () => {
    const group = selectedGroup();
    const instances = Object.values(group.projection?.workflowInstances || {});
    const selectedInstance = instances.find(
      (instance) => instance.instance_id === state.selectedInstanceId,
    );
    if (selectedInstance) return renderInstanceDetail(selectedInstance);
    const definitions = workflowDefinitionEntries();
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>工作流定义</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-workflow">新建</button>' : ''}</div><div class="collaboration-record-list">${definitions.map((entry) => `<article class="collaboration-record"><div><strong>${html(collaborationLabel(entry.definition.name))}</strong><small>${html(entry.definition.definition_id)} · v${html(entry.definition.version)}</small></div>${status(entry.definition.status)}<div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="view-workflow" data-definition-key="${attr(entry.definition.definition_id)}@${attr(entry.definition.version)}">打开</button>${entry.definition.status === 'published' && collaborationWorkflowEditable(group, entry) ? `<button type="button" class="btn-ghost" data-collaboration-action="new-workflow-version" data-definition-key="${attr(entry.definition.definition_id)}@${attr(entry.definition.version)}">新建版本</button>` : ''}${collaborationWorkflowPublishable(group, entry) ? `<button type="button" class="btn-primary" data-collaboration-action="publish-workflow" data-definition-id="${attr(entry.definition.definition_id)}" data-version="${attr(entry.definition.version)}">发布</button>` : ''}</div></article>`).join('') || empty('暂无工作流定义')}</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>工作流实例</h3>${collaborationCanMutate(group) && definitions.some((entry) => entry.definition.status === 'published') ? '<button type="button" class="btn-primary" data-collaboration-action="new-instance">新建</button>' : ''}</div><div class="collaboration-record-list">${
      instances
        .map((instance) => {
          const definition = definitions.find(
            (entry) =>
              entry.definition.definition_id === instance.definition_id &&
              entry.definition.version === instance.definition_version,
          );
          return `<button type="button" class="collaboration-row-button" data-collaboration-action="open-instance" data-instance-id="${attr(instance.instance_id)}"><strong>${html(collaborationLabel(definition?.definition?.name || instance.definition_id))}</strong><span>${html(workflowStateLabel(definition, instance.business_state))} · ${html(collaborationLabel(instance.scope.type))}</span>${status(instance.lifecycle)}</button>`;
        })
        .join('') || empty('暂无工作流实例')
    }</div></section>`;
  };

  const renderMembers = () => {
    const group = selectedGroup();
    const projection = group.projection;
    const canApprove = collaborationCanApproveMembers(group);
    const invites = Object.values(projection?.invites || {});
    const inviteSection =
      projection?.group?.membership_policy?.join === 'invite_only'
        ? `<section class="collaboration-section"><div class="collaboration-section-head"><h3>邀请</h3>${canApprove ? '<button type="button" class="btn-primary" data-collaboration-action="issue-invite">发放邀请</button>' : ''}</div><div class="collaboration-record-list">${invites.map((invite) => `<article class="collaboration-record"><div><strong>${html(collaborationPrincipalName(projection, invite.principal_id))}</strong><small>${html(invite.invite_id)} · ${html(invite.expires_at ? timestamp(invite.expires_at) : '永不过期')}</small></div>${status(invite.status)}${canApprove && invite.status === 'active' ? `<button type="button" class="btn-ghost" data-collaboration-action="revoke-invite" data-invite-id="${attr(invite.invite_id)}">撤销</button>` : ''}</article>`).join('') || empty('暂无邀请')}</div></section>`
        : '';
    return `${inviteSection}<section class="collaboration-section"><div class="collaboration-section-head"><h3>成员</h3><span>${Object.keys(projection?.members || {}).length}</span></div><div class="collaboration-record-list">${Object.values(
      projection?.members || {},
    )
      .map((member) => {
        const grants =
          projection.permissionGrants?.[member.principal_id]?.grants || [];
        const clients = Object.values(
          projection.clients?.[member.principal_id] || {},
        );
        const approvalActions =
          canApprove && member.status === 'requested'
            ? `<div class="collaboration-record-actions"><button type="button" class="btn-primary" data-collaboration-action="approve-member" data-principal-id="${attr(member.principal_id)}">批准</button><button type="button" class="btn-danger-soft" data-collaboration-action="reject-member" data-principal-id="${attr(member.principal_id)}">拒绝</button></div>`
            : '';
        return `<article class="collaboration-record"><div><strong>${html(member.display_name)}</strong><small>${html(member.principal_id)} · ${clients.length} 个客户端</small><p>${grants.map((grant) => `<code title="${attr(grant)}">${html(collaborationPermissionLabel(grant))}</code>`).join(' ') || '无直接权限'}</p></div>${status(member.status)}${approvalActions}${group.localPrincipalId === group.ownerPrincipalId && collaborationCanMutate(group) && member.status === 'active' ? `<button type="button" class="btn-ghost" data-collaboration-action="edit-permissions" data-principal-id="${attr(member.principal_id)}">权限</button>` : ''}</article>`;
      })
      .join('')}</div></section>`;
  };

  const renderAudit = () => {
    const audit = state.tabData.audit;
    if (!audit) return empty('正在加载审计记录');
    const events = collaborationAuditEventTimeline(audit.events);
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>审计</h3><button type="button" class="btn-ghost" data-collaboration-action="export-audit">导出 JSON</button></div><section class="collaboration-metrics">${metric('聚合对象', Object.keys(audit.aggregates || {}).length)}${metric('事件', events.length)}${metric('本地证据', audit.local_evidence?.length || 0)}${metric('当前版本', audit.group?.last_verified_head?.slice(0, 10) || '-')}</section><div class="collaboration-timeline">${events
      .slice()
      .reverse()
      .map(
        (event) =>
          `<article><span class="collaboration-timeline-marker"></span><div><strong>${html(collaborationEventLabel(event.event_type))}</strong><p>${html(collaborationAggregateLabel(event.aggregate_type))} · ${html(event.aggregate_id)} · 修订 ${html(event.aggregate_revision)}</p><small>Git commit ${html(event.commit_hash?.slice(0, 12))} · ${html(timestamp(event.occurred_at))}</small></div></article>`,
      )
      .join('')}</div></section>`;
  };

  const renderSettings = () => {
    const group = selectedGroup();
    return `${renderObserverBand(group)}<section class="collaboration-section"><div class="collaboration-section-head"><h3>群组设置</h3></div><dl class="collaboration-definition-list"><div><dt>群组 ID</dt><dd>${html(group.groupId)}</dd></div><div><dt>Git 远程仓库</dt><dd>${html(group.remoteUrl)}</dd></div><div><dt>订阅模式</dt><dd>${html(collaborationLabel(group.subscriptionMode))}</dd></div><div><dt>协议状态</dt><dd>${html(collaborationStatusLabel(group.protocolStatus))}</dd></div><div><dt>已验证版本</dt><dd>${html(group.lastVerifiedHead || '-')}</dd></div></dl><div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="backup">创建备份</button><button type="button" class="btn-ghost" data-collaboration-action="restore">恢复备份</button>${group.localPrincipalId === group.ownerPrincipalId && group.lifecycle === 'active' ? '<button type="button" class="btn-danger-soft" data-collaboration-action="archive-group">归档群组</button>' : ''}</div></section>`;
  };

  const renderDiagnostics = () => {
    const data = state.tabData.diagnostics;
    if (!data) return empty('正在加载诊断信息');
    return `<section class="collaboration-metrics">${metric('协议', collaborationStatusLabel(data.group?.protocolStatus || '-'))}${metric('同步次数', data.syncAttempts?.length || 0)}${metric('异常事件', data.integrityIncidents?.length || 0, data.integrityIncidents?.length ? 'danger' : '')}${metric('调度器', collaborationStatusLabel(data.scheduler?.running ? 'running' : 'stopped'))}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>同步记录</h3></div><div class="collaboration-record-list">${(data.syncAttempts || []).map((attempt) => `<article class="collaboration-record"><strong>${html(collaborationStatusLabel(attempt.outcome))}</strong><span>${html(localDate(attempt.started_at_ms || attempt.startedAtMs))}</span><small>${html(attempt.error || '')}</small></article>`).join('') || empty('暂无同步记录')}</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>完整性检查</h3></div>${(data.integrityIncidents || []).map((incident) => `<article class="collaboration-record"><strong>${html(incident.code)}</strong><p>${html(incident.message)}</p></article>`).join('') || empty('未发现异常')}</section>`;
  };

  const renderContent = () => {
    workflowEditor?.destroy();
    workflowEditor = null;
    const renderers = {
      overview: renderOverview,
      activity: renderActivity,
      'work-items': renderWorkItems,
      discussions: renderDiscussions,
      files: renderFiles,
      workflows: renderWorkflows,
      members: renderMembers,
      audit: renderAudit,
      settings: renderSettings,
      diagnostics: renderDiagnostics,
    };
    elements.content.innerHTML = (
      renderers[state.activeTab] || renderOverview
    )();
  };

  const loadTabData = async () => {
    const groupId = state.selectedGroupId;
    if (!groupId) return;
    if (state.activeTab === 'files') {
      const data = await options.request(
        `/groups/${encodeURIComponent(groupId)}/files`,
      );
      state.tabData.files = data.files || [];
    } else if (state.activeTab === 'audit')
      state.tabData.audit = await options.request(
        `/groups/${encodeURIComponent(groupId)}/audit`,
      );
    else if (state.activeTab === 'diagnostics')
      state.tabData.diagnostics = await options.request(
        `/groups/${encodeURIComponent(groupId)}/diagnostics`,
      );
    renderContent();
  };

  const loadDetail = async (groupId, updateHistory = true) => {
    elements.content.innerHTML = empty('正在加载群组');
    const data = await options.request(
      `/groups/${encodeURIComponent(groupId)}`,
    );
    state.detail = data;
    state.selectedGroupId = groupId;
    state.groups = state.groups.map((group) =>
      group.groupId === groupId ? data.group : group,
    );
    renderList();
    renderShell();
    if (updateHistory) updateRoute();
    await loadTabData();
  };

  const loadGroups = async () => {
    if (state.loading) return;
    state.loading = true;
    renderList();
    try {
      const statusData = await options.request('/status');
      state.status = statusData.collaboration;
      setBanner(
        state.status?.available ? '' : state.status?.error || '群组服务不可用',
      );
      const data = await options.request('/groups');
      state.groups = data.groups || [];
      if (
        !state.groups.some((group) => group.groupId === state.selectedGroupId)
      ) {
        state.selectedGroupId = '';
        state.detail = null;
      }
      renderList();
      renderShell();
      if (state.selectedGroupId) await loadDetail(state.selectedGroupId, false);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      state.loading = false;
      renderList();
    }
  };

  const selectGroup = async (groupId, selectOptions = {}) => {
    state.selectedGroupId = groupId;
    state.activeTab = selectOptions.tab || 'overview';
    state.selectedWorkItemId = '';
    state.selectedDiscussionId = '';
    state.selectedInstanceId = '';
    state.tabData = {};
    await loadDetail(groupId, selectOptions.updateRoute !== false);
  };

  const selectTab = async (tab, selectOptions = {}) => {
    if (!collaborationRouteTabs.has(tab)) return;
    state.activeTab = tab;
    renderShell();
    if (selectOptions.updateRoute !== false) updateRoute();
    await loadTabData();
  };

  const syncSelected = async () => {
    if (!state.selectedGroupId) return;
    await options.request(
      `/groups/${encodeURIComponent(state.selectedGroupId)}/sync`,
      {
        method: 'POST',
        body: '{}',
      },
    );
    await loadDetail(state.selectedGroupId, false);
    options.showToast('群组同步完成');
  };

  const openCreate = () =>
    openDialog({
      title: '创建群组',
      submitText: '创建',
      body: `<div class="collaboration-form-grid">${field('群组名称', 'name')}${field('Git 远程仓库', 'remoteUrl')}${field('SSH 签名密钥（可选）', 'signingKeyPath', '', { required: false })}${field('成员显示名', 'displayName')}${field('客户端名称', 'clientDisplayName')}${field(
        '加入方式',
        'membershipPolicy',
        'approval',
        {
          options: [
            ['open', '开放加入'],
            ['approval', '需要审批'],
            ['invite_only', '仅限邀请'],
          ],
        },
      )}${field('观察者访问', 'observerAccess', 'allowed', {
        options: [
          ['allowed', '允许观察'],
          ['members_only', '仅限成员'],
        ],
      })}</div>`,
      onSubmit: async (formData) => {
        const values = Object.fromEntries(formData.entries());
        const data = await options.request('/groups', {
          method: 'POST',
          body: JSON.stringify(buildCollaborationCreateRequest(values)),
        });
        closeDialog();
        await loadGroups();
        await selectGroup(data.group.groupId);
      },
    });

  const openObserve = () =>
    openDialog({
      title: '加入或观察群组',
      submitText: '添加群组',
      body: field('Git 远程仓库', 'remoteUrl'),
      onSubmit: async (formData) => {
        const data = await options.request('/subscriptions', {
          method: 'POST',
          body: JSON.stringify({ remoteUrl: formData.get('remoteUrl') }),
        });
        closeDialog();
        await loadGroups();
        await selectGroup(data.group.groupId);
      },
    });

  const requestJoin = () => {
    const group = selectedGroup();
    const inviteOnly =
      group.projection?.group?.membership_policy?.join === 'invite_only';
    openDialog({
      title: '申请加入群组',
      submitText: '提交申请',
      body: `<div class="collaboration-form-grid">${field('SSH 签名密钥（可选）', 'signingKeyPath', '', { required: false })}${field('成员显示名', 'displayName')}${field('客户端名称', 'clientDisplayName')}${inviteOnly ? field('邀请 ID', 'inviteId') : ''}</div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/join-requests`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationJoinRequest(
                Object.fromEntries(formData.entries()),
              ),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const issueInvite = () => {
    const group = selectedGroup();
    openDialog({
      title: '发放邀请',
      submitText: '发放',
      body: `<div class="collaboration-form-grid">${field('成员 ID', 'principalId')}${field('过期时间', 'expiresAt', '', { required: false })}</div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/invites`,
          {
            method: 'POST',
            body: JSON.stringify({
              principalId: formData.get('principalId'),
              expiresAt: formData.get('expiresAt') || null,
              expectedRevision: 0,
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const rejectMember = (principalId) => {
    const group = selectedGroup();
    openDialog({
      title: '拒绝加入申请',
      submitText: '确认拒绝',
      danger: true,
      body: field('拒绝原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/join-requests/${encodeURIComponent(principalId)}/reject`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'membership',
                principalId,
              ),
              reason: formData.get('reason'),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const newWorkItem = () => {
    const group = selectedGroup();
    openDialog({
      title: '新建工作项',
      body: `<div class="collaboration-form-grid">${field(
        '类型',
        'type',
        'task',
        {
          options: [
            ['task', '任务'],
            ['issue', '问题'],
            ['decision', '决策'],
            ['milestone', '里程碑'],
          ],
        },
      )}${field('标题', 'title')}${field('描述', 'description', '', { multiline: true, required: false })}${field(
        '优先级',
        'priority',
        'normal',
        {
          options: [
            ['low', '低'],
            ['normal', '普通'],
            ['high', '高'],
            ['urgent', '紧急'],
          ],
        },
      )}${field('截止时间', 'dueAt', '', { required: false })}</div>`,
      onSubmit: async (formData) => {
        const values = Object.fromEntries(formData.entries());
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/work-items`,
          {
            method: 'POST',
            body: JSON.stringify({ ...values, dueAt: values.dueAt || null }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const postWorkProgress = () => {
    const group = selectedGroup();
    const item = group.projection.workItems[state.selectedWorkItemId];
    const artifactIds = [];
    let selectedFiles = null;
    openDialog({
      title: '发布工作进展',
      body: `<div class="collaboration-form-grid">${field('进展摘要', 'summary', '', { multiline: true })}${field('产出物', 'artifacts', '', { type: 'file', required: false, multiple: true })}</div>`,
      onSubmit: async (formData) => {
        const fileControl = elements.dialogForm.elements.artifacts;
        if (selectedFiles === null) {
          selectedFiles = [...(fileControl?.files || [])];
          if (selectedFiles.length > 20)
            throw new Error('最多可添加 20 个产出物');
          if (selectedFiles.length) fileControl.disabled = true;
        }
        await stageCollaborationArtifactFiles({
          files: selectedFiles,
          artifactIds,
          request: options.request,
          endpoint: `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}/artifacts`,
          metadata: (file) => ({
            fileName: file.name,
            mediaType: file.type || 'application/octet-stream',
          }),
        });
        try {
          const currentGroup = selectedGroup();
          await options.request(
            `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}/progress`,
            {
              method: 'POST',
              body: JSON.stringify({
                expectedRevision: aggregateRevision(
                  currentGroup.projection,
                  'work_item',
                  item.work_item_id,
                ),
                summary: formData.get('summary'),
                artifactIds,
              }),
            },
          );
        } catch (error) {
          if (/revision conflict|stale/iu.test(String(error)))
            await loadDetail(group.groupId, false);
          throw error;
        }
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const newDiscussion = () => {
    const group = selectedGroup();
    openDialog({
      title: '新建讨论',
      body: field('标题', 'title'),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/discussions`,
          {
            method: 'POST',
            body: JSON.stringify({
              title: formData.get('title'),
              scope: { type: 'group' },
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const newMessage = () => {
    const group = selectedGroup();
    const thread = group.projection.discussions[state.selectedDiscussionId];
    openDialog({
      title: '回复讨论',
      body: field('消息内容', 'body', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/discussions/${encodeURIComponent(state.selectedDiscussionId)}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'discussion',
                thread.discussion.thread_id,
              ),
              body: formData.get('body'),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const uploadFile = () => {
    const group = selectedGroup();
    openDialog({
      title: '上传文件',
      body: `<div class="collaboration-form-grid">${field(
        '保存位置',
        'scope',
        'shared',
        {
          options: [
            ['shared', '共享文件'],
            ['me', '个人文件'],
          ],
        },
      )}${field('文件', 'file', '', { type: 'file' })}</div>`,
      onSubmit: async (formData) => {
        const fileValue = elements.dialogForm.elements.file?.files?.[0];
        if (!fileValue) throw new Error('请选择要上传的文件');
        const upload = new FormData();
        upload.append(
          'metadata',
          new Blob([
            JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'workspace',
                formData.get('scope') === 'shared'
                  ? 'shared'
                  : group.localPrincipalId,
              ),
              fileName: fileValue.name,
              mediaType: fileValue.type || 'application/octet-stream',
            }),
          ]),
        );
        upload.append('file', fileValue, fileValue.name);
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workspace/${encodeURIComponent(formData.get('scope'))}/files`,
          { method: 'POST', body: upload },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        await loadTabData();
      },
    });
  };

  const openWorkflowEditor = (entry = null, newVersion = false) => {
    const group = selectedGroup();
    const draft = entry
      ? collaborationDraftFromDefinition(entry)
      : defaultCollaborationWorkflowDraft();
    if (newVersion) {
      draft.version = entry.definition.version + 1;
      draft.layout.revision = 1;
    }
    const editable =
      collaborationWorkflowEditable(group, entry) &&
      (!entry || newVersion || entry.definition.status === 'proposed');
    openDialog({
      title: entry
        ? `${entry.definition.name} · v${draft.version}`
        : '新建工作流定义',
      submitText: entry && !newVersion ? '保存草稿' : '创建草稿',
      wide: true,
      body: `<div id="collaboration-workflow-editor-host"></div>`,
      onOpen: () => {
        workflowEditor = mountCollaborationFsmEditor(
          document.getElementById('collaboration-workflow-editor-host'),
          { draft, readonly: !editable },
        );
      },
      onSubmit: !editable
        ? null
        : async () => {
            const request = buildCollaborationWorkflowRequest({
              expectedRevision: entry
                ? aggregateRevision(
                    group.projection,
                    'workflow_definition',
                    entry.definition.definition_id,
                  )
                : 0,
              draft: workflowEditor.getDraft(),
              launchPolicy: entry?.definition.launch_policy,
            });
            const editingDraft = entry && !newVersion;
            const body = editingDraft
              ? (({ definitionId: _definitionId, ...rest }) => rest)(request)
              : request;
            await options.request(
              editingDraft
                ? `/groups/${encodeURIComponent(group.groupId)}/workflow-definitions/${encodeURIComponent(entry.definition.definition_id)}/draft`
                : `/groups/${encodeURIComponent(group.groupId)}/workflow-definitions`,
              {
                method: editingDraft ? 'PUT' : 'POST',
                body: JSON.stringify(body),
              },
            );
            closeDialog();
            await loadDetail(group.groupId, false);
          },
    });
  };

  const newInstance = () => {
    const group = selectedGroup();
    const definitions = workflowDefinitionEntries().filter(
      (entry) => entry.definition.status === 'published',
    );
    openDialog({
      title: '新建工作流实例',
      body: `<div class="collaboration-form-grid">${field('工作流定义', 'definition', `${definitions[0]?.definition.definition_id}@${definitions[0]?.definition.version}`, { options: definitions.map((entry) => [`${entry.definition.definition_id}@${entry.definition.version}`, `${entry.definition.name} · v${entry.definition.version}`]) })}${field(
        '作用范围',
        'scope',
        'group',
        {
          options: [
            ['group', '整个群组'],
            ['work_item', '指定工作项'],
          ],
        },
      )}${field('工作项 ID', 'workItemId', '', { required: false })}${field('参与者绑定 JSON', 'participants', '{}', { multiline: true })}</div>`,
      onSubmit: async (formData) => {
        const [definitionId, version] = String(
          formData.get('definition'),
        ).split('@');
        const workItem = String(formData.get('workItemId') || '').trim();
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances`,
          {
            method: 'POST',
            body: JSON.stringify({
              definitionId,
              definitionVersion: Number(version),
              scope:
                formData.get('scope') === 'work_item'
                  ? { type: 'work_item', work_item_id: workItem }
                  : { type: 'group' },
              participantBindings: JSON.parse(
                String(formData.get('participants') || '{}'),
              ),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const selectedInstance = () =>
    selectedGroup().projection?.workflowInstances?.[state.selectedInstanceId];

  const completeTurn = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const turn = collaborationCurrentTurn(
      group.projection,
      instance.instance_id,
    );
    const definition = workflowDefinitionEntries().find(
      (entry) =>
        entry.definition.definition_id === instance.definition_id &&
        entry.definition.version === instance.definition_version,
    );
    const routes = collaborationOutcomeRoutes(definition, turn);
    const draft = collaborationTurnCompletionDraft(turn, routes);
    const artifactIds = [];
    let selectedFiles = null;
    openDialog({
      title: `完成：${workflowStateLabel(definition, turn.state_id)}`,
      body: `<div class="collaboration-form-grid">${field('执行结果', 'outcome', draft.outcome, { options: routes.map((route) => [route.outcome, `${collaborationLabel(route.label || route.outcome)} → ${workflowStateLabel(definition, route.target_state)}`]) })}${field('摘要', 'summary', draft.summary, { multiline: true })}${field('后续说明', 'instruction', draft.instruction, { multiline: true, required: false })}${field('标记', 'markers', draft.markers, { multiline: true, required: false })}${field('数据 JSON', 'data', draft.data, { multiline: true })}${field('产出物', 'artifacts', '', { type: 'file', required: false, multiple: true })}</div>`,
      onSubmit: async (formData) => {
        const fileControl = elements.dialogForm.elements.artifacts;
        if (selectedFiles === null) {
          selectedFiles = [...(fileControl?.files || [])];
          if (selectedFiles.length > 20)
            throw new Error('最多可添加 20 个产出物');
          if (selectedFiles.length) fileControl.disabled = true;
        }
        await stageCollaborationArtifactFiles({
          files: selectedFiles,
          artifactIds,
          request: options.request,
          endpoint: `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/turns/${encodeURIComponent(turn.turn_id)}/artifacts`,
          metadata: (file) => ({
            attempt: turn.attempt,
            fencingToken: turn.fencing_token,
            fileName: file.name,
            mediaType: file.type || 'application/octet-stream',
          }),
        });
        try {
          const currentGroup = selectedGroup();
          await options.request(
            `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/turns/${encodeURIComponent(turn.turn_id)}/complete`,
            {
              method: 'POST',
              body: JSON.stringify(
                buildCollaborationCompleteTurnRequest({
                  expectedRevision: aggregateRevision(
                    currentGroup.projection,
                    'workflow_instance',
                    instance.instance_id,
                  ),
                  turn,
                  outcome: formData.get('outcome'),
                  summary: formData.get('summary'),
                  instruction: formData.get('instruction') || '',
                  markers: formData.get('markers') || '',
                  data: JSON.parse(String(formData.get('data') || '{}')),
                  artifactIds,
                }),
              ),
            },
          );
        } catch (error) {
          if (/revision conflict|stale/iu.test(String(error)))
            await loadDetail(group.groupId, false);
          throw error;
        }
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const startCurrentTurn = async (executorId = null) => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const turn = collaborationCurrentTurn(
      group.projection,
      instance.instance_id,
    );
    if (!turn) throw new Error('工作流实例当前没有可执行轮次');
    await options.request(
      `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/turns/${encodeURIComponent(turn.turn_id)}/start`,
      {
        method: 'POST',
        body: JSON.stringify(
          buildCollaborationStartTurnRequest(
            aggregateRevision(
              group.projection,
              'workflow_instance',
              instance.instance_id,
            ),
            turn,
            executorId,
          ),
        ),
      },
    );
    await loadDetail(group.groupId, false);
  };

  const selectTurnExecutor = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const definition = workflowDefinitionEntries().find(
      (entry) =>
        entry.definition.definition_id === instance.definition_id &&
        entry.definition.version === instance.definition_version,
    );
    const turn = collaborationCurrentTurn(
      group.projection,
      instance.instance_id,
    );
    const executors = collaborationEligibleTurnExecutors(
      group,
      turn,
      state.detail.bindings,
    );
    if (!executors.length)
      throw new Error('没有匹配当前辅助执行轮次的本地执行器绑定');
    openDialog({
      title: `开始：${workflowStateLabel(definition, turn.state_id)}`,
      submitText: '开始执行',
      body: field('执行器', 'executorId', executors[0], {
        options: executors.map((executorId) => [executorId, executorId]),
      }),
      onSubmit: async (formData) => {
        await startCurrentTurn(formData.get('executorId'));
        closeDialog();
      },
    });
  };

  const configureExecution = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const turn = collaborationCurrentTurn(
      group.projection,
      instance.instance_id,
    );
    const stateId = turn?.state_id ?? instance.business_state;
    openDialog({
      title: `执行配置 · ${stateId}`,
      body: `<div class="collaboration-form-grid">${field(
        '执行模式',
        'mode',
        'manual',
        {
          options: [
            ['manual', '手动'],
            ['assisted', '辅助执行'],
            ['automatic', '自动执行'],
          ],
        },
      )}${field('操作 ID', 'actionId', '', { required: false })}${field('执行器 ID', 'executorId', '', { required: false })}${field(
        '执行器类型',
        'executorKind',
        'run_once',
        {
          options: [
            ['run_once', '单次运行'],
            ['workflow', '工作流'],
            ['external', '外部执行器'],
            ['codex', 'Codex'],
          ],
        },
      )}${field('工作区路径', 'workspacePath', '', { required: false })}${field(
        '文件系统权限',
        'filesystemAccess',
        'read_only',
        {
          options: [
            ['read_only', '只读'],
            ['workspace_write', '工作区可写'],
          ],
        },
      )}${field('审批策略', 'approvalPolicy', 'on-request', {
        options: [
          ['untrusted', '不受信任'],
          ['on-request', '按需询问'],
          ['never', '从不询问'],
        ],
      })}${field('配置 JSON', 'config', '{}', { multiline: true })}</div>`,
      onSubmit: async (formData) => {
        const values = Object.fromEntries(formData.entries());
        const manual = values.mode === 'manual';
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/states/${encodeURIComponent(stateId)}/execution`,
          {
            method: 'PUT',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'workflow_instance',
                instance.instance_id,
              ),
              mode: values.mode,
              actionId: manual ? null : values.actionId,
              ...(manual
                ? {}
                : {
                    binding: {
                      executorId: values.executorId,
                      executorKind: values.executorKind,
                      workspacePath: values.workspacePath,
                      filesystemAccess: values.filesystemAccess,
                      approvalPolicy: values.approvalPolicy,
                      config: JSON.parse(String(values.config || '{}')),
                      enabled: true,
                    },
                  }),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const backupDialog = (restore) =>
    openDialog({
      title: restore ? '恢复群组备份' : '创建群组备份',
      submitText: restore ? '确认恢复' : '创建备份',
      danger: restore,
      body: field('备份目录', 'backupDirectory', '', {
        required: restore,
      }),
      onSubmit: async (formData) => {
        const directory = formData.get('backupDirectory');
        await options.request(restore ? '/restore' : '/backup', {
          method: 'POST',
          body: JSON.stringify({
            ...(directory ? { backupDirectory: directory } : {}),
            ...(restore ? { confirm: 'RESTORE COLLABORATION V3' } : {}),
          }),
        });
        closeDialog();
        await loadGroups();
      },
    });

  const handleAction = async (button) => {
    const action = button.dataset.collaborationAction;
    const group = selectedGroup();
    if (action === 'go-activity') return selectTab('activity');
    if (action === 'request-join') return requestJoin();
    if (action === 'issue-invite') return issueInvite();
    if (action === 'revoke-invite') {
      const inviteId = button.dataset.inviteId;
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'invite',
              inviteId,
            ),
            reason: '从群组成员页面撤销邀请',
          }),
        },
      );
      return loadDetail(group.groupId, false);
    }
    if (action === 'approve-member') {
      const principalId = button.dataset.principalId;
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/join-requests/${encodeURIComponent(principalId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'membership',
              principalId,
            ),
          }),
        },
      );
      return loadDetail(group.groupId, false);
    }
    if (action === 'reject-member')
      return rejectMember(button.dataset.principalId);
    if (action === 'new-work-item') return newWorkItem();
    if (action === 'open-work-item') {
      state.selectedWorkItemId = button.dataset.workItemId;
      return renderContent();
    }
    if (action === 'close-work-item') {
      state.selectedWorkItemId = '';
      return renderContent();
    }
    if (action === 'work-view') {
      state.workItemView = button.dataset.view;
      return renderContent();
    }
    if (action === 'post-work-progress') return postWorkProgress();
    if (action === 'set-work-status') {
      const item = group.projection.workItems[state.selectedWorkItemId];
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}/status`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'work_item',
              item.work_item_id,
            ),
            status: button.dataset.status,
          }),
        },
      );
      return loadDetail(group.groupId, false);
    }
    if (action === 'new-discussion') return newDiscussion();
    if (action === 'open-discussion') {
      state.selectedDiscussionId = button.dataset.threadId;
      return renderContent();
    }
    if (action === 'close-discussion') {
      state.selectedDiscussionId = '';
      return renderContent();
    }
    if (action === 'new-message') return newMessage();
    if (action === 'upload-file') return uploadFile();
    if (action === 'open-file') {
      const path = button.dataset.repositoryPath;
      const indexed = (state.tabData.files || []).find(
        (file) => file.repositoryPath === path,
      );
      const url = options.fileUrl(
        `/api/collaboration/groups/${encodeURIComponent(group.groupId)}/files/content?path=${encodeURIComponent(path)}`,
      );
      const textMedia = /^(?:text\/|application\/(?:json|xml))/u.test(
        indexed?.metadata?.media_type || '',
      );
      state.filePreview = {
        name: indexed?.virtualPath || path,
        mediaType: indexed?.metadata?.media_type,
        url,
        text: textMedia
          ? await fetch(url).then((response) => response.text())
          : '',
      };
      return renderContent();
    }
    if (action === 'new-workflow') return openWorkflowEditor();
    if (action === 'view-workflow') {
      const entry = workflowDefinitionEntries().find(
        (candidate) =>
          `${candidate.definition.definition_id}@${candidate.definition.version}` ===
          button.dataset.definitionKey,
      );
      return openWorkflowEditor(entry);
    }
    if (action === 'new-workflow-version') {
      const entry = workflowDefinitionEntries().find(
        (candidate) =>
          `${candidate.definition.definition_id}@${candidate.definition.version}` ===
          button.dataset.definitionKey,
      );
      return openWorkflowEditor(entry, true);
    }
    if (action === 'publish-workflow') {
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/workflow-definitions/${encodeURIComponent(button.dataset.definitionId)}/publish`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'workflow_definition',
              button.dataset.definitionId,
            ),
            version: Number(button.dataset.version),
          }),
        },
      );
      return loadDetail(group.groupId, false);
    }
    if (action === 'new-instance') return newInstance();
    if (action === 'open-instance') {
      state.activeTab = 'workflows';
      state.selectedInstanceId = button.dataset.instanceId;
      updateRoute();
      return renderShell();
    }
    if (action === 'close-instance') {
      state.selectedInstanceId = '';
      return renderContent();
    }
    if (action === 'instance-command') {
      const instance = selectedInstance();
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/commands`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'workflow_instance',
              instance.instance_id,
            ),
            command: button.dataset.command,
          }),
        },
      );
      return loadDetail(group.groupId, false);
    }
    if (action === 'create-turn') {
      const instance = selectedInstance();
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/commands`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'workflow_instance',
              instance.instance_id,
            ),
            command: 'create_turn',
          }),
        },
      );
      return loadDetail(group.groupId, false);
    }
    if (action === 'start-turn') {
      const instance = selectedInstance();
      const turn = collaborationCurrentTurn(
        group.projection,
        instance.instance_id,
      );
      return turn.execution_mode === 'manual'
        ? startCurrentTurn()
        : selectTurnExecutor();
    }
    if (action === 'complete-turn') return completeTurn();
    if (action === 'configure-execution') return configureExecution();
    if (action === 'edit-permissions') {
      const principalId = button.dataset.principalId;
      const current =
        group.projection.permissionGrants?.[principalId]?.grants || [];
      return openDialog({
        title: '直接权限',
        body: field('权限项', 'grants', current.join(', ')),
        onSubmit: async (formData) => {
          await options.request(
            `/groups/${encodeURIComponent(group.groupId)}/permissions/${encodeURIComponent(principalId)}`,
            {
              method: 'PUT',
              body: JSON.stringify({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'membership',
                  principalId,
                ),
                grants: String(formData.get('grants') || '')
                  .split(',')
                  .map((grant) => grant.trim())
                  .filter(Boolean),
              }),
            },
          );
          closeDialog();
          await loadDetail(group.groupId, false);
        },
      });
    }
    if (action === 'backup' || action === 'restore')
      return backupDialog(action === 'restore');
    if (action === 'archive-group') {
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/archive`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'group',
              group.groupId,
            ),
            reason: '从群组设置页面归档',
          }),
        },
      );
      return loadDetail(group.groupId, false);
    }
    if (action === 'export-audit') {
      const blob = new Blob(
        [`${JSON.stringify(state.tabData.audit, null, 2)}\n`],
        {
          type: 'application/json',
        },
      );
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${group.groupId}-audit.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
    }
  };

  const restoreRoute = async (pathname) => {
    const route = parseCollaborationRoute(pathname);
    if (!route) return false;
    options.setPrimaryNav('groups', { updateRoute: false });
    state.activeTab = route.tab;
    if (!route.groupId) {
      state.selectedGroupId = '';
      state.detail = null;
      renderList();
      renderShell();
      return true;
    }
    await selectGroup(route.groupId, { tab: route.tab, updateRoute: false });
    return true;
  };

  const openNotification = async (groupId) => {
    options.setPrimaryNav('groups', { updateRoute: false });
    await selectGroup(groupId, { tab: 'overview' });
  };

  return {
    loadGroups,
    renderList,
    renderShell,
    selectGroup,
    selectTab,
    syncSelected,
    openCreate,
    openObserve,
    handleAction,
    closeDialog,
    restoreRoute,
    openNotification,
  };
}
