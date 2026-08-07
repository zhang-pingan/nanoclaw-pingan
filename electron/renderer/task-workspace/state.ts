export type TaskSessionStatus = 'open' | 'completed' | 'cancelled' | 'archived';

export type TaskRunSelection =
  | { kind: 'temporary_workflow' }
  | {
      kind: 'published_recipe';
      recipe_ref: { id: string; version: string };
      recipe_hash: string;
      recipe_kind: 'core' | 'feature' | 'personal';
    };

export interface TaskSession {
  session_id: string;
  title: string;
  status: TaskSessionStatus;
  attention_state: 'none' | 'waiting_user' | 'action_required' | 'failed';
  current_run_selection: TaskRunSelection;
  updated_at_ms: number;
  row_version: number;
}

export interface TimelineEntry {
  entry_id: string;
  session_id: string;
  session_seq: number;
  kind: string;
  source_kind: 'workspace' | 'runtime';
  source_id: string;
  source_event_seq: number | null;
  payload_json: Record<string, unknown>;
  occurred_at_ms: number;
  created_at_ms: number;
}

export interface RecipeCatalogItem {
  recipe_kind: 'core' | 'feature' | 'personal';
  recipe_ref: { id: string; version: string };
  recipe_hash: string;
  display_name: string;
  description: string | null;
  launch_policy: 'auto' | 'confirm' | 'manual_only';
  input_summary: Record<string, unknown>;
  selection_token: string;
}

export interface RuntimeDetail {
  format: 'icarus.workspace-runtime-detail/1';
  freshness: 'ready' | 'degraded';
  workflows: Array<Record<string, unknown>>;
  pending_interactions?: Array<Record<string, unknown>>;
  artifact_links?: Array<Record<string, unknown>>;
}

export interface TaskWorkspaceState {
  sessions: TaskSession[];
  activeSession: TaskSession | null;
  executionLinks: Array<Record<string, unknown>>;
  recipes: RecipeCatalogItem[];
  timeline: TimelineEntry[];
  timelineCursor: number;
  timelineSourceState: 'ready' | 'catching_up' | 'degraded';
  runtimeDetail: RuntimeDetail | null;
  selectedWorkflowId: string;
  selectedRunId: string;
  sessionFilter: 'active' | 'waiting' | 'completed' | 'archived';
  sessionSearch: string;
  inspectorPanel: 'overview' | 'dag' | 'artifacts' | 'pending' | 'trace';
  inspectorCollapsed: boolean;
  localInteractions: Array<Record<string, unknown>>;
  replans: Array<Record<string, unknown>>;
  busy: boolean;
  error: string;
}

export function createTaskWorkspaceState(): TaskWorkspaceState {
  return {
    sessions: [],
    activeSession: null,
    executionLinks: [],
    recipes: [],
    timeline: [],
    timelineCursor: 0,
    timelineSourceState: 'ready',
    runtimeDetail: null,
    selectedWorkflowId: '',
    selectedRunId: '',
    sessionFilter: 'active',
    sessionSearch: '',
    inspectorPanel: 'overview',
    inspectorCollapsed: false,
    localInteractions: [],
    replans: [],
    busy: false,
    error: '',
  };
}

export function mergeTimelineEntries(
  current: readonly TimelineEntry[],
  incoming: readonly TimelineEntry[],
): TimelineEntry[] {
  const byId = new Map(current.map((entry) => [entry.entry_id, entry]));
  for (const entry of incoming) byId.set(entry.entry_id, entry);
  return [...byId.values()].sort(
    (left, right) =>
      left.occurred_at_ms - right.occurred_at_ms ||
      left.source_kind.localeCompare(right.source_kind) ||
      left.source_id.localeCompare(right.source_id) ||
      (left.source_event_seq ?? -1) - (right.source_event_seq ?? -1) ||
      left.entry_id.localeCompare(right.entry_id),
  );
}

export function timelineCursor(entries: readonly TimelineEntry[]): number {
  return entries.reduce(
    (cursor, entry) => Math.max(cursor, entry.session_seq),
    0,
  );
}

export function visibleSessions(
  sessions: readonly TaskSession[],
  filter: TaskWorkspaceState['sessionFilter'],
  search: string,
): TaskSession[] {
  const query = search.trim().toLocaleLowerCase();
  return sessions
    .filter((session) => {
      if (filter === 'waiting') {
        return (
          session.status === 'open' &&
          ['waiting_user', 'action_required'].includes(session.attention_state)
        );
      }
      if (filter === 'active') {
        return (
          session.status === 'open' &&
          !['waiting_user', 'action_required'].includes(session.attention_state)
        );
      }
      if (filter === 'completed') {
        return ['completed', 'cancelled'].includes(session.status);
      }
      return session.status === 'archived';
    })
    .filter(
      (session) => !query || session.title.toLocaleLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        right.updated_at_ms - left.updated_at_ms ||
        left.session_id.localeCompare(right.session_id),
    );
}

export function workflowRuns(
  workflow: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  return workflow && Array.isArray(workflow.runs)
    ? workflow.runs.filter((run): run is Record<string, unknown> =>
        Boolean(run && typeof run === 'object' && !Array.isArray(run)),
      )
    : [];
}

export function workflowIdentity(
  workflow: Record<string, unknown> | null | undefined,
): string {
  return String(workflow?.workflow_id ?? workflow?.id ?? '');
}

export function chooseExecution(
  detail: RuntimeDetail | null,
  workflowId = '',
  runId = '',
): { workflowId: string; runId: string } {
  const available = (detail?.workflows ?? []).filter(
    (workflow) => workflow.availability !== 'unavailable',
  );
  const workflow =
    available.find((item) => workflowIdentity(item) === workflowId) ??
    available[0] ??
    null;
  if (!workflow) return { workflowId: '', runId: '' };
  const runs = workflowRuns(workflow);
  const run =
    runs.find((item) => item.id === runId) ??
    runs.find((item) => item.id === workflow.current_graph_run_id) ??
    runs[0] ??
    null;
  return {
    workflowId: workflowIdentity(workflow),
    runId: String(run?.id ?? ''),
  };
}

export function currentWorkflow(
  state: TaskWorkspaceState,
): Record<string, unknown> | null {
  return (
    state.runtimeDetail?.workflows.find(
      (workflow) => workflowIdentity(workflow) === state.selectedWorkflowId,
    ) ??
    state.runtimeDetail?.workflows[0] ??
    null
  );
}

export function currentRun(
  state: TaskWorkspaceState,
): Record<string, unknown> | null {
  const workflow = currentWorkflow(state);
  return (
    workflowRuns(workflow).find((run) => run.id === state.selectedRunId) ??
    workflowRuns(workflow)[0] ??
    null
  );
}
