import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type { RuntimeRegistryRef } from '../contracts/g5-basic-runtime-types.js';
import type { PlanGeneratedSchemaGenerator } from '../contracts/generated-schema-authority.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';

export class G5RuntimeError extends Error {
  constructor(
    readonly code:
      | 'contract_invalid'
      | 'precondition_failed'
      | 'cas_conflict'
      | 'idempotency_conflict'
      | 'integrity_violation'
      | 'resource_unavailable'
      | 'forbidden_surface'
      | 'fault_injected',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'G5RuntimeError';
  }
}

export interface G5TransactionFault {
  readonly point: 'before_first_write' | 'before_commit';
}

export function stableRuntimeId(kind: string, identity: JsonValue): string {
  const digest = domainSeparatedSha256(
    `icarus:workflow-g5-${kind}:1\n`,
    identity,
  ).slice('sha256:'.length);
  return `g5:${kind}:${digest}`;
}

export function runtimeObjectHash(kind: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(`icarus:workflow-g5-${kind}:1\n`, value);
}

export function requireSingleChange(
  changes: number,
  label: string,
  code: G5RuntimeError['code'] = 'cas_conflict',
): void {
  if (changes !== 1) {
    throw new G5RuntimeError(
      code,
      `${label}: expected one changed row, received ${changes}`,
    );
  }
}

export function assertExactPublishedRegistryResource(
  transaction: WorkflowRuntimeWriteTransaction,
  resource: RuntimeRegistryRef,
  label: string,
): void {
  const row = transaction.queryOne<{
    id: string;
    resource_type: string;
    resource_id: string;
    resource_version: string;
    content_hash: string;
    publication_state: string;
  }>(
    `SELECT id, resource_type, resource_id, resource_version, content_hash,
            publication_state
       FROM workflow_registry_resources WHERE id = ?`,
    [resource.rowId],
  );
  if (
    !row ||
    row.resource_type !== resource.resourceType ||
    row.resource_id !== resource.ref.id ||
    row.resource_version !== resource.ref.version ||
    row.content_hash !== resource.hash ||
    row.publication_state !== 'published'
  )
    throw new G5RuntimeError(
      'precondition_failed',
      `${label} is not the exact Published Registry resource`,
    );
}

export type InlineValueSchemaAuthority =
  | {
      readonly kind: 'registry';
      readonly resourceId: string;
      readonly resourceHash: Sha256Hash;
    }
  | {
      readonly kind: 'plan_generated';
      readonly planId: string;
      readonly planHash: Sha256Hash;
      readonly schemaRef: string;
      readonly schemaHash: Sha256Hash;
      readonly generator: PlanGeneratedSchemaGenerator;
      readonly parameterHash: Sha256Hash;
    };

