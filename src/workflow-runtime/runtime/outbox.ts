import {
  CAPABILITY_OUTBOX_ADAPTER_DOMAIN,
  CAPABILITY_OUTBOX_EXECUTION_BINDING_DOMAIN,
  CAPABILITY_OUTBOX_POLICY_DOMAIN,
  capabilityOutboxPolicySnapshotHash,
} from '../contracts/capability-outbox-binding-contract.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  insertInlineValue,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import { reserveLedgerResources } from './ledger.js';
import { loadMaterializedNodeAuthority } from './plan-authority.js';

interface PlanExecutionBinding extends JsonObject {
  readonly adapter_identity: JsonObject & {
    readonly resource_type: 'outbox_adapter';
    readonly ref: VersionedRef;
    readonly content_hash: Sha256Hash;
  };
  readonly delivery_policy_identity: JsonObject & {
    readonly resource_type: 'outbox_policy';
    readonly ref: VersionedRef;
    readonly content_hash: Sha256Hash;
  };
  readonly effective_policy_snapshot: JsonObject & {
    readonly format: 'icarus.workflow-outbox-effective-policy-snapshot/1';
    readonly snapshot_hash: Sha256Hash;
  };
  readonly effect_contract: JsonObject & {
    readonly adapter_ref: VersionedRef;
    readonly delivery_policy_ref: VersionedRef;
    readonly effect_type: string;
    readonly delivery_lane: 'normal_execution';
    readonly delivery_requirement: 'required';
    readonly idempotency: 'provider_key' | 'external_lookup';
    readonly reconciliation: JsonObject;
  };
  readonly binding_hash: Sha256Hash;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort().join('\n');
  if (actual !== [...expected].sort().join('\n'))
    throw new G5RuntimeError(
      'contract_invalid',
      `${label} has an unknown or missing field`,
    );
}

function validateBinding(candidate: unknown): PlanExecutionBinding {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new G5RuntimeError(
      'contract_invalid',
      'T5 requires Plan v2 outbox_execution_binding',
    );
  const binding = candidate as PlanExecutionBinding;
  exactKeys(
    binding,
    [
      'adapter_identity',
      'binding_hash',
      'delivery_policy_identity',
      'effect_contract',
      'effective_policy_snapshot',
    ],
    'outbox_execution_binding',
  );
  exactKeys(
    binding.effect_contract,
    [
      'adapter_ref',
      'delivery_lane',
      'delivery_policy_ref',
      'delivery_requirement',
      'effect_type',
      'idempotency',
      'reconciliation',
    ],
    'effect_contract',
  );
  exactKeys(
    binding.effective_policy_snapshot,
    [
      'effective_policy',
      'format',
      'runtime_safety_hash',
      'snapshot_hash',
      'source_policy_content_hash',
      'source_policy_hash',
      'source_policy_ref',
    ],
    'effective_policy_snapshot',
  );
  for (const [label, ref] of [
    ['adapter_identity.ref', binding.adapter_identity.ref],
    ['delivery_policy_identity.ref', binding.delivery_policy_identity.ref],
    ['effect_contract.adapter_ref', binding.effect_contract.adapter_ref],
    [
      'effect_contract.delivery_policy_ref',
      binding.effect_contract.delivery_policy_ref,
    ],
    [
      'effective_policy_snapshot.source_policy_ref',
      binding.effective_policy_snapshot.source_policy_ref as JsonObject,
    ],
  ] as const)
    exactKeys(ref as JsonObject, ['id', 'version'], label);
  const reconciliation = binding.effect_contract.reconciliation;
  exactKeys(
    reconciliation,
    reconciliation.type === 'not_required'
      ? ['type']
      : ['reconcile_action_ref', 'type'],
    'effect_contract.reconciliation',
  );
  exactKeys(
    binding.adapter_identity,
    ['content_hash', 'ref', 'resource_type'],
    'adapter_identity',
  );
  exactKeys(
    binding.delivery_policy_identity,
    ['content_hash', 'ref', 'resource_type'],
    'delivery_policy_identity',
  );
  if (
    binding.adapter_identity.resource_type !== 'outbox_adapter' ||
    binding.delivery_policy_identity.resource_type !== 'outbox_policy' ||
    binding.effect_contract.delivery_lane !== 'normal_execution' ||
    binding.effect_contract.delivery_requirement !== 'required' ||
    /^(?:latest|current|head|main|master|next|snapshot)$/i.test(
      binding.adapter_identity.ref.version,
    ) ||
    /^(?:latest|current|head|main|master|next|snapshot)$/i.test(
      binding.delivery_policy_identity.ref.version,
    ) ||
    canonicalJson(binding.effect_contract.adapter_ref) !==
      canonicalJson(binding.adapter_identity.ref) ||
    canonicalJson(binding.effect_contract.delivery_policy_ref) !==
      canonicalJson(binding.delivery_policy_identity.ref)
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'T5 execution binding is not exact and finite',
    );
  const { snapshot_hash: snapshotHash, ...snapshotWithoutHash } =
    binding.effective_policy_snapshot;
  if (capabilityOutboxPolicySnapshotHash(snapshotWithoutHash) !== snapshotHash)
    throw new G5RuntimeError(
      'integrity_violation',
      'T5 effective Policy snapshot hash drift',
    );
  const { binding_hash: bindingHash, ...bindingWithoutHash } = binding;
  if (
    domainSeparatedSha256(
      CAPABILITY_OUTBOX_EXECUTION_BINDING_DOMAIN,
      bindingWithoutHash,
    ) !== bindingHash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T5 execution binding hash drift',
    );
  return binding;
}

