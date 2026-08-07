import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { canonicalJson } from '../contracts/hash.js';
import { strictParseJsonBytes } from '../contracts/strict-json.js';
import type { JsonObject } from '../contracts/types.js';
import {
  calculateClosureManifestHash,
  calculateDependencyClosureHash,
  calculateRegistryResourceContentHash,
  calculateRegistrySnapshotHash,
  compareAscii,
  G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA,
  registryClosureId,
  registryClosureValueId,
  registryResourceId,
  registrySnapshotId,
  registryValueId,
  validateRegistryPersistenceBatch,
  type G3RegistryPersistenceContractError,
} from '../contracts/g3-registry-persistence.js';
import type {
  G3RegistryDependencyClosureManifest,
  G3RegistryPersistenceBatch,
  G3RegistryResourceIdentity,
  G3RegistryResourceRecord,
  G3RegistrySnapshot,
  G3RegistrySnapshotPreflightInput,
  G3RegistrySnapshotPreflightResult,
} from '../contracts/g3-registry-persistence-types.js';
import type {
  WorkflowRuntimeReadConnection,
  WorkflowRuntimeStore,
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeWriteTransaction,
} from './runtime-store/index.js';

export interface RegistryPersistenceStore {
  withImmediateTransaction<T>(
    callback: (transaction: WorkflowRuntimeWriteTransaction) => T,
  ): T;
  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[];
  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined;
}

export type RegistryPersistenceReadConnection = Pick<
  WorkflowRuntimeReadConnection,
  'queryAll' | 'queryOne'
>;

export class RegistryPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'RegistryPersistenceError';
  }
}

export interface RegistryPersistenceReceipt {
  readonly disposition: 'inserted' | 'exact_replay';
  readonly resource_ids: string[];
  readonly closure_id: string;
  readonly snapshot_id: string;
  readonly resource_count: number;
  readonly member_count: number;
}

export const REGISTRY_IMMUTABLE_COLLISION_CODES = [
  'registry_value_identity_collision',
  'registry_resource_identity_collision',
  'registry_dependency_set_collision',
  'registry_closure_identity_collision',
  'registry_closure_member_set_collision',
  'registry_snapshot_identity_collision',
] as const;

export type RegistryImmutableCollisionCode =
  (typeof REGISTRY_IMMUTABLE_COLLISION_CODES)[number];

const PROVENANCE_REF = 'icarus.workflow-registry-persistence/1';
const validateSnapshotPreflightInput = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
}).compile(G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA as AnySchema);

interface ImmutableValueRow extends Record<string, unknown> {
  id: string;
  storage_kind: string;
  inline_canonical_json: string | null;
  blob_hash: string | null;
  immutable_external_locator: string | null;
  expected_hash: string | null;
  content_hash: string;
  byte_length: number;
  media_type: string;
  schema_resource_id: string;
  schema_resource_hash: string;
  provenance_ref: string;
  retention_class: string;
  payload_state: string;
  payload_pruned_at_ms: number | null;
  row_version: number;
}

interface ImmutableResourceRow extends Record<string, unknown> {
  id: string;
  resource_type: string;
  resource_id: string;
  resource_version: string;
  owner_core_ref: string | null;
  owner_feature_id: string | null;
  owner_principal_ref: string | null;
  canonical_value_id: string;
  content_hash: string;
  publication_state: string;
  published_at_ms: number | null;
  retired_at_ms: number | null;
  row_version: number;
}

interface ImmutableDependencyRow extends Record<string, unknown> {
  resource_id: string;
  dependency_resource_id: string;
  dependency_kind: string;
  expected_content_hash: string;
}

interface ImmutableClosureRow extends Record<string, unknown> {
  id: string;
  closure_hash: string;
  manifest_value_id: string;
  manifest_hash: string;
}

interface ImmutableClosureMemberRow extends Record<string, unknown> {
  closure_manifest_id: string;
  resource_id: string;
  resource_type: string;
  content_hash: string;
  member_index: number;
}

interface ImmutableSnapshotRow extends Record<string, unknown> {
  id: string;
  snapshot_hash: string;
  closure_manifest_id: string;
  closure_hash: string;
  compiler_version: string;
}

interface RegistryPersistenceInsertPlan {
  valueIds: Set<string>;
  resourceIds: Set<string>;
  closureValue: boolean;
  closure: boolean;
  snapshot: boolean;
}

