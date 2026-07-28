import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
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
  loadInlineValue,
  requireSingleChange,
  runImmediateG5Transaction,
  runtimeObjectHash,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import {
  loadPersistedPlanGeneratedSchemaAuthority,
  nodeOutputPortContractHash,
  persistNodeOutputEnvelope,
  persistPlanGeneratedSchemaAuthorities,
  verifyPersistedPlanGeneratedSchemaAuthorities,
} from './generated-schema-runtime.js';
import {
  releaseLedgerReservationGroup,
  reserveLedgerResources,
} from './ledger.js';
import { verifyCompletionPolicyAuthority } from './fixed-point-authority.js';
import {
  loadMaterializedNodeAuthority,
  verifyCompiledPlanAuthority,
} from './plan-authority.js';
import {
  requestScopeCloseT7aInTransaction,
  type T7aCloseInput,
} from './graph-runtime.js';

type DynamicMode = 'subgraph' | 'expand' | 'map';
type ChildScopeKind = 'subgraph' | 'expansion' | 'map_item';

export interface ExpansionChildIntent {
  readonly childKey: string;
  readonly itemIndex?: number;
  readonly itemKey?: JsonValue;
  readonly itemKeyHash?: Sha256Hash;
  readonly sourceSeedHash: Sha256Hash;
  readonly sourceSnapshot: RuntimeValueRef;
  readonly inputSnapshot: RuntimeValueRef;
  readonly compilerSnapshotHash: Sha256Hash;
  readonly compiledPlan?: {
    readonly id: string;
    readonly hash: Sha256Hash;
  };
}

export interface SealExpansionInput {
  readonly graphRunId: string;
  readonly ownerScopeId: string;
  readonly ownerNodeId: string;
  readonly expectedRunRowVersion: number;
  readonly expectedOwnerScopeRowVersion: number;
  readonly expectedOwnerNodeRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedOwnerScopeWorkFenceEpoch: number;
  readonly mode: DynamicMode;
  readonly sourceArtifact: RuntimeValueRef;
  readonly manifest: JsonObject;
  readonly manifestSchema: RuntimeRegistryRef;
  readonly mapItemResultsManifestSchema?: RuntimeRegistryRef;
  readonly childCompletionPolicy: JsonObject;
  readonly children: readonly ExpansionChildIntent[];
  readonly nowMs: number;
}

export interface SealExpansionReceipt {
  readonly disposition: 'sealed' | 'exact_replay';
  readonly expansionManifestId: string;
  readonly expansionManifestHash: Sha256Hash;
  readonly buildIds: readonly string[];
  readonly mapSlotIds: readonly string[];
}

function assertExpansionChildren(
  mode: DynamicMode,
  children: readonly ExpansionChildIntent[],
): void {
  if (mode !== 'map') {
    if (children.length !== 1 || children[0]!.childKey !== 'single')
      throw new G5RuntimeError(
        'contract_invalid',
        `${mode} must freeze exactly one child_key=single`,
      );
    if (
      children[0]!.itemIndex !== undefined ||
      children[0]!.itemKey !== undefined ||
      children[0]!.itemKeyHash !== undefined
    )
      throw new G5RuntimeError(
        'contract_invalid',
        `${mode} child cannot carry Map item identity`,
      );
    return;
  }
  const indices = new Set<number>();
  const keys = new Set<string>();
  for (const child of children) {
    if (
      child.itemIndex === undefined ||
      !Number.isSafeInteger(child.itemIndex) ||
      child.itemIndex < 0 ||
      child.itemKey === undefined ||
      child.itemKeyHash === undefined ||
      (!['string', 'number', 'boolean'].includes(typeof child.itemKey) &&
        child.itemKey !== null)
    )
      throw new G5RuntimeError(
        'contract_invalid',
        'Map child requires a non-negative index and JSON scalar key',
      );
    const observedKeyHash = runtimeObjectHash('map-item-key', child.itemKey);
    if (observedKeyHash !== child.itemKeyHash)
      throw new G5RuntimeError(
        'contract_invalid',
        'Map item key hash is not canonical',
      );
    if (indices.has(child.itemIndex) || keys.has(child.itemKeyHash))
      throw new G5RuntimeError(
        'contract_invalid',
        'Map item indices and keys must be unique',
      );
    indices.add(child.itemIndex);
    keys.add(child.itemKeyHash);
  }
  const ordered = [...indices].sort((left, right) => left - right);
  if (ordered.some((index, position) => index !== position))
    throw new G5RuntimeError(
      'contract_invalid',
      'Map item indices must cover the frozen collection contiguously',
    );
}

function appendRunManifest(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly expansionManifestId?: string;
    readonly scopeId?: string;
    readonly parentScopeId?: string;
    readonly ownerNodeId?: string;
    readonly childKey?: string;
    readonly scopeKind?: ChildScopeKind;
    readonly sourceHash?: Sha256Hash;
    readonly planHash?: Sha256Hash;
    readonly interfaceHash?: Sha256Hash;
    readonly inputHash?: Sha256Hash;
    readonly policyHash?: Sha256Hash;
    readonly expansionHash?: Sha256Hash;
    readonly itemCount?: number;
    readonly nowMs: number;
  },
): { sequence: number; hash: Sha256Hash } {
  const run = transaction.queryOne<{
    manifest_seq: number;
    manifest_head_hash: Sha256Hash;
  }>(
    'SELECT manifest_seq, manifest_head_hash FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  );
  if (!run)
    throw new G5RuntimeError(
      'precondition_failed',
      'Run Manifest owner is missing',
    );
  const sequence = run.manifest_seq + 1;
  const expansion = input.expansionManifestId !== undefined;
  const payload: JsonObject = expansion
    ? {
        graph_run_id: input.graphRunId,
        manifest_seq: sequence,
        entry_kind: 'expansion_sealed',
        expansion_manifest_id: input.expansionManifestId!,
        parent_scope_id: input.parentScopeId!,
        owner_node_id: input.ownerNodeId!,
        child_key: null,
        scope_kind: null,
        expansion_hash: input.expansionHash!,
        item_count: input.itemCount!,
        previous_manifest_hash: run.manifest_head_hash,
        created_at_ms: input.nowMs,
      }
    : {
        graph_run_id: input.graphRunId,
        manifest_seq: sequence,
        entry_kind: 'scope_materialized',
        scope_id: input.scopeId!,
        parent_scope_id: input.parentScopeId!,
        owner_node_id: input.ownerNodeId!,
        child_key: input.childKey!,
        scope_kind: input.scopeKind!,
        source_hash: input.sourceHash!,
        plan_hash: input.planHash!,
        interface_hash: input.interfaceHash!,
        input_hash: input.inputHash!,
        policy_hash: input.policyHash!,
        previous_manifest_hash: run.manifest_head_hash,
        created_at_ms: input.nowMs,
      };
  const manifestHash = runtimeObjectHash('run-manifest-entry', payload);
  transaction.execute(
    `INSERT INTO workflow_graph_run_manifest (
       graph_run_id, manifest_seq, entry_kind, scope_id, expansion_manifest_id,
       parent_scope_id, owner_node_id, child_key, scope_kind, source_hash,
       plan_hash, interface_hash, input_hash, policy_hash, expansion_hash,
       item_count, previous_manifest_hash, manifest_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.graphRunId,
      sequence,
      expansion ? 'expansion_sealed' : 'scope_materialized',
      input.scopeId ?? null,
      input.expansionManifestId ?? null,
      input.parentScopeId ?? null,
      input.ownerNodeId ?? null,
      input.childKey ?? null,
      input.scopeKind ?? null,
      input.sourceHash ?? null,
      input.planHash ?? null,
      input.interfaceHash ?? null,
      input.inputHash ?? null,
      input.policyHash ?? null,
      input.expansionHash ?? null,
      input.itemCount ?? null,
      run.manifest_head_hash,
      manifestHash,
      input.nowMs,
    ],
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_runs
          SET manifest_seq = ?, manifest_head_hash = ?,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND manifest_seq = ? AND manifest_head_hash = ?`,
      [
        sequence,
        manifestHash,
        input.nowMs,
        input.graphRunId,
        run.manifest_seq,
        run.manifest_head_hash,
      ],
    ).changes,
    'Run Manifest head CAS',
  );
  return { sequence, hash: manifestHash };
}

