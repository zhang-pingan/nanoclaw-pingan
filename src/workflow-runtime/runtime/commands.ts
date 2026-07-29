import type { CapacitySnapshotWatcher } from '../capacity/publication.js';
import type { WorkflowRuntimeCommandDocument } from '../contracts/closed-schema-types.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import { canonicalJson } from '../contracts/hash.js';
import {
  RUNTIME_COMMAND_PROTOCOL_ENTRIES,
  type RuntimeCommandProtocolEntry,
} from '../contracts/protocol-table-types.js';
import type {
  CommandActorKind,
  RuntimeCommandDenialCode,
  RuntimePermissionCode,
  WorkflowCommandType,
} from '../contracts/catalog-protocol-types.js';
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
  loadInlineValue,
  requireSingleChange,
  runImmediateG5Transaction,
  runtimeObjectHash,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import { requestScopeCloseT7aInTransaction } from './graph-runtime.js';
import { chargeAndInsertGraphFact } from './ledger.js';
import { consumeExistingRetryScheduleT6dInTransaction } from './node-execution.js';
import {
  commitRootT8InTransaction,
  type T8RootCommitInput,
} from './root-finalizer.js';

const SYSTEM_DEADLINE_ACTOR = 'system:deadline-watchdog';
const SYSTEM_DEADLINE_DOMAIN = 'system:deadline-watchdog';
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const EVIDENCE_REQUIRED_REASONS = new Set([
  'dependency_recovered',
  'credential_restored',
  'receipt_recovered',
  'provider_reconciled',
  'not_applied_verified',
  'backup_restored',
  'hash_revalidated',
  'deadline_enforced',
  'safety_enforced',
  'unrecoverable_state',
  'external_effect_unverifiable',
  'data_loss_accepted',
]);

export interface G7CommandPolicy extends JsonObject {
  readonly command_policy_allow_pause: boolean;
  readonly command_policy_allow_resume: boolean;
  readonly command_policy_allows_local_graph_cancel: boolean;
  readonly command_policy_allows_workflow_cancel: boolean;
  readonly command_policy_allow_manual_skip: boolean;
  readonly command_policy_allow_retry_wait_advance: boolean;
  readonly receipt_remediation_contract_allows_reconcile: boolean;
  readonly receipt_remediation_contract_allows_verified_receipt: boolean;
  readonly receipt_remediation_contract_allows_not_applied_proof: boolean;
  readonly command_policy_administrative_abandon_allowed: boolean;
  readonly administrative_abandon_release_claims: false;
}

export interface AuthenticatedRuntimeCommandActor {
  readonly authenticated: true;
  readonly actorRef: string;
  readonly actorKind: CommandActorKind;
  readonly authSessionRef: string;
  readonly entrypoint:
    | 'runtime_center'
    | 'feature_page'
    | 'feature_host_api'
    | 'external_api'
    | 'automation'
    | 'card_action'
    | 'deadline_watchdog';
  readonly sourceFeatureId: string | null;
  readonly delegationChainRef: string | null;
  readonly permissions: ReadonlySet<RuntimePermissionCode>;
  readonly featurePermissionCeiling: ReadonlySet<RuntimePermissionCode> | null;
}

export type G7SourceVerification =
  | { readonly kind: 'retry_wait'; readonly nextEligibleAtMs: number }
  | { readonly kind: 'effect_not_applied'; readonly operationKey: string }
  | {
      readonly kind: 'effect_receipt';
      readonly operationKey: string;
      readonly receipt: RuntimeValueRef;
      readonly afterSnapshot: RuntimeValueRef;
      readonly immutableOutputSnapshot: RuntimeValueRef;
    }
  | {
      readonly kind: 'compensation_succeeded';
      readonly operationKey: string;
      readonly compensation: RuntimeValueRef;
    }
  | { readonly kind: 'claim_released'; readonly claimId: string }
  | {
      readonly kind: 'resource_preflight_scheduled';
      readonly retryScheduleId: string;
    }
  | {
      readonly kind: 'integrity_restored';
      readonly expectedHash: Sha256Hash;
      readonly restoredHash: Sha256Hash;
      readonly fullChainVerified: true;
    }
  | {
      readonly kind: 'root_finalization_ready';
      readonly scheduleId: string;
      readonly rootCommit: T8RootCommitInput;
    };

export interface RuntimeCommandGatewayInput {
  readonly command: WorkflowRuntimeCommandDocument;
  readonly actor: AuthenticatedRuntimeCommandActor;
  readonly auditSchema: RuntimeRegistryRef;
  readonly fenceManifestSchema: RuntimeRegistryRef;
  readonly capacityWatcher: Pick<CapacitySnapshotWatcher, 'current'>;
  readonly verification?: G7SourceVerification;
  readonly nowMs: number;
}

export interface RuntimeCommandGatewayReceipt {
  readonly ingressInvocationId: string;
  readonly commandId: string | null;
  readonly invocationId: string | null;
  readonly executionResult:
    | 'applied'
    | 'denied'
    | 'conflict'
    | 'duplicate'
    | 'late';
  readonly denialCode: RuntimeCommandDenialCode | null;
  readonly canonicalResult: JsonObject;
}

type RuntimeCommandClaimedTargetKind =
  | 'workflow'
  | 'run'
  | 'node'
  | 'retry_schedule'
  | 'effect_operation'
  | 'operational_blocker';

interface RuntimeCommandClaimedTarget {
  readonly kind: RuntimeCommandClaimedTargetKind;
  readonly id: string;
}

interface PreparedRuntimeCommandIngress {
  readonly id: string;
  readonly requestHash: Sha256Hash;
  readonly domain: string;
  readonly claimedTarget: RuntimeCommandClaimedTarget;
}

interface TargetAuthority extends Record<string, unknown> {
  workflow_id: string;
  workflow_status: string;
  workflow_operational_state: string;
  workflow_row_version: number;
  owner_principal_ref: string;
  controlling_feature_id: string | null;
  creator_automation_ref: string | null;
  command_policy_resource_id: string;
  command_policy_resource_hash: Sha256Hash;
  run_id: string | null;
  run_lifecycle: string | null;
  run_control: string | null;
  run_operational_state: string | null;
  run_row_version: number | null;
  run_work_fence_epoch: number | null;
  run_next_event_seq: number | null;
  root_scope_id: string | null;
  root_scope_row_version: number | null;
  root_scope_work_fence_epoch: number | null;
  root_close_request_id: string | null;
  target_row_version: number;
  node_id: string | null;
  node_phase: string | null;
  node_scope_id: string | null;
  retry_schedule_id: string | null;
  retry_status: string | null;
  effect_operation_id: string | null;
  effect_status: string | null;
  effect_operation_key: string | null;
  blocker_id: string | null;
  blocker_kind: string | null;
  blocker_status: string | null;
  blocker_severity: string | null;
  blocker_row_version: number | null;
  blocker_policy_resource_id: string | null;
  blocker_policy_resource_hash: Sha256Hash | null;
  blocker_attempt_count: number | null;
  blocker_deadline_at_ms: number | null;
  blocker_source_claim_id: string | null;
  blocker_source_root_finalization_schedule_id: string | null;
}

interface ExecutionOutcome {
  readonly executionResult: RuntimeCommandGatewayReceipt['executionResult'];
  readonly denialCode: RuntimeCommandDenialCode | null;
  readonly resultingEventSeq: number | null;
  readonly closeRequestId: string | null;
  readonly effectOperationId: string | null;
  readonly result: JsonObject;
}

function assertCommandShape(
  command: WorkflowRuntimeCommandDocument,
): {
  entry: RuntimeCommandProtocolEntry;
  claimedTarget: RuntimeCommandClaimedTarget;
} {
  const entry = RUNTIME_COMMAND_PROTOCOL_ENTRIES.find(
    (candidate) => candidate.command_type === command.command_type,
  );
  if (!entry)
    throw new G5RuntimeError('contract_invalid', 'Unknown command type');
  const expectedKeys = new Set([
    'command_id',
    'idempotency_key',
    'expected_row_version',
    'reason_code',
    'evidence_refs',
    'command_type',
    'target',
    ...(command.command_type === 'confirm_administrative_abandon'
      ? ['confirmation_ref']
      : []),
    ...(command.reason_text === undefined ? [] : ['reason_text']),
  ]);
  if (
    !COMMAND_ID_PATTERN.test(command.command_id) ||
    command.idempotency_key.length < 1 ||
    command.idempotency_key.length > 512 ||
    !Number.isSafeInteger(command.expected_row_version) ||
    command.expected_row_version < 0 ||
    Object.keys(command).some((key) => !expectedKeys.has(key)) ||
    Object.keys(command).length !== expectedKeys.size ||
    !Array.isArray(command.evidence_refs) ||
    command.evidence_refs.some(
      (ref) => typeof ref !== 'string' || ref.length === 0,
    ) ||
    new Set(command.evidence_refs).size !== command.evidence_refs.length ||
    (command.reason_text !== undefined &&
      (command.reason_text.length < 1 || command.reason_text.length > 4096))
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'Runtime command shape is invalid',
    );
  const target = command.target as unknown as Record<string, unknown>;
  const targetKeys = {
    workflow_id: 'workflow',
    run_id: 'run',
    node_id: 'node',
    retry_schedule_id: 'retry_schedule',
    effect_operation_id: 'effect_operation',
    operational_blocker_id: 'operational_blocker',
  } as const;
  const targetKey = Object.keys(target)[0] as keyof typeof targetKeys;
  if (
    Object.keys(target).length !== 1 ||
    !(targetKey in targetKeys) ||
    typeof target[targetKey] !== 'string' ||
    String(target[targetKey]).length === 0
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'Runtime command typed target is invalid',
    );
  return {
    entry,
    claimedTarget: {
      kind: targetKeys[targetKey],
      id: String(target[targetKey]),
    },
  };
}

function targetId(command: WorkflowRuntimeCommandDocument): string {
  return Object.values(command.target)[0]!;
}

function idempotencyDomain(input: RuntimeCommandGatewayInput): string {
  if (input.actor.actorKind === 'system') return SYSTEM_DEADLINE_DOMAIN;
  const source = input.actor.sourceFeatureId ?? input.actor.entrypoint;
  return `${input.actor.actorKind}:${input.actor.actorRef}:${source}`;
}

function parseCanonicalIngressJson(
  bytes: string,
  label: string,
): JsonValue {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(bytes) as JsonValue;
  } catch (error) {
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} is not valid JSON`,
      { cause: error },
    );
  }
  if (canonicalJson(parsed) !== bytes)
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} is not canonical JSON`,
    );
  return parsed;
}

