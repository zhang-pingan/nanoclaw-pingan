/**
 * Workflow Engine for NanoClaw — Configuration-Driven
 *
 * State machine definitions live in container/skills/workflows.json.
 * This engine reads them at init and drives transitions generically.
 *
 * Role resolution (no hardcoded group names):
 *   1. skills.json "workflow_roles" explicit mapping (if present)
 *   2. Infer from skill assignments using each workflow type's roles[].skill_to_role_key
 *   3. If any role is missing for all types → workflow is disabled
 */
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import {
  createDelegation,
  createWorkflow as dbCreateWorkflow,
  getAllActiveWorkflows,
  getAllWorkflows,
  getDelegation,
  getWorkflow,
  getWorkflowByDelegation,
  storeChatMetadata,
  storeMessageDirect,
  updateWorkflow,
} from './db.js';
import { logger } from './logger.js';
import { CardButton, CardSection, InteractiveCard, RegisteredGroup, Workflow } from './types.js';
import {
  getWorkflowConfigError,
  getWorkflowConfigs,
  getWorkflowTypeConfig,
  loadWorkflowConfigs,
  renderTemplate,
  StateTransition,
  TemplateVars,
  WorkflowTypeConfig,
} from './workflow-config.js';

// -------------------------------------------------------
// Role resolution — per trigger channel
// -------------------------------------------------------

/** 从 folder 名提取渠道前缀，如 "feishu_main" → "feishu" */
function getChannelFromFolder(folder: string): string {
  return folder.split('_')[0];
}

/**
 * 根据 workflow 类型和触发群组的 sourceJid 解析所有角色的 folder 映射。
 * 渠道从触发群组的 folder 名前缀提取，然后查找对应渠道的 folder 配置。
 */
function resolveRoles(
  workflowType: string,
  sourceJid: string,
): { roles: Record<string, string> } | { error: string } {
  const config = getWorkflowTypeConfig(workflowType);
  if (!config) return { error: `未知的 workflow 类型: ${workflowType}` };

  const groups = getDeps().registeredGroups();
  const sourceGroup = groups[sourceJid];
  const channel = sourceGroup
    ? getChannelFromFolder(sourceGroup.folder)
    : '';

  const roles: Record<string, string> = {};
  const missing: string[] = [];

  for (const [roleName, roleConfig] of Object.entries(config.roles)) {
    const folder = roleConfig.channels[channel];
    if (folder) {
      roles[roleName] = folder;
    } else {
      const available = Object.keys(roleConfig.channels).join(', ');
      missing.push(
        `${roleName}（渠道 "${channel}" 未配置，已有: ${available || '无'}）`,
      );
    }
  }

  if (missing.length > 0) {
    return {
      error:
        `渠道 "${channel}" 缺少角色配置：${missing.join('；')}。` +
        `请在 workflows.json 的对应角色 channels 中添加 "${channel}" 渠道。`,
    };
  }

  return { roles };
}

// -------------------------------------------------------
// Dependencies
// -------------------------------------------------------

export interface WorkflowDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  enqueueMessageCheck: (groupJid: string) => void;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
}

let deps: WorkflowDeps | null = null;

export function initWorkflow(d: WorkflowDeps): void {
  deps = d;
  loadWorkflowConfigs();
}

function getDeps(): WorkflowDeps {
  if (!deps) throw new Error('Workflow not initialized — call initWorkflow()');
  return deps;
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/** Find the JID for a given group folder name. */
function findJidByFolder(
  folder: string,
  groups: Record<string, RegisteredGroup>,
): string | undefined {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.folder === folder) return jid;
  }
  return undefined;
}

/** Find the main group's JID, optionally scoped to the same channel as sourceJid. */
function findMainJid(
  groups: Record<string, RegisteredGroup>,
  sourceJid?: string,
): string | undefined {
  // If sourceJid is provided, find the main group in the same channel
  if (sourceJid) {
    const sourceGroup = groups[sourceJid];
    if (sourceGroup) {
      const channel = getChannelFromFolder(sourceGroup.folder);
      for (const [jid, g] of Object.entries(groups)) {
        if (g.isMain && getChannelFromFolder(g.folder) === channel) return jid;
      }
    }
  }
  // Fallback: return the first main group found
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return jid;
  }
  return undefined;
}

/** Get the main group's folder name, optionally scoped to a channel via sourceJid. */
function getMainFolder(sourceJid?: string): string {
  const groups = getDeps().registeredGroups();
  if (sourceJid) {
    const sourceGroup = groups[sourceJid];
    if (sourceGroup) {
      const channel = getChannelFromFolder(sourceGroup.folder);
      const match = Object.values(groups).find(
        (g) => g.isMain && getChannelFromFolder(g.folder) === channel,
      );
      if (match) return match.folder;
    }
  }
  return Object.values(groups).find((g) => g.isMain)?.folder || '';
}

