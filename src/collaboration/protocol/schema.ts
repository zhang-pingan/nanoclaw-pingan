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
      !value.split('/').some((segment) => segment === '..' || segment === ''),
    'must be a normalized repository-relative path',
  );

export const collaborationDataPathSchema = z
  .string()
  .min('data/x'.length)
  .max(512)
  .refine((value) => value.startsWith('data/'), 'must be below data/')
  .refine((value) => !value.includes('\\'), 'must use forward slashes')
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'must not contain control characters',
  )
  .refine(
    (value) =>
      value
        .split('/')
        .every(
          (segment) =>
            segment !== '' &&
            segment !== '.' &&
            segment !== '..' &&
            segment.toLowerCase() !== '.git',
        ),
    'must be a normalized safe data path',
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
    const fenceFields = [
      payload.turn_id,
      payload.attempt,
      payload.fencing_token,
    ];
    const populated = fenceFields.filter((value) => value !== undefined).length;
    if (populated !== 0 && populated !== fenceFields.length)
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
    format: z.literal('icarus.agent-group/1'),
    protocol_version: z.number().int(),
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
  .superRefine((value, context) => {
    if (value.protocol_version !== COLLABORATION_PROTOCOL_VERSION) {
      context.addIssue({
        code: 'custom',
        path: ['protocol_version'],
        message: `unsupported protocol version ${String(value.protocol_version)}`,
      });
    }
    const roles = value.required_roles.map((entry) => entry.role);
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
    format: z.literal('icarus.agent-group-role/1'),
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
    allowed_transitions: z.array(identifier).min(1),
    executor_requirements: z
      .object({
        capability: identifier,
        interaction: z.enum(['headless', 'visible_session']),
      })
      .strict(),
  })
  .strict();
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

export const memberDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-member/1'),
    principal_id: identifier,
    signing_key_ref: z.string().min(1).max(255),
    signing_public_key: z
      .string()
      .min(32)
      .max(16_384)
      .regex(sshPublicKey, 'must be a single-line OpenSSH public key'),
    agent_id: identifier,
    capabilities: z.array(identifier).min(1),
    registered_at_event: identifier,
  })
  .strict();
export type MemberDefinition = z.infer<typeof memberDefinitionSchema>;

export const roleClaimSchema = z
  .object({
    format: z.literal('icarus.agent-group-role-claim/1'),
    role: identifier,
    principal_id: identifier,
    agent_id: identifier,
    claimed_at_event: identifier,
  })
  .strict();
export type RoleClaim = z.infer<typeof roleClaimSchema>;

const transitionSchema = z
  .object({
    id: identifier,
    actor_role: identifier,
    action_ref: relativeRepositoryPath,
    outcomes: z.record(identifier, identifier),
  })
  .strict();

export const machineDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-machine/1'),
    initial_state: identifier,
    states: z.record(
      identifier,
      z
        .object({
          terminal: z.boolean().optional().default(false),
          transitions: z.array(transitionSchema).optional().default([]),
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
    const transitionIds = new Set<string>();
    for (const [stateId, state] of Object.entries(machine.states)) {
      if (state.terminal && state.transitions.length > 0)
        context.addIssue({
          code: 'custom',
          path: ['states', stateId],
          message: 'terminal states cannot define transitions',
        });
      for (const transition of state.transitions) {
        if (transitionIds.has(transition.id))
          context.addIssue({
            code: 'custom',
            path: ['states', stateId, 'transitions'],
            message: `duplicate transition id ${transition.id}`,
          });
        transitionIds.add(transition.id);
        for (const destination of Object.values(transition.outcomes)) {
          if (!machine.states[destination])
            context.addIssue({
              code: 'custom',
              path: ['states', stateId, 'transitions', transition.id],
              message: `outcome state ${destination} does not exist`,
            });
        }
      }
    }
  });
export type MachineDefinition = z.infer<typeof machineDefinitionSchema>;

export const actionDefinitionSchema = z
  .object({
    format: z.literal('icarus.agent-group-action/1'),
    action_id: identifier,
    kind: z.enum(['run_once', 'workflow', 'external']),
    adapter: identifier.optional(),
    input: z
      .object({
        prompt_ref: relativeRepositoryPath,
        workspace_ref: identifier.optional(),
        workflow_ref: identifier.optional(),
      })
      .strict(),
    requirements: z
      .object({
        capability: identifier,
        interaction: z.enum(['headless', 'visible_session']),
        filesystem_access: filesystemAccessSchema,
      })
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
        message: 'workflow actions require a local workflow_ref',
      });
  });
export type ActionDefinition = z.infer<typeof actionDefinitionSchema>;

export const collaborationEventTypes = [
  'group_initialized',
  'member_registered',
  'role_claimed',
  'role_released',
  'group_ready',
  'group_started',
  'group_pause_requested',
  'group_paused',
  'group_resumed',
  'group_close_requested',
  'group_closed',
  'turn_created',
  'turn_claimed',
  'action_dispatched',
  'action_waiting_input',
  'action_waiting_approval',
  'action_succeeded',
  'action_failed',
  'action_cancelled',
  'data_updated',
  'artifact_published',
  'state_transitioned',
  'stalled_turn_recovery_requested',
  'turn_recovered',
  'protocol_recovery',
] as const;
export type CollaborationEventType = (typeof collaborationEventTypes)[number];

export const collaborationEventSchema = z
  .object({
    format: z.literal('icarus.agent-group-event/1'),
    protocol_version: z.number().int(),
    group_id: identifier,
    event_id: identifier,
    epoch: z.number().int().positive(),
    sequence: z.number().int().positive(),
    event_type: z.enum(collaborationEventTypes),
    actor: z
      .object({
        principal_id: identifier,
        agent_id: identifier,
      })
      .strict(),
    expected: z
      .object({ state_revision: z.number().int().nonnegative() })
      .strict(),
    payload: z.record(z.string(), z.unknown()),
    occurred_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.protocol_version !== COLLABORATION_PROTOCOL_VERSION)
      context.addIssue({
        code: 'custom',
        path: ['protocol_version'],
        message: `unsupported protocol version ${String(event.protocol_version)}`,
      });
  });
export type CollaborationEvent = z.infer<typeof collaborationEventSchema>;

export interface CollaborationRepositoryDefinition {
  readonly group: GroupDefinition;
  readonly machine: MachineDefinition;
  readonly roles: Readonly<Record<string, RoleDefinition>>;
  readonly actions: Readonly<Record<string, ActionDefinition>>;
}

export function parseProtocolVersion(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    Number(value) !== COLLABORATION_PROTOCOL_VERSION
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      `Collaboration protocol version is unsupported: ${String(value)}`,
    );
  return Number(value);
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
  for (const [stateId, state] of Object.entries(machine.states)) {
    for (const transition of state.transitions) {
      const role = roles[transition.actor_role];
      if (!role)
        throw new Error(
          `Transition ${transition.id} in ${stateId} references missing role ${transition.actor_role}`,
        );
      if (!role.allowed_transitions.includes(transition.id))
        throw new Error(
          `Role ${transition.actor_role} does not allow transition ${transition.id}`,
        );
      const actionId = transition.action_ref
        .replace(/^actions\//, '')
        .replace(/\.yaml$/, '');
      if (!actions[actionId])
        throw new Error(
          `Transition ${transition.id} references missing action ${transition.action_ref}`,
        );
    }
  }
  return { group, machine, roles, actions };
}

export { identifier, relativeRepositoryPath, sha256 };
