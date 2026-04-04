export interface WorkbenchRealtimeEvent {
  type:
    | 'task_created'
    | 'task_updated'
    | 'subtask_updated'
    | 'event_created'
    | 'artifact_created'
    | 'approval_updated'
    | 'comment_created'
    | 'asset_created';
  taskId: string;
  workflowId: string;
  payload: Record<string, unknown>;
}

type WorkbenchEventBroadcaster = (event: WorkbenchRealtimeEvent) => void;

let broadcaster: WorkbenchEventBroadcaster | null = null;

export function initWorkbenchEvents(nextBroadcaster: WorkbenchEventBroadcaster): void {
  broadcaster = nextBroadcaster;
}

export function emitWorkbenchEvent(event: WorkbenchRealtimeEvent): void {
  broadcaster?.(event);
}
