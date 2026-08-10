import {
  COLLABORATION_PERMISSION_CATALOG,
  COLLABORATION_PERMISSION_CATALOG_VERSION,
  COLLABORATION_PERMISSION_TEMPLATES,
  DEFAULT_COLLABORATION_PERMISSION_TEMPLATE_ID,
  collaborationPermissionTemplateMatch,
  type CollaborationPermission,
} from './permissions.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';
import type {
  DiscussionMessage,
  WorkflowDefinition,
  WorkflowInstance,
  WorkItem,
} from './protocol/v3-schema.js';

export type CollaborationAuthorizationCode =
  | 'ALLOWED'
  | 'OBSERVER_READ_ONLY'
  | 'MEMBERSHIP_INACTIVE'
  | 'CLIENT_INACTIVE'
  | 'CREDENTIAL_INACTIVE'
  | 'GROUP_ARCHIVED'
  | 'PERMISSION_REQUIRED'
  | 'RESOURCE_AUTHORITY_REQUIRED'
  | 'RESOURCE_STATE_BLOCKED'
  | 'WORKFLOW_LAUNCH_POLICY_DENIED';

export interface CollaborationActionDecision {
  readonly allowed: boolean;
  readonly code: CollaborationAuthorizationCode;
  readonly reason: string | null;
}

export interface CollaborationAuthorizationPrincipal {
  readonly principalId: string | null;
  readonly membershipStatus: string;
  readonly isOwner: boolean;
  readonly directPermissions: readonly CollaborationPermission[];
  readonly effectivePermissions: readonly CollaborationPermission[];
  readonly matchedTemplateId: string | null;
}

export interface CollaborationAllowedActionsProjection {
  readonly version: 1;
  readonly principal: CollaborationAuthorizationPrincipal;
  readonly catalogs: {
    readonly permissionCatalogVersion: number;
    readonly permissions: typeof COLLABORATION_PERMISSION_CATALOG;
    readonly templates: typeof COLLABORATION_PERMISSION_TEMPLATES;
    readonly defaultTemplateId: string;
  };
  readonly group: Readonly<Record<string, CollaborationActionDecision>>;
  readonly workItems: Readonly<
    Record<string, Readonly<Record<string, CollaborationActionDecision>>>
  >;
  readonly discussions: Readonly<
    Record<
      string,
      {
        readonly post: CollaborationActionDecision;
        readonly resolve: CollaborationActionDecision;
        readonly messages: Readonly<
          Record<
            string,
            {
              readonly revise: CollaborationActionDecision;
              readonly tombstone: CollaborationActionDecision;
            }
          >
        >;
      }
    >
  >;
  readonly workflowDefinitions: Readonly<
    Record<
      string,
      {
        readonly editDefinition: CollaborationActionDecision;
        readonly editLayout: CollaborationActionDecision;
        readonly publish: CollaborationActionDecision;
        readonly retire: CollaborationActionDecision;
        readonly createGroupInstance: CollaborationActionDecision;
        readonly createWorkItemInstances: Readonly<
          Record<string, CollaborationActionDecision>
        >;
      }
    >
  >;
  readonly workflowInstances: Readonly<
    Record<string, Readonly<Record<string, CollaborationActionDecision>>>
  >;
  readonly members: Readonly<
    Record<
      string,
      {
        readonly directPermissions: readonly CollaborationPermission[];
        readonly effectivePermissions: readonly CollaborationPermission[];
        readonly matchedTemplateId: string | null;
        readonly isOwner: boolean;
      }
    >
  >;
  readonly clients: Readonly<
    Record<
      string,
      {
        readonly revoke: CollaborationActionDecision;
      }
    >
  >;
  readonly credentials: Readonly<
    Record<
      string,
      {
        readonly revoke: CollaborationActionDecision;
      }
    >
  >;
  readonly recoveryRequests: Readonly<
    Record<
      string,
      {
        readonly approve: CollaborationActionDecision;
        readonly reject: CollaborationActionDecision;
        readonly cancel: CollaborationActionDecision;
      }
    >
  >;
}

const allowed = (): CollaborationActionDecision => ({
  allowed: true,
  code: 'ALLOWED',
  reason: null,
});

