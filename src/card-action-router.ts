import {
  ASK_ACTION_ANSWER,
  ASK_ACTION_SKIP,
  dispatchCurrentAskQuestion,
  handleAskQuestionResponse,
} from './ask-user-question.js';
import { logger } from './logger.js';
import {
  CardActionHandler,
  InteractiveCard,
  RegisteredGroup,
} from './types.js';
import { handleCardAction as handleWorkflowCardAction } from './workflow.js';
import {
  handleWorkbenchBroadcastCardAction,
  logWorkbenchBroadcastActionFailure,
} from './workbench-broadcast-actions.js';

const ASK_ACTION_DEDUPE_WINDOW_MS = 15_000;
const recentAskActionFingerprints = new Map<string, number>();

function findChatJidByGroupFolder(
  groupFolder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  const entry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === groupFolder,
  );
  return entry?.[0];
}

function pruneExpiredAskActions(now: number): void {
  for (const [k, ts] of recentAskActionFingerprints.entries()) {
    if (now - ts > ASK_ACTION_DEDUPE_WINDOW_MS) {
      recentAskActionFingerprints.delete(k);
    }
  }
}

function askActionFingerprint(action: {
  action: string;
  user_id: string;
  message_id: string;
  group_folder?: string;
  form_value?: Record<string, string>;
}): string {
  const fv = action.form_value || {};
  const fvKeys = Object.keys(fv).sort();
  const fvPairs = fvKeys.map((k) => `${k}=${fv[k]}`).join('&');
  return [
    action.action,
    action.user_id || '',
    action.message_id || '',
    action.group_folder || '',
    fvPairs,
  ].join('|');
}

export function createCardActionHandler(deps: {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendCard?: (
    jid: string,
    card: InteractiveCard,
  ) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}): CardActionHandler {
  return async (action) => {
    if (action.action.startsWith('wb_broadcast_')) {
      try {
        return await handleWorkbenchBroadcastCardAction({
          action: action.action,
          formValue: action.form_value,
          registeredGroups: deps.registeredGroups(),
          sendCard: deps.sendCard,
          sendMessage: deps.sendMessage,
          userId: action.user_id || 'unknown',
        });
      } catch (err) {
        logWorkbenchBroadcastActionFailure(action.action, err);
        return {
          toast: {
            type: 'error' as const,
            content: '处理工作台广播卡片失败，请稍后重试。',
          },
        };
      }
    }

    if (
      action.action !== ASK_ACTION_ANSWER &&
      action.action !== ASK_ACTION_SKIP
    ) {
      handleWorkflowCardAction(action);
      return;
    }

    const requestId = action.form_value?.request_id;
    const groupFolder = action.group_folder || action.form_value?.group_folder;
    if (!requestId || !groupFolder) {
      logger.warn(
        { action },
        'ask_question card action missing request_id/group_folder',
      );
      return;
    }

    const now = Date.now();
    pruneExpiredAskActions(now);
    const fp = askActionFingerprint({
      action: action.action,
      user_id: action.user_id,
      message_id: action.message_id,
      group_folder: groupFolder,
      form_value: action.form_value,
    });
    if (recentAskActionFingerprints.has(fp)) {
      logger.info(
        {
          requestId,
          groupFolder,
          userId: action.user_id,
          messageId: action.message_id,
        },
        'Duplicate ask card action ignored by dedupe window',
      );
      return;
    }
    recentAskActionFingerprints.set(fp, now);

    const answer = action.form_value?.answer;
    const formValues = action.form_value
      ? Object.fromEntries(
          Object.entries(action.form_value).filter(
            ([k]) =>
              ![
                'action',
                'group_folder',
                'request_id',
                'question_id',
                'answer',
              ].includes(k),
          ),
        )
      : undefined;
    const registeredGroups = deps.registeredGroups();
    const chatJid = findChatJidByGroupFolder(groupFolder, registeredGroups);

    void handleAskQuestionResponse({
      requestId,
      groupFolder,
      userId: action.user_id || 'unknown',
      answer,
      formValues,
      skip: action.action === ASK_ACTION_SKIP,
      registeredGroups,
      sendCard: deps.sendCard,
      sendMessage: deps.sendMessage,
    })
      .then(async (result) => {
        if (!chatJid) return;
        if (!result.ok) {
          await deps.sendMessage(chatJid, result.userMessage);
          if (!result.completed) {
            await dispatchCurrentAskQuestion({
              requestId,
              groupFolder,
              validationError: result.userMessage,
              validationErrors: result.validationErrors,
              registeredGroups,
              sendCard: deps.sendCard,
              sendMessage: deps.sendMessage,
            });
          }
        }
      })
      .catch((err) => {
        logger.warn(
          { err, requestId, groupFolder },
          'ask_question card action handling failed',
        );
      });
  };
}
