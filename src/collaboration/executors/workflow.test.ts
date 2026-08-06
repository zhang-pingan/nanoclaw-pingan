import crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkflowExecutionHostService,
  type FiniteWorkflowCreationTemplate,
  type FiniteWorkflowRunObservation,
  type WorkflowExecutionHostGateway,
} from '../../workflow-execution/host-service.js';
import type { WorkflowRuntimeStore } from '../../workflow-runtime/gateway/connection.js';
import type { ActionDefinition } from '../protocol/index.js';
import type { CollaborationExecutorBinding } from '../store.js';
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

function action(): ActionDefinition {
  return {
    format: 'icarus.agent-group-action/1',
    action_id: 'workflow-action',
    kind: 'workflow',
    input: {
      prompt_ref: 'prompts/workflow.md',
      workflow_ref: 'workflow:local-review',
    },
    requirements: {
      capability: 'workflow_task',
      interaction: 'headless',
      filesystem_access: 'read_only',
    },
    result_schema: { ref: 'workflow-result@1' },
  };
}

function binding(): CollaborationExecutorBinding {
  return {
    groupId: 'ag_test',
    role: 'reviewer',
    executorKind: 'workflow',
    adapter: null,
    agentJid: null,
    workspacePath: '/tmp/workspace',
    promptOverride: null,
    filesystemAccessCap: 'read_only',
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

function request(): ActionRequest {
  return {
    executionId: 'collaboration:workflow-1',
    operationKey,
    groupId: 'ag_test',
    turnId: 'turn_1',
    epoch: 1,
    attempt: 1,
    fencingToken: `sha256:${'b'.repeat(64)}`,
    action: action(),
    prompt,
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
    output: state === 'succeeded' ? { reviewed: true } : null,
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
        outcome: 'success',
        data: { output: { reviewed: true } },
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
      result: {
        outcome: 'failure',
        error: { code: 'workflow_failed' },
      },
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
        creationIntentHash: expect.stringMatching(/^sha256:/),
        nowMs: 42,
        initialActivation: { nowMs: 42 },
      }),
    );
    expect(gateway.observe).toHaveBeenCalledWith(store, 'run:1');
  });

  it('rejects host-owned creation fields in a reusable launch profile', () => {
    const host = new WorkflowExecutionHostService({} as WorkflowRuntimeStore, {
      create: vi.fn(),
      observe: vi.fn(),
    });
    const config = structuredClone(binding().config);
    const profile = config.workflow_launch_profile as Record<string, unknown>;
    profile.template = {
      ...(profile.template as Record<string, unknown>),
      creationKey: 'configured-by-caller',
    };
    expect(() =>
      host.startCollaborationFiniteRun({
        workflowRef: 'workflow:local-review',
        operationKey,
        promptSha256: hash(prompt),
        bindingConfig: config,
      }),
    ).toThrow(/must not configure host-owned creationKey/);
  });
});
