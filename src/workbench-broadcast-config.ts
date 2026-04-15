import { WORKBENCH_BROADCAST_TARGETS } from './config.js';
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
  const targets = getWorkbenchBroadcastTargetKeys();
  const resolved = new Set<string>();

  for (const target of targets) {
    if (groups[target]) {
      resolved.add(target);
      continue;
    }

    const matched = Object.entries(groups).find(([, group]) => {
      return group.folder === target || group.name === target;
    });
    if (matched) resolved.add(matched[0]);
  }

  return [...resolved];
}

export function isWorkbenchBroadcastGroup(
  groupJid: string,
  groups: Record<string, RegisteredGroup>,
): boolean {
  return resolveWorkbenchBroadcastJids(groups).includes(groupJid);
}
