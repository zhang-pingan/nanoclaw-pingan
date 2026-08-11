import { describe, expect, it } from 'vitest';

import {
  buildCollaborationEventV3,
  collaborationCanonicalHashV3,
  collaborationDeadlineSnapshotHashV3,
  collaborationFencingTokenV3,
  collaborationIdempotencyKeyV3,
  collaborationRecoveryRequestHashV3,
  collaborationTurnInputHashV3,
  collaborationWorkflowDefinitionHashV3,
  reduceCollaborationEventV3,
  type CollaborationProjectionV3,
} from './v3-reducer.js';
import type {
  ActionDefinitionV3,
  CollaborationAggregateType,
  CollaborationEventTypeV3,
  CollaborationEventV3,
  CollaborationTurnV3,
  MachineDefinitionV3,
  StateExecution,
  WorkflowLayout,
  WorkItem,
} from './v3-schema.js';
import { collaborationCredentialFingerprintV3 } from './v3-schema.js';

const NOW = '2026-08-06T12:00:00.000Z';
const ALICE = 'principal_00000000-0000-4000-8000-000000000001';
const BOB = 'principal_00000000-0000-4000-8000-000000000002';
const ALICE_CLIENT = 'client_alice';
const BOB_CLIENT = 'client_bob';
const BOB_CLIENT_2 = 'client_bob_second';
const ALICE_CREDENTIAL = 'credential_alice';
const ALICE_RECOVERY_CREDENTIAL = 'credential_alice_recovery';
const BOB_CREDENTIAL = 'credential_bob';
const BOB_CREDENTIAL_2 = 'credential_bob_second';
const CAROL = 'principal_00000000-0000-4000-8000-000000000003';
const CAROL_CLIENT = 'client_carol';
const CAROL_CREDENTIAL = 'credential_carol';
const HASH = `sha256:${'a'.repeat(64)}`;
const ALICE_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice';
const BOB_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEbob00';
const ALICE_FINGERPRINT = collaborationCredentialFingerprintV3(ALICE_KEY);
const BOB_FINGERPRINT = collaborationCredentialFingerprintV3(BOB_KEY);
const CAROL_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEcarol';
const CAROL_FINGERPRINT = collaborationCredentialFingerprintV3(CAROL_KEY);

let eventOrdinal = 0;

function event(input: {
  projection: CollaborationProjectionV3 | null;
  aggregateType: CollaborationAggregateType;
  aggregateId: string;
  eventType: CollaborationEventTypeV3;
  payload: Record<string, unknown>;
  actor?: string;
  client?: string;
  credential?: string;
  executor?: string | null;
  id?: string;
  occurredAt?: string;
}): CollaborationEventV3 {
  const head =
    input.projection?.aggregateHeads[
      `${input.aggregateType}:${input.aggregateId}`
    ];
  const actor = input.actor ?? ALICE;
  return buildCollaborationEventV3({
    groupId: 'group_test',
    eventId: input.id ?? `evt_${String(++eventOrdinal)}`,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateRevision: (head?.revision ?? 0) + 1,
    previousEventHash: head?.eventHash ?? null,
    eventType: input.eventType,
    actor: {
      principal_id: actor,
      client_id: input.client ?? (actor === ALICE ? ALICE_CLIENT : BOB_CLIENT),
      credential_id:
        input.credential ??
        (actor === ALICE ? ALICE_CREDENTIAL : BOB_CREDENTIAL),
      executor_id: input.executor ?? null,
    },
    occurredAt: input.occurredAt ?? NOW,
    payload: input.payload,
  });
}

function apply(
  projection: CollaborationProjectionV3 | null,
  input: Omit<Parameters<typeof event>[0], 'projection'>,
): CollaborationProjectionV3 {
  return reduceCollaborationEventV3(
    projection,
    event({ ...input, projection }),
  );
}

function genesis(): CollaborationProjectionV3 {
  return apply(null, {
    aggregateType: 'group',
    aggregateId: 'group_test',
    eventType: 'group_initialized',
    id: 'evt_genesis',
    payload: {
      group: {
        format: 'icarus.collaboration-group/3',
        protocol_version: 3,
        group_id: 'group_test',
        name: 'Test group',
        creator: {
          principal_id: ALICE,
        },
        owner_principal_id: ALICE,
        control_branch: 'refs/heads/icarus/control',
        lifecycle: 'active',
        membership_policy: { join: 'open' },
        visibility_policy: { observer_access: 'allowed' },
        created_at: NOW,
        archived_at: null,
      },
      member: {
        format: 'icarus.collaboration-member/3',
        principal_id: ALICE,
        display_name: 'Alice',
        status: 'active',
        joined_at_event: 'evt_genesis',
      },
      client: {
        format: 'icarus.collaboration-client/1',
        principal_id: ALICE,
        client_id: ALICE_CLIENT,
        display_name: 'Alice MacBook',
        capabilities: [],
        status: 'active',
        registered_at_event: 'evt_genesis',
      },
      credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: ALICE_CREDENTIAL,
        principal_id: ALICE,
        client_id: ALICE_CLIENT,
        public_key: ALICE_KEY,
        fingerprint: ALICE_FINGERPRINT,
        purpose: 'event_signing',
        status: 'active',
        created_at_event: 'evt_genesis',
        revoked_at_event: null,
      },
      recovery_credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: ALICE_RECOVERY_CREDENTIAL,
        principal_id: ALICE,
        client_id: ALICE_CLIENT,
        public_key: ALICE_KEY,
        fingerprint: ALICE_FINGERPRINT,
        purpose: 'group_recovery',
        status: 'active',
        created_at_event: 'evt_genesis',
        revoked_at_event: null,
      },
      owner_permissions: {
        format: 'icarus.collaboration-permission-grant/1',
        principal_id: ALICE,
        grants: [
          'member:approve',
          'work_item:create',
          'work_item:manage_all',
          'workflow_definition:propose',
          'workflow_definition:publish',
          'workflow_instance:start_allowed',
          'workflow_instance:manage_all',
        ],
        revision: 1,
        updated_at_event: 'evt_genesis',
      },
    },
  });
}

function withBob(secondClient = false): CollaborationProjectionV3 {
  let projection = genesis();
  const joinEventId = 'evt_bob_join';
  projection = apply(projection, {
    aggregateType: 'membership',
    aggregateId: BOB,
    eventType: 'member_registered',
    id: joinEventId,
    payload: {
      member: {
        format: 'icarus.collaboration-member/3',
        principal_id: BOB,
        display_name: 'Bob',
        status: 'active',
        joined_at_event: joinEventId,
      },
      client: {
        format: 'icarus.collaboration-client/1',
        principal_id: BOB,
        client_id: BOB_CLIENT,
        display_name: 'Bob MacBook',
        capabilities: [],
        status: 'active',
        registered_at_event: joinEventId,
      },
      credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: BOB_CREDENTIAL,
        principal_id: BOB,
        client_id: BOB_CLIENT,
        public_key: BOB_KEY,
        fingerprint: BOB_FINGERPRINT,
        purpose: 'event_signing',
        status: 'active',
        created_at_event: joinEventId,
        revoked_at_event: null,
      },
    },
    actor: BOB,
  });
  if (secondClient) {
    projection = structuredClone(projection);
    projection.clients[BOB]![BOB_CLIENT_2] = {
      format: 'icarus.collaboration-client/1',
      principal_id: BOB,
      client_id: BOB_CLIENT_2,
      display_name: 'Bob Desktop',
      capabilities: [],
      status: 'active',
      registered_at_event: 'evt_bob_recovery_approved',
    };
    projection.credentials[BOB]![BOB_CREDENTIAL_2] = {
      format: 'icarus.collaboration-credential/1',
      credential_id: BOB_CREDENTIAL_2,
      principal_id: BOB,
      client_id: BOB_CLIENT_2,
      public_key: BOB_KEY,
      fingerprint: BOB_FINGERPRINT,
      purpose: 'event_signing',
      status: 'active',
      created_at_event: 'evt_bob_recovery_requested',
      revoked_at_event: null,
    };
  }
  return projection;
}

