import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import {
  buildG37Receipt,
  buildG37Result,
  calculateG37ApprovedReviewHash,
  evaluateG37PublishFoundation,
  G37_EVENT_DOMAIN,
  G37_INVOCATION_DOMAIN,
  validateG37WorkflowPublisherReceipt,
  validateG37WorkflowPublisherRequest,
  workflowFeatureReleaseId,
  workflowPublishedRetentionHandleId,
  workflowPublisherCommandId,
} from '../contracts/g3-workflow-publisher.js';
import type {
  G3WorkflowPublisherApprovedReview,
  G3WorkflowPublisherFailureCode,
  G3WorkflowPublisherInvocation,
  G3WorkflowPublisherReceipt,
  G3WorkflowPublisherRequest,
  G3WorkflowPublisherResult,
} from '../contracts/g3-workflow-publisher-types.js';
import {
  registryClosureId,
  registryResourceId,
} from '../contracts/g3-registry-persistence.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import { strictParseJsonBytes } from '../contracts/strict-json.js';
import { queryExactRegistryResource } from '../store/registry-resource-query.js';
import { preflightRetentionExecutorAbiCompatibility } from '../store/retention-executor-abi-preflight.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';

export interface WorkflowPublisherApprovedReviewRegistry {
  resolveApprovedReview(
    reviewRef: string,
    reviewHash: Sha256Hash,
  ): G3WorkflowPublisherApprovedReview | null;
}

export type WorkflowPublisherFaultPoint =
  | 'after_command_pending'
  | 'after_registry_publication'
  | 'after_feature_release_resources'
  | 'after_retention_root'
  | 'before_command_finalize';

export interface WorkflowPublisherOptions {
  readonly faultInjector?: (point: WorkflowPublisherFaultPoint) => void;
}

export class WorkflowPublisherError extends Error {
  constructor(
    readonly code: G3WorkflowPublisherFailureCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'WorkflowPublisherError';
  }
}

interface PublisherCommandRow extends Record<string, unknown> {
  command_id: string;
  domain_request_hash: string;
  target_feature_release_id: string;
  target_feature_release_hash: string;
  canonical_receipt_value_id: string | null;
  canonical_receipt_hash: string | null;
  canonical_receipt_schema_resource_id: string | null;
  canonical_receipt_schema_hash: string | null;
  lifecycle: 'pending' | 'applied' | 'failed';
}

interface ChainHeadRow extends Record<string, unknown> {
  invocation_no: number;
  invocation_hash: string;
}

interface EventHeadRow extends Record<string, unknown> {
  event_no: number;
  event_hash: string;
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
  execution_artifact_resource_id: string | null;
  execution_artifact_hash: string | null;
  status: string;
  compatibility_snapshot_ref: string;
  compatibility_snapshot_hash: string;
  staged_at_ms: number;
  activated_at_ms: number | null;
  disabled_at_ms: number | null;
  row_version: number;
}

interface ClosureRow extends Record<string, unknown> {
  id: string;
  closure_hash: string;
}

interface PublisherEventInput {
  phase:
    | 'authenticate'
    | 'validate'
    | 'review'
    | 'preflight'
    | 'publish_transaction'
    | 'recovery'
    | 'finalize';
  event_type:
    | 'attempt_started'
    | 'phase_succeeded'
    | 'pre_transaction_failed'
    | 'publish_transaction_started'
    | 'publish_committed'
    | 'recovery_started'
    | 'recovery_succeeded'
    | 'recovery_failed'
    | 'terminal_failed';
  failure_code: string | null;
  related_feature_release_id: string | null;
  related_feature_release_hash: string | null;
  detail: G3WorkflowPublisherResult | null;
}

const PROVENANCE_REF = 'icarus.workflow-publisher/1';

function assertInvocation(invocation: G3WorkflowPublisherInvocation): void {
  const keys = Object.keys(invocation).sort();
  if (
    canonicalJson(keys) !==
      canonicalJson([
        'actor_ref',
        'auth_session_ref',
        'invocation_kind',
        'requested_at_ms',
      ]) ||
    (invocation.invocation_kind !== 'submit' &&
      invocation.invocation_kind !== 'recovery') ||
    typeof invocation.actor_ref !== 'string' ||
    invocation.actor_ref.length === 0 ||
    typeof invocation.auth_session_ref !== 'string' ||
    invocation.auth_session_ref.length === 0 ||
    !Number.isSafeInteger(invocation.requested_at_ms) ||
    invocation.requested_at_ms < 0
  ) {
    throw new WorkflowPublisherError(
      'publish_request_invalid',
      'Publisher invocation must be a closed authenticated invocation',
    );
  }
}

