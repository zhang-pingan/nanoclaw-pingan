import { WORKBENCH_BROADCAST_TARGETS } from './config.js';
import {
  isBroadcastTargetGroup,
  resolveBroadcastTargetJids,
} from './broadcast-targets.js';
import type { RegisteredGroup } from './types.js';

export function getWorkbenchBroadcastTargetKeys(): string[] {
  return WORKBENCH_BROADCAST_TARGETS;
}

export function isWorkbenchBroadcastEnabled(): boolean {
  return getWorkbenchBroadcastTargetKeys().length > 0;
}

export function resolveWorkbenchBroadcastJids(
  groups: Record<string, RegisteredGroup>,
): string[] {
  return resolveBroadcastTargetJids(getWorkbenchBroadcastTargetKeys(), groups);
}

export function isWorkbenchBroadcastGroup(
  groupJid: string,
  groups: Record<string, RegisteredGroup>,
): boolean {
  return isBroadcastTargetGroup(
    groupJid,
    getWorkbenchBroadcastTargetKeys(),
    groups,
  );
}
