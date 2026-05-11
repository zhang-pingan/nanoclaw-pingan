import { beforeEach, describe, expect, it } from 'vitest';

import { agentQueryTraceManager } from './agent-query-trace.js';
import { _initTestDatabase } from './db.js';

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
});
