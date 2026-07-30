import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const hash = `sha256:${'1'.repeat(64)}`;
const ref = { id: 'fixture.ref', version: '1.0.0' };

function readinessCase(
  transaction: 't3' | 't7' | 't8',
  shape: string,
  profile: 'supported_limit' | 'beyond_limit',
) {
  const beyond = profile === 'beyond_limit';
  const observations = [
    { phase: 'warmup', iteration: 1 },
    ...Array.from({ length: 5 }, (_, index) => ({
      phase: 'measurement',
      iteration: index + 1,
    })),
  ].map((observation) => ({
    ...observation,
    status: 'rejected_before_atomic_write',
    error_code: 'runtime_supported_limit_exceeded',
    database_before_hash: hash,
    database_after_hash: hash,
    affected_rows: 0,
  }));
  return {
    case_id: `g8:${transaction}:${shape}:${profile}`,
    transaction,
    shape,
    profile,
    scale_percent: beyond ? null : 100,
    warmup_iterations: 1,
    measurement_iterations: 5,
    dimensions: { max_nodes_total: 1 },
    limit_dimensions: { max_nodes_total: 1 },
    production_entry:
      transaction === 't3'
        ? 'reconcileFactT3a'
        : transaction === 't7'
          ? 'requestScopeCloseT7a'
          : 'commitRootT8',
    production_index_evidence: ['fixture:index'],
    correctness_invariants: ['fixture invariant'],
    statistics: beyond
      ? null
      : {
          p50_ms: 1,
          p95_ms: 2,
          p99_ms: 3,
          max_ms: 4,
          wal_bytes: 1,
          peak_rss_bytes: 1,
          affected_rows: 1,
        },
    beyond_limit_rejection: beyond
      ? {
          status: 'rejected_before_atomic_write',
          error_code: 'runtime_supported_limit_exceeded',
          attempted_dimensions: { max_nodes_total: 1 },
          database_before_hash: hash,
          database_after_hash: hash,
          affected_rows: 0,
          observations,
        }
      : null,
  };
}

function reportFixture() {
  const cases = [
    readinessCase('t3', 'route_group', 'supported_limit'),
    readinessCase('t3', 'route_group', 'beyond_limit'),
    readinessCase('t7', 'mixed_lifecycle', 'supported_limit'),
    readinessCase('t7', 'mixed_lifecycle', 'beyond_limit'),
    readinessCase('t8', 'maximum_required_child', 'supported_limit'),
    readinessCase('t8', 'maximum_required_child', 'beyond_limit'),
  ];
  return {
    format: 'icarus.workflow-runtime-g8-readiness-report/1',
    ref: {
      id: 'icarus.workflow-runtime-g8-readiness',
      version: '1.0.0',
    },
    status: 'pass',
    certification_status: 'not_certified',
    release_manifest_hash: hash,
    release_artifact_hash: hash,
    core_build_hash: hash,
    database_schema_hash: hash,
    runtime_launcher_hash: hash,
    runtime_toolchain_hash: hash,
    managed_node_distribution_ref: ref,
    managed_node_distribution_hash: hash,
    node_runtime_version: '26.5.0',
    node_executable_hash: hash,
    better_sqlite3_version: '12.11.1',
    better_sqlite3_native_module_hash: hash,
    sqlite_version: '3.0.0',
    sqlite_source_id: 'fixture-source',
    sqlite_compile_options_hash: hash,
    sqlite_profile_candidate_hash: hash,
    startup_smoke_harness_ref: ref,
    startup_smoke_harness_hash: hash,
    startup_smoke_report_hash: hash,
    readiness_harness_ref: ref,
    readiness_harness_hash: hash,
    warmup_iterations: 1,
    measurement_iterations: 5,
    cases,
    cases_hash: hash,
    security_sensitive_validation: 'SECURITY_VALIDATION_NOT_RUN',
    security_validation_basis:
      'static_source_existing_tests_and_invariant_mapping_only',
    report_hash: hash,
  };
}

describe('G8 readiness artifact schema', () => {
  it('accepts the closed six-case non-certified report fixture', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          '../contracts/certification/g8-validation-reports-schema.json',
        ),
        'utf8',
      ),
    ) as AnySchema;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      schema,
    );
    expect(validate(reportFixture()), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(validate({ ...reportFixture(), certified: true })).toBe(false);
  });
});