function validateApprovedReview(
  request: G3WorkflowPublisherRequest,
  invocation: G3WorkflowPublisherInvocation,
  registry: WorkflowPublisherApprovedReviewRegistry,
): void {
  const review = request.approved_review;
  const resolved = registry.resolveApprovedReview(
    review.review_ref,
    review.review_hash,
  );
  if (
    resolved === null ||
    calculateG37ApprovedReviewHash(resolved) !== resolved.review_hash ||
    canonicalJson(resolved) !== canonicalJson(review)
  ) {
    throw new WorkflowPublisherError(
      'approved_review_invalid',
      'Approved review registry did not resolve the exact approved review',
    );
  }
  if (
    invocation.actor_ref !== review.reviewer_actor_ref ||
    invocation.auth_session_ref !== review.reviewer_auth_session_ref
  ) {
    throw new WorkflowPublisherError(
      'caller_review_session_mismatch',
      'Initial Publish must use the authenticated reviewer actor and session',
    );
  }
  if (
    review.approved_at_ms > invocation.requested_at_ms ||
    invocation.requested_at_ms >= review.expires_at_ms
  ) {
    throw new WorkflowPublisherError(
      'approved_review_expired',
      'Approved review is not valid at the authoritative invocation time',
    );
  }
}

function loadCommand(
  connection:
    | Pick<WorkflowRuntimeStore, 'queryOne'>
    | WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
): PublisherCommandRow | undefined {
  return connection.queryOne<PublisherCommandRow>(
    `SELECT command_id, domain_request_hash, target_feature_release_id,
            target_feature_release_hash, canonical_receipt_value_id,
            canonical_receipt_hash, canonical_receipt_schema_resource_id,
            canonical_receipt_schema_hash, lifecycle
       FROM workflow_publisher_commands
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
      throw new WorkflowPublisherError(
        'publisher_transaction_failed',
        `Canonical Publisher Value collision at ${valueId}`,
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

function parseReceipt(
  transaction: WorkflowRuntimeWriteTransaction,
  command: PublisherCommandRow,
): G3WorkflowPublisherReceipt {
  if (!command.canonical_receipt_value_id || !command.canonical_receipt_hash) {
    throw new WorkflowPublisherError(
      'publisher_transaction_failed',
      'Terminal Publisher command has no canonical receipt',
    );
  }
  const row = transaction.queryOne<ValueRow>(
    `SELECT id, storage_kind, inline_canonical_json, content_hash, byte_length,
            media_type, schema_resource_id, schema_resource_hash, provenance_ref,
            retention_class, payload_state, payload_pruned_at_ms, row_version
       FROM workflow_values WHERE id = ?`,
    [command.canonical_receipt_value_id],
  );
  if (
    !row ||
    row.storage_kind !== 'inline' ||
    row.inline_canonical_json === null ||
    row.content_hash !== command.canonical_receipt_hash ||
    row.schema_resource_id !== command.canonical_receipt_schema_resource_id ||
    row.schema_resource_hash !== command.canonical_receipt_schema_hash
  ) {
    throw new WorkflowPublisherError(
      'publisher_transaction_failed',
      'Canonical Publisher receipt Value identity mismatch',
    );
  }
  try {
    const parsed = strictParseJsonBytes(
      Buffer.from(row.inline_canonical_json, 'utf8'),
    );
    if (canonicalJson(parsed) !== row.inline_canonical_json)
      throw new Error('receipt bytes are not canonical JSON');
    validateG37WorkflowPublisherReceipt(parsed);
    return parsed;
  } catch (error) {
    throw new WorkflowPublisherError(
      'publisher_transaction_failed',
      'Canonical Publisher receipt is not JSON',
      { cause: error },
    );
  }
}

function nextInvocation(
  transaction: WorkflowRuntimeWriteTransaction,
  commandId: string,
): { invocationNo: number; previousHash: string | null } {
  const head = transaction.queryOne<ChainHeadRow>(
    `SELECT invocation_no, invocation_hash
       FROM workflow_publisher_command_invocations
      WHERE command_id = ? ORDER BY invocation_no DESC LIMIT 1`,
    [commandId],
  );
  return {
    invocationNo: head ? head.invocation_no + 1 : 1,
    previousHash: head?.invocation_hash ?? null,
  };
}

function resultValueId(commandId: string, invocationNo: number): string {
  return `publisher-result:${commandId}:${invocationNo}`;
}

function requestValueId(commandId: string): string {
  return `publisher-request:${commandId}`;
}

function receiptValueId(commandId: string): string {
  return `publisher-receipt:${commandId}`;
}

function insertInvocation(
  transaction: WorkflowRuntimeWriteTransaction,
  commandId: string,
  boundDomainRequestHash: string,
  invocation: G3WorkflowPublisherInvocation,
  result: G3WorkflowPublisherResult,
  resultSchemaResourceId: string,
  resultSchemaHash: string,
  previousInvocationHash: string | null,
): void {
  const payload = {
    command_id: commandId,
    invocation_no: result.invocation_no,
    command_domain_request_hash: boundDomainRequestHash,
    submitted_request_hash: result.submitted_domain_request_hash,
    actor_ref: invocation.actor_ref,
    auth_session_ref: invocation.auth_session_ref,
    requested_at_ms: invocation.requested_at_ms,
    disposition: result.disposition,
    result_value_id: resultValueId(commandId, result.invocation_no),
    result_hash: result.result_hash,
    result_schema_resource_id: resultSchemaResourceId,
    result_schema_hash: resultSchemaHash,
    decided_at_ms: invocation.requested_at_ms,
    applied_at_ms:
      result.disposition === 'applied' ? invocation.requested_at_ms : null,
    previous_invocation_hash: previousInvocationHash,
  };
  const invocationHash = domainSeparatedSha256(G37_INVOCATION_DOMAIN, payload);
  transaction.execute(
    `INSERT INTO workflow_publisher_command_invocations (
      id, command_id, invocation_no, command_domain_request_hash,
      submitted_request_hash, actor_ref, auth_session_ref, requested_at_ms,
      disposition, result_value_id, result_hash, result_schema_resource_id,
      result_schema_hash, decided_at_ms, applied_at_ms,
      previous_invocation_hash, invocation_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `publisher-invocation:${commandId}:${result.invocation_no}`,
      commandId,
      result.invocation_no,
      boundDomainRequestHash,
      result.submitted_domain_request_hash,
      invocation.actor_ref,
      invocation.auth_session_ref,
      invocation.requested_at_ms,
      result.disposition,
      resultValueId(commandId, result.invocation_no),
      result.result_hash,
      resultSchemaResourceId,
      resultSchemaHash,
      invocation.requested_at_ms,
      result.disposition === 'applied' ? invocation.requested_at_ms : null,
      previousInvocationHash,
      invocationHash,
    ],
  );
}