export function sealExpansionManifestT4(
  store: WorkflowRuntimeStore,
  input: SealExpansionInput,
  fault?: G5TransactionFault,
): SealExpansionReceipt {
  assertExpansionChildren(input.mode, input.children);
  if (input.mode === 'map' && !input.mapItemResultsManifestSchema)
    throw new G5RuntimeError(
      'contract_invalid',
      'Map T4 requires the exact item-results manifest schema',
    );
  const childPolicyHash = runtimeObjectHash(
    'child-completion-policy',
    input.childCompletionPolicy,
  );
  const expansionManifestHash = runtimeObjectHash('expansion-manifest', {
    graph_run_id: input.graphRunId,
    owner_scope_id: input.ownerScopeId,
    owner_node_id: input.ownerNodeId,
    mode: input.mode,
    source_artifact_hash: input.sourceArtifact.hash,
    manifest: input.manifest,
    item_count: input.children.length,
    child_completion_policy_hash: childPolicyHash,
  });
  const expansionManifestId = stableRuntimeId('expansion', {
    graph_run_id: input.graphRunId,
    owner_node_id: input.ownerNodeId,
    manifest_hash: expansionManifestHash,
  });
  const buildIds = input.children.map((child) =>
    stableRuntimeId('build', {
      graph_run_id: input.graphRunId,
      owner_node_id: input.ownerNodeId,
      invocation_key: child.childKey,
    }),
  );
  const mapSlotIds =
    input.mode === 'map'
      ? input.children.map((child) =>
          stableRuntimeId('map-slot', {
            graph_run_id: input.graphRunId,
            owner_node_id: input.ownerNodeId,
            item_index: child.itemIndex!,
            item_key_hash: child.itemKeyHash!,
          }),
        )
      : [];
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      assertExactPublishedRegistryResource(
        transaction,
        input.manifestSchema,
        'T4 Expansion Manifest schema',
      );
      if (input.mapItemResultsManifestSchema)
        assertExactPublishedRegistryResource(
          transaction,
          input.mapItemResultsManifestSchema,
          'T4 Map item-results manifest schema',
        );
      const prior = transaction.queryOne<{
        id: string;
        manifest_hash: string;
        child_completion_policy_hash: string;
        item_count: number;
      }>(
        `SELECT id, manifest_hash, child_completion_policy_hash, item_count
           FROM workflow_graph_expansion_manifests
          WHERE graph_run_id = ? AND owner_node_id = ?`,
        [input.graphRunId, input.ownerNodeId],
      );
      if (prior) {
        if (
          prior.id !== expansionManifestId ||
          prior.manifest_hash !== expansionManifestHash ||
          prior.child_completion_policy_hash !== childPolicyHash ||
          prior.item_count !== input.children.length
        )
          throw new G5RuntimeError(
            'idempotency_conflict',
            'Expansion owner already binds different frozen intent',
          );
        return {
          disposition: 'exact_replay',
          expansionManifestId,
          expansionManifestHash,
          buildIds,
          mapSlotIds: input.mode === 'map' ? mapSlotIds : [],
        };
      }
      const run = transaction.queryOne<{
        lifecycle: string;
        control: string;
        operational_state: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        `SELECT lifecycle, control, operational_state, work_fence_epoch,
                row_version FROM workflow_graph_runs WHERE id = ?`,
        [input.graphRunId],
      );
      const scope = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        `SELECT lifecycle, work_fence_epoch, row_version
           FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?`,
        [input.ownerScopeId, input.graphRunId],
      );
      const owner = transaction.queryOne<{
        node_type: string;
        phase: string;
        controller_state: string | null;
        row_version: number;
      }>(
        `SELECT node_type, phase, controller_state, row_version
           FROM workflow_graph_nodes
          WHERE id = ? AND graph_run_id = ? AND scope_id = ?`,
        [input.ownerNodeId, input.graphRunId, input.ownerScopeId],
      );
      if (
        !run ||
        !scope ||
        !owner ||
        run.lifecycle !== 'executing' ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        run.row_version !== input.expectedRunRowVersion ||
        scope.lifecycle !== 'active' ||
        scope.work_fence_epoch !== input.expectedOwnerScopeWorkFenceEpoch ||
        scope.row_version !== input.expectedOwnerScopeRowVersion ||
        owner.node_type !== input.mode ||
        owner.phase !== 'active' ||
        owner.controller_state !== 'sealing' ||
        owner.row_version !== input.expectedOwnerNodeRowVersion
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T4 dynamic owner, control, or work epoch is stale',
        );
      const ownerAuthority = loadMaterializedNodeAuthority(
        transaction,
        input.graphRunId,
        input.ownerScopeId,
        input.ownerNodeId,
      );
      const pinnedChildCompletion = objectField(
        ownerAuthority.node,
        input.mode === 'map' ? 'completion' : 'child_policy',
      );
      if (
        !pinnedChildCompletion ||
        canonicalJson(pinnedChildCompletion) !==
          canonicalJson(input.childCompletionPolicy)
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'T4 child completion policy differs from the compiled owner Plan',
        );
      const staticBinding =
        input.mode === 'subgraph'
          ? objectField(ownerAuthority.node, 'factory_binding')
          : input.mode === 'map'
            ? objectField(ownerAuthority.node, 'body_binding')
            : null;
      if (input.mode !== 'expand' && !staticBinding)
        throw new G5RuntimeError(
          'integrity_violation',
          `T4 ${input.mode} owner lacks its compiled static child binding`,
        );
      const source = transaction.queryOne<{ content_hash: string }>(
        `SELECT content_hash FROM workflow_values
          WHERE id = ? AND content_hash = ? AND payload_state = 'live'`,
        [input.sourceArtifact.id, input.sourceArtifact.hash],
      );
      if (!source)
        throw new G5RuntimeError(
          'precondition_failed',
          'T4 source artifact is not immutable/live',
        );
      for (const child of input.children) {
        for (const value of [child.sourceSnapshot, child.inputSnapshot]) {
          if (
            !transaction.queryOne<{ id: string }>(
              "SELECT id FROM workflow_values WHERE id = ? AND content_hash = ? AND payload_state = 'live'",
              [value.id, value.hash],
            )
          )
            throw new G5RuntimeError(
              'precondition_failed',
              'T4 child snapshot is not immutable/live',
            );
        }
        if (child.compiledPlan) {
          const plan = transaction.queryOne<{ plan_hash: string }>(
            `SELECT plan_hash FROM workflow_graph_scope_plans
              WHERE id = ? AND graph_run_id = ?`,
            [child.compiledPlan.id, input.graphRunId],
          );
          if (!plan || plan.plan_hash !== child.compiledPlan.hash)
            throw new G5RuntimeError(
              'integrity_violation',
              'T4 child Plan identity is not persisted in this Run',
            );
        }
        if (
          staticBinding &&
          (child.sourceSeedHash !== staticBinding.source_hash ||
            child.sourceSnapshot.hash !== staticBinding.source_hash ||
            !child.compiledPlan ||
            child.compiledPlan.hash !== staticBinding.precompiled_plan_hash)
        )
          throw new G5RuntimeError(
            'integrity_violation',
            `T4 ${input.mode} child differs from its compiled static source/Plan binding`,
          );
      }

      const manifestValueId = stableRuntimeId('value', {
        graph_run_id: input.graphRunId,
        kind: 'expansion-manifest',
        content_hash: expansionManifestHash,
      });
      insertInlineValue(transaction, {
        id: manifestValueId,
        content: input.manifest,
        contentHash: expansionManifestHash,
        schemaResourceId: input.manifestSchema.rowId,
        schemaResourceHash: input.manifestSchema.hash,
        provenanceRef: `t4:${input.ownerNodeId}:expansion-manifest`,
        retentionClass: 'run_recovery',
        ownerGraphRunId: input.graphRunId,
        createdAtMs: input.nowMs,
      });
      transaction.execute(
        `INSERT INTO workflow_graph_expansion_manifests (
           id, graph_run_id, scope_id, owner_node_id, producer_attempt_id,
           mode, source_artifact_value_id, source_artifact_hash,
           manifest_json, manifest_value_id, manifest_hash, item_count,
           child_completion_policy_json, child_completion_policy_hash,
           sealed_at_ms, row_version
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1)`,
        [
          expansionManifestId,
          input.graphRunId,
          input.ownerScopeId,
          input.ownerNodeId,
          input.mode,
          input.sourceArtifact.id,
          input.sourceArtifact.hash,
          manifestValueId,
          expansionManifestHash,
          input.children.length,
          canonicalJson(input.childCompletionPolicy),
          childPolicyHash,
          input.nowMs,
        ],
      );

      const controllerReservationGroupId = stableRuntimeId(
        'reservation-group',
        {
          graph_run_id: input.graphRunId,
          node_id: input.ownerNodeId,
          purpose: 'dynamic_controller',
        },
      );
      if (input.children.length > 0) {
        reserveLedgerResources(transaction, {
          graphRunId: input.graphRunId,
          reservationGroupId: controllerReservationGroupId,
          consumer: { nodeId: input.ownerNodeId },
          amounts: {
            builds_total: input.children.length,
            build_attempts_total: input.children.length,
            ...(input.mode === 'map'
              ? { map_items_total: input.children.length }
              : {}),
          },
          purpose: 'dynamic_controller',
          settlementMode: 'consume_on_create',
          nowMs: input.nowMs,
        });
      }
      input.children.forEach((child, index) => {
        const buildId = buildIds[index]!;
        const scopeKind: ChildScopeKind =
          input.mode === 'subgraph'
            ? 'subgraph'
            : input.mode === 'expand'
              ? 'expansion'
              : 'map_item';
        transaction.execute(
          `INSERT INTO workflow_graph_scope_builds (
             id, graph_run_id, owner_scope_id, owner_node_id, target_scope_id,
             invocation_key, scope_kind, item_key_json, item_index,
             source_seed_json, source_seed_value_id, source_seed_hash,
             source_snapshot_json, source_snapshot_value_id,
             source_snapshot_hash, input_snapshot_json, input_snapshot_value_id,
             input_snapshot_hash, compiler_snapshot_hash, run_work_fence_epoch,
             owner_scope_work_fence_epoch, status, compiled_plan_id,
             compiled_plan_hash, scope_id, materialization_reservation_group_id,
             attempt_count, next_attempt_at_ms, deadline_at_ms, lease_owner,
             lease_token, lease_expires_at_ms, error_code,
             error_detail_value_id, error_detail_hash, row_version,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?,
             NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, 1, ?, ?)`,
          [
            buildId,
            input.graphRunId,
            input.ownerScopeId,
            input.ownerNodeId,
            child.childKey,
            scopeKind,
            child.itemKey === undefined ? null : canonicalJson(child.itemKey),
            child.itemIndex ?? null,
            child.sourceSeedHash,
            child.sourceSnapshot.id,
            child.sourceSnapshot.hash,
            child.inputSnapshot.id,
            child.inputSnapshot.hash,
            child.compilerSnapshotHash,
            input.expectedRunWorkFenceEpoch,
            input.expectedOwnerScopeWorkFenceEpoch,
            child.compiledPlan ? 'compiled' : 'ready_to_compile',
            child.compiledPlan?.id ?? null,
            child.compiledPlan?.hash ?? null,
            input.nowMs,
            input.nowMs,
            input.nowMs,
          ],
        );
        if (input.mode === 'map') {
          transaction.execute(
            `INSERT INTO workflow_graph_map_item_results (
               id, graph_run_id, owner_scope_id, owner_node_id,
               expansion_manifest_id, item_index, item_key_json, item_key_hash,
               build_id, scope_id, outcome_state, exit_name, error_code, reason,
               output_value_id, output_hash, completion_seq, fence_event_seq,
               row_version, created_at_ms, resolved_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', NULL, NULL,
               NULL, NULL, NULL, NULL, NULL, 1, ?, NULL)`,
            [
              mapSlotIds[index],
              input.graphRunId,
              input.ownerScopeId,
              input.ownerNodeId,
              expansionManifestId,
              child.itemIndex!,
              canonicalJson(child.itemKey!),
              child.itemKeyHash!,
              buildId,
              input.nowMs,
            ],
          );
        }
      });
      const manifestEntry = appendRunManifest(transaction, {
        graphRunId: input.graphRunId,
        expansionManifestId,
        parentScopeId: input.ownerScopeId,
        ownerNodeId: input.ownerNodeId,
        expansionHash: expansionManifestHash,
        itemCount: input.children.length,
        nowMs: input.nowMs,
      });
      const refreshedRun = transaction.queryOne<{
        row_version: number;
        next_event_seq: number;
      }>(
        'SELECT row_version, next_event_seq FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      const eventSequence = refreshedRun.next_event_seq + 1;
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_runs
              SET next_event_seq = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ?`,
          [
            eventSequence,
            input.nowMs,
            input.graphRunId,
            refreshedRun.row_version,
          ],
        ).changes,
        'T4 expansion event CAS',
      );
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence: eventSequence,
        scopeId: input.ownerScopeId,
        nodeId: input.ownerNodeId,
        attemptId: null,
        eventType: 'expansion_sealed',
        idempotencyKey: `expansion-sealed:${expansionManifestId}`,
        payloadJson: {
          expansion_manifest_id: expansionManifestId,
          expansion_manifest_hash: expansionManifestHash,
          run_manifest_hash: manifestEntry.hash,
        },
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      if (input.mode === 'map' && input.children.length === 0) {
        const decision = mapPolicyDecision(input.childCompletionPolicy, []);
        if (!decision.terminal)
          throw new G5RuntimeError(
            'integrity_violation',
            'Empty Map completion policy did not reach a terminal decision',
          );
        const items: JsonObject[] = [];
        const itemContent: JsonObject = {
          items,
          manifest_hash: runtimeObjectHash('map-item-results', items),
        };
        const itemContentHash = runtimeObjectHash(
          'map-item-results-manifest',
          itemContent,
        );
        const itemValueId = stableRuntimeId('value', {
          graph_run_id: input.graphRunId,
          owner_node_id: input.ownerNodeId,
          content_hash: itemContentHash,
        });
        insertInlineValue(transaction, {
          id: itemValueId,
          content: itemContent,
          contentHash: itemContentHash,
          schemaResourceId: input.mapItemResultsManifestSchema!.rowId,
          schemaResourceHash: input.mapItemResultsManifestSchema!.hash,
          provenanceRef: `t4:${input.ownerNodeId}:empty-map-item-results`,
          retentionClass: 'run_recovery',
          ownerGraphRunId: input.graphRunId,
          createdAtMs: input.nowMs,
        });
        const published = decision.succeeded
          ? persistGeneratedOwnerOutput(transaction, {
              graphRunId: input.graphRunId,
              ownerScopeId: input.ownerScopeId,
              ownerNodeId: input.ownerNodeId,
              expectedGenerator: 'map_result',
              content: {
                expansion_manifest_ref: expansionManifestId,
                expansion_manifest_hash: expansionManifestHash,
                completion_policy_hash: childPolicyHash,
                selected_indices: [],
                item_results_manifest_ref: itemValueId,
                item_results_manifest_hash: itemContentHash,
                item_count: 0,
              },
              nowMs: input.nowMs,
            })
          : null;
        const frozenDecision: JsonObject = {
          succeeded: decision.succeeded,
          reason: decision.reason,
          selected_indices: [],
          decided_at_event_seq: eventSequence,
        };
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_nodes
                SET phase = 'terminal', terminal_status = ?, terminal_code = ?,
                    published_output_envelope_value_id = ?,
                    published_output_envelope_hash = ?, controller_state = 'settled',
                    controller_decision_json = ?, controller_decision_hash = ?,
                    controller_remaining_count = 0,
                    controller_reservation_group_id = NULL,
                    row_version = row_version + 1, terminal_at_ms = ?,
                    updated_at_ms = ?
              WHERE id = ? AND graph_run_id = ? AND scope_id = ?
                AND row_version = ? AND phase = 'active'
                AND controller_state = 'sealing'`,
            [
              decision.succeeded ? 'succeeded' : 'failed',
              decision.succeeded ? null : decision.reason,
              published?.id ?? null,
              published?.hash ?? null,
              canonicalJson(frozenDecision),
              runtimeObjectHash('map-controller-decision', frozenDecision),
              input.nowMs,
              input.nowMs,
              input.ownerNodeId,
              input.graphRunId,
              input.ownerScopeId,
              input.expectedOwnerNodeRowVersion,
            ],
          ).changes,
          'T4 empty Map owner CAS',
        );
      } else {
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_nodes
                SET controller_state = 'running', controller_remaining_count = ?,
                    controller_reservation_group_id = ?,
                    row_version = row_version + 1, updated_at_ms = ?
              WHERE id = ? AND graph_run_id = ? AND scope_id = ?
                AND row_version = ? AND phase = 'active'
                AND controller_state = 'sealing'`,
            [
              input.children.length,
              controllerReservationGroupId,
              input.nowMs,
              input.ownerNodeId,
              input.graphRunId,
              input.ownerScopeId,
              input.expectedOwnerNodeRowVersion,
            ],
          ).changes,
          'T4 dynamic owner CAS',
        );
      }
      assertNoDeferredForeignKeyViolations(transaction, 'T4 expansion seal');
      return {
        disposition: 'sealed',
        expansionManifestId,
        expansionManifestHash,
        buildIds,
        mapSlotIds: input.mode === 'map' ? mapSlotIds : [],
      };
    },
    fault,
  );
}

function resolveRegistrySchema(
  transaction: WorkflowRuntimeWriteTransaction,
  compiledSchema: JsonObject,
  label: string,
): JsonObject {
  if (compiledSchema.type !== 'registry')
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} is not a Registry schema`,
    );
  const ref = compiledSchema.ref as JsonObject;
  const rowId = registryResourceId({
    resource_type: 'schema',
    ref: { id: String(ref.id), version: String(ref.version) },
  });
  const row = transaction.queryOne<{
    content_hash: string;
    inline_canonical_json: string | null;
    publication_state: string;
    payload_state: string;
  }>(
    `SELECT rr.content_hash, rr.publication_state,
            v.inline_canonical_json, v.payload_state
       FROM workflow_registry_resources rr
       JOIN workflow_values v ON v.id = rr.canonical_value_id
      WHERE rr.id = ? AND rr.resource_type = 'schema'`,
    [rowId],
  );
  if (
    !row ||
    row.publication_state !== 'published' ||
    row.payload_state !== 'live' ||
    row.inline_canonical_json === null ||
    row.content_hash !== compiledSchema.schema_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} exact Published Registry schema is unavailable`,
    );
  return JSON.parse(row.inline_canonical_json) as JsonObject;
}

export interface DynamicBuildFailureInput {
  readonly graphRunId: string;
  readonly buildId: string;
  readonly expectedBuildRowVersion: number;
  readonly expectedRunRowVersion: number;
  readonly expectedOwnerScopeRowVersion: number;
  readonly expectedOwnerNodeRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedOwnerScopeWorkFenceEpoch: number;
  readonly errorCode: string;
  readonly errorDetail: RuntimeValueRef;
  readonly fenceManifestSchema: RuntimeRegistryRef;
  readonly mapItemResultsManifestSchema: RuntimeRegistryRef;
  readonly nowMs: number;
}

export interface DynamicBuildFailureReceipt {
  readonly disposition: 'failed' | 'exact_replay';
  readonly ownerTerminal: boolean;
  readonly mapSlotId: string | null;
  readonly closedLoserScopeIds: readonly string[];
}

export function recordDynamicBuildFailureT2a(
  store: WorkflowRuntimeStore,
  input: DynamicBuildFailureInput,
  fault?: G5TransactionFault,
): DynamicBuildFailureReceipt {
  if (input.errorCode.length === 0)
    throw new G5RuntimeError(
      'contract_invalid',
      'Dynamic build failure requires an error code',
    );
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      assertExactPublishedRegistryResource(
        transaction,
        input.fenceManifestSchema,
        'Dynamic build failure fence manifest schema',
      );
      assertExactPublishedRegistryResource(
        transaction,
        input.mapItemResultsManifestSchema,
        'Dynamic build failure Map item-results schema',
      );
      loadInlineValue(
        transaction,
        input.errorDetail.id,
        input.errorDetail.hash,
        'Dynamic build failure detail',
      );
      const build = transaction.queryOne<{
        graph_run_id: string;
        owner_scope_id: string;
        owner_node_id: string;
        scope_kind: ChildScopeKind;
        status: string;
        run_work_fence_epoch: number;
        owner_scope_work_fence_epoch: number;
        error_code: string | null;
        error_detail_value_id: string | null;
        error_detail_hash: Sha256Hash | null;
        row_version: number;
      }>(
        `SELECT graph_run_id, owner_scope_id, owner_node_id, scope_kind, status,
                run_work_fence_epoch, owner_scope_work_fence_epoch, error_code,
                error_detail_value_id, error_detail_hash, row_version
           FROM workflow_graph_scope_builds
          WHERE id = ? AND graph_run_id = ?`,
        [input.buildId, input.graphRunId],
      );
      if (!build)
        throw new G5RuntimeError(
          'precondition_failed',
          'Dynamic build failure target is missing',
        );
      const mapSlot = transaction.queryOne<{
        id: string;
        outcome_state: string;
      }>(
        `SELECT id, outcome_state FROM workflow_graph_map_item_results
          WHERE graph_run_id = ? AND build_id = ?`,
        [input.graphRunId, input.buildId],
      );
      if (build.status === 'failed') {
        if (
          build.error_code !== input.errorCode ||
          build.error_detail_value_id !== input.errorDetail.id ||
          build.error_detail_hash !== input.errorDetail.hash ||
          (build.scope_kind === 'map_item' &&
            (!mapSlot || mapSlot.outcome_state !== 'errored'))
        )
          throw new G5RuntimeError(
            'idempotency_conflict',
            'Dynamic build failure replay drifted',
          );
        const owner = transaction.queryOne<{ phase: string }>(
          'SELECT phase FROM workflow_graph_nodes WHERE id = ?',
          [build.owner_node_id],
        );
        return {
          disposition: 'exact_replay',
          ownerTerminal: owner?.phase === 'terminal',
          mapSlotId: mapSlot?.id ?? null,
          closedLoserScopeIds: [],
        };
      }
      const run = transaction.queryOne<{
        lifecycle: string;
        control: string;
        operational_state: string;
        work_fence_epoch: number;
        next_event_seq: number;
        row_version: number;
      }>(
        `SELECT lifecycle, control, operational_state, work_fence_epoch,
                next_event_seq, row_version
           FROM workflow_graph_runs WHERE id = ?`,
        [input.graphRunId],
      );
      const ownerScope = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        `SELECT lifecycle, work_fence_epoch, row_version
           FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?`,
        [build.owner_scope_id, input.graphRunId],
      );
      const owner = transaction.queryOne<{
        node_type: DynamicMode;
        phase: string;
        controller_state: string;
        controller_remaining_count: number;
        controller_reservation_group_id: string | null;
        row_version: number;
      }>(
        `SELECT node_type, phase, controller_state,
                controller_remaining_count, controller_reservation_group_id,
                row_version
           FROM workflow_graph_nodes
          WHERE id = ? AND graph_run_id = ? AND scope_id = ?`,
        [build.owner_node_id, input.graphRunId, build.owner_scope_id],
      );
      if (
        !run ||
        !ownerScope ||
        !owner ||
        run.lifecycle !== 'executing' ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        run.row_version !== input.expectedRunRowVersion ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        ownerScope.lifecycle !== 'active' ||
        ownerScope.row_version !== input.expectedOwnerScopeRowVersion ||
        ownerScope.work_fence_epoch !==
          input.expectedOwnerScopeWorkFenceEpoch ||
        owner.phase !== 'active' ||
        !['running', 'closing_remaining'].includes(owner.controller_state) ||
        owner.row_version !== input.expectedOwnerNodeRowVersion ||
        !['ready_to_compile', 'compiling', 'compiled'].includes(build.status) ||
        build.row_version !== input.expectedBuildRowVersion ||
        build.run_work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        build.owner_scope_work_fence_epoch !==
          input.expectedOwnerScopeWorkFenceEpoch
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'Dynamic build failure owner, build, or work-fence authority is stale',
        );
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_scope_builds
              SET status = 'failed', error_code = ?,
                  error_detail_value_id = ?, error_detail_hash = ?,
                  lease_owner = NULL, lease_token = NULL,
                  lease_expires_at_ms = NULL, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND graph_run_id = ? AND row_version = ?
              AND status IN ('ready_to_compile','compiling','compiled')`,
          [
            input.errorCode,
            input.errorDetail.id,
            input.errorDetail.hash,
            input.nowMs,
            input.buildId,
            input.graphRunId,
            input.expectedBuildRowVersion,
          ],
        ).changes,
        'Dynamic build failure CAS',
      );
      const sequence = run.next_event_seq + 1;
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_runs
              SET next_event_seq = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND next_event_seq = ?`,
          [
            sequence,
            input.nowMs,
            input.graphRunId,
            input.expectedRunRowVersion,
            run.next_event_seq,
          ],
        ).changes,
        'Dynamic build failure event-head CAS',
      );
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId: build.owner_scope_id,
        nodeId: build.owner_node_id,
        attemptId: null,
        eventType: 'build_failed',
        idempotencyKey: `build-failed:${input.buildId}`,
        payloadValueId: input.errorDetail.id,
        payloadHash: input.errorDetail.hash,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      const factKey = `build-failed:${input.buildId}`;
      transaction.execute(
        `INSERT INTO workflow_graph_facts (
           id, graph_run_id, scope_id, event_seq, causal_event_seq, causal_wave,
           fact_kind, stable_object_kind, stable_object_id, fact_key,
           payload_value_id, payload_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, NULL, 0, 'build_failed', 'scope_build', ?, ?, ?, ?, ?)`,
        [
          stableRuntimeId('fact', {
            graph_run_id: input.graphRunId,
            scope_id: build.owner_scope_id,
            fact_key: factKey,
          }),
          input.graphRunId,
          build.owner_scope_id,
          sequence,
          input.buildId,
          factKey,
          input.errorDetail.id,
          input.errorDetail.hash,
          input.nowMs,
        ],
      );

      if (owner.node_type !== 'map') {
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_nodes
                SET phase = 'terminal', terminal_status = 'failed',
                    terminal_code = 'child_scope_build_failed',
                    controller_state = 'settled', controller_remaining_count = 0,
                    controller_reservation_group_id = NULL,
                    row_version = row_version + 1, terminal_at_ms = ?,
                    updated_at_ms = ?
              WHERE id = ? AND row_version = ? AND phase = 'active'
                AND controller_state = 'running'`,
            [
              input.nowMs,
              input.nowMs,
              build.owner_node_id,
              input.expectedOwnerNodeRowVersion,
            ],
          ).changes,
          'Dynamic single-child build failure owner CAS',
        );
        if (owner.controller_reservation_group_id)
          releaseLedgerReservationGroup(
            transaction,
            input.graphRunId,
            owner.controller_reservation_group_id,
            input.nowMs,
          );
        assertNoDeferredForeignKeyViolations(
          transaction,
          'Dynamic single-child build failure',
        );
        return {
          disposition: 'failed',
          ownerTerminal: true,
          mapSlotId: null,
          closedLoserScopeIds: [],
        };
      }
      if (!mapSlot || mapSlot.outcome_state !== 'open')
        throw new G5RuntimeError(
          'integrity_violation',
          'Map build failure has no open exact slot',
        );
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_map_item_results
              SET outcome_state = 'errored', error_code = ?, completion_seq = ?,
                  row_version = row_version + 1, resolved_at_ms = ?
            WHERE id = ? AND outcome_state = 'open' AND scope_id IS NULL`,
          [input.errorCode, sequence, input.nowMs, mapSlot.id],
        ).changes,
        'Map build failure slot CAS',
      );
      const expansion = transaction.queryOne<{
        id: string;
        manifest_hash: Sha256Hash;
        item_count: number;
        child_completion_policy_json: string;
        child_completion_policy_hash: Sha256Hash;
      }>(
        `SELECT id, manifest_hash, item_count, child_completion_policy_json,
                child_completion_policy_hash
           FROM workflow_graph_expansion_manifests
          WHERE graph_run_id = ? AND owner_node_id = ?`,
        [input.graphRunId, build.owner_node_id],
      );
      if (!expansion)
        throw new G5RuntimeError(
          'integrity_violation',
          'Map build failure Expansion Manifest is missing',
        );
      const policy = JSON.parse(
        expansion.child_completion_policy_json,
      ) as JsonObject;
      if (
        runtimeObjectHash('child-completion-policy', policy) !==
        expansion.child_completion_policy_hash
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'Map build failure completion policy hash drifted',
        );
      let slots = transaction.queryAll<{
        id: string;
        item_index: number;
        item_key_json: string;
        item_key_hash: Sha256Hash;
        build_id: string | null;
        scope_id: string | null;
        outcome_state: MapOutcome | 'open';
        exit_name: string | null;
        error_code: string | null;
        reason: string | null;
        output_value_id: string | null;
        output_hash: Sha256Hash | null;
        completion_seq: number | null;
        fence_event_seq: number | null;
        row_version: number;
      }>(
        `SELECT id, item_index, item_key_json, item_key_hash, build_id, scope_id,
                outcome_state, exit_name, error_code, reason, output_value_id,
                output_hash, completion_seq, fence_event_seq, row_version
           FROM workflow_graph_map_item_results
          WHERE graph_run_id = ? AND owner_node_id = ? ORDER BY item_index`,
        [input.graphRunId, build.owner_node_id],
      );
      if (
        slots.length !== expansion.item_count ||
        slots.some((slot, index) => slot.item_index !== index)
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'Map build failure slots do not cover the frozen manifest',
        );
      const evaluated = mapPolicyDecision(policy, slots);
      const closedLoserScopeIds: string[] = [];
      let immediatelySettledLosers = 0;
      let decision: JsonObject | null = null;
      if (evaluated.terminal) {
        decision = {
          succeeded: evaluated.succeeded,
          reason: evaluated.reason,
          selected_indices: [...evaluated.selectedIndices],
          decided_at_event_seq: sequence,
        };
        if (evaluated.fenceReason) {
          for (const loser of slots.filter(
            (slot) => slot.outcome_state === 'open',
          )) {
            requireSingleChange(
              transaction.execute(
                `UPDATE workflow_graph_map_item_results
                    SET outcome_state = 'fenced', reason = ?, fence_event_seq = ?,
                        row_version = row_version + 1, resolved_at_ms = ?
                  WHERE id = ? AND row_version = ? AND outcome_state = 'open'`,
                [
                  evaluated.fenceReason,
                  sequence,
                  input.nowMs,
                  loser.id,
                  loser.row_version,
                ],
              ).changes,
              `Map build failure loser slot ${loser.id}`,
            );
            if (!loser.scope_id) {
              immediatelySettledLosers += 1;
              if (loser.build_id)
                transaction.execute(
                  `UPDATE workflow_graph_scope_builds
                      SET status = 'fenced', lease_owner = NULL,
                          lease_token = NULL, lease_expires_at_ms = NULL,
                          row_version = row_version + 1, updated_at_ms = ?
                    WHERE id = ? AND status IN (
                      'pending_snapshot','ready_to_compile','compiling','compiled'
                    )`,
                  [input.nowMs, loser.build_id],
                );
              continue;
            }
            const loserScope = transaction.queryOne<{
              lifecycle: string;
              row_version: number;
              work_fence_epoch: number;
            }>(
              `SELECT lifecycle, row_version, work_fence_epoch
                 FROM workflow_graph_scopes WHERE id = ?`,
              [loser.scope_id],
            );
            if (loserScope?.lifecycle === 'active') {
              const currentRun = transaction.queryOne<{
                row_version: number;
                work_fence_epoch: number;
              }>(
                `SELECT row_version, work_fence_epoch
                   FROM workflow_graph_runs WHERE id = ?`,
                [input.graphRunId],
              )!;
              requestScopeCloseT7aInTransaction(transaction, {
                graphRunId: input.graphRunId,
                scopeId: loser.scope_id,
                expectedRunRowVersion: currentRun.row_version,
                expectedScopeRowVersion: loserScope.row_version,
                expectedRunWorkFenceEpoch: currentRun.work_fence_epoch,
                expectedScopeWorkFenceEpoch: loserScope.work_fence_epoch,
                cause: { reason: 'parent_close' },
                manifestSchema: input.fenceManifestSchema,
                nowMs: input.nowMs,
              });
              closedLoserScopeIds.push(loser.scope_id);
            }
          }
        }
      }
      slots = transaction.queryAll<(typeof slots)[number]>(
        `SELECT id, item_index, item_key_json, item_key_hash, build_id, scope_id,
                outcome_state, exit_name, error_code, reason, output_value_id,
                output_hash, completion_seq, fence_event_seq, row_version
           FROM workflow_graph_map_item_results
          WHERE graph_run_id = ? AND owner_node_id = ? ORDER BY item_index`,
        [input.graphRunId, build.owner_node_id],
      );
      const remaining = Math.max(
        0,
        owner.controller_remaining_count - 1 - immediatelySettledLosers,
      );
      const canTerminalize =
        evaluated.terminal &&
        remaining === 0 &&
        slots.every((slot) => slot.outcome_state !== 'open');
      let published: { readonly id: string; readonly hash: Sha256Hash } | null =
        null;
      if (canTerminalize && evaluated.succeeded) {
        const items = slots.map((slot) =>
          mapItemEnvelope(
            transaction,
            slot as typeof slot & { outcome_state: MapOutcome },
          ),
        );
        const itemContent: JsonObject = {
          items,
          manifest_hash: runtimeObjectHash('map-item-results', items),
        };
        const itemContentHash = runtimeObjectHash(
          'map-item-results-manifest',
          itemContent,
        );
        const itemValueId = stableRuntimeId('value', {
          graph_run_id: input.graphRunId,
          owner_node_id: build.owner_node_id,
          content_hash: itemContentHash,
        });
        insertInlineValue(transaction, {
          id: itemValueId,
          content: itemContent,
          contentHash: itemContentHash,
          schemaResourceId: input.mapItemResultsManifestSchema.rowId,
          schemaResourceHash: input.mapItemResultsManifestSchema.hash,
          provenanceRef: `t2a:${build.owner_node_id}:map-build-failure-results`,
          retentionClass: 'run_recovery',
          ownerGraphRunId: input.graphRunId,
          createdAtMs: input.nowMs,
        });
        published = persistGeneratedOwnerOutput(transaction, {
          graphRunId: input.graphRunId,
          ownerScopeId: build.owner_scope_id,
          ownerNodeId: build.owner_node_id,
          expectedGenerator: 'map_result',
          content: {
            expansion_manifest_ref: expansion.id,
            expansion_manifest_hash: expansion.manifest_hash,
            completion_policy_hash: expansion.child_completion_policy_hash,
            selected_indices: [...evaluated.selectedIndices],
            item_results_manifest_ref: itemValueId,
            item_results_manifest_hash: itemContentHash,
            item_count: expansion.item_count,
          },
          nowMs: input.nowMs,
        });
      }
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_nodes
              SET phase = ?, terminal_status = ?, terminal_code = ?,
                  published_output_envelope_value_id = ?,
                  published_output_envelope_hash = ?, controller_state = ?,
                  controller_decision_json = ?, controller_decision_hash = ?,
                  controller_remaining_count = ?,
                  controller_reservation_group_id = ?,
                  row_version = row_version + 1, terminal_at_ms = ?,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND phase = 'active'
              AND controller_state IN ('running','closing_remaining')`,
          [
            canTerminalize ? 'terminal' : 'active',
            canTerminalize
              ? evaluated.succeeded
                ? 'succeeded'
                : 'failed'
              : null,
            canTerminalize && !evaluated.succeeded ? evaluated.reason : null,
            published?.id ?? null,
            published?.hash ?? null,
            canTerminalize
              ? 'settled'
              : decision
                ? 'closing_remaining'
                : 'running',
            decision ? canonicalJson(decision) : null,
            decision
              ? runtimeObjectHash('map-controller-decision', decision)
              : null,
            remaining,
            canTerminalize ? null : owner.controller_reservation_group_id,
            canTerminalize ? input.nowMs : null,
            input.nowMs,
            build.owner_node_id,
            input.expectedOwnerNodeRowVersion,
          ],
        ).changes,
        'Map build failure owner CAS',
      );
      if (canTerminalize && owner.controller_reservation_group_id)
        releaseLedgerReservationGroup(
          transaction,
          input.graphRunId,
          owner.controller_reservation_group_id,
          input.nowMs,
        );
      assertNoDeferredForeignKeyViolations(
        transaction,
        'Dynamic Map build failure',
      );
      return {
        disposition: 'failed',
        ownerTerminal: canTerminalize,
        mapSlotId: mapSlot.id,
        closedLoserScopeIds,
      };
    },
    fault,
  );
}

