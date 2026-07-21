import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  SAFETY_SQLITE_ARTIFACT_DESCRIPTORS,
  buildDeploymentRuntimeCapacityBaseline,
  buildSafetyEnforcementRecords,
  buildSafetySqliteSemanticArtifacts,
} from './safety-sqlite-artifacts.js';
import {
  SAFETY_SQLITE_NEGATIVE_CASES,
  SAFETY_SQLITE_POSITIVE_CASES,
} from './safety-sqlite-fixtures.js';
import { checkContractPackSafetySqlite } from './safety-sqlite-pack.js';
import {
  CAPACITY_LIMIT_PATHS,
  DEPLOYMENT_CAPACITY_RELOAD_CONTRACT,
  LOCAL_SINGLE_USER_PRODUCT_FLOOR,
  LOCAL_SINGLE_USER_RETENTION_POLICY,
  LOCAL_SINGLE_USER_SAFETY_PROFILE,
  LOCAL_SINGLE_USER_SQLITE_CANDIDATE,
  SAFETY_LIMIT_PATHS,
} from './safety-sqlite-types.js';
import { domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;
const repositoryRoot = path.resolve(contractsRoot, '../../..');

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

describe('G0.5 Safety, Retention, and SQLite Contract Pack', () => {
  it('checks every generated artifact and capacity baseline without writes', () => {
    const trackedPaths = [
      'contract-pack-foundation.json',
      'contract-pack-closed-schemas.json',
      'contract-pack-catalog-protocols.json',
      'contract-pack-safety-sqlite.json',
      'catalogs/safety-sqlite-domain-separators.json',
      'conformance/safety-sqlite/positive-cases.json',
      'conformance/safety-sqlite/negative-cases.json',
      ...SAFETY_SQLITE_ARTIFACT_DESCRIPTORS.map(
        (descriptor) => descriptor.artifact_path,
      ),
    ];
    const before = new Map(
      trackedPaths.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );
    const capacityPath = path.join(
      repositoryRoot,
      'config/workflow-runtime-capacity.json',
    );
    const capacityBefore = fs.readFileSync(capacityPath);

    const manifest = checkContractPackSafetySqlite();
    expect(manifest.payload.gate).toBe('G0.5');
    expect(manifest.payload.sqlite_profile_status).toBe('candidate');
    expect(manifest.payload.certification_status).toBe('not_certified');
    expect(manifest.payload.foundation_manifest_hash).toBe(
      'sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d',
    );
    expect(manifest.payload.closed_schema_manifest_hash).toBe(
      'sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8',
    );
    expect(manifest.payload.catalog_protocol_manifest_hash).toBe(
      'sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607',
    );
    for (const [relativePath, bytes] of before) {
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    }
    expect(fs.readFileSync(capacityPath)).toEqual(capacityBefore);
  });

  it('freezes all 69 finite Safety ceilings at the approved values', () => {
    expect(SAFETY_LIMIT_PATHS).toHaveLength(69);
    const safety = LOCAL_SINGLE_USER_SAFETY_PROFILE.ceilings;
    expect(safety.run).toMatchObject({
      max_scopes_total: 128,
      max_nodes_total: 1024,
      max_edges_total: 4096,
      max_map_items_total: 256,
      max_attempts_total: 4096,
      max_waits_total: 512,
      max_builds_total: 512,
      max_effect_operations_total: 2048,
    });
    expect(safety.workflow.max_graph_runs).toBeLessThanOrEqual(
      safety.workflow.max_state_activations - 1,
    );
    for (const group of Object.values(safety)) {
      for (const value of Object.values(group)) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it('freezes the closed hot-reload Capacity baseline and its own hash', () => {
    const capacity = buildDeploymentRuntimeCapacityBaseline();
    expect(CAPACITY_LIMIT_PATHS).toHaveLength(7);
    expect(capacity).toMatchObject({
      max_active_executions: 5,
      max_active_waits: 256,
      max_pending_signals: 2048,
      max_outbox_inflight: 16,
      max_physical_blob_bytes: 21474836480,
      soft_blob_high_water_bytes: 17179869184,
      minimum_free_disk_bytes: 5368709120,
    });
    expect(capacity.soft_blob_high_water_bytes).toBeLessThan(
      capacity.max_physical_blob_bytes,
    );
    expect(DEPLOYMENT_CAPACITY_RELOAD_CONTRACT).toMatchObject({
      update_mode: 'atomic_complete_validated_snapshot',
      lowering_existing_admissions: 'never_cancel_existing_work',
      minimum_free_disk_update: 'increase_only',
      safety_quota_effect: 'cannot_relax_pinned_safety',
    });
    const { config_hash: _configHash, ...payload } = capacity;
    expect(capacity.config_hash).toBe(
      domainSeparatedSha256('icarus:deployment-runtime-capacity:1\n', payload),
    );
  });

  it('binds Product Floor dimensions to Safety and freezes benchmark budgets', () => {
    const floor = LOCAL_SINGLE_USER_PRODUCT_FLOOR;
    expect(floor.limits.max_nodes_total).toBe(
      LOCAL_SINGLE_USER_SAFETY_PROFILE.ceilings.run.max_nodes_total,
    );
    expect(floor.limits.max_frontier_bytes).toBe(16777216);
    expect(floor.limits.max_required_child_creations_per_t8).toBe(8);
    expect(floor.benchmark_requirements).toMatchObject({
      reference_machine_minimum: 'apple_silicon_m2',
      minimum_memory_gib: 16,
      concurrent_benchmark_interference: 'forbidden',
      warmup_iterations: 10,
      measurement_iterations: 100,
      scaling_profiles_percent: [25, 50, 100],
      beyond_limit_rejection: 'before_atomic_write',
      t3_p99_budget_ms: 250,
      t7_root_fence_p99_budget_ms: 1000,
      t8_required_child_p99_budget_ms: 500,
      max_to_p99_budget_multiplier: 2,
    });
  });

  it('freezes all Retention windows and active recovery roots', () => {
    const retention = LOCAL_SINGLE_USER_RETENTION_POLICY;
    expect(retention.durations_ms).toMatchObject({
      transient_payload_retention_ms: 86400000,
      run_recovery_closed_retention_ms: 2592000000,
      workflow_audit_payload_retention_ms: 7776000000,
      workflow_audit_metadata_retention_ms: 31536000000,
      inbox_rejected_late_unmatched_payload_retention_ms: 604800000,
      inbox_rejected_late_unmatched_audit_retention_ms: 2592000000,
      backup_default_expiry_ms: 2592000000,
      pending_signal_safety_ttl_ms: 604800000,
    });
    expect(retention.rules.run_recovery_strong_states).toEqual([
      'active',
      'closing',
      'action_required',
      'quarantined',
    ]);
    expect(retention.rules.feature_policy_may_only_extend_user_artifact).toBe(
      true,
    );
  });

  it('keeps SQLite identity explicitly candidate and release-generated', () => {
    expect(LOCAL_SINGLE_USER_SQLITE_CANDIDATE).toMatchObject({
      certification_status: 'candidate',
      journal_mode: 'wal',
      synchronous: 'full',
      foreign_keys: true,
      busy_timeout_ms: 5000,
      page_size: 4096,
      auto_vacuum: 'incremental',
      temp_store: 'memory',
      wal_autocheckpoint_pages: 4096,
      journal_size_limit_bytes: 67108864,
      cache_size_kib: 32768,
      mmap_size_bytes: 0,
      read_only_query_only: true,
      identity_binding_rule: 'release_build_generated_at_g8',
    });
    for (const identityField of [
      'sqlite_version',
      'sqlite_source_id',
      'sqlite_compile_options_hash',
      'better_sqlite3_native_module_hash',
      'release_artifact_hash',
      'runtime_launcher_hash',
    ] as const) {
      expect(LOCAL_SINGLE_USER_SQLITE_CANDIDATE[identityField]).toBeNull();
    }
  });

  it('expands every Safety and Capacity field into one hashed enforcement record', () => {
    const records = buildSafetyEnforcementRecords();
    const expectedPaths = [
      ...SAFETY_LIMIT_PATHS,
      ...CAPACITY_LIMIT_PATHS,
    ].sort();
    expect(records).toHaveLength(76);
    expect(records.map((record) => record.limit_path).sort()).toEqual(
      expectedPaths,
    );
    expect(new Set(records.map((record) => record.limit_path)).size).toBe(76);
    for (const record of records) {
      expect(record.limit_path).not.toContain('*');
      expect(record.enforcement_component).not.toBe('');
      expect(record.reservation_point).not.toBeNull();
      expect(record.failure_code).not.toBe('');
      expect(record.failure_outcome).not.toBe('');
      const { record_hash: _recordHash, ...payload } = record;
      expect(record.record_hash).toBe(
        domainSeparatedSha256(
          'icarus:workflow-safety-enforcement-record:1\n',
          payload,
        ),
      );
      expect(record.included_in_plan_hash).toBe(
        !record.limit_path.startsWith('capacity.'),
      );
    }
  });

  it('executes all positive and negative G0.5 fixtures', () => {
    expect(SAFETY_SQLITE_POSITIVE_CASES).toHaveLength(7);
    expect(SAFETY_SQLITE_NEGATIVE_CASES).toHaveLength(30);
    expect(() => checkContractPackSafetySqlite()).not.toThrow();
  });

  it('keeps G0.5 free of G0.6, DDL, Golden, and certification semantics', () => {
    const formats = buildSafetySqliteSemanticArtifacts().map(
      ([, artifact]) => artifact.format,
    );
    expect(formats).not.toContain('icarus.workflow-runtime-schema-manifest/1');
    expect(formats).not.toContain('icarus.runtime-supported-limits/1');
    const sqliteFiles = fs
      .readdirSync(path.join(contractsRoot, 'sqlite'))
      .sort();
    expect(sqliteFiles).toContain('local_single_user_sqlite@1.json');
    expect(sqliteFiles).toContain('sqlite-execution-profile-schema.json');
    expect(sqliteFiles).not.toContain('workflow-runtime-schema-manifest.json');
    expect(sqliteFiles).not.toContain('workflow-runtime-migration.sql');
    for (const directory of ['conformance/sealed']) {
      expect(fs.readdirSync(path.join(contractsRoot, directory))).toEqual([
        '.gitkeep',
        'g2-production-compiler-replay-repair-v2',
        'g2-semantic-correction',
      ]);
    }
    const matrix = readArtifact(
      'safety/local_single_user_safety_enforcement_matrix@1.json',
    );
    expect(matrix.payload.records).toHaveLength(76);
    assertJsonObject(matrix.payload);
  });
});
