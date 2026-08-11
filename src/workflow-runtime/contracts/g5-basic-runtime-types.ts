import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';
import {
  RUNTIME_AUDIT_EVENT_TYPES,
  RUNTIME_FACT_KINDS,
} from './catalog-protocol-types.js';

export const G5_TRANSACTION_IDS = [
  'T0',
  'T0p',
  'T1',
  'T2a',
  'T2b',
  'T3a',
  'T3b',
  'T4',
  'T5',
  'T6a',
  'T6b',
  'T6c',
  'T6d',
] as const;

export type G5TransactionId = (typeof G5_TRANSACTION_IDS)[number];
export type RuntimeFactKind = (typeof RUNTIME_FACT_KINDS)[number];
export type RuntimeEventType =
  | RuntimeFactKind
  | (typeof RUNTIME_AUDIT_EVENT_TYPES)[number];

export interface RuntimeValueRef {
  readonly id: string;
  readonly hash: Sha256Hash;
}

export interface RuntimeRegistryRef {
  readonly rowId: string;
  readonly resourceType: string;
  readonly ref: VersionedRef;
  readonly hash: Sha256Hash;
}

export interface TaskRecord {
  readonly intakeId: string;
  readonly requestId: string;
  readonly creationDomain: string;
  readonly creationKey: string;
  readonly source:
    | 'global_assistant'
    | 'schedule'
    | 'api'
    | 'task_workspace'
    | 'workflow_transition';
  readonly principalRef: string;
  readonly routingScope: RuntimeRegistryRef;
  readonly input: RuntimeValueRef;
  readonly attachments: RuntimeValueRef;
  readonly revisionId: string;
  readonly revisionHash: Sha256Hash;
  readonly createdAtMs: number;
}

export interface CreationRecord {
  readonly requestId: string;
  readonly intakeId: string;
  readonly mode: 'direct' | 'required_finalization' | 'best_effort_delivery';
  readonly creationDomain: string;
  readonly creationKey: string;
  readonly recipe: RuntimeRegistryRef;
  readonly definition: RuntimeRegistryRef;
  readonly entryPoint: string;
  readonly executionPolicy: RuntimeRegistryRef;
  readonly input: RuntimeValueRef;
  readonly attachments: RuntimeValueRef;
  readonly intentHash: Sha256Hash;
  readonly runtimeSafetyHash: Sha256Hash;
  readonly createdAtMs: number;
}

export interface LaunchRecord {
  readonly confirmationId: string;
  readonly intakeId: string;
  readonly intakeRevisionId: string;
  readonly inputHash: Sha256Hash;
  readonly routingDecisionId: string;
  readonly routingDecisionHash: Sha256Hash;
  readonly recipe: RuntimeRegistryRef;
  readonly creationIntentHash: Sha256Hash;
  readonly actorRef: string;
  readonly action: 'approve' | 'decline';
  readonly expiresAtMs: number;
  readonly idempotencyKey: string;
  readonly requestHash: Sha256Hash;
  readonly createdAtMs: number;
}

export interface ActivationRecord {
  readonly activationId: string;
  readonly workflowId: string;
  readonly stateKey: string;
  readonly stateType:
    | 'delegation'
    | 'system'
    | 'interrupt'
    | 'graph'
    | 'terminal';
  readonly activationNo: number;
  readonly definition: RuntimeRegistryRef;
  readonly definitionVersion: string;
  readonly stateConfig: RuntimeValueRef;
  readonly graphRunId: string | null;
  readonly startedAtMs: number;
}

interface ManifestRecordBase {
  readonly graphRunId: string;
  readonly sequence: number;
  readonly previousManifestHash: Sha256Hash;
  readonly manifestHash: Sha256Hash;
  readonly createdAtMs: number;
}

export interface ScopeMaterializedManifestRecord extends ManifestRecordBase {
  readonly entryKind: 'scope_materialized';
  readonly scopeId: string;
  readonly expansionManifestId: null;
  readonly parentScopeId: string | null;
  readonly ownerNodeId: string | null;
  readonly childKey: string | null;
  readonly scopeKind: 'root' | 'subgraph' | 'expansion' | 'map_item';
  readonly sourceHash: Sha256Hash;
  readonly planHash: Sha256Hash;
  readonly interfaceHash: Sha256Hash;
  readonly inputHash: Sha256Hash;
  readonly policyHash: Sha256Hash;
  readonly expansionHash: null;
  readonly itemCount: null;
}

