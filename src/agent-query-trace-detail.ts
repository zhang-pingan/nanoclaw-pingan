import {
  getAgentQuery,
  listAgentQueryEvents,
  listAgentQuerySteps,
  updateAgentQuery,
} from './db.js';
import {
  AgentQueryEventRecord,
  AgentQueryRecord,
  AgentQueryStepRecord,
} from './types.js';

export interface AgentQueryTraceSummary {
  durationMs: number | null;
  queueLatencyMs: number | null;
  containerDurationMs: number | null;
  firstOutputDelayMs: number | null;
  firstToolDelayMs: number | null;
  toolCallCount: number;
  failedToolCallCount: number;
  fileReadCount: number;
  fileWriteCount: number;
  changedFileCount: number;
  commandCount: number;
  ipcCallCount: number;
  modelCallCount: number;
  artifactCount: number;
  errorCount: number;
  warningCount: number;
}

export interface AgentQueryTraceHighlights {
  files: AgentQueryEventRecord[];
  tools: AgentQueryEventRecord[];
  errors: AgentQueryEventRecord[];
  artifacts: AgentQueryEventRecord[];
  humanReviews: AgentQueryEventRecord[];
  models: AgentQueryEventRecord[];
  ipc: AgentQueryEventRecord[];
  containers: AgentQueryEventRecord[];
  workflow: AgentQueryEventRecord[];
  evaluation: AgentQueryEventRecord[];
}

export interface AgentQueryTraceDetail {
  query: AgentQueryRecord;
  steps: AgentQueryStepRecord[];
  events: AgentQueryEventRecord[];
  summary: AgentQueryTraceSummary;
  highlights: AgentQueryTraceHighlights;
}

type JsonObject = Record<string, unknown>;

function parsePayload(value: string | null): JsonObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isErrorEvent(event: AgentQueryEventRecord, payload: JsonObject): boolean {
  const status = stringValue(event.status).toLowerCase();
  const severity = stringValue(payload.severity).toLowerCase();
  const name = event.event_name.toLowerCase();
  const type = event.event_type.toLowerCase();
  return (
    status === 'error' ||
    status === 'failed' ||
    severity === 'error' ||
    type === 'error' ||
    name.includes('failed') ||
    name.includes('error') ||
    name.includes('timeout')
  );
}

function categoryForEvent(
  event: AgentQueryEventRecord,
  payload: JsonObject,
): string {
  const explicit = stringValue(payload.category).toLowerCase();
  if (explicit) return explicit;

  const type = event.event_type.toLowerCase();
  const name = event.event_name.toLowerCase();
  if (type === 'command' || name.startsWith('command_')) return 'tool';
  if (type) return type;
  if (name.startsWith('file_')) return 'file';
  if (name.startsWith('tool_')) return 'tool';
  if (name.startsWith('model_')) return 'model';
  if (name.startsWith('container_')) return 'container';
  if (name.startsWith('workflow_')) return 'workflow';
  if (name.includes('evaluation') || name.includes('judge')) return 'evaluation';
  if (name.startsWith('ipc_')) return 'ipc';
  return 'lifecycle';
}

function addUniquePath(paths: Set<string>, payload: JsonObject): void {
  const path = stringValue(payload.path) || stringValue(payload.resourceRef);
  if (path) paths.add(path);
}

function backfillQuerySummary(
  query: AgentQueryRecord,
  summary: AgentQueryTraceSummary,
): void {
  const patch: Partial<AgentQueryRecord> = {};
  if (query.queue_latency_ms == null && summary.queueLatencyMs != null) {
    patch.queue_latency_ms = summary.queueLatencyMs;
  }
  if (query.tool_call_count == null) patch.tool_call_count = summary.toolCallCount;
  if (query.failed_tool_call_count == null) {
    patch.failed_tool_call_count = summary.failedToolCallCount;
  }
  if (query.changed_file_count == null) {
    patch.changed_file_count = summary.changedFileCount;
  }
  if (query.artifact_count == null) patch.artifact_count = summary.artifactCount;

  if (Object.keys(patch).length > 0) {
    updateAgentQuery(query.query_id, patch);
    Object.assign(query, patch);
  }
}

function newestQuery(queryId: string, query: AgentQueryRecord): AgentQueryRecord {
  return getAgentQuery(queryId) ?? query;
}

