/**
 * Workflow Engine for NanoClaw
 *
 * State machine: dev → awaiting_confirm → ops_deploy → testing
 *                                                       ├→ passed (terminal)
 *                                                       └→ fixing → ops_deploy → testing (loop)
 *                                          ops_failed (terminal)
 *
 * Role resolution (no hardcoded group names):
 *   1. skills.json "workflow_roles" explicit mapping (if present)
 *   2. Infer from skill assignments: dev-requirement → dev, ops-staging-deploy → ops, test-requirement → test
 *   3. If any role is missing → workflow is disabled, create_workflow returns a friendly message
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  createDelegation,
  createWorkflow as dbCreateWorkflow,
  getAllActiveWorkflows,
  getDelegation,
  getWorkflow,
  getWorkflowByDelegation,
  storeChatMetadata,
  storeMessageDirect,
  updateWorkflow,
} from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// -------------------------------------------------------
// Role resolution
// -------------------------------------------------------

/** Skill → workflow role mapping for auto-detection */
const SKILL_TO_ROLE: Record<string, 'dev' | 'ops' | 'test'> = {
  'dev-requirement': 'dev',
  'ops-staging-deploy': 'ops',
  'test-requirement': 'test',
};

interface WorkflowRoles {
  dev: string; // group folder for dev role
  ops: string; // group folder for ops role
  test: string; // group folder for test role
}

let resolvedRoles: WorkflowRoles | null = null;
let roleResolutionError: string | null = null;

/** Resolve workflow roles from skills.json. Called once at init. */
function resolveRoles(): void {
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
  const roles: Partial<WorkflowRoles> = {};

  if (explicit && typeof explicit === 'object') {
    if (explicit.dev) roles.dev = explicit.dev;
    if (explicit.ops) roles.ops = explicit.ops;
    if (explicit.test) roles.test = explicit.test;
  }

  // Priority 2: infer from skill assignments
  for (const [folder, skills] of Object.entries(skillsConfig)) {
    if (folder === 'global' || folder === 'workflow_roles') continue;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      const role = SKILL_TO_ROLE[skill];
      if (role && !roles[role]) {
        roles[role] = folder;
      }
    }
  }

  // Check completeness
  const missing: string[] = [];
  if (!roles.dev) missing.push('dev (需要 dev-requirement skill)');
  if (!roles.ops) missing.push('ops (需要 ops-staging-deploy skill)');
  if (!roles.test) missing.push('test (需要 test-requirement skill)');

  if (missing.length > 0) {
    roleResolutionError = `Workflow 未启用：缺少角色 ${missing.join(', ')}。请在 skills.json 中配置对应 skill 或添加 workflow_roles。`;
    logger.info(roleResolutionError);
    return;
  }

  resolvedRoles = roles as WorkflowRoles;
  logger.info(
    {
      dev: resolvedRoles.dev,
      ops: resolvedRoles.ops,
      test: resolvedRoles.test,
    },
    'Workflow roles resolved',
  );
}

/** Get resolved roles, or return the error message if not available. */
function getRoles(): { roles: WorkflowRoles } | { error: string } {
  if (resolvedRoles) return { roles: resolvedRoles };
  return {
    error: roleResolutionError || 'Workflow 未初始化',
  };
}

// -------------------------------------------------------
// Dependencies
// -------------------------------------------------------

export interface WorkflowDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  enqueueMessageCheck: (groupJid: string) => void;
}

let deps: WorkflowDeps | null = null;

export function initWorkflow(d: WorkflowDeps): void {
  deps = d;
  resolveRoles();
}

function getDeps(): WorkflowDeps {
  if (!deps) throw new Error('Workflow not initialized — call initWorkflow()');
  return deps;
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/** Write a plan_mode marker to the group's IPC directory. */
function writePlanModeMarker(groupFolder: string): void {
  const markerPath = path.join(DATA_DIR, 'ipc', groupFolder, 'plan_mode');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, '1');
}

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

