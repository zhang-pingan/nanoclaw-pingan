import type { CompiledScopePlanV2Document } from './contracts/compiler-contract-repair-types.js';
import type { JsonObject, Sha256Hash } from './contracts/types.js';
import { canonicalJson, domainSeparatedSha256 } from './contracts/hash.js';
import { compileWorkflow } from './compiler/compiler.js';
import { dynamicChildCompilerInputSnapshot } from './compiler/dynamic-snapshot.js';
import { buildDeploymentCapacityPublication } from './contracts/capacity-control-plane-source.js';
import type { DeploymentRuntimeCapacitySnapshot } from './contracts/capacity-control-plane-types.js';
import {
  initializeScopeFixedPointT3a,
  materializeRootScopeT2b,
  persistCompileResultT2a,
  reconcileFactT3a,
  requestSettledCloseT3b,
} from './runtime/reconciler.js';
import { scheduleReadyNodeT4 } from './runtime/basic-scheduler.js';
import {
  acceptInternalResultT6a,
  consumeRetryScheduleT6d,
  fireAttemptWatchdogT6d,
} from './runtime/node-execution.js';
import { prepareCapabilityDispatchT5 } from './runtime/outbox.js';
import {
  finalizeChildScopeT7b,
  materializeDynamicScopeT2b,
  persistDynamicCompileResultT2a,
  recordDynamicBuildFailureT2a,
  sealExpansionManifestT4,
} from './runtime/child-runtime.js';
import {
  commitRootT8,
  deriveTemporaryReplanTransitionAuthority,
} from './runtime/root-finalizer.js';
import {
  insertGraphEvent,
  insertInlineValue,
  requireSingleChange,
  runtimeObjectHash,
  stableRuntimeId,
} from './runtime/graph-store.js';
import type { RuntimeRegistryRef } from './contracts/g5-basic-runtime-types.js';
import type { WorkflowRuntimeStore } from './store/runtime-store/index.js';

export type WorkflowRuntimePhase =
  | 'compile'
  | 'materialize'
  | 'reconcile'
  | 'schedule'
  | 'recover'
  | 'close';

export interface WorkflowRuntimeAdvanceResult {
  readonly processed: number;
  readonly has_more: boolean;
}

export interface WorkflowRuntimeAdvanceAuthority {
  advance(
    phase: WorkflowRuntimePhase,
    limit: number,
    nowMs: number,
  ): WorkflowRuntimeAdvanceResult | Promise<WorkflowRuntimeAdvanceResult>;
}

export interface WorkflowRuntimeServiceLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface WorkflowRuntimeServiceOptions {
  readonly authority: WorkflowRuntimeAdvanceAuthority;
  readonly poll_interval_ms?: number;
  readonly batch_size?: number;
  readonly max_iterations_per_turn?: number;
  readonly now?: () => number;
  readonly logger?: WorkflowRuntimeServiceLogger;
  readonly on_commit?: (result: {
    readonly phase: WorkflowRuntimePhase;
    readonly processed: number;
  }) => void;
}

const PHASES: readonly WorkflowRuntimePhase[] = [
  'compile',
  'materialize',
  'reconcile',
  'schedule',
  'recover',
  'close',
];

