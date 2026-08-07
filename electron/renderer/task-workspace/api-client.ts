import type {
  RecipeCatalogItem,
  RuntimeDetail,
  TaskSession,
  TimelineEntry,
} from './state.js';

export type Fetcher = (
  path: string,
  options?: RequestInit,
) => Promise<Response>;

export class TaskWorkspaceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TaskWorkspaceApiError';
  }
}

export class TaskWorkspaceApiClient {
  constructor(private readonly fetcher: Fetcher) {}

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetcher(path, options);
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const envelope =
        body.error &&
        typeof body.error === 'object' &&
        !Array.isArray(body.error)
          ? (body.error as Record<string, unknown>)
          : body;
      throw new TaskWorkspaceApiError(
        String(envelope.code ?? 'http_error'),
        String(envelope.message ?? `Task Workspace HTTP ${response.status}`),
        response.status,
        envelope.retryable === true,
      );
    }
    return body as T;
  }

  listSessions(): Promise<{ sessions: TaskSession[] }> {
    return this.request('/api/task-workspace/sessions');
  }

  createSession(title: string): Promise<{ session: TaskSession }> {
    return this.request('/api/task-workspace/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  getSession(sessionId: string): Promise<{
    session: TaskSession;
    execution_links: Array<Record<string, unknown>>;
  }> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  listRecipes(): Promise<{
    format: string;
    items: RecipeCatalogItem[];
    expires_at_ms: number;
  }> {
    return this.request('/api/task-workspace/recipes');
  }

  setRunSelection(
    sessionId: string,
    selection:
      | { kind: 'temporary_workflow' }
      | { kind: 'published_recipe'; selection_token: string },
    expectedRowVersion: number,
  ): Promise<{ session: TaskSession }> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/run-selection`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ...selection,
          expected_row_version: expectedRowVersion,
        }),
      },
    );
  }

  postMessage(
    sessionId: string,
    action: 'send' | 'run',
    text: string,
    options: { selectionToken?: string; idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          action,
          text,
          ...(options.selectionToken
            ? { selection_token: options.selectionToken }
            : {}),
          ...(action === 'run'
            ? { idempotency_key: options.idempotencyKey }
            : {}),
        }),
      },
    );
  }

  timeline(
    sessionId: string,
    afterSessionSeq: number,
  ): Promise<{
    type: 'task_workspace_timeline_delta';
    session_id: string;
    after_session_seq: number;
    entries: TimelineEntry[];
    next_session_seq: number;
    source_state: 'ready' | 'catching_up' | 'degraded';
  }> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/timeline?after_session_seq=${afterSessionSeq}`,
    );
  }

  runtimeDetail(sessionId: string): Promise<RuntimeDetail> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/runtime-detail`,
    );
  }

  updateSessionStatus(
    sessionId: string,
    action: 'complete' | 'reopen' | 'archive',
    expectedRowVersion: number,
  ): Promise<{ session: TaskSession }> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/${action}`,
      {
        method: 'POST',
        body: JSON.stringify({ expected_row_version: expectedRowVersion }),
      },
    );
  }

  getLaunchIntent(launchIntentId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/launch-intents/${encodeURIComponent(launchIntentId)}`,
    );
  }

  confirmTemporary(
    launchIntentId: string,
    revisionId: string,
    expectedRowVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/launch-intents/${encodeURIComponent(launchIntentId)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({
          revision_id: revisionId,
          expected_row_version: expectedRowVersion,
        }),
      },
    );
  }

  reviseTemporary(
    launchIntentId: string,
    instruction: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/launch-intents/${encodeURIComponent(launchIntentId)}/revise`,
      {
        method: 'POST',
        body: JSON.stringify({ instruction }),
      },
    );
  }

  cancelTemporary(
    launchIntentId: string,
    expectedRowVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/launch-intents/${encodeURIComponent(launchIntentId)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ expected_row_version: expectedRowVersion }),
      },
    );
  }

  submitInteraction(
    interactionId: string,
    submission: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { interaction_id: _pathIdentity, ...body } = submission;
    return this.request(
      `/api/task-workspace/interactions/${encodeURIComponent(interactionId)}/submit`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  createRuntimeCommandProposal(
    sessionId: string,
    workflowId: string,
    runId: string,
    action: 'pause' | 'resume' | 'cancel',
    expectedTargetRowVersion: number,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/runtime-command-proposals`,
      {
        method: 'POST',
        body: JSON.stringify({
          workflow_id: workflowId,
          run_id: runId,
          action,
          expected_target_row_version: expectedTargetRowVersion,
          idempotency_key: idempotencyKey,
        }),
      },
    );
  }

  confirmRuntimeCommand(
    proposalId: string,
    expectedRowVersion: number,
    proposalHash: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/runtime-command-proposals/${encodeURIComponent(proposalId)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({
          expected_row_version: expectedRowVersion,
          proposal_hash: proposalHash,
        }),
      },
    );
  }

  listReplans(
    sessionId: string,
  ): Promise<{ replans: Array<Record<string, unknown>> }> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/replans`,
    );
  }

  createReplan(
    sessionId: string,
    workflowId: string,
    runId: string,
    instruction: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/sessions/${encodeURIComponent(sessionId)}/replans`,
      {
        method: 'POST',
        body: JSON.stringify({
          workflow_id: workflowId,
          run_id: runId,
          instruction,
          idempotency_key: idempotencyKey,
        }),
      },
    );
  }

  confirmReplan(
    replanId: string,
    expectedRowVersion: number,
    proposalHash: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/replans/${encodeURIComponent(replanId)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({
          expected_row_version: expectedRowVersion,
          proposal_hash: proposalHash,
        }),
      },
    );
  }

  cancelReplan(
    replanId: string,
    expectedRowVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/task-workspace/replans/${encodeURIComponent(replanId)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ expected_row_version: expectedRowVersion }),
      },
    );
  }
}
