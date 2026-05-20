import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import { createOrUpdateAgentInboxItem } from './agent-inbox-store.js';
import { AssistantInboxBroadcastService } from './assistant-inbox-broadcast.js';
import type { InteractiveCard, RegisteredGroup } from '../types.js';

const groups: Record<string, RegisteredGroup> = {
  'feishu:oc_1': {
    name: '主群',
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
      registeredGroups: () => groups,
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
      registeredGroups: () => groups,
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
});
