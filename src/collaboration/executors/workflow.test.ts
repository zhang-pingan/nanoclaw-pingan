import crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkflowExecutionHostService,
  type FiniteWorkflowCreationTemplate,
  type FiniteWorkflowRunObservation,
  type WorkflowExecutionHostGateway,
} from '../../workflow-execution/host-service.js';
import type { WorkflowRuntimeStore } from '../../workflow-runtime/gateway/connection.js';
import type { CollaborationExecutorBindingV3 } from '../project-space-store.js';
import type {
  ActionDefinitionV3,
  CollaborationTurnV3,
} from '../protocol/v3-schema.js';
import { WorkflowActionExecutor } from './workflow.js';
import type { ActionRequest } from './types.js';

function hash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

const prompt = 'Run the finite workflow.';
const operationKey = `sha256:${'a'.repeat(64)}`;
const creationTemplate = {
  principalRef: 'principal:alice',
  recipe: {
    rowId: 'recipe-row',
    resourceType: 'recipe',
    ref: { id: 'local-review', version: '1.0.0' },
    hash: `sha256:${'1'.repeat(64)}`,
  },
  routingScope: {
    rowId: 'routing-row',
    resourceType: 'routing_scope',
    ref: { id: 'local', version: '1.0.0' },
    hash: `sha256:${'2'.repeat(64)}`,
  },
  input: { id: 'input-value', hash: `sha256:${'3'.repeat(64)}` },
  attachments: {
    id: 'attachments-value',
    hash: `sha256:${'4'.repeat(64)}`,
  },
  ownershipHash: `sha256:${'5'.repeat(64)}`,
  initialActivation: {},
} as unknown as FiniteWorkflowCreationTemplate;

function action(): ActionDefinitionV3 {
  return {
    format: 'icarus.collaboration-action/1',
    action_id: 'workflow-action',
    name: 'Review workflow',
    owner_principal_id: 'principal_alice',
    version: 1,
    kind: 'workflow',
    adapter: null,
    workflow_ref: 'workflow:local-review',
    prompt_ref: 'prompts/workflow.md',
    prompt_hash: hash(prompt),
    executor_policy: 'principal_selected',
    filesystem_access: 'read_only',
    result_schema: { ref: 'workflow-result@1', schema: null },
  };
}

function binding(): CollaborationExecutorBindingV3 {
  return {
    groupId: 'group_test',
    instanceId: 'instance_1',
    stateId: 'review',
    principalId: 'principal_alice',
    clientId: 'client_1',
    actionHash: `sha256:${'d'.repeat(64)}`,
    promptHash: hash(prompt),
    executorId: 'executor_local',
    executorKind: 'workflow',
    workspacePath: '/tmp/workspace',
    filesystemAccess: 'read_only',
    approvalPolicy: 'never',
    config: {
      workflow_launch_profile: {
        format: 'icarus.collaboration-workflow-launch-profile/1',
        workflow_ref: 'workflow:local-review',
        prompt_sha256: hash(prompt),
        template: creationTemplate,
      },
    },
    enabled: true,
    updatedAtMs: 1,
  };
}

function turn(): CollaborationTurnV3 {
  return {
    format: 'icarus.collaboration-turn/1',
    turn_id: 'turn_1',
    workflow_instance_id: 'instance_1',
    state_id: 'review',
    assignee_principal_id: 'principal_alice',
    claimant_principal_id: 'principal_alice',
    claimant_client_id: 'client_1',
    executor_id: 'executor_local',
    attempt: 1,
    fencing_token: `sha256:${'b'.repeat(64)}`,
    execution_mode: 'automatic',
    state: 'running',
    action_ref: 'actions/review/action.json',
    action_hash: `sha256:${'d'.repeat(64)}`,
    prompt_hash: hash(prompt),
    input_hash: `sha256:${'e'.repeat(64)}`,
    idempotency_key: operationKey,
    incoming_handoff: null,
    incoming_handoff_hash: null,
    timeout_policy_snapshot: null,
    start_deadline_at: null,
    execution_deadline_at: null,
    deadline_snapshot_hash: `sha256:${'f'.repeat(64)}`,
    created_at: '2026-08-06T00:00:00.000Z',
    started_at: '2026-08-06T00:00:01.000Z',
    completed_at: null,
    outcome: null,
    handoff: null,
    handoff_hash: null,
    executor_result: null,
    executor_result_hash: null,
    completion_hash: null,
    recovery_reason: null,
  };
}

