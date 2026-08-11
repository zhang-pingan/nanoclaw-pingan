import crypto from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  CollaborationProjectSpaceIdentityService,
  type CollaborationEventSigningIdentity,
} from './project-space-identity.js';
import {
  CollaborationProjectSpaceStore,
  type CollaborationLocalGroupBinding,
  type CollaborationProjectSpaceEventRecord,
  type CollaborationGroupInitializationOperation,
  type CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import {
  buildCollaborationEventV3,
  canCreateWorkflowTurnV3,
  collaborationCanonicalHashV3,
  collaborationDeadlineAtV3,
  collaborationDeadlineSnapshotHashV3,
  collaborationFencingTokenV3,
  collaborationIdempotencyKeyV3,
  collaborationMemberLeftAffectedTurnIdsV3,
  collaborationRecoveryRequestHashV3,
  collaborationRecoveryVerificationCodeV3,
  collaborationTurnCompletionHashV3,
  collaborationTurnInputHashV3,
  collaborationWorkflowDefinitionHashV3,
  hasCollaborationPermissionV3,
  reduceCollaborationEventV3,
  workflowDefinitionVersionKey,
  type CollaborationProjectionV3,
} from './protocol/v3-reducer.js';
import { COLLABORATION_CONTROL_BRANCH } from './protocol/version.js';
import {
  actionDefinitionV3Schema,
  artifactMetadataV3Schema,
  collaborationBasenameSchema,
  clientDefinitionSchema,
  credentialDefinitionSchema,
  discussionMessageSchema,
  discussionSchema,
  executorDescriptorSchema,
  machineDefinitionV3Schema,
  memberDefinitionV3Schema,
  permissionGrantSchema,
  recoveryRequestSchema,
  handoffEnvelopeV3Schema,
  stateExecutionSchema,
  collaborationTurnV3Schema,
  workflowDefinitionSchema,
  workflowInstanceSchema,
  workflowLayoutSchema,
  workItemProgressSchema,
  workItemSchema,
  type CollaborationAggregateType,
  type CollaborationEventTypeV3,
  type CollaborationEventV3,
  type CollaborationPermission,
  type CredentialDefinition,
  type ArtifactMetadataV3,
  type Discussion,
  type DiscussionMessage,
  type FileMetadata,
  type MachineDefinitionV3,
  type MemberDefinitionV3,
  type ObserverSubscription,
  type HandoffEnvelopeV3,
  type ExecutionModeV3,
  type WorkflowDefinition,
  type WorkflowInstance,
  type WorkflowLayout,
  type WorkItem,
  type WorkItemStatus,
} from './protocol/v3-schema.js';
import type { CollaborationStagedArtifactV3 } from './project-space-store.js';

export interface ValidatedProjectSpaceHistory {
  readonly head: string;
  readonly projection: CollaborationProjectionV3;
  readonly eventRecords: readonly CollaborationProjectSpaceEventRecord[];
  readonly transportGitSshKeyPath?: string;
}

export interface CollaborationProjectSpaceTransport {
  inspect(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly previousHead?: string | null;
    readonly gitSshKeyPath?: string;
    readonly gitSshKeyPaths?: readonly string[];
  }): Promise<ValidatedProjectSpaceHistory>;
  create(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath?: string;
    readonly gitSshKeyPaths?: readonly string[];
    readonly identity: CollaborationEventSigningIdentity;
    readonly genesisEvent: CollaborationEventV3;
    readonly genesisProjection: CollaborationProjectionV3;
  }): Promise<ValidatedProjectSpaceHistory>;
  reinitialize(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath: string;
    readonly identity: CollaborationEventSigningIdentity;
    readonly genesisEvent: CollaborationEventV3;
    readonly genesisProjection: CollaborationProjectionV3;
  }): Promise<ValidatedProjectSpaceHistory>;
  refreshAfterReinitialize(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath: string;
  }): Promise<ValidatedProjectSpaceHistory>;
  append(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly previousHead: string | null;
    readonly gitSshKeyPath?: string;
    readonly gitSshKeyPaths?: readonly string[];
    readonly identity: CollaborationEventSigningIdentity;
    readonly buildEvent: (history: ValidatedProjectSpaceHistory) =>
      | CollaborationEventV3
      | {
          readonly event: CollaborationEventV3;
          readonly materializedFiles: readonly {
            readonly path: string;
            readonly contents: string | Buffer | null;
          }[];
        };
  }): Promise<ValidatedProjectSpaceHistory>;
  readVerifiedFile(input: {
    readonly repositoryPath: string;
    readonly verifiedHead: string;
    readonly repositoryFile: string;
  }): Promise<Buffer>;
}

export interface ProjectSpaceInspectResult {
  readonly group: CollaborationProjectionV3['group'];
  readonly verifiedHead: string;
  readonly memberCount: number;
  readonly activeMemberCount: number;
  readonly workItemCount: number;
  readonly workflowDefinitionCount: number;
  readonly workflowInstanceCount: number;
  readonly repositoryPath: string;
  readonly projection: CollaborationProjectionV3;
}

export interface CreateProjectSpaceGroupInput {
  readonly remoteUrl: string;
  readonly name: string;
  readonly gitSshKeyPath?: string;
  readonly displayName: string;
  readonly clientDisplayName: string;
  readonly membershipPolicy: 'open' | 'approval' | 'invite_only';
  readonly observerAccess: 'allowed' | 'members_only';
  readonly groupId?: string;
  readonly pollIntervalMs?: number;
}

export interface JoinProjectSpaceGroupInput {
  readonly remoteUrl: string;
  readonly gitSshKeyPath?: string;
  readonly displayName: string;
  readonly clientDisplayName: string;
  readonly inviteId?: string;
  readonly pollIntervalMs?: number;
}

export interface ProjectSpaceStagedArtifactResult {
  readonly metadata: ArtifactMetadataV3;
  readonly artifactRef: string;
}

export interface CollaborationLocalGroupRemovalResult {
  readonly groupId: string;
  readonly removed: boolean;
  readonly cleanupPending: boolean;
  readonly cleanupError: string | null;
}

export type CollaborationLocalGroupCleanup = (
  paths: readonly string[],
) => Promise<void>;

export const MAX_PROJECT_SPACE_FILE_BYTES = 10 * 1024 * 1024;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function buildDiscussionMessage(input: {
  readonly group: CollaborationProjectSpaceGroupRecord;
  readonly threadId: string;
  readonly messageId?: string;
  readonly body: string;
  readonly mentions?: readonly string[];
  readonly refs?: readonly string[];
  readonly executorId?: string | null;
  readonly origin?: 'human' | 'agent' | 'workflow';
  readonly now: string;
}): DiscussionMessage {
  return discussionMessageSchema.parse({
    format: 'icarus.collaboration-message/1',
    message_id: input.messageId ?? newId('message'),
    thread_id: input.threadId,
    author_principal_id: input.group.localPrincipalId,
    actor_client_id: input.group.localClientId,
    executor_id: input.executorId ?? null,
    origin: input.origin ?? 'human',
    body: input.body,
    mentions: [...(input.mentions ?? [])],
    refs: [...(input.refs ?? [])],
    revision: 1,
    tombstoned: false,
    created_at: input.now,
    updated_at: input.now,
  });
}

function sharedCredential(
  identity: CollaborationEventSigningIdentity,
  eventId: string,
): CredentialDefinition {
  return credentialDefinitionSchema.parse({
    format: 'icarus.collaboration-credential/1',
    credential_id: identity.credentialId,
    principal_id: identity.principalId,
    client_id: identity.clientId,
    public_key: identity.publicKey,
    fingerprint: identity.fingerprint,
    purpose: identity.purpose,
    status: 'active',
    created_at_event: eventId,
    revoked_at_event: null,
  });
}

export function collaborationProjectSpaceRepositoryPath(
  repositoryRoot: string,
  remoteUrl: string,
): string {
  const digest = crypto.createHash('sha256').update(remoteUrl).digest('hex');
  return path.join(repositoryRoot, `${digest}.git`);
}

function buildGroupGenesis(input: {
  readonly groupId: string;
  readonly name: string;
  readonly displayName: string;
  readonly clientDisplayName: string;
  readonly membershipPolicy: 'open' | 'approval' | 'invite_only';
  readonly observerAccess: 'allowed' | 'members_only';
  readonly identity: CollaborationEventSigningIdentity;
  readonly recoveryIdentity: CollaborationEventSigningIdentity;
  readonly occurredAt: string;
}): {
  readonly event: CollaborationEventV3;
  readonly projection: CollaborationProjectionV3;
} {
  const eventId = newId('evt');
  const member: MemberDefinitionV3 = memberDefinitionV3Schema.parse({
    format: 'icarus.collaboration-member/3',
    principal_id: input.identity.principalId,
    display_name: input.displayName,
    status: 'active',
    joined_at_event: eventId,
  });
  const client = {
    format: 'icarus.collaboration-client/1' as const,
    principal_id: input.identity.principalId,
    client_id: input.identity.clientId,
    display_name: input.clientDisplayName,
    capabilities: [],
    status: 'active' as const,
    registered_at_event: eventId,
  };
  const ownerPermissions = permissionGrantSchema.parse({
    format: 'icarus.collaboration-permission-grant/1',
    principal_id: input.identity.principalId,
    grants: [],
    revision: 1,
    updated_at_event: eventId,
  });
  const event = buildCollaborationEventV3({
    groupId: input.groupId,
    eventId,
    aggregateType: 'group',
    aggregateId: input.groupId,
    aggregateRevision: 1,
    previousEventHash: null,
    eventType: 'group_initialized',
    actor: {
      principal_id: input.identity.principalId,
      client_id: input.identity.clientId,
      credential_id: input.identity.credentialId,
      executor_id: null,
    },
    occurredAt: input.occurredAt,
    payload: {
      group: {
        format: 'icarus.collaboration-group/3',
        protocol_version: 3,
        group_id: input.groupId,
        name: input.name,
        creator: { principal_id: input.identity.principalId },
        owner_principal_id: input.identity.principalId,
        control_branch: COLLABORATION_CONTROL_BRANCH,
        lifecycle: 'active',
        membership_policy: { join: input.membershipPolicy },
        visibility_policy: { observer_access: input.observerAccess },
        created_at: input.occurredAt,
        archived_at: null,
        dissolved_at: null,
      },
      member,
      client,
      credential: sharedCredential(input.identity, eventId),
      recovery_credential: sharedCredential(input.recoveryIdentity, eventId),
      owner_permissions: ownerPermissions,
    },
  });
  return { event, projection: reduceCollaborationEventV3(null, event) };
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..'
  );
}

async function removeCollaborationLocalPaths(
  repositoryRoot: string,
  databasePath: string,
  paths: readonly string[],
): Promise<void> {
  const allowedRoots = [
    path.resolve(repositoryRoot),
    path.resolve(path.dirname(databasePath), 'collaboration-staged-artifacts'),
  ];
  for (const cleanupPath of paths) {
    const resolved = path.resolve(cleanupPath);
    if (!allowedRoots.some((root) => pathIsInside(root, resolved)))
      throw new Error(
        `Refusing unsafe Collaboration cleanup path: ${resolved}`,
      );
    await rm(resolved, { recursive: true, force: true });
  }
}

export class CollaborationProjectSpaceService {
  private readonly histories = new Map<string, ValidatedProjectSpaceHistory>();
  private readonly repositoryOperations = new Map<string, Promise<void>>();
  private readonly cleanupLocalPaths: CollaborationLocalGroupCleanup;

  constructor(
    readonly store: CollaborationProjectSpaceStore,
    readonly transport: CollaborationProjectSpaceTransport,
    private readonly repositoryRoot: string,
    private readonly identities: CollaborationProjectSpaceIdentityService,
    private readonly now: () => number = Date.now,
    cleanupLocalPaths?: CollaborationLocalGroupCleanup,
  ) {
    this.cleanupLocalPaths =
      cleanupLocalPaths ??
      ((paths) =>
        removeCollaborationLocalPaths(
          this.repositoryRoot,
          this.store.databasePath,
          paths,
        ));
  }

  async inspectRemote(remoteUrl: string): Promise<ProjectSpaceInspectResult> {
    const repositoryPath = collaborationProjectSpaceRepositoryPath(
      this.repositoryRoot,
      remoteUrl,
    );
    const history = await this.transport.inspect({
      remoteUrl,
      repositoryPath,
      gitSshKeyPaths: this.identities.resolveGitSshKeyCandidates(),
    });
    return this.inspectResult(history, repositoryPath);
  }

  async createGroup(
    input: CreateProjectSpaceGroupInput,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const identity = await this.identities.createPrincipalIdentity();
    const recoveryIdentity = await this.identities.createCredentialIdentity({
      principalId: identity.principalId,
      clientId: identity.clientId,
      purpose: 'group_recovery',
    });
    const gitSshKeyPaths = this.identities.resolveGitSshKeyCandidates(
      input.gitSshKeyPath,
    );
    const groupId = input.groupId ?? newId('group');
    const occurredAt = new Date(this.now()).toISOString();
    const { event, projection } = buildGroupGenesis({
      groupId,
      name: input.name,
      displayName: input.displayName,
      clientDisplayName: input.clientDisplayName,
      membershipPolicy: input.membershipPolicy,
      observerAccess: input.observerAccess,
      identity,
      recoveryIdentity,
      occurredAt,
    });
    const repositoryPath = collaborationProjectSpaceRepositoryPath(
      this.repositoryRoot,
      input.remoteUrl,
    );
    const history = await this.transport.create({
      remoteUrl: input.remoteUrl,
      repositoryPath,
      gitSshKeyPaths,
      identity,
      genesisEvent: event,
      genesisProjection: projection,
    });
    this.registerLocalGroup({
      history,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      mode: 'member',
      identity,
      recoveryIdentity,
      gitSshKeyPath: history.transportGitSshKeyPath ?? gitSshKeyPaths[0]!,
      pollIntervalMs: input.pollIntervalMs,
    });
    return this.store.getGroup(groupId)!;
  }

