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
import { FeishuCard, RegisteredGroup, Workflow } from './types.js';
import {
  getWorkflowConfigs,
  getWorkflowTypeConfig,
  loadWorkflowConfigs,
  renderTemplate,
  StateTransition,
  TemplateVars,
  WorkflowTypeConfig,
} from './workflow-config.js';

// -------------------------------------------------------
// Role resolution — per workflow type
// -------------------------------------------------------

/**
 * Resolved roles for each workflow type.
 * Key: workflow type name (e.g. "dev_test")
 * Value: mapping of role name → group folder (e.g. { dev: "feishu_dev", ops: "feishu_ops" })
 */
let allResolvedRoles: Record<string, Record<string, string>> = {};
let roleResolutionError: string | null = null;

/**
 * Resolve roles for all configured workflow types from skills.json.
 * For each workflow type, builds a skill_key → role_name reverse map,
 * then scans skills.json assignments to find folders.
 */
function resolveRolesForAllTypes(): void {
  const configs = getWorkflowConfigs();
  if (!configs) {
    roleResolutionError = 'Workflow 未启用：workflows.json 未加载';
    return;
  }

  const skillsPath = path.join(
    process.cwd(),
    'container',
    'skills',
    'skills.json',
  );

  if (!fs.existsSync(skillsPath)) {
    roleResolutionError =
      'Workflow 未启用：未找到 container/skills/skills.json';
    logger.info(roleResolutionError);
    return;
  }

  let skillsConfig: Record<string, string[] | Record<string, string>>;
  try {
    skillsConfig = JSON.parse(fs.readFileSync(skillsPath, 'utf-8'));
  } catch (err) {
    roleResolutionError = `Workflow 未启用：skills.json 解析失败 — ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(roleResolutionError);
    return;
  }

  // Priority 1: explicit workflow_roles
  const explicit = skillsConfig['workflow_roles'] as
    | Record<string, string>
    | undefined;

  // Build a global skill_key → folder mapping from skills.json assignments
  const skillKeyToFolder: Record<string, string> = {};
  for (const [folder, skills] of Object.entries(skillsConfig)) {
    if (folder === 'global' || folder === 'workflow_roles') continue;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (!skillKeyToFolder[skill]) {
        skillKeyToFolder[skill] = folder;
      }
    }
  }

  let anyTypeFullyResolved = false;

  for (const [typeName, config] of Object.entries(configs)) {
    const roles: Record<string, string> = {};
    const missing: string[] = [];

    for (const [roleName, roleConfig] of Object.entries(config.roles)) {
      // Priority 1: explicit mapping
      if (explicit && explicit[roleName]) {
        roles[roleName] = explicit[roleName];
        continue;
      }
      // Priority 2: infer from skill assignments
      const folder = skillKeyToFolder[roleConfig.skill_to_role_key];
      if (folder) {
        roles[roleName] = folder;
      } else {
        missing.push(
          `${roleName} (需要 ${roleConfig.skill_to_role_key} skill)`,
        );
      }
    }

    if (missing.length > 0) {
      logger.info(
        { typeName, missing },
        `Workflow type "${typeName}" 缺少角色: ${missing.join(', ')}`,
      );
    } else {
      allResolvedRoles[typeName] = roles;
      anyTypeFullyResolved = true;
      logger.info(
        { typeName, roles },
        `Workflow type "${typeName}" roles resolved`,
      );
    }
  }

  if (!anyTypeFullyResolved) {
    roleResolutionError = `Workflow 未启用：所有 workflow 类型都缺少角色。请在 skills.json 中配置对应 skill 或添加 workflow_roles。`;
    logger.info(roleResolutionError);
  }
}

/** Get resolved roles for a specific workflow type. */
function getRolesForType(
  workflowType: string,
): { roles: Record<string, string> } | { error: string } {
  const roles = allResolvedRoles[workflowType];
  if (roles) return { roles };
  return {
    error:
      roleResolutionError ||
      `Workflow type "${workflowType}" 角色未解析或缺少配置`,
  };
}

/** Check if any workflow type is available. */
function hasAnyRoles(): boolean {
  return Object.keys(allResolvedRoles).length > 0;
}

// -------------------------------------------------------
// Dependencies
// -------------------------------------------------------

export interface WorkflowDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  enqueueMessageCheck: (groupJid: string) => void;
  sendCard?: (jid: string, card: FeishuCard) => Promise<string | undefined>;
}

let deps: WorkflowDeps | null = null;

export function initWorkflow(d: WorkflowDeps): void {
  deps = d;
  loadWorkflowConfigs();
  resolveRolesForAllTypes();
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

/** Find the main group's JID. */
function findMainJid(
  groups: Record<string, RegisteredGroup>,
): string | undefined {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return jid;
  }
  return undefined;
}

/** Get the main group's folder name. */
function getMainFolder(): string {
  const groups = getDeps().registeredGroups();
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
  });

  enqueueMessageCheck(targetJid);
}

/** Send a progress message to the main group. */
function notifyMain(message: string): void {
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups);
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
  });

  getDeps().enqueueMessageCheck(mainJid);
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
    requester_jid: null,
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

/** Role name → deliverable filename inside the folder. */
const ROLE_DELIVERABLE_FILE: Record<string, string> = {
  planner: 'plan.md',
  dev: 'dev.md',
  test: 'test.md',
};

/** Read deliverable metadata from the shared projects directory.
 *  Directory layout: projects/{service}/iteration/{folderName}/{role}.md
 *  Scans for the latest sub-directory containing the role's file (used by entry points). */
function readLatestDeliverable(
  service: string,
  role: string,
): { branch: string; fileName: string } | null {
  const roleFile = ROLE_DELIVERABLE_FILE[role] || `${role}.md`;
  const delivDir = path.join(PROJECT_ROOT, 'projects', service, 'iteration');
  if (!fs.existsSync(delivDir)) return null;

  const dirs = fs
    .readdirSync(delivDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  for (const dir of dirs) {
    const filePath = path.join(delivDir, dir, roleFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const branchMatch = content.match(/工作分支[：:]\s*(.+)/);
      const branch = branchMatch ? branchMatch[1].trim() : '';
      return { branch, fileName: dir };
    }
  }

  return null;
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

  const mainFolder = getMainFolder();
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
    notifyMain(renderTemplate(transition.notify, vars, roles));
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
  const rolesResult = getRolesForType(workflowType);
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
  const mainFolder = getMainFolder();

  // If entry point requires deliverable, read it first
  if (entryPoint.requires_deliverable) {
    const deliverable = readLatestDeliverable(opts.service, 'dev');
    if (!deliverable) {
      return {
        workflowId,
        error: `未找到服务 ${opts.service} 的交付文档 (projects/${opts.service}/iteration/)`,
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

    // If entry state is a confirmation state, send the card
    const entryStateConfig = config.states[entryPoint.state];
    if (entryStateConfig?.type === 'confirmation' && entryStateConfig.card) {
      const createdWorkflow = getWorkflow(workflowId);
      if (createdWorkflow) {
        sendConfigCard(createdWorkflow, entryStateConfig.card);
      }
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

  const rolesResult = getRolesForType(workflow.workflow_type);
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

  const rolesResult = getRolesForType(workflow.workflow_type);
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

  const rolesResult = getRolesForType(workflow.workflow_type);
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

const ACTION_BUTTONS: Record<string, { label: string; type?: string }> = {
  approve: { label: '✅ 确认执行', type: 'primary' },
  pause: { label: '⏸ 暂缓' },
  cancel: { label: '❌ 取消流程', type: 'danger' },
  resume: { label: '▶ 继续', type: 'primary' },
  revise: { label: '✏️ 提交修改' },
};

function buildConfigCard(
  workflow: Workflow,
  cardKey: string,
): FeishuCard | null {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return null;

  const cardConfig = config.cards[cardKey];
  if (!cardConfig) return null;

  const vars = buildTemplateVars(workflow);
  const roleFolders = allResolvedRoles[workflow.workflow_type] || {};

  const header = renderTemplate(cardConfig.header_template, vars, roleFolders);
  const body = renderTemplate(cardConfig.body_template, vars, roleFolders);

  const actions: unknown[] = [];
  let hasRevise = false;
  for (const actionName of cardConfig.actions) {
    if (actionName === 'revise') {
      hasRevise = true;
      continue; // revise is rendered as a form below, not a regular button
    }
    const btn = ACTION_BUTTONS[actionName];
    if (btn) {
      const button: Record<string, unknown> = {
        tag: 'button',
        text: { tag: 'plain_text', content: btn.label },
        value: { workflow_id: workflow.id, action: actionName },
      };
      if (btn.type) button.type = btn.type;
      actions.push(button);
    }
  }

  const elements: unknown[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: body },
    },
    ...(actions.length > 0 ? [{ tag: 'action', actions }] : []),
  ];

  // Append revision form if the card has a "revise" action
  if (hasRevise) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'form',
        name: 'revision_form',
        elements: [
          {
            tag: 'input',
            name: 'revision_text',
            placeholder: { tag: 'plain_text', content: '如需修改方案，请输入修改意见...' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✏️ 提交修改' },
            value: { workflow_id: workflow.id, action: 'request_revision' },
          },
        ],
      },
    );
  }

  return {
    header: { title: header, template: cardConfig.header_color || 'blue' },
    elements,
  };
}

/** Send a card defined in config to the main group. */
function sendConfigCard(workflow: Workflow, cardKey: string): void {
  const { sendCard } = getDeps();
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups);
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
      );
    }
  }
}

function buildWorkflowListCard(workflows: Workflow[]): FeishuCard {
  const elements: unknown[] = [];

  for (const w of workflows) {
    const config = getWorkflowTypeConfig(w.workflow_type);
    const labels = config?.status_labels || {};
    const terminalStates = config ? getTerminalStates(config) : [];

    const statusLabel =
      w.status === 'paused'
        ? `⏸ 已中断（原状态：${labels[w.paused_from || ''] || w.paused_from || '未知'}）`
        : labels[w.status] || w.status;

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${w.id}** ${w.name} (${w.service})\n状态：${statusLabel}${w.round > 0 ? ` | Round ${w.round}` : ''}${w.branch ? `\n分支：${w.branch}` : ''}`,
      },
    });

    // Add action buttons based on status
    const actions: unknown[] = [];
    const confirmationStates = config ? getConfirmationStates(config) : [];

    if (confirmationStates.includes(w.status)) {
      actions.push(
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 确认部署' },
          type: 'primary',
          value: { workflow_id: w.id, action: 'approve' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '⏸ 中断' },
          value: { workflow_id: w.id, action: 'pause' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 取消' },
          type: 'danger',
          value: { workflow_id: w.id, action: 'cancel' },
        },
      );
    } else if (w.status === 'paused') {
      actions.push(
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '▶ 继续' },
          type: 'primary',
          value: { workflow_id: w.id, action: 'resume' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 取消' },
          type: 'danger',
          value: { workflow_id: w.id, action: 'cancel' },
        },
      );
    } else if (!terminalStates.includes(w.status)) {
      actions.push(
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '⏸ 中断' },
          value: { workflow_id: w.id, action: 'pause' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 取消' },
          type: 'danger',
          value: { workflow_id: w.id, action: 'cancel' },
        },
      );
    }

    if (actions.length > 0) {
      elements.push({ tag: 'action', actions });
    }

    elements.push({ tag: 'hr' });
  }

  // Remove trailing hr
  if (
    elements.length > 0 &&
    (elements[elements.length - 1] as any)?.tag === 'hr'
  ) {
    elements.pop();
  }

  return {
    header: { title: '📊 流程列表', template: 'blue' },
    elements,
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
  notifyMain(`[流程取消] 需求「${workflow.name}」(${workflowId}) 已取消。`);
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
      );
      return {};
    }
  }

  // No active delegation (e.g. paused_from is a confirmation state) — restore state
  updateWorkflow(workflowId, {
    status: workflow.paused_from,
    paused_from: null,
  });
  notifyMain(`[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复。`);

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
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID'); break; }
      const result = approveWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 确认部署失败: ${result.error}`);
      break;
    }
    case 'pause': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID'); break; }
      const result = pauseWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 中断流程失败: ${result.error}`);
      break;
    }
    case 'resume': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID'); break; }
      const result = resumeWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 恢复流程失败: ${result.error}`);
      break;
    }
    case 'request_revision': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID'); break; }
      const revisionText = action.form_value?.revision_text;
      if (!revisionText?.trim()) { notifyMain('[操作失败] 请输入修改意见后再提交。'); break; }
      const result = reviseWorkflow(action.workflow_id, `[方案修改意见]\n\n${revisionText}`);
      if (result.error) notifyMain(`[操作失败] 提交修改失败: ${result.error}`);
      break;
    }
    case 'cancel': {
      if (!action.workflow_id) { notifyMain('[操作失败] 缺少流程 ID'); break; }
      const result = cancelWorkflow(action.workflow_id);
      if (result.error) notifyMain(`[操作失败] 取消流程失败: ${result.error}`);
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
export function sendWorkflowListCard(): boolean {
  const { sendCard } = getDeps();
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups);
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
  return hasAnyRoles();
}

/** Get the reason workflow is disabled (for diagnostics). */
export function getWorkflowDisabledReason(): string | null {
  return roleResolutionError;
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
  roles: Record<string, string>;
  roles_resolved: boolean;
}> {
  const configs = getWorkflowConfigs();
  if (!configs) return [];

  return Object.entries(configs).map(([typeName, config]) => {
    const resolved = allResolvedRoles[typeName];
    return {
      type: typeName,
      name: config.name,
      entry_points: Object.keys(config.entry_points),
      roles: resolved || {},
      roles_resolved: !!resolved,
    };
  });
}
