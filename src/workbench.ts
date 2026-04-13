import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import {
  createWorkbenchEvent,
  createWorkbenchComment,
  createWorkbenchContextAsset,
  getWorkbenchActionItem,
  getDelegationsByWorkflow,
  getWorkflow,
  getAllWorkflows,
  getWorkbenchTaskById,
  getWorkbenchTaskByWorkflowId,
  listWorkbenchActionItemsByTask,
  listWorkbenchArtifactsByTask,
  listWorkbenchCommentsByTask,
  listWorkbenchContextAssetsByTask,
  listWorkbenchEventsByTask,
  listWorkbenchSubtasksByTask,
  listWorkbenchTasks as listWorkbenchTaskRecords,
  updateWorkbenchActionItem,
  updateWorkbenchSubtask,
} from './db.js';
import type {
  Delegation,
  WorkbenchActionItemRecord,
  WorkbenchArtifactRecord,
  WorkbenchCommentRecord,
  WorkbenchContextAssetRecord,
  WorkbenchEventRecord,
  WorkbenchSubtaskRecord,
  WorkbenchTaskRecord,
  Workflow,
} from './types.js';
import {
  approveWorkflow,
  cancelWorkflow,
  createNewWorkflow,
  getAvailableWorkflowTypes,
  getStatusLabelsForType,
  pauseWorkflow,
  resumeWorkflow,
  retryWorkflowStage,
  reviseWorkflow,
  skipWorkflow,
  skipWorkflowStage,
} from './workflow.js';
import {
  getCardConfig,
  getReachableWorkflowStages,
  getWorkflowTypeConfig,
  renderTemplate,
} from './workflow-config.js';
import { WORKFLOW_ARTIFACT_DEFINITIONS } from './workflow-artifacts.js';
import { syncWorkbenchFromWorkflow } from './workbench-store.js';
import { emitWorkbenchEvent } from './workbench-events.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
  WorkflowContext,
} from './workflow-context.js';

export interface WorkbenchTaskItem {
  id: string;
  title: string;
  service: string;
  start_from: string;
  workflow_type: string;
  status: string;
  status_label: string;
  current_stage: string;
  current_stage_label: string;
  round: number;
  source_jid: string;
  created_at: string;
  updated_at: string;
  pending_approval: boolean;
  pending_action_count: number;
  active_delegation_id: string;
  context: Record<string, unknown>;
}

export interface WorkbenchTimelineEvent {
  id: string;
  type: 'lifecycle' | 'delegation' | 'approval' | 'artifact' | 'manual';
  title: string;
  body: string;
  created_at: string;
  status?: string;
}

