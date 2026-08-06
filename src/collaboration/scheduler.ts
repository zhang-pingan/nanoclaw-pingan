import crypto from 'node:crypto';

import { readPromptFromValidatedCacheAsync } from './git-transport.js';
import {
  CollaborationProtocolError,
  type CollaborationTurn,
  type ValidatedCollaborationHistory,
} from './protocol/index.js';
import { CollaborationGroupService } from './service.js';
import {
  CollaborationStore,
  type CollaborationExecutionRecord,
  type CollaborationExecutionState,
  type CollaborationGroupRecord,
} from './store.js';
import {
  ActionExecutorRegistry,
  validateActionResult,
  type ActionExecutor,
  type ActionObservation,
  type ActionRequest,
  type PreparedAction,
} from './executors/index.js';

const TERMINAL_OBSERVATIONS = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
]);

export interface CollaborationSchedulerOptions {
  readonly tickIntervalMs?: number;
  readonly lockStaleMs?: number;
  readonly ownerId?: string;
  readonly now?: () => number;
}

export interface CollaborationSchedulerDiagnostic {
  readonly running: boolean;
  readonly ownerId: string;
  readonly lastTickAtMs: number | null;
  readonly receiptlessRecoveries: number;
  readonly groupErrors: Readonly<Record<string, string>>;
}

export function deterministicCollaborationPollDelay(
  groupId: string,
  baseDelayMs: number,
): number {
  const digest = crypto
    .createHash('sha256')
    .update(`icarus-collaboration-jitter-v1\0${groupId}`)
    .digest();
  const fraction = digest.readUInt32BE(0) / 0xffffffff;
  const jitter = Math.round(baseDelayMs * 0.2 * (fraction - 0.5));
  return Math.max(250, baseDelayMs + jitter);
}

function executionState(
  observation: ActionObservation,
): CollaborationExecutionState {
  if (observation.state === 'blocked') return 'failed';
  if (observation.state === 'recovery_required') return 'recovery_required';
  return observation.state;
}

function isTerminalObservation(observation: ActionObservation): boolean {
  return TERMINAL_OBSERVATIONS.has(observation.state);
}

function persistedObservation(
  record: CollaborationExecutionRecord,
): ActionObservation | null {
  const value = record.observation;
  if (
    !value ||
    typeof value.state !== 'string' ||
    typeof value.executionRef !== 'string' ||
    typeof value.providerMetadata !== 'object'
  )
    return null;
  return value as unknown as ActionObservation;
}

function transitionOutcomes(observation: ActionObservation): readonly string[] {
  switch (observation.state) {
    case 'succeeded':
      return ['succeeded', 'success'];
    case 'failed':
      return ['failed', 'failure'];
    case 'cancelled':
      return ['cancelled'];
    case 'blocked':
      return ['blocked', 'failed', 'failure'];
    default:
      return [];
  }
}

export class CollaborationScheduler {
  private readonly ownerId: string;
  private readonly tickIntervalMs: number;
  private readonly lockStaleMs: number;
  private readonly now: () => number;
  private readonly groupErrors = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;
  private acceptingWork = true;
  private activeOperations = 0;
  private readonly idleWaiters = new Set<() => void>();
  private lastTickAtMs: number | null = null;
  private receiptlessRecoveries = 0;

