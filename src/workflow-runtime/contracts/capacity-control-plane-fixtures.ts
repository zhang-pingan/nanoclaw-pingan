import { buildDeploymentRuntimeCapacityBaseline } from './safety-sqlite-artifacts.js';
import type { Sha256Hash } from './types.js';
import {
  buildDeploymentCapacityPublication,
  calculateCapacityAdminRequestHash,
  calculateDeploymentCapacityConfigHash,
  CAPACITY_CRASH_BOUNDARIES,
  evaluateCapacityAdminModel,
  validateCapacityAdminInvocationLifecycle,
  validateCapacityPublication,
} from './capacity-control-plane-source.js';
import type {
  CapacityAdminCommand,
  CapacityAdminModelHead,
  CapacityAdminModelInvocation,
  CapacityAdmissionLineage,
  CapacityConformanceCase,
  DeploymentRuntimeCapacityPublication,
  DeploymentRuntimeCapacitySnapshot,
  InitializeDeploymentCapacityCommand,
  ReplaceDeploymentCapacityCommand,
} from './capacity-control-plane-types.js';

const HASH_A = `sha256:${'a'.repeat(64)}` as Sha256Hash;
const HASH_B = `sha256:${'b'.repeat(64)}` as Sha256Hash;
const ACTIVE_CORE_RELEASE_HASH = `sha256:${'c'.repeat(64)}` as Sha256Hash;

function baselineCapacity(): DeploymentRuntimeCapacitySnapshot {
  return buildDeploymentRuntimeCapacityBaseline() as DeploymentRuntimeCapacitySnapshot;
}

function capacityWith(
  updates: Partial<Omit<DeploymentRuntimeCapacitySnapshot, 'config_hash'>>,
): DeploymentRuntimeCapacitySnapshot {
  const current = baselineCapacity();
  const withoutHash = {
    max_active_executions:
      updates.max_active_executions ?? current.max_active_executions,
    max_active_waits: updates.max_active_waits ?? current.max_active_waits,
    max_pending_signals:
      updates.max_pending_signals ?? current.max_pending_signals,
    max_outbox_inflight:
      updates.max_outbox_inflight ?? current.max_outbox_inflight,
    max_physical_blob_bytes:
      updates.max_physical_blob_bytes ?? current.max_physical_blob_bytes,
    soft_blob_high_water_bytes:
      updates.soft_blob_high_water_bytes ?? current.soft_blob_high_water_bytes,
    minimum_free_disk_bytes:
      updates.minimum_free_disk_bytes ?? current.minimum_free_disk_bytes,
  };
  return {
    ...withoutHash,
    config_hash: calculateDeploymentCapacityConfigHash(withoutHash),
  };
}

function replaceCommand(
  updates: Partial<ReplaceDeploymentCapacityCommand> = {},
): ReplaceDeploymentCapacityCommand {
  return {
    command_type: 'replace_deployment_capacity',
    command_id: 'capacity-command:replace:1',
    idempotency_key: 'capacity-key:replace:1',
    expected_capacity_revision: 4,
    expected_config_hash: baselineCapacity().config_hash,
    proposed_capacity: capacityWith({ max_active_executions: 6 }),
    reason_code: 'planned_tuning',
    reason_text: 'Increase execution slots after measured host validation.',
    evidence_refs: [],
    ...updates,
  };
}

function initializeCommand(
  updates: Partial<InitializeDeploymentCapacityCommand> = {},
): InitializeDeploymentCapacityCommand {
  return {
    command_type: 'initialize_deployment_capacity',
    command_id: 'capacity-command:initialize:1',
    idempotency_key: 'capacity-key:initialize:1',
    proposed_capacity: baselineCapacity(),
    reason_code: 'initial_provisioning',
    core_release_hash: ACTIVE_CORE_RELEASE_HASH,
    evidence_refs: ['core-release:evidence', 'capacity-baseline:evidence'],
    ...updates,
  };
}

