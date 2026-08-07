import { z } from 'zod';

import {
  COLLABORATION_CONTROL_BRANCH,
  CollaborationProtocolError,
} from './version.js';

export const V3_COLLABORATION_PROTOCOL_VERSION = 3 as const;

export const collaborationIdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u);
export const collaborationSha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u);
export const collaborationIsoTimeSchema = z.iso.datetime({ offset: true });
export const collaborationSshPublicKeySchema = z
  .string()
  .min(32)
  .max(16_384)
  .regex(
    /^(?:ssh-ed25519|ecdsa-sha2-[A-Za-z0-9@._+-]+|sk-ssh-[A-Za-z0-9@._+-]+) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,1024})?$/u,
  );

export const collaborationRelativePathSchema = z
  .string()
  .min(1)
  .max(768)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '' || segment === '..'),
    'must be a normalized repository-relative path',
  );
export const collaborationBasenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('\0'),
    'must be a safe basename',
  );

const extensionsSchema = z.record(z.string(), z.unknown()).optional();
const principalIdSchema = collaborationIdentifierSchema.refine(
  (value) => value.startsWith('principal_'),
  'must be a Principal id',
);
const actorOriginSchema = z.enum(['human', 'agent', 'workflow']);

export const membershipPolicySchema = z
  .object({ join: z.enum(['open', 'approval', 'invite_only']) })
  .strict();
export const visibilityPolicySchema = z
  .object({ observer_access: z.enum(['allowed', 'members_only']) })
  .strict();

export const groupDefinitionV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-group/3'),
    protocol_version: z.literal(V3_COLLABORATION_PROTOCOL_VERSION),
    group_id: collaborationIdentifierSchema,
    name: z.string().min(1).max(240),
    creator: z
      .object({
        principal_id: principalIdSchema,
        signing_key_ref: z.string().min(1).max(255),
      })
      .strict(),
    owner_principal_id: principalIdSchema,
    control_branch: z.literal(COLLABORATION_CONTROL_BRANCH),
    lifecycle: z.enum(['active', 'archived']),
    membership_policy: membershipPolicySchema,
    visibility_policy: visibilityPolicySchema,
    created_at: collaborationIsoTimeSchema,
    archived_at: collaborationIsoTimeSchema.nullable().default(null),
    extensions: extensionsSchema,
  })
  .strict()
  .refine((group) => group.creator.principal_id === group.owner_principal_id, {
    message: 'creator must be the initial owner',
  });
export type GroupDefinitionV3 = z.infer<typeof groupDefinitionV3Schema>;

export const memberDefinitionV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-member/3'),
    principal_id: principalIdSchema,
    display_name: z.string().min(1).max(160),
    signing_key_ref: z.string().min(1).max(255),
    signing_public_key: collaborationSshPublicKeySchema,
    status: z.enum(['requested', 'active', 'rejected', 'suspended', 'removed']),
    joined_at_event: collaborationIdentifierSchema.nullable(),
    extensions: extensionsSchema,
  })
  .strict();
export type MemberDefinitionV3 = z.infer<typeof memberDefinitionV3Schema>;

export const inviteDefinitionV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-invite/1'),
    invite_id: collaborationIdentifierSchema,
    principal_id: principalIdSchema,
    issued_by_principal_id: principalIdSchema,
    status: z.enum(['active', 'used', 'revoked']),
    issued_at: collaborationIsoTimeSchema,
    expires_at: collaborationIsoTimeSchema.nullable(),
    used_at_event: collaborationIdentifierSchema.nullable(),
    revoked_at_event: collaborationIdentifierSchema.nullable(),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((invite, context) => {
    if (
      invite.expires_at !== null &&
      Date.parse(invite.expires_at) <= Date.parse(invite.issued_at)
    )
      context.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'Invite expiry must be after issuance',
      });
    const validLifecycle =
      (invite.status === 'active' &&
        invite.used_at_event === null &&
        invite.revoked_at_event === null) ||
      (invite.status === 'used' &&
        invite.used_at_event !== null &&
        invite.revoked_at_event === null) ||
      (invite.status === 'revoked' &&
        invite.used_at_event === null &&
        invite.revoked_at_event !== null);
    if (!validLifecycle)
      context.addIssue({
        code: 'custom',
        message:
          'Invite status and lifecycle event references are inconsistent',
      });
  });
