import { describe, expect, it } from 'vitest';

import {
  collaborationInitializeConfirmation,
  collaborationRoute,
  parseCollaborationRoute,
} from './collaboration-workspace.js';
import {
  collaborationAggregateLabel,
  collaborationEventLabel,
  collaborationLabel,
  collaborationPermissionLabel,
  collaborationStatusLabel,
} from './collaboration-labels.js';
import {
  collaborationArtifactName,
  collaborationAuditEventTimeline,
  collaborationCanApproveMembers,
  collaborationCanAnswerWorkItemAssignment,
  collaborationCanDissolve,
  collaborationCanLeave,
  collaborationCanRemoveLocal,
  collaborationCanRecoverTurn,
  collaborationCanDecideRecovery,
  collaborationCanCreateTurn,
  collaborationCanInitializeGroup,
  collaborationCanMutate,
  collaborationCurrentTurn,
  collaborationDuration,
  collaborationDiscussionMessageActionAccess,
  collaborationDiscussionMessageActionAllowed,
  collaborationEligibleTurnExecutors,
  collaborationIsObserver,
  collaborationLocalMembershipStatus,
  collaborationLocalCredential,
  collaborationOutcomeRoutes,
  collaborationPendingNotifications,
  collaborationNotificationTarget,
  collaborationNotificationScope,
  collaborationResourceTarget,
  collaborationPrincipalName,
  collaborationShortId,
  stageCollaborationArtifactFiles,
  collaborationTurnAccess,
  collaborationTurnDeadline,
  collaborationTurnHistory,
  collaborationWorkflowInstanceCommand,
  collaborationWorkflowStateActionAccess,
  collaborationWorkflowTurnActionAccess,
  collaborationWorkItemStatusActionAccess,
  buildCollaborationStartTurnRequest,
  buildCollaborationRecoverTurnRequest,
  buildCollaborationCompleteTurnRequest,
  buildCollaborationAssignmentDecisionRequest,
  buildCollaborationDiscussionMessageRequest,
  buildCollaborationMemberNotificationRequest,
  buildCollaborationReasonRequest,
  buildCollaborationTurnCancellationRequest,
  buildCollaborationWorkflowReassignmentRequest,
  buildCollaborationWorkItemAssignmentRequest,
  buildCollaborationWorkItemDetailsRequest,
  buildCollaborationWorkItemRelationsRequest,
  buildCollaborationAnalysisRunRequest,
  buildCollaborationExternalResultRequest,
  buildCollaborationFindingDecisionRequest,
  buildCollaborationLifecycleRequest,
  buildCollaborationActionPreviewRequest,
  buildCollaborationActionApplyRequest,
  buildCollaborationActionMutationRequest,
  buildCollaborationExecutorRegistrationRequest,
  buildCollaborationStateExecutionRequest,
  collaborationFindingActionDraft,
  collaborationFindingActionTypes,
  collaborationTurnCompletionDraft,
  collaborationAnalysisRunAccess,
  collaborationActionAccess,
  collaborationActionAllowed,
  collaborationActiveMemberOptions,
  collaborationAvailableLocalExecutors,
  collaborationOwnedActions,
  parseCollaborationExternalResult,
  collaborationVerifiedFileTree,
  collaborationWorkItemColumns,
  collaborationWorkflowLaunchAccess,
} from './collaboration-ui.js';

