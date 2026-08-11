import {
  buildDeploymentCapacityPublication,
  calculateCapacityAdminRequestHash,
} from '../contracts/capacity-control-plane-source.js';
import type { DeploymentRuntimeCapacitySnapshot } from '../contracts/capacity-control-plane-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { buildDeploymentRuntimeCapacityBaseline } from '../contracts/safety-sqlite-artifacts.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import { appendCapacityEvent } from './admin-gateway.js';

const SCHEMA_ROW_ID =
  'registry-resource:schema:icarus.local-capacity-defaults@1.0.0';
const SCHEMA_VALUE_ID =
  'registry-value:schema:icarus.local-capacity-defaults@1.0.0';
const DIAGNOSTIC_VALUE_ID = 'capacity-defaults-diagnostic:1';
const RESULT_VALUE_ID = 'capacity-defaults-result:1';
const COMMAND_ID = 'capacity-defaults-command:1';
const CHANGE_ID = 'capacity-defaults-change:1';

const LOCAL_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:local-capacity-defaults:1',
  title: 'Icarus Local Capacity Defaults',
  type: 'object',
  additionalProperties: true,
};

function hash(domain: string, content: JsonValue): Sha256Hash {
  return domainSeparatedSha256(domain, content);
}

function insertInlineValue(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly id: string;
    readonly content: JsonValue;
    readonly hash: Sha256Hash;
    readonly schemaHash: Sha256Hash;
    readonly createdAtMs: number;
    readonly retention: 'pinned' | 'workflow_audit';
  },
): void {
  const bytes = canonicalJson(input.content);
  transaction.execute(
    `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version
     ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
               ?, ?, 'icarus.local-capacity-defaults/1', ?, 'live', NULL, ?, 1)`,
    [
      input.id,
      bytes,
      input.hash,
      Buffer.byteLength(bytes, 'utf8'),
      SCHEMA_ROW_ID,
      input.schemaHash,
      input.retention,
      input.createdAtMs,
    ],
  );
}

export type EnsureCapacityDefaultsResult = 'initialized' | 'preserved';

export function ensureCapacityDefaults(
  store: WorkflowRuntimeStore,
  initializedAtMs = Date.now(),
): EnsureCapacityDefaultsResult {
  return store.withImmediateTransaction((transaction) => {
    const head = transaction.queryOne<Record<string, unknown>>(
      'SELECT * FROM runtime_capacity_head WHERE singleton_key = 1',
      [],
    );
    if (head) return 'preserved';

    const capacity =
      buildDeploymentRuntimeCapacityBaseline() as DeploymentRuntimeCapacitySnapshot;
    const schemaHash = hash(
      'icarus:local-capacity-defaults-schema:1\n',
      LOCAL_SCHEMA,
    );
    const diagnostic: JsonObject = {
      format: 'icarus.local-capacity-defaults/1',
      purpose: 'first_store_initialization',
      baseline_config_hash: capacity.config_hash,
    };
    const diagnosticHash = hash(
      'icarus:local-capacity-defaults-diagnostic:1\n',
      diagnostic,
    );
    const result: JsonObject = {
      format: 'icarus.capacity-admin-result/1',
      command_id: COMMAND_ID,
      disposition: 'applied',
      capacity_revision: 1,
      capacity_change_id: CHANGE_ID,
      config_hash: capacity.config_hash,
    };
    const resultHash = hash('icarus:capacity-admin-result:1\n', result);
    const command = {
      command_type: 'initialize_deployment_capacity' as const,
      command_id: COMMAND_ID,
      idempotency_key: 'local-capacity-defaults-v1',
      proposed_capacity: capacity,
      reason_code: 'initial_provisioning' as const,
    };
    const requestHash = calculateCapacityAdminRequestHash(command);
    const publication = buildDeploymentCapacityPublication(
      1,
      CHANGE_ID,
      null,
      capacity,
    );

    insertInlineValue(transaction, {
      id: SCHEMA_VALUE_ID,
      content: LOCAL_SCHEMA,
      hash: schemaHash,
      schemaHash,
      createdAtMs: initializedAtMs,
      retention: 'pinned',
    });
    transaction.execute(
      `INSERT INTO workflow_registry_resources (
         id, resource_type, resource_id, resource_version, owner_core_ref,
         owner_pack_id, canonical_value_id, content_hash, publication_state,
         created_at_ms, published_at_ms, retired_at_ms, row_version
       ) VALUES (?, 'schema', 'icarus.local-capacity-defaults', '1.0.0',
                 'icarus.core@local', NULL, ?, ?, 'published', ?, ?, NULL, 1)`,
      [
        SCHEMA_ROW_ID,
        SCHEMA_VALUE_ID,
        schemaHash,
        initializedAtMs,
        initializedAtMs,
      ],
    );
    insertInlineValue(transaction, {
      id: DIAGNOSTIC_VALUE_ID,
      content: diagnostic,
      hash: diagnosticHash,
      schemaHash,
      createdAtMs: initializedAtMs,
      retention: 'workflow_audit',
    });
    insertInlineValue(transaction, {
      id: RESULT_VALUE_ID,
      content: result,
      hash: resultHash,
      schemaHash,
      createdAtMs: initializedAtMs,
      retention: 'workflow_audit',
    });
    transaction.execute(
      `INSERT INTO runtime_capacity_admin_commands (
         command_id, idempotency_domain, idempotency_key, command_type,
         expected_capacity_revision, expected_config_hash,
         assigned_capacity_revision, assigned_change_id,
         proposed_capacity_json, proposed_config_hash, request_hash, reason_code,
         reason_text_value_id, reason_text_hash, evidence_manifest_value_id,
         evidence_manifest_hash, canonical_result_value_id, canonical_result_hash,
         created_at_ms, finalized_at_ms
       ) VALUES (?, 'local_capacity_defaults', ?, 'initialize_deployment_capacity',
                 NULL, NULL, 1, ?, ?, ?, ?, 'initial_provisioning',
                 NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        COMMAND_ID,
        command.idempotency_key,
        CHANGE_ID,
        canonicalJson(capacity as unknown as JsonValue),
        capacity.config_hash,
        requestHash,
        DIAGNOSTIC_VALUE_ID,
        diagnosticHash,
        RESULT_VALUE_ID,
        resultHash,
        initializedAtMs,
        initializedAtMs,
      ],
    );
    transaction.execute(
      `INSERT INTO runtime_capacity_head (
         singleton_key, current_capacity_revision, current_change_id,
         current_config_hash, current_publication_hash, pending_change_id,
         row_version, created_at_ms, updated_at_ms
       ) VALUES (1, 1, ?, ?, ?, NULL, 1, ?, ?)`,
      [
        CHANGE_ID,
        capacity.config_hash,
        publication.publication_hash,
        initializedAtMs,
        initializedAtMs,
      ],
    );
    appendCapacityEvent(transaction, {
      changeId: CHANGE_ID,
      commandId: COMMAND_ID,
      capacityRevision: 1,
      eventType: 'head_committed',
      configHash: capacity.config_hash,
      publicationHash: publication.publication_hash,
      createdAtMs: initializedAtMs,
    });
    return 'initialized';
  });
}
