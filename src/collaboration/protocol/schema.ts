import { z } from 'zod';

import {
  COLLABORATION_CONTROL_BRANCH,
  COLLABORATION_PROTOCOL_VERSION,
  CollaborationProtocolError,
} from './version.js';

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const sshPublicKey =
  /^(?:ssh-ed25519|ecdsa-sha2-[A-Za-z0-9@._+-]+|sk-ssh-[A-Za-z0-9@._+-]+) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,1024})?$/;
const relativeRepositoryPath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '..' || segment === ''),
    'must be a normalized repository-relative path',
  );

export const MAX_COLLABORATION_HANDOFF_DATA_BYTES = 1024 * 1024;

export const collaborationDataPathSchema = relativeRepositoryPath.refine(
  (value) => value.startsWith('data/'),
  'must be below data/',
);
export const collaborationArtifactPathSchema = relativeRepositoryPath.refine(
  (value) => /^artifacts\/[^/]+\/[^/]+$/u.test(value),
  'must be a turn-scoped artifact path',
);

export const dataUpdatePayloadSchema = z
  .object({
    path: collaborationDataPathSchema,
    encoding: z.literal('utf-8'),
    content_sha256: sha256,
    size_bytes: z.number().int().nonnegative(),
    media_type: z.string().min(1).max(160).optional(),
    turn_id: identifier.optional(),
    attempt: z.number().int().positive().optional(),
    fencing_token: sha256.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const values = [payload.turn_id, payload.attempt, payload.fencing_token];
    const populated = values.filter((value) => value !== undefined).length;
    if (populated !== 0 && populated !== values.length)
      context.addIssue({
        code: 'custom',
        message:
          'turn_id, attempt, and fencing_token must be provided together',
      });
  });
export type DataUpdatePayload = z.infer<typeof dataUpdatePayloadSchema>;

export const filesystemAccessSchema = z.enum(['read_only', 'workspace_write']);
export type FilesystemAccess = z.infer<typeof filesystemAccessSchema>;

export const groupDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group/2'),
    protocol_version: z.literal(COLLABORATION_PROTOCOL_VERSION),
    group_id: identifier,
    name: z.string().min(1).max(240),
    creator: z
      .object({
        principal_id: identifier,
        signing_key_ref: z.string().min(1).max(255),
      })
      .strict(),
    control_branch: z.literal(COLLABORATION_CONTROL_BRANCH),
    machine_ref: relativeRepositoryPath,
    required_roles: z
      .array(
        z
          .object({
            role: identifier,
            min_members: z.number().int().positive(),
            max_members: z.number().int().positive(),
          })
          .strict()
          .refine((value) => value.max_members >= value.min_members, {
            message: 'max_members must be at least min_members',
          }),
      )
      .min(1),
    lifecycle_policy: z
      .object({
        active_turn_pause: z.literal('drain'),
        stalled_turn_recovery: z.literal('creator_command'),
      })
      .strict(),
  })
  .strict()
  .superRefine((group, context) => {
    const roles = group.required_roles.map((entry) => entry.role);
    if (new Set(roles).size !== roles.length)
      context.addIssue({
        code: 'custom',
        path: ['required_roles'],
        message: 'required roles must be unique',
      });
  });
export type GroupDefinition = z.infer<typeof groupDefinitionSchema>;

export const roleDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-role/2'),
    role: identifier,
    display_name: z.string().min(1).max(120),
    cardinality: z
      .object({
        min: z.number().int().positive(),
        max: z.number().int().positive(),
      })
      .strict()
      .refine((value) => value.max >= value.min, {
        message: 'role cardinality max must be at least min',
      }),
    required_capabilities: z.array(identifier).default([]),
    owned_states: z.array(identifier),
  })
  .strict();
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

export const memberDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-member/2'),
    principal_id: identifier,
    signing_key_ref: z.string().min(1).max(255),
    signing_public_key: z.string().min(32).max(16_384).regex(sshPublicKey),
    agent_id: identifier,
    capabilities: z.array(identifier),
    registered_at_event: identifier,
  })
  .strict();
