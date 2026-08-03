import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  buildG9CapacityGenesisEvidence,
  readInstalledG9CapacityGenesisBootstrapBundle,
  type G9CapacityGenesisBootstrapBundle,
  type G9CapacityGenesisBootstrapMember,
} from '../contracts/g9-capacity-genesis-bootstrap.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  G9ActivationAuditAuthority,
  G9CapacityGenesisEvidenceIdentity,
} from '../contracts/g9-production-activation-types.js';
import type { JsonValue, Sha256Hash } from '../contracts/types.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';

const BOOTSTRAP_PROVENANCE = 'icarus.capacity-genesis-bootstrap/1' as const;
const EVIDENCE_PROVENANCE = 'icarus.production-activation/1' as const;

interface ValueRow extends Record<string, unknown> {
  id: string;
  storage_kind: string;
  inline_canonical_json: string | null;
  blob_hash: string | null;
  immutable_external_locator: string | null;
  expected_hash: string | null;
  content_hash: Sha256Hash;
  byte_length: number;
  media_type: string;
  schema_resource_id: string;
  schema_resource_hash: Sha256Hash;
  provenance_ref: string;
  retention_class: string;
  payload_state: string;
  payload_pruned_at_ms: number | null;
  created_at_ms: number;
  row_version: number;
}

interface ResourceRow extends Record<string, unknown> {
  id: string;
  resource_type: string;
  resource_id: string;
  resource_version: string;
  owner_core_ref: string | null;
  owner_feature_id: string | null;
  canonical_value_id: string;
  content_hash: Sha256Hash;
  publication_state: string;
  created_at_ms: number;
  published_at_ms: number | null;
  retired_at_ms: number | null;
  row_version: number;
}

interface DependencyRow extends Record<string, unknown> {
  resource_id: string;
  dependency_resource_id: string;
  dependency_kind: string;
  expected_content_hash: Sha256Hash;
}

interface ExistingDependencyRow extends DependencyRow {
  created_at_ms: number;
}

interface CapacityDependencyCommandRow extends Record<string, unknown> {
  reason_text_value_id: string | null;
  reason_text_hash: Sha256Hash | null;
  evidence_manifest_value_id: string;
  evidence_manifest_hash: Sha256Hash;
  canonical_result_value_id: string | null;
  canonical_result_hash: Sha256Hash | null;
}

function valueRow(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryAll'>
    | WorkflowRuntimeWriteTransaction,
  id: string,
): ValueRow | undefined {
  const rows = connection.queryAll<ValueRow>(
    `SELECT id, storage_kind, inline_canonical_json, blob_hash,
            immutable_external_locator, expected_hash, content_hash, byte_length,
            media_type, schema_resource_id, schema_resource_hash, provenance_ref,
            retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
            row_version
       FROM workflow_values WHERE id = ?`,
    [id],
  );
  if (rows.length > 1)
    throw new Error('capacity_bootstrap_value_identity_collision');
  return rows[0];
}

function resourceRow(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryAll'>
    | WorkflowRuntimeWriteTransaction,
  member: G9CapacityGenesisBootstrapMember,
): ResourceRow | undefined {
  const resource = member.resource;
  const rows = connection.queryAll<ResourceRow>(
    `SELECT id, resource_type, resource_id, resource_version, owner_core_ref,
            owner_feature_id, canonical_value_id, content_hash, publication_state,
            created_at_ms, published_at_ms, retired_at_ms, row_version
       FROM workflow_registry_resources
      WHERE id = ? OR (resource_type = ? AND resource_id = ? AND resource_version = ?)`,
    [
      member.resource_row_id,
      resource.resource_type,
      resource.ref.id,
      resource.ref.version,
    ],
  );
  if (rows.length > 1)
    throw new Error('capacity_bootstrap_resource_identity_collision');
  return rows[0];
}

