import {
  buildCollaborationCreateRequest,
  buildCollaborationJoinRequest,
  buildCollaborationWorkflowInstanceRequest,
  buildCollaborationWorkflowRequest,
  COLLABORATION_WORK_ITEM_STATUSES,
  collaborationDraftFromDefinition,
  collaborationWorkflowBindingSuggestions,
  collaborationWorkflowParticipantSlots,
  defaultCollaborationWorkflowDraft,
} from './collaboration-definition.js';
import {
  collaborationRuntimeGraphHighlights,
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
  buildCollaborationActionApplyRequest,
  buildCollaborationActionPreviewRequest,
  buildCollaborationAnalysisRunRequest,
  buildCollaborationAssignmentDecisionRequest,
  buildCollaborationCompleteTurnRequest,
  buildCollaborationDiscussionMessageRequest,
  buildCollaborationMemberNotificationRequest,
  buildCollaborationReasonRequest,
  buildCollaborationActionMutationRequest,
  buildCollaborationExecutorRegistrationRequest,
  buildCollaborationStateExecutionRequest,
  buildCollaborationWorkItemAssignmentRequest,
  buildCollaborationWorkItemDetailsRequest,
  buildCollaborationWorkItemRelationsRequest,
  buildCollaborationExternalResultRequest,
  buildCollaborationFindingDecisionRequest,
  buildCollaborationLifecycleRequest,
  buildCollaborationRecoverTurnRequest,
  buildCollaborationStartTurnRequest,
  buildCollaborationTurnCancellationRequest,
  buildCollaborationWorkflowReassignmentRequest,
  collaborationActiveMemberOptions,
  collaborationAnalysisRunAccess,
  collaborationActionAllowed,
  collaborationActionType,
  collaborationAvailableLocalExecutors,
  collaborationCanApproveMembers,
  collaborationCanAnswerWorkItemAssignment,
  collaborationCanDissolve,
  collaborationCanLeave,
  collaborationCanRecoverTurn,
  collaborationCanDecideRecovery,
  collaborationCanCreateTurn,
  collaborationCanInitializeGroup,
  collaborationCanMutate,
  collaborationCurrentTurn,
  collaborationDuration,
  collaborationDiscussionMessageActionAllowed,
  collaborationEligibleTurnExecutors,
  collaborationElapsed,
  collaborationFileById,
  collaborationFindingActionDraft,
  collaborationFindingActionTypes,
  collaborationIsObserver,
  collaborationLocalMembershipStatus,
  collaborationLocalCredential,
  collaborationNotificationScope,
  collaborationOutcomeRoutes,
  collaborationOwnedActions,
  collaborationPrincipalName,
  collaborationResourceTarget,
  collaborationShortId,
  stageCollaborationArtifactFiles,
  collaborationTurnAccess,
  collaborationTurnCompletionDraft,
  collaborationTurnDeadline,
  collaborationTurnHistory,
  collaborationTurnLifecycle,
  collaborationVerifiedFileTree,
  collaborationWorkflowLaunchAccess,
  collaborationWorkflowInstanceCommand,
  collaborationWorkflowStateActionAccess,
  collaborationWorkflowTurnActionAllowed,
  collaborationWorkItemStatusActionAccess,
  collaborationWorkItemColumns,
} from './collaboration-ui.js';

export const collaborationRouteTabs = new Set([
  'overview',
  'activity',
  'work-items',
  'discussions',
  'files',
  'workflows',
  'analysis',
  'members',
  'audit',
  'settings',
  'diagnostics',
]);

export const collaborationInitializeConfirmation =
  '初始化会清除全部成员、任务、文件、Workflow、事件、审计和 Git 历史，无法恢复。';

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
    [
      'active',
      'running',
      'ready',
      'verified',
      'healthy',
      'done',
      'completed',
      'applied',
    ].includes(normalized)
  )
    return 'success';
  if (
    [
      'blocked',
      'failed',
      'invalid',
      'critical',
      'high',
      'at_risk',
      'recovery_required',
      'protocol_quarantined',
    ].includes(normalized)
  )
    return 'danger';
  if (
    [
      'paused',
      'waiting_input',
      'waiting_approval',
      'awaiting_external_result',
      'validating',
      'needs_attention',
      'medium',
      'pending',
      'stale',
    ].includes(normalized)
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
  const disabled = options.disabled ? 'disabled' : '';
  const control = options.multiline
    ? `<textarea name="${attr(name)}" ${options.required === false ? '' : 'required'} ${disabled}>${html(value)}</textarea>`
    : options.options
      ? `<select name="${attr(name)}" ${disabled}>${options.options
          .map(
            ([id, text]) =>
              `<option value="${attr(id)}" ${String(value) === String(id) ? 'selected' : ''}>${html(text)}</option>`,
          )
          .join('')}</select>`
      : `<input name="${attr(name)}" value="${attr(value)}" ${options.type ? `type="${attr(options.type)}"` : ''} ${options.multiple ? 'multiple' : ''} ${options.required === false ? '' : 'required'} ${disabled}>`;
  return `<label class="collaboration-field"><span>${html(label)}</span>${control}${options.hint ? `<small>${html(options.hint)}</small>` : ''}</label>`;
}

function collaborationActiveNotificationMembers(group) {
  return Object.values(group?.projection?.members || {})
    .filter(
      (member) =>
        member.status === 'active' &&
        member.principal_id !== group.localPrincipalId,
    )
    .sort(
      (left, right) =>
        left.display_name.localeCompare(right.display_name) ||
        left.principal_id.localeCompare(right.principal_id),
    );
}

function memberPicker(group, options = {}) {
  const members = collaborationActiveNotificationMembers(group);
  const selected = new Set(options.selected || []);
  const name = options.name || 'recipientPrincipalIds';
  return `<fieldset class="collaboration-member-picker" data-member-picker><legend>${html(options.legend || '选择成员')}</legend><div class="collaboration-member-picker-tools"><label><span class="sr-only">搜索成员</span><input type="search" placeholder="搜索名称或短 ID" data-member-picker-search></label><div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-member-picker-action="all">全选</button><button type="button" class="btn-ghost" data-member-picker-action="clear">清除</button></div></div><div class="collaboration-member-picker-list">${members
    .map(
      (member) =>
        `<label data-member-picker-option data-member-search="${attr(`${member.display_name} ${collaborationShortId(member.principal_id)}`.toLowerCase())}"><input type="checkbox" name="${attr(name)}" value="${attr(member.principal_id)}" ${selected.has(member.principal_id) ? 'checked' : ''}><span><strong>${html(member.display_name)}</strong><small>${html(collaborationShortId(member.principal_id))}</small></span></label>`,
    )
    .join('') || empty('没有可选择的 Active Member')}</div><small class="collaboration-member-picker-count" data-member-picker-count></small></fieldset>`;
}

