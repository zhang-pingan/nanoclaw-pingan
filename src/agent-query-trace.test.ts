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
});