/** Inject a message into a group's chat to trigger the agent. */
function injectDelegation(
  targetJid: string,
  targetGroup: RegisteredGroup,
  delegationId: string,
  workflowId: string,
  skillName: string,
  taskContent: string,
): void {
  const { enqueueMessageCheck } = getDeps();
  const now = Date.now().toString();

  storeChatMetadata(targetJid, now);

  const syntheticContent = `${targetGroup.trigger} [委派任务 | ID:${delegationId} | 来自:主群 | 流程:${workflowId}]\n\n请按照 ${skillName} 技能执行以下任务：\n\n${taskContent}\n\n完成后请调用 complete_delegation 工具报告结果，delegation_id 为 "${delegationId}"。`;
  const syntheticId = `wf-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  storeMessageDirect({
    id: syntheticId,
    chat_jid: targetJid,
    sender: 'system',
    sender_name: '流程委派',
    content: syntheticContent,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
    workflow_id: workflowId,
  });

  enqueueMessageCheck(targetJid);
}

/** Send a progress message to the main group (scoped to the same channel as sourceJid when provided). */
function notifyMain(message: string, sourceJid?: string, workflowId?: string): void {
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups, sourceJid);
  if (!mainJid) {
    logger.warn('Workflow: cannot notify main — main group not found');
    return;
  }

  const now = Date.now().toString();
  const msgId = `wf-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  storeMessageDirect({
    id: msgId,
    chat_jid: mainJid,
    sender: 'system',
    sender_name: '流程引擎',
    content: message,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
    workflow_id: workflowId,
  });

  getDeps().enqueueMessageCheck(mainJid);
}

function notifyGroupFolder(folder: string, senderName: string, message: string, workflowId?: string): void {
  const groups = getDeps().registeredGroups();
  const targetJid = findJidByFolder(folder, groups);
  if (!targetJid) {
    logger.warn({ folder }, 'Cannot notify group folder: target JID not found');
    return;
  }
  const now = Date.now().toString();
  const msgId = `mem-conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  storeChatMetadata(targetJid, now);
  storeMessageDirect({
    id: msgId,
    chat_jid: targetJid,
    sender: 'system',
    sender_name: senderName,
    content: message,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
    workflow_id: workflowId,
  });
  getDeps().enqueueMessageCheck(targetJid);
}

/** Create a delegation record and inject it into the target group. */
function delegateTo(
  targetFolder: string,
  sourceFolder: string,
  workflowId: string,
  skillName: string,
  taskContent: string,
): string {
  const groups = getDeps().registeredGroups();
  const targetJid = findJidByFolder(targetFolder, groups);
  if (!targetJid) {
    throw new Error(
      `Workflow: target group folder "${targetFolder}" not found`,
    );
  }
  const targetGroup = groups[targetJid];

  const sourceJid = findJidByFolder(sourceFolder, groups) || '';
  const delegationId = `wf-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now().toString();

  createDelegation({
    id: delegationId,
    source_jid: sourceJid,
    source_folder: sourceFolder,
    target_jid: targetJid,
    target_folder: targetFolder,
    task: taskContent,
    status: 'pending',
    result: null,
    outcome: null,
    workflow_id: workflowId,
    created_at: now,
    updated_at: now,
  });

  injectDelegation(
    targetJid,
    targetGroup,
    delegationId,
    workflowId,
    skillName,
    taskContent,
  );

  return delegationId;
}