function action(
  version = 1,
  owner = ALICE,
  actionId = 'implement',
): ActionDefinitionV3 {
  return {
    format: 'icarus.collaboration-action/1',
    action_id: actionId,
    name: `Implement v${String(version)}`,
    owner_principal_id: owner,
    version,
    kind: 'run_once',
    adapter: null,
    workflow_ref: null,
    prompt_ref: `workspace/principals/${owner}/automations/prompts/${actionId}.md`,
    prompt_hash: HASH,
    executor_policy: 'principal_selected',
    filesystem_access: 'workspace_write',
    result_schema: { ref: 'result@1', schema: null },
  };
}

function machine(
  initialState = 'build',
  stateIds: readonly string[] = ['build', 'review'],
): MachineDefinitionV3 {
  const states: MachineDefinitionV3['states'] = {};
  for (const [index, stateId] of stateIds.entries())
    states[stateId] = {
      label: stateId,
      description: '',
      assignee: {
        type: 'principal',
        principal_id: index === 0 ? BOB : ALICE,
      },
      terminal: false,
      transitions: [
        {
          outcome: index === stateIds.length - 1 ? 'done' : 'next',
          label: index === stateIds.length - 1 ? 'Done' : 'Next',
          target_state:
            index === stateIds.length - 1 ? 'complete' : stateIds[index + 1]!,
        },
      ],
    };
  states.complete = {
    label: 'Complete',
    description: '',
    terminal: true,
    transitions: [],
  };
  return {
    format: 'icarus.collaboration-machine/3',
    initial_state: initialState,
    states,
  };
}

function addDefinition(
  projection: CollaborationProjectionV3,
  definitionId: string,
  selectedMachine: MachineDefinitionV3,
): CollaborationProjectionV3 {
  const layout: WorkflowLayout = {
    format: 'icarus.collaboration-workflow-layout/1',
    view: 'free',
    nodes: Object.fromEntries(
      Object.keys(selectedMachine.states).map((stateId, index) => [
        stateId,
        { x: index * 240, y: 100 },
      ]),
    ),
    revision: 1,
  };
  return apply(projection, {
    aggregateType: 'workflow_definition',
    aggregateId: definitionId,
    eventType: 'workflow_definition_published',
    payload: {
      definition: {
        format: 'icarus.collaboration-workflow-definition/1',
        definition_id: definitionId,
        name: definitionId,
        description: '',
        version: 1,
        created_by_principal_id: ALICE,
        published_by_principal_id: ALICE,
        status: 'published',
        launch_policy: {
          group_admin: true,
          work_item_owner: true,
          principals: [ALICE],
        },
        machine_ref: `workflows/definitions/${definitionId}/machine.json`,
        layout_ref: `workflows/definitions/${definitionId}/layout.json`,
        machine_hash: collaborationCanonicalHashV3(selectedMachine),
        layout_hash: collaborationCanonicalHashV3(layout),
        revision: 1,
        created_at: NOW,
        updated_at: NOW,
      },
      machine: selectedMachine,
      layout,
    },
  });
}

function workflowFixture(input?: {
  startTurn?: boolean;
  secondBobClient?: boolean;
}): {
  projection: CollaborationProjectionV3;
  turn: CollaborationTurnV3;
} {
  let projection = withBob(input?.secondBobClient);
  const selectedMachine = machine();
  projection = addDefinition(projection, 'delivery', selectedMachine);
  const definition = projection.workflowDefinitions['delivery@1']!;
  projection = apply(projection, {
    aggregateType: 'workflow_instance',
    aggregateId: 'instance_1',
    eventType: 'workflow_instance_created',
    payload: {
      instance: {
        format: 'icarus.collaboration-workflow-instance/1',
        instance_id: 'instance_1',
        definition_id: 'delivery',
        definition_version: 1,
        definition_hash: collaborationWorkflowDefinitionHashV3(
          definition.definition,
          definition.machine,
        ),
        scope: { type: 'group' },
        related_work_item_refs: [],
        participant_bindings: {},
        resolved_assignments: { build: BOB, review: ALICE },
        work_item_status_mapping: {},
        lifecycle: 'ready',
        business_state: 'build',
        active_turn_id: null,
        last_completed_turn_id: null,
        last_handoff_hash: null,
        epoch: 1,
        revision: 1,
        created_by_principal_id: ALICE,
        created_at: NOW,
        updated_at: NOW,
      },
    },
  });
  projection = apply(projection, {
    aggregateType: 'workflow_instance',
    aggregateId: 'instance_1',
    eventType: 'workflow_instance_started',
    payload: {},
  });
  const inputHash = collaborationTurnInputHashV3({
    groupId: 'group_test',
    instanceId: 'instance_1',
    epoch: 1,
    stateId: 'build',
    assigneePrincipalId: BOB,
    execution: null,
    incomingHandoffHash: null,
    workItem: null,
  });
  let selectedTurn: CollaborationTurnV3 = {
    format: 'icarus.collaboration-turn/1',
    turn_id: 'turn_1',
    workflow_instance_id: 'instance_1',
    state_id: 'build',
    assignee_principal_id: BOB,
    claimant_principal_id: null,
    claimant_client_id: null,
    executor_id: null,
    attempt: 1,
    fencing_token: null,
    execution_mode: 'manual',
    state: 'pending',
    action_ref: null,
    action_hash: null,
    prompt_hash: null,
    input_hash: inputHash,
    idempotency_key: collaborationIdempotencyKeyV3({
      groupId: 'group_test',
      instanceId: 'instance_1',
      epoch: 1,
      turnId: 'turn_1',
      attempt: 1,
      inputHash,
    }),
    incoming_handoff: null,
    incoming_handoff_hash: null,
    timeout_policy_snapshot: null,
    start_deadline_at: null,
    execution_deadline_at: null,
    deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
      turnId: 'turn_1',
      attempt: 1,
      timeoutPolicy: null,
      startDeadlineAt: null,
      startedAt: null,
      executionDeadlineAt: null,
    }),
    created_at: NOW,
    started_at: null,
    completed_at: null,
    outcome: null,
    handoff: null,
    handoff_hash: null,
    executor_result: null,
    executor_result_hash: null,
    completion_hash: null,
    recovery_reason: null,
  };
  projection = apply(projection, {
    aggregateType: 'workflow_instance',
    aggregateId: 'instance_1',
    eventType: 'turn_created',
    payload: { turn: selectedTurn },
  });
  if (input?.startTurn) {
    const startEventId = 'evt_turn_started';
    const expectedRevision =
      projection.aggregateHeads['workflow_instance:instance_1']!.revision;
    const fence = collaborationFencingTokenV3({
      groupId: 'group_test',
      instanceId: 'instance_1',
      epoch: 1,
      turnId: 'turn_1',
      attempt: 1,
      claimantClientId: BOB_CLIENT,
      claimEventId: startEventId,
      expectedRevision,
    });
    projection = apply(projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_started',
      actor: BOB,
      id: startEventId,
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: fence,
        executor_id: null,
        execution_deadline_at: null,
        deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
          turnId: 'turn_1',
          attempt: 1,
          timeoutPolicy: null,
          startDeadlineAt: null,
          startedAt: NOW,
          executionDeadlineAt: null,
        }),
      },
    });
    selectedTurn = projection.turns.turn_1!;
  }
  return { projection, turn: selectedTurn };
}

