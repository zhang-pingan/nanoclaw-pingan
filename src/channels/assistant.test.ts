import { beforeEach, describe, expect, it } from 'vitest';

import { initAssistantEvents } from '../assistant/assistant-events.js';
import {
  ASSISTANT_MAIN_FOLDER,
  ASSISTANT_MAIN_JID,
  listAssistantChatMessages,
  sendAssistantUserMessage,
} from '../assistant/assistant-channel-bridge.js';
import {
  _initTestDatabase,
  getAllRegisteredGroups,
  getMessagesSince,
  listStoredMessagesByChat,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import { ASSISTANT_NAME } from '../config.js';
import type { RegisteredGroup } from '../types.js';
import { getChannelFactory } from './registry.js';
import './assistant.js';

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
});

describe('assistant channel', () => {
  it('registers an assistant main group and injects desktop messages', async () => {
    const factory = getChannelFactory('assistant');
    expect(factory).toBeTruthy();

    let groups: Record<string, RegisteredGroup> = {};
    const channel = factory!({
      onMessage: (_jid, msg) => storeMessage(msg),
      onChatMetadata: (jid, timestamp, name, channelName, isGroup) =>
        storeChatMetadata(jid, timestamp, name, channelName, isGroup),
      registeredGroups: () => groups,
      registerGroup: (jid, group) => {
        groups[jid] = group;
        setRegisteredGroup(jid, group);
      },
      enqueueMessageCheck: () => undefined,
    });
    expect(channel).toBeTruthy();
    if (!channel) throw new Error('assistant channel factory returned null');

    await channel.connect();

    groups = getAllRegisteredGroups();
    expect(groups[ASSISTANT_MAIN_JID]?.folder).toBe(ASSISTANT_MAIN_FOLDER);
    expect(groups[ASSISTANT_MAIN_JID]?.isMain).toBe(true);

    const userMessage = sendAssistantUserMessage('帮我总结今天要做什么');
    expect(userMessage.chatJid).toBe(ASSISTANT_MAIN_JID);
    expect(userMessage.isFromMe).toBe(true);

    const pending = getMessagesSince(ASSISTANT_MAIN_JID, '', ASSISTANT_NAME);
    expect(pending.map((message) => message.content)).toContain(
      '帮我总结今天要做什么',
    );

    await channel.sendMessage(ASSISTANT_MAIN_JID, '可以，我先查看今日计划。');
    const chatMessages = listAssistantChatMessages(10);
    expect(chatMessages.map((message) => message.content)).toEqual([
      '帮我总结今天要做什么',
      '可以，我先查看今日计划。',
    ]);

    const genericMessages = listStoredMessagesByChat(ASSISTANT_MAIN_JID, 10);
    expect(genericMessages.map((message) => message.content)).toEqual([
      '帮我总结今天要做什么',
    ]);

    await channel.disconnect();
  });
});
