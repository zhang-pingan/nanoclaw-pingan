import {
  COLLABORATION_OUTCOME_PRESETS,
  addCollaborationOutcomeFirst,
  autoLayoutCollaborationFsm,
  collaborationEdgeId,
  collaborationRoleLaneStride,
  createCollaborationDraftHistory,
  nextCollaborationDraftId,
  removeCollaborationState,
  renameCollaborationState,
  validateCollaborationFsmDraft,
} from './collaboration-fsm.js';
import { createRoleDraft } from './collaboration-definition.js';

export function calculateCollaborationFsmFitZoom(
  canvasWidth,
  canvasHeight,
  stageWidth,
  stageHeight,
) {
  const horizontal = (canvasWidth - 28) / Math.max(1, stageWidth);
  const vertical = (canvasHeight - 28) / Math.max(1, stageHeight);
  return Math.min(1, Math.max(0.45, Math.min(horizontal, vertical)));
}

function html(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function attr(value) {
  return html(value);
}

function icon(name) {
  const paths = {
    undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6"/>',
    redo: '<path d="m15 7 5 5-5 5"/><path d="M20 12h-9a6 6 0 0 0-6 6"/>',
    arrange:
      '<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/><path d="M10 7h4a3 3 0 0 1 3 3v4"/>',
    fit: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    locate:
      '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  };
  return `<svg class="collaboration-fsm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function iconButton(action, name, label, disabled = false) {
  return `<button type="button" class="collaboration-fsm-icon-button" data-fsm-action="${attr(action)}" title="${attr(label)}" aria-label="${attr(label)}" ${disabled ? 'disabled' : ''}>${icon(name)}</button>`;
}

function stateOptions(draft, value) {
  return draft.states
    .map(
      (state) =>
        `<option value="${attr(state.id)}" ${state.id === value ? 'selected' : ''}>${html(state.label)} · ${html(state.id)}</option>`,
    )
    .join('');
}

function roleOptions(draft, value) {
  return draft.roles
    .map(
      (role) =>
        `<option value="${attr(role.id)}" ${role.id === value ? 'selected' : ''}>${html(role.displayName)} · ${html(role.id)}</option>`,
    )
    .join('');
}

function field(label, fieldName, value, options = {}) {
  const disabled = options.disabled ? 'disabled' : '';
  const input = options.multiline
    ? `<textarea data-fsm-state-field="${attr(fieldName)}" rows="3" ${disabled}>${html(value)}</textarea>`
    : `<input data-fsm-state-field="${attr(fieldName)}" type="${attr(options.type || 'text')}" value="${attr(value)}" ${options.type === 'number' ? 'min="1" step="1"' : ''} ${disabled}>`;
  return `<label class="collaboration-fsm-field"><span>${html(label)}</span>${input}</label>`;
}

function renderRoles(draft, readonly, initialRoleEditable) {
  if (readonly) return '';
  return `<details class="collaboration-fsm-roles" aria-label="角色定义">
    <summary><strong>Roles</strong><span>${draft.roles.length} 个角色 · 创建者 ${html(draft.initialRole)}</span></summary>
    <div class="collaboration-fsm-roles-body">
      <div class="collaboration-fsm-roles-head"><span></span><button type="button" class="btn-ghost" data-fsm-action="add-role">${icon('plus')}<span>添加角色</span></button></div>
      <div class="collaboration-fsm-role-list">
      ${draft.roles
        .map(
          (
            role,
          ) => `<div class="collaboration-fsm-role-row" data-fsm-role-id="${attr(role.id)}">
            <label><span>Role ID</span><input data-fsm-role-field="id" data-original-value="${attr(role.id)}" value="${attr(role.id)}"></label>
            <label><span>显示名称</span><input data-fsm-role-field="displayName" value="${attr(role.displayName)}"></label>
            <label><span>人数</span><span class="collaboration-fsm-cardinality"><input data-fsm-role-field="minMembers" type="number" min="1" value="${attr(role.minMembers)}"><i>至</i><input data-fsm-role-field="maxMembers" type="number" min="1" value="${attr(role.maxMembers)}"></span></label>
            <label><span>Capabilities</span><input data-fsm-role-field="capabilities" value="${attr(role.capabilities || '')}"></label>
            ${iconButton('remove-role', 'trash', `删除角色 ${role.id}`)}
          </div>`,
        )
        .join('')}
      </div>
      ${initialRoleEditable ? `<label class="collaboration-fsm-initial-role"><span>创建者初始角色</span><select data-fsm-initial-role>${roleOptions(draft, draft.initialRole)}</select></label>` : ''}
    </div>
  </details>`;
}

function renderComposer(draft, state) {
  return `<div class="collaboration-fsm-outcome-composer">
    <div class="collaboration-fsm-composer-presets" aria-label="常用执行结果">
      ${COLLABORATION_OUTCOME_PRESETS.map((preset) => `<button type="button" data-fsm-preset="${attr(preset.id)}" data-fsm-preset-label="${attr(preset.label)}">${html(preset.id)}</button>`).join('')}
    </div>
    <div class="collaboration-fsm-composer-grid">
      <label><span>稳定 ID</span><input data-fsm-new-outcome value="succeeded"></label>
      <label><span>显示名称</span><input data-fsm-new-outcome-label value="Succeeded"></label>
    </div>
    <fieldset class="collaboration-fsm-destination">
      <legend>去向</legend>
      <label><input type="radio" name="fsm-destination-${attr(state.id)}" value="new" checked>新建下一节点</label>
      <label><input type="radio" name="fsm-destination-${attr(state.id)}" value="existing">连接已有节点</label>
      <label><input type="radio" name="fsm-destination-${attr(state.id)}" value="self">返回当前节点</label>
      <label><input type="radio" name="fsm-destination-${attr(state.id)}" value="terminal">进入终止节点</label>
    </fieldset>
    <label class="collaboration-fsm-existing-target hidden"><span>目标 State</span><select data-fsm-new-target>${stateOptions(draft, draft.initialState)}</select></label>
    <div class="collaboration-fsm-composer-actions">
      <button type="button" class="btn-ghost" data-fsm-action="cancel-outcome">取消</button>
      <button type="button" class="btn-primary btn-soft-primary" data-fsm-action="confirm-outcome">添加执行结果</button>
    </div>
  </div>`;
}

function renderInspector(draft, selectedStateId, readonly, composerOpen) {
  const state = draft.states.find(
    (candidate) => candidate.id === selectedStateId,
  );
  if (!state)
    return `<aside class="collaboration-fsm-inspector"><div class="collaboration-fsm-inspector-empty">选择节点查看属性</div></aside>`;
  const disabled = readonly || state.terminal;
  return `<aside class="collaboration-fsm-inspector" aria-label="State 属性">
    <div class="collaboration-fsm-inspector-head">
      <div><span>State</span><strong>${html(state.label)}</strong></div>
      ${!readonly ? iconButton('remove-state', 'trash', `删除 State ${state.id}`) : ''}
    </div>
    <div class="collaboration-fsm-inspector-scroll">
      ${field('显示名称', 'label', state.label, { disabled: readonly })}
      ${field('稳定 ID', 'id', state.id, { disabled: readonly })}
      ${field('描述', 'description', state.description || '', { multiline: true, disabled: readonly })}
      <label class="collaboration-fsm-field"><span>责任角色</span><select data-fsm-state-field="ownerRole" ${disabled ? 'disabled' : ''}>${state.terminal ? '<option value="" selected>不适用</option>' : roleOptions(draft, state.ownerRole)}</select></label>
      <div class="collaboration-fsm-switch-row">
        <label><input data-fsm-state-field="terminal" type="checkbox" ${state.terminal ? 'checked' : ''} ${readonly ? 'disabled' : ''}><span>Terminal State</span></label>
        ${state.id === draft.initialState ? '<span class="collaboration-fsm-initial-chip">Initial</span>' : !readonly ? '<button type="button" data-fsm-action="set-initial">设为 Initial</button>' : ''}
      </div>
      <div class="collaboration-fsm-timeouts">
        ${field('Start timeout (ms)', 'startTimeoutMs', state.startTimeoutMs ?? '', { type: 'number', disabled })}
        ${field('Execution timeout (ms)', 'executionTimeoutMs', state.executionTimeoutMs ?? '', { type: 'number', disabled })}
        ${field('Reminder interval (ms)', 'reminderIntervalMs', state.reminderIntervalMs ?? '', { type: 'number', disabled })}
      </div>
      <section class="collaboration-fsm-outcomes">
        <div class="collaboration-fsm-outcomes-head"><strong>执行结果</strong>${!readonly && !state.terminal ? `<button type="button" class="btn-ghost" data-fsm-action="add-outcome">${icon('plus')}<span>添加执行结果</span></button>` : ''}</div>
        <div class="collaboration-fsm-outcome-list">
          ${
            (state.transitions || [])
              .map(
                (
                  transition,
                ) => `<div class="collaboration-fsm-outcome-row" data-fsm-outcome="${attr(transition.outcome)}">
                <div class="collaboration-fsm-outcome-title"><strong>${html(transition.label || transition.outcome)}</strong><code>${html(transition.outcome)}</code>${!readonly ? iconButton('remove-outcome', 'trash', `删除执行结果 ${transition.outcome}`) : ''}</div>
                <label><span>显示名称</span><input data-fsm-outcome-field="label" value="${attr(transition.label || transition.outcome)}" ${readonly ? 'disabled' : ''}></label>
                <label><span>稳定 ID</span><input data-fsm-outcome-field="outcome" data-original-value="${attr(transition.outcome)}" value="${attr(transition.outcome)}" ${readonly ? 'disabled' : ''}></label>
                <label><span>目标 State</span><select data-fsm-outcome-field="targetState" data-original-value="${attr(transition.targetState)}" ${readonly ? 'disabled' : ''}>${stateOptions(draft, transition.targetState)}</select></label>
              </div>`,
              )
              .join('') ||
            '<div class="collaboration-fsm-no-outcomes">尚未添加执行结果</div>'
          }
        </div>
        ${composerOpen && !readonly && !state.terminal ? renderComposer(draft, state) : ''}
      </section>
    </div>
  </aside>`;
}

function edgeGeometry(source, target, self, ordinal) {
  if (self) {
    const x = source.x + 96;
    const y = source.y;
    return {
      path: `M ${x + 28} ${y + 8} C ${x + 100} ${y - 74}, ${x - 100} ${y - 74}, ${x - 28} ${y + 8}`,
      labelX: x,
      labelY: y - 54,
    };
  }
  const startX = source.x + 192;
  const startY = source.y + 47;
  const endX = target.x;
  const endY = target.y + 47;
  const bend = Math.max(70, Math.abs(endX - startX) * 0.48);
  const offset = ordinal * 15;
  return {
    path: `M ${startX} ${startY + offset} C ${startX + bend} ${startY + offset}, ${endX - bend} ${endY + offset}, ${endX} ${endY + offset}`,
    labelX: (startX + endX) / 2,
    labelY: (startY + endY) / 2 + offset - 10,
  };
}

function renderStage(draft, selectedStateId, issues, options) {
  const positions = draft.layout?.nodes || {};
  const issueStates = new Set(
    issues
      .filter((entry) => entry.severity === 'error')
      .map((entry) => entry.stateId),
  );
  const issueEdges = new Set(
    issues
      .filter((entry) => entry.severity === 'error')
      .map((entry) => entry.edgeId),
  );
  const visitedNodes = new Set(options.highlights?.visitedNodeIds || []);
  const visitedEdges = new Set(options.highlights?.visitedEdgeIds || []);
  const edgePairs = new Map();
  const edges = [];
  for (const state of draft.states) {
    const source = positions[state.id] || { x: 80, y: 100 };
    for (const transition of state.transitions || []) {
      const target = positions[transition.targetState] || source;
      const pair = `${state.id}->${transition.targetState}`;
      const ordinal = edgePairs.get(pair) || 0;
      edgePairs.set(pair, ordinal + 1);
      edges.push({
        state,
        transition,
        ...edgeGeometry(
          source,
          target,
          state.id === transition.targetState,
          ordinal,
        ),
      });
    }
  }
  const maxX = Math.max(
    880,
    ...Object.values(positions).map((position) => position.x + 300),
  );
  const maxY = Math.max(
    520,
    ...Object.values(positions).map((position) => position.y + 190),
  );
  const lanes =
    draft.layout?.view === 'roles'
      ? [
          ...draft.roles.map((role) => ({
            id: role.id,
            label: role.displayName,
          })),
          ...(draft.states.some((state) => state.terminal)
            ? [{ id: '__terminal__', label: 'Terminal' }]
            : []),
        ]
      : [];
  const laneStride = collaborationRoleLaneStride(draft);
  return `<div class="collaboration-fsm-stage" style="width:${maxX}px;height:${maxY}px" data-fsm-stage>
    ${lanes.map((lane, index) => `<div class="collaboration-fsm-lane" style="top:${48 + index * laneStride}px;height:${laneStride - 14}px"><span>${html(lane.label)}</span></div>`).join('')}
    <svg class="collaboration-fsm-edges" viewBox="0 0 ${maxX} ${maxY}" width="${maxX}" height="${maxY}" aria-hidden="true">
      <defs><marker id="collaboration-fsm-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs>
      ${edges
        .map(({ state, transition, path, labelX, labelY }) => {
          const edgeId = collaborationEdgeId(state.id, transition.outcome);
          return `<g class="collaboration-fsm-edge ${issueEdges.has(edgeId) ? 'invalid' : ''} ${visitedEdges.has(edgeId) ? 'visited' : ''}" data-fsm-edge="${attr(edgeId)}"><path d="${path}" marker-end="url(#collaboration-fsm-arrow)"></path><foreignObject x="${labelX - 70}" y="${labelY - 13}" width="140" height="28"><div class="collaboration-fsm-edge-label">${html(transition.label || transition.outcome)}</div></foreignObject></g>`;
        })
        .join('')}
    </svg>
    ${draft.states
      .map((state) => {
        const position = positions[state.id] || { x: 80, y: 100 };
        const current = options.highlights?.currentStateId === state.id;
        const timedOut = options.highlights?.timeoutStateId === state.id;
        return `<button type="button" class="collaboration-fsm-node ${state.id === selectedStateId ? 'selected' : ''} ${state.terminal ? 'terminal' : ''} ${state.id === draft.initialState ? 'initial' : ''} ${issueStates.has(state.id) ? 'invalid' : ''} ${visitedNodes.has(state.id) ? 'visited' : ''} ${current ? 'current' : ''} ${timedOut ? 'timed-out' : ''}" data-fsm-node="${attr(state.id)}" style="transform:translate(${position.x}px,${position.y}px)" aria-label="${attr(state.label)}">
        <span class="collaboration-fsm-node-flags">${state.id === draft.initialState ? '<i>INITIAL</i>' : ''}${state.terminal ? '<i>TERMINAL</i>' : ''}${current ? '<i>CURRENT</i>' : ''}</span>
        <strong>${html(state.label)}</strong><code>${html(state.id)}</code>
        <span class="collaboration-fsm-node-owner">${state.terminal ? '流程结束' : html(state.ownerRole || '未指定角色')}</span>
      </button>`;
      })
      .join('')}
  </div>`;
}

function renderValidation(issues) {
  if (!issues.length)
    return '<div class="collaboration-fsm-validation success"><strong>校验通过</strong><span>Machine 可以发布</span></div>';
  const errors = issues.filter((entry) => entry.severity === 'error').length;
  const warnings = issues.length - errors;
  return `<div class="collaboration-fsm-validation ${errors ? 'danger' : 'warning'}"><div><strong>${errors ? `${errors} 个错误` : '可以发布'}</strong><span>${warnings ? `${warnings} 个警告` : '请修复后发布'}</span></div><div class="collaboration-fsm-issue-list">${issues.map((entry, index) => `<button type="button" data-fsm-issue-index="${index}" class="${entry.severity}"><span>${entry.severity === 'error' ? '错误' : '警告'}</span>${html(entry.message)}</button>`).join('')}</div></div>`;
}

export function mountCollaborationFsmEditor(root, initialDraft, options = {}) {
  root.__collaborationFsmDestroy?.();
  const abortController = new AbortController();
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    abortController.abort();
    detachObserver.disconnect();
  });
  detachObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  const readonly = options.readonly === true;
  const compact = options.compact === true;
  const history = createCollaborationDraftHistory(initialDraft);
  let draft = history.current();
  let selectedStateId =
    options.selectedStateId || draft.initialState || draft.states[0]?.id || '';
  let composerOpen = false;
  let zoom = compact ? 0.82 : 1;
  let drag = null;
  let suppressClick = false;

  const confirmAction = async (message) =>
    options.confirm ? options.confirm(message) : window.confirm(message);

  function commit(next, selected = selectedStateId) {
    draft = history.commit(next);
    selectedStateId = selected;
    options.onChange?.(structuredClone(draft));
    render();
  }

  function render() {
    const issues = validateCollaborationFsmDraft(draft);
    root.innerHTML = `<div class="collaboration-fsm-editor ${readonly ? 'readonly' : ''} ${compact ? 'compact' : ''}">
      ${renderRoles(draft, readonly, options.initialRoleEditable !== false)}
      <div class="collaboration-fsm-toolbar">
        <div class="collaboration-fsm-segmented" aria-label="布局视图"><button type="button" data-fsm-view="free" class="${draft.layout?.view !== 'roles' ? 'active' : ''}">自由布局</button><button type="button" data-fsm-view="roles" class="${draft.layout?.view === 'roles' ? 'active' : ''}">角色泳道</button></div>
        <div class="collaboration-fsm-tools">
          ${!readonly ? `${iconButton('undo', 'undo', '撤销', !history.canUndo())}${iconButton('redo', 'redo', '重做', !history.canRedo())}${iconButton('arrange', 'arrange', '自动整理')}` : ''}
          ${iconButton('zoom-out', 'minus', '缩小')}${iconButton('zoom-in', 'plus', '放大')}${iconButton('fit', 'fit', '适配画布')}${iconButton('locate', 'locate', '定位选中节点')}
        </div>
      </div>
      <div class="collaboration-fsm-workspace">
        <div class="collaboration-fsm-canvas" data-fsm-canvas tabindex="0"><div class="collaboration-fsm-zoom" style="transform:scale(${zoom})">${renderStage(draft, selectedStateId, issues, options)}</div></div>
        ${renderInspector(draft, selectedStateId, readonly, composerOpen)}
      </div>
      ${renderValidation(issues)}
    </div>`;
  }

  function refreshValidation() {
    const current = root.querySelector('.collaboration-fsm-validation');
    if (current)
      current.outerHTML = renderValidation(
        validateCollaborationFsmDraft(draft),
      );
  }

  function locateSelected() {
    root
      .querySelector(`[data-fsm-node="${CSS.escape(selectedStateId)}"]`)
      ?.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'smooth',
      });
  }

  root.addEventListener('click', async (event) => {
    const node = event.target.closest('[data-fsm-node]');
    if (node && !suppressClick) {
      selectedStateId = node.dataset.fsmNode;
      composerOpen = false;
      render();
      return;
    }
    suppressClick = false;
    const preset = event.target.closest('[data-fsm-preset]');
    if (preset) {
      root.querySelector('[data-fsm-new-outcome]').value =
        preset.dataset.fsmPreset;
      root.querySelector('[data-fsm-new-outcome-label]').value =
        preset.dataset.fsmPresetLabel;
      return;
    }
    const issueButton = event.target.closest('[data-fsm-issue-index]');
    if (issueButton) {
      const issue =
        validateCollaborationFsmDraft(draft)[
          Number(issueButton.dataset.fsmIssueIndex)
        ];
      if (issue?.stateId) selectedStateId = issue.stateId;
      render();
      locateSelected();
      return;
    }
    const viewButton = event.target.closest('[data-fsm-view]');
    if (viewButton) {
      if (readonly) {
        draft = autoLayoutCollaborationFsm(draft, viewButton.dataset.fsmView);
        render();
      } else
        commit(autoLayoutCollaborationFsm(draft, viewButton.dataset.fsmView));
      return;
    }
    const button = event.target.closest('[data-fsm-action]');
    if (!button) return;
    const action = button.dataset.fsmAction;
    if (action === 'zoom-in' || action === 'zoom-out') {
      zoom = Math.min(
        1.5,
        Math.max(0.45, zoom + (action === 'zoom-in' ? 0.1 : -0.1)),
      );
      render();
    } else if (action === 'fit') {
      const canvas = root.querySelector('[data-fsm-canvas]');
      const stage = root.querySelector('[data-fsm-stage]');
      zoom = calculateCollaborationFsmFitZoom(
        canvas.clientWidth,
        canvas.clientHeight,
        stage.offsetWidth,
        stage.offsetHeight,
      );
      render();
    } else if (action === 'locate') locateSelected();
    else if (action === 'undo' && !readonly) {
      draft = history.undo();
      composerOpen = false;
      render();
    } else if (action === 'redo' && !readonly) {
      draft = history.redo();
      composerOpen = false;
      render();
    } else if (action === 'arrange' && !readonly)
      commit(autoLayoutCollaborationFsm(draft, draft.layout?.view || 'free'));
    else if (action === 'add-outcome' && !readonly) {
      composerOpen = true;
      render();
    } else if (action === 'cancel-outcome') {
      composerOpen = false;
      render();
    } else if (action === 'confirm-outcome' && !readonly) {
      const destination =
        root.querySelector('input[name^="fsm-destination-"]:checked')?.value ||
        'new';
      try {
        const added = addCollaborationOutcomeFirst(draft, {
          sourceStateId: selectedStateId,
          outcome: root.querySelector('[data-fsm-new-outcome]').value,
          label: root.querySelector('[data-fsm-new-outcome-label]').value,
          destination,
          targetStateId: root.querySelector('[data-fsm-new-target]')?.value,
        });
        composerOpen = false;
        commit(added.draft, added.selectedStateId);
        locateSelected();
      } catch (error) {
        options.onError?.(
          error instanceof Error ? error.message : String(error),
        );
      }
    } else if (action === 'set-initial' && !readonly) {
      const next = structuredClone(draft);
      next.initialState = selectedStateId;
      commit(next);
    } else if (action === 'remove-outcome' && !readonly) {
      const row = button.closest('[data-fsm-outcome]');
      const outcome = row?.dataset.fsmOutcome;
      if (
        !(await confirmAction(
          `删除执行结果 ${outcome}？将移除从 ${selectedStateId} 发出的连线。`,
        ))
      )
        return;
      const next = structuredClone(draft);
      const state = next.states.find(
        (candidate) => candidate.id === selectedStateId,
      );
      state.transitions = state.transitions.filter(
        (transition) => transition.outcome !== outcome,
      );
      commit(next);
    } else if (action === 'remove-state' && !readonly) {
      const preview = removeCollaborationState(draft, selectedStateId);
      const edges = preview.affectedEdges
        .map(
          (edge) =>
            `${edge.sourceStateId}.${edge.outcome} → ${edge.targetStateId}`,
        )
        .join('\n');
      const orphaned = preview.orphanedStateIds.length
        ? `\n删除后孤立：${preview.orphanedStateIds.join(', ')}`
        : '';
      if (
        !(await confirmAction(
          `删除 State ${selectedStateId}？\n受影响连线：\n${edges || '无'}${orphaned}`,
        ))
      )
        return;
      commit(preview.draft, preview.draft.initialState);
    } else if (action === 'add-role' && !readonly) {
      const next = structuredClone(draft);
      const role = createRoleDraft(next.roles.length + 1);
      role.id = nextCollaborationDraftId('role', next.roles);
      next.roles.push(role);
      commit(next);
    } else if (action === 'remove-role' && !readonly) {
      const row = button.closest('[data-fsm-role-id]');
      const roleId = row?.dataset.fsmRoleId;
      const owned = draft.states
        .filter((state) => state.ownerRole === roleId)
        .map((state) => state.id);
      if (
        !(await confirmAction(
          `删除角色 ${roleId}？${owned.length ? `\n以下 State 将失去责任角色：${owned.join(', ')}` : ''}`,
        ))
      )
        return;
      const next = structuredClone(draft);
      next.roles = next.roles.filter((role) => role.id !== roleId);
      for (const state of next.states)
        if (state.ownerRole === roleId) state.ownerRole = '';
      if (next.initialRole === roleId)
        next.initialRole = next.roles[0]?.id || '';
      commit(next);
    }
  });

  root.addEventListener('input', (event) => {
    if (readonly) return;
    const roleField = event.target.closest('[data-fsm-role-field]');
    if (roleField && roleField.dataset.fsmRoleField !== 'id') {
      const roleId = roleField.closest('[data-fsm-role-id]').dataset.fsmRoleId;
      const role = draft.roles.find((candidate) => candidate.id === roleId);
      if (role) role[roleField.dataset.fsmRoleField] = roleField.value;
      refreshValidation();
      return;
    }
    const stateField = event.target.closest('[data-fsm-state-field]');
    if (
      stateField &&
      !['id', 'terminal', 'ownerRole'].includes(
        stateField.dataset.fsmStateField,
      )
    ) {
      const state = draft.states.find(
        (candidate) => candidate.id === selectedStateId,
      );
      if (state) state[stateField.dataset.fsmStateField] = stateField.value;
      if (stateField.dataset.fsmStateField === 'label') {
        const nodeLabel = root.querySelector(
          `[data-fsm-node="${CSS.escape(selectedStateId)}"] strong`,
        );
        const inspectorLabel = root.querySelector(
          '.collaboration-fsm-inspector-head strong',
        );
        if (nodeLabel) nodeLabel.textContent = stateField.value;
        if (inspectorLabel) inspectorLabel.textContent = stateField.value;
      }
      refreshValidation();
      return;
    }
    const outcomeField = event.target.closest('[data-fsm-outcome-field]');
    if (
      outcomeField &&
      !['outcome', 'targetState'].includes(outcomeField.dataset.fsmOutcomeField)
    ) {
      const outcomeId =
        outcomeField.closest('[data-fsm-outcome]').dataset.fsmOutcome;
      const state = draft.states.find(
        (candidate) => candidate.id === selectedStateId,
      );
      const transition = state?.transitions.find(
        (candidate) => candidate.outcome === outcomeId,
      );
      if (transition)
        transition[outcomeField.dataset.fsmOutcomeField] = outcomeField.value;
      refreshValidation();
    }
  });

  root.addEventListener('focusout', (event) => {
    if (readonly) return;
    const roleField = event.target.closest('[data-fsm-role-field="id"]');
    if (roleField) {
      const roleId = roleField.closest('[data-fsm-role-id]').dataset.fsmRoleId;
      const nextId = roleField.value.trim();
      if (!nextId) {
        options.onError?.('角色 ID 不能为空');
        render();
        return;
      }
      if (
        draft.roles.some(
          (candidate) => candidate.id === nextId && candidate.id !== roleId,
        )
      ) {
        options.onError?.(`角色 ID 重复：${nextId}`);
        render();
        return;
      }
      if (nextId && nextId !== roleId) {
        const next = structuredClone(draft);
        const role = next.roles.find((candidate) => candidate.id === roleId);
        role.id = nextId;
        if (next.initialRole === roleId) next.initialRole = nextId;
        for (const state of next.states)
          if (state.ownerRole === roleId) state.ownerRole = nextId;
        commit(next);
      }
      return;
    }
    const stateField = event.target.closest('[data-fsm-state-field="id"]');
    if (stateField) {
      const nextId = stateField.value.trim();
      if (!nextId) {
        options.onError?.('State ID 不能为空');
        render();
        return;
      }
      if (nextId && nextId !== selectedStateId)
        try {
          commit(
            renameCollaborationState(draft, selectedStateId, nextId),
            nextId,
          );
        } catch (error) {
          options.onError?.(
            error instanceof Error ? error.message : String(error),
          );
          render();
        }
      return;
    }
    const outcomeField = event.target.closest(
      '[data-fsm-outcome-field="outcome"]',
    );
    if (outcomeField) {
      const row = outcomeField.closest('[data-fsm-outcome]');
      const from = row.dataset.fsmOutcome;
      const to = outcomeField.value.trim();
      if (!to) {
        options.onError?.('执行结果 ID 不能为空');
        render();
        return;
      }
      const selectedState = draft.states.find(
        (candidate) => candidate.id === selectedStateId,
      );
      if (
        selectedState?.transitions.some(
          (candidate) => candidate.outcome === to && candidate.outcome !== from,
        )
      ) {
        options.onError?.(`执行结果 ID 重复：${to}`);
        render();
        return;
      }
      if (to && to !== from) {
        const next = structuredClone(draft);
        const state = next.states.find(
          (candidate) => candidate.id === selectedStateId,
        );
        const transition = state.transitions.find(
          (candidate) => candidate.outcome === from,
        );
        transition.outcome = to;
        commit(next);
      }
    }
  });

  root.addEventListener('change', async (event) => {
    const destination = event.target.closest('input[name^="fsm-destination-"]');
    if (destination) {
      root
        .querySelector('.collaboration-fsm-existing-target')
        ?.classList.toggle('hidden', destination.value !== 'existing');
      return;
    }
    if (readonly) return;
    const initialRole = event.target.closest('[data-fsm-initial-role]');
    if (initialRole) {
      const next = structuredClone(draft);
      next.initialRole = initialRole.value;
      commit(next);
      return;
    }
    const roleField = event.target.closest('[data-fsm-role-field]');
    if (roleField) {
      const roleId = roleField.closest('[data-fsm-role-id]').dataset.fsmRoleId;
      const next = structuredClone(draft);
      const role = next.roles.find((candidate) => candidate.id === roleId);
      const fieldName = roleField.dataset.fsmRoleField;
      if (fieldName === 'id') return;
      role[fieldName] = roleField.value;
      commit(next);
      return;
    }
    const stateField = event.target.closest('[data-fsm-state-field]');
    if (stateField) {
      const fieldName = stateField.dataset.fsmStateField;
      if (fieldName === 'id') return;
      const next = structuredClone(draft);
      const state = next.states.find(
        (candidate) => candidate.id === selectedStateId,
      );
      if (fieldName === 'terminal') {
        if (state.transitions.length) {
          const affected = state.transitions
            .map(
              (transition) =>
                `${transition.outcome} → ${transition.targetState}`,
            )
            .join('\n');
          if (
            !(await confirmAction(
              `设为 Terminal 将删除以下出边，并清除责任角色和超时：\n${affected}`,
            ))
          ) {
            render();
            return;
          }
        }
        state.terminal = stateField.checked;
        if (state.terminal) {
          state.ownerRole = '';
          state.startTimeoutMs = '';
          state.executionTimeoutMs = '';
          state.reminderIntervalMs = '';
          state.transitions = [];
        } else state.ownerRole = next.roles[0]?.id || '';
      } else state[fieldName] = stateField.value;
      commit(next);
      return;
    }
    const outcomeField = event.target.closest('[data-fsm-outcome-field]');
    if (outcomeField) {
      const row = outcomeField.closest('[data-fsm-outcome]');
      const outcomeId = row.dataset.fsmOutcome;
      const next = structuredClone(draft);
      const state = next.states.find(
        (candidate) => candidate.id === selectedStateId,
      );
      const transition = state.transitions.find(
        (candidate) => candidate.outcome === outcomeId,
      );
      const fieldName = outcomeField.dataset.fsmOutcomeField;
      if (fieldName === 'outcome') return;
      if (
        fieldName === 'targetState' &&
        transition.targetState !== outcomeField.value
      ) {
        if (
          !(await confirmAction(
            `把 ${transition.outcome} 的目标从 ${transition.targetState} 改为 ${outcomeField.value}？`,
          ))
        ) {
          render();
          return;
        }
      }
      transition[fieldName] = outcomeField.value;
      commit(next);
    }
  });

  root.addEventListener('pointerdown', (event) => {
    if (readonly) return;
    const node = event.target.closest('[data-fsm-node]');
    if (!node || event.button !== 0) return;
    const stateId = node.dataset.fsmNode;
    const position = draft.layout?.nodes?.[stateId] || { x: 0, y: 0 };
    drag = {
      stateId,
      startX: event.clientX,
      startY: event.clientY,
      x: position.x,
      y: position.y,
      moved: false,
    };
  });
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!drag) return;
      const dx = (event.clientX - drag.startX) / zoom;
      const dy = (event.clientY - drag.startY) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      draft.layout.nodes[drag.stateId] = {
        x: Math.round(drag.x + dx),
        y: Math.round(drag.y + dy),
      };
      render();
    },
    { signal: abortController.signal },
  );
  window.addEventListener(
    'pointerup',
    () => {
      if (!drag) return;
      if (drag.moved) {
        suppressClick = true;
        commit(draft, drag.stateId);
      }
      drag = null;
    },
    { signal: abortController.signal },
  );
  root.addEventListener('keydown', (event) => {
    if (
      readonly ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== 'z'
    )
      return;
    event.preventDefault();
    draft = event.shiftKey ? history.redo() : history.undo();
    render();
  });

  render();
  const controller = {
    getDraft: () => structuredClone(draft),
    validate: () => validateCollaborationFsmDraft(draft),
    focusState(stateId) {
      if (draft.states.some((state) => state.id === stateId))
        selectedStateId = stateId;
      render();
      locateSelected();
    },
    destroy() {
      abortController.abort();
      detachObserver.disconnect();
    },
  };
  root.__collaborationFsmDestroy = controller.destroy;
  return controller;
}
