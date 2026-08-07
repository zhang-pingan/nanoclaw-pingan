import crypto from 'node:crypto';

import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

import { canonicalJson } from '../workflow-runtime/contracts/hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import {
  acceptDelegationCallbackT6b,
  insertInlineValue,
  leaseOutboxWork,
  recordOutboxResult,
  runtimeObjectHash,
  stableRuntimeId,
  type OutboxLease,
  type WorkflowRuntimeStore,
} from '../workflow-runtime/gateway/execution.js';
import { WorkflowExecutionAdapterRegistry } from './adapter-registry.js';
import { WorkflowAdapterExecutionStore } from './execution-store.js';
import {
  parseWorkflowAgentDispatchRequest,
  workflowAgentResultSchema,
  type WorkflowAdapterCompletion,
  type WorkflowAdapterExecutionContext,
  type WorkflowAdapterExecutionRecord,
  type WorkflowAdapterRunHandle,
  type WorkflowAgentDispatchRequest,
  type WorkflowAgentResult,
} from './types.js';

interface DueOutboxRow extends Record<string, unknown> {
  id: string;
  deadline_at_ms: number;
  policy_snapshot_json: string;
}

interface DispatchRow extends Record<string, unknown> {
  outbox_id: string;
  adapter_resource_id: string;
  adapter_resource_hash: string;
  adapter_ref_id: string;
  adapter_ref_version: string;
  adapter_publication_state: string;
  request_value_id: string;
  request_hash: string;
  request_json: string;
  request_byte_length: number;
  effect_operation_id: string;
  operation_key: string;
  graph_run_id: string;
  scope_id: string;
  node_id: string;
  attempt_id: string;
  delegation_id: string | null;
  run_work_fence_epoch: number;
  scope_work_fence_epoch: number;
}

interface SchemaRow extends Record<string, unknown> {
  id: string;
  resource_id: string;
  resource_version: string;
  content_hash: string;
  publication_state: string;
  schema_json: string;
}

export interface WorkflowExecutionWorkerLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface WorkflowExecutionWorkerOptions {
  readonly runtimeStore: WorkflowRuntimeStore;
  readonly executionStore: WorkflowAdapterExecutionStore;
  readonly registry: WorkflowExecutionAdapterRegistry;
  readonly pollIntervalMs: number;
  readonly leaseOwner: string;
  readonly now?: () => number;
  readonly logger?: WorkflowExecutionWorkerLogger;
  readonly onRuntimeCommit?: (hint: {
    readonly workflowId: string;
    readonly graphRunId: string;
  }) => void;
}

const NOOP_LOGGER: WorkflowExecutionWorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function terminalFailure(
  record: WorkflowAdapterExecutionRecord,
  message: string,
  code: string,
): WorkflowAdapterCompletion {
  return {
    state: 'failed',
    result: {
      format: 'icarus.workflow-agent-result/1',
      outcome: 'failure',
      summary: message,
      provider: {
        adapter: record.adapterRefId,
        execution_id: record.executionId,
        metadata: record.providerMetadata,
      },
      artifacts: [],
      error: { code, message, retryable: true },
    },
  };
}

function policyAttemptTimeout(policySnapshotJson: string): number {
  const snapshot = JSON.parse(policySnapshotJson) as Record<string, unknown>;
  const policy = snapshot.effective_policy as
    | Record<string, unknown>
    | undefined;
  const timeout = policy?.attempt_timeout_ms;
  if (!Number.isSafeInteger(timeout) || Number(timeout) <= 0)
    throw new Error('Workflow Outbox policy has no valid attempt_timeout_ms');
  return Number(timeout);
}

function errorDetails(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}

