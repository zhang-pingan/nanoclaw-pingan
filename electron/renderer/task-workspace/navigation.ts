export interface RuntimeCenterRunLink {
  readonly format: 'icarus.runtime-link/1';
  readonly target: 'run';
  readonly workflow_id: string;
  readonly run_id: string;
}

export interface TaskWorkspaceSessionLink {
  readonly format: 'icarus.task-workspace-link/1';
  readonly target: 'session';
  readonly session_id: string;
}

export function runtimeCenterRunLink(
  workflowId: string,
  runId: string,
): RuntimeCenterRunLink | null {
  const workflow_id = workflowId.trim();
  const run_id = runId.trim();
  return workflow_id && run_id
    ? {
        format: 'icarus.runtime-link/1',
        target: 'run',
        workflow_id,
        run_id,
      }
    : null;
}

export function taskWorkspaceSessionLink(
  sessionId: string,
): TaskWorkspaceSessionLink | null {
  const session_id = sessionId.trim();
  return session_id
    ? {
        format: 'icarus.task-workspace-link/1',
        target: 'session',
        session_id,
      }
    : null;
}

export function isTaskWorkspaceSessionLink(
  value: unknown,
): value is TaskWorkspaceSessionLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  return (
    Object.keys(link).sort().join(',') === 'format,session_id,target' &&
    link.format === 'icarus.task-workspace-link/1' &&
    link.target === 'session' &&
    typeof link.session_id === 'string' &&
    link.session_id.trim().length > 0
  );
}

export function isRuntimeCenterRunLink(
  value: unknown,
): value is RuntimeCenterRunLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  return (
    Object.keys(link).sort().join(',') === 'format,run_id,target,workflow_id' &&
    link.format === 'icarus.runtime-link/1' &&
    link.target === 'run' &&
    typeof link.workflow_id === 'string' &&
    link.workflow_id.trim().length > 0 &&
    typeof link.run_id === 'string' &&
    link.run_id.trim().length > 0
  );
}

export function taskWorkspaceLinkHref(link: TaskWorkspaceSessionLink): string {
  return `/tasks?session_id=${encodeURIComponent(link.session_id)}`;
}

export function runtimeCenterLinkHref(link: RuntimeCenterRunLink): string {
  const query = new URLSearchParams({
    assistantTarget: 'trace-monitor',
    runtime_target: link.target,
    workflow_id: link.workflow_id,
    run_id: link.run_id,
  });
  return `/?${query.toString()}`;
}