  async initializeGroup(
    groupId: string,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const current = this.store.getGroup(groupId);
    const projection = current?.projection;
    if (
      !current ||
      !projection ||
      current.subscriptionMode !== 'member' ||
      !current.localPrincipalId ||
      current.localPrincipalId !== projection.group.owner_principal_id ||
      current.localPrincipalId !== current.ownerPrincipalId ||
      !current.localClientId ||
      !current.localCredentialId ||
      projection.members[current.localPrincipalId]?.status !== 'active' ||
      projection.clients[current.localPrincipalId]?.[current.localClientId]
        ?.status !== 'active' ||
      projection.credentials[current.localPrincipalId]?.[
        current.localCredentialId
      ]?.status !== 'active'
    )
      throw new Error('Only the current Group Owner may initialize the Group');
    if (!['active', 'archived'].includes(current.lifecycle))
      throw new Error('Only an active or archived Group may be initialized');

    return this.withRepositoryOperation(current.repositoryPath, async () => {
      await this.syncUnlocked(groupId);
      const group = this.store.getGroup(groupId);
      const latest = group?.projection;
      if (
        !group ||
        !latest ||
        group.subscriptionMode !== 'member' ||
        !['active', 'archived'].includes(group.lifecycle) ||
        !group.localPrincipalId ||
        group.localPrincipalId !== latest.group.owner_principal_id ||
        group.localPrincipalId !== group.ownerPrincipalId ||
        !group.localClientId ||
        !group.localCredentialId ||
        latest.members[group.localPrincipalId]?.status !== 'active' ||
        latest.clients[group.localPrincipalId]?.[group.localClientId]
          ?.status !== 'active' ||
        latest.credentials[group.localPrincipalId]?.[group.localCredentialId]
          ?.status !== 'active'
      )
        throw new Error(
          'Only the current Group Owner may initialize the Group',
        );
      if (
        this.store
          .listGroupInitializations()
          .some((operation) => operation.oldGroupId === groupId)
      )
        throw new Error(
          'This Group already has an initialization pending local recovery',
        );
      const oldOwner = latest.members[group.localPrincipalId];
      const oldClient =
        latest.clients[group.localPrincipalId]?.[group.localClientId!];
      if (!oldOwner || !oldClient)
        throw new Error('The current Owner identity is incomplete');

      const operationId = newId('initialization');
      const newGroupId = newId('group');
      const principalId = newId('principal');
      const clientId = newId('client');
      const credentialId = newId('credential');
      const recoveryCredentialId = newId('credential');
      let operation = this.store.prepareGroupInitialization({
        operationId,
        oldGroupId: groupId,
        newGroupId,
        principalId,
        clientId,
        credentialId,
        recoveryCredentialId,
        nowMs: this.now(),
      });
      let pushed = false;
      try {
        const identity = await this.identities.createPrincipalIdentity({
          freshClient: true,
          principalId,
          clientId,
          credentialId,
        });
        const recoveryIdentity = await this.identities.createCredentialIdentity(
          {
            principalId,
            clientId,
            credentialId: recoveryCredentialId,
            purpose: 'group_recovery',
          },
        );
        const genesis = buildGroupGenesis({
          groupId: newGroupId,
          name: latest.group.name,
          displayName: oldOwner.display_name,
          clientDisplayName: oldClient.display_name,
          membershipPolicy: latest.group.membership_policy.join,
          observerAccess: latest.group.visibility_policy.observer_access,
          identity,
          recoveryIdentity,
          occurredAt: new Date(this.now()).toISOString(),
        });
        operation = this.store.beginGroupInitialization({
          operationId,
          identity,
          recoveryIdentity,
          nowMs: this.now(),
        });
        const history = await this.transport.reinitialize({
          remoteUrl: group.remoteUrl,
          repositoryPath: group.repositoryPath,
          gitSshKeyPath: group.gitSshKeyPath,
          identity,
          genesisEvent: genesis.event,
          genesisProjection: genesis.projection,
        });
        pushed = true;
        this.store.markGroupInitializationPushed(
          operation.operationId,
          history.head,
          this.now(),
        );
        const initialized = await this.finishGroupInitialization(
          operation,
          history,
        );
        if (!initialized)
          throw new Error(
            'Another Owner initialized this members-only Group; explicitly join or recover an identity to access it',
          );
        return initialized;
      } catch (error) {
        if (!pushed) {
          try {
            await this.discardPreparedInitialization(operation);
          } catch (cleanupError) {
            throw new Error(
              `Group initialization failed before the remote rewrite and generated Credential cleanup remains pending: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              { cause: new AggregateError([error, cleanupError]) },
            );
          }
          throw error;
        }
        if (!this.store.getGroupInitialization(operation.operationId))
          throw error;
        throw new Error(
          `The remote Group was initialized, but local replacement is pending and will retry on restart: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  async recoverInterruptedInitializations(): Promise<
    readonly CollaborationProjectSpaceGroupRecord[]
  > {
    const recovered: CollaborationProjectSpaceGroupRecord[] = [];
    const failures: Error[] = [];
    for (const operation of this.store.listGroupInitializations()) {
      try {
        await this.withRepositoryOperation(
          operation.repositoryPath,
          async () => {
            const history = await this.transport.refreshAfterReinitialize({
              remoteUrl: operation.remoteUrl,
              repositoryPath: operation.repositoryPath,
              gitSshKeyPath: operation.gitSshKeyPath,
            });
            if (
              history.projection.groupId === operation.oldGroupId &&
              operation.phase === 'prepared'
            ) {
              await this.discardPreparedInitialization(operation);
              return;
            }
            if (history.projection.groupId === operation.oldGroupId)
              throw new Error(
                `Initialization ${operation.operationId} was pushed but the remote still exposes the old Group`,
              );
            const group = await this.finishGroupInitialization(
              operation,
              history,
              true,
            );
            if (group) recovered.push(group);
          },
        );
      } catch (error) {
        failures.push(
          new Error(
            `Initialization ${operation.operationId} remains pending: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        );
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `${String(failures.length)} Collaboration Group initialization recovery operation(s) remain pending`,
      );
    return recovered;
  }

  async observeGroup(input: {
    readonly remoteUrl: string;
    readonly gitSshKeyPath?: string;
    readonly pollIntervalMs?: number;
    readonly notificationsEnabled?: boolean;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const repositoryPath = collaborationProjectSpaceRepositoryPath(
      this.repositoryRoot,
      input.remoteUrl,
    );
    const gitSshKeyPaths = this.identities.resolveGitSshKeyCandidates(
      input.gitSshKeyPath,
    );
    const history = await this.transport.inspect({
      remoteUrl: input.remoteUrl,
      repositoryPath,
      gitSshKeyPaths,
    });
    if (history.projection.group.lifecycle === 'dissolved')
      throw new Error('Dissolved Groups cannot be observed or restored');
    await this.requireCompletedCleanup(history.projection.groupId);
    const binding = this.store.getLocalGroupBinding(history.projection.groupId);
    const identity = binding
      ? await this.restoreBoundIdentity(binding, history, ['active'])
      : null;
    const recoveryIdentity =
      binding && identity
        ? await this.restoreBoundRecoveryIdentity(binding, history)
        : null;
    if (
      !identity &&
      history.projection.group.visibility_policy.observer_access !== 'allowed'
    )
      throw new Error(
        'Group requires Git members-only read access; Observer subscription is disabled',
      );
    this.registerLocalGroup({
      history,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      mode: identity ? 'member' : 'observer',
      identity: identity ?? undefined,
      recoveryIdentity: recoveryIdentity ?? undefined,
      gitSshKeyPath: history.transportGitSshKeyPath ?? gitSshKeyPaths[0]!,
      pollIntervalMs: input.pollIntervalMs,
      notificationsEnabled: input.notificationsEnabled,
    });
    return this.store.getGroup(history.projection.groupId)!;
  }

  async joinGroup(
    input: JoinProjectSpaceGroupInput,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const repositoryPath = collaborationProjectSpaceRepositoryPath(
      this.repositoryRoot,
      input.remoteUrl,
    );
    const existingByLocator = this.store
      .listGroups()
      .find((group) => group.remoteUrl === input.remoteUrl);
    const gitSshKeyPaths = this.identities.resolveGitSshKeyCandidates(
      input.gitSshKeyPath ?? existingByLocator?.gitSshKeyPath,
    );
    const inspected = await this.transport.inspect({
      remoteUrl: input.remoteUrl,
      repositoryPath,
      gitSshKeyPaths,
    });
    if (inspected.projection.group.lifecycle === 'dissolved')
      throw new Error('Dissolved Groups cannot accept membership');
    if (inspected.projection.group.lifecycle !== 'active')
      throw new Error('Archived Groups must be reopened before joining');
    await this.requireCompletedCleanup(inspected.projection.groupId);
    const binding = this.store.getLocalGroupBinding(
      inspected.projection.groupId,
    );
    const restored = binding
      ? await this.restoreBoundIdentity(binding, inspected, [
          'active',
          'requested',
        ])
      : null;
    const gitSshKeyPath =
      inspected.transportGitSshKeyPath ?? gitSshKeyPaths[0]!;
    if (restored) {
      const recoveryIdentity = binding
        ? await this.restoreBoundRecoveryIdentity(binding, inspected)
        : null;
      const pending =
        inspected.projection.members[restored.principalId]?.status ===
        'requested';
      this.registerOrUpgradeMember({
        history: inspected,
        remoteUrl: input.remoteUrl,
        repositoryPath,
        gitSshKeyPath,
        identity: restored,
        recoveryIdentity: recoveryIdentity ?? undefined,
        pollIntervalMs: input.pollIntervalMs,
        pending,
      });
      return this.store.getGroup(inspected.projection.groupId)!;
    }
    const retainedMember = binding?.principalId
      ? inspected.projection.members[binding.principalId]
      : null;
    if (retainedMember && !['left', 'rejected'].includes(retainedMember.status))
      throw new Error(
        `Retained Principal cannot rejoin while Membership is ${retainedMember.status}`,
      );
    const identity = binding?.principalId
      ? await this.identities.createCredentialIdentity({
          principalId: binding.principalId,
          purpose: 'event_signing',
        })
      : await this.identities.createPrincipalIdentity();
    const joinPolicy = inspected.projection.group.membership_policy.join;
    const open = joinPolicy === 'open';
    if (joinPolicy === 'invite_only') {
      if (!input.inviteId)
        throw new Error('Invite-only membership requires an Invite');
      const invite = inspected.projection.invites[input.inviteId];
      if (!invite) throw new Error('Invite does not exist');
      if (invite.status !== 'active') throw new Error('Invite is not active');
      if (
        invite.expires_at !== null &&
        Date.parse(invite.expires_at) <= this.now()
      )
        throw new Error('Invite has expired');
    } else if (input.inviteId) {
      throw new Error('This Group membership policy does not accept Invites');
    }
    const eventId = newId('evt');
    const client = {
      format: 'icarus.collaboration-client/1' as const,
      principal_id: identity.principalId,
      client_id: identity.clientId,
      display_name: input.clientDisplayName,
      capabilities: [],
      status: 'active' as const,
      registered_at_event: eventId,
    };
    const history = await this.appendWithIdentity({
      history: inspected,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      gitSshKeyPath,
      identity,
      aggregateType: 'membership',
      aggregateId: identity.principalId,
      eventType: open ? 'member_registered' : 'membership_requested',
      payload: {
        member: {
          format: 'icarus.collaboration-member/3',
          principal_id: identity.principalId,
          display_name: input.displayName,
          status: open ? 'active' : 'requested',
          joined_at_event: open ? eventId : null,
        },
        client,
        credential: {
          ...sharedCredential(identity, eventId),
          created_at_event: eventId,
        },
        ...(!open
          ? { invite_id: joinPolicy === 'invite_only' ? input.inviteId : null }
          : {}),
      },
      eventId,
    });
    this.registerOrUpgradeMember({
      history,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      gitSshKeyPath,
      identity,
      pollIntervalMs: input.pollIntervalMs,
      pending: !open,
    });
    return this.store.getGroup(history.projection.groupId)!;
  }

  async issueInvite(input: {
    readonly groupId: string;
    readonly expiresAt?: string | null;
    readonly expectedRevision?: number;
    readonly inviteId?: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.store.getGroup(input.groupId);
    if (!group?.localPrincipalId)
      throw new Error('Observer subscriptions cannot issue Invites');
    const inviteId = input.inviteId ?? newId('invite');
    const invite = {
      format: 'icarus.collaboration-invite/1',
      invite_id: inviteId,
      issued_by_principal_id: group.localPrincipalId,
      status: 'active',
      issued_at: '__OCCURRED_AT__',
      expires_at: input.expiresAt ?? null,
      used_at_event: null,
      revoked_at_event: null,
    };
    return this.appendLocal(input.groupId, {
      aggregateType: 'invite',
      aggregateId: inviteId,
      expectedRevision: input.expectedRevision ?? 0,
      eventType: 'invite_issued',
      payload: { invite },
      replaceEventId: true,
    });
  }

  async revokeInvite(input: {
    readonly groupId: string;
    readonly inviteId: string;
    readonly reason: string;
    readonly expectedRevision: number;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'invite',
      aggregateId: input.inviteId,
      expectedRevision: input.expectedRevision,
      eventType: 'invite_revoked',
      payload: { reason: input.reason },
    });
  }

  async approveMembership(
    groupId: string,
    principalId: string,
    expectedRevision: number,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const history = await this.sync(groupId);
    const requested = history.projection.members[principalId];
    if (!requested || requested.status !== 'requested')
      throw new Error('Membership request is not pending');
    return this.appendLocal(groupId, {
      aggregateType: 'membership',
      aggregateId: principalId,
      expectedRevision,
      eventType: 'member_registered',
      payload: {
        member: {
          ...requested,
          status: 'active',
          joined_at_event: '__EVENT_ID__',
        },
      },
      replaceEventId: true,
    });
  }

  async rejectMembership(
    groupId: string,
    principalId: string,
    reason: string,
    expectedRevision: number,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(groupId, {
      aggregateType: 'membership',
      aggregateId: principalId,
      expectedRevision,
      eventType: 'membership_rejected',
      payload: { principal_id: principalId, reason },
    });
  }

  async updatePermissions(input: {
    readonly groupId: string;
    readonly principalId: string;
    readonly grants: readonly CollaborationPermission[];
    readonly expectedRevision: number;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const eventId = newId('evt');
    const history = await this.requireHistory(input.groupId);
    const currentGrant = history.projection.permissionGrants[input.principalId];
    const grant = permissionGrantSchema.parse({
      format: 'icarus.collaboration-permission-grant/1',
      principal_id: input.principalId,
      grants: [...new Set(input.grants)],
      revision: (currentGrant?.revision ?? 0) + 1,
      updated_at_event: eventId,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'membership',
      aggregateId: input.principalId,
      expectedRevision: input.expectedRevision,
      eventType:
        grant.grants.length > 0 ? 'permission_granted' : 'permission_revoked',
      payload: { grant },
      eventId,
    });
  }

  async requestIdentityRecovery(input: {
    readonly groupId: string;
    readonly targetPrincipalId: string;
    readonly type: 'identity_recovery' | 'owner_recovery';
    readonly clientDisplayName: string;
    readonly reason?: string | null;
    readonly expiresInMs?: number;
  }): Promise<{
    readonly group: CollaborationProjectSpaceGroupRecord;
    readonly requestId: string;
    readonly requestHash: string;
    readonly verificationCode: string;
  }> {
    const group = this.store.getGroup(input.groupId);
    if (!group)
      throw new Error(`Collaboration Group not found: ${input.groupId}`);
    if (group.subscriptionMode !== 'observer')
      throw new Error('Identity recovery starts from an Observer subscription');
    const history = await this.sync(input.groupId);
    const target = history.projection.members[input.targetPrincipalId];
    if (!target || target.status !== 'active')
      throw new Error('Recovery target must be an active Principal');
    if (input.type === 'owner_recovery' && !input.reason?.trim())
      throw new Error('Owner recovery requires a reason');
    const identity = await this.identities.createCredentialIdentity({
      principalId: input.targetPrincipalId,
      purpose: 'event_signing',
    });
    const eventId = newId('evt');
    const requestId = newId('recovery');
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(
      this.now() + (input.expiresInMs ?? 7 * 24 * 60 * 60 * 1000),
    ).toISOString();
    const client = clientDefinitionSchema.parse({
      format: 'icarus.collaboration-client/1',
      principal_id: input.targetPrincipalId,
      client_id: identity.clientId,
      display_name: input.clientDisplayName,
      capabilities: [],
      status: 'active',
      registered_at_event: eventId,
    });
    const credential = sharedCredential(identity, eventId);
    const immutable = {
      format: 'icarus.collaboration-recovery-request/1' as const,
      request_id: requestId,
      type: input.type,
      target_principal_id: input.targetPrincipalId,
      requested_client: client,
      requested_credential: credential,
      reason: input.reason?.trim() || null,
      created_at: createdAt,
      expires_at: expiresAt,
    };
    const requestHash = collaborationRecoveryRequestHashV3(immutable);
    const request = recoveryRequestSchema.parse({
      ...immutable,
      request_hash: requestHash,
      status: 'pending',
      decided_at_event: null,
      decided_by_principal_id: null,
      decision_reason: null,
      approval_kind: null,
      revoked_credential_ids: [],
    });
    const updated = await this.appendWithIdentity({
      history,
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      gitSshKeyPath: group.gitSshKeyPath,
      identity,
      aggregateType: 'recovery',
      aggregateId: requestId,
      eventType:
        input.type === 'identity_recovery'
          ? 'identity_recovery_requested'
          : 'owner_recovery_requested',
      payload: { request },
      eventId,
    });
    this.store.updateLocalIdentity({
      groupId: input.groupId,
      subscriptionMode: 'observer',
      localPrincipalId: identity.principalId,
      localClientId: identity.clientId,
      localCredentialId: identity.credentialId,
      eventPrivateKeyPath: identity.privateKeyPath,
      eventPublicKey: identity.publicKey,
      eventFingerprint: identity.fingerprint,
    });
    this.saveHistory(input.groupId, updated);
    return {
      group: this.store.getGroup(input.groupId)!,
      requestId,
      requestHash,
      verificationCode: collaborationRecoveryVerificationCodeV3(requestHash),
    };
  }

  async decideRecovery(input: {
    readonly groupId: string;
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly decision: 'approve' | 'reject';
    readonly reason: string;
    readonly useOfflineOwnerCredential?: boolean;
    readonly revokeCredentialIds?: readonly string[];
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const history = await this.requireHistory(input.groupId);
    const request = history.projection.recoveryRequests[input.requestId];
    if (!request || request.status !== 'pending')
      throw new Error('Recovery request is not pending');
    const payload = {
      request_hash: request.request_hash,
      reason: input.reason,
      revoke_previous_credentials:
        input.decision === 'approve' &&
        request.type === 'owner_recovery' &&
        input.revokeCredentialIds === undefined,
      revoke_credential_ids:
        input.decision === 'approve' && request.type === 'owner_recovery'
          ? [...(input.revokeCredentialIds ?? [])]
          : [],
    };
    if (!input.useOfflineOwnerCredential)
      return this.appendLocal(input.groupId, {
        aggregateType: 'recovery',
        aggregateId: input.requestId,
        expectedRevision: input.expectedRevision,
        eventType:
          input.decision === 'approve'
            ? 'recovery_approved'
            : 'recovery_rejected',
        payload,
      });

    if (input.decision !== 'approve' || request.type !== 'owner_recovery')
      throw new Error('Offline Group recovery is only valid for approval');
    const group = this.store.getGroup(input.groupId);
    if (!group?.recoveryCredentialId || !group.recoveryPrivateKeyPath)
      throw new Error('No imported Group recovery Credential is available');
    const identity = await this.identities.loadCredentialIdentity(
      group.recoveryCredentialId,
    );
    const updated = await this.appendWithIdentity({
      history,
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      gitSshKeyPath: group.gitSshKeyPath,
      identity,
      aggregateType: 'recovery',
      aggregateId: input.requestId,
      eventType: 'recovery_approved',
      payload,
    });
    this.saveHistory(input.groupId, updated);
    return this.store.getGroup(input.groupId)!;
  }

  async cancelRecovery(input: {
    readonly groupId: string;
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.store.getGroup(input.groupId);
    if (
      !group ||
      !group.localPrincipalId ||
      !group.localClientId ||
      !group.localCredentialId ||
      !group.eventPrivateKeyPath ||
      !group.eventPublicKey ||
      !group.eventFingerprint
    )
      throw new Error(
        'This installation does not hold a recovery request identity',
      );
    return this.withRepositoryOperation(group.repositoryPath, async () => {
      const history = await this.syncUnlocked(input.groupId);
      const request = history.projection.recoveryRequests[input.requestId];
      if (!request || request.status !== 'pending')
        throw new Error('Recovery request is not pending');
      if (
        request.target_principal_id !== group.localPrincipalId ||
        request.requested_client.client_id !== group.localClientId ||
        request.requested_credential.credential_id !== group.localCredentialId
      )
        throw new Error('Only the requesting Client may cancel recovery');
      const revision =
        history.projection.aggregateHeads[`recovery:${input.requestId}`]
          ?.revision ?? 0;
      if (revision !== input.expectedRevision)
        throw new Error(
          `Aggregate revision conflict: expected ${String(input.expectedRevision)}, current ${String(revision)}`,
        );
      const identity: CollaborationEventSigningIdentity = {
        principalId: group.localPrincipalId,
        clientId: group.localClientId,
        credentialId: group.localCredentialId,
        privateKeyPath: group.eventPrivateKeyPath!,
        publicKey: group.eventPublicKey!,
        fingerprint: group.eventFingerprint!,
        purpose: 'event_signing',
      };
      const updated = await this.appendWithIdentity({
        history,
        remoteUrl: group.remoteUrl,
        repositoryPath: group.repositoryPath,
        gitSshKeyPath: group.gitSshKeyPath,
        identity,
        aggregateType: 'recovery',
        aggregateId: input.requestId,
        eventType: 'recovery_cancelled',
        payload: {
          request_hash: request.request_hash,
          reason: input.reason,
          revoke_previous_credentials: false,
        },
      });
      this.saveHistory(input.groupId, updated);
      return this.store.getGroup(input.groupId)!;
    });
  }

  async expireRecoveryRequests(groupId: string): Promise<number> {
    const group = this.store.getGroup(groupId);
    if (group?.subscriptionMode !== 'member') return 0;
    let history = await this.requireHistory(groupId);
    let expired = 0;
    for (const request of Object.values(history.projection.recoveryRequests)) {
      const expiryAuthority =
        request.type === 'identity_recovery'
          ? request.target_principal_id
          : history.projection.group.owner_principal_id;
      if (
        group.localPrincipalId !== expiryAuthority ||
        request.status !== 'pending' ||
        Date.parse(request.expires_at) > this.now()
      )
        continue;
      const revision =
        history.projection.aggregateHeads[`recovery:${request.request_id}`]
          ?.revision ?? 0;
      await this.appendLocal(groupId, {
        aggregateType: 'recovery',
        aggregateId: request.request_id,
        expectedRevision: revision,
        eventType: 'recovery_expired',
        payload: {
          request_hash: request.request_hash,
          reason: 'request expired',
          revoke_previous_credentials: false,
        },
      });
      expired += 1;
      history = await this.requireHistory(groupId);
    }
    return expired;
  }

  async rotateCredential(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly revokeCurrent?: boolean;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const identity = await this.identities.createCredentialIdentity({
      principalId: group.localPrincipalId!,
      clientId: group.localClientId!,
      purpose: 'event_signing',
    });
    const eventId = newId('evt');
    const updated = await this.appendLocal(input.groupId, {
      aggregateType: 'membership',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'credential_rotated',
      eventId,
      payload: {
        credential: sharedCredential(identity, eventId),
        revoke_credential_id: input.revokeCurrent
          ? group.localCredentialId
          : null,
      },
    });
    this.store.updateLocalIdentity({
      groupId: input.groupId,
      subscriptionMode: 'member',
      localPrincipalId: identity.principalId,
      localClientId: identity.clientId,
      localCredentialId: identity.credentialId,
      eventPrivateKeyPath: identity.privateKeyPath,
      eventPublicKey: identity.publicKey,
      eventFingerprint: identity.fingerprint,
    });
    return this.store.getGroup(updated.groupId)!;
  }

  async revokeCredential(input: {
    readonly groupId: string;
    readonly credentialId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    if (input.credentialId === group.localCredentialId)
      throw new Error('Rotate before revoking the currently used Credential');
    return this.appendLocal(input.groupId, {
      aggregateType: 'membership',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'credential_revoked',
      payload: {
        credential_id: input.credentialId,
        reason: input.reason,
      },
    });
  }

  async revokeClient(input: {
    readonly groupId: string;
    readonly clientId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    if (input.clientId === group.localClientId)
      throw new Error('A different active Client must revoke this Client');
    const client =
      group.projection?.clients[group.localPrincipalId!]?.[input.clientId];
    if (!client || client.status !== 'active')
      throw new Error('Client is not active for the local Principal');
    return this.appendLocal(input.groupId, {
      aggregateType: 'membership',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'client_revoked',
      payload: {
        client_id: input.clientId,
        reason: input.reason,
      },
    });
  }

  updateGitSshKeyPath(groupId: string, configured?: string | null): string {
    const resolved = this.identities.resolveGitSshKeyPath(configured);
    this.store.updateGitSshKeyPath(groupId, resolved);
    return resolved;
  }

  async exportGroupRecoveryCredential(
    groupId: string,
    destinationPath: string,
  ): Promise<string> {
    const group = this.requireLocalMember(groupId);
    if (!group.recoveryCredentialId)
      throw new Error(
        'This Client does not hold the Group recovery Credential',
      );
    return this.identities.exportRecoveryCredential(
      group.recoveryCredentialId,
      destinationPath,
    );
  }

  async importGroupRecoveryCredential(
    groupId: string,
    sourcePath: string,
  ): Promise<void> {
    const group = this.store.getGroup(groupId);
    if (!group) throw new Error(`Collaboration Group not found: ${groupId}`);
    const identity = await this.identities.importRecoveryCredential(sourcePath);
    const shared =
      group.projection?.credentials[identity.principalId]?.[
        identity.credentialId
      ];
    if (
      !shared ||
      shared.status !== 'active' ||
      shared.purpose !== 'group_recovery' ||
      identity.principalId !== group.ownerPrincipalId ||
      shared.principal_id !== identity.principalId ||
      shared.client_id !== identity.clientId ||
      shared.public_key !== identity.publicKey ||
      shared.fingerprint !== identity.fingerprint
    )
      throw new Error(
        'Imported Credential does not match the active Group Owner recovery record',
      );
    if (
      group.localPrincipalId &&
      group.localClientId &&
      group.localCredentialId &&
      group.eventPrivateKeyPath &&
      group.eventPublicKey &&
      group.eventFingerprint
    )
      this.store.updateLocalIdentity({
        groupId,
        subscriptionMode: group.subscriptionMode,
        localPrincipalId: group.localPrincipalId,
        localClientId: group.localClientId,
        localCredentialId: group.localCredentialId,
        eventPrivateKeyPath: group.eventPrivateKeyPath,
        eventPublicKey: group.eventPublicKey,
        eventFingerprint: group.eventFingerprint,
        recoveryCredentialId: identity.credentialId,
        recoveryPrivateKeyPath: identity.privateKeyPath,
      });
    else
      throw new Error(
        'Import requires a local recovery request identity for this Group',
      );
  }

  async registerExecutor(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly executorId: string;
    readonly displayName: string;
    readonly kind: 'codex' | 'workflow' | 'run_once' | 'external';
    readonly capabilities?: readonly string[];
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const eventId = newId('evt');
    const executor = executorDescriptorSchema.parse({
      format: 'icarus.collaboration-executor/1',
      principal_id: group.localPrincipalId,
      executor_id: input.executorId,
      display_name: input.displayName,
      kind: input.kind,
      capabilities: [...(input.capabilities ?? [])],
      registered_at_event: eventId,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'membership',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'executor_registered',
      payload: { executor },
      eventId,
    });
  }

  async revokeExecutor(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly executorId: string;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    return this.appendLocal(input.groupId, {
      aggregateType: 'membership',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'executor_revoked',
      payload: { executor_id: input.executorId, reason: input.reason },
    });
  }

  async archiveGroup(
    groupId: string,
    reason: string,
    expectedRevision: number,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(groupId, {
      aggregateType: 'group',
      aggregateId: groupId,
      expectedRevision,
      eventType: 'group_archived',
      payload: { reason },
    });
  }

  async reopenGroup(
    groupId: string,
    reason: string,
    expectedRevision: number,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(groupId, {
      aggregateType: 'group',
      aggregateId: groupId,
      expectedRevision,
      eventType: 'group_reopened',
      payload: { reason },
    });
  }

  async dissolveGroup(
    groupId: string,
    reason: string,
    expectedRevision: number,
  ): Promise<CollaborationLocalGroupRemovalResult> {
    return this.appendTerminalLocal(groupId, {
      expectedRevision,
      eventType: 'group_dissolved',
      reason,
      detachReason: 'group_dissolved',
      validate: (projection, principalId) => {
        if (projection.group.owner_principal_id !== principalId)
          throw new Error('Only the Group Owner may dissolve the Group');
        if (!['active', 'archived'].includes(projection.group.lifecycle))
          throw new Error('Only an active or archived Group can be dissolved');
      },
    });
  }

  async leaveGroup(
    groupId: string,
    reason: string,
    expectedRevision: number,
  ): Promise<CollaborationLocalGroupRemovalResult> {
    return this.appendTerminalLocal(groupId, {
      expectedRevision,
      eventType: 'member_left',
      reason,
      detachReason: 'member_left',
      validate: (projection, principalId) => {
        if (projection.group.owner_principal_id === principalId)
          throw new Error('The Group Owner cannot leave the Group');
        if (projection.members[principalId]?.status !== 'active')
          throw new Error('Only an active Group member may leave');
      },
    });
  }

  async removeLocalGroup(
    groupId: string,
  ): Promise<CollaborationLocalGroupRemovalResult> {
    if (!this.store.getGroup(groupId))
      throw new Error(`Collaboration Group not found: ${groupId}`);
    return this.detachAndCleanup(groupId, 'local_remove', null);
  }

  async retryLocalCleanup(
    groupId: string,
  ): Promise<CollaborationLocalGroupRemovalResult> {
    const binding = this.store.getLocalGroupBinding(groupId);
    if (!binding) throw new Error(`Local Group binding not found: ${groupId}`);
    if (binding.bindingState === 'attached') {
      const group = this.store.getGroup(groupId);
      const detachReason =
        group?.projection?.group.lifecycle === 'dissolved'
          ? 'group_dissolved'
          : group?.localPrincipalId &&
              group.projection?.members[group.localPrincipalId]?.status ===
                'left'
            ? 'member_left'
            : null;
      if (detachReason)
        return this.detachAndCleanup(
          groupId,
          detachReason,
          group?.lastVerifiedHead ?? binding.terminalHead,
        );
    }
    if (binding.bindingState !== 'cleanup_pending')
      return {
        groupId,
        removed: false,
        cleanupPending: false,
        cleanupError: null,
      };
    try {
      await this.cleanupLocalPaths(binding.cleanupPaths);
      this.store.completeLocalGroupCleanup(groupId, this.now());
      return {
        groupId,
        removed: false,
        cleanupPending: false,
        cleanupError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.failLocalGroupCleanup(groupId, message, this.now());
      return {
        groupId,
        removed: false,
        cleanupPending: true,
        cleanupError: message,
      };
    }
  }

  async retryPendingLocalCleanups(): Promise<
    CollaborationLocalGroupRemovalResult[]
  > {
    const results: CollaborationLocalGroupRemovalResult[] = [];
    const groupIds = new Set(
      this.store
        .listLocalGroupBindings({ bindingState: 'cleanup_pending' })
        .map((binding) => binding.groupId),
    );
    for (const group of this.store.listGroups())
      if (
        group.projection?.group.lifecycle === 'dissolved' ||
        (group.localPrincipalId &&
          group.projection?.members[group.localPrincipalId]?.status === 'left')
      )
        groupIds.add(group.groupId);
    for (const groupId of groupIds)
      results.push(await this.retryLocalCleanup(groupId));
    return results;
  }

  async postProgress(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly updateId?: string;
    readonly summary: string;
    readonly completed?: readonly string[];
    readonly inProgress?: readonly string[];
    readonly nextSteps?: readonly string[];
    readonly blockers?: readonly string[];
    readonly workItemRefs?: readonly string[];
    readonly workflowInstanceRefs?: readonly string[];
    readonly artifactRefs?: readonly string[];
    readonly executorId?: string | null;
    readonly origin?: 'human' | 'agent' | 'workflow';
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    return this.appendLocal(input.groupId, {
      aggregateType: 'workspace',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'progress_update_posted',
      payload: {
        update: {
          format: 'icarus.collaboration-progress-update/1',
          update_id: input.updateId ?? newId('update'),
          principal_id: group.localPrincipalId,
          summary: input.summary,
          completed: input.completed ?? [],
          in_progress: input.inProgress ?? [],
          next_steps: input.nextSteps ?? [],
          blockers: input.blockers ?? [],
          work_item_refs: input.workItemRefs ?? [],
          workflow_instance_refs: input.workflowInstanceRefs ?? [],
          artifact_refs: input.artifactRefs ?? [],
          origin: input.origin ?? 'human',
          actor_client_id: group.localClientId,
          executor_id: input.executorId ?? null,
          created_at: new Date(this.now()).toISOString(),
        },
      },
      executorId: input.executorId ?? null,
    });
  }

  async publishSharedFile(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly fileName: string;
    readonly mediaType: string;
    readonly contents?: Buffer | null;
    readonly externalLocator?: {
      readonly type: 'https' | 'object_store';
      readonly locator: string;
    } | null;
    readonly externalSize?: number;
    readonly externalSha256?: string;
    readonly workItemRefs?: readonly string[];
    readonly workflowInstanceRefs?: readonly string[];
    readonly discussionRefs?: readonly string[];
    readonly fileId?: string;
    readonly previousRevision?: number | null;
    readonly executorId?: string | null;
    readonly origin?: 'human' | 'agent' | 'workflow';
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const fileId = input.fileId ?? newId('file');
    const metadata = this.fileMetadata({
      ...input,
      fileId,
      principalId: group.localPrincipalId!,
      clientId: group.localClientId!,
      revision: (input.previousRevision ?? 0) + 1,
    });
    const directory = `workspace/shared/documents/${fileId}`;
    return this.appendLocal(input.groupId, {
      aggregateType: 'workspace',
      aggregateId: 'shared',
      expectedRevision: input.expectedRevision,
      eventType:
        input.previousRevision == null
          ? 'shared_file_published'
          : 'shared_file_revised',
      payload: { metadata },
      executorId: input.executorId ?? null,
      materializedFiles: metadata.content_ref
        ? [
            {
              path: `${directory}/${metadata.content_ref}`,
              contents: input.contents!,
            },
          ]
        : [],
    });
  }

  async publishPrincipalFile(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly fileName: string;
    readonly mediaType: string;
    readonly contents?: Buffer | null;
    readonly externalLocator?: {
      readonly type: 'https' | 'object_store';
      readonly locator: string;
    } | null;
    readonly externalSize?: number;
    readonly externalSha256?: string;
    readonly workItemRefs?: readonly string[];
    readonly workflowInstanceRefs?: readonly string[];
    readonly discussionRefs?: readonly string[];
    readonly fileId?: string;
    readonly executorId?: string | null;
    readonly origin?: 'human' | 'agent' | 'workflow';
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const fileId = input.fileId ?? newId('file');
    const metadata = this.fileMetadata({
      ...input,
      fileId,
      principalId: group.localPrincipalId!,
      clientId: group.localClientId!,
      revision: 1,
    });
    const directory = `workspace/principals/${group.localPrincipalId}/files/${fileId}`;
    return this.appendLocal(input.groupId, {
      aggregateType: 'workspace',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'principal_file_published',
      payload: { metadata },
      executorId: input.executorId ?? null,
      materializedFiles: metadata.content_ref
        ? [
            {
              path: `${directory}/${metadata.content_ref}`,
              contents: input.contents!,
            },
          ]
        : [],
    });
  }

  async publishAction(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly actionId: string;
    readonly name: string;
    readonly version: number;
    readonly kind: 'run_once' | 'workflow' | 'external';
    readonly adapter?: string | null;
    readonly workflowRef?: string | null;
    readonly prompt: string;
    readonly filesystemAccess: 'read_only' | 'workspace_write';
    readonly resultSchema?: {
      readonly ref: string;
      readonly schema: Record<string, unknown> | null;
    };
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const promptRef = `workspace/principals/${group.localPrincipalId}/automations/prompts/${input.actionId}.md`;
    const promptHash = `sha256:${crypto
      .createHash('sha256')
      .update(input.prompt, 'utf8')
      .digest('hex')}`;
    const action = actionDefinitionV3Schema.parse({
      format: 'icarus.collaboration-action/1',
      action_id: input.actionId,
      name: input.name,
      owner_principal_id: group.localPrincipalId,
      version: input.version,
      kind: input.kind,
      adapter: input.adapter ?? null,
      workflow_ref: input.workflowRef ?? null,
      prompt_ref: promptRef,
      prompt_hash: promptHash,
      executor_policy: 'principal_selected',
      filesystem_access: input.filesystemAccess,
      result_schema: input.resultSchema ?? {
        ref: 'collaboration-state-result@1',
        schema: null,
      },
    });
    const history = await this.sync(input.groupId);
    const existing =
      history.projection.actions[`${group.localPrincipalId}:${input.actionId}`];
    if (existing && input.version !== existing.version + 1)
      throw new Error('Action version is stale');
    if (!existing && input.version !== 1)
      throw new Error('New Action must start at version 1');
    return this.appendLocal(input.groupId, {
      aggregateType: 'workspace',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: existing ? 'action_revised' : 'action_published',
      payload: { action },
      materializedFiles: [{ path: promptRef, contents: input.prompt }],
    });
  }

  async createWorkItem(input: {
    readonly groupId: string;
    readonly expectedRevision?: 0;
    readonly workItemId?: string;
    readonly type: WorkItem['type'];
    readonly title: string;
    readonly description?: string;
    readonly status?: 'proposed' | 'open';
    readonly priority?: WorkItem['priority'];
    readonly ownerPrincipalId?: string;
    readonly preferredExecutorId?: string | null;
    readonly contributors?: readonly string[];
    readonly watchers?: readonly string[];
    readonly acceptanceCriteria?: readonly string[];
    readonly labels?: readonly string[];
    readonly dueAt?: string | null;
    readonly parentId?: string | null;
    readonly blockedBy?: readonly string[];
    readonly relatedItems?: readonly string[];
    readonly executorId?: string | null;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const now = new Date(this.now()).toISOString();
    const workItemId = input.workItemId ?? newId('wi');
    const ownerPrincipalId = input.ownerPrincipalId ?? group.localPrincipalId!;
    const item = workItemSchema.parse({
      format: 'icarus.collaboration-work-item/1',
      work_item_id: workItemId,
      type: input.type,
      title: input.title,
      description: input.description ?? '',
      status: input.executorId ? 'proposed' : (input.status ?? 'open'),
      priority: input.priority ?? 'normal',
      creator_principal_id: group.localPrincipalId,
      owner_principal_id: ownerPrincipalId,
      preferred_executor_id: input.preferredExecutorId ?? null,
      contributors: [...(input.contributors ?? [])],
      watchers: [...(input.watchers ?? [])],
      acceptance_criteria: [...(input.acceptanceCriteria ?? [])],
      labels: [...(input.labels ?? [])],
      due_at: input.dueAt ?? null,
      parent_id: input.parentId ?? null,
      blocked_by: [...(input.blockedBy ?? [])],
      related_items: [...(input.relatedItems ?? [])],
      primary_workflow_instance_id: null,
      assignment_status:
        ownerPrincipalId === group.localPrincipalId ? 'accepted' : 'pending',
      created_at: now,
      updated_at: now,
      closed_at: null,
      revision: 1,
      archived: false,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: workItemId,
      expectedRevision: input.expectedRevision ?? 0,
      eventType: 'work_item_created',
      payload: { item },
      executorId: input.executorId ?? null,
    });
  }

  async updateWorkItemDetails(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly type?: WorkItem['type'];
    readonly title?: string;
    readonly description?: string;
    readonly priority?: WorkItem['priority'];
    readonly preferredExecutorId?: string | null;
    readonly contributors?: readonly string[];
    readonly watchers?: readonly string[];
    readonly acceptanceCriteria?: readonly string[];
    readonly labels?: readonly string[];
    readonly dueAt?: string | null;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const history = await this.sync(input.groupId);
    const current = history.projection.workItems[input.workItemId];
    if (!current) throw new Error('Work Item does not exist');
    const item = workItemSchema.parse({
      ...current,
      type: input.type ?? current.type,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      priority: input.priority ?? current.priority,
      preferred_executor_id:
        input.preferredExecutorId === undefined
          ? current.preferred_executor_id
          : input.preferredExecutorId,
      contributors: input.contributors
        ? [...input.contributors]
        : current.contributors,
      watchers: input.watchers ? [...input.watchers] : current.watchers,
      acceptance_criteria: input.acceptanceCriteria
        ? [...input.acceptanceCriteria]
        : current.acceptance_criteria,
      labels: input.labels ? [...input.labels] : current.labels,
      due_at: input.dueAt === undefined ? current.due_at : input.dueAt,
      updated_at: new Date(this.now()).toISOString(),
      revision: input.expectedRevision + 1,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: input.workItemId,
      expectedRevision: input.expectedRevision,
      eventType: 'work_item_details_updated',
      payload: { item },
    });
  }

  async changeWorkItemAssignment(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly ownerPrincipalId: string;
    readonly preferredExecutorId?: string | null;
    readonly requireAcknowledgement?: boolean;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    return this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: input.workItemId,
      expectedRevision: input.expectedRevision,
      eventType: 'work_item_assignment_changed',
      payload: {
        owner_principal_id: input.ownerPrincipalId,
        preferred_executor_id: input.preferredExecutorId ?? null,
        assignment_status:
          !input.requireAcknowledgement &&
          input.ownerPrincipalId === group.localPrincipalId
            ? 'accepted'
            : 'pending',
      },
    });
  }

  async answerWorkItemAssignment(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly accepted: boolean;
    readonly reason?: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: input.workItemId,
      expectedRevision: input.expectedRevision,
      eventType: input.accepted
        ? 'work_item_assignment_acknowledged'
        : 'work_item_assignment_declined',
      payload: input.accepted ? {} : { reason: input.reason ?? 'declined' },
    });
  }

  async changeWorkItemStatus(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly status: WorkItemStatus;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: input.workItemId,
      expectedRevision: input.expectedRevision,
      eventType: 'work_item_status_changed',
      payload: {
        status: input.status,
        closed_at: ['done', 'cancelled'].includes(input.status)
          ? new Date(this.now()).toISOString()
          : null,
      },
    });
  }

  async stageWorkItemArtifact(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly contents: Buffer;
  }): Promise<ProjectSpaceStagedArtifactResult> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const item = history.projection.workItems[input.workItemId];
    if (!item) throw new Error('Work Item does not exist');
    const canContribute =
      item.owner_principal_id === group.localPrincipalId ||
      item.contributors.includes(group.localPrincipalId!) ||
      hasCollaborationPermissionV3(
        history.projection,
        group.localPrincipalId!,
        'work_item:manage_all',
      );
    if (!canContribute)
      throw new Error('Local Principal cannot contribute to this Work Item');
    const artifact = this.store.stageArtifact({
      artifactId: newId('artifact'),
      groupId: input.groupId,
      scopeType: 'work_item',
      scopeId: input.workItemId,
      principalId: group.localPrincipalId!,
      clientId: group.localClientId!,
      originalName: collaborationBasenameSchema.parse(input.fileName),
      mediaType: input.mediaType,
      contents: this.artifactContents(input.contents),
      nowMs: this.now(),
    });
    const metadata = this.artifactMetadata(artifact, null);
    return { metadata, artifactRef: this.artifactRef(metadata) };
  }

  async postWorkItemProgress(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly summary: string;
    readonly completed?: readonly string[];
    readonly nextSteps?: readonly string[];
    readonly blockers?: readonly string[];
    readonly artifactIds?: readonly string[];
    readonly artifactRefs?: readonly string[];
    readonly executorId?: string | null;
    readonly origin?: 'human' | 'agent' | 'workflow';
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const staged = this.materializeStagedArtifacts({
      artifactIds: input.artifactIds ?? [],
      group,
      scopeType: 'work_item',
      scopeId: input.workItemId,
      executorId: input.executorId ?? null,
    });
    const artifactRefs = [
      ...new Set([...(input.artifactRefs ?? []), ...staged.artifactRefs]),
    ];
    const update = workItemProgressSchema.parse({
      format: 'icarus.collaboration-work-item-progress/1',
      update_id: newId('update'),
      work_item_id: input.workItemId,
      summary: input.summary,
      completed: [...(input.completed ?? [])],
      next_steps: [...(input.nextSteps ?? [])],
      blockers: [...(input.blockers ?? [])],
      artifact_refs: artifactRefs,
      actor_principal_id: group.localPrincipalId,
      actor_client_id: group.localClientId,
      executor_id: input.executorId ?? null,
      origin: input.origin ?? 'human',
      created_at: new Date(this.now()).toISOString(),
    });
    const result = await this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: input.workItemId,
      expectedRevision: input.expectedRevision,
      eventType: 'work_item_progress_posted',
      payload: { update, artifacts: staged.metadata },
      executorId: input.executorId ?? null,
      materializedFiles: staged.files.length ? staged.files : undefined,
    });
    this.store.markStagedArtifactsCommitted(
      input.artifactIds ?? [],
      this.now(),
    );
    return result;
  }

  async changeWorkItemRelations(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly parentId?: string | null;
    readonly blockedBy?: readonly string[];
    readonly relatedItems?: readonly string[];
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: input.workItemId,
      expectedRevision: input.expectedRevision,
      eventType: 'work_item_relation_changed',
      payload: {
        parent_id: input.parentId ?? null,
        blocked_by: [...(input.blockedBy ?? [])],
        related_items: [...(input.relatedItems ?? [])],
      },
    });
  }

  async archiveWorkItem(input: {
    readonly groupId: string;
    readonly workItemId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'work_item',
      aggregateId: input.workItemId,
      expectedRevision: input.expectedRevision,
      eventType: 'work_item_archived',
      payload: { reason: input.reason },
    });
  }

  async createDiscussion(input: {
    readonly groupId: string;
    readonly expectedRevision?: 0;
    readonly threadId?: string;
    readonly title: string;
    readonly scope: Discussion['scope'];
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const discussion = discussionSchema.parse({
      format: 'icarus.collaboration-discussion/1',
      thread_id: input.threadId ?? newId('thread'),
      title: input.title,
      created_by: group.localPrincipalId,
      scope: input.scope,
      status: 'open',
      created_at: new Date(this.now()).toISOString(),
      resolved_at: null,
      revision: 1,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'discussion',
      aggregateId: discussion.thread_id,
      expectedRevision: input.expectedRevision ?? 0,
      eventType: 'discussion_created',
      payload: { discussion },
    });
  }

  async createDiscussionWithMessage(input: {
    readonly groupId: string;
    readonly expectedRevision?: 0;
    readonly threadId?: string;
    readonly title: string;
    readonly scope: Discussion['scope'];
    readonly messageId?: string;
    readonly body: string;
    readonly mentions?: readonly string[];
    readonly refs?: readonly string[];
    readonly executorId?: string | null;
    readonly origin?: 'human' | 'agent' | 'workflow';
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const now = new Date(this.now()).toISOString();
    const threadId = input.threadId ?? newId('thread');
    const discussion = discussionSchema.parse({
      format: 'icarus.collaboration-discussion/1',
      thread_id: threadId,
      title: input.title,
      created_by: group.localPrincipalId,
      scope: input.scope,
      status: 'open',
      created_at: now,
      resolved_at: null,
      revision: 1,
    });
    const message = buildDiscussionMessage({
      group,
      threadId,
      messageId: input.messageId,
      body: input.body,
      mentions: input.mentions,
      refs: input.refs,
      executorId: input.executorId,
      origin: input.origin,
      now,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'discussion',
      aggregateId: threadId,
      expectedRevision: input.expectedRevision ?? 0,
      eventType: 'discussion_created',
      payload: { discussion, message },
      executorId: input.executorId ?? null,
    });
  }

  async postDiscussionMessage(input: {
    readonly groupId: string;
    readonly threadId: string;
    readonly expectedRevision: number;
    readonly messageId?: string;
    readonly body: string;
    readonly mentions?: readonly string[];
    readonly refs?: readonly string[];
    readonly executorId?: string | null;
    readonly origin?: 'human' | 'agent' | 'workflow';
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const now = new Date(this.now()).toISOString();
    const message = buildDiscussionMessage({
      group,
      threadId: input.threadId,
      messageId: input.messageId,
      body: input.body,
      mentions: input.mentions,
      refs: input.refs,
      executorId: input.executorId,
      origin: input.origin,
      now,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'discussion',
      aggregateId: input.threadId,
      expectedRevision: input.expectedRevision,
      eventType: 'message_posted',
      payload: { message },
      executorId: input.executorId ?? null,
    });
  }

  async reviseDiscussionMessage(input: {
    readonly groupId: string;
    readonly threadId: string;
    readonly expectedRevision: number;
    readonly messageId: string;
    readonly body: string;
    readonly mentions?: readonly string[];
    readonly refs?: readonly string[];
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const previous =
      history.projection.discussions[input.threadId]?.messages[input.messageId];
    if (!previous) throw new Error('Discussion message does not exist');
    if (previous.author_principal_id !== group.localPrincipalId)
      throw new Error('Only the message author may revise it');
    const message = discussionMessageSchema.parse({
      ...previous,
      actor_client_id: group.localClientId,
      body: input.body,
      mentions: input.mentions ? [...input.mentions] : previous.mentions,
      refs: input.refs ? [...input.refs] : previous.refs,
      revision: previous.revision + 1,
      updated_at: new Date(this.now()).toISOString(),
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'discussion',
      aggregateId: input.threadId,
      expectedRevision: input.expectedRevision,
      eventType: 'message_revised',
      payload: { message },
    });
  }

  async tombstoneDiscussionMessage(input: {
    readonly groupId: string;
    readonly threadId: string;
    readonly expectedRevision: number;
    readonly messageId: string;
    readonly reason?: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'discussion',
      aggregateId: input.threadId,
      expectedRevision: input.expectedRevision,
      eventType: 'message_tombstoned',
      payload: {
        message_id: input.messageId,
        reason: input.reason ?? '',
      },
    });
  }

  async setDiscussionResolved(input: {
    readonly groupId: string;
    readonly threadId: string;
    readonly expectedRevision: number;
    readonly resolved: boolean;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'discussion',
      aggregateId: input.threadId,
      expectedRevision: input.expectedRevision,
      eventType: input.resolved ? 'discussion_resolved' : 'discussion_reopened',
      payload: {},
    });
  }

  async proposeWorkflowDefinition(input: {
    readonly groupId: string;
    readonly definitionId: string;
    readonly expectedRevision: number;
    readonly version: number;
    readonly name: string;
    readonly description?: string;
    readonly launchPolicy?: {
      readonly group_admin: boolean;
      readonly work_item_owner: boolean;
      readonly principals: readonly string[];
    };
    readonly machine: MachineDefinitionV3;
    readonly layout: WorkflowLayout;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const key = workflowDefinitionVersionKey(input.definitionId, input.version);
    const previous = history.projection.workflowDefinitions[key];
    const latest =
      history.projection.latestWorkflowDefinitionVersions[input.definitionId] ??
      0;
    if (!previous && input.version !== latest + 1)
      throw new Error('Workflow Definition versions must be sequential');
    if (previous?.definition.status === 'published')
      throw new Error('Published Workflow Definition versions are immutable');
    const machine = machineDefinitionV3Schema.parse(input.machine);
    const layout = workflowLayoutSchema.parse(input.layout);
    const now = new Date(this.now()).toISOString();
    const definition = workflowDefinitionSchema.parse({
      format: 'icarus.collaboration-workflow-definition/1',
      definition_id: input.definitionId,
      name: input.name,
      description: input.description ?? '',
      version: input.version,
      created_by_principal_id:
        previous?.definition.created_by_principal_id ?? group.localPrincipalId,
      published_by_principal_id: null,
      status: 'proposed',
      launch_policy: input.launchPolicy ?? {
        group_admin: true,
        work_item_owner: true,
        principals: [],
      },
      machine_ref: `workflows/definitions/${input.definitionId}/machine.json`,
      layout_ref: `workflows/definitions/${input.definitionId}/layout.json`,
      machine_hash: collaborationCanonicalHashV3(machine),
      layout_hash: collaborationCanonicalHashV3(layout),
      revision: input.expectedRevision + 1,
      created_at: previous?.definition.created_at ?? now,
      updated_at: now,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_definition',
      aggregateId: input.definitionId,
      expectedRevision: input.expectedRevision,
      eventType: 'workflow_definition_proposed',
      payload: { definition, machine, layout },
    });
  }

  async publishWorkflowDefinition(input: {
    readonly groupId: string;
    readonly definitionId: string;
    readonly version: number;
    readonly expectedRevision: number;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const current =
      history.projection.workflowDefinitions[
        workflowDefinitionVersionKey(input.definitionId, input.version)
      ];
    if (!current || current.definition.status !== 'proposed')
      throw new Error('Proposed Workflow Definition version does not exist');
    const definition = workflowDefinitionSchema.parse({
      ...current.definition,
      status: 'published',
      published_by_principal_id: group.localPrincipalId,
      revision: input.expectedRevision + 1,
      updated_at: new Date(this.now()).toISOString(),
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_definition',
      aggregateId: input.definitionId,
      expectedRevision: input.expectedRevision,
      eventType: 'workflow_definition_published',
      payload: {
        definition,
        machine: current.machine,
        layout: current.layout,
      },
    });
  }

  async updateWorkflowLayout(input: {
    readonly groupId: string;
    readonly definitionId: string;
    readonly version: number;
    readonly expectedRevision: number;
    readonly view: WorkflowLayout['view'];
    readonly nodes: WorkflowLayout['nodes'];
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const history = await this.sync(input.groupId);
    const current =
      history.projection.workflowDefinitions[
        workflowDefinitionVersionKey(input.definitionId, input.version)
      ];
    if (!current) throw new Error('Workflow Definition does not exist');
    const layout = workflowLayoutSchema.parse({
      format: 'icarus.collaboration-workflow-layout/1',
      view: input.view,
      nodes: input.nodes,
      revision: current.layout.revision + 1,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_definition',
      aggregateId: input.definitionId,
      expectedRevision: input.expectedRevision,
      eventType: 'workflow_layout_updated',
      payload: {
        definition_id: input.definitionId,
        version: input.version,
        layout,
        layout_hash: collaborationCanonicalHashV3(layout),
      },
    });
  }

  async retireWorkflowDefinition(input: {
    readonly groupId: string;
    readonly definitionId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_definition',
      aggregateId: input.definitionId,
      expectedRevision: input.expectedRevision,
      eventType: 'workflow_definition_retired',
      payload: { reason: input.reason },
    });
  }

  async createWorkflowInstance(input: {
    readonly groupId: string;
    readonly definitionId: string;
    readonly definitionVersion: number;
    readonly instanceId?: string;
    readonly scope: WorkflowInstance['scope'];
    readonly relatedWorkItemRefs?: readonly string[];
    readonly participantBindings?: Readonly<Record<string, string>>;
    readonly stateAssignments?: Readonly<Record<string, string>>;
    readonly workItemStatusMapping?: Readonly<Record<string, WorkItemStatus>>;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const selected =
      history.projection.workflowDefinitions[
        workflowDefinitionVersionKey(
          input.definitionId,
          input.definitionVersion,
        )
      ];
    if (!selected || selected.definition.status !== 'published')
      throw new Error('Published Workflow Definition does not exist');
    const participantBindings = { ...(input.participantBindings ?? {}) };
    const resolvedAssignments = { ...(input.stateAssignments ?? {}) };
    for (const [stateId, state] of Object.entries(selected.machine.states)) {
      if (state.terminal || resolvedAssignments[stateId]) continue;
      if (state.assignee?.type === 'principal')
        resolvedAssignments[stateId] = state.assignee.principal_id;
      else if (
        state.assignee?.type === 'participant_slot' &&
        participantBindings[state.assignee.slot]
      )
        resolvedAssignments[stateId] =
          participantBindings[state.assignee.slot]!;
    }
    const executableStateIds = Object.entries(selected.machine.states)
      .filter(([, state]) => !state.terminal)
      .map(([stateId]) => stateId);
    const ready = executableStateIds.every(
      (stateId) => resolvedAssignments[stateId],
    );
    const now = new Date(this.now()).toISOString();
    const instance = workflowInstanceSchema.parse({
      format: 'icarus.collaboration-workflow-instance/1',
      instance_id: input.instanceId ?? newId('wfi'),
      definition_id: input.definitionId,
      definition_version: input.definitionVersion,
      definition_hash: collaborationWorkflowDefinitionHashV3(
        selected.definition,
        selected.machine,
      ),
      scope: input.scope,
      related_work_item_refs: [...(input.relatedWorkItemRefs ?? [])],
      participant_bindings: participantBindings,
      resolved_assignments: resolvedAssignments,
      work_item_status_mapping: { ...(input.workItemStatusMapping ?? {}) },
      lifecycle: ready ? 'ready' : 'draft',
      business_state: selected.machine.initial_state,
      active_turn_id: null,
      last_completed_turn_id: null,
      last_handoff_hash: null,
      epoch: 1,
      revision: 1,
      created_by_principal_id: group.localPrincipalId,
      created_at: now,
      updated_at: now,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: instance.instance_id,
      expectedRevision: 0,
      eventType: 'workflow_instance_created',
      payload: { instance },
    });
  }

  async startWorkflowInstance(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly expectedRevision: number;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'workflow_instance_started',
      payload: {},
    });
  }

  async setWorkflowInstancePaused(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly expectedRevision: number;
    readonly paused: boolean;
    readonly reason?: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: input.paused
        ? 'workflow_instance_paused'
        : 'workflow_instance_resumed',
      payload: input.paused ? { reason: input.reason ?? 'paused' } : {},
    });
  }

  async closeWorkflowInstance(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'workflow_instance_closed',
      payload: { reason: input.reason },
    });
  }

  async reassignWorkflowState(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly expectedRevision: number;
    readonly stateId: string;
    readonly principalId: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'workflow_state_assignee_changed',
      payload: {
        state_id: input.stateId,
        principal_id: input.principalId,
      },
    });
  }

  async publishStateExecution(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly stateId: string;
    readonly expectedRevision: number;
    readonly mode: ExecutionModeV3;
    readonly actionId?: string | null;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const current =
      history.projection.stateExecutions[input.instanceId]?.[input.stateId];
    const action = input.actionId
      ? history.projection.actions[
          `${group.localPrincipalId}:${input.actionId}`
        ]
      : null;
    if (input.mode !== 'manual' && !action)
      throw new Error('Assisted/automatic execution requires an owned Action');
    if (input.mode === 'manual' && input.actionId)
      throw new Error('Manual execution cannot reference an Action');
    const eventId = newId('evt');
    const execution = stateExecutionSchema.parse({
      format: 'icarus.collaboration-state-execution/1',
      instance_id: input.instanceId,
      state_id: input.stateId,
      principal_id: group.localPrincipalId,
      mode: input.mode,
      action_ref: action
        ? `workspace/principals/${group.localPrincipalId}/automations/actions/${action.action_id}.json`
        : null,
      action_hash: action ? collaborationCanonicalHashV3(action) : null,
      prompt_hash: action?.prompt_hash ?? null,
      published_at_event: eventId,
      revision: (current?.revision ?? 0) + 1,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: current
        ? 'state_execution_revised'
        : 'state_execution_published',
      payload: { execution },
      eventId,
    });
  }

  async withdrawStateExecution(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly stateId: string;
    readonly expectedRevision: number;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'state_execution_withdrawn',
      payload: { state_id: input.stateId },
    });
  }

  async createTurn(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly expectedRevision: number;
    readonly turnId?: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const history = await this.sync(input.groupId);
    const instance = history.projection.workflowInstances[input.instanceId];
    if (!instance) throw new Error('Workflow Instance does not exist');
    const definition =
      history.projection.workflowDefinitions[
        workflowDefinitionVersionKey(
          instance.definition_id,
          instance.definition_version,
        )
      ];
    const state = definition?.machine.states[instance.business_state];
    if (!definition || !state || state.terminal)
      throw new Error('Workflow Instance is not on an executable State');
    const group = this.requireLocalMember(input.groupId);
    if (
      !canCreateWorkflowTurnV3(
        history.projection,
        group.localPrincipalId!,
        instance,
      )
    )
      throw new Error('Local Principal cannot create this Workflow Turn');
    const execution =
      history.projection.stateExecutions[input.instanceId]?.[
        instance.business_state
      ];
    const turnId = input.turnId ?? newId('turn');
    const previousTurn = instance.last_completed_turn_id
      ? history.projection.turns[instance.last_completed_turn_id]
      : null;
    if (
      (instance.last_completed_turn_id === null) !==
        (instance.last_handoff_hash === null) ||
      (previousTurn &&
        (previousTurn.workflow_instance_id !== instance.instance_id ||
          previousTurn.state !== 'completed' ||
          !previousTurn.handoff ||
          previousTurn.handoff_hash !== instance.last_handoff_hash))
    )
      throw new Error('Workflow Instance Handoff authority is inconsistent');
    const incomingHandoff = previousTurn?.handoff ?? null;
    const incomingHandoffHash = previousTurn?.handoff_hash ?? null;
    const createdAt = new Date(this.now()).toISOString();
    const timeoutPolicy = state.timeout_policy ?? null;
    const startDeadlineAt = collaborationDeadlineAtV3(
      createdAt,
      timeoutPolicy?.start_timeout_ms,
    );
    const inputHash = collaborationTurnInputHashV3({
      groupId: input.groupId,
      instanceId: input.instanceId,
      epoch: instance.epoch,
      stateId: instance.business_state,
      assigneePrincipalId:
        instance.resolved_assignments[instance.business_state]!,
      execution: execution ?? null,
      incomingHandoffHash,
      workItem:
        instance.scope.type === 'work_item'
          ? history.projection.workItems[instance.scope.work_item_id]
          : null,
    });
    const attempt = 1;
    const turn = collaborationTurnV3Schema.parse({
      format: 'icarus.collaboration-turn/1',
      turn_id: turnId,
      workflow_instance_id: input.instanceId,
      state_id: instance.business_state,
      assignee_principal_id:
        instance.resolved_assignments[instance.business_state],
      claimant_principal_id: null,
      claimant_client_id: null,
      executor_id: null,
      attempt,
      fencing_token: null,
      execution_mode: execution?.mode ?? 'manual',
      state: 'pending',
      action_ref: execution?.action_ref ?? null,
      action_hash: execution?.action_hash ?? null,
      prompt_hash: execution?.prompt_hash ?? null,
      input_hash: inputHash,
      idempotency_key: collaborationIdempotencyKeyV3({
        groupId: input.groupId,
        instanceId: input.instanceId,
        epoch: instance.epoch,
        turnId,
        attempt,
        inputHash,
      }),
      incoming_handoff: incomingHandoff,
      incoming_handoff_hash: incomingHandoffHash,
      timeout_policy_snapshot: timeoutPolicy,
      start_deadline_at: startDeadlineAt,
      execution_deadline_at: null,
      deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
        turnId,
        attempt,
        timeoutPolicy,
        startDeadlineAt,
        startedAt: null,
        executionDeadlineAt: null,
      }),
      created_at: createdAt,
      started_at: null,
      completed_at: null,
      outcome: null,
      handoff: null,
      handoff_hash: null,
      executor_result: null,
      executor_result_hash: null,
      completion_hash: null,
      recovery_reason: null,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'turn_created',
      payload: { turn },
    });
  }

  async startTurn(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly expectedRevision: number;
    readonly executorId?: string | null;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const instance = history.projection.workflowInstances[input.instanceId];
    const turn = history.projection.turns[input.turnId];
    if (!instance || !turn) throw new Error('Workflow Turn does not exist');
    if (turn.assignee_principal_id !== group.localPrincipalId)
      throw new Error('Only the assigned Principal may start this Turn');
    if (turn.execution_mode === 'manual' && input.executorId)
      throw new Error('Manual Turns do not use an Executor');
    if (turn.execution_mode !== 'manual') {
      if (!input.executorId || !turn.action_hash || !turn.prompt_hash)
        throw new Error(
          'Assisted/automatic Turns require an Executor and Action snapshot',
        );
      const binding = this.store.getExecutorBinding({
        groupId: input.groupId,
        instanceId: input.instanceId,
        stateId: turn.state_id,
        principalId: group.localPrincipalId!,
        clientId: group.localClientId!,
        actionHash: turn.action_hash,
        promptHash: turn.prompt_hash,
      });
      if (!binding?.enabled || binding.executorId !== input.executorId)
        throw new Error('No enabled local Executor Binding matches this Turn');
    }
    const eventId = newId('evt');
    const startedAt = new Date(this.now()).toISOString();
    const executionDeadlineAt = collaborationDeadlineAtV3(
      startedAt,
      turn.timeout_policy_snapshot?.execution_timeout_ms,
    );
    const fencingToken = collaborationFencingTokenV3({
      groupId: input.groupId,
      instanceId: input.instanceId,
      epoch: instance.epoch,
      turnId: input.turnId,
      attempt: turn.attempt,
      claimantClientId: group.localClientId!,
      claimEventId: eventId,
      expectedRevision: input.expectedRevision,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'turn_started',
      payload: {
        turn_id: input.turnId,
        attempt: turn.attempt,
        fencing_token: fencingToken,
        executor_id: input.executorId ?? null,
        execution_deadline_at: executionDeadlineAt,
        deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
          turnId: input.turnId,
          attempt: turn.attempt,
          timeoutPolicy: turn.timeout_policy_snapshot,
          startDeadlineAt: turn.start_deadline_at,
          startedAt,
          executionDeadlineAt,
        }),
      },
      eventId,
      occurredAt: startedAt,
      executorId: input.executorId ?? null,
    });
  }

  async recordActionState(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly expectedRevision: number;
    readonly attempt: number;
    readonly fencingToken: string;
    readonly state:
      | 'dispatched'
      | 'waiting_input'
      | 'waiting_approval'
      | 'completed';
    readonly executionRef?: string;
    readonly resultHash?: string;
    readonly result?: unknown;
    readonly executorId?: string | null;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const eventType =
      input.state === 'dispatched'
        ? 'action_dispatched'
        : input.state === 'waiting_input'
          ? 'action_waiting_input'
          : input.state === 'waiting_approval'
            ? 'action_waiting_approval'
            : 'action_completed';
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType,
      payload: {
        turn_id: input.turnId,
        attempt: input.attempt,
        fencing_token: input.fencingToken,
        ...(input.state === 'dispatched'
          ? { execution_ref: input.executionRef }
          : {}),
        ...(input.state === 'completed'
          ? { result: input.result, result_hash: input.resultHash }
          : {}),
      },
      executorId: input.executorId ?? null,
    });
  }

  async stageTurnArtifact(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly attempt: number;
    readonly fencingToken: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly contents: Buffer;
  }): Promise<ProjectSpaceStagedArtifactResult> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const turn = history.projection.turns[input.turnId];
    if (
      !turn ||
      turn.workflow_instance_id !== input.instanceId ||
      turn.attempt !== input.attempt ||
      turn.fencing_token !== input.fencingToken ||
      turn.claimant_principal_id !== group.localPrincipalId ||
      turn.claimant_client_id !== group.localClientId ||
      ![
        'running',
        'waiting_input',
        'waiting_approval',
        'awaiting_confirmation',
      ].includes(turn.state)
    )
      throw new Error(
        'Turn Artifact requires the current fenced claimant Client',
      );
    const artifact = this.store.stageArtifact({
      artifactId: newId('artifact'),
      groupId: input.groupId,
      scopeType: 'workflow_turn',
      scopeId: input.instanceId,
      turnId: input.turnId,
      attempt: input.attempt,
      fencingToken: input.fencingToken,
      principalId: group.localPrincipalId!,
      clientId: group.localClientId!,
      originalName: collaborationBasenameSchema.parse(input.fileName),
      mediaType: input.mediaType,
      contents: this.artifactContents(input.contents),
      nowMs: this.now(),
    });
    const metadata = this.artifactMetadata(
      artifact,
      turn.execution_mode === 'automatic' ? turn.executor_id : null,
    );
    return { metadata, artifactRef: this.artifactRef(metadata) };
  }

  async completeTurn(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly expectedRevision: number;
    readonly attempt: number;
    readonly fencingToken: string;
    readonly outcome: string;
    readonly summary: string;
    readonly instruction?: string;
    readonly markers?: readonly string[];
    readonly dataRefs?: readonly string[];
    readonly artifactIds?: readonly string[];
    readonly artifactRefs?: readonly string[];
    readonly data?: Readonly<Record<string, unknown>>;
    readonly executorId?: string | null;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const history = await this.sync(input.groupId);
    const turn = history.projection.turns[input.turnId];
    if (
      !turn ||
      turn.workflow_instance_id !== input.instanceId ||
      turn.attempt !== input.attempt ||
      turn.fencing_token !== input.fencingToken
    )
      throw new Error('Workflow Turn completion is stale');
    const resultHash =
      turn.execution_mode === 'manual' ? null : turn.executor_result_hash;
    if (turn.execution_mode !== 'manual' && !resultHash)
      throw new Error(
        'Executor result must be recorded before Turn completion',
      );
    if (
      turn.execution_mode === 'automatic'
        ? input.executorId !== turn.executor_id
        : input.executorId != null
    )
      throw new Error(
        'Turn completion actor does not match its execution mode',
      );
    const staged = this.materializeStagedArtifacts({
      artifactIds: input.artifactIds ?? [],
      group,
      scopeType: 'workflow_turn',
      scopeId: input.instanceId,
      turnId: input.turnId,
      attempt: input.attempt,
      fencingToken: input.fencingToken,
      executorId: input.executorId ?? null,
    });
    const artifactRefs = [
      ...new Set([...(input.artifactRefs ?? []), ...staged.artifactRefs]),
    ];
    const handoff = handoffEnvelopeV3Schema.parse({
      format: 'icarus.collaboration-handoff/1',
      source_turn_id: input.turnId,
      outcome: input.outcome,
      summary: input.summary,
      instruction: input.instruction ?? '',
      markers: [...(input.markers ?? [])],
      data_refs: [...(input.dataRefs ?? [])],
      artifact_refs: artifactRefs,
      data: { ...(input.data ?? {}) },
    });
    const result = await this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'turn_completed',
      payload: {
        turn_id: input.turnId,
        attempt: input.attempt,
        fencing_token: input.fencingToken,
        outcome: input.outcome,
        result_hash: resultHash,
        completion_hash: collaborationTurnCompletionHashV3({
          turnId: input.turnId,
          attempt: input.attempt,
          outcome: input.outcome,
          resultHash,
          handoffHash: collaborationCanonicalHashV3(handoff),
          artifactRefs,
        }),
        handoff,
        handoff_hash: collaborationCanonicalHashV3(handoff),
        artifact_refs: artifactRefs,
        artifacts: staged.metadata,
      },
      executorId: input.executorId ?? null,
      materializedFiles: staged.files.length ? staged.files : undefined,
    });
    this.store.markStagedArtifactsCommitted(
      input.artifactIds ?? [],
      this.now(),
    );
    return result;
  }

  async cancelTurn(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly expectedRevision: number;
    readonly attempt: number;
    readonly fencingToken?: string | null;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'turn_cancelled',
      payload: {
        turn_id: input.turnId,
        attempt: input.attempt,
        fencing_token: input.fencingToken ?? null,
        reason: input.reason,
      },
    });
  }

  async requestTurnRecovery(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly expectedRevision: number;
    readonly epoch: number;
    readonly attempt: number;
    readonly fencingToken: string;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'turn_recovery_requested',
      payload: {
        turn_id: input.turnId,
        epoch: input.epoch,
        attempt: input.attempt,
        fencing_token: input.fencingToken,
        reason: input.reason,
      },
    });
  }

  async recoverTurn(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly expectedRevision: number;
    readonly previousAttempt: number;
    readonly assigneePrincipalId: string;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const history = await this.sync(input.groupId);
    const turn = history.projection.turns[input.turnId];
    if (!turn || turn.attempt !== input.previousAttempt)
      throw new Error('Turn recovery attempt is stale');
    const nextAttempt = input.previousAttempt + 1;
    const startDeadlineAt = collaborationDeadlineAtV3(
      new Date(this.now()).toISOString(),
      turn.timeout_policy_snapshot?.start_timeout_ms,
    );
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'turn_recovered',
      payload: {
        turn_id: input.turnId,
        assignee_principal_id: input.assigneePrincipalId,
        previous_attempt: input.previousAttempt,
        next_attempt: nextAttempt,
        reason: input.reason,
        start_deadline_at: startDeadlineAt,
        deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
          turnId: input.turnId,
          attempt: nextAttempt,
          timeoutPolicy: turn.timeout_policy_snapshot,
          startDeadlineAt,
          startedAt: null,
          executionDeadlineAt: null,
        }),
      },
    });
  }

  async observeDueTimeouts(groupId: string): Promise<{
    readonly observed: number;
    readonly notifications: number;
  }> {
    const group = this.requireLocalMember(groupId);
    let observed = 0;
    let notifications = 0;
    const due = this.store.listDueTimeoutSchedules(this.now(), groupId);
    for (const schedule of due) {
      const history = await this.sync(groupId);
      const turn = history.projection.turns[schedule.turnId];
      const instance =
        history.projection.workflowInstances[schedule.instanceId];
      if (
        !turn ||
        !instance ||
        turn.attempt !== schedule.attempt ||
        (schedule.deadlineKind === 'start'
          ? turn.state !== 'pending' ||
            Date.parse(turn.start_deadline_at ?? '') !== schedule.deadlineAtMs
          : ![
              'running',
              'waiting_input',
              'waiting_approval',
              'awaiting_confirmation',
            ].includes(turn.state) ||
            Date.parse(turn.execution_deadline_at ?? '') !==
              schedule.deadlineAtMs)
      ) {
        this.store.advanceTimeoutSchedule(
          schedule.scheduleId,
          schedule.reminderOrdinal,
          this.now(),
        );
        continue;
      }
      const prior = history.projection.timeoutObservations[turn.turn_id]?.some(
        (candidate) =>
          candidate.attempt === turn.attempt &&
          candidate.deadlineKind === schedule.deadlineKind,
      );
      if (!prior) {
        const revision =
          history.projection.aggregateHeads[
            `workflow_instance:${instance.instance_id}`
          ]!.revision;
        await this.appendLocal(groupId, {
          aggregateType: 'workflow_instance',
          aggregateId: instance.instance_id,
          expectedRevision: revision,
          eventType: 'turn_timeout_observed',
          payload: {
            turn_id: turn.turn_id,
            attempt: turn.attempt,
            deadline_kind: schedule.deadlineKind,
            deadline_at: new Date(schedule.deadlineAtMs).toISOString(),
            observed_at: new Date(this.now()).toISOString(),
            turn_snapshot_hash: turn.deadline_snapshot_hash,
          },
        });
        observed += 1;
      }
      const recipient = group.localPrincipalId!;
      if (
        recipient === turn.assignee_principal_id ||
        recipient === instance.created_by_principal_id
      ) {
        const result = this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: recipient,
          recipientClientId: group.localClientId!,
          kind: 'workflow_state_timeout',
          resourceType: 'workflow_instance',
          resourceId: instance.instance_id,
          reason: `${schedule.deadlineKind}_timeout`,
          dedupeKey: `workflow-timeout:${groupId}:${turn.turn_id}:${String(turn.attempt)}:${schedule.deadlineKind}:${String(schedule.reminderOrdinal)}:${recipient}`,
          reminderOrdinal: schedule.reminderOrdinal,
          dueAtMs: schedule.deadlineAtMs,
          payload: {
            turn_id: turn.turn_id,
            state_id: turn.state_id,
            deadline_kind: schedule.deadlineKind,
          },
          nowMs: this.now(),
        });
        if (result.enqueued) notifications += 1;
      }
      this.store.advanceTimeoutSchedule(
        schedule.scheduleId,
        schedule.reminderOrdinal,
        this.now(),
      );
    }
    return { observed, notifications };
  }

  refreshDueNotifications(groupId: string): number {
    const group = this.requireLocalMember(groupId);
    const projection = group.projection;
    if (!projection) return 0;
    let enqueued = 0;
    for (const item of Object.values(projection.workItems)) {
      if (
        !item.due_at ||
        item.archived ||
        ['done', 'cancelled'].includes(item.status) ||
        Date.parse(item.due_at) > this.now()
      )
        continue;
      const recipient = group.localPrincipalId!;
      const isAdmin =
        recipient === projection.group.owner_principal_id ||
        projection.permissionGrants[recipient]?.grants.includes('group:admin');
      if (
        recipient !== item.owner_principal_id &&
        !item.watchers.includes(recipient) &&
        !isAdmin
      )
        continue;
      const result = this.store.enqueueNotification({
        groupId,
        recipientPrincipalId: recipient,
        recipientClientId: group.localClientId!,
        kind: 'work_item_due',
        resourceType: 'work_item',
        resourceId: item.work_item_id,
        reason: 'due_at_reached',
        dedupeKey: `work-item-due:${groupId}:${item.work_item_id}:${item.due_at}:${recipient}`,
        dueAtMs: Date.parse(item.due_at),
        payload: { due_at: item.due_at, status: item.status },
        nowMs: this.now(),
      });
      if (result.enqueued) enqueued += 1;
    }
    return enqueued;
  }

  async readVerifiedFile(input: {
    readonly groupId: string;
    readonly repositoryFile: string;
    readonly verifiedCommit?: string;
  }): Promise<Buffer> {
    const group = this.store.getGroup(input.groupId);
    if (!group?.lastVerifiedHead)
      throw new Error('Group has no verified snapshot');
    const verifiedHead = input.verifiedCommit ?? group.lastVerifiedHead;
    if (
      input.verifiedCommit &&
      !this.store.hasVerifiedCommit(input.groupId, input.verifiedCommit)
    )
      throw new Error('Requested Action snapshot commit is not verified');
    return this.transport.readVerifiedFile({
      repositoryPath: group.repositoryPath,
      verifiedHead,
      repositoryFile: input.repositoryFile,
    });
  }

  async sync(groupId: string): Promise<ValidatedProjectSpaceHistory> {
    const group = this.store.getGroup(groupId);
    if (!group) throw new Error(`Collaboration Group not found: ${groupId}`);
    return this.withRepositoryOperation(group.repositoryPath, () =>
      this.syncUnlocked(groupId),
    );
  }

  private async syncUnlocked(
    groupId: string,
  ): Promise<ValidatedProjectSpaceHistory> {
    const group = this.store.getGroup(groupId);
    if (!group) throw new Error(`Collaboration Group not found: ${groupId}`);
    const attemptId = this.store.startSyncAttempt(
      groupId,
      group.lastVerifiedHead,
      this.now(),
    );
    try {
      const history = await this.transport.inspect({
        remoteUrl: group.remoteUrl,
        repositoryPath: group.repositoryPath,
        previousHead: group.lastVerifiedHead,
        gitSshKeyPath: group.gitSshKeyPath,
      });
      this.saveHistory(groupId, history);
      this.store.finishSyncAttempt({
        id: attemptId,
        groupId,
        outcome: 'succeeded',
        headAfter: history.head,
        nowMs: this.now(),
      });
      const refreshed = this.store.getGroup(groupId);
      const detachReason =
        history.projection.group.lifecycle === 'dissolved'
          ? 'group_dissolved'
          : refreshed?.localPrincipalId &&
              history.projection.members[refreshed.localPrincipalId]?.status ===
                'left'
            ? 'member_left'
            : null;
      if (detachReason)
        await this.detachAndCleanup(groupId, detachReason, history.head);
      return history;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'CollaborationProjectSpaceHistoryRewrittenError'
      )
        this.store.stopWritesAfterHistoryRewrite(groupId, error.message);
      this.store.finishSyncAttempt({
        id: attemptId,
        groupId,
        outcome: 'failed',
        headAfter: group.lastVerifiedHead,
        error: error instanceof Error ? error.message : String(error),
        errorClass: error instanceof Error ? error.name : 'Error',
        nowMs: this.now(),
      });
      this.store.recordIntegrityIncident({
        groupId,
        code: 'SYNC_VALIDATION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
      if (group.localPrincipalId && group.localClientId)
        this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: group.localPrincipalId,
          recipientClientId: group.localClientId,
          kind: 'protocol_sync_failure',
          resourceType: 'protocol',
          resourceId: groupId,
          reason: 'verified_sync_failed',
          dedupeKey: `protocol-sync:${group.lastVerifiedHead ?? 'none'}:${crypto
            .createHash('sha256')
            .update(error instanceof Error ? error.message : String(error))
            .digest('hex')
            .slice(0, 16)}`,
          severity: 'critical',
          payload: {
            last_verified_head: group.lastVerifiedHead,
            error_class: error instanceof Error ? error.name : 'Error',
          },
          nowMs: this.now(),
        });
      throw error;
    }
  }

  getCachedHistory(groupId: string): ValidatedProjectSpaceHistory | null {
    return this.histories.get(groupId) ?? null;
  }

  private inspectResult(
    history: ValidatedProjectSpaceHistory,
    repositoryPath: string,
  ): ProjectSpaceInspectResult {
    const projection = history.projection;
    return {
      group: projection.group,
      verifiedHead: history.head,
      memberCount: Object.keys(projection.members).length,
      activeMemberCount: Object.values(projection.members).filter(
        (member) => member.status === 'active',
      ).length,
      workItemCount: Object.keys(projection.workItems).length,
      workflowDefinitionCount: Object.keys(projection.workflowDefinitions)
        .length,
      workflowInstanceCount: Object.keys(projection.workflowInstances).length,
      repositoryPath,
      projection,
    };
  }

  private async finishGroupInitialization(
    operation: CollaborationGroupInitializationOperation,
    pushedHistory: ValidatedProjectSpaceHistory,
    cacheAlreadyRefreshed = false,
  ): Promise<CollaborationProjectSpaceGroupRecord | null> {
    const history = cacheAlreadyRefreshed
      ? pushedHistory
      : await this.transport.refreshAfterReinitialize({
          remoteUrl: operation.remoteUrl,
          repositoryPath: operation.repositoryPath,
          gitSshKeyPath: operation.gitSshKeyPath,
        });
    if (history.projection.groupId === operation.oldGroupId)
      throw new Error(
        'The remote still exposes the old Group after initialization',
      );
    const localWon = history.projection.groupId === operation.newGroupId;
    const maySubscribe =
      localWon ||
      history.projection.group.visibility_policy.observer_access === 'allowed';
    const group = this.store.replaceGroupAfterInitialization({
      operationId: operation.operationId,
      history,
      identity: localWon ? operation.identity : null,
      recoveryIdentity: localWon ? operation.recoveryIdentity : null,
      nowMs: this.now(),
    });
    this.histories.delete(operation.oldGroupId);
    if (!localWon) this.histories.delete(operation.newGroupId);
    if (group) this.histories.set(group.groupId, history);
    else this.histories.delete(history.projection.groupId);
    await this.cleanupFinishedInitialization(operation, localWon, maySubscribe);
    return group;
  }

  private async discardPreparedInitialization(
    operation: CollaborationGroupInitializationOperation,
  ): Promise<void> {
    await this.deleteUnreferencedCredentialIdentities(
      [
        operation.identity.credentialId,
        operation.recoveryIdentity.credentialId,
      ],
      operation.operationId,
    );
    this.store.deleteGroupInitialization(operation.operationId);
  }

  private async cleanupFinishedInitialization(
    operation: CollaborationGroupInitializationOperation,
    localWon: boolean,
    keepRepository: boolean,
  ): Promise<void> {
    const stagingRoot = path.resolve(
      path.dirname(this.store.databasePath),
      'collaboration-staged-artifacts',
    );
    for (const directory of operation.cleanup.stagedDirectories) {
      const target = path.resolve(directory);
      if (!target.startsWith(`${stagingRoot}${path.sep}`))
        throw new Error(
          `Initialization refused unsafe staged Artifact cleanup path: ${directory}`,
        );
      await rm(target, { recursive: true, force: true });
    }
    this.store.purgeManagedBackupsForGroup(operation.oldGroupId);
    if (!localWon) this.store.purgeManagedBackupsForGroup(operation.newGroupId);
    await this.deleteUnreferencedCredentialIdentities(
      [
        ...operation.cleanup.credentialIds,
        ...(localWon
          ? []
          : [
              operation.identity.credentialId,
              operation.recoveryIdentity.credentialId,
            ]),
      ],
      operation.operationId,
    );
    if (!keepRepository) {
      const expectedRepository = path.resolve(
        collaborationProjectSpaceRepositoryPath(
          this.repositoryRoot,
          operation.remoteUrl,
        ),
      );
      if (path.resolve(operation.repositoryPath) !== expectedRepository)
        throw new Error(
          `Initialization refused unsafe repository cleanup path: ${operation.repositoryPath}`,
        );
      await rm(expectedRepository, { recursive: true, force: true });
    }
    this.store.deleteGroupInitialization(operation.operationId);
  }

  private async deleteUnreferencedCredentialIdentities(
    credentialIds: readonly string[],
    excludingOperationId: string,
  ): Promise<void> {
    for (const credentialId of new Set(credentialIds))
      if (
        !this.store.credentialIdentityIsReferenced(
          credentialId,
          excludingOperationId,
        )
      )
        await this.identities.deleteCredentialIdentity(credentialId);
  }

  private async requireCompletedCleanup(groupId: string): Promise<void> {
    const binding = this.store.getLocalGroupBinding(groupId);
    if (binding?.bindingState !== 'cleanup_pending') return;
    const result = await this.retryLocalCleanup(groupId);
    if (result.cleanupPending)
      throw new Error(
        `Local Group cleanup must complete before reattaching: ${result.cleanupError ?? 'unknown cleanup failure'}`,
      );
  }

  private async restoreBoundIdentity(
    binding: CollaborationLocalGroupBinding,
    history: ValidatedProjectSpaceHistory,
    allowedStatuses: readonly MemberDefinitionV3['status'][],
  ): Promise<CollaborationEventSigningIdentity | null> {
    if (!binding.principalId || !binding.credentialId) return null;
    const member = history.projection.members[binding.principalId];
    const credential =
      history.projection.credentials[binding.principalId]?.[
        binding.credentialId
      ];
    if (
      !member ||
      !allowedStatuses.includes(member.status) ||
      !credential ||
      credential.status !== 'active'
    )
      return null;
    const identity = await this.identities.loadCredentialIdentity(
      binding.credentialId,
    );
    if (
      identity.principalId !== binding.principalId ||
      identity.clientId !== credential.client_id ||
      identity.purpose !== 'event_signing' ||
      history.projection.clients[binding.principalId]?.[identity.clientId]
        ?.status !== 'active'
    )
      throw new Error(
        'Retained Collaboration identity does not match the Group',
      );
    return identity;
  }

  private async restoreBoundRecoveryIdentity(
    binding: CollaborationLocalGroupBinding,
    history: ValidatedProjectSpaceHistory,
  ): Promise<CollaborationEventSigningIdentity | null> {
    if (!binding.principalId || !binding.recoveryCredentialId) return null;
    const credential =
      history.projection.credentials[binding.principalId]?.[
        binding.recoveryCredentialId
      ];
    if (
      !credential ||
      credential.status !== 'active' ||
      credential.purpose !== 'group_recovery'
    )
      return null;
    const identity = await this.identities.loadCredentialIdentity(
      binding.recoveryCredentialId,
    );
    if (
      identity.credentialId !== binding.recoveryCredentialId ||
      identity.principalId !== binding.principalId ||
      identity.clientId !== credential.client_id ||
      identity.purpose !== 'group_recovery'
    )
      throw new Error(
        'Retained Collaboration recovery identity does not match the Group',
      );
    return identity;
  }

  private registerLocalGroup(input: {
    readonly history: ValidatedProjectSpaceHistory;
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath: string;
    readonly mode: 'observer' | 'member';
    readonly identity?: CollaborationEventSigningIdentity;
    readonly recoveryIdentity?: CollaborationEventSigningIdentity;
    readonly pollIntervalMs?: number;
    readonly notificationsEnabled?: boolean;
  }): void {
    const existing = this.store.getGroup(input.history.projection.groupId);
    if (existing) {
      this.store.updateGroupLocator({
        groupId: input.history.projection.groupId,
        remoteUrl: input.remoteUrl,
        repositoryPath: input.repositoryPath,
        gitSshKeyPath: input.gitSshKeyPath,
        nowMs: this.now(),
      });
      if (input.identity)
        this.store.updateLocalIdentity({
          groupId: input.history.projection.groupId,
          subscriptionMode: input.mode,
          localPrincipalId: input.identity.principalId,
          localClientId: input.identity.clientId,
          localCredentialId: input.identity.credentialId,
          eventPrivateKeyPath: input.identity.privateKeyPath,
          eventPublicKey: input.identity.publicKey,
          eventFingerprint: input.identity.fingerprint,
          recoveryCredentialId: input.recoveryIdentity?.credentialId,
          recoveryPrivateKeyPath: input.recoveryIdentity?.privateKeyPath,
        });
      this.saveHistory(input.history.projection.groupId, input.history);
      return;
    }
    const pollIntervalMs = input.pollIntervalMs ?? 60_000;
    const subscription: ObserverSubscription = {
      format: 'icarus.collaboration-subscription/1',
      group_id: input.history.projection.groupId,
      remote_url: input.remoteUrl,
      subscription_mode: input.mode,
      poll_interval_ms: pollIntervalMs,
      last_verified_head: input.history.head,
      notifications_enabled: input.notificationsEnabled ?? true,
      created_at: new Date(this.now()).toISOString(),
    };
    this.store.registerGroup({
      subscription,
      name: input.history.projection.group.name,
      lifecycle: input.history.projection.group.lifecycle,
      ownerPrincipalId: input.history.projection.group.owner_principal_id,
      repositoryPath: input.repositoryPath,
      gitSshKeyPath: input.gitSshKeyPath,
      localPrincipalId: input.identity?.principalId ?? null,
      localClientId: input.identity?.clientId ?? null,
      localCredentialId: input.identity?.credentialId ?? null,
      eventPrivateKeyPath: input.identity?.privateKeyPath ?? null,
      eventPublicKey: input.identity?.publicKey ?? null,
      eventFingerprint: input.identity?.fingerprint ?? null,
      recoveryCredentialId: input.recoveryIdentity?.credentialId ?? null,
      recoveryPrivateKeyPath: input.recoveryIdentity?.privateKeyPath ?? null,
      nowMs: this.now(),
    });
    this.saveHistory(input.history.projection.groupId, input.history);
  }

  private registerOrUpgradeMember(input: {
    readonly history: ValidatedProjectSpaceHistory;
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath: string;
    readonly identity: CollaborationEventSigningIdentity;
    readonly recoveryIdentity?: CollaborationEventSigningIdentity;
    readonly pollIntervalMs?: number;
    readonly pending?: boolean;
  }): void {
    const existing = this.store.getGroup(input.history.projection.groupId);
    const subscriptionMode = input.pending ? 'observer' : 'member';
    if (existing) {
      this.store.updateLocalIdentity({
        groupId: input.history.projection.groupId,
        subscriptionMode,
        localPrincipalId: input.identity.principalId,
        localClientId: input.identity.clientId,
        localCredentialId: input.identity.credentialId,
        eventPrivateKeyPath: input.identity.privateKeyPath,
        eventPublicKey: input.identity.publicKey,
        eventFingerprint: input.identity.fingerprint,
        recoveryCredentialId: input.recoveryIdentity?.credentialId,
        recoveryPrivateKeyPath: input.recoveryIdentity?.privateKeyPath,
      });
      this.store.updateGroupLocator({
        groupId: input.history.projection.groupId,
        remoteUrl: input.remoteUrl,
        repositoryPath: input.repositoryPath,
        gitSshKeyPath: input.gitSshKeyPath,
        nowMs: this.now(),
      });
      this.saveHistory(input.history.projection.groupId, input.history);
      return;
    }
    this.registerLocalGroup({
      ...input,
      mode: subscriptionMode,
    });
  }

  private async appendLocal(
    groupId: string,
    input: {
      readonly aggregateType: CollaborationAggregateType;
      readonly aggregateId: string;
      readonly expectedRevision: number;
      readonly eventType: CollaborationEventTypeV3;
      readonly payload: Record<string, unknown>;
      readonly replaceEventId?: boolean;
      readonly eventId?: string;
      readonly occurredAt?: string;
      readonly executorId?: string | null;
      readonly materializedFiles?: readonly {
        readonly path: string;
        readonly contents: string | Buffer | null;
      }[];
    },
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.store.getGroup(groupId);
    if (!group) throw new Error(`Collaboration Group not found: ${groupId}`);
    return this.withRepositoryOperation(group.repositoryPath, async () => {
      const currentGroup = this.store.getGroup(groupId);
      if (
        !currentGroup ||
        currentGroup.subscriptionMode !== 'member' ||
        !currentGroup.localPrincipalId ||
        !currentGroup.localClientId ||
        !currentGroup.localCredentialId ||
        !currentGroup.eventPrivateKeyPath ||
        !currentGroup.eventPublicKey ||
        !currentGroup.eventFingerprint
      )
        throw new Error(
          'Observer subscriptions cannot issue collaboration commands',
        );
      const history = await this.syncUnlocked(groupId);
      const head =
        history.projection.aggregateHeads[
          `${input.aggregateType}:${input.aggregateId}`
        ];
      if ((head?.revision ?? 0) !== input.expectedRevision)
        throw new Error(
          `Aggregate revision conflict: expected ${String(input.expectedRevision)}, current ${String(head?.revision ?? 0)}`,
        );
      const identity: CollaborationEventSigningIdentity = {
        principalId: currentGroup.localPrincipalId,
        clientId: currentGroup.localClientId,
        credentialId: currentGroup.localCredentialId,
        privateKeyPath: currentGroup.eventPrivateKeyPath,
        publicKey: currentGroup.eventPublicKey,
        fingerprint: currentGroup.eventFingerprint,
        purpose: 'event_signing',
      };
      const updated = await this.appendWithIdentity({
        history,
        remoteUrl: currentGroup.remoteUrl,
        repositoryPath: currentGroup.repositoryPath,
        gitSshKeyPath: currentGroup.gitSshKeyPath,
        identity,
        ...input,
      });
      this.saveHistory(groupId, updated);
      return this.store.getGroup(groupId)!;
    });
  }

  private async appendTerminalLocal(
    groupId: string,
    input: {
      readonly expectedRevision: number;
      readonly eventType: 'group_dissolved' | 'member_left';
      readonly reason: string;
      readonly detachReason: 'group_dissolved' | 'member_left';
      readonly validate: (
        projection: CollaborationProjectionV3,
        principalId: string,
      ) => void;
    },
  ): Promise<CollaborationLocalGroupRemovalResult> {
    const group = this.store.getGroup(groupId);
    if (!group) throw new Error(`Collaboration Group not found: ${groupId}`);
    return this.withRepositoryOperation(group.repositoryPath, async () => {
      const currentGroup = this.requireLocalMember(groupId);
      if (
        !currentGroup.localCredentialId ||
        !currentGroup.eventPrivateKeyPath ||
        !currentGroup.eventPublicKey ||
        !currentGroup.eventFingerprint
      )
        throw new Error('Local Collaboration signing identity is incomplete');
      const history = await this.syncUnlocked(groupId);
      input.validate(history.projection, currentGroup.localPrincipalId!);
      const aggregateId =
        input.eventType === 'group_dissolved'
          ? groupId
          : currentGroup.localPrincipalId!;
      const head =
        history.projection.aggregateHeads[
          `${input.eventType === 'group_dissolved' ? 'group' : 'membership'}:${aggregateId}`
        ];
      if ((head?.revision ?? 0) !== input.expectedRevision)
        throw new Error(
          `Aggregate revision conflict: expected ${String(input.expectedRevision)}, current ${String(head?.revision ?? 0)}`,
        );
      const identity: CollaborationEventSigningIdentity = {
        principalId: currentGroup.localPrincipalId!,
        clientId: currentGroup.localClientId!,
        credentialId: currentGroup.localCredentialId,
        privateKeyPath: currentGroup.eventPrivateKeyPath,
        publicKey: currentGroup.eventPublicKey,
        fingerprint: currentGroup.eventFingerprint,
        purpose: 'event_signing',
      };
      const updated = await this.appendWithIdentity({
        history,
        remoteUrl: currentGroup.remoteUrl,
        repositoryPath: currentGroup.repositoryPath,
        gitSshKeyPath: currentGroup.gitSshKeyPath,
        identity,
        aggregateType:
          input.eventType === 'group_dissolved' ? 'group' : 'membership',
        aggregateId,
        eventType: input.eventType,
        payload:
          input.eventType === 'member_left'
            ? {
                reason: input.reason,
                affected_turn_ids: collaborationMemberLeftAffectedTurnIdsV3(
                  history.projection,
                  currentGroup.localPrincipalId!,
                ),
              }
            : { reason: input.reason },
      });
      this.saveHistory(groupId, updated);
      try {
        return await this.detachAndCleanup(
          groupId,
          input.detachReason,
          updated.head,
        );
      } catch (error) {
        return {
          groupId,
          removed: false,
          cleanupPending: true,
          cleanupError: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  private async detachAndCleanup(
    groupId: string,
    reason: 'local_remove' | 'member_left' | 'group_dissolved',
    terminalHead: string | null,
  ): Promise<CollaborationLocalGroupRemovalResult> {
    const plan = this.store.detachLocalGroup({
      groupId,
      reason,
      terminalHead,
      nowMs: this.now(),
    });
    this.histories.delete(groupId);
    if (plan.binding?.bindingState !== 'cleanup_pending')
      return {
        groupId,
        removed: plan.detached,
        cleanupPending: false,
        cleanupError: null,
      };
    const cleanup = await this.retryLocalCleanup(groupId);
    return { ...cleanup, removed: plan.detached };
  }

  private async withRepositoryOperation<T>(
    repositoryPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.repositoryOperations.get(repositoryPath);
    const result = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.repositoryOperations.set(repositoryPath, settled);
    try {
      return await result;
    } finally {
      if (this.repositoryOperations.get(repositoryPath) === settled)
        this.repositoryOperations.delete(repositoryPath);
    }
  }

  private async appendWithIdentity(input: {
    readonly history: ValidatedProjectSpaceHistory;
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath: string;
    readonly identity: CollaborationEventSigningIdentity;
    readonly aggregateType: CollaborationAggregateType;
    readonly aggregateId: string;
    readonly eventType: CollaborationEventTypeV3;
    readonly payload: Record<string, unknown>;
    readonly replaceEventId?: boolean;
    readonly eventId?: string;
    readonly occurredAt?: string;
    readonly executorId?: string | null;
    readonly materializedFiles?: readonly {
      readonly path: string;
      readonly contents: string | Buffer | null;
    }[];
  }): Promise<ValidatedProjectSpaceHistory> {
    return this.transport.append({
      remoteUrl: input.remoteUrl,
      repositoryPath: input.repositoryPath,
      gitSshKeyPath: input.gitSshKeyPath,
      previousHead: input.history.head,
      identity: input.identity,
      buildEvent: (history) => {
        const head =
          history.projection.aggregateHeads[
            `${input.aggregateType}:${input.aggregateId}`
          ];
        const eventId = input.eventId ?? newId('evt');
        const occurredAt =
          input.occurredAt ?? new Date(this.now()).toISOString();
        const payload = input.replaceEventId
          ? (JSON.parse(
              JSON.stringify(input.payload)
                .replaceAll('__EVENT_ID__', eventId)
                .replaceAll('__OCCURRED_AT__', occurredAt),
            ) as Record<string, unknown>)
          : input.payload;
        const event = buildCollaborationEventV3({
          groupId: history.projection.groupId,
          eventId,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          aggregateRevision: (head?.revision ?? 0) + 1,
          previousEventHash: head?.eventHash ?? null,
          eventType: input.eventType,
          actor: {
            principal_id: input.identity.principalId,
            client_id: input.identity.clientId,
            credential_id: input.identity.credentialId,
            executor_id: input.executorId ?? null,
          },
          occurredAt,
          payload,
        });
        reduceCollaborationEventV3(history.projection, event);
        return input.materializedFiles
          ? { event, materializedFiles: input.materializedFiles }
          : event;
      },
    });
  }

  private async requireHistory(
    groupId: string,
  ): Promise<ValidatedProjectSpaceHistory> {
    return this.histories.get(groupId) ?? (await this.sync(groupId));
  }

  private saveHistory(
    groupId: string,
    history: ValidatedProjectSpaceHistory,
  ): void {
    const previousProjection = this.store.getGroup(groupId)?.projection ?? null;
    const knownEventIds = new Set(
      this.store
        .listEventRecords(groupId)
        .map((record) => record.event.event_id),
    );
    this.histories.set(groupId, history);
    this.store.saveVerifiedProjection({
      groupId,
      verifiedHead: history.head,
      projection: history.projection,
      eventRecords: history.eventRecords,
      nowMs: this.now(),
    });
    this.store.syncTimeoutSchedules(
      groupId,
      Object.values(history.projection.turns),
    );
    let group = this.store.getGroup(groupId);
    if (
      group?.subscriptionMode === 'observer' &&
      group.localPrincipalId &&
      group.localClientId &&
      group.localCredentialId &&
      group.eventPrivateKeyPath &&
      group.eventPublicKey &&
      group.eventFingerprint &&
      history.projection.members[group.localPrincipalId]?.status === 'active' &&
      history.projection.clients[group.localPrincipalId]?.[group.localClientId]
        ?.status === 'active' &&
      history.projection.credentials[group.localPrincipalId]?.[
        group.localCredentialId
      ]?.status === 'active'
    ) {
      this.store.updateLocalIdentity({
        groupId,
        subscriptionMode: 'member',
        localPrincipalId: group.localPrincipalId,
        localClientId: group.localClientId,
        localCredentialId: group.localCredentialId,
        eventPrivateKeyPath: group.eventPrivateKeyPath,
        eventPublicKey: group.eventPublicKey,
        eventFingerprint: group.eventFingerprint,
      });
      group = this.store.getGroup(groupId);
    }
    if (
      group?.subscriptionMode !== 'member' ||
      !group.localPrincipalId ||
      !group.localClientId
    )
      return;
    for (const record of history.eventRecords) {
      if (knownEventIds.has(record.event.event_id)) continue;
      if (
        record.event.event_type === 'member_left' &&
        group.localPrincipalId === history.projection.group.owner_principal_id
      )
        for (const turnId of record.event.payload
          .affected_turn_ids as string[]) {
          this.store.enqueueNotification({
            groupId,
            recipientPrincipalId: group.localPrincipalId,
            recipientClientId: group.localClientId,
            kind: 'member_left_workflow_recovery',
            resourceType: 'turn',
            resourceId: turnId,
            reason: 'member_left',
            dedupeKey: `member-left-recovery:${record.event.event_id}:${turnId}:${group.localClientId}`,
            severity: 'critical',
            payload: {
              principal_id: record.event.actor.principal_id,
              turn_id: turnId,
            },
            nowMs: this.now(),
          });
        }
      if (
        ['identity_recovery_requested', 'owner_recovery_requested'].includes(
          record.event.event_type,
        )
      ) {
        const parsed = recoveryRequestSchema.safeParse(
          record.event.payload.request,
        );
        if (!parsed.success) continue;
        const recipient: string =
          parsed.data.type === 'identity_recovery'
            ? parsed.data.target_principal_id
            : history.projection.group.owner_principal_id;
        if (recipient !== group.localPrincipalId) continue;
        this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: group.localPrincipalId,
          recipientClientId: group.localClientId,
          kind: parsed.data.type,
          resourceType: 'recovery_request',
          resourceId: parsed.data.request_id,
          reason:
            parsed.data.type === 'identity_recovery'
              ? 'device_approval_required'
              : 'offline_identity_verification_required',
          dedupeKey: `recovery-request:${groupId}:${parsed.data.request_hash}:${group.localClientId}`,
          payload: {
            request_id: parsed.data.request_id,
            request_hash: parsed.data.request_hash,
            verification_code: collaborationRecoveryVerificationCodeV3(
              parsed.data.request_hash,
            ),
            expires_at: parsed.data.expires_at,
          },
          nowMs: this.now(),
        });
        continue;
      }
      if (
        [
          'recovery_approved',
          'recovery_rejected',
          'recovery_expired',
          'recovery_cancelled',
        ].includes(record.event.event_type)
      ) {
        const request =
          history.projection.recoveryRequests[record.event.aggregate_id];
        if (!request || request.target_principal_id !== group.localPrincipalId)
          continue;
        this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: group.localPrincipalId,
          recipientClientId: group.localClientId,
          kind: record.event.event_type,
          resourceType: 'recovery_request',
          resourceId: request.request_id,
          reason: request.status,
          dedupeKey: `recovery-decision:${groupId}:${request.request_hash}:${request.status}:${group.localClientId}`,
          payload: {
            request_id: request.request_id,
            request_hash: request.request_hash,
            status: request.status,
            approval_kind: request.approval_kind,
          },
          nowMs: this.now(),
        });
        continue;
      }
      if (
        record.event.aggregate_type === 'work_item' &&
        [
          'work_item_created',
          'work_item_assignment_changed',
          'work_item_assignment_acknowledged',
          'work_item_assignment_declined',
          'work_item_status_changed',
          'work_item_relation_changed',
          'work_item_details_updated',
        ].includes(record.event.event_type)
      ) {
        const item = history.projection.workItems[record.event.aggregate_id];
        if (!item) continue;
        const localIsOwner = item.owner_principal_id === group.localPrincipalId;
        const localIsWatcher = item.watchers.includes(group.localPrincipalId);
        const activeBlockers = item.blocked_by.filter((id) => {
          const blocker = history.projection.workItems[id];
          return (
            blocker &&
            !blocker.archived &&
            !['done', 'cancelled'].includes(blocker.status)
          );
        });
        const currentlyBlocked =
          item.status === 'blocked' || activeBlockers.length > 0;
        if (
          localIsOwner &&
          item.assignment_status === 'pending' &&
          ['work_item_created', 'work_item_assignment_changed'].includes(
            record.event.event_type,
          )
        )
          this.store.enqueueNotification({
            groupId,
            recipientPrincipalId: group.localPrincipalId,
            recipientClientId: group.localClientId,
            kind: 'work_item_assignment',
            resourceType: 'work_item',
            resourceId: item.work_item_id,
            reason: 'assignment_confirmation_required',
            dedupeKey: `work-item-assignment:${item.work_item_id}:${String(item.revision)}`,
            severity: ['high', 'urgent'].includes(item.priority)
              ? 'high'
              : 'medium',
            dueAtMs: item.due_at ? Date.parse(item.due_at) : null,
            payload: {
              title: item.title,
              assignment_status: item.assignment_status,
              priority: item.priority,
            },
            nowMs: this.now(),
          });
        if (localIsOwner && currentlyBlocked)
          this.store.enqueueNotification({
            groupId,
            recipientPrincipalId: group.localPrincipalId,
            recipientClientId: group.localClientId,
            kind: 'work_item_blocked',
            resourceType: 'work_item',
            resourceId: item.work_item_id,
            reason: 'active_blocker',
            dedupeKey: `work-item-blocked:${item.work_item_id}:${activeBlockers
              .map((id) => {
                const blocker = history.projection.workItems[id]!;
                return `${id}@${String(blocker.revision)}:${blocker.status}`;
              })
              .sort()
              .join(',')}:${item.status}`,
            severity: ['high', 'urgent'].includes(item.priority)
              ? 'high'
              : 'medium',
            payload: {
              title: item.title,
              status: item.status,
              active_blocker_ids: activeBlockers,
            },
            nowMs: this.now(),
          });
        if (
          record.event.actor.principal_id !== group.localPrincipalId &&
          (localIsOwner || localIsWatcher) &&
          ['work_item_status_changed', 'work_item_assignment_changed'].includes(
            record.event.event_type,
          )
        )
          this.store.enqueueNotification({
            groupId,
            recipientPrincipalId: group.localPrincipalId,
            recipientClientId: group.localClientId,
            kind: 'work_item_status_change',
            resourceType: 'work_item',
            resourceId: item.work_item_id,
            reason: item.status,
            dedupeKey: `work-item-status:${item.work_item_id}:${String(item.revision)}:${item.status}`,
            severity:
              item.status === 'blocked' ||
              (item.due_at && Date.parse(item.due_at) <= this.now())
                ? 'high'
                : 'low',
            payload: {
              title: item.title,
              status: item.status,
              assignment_status: item.assignment_status,
            },
            nowMs: this.now(),
          });
        continue;
      }
      if (
        record.event.aggregate_type === 'workflow_instance' &&
        [
          'workflow_instance_started',
          'workflow_instance_resumed',
          'workflow_state_assignee_changed',
          'turn_completed',
          'turn_cancelled',
          'turn_recovered',
        ].includes(record.event.event_type)
      ) {
        const instance =
          history.projection.workflowInstances[record.event.aggregate_id];
        if (
          instance?.lifecycle === 'running' &&
          !instance.active_turn_id &&
          instance.resolved_assignments[instance.business_state] ===
            group.localPrincipalId
        )
          this.store.enqueueNotification({
            groupId,
            recipientPrincipalId: group.localPrincipalId,
            recipientClientId: group.localClientId,
            kind: 'workflow_state_action',
            resourceType: 'workflow_instance',
            resourceId: instance.instance_id,
            reason: 'state_assignment_ready',
            dedupeKey: `workflow-state:${instance.instance_id}:${String(instance.revision)}:${instance.business_state}`,
            severity: 'medium',
            payload: {
              state_id: instance.business_state,
              lifecycle: instance.lifecycle,
            },
            nowMs: this.now(),
          });
        continue;
      }
      if (
        [
          'turn_created',
          'action_waiting_input',
          'action_waiting_approval',
          'action_completed',
          'turn_recovery_requested',
        ].includes(record.event.event_type)
      ) {
        const parsedTurn = collaborationTurnV3Schema.safeParse(
          record.event.payload.turn,
        );
        const instance =
          history.projection.workflowInstances[record.event.aggregate_id];
        const turn = parsedTurn.success
          ? parsedTurn.data
          : instance?.active_turn_id
            ? history.projection.turns[instance.active_turn_id]
            : null;
        if (!turn || turn.assignee_principal_id !== group.localPrincipalId)
          continue;
        this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: group.localPrincipalId,
          recipientClientId: group.localClientId,
          kind: 'workflow_turn_action',
          resourceType: 'turn',
          resourceId: turn.turn_id,
          reason: turn.state,
          dedupeKey: `workflow-turn:${turn.turn_id}:${String(turn.attempt)}:${turn.state}`,
          severity: turn.state === 'recovery_required' ? 'critical' : 'medium',
          dueAtMs:
            turn.execution_deadline_at || turn.start_deadline_at
              ? Date.parse(
                  turn.execution_deadline_at ?? turn.start_deadline_at!,
                )
              : null,
          payload: {
            workflow_instance_id: turn.workflow_instance_id,
            state_id: turn.state_id,
            state: turn.state,
          },
          nowMs: this.now(),
        });
        continue;
      }
      if (
        ['credential_revoked', 'client_revoked'].includes(
          record.event.event_type,
        ) &&
        record.event.aggregate_id === group.localPrincipalId
      ) {
        const credential =
          history.projection.credentials[group.localPrincipalId]?.[
            group.localCredentialId!
          ];
        const client =
          history.projection.clients[group.localPrincipalId]?.[
            group.localClientId
          ];
        if (credential?.status === 'active' && client?.status === 'active')
          continue;
        this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: group.localPrincipalId,
          recipientClientId: group.localClientId,
          kind: 'local_identity_invalid',
          resourceType: 'credential',
          resourceId: group.localCredentialId!,
          reason:
            credential?.status !== 'active'
              ? 'credential_revoked'
              : 'client_revoked',
          dedupeKey: `local-identity:${group.localCredentialId}:${credential?.status ?? 'missing'}:${client?.status ?? 'missing'}`,
          severity: 'critical',
          payload: {
            credential_status: credential?.status ?? 'missing',
            client_status: client?.status ?? 'missing',
          },
          nowMs: this.now(),
        });
        continue;
      }
      if (
        !['discussion_created', 'message_posted', 'message_revised'].includes(
          record.event.event_type,
        )
      )
        continue;
      const parsed = discussionMessageSchema.safeParse(
        record.event.payload.message,
      );
      if (
        !parsed.success ||
        parsed.data.author_principal_id === group.localPrincipalId ||
        !parsed.data.mentions.includes(group.localPrincipalId)
      )
        continue;
      this.store.enqueueNotification({
        groupId,
        recipientPrincipalId: group.localPrincipalId,
        recipientClientId: group.localClientId,
        kind: 'discussion_mention',
        resourceType: 'discussion',
        resourceId: parsed.data.thread_id,
        reason: 'mentioned',
        dedupeKey: `discussion-mention:${groupId}:${parsed.data.message_id}:${String(parsed.data.revision)}:${group.localPrincipalId}`,
        payload: {
          message_id: parsed.data.message_id,
          author_principal_id: parsed.data.author_principal_id,
        },
        nowMs: this.now(),
      });
    }
    for (const item of Object.values(history.projection.workItems)) {
      const previousItem = previousProjection?.workItems[item.work_item_id];
      if (
        item.owner_principal_id !== group.localPrincipalId ||
        !previousItem ||
        item.archived ||
        ['done', 'cancelled'].includes(item.status)
      )
        continue;
      const previousWasBlocked =
        previousItem.status === 'blocked' ||
        previousItem.blocked_by.some((id) => {
          const blocker = previousProjection?.workItems[id];
          return (
            blocker &&
            !blocker.archived &&
            !['done', 'cancelled'].includes(blocker.status)
          );
        });
      const currentlyBlocked =
        item.status === 'blocked' ||
        item.blocked_by.some((id) => {
          const blocker = history.projection.workItems[id];
          return (
            blocker &&
            !blocker.archived &&
            !['done', 'cancelled'].includes(blocker.status)
          );
        });
      if (previousWasBlocked && !currentlyBlocked)
        this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: group.localPrincipalId,
          recipientClientId: group.localClientId,
          kind: 'work_item_unblocked',
          resourceType: 'work_item',
          resourceId: item.work_item_id,
          reason: 'blockers_resolved',
          dedupeKey: `work-item-unblocked:${item.work_item_id}:${history.head}`,
          severity: 'low',
          payload: {
            title: item.title,
            status: item.status,
          },
          nowMs: this.now(),
        });
    }
    for (const item of Object.values(history.projection.workItems)) {
      if (
        item.owner_principal_id !== group.localPrincipalId ||
        item.archived ||
        ['done', 'cancelled'].includes(item.status)
      )
        continue;
      const blockedHighPriority = Object.values(
        history.projection.workItems,
      ).filter(
        (dependent) =>
          !dependent.archived &&
          !['done', 'cancelled'].includes(dependent.status) &&
          ['high', 'urgent'].includes(dependent.priority) &&
          dependent.blocked_by.includes(item.work_item_id),
      );
      if (blockedHighPriority.length)
        this.store.enqueueNotification({
          groupId,
          recipientPrincipalId: group.localPrincipalId,
          recipientClientId: group.localClientId,
          kind: 'work_item_blocking_others',
          resourceType: 'work_item',
          resourceId: item.work_item_id,
          reason: 'blocking_high_priority_work',
          dedupeKey: `work-item-blocking:${item.work_item_id}:${blockedHighPriority
            .map(
              (dependent) =>
                `${dependent.work_item_id}@${String(dependent.revision)}:${dependent.status}`,
            )
            .sort()
            .join(',')}`,
          severity: 'high',
          payload: {
            title: item.title,
            blocked_work_item_ids: blockedHighPriority.map(
              (dependent) => dependent.work_item_id,
            ),
          },
          nowMs: this.now(),
        });
      else
        this.store.handleNotificationsByKind({
          groupId,
          resourceType: 'work_item',
          resourceId: item.work_item_id,
          kinds: ['work_item_blocking_others'],
          nowMs: this.now(),
        });
    }
    for (const item of Object.values(history.projection.workItems)) {
      if (item.archived || ['done', 'cancelled'].includes(item.status))
        this.store.handleNotificationsForResource({
          groupId,
          resourceType: 'work_item',
          resourceId: item.work_item_id,
          nowMs: this.now(),
        });
      else {
        if (item.assignment_status !== 'pending')
          this.store.handleNotificationsByKind({
            groupId,
            resourceType: 'work_item',
            resourceId: item.work_item_id,
            kinds: ['work_item_assignment'],
            nowMs: this.now(),
          });
        const blocked =
          item.status === 'blocked' ||
          item.blocked_by.some((id) => {
            const blocker = history.projection.workItems[id];
            return (
              blocker &&
              !blocker.archived &&
              !['done', 'cancelled'].includes(blocker.status)
            );
          });
        if (!blocked)
          this.store.handleNotificationsByKind({
            groupId,
            resourceType: 'work_item',
            resourceId: item.work_item_id,
            kinds: ['work_item_blocked'],
            nowMs: this.now(),
          });
      }
    }
    for (const discussion of Object.values(history.projection.discussions))
      if (discussion.discussion.status === 'resolved')
        this.store.handleNotificationsForResource({
          groupId,
          resourceType: 'discussion',
          resourceId: discussion.discussion.thread_id,
          nowMs: this.now(),
        });
    for (const request of Object.values(history.projection.recoveryRequests))
      if (request.status !== 'pending')
        this.store.handleNotificationsForResource({
          groupId,
          resourceType: 'recovery_request',
          resourceId: request.request_id,
          nowMs: this.now(),
        });
    for (const turn of Object.values(history.projection.turns))
      if (['completed', 'cancelled'].includes(turn.state))
        this.store.handleNotificationsForResource({
          groupId,
          resourceType: 'turn',
          resourceId: turn.turn_id,
          nowMs: this.now(),
        });
    for (const instance of Object.values(history.projection.workflowInstances))
      if (
        instance.lifecycle !== 'running' ||
        Boolean(instance.active_turn_id) ||
        instance.resolved_assignments[instance.business_state] !==
          group.localPrincipalId
      )
        this.store.handleNotificationsByKind({
          groupId,
          resourceType: 'workflow_instance',
          resourceId: instance.instance_id,
          kinds: ['workflow_state_action'],
          nowMs: this.now(),
        });
    if (
      history.projection.integrityStatus === 'OK' &&
      group.protocolStatus === 'OK'
    )
      this.store.handleNotificationsForResource({
        groupId,
        resourceType: 'protocol',
        resourceId: groupId,
        nowMs: this.now(),
      });
    this.refreshDueNotifications(groupId);
  }

  private requireLocalMember(
    groupId: string,
  ): CollaborationProjectSpaceGroupRecord {
    const group = this.store.getGroup(groupId);
    if (
      !group ||
      group.subscriptionMode !== 'member' ||
      !group.localPrincipalId ||
      !group.localClientId
    )
      throw new Error(
        'Observer subscriptions cannot issue collaboration commands',
      );
    return group;
  }

  private artifactContents(contents: Buffer): Buffer {
    if (contents.byteLength > MAX_PROJECT_SPACE_FILE_BYTES)
      throw new Error('Artifact exceeds the 10 MiB local Git limit');
    return Buffer.from(contents);
  }

  private artifactMetadata(
    artifact: CollaborationStagedArtifactV3,
    executorId: string | null,
  ): ArtifactMetadataV3 {
    return artifactMetadataV3Schema.parse({
      format: 'icarus.collaboration-artifact/1',
      artifact_id: artifact.artifactId,
      scope:
        artifact.scopeType === 'work_item'
          ? { type: 'work_item', work_item_id: artifact.scopeId }
          : {
              type: 'workflow_turn',
              workflow_instance_id: artifact.scopeId,
              turn_id: artifact.turnId,
              attempt: artifact.attempt,
              fencing_token: artifact.fencingToken,
            },
      original_filename: artifact.originalName,
      content_ref: artifact.originalName,
      media_type: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
      uploader_principal_id: artifact.principalId,
      uploader_client_id: artifact.clientId,
      executor_id: executorId,
      created_at: new Date(artifact.createdAtMs).toISOString(),
    });
  }

  private artifactRef(metadata: ArtifactMetadataV3): string {
    return metadata.scope.type === 'work_item'
      ? `artifacts/work-items/${metadata.scope.work_item_id}/${metadata.artifact_id}/metadata.json`
      : `artifacts/workflows/${metadata.scope.workflow_instance_id}/${metadata.scope.turn_id}/${metadata.artifact_id}/metadata.json`;
  }

  private materializeStagedArtifacts(input: {
    readonly artifactIds: readonly string[];
    readonly group: CollaborationProjectSpaceGroupRecord;
    readonly scopeType: CollaborationStagedArtifactV3['scopeType'];
    readonly scopeId: string;
    readonly turnId?: string;
    readonly attempt?: number;
    readonly fencingToken?: string;
    readonly executorId: string | null;
  }): {
    readonly metadata: ArtifactMetadataV3[];
    readonly artifactRefs: string[];
    readonly files: Array<{ readonly path: string; readonly contents: Buffer }>;
  } {
    if (input.artifactIds.length > 20)
      throw new Error('A command can materialize at most 20 Artifacts');
    if (new Set(input.artifactIds).size !== input.artifactIds.length)
      throw new Error('Staged Artifact ids must be unique');
    const metadata: ArtifactMetadataV3[] = [];
    const artifactRefs: string[] = [];
    const files: Array<{ readonly path: string; readonly contents: Buffer }> =
      [];
    for (const artifactId of input.artifactIds) {
      const staged = this.store.readStagedArtifact(artifactId, this.now());
      const artifact = staged.artifact;
      if (
        artifact.groupId !== input.group.groupId ||
        artifact.scopeType !== input.scopeType ||
        artifact.scopeId !== input.scopeId ||
        artifact.principalId !== input.group.localPrincipalId ||
        artifact.clientId !== input.group.localClientId ||
        (input.scopeType === 'workflow_turn' &&
          (artifact.turnId !== input.turnId ||
            artifact.attempt !== input.attempt ||
            artifact.fencingToken !== input.fencingToken))
      )
        throw new Error(
          `Staged Artifact does not match the command scope or claimant: ${artifactId}`,
        );
      const parsed = this.artifactMetadata(artifact, input.executorId);
      const directory = this.artifactRef(parsed).replace(
        /\/metadata\.json$/u,
        '',
      );
      metadata.push(parsed);
      artifactRefs.push(`${directory}/metadata.json`);
      files.push({
        path: `${directory}/${parsed.content_ref}`,
        contents: staged.contents,
      });
    }
    return { metadata, artifactRefs, files };
  }

  private fileMetadata(input: {
    readonly fileId: string;
    readonly principalId: string;
    readonly clientId: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly contents?: Buffer | null;
    readonly externalLocator?: {
      readonly type: 'https' | 'object_store';
      readonly locator: string;
    } | null;
    readonly externalSize?: number;
    readonly externalSha256?: string;
    readonly workItemRefs?: readonly string[];
    readonly workflowInstanceRefs?: readonly string[];
    readonly discussionRefs?: readonly string[];
    readonly executorId?: string | null;
    readonly origin?: 'human' | 'agent' | 'workflow';
    readonly revision: number;
  }): FileMetadata {
    const fileName = collaborationBasenameSchema.parse(input.fileName);
    const contents = input.contents ?? null;
    if ((contents === null) === (input.externalLocator == null))
      throw new Error(
        'Provide either business file bytes or an external locator',
      );
    if (contents && contents.byteLength > MAX_PROJECT_SPACE_FILE_BYTES)
      throw new Error('Project space file exceeds the 10 MiB local Git limit');
    if (
      contents === null &&
      (!Number.isSafeInteger(input.externalSize) ||
        input.externalSize! < 0 ||
        !input.externalSha256)
    )
      throw new Error('External files require their verified size and sha256');
    const sha256 = contents
      ? `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`
      : input.externalSha256!;
    return {
      format: 'icarus.collaboration-file-metadata/1',
      file_id: input.fileId,
      original_filename: fileName,
      content_ref: contents ? fileName : null,
      external_locator: input.externalLocator ?? null,
      media_type: input.mediaType,
      size: contents?.byteLength ?? input.externalSize!,
      sha256,
      uploader_principal_id: input.principalId,
      uploader_client_id: input.clientId,
      executor_id: input.executorId ?? null,
      origin: input.origin ?? 'human',
      refs: {
        work_item_refs: [...(input.workItemRefs ?? [])],
        workflow_instance_refs: [...(input.workflowInstanceRefs ?? [])],
        discussion_refs: [...(input.discussionRefs ?? [])],
      },
      created_at: new Date(this.now()).toISOString(),
      revision: input.revision,
    };
  }
}