const EFFECTIVE_POLICY_KEYS = [
  'attempt_timeout_ms',
  'backoff',
  'delivery_duration_ms',
  'deterministic_jitter_micros',
  'honor_retry_after',
  'initial_backoff_ms',
  'max_backoff_ms',
  'max_delivery_attempts',
  'max_reconcile_attempts',
  'permanent_error_codes',
  'retryable_error_codes',
] as const;

function finiteInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function uniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function validateEffectivePolicy(policy: JsonObject): void {
  exactKeys(policy, EFFECTIVE_POLICY_KEYS, 'effective_policy');
  const retryable = policy.retryable_error_codes;
  const permanent = policy.permanent_error_codes;
  if (
    !finiteInteger(policy.max_delivery_attempts, 1) ||
    !finiteInteger(policy.max_reconcile_attempts, 0) ||
    !finiteInteger(policy.delivery_duration_ms, 1) ||
    !finiteInteger(policy.attempt_timeout_ms, 1) ||
    Number(policy.attempt_timeout_ms) > Number(policy.delivery_duration_ms) ||
    !finiteInteger(policy.initial_backoff_ms, 0) ||
    !finiteInteger(policy.max_backoff_ms, 0) ||
    Number(policy.initial_backoff_ms) > Number(policy.max_backoff_ms) ||
    !['fixed', 'exponential'].includes(String(policy.backoff)) ||
    !finiteInteger(policy.deterministic_jitter_micros, 0) ||
    Number(policy.deterministic_jitter_micros) > 1_000_000 ||
    typeof policy.honor_retry_after !== 'boolean' ||
    !uniqueStrings(retryable) ||
    !uniqueStrings(permanent) ||
    retryable.some((code) => permanent.includes(code))
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'T5 effective Delivery Policy is not finite or internally consistent',
    );
}

function validatePublishedBindingResources(
  binding: PlanExecutionBinding,
  adapter: JsonObject,
  policy: JsonObject,
): void {
  exactKeys(
    adapter,
    [
      'adapter_hash',
      'format',
      'ref',
      'supported_delivery_lanes',
      'supported_effect_types',
      'supported_idempotency',
      'supported_reconciliation',
    ],
    'Published Outbox Adapter',
  );
  exactKeys(adapter.ref as JsonObject, ['id', 'version'], 'Adapter ref');
  const { adapter_hash: adapterHash, ...adapterWithoutHash } = adapter;
  const reconciliation = binding.effect_contract.reconciliation;
  if (
    adapter.format !== 'icarus.workflow-outbox-adapter/1' ||
    canonicalJson(adapter.ref as JsonObject) !==
      canonicalJson(binding.adapter_identity.ref) ||
    adapterHash !==
      domainSeparatedSha256(
        CAPABILITY_OUTBOX_ADAPTER_DOMAIN,
        adapterWithoutHash,
      ) ||
    !uniqueStrings(adapter.supported_effect_types) ||
    !adapter.supported_effect_types.includes(
      binding.effect_contract.effect_type,
    ) ||
    !uniqueStrings(adapter.supported_delivery_lanes) ||
    !adapter.supported_delivery_lanes.includes('normal_execution') ||
    !uniqueStrings(adapter.supported_reconciliation) ||
    !adapter.supported_reconciliation.includes(String(reconciliation.type)) ||
    !uniqueStrings(adapter.supported_idempotency) ||
    !adapter.supported_idempotency.includes(binding.effect_contract.idempotency)
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T5 Published Adapter does not match the sealed execution contract',
    );

  exactKeys(
    policy,
    ['format', 'policy_hash', 'ref', ...EFFECTIVE_POLICY_KEYS],
    'Published Delivery Policy',
  );
  exactKeys(policy.ref as JsonObject, ['id', 'version'], 'Policy ref');
  const {
    policy_hash: policyHash,
    format: policyFormat,
    ref,
    ...policyValues
  } = policy;
  validateEffectivePolicy(policyValues);
  const effective = binding.effective_policy_snapshot
    .effective_policy as JsonObject;
  validateEffectivePolicy(effective);
  if (
    policyFormat !== 'icarus.workflow-outbox-delivery-policy/1' ||
    canonicalJson(ref as JsonObject) !==
      canonicalJson(binding.delivery_policy_identity.ref) ||
    policyHash !==
      domainSeparatedSha256(CAPABILITY_OUTBOX_POLICY_DOMAIN, {
        format: policyFormat,
        ref,
        ...policyValues,
      }) ||
    canonicalJson(binding.effective_policy_snapshot.source_policy_ref) !==
      canonicalJson(binding.delivery_policy_identity.ref) ||
    binding.effective_policy_snapshot.source_policy_hash !== policyHash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T5 Published Delivery Policy identity drifted',
    );
  for (const key of [
    'max_delivery_attempts',
    'max_reconcile_attempts',
    'delivery_duration_ms',
    'attempt_timeout_ms',
    'initial_backoff_ms',
    'max_backoff_ms',
  ] as const)
    if (Number(effective[key]) > Number(policyValues[key]))
      throw new G5RuntimeError(
        'integrity_violation',
        `T5 effective Policy widens ${key}`,
      );
  for (const key of [
    'backoff',
    'deterministic_jitter_micros',
    'honor_retry_after',
    'retryable_error_codes',
    'permanent_error_codes',
  ] as const)
    if (
      canonicalJson(effective[key] as JsonValue) !==
      canonicalJson(policyValues[key] as JsonValue)
    )
      throw new G5RuntimeError(
        'integrity_violation',
        `T5 effective Policy changes ${key}`,
      );
}