function assertRuntimeCommandIngressHistory(
  transaction: WorkflowRuntimeWriteTransaction,
  domain: string,
  idempotencyKey: string,
): void {
  const history = transaction.queryAll<{
    id: string;
    ingress_no: number;
    submitted_command_id: string;
    canonical_request_json: string;
    submitted_request_hash: Sha256Hash;
    command_type: WorkflowCommandType;
    claimed_target_kind: RuntimeCommandClaimedTargetKind;
    claimed_workflow_id: string | null;
    claimed_run_id: string | null;
    claimed_node_id: string | null;
    claimed_retry_schedule_id: string | null;
    claimed_effect_operation_id: string | null;
    claimed_operational_blocker_id: string | null;
    resolution_result: string;
    canonical_result_json: string | null;
    canonical_result_hash: Sha256Hash | null;
  }>(
    `SELECT id, ingress_no, submitted_command_id, canonical_request_json,
            submitted_request_hash, command_type, claimed_target_kind,
            claimed_workflow_id, claimed_run_id, claimed_node_id,
            claimed_retry_schedule_id, claimed_effect_operation_id,
            claimed_operational_blocker_id, resolution_result,
            canonical_result_json, canonical_result_hash
       FROM workflow_runtime_command_ingress_invocations
      WHERE idempotency_domain = ? AND idempotency_key = ?
      ORDER BY ingress_no`,
    [domain, idempotencyKey],
  );
  for (const [index, row] of history.entries()) {
    const request = parseCanonicalIngressJson(
      row.canonical_request_json,
      'Runtime Command ingress request',
    );
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new G5RuntimeError(
        'integrity_violation',
        'Runtime Command ingress request is not an object',
      );
    let parsed: ReturnType<typeof assertCommandShape>;
    try {
      parsed = assertCommandShape(
        request as unknown as WorkflowRuntimeCommandDocument,
      );
    } catch (error) {
      throw new G5RuntimeError(
        'integrity_violation',
        'Runtime Command ingress request no longer satisfies the closed contract',
        { cause: error },
      );
    }
    const expectedNo = index + 1;
    const expectedId = stableRuntimeId('runtime-command-ingress', {
      idempotency_domain: domain,
      idempotency_key: idempotencyKey,
      ingress_no: expectedNo,
    }).replace(/^g5:/, '');
    const claimedColumns: Record<RuntimeCommandClaimedTargetKind, string | null> = {
      workflow: row.claimed_workflow_id,
      run: row.claimed_run_id,
      node: row.claimed_node_id,
      retry_schedule: row.claimed_retry_schedule_id,
      effect_operation: row.claimed_effect_operation_id,
      operational_blocker: row.claimed_operational_blocker_id,
    };
    if (
      row.ingress_no !== expectedNo ||
      row.id !== expectedId ||
      runtimeObjectHash('runtime-command-request', request) !==
        row.submitted_request_hash ||
      row.submitted_command_id !== String(request.command_id) ||
      row.command_type !== parsed.entry.command_type ||
      row.claimed_target_kind !== parsed.claimedTarget.kind ||
      claimedColumns[row.claimed_target_kind] !== parsed.claimedTarget.id ||
      row.resolution_result === 'prepared' ||
      row.canonical_result_json === null ||
      row.canonical_result_hash === null
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'Runtime Command ingress identity or terminal authority drifted',
      );
    const result = parseCanonicalIngressJson(
      row.canonical_result_json,
      'Runtime Command ingress result',
    );
    if (
      runtimeObjectHash('runtime-command-ingress-result', result) !==
      row.canonical_result_hash
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'Runtime Command ingress result hash authority drifted',
      );
  }
}

function prepareRuntimeCommandIngress(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  claimedTarget: RuntimeCommandClaimedTarget,
): PreparedRuntimeCommandIngress {
  const requestHash = runtimeObjectHash(
    'runtime-command-request',
    input.command as unknown as JsonObject,
  );
  const domain = idempotencyDomain(input);
  const ingressNo = transaction.queryOne<{ next_no: number }>(
    `SELECT coalesce(max(ingress_no), 0) + 1 AS next_no
       FROM workflow_runtime_command_ingress_invocations
      WHERE idempotency_domain = ? AND idempotency_key = ?`,
    [domain, input.command.idempotency_key],
  )!.next_no;
  const id = stableRuntimeId('runtime-command-ingress', {
    idempotency_domain: domain,
    idempotency_key: input.command.idempotency_key,
    ingress_no: ingressNo,
  }).replace(/^g5:/, '');
  const targets: Record<RuntimeCommandClaimedTargetKind, string | null> = {
    workflow: null,
    run: null,
    node: null,
    retry_schedule: null,
    effect_operation: null,
    operational_blocker: null,
  };
  targets[claimedTarget.kind] = claimedTarget.id;
  transaction.execute(
    `INSERT INTO workflow_runtime_command_ingress_invocations (
       id, idempotency_domain, idempotency_key, ingress_no,
       submitted_command_id, canonical_request_json, submitted_request_hash,
       command_type, claimed_target_kind, claimed_workflow_id, claimed_run_id,
       claimed_node_id, claimed_retry_schedule_id, claimed_effect_operation_id,
       claimed_operational_blocker_id, actor_ref, actor_kind, auth_session_ref,
       entrypoint, source_feature_id, delegation_chain_ref, resolution_result,
       authorization_result, execution_result, denial_code,
       canonical_result_json, canonical_result_hash, resolved_command_id,
       resolved_invocation_id, requested_at_ms, decided_at_ms, applied_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       'prepared', 'pending', 'prepared', NULL, NULL, NULL, NULL, NULL, ?, NULL,
       NULL)`,
    [
      id,
      domain,
      input.command.idempotency_key,
      ingressNo,
      input.command.command_id,
      canonicalJson(input.command as unknown as JsonValue),
      requestHash,
      input.command.command_type,
      claimedTarget.kind,
      targets.workflow,
      targets.run,
      targets.node,
      targets.retry_schedule,
      targets.effect_operation,
      targets.operational_blocker,
      input.actor.actorRef,
      input.actor.actorKind,
      input.actor.authSessionRef,
      input.actor.entrypoint,
      input.actor.sourceFeatureId,
      input.actor.delegationChainRef,
      input.nowMs,
    ],
  );
  return { id, requestHash, domain, claimedTarget };
}

