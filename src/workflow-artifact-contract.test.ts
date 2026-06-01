import fs from 'fs';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from './config.js';
import type { Workflow } from './types.js';
import {
  clearWorkflowArtifactContractCacheForTest,
  evaluateWorkflowArtifactContract,
} from './workflow-artifact-contract.js';

const TEST_SERVICE = 'artifact-contract-test-service';
const DELIVERABLE = '2026-05-29_artifact';
const ITERATION_DIR = path.join(
  PROJECT_ROOT,
  'projects',
  TEST_SERVICE,
  'iteration',
  DELIVERABLE,
);
const CONTRACTS_DIR = path.join(
  PROJECT_ROOT,
  'container',
  'artifact-contracts',
);
const TEMP_CONTRACT_FILE = path.join(
  CONTRACTS_DIR,
  '__test_json_deliverable.json',
);

function makeWorkflow(): Workflow {
  return {
    id: 'wf-artifact-test',
    name: 'Artifact contract test',
    service: TEST_SERVICE,
    start_from: 'plan',
    context: { deliverable: DELIVERABLE },
    status: 'plan',
    current_delegation_id: '',
    round: 0,
    source_jid: 'main@g.us',
    paused_from: null,
    workflow_type: 'dev_test',
    created_at: '2026-05-29T00:00:00.000Z',
    updated_at: '2026-05-29T00:00:00.000Z',
  };
}

function writeDeliverable(fileName: string, content: string): void {
  fs.mkdirSync(ITERATION_DIR, { recursive: true });
  fs.writeFileSync(path.join(ITERATION_DIR, fileName), content);
}

const PLAN_FRONTMATTER = `---\nservice: ${TEST_SERVICE}\ndeliverable: ${DELIVERABLE}\ndoc_type: plan\n---\n`;