export function insertInlineValue(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly id: string;
    readonly content: JsonValue;
    readonly contentHash: Sha256Hash;
    readonly provenanceRef: string;
    readonly retentionClass:
      | 'transient'
      | 'run_recovery'
      | 'workflow_audit'
      | 'user_artifact'
      | 'pinned';
    readonly createdAtMs: number;
    readonly rowVersion?: 0 | 1;
    readonly ownerGraphRunId?: string;
  } & (
    | {
        readonly schemaAuthority: InlineValueSchemaAuthority;
        readonly schemaResourceId?: never;
        readonly schemaResourceHash?: never;
      }
    | {
        readonly schemaAuthority?: never;
        readonly schemaResourceId: string;
        readonly schemaResourceHash: Sha256Hash;
      }
  ),
): 'inserted' | 'exact_replay' {
  const canonical = canonicalJson(input.content);
  const authority: InlineValueSchemaAuthority = input.schemaAuthority ?? {
    kind: 'registry',
    resourceId: input.schemaResourceId,
    resourceHash: input.schemaResourceHash,
  };
  const existing = transaction.queryOne<{
    id: string;
    inline_canonical_json: string;
    content_hash: string;
    schema_resource_id: string | null;
    schema_resource_hash: string | null;
    schema_authority_kind: string;
    schema_plan_id: string | null;
    schema_plan_hash: string | null;
    generated_schema_ref: string | null;
    generated_schema_hash: string | null;
    generated_schema_generator: string | null;
    generated_schema_parameter_hash: string | null;
    provenance_ref: string;
    retention_class: string;
    payload_state: string;
    row_version: number;
  }>(
    `SELECT id, inline_canonical_json, content_hash, schema_resource_id,
            schema_resource_hash, schema_authority_kind, schema_plan_id,
            schema_plan_hash, generated_schema_ref, generated_schema_hash,
            generated_schema_generator, generated_schema_parameter_hash,
            provenance_ref, retention_class, payload_state, row_version
       FROM workflow_values WHERE id = ?`,
    [input.id],
  );
  if (existing) {
    if (
      existing.inline_canonical_json !== canonical ||
      existing.content_hash !== input.contentHash ||
      existing.schema_authority_kind !== authority.kind ||
      existing.schema_resource_id !==
        (authority.kind === 'registry' ? authority.resourceId : null) ||
      existing.schema_resource_hash !==
        (authority.kind === 'registry' ? authority.resourceHash : null) ||
      existing.schema_plan_id !==
        (authority.kind === 'plan_generated' ? authority.planId : null) ||
      existing.schema_plan_hash !==
        (authority.kind === 'plan_generated' ? authority.planHash : null) ||
      existing.generated_schema_ref !==
        (authority.kind === 'plan_generated' ? authority.schemaRef : null) ||
      existing.generated_schema_hash !==
        (authority.kind === 'plan_generated' ? authority.schemaHash : null) ||
      existing.generated_schema_generator !==
        (authority.kind === 'plan_generated' ? authority.generator : null) ||
      existing.generated_schema_parameter_hash !==
        (authority.kind === 'plan_generated'
          ? authority.parameterHash
          : null) ||
      existing.provenance_ref !== input.provenanceRef ||
      existing.retention_class !== input.retentionClass ||
      existing.payload_state !== 'live' ||
      existing.row_version !== (input.rowVersion ?? 1)
    ) {
      throw new G5RuntimeError(
        'integrity_violation',
        `Immutable workflow value identity collision: ${input.id}`,
      );
    }
    if (input.ownerGraphRunId !== undefined) {
      const ownership = transaction.queryAll<{
        owner_workflow_id: string | null;
        owner_graph_run_id: string | null;
        owner_registry_resource_id: string | null;
        owner_feature_release_id: string | null;
        system_owner_ref: string | null;
      }>(
        `SELECT owner_workflow_id, owner_graph_run_id,
                owner_registry_resource_id, owner_feature_release_id,
                system_owner_ref
           FROM workflow_value_ownerships WHERE value_id = ?`,
        [input.id],
      );
      if (
        ownership.length !== 1 ||
        ownership[0]!.owner_workflow_id !== null ||
        ownership[0]!.owner_graph_run_id !== input.ownerGraphRunId ||
        ownership[0]!.owner_registry_resource_id !== null ||
        ownership[0]!.owner_feature_release_id !== null ||
        ownership[0]!.system_owner_ref !== null
      )
        throw new G5RuntimeError(
          'integrity_violation',
          `Immutable workflow value ownership drifted: ${input.id}`,
        );
    }
    return 'exact_replay';
  }
  transaction.execute(
    `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version, schema_authority_kind, schema_plan_id, schema_plan_hash,
       generated_schema_ref, generated_schema_hash, generated_schema_generator,
       generated_schema_parameter_hash
     ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json', ?, ?,
       ?, ?, 'live', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      canonical,
      input.contentHash,
      Buffer.byteLength(canonical, 'utf8'),
      authority.kind === 'registry' ? authority.resourceId : null,
      authority.kind === 'registry' ? authority.resourceHash : null,
      input.provenanceRef,
      input.retentionClass,
      input.createdAtMs,
      input.rowVersion ?? 1,
      authority.kind,
      authority.kind === 'plan_generated' ? authority.planId : null,
      authority.kind === 'plan_generated' ? authority.planHash : null,
      authority.kind === 'plan_generated' ? authority.schemaRef : null,
      authority.kind === 'plan_generated' ? authority.schemaHash : null,
      authority.kind === 'plan_generated' ? authority.generator : null,
      authority.kind === 'plan_generated' ? authority.parameterHash : null,
    ],
  );
  if (input.ownerGraphRunId !== undefined) {
    requireSingleChange(
      transaction.execute(
        `INSERT INTO workflow_value_ownerships (
           value_id, owner_workflow_id, owner_graph_run_id,
           owner_registry_resource_id, owner_feature_release_id,
           system_owner_ref, created_at_ms
         ) VALUES (?, NULL, ?, NULL, NULL, NULL, ?)`,
        [input.id, input.ownerGraphRunId, input.createdAtMs],
      ).changes,
      `Workflow Value ownership insert ${input.id}`,
      'integrity_violation',
    );
  }
  return 'inserted';
}

export function nextRunEventSequence(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  expectedRowVersion: number,
  nowMs: number,
): number {
  const row = transaction.queryOne<{ next_event_seq: number }>(
    'SELECT next_event_seq FROM workflow_graph_runs WHERE id = ? AND row_version = ?',
    [graphRunId, expectedRowVersion],
  );
  if (!row)
    throw new G5RuntimeError('cas_conflict', 'Run event sequence CAS failed');
  const sequence = row.next_event_seq + 1;
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_runs
          SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND next_event_seq = ?`,
      [sequence, nowMs, graphRunId, expectedRowVersion, row.next_event_seq],
    ).changes,
    'Run event sequence CAS',
  );
  return sequence;
}

