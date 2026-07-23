import {
  canInvestigateInboxItem,
  canRepairInboxItem,
} from './assistant-auto-flow.js';
import type { AgentInboxItemView } from './types.js';
import type { CardButton, CardHeaderColor, InteractiveCard } from '../types.js';

const ACTIVE_STATUSES = new Set(['unread', 'read', 'snoozed']);
const MOBILE_EXECUTE_ACTION_KINDS = new Set(['continue_today_plan']);

function compactText(value: string | null | undefined, max = 420): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function headerColorForInboxItem(item: AgentInboxItemView): CardHeaderColor {
  if (item.priority === 'urgent' || item.kind === 'risk') return 'red';
  if (item.priority === 'high' || item.kind === 'approval') return 'orange';
  if (item.kind === 'suggestion') return 'blue';
  return 'grey';
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'approval':
      return '审批';
    case 'risk':
      return '风险';
    case 'suggestion':
      return '建议';
    default:
      return '通知';
  }
}

function priorityLabel(priority: string): string {
  switch (priority) {
    case 'urgent':
      return '紧急';
    case 'high':
      return '高';
    case 'low':
      return '低';
    default:
      return '普通';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'unread':
      return '未读';
    case 'read':
      return '已读';
    case 'done':
      return '已处理';
    case 'dismissed':
      return '已忽略';
    case 'snoozed':
      return '稍后提醒';
    default:
      return status;
  }
}

function buildActionValue(
  action: string,
  item: AgentInboxItemView,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    action: `assistant_inbox_broadcast_${action}`,
    item_id: item.id,
    ...extra,
  };
}

function button(
  id: string,
  label: string,
  action: string,
  item: AgentInboxItemView,
  type: CardButton['type'] = 'default',
  extra: Record<string, string> = {},
): CardButton {
  return {
    id,
    label,
    type,
    value: buildActionValue(action, item, extra),
  };
}

function canExecuteOnMobile(item: AgentInboxItemView): boolean {
  return Boolean(
    item.action_kind && MOBILE_EXECUTE_ACTION_KINDS.has(item.action_kind),
  );
}

function repairableGroups(item: AgentInboxItemView): Array<{
  id: string;
  title: string;
}> {
  const investigation = item.extra.investigation;
  if (!investigation || typeof investigation !== 'object') return [];
  const groups = (investigation as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  return groups
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const group = entry as Record<string, unknown>;
      const id = stringValue(group.id);
      if (!id || group.repairable !== true) return null;
      return {
        id,
        title: stringValue(group.title) || id,
      };
    })
    .filter((entry): entry is { id: string; title: string } => Boolean(entry))
    .slice(0, 3);
}

function sourceLabel(item: AgentInboxItemView): string {
  const parts = [item.source_type, item.source_ref_id].filter(Boolean);
  return parts.join(' / ');
}

function buildExtraLines(item: AgentInboxItemView): string[] {
  const lines: string[] = [];
  const ruleKey = stringValue(item.extra.ruleKey);
  const autoFlowStatus = stringValue(item.extra.autoFlowStatus);
  const lastError =
    stringValue(item.extra.lastInvestigationError) ||
    stringValue(item.extra.lastRepairError) ||
    stringValue(item.extra.lastAutoFlowError);

  if (ruleKey) lines.push(`规则: ${ruleKey}`);
  if (autoFlowStatus) lines.push(`自动流程: ${autoFlowStatus}`);
  if (lastError) lines.push(`最近错误: ${compactText(lastError, 180)}`);
  if (item.due_at) lines.push(`到期: ${item.due_at}`);
  if (item.snoozed_until) lines.push(`稍后到: ${item.snoozed_until}`);
  if (item.action_kind) lines.push(`动作: ${item.action_kind}`);
  return lines;
}

