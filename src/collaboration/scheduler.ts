import crypto from 'node:crypto';

import type { ActionExecutorRegistry } from './executors/registry.js';
import type { ActionObservation } from './executors/types.js';
import type { CollaborationProjectSpaceService } from './project-space-service.js';
import type {
  CollaborationActionExecutionV3,
  CollaborationProjectSpaceEventRecord,
  CollaborationProjectSpaceGroupRecord,
  CollaborationProjectSpaceStore,
} from './project-space-store.js';
export { deterministicCollaborationPollDelay } from './project-space-store.js';
import {
  actionDefinitionV3Schema,
  type ActionDefinitionV3,
  type CollaborationTurnV3,
} from './protocol/v3-schema.js';
import type { CollaborationEventV3 } from './protocol/v3-schema.js';
import { collaborationCanonicalHashV3 } from './protocol/v3-reducer.js';

export interface CollaborationSchedulerOptions {
  readonly ownerId?: string;
  readonly now?: () => number;
  readonly tickIntervalMs?: number;
  readonly lockStaleAfterMs?: number;
}

export interface CollaborationSchedulerDiagnostic {
  readonly running: boolean;
  readonly quiescing: boolean;
  readonly ownerId: string;
  readonly activeGroups: number;
  readonly inFlight: number;
  readonly lastTickAtMs: number | null;
  readonly lastError: string | null;
}

interface CollaborationActionSnapshot {
  readonly action: ActionDefinitionV3;
  readonly verifiedCommit: string;
}

function actionFromEvent(
  event: CollaborationEventV3,
): ActionDefinitionV3 | null {
  if (
    event.event_type !== 'action_published' &&
    event.event_type !== 'action_revised'
  )
    return null;
  const parsed = actionDefinitionV3Schema.safeParse(event.payload.action);
  return parsed.success ? parsed.data : null;
}

export function collaborationActionSnapshotForTurn(
  records: readonly CollaborationProjectSpaceEventRecord[],
  turn: CollaborationTurnV3,
): CollaborationActionSnapshot | null {
  if (!turn.action_ref || !turn.action_hash || !turn.prompt_hash) return null;
  for (const record of records) {
    const action = actionFromEvent(record.event);
    if (!action) continue;
    const expectedActionRef = `workspace/principals/${action.owner_principal_id}/automations/actions/${action.action_id}.json`;
    if (
      action.owner_principal_id !== turn.assignee_principal_id ||
      record.event.aggregate_type !== 'workspace' ||
      record.event.aggregate_id !== action.owner_principal_id ||
      record.event.actor.principal_id !== action.owner_principal_id ||
      action.prompt_ref.startsWith(
        `workspace/principals/${action.owner_principal_id}/automations/prompts/`,
      ) === false ||
      turn.action_ref !== expectedActionRef ||
      collaborationCanonicalHashV3(action) !== turn.action_hash ||
      action.prompt_hash !== turn.prompt_hash
    )
      continue;
    return { action, verifiedCommit: record.commitHash };
  }
  return null;
}