function bindMemberPicker(root) {
  root.querySelectorAll('[data-member-picker]').forEach((picker) => {
    const options = [...picker.querySelectorAll('[data-member-picker-option]')];
    const count = picker.querySelector('[data-member-picker-count]');
    const updateCount = () => {
      const selected = options.filter(
        (option) => option.querySelector('input')?.checked,
      ).length;
      if (count) count.textContent = `已选择 ${selected} / ${options.length}`;
    };
    picker
      .querySelector('[data-member-picker-search]')
      ?.addEventListener('input', (event) => {
        const query = String(event.target.value || '')
          .trim()
          .toLowerCase();
        options.forEach((option) =>
          option.classList.toggle(
            'hidden',
            Boolean(query && !option.dataset.memberSearch.includes(query)),
          ),
        );
      });
    picker.addEventListener('click', (event) => {
      const action = event.target.closest('[data-member-picker-action]')
        ?.dataset.memberPickerAction;
      if (!action) return;
      options.forEach((option) => {
        const input = option.querySelector('input');
        if (input) input.checked = action === 'all';
      });
      updateCount();
    });
    picker.addEventListener('change', updateCount);
    updateCount();
  });
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
  state.selectedAnalysisId ||= '';
  state.selectedFileId ||= '';
  state.overviewOnlyMine ??= false;
  state.overviewRiskOnly ??= false;
  state.notificationSeverity ||= '';
  state.notificationResourceType ||= '';
  state.permissionCatalog ||= { permissions: [], templates: [] };
  const elements = {
    banner: document.getElementById('collaboration-runtime-banner'),
    list: document.getElementById('collaboration-list'),
    search: document.getElementById('collaboration-search'),
    empty: document.getElementById('collaboration-empty'),
    detail: document.getElementById('collaboration-detail'),
    title: document.getElementById('collaboration-title'),
    lifecycle: document.getElementById('collaboration-lifecycle'),
    meta: document.getElementById('collaboration-detail-meta'),
    notify: document.getElementById('collaboration-notify-btn'),
    content: document.getElementById('collaboration-content'),
    dialog: document.getElementById('collaboration-dialog'),
    dialogForm: document.getElementById('collaboration-dialog-form'),
    dialogTitle: document.getElementById('collaboration-dialog-title'),
    dialogBody: document.getElementById('collaboration-dialog-body'),
    dialogError: document.getElementById('collaboration-dialog-error'),
    dialogSubmit: document.getElementById('collaboration-dialog-submit'),
    contextMenu: document.getElementById('collaboration-group-context-menu'),
    tabs: [...document.querySelectorAll('[data-collaboration-tab]')],
  };
  let workflowEditor = null;
  let analysisPollTimer = null;
  let analysisPollCount = 0;

  const selectedGroup = () =>
    state.detail?.group ||
    state.groups.find((group) => group.groupId === state.selectedGroupId) ||
    null;

  const groupAction = (action) =>
    collaborationActionAllowed(selectedGroup(), action);
  const resourceAction = (type, id, action) =>
    collaborationActionAllowed(selectedGroup(), action, type, id);
  const permissionTemplates = () =>
    selectedGroup()?.allowedActions?.catalogs?.templates ||
    state.permissionCatalog.templates ||
    [];
  const permissionCatalog = () =>
    selectedGroup()?.allowedActions?.catalogs?.permissions ||
    state.permissionCatalog.permissions ||
    [];

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
    elements.dialogSubmit.disabled = false;
    elements.dialogSubmit.removeAttribute('title');
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

  const closeGroupContextMenu = () => {
    elements.contextMenu?.classList.add('hidden');
    state.contextGroupId = '';
  };

  elements.list?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-collaboration-group-id]');
    if (!(button instanceof HTMLButtonElement)) return;
    closeGroupContextMenu();
    void selectGroup(button.dataset.collaborationGroupId);
  });

  elements.list?.addEventListener('contextmenu', (event) => {
    const button = event.target.closest('[data-collaboration-group-id]');
    if (!(button instanceof HTMLButtonElement) || !elements.contextMenu) return;
    event.preventDefault();
    state.contextGroupId = button.dataset.collaborationGroupId || '';
    elements.contextMenu.style.left = `${Math.max(
      8,
      Math.min(event.clientX, window.innerWidth - 190),
    )}px`;
    elements.contextMenu.style.top = `${Math.max(
      8,
      Math.min(event.clientY, window.innerHeight - 56),
    )}px`;
    elements.contextMenu.classList.remove('hidden');
  });

  elements.contextMenu?.addEventListener('click', () => {
    const group = state.groups.find(
      (candidate) => candidate.groupId === state.contextGroupId,
    );
    closeGroupContextMenu();
    if (group) openLifecycleConfirmation('remove-local', group);
  });

  document.addEventListener('click', (event) => {
    if (!elements.contextMenu?.contains(event.target)) closeGroupContextMenu();
  });

  const renderShell = () => {
    const group = selectedGroup();
    elements.empty.classList.toggle('hidden', Boolean(group));
    elements.detail.classList.toggle('hidden', !group);
    if (!group) return;
    elements.title.textContent = group.name;
    elements.lifecycle.className = `collaboration-status ${statusTone(group.lifecycle)}`;
    elements.lifecycle.textContent = collaborationStatusLabel(group.lifecycle);
    elements.notify?.classList.toggle('hidden', !groupAction('notifyMembers'));
    const membershipStatus = collaborationLocalMembershipStatus(group);
    elements.meta.innerHTML = `<span>${html(group.groupId)}</span><span>${html(group.subscriptionMode === 'member' ? `成员 · ${collaborationStatusLabel(membershipStatus)}` : '观察者')}</span><span>${html(collaborationStatusLabel(group.protocolStatus))}</span><span>${html(localDate(group.lastSyncAtMs))}</span>`;
    elements.tabs.forEach((button) =>
      button.classList.toggle(
        'active',
        button.dataset.collaborationTab === state.activeTab,
      ),
    );
    renderContent();
    scheduleAnalysisPoll();
  };

  const renderObserverBand = (group) => {
    if (collaborationIsObserver(group))
      return `<section class="collaboration-observer-band"><div><strong>Icarus 业务只读</strong><span>${html(group.lastVerifiedHead ? `已验证 ${group.lastVerifiedHead.slice(0, 12)}` : '正在等待验证版本')}</span></div><div class="collaboration-record-actions">${groupAction('requestRecovery') ? '<button type="button" class="btn-ghost" data-collaboration-action="request-recovery">恢复已有身份</button>' : ''}${groupAction('requestJoin') ? '<button type="button" class="btn-primary" data-collaboration-action="request-join">申请新成员身份</button>' : ''}</div></section>`;
    const membershipStatus = collaborationLocalMembershipStatus(group);
    return membershipStatus === 'active'
      ? ''
      : `<section class="collaboration-observer-band"><div><strong>成员状态：${html(collaborationStatusLabel(membershipStatus))}</strong><span>成员资格生效前，群组写入功能保持禁用。</span></div></section>`;
  };

  const severityTone = (value) =>
    ['critical', 'high', 'at_risk', 'failed', 'invalid'].includes(value)
      ? 'danger'
      : [
            'medium',
            'needs_attention',
            'stale',
            'awaiting_external_result',
            'validating',
          ].includes(value)
        ? 'warning'
        : '';

  const renderNavigationButton = (input, action, label = input.title) =>
    `<button type="button" class="collaboration-row-button" data-collaboration-action="${attr(action)}" data-resource-type="${attr(input.resource_type || input.resourceType)}" data-resource-id="${attr(input.resource_id || input.resourceId)}"><span class="collaboration-row-copy"><strong>${html(label)}</strong><small>${html(collaborationLabel(input.reason || ''))}${input.due_at ? ` · ${html(timestamp(input.due_at))}` : ''}</small></span>${status(input.severity || 'info')}</button>`;

  const renderMyItems = (items) => {
    const labels = {
      needs_action: '需要处理',
      at_risk: '存在风险',
      waiting_on_others: '等待他人',
      watching: '关注中',
      recently_resolved: '最近解决',
    };
    const visible = state.overviewRiskOnly
      ? items.filter((item) =>
          ['critical', 'high', 'medium'].includes(item.severity),
        )
      : items;
    return Object.entries(labels)
      .map(([groupName, label]) => {
        const grouped = visible.filter((item) => item.group === groupName);
        if (!grouped.length) return '';
        return `<section class="collaboration-item-group"><header><strong>${html(label)}</strong><span>${grouped.length}</span></header>${grouped.map((item) => renderNavigationButton(item, 'open-overview-resource')).join('')}</section>`;
      })
      .join('');
  };

  const renderNotifications = (notifications) => {
    const severityFiltered = state.overviewRiskOnly
      ? notifications.filter((entry) =>
          ['critical', 'high', 'medium'].includes(entry.severity),
        )
      : notifications;
    const visible = severityFiltered.filter(
      (entry) =>
        (!state.notificationSeverity ||
          entry.severity === state.notificationSeverity) &&
        (!state.notificationResourceType ||
          entry.resourceType === state.notificationResourceType),
    );
    const resourceTypes = [
      ...new Set(notifications.map((entry) => entry.resourceType)),
    ].sort();
    return `<div class="collaboration-filter-row"><label><span>严重程度</span><select data-collaboration-change="notification-severity"><option value="">全部</option>${['critical', 'high', 'medium', 'low', 'info'].map((value) => `<option value="${value}" ${state.notificationSeverity === value ? 'selected' : ''}>${html(collaborationLabel(value))}</option>`).join('')}</select></label><label><span>资源</span><select data-collaboration-change="notification-resource"><option value="">全部</option>${resourceTypes.map((value) => `<option value="${attr(value)}" ${state.notificationResourceType === value ? 'selected' : ''}>${html(collaborationLabel(value))}</option>`).join('')}</select></label></div><div class="collaboration-record-list">${
      visible
        .map((entry) => {
          const communication = entry.kind === 'member_communication';
          const sender = communication
            ? collaborationPrincipalName(
                selectedGroup()?.projection,
                entry.payload?.sender_principal_id,
              )
            : '';
          const title = communication
            ? `${sender} ${entry.reason === 'mentioned' ? '@了你' : '通知了你'}`
            : collaborationLabel(entry.kind);
          const message = communication
            ? entry.payload?.body_markdown || ''
            : collaborationLabel(entry.reason);
          return `<article class="collaboration-record collaboration-notification ${entry.readAtMs ? 'read' : ''}"><button type="button" class="collaboration-record-main collaboration-record-link" data-collaboration-action="open-notification" data-notification-id="${attr(entry.notificationId)}" data-resource-type="${attr(entry.resourceType)}" data-resource-id="${attr(entry.resourceId)}"><span class="collaboration-record-title"><strong>${html(title)}</strong>${status(entry.severity)}</span><p class="${communication ? 'collaboration-markdown-body' : ''}">${html(message)}</p><small>${html(localDate(entry.updatedAtMs))} · ${html(collaborationLabel(entry.resourceType))}${entry.payload?.status || entry.payload?.current_status || entry.payload?.state ? ` · ${html(collaborationStatusLabel(entry.payload.status || entry.payload.current_status || entry.payload.state))}` : ''}</small></button><div class="collaboration-record-actions">${entry.readAtMs ? '' : `<button type="button" class="btn-ghost" data-collaboration-action="read-notification" data-notification-id="${attr(entry.notificationId)}">已读</button>`}<button type="button" class="btn-ghost" data-collaboration-action="handle-notification" data-notification-id="${attr(entry.notificationId)}">处理</button></div></article>`;
        })
        .join('') || empty('没有未处理通知')
    }</div>`;
  };

  const renderAnalysisRuns = (
    runs,
    group,
    { limit = 6, showCreate = true } = {},
  ) => {
    const latest = runs[0];
    const findings = latest?.findings || [];
    const lifecycle = (kind) =>
      findings.filter((entry) => entry.lifecycle === kind).length;
    return `<section class="collaboration-analysis-summary"><div class="collaboration-analysis-stats">${metric('最近状态', latest ? collaborationStatusLabel(latest.run.status) : '-')}${metric('新增', lifecycle('new'))}${metric('恶化', lifecycle('worsened'), lifecycle('worsened') ? 'danger' : '')}${metric('已解决', lifecycle('resolved'), 'success')}</div>${showCreate ? '<div class="collaboration-record-actions"><button type="button" class="btn-primary" data-collaboration-action="new-analysis">分析项目</button></div>' : ''}</section><div class="collaboration-record-list">${
      runs
        .slice(0, limit)
        .map(
          (detail) =>
            `<button type="button" class="collaboration-row-button" data-collaboration-action="open-analysis" data-analysis-id="${attr(detail.run.analysisId)}"><span class="collaboration-row-copy"><strong>${html(detail.result?.normalized?.summary?.headline || collaborationLabel(detail.run.scope?.type || 'project'))}</strong><small>${html(timestamp(detail.run.updatedAtMs))} · ${html(collaborationLabel(detail.run.executionChannel))}</small></span>${detail.stale ? status('stale') : status(detail.run.status)}</button>`,
        )
        .join('') || empty('尚未运行项目分析')
    }</div>${collaborationIsObserver(group) ? '<p class="collaboration-muted-note">Observer 的分析仅保存在本机，群组写操作不可用。</p>' : ''}`;
  };

  const renderEvidenceRef = (ref) => {
    const separator = String(ref).indexOf(':');
    const type = separator < 0 ? '' : String(ref).slice(0, separator);
    const id = separator < 0 ? '' : String(ref).slice(separator + 1);
    return type && id
      ? `<button type="button" class="collaboration-ref-button" data-collaboration-action="open-overview-resource" data-resource-type="${attr(type)}" data-resource-id="${attr(id)}"><code>${html(ref)}</code></button>`
      : `<code>${html(ref)}</code>`;
  };

  const renderFinding = (entry, detail, group) => {
    const finding = entry.finding;
    const access = collaborationAnalysisRunAccess(group, detail);
    const proposedActions = finding.proposed_actions || [];
    const actionControls = access.canPreviewActions
      ? `<div class="collaboration-finding-actions"><span>后续动作</span><div class="collaboration-record-actions">${proposedActions.map((action, index) => `<button type="button" class="btn-ghost" data-collaboration-action="preview-analysis-action" data-finding-id="${attr(entry.findingId)}" data-action-ordinal="${index}" data-action-type="${attr(action.action)}">建议：${html(collaborationLabel(action.action))}</button>`).join('')}<button type="button" class="btn-primary" data-collaboration-action="preview-analysis-action" data-finding-id="${attr(entry.findingId)}">选择转化动作</button></div></div>`
      : '';
    return `<article class="collaboration-finding"><header><div><span class="collaboration-finding-kind">${html(collaborationLabel(finding.kind))} · ${html(collaborationLabel(finding.category))}</span><strong>${html(finding.title)}</strong></div><div>${status(finding.severity)}${status(entry.lifecycle)}</div></header><p>${html(finding.summary)}</p><dl class="collaboration-definition-list"><div><dt>置信度</dt><dd>${html(`${Math.round(Number(finding.confidence || 0) * 100)}%`)}</dd></div><div><dt>影响范围</dt><dd class="collaboration-ref-list">${(finding.affected_refs || []).map(renderEvidenceRef).join(' ')}</dd></div><div><dt>证据</dt><dd class="collaboration-ref-list">${(finding.evidence_refs || []).map(renderEvidenceRef).join(' ')}</dd></div></dl>${finding.recommendations?.length ? `<ul class="collaboration-analysis-recommendations">${finding.recommendations.map((value) => `<li>${html(value)}</li>`).join('')}</ul>` : ''}<div class="collaboration-finding-footer">${access.canDecideFinding ? `<div class="collaboration-record-actions">${['accepted', 'deferred', 'ignored', 'false_positive'].map((decision) => `<button type="button" class="btn-ghost ${entry.decision === decision ? 'active' : ''}" data-collaboration-action="finding-decision" data-finding-id="${attr(entry.findingId)}" data-decision="${decision}">${html(collaborationLabel(decision))}</button>`).join('')}</div>` : ''}${actionControls}</div></article>`;
  };

  const renderAnalysisDetail = (detail) => {
    const group = selectedGroup();
    const run = detail.run;
    const normalized = detail.result?.normalized;
    const access = collaborationAnalysisRunAccess(group, detail);
    const operation = access.canRetry ? 'retry' : 'start';
    const validationErrors = [
      ...(run.validationErrors || []),
      ...(detail.result?.validationErrors || []),
    ];
    const controls = `<div class="collaboration-record-actions">${access.canStart || access.canRetry ? `<button type="button" class="btn-primary" data-collaboration-action="analysis-operation" data-operation="${operation}">${operation === 'start' ? '开始分析' : '重新分析'}</button>` : ''}${access.canCancel ? '<button type="button" class="btn-ghost" data-collaboration-action="analysis-operation" data-operation="cancel">取消</button>' : ''}${access.canCompleteReview ? '<button type="button" class="btn-ghost" data-collaboration-action="analysis-operation" data-operation="complete">完成复核</button>' : ''}</div>`;
    const externalPanel =
      run.executionChannel === 'external_agent'
        ? `<section class="collaboration-section collaboration-export-panel"><div class="collaboration-section-head"><h3>外部 Agent 接力</h3><span>内容不会自动上传</span></div><dl class="collaboration-definition-list"><div><dt>资源数</dt><dd>${html(detail.exportScope?.resource_count || 0)}</dd></div><div><dt>所选文件</dt><dd>${html(detail.exportScope?.file_count || 0)}</dd></div><div><dt>包含文件内容</dt><dd>${detail.exportScope?.include_selected_file_contents ? '是' : '否'}</dd></div></dl><p class="collaboration-muted-note">导出前会展示完整文件清单、大小和脱敏标记。不要向第三方平台提供 Credential、token 或 Provider 配置。</p><div class="collaboration-record-actions">${access.canExportExternal ? '<button type="button" class="btn-ghost" data-collaboration-action="review-analysis-package">复核分析包</button>' : ''}${access.canSubmitExternal ? '<button type="button" class="btn-primary" data-collaboration-action="submit-external-result">回填 JSON</button>' : ''}</div>${detail.repairPrompt ? `<div class="collaboration-repair-prompt"><div class="collaboration-record-actions"><strong>结果修复 Prompt</strong><button type="button" class="btn-ghost" data-collaboration-action="copy-repair-prompt">复制</button></div><pre>${html(detail.repairPrompt)}</pre></div>` : ''}</section>`
        : '';
    return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-analysis">返回分析</button>${controls}</section>${detail.stale ? '<div class="collaboration-inline-alert">该报告绑定的 verified snapshot 已过期，当前仅可查看。请基于当前 verified head 重新分析后再复核或转化 Finding。</div>' : ''}<section class="collaboration-metrics">${metric('状态', collaborationStatusLabel(run.status), severityTone(run.status))}${metric('渠道', collaborationLabel(run.executionChannel))}${metric('Executor', run.executorId || '外部 Agent')}${metric('Findings', detail.findings?.length || 0)}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Analysis Run</h3>${status(run.status)}</div><dl class="collaboration-definition-list"><div><dt>Analysis ID</dt><dd><code>${html(run.analysisId)}</code></dd></div><div><dt>verified snapshot</dt><dd><code>${html(run.snapshotHead)}</code></dd></div>${run.scope?.type === 'delta' ? `<div><dt>基准 snapshot</dt><dd><code>${html(run.scope.since_snapshot_head)}</code></dd></div>` : ''}<div><dt>Context hash</dt><dd><code>${html(run.contextHash)}</code></dd></div><div><dt>Prompt hash</dt><dd><code>${html(run.promptHash)}</code></dd></div><div><dt>范围</dt><dd>${html(collaborationLabel(run.scope?.type))}</dd></div><div><dt>开始时间</dt><dd>${html(localDate(run.startedAtMs))}</dd></div></dl>${run.error ? `<div class="collaboration-inline-alert">${html(run.error)}</div>` : ''}${validationErrors.length ? `<div class="collaboration-validation-list">${validationErrors.map((error) => `<p><code>${html(error.code)}</code> ${html(error.path)} · ${html(error.message)}</p>`).join('')}</div>` : ''}</section>${externalPanel}${normalized ? `<section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(normalized.summary?.headline)}</h3>${status(normalized.summary?.health)}</div><p class="collaboration-prose">${html(normalized.summary?.details)}</p></section>` : ''}<section class="collaboration-section"><div class="collaboration-section-head"><h3>Findings</h3><span>${detail.findings?.length || 0}</span></div><div class="collaboration-finding-list">${(detail.findings || []).map((entry) => renderFinding(entry, detail, group)).join('') || empty('没有可复核的 Finding')}</div></section>${detail.applications?.length ? `<section class="collaboration-section"><div class="collaboration-section-head"><h3>动作执行记录</h3><span>${detail.applications.length}</span></div><div class="collaboration-record-list">${detail.applications.map((entry) => `<article class="collaboration-record"><div class="collaboration-record-main"><strong>${html(collaborationLabel(entry.action?.action))}</strong><small>${html(collaborationStatusLabel(entry.state))} · ${html(localDate(entry.updatedAtMs))}</small>${entry.error ? `<p>${html(entry.error)}</p>` : ''}<pre>${html(JSON.stringify(entry.preview, null, 2))}</pre></div>${status(entry.state)}</article>`).join('')}</div></section>` : ''}`;
  };

  const renderAnalysis = () => {
    const data = state.tabData.analysis;
    if (!data) return empty('正在加载分析记录');
    if (state.selectedAnalysisId) {
      const detail = state.tabData.analysisDetail;
      return detail
        ? renderAnalysisDetail(detail)
        : empty('正在加载 Analysis Run');
    }
    return `${renderObserverBand(selectedGroup())}<section class="collaboration-section"><div class="collaboration-section-head"><h3>Agent Analysis</h3><button type="button" class="btn-primary" data-collaboration-action="new-analysis">新建分析</button></div>${renderAnalysisRuns(data.runs || [], selectedGroup(), { limit: Number.POSITIVE_INFINITY, showCreate: false })}</section>`;
  };

  const renderOverview = () => {
    const group = selectedGroup();
    const overview = state.tabData.overview;
    if (!overview) return empty('正在加载项目概览');
    const { insight, myItems, notifications, runs } = overview;
    const myRefs = new Set(
      myItems.map((item) => `${item.resource_type}:${item.resource_id}`),
    );
    const signals = insight.signals.filter(
      (entry) =>
        (!state.overviewOnlyMine ||
          entry.affected_refs.some((ref) => myRefs.has(ref))) &&
        (!state.overviewRiskOnly ||
          ['critical', 'high', 'medium'].includes(entry.severity)),
    );
    return `${renderObserverBand(group)}<section class="collaboration-overview-toolbar"><div class="collaboration-segmented"><button type="button" class="${state.overviewOnlyMine ? 'active' : ''}" data-collaboration-action="toggle-overview-filter" data-filter="mine">只看我的</button><button type="button" class="${state.overviewRiskOnly ? 'active' : ''}" data-collaboration-action="toggle-overview-filter" data-filter="risk">风险</button></div><div class="collaboration-verified-state"><span>${html(collaborationStatusLabel(insight.sync.protocol_status))} · ${html(collaborationStatusLabel(insight.sync.integrity_status))}</span><code>${html(insight.snapshot_head.slice(0, 12))}</code><small>${html(timestamp(insight.sync.last_verified_sync_at))}</small></div></section><section class="collaboration-metrics collaboration-health-metrics">${metric('项目健康', collaborationStatusLabel(insight.health), severityTone(insight.health))}${metric('活跃成员', insight.counts.active_members)}${metric('未完成', insight.counts.open_work_items)}${metric('逾期', insight.counts.overdue_work_items, insight.counts.overdue_work_items ? 'danger' : '')}${metric('阻塞', insight.counts.blocked_work_items, insight.counts.blocked_work_items ? 'warning' : '')}${metric('待确认分配', insight.counts.pending_assignments)}${metric('运行工作流', insight.counts.workflow_running)}${metric('等待工作流', insight.counts.workflow_waiting)}${metric('暂停 / 超时', `${insight.counts.workflow_paused} / ${insight.counts.workflow_timed_out}`)}${metric('未解决讨论', insight.counts.unresolved_discussions)}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>确定性风险信号</h3><span>${signals.length}</span></div><div class="collaboration-record-list">${signals.map((entry) => `<article class="collaboration-record"><div class="collaboration-record-main"><strong>${html(entry.title)}</strong><p>${html(entry.summary)}</p><div class="collaboration-ref-list">${entry.evidence_refs.map(renderEvidenceRef).join(' ')}</div></div>${status(entry.severity)}</article>`).join('') || empty('当前筛选下没有风险信号')}</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>我的事项</h3><span>${myItems.length}</span></div><div class="collaboration-my-items">${renderMyItems(myItems) || empty('当前没有需要处理的事项')}</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>通知</h3><span>${notifications.length}</span></div>${renderNotifications(notifications)}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Agent Analysis</h3><span>${runs.length}</span></div>${renderAnalysisRuns(runs, group)}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>最近活动</h3><div class="collaboration-record-actions"><span>${insight.activity_delta.length} 条新动态</span><button type="button" class="btn-ghost" data-collaboration-action="go-activity">查看全部</button></div></div><div class="collaboration-timeline">${
      insight.recent_activity
        .slice(0, 8)
        .map(
          (event) =>
            `<article><span class="collaboration-timeline-marker"></span><div><strong>${html(collaborationEventLabel(event.eventType))}</strong><small>${html(collaborationPrincipalName(group.projection, event.actorPrincipalId))} · ${html(timestamp(event.occurredAt))}</small></div></article>`,
        )
        .join('') || empty('暂无动态')
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
    const canEdit = resourceAction(
      'work_item',
      item.work_item_id,
      'editDetails',
    );
    const canAssign = resourceAction(
      'work_item',
      item.work_item_id,
      'changeAssignment',
    );
    const canRelate = resourceAction(
      'work_item',
      item.work_item_id,
      'changeRelations',
    );
    const canArchive = resourceAction(
      'work_item',
      item.work_item_id,
      'archive',
    );
    const canPostProgress = resourceAction(
      'work_item',
      item.work_item_id,
      'postProgress',
    );
    const canAnswer = collaborationCanAnswerWorkItemAssignment(group, item);
    const statusActions = [
      'proposed',
      'open',
      'in_progress',
      'blocked',
      'done',
      'cancelled',
    ].filter(
      (value) =>
        value !== item.status &&
        collaborationWorkItemStatusActionAccess(group, item.work_item_id, value)
          .allowed,
    );
    return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-work-item">返回</button><div class="collaboration-record-actions">${canEdit ? '<button type="button" class="btn-ghost" data-collaboration-action="edit-work-item">编辑</button>' : ''}${canAssign ? '<button type="button" class="btn-ghost" data-collaboration-action="assign-work-item">负责人</button>' : ''}${canRelate ? '<button type="button" class="btn-ghost" data-collaboration-action="relate-work-item">关系</button>' : ''}${canPostProgress ? '<button type="button" class="btn-primary" data-collaboration-action="post-work-progress">发布进展</button>' : ''}${canArchive ? '<button type="button" class="btn-danger-soft" data-collaboration-action="archive-work-item">归档</button>' : ''}</div></section>
      <section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(item.title)}</h3>${status(item.archived ? 'archived' : item.status)}</div><p class="collaboration-prose">${html(item.description || '')}</p>${canAnswer ? '<div class="collaboration-command-band"><div><span>等待确认</span><strong>这项工作已分配给你</strong></div><div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="decline-assignment">拒绝</button><button type="button" class="btn-primary" data-collaboration-action="acknowledge-assignment">接受</button></div></div>' : ''}<dl class="collaboration-definition-list"><div><dt>负责人</dt><dd>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</dd></div><div><dt>贡献者</dt><dd>${(item.contributors || []).map((id) => html(collaborationPrincipalName(group.projection, id))).join('、') || '-'}</dd></div><div><dt>关注者</dt><dd>${(item.watchers || []).map((id) => html(collaborationPrincipalName(group.projection, id))).join('、') || '-'}</dd></div><div><dt>优先级</dt><dd>${html(collaborationLabel(item.priority))}</dd></div><div><dt>截止时间</dt><dd>${html(timestamp(item.due_at))}</dd></div><div><dt>分配状态</dt><dd>${html(collaborationLabel(item.assignment_status))}</dd></div><div><dt>标签</dt><dd>${(item.labels || []).map((label) => `<code>${html(collaborationLabel(label))}</code>`).join(' ') || '-'}</dd></div><div><dt>父工作项</dt><dd>${item.parent_id ? `<code>${html(item.parent_id)}</code>` : '-'}</dd></div><div><dt>阻塞项</dt><dd>${(item.blocked_by || []).map((id) => `<code>${html(id)}</code>`).join(' ') || '-'}</dd></div><div><dt>关联项</dt><dd>${(item.related_items || []).map((id) => `<code>${html(id)}</code>`).join(' ') || '-'}</dd></div></dl>${statusActions.length ? `<div class="collaboration-segmented">${statusActions.map((value) => `<button type="button" data-collaboration-action="set-work-status" data-status="${value}">${html(collaborationStatusLabel(value))}</button>`).join('')}</div>` : ''}</section>
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
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>工作项</h3>${groupAction('createWorkItem') ? '<button type="button" class="btn-primary" data-collaboration-action="new-work-item">新建</button>' : ''}</div><div class="collaboration-view-toggle"><button type="button" data-collaboration-action="work-view" data-view="board" class="${state.workItemView !== 'list' ? 'active' : ''}">看板</button><button type="button" data-collaboration-action="work-view" data-view="list" class="${state.workItemView === 'list' ? 'active' : ''}">列表</button></div>${state.workItemView === 'list' ? `<div class="collaboration-record-list">${items.map((item) => `<button type="button" class="collaboration-row-button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong><span>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</span>${status(item.status)}</button>`).join('') || empty('暂无工作项')}</div>` : `<div class="collaboration-work-board">${statuses.map((column) => `<section><header><strong>${html(collaborationStatusLabel(column))}</strong><span>${columns[column].length}</span></header>${columns[column].map((item) => `<button type="button" data-collaboration-action="open-work-item" data-work-item-id="${attr(item.work_item_id)}"><strong>${html(item.title)}</strong><small>${html(collaborationPrincipalName(group.projection, item.owner_principal_id))}</small><span>${html(collaborationLabel(item.priority))}</span></button>`).join('') || empty('暂无内容')}</section>`).join('')}</div>`}</section>`;
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
      const canPost = resourceAction(
        'discussion',
        selected.discussion.thread_id,
        'post',
      );
      const statusAction =
        selected.discussion.status === 'open' ? 'resolve' : 'reopen';
      const canChangeStatus = resourceAction(
        'discussion',
        selected.discussion.thread_id,
        statusAction,
      );
      return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-discussion">返回</button><div class="collaboration-record-actions">${canChangeStatus ? `<button type="button" class="btn-ghost" data-collaboration-action="${statusAction}-discussion">${statusAction === 'resolve' ? '解决讨论' : '重新打开'}</button>` : ''}${canPost ? '<button type="button" class="btn-primary" data-collaboration-action="new-message">回复</button>' : ''}</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(selected.discussion.title)}</h3>${status(selected.discussion.status)}</div>${selected.discussion.status === 'resolved' ? '<div class="collaboration-discussion-state"><strong>讨论已解决</strong><span>重新打开后才可回复或编辑消息。</span></div>' : ''}<div class="collaboration-discussion-stream">${
        messages
          .map((message) => {
            const canRevise = collaborationDiscussionMessageActionAllowed(
              group,
              selected.discussion.thread_id,
              message.message_id,
              'revise',
            );
            const canTombstone = collaborationDiscussionMessageActionAllowed(
              group,
              selected.discussion.thread_id,
              message.message_id,
              'tombstone',
            );
            return `<article><header><strong>${html(collaborationPrincipalName(group.projection, message.author_principal_id))}</strong><small>${html(timestamp(message.updated_at || message.created_at))}</small></header><p class="collaboration-markdown-body">${message.tombstoned ? '<em>消息已删除</em>' : html(message.body)}</p>${canRevise || canTombstone ? `<div class="collaboration-record-actions">${canRevise ? `<button type="button" class="btn-ghost" data-collaboration-action="revise-message" data-message-id="${attr(message.message_id)}">编辑</button>` : ''}${canTombstone ? `<button type="button" class="btn-danger-soft" data-collaboration-action="tombstone-message" data-message-id="${attr(message.message_id)}">删除</button>` : ''}</div>` : ''}</article>`;
          })
          .join('') || empty('暂无消息')
      }</div></section>`;
    }
    return `<section class="collaboration-section"><div class="collaboration-section-head"><h3>讨论</h3>${groupAction('createDiscussion') ? '<button type="button" class="btn-primary" data-collaboration-action="new-discussion">新建</button>' : ''}</div><div class="collaboration-record-list">${threads.map((thread) => `<button type="button" class="collaboration-row-button" data-collaboration-action="open-discussion" data-thread-id="${attr(thread.discussion.thread_id)}"><strong>${html(thread.discussion.title)}</strong><span>${html(Object.keys(thread.messages || {}).length)} 条消息</span>${status(thread.discussion.status)}</button>`).join('') || empty('暂无讨论')}</div></section>`;
  };

  const renderFiles = () => {
    const group = selectedGroup();
    const files = state.tabData.files || [];
    const tree = collaborationVerifiedFileTree(files);
    const canUpload =
      groupAction('writeSharedWorkspace') || groupAction('postOwnedWorkspace');
    return `<section class="collaboration-files-layout"><aside><div class="collaboration-section-head"><h3>已验证文件</h3>${canUpload ? '<button type="button" class="btn-primary" data-collaboration-action="upload-file">上传</button>' : ''}</div>${renderTreeNode(tree)}</aside><main id="collaboration-file-preview">${state.filePreview ? `<header><strong>${html(state.filePreview.name)}</strong><small>${html(state.filePreview.mediaType)}</small></header>${state.filePreview.text ? `<pre>${html(state.filePreview.text)}</pre>` : `<a class="btn-primary" href="${attr(state.filePreview.url)}" download>下载</a>`}` : empty('请选择文件')}</main></section>`;
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
    const canRecoverTurn = collaborationCanRecoverTurn(group, instance, turn);
    const instanceCommand = collaborationWorkflowInstanceCommand(instance);
    const routes = collaborationOutcomeRoutes(definition, turn);
    const canCreateTurn = collaborationCanCreateTurn(
      group,
      instance,
      definition,
    );
    const canConfigure = resourceAction(
      'workflow_instance',
      instance.instance_id,
      'configureCurrentState',
    );
    const canWithdrawExecution = collaborationWorkflowStateActionAccess(
      group,
      instance.instance_id,
      instance.business_state,
      'withdrawExecution',
    ).allowed;
    const canRunCommand = Boolean(
      instanceCommand &&
      resourceAction(
        'workflow_instance',
        instance.instance_id,
        instanceCommand.command,
      ),
    );
    const canReassign = resourceAction(
      'workflow_instance',
      instance.instance_id,
      'reassign',
    );
    const canClose = resourceAction(
      'workflow_instance',
      instance.instance_id,
      'close',
    );
    const canCancelTurn = Boolean(
      turn &&
      collaborationWorkflowTurnActionAllowed(
        group,
        instance.instance_id,
        turn.turn_id,
        'cancel',
      ),
    );
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
      ? `<dl class="collaboration-definition-list"><div><dt>状态</dt><dd>${html(workflowStateLabel(definition, turn.state_id))}</dd></div><div><dt>负责人</dt><dd>${html(collaborationPrincipalName(projection, turn.assignee_principal_id))}</dd></div><div><dt>客户端</dt><dd>${html(turn.claimant_client_id || '-')}</dd></div><div><dt>执行模式</dt><dd>${html(collaborationLabel(turn.execution_mode))}</dd></div><div><dt>尝试次数</dt><dd>${html(turn.attempt)}</dd></div><div><dt>截止时间</dt><dd>${html(collaborationTurnDeadline(turn)?.deadlineAt || '-')}</dd></div>${turn.recovery_reason ? `<div><dt>恢复原因</dt><dd>${html(turn.recovery_reason)}</dd></div>` : ''}</dl><div class="collaboration-record-actions">${canRecoverTurn ? '<button type="button" class="btn-primary" data-collaboration-action="recover-turn">恢复执行轮次</button>' : ''}${access.canStart ? '<button type="button" class="btn-primary" data-collaboration-action="start-turn">开始执行</button>' : ''}${access.canComplete ? '<button type="button" class="btn-primary" data-collaboration-action="complete-turn">完成</button>' : ''}${canCancelTurn ? '<button type="button" class="btn-danger-soft" data-collaboration-action="cancel-turn">取消 Turn</button>' : ''}${canConfigure && turn.state !== 'recovery_required' ? '<button type="button" class="btn-ghost" data-collaboration-action="configure-execution">执行配置</button>' : ''}${canWithdrawExecution ? '<button type="button" class="btn-danger-soft" data-collaboration-action="withdraw-execution">清除执行配置</button>' : ''}</div><div class="collaboration-outcome-preview">${routes.map((route) => `<span><strong>${html(collaborationLabel(route.label || route.outcome))}</strong> → ${html(workflowStateLabel(definition, route.target_state))}</span>`).join('')}</div>`
      : `<div class="collaboration-section-empty">${instance.lifecycle === 'running' ? `可以开始：${html(workflowStateLabel(definition, instance.business_state))}` : '当前没有执行轮次'}</div><div class="collaboration-record-actions">${canConfigure ? '<button type="button" class="btn-ghost" data-collaboration-action="configure-execution">执行配置</button>' : ''}${canWithdrawExecution ? '<button type="button" class="btn-danger-soft" data-collaboration-action="withdraw-execution">清除执行配置</button>' : ''}${canCreateTurn ? `<button type="button" class="btn-primary" data-collaboration-action="create-turn">${turns.length ? '继续执行' : '创建执行轮次'}</button>` : ''}</div>`;
    return `<section class="collaboration-detail-toolbar"><button type="button" class="btn-ghost" data-collaboration-action="close-instance">返回</button><div class="collaboration-record-actions">${canReassign ? '<button type="button" class="btn-ghost" data-collaboration-action="reassign-instance">补齐参与者 / 重新分配</button>' : ''}${canRunCommand ? `<button type="button" class="btn-primary" data-collaboration-action="instance-command" data-command="${instanceCommand.command}">${instanceCommand.label}</button>` : ''}${canClose ? '<button type="button" class="btn-danger-soft" data-collaboration-action="close-workflow-instance">关闭实例</button>' : ''}</div></section><section class="collaboration-metrics">${metric('生命周期', collaborationStatusLabel(instance.lifecycle))}${metric('当前状态', workflowStateLabel(definition, instance.business_state))}${metric('周期', instance.epoch)}${metric('执行轮次', turns.length)}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>${html(collaborationLabel(definition?.definition?.name || instance.definition_id))} · ${html(instance.instance_id)}</h3>${status(instance.lifecycle)}</div><div id="collaboration-instance-graph"></div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>当前执行轮次</h3>${turn ? status(turn.state) : ''}</div>${currentTurn}</section><section class="collaboration-section"><div class="collaboration-section-head"><h3>执行历史</h3><span>${turns.length}</span></div>${turns.map((item) => `<article class="collaboration-record"><div><strong>${html(workflowStateLabel(definition, item.state_id))}</strong><small>${html(timestamp(item.created_at))}${item.outcome ? ` · ${html(collaborationLabel(item.outcome))}` : ''}</small>${renderArtifactRefs(projection, item.artifact_refs)}</div>${status(item.state)}</article>`).join('') || empty('暂无执行记录')}</section>`;
  };

  const renderWorkflows = () => {
    const group = selectedGroup();
    const instances = Object.values(group.projection?.workflowInstances || {});
    const selectedInstance = instances.find(
      (instance) => instance.instance_id === state.selectedInstanceId,
    );
    if (selectedInstance) return renderInstanceDetail(selectedInstance);
    const definitions = workflowDefinitionEntries();
    const ownedActions = collaborationOwnedActions(group);
    const localExecutors = state.detail?.localExecutors || [];
    const executionResources = `<section class="collaboration-section"><div class="collaboration-section-head"><h3>执行资源</h3><div class="collaboration-record-actions">${groupAction('registerOwnExecutor') ? '<button type="button" class="btn-ghost" data-collaboration-action="new-executor">添加 Executor</button>' : ''}${groupAction('publishOwnedAction') ? '<button type="button" class="btn-primary" data-collaboration-action="new-action">创建 Action</button>' : ''}</div></div><div class="collaboration-resource-columns"><div><h4>本机 Executor</h4><div class="collaboration-record-list">${
      localExecutors
        .map((executor) => {
          const canRevoke = resourceAction(
            'executor',
            executor.executorId,
            'revoke',
          );
          return `<article class="collaboration-record"><div><strong>${html(executor.displayName)}</strong><small>${html(collaborationLabel(executor.executorKind))} · ${html(collaborationShortId(executor.executorId))}</small></div>${status(executor.enabled ? 'active' : 'revoked')}${canRevoke ? `<button type="button" class="btn-danger-soft" data-collaboration-action="revoke-executor" data-executor-id="${attr(executor.executorId)}">撤销</button>` : ''}</article>`;
        })
        .join('') || empty('暂无本机 Executor')
    }</div></div><div><h4>我的 Action</h4><div class="collaboration-record-list">${
      ownedActions
        .map((action) => {
          const key = `${action.owner_principal_id}:${action.action_id}`;
          const canRevise = resourceAction('action', key, 'revise');
          return `<article class="collaboration-record"><div><strong>${html(action.name)}</strong><small>${html(collaborationLabel(collaborationActionType(action)))} · v${html(action.version)} · ${html(collaborationShortId(action.action_id))}</small></div>${canRevise ? `<button type="button" class="btn-ghost" data-collaboration-action="revise-action" data-action-id="${attr(action.action_id)}">修订</button>` : ''}</article>`;
        })
        .join('') || empty('暂无 Action')
    }</div></div></div></section>`;
    return `${executionResources}<section class="collaboration-section"><div class="collaboration-section-head"><h3>工作流定义</h3>${groupAction('proposeWorkflowDefinition') ? '<button type="button" class="btn-primary" data-collaboration-action="new-workflow">新建</button>' : ''}</div><div class="collaboration-record-list">${
      definitions
        .map((entry) => {
          const key = `${entry.definition.definition_id}@${entry.definition.version}`;
          const canCreateVersion = resourceAction(
            'workflow_definition',
            key,
            'createVersion',
          );
          const canRetire = resourceAction(
            'workflow_definition',
            key,
            'retire',
          );
          return `<article class="collaboration-record"><div><strong>${html(collaborationLabel(entry.definition.name))}</strong><small>${html(entry.definition.definition_id)} · v${html(entry.definition.version)}</small></div>${status(entry.definition.status)}<div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="view-workflow" data-definition-key="${attr(key)}">打开</button>${canCreateVersion ? `<button type="button" class="btn-ghost" data-collaboration-action="new-workflow-version" data-definition-key="${attr(key)}">新建版本</button>` : ''}${collaborationWorkflowPublishable(group, entry) ? `<button type="button" class="btn-primary" data-collaboration-action="publish-workflow" data-definition-id="${attr(entry.definition.definition_id)}" data-version="${attr(entry.definition.version)}">发布</button>` : ''}${canRetire ? `<button type="button" class="btn-danger-soft" data-collaboration-action="retire-workflow" data-definition-key="${attr(key)}">停用</button>` : ''}</div></article>`;
        })
        .join('') || empty('暂无工作流定义')
    }</div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>工作流实例</h3>${groupAction('createWorkflowInstance') && definitions.some((entry) => entry.definition.status === 'published') ? '<button type="button" class="btn-primary" data-collaboration-action="new-instance">新建</button>' : ''}</div><div class="collaboration-record-list">${
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
    const memberData = state.tabData.members || projection || {};
    const members = memberData.members || projection?.members || {};
    const clientsByPrincipal = memberData.clients || projection?.clients || {};
    const credentialsByPrincipal =
      memberData.credentials || projection?.credentials || {};
    const recoveryRequests = Object.values(
      memberData.recoveryRequests || projection?.recoveryRequests || {},
    ).sort((left, right) =>
      String(right.created_at).localeCompare(String(left.created_at)),
    );
    const canApprove = collaborationCanApproveMembers(group);
    const invites = Object.values(projection?.invites || {});
    const inviteSection =
      projection?.group?.membership_policy?.join === 'invite_only'
        ? `<section class="collaboration-section"><div class="collaboration-section-head"><h3>邀请</h3>${canApprove ? '<button type="button" class="btn-primary" data-collaboration-action="issue-invite">发放邀请</button>' : ''}</div><div class="collaboration-record-list">${invites.map((invite) => `<article class="collaboration-record"><div><strong>新成员邀请</strong><small>${html(invite.invite_id)} · ${html(invite.expires_at ? timestamp(invite.expires_at) : '永不过期')}</small></div>${status(invite.status)}${canApprove && invite.status === 'active' ? `<button type="button" class="btn-ghost" data-collaboration-action="revoke-invite" data-invite-id="${attr(invite.invite_id)}">撤销</button>` : ''}</article>`).join('') || empty('暂无邀请')}</div></section>`
        : '';
    const memberSection = `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Icarus Group Permission</h3><span>${Object.keys(members).length}</span></div><div class="collaboration-record-list">${Object.values(
      members,
    )
      .map((member) => {
        const grants =
          memberData.permissionGrants?.[member.principal_id]?.grants ||
          projection.permissionGrants?.[member.principal_id]?.grants ||
          [];
        const profile = group.allowedActions?.members?.[member.principal_id];
        const effective = profile?.effectivePermissions || grants;
        const matchedTemplate = permissionTemplates().find(
          (template) => template.id === profile?.matchedTemplateId,
        );
        const clients = Object.values(
          clientsByPrincipal[member.principal_id] || {},
        );
        const approvalActions =
          canApprove && member.status === 'requested'
            ? `<div class="collaboration-record-actions"><button type="button" class="btn-primary" data-collaboration-action="approve-member" data-principal-id="${attr(member.principal_id)}">批准</button><button type="button" class="btn-danger-soft" data-collaboration-action="reject-member" data-principal-id="${attr(member.principal_id)}">拒绝</button></div>`
            : '';
        return `<article class="collaboration-record"><div class="collaboration-record-main"><strong>${html(member.display_name)}</strong><small title="${attr(member.principal_id)}">${html(collaborationShortId(member.principal_id))} · ${clients.length} 个 Client</small><p>${profile?.isOwner ? '<span class="collaboration-template-match">Owner 内置管理能力</span>' : matchedTemplate ? `<span class="collaboration-template-match">${html(matchedTemplate.nameZh)}</span>` : grants.length ? '<span class="collaboration-template-custom">自定义权限</span>' : '<span>无直接权限</span>'} ${grants.map((grant) => `<code title="${attr(grant)}">${html(collaborationPermissionLabel(grant))}</code>`).join(' ')}</p><details class="collaboration-effective-permissions"><summary>当前有效权限 ${html(effective.length)}</summary><div>${effective.map((grant) => `<code title="${attr(grant)}">${html(collaborationPermissionLabel(grant))}</code>`).join(' ') || '无'}</div></details></div>${status(member.status)}${approvalActions}${groupAction('managePermissions') && member.status === 'active' && member.principal_id !== group.ownerPrincipalId ? `<button type="button" class="btn-ghost" data-collaboration-action="edit-permissions" data-principal-id="${attr(member.principal_id)}">权限</button>` : ''}</article>`;
      })
      .join('')}</div></section>`;
    const clients = Object.values(clientsByPrincipal).flatMap((entries) =>
      Object.values(entries || {}),
    );
    const clientSection = `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Clients</h3><span>${clients.length}</span></div><div class="collaboration-record-list">${
      clients
        .map((client) => {
          const canRevoke = resourceAction(
            'client',
            client.client_id,
            'revoke',
          );
          return `<article class="collaboration-record"><div class="collaboration-record-main"><strong>${html(client.display_name)}</strong><small title="${attr(client.client_id)}">${html(collaborationPrincipalName(projection, client.principal_id))} · ${html(collaborationShortId(client.client_id))}</small></div>${status(client.status)}${canRevoke ? `<button type="button" class="btn-danger-soft" data-collaboration-action="revoke-client" data-client-id="${attr(client.client_id)}">撤销 Client</button>` : ''}</article>`;
        })
        .join('') || empty('暂无 Client')
    }</div></section>`;
    const credentials = Object.values(credentialsByPrincipal).flatMap(
      (entries) => Object.values(entries || {}),
    );
    const credentialSection = `<section class="collaboration-section"><div class="collaboration-section-head"><h3>Event-signing Credentials</h3>${groupAction('rotateOwnCredential') ? '<button type="button" class="btn-primary" data-collaboration-action="rotate-credential">轮换当前 Credential</button>' : ''}</div><div class="collaboration-record-list">${
      credentials
        .map((credential) => {
          const current =
            credential.credential_id === group.icarusIdentity?.credentialId;
          const canRevoke = resourceAction(
            'credential',
            credential.credential_id,
            'revoke',
          );
          return `<article class="collaboration-record"><div class="collaboration-record-main"><strong>${html(credential.purpose === 'group_recovery' ? 'Offline Group recovery' : current ? '当前设备签名' : 'Icarus 事件签名')}</strong><small title="${attr(credential.credential_id)}">${html(collaborationShortId(credential.credential_id))} · ${html(collaborationShortId(credential.client_id))}</small><code title="${attr(credential.fingerprint)}">${html(credential.fingerprint)}</code></div>${status(credential.status)}${canRevoke ? `<button type="button" class="btn-danger-soft" data-collaboration-action="revoke-credential" data-credential-id="${attr(credential.credential_id)}">撤销</button>` : ''}</article>`;
        })
        .join('') || empty('暂无 Credential')
    }</div></section>`;
    const recoverySection = `<section class="collaboration-section"><div class="collaboration-section-head"><h3>身份恢复请求</h3><span>${recoveryRequests.length}</span></div><div class="collaboration-record-list">${
      recoveryRequests
        .map((request) => {
          const canDecide = collaborationCanDecideRecovery(group, request);
          const canCancel = resourceAction(
            'recovery_request',
            request.request_id,
            'cancel',
          );
          const code = request.verification_code || '------';
          return `<article class="collaboration-record collaboration-recovery-record"><div class="collaboration-record-main"><div class="collaboration-record-title"><strong>${html(request.type === 'owner_recovery' ? '群主恢复' : '旧设备批准')}</strong><code class="collaboration-verification-code">${html(code)}</code></div><small>${html(collaborationPrincipalName(projection, request.target_principal_id))} · ${html(collaborationShortId(request.target_principal_id))}</small><span>${html(request.requested_client.display_name)} · ${html(request.requested_credential.fingerprint)}</span><small>${html(timestamp(request.created_at))} - ${html(timestamp(request.expires_at))}</small>${request.reason ? `<p>${html(request.reason)}</p>` : ''}</div>${status(request.status)}${canDecide ? `<div class="collaboration-record-actions"><button type="button" class="btn-primary" data-collaboration-action="approve-recovery" data-request-id="${attr(request.request_id)}">批准</button><button type="button" class="btn-danger-soft" data-collaboration-action="reject-recovery" data-request-id="${attr(request.request_id)}">拒绝</button></div>` : ''}${canCancel ? `<button type="button" class="btn-ghost" data-collaboration-action="cancel-recovery" data-request-id="${attr(request.request_id)}">取消</button>` : ''}</article>`;
        })
        .join('') || empty('暂无恢复请求')
    }</div></section>`;
    return `${inviteSection}${recoverySection}${memberSection}${clientSection}${credentialSection}`;
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
    const identity = group.icarusIdentity || {};
    const localCredential = collaborationLocalCredential(group);
    const defaultTemplate = permissionTemplates().find(
      (template) =>
        template.id ===
        (group.projection?.group?.default_permission_template_id ||
          group.allowedActions?.catalogs?.defaultTemplateId),
    );
    const lifecycleActions = [
      groupAction('archive')
        ? '<button type="button" class="btn-danger-soft" data-collaboration-action="archive-group">归档群组</button>'
        : '',
      groupAction('reopen')
        ? '<button type="button" class="btn-primary" data-collaboration-action="reopen-group">恢复群组</button>'
        : '',
      collaborationCanLeave(group)
        ? '<button type="button" class="btn-danger-soft" data-collaboration-action="leave-group">退出群组</button>'
        : '',
      collaborationCanDissolve(group)
        ? '<button type="button" class="btn-danger-soft" data-collaboration-action="dissolve-group">解散群组</button>'
        : '',
      collaborationCanInitializeGroup(group)
        ? '<button type="button" class="btn-danger-soft" data-collaboration-action="initialize-group">初始化群组</button>'
        : '',
    ].join('');
    return `${renderObserverBand(group)}<section class="collaboration-section"><div class="collaboration-section-head"><h3>Git Remote Access</h3><button type="button" class="btn-ghost" data-collaboration-action="edit-git-ssh-key">修改 SSH Key</button></div><dl class="collaboration-definition-list"><div><dt>Remote</dt><dd>${html(group.remoteUrl)}</dd></div><div><dt>本地 SSH Key</dt><dd>${html(group.gitRemoteAccess?.sshKeyPath || '-')}</dd></div><div><dt>权限边界</dt><dd>clone / fetch / push</dd></div></dl><div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="clear-git-ssh-key">使用默认路径</button></div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>Icarus Group Permission 与身份</h3></div><dl class="collaboration-definition-list"><div><dt>业务身份</dt><dd title="${attr(identity.principalId || '')}">${html(identity.principalId ? collaborationShortId(identity.principalId) : '-')}</dd></div><div><dt>当前 Client</dt><dd title="${attr(identity.clientId || '')}">${html(identity.clientId ? collaborationShortId(identity.clientId) : '-')}</dd></div><div><dt>当前 Credential</dt><dd title="${attr(identity.credentialId || '')}">${html(identity.credentialId ? collaborationShortId(identity.credentialId) : '-')}</dd></div><div><dt>签名状态</dt><dd>${html(collaborationStatusLabel(localCredential?.status || (identity.credentialId ? 'unknown' : 'not_configured')))}</dd></div><div><dt>离线 Group recovery</dt><dd>${identity.recoveryCredentialAvailable ? '本机可用' : '本机未导入'}</dd></div><div><dt>权限边界</dt><dd>Host API / 协议验证 / Reducer</dd></div></dl><div class="collaboration-record-actions">${groupAction('rotateOwnCredential') ? '<button type="button" class="btn-ghost" data-collaboration-action="rotate-credential">轮换 Credential</button>' : ''}${identity.recoveryCredentialAvailable ? '<button type="button" class="btn-ghost" data-collaboration-action="export-recovery-credential">导出离线恢复凭据</button>' : ''}<button type="button" class="btn-ghost" data-collaboration-action="import-recovery-credential">导入离线恢复凭据</button></div></section><section class="collaboration-section"><div class="collaboration-section-head"><h3>群组与本地数据</h3></div><dl class="collaboration-definition-list"><div><dt>群组 ID</dt><dd>${html(group.groupId)}</dd></div><div><dt>订阅模式</dt><dd>${html(collaborationLabel(group.subscriptionMode))}</dd></div><div><dt>默认权限模板</dt><dd>${html(defaultTemplate ? `${defaultTemplate.nameZh} · ${defaultTemplate.summaryZh}` : '-')}</dd></div><div><dt>协议状态</dt><dd>${html(collaborationStatusLabel(group.protocolStatus))}</dd></div><div><dt>已验证版本</dt><dd>${html(group.lastVerifiedHead || '-')}</dd></div></dl><div class="collaboration-record-actions"><button type="button" class="btn-ghost" data-collaboration-action="backup">创建备份</button><button type="button" class="btn-ghost" data-collaboration-action="restore">恢复备份</button>${groupAction('updateSettings') ? '<button type="button" class="btn-ghost" data-collaboration-action="edit-default-template">修改新成员默认模板</button>' : ''}${lifecycleActions}</div></section>`;
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
      analysis: renderAnalysis,
      members: renderMembers,
      audit: renderAudit,
      settings: renderSettings,
      diagnostics: renderDiagnostics,
    };
    elements.content.innerHTML = (
      renderers[state.activeTab] || renderOverview
    )();
  };

  const previewFile = async (file) => {
    if (!file?.repositoryPath) return false;
    const group = selectedGroup();
    const url = options.fileUrl(
      `/api/collaboration/groups/${encodeURIComponent(group.groupId)}/files/content?path=${encodeURIComponent(file.repositoryPath)}`,
    );
    const textMedia = /^(?:text\/|application\/(?:json|xml))/u.test(
      file.metadata?.media_type || '',
    );
    let text = '';
    if (textMedia) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('File content is unavailable');
      text = await response.text();
    }
    state.selectedFileId = file.metadata?.file_id || '';
    state.filePreview = {
      fileId: state.selectedFileId,
      name: file.virtualPath || file.repositoryPath,
      mediaType: file.metadata?.media_type,
      url,
      text,
    };
    return true;
  };

  const loadTabData = async () => {
    const groupId = state.selectedGroupId;
    if (!groupId) return;
    if (state.activeTab === 'overview') {
      const base = `/groups/${encodeURIComponent(groupId)}`;
      const [insightData, myItemData, notificationData, runData] =
        await Promise.all([
          options.request(`${base}/insights`),
          options.request(`${base}/my-items`),
          options.request(`${base}/notifications`),
          options.request(`${base}/analysis-runs`),
        ]);
      state.tabData.overview = {
        insight: insightData.insight,
        myItems: myItemData.items || [],
        notifications: notificationData.notifications || [],
        runs: runData.runs || [],
      };
      if (state.selectedAnalysisId)
        state.tabData.analysisDetail = await options.request(
          `${base}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}`,
        );
    } else if (state.activeTab === 'analysis') {
      const base = `/groups/${encodeURIComponent(groupId)}/analysis-runs`;
      const runData = await options.request(base);
      state.tabData.analysis = { runs: runData.runs || [] };
      state.tabData.analysisDetail = state.selectedAnalysisId
        ? await options.request(
            `${base}/${encodeURIComponent(state.selectedAnalysisId)}`,
          )
        : null;
    } else if (state.activeTab === 'files') {
      const data = await options.request(
        `/groups/${encodeURIComponent(groupId)}/files`,
      );
      state.tabData.files = data.files || [];
      if (state.selectedFileId) {
        const selected = collaborationFileById(
          state.tabData.files,
          state.selectedFileId,
        );
        state.selectedFileId = '';
        state.filePreview = null;
        if (selected) {
          try {
            await previewFile(selected);
          } catch {
            state.filePreview = null;
            options.showToast('目标文件不可用，已返回文件列表');
          }
        }
      }
    } else if (state.activeTab === 'members')
      state.tabData.members = await options.request(
        `/groups/${encodeURIComponent(groupId)}/members`,
      );
    else if (state.activeTab === 'audit')
      state.tabData.audit = await options.request(
        `/groups/${encodeURIComponent(groupId)}/audit`,
      );
    else if (state.activeTab === 'diagnostics')
      state.tabData.diagnostics = await options.request(
        `/groups/${encodeURIComponent(groupId)}/diagnostics`,
      );
    renderContent();
    scheduleAnalysisPoll();
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
      const [statusData, data, catalog] = await Promise.all([
        options.request('/status'),
        options.request('/groups'),
        options.request('/permission-catalog'),
      ]);
      state.status = statusData.collaboration;
      state.permissionCatalog = catalog;
      setBanner(
        state.status?.available ? '' : state.status?.error || '群组服务不可用',
      );
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
    clearAnalysisPoll();
    state.selectedGroupId = groupId;
    state.activeTab = selectOptions.tab || 'overview';
    state.selectedWorkItemId = '';
    state.selectedDiscussionId = '';
    state.selectedInstanceId = '';
    state.selectedAnalysisId = '';
    state.tabData = {};
    await loadDetail(groupId, selectOptions.updateRoute !== false);
  };

  const selectTab = async (tab, selectOptions = {}) => {
    if (!collaborationRouteTabs.has(tab)) return;
    clearAnalysisPoll();
    state.activeTab = tab;
    if (tab !== 'overview') state.selectedAnalysisId = '';
    renderShell();
    if (selectOptions.updateRoute !== false) updateRoute();
    await loadTabData();
  };

  const syncSelected = async () => {
    if (!state.selectedGroupId) return;
    const groupId = state.selectedGroupId;
    const result = await options.request(
      `/groups/${encodeURIComponent(state.selectedGroupId)}/sync`,
      {
        method: 'POST',
        body: '{}',
      },
    );
    if (!result.group) {
      forgetLocalGroup(groupId);
      options.showToast('远端生命周期已同步，群组已从本机列表移除');
      return;
    }
    await loadDetail(groupId, false);
    options.showToast('群组同步完成');
  };

  const notificationScopeLabel = (group, scope) => {
    const projection = group.projection;
    const labels = {
      group: group.name,
      work_item: projection.workItems?.[scope.ref]?.title,
      discussion: projection.discussions?.[scope.ref]?.discussion?.title,
      workflow_definition:
        projection.workflowDefinitions?.[
          `${scope.ref}@${projection.latestWorkflowDefinitionVersions?.[scope.ref]}`
        ]?.definition?.name,
      workflow_instance: scope.ref,
      turn: projection.turns?.[scope.ref]?.state_id,
      file: projection.files?.[scope.ref]?.original_filename,
    };
    return `${collaborationLabel(scope.type)} · ${labels[scope.type] || collaborationShortId(scope.ref)}`;
  };

  const openNotificationComposer = () => {
    const group = selectedGroup();
    const members = collaborationActiveNotificationMembers(group);
    if (!members.length) throw new Error('群组中没有其他 Active Member');
    const scope = collaborationNotificationScope(group, state);
    openDialog({
      title: '通知成员',
      submitText: '发送通知',
      body: `<div class="collaboration-form-grid collaboration-form-grid-single"><div class="collaboration-context-summary"><span>通知上下文</span><strong>${html(notificationScopeLabel(group, scope))}</strong></div>${memberPicker(group, { legend: '接收成员' })}${field('Markdown 消息', 'bodyMarkdown', '', { multiline: true, hint: '消息会随签名事件写入群组 Git 历史。' })}</div>`,
      onOpen: () => bindMemberPicker(elements.dialogBody),
      onSubmit: async (formData) => {
        const request = buildCollaborationMemberNotificationRequest({
          recipientPrincipalIds: formData.getAll('recipientPrincipalIds'),
          bodyMarkdown: formData.get('bodyMarkdown'),
          scope,
        });
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/notifications`,
          { method: 'POST', body: JSON.stringify(request) },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        options.showToast(`已通知 ${request.recipientPrincipalIds.length} 名成员`);
      },
    });
  };

  const openCreate = () =>
    openDialog({
      title: '创建群组',
      submitText: '创建',
      body: `<div class="collaboration-form-grid">${field('群组名称', 'name')}${field('Git 远程仓库', 'remoteUrl')}${field('Git Remote SSH Key（可选）', 'gitSshKeyPath', '', { required: false })}${field('成员显示名', 'displayName')}${field('客户端名称', 'clientDisplayName')}${field(
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
      )}${field('新成员默认权限', 'defaultPermissionTemplateId', 'member.v1', {
        options: permissionTemplates().map((template) => [
          template.id,
          `${template.nameZh} · ${template.summaryZh}`,
        ]),
      })}${field('观察者访问', 'observerAccess', 'allowed', {
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
      body: `<div class="collaboration-form-grid">${field('Git 远程仓库', 'remoteUrl')}${field('Git Remote SSH Key（可选）', 'gitSshKeyPath', '', { required: false })}</div>`,
      onSubmit: async (formData) => {
        const gitSshKeyPath = String(
          formData.get('gitSshKeyPath') || '',
        ).trim();
        const data = await options.request('/subscriptions', {
          method: 'POST',
          body: JSON.stringify({
            remoteUrl: formData.get('remoteUrl'),
            ...(gitSshKeyPath ? { gitSshKeyPath } : {}),
          }),
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
      body: `<div class="collaboration-form-grid">${field('Git Remote SSH Key（可选）', 'gitSshKeyPath', group.gitRemoteAccess?.sshKeyPath || '', { required: false })}${field('成员显示名', 'displayName')}${field('客户端名称', 'clientDisplayName')}${inviteOnly ? field('邀请 ID', 'inviteId') : ''}</div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/join-requests`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationJoinRequest({
                ...Object.fromEntries(formData.entries()),
                configuredGitSshKeyPath:
                  group.gitRemoteAccess?.sshKeyPath || '',
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const requestRecovery = () => {
    const group = selectedGroup();
    const principals = Object.values(group.projection?.members || {}).filter(
      (member) => member.status === 'active',
    );
    if (!principals.length) throw new Error('群组中没有可恢复的 Principal');
    openDialog({
      title: '恢复已有身份',
      submitText: '提交恢复请求',
      body: `<div class="collaboration-form-grid">${field(
        '原 Principal',
        'targetPrincipalId',
        principals[0].principal_id,
        {
          options: principals.map((member) => [
            member.principal_id,
            `${member.display_name} · ${collaborationShortId(member.principal_id)}`,
          ]),
        },
      )}${field('新设备名称', 'clientDisplayName')}${field(
        '恢复方式',
        'type',
        'identity_recovery',
        {
          options: [
            ['identity_recovery', '旧设备可批准'],
            ['owner_recovery', '旧设备和密钥均不可用'],
          ],
        },
      )}${field('申请原因', 'reason', '', {
        multiline: true,
        required: false,
      })}</div>`,
      onSubmit: async (formData) => {
        const values = Object.fromEntries(formData.entries());
        const reason = String(values.reason || '').trim();
        if (values.type === 'owner_recovery' && !reason)
          throw new Error('群主恢复必须填写申请原因');
        const result = await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/recovery-requests`,
          {
            method: 'POST',
            body: JSON.stringify({
              targetPrincipalId: values.targetPrincipalId,
              type: values.type,
              clientDisplayName: values.clientDisplayName,
              reason: reason || null,
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        openDialog({
          title: '恢复请求已提交',
          body: `<dl class="collaboration-definition-list"><div><dt>验证码</dt><dd><code class="collaboration-verification-code">${html(result.verificationCode)}</code></dd></div><div><dt>请求 ID</dt><dd>${html(result.requestId)}</dd></div><div><dt>请求 Hash</dt><dd>${html(result.requestHash)}</dd></div></dl>`,
        });
      },
    });
  };

  const decideRecovery = (requestId, decision) => {
    const group = selectedGroup();
    const requests =
      state.tabData.members?.recoveryRequests ||
      group.projection?.recoveryRequests ||
      {};
    const request = requests[requestId];
    if (!request) throw new Error('恢复请求不存在');
    const offlineOnly =
      decision === 'approve' &&
      request.type === 'owner_recovery' &&
      !collaborationCanMutate(group) &&
      group.icarusIdentity?.recoveryCredentialAvailable;
    const ownerApproval =
      decision === 'approve' && request.type === 'owner_recovery';
    const revocableCredentialIds = Object.values(
      group.projection?.credentials?.[request.target_principal_id] || {},
    )
      .filter(
        (credential) =>
          credential.purpose === 'event_signing' &&
          credential.status === 'active' &&
          credential.credential_id !==
            request.requested_credential.credential_id,
      )
      .map((credential) => credential.credential_id);
    openDialog({
      title: decision === 'approve' ? '批准身份恢复' : '拒绝身份恢复',
      submitText: decision === 'approve' ? '确认批准' : '确认拒绝',
      danger: decision === 'reject',
      body: `<dl class="collaboration-definition-list"><div><dt>新设备</dt><dd>${html(request.requested_client.display_name)}</dd></div><div><dt>Credential</dt><dd>${html(request.requested_credential.fingerprint)}</dd></div><div><dt>申请时间</dt><dd>${html(timestamp(request.created_at))}</dd></div><div><dt>过期时间</dt><dd>${html(timestamp(request.expires_at))}</dd></div><div><dt>验证码</dt><dd><code class="collaboration-verification-code">${html(request.verification_code || '------')}</code></dd></div></dl><div class="collaboration-form-grid">${field(decision === 'approve' ? '核验与批准原因' : '拒绝原因', 'reason', '', { multiline: true })}${
        ownerApproval
          ? `${field('旧 Credential 撤销范围', 'credentialScope', 'all', {
              options: [
                ['all', '全部旧 event-signing Credentials'],
                ['selected', '仅指定 Credentials'],
              ],
            })}${field('指定 Credential IDs', 'revokeCredentialIds', revocableCredentialIds.join(', '), { multiline: true, required: false })}`
          : ''
      }${offlineOnly ? '<label class="collaboration-field collaboration-check-field"><input type="checkbox" name="useOfflineOwnerCredential" checked><span>使用已导入的离线 Group recovery Credential</span></label>' : ''}</div>`,
      onSubmit: async (formData) => {
        const credentialScope = formData.get('credentialScope');
        const revokeCredentialIds = String(
          formData.get('revokeCredentialIds') || '',
        )
          .split(/[\s,]+/u)
          .map((value) => value.trim())
          .filter(Boolean);
        if (
          ownerApproval &&
          credentialScope === 'selected' &&
          revokeCredentialIds.length === 0
        )
          throw new Error('指定撤销范围至少需要一个 Credential ID');
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/recovery-requests/${encodeURIComponent(requestId)}/${decision === 'approve' ? 'approve' : 'reject'}`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'recovery',
                requestId,
              ),
              reason: formData.get('reason'),
              ...(offlineOnly
                ? {
                    useOfflineOwnerCredential: Boolean(
                      formData.get('useOfflineOwnerCredential'),
                    ),
                  }
                : {}),
              ...(ownerApproval && credentialScope === 'selected'
                ? { revokeCredentialIds }
                : {}),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        await loadTabData();
      },
    });
  };

  const cancelRecovery = (requestId) => {
    const group = selectedGroup();
    openDialog({
      title: '取消身份恢复',
      submitText: '确认取消',
      body: field('取消原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/recovery-requests/${encodeURIComponent(requestId)}/cancel`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'recovery',
                requestId,
              ),
              reason: formData.get('reason'),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        await loadTabData();
      },
    });
  };

  const rotateCredential = () => {
    const group = selectedGroup();
    openDialog({
      title: '轮换当前 Credential',
      submitText: '生成并轮换',
      body: '<label class="collaboration-field collaboration-check-field"><input type="checkbox" name="revokeCurrent" checked><span>轮换后撤销当前 Credential</span></label>',
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/credentials/rotate`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'membership',
                group.localPrincipalId,
              ),
              revokeCurrent: Boolean(formData.get('revokeCurrent')),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        await loadTabData();
      },
    });
  };

  const revokeCredential = (credentialId) => {
    const group = selectedGroup();
    openDialog({
      title: '撤销 Credential',
      submitText: '确认撤销',
      danger: true,
      body: field('撤销原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/credentials/${encodeURIComponent(credentialId)}/revoke`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'membership',
                group.localPrincipalId,
              ),
              reason: formData.get('reason'),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        await loadTabData();
      },
    });
  };

  const revokeClient = (clientId) => {
    const group = selectedGroup();
    openDialog({
      title: '撤销 Client',
      submitText: '撤销 Client 与其 Credentials',
      danger: true,
      body: field('撤销原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/clients/${encodeURIComponent(clientId)}/revoke`,
          {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'membership',
                group.localPrincipalId,
              ),
              reason: formData.get('reason'),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
        await loadTabData();
      },
    });
  };

  const issueInvite = () => {
    const group = selectedGroup();
    openDialog({
      title: '发放邀请',
      submitText: '发放',
      body: `<div class="collaboration-form-grid">${field('过期时间', 'expiresAt', '', { required: false })}</div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/invites`,
          {
            method: 'POST',
            body: JSON.stringify({
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

  const openPermissionEditor = (principalId, approval = false) => {
    const group = selectedGroup();
    const templates = permissionTemplates();
    const permissions = permissionCatalog();
    const current = approval
      ? []
      : group.projection.permissionGrants?.[principalId]?.grants || [];
    const matched = templates.find(
      (template) =>
        [...template.permissions].sort().join('\0') ===
        [...current].sort().join('\0'),
    );
    const defaultTemplateId =
      group.projection?.group?.default_permission_template_id ||
      group.allowedActions?.catalogs?.defaultTemplateId ||
      'member.v1';
    const selectedTemplateId = approval
      ? defaultTemplateId
      : matched?.id || '__custom__';
    const renderDiff = () => {
      const selected = [
        ...elements.dialogForm.querySelectorAll(
          'input[name="permissionGrant"]:checked',
        ),
      ].map((control) => control.value);
      const added = selected.filter((value) => !current.includes(value));
      const removed = current.filter((value) => !selected.includes(value));
      const preview = elements.dialogBody.querySelector(
        '[data-permission-preview]',
      );
      if (preview)
        preview.innerHTML = `<span class="ok">新增 ${html(added.length)}</span><span class="danger">撤销 ${html(removed.length)}</span>${added.length ? `<small>+ ${html(added.map(collaborationPermissionLabel).join('、'))}</small>` : ''}${removed.length ? `<small>- ${html(removed.map(collaborationPermissionLabel).join('、'))}</small>` : ''}`;
    };
    openDialog({
      title: approval ? '批准成员并授权' : '成员权限',
      submitText: approval ? '批准并授权' : '确认变更',
      wide: true,
      body: `<div class="collaboration-permission-editor">${field(
        '权限模板',
        'templateId',
        selectedTemplateId,
        {
          options: [
            ...templates.map((template) => [
              template.id,
              `${template.nameZh} · ${template.summaryZh}`,
            ]),
            ['__custom__', '自定义权限'],
          ],
        },
      )}<div class="collaboration-template-summary">${templates
        .map(
          (template) =>
            `<details><summary>${html(template.nameZh)}</summary><p>${html(template.summaryZh)}</p><div>${template.permissions.map((permission) => `<code>${html(collaborationPermissionLabel(permission))}</code>`).join(' ')}</div></details>`,
        )
        .join(
          '',
        )}</div><fieldset class="collaboration-permission-grid"><legend>高级权限</legend>${permissions
        .map(
          (permission) =>
            `<label><input type="checkbox" name="permissionGrant" value="${attr(permission.id)}" ${current.includes(permission.id) ? 'checked' : ''}><span><strong>${html(permission.nameZh)}</strong><small>${html(permission.summaryZh)}</small></span></label>`,
        )
        .join(
          '',
        )}</fieldset><div class="collaboration-permission-preview" data-permission-preview></div></div>`,
      onOpen: () => {
        const templateSelect = elements.dialogForm.elements.templateId;
        const applyTemplate = () => {
          const template = templates.find(
            (entry) => entry.id === templateSelect.value,
          );
          if (template)
            for (const control of elements.dialogForm.querySelectorAll(
              'input[name="permissionGrant"]',
            ))
              control.checked = template.permissions.includes(control.value);
          renderDiff();
        };
        templateSelect.addEventListener('change', applyTemplate);
        elements.dialogBody
          .querySelector('.collaboration-permission-grid')
          ?.addEventListener('change', () => {
            templateSelect.value = '__custom__';
            renderDiff();
          });
        if (approval || matched) applyTemplate();
        else renderDiff();
      },
      onSubmit: async (formData) => {
        const templateId = String(formData.get('templateId') || '');
        const grants = formData.getAll('permissionGrant');
        const endpoint = approval
          ? `/groups/${encodeURIComponent(group.groupId)}/join-requests/${encodeURIComponent(principalId)}/approve`
          : `/groups/${encodeURIComponent(group.groupId)}/permissions/${encodeURIComponent(principalId)}`;
        await options.request(endpoint, {
          method: approval ? 'POST' : 'PUT',
          body: JSON.stringify({
            expectedRevision: aggregateRevision(
              group.projection,
              'membership',
              principalId,
            ),
            grants,
            ...(templateId !== '__custom__' ? { templateId } : {}),
          }),
        });
        closeDialog();
        await loadDetail(group.groupId, false);
        if (state.activeTab === 'members') await loadTabData();
      },
    });
  };

  const editDefaultTemplate = () => {
    const group = selectedGroup();
    const current =
      group.projection?.group?.default_permission_template_id || 'member.v1';
    openDialog({
      title: '新成员默认权限模板',
      submitText: '更新默认模板',
      body: `<div class="collaboration-form-grid">${field(
        '默认模板',
        'defaultPermissionTemplateId',
        current,
        {
          options: permissionTemplates().map((template) => [
            template.id,
            `${template.nameZh} · ${template.summaryZh}`,
          ]),
        },
      )}<p class="collaboration-muted-note">只影响以后开放加入或批准的成员，不会改写现有授权。</p></div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/settings`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'group',
                group.groupId,
              ),
              defaultPermissionTemplateId: formData.get(
                'defaultPermissionTemplateId',
              ),
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

  const editWorkItem = () => {
    const group = selectedGroup();
    const item = group.projection.workItems[state.selectedWorkItemId];
    const activeMembers = Object.values(group.projection?.members || {}).filter(
      (member) => member.status === 'active',
    );
    const memberChecks = (name, selected) =>
      `<fieldset class="collaboration-mention-picker"><legend>${name === 'contributors' ? '贡献者' : '关注者'}</legend>${activeMembers
        .map(
          (member) =>
            `<label><input type="checkbox" name="${name}" value="${attr(member.principal_id)}" ${selected.includes(member.principal_id) ? 'checked' : ''}><span>${html(member.display_name)}</span><small>${html(collaborationShortId(member.principal_id))}</small></label>`,
        )
        .join('')}</fieldset>`;
    openDialog({
      title: '编辑工作项',
      wide: true,
      body: `<div class="collaboration-form-grid">${field(
        '类型',
        'type',
        item.type,
        {
          options: [
            ['task', '任务'],
            ['issue', '问题'],
            ['decision', '决策'],
            ['milestone', '里程碑'],
          ],
        },
      )}${field('标题', 'title', item.title)}${field('描述', 'description', item.description, { multiline: true, required: false })}${field(
        '优先级',
        'priority',
        item.priority,
        {
          options: [
            ['low', '低'],
            ['normal', '普通'],
            ['high', '高'],
            ['urgent', '紧急'],
          ],
        },
      )}${field('首选 Executor ID', 'preferredExecutorId', item.preferred_executor_id || '', { required: false })}${field('截止时间（ISO 8601）', 'dueAt', item.due_at || '', { required: false })}${field('验收标准（每行一项）', 'acceptanceCriteria', (item.acceptance_criteria || []).join('\n'), { multiline: true, required: false })}${field('标签（逗号或换行分隔）', 'labels', (item.labels || []).join('\n'), { multiline: true, required: false })}${memberChecks('contributors', item.contributors || [])}${memberChecks('watchers', item.watchers || [])}</div>`,
      onSubmit: async (formData) => {
        const split = (value) =>
          String(value || '')
            .split(/[,\r\n]+/u)
            .map((entry) => entry.trim())
            .filter(Boolean);
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(
              buildCollaborationWorkItemDetailsRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'work_item',
                  item.work_item_id,
                ),
                type: formData.get('type'),
                title: formData.get('title'),
                description: formData.get('description'),
                priority: formData.get('priority'),
                preferredExecutorId: formData.get('preferredExecutorId'),
                dueAt: formData.get('dueAt'),
                acceptanceCriteria: split(formData.get('acceptanceCriteria')),
                labels: split(formData.get('labels')),
                contributors: formData.getAll('contributors'),
                watchers: formData.getAll('watchers'),
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const assignWorkItem = () => {
    const group = selectedGroup();
    const item = group.projection.workItems[state.selectedWorkItemId];
    const activeMembers = Object.values(group.projection?.members || {}).filter(
      (member) => member.status === 'active',
    );
    openDialog({
      title: '变更工作项负责人',
      body: `<div class="collaboration-form-grid">${field('负责人', 'ownerPrincipalId', item.owner_principal_id, { options: activeMembers.map((member) => [member.principal_id, `${member.display_name} · ${collaborationShortId(member.principal_id)}`]) })}${field('首选 Executor ID', 'preferredExecutorId', item.preferred_executor_id || '', { required: false })}<label class="collaboration-toggle"><input type="checkbox" name="requireAcknowledgement" ${item.owner_principal_id === group.localPrincipalId ? '' : 'checked'}><span>要求新负责人确认</span></label></div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}/assignment`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationWorkItemAssignmentRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'work_item',
                  item.work_item_id,
                ),
                ownerPrincipalId: formData.get('ownerPrincipalId'),
                preferredExecutorId: formData.get('preferredExecutorId'),
                requireAcknowledgement: formData.has('requireAcknowledgement'),
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const relateWorkItem = () => {
    const group = selectedGroup();
    const item = group.projection.workItems[state.selectedWorkItemId];
    const candidates = Object.values(group.projection?.workItems || {}).filter(
      (candidate) => candidate.work_item_id !== item.work_item_id,
    );
    const checks = (name, title, selected) =>
      `<fieldset class="collaboration-mention-picker"><legend>${title}</legend>${
        candidates
          .map(
            (candidate) =>
              `<label><input type="checkbox" name="${name}" value="${attr(candidate.work_item_id)}" ${selected.includes(candidate.work_item_id) ? 'checked' : ''}><span>${html(candidate.title)}</span><small>${html(collaborationStatusLabel(candidate.status))}</small></label>`,
          )
          .join('') || empty('没有其他工作项')
      }</fieldset>`;
    openDialog({
      title: '变更工作项关系',
      wide: true,
      body: `<div class="collaboration-form-grid">${field('父工作项', 'parentId', item.parent_id || '', { options: [['', '无'], ...candidates.map((candidate) => [candidate.work_item_id, `${candidate.title} · ${collaborationStatusLabel(candidate.status)}`])] })}${checks('blockedBy', '被以下工作项阻塞', item.blocked_by || [])}${checks('relatedItems', '关联工作项', item.related_items || [])}</div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}/relations`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationWorkItemRelationsRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'work_item',
                  item.work_item_id,
                ),
                parentId: formData.get('parentId'),
                blockedBy: formData.getAll('blockedBy'),
                relatedItems: formData.getAll('relatedItems'),
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const archiveWorkItem = () => {
    const group = selectedGroup();
    const item = group.projection.workItems[state.selectedWorkItemId];
    openDialog({
      title: '归档工作项',
      submitText: '确认归档',
      danger: true,
      body: field('归档原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}/archive`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationReasonRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'work_item',
                  item.work_item_id,
                ),
                reason: formData.get('reason'),
              }),
            ),
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

  const submitDiscussionMutation = async (groupId, operation) => {
    try {
      await operation();
    } catch (error) {
      if (/revision conflict|stale/iu.test(String(error))) {
        await loadDetail(groupId, false);
        throw new Error('讨论已在其他客户端更新，页面已刷新；请核对后重试');
      }
      throw error;
    }
    closeDialog();
    await loadDetail(groupId, false);
  };

  const newDiscussion = () => {
    const group = selectedGroup();
    const canPost = groupAction('postDiscussion');
    openDialog({
      title: '新建讨论',
      submitText: '创建讨论',
      body: `<div class="collaboration-form-grid collaboration-form-grid-single">${field('标题', 'title')}${canPost ? `${field('首条消息（可选）', 'body', '', { multiline: true, required: false })}${memberPicker(group, { name: 'mentions', legend: '@成员（可选）' })}` : ''}</div>`,
      onOpen: () => {
        if (canPost) bindMemberPicker(elements.dialogBody);
      },
      onSubmit: async (formData) => {
        const body = String(formData.get('body') || '').trim();
        const request = {
          title: formData.get('title'),
          scope: { type: 'group' },
        };
        if (canPost && body) {
          const message = buildCollaborationDiscussionMessageRequest({
            expectedRevision: 0,
            body,
            mentions: formData.getAll('mentions'),
          });
          request.body = message.body;
          request.mentions = message.mentions;
        }
        await submitDiscussionMutation(group.groupId, () =>
          options.request(
            `/groups/${encodeURIComponent(group.groupId)}/discussions`,
            {
              method: 'POST',
              body: JSON.stringify(request),
            },
          ),
        );
      },
    });
  };

  const newMessage = () => {
    const group = selectedGroup();
    const thread = group.projection.discussions[state.selectedDiscussionId];
    openDialog({
      title: '回复讨论',
      submitText: '发布回复',
      body: `<div class="collaboration-form-grid collaboration-form-grid-single">${field('Markdown 消息', 'body', '', { multiline: true })}${memberPicker(group, { name: 'mentions', legend: '@成员（可选）' })}</div>`,
      onOpen: () => bindMemberPicker(elements.dialogBody),
      onSubmit: async (formData) => {
        await submitDiscussionMutation(group.groupId, () =>
          options.request(
            `/groups/${encodeURIComponent(group.groupId)}/discussions/${encodeURIComponent(state.selectedDiscussionId)}/messages`,
            {
              method: 'POST',
              body: JSON.stringify(
                buildCollaborationDiscussionMessageRequest({
                  expectedRevision: aggregateRevision(
                    group.projection,
                    'discussion',
                    thread.discussion.thread_id,
                  ),
                  body: formData.get('body'),
                  mentions: formData.getAll('mentions'),
                }),
              ),
            },
          ),
        );
      },
    });
  };

  const reviseMessage = (messageId) => {
    const group = selectedGroup();
    const thread = group.projection.discussions[state.selectedDiscussionId];
    const message = thread.messages[messageId];
    openDialog({
      title: '编辑消息',
      submitText: '保存修改',
      body: `<div class="collaboration-form-grid collaboration-form-grid-single">${field('Markdown 消息', 'body', message.body, { multiline: true })}${memberPicker(group, { name: 'mentions', legend: '@成员（可选）', selected: message.mentions || [] })}</div>`,
      onOpen: () => bindMemberPicker(elements.dialogBody),
      onSubmit: async (formData) => {
        await submitDiscussionMutation(group.groupId, () =>
          options.request(
            `/groups/${encodeURIComponent(group.groupId)}/discussions/${encodeURIComponent(thread.discussion.thread_id)}/messages/${encodeURIComponent(messageId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify(
                buildCollaborationDiscussionMessageRequest({
                  expectedRevision: aggregateRevision(
                    group.projection,
                    'discussion',
                    thread.discussion.thread_id,
                  ),
                  body: formData.get('body'),
                  mentions: formData.getAll('mentions'),
                  refs: message.refs || [],
                }),
              ),
            },
          ),
        );
      },
    });
  };

  const tombstoneMessage = (messageId) => {
    const group = selectedGroup();
    const thread = group.projection.discussions[state.selectedDiscussionId];
    openDialog({
      title: '删除消息',
      submitText: '确认删除',
      danger: true,
      body: `<p class="collaboration-muted-note">消息正文会被软删除，签名事件和审计历史仍会保留。</p>${field('删除原因（可选）', 'reason', '', { multiline: true, required: false })}`,
      onSubmit: async (formData) => {
        await submitDiscussionMutation(group.groupId, () =>
          options.request(
            `/groups/${encodeURIComponent(group.groupId)}/discussions/${encodeURIComponent(thread.discussion.thread_id)}/messages/${encodeURIComponent(messageId)}`,
            {
              method: 'DELETE',
              body: JSON.stringify({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'discussion',
                  thread.discussion.thread_id,
                ),
                reason: String(formData.get('reason') || '').trim(),
              }),
            },
          ),
        );
      },
    });
  };

  const changeDiscussionStatus = (resolved) => {
    const group = selectedGroup();
    const thread = group.projection.discussions[state.selectedDiscussionId];
    openDialog({
      title: resolved ? '解决讨论' : '重新打开讨论',
      submitText: resolved ? '确认解决' : '确认重新打开',
      body: `<p class="collaboration-muted-note">${resolved ? '解决后将停止回复和消息编辑；有后续事项时可以重新打开。' : '重新打开后，具备参与权限的成员可以继续回复和编辑自己的消息。'}</p>`,
      onSubmit: async () => {
        await submitDiscussionMutation(group.groupId, () =>
          options.request(
            `/groups/${encodeURIComponent(group.groupId)}/discussions/${encodeURIComponent(thread.discussion.thread_id)}/${resolved ? 'resolve' : 'reopen'}`,
            {
              method: 'POST',
              body: JSON.stringify(
                resolved
                  ? {
                      expectedRevision: aggregateRevision(
                        group.projection,
                        'discussion',
                        thread.discussion.thread_id,
                      ),
                      resolved: true,
                    }
                  : {
                      expectedRevision: aggregateRevision(
                        group.projection,
                        'discussion',
                        thread.discussion.thread_id,
                      ),
                    },
              ),
            },
          ),
        );
      },
    });
  };

  const uploadFile = () => {
    const group = selectedGroup();
    const scopeOptions = [
      ...(groupAction('writeSharedWorkspace') ? [['shared', '共享文件']] : []),
      ...(groupAction('postOwnedWorkspace') ? [['me', '个人文件']] : []),
    ];
    openDialog({
      title: '上传文件',
      body: `<div class="collaboration-form-grid">${field(
        '保存位置',
        'scope',
        scopeOptions[0]?.[0] || 'me',
        {
          options: scopeOptions,
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
    const definitionKey = entry
      ? `${entry.definition.definition_id}@${entry.definition.version}`
      : '';
    const editable = !entry
      ? groupAction('proposeWorkflowDefinition')
      : newVersion
        ? resourceAction('workflow_definition', definitionKey, 'createVersion')
        : resourceAction(
            'workflow_definition',
            definitionKey,
            'editDefinition',
          );
    const layoutOnly = Boolean(
      entry &&
      !newVersion &&
      !editable &&
      resourceAction('workflow_definition', definitionKey, 'editLayout'),
    );
    openDialog({
      title: entry
        ? `${entry.definition.name} · v${draft.version}`
        : '新建工作流定义',
      submitText: layoutOnly
        ? '保存布局'
        : entry && !newVersion
          ? '保存草稿'
          : '创建草稿',
      wide: true,
      body: `<div id="collaboration-workflow-editor-host"></div>`,
      onOpen: () => {
        workflowEditor = mountCollaborationFsmEditor(
          document.getElementById('collaboration-workflow-editor-host'),
          { draft, readonly: !editable && !layoutOnly, layoutOnly },
        );
      },
      onSubmit:
        !editable && !layoutOnly
          ? null
          : async () => {
              if (layoutOnly) {
                const currentDraft = workflowEditor.getDraft();
                await options.request(
                  `/groups/${encodeURIComponent(group.groupId)}/workflow-definitions/${encodeURIComponent(entry.definition.definition_id)}/layout`,
                  {
                    method: 'PUT',
                    body: JSON.stringify({
                      expectedRevision: aggregateRevision(
                        group.projection,
                        'workflow_definition',
                        entry.definition.definition_id,
                      ),
                      version: entry.definition.version,
                      view: currentDraft.layout.view,
                      nodes: currentDraft.layout.nodes,
                    }),
                  },
                );
                closeDialog();
                await loadDetail(group.groupId, false);
                return;
              }
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

  const retireWorkflow = (definitionKey) => {
    const group = selectedGroup();
    const entry = workflowDefinitionEntries().find(
      (candidate) =>
        `${candidate.definition.definition_id}@${candidate.definition.version}` ===
        definitionKey,
    );
    if (!entry) throw new Error('Workflow Definition 不存在');
    openDialog({
      title: '停用工作流定义',
      submitText: '确认停用',
      danger: true,
      body: field('停用原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-definitions/${encodeURIComponent(entry.definition.definition_id)}/retire`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationReasonRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'workflow_definition',
                  entry.definition.definition_id,
                ),
                reason: formData.get('reason'),
              }),
            ),
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
    const activeMembers = Object.values(group.projection?.members || {}).filter(
      (member) => member.status === 'active',
    );
    const activeMemberOptions = collaborationActiveMemberOptions(group);
    const workItems = Object.values(group.projection?.workItems || {}).filter(
      (item) => !item.archived,
    );
    const draft = {
      definitionKey: `${definitions[0]?.definition.definition_id}@${definitions[0]?.definition.version}`,
      scopeType: 'group',
      workItemId: '',
      participantBindings: {},
      workItemStatusMapping: {},
    };
    const selectedDefinition = () =>
      definitions.find(
        (entry) =>
          `${entry.definition.definition_id}@${entry.definition.version}` ===
          draft.definitionKey,
      );
    const capture = () => {
      const form = elements.dialogForm;
      draft.definitionKey = String(
        form.elements.definition?.value || draft.definitionKey,
      );
      draft.scopeType = String(form.elements.scope?.value || draft.scopeType);
      draft.workItemId = String(
        form.elements.workItemId?.value || draft.workItemId,
      );
      draft.participantBindings = Object.fromEntries(
        [...form.querySelectorAll('[data-participant-slot]')].map((control) => [
          control.dataset.participantSlot,
          control.value,
        ]),
      );
      draft.workItemStatusMapping = Object.fromEntries(
        [...form.querySelectorAll('[data-terminal-state]')].map((control) => [
          control.dataset.terminalState,
          control.value,
        ]),
      );
    };
    const renderWizard = (definitionChanged = false) => {
      const definition = selectedDefinition();
      const selectedItem = workItems.find(
        (item) => item.work_item_id === draft.workItemId,
      );
      if (definitionChanged) {
        draft.participantBindings = {};
        draft.workItemStatusMapping = {};
      }
      const launchAccess = collaborationWorkflowLaunchAccess(
        group,
        draft.definitionKey,
        draft.scopeType,
        draft.workItemId,
      );
      const slots = collaborationWorkflowParticipantSlots(definition);
      const suggestions = collaborationWorkflowBindingSuggestions({
        definition,
        workItem: selectedItem,
        activeMembers,
        currentPrincipalId: group.localPrincipalId,
      });
      for (const [slotId, principalId] of Object.entries(suggestions))
        draft.participantBindings[slotId] ||= principalId;
      const terminalStates = Object.entries(
        definition?.machine?.states || {},
      ).filter(([, state]) => state.terminal);
      const stateAssignments = Object.entries(
        definition?.machine?.states || {},
      ).filter(([, state]) => !state.terminal);
      const resolvedPreview = stateAssignments.map(([stateId, state]) => {
        const principalId =
          state.assignee?.type === 'principal'
            ? state.assignee.principal_id
            : draft.participantBindings[state.assignee?.slot] || '';
        const active = activeMembers.some(
          (member) => member.principal_id === principalId,
        );
        return `<div class="${principalId && active ? 'ok' : 'danger'}"><strong>${html(workflowStateLabel(definition, stateId))}</strong><span>${principalId ? html(collaborationPrincipalName(group.projection, principalId)) : '待选择'}${principalId ? ` · ${html(collaborationShortId(principalId))}` : ''}</span></div>`;
      });
      elements.dialogBody.innerHTML = `<div class="collaboration-workflow-wizard"><section><header><span>1</span><div><strong>Definition 与范围</strong><small>选择业务流程和关联工作项</small></div></header><div class="collaboration-form-grid">${field('Workflow Definition', 'definition', draft.definitionKey, { options: definitions.map((entry) => [`${entry.definition.definition_id}@${entry.definition.version}`, `${entry.definition.name} · v${entry.definition.version}`]) })}${field(
        '作用范围',
        'scope',
        draft.scopeType,
        {
          options: [
            ['group', '整个群组'],
            ['work_item', '指定工作项'],
          ],
        },
      )}<label class="collaboration-field ${draft.scopeType === 'work_item' ? '' : 'hidden'}"><span>工作项</span><select name="workItemId"><option value="">请选择工作项</option>${workItems.map((item) => `<option value="${attr(item.work_item_id)}" ${item.work_item_id === draft.workItemId ? 'selected' : ''}>${html(item.title)} · ${html(collaborationStatusLabel(item.status))}</option>`).join('')}</select></label></div></section><section><header><span>2</span><div><strong>参与者</strong><small>只显示 Active Principal；同一成员可承担多个槽位</small></div></header><div class="collaboration-slot-list">${slots.map((slot) => `<label class="collaboration-slot-field"><span><strong>${html(slot.label)}</strong><small>${html(slot.description || '负责流程中的指定 State')}</small><em>${slot.states.map((state) => html(state.label)).join('、')}</em></span><select data-participant-slot="${attr(slot.id)}" required><option value="">请选择 Active Principal</option>${activeMemberOptions.map(([principalId, label]) => `<option value="${attr(principalId)}" ${principalId === draft.participantBindings[slot.id] ? 'selected' : ''}>${html(label)}</option>`).join('')}</select></label>`).join('') || empty('此 Definition 没有参与者槽位')}</div></section><section class="${draft.scopeType === 'work_item' ? '' : 'hidden'}"><header><span>3</span><div><strong>终态映射</strong><small>每个终止 State 必须映射工作项状态</small></div></header><div class="collaboration-terminal-map">${terminalStates.map(([stateId, state]) => field(collaborationLabel(state.label || stateId), `terminal:${stateId}`, draft.workItemStatusMapping[stateId] || '', { options: [['', '请选择状态'], ...COLLABORATION_WORK_ITEM_STATUSES.map((value) => [value, collaborationStatusLabel(value)])] }).replace('<select ', `<select data-terminal-state="${attr(stateId)}" `)).join('')}</div></section><section><header><span>${draft.scopeType === 'work_item' ? '4' : '3'}</span><div><strong>解析预览</strong><small>提交时服务端会重新校验权限与成员状态</small></div></header><div class="collaboration-resolution-preview">${resolvedPreview.join('') || empty('没有可执行 State')}</div><div class="collaboration-rule-summary"><span>${html(definition?.definition?.launch_policy?.work_item_owner ? '工作项负责人可启动' : '按直接权限或指定 Principal 启动')}</span><span class="${launchAccess.allowed ? 'ok' : 'danger'}">${html(launchAccess.reason || '当前身份满足创建规则')}</span></div></section></div>`;
      elements.dialogSubmit.disabled = !launchAccess.allowed;
      if (launchAccess.reason)
        elements.dialogSubmit.title = launchAccess.reason;
      else elements.dialogSubmit.removeAttribute('title');
    };
    openDialog({
      title: '新建工作流实例',
      wide: true,
      body: '<div class="collaboration-section-empty">正在准备 Workflow</div>',
      onOpen: () => {
        renderWizard();
        elements.dialogBody.addEventListener('change', (event) => {
          const previousDefinition = draft.definitionKey;
          capture();
          renderWizard(
            event.target.name === 'definition' &&
              previousDefinition !== draft.definitionKey,
          );
        });
      },
      onSubmit: async (formData) => {
        capture();
        const launchAccess = collaborationWorkflowLaunchAccess(
          group,
          draft.definitionKey,
          draft.scopeType,
          draft.workItemId,
        );
        if (!launchAccess.allowed)
          throw new Error(launchAccess.reason || '当前身份不能创建此实例');
        const request = buildCollaborationWorkflowInstanceRequest({
          definition: selectedDefinition(),
          scopeType: draft.scopeType,
          workItemId: draft.workItemId,
          participantBindings: draft.participantBindings,
          workItemStatusMapping: draft.workItemStatusMapping,
          activeMembers,
        });
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances`,
          {
            method: 'POST',
            body: JSON.stringify(request),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const reassignInstance = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const definition = workflowDefinitionEntries().find(
      (entry) =>
        entry.definition.definition_id === instance.definition_id &&
        entry.definition.version === instance.definition_version,
    );
    const activeMembers = Object.values(group.projection?.members || {}).filter(
      (member) => member.status === 'active',
    );
    const states = Object.entries(definition?.machine?.states || {}).filter(
      ([, state]) => !state.terminal,
    );
    const stateDecisions = Object.fromEntries(
      states.map(([stateId]) => [
        stateId,
        collaborationWorkflowStateActionAccess(
          group,
          instance.instance_id,
          stateId,
        ),
      ]),
    );
    const editableStates = states.filter(
      ([stateId]) => stateDecisions[stateId]?.allowed,
    );
    openDialog({
      title: instance.lifecycle === 'draft' ? '补齐参与者' : '重新分配参与者',
      submitText: '确认分配',
      wide: true,
      body: `<div class="collaboration-form-grid">${states.map(([stateId, state]) => field(collaborationLabel(state.label || stateId), `state:${stateId}`, instance.resolved_assignments?.[stateId] || '', { options: [['', '请选择 Active Principal'], ...activeMembers.map((member) => [member.principal_id, `${member.display_name} · ${collaborationShortId(member.principal_id)}`])], disabled: !stateDecisions[stateId]?.allowed, hint: stateDecisions[stateId]?.allowed ? '' : stateDecisions[stateId]?.reason })).join('')}</div>`,
      onSubmit: async (formData) => {
        const assignments = editableStates.map(([stateId]) => ({
          stateId,
          principalId: String(formData.get(`state:${stateId}`) || ''),
        }));
        if (assignments.some((assignment) => !assignment.principalId))
          throw new Error('请为每个可执行 State 选择 Active Principal');
        const changed = assignments.filter(
          (assignment) =>
            instance.resolved_assignments?.[assignment.stateId] !==
            assignment.principalId,
        );
        if (changed.length) {
          await options.request(
            `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/reassign`,
            {
              method: 'POST',
              body: JSON.stringify(
                buildCollaborationWorkflowReassignmentRequest({
                  expectedRevision: aggregateRevision(
                    group.projection,
                    'workflow_instance',
                    instance.instance_id,
                  ),
                  assignments: changed,
                }),
              ),
            },
          );
        }
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const selectedInstance = () =>
    selectedGroup().projection?.workflowInstances?.[state.selectedInstanceId];

  const cancelCurrentTurn = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const turn = collaborationCurrentTurn(
      group.projection,
      instance.instance_id,
    );
    if (
      !turn ||
      !collaborationWorkflowTurnActionAllowed(
        group,
        instance.instance_id,
        turn.turn_id,
        'cancel',
      )
    )
      throw new Error('当前身份不能取消此 Turn');
    openDialog({
      title: '取消当前 Turn',
      submitText: '确认取消',
      danger: true,
      body: field('取消原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/turns/${encodeURIComponent(turn.turn_id)}/cancel`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationTurnCancellationRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'workflow_instance',
                  instance.instance_id,
                ),
                attempt: turn.attempt,
                fencingToken: turn.fencing_token,
                reason: formData.get('reason'),
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const closeWorkflowInstance = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    openDialog({
      title: '关闭工作流实例',
      submitText: '确认关闭',
      danger: true,
      body: field('关闭原因', 'reason', '', { multiline: true }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/commands`,
          {
            method: 'POST',
            body: JSON.stringify({
              ...buildCollaborationReasonRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'workflow_instance',
                  instance.instance_id,
                ),
                reason: formData.get('reason'),
              }),
              command: 'close',
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const changeGroupLifecycle = (reopen) => {
    const group = selectedGroup();
    openDialog({
      title: reopen ? '恢复群组' : '归档群组',
      submitText: reopen ? '确认恢复' : '确认归档',
      danger: !reopen,
      body: field(reopen ? '恢复原因' : '归档原因', 'reason', '', {
        multiline: true,
      }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/${reopen ? 'reopen' : 'archive'}`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationReasonRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'group',
                  group.groupId,
                ),
                reason: formData.get('reason'),
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

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

  const recoverCurrentTurn = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const turn = collaborationCurrentTurn(
      group.projection,
      instance.instance_id,
    );
    if (!collaborationCanRecoverTurn(group, instance, turn))
      throw new Error('当前身份无权恢复该执行轮次');
    const assigneeOptions = collaborationActiveMemberOptions(group);
    if (!assigneeOptions.length)
      throw new Error('当前没有可接管执行轮次的 active 成员');
    const defaultAssignee = assigneeOptions.some(
      ([principalId]) => principalId === turn.assignee_principal_id,
    )
      ? turn.assignee_principal_id
      : assigneeOptions.some(
            ([principalId]) => principalId === group.localPrincipalId,
          )
        ? group.localPrincipalId
        : assigneeOptions[0][0];
    openDialog({
      title: '重新分配并恢复执行轮次',
      submitText: '确认重新分配',
      body: `<div class="collaboration-transfer-warning"><strong>创建新的执行尝试</strong><span>负责人、当前状态分配与 Turn 将原子更新；原执行结果不会被直接采用。</span></div><div class="collaboration-form-grid">${field('新的负责人', 'assigneePrincipalId', defaultAssignee, { options: assigneeOptions })}${field('恢复原因', 'reason', turn.recovery_reason || '', { multiline: true })}</div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/turns/${encodeURIComponent(turn.turn_id)}/recover`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationRecoverTurnRequest({
                expectedRevision: aggregateRevision(
                  group.projection,
                  'workflow_instance',
                  instance.instance_id,
                ),
                previousAttempt: turn.attempt,
                assigneePrincipalId: formData.get('assigneePrincipalId'),
                reason: formData.get('reason'),
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
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
      state.detail?.bindings || [],
    );
    if (!executors.length)
      throw new Error('没有匹配当前辅助执行轮次的本地执行器绑定');
    const localExecutorNames = Object.fromEntries(
      (state.detail?.localExecutors || []).map((executor) => [
        executor.executorId,
        executor.displayName,
      ]),
    );
    openDialog({
      title: `开始：${workflowStateLabel(definition, turn.state_id)}`,
      submitText: '开始执行',
      body: field('执行器', 'executorId', executors[0], {
        options: executors.map((executorId) => [
          executorId,
          localExecutorNames[executorId] || collaborationShortId(executorId),
        ]),
      }),
      onSubmit: async (formData) => {
        await startCurrentTurn(formData.get('executorId'));
        closeDialog();
      },
    });
  };

  const addExecutor = () => {
    const group = selectedGroup();
    openDialog({
      title: '添加 Executor',
      submitText: '注册',
      body: `<div class="collaboration-form-grid">${field('显示名称', 'displayName', 'Codex Desktop')}${field('平台', 'kind', 'codex', { options: [['codex', 'Codex Desktop']] })}${field('本地工作目录', 'workspacePath', '')}${field(
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
      })}${field('模型', 'model', '', { required: false })}</div>`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/executors`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationExecutorRegistrationRequest({
                ...Object.fromEntries(formData.entries()),
                expectedRevision: aggregateRevision(
                  group.projection,
                  'membership',
                  group.localPrincipalId,
                ),
              }),
            ),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const revokeExecutor = (executorId) => {
    const group = selectedGroup();
    const executor = (state.detail?.localExecutors || []).find(
      (entry) => entry.executorId === executorId,
    );
    openDialog({
      title: '撤销 Executor',
      submitText: '确认撤销',
      danger: true,
      body: `<div class="collaboration-transfer-warning"><strong>${html(executor?.displayName || collaborationShortId(executorId))}</strong><span>撤销后，使用此 Executor 的后续 Turn 将无法启动。</span></div>${field('原因', 'reason', '', { multiline: true })}`,
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/executors/${encodeURIComponent(executorId)}`,
          {
            method: 'DELETE',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'membership',
                group.localPrincipalId,
              ),
              reason: String(formData.get('reason') || ''),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const editAction = async (actionId = null) => {
    const group = selectedGroup();
    const detail = actionId
      ? await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workspace/me/actions/${encodeURIComponent(actionId)}`,
        )
      : null;
    const action = detail?.action || null;
    openDialog({
      title: action ? '修订 Action' : '创建 Action',
      submitText: action ? '发布修订' : '创建',
      body: `<div class="collaboration-form-grid">${field('名称', 'name', action?.name || '')}${field(
        '类型',
        'actionType',
        action ? collaborationActionType(action) : 'codex',
        {
          options: [
            ['codex', 'Codex'],
            ['run_once', 'Icarus Agent'],
          ],
        },
      )}${field('Prompt', 'prompt', detail?.prompt || '', { multiline: true })}${field(
        '执行权限',
        'filesystemAccess',
        action?.filesystem_access || 'read_only',
        {
          options: [
            ['read_only', '只读'],
            ['workspace_write', '工作区可写'],
          ],
        },
      )}${field('结果格式', 'resultFormat', 'collaboration_state_result', { options: [['collaboration_state_result', 'Workflow State 结果']] })}</div>`,
      onSubmit: async (formData) => {
        const endpoint = `/groups/${encodeURIComponent(group.groupId)}/workspace/me/actions${action ? `/${encodeURIComponent(action.action_id)}` : ''}`;
        await options.request(endpoint, {
          method: action ? 'PUT' : 'POST',
          body: JSON.stringify(
            buildCollaborationActionMutationRequest({
              ...Object.fromEntries(formData.entries()),
              expectedRevision: aggregateRevision(
                group.projection,
                'workspace',
                group.localPrincipalId,
              ),
            }),
          ),
        });
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const withdrawExecution = () => {
    const group = selectedGroup();
    const instance = selectedInstance();
    const stateId = instance.business_state;
    const access = collaborationWorkflowStateActionAccess(
      group,
      instance.instance_id,
      stateId,
      'withdrawExecution',
    );
    if (!access.allowed)
      throw new Error(access.reason || '当前身份不能清除执行配置');
    openDialog({
      title: '清除执行配置',
      submitText: '确认清除',
      danger: true,
      body: '<div class="collaboration-transfer-warning"><strong>恢复默认手动执行</strong><span>清除后，此 State 不再绑定 Action，后续 Turn 默认使用手动模式。</span></div>',
      onSubmit: async () => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/states/${encodeURIComponent(stateId)}/execution`,
          {
            method: 'DELETE',
            body: JSON.stringify({
              expectedRevision: aggregateRevision(
                group.projection,
                'workflow_instance',
                instance.instance_id,
              ),
            }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
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
    const current =
      group.projection?.stateExecutions?.[instance.instance_id]?.[stateId] ||
      null;
    const ownedActions = collaborationOwnedActions(group);
    const currentActionId = current?.action_ref
      ?.split('/')
      .at(-1)
      ?.replace(/\.json$/u, '');
    const currentBinding = (state.detail?.bindings || []).find(
      (binding) =>
        binding.instanceId === instance.instance_id &&
        binding.stateId === stateId &&
        binding.actionHash === current?.action_hash &&
        binding.promptHash === current?.prompt_hash,
    );
    const actionOptions = ownedActions.map((action) => [
      action.action_id,
      `${action.name} · v${String(action.version)} · ${collaborationLabel(collaborationActionType(action))}`,
    ]);
    openDialog({
      title: `执行配置 · ${stateId}`,
      body: `<div class="collaboration-form-grid">${field(
        '执行模式',
        'mode',
        current?.mode || 'manual',
        {
          options: [
            ['manual', '手动'],
            ['assisted', '辅助执行'],
            ['automatic', '自动执行'],
          ],
        },
      )}<div data-execution-resources>${field('Action', 'actionId', currentActionId || '', { required: false, options: [['', '请选择 Action'], ...actionOptions] })}<div data-executor-select></div></div></div>`,
      onOpen: () => {
        const form = elements.dialogForm;
        const resources = form.querySelector('[data-execution-resources]');
        const executorHost = form.querySelector('[data-executor-select]');
        const refresh = () => {
          const manual = form.elements.mode.value === 'manual';
          resources.classList.toggle('hidden', manual);
          const action = ownedActions.find(
            (entry) => entry.action_id === form.elements.actionId.value,
          );
          const executors = collaborationAvailableLocalExecutors(
            group,
            state.detail?.localExecutors || [],
            action,
          );
          executorHost.innerHTML = field(
            'Executor',
            'executorId',
            executors.some(
              (executor) => executor.executorId === currentBinding?.executorId,
            )
              ? currentBinding.executorId
              : executors[0]?.executorId || '',
            {
              required: false,
              options: [
                ['', '请选择本机 Executor'],
                ...executors.map((executor) => [
                  executor.executorId,
                  `${executor.displayName} · ${collaborationLabel(executor.executorKind)}`,
                ]),
              ],
            },
          );
        };
        form.elements.mode.addEventListener('change', refresh);
        form.elements.actionId.addEventListener('change', refresh);
        refresh();
      },
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/workflow-instances/${encodeURIComponent(instance.instance_id)}/states/${encodeURIComponent(stateId)}/execution`,
          {
            method: 'PUT',
            body: JSON.stringify(
              buildCollaborationStateExecutionRequest({
                ...Object.fromEntries(formData.entries()),
                expectedRevision: aggregateRevision(
                  group.projection,
                  'workflow_instance',
                  instance.instance_id,
                ),
              }),
            ),
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

  const initializeGroupDialog = () => {
    const group = selectedGroup();
    openDialog({
      title: '初始化群组',
      submitText: '确认初始化',
      danger: true,
      body: `<p class="collaboration-prose">${html(collaborationInitializeConfirmation)}</p>`,
      onSubmit: async () => {
        elements.dialogSubmit.textContent = '正在初始化...';
        try {
          const data = await options.request(
            `/groups/${encodeURIComponent(group.groupId)}/initialize`,
            { method: 'POST', body: '{}' },
          );
          closeDialog();
          await loadGroups();
          await selectGroup(data.group.groupId, { tab: 'settings' });
          options.showToast('群组已初始化');
        } catch (error) {
          elements.dialogSubmit.textContent = '确认初始化';
          throw error;
        }
      },
    });
  };

  const forgetLocalGroup = (groupId) => {
    state.groups = state.groups.filter((group) => group.groupId !== groupId);
    if (state.selectedGroupId === groupId) {
      clearAnalysisPoll();
      state.selectedGroupId = '';
      state.detail = null;
      state.tabData = {};
      state.activeTab = 'overview';
      updateRoute(true);
    }
    renderList();
    renderShell();
  };

  const openLifecycleConfirmation = (
    operation,
    targetGroup = selectedGroup(),
  ) => {
    if (!targetGroup) return;
    const configurations = {
      dissolve: {
        title: '解散群组',
        submitText: '永久解散',
        copy: '<strong>解散不可恢复。</strong><span>远端将记录正式解散事件并保留审计历史；同步成功后，本机群组数据会被移除。</span>',
      },
      leave: {
        title: '退出群组',
        submitText: '确认退出',
        copy: '<strong>退出会立即失效当前身份的 Client、Credential 与 Executor。</strong><span>再次加入时仍使用原 principal，并重新按当前加入策略审批。</span>',
      },
      'remove-local': {
        title: '从本机移除',
        submitText: '从本机移除',
        copy: '<strong>此操作只影响当前设备。</strong><span>不会退出或解散群组；本机 Credential、私钥、备份和身份恢复绑定会保留。</span>',
      },
    };
    const configuration = configurations[operation];
    if (!configuration) return;
    openDialog({
      title: configuration.title,
      submitText: configuration.submitText,
      danger: true,
      body: `<div class="collaboration-confirmation-copy">${configuration.copy}</div>${field('输入群组 ID 以确认', 'confirmation')}`,
      onSubmit: async (formData) => {
        const confirmation = String(formData.get('confirmation') || '').trim();
        const request = buildCollaborationLifecycleRequest({
          operation,
          group: targetGroup,
          confirmation,
        });
        const result = await options.request(request.endpoint, {
          method: request.method,
          body: JSON.stringify(request.body),
        });
        closeDialog();
        forgetLocalGroup(targetGroup.groupId);
        options.showToast(
          result.cleanupPending
            ? `群组已隐藏，本地清理将在重试后完成：${result.cleanupError || '清理失败'}`
            : operation === 'dissolve'
              ? '群组已解散'
              : operation === 'leave'
                ? '已退出群组'
                : '已从本机移除',
        );
      },
    });
  };

  const updateGitSshKey = (useDefault = false) => {
    const group = selectedGroup();
    const save = async (sshKeyPath) => {
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/settings/git-remote`,
        {
          method: 'PUT',
          body: JSON.stringify({ sshKeyPath }),
        },
      );
      if (elements.dialog.open) closeDialog();
      await loadDetail(group.groupId, false);
    };
    if (useDefault) return save(null);
    openDialog({
      title: 'Git Remote SSH Key',
      submitText: '更新本地设置',
      body: field(
        '本地 Key 路径',
        'sshKeyPath',
        group.gitRemoteAccess?.sshKeyPath || '',
      ),
      onSubmit: async (formData) =>
        save(String(formData.get('sshKeyPath') || '').trim() || null),
    });
  };

  const recoveryCredentialDialog = (operation) => {
    const group = selectedGroup();
    openDialog({
      title:
        operation === 'export'
          ? '导出离线 Group recovery Credential'
          : '导入离线 Group recovery Credential',
      submitText: operation === 'export' ? '安全导出' : '导入',
      body: field(
        operation === 'export' ? '导出路径' : 'Credential 路径',
        'path',
      ),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/recovery-credential/${operation}`,
          {
            method: 'POST',
            body: JSON.stringify({ path: formData.get('path') }),
          },
        );
        closeDialog();
        await loadDetail(group.groupId, false);
      },
    });
  };

  const navigateToResource = async (resourceType, resourceId) => {
    const navigation = collaborationResourceTarget(
      resourceType,
      resourceId,
      selectedGroup().projection,
    );
    state.activeTab = navigation.tab;
    state.selectedWorkItemId = navigation.selectedWorkItemId || '';
    state.selectedDiscussionId = navigation.selectedDiscussionId || '';
    state.selectedInstanceId = navigation.selectedInstanceId || '';
    state.selectedAnalysisId = navigation.selectedAnalysisId || '';
    state.selectedFileId = navigation.selectedFileId || '';
    if (navigation.tab === 'files') state.filePreview = null;
    updateRoute();
    renderShell();
    await loadTabData();
  };

  const clearAnalysisPoll = () => {
    if (analysisPollTimer) clearTimeout(analysisPollTimer);
    analysisPollTimer = null;
    analysisPollCount = 0;
  };

  const scheduleAnalysisPoll = () => {
    if (analysisPollTimer) clearTimeout(analysisPollTimer);
    analysisPollTimer = null;
    const statusValue = state.tabData.analysisDetail?.run?.status;
    if (
      state.activeTab !== 'analysis' ||
      !state.selectedAnalysisId ||
      !['running', 'validating'].includes(statusValue) ||
      analysisPollCount >= 240
    )
      return;
    analysisPollCount += 1;
    analysisPollTimer = setTimeout(async () => {
      analysisPollTimer = null;
      try {
        await refreshAnalysisDetail();
      } catch (error) {
        setBanner(error instanceof Error ? error.message : String(error));
      }
    }, 1_500);
  };

  const refreshAnalysisDetail = async () => {
    const group = selectedGroup();
    if (!group || !state.selectedAnalysisId) return;
    state.tabData.analysisDetail = await options.request(
      `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}`,
    );
    const overview = state.tabData.overview;
    if (overview) {
      const runData = await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/analysis-runs`,
      );
      overview.runs = runData.runs || [];
    }
    if (state.tabData.analysis) {
      const runData = await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/analysis-runs`,
      );
      state.tabData.analysis.runs = runData.runs || [];
    }
    renderContent();
    scheduleAnalysisPoll();
  };

  const openAnalysisCreator = async () => {
    const group = selectedGroup();
    const base = `/groups/${encodeURIComponent(group.groupId)}`;
    const [executorData, fileData, scopeOptionsData] = await Promise.all([
      options.request(`${base}/analysis-executors`),
      options.request(`${base}/files`),
      options.request(`${base}/analysis-scope-options`),
    ]);
    const executors = executorData.executors || [];
    const files = fileData.files || [];
    const workItems = Object.values(group.projection?.workItems || {});
    const instances = Object.values(group.projection?.workflowInstances || {});
    const deltaBaseSnapshots = scopeOptionsData.deltaBaseSnapshots || [];
    const deltaBaseOptions = deltaBaseSnapshots.map((entry) => [
      entry.snapshotHead,
      `${String(entry.snapshotHead).slice(0, 12)} · ${timestamp(entry.occurredAt)}`,
    ]);
    openDialog({
      title: '新建项目分析',
      submitText: '开始分析',
      wide: true,
      body: `<div class="collaboration-analysis-create"><fieldset><legend>分析范围</legend><div class="collaboration-radio-segments">${[
        ['project', '全项目'],
        ['mine', '与我相关'],
        ['work_item', 'Work Item'],
        ['workflow_instance', 'Workflow'],
        ['delta', '增量变化'],
      ]
        .map(
          ([value, label], index) =>
            `<label><input type="radio" name="scopeType" value="${value}" ${index === 0 ? 'checked' : ''}><span>${label}</span></label>`,
        )
        .join(
          '',
        )}</div><div data-analysis-scope="work_item" class="hidden">${field('Work Item', 'workItemId', workItems[0]?.work_item_id || '', { required: false, options: workItems.map((item) => [item.work_item_id, item.title]) })}</div><div data-analysis-scope="workflow_instance" class="hidden">${field('Workflow Instance', 'workflowInstanceId', instances[0]?.instance_id || '', { required: false, options: instances.map((instance) => [instance.instance_id, instance.definition_id]) })}</div><div data-analysis-scope="delta" class="hidden">${field('基准 verified head', 'sinceSnapshotHead', deltaBaseSnapshots[0]?.snapshotHead || '', { required: false, options: deltaBaseOptions })}<p class="collaboration-muted-note">${deltaBaseOptions.length ? `仅分析所选 verified snapshot 至当前 ${html(String(scopeOptionsData.currentSnapshotHead || '').slice(0, 12))} 的变化。` : '当前没有可用的历史 verified snapshot。'}</p></div></fieldset><fieldset><legend>执行渠道</legend><div class="collaboration-radio-segments">${[
        ['managed_executor', 'Icarus 托管'],
        ['external_agent', '外部 Agent'],
      ]
        .map(
          ([value, label], index) =>
            `<label><input type="radio" name="executionChannel" value="${value}" ${index === 0 ? 'checked' : ''}><span>${label}</span></label>`,
        )
        .join(
          '',
        )}</div><div data-analysis-channel="managed_executor">${field('Executor', 'executorId', executors[0]?.executorId || '', { required: false, options: executors.map((executor) => [executor.executorId, executor.displayName]) })}</div><div data-analysis-channel="external_agent" class="hidden"><div class="collaboration-transfer-warning"><strong>外部数据传输</strong><span>分析包不会自动上传。导出前请确认以下 verified 文件范围，敏感文本将由 Host 脱敏。</span></div><label class="collaboration-check-field"><input type="checkbox" name="includeSelectedFileContents"><span>在分析包中包含所选文件内容</span></label><div class="collaboration-analysis-file-list">${files.map((file) => `<label><input type="checkbox" name="selectedFileIds" value="${attr(file.fileId)}"><span>${html(file.virtualPath)}</span><small>${html(file.metadata?.media_type || '')}</small></label>`).join('') || empty('当前范围没有 verified 文件')}</div></div></fieldset></div>`,
      onOpen: () => {
        const update = () => {
          const form = elements.dialogForm;
          const scopeType = form.elements.scopeType?.value;
          const executionChannel = form.elements.executionChannel?.value;
          form
            .querySelectorAll('[data-analysis-scope]')
            .forEach((element) =>
              element.classList.toggle(
                'hidden',
                element.dataset.analysisScope !== scopeType,
              ),
            );
          const sinceSnapshotInput = form.elements.sinceSnapshotHead;
          if (sinceSnapshotInput)
            sinceSnapshotInput.required = scopeType === 'delta';
          form
            .querySelectorAll('[data-analysis-channel]')
            .forEach((element) =>
              element.classList.toggle(
                'hidden',
                element.dataset.analysisChannel !== executionChannel,
              ),
            );
        };
        elements.dialogForm
          .querySelectorAll('[name="scopeType"], [name="executionChannel"]')
          .forEach((control) => control.addEventListener('change', update));
        update();
      },
      onSubmit: async (formData) => {
        const scopeType = formData.get('scopeType');
        const executionChannel = formData.get('executionChannel');
        const request = buildCollaborationAnalysisRunRequest({
          scopeType,
          resourceId:
            scopeType === 'work_item'
              ? formData.get('workItemId')
              : formData.get('workflowInstanceId'),
          sinceSnapshotHead: formData.get('sinceSnapshotHead'),
          executionChannel,
          executorId:
            executionChannel === 'managed_executor'
              ? formData.get('executorId')
              : null,
          selectedFileIds: formData.getAll('selectedFileIds'),
          includeSelectedFileContents: Boolean(
            formData.get('includeSelectedFileContents'),
          ),
        });
        const created = await options.request(`${base}/analysis-runs`, {
          method: 'POST',
          body: JSON.stringify(request),
        });
        const started = await options.request(
          `${base}/analysis-runs/${encodeURIComponent(created.run.analysisId)}/start`,
          { method: 'POST', body: '{}' },
        );
        state.selectedAnalysisId = created.run.analysisId;
        state.tabData.analysisDetail = started;
        state.activeTab = 'analysis';
        state.tabData.analysis = { runs: [started] };
        analysisPollCount = 0;
        closeDialog();
        updateRoute();
        await loadTabData();
        scheduleAnalysisPoll();
        options.showToast(
          request.executionChannel === 'external_agent'
            ? '外部分析包已准备'
            : '托管分析已开始',
        );
      },
    });
  };

  const fetchExternalPackage = () => {
    const group = selectedGroup();
    return options.request(
      `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}/external-package`,
    );
  };

  const copyExternalPrompt = async () => {
    const group = selectedGroup();
    const response = await options.request(
      `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}/external-prompt`,
    );
    await navigator.clipboard.writeText(response.prompt);
    options.showToast('Prompt、Context、结果模板和 Schema 已复制');
  };

  const downloadExternalPackage = async () => {
    const group = selectedGroup();
    const analysisPackage = await fetchExternalPackage();
    const blob = new Blob([`${JSON.stringify(analysisPackage, null, 2)}\n`], {
      type: 'application/json',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${group.groupId}-${state.selectedAnalysisId}-analysis-package.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };

  const reviewExternalPackage = async () => {
    const analysisPackage = await fetchExternalPackage();
    openDialog({
      title: '复核外部分析包',
      submitText: '下载分析包',
      wide: true,
      body: `<div class="collaboration-transfer-warning"><strong>${html(analysisPackage.transfer_notice)}</strong><span>${analysisPackage.files.length} 个文件 · ${html(`${analysisPackage.total_bytes} bytes`)}</span></div><div class="collaboration-record-actions"><button id="collaboration-copy-analysis-prompt" type="button" class="btn-ghost">复制 Prompt</button></div><div class="collaboration-package-files">${analysisPackage.files.map((file) => `<article><div><strong>${html(file.path)}</strong><small>${html(file.media_type)} · ${html(`${file.bytes} bytes`)}</small></div>${file.redacted ? status('redacted') : status('verified')}</article>`).join('')}</div>`,
      onOpen: () => {
        document
          .getElementById('collaboration-copy-analysis-prompt')
          ?.addEventListener('click', () => {
            copyExternalPrompt().catch((error) => {
              elements.dialogError.textContent =
                error instanceof Error ? error.message : String(error);
              elements.dialogError.classList.remove('hidden');
            });
          });
      },
      onSubmit: async () => {
        closeDialog();
        await downloadExternalPackage();
      },
    });
  };

  const submitExternalResultDialog = () => {
    const group = selectedGroup();
    openDialog({
      title: '回填外部分析结果',
      submitText: '校验并回填',
      wide: true,
      body: `<div class="collaboration-form-grid">${field('JSON 结果', 'rawJson', '', { multiline: true, required: false })}${field('或选择 JSON 文件', 'resultFile', '', { type: 'file', required: false })}</div>`,
      onSubmit: async (formData) => {
        const file = elements.dialogForm.elements.resultFile?.files?.[0];
        const rawJson = file
          ? await file.text()
          : String(formData.get('rawJson') || '');
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}/external-result`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: buildCollaborationExternalResultRequest(rawJson),
          },
        );
        closeDialog();
        await refreshAnalysisDetail();
      },
    });
  };

  const decideFinding = (findingId, decision) => {
    const group = selectedGroup();
    openDialog({
      title: '记录 Finding 决定',
      submitText: '保存决定',
      body: field('说明（可选）', 'reason', '', {
        multiline: true,
        required: false,
      }),
      onSubmit: async (formData) => {
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}/findings/${encodeURIComponent(findingId)}/decision`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationFindingDecisionRequest({
                decision,
                reason: formData.get('reason'),
              }),
            ),
          },
        );
        closeDialog();
        await refreshAnalysisDetail();
      },
    });
  };

  const previewAnalysisAction = (
    findingId,
    actionOrdinal = null,
    requestedActionType = '',
  ) => {
    const group = selectedGroup();
    const entry = state.tabData.analysisDetail.findings.find(
      (candidate) => candidate.findingId === findingId,
    );
    if (!entry) throw new Error('Finding 不存在');
    const proposedAction = Number.isInteger(actionOrdinal)
      ? entry.finding?.proposed_actions?.[actionOrdinal]
      : null;
    if (Number.isInteger(actionOrdinal) && !proposedAction)
      throw new Error('Agent 建议动作不存在');
    const initialActionType = proposedAction?.action || requestedActionType;
    const selectedActionType = collaborationFindingActionTypes.includes(
      initialActionType,
    )
      ? initialActionType
      : collaborationFindingActionTypes[0];
    const actionDraft = (actionType) =>
      proposedAction?.action === actionType
        ? proposedAction
        : collaborationFindingActionDraft(entry, actionType);
    const requestId = `analysis_preview_${globalThis.crypto.randomUUID()}`;
    openDialog({
      title: proposedAction ? '编辑建议动作' : '选择 Finding 转化动作',
      submitText: '生成预览',
      wide: true,
      body: `<dl class="collaboration-definition-list"><div><dt>Finding</dt><dd>${html(entry.finding.title)}</dd></div><div><dt>来源</dt><dd>${proposedAction ? 'Agent 建议，可修改参数或切换类型' : '用户独立选择'}</dd></div></dl>${field('动作类型', 'actionType', selectedActionType, { options: collaborationFindingActionTypes.map((actionType) => [actionType, collaborationLabel(actionType)]) })}${field('动作参数 JSON', 'parametersJson', JSON.stringify(actionDraft(selectedActionType).parameters, null, 2), { multiline: true })}`,
      onOpen: () => {
        const actionTypeControl = elements.dialogForm.elements.actionType;
        const parametersControl = elements.dialogForm.elements.parametersJson;
        actionTypeControl?.addEventListener('change', () => {
          parametersControl.value = JSON.stringify(
            actionDraft(actionTypeControl.value).parameters,
            null,
            2,
          );
        });
      },
      onSubmit: async (formData) => {
        const actionType = String(formData.get('actionType') || '');
        if (!collaborationFindingActionTypes.includes(actionType))
          throw new Error('不支持的 Finding 转化动作');
        let parameters;
        try {
          parameters = JSON.parse(String(formData.get('parametersJson') || ''));
        } catch {
          throw new Error('动作参数必须是有效 JSON');
        }
        if (
          !parameters ||
          typeof parameters !== 'object' ||
          Array.isArray(parameters)
        )
          throw new Error('动作参数必须是 JSON 对象');
        const editedAction = { action: actionType, parameters };
        const linkedActionOrdinal =
          proposedAction?.action === actionType ? actionOrdinal : null;
        const response = await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}/actions/preview`,
          {
            method: 'POST',
            body: JSON.stringify(
              buildCollaborationActionPreviewRequest({
                actions: [
                  {
                    requestId,
                    findingId,
                    ...(Number.isInteger(linkedActionOrdinal)
                      ? { actionOrdinal: linkedActionOrdinal }
                      : {}),
                    action: editedAction,
                  },
                ],
              }),
            ),
          },
        );
        closeDialog();
        openDialog({
          title: '确认转化动作',
          submitText: '确认并写入群组',
          body: `<div class="collaboration-transfer-warning"><strong>即将写入群组</strong><span>Host 会在执行时重新检查权限、目标 revision 和 Git CAS。</span></div><dl class="collaboration-definition-list"><div><dt>动作</dt><dd>${html(collaborationLabel(editedAction.action))}</dd></div><div><dt>Finding</dt><dd>${html(entry.finding.title)}</dd></div></dl><pre class="collaboration-json-preview">${html(JSON.stringify({ parameters: editedAction.parameters, preview: response.previews.map((preview) => preview.application.preview) }, null, 2))}</pre>`,
          onSubmit: async () => {
            await options.request(
              `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}/actions/apply`,
              {
                method: 'POST',
                body: JSON.stringify(
                  buildCollaborationActionApplyRequest({
                    actions: response.previews.map((preview) => ({
                      applicationId: preview.application.applicationId,
                      confirmationToken: preview.confirmationToken,
                      action: preview.application.action,
                    })),
                  }),
                ),
              },
            );
            closeDialog();
            await loadDetail(group.groupId, false);
          },
        });
      },
    });
  };

  const answerWorkItemAssignment = async (item, accepted, reason = null) => {
    const group = selectedGroup();
    await options.request(
      `/groups/${encodeURIComponent(group.groupId)}/work-items/${encodeURIComponent(item.work_item_id)}/assignment/${accepted ? 'acknowledge' : 'decline'}`,
      {
        method: 'POST',
        body: JSON.stringify(
          buildCollaborationAssignmentDecisionRequest({
            expectedRevision: aggregateRevision(
              group.projection,
              'work_item',
              item.work_item_id,
            ),
            accepted,
            reason,
          }),
        ),
      },
    );
    await loadDetail(group.groupId, false);
  };

  const handleChange = (control) => {
    if (control.dataset.collaborationChange === 'notification-severity') {
      state.notificationSeverity = control.value;
      renderContent();
    } else if (
      control.dataset.collaborationChange === 'notification-resource'
    ) {
      state.notificationResourceType = control.value;
      renderContent();
    }
  };

  const handleAction = async (button) => {
    const action = button.dataset.collaborationAction;
    const group = selectedGroup();
    if (action === 'toggle-overview-filter') {
      if (button.dataset.filter === 'mine')
        state.overviewOnlyMine = !state.overviewOnlyMine;
      if (button.dataset.filter === 'risk')
        state.overviewRiskOnly = !state.overviewRiskOnly;
      return renderContent();
    }
    if (action === 'open-overview-resource')
      return navigateToResource(
        button.dataset.resourceType,
        button.dataset.resourceId,
      );
    if (action === 'open-notification') {
      if (button.dataset.notificationId)
        await options.request(
          `/groups/${encodeURIComponent(group.groupId)}/notifications/${encodeURIComponent(button.dataset.notificationId)}/read`,
          { method: 'POST', body: '{}' },
        );
      return navigateToResource(
        button.dataset.resourceType,
        button.dataset.resourceId,
      );
    }
    if (action === 'read-notification') {
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/notifications/${encodeURIComponent(button.dataset.notificationId)}/read`,
        { method: 'POST', body: '{}' },
      );
      return loadTabData();
    }
    if (action === 'handle-notification') {
      await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/notifications/${encodeURIComponent(button.dataset.notificationId)}/handled`,
        { method: 'POST', body: '{}' },
      );
      return loadTabData();
    }
    if (action === 'new-analysis') return openAnalysisCreator();
    if (action === 'open-analysis') {
      clearAnalysisPoll();
      state.activeTab = 'analysis';
      state.selectedAnalysisId = button.dataset.analysisId;
      updateRoute();
      renderShell();
      return loadTabData();
    }
    if (action === 'close-analysis') {
      state.selectedAnalysisId = '';
      state.tabData.analysisDetail = null;
      clearAnalysisPoll();
      return renderContent();
    }
    if (action === 'analysis-operation') {
      state.tabData.analysisDetail = await options.request(
        `/groups/${encodeURIComponent(group.groupId)}/analysis-runs/${encodeURIComponent(state.selectedAnalysisId)}/${encodeURIComponent(button.dataset.operation)}`,
        { method: 'POST', body: '{}' },
      );
      analysisPollCount = 0;
      return refreshAnalysisDetail();
    }
    if (action === 'review-analysis-package') return reviewExternalPackage();
    if (action === 'copy-repair-prompt') {
      await navigator.clipboard.writeText(
        state.tabData.analysisDetail?.repairPrompt || '',
      );
      return options.showToast('修复 Prompt 已复制');
    }
    if (action === 'submit-external-result')
      return submitExternalResultDialog();
    if (action === 'finding-decision')
      return decideFinding(button.dataset.findingId, button.dataset.decision);
    if (action === 'preview-analysis-action')
      return previewAnalysisAction(
        button.dataset.findingId,
        button.dataset.actionOrdinal === undefined
          ? null
          : Number(button.dataset.actionOrdinal),
        button.dataset.actionType || '',
      );
    if (action === 'acknowledge-assignment') {
      const item = group.projection.workItems[state.selectedWorkItemId];
      return answerWorkItemAssignment(item, true);
    }
    if (action === 'decline-assignment') {
      const item = group.projection.workItems[state.selectedWorkItemId];
      return openDialog({
        title: '拒绝工作项分配',
        submitText: '确认拒绝',
        danger: true,
        body: field('原因', 'reason', '', { multiline: true }),
        onSubmit: async (formData) => {
          await answerWorkItemAssignment(
            item,
            false,
            String(formData.get('reason') || '').trim(),
          );
          closeDialog();
        },
      });
    }
    if (action === 'go-activity') return selectTab('activity');
    if (action === 'request-join') return requestJoin();
    if (action === 'request-recovery') return requestRecovery();
    if (action === 'approve-recovery')
      return decideRecovery(button.dataset.requestId, 'approve');
    if (action === 'reject-recovery')
      return decideRecovery(button.dataset.requestId, 'reject');
    if (action === 'cancel-recovery')
      return cancelRecovery(button.dataset.requestId);
    if (action === 'rotate-credential') return rotateCredential();
    if (action === 'revoke-credential')
      return revokeCredential(button.dataset.credentialId);
    if (action === 'revoke-client')
      return revokeClient(button.dataset.clientId);
    if (action === 'edit-git-ssh-key') return updateGitSshKey(false);
    if (action === 'clear-git-ssh-key') return updateGitSshKey(true);
    if (action === 'export-recovery-credential')
      return recoveryCredentialDialog('export');
    if (action === 'import-recovery-credential')
      return recoveryCredentialDialog('import');
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
      return openPermissionEditor(button.dataset.principalId, true);
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
    if (action === 'edit-work-item') return editWorkItem();
    if (action === 'assign-work-item') return assignWorkItem();
    if (action === 'relate-work-item') return relateWorkItem();
    if (action === 'archive-work-item') return archiveWorkItem();
    if (action === 'set-work-status') {
      const item = group.projection.workItems[state.selectedWorkItemId];
      const access = collaborationWorkItemStatusActionAccess(
        group,
        item.work_item_id,
        button.dataset.status,
      );
      if (!access.allowed)
        throw new Error(access.reason || '当前状态转换不可用');
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
    if (action === 'resolve-discussion') return changeDiscussionStatus(true);
    if (action === 'reopen-discussion') return changeDiscussionStatus(false);
    if (action === 'revise-message')
      return reviseMessage(button.dataset.messageId);
    if (action === 'tombstone-message')
      return tombstoneMessage(button.dataset.messageId);
    if (action === 'upload-file') return uploadFile();
    if (action === 'open-file') {
      const path = button.dataset.repositoryPath;
      const indexed = (state.tabData.files || []).find(
        (file) => file.repositoryPath === path,
      );
      if (!indexed) {
        state.selectedFileId = '';
        state.filePreview = null;
        return renderContent();
      }
      await previewFile(indexed);
      return renderContent();
    }
    if (action === 'new-workflow') return openWorkflowEditor();
    if (action === 'new-executor') return addExecutor();
    if (action === 'revoke-executor')
      return revokeExecutor(button.dataset.executorId);
    if (action === 'new-action') return editAction();
    if (action === 'revise-action') return editAction(button.dataset.actionId);
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
    if (action === 'retire-workflow')
      return retireWorkflow(button.dataset.definitionKey);
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
    if (action === 'close-workflow-instance') return closeWorkflowInstance();
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
    if (action === 'recover-turn') return recoverCurrentTurn();
    if (action === 'complete-turn') return completeTurn();
    if (action === 'cancel-turn') return cancelCurrentTurn();
    if (action === 'configure-execution') return configureExecution();
    if (action === 'withdraw-execution') return withdrawExecution();
    if (action === 'reassign-instance') return reassignInstance();
    if (action === 'edit-permissions') {
      return openPermissionEditor(button.dataset.principalId, false);
    }
    if (action === 'edit-default-template') return editDefaultTemplate();
    if (action === 'backup' || action === 'restore')
      return backupDialog(action === 'restore');
    if (action === 'initialize-group') return initializeGroupDialog();
    if (action === 'archive-group') return changeGroupLifecycle(false);
    if (action === 'reopen-group') return changeGroupLifecycle(true);
    if (action === 'dissolve-group')
      return openLifecycleConfirmation('dissolve', group);
    if (action === 'leave-group')
      return openLifecycleConfirmation('leave', group);
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
    openNotificationComposer,
    openCreate,
    openObserve,
    handleAction,
    handleChange,
    closeDialog,
    restoreRoute,
    openNotification,
  };
}
