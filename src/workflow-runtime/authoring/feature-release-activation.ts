import {
  G39_EVENT_DOMAIN,
  G39_INVOCATION_DOMAIN,
  buildG39Receipt,
  buildG39Result,
  g39ActivationCommandId,
  g39ExpectedPointer,
  g39Failure,
  g39SchemaResourceId,
  g39TerminalReference,
  validateG39FeatureReleaseActivationReceipt,
  validateG39FeatureReleaseActivationRequest,
  validateG39FeatureReleaseActivationResult,
} from '../contracts/g3-feature-release-activation.js';
import type {
  G39ActivationDisposition,
  G39ActivationErrorCode,
  G39ActivationInvocation,
  G39FeatureReleaseActivationReceipt,
  G39FeatureReleaseActivationRequest,
  G39FeatureReleaseActivationResult,
  G39ObservedPointer,
  G39RetentionClaim,
  G39TerminalDisposition,
  G39TerminalResultReference,
} from '../contracts/g3-feature-release-activation-types.js';
import {
  registryClosureId,
  registryResourceKey,
} from '../contracts/g3-registry-persistence.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { strictParseJsonBytes } from '../contracts/strict-json.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import {
  checkReleaseRuntimeCompatibility,
  type ReleaseRuntimeResource,
} from '../store/release-runtime-compatibility.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';

export type FeatureReleaseActivationFaultPoint =
  | 'after_request_value'
  | 'after_command_pending'
  | 'after_verified_preflight'
  | 'after_previous_draining'
  | 'after_target_active'
  | 'after_pointer_cas'
  | 'after_receipt'
  | 'after_terminal_invocation'
  | 'after_terminal_events'
  | 'after_commit_before_response';

export interface FeatureReleaseActivationOptions {
  readonly faultInjector?: (point: FeatureReleaseActivationFaultPoint) => void;
}

export interface FeatureReleaseActivationRecoveryOptions {
  readonly limit: number;
  readonly actor_ref: string;
  readonly auth_session_ref: string;
  readonly requested_at_ms: number;
}

export class FeatureReleaseActivationError extends Error {
  constructor(
    readonly code: G39ActivationErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'FeatureReleaseActivationError';
  }
}

interface CommandRow extends Record<string, unknown> {
  command_id: string;
  idempotency_domain: string;
  idempotency_key: string;
  request_value_id: string;
  request_hash: string;
  request_schema_resource_id: string;
  request_schema_hash: string;
  domain_request_hash: string;
  verified_feature_id: string | null;
  verified_target_feature_release_id: string | null;
  verified_target_feature_release_ref: string | null;
  verified_target_feature_release_version: string | null;
  verified_target_feature_release_hash: string | null;
  verified_previous_feature_release_id: string | null;
  verified_previous_feature_release_ref: string | null;
  verified_previous_feature_release_version: string | null;
  verified_previous_feature_release_hash: string | null;
  verified_target_retention_handle_id: string | null;
  verified_target_retention_handle_kind: string | null;
  verified_target_retention_feature_release_id: string | null;
  verified_target_retention_closure_manifest_id: string | null;
  verified_target_retention_closure_hash: string | null;
  verified_target_retention_observed_status: string | null;
  verified_target_retention_observed_row_version: number | null;
  verified_previous_retention_handle_id: string | null;
  verified_previous_retention_handle_kind: string | null;
  verified_previous_retention_feature_release_id: string | null;
  verified_previous_retention_closure_manifest_id: string | null;
  verified_previous_retention_closure_hash: string | null;
  verified_previous_retention_observed_status: string | null;
  verified_previous_retention_observed_row_version: number | null;
  observed_pointer_state: 'absent' | 'present' | null;
  observed_pointer_row_version: number | null;
  observed_feature_release_id: string | null;
  observed_feature_release_ref: string | null;
  observed_feature_release_version: string | null;
  observed_feature_release_hash: string | null;
  terminal_disposition: G39TerminalDisposition | null;
  canonical_terminal_result_value_id: string | null;
  canonical_terminal_result_hash: string | null;
  canonical_terminal_result_schema_resource_id: string | null;
  canonical_terminal_result_schema_hash: string | null;
  canonical_terminal_invocation_id: string | null;
  canonical_terminal_invocation_no: number | null;
  canonical_terminal_invocation_hash: string | null;
  canonical_terminal_submitted_request_hash: string | null;
  applied_pointer_row_version: number | null;
  canonical_receipt_value_id: string | null;
  canonical_receipt_hash: string | null;
  canonical_receipt_schema_resource_id: string | null;
  canonical_receipt_schema_hash: string | null;
  lifecycle: 'pending' | 'applied' | 'failed' | 'conflict';
  created_at_ms: number;
  finalized_at_ms: number | null;
  row_version: number;
}

interface ValueRow extends Record<string, unknown> {
  id: string;
  storage_kind: string;
  inline_canonical_json: string | null;
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

interface ReleaseRow extends Record<string, unknown> {
  id: string;
  feature_id: string;
  release_ref: string;
  release_version: string;
  release_hash: string;
  status: 'staged' | 'active' | 'draining' | 'disabled' | 'deleting';
  activated_at_ms: number | null;
  row_version: number;
}

interface RetentionRow extends Record<string, unknown> {
  id: string;
  handle_kind: string;
  feature_release_id: string | null;
  closure_manifest_id: string;
  closure_hash: string;
  status: 'held' | 'released';
  row_version: number;
}

interface PointerRow extends Record<string, unknown> {
  feature_id: string;
  release_id: string;
  release_hash: string;
  release_ref: string;
  release_version: string;
  row_version: number;
}

interface InvocationRow extends Record<string, unknown> {
  id: string;
  command_id: string;
  invocation_no: number;
  invocation_kind: 'submit' | 'recovery';
  command_domain_request_hash: string;
  submitted_request_hash: string;
  actor_ref: string;
  auth_session_ref: string;
  requested_at_ms: number;
  disposition: G39ActivationDisposition;
  result_value_id: string;
  result_hash: string;
  result_schema_resource_id: string;
  result_schema_hash: string;
  referenced_terminal_result_value_id: string | null;
  referenced_terminal_result_hash: string | null;
  referenced_terminal_result_schema_resource_id: string | null;
  referenced_terminal_result_schema_hash: string | null;
  decided_at_ms: number;
  applied_at_ms: number | null;
  previous_invocation_hash: string | null;
  invocation_hash: string;
}

interface EventRow extends Record<string, unknown> {
  command_id: string;
  event_no: number;
  attempt_no: number;
  phase: string;
  event_type: string;
  failure_code: string | null;
  verified_feature_id: string | null;
  verified_target_feature_release_id: string | null;
  verified_target_feature_release_ref: string | null;
  verified_target_feature_release_version: string | null;
  verified_target_feature_release_hash: string | null;
  verified_previous_feature_release_id: string | null;
  verified_previous_feature_release_ref: string | null;
  verified_previous_feature_release_version: string | null;
  verified_previous_feature_release_hash: string | null;
  detail_value_id: string | null;
  detail_hash: string | null;
  detail_schema_resource_id: string | null;
  detail_schema_hash: string | null;
  previous_event_hash: string | null;
  event_hash: string;
  occurred_at_ms: number;
}

interface VerifiedFacts {
  target?: ReleaseRow;
  previous?: ReleaseRow;
  targetRetentionIdentity?: RetentionRow;
  targetRetentionObservation?: RetentionRow;
  previousRetentionIdentity?: RetentionRow;
  previousRetentionObservation?: RetentionRow;
  pointer?: G39ObservedPointer;
}

interface ActivationEventInput {
  phase:
    | 'authenticate'
    | 'validate'
    | 'preflight'
    | 'activation_transaction'
    | 'recovery'
    | 'finalize';
  event_type:
    | 'attempt_started'
    | 'phase_succeeded'
    | 'pre_transaction_failed'
    | 'activation_transaction_started'
    | 'activation_committed'
    | 'domain_request_conflicted'
    | 'pointer_cas_conflicted'
    | 'terminal_result_committed'
    | 'terminal_replayed'
    | 'recovery_started'
    | 'recovery_succeeded'
    | 'recovery_failed'
    | 'integrity_failed';
  failure_code: string | null;
  detail: G39FeatureReleaseActivationResult | null;
  includeVerifiedReleaseFacts: boolean;
}

const PROVENANCE_REF = 'icarus.feature-release-activation/1';
const REMOVED_FIELDS = new Set([
  'active_release',
  'current_release',
  'free_json_detail',
  'publisher_command',
  'receipt_required_for_all_duplicates',
  'workflow_runtime_command',
]);
const COMMAND_COLUMNS = `command_id, idempotency_domain, idempotency_key,
  request_value_id, request_hash, request_schema_resource_id,
  request_schema_hash, domain_request_hash,
  verified_feature_id,
  verified_target_feature_release_id, verified_target_feature_release_ref,
  verified_target_feature_release_version, verified_target_feature_release_hash,
  verified_previous_feature_release_id, verified_previous_feature_release_ref,
  verified_previous_feature_release_version,
  verified_previous_feature_release_hash, verified_target_retention_handle_id,
  verified_target_retention_handle_kind,
  verified_target_retention_feature_release_id,
  verified_target_retention_closure_manifest_id,
  verified_target_retention_closure_hash,
  verified_target_retention_observed_status,
  verified_target_retention_observed_row_version,
  verified_previous_retention_handle_id,
  verified_previous_retention_handle_kind,
  verified_previous_retention_feature_release_id,
  verified_previous_retention_closure_manifest_id,
  verified_previous_retention_closure_hash,
  verified_previous_retention_observed_status,
  verified_previous_retention_observed_row_version, observed_pointer_state,
  observed_pointer_row_version, observed_feature_release_id,
  observed_feature_release_ref, observed_feature_release_version,
  observed_feature_release_hash, terminal_disposition,
  canonical_terminal_result_value_id, canonical_terminal_result_hash,
  canonical_terminal_result_schema_resource_id,
  canonical_terminal_result_schema_hash, canonical_terminal_invocation_id,
  canonical_terminal_invocation_no, canonical_terminal_invocation_hash,
  canonical_terminal_submitted_request_hash, applied_pointer_row_version,
  canonical_receipt_value_id, canonical_receipt_hash,
  canonical_receipt_schema_resource_id, canonical_receipt_schema_hash,
  lifecycle, created_at_ms, finalized_at_ms, row_version`;

function assertInvocation(invocation: G39ActivationInvocation): void {
  if (
    canonicalJson(Object.keys(invocation).sort()) !==
      canonicalJson([
        'actor_ref',
        'auth_session_ref',
        'invocation_kind',
        'requested_at_ms',
      ]) ||
    !['submit', 'recovery'].includes(invocation.invocation_kind) ||
    typeof invocation.actor_ref !== 'string' ||
    invocation.actor_ref.length === 0 ||
    typeof invocation.auth_session_ref !== 'string' ||
    invocation.auth_session_ref.length === 0 ||
    !Number.isSafeInteger(invocation.requested_at_ms) ||
    invocation.requested_at_ms < 0
  ) {
    throw new FeatureReleaseActivationError(
      'activation_authentication_mismatch',
      'Activation invocation must be closed and authenticated',
    );
  }
}

function findRemovedField(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findRemovedField(entry);
      if (result) return result;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    if (REMOVED_FIELDS.has(key)) return key;
    const result = findRemovedField(entry);
    if (result) return result;
  }
  return null;
}