export function buildAgentQueryTraceDetail(
  queryId: string,
): AgentQueryTraceDetail | null {
  const query = getAgentQuery(queryId);
  if (!query) return null;

  const steps = listAgentQuerySteps(queryId);
  const events = listAgentQueryEvents(queryId);
  const highlights: AgentQueryTraceHighlights = {
    files: [],
    tools: [],
    errors: [],
    artifacts: [],
    humanReviews: [],
    models: [],
    ipc: [],
    containers: [],
    workflow: [],
    evaluation: [],
  };

  const changedPaths = new Set<string>();
  let toolCallCount = 0;
  let failedToolCallCount = 0;
  let fileReadCount = 0;
  let fileWriteCount = 0;
  let commandCount = 0;
  let ipcCallCount = 0;
  let modelStartedCount = 0;
  let modelCompletedCount = 0;
  let modelResolutionCount = 0;
  let artifactCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  let containerStart: number | null = null;
  let containerEnd: number | null = null;
  let queueLatencyMs = query.queue_latency_ms;

  for (const event of events) {
    const payload = parsePayload(event.payload_json);
    const category = categoryForEvent(event, payload);
    const name = event.event_name.toLowerCase();
    const status = stringValue(event.status).toLowerCase();
    const severity = stringValue(payload.severity).toLowerCase();
    const startedAt = timestamp(event.started_at);

    if (category === 'queue') {
      const payloadLatency = numberValue(payload.queueLatencyMs);
      if (payloadLatency != null) queueLatencyMs = payloadLatency;
    }

    if (category === 'container') {
      highlights.containers.push(event);
      if (name === 'container_spawned' && startedAt != null) {
        containerStart = containerStart == null ? startedAt : Math.min(containerStart, startedAt);
      }
      if (
        (name === 'container_exited' || name === 'container_timeout') &&
        startedAt != null
      ) {
        containerEnd = containerEnd == null ? startedAt : Math.max(containerEnd, startedAt);
      }
    }

    if (category === 'tool') {
      highlights.tools.push(event);
      if (name === 'tool_started' || name === 'tool_call') toolCallCount += 1;
      if (status === 'error' || status === 'failed' || name.includes('failed')) {
        failedToolCallCount += 1;
      }
    }

    if (category === 'file') {
      highlights.files.push(event);
      if (name.includes('read')) fileReadCount += 1;
      if (
        name.includes('write') ||
        name.includes('edit') ||
        name.includes('delete') ||
        name.includes('diff')
      ) {
        fileWriteCount += 1;
        addUniquePath(changedPaths, payload);
      }
    }

    if (event.event_type === 'command' || name.startsWith('command_')) {
      commandCount += name.endsWith('started') ? 1 : 0;
      if (!highlights.tools.includes(event)) highlights.tools.push(event);
    }

    if (category === 'model') {
      highlights.models.push(event);
      if (name.includes('started')) modelStartedCount += 1;
      if (name.includes('completed')) modelCompletedCount += 1;
      if (name === 'model_resolution') modelResolutionCount += 1;
    }

    if (category === 'ipc') {
      highlights.ipc.push(event);
      if (name.includes('request') || name.includes('call')) ipcCallCount += 1;
    }

    if (category === 'workflow') highlights.workflow.push(event);
    if (category === 'evaluation') highlights.evaluation.push(event);
    if (category === 'artifact') {
      highlights.artifacts.push(event);
      artifactCount += 1;
    }
    if (category === 'human') highlights.humanReviews.push(event);

    if (isErrorEvent(event, payload)) {
      highlights.errors.push(event);
      errorCount += 1;
    } else if (severity === 'warn' || status === 'warning') {
      warningCount += 1;
    }
  }

  const start = timestamp(query.started_at);
  const firstOutput = timestamp(query.first_output_at);
  const firstTool = timestamp(query.first_tool_at);
  const containerDurationMs =
    containerStart != null && containerEnd != null
      ? Math.max(0, containerEnd - containerStart)
      : null;
  const summary: AgentQueryTraceSummary = {
    durationMs: query.latency_ms,
    queueLatencyMs,
    containerDurationMs,
    firstOutputDelayMs:
      start != null && firstOutput != null ? Math.max(0, firstOutput - start) : null,
    firstToolDelayMs:
      start != null && firstTool != null ? Math.max(0, firstTool - start) : null,
    toolCallCount:
      query.tool_call_count ?? Math.max(toolCallCount, highlights.tools.length),
    failedToolCallCount: query.failed_tool_call_count ?? failedToolCallCount,
    fileReadCount,
    fileWriteCount,
    changedFileCount: query.changed_file_count ?? changedPaths.size,
    commandCount,
    ipcCallCount,
    modelCallCount:
      modelStartedCount || modelCompletedCount || modelResolutionCount,
    artifactCount: query.artifact_count ?? artifactCount,
    errorCount,
    warningCount,
  };

  backfillQuerySummary(query, summary);
  return { query: newestQuery(queryId, query), steps, events, summary, highlights };
}