function insertEvents(
  transaction: WorkflowRuntimeWriteTransaction,
  commandId: string,
  invocationNo: number,
  occurredAtMs: number,
  resultSchemaResourceId: string,
  resultSchemaHash: string,
  inputs: PublisherEventInput[],
): void {
  const head = transaction.queryOne<EventHeadRow>(
    `SELECT event_no, event_hash FROM workflow_publisher_events
      WHERE command_id = ? ORDER BY event_no DESC LIMIT 1`,
    [commandId],
  );
  let eventNo = head ? head.event_no + 1 : 1;
  let previousEventHash = head?.event_hash ?? null;
  for (const input of inputs) {
    const detailValueId = input.detail
      ? resultValueId(commandId, invocationNo)
      : null;
    const detailHash = input.detail?.result_hash ?? null;
    const payload = {
      command_id: commandId,
      event_no: eventNo,
      attempt_no: invocationNo,
      phase: input.phase,
      event_type: input.event_type,
      failure_code: input.failure_code,
      related_feature_release_id: input.related_feature_release_id,
      related_feature_release_hash: input.related_feature_release_hash,
      detail_value_id: detailValueId,
      detail_hash: detailHash,
      detail_schema_resource_id: input.detail ? resultSchemaResourceId : null,
      detail_schema_hash: input.detail ? resultSchemaHash : null,
      previous_event_hash: previousEventHash,
      occurred_at_ms: occurredAtMs,
    };
    const eventHash = domainSeparatedSha256(G37_EVENT_DOMAIN, payload);
    transaction.execute(
      `INSERT INTO workflow_publisher_events (
        command_id, event_no, attempt_no, phase, event_type, failure_code,
        related_feature_release_id, related_feature_release_hash,
        detail_value_id, detail_hash, detail_schema_resource_id,
        detail_schema_hash, previous_event_hash, event_hash, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        commandId,
        eventNo,
        invocationNo,
        input.phase,
        input.event_type,
        input.failure_code,
        input.related_feature_release_id,
        input.related_feature_release_hash,
        detailValueId,
        detailHash,
        input.detail ? resultSchemaResourceId : null,
        input.detail ? resultSchemaHash : null,
        previousEventHash,
        eventHash,
        occurredAtMs,
      ],
    );
    previousEventHash = eventHash;
    eventNo += 1;
  }
}

function exactSchemaResourceId(
  request: G3WorkflowPublisherRequest,
  kind: 'request' | 'receipt' | 'result',
): string {
  return registryResourceId(request.contract_schemas[kind]);
}

function appendExistingDisposition(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
  invocation: G3WorkflowPublisherInvocation,
  command: PublisherCommandRow,
): G3WorkflowPublisherResult {
  if (command.lifecycle === 'pending') {
    throw new WorkflowPublisherError(
      'publisher_transaction_failed',
      'Pending Publisher command requires an earlier-version recovery protocol',
    );
  }
  const { invocationNo, previousHash } = nextInvocation(
    transaction,
    command.command_id,
  );
  const conflict = command.domain_request_hash !== request.domain_request_hash;
  const receipt = conflict ? null : parseReceipt(transaction, command);
  const result = buildG37Result({
    format: 'icarus.workflow-staged-publish-result/1',
    disposition: conflict ? 'conflict' : 'duplicate',
    code: conflict ? 'idempotency_conflict' : 'staged_publish_duplicate',
    command_id: command.command_id,
    invocation_no: invocationNo,
    submitted_domain_request_hash: request.domain_request_hash,
    bound_domain_request_hash: command.domain_request_hash as Sha256Hash,
    receipt,
  });
  const resultSchemaId = exactSchemaResourceId(request, 'result');
  ensureCanonicalValue(
    transaction,
    resultValueId(command.command_id, invocationNo),
    result,
    result.result_hash,
    resultSchemaId,
    request.contract_schemas.result.content_hash,
    invocation.requested_at_ms,
  );
  insertInvocation(
    transaction,
    command.command_id,
    command.domain_request_hash,
    invocation,
    result,
    resultSchemaId,
    request.contract_schemas.result.content_hash,
    previousHash,
  );
  const releaseId = command.target_feature_release_id;
  const releaseHash = command.target_feature_release_hash;
  const events: PublisherEventInput[] = [
    {
      phase: 'authenticate',
      event_type: 'attempt_started',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    },
  ];
  if (conflict) {
    events.push({
      phase: 'validate',
      event_type: 'pre_transaction_failed',
      failure_code: 'idempotency_conflict',
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: result,
    });
  } else if (invocation.invocation_kind === 'recovery') {
    events.push({
      phase: 'recovery',
      event_type: 'recovery_started',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    });
    events.push({
      phase: 'recovery',
      event_type:
        command.lifecycle === 'applied'
          ? 'recovery_succeeded'
          : 'recovery_failed',
      failure_code:
        command.lifecycle === 'applied' ? null : 'publisher_transaction_failed',
      related_feature_release_id:
        command.lifecycle === 'applied' ? releaseId : null,
      related_feature_release_hash:
        command.lifecycle === 'applied' ? releaseHash : null,
      detail: result,
    });
  } else {
    events.push({
      phase: 'finalize',
      event_type: 'phase_succeeded',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: result,
    });
  }
  insertEvents(
    transaction,
    command.command_id,
    invocationNo,
    invocation.requested_at_ms,
    resultSchemaId,
    request.contract_schemas.result.content_hash,
    events,
  );
  return result;
}

function assertNoReleaseCollision(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
): void {
  const release = request.target_release;
  const id = workflowFeatureReleaseId(release.release_ref);
  const rows = transaction.queryAll<ReleaseRow>(
    `SELECT id, feature_id, release_ref, release_version, release_hash,
            execution_artifact_resource_id, execution_artifact_hash, status,
            compatibility_snapshot_ref, compatibility_snapshot_hash,
            staged_at_ms, activated_at_ms, disabled_at_ms, row_version
       FROM workflow_feature_releases
      WHERE id = ? OR (feature_id = ? AND release_ref = ? AND release_version = ?)`,
    [
      id,
      release.feature_id,
      release.release_ref.id,
      release.release_ref.version,
    ],
  );
  if (rows.length !== 0) {
    throw new WorkflowPublisherError(
      'feature_release_identity_collision',
      `Target Feature Release already exists outside this idempotency command: ${id}`,
    );
  }
}

function insertFeatureRelease(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
  stagedAtMs: number,
): string {
  const release = request.target_release;
  const releaseId = workflowFeatureReleaseId(release.release_ref);
  transaction.execute(
    `INSERT INTO workflow_feature_releases (
      id, feature_id, release_ref, release_version, release_hash,
      execution_artifact_resource_id, execution_artifact_hash, status,
      compatibility_snapshot_ref, compatibility_snapshot_hash, staged_at_ms,
      activated_at_ms, disabled_at_ms, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, NULL, NULL, 1)`,
    [
      releaseId,
      release.feature_id,
      release.release_ref.id,
      release.release_ref.version,
      release.release_hash,
      registryResourceId({
        resource_type: 'feature_execution_artifact',
        ref: release.execution_artifact.ref,
      }),
      release.execution_artifact.hash,
      `${release.compatibility_snapshot.ref.id}@${release.compatibility_snapshot.ref.version}`,
      release.compatibility_snapshot.hash,
      stagedAtMs,
    ],
  );
  return releaseId;
}

function insertPendingCommand(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
  commandId: string,
  releaseId: string,
  createdAtMs: number,
): void {
  transaction.execute(
    `INSERT INTO workflow_publisher_commands (
      command_id, command_type, idempotency_domain, idempotency_key,
      request_value_id, request_hash, request_schema_resource_id,
      request_schema_hash, domain_request_hash, approved_review_ref,
      approved_review_hash, reviewer_actor_ref, reviewer_auth_session_ref,
      approved_at_ms, expires_at_ms, source_manifest_value_id,
      source_manifest_hash, source_manifest_schema_resource_id,
      source_manifest_schema_hash, compiled_plan_value_id, compiled_plan_hash,
      compiled_plan_schema_resource_id, compiled_plan_schema_hash,
      execution_artifact_resource_id, execution_artifact_hash,
      closure_manifest_id, closure_hash, target_feature_release_id,
      target_feature_release_hash, applied_feature_release_id,
      applied_feature_release_hash, canonical_receipt_value_id,
      canonical_receipt_hash, canonical_receipt_schema_resource_id,
      canonical_receipt_schema_hash, lifecycle, created_at_ms,
      finalized_at_ms, row_version
    ) VALUES (
      ?, 'staged_publish', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL,
      'pending', ?, NULL, 1
    )`,
    [
      commandId,
      request.idempotency_domain,
      request.idempotency_key,
      requestValueId(commandId),
      request.request_hash,
      exactSchemaResourceId(request, 'request'),
      request.contract_schemas.request.content_hash,
      request.domain_request_hash,
      request.approved_review.review_ref,
      request.approved_review.review_hash,
      request.approved_review.reviewer_actor_ref,
      request.approved_review.reviewer_auth_session_ref,
      request.approved_review.approved_at_ms,
      request.approved_review.expires_at_ms,
      request.source_manifest.value_id,
      request.source_manifest.content_hash,
      registryResourceId(request.source_manifest.schema),
      request.source_manifest.schema.content_hash,
      request.compiled_plan.value_id,
      request.compiled_plan.content_hash,
      registryResourceId(request.compiled_plan.schema),
      request.compiled_plan.schema.content_hash,
      registryResourceId({
        resource_type: 'feature_execution_artifact',
        ref: request.target_release.execution_artifact.ref,
      }),
      request.target_release.execution_artifact.hash,
      registryClosureId(request.compatibility_preflight.closure.ref),
      request.compatibility_preflight.closure.closure_hash,
      releaseId,
      request.target_release.release_hash,
      createdAtMs,
    ],
  );
}

function finalizeCommand(
  transaction: WorkflowRuntimeWriteTransaction,
  commandId: string,
  releaseId: string,
  request: G3WorkflowPublisherRequest,
  receipt: G3WorkflowPublisherReceipt,
  lifecycle: 'applied' | 'failed',
  finalizedAtMs: number,
): void {
  const result = transaction.execute(
    `UPDATE workflow_publisher_commands
        SET applied_feature_release_id = ?, applied_feature_release_hash = ?,
            canonical_receipt_value_id = ?, canonical_receipt_hash = ?,
            canonical_receipt_schema_resource_id = ?,
            canonical_receipt_schema_hash = ?, lifecycle = ?,
            finalized_at_ms = ?, row_version = row_version + 1
      WHERE command_id = ? AND lifecycle = 'pending' AND row_version = 1`,
    [
      lifecycle === 'applied' ? releaseId : null,
      lifecycle === 'applied' ? request.target_release.release_hash : null,
      receiptValueId(commandId),
      receipt.receipt_hash,
      exactSchemaResourceId(request, 'receipt'),
      request.contract_schemas.receipt.content_hash,
      lifecycle,
      finalizedAtMs,
      commandId,
    ],
  );
  if (result.changes !== 1) {
    throw new WorkflowPublisherError(
      'publisher_transaction_failed',
      'Publisher command finalization CAS failed',
    );
  }
}

function preflightSchemas(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
): void {
  for (const query of [
    request.contract_schemas.request,
    request.contract_schemas.receipt,
    request.contract_schemas.result,
    request.source_manifest.schema,
    request.compiled_plan.schema,
  ]) {
    const result = queryExactRegistryResource(transaction, query);
    if (result.outcome === 'rejected') {
      throw new WorkflowPublisherError(
        'registry_resource_preflight_failed',
        `Publisher schema Value binding failed: ${result.code}`,
      );
    }
  }
}

function preflightReleaseResources(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
): string | null {
  for (const query of request.release_resources) {
    const result = queryExactRegistryResource(transaction, query);
    if (result.outcome === 'rejected') return result.code;
  }
  return null;
}

function publishRegistryResources(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
  publishedAtMs: number,
): void {
  for (const query of request.release_resources) {
    const result = transaction.execute(
      `UPDATE workflow_registry_resources
          SET publication_state = 'published', published_at_ms = ?,
              row_version = row_version + 1
        WHERE id = ? AND content_hash = ? AND publication_state = 'staged'
          AND published_at_ms IS NULL AND retired_at_ms IS NULL`,
      [publishedAtMs, registryResourceId(query), query.content_hash],
    );
    if (result.changes !== 1) {
      throw new WorkflowPublisherError(
        'registry_publication_collision',
        `Registry publication CAS failed for ${registryResourceId(query)}`,
      );
    }
  }
}

function insertReleaseResources(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
  releaseId: string,
): void {
  for (const entry of request.target_release.resources) {
    transaction.execute(
      `INSERT INTO workflow_feature_release_resources (
        release_id, resource_id, content_hash, resource_role
      ) VALUES (?, ?, ?, ?)`,
      [
        releaseId,
        registryResourceId(entry.resource),
        entry.resource.content_hash,
        entry.role,
      ],
    );
  }
}

function insertRetentionRoot(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
  releaseId: string,
  createdAtMs: number,
): string {
  const closure = request.compatibility_preflight.closure;
  const handleId = workflowPublishedRetentionHandleId(
    request.target_release.release_ref,
    closure.ref,
  );
  const collision = transaction.queryOne<Record<string, unknown>>(
    `SELECT id FROM workflow_registry_retention_handles
      WHERE id = ? OR (handle_kind = 'published' AND feature_release_id = ?
        AND closure_manifest_id = ?)`,
    [handleId, releaseId, registryClosureId(closure.ref)],
  );
  if (collision) {
    throw new WorkflowPublisherError(
      'retention_root_identity_collision',
      `Published Retention root collision at ${handleId}`,
    );
  }
  transaction.execute(
    `INSERT INTO workflow_registry_retention_handles (
      id, handle_kind, feature_release_id, graph_run_id, backup_id,
      external_actor_ref, closure_manifest_id, closure_hash, status,
      created_at_ms, released_at_ms, row_version
    ) VALUES (?, 'published', ?, NULL, NULL, NULL, ?, ?, 'held', ?, NULL, 1)`,
    [
      handleId,
      releaseId,
      registryClosureId(closure.ref),
      closure.closure_hash,
      createdAtMs,
    ],
  );
  for (const member of request.compatibility_preflight.retention.members) {
    transaction.execute(
      `INSERT INTO workflow_registry_retention_handle_members (
        handle_id, resource_id, content_hash
      ) VALUES (?, ?, ?)`,
      [handleId, registryResourceId(member), member.content_hash],
    );
  }
  return handleId;
}

function failureFromPreflights(
  transaction: WorkflowRuntimeWriteTransaction,
  request: G3WorkflowPublisherRequest,
): G3WorkflowPublisherFailureCode | null {
  const foundation = evaluateG37PublishFoundation(request);
  if (foundation.outcome === 'rejected')
    return 'publish_foundation_preflight_failed';
  const resourceFailure = preflightReleaseResources(transaction, request);
  if (resourceFailure !== null) return 'registry_resource_preflight_failed';
  const compatibility = preflightRetentionExecutorAbiCompatibility(
    transaction,
    request.compatibility_preflight,
  );
  if (compatibility.outcome === 'rejected')
    return 'retention_executor_abi_preflight_failed';
  return null;
}

function eventInputsForNewCommand(
  invocation: G3WorkflowPublisherInvocation,
  result: G3WorkflowPublisherResult,
  releaseId: string,
  releaseHash: string,
  failureCode: G3WorkflowPublisherFailureCode | null,
): PublisherEventInput[] {
  const events: PublisherEventInput[] = [
    {
      phase: 'authenticate',
      event_type: 'attempt_started',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    },
  ];
  if (invocation.invocation_kind === 'recovery') {
    events.push({
      phase: 'recovery',
      event_type: 'recovery_started',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    });
  }
  events.push(
    {
      phase: 'validate',
      event_type: 'phase_succeeded',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    },
    {
      phase: 'review',
      event_type: 'phase_succeeded',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    },
  );
  if (failureCode) {
    events.push(
      {
        phase: 'preflight',
        event_type: 'pre_transaction_failed',
        failure_code: failureCode,
        related_feature_release_id: null,
        related_feature_release_hash: null,
        detail: result,
      },
      {
        phase: 'finalize',
        event_type: 'terminal_failed',
        failure_code: failureCode,
        related_feature_release_id: null,
        related_feature_release_hash: null,
        detail: result,
      },
    );
    return events;
  }
  events.push(
    {
      phase: 'preflight',
      event_type: 'phase_succeeded',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    },
    {
      phase: 'publish_transaction',
      event_type: 'publish_transaction_started',
      failure_code: null,
      related_feature_release_id: null,
      related_feature_release_hash: null,
      detail: null,
    },
    {
      phase: 'publish_transaction',
      event_type: 'publish_committed',
      failure_code: null,
      related_feature_release_id: releaseId,
      related_feature_release_hash: releaseHash,
      detail: null,
    },
  );
  events.push(
    invocation.invocation_kind === 'recovery'
      ? {
          phase: 'recovery',
          event_type: 'recovery_succeeded',
          failure_code: null,
          related_feature_release_id: releaseId,
          related_feature_release_hash: releaseHash,
          detail: result,
        }
      : {
          phase: 'finalize',
          event_type: 'phase_succeeded',
          failure_code: null,
          related_feature_release_id: null,
          related_feature_release_hash: null,
          detail: result,
        },
  );
  return events;
}

export function publishStagedWorkflowRelease(
  store: WorkflowRuntimeStore,
  requestCandidate: unknown,
  invocation: G3WorkflowPublisherInvocation,
  reviewRegistry: WorkflowPublisherApprovedReviewRegistry,
  options: WorkflowPublisherOptions = {},
): G3WorkflowPublisherResult {
  assertInvocation(invocation);
  try {
    validateG37WorkflowPublisherRequest(requestCandidate);
  } catch (error) {
    if (error instanceof WorkflowPublisherError) throw error;
    const code =
      error instanceof Error && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'publish_request_invalid';
    throw new WorkflowPublisherError(
      code === 'publish_request_hash_mismatch'
        ? 'publish_request_hash_mismatch'
        : 'publish_request_invalid',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  const request = requestCandidate;
  const observed = loadCommand(store, request);
  if (!observed) validateApprovedReview(request, invocation, reviewRegistry);

  return store.withImmediateTransaction((transaction) => {
    preflightSchemas(transaction, request);
    const existing = loadCommand(transaction, request);
    if (existing)
      return appendExistingDisposition(
        transaction,
        request,
        invocation,
        existing,
      );

    assertNoReleaseCollision(transaction, request);
    const closure = transaction.queryOne<ClosureRow>(
      `SELECT id, closure_hash FROM workflow_registry_closure_manifests
        WHERE id = ?`,
      [registryClosureId(request.compatibility_preflight.closure.ref)],
    );
    if (
      !closure ||
      closure.closure_hash !==
        request.compatibility_preflight.closure.closure_hash
    ) {
      throw new WorkflowPublisherError(
        'registry_resource_preflight_failed',
        'Exact Closure is unavailable for Publisher audit binding',
      );
    }

    ensureCanonicalValue(
      transaction,
      request.source_manifest.value_id,
      request.source_manifest.content,
      request.source_manifest.content_hash,
      registryResourceId(request.source_manifest.schema),
      request.source_manifest.schema.content_hash,
      invocation.requested_at_ms,
    );
    ensureCanonicalValue(
      transaction,
      request.compiled_plan.value_id,
      request.compiled_plan.content,
      request.compiled_plan.content_hash,
      registryResourceId(request.compiled_plan.schema),
      request.compiled_plan.schema.content_hash,
      invocation.requested_at_ms,
    );

    const commandId = workflowPublisherCommandId(
      request.idempotency_domain,
      request.idempotency_key,
    );
    ensureCanonicalValue(
      transaction,
      requestValueId(commandId),
      request,
      request.request_hash,
      exactSchemaResourceId(request, 'request'),
      request.contract_schemas.request.content_hash,
      invocation.requested_at_ms,
    );

    const failureCode = failureFromPreflights(transaction, request);
    const releaseId = insertFeatureRelease(
      transaction,
      request,
      invocation.requested_at_ms,
    );
    insertPendingCommand(
      transaction,
      request,
      commandId,
      releaseId,
      invocation.requested_at_ms,
    );
    options.faultInjector?.('after_command_pending');

    let retentionHandleId: string | null = null;
    if (!failureCode) {
      publishRegistryResources(
        transaction,
        request,
        invocation.requested_at_ms,
      );
      options.faultInjector?.('after_registry_publication');
      insertReleaseResources(transaction, request, releaseId);
      options.faultInjector?.('after_feature_release_resources');
      retentionHandleId = insertRetentionRoot(
        transaction,
        request,
        releaseId,
        invocation.requested_at_ms,
      );
      options.faultInjector?.('after_retention_root');
    }

    const receipt = buildG37Receipt({
      format: 'icarus.workflow-staged-publish-receipt/1',
      command_id: commandId,
      outcome: failureCode ? 'failed' : 'applied',
      domain_request_hash: request.domain_request_hash,
      feature_release_ref: request.target_release.release_ref,
      feature_release_hash: request.target_release.release_hash,
      closure_ref: request.compatibility_preflight.closure.ref,
      closure_hash: request.compatibility_preflight.closure.closure_hash,
      execution_artifact_ref: request.target_release.execution_artifact.ref,
      execution_artifact_hash: request.target_release.execution_artifact.hash,
      release_resources: request.target_release.resources,
      registry_publication_count: failureCode
        ? 0
        : request.release_resources.length,
      retention_handle_id: retentionHandleId,
      failure_code: failureCode,
      active_pointer_changed: false,
    });
    ensureCanonicalValue(
      transaction,
      receiptValueId(commandId),
      receipt,
      receipt.receipt_hash,
      exactSchemaResourceId(request, 'receipt'),
      request.contract_schemas.receipt.content_hash,
      invocation.requested_at_ms,
    );

    const result = buildG37Result({
      format: 'icarus.workflow-staged-publish-result/1',
      disposition: failureCode ? 'failed' : 'applied',
      code: failureCode ?? 'staged_publish_applied',
      command_id: commandId,
      invocation_no: 1,
      submitted_domain_request_hash: request.domain_request_hash,
      bound_domain_request_hash: request.domain_request_hash,
      receipt,
    });
    const resultSchemaId = exactSchemaResourceId(request, 'result');
    ensureCanonicalValue(
      transaction,
      resultValueId(commandId, 1),
      result,
      result.result_hash,
      resultSchemaId,
      request.contract_schemas.result.content_hash,
      invocation.requested_at_ms,
    );
    insertInvocation(
      transaction,
      commandId,
      request.domain_request_hash,
      invocation,
      result,
      resultSchemaId,
      request.contract_schemas.result.content_hash,
      null,
    );
    insertEvents(
      transaction,
      commandId,
      1,
      invocation.requested_at_ms,
      resultSchemaId,
      request.contract_schemas.result.content_hash,
      eventInputsForNewCommand(
        invocation,
        result,
        releaseId,
        request.target_release.release_hash,
        failureCode,
      ),
    );
    options.faultInjector?.('before_command_finalize');
    finalizeCommand(
      transaction,
      commandId,
      releaseId,
      request,
      receipt,
      failureCode ? 'failed' : 'applied',
      invocation.requested_at_ms,
    );
    return result;
  });
}