export function parseG39ActivationRequestBytes(
  requestBytes: Uint8Array,
): G39FeatureReleaseActivationRequest {
  let parsed: JsonObject;
  try {
    parsed = strictParseJsonBytes(Buffer.from(requestBytes)) as JsonObject;
  } catch (error) {
    throw new FeatureReleaseActivationError(
      'activation_request_strict_parse_invalid',
      'Activation request bytes failed strict parsing',
      { cause: error },
    );
  }
  const removed = findRemovedField(parsed);
  if (removed) {
    throw new FeatureReleaseActivationError(
      'activation_request_removed_field',
      `Activation request uses removed field ${removed}`,
    );
  }
  try {
    validateG39FeatureReleaseActivationRequest(parsed);
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'activation_request_schema_invalid';
    throw new FeatureReleaseActivationError(
      code === 'activation_request_unknown_field'
        ? 'activation_request_unknown_field'
        : code === 'activation_request_hash_mismatch'
          ? 'activation_request_hash_mismatch'
          : 'activation_request_schema_invalid',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (canonicalJson(parsed) !== Buffer.from(requestBytes).toString('utf8')) {
    throw new FeatureReleaseActivationError(
      'activation_request_hash_mismatch',
      'Activation request bytes are not the exact canonical request Value bytes',
    );
  }
  return parsed;
}

function loadCommand(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryOne'>
    | WorkflowRuntimeWriteTransaction,
  request: G39FeatureReleaseActivationRequest,
): CommandRow | undefined {
  return connection.queryOne<CommandRow>(
    `SELECT ${COMMAND_COLUMNS}
       FROM workflow_feature_release_activation_commands
      WHERE idempotency_domain = ? AND idempotency_key = ?`,
    [request.idempotency_domain, request.idempotency_key],
  );
}

function ensureCanonicalValue(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  content: JsonObject,
  contentHash: string,
  schemaResourceId: string,
  schemaHash: string,
  createdAtMs: number,
): void {
  const canonical = canonicalJson(content);
  const existing = transaction.queryOne<ValueRow>(
    `SELECT id, storage_kind, inline_canonical_json, content_hash, byte_length,
            media_type, schema_resource_id, schema_resource_hash, provenance_ref,
            retention_class, payload_state, payload_pruned_at_ms, row_version
       FROM workflow_values WHERE id = ?`,
    [valueId],
  );
  if (existing) {
    if (
      existing.storage_kind !== 'inline' ||
      existing.inline_canonical_json !== canonical ||
      existing.content_hash !== contentHash ||
      existing.byte_length !== Buffer.byteLength(canonical, 'utf8') ||
      existing.media_type !== 'application/json' ||
      existing.schema_resource_id !== schemaResourceId ||
      existing.schema_resource_hash !== schemaHash ||
      existing.provenance_ref !== PROVENANCE_REF ||
      existing.retention_class !== 'pinned' ||
      existing.payload_state !== 'live' ||
      existing.payload_pruned_at_ms !== null ||
      existing.row_version !== 1
    ) {
      throw new FeatureReleaseActivationError(
        'activation_persistence_identity_collision',
        `Activation canonical Value collision at ${valueId}`,
      );
    }
    return;
  }
  transaction.execute(
    `INSERT INTO workflow_values (
      id, storage_kind, inline_canonical_json, blob_hash,
      immutable_external_locator, expected_hash, content_hash, byte_length,
      media_type, schema_resource_id, schema_resource_hash, provenance_ref,
      retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
      row_version
    ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
              ?, ?, ?, 'pinned', 'live', NULL, ?, 1)`,
    [
      valueId,
      canonical,
      contentHash,
      Buffer.byteLength(canonical, 'utf8'),
      schemaResourceId,
      schemaHash,
      PROVENANCE_REF,
      createdAtMs,
    ],
  );
}

function loadValue(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  expectedHash: string,
  expectedSchemaId: string,
  expectedSchemaHash: string,
): { row: ValueRow; parsed: JsonObject } {
  const row = transaction.queryOne<ValueRow>(
    `SELECT id, storage_kind, inline_canonical_json, content_hash, byte_length,
            media_type, schema_resource_id, schema_resource_hash, provenance_ref,
            retention_class, payload_state, payload_pruned_at_ms, row_version
       FROM workflow_values WHERE id = ?`,
    [valueId],
  );
  if (
    !row ||
    row.storage_kind !== 'inline' ||
    row.inline_canonical_json === null ||
    row.content_hash !== expectedHash ||
    row.schema_resource_id !== expectedSchemaId ||
    row.schema_resource_hash !== expectedSchemaHash ||
    row.byte_length !== Buffer.byteLength(row.inline_canonical_json, 'utf8') ||
    row.media_type !== 'application/json' ||
    row.provenance_ref !== PROVENANCE_REF ||
    row.retention_class !== 'pinned' ||
    row.payload_state !== 'live' ||
    row.payload_pruned_at_ms !== null ||
    row.row_version !== 1
  ) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      `Activation Value identity mismatch at ${valueId}`,
    );
  }
  try {
    const parsed = strictParseJsonBytes(
      Buffer.from(row.inline_canonical_json, 'utf8'),
    ) as JsonObject;
    if (canonicalJson(parsed) !== row.inline_canonical_json)
      throw new Error('Value bytes are not canonical');
    return { row, parsed };
  } catch (error) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      `Activation Value strict parse failed at ${valueId}`,
      { cause: error },
    );
  }
}

function requestValueId(commandId: string): string {
  return `activation-request:${commandId}`;
}

function receiptValueId(commandId: string): string {
  return `activation-receipt:${commandId}`;
}

function resultValueId(commandId: string, invocationNo: number): string {
  return `activation-result:${commandId}:${invocationNo}`;
}

function invocationId(commandId: string, invocationNo: number): string {
  return `activation-invocation:${commandId}:${invocationNo}`;
}

function loadRelease(
  transaction: WorkflowRuntimeWriteTransaction,
  releaseId: string,
): ReleaseRow | undefined {
  return transaction.queryOne<ReleaseRow>(
    `SELECT id, feature_id, release_ref, release_version, release_hash,
            status, activated_at_ms, row_version
       FROM workflow_feature_releases WHERE id = ?`,
    [releaseId],
  );
}

function loadRetention(
  transaction: WorkflowRuntimeWriteTransaction,
  handleId: string,
): RetentionRow | undefined {
  return transaction.queryOne<RetentionRow>(
    `SELECT id, handle_kind, feature_release_id, closure_manifest_id,
            closure_hash, status, row_version
       FROM workflow_registry_retention_handles WHERE id = ?`,
    [handleId],
  );
}

function loadPointer(
  transaction: WorkflowRuntimeWriteTransaction,
  featureId: string,
): PointerRow | undefined {
  return transaction.queryOne<PointerRow>(
    `SELECT pointer.feature_id, pointer.release_id, pointer.release_hash,
            pointer.row_version, release.release_ref, release.release_version
       FROM workflow_feature_active_releases AS pointer
       JOIN workflow_feature_releases AS release ON release.id = pointer.release_id
      WHERE pointer.feature_id = ?`,
    [featureId],
  );
}

function observedPointer(row: PointerRow | undefined): G39ObservedPointer {
  return row
    ? {
        state: 'present',
        row_version: row.row_version,
        release: {
          release_id: row.release_id,
          ref: { id: row.release_ref, version: row.release_version },
          hash: row.release_hash as Sha256Hash,
        },
      }
    : { state: 'absent', row_version: null, release: null };
}

function pointerMatches(
  request: G39FeatureReleaseActivationRequest,
  observed: G39ObservedPointer,
): boolean {
  return canonicalJson(request.expected_pointer) === canonicalJson(observed);
}

function releaseMatches(
  row: ReleaseRow,
  claim: {
    release_id: string;
    ref: { id: string; version: string };
    hash: string;
  },
): boolean {
  return (
    row.id === claim.release_id &&
    row.release_ref === claim.ref.id &&
    row.release_version === claim.ref.version &&
    row.release_hash === claim.hash
  );
}

function exactReleaseResources(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G39FeatureReleaseActivationRequest,
): boolean {
  const rows = transaction.queryAll<{
    resource_type: string;
    resource_id: string;
    resource_version: string;
    content_hash: string;
    resource_role: string;
  }>(
    `SELECT resource.resource_type, resource.resource_id,
            resource.resource_version, member.content_hash,
            member.resource_role
       FROM workflow_feature_release_resources AS member
       JOIN workflow_registry_resources AS resource
         ON resource.id = member.resource_id
      WHERE member.release_id = ?
      ORDER BY resource.resource_type, resource.resource_id,
               resource.resource_version`,
    [request.target_release.release_id],
  );
  const actual = rows.map((row) => ({
    resource_type: row.resource_type,
    ref: { id: row.resource_id, version: row.resource_version },
    content_hash: row.content_hash,
    role: row.resource_role,
  }));
  return (
    canonicalJson(actual) === canonicalJson(request.target_release.resources)
  );
}

