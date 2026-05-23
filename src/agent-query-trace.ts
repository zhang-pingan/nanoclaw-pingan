import crypto from 'crypto';

import {
  createAgentQuery,
  createAgentQueryEvent,
  createAgentQueryStep,
  deleteAgentQuery,
  getAgentQuery,
  listAgentQueries,
  listAgentQueryEvents,
  listAgentQuerySteps,
  updateAgentQuery,
  updateAgentQueryStep,
} from './db.js';
import {
  AgentQueryTraceSummaryAccumulator,
  applyEventToTraceSummary,
  createTraceSummaryAccumulator,
  finalizeTraceSummary,
  summarizeAgentQueryEvents,
} from './agent-query-trace-summary.js';
import {
  ActiveAgentQueryTrace,
  AgentQueryEventRecord,
  AgentQueryRecord,
  AgentQuerySourceType,
  AgentQueryStatus,
  AgentQueryStepRecord,
} from './types.js';

interface LiveQueryState extends ActiveAgentQueryTrace {
  sourceType: AgentQuerySourceType;
  sourceRefId: string | null;
  delegationId: string | null;
  stepIndex: number;
  eventIndex: number;
}

interface StartQueryInput {
  queryId: string;
  runId?: string | null;
  sourceType: AgentQuerySourceType;
  sourceRefId?: string | null;
  chatJid?: string | null;
  groupFolder?: string | null;
  workflowType?: string | null;
  service?: string | null;
  role?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  workflowId?: string | null;
  stageKey?: string | null;
  delegationId?: string | null;
  sessionId?: string | null;
  selectedModel?: string | null;
  selectedModelReason?: string | null;
  promptSummary?: string | null;
  promptHash?: string | null;
}

interface StartStepInput {
  queryId: string;
  stepType: string;
  stepName: string;
  summary?: string | null;
  payload?: unknown;
}

interface AppendEventInput {
  queryId: string;
  stepId?: string | null;
  eventType: string;
  eventName: string;
  status?: string | null;
  summary?: string | null;
  payload?: unknown;
  startedAt?: string;
  endedAt?: string | null;
  latencyMs?: number | null;
}

type TraceEventSeverity = 'debug' | 'info' | 'warn' | 'error';
type TraceEventVisibility = 'summary' | 'detail' | 'debug';

interface AppendStructuredEventInput {
  queryId: string;
  stepId?: string | null;
  category: string;
  eventName: string;
  status?: string | null;
  severity?: TraceEventSeverity;
  summary?: string | null;
  resourceType?: string | null;
  resourceRef?: string | null;
  visibility?: TraceEventVisibility;
  redacted?: boolean;
  payload?: Record<string, unknown>;
  startedAt?: string;
  endedAt?: string | null;
  latencyMs?: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  return crypto.randomUUID();
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function isErrorTerminalStatus(status: AgentQueryStatus): boolean {
  return status === 'error' || status === 'timeout';
}

function hasErrorEvent(events: AgentQueryEventRecord[]): boolean {
  return events.some(
    (event) =>
      event.event_type === 'error' ||
      event.status === 'error' ||
      event.event_name === 'query_failed',
  );
}

export class AgentQueryTraceManager {
  private activeQueries = new Map<string, LiveQueryState>();
  private summaryAccumulators = new Map<
    string,
    AgentQueryTraceSummaryAccumulator
  >();
  private listeners: Array<() => void> = [];

  onChange(callback: () => void): void {
    this.listeners.push(callback);
  }

  private emitChange(): void {
    for (const callback of this.listeners) {
      try {
        callback();
      } catch {
        // ignore listener errors
      }
    }
  }