export interface WorkbenchSubtask {
  id: string;
  title: string;
  stage_key: string;
  stage_label: string;
  status: 'completed' | 'current' | 'pending' | 'failed' | 'cancelled';
  manually_skipped?: boolean;
  role?: string;
  skill?: string;
  target_folder?: string;
  delegation_id?: string;
  result?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WorkbenchArtifact {
  id: string;
  title: string;
  artifact_type: string;
  path: string;
  absolute_path: string;
  exists: boolean;
  created_at?: string;
}

export interface WorkbenchActionItem {
  id: string;
  item_type: 'approval' | 'interactive';
  source_type:
    | 'workflow'
    | 'request_human_input'
    | 'ask_user_question'
    | 'send_message';
  title: string;
  body: string;
  status:
    | 'pending'
    | 'confirmed'
    | 'resolved'
    | 'skipped'
    | 'cancelled'
    | 'expired';
  stage_key?: string;
  delegation_id?: string;
  group_folder?: string;
  source_ref_id?: string;
  replyable: boolean;
  action_mode?: 'approve_only' | 'approve_or_revise' | 'input_required';
  created_at?: string;
  extra?: Record<string, unknown>;
}

export interface WorkbenchTaskDetail {
  task: WorkbenchTaskItem;
  subtasks: WorkbenchSubtask[];
  timeline: WorkbenchTimelineEvent[];
  artifacts: WorkbenchArtifact[];
  action_items: WorkbenchActionItem[];
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
}

function toTaskItem(workflow: Workflow): WorkbenchTaskItem {
  const persisted = getWorkbenchTaskByWorkflowId(workflow.id);
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stateConfig = config?.states[workflow.status];
  const statusLabels = getStatusLabelsForType(workflow.workflow_type);
  const taskId = persisted?.id || workflow.id;
  const pendingActionCount = listWorkbenchActionItemsByTask(taskId).filter(
    (item) => item.status === 'pending',
  ).length;

  return {
    id: taskId,
    title: persisted?.title || workflow.name,
    service: persisted?.service || workflow.service,
    start_from: persisted?.start_from || workflow.start_from,
    workflow_type: persisted?.workflow_type || workflow.workflow_type,
    status: persisted?.status || workflow.status,
    status_label: statusLabels[workflow.status] || workflow.status,
    current_stage: persisted?.current_stage || workflow.status,
    current_stage_label:
      statusLabels[persisted?.current_stage || workflow.status] ||
      persisted?.current_stage ||
      workflow.status,
    round: workflow.round,
    source_jid: persisted?.source_jid || workflow.source_jid,
    created_at: persisted?.created_at || workflow.created_at,
    updated_at: persisted?.updated_at || workflow.updated_at,
    pending_approval:
      stateConfig?.type === 'confirmation' || pendingActionCount > 0,
    pending_action_count: pendingActionCount,
    active_delegation_id: workflow.current_delegation_id || '',
    context: { ...workflow.context },
  };
}

function mapPersistedSubtask(
  item: WorkbenchSubtaskRecord,
  manuallySkippedSubtaskIds?: Set<string>,
): WorkbenchSubtask {
  return {
    id: item.id,
    title: item.title,
    stage_key: item.stage_key,
    stage_label: item.title,
    status:
      item.status === 'completed'
        ? 'completed'
        : item.status === 'current'
          ? 'current'
          : item.status === 'cancelled'
            ? 'cancelled'
            : item.status === 'failed'
              ? 'failed'
              : 'pending',
    manually_skipped: manuallySkippedSubtaskIds?.has(item.id) || undefined,
    role: item.role || undefined,
    target_folder: item.group_folder || undefined,
    delegation_id: item.delegation_id || undefined,
    result: item.output_summary || undefined,
    created_at: item.started_at || undefined,
    updated_at: item.updated_at,
  };
}

function mapPersistedEvent(item: WorkbenchEventRecord): WorkbenchTimelineEvent {
  return {
    id: item.id,
    type:
      item.event_type === 'manual_skip'
        || item.event_type === 'retry_note'
        ? 'manual'
        : item.event_type === 'workflow_created'
          ? 'lifecycle'
          : item.event_type.includes('approval')
            ? 'approval'
            : item.event_type.includes('artifact')
              ? 'artifact'
              : 'delegation',
    title: item.title,
    body: item.body || '',
    created_at: item.created_at,
    status: item.event_type,
  };
}

function mapPersistedArtifact(
  item: WorkbenchArtifactRecord,
): WorkbenchArtifact {
  const fullPath = path.join(PROJECT_ROOT, item.path);
  return {
    id: item.id,
    title: item.title,
    artifact_type: item.artifact_type,
    path: item.path,
    absolute_path: fullPath,
    exists: fs.existsSync(fullPath),
    created_at: item.created_at,
  };
}

function mapPersistedActionItem(
  item: WorkbenchActionItemRecord,
): WorkbenchActionItem {
  const extra = item.extra_json
    ? (JSON.parse(item.extra_json) as Record<string, unknown>)
    : undefined;
  return {
    id: item.id,
    item_type: item.item_type === 'approval' ? 'approval' : 'interactive',
    source_type:
      item.source_type === 'request_human_input' ||
      item.source_type === 'ask_user_question' ||
      item.source_type === 'send_message'
        ? item.source_type
        : 'workflow',
    title: item.title,
    body: item.body || '',
    status:
      item.status === 'confirmed' ||
      item.status === 'resolved' ||
      item.status === 'skipped' ||
      item.status === 'cancelled' ||
      item.status === 'expired'
        ? item.status
        : 'pending',
    stage_key: item.stage_key || undefined,
    delegation_id: item.delegation_id || undefined,
    group_folder: item.group_folder || undefined,
    source_ref_id: item.source_ref_id || undefined,
    replyable: item.replyable === 1,
    action_mode:
      extra?.action_mode === 'approve_only' ||
      extra?.action_mode === 'approve_or_revise' ||
      extra?.action_mode === 'input_required'
        ? extra.action_mode
        : undefined,
    created_at: item.created_at,
    extra,
  };
}

function mapPersistedComment(item: WorkbenchCommentRecord) {
  return {
    id: item.id,
    author: item.author,
    content: item.content,
    created_at: item.created_at,
  };
}

function mapPersistedAsset(item: WorkbenchContextAssetRecord) {
  return {
    id: item.id,
    title: item.title,
    asset_type: item.asset_type,
    path: item.path,
    url: item.url,
    note: item.note,
    created_at: item.created_at,
  };
}

function getVisibleStageKeys(workflow: Workflow): string[] {
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  const persistedStageKeys = task
    ? listWorkbenchSubtasksByTask(task.id).map((item) => item.stage_key)
    : [];

  if (persistedStageKeys.length > 0) {
    return persistedStageKeys;
  }

  const visibleStageKeys = getReachableWorkflowStages(
    workflow.workflow_type,
    workflow.status,
  );
  return visibleStageKeys.length > 0 ? visibleStageKeys : [workflow.status];
}

function getOrderedVisibleStageKeys(workflow: Workflow): string[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return getVisibleStageKeys(workflow);

  const visibleStageKeys = new Set(getVisibleStageKeys(workflow));
  const orderedStageKeys = Object.keys(config.states).filter(
    (stageKey) =>
      visibleStageKeys.has(stageKey) &&
      config.states[stageKey]?.type !== 'system' &&
      config.states[stageKey]?.type !== 'terminal',
  );

  return orderedStageKeys.length > 0
    ? orderedStageKeys
    : Array.from(visibleStageKeys);
}

function sortSubtasksByWorkflowOrder(
  workflow: Workflow,
  subtasks: WorkbenchSubtask[],
): WorkbenchSubtask[] {
  const hasRepeatedStages =
    new Set(subtasks.map((item) => item.stage_key)).size !== subtasks.length;
  if (hasRepeatedStages) {
    return [...subtasks];
  }

  const stageOrder = new Map(
    getOrderedVisibleStageKeys(workflow).map((stageKey, index) => [
      stageKey,
      index,
    ]),
  );

  return [...subtasks].sort((a, b) => {
    const aIndex = stageOrder.get(a.stage_key) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = stageOrder.get(b.stage_key) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}

function getStageDefinitions(workflow: Workflow): WorkbenchSubtask[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return [];

  const visibleStageKeys = new Set(getVisibleStageKeys(workflow));

  return Object.entries(config.states)
    .filter(
      ([key, state]) =>
        state.type !== 'system' &&
        state.type !== 'terminal' &&
        visibleStageKeys.has(key),
    )
    .map(([key, state]) => ({
      id: `stage-${key}`,
      title: state.role || key,
      stage_key: key,
      stage_label: config.status_labels[key] || key,
      status: 'pending' as const,
      role: state.role,
      skill: state.skill,
    }));
}

function summarizeResult(result: string | null): string {
  if (!result) return '';
  const normalized = result.replace(/\s+/g, ' ').trim();
  return normalized.length > 180
    ? `${normalized.slice(0, 177)}...`
    : normalized;
}

function buildSubtasks(
  workflow: Workflow,
  delegations: Delegation[],
): WorkbenchSubtask[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stages = getStageDefinitions(workflow);
  if (!config || stages.length === 0) return [];

  const currentKey = workflow.status;
  const delegationStates = Object.entries(config.states)
    .filter(([, state]) => state.type === 'delegation')
    .map(([key]) => key);

  return stages.map((stage) => {
    const delegationIndex = delegationStates.indexOf(stage.stage_key);
    const linkedDelegation =
      delegationIndex >= 0 ? delegations[delegationIndex] : undefined;

    let status: WorkbenchSubtask['status'] = 'pending';
    if (stage.stage_key === currentKey) status = 'current';
    else if (linkedDelegation?.outcome === 'failure') status = 'failed';
    else if (linkedDelegation?.status === 'completed') status = 'completed';

    return {
      ...stage,
      title: stage.stage_label,
      status,
      target_folder: linkedDelegation?.target_folder,
      delegation_id: linkedDelegation?.id,
      result: summarizeResult(linkedDelegation?.result || null),
      created_at: linkedDelegation?.created_at,
      updated_at: linkedDelegation?.updated_at,
    };
  });
}

function buildArtifacts(workflow: Workflow): WorkbenchArtifact[] {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  if (!workflow.service || !deliverable) return [];

  const baseDir = path.join(
    PROJECT_ROOT,
    'projects',
    workflow.service,
    'iteration',
    deliverable,
  );

  return WORKFLOW_ARTIFACT_DEFINITIONS.map((candidate) => {
    const fullPath = path.join(baseDir, candidate.file);
    return {
      id: `${workflow.id}-${candidate.file}`,
      title: candidate.title,
      artifact_type: candidate.artifact_type,
      path: path.relative(PROJECT_ROOT, fullPath),
      absolute_path: fullPath,
      exists: fs.existsSync(fullPath),
      created_at: workflow.updated_at,
    };
  });
}

function buildActionItems(workflow: Workflow): WorkbenchActionItem[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stateConfig = config?.states[workflow.status];
  if (!config || !stateConfig || stateConfig.type !== 'confirmation') return [];

  const card = stateConfig.card
    ? getCardConfig(workflow.workflow_type, stateConfig.card)
    : undefined;
  const vars = {
    name: workflow.name,
    service: workflow.service,
    main_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.mainBranch,
    ),
    work_branch:
      getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.workBranch) || 'N/A',
    staging_base_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.stagingBaseBranch,
    ),
    staging_work_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
    ),
    id: workflow.id,
    round: workflow.round,
    deliverable:
      getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.deliverable) ||
      'N/A',
    delegation_result: '',
    result_summary: '',
    revision_text: '',
  };
  const body = card?.body_template
    ? renderTemplate(card.body_template, vars)
    : `${config.status_labels[workflow.status] || workflow.status} 等待处理`;

  return [
    {
      id: `${workflow.id}-approval-${workflow.status}`,
      item_type: 'approval',
      source_type: 'workflow',
      title: config.status_labels[workflow.status] || workflow.status,
      body,
      status: 'pending',
      stage_key: workflow.status,
      source_ref_id: workflow.status,
      replyable: false,
      action_mode:
        workflow.status === 'testing_confirm'
          ? 'input_required'
          : stateConfig.on_revise
            ? 'approve_or_revise'
            : 'approve_only',
      created_at: workflow.updated_at,
    },
  ];
}

