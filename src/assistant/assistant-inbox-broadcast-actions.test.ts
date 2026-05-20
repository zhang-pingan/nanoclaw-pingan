import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import { initAssistantAutoFlow } from './assistant-auto-flow.js';
import {
  createOrUpdateAgentInboxItem,
  getAgentInboxItem,
  listAssistantActionLogs,
} from './agent-inbox-store.js';
import { handleAssistantInboxBroadcastCardAction } from './assistant-inbox-broadcast-actions.js';
import type { RegisteredGroup } from '../types.js';

const groups: Record<string, RegisteredGroup> = {
  'feishu:oc_allowed': {
    name: '主群',
    folder: 'main',
    trigger: '',
    added_at: '1',
  },
};

function baseInput(action: string, itemId: string) {
  return {
    action,
    formValue: {
      action,
      item_id: itemId,
    },
    registeredGroups: groups,
    userId: 'user-1',
    actorChannel: 'feishu' as const,
    messageId: 'msg-1',
    targetJid: 'feishu:oc_allowed',
    sendMessage: async () => {},
  };
}

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
  initAssistantAutoFlow({ agentRunner: null });
  process.env.ASSISTANT_INBOX_BROADCAST_TARGETS = 'main';
});

afterEach(() => {
  delete process.env.ASSISTANT_INBOX_BROADCAST_TARGETS;
  vi.useRealTimers();
});

describe('handleAssistantInboxBroadcastCardAction', () => {
  it('rejects callbacks outside configured broadcast targets', async () => {
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'reject-target',
      kind: 'notification',
      title: '测试事项',
      sourceType: 'test',
    });

    const result = await handleAssistantInboxBroadcastCardAction({
      ...baseInput('assistant_inbox_broadcast_dismiss', item.id),
      targetJid: 'feishu:oc_other',
    });

    expect(result.ok).toBe(false);
    expect(result.toast?.content).toContain('允许的个人助手广播目标');
    expect(getAgentInboxItem(item.id)?.status).toBe('unread');
  });

  it('dismisses an active item and records mobile actor payload', async () => {
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'dismiss',
      kind: 'notification',
      title: '测试事项',
      sourceType: 'test',
    });

    const result = await handleAssistantInboxBroadcastCardAction(
      baseInput('assistant_inbox_broadcast_dismiss', item.id),
    );

    expect(result.ok).toBe(true);
    expect(getAgentInboxItem(item.id)?.status).toBe('dismissed');
    expect(listAssistantActionLogs(1)[0].payload).toMatchObject({
      source: 'assistant_inbox_broadcast',
      actor: {
        channel: 'feishu',
        userId: 'user-1',
        messageId: 'msg-1',
        targetJid: 'feishu:oc_allowed',
      },
    });
  });

  it('rejects execute actions outside the mobile whitelist', async () => {
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'blocked-execute',
      kind: 'approval',
      title: '采纳方案',
      sourceType: 'assistant_evolution',
      sourceRefId: 'evo-1',
      actionKind: 'assistant_evolution_adopt',
    });

    const result = await handleAssistantInboxBroadcastCardAction(
      baseInput('assistant_inbox_broadcast_execute', item.id),
    );

    expect(result.ok).toBe(false);
    expect(result.toast?.content).toContain('不允许在移动端触发');
  });

  it('requires repair group_id and repairable group', async () => {
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'repair-group',
      kind: 'risk',
      title: '可修复事项',
      triggerRuleKey: 'online.error_logs',
      sourceType: 'online_error_log',
      sourceRefId: 'catstory',
      extra: {
        investigation: {
          groups: [
            {
              id: 'g1',
              title: '配置缺失',
              repairable: false,
            },
          ],
        },
      },
    });

    const missing = await handleAssistantInboxBroadcastCardAction(
      baseInput('assistant_inbox_broadcast_repair', item.id),
    );
    const notRepairable = await handleAssistantInboxBroadcastCardAction({
      ...baseInput('assistant_inbox_broadcast_repair', item.id),
      formValue: {
        action: 'assistant_inbox_broadcast_repair',
        item_id: item.id,
        group_id: 'g1',
      },
    });

    expect(missing.ok).toBe(false);
    expect(missing.toast?.content).toContain('group_id');
    expect(notRepairable.ok).toBe(false);
    expect(notRepairable.toast?.content).toContain('不存在或不可自动修复');
  });

  it('starts investigation asynchronously and returns immediately', async () => {
    vi.useFakeTimers();
    const runner = vi.fn(
      async () =>
        new Promise<{ ok: boolean; text: string }>((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              text: JSON.stringify({
                ok: true,
                summary: '排查完成',
                root_cause: null,
                repairable: false,
                repair_plan: null,
                risk_level: 'unknown',
                required_user_action: null,
                evidence: [],
                groups: [
                  {
                    id: 'g1',
                    title: '分类',
                    log_indexes: [],
                    count: 1,
                    root_cause: null,
                    repairable: false,
                    repair_plan: null,
                    risk_level: 'unknown',
                    required_user_action: null,
                    evidence: [],
                  },
                ],
              }),
            });
          }, 10);
        }),
    );
    initAssistantAutoFlow({ agentRunner: runner });
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'async-investigate',
      kind: 'risk',
      title: '线上异常',
      triggerRuleKey: 'online.error_logs',
      sourceType: 'online_error_log',
      sourceRefId: 'catstory',
      extra: {
        onlineErrorLog: { logs: [{ rawLog: 'err' }] },
      },
    });

    const result = await handleAssistantInboxBroadcastCardAction(
      baseInput('assistant_inbox_broadcast_investigate', item.id),
    );

    expect(result.ok).toBe(true);
    expect(result.toast?.content).toContain('已开始排查');
    expect(getAgentInboxItem(item.id)?.extra.autoFlowStatus).toBe(
      'investigating',
    );

    await vi.advanceTimersByTimeAsync(20);
    expect(getAgentInboxItem(item.id)?.extra.autoFlowStatus).toBe(
      'investigated',
    );
  });
});