function committedHead(
  updates: Partial<CapacityAdminModelHead> = {},
): CapacityAdminModelHead {
  const capacity = baselineCapacity();
  return {
    capacity_revision: 4,
    capacity_change_id: 'capacity-change:4',
    config_hash: capacity.config_hash,
    pending_change_id: null,
    row_version: 8,
    minimum_free_disk_bytes: capacity.minimum_free_disk_bytes,
    ...updates,
  };
}

function localOwnerInvocation(
  command: CapacityAdminCommand,
  updates: Partial<CapacityAdminModelInvocation> = {},
): CapacityAdminModelInvocation {
  return {
    authenticated: true,
    actor_ref: 'human:local-owner',
    actor_kind: 'human',
    auth_session_ref: 'auth-session:local-owner',
    session_actor_ref: 'human:local-owner',
    permissions: ['runtime.capacity.manage'],
    entrypoint: 'runtime_center',
    delegation_chain_ref: null,
    audit_available: true,
    genesis_grant: null,
    active_core_release_hash: ACTIVE_CORE_RELEASE_HASH,
    baseline_config_hash: baselineCapacity().config_hash,
    idempotency_record: null,
    submitted_request_hash: calculateCapacityAdminRequestHash(command),
    ...updates,
  };
}

function genesisInvocation(
  command: CapacityAdminCommand,
  updates: Partial<CapacityAdminModelInvocation> = {},
): CapacityAdminModelInvocation {
  return localOwnerInvocation(command, {
    actor_ref: 'system:production-activation',
    actor_kind: 'system',
    auth_session_ref: 'auth-session:production-activation',
    session_actor_ref: 'system:production-activation',
    permissions: [],
    entrypoint: 'production_activation',
    genesis_grant: {
      core_release_hash: ACTIVE_CORE_RELEASE_HASH,
      baseline_config_hash: baselineCapacity().config_hash,
    },
    ...updates,
  });
}

interface ModelScenario {
  invocation: CapacityAdminModelInvocation;
  head: CapacityAdminModelHead | null;
  command: CapacityAdminCommand;
}

function scenario(
  command: CapacityAdminCommand,
  invocation: CapacityAdminModelInvocation,
  head: CapacityAdminModelHead | null,
): ModelScenario {
  return { command, invocation, head };
}

const validReplace = replaceCommand();
const validInitialize = initializeCommand();