function buildTimeline(
  workflow: Workflow,
  delegations: Delegation[],
): WorkbenchTimelineEvent[] {
  const timeline: WorkbenchTimelineEvent[] = [
    {
      id: `${workflow.id}-created`,
      type: 'lifecycle',
      title: '任务已创建',
      body: `已创建 ${workflow.workflow_type} 工作流，服务 ${workflow.service}`,
      created_at: workflow.created_at,
      status: workflow.status,
    },
  ];

  for (const delegation of delegations) {
    timeline.push({
      id: `${delegation.id}-created`,
      type: 'delegation',
      title: `已委派 ${delegation.target_folder}`,
      body: delegation.task,
      created_at: delegation.created_at,
      status: delegation.status,
    });

    if (delegation.status !== 'pending') {
      timeline.push({
        id: `${delegation.id}-completed`,
        type: 'delegation',
        title:
          delegation.outcome === 'failure'
            ? `委派失败 ${delegation.target_folder}`
            : `委派完成 ${delegation.target_folder}`,
        body: summarizeResult(delegation.result),
        created_at: delegation.updated_at,
        status: delegation.outcome || delegation.status,
      });
    }
  }

  for (const artifact of buildArtifacts(workflow).filter(
    (item) => item.exists,
  )) {
    timeline.push({
      id: `${artifact.id}-artifact`,
      type: 'artifact',
      title: `产出已生成：${artifact.title}`,
      body: artifact.path,
      created_at: workflow.updated_at,
      status: 'ready',
    });
  }

  for (const item of buildActionItems(workflow)) {
    timeline.push({
      id: `${item.id}-approval`,
      type: 'approval',
      title: `等待审批：${item.title}`,
      body: item.body,
      created_at: workflow.updated_at,
      status: item.status,
    });
  }

  return sortTimelineEvents(timeline);
}

