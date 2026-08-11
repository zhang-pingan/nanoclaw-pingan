import { describe, expect, it } from 'vitest';

import {
  COLLABORATION_PERMISSION_TEMPLATES,
  DEFAULT_COLLABORATION_PERMISSION_TEMPLATE_ID,
  collaborationPermissionTemplate,
} from './permissions.js';
import { projectCollaborationAllowedActionsV3 } from './authorization.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';

const ownerId = 'principal_00000000-0000-4000-8000-000000000001';
const memberId = 'principal_00000000-0000-4000-8000-000000000002';
const contributorId = 'principal_00000000-0000-4000-8000-000000000003';

function projection(): CollaborationProjectionV3 {
  const member = (principalId: string, status = 'active') => ({
    format: 'icarus.collaboration-member/3' as const,
    principal_id: principalId,
    display_name: principalId,
    status: status as 'active',
    joined_at_event: 'evt_join',
  });
  const client = (principalId: string) => ({
    format: 'icarus.collaboration-client/1' as const,
    principal_id: principalId,
    client_id: `client_${principalId.slice(-4)}`,
    display_name: 'Client',
    capabilities: [],
    status: 'active' as const,
    registered_at_event: 'evt_join',
  });
  const credential = (principalId: string) => ({
    format: 'icarus.collaboration-credential/1' as const,
    credential_id: `credential_${principalId.slice(-4)}`,
    principal_id: principalId,
    client_id: `client_${principalId.slice(-4)}`,
    public_key:
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQ0h6jJj7fSxuv0PQGzvL6wXhJv0D7RQnC0XcKZi7JY test',
    fingerprint: 'SHA256:fixture',
    purpose: 'event_signing' as const,
    status: 'active' as const,
    created_at_event: 'evt_join',
    revoked_at_event: null,
  });
  return {
    format: 'icarus.collaboration-projection/3',
    protocolVersion: 3,
    groupId: 'group_test',
    group: {
      format: 'icarus.collaboration-group/3',
      protocol_version: 3,
      group_id: 'group_test',
      name: 'Test',
      creator: { principal_id: ownerId },
      owner_principal_id: ownerId,
      control_branch: 'refs/heads/icarus/control',
      lifecycle: 'active',
      membership_policy: { join: 'approval' },
      visibility_policy: { observer_access: 'allowed' },
      default_permission_template_id:
        DEFAULT_COLLABORATION_PERMISSION_TEMPLATE_ID,
      created_at: '2026-08-10T00:00:00.000Z',
      archived_at: null,
      dissolved_at: null,
    },
    aggregateHeads: {},
    invites: {},
    members: {
      [ownerId]: member(ownerId),
      [memberId]: member(memberId),
      [contributorId]: member(contributorId),
    },
    clients: {
      [ownerId]: { client_0001: client(ownerId) },
      [memberId]: { client_0002: client(memberId) },
      [contributorId]: { client_0003: client(contributorId) },
    },
    credentials: {
      [ownerId]: { credential_0001: credential(ownerId) },
      [memberId]: { credential_0002: credential(memberId) },
      [contributorId]: { credential_0003: credential(contributorId) },
    },
    recoveryRequests: {},
    executors: {},
    permissionGrants: {
      [memberId]: {
        format: 'icarus.collaboration-permission-grant/1',
        principal_id: memberId,
        grants: ['discussion:post', 'work_item:manage_owned'],
        revision: 1,
        updated_at_event: 'evt_permission',
      },
    },
    progressUpdates: {},
    files: {},
    artifacts: {},
    fileLocations: {},
    actions: {},
    workItems: {
      work_owner: {
        format: 'icarus.collaboration-work-item/1',
        work_item_id: 'work_owner',
        type: 'task',
        title: 'Owned',
        description: '',
        status: 'open',
        priority: 'normal',
        creator_principal_id: ownerId,
        owner_principal_id: memberId,
        preferred_executor_id: null,
        contributors: [contributorId],
        watchers: [],
        acceptance_criteria: [],
        labels: [],
        due_at: null,
        parent_id: null,
        blocked_by: [],
        related_items: [],
        primary_workflow_instance_id: null,
        assignment_status: 'accepted',
        created_at: '2026-08-10T00:00:00.000Z',
        updated_at: '2026-08-10T00:00:00.000Z',
        closed_at: null,
        revision: 1,
        archived: false,
      },
    },
    workItemUpdates: {},
    discussions: {},
    workflowDefinitions: {},
    latestWorkflowDefinitionVersions: {},
    workflowInstances: {},
    stateExecutions: {},
    turns: {},
    timeoutObservations: {},
    seenEventIds: [],
    activity: [],
    integrityStatus: 'OK',
    integrityMessage: null,
  };
}