export interface PersistDynamicCompileInput {
  readonly graphRunId: string;
  readonly buildId: string;
  readonly expectedBuildRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedOwnerScopeWorkFenceEpoch: number;
  readonly source: JsonObject;
  readonly plan: CompiledScopePlanV2Document;
  readonly nowMs: number;
}

export function persistDynamicCompileResultT2a(
  store: WorkflowRuntimeStore,
  input: PersistDynamicCompileInput,
  fault?: G5TransactionFault,
): { disposition: 'compiled' | 'exact_replay'; planId: string } {
  verifyCompiledPlanAuthority(input.plan);
  const sourceHash = domainSeparatedSha256(
    'icarus:workflow-graph-source:1\n',
    input.source,
  );
  if (sourceHash !== input.plan.source_hash)
    throw new G5RuntimeError(
      'contract_invalid',
      'Dynamic compile source does not match the Plan source hash',
    );
  const planId = stableRuntimeId('plan', {
    graph_run_id: input.graphRunId,
    plan_hash: input.plan.plan_hash,
  });
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const build = transaction.queryOne<{
        owner_scope_id: string;
        owner_node_id: string;
        status: string;
        compiled_plan_id: string | null;
        compiled_plan_hash: Sha256Hash | null;
        run_work_fence_epoch: number;
        owner_scope_work_fence_epoch: number;
        source_snapshot_hash: Sha256Hash | null;
        row_version: number;
      }>(
        `SELECT owner_scope_id, owner_node_id, status,
                compiled_plan_id, compiled_plan_hash,
                run_work_fence_epoch, owner_scope_work_fence_epoch,
                source_snapshot_hash, row_version
           FROM workflow_graph_scope_builds
          WHERE id = ? AND graph_run_id = ?`,
        [input.buildId, input.graphRunId],
      );
      const run = transaction.queryOne<{
        runtime_safety_snapshot_hash: Sha256Hash;
        compiler_toolchain_resource_hash: Sha256Hash;
        work_fence_epoch: number;
      }>(
        `SELECT runtime_safety_snapshot_hash,
                compiler_toolchain_resource_hash, work_fence_epoch
           FROM workflow_graph_runs WHERE id = ?`,
        [input.graphRunId],
      );
      if (!build || !run)
        throw new G5RuntimeError(
          'precondition_failed',
          'Dynamic compile build or Run is missing',
        );
      const owner = transaction.queryOne<{ normalized_node_json: string }>(
        `SELECT normalized_node_json FROM workflow_graph_nodes
          WHERE id = ? AND graph_run_id = ? AND scope_id = ?`,
        [build.owner_node_id, input.graphRunId, build.owner_scope_id],
      );
      if (!owner)
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic compile owner authority is missing',
        );
      const ownerNode = JSON.parse(owner.normalized_node_json) as JsonObject;
      if (ownerNode.type !== 'expand')
        throw new G5RuntimeError(
          'integrity_violation',
          'Only an Expand owner may persist a dynamic child Plan',
        );
      const compiledInterface = objectField(
        ownerNode,
        'child_interface_snapshot',
      );
      const childPolicy = objectField(ownerNode, 'child_policy');
      const effectivePolicy = childPolicy
        ? objectField(childPolicy, 'effective_policy_snapshot')
        : null;
      const interfaceMatches =
        !!compiledInterface &&
        canonicalJson(input.plan.interface_snapshot as JsonObject) ===
          canonicalJson(compiledInterface);
      const policyMatches =
        !!effectivePolicy &&
        canonicalJson(input.plan.effective_policy_snapshot as JsonObject) ===
          canonicalJson(effectivePolicy);
      if (!interfaceMatches || !policyMatches)
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic compile Plan differs from the Expand child interface/policy authority',
        );
      if (build.status === 'compiled') {
        if (
          build.compiled_plan_id !== planId ||
          build.compiled_plan_hash !== input.plan.plan_hash
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'Dynamic compile replay drifted',
          );
        verifyPersistedPlanGeneratedSchemaAuthorities(transaction, {
          planId,
          graphRunId: input.graphRunId,
          planHash: input.plan.plan_hash as Sha256Hash,
          plan: input.plan,
        });
        return { disposition: 'exact_replay', planId };
      }
      if (
        !['ready_to_compile', 'compiling'].includes(build.status) ||
        build.row_version !== input.expectedBuildRowVersion ||
        build.run_work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        build.owner_scope_work_fence_epoch !==
          input.expectedOwnerScopeWorkFenceEpoch ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        run.runtime_safety_snapshot_hash !== input.plan.runtime_safety_hash ||
        run.compiler_toolchain_resource_hash !==
          input.plan.compiler_toolchain_hash ||
        build.source_snapshot_hash !== sourceHash
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'Dynamic compile lease, source, authority, or work epoch is stale',
        );
      const existing = transaction.queryOne<{
        compiled_plan_json: string | null;
        plan_hash: Sha256Hash;
      }>(
        `SELECT compiled_plan_json, plan_hash
           FROM workflow_graph_scope_plans WHERE id = ?`,
        [planId],
      );
      if (existing) {
        if (
          existing.plan_hash !== input.plan.plan_hash ||
          existing.compiled_plan_json !== canonicalJson(input.plan)
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'Dynamic content-addressed Plan collision',
          );
      } else {
        transaction.execute(
          `INSERT INTO workflow_graph_scope_plans (
             id, graph_run_id, plan_hash, format, compiler_version,
             source_json, source_value_id, source_hash, compiled_plan_json,
             compiled_plan_value_id, interface_snapshot_json,
             interface_snapshot_hash, policy_snapshot_json,
             policy_snapshot_hash, capability_catalog_hash, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          [
            planId,
            input.graphRunId,
            input.plan.plan_hash,
            input.plan.format,
            input.plan.compiler_version,
            canonicalJson(input.source),
            sourceHash,
            canonicalJson(input.plan),
            canonicalJson(input.plan.interface_snapshot),
            input.plan.interface_snapshot_hash,
            canonicalJson(input.plan.effective_policy_snapshot),
            input.plan.policy_snapshot_hash,
            input.plan.capability_catalog_hash,
            input.nowMs,
          ],
        );
      }
      persistPlanGeneratedSchemaAuthorities(
        transaction,
        {
          planId,
          graphRunId: input.graphRunId,
          planHash: input.plan.plan_hash as Sha256Hash,
          plan: input.plan,
        },
        input.nowMs,
        (schema, label) => resolveRegistrySchema(transaction, schema, label),
      );
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_scope_builds
              SET status = 'compiled', compiled_plan_id = ?,
                  compiled_plan_hash = ?, lease_owner = NULL,
                  lease_token = NULL, lease_expires_at_ms = NULL,
                  row_version = row_version + 1, updated_at_ms = ?
            WHERE id = ? AND row_version = ?
              AND status IN ('ready_to_compile', 'compiling')`,
          [
            planId,
            input.plan.plan_hash,
            input.nowMs,
            input.buildId,
            input.expectedBuildRowVersion,
          ],
        ).changes,
        'Dynamic compile build CAS',
      );
      assertNoDeferredForeignKeyViolations(transaction, 'Dynamic T2a');
      return { disposition: 'compiled', planId };
    },
    fault,
  );
}

