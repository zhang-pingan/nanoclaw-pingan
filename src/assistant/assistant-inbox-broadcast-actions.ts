import { createHash } from 'crypto';

import {
  createAssistantActionLog,
  getAgentInboxItem,
  updateAgentInboxItemExtra,
} from './agent-inbox-store.js';
import { runAgentInboxAction } from './assistant-actions.js';
import {
  canInvestigateInboxItem,
  canRepairInboxItem,
} from './assistant-auto-flow.js';
import {
  buildAssistantInboxBroadcastActionFeedbackCard,
  isAssistantInboxActionKindExecutableOnMobile,
} from './assistant-inbox-broadcast-render.js';
import { isAssistantInboxBroadcastGroup } from './assistant-inbox-broadcast-config.js';
import type { AgentInboxItemView } from './types.js';
import type {
  CardActionResult,
  CardActorChannel,
  InteractiveCard,
  RegisteredGroup,
} from '../types.js';
import { logger } from '../logger.js';

export const ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX =
  'assistant_inbox_broadcast_';

type MobileInboxAction =
  | 'mark_read'
  | 'snooze'
  | 'dismiss'
  | 'resolve'
  | 'execute'
  | 'investigate'
  | 'repair';

interface AssistantInboxBroadcastCardActionResult extends CardActionResult {
  ok: boolean;
}

const ACTIVE_STATUSES = new Set(['unread', 'read', 'snoozed']);

function successResult(
  item: AgentInboxItemView,
  toastContent: string,
  statusText: string,
): AssistantInboxBroadcastCardActionResult {
  return {
    ok: true,
    toast: {
      type: 'success',
      content: toastContent,
    },
    replacementCard: buildAssistantInboxBroadcastActionFeedbackCard({
      item,
      statusText,
    }),
  };
}

function errorResult(message: string): AssistantInboxBroadcastCardActionResult {
  return {
    ok: false,
    toast: {
      type: 'error',
      content: message,
    },
  };
}

function isMobileInboxAction(action: string): action is MobileInboxAction {
  return (
    action === 'mark_read' ||
    action === 'snooze' ||
    action === 'dismiss' ||
    action === 'resolve' ||
    action === 'execute' ||
    action === 'investigate' ||
    action === 'repair'
  );
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`)
    .join(',')}}`;
}

function digest(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')
    .slice(0, 16);
}

function buildActor(input: {
  actorChannel?: CardActorChannel;
  userId: string;
  messageId?: string;
  targetJid?: string;
}): Record<string, unknown> {
  return {
    channel: input.actorChannel || 'feishu',
    userId: input.userId || 'unknown',
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.targetJid ? { targetJid: input.targetJid } : {}),
  };
}