export function insertGraphEvent(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly sequence: number;
    readonly scopeId: string | null;
    readonly nodeId: string | null;
    readonly attemptId: string | null;
    readonly eventType: string;
    readonly idempotencyKey: string;
    readonly payloadJson?: JsonValue | null;
    readonly payloadValueId?: string | null;
    readonly payloadHash?: Sha256Hash | null;
    readonly occurredAtMs: number;
    readonly createdAtMs: number;
  },
): void {
  transaction.execute(
    `INSERT INTO workflow_graph_events (
       graph_run_id, seq, scope_id, node_id, attempt_id, event_type,
       idempotency_key, payload_json, payload_value_id, payload_hash,
       occurred_at_ms, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.graphRunId,
      input.sequence,
      input.scopeId,
      input.nodeId,
      input.attemptId,
      input.eventType,
      input.idempotencyKey,
      input.payloadJson === undefined || input.payloadJson === null
        ? null
        : canonicalJson(input.payloadJson),
      input.payloadValueId ?? null,
      input.payloadHash ?? null,
      input.occurredAtMs,
      input.createdAtMs,
    ],
  );
}

export interface GraphFactInsertInput {
  readonly id: string;
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly eventSeq: number;
  readonly causalEventSeq: number;
  readonly causalWave: number;
  readonly factKind: string;
  readonly stableObjectKind: string;
  readonly stableObjectId: string;
  readonly factKey: string;
  readonly payloadValueId: string;
  readonly payloadHash: Sha256Hash;
  readonly createdAtMs: number;
}

export function insertGraphFact(
  transaction: WorkflowRuntimeWriteTransaction,
  input: GraphFactInsertInput,
): 'inserted' | 'exact_replay' {
  const existing = transaction.queryOne<{
    id: string;
    event_seq: number;
    fact_kind: string;
    stable_object_kind: string;
    stable_object_id: string;
    payload_value_id: string | null;
    payload_hash: string | null;
  }>(
    `SELECT id, event_seq, fact_kind, stable_object_kind, stable_object_id,
            payload_value_id, payload_hash
       FROM workflow_graph_facts WHERE graph_run_id = ? AND fact_key = ?`,
    [input.graphRunId, input.factKey],
  );
  if (existing) {
    if (
      existing.id !== input.id ||
      existing.event_seq !== input.eventSeq ||
      existing.fact_kind !== input.factKind ||
      existing.stable_object_kind !== input.stableObjectKind ||
      existing.stable_object_id !== input.stableObjectId ||
      existing.payload_value_id !== input.payloadValueId ||
      existing.payload_hash !== input.payloadHash
    ) {
      throw new G5RuntimeError(
        'integrity_violation',
        `Fact key drift: ${input.factKey}`,
      );
    }
    return 'exact_replay';
  }
  transaction.execute(
    `INSERT INTO workflow_graph_facts (
       id, graph_run_id, scope_id, event_seq, causal_event_seq, causal_wave,
       fact_kind, stable_object_kind, stable_object_id, fact_key,
       payload_value_id, payload_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.graphRunId,
      input.scopeId,
      input.eventSeq,
      input.causalEventSeq,
      input.causalWave,
      input.factKind,
      input.stableObjectKind,
      input.stableObjectId,
      input.factKey,
      input.payloadValueId,
      input.payloadHash,
      input.createdAtMs,
    ],
  );
  return 'inserted';
}

export function runImmediateG5Transaction<T>(
  store: WorkflowRuntimeStore,
  callback: (transaction: WorkflowRuntimeWriteTransaction) => T,
  fault?: G5TransactionFault,
): T {
  return store.withImmediateTransaction((transaction) => {
    if (fault?.point === 'before_first_write') {
      throw new G5RuntimeError(
        'fault_injected',
        'Injected fault before first write',
      );
    }
    const value = callback(transaction);
    if (fault?.point === 'before_commit') {
      throw new G5RuntimeError(
        'fault_injected',
        'Injected fault before commit',
      );
    }
    return value;
  });
}

export function queryRequired<T extends Record<string, unknown>>(
  transaction: WorkflowRuntimeWriteTransaction,
  sql: string,
  parameters: readonly WorkflowRuntimeSqlValue[],
  label: string,
): T {
  const row = transaction.queryOne<T>(sql, parameters);
  if (!row) throw new G5RuntimeError('precondition_failed', label);
  return row;
}

export function assertNoDeferredForeignKeyViolations(
  transaction: WorkflowRuntimeWriteTransaction,
  label: string,
): void {
  const violations = transaction.queryAll<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>('SELECT "table", rowid, parent, fkid FROM pragma_foreign_key_check', []);
  if (violations.length > 0) {
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} deferred foreign key violation: ${JSON.stringify(violations)}`,
    );
  }
}
