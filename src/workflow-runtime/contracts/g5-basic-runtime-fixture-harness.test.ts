import { describe, expect, it } from 'vitest';

import {
  calculateG5RepairFixtureBindingHash,
  G5_REPAIR_FAULT_FIXTURES,
  G5_REPAIR_NEGATIVE_FIXTURES,
  G5_REPAIR_POSITIVE_FIXTURES,
  type G5RepairFixtureCase,
} from './g5-basic-runtime-repair-contract.js';
import {
  G5FixtureExecutionHarness,
  type G5FixtureArtifacts,
  type G5FixtureHandler,
} from './g5-basic-runtime-fixture-harness.js';

function artifacts(): G5FixtureArtifacts {
  return {
    positive: G5_REPAIR_POSITIVE_FIXTURES,
    negative: G5_REPAIR_NEGATIVE_FIXTURES,
    fault: G5_REPAIR_FAULT_FIXTURES,
  };
}

const handlers: readonly G5FixtureHandler[] = [
  'create_workflow_t0_production',
  'prepare_required_finalization_t0p_production',
  'activate_workflow_t1_production',
  'persist_compile_result_t2a_production',
  'materialize_root_scope_t2b_production',
  'initialize_fixed_point_t3a_production',
  'request_settled_close_t3b_production',
  'schedule_ready_node_t4_production',
  'prepare_capability_dispatch_t5_production',
  'accept_internal_result_t6a_production',
  'accept_delegation_callback_t6b_production',
  'resolve_wait_t6c_production',
  'fire_attempt_watchdog_t6d_production',
  'capacity_admin_cap0_cap4_production',
  'open_operational_blocker_production',
  'node_output_envelope_store_production',
].map((id) => ({
  id,
  execute: (fixture: G5RepairFixtureCase) => fixture.oracle,
}));

describe('G5 runtime fixture harness', () => {
  it('accepts the current fixture corpus and requires exactly one handler', () => {
    const harness = new G5FixtureExecutionHarness(artifacts(), handlers);
    for (const fixture of harness.fixtures) harness.execute(fixture);
    expect(() => harness.assertComplete()).not.toThrow();

    const missingHandlers = new G5FixtureExecutionHarness(artifacts(), []);
    expect(() => missingHandlers.execute(missingHandlers.fixtures[0]!)).toThrow(
      /0 execution handlers/,
    );
  });

  it('rejects fixture drift even when the binding hash is recomputed', () => {
    const changed = structuredClone(artifacts()) as {
      positive: G5RepairFixtureCase[];
      negative: G5RepairFixtureCase[];
      fault: G5RepairFixtureCase[];
    };
    const fixture = changed.positive[0]!;
    Object.assign(fixture.oracle, { disposition: 'replayed' });
    expect(() => new G5FixtureExecutionHarness(changed, handlers)).toThrow(
      /binding hash drifted/,
    );

    const { binding_hash: _bindingHash, ...withoutBinding } = fixture;
    void _bindingHash;
    Object.assign(fixture, {
      binding_hash: calculateG5RepairFixtureBindingHash(withoutBinding),
    });
    expect(() => new G5FixtureExecutionHarness(changed, handlers)).toThrow(
      /fixture bytes are not current/,
    );
  });

  it('rejects duplicate fixture IDs', () => {
    const current = artifacts();
    expect(
      () =>
        new G5FixtureExecutionHarness(
          {
            ...current,
            positive: [...current.positive, current.positive[0]!],
          },
          handlers,
        ),
    ).toThrow(/duplicate G5 fixture id/);
  });
});