function sortTimelineEvents(
  timeline: WorkbenchTimelineEvent[],
): WorkbenchTimelineEvent[] {
  return [...timeline].sort((a, b) => {
    const aTs = parseTimestamp(a.created_at);
    const bTs = parseTimestamp(b.created_at);
    if (aTs !== bTs) return aTs - bTs;
    return a.id.localeCompare(b.id);
  });
}

function sortWorkbenchTaskItems(
  tasks: WorkbenchTaskItem[],
): WorkbenchTaskItem[] {
  return [...tasks].sort((a, b) => {
    const aTs = parseTimestamp(a.updated_at || a.created_at);
    const bTs = parseTimestamp(b.updated_at || b.created_at);
    if (aTs !== bTs) return bTs - aTs;
    return b.id.localeCompare(a.id);
  });
}

function parseTimestamp(value: string | undefined | null): number {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function listWorkbenchTasks(): WorkbenchTaskItem[] {
  const persisted = listWorkbenchTaskRecords();
  if (persisted.length > 0) {
    return sortWorkbenchTaskItems(
      persisted.map((item: WorkbenchTaskRecord) => {
        const workflow = getWorkflow(item.workflow_id);
        if (workflow) return toTaskItem(workflow);
        return {
          id: item.id,
          title: item.title,
          service: item.service,
          start_from: item.start_from,
          workflow_type: item.workflow_type,
          status: item.status,
          status_label: item.status,
          current_stage: item.current_stage,
          current_stage_label: item.current_stage,
          round: 0,
          source_jid: item.source_jid,
          created_at: item.created_at,
          updated_at: item.updated_at,
          pending_approval: listWorkbenchActionItemsByTask(item.id).some(
            (actionItem) => actionItem.status === 'pending',
          ),
          pending_action_count: listWorkbenchActionItemsByTask(item.id).filter(
            (actionItem) => actionItem.status === 'pending',
          ).length,
          active_delegation_id: '',
          context: {},
        };
      }),
    );
  }
  return sortWorkbenchTaskItems(
    getAllWorkflows().map((workflow) => {
      syncWorkbenchFromWorkflow(workflow.id);
      return toTaskItem(workflow);
    }),
  );
}

function resolveWorkbenchWorkflowId(taskId: string): string | null {
  if (!taskId) return null;

  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) return null;

  const persistedById = getWorkbenchTaskById(normalizedTaskId);
  if (persistedById) return persistedById.workflow_id;

  const normalizedWorkflowId = normalizedTaskId.replace(/^wb-/, '');
  if (getWorkflow(normalizedWorkflowId)) return normalizedWorkflowId;

  const persistedByWorkflowId =
    getWorkbenchTaskByWorkflowId(normalizedWorkflowId);
  if (persistedByWorkflowId) return persistedByWorkflowId.workflow_id;

  return null;
}