function exactValue(
  row: ValueRow,
  expected: {
    readonly id: string;
    readonly content: JsonValue;
    readonly hash: Sha256Hash;
    readonly schemaResourceId: string;
    readonly schemaResourceHash: Sha256Hash;
    readonly provenance: string;
    readonly retention: 'pinned' | 'workflow_audit';
  },
): boolean {
  const canonical = canonicalJson(expected.content);
  return (
    row.id === expected.id &&
    row.storage_kind === 'inline' &&
    row.inline_canonical_json === canonical &&
    row.blob_hash === null &&
    row.immutable_external_locator === null &&
    row.expected_hash === null &&
    row.content_hash === expected.hash &&
    row.byte_length === Buffer.byteLength(canonical, 'utf8') &&
    row.media_type === 'application/json' &&
    row.schema_resource_id === expected.schemaResourceId &&
    row.schema_resource_hash === expected.schemaResourceHash &&
    row.provenance_ref === expected.provenance &&
    row.retention_class === expected.retention &&
    row.payload_state === 'live' &&
    row.payload_pruned_at_ms === null &&
    row.row_version === 1
  );
}

function exactResource(
  row: ResourceRow,
  member: G9CapacityGenesisBootstrapMember,
): boolean {
  const resource = member.resource;
  if (resource.owner.kind !== 'core') return false;
  const expectedOwnerCoreRef = `${resource.owner.ref.id}@${resource.owner.ref.version}`;
  return (
    row.id === member.resource_row_id &&
    row.resource_type === resource.resource_type &&
    row.resource_id === resource.ref.id &&
    row.resource_version === resource.ref.version &&
    row.owner_core_ref === expectedOwnerCoreRef &&
    row.owner_feature_id === null &&
    row.canonical_value_id === member.canonical_value_id &&
    row.content_hash === resource.content_hash &&
    row.publication_state === 'published' &&
    row.published_at_ms !== null &&
    row.retired_at_ms === null &&
    row.row_version === 1
  );
}

function expectedDependencies(
  member: G9CapacityGenesisBootstrapMember,
): DependencyRow[] {
  return member.resource.dependencies.map((dependency) => ({
    resource_id: member.resource_row_id,
    dependency_resource_id: `registry-resource:${dependency.resource_type}:${dependency.ref.id}@${dependency.ref.version}`,
    dependency_kind: dependency.dependency_kind,
    expected_content_hash: dependency.content_hash,
  }));
}

function observedDependencies(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryAll'>
    | WorkflowRuntimeWriteTransaction,
  member: G9CapacityGenesisBootstrapMember,
): DependencyRow[] {
  return connection.queryAll<DependencyRow>(
    `SELECT resource_id, dependency_resource_id, dependency_kind,
            expected_content_hash
       FROM workflow_registry_resource_dependencies
      WHERE resource_id = ?
      ORDER BY dependency_resource_id COLLATE BINARY, dependency_kind COLLATE BINARY`,
    [member.resource_row_id],
  );
}

function exactDependencies(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryAll'>
    | WorkflowRuntimeWriteTransaction,
  member: G9CapacityGenesisBootstrapMember,
): boolean {
  const rows = observedDependencies(connection, member);
  return (
    canonicalJson(rows as unknown as JsonValue) ===
    canonicalJson(expectedDependencies(member) as unknown as JsonValue)
  );
}

function memberState(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryAll'>
    | WorkflowRuntimeWriteTransaction,
  member: G9CapacityGenesisBootstrapMember,
): 'absent' | 'exact' {
  const value = valueRow(connection, member.canonical_value_id);
  const resource = resourceRow(connection, member);
  if (!value && !resource) {
    if (observedDependencies(connection, member).length !== 0)
      throw new Error('capacity_bootstrap_dependency_identity_collision');
    return 'absent';
  }
  if (
    !value ||
    !resource ||
    !exactValue(value, {
      id: member.canonical_value_id,
      content: member.resource.content,
      hash: member.resource.content_hash,
      schemaResourceId: `registry-resource:schema:${member.resource.schema_ref.id}@${member.resource.schema_ref.version}`,
      schemaResourceHash: member.resource.schema_hash,
      provenance: BOOTSTRAP_PROVENANCE,
      retention: 'pinned',
    }) ||
    !exactResource(resource, member) ||
    !exactDependencies(connection, member)
  )
    throw new Error('capacity_bootstrap_member_identity_collision');
  return 'exact';
}

