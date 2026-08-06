import {
  buildDeploymentCapacityPublication,
  calculateCapacityAdminRequestHash,
  validateDeploymentCapacitySnapshot,
} from '../contracts/capacity-control-plane-source.js';
import type {
  CapacityAdminCommand,
  CapacityAdminDenialCode,
  DeploymentRuntimeCapacityPublication,
} from '../contracts/capacity-control-plane-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { assertJsonObject } from '../contracts/strict-json.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  insertInlineValue,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from '../runtime/graph-store.js';

export interface CapacityAuthenticatedInvocation {
  readonly authenticated: boolean;
  readonly actorRef: string;
  readonly sessionActorRef: string;
  readonly actorKind: 'human' | 'feature_service' | 'automation' | 'system';
  readonly authSessionRef: string | null;
  readonly entrypoint:
    | 'runtime_center'
    | 'cli'
    | 'deployment_tool'
    | 'local_startup';
  readonly delegationChainRef: string | null;
  readonly permissions: readonly string[];
  readonly requestedAtMs: number;
}

export interface CapacityCommandPersistence {
  readonly evidenceManifest: RuntimeValueRef;
  readonly reasonText: RuntimeValueRef | null;
  readonly resultSchema: RuntimeRegistryRef;
}

export interface PreparedCapacityChange {
  readonly disposition:
    | 'prepared'
    | 'pending_recovery'
    | 'duplicate'
    | 'denied'
    | 'conflict';
  readonly commandId: string;
  readonly changeId: string | null;
  readonly capacityRevision: number | null;
  readonly requestHash: Sha256Hash;
  readonly publication: DeploymentRuntimeCapacityPublication | null;
  readonly denialCode: CapacityAdminDenialCode | null;
  readonly canonicalResult: RuntimeValueRef | null;
}

interface CapacityHeadRow extends Record<string, unknown> {
  current_capacity_revision: number | null;
  current_change_id: string | null;
  current_config_hash: string | null;
  current_publication_hash: string | null;
  pending_change_id: string | null;
  row_version: number;
}

interface CapacityCommandRow extends Record<string, unknown> {
  command_id: string;
  command_type: CapacityAdminCommand['command_type'];
  request_hash: Sha256Hash;
  assigned_capacity_revision: number | null;
  assigned_change_id: string | null;
  proposed_capacity_json: string;
  proposed_config_hash: Sha256Hash;
  canonical_result_value_id: string | null;
  canonical_result_hash: Sha256Hash | null;
  finalized_at_ms: number | null;
}

function commandKeys(
  commandType: CapacityAdminCommand['command_type'],
): string[] {
  return commandType === 'initialize_deployment_capacity'
    ? [
        'command_type',
        'command_id',
        'idempotency_key',
        'proposed_capacity',
        'reason_code',
      ]
    : [
        'command_type',
        'command_id',
        'idempotency_key',
        'expected_capacity_revision',
        'expected_config_hash',
        'proposed_capacity',
        'reason_code',
        'reason_text',
        'evidence_refs',
      ];
}

export function parseCapacityAdminCommand(
  value: unknown,
): CapacityAdminCommand {
  assertJsonObject(value);
  if (
    value.command_type !== 'initialize_deployment_capacity' &&
    value.command_type !== 'replace_deployment_capacity'
  ) {
    throw new G5RuntimeError(
      'contract_invalid',
      'Capacity command_type is not closed',
    );
  }
  const expected = commandKeys(value.command_type).sort();
  const actual = Object.keys(value).sort();
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new G5RuntimeError(
      'contract_invalid',
      'Capacity Command has an unknown or missing field',
    );
  }
  const command = value as unknown as CapacityAdminCommand;
  if (
    typeof command.command_id !== 'string' ||
    command.command_id.length === 0 ||
    typeof command.idempotency_key !== 'string' ||
    command.idempotency_key.length === 0 ||
    (command.command_type === 'replace_deployment_capacity' &&
      (!Array.isArray(command.evidence_refs) ||
        command.evidence_refs.some((entry) => typeof entry !== 'string')))
  ) {
    throw new G5RuntimeError(
      'contract_invalid',
      'Capacity Command identity or evidence is invalid',
    );
  }
  if (validateDeploymentCapacitySnapshot(command.proposed_capacity) !== null) {
    throw new G5RuntimeError(
      'contract_invalid',
      'Capacity snapshot is invalid',
    );
  }
  return structuredClone(command);
}

function eventHash(input: JsonObject): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:runtime-capacity-change-event:1\n',
    input,
  );
}

