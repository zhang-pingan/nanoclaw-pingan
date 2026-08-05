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
  clearAssistantChatMessages,
  clearAssistantData,
  getAllRegisteredAgents,
  getMessagesSince,
  listAssistantChatMessageRecords,
  listStoredMessagesByChat,
  setRegisteredAgent,
  storeChatMetadata,
  storeAssistantChatMessage,
  storeMessage,
} from '../db.js';
import { ASSISTANT_NAME } from '../config.js';
import type { RegisteredAgent } from '../types.js';
import { getChannelFactory } from './registry.js';
import './assistant.js';

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
});

describe('assistant channel', () => {
  it('registers an assistant main agent and injects desktop messages', async () => {
    const factory = getChannelFactory('assistant');
    expect(factory).toBeTruthy();

    let agents: Record<string, RegisteredAgent> = {};
    const channel = factory!({
      onMessage: (_jid, msg) => storeMessage(msg),
      onChatMetadata: (jid, timestamp, name, channelName) =>
        storeChatMetadata(jid, timestamp, name, channelName),
      registeredAgents: () => agents,
      registerAgent: (jid, agent) => {
        agents[jid] = agent;
        setRegisteredAgent(jid, agent);
      },
      enqueueMessageCheck: () => undefined,
    });
    expect(channel).toBeTruthy();
    if (!channel) throw new Error('assistant channel factory returned null');

    await channel.connect();

    agents = getAllRegisteredAgents();
    expect(agents[ASSISTANT_MAIN_JID]?.folder).toBe(ASSISTANT_MAIN_FOLDER);
    expect(agents[ASSISTANT_MAIN_JID]?.isMain).toBe(true);
    expect(agents[ASSISTANT_MAIN_JID]?.description).toContain(
      'assistant 桌面个人助手的沟通频道',
    );

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

    expect(channel.sendFile).toBeTruthy();
    await channel.sendFile?.(
      ASSISTANT_MAIN_JID,
      '/tmp/icarus-test-image.png',
      '生成图片',
    );
    const messagesWithFile = listAssistantChatMessages(10);
    const fileMessage = messagesWithFile[messagesWithFile.length - 1];
    expect(fileMessage.content).toBe('生成图片');
    expect(fileMessage.filePath).toBe('/tmp/icarus-test-image.png');
    expect(fileMessage.fileUrl).toBe(
      `/api/message-files/${encodeURIComponent(
        ASSISTANT_MAIN_JID,
      )}/${encodeURIComponent(fileMessage.id)}`,
    );

    const genericMessages = listStoredMessagesByChat(ASSISTANT_MAIN_JID, 10);
    expect(genericMessages.map((message) => message.content)).toEqual([
      '帮我总结今天要做什么',
    ]);

    const clearResult = clearAssistantData();
    expect(clearResult.total).toBeGreaterThan(0);
    expect(listAssistantChatMessages(10)).toEqual([]);
    expect(listStoredMessagesByChat(ASSISTANT_MAIN_JID, 10)).toEqual([]);

    await channel.disconnect();
  });

  it('refreshes an existing assistant main agent definition on connect', async () => {
    const factory = getChannelFactory('assistant');
    expect(factory).toBeTruthy();

    let agents: Record<string, RegisteredAgent> = {
      [ASSISTANT_MAIN_JID]: {
        name: '旧桌面助手',
        folder: ASSISTANT_MAIN_FOLDER,
        trigger: '@old',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: true,
        isMain: false,
        description: '旧描述',
      },
    };

    const channel = factory!({
      onMessage: (_jid, msg) => storeMessage(msg),
      onChatMetadata: (jid, timestamp, name, channelName) =>
        storeChatMetadata(jid, timestamp, name, channelName),
      registeredAgents: () => agents,
      registerAgent: (jid, agent) => {
        agents[jid] = agent;
        setRegisteredAgent(jid, agent);
      },
      enqueueMessageCheck: () => undefined,
    });
    expect(channel).toBeTruthy();
    if (!channel) throw new Error('assistant channel factory returned null');

    await channel.connect();

    agents = getAllRegisteredAgents();
    expect(agents[ASSISTANT_MAIN_JID]).toMatchObject({
      folder: ASSISTANT_MAIN_FOLDER,
      trigger: '',
      requiresTrigger: false,
      isMain: true,
    });
    expect(agents[ASSISTANT_MAIN_JID]?.description).toContain(
      'assistant 桌面个人助手的沟通频道',
    );

    await channel.disconnect();
  });

  it('clears assistant chat messages only for the target chat', () => {
    storeAssistantChatMessage({
      id: 'assistant-main-1',
      chat_jid: ASSISTANT_MAIN_JID,
      sender: 'desktop_assistant_user',
      sender_name: 'Desktop User',
      content: 'main message',
      timestamp: '100',
      is_from_me: true,
      is_bot_message: false,
    });
    storeAssistantChatMessage({
      id: 'assistant-other-1',
      chat_jid: 'assistant:other',
      sender: 'desktop_assistant_user',
      sender_name: 'Desktop User',
      content: 'other message',
      timestamp: '101',
      is_from_me: true,
      is_bot_message: false,
    });

    expect(
      listAssistantChatMessageRecords(ASSISTANT_MAIN_JID, 10),
    ).toHaveLength(1);
    expect(
      listAssistantChatMessageRecords('assistant:other', 10).map(
        (message) => message.content,
      ),
    ).toEqual(['other message']);

    expect(clearAssistantChatMessages(ASSISTANT_MAIN_JID)).toBe(1);
    expect(listAssistantChatMessageRecords(ASSISTANT_MAIN_JID, 10)).toEqual([]);
    expect(
      listAssistantChatMessageRecords('assistant:other', 10).map(
        (message) => message.content,
      ),
    ).toEqual(['other message']);
  });
});
