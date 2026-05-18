import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerInput } from './container-runner.js';
import type { Delegation, RegisteredGroup, Workflow } from './types.js';

vi.mock('./container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runner.js')>(
    './container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    writeTasksSnapshot: vi.fn(),
  };
});

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-workflow-session-isolation',
  };
});

import { runContainerAgent } from './container-runner.js';
import {
  _initTestDatabase,
  createDelegation,
  createWorkflow,
  getAllSessions,
  setSession,
} from './db.js';
import { _runAgentForTest, _setSessionsForTest } from './index.js';

const group: RegisteredGroup = {
  name: 'Web Dev',
  folder: 'web_dev',
  trigger: '/nc',
  added_at: '2026-05-18T00:00:00.000Z',
};

function createWorkflowDelegation(): void {
  const workflow: Workflow = {
    id: 'wf-session-isolation',
    name: 'Session isolation',
    service: 'svc',
    start_from: 'dev',
    context: {},
    status: 'dev',
    current_delegation_id: 'del-session-isolation',
    round: 0,
    source_jid: 'main@g.us',
    paused_from: null,
    workflow_type: 'dev_test',
    created_at: '2026-05-18T00:00:00.000Z',
    updated_at: '2026-05-18T00:00:00.000Z',
  };
  const delegation: Delegation = {
    id: 'del-session-isolation',
    source_jid: 'main@g.us',
    source_folder: 'web_main',
    target_jid: 'dev@g.us',
    target_folder: 'web_dev',
    task: 'Implement',
    status: 'pending',
    result: null,
    outcome: null,
    requester_jid: null,
    workflow_id: workflow.id,
    created_at: '2026-05-18T00:00:00.000Z',
    updated_at: '2026-05-18T00:00:00.000Z',
  };

  createWorkflow(workflow);
  createDelegation(delegation);
}

describe('workflow delegation session isolation', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setSessionsForTest({});
    vi.mocked(runContainerAgent).mockReset();
  });

  it('does not resume or persist group sessions for isolated workflow delegation runs', async () => {
    setSession(group.folder, 'old-session');
    _setSessionsForTest({ [group.folder]: 'old-session' });
    createWorkflowDelegation();

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: null,
      newSessionId: 'delegation-session',
    });

    const status = await _runAgentForTest({
      group,
      executionContext: {
        workflowId: 'wf-session-isolation',
        stageKey: 'dev',
        delegationId: 'del-session-isolation',
      },
      isolatedSession: true,
    });

    expect(status).toBe('success');
    expect(vi.mocked(runContainerAgent).mock.calls[0][1]).toMatchObject({
      sessionId: undefined,
      isolatedSession: true,
    } satisfies Partial<ContainerInput>);
    expect(getAllSessions()[group.folder]).toBe('old-session');
  });

  it('keeps ordinary group chat session reuse and persistence unchanged', async () => {
    setSession(group.folder, 'old-session');
    _setSessionsForTest({ [group.folder]: 'old-session' });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: null,
      newSessionId: 'next-session',
    });

    const status = await _runAgentForTest({ group });

    expect(status).toBe('success');
    expect(vi.mocked(runContainerAgent).mock.calls[0][1]).toMatchObject({
      sessionId: 'old-session',
      isolatedSession: undefined,
    } satisfies Partial<ContainerInput>);
    expect(getAllSessions()[group.folder]).toBe('next-session');
  });
});