const MODEL_SCENARIOS: Record<string, ModelScenario> = {
  replace_local_owner_prepared: scenario(
    validReplace,
    localOwnerInvocation(validReplace),
    committedHead(),
  ),
  same_config_hash_new_revision: (() => {
    const command = replaceCommand({
      command_id: 'capacity-command:same-config',
      idempotency_key: 'capacity-key:same-config',
      proposed_capacity: baselineCapacity(),
    });
    return scenario(command, localOwnerInvocation(command), committedHead());
  })(),
  minimum_free_disk_increase: (() => {
    const command = replaceCommand({
      command_id: 'capacity-command:disk-increase',
      idempotency_key: 'capacity-key:disk-increase',
      proposed_capacity: capacityWith({
        minimum_free_disk_bytes:
          baselineCapacity().minimum_free_disk_bytes + 1073741824,
      }),
      reason_code: 'storage_pressure',
      evidence_refs: ['disk-pressure:evidence'],
    });
    return scenario(command, localOwnerInvocation(command), committedHead());
  })(),
  initialize_valid_genesis: scenario(
    validInitialize,
    genesisInvocation(validInitialize),
    null,
  ),
  duplicate_same_request: (() => {
    const command = replaceCommand({
      command_id: 'capacity-command:duplicate',
      idempotency_key: 'capacity-key:duplicate',
    });
    return scenario(
      command,
      localOwnerInvocation(command, {
        idempotency_record: {
          request_hash: calculateCapacityAdminRequestHash(command),
          canonical_result: 'capacity-change:5',
        },
      }),
      committedHead(),
    );
  })(),
  non_local_owner: scenario(
    validReplace,
    localOwnerInvocation(validReplace, {
      actor_ref: 'human:other',
      session_actor_ref: 'human:other',
      permissions: [],
    }),
    committedHead(),
  ),
  forged_actor_session: scenario(
    validReplace,
    localOwnerInvocation(validReplace, {
      session_actor_ref: 'human:other',
    }),
    committedHead(),
  ),
  wrong_actor_kind: scenario(
    validReplace,
    localOwnerInvocation(validReplace, {
      actor_ref: 'feature_service:research',
      actor_kind: 'feature_service',
      session_actor_ref: 'feature_service:research',
      permissions: ['runtime.capacity.manage'],
    }),
    committedHead(),
  ),
  delegated_via_feature_service: scenario(
    validReplace,
    localOwnerInvocation(validReplace, {
      delegation_chain_ref: 'delegation:feature-service:research',
    }),
    committedHead(),
  ),
  delegated_via_automation: scenario(
    validReplace,
    localOwnerInvocation(validReplace, {
      delegation_chain_ref: 'delegation:automation:nightly',
    }),
    committedHead(),
  ),
  delegated_via_workflow: scenario(
    validReplace,
    localOwnerInvocation(validReplace, {
      delegation_chain_ref: 'delegation:workflow:run-1',
    }),
    committedHead(),
  ),
  delegated_duplicate_same_request: (() => {
    const command = replaceCommand({
      command_id: 'capacity-command:delegated-duplicate',
      idempotency_key: 'capacity-key:delegated-duplicate',
    });
    return scenario(
      command,
      localOwnerInvocation(command, {
        delegation_chain_ref: 'delegation:feature-service:research',
        idempotency_record: {
          request_hash: calculateCapacityAdminRequestHash(command),
          canonical_result: 'capacity-change:5',
        },
      }),
      committedHead(),
    );
  })(),
  feature_duplicate_same_request: (() => {
    const command = replaceCommand({
      command_id: 'capacity-command:feature-duplicate',
      idempotency_key: 'capacity-key:feature-duplicate',
    });
    return scenario(
      command,
      localOwnerInvocation(command, {
        actor_ref: 'feature_service:research',
        actor_kind: 'feature_service',
        session_actor_ref: 'feature_service:research',
        permissions: ['runtime.capacity.manage'],
        idempotency_record: {
          request_hash: calculateCapacityAdminRequestHash(command),
          canonical_result: 'capacity-change:5',
        },
      }),
      committedHead(),
    );
  })(),
  untrusted_business_api_entrypoint: scenario(
    validReplace,
    localOwnerInvocation(validReplace, { entrypoint: 'business_api' }),
    committedHead(),
  ),
  stale_revision: scenario(
    replaceCommand({ expected_capacity_revision: 3 }),
    localOwnerInvocation(replaceCommand({ expected_capacity_revision: 3 })),
    committedHead(),
  ),
  stale_hash: scenario(
    replaceCommand({ expected_config_hash: HASH_A }),
    localOwnerInvocation(replaceCommand({ expected_config_hash: HASH_A })),
    committedHead(),
  ),
  concurrent_head_modified: scenario(
    validReplace,
    localOwnerInvocation(validReplace),
    committedHead({ capacity_revision: 5, row_version: 9 }),
  ),
  pending_change: scenario(
    validReplace,
    localOwnerInvocation(validReplace),
    committedHead({ pending_change_id: 'capacity-change:pending' }),
  ),
  conflicting_idempotency_key: (() => {
    const command = replaceCommand({
      command_id: 'capacity-command:conflict',
      idempotency_key: 'capacity-key:conflict',
    });
    return scenario(
      command,
      localOwnerInvocation(command, {
        idempotency_record: {
          request_hash: HASH_A,
          canonical_result: 'capacity-change:other',
        },
      }),
      committedHead(),
    );
  })(),
  minimum_free_disk_decrease: (() => {
    const command = replaceCommand({
      proposed_capacity: capacityWith({
        minimum_free_disk_bytes: baselineCapacity().minimum_free_disk_bytes - 1,
      }),
    });
    return scenario(command, localOwnerInvocation(command), committedHead());
  })(),
  genesis_already_initialized: scenario(
    validInitialize,
    genesisInvocation(validInitialize),
    committedHead(),
  ),
  wrong_core_release_evidence: scenario(
    initializeCommand({ core_release_hash: HASH_B }),
    genesisInvocation(initializeCommand({ core_release_hash: HASH_B })),
    null,
  ),
  missing_reason_text: (() => {
    const command = replaceCommand({ reason_text: '' });
    return scenario(command, localOwnerInvocation(command), committedHead());
  })(),
  invalid_full_snapshot_hash: (() => {
    const command = replaceCommand({
      proposed_capacity: {
        ...capacityWith({ max_active_executions: 7 }),
        config_hash: HASH_A,
      },
    });
    return scenario(command, localOwnerInvocation(command), committedHead());
  })(),
  audit_unavailable: scenario(
    validReplace,
    localOwnerInvocation(validReplace, { audit_available: false }),
    committedHead(),
  ),
};

