import { getAskQuestion, getWorkbenchActionItem } from './db.js';
import { handleAskQuestionResponse } from './ask-user-question.js';
import { logger } from './logger.js';
import type { InteractiveCard, RegisteredGroup } from './types.js';
import { runWorkbenchActionItemAction, runWorkbenchTaskAction } from './workbench.js';
import { isWorkbenchBroadcastGroup } from './workbench-broadcast-config.js';

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
  return getAskQuestion(input.requestId)?.group_folder || input.currentGroupFolder;
}

export async function handleWorkbenchBroadcastCardAction(input: {
  action: string;
  formValue?: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  userId: string;
}): Promise<boolean> {
  const taskId = input.formValue?.task_id;
  const actionItemId = input.formValue?.action_item_id;
  if (!taskId || !actionItemId) return false;

  switch (input.action) {
    case 'wb_broadcast_confirm': {
      const result = runWorkbenchTaskAction({ taskId, action: 'approve' });
      return !result.error;
    }
    case 'wb_broadcast_revise': {
      const revisionText = input.formValue?.revision_text?.trim();
      const result = runWorkbenchTaskAction({
        taskId,
        action: 'revise',
        revisionText,
      });
      return !result.error;
    }
    case 'wb_broadcast_submit_access_token': {
      const accessToken = input.formValue?.access_token?.trim();
      const result = runWorkbenchTaskAction({
        taskId,
        action: 'submit_access_token',
        context: { access_token: accessToken },
      });
      return !result.error;
    }
    case 'wb_broadcast_reply':
    case 'wb_broadcast_skip_reply': {
      const item = getWorkbenchActionItem(actionItemId);
      if (!item?.source_ref_id || !item.group_folder) return false;
      const result = await handleAskQuestionResponse({
        requestId: item.source_ref_id,
        groupFolder: item.group_folder,
        userId: input.userId || 'unknown',
        answer: input.formValue?.reply_text?.trim(),
        skip: input.action === 'wb_broadcast_skip_reply',
        registeredGroups: input.registeredGroups,
        sendCard: input.sendCard,
        sendMessage: input.sendMessage,
      });
      if (result.ok && result.completed) {
        runWorkbenchActionItemAction({
          taskId,
          actionItemId,
          action: input.action === 'wb_broadcast_skip_reply' ? 'skip' : 'confirm',
        });
      }
      return result.ok;
    }
    case 'wb_broadcast_resolve': {
      const item = getWorkbenchActionItem(actionItemId);
      if (!item) return false;
      const result = runWorkbenchActionItemAction({
        taskId,
        actionItemId,
        action: 'resolve',
      });
      return !result.error;
    }
    default:
      return false;
  }
}

export function logWorkbenchBroadcastActionFailure(action: string, err: unknown): void {
  logger.warn(
    { action, err },
    'workbench broadcast card action handling failed',
  );
}