function exactPublishedRegistryRow(
  store: WorkflowRuntimeWriteTransaction,
  identity:
    | PlanExecutionBinding['adapter_identity']
    | PlanExecutionBinding['delivery_policy_identity'],
): { rowId: string; content: JsonObject } {
  const rowId = registryResourceId({
    resource_type: identity.resource_type,
    ref: identity.ref,
  });
  const row = store.queryOne<{
    id: string;
    content_hash: string;
    publication_state: string;
    inline_canonical_json: string;
    payload_state: string;
  }>(
    `SELECT r.id, r.content_hash, r.publication_state,
            v.inline_canonical_json, v.payload_state
       FROM workflow_registry_resources r
       JOIN workflow_values v ON v.id = r.canonical_value_id
      WHERE r.resource_type = ? AND r.resource_id = ? AND r.resource_version = ?`,
    [identity.resource_type, identity.ref.id, identity.ref.version],
  );
  if (
    !row ||
    row.id !== rowId ||
    row.content_hash !== identity.content_hash ||
    row.publication_state !== 'published' ||
    row.payload_state !== 'live'
  )
    throw new G5RuntimeError(
      'precondition_failed',
      `T5 exact Published ${identity.resource_type} is unavailable`,
    );
  const content = JSON.parse(row.inline_canonical_json) as JsonObject;
  if (
    content.launchability === 'test_only' ||
    /(?:^|[.:/_-])test(?:[.:/_-]?only)?(?:$|[.:/_-])/i.test(identity.ref.id)
  )
    throw new G5RuntimeError(
      'forbidden_surface',
      'T5 cannot promote test-only Registry authority',
    );
  return { rowId, content };
}

export interface T5DispatchInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly expectedAttemptRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly request: RuntimeValueRef;
  readonly policySnapshotSchema: RuntimeRegistryRef;
  readonly operationKey: string;
  readonly requiredClaims: readonly {
    claimId: string;
    claimSpecId: string;
    access: 'read' | 'write';
    fencingToken: number | null;
  }[];
  readonly dispatchDeadlineAtMs: number;
  readonly outboxDeadlineAtMs: number;
  readonly nowMs: number;
}

export interface T5DispatchReceipt {
  readonly disposition: 'dispatch_pending' | 'exact_replay';
  readonly effectOperationId: string;
  readonly outboxId: string;
  readonly policySnapshotValueId: string;
}