/** Read a specific deliverable directory and return its metadata. */
function readDeliverableDir(
  service: string,
  dirName: string,
): { branch: string; fileName: string; files: string[] } | null {
  const delivDir = path.join(PROJECT_ROOT, 'projects', service, 'iteration', dirName);
  if (!fs.existsSync(delivDir)) return null;

  const files = fs.readdirSync(delivDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return null;

  let branch = '';
  // Try to read branch from any .md file
  for (const file of files) {
    const content = fs.readFileSync(path.join(delivDir, file), 'utf-8');
    const branchMatch = content.match(/工作分支[：:]\s*(.+)/);
    if (branchMatch) {
      branch = branchMatch[1].trim();
      break;
    }
  }

  return { branch, fileName: dirName, files };
}

/** Get terminal state names from a workflow type config. */
function getTerminalStates(config: WorkflowTypeConfig): string[] {
  return Object.entries(config.states)
    .filter(([, s]) => s.type === 'terminal')
    .map(([name]) => name);
}

/** Get confirmation state names from a workflow type config. */
function getConfirmationStates(config: WorkflowTypeConfig): string[] {
  return Object.entries(config.states)
    .filter(([, s]) => s.type === 'confirmation')
    .map(([name]) => name);
}

/** Get the status label for a workflow. */
function getStatusLabel(workflow: Workflow): string {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return workflow.status;
  return config.status_labels[workflow.status] || workflow.status;
}

/** Build template vars from a workflow + optional delegation result. */
function buildTemplateVars(
  workflow: Workflow,
  extra?: {
    delegationResult?: string;
    resultSummary?: string;
    revisionText?: string;
  },
): TemplateVars {
  return {
    name: workflow.name,
    service: workflow.service,
    branch: workflow.branch || 'N/A',
    id: workflow.id,
    round: workflow.round,
    deliverable: workflow.deliverable || 'N/A',
    delegation_result: extra?.delegationResult || '',
    result_summary: extra?.resultSummary || '',
    revision_text: extra?.revisionText || '',
  };
}

// -------------------------------------------------------
// Generic transition engine
// -------------------------------------------------------

/**
 * Apply a state transition defined in the config.
 * Handles: increment_round → delegateTo → updateWorkflow → notify → send card
 */
function applyTransition(
  workflow: Workflow,
  transition: StateTransition,
  roles: Record<string, string>,
  extra?: {
    delegationResult?: string;
    resultSummary?: string;
    revisionText?: string;
  },
): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return;

  const mainFolder = getMainFolder(workflow.source_jid);
  const updates: Parameters<typeof updateWorkflow>[1] = {
    status: transition.target,
  };

  // 1. Increment round if needed
  let round = workflow.round;
  if (transition.increment_round) {
    round = workflow.round + 1;
    updates.round = round;
  }

  // Build template vars with updated values
  const vars = buildTemplateVars(
    {
      ...workflow,
      round,
    },
    extra,
  );

  // 3. Delegate if transition specifies a role + skill
  const delegateRole = transition.role;
  const delegateSkill = transition.skill;

  if (delegateRole && delegateSkill && roles[delegateRole]) {
    const taskContent = transition.task_template
      ? renderTemplate(transition.task_template, vars, roles)
      : '';

    try {
      const delegationId = delegateTo(
        roles[delegateRole],
        mainFolder,
        workflow.id,
        delegateSkill,
        taskContent,
      );
      updates.current_delegation_id = delegationId;
    } catch (err) {
      logger.error(
        { err, workflowId: workflow.id, role: delegateRole },
        'Failed to delegate task in transition',
      );
      notifyMain(
        `[流程异常] 需求「${workflow.name}」(${workflow.id}) 委派任务失败。`,
        workflow.source_jid,
        workflow.id,
      );
      return;
    }
  } else {
    // No delegation — clear current_delegation_id
    updates.current_delegation_id = '';
  }

  // 4. Update workflow state
  updateWorkflow(workflow.id, updates);

  // 5. Send notification
  if (transition.notify) {
    notifyMain(renderTemplate(transition.notify, vars, roles), workflow.source_jid, workflow.id);
  }

  // 6. Send card if specified
  if (transition.card) {
    const updatedWorkflow = getWorkflow(workflow.id);
    if (updatedWorkflow) {
      sendConfigCard(updatedWorkflow, transition.card);
    }
  }
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

export interface CreateWorkflowOpts {
  name: string;
  service: string;
  sourceJid: string;
  startFrom: string;
  workflowType: string;
  deliverable?: string;
}

export function createNewWorkflow(opts: CreateWorkflowOpts): {
  workflowId: string;
  error?: string;
} {
  const workflowType = opts.workflowType;

  // Check if workflow type config exists
  const config = getWorkflowTypeConfig(workflowType);
  if (!config) {
    return {
      workflowId: '',
      error: `未知的 workflow 类型: ${workflowType}`,
    };
  }

  // Check roles
  const rolesResult = resolveRoles(workflowType, opts.sourceJid);
  if ('error' in rolesResult) {
    return { workflowId: '', error: rolesResult.error };
  }
  const roles = rolesResult.roles;

  // Find entry point
  const entryPoint = config.entry_points[opts.startFrom];
  if (!entryPoint) {
    return {
      workflowId: '',
      error: `Workflow type "${workflowType}" 不支持 start_from="${opts.startFrom}"，可选: ${Object.keys(config.entry_points).join(', ')}`,
    };
  }

  const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const mainFolder = getMainFolder(opts.sourceJid);

  // If entry point requires deliverable, it must be explicitly specified
  if (entryPoint.requires_deliverable) {
    if (!opts.deliverable) {
      return {
        workflowId,
        error: `入口 "${opts.startFrom}" 需要指定 deliverable 参数，请先用 list_deliverables 工具查看可用目录。`,
      };
    }

    const deliverable = readDeliverableDir(opts.service, opts.deliverable);
    if (!deliverable) {
      return {
        workflowId,
        error: `交付文档目录 "${opts.deliverable}" 不存在 (projects/${opts.service}/iteration/${opts.deliverable}/)`,
      };
    }

    dbCreateWorkflow({
      id: workflowId,
      name: opts.name,
      service: opts.service,
      branch: deliverable.branch,
      deliverable: deliverable.fileName,
      status: entryPoint.state,
      current_delegation_id: '',
      round: 0,
      source_jid: opts.sourceJid,
      paused_from: null,
      workflow_type: workflowType,
      created_at: now,
      updated_at: now,
    });

    const entryStateConfig = config.states[entryPoint.state];

    // If entry state is a confirmation state, send the card
    if (entryStateConfig?.type === 'confirmation' && entryStateConfig.card) {
      const createdWorkflow = getWorkflow(workflowId);
      if (createdWorkflow) {
        sendConfigCard(createdWorkflow, entryStateConfig.card);
      }
    }

    // If entry state is a delegation state, delegate immediately
    if (
      entryStateConfig?.type === 'delegation' &&
      entryStateConfig.role &&
      entryStateConfig.skill
    ) {
      const targetFolder = roles[entryStateConfig.role];
      if (!targetFolder) {
        return {
          workflowId,
          error: `角色 ${entryStateConfig.role} 未找到对应的群组`,
        };
      }

      try {
        const vars = buildTemplateVars(getWorkflow(workflowId)!);
        const taskContent = entryStateConfig.task_template
          ? renderTemplate(entryStateConfig.task_template, vars, roles)
          : '';

        const delegationId = delegateTo(
          targetFolder,
          mainFolder,
          workflowId,
          entryStateConfig.skill,
          taskContent,
        );
        updateWorkflow(workflowId, { current_delegation_id: delegationId });
      } catch (err) {
        logger.error({ err, workflowId }, 'Failed to delegate initial task');
        return {
          workflowId,
          error: `委派初始任务失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      notifyMain(
        `[流程启动] 需求「${opts.name}」${config.name}已创建 (${workflowId})，已委派 ${roles[entryStateConfig.role]} 开始执行。`,
        opts.sourceJid,
        workflowId,
      );
    }

    return { workflowId };
  }

  // Normal entry: create workflow and delegate to the initial state's role
  const entryStateConfig = config.states[entryPoint.state];

  dbCreateWorkflow({
    id: workflowId,
    name: opts.name,
    service: opts.service,
    branch: '',
    deliverable: '',
    status: entryPoint.state,
    current_delegation_id: '',
    round: 0,
    source_jid: opts.sourceJid,
    paused_from: null,
    workflow_type: workflowType,
    created_at: now,
    updated_at: now,
  });

  // If entry state is a delegation state, delegate immediately
  if (
    entryStateConfig?.type === 'delegation' &&
    entryStateConfig.role &&
    entryStateConfig.skill
  ) {
    const targetFolder = roles[entryStateConfig.role];
    if (!targetFolder) {
      return {
        workflowId,
        error: `角色 ${entryStateConfig.role} 未找到对应的群组`,
      };
    }

    try {
      const vars = buildTemplateVars(getWorkflow(workflowId)!);
      const taskContent = entryStateConfig.task_template
        ? renderTemplate(entryStateConfig.task_template, vars, roles)
        : '';

      const delegationId = delegateTo(
        targetFolder,
        mainFolder,
        workflowId,
        entryStateConfig.skill,
        taskContent,
      );
      updateWorkflow(workflowId, { current_delegation_id: delegationId });
    } catch (err) {
      logger.error({ err, workflowId }, 'Failed to delegate initial task');
      return {
        workflowId,
        error: `委派初始任务失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    notifyMain(
      `[流程启动] 需求「${opts.name}」${config.name}已创建 (${workflowId})，已委派 ${roles[entryStateConfig.role]} 开始执行。`,
      opts.sourceJid,
      workflowId,
    );
  }

  return { workflowId };
}

export function approveWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config)
    return { error: `未知的 workflow 类型: ${workflow.workflow_type}` };

  const stateConfig = config.states[workflow.status];
  if (
    !stateConfig ||
    stateConfig.type !== 'confirmation' ||
    !stateConfig.on_approve
  ) {
    return {
      error: `流程 ${workflowId} 当前状态 ${workflow.status} 不支持确认操作`,
    };
  }

  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  if ('error' in rolesResult) return { error: rolesResult.error };

  applyTransition(workflow, stateConfig.on_approve, rolesResult.roles);
  return {};
}

export function reviseWorkflow(
  workflowId: string,
  revisionText: string,
): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config)
    return { error: `未知的 workflow 类型: ${workflow.workflow_type}` };

  const stateConfig = config.states[workflow.status];
  if (
    !stateConfig ||
    stateConfig.type !== 'confirmation' ||
    !stateConfig.on_revise
  ) {
    return {
      error: `流程 ${workflowId} 当前状态 ${workflow.status} 不支持修改操作`,
    };
  }

  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  if ('error' in rolesResult) return { error: rolesResult.error };

  applyTransition(workflow, stateConfig.on_revise, rolesResult.roles, {
    revisionText,
  });
  return {};
}

