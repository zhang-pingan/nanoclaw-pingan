import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  calculateG5RepairFixtureBindingHash,
  checkG5BasicRuntimeRepairContracts,
  G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS,
  type G5RepairFixtureCase,
} from './g5-basic-runtime-repair-contract.js';
import {
  G5FixtureExecutionHarness,
  type G5FixtureArtifacts,
  type G5FixtureHandler,
} from './g5-basic-runtime-fixture-harness.js';
import { G5_REPAIR_EXIT_STATUS } from './g5-basic-runtime-repair-types.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function fixtureArtifacts(): G5FixtureArtifacts {
  const readCases = (name: string) => {
    const artifact = JSON.parse(
      fs.readFileSync(
        path.join(
          repoRoot,
          'src/workflow-runtime/contracts/conformance/g5-basic-runtime-repair',
          name,
        ),
        'utf8',
      ),
    ) as { payload: { cases: G5RepairFixtureCase[] } };
    return artifact.payload.cases;
  };
  return {
    positive: readCases('positive-cases.json'),
    negative: readCases('negative-cases.json'),
    fault: readCases('fault-cases.json'),
  };
}

function mutateFixture(
  artifacts: G5FixtureArtifacts,
  category: keyof G5FixtureArtifacts,
  caseId: string,
  mutate: (fixture: G5RepairFixtureCase) => void,
  refreshBinding = false,
): G5FixtureArtifacts {
  const copy = structuredClone(artifacts) as {
    positive: G5RepairFixtureCase[];
    negative: G5RepairFixtureCase[];
    fault: G5RepairFixtureCase[];
  };
  const fixture = copy[category].find((entry) => entry.case_id === caseId);
  if (!fixture) throw new Error(`missing mutation fixture ${caseId}`);
  mutate(fixture);
  if (refreshBinding) {
    const { binding_hash: _bindingHash, ...withoutBinding } = fixture;
    void _bindingHash;
    Object.assign(fixture, {
      binding_hash: calculateG5RepairFixtureBindingHash(withoutBinding),
    });
  }
  return copy;
}