function getWorkbenchTaskRecord(taskId: string): WorkbenchTaskRecord | null {
  const workflowId = resolveWorkbenchWorkflowId(taskId);
  if (!workflowId) return null;
  syncWorkbenchFromWorkflow(workflowId);
  return getWorkbenchTaskByWorkflowId(workflowId) || null;
}

export function getWorkbenchTaskDetail(
  taskId: string,
): WorkbenchTaskDetail | null {
  const workflowId = resolveWorkbenchWorkflowId(taskId);
  if (!workflowId) return null;

  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const task = getWorkbenchTaskRecord(taskId);
  if (task) {
    const events = listWorkbenchEventsByTask(task.id);
    const manuallySkippedSubtaskIds = new Set(
      events
        .filter((item) => item.event_type === 'manual_skip' && item.subtask_id)
        .map((item) => item.subtask_id as string),
    );
    const visibleStageKeys = new Set(getVisibleStageKeys(workflow));
    return {
      task: toTaskItem(workflow),
      subtasks: sortSubtasksByWorkflowOrder(
        workflow,
        listWorkbenchSubtasksByTask(task.id)
          .filter((item) => visibleStageKeys.has(item.stage_key))
          .map((item) => mapPersistedSubtask(item, manuallySkippedSubtaskIds)),
      ),
      timeline: sortTimelineEvents(events.map(mapPersistedEvent)),
      artifacts: listWorkbenchArtifactsByTask(task.id).map(
        mapPersistedArtifact,
      ),
      action_items: listWorkbenchActionItemsByTask(task.id)
        .filter((item) => {
          if (item.status !== 'pending') return false;
          if (item.delegation_id) {
            return workflow.current_delegation_id === item.delegation_id;
          }
          return item.stage_key === workflow.status;
        })
        .map(mapPersistedActionItem),
      comments: listWorkbenchCommentsByTask(task.id).map(mapPersistedComment),
      assets: listWorkbenchContextAssetsByTask(task.id).map(mapPersistedAsset),
    };
  }
  const delegations = getDelegationsByWorkflow(workflow.id);

  return {
    task: toTaskItem(workflow),
    subtasks: sortSubtasksByWorkflowOrder(
      workflow,
      buildSubtasks(workflow, delegations),
    ),
    timeline: buildTimeline(workflow, delegations),
    artifacts: buildArtifacts(workflow),
    action_items: buildActionItems(workflow),
    comments: [],
    assets: [],
  };
}