function bundleState(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryAll'>
    | WorkflowRuntimeWriteTransaction,
  bundle: G9CapacityGenesisBootstrapBundle,
): 'absent' | 'exact' {
  const states = bundle.members.map((member) =>
    memberState(connection, member),
  );
  if (states.every((state) => state === 'absent')) return 'absent';
  if (states.every((state) => state === 'exact')) return 'exact';
  throw new Error('capacity_bootstrap_partial_authority');
}

function insertValue(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly id: string;
    readonly content: JsonValue;
    readonly hash: Sha256Hash;
    readonly schemaResourceId: string;
    readonly schemaResourceHash: Sha256Hash;
    readonly provenance: string;
    readonly retention: 'pinned' | 'workflow_audit';
    readonly createdAtMs: number;
  },
): void {
  const canonical = canonicalJson(input.content);
  transaction.execute(
    `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version
     ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
               ?, ?, ?, ?, 'live', NULL, ?, 1)`,
    [
      input.id,
      canonical,
      input.hash,
      Buffer.byteLength(canonical, 'utf8'),
      input.schemaResourceId,
      input.schemaResourceHash,
      input.provenance,
      input.retention,
      input.createdAtMs,
    ],
  );
}

function insertMemberResource(
  transaction: WorkflowRuntimeWriteTransaction,
  member: G9CapacityGenesisBootstrapMember,
  installedAtMs: number,
): void {
  const resource = member.resource;
  if (resource.owner.kind !== 'core')
    throw new Error('capacity_bootstrap_owner_invalid');
  transaction.execute(
    `INSERT INTO workflow_registry_resources (
       id, resource_type, resource_id, resource_version, owner_core_ref,
       owner_feature_id, canonical_value_id, content_hash, publication_state,
       created_at_ms, published_at_ms, retired_at_ms, row_version
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'published', ?, ?, NULL, 1)`,
    [
      member.resource_row_id,
      resource.resource_type,
      resource.ref.id,
      resource.ref.version,
      `${resource.owner.ref.id}@${resource.owner.ref.version}`,
      member.canonical_value_id,
      resource.content_hash,
      installedAtMs,
      installedAtMs,
    ],
  );
}

export interface G9CapacityGenesisBootstrapPreparation {
  readonly bundle: G9CapacityGenesisBootstrapBundle;
  readonly evidence: G9CapacityGenesisEvidenceIdentity;
}

export function prepareG9CapacityGenesisBootstrap(input: {
  readonly releaseRoot: string;
  readonly bundleHash: Sha256Hash;
  readonly releaseArtifactHash: Sha256Hash;
  readonly baselineConfigHash: Sha256Hash;
  readonly auditAuthority: G9ActivationAuditAuthority;
}): G9CapacityGenesisBootstrapPreparation {
  const bundle = readInstalledG9CapacityGenesisBootstrapBundle(
    input.releaseRoot,
    input.bundleHash,
  );
  const evidence = buildG9CapacityGenesisEvidence({
    core_release_artifact_hash: input.releaseArtifactHash,
    baseline_config_hash: input.baselineConfigHash,
    activation_audit_authority_hash: input.auditAuthority.authority_hash,
  });
  const evidenceSchema = bundle.members[2]!.resource.content;
  const validateEvidence = new Ajv2020({
    strict: true,
    allErrors: true,
  }).compile(evidenceSchema as AnySchema);
  if (!validateEvidence(evidence.document))
    throw new Error('capacity_genesis_evidence_schema_invalid');
  return { bundle, evidence };
}

