import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from '../../contracts/artifact.js';
import { parseSha256Hash } from '../../contracts/hash.js';
import {
  SQLITE_PROFILE_KEYS,
  type SQLiteExecutionProfileCandidate,
} from '../../contracts/safety-sqlite-types.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  Sha256Hash,
} from '../../contracts/types.js';
import { parseVersionedRef } from '../../contracts/versioned-ref.js';
import { assertClosedSchemaDependencyManifest } from '../schema/dependencies.js';
import { calculateManifestSqliteSchemaIdentity } from '../schema/database-identity.js';
import { assertClosedSchemaManifest } from '../schema/manifest.js';
import type {
  G1SchemaDependencyManifestPayload,
  WorkflowRuntimeSchemaManifestPayload,
} from '../schema/types.js';

export const FROZEN_G1_1_IDENTITIES = {
  root: 'sha256:baa39d55cac34133a29b461466aa450fec59bd2fd6df72334e8b33d1d1619869',
  dependencyManifest:
    'sha256:d08cfaae72c003b11a05cb1fbfa546f7cce7fad9ecb56d0746f33de294b8088c',
  physicalSchema:
    'sha256:ba025b32bb028f2ffe5df45d9440cd0a897e0a06c076b10b6f641c265ae02090',
  schema:
    'sha256:49aaee7c8f046cd9a15b3bc5b77fbcf1713be2a1872078941043f5ccdca29024',
  migration:
    'sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6',
  schema3To4Upgrade:
    'sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf',
  schema4To5Upgrade:
    'sha256:97479810c2c079d71270d5a714faa4b8fa8ebd6af629ef2f7d772af270c2bb0a',
  schema3SourceMigration:
    'sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345',
  schema3SourceSqliteSchema:
    'sha256:a4bc69f3bbf8f6cf00c32c835596eed4a73036941276a3175d550faba2d2f5ee',
  schema4SourceMigration:
    'sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43',
  schema4SourceSqliteSchema:
    'sha256:e46f58e49b42ad53e3d744de86b6d8fb6299236258459c35d9ca3affa440932c',
  sqliteSchema:
    'sha256:5ee3c119cc6a0e0552e2a6fe45b51c8ffd08ec7acdbac66748978ed0d21fdb0a',
  deterministic:
    'sha256:971466fbade30d4a7f15df694b5a5a18cc8fe033270a1966a90d4e8d17da8202',
  manifest:
    'sha256:c9bce166112023cf5e09d41901938f74efbc69cff36da9428a3c21c3064d8439',
  executableDdl:
    'sha256:8e5f64dd00d99ddf6cfece939ce162190bdd05402aca6b3c369b85ed18642f62',
  profile:
    'sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af',
} as const;

export const CURRENT_G1_SCHEMA_IDENTITIES = {
  root: 'sha256:0373eac8da2f96c1377e934ea5bcfdb701e96954720c2719aa756be778cc3995',
  dependencyManifest:
    'sha256:e09243fdc43f591f820c4f090284eedfda1b855e514545faf4dd6089f9c33e7f',
  physicalSchema:
    'sha256:01c9aba5e41b05f91eb4ede8fe6150e6d737f7140e16d05ad7b60816ff1fb472',
  schema:
    'sha256:1c7592c8b24a2b032217f42b31a5af3ebf39a9dd4dd10f1158ab9ced340142c6',
  migration:
    'sha256:b19ebe83ea8b7c53a2ab54a901df092b4e343ee4e1d5772ed6bc3143a82746ad',
  schema3To4Upgrade: FROZEN_G1_1_IDENTITIES.schema3To4Upgrade,
  schema4To5Upgrade: FROZEN_G1_1_IDENTITIES.schema4To5Upgrade,
  schema5To6Upgrade:
    'sha256:dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d',
  schema6To7Upgrade:
    'sha256:225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062',
  schema7To8Upgrade:
    'sha256:544af9b55349268d152650c9a9fda5c399bb0e665750a2c47a6155d22ca6e3a9',
  schema3SourceMigration: FROZEN_G1_1_IDENTITIES.schema3SourceMigration,
  schema3SourceSqliteSchema: FROZEN_G1_1_IDENTITIES.schema3SourceSqliteSchema,
  schema4SourceMigration: FROZEN_G1_1_IDENTITIES.schema4SourceMigration,
  schema4SourceSqliteSchema: FROZEN_G1_1_IDENTITIES.schema4SourceSqliteSchema,
  schema5SourceMigration: FROZEN_G1_1_IDENTITIES.migration,
  schema5SourceSqliteSchema: FROZEN_G1_1_IDENTITIES.sqliteSchema,
  schema6SourceMigration:
    'sha256:16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41',
  schema6SourceSqliteSchema:
    'sha256:a4936a9a71670cb30b1c974ee3cf9cd21375fb743e8c2278d8db08c685854486',
  schema7SourceMigration:
    'sha256:b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497',
  schema7SourceSqliteSchema:
    'sha256:89ea6f6cfd7753938722aaf2ea7201d25f6546c12bd54a42441ec451810c8b96',
  sqliteSchema:
    'sha256:fc5fe00fb26b187cf4d0b2927a97de1851fffc2ba5283811312397255ffd5b3b',
  deterministic:
    'sha256:54a9933266d7765ad931f7e203e22359ec87307a90b4f4c343af193a3688a561',
  manifest:
    'sha256:6658a3545932cef875289536d5f70b242ccdbe21c6ee8fcdf5c6f1935d1512f1',
  executableDdl:
    'sha256:6434fb948e1f8aa12b2359c661a45ebc2e6f995d535f1caefadb6928bda21460',
  profile: FROZEN_G1_1_IDENTITIES.profile,
} as const;