/**
 * Called when a delegation completes. Checks if it belongs to a workflow
 * and advances the state machine accordingly.
 */
export function onDelegationComplete(delegationId: string): void {
  const workflow = getWorkflowByDelegation(delegationId);
  if (!workflow) return; // Not a workflow delegation

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return;

  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  if ('error' in rolesResult) return;
  const roles = rolesResult.roles;

  const delegation = getDelegation(delegationId);
  if (!delegation) return;

  // If workflow is paused, delegation result is stored but state machine does not advance
  if (workflow.status === 'paused') {
    logger.info(
      { workflowId: workflow.id, delegationId },
      'Workflow is paused, delegation result stored but not advancing',
    );
    return;
  }

  logger.info(
    {
      workflowId: workflow.id,
      delegationId,
      currentStatus: workflow.status,
      result: delegation.result?.slice(0, 100),
    },
    'Workflow delegation completed',
  );

  // Look up current state config
  const stateConfig = config.states[workflow.status];
  if (
    !stateConfig ||
    stateConfig.type !== 'delegation' ||
    !stateConfig.on_complete
  ) {
    logger.warn(
      { workflowId: workflow.id, status: workflow.status },
      'Unexpected workflow status on delegation complete — no on_complete config',
    );
    return;
  }

  // Determine outcome
  const outcome = delegation.outcome === 'failure' ? 'failure' : 'success';
  const transition = stateConfig.on_complete[outcome];
  if (!transition) {
    logger.warn(
      { workflowId: workflow.id, status: workflow.status, outcome },
      'No transition defined for outcome',
    );
    return;
  }

  // Parse result summary
  let resultSummary = delegation.result || '';
  try {
    const p = JSON.parse(resultSummary);
    if (p.summary) {
      resultSummary = p.summary;
    } else if (p.total !== undefined) {
      resultSummary = `总用例 ${p.total}，通过 ${p.passed}，失败 ${p.failed}`;
      if (p.bugs?.length) {
        resultSummary +=
          '\n' + p.bugs.map((b: any) => `- ${b.id}: ${b.title}`).join('\n');
      }
    }
  } catch {
    /* not JSON, use raw */
  }

  applyTransition(workflow, transition, roles, {
    delegationResult: delegation.result || '',
    resultSummary,
  });
}

