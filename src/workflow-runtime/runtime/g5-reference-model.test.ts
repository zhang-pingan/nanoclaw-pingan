import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { G5BasicRuntimeReferenceModel } from '../contracts/g5-basic-runtime-reference-model.js';

describe('G5 independent Basic Runtime reference model', () => {
  it('covers static/delegation/system/wait/join/terminal and Fact/Event fixed point', () => {
    const model = new G5BasicRuntimeReferenceModel(
      [
        { id: 'static', kind: 'static' },
        { id: 'delegation', kind: 'delegation' },
        { id: 'system', kind: 'system' },
        { id: 'wait', kind: 'wait' },
        { id: 'join', kind: 'join' },
        { id: 'terminal', kind: 'terminal' },
      ],
      [
        { from: 'static', to: 'join', statuses: ['succeeded'] },
        { from: 'delegation', to: 'join', statuses: ['succeeded'] },
        { from: 'system', to: 'join', statuses: ['succeeded'] },
        { from: 'wait', to: 'join', statuses: ['succeeded'] },
        { from: 'join', to: 'terminal', statuses: ['succeeded'] },
      ],
    );
    model.complete('static', 'succeeded');
    model.activate('delegation');
    model.complete('delegation', 'succeeded');
    model.activate('system');
    model.complete('system', 'succeeded');
    expect(model.resolveWait('wait', 'provider-event-1')).toBe('accepted');
    expect(model.resolveWait('wait', 'provider-event-1')).toBe('duplicate');
    expect(model.resolveWait('wait', 'provider-event-2')).toBe('late');
    model.complete('join', 'succeeded');
    model.complete('terminal', 'succeeded');
    expect(
      [...model.nodes.values()].every((node) => node.phase === 'terminal'),
    ).toBe(true);
    expect(model.events).toHaveLength(model.facts.size);
    expect(model.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: model.events.length }, (_, index) => index + 1),
    );
  });

  it('models quality continuation, exhaustion, automatic retry, and blocker cache', () => {
    const model = new G5BasicRuntimeReferenceModel(
      [{ id: 'quality', kind: 'system' }],
      [],
    );
    model.activate('quality');
    expect(model.qualityDecision('quality', 'needs_revision', 2)).toBe(
      'retry_scheduled',
    );
    expect(model.consumeRetry('retry:quality:2')).toBe('consumed');
    expect(model.consumeRetry('retry:quality:2')).toBe('duplicate_timer');
    expect(model.qualityDecision('quality', 'needs_revision', 2)).toBe(
      'exhausted',
    );
    model.openBlocker('effect-unknown', 'action_required');
    expect(model.operationalState).toBe('action_required');
    model.openBlocker('integrity', 'quarantine');
    expect(model.operationalState).toBe('quarantined');
  });

  it('property-checks same-key idempotency and order-independent terminal state', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (ids, flags) => {
          const nodes = ids.map((id) => ({ id, kind: 'system' as const }));
          const first = new G5BasicRuntimeReferenceModel(nodes, []);
          const second = new G5BasicRuntimeReferenceModel(nodes, []);
          const outcomes = new Map(
            ids.map((id, index) => [
              id,
              flags[index % flags.length]
                ? ('succeeded' as const)
                : ('failed' as const),
            ]),
          );
          for (const id of ids) {
            first.activate(id);
            first.complete(id, outcomes.get(id)!);
            expect(first.complete(id, outcomes.get(id)!)).toBe('duplicate');
          }
          for (const id of [...ids].reverse()) {
            second.activate(id);
            second.complete(id, outcomes.get(id)!);
          }
          const terminalState = (model: G5BasicRuntimeReferenceModel) =>
            [...model.nodes.values()]
              .map(({ id, phase, terminalStatus }) => ({
                id,
                phase,
                terminalStatus,
              }))
              .sort((left, right) => left.id.localeCompare(right.id));
          expect(terminalState(first)).toEqual(terminalState(second));
          expect(first.events).toHaveLength(first.facts.size);
          expect(second.events).toHaveLength(second.facts.size);
        },
      ),
      { seed: 0x5a17, numRuns: 200 },
    );
  });
});