export const CAPACITY_CONTROL_PLANE_POSITIVE_CASES = [
  {
    case_id: 'positive.publication-full-snapshot-hash',
    area: 'integrity',
    scenario: 'valid_publication',
    expected_result: 'valid',
    expected_head_effect: 'unchanged',
    assertion:
      'publication validates both the unchanged 7-field config hash and envelope hash',
  },
  {
    case_id: 'positive.replace-local-owner',
    area: 'authorization',
    scenario: 'replace_local_owner_prepared',
    expected_result: 'prepared',
    expected_head_effect: 'pending_prepared',
    assertion:
      'authenticated local owner with runtime.capacity.manage reaches CAP1',
  },
  {
    case_id: 'positive.same-config-new-revision',
    area: 'cas',
    scenario: 'same_config_hash_new_revision',
    expected_result: 'prepared',
    expected_head_effect: 'pending_prepared',
    assertion:
      'same config hash still creates a distinct assigned revision and change id',
  },
  {
    case_id: 'positive.duplicate-same-request',
    area: 'idempotency',
    scenario: 'duplicate_same_request',
    expected_result: 'duplicate',
    expected_head_effect: 'unchanged',
    assertion:
      'same domain key and request returns canonical result and appends duplicate invocation',
  },
  {
    case_id: 'positive.minimum-free-disk-increase',
    area: 'transition',
    scenario: 'minimum_free_disk_increase',
    expected_result: 'prepared',
    expected_head_effect: 'pending_prepared',
    assertion: 'minimum free disk bytes may increase',
  },
  {
    case_id: 'positive.initialize-fresh-genesis',
    area: 'genesis',
    scenario: 'initialize_valid_genesis',
    expected_result: 'prepared',
    expected_head_effect: 'pending_prepared',
    assertion:
      'fresh head and exact one-time Core release baseline grant initialize revision 1',
  },
  {
    case_id: 'positive.admission-lineage',
    area: 'admission_lineage',
    scenario: 'admission_lineage_matches_pointer',
    expected_result: 'valid',
    expected_head_effect: 'unchanged',
    assertion:
      'Admission revision change and config hash equal one immutable pointer',
  },
  {
    case_id: 'positive.cap1-prepared-invocation-shape',
    area: 'idempotency',
    scenario: 'cap1_prepared_invocation_shape',
    expected_result: 'valid_prepared_invocation',
    expected_head_effect: 'pending_prepared',
    assertion:
      'CAP1 initial authenticated and authorized invocation is decided as prepared with null applied time',
  },
  {
    case_id: 'positive.cap4-retry-duplicate-preserves-prepared',
    area: 'idempotency',
    scenario: 'cap4_retry_duplicate_preserves_prepared',
    expected_result: 'canonical_result_new_duplicate_prepared_unchanged',
    expected_head_effect: 'committed',
    assertion:
      'after CAP4 an exact retry appends duplicate and returns the canonical Command result without updating the CAP1 prepared invocation',
  },
] as const satisfies readonly CapacityConformanceCase[];

