export {
  insertInlineValue,
  runtimeObjectHash,
  stableRuntimeId,
} from '../runtime/graph-store.js';
export { acceptDelegationCallbackT6b } from '../runtime/node-execution.js';
export {
  leaseOutboxWork,
  recordOutboxResult,
  type OutboxLease,
} from '../runtime/outbox.js';
export type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
export {
  createWorkflowT0 as createFiniteWorkflowRun,
  type T0CreationInput as FiniteWorkflowCreationInput,
  type T0CreationReceipt as FiniteWorkflowCreationReceipt,
} from '../creation/task-intake.js';

import {
  calculateCreationIntentHash,
  type T0CreationInput,
} from '../creation/task-intake.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';

export type FiniteWorkflowCreationTemplate = Omit<
  T0CreationInput,
  | 'requestId'
  | 'creationDomain'
  | 'creationKey'
  | 'source'
  | 'creationIntentHash'
  | 'nowMs'
  | 'initialActivation'
> & {
  readonly initialActivation: Omit<
    T0CreationInput['initialActivation'],
    'nowMs'
  >;
};

export interface FiniteWorkflowCreationRequest {
  readonly requestId: string;
  readonly creationDomain: string;
  readonly creationKey: string;
  readonly source: T0CreationInput['source'];
  readonly nowMs: number;
  readonly template: FiniteWorkflowCreationTemplate;
}

export function resolveFiniteWorkflowCreationInput(
  request: FiniteWorkflowCreationRequest,
): T0CreationInput {
  const input: T0CreationInput = {
    ...request.template,
    requestId: request.requestId,
    creationDomain: request.creationDomain,
    creationKey: request.creationKey,
    source: request.source,
    creationIntentHash: calculateCreationIntentHash({
      creationDomain: request.creationDomain,
      creationKey: request.creationKey,
      principalRef: request.template.principalRef,
      ownershipHash: request.template.ownershipHash,
      routingScope: request.template.routingScope,
      recipe: request.template.recipe,
      entryPoint: request.template.entryPoint,
      inputHash: request.template.input.hash,
      attachmentManifestHash: request.template.attachments.hash,
    }),
    initialActivation: {
      ...request.template.initialActivation,
      nowMs: request.nowMs,
    },
    nowMs: request.nowMs,
  };
  return input;
}

export interface FiniteWorkflowRunObservation {
  readonly state:
    | 'running'
    | 'waiting_approval'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  readonly workflowId: string;
  readonly graphRunId: string;
  readonly lifecycle: string;
  readonly control: string;
  readonly operationalState: string;
  readonly outcomeKind: string | null;
  readonly exitName: string | null;
  readonly outputHash: string | null;
  readonly output: unknown;
  readonly errorCode: string | null;
}

export function observeFiniteWorkflowRun(
  store: WorkflowRuntimeStore,
  graphRunId: string,
): FiniteWorkflowRunObservation | null {
  const row = store.queryOne<{
    workflow_id: string;
    lifecycle: string;
    control: string;
    operational_state: string;
    outcome_kind: string | null;
    exit_name: string | null;
    output_hash: string | null;
    error_code: string | null;
    inline_canonical_json: string | null;
  }>(
    `SELECT run.workflow_id, run.lifecycle, run.control,
            run.operational_state, run.outcome_kind, run.exit_name,
            run.output_hash, run.error_code, value.inline_canonical_json
       FROM workflow_graph_runs run
  LEFT JOIN workflow_values value ON value.id = run.output_value_id
      WHERE run.id = ?`,
    [graphRunId],
  );
  if (!row) return null;
  const state =
    row.lifecycle !== 'closed'
      ? row.operational_state === 'action_required'
        ? ('waiting_approval' as const)
        : ('running' as const)
      : row.outcome_kind === 'normal'
        ? ('succeeded' as const)
        : row.outcome_kind === 'cancelled'
          ? ('cancelled' as const)
          : ('failed' as const);
  return {
    state,
    workflowId: row.workflow_id,
    graphRunId,
    lifecycle: row.lifecycle,
    control: row.control,
    operationalState: row.operational_state,
    outcomeKind: row.outcome_kind,
    exitName: row.exit_name,
    outputHash: row.output_hash,
    output: row.inline_canonical_json
      ? (JSON.parse(row.inline_canonical_json) as unknown)
      : null,
    errorCode: row.error_code,
  };
}