describe('workflow artifact contract declarative rules', () => {
  beforeEach(() => {
    fs.rmSync(ITERATION_DIR, { recursive: true, force: true });
    clearWorkflowArtifactContractCacheForTest();
  });

  afterAll(() => {
    fs.rmSync(ITERATION_DIR, { recursive: true, force: true });
    fs.rmSync(TEMP_CONTRACT_FILE, { force: true });
    clearWorkflowArtifactContractCacheForTest();
  });

  it('passes when plan.md satisfies migrated content_checks', () => {
    writeDeliverable(
      'plan.md',
      `${PLAN_FRONTMATTER}\n# 方案\n\n## 范围\n- x\n\n## 验收标准\n- y\n\n## 风险\n- z\n`,
    );
    writeDeliverable('traceability.json', '{}');

    const result = evaluateWorkflowArtifactContract({
      workflow: makeWorkflow(),
      contractRef: 'dev_test.plan.v1',
      payload: {
        deliverable: DELIVERABLE,
        main_branch: 'main',
        work_branch: 'feature/x',
      },
    });

    expect(result?.status).toBe('passed');
    expect(
      result?.findings.some((f) => f.code === 'missing_acceptance_criteria'),
    ).toBe(false);
  });

  it('flags missing plan content_checks sections from config', () => {
    writeDeliverable('plan.md', `${PLAN_FRONTMATTER}\n# 方案\n\n仅有正文。\n`);
    writeDeliverable('traceability.json', '{}');

    const result = evaluateWorkflowArtifactContract({
      workflow: makeWorkflow(),
      contractRef: 'dev_test.plan.v1',
      payload: {
        deliverable: DELIVERABLE,
        main_branch: 'main',
        work_branch: 'feature/x',
      },
    });

    expect(result?.status).toBe('needs_revision');
    const codes = result?.findings.map((f) => f.code) || [];
    expect(codes).toContain('missing_acceptance_criteria');
    expect(codes).toContain('missing_scope_definition');
    expect(codes).toContain('missing_risk_assessment');
  });

  it('forces failed status via testing payload_rules when failed > 0', () => {
    const result = evaluateWorkflowArtifactContract({
      workflow: { ...makeWorkflow(), status: 'testing' },
      contractRef: 'dev_test.testing.v1',
      payload: {
        deliverable: DELIVERABLE,
        test_doc: 'test.md',
        total: 10,
        passed: 8,
        failed: 2,
        blocked: 0,
      },
    });

    expect(result?.status).toBe('failed');
    const failedFinding = result?.findings.find(
      (f) => f.code === 'test_cases_failed',
    );
    expect(failedFinding).toBeDefined();
    expect(failedFinding?.message).toContain('2');
  });

  it('does not trigger testing payload_rule when failed = 0', () => {
    const result = evaluateWorkflowArtifactContract({
      workflow: { ...makeWorkflow(), status: 'testing' },
      contractRef: 'dev_test.testing.v1',
      payload: {
        deliverable: DELIVERABLE,
        test_doc: 'test.md',
        total: 10,
        passed: 10,
        failed: 0,
        blocked: 0,
      },
    });

    expect(result?.status).toBe('passed');
    expect(result?.findings.some((f) => f.code === 'test_cases_failed')).toBe(
      false,
    );
  });

  it('requires iOS recon artifacts and JSON fields', () => {
    writeDeliverable(
      'product-recon.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_id: 'SESSION-001',
        evidence: [],
      }),
    );
    writeDeliverable(
      'impact-analysis.json',
      JSON.stringify({
        version: 1,
        service: TEST_SERVICE,
        platform: 'ios',
        client_impact: { required: 'unknown' },
        server_impact: { required: true },
        evidence: [],
      }),
    );

    const result = evaluateWorkflowArtifactContract({
      workflow: { ...makeWorkflow(), workflow_type: 'ios_dev_test' },
      contractRef: 'ios_dev_test.ios_recon.v1',
      payload: {
        deliverable: DELIVERABLE,
        main_branch: 'main',
        work_branch: 'feature/ios',
        product_recon: `/workspace/projects/${TEST_SERVICE}/iteration/${DELIVERABLE}/product-recon.json`,
        impact_analysis: `/workspace/projects/${TEST_SERVICE}/iteration/${DELIVERABLE}/impact-analysis.json`,
      },
    });

    expect(result?.status).toBe('pending');
    expect(result?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'artifact_contract.body_field_missing',
          message: expect.stringContaining('flows'),
        }),
      ]),
    );
  });

  it('forces failed status when iOS acceptance has failed or blocked cases', () => {
    writeDeliverable(
      'ios-test-plan.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_purpose: 'acceptance',
        cases: [],
        evidence: [],
      }),
    );
    writeDeliverable(
      'acceptance-report.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_id: 'SESSION-002',
        summary: {
          total: 2,
          passed: 0,
          failed: 1,
          blocked: 1,
        },
        cases: [],
        verdict: 'failed',
        evidence: [],
      }),
    );

    const result = evaluateWorkflowArtifactContract({
      workflow: {
        ...makeWorkflow(),
        workflow_type: 'ios_dev_test',
        status: 'ios_acceptance',
      },
      contractRef: 'ios_dev_test.ios_acceptance.v1',
      payload: {
        deliverable: DELIVERABLE,
        ios_test_plan: `/workspace/projects/${TEST_SERVICE}/iteration/${DELIVERABLE}/ios-test-plan.json`,
        acceptance_report: `/workspace/projects/${TEST_SERVICE}/iteration/${DELIVERABLE}/acceptance-report.json`,
        total: 2,
        passed: 0,
        failed: 1,
        blocked: 1,
      },
    });

    expect(result?.status).toBe('failed');
    const codes = result?.findings.map((f) => f.code) || [];
    expect(codes).toContain('ios_acceptance_cases_failed');
    expect(codes).toContain('ios_acceptance_cases_blocked');
  });

  it('validates JSON deliverable body_required_fields', () => {
    fs.writeFileSync(
      TEMP_CONTRACT_FILE,
      JSON.stringify(
        {
          id: 'test.json_deliverable.v1',
          version: 1,
          allowed_artifact_roots: ['/workspace/projects'],
          files: [
            {
              path: `projects/{{service}}/iteration/{{deliverable}}/report.json`,
              required: true,
              body_required_fields: ['version', 'platform', 'flows'],
            },
          ],
        },
        null,
        2,
      ),
    );
    clearWorkflowArtifactContractCacheForTest();

    writeDeliverable(
      'report.json',
      JSON.stringify({ version: '1', platform: 'ios' }),
    );

    const result = evaluateWorkflowArtifactContract({
      workflow: makeWorkflow(),
      contractRef: 'test.json_deliverable.v1',
      payload: {},
    });

    const missing = result?.findings.filter(
      (f) => f.code === 'artifact_contract.body_field_missing',
    );
    expect(missing?.length).toBe(1);
    expect(missing?.[0]?.message).toContain('flows');
  });

  it('passes JSON deliverable when all body fields exist', () => {
    fs.writeFileSync(
      TEMP_CONTRACT_FILE,
      JSON.stringify(
        {
          id: 'test.json_deliverable.v1',
          version: 1,
          allowed_artifact_roots: ['/workspace/projects'],
          files: [
            {
              path: `projects/{{service}}/iteration/{{deliverable}}/report.json`,
              required: true,
              body_required_fields: ['version', 'platform', 'flows'],
            },
          ],
        },
        null,
        2,
      ),
    );
    clearWorkflowArtifactContractCacheForTest();

    writeDeliverable(
      'report.json',
      JSON.stringify({ version: '1', platform: 'ios', flows: [] }),
    );

    const result = evaluateWorkflowArtifactContract({
      workflow: makeWorkflow(),
      contractRef: 'test.json_deliverable.v1',
      payload: {},
    });

    expect(result?.status).toBe('passed');
    expect(
      result?.findings.some(
        (f) => f.code === 'artifact_contract.body_field_missing',
      ),
    ).toBe(false);
  });

  it('flags non-JSON body for a JSON deliverable', () => {
    fs.writeFileSync(
      TEMP_CONTRACT_FILE,
      JSON.stringify({
        id: 'test.json_deliverable.v1',
        version: 1,
        allowed_artifact_roots: ['/workspace/projects'],
        files: [
          {
            path: `projects/{{service}}/iteration/{{deliverable}}/report.json`,
            required: true,
            body_required_fields: ['version'],
          },
        ],
      }),
    );
    clearWorkflowArtifactContractCacheForTest();

    writeDeliverable('report.json', 'not json at all');

    const result = evaluateWorkflowArtifactContract({
      workflow: makeWorkflow(),
      contractRef: 'test.json_deliverable.v1',
      payload: {},
    });

    expect(
      result?.findings.some(
        (f) => f.code === 'artifact_contract.body_not_json',
      ),
    ).toBe(true);
  });
});