function buildBody(item: AgentInboxItemView): string {
  const lines = [
    `类型: ${kindLabel(item.kind)} / 优先级: ${priorityLabel(item.priority)} / 状态: ${statusLabel(item.status)}`,
    sourceLabel(item) ? `来源: ${sourceLabel(item)}` : '',
    item.body ? `说明: ${compactText(item.body)}` : '',
    ...buildExtraLines(item),
    `Inbox ID: ${item.id}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function buildButtons(item: AgentInboxItemView): CardButton[] {
  if (!ACTIVE_STATUSES.has(item.status)) return [];

  const buttons: CardButton[] = [];
  if (canExecuteOnMobile(item)) {
    buttons.push(
      button(
        'assistant-inbox-execute',
        item.action_label || '执行',
        'execute',
        item,
        'primary',
      ),
    );
  }
  if (canInvestigateInboxItem(item)) {
    buttons.push(
      button(
        'assistant-inbox-investigate',
        '排查',
        'investigate',
        item,
        'primary',
      ),
    );
  }
  buttons.push(
    button('assistant-inbox-resolve', '已处理', 'resolve', item),
    button('assistant-inbox-snooze', '稍后', 'snooze', item),
    button('assistant-inbox-dismiss', '忽略', 'dismiss', item, 'danger'),
  );

  return buttons.slice(0, 5);
}

export function isAssistantInboxActionKindExecutableOnMobile(
  actionKind: string | null | undefined,
): boolean {
  return Boolean(actionKind && MOBILE_EXECUTE_ACTION_KINDS.has(actionKind));
}

export function buildAssistantInboxBroadcastCard(
  item: AgentInboxItemView,
): InteractiveCard | null {
  return {
    header: {
      title: `个人助手：${item.title || '未命名事项'}`,
      color: headerColorForInboxItem(item),
    },
    body: buildBody(item),
    buttons: buildButtons(item),
    sections:
      ACTIVE_STATUSES.has(item.status) && canRepairInboxItem(item)
        ? repairableGroups(item).map((group) => ({
            body: `可修复分类: ${group.title}`,
            buttons: [
              button(
                `assistant-inbox-repair-${group.id}`,
                '修复',
                'repair',
                item,
                'primary',
                { group_id: group.id },
              ),
            ],
          }))
        : undefined,
  };
}

export function buildAssistantInboxBroadcastFallbackText(
  item: AgentInboxItemView,
): string {
  return [
    `【个人助手：${item.title || '未命名事项'}】`,
    `类型: ${kindLabel(item.kind)}`,
    `优先级: ${priorityLabel(item.priority)}`,
    `状态: ${statusLabel(item.status)}`,
    sourceLabel(item) ? `来源: ${sourceLabel(item)}` : '',
    item.body ? `说明: ${compactText(item.body, 500)}` : '',
    `Inbox ID: ${item.id}`,
    '卡片发送失败，请到个人助手或 Web 工作台处理。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildAssistantInboxBroadcastStatusText(
  item: AgentInboxItemView,
): string {
  return [
    `个人助手事项已更新：${item.title || '未命名事项'}`,
    `状态: ${statusLabel(item.status)}`,
    `Inbox ID: ${item.id}`,
  ].join('\n');
}

export function buildAssistantInboxBroadcastStatusCard(
  item: AgentInboxItemView,
): InteractiveCard {
  return {
    header: {
      title: `个人助手事项已更新：${item.title || '未命名事项'}`,
      color: headerColorForInboxItem(item),
    },
    body: [
      `状态: ${statusLabel(item.status)}`,
      sourceLabel(item) ? `来源: ${sourceLabel(item)}` : '',
      item.body ? `说明: ${compactText(item.body)}` : '',
      ...buildExtraLines(item),
      `Inbox ID: ${item.id}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function buildAssistantInboxBroadcastActionFeedbackCard(input: {
  item: AgentInboxItemView;
  statusText: string;
}): InteractiveCard {
  return {
    header: {
      title: `个人助手：${input.item.title || '未命名事项'}`,
      color: headerColorForInboxItem(input.item),
    },
    body: [buildBody(input.item), `处理状态: ${input.statusText}`]
      .filter(Boolean)
      .join('\n'),
  };
}
