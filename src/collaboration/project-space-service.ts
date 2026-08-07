import crypto from 'node:crypto';
import path from 'node:path';

import {
  CollaborationProjectSpaceIdentityService,
  type CollaborationPrincipalIdentity,
} from './project-space-identity.js';
import {
  CollaborationProjectSpaceStore,
  type CollaborationProjectSpaceEventRecord,
  type CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import {
  buildCollaborationEventV3,
  reduceCollaborationEventV3,
  type CollaborationProjectionV3,
} from './protocol/v3-reducer.js';
import { COLLABORATION_CONTROL_BRANCH } from './protocol/version.js';
import {
  actionDefinitionV3Schema,
  collaborationBasenameSchema,
  memberDefinitionV3Schema,
  permissionGrantSchema,
  type CollaborationAggregateType,
  type CollaborationEventTypeV3,
  type CollaborationEventV3,
  type CollaborationPermission,
  type FileMetadata,
  type MemberDefinitionV3,
  type ObserverSubscription,
} from './protocol/v3-schema.js';

export interface ValidatedProjectSpaceHistory {
  readonly head: string;
  readonly projection: CollaborationProjectionV3;
  readonly eventRecords: readonly CollaborationProjectSpaceEventRecord[];
}

export interface CollaborationProjectSpaceTransport {
  inspect(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly previousHead?: string | null;
  }): Promise<ValidatedProjectSpaceHistory>;
  create(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly identity: CollaborationPrincipalIdentity;
    readonly genesisEvent: CollaborationEventV3;
    readonly genesisProjection: CollaborationProjectionV3;
  }): Promise<ValidatedProjectSpaceHistory>;
  append(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly previousHead: string | null;
    readonly identity: CollaborationPrincipalIdentity;
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
  readonly signingKeyPath: string;
  readonly displayName: string;
  readonly clientDisplayName: string;
  readonly membershipPolicy: 'open' | 'approval' | 'invite_only';
  readonly observerAccess: 'allowed' | 'members_only';
  readonly groupId?: string;
  readonly pollIntervalMs?: number;
}

export interface JoinProjectSpaceGroupInput {
  readonly remoteUrl: string;
  readonly signingKeyPath: string;
  readonly displayName: string;
  readonly clientDisplayName: string;
  readonly pollIntervalMs?: number;
}

export const MAX_PROJECT_SPACE_FILE_BYTES = 10 * 1024 * 1024;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function collaborationProjectSpaceRepositoryPath(
  repositoryRoot: string,
  remoteUrl: string,
): string {
  const digest = crypto.createHash('sha256').update(remoteUrl).digest('hex');
  return path.join(repositoryRoot, `${digest}.git`);
}

export class CollaborationProjectSpaceService {
  private readonly histories = new Map<string, ValidatedProjectSpaceHistory>();

  constructor(
    readonly store: CollaborationProjectSpaceStore,
    readonly transport: CollaborationProjectSpaceTransport,
    private readonly repositoryRoot: string,
    private readonly identities: CollaborationProjectSpaceIdentityService,
    private readonly now: () => number = Date.now,
  ) {}

  async inspectRemote(remoteUrl: string): Promise<ProjectSpaceInspectResult> {
    const repositoryPath = collaborationProjectSpaceRepositoryPath(
      this.repositoryRoot,
      remoteUrl,
    );
    const history = await this.transport.inspect({ remoteUrl, repositoryPath });
    return this.inspectResult(history, repositoryPath);
  }

  async createGroup(
    input: CreateProjectSpaceGroupInput,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const identity = await this.identities.resolveSigningIdentity(
      input.signingKeyPath,
    );
    const groupId = input.groupId ?? newId('group');
    const eventId = newId('evt');
    const occurredAt = new Date(this.now()).toISOString();
    const member: MemberDefinitionV3 = memberDefinitionV3Schema.parse({
      format: 'icarus.collaboration-member/3',
      principal_id: identity.principalId,
      display_name: input.displayName,
      signing_key_ref: identity.keyRef,
      signing_public_key: identity.publicKey,
      status: 'active',
      joined_at_event: eventId,
    });
    const client = {
      format: 'icarus.collaboration-client/1' as const,
      principal_id: identity.principalId,
      client_id: identity.clientId,
      display_name: input.clientDisplayName,
      capabilities: [],
      status: 'active' as const,
      registered_at_event: eventId,
    };
    const ownerPermissions = permissionGrantSchema.parse({
      format: 'icarus.collaboration-permission-grant/1',
      principal_id: identity.principalId,
      grants: [],
      revision: 1,
      updated_at_event: eventId,
    });
    const payload = {
      group: {
        format: 'icarus.collaboration-group/3' as const,
        protocol_version: 3 as const,
        group_id: groupId,
        name: input.name,
        creator: {
          principal_id: identity.principalId,
          signing_key_ref: identity.keyRef,
        },
        owner_principal_id: identity.principalId,
        control_branch: COLLABORATION_CONTROL_BRANCH,
        lifecycle: 'active' as const,
        membership_policy: { join: input.membershipPolicy },
        visibility_policy: { observer_access: input.observerAccess },
        created_at: occurredAt,
        archived_at: null,
      },
      member,
      client,
      owner_permissions: ownerPermissions,
    };
    const event = buildCollaborationEventV3({
      groupId,
      eventId,
      aggregateType: 'group',
      aggregateId: groupId,
      aggregateRevision: 1,
      previousEventHash: null,
      eventType: 'group_initialized',
      actor: {
        principal_id: identity.principalId,
        client_id: identity.clientId,
        executor_id: null,
      },
      occurredAt,
      payload,
    });
    const projection = reduceCollaborationEventV3(null, event);
    const repositoryPath = collaborationProjectSpaceRepositoryPath(
      this.repositoryRoot,
      input.remoteUrl,
    );
    const history = await this.transport.create({
      remoteUrl: input.remoteUrl,
      repositoryPath,
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
      pollIntervalMs: input.pollIntervalMs,
    });
    return this.store.getGroup(groupId)!;
  }

