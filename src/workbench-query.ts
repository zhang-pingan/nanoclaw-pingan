import {
  getWorkbenchTaskDetail,
  listWorkbenchTasks,
} from './workbench.js';

export interface WorkbenchStatusQueryInput {
  task_id?: string;
  keyword?: string;
  /** Matches either workflow status/current stage or aggregated task_state. */
  status?: string;
  task_state?: 'running' | 'success' | 'failed' | 'cancelled';
  workflow_status?: string;
  include_terminal?: boolean;
  include_detail?: boolean;
  limit?: number;
}

export interface WorkbenchStatusQueryResult {
  query: {
    task_id?: string;
    keyword?: string;
    status?: string;
    task_state?: 'running' | 'success' | 'failed' | 'cancelled';
    workflow_status?: string;
    include_terminal: boolean;
    include_detail: boolean;
    limit: number;
  };
  matched_count: number;
  tasks: Array<{
    id: string;
    title: string;
    service: string;
    start_from: string;
    workflow_type: string;
    workflow_status: string;
    workflow_status_label: string;
    task_state: 'running' | 'success' | 'failed' | 'cancelled';
    workflow_stage: string;
    workflow_stage_label: string;
    pending_approval: boolean;
    pending_action_count: number;
    active_delegation_id: string;
    created_at: string;
    updated_at: string;
  }>;
  detail?: {
    task: WorkbenchStatusQueryResult['tasks'][number];
    subtasks: Array<{
      id: string;
      title: string;
      stage_key: string;
      stage_label: string;
      stage_type: string;
      status: string;
      role?: string;
      skill?: string;
      target_folder?: string;
      delegation_id?: string;
      updated_at?: string;
    }>;
    action_items: Array<{
      id: string;
      title: string;
      item_type: string;
      source_type: string;
      status: string;
      group_folder?: string;
      replyable: boolean;
      created_at?: string;
    }>;
    artifacts: Array<{
      id: string;
      title: string;
      artifact_type: string;
      path: string;
      exists: boolean;
      created_at?: string;
    }>;
    timeline: Array<{
      id: string;
      type: string;
      title: string;
      status?: string;
      created_at: string;
    }>;
    comments: Array<{
      id: string;
      author: string;
      content: string;
      created_at: string;
    }>;
    assets: Array<{
      id: string;
      title: string;
      asset_type: string;
      path: string | null;
      url: string | null;
      note: string | null;
      created_at: string;
    }>;
  };
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(20, Math.max(1, Math.trunc(limit as number)));
}

function toSummary(task: ReturnType<typeof listWorkbenchTasks>[number]) {
  return {
    id: task.id,
    title: task.title,
    service: task.service,
    start_from: task.start_from,
    workflow_type: task.workflow_type,
    workflow_status: task.workflow_status,
    workflow_status_label: task.workflow_status_label,
    task_state: task.task_state,
    workflow_stage: task.workflow_stage,
    workflow_stage_label: task.workflow_stage_label,
    pending_approval: task.pending_approval,
    pending_action_count: task.pending_action_count,
    active_delegation_id: task.active_delegation_id,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function includesInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function queryWorkbenchTaskStatuses(
  input: WorkbenchStatusQueryInput,
): WorkbenchStatusQueryResult {
  const limit = normalizeLimit(input.limit);
  const includeTerminal = input.include_terminal === true;
  const includeDetail = input.include_detail === true;
  const taskId = input.task_id?.trim();
  const keyword = input.keyword?.trim();
  const status = input.status?.trim().toLowerCase();
  const taskState = input.task_state?.trim().toLowerCase();
  const workflowStatus = input.workflow_status?.trim().toLowerCase();

  if (taskId) {
    const detail = getWorkbenchTaskDetail(taskId);
    if (!detail) {
      return {
        query: {
          task_id: taskId,
          keyword,
          status: input.status,
          task_state: input.task_state,
          workflow_status: input.workflow_status,
          include_terminal: includeTerminal,
          include_detail: true,
          limit,
        },
        matched_count: 0,
        tasks: [],
      };
    }

    return {
      query: {
        task_id: taskId,
        keyword,
        status: input.status,
        task_state: input.task_state,
        workflow_status: input.workflow_status,
        include_terminal: true,
        include_detail: true,
        limit: 1,
      },
      matched_count: 1,
      tasks: [toSummary(detail.task)],
      detail: {
        task: toSummary(detail.task),
        subtasks: detail.subtasks.map((item) => ({
          id: item.id,
          title: item.title,
          stage_key: item.stage_key,
          stage_label: item.stage_label,
          stage_type: item.stage_type,
          status: item.status,
          role: item.role,
          skill: item.skill,
          target_folder: item.target_folder,
          delegation_id: item.delegation_id,
          updated_at: item.updated_at,
        })),
        action_items: detail.action_items.map((item) => ({
          id: item.id,
          title: item.title,
          item_type: item.item_type,
          source_type: item.source_type,
          status: item.status,
          group_folder: item.group_folder,
          replyable: item.replyable,
          created_at: item.created_at,
        })),
        artifacts: detail.artifacts.map((item) => ({
          id: item.id,
          title: item.title,
          artifact_type: item.artifact_type,
          path: item.path,
          exists: item.exists,
          created_at: item.created_at,
        })),
        timeline: detail.timeline.slice(0, 10).map((item) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          status: item.status,
          created_at: item.created_at,
        })),
        comments: detail.comments.slice(0, 5),
        assets: detail.assets.slice(0, 5),
      },
    };
  }

  let tasks = listWorkbenchTasks();
  if (!includeTerminal) {
    tasks = tasks.filter((item) => item.task_state === 'running');
  }
  if (status) {
    tasks = tasks.filter(
      (item) =>
        item.workflow_status.toLowerCase() === status ||
        item.workflow_stage.toLowerCase() === status ||
        item.task_state.toLowerCase() === status,
    );
  }
  if (taskState) {
    tasks = tasks.filter((item) => item.task_state.toLowerCase() === taskState);
  }
  if (workflowStatus) {
    tasks = tasks.filter(
      (item) =>
        item.workflow_status.toLowerCase() === workflowStatus ||
        item.workflow_stage.toLowerCase() === workflowStatus,
    );
  }
  if (keyword) {
    tasks = tasks.filter((item) =>
      [
        item.id,
        item.title,
        item.service,
        item.start_from,
        item.workflow_type,
        item.workflow_status,
        item.workflow_status_label,
        item.task_state,
        item.workflow_stage,
        item.workflow_stage_label,
      ].some((field) => includesInsensitive(field, keyword)),
    );
  }

  const summaries = tasks.slice(0, limit).map(toSummary);
  const result: WorkbenchStatusQueryResult = {
    query: {
      task_id: taskId,
      keyword,
      status: input.status,
      task_state: input.task_state,
      workflow_status: input.workflow_status,
      include_terminal: includeTerminal,
      include_detail: includeDetail,
      limit,
    },
    matched_count: tasks.length,
    tasks: summaries,
  };

  if (includeDetail && summaries.length === 1) {
    return queryWorkbenchTaskStatuses({ task_id: summaries[0].id });
  }

  return result;
}