function terminalizeRuntimeCommandIngress(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  ingress: PreparedRuntimeCommandIngress,
  resolutionResult: 'resolved' | 'target_not_found' | 'target_kind_invalid',
  authorizationResult: 'not_evaluated' | 'allowed' | 'denied',
  receipt: Omit<RuntimeCommandGatewayReceipt, 'ingressInvocationId'>,
): RuntimeCommandGatewayReceipt {
  const resultHash = runtimeObjectHash(
    'runtime-command-ingress-result',
    receipt.canonicalResult,
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_runtime_command_ingress_invocations
          SET resolution_result = ?, authorization_result = ?,
              execution_result = ?, denial_code = ?,
              canonical_result_json = ?, canonical_result_hash = ?,
              resolved_command_id = ?, resolved_invocation_id = ?,
              decided_at_ms = ?, applied_at_ms = ?
        WHERE id = ? AND resolution_result = 'prepared'`,
      [
        resolutionResult,
        authorizationResult,
        receipt.executionResult,
        receipt.denialCode,
        canonicalJson(receipt.canonicalResult),
        resultHash,
        receipt.commandId,
        receipt.invocationId,
        input.nowMs,
        receipt.executionResult === 'applied' ? input.nowMs : null,
        ingress.id,
      ],
    ).changes,
    'Runtime Command ingress terminalization',
  );
  return { ingressInvocationId: ingress.id, ...receipt };
}

function loadTarget(
  transaction: WorkflowRuntimeWriteTransaction,
  command: WorkflowRuntimeCommandDocument,
): TargetAuthority | undefined {
  const id = targetId(command);
  const workflowColumns = `w.id AS workflow_id, w.status AS workflow_status,
    w.operational_state AS workflow_operational_state,
    w.row_version AS workflow_row_version,
    w.owner_principal_ref, w.controlling_feature_id, w.creator_automation_ref,
    w.workflow_command_policy_resource_id AS command_policy_resource_id,
    w.workflow_command_policy_resource_hash AS command_policy_resource_hash`;
  const runColumns = `r.id AS run_id, r.lifecycle AS run_lifecycle,
    r.control AS run_control, r.operational_state AS run_operational_state,
    r.row_version AS run_row_version, r.work_fence_epoch AS run_work_fence_epoch,
    r.next_event_seq AS run_next_event_seq, r.root_scope_id,
    r.root_close_request_id, s.row_version AS root_scope_row_version,
    s.work_fence_epoch AS root_scope_work_fence_epoch`;
  const emptySpecific = `NULL AS node_id, NULL AS node_phase, NULL AS node_scope_id,
    NULL AS retry_schedule_id, NULL AS retry_status,
    NULL AS effect_operation_id, NULL AS effect_status,
    NULL AS effect_operation_key, NULL AS blocker_id, NULL AS blocker_kind,
    NULL AS blocker_status, NULL AS blocker_severity,
    NULL AS blocker_row_version, NULL AS blocker_policy_resource_id,
    NULL AS blocker_policy_resource_hash, NULL AS blocker_attempt_count,
    NULL AS blocker_deadline_at_ms, NULL AS blocker_source_claim_id,
    NULL AS blocker_source_root_finalization_schedule_id`;
  const joins = `LEFT JOIN workflow_graph_runs r ON r.id = w.current_graph_run_id
    LEFT JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
      AND s.graph_run_id = r.id`;
  switch (command.command_type) {
    case 'cancel_workflow':
    case 'request_administrative_abandon':
    case 'confirm_administrative_abandon':
      return transaction.queryOne<TargetAuthority>(
        `SELECT ${workflowColumns}, ${runColumns}, w.row_version AS target_row_version,
                ${emptySpecific}
           FROM workflows w ${joins} WHERE w.id = ?`,
        [id],
      );
    case 'pause_run':
    case 'resume_run':
    case 'cancel_run':
      return transaction.queryOne<TargetAuthority>(
        `SELECT ${workflowColumns}, ${runColumns}, r.row_version AS target_row_version,
                ${emptySpecific}
           FROM workflow_graph_runs r JOIN workflows w
             ON w.id = r.workflow_id AND w.current_graph_run_id = r.id
           LEFT JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
             AND s.graph_run_id = r.id WHERE r.id = ?`,
        [id],
      );
    case 'skip_node':
      return transaction.queryOne<TargetAuthority>(
        `SELECT ${workflowColumns}, ${runColumns}, n.row_version AS target_row_version,
                n.id AS node_id, n.phase AS node_phase, n.scope_id AS node_scope_id,
                NULL AS retry_schedule_id, NULL AS retry_status,
                NULL AS effect_operation_id, NULL AS effect_status,
                NULL AS effect_operation_key, NULL AS blocker_id,
                NULL AS blocker_kind, NULL AS blocker_status,
                NULL AS blocker_severity, NULL AS blocker_row_version,
                NULL AS blocker_policy_resource_id,
                NULL AS blocker_policy_resource_hash,
                NULL AS blocker_attempt_count, NULL AS blocker_deadline_at_ms,
                NULL AS blocker_source_claim_id,
                NULL AS blocker_source_root_finalization_schedule_id
           FROM workflow_graph_nodes n JOIN workflow_graph_runs r ON r.id = n.graph_run_id
           JOIN workflows w ON w.id = r.workflow_id AND w.current_graph_run_id = r.id
           LEFT JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
             AND s.graph_run_id = r.id WHERE n.id = ?`,
        [id],
      );
    case 'advance_retry_schedule':
      return transaction.queryOne<TargetAuthority>(
        `SELECT ${workflowColumns}, ${runColumns}, q.row_version AS target_row_version,
                n.id AS node_id, n.phase AS node_phase, n.scope_id AS node_scope_id,
                q.id AS retry_schedule_id, q.status AS retry_status,
                NULL AS effect_operation_id, NULL AS effect_status,
                NULL AS effect_operation_key, NULL AS blocker_id,
                NULL AS blocker_kind, NULL AS blocker_status,
                NULL AS blocker_severity, NULL AS blocker_row_version,
                NULL AS blocker_policy_resource_id,
                NULL AS blocker_policy_resource_hash,
                NULL AS blocker_attempt_count, NULL AS blocker_deadline_at_ms,
                NULL AS blocker_source_claim_id,
                NULL AS blocker_source_root_finalization_schedule_id
           FROM workflow_graph_retry_schedules q
           JOIN workflow_graph_nodes n ON n.id = q.node_id
           JOIN workflow_graph_runs r ON r.id = q.graph_run_id
           JOIN workflows w ON w.id = r.workflow_id AND w.current_graph_run_id = r.id
           LEFT JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
             AND s.graph_run_id = r.id WHERE q.id = ?`,
        [id],
      );
    case 'reconcile_effect':
    case 'submit_effect_receipt':
    case 'verify_effect_not_applied':
      return transaction.queryOne<TargetAuthority>(
        `SELECT ${workflowColumns}, ${runColumns}, e.row_version AS target_row_version,
                e.node_id, n.phase AS node_phase, e.scope_id AS node_scope_id,
                NULL AS retry_schedule_id, NULL AS retry_status,
                e.id AS effect_operation_id, e.status AS effect_status,
                e.operation_key AS effect_operation_key, b.id AS blocker_id,
                b.blocker_kind, b.status AS blocker_status,
                b.severity AS blocker_severity, b.row_version AS blocker_row_version,
                b.remediation_policy_resource_id AS blocker_policy_resource_id,
                b.remediation_policy_resource_hash AS blocker_policy_resource_hash,
                b.remediation_attempt_count AS blocker_attempt_count,
                b.remediation_deadline_at_ms AS blocker_deadline_at_ms,
                b.source_claim_id AS blocker_source_claim_id,
                b.source_root_finalization_schedule_id AS blocker_source_root_finalization_schedule_id
           FROM workflow_graph_effect_operations e
           JOIN workflow_graph_nodes n ON n.id = e.node_id
           JOIN workflow_graph_runs r ON r.id = e.graph_run_id
           JOIN workflows w ON w.id = r.workflow_id AND w.current_graph_run_id = r.id
           LEFT JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
             AND s.graph_run_id = r.id
           LEFT JOIN workflow_operational_blockers b
             ON b.source_effect_operation_id = e.id AND b.status = 'open'
          WHERE e.id = ? ORDER BY b.id LIMIT 1`,
        [id],
      );
    case 'remediate_operational_blocker':
    case 'restore_integrity':
      return transaction.queryOne<TargetAuthority>(
        `SELECT ${workflowColumns}, ${runColumns}, b.row_version AS target_row_version,
                NULL AS node_id, NULL AS node_phase, NULL AS node_scope_id,
                NULL AS retry_schedule_id, NULL AS retry_status,
                b.source_effect_operation_id AS effect_operation_id,
                e.status AS effect_status, e.operation_key AS effect_operation_key,
                b.id AS blocker_id, b.blocker_kind, b.status AS blocker_status,
                b.severity AS blocker_severity, b.row_version AS blocker_row_version,
                b.remediation_policy_resource_id AS blocker_policy_resource_id,
                b.remediation_policy_resource_hash AS blocker_policy_resource_hash,
                b.remediation_attempt_count AS blocker_attempt_count,
                b.remediation_deadline_at_ms AS blocker_deadline_at_ms,
                b.source_claim_id AS blocker_source_claim_id,
                b.source_root_finalization_schedule_id AS blocker_source_root_finalization_schedule_id
           FROM workflow_operational_blockers b
           JOIN workflow_graph_runs r ON r.id = b.graph_run_id
           JOIN workflows w ON w.id = b.workflow_id AND w.current_graph_run_id = r.id
           LEFT JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
             AND s.graph_run_id = r.id
           LEFT JOIN workflow_graph_effect_operations e
             ON e.id = b.source_effect_operation_id WHERE b.id = ?`,
        [id],
      );
  }
}

function loadRegistryContent(
  transaction: WorkflowRuntimeWriteTransaction,
  id: string,
  hash: Sha256Hash,
  resourceType: string,
): JsonObject {
  const row = transaction.queryOne<{
    canonical_value_id: string;
    content_hash: Sha256Hash;
    publication_state: string;
    resource_type: string;
  }>(
    `SELECT canonical_value_id, content_hash, publication_state, resource_type
       FROM workflow_registry_resources WHERE id = ? AND content_hash = ?`,
    [id, hash],
  );
  if (
    !row ||
    row.publication_state !== 'published' ||
    row.resource_type !== resourceType
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `Published ${resourceType} resource is unavailable`,
    );
  const value = loadInlineValue(
    transaction,
    row.canonical_value_id,
    hash,
    resourceType,
  );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new G5RuntimeError(
      'integrity_violation',
      `${resourceType} is not an object`,
    );
  return value;
}

function isOwner(
  actor: AuthenticatedRuntimeCommandActor,
  target: TargetAuthority,
) {
  if (actor.actorKind === 'human')
    return actor.actorRef === target.owner_principal_ref;
  if (actor.actorKind === 'feature_service')
    return (
      target.controlling_feature_id !== null &&
      actor.actorRef === `feature_service:${target.controlling_feature_id}`
    );
  if (actor.actorKind === 'automation')
    return actor.actorRef === target.creator_automation_ref;
  return false;
}

function requiredPermission(
  entry: RuntimeCommandProtocolEntry,
  actor: AuthenticatedRuntimeCommandActor,
  target: TargetAuthority,
): RuntimePermissionCode {
  return entry.permission_rule.kind === 'single'
    ? entry.permission_rule.permission
    : isOwner(actor, target)
      ? entry.permission_rule.own_permission
      : entry.permission_rule.fallback_permission;
}

function policyAllows(
  entry: RuntimeCommandProtocolEntry,
  policy: JsonObject,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  transaction: WorkflowRuntimeWriteTransaction,
): boolean {
  if (
    input.actor.actorKind === 'system' &&
    input.command.command_type === 'cancel_workflow'
  )
    return true;
  if (
    entry.policy_guard ===
    'command_policy_allows_workflow_cancel_or_system_grant'
  )
    return policy.command_policy_allows_workflow_cancel === true;
  if (
    entry.policy_guard === 'operational_remediation_policy_allows_blocker_kind'
  ) {
    if (
      !target.blocker_policy_resource_id ||
      !target.blocker_policy_resource_hash
    )
      return false;
    const remediationPolicy = loadRegistryContent(
      transaction,
      target.blocker_policy_resource_id,
      target.blocker_policy_resource_hash,
      'operational_remediation_policy',
    );
    return (
      Array.isArray(remediationPolicy.allowed_blocker_kinds) &&
      remediationPolicy.allowed_blocker_kinds.includes(target.blocker_kind)
    );
  }
  if (entry.policy_guard === 'trusted_integrity_restore_evidence_required')
    return (
      input.verification?.kind === 'integrity_restored' &&
      input.verification.expectedHash === input.verification.restoredHash &&
      input.verification.fullChainVerified
    );
  return policy[entry.policy_guard] === true;
}

function stateAllows(
  command: WorkflowRuntimeCommandDocument,
  target: TargetAuthority,
): boolean {
  if (target.target_row_version !== command.expected_row_version) return false;
  switch (command.command_type) {
    case 'pause_run':
      return (
        target.run_control === 'running' &&
        target.run_lifecycle !== 'closed' &&
        target.run_operational_state === 'healthy'
      );
    case 'resume_run':
      return (
        target.run_control === 'paused' &&
        target.run_lifecycle !== 'closed' &&
        target.run_operational_state === 'healthy'
      );
    case 'cancel_run':
    case 'cancel_workflow':
      return (
        target.workflow_status === 'active' &&
        target.run_id !== null &&
        target.run_lifecycle !== 'closed' &&
        target.run_operational_state === 'healthy'
      );
    case 'skip_node':
      return (
        target.run_control === 'paused' &&
        target.run_operational_state === 'healthy' &&
        target.node_phase !== 'terminal' &&
        target.node_phase !== null
      );
    case 'advance_retry_schedule':
      return (
        target.run_control === 'paused' &&
        target.run_operational_state === 'healthy' &&
        target.retry_status === 'scheduled' &&
        target.node_phase === 'retry_wait'
      );
    case 'reconcile_effect':
    case 'submit_effect_receipt':
    case 'verify_effect_not_applied':
      return (
        target.effect_status !== null &&
        ['intended', 'dispatched', 'failed', 'action_required'].includes(
          target.effect_status,
        )
      );
    case 'remediate_operational_blocker':
      return (
        target.blocker_status === 'open' &&
        target.blocker_severity === 'action_required' &&
        target.blocker_kind !== 'integrity_quarantine'
      );
    case 'restore_integrity':
      return (
        target.blocker_status === 'open' &&
        target.blocker_kind === 'integrity_quarantine'
      );
    case 'request_administrative_abandon':
    case 'confirm_administrative_abandon':
      return (
        target.workflow_status === 'active' && target.run_lifecycle !== 'closed'
      );
  }
}

function appendCommandEvent(
  transaction: WorkflowRuntimeWriteTransaction,
  target: TargetAuthority,
  commandId: string,
  executionResult: RuntimeCommandGatewayReceipt['executionResult'],
  nowMs: number,
): number | null {
  if (target.run_id === null) return null;
  const run = transaction.queryOne<{
    next_event_seq: number;
    row_version: number;
  }>(
    'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
    [target.run_id],
  );
  if (!run) return null;
  const sequence = run.next_event_seq + 1;
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_runs SET next_event_seq = ?,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ?`,
      [sequence, nowMs, target.run_id, run.row_version],
    ).changes,
    'Runtime Command event head',
  );
  insertGraphEvent(transaction, {
    graphRunId: target.run_id,
    sequence,
    scopeId: null,
    nodeId: target.node_id,
    attemptId: null,
    eventType: 'runtime_command_decided',
    idempotencyKey: `runtime-command:${commandId}:${sequence}`,
    payloadJson: {
      command_id: commandId,
      execution_result: executionResult,
    },
    occurredAtMs: nowMs,
    createdAtMs: nowMs,
  });
  return sequence;
}

