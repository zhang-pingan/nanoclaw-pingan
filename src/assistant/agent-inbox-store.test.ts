import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getTodayPlanByDate } from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import { runAgentInboxAction } from './assistant-actions.js';
import {
  createOrUpdateAgentInboxItem,
  getAssistantSettings,
  listAgentInboxItems,
  updateAssistantSettings,
} from './agent-inbox-store.js';
import { runProactiveScan } from './proactive-engine.js';

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
});

describe('agent inbox store', () => {
  it('merges assistant settings without dropping nested defaults', () => {
    const settings = updateAssistantSettings({
      enabled: false,
      dataSources: { workbench: false },
      desktopAssistant: { allowMovement: false },
    });

    expect(settings.enabled).toBe(false);
    expect(settings.dataSources.workbench).toBe(false);
    expect(settings.dataSources.todayPlan).toBe(true);
    expect(settings.desktopAssistant.allowMovement).toBe(false);
    expect(settings.desktopAssistant.alwaysOnTop).toBe(true);
    expect(getAssistantSettings().enabled).toBe(false);
  });

  it('upserts active inbox items by dedupe key', () => {
    const first = createOrUpdateAgentInboxItem({
      dedupeKey: 'test:item',
      kind: 'notification',
      title: 'Old title',
      sourceType: 'test',
      sourceRefId: '1',
    });
    const second = createOrUpdateAgentInboxItem({
      dedupeKey: 'test:item',
      kind: 'risk',
      priority: 'high',
      title: 'New title',
      sourceType: 'test',
      sourceRefId: '1',
      actionPayload: { next: true },
    });

    expect(second.id).toBe(first.id);
    expect(second.kind).toBe('risk');
    expect(second.priority).toBe('high');
    expect(second.title).toBe('New title');
    expect(second.action_payload).toEqual({ next: true });
    expect(listAgentInboxItems({ status: 'active' })).toHaveLength(1);
  });

  it('creates a today-plan inbox item and can execute it', () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const scan = runProactiveScan({ now });
    expect(scan.createdOrUpdated).toBeGreaterThanOrEqual(1);

    const item = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.action_kind === 'create_today_plan',
    );
    expect(item).toBeTruthy();

    const result = runAgentInboxAction({
      itemId: item!.id,
      action: 'execute',
    });

    expect(result.item.status).toBe('done');
    expect(result.result.planDate).toBe('2026-04-28');
    expect(getTodayPlanByDate('2026-04-28')).toBeTruthy();
  });
});