export class CollaborationScheduler {
  private readonly ownerId: string;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly lockStaleAfterMs: number;
  private timer: NodeJS.Timeout | null = null;
  private quiescing = false;
  private readonly inFlight = new Set<Promise<void>>();
  private lastTickAtMs: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: CollaborationProjectSpaceStore,
    private readonly groups: CollaborationProjectSpaceService,
    private readonly executors: ActionExecutorRegistry,
    options: CollaborationSchedulerOptions = {},
  ) {
    this.ownerId = options.ownerId ?? `scheduler_${crypto.randomUUID()}`;
    this.now = options.now ?? Date.now;
    this.tickIntervalMs = options.tickIntervalMs ?? 1_000;
    this.lockStaleAfterMs = options.lockStaleAfterMs ?? 120_000;
  }

  start(): void {
    if (this.timer) return;
    this.quiescing = false;
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.quiescing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.inFlight]);
  }

  diagnostics(): CollaborationSchedulerDiagnostic {
    return {
      running: this.timer !== null,
      quiescing: this.quiescing,
      ownerId: this.ownerId,
      activeGroups: this.store.listGroups().length,
      inFlight: this.inFlight.size,
      lastTickAtMs: this.lastTickAtMs,
      lastError: this.lastError,
    };
  }

  async tick(): Promise<void> {
    if (this.quiescing) return;
    this.lastTickAtMs = this.now();
    await Promise.all(
      this.store.listGroups().map(async (group) => {
        if (group.nextSyncAtMs > this.now()) return;
        try {
          await this.syncNow(group.groupId);
        } catch (error) {
          this.lastError =
            error instanceof Error ? error.message : String(error);
        }
      }),
    );
  }

  async syncNow(groupId: string): Promise<void> {
    if (this.quiescing) throw new Error('Collaboration Scheduler is quiescing');
    if (
      !this.store.acquireProcessLock({
        groupId,
        ownerId: this.ownerId,
        nowMs: this.now(),
        staleAfterMs: this.lockStaleAfterMs,
      })
    )
      return;
    const work = this.driveGroup(groupId).finally(() => {
      this.store.releaseProcessLock(groupId, this.ownerId);
    });
    this.inFlight.add(work);
    try {
      await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  private async driveGroup(groupId: string): Promise<void> {
    const history = await this.groups.sync(groupId);
    const group = this.store.getGroup(groupId);
    if (
      !group ||
      group.subscriptionMode !== 'member' ||
      !group.localPrincipalId ||
      !group.localClientId
    )
      return;
    await this.groups.observeDueTimeouts(groupId);
    for (const turn of Object.values(history.projection.turns)) {
      if (
        turn.assignee_principal_id !== group.localPrincipalId ||
        ['completed', 'cancelled', 'recovery_required'].includes(turn.state)
      )
        continue;
      if (turn.state === 'pending') {
        if (turn.execution_mode !== 'automatic') continue;
        const binding = this.bindingForTurn(group, turn);
        if (!binding) continue;
        const instance =
          history.projection.workflowInstances[turn.workflow_instance_id];
        if (!instance) continue;
        const revision =
          history.projection.aggregateHeads[
            `workflow_instance:${instance.instance_id}`
          ]!.revision;
        await this.groups.startTurn({
          groupId,
          instanceId: instance.instance_id,
          turnId: turn.turn_id,
          expectedRevision: revision,
          executorId: binding.executorId,
        });
      }
      const latest =
        this.store.getGroup(groupId)?.projection?.turns[turn.turn_id];
      if (
        latest &&
        ['running', 'waiting_input', 'waiting_approval'].includes(
          latest.state,
        ) &&
        latest.claimant_client_id === group.localClientId &&
        latest.execution_mode !== 'manual'
      )
        await this.driveAction(groupId, latest);
    }
  }

  private bindingForTurn(
    group: CollaborationProjectSpaceGroupRecord,
    turn: CollaborationTurnV3,
  ) {
    if (
      !group.localPrincipalId ||
      !group.localClientId ||
      !turn.action_hash ||
      !turn.prompt_hash
    )
      return null;
    return this.store.getExecutorBinding({
      groupId: group.groupId,
      instanceId: turn.workflow_instance_id,
      stateId: turn.state_id,
      principalId: group.localPrincipalId,
      clientId: group.localClientId,
      actionHash: turn.action_hash,
      promptHash: turn.prompt_hash,
    });
  }

  private async driveAction(
    groupId: string,
    turn: CollaborationTurnV3,
  ): Promise<void> {
    const group = this.store.getGroup(groupId);
    const instance =
      group?.projection?.workflowInstances[turn.workflow_instance_id];
    const binding = group ? this.bindingForTurn(group, turn) : null;
    if (
      !group ||
      !instance ||
      !binding?.enabled ||
      !turn.fencing_token ||
      !group.localClientId
    )
      return;
    const snapshot = collaborationActionSnapshotForTurn(
      this.store.listEventRecords(groupId, 5_000),
      turn,
    );
    if (!snapshot) {
      await this.requestRecovery(
        groupId,
        turn,
        'Verified Action snapshot does not match the Turn owner and hashes',
      );
      return;
    }
    let prompt: string;
    try {
      const bytes = await this.groups.readVerifiedFile({
        groupId,
        repositoryFile: snapshot.action.prompt_ref,
        verifiedCommit: snapshot.verifiedCommit,
      });
      const promptHash = `sha256:${crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex')}`;
      if (promptHash !== turn.prompt_hash)
        throw new Error('Verified Prompt bytes do not match the Turn hash');
      prompt = bytes.toString('utf8');
    } catch (error) {
      await this.requestRecovery(
        groupId,
        turn,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const action = snapshot.action;
    const executor = this.executors.resolve(action);
    const claim = this.store.claimActionExecution({
      groupId,
      instanceId: instance.instance_id,
      turnId: turn.turn_id,
      epoch: instance.epoch,
      attempt: turn.attempt,
      claimantClientId: group.localClientId,
      fencingToken: turn.fencing_token,
      operationKey: turn.idempotency_key,
      executorId: binding.executorId,
      executorKind: binding.executorKind,
      nowMs: this.now(),
    });
    let execution = claim.execution;
    if (claim.acquired) {
      try {
        const prepared = await executor.prepare({
          executionId: execution.executionId,
          operationKey: execution.operationKey,
          groupId,
          instanceId: instance.instance_id,
          turn,
          epoch: instance.epoch,
          action,
          prompt,
          binding,
        });
        if (
          !this.store.markActionDispatchStarted(
            execution.executionId,
            group.localClientId,
            turn.fencing_token,
            this.now(),
          )
        )
          return;
        const receipt = await executor.dispatch(prepared);
        if (
          !this.store.recordActionDispatchReceipt({
            executionId: execution.executionId,
            claimantClientId: group.localClientId,
            fencingToken: turn.fencing_token,
            executionRef: receipt.executionRef,
            providerMetadata: receipt.providerMetadata,
            receipt: receipt.receipt,
            nowMs: this.now(),
          })
        )
          return;
        const revision = await this.currentInstanceRevision(
          groupId,
          instance.instance_id,
        );
        await this.groups.recordActionState({
          groupId,
          instanceId: instance.instance_id,
          turnId: turn.turn_id,
          expectedRevision: revision,
          attempt: turn.attempt,
          fencingToken: turn.fencing_token,
          state: 'dispatched',
          executionRef: receipt.executionRef,
          executorId: binding.executorId,
        });
        execution = this.store.getActionExecution({
          groupId,
          turnId: turn.turn_id,
          attempt: turn.attempt,
        })!;
      } catch (error) {
        await this.failClosedAfterDispatch(groupId, turn, execution, error);
        return;
      }
    }
    if (!execution.executionRef) {
      await this.failClosedAfterDispatch(
        groupId,
        turn,
        execution,
        new Error('Dispatch started without a durable provider receipt'),
      );
      return;
    }
    const observation = await executor.observe(execution.executionRef);
    await this.applyObservation(groupId, turn, execution, observation);
  }

  private async applyObservation(
    groupId: string,
    turn: CollaborationTurnV3,
    execution: CollaborationActionExecutionV3,
    observation: ActionObservation,
  ): Promise<void> {
    if (!turn.fencing_token) return;
    const terminal = [
      'succeeded',
      'failed',
      'cancelled',
      'blocked',
      'recovery_required',
    ].includes(observation.state);
    if (
      !this.store.recordActionObservation({
        executionId: execution.executionId,
        claimantClientId: execution.claimantClientId,
        fencingToken: turn.fencing_token,
        state: observation.state,
        observation: observation as unknown as Record<string, unknown>,
        providerCompleted: terminal,
        recoveryRequiredReason: observation.recoveryReason ?? null,
        nowMs: this.now(),
      })
    )
      return;
    if (
      observation.state === 'waiting_input' ||
      observation.state === 'waiting_approval'
    ) {
      if (turn.state === observation.state) return;
      await this.groups.recordActionState({
        groupId,
        instanceId: turn.workflow_instance_id,
        turnId: turn.turn_id,
        expectedRevision: await this.currentInstanceRevision(
          groupId,
          turn.workflow_instance_id,
        ),
        attempt: turn.attempt,
        fencingToken: turn.fencing_token,
        state: observation.state,
        executorId: execution.executorId,
      });
      return;
    }
    if (
      observation.state !== 'succeeded' ||
      !observation.result ||
      !observation.resultHash
    ) {
      if (terminal)
        await this.requestRecovery(
          groupId,
          turn,
          observation.recoveryReason ??
            `Executor ended as ${observation.state}`,
        );
      return;
    }
    await this.groups.recordActionState({
      groupId,
      instanceId: turn.workflow_instance_id,
      turnId: turn.turn_id,
      expectedRevision: await this.currentInstanceRevision(
        groupId,
        turn.workflow_instance_id,
      ),
      attempt: turn.attempt,
      fencingToken: turn.fencing_token,
      state: 'completed',
      resultHash: observation.resultHash,
      executorId: execution.executorId,
    });
    await this.groups.completeTurn({
      groupId,
      instanceId: turn.workflow_instance_id,
      turnId: turn.turn_id,
      expectedRevision: await this.currentInstanceRevision(
        groupId,
        turn.workflow_instance_id,
      ),
      attempt: turn.attempt,
      fencingToken: turn.fencing_token,
      outcome: observation.result.outcome,
      summary: observation.result.summary,
      instruction: observation.result.instruction,
      markers: observation.result.markers,
      data: observation.result.data,
      artifactRefs: observation.result.artifacts.map(
        (artifact) => artifact.ref,
      ),
      result: observation.result,
      executorId: execution.executorId,
    });
  }

  private async failClosedAfterDispatch(
    groupId: string,
    turn: CollaborationTurnV3,
    execution: CollaborationActionExecutionV3,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    if (
      !this.store.recordActionObservation({
        executionId: execution.executionId,
        claimantClientId: execution.claimantClientId,
        fencingToken: execution.fencingToken,
        state: 'recovery_required',
        observation: { error: reason },
        recoveryRequiredReason: reason,
        nowMs: this.now(),
      })
    )
      return;
    await this.requestRecovery(groupId, turn, reason);
  }

  private async requestRecovery(
    groupId: string,
    turn: CollaborationTurnV3,
    reason: string,
  ): Promise<void> {
    const current =
      this.store.getGroup(groupId)?.projection?.turns[turn.turn_id];
    if (!current || current.state === 'recovery_required') return;
    await this.groups.requestTurnRecovery({
      groupId,
      instanceId: turn.workflow_instance_id,
      turnId: turn.turn_id,
      expectedRevision: await this.currentInstanceRevision(
        groupId,
        turn.workflow_instance_id,
      ),
      attempt: turn.attempt,
      fencingToken: turn.fencing_token,
      reason,
    });
  }

  private async currentInstanceRevision(
    groupId: string,
    instanceId: string,
  ): Promise<number> {
    const history = await this.groups.sync(groupId);
    return history.projection.aggregateHeads[`workflow_instance:${instanceId}`]!
      .revision;
  }
}