const NOOP_LOGGER: WorkflowRuntimeServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class WorkflowRuntimeService {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxIterations: number;
  private readonly now: () => number;
  private readonly log: WorkflowRuntimeServiceLogger;
  private pollTimer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopping = false;
  private wakePending = false;

  constructor(private readonly options: WorkflowRuntimeServiceOptions) {
    this.pollIntervalMs = options.poll_interval_ms ?? 1_000;
    this.batchSize = options.batch_size ?? 32;
    this.maxIterations = options.max_iterations_per_turn ?? 8;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? NOOP_LOGGER;
    if (
      !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 100 ||
      !Number.isSafeInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 200 ||
      !Number.isSafeInteger(this.maxIterations) ||
      this.maxIterations < 1 ||
      this.maxIterations > 100
    ) {
      throw new Error('WorkflowRuntimeService bounds are invalid');
    }
  }

  async start(): Promise<void> {
    if (this.pollTimer) return;
    this.stopping = false;
    this.pollTimer = setInterval(
      () => this.wake('fallback_poll'),
      this.pollIntervalMs,
    );
    this.pollTimer.unref?.();
    this.wake('startup_scan');
    await this.drainScheduledLoop();
    this.log.info({}, 'Workflow Runtime advancement service started');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakePending = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.immediate) clearImmediate(this.immediate);
    this.immediate = null;
    if (this.loopPromise) await this.loopPromise;
    this.log.info({}, 'Workflow Runtime advancement service stopped');
  }

  wake(_reason = 'runtime_commit'): void {
    if (this.stopping) return;
    this.wakePending = true;
    if (this.loopPromise || this.immediate) return;
    this.immediate = setImmediate(() => {
      this.immediate = null;
      void this.runLoop();
    });
  }

  private async drainScheduledLoop(): Promise<void> {
    if (this.immediate) {
      clearImmediate(this.immediate);
      this.immediate = null;
    }
    await this.runLoop();
  }

  private async runLoop(): Promise<void> {
    if (this.stopping || this.loopPromise) return this.loopPromise ?? undefined;
    this.loopPromise = this.runLoopInternal().finally(() => {
      this.loopPromise = null;
      if (this.wakePending && !this.stopping) this.wake('coalesced');
    });
    return this.loopPromise;
  }

  private async runLoopInternal(): Promise<void> {
    let iteration = 0;
    while (
      !this.stopping &&
      this.wakePending &&
      iteration < this.maxIterations
    ) {
      this.wakePending = false;
      iteration += 1;
      let hasMore = false;
      for (const phase of PHASES) {
        if (this.stopping) break;
        try {
          const result = await this.options.authority.advance(
            phase,
            this.batchSize,
            this.now(),
          );
          if (
            !Number.isSafeInteger(result.processed) ||
            result.processed < 0 ||
            result.processed > this.batchSize
          ) {
            throw new Error(`Runtime phase ${phase} returned an invalid count`);
          }
          if (result.processed > 0) {
            this.options.on_commit?.({ phase, processed: result.processed });
          }
          hasMore ||= result.has_more;
        } catch (error) {
          this.log.error(
            {
              phase,
              error: error instanceof Error ? error.message : String(error),
            },
            'Workflow Runtime phase failed',
          );
        }
      }
      this.wakePending ||= hasMore;
    }
    if (this.wakePending && !this.stopping) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

interface CompileCandidate extends Record<string, unknown> {
  build_id: string;
  graph_run_id: string;
  workflow_id: string;
  root_scope_id: string;
  build_row_version: number;
  run_row_version: number;
  owner_scope_row_version: number | null;
  owner_node_row_version: number | null;
  run_work_fence_epoch: number;
  owner_scope_work_fence_epoch: number;
  compiler_snapshot_hash: Sha256Hash;
  source_snapshot_json: string | null;
  source_snapshot_value_json: string | null;
  definition_json: string;
  state_config_json: string;
  entry_point: string;
  state_key: string;
  scope_kind: string;
  owner_node_json: string | null;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function parseObject(value: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  const result = object(parsed);
  if (!result) throw new Error('Expected a JSON object');
  return result;
}

function finiteDeadline(nowMs: number, durationMs: number): number {
  const duration =
    Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : 1;
  return Math.min(Number.MAX_SAFE_INTEGER, nowMs + duration);
}

function runtimeRef(value: unknown): RuntimeRegistryRef | null {
  const candidate = object(value);
  const ref = object(candidate?.ref);
  if (
    !candidate ||
    !ref ||
    typeof candidate.rowId !== 'string' ||
    typeof candidate.resourceType !== 'string' ||
    typeof ref.id !== 'string' ||
    typeof ref.version !== 'string' ||
    typeof candidate.hash !== 'string'
  ) {
    return null;
  }
  return candidate as unknown as RuntimeRegistryRef;
}

/**
 * Runtime-owned durable work discovery. Published deployments persist the
 * compiler input snapshot in state_config.compiler_input_snapshot; dynamic
 * builds may place it beside source in source_snapshot_json.
 */
export class WorkflowRuntimeTransactionAuthority implements WorkflowRuntimeAdvanceAuthority {
  constructor(private readonly store: WorkflowRuntimeStore) {}

  advance(
    phase: WorkflowRuntimePhase,
    limit: number,
    nowMs: number,
  ): WorkflowRuntimeAdvanceResult {
    switch (phase) {
      case 'compile':
        return this.compile(limit, nowMs);
      case 'materialize':
        return this.materialize(limit, nowMs);
      case 'reconcile':
        return this.reconcile(limit, nowMs);
      case 'schedule':
        return this.schedule(limit, nowMs);
      case 'recover':
        return this.recover(limit, nowMs);
      case 'close':
        return this.close(limit, nowMs);
    }
  }

  private compile(limit: number, nowMs: number): WorkflowRuntimeAdvanceResult {
    const rows = this.store.queryAll<CompileCandidate>(
      `SELECT b.id AS build_id, b.graph_run_id, r.workflow_id, r.root_scope_id,
              b.row_version AS build_row_version,
              r.row_version AS run_row_version,
              owner_scope.row_version AS owner_scope_row_version,
              owner.row_version AS owner_node_row_version,
              b.run_work_fence_epoch,
              b.owner_scope_work_fence_epoch, b.compiler_snapshot_hash,
              b.source_snapshot_json,
              source_value.inline_canonical_json AS source_snapshot_value_json,
              definition_value.inline_canonical_json AS definition_json,
              state_value.inline_canonical_json AS state_config_json,
              creation.entry_point, r.state_key, b.scope_kind
              , owner.normalized_node_json AS owner_node_json
         FROM workflow_graph_scope_builds b
         JOIN workflow_graph_runs r ON r.id = b.graph_run_id
         JOIN workflows w ON w.id = r.workflow_id
         JOIN workflow_creation_requests creation ON creation.id = w.creation_request_id
         JOIN workflow_state_activations activation ON activation.id = r.state_instance_id
         JOIN workflow_registry_resources definition
           ON definition.id = activation.workflow_definition_resource_id
          AND definition.content_hash = activation.workflow_definition_resource_hash
         JOIN workflow_values definition_value ON definition_value.id = definition.canonical_value_id
         JOIN workflow_values state_value ON state_value.id = r.state_config_value_id
    LEFT JOIN workflow_values source_value
           ON source_value.id = b.source_snapshot_value_id
          AND source_value.content_hash = b.source_snapshot_hash
    LEFT JOIN workflow_graph_scopes owner_scope
           ON owner_scope.graph_run_id = b.graph_run_id
          AND owner_scope.id = b.owner_scope_id
    LEFT JOIN workflow_graph_nodes owner
           ON owner.graph_run_id = b.graph_run_id
          AND owner.scope_id = b.owner_scope_id
          AND owner.id = b.owner_node_id
        WHERE b.status = 'ready_to_compile'
          AND r.control = 'running' AND r.operational_state = 'healthy'
        ORDER BY b.created_at_ms, b.id COLLATE BINARY LIMIT ?`,
      [limit + 1],
    );
    let processed = 0;
    for (const row of rows.slice(0, limit)) {
      const stateConfig = parseObject(row.state_config_json);
      const sourceSnapshot = row.source_snapshot_json
        ? parseObject(row.source_snapshot_json)
        : row.source_snapshot_value_json
          ? parseObject(row.source_snapshot_value_json)
          : null;
      const compilerInput =
        object(sourceSnapshot?.compiler_input_snapshot) ??
        object(stateConfig.compiler_input_snapshot);
      const definition = parseObject(row.definition_json);
      const states = object(definition.states);
      const definitionState = object(states?.[row.state_key]);
      const graphSource = object(definitionState?.graph_source);
      const source =
        object(sourceSnapshot?.source) ??
        sourceSnapshot ??
        graphSource ??
        definition;
      const precompiledPlan = object(stateConfig.precompiled_plan);
      if (row.scope_kind === 'root' && precompiledPlan) {
        const plan = precompiledPlan as unknown as CompiledScopePlanV2Document;
        persistCompileResultT2a(this.store, {
          graphRunId: row.graph_run_id,
          buildId: row.build_id,
          expectedBuildRowVersion: row.build_row_version,
          expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
          expectedOwnerScopeWorkFenceEpoch: row.owner_scope_work_fence_epoch,
          expectedCompilerSnapshotHash: row.compiler_snapshot_hash,
          expectedBuildLease: null,
          sourceJson: source,
          sourceHash: plan.source_hash as Sha256Hash,
          plan,
          staticChildPlanBundle: {
            format: 'icarus.workflow-compiler-static-child-plan-bundle/1',
            entries: [],
          },
          nowMs,
        });
        processed += 1;
        continue;
      }
      if (!compilerInput) {
        this.persistCompileFailure(
          row,
          {
            format: 'icarus.workflow-runtime-compile-failure/1',
            failure_kind: 'compiler_snapshot_missing',
            build_id: row.build_id,
            graph_run_id: row.graph_run_id,
            scope_kind: row.scope_kind,
            compiler_snapshot_hash: row.compiler_snapshot_hash,
          },
          'compiler_snapshot_missing',
          nowMs,
        );
        processed += 1;
        continue;
      }
      const effectiveCompilerInput =
        row.scope_kind !== 'root' && row.owner_node_json
          ? dynamicChildCompilerInputSnapshot(
              compilerInput,
              parseObject(row.owner_node_json),
            )
          : compilerInput;
      const outcome = compileWorkflow({
        caseId: `runtime:${row.graph_run_id}:${row.build_id}`,
        sourceKind:
          graphSource || row.scope_kind !== 'root'
            ? 'graph_scope'
            : 'workflow_definition',
        rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
        inputSnapshot: effectiveCompilerInput,
        ...(graphSource || row.scope_kind !== 'root'
          ? {}
          : { entryPoint: row.entry_point }),
      });
      if (!outcome.ok) {
        this.persistCompileFailure(
          row,
          {
            format: 'icarus.workflow-runtime-compile-failure/1',
            failure_kind: 'compiler_rejected',
            build_id: row.build_id,
            graph_run_id: row.graph_run_id,
            scope_kind: row.scope_kind,
            source_hash: outcome.value.sourceHash,
            diagnostics: outcome.value.diagnostics,
          },
          outcome.value.diagnostics[0]?.code ?? 'compiler_rejected',
          nowMs,
        );
        processed += 1;
        continue;
      }
      const dynamicBinding =
        object(stateConfig.temporary_confirmation) ??
        object(stateConfig.personal_release);
      if (
        row.scope_kind !== 'root' &&
        dynamicBinding &&
        ((typeof dynamicBinding.source_hash === 'string' &&
          dynamicBinding.source_hash !== outcome.value.sourceHash) ||
          (typeof dynamicBinding.plan_hash === 'string' &&
            dynamicBinding.plan_hash !== outcome.value.plan.plan_hash))
      ) {
        this.persistCompileFailure(
          row,
          {
            format: 'icarus.workflow-runtime-compile-failure/1',
            failure_kind: 'confirmed_identity_mismatch',
            build_id: row.build_id,
            graph_run_id: row.graph_run_id,
            scope_kind: row.scope_kind,
            confirmed_source_hash:
              typeof dynamicBinding.source_hash === 'string'
                ? dynamicBinding.source_hash
                : null,
            actual_source_hash: outcome.value.sourceHash,
            confirmed_plan_hash:
              typeof dynamicBinding.plan_hash === 'string'
                ? dynamicBinding.plan_hash
                : null,
            actual_plan_hash: outcome.value.plan.plan_hash,
          },
          'integrity_violation',
          nowMs,
        );
        processed += 1;
        continue;
      }
      if (row.scope_kind === 'root') {
        persistCompileResultT2a(this.store, {
          graphRunId: row.graph_run_id,
          buildId: row.build_id,
          expectedBuildRowVersion: row.build_row_version,
          expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
          expectedOwnerScopeWorkFenceEpoch: row.owner_scope_work_fence_epoch,
          expectedCompilerSnapshotHash: row.compiler_snapshot_hash,
          expectedBuildLease: null,
          sourceJson: source,
          sourceHash: outcome.value.sourceHash,
          plan: outcome.value.plan,
          staticChildPlanBundle: outcome.value.staticChildPlanBundle,
          nowMs,
        });
      } else {
        persistDynamicCompileResultT2a(this.store, {
          graphRunId: row.graph_run_id,
          buildId: row.build_id,
          expectedBuildRowVersion: row.build_row_version,
          expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
          expectedOwnerScopeWorkFenceEpoch: row.owner_scope_work_fence_epoch,
          source,
          plan: outcome.value.plan,
          nowMs,
        });
      }
      processed += 1;
    }
    return { processed, has_more: rows.length > limit };
  }

  private persistCompileFailure(
    row: CompileCandidate,
    detail: JsonObject,
    errorCode: string,
    nowMs: number,
  ): void {
    const stateConfig = parseObject(row.state_config_json);
    const schema =
      runtimeRef(stateConfig.fence_manifest_schema) ??
      runtimeRef(stateConfig.manifest_schema) ??
      this.firstResource('schema');
    if (!schema) {
      throw new Error('Runtime compile failure has no diagnostic schema');
    }
    const detailHash = runtimeObjectHash('compile-failure-detail', detail);
    const detailValue = {
      id: stableRuntimeId('value', {
        graph_run_id: row.graph_run_id,
        build_id: row.build_id,
        kind: 'compile-failure-detail',
        content_hash: detailHash,
      }),
      hash: detailHash,
    };

    if (row.scope_kind === 'root') {
      const remediationPolicy = this.firstResource(
        'operational_remediation_policy',
      );
      const policyValue = remediationPolicy
        ? this.store.queryOne<{
            inline_canonical_json: string;
          }>(
            `SELECT value.inline_canonical_json
               FROM workflow_registry_resources resource
               JOIN workflow_values value ON value.id = resource.canonical_value_id
              WHERE resource.id = ? AND resource.content_hash = ?
                AND resource.publication_state = 'published'`,
            [remediationPolicy.rowId, remediationPolicy.hash],
          )
        : null;
      const policy = policyValue
        ? parseObject(policyValue.inline_canonical_json)
        : null;
      const configuredDuration = Number(policy?.max_duration_ms);
      const remediationDurationMs = remediationPolicy
        ? Number.isSafeInteger(configuredDuration) && configuredDuration > 0
          ? configuredDuration
          : 24 * 60 * 60_000
        : null;
      const severity =
        errorCode === 'integrity_violation'
          ? ('quarantine' as const)
          : ('action_required' as const);
      const blockerKind =
        severity === 'quarantine'
          ? ('integrity_quarantine' as const)
          : ('resource_or_credential_unavailable' as const);
      this.store.withImmediateTransaction((transaction) => {
        insertInlineValue(transaction, {
          id: detailValue.id,
          content: detail,
          contentHash: detailValue.hash,
          schemaResourceId: schema.rowId,
          schemaResourceHash: schema.hash,
          provenanceRef: `runtime-service:${row.build_id}:compile-failure`,
          retentionClass: 'workflow_audit',
          ownerGraphRunId: row.graph_run_id,
          createdAtMs: nowMs,
        });
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_scope_builds
                SET status = 'failed', error_code = ?,
                    error_detail_value_id = ?, error_detail_hash = ?,
                    lease_owner = NULL, lease_token = NULL,
                    lease_expires_at_ms = NULL,
                    row_version = row_version + 1, updated_at_ms = ?
              WHERE id = ? AND graph_run_id = ? AND row_version = ?
                AND status = 'ready_to_compile'
                AND run_work_fence_epoch = ?
                AND owner_scope_work_fence_epoch = ?
                AND compiler_snapshot_hash = ?`,
            [
              errorCode,
              detailValue.id,
              detailValue.hash,
              nowMs,
              row.build_id,
              row.graph_run_id,
              row.build_row_version,
              row.run_work_fence_epoch,
              row.owner_scope_work_fence_epoch,
              row.compiler_snapshot_hash,
            ],
          ).changes,
          'Root compile failure CAS',
        );
        const run = transaction.queryOne<{
          workflow_id: string;
          operational_state: string;
          next_event_seq: number;
          row_version: number;
        }>(
          `SELECT workflow_id, operational_state, next_event_seq, row_version
             FROM workflow_graph_runs WHERE id = ?`,
          [row.graph_run_id],
        );
        if (
          !run ||
          run.workflow_id !== row.workflow_id ||
          run.operational_state !== 'healthy' ||
          run.row_version !== row.run_row_version
        ) {
          throw new Error('Root compile failure Run authority is stale');
        }
        const failureSequence = run.next_event_seq + 1;
        const blockerSequence = failureSequence + 1;
        const expectedState =
          severity === 'quarantine' ? 'quarantined' : 'action_required';
        const blockerId = stableRuntimeId('blocker', {
          graph_run_id: row.graph_run_id,
          blocker_kind: blockerKind,
          source_kind: 'event',
          source_identity: failureSequence,
        });
        insertGraphEvent(transaction, {
          graphRunId: row.graph_run_id,
          sequence: failureSequence,
          scopeId: row.root_scope_id,
          nodeId: null,
          attemptId: null,
          eventType: 'build_failed',
          idempotencyKey: `build-failed:${row.build_id}`,
          payloadValueId: detailValue.id,
          payloadHash: detailValue.hash,
          occurredAtMs: nowMs,
          createdAtMs: nowMs,
        });
        if (remediationPolicy) {
          insertGraphEvent(transaction, {
            graphRunId: row.graph_run_id,
            sequence: blockerSequence,
            scopeId: row.root_scope_id,
            nodeId: null,
            attemptId: null,
            eventType: 'operational_blocker_changed',
            idempotencyKey: `blocker-open:${blockerId}`,
            payloadJson: {
              blocker_id: blockerId,
              status: 'open',
              severity,
            },
            occurredAtMs: nowMs,
            createdAtMs: nowMs,
          });
        }
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_graph_runs
                SET next_event_seq = ?,
                    operational_state = CASE WHEN ? IS NULL
                      THEN ? ELSE operational_state END,
                    row_version = row_version + 1, updated_at_ms = ?
              WHERE id = ? AND row_version = ? AND next_event_seq = ?
                AND operational_state = 'healthy'`,
            [
              remediationPolicy ? blockerSequence : failureSequence,
              remediationPolicy?.rowId ?? null,
              expectedState,
              nowMs,
              row.graph_run_id,
              row.run_row_version,
              run.next_event_seq,
            ],
          ).changes,
          'Root compile failure event-head CAS',
        );
        if (remediationPolicy) {
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
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?,
             'open', ?, ?, 0, NULL, ?, ?, NULL, NULL, NULL, NULL, 1, ?, NULL,
             NULL)`,
            [
              blockerId,
              row.workflow_id,
              row.graph_run_id,
              blockerKind,
              severity,
              failureSequence,
              errorCode,
              detailValue.id,
              detailValue.hash,
              remediationPolicy.rowId,
              remediationPolicy.hash,
              Math.min(Number.MAX_SAFE_INTEGER, nowMs + remediationDurationMs!),
              blockerSequence,
              nowMs,
            ],
          );
        } else {
          requireSingleChange(
            transaction.execute(
              `UPDATE workflows
                  SET operational_state = ?, row_version = row_version + 1,
                      updated_at_ms = ?
                WHERE id = ? AND operational_state = 'healthy'`,
              [expectedState, nowMs, row.workflow_id],
            ).changes,
            'Root compile failure Workflow state CAS',
          );
        }
        const converged = transaction.queryOne<{
          run_state: string;
          workflow_state: string;
        }>(
          `SELECT run.operational_state AS run_state,
                  workflow.operational_state AS workflow_state
             FROM workflow_graph_runs run
             JOIN workflows workflow ON workflow.id = run.workflow_id
            WHERE run.id = ?`,
          [row.graph_run_id],
        );
        if (
          converged?.run_state !== expectedState ||
          converged.workflow_state !== expectedState
        ) {
          throw new Error('Root compile failure state did not converge');
        }
      });
      return;
    }

    const fenceSchema = runtimeRef(stateConfig.fence_manifest_schema) ?? schema;
    const mapSchema =
      runtimeRef(stateConfig.map_item_results_manifest_schema) ?? fenceSchema;
    if (
      row.owner_scope_row_version === null ||
      row.owner_node_row_version === null
    ) {
      throw new Error(`Dynamic build ${row.build_id} has no owner authority`);
    }
    this.store.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id: detailValue.id,
        content: detail,
        contentHash: detailValue.hash,
        schemaResourceId: schema.rowId,
        schemaResourceHash: schema.hash,
        provenanceRef: `runtime-service:${row.build_id}:compile-failure`,
        retentionClass: 'workflow_audit',
        ownerGraphRunId: row.graph_run_id,
        createdAtMs: nowMs,
      });
    });
    recordDynamicBuildFailureT2a(this.store, {
      graphRunId: row.graph_run_id,
      buildId: row.build_id,
      expectedBuildRowVersion: row.build_row_version,
      expectedRunRowVersion: row.run_row_version,
      expectedOwnerScopeRowVersion: row.owner_scope_row_version,
      expectedOwnerNodeRowVersion: row.owner_node_row_version,
      expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
      expectedOwnerScopeWorkFenceEpoch: row.owner_scope_work_fence_epoch,
      errorCode,
      errorDetail: detailValue,
      fenceManifestSchema: fenceSchema,
      mapItemResultsManifestSchema: mapSchema,
      nowMs,
    });
  }

  private materialize(
    limit: number,
    nowMs: number,
  ): WorkflowRuntimeAdvanceResult {
    const rootRows = this.store.queryAll<{
      build_id: string;
      graph_run_id: string;
      root_scope_id: string;
      build_row_version: number;
      run_row_version: number;
      scope_row_version: number;
      work_fence_epoch: number;
      compiled_plan_id: string;
      compiled_plan_json: string;
      input_snapshot_value_id: string;
      input_snapshot_hash: Sha256Hash;
    }>(
      `SELECT b.id AS build_id, b.graph_run_id, r.root_scope_id,
              b.row_version AS build_row_version, r.row_version AS run_row_version,
              s.row_version AS scope_row_version, r.work_fence_epoch,
              b.compiled_plan_id, p.compiled_plan_json,
              s.input_snapshot_value_id, s.input_snapshot_hash
         FROM workflow_graph_scope_builds b
         JOIN workflow_graph_runs r ON r.id = b.graph_run_id
         JOIN workflow_graph_scopes s
           ON s.graph_run_id = r.id AND s.id = r.root_scope_id
         JOIN workflow_graph_scope_plans p
           ON p.graph_run_id = b.graph_run_id AND p.id = b.compiled_plan_id
        WHERE b.status = 'compiled' AND b.scope_kind = 'root'
          AND s.lifecycle = 'materializing'
        ORDER BY b.updated_at_ms, b.id COLLATE BINARY LIMIT ?`,
      [limit + 1],
    );
    let processed = 0;
    for (const row of rootRows.slice(0, limit)) {
      materializeRootScopeT2b(this.store, {
        graphRunId: row.graph_run_id,
        buildId: row.build_id,
        rootScopeId: row.root_scope_id,
        expectedBuildRowVersion: row.build_row_version,
        expectedRunRowVersion: row.run_row_version,
        expectedScopeRowVersion: row.scope_row_version,
        expectedRunWorkFenceEpoch: row.work_fence_epoch,
        planId: row.compiled_plan_id,
        plan: JSON.parse(row.compiled_plan_json) as CompiledScopePlanV2Document,
        inputSnapshot: {
          id: row.input_snapshot_value_id,
          hash: row.input_snapshot_hash,
        },
        nowMs,
      });
      processed += 1;
    }
    if (processed < limit) {
      const remaining = limit - processed;
      const dynamicRows = this.store.queryAll<{
        build_id: string;
        graph_run_id: string;
        build_row_version: number;
        run_row_version: number;
        owner_scope_row_version: number;
        owner_node_row_version: number;
        run_work_fence_epoch: number;
        owner_scope_work_fence_epoch: number;
      }>(
        `SELECT b.id AS build_id, b.graph_run_id,
                b.row_version AS build_row_version,
                r.row_version AS run_row_version,
                s.row_version AS owner_scope_row_version,
                n.row_version AS owner_node_row_version,
                r.work_fence_epoch AS run_work_fence_epoch,
                s.work_fence_epoch AS owner_scope_work_fence_epoch
           FROM workflow_graph_scope_builds b
           JOIN workflow_graph_runs r ON r.id = b.graph_run_id
           JOIN workflow_graph_scopes s
             ON s.graph_run_id = b.graph_run_id AND s.id = b.owner_scope_id
           JOIN workflow_graph_nodes n
             ON n.graph_run_id = b.graph_run_id AND n.scope_id = b.owner_scope_id
            AND n.id = b.owner_node_id
          WHERE b.status = 'compiled' AND b.scope_kind <> 'root'
            AND r.control = 'running' AND r.operational_state = 'healthy'
            AND s.lifecycle = 'active' AND n.phase = 'active'
          ORDER BY b.updated_at_ms, b.id COLLATE BINARY LIMIT ?`,
        [remaining + 1],
      );
      for (const row of dynamicRows.slice(0, remaining)) {
        materializeDynamicScopeT2b(this.store, {
          graphRunId: row.graph_run_id,
          buildId: row.build_id,
          expectedBuildRowVersion: row.build_row_version,
          expectedRunRowVersion: row.run_row_version,
          expectedOwnerScopeRowVersion: row.owner_scope_row_version,
          expectedOwnerNodeRowVersion: row.owner_node_row_version,
          expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
          expectedOwnerScopeWorkFenceEpoch: row.owner_scope_work_fence_epoch,
          nowMs,
        });
        processed += 1;
      }
      return {
        processed,
        has_more: rootRows.length > limit || dynamicRows.length > remaining,
      };
    }
    return {
      processed,
      has_more: rootRows.length > limit,
    };
  }

  private reconcile(
    limit: number,
    nowMs: number,
  ): WorkflowRuntimeAdvanceResult {
    const initializationRows = this.store.queryAll<{
      graph_run_id: string;
      scope_id: string;
      run_row_version: number;
      state_config_json: string;
    }>(
      `SELECT r.id AS graph_run_id, s.id AS scope_id,
              r.row_version AS run_row_version,
              value.inline_canonical_json AS state_config_json
         FROM workflow_graph_runs r
         JOIN workflow_graph_scopes s ON s.graph_run_id = r.id
         JOIN workflow_values value ON value.id = r.state_config_value_id
        WHERE r.lifecycle = 'executing' AND r.control = 'running'
          AND r.operational_state = 'healthy' AND s.lifecycle = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_graph_facts f
             WHERE f.graph_run_id = r.id AND f.scope_id = s.id
          )
        ORDER BY r.updated_at_ms, r.id COLLATE BINARY, s.id COLLATE BINARY
        LIMIT ?`,
      [limit + 1],
    );
    let processed = 0;
    for (const row of initializationRows.slice(0, limit)) {
      const currentRun = this.store.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [row.graph_run_id],
      );
      if (!currentRun) continue;
      const state = parseObject(row.state_config_json);
      const manifestSchema =
        runtimeRef(state.manifest_schema) ?? this.firstResource('schema');
      if (!manifestSchema) continue;
      initializeScopeFixedPointT3a(this.store, {
        graphRunId: row.graph_run_id,
        scopeId: row.scope_id,
        expectedRunRowVersion: currentRun.row_version,
        manifestSchema,
        nowMs,
      });
      processed += 1;
    }
    let evaluatingHasMore = false;
    if (processed < limit) {
      const remaining = limit - processed;
      const evaluatingRows = this.store.queryAll<{
        attempt_id: string;
        graph_run_id: string;
        scope_id: string;
        node_id: string;
        attempt_row_version: number;
        run_work_fence_epoch: number;
        scope_work_fence_epoch: number;
        lease_owner: string | null;
        lease_token: string | null;
        result_value_id: string;
        result_hash: Sha256Hash;
        result_json: string;
      }>(
        `SELECT attempt.id AS attempt_id, attempt.graph_run_id,
                attempt.scope_id, attempt.node_id,
                attempt.row_version AS attempt_row_version,
                attempt.run_work_fence_epoch, attempt.scope_work_fence_epoch,
                attempt.lease_owner, attempt.lease_token,
                attempt.result_value_id, attempt.result_hash,
                result.inline_canonical_json AS result_json
           FROM workflow_graph_node_attempts attempt
           JOIN workflow_graph_nodes node
             ON node.graph_run_id = attempt.graph_run_id
            AND node.scope_id = attempt.scope_id AND node.id = attempt.node_id
           JOIN workflow_graph_runs run ON run.id = attempt.graph_run_id
           JOIN workflow_graph_scopes scope
             ON scope.graph_run_id = attempt.graph_run_id
            AND scope.id = attempt.scope_id
           JOIN workflow_values result ON result.id = attempt.result_value_id
          WHERE attempt.phase = 'evaluating'
            AND attempt.acceptance_state = 'open'
            AND attempt.result_value_id IS NOT NULL
            AND attempt.result_hash IS NOT NULL
            AND node.node_type = 'delegation'
            AND result.storage_kind = 'inline' AND result.payload_state = 'live'
            AND result.content_hash = attempt.result_hash
            AND json_extract(result.inline_canonical_json, '$.format') =
                'icarus.workflow-agent-result/1'
            AND run.lifecycle = 'executing' AND run.control = 'running'
            AND run.operational_state = 'healthy' AND scope.lifecycle = 'active'
          ORDER BY attempt.updated_at_ms, attempt.id COLLATE BINARY LIMIT ?`,
        [remaining + 1],
      );
      evaluatingHasMore = evaluatingRows.length > remaining;
      for (const row of evaluatingRows.slice(0, remaining)) {
        const result = parseObject(row.result_json);
        const outcome = String(result.outcome);
        const error = object(result.error);
        const succeeded =
          result.format === 'icarus.workflow-agent-result/1' &&
          outcome === 'success';
        const cancelled = outcome === 'cancelled';
        const executionOutcome = succeeded
          ? 'succeeded'
          : cancelled
            ? 'cancelled'
            : 'failed';
        const resultRef = {
          id: row.result_value_id,
          hash: row.result_hash,
        };
        acceptInternalResultT6a(this.store, {
          graphRunId: row.graph_run_id,
          scopeId: row.scope_id,
          nodeId: row.node_id,
          attemptId: row.attempt_id,
          expectedAttemptRowVersion: row.attempt_row_version,
          leaseOwner: row.lease_owner,
          leaseToken: row.lease_token,
          expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
          expectedScopeWorkFenceEpoch: row.scope_work_fence_epoch,
          executionOutcome,
          qualityDecision: succeeded ? 'pass' : null,
          result: resultRef,
          outputPorts: succeeded ? { result: resultRef } : null,
          evaluation: null,
          feedback: null,
          errorCode:
            succeeded || cancelled
              ? null
              : typeof error?.code === 'string'
                ? error.code
                : outcome === 'blocked'
                  ? 'workflow_agent_blocked'
                  : result.format === 'icarus.workflow-agent-result/1'
                    ? 'workflow_agent_failed'
                    : 'workflow_agent_result_invalid',
          factPayload: resultRef,
          nowMs,
        });
        processed += 1;
      }
    }
    if (processed < limit) {
      const remaining = limit - processed;
      const terminalRows = this.store.queryAll<{
        graph_run_id: string;
        scope_id: string;
        node_id: string;
        terminal_status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
        payload_value_id: string;
        payload_hash: Sha256Hash;
        run_row_version: number;
        state_config_json: string;
      }>(
        `SELECT n.graph_run_id, n.scope_id, n.id AS node_id,
                n.terminal_status,
                coalesce(n.published_output_envelope_value_id,
                         attempt_fact.payload_value_id,
                         wait_fact.payload_value_id) AS payload_value_id,
                coalesce(n.published_output_envelope_hash,
                         attempt_fact.payload_hash,
                         wait_fact.payload_hash) AS payload_hash,
                r.row_version AS run_row_version,
                state_value.inline_canonical_json AS state_config_json
           FROM workflow_graph_nodes n
           JOIN workflow_graph_runs r ON r.id = n.graph_run_id
           JOIN workflow_values state_value ON state_value.id = r.state_config_value_id
      LEFT JOIN workflow_graph_facts attempt_fact
             ON attempt_fact.graph_run_id = n.graph_run_id
            AND attempt_fact.fact_key = 'attempt-result:' || n.current_attempt_id
      LEFT JOIN workflow_graph_facts wait_fact
             ON wait_fact.graph_run_id = n.graph_run_id
            AND wait_fact.fact_key = 'wait-winner:' || n.active_wait_id
          WHERE n.phase = 'terminal' AND n.terminal_status IS NOT NULL
            AND r.operational_state = 'healthy'
            AND coalesce(n.published_output_envelope_value_id,
                         attempt_fact.payload_value_id,
                         wait_fact.payload_value_id) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM workflow_graph_facts reconciled
               WHERE reconciled.graph_run_id = n.graph_run_id
                 AND reconciled.fact_key = 'runtime-service:node-terminal:' || n.id
            )
          ORDER BY n.terminal_at_ms, n.id COLLATE BINARY LIMIT ?`,
        [remaining + 1],
      );
      for (const row of terminalRows.slice(0, remaining)) {
        const current = this.store.queryOne<{
          row_version: number;
          scope_lifecycle: string;
        }>(
          `SELECT r.row_version, s.lifecycle AS scope_lifecycle
             FROM workflow_graph_runs r
             JOIN workflow_graph_scopes s
               ON s.graph_run_id = r.id AND s.id = ?
            WHERE r.id = ?`,
          [row.scope_id, row.graph_run_id],
        );
        if (!current || current.scope_lifecycle !== 'active') continue;
        const state = parseObject(row.state_config_json);
        const manifestSchema =
          runtimeRef(state.manifest_schema) ?? this.firstResource('schema');
        if (!manifestSchema) continue;
        reconcileFactT3a(this.store, {
          graphRunId: row.graph_run_id,
          scopeId: row.scope_id,
          expectedRunRowVersion: current.row_version,
          factKind: 'node_terminal',
          stableObjectKind: 'node',
          stableObjectId: row.node_id,
          factKey: `runtime-service:node-terminal:${row.node_id}`,
          payload: { id: row.payload_value_id, hash: row.payload_hash },
          manifestSchema,
          terminalStatus: row.terminal_status,
          nowMs,
        });
        processed += 1;
      }
      return {
        processed,
        has_more:
          initializationRows.length > limit ||
          evaluatingHasMore ||
          terminalRows.length > remaining,
      };
    }
    return {
      processed,
      has_more:
        processed >= limit ||
        initializationRows.length > limit ||
        evaluatingHasMore,
    };
  }

  private schedule(limit: number, nowMs: number): WorkflowRuntimeAdvanceResult {
    const rows = this.store.queryAll<{
      graph_run_id: string;
      scope_id: string;
      node_id: string;
      node_type: string;
      node_row_version: number;
      run_work_fence_epoch: number;
      scope_work_fence_epoch: number;
      activation_event_seq: number;
    }>(
      `SELECT n.graph_run_id, n.scope_id, n.id AS node_id, n.node_type,
              n.row_version AS node_row_version,
              r.work_fence_epoch AS run_work_fence_epoch,
              s.work_fence_epoch AS scope_work_fence_epoch,
              n.activation_event_seq
         FROM workflow_graph_nodes n
         JOIN workflow_graph_runs r ON r.id = n.graph_run_id
         JOIN workflow_graph_scopes s
           ON s.graph_run_id = n.graph_run_id AND s.id = n.scope_id
        WHERE n.phase = 'ready' AND n.activation_event_seq IS NOT NULL
          AND r.lifecycle = 'executing' AND r.control = 'running'
          AND r.operational_state = 'healthy' AND s.lifecycle = 'active'
        ORDER BY n.activation_event_seq, n.id COLLATE BINARY LIMIT ?`,
      [limit + 1],
    );
    const capacity = this.capacityPublication();
    let processed = 0;
    for (const row of rows.slice(0, limit)) {
      const kind = ['delegation', 'system'].includes(row.node_type)
        ? 'execution'
        : row.node_type === 'wait'
          ? 'wait'
          : ['join', 'terminal'].includes(row.node_type)
            ? 'structural'
            : 'child_owner';
      const receipt = scheduleReadyNodeT4(
        this.store,
        { current: () => capacity },
        {
          graphRunId: row.graph_run_id,
          scopeId: row.scope_id,
          nodeId: row.node_id,
          expectedNodeRowVersion: row.node_row_version,
          expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
          expectedScopeWorkFenceEpoch: row.scope_work_fence_epoch,
          eligibleEventSeq: row.activation_event_seq,
          activation: { kind },
          nowMs,
        },
      );
      if (receipt.disposition !== 'backpressure') processed += 1;
    }
    if (processed >= limit) {
      return { processed, has_more: true };
    }
    let remaining = limit - processed;
    const preparing = this.store.queryAll<{
      attempt_id: string;
      graph_run_id: string;
      scope_id: string;
      node_id: string;
      attempt_row_version: number;
      run_work_fence_epoch: number;
      scope_work_fence_epoch: number;
      context_pack_value_id: string;
      context_pack_hash: Sha256Hash;
      normalized_node_json: string;
      state_config_json: string;
    }>(
      `SELECT attempt.id AS attempt_id, attempt.graph_run_id,
              attempt.scope_id, attempt.node_id,
              attempt.row_version AS attempt_row_version,
              attempt.run_work_fence_epoch, attempt.scope_work_fence_epoch,
              attempt.context_pack_value_id, attempt.context_pack_hash,
              node.normalized_node_json,
              state_value.inline_canonical_json AS state_config_json
         FROM workflow_graph_node_attempts attempt
         JOIN workflow_graph_nodes node
           ON node.graph_run_id = attempt.graph_run_id
          AND node.scope_id = attempt.scope_id AND node.id = attempt.node_id
         JOIN workflow_graph_runs run ON run.id = attempt.graph_run_id
         JOIN workflow_graph_scopes scope
           ON scope.graph_run_id = attempt.graph_run_id
          AND scope.id = attempt.scope_id
         JOIN workflow_values state_value ON state_value.id = run.state_config_value_id
        WHERE attempt.phase = 'preparing'
          AND attempt.acceptance_state = 'open'
          AND attempt.context_pack_value_id IS NOT NULL
          AND attempt.context_pack_hash IS NOT NULL
          AND node.node_type = 'delegation'
          AND json_array_length(
                json_extract(node.normalized_node_json,
                             '$.capability_binding.required_claims')) = 0
          AND run.lifecycle = 'executing' AND run.control = 'running'
          AND run.operational_state = 'healthy' AND scope.lifecycle = 'active'
        ORDER BY attempt.updated_at_ms, attempt.id COLLATE BINARY LIMIT ?`,
      [remaining + 1],
    );
    const preparingHasMore = preparing.length > remaining;
    for (const row of preparing.slice(0, remaining)) {
      const node = parseObject(row.normalized_node_json);
      const state = parseObject(row.state_config_json);
      const policySnapshotSchema =
        runtimeRef(state.manifest_schema) ?? this.firstResource('schema');
      const effectiveLimits = object(node.effective_limits);
      const outboxBinding = object(node.outbox_execution_binding);
      const policySnapshot = object(outboxBinding?.effective_policy_snapshot);
      const effectivePolicy = object(policySnapshot?.effective_policy);
      if (!policySnapshotSchema || !effectiveLimits || !effectivePolicy) {
        throw new Error(
          `Capability dispatch authority is incomplete: ${row.attempt_id}`,
        );
      }
      prepareCapabilityDispatchT5(this.store, {
        graphRunId: row.graph_run_id,
        scopeId: row.scope_id,
        nodeId: row.node_id,
        attemptId: row.attempt_id,
        expectedAttemptRowVersion: row.attempt_row_version,
        expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
        expectedScopeWorkFenceEpoch: row.scope_work_fence_epoch,
        request: {
          id: row.context_pack_value_id,
          hash: row.context_pack_hash,
        },
        policySnapshotSchema,
        operationKey: `runtime-service:${row.attempt_id}:capability-dispatch`,
        requiredClaims: [],
        dispatchDeadlineAtMs: finiteDeadline(
          nowMs,
          Number(effectiveLimits.timeout_ms),
        ),
        outboxDeadlineAtMs: finiteDeadline(
          nowMs,
          Number(effectivePolicy.delivery_duration_ms),
        ),
        nowMs,
      });
      processed += 1;
    }
    if (processed >= limit) {
      return {
        processed,
        has_more: true,
      };
    }
    remaining = limit - processed;
    const owners = this.store.queryAll<{
      graph_run_id: string;
      scope_id: string;
      node_id: string;
      node_type: 'subgraph' | 'expand' | 'map';
      normalized_node_json: string;
      input_snapshot_json: string | null;
      input_snapshot_value_id: string | null;
      input_snapshot_hash: Sha256Hash | null;
      run_row_version: number;
      scope_row_version: number;
      node_row_version: number;
      run_work_fence_epoch: number;
      scope_work_fence_epoch: number;
      compiler_snapshot_hash: Sha256Hash;
      plan_json: string;
      state_config_json: string;
    }>(
      `SELECT n.graph_run_id, n.scope_id, n.id AS node_id, n.node_type,
              n.normalized_node_json, n.input_snapshot_json,
              n.input_snapshot_value_id, n.input_snapshot_hash,
              r.row_version AS run_row_version,
              s.row_version AS scope_row_version,
              n.row_version AS node_row_version,
              r.work_fence_epoch AS run_work_fence_epoch,
              s.work_fence_epoch AS scope_work_fence_epoch,
              b.compiler_snapshot_hash, plan.compiled_plan_json AS plan_json,
              state_value.inline_canonical_json AS state_config_json
         FROM workflow_graph_nodes n
         JOIN workflow_graph_runs r ON r.id = n.graph_run_id
         JOIN workflow_graph_scopes s
           ON s.graph_run_id = n.graph_run_id AND s.id = n.scope_id
         JOIN workflow_graph_scope_builds b
           ON b.graph_run_id = r.id AND b.id = r.root_build_id
         JOIN workflow_graph_scope_plans plan
           ON plan.graph_run_id = r.id AND plan.id = s.plan_id
         JOIN workflow_values state_value ON state_value.id = r.state_config_value_id
        WHERE n.phase = 'active' AND n.controller_state = 'sealing'
          AND n.node_type = 'expand'
          AND r.lifecycle = 'executing' AND r.control = 'running'
          AND r.operational_state = 'healthy' AND s.lifecycle = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_graph_expansion_manifests manifest
             WHERE manifest.graph_run_id = n.graph_run_id
               AND manifest.owner_node_id = n.id
          )
        ORDER BY n.updated_at_ms, n.id COLLATE BINARY LIMIT ?`,
      [remaining + 1],
    );
    for (const row of owners.slice(0, remaining)) {
      this.sealDynamicOwner(row, nowMs);
      processed += 1;
    }
    return {
      processed,
      has_more:
        rows.length > limit || preparingHasMore || owners.length > remaining,
    };
  }

  private sealDynamicOwner(
    row: {
      graph_run_id: string;
      scope_id: string;
      node_id: string;
      node_type: 'subgraph' | 'expand' | 'map';
      normalized_node_json: string;
      input_snapshot_json: string | null;
      input_snapshot_value_id: string | null;
      input_snapshot_hash: Sha256Hash | null;
      run_row_version: number;
      scope_row_version: number;
      node_row_version: number;
      run_work_fence_epoch: number;
      scope_work_fence_epoch: number;
      compiler_snapshot_hash: Sha256Hash;
      plan_json: string;
      state_config_json: string;
    },
    nowMs: number,
  ): void {
    const node = parseObject(row.normalized_node_json);
    const plan = parseObject(row.plan_json);
    const state = parseObject(row.state_config_json);
    const binding =
      object(state.temporary_confirmation) ?? object(state.personal_release);
    let source = object(binding?.source_json);
    if (!source && row.node_type === 'expand') {
      const edges = Array.isArray(plan.data_edges)
        ? (plan.data_edges as JsonObject[])
        : [];
      const literal = edges.find((candidate) => {
        const to = object(candidate.to);
        const from = object(candidate.from);
        return (
          to?.node_id === node.id &&
          to.port === node.graph_spec_input_port &&
          from?.type === 'literal'
        );
      });
      source = object(object(literal?.from)?.value);
    }
    if (!source) {
      throw new Error(`Dynamic owner ${row.node_id} has no exact child source`);
    }
    const sourceHash = domainSeparatedSha256(
      'icarus:workflow-graph-source:1\n',
      source,
    );
    if (
      binding &&
      typeof binding.source_hash === 'string' &&
      binding.source_hash !== sourceHash
    ) {
      throw new Error(`Dynamic owner ${row.node_id} source hash drifted`);
    }
    const schema =
      runtimeRef(state.manifest_schema) ?? this.firstResource('schema');
    const mapSchema =
      runtimeRef(state.map_item_results_manifest_schema) ?? schema;
    if (!schema || !mapSchema) {
      throw new Error('Dynamic owner has no manifest schema');
    }
    const sourceValue = {
      id: stableRuntimeId('value', {
        graph_run_id: row.graph_run_id,
        node_id: row.node_id,
        kind: 'dynamic-child-source',
        content_hash: sourceHash,
      }),
      hash: sourceHash,
    };
    const childInputContent: JsonObject = {};
    const childInputHash = runtimeObjectHash(
      'dynamic-child-input',
      childInputContent,
    );
    const childInput = {
      id: stableRuntimeId('value', {
        graph_run_id: row.graph_run_id,
        node_id: row.node_id,
        kind: 'dynamic-child-input',
        content_hash: childInputHash,
      }),
      hash: childInputHash,
    };
    this.store.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id: sourceValue.id,
        content: source,
        contentHash: sourceValue.hash,
        schemaResourceId: schema.rowId,
        schemaResourceHash: schema.hash,
        provenanceRef: `runtime-service:${row.node_id}:dynamic-source`,
        retentionClass: 'run_recovery',
        ownerGraphRunId: row.graph_run_id,
        createdAtMs: nowMs,
      });
      insertInlineValue(transaction, {
        id: childInput.id,
        content: childInputContent,
        contentHash: childInput.hash,
        schemaResourceId: schema.rowId,
        schemaResourceHash: schema.hash,
        provenanceRef: `runtime-service:${row.node_id}:dynamic-input`,
        retentionClass: 'run_recovery',
        ownerGraphRunId: row.graph_run_id,
        createdAtMs: nowMs,
      });
    });
    const completion =
      object(node[row.node_type === 'map' ? 'completion' : 'child_policy']) ??
      {};
    sealExpansionManifestT4(this.store, {
      graphRunId: row.graph_run_id,
      ownerScopeId: row.scope_id,
      ownerNodeId: row.node_id,
      expectedRunRowVersion: row.run_row_version,
      expectedOwnerScopeRowVersion: row.scope_row_version,
      expectedOwnerNodeRowVersion: row.node_row_version,
      expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
      expectedOwnerScopeWorkFenceEpoch: row.scope_work_fence_epoch,
      mode: row.node_type,
      sourceArtifact: sourceValue,
      manifest: {
        mode: row.node_type,
        source_hash: sourceHash,
        confirmation_hash:
          binding && typeof binding.plan_hash === 'string'
            ? binding.plan_hash
            : null,
      },
      manifestSchema: schema,
      ...(row.node_type === 'map'
        ? { mapItemResultsManifestSchema: mapSchema }
        : {}),
      childCompletionPolicy: completion,
      children: [
        {
          childKey: 'single',
          sourceSeedHash: sourceHash,
          sourceSnapshot: sourceValue,
          inputSnapshot: childInput,
          compilerSnapshotHash: row.compiler_snapshot_hash,
        },
      ],
      nowMs,
    });
  }

  private recover(limit: number, nowMs: number): WorkflowRuntimeAdvanceResult {
    const capacity = this.capacityPublication();
    const retries = this.store.queryAll<{
      id: string;
      row_version: number;
    }>(
      `SELECT id, row_version FROM workflow_graph_retry_schedules
        WHERE status = 'scheduled' AND eligible_at_ms <= ?
        ORDER BY eligible_at_ms, id COLLATE BINARY LIMIT ?`,
      [nowMs, limit + 1],
    );
    let processed = 0;
    for (const row of retries.slice(0, limit)) {
      consumeRetryScheduleT6d(
        this.store,
        { current: () => capacity },
        {
          retryScheduleId: row.id,
          expectedScheduleRowVersion: row.row_version,
          automaticTimer: true,
          nowMs,
        },
      );
      processed += 1;
    }
    if (processed >= limit) {
      return { processed, has_more: retries.length > limit };
    }
    const remaining = limit - processed;
    const attempts = this.store.queryAll<{
      id: string;
      row_version: number;
      payload_value_id: string;
      payload_hash: Sha256Hash;
    }>(
      `SELECT id, row_version, context_pack_value_id AS payload_value_id,
              context_pack_hash AS payload_hash
         FROM workflow_graph_node_attempts
        WHERE acceptance_state = 'open'
          AND phase IN ('dispatch_pending', 'running')
          AND ((phase = 'dispatch_pending' AND dispatch_deadline_at_ms <= ?)
            OR (phase = 'running' AND execution_deadline_at_ms <= ?))
        ORDER BY coalesce(dispatch_deadline_at_ms, execution_deadline_at_ms),
                 id COLLATE BINARY LIMIT ?`,
      [nowMs, nowMs, remaining + 1],
    );
    for (const row of attempts.slice(0, remaining)) {
      fireAttemptWatchdogT6d(this.store, {
        attemptId: row.id,
        automaticTimer: true,
        expectedAttemptRowVersion: row.row_version,
        factPayload: { id: row.payload_value_id, hash: row.payload_hash },
        nowMs,
      });
      processed += 1;
    }
    return {
      processed,
      has_more: retries.length > limit || attempts.length > remaining,
    };
  }

  private close(limit: number, nowMs: number): WorkflowRuntimeAdvanceResult {
    let processed = 0;
    const settled = this.store.queryAll<{
      graph_run_id: string;
      scope_id: string;
      run_row_version: number;
      scope_row_version: number;
      state_config_json: string;
    }>(
      `SELECT s.graph_run_id, s.id AS scope_id,
              r.row_version AS run_row_version,
              s.row_version AS scope_row_version,
              value.inline_canonical_json AS state_config_json
         FROM workflow_graph_scopes s
         JOIN workflow_graph_runs r ON r.id = s.graph_run_id
         JOIN workflow_values value ON value.id = r.state_config_value_id
        WHERE s.lifecycle = 'active' AND s.close_request_id IS NULL
          AND r.lifecycle = 'executing' AND r.control = 'running'
          AND r.operational_state = 'healthy'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_graph_nodes n
             WHERE n.graph_run_id = s.graph_run_id AND n.scope_id = s.id
               AND n.phase <> 'terminal'
          )
        ORDER BY s.depth DESC, s.updated_at_ms, s.id COLLATE BINARY LIMIT ?`,
      [limit + 1],
    );
    for (const row of settled.slice(0, limit)) {
      const state = parseObject(row.state_config_json);
      const manifestSchema =
        runtimeRef(state.manifest_schema) ?? this.firstResource('schema');
      if (!manifestSchema) continue;
      requestSettledCloseT3b(this.store, {
        graphRunId: row.graph_run_id,
        scopeId: row.scope_id,
        expectedRunRowVersion: row.run_row_version,
        expectedScopeRowVersion: row.scope_row_version,
        manifestSchema,
        nowMs,
      });
      processed += 1;
    }
    if (processed >= limit) {
      return { processed, has_more: settled.length > limit };
    }
    const childBudget = limit - processed;
    const children = this.store.queryAll<{
      graph_run_id: string;
      child_scope_id: string;
      child_row_version: number;
      parent_row_version: number;
      owner_row_version: number;
      run_work_fence_epoch: number;
      parent_work_fence_epoch: number;
      state_config_json: string;
    }>(
      `SELECT child.graph_run_id, child.id AS child_scope_id,
              child.row_version AS child_row_version,
              parent.row_version AS parent_row_version,
              owner.row_version AS owner_row_version,
              r.work_fence_epoch AS run_work_fence_epoch,
              parent.work_fence_epoch AS parent_work_fence_epoch,
              value.inline_canonical_json AS state_config_json
         FROM workflow_graph_scopes child
         JOIN workflow_graph_scopes parent
           ON parent.graph_run_id = child.graph_run_id
          AND parent.id = child.parent_scope_id
         JOIN workflow_graph_nodes owner
           ON owner.graph_run_id = child.graph_run_id
          AND owner.scope_id = parent.id AND owner.id = child.owner_node_id
         JOIN workflow_graph_runs r ON r.id = child.graph_run_id
         JOIN workflow_values value ON value.id = r.state_config_value_id
        WHERE child.parent_scope_id IS NOT NULL
          AND child.close_request_id IS NOT NULL
          AND child.completion_cut_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM workflow_graph_child_completion_consumptions c
             WHERE c.child_scope_id = child.id
          )
        ORDER BY child.depth DESC, child.updated_at_ms, child.id COLLATE BINARY
        LIMIT ?`,
      [childBudget + 1],
    );
    for (const row of children.slice(0, childBudget)) {
      const state = parseObject(row.state_config_json);
      const fence =
        runtimeRef(state.fence_manifest_schema) ?? this.firstResource('schema');
      const map = runtimeRef(state.map_item_results_manifest_schema) ?? fence;
      if (!fence || !map) continue;
      finalizeChildScopeT7b(this.store, {
        graphRunId: row.graph_run_id,
        childScopeId: row.child_scope_id,
        expectedChildScopeRowVersion: row.child_row_version,
        expectedParentScopeRowVersion: row.parent_row_version,
        expectedOwnerNodeRowVersion: row.owner_row_version,
        expectedRunWorkFenceEpoch: row.run_work_fence_epoch,
        expectedParentScopeWorkFenceEpoch: row.parent_work_fence_epoch,
        fenceManifestSchema: fence,
        mapItemResultsManifestSchema: map,
        nowMs,
      });
      processed += 1;
    }
    if (processed >= limit) {
      return {
        processed,
        has_more: settled.length > limit || children.length > childBudget,
      };
    }
    const rootBudget = limit - processed;
    const roots = this.store.queryAll<{
      workflow_id: string;
      activation_id: string;
      graph_run_id: string;
      root_scope_id: string;
      close_request_id: string;
      workflow_row_version: number;
      activation_row_version: number;
      run_row_version: number;
      root_row_version: number;
      definition_row_id: string;
      definition_resource_type: string;
      definition_id: string;
      definition_version: string;
      definition_hash: Sha256Hash;
      definition_json: string;
      state_key: string;
      state_config_value_id: string;
      state_config_hash: Sha256Hash;
      close_reason: string;
      close_error_code: string | null;
      close_error_detail_value_id: string | null;
      close_error_detail_hash: Sha256Hash | null;
      close_cancel_json: string | null;
    }>(
      `SELECT w.id AS workflow_id, a.id AS activation_id,
              r.id AS graph_run_id, r.root_scope_id,
              r.root_close_request_id AS close_request_id,
              w.row_version AS workflow_row_version,
              a.row_version AS activation_row_version,
              r.row_version AS run_row_version,
              root.row_version AS root_row_version,
              definition.id AS definition_row_id,
              definition.resource_type AS definition_resource_type,
              definition.resource_id AS definition_id,
              definition.resource_version AS definition_version,
              definition.content_hash AS definition_hash,
              definition_value.inline_canonical_json AS definition_json,
              r.state_key, r.state_config_value_id, r.state_config_hash,
              close.reason AS close_reason, close.error_code AS close_error_code,
              close.error_detail_value_id AS close_error_detail_value_id,
              close.error_detail_hash AS close_error_detail_hash,
              close.cancel_payload_json AS close_cancel_json
         FROM workflow_graph_runs r
         JOIN workflows w ON w.id = r.workflow_id
         JOIN workflow_state_activations a ON a.id = r.state_instance_id
         JOIN workflow_graph_scopes root
           ON root.graph_run_id = r.id AND root.id = r.root_scope_id
         JOIN workflow_graph_scope_close_requests close
           ON close.id = r.root_close_request_id
         JOIN workflow_registry_resources definition
           ON definition.id = a.workflow_definition_resource_id
          AND definition.content_hash = a.workflow_definition_resource_hash
         JOIN workflow_values definition_value
           ON definition_value.id = definition.canonical_value_id
        WHERE r.root_close_request_id IS NOT NULL
          AND r.completion_cut_id IS NULL
          AND w.current_graph_run_id = r.id
        ORDER BY r.updated_at_ms, r.id COLLATE BINARY LIMIT ?`,
      [rootBudget + 1],
    );
    for (const row of roots.slice(0, rootBudget)) {
      if (!this.commitTerminalRoot(row, nowMs)) continue;
      processed += 1;
    }
    return {
      processed,
      has_more:
        settled.length > limit ||
        children.length > childBudget ||
        roots.length > rootBudget,
    };
  }

  private commitTerminalRoot(
    row: {
      workflow_id: string;
      activation_id: string;
      graph_run_id: string;
      root_scope_id: string;
      close_request_id: string;
      workflow_row_version: number;
      activation_row_version: number;
      run_row_version: number;
      root_row_version: number;
      definition_row_id: string;
      definition_resource_type: string;
      definition_id: string;
      definition_version: string;
      definition_hash: Sha256Hash;
      definition_json: string;
      state_key: string;
      state_config_value_id: string;
      state_config_hash: Sha256Hash;
      close_reason: string;
      close_error_code: string | null;
      close_error_detail_value_id: string | null;
      close_error_detail_hash: Sha256Hash | null;
      close_cancel_json: string | null;
    },
    nowMs: number,
  ): boolean {
    const definition = parseObject(row.definition_json);
    const states = object(definition.states);
    const sourceState = object(states?.[row.state_key]);
    if (!states || !sourceState) return false;
    const schema = this.firstResource('schema');
    if (!schema) return false;
    const temporaryReplan =
      row.close_reason === 'local_cancel'
        ? deriveTemporaryReplanTransitionAuthority(this.store, {
            workflowId: row.workflow_id,
            sourceActivationId: row.activation_id,
            sourceRunId: row.graph_run_id,
            rootScopeId: row.root_scope_id,
            closeRequestId: row.close_request_id,
            nowMs,
          })
        : null;
    let routeSource =
      row.close_reason === 'workflow_cancel'
        ? 'workflow_cancel'
        : temporaryReplan
          ? temporaryReplan.routeSource
          : row.close_reason === 'local_cancel'
            ? 'on_local_cancel'
            : 'on_error';
    let targetKey: string | null = null;
    if (row.close_reason === 'normal') {
      const close = this.store.queryOne<{ exit_name: string | null }>(
        `SELECT candidate.exit_name
           FROM workflow_graph_scope_close_requests request
      LEFT JOIN workflow_graph_terminal_candidates candidate
             ON candidate.id = request.candidate_id
          WHERE request.id = ?`,
        [row.close_request_id],
      );
      const routes = object(sourceState.exit_routes);
      const route = close?.exit_name ? object(routes?.[close.exit_name]) : null;
      targetKey = typeof route?.target === 'string' ? route.target : null;
      if (close?.exit_name) routeSource = `exit:${close.exit_name}`;
    } else if (routeSource === 'workflow_cancel') {
      commitRootT8(this.store, {
        workflowId: row.workflow_id,
        sourceActivationId: row.activation_id,
        sourceRunId: row.graph_run_id,
        rootScopeId: row.root_scope_id,
        closeRequestId: row.close_request_id,
        expectedWorkflowRowVersion: row.workflow_row_version,
        expectedSourceActivationRowVersion: row.activation_row_version,
        expectedSourceRunRowVersion: row.run_row_version,
        expectedRootScopeRowVersion: row.root_row_version,
        routeSource,
        target: { kind: 'global_cancel' },
        contextValueSchema: schema,
        requiredChildren: [],
        bestEffortOutbox: [],
        nowMs,
      });
      return true;
    } else if (temporaryReplan) {
      commitRootT8(this.store, {
        workflowId: row.workflow_id,
        sourceActivationId: row.activation_id,
        sourceRunId: row.graph_run_id,
        rootScopeId: row.root_scope_id,
        closeRequestId: row.close_request_id,
        expectedWorkflowRowVersion: row.workflow_row_version,
        expectedSourceActivationRowVersion: row.activation_row_version,
        expectedSourceRunRowVersion: row.run_row_version,
        expectedRootScopeRowVersion: row.root_row_version,
        routeSource: temporaryReplan.routeSource,
        target: temporaryReplan.target,
        contextValueSchema: schema,
        requiredChildren: [],
        bestEffortOutbox: [],
        nowMs,
      });
      return true;
    } else {
      const route = object(sourceState[routeSource]);
      targetKey = typeof route?.target === 'string' ? route.target : null;
    }
    if (!targetKey) return false;
    const targetState = object(states[targetKey]);
    if (!targetState || targetState.type !== 'terminal') return false;
    if (routeSource === 'exit:cancelled') {
      commitRootT8(this.store, {
        workflowId: row.workflow_id,
        sourceActivationId: row.activation_id,
        sourceRunId: row.graph_run_id,
        rootScopeId: row.root_scope_id,
        closeRequestId: row.close_request_id,
        expectedWorkflowRowVersion: row.workflow_row_version,
        expectedSourceActivationRowVersion: row.activation_row_version,
        expectedSourceRunRowVersion: row.run_row_version,
        expectedRootScopeRowVersion: row.root_row_version,
        routeSource,
        target: { kind: 'global_cancel' },
        contextValueSchema: schema,
        requiredChildren: [],
        bestEffortOutbox: [],
        nowMs,
      });
      return true;
    }
    const definitionRef: RuntimeRegistryRef = {
      rowId: row.definition_row_id,
      resourceType: row.definition_resource_type,
      ref: { id: row.definition_id, version: row.definition_version },
      hash: row.definition_hash,
    };
    const normal = targetState.terminal_kind === 'normal';
    const rootOutput = this.store.queryOne<{
      output_value_id: string | null;
      output_hash: Sha256Hash | null;
      output_schema_hash: Sha256Hash | null;
    }>(
      `SELECT candidate.output_snapshot_value_id AS output_value_id,
              candidate.output_snapshot_hash AS output_hash,
              coalesce(output.generated_schema_hash,
                       output.schema_resource_hash) AS output_schema_hash
         FROM workflow_graph_scope_close_requests request
    LEFT JOIN workflow_graph_terminal_candidates candidate
           ON candidate.id = request.candidate_id
    LEFT JOIN workflow_values output
           ON output.id = candidate.output_snapshot_value_id
          AND output.content_hash = candidate.output_snapshot_hash
        WHERE request.id = ?`,
      [row.close_request_id],
    );
    commitRootT8(this.store, {
      workflowId: row.workflow_id,
      sourceActivationId: row.activation_id,
      sourceRunId: row.graph_run_id,
      rootScopeId: row.root_scope_id,
      closeRequestId: row.close_request_id,
      expectedWorkflowRowVersion: row.workflow_row_version,
      expectedSourceActivationRowVersion: row.activation_row_version,
      expectedSourceRunRowVersion: row.run_row_version,
      expectedRootScopeRowVersion: row.root_row_version,
      routeSource,
      target: {
        kind: 'terminal',
        stateKey: targetKey,
        definition: definitionRef,
        definitionVersion: row.definition_version,
        stateConfig: {
          id: row.state_config_value_id,
          hash: row.state_config_hash,
        },
        terminalKind: normal ? 'normal' : 'errored',
        output:
          normal && rootOutput?.output_value_id && rootOutput.output_hash
            ? { id: rootOutput.output_value_id, hash: rootOutput.output_hash }
            : null,
        outputSchemaHash:
          normal && rootOutput?.output_value_id && rootOutput.output_hash
            ? rootOutput.output_schema_hash
            : null,
        errorCode: normal
          ? null
          : typeof targetState.error_code === 'string'
            ? targetState.error_code
            : row.close_error_code,
        errorDetail:
          !normal &&
          row.close_error_detail_value_id &&
          row.close_error_detail_hash
            ? {
                id: row.close_error_detail_value_id,
                hash: row.close_error_detail_hash,
              }
            : null,
      },
      contextValueSchema: schema,
      requiredChildren: [],
      bestEffortOutbox: [],
      nowMs,
    });
    return true;
  }

  private firstResource(resourceType: string): RuntimeRegistryRef | null {
    const row = this.store.queryOne<{
      id: string;
      resource_id: string;
      resource_version: string;
      content_hash: Sha256Hash;
    }>(
      `SELECT id, resource_id, resource_version, content_hash
         FROM workflow_registry_resources
        WHERE resource_type = ? AND publication_state = 'published'
        ORDER BY resource_id COLLATE BINARY, resource_version COLLATE BINARY
        LIMIT 1`,
      [resourceType],
    );
    return row
      ? {
          rowId: row.id,
          resourceType,
          ref: { id: row.resource_id, version: row.resource_version },
          hash: row.content_hash,
        }
      : null;
  }

  private capacityPublication() {
    const row = this.store.queryOne<{
      current_capacity_revision: number;
      current_change_id: string;
      current_publication_hash: Sha256Hash;
      proposed_capacity_json: string;
      previous_config_hash: Sha256Hash | null;
    }>(
      `SELECT h.current_capacity_revision, h.current_change_id,
              h.current_publication_hash, command.proposed_capacity_json,
              previous.proposed_config_hash AS previous_config_hash
         FROM runtime_capacity_head h
         JOIN runtime_capacity_admin_commands command
           ON command.assigned_capacity_revision = h.current_capacity_revision
          AND command.assigned_change_id = h.current_change_id
    LEFT JOIN runtime_capacity_admin_commands previous
           ON previous.assigned_capacity_revision = h.current_capacity_revision - 1
        WHERE h.singleton_key = 1`,
      [],
    );
    if (!row) return null;
    const publication = buildDeploymentCapacityPublication(
      row.current_capacity_revision,
      row.current_change_id,
      row.previous_config_hash,
      JSON.parse(
        row.proposed_capacity_json,
      ) as DeploymentRuntimeCapacitySnapshot,
    );
    return publication.publication_hash === row.current_publication_hash
      ? publication
      : null;
  }
}