  startQuery(input: StartQueryInput): void {
    const startedAt = nowIso();
    const record: AgentQueryRecord = {
      id: input.queryId,
      query_id: input.queryId,
      run_id: input.runId ?? null,
      source_type: input.sourceType,
      source_ref_id: input.sourceRefId ?? null,
      chat_jid: input.chatJid ?? null,
      group_folder: input.groupFolder ?? null,
      workflow_type: input.workflowType ?? null,
      service: input.service ?? null,
      role: input.role ?? null,
      task_id: input.taskId ?? null,
      task_title: input.taskTitle ?? null,
      workflow_id: input.workflowId ?? null,
      stage_key: input.stageKey ?? null,
      delegation_id: input.delegationId ?? null,
      session_id: input.sessionId ?? null,
      selected_model: input.selectedModel ?? null,
      selected_model_reason: input.selectedModelReason ?? null,
      actual_model: null,
      prompt_hash: input.promptHash ?? null,
      memory_pack_hash: null,
      tools_hash: null,
      mounts_hash: null,
      status: 'running',
      current_step_id: null,
      current_phase: null,
      current_action: null,
      failure_type: null,
      failure_subtype: null,
      failure_origin: null,
      failure_retryable: null,
      error_message: null,
      output_digest: null,
      output_preview: null,
      first_output_at: null,
      first_tool_at: null,
      last_event_at: startedAt,
      queue_latency_ms: null,
      container_name: null,
      container_runtime: null,
      container_exit_code: null,
      container_timeout_ms: null,
      container_terminated_reason: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      estimated_cost: null,
      tool_call_count: null,
      failed_tool_call_count: null,
      changed_file_count: null,
      artifact_count: null,
      artifact_contract_status: null,
      retry_attempt: null,
      retry_of_query_id: null,
      started_at: startedAt,
      ended_at: null,
      latency_ms: null,
      created_at: startedAt,
      updated_at: startedAt,
    };
    createAgentQuery(record);
    this.summaryAccumulators.set(
      input.queryId,
      createTraceSummaryAccumulator(),
    );
    this.activeQueries.set(input.queryId, {
      queryId: input.queryId,
      runId: input.runId ?? null,
      groupJid: input.chatJid ?? null,
      groupFolder: input.groupFolder ?? null,
      workflowType: input.workflowType ?? null,
      service: input.service ?? null,
      role: input.role ?? null,
      workflowId: input.workflowId ?? null,
      stageKey: input.stageKey ?? null,
      sessionId: input.sessionId ?? null,
      selectedModel: input.selectedModel ?? null,
      actualModel: null,
      status: 'running',
      currentStepId: null,
      currentStepType: null,
      currentStepName: null,
      currentPhase: null,
      currentAction: null,
      promptSummary: input.promptSummary ?? null,
      startedAt,
      firstOutputAt: null,
      lastEventAt: startedAt,
      queueLatencyMs: null,
      containerName: null,
      containerRuntime: null,
      containerExitCode: null,
      containerTerminatedReason: null,
      toolCallCount: null,
      failedToolCallCount: null,
      changedFileCount: null,
      artifactCount: null,
      artifactContractStatus: null,
      recentEvents: [],
      sourceType: input.sourceType,
      sourceRefId: input.sourceRefId ?? null,
      delegationId: input.delegationId ?? null,
      stepIndex: 0,
      eventIndex: 0,
    });
    this.appendEvent({
      queryId: input.queryId,
      eventType: 'lifecycle',
      eventName: 'query_started',
      status: 'success',
      summary: 'Query started',
      payload: {
        category: 'lifecycle',
        severity: 'info',
        visibility: 'summary',
        sourceType: input.sourceType,
        sourceRefId: input.sourceRefId ?? null,
      },
    });
  }

  deleteQuery(queryId: string): void {
    this.activeQueries.delete(queryId);
    this.summaryAccumulators.delete(queryId);
    deleteAgentQuery(queryId);
    this.emitChange();
  }

  startStep(input: StartStepInput): string {
    const query = this.activeQueries.get(input.queryId);
    if (!query) throw new Error(`Query ${input.queryId} is not active`);
    const now = nowIso();
    const stepId = makeId();
    query.stepIndex += 1;
    const record: AgentQueryStepRecord = {
      id: stepId,
      query_id: input.queryId,
      step_index: query.stepIndex,
      step_type: input.stepType,
      step_name: input.stepName,
      status: 'running',
      summary: input.summary ?? null,
      payload_json: toJson(input.payload),
      started_at: now,
      ended_at: null,
      latency_ms: null,
      created_at: now,
      updated_at: now,
    };
    createAgentQueryStep(record);
    query.currentStepId = stepId;
    query.currentStepType = input.stepType;
    query.currentStepName = input.stepName;
    query.currentAction = input.summary ?? query.currentAction;
    query.lastEventAt = now;
    updateAgentQuery(input.queryId, {
      current_step_id: stepId,
      current_action: query.currentAction,
      last_event_at: now,
    });
    this.emitChange();
    return stepId;
  }

  completeStep(
    queryId: string,
    stepId: string,
    status: AgentQueryStatus = 'success',
    summary?: string | null,
  ): void {
    const query = this.activeQueries.get(queryId);
    const endedAt = nowIso();
    const step = listAgentQuerySteps(queryId).find((item) => item.id === stepId);
    if (!step) return;
    const latencyMs = Date.parse(endedAt) - Date.parse(step.started_at);
    updateAgentQueryStep(stepId, {
      status,
      summary: summary ?? step.summary,
      ended_at: endedAt,
      latency_ms: latencyMs,
      updated_at: endedAt,
    });
    if (query?.currentStepId === stepId) {
      query.currentStepId = null;
      query.currentStepType = null;
      query.currentStepName = null;
      query.lastEventAt = endedAt;
      updateAgentQuery(queryId, {
        current_step_id: null,
        last_event_at: endedAt,
      });
      this.emitChange();
    }
  }