function objectField(value: JsonObject, key: string): JsonObject | null {
  const candidate = value[key];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as JsonObject)
    : null;
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface MaterializeDynamicScopeInput {
  readonly graphRunId: string;
  readonly buildId: string;
  readonly expectedBuildRowVersion: number;
  readonly expectedRunRowVersion: number;
  readonly expectedOwnerScopeRowVersion: number;
  readonly expectedOwnerNodeRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedOwnerScopeWorkFenceEpoch: number;
  readonly nowMs: number;
}

export interface MaterializeDynamicScopeReceipt {
  readonly disposition: 'materialized' | 'exact_replay';
  readonly scopeId: string;
  readonly manifestHash: Sha256Hash;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export function materializeDynamicScopeT2b(
  store: WorkflowRuntimeStore,
  input: MaterializeDynamicScopeInput,
  fault?: G5TransactionFault,
): MaterializeDynamicScopeReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const build = transaction.queryOne<{
        owner_scope_id: string;
        owner_node_id: string;
        invocation_key: string;
        scope_kind: ChildScopeKind;
        input_snapshot_value_id: string;
        input_snapshot_hash: Sha256Hash;
        compiled_plan_id: string;
        compiled_plan_hash: Sha256Hash;
        run_work_fence_epoch: number;
        owner_scope_work_fence_epoch: number;
        status: string;
        scope_id: string | null;
        row_version: number;
      }>(
        `SELECT owner_scope_id, owner_node_id, invocation_key, scope_kind,
                input_snapshot_value_id, input_snapshot_hash, compiled_plan_id,
                compiled_plan_hash, run_work_fence_epoch,
                owner_scope_work_fence_epoch, status, scope_id, row_version
           FROM workflow_graph_scope_builds
          WHERE id = ? AND graph_run_id = ?`,
        [input.buildId, input.graphRunId],
      );
      if (!build || !build.owner_scope_id || !build.owner_node_id)
        throw new G5RuntimeError(
          'precondition_failed',
          'Dynamic T2b child build is missing its exact owner',
        );
      const scopeId = stableRuntimeId('scope', {
        graph_run_id: input.graphRunId,
        parent_scope_id: build.owner_scope_id,
        owner_node_id: build.owner_node_id,
        child_key: build.invocation_key,
      });
      const persistedPlan = transaction.queryOne<{
        compiled_plan_json: string | null;
        plan_hash: Sha256Hash;
      }>(
        `SELECT compiled_plan_json, plan_hash
           FROM workflow_graph_scope_plans
          WHERE id = ? AND graph_run_id = ?`,
        [build.compiled_plan_id, input.graphRunId],
      );
      if (
        !persistedPlan ||
        persistedPlan.compiled_plan_json === null ||
        persistedPlan.plan_hash !== build.compiled_plan_hash
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic T2b persisted Plan identity is missing or drifted',
        );
      let plan: CompiledScopePlanV2Document;
      try {
        plan = JSON.parse(
          persistedPlan.compiled_plan_json,
        ) as CompiledScopePlanV2Document;
      } catch {
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic T2b persisted Plan bytes are not JSON',
        );
      }
      if (canonicalJson(plan) !== persistedPlan.compiled_plan_json)
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic T2b persisted Plan bytes are not canonical',
        );
      verifyCompiledPlanAuthority(plan);
      if (plan.plan_hash !== persistedPlan.plan_hash)
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic T2b persisted Plan hash does not match its bytes',
        );
      const nodes = plan.nodes as JsonObject[];
      const edges = [
        ...(plan.control_edges as JsonObject[]),
        ...(plan.data_edges as JsonObject[]),
      ];
      const priorManifest = transaction.queryOne<{
        manifest_hash: Sha256Hash;
        plan_hash: Sha256Hash;
        input_hash: Sha256Hash;
      }>(
        `SELECT manifest_hash, plan_hash, input_hash
           FROM workflow_graph_run_manifest
          WHERE graph_run_id = ? AND scope_id = ?`,
        [input.graphRunId, scopeId],
      );
      if (build.status === 'materialized') {
        const scope = transaction.queryOne<{
          parent_scope_id: string;
          owner_node_id: string;
          child_key: string;
          plan_id: string;
          plan_hash: Sha256Hash;
          input_snapshot_value_id: string;
          input_snapshot_hash: Sha256Hash;
          lifecycle: string;
        }>(
          `SELECT parent_scope_id, owner_node_id, child_key, plan_id, plan_hash,
                  input_snapshot_value_id, input_snapshot_hash, lifecycle
             FROM workflow_graph_scopes
            WHERE id = ? AND graph_run_id = ?`,
          [scopeId, input.graphRunId],
        );
        if (
          build.scope_id !== scopeId ||
          !scope ||
          scope.parent_scope_id !== build.owner_scope_id ||
          scope.owner_node_id !== build.owner_node_id ||
          scope.child_key !== build.invocation_key ||
          scope.plan_id !== build.compiled_plan_id ||
          scope.plan_hash !== build.compiled_plan_hash ||
          scope.input_snapshot_value_id !== build.input_snapshot_value_id ||
          scope.input_snapshot_hash !== build.input_snapshot_hash ||
          !['active', 'closing', 'closed'].includes(scope.lifecycle) ||
          !priorManifest ||
          priorManifest.plan_hash !== build.compiled_plan_hash ||
          priorManifest.input_hash !== build.input_snapshot_hash
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'Dynamic T2b materialized replay lineage drifted',
          );
        verifyPersistedPlanGeneratedSchemaAuthorities(transaction, {
          planId: build.compiled_plan_id,
          graphRunId: input.graphRunId,
          planHash: build.compiled_plan_hash,
          plan,
        });
        return {
          disposition: 'exact_replay',
          scopeId,
          manifestHash: priorManifest.manifest_hash,
          nodeCount: nodes.length,
          edgeCount: edges.length,
        };
      }
      if (priorManifest)
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic T2b manifest exists without a materialized build',
        );
      const run = transaction.queryOne<{
        lifecycle: string;
        control: string;
        operational_state: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        `SELECT lifecycle, control, operational_state, work_fence_epoch,
                row_version FROM workflow_graph_runs WHERE id = ?`,
        [input.graphRunId],
      );
      const parent = transaction.queryOne<{
        depth: number;
        lifecycle: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        `SELECT depth, lifecycle, work_fence_epoch, row_version
           FROM workflow_graph_scopes
          WHERE id = ? AND graph_run_id = ?`,
        [build.owner_scope_id, input.graphRunId],
      );
      const owner = transaction.queryOne<{
        phase: string;
        controller_state: string | null;
        row_version: number;
      }>(
        `SELECT phase, controller_state, row_version
           FROM workflow_graph_nodes
          WHERE id = ? AND graph_run_id = ? AND scope_id = ?`,
        [build.owner_node_id, input.graphRunId, build.owner_scope_id],
      );
      if (
        !run ||
        !parent ||
        !owner ||
        run.lifecycle !== 'executing' ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        run.row_version !== input.expectedRunRowVersion ||
        parent.lifecycle !== 'active' ||
        parent.work_fence_epoch !== input.expectedOwnerScopeWorkFenceEpoch ||
        parent.row_version !== input.expectedOwnerScopeRowVersion ||
        owner.phase !== 'active' ||
        owner.controller_state !== 'running' ||
        owner.row_version !== input.expectedOwnerNodeRowVersion ||
        build.status !== 'compiled' ||
        build.row_version !== input.expectedBuildRowVersion ||
        build.run_work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        build.owner_scope_work_fence_epoch !==
          input.expectedOwnerScopeWorkFenceEpoch
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'Dynamic T2b owner, build, work epoch, or row version is stale',
        );
      if (
        !transaction.queryOne<{ id: string }>(
          `SELECT id FROM workflow_values
            WHERE id = ? AND content_hash = ? AND payload_state = 'live'`,
          [build.input_snapshot_value_id, build.input_snapshot_hash],
        )
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'Dynamic T2b input snapshot is unavailable',
        );
      verifyPersistedPlanGeneratedSchemaAuthorities(transaction, {
        planId: build.compiled_plan_id,
        graphRunId: input.graphRunId,
        planHash: build.compiled_plan_hash,
        plan,
      });
      const reservationGroupId = stableRuntimeId('reservation-group', {
        graph_run_id: input.graphRunId,
        scope_id: scopeId,
        purpose: 'child_scope_materialization',
      });
      const amounts: Record<string, number> = {
        scopes_total: 1,
        nodes_total: nodes.length,
      };
      if (edges.length > 0) amounts.edges_total = edges.length;
      reserveLedgerResources(transaction, {
        graphRunId: input.graphRunId,
        reservationGroupId,
        consumer: { scopeId },
        amounts,
        purpose: 'child_scope_materialization',
        settlementMode: 'consume_on_create',
        nowMs: input.nowMs,
      });
      transaction.execute(
        `INSERT INTO workflow_graph_scopes (
           id, graph_run_id, parent_scope_id, owner_node_id, child_key,
           scope_kind, depth, plan_id, plan_hash, input_snapshot_json,
           input_snapshot_value_id, input_snapshot_hash,
           materialization_reservation_group_id, owner_run_work_fence_epoch,
           owner_scope_work_fence_epoch, lifecycle, work_fence_epoch,
           outcome_kind, exit_name, candidate_node_id, output_value_id,
           output_hash, error_code, error_detail_value_id, error_detail_hash,
           close_request_id, completion_cut_id, next_resolution_seq,
           next_candidate_seq, row_version, created_at_ms, finished_at_ms,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active',
           0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           0, 0, 1, ?, NULL, ?)`,
        [
          scopeId,
          input.graphRunId,
          build.owner_scope_id,
          build.owner_node_id,
          build.invocation_key,
          build.scope_kind,
          parent.depth + 1,
          build.compiled_plan_id,
          build.compiled_plan_hash,
          build.input_snapshot_value_id,
          build.input_snapshot_hash,
          reservationGroupId,
          input.expectedRunWorkFenceEpoch,
          input.expectedOwnerScopeWorkFenceEpoch,
          input.nowMs,
          input.nowMs,
        ],
      );
      for (const node of [...nodes].sort((left, right) =>
        ascii(String(left.id), String(right.id)),
      )) {
        const nodeKey = String(node.id);
        const nodeType = String(node.type);
        const binding = objectField(node, 'capability_binding');
        const capabilityRef = binding ? objectField(binding, 'ref') : null;
        const capabilityRowId = capabilityRef
          ? registryResourceId({
              resource_type: 'capability',
              ref: {
                id: String(capabilityRef.id),
                version: String(capabilityRef.version),
              },
            })
          : null;
        const capability = capabilityRowId
          ? transaction.queryOne<{
              content_hash: Sha256Hash;
              publication_state: string;
            }>(
              `SELECT content_hash, publication_state
                 FROM workflow_registry_resources
                WHERE id = ? AND resource_type = 'capability'`,
              [capabilityRowId],
            )
          : null;
        if (
          capabilityRowId &&
          (!capability || capability.publication_state !== 'published')
        )
          throw new G5RuntimeError(
            'precondition_failed',
            `Dynamic T2b capability is unavailable: ${nodeKey}`,
          );
        const dynamic = ['subgraph', 'expand', 'map'].includes(nodeType);
        transaction.execute(
          `INSERT INTO workflow_graph_nodes (
             id, graph_run_id, scope_id, node_key, node_type,
             capability_resource_id, capability_version, capability_hash,
             normalized_node_json, phase, trigger_state, input_state,
             trigger_cut_json, trigger_cut_hash, input_snapshot_json,
             input_snapshot_value_id, input_snapshot_hash, selected_edges_json,
             activation_event_seq, run_work_fence_epoch_at_activation,
             scope_work_fence_epoch_at_activation, terminal_status,
             terminal_code, child_exit, published_output_envelope_value_id,
             published_output_envelope_hash, port_contract_hash,
             current_attempt_id, current_attempt_no, active_wait_id,
             controller_state, controller_decision_json,
             controller_decision_hash, controller_remaining_count,
             controller_reservation_group_id, row_version, ready_at_ms,
             terminal_at_ms, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unknown', 'open',
             NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL,
             ?, NULL, 1, NULL, NULL, ?, ?)`,
          [
            stableRuntimeId('node', {
              graph_run_id: input.graphRunId,
              scope_id: scopeId,
              node_key: nodeKey,
            }),
            input.graphRunId,
            scopeId,
            nodeKey,
            nodeType,
            capabilityRowId,
            capabilityRef ? String(capabilityRef.version) : null,
            capability?.content_hash ?? null,
            canonicalJson(node),
            nodeOutputPortContractHash(objectField(node, 'output_ports') ?? {}),
            dynamic ? 'sealing' : null,
            dynamic ? 0 : null,
            input.nowMs,
            input.nowMs,
          ],
        );
      }
      for (const edge of [...edges].sort((left, right) =>
        ascii(String(left.id), String(right.id)),
      )) {
        const edgeKey = String(edge.id);
        const edgeKind = (plan.control_edges as JsonObject[]).some(
          (candidate) => String(candidate.id) === edgeKey,
        )
          ? 'control'
          : 'data';
        const edgeId = stableRuntimeId('edge', {
          graph_run_id: input.graphRunId,
          scope_id: scopeId,
          edge_key: edgeKey,
        });
        transaction.execute(
          `INSERT INTO workflow_graph_edges (
             id, graph_run_id, scope_id, edge_key, edge_kind,
             compiled_edge_json, compiled_edge_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            edgeId,
            input.graphRunId,
            scopeId,
            edgeKey,
            edgeKind,
            canonicalJson(edge),
            String(edge.compiled_edge_hash),
          ],
        );
        transaction.execute(
          edgeKind === 'control'
            ? `INSERT INTO workflow_graph_control_edge_resolutions (
                 edge_id, state, decision_input_hash, decision_json, error_code,
                 resolution_seq, resolved_at_ms, row_version
               ) VALUES (?, 'unresolved', NULL, NULL, NULL, NULL, NULL, 1)`
            : `INSERT INTO workflow_graph_data_edge_resolutions (
                 edge_id, state, value_value_id, value_hash, schema_hash,
                 source_attempt_id, error_code, resolution_seq, resolved_at_ms,
                 row_version
               ) VALUES (?, 'unresolved', NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, 1)`,
          [edgeId],
        );
      }
      const manifest = appendRunManifest(transaction, {
        graphRunId: input.graphRunId,
        scopeId,
        parentScopeId: build.owner_scope_id,
        ownerNodeId: build.owner_node_id,
        childKey: build.invocation_key,
        scopeKind: build.scope_kind,
        sourceHash: plan.source_hash as Sha256Hash,
        planHash: build.compiled_plan_hash,
        interfaceHash: plan.interface_snapshot_hash as Sha256Hash,
        inputHash: build.input_snapshot_hash,
        policyHash: plan.policy_snapshot_hash as Sha256Hash,
        nowMs: input.nowMs,
      });
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_scope_builds
              SET target_scope_id = ?, status = 'materialized', scope_id = ?,
                  materialization_reservation_group_id = ?,
                  row_version = row_version + 1, updated_at_ms = ?
            WHERE id = ? AND graph_run_id = ? AND row_version = ?
              AND status = 'compiled' AND scope_id IS NULL`,
          [
            scopeId,
            scopeId,
            reservationGroupId,
            input.nowMs,
            input.buildId,
            input.graphRunId,
            input.expectedBuildRowVersion,
          ],
        ).changes,
        'Dynamic T2b build CAS',
      );
      const mapSlot = transaction.queryOne<{
        id: string;
        row_version: number;
      }>(
        `SELECT id, row_version FROM workflow_graph_map_item_results
          WHERE graph_run_id = ? AND build_id = ?`,
        [input.graphRunId, input.buildId],
      );
      if (mapSlot)
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_map_item_results
                SET scope_id = ?, row_version = row_version + 1
              WHERE id = ? AND row_version = ? AND outcome_state = 'open'
                AND scope_id IS NULL`,
            [scopeId, mapSlot.id, mapSlot.row_version],
          ).changes,
          'Dynamic T2b Map slot binding',
        );
      const refreshedRun = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        `SELECT next_event_seq, row_version
           FROM workflow_graph_runs WHERE id = ?`,
        [input.graphRunId],
      )!;
      const sequence = refreshedRun.next_event_seq + 1;
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_runs
              SET next_event_seq = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ?`,
          [sequence, input.nowMs, input.graphRunId, refreshedRun.row_version],
        ).changes,
        'Dynamic T2b event CAS',
      );
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId,
        nodeId: null,
        attemptId: null,
        eventType: 'scope_materialized',
        idempotencyKey: `scope-materialized:${scopeId}`,
        payloadJson: {
          scope_id: scopeId,
          build_id: input.buildId,
          owner_scope_id: build.owner_scope_id,
          owner_node_id: build.owner_node_id,
          run_manifest_hash: manifest.hash,
        },
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      assertNoDeferredForeignKeyViolations(
        transaction,
        'Dynamic T2b child materialization',
      );
      return {
        disposition: 'materialized',
        scopeId,
        manifestHash: manifest.hash,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      };
    },
    fault,
  );
}

