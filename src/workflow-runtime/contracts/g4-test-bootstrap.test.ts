import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertG4ProfileRejectedForProduction,
  checkG4TestBootstrapContracts,
  G4_FAKE_ADAPTER_INVOCATION_SCHEMA,
  G4_FAKE_ADAPTER_RESULT_SCHEMA,
  G4_ISOLATION_RECEIPT_SCHEMA,
  G4_TEST_BOOTSTRAP_PROFILE_SCHEMA,
  g4ContractCountsForTest,
  validateG4TestBootstrapProfile,
} from './g4-test-bootstrap-contract.js';
import {
  g4FakeAdapterBehaviors,
  g4FaultCases,
  g4NegativeCases,
  g4PositiveCases,
  g4VirtualClockProfile,
} from './g4-test-bootstrap-fixtures.js';
import { G4_FAKE_ADAPTER_OUTCOMES } from './g4-test-bootstrap-types.js';
import { canonicalJson } from './hash.js';
import type { JsonObject } from './types.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

describe('G4 Test Bootstrap Contract Pack', () => {
  it('checks the closed pack, exact upstream bindings, and case counts', () => {
    const first = checkG4TestBootstrapContracts();
    const second = checkG4TestBootstrapContracts();
    expect(canonicalJson(second.pack)).toBe(canonicalJson(first.pack));
    expect(first.pack.payload).toMatchObject({
      gate: 'G4',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_G4_REGRESSION',
      positive_case_count: 7,
      negative_case_count: 21,
      fault_case_count: 13,
      fake_adapter_outcome_count: 7,
      database_schema_version: 4,
      database_schema_hash:
        'sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a',
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
      explicit_selection_required: true,
      production_build_acceptance: 'reject',
      production_startup_acceptance: 'reject',
      production_loader_implemented: false,
      runtime_business_tables_written: false,
      g5_through_g9_status: 'NOT_READY',
    });
    expect(g4ContractCountsForTest()).toEqual({
      positive: 7,
      negative: 21,
      fault: 13,
    });
    expect(g4PositiveCases()).toHaveLength(7);
    expect(g4NegativeCases()).toHaveLength(21);
    expect(g4FaultCases()).toHaveLength(13);

    expect(first.profile.payload).toMatchObject({
      gate: 'G4',
      profile_kind: 'test_only',
      selection: 'explicit_exact_ref_and_hash',
      default_enabled: false,
      certification_status: 'not_certified',
      production_acceptance: 'reject',
      managed_toolchain: {
        node_runtime_version: '26.5.0',
        npm_version: '11.17.0',
      },
      store_binding: {
        connection_factory: 'WorkflowRuntimeConnectionFactory',
        identity_mode: 'candidate_development',
        database_name: 'workflow-runtime.db',
        database_schema_version: 4,
        g1_root_hash:
          'sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591',
        migration_hash:
          'sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43',
        schema3_to_4_upgrade_hash:
          'sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf',
      },
      upstream_contracts: {
        g2_sealed_bundle_hash:
          'sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145',
        g3_6_pack_hash:
          'sha256:730daac9db4bcfb645374b12e10e3962ddacbebc2828875cb00133c8ada195a8',
        g3_7_pack_hash:
          'sha256:2fae2da648d6da5969e6c5c57b2342f6f15b3084b39e7acfc43b010b48517e74',
        g3_8a_pack_hash:
          'sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f',
        g3_9_pack_hash:
          'sha256:2ef0997982483a6da4c6c6cfd3e26b7934f7fcffce4fdae160f94f4e9d600b38',
      },
    });
  });

  it('publishes strict schemas and exactly seven replayable behaviors', () => {
    for (const schema of [
      G4_TEST_BOOTSTRAP_PROFILE_SCHEMA,
      G4_FAKE_ADAPTER_INVOCATION_SCHEMA,
      G4_FAKE_ADAPTER_RESULT_SCHEMA,
      G4_ISOLATION_RECEIPT_SCHEMA,
    ]) {
      expect(schema.additionalProperties).toBe(false);
    }
    expect(G4_TEST_BOOTSTRAP_PROFILE_SCHEMA.properties).toMatchObject({
      managed_toolchain: { additionalProperties: false },
      store_binding: { additionalProperties: false },
      upstream_contracts: { additionalProperties: false },
      fixture_set: { additionalProperties: false },
      fake_adapter: { additionalProperties: false },
      virtual_clock: { additionalProperties: false },
      root_policy: { additionalProperties: false },
      isolation_boundary: { additionalProperties: false },
    });
    const behaviors = g4FakeAdapterBehaviors();
    expect(behaviors.map((entry) => entry.response.outcome)).toEqual([
      ...G4_FAKE_ADAPTER_OUTCOMES,
    ]);
    expect(
      new Set(behaviors.map((entry) => entry.invocation.invocation_hash)).size,
    ).toBe(7);
    expect(g4VirtualClockProfile()).toEqual({
      format: 'icarus.workflow-test-virtual-clock-profile/1',
      ref: {
        id: 'icarus.workflow-test-virtual-clock-profile',
        version: '1.0.0',
      },
      seed: 'g4-virtual-clock-seed-0001',
      initial_time_ms: 1_784_764_800_000,
      tick_quantum_ms: 1,
      authority: 'virtual_only',
      implicit_date_now_allowed: false,
      wall_clock_fallback_allowed: false,
      real_sleep_allowed: false,
      rollback_allowed: false,
    });
  });

  it('rejects profile/hash drift and every production consumption surface', () => {
    const profile = checkG4TestBootstrapContracts().profile.payload;
    expect(() => validateG4TestBootstrapProfile(profile)).not.toThrow();

    const drifted = structuredClone(profile) as JsonObject;
    drifted.default_enabled = true;
    expect(() => validateG4TestBootstrapProfile(drifted)).toThrow();

    const hashDrifted = structuredClone(profile);
    hashDrifted.bootstrap_implementation_hash =
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => validateG4TestBootstrapProfile(hashDrifted)).toThrow(
      /identity mismatch/,
    );

    for (const surface of ['build', 'startup', 'loader'] as const) {
      expect(() =>
        assertG4ProfileRejectedForProduction(surface, profile),
      ).toThrow(
        `test_bootstrap_profile_forbidden: production ${surface} rejects`,
      );
    }
  });

  it('proves Production and Feature/API/Automation ingress are absent', () => {
    const isolation = checkG4TestBootstrapContracts().isolationBoundary.payload;
    expect(isolation).toMatchObject({
      forbidden_import_hits: [],
      feature_ingress_import_count: 0,
      api_ingress_import_count: 0,
      automation_ingress_import_count: 0,
      production_loader_present: false,
      production_startup_present: false,
      production_fail_closed_evidence:
        'closed_negative_contract_and_static_surface_absence',
      active_registry_or_release_pointer_access: 'forbidden',
      real_adapter_access: 'forbidden',
      network_access: 'forbidden',
      user_data_access: 'forbidden',
    });
    for (const relativePath of isolation.absent_production_paths as string[]) {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(false);
    }
  });
});
