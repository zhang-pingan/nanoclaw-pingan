import type { AgentQueryEventRecord } from './types.js';

export interface AgentQueryDerivedTraceSummary {
  queue_latency_ms: number | null;
  tool_call_count: number;
  failed_tool_call_count: number;
  changed_file_count: number;
  artifact_count: number;
  first_tool_at: string | null;
}

export interface AgentQueryTraceSummaryAccumulator {
  queueLatencyMs: number | null;
  firstToolAt: string | null;
  toolIds: Set<string>;
  failedToolIds: Set<string>;
  changedPaths: Set<string>;
  artifactIds: Set<string>;
}

export function parseTracePayloadObject(
  value: string | null,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function traceStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function tracePayloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function traceNumberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function traceEventCategory(
  eventType: string,
  eventName: string,
  payload: Record<string, unknown>,
): string {
  const explicit = tracePayloadString(payload, 'category');
  if (explicit) return explicit.toLowerCase();
  const type = eventType.toLowerCase();
  const name = eventName.toLowerCase();
  if (type === 'command' || name.startsWith('command_')) return 'tool';
  if (type) return type;
  if (name.startsWith('file_')) return 'file';
  if (name.startsWith('tool_')) return 'tool';
  if (name.startsWith('model_')) return 'model';
  if (name.startsWith('container_')) return 'container';
  if (name.startsWith('queue_')) return 'queue';
  if (name.startsWith('ipc_')) return 'ipc';
  if (name.includes('evaluation') || name.includes('judge')) return 'evaluation';
  if (name.startsWith('human_')) return 'human';
  if (name.startsWith('artifact_')) return 'artifact';
  return 'lifecycle';
}

export function traceEventIdentity(
  eventName: string,
  payload: Record<string, unknown>,
  fallback: string,
): string {
  return (
    tracePayloadString(payload, 'toolUseId') ||
    tracePayloadString(payload, 'path') ||
    tracePayloadString(payload, 'resourceRef') ||
    `${eventName}:${fallback}`
  );
}

export function isTraceToolStartEvent(eventName: string): boolean {
  const name = eventName.toLowerCase();
  return (
    name === 'tool_started' ||
    name === 'tool_call' ||
    name === 'command_started'
  );
}

export function isTraceToolFailureEvent(
  eventName: string,
  status: string | null,
): boolean {
  const normalizedStatus = (status || '').toLowerCase();
  const name = eventName.toLowerCase();
  return (
    normalizedStatus === 'error' ||
    normalizedStatus === 'failed' ||
    name.endsWith('_failed') ||
    name.includes('tool_failed') ||
    name.includes('command_failed')
  );
}

export function isTraceFileChangeEvent(
  eventName: string,
  payload: Record<string, unknown>,
): boolean {
  const name = eventName.toLowerCase();
  const operation = tracePayloadString(payload, 'operation')?.toLowerCase() || '';
  return (
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('delete') ||
    name.includes('diff') ||
    operation === 'write' ||
    operation === 'edit' ||
    operation === 'delete' ||
    operation === 'diff'
  );
}

export function isTraceFileReadEvent(
  eventName: string,
  payload: Record<string, unknown>,
): boolean {
  const operation = tracePayloadString(payload, 'operation')?.toLowerCase() || '';
  return eventName.toLowerCase().includes('read') || operation === 'read';
}

function isSuccessfulTraceStatus(status: string | null): boolean {
  const normalized = (status || '').toLowerCase();
  return (
    normalized === 'success' ||
    normalized === 'succeeded' ||
    normalized === 'completed' ||
    normalized === 'ok'
  );
}

export function isAppliedTraceFileChangeEvent(
  eventName: string,
  status: string | null,
  payload: Record<string, unknown>,
): boolean {
  if (!isTraceFileChangeEvent(eventName, payload)) return false;
  const name = eventName.toLowerCase();
  if (isSuccessfulTraceStatus(status)) return true;
  return (
    !status &&
    (name.endsWith('_complete') ||
      name.endsWith('_completed') ||
      name.includes('_complete'))
  );
}

export function traceEventHasToolIdentity(
  payload: Record<string, unknown>,
): boolean {
  return Boolean(
    tracePayloadString(payload, 'toolUseId') ||
      tracePayloadString(payload, 'toolName'),
  );
}

export function isTraceToolActivityEvent(
  category: string,
  eventType: string,
  eventName: string,
  payload: Record<string, unknown>,
): boolean {
  const normalizedCategory = category.toLowerCase();
  const normalizedType = eventType.toLowerCase();
  const normalizedName = eventName.toLowerCase();
  return (
    normalizedCategory === 'tool' ||
    normalizedCategory === 'ipc' ||
    normalizedType === 'command' ||
    normalizedName.startsWith('command_') ||
    normalizedName.startsWith('tool_') ||
    normalizedName.startsWith('ipc_request_') ||
    (normalizedCategory === 'file' &&
      (normalizedName.startsWith('file_') || traceEventHasToolIdentity(payload)))
  );
}

export function createTraceSummaryAccumulator(
  firstToolAt: string | null = null,
): AgentQueryTraceSummaryAccumulator {
  return {
    queueLatencyMs: null,
    firstToolAt,
    toolIds: new Set<string>(),
    failedToolIds: new Set<string>(),
    changedPaths: new Set<string>(),
    artifactIds: new Set<string>(),
  };
}

export function applyEventToTraceSummary(
  accumulator: AgentQueryTraceSummaryAccumulator,
  event: AgentQueryEventRecord,
): void {
  const payload = parseTracePayloadObject(event.payload_json);
  const category = traceEventCategory(
    event.event_type,
    event.event_name,
    payload,
  );
  const eventName = event.event_name.toLowerCase();

  if (
    accumulator.firstToolAt == null &&
    isTraceToolActivityEvent(category, event.event_type, eventName, payload)
  ) {
    accumulator.firstToolAt = event.started_at;
  }

  if (category === 'queue') {
    const payloadLatency = traceNumberValue(payload.queueLatencyMs);
    if (payloadLatency != null) accumulator.queueLatencyMs = payloadLatency;
  }

  if (category === 'tool' || event.event_type === 'command') {
    const id = traceEventIdentity(
      eventName,
      payload,
      String(event.event_index),
    );
    if (isTraceToolStartEvent(eventName)) {
      accumulator.toolIds.add(id);
    }
    if (isTraceToolFailureEvent(eventName, event.status)) {
      accumulator.failedToolIds.add(id);
      accumulator.toolIds.add(id);
    }
  } else if (
    traceEventHasToolIdentity(payload) &&
    isTraceToolFailureEvent(eventName, event.status)
  ) {
    const id = traceEventIdentity(
      eventName,
      payload,
      String(event.event_index),
    );
    accumulator.failedToolIds.add(id);
    accumulator.toolIds.add(id);
  }

  if (category === 'file' && isAppliedTraceFileChangeEvent(eventName, event.status, payload)) {
    const path =
      tracePayloadString(payload, 'path') ||
      tracePayloadString(payload, 'resourceRef');
    if (path) accumulator.changedPaths.add(path);
  }

  if (category === 'artifact') {
    accumulator.artifactIds.add(
      traceEventIdentity(eventName, payload, String(event.event_index)),
    );
  }
}

export function finalizeTraceSummary(
  accumulator: AgentQueryTraceSummaryAccumulator,
): AgentQueryDerivedTraceSummary {
  return {
    queue_latency_ms: accumulator.queueLatencyMs,
    tool_call_count: accumulator.toolIds.size,
    failed_tool_call_count: accumulator.failedToolIds.size,
    changed_file_count: accumulator.changedPaths.size,
    artifact_count: accumulator.artifactIds.size,
    first_tool_at: accumulator.firstToolAt,
  };
}

export function summarizeAgentQueryEvents(
  events: AgentQueryEventRecord[],
  firstToolAt: string | null = null,
): AgentQueryDerivedTraceSummary {
  const accumulator = createTraceSummaryAccumulator(firstToolAt);
  for (const event of events) {
    applyEventToTraceSummary(accumulator, event);
  }
  return finalizeTraceSummary(accumulator);
}