function persistAuditValue(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  kind: string,
  content: JsonValue,
  ownerWorkflowId: string,
): RuntimeValueRef {
  assertExactPublishedRegistryResource(
    transaction,
    input.auditSchema,
    'G7 audit schema',
  );
  const hash = runtimeObjectHash(`g7-${kind}`, content);
  const id = stableRuntimeId(`g7-${kind}`, { hash });
  insertInlineValue(transaction, {
    id,
    content,
    contentHash: hash,
    provenanceRef: `g7:${kind}`,
    retentionClass: 'workflow_audit',
    ownerWorkflowId,
    schemaResourceId: input.auditSchema.rowId,
    schemaResourceHash: input.auditSchema.hash,
    createdAtMs: input.nowMs,
  });
  return { id, hash };
}

function loadG7AuditValue(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  valueHash: Sha256Hash,
  kind: string,
): JsonValue {
  const value = loadInlineValue(transaction, valueId, valueHash, `G7 ${kind}`);
  if (runtimeObjectHash(`g7-${kind}`, value) !== valueHash)
    throw new G5RuntimeError(
      'integrity_violation',
      `G7 ${kind} Value hash authority drifted`,
    );
  return value;
}

function targetSnapshot(target: TargetAuthority): JsonObject {
  return {
    workflow_id: target.workflow_id,
    workflow_status: target.workflow_status,
    workflow_operational_state: target.workflow_operational_state,
    workflow_row_version: target.workflow_row_version,
    run_id: target.run_id,
    run_lifecycle: target.run_lifecycle,
    run_control: target.run_control,
    run_operational_state: target.run_operational_state,
    run_row_version: target.run_row_version,
    target_row_version: target.target_row_version,
    node_id: target.node_id,
    node_phase: target.node_phase,
    retry_schedule_id: target.retry_schedule_id,
    retry_status: target.retry_status,
    effect_operation_id: target.effect_operation_id,
    effect_status: target.effect_status,
    blocker_id: target.blocker_id,
    blocker_kind: target.blocker_kind,
    blocker_status: target.blocker_status,
  };
}

function insertCommandHeader(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  requestHash: Sha256Hash,
  evidence: RuntimeValueRef,
  reasonText: RuntimeValueRef | null,
  domain: string,
): void {
  const command = input.command;
  const targetColumns: Record<string, string | null> = {
    workflow_id: null,
    run_id: null,
    node_id: null,
    retry_schedule_id: null,
    effect_operation_id: null,
    operational_blocker_id: null,
  };
  const entry = RUNTIME_COMMAND_PROTOCOL_ENTRIES.find(
    (candidate) => candidate.command_type === command.command_type,
  )!;
  targetColumns[`${entry.target_kind}_id`] = targetId(command);
  transaction.execute(
    `INSERT INTO workflow_runtime_commands (
       command_id, idempotency_domain, idempotency_key, command_type,
       workflow_id, run_id, node_id, retry_schedule_id, effect_operation_id,
       operational_blocker_id, expected_row_version, reason_code,
       reason_text_value_id, reason_text_hash, evidence_manifest_value_id,
       evidence_manifest_hash, request_hash, canonical_result_value_id,
       canonical_result_hash, created_at_ms, finalized_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
       ?, NULL)`,
    [
      command.command_id,
      domain,
      command.idempotency_key,
      command.command_type,
      targetColumns.workflow_id,
      targetColumns.run_id,
      targetColumns.node_id,
      targetColumns.retry_schedule_id,
      targetColumns.effect_operation_id,
      targetColumns.operational_blocker_id,
      command.expected_row_version,
      command.reason_code,
      reasonText?.id ?? null,
      reasonText?.hash ?? null,
      evidence.id,
      evidence.hash,
      requestHash,
      input.nowMs,
    ],
  );
  void target;
}

function finalizeAndInvoke(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  required: RuntimePermissionCode,
  requestHash: Sha256Hash,
  targetBeforeHash: Sha256Hash,
  outcome: ExecutionOutcome,
  canonicalCommandId = input.command.command_id,
): Omit<RuntimeCommandGatewayReceipt, 'ingressInvocationId'> {
  const header = transaction.queryOne<{
    canonical_result_value_id: string | null;
    canonical_result_hash: Sha256Hash | null;
  }>(
    `SELECT canonical_result_value_id, canonical_result_hash
       FROM workflow_runtime_commands WHERE command_id = ?`,
    [canonicalCommandId],
  )!;
  if (header.canonical_result_value_id === null) {
    const resultValue = persistAuditValue(
      transaction,
      input,
      'command-result',
      outcome.result,
      target.workflow_id,
    );
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_runtime_commands
            SET canonical_result_value_id = ?, canonical_result_hash = ?,
                finalized_at_ms = ?
          WHERE command_id = ? AND canonical_result_value_id IS NULL`,
        [resultValue.id, resultValue.hash, input.nowMs, canonicalCommandId],
      ).changes,
      'Runtime Command Header finalization',
    );
  }
  const invocationNo = transaction.queryOne<{ next_no: number }>(
    `SELECT coalesce(max(invocation_no), 0) + 1 AS next_no
       FROM workflow_runtime_command_invocations WHERE command_id = ?`,
    [canonicalCommandId],
  )!.next_no;
  const invocationId = stableRuntimeId('command-invocation', {
    command_id: canonicalCommandId,
    invocation_no: invocationNo,
  });
  const applied = outcome.executionResult === 'applied';
  const targetAfterHash = applied
    ? runtimeObjectHash(
        'command-target-after',
        targetSnapshot(loadTarget(transaction, input.command) ?? target),
      )
    : null;
  transaction.execute(
    `INSERT INTO workflow_runtime_command_invocations (
       id, command_id, invocation_no, submitted_request_hash, actor_ref,
       actor_kind, auth_session_ref, entrypoint, source_feature_id,
       delegation_chain_ref, required_permission, command_policy_resource_id,
       command_policy_resource_hash, authorization_result, execution_result,
       target_before_hash, target_after_hash, resulting_event_seq,
       close_request_id, effect_operation_id, requested_at_ms, decided_at_ms,
       applied_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?)`,
    [
      invocationId,
      canonicalCommandId,
      invocationNo,
      requestHash,
      input.actor.actorRef,
      input.actor.actorKind,
      input.actor.authSessionRef,
      input.actor.entrypoint,
      input.actor.sourceFeatureId,
      input.actor.delegationChainRef,
      required,
      target.command_policy_resource_id,
      target.command_policy_resource_hash,
      outcome.executionResult === 'denied' ? 'denied' : 'allowed',
      outcome.executionResult,
      targetBeforeHash,
      targetAfterHash,
      outcome.resultingEventSeq,
      outcome.closeRequestId,
      outcome.effectOperationId,
      input.nowMs,
      input.nowMs,
      applied ? input.nowMs : null,
    ],
  );
  const finalizedHeader = transaction.queryOne<{
    canonical_result_value_id: string;
    canonical_result_hash: Sha256Hash;
  }>(
    `SELECT canonical_result_value_id, canonical_result_hash
       FROM workflow_runtime_commands WHERE command_id = ?`,
    [canonicalCommandId],
  )!;
  const canonical = header.canonical_result_value_id
    ? (loadG7AuditValue(
        transaction,
        header.canonical_result_value_id,
        header.canonical_result_hash!,
        'command-result',
      ) as JsonObject)
    : (loadG7AuditValue(
        transaction,
        finalizedHeader.canonical_result_value_id,
        finalizedHeader.canonical_result_hash,
        'command-result',
      ) as JsonObject);
  return {
    commandId: canonicalCommandId,
    invocationId,
    executionResult: outcome.executionResult,
    denialCode: outcome.denialCode,
    canonicalResult: canonical,
  };
}

function deny(
  code: RuntimeCommandDenialCode,
  commandId: string,
): ExecutionOutcome {
  const executionResult =
    code === 'row_version_conflict' || code === 'idempotency_conflict'
      ? 'conflict'
      : code === 'late_command'
        ? 'late'
        : 'denied';
  return {
    executionResult,
    denialCode: code,
    resultingEventSeq: null,
    closeRequestId: null,
    effectOperationId: null,
    result: {
      command_id: commandId,
      execution_result: executionResult,
      denial_code: code,
    },
  };
}

function executeCancel(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  requestHash: Sha256Hash,
): ExecutionOutcome {
  if (target.root_close_request_id !== null)
    return deny('late_command', input.command.command_id);
  if (
    target.run_id === null ||
    target.root_scope_id === null ||
    target.run_row_version === null ||
    target.run_work_fence_epoch === null ||
    target.root_scope_row_version === null ||
    target.root_scope_work_fence_epoch === null
  )
    return deny('state_guard_failed', input.command.command_id);
  const workflowCancel = input.command.command_type === 'cancel_workflow';
  const close = requestScopeCloseT7aInTransaction(transaction, {
    graphRunId: target.run_id,
    scopeId: target.root_scope_id,
    expectedRunRowVersion: target.run_row_version,
    expectedScopeRowVersion: target.root_scope_row_version,
    expectedRunWorkFenceEpoch: target.run_work_fence_epoch,
    expectedScopeWorkFenceEpoch: target.root_scope_work_fence_epoch,
    cause: {
      reason: workflowCancel ? 'workflow_cancel' : 'local_cancel',
      cancelPayload: {
        command_id: input.command.command_id,
        request_hash: requestHash,
        reason_code: input.command.reason_code,
      },
    },
    manifestSchema: input.fenceManifestSchema,
    nowMs: input.nowMs,
  });
  const afterT7a = transaction.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [target.run_id],
  )!;
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_runs SET control = 'cancelling', root_cancel_scope = ?,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND lifecycle = 'closing'
          AND root_close_request_id = ? AND root_cancel_scope IS NULL`,
      [
        workflowCancel ? 'workflow' : 'local_graph',
        input.nowMs,
        target.run_id,
        afterT7a.row_version,
        close.closeRequestId,
      ],
    ).changes,
    'T7c cancel ingress',
  );
  const sequence = appendCommandEvent(
    transaction,
    target,
    input.command.command_id,
    'applied',
    input.nowMs,
  );
  return {
    executionResult: 'applied',
    denialCode: null,
    resultingEventSeq: sequence,
    closeRequestId: close.closeRequestId,
    effectOperationId: null,
    result: {
      command_id: input.command.command_id,
      execution_result: 'applied',
      close_request_id: close.closeRequestId,
      cancel_scope: workflowCancel ? 'workflow' : 'local_graph',
    },
  };
}