// -------------------------------------------------------
// Card helpers — config-driven
// -------------------------------------------------------

const ACTION_BUTTONS: Record<string, { label: string; type?: 'primary' | 'danger' | 'default' }> = {
  approve: { label: '✅ 确认执行', type: 'primary' },
  approve_dev: { label: '✅ 直接进入开发', type: 'primary' },
  pause: { label: '⏸ 暂缓' },
  cancel: { label: '❌ 取消流程', type: 'danger' },
  resume: { label: '▶ 继续', type: 'primary' },
  revise: { label: '✏️ 提交修改' },
};

function buildConfigCard(
  workflow: Workflow,
  cardKey: string,
): InteractiveCard | null {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return null;

  const cardConfig = config.cards[cardKey];
  if (!cardConfig) return null;

  const vars = buildTemplateVars(workflow);
  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  const roleFolders = 'roles' in rolesResult ? rolesResult.roles : {};

  const header = renderTemplate(cardConfig.header_template, vars, roleFolders);
  const body = renderTemplate(cardConfig.body_template, vars, roleFolders);

  const buttons: CardButton[] = [];
  let hasRevise = false;
  for (const actionName of cardConfig.actions) {
    if (actionName === 'revise') {
      hasRevise = true;
      continue;
    }
    const btn = ACTION_BUTTONS[actionName];
    if (btn) {
      buttons.push({
        id: actionName,
        label: btn.label,
        type: btn.type,
        value: { workflow_id: workflow.id, action: actionName },
      });
    }
  }

  const card: InteractiveCard = {
    header: {
      title: header,
      color: (cardConfig.header_color || 'blue') as InteractiveCard['header']['color'],
    },
    body,
    buttons: buttons.length > 0 ? buttons : undefined,
  };

  if (hasRevise) {
    card.form = {
      name: 'revision_form',
      inputs: [{ name: 'revision_text', placeholder: '如需修改方案，请输入修改意见...' }],
      submitButton: {
        id: 'request_revision',
        label: '✏️ 提交修改',
        value: { workflow_id: workflow.id, action: 'request_revision' },
      },
    };
  }

  return card;
}