  constructor(
    private readonly store: CollaborationStore,
    private readonly groups: CollaborationGroupService,
    private readonly executors: ActionExecutorRegistry,
    options: CollaborationSchedulerOptions = {},
  ) {
    this.ownerId =
      options.ownerId ??
      `collaboration-scheduler:${process.pid}:${crypto.randomUUID()}`;
    this.tickIntervalMs = options.tickIntervalMs ?? 1_000;
    this.lockStaleMs = options.lockStaleMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.acceptingWork = true;
    this.receiptlessRecoveries =
      this.store.markReceiptlessExecutionsForRecovery(
        undefined,
        this.now(),
      ).length;
    this.running = true;
    void this.tickOnce().finally(() => this.schedule());
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async stopAndDrain(): Promise<void> {
    this.acceptingWork = false;
    this.stop();
    if (this.activeOperations === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  diagnostics(): CollaborationSchedulerDiagnostic {
    return {
      running: this.running,
      ownerId: this.ownerId,
      lastTickAtMs: this.lastTickAtMs,
      receiptlessRecoveries: this.receiptlessRecoveries,
      groupErrors: Object.fromEntries(this.groupErrors),
    };
  }

  async syncNow(groupId: string): Promise<void> {
    if (!this.acceptingWork)
      throw new Error('Collaboration Scheduler is quiescing for maintenance');
    await this.withActiveOperation(() => this.processGroup(groupId, true));
  }

  async tickOnce(): Promise<void> {
    if (this.ticking || !this.acceptingWork) return;
    this.ticking = true;
    this.activeOperations += 1;
    this.lastTickAtMs = this.now();
    try {
      for (const group of this.store.listGroups()) {
        if (group.nextSyncAtMs > this.now()) continue;
        try {
          await this.processGroup(group.groupId, false);
        } catch (error) {
          this.groupErrors.set(
            group.groupId,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.ticking = false;
      this.finishActiveOperation();
    }
  }

  private async withActiveOperation<T>(work: () => Promise<T>): Promise<T> {
    this.activeOperations += 1;
    try {
      return await work();
    } finally {
      this.finishActiveOperation();
    }
  }

  private finishActiveOperation(): void {
    this.activeOperations -= 1;
    if (this.activeOperations !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private schedule(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tickOnce().finally(() => this.schedule());
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  private async processGroup(groupId: string, force: boolean): Promise<void> {
    const group = this.store.getGroup(groupId);
    if (!group)
      throw new Error(`Collaboration group was not found: ${groupId}`);
    if (!force && group.nextSyncAtMs > this.now()) return;
    const locked = this.store.tryAcquireGroupLock(
      groupId,
      this.ownerId,
      this.now() - this.lockStaleMs,
      this.now(),
    );
    if (!locked) return;
    let syncAttemptId: number | null = null;
    let lockError: Error | null = null;
    const heartbeat = (): void => {
      if (lockError) return;
      try {
        if (!this.store.heartbeatGroupLock(groupId, this.ownerId, this.now()))
          lockError = new Error(
            `Collaboration group lock ownership was lost: ${groupId}`,
          );
      } catch (error) {
        lockError = new Error(
          `Collaboration group lock heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const assertLockHeld = (): void => {
      heartbeat();
      if (lockError) throw lockError;
    };
    const heartbeatTimer = setInterval(
      heartbeat,
      Math.max(10, Math.floor(this.lockStaleMs / 3)),
    );
    heartbeatTimer.unref?.();
    try {
      syncAttemptId = this.store.startSyncAttempt(
        groupId,
        group.headCommit,
        this.now(),
      );
      let history = await this.groups.syncHistory(groupId);
      assertLockHeld();
      this.store.scheduleNextSync(
        groupId,
        this.now() +
          deterministicCollaborationPollDelay(groupId, group.pollIntervalMs),
      );
      history = await this.driveHistory(group, history);
      assertLockHeld();
      await this.finishLifecycleOrCreateTurn(group, history);
      assertLockHeld();
      this.groupErrors.delete(groupId);
      this.store.finishSyncAttempt({
        id: syncAttemptId,
        groupId,
        outcome: 'succeeded',
        headAfter: this.store.getGroup(groupId)?.headCommit ?? null,
        nowMs: this.now(),
      });
    } catch (error) {
      if (syncAttemptId !== null)
        this.store.finishSyncAttempt({
          id: syncAttemptId,
          groupId,
          outcome: 'failed',
          headAfter: this.store.getGroup(groupId)?.headCommit ?? null,
          error: error instanceof Error ? error.message : String(error),
          errorClass:
            error instanceof CollaborationProtocolError
              ? 'protocol'
              : 'runtime',
          nowMs: this.now(),
        });
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      this.store.releaseGroupLock(groupId, this.ownerId);
    }
  }

  private async driveHistory(
    group: CollaborationGroupRecord,
    input: ValidatedCollaborationHistory,
  ): Promise<ValidatedCollaborationHistory> {
    let history = input;
    const turnId = history.projection.activeTurnId;
    const turn = turnId ? history.projection.turns[turnId] : null;
    if (!turn) return history;
    const localClaim = (history.projection.roleClaims[turn.role] ?? []).some(
      (claim) =>
        claim.principal_id === group.localPrincipalId &&
        claim.agent_id === group.localAgentId,
    );
    if (!localClaim) return history;

    if (
      turn.state === 'WAITING' &&
      history.projection.lifecycle === 'RUNNING'
    ) {
      await this.prepareAction(group, history, turn, null);
      const claim = await this.groups.claimCurrentTurn(group.groupId);
      history = claim.history;
      if (!claim.won) return history;
      const claimedTurnId = history.projection.activeTurnId;
      const claimedTurn = claimedTurnId
        ? history.projection.turns[claimedTurnId]
        : null;
      if (
        !claimedTurn ||
        claimedTurn.claimantPrincipalId !== group.localPrincipalId ||
        claimedTurn.claimantAgentId !== group.localAgentId
      )
        return history;
      return this.processLocalExecution(group, history, claimedTurn, true);
    }

    if (
      turn.claimantPrincipalId === group.localPrincipalId &&
      turn.claimantAgentId === group.localAgentId
    )
      history = await this.processLocalExecution(group, history, turn, false);
    return history;
  }

  private async prepareAction(
    group: CollaborationGroupRecord,
    history: ValidatedCollaborationHistory,
    turn: CollaborationTurn,
    executionId: string | null,
  ): Promise<{
    readonly executor: ActionExecutor;
    readonly prepared: PreparedAction;
  }> {
    const action = history.definition.actions[turn.actionId];
    if (!action)
      throw new Error(`Collaboration action is missing: ${turn.actionId}`);
    const binding = this.store.getExecutorBinding(group.groupId, turn.role);
    if (!binding)
      throw new Error(`No local executor binding exists for role ${turn.role}`);
    if (
      binding.executorKind !== action.kind ||
      (action.kind === 'external' && binding.adapter !== action.adapter)
    )
      throw new Error(
        `Local executor binding does not match action ${turn.actionId}`,
      );
    const executor = this.executors.resolve(action);
    const sharedPrompt = await readPromptFromValidatedCacheAsync({
      repositoryPath: group.repositoryPath,
      head: history.head,
      promptRef: action.input.prompt_ref,
    });
    const request: ActionRequest = {
      executionId: executionId ?? `collaboration:${crypto.randomUUID()}`,
      operationKey: turn.idempotencyKey,
      groupId: group.groupId,
      turnId: turn.turnId,
      epoch: turn.epoch,
      attempt: turn.attempt,
      fencingToken: turn.fencingToken ?? `sha256:${'0'.repeat(64)}`,
      action,
      prompt: binding.promptOverride ?? sharedPrompt,
      binding,
    };
    return { executor, prepared: await executor.prepare(request) };
  }

  private async processLocalExecution(
    group: CollaborationGroupRecord,
    input: ValidatedCollaborationHistory,
    turn: CollaborationTurn,
    freshClaim: boolean,
  ): Promise<ValidatedCollaborationHistory> {
    let history = input;
    if (!turn.fencingToken) return history;
    const existing = this.store.getExecutionForTurn(
      group.groupId,
      turn.turnId,
      turn.attempt,
    );
    const execution =
      existing ??
      this.store.reserveExecution({
        groupId: group.groupId,
        turnId: turn.turnId,
        epoch: turn.epoch,
        attempt: turn.attempt,
        fencingToken: turn.fencingToken,
        operationKey: turn.idempotencyKey,
        executorKind:
          history.definition.actions[turn.actionId]?.kind ?? 'unknown',
        adapter: history.definition.actions[turn.actionId]?.adapter,
        nowMs: this.now(),
      });

    if (!existing && !freshClaim) {
      this.store.requireRecovery(
        execution.executionId,
        'The local claimant has no execution receipt; automatic dispatch is forbidden',
        this.now(),
      );
      return history;
    }
    if (execution.state === 'recovery_required') return history;

    const prepared = await this.prepareAction(
      group,
      history,
      turn,
      execution.executionId,
    );
    let current = this.store.getExecutionByOperationKey(turn.idempotencyKey)!;
    if (!current.receipt) {
      if (!freshClaim || existing) {
        this.store.requireRecovery(
          current.executionId,
          'The claimed action has no durable dispatch receipt; automatic redispatch is forbidden',
          this.now(),
        );
        return history;
      }
      this.store.markDispatchStarted(current.executionId, this.now());
      try {
        const receipt = await prepared.executor.dispatch(prepared.prepared);
        this.store.recordDispatchReceipt({
          executionId: current.executionId,
          executionRef: receipt.executionRef,
          providerMetadata: receipt.providerMetadata,
          receipt: receipt.receipt,
          nowMs: this.now(),
        });
      } catch (error) {
        this.store.requireRecovery(
          current.executionId,
          `Dispatch did not produce a durable receipt: ${error instanceof Error ? error.message : String(error)}`,
          this.now(),
        );
        return history;
      }
      current = this.store.getExecutionByOperationKey(turn.idempotencyKey)!;
    }
    if (!current.executionRef || !current.providerMetadata) {
      this.store.requireRecovery(
        current.executionId,
        'The dispatch receipt is structurally incomplete',
        this.now(),
      );
      return history;
    }

    const latestTurn = history.projection.turns[turn.turnId];
    if (
      latestTurn.attempt !== current.attempt ||
      latestTurn.fencingToken !== current.fencingToken
    ) {
      this.store.requireRecovery(
        current.executionId,
        'A late executor observation was rejected by the current fencing token',
        this.now(),
      );
      return history;
    }
    if (latestTurn.state === 'CLAIMED') {
      history = await this.groups.appendActionEvent({
        groupId: group.groupId,
        type: 'action_dispatched',
        payload: {
          turn_id: turn.turnId,
          attempt: current.attempt,
          fencing_token: current.fencingToken,
          execution_ref: current.executionRef,
        },
      });
    } else if (
      latestTurn.executionRef &&
      latestTurn.executionRef !== current.executionRef
    ) {
      this.store.requireRecovery(
        current.executionId,
        'The Git execution ref does not match the durable local receipt',
        this.now(),
      );
      return history;
    }

    let observation = persistedObservation(current);
    if (!observation || !isTerminalObservation(observation)) {
      observation = await prepared.executor.observe(current.executionRef);
      if (observation.state === 'recovery_required')
        observation = await prepared.executor.recover(
          current.executionRef,
          current.providerMetadata,
        );
      this.store.saveObservation({
        executionId: current.executionId,
        state: executionState(observation),
        observation: observation as unknown as Record<string, unknown>,
        nowMs: this.now(),
      });
    }
    if (observation.state === 'recovery_required') {
      this.store.requireRecovery(
        current.executionId,
        observation.recoveryReason ?? 'Provider recovery is required',
        this.now(),
      );
      return history;
    }
    if (observation.state === 'waiting_input')
      return this.appendWaitingEvent(
        group,
        history,
        current,
        'action_waiting_input',
      );
    if (observation.state === 'waiting_approval')
      return this.appendWaitingEvent(
        group,
        history,
        current,
        'action_waiting_approval',
      );
    if (!isTerminalObservation(observation)) return history;
    if (!observation.result)
      throw new Error('A terminal executor observation has no result');
    const action = history.definition.actions[turn.actionId];
    const validated = validateActionResult(action, observation.result);
    if (
      observation.resultHash &&
      observation.resultHash !== validated.resultHash
    )
      throw new Error(
        'Executor result hash disagrees with the validated result',
      );
    const terminalType =
      observation.state === 'succeeded'
        ? 'action_succeeded'
        : observation.state === 'cancelled'
          ? 'action_cancelled'
          : 'action_failed';
    const terminalTurn = history.projection.turns[turn.turnId];
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(terminalTurn.state))
      history = await this.groups.appendActionEvent({
        groupId: group.groupId,
        type: terminalType,
        payload: {
          turn_id: turn.turnId,
          attempt: current.attempt,
          fencing_token: current.fencingToken,
          result_hash: validated.resultHash,
          artifact_refs: validated.result.artifacts.map(
            (artifact) => artifact.ref,
          ),
        },
      });

    const transition = history.definition.machine.states[
      history.projection.businessState
    ]?.transitions.find((candidate) => candidate.id === turn.transitionId);
    const outcome = transitionOutcomes(observation).find(
      (candidate) => transition?.outcomes[candidate],
    );
    if (!transition || !outcome) {
      this.store.requireRecovery(
        current.executionId,
        `No FSM outcome matches executor state ${observation.state}`,
        this.now(),
      );
      return history;
    }
    const toState = transition.outcomes[outcome];
    history = await this.groups.appendActionEvent({
      groupId: group.groupId,
      type: 'state_transitioned',
      payload: {
        turn_id: turn.turnId,
        attempt: current.attempt,
        fencing_token: current.fencingToken,
        outcome,
        from_state: history.projection.businessState,
        to_state: toState,
      },
    });
    return history;
  }

  private async appendWaitingEvent(
    group: CollaborationGroupRecord,
    history: ValidatedCollaborationHistory,
    execution: CollaborationExecutionRecord,
    type: 'action_waiting_input' | 'action_waiting_approval',
  ): Promise<ValidatedCollaborationHistory> {
    const turn = history.projection.turns[execution.turnId];
    const expected =
      type === 'action_waiting_input' ? 'WAITING_INPUT' : 'WAITING_APPROVAL';
    if (turn.state === expected) return history;
    return this.groups.appendActionEvent({
      groupId: group.groupId,
      type,
      payload: {
        turn_id: execution.turnId,
        attempt: execution.attempt,
        fencing_token: execution.fencingToken,
      },
    });
  }

  private async finishLifecycleOrCreateTurn(
    group: CollaborationGroupRecord,
    history: ValidatedCollaborationHistory,
  ): Promise<void> {
    const latest = this.store.getGroup(group.groupId);
    if (!latest || latest.localPrincipalId !== latest.creatorPrincipalId)
      return;
    if (
      history.projection.lifecycle === 'PAUSING' ||
      history.projection.lifecycle === 'CLOSING'
    ) {
      await this.groups.finishDrainingLifecycle(group.groupId);
      return;
    }
    if (
      history.projection.lifecycle === 'RUNNING' &&
      !history.projection.activeTurnId
    )
      await this.groups.ensureTurn(group.groupId);
  }
}

export function isSchedulerProtocolConflict(error: unknown): boolean {
  return error instanceof CollaborationProtocolError;
}