function executeControl(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
): ExecutionOutcome {
  if (input.command.command_type === 'pause_run') {
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_graph_runs SET control = 'paused', row_version = row_version + 1,
                updated_at_ms = ? WHERE id = ? AND row_version = ?
                AND control = 'running' AND lifecycle <> 'closed'
                AND operational_state = 'healthy'`,
        [input.nowMs, target.run_id, input.command.expected_row_version],
      ).changes,
      'Pause Run command',
    );
  } else {
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_graph_runs SET control = 'resuming', row_version = row_version + 1,
                updated_at_ms = ? WHERE id = ? AND row_version = ?
                AND control = 'paused' AND lifecycle <> 'closed'
                AND operational_state = 'healthy'`,
        [input.nowMs, target.run_id, input.command.expected_row_version],
      ).changes,
      'Resume Run command',
    );
  }
  const sequence = appendCommandEvent(
    transaction,
    target,
    input.command.command_id,
    'applied',
    input.nowMs,
  );
  return {
    executionResult: 'applied',
    denialCode: null,
    resultingEventSeq: sequence,
    closeRequestId: null,
    effectOperationId: null,
    result: {
      command_id: input.command.command_id,
      execution_result: 'applied',
      control:
        input.command.command_type === 'pause_run' ? 'paused' : 'resuming',
    },
  };
}

function executeSkip(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  evidence: RuntimeValueRef,
): ExecutionOutcome {
  const unknownEffect = transaction.queryOne<{ count: number }>(
    `SELECT count(*) AS count FROM workflow_graph_effect_operations
      WHERE node_id = ? AND status IN ('dispatched','action_required')`,
    [target.node_id],
  )!.count;
  if (unknownEffect > 0)
    return deny('state_guard_failed', input.command.command_id);
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_nodes
          SET phase = 'terminal', terminal_status = 'skipped',
              terminal_code = 'manual_skip', terminal_at_ms = ?,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND phase <> 'terminal'`,
      [
        input.nowMs,
        input.nowMs,
        target.node_id,
        input.command.expected_row_version,
      ],
    ).changes,
    'Manual Skip Node command',
  );
  const run = transaction.queryOne<{
    next_event_seq: number;
    row_version: number;
  }>(
    'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
    [target.run_id],
  )!;
  const sequence = run.next_event_seq + 1;
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1,
              updated_at_ms = ? WHERE id = ? AND row_version = ?`,
      [sequence, input.nowMs, target.run_id, run.row_version],
    ).changes,
    'Manual Skip event head',
  );
  insertGraphEvent(transaction, {
    graphRunId: target.run_id!,
    sequence,
    scopeId: target.node_scope_id,
    nodeId: target.node_id,
    attemptId: null,
    eventType: 'node_skipped',
    idempotencyKey: `manual-skip:${target.node_id}:${input.command.command_id}`,
    payloadValueId: evidence.id,
    payloadHash: evidence.hash,
    occurredAtMs: input.nowMs,
    createdAtMs: input.nowMs,
  });
  chargeAndInsertGraphFact(transaction, {
    id: stableRuntimeId('fact', {
      graph_run_id: target.run_id,
      fact_key: `manual-skip:${target.node_id}:${input.command.command_id}`,
    }),
    graphRunId: target.run_id!,
    scopeId: target.node_scope_id!,
    eventSeq: sequence,
    causalEventSeq: sequence,
    causalWave: 0,
    factKind: 'node_terminal',
    stableObjectKind: 'node',
    stableObjectId: target.node_id!,
    factKey: `manual-skip:${target.node_id}:${input.command.command_id}`,
    payloadValueId: evidence.id,
    payloadHash: evidence.hash,
    createdAtMs: input.nowMs,
  });
  const commandSequence = appendCommandEvent(
    transaction,
    target,
    input.command.command_id,
    'applied',
    input.nowMs,
  );
  return {
    executionResult: 'applied',
    denialCode: null,
    resultingEventSeq: commandSequence,
    closeRequestId: null,
    effectOperationId: null,
    result: {
      command_id: input.command.command_id,
      execution_result: 'applied',
      node_id: target.node_id,
      terminal_status: 'skipped',
    },
  };
}

function executeManualRetry(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
): ExecutionOutcome {
  const receipt = consumeExistingRetryScheduleT6dInTransaction(
    transaction,
    input.capacityWatcher,
    {
      retryScheduleId: target.retry_schedule_id!,
      expectedScheduleRowVersion: input.command.expected_row_version,
      ingress: 'authorized_manual_retry',
      nowMs: input.nowMs,
    },
  );
  const sequence = appendCommandEvent(
    transaction,
    target,
    input.command.command_id,
    'applied',
    input.nowMs,
  );
  return {
    executionResult: 'applied',
    denialCode: null,
    resultingEventSeq: sequence,
    closeRequestId: null,
    effectOperationId: null,
    result: {
      command_id: input.command.command_id,
      execution_result: 'applied',
      retry_schedule_id: target.retry_schedule_id,
      attempt_id: receipt.attemptId,
    },
  };
}

function blockerAttemptKind(blockerKind: string): string {
  switch (blockerKind) {
    case 'effect_unknown':
      return 'reconcile';
    case 'compensation_dead_letter':
      return 'compensate';
    case 'root_finalization_exhausted':
      return 'finalization';
    case 'claim_release_failed':
      return 'claim_release';
    case 'resource_or_credential_unavailable':
      return 'resource_preflight';
    case 'integrity_quarantine':
      return 'integrity_restore';
    default:
      throw new G5RuntimeError('integrity_violation', 'Unknown blocker kind');
  }
}

