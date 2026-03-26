import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';

/** Format a Date to a local timezone string without T/Z (e.g., "2026-03-26 12:05:00") */
function formatLocalTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}
import {
  createNewWorkflow,
  getAvailableWorkflowTypes,
  listWorkflows,
  onDelegationComplete as onWorkflowDelegationComplete,
  sendWorkflowListCard,
} from './workflow.js';
import { AvailableGroup } from './container-runner.js';
import {
  createDelegation,
  createTask,
  deleteTask,
  getDelegation,
  getTaskById,
  searchMessages,
  storeChatMetadata,
  storeMessageDirect,
  updateDelegation,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { InteractiveCard, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  enqueueMessageCheck: (groupJid: string) => void;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
  sendFile?: (jid: string, filePath: string, caption?: string) => Promise<void>;
  reloadContainer?: (jid: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'file' && data.chatJid && data.filePath) {
                // Authorization: same as message
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Map container path to host path
                  const containerPrefix = '/workspace/group/';
                  if (
                    typeof data.filePath !== 'string' ||
                    !data.filePath.startsWith(containerPrefix)
                  ) {
                    logger.warn(
                      { filePath: data.filePath, sourceGroup },
                      'IPC file path must start with /workspace/group/',
                    );
                  } else {
                    const relativePath = data.filePath.slice(
                      containerPrefix.length,
                    );
                    const hostPath = path.resolve(
                      path.join(GROUPS_DIR, sourceGroup, relativePath),
                    );
                    // Prevent directory traversal
                    const expectedPrefix = path.resolve(
                      path.join(GROUPS_DIR, sourceGroup),
                    );
                    if (!hostPath.startsWith(expectedPrefix + path.sep) && hostPath !== expectedPrefix) {
                      logger.warn(
                        { filePath: data.filePath, hostPath, sourceGroup },
                        'IPC file path traversal attempt blocked',
                      );
                    } else if (!fs.existsSync(hostPath)) {
                      logger.warn(
                        { hostPath, sourceGroup },
                        'IPC file does not exist on host',
                      );
                    } else if (deps.sendFile) {
                      await deps.sendFile(
                        data.chatJid,
                        hostPath,
                        data.caption,
                      );
                      logger.info(
                        { chatJid: data.chatJid, hostPath, sourceGroup },
                        'IPC file sent',
                      );
                    } else {
                      // Fallback: send caption text if channel doesn't support files
                      await deps.sendMessage(
                        data.chatJid,
                        data.caption || `[文件: ${path.basename(hostPath)}] (该渠道不支持发送文件)`,
                      );
                      logger.info(
                        { chatJid: data.chatJid, sourceGroup },
                        'IPC file fallback to text (sendFile not supported)',
                      );
                    }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

interface ConversationSearchResult {
  file: string;
  snippet: string;
}

/**
 * Search conversations/ markdown files for a group by keyword.
 */
function searchConversations(
  groupFolder: string,
  query: string,
  limit: number = 10,
): ConversationSearchResult[] {
  const conversationsDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  if (!fs.existsSync(conversationsDir)) return [];

  const results: ConversationSearchResult[] = [];
  const queryLower = query.toLowerCase();

  try {
    const files = fs
      .readdirSync(conversationsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse(); // newest first

    for (const file of files) {
      if (results.length >= limit) break;
      const filePath = path.join(conversationsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) break;
          if (lines[i].toLowerCase().includes(queryLower)) {
            // Extract context: 1 line before and 1 line after
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length, i + 2);
            const snippet = lines.slice(start, end).join('\n');
            results.push({ file, snippet });
          }
        }
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* directory read error */
  }

  return results;
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    description?: string;
    // For memory_search
    query?: string;
    limit?: number;
    requestId?: string;
    // For delegate_task / complete_delegation / request_delegation
    delegationId?: string;
    targetGroupJid?: string;
    requesterJid?: string;
    task?: string;
    result?: string;
    // For workflow
    service?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = formatLocalTime(interval.next().toDate());
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = formatLocalTime(new Date(Date.now() + ms));
        } else if (scheduleType === 'once') {
          // Node.js Date parses naive strings as local time.
          const date = new Date(data.schedule_value ?? '');
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = formatLocalTime(date);
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: formatLocalTime(new Date()),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = formatLocalTime(interval.next().toDate());
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = formatLocalTime(new Date(Date.now() + ms));
            }
          } else if (updatedTask.schedule_type === 'once') {
            const date = new Date(updatedTask.schedule_value ?? '');
            if (!isNaN(date.getTime())) {
              updates.next_run = formatLocalTime(date);
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          description: data.description,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'request_delegation': {
      // Non-main groups request delegation via the main group
      if (isMain) {
        logger.warn(
          { sourceGroup },
          'Main group should use delegate_task directly, not request_delegation',
        );
        break;
      }

      if (!data.task) {
        logger.warn(
          { sourceGroup },
          'request_delegation missing task',
        );
        break;
      }

      // Find main group JID
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      if (!mainEntry) {
        logger.warn('request_delegation: main group not found');
        break;
      }
      const [mainJid, mainGroup] = mainEntry;

      // Find source group name
      const reqSourceEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === sourceGroup,
      );
      const reqSourceName = reqSourceEntry?.[1]?.name || sourceGroup;

      // Construct synthetic message to main group
      const reqTrigger = mainGroup.trigger;
      const requesterJid = reqSourceEntry?.[0] || '';
      const reqContent = `${reqTrigger} [委派请求 | 来自:${reqSourceName}]\n\n${data.task}\n\n请根据 available_groups.json 判断是否需要委派，以及委派给哪个群。如需委派请使用 delegate_task，并传入 requester_jid="${requesterJid}" 以便完成后自动通知请求方。`;
      const reqMsgId = `delreq-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reqNow = Date.now().toString();

      storeChatMetadata(mainJid, reqNow);
      storeMessageDirect({
        id: reqMsgId,
        chat_jid: mainJid,
        sender: 'system',
        sender_name: `${reqSourceName}委派请求`,
        content: reqContent,
        timestamp: reqNow,
        is_from_me: true,
        is_bot_message: false,
      });

      deps.enqueueMessageCheck(mainJid);

      logger.info(
        { sourceGroup, sourceName: reqSourceName },
        'Delegation request forwarded to main group',
      );
      break;
    }

    case 'delegate_task': {
      // Only main group can delegate tasks
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized delegate_task attempt blocked',
        );
        break;
      }

      if (!data.targetGroupJid || !data.task) {
        logger.warn(
          { sourceGroup },
          'delegate_task missing targetGroupJid or task',
        );
        break;
      }

      const targetGroup = registeredGroups[data.targetGroupJid];
      if (!targetGroup) {
        logger.warn(
          { targetGroupJid: data.targetGroupJid },
          'delegate_task: target group not registered',
        );
        break;
      }

      const delegationId =
        data.delegationId ||
        `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now().toString();

      // Create delegation record
      createDelegation({
        id: delegationId,
        source_jid:
          Object.entries(registeredGroups).find(
            ([, g]) => g.folder === sourceGroup,
          )?.[0] || '',
        source_folder: sourceGroup,
        target_jid: data.targetGroupJid,
        target_folder: targetGroup.folder,
        task: data.task,
        status: 'pending',
        result: null,
        outcome: null,
        requester_jid: data.requesterJid || null,
        created_at: now,
        updated_at: now,
      });

      // Ensure chat metadata exists for target JID
      storeChatMetadata(data.targetGroupJid, now);

      // Construct synthetic message with target group's trigger prefix
      const triggerPrefix = targetGroup.trigger;
      const syntheticContent = `${triggerPrefix} [委派任务 | ID:${delegationId} | 来自:主群]\n\n${data.task}\n\n完成后请调用 complete_delegation 工具报告结果，delegation_id 为 "${delegationId}"。`;
      const syntheticId = `del-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      storeMessageDirect({
        id: syntheticId,
        chat_jid: data.targetGroupJid,
        sender: 'system',
        sender_name: '主群委派',
        content: syntheticContent,
        timestamp: now,
        is_from_me: true,
        is_bot_message: false,
      });

      // Wake up the target group's agent
      deps.enqueueMessageCheck(data.targetGroupJid);

      // Write delegation ID back via IPC response
      const resultsDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'delegation-results',
      );
      fs.mkdirSync(resultsDir, { recursive: true });
      if (data.requestId) {
        const responsePath = path.join(resultsDir, `${data.requestId}.json`);
        const tempPath = `${responsePath}.tmp`;
        fs.writeFileSync(
          tempPath,
          JSON.stringify({ delegationId, status: 'created' }),
        );
        fs.renameSync(tempPath, responsePath);
      }

      logger.info(
        {
          delegationId,
          sourceGroup,
          targetFolder: targetGroup.folder,
          targetJid: data.targetGroupJid,
        },
        'Task delegated via IPC',
      );
      break;
    }

    case 'complete_delegation': {
      if (!data.delegationId || !data.result) {
        logger.warn(
          { sourceGroup },
          'complete_delegation missing delegationId or result',
        );
        break;
      }

      const delegation = getDelegation(data.delegationId);
      if (!delegation) {
        logger.warn(
          { delegationId: data.delegationId },
          'complete_delegation: delegation not found',
        );
        break;
      }

      // Verify the caller is the delegation's target
      if (delegation.target_folder !== sourceGroup) {
        logger.warn(
          {
            delegationId: data.delegationId,
            sourceGroup,
            expectedFolder: delegation.target_folder,
          },
          'Unauthorized complete_delegation attempt',
        );
        break;
      }

      // Update delegation status
      updateDelegation(data.delegationId, {
        status: 'completed',
        result: data.result,
        outcome:
          ((data as { outcome?: string }).outcome as
            | 'success'
            | 'failure'
            | null) || null,
      });

      // Find the target group name for the result message
      const delegTargetGroup = registeredGroups[delegation.target_jid];
      const targetName = delegTargetGroup?.name || delegation.target_folder;

      // Construct result message for the source (main) group
      const requesterJid = delegation.requester_jid;
      const requesterGroup = requesterJid ? registeredGroups[requesterJid] : null;
      const requesterNote = requesterGroup
        ? `\n\n请将此结果转发给请求方「${requesterGroup.name}」（使用 send_message，JID: ${requesterJid}）。`
        : '';
      const resultContent = `[委派结果 | 来自:${targetName} | ID:${data.delegationId}]\n\n${data.result}${requesterNote}`;
      const resultMsgId = `del-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resultNow = Date.now().toString();

      storeMessageDirect({
        id: resultMsgId,
        chat_jid: delegation.source_jid,
        sender: 'system',
        sender_name: `${targetName}委派结果`,
        content: resultContent,
        timestamp: resultNow,
        is_from_me: true,
        is_bot_message: false,
      });

      // Wake up the source (main) group's agent
      deps.enqueueMessageCheck(delegation.source_jid);

      logger.info(
        {
          delegationId: data.delegationId,
          sourceGroup,
          sourceJid: delegation.source_jid,
        },
        'Delegation completed via IPC',
      );

      // Workflow hook: check if this delegation belongs to a workflow
      try {
        onWorkflowDelegationComplete(data.delegationId);
      } catch (err) {
        logger.error(
          { err, delegationId: data.delegationId },
          'Workflow delegation hook failed',
        );
      }

      break;
    }

    case 'memory_search': {
      if (!data.query || !data.requestId) {
        logger.warn(
          { sourceGroup },
          'memory_search missing query or requestId',
        );
        break;
      }

      const searchLimit = data.limit || 10;

      // Search messages via FTS
      const messageResults = searchMessages(
        sourceGroup,
        data.query,
        searchLimit,
      );

      // Search conversations/ files
      const conversationResults = searchConversations(
        sourceGroup,
        data.query,
        searchLimit,
      );

      // Write results to IPC response file
      const resultsDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'search-results',
      );
      fs.mkdirSync(resultsDir, { recursive: true });

      const response = {
        messages: messageResults.map((r) => ({
          sender: r.sender_name,
          content: r.content,
          timestamp: r.timestamp,
        })),
        conversations: conversationResults.map((r) => ({
          file: r.file,
          snippet: r.snippet,
        })),
      };

      const responsePath = path.join(resultsDir, `${data.requestId}.json`);
      const tempPath = `${responsePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
      fs.renameSync(tempPath, responsePath);

      logger.info(
        {
          sourceGroup,
          query: data.query,
          messageHits: messageResults.length,
          conversationHits: conversationResults.length,
        },
        'memory_search completed',
      );
      break;
    }

    case 'create_workflow': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_workflow attempt blocked',
        );
        break;
      }

      if (!data.name || !data.service) {
        logger.warn({ sourceGroup }, 'create_workflow missing name or service');
        break;
      }

      const startFrom = (data as { start_from?: string }).start_from;
      const workflowType = (data as { workflow_type?: string }).workflow_type;

      if (!startFrom || !workflowType) {
        logger.warn(
          { sourceGroup },
          'create_workflow missing start_from or workflow_type',
        );
        break;
      }

      // Find the source JID (main group's JID)
      const mainJid =
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === sourceGroup,
        )?.[0] || '';

      const wfResult = createNewWorkflow({
        name: data.name as string,
        service: data.service as string,
        sourceJid: mainJid,
        startFrom,
        workflowType,
      });

      // Write result back via IPC response
      if (data.requestId) {
        const resultsDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'workflow-results',
        );
        fs.mkdirSync(resultsDir, { recursive: true });
        const responsePath = path.join(resultsDir, `${data.requestId}.json`);
        const tempPath = `${responsePath}.tmp`;
        fs.writeFileSync(
          tempPath,
          JSON.stringify({
            workflowId: wfResult.workflowId,
            error: wfResult.error || null,
          }),
        );
        fs.renameSync(tempPath, responsePath);
      }

      logger.info(
        { workflowId: wfResult.workflowId, sourceGroup, startFrom },
        'Workflow created via IPC',
      );
      break;
    }

    case 'list_workflows': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized list_workflows attempt blocked',
        );
        break;
      }

      // Try to send as interactive card first
      const cardSent = sendWorkflowListCard();

      const workflows = listWorkflows();

      if (data.requestId) {
        const resultsDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'workflow-results',
        );
        fs.mkdirSync(resultsDir, { recursive: true });
        const responsePath = path.join(resultsDir, `${data.requestId}.json`);
        const tempPath = `${responsePath}.tmp`;
        if (cardSent) {
          fs.writeFileSync(
            tempPath,
            JSON.stringify({ workflows, cardSent: true }),
          );
        } else {
          fs.writeFileSync(tempPath, JSON.stringify({ workflows }));
        }
        fs.renameSync(tempPath, responsePath);
      }

      logger.info(
        { sourceGroup, count: workflows.length, cardSent },
        'Workflows listed via IPC',
      );
      break;
    }

    case 'list_workflow_types': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized list_workflow_types attempt blocked',
        );
        break;
      }

      const types = getAvailableWorkflowTypes();

      if (data.requestId) {
        const resultsDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'workflow-results',
        );
        fs.mkdirSync(resultsDir, { recursive: true });
        const responsePath = path.join(resultsDir, `${data.requestId}.json`);
        const tempPath = `${responsePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify({ types }));
        fs.renameSync(tempPath, responsePath);
      }

      logger.info(
        { sourceGroup, count: types.length },
        'Workflow types listed via IPC',
      );
      break;
    }

    case 'reload_container': {
      if (!data.chatJid) {
        logger.warn({ sourceGroup }, 'reload_container missing chatJid');
        break;
      }
      // Authorization: group can only reload itself, main can reload any
      const targetGroup = registeredGroups[data.chatJid];
      if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
        if (deps.reloadContainer) {
          deps.reloadContainer(data.chatJid);
          logger.info({ chatJid: data.chatJid, sourceGroup }, 'Container reload requested');
        }
      } else {
        logger.warn(
          { chatJid: data.chatJid, sourceGroup },
          'Unauthorized reload_container attempt blocked',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
