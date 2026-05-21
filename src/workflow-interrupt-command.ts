import {
  getWorkflow,
  getWorkflowInterrupt,
  listWorkbenchActionItemsBySource,
} from './db.js';
import type {
  RegisteredGroup,
  WorkflowInterruptActorChannel,
} from './types.js';
import { runWorkbenchActionItemAction } from './workbench.js';

export type WorkflowResumeCommand = {
  interruptId: string;
  action: string;
  payload: Record<string, unknown>;
};

const RESERVED_COMMAND_KEYS = new Set(['action']);

function parseScalar(value: string): unknown {
  const text = value.trim();
  if (/^(true|false)$/i.test(text)) return /^true$/i.test(text);
  if (/^[-+]?\d+$/.test(text)) {
    const parsed = Number.parseInt(text, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (/^[-+]?(?:\d+\.\d+|\d+\.\d*|\.\d+)$/.test(text)) {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function parsePayloadText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  const chunks = trimmed
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const entries: Record<string, unknown> = {};
  for (const chunk of chunks) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const key = chunk.slice(0, eq).trim();
    if (!key || RESERVED_COMMAND_KEYS.has(key)) continue;
    entries[key] = parseScalar(chunk.slice(eq + 1));
  }
  return entries;
}

export function parseWorkflowResumeCommand(
  content: string,
  triggerPattern: RegExp,
): WorkflowResumeCommand | null {
  const text = content.trim().replace(triggerPattern, '').trim();
  if (!text.startsWith('/resume')) return null;
  const rest = text.slice('/resume'.length).trim();
  if (!rest) return null;
  const [interruptId, action, ...payloadParts] = rest.split(/\s+/);
  if (!interruptId || !action) return null;
  return {
    interruptId: interruptId.trim(),
    action: action.trim(),
    payload: parsePayloadText(payloadParts.join(' ')),
  };
}

function chatJidForGroupFolder(
  groupFolder: string | null | undefined,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  if (!groupFolder) return undefined;
  return Object.entries(registeredGroups).find(
    ([, group]) => group.folder === groupFolder,
  )?.[0];
}

function inferChannelFromJid(
  jid: string | undefined,
): WorkflowInterruptActorChannel {
  if (!jid) return 'system';
  if (jid.startsWith('feishu:')) return 'feishu';
  if (jid.startsWith('assistant:')) return 'assistant';
  if (jid.startsWith('web:')) return 'web';
  return 'web';
}

function normalizeAction(
  action: string,
):
  | 'confirm'
  | 'approve'
  | 'reject'
  | 'revise'
  | 'submit'
  | 'skip'
  | 'cancel'
  | 'resolve'
  | null {
  if (
    action === 'confirm' ||
    action === 'approve' ||
    action === 'reject' ||
    action === 'revise' ||
    action === 'submit' ||
    action === 'skip' ||
    action === 'cancel' ||
    action === 'resolve'
  ) {
    return action;
  }
  return null;
}

export function handleWorkflowResumeCommand(input: {
  command: WorkflowResumeCommand;
  currentChatJid?: string;
  currentGroupFolder?: string;
  registeredGroups: Record<string, RegisteredGroup>;
  userId?: string;
}): { ok: boolean; message: string } {
  const interrupt = getWorkflowInterrupt(input.command.interruptId);
  if (!interrupt) return { ok: false, message: '未找到对应的流程中断。' };

  const workflow = getWorkflow(interrupt.workflow_id);
  if (!workflow) return { ok: false, message: '流程不存在。' };

  const items = listWorkbenchActionItemsBySource(
    'workflow_interrupt',
    interrupt.id,
  );
  const item =
    items.find((entry) => entry.status === 'pending') ||
    items.find((entry) => entry.workflow_id === workflow.id);
  if (!item) {
    return { ok: false, message: '未找到对应的工作台待办。' };
  }
  const action = normalizeAction(input.command.action);
  if (!action) {
    return { ok: false, message: `不支持的恢复动作：${input.command.action}` };
  }

  const expectedChatJid = chatJidForGroupFolder(
    item.group_folder,
    input.registeredGroups,
  );
  const actorChannel = inferChannelFromJid(input.currentChatJid);
  const result = runWorkbenchActionItemAction({
    taskId: item.task_id,
    actionItemId: item.id,
    action,
    payload: input.command.payload,
    actor: {
      channel: actorChannel,
      userId: input.userId || 'text-command',
    },
    idempotencyKey: [
      'text-resume',
      input.currentChatJid || '',
      input.userId || '',
      item.id,
      input.command.action,
      Date.now(),
    ].join(':'),
  });
  if (result.error) return { ok: false, message: `恢复失败：${result.error}` };

  const scopeHint =
    expectedChatJid &&
    input.currentChatJid &&
    expectedChatJid !== input.currentChatJid
      ? `（已从当前群处理原待办群 ${expectedChatJid} 的待办）`
      : '';
  return { ok: true, message: `已提交操作，正在推进后续流程。${scopeHint}` };
}