type ChildOutcome = 'completed' | 'errored' | 'cancelled';
type MapOutcome = ChildOutcome | 'fenced';

interface ChildCutAuthority {
  readonly outcome: ChildOutcome;
  readonly selectedRuleId: string | null;
  readonly candidateId: string | null;
  readonly exitName: string | null;
  readonly outputValueId: string | null;
  readonly outputHash: Sha256Hash | null;
  readonly errorCode: string | null;
}

interface PersistedScopePlan {
  readonly planId: string;
  readonly planHash: Sha256Hash;
  readonly plan: CompiledScopePlanV2Document;
}

function loadScopePlan(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  scopeId: string,
): PersistedScopePlan {
  const row = transaction.queryOne<{
    plan_id: string;
    plan_hash: Sha256Hash;
    compiled_plan_json: string | null;
  }>(
    `SELECT s.plan_id, s.plan_hash, p.compiled_plan_json
       FROM workflow_graph_scopes s
       JOIN workflow_graph_scope_plans p
         ON p.id = s.plan_id AND p.graph_run_id = s.graph_run_id
        AND p.plan_hash = s.plan_hash
      WHERE s.graph_run_id = ? AND s.id = ?`,
    [graphRunId, scopeId],
  );
  if (!row || row.compiled_plan_json === null)
    throw new G5RuntimeError(
      'integrity_violation',
      `Scope ${scopeId} has no exact persisted Plan`,
    );
  let plan: CompiledScopePlanV2Document;
  try {
    plan = JSON.parse(row.compiled_plan_json) as CompiledScopePlanV2Document;
  } catch {
    throw new G5RuntimeError(
      'integrity_violation',
      `Scope ${scopeId} Plan bytes are not JSON`,
    );
  }
  if (
    canonicalJson(plan) !== row.compiled_plan_json ||
    plan.plan_hash !== row.plan_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `Scope ${scopeId} Plan bytes/hash drifted`,
    );
  verifyCompiledPlanAuthority(plan);
  verifyPersistedPlanGeneratedSchemaAuthorities(transaction, {
    planId: row.plan_id,
    graphRunId,
    planHash: row.plan_hash,
    plan,
  });
  return { planId: row.plan_id, planHash: row.plan_hash, plan };
}

function cutAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  closeRequest: {
    readonly reason: string;
    readonly selected_rule_id: string | null;
    readonly candidate_id: string | null;
    readonly error_code: string | null;
  },
): ChildCutAuthority {
  if (closeRequest.reason === 'normal') {
    const candidate = transaction.queryOne<{
      exit_name: string;
      output_snapshot_value_id: string;
      output_snapshot_hash: Sha256Hash;
    }>(
      `SELECT exit_name, output_snapshot_value_id, output_snapshot_hash
         FROM workflow_graph_terminal_candidates WHERE id = ?`,
      [closeRequest.candidate_id],
    );
    if (!candidate)
      throw new G5RuntimeError(
        'integrity_violation',
        'T7b normal close candidate is missing',
      );
    return {
      outcome: 'completed',
      selectedRuleId: closeRequest.selected_rule_id,
      candidateId: closeRequest.candidate_id,
      exitName: candidate.exit_name,
      outputValueId: candidate.output_snapshot_value_id,
      outputHash: candidate.output_snapshot_hash,
      errorCode: null,
    };
  }
  if (closeRequest.reason === 'engine_error')
    return {
      outcome: 'errored',
      selectedRuleId: null,
      candidateId: null,
      exitName: null,
      outputValueId: null,
      outputHash: null,
      errorCode: closeRequest.error_code,
    };
  return {
    outcome: 'cancelled',
    selectedRuleId: null,
    candidateId: null,
    exitName: null,
    outputValueId: null,
    outputHash: null,
    errorCode: null,
  };
}

function persistGeneratedOwnerOutput(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly ownerScopeId: string;
    readonly ownerNodeId: string;
    readonly content: JsonObject;
    readonly expectedGenerator: 'child_completion' | 'map_result';
    readonly nowMs: number;
  },
): { readonly id: string; readonly hash: Sha256Hash } {
  const identity = loadScopePlan(
    transaction,
    input.graphRunId,
    input.ownerScopeId,
  );
  const node = (identity.plan.nodes as JsonObject[]).find(
    (candidate) =>
      stableRuntimeId('node', {
        graph_run_id: input.graphRunId,
        scope_id: input.ownerScopeId,
        node_key: String(candidate.id),
      }) === input.ownerNodeId,
  );
  if (!node)
    throw new G5RuntimeError(
      'integrity_violation',
      'T7b owner is not in its exact persisted Plan',
    );
  const outputPort = String(
    input.expectedGenerator === 'map_result'
      ? node.result_output_port
      : node.completion_output_port,
  );
  const outputPorts = objectField(node, 'output_ports');
  const port = outputPorts ? objectField(outputPorts, outputPort) : null;
  const descriptor = port ? objectField(port, 'schema') : null;
  if (!descriptor)
    throw new G5RuntimeError(
      'integrity_violation',
      'T7b dynamic owner output port schema is missing',
    );
  const generated = loadPersistedPlanGeneratedSchemaAuthority(
    transaction,
    {
      planId: identity.planId,
      graphRunId: input.graphRunId,
      planHash: identity.planHash,
      plan: identity.plan,
    },
    descriptor,
    `T7b ${input.expectedGenerator} output`,
  );
  if (generated.authority.generator !== input.expectedGenerator)
    throw new G5RuntimeError(
      'integrity_violation',
      'T7b dynamic owner generated schema kind drifted',
    );
  const sourceHash = runtimeObjectHash(
    `${input.expectedGenerator.replaceAll('_', '-')}-value`,
    input.content,
  );
  const sourceId = stableRuntimeId('value', {
    graph_run_id: input.graphRunId,
    node_id: input.ownerNodeId,
    generator: input.expectedGenerator,
    content_hash: sourceHash,
  });
  insertInlineValue(transaction, {
    id: sourceId,
    content: input.content,
    contentHash: sourceHash,
    schemaAuthority: generated.authority,
    provenanceRef: `t7b:${input.ownerNodeId}:${input.expectedGenerator}`,
    retentionClass: 'run_recovery',
    ownerGraphRunId: input.graphRunId,
    createdAtMs: input.nowMs,
    rowVersion: 0,
  });
  const sources: Record<
    string,
    { readonly id: string; readonly hash: Sha256Hash } | null
  > = {};
  for (const portName of Object.keys(outputPorts!).sort(ascii))
    sources[portName] =
      portName === outputPort ? { id: sourceId, hash: sourceHash } : null;
  const envelope = persistNodeOutputEnvelope(transaction, {
    identity: {
      planId: identity.planId,
      graphRunId: input.graphRunId,
      planHash: identity.planHash,
      plan: identity.plan,
    },
    node,
    sourcePorts: sources,
    nowMs: input.nowMs,
  });
  return { id: envelope.id, hash: envelope.hash };
}

function mapPolicyDecision(
  policy: JsonObject,
  slots: readonly {
    readonly item_index: number;
    readonly outcome_state: MapOutcome | 'open';
    readonly exit_name: string | null;
    readonly completion_seq: number | null;
  }[],
):
  | {
      readonly terminal: true;
      readonly succeeded: boolean;
      readonly reason: string;
      readonly selectedIndices: readonly number[];
      readonly fenceReason: 'quorum_reached' | 'fail_fast' | null;
    }
  | { readonly terminal: false } {
  const open = slots.filter((slot) => slot.outcome_state === 'open');
  const terminalFailures = slots.filter((slot) =>
    ['errored', 'cancelled'].includes(slot.outcome_state),
  );
  if (policy.type === 'all_settled') {
    if (open.length > 0) return { terminal: false };
    const succeeded =
      policy.child_error === 'record' || terminalFailures.length === 0;
    return {
      terminal: true,
      succeeded,
      reason: succeeded ? 'all_settled' : 'child_rejected',
      selectedIndices: succeeded ? slots.map((slot) => slot.item_index) : [],
      fenceReason: null,
    };
  }
  const acceptedExits = policy.accepted_exits;
  if (
    !Array.isArray(acceptedExits) ||
    acceptedExits.length === 0 ||
    acceptedExits.some(
      (exit) => typeof exit !== 'string' || exit.length === 0,
    ) ||
    new Set(acceptedExits).size !== acceptedExits.length
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T7b persisted Map accepted exits are invalid',
    );
  const accepted = slots.filter(
    (slot) =>
      slot.outcome_state === 'completed' &&
      slot.exit_name !== null &&
      acceptedExits.includes(slot.exit_name),
  );
  const rejected = slots.filter(
    (slot) =>
      ['errored', 'cancelled'].includes(slot.outcome_state) ||
      (slot.outcome_state === 'completed' && !accepted.includes(slot)),
  );
  if (policy.type === 'all_accepted') {
    if (rejected.length > 0 && policy.on_rejected === 'fail_fast')
      return {
        terminal: true,
        succeeded: false,
        reason: 'child_rejected',
        selectedIndices: [],
        fenceReason: 'fail_fast',
      };
    if (open.length > 0) return { terminal: false };
    return {
      terminal: true,
      succeeded: rejected.length === 0,
      reason: rejected.length === 0 ? 'all_accepted' : 'child_rejected',
      selectedIndices:
        rejected.length === 0 ? accepted.map((slot) => slot.item_index) : [],
      fenceReason: null,
    };
  }
  if (policy.type === 'quorum') {
    const minimum = Number(policy.min_accepted);
    if (!Number.isSafeInteger(minimum) || minimum < 1)
      throw new G5RuntimeError(
        'integrity_violation',
        'T7b persisted Map quorum is invalid',
      );
    if (accepted.length >= minimum) {
      const winners = [...accepted]
        .sort((left, right) =>
          left.completion_seq! !== right.completion_seq!
            ? left.completion_seq! - right.completion_seq!
            : left.item_index - right.item_index,
        )
        .slice(0, minimum)
        .map((slot) => slot.item_index)
        .sort((left, right) => left - right);
      return {
        terminal: true,
        succeeded: true,
        reason: 'quorum_reached',
        selectedIndices: winners,
        fenceReason: 'quorum_reached',
      };
    }
    if (accepted.length + open.length < minimum)
      return {
        terminal: true,
        succeeded: false,
        reason: 'quorum_impossible',
        selectedIndices: [],
        fenceReason: 'fail_fast',
      };
    return { terminal: false };
  }
  throw new G5RuntimeError(
    'integrity_violation',
    'T7b persisted Map completion policy is unknown',
  );
}

