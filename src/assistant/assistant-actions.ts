import { createOrContinueTodayPlan } from '../today-plan.js';
import {
  createAssistantActionLog,
  createAssistantSnooze,
  getAgentInboxItem,
  updateAgentInboxItemStatus,
} from './agent-inbox-store.js';
import type { AgentInboxItemView } from './types.js';

function requireItem(itemId: string): AgentInboxItemView {
  const item = getAgentInboxItem(itemId);
  if (!item) throw new Error('Agent inbox item not found');
  return item;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getSnoozeUntil(payload: Record<string, unknown>): string {
  if (typeof payload.until === 'string' && payload.until.trim()) {
    return payload.until.trim();
  }
  const minutes =
    typeof payload.minutes === 'number' && Number.isFinite(payload.minutes)
      ? Math.min(Math.max(Math.round(payload.minutes), 1), 60 * 24 * 7)
      : 60;
  return String(Date.now() + minutes * 60 * 1000);
}

export function runAgentInboxAction(input: {
  itemId: string;
  action: string;
  payload?: Record<string, unknown>;
}): { ok: true; item: AgentInboxItemView; result: Record<string, unknown> } {
  const item = requireItem(input.itemId);
  const payload = toRecord(input.payload);

  try {
    if (input.action === 'mark_read') {
      const updated = updateAgentInboxItemStatus(item.id, 'read');
      createAssistantActionLog({
        itemId: item.id,
        action: input.action,
        status: 'success',
        title: item.title,
        sourceType: item.source_type,
        sourceRefId: item.source_ref_id,
      });
      return { ok: true, item: updated, result: { status: 'read' } };
    }

    if (input.action === 'dismiss') {
      const updated = updateAgentInboxItemStatus(item.id, 'dismissed');
      createAssistantActionLog({
        itemId: item.id,
        action: input.action,
        status: 'success',
        title: item.title,
        sourceType: item.source_type,
        sourceRefId: item.source_ref_id,
      });
      return { ok: true, item: updated, result: { status: 'dismissed' } };
    }

    if (input.action === 'resolve') {
      const updated = updateAgentInboxItemStatus(item.id, 'done');
      createAssistantActionLog({
        itemId: item.id,
        action: input.action,
        status: 'success',
        title: item.title,
        sourceType: item.source_type,
        sourceRefId: item.source_ref_id,
      });
      return { ok: true, item: updated, result: { status: 'done' } };
    }

    if (input.action === 'snooze') {
      const until = getSnoozeUntil(payload);
      createAssistantSnooze({
        scope: 'agent_inbox_item',
        scopeRef: item.id,
        until,
        reason:
          typeof payload.reason === 'string' ? payload.reason.trim() : null,
      });
      const updated = updateAgentInboxItemStatus(item.id, 'snoozed', {
        snoozedUntil: until,
      });
      createAssistantActionLog({
        itemId: item.id,
        action: input.action,
        status: 'success',
        title: item.title,
        sourceType: item.source_type,
        sourceRefId: item.source_ref_id,
        payload,
        result: { until },
      });
      return { ok: true, item: updated, result: { status: 'snoozed', until } };
    }

    if (input.action === 'execute') {
      if (item.action_kind === 'create_today_plan') {
        const plan = createOrContinueTodayPlan();
        const updated = updateAgentInboxItemStatus(item.id, 'done');
        createAssistantActionLog({
          itemId: item.id,
          action: item.action_kind,
          status: 'success',
          title: item.title,
          sourceType: item.source_type,
          sourceRefId: item.source_ref_id,
          payload,
          result: { planId: plan.id, planDate: plan.plan_date },
        });
        return {
          ok: true,
          item: updated,
          result: { planId: plan.id, planDate: plan.plan_date },
        };
      }

      if (item.action_kind === 'continue_today_plan') {
        const continueFromPlanId =
          typeof item.action_payload.continueFromPlanId === 'string'
            ? item.action_payload.continueFromPlanId
            : '';
        if (!continueFromPlanId) {
          throw new Error('continueFromPlanId missing');
        }
        const plan = createOrContinueTodayPlan({ continueFromPlanId });
        const updated = updateAgentInboxItemStatus(item.id, 'done');
        createAssistantActionLog({
          itemId: item.id,
          action: item.action_kind,
          status: 'success',
          title: item.title,
          sourceType: item.source_type,
          sourceRefId: item.source_ref_id,
          payload,
          result: { planId: plan.id, planDate: plan.plan_date },
        });
        return {
          ok: true,
          item: updated,
          result: { planId: plan.id, planDate: plan.plan_date },
        };
      }

      createAssistantActionLog({
        itemId: item.id,
        action: item.action_kind || input.action,
        status: 'skipped',
        title: item.title,
        sourceType: item.source_type,
        sourceRefId: item.source_ref_id,
        payload,
        result: { reason: 'No executable action registered' },
      });
      return {
        ok: true,
        item,
        result: { reason: 'No executable action registered' },
      };
    }

    throw new Error(`Unsupported agent inbox action: ${input.action}`);
  } catch (err) {
    createAssistantActionLog({
      itemId: item.id,
      action: input.action,
      status: 'error',
      title: item.title,
      sourceType: item.source_type,
      sourceRefId: item.source_ref_id,
      payload,
      result: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
