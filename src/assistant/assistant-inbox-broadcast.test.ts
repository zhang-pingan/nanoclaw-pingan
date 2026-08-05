import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import {
  createOrUpdateAgentInboxItem,
  updateAgentInboxItemStatus,
} from './agent-inbox-store.js';
import { AssistantInboxBroadcastService } from './assistant-inbox-broadcast.js';
import type { InteractiveCard, RegisteredAgent } from '../types.js';

const agents: Record<string, RegisteredAgent> = {
  'feishu:oc_1': {
    name: '主 Agent',
    folder: 'main',
    trigger: '',
    added_at: '1',
  },
};

beforeEach(() => {
  _initTestDatabase();
  process.env.ASSISTANT_INBOX_BROADCAST_TARGETS = 'main';
});

afterEach(() => {
  delete process.env.ASSISTANT_INBOX_BROADCAST_TARGETS;
  initAssistantEvents(() => {});
});

describe('AssistantInboxBroadcastService', () => {
  it('broadcasts active inbox items once per updated_at and target', async () => {
    const cards: Array<{ jid: string; card: InteractiveCard }> = [];
    const service = new AssistantInboxBroadcastService({
      registeredAgents: () => agents,
      sendCard: async (jid, card) => {
        cards.push({ jid, card });
        return 'msg-1';
      },
      sendMessage: async () => {},
    });
    initAssistantEvents((event) => {
      void service.handleEvent(event);
    });

    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'broadcast-once',
      kind: 'notification',
      title: '测试事项',
      sourceType: 'test',
    });
    await new Promise((resolve) => setImmediate(resolve));

    await service.handleEvent({ type: 'inbox_updated', item });

    expect(cards).toHaveLength(1);
    expect(cards[0].jid).toBe('feishu:oc_1');
    expect(cards[0].card.header.title).toBe('个人助手：测试事项');
  });

  it('falls back to text when card send fails', async () => {
    const messages: Array<{ jid: string; text: string }> = [];
    const service = new AssistantInboxBroadcastService({
      registeredAgents: () => agents,
      sendCard: async () => {
        throw new Error('card failed');
      },
      sendMessage: async (jid, text) => {
        messages.push({ jid, text });
      },
    });

    await service.handleEvent({
      type: 'inbox_updated',
      item: createOrUpdateAgentInboxItem({
        dedupeKey: 'broadcast-fallback',
        kind: 'notification',
        title: '降级事项',
        sourceType: 'test',
      }),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('卡片发送失败');
  });

  it('broadcasts status updates as cards when the channel supports cards', async () => {
    const cards: Array<{ jid: string; card: InteractiveCard }> = [];
    const service = new AssistantInboxBroadcastService({
      registeredAgents: () => agents,
      sendCard: async (jid, card) => {
        cards.push({ jid, card });
        return 'msg-1';
      },
      sendMessage: async () => {},
    });
    const created = createOrUpdateAgentInboxItem({
      dedupeKey: 'broadcast-status-card',
      kind: 'notification',
      title: '状态事项',
      sourceType: 'test',
    });
    const item = updateAgentInboxItemStatus(created.id, 'dismissed');

    await service.handleEvent({ type: 'inbox_updated', item });

    expect(cards).toHaveLength(1);
    expect(cards[0].jid).toBe('feishu:oc_1');
    expect(cards[0].card.header.title).toBe('个人助手事项已更新：状态事项');
    expect(cards[0].card.body).toContain('状态: 已忽略');
    expect(cards[0].card.body).toContain(`Inbox ID: ${item.id}`);
  });

  it('falls back to status text when status card send fails', async () => {
    const messages: Array<{ jid: string; text: string }> = [];
    const service = new AssistantInboxBroadcastService({
      registeredAgents: () => agents,
      sendCard: async () => {
        throw new Error('card failed');
      },
      sendMessage: async (jid, text) => {
        messages.push({ jid, text });
      },
    });
    const created = createOrUpdateAgentInboxItem({
      dedupeKey: 'broadcast-status-fallback',
      kind: 'notification',
      title: '状态降级事项',
      sourceType: 'test',
    });
    const item = updateAgentInboxItemStatus(created.id, 'dismissed');

    await service.handleEvent({ type: 'inbox_updated', item });

    expect(messages).toHaveLength(1);
    expect(messages[0].jid).toBe('feishu:oc_1');
    expect(messages[0].text).toContain('个人助手事项已更新：状态降级事项');
    expect(messages[0].text).toContain('状态: 已忽略');
    expect(messages[0].text).toContain(`Inbox ID: ${item.id}`);
  });
});
