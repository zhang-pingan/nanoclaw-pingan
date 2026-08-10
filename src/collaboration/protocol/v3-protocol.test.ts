import { describe, expect, it } from 'vitest';

import {
  canonicalJsonStringify,
  prettyCollaborationJson,
  strictParseJson,
} from './canonical-json.js';
import {
  buildCollaborationEventV3,
  collaborationCanonicalHashV3,
  collaborationDeadlineSnapshotHashV3,
  collaborationIdempotencyKeyV3,
  collaborationRecoveryRequestHashV3,
  collaborationRecoveryVerificationCodeV3,
  collaborationTurnInputHashV3,
  collaborationWorkflowDefinitionHashV3,
  reduceCollaborationEventV3,
  type CollaborationProjectionV3,
} from './v3-reducer.js';
import {
  collaborationEventV3Schema,
  groupDefinitionV3Schema,
  collaborationCredentialFingerprintV3,
  machineDefinitionV3Schema,
  parseV3ProtocolVersion,
  type CollaborationAggregateType,
  type CollaborationEventTypeV3,
  type CollaborationEventV3,
} from './v3-schema.js';

const NOW = '2026-08-06T12:00:00.000Z';
const ALICE = 'principal_00000000-0000-4000-8000-000000000001';
const BOB = 'principal_00000000-0000-4000-8000-000000000002';
const CLIENT = 'client_alice_mac';
const BOB_CLIENT = 'client_bob_mac';
const CREDENTIAL = 'credential_alice_mac';
const BOB_CREDENTIAL = 'credential_bob_mac';
const RECOVERY_CREDENTIAL = 'credential_alice_recovery';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice';
const FINGERPRINT = collaborationCredentialFingerprintV3(KEY);

function event(input: {
  projection?: CollaborationProjectionV3 | null;
  aggregateType: CollaborationAggregateType;
  aggregateId: string;
  eventType: CollaborationEventTypeV3;
  payload: Record<string, unknown>;
  id?: string;
  actor?: {
    principalId: string;
    clientId: string;
    credentialId: string;
  };
}): CollaborationEventV3 {
  const head =
    input.projection?.aggregateHeads[
      `${input.aggregateType}:${input.aggregateId}`
    ];
  return buildCollaborationEventV3({
    groupId: 'group_payment',
    eventId: input.id ?? `evt_${input.eventType}`,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateRevision: (head?.revision ?? 0) + 1,
    previousEventHash: head?.eventHash ?? null,
    eventType: input.eventType,
    actor: {
      principal_id: input.actor?.principalId ?? ALICE,
      client_id: input.actor?.clientId ?? CLIENT,
      credential_id: input.actor?.credentialId ?? CREDENTIAL,
      executor_id: null,
    },
    occurredAt: NOW,
    payload: input.payload,
  });
}

function genesis(): CollaborationEventV3 {
  return event({
    aggregateType: 'group',
    aggregateId: 'group_payment',
    eventType: 'group_initialized',
    id: 'evt_genesis',
    payload: {
      group: {
        format: 'icarus.collaboration-group/3',
        protocol_version: 3,
        group_id: 'group_payment',
        name: 'Payment project',
        creator: {
          principal_id: ALICE,
        },
        owner_principal_id: ALICE,
        control_branch: 'refs/heads/icarus/control',
        lifecycle: 'active',
        membership_policy: { join: 'open' },
        visibility_policy: { observer_access: 'allowed' },
        default_permission_template_id: 'member.v1',
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
        client_id: CLIENT,
        display_name: 'Alice MacBook',
        capabilities: [],
        status: 'active',
        registered_at_event: 'evt_genesis',
      },
      credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: CREDENTIAL,
        principal_id: ALICE,
        client_id: CLIENT,
        public_key: KEY,
        fingerprint: FINGERPRINT,
        purpose: 'event_signing',
        status: 'active',
        created_at_event: 'evt_genesis',
        revoked_at_event: null,
      },
      recovery_credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: RECOVERY_CREDENTIAL,
        principal_id: ALICE,
        client_id: CLIENT,
        public_key: KEY,
        fingerprint: FINGERPRINT,
        purpose: 'group_recovery',
        status: 'active',
        created_at_event: 'evt_genesis',
        revoked_at_event: null,
      },
      owner_permissions: {
        format: 'icarus.collaboration-permission-grant/1',
        principal_id: ALICE,
        grants: [],
        revision: 1,
        updated_at_event: 'evt_genesis',
      },
    },
  });
}

