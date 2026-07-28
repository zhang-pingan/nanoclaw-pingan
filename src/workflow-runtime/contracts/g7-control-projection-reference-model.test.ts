import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyG7ModelCommand,
  consumeG7ModelProjectionEvent,
  g7ModelOperationalState,
  g7ModelProjectionEvent,
  resolveG7ModelBlocker,
  type G7ModelCommandRequest,
  type G7ModelProjectionHead,
} from './g7-control-projection-reference-model.js';
import type { JsonObject, JsonValue } from './types.js';

const safeJsonScalar = fc.oneof(
  fc.string(),
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
  fc.boolean(),
  fc.constant(null),
);

function request(payload: JsonObject = {}): G7ModelCommandRequest {
  return {
    command_id: 'command:g7:model',
    idempotency_domain: 'human:local-owner',
    idempotency_key: 'model-key',
    target_version: 3,
    expected_version: 3,
    authorized: true,
    target_open: true,
    payload,
  };
}

describe('G7 independent control/projection reference model', () => {
  it('models exact duplicate and drift conflict without a second target mutation', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), safeJsonScalar), (payload) => {
        const jsonPayload = payload as unknown as JsonObject;
        const first = applyG7ModelCommand(null, request(jsonPayload));
        const duplicate = applyG7ModelCommand(first, request(jsonPayload));
        const conflict = applyG7ModelCommand(duplicate, {
          ...request(jsonPayload),
          payload: { ...jsonPayload, drift: true },
        });
        expect(first.canonicalResult).toBe('applied');
        expect(duplicate).toMatchObject({
          canonicalResult: 'duplicate',
          targetVersion: 4,
          invocationCount: 2,
        });
        expect(conflict).toMatchObject({
          canonicalResult: 'conflict',
          targetVersion: 4,
          invocationCount: 3,
        });
      }),
      { numRuns: 100 },
    );
  });

  it('restores healthy only after the last blocker and preserves quarantine priority', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), {
          minLength: 2,
          maxLength: 12,
        }),
        fc.integer({ min: 0, max: 11 }),
        (ids, quarantineIndex) => {
          const selected = quarantineIndex % ids.length;
          let blockers = ids.map((id, index) => ({
            id,
            severity:
              index === selected
                ? ('quarantine' as const)
                : ('action_required' as const),
            open: true,
          }));
          expect(g7ModelOperationalState(blockers)).toBe('quarantined');
          for (const id of ids.filter((_, index) => index !== selected))
            blockers = [...resolveG7ModelBlocker(blockers, id)];
          expect(g7ModelOperationalState(blockers)).toBe('quarantined');
          blockers = [...resolveG7ModelBlocker(blockers, ids[selected]!)];
          expect(g7ModelOperationalState(blockers)).toBe('healthy');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts only an adjacent projection hash chain', () => {
    fc.assert(
      fc.property(
        fc.array(safeJsonScalar, { minLength: 1, maxLength: 30 }),
        (values) => {
          let head: G7ModelProjectionHead = {
            sequence: 0,
            hash: null,
            state: 'ready' as const,
          };
          for (const [index, value] of values.entries()) {
            const event = g7ModelProjectionEvent(index + 1, head.hash, {
              value: value as unknown as JsonValue,
            });
            head = consumeG7ModelProjectionEvent(head, event);
            expect(head.state).toBe('ready');
          }
          const gap = g7ModelProjectionEvent(head.sequence + 2, head.hash, {});
          expect(consumeG7ModelProjectionEvent(head, gap).state).toBe(
            'degraded',
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