export type MemberDefinition = z.infer<typeof memberDefinitionSchema>;

export const roleClaimSchema = z
  .object({
    format: z.literal('icarus.agent-group-role-claim/2'),
    role: identifier,
    principal_id: identifier,
    agent_id: identifier,
    claimed_at_event: identifier,
  })
  .strict();
export type RoleClaim = z.infer<typeof roleClaimSchema>;

const transitionSchema = z
  .object({
    outcome: identifier,
    label: z.string().min(1).max(160).optional(),
    target_state: identifier,
  })
  .strict();

export const timeoutPolicySchema = z
  .object({
    start_timeout_ms: z.number().int().positive().nullable().default(null),
    execution_timeout_ms: z.number().int().positive().nullable().default(null),
    reminder_interval_ms: z.number().int().positive().nullable().default(null),
    on_timeout: z.literal('notify_only'),
  })
  .strict();
export type TimeoutPolicy = z.infer<typeof timeoutPolicySchema>;

export const machineDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-machine/2'),
    initial_state: identifier,
    states: z.record(
      identifier,
      z
        .object({
          label: z.string().min(1).max(160),
          description: z.string().max(2_000).optional(),
          owner_role: identifier.optional(),
          terminal: z.boolean().default(false),
          transitions: z.array(transitionSchema).default([]),
          timeout_policy: timeoutPolicySchema.nullable().optional(),
        })
        .strict(),
    ),
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
      if (state.terminal && (state.owner_role || state.transitions.length))
        context.addIssue({
          code: 'custom',
          path: ['states', stateId],
          message: 'terminal states cannot own work or define transitions',
        });
      if (state.terminal && state.timeout_policy)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId, 'timeout_policy'],
          message: 'terminal states cannot define a timeout policy',
        });
      if (!state.terminal && !state.owner_role)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId, 'owner_role'],
          message: 'non-terminal states require owner_role',
        });
      if (!state.terminal && state.transitions.length === 0)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId],
          message: 'non-terminal states require outcomes',
        });
      const outcomes = state.transitions.map(
        (transition) => transition.outcome,
      );
      if (new Set(outcomes).size !== outcomes.length)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId, 'transitions'],
          message: 'outcomes must be unique within a state',
        });
      for (const transition of state.transitions)
        if (!machine.states[transition.target_state])
          context.addIssue({
            code: 'custom',
            path: ['states', stateId, 'transitions'],
            message: `outcome target ${transition.target_state} does not exist`,
          });
    }
  });
export type MachineDefinition = z.infer<typeof machineDefinitionSchema>;

export const machineLayoutDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-machine-layout/1'),
    view: z.enum(['free', 'roles']).default('free'),
    nodes: z.record(
      identifier,
      z
        .object({
          x: z.number().finite().min(-100_000).max(100_000),
          y: z.number().finite().min(-100_000).max(100_000),
        })
        .strict(),
    ),
  })
  .strict();
export type MachineLayoutDefinition = z.infer<
  typeof machineLayoutDefinitionSchema
>;

export const executionModeSchema = z.enum(['manual', 'assisted', 'automatic']);
export type StateExecutionMode = z.infer<typeof executionModeSchema>;

export const stateImplementationSchema = z
  .object({
    format: z.literal('icarus.agent-group-state-implementation/2'),
    role: identifier,
    state_id: identifier,
    owner: z
      .object({ principal_id: identifier, agent_id: identifier })
      .strict(),
    mode: executionModeSchema,
    action_ref: relativeRepositoryPath.nullable(),
    published_at_event: identifier,
  })
  .strict()
  .superRefine((implementation, context) => {
    if (implementation.mode === 'manual' && implementation.action_ref !== null)
      context.addIssue({
        code: 'custom',
        path: ['action_ref'],
        message: 'manual implementation cannot reference an action',
      });
    if (implementation.mode !== 'manual' && implementation.action_ref === null)
      context.addIssue({
        code: 'custom',
        path: ['action_ref'],
        message: 'assisted and automatic implementations require an action',
      });
  });
