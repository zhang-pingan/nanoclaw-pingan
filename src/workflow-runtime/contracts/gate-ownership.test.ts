import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  checkGateOwnershipContracts,
  evaluateGateOwnershipAuditProbeForTest,
  evaluateGateOwnershipDependencyProbeForTest,
  evaluateGateOwnershipFixtureForTest,
  type GateOwnershipFixture,
  gateOwnershipFixturesForTest,
  generateGateOwnershipContracts,
} from './gate-ownership-contract.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function withRestoredFile(
  relativePath: string,
  mutate: (bytes: Buffer) => Buffer,
  probe: () => void,
) {
  const absolutePath = path.join(contractsRoot, relativePath);
  const original = fs.readFileSync(absolutePath);
  try {
    fs.writeFileSync(absolutePath, mutate(original));
    probe();
  } finally {
    fs.writeFileSync(absolutePath, original);
  }
}

describe('G5/G7 T6e gate ownership authority', () => {
  it('generates deterministically and keeps frozen G0/G1/G4 identities external', () => {
    const paths = [
      'governance/workflow-runtime-gate-ownership@1.json',
      'conformance/gate-ownership/positive-cases.json',
      'conformance/gate-ownership/negative-cases.json',
    ];
    const first = generateGateOwnershipContracts();
    const firstBytes = paths.map((relativePath) =>
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    );
    const second = generateGateOwnershipContracts();
    expect(second.hash).toBe(first.hash);
    expect(checkGateOwnershipContracts().hash).toBe(first.hash);
    expect(
      paths.map((relativePath) =>
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ),
    ).toEqual(firstBytes);
    expect(first.payload).toMatchObject({
      authority_kind: 'current_construction_gate_ownership',
      historical_g0_g1_identity_effect: 'none',
      g4_pack_identity_effect: 'none',
      implementation_authorized: false,
    });
  });

  it('owns exactly T0-T6d in G5 and T6e in G7', () => {
    const authority = readArtifact(
      'governance/workflow-runtime-gate-ownership@1.json',
    );
    const matrix = authority.payload.matrix as Array<{
      gate: string;
      owned_transaction_protocols: string[];
      owned_semantics: string[];
    }>;
    expect(matrix[0]).toMatchObject({
      gate: 'G5',
      owned_transaction_protocols: [
        'T0',
        'T0p',
        'T1',
        'T2a',
        'T2b',
        'T3a',
        'T3b',
        'T4',
        'T5',
        'T6a',
        'T6b',
        'T6c',
        'T6d',
      ],
    });
    expect(matrix[0].owned_semantics).toEqual([
      'operational_blocker_create',
      'open_blocker_set_authority',
      'run_operational_state_cache_on_blocker_create',
      'workflow_operational_state_cache_on_blocker_create',
      'open_blocker_cache_bidirectional_consistency',
    ]);
    expect(matrix[1]).toMatchObject({
      gate: 'G7',
      owned_transaction_protocols: ['T6e'],
    });
    expect(matrix[1].owned_semantics).toEqual(
      expect.arrayContaining([
        'runtime_command_gateway',
        'resolution_command_invocation_event_audit',
        'last_blocker_operational_state_restoration',
        'administrative_abandon',
        'recovery_and_integrity_restoration',
      ]),
    );
  });

  it('fails closed for every ownership and frozen-boundary fixture', () => {
    const generatedFixtures = gateOwnershipFixturesForTest();
    const artifactFixtures = {
      positive: readArtifact('conformance/gate-ownership/positive-cases.json')
        .payload.cases as unknown as GateOwnershipFixture[],
      negative: readArtifact('conformance/gate-ownership/negative-cases.json')
        .payload.cases as unknown as GateOwnershipFixture[],
    };
    expect(artifactFixtures).toEqual(generatedFixtures);
    expect(artifactFixtures.positive).toHaveLength(1);
    expect(artifactFixtures.negative).toHaveLength(18);
    for (const fixture of [
      ...artifactFixtures.positive,
      ...artifactFixtures.negative,
    ]) {
      expect(evaluateGateOwnershipFixtureForTest(fixture.mutation)).toBe(
        fixture.expected_code,
      );
    }
  });

  it('preserves T6e authorization/audit and Schema 4 resolution integrity', () => {
    const authority = readArtifact(
      'governance/workflow-runtime-gate-ownership@1.json',
    );
    expect(authority.payload.frozen_invariants).toEqual({
      t6e_authorization_precondition: 'authorized_runtime_command',
      t6e_atomic_resolution_audit: 'command_invocation_and_runtime_event',
      t6e_command_types: [
        'reconcile_effect',
        'submit_effect_receipt',
        'verify_effect_not_applied',
        'remediate_operational_blocker',
        'restore_integrity',
      ],
      resolution_command_fk:
        'workflow_operational_blockers.resolution_command_id -> workflow_runtime_commands.command_id',
      resolved_blocker_requires_resolution_command: true,
      blocker_cache_triggers: [
        'trg:operational_blockers:insert_cache',
        'trg:operational_blockers:update_cache',
      ],
    });
    expect(authority.payload.frozen_authority_bindings).toMatchObject({
      database_schema_version: 4,
      g1_executable_schema_root_hash:
        'sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591',
      workflow_runtime_schema_hash:
        'sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a',
    });
  });

  it('fails closed for independent matrix and excluded-semantics probes', () => {
    expect(
      evaluateGateOwnershipAuditProbeForTest('reorder_g5_transactions'),
    ).toBe('transaction_missing');
    expect(evaluateGateOwnershipAuditProbeForTest('remove_g5_gate')).toBe(
      'gate_missing_or_unknown',
    );
    expect(evaluateGateOwnershipAuditProbeForTest('add_extra_gate')).toBe(
      'gate_missing_or_unknown',
    );
    expect(
      evaluateGateOwnershipAuditProbeForTest('remove_g5_excluded_semantic'),
    ).toBe('semantic_missing');
    expect(
      evaluateGateOwnershipAuditProbeForTest('remove_g7_excluded_semantic'),
    ).toBe('semantic_missing');
  });

  it('fails closed for protocol source/generated divergence', () => {
    expect(
      evaluateGateOwnershipDependencyProbeForTest(
        'transaction_source_generated_divergence',
      ),
    ).toBe('t6e_protocol_drift');
    expect(
      evaluateGateOwnershipDependencyProbeForTest(
        'command_source_generated_divergence',
      ),
    ).toBe('t6e_command_mapping_drift');
  });

  it('fails closed for the Schema 4 FK, CHECK, and both cache triggers', () => {
    expect(
      evaluateGateOwnershipFixtureForTest('remove_schema_resolution_fk'),
    ).toBe('schema_resolution_fk_drift');
    expect(
      evaluateGateOwnershipAuditProbeForTest('remove_schema_resolution_check'),
    ).toBe('schema_resolution_shape_drift');
    expect(
      evaluateGateOwnershipAuditProbeForTest(
        'remove_schema_insert_cache_trigger',
      ),
    ).toBe('schema_cache_trigger_drift');
    expect(
      evaluateGateOwnershipAuditProbeForTest(
        'mutate_schema_update_cache_trigger',
      ),
    ).toBe('schema_cache_trigger_drift');
  });

  it('rejects real dependency and generated-fixture artifact drift', () => {
    withRestoredFile(
      'protocols/workflow-run-transaction-protocol-table.json',
      (bytes) => Buffer.from(bytes.toString('utf8').replace('"T6e"', '"T6x"')),
      () => expect(() => checkGateOwnershipContracts()).toThrow(),
    );
    withRestoredFile(
      'conformance/gate-ownership/negative-cases.json',
      (bytes) => Buffer.concat([bytes, Buffer.from('\n')]),
      () =>
        expect(() => checkGateOwnershipContracts()).toThrow(
          /not generated byte-for-byte/,
        ),
    );
    expect(() => checkGateOwnershipContracts()).not.toThrow();
  });

  it('is connected to both aggregate package contract chains', () => {
    const packageJson = strictParseJsonBytes(
      fs.readFileSync(path.resolve(contractsRoot, '../../../package.json')),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['contracts:generate']).toContain(
      'npm run contracts:gate-ownership:generate',
    );
    expect(packageJson.scripts['contracts:check']).toContain(
      'npm run contracts:gate-ownership:check',
    );
  });
});
