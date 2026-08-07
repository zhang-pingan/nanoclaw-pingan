import { describe, expect, it } from 'vitest';

import {
  isRuntimeCenterRunLink,
  isTaskWorkspaceSessionLink,
  runtimeCenterLinkHref,
  runtimeCenterRunLink,
  taskWorkspaceLinkHref,
  taskWorkspaceSessionLink,
} from './navigation.js';

describe('Task Workspace typed navigation', () => {
  it('builds closed exact Runtime and TaskSession links', () => {
    const runtime = runtimeCenterRunLink(' workflow:test ', ' run:test ');
    expect(runtime).toEqual({
      format: 'icarus.runtime-link/1',
      target: 'run',
      workflow_id: 'workflow:test',
      run_id: 'run:test',
    });
    expect(runtimeCenterLinkHref(runtime!)).toBe(
      '/?assistantTarget=trace-monitor&runtime_target=run&workflow_id=workflow%3Atest&run_id=run%3Atest',
    );
    expect(isRuntimeCenterRunLink(runtime)).toBe(true);

    const workspace = taskWorkspaceSessionLink('session:test')!;
    expect(isTaskWorkspaceSessionLink(workspace)).toBe(true);
    expect(taskWorkspaceLinkHref(workspace)).toBe(
      '/tasks?session_id=session%3Atest',
    );
  });

  it('rejects missing identities and open link documents', () => {
    expect(runtimeCenterRunLink('', 'run:test')).toBeNull();
    expect(taskWorkspaceSessionLink('')).toBeNull();
    expect(
      isTaskWorkspaceSessionLink({
        format: 'icarus.task-workspace-link/1',
        target: 'session',
        session_id: 'session:test',
        workflow_id: 'workflow:forged',
      }),
    ).toBe(false);
    expect(
      isRuntimeCenterRunLink({
        format: 'icarus.runtime-link/1',
        target: 'run',
        workflow_id: 'workflow:test',
        run_id: 'run:test',
        session_id: 'session:forged',
      }),
    ).toBe(false);
  });
});
