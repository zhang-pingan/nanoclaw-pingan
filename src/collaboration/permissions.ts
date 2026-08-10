export const COLLABORATION_PERMISSION_CATALOG_VERSION = 1 as const;

export const COLLABORATION_PERMISSIONS = [
  'group:admin',
  'group:archive',
  'member:approve',
  'permission:grant',
  'workspace:write_shared',
  'workspace:publish_owned',
  'work_item:create',
  'work_item:manage_owned',
  'work_item:manage_all',
  'discussion:create',
  'discussion:post',
  'discussion:moderate',
  'workflow_definition:propose',
  'workflow_definition:publish',
  'workflow_instance:start_allowed',
  'workflow_instance:manage_all',
] as const;

export type CollaborationPermission =
  (typeof COLLABORATION_PERMISSIONS)[number];

export interface CollaborationPermissionCatalogEntry {
  readonly id: CollaborationPermission;
  readonly nameZh: string;
  readonly summaryZh: string;
}

const permissionDescriptions: Readonly<
  Record<CollaborationPermission, readonly [string, string]>
> = {
  'group:admin': ['群组管理', '拥有除群组所有权外的内置群组管理能力'],
  'group:archive': ['归档群组', '归档或重新开放群组'],
  'member:approve': ['成员与邀请', '审批成员申请并管理邀请'],
  'permission:grant': ['权限授权', '变更成员的直接权限'],
  'workspace:write_shared': ['共享文件写入', '发布或修订群组共享文件'],
  'workspace:publish_owned': ['个人空间发布', '发布本人进展、文件与自动化'],
  'work_item:create': ['创建工作项', '创建任务、问题、决策或里程碑'],
  'work_item:manage_owned': ['管理负责的工作项', '管理本人负责的工作项'],
  'work_item:manage_all': ['管理全部工作项', '管理群组中的任意工作项'],
  'discussion:create': ['创建讨论', '创建群组或资源讨论'],
  'discussion:post': ['参与讨论', '在开放讨论中发布消息'],
  'discussion:moderate': ['管理讨论', '解决讨论并移除不适用消息'],
  'workflow_definition:propose': [
    '设计 Workflow',
    '创建和修改 Workflow Definition 提案',
  ],
  'workflow_definition:publish': [
    '发布 Workflow',
    '发布、退役 Definition 并管理布局',
  ],
  'workflow_instance:start_allowed': [
    '启动 Workflow',
    '按 Definition 启动策略创建或启动实例',
  ],
  'workflow_instance:manage_all': [
    '管理 Workflow 实例',
    '管理、重分配和恢复任意 Workflow 实例',
  ],
};

export const COLLABORATION_PERMISSION_CATALOG = Object.freeze(
  COLLABORATION_PERMISSIONS.map((id) => ({
    id,
    nameZh: permissionDescriptions[id][0],
    summaryZh: permissionDescriptions[id][1],
  })),
);

export const COLLABORATION_PERMISSION_TEMPLATE_VERSION = 1 as const;
export const DEFAULT_COLLABORATION_PERMISSION_TEMPLATE_ID =
  'member.v1' as const;

export interface CollaborationPermissionTemplate {
  readonly id:
    | 'member.v1'
    | 'contributor.v1'
    | 'project_manager.v1'
    | 'workflow_manager.v1'
    | 'group_manager.v1';
  readonly version: 1;
  readonly nameZh: string;
  readonly summaryZh: string;
  readonly permissions: readonly CollaborationPermission[];
}

export const COLLABORATION_PERMISSION_TEMPLATES = Object.freeze([
  {
    id: 'member.v1',
    version: COLLABORATION_PERMISSION_TEMPLATE_VERSION,
    nameZh: '基础成员',
    summaryZh: '发布个人进展、创建工作项并参与讨论',
    permissions: [
      'workspace:publish_owned',
      'work_item:create',
      'work_item:manage_owned',
      'discussion:create',
      'discussion:post',
    ],
  },
  {
    id: 'contributor.v1',
    version: COLLABORATION_PERMISSION_TEMPLATE_VERSION,
    nameZh: '贡献者',
    summaryZh: '具备基础成员能力，并可维护共享文件',
    permissions: [
      'workspace:publish_owned',
      'workspace:write_shared',
      'work_item:create',
      'work_item:manage_owned',
      'discussion:create',
      'discussion:post',
    ],
  },
  {
    id: 'project_manager.v1',
    version: COLLABORATION_PERMISSION_TEMPLATE_VERSION,
    nameZh: '项目管理',
    summaryZh: '管理工作项、讨论、共享文件并启动获准的 Workflow',
    permissions: [
      'workspace:publish_owned',
      'workspace:write_shared',
      'work_item:create',
      'work_item:manage_owned',
      'work_item:manage_all',
      'discussion:create',
      'discussion:post',
      'discussion:moderate',
      'workflow_instance:start_allowed',
    ],
  },
  {
    id: 'workflow_manager.v1',
    version: COLLABORATION_PERMISSION_TEMPLATE_VERSION,
    nameZh: 'Workflow 设计与管理',
    summaryZh: '设计、发布、启动并管理 Workflow',
    permissions: [
      'workspace:publish_owned',
      'work_item:create',
      'work_item:manage_owned',
      'discussion:create',
      'discussion:post',
      'workflow_definition:propose',
      'workflow_definition:publish',
      'workflow_instance:start_allowed',
      'workflow_instance:manage_all',
    ],
  },
  {
    id: 'group_manager.v1',
    version: COLLABORATION_PERMISSION_TEMPLATE_VERSION,
    nameZh: '群组管理',
    summaryZh: '管理群组设置、成员、授权和全部业务资源',
    permissions: ['group:admin', 'permission:grant'],
  },
] satisfies readonly CollaborationPermissionTemplate[]);

export type CollaborationPermissionTemplateId =
  (typeof COLLABORATION_PERMISSION_TEMPLATES)[number]['id'];

export function collaborationPermissionTemplate(
  templateId: string,
): CollaborationPermissionTemplate | null {
  return (
    COLLABORATION_PERMISSION_TEMPLATES.find(
      (template) => template.id === templateId,
    ) ?? null
  );
}

export function collaborationPermissionsForTemplate(
  templateId: string,
): readonly CollaborationPermission[] {
  const template = collaborationPermissionTemplate(templateId);
  if (!template) throw new Error(`Unknown permission template: ${templateId}`);
  return template.permissions;
}

export function collaborationPermissionTemplateMatch(
  permissions: readonly CollaborationPermission[],
): CollaborationPermissionTemplate | null {
  const normalized = [...new Set(permissions)].sort().join('\0');
  return (
    COLLABORATION_PERMISSION_TEMPLATES.find(
      (template) => [...template.permissions].sort().join('\0') === normalized,
    ) ?? null
  );
}