const denied = (
  code: Exclude<CollaborationAuthorizationCode, 'ALLOWED'>,
  reason: string,
): CollaborationActionDecision => ({ allowed: false, code, reason });

export function hasCollaborationPermissionV3(
  projection: CollaborationProjectionV3,
  principalId: string,
  permission: CollaborationPermission,
): boolean {
  return (
    principalId === projection.group.owner_principal_id ||
    projection.permissionGrants[principalId]?.grants.includes(permission) ===
      true ||
    (permission !== 'group:admin' &&
      projection.permissionGrants[principalId]?.grants.includes(
        'group:admin',
      ) === true)
  );
}

export function canManageCollaborationWorkItemV3(
  projection: CollaborationProjectionV3,
  principalId: string,
  item: WorkItem,
): boolean {
  return (
    item.owner_principal_id === principalId ||
    hasCollaborationPermissionV3(
      projection,
      principalId,
      'work_item:manage_all',
    )
  );
}

export function canContributeToCollaborationWorkItemV3(
  projection: CollaborationProjectionV3,
  principalId: string,
  item: WorkItem,
): boolean {
  return (
    canManageCollaborationWorkItemV3(projection, principalId, item) ||
    item.contributors.includes(principalId)
  );
}

export function canLaunchCollaborationWorkflowV3(
  projection: CollaborationProjectionV3,
  principalId: string,
  instance: Pick<WorkflowInstance, 'scope'>,
  definition: WorkflowDefinition,
): boolean {
  if (
    hasCollaborationPermissionV3(
      projection,
      principalId,
      'workflow_instance:start_allowed',
    ) ||
    definition.launch_policy.principals.includes(principalId)
  )
    return true;
  if (
    definition.launch_policy.group_admin &&
    hasCollaborationPermissionV3(projection, principalId, 'group:admin')
  )
    return true;
  return Boolean(
    definition.launch_policy.work_item_owner &&
    instance.scope.type === 'work_item' &&
    projection.workItems[instance.scope.work_item_id]?.owner_principal_id ===
      principalId,
  );
}

export function canManageCollaborationWorkflowInstanceV3(
  projection: CollaborationProjectionV3,
  principalId: string,
  instance: WorkflowInstance,
): boolean {
  return (
    instance.created_by_principal_id === principalId ||
    hasCollaborationPermissionV3(
      projection,
      principalId,
      'workflow_instance:manage_all',
    ) ||
    instance.resolved_assignments[instance.business_state] === principalId
  );
}

function boundaryDecision(input: {
  readonly projection: CollaborationProjectionV3;
  readonly subscriptionMode: 'observer' | 'member';
  readonly principalId: string | null;
  readonly clientId: string | null;
  readonly credentialId: string | null;
}): CollaborationActionDecision {
  if (input.subscriptionMode === 'observer' || !input.principalId)
    return denied('OBSERVER_READ_ONLY', '观察者只能查看群组内容');
  if (input.projection.members[input.principalId]?.status !== 'active')
    return denied('MEMBERSHIP_INACTIVE', '当前成员身份尚未生效');
  if (
    !input.clientId ||
    input.projection.clients[input.principalId]?.[input.clientId]?.status !==
      'active'
  )
    return denied('CLIENT_INACTIVE', '当前 Client 已失效');
  if (
    !input.credentialId ||
    input.projection.credentials[input.principalId]?.[input.credentialId]
      ?.status !== 'active'
  )
    return denied('CREDENTIAL_INACTIVE', '当前签名 Credential 已失效');
  if (input.projection.group.lifecycle !== 'active')
    return denied('GROUP_ARCHIVED', '已归档群组不接受业务写入');
  return allowed();
}

function withPermission(
  boundary: CollaborationActionDecision,
  projection: CollaborationProjectionV3,
  principalId: string | null,
  permission: CollaborationPermission,
): CollaborationActionDecision {
  if (!boundary.allowed) return boundary;
  return principalId &&
    hasCollaborationPermissionV3(projection, principalId, permission)
    ? allowed()
    : denied('PERMISSION_REQUIRED', `需要权限 ${permission}`);
}