/** Send a card defined in config to the main group (scoped to workflow's source channel). */
function sendConfigCard(workflow: Workflow, cardKey: string): void {
  const { sendCard } = getDeps();
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups, workflow.source_jid);
  if (!mainJid) {
    logger.warn('Workflow: cannot send card — main group not found');
    return;
  }

  if (sendCard) {
    const card = buildConfigCard(workflow, cardKey);
    if (card) {
      sendCard(mainJid, card).catch((err) => {
        logger.error(
          { err, workflowId: workflow.id, cardKey },
          'Failed to send workflow card, falling back to text',
        );
        // Fallback: send text notification
        const config = getWorkflowTypeConfig(workflow.workflow_type);
        const cardConfig = config?.cards[cardKey];
        if (cardConfig) {
          const vars = buildTemplateVars(workflow);
          const body = renderTemplate(cardConfig.body_template, vars);
          notifyMain(
            `[流程进展] ${renderTemplate(cardConfig.header_template, vars)}\n\n${body}`,
            workflow.source_jid,
            workflow.id,
          );
        }
      });
    }
  } else {
    // Fallback: no card support
    const config = getWorkflowTypeConfig(workflow.workflow_type);
    const cardConfig = config?.cards[cardKey];
    if (cardConfig) {
      const vars = buildTemplateVars(workflow);
      const body = renderTemplate(cardConfig.body_template, vars);
      notifyMain(
        `[流程进展] ${renderTemplate(cardConfig.header_template, vars)}\n\n${body}\n\n请确认是否继续。`,
        workflow.source_jid,
        workflow.id,
      );
    }
  }
}

function buildWorkflowListCard(workflows: Workflow[]): InteractiveCard {
  const sections: CardSection[] = [];

  for (const w of workflows) {
    const config = getWorkflowTypeConfig(w.workflow_type);
    const labels = config?.status_labels || {};
    const terminalStates = config ? getTerminalStates(config) : [];

    const statusLabel =
      w.status === 'paused'
        ? `⏸ 已中断（原状态：${labels[w.paused_from || ''] || w.paused_from || '未知'}）`
        : labels[w.status] || w.status;

    const body = `**${w.id}** ${w.name} (${w.service})\n状态：${statusLabel}${w.round > 0 ? ` | Round ${w.round}` : ''}${w.branch ? `\n分支：${w.branch}` : ''}`;

    const buttons: CardButton[] = [];
    const confirmationStates = config ? getConfirmationStates(config) : [];

    if (confirmationStates.includes(w.status)) {
      buttons.push(
        { id: 'approve', label: '✅ 确认部署', type: 'primary', value: { workflow_id: w.id, action: 'approve' } },
        { id: 'pause', label: '⏸ 中断', value: { workflow_id: w.id, action: 'pause' } },
        { id: 'cancel', label: '❌ 取消', type: 'danger', value: { workflow_id: w.id, action: 'cancel' } },
      );
    } else if (w.status === 'paused') {
      buttons.push(
        { id: 'resume', label: '▶ 继续', type: 'primary', value: { workflow_id: w.id, action: 'resume' } },
        { id: 'cancel', label: '❌ 取消', type: 'danger', value: { workflow_id: w.id, action: 'cancel' } },
      );
    } else if (!terminalStates.includes(w.status)) {
      buttons.push(
        { id: 'pause', label: '⏸ 中断', value: { workflow_id: w.id, action: 'pause' } },
        { id: 'cancel', label: '❌ 取消', type: 'danger', value: { workflow_id: w.id, action: 'cancel' } },
      );
    }

    sections.push({ body, buttons: buttons.length > 0 ? buttons : undefined });
  }

  return {
    header: { title: '📊 流程列表', color: 'blue' },
    sections,
  };
}

// -------------------------------------------------------
// Cancel / Pause / Resume
// -------------------------------------------------------

export function cancelWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const terminalStates = config
    ? getTerminalStates(config)
    : ['passed', 'ops_failed', 'cancelled'];

  if (terminalStates.includes(workflow.status)) {
    return { error: `流程已结束 (${workflow.status})` };
  }
  updateWorkflow(workflowId, {
    status: 'cancelled',
    current_delegation_id: '',
  });
  notifyMain(`[流程取消] 需求「${workflow.name}」(${workflowId}) 已取消。`, workflow.source_jid, workflowId);
  return {};
}