function workItem(revision = 1) {
  return {
    format: 'icarus.collaboration-work-item/1' as const,
    work_item_id: 'wi_101',
    type: 'task' as const,
    title: 'Automatic renewal',
    description: 'Ship renewal and failure notification.',
    status: 'open' as const,
    priority: 'high' as const,
    creator_principal_id: ALICE,
    owner_principal_id: ALICE,
    preferred_executor_id: null,
    contributors: [],
    watchers: [],
    acceptance_criteria: ['Renewal can be enabled'],
    labels: ['payment'],
    due_at: null,
    parent_id: null,
    blocked_by: [],
    related_items: [],
    primary_workflow_instance_id: null,
    assignment_status: 'accepted' as const,
    created_at: NOW,
    updated_at: NOW,
    closed_at: null,
    revision,
    archived: false,
  };
}

describe('Collaboration project space v3 contract', () => {
  it('allows only the immediate audited default grant after open registration', () => {
    const initial = reduceCollaborationEventV3(null, genesis());
    const registrationEvent = event({
      projection: initial,
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'member_registered',
      id: 'evt_bob_registered',
      actor: {
        principalId: BOB,
        clientId: BOB_CLIENT,
        credentialId: BOB_CREDENTIAL,
      },
      payload: {
        member: {
          format: 'icarus.collaboration-member/3',
          principal_id: BOB,
          display_name: 'Bob',
          status: 'active',
          joined_at_event: 'evt_bob_registered',
        },
        client: {
          format: 'icarus.collaboration-client/1',
          principal_id: BOB,
          client_id: BOB_CLIENT,
          display_name: 'Bob MacBook',
          capabilities: [],
          status: 'active',
          registered_at_event: 'evt_bob_registered',
        },
        credential: {
          format: 'icarus.collaboration-credential/1',
          credential_id: BOB_CREDENTIAL,
          principal_id: BOB,
          client_id: BOB_CLIENT,
          public_key: KEY,
          fingerprint: FINGERPRINT,
          purpose: 'event_signing',
          status: 'active',
          created_at_event: 'evt_bob_registered',
          revoked_at_event: null,
        },
      },
    });
    const registered = reduceCollaborationEventV3(initial, registrationEvent);
    const memberPermissions = [
      'workspace:publish_owned',
      'work_item:create',
      'work_item:manage_owned',
      'discussion:create',
      'discussion:post',
    ];
    const immediateGrant = event({
      projection: registered,
      aggregateType: 'membership',
      aggregateId: BOB,
      eventType: 'permission_granted',
      id: 'evt_bob_default_permissions',
      actor: {
        principalId: BOB,
        clientId: BOB_CLIENT,
        credentialId: BOB_CREDENTIAL,
      },
      payload: {
        grant: {
          format: 'icarus.collaboration-permission-grant/1',
          principal_id: BOB,
          grants: memberPermissions,
          revision: 1,
          updated_at_event: 'evt_bob_default_permissions',
        },
      },
    });
    expect(
      reduceCollaborationEventV3(registered, immediateGrant, {
        previousEventInAtomicBatch: registrationEvent,
      }).permissionGrants[BOB]?.grants,
    ).toEqual(memberPermissions);

    const settingsChanged = reduceCollaborationEventV3(
      registered,
      event({
        projection: registered,
        aggregateType: 'group',
        aggregateId: 'group_payment',
        eventType: 'group_settings_updated',
        id: 'evt_default_changed',
        payload: { default_permission_template_id: 'contributor.v1' },
      }),
    );
    expect(() =>
      reduceCollaborationEventV3(
        settingsChanged,
        event({
          projection: settingsChanged,
          aggregateType: 'membership',
          aggregateId: BOB,
          eventType: 'permission_granted',
          id: 'evt_bob_delayed_permissions',
          actor: {
            principalId: BOB,
            clientId: BOB_CLIENT,
            credentialId: BOB_CREDENTIAL,
          },
          payload: {
            grant: {
              format: 'icarus.collaboration-permission-grant/1',
              principal_id: BOB,
              grants: [...memberPermissions, 'workspace:write_shared'],
              revision: 1,
              updated_at_event: 'evt_bob_delayed_permissions',
            },
          },
        }),
      ),
    ).toThrow(/cannot change direct permission grants/u);
  });

  it('uses strict JSON and RFC 8785 canonical hashes', () => {
    expect(canonicalJsonStringify({ z: 1, a: { y: true, x: 'v' } })).toBe(
      '{"a":{"x":"v","y":true},"z":1}',
    );
    expect(collaborationCanonicalHashV3({ b: 2, a: 1 })).toBe(
      collaborationCanonicalHashV3({ a: 1, b: 2 }),
    );
    expect(prettyCollaborationJson({ b: 2, a: 1 })).toBe(
      '{\n  "b": 2,\n  "a": 1\n}\n',
    );
    expect(() => strictParseJson('{"a":1,"a":2}')).toThrow(
      /Duplicate object key/u,
    );
  });

  it('accepts only the current Group format and a Group without Workflow', () => {
    expect(parseV3ProtocolVersion(3)).toBe(3);
    expect(() => parseV3ProtocolVersion(2)).toThrow(/only v3 is current/u);
    expect(() =>
      groupDefinitionV3Schema.parse({
        ...(genesis().payload.group as Record<string, unknown>),
        format: 'icarus.agent-group/2',
      }),
    ).toThrow();
    expect(() =>
      collaborationEventV3Schema.parse({
        ...genesis(),
        event_type: 'client_registered',
      }),
    ).toThrow();

    const projection = reduceCollaborationEventV3(null, genesis());
    expect(projection.group.lifecycle).toBe('active');
    expect(projection.workflowDefinitions).toEqual({});
    expect(projection.workflowInstances).toEqual({});
  });

  it('rejects v2 owner_role and validates Principal/participant assignment', () => {
    expect(() =>
      machineDefinitionV3Schema.parse({
        format: 'icarus.collaboration-machine/3',
        initial_state: 'build',
        states: {
          build: {
            label: 'Build',
            owner_role: 'developer',
            terminal: false,
            transitions: [
              { outcome: 'done', label: 'Done', target_state: 'complete' },
            ],
          },
          complete: { label: 'Complete', terminal: true, transitions: [] },
        },
      }),
    ).toThrow();

    expect(
      machineDefinitionV3Schema.parse({
        format: 'icarus.collaboration-machine/3',
        initial_state: 'build',
        states: {
          build: {
            label: 'Build',
            description: '',
            assignee: { type: 'participant_slot', slot: 'developer' },
            terminal: false,
            transitions: [
              { outcome: 'done', label: 'Done', target_state: 'complete' },
            ],
          },
          complete: {
            label: 'Complete',
            description: '',
            terminal: true,
            transitions: [],
          },
        },
      }).states.build?.assignee,
    ).toEqual({ type: 'participant_slot', slot: 'developer' });
  });

  it('maintains independent Aggregate revisions without a global sequence', () => {
    let projection = reduceCollaborationEventV3(null, genesis());
    const created = event({
      projection,
      aggregateType: 'work_item',
      aggregateId: 'wi_101',
      eventType: 'work_item_created',
      payload: { item: workItem() },
    });
    projection = reduceCollaborationEventV3(projection, created);

    const progress = event({
      projection,
      aggregateType: 'workspace',
      aggregateId: ALICE,
      eventType: 'progress_update_posted',
      payload: {
        update: {
          format: 'icarus.collaboration-progress-update/1',
          update_id: 'update_1',
          principal_id: ALICE,
          summary: 'Backend complete',
          completed: ['API'],
          in_progress: [],
          next_steps: ['UI'],
          blockers: [],
          work_item_refs: ['wi_101'],
          workflow_instance_refs: [],
          artifact_refs: [],
          origin: 'human',
          actor_client_id: CLIENT,
          executor_id: null,
          created_at: NOW,
        },
      },
    });
    projection = reduceCollaborationEventV3(projection, progress);

    expect(projection.aggregateHeads['work_item:wi_101']?.revision).toBe(1);
    expect(projection.aggregateHeads[`workspace:${ALICE}`]?.revision).toBe(1);
    expect(projection.progressUpdates.update_1?.summary).toBe(
      'Backend complete',
    );

    expect(() =>
      reduceCollaborationEventV3(projection, {
        ...created,
        event_id: 'evt_stale',
      }),
    ).toThrow(/Aggregate revision conflict/u);
  });

  it('binds rotation, multi-client recovery, revocation, and offline Owner recovery to Credentials', () => {
    let projection = reduceCollaborationEventV3(null, genesis());
    const rotatedCredentialId = 'credential_alice_rotated';
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'membership',
        aggregateId: ALICE,
        eventType: 'credential_rotated',
        id: 'evt_credential_rotated',
        payload: {
          credential: {
            format: 'icarus.collaboration-credential/1',
            credential_id: rotatedCredentialId,
            principal_id: ALICE,
            client_id: CLIENT,
            public_key: KEY,
            fingerprint: FINGERPRINT,
            purpose: 'event_signing',
            status: 'active',
            created_at_event: 'evt_credential_rotated',
            revoked_at_event: null,
          },
          revoke_credential_id: null,
        },
      }),
    );
    expect(projection.credentials[ALICE]?.[CREDENTIAL]?.status).toBe('active');
    expect(
      projection.credentials[ALICE]?.[rotatedCredentialId]?.principal_id,
    ).toBe(ALICE);

    const phoneClient = 'client_alice_phone';
    const phoneCredential = 'credential_alice_phone';
    const recoveryId = 'recovery_alice_phone';
    const recoveryImmutable = {
      format: 'icarus.collaboration-recovery-request/1' as const,
      request_id: recoveryId,
      type: 'identity_recovery' as const,
      target_principal_id: ALICE,
      requested_client: {
        format: 'icarus.collaboration-client/1' as const,
        principal_id: ALICE,
        client_id: phoneClient,
        display_name: 'Alice phone',
        capabilities: [],
        status: 'active' as const,
        registered_at_event: 'evt_phone_recovery',
      },
      requested_credential: {
        format: 'icarus.collaboration-credential/1' as const,
        credential_id: phoneCredential,
        principal_id: ALICE,
        client_id: phoneClient,
        public_key: KEY,
        fingerprint: FINGERPRINT,
        purpose: 'event_signing' as const,
        status: 'active' as const,
        created_at_event: 'evt_phone_recovery',
        revoked_at_event: null,
      },
      reason: null,
      created_at: NOW,
      expires_at: '2026-08-07T12:00:00.000Z',
    };
    const recoveryHash = collaborationRecoveryRequestHashV3(recoveryImmutable);
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'recovery',
        aggregateId: recoveryId,
        eventType: 'identity_recovery_requested',
        id: 'evt_phone_recovery',
        actor: {
          principalId: ALICE,
          clientId: phoneClient,
          credentialId: phoneCredential,
        },
        payload: {
          request: {
            ...recoveryImmutable,
            request_hash: recoveryHash,
            status: 'pending',
            decided_at_event: null,
            decided_by_principal_id: null,
            decision_reason: null,
            approval_kind: null,
            revoked_credential_ids: [],
          },
        },
      }),
    );
    expect(projection.clients[ALICE]?.[phoneClient]).toBeUndefined();
    expect(collaborationRecoveryVerificationCodeV3(recoveryHash)).toMatch(
      /^\d{6}$/u,
    );
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'recovery',
        aggregateId: recoveryId,
        eventType: 'recovery_approved',
        id: 'evt_phone_approved',
        actor: {
          principalId: ALICE,
          clientId: CLIENT,
          credentialId: rotatedCredentialId,
        },
        payload: {
          request_hash: recoveryHash,
          reason: 'Verification code matched',
          revoke_previous_credentials: false,
          revoke_credential_ids: [],
        },
      }),
    );
    expect(projection.clients[ALICE]?.[phoneClient]?.status).toBe('active');
    expect(projection.recoveryRequests[recoveryId]?.approval_kind).toBe(
      'self_device',
    );

    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'membership',
        aggregateId: ALICE,
        eventType: 'credential_revoked',
        id: 'evt_original_revoked',
        actor: {
          principalId: ALICE,
          clientId: CLIENT,
          credentialId: rotatedCredentialId,
        },
        payload: {
          credential_id: CREDENTIAL,
          reason: 'Old key retired',
        },
      }),
    );
    expect(projection.credentials[ALICE]?.[CREDENTIAL]).toMatchObject({
      status: 'revoked',
      revoked_at_event: 'evt_original_revoked',
    });

    const rescueClient = 'client_alice_rescue';
    const rescueCredential = 'credential_alice_rescue';
    const ownerRecoveryId = 'recovery_alice_owner';
    const ownerImmutable = {
      ...recoveryImmutable,
      request_id: ownerRecoveryId,
      type: 'owner_recovery' as const,
      requested_client: {
        ...recoveryImmutable.requested_client,
        client_id: rescueClient,
        display_name: 'Alice rescue laptop',
        registered_at_event: 'evt_owner_recovery',
      },
      requested_credential: {
        ...recoveryImmutable.requested_credential,
        credential_id: rescueCredential,
        client_id: rescueClient,
        created_at_event: 'evt_owner_recovery',
      },
      reason: 'All online signing Credentials are unavailable',
    };
    const ownerHash = collaborationRecoveryRequestHashV3(ownerImmutable);
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'recovery',
        aggregateId: ownerRecoveryId,
        eventType: 'owner_recovery_requested',
        id: 'evt_owner_recovery',
        actor: {
          principalId: ALICE,
          clientId: rescueClient,
          credentialId: rescueCredential,
        },
        payload: {
          request: {
            ...ownerImmutable,
            request_hash: ownerHash,
            status: 'pending',
            decided_at_event: null,
            decided_by_principal_id: null,
            decision_reason: null,
            approval_kind: null,
            revoked_credential_ids: [],
          },
        },
      }),
    );
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'recovery',
        aggregateId: ownerRecoveryId,
        eventType: 'recovery_approved',
        id: 'evt_owner_recovery_approved',
        actor: {
          principalId: ALICE,
          clientId: CLIENT,
          credentialId: RECOVERY_CREDENTIAL,
        },
        payload: {
          request_hash: ownerHash,
          reason: 'Offline identity verification completed',
          revoke_previous_credentials: false,
          revoke_credential_ids: [phoneCredential],
        },
      }),
    );
    expect(projection.recoveryRequests[ownerRecoveryId]).toMatchObject({
      status: 'approved',
      approval_kind: 'offline_owner',
      revoked_credential_ids: [phoneCredential],
    });
    expect(projection.credentials[ALICE]?.[phoneCredential]?.status).toBe(
      'revoked',
    );
    expect(projection.credentials[ALICE]?.[rotatedCredentialId]?.status).toBe(
      'active',
    );
    expect(projection.credentials[ALICE]?.[rescueCredential]?.status).toBe(
      'active',
    );
    expect(() =>
      reduceCollaborationEventV3(
        projection,
        event({
          projection,
          aggregateType: 'recovery',
          aggregateId: ownerRecoveryId,
          eventType: 'recovery_rejected',
          actor: {
            principalId: ALICE,
            clientId: CLIENT,
            credentialId: rotatedCredentialId,
          },
          payload: {
            request_hash: ownerHash,
            reason: 'second terminal decision',
            revoke_previous_credentials: false,
            revoke_credential_ids: [],
          },
        }),
      ),
    ).toThrow(/not pending/u);
  });

  it('preserves layout isolation and defaults an unconfigured State to manual', () => {
    let projection = reduceCollaborationEventV3(null, genesis());
    const machine = machineDefinitionV3Schema.parse({
      format: 'icarus.collaboration-machine/3',
      initial_state: 'build',
      states: {
        build: {
          label: 'Build',
          description: '',
          assignee: { type: 'participant_slot', slot: 'developer' },
          terminal: false,
          timeout_policy: {
            start_timeout_ms: 60_000,
            execution_timeout_ms: 120_000,
            reminder_interval_ms: 30_000,
            on_timeout: 'notify_only',
          },
          transitions: [
            { outcome: 'done', label: 'Done', target_state: 'complete' },
          ],
        },
        complete: {
          label: 'Complete',
          description: '',
          terminal: true,
          transitions: [],
        },
      },
    });
    const layout = {
      format: 'icarus.collaboration-workflow-layout/1' as const,
      view: 'participants' as const,
      nodes: { build: { x: 80, y: 120 } },
      revision: 1,
    };
    const definition = {
      format: 'icarus.collaboration-workflow-definition/1' as const,
      definition_id: 'delivery',
      name: 'Delivery',
      description: '',
      version: 1,
      created_by_principal_id: ALICE,
      published_by_principal_id: ALICE,
      status: 'published' as const,
      launch_policy: {
        group_admin: true,
        work_item_owner: true,
        principals: [],
      },
      machine_ref: 'workflows/definitions/delivery/machine.json',
      layout_ref: 'workflows/definitions/delivery/layout.json',
      machine_hash: collaborationCanonicalHashV3(machine),
      layout_hash: collaborationCanonicalHashV3(layout),
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    };
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'workflow_definition',
        aggregateId: 'delivery',
        eventType: 'workflow_definition_published',
        payload: { definition, machine, layout },
      }),
    );
    const machineHash = definition.machine_hash;
    const nextLayout = {
      ...layout,
      nodes: { build: { x: 420, y: 240 } },
      revision: 2,
    };
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'workflow_definition',
        aggregateId: 'delivery',
        eventType: 'workflow_layout_updated',
        payload: {
          definition_id: 'delivery',
          version: 1,
          layout: nextLayout,
          layout_hash: collaborationCanonicalHashV3(nextLayout),
        },
      }),
    );
    expect(
      projection.workflowDefinitions['delivery@1']?.definition.machine_hash,
    ).toBe(machineHash);

    const storedDefinition = projection.workflowDefinitions['delivery@1']!;
    const instance = {
      format: 'icarus.collaboration-workflow-instance/1' as const,
      instance_id: 'wfi_201',
      definition_id: 'delivery',
      definition_version: 1,
      definition_hash: collaborationWorkflowDefinitionHashV3(
        storedDefinition.definition,
        storedDefinition.machine,
      ),
      scope: { type: 'group' as const },
      related_work_item_refs: [],
      participant_bindings: { developer: ALICE },
      resolved_assignments: { build: ALICE },
      work_item_status_mapping: {},
      lifecycle: 'ready' as const,
      business_state: 'build',
      active_turn_id: null,
      last_completed_turn_id: null,
      last_handoff_hash: null,
      epoch: 1,
      revision: 1,
      created_by_principal_id: ALICE,
      created_at: NOW,
      updated_at: NOW,
    };
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'workflow_instance',
        aggregateId: 'wfi_201',
        eventType: 'workflow_instance_created',
        payload: { instance },
      }),
    );
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'workflow_instance',
        aggregateId: 'wfi_201',
        eventType: 'workflow_instance_started',
        payload: {},
      }),
    );

    const timeout = machine.states.build?.timeout_policy ?? null;
    const startDeadline = '2026-08-06T12:01:00.000Z';
    const inputHash = collaborationTurnInputHashV3({
      groupId: 'group_payment',
      instanceId: 'wfi_201',
      epoch: 1,
      stateId: 'build',
      assigneePrincipalId: ALICE,
      execution: null,
      incomingHandoffHash: null,
      workItem: null,
    });
    const turn = {
      format: 'icarus.collaboration-turn/1' as const,
      turn_id: 'turn_1',
      workflow_instance_id: 'wfi_201',
      state_id: 'build',
      assignee_principal_id: ALICE,
      claimant_principal_id: null,
      claimant_client_id: null,
      executor_id: null,
      attempt: 1,
      fencing_token: null,
      execution_mode: 'manual' as const,
      state: 'pending' as const,
      action_ref: null,
      action_hash: null,
      prompt_hash: null,
      input_hash: inputHash,
      idempotency_key: collaborationIdempotencyKeyV3({
        groupId: 'group_payment',
        instanceId: 'wfi_201',
        epoch: 1,
        turnId: 'turn_1',
        attempt: 1,
        inputHash,
      }),
      incoming_handoff: null,
      incoming_handoff_hash: null,
      timeout_policy_snapshot: timeout,
      start_deadline_at: startDeadline,
      execution_deadline_at: null,
      deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
        turnId: 'turn_1',
        attempt: 1,
        timeoutPolicy: timeout,
        startDeadlineAt: startDeadline,
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
    projection = reduceCollaborationEventV3(
      projection,
      event({
        projection,
        aggregateType: 'workflow_instance',
        aggregateId: 'wfi_201',
        eventType: 'turn_created',
        payload: { turn },
      }),
    );
    expect(projection.turns.turn_1?.execution_mode).toBe('manual');
    expect(projection.stateExecutions.wfi_201).toBeUndefined();
  });
});
