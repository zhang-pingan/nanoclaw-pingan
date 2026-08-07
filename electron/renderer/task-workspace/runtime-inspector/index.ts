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
  if (!workflow) return empty('No linked Workflow yet.');
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
        ${!available ? 'Historical Runtime detail is unavailable. This Workflow is read-only.' : state.runtimeDetail?.freshness === 'degraded' ? 'Runtime snapshot is degraded. Fresh-state actions are disabled.' : 'Runtime snapshot is current.'}
      </div>
      <dl class="tw-facts">
        ${fact('Workflow', compactId(workflowIdentity(workflow)), workflowIdentity(workflow))}
        ${fact('Status', workflow.status)}
        ${fact('Operational', workflow.operational_state)}
        ${fact('Run', compactId(run?.id), String(run?.id ?? ''))}
        ${fact('Run lifecycle', run?.lifecycle)}
        ${fact('Control', run?.control)}
        ${fact('Deadline', formatTime(workflow.deadline_at_ms))}
        ${fact('Pending', pending.length)}
        ${fact('Outcome', workflow.final_outcome_kind)}
        ${fact('Last error', workflow.final_error_code ?? run?.error_code)}
      </dl>
      ${hints.length || replanAvailable ? `<div class="tw-command-bar" aria-label="Runtime commands">${hints.map((hint) => `<button type="button" class="tw-btn ${hint === 'cancel' ? 'tw-btn-danger' : 'tw-btn-quiet'}" data-tw-action="runtime-command" data-command="${escapeAttribute(hint)}"${state.runtimeDetail?.freshness === 'degraded' ? ' disabled' : ''}>${escapeHtml(readableLabel(hint))}</button>`).join('')}${replanAvailable ? '<button type="button" class="tw-btn tw-btn-quiet" data-tw-action="begin-replan">Replan</button>' : ''}</div>` : ''}
    </section>`;
}

export function renderDag(state: TaskWorkspaceState): string {
  const workflow = currentWorkflow(state);
  const run = currentRun(state);
  if (!workflow || !run) return empty('No materialized DAG is linked.');
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
      ${temporary && childScopes.length ? '<div class="tw-context-note">Dynamic Child DAG shown. The fixed Runtime wrapper is hidden.</div>' : ''}
      <div class="tw-dag-summary"><span>${nodes.length} nodes</span><span>${edges.length} edges</span><span>${attempts.length} attempts</span><span>${completionCuts.length} completion cuts</span><span>${allScopes.length} scopes</span></div>
      <div class="tw-dag-list">
        ${
          nodes.length
            ? nodes
                .map(
                  (node) => `
                  <div class="tw-dag-node">
                    <span class="tw-node-state is-${escapeAttribute(String(node.phase ?? 'unknown'))}"></span>
                    <div><strong>${escapeHtml(node.node_key ?? compactId(node.id))}</strong><span>${escapeHtml(readableLabel(node.node_type ?? 'node'))}</span></div>
                    <div class="tw-dag-node-state"><span>${escapeHtml(node.phase ?? '--')}</span><small>${escapeHtml(node.terminal_status ?? node.trigger_state ?? '')}</small></div>
                  </div>`,
                )
                .join('')
            : empty('The current Run has no materialized nodes.')
        }
      </div>
      ${edges.length ? `<details class="tw-disclosure"><summary>Edges</summary><div class="tw-edge-list">${edges.map((edge) => `<div title="${escapeAttribute(String(edge.edge_kind ?? edge.resolution_state ?? ''))}"><span>${escapeHtml(edge.from_node_key ?? nodeKeys.get(String(edge.from_node_id)) ?? compactId(edge.from_node_id))}</span><span aria-hidden="true">-&gt;</span><span>${escapeHtml(edge.to_node_key ?? nodeKeys.get(String(edge.to_node_id)) ?? compactId(edge.to_node_id))}</span></div>`).join('')}</div></details>` : ''}
      ${attempts.length ? `<details class="tw-disclosure"><summary>Attempts</summary><dl class="tw-facts">${attempts.map((attempt) => fact(`${nodeKeys.get(String(attempt.node_id)) ?? compactId(attempt.node_id)} / #${attempt.attempt_no ?? '?'}`, attempt.execution_outcome ?? attempt.quality_decision ?? attempt.phase ?? '--', String(attempt.query_id ?? attempt.id ?? ''))).join('')}</dl></details>` : ''}
      ${completionCuts.length ? `<details class="tw-disclosure"><summary>Completion cuts</summary><dl class="tw-facts">${completionCuts.map((cut) => fact(String(cut.exit_name ?? compactId(cut.scope_id) ?? 'Completion'), cut.outcome_kind ?? '--', String(cut.cut_hash ?? cut.id ?? ''))).join('')}</dl></details>` : ''}
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
    return empty('No Workspace attachment or Runtime Artifact is linked.');
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
  if (!unique.size) return empty('No action is waiting for you.');
  return `<section class="tw-inspector-section tw-pending-list">${[...unique.values()].map((item) => renderInteractionCard(item, 'pending')).join('')}</section>`;
}

export function renderTrace(state: TaskWorkspaceState): string {
  const workflow = currentWorkflow(state);
  const run = currentRun(state);
  if (!workflow) return empty('No Runtime correlation is available.');
  const hasExactRun =
    workflowIdentity(workflow).trim().length > 0 &&
    String(run?.id ?? '').trim().length > 0;
  const queryIds = state.timeline
    .map((entry) => entry.payload_json.query_id)
    .filter((value): value is string => typeof value === 'string');
  return `
    <section class="tw-inspector-section">
      <p class="tw-context-note">Task-scoped correlation only. Full event payloads stay in Runtime Center.</p>
      <dl class="tw-facts tw-trace-facts">
        ${fact('Workflow ID', workflowIdentity(workflow), workflowIdentity(workflow))}
        ${fact('Run ID', run?.id, String(run?.id ?? ''))}
        ${fact('Recipe', workflow.recipe_id ?? workflow.recipe_resource_id)}
        ${fact('Recipe version', workflow.recipe_ref_version ?? workflow.recipe_version)}
        ${fact('Event cursor', run?.next_event_seq)}
        ${fact('Query IDs', queryIds.length ? [...new Set(queryIds)].join(', ') : '--')}
      </dl>
      <button type="button" class="tw-btn tw-btn-primary" data-tw-action="open-runtime-center"${hasExactRun ? '' : ' disabled'}>Open Runtime Center</button>
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
        return `<option value="${escapeAttribute(value)}"${selected ? ' selected' : ''}>${escapeHtml(`${compactId(workflowId)} / ${String(run.lifecycle ?? run.state_key ?? compactId(runId))}`)}</option>`;
      }),
    )
    .join('');
}
