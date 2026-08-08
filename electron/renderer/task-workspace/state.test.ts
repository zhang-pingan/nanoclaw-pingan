import { describe, expect, it } from 'vitest';

import {
  chooseExecution,
  createTaskWorkspaceState,
  mergeTimelineEntries,
  timelineCursor,
  visibleSessions,
  type RuntimeDetail,
  type TaskSession,
  type TimelineEntry,
} from './state.js';

function entry(
  id: string,
  sequence: number,
  occurredAt: number,
  source = 'run:1',
): TimelineEntry {
  return {
    entry_id: id,
    session_id: 'session:1',
    session_seq: sequence,
    kind: 'workflow_progress',
    source_kind: 'runtime',
    source_id: source,
    source_event_seq: sequence,
    payload_json: {},
    occurred_at_ms: occurredAt,
    created_at_ms: occurredAt,
  };
}

function session(
  id: string,
  status: TaskSession['status'],
  attention: TaskSession['attention_state'],
  updatedAt: number,
): TaskSession {
  return {
    session_id: id,
    title: `Task ${id}`,
    status,
    attention_state: attention,
    current_run_selection: { kind: 'temporary_workflow' },
    updated_at_ms: updatedAt,
    row_version: 1,
  };
}

describe('Task Workspace renderer state', () => {
  it('keeps Runtime out of the primary conversation until requested', () => {
    expect(createTaskWorkspaceState().inspectorCollapsed).toBe(true);
  });

  it('deduplicates cursor pages while displaying stable occurrence order', () => {
    const merged = mergeTimelineEntries(
      [entry('late', 1, 200)],
      [entry('early', 2, 100), entry('late', 1, 200)],
    );

    expect(merged.map((item) => item.entry_id)).toEqual(['early', 'late']);
    expect(timelineCursor(merged)).toBe(2);
  });

  it('separates waiting sessions from active sessions', () => {
    const sessions = [
      session('active', 'open', 'none', 10),
      session('waiting', 'open', 'waiting_user', 20),
      session('failed', 'open', 'failed', 30),
      session('done', 'completed', 'none', 40),
    ];

    expect(
      visibleSessions(sessions, 'active', '').map((item) => item.session_id),
    ).toEqual(['failed', 'active']);
    expect(
      visibleSessions(sessions, 'waiting', '').map((item) => item.session_id),
    ).toEqual(['waiting']);
    expect(visibleSessions(sessions, 'completed', 'done')).toHaveLength(1);
  });

  it('keeps a selected execution when Runtime Detail refreshes', () => {
    const detail: RuntimeDetail = {
      format: 'icarus.workspace-runtime-detail/1',
      freshness: 'ready',
      workflows: [
        {
          workflow_id: 'workflow:1',
          current_graph_run_id: 'run:2',
          runs: [{ id: 'run:2' }, { id: 'run:1' }],
        },
      ],
    };

    expect(chooseExecution(detail, 'workflow:1', 'run:1')).toEqual({
      workflowId: 'workflow:1',
      runId: 'run:1',
    });
    expect(chooseExecution(detail)).toEqual({
      workflowId: 'workflow:1',
      runId: 'run:2',
    });
  });
});