function stateExecution(
  revision: number,
  eventId: string,
  stateId = 'build',
  principalId = BOB,
): StateExecution {
  return {
    format: 'icarus.collaboration-state-execution/1',
    instance_id: 'instance_1',
    state_id: stateId,
    principal_id: principalId,
    mode: 'manual',
    action_ref: null,
    action_hash: null,
    prompt_hash: null,
    published_at_event: eventId,
    revision,
  };
}

function workItem(workItemId: string): WorkItem {
  return {
    format: 'icarus.collaboration-work-item/1',
    work_item_id: workItemId,
    type: 'task',
    title: workItemId,
    description: '',
    status: 'open',
    priority: 'normal',
    creator_principal_id: ALICE,
    owner_principal_id: ALICE,
    preferred_executor_id: null,
    contributors: [],
    watchers: [],
    acceptance_criteria: [],
    labels: [],
    due_at: null,
    parent_id: null,
    blocked_by: [],
    related_items: [],
    primary_workflow_instance_id: null,
    assignment_status: 'accepted',
    created_at: NOW,
    updated_at: NOW,
    closed_at: null,
    revision: 1,
    archived: false,
  };
}

function addWorkItems(
  ...workItemIds: readonly string[]
): CollaborationProjectionV3 {
  let projection = genesis();
  for (const workItemId of workItemIds)
    projection = apply(projection, {
      aggregateType: 'work_item',
      aggregateId: workItemId,
      eventType: 'work_item_created',
      payload: { item: workItem(workItemId) },
    });
  return projection;
}