export function appendCapacityEvent(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly changeId: string;
    readonly commandId: string;
    readonly capacityRevision: number;
    readonly eventType:
      | 'prepared'
      | 'file_installed'
      | 'head_committed'
      | 'watcher_published'
      | 'recovered'
      | 'failed'
      | 'unauthorized_file_rejected';
    readonly configHash: Sha256Hash;
    readonly publicationHash: Sha256Hash;
    readonly createdAtMs: number;
  },
): Sha256Hash {
  const previous = transaction.queryOne<{
    event_seq: number;
    event_hash: Sha256Hash;
  }>(
    'SELECT event_seq, event_hash FROM runtime_capacity_change_events ORDER BY event_seq DESC LIMIT 1',
    [],
  );
  const sequence = (previous?.event_seq ?? 0) + 1;
  const payload: JsonObject = {
    event_seq: sequence,
    change_id: input.changeId,
    command_id: input.commandId,
    capacity_revision: input.capacityRevision,
    event_type: input.eventType,
    config_hash: input.configHash,
    publication_hash: input.publicationHash,
    previous_event_hash: previous?.event_hash ?? null,
    detail_value_id: null,
    detail_hash: null,
    created_at_ms: input.createdAtMs,
  };
  const hash = eventHash(payload);
  transaction.execute(
    `INSERT INTO runtime_capacity_change_events (
       event_seq, change_id, command_id, capacity_revision, event_type,
       config_hash, publication_hash, previous_event_hash, event_hash,
       detail_value_id, detail_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      sequence,
      input.changeId,
      input.commandId,
      input.capacityRevision,
      input.eventType,
      input.configHash,
      input.publicationHash,
      previous?.event_hash ?? null,
      hash,
      input.createdAtMs,
    ],
  );
  return hash;
}

function findCommand(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CapacityAdminCommand,
): CapacityCommandRow | undefined {
  return transaction.queryOne<CapacityCommandRow>(
    `SELECT command_id, command_type, request_hash, assigned_capacity_revision,
            assigned_change_id, proposed_capacity_json, proposed_config_hash,
            canonical_result_value_id, canonical_result_hash, finalized_at_ms
       FROM runtime_capacity_admin_commands
      WHERE idempotency_domain = 'deployment_capacity' AND idempotency_key = ?`,
    [command.idempotency_key],
  );
}

function nextInvocationNo(
  transaction: WorkflowRuntimeWriteTransaction,
  commandId: string,
): number {
  return (
    transaction.queryOne<{ value: number }>(
      'SELECT count(*) + 1 AS value FROM runtime_capacity_admin_invocations WHERE command_id = ?',
      [commandId],
    )?.value ?? 1
  );
}

function insertInvocation(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly commandId: string;
    readonly invocationNo: number;
    readonly requestHash: Sha256Hash;
    readonly invocation: CapacityAuthenticatedInvocation;
    readonly authorization: 'allowed' | 'denied';
    readonly execution:
      | 'prepared'
      | 'denied'
      | 'conflict'
      | 'duplicate'
      | 'failed';
    readonly denialCode: CapacityAdminDenialCode | null;
    readonly observedRevision: number | null;
    readonly observedConfigHash: Sha256Hash | null;
    readonly decidedAtMs: number;
  },
): void {
  transaction.execute(
    `INSERT INTO runtime_capacity_admin_invocations (
       id, command_id, invocation_no, submitted_request_hash, actor_ref,
       actor_kind, auth_session_ref, entrypoint, delegation_chain_ref,
       required_permission, authorization_result, execution_result, denial_code,
       observed_capacity_revision, observed_config_hash, requested_at_ms,
       decided_at_ms, applied_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'runtime.capacity.manage', ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      stableRuntimeId('capacity-invocation', {
        command_id: input.commandId,
        invocation_no: input.invocationNo,
      }),
      input.commandId,
      input.invocationNo,
      input.requestHash,
      input.invocation.actorRef,
      input.invocation.actorKind,
      input.invocation.authSessionRef!,
      input.invocation.entrypoint,
      input.invocation.delegationChainRef,
      input.authorization,
      input.execution,
      input.denialCode,
      input.observedRevision,
      input.observedConfigHash,
      input.invocation.requestedAtMs,
      input.decidedAtMs,
    ],
  );
}