function verifyAndMutateSource(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  evidence: RuntimeValueRef,
): 'resolved' | 'retry_wait' {
  const verification = input.verification;
  if (!verification)
    throw new G5RuntimeError(
      'precondition_failed',
      'T6e source-specific verification is required',
    );
  const persistedSource = transaction.queryOne<{
    workflow_id: string;
    graph_run_id: string;
    source_effect_operation_id: string | null;
    source_outbox_id: string | null;
    source_root_finalization_schedule_id: string | null;
    source_claim_id: string | null;
    source_event_seq: number | null;
    evidence_manifest_value_id: string;
    evidence_manifest_hash: Sha256Hash;
  }>(
    `SELECT workflow_id, graph_run_id, source_effect_operation_id,
            source_outbox_id, source_root_finalization_schedule_id,
            source_claim_id, source_event_seq, evidence_manifest_value_id,
            evidence_manifest_hash
       FROM workflow_operational_blockers
      WHERE id = ? AND status = 'open'`,
    [target.blocker_id],
  );
  if (
    !persistedSource ||
    persistedSource.workflow_id !== target.workflow_id ||
    persistedSource.graph_run_id !== target.run_id
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T6e persisted Blocker source identity drifted',
    );
  loadInlineValue(
    transaction,
    persistedSource.evidence_manifest_value_id,
    persistedSource.evidence_manifest_hash,
    'T6e persisted Blocker evidence',
  );
  const sourceShapeMatches = (() => {
    switch (target.blocker_kind) {
      case 'effect_unknown':
      case 'compensation_dead_letter':
        return (
          persistedSource.source_effect_operation_id !== null &&
          persistedSource.source_effect_operation_id ===
            target.effect_operation_id &&
          persistedSource.source_outbox_id === null &&
          persistedSource.source_root_finalization_schedule_id === null &&
          persistedSource.source_claim_id === null &&
          persistedSource.source_event_seq === null
        );
      case 'claim_release_failed':
        return (
          persistedSource.source_claim_id !== null &&
          persistedSource.source_effect_operation_id === null &&
          persistedSource.source_outbox_id === null &&
          persistedSource.source_root_finalization_schedule_id === null &&
          persistedSource.source_event_seq === null
        );
      case 'root_finalization_exhausted':
        return (
          persistedSource.source_root_finalization_schedule_id !== null &&
          persistedSource.source_effect_operation_id === null &&
          persistedSource.source_outbox_id === null &&
          persistedSource.source_claim_id === null &&
          persistedSource.source_event_seq === null
        );
      case 'resource_or_credential_unavailable':
      case 'integrity_quarantine':
        return (
          persistedSource.source_event_seq !== null &&
          persistedSource.source_effect_operation_id === null &&
          persistedSource.source_outbox_id === null &&
          persistedSource.source_root_finalization_schedule_id === null &&
          persistedSource.source_claim_id === null
        );
      default:
        return false;
    }
  })();
  if (!sourceShapeMatches)
    throw new G5RuntimeError(
      'integrity_violation',
      'T6e Blocker kind is not bound to its persisted typed source',
    );
  if (verification.kind === 'retry_wait') return 'retry_wait';
  switch (target.blocker_kind) {
    case 'effect_unknown':
      if (
        verification.kind === 'effect_not_applied' &&
        verification.operationKey === target.effect_operation_key
      ) {
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_effect_operations
                SET status = 'failed', lease_owner = NULL, lease_token = NULL,
                    lease_expires_at_ms = NULL, row_version = row_version + 1,
                    updated_at_ms = ? WHERE id = ? AND operation_key = ?
                    AND status = 'action_required'`,
            [
              input.nowMs,
              target.effect_operation_id,
              verification.operationKey,
            ],
          ).changes,
          'T6e not-applied effect result',
        );
        return 'resolved';
      }
      if (
        verification.kind === 'effect_receipt' &&
        verification.operationKey === target.effect_operation_key
      ) {
        for (const [label, value] of [
          ['receipt', verification.receipt],
          ['after snapshot', verification.afterSnapshot],
          ['immutable output', verification.immutableOutputSnapshot],
        ] as const)
          loadInlineValue(transaction, value.id, value.hash, `T6e ${label}`);
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_effect_operations SET status = 'succeeded',
                    receipt_value_id = ?, receipt_hash = ?, after_state_value_id = ?,
                    after_state_hash = ?, immutable_output_snapshot_value_id = ?,
                    immutable_output_snapshot_hash = ?, lease_owner = NULL,
                    lease_token = NULL, lease_expires_at_ms = NULL,
                    row_version = row_version + 1, updated_at_ms = ?
              WHERE id = ? AND operation_key = ? AND status = 'action_required'`,
            [
              verification.receipt.id,
              verification.receipt.hash,
              verification.afterSnapshot.id,
              verification.afterSnapshot.hash,
              verification.immutableOutputSnapshot.id,
              verification.immutableOutputSnapshot.hash,
              input.nowMs,
              target.effect_operation_id,
              verification.operationKey,
            ],
          ).changes,
          'T6e verified effect receipt',
        );
        return 'resolved';
      }
      break;
    case 'compensation_dead_letter':
      if (
        verification.kind === 'effect_not_applied' &&
        verification.operationKey === target.effect_operation_key
      ) {
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_effect_operations
                SET status = 'compensation_not_required', compensation_value_id = ?,
                    compensation_hash = ?, row_version = row_version + 1,
                    updated_at_ms = ? WHERE id = ? AND operation_key = ?
                    AND status = 'action_required'`,
            [
              evidence.id,
              evidence.hash,
              input.nowMs,
              target.effect_operation_id,
              verification.operationKey,
            ],
          ).changes,
          'T6e compensation not required',
        );
        return 'resolved';
      }
      if (
        verification.kind === 'compensation_succeeded' &&
        verification.operationKey === target.effect_operation_key
      ) {
        loadInlineValue(
          transaction,
          verification.compensation.id,
          verification.compensation.hash,
          'T6e compensation result',
        );
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_effect_operations
                SET status = 'compensated', compensation_value_id = ?,
                    compensation_hash = ?, row_version = row_version + 1,
                    updated_at_ms = ? WHERE id = ? AND operation_key = ?
                    AND status = 'action_required'`,
            [
              verification.compensation.id,
              verification.compensation.hash,
              input.nowMs,
              target.effect_operation_id,
              verification.operationKey,
            ],
          ).changes,
          'T6e compensation terminal success',
        );
        return 'resolved';
      }
      break;
    case 'claim_release_failed': {
      if (
        verification.kind !== 'claim_released' ||
        verification.claimId !== persistedSource.source_claim_id
      )
        break;
      const claim = transaction.queryOne<{ status: string }>(
        'SELECT status FROM workflow_domain_resource_claims WHERE id = ?',
        [verification.claimId],
      );
      if (claim?.status === 'released') return 'resolved';
      break;
    }
    case 'resource_or_credential_unavailable': {
      if (verification.kind !== 'resource_preflight_scheduled') break;
      const schedule = transaction.queryOne<{ status: string }>(
        `SELECT schedule.status
           FROM workflow_graph_retry_schedules AS schedule
           JOIN workflow_graph_events AS source_event
             ON source_event.graph_run_id = schedule.graph_run_id
            AND source_event.seq = ?
            AND source_event.scope_id IS schedule.scope_id
            AND source_event.node_id IS schedule.node_id
            AND source_event.attempt_id IS schedule.source_attempt_id
            AND source_event.event_type = 'attempt_phase_changed'
            AND source_event.idempotency_key = 'retry-schedule:' || schedule.id
          WHERE schedule.id = ? AND schedule.graph_run_id = ?`,
        [
          persistedSource.source_event_seq,
          verification.retryScheduleId,
          persistedSource.graph_run_id,
        ],
      );
      if (schedule?.status === 'scheduled') return 'resolved';
      throw new G5RuntimeError(
        'precondition_failed',
        'T6e retry Schedule does not match the persisted source event',
      );
    }
    case 'integrity_quarantine': {
      if (verification.kind !== 'integrity_restored') break;
      const sourceEvent = transaction.queryOne<{
        event_type: string;
        payload_value_id: string | null;
        payload_hash: Sha256Hash | null;
      }>(
        `SELECT event_type, payload_value_id, payload_hash
           FROM workflow_graph_events
          WHERE graph_run_id = ? AND seq = ?`,
        [persistedSource.graph_run_id, persistedSource.source_event_seq],
      );
      if (
        sourceEvent?.event_type === 'orchestration_error' &&
        sourceEvent.payload_value_id ===
          persistedSource.evidence_manifest_value_id &&
        sourceEvent.payload_hash === persistedSource.evidence_manifest_hash &&
        verification.expectedHash === persistedSource.evidence_manifest_hash &&
        verification.expectedHash === verification.restoredHash &&
        verification.fullChainVerified
      )
        return 'resolved';
      break;
    }
    case 'root_finalization_exhausted': {
      if (
        verification.kind !== 'root_finalization_ready' ||
        verification.scheduleId !==
          persistedSource.source_root_finalization_schedule_id
      )
        break;
      const schedule = transaction.queryOne<{ status: string }>(
        'SELECT status FROM workflow_root_finalization_schedules WHERE id = ?',
        [verification.scheduleId],
      );
      const other = transaction.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_operational_blockers
          WHERE graph_run_id = ? AND status = 'open' AND id <> ?`,
        [target.run_id, target.blocker_id],
      )!.count;
      if (schedule?.status === 'ready' && other === 0) return 'resolved';
      break;
    }
  }
  throw new G5RuntimeError(
    'precondition_failed',
    `T6e verification did not close ${target.blocker_kind}`,
  );
}

function executeT6e(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  evidence: RuntimeValueRef,
): ExecutionOutcome {
  if (!target.blocker_id || target.blocker_row_version === null)
    return deny('state_guard_failed', input.command.command_id);
  const disposition = verifyAndMutateSource(
    transaction,
    input,
    target,
    evidence,
  );
  if (
    target.blocker_policy_resource_id === null ||
    target.blocker_policy_resource_hash === null ||
    target.blocker_attempt_count === null ||
    target.blocker_deadline_at_ms === null
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T6e blocker finite remediation authority is incomplete',
    );
  const remediationPolicy = loadRegistryContent(
    transaction,
    target.blocker_policy_resource_id,
    target.blocker_policy_resource_hash,
    'operational_remediation_policy',
  );
  const maxAttempts = Number(remediationPolicy.max_attempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new G5RuntimeError(
      'integrity_violation',
      'T6e remediation policy attempt ceiling is invalid',
    );
  if (
    disposition === 'retry_wait' &&
    (target.blocker_attempt_count >= maxAttempts ||
      input.nowMs > target.blocker_deadline_at_ms ||
      (input.verification?.kind === 'retry_wait' &&
        input.verification.nextEligibleAtMs > target.blocker_deadline_at_ms))
  )
    throw new G5RuntimeError(
      'resource_unavailable',
      'T6e finite remediation budget is exhausted',
    );
  const actualAttempts = transaction.queryOne<{ count: number }>(
    `SELECT count(*) AS count
       FROM workflow_operational_blocker_remediation_attempts WHERE blocker_id = ?`,
    [target.blocker_id],
  )!.count;
  if (actualAttempts !== target.blocker_attempt_count)
    throw new G5RuntimeError(
      'integrity_violation',
      'T6e remediation attempt cache drifted',
    );
  const attemptNo = target.blocker_attempt_count + 1;
  const attemptId = stableRuntimeId('blocker-remediation-attempt', {
    blocker_id: target.blocker_id,
    attempt_no: attemptNo,
  });
  const resultContent: JsonObject = {
    blocker_id: target.blocker_id,
    attempt_no: attemptNo,
    result: disposition,
    verification_kind: input.verification!.kind,
  };
  const resultValue =
    disposition === 'resolved'
      ? persistAuditValue(
          transaction,
          input,
          'remediation-result',
          resultContent,
          target.workflow_id,
        )
      : null;
  transaction.execute(
    `INSERT INTO workflow_operational_blocker_remediation_attempts (
       id, blocker_id, attempt_no, attempt_key, command_id,
       remediation_policy_resource_id, remediation_policy_resource_hash,
       attempt_kind, request_value_id, request_hash, result, result_value_id,
       result_hash, error_code, next_eligible_at_ms, started_at_ms, finished_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      attemptId,
      target.blocker_id,
      attemptNo,
      `blocker-remediation:${target.blocker_id}:${input.command.idempotency_key}`,
      input.command.command_id,
      target.blocker_policy_resource_id,
      target.blocker_policy_resource_hash,
      blockerAttemptKind(target.blocker_kind!),
      evidence.id,
      evidence.hash,
      disposition,
      resultValue?.id ?? null,
      resultValue?.hash ?? null,
      disposition === 'retry_wait' ? 'remediation_retry_wait' : null,
      disposition === 'retry_wait' && input.verification?.kind === 'retry_wait'
        ? input.verification.nextEligibleAtMs
        : null,
      input.nowMs,
      input.nowMs,
    ],
  );
  if (disposition === 'retry_wait') {
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_operational_blockers
            SET remediation_attempt_count = ?, next_remediation_at_ms = ?,
                row_version = row_version + 1
          WHERE id = ? AND row_version = ? AND status = 'open'`,
        [
          attemptNo,
          (input.verification as { nextEligibleAtMs: number }).nextEligibleAtMs,
          target.blocker_id,
          target.blocker_row_version,
        ],
      ).changes,
      'T6e retry-wait blocker CAS',
    );
  } else {
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_operational_blockers
            SET status = 'resolved', remediation_attempt_count = ?,
                next_remediation_at_ms = NULL, resolved_event_seq = 0,
                resolution_command_id = ?, resolution_value_id = ?,
                resolution_hash = ?, resolved_at_ms = ?,
                row_version = row_version + 1
          WHERE id = ? AND row_version = ? AND status = 'open'`,
        [
          attemptNo,
          input.command.command_id,
          resultValue!.id,
          resultValue!.hash,
          input.nowMs,
          target.blocker_id,
          target.blocker_row_version,
        ],
      ).changes,
      'T6e blocker resolution CAS',
    );
  }
  const sequence = appendCommandEvent(
    transaction,
    target,
    input.command.command_id,
    'applied',
    input.nowMs,
  );
  if (disposition === 'resolved' && sequence !== null)
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_operational_blockers SET resolved_event_seq = ?
          WHERE id = ? AND resolved_event_seq = 0 AND status = 'resolved'`,
        [sequence, target.blocker_id],
      ).changes,
      'T6e blocker resolution event binding',
    );
  if (
    disposition === 'resolved' &&
    target.blocker_kind === 'root_finalization_exhausted' &&
    input.verification?.kind === 'root_finalization_ready'
  )
    commitRootT8InTransaction(transaction, input.verification.rootCommit);
  return {
    executionResult: 'applied',
    denialCode: null,
    resultingEventSeq: sequence,
    closeRequestId: null,
    effectOperationId: target.effect_operation_id,
    result: {
      command_id: input.command.command_id,
      execution_result: 'applied',
      blocker_id: target.blocker_id,
      remediation_result: disposition,
    },
  };
}

function executeAbandonRequest(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  requestHash: Sha256Hash,
  evidence: RuntimeValueRef,
): ExecutionOutcome {
  const confirmationId = stableRuntimeId('command-confirmation', {
    request_command_id: input.command.command_id,
  });
  transaction.execute(
    `INSERT INTO workflow_runtime_command_confirmations (
       id, request_command_id, workflow_id, actor_ref, auth_session_ref,
       expected_workflow_row_version, request_hash, evidence_manifest_value_id,
       evidence_manifest_hash, status, expires_at_ms, consumed_at_ms, row_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 1)`,
    [
      confirmationId,
      input.command.command_id,
      target.workflow_id,
      input.actor.actorRef,
      input.actor.authSessionRef,
      input.command.expected_row_version,
      requestHash,
      evidence.id,
      evidence.hash,
      input.nowMs + 300_000,
    ],
  );
  const sequence = appendCommandEvent(
    transaction,
    target,
    input.command.command_id,
    'applied',
    input.nowMs,
  );
  return {
    executionResult: 'applied',
    denialCode: null,
    resultingEventSeq: sequence,
    closeRequestId: null,
    effectOperationId: null,
    result: {
      command_id: input.command.command_id,
      execution_result: 'applied',
      confirmation_ref: confirmationId,
      expires_at_ms: input.nowMs + 300_000,
    },
  };
}

function executeAbandonConfirm(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  evidence: RuntimeValueRef,
): ExecutionOutcome {
  const command = input.command;
  if (command.command_type !== 'confirm_administrative_abandon')
    throw new G5RuntimeError(
      'contract_invalid',
      'Confirmation command is invalid',
    );
  const confirmation = transaction.queryOne<{
    workflow_id: string;
    actor_ref: string;
    auth_session_ref: string;
    expected_workflow_row_version: number;
    evidence_manifest_hash: string;
    status: string;
    expires_at_ms: number;
    row_version: number;
    request_command_id: string;
    request_reason_code: string;
    request_reason_text_hash: string | null;
    request_evidence_hash: string;
  }>(
    `SELECT confirmation.workflow_id, confirmation.actor_ref,
            confirmation.auth_session_ref,
            confirmation.expected_workflow_row_version,
            confirmation.evidence_manifest_hash, confirmation.status,
            confirmation.expires_at_ms, confirmation.row_version,
            confirmation.request_command_id,
            request.reason_code AS request_reason_code,
            request.reason_text_hash AS request_reason_text_hash,
            request.evidence_manifest_hash AS request_evidence_hash
       FROM workflow_runtime_command_confirmations AS confirmation
       JOIN workflow_runtime_commands AS request
         ON request.command_id = confirmation.request_command_id
      WHERE confirmation.id = ?`,
    [command.confirmation_ref],
  );
  const confirmingIntent = transaction.queryOne<{
    reason_code: string;
    reason_text_hash: string | null;
    evidence_manifest_hash: string;
  }>(
    `SELECT reason_code, reason_text_hash, evidence_manifest_hash
       FROM workflow_runtime_commands WHERE command_id = ?`,
    [command.command_id],
  );
  if (
    !confirmation ||
    confirmation.workflow_id !== target.workflow_id ||
    confirmation.actor_ref !== input.actor.actorRef ||
    confirmation.auth_session_ref !== input.actor.authSessionRef ||
    confirmation.expected_workflow_row_version !==
      command.expected_row_version ||
    confirmation.evidence_manifest_hash !== evidence.hash ||
    confirmation.request_evidence_hash !== evidence.hash ||
    confirmation.status !== 'pending' ||
    !confirmingIntent ||
    confirmingIntent.reason_code !== confirmation.request_reason_code ||
    confirmingIntent.reason_text_hash !== confirmation.request_reason_text_hash ||
    confirmingIntent.evidence_manifest_hash !== confirmation.request_evidence_hash
  )
    return deny('confirmation_required', command.command_id);
  if (input.nowMs >= confirmation.expires_at_ms) {
    requireSingleChange(
      transaction.execute(
        `UPDATE workflow_runtime_command_confirmations SET status = 'expired',
                row_version = row_version + 1
          WHERE id = ? AND row_version = ? AND status = 'pending'`,
        [command.confirmation_ref, confirmation.row_version],
      ).changes,
      'Administrative Abandon confirmation expiry',
    );
    return deny('confirmation_required', command.command_id);
  }
  transaction.execute(
    `UPDATE workflow_operational_blockers SET status = 'abandoned',
            abandoned_at_ms = ?, next_remediation_at_ms = NULL,
            row_version = row_version + 1
      WHERE workflow_id = ? AND status = 'open'`,
    [input.nowMs, target.workflow_id],
  );
  transaction.execute(
    `UPDATE workflow_task_intakes SET status = 'rejected',
            selected_recipe_resource_id = NULL, selected_recipe_hash = NULL,
            row_version = row_version + 1, updated_at_ms = ?
      WHERE id IN (
        SELECT transition_intake_id FROM workflow_root_finalization_schedules
         WHERE workflow_id = ? AND status IN ('pending','retry_wait','ready')
      ) AND status = 'ready_to_create'`,
    [input.nowMs, target.workflow_id],
  );
  transaction.execute(
    `UPDATE workflow_creation_requests SET status = 'cancelled',
            updated_at_ms = ?
      WHERE id IN (
        SELECT creation_request_id FROM workflow_root_finalization_schedules
         WHERE workflow_id = ? AND status IN ('pending','retry_wait','ready')
      ) AND status IN ('pending','blocked_retryable','awaiting_confirmation')`,
    [input.nowMs, target.workflow_id],
  );
  transaction.execute(
    `UPDATE workflow_root_finalization_schedules SET status = 'cancelled',
            next_eligible_at_ms = NULL, completed_at_ms = ?,
            row_version = row_version + 1, updated_at_ms = ?
      WHERE workflow_id = ? AND status IN ('pending','retry_wait','ready')`,
    [input.nowMs, input.nowMs, target.workflow_id],
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_state_activations SET status = 'abandoned',
              finished_at_ms = ?, row_version = row_version + 1
        WHERE id = (SELECT state_instance_id FROM workflows WHERE id = ?)
          AND status = 'active' AND state_type <> 'terminal'`,
      [input.nowMs, target.workflow_id],
    ).changes,
    'Administrative Abandon activation',
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_runs SET control = 'paused',
              operational_state = 'administratively_abandoned',
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND lifecycle <> 'closed'`,
      [input.nowMs, target.run_id],
    ).changes,
    'Administrative Abandon run',
  );
  const workflow = transaction.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflows WHERE id = ?',
    [target.workflow_id],
  )!;
  requireSingleChange(
    transaction.execute(
      `UPDATE workflows SET status = 'administratively_abandoned',
              operational_state = 'administratively_abandoned', finished_at_ms = ?,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND status = 'active'`,
      [input.nowMs, input.nowMs, target.workflow_id, workflow.row_version],
    ).changes,
    'Administrative Abandon workflow',
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_runtime_command_confirmations SET status = 'consumed',
              consumed_at_ms = ?, row_version = row_version + 1
        WHERE id = ? AND row_version = ? AND status = 'pending'`,
      [input.nowMs, command.confirmation_ref, confirmation.row_version],
    ).changes,
    'Administrative Abandon confirmation consumption',
  );
  const sequence = appendCommandEvent(
    transaction,
    target,
    command.command_id,
    'applied',
    input.nowMs,
  );
  return {
    executionResult: 'applied',
    denialCode: null,
    resultingEventSeq: sequence,
    closeRequestId: null,
    effectOperationId: null,
    result: {
      command_id: command.command_id,
      execution_result: 'applied',
      workflow_status: 'administratively_abandoned',
      completion_cut_created: false,
    },
  };
}

