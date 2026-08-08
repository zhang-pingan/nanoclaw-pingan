import {
  renderInteractionCard,
  replanInteraction,
} from '../interactions/index.js';
import {
  compactId,
  escapeAttribute,
  escapeHtml,
  formatTime,
  isRecord,
  readableLabel,
  renderArtifact,
  workspaceDisplayLabel,
} from '../rendering.js';
import {
  currentRun,
  currentWorkflow,
  workflowIdentity,
  workflowRuns,
  type TaskWorkspaceState,
} from '../state.js';

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function fact(label: string, value: unknown, title = ''): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd${title ? ` title="${escapeAttribute(title)}"` : ''}>${escapeHtml(value ?? '--')}</dd></div>`;
}

function empty(text: string): string {
  return `<div class="tw-empty tw-empty-compact">${escapeHtml(text)}</div>`;
}

function recordIdentity(
  record: Record<string, unknown>,
  fallback: string,
): string {
  return String(
    record.artifact_link_id ??
      record.artifact_ref ??
      record.id ??
      record.ref ??
      fallback,
  );
}

function artifactGraphRunId(artifact: Record<string, unknown>): string {
  const payload = isRecord(artifact.artifact) ? artifact.artifact : artifact;
  const display = isRecord(payload.display_json)
    ? payload.display_json
    : isRecord(payload.display)
      ? payload.display
      : null;
  return String(payload.graph_run_id ?? display?.graph_run_id ?? '');
}

export function renderOverview(state: TaskWorkspaceState): string {
  const workflow = currentWorkflow(state);
  const run = currentRun(state);
  if (!workflow) return empty('尚未关联 Workflow。');
  const available = workflow.availability !== 'unavailable';
  const hints =
    available && Array.isArray(workflow.command_hints)
      ? workflow.command_hints
          .map((hint) =>
            typeof hint === 'string'
              ? hint
              : isRecord(hint)
                ? String(hint.action ?? '')
                : '',
          )
          .filter((hint) => ['pause', 'resume', 'cancel'].includes(hint))
      : [];
  const pending = records(workflow.pending);
  const temporary =
    state.activeSession?.current_run_selection.kind === 'temporary_workflow';
  const replanAvailable =
    available &&
    temporary &&
    run?.id === workflow.current_graph_run_id &&
    run?.lifecycle !== 'closed' &&
    state.runtimeDetail?.freshness !== 'degraded';
  return `
    <section class="tw-inspector-section">
      <div class="tw-freshness ${state.runtimeDetail?.freshness === 'degraded' ? 'is-degraded' : ''}">
        ${!available ? '历史 Runtime 详情不可用，此 Workflow 仅可查看。' : state.runtimeDetail?.freshness === 'degraded' ? 'Runtime 快照已降级，依赖最新状态的操作已禁用。' : 'Runtime 快照为最新状态。'}
      </div>
      <dl class="tw-facts">
        ${fact('Workflow', compactId(workflowIdentity(workflow)), workflowIdentity(workflow))}
        ${fact('状态', workspaceDisplayLabel(workflow.status ?? '--'))}
        ${fact('运行状态', workspaceDisplayLabel(workflow.operational_state ?? '--'))}
        ${fact('Run', compactId(run?.id), String(run?.id ?? ''))}
        ${fact('Run 生命周期', workspaceDisplayLabel(run?.lifecycle ?? '--'))}
        ${fact('控制状态', workspaceDisplayLabel(run?.control ?? '--'))}
        ${fact('截止时间', formatTime(workflow.deadline_at_ms))}
        ${fact('待处理', pending.length)}
        ${fact('结果', workspaceDisplayLabel(workflow.final_outcome_kind ?? '--'))}
        ${fact('最近错误', workflow.final_error_code ?? run?.error_code)}
      </dl>
      ${hints.length || replanAvailable ? `<div class="tw-command-bar" aria-label="Runtime 命令">${hints.map((hint) => `<button type="button" class="tw-btn ${hint === 'cancel' ? 'tw-btn-danger' : 'tw-btn-quiet'}" data-tw-action="runtime-command" data-command="${escapeAttribute(hint)}"${state.runtimeDetail?.freshness === 'degraded' ? ' disabled' : ''}>${escapeHtml(workspaceDisplayLabel(hint))}</button>`).join('')}${replanAvailable ? '<button type="button" class="tw-btn tw-btn-quiet" data-tw-action="begin-replan">Replan</button>' : ''}</div>` : ''}
    </section>`;
}

export function renderDag(state: TaskWorkspaceState): string {
  const workflow = currentWorkflow(state);
  const run = currentRun(state);
  if (!workflow || !run) return empty('尚未关联已物化的 DAG。');
  const runId = String(run.id ?? '');
  const allScopes = records(workflow.scopes).filter(
    (scope) => scope.graph_run_id === runId,
  );
  const allNodes = records(workflow.nodes).filter(
    (node) => node.graph_run_id === runId,
  );
  const temporary =
    state.activeSession?.current_run_selection.kind === 'temporary_workflow';
  const childScopes = allScopes.filter((scope) =>
    ['expansion', 'dynamic_child'].includes(String(scope.scope_kind)),
  );
  const visibleScopeIds = new Set(
    (temporary && childScopes.length ? childScopes : allScopes).map((scope) =>
      String(scope.id),
    ),
  );
  const nodes =
    temporary && childScopes.length
      ? allNodes.filter((node) => visibleScopeIds.has(String(node.scope_id)))
      : allNodes;
  const edges = records(workflow.edges).filter(
    (edge) => edge.graph_run_id === runId,
  );
  const attempts = records(workflow.attempts).filter(
    (attempt) => attempt.graph_run_id === runId,
  );
  const completionCuts = records(workflow.completion_cuts).filter(
    (cut) => cut.graph_run_id === runId,
  );
  const nodeKeys = new Map(
    allNodes.map((node) => [String(node.id), String(node.node_key ?? node.id)]),
  );
  return `
    <section class="tw-inspector-section">
      ${temporary && childScopes.length ? '<div class="tw-context-note">当前显示 Dynamic Child DAG，已隐藏固定的 Runtime 包装层。</div>' : ''}
      <div class="tw-dag-summary"><span>${nodes.length} 个节点</span><span>${edges.length} 条边</span><span>${attempts.length} 次 Attempt</span><span>${completionCuts.length} 个 Completion Cut</span><span>${allScopes.length} 个 Scope</span></div>
      <div class="tw-dag-list">
        ${
          nodes.length
            ? nodes
                .map(
                  (node) => `
                  <div class="tw-dag-node">
                    <span class="tw-node-state is-${escapeAttribute(String(node.phase ?? 'unknown'))}"></span>
                    <div><strong>${escapeHtml(node.node_key ?? compactId(node.id))}</strong><span>${escapeHtml(readableLabel(node.node_type ?? 'node'))}</span></div>
                    <div class="tw-dag-node-state"><span>${escapeHtml(workspaceDisplayLabel(node.phase ?? '--'))}</span><small>${escapeHtml(workspaceDisplayLabel(node.terminal_status ?? node.trigger_state ?? ''))}</small></div>
                  </div>`,
                )
                .join('')
            : empty('当前 Run 尚无已物化节点。')
        }
      </div>
      ${edges.length ? `<details class="tw-disclosure"><summary>边</summary><div class="tw-edge-list">${edges.map((edge) => `<div title="${escapeAttribute(String(edge.edge_kind ?? edge.resolution_state ?? ''))}"><span>${escapeHtml(edge.from_node_key ?? nodeKeys.get(String(edge.from_node_id)) ?? compactId(edge.from_node_id))}</span><span aria-hidden="true">-&gt;</span><span>${escapeHtml(edge.to_node_key ?? nodeKeys.get(String(edge.to_node_id)) ?? compactId(edge.to_node_id))}</span></div>`).join('')}</div></details>` : ''}
      ${attempts.length ? `<details class="tw-disclosure"><summary>Attempt</summary><dl class="tw-facts">${attempts.map((attempt) => fact(`${nodeKeys.get(String(attempt.node_id)) ?? compactId(attempt.node_id)} / #${attempt.attempt_no ?? '?'}`, workspaceDisplayLabel(attempt.execution_outcome ?? attempt.quality_decision ?? attempt.phase ?? '--'), String(attempt.query_id ?? attempt.id ?? ''))).join('')}</dl></details>` : ''}
      ${completionCuts.length ? `<details class="tw-disclosure"><summary>Completion Cut</summary><dl class="tw-facts">${completionCuts.map((cut) => fact(String(cut.exit_name ?? compactId(cut.scope_id) ?? '完成'), workspaceDisplayLabel(cut.outcome_kind ?? '--'), String(cut.cut_hash ?? cut.id ?? ''))).join('')}</dl></details>` : ''}
    </section>`;
}

export function renderArtifacts(state: TaskWorkspaceState): string {
  const workflow = currentWorkflow(state);
  const run = currentRun(state);
  const workflowId = workflowIdentity(workflow);
  const runId = String(run?.id ?? '');
  const linked = records(state.runtimeDetail?.artifact_links).filter(
    (artifact) =>
      (!artifact.workflow_id || artifact.workflow_id === workflowId) &&
      (!artifactGraphRunId(artifact) || artifactGraphRunId(artifact) === runId),
  );
  const runtime = records(workflow?.artifacts).filter(
    (artifact) =>
      !artifactGraphRunId(artifact) || artifactGraphRunId(artifact) === runId,
  );
  const timeline = state.timeline
    .filter(
      (entry) =>
        entry.kind === 'artifact_published' ||
        String(entry.payload_json.event_type ?? '')
          .toLocaleLowerCase()
          .includes('artifact'),
    )
    .map((entry) => entry.payload_json)
    .filter(
      (artifact) =>
        !artifactGraphRunId(artifact) || artifactGraphRunId(artifact) === runId,
    );
  const artifacts = new Map<string, Record<string, unknown>>();
  [...runtime, ...linked, ...timeline].forEach((artifact, index) => {
    artifacts.set(recordIdentity(artifact, `artifact-${index}`), artifact);
  });
  if (!artifacts.size)
    return empty('尚未关联 Workspace 附件或 Runtime Artifact。');
  return `<section class="tw-inspector-section tw-artifact-list">${[...artifacts.values()].map(renderArtifact).join('')}</section>`;
}

export function renderPending(state: TaskWorkspaceState): string {
  const workflow = currentWorkflow(state);
  const runtimePending = records(workflow?.pending);
  const timelinePending = state.timeline
    .filter((entry) => entry.kind === 'pending_interaction')
    .map((entry) => {
      if (
        entry.payload_json.interaction_kind !== 'runtime_command_confirmation'
      ) {
        return entry.payload_json;
      }
      const result = [...state.timeline]
        .sort((left, right) => right.session_seq - left.session_seq)
        .find(
          (candidate) =>
            candidate.kind === 'command_result' &&
            candidate.payload_json.proposal_id ===
              entry.payload_json.proposal_id,
        );
      if (!result) return entry.payload_json;
      const status = String(result.payload_json.status ?? 'failed');
      return {
        ...entry.payload_json,
        status: status === 'applied' ? 'accepted' : 'denied',
        canonical_result: result.payload_json.receipt ?? {
          command_status: status,
        },
      };
    });
  const linkedPending = state.runtimeDetail?.pending_interactions ?? [];
  const candidates = [
    ...timelinePending,
    ...(linkedPending.length ? [] : runtimePending),
    ...linkedPending,
    ...state.localInteractions,
    ...state.replans.map(replanInteraction),
  ];
  const unique = new Map<string, Record<string, unknown>>();
  candidates.forEach((candidate, index) => {
    const key = String(
      candidate.interaction_id ??
        candidate.target_id ??
        candidate.id ??
        `pending-${index}`,
    );
    unique.set(key, candidate);
  });
  if (!unique.size) return empty('当前没有等待处理的操作。');
  return `<section class="tw-inspector-section tw-pending-list">${[...unique.values()].map((item) => renderInteractionCard(item, 'pending')).join('')}</section>`;
}

export function renderTrace(state: TaskWorkspaceState): string {
  const workflow = currentWorkflow(state);
  const run = currentRun(state);
  if (!workflow) return empty('暂无 Runtime 关联信息。');
  const hasExactRun =
    workflowIdentity(workflow).trim().length > 0 &&
    String(run?.id ?? '').trim().length > 0;
  const queryIds = state.timeline
    .map((entry) => entry.payload_json.query_id)
    .filter((value): value is string => typeof value === 'string');
  return `
    <section class="tw-inspector-section">
      <p class="tw-context-note">此处仅显示 Task 范围内的关联信息，完整事件内容保留在 Runtime Center。</p>
      <dl class="tw-facts tw-trace-facts">
        ${fact('Workflow ID', workflowIdentity(workflow), workflowIdentity(workflow))}
        ${fact('Run ID', run?.id, String(run?.id ?? ''))}
        ${fact('Recipe', workflow.recipe_id ?? workflow.recipe_resource_id)}
        ${fact('Recipe 版本', workflow.recipe_ref_version ?? workflow.recipe_version)}
        ${fact('事件游标', run?.next_event_seq)}
        ${fact('Query IDs', queryIds.length ? [...new Set(queryIds)].join(', ') : '--')}
      </dl>
      <button type="button" class="tw-btn tw-btn-primary" data-tw-action="open-runtime-center"${hasExactRun ? '' : ' disabled'}>打开 Runtime Center</button>
    </section>`;
}

export function renderInspectorPanel(state: TaskWorkspaceState): string {
  switch (state.inspectorPanel) {
    case 'dag':
      return renderDag(state);
    case 'artifacts':
      return renderArtifacts(state);
    case 'pending':
      return renderPending(state);
    case 'trace':
      return renderTrace(state);
    default:
      return renderOverview(state);
  }
}

export function renderExecutionOptions(state: TaskWorkspaceState): string {
  const workflows = state.runtimeDetail?.workflows ?? [];
  return workflows
    .filter((workflow) => workflow.availability !== 'unavailable')
    .flatMap((workflow) =>
      workflowRuns(workflow).map((run) => {
        const workflowId = workflowIdentity(workflow);
        const runId = String(run.id ?? '');
        const value = `${workflowId}\n${runId}`;
        const selected =
          workflowId === state.selectedWorkflowId &&
          runId === state.selectedRunId;
        const runLabel = run.lifecycle ?? run.state_key;
        return `<option value="${escapeAttribute(value)}"${selected ? ' selected' : ''}>${escapeHtml(`${compactId(workflowId)} / ${runLabel ? workspaceDisplayLabel(runLabel) : compactId(runId)}`)}</option>`;
      }),
    )
    .join('');
}
