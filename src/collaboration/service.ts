import crypto from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import {
  CollaborationGitConflictError,
  CollaborationGitTransport,
  collaborationRepositoryCachePath,
  listCollaborationSharedPaths,
  normalizeCollaborationDataPath,
  type CollaborationMaterializedFile,
} from './git-transport.js';
import {
  CollaborationIdentityService,
  type CollaborationSigningIdentity,
} from './identity.js';
import {
  COLLABORATION_CONTROL_BRANCH,
  COLLABORATION_PROTOCOL_VERSION,
  CollaborationProtocolError,
  collaborationCanonicalHash,
  collaborationDeadlineAt,
  collaborationDeadlineSnapshotHash,
  collaborationEventSchema,
  collaborationFencingToken,
  collaborationIdempotencyKey,
  findCollaborationMember,
  handoffEnvelopeSchema,
  reduceCollaborationEvent,
  validateRepositoryDefinition,
  type ActionDefinition,
  type ArtifactMetadata,
  type CollaborationEvent,
  type CollaborationEventType,
  type CollaborationProjection,
  type CollaborationRepositoryDefinition,
  type CollaborationValidationCheckpoint,
  type CollaborationValidationMetrics,
  type FilesystemAccess,
  type MachineDefinition,
  type MachineLayoutDefinition,
  type MemberDefinition,
  type RoleDefinition,
  type StateExecutionMode,
  type StateImplementation,
  type CollaborationDeadlineKind,
  type ValidatedCollaborationHistory,
} from './protocol/index.js';
import {
  CollaborationStore,
  type CollaborationGroupRecord,
  type CollaborationStagedArtifact,
} from './store.js';

function hash(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function identifier(prefix: 'ag' | 'evt' | 'turn' | 'artifact'): string {
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
  readonly layout?: MachineLayoutDefinition | null;
  readonly groupId?: string;
  readonly pollIntervalMs?: number;
}

export interface ReviseCollaborationMachineInput {
  readonly groupId: string;
  readonly machine: MachineDefinition;
  readonly roles: Readonly<Record<string, RoleDefinition>>;
  readonly expectedRevision: number;
}

export interface UpdateCollaborationMachineLayoutInput {
  readonly groupId: string;
  readonly layout: MachineLayoutDefinition;
  readonly expectedRevision: number;
}

export interface JoinCollaborationGroupInput {
  readonly remoteUrl: string;
  readonly signingKeyPath: string;
  readonly capabilities: readonly string[];
  readonly role: string;
  readonly pollIntervalMs?: number;
}

export interface PublishStateImplementationInput {
  readonly groupId: string;
  readonly stateId: string;
  readonly mode: StateExecutionMode;
  readonly expectedRevision: number;
  readonly action?: {
    readonly actionId?: string;
    readonly kind: ActionDefinition['kind'];
    readonly adapter?: string;
    readonly workflowRef?: string;
    readonly prompt: string;
    readonly filesystemAccess: FilesystemAccess;
    readonly resultSchema?: Readonly<Record<string, unknown>>;
  } | null;
}

export interface CompleteCollaborationTurnInput {
  readonly groupId: string;
  readonly turnId: string;
  readonly expectedRevision: number;
  readonly outcome: string;
  readonly summary: string;
  readonly instruction?: string;
  readonly markers?: readonly string[];
  readonly dataRefs?: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
  readonly artifactIds?: readonly string[];
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
    readonly ownedStates: readonly string[];
  }[];
}

export const MAX_COLLABORATION_DATA_BYTES = 1024 * 1024;
export const MAX_COLLABORATION_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_COLLABORATION_TURN_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const MAX_COLLABORATION_TURN_ARTIFACTS = 20;