function immutableCollision(
  code: RegistryImmutableCollisionCode,
  identity: string,
): never {
  throw new RegistryPersistenceError(
    code,
    `Immutable Registry identity collision at ${identity}`,
  );
}

function valueNeedsInsert(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  content: JsonObject,
  contentHash: string,
  schemaRef: { id: string; version: string },
  schemaHash: string,
): boolean {
  const rows = transaction.queryAll<ImmutableValueRow>(
    `SELECT id, storage_kind, inline_canonical_json, blob_hash,
            immutable_external_locator, expected_hash, content_hash, byte_length,
            media_type, schema_resource_id, schema_resource_hash, provenance_ref,
            retention_class, payload_state, payload_pruned_at_ms, row_version
       FROM workflow_values WHERE id = ?`,
    [valueId],
  );
  if (rows.length === 0) return true;
  if (rows.length !== 1)
    return immutableCollision('registry_value_identity_collision', valueId);
  const row = rows[0];
  const canonical = canonicalJson(content);
  if (
    row.id !== valueId ||
    row.storage_kind !== 'inline' ||
    row.inline_canonical_json !== canonical ||
    row.blob_hash !== null ||
    row.immutable_external_locator !== null ||
    row.expected_hash !== null ||
    row.content_hash !== contentHash ||
    row.byte_length !== Buffer.byteLength(canonical, 'utf8') ||
    row.media_type !== 'application/json' ||
    row.schema_resource_id !==
      registryResourceId({ resource_type: 'schema', ref: schemaRef }) ||
    row.schema_resource_hash !== schemaHash ||
    row.provenance_ref !== PROVENANCE_REF ||
    row.retention_class !== 'pinned' ||
    row.payload_state !== 'live' ||
    row.payload_pruned_at_ms !== null ||
    row.row_version !== 1
  ) {
    return immutableCollision('registry_value_identity_collision', valueId);
  }
  return false;
}

function resourceNeedsInsert(
  transaction: WorkflowRuntimeWriteTransaction,
  resource: G3RegistryResourceRecord,
): boolean {
  const id = registryResourceId(resource);
  const rows = transaction.queryAll<ImmutableResourceRow>(
    `SELECT id, resource_type, resource_id, resource_version, owner_core_ref,
            owner_feature_id, owner_principal_ref, canonical_value_id, content_hash, publication_state,
            published_at_ms, retired_at_ms, row_version
       FROM workflow_registry_resources
      WHERE id = ? OR (resource_type = ? AND resource_id = ? AND resource_version = ?)`,
    [id, resource.resource_type, resource.ref.id, resource.ref.version],
  );
  if (rows.length === 0) return true;
  const ownerCoreRef =
    resource.owner.kind === 'core'
      ? `${resource.owner.ref.id}@${resource.owner.ref.version}`
      : null;
  const ownerFeatureId =
    resource.owner.kind === 'feature' ? resource.owner.feature_id : null;
  const ownerPrincipalRef =
    resource.owner.kind === 'principal' ? resource.owner.principal_ref : null;
  if (
    rows.length !== 1 ||
    rows[0].id !== id ||
    rows[0].resource_type !== resource.resource_type ||
    rows[0].resource_id !== resource.ref.id ||
    rows[0].resource_version !== resource.ref.version ||
    rows[0].owner_core_ref !== ownerCoreRef ||
    rows[0].owner_feature_id !== ownerFeatureId ||
    rows[0].owner_principal_ref !== ownerPrincipalRef ||
    rows[0].canonical_value_id !== registryValueId(resource) ||
    rows[0].content_hash !== resource.content_hash ||
    rows[0].publication_state !== 'staged' ||
    rows[0].published_at_ms !== null ||
    rows[0].retired_at_ms !== null ||
    rows[0].row_version !== 1
  ) {
    return immutableCollision('registry_resource_identity_collision', id);
  }
  return false;
}