export function prepareCapabilityDispatchT5(
  store: WorkflowRuntimeStore,
  input: T5DispatchInput,
  fault?: G5TransactionFault,
): T5DispatchReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const authority = loadMaterializedNodeAuthority(
        transaction,
        input.graphRunId,
        input.scopeId,
        input.nodeId,
      );
      if (
        authority.runWorkFenceEpoch !== input.expectedRunWorkFenceEpoch ||
        authority.scopeWorkFenceEpoch !== input.expectedScopeWorkFenceEpoch
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T5 current Run/Scope work epoch drifted',
        );
      const binding = validateBinding(authority.node.outbox_execution_binding);
      if (
        binding.effective_policy_snapshot.runtime_safety_hash !==
          authority.runtimeSafetyHash ||
        binding.effective_policy_snapshot.source_policy_content_hash !==
          binding.delivery_policy_identity.content_hash
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'T5 Plan binding safety or Policy source identity drifted',
        );
      const adapter = exactPublishedRegistryRow(
        transaction,
        binding.adapter_identity,
      );
      const policy = exactPublishedRegistryRow(
        transaction,
        binding.delivery_policy_identity,
      );
      validatePublishedBindingResources(
        binding,
        adapter.content,
        policy.content,
      );
      const effectOperationId = stableRuntimeId('effect', {
        attempt_id: input.attemptId,
        operation_key: input.operationKey,
      });
      const outboxId = stableRuntimeId('outbox', {
        effect_operation_id: effectOperationId,
        operation_key: input.operationKey,
      });
      const policySnapshotValueId = stableRuntimeId('policy-value', {
        snapshot_hash: binding.effective_policy_snapshot.snapshot_hash,
      });
      const keyStrategy: JsonObject = {
        type: binding.effect_contract.idempotency,
        operation_key: input.operationKey,
        execution_binding_hash: binding.binding_hash,
      };
      const keyStrategyJson = canonicalJson(keyStrategy);
      const keyStrategyHash = domainSeparatedSha256(
        'icarus:workflow-effect-key-strategy:1\n',
        keyStrategy,
      );
      const attempt = transaction.queryOne<{
        phase: string;
        acceptance_state: string;
        run_work_fence_epoch: number;
        scope_work_fence_epoch: number;
        context_pack_value_id: string | null;
        context_pack_hash: string | null;
        row_version: number;
      }>(
        `SELECT phase, acceptance_state, run_work_fence_epoch,
                scope_work_fence_epoch, context_pack_value_id,
                context_pack_hash, row_version
           FROM workflow_graph_node_attempts
          WHERE id = ? AND graph_run_id = ? AND scope_id = ? AND node_id = ?`,
        [input.attemptId, input.graphRunId, input.scopeId, input.nodeId],
      );
      if (
        !attempt ||
        attempt.context_pack_value_id === null ||
        attempt.context_pack_hash === null
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'T5 attempt lacks its Plan-derived context pack',
        );
      const contextPack = {
        id: attempt.context_pack_value_id,
        hash: attempt.context_pack_hash,
      };
      const existing = transaction.queryOne<{
        id: string;
        policy_snapshot_value_id: string;
        policy_snapshot_hash: string;
        adapter_resource_id: string;
        adapter_resource_hash: string;
        delivery_policy_resource_id: string;
        delivery_policy_resource_hash: string;
        payload_value_id: string;
        payload_hash: string;
        effect_type: string;
        delivery_lane: string;
        delivery_requirement: string;
        deadline_at_ms: number;
        operation_key: string;
        key_strategy_json: string;
        key_strategy_hash: string;
        request_value_id: string;
        request_hash: string;
        context_pack_value_id: string | null;
        context_pack_hash: string | null;
      }>(
        `SELECT o.id, o.policy_snapshot_value_id, o.policy_snapshot_hash,
                o.adapter_resource_id, o.adapter_resource_hash,
                o.delivery_policy_resource_id, o.delivery_policy_resource_hash,
                o.payload_value_id, o.payload_hash, o.effect_type,
                o.delivery_lane, o.delivery_requirement, o.deadline_at_ms,
                e.operation_key, e.key_strategy_json, e.key_strategy_hash,
                e.request_value_id, e.request_hash,
                a.context_pack_value_id, a.context_pack_hash
           FROM workflow_outbox o
           JOIN workflow_graph_effect_operations e ON e.id = o.effect_operation_id
           JOIN workflow_graph_node_attempts a ON a.id = e.attempt_id
          WHERE o.effect_key = ?`,
        [input.operationKey],
      );
      if (existing) {
        if (
          existing.id !== outboxId ||
          existing.policy_snapshot_value_id !== policySnapshotValueId ||
          existing.policy_snapshot_hash !==
            binding.effective_policy_snapshot.snapshot_hash ||
          existing.adapter_resource_id !== adapter.rowId ||
          existing.adapter_resource_hash !==
            binding.adapter_identity.content_hash ||
          existing.delivery_policy_resource_id !== policy.rowId ||
          existing.delivery_policy_resource_hash !==
            binding.delivery_policy_identity.content_hash ||
          existing.payload_value_id !== input.request.id ||
          existing.payload_hash !== input.request.hash ||
          existing.effect_type !== binding.effect_contract.effect_type ||
          existing.delivery_lane !== 'normal_execution' ||
          existing.delivery_requirement !== 'required' ||
          existing.deadline_at_ms !== input.outboxDeadlineAtMs ||
          existing.operation_key !== input.operationKey ||
          existing.key_strategy_json !== keyStrategyJson ||
          existing.key_strategy_hash !== keyStrategyHash ||
          existing.request_value_id !== input.request.id ||
          existing.request_hash !== input.request.hash ||
          existing.context_pack_value_id !== contextPack.id ||
          existing.context_pack_hash !== contextPack.hash
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T5 operation key replay drift',
          );
        return {
          disposition: 'exact_replay',
          effectOperationId,
          outboxId,
          policySnapshotValueId,
        };
      }
      const run = transaction.queryOne<{
        control: string;
        operational_state: string;
      }>(
        'SELECT control, operational_state FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      if (
        !attempt ||
        !run ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        !['preparing', 'dispatch_pending'].includes(attempt.phase) ||
        attempt.acceptance_state !== 'open' ||
        attempt.row_version !== input.expectedAttemptRowVersion ||
        attempt.run_work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        attempt.scope_work_fence_epoch !== input.expectedScopeWorkFenceEpoch
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T5 attempt, run, or work epoch is stale',
        );
      assertExactPublishedRegistryResource(
        transaction,
        input.policySnapshotSchema,
        'T5 effective Policy snapshot schema',
      );
      for (const required of input.requiredClaims) {
        const claim = transaction.queryOne<{
          status: string;
          fencing_token: number | null;
        }>(
          'SELECT status, fencing_token FROM workflow_domain_resource_claims WHERE id = ?',
          [required.claimId],
        );
        if (
          !claim ||
          claim.status !== 'held' ||
          (required.access === 'write' &&
            (required.fencingToken === null ||
              claim.fencing_token !== required.fencingToken)) ||
          (required.access === 'read' && required.fencingToken !== null)
        )
          throw new G5RuntimeError(
            'precondition_failed',
            `T5 required claim is not held/current: ${required.claimId}`,
          );
      }
      reserveLedgerResources(transaction, {
        graphRunId: input.graphRunId,
        reservationGroupId: stableRuntimeId('reservation-group', {
          effect_operation_id: effectOperationId,
        }),
        consumer: { effectId: effectOperationId },
        amounts: { effect_operations_total: 1 },
        purpose: 'effect_operation',
        settlementMode: 'consume_on_create',
        nowMs: input.nowMs,
      });
      insertInlineValue(transaction, {
        id: policySnapshotValueId,
        content: binding.effective_policy_snapshot,
        contentHash: binding.effective_policy_snapshot.snapshot_hash,
        schemaResourceId: input.policySnapshotSchema.rowId,
        schemaResourceHash: input.policySnapshotSchema.hash,
        provenanceRef: 'icarus.workflow-g5-t5/1',
        retentionClass: 'run_recovery',
        createdAtMs: input.nowMs,
      });
      transaction.execute(
        `INSERT INTO workflow_graph_effect_operations (
       id, graph_run_id, scope_id, node_id, attempt_id, operation_key,
       key_strategy_json, key_strategy_hash, execution_lane, close_request_id,
       effect_type, status, request_value_id, request_hash, receipt_value_id,
       receipt_hash, before_state_value_id, before_state_hash,
       after_state_value_id, after_state_hash, immutable_output_snapshot_value_id,
       immutable_output_snapshot_hash, compensation_value_id, compensation_hash,
       lease_owner, lease_token, lease_expires_at_ms, row_version, created_at_ms,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal', NULL, ?, 'intended', ?, ?,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, 1, ?, ?)`,
        [
          effectOperationId,
          input.graphRunId,
          input.scopeId,
          input.nodeId,
          input.attemptId,
          input.operationKey,
          keyStrategyJson,
          keyStrategyHash,
          binding.effect_contract.effect_type,
          input.request.id,
          input.request.hash,
          input.nowMs,
          input.nowMs,
        ],
      );
      for (const required of input.requiredClaims)
        transaction.execute(
          'INSERT INTO workflow_graph_effect_operation_claims (operation_id, claim_id, claim_spec_id, access, fencing_token) VALUES (?, ?, ?, ?, ?)',
          [
            effectOperationId,
            required.claimId,
            required.claimSpecId,
            required.access,
            required.fencingToken,
          ],
        );
      transaction.execute(
        `INSERT INTO workflow_outbox (
       id, effect_key, workflow_id, attempt_id, wait_id, effect_operation_id,
       domain_claim_id, projection_target_ref, aggregate_row_version, effect_type,
       adapter_resource_id, adapter_resource_hash, delivery_policy_resource_id,
       delivery_policy_resource_hash, policy_snapshot_value_id,
       policy_snapshot_hash, delivery_lane, delivery_requirement,
       payload_value_id, payload_hash, status, delivery_attempt_count,
       reconcile_attempt_count, next_attempt_at_ms, deadline_at_ms, lease_owner,
       lease_token, lease_expires_at_ms, last_result_kind, last_error_code,
       created_at_ms, delivered_at_ms, updated_at_ms
     ) VALUES (?, ?, NULL, NULL, NULL, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?, ?,
       'normal_execution', 'required', ?, ?, 'pending', 0, 0, ?, ?, NULL, NULL,
       NULL, NULL, NULL, ?, NULL, ?)`,
        [
          outboxId,
          input.operationKey,
          effectOperationId,
          binding.effect_contract.effect_type,
          adapter.rowId,
          binding.adapter_identity.content_hash,
          policy.rowId,
          binding.delivery_policy_identity.content_hash,
          policySnapshotValueId,
          binding.effective_policy_snapshot.snapshot_hash,
          input.request.id,
          input.request.hash,
          input.nowMs,
          input.outboxDeadlineAtMs,
          input.nowMs,
          input.nowMs,
        ],
      );
      const changed = transaction.execute(
        "UPDATE workflow_graph_node_attempts SET context_pack_value_id = ?, context_pack_hash = ?, delegation_id = coalesce(delegation_id, ?), phase = 'dispatch_pending', dispatch_started_at_ms = ?, dispatch_deadline_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase IN ('preparing', 'dispatch_pending') AND acceptance_state = 'open' AND run_work_fence_epoch = ? AND scope_work_fence_epoch = ?",
        [
          contextPack.id,
          contextPack.hash,
          authority.node.type === 'delegation'
            ? stableRuntimeId('delegation', { attempt_id: input.attemptId })
            : null,
          input.nowMs,
          input.dispatchDeadlineAtMs,
          input.nowMs,
          input.attemptId,
          input.expectedAttemptRowVersion,
          input.expectedRunWorkFenceEpoch,
          input.expectedScopeWorkFenceEpoch,
        ],
      ).changes;
      if (changed !== 1)
        throw new G5RuntimeError('cas_conflict', 'T5 attempt CAS failed');
      return {
        disposition: 'dispatch_pending',
        effectOperationId,
        outboxId,
        policySnapshotValueId,
      };
    },
    fault,
  );
}