export type InviteDefinitionV3 = z.infer<typeof inviteDefinitionV3Schema>;

export const clientDefinitionSchema = z
  .object({
    format: z.literal('icarus.collaboration-client/1'),
    principal_id: principalIdSchema,
    client_id: collaborationIdentifierSchema,
    display_name: z.string().min(1).max(160),
    capabilities: z.array(collaborationIdentifierSchema).max(100),
    status: z.enum(['active', 'revoked']).default('active'),
    registered_at_event: collaborationIdentifierSchema,
    extensions: extensionsSchema,
  })
  .strict();
export type ClientDefinition = z.infer<typeof clientDefinitionSchema>;

export const executorDescriptorSchema = z
  .object({
    format: z.literal('icarus.collaboration-executor/1'),
    principal_id: principalIdSchema,
    executor_id: collaborationIdentifierSchema,
    display_name: z.string().min(1).max(160),
    kind: z.enum(['codex', 'workflow', 'run_once', 'external']),
    capabilities: z.array(collaborationIdentifierSchema).max(100),
    registered_at_event: collaborationIdentifierSchema,
    extensions: extensionsSchema,
  })
  .strict();
export type ExecutorDescriptor = z.infer<typeof executorDescriptorSchema>;

export const collaborationPermissionSchema = z.enum([
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
]);
export type CollaborationPermission = z.infer<
  typeof collaborationPermissionSchema
>;

export const permissionGrantSchema = z
  .object({
    format: z.literal('icarus.collaboration-permission-grant/1'),
    principal_id: principalIdSchema,
    grants: z.array(collaborationPermissionSchema).max(50),
    revision: z.number().int().positive(),
    updated_at_event: collaborationIdentifierSchema,
  })
  .strict()
  .refine((grant) => new Set(grant.grants).size === grant.grants.length, {
    message: 'permission grants must be unique',
  });
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

const fileBusinessRefsSchema = z
  .object({
    work_item_refs: z.array(collaborationIdentifierSchema).max(100).default([]),
    workflow_instance_refs: z
      .array(collaborationIdentifierSchema)
      .max(100)
      .default([]),
    discussion_refs: z
      .array(collaborationIdentifierSchema)
      .max(100)
      .default([]),
  })
  .strict();