export const CAPACITY_CONTROL_PLANE_NEGATIVE_CASES = [
  [
    'negative.non-local-owner',
    'authorization',
    'non_local_owner',
    'permission_denied',
  ],
  [
    'negative.forged-actor-session',
    'authorization',
    'forged_actor_session',
    'authentication_rejected_no_invocation',
  ],
  [
    'negative.wrong-actor-kind',
    'authorization',
    'wrong_actor_kind',
    'actor_kind_denied',
  ],
  [
    'negative.delegated-via-feature-service',
    'authorization',
    'delegated_via_feature_service',
    'permission_denied',
  ],
  [
    'negative.delegated-via-automation',
    'authorization',
    'delegated_via_automation',
    'permission_denied',
  ],
  [
    'negative.delegated-via-workflow',
    'authorization',
    'delegated_via_workflow',
    'permission_denied',
  ],
  [
    'negative.delegated-duplicate-same-request',
    'authorization',
    'delegated_duplicate_same_request',
    'permission_denied',
  ],
  [
    'negative.feature-duplicate-same-request',
    'authorization',
    'feature_duplicate_same_request',
    'actor_kind_denied',
  ],
  [
    'negative.untrusted-business-api-entrypoint',
    'authorization',
    'untrusted_business_api_entrypoint',
    'permission_denied',
  ],
  [
    'negative.stale-revision',
    'cas',
    'stale_revision',
    'expected_capacity_revision_conflict',
  ],
  ['negative.stale-hash', 'cas', 'stale_hash', 'expected_config_hash_conflict'],
  [
    'negative.concurrent-head-modified',
    'cas',
    'concurrent_head_modified',
    'expected_capacity_revision_conflict',
  ],
  [
    'negative.pending-change',
    'cas',
    'pending_change',
    'capacity_change_in_progress',
  ],
  [
    'negative.conflicting-idempotency-key',
    'idempotency',
    'conflicting_idempotency_key',
    'idempotency_conflict',
  ],
  [
    'negative.minimum-free-disk-decrease',
    'transition',
    'minimum_free_disk_decrease',
    'capacity_transition_invalid',
  ],
  [
    'negative.genesis-already-initialized',
    'genesis',
    'genesis_already_initialized',
    'capacity_already_initialized',
  ],
  [
    'negative.wrong-core-release-evidence',
    'genesis',
    'wrong_core_release_evidence',
    'capacity_snapshot_invalid',
  ],
  [
    'negative.missing-reason-text',
    'transition',
    'missing_reason_text',
    'capacity_snapshot_invalid',
  ],
  [
    'negative.invalid-full-snapshot-hash',
    'integrity',
    'invalid_full_snapshot_hash',
    'capacity_snapshot_invalid',
  ],
  [
    'negative.invalid-publication-hash',
    'integrity',
    'invalid_publication_hash',
    'capacity_publication_hash_invalid',
  ],
  [
    'negative.direct-file-tamper',
    'integrity',
    'direct_file_tamper',
    'unauthorized_file_rejected',
  ],
  [
    'negative.cold-start-mismatch',
    'integrity',
    'cold_start_mismatch',
    'admission_disabled_fail_closed',
  ],
  [
    'negative.audit-unavailable',
    'authorization',
    'audit_unavailable',
    'audit_unavailable',
  ],
  [
    'negative.prepared-denied-authorization',
    'authorization',
    'prepared_denied_authorization',
    'capacity_invocation_denied_shape_invalid',
  ],
  [
    'negative.prepared-with-denial-code',
    'authorization',
    'prepared_with_denial_code',
    'capacity_invocation_allowed_denial_code_invalid',
  ],
  [
    'negative.prepared-with-applied-time',
    'idempotency',
    'prepared_with_applied_time',
    'capacity_invocation_prepared_applied_time_invalid',
  ],
  [
    'negative.prepared-decision-before-request',
    'idempotency',
    'prepared_decision_before_request',
    'capacity_invocation_time_invalid',
  ],
  [
    'negative.prepared-non-initial-invocation',
    'idempotency',
    'prepared_non_initial_invocation',
    'capacity_invocation_prepared_lifecycle_invalid',
  ],
  [
    'negative.duplicate-before-command-finalization',
    'idempotency',
    'duplicate_before_command_finalization',
    'capacity_invocation_duplicate_lifecycle_invalid',
  ],
  [
    'negative.duplicate-request-mismatch',
    'idempotency',
    'duplicate_request_mismatch',
    'capacity_invocation_duplicate_lifecycle_invalid',
  ],
  [
    'negative.applied-is-schema4-history-only',
    'idempotency',
    'applied_current_schema',
    'capacity_invocation_applied_is_historical',
  ],
].map(([caseId, area, scenarioId, expectedResult]) => ({
  case_id: caseId!,
  area: area as CapacityConformanceCase['area'],
  scenario: scenarioId!,
  expected_result: expectedResult!,
  expected_head_effect: 'unchanged' as const,
  assertion: `Scenario ${scenarioId} must fail closed without changing committed head`,
})) satisfies readonly CapacityConformanceCase[];

