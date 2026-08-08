import crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ActionExecutorRegistry } from './executors/registry.js';
import type {
  ActionExecutor,
  ActionObservation,
  PreparedAction,
} from './executors/types.js';
import type { CollaborationProjectSpaceService } from './project-space-service.js';
import type {
  CollaborationActionExecutionV3,
  CollaborationExecutorBindingV3,
  CollaborationProjectSpaceGroupRecord,
  CollaborationProjectSpaceStore,
} from './project-space-store.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';
import {
  buildCollaborationEventV3,
  collaborationCanonicalHashV3,
} from './protocol/v3-reducer.js';
import type {
  ActionDefinitionV3,
  CollaborationTurnV3,
  WorkflowInstance,
} from './protocol/v3-schema.js';
import {
  collaborationActionSnapshotForTurn,
  CollaborationScheduler,
  deterministicCollaborationPollDelay,
} from './scheduler.js';

const hash = (value: string) => `sha256:${value.repeat(64)}`;
const NOW = 1_786_032_000_000;
const PROMPT = '# Prompt\n';
const PROMPT_HASH = `sha256:${crypto.createHash('sha256').update(PROMPT).digest('hex')}`;

function action(): ActionDefinitionV3 {
  return {
    format: 'icarus.collaboration-action/1',
    action_id: 'implement',
    name: 'Implement',
    owner_principal_id: 'principal_00000000-0000-4000-8000-000000000001',
    version: 1,
    kind: 'run_once',
    adapter: null,
    workflow_ref: null,
    prompt_ref:
      'workspace/principals/principal_00000000-0000-4000-8000-000000000001/automations/prompts/implement.md',
    prompt_hash: PROMPT_HASH,
    executor_policy: 'principal_selected',
    filesystem_access: 'workspace_write',
    result_schema: { ref: 'result@1', schema: null },
  };
}

function turn(state: CollaborationTurnV3['state']): CollaborationTurnV3 {
  const claimed = state !== 'pending';
  return {
    format: 'icarus.collaboration-turn/1',
    turn_id: 'turn_1',
    workflow_instance_id: 'instance_1',
    state_id: 'implementation',
    assignee_principal_id: 'principal_00000000-0000-4000-8000-000000000001',
    claimant_principal_id: claimed
      ? 'principal_00000000-0000-4000-8000-000000000001'
      : null,
    claimant_client_id: claimed ? 'client_alice' : null,
    executor_id: claimed ? 'executor_local' : null,
    attempt: 1,
    fencing_token: claimed ? hash('f') : null,
    execution_mode: 'automatic',
    state,
    action_ref:
      'workspace/principals/principal_00000000-0000-4000-8000-000000000001/automations/actions/implement.json',
    action_hash: collaborationCanonicalHashV3(action()),
    prompt_hash: PROMPT_HASH,
    input_hash: hash('i'),
    idempotency_key: hash('k'),
    incoming_handoff: null,
    incoming_handoff_hash: null,
    timeout_policy_snapshot: null,
    start_deadline_at: null,
    execution_deadline_at: null,
    deadline_snapshot_hash: hash('d'),
    created_at: '2026-08-06T12:00:00.000Z',
    started_at: claimed ? '2026-08-06T12:00:01.000Z' : null,
    completed_at: null,
    outcome: null,
    handoff: null,
    handoff_hash: null,
    executor_result: null,
    executor_result_hash: null,
    completion_hash: null,
    recovery_reason: null,
  };
}

function instance(): WorkflowInstance {
  return {
    format: 'icarus.collaboration-workflow-instance/1',
    instance_id: 'instance_1',
    definition_id: 'definition_1',
    definition_version: 1,
    definition_hash: hash('w'),
    scope: { type: 'group' },
    related_work_item_refs: [],
    participant_bindings: {},
    resolved_assignments: {
      implementation: 'principal_00000000-0000-4000-8000-000000000001',
    },
    work_item_status_mapping: {},
    lifecycle: 'running',
    business_state: 'implementation',
    active_turn_id: 'turn_1',
    last_completed_turn_id: null,
    last_handoff_hash: null,
    epoch: 1,
    revision: 1,
    created_by_principal_id: 'principal_00000000-0000-4000-8000-000000000001',
    created_at: '2026-08-06T12:00:00.000Z',
    updated_at: '2026-08-06T12:00:00.000Z',
  };
}