const inertHandlers: readonly G5FixtureHandler[] = [
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

describe('current G5 Basic Runtime repair Contract Pack', () => {
  it('binds only the current repair authority and remains a non-DONE candidate', () => {
    const pack = checkG5BasicRuntimeRepairContracts();
    expect(pack.payload).toMatchObject({
      status: G5_REPAIR_EXIT_STATUS,
      g5_done: false,
      g6_through_g9: 'NOT_READY',
      historical_g5_candidate_authority: 'forbidden',
      positive_case_count: 21,
      negative_case_count: 28,
      fault_case_count: 17,
    });
    expect(JSON.stringify(pack)).not.toContain(
      'contract-pack-g5-basic-runtime.json',
    );
    expect(JSON.stringify(pack)).not.toContain('conformance/g5-basic-runtime/');
  });

  it('binds production sources and preserves forbidden ownership boundaries', () => {
    expect(G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS).toHaveLength(18);
    for (const relativePath of G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toMatch(
        /workflow-runtime\/bootstrap|g4-test-bootstrap/,
      );
      expect(source).not.toMatch(
        /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+["`']?(?:workflow_runtime_commands|workflow_runtime_command_invocations|workflow_graph_completion_cuts|workflow_relations)\b/i,
      );
      expect(source).not.toMatch(/\bworkflow_deadline\b|\bT6e\b/);
      expect(source).not.toMatch(
        /https?:\/\/|registry.*latest|network.*fallback/i,
      );
    }
  });

  it('fails closed on fixture oracle, operation, and fault drift', () => {
    const artifacts = fixtureArtifacts();
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'positive',
            'intake_routing_domain_claim',
            (fixture) => {
              Object.assign(fixture.oracle, { disposition: 'replayed' });
            },
          ),
          inertHandlers,
        ),
    ).toThrow(/binding hash drifted/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'positive',
            'intake_routing_domain_claim',
            (fixture) => {
              Object.assign(fixture.oracle, { disposition: 'replayed' });
            },
            true,
          ),
          inertHandlers,
        ),
    ).toThrow(/fixture bytes are not current/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'positive',
            'activation_state_lowering',
            (fixture) => {
              const payload = fixture.operation.input.payload as {
                behavior: string;
              };
              payload.behavior = 'stale_activation_row';
            },
            true,
          ),
          inertHandlers,
        ),
    ).toThrow(/fixture bytes are not current/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'positive',
            'activation_state_lowering',
            (fixture) => {
              fixture.operation.input.now_ms =
                Number(fixture.operation.input.now_ms) + 1;
            },
          ),
          inertHandlers,
        ),
    ).toThrow(/binding hash drifted/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'fault',
            'fault_before_commit_t4',
            (fixture) => {
              fixture.operation.fault!.point = 'after_commit';
            },
            true,
          ),
          inertHandlers,
        ),
    ).toThrow(/fixture bytes are not current/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'fault',
            'fault_before_commit_t4',
            (fixture) => {
              fixture.operation.fault!.point = 'after_commit';
            },
          ),
          inertHandlers,
        ),
    ).toThrow(/binding hash drifted/);
  });

  it('fails closed on category, surface, handler, and inventory drift', () => {
    const artifacts = fixtureArtifacts();
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'negative',
            'creation_intent_conflict',
            (fixture) => {
              Object.assign(fixture, { category: 'positive' });
            },
            true,
          ),
          inertHandlers,
        ),
    ).toThrow(/category does not match/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'positive',
            'intake_routing_domain_claim',
            (fixture) => {
              Object.assign(fixture, { surface: 'CAP0_CAP4' });
              Object.assign(fixture.operation, {
                transaction: 'CAP0_CAP4',
              });
              fixture.operation.input.expected_surface = 'CAP0_CAP4';
            },
            true,
          ),
          inertHandlers,
        ),
    ).toThrow(/operation .* invalid|handler binding is invalid/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          mutateFixture(
            artifacts,
            'positive',
            'capacity_admin_recovery',
            (fixture) => {
              Object.assign(fixture, {
                handler: 'create_workflow_t0_production',
              });
            },
            true,
          ),
          inertHandlers,
        ),
    ).toThrow(/handler binding is invalid/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          {
            ...artifacts,
            positive: artifacts.positive.slice(1),
          },
          inertHandlers,
        ),
    ).toThrow(/missing or unknown/);
    expect(
      () =>
        new G5FixtureExecutionHarness(
          {
            ...artifacts,
            positive: [...artifacts.positive, artifacts.positive[0]!],
          },
          inertHandlers,
        ),
    ).toThrow(/duplicate G5 fixture id/);
  });

  it('fails closed on unknown, unhandled, and multiply handled bindings', () => {
    const artifacts = fixtureArtifacts();
    const noHandlers = new G5FixtureExecutionHarness(artifacts, []);
    expect(() => noHandlers.execute(noHandlers.fixtures[0]!)).toThrow(
      /0 execution handlers/,
    );
    expect(() => noHandlers.assertComplete()).toThrow(/unhandled G5 fixtures/);
    const duplicateHandlers = new G5FixtureExecutionHarness(artifacts, [
      inertHandlers[0]!,
      inertHandlers[0]!,
    ]);
    const runtimeFixture = duplicateHandlers.fixtures.find(
      (fixture) => fixture.handler === inertHandlers[0]!.id,
    )!;
    expect(() => duplicateHandlers.execute(runtimeFixture)).toThrow(
      /2 execution handlers/,
    );
    const harness = new G5FixtureExecutionHarness(artifacts, inertHandlers);
    const fixture = harness.fixtures[0]!;
    harness.execute(fixture);
    expect(() => harness.execute(fixture)).toThrow(/handled more than once/);
    const fresh = new G5FixtureExecutionHarness(artifacts, inertHandlers);
    const drifted = structuredClone(fresh.fixtures[0]!);
    drifted.operation.input.now_ms = Number(drifted.operation.input.now_ms) + 1;
    expect(() => fresh.execute(drifted)).toThrow(
      /execution record is not checked in/,
    );
  });
});