function buildActionPayload(input: {
  action: MobileInboxAction;
  actorChannel?: CardActorChannel;
  userId: string;
  messageId?: string;
  targetJid?: string;
  groupId?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const payload = {
    source: 'assistant_inbox_broadcast',
    actor: buildActor(input),
    ...(input.groupId ? { group_id: input.groupId } : {}),
    ...(input.extra || {}),
  };
  return {
    ...payload,
    idempotencyKey: [
      'assistant-inbox-broadcast',
      input.messageId || input.userId || 'unknown',
      input.action,
      digest(payload),
    ].join(':'),
  };
}

function findRepairableGroup(
  item: AgentInboxItemView,
  groupId: string,
): Record<string, unknown> | null {
  const investigation = toRecord(item.extra.investigation);
  const groups = investigation.groups;
  if (!Array.isArray(groups)) return null;
  const group = groups.find(
    (entry) => toRecord(entry).id === groupId,
  ) as unknown;
  if (!group) return null;
  const groupRecord = toRecord(group);
  return groupRecord.repairable === true ? groupRecord : null;
}

function scheduleBackgroundAction(input: {
  itemId: string;
  action: 'investigate' | 'repair';
  payload: Record<string, unknown>;
}): void {
  void runAgentInboxAction(input).catch((err) => {
    logger.warn(
      { err, itemId: input.itemId, action: input.action },
      'Assistant inbox broadcast background action failed',
    );
  });
}

async function startAsyncAction(input: {
  item: AgentInboxItemView;
  action: 'investigate' | 'repair';
  payload: Record<string, unknown>;
  groupId?: string;
}): Promise<AssistantInboxBroadcastCardActionResult> {
  const currentStatus = input.item.extra.autoFlowStatus;
  if (input.action === 'investigate' && currentStatus === 'investigating') {
    return successResult(
      input.item,
      '排查已在进行中。',
      '排查已在进行中，完成后会更新卡片。',
    );
  }
  if (input.action === 'repair' && currentStatus === 'repairing') {
    return successResult(
      input.item,
      '修复已在进行中。',
      '修复已在进行中，完成后会更新卡片。',
    );
  }

  const statusPatch =
    input.action === 'investigate'
      ? {
          autoFlowStatus: 'investigating',
          lastInvestigationError: null,
        }
      : {
          autoFlowStatus: 'repairing',
          lastRepairGroupId: input.groupId || null,
          lastRepairError: null,
        };
  const updated = updateAgentInboxItemExtra(input.item.id, statusPatch);
  createAssistantActionLog({
    itemId: input.item.id,
    action: `broadcast_${input.action}`,
    status: 'success',
    title: input.item.title,
    sourceType: input.item.source_type,
    sourceRefId: input.item.source_ref_id,
    payload: input.payload,
  });

  scheduleBackgroundAction({
    itemId: input.item.id,
    action: input.action,
    payload: input.payload,
  });

  const text =
    input.action === 'investigate'
      ? '已开始排查，完成后会更新卡片。'
      : '已开始修复，完成后会更新卡片。';
  return successResult(updated, text, text);
}

function stripPrefix(action: string): string {
  return action.startsWith(ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX)
    ? action.slice(ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX.length)
    : action;
}

export async function handleAssistantInboxBroadcastCardAction(input: {
  action: string;
  formValue?: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
  userId: string;
  actorChannel?: CardActorChannel;
  messageId?: string;
  targetJid?: string;
  sendCard?: (
    jid: string,
    card: InteractiveCard,
  ) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}): Promise<AssistantInboxBroadcastCardActionResult> {
  const action = stripPrefix(input.action);
  if (!isMobileInboxAction(action)) {
    return errorResult(`不支持的个人助手广播动作：${input.action}`);
  }

  if (
    !input.targetJid ||
    !isAssistantInboxBroadcastGroup(input.targetJid, input.registeredGroups)
  ) {
    return errorResult('该卡片不在允许的个人助手广播目标中，已拒绝操作。');
  }

  const itemId = input.formValue?.item_id || '';
  if (!itemId) return errorResult('缺少 inbox item id，无法处理该卡片。');
  const item = getAgentInboxItem(itemId);
  if (!item) return errorResult('个人助手事项不存在，无法处理。');
  if (!ACTIVE_STATUSES.has(item.status)) {
    return errorResult(`该事项当前状态为 ${item.status}，不能重复处理。`);
  }

  if (
    action === 'execute' &&
    !isAssistantInboxActionKindExecutableOnMobile(item.action_kind)
  ) {
    return errorResult(
      `该执行动作不允许在移动端触发：${item.action_kind || 'unknown'}`,
    );
  }
  if (action === 'investigate' && !canInvestigateInboxItem(item)) {
    return errorResult('该事项当前不支持移动端排查。');
  }

  const groupId = input.formValue?.group_id || '';
  if (action === 'repair') {
    if (!groupId) return errorResult('缺少修复分类 group_id。');
    if (!canRepairInboxItem(item)) {
      return errorResult('该事项当前不支持移动端自动修复。');
    }
    if (!findRepairableGroup(item, groupId)) {
      return errorResult('该修复分类不存在或不可自动修复。');
    }
  }

  const payload = buildActionPayload({
    action,
    actorChannel: input.actorChannel,
    userId: input.userId,
    messageId: input.messageId,
    targetJid: input.targetJid,
    groupId: action === 'repair' ? groupId : undefined,
    extra: action === 'snooze' ? { minutes: 60 } : undefined,
  });

  try {
    if (action === 'investigate' || action === 'repair') {
      return startAsyncAction({
        item,
        action,
        payload,
        groupId: action === 'repair' ? groupId : undefined,
      });
    }

    const result = await runAgentInboxAction({
      itemId: item.id,
      action,
      payload,
    });

    switch (action) {
      case 'mark_read':
        return successResult(result.item, '已标记已读。', '已标记已读。');
      case 'snooze':
        return successResult(
          result.item,
          '已设置稍后提醒。',
          '已设置稍后提醒。',
        );
      case 'dismiss':
        return successResult(result.item, '已忽略。', '已忽略。');
      case 'resolve':
        return successResult(result.item, '已标记已处理。', '已标记已处理。');
      case 'execute':
        return successResult(
          result.item,
          '已提交执行请求。',
          '已提交执行请求。',
        );
      default:
        return errorResult(`不支持的个人助手广播动作：${input.action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`处理失败：${message}`);
  }
}

export function logAssistantInboxBroadcastActionFailure(
  action: string,
  err: unknown,
): void {
  logger.warn(
    { action, err },
    'assistant inbox broadcast card action handling failed',
  );
}
