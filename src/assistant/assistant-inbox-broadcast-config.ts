import { ASSISTANT_INBOX_BROADCAST_TARGETS } from '../config.js';
import {
  isBroadcastTargetGroup,
  resolveBroadcastTargetJids,
} from '../broadcast-targets.js';
import type { RegisteredGroup } from '../types.js';

function parseCsvList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getAssistantInboxBroadcastTargetKeys(): string[] {
  if (process.env.ASSISTANT_INBOX_BROADCAST_TARGETS !== undefined) {
    return parseCsvList(process.env.ASSISTANT_INBOX_BROADCAST_TARGETS);
  }
  return ASSISTANT_INBOX_BROADCAST_TARGETS;
}

export function isAssistantInboxBroadcastEnabled(): boolean {
  return getAssistantInboxBroadcastTargetKeys().length > 0;
}

export function resolveAssistantInboxBroadcastJids(
  groups: Record<string, RegisteredGroup>,
): string[] {
  return resolveBroadcastTargetJids(
    getAssistantInboxBroadcastTargetKeys(),
    groups,
  );
}

export function isAssistantInboxBroadcastGroup(
  groupJid: string,
  groups: Record<string, RegisteredGroup>,
): boolean {
  return isBroadcastTargetGroup(
    groupJid,
    getAssistantInboxBroadcastTargetKeys(),
    groups,
  );
}