export const fileMetadataSchema = z
  .object({
    format: z.literal('icarus.collaboration-file-metadata/1'),
    file_id: collaborationIdentifierSchema,
    original_filename: collaborationBasenameSchema,
    content_ref: collaborationBasenameSchema.nullable(),
    external_locator: z
      .object({
        type: z.enum(['https', 'object_store']),
        locator: z.string().min(1).max(2048),
      })
      .strict()
      .nullable()
      .default(null),
    media_type: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    sha256: collaborationSha256Schema,
    uploader_principal_id: principalIdSchema,
    uploader_client_id: collaborationIdentifierSchema,
    executor_id: collaborationIdentifierSchema.nullable().default(null),
    origin: actorOriginSchema,
    refs: fileBusinessRefsSchema,
    created_at: collaborationIsoTimeSchema,
    revision: z.number().int().positive().default(1),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((metadata, context) => {
    if (
      (metadata.content_ref === null) ===
      (metadata.external_locator === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'exactly one of content_ref and external_locator is required',
      });
  });
export type FileMetadata = z.infer<typeof fileMetadataSchema>;

export const progressUpdateSchema = z
  .object({
    format: z.literal('icarus.collaboration-progress-update/1'),
    update_id: collaborationIdentifierSchema,
    principal_id: principalIdSchema,
    summary: z.string().min(1).max(4000),
    completed: z.array(z.string().min(1).max(1000)).max(100).default([]),
    in_progress: z.array(z.string().min(1).max(1000)).max(100).default([]),
    next_steps: z.array(z.string().min(1).max(1000)).max(100).default([]),
    blockers: z.array(z.string().min(1).max(1000)).max(100).default([]),
    work_item_refs: z.array(collaborationIdentifierSchema).max(100).default([]),
    workflow_instance_refs: z
      .array(collaborationIdentifierSchema)
      .max(100)
      .default([]),
    artifact_refs: z
      .array(collaborationRelativePathSchema)
      .max(100)
      .default([]),
    origin: actorOriginSchema,
    actor_client_id: collaborationIdentifierSchema,
    executor_id: collaborationIdentifierSchema.nullable().default(null),
    created_at: collaborationIsoTimeSchema,
    extensions: extensionsSchema,
  })
  .strict();
export type ProgressUpdate = z.infer<typeof progressUpdateSchema>;

export const workItemStatusSchema = z.enum([
  'proposed',
  'open',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
]);
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

export const workItemSchema = z
  .object({
    format: z.literal('icarus.collaboration-work-item/1'),
    work_item_id: collaborationIdentifierSchema,
    type: z.enum(['task', 'issue', 'decision', 'milestone']),
    title: z.string().min(1).max(300),
    description: z.string().max(32_000),
    status: workItemStatusSchema,
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    creator_principal_id: principalIdSchema,
    owner_principal_id: principalIdSchema,
    preferred_executor_id: collaborationIdentifierSchema.nullable(),
    contributors: z.array(principalIdSchema).max(100),
    watchers: z.array(principalIdSchema).max(100).default([]),
    acceptance_criteria: z.array(z.string().min(1).max(2000)).max(100),
    labels: z.array(collaborationIdentifierSchema).max(100),
    due_at: collaborationIsoTimeSchema.nullable(),
    parent_id: collaborationIdentifierSchema.nullable(),
    blocked_by: z.array(collaborationIdentifierSchema).max(100),
    related_items: z.array(collaborationIdentifierSchema).max(100),
    primary_workflow_instance_id: collaborationIdentifierSchema.nullable(),
    assignment_status: z
      .enum(['accepted', 'pending', 'declined'])
      .default('accepted'),
    created_at: collaborationIsoTimeSchema,
    updated_at: collaborationIsoTimeSchema,
    closed_at: collaborationIsoTimeSchema.nullable(),
    revision: z.number().int().positive(),
    archived: z.boolean().default(false),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((item, context) => {
    for (const [key, ids] of [
      ['contributors', item.contributors],
      ['watchers', item.watchers],
      ['blocked_by', item.blocked_by],
      ['related_items', item.related_items],
    ] as const)
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be unique`,
        });
    if (
      item.parent_id === item.work_item_id ||
      item.blocked_by.includes(item.work_item_id)
    )
      context.addIssue({
        code: 'custom',
        message: 'a Work Item cannot parent or block itself',
      });
  });
export type WorkItem = z.infer<typeof workItemSchema>;

export const workItemProgressSchema = z
  .object({
    format: z.literal('icarus.collaboration-work-item-progress/1'),
    update_id: collaborationIdentifierSchema,
    work_item_id: collaborationIdentifierSchema,
    summary: z.string().min(1).max(4000),
    completed: z.array(z.string().min(1).max(1000)).max(100).default([]),
    next_steps: z.array(z.string().min(1).max(1000)).max(100).default([]),
    blockers: z.array(z.string().min(1).max(1000)).max(100).default([]),
    artifact_refs: z
      .array(collaborationRelativePathSchema)
      .max(100)
      .default([]),
    actor_principal_id: principalIdSchema,
    actor_client_id: collaborationIdentifierSchema,
    executor_id: collaborationIdentifierSchema.nullable().default(null),
    origin: actorOriginSchema,
    created_at: collaborationIsoTimeSchema,
    extensions: extensionsSchema,
  })
  .strict();
export type WorkItemProgress = z.infer<typeof workItemProgressSchema>;

export const discussionScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group') }).strict(),
  z
    .object({
      type: z.literal('work_item'),
      ref: collaborationIdentifierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('workflow_instance'),
      ref: collaborationIdentifierSchema,
    })
    .strict(),
  z
    .object({ type: z.literal('turn'), ref: collaborationIdentifierSchema })
    .strict(),
]);

export const discussionSchema = z
  .object({
    format: z.literal('icarus.collaboration-discussion/1'),
    thread_id: collaborationIdentifierSchema,
    title: z.string().min(1).max(300),
    created_by: principalIdSchema,
    scope: discussionScopeSchema,
    status: z.enum(['open', 'resolved']),
    created_at: collaborationIsoTimeSchema,
    resolved_at: collaborationIsoTimeSchema.nullable(),
    revision: z.number().int().positive(),
    extensions: extensionsSchema,
  })
  .strict();
export type Discussion = z.infer<typeof discussionSchema>;

export const discussionMessageSchema = z
  .object({
    format: z.literal('icarus.collaboration-message/1'),
    message_id: collaborationIdentifierSchema,
    thread_id: collaborationIdentifierSchema,
    author_principal_id: principalIdSchema,
    actor_client_id: collaborationIdentifierSchema,
    executor_id: collaborationIdentifierSchema.nullable().default(null),
    origin: actorOriginSchema,
    body: z.string().min(1).max(64_000),
    mentions: z.array(principalIdSchema).max(100).default([]),
    refs: z.array(collaborationRelativePathSchema).max(100).default([]),
    revision: z.number().int().positive(),
    tombstoned: z.boolean().default(false),
    created_at: collaborationIsoTimeSchema,
    updated_at: collaborationIsoTimeSchema,
    extensions: extensionsSchema,
  })
  .strict();
export type DiscussionMessage = z.infer<typeof discussionMessageSchema>;

export const timeoutPolicyV3Schema = z
  .object({
    start_timeout_ms: z.number().int().positive().nullable().default(null),
    execution_timeout_ms: z.number().int().positive().nullable().default(null),
    reminder_interval_ms: z.number().int().positive().nullable().default(null),
    on_timeout: z.literal('notify_only'),
  })
  .strict();
export type TimeoutPolicyV3 = z.infer<typeof timeoutPolicyV3Schema>;

export const stateAssigneeSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('principal'), principal_id: principalIdSchema })
    .strict(),
  z
    .object({
      type: z.literal('participant_slot'),
      slot: collaborationIdentifierSchema,
    })
    .strict(),
]);
export type StateAssignee = z.infer<typeof stateAssigneeSchema>;

const workflowTransitionSchema = z
  .object({
    outcome: collaborationIdentifierSchema,
    label: z.string().min(1).max(160),
    target_state: collaborationIdentifierSchema,
  })
  .strict();

export const machineDefinitionV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-machine/3'),
    initial_state: collaborationIdentifierSchema,
    states: z.record(
      collaborationIdentifierSchema,
      z
        .object({
          label: z.string().min(1).max(160),
          description: z.string().max(4000).default(''),
          assignee: stateAssigneeSchema.optional(),
          terminal: z.boolean(),
          timeout_policy: timeoutPolicyV3Schema.nullable().optional(),
          transitions: z.array(workflowTransitionSchema),
        })
        .strict(),
    ),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((machine, context) => {
    if (!machine.states[machine.initial_state])
      context.addIssue({
        code: 'custom',
        path: ['initial_state'],
        message: 'initial state does not exist',
      });
    for (const [stateId, state] of Object.entries(machine.states)) {
      if (state.terminal) {
        if (
          state.assignee ||
          state.timeout_policy ||
          state.transitions.length > 0
        )
          context.addIssue({
            code: 'custom',
            path: ['states', stateId],
            message:
              'terminal states cannot define assignee, timeout, or transitions',
          });
        continue;
      }
      if (!state.assignee)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId, 'assignee'],
          message: 'non-terminal states require an assignee',
        });
      if (state.transitions.length === 0)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId, 'transitions'],
          message: 'non-terminal states require at least one Outcome',
        });
      const outcomes = state.transitions.map(
        (transition) => transition.outcome,
      );
      if (new Set(outcomes).size !== outcomes.length)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId, 'transitions'],
          message: 'Outcome ids must be unique within a State',
        });
      for (const transition of state.transitions)
        if (!machine.states[transition.target_state])
          context.addIssue({
            code: 'custom',
            path: ['states', stateId, 'transitions'],
            message: `Outcome target does not exist: ${transition.target_state}`,
          });
    }
    if (machine.states[machine.initial_state]?.terminal)
      context.addIssue({
        code: 'custom',
        path: ['initial_state'],
        message: 'initial state cannot be terminal',
      });
    const visited = new Set<string>();
    const pending = [machine.initial_state];
    while (pending.length > 0) {
      const stateId = pending.pop()!;
      if (visited.has(stateId)) continue;
      visited.add(stateId);
      for (const transition of machine.states[stateId]?.transitions ?? [])
        pending.push(transition.target_state);
    }
    for (const stateId of Object.keys(machine.states))
      if (!visited.has(stateId))
        context.addIssue({
          code: 'custom',
          path: ['states', stateId],
          message: 'State is unreachable from the initial State',
        });
  });
export type MachineDefinitionV3 = z.infer<typeof machineDefinitionV3Schema>;

export const workflowLayoutSchema = z
  .object({
    format: z.literal('icarus.collaboration-workflow-layout/1'),
    view: z.enum(['free', 'participants']),
    nodes: z.record(
      collaborationIdentifierSchema,
      z
        .object({
          x: z.number().finite().min(-100_000).max(100_000),
          y: z.number().finite().min(-100_000).max(100_000),
        })
        .strict(),
    ),
    revision: z.number().int().positive(),
  })
  .strict();
export type WorkflowLayout = z.infer<typeof workflowLayoutSchema>;

export const workflowLaunchPolicySchema = z
  .object({
    group_admin: z.boolean(),
    work_item_owner: z.boolean(),
    principals: z.array(principalIdSchema).max(100),
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    format: z.literal('icarus.collaboration-workflow-definition/1'),
    definition_id: collaborationIdentifierSchema,
    name: z.string().min(1).max(240),
    description: z.string().max(4000),
    version: z.number().int().positive(),
    created_by_principal_id: principalIdSchema,
    published_by_principal_id: principalIdSchema.nullable(),
    status: z.enum(['draft', 'proposed', 'published', 'retired']),
    launch_policy: workflowLaunchPolicySchema,
    machine_ref: collaborationRelativePathSchema,
    layout_ref: collaborationRelativePathSchema,
    machine_hash: collaborationSha256Schema,
    layout_hash: collaborationSha256Schema,
    revision: z.number().int().positive(),
    created_at: collaborationIsoTimeSchema,
    updated_at: collaborationIsoTimeSchema,
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((definition, context) => {
    if (
      definition.status === 'published' &&
      definition.published_by_principal_id === null
    )
      context.addIssue({
        code: 'custom',
        path: ['published_by_principal_id'],
        message: 'published Definition requires a publisher',
      });
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const workflowScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group') }).strict(),
  z
    .object({
      type: z.literal('work_item'),
      work_item_id: collaborationIdentifierSchema,
    })
    .strict(),
]);

export const workflowInstanceSchema = z
  .object({
    format: z.literal('icarus.collaboration-workflow-instance/1'),
    instance_id: collaborationIdentifierSchema,
    definition_id: collaborationIdentifierSchema,
    definition_version: z.number().int().positive(),
    definition_hash: collaborationSha256Schema,
    scope: workflowScopeSchema,
    related_work_item_refs: z
      .array(collaborationIdentifierSchema)
      .max(100)
      .default([]),
    participant_bindings: z.record(
      collaborationIdentifierSchema,
      principalIdSchema,
    ),
    resolved_assignments: z.record(
      collaborationIdentifierSchema,
      principalIdSchema,
    ),
    work_item_status_mapping: z
      .record(collaborationIdentifierSchema, workItemStatusSchema)
      .default({}),
    lifecycle: z.enum([
      'draft',
      'ready',
      'running',
      'pausing',
      'paused',
      'closing',
      'closed',
      'recovery_required',
    ]),
    business_state: collaborationIdentifierSchema,
    active_turn_id: collaborationIdentifierSchema.nullable(),
    last_completed_turn_id: collaborationIdentifierSchema.nullable(),
    last_handoff_hash: collaborationSha256Schema.nullable(),
    epoch: z.number().int().positive(),
    revision: z.number().int().positive(),
    created_by_principal_id: principalIdSchema,
    created_at: collaborationIsoTimeSchema,
    updated_at: collaborationIsoTimeSchema,
    extensions: extensionsSchema,
  })
  .strict();
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;

export const executionModeV3Schema = z.enum([
  'manual',
  'assisted',
  'automatic',
]);
export type ExecutionModeV3 = z.infer<typeof executionModeV3Schema>;

export const stateExecutionSchema = z
  .object({
    format: z.literal('icarus.collaboration-state-execution/1'),
    instance_id: collaborationIdentifierSchema,
    state_id: collaborationIdentifierSchema,
    principal_id: principalIdSchema,
    mode: executionModeV3Schema,
    action_ref: collaborationRelativePathSchema.nullable(),
    action_hash: collaborationSha256Schema.nullable().default(null),
    prompt_hash: collaborationSha256Schema.nullable().default(null),
    published_at_event: collaborationIdentifierSchema,
    revision: z.number().int().positive(),
  })
  .strict()
  .superRefine((execution, context) => {
    const manual = execution.mode === 'manual';
    if (manual !== (execution.action_ref === null))
      context.addIssue({
        code: 'custom',
        path: ['action_ref'],
        message:
          'manual requires no Action; assisted/automatic require an Action',
      });
    if (manual && (execution.action_hash || execution.prompt_hash))
      context.addIssue({
        code: 'custom',
        message: 'manual execution cannot snapshot Action or Prompt hashes',
      });
    if (!manual && (!execution.action_hash || !execution.prompt_hash))
      context.addIssue({
        code: 'custom',
        message:
          'assisted/automatic execution requires Action and Prompt hashes',
      });
  });
export type StateExecution = z.infer<typeof stateExecutionSchema>;

export const actionDefinitionV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-action/1'),
    action_id: collaborationIdentifierSchema,
    name: z.string().min(1).max(240),
    owner_principal_id: principalIdSchema,
    version: z.number().int().positive(),
    kind: z.enum(['run_once', 'workflow', 'external']),
    adapter: collaborationIdentifierSchema.nullable().default(null),
    workflow_ref: collaborationIdentifierSchema.nullable().default(null),
    prompt_ref: collaborationRelativePathSchema,
    prompt_hash: collaborationSha256Schema,
    executor_policy: z.literal('principal_selected'),
    filesystem_access: z.enum(['read_only', 'workspace_write']),
    result_schema: z
      .object({
        ref: collaborationIdentifierSchema,
        schema: z.record(z.string(), z.unknown()).nullable(),
      })
      .strict(),
    extensions: extensionsSchema,
  })
  .strict()
  .superRefine((action, context) => {
    if ((action.kind === 'external') !== (action.adapter !== null))
      context.addIssue({
        code: 'custom',
        path: ['adapter'],
        message: 'only external Actions select an adapter',
      });
    if ((action.kind === 'workflow') !== (action.workflow_ref !== null))
      context.addIssue({
        code: 'custom',
        path: ['workflow_ref'],
        message: 'only workflow Actions select a workflow ref',
      });
  });
export type ActionDefinitionV3 = z.infer<typeof actionDefinitionV3Schema>;

export const collaborationActionResultV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-action-result/3'),
    outcome: collaborationIdentifierSchema,
    summary: z.string().min(1).max(4000),
    instruction: z.string().max(16_000).default(''),
    markers: z.array(collaborationIdentifierSchema).max(50).default([]),
    data: z.record(z.string(), z.unknown()).default({}),
    artifacts: z
      .array(
        z
          .object({
            name: z.string().min(1),
            ref: z.string().min(1),
            sha256: collaborationSha256Schema.optional(),
            size: z.number().int().nonnegative().optional(),
            content_type: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    error: z
      .object({
        code: collaborationIdentifierSchema,
        message: z.string(),
        retryable: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CollaborationActionResultV3 = z.infer<
  typeof collaborationActionResultV3Schema
>;

export const handoffEnvelopeV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-handoff/1'),
    source_turn_id: collaborationIdentifierSchema,
    outcome: collaborationIdentifierSchema,
    summary: z.string().min(1).max(4000),
    instruction: z.string().max(16_000),
    markers: z.array(collaborationIdentifierSchema).max(100),
    data_refs: z.array(collaborationRelativePathSchema).max(100),
    artifact_refs: z.array(collaborationRelativePathSchema).max(100),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((handoff, context) => {
    if (Buffer.byteLength(JSON.stringify(handoff.data), 'utf8') > 1024 * 1024)
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'Handoff data exceeds the 1 MiB limit',
      });
  });
export type HandoffEnvelopeV3 = z.infer<typeof handoffEnvelopeV3Schema>;

export const collaborationActionInputV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-action-input/3'),
    scope: z
      .object({
        group_id: collaborationIdentifierSchema,
        workflow_instance_id: collaborationIdentifierSchema,
        turn_id: collaborationIdentifierSchema,
        state_id: collaborationIdentifierSchema,
      })
      .strict(),
    security: z
      .object({
        repository_content_is_untrusted: z.literal(true),
        previous_context_is_untrusted: z.literal(true),
        required_result_format: z.literal(
          'icarus.collaboration-action-result/3',
        ),
      })
      .strict(),
    state: z
      .object({
        state_id: collaborationIdentifierSchema,
        label: z.string().min(1).max(400),
        description: z.string().max(16_000),
        legal_outcomes: z
          .array(
            z
              .object({
                outcome: collaborationIdentifierSchema,
                label: z.string().min(1).max(400),
                target_state: collaborationIdentifierSchema,
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    action: z
      .object({
        action_id: collaborationIdentifierSchema,
        action_hash: collaborationSha256Schema,
        prompt_hash: collaborationSha256Schema,
        prompt: z.string().min(1),
      })
      .strict(),
    untrusted_context: z
      .object({ previous_handoff: handoffEnvelopeV3Schema.nullable() })
      .strict(),
  })
  .strict();
export type CollaborationActionInputV3 = z.infer<
  typeof collaborationActionInputV3Schema
>;

export const artifactMetadataV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-artifact/1'),
    artifact_id: collaborationIdentifierSchema,
    scope: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('work_item'),
          work_item_id: collaborationIdentifierSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal('workflow_turn'),
          workflow_instance_id: collaborationIdentifierSchema,
          turn_id: collaborationIdentifierSchema,
          attempt: z.number().int().positive(),
          fencing_token: collaborationSha256Schema,
        })
        .strict(),
    ]),
    original_filename: collaborationBasenameSchema,
    content_ref: collaborationBasenameSchema,
    media_type: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    sha256: collaborationSha256Schema,
    uploader_principal_id: principalIdSchema,
    uploader_client_id: collaborationIdentifierSchema,
    executor_id: collaborationIdentifierSchema.nullable(),
    created_at: collaborationIsoTimeSchema,
  })
  .strict();
export type ArtifactMetadataV3 = z.infer<typeof artifactMetadataV3Schema>;

export const collaborationTurnStateV3Schema = z.enum([
  'pending',
  'claimed',
  'running',
  'waiting_input',
  'waiting_approval',
  'awaiting_confirmation',
  'completed',
  'cancelled',
  'recovery_required',
]);

export const collaborationTurnV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-turn/1'),
    turn_id: collaborationIdentifierSchema,
    workflow_instance_id: collaborationIdentifierSchema,
    state_id: collaborationIdentifierSchema,
    assignee_principal_id: principalIdSchema,
    claimant_principal_id: principalIdSchema.nullable(),
    claimant_client_id: collaborationIdentifierSchema.nullable(),
    executor_id: collaborationIdentifierSchema.nullable(),
    attempt: z.number().int().positive(),
    fencing_token: collaborationSha256Schema.nullable(),
    execution_mode: executionModeV3Schema,
    state: collaborationTurnStateV3Schema,
    action_ref: collaborationRelativePathSchema.nullable(),
    action_hash: collaborationSha256Schema.nullable(),
    prompt_hash: collaborationSha256Schema.nullable(),
    input_hash: collaborationSha256Schema,
    idempotency_key: collaborationSha256Schema,
    incoming_handoff: handoffEnvelopeV3Schema.nullable(),
    incoming_handoff_hash: collaborationSha256Schema.nullable(),
    timeout_policy_snapshot: timeoutPolicyV3Schema.nullable(),
    start_deadline_at: collaborationIsoTimeSchema.nullable(),
    execution_deadline_at: collaborationIsoTimeSchema.nullable(),
    deadline_snapshot_hash: collaborationSha256Schema,
    created_at: collaborationIsoTimeSchema,
    started_at: collaborationIsoTimeSchema.nullable(),
    completed_at: collaborationIsoTimeSchema.nullable(),
    outcome: collaborationIdentifierSchema.nullable(),
    handoff: handoffEnvelopeV3Schema.nullable(),
    handoff_hash: collaborationSha256Schema.nullable(),
    executor_result: collaborationActionResultV3Schema.nullable(),
    executor_result_hash: collaborationSha256Schema.nullable(),
    completion_hash: collaborationSha256Schema.nullable(),
    recovery_reason: z.string().max(4000).nullable(),
  })
  .strict();
export type CollaborationTurnV3 = z.infer<typeof collaborationTurnV3Schema>;

export const collaborationAggregateTypeSchema = z.enum([
  'group',
  'invite',
  'membership',
  'workspace',
  'work_item',
  'discussion',
  'workflow_definition',
  'workflow_instance',
]);
export type CollaborationAggregateType = z.infer<
  typeof collaborationAggregateTypeSchema
>;

export const collaborationEventTypesV3 = [
  'group_initialized',
  'group_settings_updated',
  'group_archived',
  'group_reopened',
  'invite_issued',
  'invite_revoked',
  'membership_requested',
  'membership_rejected',
  'member_registered',
  'member_suspended',
  'member_reactivated',
  'member_removed',
  'client_registered',
  'client_revoked',
  'executor_registered',
  'executor_revoked',
  'permission_granted',
  'permission_revoked',
  'progress_update_posted',
  'shared_file_published',
  'shared_file_revised',
  'principal_file_published',
  'action_published',
  'action_revised',
  'work_item_created',
  'work_item_details_updated',
  'work_item_assignment_changed',
  'work_item_assignment_acknowledged',
  'work_item_assignment_declined',
  'work_item_status_changed',
  'work_item_progress_posted',
  'work_item_relation_changed',
  'work_item_archived',
  'discussion_created',
  'message_posted',
  'message_revised',
  'message_tombstoned',
  'discussion_resolved',
  'discussion_reopened',
  'workflow_definition_proposed',
  'workflow_definition_published',
  'workflow_definition_retired',
  'workflow_layout_updated',
  'workflow_instance_created',
  'workflow_instance_started',
  'workflow_instance_paused',
  'workflow_instance_resumed',
  'workflow_instance_closed',
  'workflow_state_assignee_changed',
  'state_execution_published',
  'state_execution_revised',
  'state_execution_withdrawn',
  'turn_created',
  'turn_started',
  'action_dispatched',
  'action_waiting_input',
  'action_waiting_approval',
  'action_completed',
  'turn_timeout_observed',
  'turn_completed',
  'turn_cancelled',
  'turn_recovery_requested',
  'turn_recovered',
] as const;
export type CollaborationEventTypeV3 =
  (typeof collaborationEventTypesV3)[number];

export const collaborationEventV3Schema = z
  .object({
    format: z.literal('icarus.collaboration-event/3'),
    protocol_version: z.literal(V3_COLLABORATION_PROTOCOL_VERSION),
    group_id: collaborationIdentifierSchema,
    event_id: collaborationIdentifierSchema,
    aggregate_type: collaborationAggregateTypeSchema,
    aggregate_id: collaborationIdentifierSchema,
    aggregate_revision: z.number().int().positive(),
    previous_event_hash: collaborationSha256Schema.nullable(),
    event_type: z.enum(collaborationEventTypesV3),
    actor: z
      .object({
        principal_id: principalIdSchema,
        client_id: collaborationIdentifierSchema,
        executor_id: collaborationIdentifierSchema.nullable(),
      })
      .strict(),
    occurred_at: collaborationIsoTimeSchema,
    causation_id: collaborationIdentifierSchema.nullable(),
    correlation_id: collaborationIdentifierSchema,
    payload_hash: collaborationSha256Schema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      (event.aggregate_revision === 1) !==
      (event.previous_event_hash === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['previous_event_hash'],
        message:
          'aggregate revision 1 requires null previous hash; later revisions require a hash',
      });
  });
export type CollaborationEventV3 = z.infer<typeof collaborationEventV3Schema>;

export const observerSubscriptionSchema = z
  .object({
    format: z.literal('icarus.collaboration-subscription/1'),
    group_id: collaborationIdentifierSchema,
    remote_url: z.string().min(1).max(2048),
    subscription_mode: z.enum(['observer', 'member']),
    poll_interval_ms: z.number().int().min(10_000).max(86_400_000),
    last_verified_head: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .nullable(),
    notifications_enabled: z.boolean(),
    created_at: collaborationIsoTimeSchema,
  })
  .strict();
export type ObserverSubscription = z.infer<typeof observerSubscriptionSchema>;

export function parseV3ProtocolVersion(value: unknown): 3 {
  if (value !== V3_COLLABORATION_PROTOCOL_VERSION)
    throw new CollaborationProtocolError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `Collaboration protocol ${String(value)} is unsupported; only v3 is current`,
    );
  return V3_COLLABORATION_PROTOCOL_VERSION;
}
