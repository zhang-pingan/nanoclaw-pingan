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
import { verifySchemaDependencyManifestArtifact } from '../schema/dependencies.js';
import { assertClosedSchemaManifest } from '../schema/manifest.js';
import type {
  G1SchemaDependencyManifestPayload,
  WorkflowRuntimeSchemaManifestPayload,
} from '../schema/types.js';

export const FROZEN_G1_1_IDENTITIES = {
  root: 'sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756',
  dependencyManifest:
    'sha256:ea039f582f0ebff2fb9bc7e512825612cf8f0f93ccdd4c5e43345f56ca2b7b89',
  physicalSchema:
    'sha256:8c667d62f69a8c67ba1edde467562e370377342a058b6dc4673ab9a383fe05a1',
  schema:
    'sha256:4d8c373387ad515c36fd292b705665e6c197c73021c1b7e55da5317bc140efbd',
  migration:
    'sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61',
  deterministic:
    'sha256:f3dc5f3364a31c153cbf78ac0276d6467627c547e0939ac8e56e6f1ce8e65f15',
  manifest:
    'sha256:02e8d7511386c82458120d65ea6eb97f3ed26941abd757d2314e58ccc91fcb3b',
  executableDdl:
    'sha256:d25fdd25fee0d1cd579c7229237ad4dddd0f0a80779505012a6743b656b84ec5',
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
  const dependencyManifest = verifySchemaDependencyManifestArtifact(
    dependencyManifestArtifact,
    { contractsRoot, schemaRoot },
  );
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
    executableDdl.payload.migration_sha256 !== FROZEN_G1_1_IDENTITIES.migration
  ) {
    throw new Error('G1.1 executable DDL payload drifted');
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

  const migrationBytes = fs.readFileSync(
    path.join(schemaRoot, 'migration/workflow-runtime-schema-v1.sql'),
  );
  const migrationSha256 = rawSha256(migrationBytes);
  if (migrationSha256 !== FROZEN_G1_1_IDENTITIES.migration) {
    throw new Error(
      `G1.1 migration drifted: expected ${FROZEN_G1_1_IDENTITIES.migration}, received ${migrationSha256}`,
    );
  }

  return deepFreeze({
    profile,
    profileArtifactHash: profileArtifact.hash,
    migrationSql: migrationBytes.toString('utf8'),
    migrationSha256,
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