export function createWorkbenchTask(input: {
  name: string;
  service: string;
  sourceJid: string;
  startFrom: string;
  workflowType: string;
  context?: WorkflowContext;
}): { workflowId: string; error?: string } {
  return createNewWorkflow({
    name: input.name,
    service: input.service,
    sourceJid: input.sourceJid,
    startFrom: input.startFrom,
    workflowType: input.workflowType,
    deliverable:
      typeof input.context?.[WORKFLOW_CONTEXT_KEYS.deliverable] === 'string'
        ? (input.context[WORKFLOW_CONTEXT_KEYS.deliverable] as string)
        : undefined,
    mainBranch:
      typeof input.context?.[WORKFLOW_CONTEXT_KEYS.mainBranch] === 'string'
        ? (input.context[WORKFLOW_CONTEXT_KEYS.mainBranch] as string)
        : undefined,
    workBranch:
      typeof input.context?.[WORKFLOW_CONTEXT_KEYS.workBranch] === 'string'
        ? (input.context[WORKFLOW_CONTEXT_KEYS.workBranch] as string)
        : undefined,
    stagingBaseBranch:
      typeof input.context?.[WORKFLOW_CONTEXT_KEYS.stagingBaseBranch] === 'string'
        ? (input.context[WORKFLOW_CONTEXT_KEYS.stagingBaseBranch] as string)
        : undefined,
    stagingWorkBranch:
      typeof input.context?.[WORKFLOW_CONTEXT_KEYS.stagingWorkBranch] === 'string'
        ? (input.context[WORKFLOW_CONTEXT_KEYS.stagingWorkBranch] as string)
        : undefined,
    accessToken:
      typeof input.context?.[WORKFLOW_CONTEXT_KEYS.accessToken] === 'string'
        ? (input.context[WORKFLOW_CONTEXT_KEYS.accessToken] as string)
        : undefined,
  });
}