function invocationAuthorizationDenial(
  invocation: CapacityAuthenticatedInvocation,
  command: CapacityAdminCommand,
): CapacityAdminDenialCode | null {
  if (invocation.delegationChainRef !== null) return 'permission_denied';
  if (command.command_type === 'initialize_deployment_capacity') {
    if (
      invocation.actorKind !== 'system' ||
      invocation.actorRef !== 'system:local-store' ||
      invocation.sessionActorRef !== invocation.actorRef ||
      invocation.entrypoint !== 'local_startup'
    )
      return 'actor_kind_denied';
    return null;
  }
  if (invocation.actorKind !== 'human') return 'actor_kind_denied';
  if (
    invocation.actorRef !== 'human:local-owner' ||
    invocation.sessionActorRef !== invocation.actorRef ||
    !invocation.permissions.includes('runtime.capacity.manage') ||
    !['runtime_center', 'cli', 'deployment_tool'].includes(
      invocation.entrypoint,
    )
  )
    return 'permission_denied';
  return null;
}

function denialCode(
  invocation: CapacityAuthenticatedInvocation,
  command: CapacityAdminCommand,
  head: CapacityHeadRow | undefined,
  currentMinimumFreeDiskBytes: number | null,
): CapacityAdminDenialCode | null {
  const authorization = invocationAuthorizationDenial(invocation, command);
  if (authorization) return authorization;
  if (command.command_type === 'initialize_deployment_capacity') {
    if (
      head &&
      (head.current_capacity_revision !== null ||
        head.pending_change_id !== null)
    )
      return 'capacity_already_initialized';
    return null;
  }
  if (
    !head ||
    head.current_capacity_revision === null ||
    head.current_config_hash === null
  )
    return 'expected_capacity_revision_conflict';
  if (head.pending_change_id !== null) return 'capacity_change_in_progress';
  if (command.expected_capacity_revision !== head.current_capacity_revision)
    return 'expected_capacity_revision_conflict';
  if (command.expected_config_hash !== head.current_config_hash)
    return 'expected_config_hash_conflict';
  if (command.reason_text.length === 0) return 'capacity_snapshot_invalid';
  if (
    currentMinimumFreeDiskBytes !== null &&
    command.proposed_capacity.minimum_free_disk_bytes <
      currentMinimumFreeDiskBytes
  )
    return 'capacity_transition_invalid';
  return null;
}

function resultValue(
  transaction: WorkflowRuntimeWriteTransaction,
  persistence: CapacityCommandPersistence,
  commandId: string,
  payload: JsonObject,
  nowMs: number,
): RuntimeValueRef {
  const hash = domainSeparatedSha256(
    'icarus:capacity-admin-result:1\n',
    payload,
  );
  const id = stableRuntimeId('capacity-result', {
    command_id: commandId,
    result_hash: hash,
  });
  insertInlineValue(transaction, {
    id,
    content: payload,
    contentHash: hash,
    schemaResourceId: persistence.resultSchema.rowId,
    schemaResourceHash: persistence.resultSchema.hash,
    provenanceRef: 'icarus.workflow-capacity-admin/1',
    retentionClass: 'workflow_audit',
    createdAtMs: nowMs,
  });
  return { id, hash };
}

