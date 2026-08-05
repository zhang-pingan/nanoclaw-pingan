import { ASSISTANT_INBOX_BROADCAST_TARGETS } from '../config.js';
import {
  isBroadcastTargetAgent,
  resolveBroadcastTargetJids,
} from '../broadcast-targets.js';
import type { RegisteredAgent } from '../types.js';

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
  agents: Record<string, RegisteredAgent>,
): string[] {
  return resolveBroadcastTargetJids(
    getAssistantInboxBroadcastTargetKeys(),
    agents,
  );
}

export function isAssistantInboxBroadcastAgent(
  agentJid: string,
  agents: Record<string, RegisteredAgent>,
): boolean {
  return isBroadcastTargetAgent(
    agentJid,
    getAssistantInboxBroadcastTargetKeys(),
    agents,
  );
}