export function runWorkbenchTaskAction(input: {
  taskId: string;
  action:
    | 'approve'
    | 'revise'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'skip'
    | 'submit_access_token';
  subtaskId?: string;
  revisionText?: string;
  context?: WorkflowContext;
}): { error?: string } {
  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  switch (input.action) {
    case 'approve':
      return approveWorkflow(workflowId);
    case 'revise':
      return reviseWorkflow(
        workflowId,
        input.revisionText?.trim() || '请按最新意见修正',
      );
    case 'pause':
      return pauseWorkflow(workflowId);
    case 'resume':
      return resumeWorkflow(workflowId);
    case 'cancel':
      return cancelWorkflow(workflowId);
    case 'skip': {
      if (!input.subtaskId) {
        return skipWorkflow(workflowId);
      }
      const subtask = listWorkbenchSubtasksByTask(input.taskId).find(
        (item) => item.id === input.subtaskId,
      );
      if (!subtask) return { error: 'Subtask not found' };
      if (subtask.status !== 'failed' && subtask.status !== 'cancelled') {
        return {
          error:
            'Only failed or cancelled subtasks can be skipped from stage progress',
        };
      }
      return skipWorkflowStage(workflowId, subtask.stage_key);
    }
    case 'submit_access_token':
      if (
        typeof input.context?.[WORKFLOW_CONTEXT_KEYS.accessToken] !== 'string' ||
        !String(input.context[WORKFLOW_CONTEXT_KEYS.accessToken]).trim()
      ) {
        return { error: 'access_token required' };
      }
      return reviseWorkflow(
        workflowId,
        String(input.context[WORKFLOW_CONTEXT_KEYS.accessToken]).trim(),
      );
    default:
      return { error: `Unsupported action: ${input.action}` };
  }
}

export function getWorkbenchCreateOptions(): {
  workflow_types: ReturnType<typeof getAvailableWorkflowTypes>;
} {
  return {
    workflow_types: getAvailableWorkflowTypes(),
  };
}

