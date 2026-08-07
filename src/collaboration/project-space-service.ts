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
  collaborationCanonicalHashV3,
  collaborationDeadlineAtV3,
  collaborationDeadlineSnapshotHashV3,
  collaborationFencingTokenV3,
  collaborationIdempotencyKeyV3,
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
  discussionMessageSchema,
  discussionSchema,
  executorDescriptorSchema,
  machineDefinitionV3Schema,
  memberDefinitionV3Schema,
  permissionGrantSchema,
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
  type ArtifactMetadataV3,
  type Discussion,
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

export interface ProjectSpaceStagedArtifactResult {
  readonly metadata: ArtifactMetadataV3;
  readonly artifactRef: string;
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
  private readonly repositoryOperations = new Map<string, Promise<void>>();

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

  async registerCurrentClient(input: {
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly displayName: string;
    readonly capabilities?: readonly string[];
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
    const eventId = newId('evt');
    const client = clientDefinitionSchema.parse({
      format: 'icarus.collaboration-client/1',
      principal_id: group.localPrincipalId,
      client_id: group.localClientId,
      display_name: input.displayName,
      capabilities: [...(input.capabilities ?? [])],
      status: 'active',
      registered_at_event: eventId,
    });
    return this.appendLocal(input.groupId, {
      aggregateType: 'membership',
      aggregateId: group.localPrincipalId!,
      expectedRevision: input.expectedRevision,
      eventType: 'client_registered',
      payload: { client },
      eventId,
    });
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
    const message = discussionMessageSchema.parse({
      format: 'icarus.collaboration-message/1',
      message_id: input.messageId ?? newId('message'),
      thread_id: input.threadId,
      author_principal_id: group.localPrincipalId,
      actor_client_id: group.localClientId,
      executor_id: input.executorId ?? null,
      origin: input.origin ?? 'human',
      body: input.body,
      mentions: [...(input.mentions ?? [])],
      refs: [...(input.refs ?? [])],
      revision: 1,
      tombstoned: false,
      created_at: now,
      updated_at: now,
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
    readonly incomingHandoff?: HandoffEnvelopeV3 | null;
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
    const execution =
      history.projection.stateExecutions[input.instanceId]?.[
        instance.business_state
      ];
    const turnId = input.turnId ?? newId('turn');
    const incomingHandoff = input.incomingHandoff
      ? handoffEnvelopeV3Schema.parse(input.incomingHandoff)
      : null;
    const incomingHandoffHash = incomingHandoff
      ? collaborationCanonicalHashV3(incomingHandoff)
      : null;
    const createdAt = new Date(this.now()).toISOString();
    const timeoutPolicy = state.timeout_policy ?? null;
    const startDeadlineAt = collaborationDeadlineAtV3(
      createdAt,
      timeoutPolicy?.start_timeout_ms,
    );
    const inputHash = collaborationCanonicalHashV3({
      group_id: input.groupId,
      instance_id: input.instanceId,
      epoch: instance.epoch,
      state_id: instance.business_state,
      assignee_principal_id:
        instance.resolved_assignments[instance.business_state],
      execution: execution ?? null,
      incoming_handoff_hash: incomingHandoffHash,
      work_item:
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
          ? { result_hash: input.resultHash }
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
      !['running', 'waiting_input', 'waiting_approval'].includes(turn.state)
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
    const metadata = this.artifactMetadata(artifact, turn.executor_id);
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
    readonly result?: unknown;
    readonly executorId?: string | null;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireLocalMember(input.groupId);
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
        result_hash: collaborationCanonicalHashV3(input.result ?? handoff.data),
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
    readonly attempt: number;
    readonly fencingToken?: string | null;
    readonly reason: string;
  }): Promise<CollaborationProjectSpaceGroupRecord> {
    return this.appendLocal(input.groupId, {
      aggregateType: 'workflow_instance',
      aggregateId: input.instanceId,
      expectedRevision: input.expectedRevision,
      eventType: 'turn_recovery_requested',
      payload: {
        turn_id: input.turnId,
        attempt: input.attempt,
        fencing_token: input.fencingToken ?? null,
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
          : !['running', 'waiting_input', 'waiting_approval'].includes(
              turn.state,
            ) ||
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
      !this.store
        .listEventRecords(input.groupId, 5_000)
        .some((record) => record.commitHash === input.verifiedCommit)
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
      });
      this.saveHistory(groupId, history);
      this.store.finishSyncAttempt({
        id: attemptId,
        groupId,
        outcome: 'succeeded',
        headAfter: history.head,
        nowMs: this.now(),
      });
      return history;
    } catch (error) {
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
    if (!group) throw new Error(`Collaboration Group not found: ${groupId}`);
    return this.withRepositoryOperation(group.repositoryPath, async () => {
      const currentGroup = this.store.getGroup(groupId);
      if (
        !currentGroup ||
        currentGroup.subscriptionMode !== 'member' ||
        !currentGroup.localPrincipalId ||
        !currentGroup.localClientId ||
        !currentGroup.signingKeyPath ||
        !currentGroup.signingPublicKey ||
        !currentGroup.signingKeyRef
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
      const identity: CollaborationPrincipalIdentity = {
        principalId: currentGroup.localPrincipalId,
        clientId: currentGroup.localClientId,
        privateKeyPath: currentGroup.signingKeyPath,
        publicKey: currentGroup.signingPublicKey,
        keyRef: currentGroup.signingKeyRef,
      };
      const updated = await this.appendWithIdentity({
        history,
        remoteUrl: currentGroup.remoteUrl,
        repositoryPath: currentGroup.repositoryPath,
        identity,
        ...input,
      });
      this.saveHistory(groupId, updated);
      return this.store.getGroup(groupId)!;
    });
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
    const group = this.store.getGroup(groupId);
    if (
      group?.subscriptionMode !== 'member' ||
      !group.localPrincipalId ||
      !group.localClientId
    )
      return;
    for (const record of history.eventRecords) {
      if (knownEventIds.has(record.event.event_id)) continue;
      if (
        !['message_posted', 'message_revised'].includes(record.event.event_type)
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