function binding(): CollaborationExecutorBindingV3 {
  return {
    groupId: 'group_test',
    instanceId: 'instance_1',
    stateId: 'implementation',
    principalId: 'principal_00000000-0000-4000-8000-000000000001',
    clientId: 'client_alice',
    actionHash: collaborationCanonicalHashV3(action()),
    promptHash: PROMPT_HASH,
    executorId: 'executor_local',
    executorKind: 'run_once',
    workspacePath: '/tmp/workspace',
    filesystemAccess: 'workspace_write',
    approvalPolicy: 'on-request',
    config: { agent_jid: 'web:main' },
    enabled: true,
    updatedAtMs: NOW,
  };
}

function actionExecution(
  executionRef: string | null = null,
): CollaborationActionExecutionV3 {
  return {
    executionId: 'execution_1',
    groupId: 'group_test',
    instanceId: 'instance_1',
    turnId: 'turn_1',
    epoch: 1,
    attempt: 1,
    claimantClientId: 'client_alice',
    fencingToken: hash('f'),
    operationKey: hash('k'),
    executorId: 'executor_local',
    executorKind: 'run_once',
    state: executionRef ? 'running' : 'dispatching',
    executionRef,
    providerMetadata: executionRef ? { provider: 'test' } : null,
    receipt: executionRef ? { accepted: true } : null,
    observation: null,
    recoveryRequiredReason: null,
    dispatchStartedAtMs: executionRef ? NOW : null,
    receiptRecordedAtMs: executionRef ? NOW : null,
    providerCompletedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function succeeded(): ActionObservation {
  const result = {
    format: 'icarus.collaboration-action-result/3' as const,
    outcome: 'done',
    summary: 'Implemented',
    instruction: '',
    markers: [],
    data: {},
    artifacts: [],
    error: null,
  };
  return {
    state: 'succeeded',
    executionRef: 'provider:1',
    providerMetadata: { provider: 'test' },
    result,
    resultHash: collaborationCanonicalHashV3(result),
  };
}

function actionRecord(
  selectedAction: ActionDefinitionV3,
  commitOrder = 1,
  commitHash = 'a'.repeat(40),
) {
  return {
    event: buildCollaborationEventV3({
      groupId: 'group_test',
      eventId: `evt_action_${commitOrder}`,
      aggregateType: 'workspace',
      aggregateId: selectedAction.owner_principal_id,
      aggregateRevision: commitOrder,
      previousEventHash: commitOrder === 1 ? null : hash('e'),
      eventType:
        selectedAction.version === 1 ? 'action_published' : 'action_revised',
      actor: {
        principal_id: selectedAction.owner_principal_id,
        client_id: 'client_alice',
        credential_id: 'credential_alice',
        executor_id: null,
      },
      occurredAt: '2026-08-06T12:00:00.000Z',
      payload: { action: selectedAction },
    }),
    commitHash,
    commitOrder,
  };
}

function harness(input: {
  initialState?: CollaborationTurnV3['state'];
  observation?: ActionObservation;
  acquired?: boolean;
  existingExecutionRef?: string | null;
  dispatchError?: Error;
  markDispatchAccepted?: boolean;
  observationAccepted?: boolean;
  groupMode?: 'observer' | 'member';
  projectionActions?: Record<string, ActionDefinitionV3>;
  eventRecords?: ReturnType<typeof actionRecord>[];
  promptByCommit?: Record<string, string>;
  turnOverrides?: Partial<CollaborationTurnV3>;
}) {
  let currentTurn = {
    ...turn(input.initialState ?? 'running'),
    ...input.turnOverrides,
  };
  const selectedInstance = instance();
  const selectedAction = action();
  const eventRecords = input.eventRecords ?? [actionRecord(selectedAction)];
  const projection = {
    turns: { turn_1: currentTurn },
    workflowInstances: { instance_1: selectedInstance },
    actions: input.projectionActions ?? {
      'principal_00000000-0000-4000-8000-000000000001:implement':
        selectedAction,
    },
    workflowDefinitions: {
      'definition_1@1': {
        machine: {
          states: {
            implementation: {
              label: 'Implementation',
              description: 'Implement the accepted scope.',
              terminal: false,
              transitions: [
                {
                  outcome: 'done',
                  label: 'Done',
                  target_state: 'complete',
                },
              ],
            },
            complete: {
              label: 'Complete',
              description: '',
              terminal: true,
              transitions: [],
            },
          },
        },
      },
    },
    aggregateHeads: {
      'workflow_instance:instance_1': { revision: 1 },
    },
  } as unknown as CollaborationProjectionV3;
  const group = {
    groupId: 'group_test',
    subscriptionMode: input.groupMode ?? 'member',
    localPrincipalId:
      input.groupMode === 'observer'
        ? null
        : 'principal_00000000-0000-4000-8000-000000000001',
    localClientId: input.groupMode === 'observer' ? null : 'client_alice',
    projection,
    nextSyncAtMs: 0,
  } as CollaborationProjectSpaceGroupRecord;
  let execution = actionExecution(input.existingExecutionRef ?? null);
  const order: string[] = [];
  const store = {
    listGroups: vi.fn(() => [group]),
    getGroup: vi.fn(() => group),
    acquireProcessLock: vi.fn(() => true),
    releaseProcessLock: vi.fn(),
    listEventRecords: vi.fn(() => eventRecords),
    findActionSnapshot: vi.fn((query) => {
      const snapshot = collaborationActionSnapshotForTurn(
        eventRecords,
        currentTurn,
      );
      return snapshot &&
        snapshot.action.owner_principal_id === query.ownerPrincipalId &&
        snapshot.action.action_id === query.actionId &&
        collaborationCanonicalHashV3(snapshot.action) === query.actionHash &&
        snapshot.action.prompt_hash === query.promptHash
        ? {
            action: snapshot.action,
            eventId: 'evt_action_snapshot',
            commitHash: snapshot.verifiedCommit,
            commitOrder: 1,
          }
        : null;
    }),
    getExecutorBinding: vi.fn(() => binding()),
    claimActionExecution: vi.fn(() => ({
      execution,
      acquired: input.acquired ?? true,
    })),
    markActionDispatchStarted: vi.fn(() => input.markDispatchAccepted ?? true),
    recordActionDispatchReceipt: vi.fn((receipt) => {
      order.push('receipt');
      execution = {
        ...execution,
        state: 'running',
        executionRef: receipt.executionRef,
        providerMetadata: receipt.providerMetadata,
        receipt: receipt.receipt,
      };
      return true;
    }),
    getActionExecution: vi.fn(() => execution),
    recordActionObservation: vi.fn(() => input.observationAccepted ?? true),
  } as unknown as CollaborationProjectSpaceStore;
  const groups = {
    sync: vi.fn(async () => ({ projection })),
    expireRecoveryRequests: vi.fn(async () => 0),
    observeDueTimeouts: vi.fn(),
    startTurn: vi.fn(async () => {
      currentTurn = turn('running');
      projection.turns.turn_1 = currentTurn;
      return group;
    }),
    readVerifiedFile: vi.fn(async (request) =>
      Buffer.from(
        input.promptByCommit?.[request.verifiedCommit ?? ''] ?? PROMPT,
      ),
    ),
    recordActionState: vi.fn(async (command) => {
      order.push('git-action-state');
      if (command.state === 'completed') {
        currentTurn = {
          ...currentTurn,
          state:
            currentTurn.execution_mode === 'assisted'
              ? 'awaiting_confirmation'
              : 'running',
          executor_result: command.result,
          executor_result_hash: command.resultHash,
        };
        projection.turns.turn_1 = currentTurn;
      }
      return group;
    }),
    completeTurn: vi.fn(async () => {
      order.push('complete-turn');
      return group;
    }),
    requestTurnRecovery: vi.fn(async () => {
      order.push('recovery');
      currentTurn = { ...currentTurn, state: 'recovery_required' };
      projection.turns.turn_1 = currentTurn;
      return group;
    }),
  } as unknown as CollaborationProjectSpaceService;
  const executor: ActionExecutor = {
    kind: 'run_once',
    prepare: vi.fn(async (request) => ({
      ...request,
      effectiveFilesystemAccess: 'workspace_write',
      turnId: request.turn.turn_id,
      attempt: request.turn.attempt,
      fencingToken: request.turn.fencing_token!,
    })),
    dispatch: vi.fn(async (_prepared: PreparedAction) => {
      if (input.dispatchError) throw input.dispatchError;
      return {
        executionRef: 'provider:1',
        providerMetadata: { provider: 'test' },
        receipt: { accepted: true },
      };
    }),
    observe: vi.fn(async () => input.observation ?? succeeded()),
    cancel: vi.fn(),
    recover: vi.fn(),
  };
  const registry = new ActionExecutorRegistry();
  registry.register(executor);
  const scheduler = new CollaborationScheduler(store, groups, registry, {
    ownerId: 'scheduler_test',
    now: () => NOW,
  });
  return { scheduler, store, groups, executor, order };
}

describe('Collaboration project-space v3 Scheduler', () => {
  it('uses deterministic bounded poll jitter', () => {
    expect(deterministicCollaborationPollDelay('group_a', 60_000)).toBe(
      deterministicCollaborationPollDelay('group_a', 60_000),
    );
    expect(
      deterministicCollaborationPollDelay('group_a', 60_000),
    ).toBeGreaterThanOrEqual(54_000);
    expect(
      deterministicCollaborationPollDelay('group_a', 60_000),
    ).toBeLessThanOrEqual(66_000);
  });

  it('resolves an Action snapshot by owner and hashes when another Principal uses the same id', async () => {
    const aliceAction = action();
    const bobAction = {
      ...action(),
      owner_principal_id: 'principal_00000000-0000-4000-8000-000000000002',
      prompt_ref:
        'workspace/principals/principal_00000000-0000-4000-8000-000000000002/automations/prompts/implement.md',
    };
    const selected = harness({
      projectionActions: {
        'principal_00000000-0000-4000-8000-000000000002:implement': bobAction,
        'principal_00000000-0000-4000-8000-000000000001:implement': aliceAction,
      },
      eventRecords: [actionRecord(aliceAction)],
    });

    await selected.scheduler.syncNow('group_test');

    expect(selected.executor.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          owner_principal_id: 'principal_00000000-0000-4000-8000-000000000001',
        }),
      }),
    );
  });

  it('executes the frozen Action and Prompt after the current Action is revised', async () => {
    const original = action();
    const revisedPrompt = '# Revised Prompt\n';
    const revised = {
      ...original,
      version: 2,
      name: 'Implement revised',
      prompt_hash: `sha256:${crypto.createHash('sha256').update(revisedPrompt).digest('hex')}`,
    };
    const originalCommit = 'a'.repeat(40);
    const revisedCommit = 'b'.repeat(40);
    const selected = harness({
      projectionActions: {
        'principal_00000000-0000-4000-8000-000000000001:implement': revised,
      },
      eventRecords: [
        actionRecord(revised, 2, revisedCommit),
        actionRecord(original, 1, originalCommit),
      ],
      promptByCommit: {
        [originalCommit]: PROMPT,
        [revisedCommit]: revisedPrompt,
      },
    });

    await selected.scheduler.syncNow('group_test');

    expect(selected.executor.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ version: 1 }),
        prompt: PROMPT,
      }),
    );
    expect(selected.groups.readVerifiedFile).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedCommit: originalCommit }),
    );
  });

  it('fails closed when no verified Action event matches the Turn hashes', async () => {
    const selected = harness({
      turnOverrides: { action_hash: hash('x') },
    });

    await selected.scheduler.syncNow('group_test');

    expect(selected.executor.dispatch).not.toHaveBeenCalled();
    expect(selected.groups.requestTurnRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/Action snapshot/i),
      }),
    );
  });

  it('keeps Observer synchronization read-only', async () => {
    const selected = harness({ groupMode: 'observer' });

    await selected.scheduler.syncNow('group_test');

    expect(selected.groups.sync).toHaveBeenCalledOnce();
    expect(selected.groups.observeDueTimeouts).not.toHaveBeenCalled();
    expect(selected.groups.startTurn).not.toHaveBeenCalled();
  });

  it('automatically claims a Principal-owned Turn and persists receipt before Git facts', async () => {
    const selected = harness({ initialState: 'pending' });
    await selected.scheduler.syncNow('group_test');

    expect(selected.groups.startTurn).toHaveBeenCalledWith({
      groupId: 'group_test',
      instanceId: 'instance_1',
      turnId: 'turn_1',
      expectedRevision: 1,
      executorId: 'executor_local',
    });
    expect(selected.executor.dispatch).toHaveBeenCalledOnce();
    expect(selected.order).toEqual([
      'receipt',
      'git-action-state',
      'git-action-state',
      'complete-turn',
    ]);
    expect(selected.groups.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'done' }),
    );
    expect(selected.groups.recordActionState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'completed',
        result: succeeded().result,
        resultHash: succeeded().resultHash,
      }),
    );
    expect(selected.store.releaseProcessLock).toHaveBeenCalledWith(
      'group_test',
      'scheduler_test',
    );
  });

  it('routes a corrupted persisted automatic Result to recovery without redispatch', async () => {
    const invalidResult = {
      ...succeeded().result!,
      artifacts: [{ name: 'external', ref: 'https://provider.example/output' }],
    };
    const selected = harness({
      acquired: false,
      existingExecutionRef: 'provider:1',
      turnOverrides: {
        executor_result: invalidResult,
        executor_result_hash: collaborationCanonicalHashV3(invalidResult),
      },
    });

    await selected.scheduler.syncNow('group_test');

    expect(selected.executor.dispatch).not.toHaveBeenCalled();
    expect(selected.executor.observe).not.toHaveBeenCalled();
    expect(selected.groups.completeTurn).not.toHaveBeenCalled();
    expect(selected.groups.requestTurnRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/persisted Executor Result/i),
      }),
    );
  });

  it('records an assisted result but leaves FSM completion to the claimant', async () => {
    const selected = harness({
      turnOverrides: { execution_mode: 'assisted' },
    });

    await selected.scheduler.syncNow('group_test');

    expect(selected.groups.recordActionState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'completed',
        result: succeeded().result,
        resultHash: succeeded().resultHash,
      }),
    );
    expect(selected.groups.completeTurn).not.toHaveBeenCalled();
  });

  it('never redispatches when dispatch began without a durable provider receipt', async () => {
    const selected = harness({
      acquired: false,
      existingExecutionRef: null,
    });
    await selected.scheduler.syncNow('group_test');

    expect(selected.executor.dispatch).not.toHaveBeenCalled();
    expect(selected.groups.requestTurnRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/without a durable provider receipt/),
      }),
    );
  });

  it('projects waiting input and approval without completing the Turn', async () => {
    for (const state of ['waiting_input', 'waiting_approval'] as const) {
      const selected = harness({
        acquired: false,
        existingExecutionRef: 'provider:1',
        observation: {
          state,
          executionRef: 'provider:1',
          providerMetadata: {},
          result: null,
          resultHash: null,
        },
      });
      await selected.scheduler.syncNow('group_test');
      expect(selected.groups.recordActionState).toHaveBeenCalledWith(
        expect.objectContaining({ state }),
      );
      expect(selected.groups.completeTurn).not.toHaveBeenCalled();
    }
  });

  it('routes technical executor failure to recovery, never to a business Outcome', async () => {
    const selected = harness({
      acquired: false,
      existingExecutionRef: 'provider:1',
      observation: {
        state: 'failed',
        executionRef: 'provider:1',
        providerMetadata: {},
        result: {
          format: 'icarus.collaboration-action-result/3',
          outcome: 'rejected',
          summary: 'Provider failed',
          instruction: '',
          markers: [],
          data: {},
          artifacts: [],
          error: {
            code: 'provider_failed',
            message: 'failed',
            retryable: true,
          },
        },
        resultHash: hash('x'),
      },
    });
    await selected.scheduler.syncNow('group_test');

    expect(selected.groups.requestTurnRecovery).toHaveBeenCalled();
    expect(selected.groups.completeTurn).not.toHaveBeenCalled();
  });

  it('fails closed on stale local dispatch and observation fencing callbacks', async () => {
    const staleDispatch = harness({ markDispatchAccepted: false });
    await staleDispatch.scheduler.syncNow('group_test');
    expect(staleDispatch.executor.dispatch).not.toHaveBeenCalled();
    expect(staleDispatch.groups.recordActionState).not.toHaveBeenCalled();

    const staleObservation = harness({
      acquired: false,
      existingExecutionRef: 'provider:1',
      observationAccepted: false,
    });
    await staleObservation.scheduler.syncNow('group_test');
    expect(staleObservation.groups.recordActionState).not.toHaveBeenCalled();
    expect(staleObservation.groups.completeTurn).not.toHaveBeenCalled();
    expect(staleObservation.groups.requestTurnRecovery).not.toHaveBeenCalled();
  });

  it('records dispatch uncertainty as recovery and does not retry automatically', async () => {
    const selected = harness({
      dispatchError: new Error('provider accepted but receipt channel closed'),
    });
    await selected.scheduler.syncNow('group_test');

    expect(selected.executor.dispatch).toHaveBeenCalledOnce();
    expect(selected.groups.requestTurnRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'provider accepted but receipt channel closed',
      }),
    );
    expect(selected.groups.completeTurn).not.toHaveBeenCalled();
  });
});
