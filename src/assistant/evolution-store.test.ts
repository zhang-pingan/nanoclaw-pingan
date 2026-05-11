import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import {
  createEvolutionItem,
  getActiveEvolutionItem,
  releaseEvolutionLease,
  renewEvolutionLease,
  transitionEvolutionItem,
  tryAcquireEvolutionLease,
} from './evolution-store.js';

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
});

describe('evolution store', () => {
  it('returns the oldest non-terminal active item', () => {
    const first = createEvolutionItem({ direction: 'first' });
    createEvolutionItem({ direction: 'second' });

    const active = getActiveEvolutionItem();

    expect(active?.id).toBe(first.id);
  });

  it('excludes terminal items from active query', () => {
    const first = createEvolutionItem({ direction: 'first' });
    const second = createEvolutionItem({ direction: 'second' });
    transitionEvolutionItem(first.id, 'completed');

    const active = getActiveEvolutionItem();

    expect(active?.id).toBe(second.id);
  });

  it('uses a global lease to prevent concurrent ticks', () => {
    createEvolutionItem({ direction: 'lease' });

    expect(
      tryAcquireEvolutionLease({ lockOwner: 'owner-a', leaseMs: 60_000 }),
    ).toBe(true);
    expect(
      tryAcquireEvolutionLease({ lockOwner: 'owner-b', leaseMs: 60_000 }),
    ).toBe(false);

    releaseEvolutionLease('owner-a');

    expect(
      tryAcquireEvolutionLease({ lockOwner: 'owner-b', leaseMs: 60_000 }),
    ).toBe(true);
  });

  it('renews an owned lease', () => {
    const item = createEvolutionItem({ direction: 'lease renewal' });

    expect(
      tryAcquireEvolutionLease({ lockOwner: 'owner-a', leaseMs: 60_000 }),
    ).toBe(true);
    expect(
      renewEvolutionLease({ lockOwner: 'owner-a', leaseMs: 120_000 }),
    ).toBe(true);
    expect(
      renewEvolutionLease({ lockOwner: 'owner-b', leaseMs: 120_000 }),
    ).toBe(false);

    expect(getActiveEvolutionItem()?.id).toBe(item.id);
  });
});
