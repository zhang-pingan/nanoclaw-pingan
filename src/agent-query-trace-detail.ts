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
import {
  isAppliedTraceFileChangeEvent,
  isTraceFileReadEvent,
  isTraceToolFailureEvent,
  isTraceToolStartEvent,
  parseTracePayloadObject,
  summarizeAgentQueryEvents,
  traceEventCategory,
  traceEventHasToolIdentity,
  traceEventIdentity,
  traceNumberValue,
  tracePayloadString,
  traceStringValue,
} from './agent-query-trace-summary.js';

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
  return parseTracePayloadObject(value);
}

function stringValue(value: unknown): string {
  return traceStringValue(value);
}

function numberValue(value: unknown): number | null {
  return traceNumberValue(value);
}

function eventIdentity(
  event: AgentQueryEventRecord,
  payload: JsonObject,
): string {
  return traceEventIdentity(event.event_name, payload, String(event.event_index));
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
  return traceEventCategory(event.event_type, event.event_name, payload);
}

function addUniquePath(paths: Set<string>, payload: JsonObject): void {
  const path =
    tracePayloadString(payload, 'path') ||
    tracePayloadString(payload, 'resourceRef');
  if (path) paths.add(path);
}

function isToolStartEvent(name: string): boolean {
  return isTraceToolStartEvent(name);
}

function isToolFailureEvent(name: string, status: string): boolean {
  return isTraceToolFailureEvent(name, status);
}

function isFileReadEvent(name: string, payload: JsonObject): boolean {
  return isTraceFileReadEvent(name, payload);
}

function eventHasToolIdentity(payload: JsonObject): boolean {
  return traceEventHasToolIdentity(payload);
}

function backfillQuerySummary(
  query: AgentQueryRecord,
  summary: AgentQueryTraceSummary,
  firstToolAt: string | null,
): void {
  const patch: Partial<AgentQueryRecord> = {};
  if (query.first_tool_at !== firstToolAt) {
    patch.first_tool_at = firstToolAt;
  }
  if (query.queue_latency_ms !== summary.queueLatencyMs) {
    patch.queue_latency_ms = summary.queueLatencyMs;
  }
  if (query.tool_call_count !== summary.toolCallCount) {
    patch.tool_call_count = summary.toolCallCount;
  }
  if (query.failed_tool_call_count !== summary.failedToolCallCount) {
    patch.failed_tool_call_count = summary.failedToolCallCount;
  }
  if (query.changed_file_count !== summary.changedFileCount) {
    patch.changed_file_count = summary.changedFileCount;
  }
  if (query.artifact_count !== summary.artifactCount) {
    patch.artifact_count = summary.artifactCount;
  }

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
  const toolCallIds = new Set<string>();
  const failedToolIds = new Set<string>();
  const fileReadPaths = new Set<string>();
  const derivedSummary = summarizeAgentQueryEvents(events);

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
      const id = eventIdentity(event, payload);
      if (isToolStartEvent(name)) {
        toolCallIds.add(id);
      }
      if (isToolFailureEvent(name, status)) {
        failedToolIds.add(id);
        toolCallIds.add(id);
      }
    }

    if (category === 'file') {
      highlights.files.push(event);
      if (isFileReadEvent(name, payload)) {
        const path = stringValue(payload.path) || stringValue(payload.resourceRef);
        if (path) fileReadPaths.add(path);
      }
      if (isAppliedTraceFileChangeEvent(name, status, payload)) {
        addUniquePath(changedPaths, payload);
      }
    }

    if (event.event_type === 'command' || name.startsWith('command_')) {
      const id = eventIdentity(event, payload);
      if (name.endsWith('started')) {
        commandCount += 1;
        toolCallIds.add(id);
      }
      if (isToolFailureEvent(name, status)) {
        failedToolIds.add(id);
      }
      if (!highlights.tools.includes(event)) highlights.tools.push(event);
    }
    if (
      category !== 'tool' &&
      event.event_type !== 'command' &&
      eventHasToolIdentity(payload) &&
      isToolFailureEvent(name, status)
    ) {
      failedToolIds.add(eventIdentity(event, payload));
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
  const firstTool = timestamp(derivedSummary.first_tool_at);
  toolCallCount = toolCallIds.size;
  failedToolCallCount = failedToolIds.size;
  fileReadCount = fileReadPaths.size;
  fileWriteCount = changedPaths.size;
  const containerDurationMs =
    containerStart != null && containerEnd != null
      ? Math.max(0, containerEnd - containerStart)
      : null;
  const summary: AgentQueryTraceSummary = {
    durationMs: query.latency_ms,
    queueLatencyMs: derivedSummary.queue_latency_ms ?? queueLatencyMs,
    containerDurationMs,
    firstOutputDelayMs:
      start != null && firstOutput != null ? Math.max(0, firstOutput - start) : null,
    firstToolDelayMs:
      start != null && firstTool != null ? Math.max(0, firstTool - start) : null,
    toolCallCount: derivedSummary.tool_call_count,
    failedToolCallCount: derivedSummary.failed_tool_call_count,
    fileReadCount,
    fileWriteCount,
    changedFileCount: derivedSummary.changed_file_count,
    commandCount,
    ipcCallCount,
    modelCallCount:
      modelStartedCount || modelCompletedCount || modelResolutionCount,
    artifactCount: derivedSummary.artifact_count,
    errorCount,
    warningCount,
  };

  backfillQuerySummary(query, summary, derivedSummary.first_tool_at);
  return { query: newestQuery(queryId, query), steps, events, summary, highlights };
}
