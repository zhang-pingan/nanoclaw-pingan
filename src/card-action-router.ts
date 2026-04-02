import {
  ASK_ACTION_ANSWER,
  ASK_ACTION_SKIP,
  handleAskQuestionResponse,
} from './ask-user-question.js';
import { logger } from './logger.js';
import { CardActionHandler, InteractiveCard, RegisteredGroup } from './types.js';
import { handleCardAction as handleWorkflowCardAction } from './workflow.js';

function findChatJidByGroupFolder(
  groupFolder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  const entry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === groupFolder,
  );
  return entry?.[0];
}

export function createCardActionHandler(deps: {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}): CardActionHandler {
  return (action) => {
    if (action.action !== ASK_ACTION_ANSWER && action.action !== ASK_ACTION_SKIP) {
      handleWorkflowCardAction(action);
      return;
    }

    const requestId = action.form_value?.request_id;
    const groupFolder = action.group_folder || action.form_value?.group_folder;
    if (!requestId || !groupFolder) {
      logger.warn({ action }, 'ask_question card action missing request_id/group_folder');
      return;
    }

    const answer = action.form_value?.answer;
    const registeredGroups = deps.registeredGroups();
    const chatJid = findChatJidByGroupFolder(groupFolder, registeredGroups);

    void handleAskQuestionResponse({
      requestId,
      groupFolder,
      userId: action.user_id || 'unknown',
      answer,
      skip: action.action === ASK_ACTION_SKIP,
      registeredGroups,
      sendCard: deps.sendCard,
      sendMessage: deps.sendMessage,
    })
      .then(async (result) => {
        if (result.ok || !chatJid) return;
        await deps.sendMessage(chatJid, result.userMessage);
      })
      .catch((err) => {
        logger.warn(
          { err, requestId, groupFolder },
          'ask_question card action handling failed',
        );
      });
  };
}