const defaultSchemaRoot = path.resolve(import.meta.dirname, '../schema');
const defaultContractsRoot = path.resolve(
  import.meta.dirname,
  '../../contracts',
);

const positiveIntegerFields = [
  'busy_timeout_ms',
  'page_size',
  'wal_autocheckpoint_pages',
  'journal_size_limit_bytes',
  'cache_size_kib',
] as const;

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} has an unknown, duplicate, or missing field`);
  }
}

function expectLiteral(
  value: unknown,
  expected: string | boolean | null,
  pointer: string,
): void {
  if (value !== expected) {
    throw new Error(
      `SQLite Profile ${pointer} must equal ${String(expected)}, received ${String(value)}`,
    );
  }
}

function positiveSafeInteger(value: unknown, pointer: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      `SQLite Profile ${pointer} must be a finite positive safe integer`,
    );
  }
  return value;
}

function readArtifact(
  root: string,
  relativePath: string,
): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(path.join(root, relativePath))),
  );
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function expectArtifact(
  artifact: ContractArtifactEnvelope,
  expectedHash: string,
  expectedFormat: string,
  label: string,
): void {
  if (artifact.hash !== expectedHash || artifact.format !== expectedFormat) {
    throw new Error(
      `${label} frozen identity drifted: expected ${expectedFormat} ${expectedHash}, received ${artifact.format} ${artifact.hash}`,
    );
  }
}

export function parseSQLiteExecutionProfilePayload(
  value: unknown,
): Readonly<SQLiteExecutionProfileCandidate> {
  assertJsonObject(value);
  exactKeys(value, SQLITE_PROFILE_KEYS, 'SQLite Profile payload');

  for (const field of positiveIntegerFields) {
    positiveSafeInteger(value[field], `/${field}`);
  }
  if (
    typeof value.mmap_size_bytes !== 'number' ||
    !Number.isFinite(value.mmap_size_bytes) ||
    !Number.isSafeInteger(value.mmap_size_bytes) ||
    value.mmap_size_bytes !== 0
  ) {
    throw new Error(
      'SQLite Profile /mmap_size_bytes must be the explicitly allowed safe integer 0',
    );
  }

  const literals: Array<
    [keyof SQLiteExecutionProfileCandidate, string | boolean | null]
  > = [
    ['profile_id', 'local_single_user_sqlite@1'],
    ['certification_status', 'candidate'],
    ['deployment_profile', 'local_single_user'],
    ['runtime_surface', 'node_service'],
    ['platform', 'darwin'],
    ['arch', 'arm64'],
    ['journal_mode', 'wal'],
    ['synchronous', 'full'],
    ['foreign_keys', true],
    ['auto_vacuum', 'incremental'],
    ['temp_store', 'memory'],
    ['trusted_schema', false],
    ['recursive_triggers', false],
    ['read_uncommitted', false],
    ['locking_mode', 'normal'],
    ['read_only_query_only', true],
    ['sqlite_version', null],
    ['sqlite_source_id', null],
    ['sqlite_compile_options_hash', null],
    ['better_sqlite3_version', '12.11.1'],
    ['better_sqlite3_native_module_hash', null],
    ['node_runtime_version', '26.5.0'],
    ['release_artifact_hash', null],
    ['runtime_launcher_hash', null],
    ['identity_binding_rule', 'release_build_generated_at_g8'],
    ['profile_application', 'immutable_restart_and_recertification_required'],
  ];
  for (const [field, expected] of literals) {
    expectLiteral(value[field], expected, `/${field}`);
  }

  const distributionRef = parseVersionedRef(
    value.managed_node_distribution_ref,
  );
  if (
    distributionRef.id !== 'nodejs.node-v26.5.0-darwin-arm64' ||
    distributionRef.version !== '1.0.0'
  ) {
    throw new Error('SQLite Profile managed Node distribution ref drifted');
  }
  parseSha256Hash(value.managed_node_distribution_hash);
  parseSha256Hash(value.node_executable_hash);

  return deepFreeze(
    structuredClone(value) as unknown as SQLiteExecutionProfileCandidate,
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export interface FrozenWorkflowRuntimeStoreInputs {
  readonly profile: Readonly<SQLiteExecutionProfileCandidate>;
  readonly profileArtifactHash: Sha256Hash;
  readonly migrationSql: string;
  readonly migrationSha256: Sha256Hash;
  readonly schema3To4UpgradeSql: string;
  readonly schema3To4UpgradeSha256: Sha256Hash;
  readonly schema4To5UpgradeSql: string;
  readonly schema4To5UpgradeSha256: Sha256Hash;
  readonly schema5To6UpgradeSql: string;
  readonly schema5To6UpgradeSha256: Sha256Hash;
  readonly schema6To7UpgradeSql: string;
  readonly schema6To7UpgradeSha256: Sha256Hash;
  readonly schema7To8UpgradeSql: string;
  readonly schema7To8UpgradeSha256: Sha256Hash;
  readonly schema3SourceMigrationSha256: Sha256Hash;
  readonly schema3SourceSqliteSchemaIdentity: Sha256Hash;
  readonly schema4SourceMigrationSha256: Sha256Hash;
  readonly schema4SourceSqliteSchemaIdentity: Sha256Hash;
  readonly schema5SourceMigrationSha256: Sha256Hash;
  readonly schema5SourceSqliteSchemaIdentity: Sha256Hash;
  readonly schema6SourceMigrationSha256: Sha256Hash;
  readonly schema6SourceSqliteSchemaIdentity: Sha256Hash;
  readonly schema7SourceMigrationSha256: Sha256Hash;
  readonly schema7SourceSqliteSchemaIdentity: Sha256Hash;
  readonly sqliteSchemaIdentity: Sha256Hash;
  readonly schema3RequiredEmptyRelations: readonly string[];
  readonly schemaManifest: Readonly<WorkflowRuntimeSchemaManifestPayload>;
  readonly schemaManifestArtifactHash: Sha256Hash;
  readonly schemaDependencyManifest: Readonly<G1SchemaDependencyManifestPayload>;
  readonly schemaDependencyManifestArtifactHash: Sha256Hash;
  readonly physicalSchemaIdentity: Sha256Hash;
  readonly schemaHash: Sha256Hash;
  readonly g1RootHash: Sha256Hash;
  readonly deterministicDigest: Sha256Hash;
}

export function loadFrozenWorkflowRuntimeStoreInputs(
  roots: { schemaRoot?: string; contractsRoot?: string } = {},
): Readonly<FrozenWorkflowRuntimeStoreInputs> {
  const schemaRoot = roots.schemaRoot ?? defaultSchemaRoot;
  const contractsRoot = roots.contractsRoot ?? defaultContractsRoot;
  const profileArtifact = readArtifact(
    contractsRoot,
    'sqlite/local_single_user_sqlite@1.json',
  );
  expectArtifact(
    profileArtifact,
    CURRENT_G1_SCHEMA_IDENTITIES.profile,
    'icarus.sqlite-execution-profile/1',
    'SQLite Profile',
  );
  const profile = parseSQLiteExecutionProfilePayload(profileArtifact.payload);

  const dependencyManifestArtifact = readArtifact(
    schemaRoot,
    'artifacts/workflow-runtime-schema-dependency-manifest@2.json',
  );
  expectArtifact(
    dependencyManifestArtifact,
    CURRENT_G1_SCHEMA_IDENTITIES.dependencyManifest,
    'icarus.workflow-runtime-schema-dependency-manifest/1',
    'G1 Schema Dependency Manifest',
  );
  const dependencyManifest =
    dependencyManifestArtifact.payload as unknown as G1SchemaDependencyManifestPayload;
  assertClosedSchemaDependencyManifest(dependencyManifest);
  if (
    dependencyManifest.physical_schema_identity !==
    CURRENT_G1_SCHEMA_IDENTITIES.physicalSchema
  ) {
    throw new Error('G1 physical schema identity drifted');
  }

  const root = readArtifact(
    schemaRoot,
    'contract-pack-g1-executable-schema-v8.json',
  );
  expectArtifact(
    root,
    CURRENT_G1_SCHEMA_IDENTITIES.root,
    'icarus.workflow-contract-pack-g1-executable-schema/1',
    'G1.1 root',
  );
  const rootPayload = root.payload;
  if (
    rootPayload.schema_dependency_manifest_hash !==
      CURRENT_G1_SCHEMA_IDENTITIES.dependencyManifest ||
    rootPayload.physical_schema_identity !==
      CURRENT_G1_SCHEMA_IDENTITIES.physicalSchema ||
    rootPayload.schema_hash !== CURRENT_G1_SCHEMA_IDENTITIES.schema ||
    rootPayload.migration_sha256 !== CURRENT_G1_SCHEMA_IDENTITIES.migration ||
    rootPayload.schema3_to_schema4_upgrade_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema3To4Upgrade ||
    rootPayload.schema4_to_schema5_upgrade_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema4To5Upgrade ||
    rootPayload.schema5_to_schema6_upgrade_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema5To6Upgrade ||
    rootPayload.schema6_to_schema7_upgrade_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema6To7Upgrade ||
    rootPayload.schema7_to_schema8_upgrade_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema7To8Upgrade ||
    rootPayload.schema3_source_migration_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema3SourceMigration ||
    rootPayload.schema3_source_sqlite_schema_identity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema3SourceSqliteSchema ||
    rootPayload.schema4_source_migration_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema4SourceMigration ||
    rootPayload.schema4_source_sqlite_schema_identity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema4SourceSqliteSchema ||
    rootPayload.schema5_source_migration_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema5SourceMigration ||
    rootPayload.schema5_source_sqlite_schema_identity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema5SourceSqliteSchema ||
    rootPayload.schema7_source_migration_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema7SourceMigration ||
    rootPayload.schema7_source_sqlite_schema_identity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema7SourceSqliteSchema ||
    rootPayload.sqlite_schema_identity !==
      CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema ||
    rootPayload.deterministic_digest !==
      CURRENT_G1_SCHEMA_IDENTITIES.deterministic ||
    rootPayload.sqlite_profile_status !== 'candidate' ||
    rootPayload.certification_status !== 'not_certified'
  ) {
    throw new Error('G1.1 root payload drifted from the frozen Store input');
  }

  const executableDdl = readArtifact(
    schemaRoot,
    'artifacts/workflow-runtime-executable-ddl@2.json',
  );
  expectArtifact(
    executableDdl,
    CURRENT_G1_SCHEMA_IDENTITIES.executableDdl,
    'icarus.workflow-runtime-executable-ddl/1',
    'G1.1 executable DDL',
  );
  if (
    executableDdl.payload.schema_hash !== CURRENT_G1_SCHEMA_IDENTITIES.schema ||
    executableDdl.payload.migration_sha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.migration ||
    executableDdl.payload.database_schema_version !== 8 ||
    executableDdl.payload.schema3_upgrade_mode !==
      'empty_activation_state_only_or_fail_closed' ||
    executableDdl.payload.schema4_upgrade_mode !==
      'rebuild_capacity_invocations_preserve_all_rows_or_fail_closed' ||
    executableDdl.payload.schema5_upgrade_mode !==
      'rebuild_workflow_values_preserve_all_rows_and_inbound_foreign_keys_or_fail_closed' ||
    executableDdl.payload.schema6_upgrade_mode !==
      'rebuild_generated_schema_binding_and_values_preserve_all_rows_or_fail_closed' ||
    executableDdl.payload.schema7_upgrade_mode !==
      'rebuild_child_consumption_with_exact_lineage_preserve_valid_rows_or_fail_closed'
  ) {
    throw new Error('G1.1 executable DDL payload drifted');
  }
  const schema3SourceMigrationSha256 = parseSha256Hash(
    executableDdl.payload.schema3_source_migration_sha256,
  );
  const schema3SourceSqliteSchemaIdentity = parseSha256Hash(
    executableDdl.payload.schema3_source_sqlite_schema_identity,
  );
  const sqliteSchemaIdentity = parseSha256Hash(
    executableDdl.payload.sqlite_schema_identity,
  );
  const schema3To4UpgradeSha256 = parseSha256Hash(
    executableDdl.payload.schema3_to_schema4_upgrade_sha256,
  );
  const schema4To5UpgradeSha256 = parseSha256Hash(
    executableDdl.payload.schema4_to_schema5_upgrade_sha256,
  );
  const schema5To6UpgradeSha256 = parseSha256Hash(
    executableDdl.payload.schema5_to_schema6_upgrade_sha256,
  );
  const schema6To7UpgradeSha256 = parseSha256Hash(
    executableDdl.payload.schema6_to_schema7_upgrade_sha256,
  );
  const schema7To8UpgradeSha256 = parseSha256Hash(
    executableDdl.payload.schema7_to_schema8_upgrade_sha256,
  );
  const schema4SourceMigrationSha256 = parseSha256Hash(
    executableDdl.payload.schema4_source_migration_sha256,
  );
  const schema4SourceSqliteSchemaIdentity = parseSha256Hash(
    executableDdl.payload.schema4_source_sqlite_schema_identity,
  );
  const schema5SourceMigrationSha256 = parseSha256Hash(
    executableDdl.payload.schema5_source_migration_sha256,
  );
  const schema5SourceSqliteSchemaIdentity = parseSha256Hash(
    executableDdl.payload.schema5_source_sqlite_schema_identity,
  );
  const schema6SourceMigrationSha256 =
    CURRENT_G1_SCHEMA_IDENTITIES.schema6SourceMigration;
  const schema6SourceSqliteSchemaIdentity =
    CURRENT_G1_SCHEMA_IDENTITIES.schema6SourceSqliteSchema;
  const schema7SourceMigrationSha256 = parseSha256Hash(
    executableDdl.payload.schema7_source_migration_sha256,
  );
  const schema7SourceSqliteSchemaIdentity = parseSha256Hash(
    executableDdl.payload.schema7_source_sqlite_schema_identity,
  );
  if (
    schema3To4UpgradeSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema3To4Upgrade ||
    schema4To5UpgradeSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema4To5Upgrade ||
    schema5To6UpgradeSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema5To6Upgrade ||
    schema6To7UpgradeSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema6To7Upgrade ||
    schema7To8UpgradeSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema7To8Upgrade ||
    schema3SourceMigrationSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema3SourceMigration ||
    schema3SourceSqliteSchemaIdentity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema3SourceSqliteSchema ||
    schema4SourceMigrationSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema4SourceMigration ||
    schema4SourceSqliteSchemaIdentity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema4SourceSqliteSchema ||
    schema5SourceMigrationSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema5SourceMigration ||
    schema5SourceSqliteSchemaIdentity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema5SourceSqliteSchema ||
    schema7SourceMigrationSha256 !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema7SourceMigration ||
    schema7SourceSqliteSchemaIdentity !==
      CURRENT_G1_SCHEMA_IDENTITIES.schema7SourceSqliteSchema ||
    sqliteSchemaIdentity !== CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema
  ) {
    throw new Error('G1.6 Schema 3/4 frozen SQLite identity drifted');
  }
  const requiredEmpty = executableDdl.payload.schema3_required_empty_relations;
  const expectedRequiredEmpty = [
    'workflow_feature_release_activation_commands',
    'workflow_feature_release_activation_invocations',
    'workflow_feature_release_activation_events',
    'workflow_feature_active_releases',
  ];
  if (
    !Array.isArray(requiredEmpty) ||
    requiredEmpty.length !== expectedRequiredEmpty.length ||
    requiredEmpty.some((value, index) => value !== expectedRequiredEmpty[index])
  ) {
    throw new Error('G1.6 Schema 3 upgrade empty-relation gate drifted');
  }

  const manifestArtifact = readArtifact(
    schemaRoot,
    'artifacts/workflow-runtime-schema-manifest@2.json',
  );
  expectArtifact(
    manifestArtifact,
    CURRENT_G1_SCHEMA_IDENTITIES.manifest,
    'icarus.workflow-runtime-schema-manifest/1',
    'G1.1 Schema Manifest',
  );
  const manifest =
    manifestArtifact.payload as unknown as WorkflowRuntimeSchemaManifestPayload;
  assertClosedSchemaManifest(manifest);
  if (
    manifest.schema_hash !== CURRENT_G1_SCHEMA_IDENTITIES.schema ||
    manifest.migration_sha256 !== CURRENT_G1_SCHEMA_IDENTITIES.migration ||
    manifest.database_name !== 'workflow-runtime.db'
  ) {
    throw new Error('G1.1 Schema Manifest payload drifted');
  }
  if (
    calculateManifestSqliteSchemaIdentity(manifest) !== sqliteSchemaIdentity
  ) {
    throw new Error('G1.1 Schema Manifest SQLite identity drifted');
  }

  const schema5MigrationBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v1.sql'),
  );
  const observedSchema5MigrationSha256 = rawSha256(schema5MigrationBytes);
  if (observedSchema5MigrationSha256 !== schema5SourceMigrationSha256) {
    throw new Error(
      `Historical Schema 5 source migration drifted: expected ${schema5SourceMigrationSha256}, received ${observedSchema5MigrationSha256}`,
    );
  }
  const migrationBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v8.sql'),
  );
  const migrationSha256 = rawSha256(migrationBytes);
  if (migrationSha256 !== CURRENT_G1_SCHEMA_IDENTITIES.migration) {
    throw new Error(
      `G1.1 migration drifted: expected ${CURRENT_G1_SCHEMA_IDENTITIES.migration}, received ${migrationSha256}`,
    );
  }
  const upgradeBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v3-to-v4.sql'),
  );
  const observedUpgradeSha256 = rawSha256(upgradeBytes);
  if (observedUpgradeSha256 !== schema3To4UpgradeSha256) {
    throw new Error(
      `G1.6 Schema 3 to 4 upgrade drifted: expected ${schema3To4UpgradeSha256}, received ${observedUpgradeSha256}`,
    );
  }
  const schema4To5UpgradeBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v4-to-v5.sql'),
  );
  const observedSchema4To5UpgradeSha256 = rawSha256(schema4To5UpgradeBytes);
  if (observedSchema4To5UpgradeSha256 !== schema4To5UpgradeSha256) {
    throw new Error(
      `G1 Schema 4 to 5 upgrade drifted: expected ${schema4To5UpgradeSha256}, received ${observedSchema4To5UpgradeSha256}`,
    );
  }
  const schema5To6UpgradeBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v5-to-v6.sql'),
  );
  const observedSchema5To6UpgradeSha256 = rawSha256(schema5To6UpgradeBytes);
  if (observedSchema5To6UpgradeSha256 !== schema5To6UpgradeSha256) {
    throw new Error(
      `G1 Schema 5 to 6 upgrade drifted: expected ${schema5To6UpgradeSha256}, received ${observedSchema5To6UpgradeSha256}`,
    );
  }
  const schema6MigrationBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v6.sql'),
  );
  const observedSchema6MigrationSha256 = rawSha256(schema6MigrationBytes);
  if (observedSchema6MigrationSha256 !== schema6SourceMigrationSha256) {
    throw new Error(
      `Historical Schema 6 source migration drifted: expected ${schema6SourceMigrationSha256}, received ${observedSchema6MigrationSha256}`,
    );
  }
  const schema6To7UpgradeBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v6-to-v7.sql'),
  );
  const observedSchema6To7UpgradeSha256 = rawSha256(schema6To7UpgradeBytes);
  if (observedSchema6To7UpgradeSha256 !== schema6To7UpgradeSha256) {
    throw new Error(
      `G1 Schema 6 to 7 upgrade drifted: expected ${schema6To7UpgradeSha256}, received ${observedSchema6To7UpgradeSha256}`,
    );
  }
  const schema7MigrationBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v7.sql'),
  );
  const observedSchema7MigrationSha256 = rawSha256(schema7MigrationBytes);
  if (observedSchema7MigrationSha256 !== schema7SourceMigrationSha256) {
    throw new Error(
      `Historical Schema 7 source migration drifted: expected ${schema7SourceMigrationSha256}, received ${observedSchema7MigrationSha256}`,
    );
  }
  const schema7To8UpgradeBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v7-to-v8.sql'),
  );
  const observedSchema7To8UpgradeSha256 = rawSha256(schema7To8UpgradeBytes);
  if (observedSchema7To8UpgradeSha256 !== schema7To8UpgradeSha256) {
    throw new Error(
      `G1 Schema 7 to 8 upgrade drifted: expected ${schema7To8UpgradeSha256}, received ${observedSchema7To8UpgradeSha256}`,
    );
  }
  const memberHash = (role: string): Sha256Hash | undefined =>
    dependencyManifest.members.find((member) => member.role === role)
      ?.raw_sha256;
  if (
    memberHash('schema_manifest') !==
      rawSha256(
        fs.readFileSync(
          path.join(
            schemaRoot,
            'artifacts/workflow-runtime-schema-manifest@2.json',
          ),
        ),
      ) ||
    memberHash('canonical_migration') !== migrationSha256 ||
    memberHash('schema3_to_schema4_upgrade') !== observedUpgradeSha256 ||
    memberHash('schema4_to_schema5_upgrade') !==
      observedSchema4To5UpgradeSha256 ||
    memberHash('schema5_to_schema6_upgrade') !==
      observedSchema5To6UpgradeSha256 ||
    memberHash('schema6_to_schema7_upgrade') !==
      observedSchema6To7UpgradeSha256 ||
    memberHash('schema7_to_schema8_upgrade') !==
      observedSchema7To8UpgradeSha256 ||
    memberHash('sqlite_execution_profile') !==
      rawSha256(
        fs.readFileSync(
          path.join(contractsRoot, 'sqlite/local_single_user_sqlite@1.json'),
        ),
      )
  ) {
    throw new Error('Frozen Store artifact closure drifted');
  }

  return deepFreeze({
    profile,
    profileArtifactHash: profileArtifact.hash,
    migrationSql: migrationBytes.toString('utf8'),
    migrationSha256,
    schema3To4UpgradeSql: upgradeBytes.toString('utf8'),
    schema3To4UpgradeSha256: observedUpgradeSha256,
    schema4To5UpgradeSql: schema4To5UpgradeBytes.toString('utf8'),
    schema4To5UpgradeSha256: observedSchema4To5UpgradeSha256,
    schema5To6UpgradeSql: schema5To6UpgradeBytes.toString('utf8'),
    schema5To6UpgradeSha256: observedSchema5To6UpgradeSha256,
    schema6To7UpgradeSql: schema6To7UpgradeBytes.toString('utf8'),
    schema6To7UpgradeSha256: observedSchema6To7UpgradeSha256,
    schema7To8UpgradeSql: schema7To8UpgradeBytes.toString('utf8'),
    schema7To8UpgradeSha256: observedSchema7To8UpgradeSha256,
    schema3SourceMigrationSha256,
    schema3SourceSqliteSchemaIdentity,
    schema4SourceMigrationSha256,
    schema4SourceSqliteSchemaIdentity,
    schema5SourceMigrationSha256,
    schema5SourceSqliteSchemaIdentity,
    schema6SourceMigrationSha256,
    schema6SourceSqliteSchemaIdentity,
    schema7SourceMigrationSha256,
    schema7SourceSqliteSchemaIdentity,
    sqliteSchemaIdentity,
    schema3RequiredEmptyRelations: [...expectedRequiredEmpty],
    schemaManifest: structuredClone(manifest),
    schemaManifestArtifactHash: manifestArtifact.hash,
    schemaDependencyManifest: structuredClone(dependencyManifest),
    schemaDependencyManifestArtifactHash: dependencyManifestArtifact.hash,
    physicalSchemaIdentity: dependencyManifest.physical_schema_identity,
    schemaHash: manifest.schema_hash,
    g1RootHash: root.hash,
    deterministicDigest: parseSha256Hash(rootPayload.deterministic_digest),
  });
}

export function profileAsJsonObject(
  profile: Readonly<SQLiteExecutionProfileCandidate>,
): JsonObject {
  return profile as unknown as JsonObject;
}
