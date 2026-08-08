import { describe, expect, it } from 'vitest';

import {
  buildCollaborationEventV3,
  collaborationCanonicalHashV3,
  collaborationDeadlineSnapshotHashV3,
  collaborationFencingTokenV3,
  collaborationIdempotencyKeyV3,
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

const NOW = '2026-08-06T12:00:00.000Z';
const ALICE = 'principal_sha256_alice';
const BOB = 'principal_sha256_bob';
const ALICE_CLIENT = 'client_alice';
const BOB_CLIENT = 'client_bob';
const BOB_CLIENT_2 = 'client_bob_second';
const HASH = `sha256:${'a'.repeat(64)}`;
const ALICE_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice';
const BOB_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEbob00';

let eventOrdinal = 0;

function event(input: {
  projection: CollaborationProjectionV3 | null;
  aggregateType: CollaborationAggregateType;
  aggregateId: string;
  eventType: CollaborationEventTypeV3;
  payload: Record<string, unknown>;
  actor?: string;
  client?: string;
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
          signing_key_ref: 'ssh-ed25519:SHA256:alice',
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
        signing_key_ref: 'ssh-ed25519:SHA256:alice',
        signing_public_key: ALICE_KEY,
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
        signing_key_ref: 'ssh-ed25519:SHA256:bob',
        signing_public_key: BOB_KEY,
        status: 'active',
        joined_at_event: joinEventId,
      },
    },
  });
  projection = apply(projection, {
    aggregateType: 'membership',
    aggregateId: BOB,
    eventType: 'client_registered',
    actor: BOB,
    payload: {
      client: {
        format: 'icarus.collaboration-client/1',
        principal_id: BOB,
        client_id: BOB_CLIENT,
        display_name: 'Bob MacBook',
        capabilities: [],
        status: 'active',
        registered_at_event: 'evt_bob_client',
      },
    },
    id: 'evt_bob_client',
  });
  if (secondClient)
    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'client_registered',
      actor: BOB,
      client: BOB_CLIENT_2,
      id: 'evt_bob_client_2',
      payload: {
        client: {
          format: 'icarus.collaboration-client/1',
          principal_id: BOB,
          client_id: BOB_CLIENT_2,
          display_name: 'Bob Desktop',
          capabilities: [],
          status: 'active',
          registered_at_event: 'evt_bob_client_2',
        },
      },
    });
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
      registered_at_event: 'evt_executor_bob',
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
      registered_at_event: 'evt_executor_bob',
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
      registered_at_event: 'evt_executor_bob',
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

    expect(
      apply(fixture.projection, {
        aggregateType: 'workflow_instance',
        aggregateId: 'instance_1',
        eventType: 'turn_cancelled',
        payload: {
          turn_id: 'turn_1',
          attempt: 1,
          fencing_token: null,
          reason: 'Cancelled by creator',
        },
      }).turns.turn_1?.state,
    ).toBe('cancelled');
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
        actor: ALICE,
        id: 'evt_missing_execution',
        payload: {
          execution: stateExecution(
            1,
            'evt_missing_execution',
            'review',
            ALICE,
          ),
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
  });

  it('rejects reassignment to a missing or different Definition State', () => {
    const fixture = workflowFixture();
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

  it('requires an authorized issuer and consumes a targeted Invite once', () => {
    let projection = apply(withBob(), {
      aggregateType: 'group',
      aggregateId: 'group_test',
      eventType: 'group_settings_updated',
      payload: { membership_policy: { join: 'invite_only' } },
    });
    const invite = {
      format: 'icarus.collaboration-invite/1',
      invite_id: 'invite_carol',
      principal_id: 'principal_sha256_carol',
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
    const activeMemberInvite = {
      ...invite,
      invite_id: 'invite_active_bob',
      principal_id: BOB,
    };
    projection = apply(projection, {
      aggregateType: 'invite',
      aggregateId: activeMemberInvite.invite_id,
      eventType: 'invite_issued',
      payload: { invite: activeMemberInvite },
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
          invite_id: activeMemberInvite.invite_id,
        },
      }),
    ).toThrow(/already|existing|active/iu);
    projection = apply(projection, {
      aggregateType: 'membership',
      aggregateId: invite.principal_id,
      eventType: 'membership_requested',
      actor: invite.principal_id,
      client: 'client_carol',
      id: 'evt_carol_request',
      payload: {
        member: {
          format: 'icarus.collaboration-member/3',
          principal_id: invite.principal_id,
          display_name: 'Carol',
          signing_key_ref: 'ssh-ed25519:SHA256:carol',
          signing_public_key:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEcarol',
          status: 'requested',
          joined_at_event: null,
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
        aggregateId: invite.principal_id,
        eventType: 'membership_requested',
        actor: invite.principal_id,
        client: 'client_carol',
        payload: {
          member: {
            ...projection.members[invite.principal_id],
            status: 'requested',
            joined_at_event: null,
          },
          invite_id: invite.invite_id,
        },
      }),
    ).toThrow(/Invite.*used|active/iu);
  });

  it('rejects missing, wrong-target, expired, and revoked Invites', () => {
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
            signing_key_ref: 'ssh-ed25519:SHA256:bob',
            signing_public_key: BOB_KEY,
            status: 'requested',
            joined_at_event: null,
          },
          invite_id: inviteId,
        },
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
      principalId: string,
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
            principal_id: principalId,
            issued_by_principal_id: ALICE,
            status: 'active',
            issued_at: NOW,
            expires_at: expiresAt,
            used_at_event: null,
            revoked_at_event: null,
          },
        },
      });
    const wrong = issue(base, 'invite_wrong', ALICE, null);
    expect(() => request(wrong, 'invite_wrong')).toThrow(/target|Principal/iu);

    const expired = issue(
      base,
      'invite_expired',
      BOB,
      '2026-08-06T12:01:00.000Z',
    );
    expect(() =>
      request(expired, 'invite_expired', '2026-08-06T12:02:00.000Z'),
    ).toThrow(/expired/iu);

    base = issue(base, 'invite_revoked', BOB, null);
    base = apply(base, {
      aggregateType: 'invite',
      aggregateId: 'invite_revoked',
      eventType: 'invite_revoked',
      payload: { reason: 'No longer needed' },
    });
    expect(() => request(base, 'invite_revoked')).toThrow(/revoked|active/iu);
  });
});
