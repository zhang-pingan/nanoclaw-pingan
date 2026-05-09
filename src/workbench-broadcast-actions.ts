import {
  getAskQuestion,
  getWorkbenchActionItem,
  listWorkbenchActionItemsByTask,
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

function resolveActionItemBySource(input: {
  sourceType?: string;
  sourceRefId?: string;
}) {
  if (!input.sourceType || !input.sourceRefId) return undefined;
  const items = listWorkbenchActionItemsBySource(
    input.sourceType,
    input.sourceRefId,
  );
  return items.find((entry) => entry.status === 'pending') || items[0];
}

function buildResumePayload(
  formValue: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!formValue) return {};
  return Object.fromEntries(
    Object.entries(formValue).filter(
      ([key]) =>
        ![
          'action',
          'workbench_action',
          'task_id',
          'action_item_id',
          'workflow_id',
          'interrupt_id',
          'resume_action',
          'resume_payload_schema',
          'group_folder',
          'source_type',
          'source_ref_id',
          'request_id',
        ].includes(key),
    ),
  );
}

function isWorkbenchAction(value: string | undefined): value is
  | 'confirm'
  | 'approve'
  | 'reject'
  | 'revise'
  | 'submit'
  | 'skip'
  | 'cancel'
  | 'resolve' {
  return (
    value === 'confirm' ||
    value === 'approve' ||
    value === 'reject' ||
    value === 'revise' ||
    value === 'submit' ||
    value === 'skip' ||
    value === 'cancel' ||
    value === 'resolve'
  );
}