  async observeGroup(input: {
    readonly remoteUrl: string;
    readonly pollIntervalMs?: number;
    readonly notificationsEnabled?: boolean;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const repositoryPath = collaborationProjectSpaceRepositoryPath(
      this.repositoryRoot,
      input.remoteUrl,
    );
    const history = await this.transport.inspect({
      remoteUrl: input.remoteUrl,
      repositoryPath,
    });
    if (
      history.projection.group.visibility_policy.observer_access !== 'allowed'
    )
      throw new Error(
        'Group requires Git members-only read access; Observer subscription is disabled',
      );
    this.registerLocalGroup({
      history,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      mode: 'observer',
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
    const [identity, inspected] = await Promise.all([
      this.identities.resolveSigningIdentity(input.signingKeyPath),
      this.transport.inspect({ remoteUrl: input.remoteUrl, repositoryPath }),
    ]);
    if (
      inspected.projection.members[identity.principalId]?.status === 'active'
    ) {
      const registered = await this.appendWithIdentity({
        history: inspected,
        remoteUrl: input.remoteUrl,
        repositoryPath,
        identity,
        aggregateType: 'membership',
        aggregateId: identity.principalId,
        eventType: 'client_registered',
        payload: {
          client: {
            format: 'icarus.collaboration-client/1',
            principal_id: identity.principalId,
            client_id: identity.clientId,
            display_name: input.clientDisplayName,
            capabilities: [],
            status: 'active',
            registered_at_event: '__EVENT_ID__',
          },
        },
        replaceEventId: true,
      });
      this.registerOrUpgradeMember({
        history: registered,
        remoteUrl: input.remoteUrl,
        repositoryPath,
        identity,
        pollIntervalMs: input.pollIntervalMs,
      });
      return this.store.getGroup(registered.projection.groupId)!;
    }

    const open = inspected.projection.group.membership_policy.join === 'open';
    const memberEventType = open ? 'member_registered' : 'membership_requested';
    const joinedAtEvent = open ? '__EVENT_ID__' : null;
    let history = await this.appendWithIdentity({
      history: inspected,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      identity,
      aggregateType: 'membership',
      aggregateId: identity.principalId,
      eventType: memberEventType,
      payload: {
        member: {
          format: 'icarus.collaboration-member/3',
          principal_id: identity.principalId,
          display_name: input.displayName,
          signing_key_ref: identity.keyRef,
          signing_public_key: identity.publicKey,
          status: open ? 'active' : 'requested',
          joined_at_event: joinedAtEvent,
        },
      },
      replaceEventId: open,
    });
    if (open)
      history = await this.appendWithIdentity({
        history,
        remoteUrl: input.remoteUrl,
        repositoryPath,
        identity,
        aggregateType: 'membership',
        aggregateId: identity.principalId,
        eventType: 'client_registered',
        payload: {
          client: {
            format: 'icarus.collaboration-client/1',
            principal_id: identity.principalId,
            client_id: identity.clientId,
            display_name: input.clientDisplayName,
            capabilities: [],
            status: 'active',
            registered_at_event: '__EVENT_ID__',
          },
        },
        replaceEventId: true,
      });
    this.registerOrUpgradeMember({
      history,
      remoteUrl: input.remoteUrl,
      repositoryPath,
      identity,
      pollIntervalMs: input.pollIntervalMs,
    });
    return this.store.getGroup(history.projection.groupId)!;
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

  async postProgress(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
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
          update_id: newId('update'),
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

  async readVerifiedFile(input: {
    readonly groupId: string;
    readonly repositoryFile: string;
  }): Promise<Buffer> {
    const group = this.store.getGroup(input.groupId);
    if (!group?.lastVerifiedHead)
      throw new Error('Group has no verified snapshot');
    return this.transport.readVerifiedFile({
      repositoryPath: group.repositoryPath,
      verifiedHead: group.lastVerifiedHead,
      repositoryFile: input.repositoryFile,
    });
  }

  async sync(groupId: string): Promise<ValidatedProjectSpaceHistory> {
    const group = this.store.getGroup(groupId);
    if (!group) throw new Error(`Collaboration Group not found: ${groupId}`);
    try {
      const history = await this.transport.inspect({
        remoteUrl: group.remoteUrl,
        repositoryPath: group.repositoryPath,
        previousHead: group.lastVerifiedHead,
      });
      this.saveHistory(groupId, history);
      return history;
    } catch (error) {
      this.store.recordIntegrityIncident({
        groupId,
        code: 'SYNC_VALIDATION_FAILED',
        message: error instanceof Error ? error.message : String(error),
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

  private registerLocalGroup(input: {
    readonly history: ValidatedProjectSpaceHistory;
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly mode: 'observer' | 'member';
    readonly identity?: CollaborationPrincipalIdentity;
    readonly pollIntervalMs?: number;
    readonly notificationsEnabled?: boolean;
  }): void {
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
      localPrincipalId: input.identity?.principalId ?? null,
      localClientId: input.identity?.clientId ?? null,
      signingKeyPath: input.identity?.privateKeyPath ?? null,
      signingPublicKey: input.identity?.publicKey ?? null,
      signingKeyRef: input.identity?.keyRef ?? null,
      nowMs: this.now(),
    });
    this.saveHistory(input.history.projection.groupId, input.history);
  }

  private registerOrUpgradeMember(input: {
    readonly history: ValidatedProjectSpaceHistory;
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly identity: CollaborationPrincipalIdentity;
    readonly pollIntervalMs?: number;
  }): void {
    const existing = this.store.getGroup(input.history.projection.groupId);
    if (existing?.subscriptionMode === 'observer') {
      this.store.updateSubscriptionMode({
        groupId: input.history.projection.groupId,
        localPrincipalId: input.identity.principalId,
        localClientId: input.identity.clientId,
        signingKeyPath: input.identity.privateKeyPath,
        signingPublicKey: input.identity.publicKey,
        signingKeyRef: input.identity.keyRef,
      });
      this.saveHistory(input.history.projection.groupId, input.history);
      return;
    }
    if (existing)
      throw new Error('Group is already registered as a Member on this Client');
    this.registerLocalGroup({
      ...input,
      mode: 'member',
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
      readonly executorId?: string | null;
      readonly materializedFiles?: readonly {
        readonly path: string;
        readonly contents: string | Buffer | null;
      }[];
    },
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.store.getGroup(groupId);
    if (
      !group ||
      group.subscriptionMode !== 'member' ||
      !group.localPrincipalId ||
      !group.localClientId ||
      !group.signingKeyPath ||
      !group.signingPublicKey ||
      !group.signingKeyRef
    )
      throw new Error(
        'Observer subscriptions cannot issue collaboration commands',
      );
    const history = await this.sync(groupId);
    const head =
      history.projection.aggregateHeads[
        `${input.aggregateType}:${input.aggregateId}`
      ];
    if ((head?.revision ?? 0) !== input.expectedRevision)
      throw new Error(
        `Aggregate revision conflict: expected ${String(input.expectedRevision)}, current ${String(head?.revision ?? 0)}`,
      );
    const identity: CollaborationPrincipalIdentity = {
      principalId: group.localPrincipalId,
      clientId: group.localClientId,
      privateKeyPath: group.signingKeyPath,
      publicKey: group.signingPublicKey,
      keyRef: group.signingKeyRef,
    };
    const updated = await this.appendWithIdentity({
      history,
      remoteUrl: group.remoteUrl,
      repositoryPath: group.repositoryPath,
      identity,
      ...input,
    });
    this.saveHistory(groupId, updated);
    return this.store.getGroup(groupId)!;
  }

  private async appendWithIdentity(input: {
    readonly history: ValidatedProjectSpaceHistory;
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly identity: CollaborationPrincipalIdentity;
    readonly aggregateType: CollaborationAggregateType;
    readonly aggregateId: string;
    readonly eventType: CollaborationEventTypeV3;
    readonly payload: Record<string, unknown>;
    readonly replaceEventId?: boolean;
    readonly eventId?: string;
    readonly executorId?: string | null;
    readonly materializedFiles?: readonly {
      readonly path: string;
      readonly contents: string | Buffer | null;
    }[];
  }): Promise<ValidatedProjectSpaceHistory> {
    return this.transport.append({
      remoteUrl: input.remoteUrl,
      repositoryPath: input.repositoryPath,
      previousHead: input.history.head,
      identity: input.identity,
      buildEvent: (history) => {
        const head =
          history.projection.aggregateHeads[
            `${input.aggregateType}:${input.aggregateId}`
          ];
        const eventId = input.eventId ?? newId('evt');
        const payload = input.replaceEventId
          ? (JSON.parse(
              JSON.stringify(input.payload).replaceAll('__EVENT_ID__', eventId),
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
            executor_id: input.executorId ?? null,
          },
          occurredAt: new Date(this.now()).toISOString(),
          payload,
        });
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
    this.histories.set(groupId, history);
    this.store.saveVerifiedProjection({
      groupId,
      verifiedHead: history.head,
      projection: history.projection,
      eventRecords: history.eventRecords,
      nowMs: this.now(),
    });
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
