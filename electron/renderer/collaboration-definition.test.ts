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
  it('builds only roles and the creator-owned FSM skeleton', () => {
    const request = build();

    expect(request.initialRole).toBe('developer');
    expect(request).not.toHaveProperty('principalId');
    expect(request).not.toHaveProperty('agentId');
    expect(request.capabilities).toEqual(['coding_task']);
    expect(Object.keys(request.roles)).toEqual(['developer', 'reviewer']);
    expect(Object.keys(request.machine.states)).toEqual([
      'development',
      'review',
      'completed',
    ]);
    expect(request.roles.developer.owned_states).toEqual(['development']);
    expect(request.roles.reviewer.owned_states).toEqual(['review']);
    expect(request.machine.states.development).toMatchObject({
      owner_role: 'developer',
      transitions: [
        { outcome: 'ready_for_review', target_state: 'review' },
        { outcome: 'blocked', target_state: 'development' },
      ],
    });
    expect(request.machine.states.completed).toEqual({
      label: 'Completed',
      terminal: true,
      transitions: [],
    });
    expect(request).not.toHaveProperty('actions');
    expect(request).not.toHaveProperty('prompts');

    expect(() =>
      validateRepositoryDefinition({
        group: {
          format: 'icarus.agent-group/2',
          protocol_version: 2,
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
        actions: {},
        implementations: {},
      }),
    ).not.toThrow();
  });

  it('snapshots optional notify-only timeout policies on non-terminal States', () => {
    const draft = defaultCollaborationCreateDraft();
    draft.states[0]!.startTimeoutMs = '60000';
    draft.states[0]!.executionTimeoutMs = 300000;
    draft.states[0]!.reminderIntervalMs = '30000';
    draft.states[1]!.executionTimeoutMs = '120000';

    const request = build(draft);

    expect(request.machine.states.development.timeout_policy).toEqual({
      start_timeout_ms: 60_000,
      execution_timeout_ms: 300_000,
      reminder_interval_ms: 30_000,
      on_timeout: 'notify_only',
    });
    expect(request.machine.states.review.timeout_policy).toEqual({
      start_timeout_ms: null,
      execution_timeout_ms: 120_000,
      reminder_interval_ms: null,
      on_timeout: 'notify_only',
    });
    expect(request.machine.states.completed).not.toHaveProperty(
      'timeout_policy',
    );
  });

  it('rejects terminal timeout policies and reminder-only policies', () => {
    const terminalTimeout = defaultCollaborationCreateDraft();
    terminalTimeout.states[2]!.startTimeoutMs = '1000';
    expect(() => build(terminalTimeout)).toThrow(/终态.*不能配置超时策略/);

    const reminderOnly = defaultCollaborationCreateDraft();
    reminderOnly.states[0]!.reminderIntervalMs = '1000';
    expect(() => build(reminderOnly)).toThrow(/必须先配置开始或执行超时/);
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
        draft.states[0]!.ownerRole = 'missing_role';
      },
      /未知角色/,
    ],
    [
      'state-owning role cardinality above one',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.roles[0]!.maxMembers = 2;
      },
      /最大人数必须为 1/,
    ],
    [
      'unknown state outcomes',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.states[0]!.transitions[0]!.targetState = 'missing_state';
      },
      /未知状态/,
    ],
    [
      'missing transitions',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.states[0]!.transitions = [];
      },
      /至少需要一个 Outcome/,
    ],
    [
      'duplicate outcomes',
      (draft: ReturnType<typeof defaultCollaborationCreateDraft>) => {
        draft.states[0]!.transitions.push({
          outcome: draft.states[0]!.transitions[0]!.outcome,
          targetState: 'review',
        });
      },
      /Outcome 重复/,
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
