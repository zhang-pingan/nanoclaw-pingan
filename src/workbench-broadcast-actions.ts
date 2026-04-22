import {
  getAskQuestion,
  getWorkbenchActionItem,
  listWorkbenchActionItemsBySource,
} from './db.js';
import { handleAskQuestionResponse } from './ask-user-question.js';
import { logger } from './logger.js';
import type {
  CardActionResult,
  InteractiveCard,
  RegisteredGroup,
} from './types.js';
import {
  runWorkbenchActionItemAction,
  runWorkbenchTaskAction,
} from './workbench.js';
import { isWorkbenchBroadcastGroup } from './workbench-broadcast-config.js';
import { buildWorkbenchBroadcastActionFeedbackCard } from './workbench-broadcast-render.js';

interface WorkbenchBroadcastCardActionResult extends CardActionResult {
  ok: boolean;
}

function successResult(
  taskId: string,
  actionItemId: string,
  toastContent: string,
  statusText: string,
): WorkbenchBroadcastCardActionResult {
  return {
    ok: true,
    toast: {
      type: 'success',
      content: toastContent,
    },
    replacementCard:
      buildWorkbenchBroadcastActionFeedbackCard({
        taskId,
        actionItemId,
        statusText,
      }) || undefined,
  };
}

function errorResult(message: string): WorkbenchBroadcastCardActionResult {
  return {
    ok: false,
    toast: {
      type: 'error',
      content: message,
    },
  };
}

function findChatJidByGroupFolder(
  groupFolder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  const entry = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === groupFolder,
  );
  return entry?.[0];
}

export function resolveAskAnswerGroupFolder(input: {
  requestId: string;
  currentGroupFolder: string;
  registeredGroups: Record<string, RegisteredGroup>;
}): string {
  const currentChatJid = findChatJidByGroupFolder(
    input.currentGroupFolder,
    input.registeredGroups,
  );
  if (!currentChatJid) return input.currentGroupFolder;
  if (!isWorkbenchBroadcastGroup(currentChatJid, input.registeredGroups)) {
    return input.currentGroupFolder;
  }
  return (
    getAskQuestion(input.requestId)?.group_folder || input.currentGroupFolder
  );
}

function resolveAskActionItemByRequestId(requestId?: string) {
  if (!requestId) return undefined;
  for (const sourceType of [
    'ask_user_question',
    'request_human_input',
  ] as const) {
    const items = listWorkbenchActionItemsBySource(sourceType, requestId);
    const item = items.find((entry) => entry.status === 'pending') || items[0];
    if (item) return item;
  }
  return undefined;
}

export async function handleWorkbenchBroadcastCardAction(input: {
  action: string;
  formValue?: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
  sendCard?: (
    jid: string,
    card: InteractiveCard,
  ) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  userId: string;
}): Promise<WorkbenchBroadcastCardActionResult> {
  const resolvedAskItem = resolveAskActionItemByRequestId(
    input.formValue?.request_id,
  );
  const actionItemId = input.formValue?.action_item_id || resolvedAskItem?.id;
  const taskId =
    input.formValue?.task_id ||
    resolvedAskItem?.task_id ||
    (actionItemId ? getWorkbenchActionItem(actionItemId)?.task_id : undefined);
  if (!taskId || !actionItemId)
    return errorResult('缺少待办标识，无法处理该卡片。');

  switch (input.action) {
    case 'wb_broadcast_confirm': {
      const result = runWorkbenchTaskAction({ taskId, action: 'approve' });
      if (result.error) return errorResult(`确认失败：${result.error}`);
      return successResult(
        taskId,
        actionItemId,
        '已提交确认，正在推进后续流程。',
        '已提交确认，正在推进后续流程。',
      );
    }
    case 'wb_broadcast_skip': {
      const result = runWorkbenchTaskAction({ taskId, action: 'skip' });
      if (result.error) return errorResult(`跳过失败：${result.error}`);
      return successResult(
        taskId,
        actionItemId,
        '已提交跳过请求，正在推进后续流程。',
        '已提交跳过请求，正在推进后续流程。',
      );
    }
    case 'wb_broadcast_revise': {
      const revisionText = input.formValue?.revision_text?.trim();
      const result = runWorkbenchTaskAction({
        taskId,
        action: 'revise',
        revisionText,
      });
      if (result.error) return errorResult(`提交修改意见失败：${result.error}`);
      return successResult(
        taskId,
        actionItemId,
        '已提交修改意见，正在回退并重新处理。',
        '已提交修改意见，正在回退并重新处理。',
      );
    }
    case 'wb_broadcast_submit_access_token': {
      const accessToken = input.formValue?.access_token?.trim();
      const result = runWorkbenchTaskAction({
        taskId,
        action: 'submit_access_token',
        context: { access_token: accessToken },
      });
      if (result.error)
        return errorResult(`提交 access_token 失败：${result.error}`);
      return successResult(
        taskId,
        actionItemId,
        '已提交 access_token，正在开始测试。',
        '已提交 access_token，正在开始测试。',
      );
    }
    case 'wb_broadcast_reply':
    case 'wb_broadcast_skip_reply': {
      const item = resolvedAskItem || getWorkbenchActionItem(actionItemId);
      if (!item?.source_ref_id || !item.group_folder) {
        return errorResult('未找到原始问答请求，无法继续处理。');
      }
      const result = await handleAskQuestionResponse({
        requestId: item.source_ref_id,
        groupFolder: item.group_folder,
        userId: input.userId || 'unknown',
        answer:
          input.formValue?.reply_text?.trim() ||
          input.formValue?.answer?.trim(),
        formValues: input.formValue
          ? Object.fromEntries(
              Object.entries(input.formValue).filter(
                ([key]) =>
                  ![
                    'action',
                    'task_id',
                    'action_item_id',
                    'reply_text',
                    'answer',
                  ].includes(key),
              ),
            )
          : undefined,
        skip: input.action === 'wb_broadcast_skip_reply',
        registeredGroups: input.registeredGroups,
        sendCard: input.sendCard,
        sendMessage: input.sendMessage,
      });
      if (result.ok && result.completed) {
        runWorkbenchActionItemAction({
          taskId,
          actionItemId,
          action:
            input.action === 'wb_broadcast_skip_reply' ? 'skip' : 'confirm',
        });
      }
      if (!result.ok) return errorResult(result.userMessage);
      return successResult(
        taskId,
        actionItemId,
        result.userMessage || '已提交答复。',
        result.completed
          ? result.userMessage || '已提交答复。'
          : '已记录当前答复，后续问题会继续发送。',
      );
    }
    case 'wb_broadcast_resolve': {
      const item = getWorkbenchActionItem(actionItemId);
      if (!item) return errorResult('待办不存在，无法标记已读。');
      const result = runWorkbenchActionItemAction({
        taskId,
        actionItemId,
        action: 'resolve',
      });
      if (result.error) return errorResult(`标记已读失败：${result.error}`);
      return successResult(
        taskId,
        actionItemId,
        '已标记已读。',
        '已标记已读。',
      );
    }
    default:
      return errorResult(`不支持的卡片动作：${input.action}`);
  }
}

export function logWorkbenchBroadcastActionFailure(
  action: string,
  err: unknown,
): void {
  logger.warn(
    { action, err },
    'workbench broadcast card action handling failed',
  );
}
