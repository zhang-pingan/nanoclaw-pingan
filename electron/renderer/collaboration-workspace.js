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
  collaborationArtifactName,
  collaborationAuditEventTimeline,
  buildCollaborationStartTurnRequest,
  collaborationCanApproveMembers,
  collaborationCanCreateTurn,
  collaborationCanMutate,
  collaborationCurrentTurn,
  collaborationDuration,
  collaborationEligibleTurnExecutors,
  collaborationElapsed,
  collaborationIsObserver,
  collaborationOutcomeRoutes,
  collaborationPendingNotifications,
  collaborationPrincipalName,
  stageCollaborationArtifactFiles,
  collaborationTurnAccess,
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
  return `<span class="collaboration-status ${statusTone(value)}">${html(label || 'unknown')}</span>`;
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
    elements.dialogSubmit.textContent = dialogOptions.submitText || 'Save';
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
              <span class="collaboration-list-meta"><span>${html(group.subscriptionMode)}</span><span>${html(group.lastVerifiedHead ? group.lastVerifiedHead.slice(0, 8) : 'not synced')}</span></span>
            </button>`,
          )
          .join('')
      : empty(state.loading ? 'Loading' : 'No project spaces');
  };

  const renderShell = () => {
    const group = selectedGroup();
    elements.empty.classList.toggle('hidden', Boolean(group));
    elements.detail.classList.toggle('hidden', !group);
    if (!group) return;
    elements.title.textContent = group.name;
    elements.lifecycle.className = `collaboration-status ${statusTone(group.lifecycle)}`;
    elements.lifecycle.textContent = group.lifecycle;
    elements.meta.innerHTML = `<span>${html(group.groupId)}</span><span>${html(group.subscriptionMode)}</span><span>${html(group.protocolStatus)}</span><span>${html(localDate(group.lastSyncAtMs))}</span>`;
    elements.tabs.forEach((button) =>
      button.classList.toggle(
        'active',
        button.dataset.collaborationTab === state.activeTab,
      ),
    );
    renderContent();
  };

  const renderObserverBand = (group) =>
    collaborationIsObserver(group)
      ? `<section class="collaboration-observer-band"><div><strong>Read-only Observer</strong><span>${html(group.lastVerifiedHead ? `Verified ${group.lastVerifiedHead.slice(0, 12)}` : 'Awaiting verified head')}</span></div><button type="button" class="btn-primary" data-collaboration-action="request-join">Request membership</button></section>`
      : '';

  const renderOverview = () => {
    const { group, notifications = [] } = state.detail;
    const projection = group.projection;
    const items = Object.values(projection?.workItems || {});
    const instances = Object.values(projection?.workflowInstances || {});
    const activity = (projection?.activity || []).slice(-8).reverse();
    return `${renderObserverBand(group)}
      <section class="collaboration-metrics">
        ${metric('Members', Object.values(projection?.members || {}).filter((member) => member.status === 'active').length)}
        ${metric('Open work', items.filter((item) => !['done', 'cancelled'].includes(item.status)).length)}
        ${metric('Workflow runs', instances.filter((instance) => instance.lifecycle !== 'closed').length)}
        ${metric('Notifications', notifications.length, notifications.length ? 'warning' : '')}
      </section>
      <section class="collaboration-section"><div class="collaboration-section-head"><h3>Project activity</h3><button type="button" class="btn-ghost" data-collaboration-action="go-activity">View all</button></div>
        <div class="collaboration-timeline">${activity.length ? activity.map((event) => `<article><span class="collaboration-timeline-marker"></span><div><strong>${html(event.eventType)}</strong><small>${html(event.actorPrincipalId)} · ${html(timestamp(event.occurredAt))}</small></div></article>`).join('') : empty('No activity')}</div>
      </section>
      <section class="collaboration-section collaboration-two-column"><div><div class="collaboration-section-head"><h3>Work Items</h3></div>${
        items
          .slice(0, 5)
          .map(
            (item) =>
              `<button type="button" class="collaboration-row-button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong>${status(item.status)}</button>`,
          )
          .join('') || empty('No Work Items')
      }</div><div><div class="collaboration-section-head"><h3>Workflow Instances</h3></div>${
        instances
          .slice(0, 5)
          .map(
            (instance) =>
              `<button type="button" class="collaboration-row-button" data-collaboration-action="open-instance" data-instance-id="${attr(instance.instance_id)}"><strong>${html(instance.definition_id)}</strong>${status(instance.lifecycle, instance.business_state)}</button>`,
          )
          .join('') || empty('No Instances')
      }</div></section>`;
  };

  const renderActivity = () => {
    const events = [...(selectedGroup().projection?.activity || [])].reverse();
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Activity</h3><span>${events.length}</span></div><div class="collaboration-timeline">${events.map((event) => `<article><span class="collaboration-timeline-marker"></span><div><strong>${html(event.eventType)}</strong><p>${html(event.aggregateType)} · ${html(event.aggregateId)} · rev ${html(event.aggregateRevision)}</p><small>${html(event.actorPrincipalId)} / ${html(event.actorClientId)} · ${html(timestamp(event.occurredAt))}</small></div></article>`).join('') || empty('No activity')}</div></section>`;
  };

  const renderWorkItemDetail = (item) => {
    const group = selectedGroup();
    const updates =
      group.projection?.workItemUpdates?.[item.work_item_id] || [];
    const mutable = collaborationCanMutate(group);
    return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-work-item">Back</button>${mutable ? '<button type="button" class="btn-ghost" data-collaboration-action="post-work-progress">Post progress</button>' : ''}</section>
      <section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(item.title)}</h3>${status(item.status)}</div><p class="collaboration-prose">${html(item.description || '')}</p><dl class="collaboration-definition-list"><div><dt>Owner</dt><dd>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</dd></div><div><dt>Priority</dt><dd>${html(item.priority)}</dd></div><div><dt>Due</dt><dd>${html(timestamp(item.due_at))}</dd></div><div><dt>Assignment</dt><dd>${html(item.assignment_status)}</dd></div><div><dt>Labels</dt><dd>${(item.labels || []).map((label) => `<code>${html(label)}</code>`).join(' ') || '-'}</dd></div><div><dt>Blocked by</dt><dd>${(item.blocked_by || []).map((id) => `<code>${html(id)}</code>`).join(' ') || '-'}</dd></div></dl>${mutable ? `<div class="collaboration-segmented">${['proposed', 'open', 'in_progress', 'blocked', 'done', 'cancelled'].map((value) => `<button type="button" data-collaboration-action="set-work-status" data-status="${value}" class="${item.status === value ? 'active' : ''}">${html(value)}</button>`).join('')}</div>` : ''}</section>
      <section class="collaboration-section"><div class="collaboration-section-head"><h3>Progress</h3><span>${updates.length}</span></div><div class="collaboration-record-list">${
        updates
          .slice()
          .reverse()
          .map(
            (update) =>
              `<article class="collaboration-record"><div><strong>${html(update.summary)}</strong><small>${html(collaborationPrincipalName(group.projection, update.actor_principal_id))} · ${html(timestamp(update.created_at))}</small>${renderArtifactRefs(group.projection, update.artifact_refs)}</div></article>`,
          )
          .join('') || empty('No progress')
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
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Work Items</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-work-item">New</button>' : ''}</div><div class="collaboration-view-toggle"><button type="button" data-collaboration-action="work-view" data-view="board" class="${state.workItemView !== 'list' ? 'active' : ''}">Board</button><button type="button" data-collaboration-action="work-view" data-view="list" class="${state.workItemView === 'list' ? 'active' : ''}">List</button></div>${state.workItemView === 'list' ? `<div class="collaboration-record-list">${items.map((item) => `<button type="button" class="collaboration-row-button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong><span>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</span>${status(item.status)}</button>`).join('') || empty('No Work Items')}</div>` : `<div class="collaboration-work-board">${statuses.map((column) => `<section><header><strong>${html(column)}</strong><span>${columns[column].length}</span></header>${columns[column].map((item) => `<button type="button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong><small>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</small><span>${html(item.priority)}</span></button>`).join('') || empty('Empty')}</section>`).join('')}</div>`}</section>`;
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
      return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-discussion">Back</button>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-message">Reply</button>' : ''}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(selected.discussion.title)}</h3>${status(selected.discussion.status)}</div><div class="collaboration-discussion-stream">${messages.map((message) => `<article><header><strong>${html(collaborationPrincipalName(group.projection, message.author_principal_id))}</strong><small>${html(timestamp(message.created_at))}</small></header><p>${message.tombstoned ? '<em>Message removed</em>' : html(message.body)}</p></article>`).join('') || empty('No messages')}</div></section>`;
    }
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Discussions</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-discussion">New</button>' : ''}</div><div class="collaboration-record-list">${threads.map((thread) => `<button type="button" class="collaboration-row-button" data-collaboration-action="open-discussion" data-thread-id="${attr(thread.discussion.thread_id)}"><strong>${html(thread.discussion.title)}</strong><span>${html(Object.keys(thread.messages || {}).length)} messages</span>${status(thread.discussion.status)}</button>`).join('') || empty('No Discussions')}</div></section>`;
  };

  const renderFiles = () => {
    const group = selectedGroup();
    const files = state.tabData.files || [];
    const tree = collaborationVerifiedFileTree(files);
    return `<section class="collaboration-files-layout"><aside><div class="collaboration-section-head"><h3>Verified files</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="upload-file">Upload</button>' : ''}</div>${renderTreeNode(tree)}</aside><main id="collaboration-file-preview">${state.filePreview ? `<header><strong>${html(state.filePreview.name)}</strong><small>${html(state.filePreview.mediaType)}</small></header>${state.filePreview.text ? `<pre>${html(state.filePreview.text)}</pre>` : `<a class="btn-primary" href="${attr(state.filePreview.url)}" download>Download</a>`}` : empty('Select a file')}</main></section>`;
  };

  const workflowDefinitionEntries = () =>
    Object.values(selectedGroup().projection?.workflowDefinitions || {});

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
      collaborationCanCreateTurn(instance, definition);
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
      ? `<dl class="collaboration-definition-list"><div><dt>State</dt><dd>${html(turn.state_id)}</dd></div><div><dt>Assignee</dt><dd>${html(collaborationPrincipalName(projection, turn.assignee_principal_id))}</dd></div><div><dt>Client</dt><dd>${html(turn.claimant_client_id || '-')}</dd></div><div><dt>Mode</dt><dd>${html(turn.execution_mode)}</dd></div><div><dt>Attempt</dt><dd>${html(turn.attempt)}</dd></div><div><dt>Deadline</dt><dd>${html(collaborationTurnDeadline(turn)?.deadlineAt || '-')}</dd></div></dl><div class="collaboration-record-actions">${access.canStart ? '<button type="button" class="btn-primary" data-collaboration-action="start-turn">Start Turn</button>' : ''}${access.canComplete ? '<button type="button" class="btn-primary" data-collaboration-action="complete-turn">Complete</button>' : ''}${collaborationCanMutate(group) && turn.assignee_principal_id === group.localPrincipalId ? '<button type="button" class="btn-ghost" data-collaboration-action="configure-execution">Execution</button>' : ''}</div><div class="collaboration-outcome-preview">${routes.map((route) => `<span><strong>${html(route.outcome)}</strong> → ${html(route.target_state)}</span>`).join('')}</div>`
      : `<div class="collaboration-section-empty">${instance.lifecycle === 'running' ? `Ready for ${html(instance.business_state)}` : 'No active Turn'}</div><div class="collaboration-record-actions">${currentAssignedToLocal ? '<button type="button" class="btn-ghost" data-collaboration-action="configure-execution">Execution</button>' : ''}${canCreateTurn ? `<button type="button" class="btn-primary" data-collaboration-action="create-turn">${turns.length ? 'Continue' : 'Create Turn'}</button>` : ''}</div>`;
    return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-instance">Back</button>${collaborationCanMutate(group) ? `<button type="button" class="btn-ghost" data-collaboration-action="instance-command" data-command="${instance.lifecycle === 'draft' || instance.lifecycle === 'ready' ? 'start' : instance.lifecycle === 'paused' ? 'resume' : 'pause'}">${instance.lifecycle === 'paused' ? 'Resume' : instance.lifecycle === 'running' ? 'Pause' : 'Start'}</button>` : ''}</section><section class="collaboration-metrics">${metric('Lifecycle', instance.lifecycle)}${metric('State', instance.business_state)}${metric('Epoch', instance.epoch)}${metric('Turns', turns.length)}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(instance.definition_id)} · ${html(instance.instance_id)}</h3>${status(instance.lifecycle)}</div><div id="collaboration-instance-graph"></div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Current Turn</h3>${turn ? status(turn.state) : ''}</div>${currentTurn}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Turn history</h3><span>${turns.length}</span></div>${turns.map((item) => `<article class="collaboration-record"><div><strong>${html(item.state_id)}</strong><small>${html(timestamp(item.created_at))}${item.outcome ? ` · ${html(item.outcome)}` : ''}</small>${renderArtifactRefs(projection, item.artifact_refs)}</div>${status(item.state)}</article>`).join('') || empty('No Turns')}</section>`;
  };

  const renderWorkflows = () => {
    const group = selectedGroup();
    const instances = Object.values(group.projection?.workflowInstances || {});
    const selectedInstance = instances.find(
      (instance) => instance.instance_id === state.selectedInstanceId,
    );
    if (selectedInstance) return renderInstanceDetail(selectedInstance);
    const definitions = workflowDefinitionEntries();
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Workflow Definitions</h3>${collaborationCanMutate(group) ? '<button type="button" class="btn-primary" data-collaboration-action="new-workflow">New</button>' : ''}</div><div class="collaboration-record-list">${definitions.map((entry) => `<article class="collaboration-record"><div><strong>${html(entry.definition.name)}</strong><small>${html(entry.definition.definition_id)} · v${html(entry.definition.version)}</small></div>${status(entry.definition.status)}<div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="view-workflow" data-definition-key="${attr(entry.definition.definition_id)}@${attr(entry.definition.version)}">Open</button>${entry.definition.status === 'published' && collaborationWorkflowEditable(group, entry) ? `<button type="button" class="btn-ghost" data-collaboration-action="new-workflow-version" data-definition-key="${attr(entry.definition.definition_id)}@${attr(entry.definition.version)}">New version</button>` : ''}${collaborationWorkflowPublishable(group, entry) ? `<button type="button" class="btn-primary" data-collaboration-action="publish-workflow" data-definition-id="${attr(entry.definition.definition_id)}" data-version="${attr(entry.definition.version)}">Publish</button>` : ''}</div></article>`).join('') || empty('No Workflow Definitions')}</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Workflow Instances</h3>${collaborationCanMutate(group) && definitions.some((entry) => entry.definition.status === 'published') ? '<button type="button" class="btn-primary" data-collaboration-action="new-instance">New</button>' : ''}</div><div class="collaboration-record-list">${instances.map((instance) => `<button type="button" class="collaboration-row-button" data-collaboration-action="open-instance" data-instance-id="${attr(instance.instance_id)}"><strong>${html(instance.definition_id)}</strong><span>${html(instance.business_state)} · ${html(instance.scope.type)}</span>${status(instance.lifecycle)}</button>`).join('') || empty('No Workflow Instances')}</div></section>`;
  };

  const renderMembers = () => {
    const group = selectedGroup();
    const projection = group.projection;
    const canApprove = collaborationCanApproveMembers(group);
    const invites = Object.values(projection?.invites || {});
    const inviteSection =
      projection?.group?.membership_policy?.join === 'invite_only'
        ? `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Invites</h3>${canApprove ? '<button type="button" class="btn-primary" data-collaboration-action="issue-invite">Issue</button>' : ''}</div><div class="collaboration-record-list">${invites.map((invite) => `<article class="collaboration-record"><div><strong>${html(collaborationPrincipalName(projection, invite.principal_id))}</strong><small>${html(invite.invite_id)} · ${html(invite.expires_at ? timestamp(invite.expires_at) : 'No expiry')}</small></div>${status(invite.status)}${canApprove && invite.status === 'active' ? `<button type="button" class="btn-ghost" data-collaboration-action="revoke-invite" data-invite-id="${attr(invite.invite_id)}">Revoke</button>` : ''}</article>`).join('') || empty('No Invites')}</div></section>`
        : '';
    return `${inviteSection}<section class="collaboration-section"><div class="collaboration-section-head"><h3>Principals</h3><span>${Object.keys(projection?.members || {}).length}</span></div><div class="collaboration-record-list">${Object.values(
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
            ? `<div class="collaboration-record-actions"><button type="button" class="btn-primary" data-collaboration-action="approve-member" data-principal-id="${attr(member.principal_id)}">Approve</button><button type="button" class="btn-danger-soft" data-collaboration-action="reject-member" data-principal-id="${attr(member.principal_id)}">Reject</button></div>`
            : '';
        return `<article class="collaboration-record"><div><strong>${html(member.display_name)}</strong><small>${html(member.principal_id)} · ${clients.length} Clients</small><p>${grants.map((grant) => `<code>${html(grant)}</code>`).join(' ') || 'No direct grants'}</p></div>${status(member.status)}${approvalActions}${group.localPrincipalId === group.ownerPrincipalId && collaborationCanMutate(group) && member.status === 'active' ? `<button type="button" class="btn-ghost" data-collaboration-action="edit-permissions" data-principal-id="${attr(member.principal_id)}">Permissions</button>` : ''}</article>`;
      })
      .join('')}</div></section>`;
  };

  const renderAudit = () => {
    const audit = state.tabData.audit;
    if (!audit) return empty('Loading audit');
    const events = collaborationAuditEventTimeline(audit.events);
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Audit</h3><button type="button" class="btn-ghost" data-collaboration-action="export-audit">Export JSON</button></div><section class="collaboration-metrics">${metric('Aggregates', Object.keys(audit.aggregates || {}).length)}${metric('Events', events.length)}${metric('Local evidence', audit.local_evidence?.length || 0)}${metric('Head', audit.group?.last_verified_head?.slice(0, 10) || '-')}</section><div class="collaboration-timeline">${events
      .slice()
      .reverse()
      .map(
        (event) =>
          `<article><span class="collaboration-timeline-marker"></span><div><strong>${html(event.event_type)}</strong><p>${html(event.aggregate_type)} · ${html(event.aggregate_id)} · rev ${html(event.aggregate_revision)}</p><small>commit ${html(event.commit_hash?.slice(0, 12))} · ${html(timestamp(event.occurred_at))}</small></div></article>`,
      )
      .join('')}</div></section>`;
  };

  const renderSettings = () => {
    const group = selectedGroup();
    return `${renderObserverBand(group)}<section class="collaboration-section"><div class="collaboration-section-head"><h3>Project space</h3></div><dl class="collaboration-definition-list"><div><dt>Group</dt><dd>${html(group.groupId)}</dd></div><div><dt>Remote</dt><dd>${html(group.remoteUrl)}</dd></div><div><dt>Mode</dt><dd>${html(group.subscriptionMode)}</dd></div><div><dt>Protocol</dt><dd>${html(group.protocolStatus)}</dd></div><div><dt>Verified head</dt><dd>${html(group.lastVerifiedHead || '-')}</dd></div></dl><div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="backup">Backup</button><button type="button" class="btn-ghost" data-collaboration-action="restore">Restore</button>${group.localPrincipalId === group.ownerPrincipalId && group.lifecycle === 'active' ? '<button type="button" class="btn-danger-soft" data-collaboration-action="archive-group">Archive</button>' : ''}</div></section>`;
  };

  const renderDiagnostics = () => {
    const data = state.tabData.diagnostics;
    if (!data) return empty('Loading diagnostics');
    return `<section class="collaboration-metrics">${metric('Protocol', data.group?.protocolStatus || '-')}${metric('Sync attempts', data.syncAttempts?.length || 0)}${metric('Incidents', data.integrityIncidents?.length || 0, data.integrityIncidents?.length ? 'danger' : '')}${metric('Scheduler', data.scheduler?.running ? 'running' : 'stopped')}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Sync</h3></div><div class="collaboration-record-list">${(data.syncAttempts || []).map((attempt) => `<article class="collaboration-record"><strong>${html(attempt.outcome)}</strong><span>${html(localDate(attempt.started_at_ms || attempt.startedAtMs))}</span><small>${html(attempt.error || '')}</small></article>`).join('') || empty('No sync attempts')}</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Integrity</h3></div>${(data.integrityIncidents || []).map((incident) => `<article class="collaboration-record"><strong>${html(incident.code)}</strong><p>${html(incident.message)}</p></article>`).join('') || empty('No incidents')}</section>`;
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
    elements.content.innerHTML = empty('Loading project space');
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
        state.status?.available
          ? ''
          : state.status?.error || 'Collaboration unavailable',
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
    options.showToast('Project space synced');
  };

  const openCreate = () =>
    openDialog({
      title: 'Create project space',
      submitText: 'Create',
      body: `<div class="collaboration-form-grid">${field('Name', 'name')}${field('Git remote', 'remoteUrl')}${field('SSH signing key', 'signingKeyPath')}${field('Principal name', 'displayName')}${field('Client name', 'clientDisplayName')}${field(
        'Membership',
        'membershipPolicy',
        'approval',
        {
          options: [
            ['open', 'Open'],
            ['approval', 'Approval'],
            ['invite_only', 'Invite only'],
          ],
        },
      )}${field('Observer access', 'observerAccess', 'allowed', {
        options: [
          ['allowed', 'Allowed'],
          ['members_only', 'Members only'],
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
      title: 'Observe project space',
      submitText: 'Observe',
      body: field('Git remote', 'remoteUrl'),
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
      title: 'Request membership',
      submitText: 'Submit',
      body: `<div class="collaboration-form-grid">${field('SSH signing key', 'signingKeyPath')}${field('Principal name', 'displayName')}${field('Client name', 'clientDisplayName')}${inviteOnly ? field('Invite ID', 'inviteId') : ''}</div>`,
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
      title: 'Issue Invite',
      submitText: 'Issue',
      body: `<div class="collaboration-form-grid">${field('Principal ID', 'principalId')}${field('Expires at', 'expiresAt', '', { required: false })}</div>`,
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
      title: 'Reject membership',
      submitText: 'Reject',
      danger: true,
      body: field('Reason', 'reason', '', { multiline: true }),
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
      title: 'New Work Item',
      body: `<div class="collaboration-form-grid">${field(
        'Type',
        'type',
        'task',
        {
          options: [
            ['task', 'Task'],
            ['issue', 'Issue'],
            ['decision', 'Decision'],
            ['milestone', 'Milestone'],
          ],
        },
      )}${field('Title', 'title')}${field('Description', 'description', '', { multiline: true, required: false })}${field(
        'Priority',
        'priority',
        'normal',
        {
          options: [
            ['low', 'Low'],
            ['normal', 'Normal'],
            ['high', 'High'],
            ['urgent', 'Urgent'],
          ],
        },
      )}${field('Due at', 'dueAt', '', { required: false })}</div>`,
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
      title: 'Post progress',
      body: `<div class="collaboration-form-grid">${field('Summary', 'summary', '', { multiline: true })}${field('Artifacts', 'artifacts', '', { type: 'file', required: false, multiple: true })}</div>`,
      onSubmit: async (formData) => {
        const fileControl = elements.dialogForm.elements.artifacts;
        if (selectedFiles === null) {
          selectedFiles = [...(fileControl?.files || [])];
          if (selectedFiles.length > 20)
            throw new Error('At most 20 Artifacts may be attached');
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
      title: 'New Discussion',
      body: field('Title', 'title'),
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
      title: 'Reply',
      body: field('Message', 'body', '', { multiline: true }),
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
      title: 'Upload file',
      body: `<div class="collaboration-form-grid">${field(
        'Scope',
        'scope',
        'shared',
        {
          options: [
            ['shared', 'Shared'],
            ['me', 'Principal'],
          ],
        },
      )}${field('File', 'file', '', { type: 'file' })}</div>`,
      onSubmit: async (formData) => {
        const fileValue = elements.dialogForm.elements.file?.files?.[0];
        if (!fileValue) throw new Error('File is required');
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
        : 'New Workflow Definition',
      submitText: entry && !newVersion ? 'Save draft' : 'Create draft',
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
      title: 'New Workflow Instance',
      body: `<div class="collaboration-form-grid">${field('Definition', 'definition', `${definitions[0]?.definition.definition_id}@${definitions[0]?.definition.version}`, { options: definitions.map((entry) => [`${entry.definition.definition_id}@${entry.definition.version}`, `${entry.definition.name} · v${entry.definition.version}`]) })}${field(
        'Scope',
        'scope',
        'group',
        {
          options: [
            ['group', 'Group'],
            ['work_item', 'Work Item'],
          ],
        },
      )}${field('Work Item ID', 'workItemId', '', { required: false })}${field('Participant bindings JSON', 'participants', '{}', { multiline: true })}</div>`,
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
    const artifactIds = [];
    let selectedFiles = null;
    openDialog({
      title: `Complete ${turn.state_id}`,
      body: `<div class="collaboration-form-grid">${field('Outcome', 'outcome', routes[0]?.outcome, { options: routes.map((route) => [route.outcome, `${route.label} → ${route.target_state}`]) })}${field('Summary', 'summary', '', { multiline: true })}${field('Instruction', 'instruction', '', { multiline: true, required: false })}${field('Data JSON', 'data', '{}', { multiline: true })}${field('Artifacts', 'artifacts', '', { type: 'file', required: false, multiple: true })}</div>`,
      onSubmit: async (formData) => {
        const fileControl = elements.dialogForm.elements.artifacts;
        if (selectedFiles === null) {
          selectedFiles = [...(fileControl?.files || [])];
          if (selectedFiles.length > 20)
            throw new Error('At most 20 Artifacts may be attached');
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
              body: JSON.stringify({
                expectedRevision: aggregateRevision(
                  currentGroup.projection,
                  'workflow_instance',
                  instance.instance_id,
                ),
                attempt: turn.attempt,
                fencingToken: turn.fencing_token,
                outcome: formData.get('outcome'),
                summary: formData.get('summary'),
                instruction: formData.get('instruction') || '',
                data: JSON.parse(String(formData.get('data') || '{}')),
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

  const startCurrentTurn = async (executorId = null) => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const turn = collaborationCurrentTurn(
      group.projection,
      instance.instance_id,
    );
    if (!turn) throw new Error('Workflow Instance has no active Turn');
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
      throw new Error(
        'No enabled local Executor Binding matches this assisted Turn',
      );
    openDialog({
      title: `Start ${turn.state_id}`,
      submitText: 'Start',
      body: field('Executor', 'executorId', executors[0], {
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
      title: `Execution · ${stateId}`,
      body: `<div class="collaboration-form-grid">${field(
        'Mode',
        'mode',
        'manual',
        {
          options: [
            ['manual', 'Manual'],
            ['assisted', 'Assisted'],
            ['automatic', 'Automatic'],
          ],
        },
      )}${field('Action ID', 'actionId', '', { required: false })}${field('Executor ID', 'executorId', '', { required: false })}${field(
        'Executor kind',
        'executorKind',
        'run_once',
        {
          options: [
            ['run_once', 'Run once'],
            ['workflow', 'Workflow'],
            ['external', 'External'],
            ['codex', 'Codex'],
          ],
        },
      )}${field('Workspace path', 'workspacePath', '', { required: false })}${field(
        'Filesystem',
        'filesystemAccess',
        'read_only',
        {
          options: [
            ['read_only', 'Read only'],
            ['workspace_write', 'Workspace write'],
          ],
        },
      )}${field('Approval', 'approvalPolicy', 'on-request', {
        options: [
          ['untrusted', 'Untrusted'],
          ['on-request', 'On request'],
          ['never', 'Never'],
        ],
      })}${field('Config JSON', 'config', '{}', { multiline: true })}</div>`,
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
      title: restore ? 'Restore backup' : 'Create backup',
      submitText: restore ? 'Restore' : 'Create',
      danger: restore,
      body: field('Backup directory', 'backupDirectory', '', {
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
            reason: 'Revoked from project-space members view',
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
        title: 'Direct permissions',
        body: field('Grants', 'grants', current.join(', ')),
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
            reason: 'Archived from project-space settings',
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
