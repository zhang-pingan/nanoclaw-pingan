import {
  createParticipantDraft,
  createStateDraft,
} from './collaboration-definition.js';
import {
  COLLABORATION_OUTCOME_PRESETS,
  addCollaborationOutcomeFirst,
  autoLayoutCollaborationFsm,
  collaborationEdgeId,
  createCollaborationDraftHistory,
  nextCollaborationDraftId,
  removeCollaborationOutcome,
  removeCollaborationState,
  validateCollaborationFsmDraft,
} from './collaboration-fsm.js';
import { collaborationLabel } from './collaboration-labels.js';

const html = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
const attr = html;

export function calculateCollaborationFsmFitZoom(
  viewportWidth,
  viewportHeight,
  stageWidth,
  stageHeight,
) {
  if (!viewportWidth || !viewportHeight || !stageWidth || !stageHeight)
    return 1;
  return Math.max(
    0.45,
    Math.min(
      1,
      (viewportWidth - 28) / stageWidth,
      (viewportHeight - 28) / stageHeight,
    ),
  );
}

function stageBounds(draft) {
  const points = Object.values(draft.layout?.nodes || {});
  return {
    width: Math.max(880, ...points.map((point) => Number(point.x) + 300)),
    height: Math.max(520, ...points.map((point) => Number(point.y) + 190)),
  };
}

function participantOptions(draft, selected) {
  return (draft.participants || [])
    .map(
      (participant) =>
        `<option value="${attr(participant.id)}" ${participant.id === selected ? 'selected' : ''}>${html(participant.label)} · ${html(participant.id)}</option>`,
    )
    .join('');
}

function renderParticipants(draft, readonly) {
  return `<section class="collaboration-workflow-participants">
    <div class="collaboration-section-head"><h3>参与者角色</h3>${readonly ? '' : '<button type="button" class="btn-ghost" data-workflow-action="add-participant">添加</button>'}</div>
    <div class="collaboration-participant-list">${(draft.participants || [])
      .map(
        (
          participant,
        ) => `<div class="collaboration-participant-row" data-participant-id="${attr(participant.id)}">
          <label><span>ID</span><input data-participant-field="id" value="${attr(participant.id)}" ${readonly ? 'disabled' : ''}></label>
          <label><span>名称</span><input data-participant-field="label" value="${attr(participant.label)}" ${readonly ? 'disabled' : ''}></label>
          ${readonly ? '' : '<button type="button" class="collaboration-icon-button" data-workflow-action="remove-participant" title="移除参与者" aria-label="移除参与者">×</button>'}
        </div>`,
      )
      .join('')}</div>
  </section>`;
}