function assertExactDependencies(
  transaction: WorkflowRuntimeWriteTransaction,
  resource: G3RegistryResourceRecord,
  resourceAbsent: boolean,
): void {
  const id = registryResourceId(resource);
  const rows = transaction.queryAll<ImmutableDependencyRow>(
    `SELECT resource_id, dependency_resource_id, dependency_kind, expected_content_hash
       FROM workflow_registry_resource_dependencies
      WHERE resource_id = ?
      ORDER BY dependency_resource_id COLLATE BINARY, dependency_kind COLLATE BINARY`,
    [id],
  );
  if (resourceAbsent) {
    if (rows.length !== 0)
      immutableCollision('registry_dependency_set_collision', id);
    return;
  }
  const expected = resource.dependencies
    .map((dependency) => ({
      resource_id: id,
      dependency_resource_id: registryResourceId(dependency),
      dependency_kind: dependency.dependency_kind,
      expected_content_hash: dependency.content_hash,
    }))
    .sort((left, right) =>
      compareAscii(
        `${left.dependency_resource_id}\0${left.dependency_kind}`,
        `${right.dependency_resource_id}\0${right.dependency_kind}`,
      ),
    );
  const actual = rows.map((row) => ({
    resource_id: row.resource_id,
    dependency_resource_id: row.dependency_resource_id,
    dependency_kind: row.dependency_kind,
    expected_content_hash: row.expected_content_hash,
  }));
  if (canonicalJson(actual) !== canonicalJson(expected))
    immutableCollision('registry_dependency_set_collision', id);
}

function closureNeedsInsert(
  transaction: WorkflowRuntimeWriteTransaction,
  closure: G3RegistryDependencyClosureManifest,
): boolean {
  const id = registryClosureId(closure.ref);
  const rows = transaction.queryAll<ImmutableClosureRow>(
    `SELECT id, closure_hash, manifest_value_id, manifest_hash
       FROM workflow_registry_closure_manifests
      WHERE id = ? OR closure_hash = ?`,
    [id, closure.closure_hash],
  );
  if (rows.length === 0) return true;
  if (
    rows.length !== 1 ||
    rows[0].id !== id ||
    rows[0].closure_hash !== closure.closure_hash ||
    rows[0].manifest_value_id !== registryClosureValueId(closure.ref) ||
    rows[0].manifest_hash !== closure.manifest_hash
  ) {
    return immutableCollision('registry_closure_identity_collision', id);
  }
  return false;
}

function assertExactClosureMembers(
  transaction: WorkflowRuntimeWriteTransaction,
  closure: G3RegistryDependencyClosureManifest,
  closureAbsent: boolean,
): void {
  const id = registryClosureId(closure.ref);
  const rows = transaction.queryAll<ImmutableClosureMemberRow>(
    `SELECT closure_manifest_id, resource_id, resource_type, content_hash, member_index
       FROM workflow_registry_closure_members
      WHERE closure_manifest_id = ? ORDER BY member_index`,
    [id],
  );
  if (closureAbsent) {
    if (rows.length !== 0)
      immutableCollision('registry_closure_member_set_collision', id);
    return;
  }
  const expected = closure.members.map((member, memberIndex) => ({
    closure_manifest_id: id,
    resource_id: registryResourceId(member),
    resource_type: member.resource_type,
    content_hash: member.content_hash,
    member_index: memberIndex,
  }));
  const actual = rows.map((row) => ({
    closure_manifest_id: row.closure_manifest_id,
    resource_id: row.resource_id,
    resource_type: row.resource_type,
    content_hash: row.content_hash,
    member_index: row.member_index,
  }));
  if (canonicalJson(actual) !== canonicalJson(expected))
    immutableCollision('registry_closure_member_set_collision', id);
}

function snapshotNeedsInsert(
  transaction: WorkflowRuntimeWriteTransaction,
  snapshot: G3RegistrySnapshot,
): boolean {
  const id = registrySnapshotId(snapshot.ref);
  const rows = transaction.queryAll<ImmutableSnapshotRow>(
    `SELECT id, snapshot_hash, closure_manifest_id, closure_hash, compiler_version
       FROM workflow_registry_snapshots
      WHERE id = ? OR snapshot_hash = ?`,
    [id, snapshot.snapshot_hash],
  );
  if (rows.length === 0) return true;
  if (
    rows.length !== 1 ||
    rows[0].id !== id ||
    rows[0].snapshot_hash !== snapshot.snapshot_hash ||
    rows[0].closure_manifest_id !== registryClosureId(snapshot.closure_ref) ||
    rows[0].closure_hash !== snapshot.closure_hash ||
    rows[0].compiler_version !== snapshot.compiler_version
  ) {
    return immutableCollision('registry_snapshot_identity_collision', id);
  }
  return false;
}