export interface UpdateCollaborationDataInput {
  readonly groupId: string;
  readonly path: string;
  readonly content: string;
  readonly expectedRevision: number;
  readonly mediaType?: string | null;
  readonly turn?: {
    readonly turnId: string;
    readonly attempt: number;
    readonly fencingToken: string;
  } | null;
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
    if (
      !role.required_capabilities.every((capability) =>
        input.capabilities.includes(capability),
      )
    )
      throw new Error(
        `Creator lacks capabilities for role ${input.initialRole}`,
      );
    const definition = validateRepositoryDefinition({
      group: {
        format: 'icarus.agent-group/2',
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
      actions: {},
      implementations: {},
      layout: input.layout ?? {
        format: 'icarus.agent-group-machine-layout/1',
        view: 'free',
        nodes: {},
      },
    });
    const eventId = identifier('evt');
    const member: MemberDefinition = {
      format: 'icarus.agent-group-member/2',
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
      epoch: 1,
      type: 'group_initialized',
      payload: {
        member,
        role_claim: {
          format: 'icarus.agent-group-role-claim/2',
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
      prompts: {},
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
      return this.summary(
        await this.transport.cloneAndValidate({
          remoteUrl,
          repositoryPath: path.join(temporaryRoot, 'control.git'),
        }),
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  async reviseMachine(
    input: ReviseCollaborationMachineInput,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(input.groupId);
    await this.append(
      input.groupId,
      await this.identityFor(group),
      (history) => {
        const requiredRoles = Object.values(input.roles).map((role) => ({
          role: role.role,
          min_members: role.cardinality.min,
          max_members: role.cardinality.max,
        }));
        const revised = validateRepositoryDefinition({
          group: {
            ...history.definition.group,
            required_roles: requiredRoles,
          },
          machine: input.machine,
          roles: input.roles,
          actions: {},
          implementations: {},
          layout: history.definition.layout,
        });
        const invalidatedStateIds = Object.entries(
          history.projection.stateImplementations,
        )
          .filter(([stateId, active]) => {
            const state = revised.machine.states[stateId];
            return (
              !state ||
              state.terminal ||
              state.owner_role !== active.implementation.role
            );
          })
          .map(([stateId]) => stateId)
          .sort();
        const files: CollaborationMaterializedFile[] = [
          {
            path: 'group.yaml',
            contents: YAML.stringify(revised.group),
          },
          {
            path: revised.group.machine_ref,
            contents: YAML.stringify(revised.machine),
          },
          ...Object.values(revised.roles).map((role) => ({
            path: `groups/roles/${role.role}.yaml`,
            contents: YAML.stringify(role),
          })),
          ...Object.keys(history.definition.roles)
            .filter((role) => !revised.roles[role])
            .map((role) => ({
              path: `groups/roles/${role}.yaml`,
              contents: null,
            })),
        ];
        for (const stateId of invalidatedStateIds) {
          const active = history.projection.stateImplementations[stateId];
          if (!active) continue;
          files.push({ path: active.implementationRef, contents: null });
          if (active.implementation.action_ref)
            files.push({
              path: active.implementation.action_ref,
              contents: null,
            });
          if (active.action?.input.prompt_ref)
            files.push({
              path: active.action.input.prompt_ref,
              contents: null,
            });
        }
        return {
          type: 'machine_revised',
          payload: {
            machine: revised.machine,
            roles: revised.roles,
            machine_hash: collaborationCanonicalHash(revised.machine),
            definition_hash: collaborationCanonicalHash({
              machine: revised.machine,
              roles: revised.roles,
            }),
            invalidated_state_ids: invalidatedStateIds,
          },
          files,
        };
      },
      input.expectedRevision,
    );
    return this.requireGroup(input.groupId);
  }

  async updateMachineLayout(
    input: UpdateCollaborationMachineLayoutInput,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(input.groupId);
    await this.append(
      input.groupId,
      await this.identityFor(group),
      () => ({
        type: 'machine_layout_updated',
        payload: {
          layout: input.layout,
          layout_hash: collaborationCanonicalHash(input.layout),
        },
        files: [
          { path: 'layout.yaml', contents: YAML.stringify(input.layout) },
        ],
      }),
      input.expectedRevision,
    );
    return this.requireGroup(input.groupId);
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
    if (
      !role.required_capabilities.every((capability) =>
        input.capabilities.includes(capability),
      )
    )
      throw new Error(`Member lacks capabilities for role ${input.role}`);
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
    const members = history.projection.members[identity.principalId] ?? [];
    if (
      members.some(
        (member) =>
          member.signing_key_ref !== identity.keyRef ||
          member.signing_public_key !== identity.publicKey,
      )
    )
      throw new Error(
        'Principal is already registered with a different signing key',
      );
    if (!members.some((member) => member.agent_id === identity.agentId)) {
      const eventId = identifier('evt');
      history = await this.append(groupId, identity, () => ({
        type: 'member_registered',
        eventId,
        payload: {
          member: {
            format: 'icarus.agent-group-member/2',
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
    if (
      !(history.projection.roleClaims[input.role] ?? []).some(
        (claim) =>
          claim.principal_id === identity.principalId &&
          claim.agent_id === identity.agentId,
      )
    )
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

  getValidationMetrics(groupId: string): CollaborationValidationMetrics | null {
    return this.histories.get(groupId)?.validation ?? null;
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
        checkpoint: this.checkpointFor(group),
      });
      this.persistHistory(history);
      this.store.recordSyncSuccess(groupId, group.pollIntervalMs, this.now());
      return history;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CollaborationProtocolError)
        this.store.markProtocolBlocked(
          groupId,
          error.code === 'PROTOCOL_VERSION_UNSUPPORTED'
            ? 'PROTOCOL_VERSION_UNSUPPORTED'
            : 'PROTOCOL_QUARANTINED',
          message,
          group.headCommit,
          this.now(),
          group.pollIntervalMs,
        );
      else
        this.store.recordSyncFailure(
          groupId,
          message,
          group.pollIntervalMs,
          this.now(),
        );
      throw error;
    }
  }

  async claimRole(
    groupId: string,
    role: string,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireGroup(groupId);
    const history = await this.syncHistory(groupId);
    if (
      !findCollaborationMember(
        history.projection,
        group.localPrincipalId,
        group.localAgentId,
      )
    )
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

  async releaseRole(
    groupId: string,
    role: string,
    expectedRevision: number,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireGroup(groupId);
    await this.append(
      groupId,
      await this.identityFor(group),
      () => ({
        type: 'role_released',
        payload: {
          role,
          principal_id: group.localPrincipalId,
          agent_id: group.localAgentId,
        },
      }),
      expectedRevision,
    );
    return this.requireGroup(groupId);
  }

  async publishStateImplementation(
    input: PublishStateImplementationInput,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireGroup(input.groupId);
    const identity = await this.identityFor(group);
    await this.append(
      input.groupId,
      identity,
      (history) => {
        const state = history.definition.machine.states[input.stateId];
        if (!state || state.terminal || !state.owner_role)
          throw new Error(`State cannot be implemented: ${input.stateId}`);
        const existing = history.projection.stateImplementations[input.stateId];
        const eventId = identifier('evt');
        const implementationRef = `groups/implementations/${state.owner_role}/${input.stateId}.yaml`;
        const actionId = input.action?.actionId ?? `execute-${input.stateId}`;
        const actionRef =
          input.mode === 'manual'
            ? null
            : `actions/${state.owner_role}/${input.stateId}/${actionId}.yaml`;
        const promptRef =
          input.mode === 'manual'
            ? null
            : `prompts/${state.owner_role}/${input.stateId}/${actionId}.md`;
        if (input.mode === 'manual' && input.action)
          throw new Error('Manual implementation cannot define an action');
        if (input.mode !== 'manual' && !input.action)
          throw new Error(`${input.mode} implementation requires an action`);
        const implementation: StateImplementation = {
          format: 'icarus.agent-group-state-implementation/2',
          role: state.owner_role,
          state_id: input.stateId,
          owner: {
            principal_id: identity.principalId,
            agent_id: identity.agentId,
          },
          mode: input.mode,
          action_ref: actionRef,
          published_at_event: eventId,
        };
        const action: ActionDefinition | null =
          input.action && actionRef && promptRef
            ? {
                format: 'icarus.agent-group-action/2',
                action_id: actionId,
                role: state.owner_role,
                state_id: input.stateId,
                kind: input.action.kind,
                ...(input.action.adapter
                  ? { adapter: input.action.adapter }
                  : {}),
                input: {
                  prompt_ref: promptRef,
                  ...(input.action.workflowRef
                    ? { workflow_ref: input.action.workflowRef }
                    : {}),
                },
                requirements: {
                  filesystem_access: input.action.filesystemAccess,
                },
                result_schema: {
                  ref: 'collaboration-state-result@2',
                  ...(input.action.resultSchema
                    ? { schema: { ...input.action.resultSchema } }
                    : {}),
                },
              }
            : null;
        return {
          type: existing
            ? 'state_implementation_revised'
            : 'state_implementation_published',
          eventId,
          payload: {
            implementation,
            implementation_ref: implementationRef,
            implementation_hash: collaborationCanonicalHash(implementation),
            action,
            action_hash: action ? collaborationCanonicalHash(action) : null,
            prompt_hash: input.action ? hash(input.action.prompt) : null,
          },
          files: [
            {
              path: implementationRef,
              contents: YAML.stringify(implementation),
            },
            ...(action && actionRef && promptRef && input.action
              ? [
                  { path: actionRef, contents: YAML.stringify(action) },
                  { path: promptRef, contents: input.action.prompt },
                ]
              : []),
            ...(existing?.implementation.action_ref &&
            existing.implementation.action_ref !== actionRef
              ? [
                  {
                    path: existing.implementation.action_ref,
                    contents: null,
                  },
                ]
              : []),
            ...(existing?.action?.input.prompt_ref &&
            existing.action.input.prompt_ref !== promptRef
              ? [
                  {
                    path: existing.action.input.prompt_ref,
                    contents: null,
                  },
                ]
              : []),
          ],
        };
      },
      input.expectedRevision,
    );
    return this.requireGroup(input.groupId);
  }

  async withdrawStateImplementation(
    groupId: string,
    stateId: string,
    expectedRevision: number,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireGroup(groupId);
    await this.append(
      groupId,
      await this.identityFor(group),
      (history) => {
        const active = history.projection.stateImplementations[stateId];
        if (!active)
          throw new Error(`State implementation does not exist: ${stateId}`);
        return {
          type: 'state_implementation_withdrawn',
          payload: { state_id: stateId, role: active.implementation.role },
          files: [
            { path: active.implementationRef, contents: null },
            ...(active.implementation.action_ref
              ? [{ path: active.implementation.action_ref, contents: null }]
              : []),
            ...(active.action?.input.prompt_ref
              ? [{ path: active.action.input.prompt_ref, contents: null }]
              : []),
          ],
        };
      },
      expectedRevision,
    );
    return this.requireGroup(groupId);
  }

  async start(
    groupId: string,
    expectedRevision?: number,
    initialHandoff?: {
      summary: string;
      instruction?: string;
      markers?: readonly string[];
      data?: Readonly<Record<string, unknown>>;
    } | null,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    await this.append(
      groupId,
      await this.identityFor(group),
      () => {
        const envelope = initialHandoff
          ? handoffEnvelopeSchema.parse({
              format: 'icarus.agent-group-handoff/2',
              source_turn_id: 'initial',
              outcome: 'initial',
              summary: initialHandoff.summary,
              instruction: initialHandoff.instruction ?? '',
              markers: initialHandoff.markers ?? [],
              data_refs: [],
              artifact_refs: [],
              data: initialHandoff.data ?? {},
            })
          : null;
        return {
          type: 'group_started',
          payload: {
            initial_handoff: envelope,
            initial_handoff_hash: envelope
              ? collaborationCanonicalHash(envelope)
              : null,
          },
        };
      },
      expectedRevision,
    );
    await this.ensureTurn(groupId);
    return this.requireGroup(groupId);
  }

  async pause(
    groupId: string,
    expectedRevision?: number,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    const history = await this.append(
      groupId,
      await this.identityFor(group),
      () => ({ type: 'group_pause_requested', payload: {} }),
      expectedRevision,
    );
    const activeTurn = history.projection.activeTurnId
      ? history.projection.turns[history.projection.activeTurnId]
      : null;
    if (activeTurn?.state === 'PENDING_START')
      await this.append(groupId, await this.identityFor(group), () => ({
        type: 'turn_cancelled',
        payload: {
          turn_id: activeTurn.turnId,
          attempt: activeTurn.attempt,
          fencing_token: null,
          reason: 'Group paused before the turn was started',
        },
      }));
    if (!activeTurn || activeTurn.state === 'PENDING_START')
      await this.append(groupId, await this.identityFor(group), () => ({
        type: 'group_paused',
        payload: {},
      }));
    return this.requireGroup(groupId);
  }

  async finishDrainingLifecycle(
    groupId: string,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    const history = await this.syncHistory(groupId);
    if (history.projection.activeTurnId) return group;
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

  async resume(
    groupId: string,
    expectedRevision?: number,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    await this.append(
      groupId,
      await this.identityFor(group),
      () => ({ type: 'group_resumed', payload: {} }),
      expectedRevision,
    );
    await this.ensureTurn(groupId);
    return this.requireGroup(groupId);
  }

  async close(
    groupId: string,
    reason: string,
    expectedRevision?: number,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    const history = await this.append(
      groupId,
      await this.identityFor(group),
      () => ({ type: 'group_close_requested', payload: { reason } }),
      expectedRevision,
    );
    const activeTurn = history.projection.activeTurnId
      ? history.projection.turns[history.projection.activeTurnId]
      : null;
    if (activeTurn?.state === 'PENDING_START')
      await this.append(groupId, await this.identityFor(group), () => ({
        type: 'turn_cancelled',
        payload: {
          turn_id: activeTurn.turnId,
          attempt: activeTurn.attempt,
          fencing_token: null,
          reason,
        },
      }));
    if (!activeTurn || activeTurn.state === 'PENDING_START')
      await this.append(groupId, await this.identityFor(group), () => ({
        type: 'group_closed',
        payload: { reason },
      }));
    return this.requireGroup(groupId);
  }

  async ensureTurn(
    groupId: string,
    expectedRevision?: number,
  ): Promise<ValidatedCollaborationHistory | null> {
    const group = this.requireCreator(groupId);
    const history = await this.syncHistory(groupId);
    if (
      history.projection.lifecycle !== 'RUNNING' ||
      history.projection.activeTurnId
    )
      return history;
    const stateId = history.projection.businessState;
    const state = history.definition.machine.states[stateId];
    if (!state || state.terminal) return null;
    const active = history.projection.stateImplementations[stateId];
    if (!active?.active)
      throw new Error(`No active implementation exists for state ${stateId}`);
    const machineHash = collaborationCanonicalHash(history.definition.machine);
    const turnId = identifier('turn');
    return this.append(
      groupId,
      await this.identityFor(group),
      (_current, occurredAt) => {
        const timeoutPolicy = state.timeout_policy ?? null;
        const startDeadlineAt = collaborationDeadlineAt(
          occurredAt,
          timeoutPolicy?.start_timeout_ms,
        );
        const inputHash = collaborationCanonicalHash({
          epoch: history.projection.epoch,
          machine_hash: machineHash,
          state_id: stateId,
          role: active.implementation.role,
          mode: active.implementation.mode,
          implementation_hash: active.implementationHash,
          action_hash: active.actionHash,
          prompt_hash: active.promptHash,
          incoming_handoff_hash: history.projection.lastHandoffHash,
          timeout_policy_snapshot: timeoutPolicy,
          start_deadline_at: startDeadlineAt,
        });
        return {
          type: 'turn_created',
          payload: {
            turn_id: turnId,
            state_id: stateId,
            role: active.implementation.role,
            mode: active.implementation.mode,
            implementation_ref: active.implementationRef,
            implementation_hash: active.implementationHash,
            action_ref: active.implementation.action_ref,
            action_hash: active.actionHash,
            prompt_hash: active.promptHash,
            incoming_handoff: history.projection.lastHandoff,
            incoming_handoff_hash: history.projection.lastHandoffHash,
            machine_hash: machineHash,
            timeout_policy_snapshot: timeoutPolicy,
            start_deadline_at: startDeadlineAt,
            deadline_snapshot_hash: collaborationDeadlineSnapshotHash({
              turnId,
              attempt: 1,
              timeoutPolicy,
              startDeadlineAt,
              startedAt: null,
              executionDeadlineAt: null,
            }),
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
        };
      },
      expectedRevision,
    );
  }

  async startCurrentTurn(
    groupId: string,
    expectedRevision?: number,
  ): Promise<{
    readonly won: boolean;
    readonly history: ValidatedCollaborationHistory;
  }> {
    const group = this.requireGroup(groupId);
    const identity = await this.identityFor(group);
    try {
      const history = await this.append(
        groupId,
        identity,
        (current, occurredAt) => {
          const turnId = current.projection.activeTurnId;
          const turn = turnId ? current.projection.turns[turnId] : null;
          if (!turn || turn.state !== 'PENDING_START')
            throw new Error('No pending turn is available');
          const eventId = identifier('evt');
          return {
            type: 'turn_started',
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
              execution_deadline_at: collaborationDeadlineAt(
                occurredAt,
                turn.timeoutPolicy?.execution_timeout_ms,
              ),
              deadline_snapshot_hash: collaborationDeadlineSnapshotHash({
                turnId: turn.turnId,
                attempt: turn.attempt,
                timeoutPolicy: turn.timeoutPolicy,
                startDeadlineAt: turn.startDeadlineAt,
                startedAt: occurredAt,
                executionDeadlineAt: collaborationDeadlineAt(
                  occurredAt,
                  turn.timeoutPolicy?.execution_timeout_ms,
                ),
              }),
            },
          };
        },
        expectedRevision,
      );
      return { won: true, history };
    } catch (error) {
      if (
        !(error instanceof CollaborationGitConflictError) &&
        !(
          error instanceof Error &&
          error.message === 'No pending turn is available'
        )
      )
        throw error;
      const history = await this.syncHistory(groupId);
      const turnId = history.projection.activeTurnId;
      const turn = turnId ? history.projection.turns[turnId] : null;
      if (!turn || turn.state === 'PENDING_START') throw error;
      return { won: false, history };
    }
  }

  async claimCurrentTurn(groupId: string) {
    return this.startCurrentTurn(groupId);
  }

  async appendActionEvent(input: {
    readonly groupId: string;
    readonly type: Extract<
      CollaborationEventType,
      | 'action_dispatched'
      | 'action_waiting_input'
      | 'action_waiting_approval'
      | 'action_completed'
      | 'turn_recovery_requested'
    >;
    readonly payload: Record<string, unknown>;
  }): Promise<ValidatedCollaborationHistory> {
    const group = this.requireGroup(input.groupId);
    return this.append(input.groupId, await this.identityFor(group), () => ({
      type: input.type,
      payload: input.payload,
    }));
  }

  async completeTurn(
    input: CompleteCollaborationTurnInput,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireGroup(input.groupId);
    const identity = await this.identityFor(group);
    const preflightHistory = await this.syncHistory(input.groupId);
    if (preflightHistory.projection.revision !== input.expectedRevision)
      throw new Error(
        `Expected revision ${String(input.expectedRevision)}, found ${String(preflightHistory.projection.revision)}`,
      );
    const sharedPaths = new Set(
      await listCollaborationSharedPaths({
        repositoryPath: group.repositoryPath,
        head: preflightHistory.head,
      }),
    );
    for (const dataRef of input.dataRefs ?? [])
      if (!sharedPaths.has(dataRef))
        throw new Error(
          `Handoff data ref does not exist at the validated head: ${dataRef}`,
        );
    const staged = this.store.getStagedArtifacts(
      input.groupId,
      input.turnId,
      input.artifactIds ?? [],
    );
    const materializedFiles: CollaborationMaterializedFile[] = [];
    const artifacts: ArtifactMetadata[] = staged.map((artifact) => {
      const stat = lstatSync(artifact.stagedPath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(
          `Staged artifact is not a regular file: ${artifact.artifactId}`,
        );
      const contents = readFileSync(artifact.stagedPath);
      if (
        contents.byteLength !== artifact.size ||
        hash(contents) !== artifact.sha256
      )
        throw new Error(
          `Staged artifact changed after upload: ${artifact.artifactId}`,
        );
      materializedFiles.push({ path: artifact.repositoryPath, contents });
      return {
        artifact_id: artifact.artifactId,
        turn_id: artifact.turnId,
        original_name: artifact.originalName,
        repository_path: artifact.repositoryPath,
        sha256: artifact.sha256,
        size: artifact.size,
        content_type: artifact.contentType,
        uploaded_by_principal_id: identity.principalId,
        uploaded_by_agent_id: identity.agentId,
        created_at: new Date(artifact.createdAtMs).toISOString(),
      };
    });
    await this.append(
      input.groupId,
      identity,
      (history) => {
        const turn = history.projection.turns[input.turnId];
        if (!turn || history.projection.activeTurnId !== input.turnId)
          throw new Error('Turn is not active');
        if (
          turn.claimantPrincipalId !== identity.principalId ||
          turn.claimantAgentId !== identity.agentId ||
          !turn.fencingToken
        )
          throw new Error('Only the current claimant can complete this turn');
        if (
          staged.some(
            (artifact) =>
              artifact.attempt !== turn.attempt ||
              artifact.principalId !== identity.principalId ||
              artifact.agentId !== identity.agentId,
          )
        )
          throw new Error(
            'Staged artifacts do not belong to the current claimant attempt',
          );
        const handoff = handoffEnvelopeSchema.parse({
          format: 'icarus.agent-group-handoff/2',
          source_turn_id: turn.turnId,
          outcome: input.outcome,
          summary: input.summary,
          instruction: input.instruction ?? '',
          markers: input.markers ?? [],
          data_refs: input.dataRefs ?? [],
          artifact_refs: artifacts.map((artifact) => artifact.repository_path),
          data: input.data ?? {},
        });
        const handoffHash = collaborationCanonicalHash(handoff);
        return {
          type: 'turn_completed',
          payload: {
            turn_id: turn.turnId,
            attempt: turn.attempt,
            fencing_token: turn.fencingToken,
            outcome: input.outcome,
            handoff,
            handoff_hash: handoffHash,
            artifacts,
            result_hash: collaborationCanonicalHash({
              outcome: input.outcome,
              handoff_hash: handoffHash,
              artifacts,
            }),
          },
          files: materializedFiles,
        };
      },
      input.expectedRevision,
    );
    this.store.commitStagedArtifacts(
      staged.map((artifact) => artifact.artifactId),
      this.now(),
    );
    for (const artifact of staged) rmSync(artifact.stagedPath, { force: true });
    return this.requireGroup(input.groupId);
  }

  stageArtifact(input: {
    readonly groupId: string;
    readonly turnId: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly stagedPath: string;
  }): CollaborationStagedArtifact {
    const group = this.requireGroup(input.groupId);
    const history = this.requireHistory(input.groupId);
    const turn = history.projection.turns[input.turnId];
    if (
      !turn ||
      history.projection.activeTurnId !== input.turnId ||
      turn.claimantPrincipalId !== group.localPrincipalId ||
      turn.claimantAgentId !== group.localAgentId
    )
      throw new Error('Only the current claimant may upload artifacts');
    if (!input.originalName || input.originalName.length > 255)
      throw new Error('Artifact name must contain 1 to 255 characters');
    if (!input.contentType || input.contentType.length > 255)
      throw new Error('Artifact content type must contain 1 to 255 characters');
    const stat = lstatSync(input.stagedPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Artifact upload must be a regular file');
    if (stat.size > MAX_COLLABORATION_ARTIFACT_BYTES)
      throw new Error('Artifact exceeds the 10 MiB file limit');
    const existing = this.store
      .listStagedArtifacts(input.groupId, input.turnId)
      .filter(
        (artifact) =>
          artifact.attempt === turn.attempt &&
          artifact.principalId === group.localPrincipalId &&
          artifact.agentId === group.localAgentId,
      );
    if (existing.length >= MAX_COLLABORATION_TURN_ARTIFACTS)
      throw new Error('Turn artifact count limit exceeded');
    if (
      existing.reduce((total, artifact) => total + artifact.size, 0) +
        stat.size >
      MAX_COLLABORATION_TURN_ARTIFACT_BYTES
    )
      throw new Error('Turn artifact size limit exceeded');
    const safeName =
      path
        .basename(input.originalName)
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .slice(0, 180) || 'artifact';
    const artifactId = identifier('artifact');
    return this.store.stageArtifact({
      artifactId,
      groupId: input.groupId,
      turnId: input.turnId,
      attempt: turn.attempt,
      principalId: group.localPrincipalId,
      agentId: group.localAgentId,
      originalName: input.originalName,
      repositoryPath: `artifacts/${turn.turnId}/${artifactId}-${safeName}`,
      stagedPath: input.stagedPath,
      sha256: hash(readFileSync(input.stagedPath)),
      size: stat.size,
      contentType: input.contentType,
      nowMs: this.now(),
    });
  }

  removeStagedArtifact(
    groupId: string,
    turnId: string,
    artifactId: string,
  ): CollaborationStagedArtifact {
    const group = this.requireGroup(groupId);
    const history = this.requireHistory(groupId);
    const turn = history.projection.turns[turnId];
    const artifact = this.store.getStagedArtifact(artifactId);
    if (
      !turn ||
      history.projection.activeTurnId !== turnId ||
      turn.claimantPrincipalId !== group.localPrincipalId ||
      turn.claimantAgentId !== group.localAgentId ||
      !artifact ||
      artifact.groupId !== groupId ||
      artifact.turnId !== turnId ||
      artifact.attempt !== turn.attempt ||
      artifact.principalId !== group.localPrincipalId ||
      artifact.agentId !== group.localAgentId
    )
      throw new Error(
        'Only the current claimant attempt may remove this artifact',
      );
    rmSync(artifact.stagedPath, { force: true });
    return this.store.removeStagedArtifact(groupId, turnId, artifactId);
  }

  async updateData(input: UpdateCollaborationDataInput) {
    const group = this.requireGroup(input.groupId);
    const repositoryPath = normalizeCollaborationDataPath(input.path);
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');
    if (sizeBytes > MAX_COLLABORATION_DATA_BYTES)
      throw new Error('Collaboration data exceeds the 1 MiB limit');
    const contentSha256 = hash(input.content);
    await this.append(
      input.groupId,
      await this.identityFor(group),
      () => ({
        type: 'data_updated',
        payload: {
          path: repositoryPath,
          encoding: 'utf-8',
          content_sha256: contentSha256,
          size_bytes: sizeBytes,
          ...(input.mediaType ? { media_type: input.mediaType } : {}),
          ...(input.turn
            ? {
                turn_id: input.turn.turnId,
                attempt: input.turn.attempt,
                fencing_token: input.turn.fencingToken,
              }
            : {}),
        },
        files: [{ path: repositoryPath, contents: input.content }],
      }),
      input.expectedRevision,
    );
    return {
      group: this.requireGroup(input.groupId),
      path: repositoryPath,
      contentSha256,
      sizeBytes,
    };
  }

  async recoverTurn(
    groupId: string,
    reason: string,
    expectedRevision?: number,
  ): Promise<CollaborationGroupRecord> {
    const group = this.requireCreator(groupId);
    const identity = await this.identityFor(group);
    await this.append(
      groupId,
      identity,
      (history) => {
        const turn = history.projection.activeTurnId
          ? history.projection.turns[history.projection.activeTurnId]
          : null;
        if (!turn?.fencingToken)
          throw new Error('No started turn can be recovered');
        return {
          type: 'turn_recovery_requested',
          payload: {
            turn_id: turn.turnId,
            attempt: turn.attempt,
            fencing_token: turn.fencingToken,
            reason,
          },
        };
      },
      expectedRevision,
    );
    await this.append(groupId, identity, (history, occurredAt) => {
      const turn = history.projection.activeTurnId
        ? history.projection.turns[history.projection.activeTurnId]
        : null;
      if (!turn?.fencingToken)
        throw new Error('No recovery-required turn exists');
      return {
        type: 'turn_recovered',
        payload: {
          turn_id: turn.turnId,
          attempt: turn.attempt + 1,
          fencing_token: turn.fencingToken,
          reason,
          start_deadline_at: collaborationDeadlineAt(
            occurredAt,
            turn.timeoutPolicy?.start_timeout_ms,
          ),
          deadline_snapshot_hash: collaborationDeadlineSnapshotHash({
            turnId: turn.turnId,
            attempt: turn.attempt + 1,
            timeoutPolicy: turn.timeoutPolicy,
            startDeadlineAt: collaborationDeadlineAt(
              occurredAt,
              turn.timeoutPolicy?.start_timeout_ms,
            ),
            startedAt: null,
            executionDeadlineAt: null,
          }),
        },
      };
    });
    return this.requireGroup(groupId);
  }

  async observeTimeout(input: {
    readonly groupId: string;
    readonly turnId: string;
    readonly attempt: number;
    readonly deadlineKind: CollaborationDeadlineKind;
    readonly observedAt?: string;
  }): Promise<{
    readonly recorded: boolean;
    readonly history: ValidatedCollaborationHistory;
  }> {
    const group = this.requireGroup(input.groupId);
    const alreadyObserved = (history: ValidatedCollaborationHistory): boolean =>
      Boolean(
        history.projection.turns[input.turnId]?.timeoutObservations.some(
          (observation) =>
            observation.attempt === input.attempt &&
            observation.deadlineKind === input.deadlineKind,
        ),
      );
    let current = await this.syncHistory(input.groupId);
    if (alreadyObserved(current)) return { recorded: false, history: current };
    try {
      const history = await this.append(
        input.groupId,
        await this.identityFor(group),
        (latest, occurredAt) => {
          const turn = latest.projection.turns[input.turnId];
          if (
            !turn ||
            latest.projection.activeTurnId !== input.turnId ||
            turn.attempt !== input.attempt
          )
            throw new Error('Timeout observation targets a stale turn attempt');
          if (
            turn.timeoutObservations.some(
              (observation) =>
                observation.attempt === input.attempt &&
                observation.deadlineKind === input.deadlineKind,
            )
          )
            throw new Error('Timeout observation already exists');
          const deadlineAt =
            input.deadlineKind === 'start'
              ? turn.startDeadlineAt
              : turn.executionDeadlineAt;
          if (!deadlineAt)
            throw new Error('Turn has no deadline for this timeout kind');
          return {
            type: 'turn_timeout_observed',
            payload: {
              turn_id: turn.turnId,
              attempt: turn.attempt,
              deadline_kind: input.deadlineKind,
              deadline_at: deadlineAt,
              observed_at: input.observedAt ?? occurredAt,
              turn_snapshot_hash: turn.deadlineSnapshotHash,
            },
          };
        },
      );
      return { recorded: true, history };
    } catch (error) {
      if (
        !(error instanceof CollaborationGitConflictError) &&
        !(
          error instanceof Error &&
          error.message === 'Timeout observation already exists'
        )
      )
        throw error;
      current = await this.syncHistory(input.groupId);
      if (!alreadyObserved(current)) throw error;
      return { recorded: false, history: current };
    }
  }

  private async append(
    groupId: string,
    identity: CollaborationSigningIdentity,
    build: (
      history: ValidatedCollaborationHistory,
      occurredAt: string,
    ) => {
      readonly type: CollaborationEventType;
      readonly payload: Record<string, unknown>;
      readonly eventId?: string;
      readonly files?: readonly CollaborationMaterializedFile[];
    },
    expectedRevision?: number,
  ): Promise<ValidatedCollaborationHistory> {
    const group = this.requireGroup(groupId);
    const history = await this.transport.appendEvent({
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      previousHead: group.headCommit,
      checkpoint: this.checkpointFor(group),
      identity,
      buildEvent: (current) => {
        if (
          expectedRevision !== undefined &&
          expectedRevision !== current.projection.revision
        )
          throw new Error(
            `Expected revision ${String(expectedRevision)} does not match ${String(current.projection.revision)}`,
          );
        const occurredAt = new Date(this.now()).toISOString();
        const next = build(current, occurredAt);
        return {
          event: this.event({
            groupId,
            identity,
            eventId: next.eventId ?? identifier('evt'),
            sequence: current.projection.sequence + 1,
            revision: current.projection.revision,
            type: next.type,
            payload: next.payload,
            epoch:
              next.type === 'group_resumed' || next.type === 'machine_revised'
                ? current.projection.epoch + 1
                : current.projection.epoch,
            occurredAt,
          }),
          materializedFiles: next.files ?? [],
        };
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
    readonly epoch: number;
    readonly occurredAt?: string;
  }): CollaborationEvent {
    return collaborationEventSchema.parse({
      format: 'icarus.agent-group-event/2',
      protocol_version: COLLABORATION_PROTOCOL_VERSION,
      group_id: input.groupId,
      event_id: input.eventId,
      epoch: input.epoch,
      sequence: input.sequence,
      event_type: input.type,
      actor: {
        principal_id: input.identity.principalId,
        agent_id: input.identity.agentId,
      },
      expected: { state_revision: input.revision },
      payload: input.payload,
      occurred_at: input.occurredAt ?? new Date(this.now()).toISOString(),
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

  private checkpointFor(
    group: CollaborationGroupRecord,
  ): CollaborationValidationCheckpoint | null {
    return group.headCommit && group.projection
      ? { head: group.headCommit, projection: group.projection }
      : null;
  }

  private persistHistory(history: ValidatedCollaborationHistory): void {
    this.histories.set(history.projection.groupId, history);
    if (!this.store.getGroup(history.projection.groupId)) return;
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
        ownedStates: role.owned_states,
      })),
    };
  }

  private requireHistory(groupId: string): ValidatedCollaborationHistory {
    const history = this.histories.get(groupId);
    if (!history)
      throw new Error(
        `Collaboration group has not been synchronized: ${groupId}`,
      );
    return history;
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