export interface ExpansionSealedManifestRecord extends ManifestRecordBase {
  readonly entryKind: 'expansion_sealed';
  readonly scopeId: null;
  readonly expansionManifestId: string;
  readonly parentScopeId: string | null;
  readonly ownerNodeId: string | null;
  readonly childKey: string | null;
  readonly scopeKind: 'root' | 'subgraph' | 'expansion' | 'map_item' | null;
  readonly sourceHash: null;
  readonly planHash: null;
  readonly interfaceHash: Sha256Hash | null;
  readonly inputHash: Sha256Hash | null;
  readonly policyHash: Sha256Hash | null;
  readonly expansionHash: Sha256Hash;
  readonly itemCount: number;
}

export type ManifestRecord =
  | ScopeMaterializedManifestRecord
  | ExpansionSealedManifestRecord;

export interface FactRecord {
  readonly id: string;
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly eventSeq: number;
  readonly causalEventSeq: number | null;
  readonly causalWave: number;
  readonly kind: RuntimeFactKind;
  readonly stableObjectKind: string;
  readonly stableObjectId: string;
  readonly factKey: string;
  readonly payload: RuntimeValueRef;
  readonly createdAtMs: number;
}

export interface EventRecord {
  readonly graphRunId: string;
  readonly sequence: number;
  readonly scopeId: string | null;
  readonly nodeId: string | null;
  readonly attemptId: string | null;
  readonly eventType: RuntimeEventType;
  readonly idempotencyKey: string;
  readonly payloadJson: JsonValue | null;
  readonly payload: RuntimeValueRef | null;
  readonly occurredAtMs: number;
  readonly createdAtMs: number;
}

export interface AttemptRecord {
  readonly id: string;
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptNo: number;
  readonly continuationKind: 'initial' | 'execution_retry' | 'quality_revision';
  readonly parentAttemptId: string | null;
  readonly parentAttemptNo: number | null;
  readonly phase:
    | 'preparing'
    | 'dispatch_pending'
    | 'running'
    | 'evaluating'
    | 'terminal';
  readonly acceptanceState: 'open' | 'fenced';
  readonly runWorkFenceEpoch: number;
  readonly scopeWorkFenceEpoch: number;
  readonly rowVersion: number;
}

export interface WaitRecord {
  readonly id: string;
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly waitType: 'signal' | 'timer' | 'approval';
  readonly contract: RuntimeRegistryRef;
  readonly correlationKey: string;
  readonly correlationKeyHash: Sha256Hash;
  readonly registrationKey: string;
  readonly payload: RuntimeValueRef | null;
  readonly status:
    | 'registering'
    | 'armed'
    | 'resolved'
    | 'timed_out'
    | 'cancelled';
  readonly deadlineAtMs: number | null;
  readonly runWorkFenceEpoch: number;
  readonly scopeWorkFenceEpoch: number;
  readonly rowVersion: number;
}

export interface EffectRecord {
  readonly id: string;
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly operationKey: string;
  readonly keyStrategy: JsonObject;
  readonly keyStrategyHash: Sha256Hash;
  readonly executionLane: 'normal' | 'close_cleanup';
  readonly effectType: string;
  readonly status:
    | 'intended'
    | 'dispatched'
    | 'succeeded'
    | 'failed'
    | 'action_required'
    | 'compensation_pending'
    | 'compensated'
    | 'compensation_not_required';
  readonly request: RuntimeValueRef;
  readonly rowVersion: number;
}

export interface InboxRecord {
  readonly providerRef: string;
  readonly providerEventId: string;
  readonly principalRef: string;
  readonly workflowId: string;
  readonly graphRunId: string;
  readonly contract: RuntimeRegistryRef;
  readonly correlationKey: string;
  readonly correlationKeyHash: Sha256Hash;
  readonly payload: RuntimeValueRef;
  readonly byteLength: number;
  readonly ingressAuthorization: RuntimeValueRef;
  readonly bindingAuthorization: RuntimeValueRef;
  readonly receivedAtMs: number;
  readonly expiresAtMs: number;
}