function request(): ActionRequest {
  return {
    executionId: 'collaboration:workflow-1',
    operationKey,
    groupId: 'group_test',
    instanceId: 'instance_1',
    turn: turn(),
    epoch: 1,
    action: action(),
    prompt,
    state: {
      label: 'Review',
      description: 'Review the workflow output.',
      assignee: { type: 'principal', principal_id: 'principal_alice' },
      terminal: false,
      transitions: [
        {
          outcome: 'ready_for_test',
          label: 'Ready for test',
          target_state: 'complete',
        },
      ],
    },
    binding: binding(),
  };
}

function observation(
  state: FiniteWorkflowRunObservation['state'],
): FiniteWorkflowRunObservation {
  return {
    state,
    workflowId: 'workflow:with:colons',
    graphRunId: 'run:with:colons',
    lifecycle: state === 'running' ? 'executing' : 'closed',
    control: 'running',
    operationalState: 'healthy',
    outcomeKind:
      state === 'succeeded'
        ? 'normal'
        : state === 'cancelled'
          ? 'cancelled'
          : state === 'failed'
            ? 'errored'
            : null,
    exitName: state === 'succeeded' ? 'done' : null,
    outputHash: state === 'succeeded' ? `sha256:${'c'.repeat(64)}` : null,
    output:
      state === 'succeeded'
        ? {
            format: 'icarus.collaboration-action-result/3',
            outcome: 'ready_for_test',
            summary: 'Workflow reviewed the change.',
            instruction: '',
            markers: [],
            data: { reviewed: true },
            artifacts: [],
            error: null,
          }
        : null,
    errorCode: state === 'failed' ? 'workflow_failed' : null,
  };
}