function successTextForAction(action: string): {
  toast: string;
  status: string;
} {
  switch (action) {
    case 'revise':
      return {
        toast: '已提交修改意见，正在回退并重新处理。',
        status: '已提交修改意见，正在回退并重新处理。',
      };
    case 'submit':
      return {
        toast: '已提交表单，正在推进后续流程。',
        status: '已提交表单，正在推进后续流程。',
      };
    case 'reject':
      return {
        toast: '已提交拒绝操作。',
        status: '已提交拒绝操作。',
      };
    case 'cancel':
      return {
        toast: '已提交取消操作。',
        status: '已提交取消操作。',
      };
    default:
      return {
        toast: '已提交操作，正在推进后续流程。',
        status: '已提交操作，正在推进后续流程。',
      };
  }
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
  const askQuestion = input.formValue?.request_id
    ? getAskQuestion(input.formValue.request_id)
    : undefined;
  if (
    askQuestion &&
    (input.action === 'wb_broadcast_reply' ||
      input.action === 'wb_broadcast_skip_reply')
  ) {
    const answer = input.formValue?.reply_text?.trim() || input.formValue?.answer?.trim();
    const result = await handleAskQuestionResponse({
      requestId: askQuestion.id,
      groupFolder: askQuestion.group_folder,
      userId: input.userId || 'unknown',
      answer,
      formValues: input.formValue
        ? Object.fromEntries(
            Object.entries(input.formValue).filter(
              ([key]) =>
                ![
                  'action',
                  'task_id',
                  'action_item_id',
                  'request_id',
                  'source_type',
                  'source_ref_id',
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
    if (!result.ok) return errorResult(result.userMessage);
    return {
      ok: true,
      toast: {
        type: 'success',
        content: result.userMessage || '答案已提交，感谢。',
      },
    };
  }
  const resolvedSourceItem = resolveActionItemBySource({
    sourceType: input.formValue?.source_type,
    sourceRefId: input.formValue?.source_ref_id,
  });
  const resolvedInterruptItem = resolveActionItemBySource({
    sourceType: 'workflow_interrupt',
    sourceRefId: input.formValue?.interrupt_id,
  });
  const actionItemIdFromForm = input.formValue?.action_item_id;
  const fallbackTaskId = actionItemIdFromForm
    ? getWorkbenchActionItem(actionItemIdFromForm)?.task_id
    : undefined;
  const fallbackTaskPendingItem =
    fallbackTaskId && !getWorkbenchActionItem(actionItemIdFromForm || '')
      ? listWorkbenchActionItemsByTask(fallbackTaskId).find(
          (entry) => entry.status === 'pending',
        )
      : undefined;
  const actionItemId =
    actionItemIdFromForm ||
    resolvedAskItem?.id ||
    resolvedSourceItem?.id ||
    resolvedInterruptItem?.id ||
    fallbackTaskPendingItem?.id;
  const taskId =
    input.formValue?.task_id ||
    resolvedAskItem?.task_id ||
    resolvedSourceItem?.task_id ||
    resolvedInterruptItem?.task_id ||
    fallbackTaskPendingItem?.task_id ||
    (actionItemId ? getWorkbenchActionItem(actionItemId)?.task_id : undefined);
  if ((!taskId || !actionItemId) && !askQuestion)
    return errorResult('缺少待办标识，无法处理该卡片。');
  const resolvedTaskId = taskId || '';
  const resolvedActionItemId = actionItemId || '';

  switch (input.action) {
    case 'wb_broadcast_confirm': {
      const item = getWorkbenchActionItem(resolvedActionItemId);
      if (item?.source_type !== 'workflow_interrupt') {
        return errorResult('该待办不是 workflow interrupt，不能执行确认。');
      }
      const result = runWorkbenchActionItemAction({
        taskId: resolvedTaskId,
        actionItemId: resolvedActionItemId,
        action: 'confirm',
      });
      if (result.error) return errorResult(`确认失败：${result.error}`);
      return successResult(
        resolvedTaskId,
        resolvedActionItemId,
        '已提交确认，正在推进后续流程。',
        '已提交确认，正在推进后续流程。',
      );
    }
    case 'wb_broadcast_skip': {
      const item = getWorkbenchActionItem(resolvedActionItemId);
      const result =
        item?.source_type === 'workflow_interrupt'
          ? runWorkbenchActionItemAction({
              taskId: resolvedTaskId,
              actionItemId: resolvedActionItemId,
              action: 'skip',
            })
          : runWorkbenchTaskAction({ taskId: resolvedTaskId, action: 'skip' });
      if (result.error) return errorResult(`跳过失败：${result.error}`);
      return successResult(
        resolvedTaskId,
        resolvedActionItemId,
        '已提交跳过请求，正在推进后续流程。',
        '已提交跳过请求，正在推进后续流程。',
      );
    }
    case 'wb_broadcast_revise': {
      const result = runWorkbenchActionItemAction({
        taskId: resolvedTaskId,
        actionItemId: resolvedActionItemId,
        action: 'revise',
        payload: buildResumePayload(input.formValue),
      });
      if (result.error) return errorResult(`提交修改意见失败：${result.error}`);
      return successResult(
        resolvedTaskId,
        resolvedActionItemId,
        '已提交修改意见，正在回退并重新处理。',
        '已提交修改意见，正在回退并重新处理。',
      );
    }
    case 'wb_broadcast_submit': {
      const result = runWorkbenchActionItemAction({
        taskId: resolvedTaskId,
        actionItemId: resolvedActionItemId,
        action: 'submit',
        payload: buildResumePayload(input.formValue),
      });
      if (result.error)
        return errorResult(`提交表单失败：${result.error}`);
      return successResult(
        resolvedTaskId,
        resolvedActionItemId,
        '已提交表单，正在推进后续流程。',
        '已提交表单，正在推进后续流程。',
      );
    }
    case 'wb_broadcast_resume': {
      const action =
        input.formValue?.workbench_action ||
        input.formValue?.resume_action;
      if (!isWorkbenchAction(action)) {
        return errorResult(`不支持的恢复动作：${action || ''}`);
      }
      const result = runWorkbenchActionItemAction({
        taskId: resolvedTaskId,
        actionItemId: resolvedActionItemId,
        action,
        payload: buildResumePayload(input.formValue),
      });
      if (result.error) return errorResult(`提交操作失败：${result.error}`);
      const text = successTextForAction(action);
      return successResult(
        resolvedTaskId,
        resolvedActionItemId,
        text.toast,
        text.status,
      );
    }
    case 'wb_broadcast_reply':
    case 'wb_broadcast_skip_reply': {
      const item =
        resolvedAskItem || getWorkbenchActionItem(resolvedActionItemId);
      const requestId = item?.source_ref_id || input.formValue?.request_id;
      const groupFolder = item?.group_folder || askQuestion?.group_folder;
      if (!requestId || !groupFolder) {
        return errorResult('未找到原始问答请求，无法继续处理。');
      }
      const result = await handleAskQuestionResponse({
        requestId,
        groupFolder,
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
                    'request_id',
                    'source_type',
                    'source_ref_id',
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
        if (taskId && actionItemId) {
          runWorkbenchActionItemAction({
            taskId,
            actionItemId,
            action:
              input.action === 'wb_broadcast_skip_reply' ? 'skip' : 'confirm',
          });
        }
      }
      if (!result.ok) return errorResult(result.userMessage);
      return successResult(
        taskId || askQuestion?.id || requestId,
        actionItemId || askQuestion?.id || requestId,
        result.userMessage || '已提交答复。',
        result.completed
          ? result.userMessage || '已提交答复。'
          : '已记录当前答复，后续问题会继续发送。',
      );
    }
    case 'wb_broadcast_resolve': {
      const item =
        resolvedSourceItem || getWorkbenchActionItem(resolvedActionItemId);
      if (!item) return errorResult('待办不存在，无法标记已读。');
      const result = runWorkbenchActionItemAction({
        taskId: resolvedTaskId,
        actionItemId: resolvedActionItemId,
        action: 'resolve',
      });
      if (result.error) return errorResult(`标记已读失败：${result.error}`);
      return successResult(
        resolvedTaskId,
        resolvedActionItemId,
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