function buildInsertPlan(
  transaction: WorkflowRuntimeWriteTransaction,
  batch: G3RegistryPersistenceBatch,
): RegistryPersistenceInsertPlan {
  const valueIds = new Set<string>();
  const resourceIds = new Set<string>();
  for (const resource of batch.resources) {
    const resourceAbsent = resourceNeedsInsert(transaction, resource);
    if (resourceAbsent) resourceIds.add(registryResourceId(resource));
    if (
      valueNeedsInsert(
        transaction,
        registryValueId(resource),
        resource.content,
        resource.content_hash,
        resource.schema_ref,
        resource.schema_hash,
      )
    ) {
      valueIds.add(registryValueId(resource));
    }
    assertExactDependencies(transaction, resource, resourceAbsent);
  }
  const closure = closureNeedsInsert(transaction, batch.closure);
  const closureValue = valueNeedsInsert(
    transaction,
    registryClosureValueId(batch.closure.ref),
    batch.closure,
    batch.closure.manifest_hash,
    batch.closure.schema_ref,
    batch.closure.schema_hash,
  );
  assertExactClosureMembers(transaction, batch.closure, closure);
  return {
    valueIds,
    resourceIds,
    closureValue,
    closure,
    snapshot: snapshotNeedsInsert(transaction, batch.snapshot),
  };
}

function resourceIdentity(
  resource: G3RegistryResourceRecord,
): G3RegistryResourceIdentity {
  return {
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
  };
}

function insertValue(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  content: JsonObject,
  contentHash: string,
  schemaRef: { id: string; version: string },
  schemaHash: string,
  createdAtMs: number,
): void {
  const canonical = canonicalJson(content);
  transaction.execute(
    `INSERT INTO workflow_values (
      id, storage_kind, inline_canonical_json, blob_hash, immutable_external_locator,
      expected_hash, content_hash, byte_length, media_type, schema_resource_id,
      schema_resource_hash, provenance_ref, retention_class, payload_state,
      payload_pruned_at_ms, created_at_ms, row_version
    ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json', ?, ?, ?, 'pinned', 'live', NULL, ?, 1)`,
    [
      valueId,
      canonical,
      contentHash,
      Buffer.byteLength(canonical, 'utf8'),
      registryResourceId({ resource_type: 'schema', ref: schemaRef }),
      schemaHash,
      PROVENANCE_REF,
      createdAtMs,
    ],
  );
}

function insertResource(
  transaction: WorkflowRuntimeWriteTransaction,
  resource: G3RegistryResourceRecord,
  createdAtMs: number,
): void {
  const id = registryResourceId(resource);
  const ownerCoreRef =
    resource.owner.kind === 'core'
      ? `${resource.owner.ref.id}@${resource.owner.ref.version}`
      : null;
  const ownerFeatureId =
    resource.owner.kind === 'feature' ? resource.owner.feature_id : null;
  const ownerPrincipalRef =
    resource.owner.kind === 'principal' ? resource.owner.principal_ref : null;
  transaction.execute(
    `INSERT INTO workflow_registry_resources (
      id, resource_type, resource_id, resource_version, owner_core_ref, owner_feature_id, owner_principal_ref,
      canonical_value_id, content_hash, publication_state, created_at_ms,
      published_at_ms, retired_at_ms, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, NULL, NULL, 1)`,
    [
      id,
      resource.resource_type,
      resource.ref.id,
      resource.ref.version,
      ownerCoreRef,
      ownerFeatureId,
      ownerPrincipalRef,
      registryValueId(resource),
      resource.content_hash,
      createdAtMs,
    ],
  );
}