  appendStructuredEvent(input: AppendStructuredEventInput): AgentQueryEventRecord {
    const payload = {
      ...(input.payload ?? {}),
      category: input.category,
      severity:
        input.severity ?? (input.status === 'error' ? 'error' : 'info'),
      resourceType: input.resourceType ?? undefined,
      resourceRef: input.resourceRef ?? undefined,
      visibility: input.visibility ?? 'summary',
      redacted: input.redacted,
    };

    return this.appendEvent({
      queryId: input.queryId,
      stepId: input.stepId,
      eventType: input.category,
      eventName: input.eventName,
      status: input.status,
      summary: input.summary,
      payload,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      latencyMs: input.latencyMs,
    });
  }

  appendEvent(input: AppendEventInput): AgentQueryEventRecord {
    const query = this.activeQueries.get(input.queryId);
    if (!query) throw new Error(`Query ${input.queryId} is not active`);
    const startedAt = input.startedAt ?? nowIso();
    query.eventIndex += 1;
    const record: AgentQueryEventRecord = {
      id: makeId(),
      query_id: input.queryId,
      step_id: input.stepId ?? query.currentStepId ?? null,
      event_index: query.eventIndex,
      event_type: input.eventType,
      event_name: input.eventName,
      status: input.status ?? null,
      summary: input.summary ?? null,
      payload_json: toJson(input.payload),
      started_at: startedAt,
      ended_at: input.endedAt ?? null,
      latency_ms: input.latencyMs ?? null,
      created_at: startedAt,
    };
    createAgentQueryEvent(record);
    query.lastEventAt = startedAt;
    query.recentEvents = [...query.recentEvents, record].slice(-25);

    if (input.eventType === 'phase') {
      query.currentPhase = input.eventName.replace(/^phase_/, '');
    }
    if (input.summary) {
      query.currentAction = input.summary;
    }
    if (input.eventType === 'output' && !query.firstOutputAt) {
      query.firstOutputAt = startedAt;
    }
    const accumulator = this.summaryAccumulators.get(input.queryId);
    let derivedSummary;
    if (accumulator) {
      applyEventToTraceSummary(accumulator, record);
      derivedSummary = finalizeTraceSummary(accumulator);
    } else {
      derivedSummary = summarizeAgentQueryEvents(
        listAgentQueryEvents(input.queryId),
      );
    }
    updateAgentQuery(input.queryId, {
      current_phase: query.currentPhase,
      current_action: query.currentAction,
      first_output_at: query.firstOutputAt,
      last_event_at: startedAt,
      ...derivedSummary,
    });
    query.queueLatencyMs = derivedSummary.queue_latency_ms;
    query.toolCallCount = derivedSummary.tool_call_count;
    query.failedToolCallCount = derivedSummary.failed_tool_call_count;
    query.changedFileCount = derivedSummary.changed_file_count;
    query.artifactCount = derivedSummary.artifact_count;
    this.emitChange();
    return record;
  }

  updateQuery(queryId: string, patch: Partial<AgentQueryRecord>): void {
    const query = this.activeQueries.get(queryId);
    if (query) {
      if (patch.run_id !== undefined) query.runId = patch.run_id;
      if (patch.workflow_type !== undefined) query.workflowType = patch.workflow_type;
      if (patch.service !== undefined) query.service = patch.service;
      if (patch.role !== undefined) query.role = patch.role;
      if (patch.session_id !== undefined) query.sessionId = patch.session_id;
      if (patch.selected_model !== undefined) query.selectedModel = patch.selected_model;
      if (patch.actual_model !== undefined) query.actualModel = patch.actual_model;
      if (patch.current_phase !== undefined) query.currentPhase = patch.current_phase;
      if (patch.current_action !== undefined) query.currentAction = patch.current_action;
      if (patch.status !== undefined) query.status = patch.status;
      if (patch.first_output_at !== undefined) query.firstOutputAt = patch.first_output_at;
      if (patch.last_event_at !== undefined && patch.last_event_at) query.lastEventAt = patch.last_event_at;
      if (patch.queue_latency_ms !== undefined) query.queueLatencyMs = patch.queue_latency_ms;
      if (patch.container_name !== undefined) query.containerName = patch.container_name;
      if (patch.container_runtime !== undefined) query.containerRuntime = patch.container_runtime;
      if (patch.container_exit_code !== undefined) query.containerExitCode = patch.container_exit_code;
      if (patch.container_terminated_reason !== undefined) {
        query.containerTerminatedReason = patch.container_terminated_reason;
      }
      if (patch.tool_call_count !== undefined) query.toolCallCount = patch.tool_call_count;
      if (patch.failed_tool_call_count !== undefined) query.failedToolCallCount = patch.failed_tool_call_count;
      if (patch.changed_file_count !== undefined) query.changedFileCount = patch.changed_file_count;
      if (patch.artifact_count !== undefined) query.artifactCount = patch.artifact_count;
      if (patch.artifact_contract_status !== undefined) {
        query.artifactContractStatus = patch.artifact_contract_status;
      }
    }
    updateAgentQuery(queryId, patch);
    this.emitChange();
  }