describe('Collaboration v3 reducer invariants', () => {
  it('allows only the Owner to dissolve and makes dissolution terminal', () => {
    let projection = withBob();
    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: ALICE,
        eventType: 'group_dissolved',
        payload: { reason: 'Wrong Aggregate type' },
      }),
    ).toThrow(/Group Aggregate/iu);
    expect(() =>
      apply(projection, {
        aggregateType: 'group',
        aggregateId: 'group_other',
        eventType: 'group_dissolved',
        payload: { reason: 'Wrong Aggregate id' },
      }),
    ).toThrow(/Group Aggregate/iu);
    expect(() =>
      apply(projection, {
        aggregateType: 'group',
        aggregateId: 'group_test',
        eventType: 'group_dissolved',
        actor: BOB,
        payload: { reason: 'Unauthorized dissolution' },
      }),
    ).toThrow(/Owner/iu);

    projection = apply(projection, {
      aggregateType: 'group',
      aggregateId: 'group_test',
      eventType: 'group_archived',
      payload: { reason: 'Pause delivery' },
    });
    projection = apply(projection, {
      aggregateType: 'group',
      aggregateId: 'group_test',
      eventType: 'group_dissolved',
      payload: { reason: 'Project is complete' },
      occurredAt: '2026-08-06T12:05:00.000Z',
    });
    expect(projection.group).toMatchObject({
      lifecycle: 'dissolved',
      archived_at: null,
      dissolved_at: '2026-08-06T12:05:00.000Z',
    });
    expect(() =>
      apply(projection, {
        aggregateType: 'group',
        aggregateId: 'group_test',
        eventType: 'group_reopened',
        payload: { reason: 'Cannot reopen' },
      }),
    ).toThrow(/Dissolved/iu);
  });

  it('binds Executor lifecycle to one Principal membership Aggregate and event lineage', () => {
    let projection = withBob();
    const executor = (registeredAtEvent: string) => ({
      format: 'icarus.collaboration-executor/1' as const,
      principal_id: BOB,
      executor_id: 'executor_bob',
      display_name: 'Bob Executor',
      kind: 'run_once' as const,
      capabilities: [],
      status: 'active' as const,
      registered_at_event: registeredAtEvent,
      revoked_at_event: null,
    });

    expect(() =>
      apply(projection, {
        aggregateType: 'workspace',
        aggregateId: BOB,
        eventType: 'executor_registered',
        actor: BOB,
        id: 'evt_executor_wrong_type',
        payload: { executor: executor('evt_executor_wrong_type') },
      }),
    ).toThrow(/membership Aggregate/iu);
    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: ALICE,
        eventType: 'executor_registered',
        actor: BOB,
        id: 'evt_executor_wrong_principal',
        payload: { executor: executor('evt_executor_wrong_principal') },
      }),
    ).toThrow(/membership Aggregate/iu);
    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: BOB,
        eventType: 'executor_registered',
        actor: BOB,
        id: 'evt_executor_wrong_reference',
        payload: { executor: executor('evt_other') },
      }),
    ).toThrow(/current event/iu);

    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'executor_registered',
      actor: BOB,
      id: 'evt_executor_registered',
      payload: { executor: executor('evt_executor_registered') },
    });
    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: BOB,
        eventType: 'executor_registered',
        actor: BOB,
        id: 'evt_executor_duplicate',
        payload: { executor: executor('evt_executor_duplicate') },
      }),
    ).toThrow(/already registered/iu);
    expect(() =>
      apply(projection, {
        aggregateType: 'workspace',
        aggregateId: BOB,
        eventType: 'executor_revoked',
        actor: BOB,
        payload: { executor_id: 'executor_bob', reason: 'Wrong chain' },
      }),
    ).toThrow(/membership Aggregate/iu);

    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'executor_revoked',
      actor: BOB,
      id: 'evt_executor_revoked',
      payload: { executor_id: 'executor_bob', reason: 'Retired locally' },
    });
    expect(projection.executors[BOB]?.executor_bob).toMatchObject({
      status: 'revoked',
      revoked_at_event: 'evt_executor_revoked',
    });
    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: BOB,
        eventType: 'executor_registered',
        actor: BOB,
        id: 'evt_executor_resurrection',
        payload: { executor: executor('evt_executor_resurrection') },
      }),
    ).toThrow(/already registered/iu);
  });

  it('revokes a leaving member and recovers active Workflow work before rejoin', () => {
    let projection = workflowFixture({
      startTurn: true,
      secondBobClient: true,
    }).projection;
    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'executor_registered',
      actor: BOB,
      id: 'evt_bob_executor',
      payload: {
        executor: {
          format: 'icarus.collaboration-executor/1',
          principal_id: BOB,
          executor_id: 'executor_bob',
          display_name: 'Bob Executor',
          kind: 'run_once',
          capabilities: [],
          status: 'active',
          registered_at_event: 'evt_bob_executor',
          revoked_at_event: null,
        },
      },
    });

    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: ALICE,
        eventType: 'member_left',
        payload: { reason: 'Owner cannot leave', affected_turn_ids: [] },
      }),
    ).toThrow(/Owner/iu);

    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'member_left',
      actor: BOB,
      id: 'evt_bob_left',
      payload: {
        reason: 'Leaving the project',
        affected_turn_ids: ['turn_1'],
      },
    });
    expect(projection.members[BOB]?.status).toBe('left');
    expect(
      Object.values(projection.clients[BOB] ?? {}).every(
        (client) => client.status === 'revoked',
      ),
    ).toBe(true);
    expect(
      Object.values(projection.credentials[BOB] ?? {}).every(
        (credential) =>
          credential.status === 'revoked' &&
          credential.revoked_at_event === 'evt_bob_left',
      ),
    ).toBe(true);
    expect(
      Object.values(projection.executors[BOB] ?? {}).every(
        (executor) =>
          executor.status === 'revoked' &&
          executor.revoked_at_event === 'evt_bob_left',
      ),
    ).toBe(true);
    expect(projection.turns.turn_1).toMatchObject({
      state: 'recovery_required',
      recovery_reason: `member_left:${BOB}`,
    });
    expect(projection.workflowInstances.instance_1?.lifecycle).toBe(
      'recovery_required',
    );
    expect(() =>
      apply(workflowFixture({ startTurn: true }).projection, {
        aggregateType: 'membership',
        aggregateId: BOB,
        eventType: 'member_left',
        actor: BOB,
        payload: {
          reason: 'Omit active work',
          affected_turn_ids: [],
        },
      }),
    ).toThrow(/affected Turn ids/iu);
    expect(() =>
      apply(projection, {
        aggregateType: 'group',
        aggregateId: 'group_test',
        eventType: 'group_settings_updated',
        actor: BOB,
        payload: { name: 'Unauthorized rename' },
      }),
    ).toThrow(/active Group member/iu);

    expect(() =>
      apply(projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_recovered',
        payload: {
          turn_id: 'turn_1',
          assignee_principal_id: BOB,
          previous_attempt: 1,
          next_attempt: 2,
          reason: 'Cannot assign recovery to a departed member',
          start_deadline_at: null,
          deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
            turnId: 'turn_1',
            attempt: 2,
            timeoutPolicy: null,
            startDeadlineAt: null,
            startedAt: null,
            executionDeadlineAt: null,
          }),
        },
      }),
    ).toThrow(/active Group member/iu);

    projection = apply(projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_recovered',
      payload: {
        turn_id: 'turn_1',
        assignee_principal_id: ALICE,
        previous_attempt: 1,
        next_attempt: 2,
        reason: 'Owner reassigned work after Bob left',
        start_deadline_at: null,
        deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
          turnId: 'turn_1',
          attempt: 2,
          timeoutPolicy: null,
          startDeadlineAt: null,
          startedAt: null,
          executionDeadlineAt: null,
        }),
      },
    });
    expect(projection.workflowInstances.instance_1).toMatchObject({
      lifecycle: 'running',
      active_turn_id: 'turn_1',
      resolved_assignments: { build: ALICE },
    });
    expect(projection.turns.turn_1).toMatchObject({
      state: 'pending',
      attempt: 2,
      assignee_principal_id: ALICE,
      claimant_principal_id: null,
      recovery_reason: null,
    });
    const recoveredInputHash = collaborationTurnInputHashV3({
      groupId: 'group_test',
      instanceId: 'instance_1',
      epoch: 1,
      stateId: 'build',
      assigneePrincipalId: ALICE,
      execution: null,
      incomingHandoffHash: null,
      workItem: null,
    });
    expect(projection.turns.turn_1?.input_hash).toBe(recoveredInputHash);
    expect(projection.turns.turn_1?.idempotency_key).toBe(
      collaborationIdempotencyKeyV3({
        groupId: 'group_test',
        instanceId: 'instance_1',
        epoch: 1,
        turnId: 'turn_1',
        attempt: 2,
        inputHash: recoveredInputHash,
      }),
    );
    const startEventId = 'evt_alice_started_recovered_turn';
    const expectedRevision =
      projection.aggregateHeads['workflow_instance:instance_1']!.revision;
    const fence = collaborationFencingTokenV3({
      groupId: 'group_test',
      instanceId: 'instance_1',
      epoch: 1,
      turnId: 'turn_1',
      attempt: 2,
      claimantClientId: ALICE_CLIENT,
      claimEventId: startEventId,
      expectedRevision,
    });
    projection = apply(projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_started',
      id: startEventId,
      payload: {
        turn_id: 'turn_1',
        attempt: 2,
        fencing_token: fence,
        executor_id: null,
        execution_deadline_at: null,
        deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
          turnId: 'turn_1',
          attempt: 2,
          timeoutPolicy: null,
          startDeadlineAt: null,
          startedAt: NOW,
          executionDeadlineAt: null,
        }),
      },
    });
    expect(projection.turns.turn_1).toMatchObject({
      state: 'running',
      claimant_principal_id: ALICE,
      claimant_client_id: ALICE_CLIENT,
    });

    const rejoinEventId = 'evt_bob_rejoined';
    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'member_registered',
      actor: BOB,
      client: 'client_bob_rejoined',
      credential: 'credential_bob_rejoined',
      id: rejoinEventId,
      payload: {
        member: {
          format: 'icarus.collaboration-member/3',
          principal_id: BOB,
          display_name: 'Bob',
          status: 'active',
          joined_at_event: rejoinEventId,
        },
        client: {
          format: 'icarus.collaboration-client/1',
          principal_id: BOB,
          client_id: 'client_bob_rejoined',
          display_name: 'Bob New Device',
          capabilities: [],
          status: 'active',
          registered_at_event: rejoinEventId,
        },
        credential: {
          format: 'icarus.collaboration-credential/1',
          credential_id: 'credential_bob_rejoined',
          principal_id: BOB,
          client_id: 'client_bob_rejoined',
          public_key: BOB_KEY,
          fingerprint: BOB_FINGERPRINT,
          purpose: 'event_signing',
          status: 'active',
          created_at_event: rejoinEventId,
          revoked_at_event: null,
        },
      },
    });
    expect(projection.members[BOB]).toMatchObject({
      principal_id: BOB,
      status: 'active',
      joined_at_event: rejoinEventId,
    });
    expect(projection.credentials[BOB]?.[BOB_CREDENTIAL]?.status).toBe(
      'revoked',
    );
    expect(projection.credentials[BOB]?.credential_bob_rejoined?.status).toBe(
      'active',
    );
    expect(Object.keys(projection.members)).toEqual(
      expect.arrayContaining([ALICE, BOB]),
    );
    expect(Object.keys(projection.members)).toHaveLength(2);
  });

  it('rejects future-dated recovery expiry by an unrelated active Member', () => {
    let projection = withBob();
    const requestEventId = 'evt_recovery_expiry_request';
    const requestId = 'recovery_expiry_attack';
    const requestedClientId = 'client_alice_recovery_expiry';
    const requestedCredentialId = 'credential_alice_recovery_expiry';
    const immutable = {
      format: 'icarus.collaboration-recovery-request/1' as const,
      request_id: requestId,
      type: 'identity_recovery' as const,
      target_principal_id: ALICE,
      requested_client: {
        format: 'icarus.collaboration-client/1' as const,
        principal_id: ALICE,
        client_id: requestedClientId,
        display_name: 'Alice replacement',
        capabilities: [],
        status: 'active' as const,
        registered_at_event: requestEventId,
      },
      requested_credential: {
        format: 'icarus.collaboration-credential/1' as const,
        credential_id: requestedCredentialId,
        principal_id: ALICE,
        client_id: requestedClientId,
        public_key: ALICE_KEY,
        fingerprint: ALICE_FINGERPRINT,
        purpose: 'event_signing' as const,
        status: 'active' as const,
        created_at_event: requestEventId,
        revoked_at_event: null,
      },
      reason: null,
      created_at: NOW,
      expires_at: '2026-08-07T12:00:00.000Z',
    };
    const requestHash = collaborationRecoveryRequestHashV3(immutable);
    projection = apply(projection, {
      aggregateType: 'recovery',
      aggregateId: requestId,
      eventType: 'identity_recovery_requested',
      id: requestEventId,
      actor: ALICE,
      client: requestedClientId,
      credential: requestedCredentialId,
      payload: {
        request: {
          ...immutable,
          request_hash: requestHash,
          status: 'pending',
          decided_at_event: null,
          decided_by_principal_id: null,
          decision_reason: null,
          approval_kind: null,
          revoked_credential_ids: [],
        },
      },
    });
    const expiryPayload = {
      request_hash: requestHash,
      reason: 'request expired',
      revoke_previous_credentials: false,
      revoke_credential_ids: [],
    };

    expect(() =>
      apply(projection, {
        aggregateType: 'recovery',
        aggregateId: requestId,
        eventType: 'recovery_expired',
        actor: BOB,
        occurredAt: '2099-01-01T00:00:00.000Z',
        payload: expiryPayload,
      }),
    ).toThrow(/target Principal|expiry requires/iu);

    const expired = apply(projection, {
      aggregateType: 'recovery',
      aggregateId: requestId,
      eventType: 'recovery_expired',
      actor: ALICE,
      occurredAt: '2026-08-07T12:00:00.000Z',
      payload: expiryPayload,
    });
    expect(expired.recoveryRequests[requestId]).toMatchObject({
      status: 'expired',
      decided_by_principal_id: ALICE,
    });
  });

  it('keeps assisted Executor results awaiting claimant confirmation and binds their hash', () => {
    const fixture = workflowFixture({ startTurn: true });
    const projection = structuredClone(fixture.projection);
    const turn = projection.turns.turn_1!;
    turn.execution_mode = 'assisted';
    turn.executor_id = 'executor_bob';
    const definition = projection.workflowDefinitions['delivery@1']!;
    definition.machine.states.build!.transitions.push({
      outcome: 'retry',
      label: 'Retry',
      target_state: 'build',
    });
    projection.workflowInstances.instance_1!.definition_hash =
      collaborationWorkflowDefinitionHashV3(
        definition.definition,
        definition.machine,
      );
    (projection.executors[BOB] ??= {}).executor_bob = {
      format: 'icarus.collaboration-executor/1',
      principal_id: BOB,
      executor_id: 'executor_bob',
      display_name: 'Bob Executor',
      kind: 'run_once',
      capabilities: [],
      status: 'active',
      registered_at_event: 'evt_executor_bob',
      revoked_at_event: null,
    };
    const result = {
      format: 'icarus.collaboration-action-result/3' as const,
      outcome: 'next',
      summary: 'Implementation is ready.',
      instruction: 'Review the changes.',
      markers: [],
      data: { commit: 'abc123' },
      artifacts: [],
      error: null,
    };
    const resultHash = collaborationCanonicalHashV3(result);
    const awaiting = apply(projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'action_completed',
      actor: BOB,
      executor: 'executor_bob',
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: turn.fencing_token,
        result,
        result_hash: resultHash,
      },
    });
    expect(awaiting.turns.turn_1).toMatchObject({
      state: 'awaiting_confirmation',
      executor_result: result,
      executor_result_hash: resultHash,
    });
    expect(awaiting.workflowInstances.instance_1?.business_state).toBe('build');

    const handoff = {
      format: 'icarus.collaboration-handoff/1' as const,
      source_turn_id: 'turn_1',
      outcome: 'retry',
      summary: 'Confirmed by Bob.',
      instruction: 'Continue to review.',
      markers: [],
      data_refs: [],
      artifact_refs: [],
      data: { commit: 'abc123', confirmed: true },
    };
    const completionHash = collaborationCanonicalHashV3({
      turn_id: 'turn_1',
      attempt: 1,
      outcome: 'retry',
      result_hash: resultHash,
      handoff_hash: collaborationCanonicalHashV3(handoff),
      artifact_refs: [],
    });
    const completed = apply(awaiting, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_completed',
      actor: BOB,
      executor: null,
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: turn.fencing_token,
        outcome: 'retry',
        result_hash: resultHash,
        completion_hash: completionHash,
        handoff,
        handoff_hash: collaborationCanonicalHashV3(handoff),
        artifact_refs: [],
        artifacts: [],
      },
    });
    expect(completed.turns.turn_1).toMatchObject({
      state: 'completed',
      executor_result_hash: resultHash,
      completion_hash: completionHash,
    });
    expect(completed.workflowInstances.instance_1?.business_state).toBe(
      'build',
    );
  });

  it('rejects automatic Result hash drift and completion without action_completed', () => {
    const fixture = workflowFixture({ startTurn: true });
    const projection = structuredClone(fixture.projection);
    const turn = projection.turns.turn_1!;
    turn.execution_mode = 'automatic';
    turn.executor_id = 'executor_bob';
    (projection.executors[BOB] ??= {}).executor_bob = {
      format: 'icarus.collaboration-executor/1',
      principal_id: BOB,
      executor_id: 'executor_bob',
      display_name: 'Bob Executor',
      kind: 'run_once',
      capabilities: [],
      status: 'active',
      registered_at_event: 'evt_executor_bob',
      revoked_at_event: null,
    };
    const handoff = {
      format: 'icarus.collaboration-handoff/1' as const,
      source_turn_id: 'turn_1',
      outcome: 'next',
      summary: 'Automatic result.',
      instruction: '',
      markers: [],
      data_refs: [],
      artifact_refs: [],
      data: {},
    };
    const completion = (resultHash: string) => ({
      turn_id: 'turn_1',
      attempt: 1,
      fencing_token: turn.fencing_token,
      outcome: 'next',
      result_hash: resultHash,
      completion_hash: collaborationCanonicalHashV3({
        turn_id: 'turn_1',
        attempt: 1,
        outcome: 'next',
        result_hash: resultHash,
        handoff_hash: collaborationCanonicalHashV3(handoff),
        artifact_refs: [],
      }),
      handoff,
      handoff_hash: collaborationCanonicalHashV3(handoff),
      artifact_refs: [],
      artifacts: [],
    });
    expect(() =>
      apply(projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_completed',
        actor: BOB,
        executor: 'executor_bob',
        payload: completion(HASH),
      }),
    ).toThrow(/Action result|action_completed|result hash/u);

    const result = {
      format: 'icarus.collaboration-action-result/3' as const,
      outcome: 'next',
      summary: 'Automatic result.',
      instruction: '',
      markers: [],
      data: {},
      artifacts: [],
      error: null,
    };
    const resultHash = collaborationCanonicalHashV3(result);
    const actionCompleted = apply(projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'action_completed',
      actor: BOB,
      executor: 'executor_bob',
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: turn.fencing_token,
        result,
        result_hash: resultHash,
      },
    });
    expect(() =>
      apply(actionCompleted, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_completed',
        actor: BOB,
        executor: 'executor_bob',
        payload: completion(HASH),
      }),
    ).toThrow(/result hash/u);
  });

  it('binds every automatic completion fact to the recorded Executor Result', () => {
    const fixture = workflowFixture({ startTurn: true });
    const projection = structuredClone(fixture.projection);
    const turn = projection.turns.turn_1!;
    turn.execution_mode = 'automatic';
    turn.executor_id = 'executor_bob';
    const definition = projection.workflowDefinitions['delivery@1']!;
    definition.machine.states.build!.transitions.push({
      outcome: 'retry',
      label: 'Retry',
      target_state: 'review',
    });
    projection.workflowInstances.instance_1!.definition_hash =
      collaborationWorkflowDefinitionHashV3(
        definition.definition,
        definition.machine,
      );
    (projection.executors[BOB] ??= {}).executor_bob = {
      format: 'icarus.collaboration-executor/1',
      principal_id: BOB,
      executor_id: 'executor_bob',
      display_name: 'Bob Executor',
      kind: 'run_once',
      capabilities: [],
      status: 'active',
      registered_at_event: 'evt_executor_bob',
      revoked_at_event: null,
    };
    const result = {
      format: 'icarus.collaboration-action-result/3' as const,
      outcome: 'next',
      summary: 'Executor selected the next Outcome.',
      instruction: 'Review the generated report.',
      markers: ['executor_verified'],
      data: { source: 'executor' },
      artifacts: [
        {
          name: 'report.json',
          ref: 'workspace/shared/files/report/metadata.json',
        },
      ],
      error: null,
    };
    const resultHash = collaborationCanonicalHashV3(result);
    const actionCompleted = apply(projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'action_completed',
      actor: BOB,
      executor: 'executor_bob',
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: turn.fencing_token,
        result,
        result_hash: resultHash,
      },
    });
    const completion = (
      overrides: {
        outcome?: string;
        summary?: string;
        instruction?: string;
        markers?: string[];
        dataRefs?: string[];
        artifactRefs?: string[];
        data?: Record<string, unknown>;
      } = {},
    ) => {
      const outcome = overrides.outcome ?? result.outcome;
      const artifactRefs =
        overrides.artifactRefs ?? result.artifacts.map(({ ref }) => ref);
      const handoff = {
        format: 'icarus.collaboration-handoff/1' as const,
        source_turn_id: 'turn_1',
        outcome,
        summary: overrides.summary ?? result.summary,
        instruction: overrides.instruction ?? result.instruction,
        markers: overrides.markers ?? result.markers,
        data_refs: overrides.dataRefs ?? [],
        artifact_refs: artifactRefs,
        data: overrides.data ?? result.data,
      };
      return {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: turn.fencing_token,
        outcome,
        result_hash: resultHash,
        completion_hash: collaborationCanonicalHashV3({
          turn_id: 'turn_1',
          attempt: 1,
          outcome,
          result_hash: resultHash,
          handoff_hash: collaborationCanonicalHashV3(handoff),
          artifact_refs: artifactRefs,
        }),
        handoff,
        handoff_hash: collaborationCanonicalHashV3(handoff),
        artifact_refs: artifactRefs,
        artifacts: [],
      };
    };

    for (const payload of [
      completion({ outcome: 'retry' }),
      completion({ summary: 'Client-supplied summary.' }),
      completion({ instruction: 'Ignore the frozen instruction.' }),
      completion({ markers: ['client_marker'] }),
      completion({ dataRefs: ['workspace/shared/files/extra/metadata.json'] }),
      completion({ artifactRefs: [] }),
      completion({ data: { source: 'client' } }),
    ])
      expect(() =>
        apply(actionCompleted, {
          aggregateType: 'workflow_instance',
          aggregateId: 'instance_1',
          eventType: 'turn_completed',
          actor: BOB,
          executor: 'executor_bob',
          payload,
        }),
      ).toThrow(/automatic|Executor Result/u);

    const closedInstance = structuredClone(actionCompleted);
    closedInstance.workflowInstances.instance_1!.lifecycle = 'closed';
    expect(() =>
      apply(closedInstance, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_completed',
        actor: BOB,
        executor: 'executor_bob',
        payload: completion(),
      }),
    ).toThrow(/running Workflow Instance/u);

    expect(
      apply(actionCompleted, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_completed',
        actor: BOB,
        executor: 'executor_bob',
        payload: completion(),
      }).turns.turn_1,
    ).toMatchObject({
      state: 'completed',
      outcome: 'next',
      handoff: {
        summary: result.summary,
        instruction: result.instruction,
        markers: result.markers,
        data_refs: [],
        artifact_refs: result.artifacts.map(({ ref }) => ref),
        data: result.data,
      },
    });
  });

  it('allows only Instance authority to cancel an unclaimed Turn', () => {
    const fixture = workflowFixture();
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'workflow_instance_closed',
        payload: { reason: 'Must not strand the active Turn' },
      }),
    ).toThrow(/active Turn/u);
    const unauthorized = event({
      projection: fixture.projection,
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_cancelled',
      actor: BOB,
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: null,
        reason: 'Not mine to cancel yet',
      },
    });
    expect(() =>
      reduceCollaborationEventV3(fixture.projection, unauthorized),
    ).toThrow(/authority|cancel/u);

    const cancelled = apply(fixture.projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_cancelled',
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: null,
        reason: 'Cancelled by creator',
      },
    });
    expect(cancelled.turns.turn_1?.state).toBe('cancelled');
    expect(
      apply(cancelled, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'workflow_instance_closed',
        payload: { reason: 'Turn is now cancelled' },
      }).workflowInstances.instance_1?.lifecycle,
    ).toBe('closed');
  });

  it('does not let a late Action callback revive completed or cancelled Turns', () => {
    const completedFixture = workflowFixture({ startTurn: true });
    const handoff = {
      format: 'icarus.collaboration-handoff/1' as const,
      source_turn_id: 'turn_1',
      outcome: 'next',
      summary: 'Build complete',
      instruction: '',
      markers: [],
      data_refs: [],
      artifact_refs: [],
      data: {},
    };
    const completed = apply(completedFixture.projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_completed',
      actor: BOB,
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: completedFixture.turn.fencing_token,
        outcome: 'next',
        result_hash: null,
        completion_hash: collaborationCanonicalHashV3({
          turn_id: 'turn_1',
          attempt: 1,
          outcome: 'next',
          result_hash: null,
          handoff_hash: collaborationCanonicalHashV3(handoff),
          artifact_refs: [],
        }),
        handoff,
        handoff_hash: collaborationCanonicalHashV3(handoff),
        artifact_refs: [],
        artifacts: [],
      },
    });
    expect(() =>
      apply(completed, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'action_waiting_input',
        actor: BOB,
        payload: {
          turn_id: 'turn_1',
          attempt: 1,
          fencing_token: completedFixture.turn.fencing_token,
        },
      }),
    ).toThrow(/terminal|callback|state/u);

    const cancelledFixture = workflowFixture({ startTurn: true });
    const cancelled = apply(cancelledFixture.projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'turn_cancelled',
      actor: BOB,
      payload: {
        turn_id: 'turn_1',
        attempt: 1,
        fencing_token: cancelledFixture.turn.fencing_token,
        reason: 'Stop',
      },
    });
    expect(() =>
      apply(cancelled, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'action_waiting_approval',
        actor: BOB,
        payload: {
          turn_id: 'turn_1',
          attempt: 1,
          fencing_token: cancelledFixture.turn.fencing_token,
        },
      }),
    ).toThrow(/terminal|callback|state/u);
  });

  it('requires recovery requests from the fenced claimant Client', () => {
    const fixture = workflowFixture({ startTurn: true, secondBobClient: true });
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_recovery_requested',
        actor: BOB,
        client: BOB_CLIENT_2,
        credential: BOB_CREDENTIAL_2,
        payload: {
          turn_id: 'turn_1',
          epoch: 1,
          attempt: 1,
          fencing_token: fixture.turn.fencing_token,
          reason: 'Wrong client',
        },
      }),
    ).toThrow(/claimant Client|owner/u);
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_recovery_requested',
        actor: BOB,
        payload: {
          turn_id: 'turn_1',
          epoch: 1,
          attempt: 1,
          fencing_token: HASH,
          reason: 'Stale fence',
        },
      }),
    ).toThrow(/fenc|stale/u);
  });

  it('requires the current Workflow epoch in recovery requests', () => {
    const fixture = workflowFixture({ startTurn: true });
    expect(
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_recovery_requested',
        actor: BOB,
        payload: {
          turn_id: 'turn_1',
          epoch: 1,
          attempt: 1,
          fencing_token: fixture.turn.fencing_token,
          reason: 'Provider uncertain',
        },
      }).turns.turn_1?.state,
    ).toBe('recovery_required');
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_recovery_requested',
        actor: BOB,
        payload: {
          turn_id: 'turn_1',
          epoch: 2,
          attempt: 1,
          fencing_token: fixture.turn.fencing_token,
          reason: 'Stale epoch',
        },
      }),
    ).toThrow(/epoch|stale/u);
  });

  it('distinguishes Action publish from sequential revise and binds Aggregate provenance', () => {
    const initial = genesis();
    const published = apply(initial, {
      aggregateType: 'workspace',
      aggregateId: ALICE,
      eventType: 'action_published',
      payload: { action: action(1) },
    });
    const revised = apply(published, {
      aggregateType: 'workspace',
      aggregateId: ALICE,
      eventType: 'action_revised',
      payload: { action: action(2) },
    });
    expect(revised.actions[`${ALICE}:implement`]?.version).toBe(2);

    expect(() =>
      apply(published, {
        aggregateType: 'workspace',
        aggregateId: ALICE,
        eventType: 'action_published',
        payload: { action: action(2) },
      }),
    ).toThrow(/publish|exists/u);
    expect(() =>
      apply(initial, {
        aggregateType: 'workspace',
        aggregateId: ALICE,
        eventType: 'action_revised',
        payload: { action: action(1) },
      }),
    ).toThrow(/revise|missing/u);
    expect(() =>
      apply(published, {
        aggregateType: 'workspace',
        aggregateId: ALICE,
        eventType: 'action_revised',
        payload: { action: action(3) },
      }),
    ).toThrow(/sequential|version/u);
    expect(() =>
      apply(initial, {
        aggregateType: 'workspace',
        aggregateId: BOB,
        eventType: 'action_published',
        payload: { action: action(1) },
      }),
    ).toThrow(/Aggregate|provenance|actor-owned/u);
  });

  it('distinguishes State Execution publish from sequential revise and binds event provenance', () => {
    const fixture = workflowFixture();
    const firstEventId = 'evt_execution_1';
    const published = apply(fixture.projection, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'state_execution_published',
      actor: BOB,
      id: firstEventId,
      payload: { execution: stateExecution(1, firstEventId) },
    });
    const secondEventId = 'evt_execution_2';
    const revised = apply(published, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'state_execution_revised',
      actor: BOB,
      id: secondEventId,
      payload: { execution: stateExecution(2, secondEventId) },
    });
    expect(revised.stateExecutions.instance_1?.build?.revision).toBe(2);

    expect(() =>
      apply(published, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'state_execution_published',
        actor: BOB,
        id: 'evt_duplicate_publish',
        payload: {
          execution: stateExecution(2, 'evt_duplicate_publish'),
        },
      }),
    ).toThrow(/publish|exists/u);
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'state_execution_revised',
        actor: BOB,
        id: 'evt_missing_execution',
        payload: {
          execution: stateExecution(1, 'evt_missing_execution'),
        },
      }),
    ).toThrow(/revise|missing/u);
    expect(() =>
      apply(published, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'state_execution_revised',
        actor: BOB,
        id: 'evt_execution_3',
        payload: { execution: stateExecution(3, 'evt_execution_3') },
      }),
    ).toThrow(/sequential|revision/u);
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'state_execution_published',
        actor: BOB,
        id: 'evt_real',
        payload: { execution: stateExecution(1, 'evt_forged') },
      }),
    ).toThrow(/provenance|event/u);

    expect(() =>
      apply(published, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'state_execution_withdrawn',
        actor: ALICE,
        payload: { state_id: 'build' },
      }),
    ).toThrow(/resolved Principal|withdraw/u);
    const withdrawn = apply(published, {
      aggregateType: 'workflow_instance',
      aggregateId: 'instance_1',
      eventType: 'state_execution_withdrawn',
      actor: BOB,
      payload: { state_id: 'build' },
    });
    expect(withdrawn.stateExecutions.instance_1?.build).toBeUndefined();
    expect(() =>
      apply(withdrawn, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'state_execution_withdrawn',
        actor: BOB,
        payload: { state_id: 'build' },
      }),
    ).toThrow(/does not exist/u);
    const closed = structuredClone(published);
    closed.workflowInstances.instance_1!.lifecycle = 'closed';
    expect(() =>
      apply(closed, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'state_execution_withdrawn',
        actor: BOB,
        payload: { state_id: 'build' },
      }),
    ).toThrow(/ready, running, or paused/u);
  });

  it('rejects reassignment to a missing or different Definition State', () => {
    const fixture = workflowFixture();
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'workflow_state_assignee_changed',
        payload: { state_id: 'build', principal_id: ALICE },
      }),
    ).toThrow(/cancel.*Turn|Current State/u);
    expect(() =>
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'workflow_state_assignee_changed',
        payload: { state_id: 'missing', principal_id: ALICE },
      }),
    ).toThrow(/Definition State|does not exist/u);

    const withOtherDefinition = addDefinition(
      fixture.projection,
      'deployment',
      machine('deploy', ['deploy']),
    );
    expect(() =>
      apply(withOtherDefinition, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'workflow_state_assignee_changed',
        payload: { state_id: 'deploy', principal_id: ALICE },
      }),
    ).toThrow(/Definition State|does not exist/u);
  });

  it('rejects self, duplicate, and missing Work Item relation references', () => {
    const projection = addWorkItems('item_a', 'item_b');
    for (const payload of [
      {
        parent_id: 'item_a',
        blocked_by: [],
        related_items: [],
      },
      {
        parent_id: null,
        blocked_by: ['item_a'],
        related_items: [],
      },
      {
        parent_id: null,
        blocked_by: ['item_b', 'item_b'],
        related_items: [],
      },
      {
        parent_id: null,
        blocked_by: [],
        related_items: ['missing'],
      },
    ])
      expect(() =>
        apply(projection, {
          aggregateType: 'work_item',
          aggregateId: 'item_a',
          eventType: 'work_item_relation_changed',
          payload,
        }),
      ).toThrow(/self|unique|does not exist/u);
  });

  it('does not let Work Item details rewrite relation fields', () => {
    const projection = addWorkItems('item_a', 'item_b');
    const previous = projection.workItems.item_a!;
    for (const relations of [
      { parent_id: 'item_a', blocked_by: [], related_items: [] },
      { parent_id: null, blocked_by: ['item_b', 'item_b'], related_items: [] },
      { parent_id: null, blocked_by: ['missing'], related_items: [] },
    ])
      expect(() =>
        apply(projection, {
          aggregateType: 'work_item',
          aggregateId: 'item_a',
          eventType: 'work_item_details_updated',
          payload: {
            item: {
              ...previous,
              ...relations,
              revision: 2,
              updated_at: '2026-08-06T12:01:00.000Z',
            },
          },
        }),
      ).toThrow(/relation|itself|unique|does not exist/u);
  });

  it('requires manage_owned for an ordinary member to manage an owned Work Item', () => {
    let projection = withBob();
    projection = apply(projection, {
      aggregateType: 'work_item',
      aggregateId: 'item_bob',
      eventType: 'work_item_created',
      payload: {
        item: {
          ...workItem('item_bob'),
          owner_principal_id: BOB,
        },
      },
    });
    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'permission_granted',
      id: 'evt_bob_manage_owned_granted',
      payload: {
        grant: {
          format: 'icarus.collaboration-permission-grant/1',
          principal_id: BOB,
          grants: ['work_item:manage_owned'],
          revision: 1,
          updated_at_event: 'evt_bob_manage_owned_granted',
        },
      },
    });
    projection = apply(projection, {
      aggregateType: 'work_item',
      aggregateId: 'item_bob',
      eventType: 'work_item_details_updated',
      actor: BOB,
      payload: {
        item: {
          ...projection.workItems.item_bob!,
          title: 'Bob may update this item',
          revision: 2,
          updated_at: '2026-08-06T12:01:00.000Z',
        },
      },
    });

    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'permission_revoked',
      id: 'evt_bob_manage_owned_revoked',
      payload: {
        grant: {
          format: 'icarus.collaboration-permission-grant/1',
          principal_id: BOB,
          grants: [],
          revision: 2,
          updated_at_event: 'evt_bob_manage_owned_revoked',
        },
      },
    });
    expect(() =>
      apply(projection, {
        aggregateType: 'work_item',
        aggregateId: 'item_bob',
        eventType: 'work_item_details_updated',
        actor: BOB,
        payload: {
          item: {
            ...projection.workItems.item_bob!,
            title: 'Bob must not update after revocation',
            revision: 3,
            updated_at: '2026-08-06T12:02:00.000Z',
          },
        },
      }),
    ).toThrow(/cannot update/iu);

    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'permission_granted',
      id: 'evt_bob_manage_owned_restored',
      payload: {
        grant: {
          format: 'icarus.collaboration-permission-grant/1',
          principal_id: BOB,
          grants: ['work_item:manage_owned'],
          revision: 3,
          updated_at_event: 'evt_bob_manage_owned_restored',
        },
      },
    });
    projection = apply(projection, {
      aggregateType: 'work_item',
      aggregateId: 'item_bob',
      eventType: 'work_item_details_updated',
      actor: BOB,
      payload: {
        item: {
          ...projection.workItems.item_bob!,
          title: 'Bob may update after restoration',
          revision: 3,
          updated_at: '2026-08-06T12:03:00.000Z',
        },
      },
    });
    expect(projection.workItems.item_bob?.title).toBe(
      'Bob may update after restoration',
    );
  });

  it('requires an authorized issuer and consumes an unbound Invite once', () => {
    let projection = apply(withBob(), {
      aggregateType: 'group',
      aggregateId: 'group_test',
      eventType: 'group_settings_updated',
      payload: { membership_policy: { join: 'invite_only' } },
    });
    const invite = {
      format: 'icarus.collaboration-invite/1',
      invite_id: 'invite_carol',
      issued_by_principal_id: ALICE,
      status: 'active',
      issued_at: NOW,
      expires_at: null,
      used_at_event: null,
      revoked_at_event: null,
    };
    expect(() =>
      apply(projection, {
        aggregateType: 'invite',
        aggregateId: invite.invite_id,
        eventType: 'invite_issued',
        actor: BOB,
        payload: {
          invite: { ...invite, issued_by_principal_id: BOB },
        },
      }),
    ).toThrow(/invite|approve|authorized/iu);

    projection = apply(projection, {
      aggregateType: 'invite',
      aggregateId: invite.invite_id,
      eventType: 'invite_issued',
      payload: { invite },
    });
    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: BOB,
        eventType: 'membership_requested',
        actor: BOB,
        payload: {
          member: {
            ...projection.members[BOB],
            status: 'requested',
            joined_at_event: null,
          },
          client: {
            ...projection.clients[BOB]![BOB_CLIENT]!,
            registered_at_event: 'evt_active_request',
          },
          credential: {
            ...projection.credentials[BOB]![BOB_CREDENTIAL]!,
            created_at_event: 'evt_active_request',
          },
          invite_id: invite.invite_id,
        },
        id: 'evt_active_request',
      }),
    ).toThrow(/already|existing|active/iu);
    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: CAROL,
      eventType: 'membership_requested',
      actor: CAROL,
      client: CAROL_CLIENT,
      credential: CAROL_CREDENTIAL,
      id: 'evt_carol_request',
      payload: {
        member: {
          format: 'icarus.collaboration-member/3',
          principal_id: CAROL,
          display_name: 'Carol',
          status: 'requested',
          joined_at_event: null,
        },
        client: {
          format: 'icarus.collaboration-client/1',
          principal_id: CAROL,
          client_id: CAROL_CLIENT,
          display_name: 'Carol laptop',
          capabilities: [],
          status: 'active',
          registered_at_event: 'evt_carol_request',
        },
        credential: {
          format: 'icarus.collaboration-credential/1',
          credential_id: CAROL_CREDENTIAL,
          principal_id: CAROL,
          client_id: CAROL_CLIENT,
          public_key: CAROL_KEY,
          fingerprint: CAROL_FINGERPRINT,
          purpose: 'event_signing',
          status: 'active',
          created_at_event: 'evt_carol_request',
          revoked_at_event: null,
        },
        invite_id: invite.invite_id,
      },
    });
    expect(
      (
        projection as CollaborationProjectionV3 & {
          invites: Record<string, { status: string; used_at_event: string }>;
        }
      ).invites[invite.invite_id],
    ).toMatchObject({ status: 'used', used_at_event: 'evt_carol_request' });
    expect(() =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: CAROL,
        eventType: 'membership_requested',
        actor: CAROL,
        client: CAROL_CLIENT,
        credential: CAROL_CREDENTIAL,
        id: 'evt_carol_retry',
        payload: {
          member: {
            ...projection.members[CAROL],
            status: 'requested',
            joined_at_event: null,
          },
          client: {
            ...projection.clients[CAROL]![CAROL_CLIENT]!,
            registered_at_event: 'evt_carol_retry',
          },
          credential: {
            ...projection.credentials[CAROL]![CAROL_CREDENTIAL]!,
            created_at_event: 'evt_carol_retry',
          },
          invite_id: invite.invite_id,
        },
      }),
    ).toThrow(/Invite.*used|active/iu);
  });

  it('rejects missing, expired, and revoked Invites', () => {
    const request = (
      projection: CollaborationProjectionV3,
      inviteId: string | null,
      occurredAt = NOW,
    ) =>
      apply(projection, {
        aggregateType: 'membership',
        aggregateId: BOB,
        eventType: 'membership_requested',
        actor: BOB,
        occurredAt,
        payload: {
          member: {
            format: 'icarus.collaboration-member/3',
            principal_id: BOB,
            display_name: 'Bob',
            status: 'requested',
            joined_at_event: null,
          },
          client: {
            format: 'icarus.collaboration-client/1',
            principal_id: BOB,
            client_id: BOB_CLIENT,
            display_name: 'Bob laptop',
            capabilities: [],
            status: 'active',
            registered_at_event: 'evt_invite_request',
          },
          credential: {
            format: 'icarus.collaboration-credential/1',
            credential_id: BOB_CREDENTIAL,
            principal_id: BOB,
            client_id: BOB_CLIENT,
            public_key: BOB_KEY,
            fingerprint: BOB_FINGERPRINT,
            purpose: 'event_signing',
            status: 'active',
            created_at_event: 'evt_invite_request',
            revoked_at_event: null,
          },
          invite_id: inviteId,
        },
        id: 'evt_invite_request',
      });
    let base = apply(genesis(), {
      aggregateType: 'group',
      aggregateId: 'group_test',
      eventType: 'group_settings_updated',
      payload: { membership_policy: { join: 'invite_only' } },
    });
    expect(() => request(base, null)).toThrow(/Invite/iu);
    expect(() => request(base, 'invite_missing')).toThrow(/Invite/iu);

    const issue = (
      projection: CollaborationProjectionV3,
      inviteId: string,
      expiresAt: string | null,
    ) =>
      apply(projection, {
        aggregateType: 'invite',
        aggregateId: inviteId,
        eventType: 'invite_issued',
        payload: {
          invite: {
            format: 'icarus.collaboration-invite/1',
            invite_id: inviteId,
            issued_by_principal_id: ALICE,
            status: 'active',
            issued_at: NOW,
            expires_at: expiresAt,
            used_at_event: null,
            revoked_at_event: null,
          },
        },
      });
    const expired = issue(base, 'invite_expired', '2026-08-06T12:01:00.000Z');
    expect(() =>
      request(expired, 'invite_expired', '2026-08-06T12:02:00.000Z'),
    ).toThrow(/expired/iu);

    base = issue(base, 'invite_revoked', null);
    base = apply(base, {
      aggregateType: 'invite',
      aggregateId: 'invite_revoked',
      eventType: 'invite_revoked',
      payload: { reason: 'No longer needed' },
    });
    expect(() => request(base, 'invite_revoked')).toThrow(/revoked|active/iu);
  });
});