function loadReleaseRuntimeResources(
  transaction: WorkflowRuntimeWriteTransaction,
  releaseId: string,
): ReleaseRuntimeResource[] | null {
  const rows = transaction.queryAll<{
    resource_type: string;
    inline_canonical_json: string | null;
  }>(
    `SELECT resource.resource_type, value.inline_canonical_json
       FROM workflow_feature_release_resources AS member
       JOIN workflow_registry_resources AS resource
         ON resource.id = member.resource_id
       JOIN workflow_values AS value
         ON value.id = resource.canonical_value_id
        AND value.content_hash = resource.content_hash
      WHERE member.release_id = ?
        AND resource.resource_type IN (
          'feature_execution_artifact', 'executor_implementation'
        )
      ORDER BY resource.resource_type, resource.resource_id,
               resource.resource_version`,
    [releaseId],
  );
  const resources: ReleaseRuntimeResource[] = [];
  for (const row of rows) {
    if (row.inline_canonical_json === null) return null;
    try {
      const content = strictParseJsonBytes(
        Buffer.from(row.inline_canonical_json, 'utf8'),
      );
      if (!content || typeof content !== 'object' || Array.isArray(content))
        return null;
      resources.push({
        resource_type: row.resource_type,
        content: content as JsonObject,
      });
    } catch {
      return null;
    }
  }
  return resources;
}

function retentionIdentityMatches(
  row: RetentionRow,
  claim: G39RetentionClaim,
): boolean {
  return (
    row.id === claim.handle_id &&
    row.handle_kind === claim.handle_kind &&
    row.feature_release_id === claim.feature_release_id &&
    row.closure_manifest_id === registryClosureId(claim.closure_ref) &&
    row.closure_hash === claim.closure_hash
  );
}

function insertPendingCommand(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G39FeatureReleaseActivationRequest,
  commandId: string,
): void {
  transaction.execute(
    `INSERT INTO workflow_feature_release_activation_commands (
      command_id, command_type, idempotency_domain, idempotency_key,
      request_value_id, request_hash, request_schema_resource_id,
      request_schema_hash, domain_request_hash, lifecycle, created_at_ms,
      row_version
    ) VALUES (?, 'activate_feature_release', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
    [
      commandId,
      request.idempotency_domain,
      request.idempotency_key,
      requestValueId(commandId),
      request.request_hash,
      g39SchemaResourceId(request, 'request'),
      request.contract_schemas.request.content_hash,
      request.domain_request_hash,
      request.requested_at_ms,
    ],
  );
}

function verifiedUpdate(
  facts: VerifiedFacts,
  request: G39FeatureReleaseActivationRequest,
): { assignments: string[]; values: WorkflowRuntimeSqlValue[] } {
  const assignments: string[] = [];
  const values: WorkflowRuntimeSqlValue[] = [];
  const set = (column: string, value: WorkflowRuntimeSqlValue): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (facts.target) {
    set('verified_feature_id', facts.target.feature_id);
    set('verified_target_feature_release_id', facts.target.id);
    set('verified_target_feature_release_ref', facts.target.release_ref);
    set(
      'verified_target_feature_release_version',
      facts.target.release_version,
    );
    set('verified_target_feature_release_hash', facts.target.release_hash);
  }
  if (facts.previous) {
    set('verified_previous_feature_release_id', facts.previous.id);
    set('verified_previous_feature_release_ref', facts.previous.release_ref);
    set(
      'verified_previous_feature_release_version',
      facts.previous.release_version,
    );
    set('verified_previous_feature_release_hash', facts.previous.release_hash);
  }
  const retention = (
    prefix: 'target' | 'previous',
    identity: RetentionRow | undefined,
    observation: RetentionRow | undefined,
  ): void => {
    if (identity) {
      set(`verified_${prefix}_retention_handle_id`, identity.id);
      set(`verified_${prefix}_retention_handle_kind`, identity.handle_kind);
      set(
        `verified_${prefix}_retention_feature_release_id`,
        identity.feature_release_id,
      );
      set(
        `verified_${prefix}_retention_closure_manifest_id`,
        identity.closure_manifest_id,
      );
      set(`verified_${prefix}_retention_closure_hash`, identity.closure_hash);
    }
    if (observation) {
      set(`verified_${prefix}_retention_observed_status`, observation.status);
      set(
        `verified_${prefix}_retention_observed_row_version`,
        observation.row_version,
      );
    }
  };
  retention(
    'target',
    facts.targetRetentionIdentity,
    facts.targetRetentionObservation,
  );
  retention(
    'previous',
    facts.previousRetentionIdentity,
    facts.previousRetentionObservation,
  );
  if (facts.pointer) {
    set('observed_pointer_state', facts.pointer.state);
    if (facts.pointer.state === 'present') {
      set('observed_pointer_row_version', facts.pointer.row_version);
      set('observed_feature_release_id', facts.pointer.release.release_id);
      set('observed_feature_release_ref', facts.pointer.release.ref.id);
      set(
        'observed_feature_release_version',
        facts.pointer.release.ref.version,
      );
      set('observed_feature_release_hash', facts.pointer.release.hash);
    }
  }
  return { assignments, values };
}

function persistVerifiedFacts(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  request: G39FeatureReleaseActivationRequest,
  facts: VerifiedFacts,
): CommandRow {
  const update = verifiedUpdate(facts, request);
  if (update.assignments.length === 0) return command;
  const result = transaction.execute(
    `UPDATE workflow_feature_release_activation_commands
        SET ${update.assignments.join(', ')}, row_version = row_version + 1
      WHERE command_id = ? AND lifecycle = 'pending' AND row_version = ?`,
    [...update.values, command.command_id, command.row_version],
  );
  if (result.changes !== 1)
    throw new FeatureReleaseActivationError(
      'activation_persistence_identity_collision',
      'Activation verified-fact enrichment CAS failed',
    );
  return transaction.queryOne<CommandRow>(
    `SELECT ${COMMAND_COLUMNS} FROM workflow_feature_release_activation_commands WHERE command_id = ?`,
    [command.command_id],
  )!;
}

function invocationPayload(
  row: Omit<InvocationRow, 'invocation_hash'>,
): JsonObject {
  return { ...row } as JsonObject;
}

function eventPayload(row: Omit<EventRow, 'event_hash'>): JsonObject {
  return { ...row } as JsonObject;
}

function nextInvocation(
  transaction: WorkflowRuntimeWriteTransaction,
  commandId: string,
): { invocationNo: number; previousHash: string | null } {
  const head = transaction.queryOne<{
    invocation_no: number;
    invocation_hash: string;
  }>(
    `SELECT invocation_no, invocation_hash
       FROM workflow_feature_release_activation_invocations
      WHERE command_id = ? ORDER BY invocation_no DESC LIMIT 1`,
    [commandId],
  );
  return {
    invocationNo: head ? head.invocation_no + 1 : 1,
    previousHash: head?.invocation_hash ?? null,
  };
}

function insertInvocation(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  invocation: G39ActivationInvocation,
  result: G39FeatureReleaseActivationResult,
  resultSchemaResourceId: string,
  resultSchemaHash: string,
  reference: G39TerminalResultReference | null,
  previousHash: string | null,
): InvocationRow {
  const id = invocationId(command.command_id, result.invocation_no);
  const rowWithoutHash: Omit<InvocationRow, 'invocation_hash'> = {
    id,
    command_id: command.command_id,
    invocation_no: result.invocation_no,
    invocation_kind: invocation.invocation_kind,
    command_domain_request_hash: command.domain_request_hash,
    submitted_request_hash: result.submitted_domain_request_hash,
    actor_ref: invocation.actor_ref,
    auth_session_ref: invocation.auth_session_ref,
    requested_at_ms: invocation.requested_at_ms,
    disposition: result.disposition,
    result_value_id: resultValueId(command.command_id, result.invocation_no),
    result_hash: result.result_hash,
    result_schema_resource_id: resultSchemaResourceId,
    result_schema_hash: resultSchemaHash,
    referenced_terminal_result_value_id: reference?.value_id ?? null,
    referenced_terminal_result_hash: reference?.hash ?? null,
    referenced_terminal_result_schema_resource_id:
      reference?.schema_resource_id ?? null,
    referenced_terminal_result_schema_hash: reference?.schema_hash ?? null,
    decided_at_ms: invocation.requested_at_ms,
    applied_at_ms:
      result.disposition === 'applied' ? invocation.requested_at_ms : null,
    previous_invocation_hash: previousHash,
  };
  const invocationHash = domainSeparatedSha256(
    G39_INVOCATION_DOMAIN,
    invocationPayload(rowWithoutHash),
  );
  transaction.execute(
    `INSERT INTO workflow_feature_release_activation_invocations (
      id, command_id, invocation_no, invocation_kind,
      command_domain_request_hash, submitted_request_hash, actor_ref,
      auth_session_ref, requested_at_ms, disposition, result_value_id,
      result_hash, result_schema_resource_id, result_schema_hash,
      referenced_terminal_result_value_id, referenced_terminal_result_hash,
      referenced_terminal_result_schema_resource_id,
      referenced_terminal_result_schema_hash, decided_at_ms, applied_at_ms,
      previous_invocation_hash, invocation_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      command.command_id,
      result.invocation_no,
      invocation.invocation_kind,
      command.domain_request_hash,
      result.submitted_domain_request_hash,
      invocation.actor_ref,
      invocation.auth_session_ref,
      invocation.requested_at_ms,
      result.disposition,
      resultValueId(command.command_id, result.invocation_no),
      result.result_hash,
      resultSchemaResourceId,
      resultSchemaHash,
      reference?.value_id ?? null,
      reference?.hash ?? null,
      reference?.schema_resource_id ?? null,
      reference?.schema_hash ?? null,
      invocation.requested_at_ms,
      result.disposition === 'applied' ? invocation.requested_at_ms : null,
      previousHash,
      invocationHash,
    ],
  );
  return {
    ...rowWithoutHash,
    invocation_hash: invocationHash,
  } as InvocationRow;
}

