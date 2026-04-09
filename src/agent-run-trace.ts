import crypto from 'crypto';

import {
  createAgentRun,
  createAgentRunEvent,
  createAgentRunStep,
  getAgentRun,
  listAgentRunEvents,
  listAgentRunSteps,
  listAgentRuns,
  updateAgentRun,
  updateAgentRunStep,
} from './db.js';
import {
  ActiveAgentRunTrace,
  AgentRunEventRecord,
  AgentRunRecord,
  AgentRunSourceType,
  AgentRunStatus,
  AgentRunStepRecord,
} from './types.js';

interface LiveRunState extends ActiveAgentRunTrace {
  sourceType: AgentRunSourceType;
  sourceRefId: string | null;
  delegationId: string | null;
  stepIndex: number;
  eventIndex: number;
}

interface StartRunInput {
  runId: string;
  queryId?: string | null;
  sourceType: AgentRunSourceType;
  sourceRefId?: string | null;
  chatJid?: string | null;
  groupFolder?: string | null;
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
  runId: string;
  stepType: string;
  stepName: string;
  summary?: string | null;
  payload?: unknown;
}

interface AppendEventInput {
  runId: string;
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

export class AgentRunTraceManager {
  private activeRuns = new Map<string, LiveRunState>();
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

  startRun(input: StartRunInput): void {
    const startedAt = nowIso();
    const record: AgentRunRecord = {
      id: input.runId,
      run_id: input.runId,
      query_id: input.queryId ?? null,
      source_type: input.sourceType,
      source_ref_id: input.sourceRefId ?? null,
      chat_jid: input.chatJid ?? null,
      group_folder: input.groupFolder ?? null,
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
      started_at: startedAt,
      ended_at: null,
      latency_ms: null,
      created_at: startedAt,
      updated_at: startedAt,
    };
    createAgentRun(record);
    this.activeRuns.set(input.runId, {
      runId: input.runId,
      queryId: input.queryId ?? null,
      groupJid: input.chatJid ?? null,
      groupFolder: input.groupFolder ?? null,
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
      recentEvents: [],
      sourceType: input.sourceType,
      sourceRefId: input.sourceRefId ?? null,
      delegationId: input.delegationId ?? null,
      stepIndex: 0,
      eventIndex: 0,
    });
    this.appendEvent({
      runId: input.runId,
      eventType: 'lifecycle',
      eventName: 'run_started',
      status: 'success',
      summary: 'Run started',
      payload: { sourceType: input.sourceType, sourceRefId: input.sourceRefId ?? null },
    });
  }

