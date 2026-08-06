import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CollaborationGitConflictError,
  CollaborationGitTransport,
  collaborationRepositoryCachePath,
  readPromptFromValidatedCacheAsync,
} from './git-transport.js';
import {
  CollaborationIdentityService,
  type CollaborationSigningIdentity,
} from './identity.js';
import {
  COLLABORATION_CONTROL_BRANCH,
  COLLABORATION_PROTOCOL_VERSION,
  CollaborationProtocolError,
  collaborationEventSchema,
  collaborationFencingToken,
  collaborationIdempotencyKey,
  findCollaborationMember,
  reduceCollaborationEvent,
  validateRepositoryDefinition,
  type ActionDefinition,
  type CollaborationEvent,
  type CollaborationEventType,
  type CollaborationProjection,
  type CollaborationRepositoryDefinition,
  type MachineDefinition,
  type MemberDefinition,
  type RoleDefinition,
  type ValidatedCollaborationHistory,
} from './protocol/index.js';
import { CollaborationStore, type CollaborationGroupRecord } from './store.js';

function hash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function identifier(prefix: 'ag' | 'evt' | 'turn'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export interface CreateCollaborationGroupInput {
  readonly remoteUrl: string;
  readonly name: string;
  readonly signingKeyPath: string;
  readonly capabilities: readonly string[];
  readonly initialRole: string;
  readonly machine: MachineDefinition;
  readonly roles: Readonly<Record<string, RoleDefinition>>;
  readonly actions: Readonly<Record<string, ActionDefinition>>;
  readonly prompts: Readonly<Record<string, string>>;
  readonly groupId?: string;
  readonly pollIntervalMs?: number;
}

export interface JoinCollaborationGroupInput {
  readonly remoteUrl: string;
  readonly signingKeyPath: string;
  readonly capabilities: readonly string[];
  readonly role: string;
  readonly pollIntervalMs?: number;
}

export interface CollaborationRemoteSummary {
  readonly groupId: string;
  readonly name: string;
  readonly creatorPrincipalId: string;
  readonly lifecycle: string;
  readonly businessState: string;
  readonly protocolVersion: number;
  readonly roles: readonly {
    readonly role: string;
    readonly displayName: string;
    readonly claimed: number;
    readonly min: number;
    readonly max: number;
  }[];
}

export class CollaborationGroupService {
  private readonly histories = new Map<string, ValidatedCollaborationHistory>();

  constructor(
    readonly store: CollaborationStore,
    readonly transport: CollaborationGitTransport,
    private readonly repositoryRoot: string,
    private readonly identities: CollaborationIdentityService,
    private readonly now: () => number = Date.now,
  ) {}

  async createGroup(
    input: CreateCollaborationGroupInput,
  ): Promise<CollaborationGroupRecord> {
    const identity = await this.identities.resolveSigningIdentity(
      input.signingKeyPath,
    );
    const groupId = input.groupId ?? identifier('ag');
    const role = input.roles[input.initialRole];
    if (!role)
      throw new Error(`Initial role is not defined: ${input.initialRole}`);
    if (!input.capabilities.includes(role.executor_requirements.capability))
      throw new Error(`Creator lacks capability for role ${input.initialRole}`);
    const definition = validateRepositoryDefinition({
      group: {
        format: 'icarus.agent-group/1',
        protocol_version: COLLABORATION_PROTOCOL_VERSION,
        group_id: groupId,
        name: input.name,
        creator: {
          principal_id: identity.principalId,
          signing_key_ref: identity.keyRef,
        },
        control_branch: COLLABORATION_CONTROL_BRANCH,
        machine_ref: 'machine.yaml',
        required_roles: Object.values(input.roles).map((candidate) => ({
          role: candidate.role,
          min_members: candidate.cardinality.min,
          max_members: candidate.cardinality.max,
        })),
        lifecycle_policy: {
          active_turn_pause: 'drain',
          stalled_turn_recovery: 'creator_command',
        },
      },
      machine: input.machine,
      roles: input.roles,
      actions: input.actions,
    });
    const eventId = identifier('evt');
    const member: MemberDefinition = {
      format: 'icarus.agent-group-member/1',
      principal_id: identity.principalId,
      signing_key_ref: identity.keyRef,
      signing_public_key: identity.publicKey,
      agent_id: identity.agentId,
      capabilities: [...new Set(input.capabilities)],
      registered_at_event: eventId,
    };
    const genesisEvent = this.event({
      groupId,
      identity,
      eventId,
      sequence: 1,
      revision: 0,
      type: 'group_initialized',
      payload: {
        member,
        role_claim: {
          format: 'icarus.agent-group-role-claim/1',
          role: input.initialRole,
          principal_id: identity.principalId,
          agent_id: identity.agentId,
          claimed_at_event: eventId,
        },
      },
    });
    const projection = reduceCollaborationEvent(null, genesisEvent, definition);
    const repositoryPath = collaborationRepositoryCachePath(
      this.repositoryRoot,
      input.remoteUrl,
    );
    const history = await this.transport.createRepository({
      remoteUrl: input.remoteUrl,
      repositoryPath,
      definition,
      prompts: input.prompts,
      genesisEvent,
      genesisProjection: projection,
      identity,
    });
    this.store.registerGroup({
      groupId,
      name: input.name,
      creatorPrincipalId: identity.principalId,
      localPrincipalId: identity.principalId,
      localAgentId: identity.agentId,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      signingKeyPath: identity.privateKeyPath,
      signingPublicKey: identity.publicKey,
      signingKeyRef: identity.keyRef,
      pollIntervalMs: input.pollIntervalMs ?? 15_000,
      nowMs: this.now(),
    });
    this.persistHistory(history);
    return this.requireGroup(groupId);
  }

  async inspectRemote(remoteUrl: string): Promise<CollaborationRemoteSummary> {
    const temporaryRoot = mkdtempSync(
      path.join(os.tmpdir(), 'icarus-collaboration-inspect-'),
    );
    try {
      const history = await this.transport.cloneAndValidate({
        remoteUrl,
        repositoryPath: path.join(temporaryRoot, 'control.git'),
      });
      return this.summary(history);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  async joinGroup(
    input: JoinCollaborationGroupInput,
  ): Promise<CollaborationGroupRecord> {
    const identity = await this.identities.resolveSigningIdentity(
      input.signingKeyPath,
    );
    const repositoryPath = collaborationRepositoryCachePath(
      this.repositoryRoot,
      input.remoteUrl,
    );
    let history = await this.transport.cloneAndValidate({
      remoteUrl: input.remoteUrl,
      repositoryPath,
    });
    const role = history.definition.roles[input.role];
    if (!role) throw new Error(`Role is not defined: ${input.role}`);
    if (!input.capabilities.includes(role.executor_requirements.capability))
      throw new Error(`Member lacks capability for role ${input.role}`);
    const groupId = history.definition.group.group_id;
    const existing = this.store.getGroup(groupId);
    if (existing && existing.remoteUrl !== input.remoteUrl)
      throw new Error(`Group ${groupId} is already bound to another remote`);
    if (!existing)
      this.store.registerGroup({
        groupId,
        name: history.definition.group.name,
        creatorPrincipalId: history.definition.group.creator.principal_id,
        localPrincipalId: identity.principalId,
        localAgentId: identity.agentId,
        remoteUrl: input.remoteUrl,
        repositoryPath,
        signingKeyPath: identity.privateKeyPath,
        signingPublicKey: identity.publicKey,
        signingKeyRef: identity.keyRef,
        pollIntervalMs: input.pollIntervalMs ?? 15_000,
        nowMs: this.now(),
      });
    this.persistHistory(history);

    const principalMembers =
      history.projection.members[identity.principalId] ?? [];
    if (
      principalMembers.some(
        (member) =>
          member.signing_key_ref !== identity.keyRef ||
          member.signing_public_key !== identity.publicKey,
      )
    )
      throw new Error(
        'Principal is already registered with a different signing key',
      );
    const registered = principalMembers.some(
      (member) => member.agent_id === identity.agentId,
    );
    if (!registered) {
      const eventId = identifier('evt');
      history = await this.append(groupId, identity, () => ({
        type: 'member_registered',
        eventId,
        payload: {
          member: {
            format: 'icarus.agent-group-member/1',
            principal_id: identity.principalId,
            signing_key_ref: identity.keyRef,
            signing_public_key: identity.publicKey,
            agent_id: identity.agentId,
            capabilities: [...new Set(input.capabilities)],
            registered_at_event: eventId,
          },
        },
      }));
    }
    const claimed = (history.projection.roleClaims[input.role] ?? []).some(
      (claim) =>
        claim.principal_id === identity.principalId &&
        claim.agent_id === identity.agentId,
    );
    if (!claimed)
      await this.append(groupId, identity, () => ({
        type: 'role_claimed',
        payload: {
          role: input.role,
          principal_id: identity.principalId,
          agent_id: identity.agentId,
        },
      }));
    return this.requireGroup(groupId);
  }

  listGroups(search = ''): CollaborationGroupRecord[] {
    const query = search.trim().toLocaleLowerCase();
    return this.store
      .listGroups()
      .filter(
        (group) =>
          !query ||
          group.name.toLocaleLowerCase().includes(query) ||
          group.groupId.toLocaleLowerCase().includes(query) ||
          group.remoteUrl.toLocaleLowerCase().includes(query),
      );
  }

  getCachedHistory(groupId: string): ValidatedCollaborationHistory | null {
    return this.histories.get(groupId) ?? null;
  }

  async sync(groupId: string): Promise<CollaborationGroupRecord> {
    await this.syncHistory(groupId);
    return this.requireGroup(groupId);
  }

  async syncHistory(groupId: string): Promise<ValidatedCollaborationHistory> {
    const group = this.requireGroup(groupId);
    try {
      const history = await this.transport.fetchAndValidate({
        remoteUrl: group.remoteUrl,
        repositoryPath: group.repositoryPath,
        previousHead: group.headCommit,
      });
      this.persistHistory(history);
      this.store.recordSyncSuccess(groupId, group.pollIntervalMs, this.now());
      return history;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CollaborationProtocolError) {
        this.store.markProtocolBlocked(
          groupId,
          error.code === 'PROTOCOL_VERSION_UNSUPPORTED'
            ? 'PROTOCOL_VERSION_UNSUPPORTED'
            : 'PROTOCOL_QUARANTINED',
          message,
          group.headCommit,
          this.now(),
        );
      } else {
        this.store.recordSyncFailure(
          groupId,
          message,
          group.pollIntervalMs,
          this.now(),
        );
      }
      throw error;
    }
  }

  async finishDrainingLifecycle(
    groupId: string,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    const history = await this.transport.fetchAndValidate({
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      previousHead: group.headCommit,
    });
    this.persistHistory(history);
    const active = history.projection.activeTurnId
      ? history.projection.turns[history.projection.activeTurnId]
      : null;
    if (active && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(active.state))
      return this.requireGroup(groupId);
    if (history.projection.lifecycle === 'PAUSING')
      await this.append(groupId, await this.identityFor(group), () => ({
        type: 'group_paused',
        payload: {},
      }));
    else if (history.projection.lifecycle === 'CLOSING')
      await this.append(groupId, await this.identityFor(group), () => ({
        type: 'group_closed',
        payload: { reason: 'Active collaboration work drained' },
      }));
    return this.requireGroup(groupId);
  }

  async claimRole(
    groupId: string,
    role: string,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireGroup(groupId);
    const history = await this.transport.fetchAndValidate({
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      previousHead: group.headCommit,
    });
    const member = findCollaborationMember(
      history.projection,
      group.localPrincipalId,
      group.localAgentId,
    );
    if (!member)
      throw new Error('Local principal is not registered in the group');
    await this.append(groupId, await this.identityFor(group), () => ({
      type: 'role_claimed',
      payload: {
        role,
        principal_id: group.localPrincipalId,
        agent_id: group.localAgentId,
      },
    }));
    return this.requireGroup(groupId);
  }

  async start(groupId: string): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    await this.append(groupId, await this.identityFor(group), () => ({
      type: 'group_started',
      payload: {},
    }));
    await this.ensureTurn(groupId);
    return this.requireGroup(groupId);
  }

  async pause(groupId: string): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    let history = await this.append(
      groupId,
      await this.identityFor(group),
      () => ({
        type: 'group_pause_requested',
        payload: {},
      }),
    );
    const active = history.projection.activeTurnId
      ? history.projection.turns[history.projection.activeTurnId]
      : null;
    if (!active || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(active.state))
      history = await this.append(
        groupId,
        await this.identityFor(group),
        () => ({
          type: 'group_paused',
          payload: {},
        }),
      );
    this.persistHistory(history);
    return this.requireGroup(groupId);
  }

  async resume(groupId: string): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    await this.append(groupId, await this.identityFor(group), () => ({
      type: 'group_resumed',
      payload: {},
    }));
    await this.ensureTurn(groupId);
    return this.requireGroup(groupId);
  }

  async close(
    groupId: string,
    reason: string,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    let history = await this.append(
      groupId,
      await this.identityFor(group),
      () => ({
        type: 'group_close_requested',
        payload: { reason },
      }),
    );
    const active = history.projection.activeTurnId
      ? history.projection.turns[history.projection.activeTurnId]
      : null;
    if (!active || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(active.state))
      history = await this.append(
        groupId,
        await this.identityFor(group),
        () => ({
          type: 'group_closed',
          payload: { reason },
        }),
      );
    this.persistHistory(history);
    return this.requireGroup(groupId);
  }

  async ensureTurn(
    groupId: string,
    transitionId?: string,
  ): Promise<ValidatedCollaborationHistory | null> {
    const group = this.requireCreator(groupId);
    const history = await this.transport.fetchAndValidate({
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      previousHead: group.headCommit,
    });
    this.persistHistory(history);
    if (history.projection.lifecycle !== 'RUNNING') return null;
    if (history.projection.activeTurnId) return history;
    const state =
      history.definition.machine.states[history.projection.businessState];
    if (!state || state.terminal) return null;
    const transition = transitionId
      ? state.transitions.find((candidate) => candidate.id === transitionId)
      : state.transitions.length === 1
        ? state.transitions[0]
        : null;
    if (!transition)
      throw new Error(
        transitionId
          ? `Transition is not available: ${transitionId}`
          : 'The current state has multiple transitions; an explicit transition is required',
      );
    const actionId = transition.action_ref
      .replace(/^actions\//, '')
      .replace(/\.yaml$/, '');
    const action = history.definition.actions[actionId];
    if (!action) throw new Error(`Action is not defined: ${actionId}`);
    const prompt = await readPromptFromValidatedCacheAsync({
      repositoryPath: group.repositoryPath,
      head: history.head,
      promptRef: action.input.prompt_ref,
    });
    const turnId = identifier('turn');
    const inputHash = hash(
      JSON.stringify({
        action,
        prompt,
        businessState: history.projection.businessState,
      }),
    );
    return this.append(groupId, await this.identityFor(group), () => ({
      type: 'turn_created',
      payload: {
        turn_id: turnId,
        transition_id: transition.id,
        action_id: action.action_id,
        role: transition.actor_role,
        attempt: 1,
        input_hash: inputHash,
        idempotency_key: collaborationIdempotencyKey({
          groupId,
          epoch: history.projection.epoch,
          turnId,
          attempt: 1,
          inputHash,
        }),
      },
    }));
  }

  async claimCurrentTurn(groupId: string): Promise<{
    readonly won: boolean;
    readonly history: ValidatedCollaborationHistory;
  }> {
    const group = this.requireGroup(groupId);
    const identity = await this.identityFor(group);
    try {
      const history = await this.append(groupId, identity, (current) => {
        const turnId = current.projection.activeTurnId;
        const turn = turnId ? current.projection.turns[turnId] : null;
        if (!turn || turn.state !== 'WAITING')
          throw new Error('No waiting turn is available');
        const eventId = identifier('evt');
        return {
          type: 'turn_claimed',
          eventId,
          payload: {
            turn_id: turn.turnId,
            attempt: turn.attempt,
            fencing_token: collaborationFencingToken({
              groupId,
              epoch: current.projection.epoch,
              turnId: turn.turnId,
              attempt: turn.attempt,
              claimEventId: eventId,
              expectedRevision: current.projection.revision,
            }),
          },
        };
      });
      return { won: true, history };
    } catch (error) {
      const possibleLostRace =
        error instanceof CollaborationGitConflictError ||
        (error instanceof Error &&
          error.message === 'No waiting turn is available');
      if (!possibleLostRace) throw error;
      const groupAfterRace = this.requireGroup(groupId);
      const history = await this.transport.fetchAndValidate({
        remoteUrl: groupAfterRace.remoteUrl,
        repositoryPath: groupAfterRace.repositoryPath,
        previousHead: groupAfterRace.headCommit,
      });
      this.persistHistory(history);
      const turnId = history.projection.activeTurnId;
      const turn = turnId ? history.projection.turns[turnId] : null;
      if (!turn || turn.state === 'WAITING') throw error;
      return { won: false, history };
    }
  }

  async appendActionEvent(input: {
    readonly groupId: string;
    readonly type: Extract<
      CollaborationEventType,
      | 'action_dispatched'
      | 'action_waiting_input'
      | 'action_waiting_approval'
      | 'action_succeeded'
      | 'action_failed'
      | 'action_cancelled'
      | 'state_transitioned'
    >;
    readonly payload: Record<string, unknown>;
  }): Promise<ValidatedCollaborationHistory> {
    const group = this.requireGroup(input.groupId);
    return this.append(input.groupId, await this.identityFor(group), () => ({
      type: input.type,
      payload: input.payload,
    }));
  }

  async recoverTurn(
    groupId: string,
    reason: string,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    const identity = await this.identityFor(group);
    let history = await this.append(groupId, identity, (current) => {
      const turnId = current.projection.activeTurnId;
      const turn = turnId ? current.projection.turns[turnId] : null;
      if (!turn || !turn.fencingToken)
        throw new Error('No claimed turn can be recovered');
      return {
        type: 'stalled_turn_recovery_requested',
        payload: {
          turn_id: turn.turnId,
          attempt: turn.attempt,
          fencing_token: turn.fencingToken,
          reason,
        },
      };
    });
    history = await this.append(groupId, identity, (current) => {
      const turnId = current.projection.activeTurnId;
      const turn = turnId ? current.projection.turns[turnId] : null;
      if (!turn || !turn.fencingToken)
        throw new Error('No recovery-required turn exists');
      return {
        type: 'turn_recovered',
        payload: {
          turn_id: turn.turnId,
          attempt: turn.attempt + 1,
          fencing_token: turn.fencingToken,
        },
      };
    });
    this.persistHistory(history);
    return this.requireGroup(groupId);
  }

  private async append(
    groupId: string,
    identity: CollaborationSigningIdentity,
    build: (history: ValidatedCollaborationHistory) => {
      readonly type: CollaborationEventType;
      readonly payload: Record<string, unknown>;
      readonly eventId?: string;
    },
  ): Promise<ValidatedCollaborationHistory> {
    const group = this.requireGroup(groupId);
    const history = await this.transport.appendEvent({
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      previousHead: group.headCommit,
      identity,
      buildEvent: (current) => {
        const next = build(current);
        return this.event({
          groupId,
          identity,
          eventId: next.eventId ?? identifier('evt'),
          sequence: current.projection.sequence + 1,
          revision: current.projection.revision,
          type: next.type,
          payload: next.payload,
          epoch: current.projection.epoch,
        });
      },
    });
    this.persistHistory(history);
    return history;
  }

  private event(input: {
    readonly groupId: string;
    readonly identity: CollaborationSigningIdentity;
    readonly eventId: string;
    readonly sequence: number;
    readonly revision: number;
    readonly type: CollaborationEventType;
    readonly payload: Record<string, unknown>;
    readonly epoch?: number;
  }): CollaborationEvent {
    return collaborationEventSchema.parse({
      format: 'icarus.agent-group-event/1',
      protocol_version: COLLABORATION_PROTOCOL_VERSION,
      group_id: input.groupId,
      event_id: input.eventId,
      epoch: input.epoch ?? 1,
      sequence: input.sequence,
      event_type: input.type,
      actor: {
        principal_id: input.identity.principalId,
        agent_id: input.identity.agentId,
      },
      expected: { state_revision: input.revision },
      payload: input.payload,
      occurred_at: new Date(this.now()).toISOString(),
    });
  }

  private async identityFor(
    group: CollaborationGroupRecord,
  ): Promise<CollaborationSigningIdentity> {
    const identity = await this.identities.resolveSigningIdentity(
      group.signingKeyPath,
    );
    if (
      identity.principalId !== group.localPrincipalId ||
      identity.agentId !== group.localAgentId ||
      identity.keyRef !== group.signingKeyRef ||
      identity.publicKey !== group.signingPublicKey
    )
      throw new Error(
        'Local collaboration signing key no longer matches its binding',
      );
    return identity;
  }

  private persistHistory(history: ValidatedCollaborationHistory): void {
    this.histories.set(history.projection.groupId, history);
    const group = this.store.getGroup(history.projection.groupId);
    if (!group) return;
    this.store.saveProjection({
      groupId: history.projection.groupId,
      headCommit: history.head,
      projection: history.projection,
      events: history.events,
      commits: history.commits,
      turns: Object.values(history.projection.turns),
      nowMs: this.now(),
    });
  }

  private summary(
    history: ValidatedCollaborationHistory,
  ): CollaborationRemoteSummary {
    return {
      groupId: history.definition.group.group_id,
      name: history.definition.group.name,
      creatorPrincipalId: history.definition.group.creator.principal_id,
      lifecycle: history.projection.lifecycle,
      businessState: history.projection.businessState,
      protocolVersion: history.definition.group.protocol_version,
      roles: Object.values(history.definition.roles).map((role) => ({
        role: role.role,
        displayName: role.display_name,
        claimed: history.projection.roleClaims[role.role]?.length ?? 0,
        min: role.cardinality.min,
        max: role.cardinality.max,
      })),
    };
  }

  private requireGroup(groupId: string): CollaborationGroupRecord {
    const group = this.store.getGroup(groupId);
    if (!group)
      throw new Error(`Collaboration group was not found: ${groupId}`);
    return group;
  }

  private requireCreator(groupId: string): CollaborationGroupRecord {
    const group = this.requireGroup(groupId);
    if (group.localPrincipalId !== group.creatorPrincipalId)
      throw new Error('Only the group creator can perform this command');
    return group;
  }
}