  finishQuery(
    queryId: string,
    status: AgentQueryStatus,
    patch?: Partial<AgentQueryRecord>,
  ): void {
    const query = this.activeQueries.get(queryId);
    const endedAt = nowIso();
    if (!query) {
      this.appendTerminalErrorEventIfMissing(queryId, status, patch, endedAt);
      updateAgentQuery(queryId, {
        status,
        ended_at: endedAt,
        updated_at: endedAt,
        ...(patch || {}),
      });
      return;
    }
    const latencyMs = Date.parse(endedAt) - Date.parse(query.startedAt);
    this.appendTerminalErrorEventIfMissing(
      queryId,
      status,
      patch,
      endedAt,
      query,
    );
    updateAgentQuery(queryId, {
      status,
      ended_at: endedAt,
      latency_ms: latencyMs,
      last_event_at: endedAt,
      updated_at: endedAt,
      current_step_id: null,
      ...(patch || {}),
    });
    this.activeQueries.delete(queryId);
    this.summaryAccumulators.delete(queryId);
    this.emitChange();
  }

  private appendTerminalErrorEventIfMissing(
    queryId: string,
    status: AgentQueryStatus,
    patch: Partial<AgentQueryRecord> | undefined,
    endedAt: string,
    query?: LiveQueryState,
  ): void {
    if (!isErrorTerminalStatus(status)) return;

    const events = listAgentQueryEvents(queryId);
    if (hasErrorEvent(events)) return;

    const record = getAgentQuery(queryId);
    const lastEventIndex = events.reduce(
      (max, event) => Math.max(max, event.event_index),
      query?.eventIndex ?? 0,
    );
    const errorMessage =
      patch?.error_message ||
      record?.error_message ||
      patch?.output_preview ||
      `Query finished with ${status}`;

    const event: AgentQueryEventRecord = {
      id: makeId(),
      query_id: queryId,
      step_id: query?.currentStepId ?? record?.current_step_id ?? null,
      event_index: lastEventIndex + 1,
      event_type: 'error',
      event_name: status === 'timeout' ? 'query_timeout' : 'query_failed',
      status: 'error',
      summary: errorMessage,
      payload_json: toJson({
        category: 'error',
        severity: 'error',
        visibility: 'summary',
        error: errorMessage,
        terminalStatus: status,
        failureType: patch?.failure_type ?? record?.failure_type ?? null,
        failureSubtype: patch?.failure_subtype ?? record?.failure_subtype ?? null,
        failureOrigin: patch?.failure_origin ?? record?.failure_origin ?? null,
        failureRetryable:
          patch?.failure_retryable ?? record?.failure_retryable ?? null,
      }),
      started_at: endedAt,
      ended_at: endedAt,
      latency_ms: null,
      created_at: endedAt,
    };
    createAgentQueryEvent(event);

    if (query) {
      query.eventIndex = event.event_index;
      query.lastEventAt = endedAt;
      query.recentEvents = [...query.recentEvents, event].slice(-25);
      query.currentAction = errorMessage;
    }
  }

  getActiveQueries(): ActiveAgentQueryTrace[] {
    return Array.from(this.activeQueries.values())
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map((query) => ({ ...query, recentEvents: [...query.recentEvents] }));
  }

  getQuery(queryId: string): AgentQueryRecord | undefined {
    return getAgentQuery(queryId);
  }

  getQuerySteps(queryId: string): AgentQueryStepRecord[] {
    return listAgentQuerySteps(queryId);
  }

  getQueryEvents(queryId: string): AgentQueryEventRecord[] {
    return listAgentQueryEvents(queryId);
  }

  listQueries(limit?: number, offset?: number): AgentQueryRecord[] {
    return listAgentQueries(limit, offset);
  }
}

export const agentQueryTraceManager = new AgentQueryTraceManager();
