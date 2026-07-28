import { canonicalJson } from '../contracts/hash.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  assertNoDeferredForeignKeyViolations,
  insertGraphEvent,
  insertInlineValue,
  requireSingleChange,
  runImmediateG5Transaction,
  runtimeObjectHash,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import { releaseLedgerReservationGroup } from './ledger.js';

export type ScopeCloseCause =
  | {
      readonly reason: 'normal';
      readonly selectedRuleId: string;
      readonly candidateId: string;
      readonly eligibilityEventSeq: number;
    }
  | {
      readonly reason: 'engine_error';
      readonly errorCode: string;
      readonly errorDetail?: RuntimeValueRef;
    }
  | {
      readonly reason: 'local_cancel' | 'workflow_cancel';
      readonly cancelPayload: JsonObject;
    }
  | { readonly reason: 'parent_close' };

export interface T7aCloseInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly expectedRunRowVersion: number;
  readonly expectedScopeRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly cause: ScopeCloseCause;
  readonly manifestSchema: RuntimeRegistryRef;
  readonly nowMs: number;
}

export interface T7aCloseReceipt {
  readonly disposition: 'close_requested' | 'exact_replay';
  readonly closeRequestId: string;
  readonly subtreeFenceManifestId: string;
  readonly fencedScopeIds: readonly string[];
  readonly createdDescendantRequestIds: readonly string[];
}

interface RunRow extends Record<string, unknown> {
  id: string;
  root_scope_id: string;
  lifecycle: string;
  control: string;
  operational_state: string;
  work_fence_epoch: number;
  next_event_seq: number;
  row_version: number;
}

interface ScopeRow extends Record<string, unknown> {
  id: string;
  parent_scope_id: string | null;
  lifecycle: string;
  work_fence_epoch: number;
  close_request_id: string | null;
  row_version: number;
}

interface CloseRequestRow extends Record<string, unknown> {
  id: string;
  scope_id: string;
  reason: string;
  selected_rule_id: string | null;
  candidate_id: string | null;
  eligibility_event_seq: number | null;
  error_code: string | null;
  error_detail_value_id: string | null;
  error_detail_hash: Sha256Hash | null;
  cancel_payload_hash: Sha256Hash | null;
  request_hash: Sha256Hash;
}

interface ScopeFrontier {
  readonly facts: JsonObject[];
  readonly nodes: JsonObject[];
  readonly edges: JsonObject[];
  readonly factHash: Sha256Hash;
  readonly nodeHash: Sha256Hash;
  readonly edgeHash: Sha256Hash;
}

function loadFrontier(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  scopeId: string,
): ScopeFrontier {
  const facts = transaction.queryAll<Record<string, unknown>>(
    `SELECT fact_key, fact_kind, event_seq, payload_hash
       FROM workflow_graph_facts
      WHERE graph_run_id = ? AND scope_id = ?
      ORDER BY event_seq, fact_key COLLATE BINARY`,
    [graphRunId, scopeId],
  ) as JsonObject[];
  const nodes = transaction.queryAll<Record<string, unknown>>(
    `SELECT id, node_key, phase, terminal_status, terminal_code,
            controller_state, controller_remaining_count, row_version
       FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id = ?
      ORDER BY node_key COLLATE BINARY`,
    [graphRunId, scopeId],
  ) as JsonObject[];
  const edges = transaction.queryAll<Record<string, unknown>>(
    `SELECT id, edge_key, edge_kind
       FROM workflow_graph_edges
      WHERE graph_run_id = ? AND scope_id = ?
      ORDER BY edge_key COLLATE BINARY`,
    [graphRunId, scopeId],
  ) as JsonObject[];
  return {
    facts,
    nodes,
    edges,
    factHash: runtimeObjectHash('fact-snapshot', facts),
    nodeHash: runtimeObjectHash('node-frontier', nodes),
    edgeHash: runtimeObjectHash('edge-frontier', edges),
  };
}

function closeRequestPayload(input: {
  readonly graphRunId: string;
  readonly scope: ScopeRow;
  readonly cause: ScopeCloseCause;
  readonly frontier: ScopeFrontier;
  readonly triggerEventSeq: number;
}): JsonObject {
  return {
    graph_run_id: input.graphRunId,
    scope_id: input.scope.id,
    reason: input.cause.reason,
    selected_rule_id:
      input.cause.reason === 'normal' ? input.cause.selectedRuleId : null,
    candidate_id:
      input.cause.reason === 'normal' ? input.cause.candidateId : null,
    eligibility_event_seq:
      input.cause.reason === 'normal' ? input.cause.eligibilityEventSeq : null,
    fact_snapshot_hash: input.frontier.factHash,
    node_frontier_hash: input.frontier.nodeHash,
    edge_frontier_hash: input.frontier.edgeHash,
    trigger_event_seq: input.triggerEventSeq,
    fenced_work_epoch_at_creation: input.scope.work_fence_epoch,
    error_code:
      input.cause.reason === 'engine_error' ? input.cause.errorCode : null,
    error_detail_hash:
      input.cause.reason === 'engine_error'
        ? (input.cause.errorDetail?.hash ?? null)
        : null,
    cancel_payload_hash:
      input.cause.reason === 'local_cancel' ||
      input.cause.reason === 'workflow_cancel'
        ? runtimeObjectHash('cancel-payload', input.cause.cancelPayload)
        : null,
  };
}