describe('Collaboration project-space v3 UI helpers', () => {
  it('renders project-space protocol labels in Chinese without changing technical keywords', () => {
    expect(collaborationStatusLabel('in_progress')).toBe('进行中');
    expect(collaborationStatusLabel('PROTOCOL_QUARANTINED')).toBe('协议已隔离');
    expect(collaborationEventLabel('workflow_instance_started')).toBe(
      '工作流实例已启动',
    );
    expect(collaborationAggregateLabel('work_item')).toBe('工作项');
    expect(collaborationPermissionLabel('member:approve')).toBe('审批成员');
    expect(collaborationStatusLabel('awaiting_external_result')).toBe(
      '等待外部结果',
    );
    expect(collaborationLabel('dependency_risk')).toBe('依赖风险');
    expect(collaborationLabel('publish_analysis_report')).toBe(
      '发布 Markdown 报告',
    );
    expect(collaborationLabel('discussion_mention')).toBe('讨论中提及了你');
    expect(collaborationLabel('Git')).toBe('Git');
    expect(collaborationLabel('Codex')).toBe('Codex');
  });

  it('round-trips encoded Project Space routes for cold navigation', () => {
    expect(collaborationRoute('', 'overview')).toBe('/groups');
    expect(collaborationRoute('group:release/one', 'work-items')).toBe(
      '/groups/group%3Arelease%2Fone/work-items',
    );
    expect(
      parseCollaborationRoute('/groups/group%3Arelease%2Fone/work-items'),
    ).toEqual({ groupId: 'group:release/one', tab: 'work-items' });
    expect(collaborationRoute('group_1', 'analysis')).toBe(
      '/groups/group_1/analysis',
    );
    expect(parseCollaborationRoute('/groups/group_1/analysis')).toEqual({
      groupId: 'group_1',
      tab: 'analysis',
    });
  });

  it('makes Observer mode explicit and read only', () => {
    expect(collaborationIsObserver({ subscriptionMode: 'observer' })).toBe(
      true,
    );
    expect(
      collaborationCanMutate({
        subscriptionMode: 'observer',
        lifecycle: 'active',
      }),
    ).toBe(false);
    expect(
      collaborationCanMutate({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_alice',
        localClientId: 'client_a',
        projection: {
          members: { principal_alice: { status: 'active' } },
        },
      }),
    ).toBe(true);
    expect(
      collaborationCanMutate({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_alice',
        localClientId: 'client_a',
        projection: {
          members: { principal_alice: { status: 'requested' } },
        },
      }),
    ).toBe(false);
    expect(
      collaborationCanMutate({
        subscriptionMode: 'member',
        lifecycle: 'dissolved',
        localPrincipalId: 'principal_alice',
        localClientId: 'client_a',
        projection: {
          members: { principal_alice: { status: 'active' } },
        },
      }),
    ).toBe(false);
    expect(
      collaborationLocalMembershipStatus({
        subscriptionMode: 'member',
        localPrincipalId: 'principal_alice',
        projection: {
          members: { principal_alice: { status: 'requested' } },
        },
      }),
    ).toBe('requested');
  });

  it('fails closed when an API capability is missing and keeps legacy fallback isolated', () => {
    const projected = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_a',
      projection: {
        members: { principal_alice: { status: 'active' } },
      },
      allowedActions: { group: {} },
    };
    expect(collaborationActionAccess(projected, 'unprojected')).toMatchObject({
      allowed: false,
      code: 'ACTION_NOT_PROJECTED',
    });
    expect(collaborationActionAllowed(projected, 'unprojected')).toBe(false);
    expect(
      collaborationActionAllowed(
        { ...projected, allowedActions: undefined },
        'legacyAction',
      ),
    ).toBe(true);
  });

  it('reads nested message and status decisions without membership fallback', () => {
    const group = {
      projection: {
        workflowInstances: {
          instance_1: { business_state: 'implementation' },
        },
      },
      allowedActions: {
        group: {
          reopen: { allowed: true, code: 'ALLOWED', reason: null },
        },
        discussions: {
          thread_1: {
            messages: {
              message_1: {
                revise: { allowed: true, code: 'ALLOWED', reason: null },
                tombstone: {
                  allowed: false,
                  code: 'RESOURCE_AUTHORITY_REQUIRED',
                  reason: '仅作者可移除',
                },
              },
            },
          },
        },
        workItems: {
          work_1: {
            changeStatus: {
              in_progress: { allowed: true, code: 'ALLOWED', reason: null },
            },
          },
        },
        workflowDefinitions: {
          'delivery@1': {
            createVersion: { allowed: true, code: 'ALLOWED', reason: null },
            editLayout: { allowed: true, code: 'ALLOWED', reason: null },
            retire: {
              allowed: false,
              code: 'RESOURCE_STATE_BLOCKED',
              reason: '不是最新已发布版本',
            },
          },
        },
        workflowInstances: {
          instance_1: {
            close: { allowed: true, code: 'ALLOWED', reason: null },
            withdrawCurrentStateExecution: {
              allowed: true,
              code: 'ALLOWED',
              reason: null,
            },
            reassignStates: {
              implementation: {
                allowed: false,
                code: 'RESOURCE_STATE_BLOCKED',
                reason: '当前 State 存在活动 Turn',
              },
              review: { allowed: true, code: 'ALLOWED', reason: null },
            },
            turns: {
              turn_1: {
                cancel: { allowed: true, code: 'ALLOWED', reason: null },
              },
            },
          },
        },
      },
    };
    expect(
      collaborationDiscussionMessageActionAllowed(
        group,
        'thread_1',
        'message_1',
        'revise',
      ),
    ).toBe(true);
    expect(collaborationActionAllowed(group, 'reopen')).toBe(true);
    expect(
      collaborationDiscussionMessageActionAccess(
        group,
        'thread_1',
        'message_missing',
        'revise',
      ),
    ).toMatchObject({ allowed: false, code: 'ACTION_NOT_PROJECTED' });
    expect(
      collaborationWorkItemStatusActionAccess(group, 'work_1', 'in_progress')
        .allowed,
    ).toBe(true);
    expect(
      collaborationWorkItemStatusActionAccess(group, 'work_1', 'done'),
    ).toMatchObject({ allowed: false, code: 'ACTION_NOT_PROJECTED' });
    expect(
      collaborationActionAllowed(
        group,
        'createVersion',
        'workflow_definition',
        'delivery@1',
      ),
    ).toBe(true);
    expect(
      collaborationWorkflowStateActionAccess(
        group,
        'instance_1',
        'implementation',
      ),
    ).toMatchObject({ allowed: false, code: 'RESOURCE_STATE_BLOCKED' });
    expect(
      collaborationWorkflowStateActionAccess(group, 'instance_1', 'review')
        .allowed,
    ).toBe(true);
    expect(
      collaborationWorkflowStateActionAccess(
        group,
        'instance_1',
        'implementation',
        'withdrawExecution',
      ).allowed,
    ).toBe(true);
    expect(
      collaborationWorkflowStateActionAccess(
        group,
        'instance_1',
        'review',
        'withdrawExecution',
      ),
    ).toMatchObject({ allowed: false, code: 'ACTION_NOT_PROJECTED' });
    expect(
      collaborationWorkflowTurnActionAccess(
        group,
        'instance_1',
        'turn_1',
        'cancel',
      ).allowed,
    ).toBe(true);
    expect(
      collaborationWorkflowTurnActionAccess(
        group,
        'instance_1',
        'turn_missing',
        'cancel',
      ),
    ).toMatchObject({ allowed: false, code: 'ACTION_NOT_PROJECTED' });
    expect(
      collaborationActionAllowed(
        group,
        'editLayout',
        'workflow_definition',
        'delivery@1',
      ),
    ).toBe(true);
    expect(
      collaborationActionAllowed(
        group,
        'retire',
        'workflow_definition',
        'delivery@1',
      ),
    ).toBe(false);
    expect(
      collaborationActionAllowed(
        group,
        'close',
        'workflow_instance',
        'instance_1',
      ),
    ).toBe(true);
  });

  it('builds business-only Executor, Action, and State execution requests', () => {
    const executor = buildCollaborationExecutorRegistrationRequest({
      expectedRevision: 2,
      displayName: 'Codex Desktop',
      kind: 'codex',
      workspacePath: '/workspace/project',
      filesystemAccess: 'workspace_write',
      approvalPolicy: 'on-request',
      model: 'gpt-5',
      executorId: 'must-not-pass-through',
    });
    expect(executor).toEqual({
      expectedRevision: 2,
      displayName: 'Codex Desktop',
      kind: 'codex',
      workspacePath: '/workspace/project',
      filesystemAccess: 'workspace_write',
      approvalPolicy: 'on-request',
      model: 'gpt-5',
    });
    expect(executor).not.toHaveProperty('executorId');

    const action = buildCollaborationActionMutationRequest({
      expectedRevision: 4,
      name: 'Implement',
      actionType: 'codex',
      prompt: '# Implement\n\nApply the accepted scope.',
      filesystemAccess: 'read_only',
      actionId: 'must-not-pass-through',
      version: 50,
      promptHash: 'must-not-pass-through',
    });
    expect(action).toEqual({
      expectedRevision: 4,
      name: 'Implement',
      actionType: 'codex',
      prompt: '# Implement\n\nApply the accepted scope.',
      filesystemAccess: 'read_only',
      resultFormat: 'collaboration_state_result',
    });
    expect(action).not.toHaveProperty('actionId');
    expect(action).not.toHaveProperty('version');
    expect(action).not.toHaveProperty('promptHash');

    expect(
      buildCollaborationStateExecutionRequest({
        expectedRevision: 7,
        mode: 'automatic',
        actionId: 'action_generated',
        executorId: 'executor_generated',
      }),
    ).toEqual({
      expectedRevision: 7,
      mode: 'automatic',
      actionId: 'action_generated',
      executorId: 'executor_generated',
    });
    expect(
      buildCollaborationStateExecutionRequest({
        expectedRevision: 8,
        mode: 'manual',
        actionId: 'ignored',
        executorId: 'ignored',
      }),
    ).toEqual({
      expectedRevision: 8,
      mode: 'manual',
      actionId: null,
      executorId: null,
    });
  });

  it('filters Action and Executor selectors to the current Principal and local Binding', () => {
    const group = {
      localPrincipalId: 'principal_alice',
      localClientId: 'client_alice',
      projection: {
        actions: {
          'principal_alice:action_codex': {
            action_id: 'action_codex',
            owner_principal_id: 'principal_alice',
            name: 'Codex action',
            kind: 'external',
            adapter: 'codex-task',
          },
          'principal_bob:action_other': {
            action_id: 'action_other',
            owner_principal_id: 'principal_bob',
            name: 'Other action',
            kind: 'run_once',
          },
        },
        executors: {
          principal_alice: {
            executor_codex: { status: 'active' },
            executor_revoked: { status: 'revoked' },
          },
        },
      },
    };
    const owned = collaborationOwnedActions(group);
    expect(owned.map((entry) => entry.action_id)).toEqual(['action_codex']);
    const local = collaborationAvailableLocalExecutors(
      group,
      [
        {
          principalId: 'principal_alice',
          clientId: 'client_alice',
          executorId: 'executor_codex',
          executorKind: 'codex',
          enabled: true,
        },
        {
          principalId: 'principal_alice',
          clientId: 'client_alice',
          executorId: 'executor_revoked',
          executorKind: 'codex',
          enabled: true,
        },
        {
          principalId: 'principal_alice',
          clientId: 'client_other',
          executorId: 'executor_other_client',
          executorKind: 'codex',
          enabled: true,
        },
      ],
      owned[0],
    );
    expect(local.map((entry) => entry.executorId)).toEqual(['executor_codex']);
  });

  it('uses Definition and Work Item launch decisions in the instance wizard', () => {
    const group = {
      allowedActions: {
        group: {
          createWorkflowInstance: { allowed: true, reason: null },
        },
        workflowDefinitions: {
          'delivery@1': {
            createGroupInstance: {
              allowed: false,
              code: 'WORKFLOW_LAUNCH_POLICY_DENIED',
              reason: '群组范围未授权',
            },
            createWorkItemInstances: {
              work_owned: { allowed: true, code: 'ALLOWED', reason: null },
              work_other: {
                allowed: false,
                code: 'WORKFLOW_LAUNCH_POLICY_DENIED',
                reason: '不是工作项负责人',
              },
            },
          },
        },
      },
    };
    expect(
      collaborationWorkflowLaunchAccess(group, 'delivery@1', 'group'),
    ).toMatchObject({ allowed: false, reason: '群组范围未授权' });
    expect(
      collaborationWorkflowLaunchAccess(
        group,
        'delivery@1',
        'work_item',
        'work_owned',
      ).allowed,
    ).toBe(true);
    expect(
      collaborationWorkflowLaunchAccess(
        group,
        'delivery@1',
        'work_item',
        'work_other',
      ),
    ).toMatchObject({ allowed: false, reason: '不是工作项负责人' });
    expect(
      collaborationWorkflowLaunchAccess(group, 'delivery@1', 'work_item', ''),
    ).toMatchObject({ allowed: false, code: 'RESOURCE_REQUIRED' });
  });

  it('shows initialization only to the current Owner with one concise confirmation', () => {
    const owner = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_owner',
      localClientId: 'client_owner',
      ownerPrincipalId: 'principal_owner',
      projection: {
        members: { principal_owner: { status: 'active' } },
      },
    };
    expect(collaborationCanInitializeGroup(owner)).toBe(true);
    expect(
      collaborationCanInitializeGroup({ ...owner, lifecycle: 'archived' }),
    ).toBe(true);
    expect(
      collaborationCanInitializeGroup({ ...owner, lifecycle: 'dissolved' }),
    ).toBe(false);
    expect(
      collaborationCanInitializeGroup({
        ...owner,
        localPrincipalId: 'principal_member',
        projection: {
          members: { principal_member: { status: 'active' } },
        },
      }),
    ).toBe(false);
    expect(
      collaborationCanInitializeGroup({
        ...owner,
        subscriptionMode: 'observer',
      }),
    ).toBe(false);
    expect(collaborationInitializeConfirmation).toBe(
      '初始化会清除全部成员、任务、文件、Workflow、事件、审计和 Git 历史，无法恢复。',
    );
  });

  it('separates Group dissolution, member exit, and local removal access', () => {
    const owner = {
      groupId: 'group_test',
      subscriptionMode: 'member',
      lifecycle: 'archived',
      ownerPrincipalId: 'principal_owner',
      localPrincipalId: 'principal_owner',
      localClientId: 'client_owner',
      projection: {
        members: { principal_owner: { status: 'active' } },
      },
    };
    expect(collaborationCanDissolve(owner)).toBe(true);
    expect(collaborationCanLeave(owner)).toBe(false);
    expect(collaborationCanRemoveLocal(owner)).toBe(true);

    const member = {
      ...owner,
      localPrincipalId: 'principal_member',
      projection: {
        members: { principal_member: { status: 'active' } },
      },
    };
    expect(collaborationCanDissolve(member)).toBe(false);
    expect(collaborationCanLeave(member)).toBe(true);
    expect(
      collaborationCanLeave({ ...member, subscriptionMode: 'observer' }),
    ).toBe(false);
  });

  it('builds distinct confirmed lifecycle requests with Aggregate revisions', () => {
    const group = {
      groupId: 'group:release/one',
      localPrincipalId: 'principal_member',
      projection: {
        aggregateHeads: {
          'group:group:release/one': { revision: 5 },
          'membership:principal_member': { revision: 3 },
        },
      },
    };
    expect(
      buildCollaborationLifecycleRequest({
        operation: 'dissolve',
        group,
        confirmation: 'group:release/one',
      }),
    ).toEqual({
      endpoint: '/groups/group%3Arelease%2Fone/dissolve',
      method: 'POST',
      body: {
        confirmation: 'group:release/one',
        expectedRevision: 5,
        reason: '群主确认解散群组',
      },
    });
    expect(
      buildCollaborationLifecycleRequest({
        operation: 'leave',
        group,
        confirmation: 'group:release/one',
      }),
    ).toEqual({
      endpoint: '/groups/group%3Arelease%2Fone/leave',
      method: 'POST',
      body: {
        confirmation: 'group:release/one',
        expectedRevision: 3,
        reason: '成员确认退出群组',
      },
    });
    expect(
      buildCollaborationLifecycleRequest({
        operation: 'remove-local',
        group,
        confirmation: 'group:release/one',
      }),
    ).toEqual({
      endpoint: '/subscriptions/group%3Arelease%2Fone',
      method: 'DELETE',
      body: { confirmation: 'group:release/one' },
    });
    expect(() =>
      buildCollaborationLifecycleRequest({
        operation: 'dissolve',
        group,
        confirmation: 'group_other',
      }),
    ).toThrow(/群组 ID 不匹配/u);
  });

  it('uses human Principal and Artifact labels for operational views', () => {
    const projection = {
      members: {
        principal_alice: { display_name: 'Alice Chen' },
      },
      artifacts: {
        artifact_report: { original_filename: 'release-report.txt' },
      },
    };
    expect(collaborationPrincipalName(projection, 'principal_alice')).toBe(
      'Alice Chen',
    );
    expect(collaborationArtifactName(projection, 'artifact_report')).toBe(
      'release-report.txt',
    );
    expect(
      collaborationArtifactName(
        projection,
        'artifacts/work-items/work_1/artifact_report/metadata.json',
      ),
    ).toBe('release-report.txt');
  });

  it('scopes Turn actions to the assignee Principal and claimant Client', () => {
    const group = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_a',
      projection: {
        members: { principal_alice: { status: 'active' } },
      },
    };
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: null,
        state: 'pending',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({
      localPrincipal: true,
      canStart: true,
      canComplete: false,
    });
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: 'client_a',
        state: 'awaiting_confirmation',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({ canComplete: true });
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: 'client_a',
        state: 'running',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({ canComplete: false });
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: 'client_b',
        state: 'running',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({
      localPrincipal: true,
      localClient: false,
      canComplete: false,
    });
  });

  it('derives membership approval authority', () => {
    expect(
      collaborationCanApproveMembers({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_owner',
        localClientId: 'client_owner',
        ownerPrincipalId: 'principal_owner',
        projection: {
          members: { principal_owner: { status: 'active' } },
          permissionGrants: {},
        },
      }),
    ).toBe(true);
    expect(
      collaborationCanApproveMembers({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_admin',
        localClientId: 'client_admin',
        ownerPrincipalId: 'principal_owner',
        projection: {
          members: { principal_admin: { status: 'active' } },
          permissionGrants: {
            principal_admin: { grants: ['member:approve'] },
          },
        },
      }),
    ).toBe(true);
    expect(
      collaborationCanApproveMembers({ subscriptionMode: 'observer' }),
    ).toBe(false);
  });

  it('only lets the pending owner answer a Work Item assignment', () => {
    const group = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_alice',
      projection: {
        members: { principal_alice: { status: 'active' } },
      },
    };
    expect(
      collaborationCanAnswerWorkItemAssignment(group, {
        owner_principal_id: 'principal_alice',
        assignment_status: 'pending',
      }),
    ).toBe(true);
    expect(
      collaborationCanAnswerWorkItemAssignment(group, {
        owner_principal_id: 'principal_bob',
        assignment_status: 'pending',
      }),
    ).toBe(false);
    expect(
      collaborationCanAnswerWorkItemAssignment(
        { ...group, subscriptionMode: 'observer' },
        {
          owner_principal_id: 'principal_alice',
          assignment_status: 'pending',
        },
      ),
    ).toBe(false);
    expect(
      buildCollaborationAssignmentDecisionRequest({
        expectedRevision: 4,
        accepted: true,
        reason: 'ignored for acceptance',
      }),
    ).toEqual({ expectedRevision: 4 });
    expect(
      buildCollaborationAssignmentDecisionRequest({
        expectedRevision: 4,
        accepted: false,
        reason: 'Capacity conflict',
      }),
    ).toEqual({ expectedRevision: 4, reason: 'Capacity conflict' });
  });

  it('builds Discussion messages with structured deduplicated Principal ids', () => {
    expect(
      buildCollaborationDiscussionMessageRequest({
        expectedRevision: 3,
        body: ' Please review ',
        mentions: ['principal_bob', 'principal_bob', 'principal_carol'],
      }),
    ).toEqual({
      expectedRevision: 3,
      body: 'Please review',
      mentions: ['principal_bob', 'principal_carol'],
    });
    expect(() =>
      buildCollaborationDiscussionMessageRequest({
        expectedRevision: 3,
        body: ' ',
        mentions: [],
      }),
    ).toThrow(/不能为空/u);
  });

  it('builds member notifications without exposing raw protocol fields', () => {
    expect(
      buildCollaborationMemberNotificationRequest({
        recipientPrincipalIds: [
          'principal_bob',
          'principal_bob',
          'principal_carol',
        ],
        bodyMarkdown: ' **Please review** ',
        scope: { type: 'discussion', ref: 'discussion_1' },
      }),
    ).toEqual({
      recipientPrincipalIds: ['principal_bob', 'principal_carol'],
      bodyMarkdown: '**Please review**',
      scope: { type: 'discussion', ref: 'discussion_1' },
      origin: 'human',
    });
    expect(() =>
      buildCollaborationMemberNotificationRequest({
        recipientPrincipalIds: [],
        bodyMarkdown: 'Hello',
        scope: { type: 'group', ref: 'group_1' },
      }),
    ).toThrow(/至少选择一名成员/u);
    expect(() =>
      buildCollaborationMemberNotificationRequest({
        recipientPrincipalIds: ['principal_bob'],
        bodyMarkdown: ' ',
        scope: { type: 'group', ref: 'group_1' },
      }),
    ).toThrow(/通知内容不能为空/u);
    expect(() =>
      buildCollaborationMemberNotificationRequest({
        recipientPrincipalIds: ['principal_bob'],
        bodyMarkdown: 'Hello',
        scope: { type: 'credential', ref: 'credential_1' },
      }),
    ).toThrow(/资源上下文无效/u);
  });

  it('builds structured Work Item edit, assignment, relation, and reason requests', () => {
    expect(
      buildCollaborationWorkItemDetailsRequest({
        expectedRevision: 4,
        type: 'task',
        title: ' Ship release ',
        description: ' Verify ',
        priority: 'high',
        contributors: ['principal_bob', 'principal_bob'],
        watchers: ['principal_alice'],
        acceptanceCriteria: [' Tested ', ''],
        labels: ['release'],
      }),
    ).toMatchObject({
      expectedRevision: 4,
      title: 'Ship release',
      contributors: ['principal_bob'],
      acceptanceCriteria: ['Tested'],
      preferredExecutorId: null,
      dueAt: null,
    });
    expect(
      buildCollaborationWorkItemAssignmentRequest({
        expectedRevision: 5,
        ownerPrincipalId: 'principal_bob',
        requireAcknowledgement: true,
      }),
    ).toEqual({
      expectedRevision: 5,
      ownerPrincipalId: 'principal_bob',
      preferredExecutorId: null,
      requireAcknowledgement: true,
    });
    expect(
      buildCollaborationWorkItemRelationsRequest({
        expectedRevision: 6,
        parentId: '',
        blockedBy: ['work_a', 'work_a'],
        relatedItems: ['work_b'],
      }),
    ).toEqual({
      expectedRevision: 6,
      parentId: null,
      blockedBy: ['work_a'],
      relatedItems: ['work_b'],
    });
    expect(
      buildCollaborationReasonRequest({
        expectedRevision: 7,
        reason: ' Completed elsewhere ',
      }),
    ).toEqual({ expectedRevision: 7, reason: 'Completed elsewhere' });
    expect(() =>
      buildCollaborationReasonRequest({ expectedRevision: 7, reason: ' ' }),
    ).toThrow(/原因不能为空/u);
    expect(
      buildCollaborationWorkflowReassignmentRequest({
        expectedRevision: 8,
        assignments: [
          { stateId: ' implementation ', principalId: ' principal_alice ' },
          { stateId: 'review', principalId: 'principal_bob' },
        ],
      }),
    ).toEqual({
      expectedRevision: 8,
      assignments: [
        { stateId: 'implementation', principalId: 'principal_alice' },
        { stateId: 'review', principalId: 'principal_bob' },
      ],
    });
    expect(() =>
      buildCollaborationWorkflowReassignmentRequest({
        expectedRevision: 8,
        assignments: [
          { stateId: 'review', principalId: 'principal_alice' },
          { stateId: 'review', principalId: 'principal_bob' },
        ],
      }),
    ).toThrow(/不能重复/u);
    expect(
      buildCollaborationTurnCancellationRequest({
        expectedRevision: 9,
        attempt: 2,
        fencingToken: 'fence',
        reason: ' Superseded ',
      }),
    ).toEqual({
      expectedRevision: 9,
      attempt: 2,
      fencingToken: 'fence',
      reason: 'Superseded',
    });
  });

  it('builds cross-field-safe Analysis Run requests', () => {
    expect(
      buildCollaborationAnalysisRunRequest({
        scopeType: 'work_item',
        resourceId: 'wi_release',
        executionChannel: 'managed_executor',
        executorId: 'analysis_local',
        selectedFileIds: ['file_a', 'file_a', 'file_b'],
      }),
    ).toEqual({
      scope: { type: 'work_item', work_item_id: 'wi_release' },
      executionChannel: 'managed_executor',
      executorId: 'analysis_local',
      selectedFileIds: ['file_a', 'file_b'],
      includeSelectedFileContents: false,
    });
    expect(
      buildCollaborationAnalysisRunRequest({
        scopeType: 'mine',
        executionChannel: 'external_agent',
      }),
    ).toEqual({
      scope: { type: 'mine' },
      executionChannel: 'external_agent',
      executorId: null,
      selectedFileIds: [],
      includeSelectedFileContents: false,
    });
    expect(
      buildCollaborationAnalysisRunRequest({
        scopeType: 'delta',
        sinceSnapshotHead: 'a'.repeat(40),
        executionChannel: 'external_agent',
      }),
    ).toEqual({
      scope: {
        type: 'delta',
        since_snapshot_head: 'a'.repeat(40),
      },
      executionChannel: 'external_agent',
      executorId: null,
      selectedFileIds: [],
      includeSelectedFileContents: false,
    });
    expect(() =>
      buildCollaborationAnalysisRunRequest({
        scopeType: 'delta',
        executionChannel: 'external_agent',
      }),
    ).toThrow(/基准 verified head/u);
    expect(() =>
      buildCollaborationAnalysisRunRequest({
        scopeType: 'delta',
        sinceSnapshotHead: 'A'.repeat(40),
        executionChannel: 'external_agent',
      }),
    ).toThrow(/小写 Git hash/u);
    expect(() =>
      buildCollaborationAnalysisRunRequest({
        scopeType: 'workflow_instance',
        executionChannel: 'external_agent',
      }),
    ).toThrow(/选择工作流实例/u);
    expect(() =>
      buildCollaborationAnalysisRunRequest({
        scopeType: 'project',
        executionChannel: 'managed_executor',
      }),
    ).toThrow(/选择本地 Executor/u);
    expect(() =>
      buildCollaborationAnalysisRunRequest({
        scopeType: 'project',
        executionChannel: 'external_agent',
        executorId: 'must_not_escape',
      }),
    ).toThrow(/不能绑定/u);
  });

  it('strictly parses one external JSON object without extracting Markdown', () => {
    expect(
      parseCollaborationExternalResult(' {"analysis_id":"analysis_1"} '),
    ).toEqual({ analysis_id: 'analysis_1' });
    expect(() =>
      parseCollaborationExternalResult(
        '```json\n{"analysis_id":"analysis_1"}\n```',
      ),
    ).toThrow(/完整 JSON 对象/u);
    expect(() => parseCollaborationExternalResult('[]')).toThrow(/JSON 对象/u);
    expect(() =>
      parseCollaborationExternalResult('{"analysis_id":"analysis_1"} trailing'),
    ).toThrow(/完整 JSON 对象/u);
    expect(
      buildCollaborationExternalResultRequest(
        '{\n  "analysis_id": "analysis_1"\n}',
      ),
    ).toBe('{\n  "analysis_id": "analysis_1"\n}');
    expect(
      buildCollaborationExternalResultRequest(
        '{"analysis_id":"analysis_1","analysis_id":"forged"}',
      ),
    ).toContain('"analysis_id":"analysis_1","analysis_id":"forged"');
  });

  it('builds explicit Finding decisions and two-step Action confirmation', () => {
    expect(
      buildCollaborationFindingDecisionRequest({
        decision: 'false_positive',
        reason: 'Evidence is obsolete',
      }),
    ).toEqual({ decision: 'false_positive', reason: 'Evidence is obsolete' });
    const action = {
      action: 'create_work_item',
      parameters: { type: 'issue', title: 'Investigate' },
    };
    expect(
      buildCollaborationActionPreviewRequest({
        actions: [
          {
            requestId: 'preview_request_1',
            findingId: 'finding_1',
            actionOrdinal: 0,
            action,
          },
        ],
      }),
    ).toEqual({
      actions: [
        {
          requestId: 'preview_request_1',
          findingId: 'finding_1',
          actionOrdinal: 0,
          action,
        },
      ],
    });
    const independentDiscussion = collaborationFindingActionDraft(
      {
        findingId: 'finding_1',
        finding: {
          title: 'Release risk',
          summary: 'The release is blocked.',
          severity: 'high',
          category: 'delivery_risk',
          affected_refs: ['work_item:wi_release'],
          evidence_refs: ['turn:turn_review'],
        },
      },
      'open_discussion',
    );
    expect(independentDiscussion).toMatchObject({
      action: 'open_discussion',
      parameters: {
        title: 'Release risk',
        scope: { type: 'work_item', ref: 'wi_release' },
      },
    });
    expect(
      buildCollaborationActionPreviewRequest({
        actions: [
          {
            requestId: 'preview_request_independent',
            findingId: 'finding_1',
            action: independentDiscussion,
          },
        ],
      }),
    ).toEqual({
      actions: [
        {
          requestId: 'preview_request_independent',
          findingId: 'finding_1',
          action: independentDiscussion,
        },
      ],
    });
    expect(
      collaborationFindingActionTypes.map(
        (actionType) =>
          collaborationFindingActionDraft(
            {
              findingId: 'finding_1',
              finding: {
                title: 'Release risk',
                summary: 'The release is blocked.',
                affected_refs: ['work_item:wi_release'],
              },
            },
            actionType,
          ).action,
      ),
    ).toEqual(collaborationFindingActionTypes);
    expect(() =>
      buildCollaborationActionPreviewRequest({ actions: [] }),
    ).toThrow(/明确选择/u);
    expect(
      buildCollaborationActionApplyRequest({
        actions: [
          {
            applicationId: 'application_1',
            confirmationToken: 'x'.repeat(32),
            action,
          },
        ],
      }),
    ).toEqual({
      actions: [
        {
          applicationId: 'application_1',
          confirmationToken: 'x'.repeat(32),
          action,
        },
      ],
    });
    expect(() => buildCollaborationActionApplyRequest({ actions: [] })).toThrow(
      /逐项确认/u,
    );
  });

  it('routes evidence and notifications to exact Project Space views', () => {
    const projection = {
      discussions: {
        discussion_1: {
          discussion: { thread_id: 'discussion_1' },
          messages: { message_1: { message_id: 'message_1' } },
        },
      },
      turns: {
        turn_1: {
          turn_id: 'turn_1',
          workflow_instance_id: 'workflow_1',
        },
      },
    };
    expect(
      collaborationResourceTarget('turn', 'turn_1', projection),
    ).toMatchObject({ tab: 'workflows', selectedInstanceId: 'workflow_1' });
    expect(
      collaborationResourceTarget('message', 'message_1', projection),
    ).toMatchObject({
      tab: 'discussions',
      selectedDiscussionId: 'discussion_1',
    });
    expect(collaborationResourceTarget('file', 'file_1')).toMatchObject({
      tab: 'files',
    });
    expect(collaborationResourceTarget('event', 'event_1')).toMatchObject({
      tab: 'audit',
    });
    expect(
      collaborationResourceTarget('principal', 'principal_1'),
    ).toMatchObject({ tab: 'members' });
    expect(
      collaborationNotificationTarget(
        { resourceType: 'analysis_run', resourceId: 'analysis_1' },
        projection,
      ),
    ).toMatchObject({ tab: 'analysis', selectedAnalysisId: 'analysis_1' });

    expect(
      collaborationResourceTarget('work_item', 'missing_work', projection),
    ).toMatchObject({ tab: 'work-items', selectedWorkItemId: '' });
    expect(
      collaborationResourceTarget('discussion', 'missing_thread', projection),
    ).toMatchObject({ tab: 'discussions', selectedDiscussionId: '' });
  });

  it('derives member notification scope from the current verified resource', () => {
    const group = {
      groupId: 'group_1',
      projection: {
        workItems: { work_1: { work_item_id: 'work_1' } },
        discussions: { thread_1: { discussion: { thread_id: 'thread_1' } } },
        files: { file_1: { file_id: 'file_1' } },
        workflowInstances: {
          instance_1: { instance_id: 'instance_1', active_turn_id: 'turn_1' },
        },
        turns: { turn_1: { turn_id: 'turn_1' } },
      },
    };
    expect(
      collaborationNotificationScope(group, {
        activeTab: 'work-items',
        selectedWorkItemId: 'work_1',
      }),
    ).toEqual({ type: 'work_item', ref: 'work_1' });
    expect(
      collaborationNotificationScope(group, {
        activeTab: 'discussions',
        selectedDiscussionId: 'thread_1',
      }),
    ).toEqual({ type: 'discussion', ref: 'thread_1' });
    expect(
      collaborationNotificationScope(group, {
        activeTab: 'files',
        filePreview: { fileId: 'file_1' },
      }),
    ).toEqual({ type: 'file', ref: 'file_1' });
    expect(
      collaborationNotificationScope(group, {
        activeTab: 'workflows',
        selectedInstanceId: 'instance_1',
      }),
    ).toEqual({ type: 'turn', ref: 'turn_1' });
    expect(
      collaborationNotificationScope(group, {
        activeTab: 'work-items',
        selectedWorkItemId: 'missing_work',
      }),
    ).toEqual({ type: 'group', ref: 'group_1' });
  });

  it('keeps Observer and stale Analysis reports read-only', () => {
    const activeGroup = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_alice',
      projection: {
        members: { principal_alice: { status: 'active' } },
      },
    };
    const detail = {
      run: {
        status: 'ready_for_review',
        executionChannel: 'managed_executor',
      },
      stale: false,
    };
    expect(collaborationAnalysisRunAccess(activeGroup, detail)).toMatchObject({
      canDecideFinding: true,
      canPreviewActions: true,
      canApplyActions: true,
    });
    expect(
      collaborationAnalysisRunAccess(
        { ...activeGroup, subscriptionMode: 'observer' },
        detail,
      ),
    ).toMatchObject({
      canDecideFinding: true,
      canPreviewActions: false,
      canApplyActions: false,
    });
    expect(
      collaborationAnalysisRunAccess(activeGroup, { ...detail, stale: true }),
    ).toMatchObject({
      canDecideFinding: false,
      canPreviewActions: false,
      canApplyActions: false,
    });
    expect(
      collaborationAnalysisRunAccess(activeGroup, {
        ...detail,
        run: { ...detail.run, status: 'stale' },
      }),
    ).toMatchObject({
      canDecideFinding: false,
      canPreviewActions: false,
      canApplyActions: false,
    });
    expect(
      collaborationAnalysisRunAccess(activeGroup, {
        run: {
          status: 'running',
          executionChannel: 'managed_executor',
        },
      }),
    ).toMatchObject({ canCancel: false });
    expect(
      collaborationAnalysisRunAccess(activeGroup, {
        run: {
          status: 'awaiting_external_result',
          executionChannel: 'external_agent',
        },
      }),
    ).toMatchObject({ canCancel: true });
  });

  it('uses stable short IDs and Credential state for recovery authority', () => {
    const principalId = 'principal_00000000-0000-4000-8000-000000000001';
    const group = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      ownerPrincipalId: principalId,
      localPrincipalId: principalId,
      localClientId: 'client_owner',
      icarusIdentity: {
        credentialId: 'credential_owner',
        recoveryCredentialAvailable: true,
      },
      projection: {
        members: { [principalId]: { status: 'active' } },
        credentials: {
          [principalId]: {
            credential_owner: { status: 'active' },
          },
        },
        permissionGrants: {},
      },
    };
    expect(collaborationShortId(principalId)).toBe('principal_00000000...0001');
    expect(collaborationLocalCredential(group)).toMatchObject({
      status: 'active',
    });
    expect(
      collaborationCanDecideRecovery(group, {
        status: 'pending',
        type: 'identity_recovery',
        target_principal_id: principalId,
      }),
    ).toBe(true);
    expect(
      collaborationCanDecideRecovery(
        {
          ...group,
          subscriptionMode: 'observer',
          projection: {
            ...group.projection,
            credentials: {
              [principalId]: {
                credential_owner: { status: 'revoked' },
              },
            },
          },
        },
        {
          status: 'pending',
          type: 'owner_recovery',
          target_principal_id: principalId,
        },
      ),
    ).toBe(true);
    expect(
      collaborationCanDecideRecovery(group, {
        status: 'approved',
        type: 'owner_recovery',
        target_principal_id: principalId,
      }),
    ).toBe(false);
  });

  it('creates each next Workflow Turn and requires an assisted Executor', () => {
    const instance = {
      instance_id: 'instance_1',
      lifecycle: 'running',
      business_state: 'build',
      active_turn_id: null,
      created_by_principal_id: 'principal_alice',
      resolved_assignments: { build: 'principal_alice' },
    };
    const definition = {
      machine: {
        states: {
          build: { terminal: false },
          done: { terminal: true },
        },
      },
    };
    const authorityGroup = {
      localPrincipalId: 'principal_alice',
      projection: { permissionGrants: {} },
    };
    expect(
      collaborationCanCreateTurn(authorityGroup, instance, definition),
    ).toBe(true);
    expect(
      collaborationCanCreateTurn(
        { ...authorityGroup, localPrincipalId: 'principal_bob' },
        instance,
        definition,
      ),
    ).toBe(false);
    expect(
      collaborationCanCreateTurn(
        authorityGroup,
        { ...instance, business_state: 'done' },
        definition,
      ),
    ).toBe(false);
    expect(
      buildCollaborationStartTurnRequest(4, { execution_mode: 'manual' }),
    ).toEqual({ expectedRevision: 4, executorId: null });
    expect(() =>
      buildCollaborationStartTurnRequest(4, {
        execution_mode: 'assisted',
      }),
    ).toThrow(/执行器/u);

    expect(
      buildCollaborationRecoverTurnRequest({
        expectedRevision: 7,
        previousAttempt: 2,
        assigneePrincipalId: 'principal_alice',
        reason: 'Executor process was replaced',
      }),
    ).toEqual({
      expectedRevision: 7,
      previousAttempt: 2,
      assigneePrincipalId: 'principal_alice',
      reason: 'Executor process was replaced',
    });
    expect(() =>
      buildCollaborationRecoverTurnRequest({
        expectedRevision: 7,
        previousAttempt: 2,
        assigneePrincipalId: 'principal_alice',
        reason: ' ',
      }),
    ).toThrow(/恢复原因不能为空/u);
    expect(() =>
      buildCollaborationRecoverTurnRequest({
        expectedRevision: 7,
        previousAttempt: 2,
        assigneePrincipalId: ' ',
        reason: 'Reassign after member exit',
      }),
    ).toThrow(/选择新的负责人/u);
    expect(
      collaborationActiveMemberOptions({
        projection: {
          members: {
            principal_bob: {
              principal_id: 'principal_bob',
              display_name: 'Bob',
              status: 'left',
            },
            principal_carol: {
              principal_id: 'principal_carol',
              display_name: 'Carol',
              status: 'active',
            },
            principal_alice: {
              principal_id: 'principal_alice',
              display_name: 'Alice',
              status: 'active',
            },
          },
        },
      }),
    ).toEqual([
      ['principal_alice', 'Alice · principal_alice'],
      ['principal_carol', 'Carol · principal_carol'],
    ]);
    expect(
      collaborationWorkflowInstanceCommand({ lifecycle: 'running' }),
    ).toEqual({ command: 'pause', label: '暂停' });
    expect(
      collaborationWorkflowInstanceCommand({ lifecycle: 'pausing' }),
    ).toEqual({ command: 'pause', label: '暂停' });
    expect(
      collaborationWorkflowInstanceCommand({ lifecycle: 'paused' }),
    ).toEqual({ command: 'resume', label: '恢复' });
    expect(
      collaborationWorkflowInstanceCommand({ lifecycle: 'ready' }),
    ).toEqual({ command: 'start', label: '启动' });
    expect(
      collaborationWorkflowInstanceCommand({ lifecycle: 'draft' }),
    ).toBeNull();
    expect(
      collaborationWorkflowInstanceCommand({ lifecycle: 'recovery_required' }),
    ).toBeNull();

    const recoveryInstance = {
      instance_id: 'instance_recovery',
      lifecycle: 'recovery_required',
      business_state: 'build',
      active_turn_id: 'turn_recovery',
      created_by_principal_id: 'principal_other',
      resolved_assignments: { build: 'principal_alice' },
    };
    const recoveryTurn = {
      turn_id: 'turn_recovery',
      state: 'recovery_required',
      assignee_principal_id: 'principal_alice',
    };
    const recoveryGroup = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_alice',
      projection: {
        members: { principal_alice: { status: 'active' } },
        permissionGrants: {},
      },
    };
    expect(
      collaborationCanRecoverTurn(
        recoveryGroup,
        recoveryInstance,
        recoveryTurn,
      ),
    ).toBe(true);
    expect(
      collaborationCanRecoverTurn(
        { ...recoveryGroup, subscriptionMode: 'observer' },
        recoveryInstance,
        recoveryTurn,
      ),
    ).toBe(false);

    const group = {
      groupId: 'group_1',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_alice',
      projection: {
        executors: {
          principal_alice: {
            executor_codex: { status: 'active' },
            executor_revoked: { status: 'revoked' },
          },
        },
      },
    };
    const turn = {
      workflow_instance_id: 'instance_1',
      state_id: 'build',
      assignee_principal_id: 'principal_alice',
      action_hash: 'sha256:action',
      prompt_hash: 'sha256:prompt',
      execution_mode: 'assisted',
    };
    const bindings = [
      {
        groupId: 'group_1',
        instanceId: 'instance_1',
        stateId: 'build',
        principalId: 'principal_alice',
        clientId: 'client_alice',
        actionHash: 'sha256:action',
        promptHash: 'sha256:prompt',
        executorId: 'executor_codex',
        enabled: true,
      },
      {
        groupId: 'group_1',
        instanceId: 'instance_1',
        stateId: 'build',
        principalId: 'principal_alice',
        clientId: 'client_other',
        actionHash: 'sha256:action',
        promptHash: 'sha256:prompt',
        executorId: 'executor_wrong_client',
        enabled: true,
      },
      {
        groupId: 'group_1',
        instanceId: 'instance_1',
        stateId: 'build',
        principalId: 'principal_alice',
        clientId: 'client_alice',
        actionHash: 'sha256:action',
        promptHash: 'sha256:prompt',
        executorId: 'executor_revoked',
        enabled: true,
      },
      {
        groupId: 'group_1',
        instanceId: 'instance_1',
        stateId: 'build',
        principalId: 'principal_alice',
        clientId: 'client_alice',
        actionHash: 'sha256:action',
        promptHash: 'sha256:prompt',
        executorId: 'executor_unknown',
        enabled: true,
      },
    ];
    expect(collaborationEligibleTurnExecutors(group, turn, bindings)).toEqual([
      'executor_codex',
    ]);
    expect(
      buildCollaborationStartTurnRequest(4, turn, 'executor_codex'),
    ).toEqual({ expectedRevision: 4, executorId: 'executor_codex' });
  });

  it('finds per-Instance current/history Turns and legal Outcomes', () => {
    const projection = {
      workflowInstances: {
        instance_a: { active_turn_id: 'turn_2' },
      },
      turns: {
        turn_1: {
          turn_id: 'turn_1',
          workflow_instance_id: 'instance_a',
          created_at: '2026-08-06T12:00:00.000Z',
        },
        turn_2: {
          turn_id: 'turn_2',
          workflow_instance_id: 'instance_a',
          state_id: 'review',
          created_at: '2026-08-06T12:01:00.000Z',
        },
      },
    };
    expect(collaborationCurrentTurn(projection, 'instance_a')?.turn_id).toBe(
      'turn_2',
    );
    expect(
      collaborationTurnHistory(projection, 'instance_a').map(
        (turn) => turn.turn_id,
      ),
    ).toEqual(['turn_2', 'turn_1']);
    expect(
      collaborationOutcomeRoutes(
        {
          machine: {
            states: {
              review: {
                transitions: [
                  {
                    outcome: 'approved',
                    label: 'Approved',
                    target_state: 'done',
                  },
                ],
              },
            },
          },
        },
        projection.turns.turn_2,
      ),
    ).toEqual([
      { outcome: 'approved', label: 'Approved', target_state: 'done' },
    ]);
  });

  it('derives notify-only deadline presentation without changing state', () => {
    const now = Date.parse('2026-08-06T12:01:30.000Z');
    expect(
      collaborationTurnDeadline(
        {
          state: 'pending',
          start_deadline_at: '2026-08-06T12:02:00.000Z',
          execution_deadline_at: null,
        },
        now,
      ),
    ).toMatchObject({
      deadlineKind: 'start',
      remainingMs: 30_000,
      overdue: false,
    });
    expect(
      collaborationTurnDeadline(
        {
          state: 'running',
          start_deadline_at: null,
          execution_deadline_at: '2026-08-06T12:01:00.000Z',
        },
        now,
      ),
    ).toMatchObject({
      deadlineKind: 'execution',
      remainingMs: -30_000,
      overdue: true,
    });
    expect(
      collaborationTurnDeadline(
        {
          state: 'awaiting_confirmation',
          start_deadline_at: '2026-08-06T12:00:00.000Z',
          execution_deadline_at: '2026-08-06T12:03:00.000Z',
        },
        now,
      ),
    ).toEqual({
      deadlineKind: 'execution',
      deadlineAt: '2026-08-06T12:03:00.000Z',
      remainingMs: 90_000,
      overdue: false,
    });
    expect(collaborationDuration(3_600_000)).toBe('1 小时');
  });

  it('prefills Assisted completion markers and submits the edited identifiers', () => {
    const turn = {
      attempt: 2,
      fencing_token: 'fence_2',
      executor_result: {
        outcome: 'ready_for_test',
        summary: 'Executor summary',
        instruction: 'Review the evidence',
        markers: ['executor_suggested', 'needs_review'],
        data: { confidence: 0.8 },
      },
    };
    expect(
      collaborationTurnCompletionDraft(turn, [
        { outcome: 'retry' },
        { outcome: 'ready_for_test' },
      ]),
    ).toEqual({
      outcome: 'ready_for_test',
      summary: 'Executor summary',
      instruction: 'Review the evidence',
      markers: 'executor_suggested, needs_review',
      data: '{\n  "confidence": 0.8\n}',
    });

    expect(
      buildCollaborationCompleteTurnRequest({
        expectedRevision: 7,
        turn,
        outcome: 'ready_for_test',
        summary: 'Confirmed summary',
        instruction: 'Continue to validation',
        markers: 'confirmed, release_candidate\nconfirmed',
        data: { confidence: 1 },
        artifactIds: ['artifact_1'],
      }),
    ).toEqual({
      expectedRevision: 7,
      attempt: 2,
      fencingToken: 'fence_2',
      outcome: 'ready_for_test',
      summary: 'Confirmed summary',
      instruction: 'Continue to validation',
      markers: ['confirmed', 'release_candidate'],
      data: { confidence: 1 },
      artifactIds: ['artifact_1'],
    });
    expect(() =>
      buildCollaborationCompleteTurnRequest({
        expectedRevision: 7,
        turn,
        outcome: 'ready_for_test',
        summary: 'Confirmed summary',
        instruction: '',
        markers: 'valid, not valid',
        data: {},
        artifactIds: [],
      }),
    ).toThrow(/标记必须是合法标识符/u);
  });

  it('builds verified virtual files and Work Item board columns', () => {
    const tree = collaborationVerifiedFileTree([
      { fileId: 'file_1', virtualPath: 'Shared/Documents/evidence.pdf' },
      { fileId: 'file_2', virtualPath: 'Alice/Files/notes.txt' },
    ]);
    expect(
      tree.directories.Shared.directories.Documents.files[0],
    ).toMatchObject({
      name: 'evidence.pdf',
    });
    expect(
      collaborationWorkItemColumns([
        {
          work_item_id: 'late',
          status: 'open',
          due_at: '2026-08-08T00:00:00Z',
        },
        {
          work_item_id: 'early',
          status: 'open',
          due_at: '2026-08-07T00:00:00Z',
        },
        { work_item_id: 'done', status: 'done', due_at: null },
      ]).open.map((item) => item.work_item_id),
    ).toEqual(['early', 'late']);
  });

  it('accepts durable notifications and orders audit by commit order', () => {
    expect(
      collaborationPendingNotifications({
        notifications: [
          {
            notificationId: 'note_1',
            resourceType: 'turn',
            resourceId: 'turn_1',
          },
          { notificationId: 'incomplete' },
        ],
      }),
    ).toHaveLength(1);
    expect(
      collaborationNotificationTarget(
        { resourceType: 'turn', resourceId: 'turn_1' },
        {
          turns: {
            turn_1: { workflow_instance_id: 'instance_1' },
          },
        },
      ),
    ).toMatchObject({
      tab: 'workflows',
      selectedInstanceId: 'instance_1',
      resourceId: 'turn_1',
    });
    expect(
      collaborationResourceTarget('analysis_run', 'analysis_1'),
    ).toMatchObject({
      tab: 'analysis',
      selectedAnalysisId: 'analysis_1',
    });
    expect(collaborationResourceTarget('protocol', 'group_1')).toMatchObject({
      tab: 'diagnostics',
    });
    expect(
      collaborationAuditEventTimeline([
        { event_id: 'event_2', commit_order: 2 },
        { event_id: 'event_1', commit_order: 1 },
      ]).map((event) => event.event_id),
    ).toEqual(['event_1', 'event_2']);
  });

  it('stages selected Artifact files once and reuses their ids on command retry', async () => {
    const files = [
      new File(['evidence'], 'evidence.txt', { type: 'text/plain' }),
      new File([new Uint8Array([0, 1, 255])], 'result.bin'),
    ];
    const requests = [];
    const request = async (endpoint, options) => {
      const metadata = JSON.parse(await options.body.get('metadata').text());
      requests.push({ endpoint, metadata });
      return {
        metadata: { artifact_id: `artifact_${requests.length}` },
      };
    };
    const artifactIds = [];
    await stageCollaborationArtifactFiles({
      files,
      artifactIds,
      request,
      endpoint: '/work-items/work_1/artifacts',
      metadata: (file) => ({
        fileName: file.name,
        mediaType: file.type || 'application/octet-stream',
      }),
    });
    await stageCollaborationArtifactFiles({
      files,
      artifactIds,
      request,
      endpoint: '/work-items/work_1/artifacts',
      metadata: () => ({}),
    });
    expect(artifactIds).toEqual(['artifact_1', 'artifact_2']);
    expect(requests).toEqual([
      {
        endpoint: '/work-items/work_1/artifacts',
        metadata: { fileName: 'evidence.txt', mediaType: 'text/plain' },
      },
      {
        endpoint: '/work-items/work_1/artifacts',
        metadata: {
          fileName: 'result.bin',
          mediaType: 'application/octet-stream',
        },
      },
    ]);
  });
});