export interface OutboxLease {
  readonly outboxId: string;
  readonly attemptKind: 'deliver' | 'reconcile';
  readonly historySequence: number;
  readonly kindAttemptNo: number;
  readonly adapterResourceId: string;
  readonly adapterResourceHash: Sha256Hash;
  readonly policyHash: Sha256Hash;
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
  readonly deadlineAtMs: number;
  readonly request: RuntimeValueRef;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}

export function leaseOutboxWork(
  store: WorkflowRuntimeStore,
  input: {
    readonly outboxId: string;
    readonly leaseOwner: string;
    readonly leaseToken: string;
    readonly leaseExpiresAtMs: number;
    readonly nowMs: number;
  },
): OutboxLease {
  return store.withImmediateTransaction((transaction) => {
    const row = transaction.queryOne<{
      status: string;
      adapter_resource_id: string;
      adapter_resource_hash: Sha256Hash;
      policy_snapshot_hash: Sha256Hash;
      payload_value_id: string;
      payload_hash: Sha256Hash;
      delivery_attempt_count: number;
      reconcile_attempt_count: number;
      deadline_at_ms: number;
      policy_snapshot_json: string;
      rowid: number;
    }>(
      `SELECT o.rowid AS rowid, o.status, o.adapter_resource_id, o.adapter_resource_hash,
              policy_snapshot_hash, payload_value_id, payload_hash,
              delivery_attempt_count, reconcile_attempt_count, deadline_at_ms,
              v.inline_canonical_json AS policy_snapshot_json
         FROM workflow_outbox o
         JOIN workflow_values v ON v.id = o.policy_snapshot_value_id
        WHERE o.id = ? AND o.status IN ('pending', 'reconciling')
          AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
          AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)`,
      [input.outboxId, input.nowMs, input.nowMs],
    );
    if (!row)
      throw new G5RuntimeError(
        'resource_unavailable',
        'Outbox work is not due or already leased',
      );
    const attemptKind = row.status === 'reconciling' ? 'reconcile' : 'deliver';
    const policySnapshot = JSON.parse(row.policy_snapshot_json) as JsonObject;
    const effectivePolicy = policySnapshot.effective_policy as JsonObject;
    validateEffectivePolicy(effectivePolicy);
    const maxAttempts = Number(
      attemptKind === 'deliver'
        ? effectivePolicy.max_delivery_attempts
        : effectivePolicy.max_reconcile_attempts,
    );
    const completedAttempts =
      attemptKind === 'deliver'
        ? row.delivery_attempt_count
        : row.reconcile_attempt_count;
    const attemptTimeoutMs = Number(effectivePolicy.attempt_timeout_ms);
    if (
      input.nowMs > row.deadline_at_ms ||
      completedAttempts >= maxAttempts ||
      input.leaseExpiresAtMs <= input.nowMs ||
      input.leaseExpiresAtMs > row.deadline_at_ms ||
      input.leaseExpiresAtMs - input.nowMs > attemptTimeoutMs
    )
      throw new G5RuntimeError(
        'resource_unavailable',
        'Outbox finite attempt or delivery window is exhausted',
      );
    const historySequence = transaction.queryOne<{ value: number }>(
      'SELECT count(*) + 1 AS value FROM workflow_outbox_attempts WHERE outbox_id = ?',
      [input.outboxId],
    )!.value;
    const kindAttemptNo =
      attemptKind === 'deliver'
        ? row.delivery_attempt_count + 1
        : row.reconcile_attempt_count + 1;
    const changed = transaction.execute(
      "UPDATE workflow_outbox SET status = 'processing', lease_owner = ?, lease_token = ?, lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND rowid = ? AND status IN ('pending', 'reconciling')",
      [
        input.leaseOwner,
        input.leaseToken,
        input.leaseExpiresAtMs,
        input.nowMs,
        input.outboxId,
        row.rowid,
      ],
    ).changes;
    if (changed !== 1)
      throw new G5RuntimeError('cas_conflict', 'Outbox lease CAS failed');
    return {
      outboxId: input.outboxId,
      attemptKind,
      historySequence,
      kindAttemptNo,
      adapterResourceId: row.adapter_resource_id,
      adapterResourceHash: row.adapter_resource_hash,
      policyHash: row.policy_snapshot_hash,
      maxAttempts,
      attemptTimeoutMs,
      deadlineAtMs: row.deadline_at_ms,
      request: { id: row.payload_value_id, hash: row.payload_hash },
      leaseOwner: input.leaseOwner,
      leaseToken: input.leaseToken,
    };
  });
}