function executeAuthorized(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
  target: TargetAuthority,
  requestHash: Sha256Hash,
  evidence: RuntimeValueRef,
): ExecutionOutcome {
  switch (input.command.command_type) {
    case 'pause_run':
    case 'resume_run':
      return executeControl(transaction, input, target);
    case 'cancel_run':
    case 'cancel_workflow':
      return executeCancel(transaction, input, target, requestHash);
    case 'skip_node':
      return executeSkip(transaction, input, target, evidence);
    case 'advance_retry_schedule':
      return executeManualRetry(transaction, input, target);
    case 'reconcile_effect':
    case 'submit_effect_receipt':
    case 'verify_effect_not_applied':
    case 'remediate_operational_blocker':
    case 'restore_integrity':
      return executeT6e(transaction, input, target, evidence);
    case 'request_administrative_abandon':
      return executeAbandonRequest(
        transaction,
        input,
        target,
        requestHash,
        evidence,
      );
    case 'confirm_administrative_abandon':
      return executeAbandonConfirm(transaction, input, target, evidence);
  }
}

function gatewayTransaction(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RuntimeCommandGatewayInput,
): RuntimeCommandGatewayReceipt {
  if (
    input.actor.authenticated !== true ||
    input.actor.actorRef.length === 0 ||
    input.actor.authSessionRef.length === 0
  )
    throw new G5RuntimeError(
      'forbidden_surface',
      'Runtime Command Gateway requires an authenticated server actor context',
    );
  const { entry, claimedTarget } = assertCommandShape(input.command);
  assertRuntimeCommandIngressHistory(
    transaction,
    idempotencyDomain(input),
    input.command.idempotency_key,
  );
  const ingress = prepareRuntimeCommandIngress(
    transaction,
    input,
    claimedTarget,
  );
  if (claimedTarget.kind !== entry.target_kind) {
    const receipt = terminalizeRuntimeCommandIngress(
      transaction,
      input,
      ingress,
      'target_kind_invalid',
      'not_evaluated',
      {
        commandId: null,
        invocationId: null,
        executionResult: 'denied',
        denialCode: 'target_kind_invalid',
        canonicalResult: {
          command_id: input.command.command_id,
          execution_result: 'denied',
          denial_code: 'target_kind_invalid',
        },
      },
    );
    assertNoDeferredForeignKeyViolations(transaction, 'Runtime Command Gateway');
    return receipt;
  }
  const target = loadTarget(transaction, input.command);
  if (!target) {
    const receipt = terminalizeRuntimeCommandIngress(
      transaction,
      input,
      ingress,
      'target_not_found',
      'not_evaluated',
      {
        commandId: null,
        invocationId: null,
        executionResult: 'denied',
        denialCode: 'target_not_found',
        canonicalResult: {
          command_id: input.command.command_id,
          execution_result: 'denied',
          denial_code: 'target_not_found',
        },
      },
    );
    assertNoDeferredForeignKeyViolations(transaction, 'Runtime Command Gateway');
    return receipt;
  }
  const requestHash = ingress.requestHash;
  const domain = ingress.domain;
  const targetBeforeHash = runtimeObjectHash(
    'command-target-before',
    targetSnapshot(target),
  );
  const existing = transaction.queryOne<{
    command_id: string;
    request_hash: Sha256Hash;
    canonical_result_value_id: string;
    canonical_result_hash: Sha256Hash;
    command_policy_resource_id: string;
    command_policy_resource_hash: Sha256Hash;
    required_permission: RuntimePermissionCode;
  }>(
    `SELECT c.command_id, c.request_hash, c.canonical_result_value_id,
            c.canonical_result_hash, i.command_policy_resource_id,
            i.command_policy_resource_hash, i.required_permission
       FROM workflow_runtime_commands c
       JOIN workflow_runtime_command_invocations i ON i.command_id = c.command_id
      WHERE c.idempotency_domain = ? AND c.idempotency_key = ?
      ORDER BY i.invocation_no LIMIT 1`,
    [domain, input.command.idempotency_key],
  );
  if (existing) {
    const outcome =
      existing.request_hash === requestHash
        ? {
            executionResult: 'duplicate' as const,
            denialCode: null,
            resultingEventSeq: null,
            closeRequestId: null,
            effectOperationId: null,
            result: loadG7AuditValue(
              transaction,
              existing.canonical_result_value_id,
              existing.canonical_result_hash,
              'command-result',
            ) as JsonObject,
          }
        : deny('idempotency_conflict', existing.command_id);
    const resolvedReceipt = finalizeAndInvoke(
      transaction,
      input,
      {
        ...target,
        command_policy_resource_id: existing.command_policy_resource_id,
        command_policy_resource_hash: existing.command_policy_resource_hash,
      },
      existing.required_permission,
      requestHash,
      targetBeforeHash,
      outcome,
      existing.command_id,
    );
    const receipt = terminalizeRuntimeCommandIngress(
      transaction,
      input,
      ingress,
      'resolved',
      'not_evaluated',
      resolvedReceipt,
    );
    assertNoDeferredForeignKeyViolations(transaction, 'Runtime Command Gateway');
    return receipt;
  }
  const required = requiredPermission(entry, input.actor, target);
  const actorKindAllowed = (
    entry.allowed_actor_kinds as readonly CommandActorKind[]
  ).includes(input.actor.actorKind);
  const permissionAllowed = input.actor.permissions.has(required);
  const ceilingAllowed =
    input.actor.featurePermissionCeiling === null ||
    input.actor.featurePermissionCeiling.has(required);
  const evidenceContent = { evidence_refs: [...input.command.evidence_refs] };
  const evidence = persistAuditValue(
    transaction,
    input,
    'command-evidence',
    evidenceContent,
    target.workflow_id,
  );
  const reasonText = input.command.reason_text
    ? persistAuditValue(
        transaction,
        input,
        'command-reason-text',
        { text: input.command.reason_text },
        target.workflow_id,
      )
    : null;
  insertCommandHeader(
    transaction,
    input,
    target,
    requestHash,
    evidence,
    reasonText,
    domain,
  );
  const policy = loadRegistryContent(
    transaction,
    target.command_policy_resource_id,
    target.command_policy_resource_hash,
    'command_policy',
  );
  let denial: RuntimeCommandDenialCode | null = null;
  if (
    !(entry.allowed_reason_codes as readonly string[]).includes(
      input.command.reason_code,
    )
  )
    denial = 'evidence_invalid';
  else if (
    input.command.evidence_refs.length < entry.minimum_evidence_refs ||
    (EVIDENCE_REQUIRED_REASONS.has(input.command.reason_code) &&
      input.command.evidence_refs.length === 0)
  )
    denial = 'evidence_invalid';
  else if (!actorKindAllowed || !permissionAllowed)
    denial = 'permission_denied';
  else if (!ceilingAllowed) denial = 'feature_ceiling_denied';
  else if (!policyAllows(entry, policy, input, target, transaction))
    denial = 'command_policy_denied';
  else if (target.target_row_version !== input.command.expected_row_version)
    denial = 'row_version_conflict';
  else if (!stateAllows(input.command, target)) denial = 'state_guard_failed';
  if (input.actor.actorKind === 'system') {
    const due =
      input.command.command_type === 'cancel_workflow' &&
      input.actor.actorRef === SYSTEM_DEADLINE_ACTOR &&
      input.actor.entrypoint === 'deadline_watchdog' &&
      ['deadline_enforced', 'safety_enforced'].includes(
        input.command.reason_code,
      ) &&
      input.command.idempotency_key ===
        `workflow-deadline:${target.workflow_id}:${String(
          transaction.queryOne<{ deadline_at_ms: number | null }>(
            'SELECT deadline_at_ms FROM workflows WHERE id = ?',
            [target.workflow_id],
          )!.deadline_at_ms,
        )}` &&
      transaction.queryOne<{ deadline_at_ms: number | null }>(
        'SELECT deadline_at_ms FROM workflows WHERE id = ?',
        [target.workflow_id],
      )!.deadline_at_ms !== null &&
      input.nowMs >=
        transaction.queryOne<{ deadline_at_ms: number }>(
          'SELECT deadline_at_ms FROM workflows WHERE id = ?',
          [target.workflow_id],
        )!.deadline_at_ms;
    if (!due) denial = 'permission_denied';
  }
  const outcome = denial
    ? deny(denial, input.command.command_id)
    : executeAuthorized(transaction, input, target, requestHash, evidence);
  const resolvedReceipt = finalizeAndInvoke(
    transaction,
    input,
    target,
    required,
    requestHash,
    targetBeforeHash,
    outcome,
  );
  const receipt = terminalizeRuntimeCommandIngress(
    transaction,
    input,
    ingress,
    'resolved',
    denial &&
      [
        'permission_denied',
        'feature_ceiling_denied',
        'command_policy_denied',
      ].includes(denial)
      ? 'denied'
      : 'allowed',
    resolvedReceipt,
  );
  assertNoDeferredForeignKeyViolations(transaction, 'Runtime Command Gateway');
  return receipt;
}

