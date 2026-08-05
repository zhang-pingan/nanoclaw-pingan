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
import type { RegisteredAgent } from '../types.js';

const agents: Record<string, RegisteredAgent> = {
  'feishu:oc_allowed': {
    name: '主 Agent',
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
    registeredAgents: agents,
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
      title: '不支持的操作',
      sourceType: 'test',
      sourceRefId: 'unsupported-1',
      actionKind: 'unsupported_action',
    });

    const result = await handleAssistantInboxBroadcastCardAction(
      baseInput('assistant_inbox_broadcast_execute', item.id),
    );

    expect(result.ok).toBe(false);
    expect(result.toast?.content).toContain('不允许在移动端触发');
  });

  it('rejects async actions before mutating unsupported inbox items', async () => {
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'unsupported-async',
      kind: 'notification',
      title: '普通通知',
      sourceType: 'test',
    });

    const investigate = await handleAssistantInboxBroadcastCardAction(
      baseInput('assistant_inbox_broadcast_investigate', item.id),
    );
    const repair = await handleAssistantInboxBroadcastCardAction({
      ...baseInput('assistant_inbox_broadcast_repair', item.id),
      formValue: {
        action: 'assistant_inbox_broadcast_repair',
        item_id: item.id,
        group_id: 'g1',
      },
    });

    expect(investigate.ok).toBe(false);
    expect(investigate.toast?.content).toContain('不支持移动端排查');
    expect(repair.ok).toBe(false);
    expect(repair.toast?.content).toContain('不支持移动端自动修复');
    expect(getAgentInboxItem(item.id)?.extra.autoFlowStatus).toBeUndefined();
    expect(listAssistantActionLogs(10)).toHaveLength(0);
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
              repairable: true,
            },
            {
              id: 'g2',
              title: '人工处理',
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
        group_id: 'g2',
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