function insertCommand(
  transaction: WorkflowRuntimeWriteTransaction,
  command: CapacityAdminCommand,
  persistence: CapacityCommandPersistence,
  requestHash: Sha256Hash,
  assignedRevision: number | null,
  assignedChangeId: string | null,
  canonicalResult: RuntimeValueRef | null,
  nowMs: number,
): void {
  transaction.execute(
    `INSERT INTO runtime_capacity_admin_commands (
       command_id, idempotency_domain, idempotency_key, command_type,
       expected_capacity_revision, expected_config_hash,
       assigned_capacity_revision, assigned_change_id,
       proposed_capacity_json, proposed_config_hash, request_hash, reason_code,
       reason_text_value_id, reason_text_hash, evidence_manifest_value_id,
       evidence_manifest_hash, canonical_result_value_id, canonical_result_hash,
       created_at_ms, finalized_at_ms
     ) VALUES (?, 'deployment_capacity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      command.command_id,
      command.idempotency_key,
      command.command_type,
      command.command_type === 'replace_deployment_capacity'
        ? command.expected_capacity_revision
        : null,
      command.command_type === 'replace_deployment_capacity'
        ? command.expected_config_hash
        : null,
      assignedRevision,
      assignedChangeId,
      canonicalJson(command.proposed_capacity),
      command.proposed_capacity.config_hash,
      requestHash,
      command.reason_code,
      persistence.reasonText?.id ?? null,
      persistence.reasonText?.hash ?? null,
      persistence.evidenceManifest.id,
      persistence.evidenceManifest.hash,
      canonicalResult?.id ?? null,
      canonicalResult?.hash ?? null,
      nowMs,
      canonicalResult ? nowMs : null,
    ],
  );
}

export function prepareCapacityChangeCAP0CAP1(
  store: WorkflowRuntimeStore,
  candidateCommand: unknown,
  invocation: CapacityAuthenticatedInvocation,
  persistence: CapacityCommandPersistence,
  decidedAtMs: number,
  fault?: G5TransactionFault,
):
  | PreparedCapacityChange
  | { disposition: 'authentication_rejected'; commandId: null } {
  if (
    !invocation.authenticated ||
    invocation.authSessionRef === null ||
    invocation.sessionActorRef !== invocation.actorRef
  ) {
    return { disposition: 'authentication_rejected', commandId: null };
  }
  let command: CapacityAdminCommand;
  try {
    command = parseCapacityAdminCommand(candidateCommand);
  } catch {
    throw new G5RuntimeError(
      'contract_invalid',
      'Authenticated Capacity command failed strict validation',
    );
  }
  const requestHash = calculateCapacityAdminRequestHash(command);
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const existing = findCommand(transaction, command);
      if (existing) {
        const invocationNo = nextInvocationNo(transaction, existing.command_id);
        const head = transaction.queryOne<CapacityHeadRow>(
          'SELECT current_capacity_revision, current_change_id, current_config_hash, current_publication_hash, pending_change_id, row_version FROM runtime_capacity_head WHERE singleton_key = 1',
          [],
        );
        const authorizationDenied = invocationAuthorizationDenial(
          invocation,
          command,
        );
        if (authorizationDenied) {
          insertInvocation(transaction, {
            commandId: existing.command_id,
            invocationNo,
            requestHash,
            invocation,
            authorization: 'denied',
            execution: 'denied',
            denialCode: authorizationDenied,
            observedRevision: head?.current_capacity_revision ?? null,
            observedConfigHash:
              (head?.current_config_hash as Sha256Hash | null | undefined) ??
              null,
            decidedAtMs,
          });
          return {
            disposition: 'denied',
            commandId: existing.command_id,
            changeId: existing.assigned_change_id,
            capacityRevision: existing.assigned_capacity_revision,
            requestHash,
            publication: null,
            denialCode: authorizationDenied,
            canonicalResult: null,
          };
        }
        if (existing.request_hash !== requestHash) {
          insertInvocation(transaction, {
            commandId: existing.command_id,
            invocationNo,
            requestHash,
            invocation,
            authorization: 'allowed',
            execution: 'conflict',
            denialCode: null,
            observedRevision: head?.current_capacity_revision ?? null,
            observedConfigHash:
              (head?.current_config_hash as Sha256Hash | null | undefined) ??
              null,
            decidedAtMs,
          });
          return {
            disposition: 'conflict',
            commandId: existing.command_id,
            changeId: existing.assigned_change_id,
            capacityRevision: existing.assigned_capacity_revision,
            requestHash,
            publication: null,
            denialCode: 'idempotency_conflict',
            canonicalResult:
              existing.canonical_result_value_id &&
              existing.canonical_result_hash
                ? {
                    id: existing.canonical_result_value_id,
                    hash: existing.canonical_result_hash,
                  }
                : null,
          };
        }
        if (
          existing.canonical_result_value_id &&
          existing.canonical_result_hash &&
          existing.finalized_at_ms !== null
        ) {
          insertInvocation(transaction, {
            commandId: existing.command_id,
            invocationNo,
            requestHash,
            invocation,
            authorization: 'allowed',
            execution: 'duplicate',
            denialCode: null,
            observedRevision: head?.current_capacity_revision ?? null,
            observedConfigHash:
              (head?.current_config_hash as Sha256Hash | null | undefined) ??
              null,
            decidedAtMs,
          });
          return {
            disposition: 'duplicate',
            commandId: existing.command_id,
            changeId: existing.assigned_change_id,
            capacityRevision: existing.assigned_capacity_revision,
            requestHash,
            publication: null,
            denialCode: null,
            canonicalResult: {
              id: existing.canonical_result_value_id,
              hash: existing.canonical_result_hash,
            },
          };
        }
        if (
          existing.assigned_change_id === null ||
          existing.assigned_capacity_revision === null
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'Non-final Capacity command has no assigned lineage',
          );
        const previousConfigHash =
          existing.assigned_capacity_revision === 1
            ? null
            : ((head?.current_config_hash as Sha256Hash | null | undefined) ??
              null);
        return {
          disposition: 'pending_recovery',
          commandId: existing.command_id,
          changeId: existing.assigned_change_id,
          capacityRevision: existing.assigned_capacity_revision,
          requestHash,
          publication: buildDeploymentCapacityPublication(
            existing.assigned_capacity_revision,
            existing.assigned_change_id,
            previousConfigHash,
            JSON.parse(existing.proposed_capacity_json),
          ),
          denialCode: null,
          canonicalResult: null,
        };
      }
      const head = transaction.queryOne<CapacityHeadRow>(
        'SELECT current_capacity_revision, current_change_id, current_config_hash, current_publication_hash, pending_change_id, row_version FROM runtime_capacity_head WHERE singleton_key = 1',
        [],
      );
      let currentMinimumFreeDiskBytes: number | null = null;
      if (head?.current_change_id) {
        const prior = transaction.queryOne<{ proposed_capacity_json: string }>(
          'SELECT proposed_capacity_json FROM runtime_capacity_admin_commands WHERE assigned_change_id = ?',
          [head.current_change_id],
        );
        if (prior)
          currentMinimumFreeDiskBytes = Number(
            (JSON.parse(prior.proposed_capacity_json) as JsonObject)
              .minimum_free_disk_bytes,
          );
      }
      const denied = denialCode(
        invocation,
        command,
        head,
        currentMinimumFreeDiskBytes,
      );
      if (denied) {
        const payload: JsonObject = {
          format: 'icarus.capacity-admin-result/1',
          command_id: command.command_id,
          disposition: 'denied',
          denial_code: denied,
          request_hash: requestHash,
        };
        const result = resultValue(
          transaction,
          persistence,
          command.command_id,
          payload,
          decidedAtMs,
        );
        insertCommand(
          transaction,
          command,
          persistence,
          requestHash,
          null,
          null,
          result,
          decidedAtMs,
        );
        insertInvocation(transaction, {
          commandId: command.command_id,
          invocationNo: 1,
          requestHash,
          invocation,
          authorization: 'denied',
          execution: 'denied',
          denialCode: denied,
          observedRevision: head?.current_capacity_revision ?? null,
          observedConfigHash:
            (head?.current_config_hash as Sha256Hash | null | undefined) ??
            null,
          decidedAtMs,
        });
        return {
          disposition: 'denied',
          commandId: command.command_id,
          changeId: null,
          capacityRevision: null,
          requestHash,
          publication: null,
          denialCode: denied,
          canonicalResult: result,
        };
      }
      const capacityRevision = (head?.current_capacity_revision ?? 0) + 1;
      const changeId = stableRuntimeId('capacity-change', {
        command_id: command.command_id,
        capacity_revision: capacityRevision,
        request_hash: requestHash,
      });
      const publication = buildDeploymentCapacityPublication(
        capacityRevision,
        changeId,
        (head?.current_config_hash as Sha256Hash | null | undefined) ?? null,
        command.proposed_capacity,
      );
      insertCommand(
        transaction,
        command,
        persistence,
        requestHash,
        capacityRevision,
        changeId,
        null,
        decidedAtMs,
      );
      insertInvocation(transaction, {
        commandId: command.command_id,
        invocationNo: 1,
        requestHash,
        invocation,
        authorization: 'allowed',
        execution: 'prepared',
        denialCode: null,
        observedRevision: head?.current_capacity_revision ?? null,
        observedConfigHash:
          (head?.current_config_hash as Sha256Hash | null | undefined) ?? null,
        decidedAtMs,
      });
      if (!head) {
        transaction.execute(
          `INSERT INTO runtime_capacity_head (
         singleton_key, current_capacity_revision, current_change_id,
         current_config_hash, current_publication_hash, pending_change_id,
         row_version, created_at_ms, updated_at_ms
       ) VALUES (1, NULL, NULL, NULL, NULL, ?, 1, ?, ?)`,
          [changeId, decidedAtMs, decidedAtMs],
        );
      } else {
        const changed = transaction.execute(
          'UPDATE runtime_capacity_head SET pending_change_id = ?, row_version = row_version + 1, updated_at_ms = ? WHERE singleton_key = 1 AND row_version = ? AND pending_change_id IS NULL',
          [changeId, decidedAtMs, head.row_version],
        ).changes;
        if (changed !== 1)
          throw new G5RuntimeError(
            'cas_conflict',
            'Capacity head changed during CAP1',
          );
      }
      appendCapacityEvent(transaction, {
        changeId,
        commandId: command.command_id,
        capacityRevision,
        eventType: 'prepared',
        configHash: command.proposed_capacity.config_hash,
        publicationHash: publication.publication_hash,
        createdAtMs: decidedAtMs,
      });
      return {
        disposition: 'prepared',
        commandId: command.command_id,
        changeId,
        capacityRevision,
        requestHash,
        publication,
        denialCode: null,
        canonicalResult: null,
      };
    },
    fault,
  );
}
