import {
  listAssistantChatMessages,
  sendAssistantUserMessage,
} from './assistant-channel-bridge.js';
import { runAgentInboxAction } from './assistant-actions.js';
import {
  getAgentInboxCounts,
  getAssistantSettings,
  listAgentInboxItems,
  listAssistantActionLogs,
  updateAssistantSettings,
} from './agent-inbox-store.js';
import { runProactiveScan } from './proactive-engine.js';
import type { AgentInboxStatus, AssistantState } from './types.js';

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toLimit(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), 1), 1000);
}

function toStatus(value: unknown): AgentInboxStatus | 'active' | 'all' {
  if (
    value === 'unread' ||
    value === 'read' ||
    value === 'done' ||
    value === 'dismissed' ||
    value === 'snoozed' ||
    value === 'active' ||
    value === 'all'
  ) {
    return value;
  }
  return 'active';
}

export function getAssistantState(): AssistantState {
  return {
    settings: getAssistantSettings(),
    inboxCounts: getAgentInboxCounts(),
    latestInboxItems: listAgentInboxItems({ status: 'active', limit: 20 }),
    latestActionLogs: listAssistantActionLogs(20),
  };
}

export function listAgentInboxForApi(input: {
  status?: unknown;
  limit?: unknown;
}) {
  return {
    items: listAgentInboxItems({
      status: toStatus(input.status),
      limit: toLimit(input.limit, 100),
    }),
    counts: getAgentInboxCounts(),
  };
}

export function updateAssistantSettingsForApi(body: unknown) {
  return updateAssistantSettings(toRecord(body));
}

export function runAgentInboxActionForApi(body: unknown) {
  const input = toRecord(body);
  const itemId = typeof input.item_id === 'string' ? input.item_id : '';
  const action = typeof input.action === 'string' ? input.action : '';
  if (!itemId || !action) {
    throw new Error('item_id and action required');
  }
  const payload = toRecord(input.payload);
  return runAgentInboxAction({ itemId, action, payload });
}

export function runAssistantScanForApi() {
  return runProactiveScan();
}

export function listAssistantChatForApi(input: { limit?: unknown }) {
  return {
    messages: listAssistantChatMessages(toLimit(input.limit, 80)),
  };
}

export function sendAssistantChatMessageForApi(body: unknown) {
  const input = toRecord(body);
  const content = typeof input.content === 'string' ? input.content : '';
  if (!content.trim()) {
    throw new Error('content required');
  }
  return sendAssistantUserMessage(content);
}