export function assertG9CapacityGenesisBootstrapAuthority(
  store: WorkflowRuntimeStore,
  preparation: G9CapacityGenesisBootstrapPreparation,
): void {
  if (bundleState(store, preparation.bundle) !== 'exact')
    throw new Error('capacity_bootstrap_authority_missing');
  const evidence = valueRow(store, preparation.evidence.value_id);
  if (
    !evidence ||
    !exactValue(evidence, {
      id: preparation.evidence.value_id,
      content: preparation.evidence.document as unknown as JsonValue,
      hash: preparation.evidence.value_hash,
      schemaResourceId: preparation.bundle.evidence_contract.schema_resource_id,
      schemaResourceHash: preparation.bundle.evidence_contract.schema_hash,
      provenance: EVIDENCE_PROVENANCE,
      retention: 'workflow_audit',
    })
  )
    throw new Error('capacity_genesis_evidence_authority_missing');
}

export function installG9CapacityGenesisBootstrapAuthority(
  store: WorkflowRuntimeStore,
  preparation: G9CapacityGenesisBootstrapPreparation,
  installedAtMs: number,
): 'installed' | 'exact_reuse' {
  const bundleDisposition = store.withImmediateTransaction((transaction) => {
    const state = bundleState(transaction, preparation.bundle);
    if (state === 'exact') return 'exact_reuse' as const;
    for (const member of preparation.bundle.members) {
      insertValue(transaction, {
        id: member.canonical_value_id,
        content: member.resource.content,
        hash: member.resource.content_hash,
        schemaResourceId: `registry-resource:schema:${member.resource.schema_ref.id}@${member.resource.schema_ref.version}`,
        schemaResourceHash: member.resource.schema_hash,
        provenance: BOOTSTRAP_PROVENANCE,
        retention: 'pinned',
        createdAtMs: installedAtMs,
      });
      insertMemberResource(transaction, member, installedAtMs);
    }
    for (const member of preparation.bundle.members) {
      for (const dependency of expectedDependencies(member)) {
        transaction.execute(
          `INSERT INTO workflow_registry_resource_dependencies (
             resource_id, dependency_resource_id, dependency_kind,
             expected_content_hash, created_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            dependency.resource_id,
            dependency.dependency_resource_id,
            dependency.dependency_kind,
            dependency.expected_content_hash,
            installedAtMs,
          ],
        );
      }
    }
    return 'installed' as const;
  });

  store.withImmediateTransaction((transaction) => {
    const existing = valueRow(transaction, preparation.evidence.value_id);
    const expected = {
      id: preparation.evidence.value_id,
      content: preparation.evidence.document as unknown as JsonValue,
      hash: preparation.evidence.value_hash,
      schemaResourceId: preparation.bundle.evidence_contract.schema_resource_id,
      schemaResourceHash: preparation.bundle.evidence_contract.schema_hash,
      provenance: EVIDENCE_PROVENANCE,
      retention: 'workflow_audit' as const,
    };
    if (existing) {
      if (!exactValue(existing, expected))
        throw new Error('capacity_genesis_evidence_identity_collision');
      return;
    }
    insertValue(transaction, {
      ...expected,
      createdAtMs: installedAtMs + 1,
    });
  });
  assertG9CapacityGenesisBootstrapAuthority(store, preparation);
  return bundleDisposition;
}

function queryOneExact<T extends Record<string, unknown>>(
  store: WorkflowRuntimeStore,
  sql: string,
  parameters: readonly WorkflowRuntimeSqlValue[],
  label: string,
): T {
  const rows = store.queryAll<T>(sql, parameters);
  if (rows.length !== 1) throw new Error(`${label}_identity_invalid`);
  return rows[0]!;
}

export function calculateExistingCapacityDependencyObjectsHash(
  store: WorkflowRuntimeStore,
  currentChangeId: string,
): Sha256Hash {
  const command = queryOneExact<CapacityDependencyCommandRow>(
    store,
    `SELECT reason_text_value_id, reason_text_hash,
            evidence_manifest_value_id, evidence_manifest_hash,
            canonical_result_value_id, canonical_result_hash
       FROM runtime_capacity_admin_commands WHERE assigned_change_id = ?`,
    [currentChangeId],
    'existing_capacity_command',
  );
  const valueBindings: ReadonlyArray<
    readonly [string | null, Sha256Hash | null]
  > = [
    [command.reason_text_value_id, command.reason_text_hash],
    [command.evidence_manifest_value_id, command.evidence_manifest_hash],
    [command.canonical_result_value_id, command.canonical_result_hash],
  ];
  const values = new Map<string, ValueRow>();
  const expectedResourceHashes = new Map<string, Sha256Hash>();
  const pending = new Set<string>();

  const bindResource = (id: string, expectedHash: Sha256Hash): void => {
    const bound = expectedResourceHashes.get(id);
    if (bound !== undefined && bound !== expectedHash)
      throw new Error('existing_capacity_schema_binding_conflict');
    expectedResourceHashes.set(id, expectedHash);
    pending.add(id);
  };
  const loadValue = (
    id: string,
    expectedHash: Sha256Hash,
    label: string,
  ): ValueRow => {
    const loaded = values.get(id);
    if (loaded) {
      if (loaded.content_hash !== expectedHash)
        throw new Error('existing_capacity_value_hash_invalid');
      return loaded;
    }
    const row = queryOneExact<ValueRow>(
      store,
      `SELECT id, storage_kind, inline_canonical_json, blob_hash,
              immutable_external_locator, expected_hash, content_hash, byte_length,
              media_type, schema_resource_id, schema_resource_hash, provenance_ref,
              retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
              row_version
         FROM workflow_values WHERE id = ?`,
      [id],
      label,
    );
    if (row.content_hash !== expectedHash)
      throw new Error('existing_capacity_value_hash_invalid');
    values.set(row.id, row);
    bindResource(row.schema_resource_id, row.schema_resource_hash);
    return row;
  };
  for (const [id, expectedHash] of valueBindings) {
    if ((id === null) !== (expectedHash === null))
      throw new Error('existing_capacity_value_binding_incomplete');
    if (id !== null && expectedHash !== null)
      loadValue(id, expectedHash, 'existing_capacity_value');
  }

  const resources: ResourceRow[] = [];
  const dependencies: ExistingDependencyRow[] = [];
  const visited = new Set<string>();
  while (pending.size > 0) {
    const id = [...pending].sort()[0]!;
    pending.delete(id);
    if (visited.has(id)) continue;
    visited.add(id);
    const resource = queryOneExact<ResourceRow>(
      store,
      `SELECT id, resource_type, resource_id, resource_version, owner_core_ref,
              owner_feature_id, canonical_value_id, content_hash,
              publication_state, created_at_ms, published_at_ms, retired_at_ms,
              row_version
         FROM workflow_registry_resources WHERE id = ?`,
      [id],
      'existing_capacity_schema_resource',
    );
    if (resource.content_hash !== expectedResourceHashes.get(id))
      throw new Error('existing_capacity_schema_resource_hash_invalid');
    resources.push(resource);
    loadValue(
      resource.canonical_value_id,
      resource.content_hash,
      'existing_capacity_schema_value',
    );
    const rows = store.queryAll<ExistingDependencyRow>(
      `SELECT resource_id, dependency_resource_id, dependency_kind,
              expected_content_hash, created_at_ms
         FROM workflow_registry_resource_dependencies WHERE resource_id = ?
         ORDER BY dependency_resource_id COLLATE BINARY,
                  dependency_kind COLLATE BINARY`,
      [id],
    );
    for (const dependency of rows) {
      dependencies.push(dependency);
      bindResource(
        dependency.dependency_resource_id,
        dependency.expected_content_hash,
      );
    }
  }
  return domainSeparatedSha256(
    'icarus:g9-existing-capacity-dependency-objects:1\n',
    {
      values: [...values.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      resources: resources.sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      dependencies: dependencies.sort((left, right) =>
        `${left.resource_id}\0${left.dependency_resource_id}`.localeCompare(
          `${right.resource_id}\0${right.dependency_resource_id}`,
        ),
      ),
    } as unknown as JsonValue,
  );
}