export class WorkflowExecutionWorker {
  private readonly now: () => number;
  private readonly log: WorkflowExecutionWorkerLogger;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly handles = new Map<string, WorkflowAdapterRunHandle>();
  private interval: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: WorkflowExecutionWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? NOOP_LOGGER;
  }

  async start(): Promise<void> {
    if (this.interval) return;
    this.stopping = false;
    await this.recover();
    await this.tick();
    this.interval = setInterval(
      () => void this.tick(),
      this.options.pollIntervalMs,
    );
    this.interval.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.tickPromise) await this.tickPromise;
    await Promise.allSettled(
      [...this.handles.values()].map((handle) => handle.cancel()),
    );
    this.handles.clear();
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.tickInternal().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  private async tickInternal(): Promise<void> {
    await this.retryPendingCallbacks();
    const adapterIds = this.options.registry
      .list()
      .map((adapter) => adapter.refId);
    if (adapterIds.length === 0) return;
    const placeholders = adapterIds.map(() => '?').join(', ');
    const nowMs = this.now();
    const rows = this.options.runtimeStore.queryAll<DueOutboxRow>(
      `SELECT o.id, o.deadline_at_ms,
              policy.inline_canonical_json AS policy_snapshot_json
         FROM workflow_outbox o
         JOIN workflow_registry_resources adapter
           ON adapter.id = o.adapter_resource_id
          AND adapter.content_hash = o.adapter_resource_hash
         JOIN workflow_values policy ON policy.id = o.policy_snapshot_value_id
        WHERE o.status IN ('pending', 'reconciling')
          AND (o.next_attempt_at_ms IS NULL OR o.next_attempt_at_ms <= ?)
          AND (o.lease_expires_at_ms IS NULL OR o.lease_expires_at_ms <= ?)
          AND o.deadline_at_ms >= ?
          AND adapter.resource_id IN (${placeholders})
        ORDER BY o.created_at_ms, o.id
        LIMIT 16`,
      [nowMs, nowMs, nowMs, ...adapterIds],
    );
    for (const row of rows) {
      if (this.stopping) break;
      try {
        await this.dispatch(row);
      } catch (error) {
        this.log.error(
          { outboxId: row.id, ...errorDetails(error) },
          'Workflow execution Outbox dispatch failed',
        );
      }
    }
  }

  private async dispatch(row: DueOutboxRow): Promise<void> {
    const startedAtMs = this.now();
    const attemptTimeoutMs = policyAttemptTimeout(row.policy_snapshot_json);
    const lease = leaseOutboxWork(this.options.runtimeStore, {
      outboxId: row.id,
      leaseOwner: this.options.leaseOwner,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAtMs: Math.min(
        row.deadline_at_ms,
        startedAtMs + attemptTimeoutMs,
      ),
      nowMs: startedAtMs,
    });
    let loaded: ReturnType<WorkflowExecutionWorker['loadDispatch']>;
    let record: WorkflowAdapterExecutionRecord;
    try {
      loaded = this.loadDispatch(lease);
      record = this.options.executionStore.reserve({
        operationKey: loaded.operationKey,
        adapterRefId: loaded.adapterRefId,
        adapterResourceHash: lease.adapterResourceHash,
        requestHash: lease.request.hash,
        request: loaded.request,
        context: loaded.context,
        nowMs: startedAtMs,
      });
    } catch (error) {
      this.recordNotApplied(lease, startedAtMs);
      throw error;
    }
    const adapter = this.options.registry.resolve(loaded.adapterRefId);
    if (record.state === 'reserved') {
      let handle: WorkflowAdapterRunHandle;
      try {
        handle = await adapter.start(record.context, record.request);
      } catch (error) {
        this.recordNotApplied(lease, startedAtMs);
        throw error;
      }
      const accepted = this.options.executionStore.markAccepted(
        record.executionId,
        handle.providerMetadata,
        this.now(),
      );
      this.options.executionStore.markRunning(accepted.executionId, this.now());
      try {
        this.recordAcceptance(lease, accepted.executionId, startedAtMs);
      } catch (error) {
        this.recordReceiptLost(lease, accepted.executionId, startedAtMs);
        throw error;
      }
      this.monitor(accepted, handle);
      return;
    }

    let handle: WorkflowAdapterRunHandle | null = null;
    let recoveryFailure: WorkflowAdapterCompletion | null = null;
    if (!record.result) {
      try {
        handle = await adapter.recover(record);
      } catch (error) {
        recoveryFailure = terminalFailure(
          record,
          error instanceof Error ? error.message : String(error),
          'workflow_adapter_recovery_failed',
        );
      }
    }
    try {
      this.recordAcceptance(lease, record.executionId, startedAtMs);
    } catch (error) {
      this.recordReceiptLost(lease, record.executionId, startedAtMs);
      throw error;
    }
    if (record.result) {
      await this.deliverCallback(record);
      return;
    }
    if (recoveryFailure) {
      await this.finish(record.executionId, recoveryFailure);
      return;
    }
    this.options.executionStore.markRunning(record.executionId, this.now());
    this.monitor(record, handle!);
  }

  private loadDispatch(lease: OutboxLease): {
    readonly adapterRefId: string;
    readonly operationKey: string;
    readonly request: WorkflowAgentDispatchRequest;
    readonly context: Omit<WorkflowAdapterExecutionContext, 'executionId'>;
  } {
    const row = this.options.runtimeStore.queryOne<DispatchRow>(
      `SELECT o.id AS outbox_id, o.adapter_resource_id,
              o.adapter_resource_hash, adapter.resource_id AS adapter_ref_id,
              adapter.resource_version AS adapter_ref_version,
              adapter.publication_state AS adapter_publication_state,
              request.id AS request_value_id, request.content_hash AS request_hash,
              request.inline_canonical_json AS request_json,
              request.byte_length AS request_byte_length,
              effect.id AS effect_operation_id, effect.operation_key,
              effect.graph_run_id, effect.scope_id, effect.node_id,
              effect.attempt_id, attempt.delegation_id,
              attempt.run_work_fence_epoch, attempt.scope_work_fence_epoch
         FROM workflow_outbox o
         JOIN workflow_registry_resources adapter
           ON adapter.id = o.adapter_resource_id
         JOIN workflow_values request ON request.id = o.payload_value_id
         JOIN workflow_graph_effect_operations effect
           ON effect.id = o.effect_operation_id
         JOIN workflow_graph_node_attempts attempt
           ON attempt.id = effect.attempt_id
        WHERE o.id = ?`,
      [lease.outboxId],
    );
    if (
      !row ||
      row.outbox_id !== lease.outboxId ||
      row.adapter_resource_id !== lease.adapterResourceId ||
      row.adapter_resource_hash !== lease.adapterResourceHash ||
      row.adapter_publication_state !== 'published' ||
      row.request_value_id !== lease.request.id ||
      row.request_hash !== lease.request.hash ||
      row.delegation_id === null
    ) {
      throw new Error('Workflow execution dispatch identity is not exact');
    }
    const parsed = JSON.parse(row.request_json) as JsonValue;
    if (
      canonicalJson(parsed) !== row.request_json ||
      Buffer.byteLength(row.request_json, 'utf8') !== row.request_byte_length
    ) {
      throw new Error('Workflow execution request Value authority drifted');
    }
    const request = parseWorkflowAgentDispatchRequest(parsed);
    return {
      adapterRefId: row.adapter_ref_id,
      operationKey: row.operation_key,
      request,
      context: {
        operationKey: row.operation_key,
        requestHash: lease.request.hash,
        adapterResourceId: lease.adapterResourceId,
        adapterResourceHash: lease.adapterResourceHash,
        adapterRefId: row.adapter_ref_id,
        adapterRefVersion: row.adapter_ref_version,
        outboxId: lease.outboxId,
        outboxAttemptKind: lease.attemptKind,
        outboxHistorySequence: lease.historySequence,
        outboxKindAttemptNo: lease.kindAttemptNo,
        outboxPolicyHash: lease.policyHash,
        outboxMaxAttempts: lease.maxAttempts,
        outboxDeadlineAtMs: lease.deadlineAtMs,
        outboxLeaseOwner: lease.leaseOwner,
        outboxLeaseToken: lease.leaseToken,
        requestValueId: lease.request.id,
        effectOperationId: row.effect_operation_id,
        graphRunId: row.graph_run_id,
        scopeId: row.scope_id,
        nodeId: row.node_id,
        attemptId: row.attempt_id,
        delegationId: row.delegation_id,
        runWorkFenceEpoch: row.run_work_fence_epoch,
        scopeWorkFenceEpoch: row.scope_work_fence_epoch,
      },
    };
  }

  private recordAcceptance(
    lease: OutboxLease,
    executionId: string,
    startedAtMs: number,
  ): void {
    const finishedAtMs = this.now();
    // The frozen Runtime requires three immutable snapshots. Dispatch has only
    // accepted execution here, so the exact request Value is the stable receipt.
    recordOutboxResult(this.options.runtimeStore, lease, {
      resultKind: 'applied_with_receipt',
      resultCode: null,
      receipt: lease.request,
      afterState: lease.request,
      immutableOutput: lease.request,
      externalId: executionId,
      nextAttemptAtMs: null,
      attemptsExhausted: lease.kindAttemptNo >= lease.maxAttempts,
      startedAtMs,
      finishedAtMs,
    });
    this.notifyRuntimeCommitForOutbox(lease.outboxId);
  }

  private recordNotApplied(lease: OutboxLease, startedAtMs: number): void {
    const finishedAtMs = this.now();
    const exhausted = lease.kindAttemptNo >= lease.maxAttempts;
    recordOutboxResult(this.options.runtimeStore, lease, {
      resultKind: 'not_applied',
      resultCode: 'workflow_adapter_start_failed',
      receipt: null,
      afterState: null,
      immutableOutput: null,
      externalId: null,
      nextAttemptAtMs: exhausted
        ? null
        : Math.min(
            lease.deadlineAtMs,
            finishedAtMs + this.options.pollIntervalMs,
          ),
      attemptsExhausted: exhausted,
      startedAtMs,
      finishedAtMs,
    });
    this.notifyRuntimeCommitForOutbox(lease.outboxId);
  }

  private recordReceiptLost(
    lease: OutboxLease,
    executionId: string,
    startedAtMs: number,
  ): void {
    const status = this.options.runtimeStore.queryOne<{ status: string }>(
      'SELECT status FROM workflow_outbox WHERE id = ?',
      [lease.outboxId],
    )?.status;
    if (status !== 'processing') return;
    const finishedAtMs = this.now();
    const exhausted = lease.kindAttemptNo >= lease.maxAttempts;
    recordOutboxResult(this.options.runtimeStore, lease, {
      resultKind: 'applied_but_receipt_lost',
      resultCode: 'workflow_adapter_receipt_lost',
      receipt: null,
      afterState: null,
      immutableOutput: null,
      externalId: executionId,
      nextAttemptAtMs: exhausted
        ? null
        : Math.min(
            lease.deadlineAtMs,
            finishedAtMs + this.options.pollIntervalMs,
          ),
      attemptsExhausted: exhausted,
      startedAtMs,
      finishedAtMs,
    });
    this.notifyRuntimeCommitForOutbox(lease.outboxId);
  }

  private monitor(
    record: WorkflowAdapterExecutionRecord,
    handle: WorkflowAdapterRunHandle,
  ): void {
    this.handles.set(record.executionId, handle);
    void handle.completion
      .then((completion) => this.finish(record.executionId, completion))
      .catch((error) =>
        this.finish(
          record.executionId,
          terminalFailure(
            record,
            error instanceof Error ? error.message : String(error),
            'workflow_adapter_completion_failed',
          ),
        ),
      )
      .catch((error) => {
        this.log.error(
          { executionId: record.executionId, ...errorDetails(error) },
          'Workflow execution completion delivery failed',
        );
      })
      .finally(() => this.handles.delete(record.executionId));
  }

  private async finish(
    executionId: string,
    completion: WorkflowAdapterCompletion,
  ): Promise<void> {
    const result = workflowAgentResultSchema.parse(completion.result);
    const record = this.options.executionStore.markTerminal(
      executionId,
      completion.state,
      result,
      result.error?.code ?? null,
      this.now(),
    );
    await this.deliverCallback(record);
  }

  private async recover(): Promise<void> {
    for (const record of this.options.executionStore.listRecoverable()) {
      if (record.state === 'reserved') continue;
      try {
        this.restoreOutboxAcceptance(record);
        const adapter = this.options.registry.resolve(record.adapterRefId);
        const handle = await adapter.recover(record);
        if (record.state !== 'running')
          this.options.executionStore.markRunning(
            record.executionId,
            this.now(),
          );
        this.monitor(record, handle);
      } catch (error) {
        await this.finish(
          record.executionId,
          terminalFailure(
            record,
            error instanceof Error ? error.message : String(error),
            'workflow_adapter_recovery_failed',
          ),
        );
      }
    }
    await this.retryPendingCallbacks();
  }

  private restoreOutboxAcceptance(
    record: WorkflowAdapterExecutionRecord,
  ): void {
    const outbox = this.options.runtimeStore.queryOne<{
      status: string;
      lease_owner: string | null;
      lease_token: string | null;
    }>(
      'SELECT status, lease_owner, lease_token FROM workflow_outbox WHERE id = ?',
      [record.context.outboxId],
    );
    if (!outbox || outbox.status === 'succeeded') return;
    if (
      outbox.status !== 'processing' ||
      outbox.lease_owner !== record.context.outboxLeaseOwner ||
      outbox.lease_token !== record.context.outboxLeaseToken
    ) {
      return;
    }
    const lease: OutboxLease = {
      outboxId: record.context.outboxId,
      attemptKind: record.context.outboxAttemptKind,
      historySequence: record.context.outboxHistorySequence,
      kindAttemptNo: record.context.outboxKindAttemptNo,
      adapterResourceId: record.context.adapterResourceId,
      adapterResourceHash: record.context.adapterResourceHash as Sha256Hash,
      policyHash: record.context.outboxPolicyHash as Sha256Hash,
      maxAttempts: record.context.outboxMaxAttempts,
      attemptTimeoutMs: 0,
      deadlineAtMs: record.context.outboxDeadlineAtMs,
      request: {
        id: record.context.requestValueId,
        hash: record.context.requestHash as Sha256Hash,
      },
      leaseOwner: record.context.outboxLeaseOwner,
      leaseToken: record.context.outboxLeaseToken,
    };
    this.recordAcceptance(lease, record.executionId, record.createdAtMs);
  }

  private async retryPendingCallbacks(): Promise<void> {
    for (const record of this.options.executionStore.listPendingCallbacks()) {
      try {
        await this.deliverCallback(record);
      } catch (error) {
        this.log.error(
          { executionId: record.executionId, ...errorDetails(error) },
          'Workflow execution callback retry failed',
        );
      }
    }
  }

  private async deliverCallback(
    record: WorkflowAdapterExecutionRecord,
  ): Promise<void> {
    if (record.callbackDeliveredAtMs !== null || !record.result) return;
    const resultRef = this.persistResultValue(record, record.result);
    const disposition = acceptDelegationCallbackT6b(this.options.runtimeStore, {
      graphRunId: record.context.graphRunId,
      scopeId: record.context.scopeId,
      nodeId: record.context.nodeId,
      attemptId: record.context.attemptId,
      delegationId: record.context.delegationId,
      externalExecutionId: record.executionId,
      providerEventId: `workflow-adapter:${record.executionId}:${record.state}`,
      result: resultRef,
      expectedRunWorkFenceEpoch: record.context.runWorkFenceEpoch,
      expectedScopeWorkFenceEpoch: record.context.scopeWorkFenceEpoch,
      nowMs: this.now(),
    });
    this.options.onRuntimeCommit?.({
      workflowId: this.workflowIdForRun(record.context.graphRunId),
      graphRunId: record.context.graphRunId,
    });
    this.options.executionStore.markCallbackDelivered(
      record.executionId,
      this.now(),
    );
    this.log.info(
      { executionId: record.executionId, disposition },
      'Workflow execution callback delivered',
    );
  }

  private workflowIdForRun(graphRunId: string): string {
    const row = this.options.runtimeStore.queryOne<{ workflow_id: string }>(
      'SELECT workflow_id FROM workflow_graph_runs WHERE id = ?',
      [graphRunId],
    );
    if (!row) throw new Error(`Workflow Run is missing: ${graphRunId}`);
    return row.workflow_id;
  }

  private notifyRuntimeCommitForOutbox(outboxId: string): void {
    if (!this.options.onRuntimeCommit) return;
    const row = this.options.runtimeStore.queryOne<{
      workflow_id: string | null;
      graph_run_id: string | null;
    }>(
      `SELECT o.workflow_id, attempt.graph_run_id
         FROM workflow_outbox o
         LEFT JOIN workflow_graph_node_attempts attempt ON attempt.id = o.attempt_id
        WHERE o.id = ?`,
      [outboxId],
    );
    if (!row?.graph_run_id) return;
    this.options.onRuntimeCommit({
      workflowId: row.workflow_id ?? this.workflowIdForRun(row.graph_run_id),
      graphRunId: row.graph_run_id,
    });
  }

  private persistResultValue(
    record: WorkflowAdapterExecutionRecord,
    result: WorkflowAgentResult,
  ): { readonly id: string; readonly hash: Sha256Hash } {
    const schema = this.loadResultSchema(record.request);
    let validate = this.validators.get(schema.content_hash);
    if (!validate) {
      const ajv = new Ajv2020({
        strict: true,
        allErrors: true,
        validateFormats: false,
      });
      validate = ajv.compile(JSON.parse(schema.schema_json) as AnySchema);
      this.validators.set(schema.content_hash, validate);
    }
    if (!validate(result)) {
      throw new Error(
        `Workflow Adapter result does not match ${schema.resource_id}@${schema.resource_version}: ${JSON.stringify(validate.errors)}`,
      );
    }
    const content = result as unknown as JsonObject;
    const identity: JsonObject = {
      execution_id: record.executionId,
      result: content,
    };
    const value = {
      id: stableRuntimeId('workflow-adapter-result', identity),
      hash: runtimeObjectHash('workflow-adapter-result', identity),
    };
    this.options.runtimeStore.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id: value.id,
        content,
        contentHash: value.hash,
        schemaResourceId: schema.id,
        schemaResourceHash: schema.content_hash as Sha256Hash,
        provenanceRef: 'icarus.workflow-adapter/1',
        retentionClass: 'run_recovery',
        createdAtMs: this.now(),
        ownerGraphRunId: record.context.graphRunId,
      });
    });
    return value;
  }

  private loadResultSchema(request: WorkflowAgentDispatchRequest): SchemaRow {
    const schema = this.options.runtimeStore.queryOne<SchemaRow>(
      `SELECT resource.id, resource.resource_id, resource.resource_version,
              resource.content_hash, resource.publication_state,
              value.inline_canonical_json AS schema_json
         FROM workflow_registry_resources resource
         JOIN workflow_values value ON value.id = resource.canonical_value_id
        WHERE resource.resource_type = 'schema'
          AND resource.resource_id = ? AND resource.resource_version = ?
          AND resource.content_hash = ?`,
      [
        request.result_schema.id,
        request.result_schema.version,
        request.result_schema.content_hash,
      ],
    );
    if (!schema || schema.publication_state !== 'published')
      throw new Error(
        `Workflow Adapter result Schema is not exactly Published: ${request.result_schema.id}@${request.result_schema.version}`,
      );
    const parsed = JSON.parse(schema.schema_json) as JsonValue;
    if (canonicalJson(parsed) !== schema.schema_json)
      throw new Error('Workflow Adapter result Schema authority drifted');
    return schema;
  }
}