export type OutboxDeliveryResultKind =
  | 'not_applied'
  | 'applied_with_receipt'
  | 'applied_but_receipt_lost'
  | 'still_running'
  | 'unknown';

export function recordOutboxResult(
  store: WorkflowRuntimeStore,
  lease: OutboxLease,
  input: {
    readonly resultKind: OutboxDeliveryResultKind;
    readonly resultCode: string | null;
    readonly receipt: RuntimeValueRef | null;
    readonly afterState: RuntimeValueRef | null;
    readonly immutableOutput: RuntimeValueRef | null;
    readonly externalId: string | null;
    readonly nextAttemptAtMs: number | null;
    readonly attemptsExhausted: boolean;
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
  },
): 'succeeded' | 'pending' | 'reconciling' | 'action_required' {
  return store.withImmediateTransaction((transaction) => {
    const terminalSuccess = input.resultKind === 'applied_with_receipt';
    const derivedExhaustion = lease.kindAttemptNo >= lease.maxAttempts;
    if (input.attemptsExhausted !== derivedExhaustion)
      throw new G5RuntimeError(
        'contract_invalid',
        'Outbox exhaustion must be derived from the immutable Delivery Policy',
      );
    const actionRequired = !terminalSuccess && derivedExhaustion;
    const nextStatus = terminalSuccess
      ? 'succeeded'
      : actionRequired
        ? 'action_required'
        : ['unknown', 'applied_but_receipt_lost', 'still_running'].includes(
              input.resultKind,
            )
          ? 'reconciling'
          : 'pending';
    if (
      !terminalSuccess &&
      !actionRequired &&
      (!Number.isSafeInteger(input.nextAttemptAtMs) ||
        input.nextAttemptAtMs! < input.finishedAtMs ||
        input.nextAttemptAtMs! > lease.deadlineAtMs)
    )
      throw new G5RuntimeError(
        'contract_invalid',
        'Outbox retry must stay inside the immutable finite delivery window',
      );
    const row = transaction.queryOne<{
      effect_operation_id: string | null;
      status: string;
      lease_owner: string | null;
      lease_token: string | null;
      adapter_resource_id: string;
      adapter_resource_hash: Sha256Hash;
      policy_snapshot_hash: Sha256Hash;
      payload_value_id: string;
      payload_hash: Sha256Hash;
      delivery_attempt_count: number;
      reconcile_attempt_count: number;
    }>(
      'SELECT effect_operation_id, status, lease_owner, lease_token, adapter_resource_id, adapter_resource_hash, policy_snapshot_hash, payload_value_id, payload_hash, delivery_attempt_count, reconcile_attempt_count FROM workflow_outbox WHERE id = ?',
      [lease.outboxId],
    );
    if (
      !row ||
      row.status !== 'processing' ||
      row.lease_owner !== lease.leaseOwner ||
      row.lease_token !== lease.leaseToken ||
      row.adapter_resource_id !== lease.adapterResourceId ||
      row.adapter_resource_hash !== lease.adapterResourceHash ||
      row.policy_snapshot_hash !== lease.policyHash
    ) {
      const priorAttempt = transaction.queryOne<{
        attempt_kind: string;
        kind_attempt_no: number;
        adapter_resource_id: string;
        adapter_resource_hash: string;
        policy_hash: string;
        lease_owner: string;
        lease_token: string;
        request_value_id: string;
        request_hash: string;
        result_kind: string;
        result_code: string | null;
        receipt_value_id: string | null;
        receipt_hash: string | null;
        external_id: string | null;
        started_at_ms: number;
        finished_at_ms: number;
        next_attempt_at_ms: number | null;
      }>(
        'SELECT attempt_kind, kind_attempt_no, adapter_resource_id, adapter_resource_hash, policy_hash, lease_owner, lease_token, request_value_id, request_hash, result_kind, result_code, receipt_value_id, receipt_hash, external_id, started_at_ms, finished_at_ms, next_attempt_at_ms FROM workflow_outbox_attempts WHERE id = ?',
        [
          stableRuntimeId('outbox-attempt', {
            outbox_id: lease.outboxId,
            history_seq: lease.historySequence,
          }),
        ],
      );
      if (priorAttempt) {
        let exact =
          priorAttempt.attempt_kind === lease.attemptKind &&
          priorAttempt.kind_attempt_no === lease.kindAttemptNo &&
          priorAttempt.adapter_resource_id === lease.adapterResourceId &&
          priorAttempt.adapter_resource_hash === lease.adapterResourceHash &&
          priorAttempt.policy_hash === lease.policyHash &&
          priorAttempt.lease_owner === lease.leaseOwner &&
          priorAttempt.lease_token === lease.leaseToken &&
          priorAttempt.request_value_id === lease.request.id &&
          priorAttempt.request_hash === lease.request.hash &&
          priorAttempt.result_kind === input.resultKind &&
          priorAttempt.result_code === input.resultCode &&
          priorAttempt.receipt_value_id === (input.receipt?.id ?? null) &&
          priorAttempt.receipt_hash === (input.receipt?.hash ?? null) &&
          priorAttempt.external_id === input.externalId &&
          priorAttempt.started_at_ms === input.startedAtMs &&
          priorAttempt.finished_at_ms === input.finishedAtMs &&
          priorAttempt.next_attempt_at_ms === input.nextAttemptAtMs;
        if (
          exact &&
          priorAttempt.result_kind === 'applied_with_receipt' &&
          row?.effect_operation_id
        ) {
          const effect = transaction.queryOne<{
            after_state_value_id: string | null;
            after_state_hash: string | null;
            immutable_output_snapshot_value_id: string | null;
            immutable_output_snapshot_hash: string | null;
          }>(
            `SELECT after_state_value_id, after_state_hash,
                    immutable_output_snapshot_value_id,
                    immutable_output_snapshot_hash
               FROM workflow_graph_effect_operations WHERE id = ?`,
            [row.effect_operation_id],
          );
          exact =
            !!effect &&
            effect.after_state_value_id === (input.afterState?.id ?? null) &&
            effect.after_state_hash === (input.afterState?.hash ?? null) &&
            effect.immutable_output_snapshot_value_id ===
              (input.immutableOutput?.id ?? null) &&
            effect.immutable_output_snapshot_hash ===
              (input.immutableOutput?.hash ?? null);
        }
        if (!exact)
          throw new G5RuntimeError(
            'integrity_violation',
            'Outbox result replay bytes drifted',
          );
        if (
          row &&
          row.status !== 'processing' &&
          ['succeeded', 'pending', 'reconciling', 'action_required'].includes(
            row.status,
          )
        )
          return row.status as
            | 'succeeded'
            | 'pending'
            | 'reconciling'
            | 'action_required';
      }
      throw new G5RuntimeError(
        'cas_conflict',
        'Outbox result lease or immutable binding is stale',
      );
    }
    if (
      input.resultKind === 'applied_with_receipt' &&
      (!input.receipt || !input.afterState || !input.immutableOutput)
    )
      throw new G5RuntimeError(
        'contract_invalid',
        'Applied Outbox result requires receipt, after-state, and immutable output',
      );
    const inserted = transaction.execute(
      `INSERT INTO workflow_outbox_attempts (
       id, outbox_id, history_seq, attempt_kind, kind_attempt_no,
       adapter_resource_id, adapter_resource_hash, policy_hash, lease_owner,
       lease_token, request_value_id, request_hash, result_kind, result_code,
       receipt_value_id, receipt_hash, external_id, started_at_ms,
       finished_at_ms, next_attempt_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableRuntimeId('outbox-attempt', {
          outbox_id: lease.outboxId,
          history_seq: lease.historySequence,
        }),
        lease.outboxId,
        lease.historySequence,
        lease.attemptKind,
        lease.kindAttemptNo,
        lease.adapterResourceId,
        lease.adapterResourceHash,
        lease.policyHash,
        lease.leaseOwner,
        lease.leaseToken,
        lease.request.id,
        lease.request.hash,
        input.resultKind,
        input.resultCode,
        input.receipt?.id ?? null,
        input.receipt?.hash ?? null,
        input.externalId,
        input.startedAtMs,
        input.finishedAtMs,
        input.nextAttemptAtMs,
      ],
    ).changes;
    if (inserted !== 1)
      throw new G5RuntimeError('cas_conflict', 'Outbox attempt insert failed');
    const changed = transaction.execute(
      `UPDATE workflow_outbox
          SET status = ?,
              delivery_attempt_count = delivery_attempt_count + ?,
              reconcile_attempt_count = reconcile_attempt_count + ?,
              next_attempt_at_ms = ?, lease_owner = NULL, lease_token = NULL,
              lease_expires_at_ms = NULL, last_result_kind = ?,
              last_error_code = ?, delivered_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ? AND lease_token = ?`,
      [
        nextStatus,
        lease.attemptKind === 'deliver' ? 1 : 0,
        lease.attemptKind === 'reconcile' ? 1 : 0,
        terminalSuccess || actionRequired ? null : input.nextAttemptAtMs,
        input.resultKind,
        terminalSuccess ? null : input.resultCode,
        terminalSuccess ? input.finishedAtMs : null,
        input.finishedAtMs,
        lease.outboxId,
        lease.leaseOwner,
        lease.leaseToken,
      ],
    ).changes;
    if (changed !== 1)
      throw new G5RuntimeError('cas_conflict', 'Outbox result CAS failed');
    if (terminalSuccess && row.effect_operation_id) {
      if (
        transaction.execute(
          "UPDATE workflow_graph_effect_operations SET status = 'succeeded', receipt_value_id = ?, receipt_hash = ?, after_state_value_id = ?, after_state_hash = ?, immutable_output_snapshot_value_id = ?, immutable_output_snapshot_hash = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND status IN ('intended', 'dispatched')",
          [
            input.receipt!.id,
            input.receipt!.hash,
            input.afterState!.id,
            input.afterState!.hash,
            input.immutableOutput!.id,
            input.immutableOutput!.hash,
            input.finishedAtMs,
            row.effect_operation_id,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'Outbox success Effect CAS failed',
        );
    } else if (actionRequired && row.effect_operation_id) {
      if (
        transaction.execute(
          "UPDATE workflow_graph_effect_operations SET status = 'action_required', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND status IN ('intended', 'dispatched')",
          [input.finishedAtMs, row.effect_operation_id],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'Outbox action-required Effect CAS failed',
        );
    }
    return nextStatus as
      | 'succeeded'
      | 'pending'
      | 'reconciling'
      | 'action_required';
  });
}