export function addWorkbenchComment(input: {
  taskId: string;
  author: string;
  content: string;
}): { error?: string } {
  const detail = getWorkbenchTaskDetail(input.taskId);
  if (!detail) return { error: 'Task not found' };

  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  const now = new Date().toISOString();
  const id = `wb-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createWorkbenchComment({
    id,
    task_id: detail.task.id,
    workflow_id: workflowId,
    author: input.author,
    content: input.content.trim(),
    created_at: now,
  });
  emitWorkbenchEvent({
    type: 'comment_created',
    taskId: detail.task.id,
    workflowId,
    payload: {
      id,
      author: input.author,
      content: input.content.trim(),
      createdAt: now,
    },
  });
  return {};
}

export function runWorkbenchActionItemAction(input: {
  taskId: string;
  actionItemId: string;
  action: 'confirm' | 'skip' | 'cancel' | 'resolve';
}): { error?: string } {
  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };
  const item = getWorkbenchActionItem(input.actionItemId);
  if (!item) return { error: 'Action item not found' };

  const nextStatus =
    input.action === 'confirm'
      ? 'confirmed'
      : input.action === 'skip'
        ? 'skipped'
        : input.action === 'cancel'
          ? 'cancelled'
          : 'resolved';
  const now = new Date().toISOString();
  updateWorkbenchActionItem(item.id, {
    status: nextStatus,
    updated_at: now,
    resolved_at: nextStatus === 'confirmed' ? null : now,
  });
  emitWorkbenchEvent({
    type: 'action_item_updated',
    taskId: item.task_id,
    workflowId,
    payload: {
      id: item.id,
      status: nextStatus,
      resolvedAt: nextStatus === 'confirmed' ? null : now,
    },
  });
  return {};
}

export function addWorkbenchAsset(input: {
  taskId: string;
  title: string;
  assetType: string;
  path?: string;
  url?: string;
  note?: string;
}): { error?: string } {
  const detail = getWorkbenchTaskDetail(input.taskId);
  if (!detail) return { error: 'Task not found' };

  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  const now = new Date().toISOString();
  const id = `wb-asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createWorkbenchContextAsset({
    id,
    task_id: detail.task.id,
    workflow_id: workflowId,
    asset_type: input.assetType,
    title: input.title,
    path: input.path || null,
    url: input.url || null,
    note: input.note || null,
    created_at: now,
  });
  emitWorkbenchEvent({
    type: 'asset_created',
    taskId: detail.task.id,
    workflowId,
    payload: {
      id,
      title: input.title,
      assetType: input.assetType,
      path: input.path || null,
      url: input.url || null,
      note: input.note || null,
      createdAt: now,
    },
  });
  return {};
}

export function retryWorkbenchSubtask(input: {
  taskId: string;
  subtaskId: string;
  retryNote?: string;
}): { error?: string } {
  const detail = getWorkbenchTaskDetail(input.taskId);
  if (!detail) return { error: 'Task not found' };

  const task = getWorkbenchTaskRecord(input.taskId);
  if (!task) return { error: 'Task not found' };

  const subtask = listWorkbenchSubtasksByTask(task.id).find(
    (item) => item.id === input.subtaskId,
  );
  if (!subtask) return { error: 'Subtask not found' };
  if (subtask.status !== 'failed')
    return { error: 'Only failed subtasks can be retried' };

  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  const result = retryWorkflowStage(workflowId, subtask.stage_key, {
    retryNote: input.retryNote,
  });
  if (result.error) return result;
  updateWorkbenchSubtask(subtask.id, {
    status: 'pending',
    output_summary: null,
    finished_at: null,
    updated_at: new Date().toISOString(),
  });
  const trimmedRetryNote = input.retryNote?.trim();
  if (trimmedRetryNote) {
    const createdAt = new Date().toISOString();
    const eventId = ['wb-event', workflowId, 'retry-note', subtask.id, createdAt].join(
      '-',
    );
    createWorkbenchEvent({
      id: eventId,
      task_id: detail.task.id,
      subtask_id: subtask.id,
      event_type: 'retry_note',
      title: `重跑补充信息：${subtask.title}`,
      body: trimmedRetryNote,
      raw_ref_type: 'workflow',
      raw_ref_id: workflowId,
      created_at: createdAt,
    });
    emitWorkbenchEvent({
      type: 'event_created',
      taskId: detail.task.id,
      workflowId,
      payload: {
        id: eventId,
        title: `重跑补充信息：${subtask.title}`,
        body: trimmedRetryNote,
        status: 'retry_note',
        createdAt,
      },
    });
  }
  emitWorkbenchEvent({
    type: 'subtask_updated',
    taskId: detail.task.id,
    workflowId,
    payload: { id: subtask.id, status: 'pending', retried: true },
  });
  return {};
}
