import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  referenceHierarchicalClose,
  referenceMapDecision,
  type ReferenceMapSlot,
} from './g6-dynamic-close-reference-model.js';
import { canonicalJson } from './hash.js';

describe('G6 Dynamic / Close independent reference model', () => {
  it('selects quorum winners by completion sequence and then item index', () => {
    expect(
      referenceMapDecision(
        [
          {
            itemIndex: 0,
            outcome: 'completed',
            completionSeq: 8,
            exitName: 'accepted',
          },
          {
            itemIndex: 1,
            outcome: 'completed',
            completionSeq: 3,
            exitName: 'accepted',
          },
          {
            itemIndex: 2,
            outcome: 'completed',
            completionSeq: 3,
            exitName: 'accepted',
          },
          {
            itemIndex: 3,
            outcome: 'completed',
            completionSeq: 2,
            exitName: 'rejected',
          },
        ],
        { type: 'quorum', count: 2, acceptedExits: ['accepted'] },
      ),
    ).toMatchObject({
      terminal: true,
      succeeded: true,
      selectedIndices: [1, 2],
      loserIndices: [0, 3],
      code: null,
    });
  });

  it('is independent of caller slot order for arbitrary terminal maps', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            outcome: fc.constantFrom(
              'completed' as const,
              'errored' as const,
              'cancelled' as const,
              'fenced' as const,
            ),
            completionSeq: fc.integer({ min: 0, max: 20 }),
            exitName: fc.constantFrom('accepted', 'rejected'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 1, max: 6 }),
        (generated, requestedCount) => {
          const slots: ReferenceMapSlot[] = generated.map(
            (slot, itemIndex) => ({
              itemIndex,
              outcome: slot.outcome,
              completionSeq: slot.completionSeq,
              exitName: slot.outcome === 'completed' ? slot.exitName : null,
            }),
          );
          const count = Math.min(requestedCount, slots.length);
          const policy = {
            type: 'quorum' as const,
            count,
            acceptedExits: ['accepted'],
          };
          expect(canonicalJson(referenceMapDecision(slots, policy))).toBe(
            canonicalJson(referenceMapDecision([...slots].reverse(), policy)),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('preserves an earlier child close when an ancestor closes', () => {
    expect(
      referenceHierarchicalClose(
        [
          {
            scopeId: 'root',
            parentScopeId: null,
            lifecycle: 'open',
            existingReason: null,
          },
          {
            scopeId: 'child:a',
            parentScopeId: 'root',
            lifecycle: 'closed',
            existingReason: 'normal',
          },
          {
            scopeId: 'child:b',
            parentScopeId: 'root',
            lifecycle: 'open',
            existingReason: null,
          },
          {
            scopeId: 'grandchild',
            parentScopeId: 'child:b',
            lifecycle: 'open',
            existingReason: null,
          },
        ],
        'root',
        'engine_error',
      ),
    ).toMatchObject({
      requests: {
        root: 'engine_error',
        'child:a': 'normal',
        'child:b': 'parent_close',
        grandchild: 'parent_close',
      },
      fenced_scope_ids: ['root', 'child:b', 'grandchild'],
      fence_hash: expect.stringMatching(/^sha256:/),
    });
  });

  it('fails closed on invalid slot order and invalid quorum', () => {
    expect(() =>
      referenceMapDecision(
        [
          {
            itemIndex: 1,
            outcome: 'completed',
            completionSeq: 1,
            exitName: 'accepted',
          },
        ],
        { type: 'all_settled' },
      ),
    ).toThrow(/invalid_map_slot_order/);
    expect(() =>
      referenceMapDecision([], {
        type: 'quorum',
        count: 0,
        acceptedExits: ['accepted'],
      }),
    ).toThrow(/invalid_quorum/);
    expect(() =>
      referenceHierarchicalClose(
        [
          {
            scopeId: 'root',
            parentScopeId: null,
            lifecycle: 'open',
            existingReason: null,
          },
          {
            scopeId: 'closed-child',
            parentScopeId: 'root',
            lifecycle: 'closed',
            existingReason: null,
          },
        ],
        'root',
        'engine_error',
      ),
    ).toThrow(/closed_scope_missing_close_authority/);
  });
});
