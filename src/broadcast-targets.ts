import type { RegisteredAgent } from './types.js';

export function resolveBroadcastTargetJids(
  targets: string[],
  agents: Record<string, RegisteredAgent>,
): string[] {
  const resolved = new Set<string>();

  for (const rawTarget of targets) {
    const target = rawTarget.trim();
    if (!target) continue;

    if (agents[target]) {
      resolved.add(target);
      continue;
    }

    const matched = Object.entries(agents).find(([, agent]) => {
      return agent.folder === target || agent.name === target;
    });
    if (matched) resolved.add(matched[0]);
  }

  return [...resolved];
}

export function isBroadcastTargetAgent(
  agentJid: string,
  targets: string[],
  agents: Record<string, RegisteredAgent>,
): boolean {
  return resolveBroadcastTargetJids(targets, agents).includes(agentJid);
}