function validatePersistenceBatch(batch: G3RegistryPersistenceBatch): void {
  try {
    validateRegistryPersistenceBatch(batch);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      throw new RegistryPersistenceError(
        String((error as G3RegistryPersistenceContractError).code),
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
}

export function persistRegistryPersistenceBatchInTransaction(
  transaction: WorkflowRuntimeWriteTransaction,
  batch: G3RegistryPersistenceBatch,
): RegistryPersistenceReceipt {
  validatePersistenceBatch(batch);
  const plan = buildInsertPlan(transaction, batch);
  for (const resource of batch.resources) {
    if (!plan.valueIds.has(registryValueId(resource))) continue;
    insertValue(
      transaction,
      registryValueId(resource),
      resource.content,
      resource.content_hash,
      resource.schema_ref,
      resource.schema_hash,
      batch.created_at_ms,
    );
  }
  for (const resource of batch.resources) {
    if (plan.resourceIds.has(registryResourceId(resource)))
      insertResource(transaction, resource, batch.created_at_ms);
  }
  for (const resource of batch.resources) {
    if (!plan.resourceIds.has(registryResourceId(resource))) continue;
    for (const dependency of resource.dependencies) {
      transaction.execute(
        `INSERT INTO workflow_registry_resource_dependencies (
            resource_id, dependency_resource_id, dependency_kind, expected_content_hash, created_at_ms
          ) VALUES (?, ?, ?, ?, ?)`,
        [
          registryResourceId(resource),
          registryResourceId(dependency),
          dependency.dependency_kind,
          dependency.content_hash,
          batch.created_at_ms,
        ],
      );
    }
  }
  if (plan.closureValue) {
    insertValue(
      transaction,
      registryClosureValueId(batch.closure.ref),
      batch.closure,
      batch.closure.manifest_hash,
      batch.closure.schema_ref,
      batch.closure.schema_hash,
      batch.created_at_ms,
    );
  }
  if (plan.closure) {
    transaction.execute(
      `INSERT INTO workflow_registry_closure_manifests (
          id, closure_hash, manifest_value_id, manifest_hash, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)`,
      [
        registryClosureId(batch.closure.ref),
        batch.closure.closure_hash,
        registryClosureValueId(batch.closure.ref),
        batch.closure.manifest_hash,
        batch.created_at_ms,
      ],
    );
    batch.closure.members.forEach((member, memberIndex) => {
      transaction.execute(
        `INSERT INTO workflow_registry_closure_members (
            closure_manifest_id, resource_id, resource_type, content_hash, member_index
          ) VALUES (?, ?, ?, ?, ?)`,
        [
          registryClosureId(batch.closure.ref),
          registryResourceId(member),
          member.resource_type,
          member.content_hash,
          memberIndex,
        ],
      );
    });
  }
  if (plan.snapshot) {
    transaction.execute(
      `INSERT INTO workflow_registry_snapshots (
          id, snapshot_hash, closure_manifest_id, closure_hash, compiler_version,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        registrySnapshotId(batch.snapshot.ref),
        batch.snapshot.snapshot_hash,
        registryClosureId(batch.snapshot.closure_ref),
        batch.snapshot.closure_hash,
        batch.snapshot.compiler_version,
        batch.created_at_ms,
      ],
    );
  }
  const inserted =
    plan.valueIds.size > 0 ||
    plan.resourceIds.size > 0 ||
    plan.closureValue ||
    plan.closure ||
    plan.snapshot;
  return {
    disposition: inserted ? 'inserted' : 'exact_replay',
    resource_ids: batch.resources.map(registryResourceId),
    closure_id: registryClosureId(batch.closure.ref),
    snapshot_id: registrySnapshotId(batch.snapshot.ref),
    resource_count: batch.resources.length,
    member_count: batch.closure.member_count,
  };
}

export function persistRegistryPersistenceBatch(
  store: RegistryPersistenceStore | WorkflowRuntimeStore,
  batch: G3RegistryPersistenceBatch,
): RegistryPersistenceReceipt {
  validatePersistenceBatch(batch);
  return store.withImmediateTransaction((transaction) =>
    persistRegistryPersistenceBatchInTransaction(transaction, batch),
  );
}

interface SnapshotRow extends Record<string, unknown> {
  id: string;
  snapshot_hash: string;
  closure_manifest_id: string;
  closure_hash: string;
  compiler_version: string;
}

interface ClosureRow extends Record<string, unknown> {
  id: string;
  closure_hash: string;
  manifest_value_id: string;
  manifest_hash: string;
}

interface ValueRow extends Record<string, unknown> {
  id: string;
  inline_canonical_json: string | null;
  content_hash: string;
}

interface ResourceRow extends Record<string, unknown> {
  id: string;
  resource_type: string;
  resource_id: string;
  resource_version: string;
  canonical_value_id: string;
  content_hash: string;
}

interface DependencyRow extends Record<string, unknown> {
  resource_id: string;
  dependency_resource_id: string;
  dependency_kind: string;
  expected_content_hash: string;
}

interface ClosureMemberRow extends Record<string, unknown> {
  resource_id: string;
  resource_type: string;
  content_hash: string;
  member_index: number;
}

function rejected(
  input: G3RegistrySnapshotPreflightInput,
  code: Exclude<G3RegistrySnapshotPreflightResult['code'], 'preflight_ok'>,
  closureHash: string | null = null,
  memberCount = 0,
): G3RegistrySnapshotPreflightResult {
  return {
    format: 'icarus.workflow-registry-snapshot-preflight-result/1',
    outcome: 'rejected',
    code,
    snapshot_ref: input.snapshot_ref,
    snapshot_hash: input.snapshot_hash,
    closure_hash:
      closureHash as G3RegistrySnapshotPreflightResult['closure_hash'],
    member_count: memberCount,
    read_only: true,
  };
}

function parseClosureValue(
  row: ValueRow,
): G3RegistryDependencyClosureManifest | null {
  if (row.inline_canonical_json === null) return null;
  try {
    const parsed = strictParseJsonBytes(
      Buffer.from(row.inline_canonical_json, 'utf8'),
    );
    if (
      canonicalJson(parsed) !== row.inline_canonical_json ||
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    )
      return null;
    return parsed as unknown as G3RegistryDependencyClosureManifest;
  } catch {
    return null;
  }
}

function verifyResourceValue(
  connection: RegistryPersistenceReadConnection,
  resource: ResourceRow,
): boolean {
  const value = connection.queryOne<ValueRow>(
    `SELECT id, inline_canonical_json, content_hash FROM workflow_values WHERE id = ?`,
    [resource.canonical_value_id],
  );
  if (
    !value ||
    value.inline_canonical_json === null ||
    value.content_hash !== resource.content_hash
  )
    return false;
  try {
    const content = strictParseJsonBytes(
      Buffer.from(value.inline_canonical_json, 'utf8'),
    );
    if (
      typeof content !== 'object' ||
      content === null ||
      Array.isArray(content) ||
      canonicalJson(content) !== value.inline_canonical_json
    )
      return false;
    return (
      calculateRegistryResourceContentHash({
        format: 'icarus.workflow-registry-resource/1',
        resource_type:
          resource.resource_type as G3RegistryResourceRecord['resource_type'],
        ref: { id: resource.resource_id, version: resource.resource_version },
        content,
      }) === resource.content_hash
    );
  } catch {
    return false;
  }
}

export function preflightRegistrySnapshot(
  connection: RegistryPersistenceReadConnection,
  input: G3RegistrySnapshotPreflightInput,
): G3RegistrySnapshotPreflightResult {
  if (!(validateSnapshotPreflightInput(input) as boolean)) {
    return {
      format: 'icarus.workflow-registry-snapshot-preflight-result/1',
      outcome: 'rejected',
      code: 'snapshot_schema_invalid',
      snapshot_ref: null,
      snapshot_hash: null,
      closure_hash: null,
      member_count: 0,
      read_only: true,
    };
  }
  const snapshotId = registrySnapshotId(input.snapshot_ref);
  const snapshot = connection.queryOne<SnapshotRow>(
    `SELECT id, snapshot_hash, closure_manifest_id, closure_hash, compiler_version
       FROM workflow_registry_snapshots WHERE id = ?`,
    [snapshotId],
  );
  if (!snapshot) return rejected(input, 'snapshot_missing');
  if (snapshot.id !== snapshotId)
    return rejected(input, 'snapshot_identity_mismatch');
  if (snapshot.snapshot_hash !== input.snapshot_hash)
    return rejected(input, 'snapshot_hash_mismatch');
  const closure = connection.queryOne<ClosureRow>(
    `SELECT id, closure_hash, manifest_value_id, manifest_hash
       FROM workflow_registry_closure_manifests WHERE id = ?`,
    [snapshot.closure_manifest_id],
  );
  if (!closure)
    return rejected(input, 'closure_missing', snapshot.closure_hash);
  const value = connection.queryOne<ValueRow>(
    `SELECT id, inline_canonical_json, content_hash FROM workflow_values WHERE id = ?`,
    [closure.manifest_value_id],
  );
  const manifest = value ? parseClosureValue(value) : null;
  if (
    !manifest ||
    !value ||
    value.content_hash !== closure.manifest_hash ||
    manifest.manifest_hash !== closure.manifest_hash
  ) {
    return rejected(
      input,
      'closure_manifest_hash_mismatch',
      closure.closure_hash,
    );
  }
  if (
    closure.id !== registryClosureId(manifest.ref) ||
    manifest.closure_hash !== closure.closure_hash
  ) {
    return rejected(input, 'closure_identity_mismatch', closure.closure_hash);
  }
  const manifestSchema = connection.queryOne<ResourceRow>(
    `SELECT id, resource_type, resource_id, resource_version, canonical_value_id, content_hash
       FROM workflow_registry_resources WHERE id = ?`,
    [registryResourceId({ resource_type: 'schema', ref: manifest.schema_ref })],
  );
  if (
    !manifestSchema ||
    manifestSchema.resource_type !== 'schema' ||
    manifestSchema.resource_id !== manifest.schema_ref.id ||
    manifestSchema.resource_version !== manifest.schema_ref.version ||
    manifestSchema.content_hash !== manifest.schema_hash ||
    !verifyResourceValue(connection, manifestSchema)
  ) {
    return rejected(input, 'resource_identity_mismatch', closure.closure_hash);
  }
  const snapshotForHash: Omit<G3RegistrySnapshot, 'snapshot_hash'> = {
    format: 'icarus.workflow-registry-snapshot/1',
    ref: input.snapshot_ref,
    closure_ref: manifest.ref,
    closure_hash: closure.closure_hash as G3SnapshotHash,
    compiler_version: snapshot.compiler_version,
  };
  if (calculateRegistrySnapshotHash(snapshotForHash) !== snapshot.snapshot_hash)
    return rejected(
      input,
      'snapshot_hash_mismatch',
      closure.closure_hash,
      manifest.member_count,
    );
  if (snapshot.compiler_version !== input.expected_compiler_version) {
    return rejected(
      input,
      'snapshot_binding_mismatch',
      closure.closure_hash,
      manifest.member_count,
    );
  }
  const memberRows = connection.queryAll<ClosureMemberRow>(
    `SELECT resource_id, resource_type, content_hash, member_index
       FROM workflow_registry_closure_members WHERE closure_manifest_id = ? ORDER BY member_index ASC`,
    [closure.id],
  );
  if (
    memberRows.length !== manifest.member_count ||
    memberRows.some((row, index) => row.member_index !== index)
  )
    return rejected(
      input,
      'closure_member_mismatch',
      closure.closure_hash,
      memberRows.length,
    );
  const resourceById = new Map<string, ResourceRow>();
  for (const member of memberRows) {
    const resource = connection.queryOne<ResourceRow>(
      `SELECT id, resource_type, resource_id, resource_version, canonical_value_id, content_hash
         FROM workflow_registry_resources WHERE id = ?`,
      [member.resource_id],
    );
    if (!resource)
      return rejected(
        input,
        'resource_missing',
        closure.closure_hash,
        memberRows.length,
      );
    if (
      resource.resource_type !== member.resource_type ||
      resource.content_hash !== member.content_hash
    )
      return rejected(
        input,
        'resource_hash_mismatch',
        closure.closure_hash,
        memberRows.length,
      );
    if (!verifyResourceValue(connection, resource))
      return rejected(
        input,
        'resource_hash_mismatch',
        closure.closure_hash,
        memberRows.length,
      );
    resourceById.set(resource.id, resource);
  }
  const expectedMembers = manifest.members.map((member) => {
    const resourceId = registryResourceId(member);
    const row = resourceById.get(resourceId);
    return row
      ? {
          resource_type: row.resource_type,
          ref: { id: row.resource_id, version: row.resource_version },
          content_hash: row.content_hash,
        }
      : null;
  });
  if (
    expectedMembers.some((entry) => entry === null) ||
    canonicalJson(expectedMembers) !== canonicalJson(manifest.members)
  )
    return rejected(
      input,
      'closure_member_mismatch',
      closure.closure_hash,
      memberRows.length,
    );
  const rootResource = connection.queryOne<ResourceRow>(
    `SELECT id, resource_type, resource_id, resource_version, canonical_value_id, content_hash
       FROM workflow_registry_resources WHERE id = ?`,
    [
      registryResourceId({
        resource_type: manifest.root_resource_type,
        ref: manifest.root_ref,
      }),
    ],
  );
  if (!rootResource)
    return rejected(
      input,
      'resource_missing',
      closure.closure_hash,
      memberRows.length,
    );
  if (
    rootResource.resource_type !== manifest.root_resource_type ||
    rootResource.resource_id !== manifest.root_ref.id ||
    rootResource.resource_version !== manifest.root_ref.version
  )
    return rejected(
      input,
      'resource_identity_mismatch',
      closure.closure_hash,
      memberRows.length,
    );
  if (!verifyResourceValue(connection, rootResource))
    return rejected(
      input,
      'resource_hash_mismatch',
      closure.closure_hash,
      memberRows.length,
    );
  const expected = new Map<string, G3RegistryResourceIdentity>();
  const visiting = new Set<string>();
  const visit = (
    resource: ResourceRow,
  ): G3RegistrySnapshotPreflightResult | null => {
    if (visiting.has(resource.id))
      return rejected(
        input,
        'dependency_cycle',
        closure.closure_hash,
        memberRows.length,
      );
    visiting.add(resource.id);
    const dependencies = connection.queryAll<DependencyRow>(
      `SELECT resource_id, dependency_resource_id, dependency_kind, expected_content_hash
         FROM workflow_registry_resource_dependencies WHERE resource_id = ? ORDER BY dependency_resource_id, dependency_kind`,
      [resource.id],
    );
    for (const dependency of dependencies) {
      if (dependency.dependency_kind !== 'registry_exact')
        return rejected(
          input,
          'snapshot_schema_invalid',
          closure.closure_hash,
          memberRows.length,
        );
      const target = connection.queryOne<ResourceRow>(
        `SELECT id, resource_type, resource_id, resource_version, canonical_value_id, content_hash
           FROM workflow_registry_resources WHERE id = ?`,
        [dependency.dependency_resource_id],
      );
      if (!target)
        return rejected(
          input,
          'dependency_missing',
          closure.closure_hash,
          memberRows.length,
        );
      if (target.content_hash !== dependency.expected_content_hash)
        return rejected(
          input,
          'dependency_hash_mismatch',
          closure.closure_hash,
          memberRows.length,
        );
      if (visiting.has(target.id))
        return rejected(
          input,
          'dependency_cycle',
          closure.closure_hash,
          memberRows.length,
        );
      if (!expected.has(target.id)) {
        expected.set(target.id, {
          resource_type:
            target.resource_type as G3RegistryResourceIdentity['resource_type'],
          ref: { id: target.resource_id, version: target.resource_version },
          content_hash:
            target.content_hash as G3RegistryResourceIdentity['content_hash'],
        });
        const result = visit(target);
        if (result) return result;
      }
    }
    visiting.delete(resource.id);
    return null;
  };
  const traversalResult = visit(rootResource);
  if (traversalResult) return traversalResult;
  const sortedExpected = [...expected.values()].sort((left, right) =>
    compareAscii(
      `${left.resource_type}\0${left.ref.id}@${left.ref.version}`,
      `${right.resource_type}\0${right.ref.id}@${right.ref.version}`,
    ),
  );
  if (canonicalJson(sortedExpected) !== canonicalJson(manifest.members))
    return rejected(
      input,
      'closure_member_mismatch',
      closure.closure_hash,
      memberRows.length,
    );
  const computedClosureHash = calculateDependencyClosureHash({
    root_resource_type: manifest.root_resource_type,
    root_ref: manifest.root_ref,
    members: manifest.members,
    member_count: manifest.member_count,
  });
  if (computedClosureHash !== closure.closure_hash)
    return rejected(
      input,
      'closure_hash_mismatch',
      closure.closure_hash,
      memberRows.length,
    );
  const computedManifestHash = calculateClosureManifestHash(manifest);
  if (computedManifestHash !== closure.manifest_hash)
    return rejected(
      input,
      'closure_manifest_hash_mismatch',
      closure.closure_hash,
      memberRows.length,
    );
  return {
    format: 'icarus.workflow-registry-snapshot-preflight-result/1',
    outcome: 'accepted',
    code: 'preflight_ok',
    snapshot_ref: input.snapshot_ref,
    snapshot_hash: input.snapshot_hash,
    closure_hash: closure.closure_hash as G3SnapshotHash,
    member_count: manifest.member_count,
    read_only: true,
  };
}

type G3SnapshotHash = `sha256:${string}`;
