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
import {
  buildCardStringFormValues,
  parseNestedCardStringPayload,
} from './card-action-payload.js';
import {
  ASSISTANT_EVOLUTION_CARD_ACTION,
  handleAssistantEvolutionCardAction,
} from './assistant/evolution-card-actions.js';
import {
  ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX,
  handleAssistantInboxBroadcastCardAction,
  logAssistantInboxBroadcastActionFailure,
} from './assistant/assistant-inbox-broadcast-actions.js';

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
    if (action.action === ASSISTANT_EVOLUTION_CARD_ACTION) {
      return handleAssistantEvolutionCardAction({
        itemId:
          action.form_value?.item_id || action.form_value?.source_ref_id || '',
        evolutionAction: action.form_value?.evolution_action || '',
      });
    }

    if (action.action.startsWith('wb_broadcast_')) {
      try {
        return await handleWorkbenchBroadcastCardAction({
          action: action.action,
          formValue: action.form_value,
          registeredGroups: deps.registeredGroups(),
          sendCard: deps.sendCard,
          sendMessage: deps.sendMessage,
          userId: action.user_id || 'unknown',
          actorChannel: action.actor_channel,
          messageId: action.message_id,
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

    if (action.action.startsWith(ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX)) {
      try {
        return await handleAssistantInboxBroadcastCardAction({
          action: action.action,
          formValue: action.form_value,
          registeredGroups: deps.registeredGroups(),
          sendCard: deps.sendCard,
          sendMessage: deps.sendMessage,
          userId: action.user_id || 'unknown',
          actorChannel: action.actor_channel,
          messageId: action.message_id,
          targetJid: action.group_jid,
        });
      } catch (err) {
        logAssistantInboxBroadcastActionFailure(action.action, err);
        return {
          toast: {
            type: 'error' as const,
            content: '处理个人助手广播卡片失败，请稍后重试。',
          },
        };
      }
    }

    if (
      action.action !== ASK_ACTION_ANSWER &&
      action.action !== ASK_ACTION_SKIP
    ) {
      return handleWorkflowCardAction(action);
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

    const nestedPayload = parseNestedCardStringPayload(action.form_value);
    const answer = nestedPayload?.answer || action.form_value?.answer;
    const formValues = buildCardStringFormValues(action.form_value, [
      'action',
      'group_folder',
      'request_id',
      'question_id',
      'answer',
      'payload',
    ]);
    const registeredGroups = deps.registeredGroups();
    const chatJid = findChatJidByGroupFolder(groupFolder, registeredGroups);

    try {
      const result = await handleAskQuestionResponse({
        requestId,
        groupFolder,
        userId: action.user_id || 'unknown',
        answer,
        formValues,
        skip: action.action === ASK_ACTION_SKIP,
        registeredGroups,
        sendCard: deps.sendCard,
        sendMessage: deps.sendMessage,
      });
      if (!result.ok) {
        if (chatJid) {
          await deps.sendMessage(chatJid, result.userMessage);
        }
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
        return {
          ok: false,
          toast: { type: 'error' as const, content: result.userMessage },
        };
      }
      return {
        ok: true,
        toast: { type: 'success' as const, content: result.userMessage },
      };
    } catch (err) {
      logger.warn(
        { err, requestId, groupFolder },
        'ask_question card action handling failed',
      );
      return {
        ok: false,
        toast: {
          type: 'error' as const,
          content: '处理问题卡片失败，请稍后重试。',
        },
      };
    }
  };
}