export interface OutboxExecutionBindingRecord {
  readonly adapter: RuntimeRegistryRef;
  readonly deliveryPolicy: RuntimeRegistryRef;
  readonly effectivePolicySnapshot: JsonObject & {
    readonly format: 'icarus.workflow-outbox-effective-policy-snapshot/1';
    readonly snapshot_hash: Sha256Hash;
  };
  readonly effectContract: JsonObject & {
    readonly delivery_lane: 'normal_execution';
    readonly delivery_requirement: 'required';
  };
  readonly bindingHash: Sha256Hash;
}

export interface OutboxRecord {
  readonly id: string;
  readonly effectKey: string;
  readonly attemptId: string | null;
  readonly waitId: string | null;
  readonly effectOperationId: string | null;
  readonly aggregateRowVersion: number;
  readonly effectType: string;
  readonly binding: OutboxExecutionBindingRecord;
  readonly policySnapshot: RuntimeValueRef;
  readonly payload: RuntimeValueRef;
  readonly deadlineAtMs: number;
  readonly createdAtMs: number;
}

export interface ClaimRecord {
  readonly id: string;
  readonly namespace: string;
  readonly keyHash: Sha256Hash;
  readonly mode: 'shared' | 'exclusive';
  readonly ownerWorkflowId: string;
  readonly recipe: RuntimeRegistryRef;
  readonly sourceIntakeId: string;
  readonly creationKey: string;
  readonly fencingToken: number | null;
  readonly status: 'held' | 'release_pending' | 'released';
  readonly rowVersion: number;
}

export interface LedgerRecord {
  readonly id: string;
  readonly graphRunId: string;
  readonly sequence: number;
  readonly reservationGroupId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly operation: 'reserve' | 'commit' | 'release' | 'charge';
  readonly deltaReserved: number;
  readonly deltaConsumed: number;
  readonly idempotencyKey: string;
  readonly previousChainHash: Sha256Hash | null;
  readonly chainHash: Sha256Hash;
  readonly createdAtMs: number;
}

export interface CapacityRecord {
  readonly max_active_executions: number;
  readonly max_active_waits: number;
  readonly max_pending_signals: number;
  readonly max_outbox_inflight: number;
  readonly max_physical_blob_bytes: number;
  readonly soft_blob_high_water_bytes: number;
  readonly minimum_free_disk_bytes: number;
  readonly config_hash: Sha256Hash;
}

export interface CapacityPublicationRecord {
  readonly format: 'icarus.deployment-runtime-capacity-publication/1';
  readonly deployment_profile: 'local_single_user';
  readonly capacity_revision: number;
  readonly capacity_change_id: string;
  readonly previous_config_hash: Sha256Hash | null;
  readonly capacity: CapacityRecord;
  readonly publication_hash: Sha256Hash;
}

export interface BlockerRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly graphRunId: string;
  readonly blockerKind:
    | 'effect_unknown'
    | 'compensation_dead_letter'
    | 'root_finalization_exhausted'
    | 'claim_release_failed'
    | 'resource_or_credential_unavailable'
    | 'integrity_quarantine';
  readonly severity: 'action_required' | 'quarantine';
  readonly sourceEffectOperationId: string | null;
  readonly sourceOutboxId: string | null;
  readonly sourceRootFinalizationScheduleId: string | null;
  readonly sourceClaimId: string | null;
  readonly sourceEventSeq: number | null;
  readonly errorCode: string;
  readonly evidenceManifest: RuntimeValueRef;
  readonly status: 'open' | 'resolved' | 'abandoned';
  readonly remediationPolicy: RuntimeRegistryRef;
  readonly remediationAttemptCount: number;
  readonly nextRemediationAtMs: number | null;
  readonly remediationDeadlineAtMs: number;
  readonly openedEventSeq: number;
  readonly resolvedEventSeq: number | null;
  readonly resolutionCommandId: string | null;
  readonly resolution: RuntimeValueRef | null;
  readonly rowVersion: number;
  readonly openedAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly abandonedAtMs: number | null;
}

export interface G5ContractFixture {
  readonly case_id: string;
  readonly transaction_id: G5TransactionId | 'CAP0-CAP4';
  readonly assertion: string;
  readonly expected: 'accepted' | 'rejected' | 'rolled_back' | 'replayed';
}
