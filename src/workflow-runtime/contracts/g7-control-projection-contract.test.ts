import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  calculateG7FixtureBindingHash,
  checkG7ControlProjectionContracts,
  G7_IMPLEMENTATION_SOURCE_PATHS,
  type G7FixtureCase,
} from './g7-control-projection-contract.js';
import {
  G7_EXIT_STATUS,
  G7_PERSISTENT_MODE_POLICY,
} from './g7-control-projection-types.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

function cases(name: string): G7FixtureCase[] {
  return (
    JSON.parse(
      fs.readFileSync(
        path.join(contractsRoot, 'conformance/g7-control-projection', name),
        'utf8',
      ),
    ) as { payload: { cases: G7FixtureCase[] } }
  ).payload.cases;
}

describe('current G7 Control / Card / Projection / Recovery Contract Pack', () => {
  it('binds the accepted G6 base and remains pending independent G7 acceptance', () => {
    const pack = checkG7ControlProjectionContracts();
    expect(pack.payload).toMatchObject({
      gate: 'G7',
      status: G7_EXIT_STATUS,
      g6_state: 'DONE_OPERATIONALLY_ACCEPTED',
      g7_state: 'IN_PROGRESS',
      g7_done: false,
      g8_through_g9: 'NOT_READY',
      persistent_mode_policy: G7_PERSISTENT_MODE_POLICY,
      production_implementation_count: 11,
      positive_case_count: 29,
      negative_case_count: 33,
      fault_case_count: 16,
      member_count: 6,
    });
    const protocol = JSON.parse(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'conformance/g7-control-projection/g7-control-card-projection-recovery-protocol@1.json',
        ),
        'utf8',
      ),
    ) as {
      payload: {
        bindings: Array<{ name: string; hash: string }>;
        authority_residuals: JsonObject[];
      };
    };
    expect(protocol.payload.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'g6_dynamic_close_accepted_candidate',
          hash: 'sha256:f5fc01bc2adeeb68a4bab1329184f0a0bb079fa0596f32e19eaf55ba7ea11dc7',
        }),
        expect.objectContaining({
          name: 'workflow_runtime_command_protocol',
          hash: 'sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba',
        }),
        expect.objectContaining({
          name: 'workflow_run_transaction_protocol',
          hash: 'sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79',
        }),
        expect.objectContaining({
          name: 'database_schema_11',
          hash: 'sha256:2adb9376d341ad430155829647086bcc76f84ebf22dffac28c19d4026ea06ab2',
        }),
      ]),
    );
    expect(protocol.payload.authority_residuals).toEqual([]);
    expect(protocol.payload).toMatchObject({
      schema_change_required: true,
      authenticated_ingress_audit: {
        relation: 'workflow_runtime_command_ingress_invocations',
        append_per_authenticated_call: true,
        pre_resolution: true,
        claimed_target: 'closed_exactly_one_typed_non_fk_union',
        unresolved_terminal_denials: [
          'target_not_found',
          'target_kind_invalid',
        ],
        unresolved_resolved_identity: 'forbidden',
      },
    });
  });

  it('binds every fixture to a closed production surface, operation, and oracle', () => {
    const all = [
      ...cases('positive-cases.json'),
      ...cases('negative-cases.json'),
      ...cases('fault-cases.json'),
    ];
    expect(new Set(all.map((fixture) => fixture.case_id)).size).toBe(
      all.length,
    );
    for (const fixture of all) {
      const { binding_hash: bindingHash, ...withoutHash } = fixture;
      expect(bindingHash).toBe(calculateG7FixtureBindingHash(withoutHash));
      expect(fixture.handler).toMatch(/^g7_[a-z0-9_]+_production$/);
      expect(fixture.operation).toMatchObject({
        runtime_database: 'isolated_real_file_sqlite',
        projection_database: 'isolated_generation_store',
        transaction_mode: 'BEGIN_IMMEDIATE',
        fake_adapter_only: true,
      });
      expect(fixture.oracle.duplicate_authoritative_writes).toBe(0);
      expect(fixture.oracle.projection_can_write_runtime).toBe(false);
    }
  });

  it('detects fixture binding drift while generated current bytes remain exact', () => {
    const fixture = structuredClone(cases('negative-cases.json')[0]!);
    fixture.oracle.exact_error = 'weakened_error';
    const { binding_hash: bindingHash, ...withoutHash } = fixture;
    expect(bindingHash).not.toBe(calculateG7FixtureBindingHash(withoutHash));
    expect(() => checkG7ControlProjectionContracts()).not.toThrow();
  });

  it('keeps the G7 implementation boundary free of G8/G9 activation surfaces', () => {
    expect(G7_IMPLEMENTATION_SOURCE_PATHS).toHaveLength(11);
    for (const relativePath of G7_IMPLEMENTATION_SOURCE_PATHS) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toMatch(
        /production[_ -](?:loader|activation|ingress)|certified[_ -]profile|startup[_ -]smoke|real[_ -]adapter|https?:\/\//i,
      );
    }
  });
});