function mapItemEnvelope(
  transaction: WorkflowRuntimeWriteTransaction,
  slot: {
    readonly item_index: number;
    readonly item_key_json: string;
    readonly item_key_hash: Sha256Hash;
    readonly scope_id: string | null;
    readonly outcome_state: MapOutcome;
    readonly exit_name: string | null;
    readonly error_code: string | null;
    readonly reason: string | null;
    readonly output_value_id: string | null;
    readonly output_hash: Sha256Hash | null;
    readonly completion_seq: number | null;
    readonly fence_event_seq: number | null;
  },
): JsonObject {
  const base: JsonObject = {
    index: slot.item_index,
    key: JSON.parse(slot.item_key_json) as JsonValue,
    key_hash: slot.item_key_hash,
    outcome: slot.outcome_state,
  };
  if (slot.outcome_state === 'completed') {
    const scope = transaction.queryOne<{ plan_hash: Sha256Hash }>(
      'SELECT plan_hash FROM workflow_graph_scopes WHERE id = ?',
      [slot.scope_id],
    );
    const cut = transaction.queryOne<{ cut_event_seq: number }>(
      `SELECT cut_event_seq FROM workflow_graph_completion_cuts
        WHERE scope_id = ?`,
      [slot.scope_id],
    );
    if (!scope || !cut)
      throw new G5RuntimeError(
        'integrity_violation',
        'T7b completed Map item lacks exact Scope/Cut lineage',
      );
    return {
      ...base,
      scope_id: slot.scope_id!,
      completion_seq: slot.completion_seq!,
      exit: slot.exit_name!,
      output_envelope_ref: slot.output_value_id!,
      output_envelope_hash: slot.output_hash!,
      plan_hash: scope.plan_hash,
      cut_event_seq: cut.cut_event_seq,
    };
  }
  if (slot.outcome_state === 'errored')
    return {
      ...base,
      scope_id: slot.scope_id,
      completion_seq: slot.completion_seq!,
      error_code: slot.error_code!,
    };
  if (slot.outcome_state === 'cancelled')
    return {
      ...base,
      scope_id: slot.scope_id!,
      completion_seq: slot.completion_seq!,
      reason: slot.reason!,
    };
  return {
    ...base,
    scope_id: slot.scope_id,
    fence_event_seq: slot.fence_event_seq!,
    reason: slot.reason!,
  };
}

export interface FinalizeChildT7bInput {
  readonly graphRunId: string;
  readonly childScopeId: string;
  readonly expectedChildScopeRowVersion: number;
  readonly expectedParentScopeRowVersion: number;
  readonly expectedOwnerNodeRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedParentScopeWorkFenceEpoch: number;
  readonly fenceManifestSchema: RuntimeRegistryRef;
  readonly mapItemResultsManifestSchema: RuntimeRegistryRef;
  readonly nowMs: number;
}

export interface FinalizeChildT7bReceipt {
  readonly disposition: 'consumed' | 'exact_replay';
  readonly completionCutId: string;
  readonly consumptionId: string;
  readonly parentDisposition: string;
  readonly ownerTerminal: boolean;
  readonly closedLoserScopeIds: readonly string[];
}

