import { describe, expect, it } from 'vitest';

import { validateRepositoryDefinition } from '../../src/collaboration/protocol/index.js';
import {
  buildCollaborationCreateRequest,
  buildCollaborationJoinRequest,
  defaultCollaborationCreateDraft,
} from './collaboration-definition.js';

function build(draft = defaultCollaborationCreateDraft()) {
  return buildCollaborationCreateRequest({
    remoteUrl: '/tmp/collaboration.git',
    name: 'Multi-role group',
    signingKeyPath: '/tmp/alice-key',
    draft,
  });
}

describe('Collaboration create request builder', () => {
  it('preserves multiple roles, actions, states, and a cyclic FSM', () => {
    const request = build();

    expect(request.initialRole).toBe('developer');
    expect(request).not.toHaveProperty('principalId');
    expect(request).not.toHaveProperty('agentId');
    expect(request.capabilities).toEqual(['coding_task', 'visible_session']);
    expect(Object.keys(request.roles)).toEqual(['developer', 'reviewer']);
    expect(Object.keys(request.actions)).toEqual(['implement', 'review']);
    expect(Object.keys(request.machine.states)).toEqual([
      'development',
      'review',
    ]);
    expect(request.roles.developer.allowed_transitions).toEqual(['implement']);
    expect(request.roles.reviewer.allowed_transitions).toEqual(['review']);
    expect(
      request.machine.states.development.transitions[0].outcomes.succeeded,
    ).toBe('review');
    expect(
      request.machine.states.review.transitions[0].outcomes.succeeded,
    ).toBe('development');
    expect(request.actions.implement.requirements).toMatchObject({
      capability: 'coding_task',
      interaction: 'visible_session',
    });
    expect(request.actions.review.requirements).toMatchObject({
      capability: 'review_task',
      interaction: 'visible_session',
    });
    expect(request.prompts).toEqual({
      'prompts/implement.md': expect.any(String),
      'prompts/review.md': expect.any(String),
    });

    expect(() =>
      validateRepositoryDefinition({
        group: {
          format: 'icarus.agent-group/1',
          protocol_version: 1,
          group_id: 'ag_ui_test',
          name: request.name,
          creator: {
            principal_id: 'principal_ssh_sha256_test',
            signing_key_ref: 'ssh-ed25519:SHA256:test',
          },
          control_branch: 'refs/heads/icarus/control',
          machine_ref: 'machine.yaml',
          required_roles: Object.values(request.roles).map((role) => ({
            role: role.role,
            min_members: role.cardinality.min,
            max_members: role.cardinality.max,
          })),
          lifecycle_policy: {
            active_turn_pause: 'drain',
            stalled_turn_recovery: 'creator_command',
          },
        },
        machine: request.machine,
        roles: request.roles,
        actions: request.actions,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      'duplicate IDs',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.roles[1]!.id = draft.roles[0]!.id;
      },
      /角色 ID 重复/,
    ],
    [
      'invalid cardinality',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.roles[0]!.minMembers = 2;
        draft.roles[0]!.maxMembers = 1;
      },
      /最大人数不能小于最小人数/,
    ],
    [
      'unknown role references',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.states[0]!.transitions[0]!.roleId = 'missing_role';
      },
      /未知角色/,
    ],
    [
      'unknown action references',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.states[0]!.transitions[0]!.actionId = 'missing_action';
      },
      /未知 Action/,
    ],
    [
      'unknown state outcomes',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.states[0]!.transitions[0]!.outcomes.succeeded = 'missing_state';
      },
      /未知状态/,
    ],
    [
      'missing transitions',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.states[0]!.transitions = [];
      },
      /至少需要一个 transition/,
    ],
    [
      'illegal outcomes',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        Object.assign(draft.states[0]!.transitions[0]!.outcomes, {
          approved: 'review',
        });
      },
      /非法 outcome/,
    ],
  ])('rejects %s before creating a request', (_name, mutate, message) => {
    const draft = defaultCollaborationCreateDraft();
    mutate(draft);
    expect(() => build(draft)).toThrow(message);
  });
});

describe('Collaboration join request builder', () => {
  it('validates join fields without serializing caller identity', () => {
    const request = buildCollaborationJoinRequest({
      remoteUrl: '/tmp/collaboration.git',
      signingKeyPath: '/tmp/alice-key',
      capabilities: 'coding_task, visible_session, coding_task',
      role: 'developer',
      principalId: 'caller-selected',
      agentId: 'caller-selected',
    });

    expect(request).toEqual({
      remoteUrl: '/tmp/collaboration.git',
      signingKeyPath: '/tmp/alice-key',
      capabilities: ['coding_task', 'visible_session'],
      role: 'developer',
    });
    expect(request).not.toHaveProperty('principalId');
    expect(request).not.toHaveProperty('agentId');
  });
});
