import { domainSeparatedSha256 } from './hash.js';
import type { JsonObject, JsonValue } from './types.js';
import {
  G4_FAKE_ADAPTER_OUTCOMES,
  G4_TEST_BOOTSTRAP_FIXTURE_SET_REF,
  G4_VIRTUAL_CLOCK_PROFILE_REF,
  type G4FakeAdapterBehavior,
  type G4FakeAdapterInvocation,
  type G4FakeAdapterOutcome,
  type G4FakeAdapterResult,
  type G4FixtureSet,
  type G4VirtualClockProfile,
} from './g4-test-bootstrap-types.js';

export const G4_FAKE_ADAPTER_INVOCATION_DOMAIN =
  'icarus:workflow-test-fake-adapter-invocation:1\n';
export const G4_FAKE_ADAPTER_RESULT_DOMAIN =
  'icarus:workflow-test-fake-adapter-result:1\n';

function responsePayload(outcome: G4FakeAdapterOutcome): {
  receipt: JsonObject | null;
  result: JsonObject;
} {
  switch (outcome) {
    case 'not_applied':
      return {
        receipt: null,
        result: { state: 'not_applied', external_revision: null },
      };
    case 'applied_with_receipt':
      return {
        receipt: {
          receipt_id: 'receipt:g4:applied-with-receipt',
          before_hash:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          after_hash:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        result: { state: 'applied', external_revision: 'revision:g4:1' },
      };
    case 'applied_but_receipt_lost':
      return {
        receipt: null,
        result: {
          state: 'applied_but_receipt_lost',
          external_revision: 'revision:g4:lost',
        },
      };
    case 'still_running':
      return {
        receipt: null,
        result: { state: 'still_running', external_execution_id: 'exec:g4:1' },
      };
    case 'unknown':
      return {
        receipt: null,
        result: { state: 'unknown', external_execution_id: 'exec:g4:unknown' },
      };
    case 'cancelled':
      return {
        receipt: null,
        result: { state: 'cancelled', cancellation_code: 'fixture_cancelled' },
      };
    case 'compensated':
      return {
        receipt: {
          receipt_id: 'receipt:g4:compensated',
          compensation_operation_key: 'g4:operation:compensated',
        },
        result: { state: 'compensated', external_revision: 'revision:g4:undo' },
      };
  }
}

function behavior(
  outcome: G4FakeAdapterOutcome,
  index: number,
): G4FakeAdapterBehavior {
  const fixtureId = `fake-adapter.${outcome}`;
  const operationKey = `g4:operation:${outcome}`;
  const input: JsonValue = {
    fixture: fixtureId,
    payload: { sequence: index + 1, value: outcome },
  };
  const invocationWithoutHash = {
    format: 'icarus.workflow-test-fake-adapter-invocation/1' as const,
    fixture_id: fixtureId,
    operation_key: operationKey,
    attempt_no: 1,
    input,
  };
  const invocation: G4FakeAdapterInvocation = {
    ...invocationWithoutHash,
    invocation_hash: domainSeparatedSha256(
      G4_FAKE_ADAPTER_INVOCATION_DOMAIN,
      invocationWithoutHash,
    ),
  };
  const responseWithoutHash = {
    format: 'icarus.workflow-test-fake-adapter-result/1' as const,
    fixture_id: fixtureId,
    operation_key: operationKey,
    attempt_no: 1,
    outcome,
    ...responsePayload(outcome),
  };
  const response: G4FakeAdapterResult = {
    ...responseWithoutHash,
    replay_hash: domainSeparatedSha256(
      G4_FAKE_ADAPTER_RESULT_DOMAIN,
      responseWithoutHash,
    ),
  };
  return { behavior_id: fixtureId, invocation, response };
}

export function g4FakeAdapterBehaviors(): G4FakeAdapterBehavior[] {
  return G4_FAKE_ADAPTER_OUTCOMES.map((outcome, index) =>
    behavior(outcome, index),
  );
}

export function g4FixtureSet(): G4FixtureSet {
  return {
    format: 'icarus.workflow-test-bootstrap-fixture-set/1',
    ref: { ...G4_TEST_BOOTSTRAP_FIXTURE_SET_REF },
    selection: 'explicit_exact_ref_and_hash',
    fixture_ids: g4FakeAdapterBehaviors().map((entry) => entry.behavior_id),
    synthetic_registry_only: true,
    production_publishable: false,
  };
}

export function g4VirtualClockProfile(): G4VirtualClockProfile {
  return {
    format: 'icarus.workflow-test-virtual-clock-profile/1',
    ref: { ...G4_VIRTUAL_CLOCK_PROFILE_REF },
    seed: 'g4-virtual-clock-seed-0001',
    initial_time_ms: 1_784_764_800_000,
    tick_quantum_ms: 1,
    authority: 'virtual_only',
    implicit_date_now_allowed: false,
    wall_clock_fallback_allowed: false,
    real_sleep_allowed: false,
    rollback_allowed: false,
  };
}

export function g4PositiveCases(): JsonObject[] {
  return [
    { case_id: 'positive.explicit-profile-selection', expected: 'accepted' },
    { case_id: 'positive.fresh-schema4-bootstrap', expected: 'accepted' },
    { case_id: 'positive.reopen-same-instance', expected: 'accepted' },
    { case_id: 'positive.cross-instance-isolation', expected: 'accepted' },
    { case_id: 'positive.fake-adapter-closed-outcomes', expected: 'accepted' },
    {
      case_id: 'positive.virtual-clock-explicit-advance',
      expected: 'accepted',
    },
    { case_id: 'positive.production-surface-absence', expected: 'accepted' },
    {
      case_id: 'positive.downstream-source-without-g4-reachability',
      expected: 'accepted',
    },
    {
      case_id: 'positive.future-graph-runtime-path-without-g4-reachability',
      expected: 'accepted',
    },
  ];
}

export function g4NegativeCases(): JsonObject[] {
  return [
    ['profile-ref-drift', 'profile_identity_mismatch'],
    ['profile-hash-drift', 'profile_identity_mismatch'],
    ['fixture-ref-drift', 'fixture_identity_mismatch'],
    ['fixture-hash-drift', 'fixture_identity_mismatch'],
    ['g1-hash-drift', 'upstream_identity_mismatch'],
    ['g2-hash-drift', 'upstream_identity_mismatch'],
    ['g3-hash-drift', 'upstream_identity_mismatch'],
    ['certified-status', 'test_profile_certification_forbidden'],
    ['production-build', 'test_bootstrap_profile_forbidden'],
    ['production-startup', 'test_bootstrap_profile_forbidden'],
    ['bootstrap-source-drift', 'bootstrap_source_identity_mismatch'],
    ['bootstrap-undeclared-sibling', 'bootstrap_source_inventory_drift'],
    ['production-entrypoint-import', 'test_bootstrap_reachable'],
    ['feature-ingress-import', 'test_bootstrap_reachable'],
    ['api-ingress-import', 'test_bootstrap_reachable'],
    ['automation-ingress-import', 'test_bootstrap_reachable'],
    ['host-bootstrap-import', 'test_bootstrap_reachable'],
    ['g5-runtime-import', 'test_bootstrap_reachable'],
    ['package-start-reference', 'test_bootstrap_profile_forbidden'],
    ['package-default-reference', 'test_bootstrap_profile_forbidden'],
    ['unknown-fixture', 'fake_adapter_invocation_undeclared'],
    ['unknown-fake-outcome', 'fake_adapter_outcome_undeclared'],
    ['clock-seed-drift', 'virtual_clock_profile_mismatch'],
    ['clock-wall-fallback', 'virtual_clock_profile_mismatch'],
    ['root-relative-path', 'data_root_invalid'],
    ['root-path-escape', 'data_root_not_temporary'],
    ['root-symlink', 'data_root_symlink_or_alias'],
    ['root-preexisting-empty', 'data_root_preexisting'],
    ['root-preexisting-nonempty', 'data_root_preexisting_nonempty'],
    ['root-cross-instance-reuse', 'data_root_preexisting_nonempty'],
    ['production-root-collision', 'production_root_collision'],
  ].map(([case_id, expected_code]) => ({ case_id, expected_code }));
}

export function g4FaultCases(): JsonObject[] {
  return [
    ['profile-identity-drift', 'before_root_create'],
    ['fixture-fake-outcome-drift', 'before_adapter_return'],
    ['clock-drift', 'clock_observation'],
    ['clock-rollback', 'clock_advance'],
    ['root-create-failure', 'root_create'],
    ['root-permission-denied', 'root_create'],
    ['root-symlink-alias', 'root_validation'],
    ['root-preexisting-or-reused', 'root_validation'],
    ['store-open-failure', 'store_open'],
    ['schema-profile-rejection', 'store_identity'],
    ['interrupt-after-root-create', 'initialization'],
    ['interrupt-after-store-open', 'initialization'],
    ['cleanup-failure-identifiable-residual', 'cleanup'],
  ].map(([case_id, fault_boundary]) => ({ case_id, fault_boundary }));
}
