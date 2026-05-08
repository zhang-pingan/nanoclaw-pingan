import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from '../db.js';
import {
  initAssistantEvents,
  type AssistantRealtimeEvent,
} from './assistant-events.js';
import { updateAssistantSettings } from './agent-inbox-store.js';
import {
  _resetProactiveEngineForTests,
  rescheduleProactiveEngine,
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
});