function edgeGeometry(source, target, self) {
  const startX = Number(source.x) + 220;
  const startY = Number(source.y) + 50;
  if (self)
    return `M ${startX - 20} ${startY - 30} C ${startX + 70} ${startY - 110}, ${startX + 105} ${startY + 90}, ${startX - 10} ${startY + 30}`;
  const endX = Number(target.x);
  const endY = Number(target.y) + 50;
  const bend = Math.max(80, Math.abs(endX - startX) * 0.45);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function renderCanvas(draft, selectedStateId, highlights, readonly) {
  const bounds = stageBounds(draft);
  const nodes = draft.layout?.nodes || {};
  const visitedStates = new Set(highlights?.visitedStateIds || []);
  const visitedEdges = new Set(highlights?.visitedEdgeIds || []);
  const edges = [];
  for (const state of draft.states)
    for (const transition of state.transitions || []) {
      const source = nodes[state.id] || { x: 0, y: 0 };
      const target = nodes[transition.targetState] || source;
      const id = collaborationEdgeId(state.id, transition.outcome);
      edges.push(`<g class="collaboration-workflow-edge ${visitedEdges.has(id) ? 'visited' : ''}">
        <path d="${edgeGeometry(source, target, state.id === transition.targetState)}" marker-end="url(#collaboration-arrow)"></path>
        <text x="${(Number(source.x) + Number(target.x)) / 2 + 110}" y="${(Number(source.y) + Number(target.y)) / 2 + 42}">${html(transition.label || collaborationLabel(transition.outcome))}</text>
      </g>`);
    }
  return `<div class="collaboration-workflow-canvas" data-workflow-canvas tabindex="0">
    <div class="collaboration-workflow-stage" style="width:${bounds.width}px;height:${bounds.height}px">
      <svg class="collaboration-workflow-edges" viewBox="0 0 ${bounds.width} ${bounds.height}" aria-hidden="true"><defs><marker id="collaboration-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"></path></marker></defs>${edges.join('')}</svg>
      ${draft.states
        .map((state) => {
          const point = nodes[state.id] || { x: 0, y: 0 };
          const selected = state.id === selectedStateId;
          const current = state.id === highlights?.currentStateId;
          const assignee = state.terminal
            ? '终止状态'
            : `${state.assigneeType === 'principal' ? '成员' : '参与者'} · ${state.assigneeId}`;
          return `<button type="button" class="collaboration-workflow-node ${selected ? 'selected' : ''} ${current ? 'current' : ''} ${visitedStates.has(state.id) ? 'visited' : ''} ${state.terminal ? 'terminal' : ''}" style="left:${Number(point.x)}px;top:${Number(point.y)}px" data-state-id="${attr(state.id)}" ${readonly ? '' : 'data-draggable-state="true"'}>
            <span>${html(state.id === draft.initialState ? '初始状态' : state.terminal ? '终止状态' : '状态')}</span>
            <strong>${html(state.label)}</strong>
            <small>${html(assignee)}</small>
          </button>`;
        })
        .join('')}
    </div>
  </div>`;
}

function renderInspector(draft, selectedStateId, readonly) {
  const state = draft.states.find(
    (candidate) => candidate.id === selectedStateId,
  );
  if (!state)
    return '<aside class="collaboration-workflow-inspector"><div class="collaboration-section-empty">请选择一个状态</div></aside>';
  const disabled = readonly ? 'disabled' : '';
  return `<aside class="collaboration-workflow-inspector" data-inspector-state="${attr(state.id)}">
    <div class="collaboration-section-head"><h3>状态</h3>${readonly || draft.states.length < 2 ? '' : '<button type="button" class="btn-danger-soft" data-workflow-action="remove-state">删除</button>'}</div>
    <label class="collaboration-field"><span>ID</span><input data-state-field="id" value="${attr(state.id)}" ${disabled}></label>
    <label class="collaboration-field"><span>名称</span><input data-state-field="label" value="${attr(state.label)}" ${disabled}></label>
    <label class="collaboration-field"><span>描述</span><textarea data-state-field="description" ${disabled}>${html(state.description)}</textarea></label>
    <label class="collaboration-toggle"><input type="checkbox" data-state-field="terminal" ${state.terminal ? 'checked' : ''} ${disabled}><span>终止状态</span></label>
    ${
      state.terminal
        ? ''
        : `<label class="collaboration-field"><span>负责人类型</span><select data-state-field="assigneeType" ${disabled}><option value="participant_slot" ${state.assigneeType === 'participant_slot' ? 'selected' : ''}>参与者角色</option><option value="principal" ${state.assigneeType === 'principal' ? 'selected' : ''}>指定成员</option></select></label>
          <label class="collaboration-field"><span>负责人</span>${
            state.assigneeType === 'participant_slot'
              ? `<select data-state-field="assigneeId" ${disabled}>${participantOptions(draft, state.assigneeId)}</select>`
              : `<input data-state-field="assigneeId" value="${attr(state.assigneeId)}" ${disabled}>`
          }</label>
          <div class="collaboration-timeout-grid">
            <label class="collaboration-field"><span>开始超时（ms）</span><input type="number" min="1" data-state-field="startTimeoutMs" value="${attr(state.startTimeoutMs)}" ${disabled}></label>
            <label class="collaboration-field"><span>执行超时（ms）</span><input type="number" min="1" data-state-field="executionTimeoutMs" value="${attr(state.executionTimeoutMs)}" ${disabled}></label>
            <label class="collaboration-field"><span>提醒间隔（ms）</span><input type="number" min="1" data-state-field="reminderIntervalMs" value="${attr(state.reminderIntervalMs)}" ${disabled}></label>
          </div>
          <div class="collaboration-section-head"><h3>执行结果</h3>${readonly ? '' : '<button type="button" class="btn-ghost" data-workflow-action="add-outcome">添加</button>'}</div>
          <div class="collaboration-outcome-list">${(state.transitions || [])
            .map(
              (transition) =>
                `<div class="collaboration-outcome-row" data-outcome-id="${attr(transition.outcome)}"><div><strong>${html(transition.outcome)}</strong><span>${html(transition.label)} → ${html(transition.targetState)}</span></div>${readonly ? '' : '<button type="button" class="collaboration-icon-button" data-workflow-action="remove-outcome" title="移除执行结果" aria-label="移除执行结果">×</button>'}</div>`,
            )
            .join('')}</div>`
    }
  </aside>`;
}

function outcomeDialog(draft, source) {
  const preset = COLLABORATION_OUTCOME_PRESETS[0];
  const outcome = window.prompt('执行结果 ID', preset.id);
  if (!outcome) return null;
  const label = window.prompt('执行结果名称', preset.label) || preset.label;
  const destinationInput = window.prompt(
    '目标类型：已有状态、当前状态、新建状态、终止状态',
    '新建状态',
  );
  const destination =
    {
      已有状态: 'existing',
      当前状态: 'self',
      新建状态: 'new',
      终止状态: 'terminal',
    }[destinationInput] || destinationInput;
  if (!['existing', 'self', 'new', 'terminal'].includes(destination))
    return null;
  const input = { sourceStateId: source.id, outcome, label, destination };
  if (destination === 'existing')
    input.targetStateId = window.prompt(
      `目标状态（${draft.states.map((state) => state.id).join('、')}）`,
      draft.states[0]?.id,
    );
  if (destination === 'new' || destination === 'terminal') {
    input.newStateId = window.prompt(
      '新状态 ID',
      nextCollaborationDraftId(
        destination === 'terminal' ? 'terminal' : 'state',
        draft.states,
      ),
    );
    input.newStateLabel =
      window.prompt('新状态名称', input.newStateId) || input.newStateId;
    input.newStateAssigneeType = 'participant_slot';
    input.newStateAssigneeId = source.assigneeId || draft.participants[0]?.id;
  }
  return input;
}

export function mountCollaborationFsmEditor(host, options) {
  if (!host) throw new Error('缺少工作流编辑器容器');
  const readonly = Boolean(options.readonly);
  const layoutOnly = !readonly && Boolean(options.layoutOnly);
  const structureReadonly = readonly || layoutOnly;
  const history = createCollaborationDraftHistory(options.draft);
  let draft = history.current();
  let selectedStateId = options.selectedStateId || draft.initialState;
  let dragging = null;

  const notify = () => options.onChange?.(structuredClone(draft));
  const commit = (next, selection = selectedStateId) => {
    draft = history.commit(next);
    selectedStateId = selection;
    notify();
    render();
  };
  const render = () => {
    const issues = validateCollaborationFsmDraft(draft);
    host.innerHTML = `<div class="collaboration-workflow-editor ${readonly ? 'readonly' : layoutOnly ? 'layout-only' : ''}">
      <header class="collaboration-workflow-toolbar">
        <div class="collaboration-segmented"><button type="button" data-workflow-view="participants" class="${draft.layout.view === 'participants' ? 'active' : ''}" ${readonly ? 'disabled' : ''}>按参与者</button><button type="button" data-workflow-view="free" class="${draft.layout.view === 'free' ? 'active' : ''}" ${readonly ? 'disabled' : ''}>自由布局</button></div>
        <div class="collaboration-toolbar-actions">${readonly ? '' : `<button type="button" class="collaboration-icon-button" data-workflow-action="undo" title="撤销" aria-label="撤销">↶</button><button type="button" class="collaboration-icon-button" data-workflow-action="redo" title="重做" aria-label="重做">↷</button><button type="button" class="btn-ghost" data-workflow-action="layout">自动布局</button>${layoutOnly ? '' : '<button type="button" class="btn-ghost" data-workflow-action="add-state">添加状态</button>'}`}</div>
      </header>
      ${renderParticipants(draft, structureReadonly)}
      <div class="collaboration-workflow-body">${renderCanvas(draft, selectedStateId, options.runtimeHighlights, readonly)}${renderInspector(draft, selectedStateId, structureReadonly)}</div>
      <footer class="collaboration-workflow-issues">${issues.length ? issues.map((entry) => `<span class="${entry.severity}">${html(entry.message)}</span>`).join('') : '<span class="ok">工作流配置有效</span>'}</footer>
    </div>`;
  };

  host.addEventListener('click', (event) => {
    const node = event.target.closest('[data-state-id]');
    if (node) {
      selectedStateId = node.dataset.stateId;
      render();
      return;
    }
    if (readonly) return;
    const view = event.target.closest('[data-workflow-view]');
    if (view) {
      commit(autoLayoutCollaborationFsm(draft, view.dataset.workflowView));
      return;
    }
    const action = event.target.closest('[data-workflow-action]')?.dataset
      .workflowAction;
    if (!action) return;
    if (layoutOnly && !['undo', 'redo', 'layout'].includes(action)) return;
    if (action === 'undo' || action === 'redo') {
      draft = action === 'undo' ? history.undo() : history.redo();
      selectedStateId = draft.states.some(
        (state) => state.id === selectedStateId,
      )
        ? selectedStateId
        : draft.initialState;
      notify();
      render();
    } else if (action === 'layout')
      commit(autoLayoutCollaborationFsm(draft, draft.layout.view));
    else if (action === 'add-participant') {
      const next = structuredClone(draft);
      next.participants.push(
        createParticipantDraft(next.participants.length + 1),
      );
      commit(next);
    } else if (action === 'remove-participant') {
      const id = event.target.closest('[data-participant-id]')?.dataset
        .participantId;
      if (
        draft.states.some(
          (state) =>
            state.assigneeType === 'participant_slot' &&
            state.assigneeId === id,
        )
      )
        return;
      const next = structuredClone(draft);
      next.participants = next.participants.filter(
        (participant) => participant.id !== id,
      );
      commit(next);
    } else if (action === 'add-state') {
      const next = structuredClone(draft);
      const id = nextCollaborationDraftId('state', next.states);
      next.states.push(
        createStateDraft(next.states.length + 1, {
          id,
          assigneeId: next.participants[0]?.id || 'participant_1',
        }),
      );
      next.layout.nodes[id] = { x: 100, y: 100 + next.states.length * 130 };
      commit(next, id);
    } else if (action === 'remove-state') {
      const removed = removeCollaborationState(draft, selectedStateId);
      commit(removed.draft, removed.draft.initialState);
    } else if (action === 'add-outcome') {
      const source = draft.states.find((state) => state.id === selectedStateId);
      const input = source ? outcomeDialog(draft, source) : null;
      if (input) {
        const added = addCollaborationOutcomeFirst(draft, input);
        commit(added.draft, added.selectedStateId);
      }
    } else if (action === 'remove-outcome') {
      const outcome =
        event.target.closest('[data-outcome-id]')?.dataset.outcomeId;
      commit(removeCollaborationOutcome(draft, selectedStateId, outcome));
    }
  });

  host.addEventListener('change', (event) => {
    if (structureReadonly) return;
    const participantField = event.target.dataset.participantField;
    if (participantField) {
      const row = event.target.closest('[data-participant-id]');
      const oldId = row.dataset.participantId;
      const next = structuredClone(draft);
      const participant = next.participants.find((item) => item.id === oldId);
      if (!participant) return;
      participant[participantField] = event.target.value;
      if (participantField === 'id')
        for (const state of next.states)
          if (
            state.assigneeType === 'participant_slot' &&
            state.assigneeId === oldId
          )
            state.assigneeId = event.target.value;
      commit(next);
      return;
    }
    const field = event.target.dataset.stateField;
    if (!field) return;
    const next = structuredClone(draft);
    const state = next.states.find(
      (candidate) => candidate.id === selectedStateId,
    );
    if (!state) return;
    const value =
      event.target.type === 'checkbox'
        ? event.target.checked
        : event.target.value;
    if (field === 'id') {
      const oldId = state.id;
      state.id = value;
      if (next.initialState === oldId) next.initialState = value;
      next.layout.nodes[value] = next.layout.nodes[oldId];
      delete next.layout.nodes[oldId];
      for (const candidate of next.states)
        for (const transition of candidate.transitions)
          if (transition.targetState === oldId) transition.targetState = value;
      selectedStateId = value;
    } else if (field === 'terminal') {
      state.terminal = value;
      if (value) {
        state.assigneeType = '';
        state.assigneeId = '';
        state.transitions = [];
        state.startTimeoutMs = '';
        state.executionTimeoutMs = '';
        state.reminderIntervalMs = '';
      } else {
        state.assigneeType = 'participant_slot';
        state.assigneeId = next.participants[0]?.id || '';
      }
    } else state[field] = value;
    commit(next);
  });

  host.addEventListener('pointerdown', (event) => {
    if (readonly) return;
    const node = event.target.closest('[data-draggable-state]');
    if (!node) return;
    selectedStateId = node.dataset.stateId;
    dragging = {
      id: node.dataset.stateId,
      x: event.clientX,
      y: event.clientY,
      origin: structuredClone(draft.layout.nodes[node.dataset.stateId]),
    };
    node.setPointerCapture(event.pointerId);
  });
  host.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    draft.layout.nodes[dragging.id] = {
      x: dragging.origin.x + event.clientX - dragging.x,
      y: dragging.origin.y + event.clientY - dragging.y,
    };
    const node = host.querySelector(
      `[data-state-id="${CSS.escape(dragging.id)}"]`,
    );
    if (node) {
      node.style.left = `${draft.layout.nodes[dragging.id].x}px`;
      node.style.top = `${draft.layout.nodes[dragging.id].y}px`;
    }
  });
  host.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = null;
    history.commit(draft);
    notify();
    render();
  });

  render();
  return {
    getDraft: () => structuredClone(draft),
    destroy: () => {
      host.innerHTML = '';
    },
  };
}
