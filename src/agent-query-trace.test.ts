import { beforeEach, describe, expect, it } from 'vitest';

import { agentQueryTraceManager } from './agent-query-trace.js';
import { _initTestDatabase, getAgentQuery } from './db.js';
import { buildAgentQueryTraceDetail } from './agent-query-trace-detail.js';

describe('agent query trace manager', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('adds an error event when a query finishes with error without one', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-error-without-event',
      sourceType: 'assistant_evolution',
      sourceRefId: 'evo-test',
    });

    agentQueryTraceManager.finishQuery('trace-error-without-event', 'error', {
      error_message: 'One-shot agent completed without output',
    });

    const events = agentQueryTraceManager.getQueryEvents(
      'trace-error-without-event',
    );
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      event_type: 'error',
      event_name: 'query_failed',
      status: 'error',
      summary: 'One-shot agent completed without output',
    });
    expect(JSON.parse(events[1].payload_json || '{}')).toMatchObject({
      error: 'One-shot agent completed without output',
      terminalStatus: 'error',
    });
  });

  it('does not duplicate an existing error event on failure finish', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-error-with-event',
      sourceType: 'assistant_evolution',
      sourceRefId: 'evo-test',
    });
    agentQueryTraceManager.appendEvent({
      queryId: 'trace-error-with-event',
      eventType: 'error',
      eventName: 'query_failed',
      status: 'error',
      summary: 'Agent execution failed',
    });

    agentQueryTraceManager.finishQuery('trace-error-with-event', 'error', {
      error_message: 'Agent execution failed',
    });

    const errorEvents = agentQueryTraceManager
      .getQueryEvents('trace-error-with-event')
      .filter((event) => event.event_type === 'error');
    expect(errorEvents).toHaveLength(1);
  });

  it('stores structured event metadata and derives trace detail summary', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-structured-events',
      sourceType: 'message',
      sourceRefId: 'msg-1',
      workflowType: 'bugfix',
      service: 'catstory',
      role: 'developer',
    });

    const stepId = agentQueryTraceManager.startStep({
      queryId: 'trace-structured-events',
      stepType: 'agent_execution',
      stepName: 'run_agent',
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-structured-events',
      stepId,
      category: 'container',
      eventName: 'container_spawned',
      status: 'running',
      summary: 'Container spawned',
      payload: {
        containerName: 'icarus-main-1',
        runtime: 'docker',
        image: 'icarus-agent',
      },
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-structured-events',
      stepId,
      category: 'tool',
      eventName: 'tool_started',
      status: 'running',
      payload: { toolName: 'Bash', toolType: 'command' },
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-structured-events',
      stepId,
      category: 'file',
      eventName: 'file_edit',
      status: 'success',
      resourceType: 'file',
      resourceRef: 'src/workflow.ts',
      payload: {
        path: 'src/workflow.ts',
        operation: 'edit',
        additions: 2,
        deletions: 1,
      },
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-structured-events',
      stepId,
      category: 'model',
      eventName: 'model_response_completed',
      status: 'success',
      payload: {
        actualModel: 'claude-test',
        inputTokens: 10,
        outputTokens: 3,
        latencyMs: 25,
      },
    });

    const events = agentQueryTraceManager.getQueryEvents(
      'trace-structured-events',
    );
    expect(JSON.parse(events[1].payload_json || '{}')).toMatchObject({
      category: 'container',
      severity: 'info',
      visibility: 'summary',
      containerName: 'icarus-main-1',
    });

    const detail = buildAgentQueryTraceDetail('trace-structured-events');
    expect(detail?.query.workflow_type).toBe('bugfix');
    expect(detail?.summary.toolCallCount).toBe(1);
    expect(detail?.summary.changedFileCount).toBe(1);
    expect(detail?.summary.modelCallCount).toBe(1);
    expect(detail?.highlights.containers).toHaveLength(1);
    expect(detail?.highlights.files).toHaveLength(1);
  });

  it('deduplicates tool/file lifecycle events and backfills query counters on append', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-dedup-counts',
      sourceType: 'message',
      sourceRefId: 'msg-dedup',
    });

    for (const eventName of ['tool_started', 'tool_completed']) {
      agentQueryTraceManager.appendStructuredEvent({
        queryId: 'trace-dedup-counts',
        category: 'tool',
        eventName,
        status: eventName === 'tool_started' ? 'running' : 'success',
        payload: {
          toolName: 'Bash',
          toolType: 'command',
          toolUseId: 'tool-1',
        },
      });
    }
    for (const eventName of ['command_started', 'command_finished']) {
      agentQueryTraceManager.appendEvent({
        queryId: 'trace-dedup-counts',
        eventType: 'command',
        eventName,
        status: eventName === 'command_started' ? 'running' : 'success',
        payload: {
          category: 'tool',
          toolName: 'Bash',
          toolType: 'command',
          toolUseId: 'tool-1',
        },
      });
    }
    for (const eventName of ['file_edit', 'file_edit_complete']) {
      agentQueryTraceManager.appendStructuredEvent({
        queryId: 'trace-dedup-counts',
        category: 'file',
        eventName,
        status: eventName === 'file_edit' ? 'running' : 'success',
        payload: {
          toolUseId: 'tool-2',
          path: 'src/example.ts',
          operation: 'edit',
        },
      });
    }

    const query = getAgentQuery('trace-dedup-counts');
    expect(query?.tool_call_count).toBe(1);
    expect(query?.changed_file_count).toBe(1);

    const detail = buildAgentQueryTraceDetail('trace-dedup-counts');
    expect(detail?.summary.toolCallCount).toBe(1);
    expect(detail?.summary.fileWriteCount).toBe(1);
    expect(detail?.summary.changedFileCount).toBe(1);
  });

  it('counts only applied file changes and records first tool activity across categories', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-applied-file-change',
      sourceType: 'message',
      sourceRefId: 'msg-file-change',
    });

    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-applied-file-change',
      category: 'file',
      eventName: 'file_edit',
      status: 'running',
      payload: {
        toolUseId: 'edit-1',
        path: 'src/risky.ts',
        operation: 'edit',
      },
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-applied-file-change',
      category: 'file',
      eventName: 'tool_failed',
      status: 'error',
      payload: {
        toolUseId: 'edit-1',
        path: 'src/risky.ts',
        operation: 'edit',
        error: 'Permission denied',
      },
    });

    let query = getAgentQuery('trace-applied-file-change');
    expect(query?.changed_file_count).toBe(0);
    expect(query?.failed_tool_call_count).toBe(1);
    expect(query?.first_tool_at).toBeTruthy();

    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-applied-file-change',
      category: 'file',
      eventName: 'file_edit_complete',
      status: 'success',
      payload: {
        toolUseId: 'edit-2',
        path: 'src/applied.ts',
        operation: 'edit',
      },
    });

    query = getAgentQuery('trace-applied-file-change');
    expect(query?.changed_file_count).toBe(1);
    const detail = buildAgentQueryTraceDetail('trace-applied-file-change');
    expect(detail?.summary.changedFileCount).toBe(1);
    expect(detail?.summary.failedToolCallCount).toBe(1);
    expect(detail?.summary.firstToolDelayMs).not.toBeNull();
  });

  it('overwrites stale query counters when detail is built', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-stale-counters',
      sourceType: 'message',
      sourceRefId: 'msg-stale',
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-stale-counters',
      category: 'file',
      eventName: 'file_write_complete',
      status: 'success',
      payload: {
        toolUseId: 'write-1',
        path: 'src/generated.ts',
        operation: 'write',
      },
    });
    agentQueryTraceManager.updateQuery('trace-stale-counters', {
      tool_call_count: 0,
      changed_file_count: 0,
      artifact_count: 99,
      first_tool_at: null,
    });

    const detail = buildAgentQueryTraceDetail('trace-stale-counters');
    expect(detail?.summary.toolCallCount).toBe(0);
    expect(detail?.summary.changedFileCount).toBe(1);

    const query = getAgentQuery('trace-stale-counters');
    expect(query?.tool_call_count).toBe(0);
    expect(query?.changed_file_count).toBe(1);
    expect(query?.artifact_count).toBe(0);
    expect(query?.first_tool_at).toBeTruthy();
  });

  it('derives queue latency and highlights IPC events', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-queue-ipc',
      sourceType: 'message',
      sourceRefId: 'msg-queue',
    });

    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-queue-ipc',
      category: 'queue',
      eventName: 'queue_dequeued',
      status: 'success',
      payload: { queueName: 'one-shot-agent-slot', queueLatencyMs: 42 },
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-queue-ipc',
      category: 'ipc',
      eventName: 'ipc_request_completed',
      status: 'success',
      payload: {
        operation: 'mcp__icarus__send_message',
        toolName: 'mcp__icarus__send_message',
        toolUseId: 'ipc-1',
      },
    });

    expect(getAgentQuery('trace-queue-ipc')?.queue_latency_ms).toBe(42);
    const detail = buildAgentQueryTraceDetail('trace-queue-ipc');
    expect(detail?.summary.queueLatencyMs).toBe(42);
    expect(detail?.summary.ipcCallCount).toBe(1);
    expect(detail?.highlights.ipc).toHaveLength(1);
  });

  it('keeps selected model separate from proxy-confirmed actual model', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-actual-model',
      sourceType: 'message',
      sourceRefId: 'msg-actual-model',
      selectedModel: 'claude-select-output',
    });

    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-actual-model',
      category: 'model',
      eventName: 'model_resolution',
      status: 'success',
      payload: {
        provider: 'anthropic',
        requestedModel: 'claude-select-output',
        actualModel: 'claude-select-output',
      },
    });

    expect(getAgentQuery('trace-actual-model')?.actual_model).toBeNull();

    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'trace-actual-model',
      category: 'model',
      eventName: 'model_response_completed',
      status: 'success',
      payload: {
        traceSource: 'credential_proxy',
        provider: 'anthropic',
        requestedModel: 'claude-select-output',
        actualModel: 'claude-proxy-final',
      },
    });
    agentQueryTraceManager.updateQuery('trace-actual-model', {
      actual_model: 'claude-proxy-final',
    });

    const query = getAgentQuery('trace-actual-model');
    expect(query?.selected_model).toBe('claude-select-output');
    expect(query?.actual_model).toBe('claude-proxy-final');
  });

  it('accumulates model usage across requests and deduplicates request ids', () => {
    agentQueryTraceManager.startQuery({
      queryId: 'trace-model-usage-aggregate',
      sourceType: 'message',
      sourceRefId: 'msg-usage',
      selectedModel: 'claude-sonnet-4-6',
    });

    expect(
      agentQueryTraceManager.accumulateModelUsage({
        queryId: 'trace-model-usage-aggregate',
        requestId: 'model-req-1',
        requestedModel: 'claude-sonnet-4-6',
        actualModel: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        latencyMs: 50,
      }),
    ).toBe(true);
    expect(
      agentQueryTraceManager.accumulateModelUsage({
        queryId: 'trace-model-usage-aggregate',
        requestId: 'model-req-2',
        requestedModel: 'claude-sonnet-4-6',
        actualModel: 'claude-sonnet-4-6',
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 11,
        cacheWriteTokens: 13,
        latencyMs: 25,
      }),
    ).toBe(true);
    expect(
      agentQueryTraceManager.accumulateModelUsage({
        queryId: 'trace-model-usage-aggregate',
        requestId: 'model-req-2',
        requestedModel: 'claude-sonnet-4-6',
        actualModel: 'claude-sonnet-4-6',
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 11,
        cacheWriteTokens: 13,
        latencyMs: 25,
      }),
    ).toBe(false);

    const query = getAgentQuery('trace-model-usage-aggregate');
    expect(query?.input_tokens).toBe(107);
    expect(query?.output_tokens).toBe(23);
    expect(query?.cache_read_tokens).toBe(41);
    expect(query?.cache_write_tokens).toBe(53);
    expect(query?.actual_model).toBe('claude-sonnet-4-6');

    const usageEvents = agentQueryTraceManager
      .getQueryEvents('trace-model-usage-aggregate')
      .filter((event) => event.event_name === 'model_usage_recorded');
    expect(usageEvents).toHaveLength(2);
    expect(JSON.parse(usageEvents[0].payload_json || '{}')).toMatchObject({
      requestId: 'model-req-1',
      inputTokens: 100,
      cacheWriteTokens: 40,
    });
  });
});