export function submitRuntimeCommand(
  store: WorkflowRuntimeStore,
  input: RuntimeCommandGatewayInput,
  fault?: G5TransactionFault,
): RuntimeCommandGatewayReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => gatewayTransaction(transaction, input),
    fault,
  );
}

export interface DeadlineWatchdogInput {
  readonly auditSchema: RuntimeRegistryRef;
  readonly fenceManifestSchema: RuntimeRegistryRef;
  readonly capacityWatcher: Pick<CapacitySnapshotWatcher, 'current'>;
  readonly reasonCode: 'deadline_enforced' | 'safety_enforced';
  readonly nowMs: number;
  readonly limit?: number;
}

export function fireWorkflowDeadlineWatchdog(
  store: WorkflowRuntimeStore,
  input: DeadlineWatchdogInput,
): readonly RuntimeCommandGatewayReceipt[] {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new G5RuntimeError(
      'contract_invalid',
      'Deadline watchdog limit is invalid',
    );
  const due = store.queryAll<{
    id: string;
    deadline_at_ms: number;
    row_version: number;
  }>(
    `SELECT id, deadline_at_ms, row_version FROM workflows
      WHERE deadline_at_ms <= ? AND finished_at_ms IS NULL
      ORDER BY deadline_at_ms ASC, id ASC LIMIT ?`,
    [input.nowMs, limit],
  );
  return due.map((workflow) =>
    submitRuntimeCommand(store, {
      command: {
        command_id: stableRuntimeId('deadline-command', {
          workflow_id: workflow.id,
          deadline_at_ms: workflow.deadline_at_ms,
        }),
        command_type: 'cancel_workflow',
        target: { workflow_id: workflow.id },
        idempotency_key: `workflow-deadline:${workflow.id}:${workflow.deadline_at_ms}`,
        expected_row_version: workflow.row_version,
        reason_code: input.reasonCode,
        evidence_refs: [
          `workflow:${workflow.id}`,
          `deadline_at_ms:${workflow.deadline_at_ms}`,
        ],
      },
      actor: {
        authenticated: true,
        actorRef: SYSTEM_DEADLINE_ACTOR,
        actorKind: 'system',
        authSessionRef: `system-session:deadline-watchdog:${input.nowMs}`,
        entrypoint: 'deadline_watchdog',
        sourceFeatureId: null,
        delegationChainRef: null,
        permissions: new Set<RuntimePermissionCode>(['workflow.cancel.any']),
        featurePermissionCeiling: null,
      },
      auditSchema: input.auditSchema,
      fenceManifestSchema: input.fenceManifestSchema,
      capacityWatcher: input.capacityWatcher,
      nowMs: input.nowMs,
    }),
  );
}