describe('Workflow Action integration', () => {
  it('uses the workflow-execution host service and stable Runtime receipt', async () => {
    let current = observation('running');
    const host = {
      startCollaborationFiniteRun: vi.fn(() => ({
        disposition: 'created' as const,
        workflowId: 'workflow:with:colons',
        intakeId: 'intake:1',
        creationRequestId: 'creation:1',
        activation: {
          activationId: 'activation:1',
          graphRunId: 'run:with:colons',
          rootScopeId: 'scope:1',
          rootBuildId: 'build:1',
          disposition: 'activated' as const,
        },
      })),
      observeFiniteRun: vi.fn(() => current),
      recoverFiniteRun: vi.fn(() => current),
    };
    const executor = new WorkflowActionExecutor(host);
    const prepared = await executor.prepare(request());
    const receipt = await executor.dispatch(prepared);
    expect(host.startCollaborationFiniteRun).toHaveBeenCalledWith({
      workflowRef: 'workflow:local-review',
      operationKey,
      promptSha256: hash(prompt),
      actionInput: prepared.actionInput,
      bindingConfig: binding().config,
    });
    expect(receipt).toMatchObject({
      executionRef: expect.stringMatching(/^collaboration-action:/),
      providerMetadata: {
        workflow_id: 'workflow:with:colons',
        graph_run_id: 'run:with:colons',
      },
    });
    expect(await executor.observe(receipt.executionRef)).toMatchObject({
      state: 'running',
    });
    current = observation('succeeded');
    expect(await executor.observe(receipt.executionRef)).toMatchObject({
      state: 'succeeded',
      result: {
        outcome: 'ready_for_test',
        data: { reviewed: true },
      },
      resultHash: expect.stringMatching(/^sha256:/),
    });
  });

  it('recovers a terminal run without fabricating Workflow graph/outbox context', async () => {
    const host = {
      startCollaborationFiniteRun: vi.fn(),
      observeFiniteRun: vi.fn(),
      recoverFiniteRun: vi.fn(() => observation('failed')),
    };
    const executor = new WorkflowActionExecutor(host);
    expect(
      await executor.recover('collaboration-action:opaque', {
        workflow_id: 'workflow:with:colons',
        graph_run_id: 'run:with:colons',
      }),
    ).toMatchObject({
      state: 'failed',
      result: null,
      resultHash: null,
    });
  });

  it('blocks stale host-resolved input instead of inventing Runtime values', async () => {
    const selected = request();
    const profile = selected.binding.config.workflow_launch_profile as Record<
      string,
      unknown
    >;
    const staleBinding = {
      ...selected.binding,
      config: {
        workflow_launch_profile: {
          ...profile,
          prompt_sha256: hash('old prompt'),
        },
      },
    };
    const executor = new WorkflowActionExecutor({
      startCollaborationFiniteRun: vi.fn(() => {
        throw new Error(
          'Workflow launch profile does not match the local action reference and prompt',
        );
      }),
      observeFiniteRun: vi.fn(),
      recoverFiniteRun: vi.fn(),
    });
    await expect(
      executor.dispatch(
        await executor.prepare({ ...selected, binding: staleBinding }),
      ),
    ).rejects.toThrow(/does not match the local action reference and prompt/);
  });

  it('host service delegates only through the injected execution gateway', () => {
    const store = {} as WorkflowRuntimeStore;
    const gateway: WorkflowExecutionHostGateway = {
      persistCollaborationActionInput: vi.fn(() => ({
        id: 'collaboration-action-input',
        hash: `sha256:${'6'.repeat(64)}` as const,
      })),
      create: vi.fn(() => ({
        disposition: 'created' as const,
        workflowId: 'workflow:1',
        intakeId: 'intake:1',
        creationRequestId: 'creation:1',
        activation: {
          activationId: 'activation:1',
          graphRunId: 'run:1',
          rootScopeId: 'scope:1',
          rootBuildId: 'build:1',
          disposition: 'activated' as const,
        },
      })),
      observe: vi.fn(() => observation('running')),
    };
    const host = new WorkflowExecutionHostService(store, gateway, () => 42);
    expect(
      host.startCollaborationFiniteRun({
        workflowRef: 'workflow:local-review',
        operationKey,
        promptSha256: hash(prompt),
        actionInput: { format: 'test-action-input' },
        bindingConfig: binding().config,
      }).workflowId,
    ).toBe('workflow:1');
    expect(host.observeFiniteRun('run:1')?.state).toBe('running');
    expect(gateway.create).toHaveBeenCalledWith(
      store,
      expect.objectContaining({
        requestId: `collaboration:${operationKey}`,
        creationDomain: 'agent_group_collaboration',
        creationKey: operationKey,
        actor: 'system',
        launchPolicy: 'auto',
        launchAuthorization: {
          kind: 'trusted_system',
          authorizationRef: `collaboration:${operationKey}`,
        },
        entryPoint: 'default',
        creationIntentHash: expect.stringMatching(/^sha256:/),
        nowMs: 42,
        initialActivation: { nowMs: 42 },
      }),
    );
    expect(gateway.observe).toHaveBeenCalledWith(store, 'run:1');
  });

  it('rejects host-owned creation fields in a reusable launch profile', () => {
    const host = new WorkflowExecutionHostService({} as WorkflowRuntimeStore, {
      persistCollaborationActionInput: vi.fn(),
      create: vi.fn(),
      observe: vi.fn(),
    });
    for (const field of [
      'creationKey',
      'actor',
      'launchPolicy',
      'launchAuthorization',
      'entryPoint',
    ]) {
      const config = structuredClone(binding().config);
      const profile = config.workflow_launch_profile as Record<string, unknown>;
      profile.template = {
        ...(profile.template as Record<string, unknown>),
        [field]: 'configured-by-caller',
      };
      expect(() =>
        host.startCollaborationFiniteRun({
          workflowRef: 'workflow:local-review',
          operationKey,
          promptSha256: hash(prompt),
          actionInput: { format: 'test-action-input' },
          bindingConfig: config,
        }),
      ).toThrow(new RegExp(`must not configure host-owned ${field}`));
    }
  });
});
