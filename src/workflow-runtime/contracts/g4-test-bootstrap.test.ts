import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertG4ProfileRejectedForProduction,
  buildG4BootstrapImplementationPayload,
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
import {
  analyzeG4TestBootstrapIsolation,
  G4_BOOTSTRAP_SOURCE_PATHS,
  g4IsolationBoundaryPayload,
} from './g4-test-bootstrap-isolation.js';
import { G4_FAKE_ADAPTER_OUTCOMES } from './g4-test-bootstrap-types.js';
import { canonicalJson } from './hash.js';
import type { JsonObject } from './types.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function writeFixtureFile(root: string, relativePath: string, source: string) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
}

function createIsolationFixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g4-isolation-'));
  writeFixtureFile(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'g4-isolation-fixture',
        type: 'module',
        main: 'dist/index.js',
        scripts: { start: 'node dist/index.js', test: 'vitest run' },
      },
      null,
      2,
    )}\n`,
  );
  for (const sourcePath of G4_BOOTSTRAP_SOURCE_PATHS) {
    writeFixtureFile(
      root,
      sourcePath,
      `export const fixture = '${sourcePath}';\n`,
    );
  }
  writeFixtureFile(root, 'src/index.ts', "import './service.js';\n");
  writeFixtureFile(root, 'src/service.ts', 'export const service = true;\n');
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function bootstrapImport(from: string): string {
  const target = 'src/workflow-runtime/bootstrap/index.ts';
  let relative = path.posix.relative(path.posix.dirname(from), target);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative.replace(/\.ts$/, '.js');
}

describe('G4 Test Bootstrap Contract Pack', () => {
  it('checks the closed pack, exact upstream bindings, and case counts', () => {
    const first = checkG4TestBootstrapContracts();
    const second = checkG4TestBootstrapContracts();
    expect(canonicalJson(second.pack)).toBe(canonicalJson(first.pack));
    expect(first.pack.payload).toMatchObject({
      gate: 'G4',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_G4_REGRESSION',
      positive_case_count: 9,
      negative_case_count: 32,
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
      production_loader_g4_consumption: 'rejected',
      production_startup_g4_consumption: 'rejected',
      runtime_business_tables_written: false,
      g5_status: 'NOT_READY_BLOCKED_BY_G4_REGRESSION',
      g6_through_g9_status: 'NOT_READY',
    });
    expect(g4ContractCountsForTest()).toEqual({
      positive: 9,
      negative: 32,
      fault: 13,
    });
    expect(g4PositiveCases()).toHaveLength(9);
    expect(g4NegativeCases()).toHaveLength(32);
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

  it('proves Production and Feature/API/Automation ingress cannot reach G4 authority', () => {
    const isolation = checkG4TestBootstrapContracts().isolationBoundary.payload;
    expect(isolation).toMatchObject({
      format: 'icarus.workflow-test-bootstrap-isolation-boundary/2',
      policy: 'downstream_safe_test_only_bootstrap_isolation',
      source_ownership: {
        root: 'src/workflow-runtime/bootstrap',
        declared_source_paths: [...G4_BOOTSTRAP_SOURCE_PATHS],
        inventory_match: 'exact',
      },
      import_graph: {
        all_non_test_source_reachability: 'unreachable',
        production_root_reachability: 'unreachable',
        future_gate_source_policy:
          'allowed_when_no_test_bootstrap_authority_reachability',
      },
      production_surfaces: {
        host_configuration_roots: [
          'src',
          'electron',
          'assistant',
          'features',
          'setup',
          'scripts',
        ],
        package_default_reference: 'absent',
        feature_ingress_reachability: 'unreachable',
        api_ingress_reachability: 'unreachable',
        automation_ingress_reachability: 'unreachable',
        host_bootstrap_reachability: 'unreachable',
      },
      production_fail_closed_evidence:
        'structured_source_ownership_and_live_ast_import_graph',
      active_registry_or_release_pointer_access: 'forbidden',
      real_adapter_access: 'forbidden',
      network_access: 'forbidden',
      user_data_access: 'forbidden',
    });
    expect(analyzeG4TestBootstrapIsolation(repoRoot).violations).toEqual([]);
  });

  it('keeps the isolation identity stable for downstream-safe G5 source growth', () => {
    const fixture = createIsolationFixture();
    try {
      const before = g4IsolationBoundaryPayload(fixture.root);
      const beforeCount = analyzeG4TestBootstrapIsolation(fixture.root)
        .source_files.length;
      writeFixtureFile(
        fixture.root,
        'src/workflow-runtime/runtime/graph-runtime.ts',
        'export const graphRuntimePrerequisite = true;\n',
      );
      const after = g4IsolationBoundaryPayload(fixture.root);
      const afterAnalysis = analyzeG4TestBootstrapIsolation(fixture.root);
      expect(afterAnalysis.source_files.length).toBe(beforeCount + 1);
      expect(afterAnalysis.violations).toEqual([]);
      expect(canonicalJson(after)).toBe(canonicalJson(before));
    } finally {
      fixture.cleanup();
    }
  });

  it('binds exact G4-owned source bytes and rejects undeclared bootstrap siblings', () => {
    const fixture = createIsolationFixture();
    try {
      const before = buildG4BootstrapImplementationPayload(fixture.root);
      writeFixtureFile(
        fixture.root,
        G4_BOOTSTRAP_SOURCE_PATHS[0],
        'export const fixture = "mutated";\n',
      );
      const after = buildG4BootstrapImplementationPayload(fixture.root);
      expect(after.implementation_hash).not.toBe(before.implementation_hash);
      writeFixtureFile(
        fixture.root,
        'src/workflow-runtime/bootstrap/undeclared.ts',
        'export const undeclared = true;\n',
      );
      expect(() => buildG4BootstrapImplementationPayload(fixture.root)).toThrow(
        /bootstrap_source_inventory_drift/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ['src/index.ts', 'host'],
    ['src/features/workflow.ts', 'feature'],
    ['src/runtime-center-api.ts', 'api'],
    ['src/workflow-automation.ts', 'automation'],
    ['electron/main.ts', 'host'],
    ['src/workflow-runtime/runtime/graph-runtime.ts', 'production'],
  ] as const)(
    'rejects G4 authority imports from %s',
    (sourcePath, expectedSurface) => {
      const fixture = createIsolationFixture();
      try {
        writeFixtureFile(
          fixture.root,
          sourcePath,
          `import '${bootstrapImport(sourcePath)}';\n`,
        );
        const analysis = analyzeG4TestBootstrapIsolation(fixture.root);
        expect(analysis.violations).toContainEqual(
          expect.objectContaining({
            kind: 'authority_import_reachable',
            surface: expectedSurface,
            source: sourcePath,
          }),
        );
        expect(() => g4IsolationBoundaryPayload(fixture.root)).toThrow(
          /authority_import_reachable/,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it('rejects indirect Production entrypoint reachability', () => {
    const fixture = createIsolationFixture();
    try {
      writeFixtureFile(
        fixture.root,
        'src/service.ts',
        `import '${bootstrapImport('src/service.ts')}';\n`,
      );
      const entrypointViolation = analyzeG4TestBootstrapIsolation(
        fixture.root,
      ).violations.find((violation) => violation.source === 'src/index.ts');
      expect(entrypointViolation?.path).toEqual([
        'src/index.ts',
        'src/service.ts',
        'src/workflow-runtime/bootstrap/index.ts',
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    [
      'start script',
      { scripts: { start: 'tsx src/workflow-runtime/bootstrap' } },
    ],
    [
      'default config',
      {
        scripts: { start: 'node dist/index.js' },
        config: { profile: 'icarus.workflow-test-bootstrap-profile' },
      },
    ],
  ] as const)('rejects G4 references from package %s', (_label, mutation) => {
    const fixture = createIsolationFixture();
    try {
      const packageValue = JSON.parse(
        fs.readFileSync(path.join(fixture.root, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      writeFixtureFile(
        fixture.root,
        'package.json',
        `${JSON.stringify({ ...packageValue, ...mutation }, null, 2)}\n`,
      );
      expect(() => g4IsolationBoundaryPayload(fixture.root)).toThrow(
        /production_package_reference/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    [
      'scripts/runtime-launcher.sh',
      '#!/bin/sh\nexec node src/workflow-runtime/bootstrap/index.js\n',
    ],
    [
      'tsconfig.json',
      '{"compilerOptions":{"baseUrl":".","paths":{"@g4/*":["src/workflow-runtime/bootstrap/*"]}}}\n',
    ],
  ] as const)('rejects G4 selection from host config %s', (file, source) => {
    const fixture = createIsolationFixture();
    try {
      writeFixtureFile(fixture.root, file, source);
      expect(() => g4IsolationBoundaryPayload(fixture.root)).toThrow(
        /authority_reference_selected/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects G4 selection from a Production-imported src JSON host config', () => {
    const fixture = createIsolationFixture();
    try {
      writeFixtureFile(
        fixture.root,
        'tsconfig.json',
        '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","resolveJsonModule":true}}\n',
      );
      writeFixtureFile(
        fixture.root,
        'src/index.ts',
        'import config from "./runtime-config.json" with { type: "json" };\nexport default config;\n',
      );
      writeFixtureFile(
        fixture.root,
        'src/runtime-config.json',
        '{"profile":"icarus.workflow-test-bootstrap-profile"}\n',
      );
      expect(
        analyzeG4TestBootstrapIsolation(fixture.root).violations,
      ).toContainEqual(
        expect.objectContaining({
          kind: 'authority_reference_selected',
          source: 'src/runtime-config.json',
        }),
      );
      expect(() => g4IsolationBoundaryPayload(fixture.root)).toThrow(
        /authority_reference_selected/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