export const CAPACITY_CONTROL_PLANE_FAULT_CASES = [
  ...CAPACITY_CRASH_BOUNDARIES.map((boundary) => ({
    case_id: `fault.${boundary.boundary_id}`,
    area: 'publication_recovery' as const,
    scenario: boundary.boundary_id,
    expected_result: boundary.recovery_action,
    expected_head_effect:
      boundary.committed_head_visibility === 'new'
        ? ('committed' as const)
        : ('unchanged' as const),
    assertion: `Recovery preserves ${boundary.watcher_visibility} watcher visibility until the declared boundary`,
  })),
  {
    case_id: 'fault.direct-file-tamper-recovery',
    area: 'publication_recovery',
    scenario: 'direct_file_tamper',
    expected_result: 'unauthorized_file_rejected',
    expected_head_effect: 'unchanged',
    assertion:
      'valid-looking unaudited file never becomes authority and Publisher restores audited bytes',
  },
  {
    case_id: 'fault.cold-start-head-file-mismatch',
    area: 'publication_recovery',
    scenario: 'cold_start_mismatch',
    expected_result: 'admission_disabled_fail_closed',
    expected_head_effect: 'unchanged',
    assertion:
      'cold start without verifiable matching head and snapshot disables new admission',
  },
  {
    case_id: 'fault.upgrade-preserves-capacity',
    area: 'upgrade',
    scenario: 'upgrade_preservation',
    expected_result: 'existing_head_file_and_audit_preserved',
    expected_head_effect: 'unchanged',
    assertion:
      'upgrade never replaces existing publication with checked-in bootstrap baseline',
  },
  {
    case_id: 'fault.cap4-recovery-preserves-prepared-invocation',
    area: 'publication_recovery',
    scenario: 'cap4_recovery_preserves_prepared_invocation',
    expected_result: 'prepared_unchanged_command_finalized_idempotently',
    expected_head_effect: 'committed',
    assertion:
      'CAP4 crash recovery idempotently completes Event and Command finalization without updating the CAP1 prepared invocation',
  },
] as const satisfies readonly CapacityConformanceCase[];

function invalidPublication(): DeploymentRuntimeCapacityPublication {
  return {
    ...buildDeploymentCapacityPublication(
      5,
      'capacity-change:5',
      baselineCapacity().config_hash,
      capacityWith({ max_active_executions: 6 }),
    ),
    publication_hash: HASH_A,
  };
}

export function validateCapacityAdmissionLineage(
  pointer: CapacityAdmissionLineage,
  admission: CapacityAdmissionLineage,
): string {
  return pointer.capacity_revision === admission.capacity_revision &&
    pointer.capacity_change_id === admission.capacity_change_id &&
    pointer.capacity_config_hash === admission.capacity_config_hash
    ? 'valid'
    : 'admission_capacity_lineage_mismatch';
}

