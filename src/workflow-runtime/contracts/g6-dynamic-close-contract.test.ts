import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  calculateG6FixtureBindingHash,
  checkG6DynamicCloseContracts,
  G6_IMPLEMENTATION_SOURCE_PATHS,
  type G6FixtureCase,
} from './g6-dynamic-close-contract.js';
import {
  G6_EXIT_STATUS,
  G6_PERSISTENT_MODE_POLICY,
} from './g6-dynamic-close-types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

function cases(name: string): G6FixtureCase[] {
  return (
    JSON.parse(
      fs.readFileSync(
        path.join(contractsRoot, 'conformance/g6-dynamic-close', name),
        'utf8',
      ),
    ) as { payload: { cases: G6FixtureCase[] } }
  ).payload.cases;
}

describe('current G6 Dynamic / Close Contract Pack', () => {
  it('binds a non-DONE construction candidate and exact current prerequisites', () => {
    const pack = checkG6DynamicCloseContracts();
    expect(pack.payload).toMatchObject({
      gate: 'G6',
      status: G6_EXIT_STATUS,
      g6_state: 'IN_PROGRESS',
      g6_done: false,
      g7_through_g9: 'NOT_READY',
      persistent_mode_policy: G6_PERSISTENT_MODE_POLICY,
      production_implementation_count: 9,
      positive_case_count: 21,
      negative_case_count: 26,
      fault_case_count: 12,
      member_count: 6,
    });
    const protocol = JSON.parse(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'conformance/g6-dynamic-close/g6-dynamic-close-protocol@1.json',
        ),
        'utf8',
      ),
    ) as { payload: { bindings: Array<{ name: string; hash: string }> } };
    expect(protocol.payload.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'r020_child_consumption_lineage',
          hash: 'sha256:8a24efc4bd98c02b92cc6d6ce70f13c879d7e537e1081e4d57d561a63ea85c5a',
        }),
        expect.objectContaining({
          name: 'r021_map_terminal_consumption',
          hash: 'sha256:b5e9237d09d829946c496e19eddf16b21c94fb4fd59b3588900f4764332d0699',
        }),
        expect.objectContaining({
          name: 'r022_domain_claim_handoff',
          hash: 'sha256:ea97a3d52a2e4a14fb2671b2191b1b1cb6acc22c4ecded7db2e141a1716b516e',
        }),
        expect.objectContaining({
          name: 'database_schema_11',
          hash: 'sha256:2adb9376d341ad430155829647086bcc76f84ebf22dffac28c19d4026ea06ab2',
        }),
      ]),
    );
  });

  it('binds every fixture to a closed handler, operation, and oracle', () => {
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
      expect(bindingHash).toBe(calculateG6FixtureBindingHash(withoutHash));
      expect(fixture.handler).toMatch(/^g6_[a-z0-9_]+_production$/);
      expect(fixture.operation).toMatchObject({
        database: 'isolated_real_file_sqlite',
        transaction_mode: 'BEGIN_IMMEDIATE',
        fake_adapter_only: true,
      });
      expect(fixture.oracle.duplicate_writes).toBe(0);
    }
  });

  it('detects fixture binding and generated-byte drift', () => {
    const fixture = structuredClone(cases('negative-cases.json')[0]!);
    fixture.oracle.exact_error = 'weakened_error';
    const { binding_hash: bindingHash, ...withoutHash } = fixture;
    expect(bindingHash).not.toBe(calculateG6FixtureBindingHash(withoutHash));
    expect(() => checkG6DynamicCloseContracts()).not.toThrow();
  });

  it('keeps G6 implementation sources outside every G7 and Production ingress boundary', () => {
    expect(G6_IMPLEMENTATION_SOURCE_PATHS).toHaveLength(9);
    for (const relativePath of G6_IMPLEMENTATION_SOURCE_PATHS) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toMatch(
        /workflow_runtime_commands|workflow_runtime_command_invocations|\bT7c\b|\bT6e\b|workflow_deadline|authorized_manual_retry/,
      );
      expect(source).not.toMatch(
        /https?:\/\/|production[_ -](?:loader|activation|ingress)|real[_ -]adapter/i,
      );
    }
  });
});