function withAuthority(
  boundary: CollaborationActionDecision,
  authority: boolean,
  reason: string,
): CollaborationActionDecision {
  if (!boundary.allowed) return boundary;
  return authority ? allowed() : denied('RESOURCE_AUTHORITY_REQUIRED', reason);
}

export function projectCollaborationAllowedActionsV3(input: {
  readonly projection: CollaborationProjectionV3;
  readonly subscriptionMode: 'observer' | 'member';
  readonly principalId: string | null;
  readonly clientId: string | null;
  readonly credentialId: string | null;
  readonly recoveryCredentialAvailable?: boolean;
}): CollaborationAllowedActionsProjection {
  const { projection, principalId } = input;
  const boundary = boundaryDecision(input);
  const directPermissions = principalId
    ? (projection.permissionGrants[principalId]?.grants ?? [])
    : [];
  const isOwner = principalId === projection.group.owner_principal_id;
  const effectivePermissions = isOwner
    ? [...COLLABORATION_PERMISSION_CATALOG.map((entry) => entry.id)]
    : directPermissions.includes('group:admin')
      ? [...COLLABORATION_PERMISSION_CATALOG.map((entry) => entry.id)]
      : [...directPermissions];
  const permission = (value: CollaborationPermission) =>
    withPermission(boundary, projection, principalId, value);
  const authority = (value: boolean, reason: string) =>
    withAuthority(boundary, value, reason);
  const can = (value: boolean, reason: string) =>
    boundary.allowed
      ? value
        ? allowed()
        : denied('WORKFLOW_LAUNCH_POLICY_DENIED', reason)
      : boundary;
  const activeGroupDecision = (
    value: boolean,
    reason: string,
  ): CollaborationActionDecision => {
    if (projection.group.lifecycle !== 'active')
      return denied('GROUP_ARCHIVED', '已归档群组不接受业务写入');
    return value ? allowed() : denied('RESOURCE_AUTHORITY_REQUIRED', reason);
  };

  const workItems = Object.fromEntries(
    Object.values(projection.workItems).map((item) => {
      const manage = Boolean(
        principalId &&
        canManageCollaborationWorkItemV3(projection, principalId, item),
      );
      const contribute = Boolean(
        principalId &&
        canContributeToCollaborationWorkItemV3(projection, principalId, item),
      );
      return [
        item.work_item_id,
        {
          manage: authority(manage, '仅工作项负责人或项目管理员可管理此工作项'),
          postProgress: authority(
            contribute,
            '仅工作项负责人、贡献者或项目管理员可发布进展',
          ),
          answerAssignment: authority(
            item.assignment_status === 'pending' &&
              item.owner_principal_id === principalId,
            '仅待确认指派的负责人可接受或拒绝',
          ),
        },
      ];
    }),
  );

  const discussions = Object.fromEntries(
    Object.values(projection.discussions).map((thread) => [
      thread.discussion.thread_id,
      {
        post:
          thread.discussion.status === 'open'
            ? permission('discussion:post')
            : denied('RESOURCE_STATE_BLOCKED', '已解决的讨论不能回复'),
        resolve: authority(
          Boolean(
            principalId &&
            (thread.discussion.created_by === principalId ||
              hasCollaborationPermissionV3(
                projection,
                principalId,
                'discussion:moderate',
              )),
          ),
          '仅讨论创建者或讨论管理员可变更状态',
        ),
        messages: Object.fromEntries(
          Object.values(thread.messages).map((message: DiscussionMessage) => [
            message.message_id,
            {
              revise: authority(
                message.author_principal_id === principalId,
                '仅消息作者可修改消息',
              ),
              tombstone: authority(
                Boolean(
                  principalId &&
                  (message.author_principal_id === principalId ||
                    hasCollaborationPermissionV3(
                      projection,
                      principalId,
                      'discussion:moderate',
                    )),
                ),
                '仅消息作者或讨论管理员可移除消息',
              ),
            },
          ]),
        ),
      },
    ]),
  );

  const workflowDefinitions = Object.fromEntries(
    Object.entries(projection.workflowDefinitions).map(([key, entry]) => {
      const launch = (scope: WorkflowInstance['scope']) =>
        !boundary.allowed
          ? boundary
          : entry.definition.status !== 'published'
            ? denied('RESOURCE_STATE_BLOCKED', 'Workflow Definition 尚未发布')
            : can(
                Boolean(
                  principalId &&
                  canLaunchCollaborationWorkflowV3(
                    projection,
                    principalId,
                    { scope },
                    entry.definition,
                  ),
                ),
                'Definition 启动策略不允许当前成员创建此实例',
              );
      return [
        key,
        {
          editDefinition: permission('workflow_definition:propose'),
          editLayout: authority(
            Boolean(
              principalId &&
              (entry.definition.created_by_principal_id === principalId ||
                hasCollaborationPermissionV3(
                  projection,
                  principalId,
                  'workflow_definition:publish',
                )),
            ),
            '仅 Definition 创建者或 Workflow 发布者可编辑布局',
          ),
          publish: permission('workflow_definition:publish'),
          retire: permission('workflow_definition:publish'),
          createGroupInstance: launch({ type: 'group' }),
          createWorkItemInstances: Object.fromEntries(
            Object.values(projection.workItems).map((item) => [
              item.work_item_id,
              launch({ type: 'work_item', work_item_id: item.work_item_id }),
            ]),
          ),
        },
      ];
    }),
  );

  const workflowInstances = Object.fromEntries(
    Object.values(projection.workflowInstances).map((instance) => {
      const definition =
        projection.workflowDefinitions[
          `${instance.definition_id}@${String(instance.definition_version)}`
        ]?.definition;
      const manage = Boolean(
        principalId &&
        canManageCollaborationWorkflowInstanceV3(
          projection,
          principalId,
          instance,
        ),
      );
      return [
        instance.instance_id,
        {
          manage: authority(
            manage,
            '仅实例创建者、当前负责人或 Workflow 管理员可管理此实例',
          ),
          reassign: authority(
            manage,
            '仅实例创建者、当前负责人或 Workflow 管理员可重新分配',
          ),
          createTurn: authority(
            manage,
            '仅实例创建者、当前负责人或 Workflow 管理员可创建执行轮次',
          ),
          configureCurrentState: authority(
            instance.resolved_assignments[instance.business_state] ===
              principalId,
            '仅当前 State 负责人可配置执行',
          ),
          start: can(
            Boolean(
              principalId &&
              definition &&
              canLaunchCollaborationWorkflowV3(
                projection,
                principalId,
                instance,
                definition,
              ),
            ),
            'Definition 启动策略不允许当前成员启动此实例',
          ),
        },
      ];
    }),
  );

  const canCreateWorkflowInstance = Object.values(
    projection.workflowDefinitions,
  ).some((entry) => {
    if (entry.definition.status !== 'published' || !principalId) return false;
    if (
      canLaunchCollaborationWorkflowV3(
        projection,
        principalId,
        { scope: { type: 'group' } },
        entry.definition,
      )
    )
      return true;
    return Object.values(projection.workItems).some((item) =>
      canLaunchCollaborationWorkflowV3(
        projection,
        principalId,
        { scope: { type: 'work_item', work_item_id: item.work_item_id } },
        entry.definition,
      ),
    );
  });

  const clients = Object.fromEntries(
    Object.values(projection.clients).flatMap((entries) =>
      Object.values(entries).map((client) => [
        client.client_id,
        {
          revoke: authority(
            Boolean(
              principalId &&
              client.principal_id === principalId &&
              client.client_id !== input.clientId &&
              client.status === 'active',
            ),
            '只能撤销当前 Principal 的其他 Active Client',
          ),
        },
      ]),
    ),
  );

  const credentials = Object.fromEntries(
    Object.values(projection.credentials).flatMap((entries) =>
      Object.values(entries).map((credential) => [
        credential.credential_id,
        {
          revoke: authority(
            Boolean(
              principalId &&
              credential.principal_id === principalId &&
              credential.credential_id !== input.credentialId &&
              credential.purpose === 'event_signing' &&
              credential.status === 'active',
            ),
            '只能撤销当前 Principal 的其他 Active 事件签名 Credential',
          ),
        },
      ]),
    ),
  );

  const recoveryRequests = Object.fromEntries(
    Object.values(projection.recoveryRequests).map((request) => {
      let decision: CollaborationActionDecision;
      if (request.status !== 'pending')
        decision = denied('RESOURCE_STATE_BLOCKED', '恢复请求已结束');
      else if (request.type === 'identity_recovery')
        decision = authority(
          request.target_principal_id === principalId,
          '仅目标 Principal 的 Active Client 可决定身份恢复',
        );
      else if (
        projection.group.lifecycle === 'active' &&
        request.target_principal_id === principalId &&
        principalId === projection.group.owner_principal_id &&
        (boundary.allowed || input.recoveryCredentialAvailable)
      )
        decision = allowed();
      else
        decision = activeGroupDecision(
          false,
          '仅群组 Owner 或其离线恢复 Credential 可决定 Owner 恢复',
        );
      const cancel =
        request.status !== 'pending'
          ? denied('RESOURCE_STATE_BLOCKED', '恢复请求已结束')
          : activeGroupDecision(
              request.target_principal_id === principalId &&
                request.requested_client.client_id === input.clientId &&
                request.requested_credential.credential_id ===
                  input.credentialId,
              '仅发起恢复请求的 Client 可取消',
            );
      return [
        request.request_id,
        { approve: decision, reject: decision, cancel },
      ];
    }),
  );

  return {
    version: 1,
    principal: {
      principalId,
      membershipStatus: principalId
        ? (projection.members[principalId]?.status ?? 'unknown')
        : input.subscriptionMode === 'observer'
          ? 'observer'
          : 'unknown',
      isOwner,
      directPermissions,
      effectivePermissions,
      matchedTemplateId:
        collaborationPermissionTemplateMatch(directPermissions)?.id ?? null,
    },
    catalogs: {
      permissionCatalogVersion: COLLABORATION_PERMISSION_CATALOG_VERSION,
      permissions: COLLABORATION_PERMISSION_CATALOG,
      templates: COLLABORATION_PERMISSION_TEMPLATES,
      defaultTemplateId:
        projection.group.default_permission_template_id ??
        DEFAULT_COLLABORATION_PERMISSION_TEMPLATE_ID,
    },
    group: {
      requestJoin: activeGroupDecision(
        input.subscriptionMode === 'observer',
        '当前订阅已经具有成员身份',
      ),
      requestRecovery: activeGroupDecision(
        input.subscriptionMode === 'observer' &&
          Object.values(projection.members).some(
            (member) => member.status === 'active',
          ),
        '恢复身份需要观察者订阅和一个 Active Principal',
      ),
      createWorkItem: permission('work_item:create'),
      createDiscussion: permission('discussion:create'),
      postOwnedWorkspace: permission('workspace:publish_owned'),
      writeSharedWorkspace: permission('workspace:write_shared'),
      proposeWorkflowDefinition: permission('workflow_definition:propose'),
      createWorkflowInstance: can(
        canCreateWorkflowInstance,
        '没有已发布的 Definition 允许当前成员创建实例',
      ),
      approveMembers: permission('member:approve'),
      manageInvites: permission('member:approve'),
      managePermissions: permission('permission:grant'),
      updateSettings: permission('group:admin'),
      archive: permission('group:archive'),
      rotateOwnCredential: boundary,
    },
    workItems,
    discussions,
    workflowDefinitions,
    workflowInstances,
    members: Object.fromEntries(
      Object.keys(projection.members).map((memberId) => {
        const permissions = projection.permissionGrants[memberId]?.grants ?? [];
        const memberIsOwner = memberId === projection.group.owner_principal_id;
        const memberEffective =
          memberIsOwner || permissions.includes('group:admin')
            ? COLLABORATION_PERMISSION_CATALOG.map((entry) => entry.id)
            : permissions;
        return [
          memberId,
          {
            directPermissions: permissions,
            effectivePermissions: memberEffective,
            matchedTemplateId:
              collaborationPermissionTemplateMatch(permissions)?.id ?? null,
            isOwner: memberIsOwner,
          },
        ];
      }),
    ),
    clients,
    credentials,
    recoveryRequests,
  };
}