export function pauseWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const terminalStates = config
    ? getTerminalStates(config)
    : ['passed', 'ops_failed', 'cancelled'];

  if (
    terminalStates.includes(workflow.status) ||
    workflow.status === 'paused'
  ) {
    return { error: `流程当前状态 ${workflow.status}，无法中断` };
  }
  updateWorkflow(workflowId, {
    status: 'paused',
    paused_from: workflow.status,
  });
  notifyMain(
    `[流程中断] 需求「${workflow.name}」(${workflowId}) 已中断，可随时恢复。`,
    workflow.source_jid,
    workflowId,
  );
  return {};
}

export function resumeWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };
  if (workflow.status !== 'paused' || !workflow.paused_from) {
    return { error: `流程当前状态 ${workflow.status}，不是中断状态` };
  }

  // Check if delegation completed while paused
  if (workflow.current_delegation_id) {
    const delegation = getDelegation(workflow.current_delegation_id);
    if (delegation?.status === 'completed') {
      // Agent completed work while paused — restore state then advance
      updateWorkflow(workflowId, {
        status: workflow.paused_from,
        paused_from: null,
      });
      onDelegationComplete(workflow.current_delegation_id);
      notifyMain(
        `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复，中断期间任务已完成，自动推进。`,
        workflow.source_jid,
        workflowId,
      );
      return {};
    }
    if (delegation?.status === 'pending') {
      // Agent still running — restore state, wait for natural completion
      updateWorkflow(workflowId, {
        status: workflow.paused_from,
        paused_from: null,
      });
      notifyMain(
        `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复，任务仍在执行中。`,
        workflow.source_jid,
        workflowId,
      );
      return {};
    }
  }

  // No active delegation (e.g. paused_from is a confirmation state) — restore state
  updateWorkflow(workflowId, {
    status: workflow.paused_from,
    paused_from: null,
  });
  notifyMain(`[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复。`, workflow.source_jid, workflowId);

  // If resuming to a confirmation state, resend its card
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (config) {
    const resumedStateConfig = config.states[workflow.paused_from];
    if (
      resumedStateConfig?.type === 'confirmation' &&
      resumedStateConfig.card
    ) {
      const updatedWorkflow = getWorkflow(workflowId);
      if (updatedWorkflow) {
        sendConfigCard(updatedWorkflow, resumedStateConfig.card);
      }
    }
  }
  return {};
}

// -------------------------------------------------------
// Card action handler
// -------------------------------------------------------

export function handleCardAction(action: {
  action: string;
  user_id: string;
  message_id: string;
  group_folder?: string;
  workflow_id?: string;
  form_value?: Record<string, string>;
}): void {
  logger.info({ action }, 'Handling card action');

  // Resolve source_jid from the workflow for channel-aware notifications
  const wfSourceJid = action.workflow_id
    ? getWorkflow(action.workflow_id)?.source_jid
    : undefined;

  /** Display label for notifications. */
  const getLabel = (): string => {
    if (action.workflow_id) {
      const wf = getWorkflow(action.workflow_id);
      if (wf) return `需求「${wf.name}」(${wf.id})`;
    }
    return action.workflow_id || '未知';
  };

  switch (action.action) {
    // --- Workflow-specific actions (require workflow_id) ---
    case 'approve': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID', wfSourceJid); break; }
      const result = approveWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 确认部署失败: ${result.error}`, wfSourceJid, action.workflow_id);
      break;
    }
    case 'approve_dev': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID', wfSourceJid); break; }
      const result = approveWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 进入开发失败: ${result.error}`, wfSourceJid, action.workflow_id);
      break;
    }
    case 'pause': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID', wfSourceJid); break; }
      const result = pauseWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 中断流程失败: ${result.error}`, wfSourceJid, action.workflow_id);
      break;
    }
    case 'resume': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID', wfSourceJid); break; }
      const result = resumeWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 恢复流程失败: ${result.error}`, wfSourceJid, action.workflow_id);
      break;
    }
    case 'request_revision': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID', wfSourceJid); break; }
      const revisionText = action.form_value?.revision_text;
      if (!revisionText?.trim()) { notifyMain('[操作失败] 请输入修改意见后再提交。', wfSourceJid, action.workflow_id); break; }
      const result = reviseWorkflow(action.workflow_id, `[方案修改意见]\n\n${revisionText}`);
      if (result.error) notifyMain(`[操作失败] 提交修改失败: ${result.error}`, wfSourceJid, action.workflow_id);
      break;
    }
    case 'cancel': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID', wfSourceJid); break; }
      const result = cancelWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 取消流程失败: ${result.error}`, wfSourceJid, action.workflow_id);
      break;
    }
    case 'memory_conflict_keep': {
      const folder = action.group_folder;
      const keepId = action.form_value?.keep_id;
      const deprecateId = action.form_value?.deprecate_id;
      if (!folder || !keepId || !deprecateId) {
        notifyMain('[操作失败] 记忆冲突处理缺少必要参数。', wfSourceJid);
        break;
      }
      notifyGroupFolder(
        folder,
        '记忆冲突指令',
        [
          '[记忆冲突处理] 用户已选择保留方案。',
          `请调用 memory_resolve_conflict(mode="keep", keep_id="${keepId}", deprecate_id="${deprecateId}")`,
          '完成后请反馈处理结果。',
        ].join('\n'),
      );
      break;
    }
    case 'memory_conflict_merge': {
      const folder = action.group_folder;
      const mergedContent = action.form_value?.merged_content?.trim();
      const mergeA = action.form_value?.merge_id_a;
      const mergeB = action.form_value?.merge_id_b;
      if (!folder || !mergeA || !mergeB) {
        notifyMain('[操作失败] 合并冲突缺少必要参数。', wfSourceJid);
        break;
      }
      if (!mergedContent) {
        notifyGroupFolder(folder, '记忆整理', '请填写合并内容后再提交。');
        break;
      }
      notifyGroupFolder(
        folder,
        '记忆冲突指令',
        [
          '[记忆冲突处理] 用户已选择合并方案。',
          `请调用 memory_resolve_conflict(mode="merge", merge_ids=["${mergeA}","${mergeB}"], merged_content="${mergedContent.replace(/"/g, '\\"')}")`,
          '完成后请反馈处理结果。',
        ].join('\n'),
      );
      break;
    }
    case 'memory_conflict_skip': {
      const folder = action.group_folder;
      if (!folder) {
        notifyMain('[操作失败] 缺少 group_folder。', wfSourceJid);
        break;
      }
      notifyGroupFolder(folder, '记忆整理', '已跳过该冲突，稍后可继续处理。');
      break;
    }
    default:
      logger.warn({ action: action.action }, 'Unknown card action');
  }
}

