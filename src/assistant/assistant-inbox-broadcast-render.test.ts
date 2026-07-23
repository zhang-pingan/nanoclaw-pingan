import { describe, expect, it } from 'vitest';

import { buildAssistantInboxBroadcastCard } from './assistant-inbox-broadcast-render.js';
import type { AgentInboxItemView } from './types.js';

function item(overrides: Partial<AgentInboxItemView> = {}): AgentInboxItemView {
  return {
    id: 'agent-inbox-1',
    dedupe_key: 'test',
    kind: 'risk',
    status: 'unread',
    priority: 'high',
    title: '线上 error 日志',
    body: 'BusinessException',
    source_type: 'online_error_log',
    source_ref_id: 'catstory',
    action_kind: null,
    action_label: null,
    action_url: null,
    action_payload: {},
    created_by: 'assistant',
    created_at: '1',
    updated_at: '1',
    due_at: null,
    snoozed_until: null,
    read_at: null,
    resolved_at: null,
    extra: {
      ruleKey: 'online.error_logs',
      investigation: {
        groups: [
          {
            id: 'g1',
            title: '配置缺失',
            repairable: true,
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('buildAssistantInboxBroadcastCard', () => {
  it('renders mobile actions and repairable investigation groups', () => {
    const card = buildAssistantInboxBroadcastCard(
      item({ action_kind: 'continue_today_plan', action_label: '继续计划' }),
    );

    expect(card?.header).toMatchObject({
      title: '个人助手：线上 error 日志',
      color: 'red',
    });
    expect(card?.buttons?.map((button) => button.value.action)).toContain(
      'assistant_inbox_broadcast_execute',
    );
    expect(card?.buttons?.map((button) => button.value.action)).toContain(
      'assistant_inbox_broadcast_investigate',
    );
    expect(card?.sections?.[0].buttons?.[0].value).toMatchObject({
      action: 'assistant_inbox_broadcast_repair',
      item_id: 'agent-inbox-1',
      group_id: 'g1',
    });
  });

  it('does not expose non-whitelisted execute actions', () => {
    const card = buildAssistantInboxBroadcastCard(
      item({
        kind: 'approval',
        action_kind: 'unsupported_action',
        extra: {},
      }),
    );

    expect(card?.buttons?.map((button) => button.value.action)).not.toContain(
      'assistant_inbox_broadcast_execute',
    );
  });
});
