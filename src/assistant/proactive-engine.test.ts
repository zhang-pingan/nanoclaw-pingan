import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from '../db.js';
import {
  initAssistantEvents,
  type AssistantRealtimeEvent,
} from './assistant-events.js';
import { updateAssistantSettings } from './agent-inbox-store.js';
import {
  _resetProactiveEngineForTests,
  getProactiveScheduleState,
  rescheduleProactiveEngine,
  runProactiveScan,
  startProactiveEngine,
} from './proactive-engine.js';

let events: AssistantRealtimeEvent[] = [];

beforeEach(() => {
  _initTestDatabase();
  events = [];
  initAssistantEvents((event) => {
    events.push(event);
  });
});

afterEach(() => {
  _resetProactiveEngineForTests();
  vi.useRealTimers();
});

function scanCompletedCount(): number {
  return events.filter((event) => event.type === 'scan_completed').length;
}

describe('proactive engine scheduler', () => {
  it('reschedules the next scan when settings change at runtime', async () => {
    vi.useFakeTimers();
    updateAssistantSettings({ scanIntervalMinutes: 120 });

    startProactiveEngine();
    expect(scanCompletedCount()).toBe(1);

    updateAssistantSettings({ scanIntervalMinutes: 1 });
    rescheduleProactiveEngine();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(scanCompletedCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scanCompletedCount()).toBe(2);
  });

  it('exposes last and next proactive scan times', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T09:00:00.000Z'));
    updateAssistantSettings({ scanIntervalMinutes: 15 });

    startProactiveEngine();
    expect(getProactiveScheduleState()).toMatchObject({
      loopStarted: true,
      intervalMinutes: 15,
      lastScanStartedAt: String(Date.parse('2026-05-11T09:00:00.000Z')),
      lastScanFinishedAt: String(Date.parse('2026-05-11T09:00:00.000Z')),
      lastScanCreatedOrUpdated: expect.any(Number),
      lastScanOk: true,
      lastScanError: null,
      nextScanAt: String(Date.parse('2026-05-11T09:15:00.000Z')),
    });

    vi.setSystemTime(new Date('2026-05-11T09:05:00.000Z'));
    const result = runProactiveScan();

    expect(result.scannedAt).toBe(
      String(Date.parse('2026-05-11T09:05:00.000Z')),
    );
    expect(getProactiveScheduleState()).toMatchObject({
      loopStarted: true,
      lastScanStartedAt: String(Date.parse('2026-05-11T09:05:00.000Z')),
      lastScanFinishedAt: String(Date.parse('2026-05-11T09:05:00.000Z')),
      nextScanAt: String(Date.parse('2026-05-11T09:15:00.000Z')),
    });
  });
});