function insertEvents(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  request: G39FeatureReleaseActivationRequest,
  invocationNo: number,
  occurredAtMs: number,
  inputs: ActivationEventInput[],
): void {
  const head = transaction.queryOne<{ event_no: number; event_hash: string }>(
    `SELECT event_no, event_hash
       FROM workflow_feature_release_activation_events
      WHERE command_id = ? ORDER BY event_no DESC LIMIT 1`,
    [command.command_id],
  );
  let eventNo = head ? head.event_no + 1 : 1;
  let previousHash = head?.event_hash ?? null;
  for (const input of inputs) {
    const target = input.includeVerifiedReleaseFacts
      ? {
          feature: command.verified_feature_id,
          id: command.verified_target_feature_release_id,
          ref: command.verified_target_feature_release_ref,
          version: command.verified_target_feature_release_version,
          hash: command.verified_target_feature_release_hash,
        }
      : null;
    const previous = input.includeVerifiedReleaseFacts
      ? {
          id: command.verified_previous_feature_release_id,
          ref: command.verified_previous_feature_release_ref,
          version: command.verified_previous_feature_release_version,
          hash: command.verified_previous_feature_release_hash,
        }
      : null;
    const detailValueId = input.detail
      ? resultValueId(command.command_id, invocationNo)
      : null;
    const rowWithoutHash: Omit<EventRow, 'event_hash'> = {
      command_id: command.command_id,
      event_no: eventNo,
      attempt_no: invocationNo,
      phase: input.phase,
      event_type: input.event_type,
      failure_code: input.failure_code,
      verified_feature_id: target?.feature ?? null,
      verified_target_feature_release_id: target?.id ?? null,
      verified_target_feature_release_ref: target?.ref ?? null,
      verified_target_feature_release_version: target?.version ?? null,
      verified_target_feature_release_hash: target?.hash ?? null,
      verified_previous_feature_release_id: previous?.id ?? null,
      verified_previous_feature_release_ref: previous?.ref ?? null,
      verified_previous_feature_release_version: previous?.version ?? null,
      verified_previous_feature_release_hash: previous?.hash ?? null,
      detail_value_id: detailValueId,
      detail_hash: input.detail?.result_hash ?? null,
      detail_schema_resource_id: input.detail
        ? g39SchemaResourceId(request, 'result')
        : null,
      detail_schema_hash: input.detail
        ? request.contract_schemas.result.content_hash
        : null,
      previous_event_hash: previousHash,
      occurred_at_ms: occurredAtMs,
    };
    const eventHash = domainSeparatedSha256(
      G39_EVENT_DOMAIN,
      eventPayload(rowWithoutHash),
    );
    transaction.execute(
      `INSERT INTO workflow_feature_release_activation_events (
        command_id, event_no, attempt_no, phase, event_type, failure_code,
        verified_feature_id, verified_target_feature_release_id,
        verified_target_feature_release_ref,
        verified_target_feature_release_version,
        verified_target_feature_release_hash,
        verified_previous_feature_release_id,
        verified_previous_feature_release_ref,
        verified_previous_feature_release_version,
        verified_previous_feature_release_hash, detail_value_id, detail_hash,
        detail_schema_resource_id, detail_schema_hash, previous_event_hash,
        event_hash, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command.command_id,
        eventNo,
        invocationNo,
        input.phase,
        input.event_type,
        input.failure_code,
        target?.feature ?? null,
        target?.id ?? null,
        target?.ref ?? null,
        target?.version ?? null,
        target?.hash ?? null,
        previous?.id ?? null,
        previous?.ref ?? null,
        previous?.version ?? null,
        previous?.hash ?? null,
        detailValueId,
        input.detail?.result_hash ?? null,
        input.detail ? g39SchemaResourceId(request, 'result') : null,
        input.detail ? request.contract_schemas.result.content_hash : null,
        previousHash,
        eventHash,
        occurredAtMs,
      ],
    );
    previousHash = eventHash;
    eventNo += 1;
  }
}

function terminalReference(
  command: CommandRow,
): G39TerminalResultReference | null {
  return command.canonical_terminal_result_value_id &&
    command.canonical_terminal_result_hash &&
    command.canonical_terminal_result_schema_resource_id &&
    command.canonical_terminal_result_schema_hash
    ? g39TerminalReference(
        command.canonical_terminal_result_value_id,
        command.canonical_terminal_result_hash as Sha256Hash,
        command.canonical_terminal_result_schema_resource_id,
        command.canonical_terminal_result_schema_hash as Sha256Hash,
      )
    : null;
}

function samePointerState(
  request: G39FeatureReleaseActivationRequest,
  transaction: WorkflowRuntimeWriteTransaction,
): boolean {
  return pointerMatches(
    request,
    observedPointer(loadPointer(transaction, request.feature_id)),
  );
}

function verifyInvocationAndEventChains(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  request: G39FeatureReleaseActivationRequest,
): void {
  const invocations = transaction.queryAll<InvocationRow>(
    `SELECT id, command_id, invocation_no, invocation_kind,
            command_domain_request_hash, submitted_request_hash, actor_ref,
            auth_session_ref, requested_at_ms, disposition, result_value_id,
            result_hash, result_schema_resource_id, result_schema_hash,
            referenced_terminal_result_value_id, referenced_terminal_result_hash,
            referenced_terminal_result_schema_resource_id,
            referenced_terminal_result_schema_hash, decided_at_ms, applied_at_ms,
            previous_invocation_hash, invocation_hash
       FROM workflow_feature_release_activation_invocations
      WHERE command_id = ? ORDER BY invocation_no`,
    [command.command_id],
  );
  let previousInvocationHash: string | null = null;
  const resultSchemaResourceId = g39SchemaResourceId(request, 'result');
  const resultSchemaHash = request.contract_schemas.result.content_hash;
  const invocationResults: G39FeatureReleaseActivationResult[] = [];
  for (const [index, row] of invocations.entries()) {
    if (
      row.invocation_no !== index + 1 ||
      row.previous_invocation_hash !== previousInvocationHash ||
      row.command_id !== command.command_id ||
      row.command_domain_request_hash !== command.domain_request_hash ||
      row.result_schema_resource_id !== resultSchemaResourceId ||
      row.result_schema_hash !== resultSchemaHash
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Activation Invocation adjacency or command binding mismatch',
      );
    }
    const { invocation_hash: ignored, ...withoutHash } = row;
    void ignored;
    if (
      row.invocation_hash !==
      domainSeparatedSha256(
        G39_INVOCATION_DOMAIN,
        invocationPayload(withoutHash),
      )
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Activation Invocation hash chain mismatch',
      );
    }
    const value = loadValue(
      transaction,
      row.result_value_id,
      row.result_hash,
      row.result_schema_resource_id,
      row.result_schema_hash,
    );
    validateG39FeatureReleaseActivationResult(value.parsed);
    const result = value.parsed as G39FeatureReleaseActivationResult;
    const referenceFields = [
      row.referenced_terminal_result_value_id,
      row.referenced_terminal_result_hash,
      row.referenced_terminal_result_schema_resource_id,
      row.referenced_terminal_result_schema_hash,
    ];
    const referenceIsNull = referenceFields.every((entry) => entry === null);
    const referenceIsComplete = referenceFields.every(
      (entry) => entry !== null,
    );
    const rowReference = referenceIsComplete
      ? g39TerminalReference(
          row.referenced_terminal_result_value_id!,
          row.referenced_terminal_result_hash as Sha256Hash,
          row.referenced_terminal_result_schema_resource_id!,
          row.referenced_terminal_result_schema_hash as Sha256Hash,
        )
      : null;
    const sameDomain =
      row.submitted_request_hash === row.command_domain_request_hash;
    const isCanonicalTerminal =
      sameDomain &&
      (row.disposition === 'applied' ||
        row.disposition === 'failed' ||
        row.disposition === 'conflict');
    if (
      result.command_id !== row.command_id ||
      result.invocation_no !== row.invocation_no ||
      result.disposition !== row.disposition ||
      result.submitted_domain_request_hash !== row.submitted_request_hash ||
      result.bound_domain_request_hash !== row.command_domain_request_hash ||
      (!referenceIsNull && !referenceIsComplete) ||
      (isCanonicalTerminal &&
        (result.referenced_terminal_result !== null ||
          canonicalJson(rowReference) !==
            canonicalJson(
              g39TerminalReference(
                row.result_value_id,
                row.result_hash as Sha256Hash,
                row.result_schema_resource_id,
                row.result_schema_hash as Sha256Hash,
              ),
            ))) ||
      (!isCanonicalTerminal &&
        canonicalJson(result.referenced_terminal_result) !==
          canonicalJson(rowReference)) ||
      (sameDomain &&
        canonicalJson(result.expected_pointer) !==
          canonicalJson(g39ExpectedPointer(request)))
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Activation Invocation/result binding mismatch',
      );
    }
    invocationResults.push(result);
    previousInvocationHash = row.invocation_hash;
  }

  const events = transaction.queryAll<EventRow>(
    `SELECT command_id, event_no, attempt_no, phase, event_type, failure_code,
            verified_feature_id, verified_target_feature_release_id,
            verified_target_feature_release_ref,
            verified_target_feature_release_version,
            verified_target_feature_release_hash,
            verified_previous_feature_release_id,
            verified_previous_feature_release_ref,
            verified_previous_feature_release_version,
            verified_previous_feature_release_hash, detail_value_id, detail_hash,
            detail_schema_resource_id, detail_schema_hash, previous_event_hash,
            event_hash, occurred_at_ms
       FROM workflow_feature_release_activation_events
      WHERE command_id = ? ORDER BY event_no`,
    [command.command_id],
  );
  let previousEventHash: string | null = null;
  for (const [index, row] of events.entries()) {
    if (
      row.event_no !== index + 1 ||
      row.previous_event_hash !== previousEventHash ||
      row.command_id !== command.command_id ||
      row.attempt_no < 1 ||
      row.attempt_no > invocations.length
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Activation Event adjacency or Invocation binding mismatch',
      );
    }
    const { event_hash: ignored, ...withoutHash } = row;
    void ignored;
    if (
      row.event_hash !==
      domainSeparatedSha256(G39_EVENT_DOMAIN, eventPayload(withoutHash))
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Activation Event hash chain mismatch',
      );
    }
    if (row.detail_value_id) {
      const attempt = invocations[row.attempt_no - 1];
      if (
        !attempt ||
        row.detail_value_id !== attempt.result_value_id ||
        row.detail_hash !== attempt.result_hash ||
        row.detail_schema_resource_id !== attempt.result_schema_resource_id ||
        row.detail_schema_hash !== attempt.result_schema_hash
      ) {
        throw new FeatureReleaseActivationError(
          'terminal_integrity_mismatch',
          'Activation Event detail/Invocation binding mismatch',
        );
      }
      const detail = loadValue(
        transaction,
        row.detail_value_id,
        row.detail_hash!,
        row.detail_schema_resource_id!,
        row.detail_schema_hash!,
      );
      validateG39FeatureReleaseActivationResult(detail.parsed);
      const detailResult = detail.parsed as G39FeatureReleaseActivationResult;
      if (
        detailResult.command_id !== row.command_id ||
        detailResult.invocation_no !== row.attempt_no
      ) {
        throw new FeatureReleaseActivationError(
          'terminal_integrity_mismatch',
          'Activation Event detail result binding mismatch',
        );
      }
    }
    previousEventHash = row.event_hash;
  }
  let eventOffset = 0;
  for (const [index, invocation] of invocations.entries()) {
    const result = invocationResults[index]!;
    const sameDomain =
      invocation.submitted_request_hash ===
      invocation.command_domain_request_hash;
    const isCanonicalTerminal =
      sameDomain &&
      (invocation.disposition === 'applied' ||
        invocation.disposition === 'failed' ||
        invocation.disposition === 'conflict');
    const eventInputs = isCanonicalTerminal
      ? eventInputsForTerminal(
          {
            invocation_kind: invocation.invocation_kind,
            actor_ref: invocation.actor_ref,
            auth_session_ref: invocation.auth_session_ref,
            requested_at_ms: invocation.requested_at_ms,
          },
          result,
        )
      : eventInputsForReplayOrDrift(
          invocation.invocation_kind,
          result,
          !sameDomain,
        );
    const attemptEvents = events.slice(
      eventOffset,
      eventOffset + eventInputs.length,
    );
    if (
      attemptEvents.length !== eventInputs.length ||
      attemptEvents.some((row, eventIndex) => {
        const input = eventInputs[eventIndex]!;
        const withVerifiedFacts = input.includeVerifiedReleaseFacts;
        const withDetail = input.detail !== null;
        return (
          row.attempt_no !== invocation.invocation_no ||
          row.phase !== input.phase ||
          row.event_type !== input.event_type ||
          row.failure_code !== input.failure_code ||
          row.occurred_at_ms !== invocation.requested_at_ms ||
          row.verified_feature_id !==
            (withVerifiedFacts ? command.verified_feature_id : null) ||
          row.verified_target_feature_release_id !==
            (withVerifiedFacts
              ? command.verified_target_feature_release_id
              : null) ||
          row.verified_target_feature_release_ref !==
            (withVerifiedFacts
              ? command.verified_target_feature_release_ref
              : null) ||
          row.verified_target_feature_release_version !==
            (withVerifiedFacts
              ? command.verified_target_feature_release_version
              : null) ||
          row.verified_target_feature_release_hash !==
            (withVerifiedFacts
              ? command.verified_target_feature_release_hash
              : null) ||
          row.verified_previous_feature_release_id !==
            (withVerifiedFacts
              ? command.verified_previous_feature_release_id
              : null) ||
          row.verified_previous_feature_release_ref !==
            (withVerifiedFacts
              ? command.verified_previous_feature_release_ref
              : null) ||
          row.verified_previous_feature_release_version !==
            (withVerifiedFacts
              ? command.verified_previous_feature_release_version
              : null) ||
          row.verified_previous_feature_release_hash !==
            (withVerifiedFacts
              ? command.verified_previous_feature_release_hash
              : null) ||
          row.detail_value_id !==
            (withDetail ? invocation.result_value_id : null) ||
          row.detail_hash !== (withDetail ? invocation.result_hash : null) ||
          row.detail_schema_resource_id !==
            (withDetail ? invocation.result_schema_resource_id : null) ||
          row.detail_schema_hash !==
            (withDetail ? invocation.result_schema_hash : null)
        );
      })
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Activation Invocation/Event profile mismatch',
      );
    }
    eventOffset += eventInputs.length;
  }
  if (eventOffset !== events.length) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Activation Event history contains an unbound suffix',
    );
  }
  if (command.lifecycle !== 'pending') {
    const canonical = invocations.find(
      (row) => row.id === command.canonical_terminal_invocation_id,
    );
    if (
      !canonical ||
      canonical.invocation_no !== command.canonical_terminal_invocation_no ||
      canonical.invocation_hash !==
        command.canonical_terminal_invocation_hash ||
      canonical.submitted_request_hash !==
        command.canonical_terminal_submitted_request_hash ||
      canonical.disposition !== command.terminal_disposition ||
      !events.some(
        (row) =>
          row.attempt_no === canonical.invocation_no &&
          row.event_type === 'terminal_result_committed',
      )
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Activation terminal Invocation/Event binding mismatch',
      );
    }
  } else if (
    invocations.some(
      (row) => row.submitted_request_hash === command.domain_request_hash,
    )
  ) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Pending Activation command contains canonical transition evidence',
    );
  }
}

function verifyExistingCommand(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
): G39FeatureReleaseActivationRequest {
  const requestValue = loadValue(
    transaction,
    command.request_value_id,
    command.request_hash,
    command.request_schema_resource_id,
    command.request_schema_hash,
  );
  try {
    validateG39FeatureReleaseActivationRequest(requestValue.parsed);
  } catch (error) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Stored Activation request Value failed validation',
      { cause: error },
    );
  }
  const request = requestValue.parsed as G39FeatureReleaseActivationRequest;
  if (
    command.command_id !==
      g39ActivationCommandId(
        request.idempotency_domain,
        request.idempotency_key,
      ) ||
    command.request_hash !== request.request_hash ||
    command.request_schema_resource_id !==
      g39SchemaResourceId(request, 'request') ||
    command.request_schema_hash !==
      request.contract_schemas.request.content_hash ||
    request.domain_request_hash !== command.domain_request_hash ||
    request.idempotency_domain !== command.idempotency_domain ||
    request.idempotency_key !== command.idempotency_key
  ) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Activation command/request binding mismatch',
    );
  }
  const compareFact = (actual: unknown, expected: unknown): boolean =>
    actual === null || actual === expected;
  if (
    !compareFact(command.verified_feature_id, request.feature_id) ||
    !compareFact(
      command.verified_target_feature_release_id,
      request.target_release.release_id,
    ) ||
    !compareFact(
      command.verified_target_feature_release_ref,
      request.target_release.ref.id,
    ) ||
    !compareFact(
      command.verified_target_feature_release_version,
      request.target_release.ref.version,
    ) ||
    !compareFact(
      command.verified_target_feature_release_hash,
      request.target_release.hash,
    ) ||
    !compareFact(
      command.verified_previous_feature_release_id,
      request.previous_release?.release_id ?? null,
    ) ||
    !compareFact(
      command.verified_previous_feature_release_ref,
      request.previous_release?.ref.id ?? null,
    ) ||
    !compareFact(
      command.verified_previous_feature_release_version,
      request.previous_release?.ref.version ?? null,
    ) ||
    !compareFact(
      command.verified_previous_feature_release_hash,
      request.previous_release?.hash ?? null,
    ) ||
    !compareFact(
      command.verified_target_retention_handle_id,
      request.target_retention.handle_id,
    ) ||
    !compareFact(
      command.verified_target_retention_handle_kind,
      request.target_retention.handle_kind,
    ) ||
    !compareFact(
      command.verified_target_retention_feature_release_id,
      request.target_retention.feature_release_id,
    ) ||
    !compareFact(
      command.verified_target_retention_closure_manifest_id,
      registryClosureId(request.target_retention.closure_ref),
    ) ||
    !compareFact(
      command.verified_target_retention_closure_hash,
      request.target_retention.closure_hash,
    ) ||
    !compareFact(
      command.verified_previous_retention_handle_id,
      request.previous_retention?.handle_id ?? null,
    ) ||
    !compareFact(
      command.verified_previous_retention_handle_kind,
      request.previous_retention?.handle_kind ?? null,
    ) ||
    !compareFact(
      command.verified_previous_retention_feature_release_id,
      request.previous_retention?.feature_release_id ?? null,
    ) ||
    !compareFact(
      command.verified_previous_retention_closure_manifest_id,
      request.previous_retention
        ? registryClosureId(request.previous_retention.closure_ref)
        : null,
    ) ||
    !compareFact(
      command.verified_previous_retention_closure_hash,
      request.previous_retention?.closure_hash ?? null,
    )
  ) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Activation verified facts do not match the canonical request claims',
    );
  }
  verifyInvocationAndEventChains(transaction, command, request);
  if (command.lifecycle === 'pending') {
    if (
      command.terminal_disposition !== null ||
      command.canonical_terminal_result_value_id !== null ||
      command.canonical_terminal_invocation_id !== null ||
      command.canonical_receipt_value_id !== null ||
      command.applied_pointer_row_version !== null ||
      !samePointerState(request, transaction) ||
      loadRelease(transaction, request.target_release.release_id)?.status !==
        request.target_release.expected_lifecycle
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Pending Activation command has transition or terminal evidence',
      );
    }
    return request;
  }
  const reference = terminalReference(command);
  if (!reference || command.terminal_disposition !== command.lifecycle) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Activation terminal header is incomplete',
    );
  }
  const resultValue = loadValue(
    transaction,
    reference.value_id,
    reference.hash,
    reference.schema_resource_id,
    reference.schema_hash,
  );
  validateG39FeatureReleaseActivationResult(resultValue.parsed);
  const terminalResult =
    resultValue.parsed as G39FeatureReleaseActivationResult;
  const observedFromHeader: G39ObservedPointer | null =
    command.observed_pointer_state === null
      ? null
      : command.observed_pointer_state === 'absent'
        ? { state: 'absent', row_version: null, release: null }
        : {
            state: 'present',
            row_version: command.observed_pointer_row_version!,
            release: {
              release_id: command.observed_feature_release_id!,
              ref: {
                id: command.observed_feature_release_ref!,
                version: command.observed_feature_release_version!,
              },
              hash: command.observed_feature_release_hash as Sha256Hash,
            },
          };
  if (
    terminalResult.command_id !== command.command_id ||
    terminalResult.invocation_no !== command.canonical_terminal_invocation_no ||
    terminalResult.terminal_disposition !== command.terminal_disposition ||
    terminalResult.disposition !== command.terminal_disposition ||
    terminalResult.submitted_domain_request_hash !==
      command.domain_request_hash ||
    terminalResult.bound_domain_request_hash !== command.domain_request_hash ||
    terminalResult.referenced_terminal_result !== null ||
    canonicalJson(terminalResult.expected_pointer) !==
      canonicalJson(g39ExpectedPointer(request)) ||
    canonicalJson(terminalResult.observed_pointer) !==
      canonicalJson(observedFromHeader)
  ) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Activation terminal result/header binding mismatch',
    );
  }
  if (command.lifecycle === 'applied') {
    if (
      !command.canonical_receipt_value_id ||
      !command.canonical_receipt_hash ||
      !command.canonical_receipt_schema_resource_id ||
      !command.canonical_receipt_schema_hash
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Applied Activation command has no receipt identity',
      );
    }
    const receiptValue = loadValue(
      transaction,
      command.canonical_receipt_value_id,
      command.canonical_receipt_hash,
      command.canonical_receipt_schema_resource_id,
      command.canonical_receipt_schema_hash,
    );
    validateG39FeatureReleaseActivationReceipt(receiptValue.parsed);
    const receipt = receiptValue.parsed as G39FeatureReleaseActivationReceipt;
    if (
      command.canonical_receipt_value_id !==
        receiptValueId(command.command_id) ||
      command.canonical_receipt_schema_resource_id !==
        g39SchemaResourceId(request, 'receipt') ||
      command.canonical_receipt_schema_hash !==
        request.contract_schemas.receipt.content_hash ||
      receipt.command_id !== command.command_id ||
      receipt.domain_request_hash !== command.domain_request_hash ||
      receipt.feature_id !== request.feature_id ||
      receipt.pointer.applied_row_version !==
        command.applied_pointer_row_version ||
      canonicalJson(receipt.target_retention) !==
        canonicalJson(request.target_retention) ||
      canonicalJson(receipt.previous_retention) !==
        canonicalJson(request.previous_retention) ||
      canonicalJson(terminalResult.receipt) !== canonicalJson(receipt)
    )
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        'Applied Activation result and receipt Value differ',
      );
  } else if (
    command.canonical_receipt_value_id !== null ||
    terminalResult.receipt !== null
  ) {
    throw new FeatureReleaseActivationError(
      'terminal_integrity_mismatch',
      'Failed/conflict Activation terminal fabricated a receipt',
    );
  }
  return request;
}

function eventInputsForTerminal(
  invocation: G39ActivationInvocation,
  result: G39FeatureReleaseActivationResult,
): ActivationEventInput[] {
  const events: ActivationEventInput[] = [
    {
      phase: 'authenticate',
      event_type: 'attempt_started',
      failure_code: null,
      detail: null,
      includeVerifiedReleaseFacts: false,
    },
  ];
  if (invocation.invocation_kind === 'recovery')
    events.push({
      phase: 'recovery',
      event_type: 'recovery_started',
      failure_code: null,
      detail: null,
      includeVerifiedReleaseFacts: false,
    });
  else
    events.push(
      {
        phase: 'authenticate',
        event_type: 'phase_succeeded',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: false,
      },
      {
        phase: 'validate',
        event_type: 'phase_succeeded',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: false,
      },
    );
  if (result.disposition === 'failed') {
    events.push({
      phase: 'preflight',
      event_type: 'pre_transaction_failed',
      failure_code: result.failure!.code,
      detail: result,
      includeVerifiedReleaseFacts: true,
    });
  } else {
    events.push(
      {
        phase: 'preflight',
        event_type: 'phase_succeeded',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: true,
      },
      {
        phase: 'activation_transaction',
        event_type: 'activation_transaction_started',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: true,
      },
      result.disposition === 'conflict'
        ? {
            phase: 'activation_transaction',
            event_type: 'pointer_cas_conflicted',
            failure_code: 'pointer_cas_conflict',
            detail: result,
            includeVerifiedReleaseFacts: true,
          }
        : {
            phase: 'activation_transaction',
            event_type: 'activation_committed',
            failure_code: null,
            detail: null,
            includeVerifiedReleaseFacts: true,
          },
    );
  }
  events.push({
    phase: 'finalize',
    event_type: 'terminal_result_committed',
    failure_code: null,
    detail: result,
    includeVerifiedReleaseFacts: true,
  });
  if (invocation.invocation_kind === 'recovery')
    events.push({
      phase: 'recovery',
      event_type: 'recovery_succeeded',
      failure_code: null,
      detail: result,
      includeVerifiedReleaseFacts: true,
    });
  return events;
}

function eventInputsForReplayOrDrift(
  invocationKind: G39ActivationInvocation['invocation_kind'],
  result: G39FeatureReleaseActivationResult,
  drift: boolean,
): ActivationEventInput[] {
  const events: ActivationEventInput[] = [
    {
      phase: 'authenticate',
      event_type: 'attempt_started',
      failure_code: null,
      detail: null,
      includeVerifiedReleaseFacts: false,
    },
  ];
  if (drift) {
    events.push(
      {
        phase: 'authenticate',
        event_type: 'phase_succeeded',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: false,
      },
      {
        phase: 'validate',
        event_type: 'domain_request_conflicted',
        failure_code: 'idempotency_conflict',
        detail: result,
        includeVerifiedReleaseFacts: false,
      },
    );
  } else if (invocationKind === 'recovery') {
    events.push(
      {
        phase: 'recovery',
        event_type: 'recovery_started',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: false,
      },
      {
        phase: 'recovery',
        event_type: 'recovery_succeeded',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: false,
      },
      {
        phase: 'finalize',
        event_type: 'terminal_replayed',
        failure_code: null,
        detail: result,
        includeVerifiedReleaseFacts: false,
      },
    );
  } else {
    events.push(
      {
        phase: 'authenticate',
        event_type: 'phase_succeeded',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: false,
      },
      {
        phase: 'validate',
        event_type: 'phase_succeeded',
        failure_code: null,
        detail: null,
        includeVerifiedReleaseFacts: false,
      },
      {
        phase: 'finalize',
        event_type: 'terminal_replayed',
        failure_code: null,
        detail: result,
        includeVerifiedReleaseFacts: false,
      },
    );
  }
  return events;
}

function finalizeCommand(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  disposition: G39TerminalDisposition,
  terminalInvocation: InvocationRow,
  result: G39FeatureReleaseActivationResult,
  request: G39FeatureReleaseActivationRequest,
  receipt: G39FeatureReleaseActivationReceipt | null,
  appliedPointerRowVersion: number | null,
  finalizedAtMs: number,
): void {
  const resultSchemaId = g39SchemaResourceId(request, 'result');
  const receiptSchemaId = g39SchemaResourceId(request, 'receipt');
  const update = transaction.execute(
    `UPDATE workflow_feature_release_activation_commands
        SET terminal_disposition = ?, canonical_terminal_result_value_id = ?,
            canonical_terminal_result_hash = ?,
            canonical_terminal_result_schema_resource_id = ?,
            canonical_terminal_result_schema_hash = ?,
            canonical_terminal_invocation_id = ?,
            canonical_terminal_invocation_no = ?,
            canonical_terminal_invocation_hash = ?,
            canonical_terminal_submitted_request_hash = ?,
            applied_pointer_row_version = ?, canonical_receipt_value_id = ?,
            canonical_receipt_hash = ?, canonical_receipt_schema_resource_id = ?,
            canonical_receipt_schema_hash = ?, lifecycle = ?,
            finalized_at_ms = ?, row_version = row_version + 1
      WHERE command_id = ? AND lifecycle = 'pending' AND row_version = ?`,
    [
      disposition,
      resultValueId(command.command_id, result.invocation_no),
      result.result_hash,
      resultSchemaId,
      request.contract_schemas.result.content_hash,
      terminalInvocation.id,
      terminalInvocation.invocation_no,
      terminalInvocation.invocation_hash,
      terminalInvocation.submitted_request_hash,
      appliedPointerRowVersion,
      receipt ? receiptValueId(command.command_id) : null,
      receipt?.receipt_hash ?? null,
      receipt ? receiptSchemaId : null,
      receipt ? request.contract_schemas.receipt.content_hash : null,
      disposition,
      finalizedAtMs,
      command.command_id,
      command.row_version,
    ],
  );
  if (update.changes !== 1)
    throw new FeatureReleaseActivationError(
      'activation_persistence_identity_collision',
      'Activation command terminalization CAS failed',
    );
}

function writeTerminal(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  request: G39FeatureReleaseActivationRequest,
  invocation: G39ActivationInvocation,
  disposition: G39TerminalDisposition,
  observed: G39ObservedPointer | null,
  failure: G39FeatureReleaseActivationResult['failure'],
  receipt: G39FeatureReleaseActivationReceipt | null,
  appliedPointerRowVersion: number | null,
  options: FeatureReleaseActivationOptions,
): G39FeatureReleaseActivationResult {
  const next = nextInvocation(transaction, command.command_id);
  const result = buildG39Result({
    format: 'icarus.workflow-feature-release-activation-result/1',
    disposition,
    code:
      disposition === 'applied'
        ? 'feature_release_activation_applied'
        : failure!.code,
    command_id: command.command_id,
    invocation_no: next.invocationNo,
    submitted_domain_request_hash: request.domain_request_hash,
    bound_domain_request_hash: command.domain_request_hash as Sha256Hash,
    terminal_disposition: disposition,
    referenced_terminal_result: null,
    receipt,
    expected_pointer: g39ExpectedPointer(request),
    observed_pointer: observed,
    failure,
  });
  ensureCanonicalValue(
    transaction,
    resultValueId(command.command_id, next.invocationNo),
    result,
    result.result_hash,
    g39SchemaResourceId(request, 'result'),
    request.contract_schemas.result.content_hash,
    invocation.requested_at_ms,
  );
  const invocationReference = g39TerminalReference(
    resultValueId(command.command_id, next.invocationNo),
    result.result_hash,
    g39SchemaResourceId(request, 'result'),
    request.contract_schemas.result.content_hash,
  );
  const terminalInvocation = insertInvocation(
    transaction,
    command,
    invocation,
    result,
    g39SchemaResourceId(request, 'result'),
    request.contract_schemas.result.content_hash,
    invocationReference,
    next.previousHash,
  );
  options.faultInjector?.('after_terminal_invocation');
  insertEvents(
    transaction,
    command,
    request,
    result.invocation_no,
    invocation.requested_at_ms,
    eventInputsForTerminal(invocation, result),
  );
  options.faultInjector?.('after_terminal_events');
  finalizeCommand(
    transaction,
    command,
    disposition,
    terminalInvocation,
    result,
    request,
    receipt,
    appliedPointerRowVersion,
    invocation.requested_at_ms,
  );
  return result;
}

function appendReplayOrDrift(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  boundRequest: G39FeatureReleaseActivationRequest,
  submittedRequest: G39FeatureReleaseActivationRequest,
  invocation: G39ActivationInvocation,
): G39FeatureReleaseActivationResult {
  const drift =
    command.domain_request_hash !== submittedRequest.domain_request_hash;
  const terminal = terminalReference(command);
  const next = nextInvocation(transaction, command.command_id);
  let receipt: G39FeatureReleaseActivationReceipt | null = null;
  if (!drift && command.lifecycle === 'applied') {
    const value = loadValue(
      transaction,
      command.canonical_receipt_value_id!,
      command.canonical_receipt_hash!,
      command.canonical_receipt_schema_resource_id!,
      command.canonical_receipt_schema_hash!,
    );
    validateG39FeatureReleaseActivationReceipt(value.parsed);
    receipt = value.parsed as G39FeatureReleaseActivationReceipt;
  }
  const result = buildG39Result({
    format: 'icarus.workflow-feature-release-activation-result/1',
    disposition: drift ? 'conflict' : 'duplicate',
    code: drift
      ? 'idempotency_conflict'
      : 'feature_release_activation_duplicate',
    command_id: command.command_id,
    invocation_no: next.invocationNo,
    submitted_domain_request_hash: submittedRequest.domain_request_hash,
    bound_domain_request_hash: command.domain_request_hash as Sha256Hash,
    terminal_disposition: command.terminal_disposition,
    referenced_terminal_result: terminal,
    receipt,
    expected_pointer: g39ExpectedPointer(submittedRequest),
    observed_pointer: null,
    failure: drift ? g39Failure('idempotency', 'idempotency_conflict') : null,
  });
  ensureCanonicalValue(
    transaction,
    resultValueId(command.command_id, next.invocationNo),
    result,
    result.result_hash,
    g39SchemaResourceId(boundRequest, 'result'),
    boundRequest.contract_schemas.result.content_hash,
    invocation.requested_at_ms,
  );
  insertInvocation(
    transaction,
    command,
    invocation,
    result,
    g39SchemaResourceId(boundRequest, 'result'),
    boundRequest.contract_schemas.result.content_hash,
    terminal,
    next.previousHash,
  );
  insertEvents(
    transaction,
    command,
    boundRequest,
    result.invocation_no,
    invocation.requested_at_ms,
    eventInputsForReplayOrDrift(invocation.invocation_kind, result, drift),
  );
  return result;
}

function admittedFailure(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  request: G39FeatureReleaseActivationRequest,
  invocation: G39ActivationInvocation,
  facts: VerifiedFacts,
  code: Exclude<
    G39ActivationErrorCode,
    | 'activation_request_strict_parse_invalid'
    | 'activation_request_removed_field'
    | 'activation_request_unknown_field'
    | 'activation_request_schema_invalid'
    | 'activation_request_hash_mismatch'
    | 'activation_authentication_mismatch'
    | 'idempotency_conflict'
    | 'terminal_integrity_mismatch'
    | 'pointer_cas_conflict'
    | 'activation_persistence_identity_collision'
  >,
  _detail: null,
  options: FeatureReleaseActivationOptions,
): G39FeatureReleaseActivationResult {
  const updated = persistVerifiedFacts(transaction, command, request, facts);
  options.faultInjector?.('after_verified_preflight');
  return writeTerminal(
    transaction,
    updated,
    request,
    invocation,
    'failed',
    facts.pointer ?? null,
    g39Failure('preflight', code),
    null,
    null,
    options,
  );
}

function executeFirstOrPending(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CommandRow,
  request: G39FeatureReleaseActivationRequest,
  invocation: G39ActivationInvocation,
  options: FeatureReleaseActivationOptions,
): G39FeatureReleaseActivationResult {
  const facts: VerifiedFacts = {};
  const target = loadRelease(transaction, request.target_release.release_id);
  if (!target)
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_release_missing',
      null,
      options,
    );
  if (!releaseMatches(target, request.target_release))
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_release_identity_mismatch',
      null,
      options,
    );
  if (target.feature_id !== request.feature_id)
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_release_owner_mismatch',
      null,
      options,
    );
  facts.target = target;
  if (!exactReleaseResources(transaction, request))
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_release_resource_set_mismatch',
      null,
      options,
    );

  const runtimeResources = loadReleaseRuntimeResources(
    transaction,
    request.target_release.release_id,
  );
  if (
    runtimeResources === null ||
    !checkReleaseRuntimeCompatibility(runtimeResources).compatible
  )
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'runtime_abi_incompatible',
      null,
      options,
    );
  if (target.status !== 'staged')
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_release_lifecycle_invalid',
      null,
      options,
    );

  if (request.previous_release) {
    const previous = loadRelease(
      transaction,
      request.previous_release.release_id,
    );
    if (!previous)
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_release_missing',
        null,
        options,
      );
    if (!releaseMatches(previous, request.previous_release))
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_release_identity_mismatch',
        null,
        options,
      );
    if (previous.feature_id !== request.feature_id)
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_release_owner_mismatch',
        null,
        options,
      );
    facts.previous = previous;
    if (previous.status !== 'active')
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_release_lifecycle_invalid',
        null,
        options,
      );
  }

  const targetRetention = loadRetention(
    transaction,
    request.target_retention.handle_id,
  );
  if (!targetRetention)
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_retention_missing',
      null,
      options,
    );
  if (!retentionIdentityMatches(targetRetention, request.target_retention))
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_retention_identity_mismatch',
      null,
      options,
    );
  facts.targetRetentionIdentity = targetRetention;
  if (targetRetention.status !== 'held')
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_retention_status_mismatch',
      null,
      options,
    );
  facts.targetRetentionObservation = targetRetention;
  if (
    targetRetention.row_version !==
    request.target_retention.expected_row_version
  )
    return admittedFailure(
      transaction,
      command,
      request,
      invocation,
      facts,
      'target_retention_row_version_mismatch',
      null,
      options,
    );

  if (request.previous_retention) {
    const previousRetention = loadRetention(
      transaction,
      request.previous_retention.handle_id,
    );
    if (!previousRetention)
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_retention_missing',
        null,
        options,
      );
    if (
      !retentionIdentityMatches(previousRetention, request.previous_retention)
    )
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_retention_identity_mismatch',
        null,
        options,
      );
    facts.previousRetentionIdentity = previousRetention;
    if (previousRetention.status !== 'held')
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_retention_status_mismatch',
        null,
        options,
      );
    facts.previousRetentionObservation = previousRetention;
    if (
      previousRetention.row_version !==
      request.previous_retention.expected_row_version
    )
      return admittedFailure(
        transaction,
        command,
        request,
        invocation,
        facts,
        'previous_retention_row_version_mismatch',
        null,
        options,
      );
  }

  facts.pointer = observedPointer(loadPointer(transaction, request.feature_id));
  let updatedCommand = persistVerifiedFacts(
    transaction,
    command,
    request,
    facts,
  );
  options.faultInjector?.('after_verified_preflight');
  if (!pointerMatches(request, facts.pointer)) {
    return writeTerminal(
      transaction,
      updatedCommand,
      request,
      invocation,
      'conflict',
      facts.pointer,
      g39Failure('activation_transaction', 'pointer_cas_conflict'),
      null,
      null,
      options,
    );
  }

  if (request.previous_release) {
    const transition = transaction.execute(
      `UPDATE workflow_feature_releases
          SET status = 'draining', row_version = row_version + 1
        WHERE id = ? AND feature_id = ? AND release_hash = ?
          AND status = 'active' AND row_version = ?`,
      [
        request.previous_release.release_id,
        request.feature_id,
        request.previous_release.hash,
        facts.previous!.row_version,
      ],
    );
    if (transition.changes !== 1)
      throw new FeatureReleaseActivationError(
        'activation_persistence_identity_collision',
        'Previous Release lifecycle CAS failed',
      );
  }
  options.faultInjector?.('after_previous_draining');
  const targetTransition = transaction.execute(
    `UPDATE workflow_feature_releases
        SET status = 'active', activated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND feature_id = ? AND release_hash = ?
        AND status = 'staged' AND row_version = ?`,
    [
      invocation.requested_at_ms,
      request.target_release.release_id,
      request.feature_id,
      request.target_release.hash,
      target.row_version,
    ],
  );
  if (targetTransition.changes !== 1)
    throw new FeatureReleaseActivationError(
      'activation_persistence_identity_collision',
      'Target Release lifecycle CAS failed',
    );
  options.faultInjector?.('after_target_active');
  const appliedPointerRowVersion =
    request.expected_pointer.state === 'absent'
      ? 1
      : request.expected_pointer.row_version + 1;
  if (request.expected_pointer.state === 'absent') {
    transaction.execute(
      `INSERT INTO workflow_feature_active_releases (
        feature_id, release_id, release_hash, row_version, activated_at_ms
      ) VALUES (?, ?, ?, 1, ?)`,
      [
        request.feature_id,
        request.target_release.release_id,
        request.target_release.hash,
        invocation.requested_at_ms,
      ],
    );
  } else {
    const pointerUpdate = transaction.execute(
      `UPDATE workflow_feature_active_releases
          SET release_id = ?, release_hash = ?, row_version = row_version + 1,
              activated_at_ms = ?
        WHERE feature_id = ? AND release_id = ? AND release_hash = ?
          AND row_version = ?`,
      [
        request.target_release.release_id,
        request.target_release.hash,
        invocation.requested_at_ms,
        request.feature_id,
        request.expected_pointer.release.release_id,
        request.expected_pointer.release.hash,
        request.expected_pointer.row_version,
      ],
    );
    if (pointerUpdate.changes !== 1)
      throw new FeatureReleaseActivationError(
        'activation_persistence_identity_collision',
        'Active pointer adjacent CAS failed after verified preflight',
      );
  }
  options.faultInjector?.('after_pointer_cas');

  const receipt = buildG39Receipt({
    format: 'icarus.workflow-feature-release-activation-receipt/1',
    command_id: updatedCommand.command_id,
    domain_request_hash: request.domain_request_hash,
    feature_id: request.feature_id,
    target_release: {
      release_id: request.target_release.release_id,
      ref: request.target_release.ref,
      hash: request.target_release.hash,
    },
    previous_release: request.previous_release
      ? {
          release_id: request.previous_release.release_id,
          ref: request.previous_release.ref,
          hash: request.previous_release.hash,
        }
      : null,
    pointer: {
      previous_state: request.expected_pointer.state,
      previous_row_version: request.expected_pointer.row_version,
      applied_row_version: appliedPointerRowVersion,
    },
    target_lifecycle: 'active',
    previous_lifecycle: request.previous_release ? 'draining' : null,
    target_retention: request.target_retention,
    previous_retention: request.previous_retention,
    activated_at_ms: invocation.requested_at_ms,
    active_pointer_changed: true,
  });
  ensureCanonicalValue(
    transaction,
    receiptValueId(updatedCommand.command_id),
    receipt,
    receipt.receipt_hash,
    g39SchemaResourceId(request, 'receipt'),
    request.contract_schemas.receipt.content_hash,
    invocation.requested_at_ms,
  );
  options.faultInjector?.('after_receipt');
  updatedCommand = transaction.queryOne<CommandRow>(
    `SELECT ${COMMAND_COLUMNS} FROM workflow_feature_release_activation_commands WHERE command_id = ?`,
    [updatedCommand.command_id],
  )!;
  return writeTerminal(
    transaction,
    updatedCommand,
    request,
    invocation,
    'applied',
    facts.pointer,
    null,
    receipt,
    appliedPointerRowVersion,
    options,
  );
}

function authenticate(
  request: G39FeatureReleaseActivationRequest,
  invocation: G39ActivationInvocation,
  existing: CommandRow | undefined,
): void {
  if (
    invocation.actor_ref !== request.actor_ref ||
    invocation.requested_at_ms < request.requested_at_ms ||
    (!existing &&
      invocation.invocation_kind === 'submit' &&
      (invocation.auth_session_ref !== request.auth_session_ref ||
        invocation.requested_at_ms !== request.requested_at_ms))
  ) {
    throw new FeatureReleaseActivationError(
      'activation_authentication_mismatch',
      'Activation authenticated actor/session/time does not match the canonical request authority',
    );
  }
}

export function activateFeatureRelease(
  store: WorkflowRuntimeStore,
  requestBytes: Uint8Array,
  invocation: G39ActivationInvocation,
  options: FeatureReleaseActivationOptions = {},
): G39FeatureReleaseActivationResult {
  const request = parseG39ActivationRequestBytes(requestBytes);
  assertInvocation(invocation);
  const observedBefore = loadCommand(store, request);
  authenticate(request, invocation, observedBefore);

  let result: G39FeatureReleaseActivationResult;
  try {
    result = store.withImmediateTransaction((transaction) => {
      const existing = loadCommand(transaction, request);
      authenticate(request, invocation, existing);
      if (existing) {
        const boundRequest = verifyExistingCommand(transaction, existing);
        if (
          existing.domain_request_hash !== request.domain_request_hash ||
          existing.lifecycle !== 'pending'
        ) {
          return appendReplayOrDrift(
            transaction,
            existing,
            boundRequest,
            request,
            invocation,
          );
        }
        if (invocation.invocation_kind !== 'recovery')
          throw new FeatureReleaseActivationError(
            'terminal_integrity_mismatch',
            'Clean pending Activation commands are resumed only by recovery',
          );
        return executeFirstOrPending(
          transaction,
          existing,
          boundRequest,
          invocation,
          options,
        );
      }

      const commandId = g39ActivationCommandId(
        request.idempotency_domain,
        request.idempotency_key,
      );
      ensureCanonicalValue(
        transaction,
        requestValueId(commandId),
        request,
        request.request_hash,
        g39SchemaResourceId(request, 'request'),
        request.contract_schemas.request.content_hash,
        request.requested_at_ms,
      );
      options.faultInjector?.('after_request_value');
      insertPendingCommand(transaction, request, commandId);
      options.faultInjector?.('after_command_pending');
      const command = loadCommand(transaction, request)!;
      return executeFirstOrPending(
        transaction,
        command,
        request,
        invocation,
        options,
      );
    });
  } catch (error) {
    if (error instanceof FeatureReleaseActivationError) throw error;
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: unknown }).code === 'terminal_integrity_mismatch'
    ) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        error.message,
        { cause: error },
      );
    }
    throw new FeatureReleaseActivationError(
      'activation_persistence_identity_collision',
      `Activation persistence transaction failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  options.faultInjector?.('after_commit_before_response');
  return result;
}

export function recoverPendingFeatureReleaseActivations(
  store: WorkflowRuntimeStore,
  options: FeatureReleaseActivationRecoveryOptions,
): G39FeatureReleaseActivationResult[] {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100 ||
    !Number.isSafeInteger(options.requested_at_ms) ||
    options.requested_at_ms < 0 ||
    options.requested_at_ms + options.limit - 1 > Number.MAX_SAFE_INTEGER
  )
    throw new FeatureReleaseActivationError(
      'activation_request_schema_invalid',
      'Activation recovery scan limit must be in 1..100',
    );
  const rows = store.queryAll<{
    command_id: string;
    request_value_id: string;
    request_hash: string;
    request_schema_resource_id: string;
    request_schema_hash: string;
  }>(
    `SELECT command_id, request_value_id, request_hash,
            request_schema_resource_id, request_schema_hash
       FROM workflow_feature_release_activation_commands
      WHERE lifecycle = 'pending'
      ORDER BY created_at_ms, command_id LIMIT ?`,
    [options.limit],
  );
  return rows.map((row, index) => {
    const value = store.queryOne<ValueRow>(
      `SELECT id, storage_kind, inline_canonical_json, content_hash, byte_length,
              media_type, schema_resource_id, schema_resource_hash,
              provenance_ref, retention_class, payload_state,
              payload_pruned_at_ms, row_version
         FROM workflow_values WHERE id = ?`,
      [row.request_value_id],
    );
    if (
      !value ||
      value.storage_kind !== 'inline' ||
      value.inline_canonical_json === null ||
      value.content_hash !== row.request_hash ||
      value.schema_resource_id !== row.request_schema_resource_id ||
      value.schema_resource_hash !== row.request_schema_hash ||
      value.byte_length !==
        Buffer.byteLength(value.inline_canonical_json, 'utf8') ||
      value.media_type !== 'application/json' ||
      value.provenance_ref !== PROVENANCE_REF ||
      value.retention_class !== 'pinned' ||
      value.payload_state !== 'live' ||
      value.payload_pruned_at_ms !== null ||
      value.row_version !== 1
    )
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        `Pending Activation request Value is untrusted: ${row.command_id}`,
      );
    try {
      const request = parseG39ActivationRequestBytes(
        Buffer.from(value.inline_canonical_json, 'utf8'),
      );
      if (
        request.request_hash !== row.request_hash ||
        g39ActivationCommandId(
          request.idempotency_domain,
          request.idempotency_key,
        ) !== row.command_id ||
        g39SchemaResourceId(request, 'request') !==
          row.request_schema_resource_id ||
        request.contract_schemas.request.content_hash !==
          row.request_schema_hash
      ) {
        throw new Error('pending command/request identity mismatch');
      }
    } catch (error) {
      throw new FeatureReleaseActivationError(
        'terminal_integrity_mismatch',
        `Pending Activation request Value failed strict verification: ${row.command_id}`,
        { cause: error },
      );
    }
    return activateFeatureRelease(
      store,
      Buffer.from(value.inline_canonical_json, 'utf8'),
      {
        invocation_kind: 'recovery',
        actor_ref: options.actor_ref,
        auth_session_ref: options.auth_session_ref,
        requested_at_ms: options.requested_at_ms + index,
      },
    );
  });
}
