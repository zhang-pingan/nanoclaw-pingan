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
  RegisteredAgent,
} from './types.js';
import {
  buildCardStringFormValues,
  parseNestedCardStringPayload,
} from './card-action-payload.js';
import {
  ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX,
  handleAssistantInboxBroadcastCardAction,
  logAssistantInboxBroadcastActionFailure,
} from './assistant/assistant-inbox-broadcast-actions.js';

const ASK_ACTION_DEDUPE_WINDOW_MS = 15_000;
const recentAskActionFingerprints = new Map<string, number>();

function findChatJidByAgentFolder(
  agentFolder: string,
  registeredAgents: Record<string, RegisteredAgent>,
): string | undefined {
  const entry = Object.entries(registeredAgents).find(
    ([, g]) => g.folder === agentFolder,
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
  agent_folder?: string;
  form_value?: Record<string, string>;
}): string {
  const fv = action.form_value || {};
  const fvKeys = Object.keys(fv).sort();
  const fvPairs = fvKeys.map((k) => `${k}=${fv[k]}`).join('&');
  return [
    action.action,
    action.user_id || '',
    action.message_id || '',
    action.agent_folder || '',
    fvPairs,
  ].join('|');
}

export function createCardActionHandler(deps: {
  registeredAgents: () => Record<string, RegisteredAgent>;
  sendCard?: (
    jid: string,
    card: InteractiveCard,
  ) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}): CardActionHandler {
  return async (action) => {
    if (action.action.startsWith(ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX)) {
      try {
        return await handleAssistantInboxBroadcastCardAction({
          action: action.action,
          formValue: action.form_value,
          registeredAgents: deps.registeredAgents(),
          sendCard: deps.sendCard,
          sendMessage: deps.sendMessage,
          userId: action.user_id || 'unknown',
          actorChannel: action.actor_channel,
          messageId: action.message_id,
          targetJid: action.agent_jid,
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
      return {
        ok: false,
        toast: { type: 'error' as const, content: '不支持的卡片操作。' },
      };
    }

    const requestId = action.form_value?.request_id;
    const agentFolder = action.agent_folder || action.form_value?.agent_folder;
    if (!requestId || !agentFolder) {
      logger.warn(
        { action },
        'ask_question card action missing request_id/agent_folder',
      );
      return;
    }

    const now = Date.now();
    pruneExpiredAskActions(now);
    const fp = askActionFingerprint({
      action: action.action,
      user_id: action.user_id,
      message_id: action.message_id,
      agent_folder: agentFolder,
      form_value: action.form_value,
    });
    if (recentAskActionFingerprints.has(fp)) {
      logger.info(
        {
          requestId,
          agentFolder,
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
      'agent_folder',
      'request_id',
      'question_id',
      'answer',
      'payload',
    ]);
    const registeredAgents = deps.registeredAgents();
    const chatJid = findChatJidByAgentFolder(agentFolder, registeredAgents);

    try {
      const result = await handleAskQuestionResponse({
        requestId,
        agentFolder,
        userId: action.user_id || 'unknown',
        answer,
        formValues,
        skip: action.action === ASK_ACTION_SKIP,
        registeredAgents,
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
            agentFolder,
            validationError: result.userMessage,
            validationErrors: result.validationErrors,
            registeredAgents,
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
        { err, requestId, agentFolder },
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
