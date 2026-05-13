import { describe, expect, it } from 'vitest';

import type { Delegation, Workflow } from './types.js';
import {
  buildWorkflowHandoffEnvelope,
  getDelegationArtifactContractRef,
  validateWorkflowHandoffResult,
} from './workflow-handoff.js';

function testWorkflow(): Workflow {
  return {
    id: 'wf-test',
    name: 'Test workflow',
    service: 'demo-service',
    start_from: 'plan',
    context: {},
    status: 'plan',
    current_delegation_id: 'del-test',
    round: 0,
    source_jid: 'main@g.us',
    paused_from: null,
    workflow_type: 'dev_test',
    created_at: '2026-04-08T00:00:00.000Z',
    updated_at: '2026-04-08T00:00:00.000Z',
  };
}

function testDelegation(contractJson: string): Delegation {
  return {
    id: 'del-test',
    source_jid: 'main@g.us',
    source_folder: 'web_main',
    target_jid: 'plan@g.us',
    target_folder: 'web_plan',
    task: 'task',
    status: 'pending',
    result: null,
    outcome: null,
    workflow_id: 'wf-test',
    handoff_contract_json: contractJson,
    created_at: '2026-04-08T00:00:00.000Z',
    updated_at: '2026-04-08T00:00:00.000Z',
  };
}

describe('workflow handoff contracts', () => {
  it('uses delegate handoff artifact contract before the state fallback', () => {
    const envelope = buildWorkflowHandoffEnvelope({
      workflow: testWorkflow(),
      stageKey: 'plan',
      role: 'planner',
      skill: 'plan-requirement',
      taskContent: 'task',
      artifactContractRef: 'dev_test.dev.v1',
      handoff: {
        artifact_contract_ref: 'dev_test.plan.v1',
      },
    });

    expect(envelope.contract.output_schema).toBe('dev_test.plan.v1');
    expect(envelope.contract.artifact_contract_ref).toBe('dev_test.plan.v1');
  });

  it('validates complete_delegation payload against the persisted artifact contract id', () => {
    const envelope = buildWorkflowHandoffEnvelope({
      workflow: testWorkflow(),
      stageKey: 'plan',
      role: 'planner',
      skill: 'plan-requirement',
      taskContent: 'task',
      artifactContractRef: 'dev_test.plan.v1',
    });
    const delegation = testDelegation(JSON.stringify(envelope.contract));

    expect(getDelegationArtifactContractRef(delegation)).toBe(
      'dev_test.plan.v1',
    );

    const validation = validateWorkflowHandoffResult(
      JSON.stringify({
        verdict: 'passed',
        summary: 'Plan finished',
        findings: [],
        evidence: [],
        main_branch: 'main',
      }),
      delegation,
    );

    expect(validation.status).toBe('invalid');
    expect(validation.errors).toContain(
      'Payload missing required field "deliverable"',
    );
    expect(validation.errors).toContain(
      'Payload missing required field "work_branch"',
    );
  });
});