function insertCloseRequest(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly scope: ScopeRow;
    readonly cause: ScopeCloseCause;
    readonly sequence: number;
    readonly nowMs: number;
  },
): CloseRequestRow {
  const frontier = loadFrontier(transaction, input.graphRunId, input.scope.id);
  const payload = closeRequestPayload({
    graphRunId: input.graphRunId,
    scope: input.scope,
    cause: input.cause,
    frontier,
    triggerEventSeq: input.sequence,
  });
  const requestHash = runtimeObjectHash('scope-close-request', payload);
  const closeRequestId = stableRuntimeId('close-request', {
    graph_run_id: input.graphRunId,
    scope_id: input.scope.id,
    request_hash: requestHash,
  });
  const cancelPayload =
    input.cause.reason === 'local_cancel' ||
    input.cause.reason === 'workflow_cancel'
      ? input.cause.cancelPayload
      : null;
  const cancelPayloadHash = cancelPayload
    ? runtimeObjectHash('cancel-payload', cancelPayload)
    : null;
  transaction.execute(
    `INSERT INTO workflow_graph_scope_close_requests (
       id, graph_run_id, scope_id, selected_rule_id, candidate_id,
       eligibility_event_seq, fact_snapshot_json, fact_snapshot_hash,
       node_frontier_json, node_frontier_hash, edge_frontier_json,
       edge_frontier_hash, trigger_event_seq, fenced_work_epoch_at_creation,
       reason, error_code, error_detail_value_id, error_detail_hash,
       cancel_payload_json, cancel_payload_hash, request_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      closeRequestId,
      input.graphRunId,
      input.scope.id,
      input.cause.reason === 'normal' ? input.cause.selectedRuleId : null,
      input.cause.reason === 'normal' ? input.cause.candidateId : null,
      input.cause.reason === 'normal' ? input.cause.eligibilityEventSeq : null,
      canonicalJson(frontier.facts),
      frontier.factHash,
      canonicalJson(frontier.nodes),
      frontier.nodeHash,
      canonicalJson(frontier.edges),
      frontier.edgeHash,
      input.sequence,
      input.scope.work_fence_epoch,
      input.cause.reason,
      input.cause.reason === 'engine_error' ? input.cause.errorCode : null,
      input.cause.reason === 'engine_error'
        ? (input.cause.errorDetail?.id ?? null)
        : null,
      input.cause.reason === 'engine_error'
        ? (input.cause.errorDetail?.hash ?? null)
        : null,
      cancelPayload ? canonicalJson(cancelPayload) : null,
      cancelPayloadHash,
      requestHash,
      input.nowMs,
    ],
  );
  insertGraphEvent(transaction, {
    graphRunId: input.graphRunId,
    sequence: input.sequence,
    scopeId: input.scope.id,
    nodeId: null,
    attemptId: null,
    eventType: 'scope_close_requested',
    idempotencyKey: `scope-close:${input.scope.id}`,
    payloadJson: payload,
    occurredAtMs: input.nowMs,
    createdAtMs: input.nowMs,
  });
  return {
    id: closeRequestId,
    scope_id: input.scope.id,
    reason: input.cause.reason,
    selected_rule_id:
      input.cause.reason === 'normal' ? input.cause.selectedRuleId : null,
    candidate_id:
      input.cause.reason === 'normal' ? input.cause.candidateId : null,
    eligibility_event_seq:
      input.cause.reason === 'normal' ? input.cause.eligibilityEventSeq : null,
    error_code:
      input.cause.reason === 'engine_error' ? input.cause.errorCode : null,
    error_detail_value_id:
      input.cause.reason === 'engine_error'
        ? (input.cause.errorDetail?.id ?? null)
        : null,
    error_detail_hash:
      input.cause.reason === 'engine_error'
        ? (input.cause.errorDetail?.hash ?? null)
        : null,
    cancel_payload_hash: cancelPayloadHash,
    request_hash: requestHash,
  };
}

function assertNormalCauseAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  scopeId: string,
  cause: ScopeCloseCause,
): void {
  if (cause.reason !== 'normal') return;
  const authority = transaction.queryOne<{
    candidate_id: string;
    eligibility_event_seq: number;
  }>(
    `SELECT selected_candidate_id AS candidate_id, eligibility_event_seq
       FROM workflow_graph_completion_eligibilities
      WHERE scope_id = ? AND rule_id = ?`,
    [scopeId, cause.selectedRuleId],
  );
  if (
    !authority ||
    authority.candidate_id !== cause.candidateId ||
    authority.eligibility_event_seq !== cause.eligibilityEventSeq
  )
    throw new G5RuntimeError(
      'precondition_failed',
      'T7a normal close does not match persisted eligibility authority',
    );
}

function assertReplay(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T7aCloseInput,
  prior: CloseRequestRow,
): T7aCloseReceipt {
  const expectedCancelHash =
    input.cause.reason === 'local_cancel' ||
    input.cause.reason === 'workflow_cancel'
      ? runtimeObjectHash('cancel-payload', input.cause.cancelPayload)
      : null;
  if (
    prior.reason !== input.cause.reason ||
    prior.selected_rule_id !==
      (input.cause.reason === 'normal' ? input.cause.selectedRuleId : null) ||
    prior.candidate_id !==
      (input.cause.reason === 'normal' ? input.cause.candidateId : null) ||
    prior.eligibility_event_seq !==
      (input.cause.reason === 'normal'
        ? input.cause.eligibilityEventSeq
        : null) ||
    prior.error_code !==
      (input.cause.reason === 'engine_error' ? input.cause.errorCode : null) ||
    prior.error_detail_value_id !==
      (input.cause.reason === 'engine_error'
        ? (input.cause.errorDetail?.id ?? null)
        : null) ||
    prior.error_detail_hash !==
      (input.cause.reason === 'engine_error'
        ? (input.cause.errorDetail?.hash ?? null)
        : null) ||
    prior.cancel_payload_hash !== expectedCancelHash
  )
    throw new G5RuntimeError(
      'idempotency_conflict',
      'T7a replay close cause differs from the committed request',
    );
  const manifest = transaction.queryOne<{
    id: string;
    scope_epochs_manifest_value_id: string;
    scope_epochs_manifest_hash: Sha256Hash;
    fenced_work_manifest_value_id: string;
    fenced_work_manifest_hash: Sha256Hash;
    cleanup_effect_keys_manifest_value_id: string;
    cleanup_effect_keys_manifest_hash: Sha256Hash;
    subtree_fence_hash: Sha256Hash;
  }>(
    `SELECT id, scope_epochs_manifest_value_id, scope_epochs_manifest_hash,
            fenced_work_manifest_value_id, fenced_work_manifest_hash,
            cleanup_effect_keys_manifest_value_id,
            cleanup_effect_keys_manifest_hash, subtree_fence_hash
       FROM workflow_graph_subtree_fence_manifests
      WHERE source_close_request_id = ? AND graph_run_id = ?`,
    [prior.id, input.graphRunId],
  );
  if (!manifest)
    throw new G5RuntimeError(
      'integrity_violation',
      'T7a close request exists without its atomic subtree fence manifest',
    );
  const valueBindings = [
    {
      id: manifest.scope_epochs_manifest_value_id,
      hash: manifest.scope_epochs_manifest_hash,
      domain: 'subtree-scope-epochs-manifest',
      kind: 'subtree-scope-epochs',
    },
    {
      id: manifest.fenced_work_manifest_value_id,
      hash: manifest.fenced_work_manifest_hash,
      domain: 'subtree-fenced-work-manifest',
      kind: 'subtree-fenced-work',
    },
    {
      id: manifest.cleanup_effect_keys_manifest_value_id,
      hash: manifest.cleanup_effect_keys_manifest_hash,
      domain: 'subtree-cleanup-keys-manifest',
      kind: 'subtree-cleanup-keys',
    },
  ] as const;
  let scopeEpochsContent: JsonValue | undefined;
  for (const binding of valueBindings) {
    const value = transaction.queryOne<{
      inline_canonical_json: string | null;
      content_hash: Sha256Hash;
      schema_resource_id: string | null;
      schema_resource_hash: Sha256Hash | null;
      payload_state: string;
    }>(
      `SELECT inline_canonical_json, content_hash, schema_resource_id,
              schema_resource_hash, payload_state
         FROM workflow_values WHERE id = ?`,
      [binding.id],
    );
    if (
      !value ||
      value.inline_canonical_json === null ||
      value.payload_state !== 'live' ||
      value.content_hash !== binding.hash ||
      value.schema_resource_id !== input.manifestSchema.rowId ||
      value.schema_resource_hash !== input.manifestSchema.hash
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'T7a replay manifest Value binding drifted',
      );
    let content: JsonValue;
    try {
      content = JSON.parse(value.inline_canonical_json) as JsonValue;
    } catch {
      throw new G5RuntimeError(
        'integrity_violation',
        'T7a replay manifest Value is not JSON',
      );
    }
    if (
      canonicalJson(content) !== value.inline_canonical_json ||
      runtimeObjectHash(binding.domain, content) !== binding.hash ||
      binding.id !==
        stableRuntimeId('value', {
          graph_run_id: input.graphRunId,
          source_close_request_id: prior.id,
          kind: binding.kind,
          content_hash: binding.hash,
        })
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'T7a replay manifest Value bytes/hash drifted',
      );
    if (binding.kind === 'subtree-scope-epochs') scopeEpochsContent = content;
  }
  const expectedFenceHash = runtimeObjectHash('subtree-fence-manifest', {
    graph_run_id: input.graphRunId,
    source_close_request_id: prior.id,
    scope_epochs_manifest_hash: manifest.scope_epochs_manifest_hash,
    fenced_work_manifest_hash: manifest.fenced_work_manifest_hash,
    cleanup_effect_keys_manifest_hash:
      manifest.cleanup_effect_keys_manifest_hash,
  });
  if (
    manifest.subtree_fence_hash !== expectedFenceHash ||
    manifest.id !==
      stableRuntimeId('subtree-fence', {
        graph_run_id: input.graphRunId,
        source_close_request_id: prior.id,
        subtree_fence_hash: expectedFenceHash,
      })
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T7a replay subtree fence identity drifted',
    );
  if (!Array.isArray(scopeEpochsContent) || scopeEpochsContent.length === 0)
    throw new G5RuntimeError(
      'integrity_violation',
      'T7a replay Scope epoch manifest is not a non-empty array',
    );
  const fencedScopeIds: string[] = [];
  let previousScopeId: string | undefined;
  for (const value of scopeEpochsContent) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new G5RuntimeError(
        'integrity_violation',
        'T7a replay Scope epoch manifest entry is malformed',
      );
    const entry = value as Record<string, JsonValue>;
    if (
      Object.keys(entry).sort().join(',') !==
        'close_request_id,new_epoch,old_epoch,scope_id' ||
      typeof entry.scope_id !== 'string' ||
      typeof entry.close_request_id !== 'string' ||
      !Number.isSafeInteger(entry.old_epoch) ||
      !Number.isSafeInteger(entry.new_epoch) ||
      (entry.old_epoch as number) < 0 ||
      entry.new_epoch !== (entry.old_epoch as number) + 1 ||
      (previousScopeId !== undefined && previousScopeId >= entry.scope_id)
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'T7a replay Scope epoch manifest entry drifted',
      );
    const scope = transaction.queryOne<{
      close_request_id: string | null;
      work_fence_epoch: number;
    }>(
      `SELECT close_request_id, work_fence_epoch
         FROM workflow_graph_scopes
        WHERE id = ? AND graph_run_id = ?`,
      [entry.scope_id, input.graphRunId],
    );
    if (
      !scope ||
      scope.close_request_id !== entry.close_request_id ||
      scope.work_fence_epoch < (entry.new_epoch as number)
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'T7a replay Scope epoch manifest authority drifted',
      );
    previousScopeId = entry.scope_id;
    fencedScopeIds.push(entry.scope_id);
  }
  return {
    disposition: 'exact_replay',
    closeRequestId: prior.id,
    subtreeFenceManifestId: manifest.id,
    fencedScopeIds,
    createdDescendantRequestIds: [],
  };
}

export function requestScopeCloseT7aInTransaction(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T7aCloseInput,
): T7aCloseReceipt {
  assertExactPublishedRegistryResource(
    transaction,
    input.manifestSchema,
    'T7a fence manifest schema',
  );
  const run = transaction.queryOne<RunRow>(
    `SELECT id, root_scope_id, lifecycle, control, operational_state,
            work_fence_epoch, next_event_seq, row_version
       FROM workflow_graph_runs WHERE id = ?`,
    [input.graphRunId],
  );
  const target = transaction.queryOne<ScopeRow>(
    `SELECT id, parent_scope_id, lifecycle, work_fence_epoch,
            close_request_id, row_version
       FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?`,
    [input.scopeId, input.graphRunId],
  );
  if (!run || !target)
    throw new G5RuntimeError('precondition_failed', 'T7a target is missing');
  const prior = transaction.queryOne<CloseRequestRow>(
    `SELECT id, scope_id, reason, selected_rule_id, candidate_id,
            eligibility_event_seq, error_code, error_detail_value_id,
            error_detail_hash, cancel_payload_hash, request_hash
       FROM workflow_graph_scope_close_requests
      WHERE graph_run_id = ? AND scope_id = ?`,
    [input.graphRunId, input.scopeId],
  );
  if (prior) return assertReplay(transaction, input, prior);
  const rootClose = input.scopeId === run.root_scope_id;
  if (
    run.operational_state !== 'healthy' ||
    run.row_version !== input.expectedRunRowVersion ||
    run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
    target.row_version !== input.expectedScopeRowVersion ||
    target.work_fence_epoch !== input.expectedScopeWorkFenceEpoch ||
    target.close_request_id !== null ||
    !(
      target.lifecycle === 'active' ||
      (rootClose &&
        target.lifecycle === 'materializing' &&
        input.cause.reason !== 'normal')
    ) ||
    !['initializing', 'executing'].includes(run.lifecycle)
  )
    throw new G5RuntimeError(
      'cas_conflict',
      'T7a run or target Scope authority is stale',
    );
  assertNormalCauseAuthority(transaction, target.id, input.cause);

  const subtree = transaction.queryAll<ScopeRow>(
    `WITH RECURSIVE subtree(
       id, parent_scope_id, lifecycle, work_fence_epoch, close_request_id,
       row_version
     ) AS (
       SELECT id, parent_scope_id, lifecycle, work_fence_epoch,
              close_request_id, row_version
         FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?
       UNION ALL
       SELECT child.id, child.parent_scope_id, child.lifecycle,
              child.work_fence_epoch, child.close_request_id, child.row_version
         FROM workflow_graph_scopes child
         JOIN subtree parent ON child.parent_scope_id = parent.id
        WHERE child.graph_run_id = ?
     ) SELECT * FROM subtree ORDER BY id COLLATE BINARY`,
    [input.scopeId, input.graphRunId, input.graphRunId],
  );
  if (subtree.length === 0)
    throw new G5RuntimeError('integrity_violation', 'T7a subtree is empty');

  let sequence = run.next_event_seq;
  const requestByScope = new Map<string, CloseRequestRow>();
  const createdDescendantRequestIds: string[] = [];
  for (const scope of subtree) {
    const existing = scope.close_request_id
      ? transaction.queryOne<CloseRequestRow>(
          `SELECT id, scope_id, reason, selected_rule_id, candidate_id,
                  eligibility_event_seq, error_code, error_detail_value_id,
                  error_detail_hash, cancel_payload_hash, request_hash
             FROM workflow_graph_scope_close_requests
            WHERE id = ? AND graph_run_id = ? AND scope_id = ?`,
          [scope.close_request_id, input.graphRunId, scope.id],
        )
      : undefined;
    if (scope.close_request_id !== null) {
      if (!existing)
        throw new G5RuntimeError(
          'integrity_violation',
          `T7a Scope ${scope.id} close authority drifted`,
        );
      requestByScope.set(scope.id, existing);
      continue;
    }
    if (scope.lifecycle === 'closed')
      throw new G5RuntimeError(
        'integrity_violation',
        `T7a closed Scope ${scope.id} has no close authority`,
      );
    sequence += 1;
    const request = insertCloseRequest(transaction, {
      graphRunId: input.graphRunId,
      scope,
      cause: scope.id === target.id ? input.cause : { reason: 'parent_close' },
      sequence,
      nowMs: input.nowMs,
    });
    requestByScope.set(scope.id, request);
    if (scope.id !== target.id) createdDescendantRequestIds.push(request.id);
  }
  const targetRequest = requestByScope.get(target.id)!;
  const fenceableScopes = subtree.filter(
    (scope) => scope.lifecycle !== 'closed',
  );

  const attemptIds = transaction.queryAll<{ id: string }>(
    `SELECT a.id FROM workflow_graph_node_attempts a
      WHERE a.graph_run_id = ? AND a.scope_id IN (${subtree.map(() => '?').join(',')})
        AND a.acceptance_state = 'open'
      ORDER BY a.id COLLATE BINARY`,
    [input.graphRunId, ...subtree.map((scope) => scope.id)],
  );
  const waitIds = transaction.queryAll<{
    id: string;
    resource_reservation_group_id: string;
  }>(
    `SELECT id, resource_reservation_group_id FROM workflow_graph_waits
      WHERE graph_run_id = ? AND scope_id IN (${subtree.map(() => '?').join(',')})
        AND status IN ('registering', 'armed')
      ORDER BY id COLLATE BINARY`,
    [input.graphRunId, ...subtree.map((scope) => scope.id)],
  );
  const buildIds = transaction.queryAll<{ id: string }>(
    `SELECT id FROM workflow_graph_scope_builds
      WHERE graph_run_id = ? AND owner_scope_id IN (${subtree.map(() => '?').join(',')})
        AND status IN ('pending_snapshot', 'ready_to_compile', 'compiling', 'compiled')
      ORDER BY id COLLATE BINARY`,
    [input.graphRunId, ...subtree.map((scope) => scope.id)],
  );
  const controllerRows = transaction.queryAll<{
    id: string;
    controller_reservation_group_id: string | null;
  }>(
    `SELECT id, controller_reservation_group_id FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id IN (${subtree.map(() => '?').join(',')})
        AND node_type IN ('subgraph', 'expand', 'map')
        AND controller_state IN ('sealing', 'running', 'closing_remaining')
      ORDER BY id COLLATE BINARY`,
    [input.graphRunId, ...subtree.map((scope) => scope.id)],
  );
  const mapSlots = transaction.queryAll<{ id: string; owner_scope_id: string }>(
    `SELECT id, owner_scope_id FROM workflow_graph_map_item_results
      WHERE graph_run_id = ? AND owner_scope_id IN (${subtree.map(() => '?').join(',')})
        AND outcome_state = 'open'
      ORDER BY owner_scope_id COLLATE BINARY, item_index`,
    [input.graphRunId, ...subtree.map((scope) => scope.id)],
  );

  transaction.execute(
    `UPDATE workflow_graph_node_attempts
        SET acceptance_state = 'fenced', lease_owner = NULL, lease_token = NULL,
            lease_expires_at_ms = NULL, evaluation_lease_owner = NULL,
            evaluation_lease_token = NULL, evaluation_lease_expires_at_ms = NULL,
            row_version = row_version + 1, updated_at_ms = ?
      WHERE graph_run_id = ? AND scope_id IN (${subtree.map(() => '?').join(',')})
        AND acceptance_state = 'open'`,
    [input.nowMs, input.graphRunId, ...subtree.map((scope) => scope.id)],
  );
  transaction.execute(
    `UPDATE workflow_graph_waits
        SET status = 'cancelled', armed_at_ms = COALESCE(armed_at_ms, ?),
            resolved_at_ms = ?, registration_lease_owner = NULL,
            registration_lease_token = NULL,
            registration_lease_expires_at_ms = NULL,
            row_version = row_version + 1, updated_at_ms = ?
      WHERE graph_run_id = ? AND scope_id IN (${subtree.map(() => '?').join(',')})
        AND status IN ('registering', 'armed')`,
    [
      input.nowMs,
      input.nowMs,
      input.nowMs,
      input.graphRunId,
      ...subtree.map((scope) => scope.id),
    ],
  );
  transaction.execute(
    `UPDATE workflow_graph_scope_builds
        SET status = 'fenced', lease_owner = NULL, lease_token = NULL,
            lease_expires_at_ms = NULL, row_version = row_version + 1,
            updated_at_ms = ?
      WHERE graph_run_id = ? AND owner_scope_id IN (${subtree.map(() => '?').join(',')})
        AND status IN ('pending_snapshot', 'ready_to_compile', 'compiling', 'compiled')`,
    [input.nowMs, input.graphRunId, ...subtree.map((scope) => scope.id)],
  );
  for (const slot of mapSlots) {
    const request = requestByScope.get(slot.owner_scope_id)!;
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_graph_map_item_results
            SET outcome_state = 'fenced', reason = 'parent_close',
                fence_event_seq = ?, resolved_at_ms = ?, row_version = row_version + 1
          WHERE id = ? AND outcome_state = 'open'`,
        [
          transaction.queryOne<{ trigger_event_seq: number }>(
            'SELECT trigger_event_seq FROM workflow_graph_scope_close_requests WHERE id = ?',
            [request.id],
          )!.trigger_event_seq,
          input.nowMs,
          slot.id,
        ],
      ).changes,
      `T7a map slot fence ${slot.id}`,
    );
  }
  transaction.execute(
    `UPDATE workflow_graph_nodes
        SET controller_state = 'closing_remaining', row_version = row_version + 1,
            updated_at_ms = ?
      WHERE graph_run_id = ? AND scope_id IN (${subtree.map(() => '?').join(',')})
        AND node_type IN ('subgraph', 'expand', 'map')
        AND controller_state IN ('sealing', 'running')`,
    [input.nowMs, input.graphRunId, ...subtree.map((scope) => scope.id)],
  );
  const reservationGroups = new Set<string>();
  for (const wait of waitIds)
    reservationGroups.add(wait.resource_reservation_group_id);
  for (const controller of controllerRows) {
    if (controller.controller_reservation_group_id)
      reservationGroups.add(controller.controller_reservation_group_id);
  }
  for (const groupId of [...reservationGroups].sort())
    releaseLedgerReservationGroup(
      transaction,
      input.graphRunId,
      groupId,
      input.nowMs,
    );

  const effects = transaction.queryAll<{
    id: string;
    scope_id: string;
    status: string;
  }>(
    `SELECT id, scope_id, status FROM workflow_graph_effect_operations
      WHERE graph_run_id = ? AND scope_id IN (${subtree.map(() => '?').join(',')})
        AND execution_lane = 'normal'
        AND status IN ('intended', 'dispatched', 'succeeded', 'failed')
      ORDER BY id COLLATE BINARY`,
    [input.graphRunId, ...subtree.map((scope) => scope.id)],
  );

  const scopeEpochs = fenceableScopes.map((scope) => ({
    scope_id: scope.id,
    old_epoch: scope.work_fence_epoch,
    new_epoch: scope.work_fence_epoch + 1,
    close_request_id: requestByScope.get(scope.id)!.id,
  }));
  const fencedWork = {
    attempt_ids: attemptIds.map((row) => row.id),
    wait_ids: waitIds.map((row) => row.id),
    build_ids: buildIds.map((row) => row.id),
    controller_ids: controllerRows.map((row) => row.id),
    map_slot_ids: mapSlots.map((row) => row.id),
  };
  const cleanupKeys = effects.map((effect) => ({
    effect_id: effect.id,
    close_request_id: requestByScope.get(effect.scope_id)!.id,
    cleanup_key: `close-cleanup:${requestByScope.get(effect.scope_id)!.id}:${effect.id}`,
  }));
  const scopeEpochsHash = runtimeObjectHash(
    'subtree-scope-epochs-manifest',
    scopeEpochs,
  );
  const fencedWorkHash = runtimeObjectHash(
    'subtree-fenced-work-manifest',
    fencedWork,
  );
  const cleanupKeysHash = runtimeObjectHash(
    'subtree-cleanup-keys-manifest',
    cleanupKeys,
  );
  const scopeEpochsValueId = stableRuntimeId('value', {
    graph_run_id: input.graphRunId,
    source_close_request_id: targetRequest.id,
    kind: 'subtree-scope-epochs',
    content_hash: scopeEpochsHash,
  });
  const fencedWorkValueId = stableRuntimeId('value', {
    graph_run_id: input.graphRunId,
    source_close_request_id: targetRequest.id,
    kind: 'subtree-fenced-work',
    content_hash: fencedWorkHash,
  });
  const cleanupKeysValueId = stableRuntimeId('value', {
    graph_run_id: input.graphRunId,
    source_close_request_id: targetRequest.id,
    kind: 'subtree-cleanup-keys',
    content_hash: cleanupKeysHash,
  });
  for (const value of [
    {
      id: scopeEpochsValueId,
      content: scopeEpochs,
      hash: scopeEpochsHash,
      provenance: `t7a:${targetRequest.id}:scope-epochs`,
    },
    {
      id: fencedWorkValueId,
      content: fencedWork,
      hash: fencedWorkHash,
      provenance: `t7a:${targetRequest.id}:fenced-work`,
    },
    {
      id: cleanupKeysValueId,
      content: cleanupKeys,
      hash: cleanupKeysHash,
      provenance: `t7a:${targetRequest.id}:cleanup-keys`,
    },
  ])
    insertInlineValue(transaction, {
      id: value.id,
      content: value.content,
      contentHash: value.hash,
      schemaResourceId: input.manifestSchema.rowId,
      schemaResourceHash: input.manifestSchema.hash,
      provenanceRef: value.provenance,
      retentionClass: 'run_recovery',
      ownerGraphRunId: input.graphRunId,
      createdAtMs: input.nowMs,
    });

  for (const effect of effects) {
    const request = requestByScope.get(effect.scope_id)!;
    const terminalWithoutApply = effect.status !== 'succeeded';
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_graph_effect_operations
            SET execution_lane = 'close_cleanup', close_request_id = ?,
                status = ?, compensation_value_id = ?, compensation_hash = ?,
                lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
                row_version = row_version + 1, updated_at_ms = ?
          WHERE id = ? AND execution_lane = 'normal' AND status = ?`,
        [
          request.id,
          terminalWithoutApply
            ? 'compensation_not_required'
            : 'compensation_pending',
          terminalWithoutApply ? cleanupKeysValueId : null,
          terminalWithoutApply ? cleanupKeysHash : null,
          input.nowMs,
          effect.id,
          effect.status,
        ],
      ).changes,
      `T7a cleanup effect ${effect.id}`,
    );
  }

  for (const scope of fenceableScopes) {
    const request = requestByScope.get(scope.id)!;
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_graph_scopes
            SET lifecycle = 'closing', close_request_id = ?,
                work_fence_epoch = work_fence_epoch + 1,
                row_version = row_version + 1, updated_at_ms = ?
          WHERE id = ? AND graph_run_id = ? AND row_version = ?
            AND work_fence_epoch = ? AND lifecycle <> 'closed'`,
        [
          request.id,
          input.nowMs,
          scope.id,
          input.graphRunId,
          scope.row_version,
          scope.work_fence_epoch,
        ],
      ).changes,
      `T7a Scope fence ${scope.id}`,
    );
  }

  sequence += 1;
  const subtreeFencePayload = {
    graph_run_id: input.graphRunId,
    source_close_request_id: targetRequest.id,
    scope_epochs_manifest_hash: scopeEpochsHash,
    fenced_work_manifest_hash: fencedWorkHash,
    cleanup_effect_keys_manifest_hash: cleanupKeysHash,
  };
  const subtreeFenceHash = runtimeObjectHash(
    'subtree-fence-manifest',
    subtreeFencePayload,
  );
  const subtreeFenceManifestId = stableRuntimeId('subtree-fence', {
    graph_run_id: input.graphRunId,
    source_close_request_id: targetRequest.id,
    subtree_fence_hash: subtreeFenceHash,
  });
  transaction.execute(
    `INSERT INTO workflow_graph_subtree_fence_manifests (
       id, graph_run_id, source_close_request_id,
       scope_epochs_manifest_value_id, scope_epochs_manifest_hash,
       fenced_work_manifest_value_id, fenced_work_manifest_hash,
       cleanup_effect_keys_manifest_value_id,
       cleanup_effect_keys_manifest_hash, subtree_fence_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      subtreeFenceManifestId,
      input.graphRunId,
      targetRequest.id,
      scopeEpochsValueId,
      scopeEpochsHash,
      fencedWorkValueId,
      fencedWorkHash,
      cleanupKeysValueId,
      cleanupKeysHash,
      subtreeFenceHash,
      input.nowMs,
    ],
  );
  insertGraphEvent(transaction, {
    graphRunId: input.graphRunId,
    sequence,
    scopeId: input.scopeId,
    nodeId: null,
    attemptId: null,
    eventType: 'subtree_fenced',
    idempotencyKey: `subtree-fenced:${targetRequest.id}`,
    payloadJson: subtreeFencePayload,
    occurredAtMs: input.nowMs,
    createdAtMs: input.nowMs,
  });

  const runChanged = rootClose
    ? transaction.execute(
        `UPDATE workflow_graph_runs
            SET lifecycle = 'closing', root_close_request_id = ?,
                work_fence_epoch = work_fence_epoch + 1, next_event_seq = ?,
                row_version = row_version + 1, updated_at_ms = ?
          WHERE id = ? AND row_version = ? AND work_fence_epoch = ?
            AND lifecycle IN ('initializing', 'executing')`,
        [
          targetRequest.id,
          sequence,
          input.nowMs,
          input.graphRunId,
          input.expectedRunRowVersion,
          input.expectedRunWorkFenceEpoch,
        ],
      ).changes
    : transaction.execute(
        `UPDATE workflow_graph_runs
            SET next_event_seq = ?, row_version = row_version + 1,
                updated_at_ms = ?
          WHERE id = ? AND row_version = ? AND work_fence_epoch = ?`,
        [
          sequence,
          input.nowMs,
          input.graphRunId,
          input.expectedRunRowVersion,
          input.expectedRunWorkFenceEpoch,
        ],
      ).changes;
  requireSingleChange(runChanged, 'T7a Run fence');

  assertNoDeferredForeignKeyViolations(transaction, 'T7a');
  return {
    disposition: 'close_requested',
    closeRequestId: targetRequest.id,
    subtreeFenceManifestId,
    fencedScopeIds: fenceableScopes.map((scope) => scope.id),
    createdDescendantRequestIds,
  };
}

export function requestScopeCloseT7a(
  store: WorkflowRuntimeStore,
  input: T7aCloseInput,
  fault?: G5TransactionFault,
): T7aCloseReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => requestScopeCloseT7aInTransaction(transaction, input),
    fault,
  );
}

export interface G7RecoveryInput {
  readonly graphRunId: string;
  readonly expectedRunRowVersion: number;
  readonly integrityEvidence: RuntimeValueRef;
  readonly remediationPolicy: RuntimeRegistryRef;
  readonly remediationDeadlineAtMs: number;
  readonly nowMs: number;
}

export interface G7RecoveryReceipt {
  readonly disposition: 'stable' | 'resumed' | 'quarantined';
  readonly eventSequence: number | null;
  readonly blockerId: string | null;
  readonly finding: string | null;
}

export function coordinateGraphRecoveryG7(
  store: WorkflowRuntimeStore,
  input: G7RecoveryInput,
  fault?: G5TransactionFault,
): G7RecoveryReceipt {
  if (
    !Number.isSafeInteger(input.expectedRunRowVersion) ||
    input.expectedRunRowVersion < 0 ||
    !Number.isSafeInteger(input.remediationDeadlineAtMs) ||
    input.remediationDeadlineAtMs < input.nowMs
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'G7 recovery CAS or remediation deadline is invalid',
    );
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const authority = transaction.queryOne<{
        workflow_id: string;
        lifecycle: string;
        control: string;
        operational_state: string;
        root_close_request_id: string | null;
        completion_cut_id: string | null;
        next_event_seq: number;
        row_version: number;
        workflow_status: string;
        workflow_operational_state: string;
        current_graph_run_id: string | null;
        open_action_required: number;
        open_quarantine: number;
        close_manifest_count: number;
      }>(
        `SELECT r.workflow_id, r.lifecycle, r.control, r.operational_state,
                r.root_close_request_id, r.completion_cut_id, r.next_event_seq,
                r.row_version, w.status AS workflow_status,
                w.operational_state AS workflow_operational_state,
                w.current_graph_run_id,
                (SELECT count(*) FROM workflow_operational_blockers b
                  WHERE b.graph_run_id = r.id AND b.status = 'open'
                    AND b.severity = 'action_required') AS open_action_required,
                (SELECT count(*) FROM workflow_operational_blockers b
                  WHERE b.graph_run_id = r.id AND b.status = 'open'
                    AND b.severity = 'quarantine') AS open_quarantine,
                (SELECT count(*)
                   FROM workflow_graph_subtree_fence_manifests m
                  WHERE m.graph_run_id = r.id
                    AND m.source_close_request_id = r.root_close_request_id)
                  AS close_manifest_count
           FROM workflow_graph_runs r JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
        [input.graphRunId],
      );
      if (!authority)
        throw new G5RuntimeError(
          'precondition_failed',
          'G7 recovery target Run does not exist',
        );
      if (authority.row_version !== input.expectedRunRowVersion)
        throw new G5RuntimeError('cas_conflict', 'G7 recovery Run CAS failed');

      const expectedOperationalState =
        authority.open_quarantine > 0
          ? 'quarantined'
          : authority.open_action_required > 0
            ? 'action_required'
            : 'healthy';
      let finding: string | null = null;
      if (
        authority.operational_state !== 'administratively_abandoned' &&
        (authority.operational_state !== expectedOperationalState ||
          authority.workflow_operational_state !== expectedOperationalState)
      )
        finding = 'operational_blocker_cache_mismatch';
      else if (
        (authority.operational_state === 'administratively_abandoned') !==
        (authority.workflow_operational_state === 'administratively_abandoned')
      )
        finding = 'administrative_abandon_cache_mismatch';
      else if (
        authority.workflow_status === 'active' &&
        authority.current_graph_run_id !== input.graphRunId
      )
        finding = 'current_run_binding_mismatch';
      else if (
        authority.root_close_request_id !== null &&
        authority.close_manifest_count !== 1
      )
        finding = 'close_manifest_missing_or_duplicated';
      else if (
        (authority.lifecycle === 'closed') !==
        (authority.completion_cut_id !== null)
      )
        finding = 'completion_cut_lifecycle_mismatch';

      if (finding !== null) {
        assertExactPublishedRegistryResource(
          transaction,
          input.remediationPolicy,
          'G7 Recovery remediation policy',
        );
        const evidence = transaction.queryOne<{
          content_hash: string;
          payload_state: string;
        }>(
          'SELECT content_hash, payload_state FROM workflow_values WHERE id = ?',
          [input.integrityEvidence.id],
        );
        if (
          !evidence ||
          evidence.content_hash !== input.integrityEvidence.hash ||
          evidence.payload_state !== 'live'
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'G7 Recovery integrity evidence is unavailable',
          );
        const findingSequence = authority.next_event_seq + 1;
        const blockerSequence = findingSequence + 1;
        const blockerId = stableRuntimeId('blocker', {
          graph_run_id: input.graphRunId,
          blocker_kind: 'integrity_quarantine',
          source_kind: 'event',
          source_identity: findingSequence,
        });
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence: findingSequence,
          scopeId: null,
          nodeId: null,
          attemptId: null,
          eventType: 'recovery_decision_recorded',
          idempotencyKey: `recovery-finding:${blockerId}`,
          payloadJson: {
            disposition: 'quarantined',
            finding,
            blocker_id: blockerId,
          },
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence: blockerSequence,
          scopeId: null,
          nodeId: null,
          attemptId: null,
          eventType: 'operational_blocker_changed',
          idempotencyKey: `blocker-open:${blockerId}`,
          payloadJson: {
            blocker_id: blockerId,
            status: 'open',
            severity: 'quarantine',
          },
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        transaction.execute(
          `INSERT INTO workflow_operational_blockers (
             id, workflow_id, graph_run_id, blocker_kind, severity,
             source_effect_operation_id, source_outbox_id,
             source_root_finalization_schedule_id, source_claim_id,
             source_event_seq, error_code, evidence_manifest_value_id,
             evidence_manifest_hash, status, remediation_policy_resource_id,
             remediation_policy_resource_hash, remediation_attempt_count,
             next_remediation_at_ms, remediation_deadline_at_ms,
             opened_event_seq, resolved_event_seq, resolution_command_id,
             resolution_value_id, resolution_hash, row_version, opened_at_ms,
             resolved_at_ms, abandoned_at_ms
           ) VALUES (?, ?, ?, 'integrity_quarantine', 'quarantine',
             NULL, NULL, NULL, NULL, ?, ?, ?, ?, 'open', ?, ?, 0, NULL, ?, ?,
             NULL, NULL, NULL, NULL, 1, ?, NULL, NULL)`,
          [
            blockerId,
            authority.workflow_id,
            input.graphRunId,
            findingSequence,
            finding,
            input.integrityEvidence.id,
            input.integrityEvidence.hash,
            input.remediationPolicy.rowId,
            input.remediationPolicy.hash,
            input.remediationDeadlineAtMs,
            blockerSequence,
            input.nowMs,
          ],
        );
        const refreshed = transaction.queryOne<{ row_version: number }>(
          'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
          [input.graphRunId],
        )!;
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_runs SET next_event_seq = ?,
                    row_version = row_version + 1, updated_at_ms = ?
              WHERE id = ? AND row_version = ?`,
            [
              blockerSequence,
              input.nowMs,
              input.graphRunId,
              refreshed.row_version,
            ],
          ).changes,
          'G7 Recovery quarantine event head',
        );
        assertNoDeferredForeignKeyViolations(
          transaction,
          'G7 Recovery quarantine',
        );
        return {
          disposition: 'quarantined',
          eventSequence: findingSequence,
          blockerId,
          finding,
        };
      }

      if (authority.control !== 'resuming')
        return {
          disposition: 'stable',
          eventSequence: null,
          blockerId: null,
          finding: null,
        };
      if (
        authority.operational_state !== 'healthy' ||
        authority.lifecycle === 'closed'
      )
        throw new G5RuntimeError(
          'precondition_failed',
          'G7 Recovery cannot resume an unhealthy or closed Run',
        );
      const sequence = authority.next_event_seq + 1;
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId: null,
        nodeId: null,
        attemptId: null,
        eventType: 'recovery_decision_recorded',
        idempotencyKey: `recovery-resume:${input.graphRunId}:${authority.row_version}`,
        payloadJson: {
          disposition: 'resumed',
          lifecycle: authority.lifecycle,
          preserved_work_fence: true,
          preserved_deadline_ledger_attempts: true,
        },
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_runs SET control = 'running', next_event_seq = ?,
                  row_version = row_version + 1, updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND control = 'resuming'
              AND operational_state = 'healthy' AND lifecycle <> 'closed'`,
          [sequence, input.nowMs, input.graphRunId, authority.row_version],
        ).changes,
        'G7 Recovery resume CAS',
      );
      assertNoDeferredForeignKeyViolations(transaction, 'G7 Recovery resume');
      return {
        disposition: 'resumed',
        eventSequence: sequence,
        blockerId: null,
        finding: null,
      };
    },
    fault,
  );
}