// -------------------------------------------------------
// list_workflows with card
// -------------------------------------------------------

/** Send workflow list as a card to the main group. Returns true if card was sent. */
export function sendWorkflowListCard(sourceJid?: string): boolean {
  const { sendCard } = getDeps();
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups, sourceJid);
  if (!mainJid || !sendCard) return false;

  const workflows = getAllWorkflows();
  if (workflows.length === 0) return false;

  const card = buildWorkflowListCard(workflows);
  sendCard(mainJid, card).catch((err) => {
    logger.error({ err }, 'Failed to send workflow list card');
  });
  return true;
}

/** List all active workflows (for MCP tool). */
export function listWorkflows(): ReturnType<typeof getAllActiveWorkflows> {
  return getAllActiveWorkflows();
}

/** Check if workflow engine is enabled. */
export function isWorkflowEnabled(): boolean {
  return getWorkflowConfigs() !== null;
}

/** Get the reason workflow is disabled (for diagnostics). */
export function getWorkflowDisabledReason(): string | null {
  return getWorkflowConfigError();
}

/** Get status labels for a workflow type (used by MCP tool). */
export function getStatusLabelsForType(
  workflowType: string,
): Record<string, string> {
  const config = getWorkflowTypeConfig(workflowType);
  return config?.status_labels || {};
}

/** Return summary of all available workflow types (for MCP tool). */
export function getAvailableWorkflowTypes(): Array<{
  type: string;
  name: string;
  entry_points: string[];
  entry_points_detail: Record<string, { requires_deliverable: boolean; deliverable_role?: string }>;
  role_channels: Record<string, Record<string, string>>;
}> {
  const configs = getWorkflowConfigs();
  if (!configs) return [];

  return Object.entries(configs).map(([typeName, config]) => ({
    type: typeName,
    name: config.name,
    entry_points: Object.keys(config.entry_points),
    entry_points_detail: Object.fromEntries(
      Object.entries(config.entry_points).map(([name, ep]) => [
        name,
        { requires_deliverable: ep.requires_deliverable || false, deliverable_role: ep.deliverable_role },
      ]),
    ),
    role_channels: Object.fromEntries(
      Object.entries(config.roles).map(([role, rc]) => [role, rc.channels]),
    ),
  }));
}

/** List all deliverable directories for a service (for MCP tool). */
export function listDeliverables(service: string): Array<{ dir: string; files: string[]; branch: string }> {
  const delivDir = path.join(PROJECT_ROOT, 'projects', service, 'iteration');
  if (!fs.existsSync(delivDir)) return [];

  return fs
    .readdirSync(delivDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dirPath = path.join(delivDir, d.name);
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));

      let branch = '';
      for (const file of files) {
        const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
        const match = content.match(/工作分支[：:]\s*(.+)/);
        if (match) {
          branch = match[1].trim();
          break;
        }
      }

      return { dir: d.name, files, branch };
    })
    .filter((d) => d.files.length > 0)
    .sort((a, b) => b.dir.localeCompare(a.dir)); // newest first
}