export type StateImplementation = z.infer<typeof stateImplementationSchema>;

export const actionDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-action/2'),
    action_id: identifier,
    role: identifier,
    state_id: identifier,
    kind: z.enum(['run_once', 'workflow', 'external']),
    adapter: identifier.optional(),
    input: z
      .object({
        prompt_ref: relativeRepositoryPath,
        workflow_ref: identifier.optional(),
      })
      .strict(),
    requirements: z
      .object({ filesystem_access: filesystemAccessSchema })
      .strict(),
    result_schema: z
      .object({
        ref: identifier,
        schema: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.kind === 'external' && !action.adapter)
      context.addIssue({
        code: 'custom',
        path: ['adapter'],
        message: 'external actions require an adapter',
      });
    if (action.kind !== 'external' && action.adapter)
      context.addIssue({
        code: 'custom',
        path: ['adapter'],
        message: 'only external actions may select an adapter',
      });
    if (action.kind === 'workflow' && !action.input.workflow_ref)
      context.addIssue({
        code: 'custom',
        path: ['input', 'workflow_ref'],
        message: 'workflow actions require workflow_ref',
      });
    if (action.kind !== 'workflow' && action.input.workflow_ref)
      context.addIssue({
        code: 'custom',
        path: ['input', 'workflow_ref'],
        message: 'only workflow actions may use workflow_ref',
      });
  });
export type ActionDefinition = z.infer<typeof actionDefinitionSchema>;