export function finalizeChildScopeT7b(
  store: WorkflowRuntimeStore,
  input: FinalizeChildT7bInput,
  fault?: G5TransactionFault,
): FinalizeChildT7bReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      assertExactPublishedRegistryResource(
        transaction,
        input.fenceManifestSchema,
        'T7b subtree fence manifest schema',
      );
      assertExactPublishedRegistryResource(
        transaction,
        input.mapItemResultsManifestSchema,
        'T7b Map item-results manifest schema',
      );
      const child = transaction.queryOne<{
        parent_scope_id: string;
        owner_node_id: string;
        lifecycle: string;
        close_request_id: string | null;
        completion_cut_id: string | null;
        row_version: number;
      }>(
        `SELECT parent_scope_id, owner_node_id, lifecycle, close_request_id,
                completion_cut_id, row_version
           FROM workflow_graph_scopes
          WHERE id = ? AND graph_run_id = ?`,
        [input.childScopeId, input.graphRunId],
      );
      if (!child || !child.parent_scope_id || !child.owner_node_id)
        throw new G5RuntimeError(
          'precondition_failed',
          'T7b requires a materialized child Scope',
        );
      const prior = transaction.queryOne<{
        id: string;
        child_completion_cut_id: string;
        disposition: string;
      }>(
        `SELECT id, child_completion_cut_id, disposition
           FROM workflow_graph_child_completion_consumptions
          WHERE graph_run_id = ? AND child_scope_id = ?`,
        [input.graphRunId, input.childScopeId],
      );
      if (prior) {
        if (
          child.lifecycle !== 'closed' ||
          child.completion_cut_id !== prior.child_completion_cut_id
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T7b replay Cut/consumption lineage drifted',
          );
        return {
          disposition: 'exact_replay',
          completionCutId: prior.child_completion_cut_id,
          consumptionId: prior.id,
          parentDisposition: prior.disposition,
          ownerTerminal: false,
          closedLoserScopeIds: [],
        };
      }
      const run = transaction.queryOne<{
        lifecycle: string;
        operational_state: string;
        work_fence_epoch: number;
        next_event_seq: number;
      }>(
        `SELECT lifecycle, operational_state, work_fence_epoch, next_event_seq
           FROM workflow_graph_runs WHERE id = ?`,
        [input.graphRunId],
      );
      const parent = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        `SELECT lifecycle, work_fence_epoch, row_version
           FROM workflow_graph_scopes
          WHERE id = ? AND graph_run_id = ?`,
        [child.parent_scope_id, input.graphRunId],
      );
      const owner = transaction.queryOne<{
        node_type: DynamicMode;
        phase: string;
        controller_state: string | null;
        controller_decision_json: string | null;
        controller_remaining_count: number | null;
        controller_reservation_group_id: string | null;
        row_version: number;
      }>(
        `SELECT node_type, phase, controller_state, controller_decision_json,
                controller_remaining_count, controller_reservation_group_id,
                row_version
           FROM workflow_graph_nodes
          WHERE id = ? AND graph_run_id = ? AND scope_id = ?`,
        [child.owner_node_id, input.graphRunId, child.parent_scope_id],
      );
      const closeRequest = child.close_request_id
        ? transaction.queryOne<{
            id: string;
            reason: string;
            selected_rule_id: string | null;
            candidate_id: string | null;
            error_code: string | null;
          }>(
            `SELECT id, reason, selected_rule_id, candidate_id, error_code
               FROM workflow_graph_scope_close_requests WHERE id = ?`,
            [child.close_request_id],
          )
        : undefined;
      if (
        !run ||
        !parent ||
        !owner ||
        !closeRequest ||
        child.lifecycle !== 'closing' ||
        child.row_version !== input.expectedChildScopeRowVersion ||
        parent.row_version !== input.expectedParentScopeRowVersion ||
        parent.work_fence_epoch !== input.expectedParentScopeWorkFenceEpoch ||
        owner.row_version !== input.expectedOwnerNodeRowVersion ||
        run.operational_state !== 'healthy' ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        !['executing', 'closing'].includes(run.lifecycle)
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T7b child, parent, owner, or work-fence authority is stale',
        );
      const openDescendant = transaction.queryOne<{ id: string }>(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM workflow_graph_scopes WHERE parent_scope_id = ?
           UNION ALL
           SELECT child.id FROM workflow_graph_scopes child
           JOIN descendants parent ON child.parent_scope_id = parent.id
         ) SELECT s.id FROM workflow_graph_scopes s
           JOIN descendants d ON d.id = s.id
          WHERE s.lifecycle <> 'closed' LIMIT 1`,
        [input.childScopeId],
      );
      if (openDescendant)
        throw new G5RuntimeError(
          'precondition_failed',
          'T7b child has an unclosed descendant',
        );
      const unsettledEffect = transaction.queryOne<{
        id: string;
        status: string;
      }>(
        `WITH RECURSIVE subtree(id) AS (
           SELECT ?
           UNION ALL
           SELECT child.id FROM workflow_graph_scopes child
           JOIN subtree parent ON child.parent_scope_id = parent.id
         ) SELECT effect.id, effect.status
             FROM workflow_graph_effect_operations effect
             JOIN subtree ON subtree.id = effect.scope_id
            WHERE effect.status NOT IN ('compensated', 'compensation_not_required')
            LIMIT 1`,
        [input.childScopeId],
      );
      if (unsettledEffect)
        throw new G5RuntimeError(
          'precondition_failed',
          'T7b required compensation barrier is not settled',
        );
      const childPlan = loadScopePlan(
        transaction,
        input.graphRunId,
        input.childScopeId,
      );
      const childCompletion = objectField(
        childPlan.plan as unknown as JsonObject,
        'completion',
      );
      if (!childCompletion)
        throw new G5RuntimeError(
          'integrity_violation',
          'T7b child Plan completion policy is missing',
        );
      const completionPolicyHash = verifyCompletionPolicyAuthority(
        childCompletion,
      ).policy_hash as Sha256Hash;
      const authority = cutAuthority(transaction, closeRequest);
      const cutSequence = run.next_event_seq + 1;
      const completionCutId = stableRuntimeId('completion-cut', {
        graph_run_id: input.graphRunId,
        scope_id: input.childScopeId,
        close_request_id: closeRequest.id,
      });
      const cutPayload: JsonObject = {
        graph_run_id: input.graphRunId,
        scope_id: input.childScopeId,
        close_request_id: closeRequest.id,
        selected_rule_id: authority.selectedRuleId,
        candidate_id: authority.candidateId,
        outcome_kind: authority.outcome,
        exit_name: authority.exitName,
        output_hash: authority.outputHash,
        completion_policy_hash: completionPolicyHash,
        cut_event_seq: cutSequence,
      };
      const cutHash = runtimeObjectHash('completion-cut', cutPayload);
      const dispositionEventPayload: JsonObject = {
        completion_cut_id: completionCutId,
        child_scope_id: input.childScopeId,
        parent_scope_id: child.parent_scope_id,
        owner_node_id: child.owner_node_id,
        outcome_kind: authority.outcome,
      };
      const runVersion = transaction.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!.row_version;
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_runs
              SET next_event_seq = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND next_event_seq = ?`,
          [
            cutSequence,
            input.nowMs,
            input.graphRunId,
            runVersion,
            run.next_event_seq,
          ],
        ).changes,
        'T7b Cut event CAS',
      );
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence: cutSequence,
        scopeId: input.childScopeId,
        nodeId: null,
        attemptId: null,
        eventType: 'child_completion_consumed',
        idempotencyKey: `child-cut:${input.childScopeId}`,
        payloadJson: dispositionEventPayload,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      transaction.execute(
        `INSERT INTO workflow_graph_completion_cuts (
           id, graph_run_id, scope_id, close_request_id, selected_rule_id,
           candidate_id, outcome_kind, exit_name, output_value_id, output_hash,
           completion_policy_hash, cut_event_seq, cut_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          completionCutId,
          input.graphRunId,
          input.childScopeId,
          closeRequest.id,
          authority.selectedRuleId,
          authority.candidateId,
          authority.outcome,
          authority.exitName,
          authority.outputValueId,
          authority.outputHash,
          completionPolicyHash,
          cutSequence,
          cutHash,
          input.nowMs,
        ],
      );
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_scopes
              SET lifecycle = 'closed', outcome_kind = ?, exit_name = ?,
                  candidate_node_id = ?, output_value_id = ?, output_hash = ?,
                  error_code = ?, completion_cut_id = ?,
                  row_version = row_version + 1, finished_at_ms = ?,
                  updated_at_ms = ?
            WHERE id = ? AND graph_run_id = ? AND row_version = ?
              AND lifecycle = 'closing' AND close_request_id = ?`,
          [
            authority.outcome,
            authority.exitName,
            authority.candidateId
              ? transaction.queryOne<{ terminal_node_id: string }>(
                  `SELECT terminal_node_id
                     FROM workflow_graph_terminal_candidates WHERE id = ?`,
                  [authority.candidateId],
                )!.terminal_node_id
              : null,
            authority.outputValueId,
            authority.outputHash,
            authority.errorCode,
            completionCutId,
            input.nowMs,
            input.nowMs,
            input.childScopeId,
            input.graphRunId,
            input.expectedChildScopeRowVersion,
            closeRequest.id,
          ],
        ).changes,
        'T7b child Scope Cut CAS',
      );

      let parentDisposition:
        | 'owner_output_published'
        | 'map_slot_completed'
        | 'map_slot_errored'
        | 'map_slot_cancelled'
        | 'map_slot_fenced'
        | 'non_publish_parent_fenced'
        | 'non_publish_owner_fenced';
      let mapSlotId: string | null = null;
      let mapSlotOutcome: MapOutcome | null = null;
      let ownerTerminal = false;
      const closedLoserScopeIds: string[] = [];
      if (owner.node_type === 'map') {
        const slot = transaction.queryOne<{
          id: string;
          outcome_state: MapOutcome | 'open';
          scope_id: string | null;
          row_version: number;
        }>(
          `SELECT id, outcome_state, scope_id, row_version
             FROM workflow_graph_map_item_results
            WHERE graph_run_id = ? AND owner_scope_id = ?
              AND owner_node_id = ? AND scope_id = ?`,
          [
            input.graphRunId,
            child.parent_scope_id,
            child.owner_node_id,
            input.childScopeId,
          ],
        );
        if (!slot)
          throw new G5RuntimeError(
            'integrity_violation',
            'T7b Map child has no exact R-021 slot lineage',
          );
        mapSlotId = slot.id;
        if (slot.outcome_state === 'fenced') {
          mapSlotOutcome = 'fenced';
          parentDisposition = 'map_slot_fenced';
        } else {
          if (slot.outcome_state !== 'open')
            throw new G5RuntimeError(
              'integrity_violation',
              'T7b Map slot is terminal without its unique consumption',
            );
          mapSlotOutcome = authority.outcome;
          parentDisposition =
            authority.outcome === 'completed'
              ? 'map_slot_completed'
              : authority.outcome === 'errored'
                ? 'map_slot_errored'
                : 'map_slot_cancelled';
          requireSingleChange(
            transaction.execute(
              `UPDATE workflow_graph_map_item_results
                  SET outcome_state = ?, exit_name = ?, error_code = ?, reason = ?,
                      output_value_id = ?, output_hash = ?, completion_seq = ?,
                      row_version = row_version + 1, resolved_at_ms = ?
                WHERE id = ? AND row_version = ? AND outcome_state = 'open'
                  AND scope_id = ?`,
              [
                authority.outcome,
                authority.exitName,
                authority.errorCode,
                authority.outcome === 'cancelled' ? closeRequest.reason : null,
                authority.outputValueId,
                authority.outputHash,
                cutSequence,
                input.nowMs,
                slot.id,
                slot.row_version,
                input.childScopeId,
              ],
            ).changes,
            'T7b Map terminal slot CAS',
          );
        }
        const expansion = transaction.queryOne<{
          id: string;
          manifest_hash: Sha256Hash;
          item_count: number;
          child_completion_policy_json: string;
          child_completion_policy_hash: Sha256Hash;
        }>(
          `SELECT id, manifest_hash, item_count, child_completion_policy_json,
                  child_completion_policy_hash
             FROM workflow_graph_expansion_manifests
            WHERE graph_run_id = ? AND owner_node_id = ?`,
          [input.graphRunId, child.owner_node_id],
        );
        if (!expansion)
          throw new G5RuntimeError(
            'integrity_violation',
            'T7b Map Expansion Manifest is missing',
          );
        const policy = JSON.parse(
          expansion.child_completion_policy_json,
        ) as JsonObject;
        if (
          runtimeObjectHash('child-completion-policy', policy) !==
          expansion.child_completion_policy_hash
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T7b Map completion policy hash drifted',
          );
        let slots = transaction.queryAll<{
          id: string;
          item_index: number;
          item_key_json: string;
          item_key_hash: Sha256Hash;
          build_id: string | null;
          scope_id: string | null;
          outcome_state: MapOutcome | 'open';
          exit_name: string | null;
          error_code: string | null;
          reason: string | null;
          output_value_id: string | null;
          output_hash: Sha256Hash | null;
          completion_seq: number | null;
          fence_event_seq: number | null;
          row_version: number;
        }>(
          `SELECT id, item_index, item_key_json, item_key_hash, build_id,
                  scope_id, outcome_state, exit_name, error_code, reason,
                  output_value_id, output_hash, completion_seq, fence_event_seq,
                  row_version
             FROM workflow_graph_map_item_results
            WHERE graph_run_id = ? AND owner_node_id = ?
            ORDER BY item_index`,
          [input.graphRunId, child.owner_node_id],
        );
        if (
          slots.length !== expansion.item_count ||
          slots.some((candidate, index) => candidate.item_index !== index)
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T7b Map slots do not cover the frozen Expansion Manifest',
          );
        let decision = owner.controller_decision_json
          ? (JSON.parse(owner.controller_decision_json) as JsonObject)
          : null;
        let evaluated = decision
          ? {
              terminal: true as const,
              succeeded: decision.succeeded === true,
              reason: String(decision.reason),
              selectedIndices: decision.selected_indices as number[],
              fenceReason: null,
            }
          : mapPolicyDecision(policy, slots);
        let immediatelySettledLosers = 0;
        if (!decision && evaluated.terminal) {
          decision = {
            succeeded: evaluated.succeeded,
            reason: evaluated.reason,
            selected_indices: [...evaluated.selectedIndices],
            decided_at_event_seq: cutSequence,
          };
          if (evaluated.fenceReason) {
            for (const loser of slots.filter(
              (candidate) => candidate.outcome_state === 'open',
            )) {
              requireSingleChange(
                transaction.execute(
                  `UPDATE workflow_graph_map_item_results
                      SET outcome_state = 'fenced', reason = ?,
                          fence_event_seq = ?, row_version = row_version + 1,
                          resolved_at_ms = ?
                    WHERE id = ? AND row_version = ?
                      AND outcome_state = 'open'`,
                  [
                    evaluated.fenceReason,
                    cutSequence,
                    input.nowMs,
                    loser.id,
                    loser.row_version,
                  ],
                ).changes,
                `T7b Map loser slot ${loser.id}`,
              );
              if (!loser.scope_id) {
                immediatelySettledLosers += 1;
                if (loser.build_id)
                  transaction.execute(
                    `UPDATE workflow_graph_scope_builds
                        SET status = 'fenced', lease_owner = NULL,
                            lease_token = NULL, lease_expires_at_ms = NULL,
                            row_version = row_version + 1, updated_at_ms = ?
                      WHERE id = ? AND status IN (
                        'pending_snapshot', 'ready_to_compile', 'compiling',
                        'compiled'
                      )`,
                    [input.nowMs, loser.build_id],
                  );
                continue;
              }
              const loserScope = transaction.queryOne<{
                row_version: number;
                work_fence_epoch: number;
                lifecycle: string;
              }>(
                `SELECT row_version, work_fence_epoch, lifecycle
                   FROM workflow_graph_scopes WHERE id = ?`,
                [loser.scope_id],
              );
              if (loserScope?.lifecycle === 'active') {
                const currentRun = transaction.queryOne<{
                  row_version: number;
                  work_fence_epoch: number;
                }>(
                  `SELECT row_version, work_fence_epoch
                     FROM workflow_graph_runs WHERE id = ?`,
                  [input.graphRunId],
                )!;
                requestScopeCloseT7aInTransaction(transaction, {
                  graphRunId: input.graphRunId,
                  scopeId: loser.scope_id,
                  expectedRunRowVersion: currentRun.row_version,
                  expectedScopeRowVersion: loserScope.row_version,
                  expectedRunWorkFenceEpoch: currentRun.work_fence_epoch,
                  expectedScopeWorkFenceEpoch: loserScope.work_fence_epoch,
                  cause: { reason: 'parent_close' },
                  manifestSchema: input.fenceManifestSchema,
                  nowMs: input.nowMs,
                });
                closedLoserScopeIds.push(loser.scope_id);
              }
            }
          }
        }
        const remaining = Math.max(
          0,
          (owner.controller_remaining_count ?? expansion.item_count) -
            1 -
            immediatelySettledLosers,
        );
        slots = transaction.queryAll<(typeof slots)[number]>(
          `SELECT id, item_index, item_key_json, item_key_hash, build_id,
                  scope_id, outcome_state, exit_name, error_code, reason,
                  output_value_id, output_hash, completion_seq, fence_event_seq,
                  row_version
             FROM workflow_graph_map_item_results
            WHERE graph_run_id = ? AND owner_node_id = ?
            ORDER BY item_index`,
          [input.graphRunId, child.owner_node_id],
        );
        const canTerminalize =
          evaluated.terminal &&
          remaining === 0 &&
          slots.every((candidate) => candidate.outcome_state !== 'open');
        let published: {
          readonly id: string;
          readonly hash: Sha256Hash;
        } | null = null;
        if (canTerminalize && evaluated.succeeded) {
          const items = slots.map((candidate) =>
            mapItemEnvelope(
              transaction,
              candidate as typeof candidate & { outcome_state: MapOutcome },
            ),
          );
          const itemSemanticHash = runtimeObjectHash('map-item-results', items);
          const itemContent: JsonObject = {
            items,
            manifest_hash: itemSemanticHash,
          };
          const itemContentHash = runtimeObjectHash(
            'map-item-results-manifest',
            itemContent,
          );
          const itemValueId = stableRuntimeId('value', {
            graph_run_id: input.graphRunId,
            owner_node_id: child.owner_node_id,
            content_hash: itemContentHash,
          });
          insertInlineValue(transaction, {
            id: itemValueId,
            content: itemContent,
            contentHash: itemContentHash,
            schemaResourceId: input.mapItemResultsManifestSchema.rowId,
            schemaResourceHash: input.mapItemResultsManifestSchema.hash,
            provenanceRef: `t7b:${child.owner_node_id}:map-item-results`,
            retentionClass: 'run_recovery',
            ownerGraphRunId: input.graphRunId,
            createdAtMs: input.nowMs,
          });
          published = persistGeneratedOwnerOutput(transaction, {
            graphRunId: input.graphRunId,
            ownerScopeId: child.parent_scope_id,
            ownerNodeId: child.owner_node_id,
            expectedGenerator: 'map_result',
            content: {
              expansion_manifest_ref: expansion.id,
              expansion_manifest_hash: expansion.manifest_hash,
              completion_policy_hash: expansion.child_completion_policy_hash,
              selected_indices: [...evaluated.selectedIndices],
              item_results_manifest_ref: itemValueId,
              item_results_manifest_hash: itemContentHash,
              item_count: expansion.item_count,
            },
            nowMs: input.nowMs,
          });
        }
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_nodes
                SET phase = ?, terminal_status = ?, terminal_code = ?,
                    published_output_envelope_value_id = ?,
                    published_output_envelope_hash = ?, controller_state = ?,
                    controller_decision_json = ?, controller_decision_hash = ?,
                    controller_remaining_count = ?,
                    controller_reservation_group_id = ?,
                    row_version = row_version + 1, terminal_at_ms = ?,
                    updated_at_ms = ?
              WHERE id = ? AND row_version = ? AND phase = 'active'
                AND controller_state IN ('running', 'closing_remaining')`,
            [
              canTerminalize ? 'terminal' : 'active',
              canTerminalize
                ? evaluated.succeeded
                  ? 'succeeded'
                  : 'failed'
                : null,
              canTerminalize && !evaluated.succeeded ? evaluated.reason : null,
              published?.id ?? null,
              published?.hash ?? null,
              canTerminalize
                ? 'settled'
                : decision
                  ? 'closing_remaining'
                  : 'running',
              decision ? canonicalJson(decision) : null,
              decision
                ? runtimeObjectHash('map-controller-decision', decision)
                : null,
              remaining,
              canTerminalize ? null : owner.controller_reservation_group_id,
              canTerminalize ? input.nowMs : null,
              input.nowMs,
              child.owner_node_id,
              input.expectedOwnerNodeRowVersion,
            ],
          ).changes,
          'T7b Map owner CAS',
        );
        if (canTerminalize && owner.controller_reservation_group_id)
          releaseLedgerReservationGroup(
            transaction,
            input.graphRunId,
            owner.controller_reservation_group_id,
            input.nowMs,
          );
        ownerTerminal = canTerminalize;
      } else if (parent.lifecycle !== 'active') {
        parentDisposition = 'non_publish_parent_fenced';
      } else if (
        owner.phase !== 'active' ||
        owner.controller_state !== 'running'
      ) {
        parentDisposition = 'non_publish_owner_fenced';
      } else {
        let published: {
          readonly id: string;
          readonly hash: Sha256Hash;
        } | null = null;
        if (authority.outcome === 'completed')
          published = persistGeneratedOwnerOutput(transaction, {
            graphRunId: input.graphRunId,
            ownerScopeId: child.parent_scope_id,
            ownerNodeId: child.owner_node_id,
            expectedGenerator: 'child_completion',
            content: {
              scope_id: input.childScopeId,
              exit: authority.exitName!,
              output_envelope_ref: authority.outputValueId!,
              output_envelope_hash: authority.outputHash!,
              plan_hash: childPlan.planHash,
              cut_event_seq: cutSequence,
            },
            nowMs: input.nowMs,
          });
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_nodes
                SET phase = 'terminal', terminal_status = ?, terminal_code = ?,
                    child_exit = ?, published_output_envelope_value_id = ?,
                    published_output_envelope_hash = ?, controller_state = 'settled',
                    controller_remaining_count = 0,
                    controller_reservation_group_id = NULL,
                    row_version = row_version + 1, terminal_at_ms = ?,
                    updated_at_ms = ?
              WHERE id = ? AND row_version = ? AND phase = 'active'
                AND controller_state = 'running'`,
            [
              authority.outcome === 'completed'
                ? 'succeeded'
                : authority.outcome === 'errored'
                  ? 'failed'
                  : 'cancelled',
              authority.errorCode,
              authority.exitName,
              published?.id ?? null,
              published?.hash ?? null,
              input.nowMs,
              input.nowMs,
              child.owner_node_id,
              input.expectedOwnerNodeRowVersion,
            ],
          ).changes,
          'T7b single child owner CAS',
        );
        if (owner.controller_reservation_group_id)
          releaseLedgerReservationGroup(
            transaction,
            input.graphRunId,
            owner.controller_reservation_group_id,
            input.nowMs,
          );
        ownerTerminal = true;
        parentDisposition = 'owner_output_published';
      }
      const consumptionId = stableRuntimeId('child-consumption', {
        graph_run_id: input.graphRunId,
        child_scope_id: input.childScopeId,
        child_completion_cut_id: completionCutId,
      });
      transaction.execute(
        `INSERT INTO workflow_graph_child_completion_consumptions (
           id, graph_run_id, child_scope_id, child_completion_cut_id,
           parent_scope_id, owner_node_id, map_slot_id,
           map_slot_outcome_state, disposition, parent_work_fence_epoch,
           disposition_event_seq, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          consumptionId,
          input.graphRunId,
          input.childScopeId,
          completionCutId,
          child.parent_scope_id,
          child.owner_node_id,
          mapSlotId,
          mapSlotOutcome,
          parentDisposition,
          input.expectedParentScopeWorkFenceEpoch,
          cutSequence,
          input.nowMs,
        ],
      );
      assertNoDeferredForeignKeyViolations(transaction, 'T7b child Cut');
      return {
        disposition: 'consumed',
        completionCutId,
        consumptionId,
        parentDisposition,
        ownerTerminal,
        closedLoserScopeIds,
      };
    },
    fault,
  );
}