  startStep(input: StartStepInput): string {
    const run = this.activeRuns.get(input.runId);
    if (!run) throw new Error(`Run ${input.runId} is not active`);
    const now = nowIso();
    const stepId = makeId();
    run.stepIndex += 1;
    const record: AgentRunStepRecord = {
      id: stepId,
      run_id: input.runId,
      step_index: run.stepIndex,
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
    createAgentRunStep(record);
    run.currentStepId = stepId;
    run.currentStepType = input.stepType;
    run.currentStepName = input.stepName;
    run.currentAction = input.summary ?? run.currentAction;
    run.lastEventAt = now;
    updateAgentRun(input.runId, {
      current_step_id: stepId,
      current_action: run.currentAction,
      last_event_at: now,
    });
    this.emitChange();
    return stepId;
  }

  completeStep(
    runId: string,
    stepId: string,
    status: AgentRunStatus = 'success',
    summary?: string | null,
  ): void {
    const run = this.activeRuns.get(runId);
    const endedAt = nowIso();
    const step = listAgentRunSteps(runId).find((item) => item.id === stepId);
    if (!step) return;
    const latencyMs = Date.parse(endedAt) - Date.parse(step.started_at);
    updateAgentRunStep(stepId, {
      status,
      summary: summary ?? step.summary,
      ended_at: endedAt,
      latency_ms: latencyMs,
      updated_at: endedAt,
    });
    if (run?.currentStepId === stepId) {
      run.currentStepId = null;
      run.currentStepType = null;
      run.currentStepName = null;
      updateAgentRun(runId, {
        current_step_id: null,
        last_event_at: endedAt,
      });
      run.lastEventAt = endedAt;
      this.emitChange();
    }
  }

  appendEvent(input: AppendEventInput): AgentRunEventRecord {
    const run = this.activeRuns.get(input.runId);
    if (!run) throw new Error(`Run ${input.runId} is not active`);
    const startedAt = input.startedAt ?? nowIso();
    run.eventIndex += 1;
    const record: AgentRunEventRecord = {
      id: makeId(),
      run_id: input.runId,
      step_id: input.stepId ?? run.currentStepId ?? null,
      event_index: run.eventIndex,
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
    createAgentRunEvent(record);
    run.lastEventAt = startedAt;
    run.recentEvents = [...run.recentEvents, record].slice(-25);

    if (input.eventType === 'phase') {
      run.currentPhase = input.eventName.replace(/^phase_/, '');
    }
    if (input.summary) {
      run.currentAction = input.summary;
    }
    if (input.eventType === 'output' && !run.firstOutputAt) {
      run.firstOutputAt = startedAt;
    }

    updateAgentRun(input.runId, {
      current_phase: run.currentPhase,
      current_action: run.currentAction,
      first_output_at: run.firstOutputAt,
      last_event_at: startedAt,
    });
    this.emitChange();
    return record;
  }

  updateRun(runId: string, patch: Partial<AgentRunRecord>): void {
    const run = this.activeRuns.get(runId);
    if (run) {
      if (patch.query_id !== undefined) run.queryId = patch.query_id;
      if (patch.session_id !== undefined) run.sessionId = patch.session_id;
      if (patch.selected_model !== undefined) run.selectedModel = patch.selected_model;
      if (patch.actual_model !== undefined) run.actualModel = patch.actual_model;
      if (patch.current_phase !== undefined) run.currentPhase = patch.current_phase;
      if (patch.current_action !== undefined) run.currentAction = patch.current_action;
      if (patch.status !== undefined) run.status = patch.status;
      if (patch.first_output_at !== undefined) run.firstOutputAt = patch.first_output_at;
      if (patch.last_event_at !== undefined && patch.last_event_at) run.lastEventAt = patch.last_event_at;
    }
    updateAgentRun(runId, patch);
    this.emitChange();
  }

  finishRun(
    runId: string,
    status: AgentRunStatus,
    patch?: Partial<AgentRunRecord>,
  ): void {
    const run = this.activeRuns.get(runId);
    const endedAt = nowIso();
    if (!run) {
      updateAgentRun(runId, {
        status,
        ended_at: endedAt,
        updated_at: endedAt,
        ...(patch || {}),
      });
      return;
    }
    const latencyMs = Date.parse(endedAt) - Date.parse(run.startedAt);
    updateAgentRun(runId, {
      status,
      ended_at: endedAt,
      latency_ms: latencyMs,
      last_event_at: endedAt,
      updated_at: endedAt,
      current_step_id: null,
      ...(patch || {}),
    });
    this.activeRuns.delete(runId);
    this.emitChange();
  }

  getActiveRuns(): ActiveAgentRunTrace[] {
    return Array.from(this.activeRuns.values())
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map((run) => ({ ...run, recentEvents: [...run.recentEvents] }));
  }

  getRun(runId: string): AgentRunRecord | undefined {
    return getAgentRun(runId);
  }

  getRunSteps(runId: string): AgentRunStepRecord[] {
    return listAgentRunSteps(runId);
  }

  getRunEvents(runId: string): AgentRunEventRecord[] {
    return listAgentRunEvents(runId);
  }

  listRuns(limit?: number): AgentRunRecord[] {
    return listAgentRuns(limit);
  }
}

export const agentRunTraceManager = new AgentRunTraceManager();
