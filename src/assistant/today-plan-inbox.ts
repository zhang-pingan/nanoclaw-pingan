import { getTodayPlanByDate } from '../db.js';
import { getTodayPlanDateKey } from '../today-plan.js';
import {
  resolveActiveAgentInboxItemByDedupeKey,
  resolveActiveAgentInboxItemsByDedupePrefix,
} from './agent-inbox-store.js';
import type { AgentInboxItemView } from './types.js';

export function resolveTodayPlanInboxItemsForDate(
  planDate: string,
): AgentInboxItemView[] {
  if (!planDate) return [];
  return [
    ...[
      resolveActiveAgentInboxItemByDedupeKey(`today-plan:missing:${planDate}`),
    ].filter((item): item is AgentInboxItemView => Boolean(item)),
    ...resolveActiveAgentInboxItemsByDedupePrefix(
      `today-plan:continue:${planDate}:`,
    ),
  ];
}

export function resolveTodayPlanInboxItemsIfPlanExists(
  planDate: string = getTodayPlanDateKey(),
): AgentInboxItemView[] {
  if (!getTodayPlanByDate(planDate)) return [];
  return resolveTodayPlanInboxItemsForDate(planDate);
}
