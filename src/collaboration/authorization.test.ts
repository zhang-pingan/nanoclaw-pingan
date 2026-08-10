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
        grants: ['discussion:post'],
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
  });

  it('projects direct grants and intrinsic Owner authority from one evaluator', () => {
    const value = projection();
    const direct = actions(value, memberId);
    expect(direct.group.createDiscussion.allowed).toBe(false);
    expect(direct.group.managePermissions.allowed).toBe(false);
    expect(direct.principal.directPermissions).toEqual(['discussion:post']);

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
      assignee.workflowInstances.instance_delivery.configureCurrentState
        .allowed,
    ).toBe(true);
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
    expect(
      actions(value, contributorId).workflowInstances.instance_delivery
        .createTurn.code,
    ).toBe('RESOURCE_STATE_BLOCKED');
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
});
