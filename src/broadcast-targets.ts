import type { RegisteredGroup } from './types.js';

export function resolveBroadcastTargetJids(
  targets: string[],
  groups: Record<string, RegisteredGroup>,
): string[] {
  const resolved = new Set<string>();

  for (const rawTarget of targets) {
    const target = rawTarget.trim();
    if (!target) continue;

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

export function isBroadcastTargetGroup(
  groupJid: string,
  targets: string[],
  groups: Record<string, RegisteredGroup>,
): boolean {
  return resolveBroadcastTargetJids(targets, groups).includes(groupJid);
}
