import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  insertGraphEvent,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';

export interface OpenOperationalBlockerInput {
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
  readonly source:
    | { readonly kind: 'effect'; readonly id: string }
    | { readonly kind: 'outbox'; readonly id: string }
    | { readonly kind: 'root_finalization'; readonly id: string }
    | { readonly kind: 'claim'; readonly id: string }
    | { readonly kind: 'event'; readonly sequence: number };
  readonly errorCode: string;
  readonly evidenceManifest: RuntimeValueRef;
  readonly remediationPolicy: RuntimeRegistryRef;
  readonly nextRemediationAtMs: number | null;
  readonly remediationDeadlineAtMs: number;
  readonly nowMs: number;
}

export interface OperationalBlockerReceipt {
  readonly blockerId: string;
  readonly disposition: 'opened' | 'exact_replay';
  readonly operationalState: 'action_required' | 'quarantined';
}

export function openOperationalBlocker(
  store: WorkflowRuntimeStore,
  input: OpenOperationalBlockerInput,
  fault?: G5TransactionFault,
): OperationalBlockerReceipt {
  if (
    (input.blockerKind === 'integrity_quarantine') !==
      (input.severity === 'quarantine') ||
    !Number.isSafeInteger(input.remediationDeadlineAtMs) ||
    input.remediationDeadlineAtMs < input.nowMs ||
    (input.nextRemediationAtMs !== null &&
      (!Number.isSafeInteger(input.nextRemediationAtMs) ||
        input.nextRemediationAtMs < input.nowMs ||
        input.nextRemediationAtMs > input.remediationDeadlineAtMs))
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'Operational Blocker severity or finite remediation window is invalid',
    );
  const blockerId = stableRuntimeId('blocker', {
    graph_run_id: input.graphRunId,
    blocker_kind: input.blockerKind,
    source_kind: input.source.kind,
    source_identity:
      input.source.kind === 'event' ? input.source.sequence : input.source.id,
  });
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      assertExactPublishedRegistryResource(
        transaction,
        input.remediationPolicy,
        'Operational Blocker remediation policy',
      );
      const existing = transaction.queryOne<{
        id: string;
        workflow_id: string;
        graph_run_id: string;
        status: string;
        error_code: string;
        severity: string;
        source_effect_operation_id: string | null;
        source_outbox_id: string | null;
        source_root_finalization_schedule_id: string | null;
        source_claim_id: string | null;
        source_event_seq: number | null;
        evidence_manifest_value_id: string;
        evidence_manifest_hash: string;
        remediation_policy_resource_id: string;
        remediation_policy_resource_hash: string;
        next_remediation_at_ms: number | null;
        remediation_deadline_at_ms: number;
      }>(
        `SELECT id, workflow_id, graph_run_id, status, error_code, severity,
                source_effect_operation_id, source_outbox_id,
                source_root_finalization_schedule_id, source_claim_id,
                source_event_seq, evidence_manifest_value_id,
                evidence_manifest_hash, remediation_policy_resource_id,
                remediation_policy_resource_hash, next_remediation_at_ms,
                remediation_deadline_at_ms
           FROM workflow_operational_blockers WHERE id = ?`,
        [blockerId],
      );
      if (existing) {
        const expectedSources = {
          effect: input.source.kind === 'effect' ? input.source.id : null,
          outbox: input.source.kind === 'outbox' ? input.source.id : null,
          rootFinalization:
            input.source.kind === 'root_finalization' ? input.source.id : null,
          claim: input.source.kind === 'claim' ? input.source.id : null,
          event: input.source.kind === 'event' ? input.source.sequence : null,
        };
        if (
          existing.workflow_id !== input.workflowId ||
          existing.graph_run_id !== input.graphRunId ||
          existing.status !== 'open' ||
          existing.error_code !== input.errorCode ||
          existing.severity !== input.severity ||
          existing.source_effect_operation_id !== expectedSources.effect ||
          existing.source_outbox_id !== expectedSources.outbox ||
          existing.source_root_finalization_schedule_id !==
            expectedSources.rootFinalization ||
          existing.source_claim_id !== expectedSources.claim ||
          existing.source_event_seq !== expectedSources.event ||
          existing.evidence_manifest_value_id !== input.evidenceManifest.id ||
          existing.evidence_manifest_hash !== input.evidenceManifest.hash ||
          existing.remediation_policy_resource_id !==
            input.remediationPolicy.rowId ||
          existing.remediation_policy_resource_hash !==
            input.remediationPolicy.hash ||
          existing.next_remediation_at_ms !== input.nextRemediationAtMs ||
          existing.remediation_deadline_at_ms !== input.remediationDeadlineAtMs
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'Operational Blocker identity drift',
          );
        const cached = transaction.queryOne<{
          run_state: string;
          workflow_state: string;
          quarantine_count: number;
        }>(
          `SELECT r.operational_state AS run_state,
                  w.operational_state AS workflow_state,
                  (SELECT count(*) FROM workflow_operational_blockers b
                    WHERE b.graph_run_id = r.id AND b.status = 'open'
                      AND b.severity = 'quarantine') AS quarantine_count
             FROM workflow_graph_runs r
             JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
          [input.graphRunId],
        );
        const expectedState =
          cached && cached.quarantine_count > 0
            ? 'quarantined'
            : 'action_required';
        if (
          !cached ||
          cached.run_state !== expectedState ||
          cached.workflow_state !== expectedState
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'Operational Blocker replay has an invalid Run cache',
          );
        return {
          blockerId,
          disposition: 'exact_replay',
          operationalState: cached.run_state as
            | 'action_required'
            | 'quarantined',
        };
      }
      const run = transaction.queryOne<{
        workflow_id: string;
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT workflow_id, next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      if (!run || run.workflow_id !== input.workflowId)
        throw new G5RuntimeError(
          'precondition_failed',
          'Operational Blocker Run/Workflow binding is invalid',
        );
      const sequence = run.next_event_seq + 1;
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId: null,
        nodeId: null,
        attemptId: null,
        eventType: 'operational_blocker_changed',
        idempotencyKey: `blocker-open:${blockerId}`,
        payloadJson: {
          blocker_id: blockerId,
          status: 'open',
          severity: input.severity,
        },
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      transaction.execute(
        `INSERT INTO workflow_operational_blockers (
       id, workflow_id, graph_run_id, blocker_kind, severity,
       source_effect_operation_id, source_outbox_id,
       source_root_finalization_schedule_id, source_claim_id, source_event_seq,
       error_code, evidence_manifest_value_id, evidence_manifest_hash, status,
       remediation_policy_resource_id, remediation_policy_resource_hash,
       remediation_attempt_count, next_remediation_at_ms,
       remediation_deadline_at_ms, opened_event_seq, resolved_event_seq,
       resolution_command_id, resolution_value_id, resolution_hash, row_version,
       opened_at_ms, resolved_at_ms, abandoned_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?,
       NULL, NULL, NULL, NULL, 1, ?, NULL, NULL)`,
        [
          blockerId,
          input.workflowId,
          input.graphRunId,
          input.blockerKind,
          input.severity,
          input.source.kind === 'effect' ? input.source.id : null,
          input.source.kind === 'outbox' ? input.source.id : null,
          input.source.kind === 'root_finalization' ? input.source.id : null,
          input.source.kind === 'claim' ? input.source.id : null,
          input.source.kind === 'event' ? input.source.sequence : null,
          input.errorCode,
          input.evidenceManifest.id,
          input.evidenceManifest.hash,
          input.remediationPolicy.rowId,
          input.remediationPolicy.hash,
          input.nextRemediationAtMs,
          input.remediationDeadlineAtMs,
          sequence,
          input.nowMs,
        ],
      );
      const refreshed = transaction.queryOne<{
        row_version: number;
        operational_state: string;
      }>(
        'SELECT row_version, operational_state FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      if (
        transaction.execute(
          'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
          [sequence, input.nowMs, input.graphRunId, refreshed.row_version],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'Operational Blocker event head CAS failed',
        );
      const workflow = transaction.queryOne<{ operational_state: string }>(
        'SELECT operational_state FROM workflows WHERE id = ?',
        [input.workflowId],
      );
      if (
        !['action_required', 'quarantined'].includes(
          refreshed.operational_state,
        ) ||
        workflow?.operational_state !== refreshed.operational_state
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'Operational Blocker cache trigger did not converge',
        );
      return {
        blockerId,
        disposition: 'opened',
        operationalState: refreshed.operational_state as
          | 'action_required'
          | 'quarantined',
      };
    },
    fault,
  );
}

export function listOpenOperationalBlockers(
  store: Pick<WorkflowRuntimeStore, 'queryAll'>,
  graphRunId: string,
): ReadonlyArray<Record<string, unknown>> {
  return store.queryAll<Record<string, unknown>>(
    "SELECT * FROM workflow_operational_blockers WHERE graph_run_id = ? AND status = 'open' ORDER BY opened_event_seq, id COLLATE BINARY",
    [graphRunId],
  );
}