export const artifactMetadataSchema = z
  .object({
    artifact_id: identifier,
    turn_id: identifier,
    original_name: z.string().min(1).max(255),
    repository_path: collaborationArtifactPathSchema,
    sha256,
    size: z.number().int().nonnegative(),
    content_type: z.string().min(1).max(255),
    uploaded_by_principal_id: identifier,
    uploaded_by_agent_id: identifier,
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;

export const handoffEnvelopeSchema = z
  .object({
    format: z.literal('icarus.agent-group-handoff/2'),
    source_turn_id: identifier,
    outcome: identifier,
    summary: z.string().min(1).max(4000),
    instruction: z.string().max(16_000).default(''),
    markers: z.array(identifier).max(50).default([]),
    data_refs: z.array(collaborationDataPathSchema).max(50).default([]),
    artifact_refs: z.array(collaborationArtifactPathSchema).max(20).default([]),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((handoff, context) => {
    if (
      Buffer.byteLength(JSON.stringify(handoff.data), 'utf8') >
      MAX_COLLABORATION_HANDOFF_DATA_BYTES
    )
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'Handoff data exceeds the 1 MiB limit',
      });
  });
export type HandoffEnvelope = z.infer<typeof handoffEnvelopeSchema>;

export const collaborationEventTypes = [
  'group_initialized',
  'machine_revised',
  'machine_layout_updated',
  'member_registered',
  'role_claimed',
  'role_released',
  'state_implementation_published',
  'state_implementation_revised',
  'state_implementation_withdrawn',
  'group_started',
  'group_pause_requested',
  'group_paused',
  'group_resumed',
  'group_close_requested',
  'group_closed',
  'turn_created',
  'turn_started',
  'action_dispatched',
  'action_waiting_input',
  'action_waiting_approval',
  'action_completed',
  'turn_completed',
  'turn_cancelled',
  'turn_recovery_requested',
  'turn_recovered',
  'turn_timeout_observed',
  'data_updated',
  'protocol_recovery',
] as const;
export type CollaborationEventType = (typeof collaborationEventTypes)[number];

export const collaborationEventSchema = z
  .object({
    format: z.literal('icarus.agent-group-event/2'),
    protocol_version: z.literal(COLLABORATION_PROTOCOL_VERSION),
    group_id: identifier,
    event_id: identifier,
    epoch: z.number().int().positive(),
    sequence: z.number().int().positive(),
    event_type: z.enum(collaborationEventTypes),
    actor: z
      .object({ principal_id: identifier, agent_id: identifier })
      .strict(),
    expected: z
      .object({ state_revision: z.number().int().nonnegative() })
      .strict(),
    payload: z.record(z.string(), z.unknown()),
    occurred_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CollaborationEvent = z.infer<typeof collaborationEventSchema>;

export interface CollaborationRepositoryDefinition {
  readonly group: GroupDefinition;
  readonly machine: MachineDefinition;
  readonly roles: Readonly<Record<string, RoleDefinition>>;
  readonly actions: Readonly<Record<string, ActionDefinition>>;
  readonly implementations: Readonly<Record<string, StateImplementation>>;
  readonly layout?: MachineLayoutDefinition | null;
}

export function parseProtocolVersion(value: unknown): number {
  if (value !== COLLABORATION_PROTOCOL_VERSION)
    throw new CollaborationProtocolError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `Collaboration protocol version is unsupported: ${String(value)}`,
    );
  return COLLABORATION_PROTOCOL_VERSION;
}

export function validateRepositoryDefinition(
  input: CollaborationRepositoryDefinition,
): CollaborationRepositoryDefinition {
  const group = groupDefinitionSchema.parse(input.group);
  const machine = machineDefinitionSchema.parse(input.machine);
  const roles = Object.fromEntries(
    Object.entries(input.roles).map(([id, role]) => [
      id,
      roleDefinitionSchema.parse(role),
    ]),
  );
  const actions = Object.fromEntries(
    Object.entries(input.actions).map(([id, action]) => [
      id,
      actionDefinitionSchema.parse(action),
    ]),
  );
  const implementations = Object.fromEntries(
    Object.entries(input.implementations).map(([id, value]) => [
      id,
      stateImplementationSchema.parse(value),
    ]),
  );
  const layout = input.layout
    ? machineLayoutDefinitionSchema.parse(input.layout)
    : null;
  const required = new Map(
    group.required_roles.map((role) => [role.role, role]),
  );
  for (const [roleId, requirement] of required) {
    const role = roles[roleId];
    if (!role)
      throw new Error(`Required role definition is missing: ${roleId}`);
    if (
      role.cardinality.min !== requirement.min_members ||
      role.cardinality.max !== requirement.max_members
    )
      throw new Error(
        `Role cardinality disagrees with group definition: ${roleId}`,
      );
  }
  const ownership = new Map<string, string[]>();
  for (const [stateId, state] of Object.entries(machine.states)) {
    if (state.terminal) continue;
    const role = state.owner_role ? roles[state.owner_role] : null;
    if (!role)
      throw new Error(`State ${stateId} references a missing owner role`);
    if (role.cardinality.max !== 1)
      throw new Error(
        `State-owning role ${role.role} must have max cardinality 1 in protocol v2`,
      );
    ownership.set(role.role, [...(ownership.get(role.role) ?? []), stateId]);
  }
  for (const role of Object.values(roles)) {
    const expected = [...(ownership.get(role.role) ?? [])].sort();
    const actual = [...role.owned_states].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error(
        `Role owned_states disagrees with machine definition: ${role.role}`,
      );
  }
  for (const [stateId, implementation] of Object.entries(implementations)) {
    if (implementation.state_id !== stateId)
      throw new Error(`Implementation key disagrees with state: ${stateId}`);
    const state = machine.states[stateId];
    if (!state || state.terminal || state.owner_role !== implementation.role)
      throw new Error(
        `Implementation ownership is invalid for state ${stateId}`,
      );
    if (implementation.action_ref) {
      const action = actions[implementation.action_ref];
      if (!action)
        throw new Error(
          `Implementation references missing action ${implementation.action_ref}`,
        );
      if (action.role !== implementation.role || action.state_id !== stateId)
        throw new Error(`Action ownership is invalid for state ${stateId}`);
    }
  }
  return { group, machine, roles, actions, implementations, layout };
}

export { identifier, relativeRepositoryPath, sha256 };