export function evaluateCapacityControlPlaneCase(
  candidate: CapacityConformanceCase,
): string {
  const lifecycleScenarios = {
    cap1_prepared_invocation_shape: {
      invocation_no: 1,
      submitted_request_matches_command: true,
      command_result_state: 'pending',
      authorization_result: 'allowed',
      execution_result: 'prepared',
      denial_code: null,
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: null,
    },
    prepared_denied_authorization: {
      invocation_no: 1,
      submitted_request_matches_command: true,
      command_result_state: 'pending',
      authorization_result: 'denied',
      execution_result: 'prepared',
      denial_code: 'permission_denied',
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: null,
    },
    prepared_with_denial_code: {
      invocation_no: 1,
      submitted_request_matches_command: true,
      command_result_state: 'pending',
      authorization_result: 'allowed',
      execution_result: 'prepared',
      denial_code: 'permission_denied',
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: null,
    },
    prepared_with_applied_time: {
      invocation_no: 1,
      submitted_request_matches_command: true,
      command_result_state: 'pending',
      authorization_result: 'allowed',
      execution_result: 'prepared',
      denial_code: null,
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: 101,
    },
    prepared_decision_before_request: {
      invocation_no: 1,
      submitted_request_matches_command: true,
      command_result_state: 'pending',
      authorization_result: 'allowed',
      execution_result: 'prepared',
      denial_code: null,
      requested_at_ms: 100,
      decided_at_ms: 99,
      applied_at_ms: null,
    },
    prepared_non_initial_invocation: {
      invocation_no: 2,
      submitted_request_matches_command: true,
      command_result_state: 'pending',
      authorization_result: 'allowed',
      execution_result: 'prepared',
      denial_code: null,
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: null,
    },
    duplicate_before_command_finalization: {
      invocation_no: 2,
      submitted_request_matches_command: true,
      command_result_state: 'pending',
      authorization_result: 'allowed',
      execution_result: 'duplicate',
      denial_code: null,
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: null,
    },
    duplicate_request_mismatch: {
      invocation_no: 2,
      submitted_request_matches_command: false,
      command_result_state: 'finalized',
      authorization_result: 'allowed',
      execution_result: 'duplicate',
      denial_code: null,
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: null,
    },
    applied_current_schema: {
      invocation_no: 1,
      submitted_request_matches_command: true,
      command_result_state: 'finalized',
      authorization_result: 'allowed',
      execution_result: 'applied',
      denial_code: null,
      requested_at_ms: 100,
      decided_at_ms: 100,
      applied_at_ms: 101,
    },
  } as const;
  const lifecycle =
    lifecycleScenarios[candidate.scenario as keyof typeof lifecycleScenarios];
  if (lifecycle) return validateCapacityAdminInvocationLifecycle(lifecycle);
  if (candidate.scenario === 'cap4_retry_duplicate_preserves_prepared')
    return 'canonical_result_new_duplicate_prepared_unchanged';
  if (candidate.scenario === 'cap4_recovery_preserves_prepared_invocation')
    return 'prepared_unchanged_command_finalized_idempotently';
  if (candidate.scenario === 'valid_publication') {
    const publication = buildDeploymentCapacityPublication(
      5,
      'capacity-change:5',
      baselineCapacity().config_hash,
      capacityWith({ max_active_executions: 6 }),
    );
    return validateCapacityPublication(publication) ?? 'valid';
  }
  if (candidate.scenario === 'invalid_publication_hash')
    return validateCapacityPublication(invalidPublication()) ?? 'valid';
  if (candidate.scenario === 'admission_lineage_matches_pointer') {
    const lineage = {
      capacity_revision: 5,
      capacity_change_id: 'capacity-change:5',
      capacity_config_hash: capacityWith({ max_active_executions: 6 })
        .config_hash,
    };
    return validateCapacityAdmissionLineage(lineage, { ...lineage });
  }
  const model = MODEL_SCENARIOS[candidate.scenario];
  if (model)
    return evaluateCapacityAdminModel(
      model.invocation,
      model.head,
      model.command,
    );
  const boundary = CAPACITY_CRASH_BOUNDARIES.find(
    (entry) => entry.boundary_id === candidate.scenario,
  );
  if (boundary) return boundary.recovery_action;
  if (candidate.scenario === 'direct_file_tamper')
    return 'unauthorized_file_rejected';
  if (candidate.scenario === 'cold_start_mismatch')
    return 'admission_disabled_fail_closed';
  if (candidate.scenario === 'upgrade_preservation')
    return 'existing_head_file_and_audit_preserved';
  return 'unknown_fixture_scenario';
}

export const CAPACITY_FIXTURE_HASHES = {
  hash_a: HASH_A,
  hash_b: HASH_B,
  active_core_release_hash: ACTIVE_CORE_RELEASE_HASH,
} as const;
