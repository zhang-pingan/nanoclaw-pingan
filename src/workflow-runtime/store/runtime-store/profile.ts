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
  root: 'sha256:f49781e161e00815e08841b2bc3b2b09ee83d60476220c398c9c0824ee4bcfa9',
  dependencyManifest:
    'sha256:8acbfe7b71e43ccb6b093d1c72f973ed27c54a8f04b03e8a8dc4fdc858de5d6e',
  physicalSchema:
    'sha256:20006150a0be02a34a636a238fe706e96d3da3b9808911f4475224e93fae7933',
  schema:
    'sha256:adfcd0462b50991cceb9497412f8af4e0271f6769a9d810ff9e4d58011952cf1',
  migration:
    'sha256:11e69e3d82c3963c3eac7d75be67ac16575e43685fdd8e5b392e97152f734e9b',
  schema3To4Upgrade:
    'sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf',
  schema4To5Upgrade:
    'sha256:b443b201131cc1a26bd2401b784f7b4672c5f80828e6df31c23fb518c93e59e1',
  schema3SourceMigration:
    'sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345',
  schema3SourceSqliteSchema:
    'sha256:a4bc69f3bbf8f6cf00c32c835596eed4a73036941276a3175d550faba2d2f5ee',
  schema4SourceMigration:
    'sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43',
  schema4SourceSqliteSchema:
    'sha256:e46f58e49b42ad53e3d744de86b6d8fb6299236258459c35d9ca3affa440932c',
  sqliteSchema:
    'sha256:c771e311172974b6b1c43e5fce8db35bca84ef4c3af9392d37efff2c4aa0dd47',
  deterministic:
    'sha256:2f12541b8e7a51d12733b3c2de10188374933626e1740255a2ae3b743b0192e8',
  manifest:
    'sha256:6ce20c518c13a47bb50f9f884f5faec506b2e50100a92ec3d3eb84f2649147e4',
  executableDdl:
    'sha256:88ca1c4875ae017c38215a9508f6c176319114cde3c1f432c292ce98d6344532',
  profile:
    'sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af',
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
  readonly schema3SourceMigrationSha256: Sha256Hash;
  readonly schema3SourceSqliteSchemaIdentity: Sha256Hash;
  readonly schema4SourceMigrationSha256: Sha256Hash;
  readonly schema4SourceSqliteSchemaIdentity: Sha256Hash;
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
    FROZEN_G1_1_IDENTITIES.profile,
    'icarus.sqlite-execution-profile/1',
    'SQLite Profile',
  );
  const profile = parseSQLiteExecutionProfilePayload(profileArtifact.payload);

  const dependencyManifestArtifact = readArtifact(
    schemaRoot,
    'artifacts/workflow-runtime-schema-dependency-manifest@1.json',
  );
  expectArtifact(
    dependencyManifestArtifact,
    FROZEN_G1_1_IDENTITIES.dependencyManifest,
    'icarus.workflow-runtime-schema-dependency-manifest/1',
    'G1 Schema Dependency Manifest',
  );
  const dependencyManifest =
    dependencyManifestArtifact.payload as unknown as G1SchemaDependencyManifestPayload;
  assertClosedSchemaDependencyManifest(dependencyManifest);
  if (
    dependencyManifest.physical_schema_identity !==
    FROZEN_G1_1_IDENTITIES.physicalSchema
  ) {
    throw new Error('G1 physical schema identity drifted');
  }

  const root = readArtifact(
    schemaRoot,
    'contract-pack-g1-executable-schema.json',
  );
  expectArtifact(
    root,
    FROZEN_G1_1_IDENTITIES.root,
    'icarus.workflow-contract-pack-g1-executable-schema/1',
    'G1.1 root',
  );
  const rootPayload = root.payload;
  if (
    rootPayload.schema_dependency_manifest_hash !==
      FROZEN_G1_1_IDENTITIES.dependencyManifest ||
    rootPayload.physical_schema_identity !==
      FROZEN_G1_1_IDENTITIES.physicalSchema ||
    rootPayload.schema_hash !== FROZEN_G1_1_IDENTITIES.schema ||
    rootPayload.migration_sha256 !== FROZEN_G1_1_IDENTITIES.migration ||
    rootPayload.schema3_to_schema4_upgrade_sha256 !==
      FROZEN_G1_1_IDENTITIES.schema3To4Upgrade ||
    rootPayload.schema4_to_schema5_upgrade_sha256 !==
      FROZEN_G1_1_IDENTITIES.schema4To5Upgrade ||
    rootPayload.schema3_source_migration_sha256 !==
      FROZEN_G1_1_IDENTITIES.schema3SourceMigration ||
    rootPayload.schema3_source_sqlite_schema_identity !==
      FROZEN_G1_1_IDENTITIES.schema3SourceSqliteSchema ||
    rootPayload.schema4_source_migration_sha256 !==
      FROZEN_G1_1_IDENTITIES.schema4SourceMigration ||
    rootPayload.schema4_source_sqlite_schema_identity !==
      FROZEN_G1_1_IDENTITIES.schema4SourceSqliteSchema ||
    rootPayload.sqlite_schema_identity !==
      FROZEN_G1_1_IDENTITIES.sqliteSchema ||
    rootPayload.deterministic_digest !== FROZEN_G1_1_IDENTITIES.deterministic ||
    rootPayload.sqlite_profile_status !== 'candidate' ||
    rootPayload.certification_status !== 'not_certified'
  ) {
    throw new Error('G1.1 root payload drifted from the frozen Store input');
  }

  const executableDdl = readArtifact(
    schemaRoot,
    'artifacts/workflow-runtime-executable-ddl@1.json',
  );
  expectArtifact(
    executableDdl,
    FROZEN_G1_1_IDENTITIES.executableDdl,
    'icarus.workflow-runtime-executable-ddl/1',
    'G1.1 executable DDL',
  );
  if (
    executableDdl.payload.schema_hash !== FROZEN_G1_1_IDENTITIES.schema ||
    executableDdl.payload.migration_sha256 !==
      FROZEN_G1_1_IDENTITIES.migration ||
    executableDdl.payload.database_schema_version !== 5 ||
    executableDdl.payload.schema3_upgrade_mode !==
      'empty_activation_state_only_or_fail_closed' ||
    executableDdl.payload.schema4_upgrade_mode !==
      'rebuild_capacity_invocations_preserve_all_rows_or_fail_closed'
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
  const schema4SourceMigrationSha256 = parseSha256Hash(
    executableDdl.payload.schema4_source_migration_sha256,
  );
  const schema4SourceSqliteSchemaIdentity = parseSha256Hash(
    executableDdl.payload.schema4_source_sqlite_schema_identity,
  );
  if (
    schema3To4UpgradeSha256 !== FROZEN_G1_1_IDENTITIES.schema3To4Upgrade ||
    schema4To5UpgradeSha256 !== FROZEN_G1_1_IDENTITIES.schema4To5Upgrade ||
    schema3SourceMigrationSha256 !==
      FROZEN_G1_1_IDENTITIES.schema3SourceMigration ||
    schema3SourceSqliteSchemaIdentity !==
      FROZEN_G1_1_IDENTITIES.schema3SourceSqliteSchema ||
    schema4SourceMigrationSha256 !==
      FROZEN_G1_1_IDENTITIES.schema4SourceMigration ||
    schema4SourceSqliteSchemaIdentity !==
      FROZEN_G1_1_IDENTITIES.schema4SourceSqliteSchema ||
    sqliteSchemaIdentity !== FROZEN_G1_1_IDENTITIES.sqliteSchema
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
    'artifacts/workflow-runtime-schema-manifest@1.json',
  );
  expectArtifact(
    manifestArtifact,
    FROZEN_G1_1_IDENTITIES.manifest,
    'icarus.workflow-runtime-schema-manifest/1',
    'G1.1 Schema Manifest',
  );
  const manifest =
    manifestArtifact.payload as unknown as WorkflowRuntimeSchemaManifestPayload;
  assertClosedSchemaManifest(manifest);
  if (
    manifest.schema_hash !== FROZEN_G1_1_IDENTITIES.schema ||
    manifest.migration_sha256 !== FROZEN_G1_1_IDENTITIES.migration ||
    manifest.database_name !== 'workflow-runtime.db'
  ) {
    throw new Error('G1.1 Schema Manifest payload drifted');
  }
  if (
    calculateManifestSqliteSchemaIdentity(manifest) !== sqliteSchemaIdentity
  ) {
    throw new Error('G1.1 Schema Manifest SQLite identity drifted');
  }

  const migrationBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v1.sql'),
  );
  const migrationSha256 = rawSha256(migrationBytes);
  if (migrationSha256 !== FROZEN_G1_1_IDENTITIES.migration) {
    throw new Error(
      `G1.1 migration drifted: expected ${FROZEN_G1_1_IDENTITIES.migration}, received ${migrationSha256}`,
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
  const memberHash = (role: string): Sha256Hash | undefined =>
    dependencyManifest.members.find((member) => member.role === role)
      ?.raw_sha256;
  if (
    memberHash('schema_manifest') !==
      rawSha256(
        fs.readFileSync(
          path.join(
            schemaRoot,
            'artifacts/workflow-runtime-schema-manifest@1.json',
          ),
        ),
      ) ||
    memberHash('canonical_migration') !== migrationSha256 ||
    memberHash('schema3_to_schema4_upgrade') !== observedUpgradeSha256 ||
    memberHash('schema4_to_schema5_upgrade') !==
      observedSchema4To5UpgradeSha256 ||
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
    schema3SourceMigrationSha256,
    schema3SourceSqliteSchemaIdentity,
    schema4SourceMigrationSha256,
    schema4SourceSqliteSchemaIdentity,
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