function actions(
  value: CollaborationProjectionV3,
  principalId: string | null,
  mode: 'observer' | 'member' = 'member',
) {
  const suffix = principalId?.slice(-4) ?? '';
  return projectCollaborationAllowedActionsV3({
    projection: value,
    subscriptionMode: mode,
    principalId,
    clientId: principalId ? `client_${suffix}` : null,
    credentialId: principalId ? `credential_${suffix}` : null,
  });
}

describe('collaboration authorization projection', () => {
  it('keeps template ids stable and ordinary defaults least-privileged', () => {
    expect(collaborationPermissionTemplate('member.v1')?.nameZh).toBe(
      '基础成员',
    );
    expect(collaborationPermissionTemplate('unknown')).toBeNull();
    expect(
      COLLABORATION_PERMISSION_TEMPLATES.find(
        (entry) => entry.id === DEFAULT_COLLABORATION_PERMISSION_TEMPLATE_ID,
      )?.permissions,
    ).not.toContain('group:admin');
  });

  it('separates group creation permission from work-item resource authority', () => {
    const value = projection();
    const member = actions(value, memberId);
    expect(member.group.createWorkItem.allowed).toBe(false);
    expect(member.workItems.work_owner.manage.allowed).toBe(true);
    expect(member.workItems.work_owner.postProgress.allowed).toBe(true);

    const contributor = actions(value, contributorId);
    expect(contributor.workItems.work_owner.manage.allowed).toBe(false);
    expect(contributor.workItems.work_owner.postProgress.allowed).toBe(true);
  });

  it('fails closed for observers, inactive credentials, and archived groups', () => {
    const value = projection();
    const observer = actions(value, null, 'observer');
    expect(observer.group.createDiscussion).toMatchObject({
      allowed: false,
      code: 'OBSERVER_READ_ONLY',
    });
    expect(observer.group.requestJoin.allowed).toBe(true);
    expect(observer.group.requestRecovery.allowed).toBe(true);
    value.credentials[memberId]!.credential_0002!.status = 'revoked';
    expect(actions(value, memberId).group.createDiscussion.code).toBe(
      'CREDENTIAL_INACTIVE',
    );
    value.credentials[memberId]!.credential_0002!.status = 'active';
    value.group.lifecycle = 'archived';
    expect(actions(value, memberId).group.createDiscussion.code).toBe(
      'GROUP_ARCHIVED',
    );
    expect(actions(value, memberId).group.reopen).toMatchObject({
      allowed: false,
      code: 'PERMISSION_REQUIRED',
    });
    expect(actions(value, ownerId).group.reopen.allowed).toBe(true);
    value.credentials[ownerId]!.credential_0001!.status = 'revoked';
    expect(actions(value, ownerId).group.reopen.code).toBe(
      'CREDENTIAL_INACTIVE',
    );
  });

  it('projects direct grants and intrinsic Owner authority from one evaluator', () => {
    const value = projection();
    const direct = actions(value, memberId);
    expect(direct.group.createDiscussion.allowed).toBe(false);
    expect(direct.group.managePermissions.allowed).toBe(false);
    expect(direct.principal.directPermissions).toEqual([
      'discussion:post',
      'work_item:manage_owned',
    ]);

    const owner = actions(value, ownerId);
    expect(owner.group.managePermissions.allowed).toBe(true);
    expect(owner.group.archive.allowed).toBe(true);
    expect(owner.principal.isOwner).toBe(true);
  });

  it('projects current Workflow assignee and per-scope launch authority', () => {
    const value = projection();
    value.workflowDefinitions['delivery@1'] = {
      definition: {
        definition_id: 'delivery',
        version: 1,
        status: 'published',
        created_by_principal_id: ownerId,
        launch_policy: {
          group_admin: false,
          work_item_owner: true,
          principals: [],
        },
      },
      machine: { states: { build: { terminal: false } } },
    } as unknown as CollaborationProjectionV3['workflowDefinitions'][string];
    value.workflowInstances.instance_delivery = {
      instance_id: 'instance_delivery',
      definition_id: 'delivery',
      definition_version: 1,
      scope: { type: 'group' },
      created_by_principal_id: ownerId,
      business_state: 'build',
      resolved_assignments: { build: contributorId },
      lifecycle: 'draft',
      active_turn_id: null,
    } as unknown as CollaborationProjectionV3['workflowInstances'][string];

    const assignee = actions(value, contributorId);
    expect(assignee.workflowInstances.instance_delivery.manage.allowed).toBe(
      true,
    );
    expect(assignee.workflowInstances.instance_delivery.start).toMatchObject({
      allowed: false,
      code: 'RESOURCE_STATE_BLOCKED',
    });
    expect(
      assignee.workflowInstances.instance_delivery.createTurn,
    ).toMatchObject({ allowed: false, code: 'RESOURCE_STATE_BLOCKED' });
    expect(
      assignee.workflowInstances.instance_delivery.configureCurrentState,
    ).toMatchObject({ allowed: false, code: 'RESOURCE_STATE_BLOCKED' });
    expect(
      assignee.workflowDefinitions['delivery@1']!.createGroupInstance.allowed,
    ).toBe(false);

    const itemOwner = actions(value, memberId);
    expect(
      itemOwner.workflowDefinitions['delivery@1']!.createWorkItemInstances
        .work_owner?.allowed,
    ).toBe(true);
    expect(
      itemOwner.workflowDefinitions['delivery@1']!.createGroupInstance.allowed,
    ).toBe(false);
    expect(itemOwner.group.createWorkflowInstance.allowed).toBe(true);

    value.workflowInstances.instance_delivery!.lifecycle = 'ready';
    expect(
      actions(value, ownerId).workflowInstances.instance_delivery.start.allowed,
    ).toBe(true);
    value.workflowInstances.instance_delivery!.lifecycle = 'running';
    const running = actions(value, contributorId).workflowInstances
      .instance_delivery;
    expect(running.start.code).toBe('RESOURCE_STATE_BLOCKED');
    expect(running.pause.allowed).toBe(true);
    expect(running.resume.code).toBe('RESOURCE_STATE_BLOCKED');
    expect(running.close.allowed).toBe(true);
    expect(running.createTurn.allowed).toBe(true);
    value.workflowInstances.instance_delivery!.active_turn_id = 'turn_active';
    value.turns.turn_active = {
      turn_id: 'turn_active',
      workflow_instance_id: 'instance_delivery',
      state_id: 'build',
      assignee_principal_id: contributorId,
      claimant_principal_id: null,
      claimant_client_id: null,
      fencing_token: null,
      attempt: 1,
      state: 'pending',
    } as unknown as CollaborationProjectionV3['turns'][string];
    const activeTurn = actions(value, contributorId).workflowInstances
      .instance_delivery;
    expect(activeTurn.createTurn.code).toBe('RESOURCE_STATE_BLOCKED');
    expect(activeTurn.close.code).toBe('RESOURCE_STATE_BLOCKED');
    expect(activeTurn.reassignStates.build).toMatchObject({
      allowed: false,
      code: 'RESOURCE_STATE_BLOCKED',
    });
    expect(activeTurn.turns.turn_active?.cancel.allowed).toBe(false);
    expect(
      actions(value, ownerId).workflowInstances.instance_delivery.turns
        .turn_active?.cancel.allowed,
    ).toBe(true);
    value.turns.turn_active!.fencing_token = `sha256:${'f'.repeat(64)}`;
    value.turns.turn_active!.claimant_principal_id = contributorId;
    value.turns.turn_active!.claimant_client_id = 'client_0003';
    expect(
      actions(value, contributorId).workflowInstances.instance_delivery.turns
        .turn_active?.cancel.allowed,
    ).toBe(true);
  });

  it('removes author and Definition creator actions when direct permissions are revoked', () => {
    const value = projection();
    value.discussions.thread_1 = {
      discussion: {
        thread_id: 'thread_1',
        created_by: memberId,
        status: 'open',
      },
      messages: {
        message_1: {
          message_id: 'message_1',
          author_principal_id: memberId,
          tombstoned: false,
        },
      },
    } as unknown as CollaborationProjectionV3['discussions'][string];
    expect(
      actions(value, memberId).discussions.thread_1.messages.message_1?.revise
        .allowed,
    ).toBe(true);
    value.permissionGrants[memberId]!.grants = [];
    expect(
      actions(value, memberId).discussions.thread_1.messages.message_1?.revise,
    ).toMatchObject({ allowed: false, code: 'PERMISSION_REQUIRED' });

    value.workflowDefinitions['member-flow@1'] = {
      definition: {
        definition_id: 'member-flow',
        version: 1,
        status: 'proposed',
        created_by_principal_id: memberId,
        launch_policy: {
          group_admin: false,
          work_item_owner: false,
          principals: [],
        },
      },
      machine: { states: {} },
    } as unknown as CollaborationProjectionV3['workflowDefinitions'][string];
    value.latestWorkflowDefinitionVersions['member-flow'] = 1;
    expect(
      actions(value, memberId).workflowDefinitions['member-flow@1']!
        .editDefinition,
    ).toMatchObject({ allowed: false, code: 'PERMISSION_REQUIRED' });
    value.permissionGrants[memberId]!.grants = ['workflow_definition:propose'];
    expect(
      actions(value, memberId).workflowDefinitions['member-flow@1']!
        .editDefinition.allowed,
    ).toBe(true);
    value.workflowDefinitions['member-flow@1']!.definition.status = 'published';
    value.permissionGrants[memberId]!.grants = [];
    expect(
      actions(value, memberId).workflowDefinitions['member-flow@1']!
        .createVersion,
    ).toMatchObject({ allowed: false, code: 'PERMISSION_REQUIRED' });
  });

  it('projects exact Work Item and Discussion resource actions', () => {
    const value = projection();
    const owned = actions(value, memberId).workItems.work_owner;
    expect(owned.editDetails.allowed).toBe(true);
    expect(owned.changeAssignment.allowed).toBe(true);
    expect(owned.changeRelations.allowed).toBe(true);
    expect(owned.archive.allowed).toBe(true);
    expect(owned.changeStatus.in_progress.allowed).toBe(true);
    expect(owned.changeStatus.done.code).toBe('RESOURCE_STATE_BLOCKED');

    value.discussions.thread_1 = {
      discussion: {
        thread_id: 'thread_1',
        created_by: memberId,
        status: 'open',
      },
      messages: {
        message_1: {
          message_id: 'message_1',
          author_principal_id: memberId,
          tombstoned: false,
        },
      },
    } as unknown as CollaborationProjectionV3['discussions'][string];
    const open = actions(value, memberId).discussions.thread_1;
    expect(open.resolve.allowed).toBe(true);
    expect(open.reopen.code).toBe('RESOURCE_STATE_BLOCKED');
    expect(open.messages.message_1?.revise.allowed).toBe(true);
    expect(open.messages.message_1?.tombstone.allowed).toBe(true);
    value.discussions.thread_1!.discussion.status = 'resolved';
    const resolved = actions(value, memberId).discussions.thread_1;
    expect(resolved.resolve.code).toBe('RESOURCE_STATE_BLOCKED');
    expect(resolved.reopen.allowed).toBe(true);
    expect(resolved.messages.message_1?.revise.code).toBe(
      'RESOURCE_STATE_BLOCKED',
    );
  });

  it('requires manage_owned in addition to Work Item ownership', () => {
    const value = projection();
    expect(actions(value, memberId).workItems.work_owner.manage.allowed).toBe(
      true,
    );

    value.permissionGrants[memberId]!.grants = ['discussion:post'];
    const revoked = actions(value, memberId).workItems.work_owner;
    expect(revoked.manage).toMatchObject({
      allowed: false,
      code: 'RESOURCE_AUTHORITY_REQUIRED',
    });
    expect(revoked.editDetails.allowed).toBe(false);
    expect(revoked.changeAssignment.allowed).toBe(false);
    expect(revoked.changeRelations.allowed).toBe(false);
    expect(revoked.archive.allowed).toBe(false);
    expect(actions(value, ownerId).workItems.work_owner.manage.allowed).toBe(
      true,
    );

    value.permissionGrants[contributorId] = {
      format: 'icarus.collaboration-permission-grant/1',
      principal_id: contributorId,
      grants: ['work_item:manage_all'],
      revision: 1,
      updated_at_event: 'evt_contributor_manager',
    };
    expect(
      actions(value, contributorId).workItems.work_owner.manage.allowed,
    ).toBe(true);

    value.permissionGrants[memberId]!.grants.push('work_item:manage_owned');
    expect(actions(value, memberId).workItems.work_owner.manage.allowed).toBe(
      true,
    );
  });

  it('projects revocation only for another owned Client or Credential', () => {
    const value = projection();
    value.clients[memberId]!.client_member_secondary = {
      ...value.clients[memberId]!.client_0002!,
      client_id: 'client_member_secondary',
    };
    value.credentials[memberId]!.credential_member_secondary = {
      ...value.credentials[memberId]!.credential_0002!,
      credential_id: 'credential_member_secondary',
      client_id: 'client_member_secondary',
    };
    const member = actions(value, memberId);
    expect(member.clients.client_0002?.revoke.allowed).toBe(false);
    expect(member.clients.client_member_secondary?.revoke.allowed).toBe(true);
    expect(member.credentials.credential_0002?.revoke.allowed).toBe(false);
    expect(member.credentials.credential_member_secondary?.revoke.allowed).toBe(
      true,
    );
  });

  it('projects Executor, owned Action, and current State Execution decisions exactly', () => {
    const value = projection();
    value.permissionGrants[memberId]!.grants = ['workspace:publish_owned'];
    value.executors[memberId] = {
      executor_member: {
        executor_id: 'executor_member',
        principal_id: memberId,
        status: 'active',
      },
    } as unknown as CollaborationProjectionV3['executors'][string];
    value.actions[`${memberId}:action_member`] = {
      action_id: 'action_member',
      owner_principal_id: memberId,
      name: 'Member action',
      version: 1,
    } as unknown as CollaborationProjectionV3['actions'][string];
    value.workflowInstances.instance_member = {
      instance_id: 'instance_member',
      definition_id: 'delivery',
      definition_version: 1,
      scope: { type: 'group' },
      created_by_principal_id: ownerId,
      business_state: 'build',
      resolved_assignments: { build: memberId },
      lifecycle: 'running',
      active_turn_id: null,
    } as unknown as CollaborationProjectionV3['workflowInstances'][string];
    value.stateExecutions.instance_member = {
      build: { instance_id: 'instance_member', state_id: 'build' },
    } as unknown as CollaborationProjectionV3['stateExecutions'][string];

    const member = actions(value, memberId);
    expect(member.group.registerOwnExecutor.allowed).toBe(true);
    expect(member.group.publishOwnedAction.allowed).toBe(true);
    expect(member.executors.executor_member?.revoke.allowed).toBe(true);
    expect(member.actions[`${memberId}:action_member`]?.revise.allowed).toBe(
      true,
    );
    expect(
      member.workflowInstances.instance_member.withdrawCurrentStateExecution
        .allowed,
    ).toBe(true);

    value.permissionGrants[memberId]!.grants = [];
    expect(actions(value, memberId).group.publishOwnedAction).toMatchObject({
      allowed: false,
      code: 'PERMISSION_REQUIRED',
    });
    expect(
      actions(value, memberId).actions[`${memberId}:action_member`]?.revise,
    ).toMatchObject({ allowed: false, code: 'PERMISSION_REQUIRED' });
    expect(
      actions(value, contributorId).actions[`${memberId}:action_member`]
        ?.revise,
    ).toMatchObject({
      allowed: false,
      code: 'RESOURCE_AUTHORITY_REQUIRED',
    });
    expect(
      actions(value, contributorId).executors.executor_member?.revoke,
    ).toMatchObject({
      allowed: false,
      code: 'RESOURCE_AUTHORITY_REQUIRED',
    });

    delete value.stateExecutions.instance_member!.build;
    expect(
      actions(value, memberId).workflowInstances.instance_member
        .withdrawCurrentStateExecution,
    ).toMatchObject({ allowed: false, code: 'RESOURCE_STATE_BLOCKED' });
    value.workflowInstances.instance_member!.lifecycle = 'closed';
    expect(
      actions(value, memberId).workflowInstances.instance_member
        .configureCurrentState,
    ).toMatchObject({ allowed: false, code: 'RESOURCE_STATE_BLOCKED' });
  });
});