/** Read the latest deliverable document from the dev group for a given service. */
function readLatestDeliverable(
  service: string,
): { content: string; branch: string; fileName: string } | null {
  const rolesResult = getRoles();
  if ('error' in rolesResult) return null;

  const delivDir = path.join(
    GROUPS_DIR,
    rolesResult.roles.dev,
    'deliverables',
    service,
  );
  if (!fs.existsSync(delivDir)) return null;

  const files = fs
    .readdirSync(delivDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const content = fs.readFileSync(path.join(delivDir, files[0]), 'utf-8');

  // Extract branch from "- 工作分支：{branch}" pattern
  const branchMatch = content.match(/工作分支[：:]\s*(.+)/);
  const branch = branchMatch ? branchMatch[1].trim() : '';

  return { content, branch, fileName: files[0] };
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

export interface CreateWorkflowOpts {
  name: string;
  service: string;
  sourceJid: string;
  startFrom: 'dev' | 'testing';
}

export function createNewWorkflow(opts: CreateWorkflowOpts): {
  workflowId: string;
  error?: string;
} {
  // Check if workflow is enabled
  const rolesResult = getRoles();
  if ('error' in rolesResult) {
    return { workflowId: '', error: rolesResult.error };
  }
  const roles = rolesResult.roles;

  const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const mainFolder = getMainFolder();

  if (opts.startFrom === 'dev') {
    dbCreateWorkflow({
      id: workflowId,
      name: opts.name,
      service: opts.service,
      branch: '',
      deliverable: '',
      status: 'dev',
      current_delegation_id: '',
      round: 0,
      source_jid: opts.sourceJid,
      created_at: now,
      updated_at: now,
    });

    try {
      writePlanModeMarker(roles.dev);

      const delegationId = delegateTo(
        roles.dev,
        mainFolder,
        workflowId,
        'dev-requirement',
        `请开发以下需求：\n\n需求名称：${opts.name}\n服务名称：${opts.service}`,
      );
      updateWorkflow(workflowId, { current_delegation_id: delegationId });
    } catch (err) {
      logger.error({ err, workflowId }, 'Failed to delegate dev task');
      return {
        workflowId,
        error: `委派开发任务失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    notifyMain(
      `[流程启动] 需求「${opts.name}」开发流程已创建 (${workflowId})，已委派 ${roles.dev} 开始开发。`,
    );

    return { workflowId };
  }

  // startFrom === 'testing'
  const deliverable = readLatestDeliverable(opts.service);
  if (!deliverable) {
    return {
      workflowId,
      error: `未找到服务 ${opts.service} 的交付文档 (groups/${roles.dev}/deliverables/${opts.service}/)`,
    };
  }

  dbCreateWorkflow({
    id: workflowId,
    name: opts.name,
    service: opts.service,
    branch: deliverable.branch,
    deliverable: deliverable.fileName,
    status: 'awaiting_confirm',
    current_delegation_id: '',
    round: 0,
    source_jid: opts.sourceJid,
    created_at: now,
    updated_at: now,
  });

  notifyMain(
    `[流程启动] 需求「${opts.name}」测试流程已创建 (${workflowId})。\n\n已读取交付文档：${deliverable.fileName}\n工作分支：${deliverable.branch}\n\n请确认是否开始自动化测试（调用 approve_workflow 工具，workflow_id 为 "${workflowId}"）。`,
  );

  return { workflowId };
}

export function approveWorkflow(workflowId: string): { error?: string } {
  const rolesResult = getRoles();
  if ('error' in rolesResult) return { error: rolesResult.error };
  const roles = rolesResult.roles;

  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };
  if (workflow.status !== 'awaiting_confirm') {
    return {
      error: `流程 ${workflowId} 当前状态为 ${workflow.status}，不是 awaiting_confirm`,
    };
  }

  const mainFolder = getMainFolder();

  try {
    const delegationId = delegateTo(
      roles.ops,
      mainFolder,
      workflowId,
      'ops-staging-deploy',
      `请部署以下服务到预发环境：\n\n服务名称：${workflow.service}\n工作分支：${workflow.branch}`,
    );
    updateWorkflow(workflowId, {
      status: 'ops_deploy',
      current_delegation_id: delegationId,
    });
  } catch (err) {
    logger.error({ err, workflowId }, 'Failed to delegate ops task');
    return {
      error: `委派部署任务失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  notifyMain(
    `[流程进展] 需求「${workflow.name}」(${workflowId}) 已确认，正在委派 ${roles.ops} 部署预发环境。`,
  );

  return {};
}

/**
 * Called when a delegation completes. Checks if it belongs to a workflow
 * and advances the state machine accordingly.
 */
export function onDelegationComplete(delegationId: string): void {
  const workflow = getWorkflowByDelegation(delegationId);
  if (!workflow) return; // Not a workflow delegation

  const rolesResult = getRoles();
  if ('error' in rolesResult) return; // Workflow disabled
  const roles = rolesResult.roles;

  const delegation = getDelegation(delegationId);
  if (!delegation) return;

  const mainFolder = getMainFolder();

  logger.info(
    {
      workflowId: workflow.id,
      delegationId,
      currentStatus: workflow.status,
      result: delegation.result?.slice(0, 100),
    },
    'Workflow delegation completed',
  );

  switch (workflow.status) {
    case 'dev': {
      const deliverable = readLatestDeliverable(workflow.service);
      const branch = deliverable?.branch || '';

      updateWorkflow(workflow.id, {
        status: 'awaiting_confirm',
        branch,
        deliverable: deliverable?.fileName || '',
        current_delegation_id: '',
      });

      notifyMain(
        `[流程进展] 需求「${workflow.name}」(${workflow.id}) 开发已完成！\n\n工作分支：${branch}\n交付文档：${deliverable?.fileName || '未找到'}\n\n请确认是否开始自动化测试（调用 approve_workflow 工具，workflow_id 为 "${workflow.id}"）。`,
      );
      break;
    }

    case 'ops_deploy': {
      const result = delegation.result || '';
      const isFailure =
        result.includes('失败') ||
        result.includes('fail') ||
        result.includes('error') ||
        result.includes('冲突');

      if (isFailure) {
        updateWorkflow(workflow.id, {
          status: 'ops_failed',
          current_delegation_id: '',
        });
        notifyMain(
          `[流程终止] 需求「${workflow.name}」(${workflow.id}) 预发部署失败 ❌\n\n${result}`,
        );
        break;
      }

      try {
        const deliverable = readLatestDeliverable(workflow.service);
        const deliverableContent = deliverable?.content || '交付文档未找到';

        const delegId = delegateTo(
          roles.test,
          mainFolder,
          workflow.id,
          'test-requirement',
          `请对以下需求进行测试：\n\n服务名称：${workflow.service}\n\n交付文档内容：\n${deliverableContent}`,
        );
        updateWorkflow(workflow.id, {
          status: 'testing',
          current_delegation_id: delegId,
        });
      } catch (err) {
        logger.error(
          { err, workflowId: workflow.id },
          'Failed to delegate test task',
        );
        notifyMain(
          `[流程异常] 需求「${workflow.name}」(${workflow.id}) 委派测试任务失败。`,
        );
        break;
      }

      notifyMain(
        `[流程进展] 需求「${workflow.name}」(${workflow.id}) 预发部署成功 ✅，已委派 ${roles.test} 开始测试。`,
      );
      break;
    }

    case 'testing': {
      const result = delegation.result || '';
      const hasFailures =
        result.includes('❌') ||
        result.includes('失败') ||
        result.includes('BUG-');

      if (!hasFailures) {
        updateWorkflow(workflow.id, {
          status: 'passed',
          current_delegation_id: '',
        });
        notifyMain(
          `[流程完成] 需求「${workflow.name}」(${workflow.id}) 测试全部通过 ✅，可以准备上线！`,
        );
        break;
      }

      const newRound = workflow.round + 1;
      try {
        const delegId = delegateTo(
          roles.dev,
          mainFolder,
          workflow.id,
          'dev-bugfix',
          `请修复以下测试发现的问题（Round ${newRound}）：\n\n服务名称：${workflow.service}\n工作分支：${workflow.branch}\n\n测试报告：\n${result}`,
        );
        updateWorkflow(workflow.id, {
          status: 'fixing',
          current_delegation_id: delegId,
          round: newRound,
        });
      } catch (err) {
        logger.error(
          { err, workflowId: workflow.id },
          'Failed to delegate fix task',
        );
        notifyMain(
          `[流程异常] 需求「${workflow.name}」(${workflow.id}) 委派修复任务失败。`,
        );
        break;
      }

      notifyMain(
        `[流程进展] 需求「${workflow.name}」(${workflow.id}) 测试发现问题 ❌，进入 Round ${newRound} 修复流程，已委派 ${roles.dev} 修复。`,
      );
      break;
    }

    case 'fixing': {
      try {
        const delegId = delegateTo(
          roles.ops,
          mainFolder,
          workflow.id,
          'ops-staging-deploy',
          `请部署以下服务到预发环境（修复后重新部署）：\n\n服务名称：${workflow.service}\n工作分支：${workflow.branch}`,
        );
        updateWorkflow(workflow.id, {
          status: 'ops_deploy',
          current_delegation_id: delegId,
        });
      } catch (err) {
        logger.error(
          { err, workflowId: workflow.id },
          'Failed to delegate redeploy task',
        );
        notifyMain(
          `[流程异常] 需求「${workflow.name}」(${workflow.id}) 委派重新部署任务失败。`,
        );
        break;
      }

      notifyMain(
        `[流程进展] 需求「${workflow.name}」(${workflow.id}) Round ${workflow.round} 修复完成，已委派 ${roles.ops} 重新部署预发。`,
      );
      break;
    }

    default:
      logger.warn(
        { workflowId: workflow.id, status: workflow.status },
        'Unexpected workflow status on delegation complete',
      );
  }
}

/** List all active workflows (for MCP tool). */
export function listWorkflows(): ReturnType<typeof getAllActiveWorkflows> {
  return getAllActiveWorkflows();
}

/** Check if workflow engine is enabled. */
export function isWorkflowEnabled(): boolean {
  return resolvedRoles !== null;
}

/** Get the reason workflow is disabled (for diagnostics). */
export function getWorkflowDisabledReason(): string | null {
  return roleResolutionError;
}
