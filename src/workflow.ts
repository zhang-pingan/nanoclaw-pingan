/**
 * Workflow Engine for NanoClaw
 *
 * State machine: dev → awaiting_confirm → ops_deploy → testing
 *                                                       ├→ passed (terminal)
 *                                                       └→ fixing → ops_deploy → testing (loop)
 *                                          ops_failed (terminal)
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

export interface WorkflowDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  enqueueMessageCheck: (groupJid: string) => void;
}

let deps: WorkflowDeps | null = null;

export function initWorkflow(d: WorkflowDeps): void {
  deps = d;
}

function getDeps(): WorkflowDeps {
  if (!deps) throw new Error('Workflow not initialized — call initWorkflow()');
  return deps;
}

/** Write a plan_mode marker to the group's IPC directory. The host reads and deletes it before spawning the container. */
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

/** Inject a message into a group's chat to trigger the agent. */
function injectDelegation(
  targetJid: string,
  targetGroup: RegisteredGroup,
  sourceFolder: string,
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
    sourceFolder,
    delegationId,
    workflowId,
    skillName,
    taskContent,
  );

  return delegationId;
}

/** Read the latest deliverable document from feishu_dev for a given service. */
function readLatestDeliverable(
  service: string,
): { content: string; branch: string; fileName: string } | null {
  const delivDir = path.join(GROUPS_DIR, 'feishu_dev', 'deliverables', service);
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
  const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const groups = getDeps().registeredGroups();

  if (opts.startFrom === 'dev') {
    // Create workflow in dev status, delegate to feishu_dev
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

    const mainFolder =
      Object.values(groups).find((g) => g.isMain)?.folder || 'feishu_main';

    try {
      // Enable plan mode: agent will first generate a plan (read-only),
      // then automatically execute it in a second phase (full permissions)
      writePlanModeMarker('feishu_dev');

      const delegationId = delegateTo(
        'feishu_dev',
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
      `[流程启动] 需求「${opts.name}」开发流程已创建 (${workflowId})，已委派 feishu_dev 开始开发。`,
    );

    return { workflowId };
  }

  // startFrom === 'testing'
  const deliverable = readLatestDeliverable(opts.service);
  if (!deliverable) {
    return {
      workflowId,
      error: `未找到服务 ${opts.service} 的交付文档 (groups/feishu_dev/deliverables/${opts.service}/)`,
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
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };
  if (workflow.status !== 'awaiting_confirm') {
    return {
      error: `流程 ${workflowId} 当前状态为 ${workflow.status}，不是 awaiting_confirm`,
    };
  }

  const mainFolder =
    Object.values(getDeps().registeredGroups()).find((g) => g.isMain)?.folder ||
    'feishu_main';

  // Move to ops_deploy, delegate to feishu_ops
  try {
    const delegationId = delegateTo(
      'feishu_ops',
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
    `[流程进展] 需求「${workflow.name}」(${workflowId}) 已确认，正在委派 feishu_ops 部署预发环境。`,
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

  const delegation = getDelegation(delegationId);
  if (!delegation) return;

  const groups = getDeps().registeredGroups();
  const mainFolder =
    Object.values(groups).find((g) => g.isMain)?.folder || 'feishu_main';

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
      // Dev completed → extract branch/deliverable info → awaiting_confirm
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
      // Check deployment result
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

      // Deployment succeeded → delegate to feishu_test
      try {
        // Read the deliverable to send to test
        const deliverable = readLatestDeliverable(workflow.service);
        const deliverableContent = deliverable?.content || '交付文档未找到';

        const delegId = delegateTo(
          'feishu_test',
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
        `[流程进展] 需求「${workflow.name}」(${workflow.id}) 预发部署成功 ✅，已委派 feishu_test 开始测试。`,
      );
      break;
    }

    case 'testing': {
      // Check test results
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

      // Has failures → delegate fix to feishu_dev
      const newRound = workflow.round + 1;
      try {
        const delegId = delegateTo(
          'feishu_dev',
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
        `[流程进展] 需求「${workflow.name}」(${workflow.id}) 测试发现问题 ❌，进入 Round ${newRound} 修复流程，已委派 feishu_dev 修复。`,
      );
      break;
    }

    case 'fixing': {
      // Fix completed → re-deploy via feishu_ops
      try {
        const delegId = delegateTo(
          'feishu_ops',
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
        `[流程进展] 需求「${workflow.name}」(${workflow.id}) Round ${workflow.round} 修复完成，已委派 feishu_ops 重新部署预发。`,
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
