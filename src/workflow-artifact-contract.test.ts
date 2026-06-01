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

  it('requires unknown iOS impact to be covered by plan open questions', () => {
    writeDeliverable(
      'product-recon.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_id: 'SESSION-001',
        flows: [],
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
    writeDeliverable(
      'plan.md',
      `${PLAN_FRONTMATTER}\n# 方案\n\n## 范围\nx\n\n## 验收标准\ny\n\n## 风险\nz\n\n## iOS 配合\nclient_impact 待确认\n`,
    );
    writeDeliverable(
      'traceability.json',
      JSON.stringify({
        statements: [],
        decisions: [],
        actions: [],
        acceptance_criteria: [],
        evidence: [],
        coverage: [],
        open_questions: [],
      }),
    );

    const result = evaluateWorkflowArtifactContract({
      workflow: { ...makeWorkflow(), workflow_type: 'ios_dev_test' },
      contractRef: 'ios_dev_test.plan.v1',
      payload: {
        deliverable: DELIVERABLE,
        main_branch: 'main',
        work_branch: 'feature/ios',
      },
    });

    expect(result?.status).toBe('needs_revision');
    expect(result?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ios_plan_traceability.unknown_impact_missing_open_question',
        }),
      ]),
    );
  });

  it('validates iOS impact required values and supporting evidence', () => {
    writeDeliverable(
      'product-recon.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_id: 'SESSION-001',
        flows: [],
        evidence: [],
      }),
    );
    writeDeliverable(
      'impact-analysis.json',
      JSON.stringify({
        version: 1,
        service: TEST_SERVICE,
        platform: 'ios',
        client_impact: { required: 'yes', supported_by: [] },
        server_impact: { required: true, supported_by: ['OBS-001'] },
        open_questions: [],
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

    expect(result?.status).toBe('needs_revision');
    expect(result?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ios_impact_analysis.client_impact_required_invalid',
        }),
        expect.objectContaining({
          code: 'ios_impact_analysis.server_impact_true_missing_evidence',
        }),
      ]),
    );
  });

  it('allows iOS preintegration pending without a final iOS branch', () => {
    const result = evaluateWorkflowArtifactContract({
      workflow: {
        ...makeWorkflow(),
        workflow_type: 'ios_dev_test',
        status: 'ios_preintegration',
      },
      contractRef: 'ios_dev_test.ios_preintegration.v1',
      payload: {
        deliverable: DELIVERABLE,
        main_branch: 'main',
        work_branch: 'feature/ios',
        verdict: 'pending',
      },
    });

    expect(result?.status).toBe('passed');
    expect(
      result?.findings.some(
        (finding) =>
          finding.code === 'artifact_contract.payload_missing' &&
          finding.message.includes('ios_work_branch'),
      ),
    ).toBe(false);
  });

  it('validates optional iOS preintegration report when present', () => {
    writeDeliverable(
      'ios-preintegration-report.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        ios_work_branch: 'preintegration/example',
        verdict: 'passed',
        evidence: [],
      }),
    );

    const result = evaluateWorkflowArtifactContract({
      workflow: {
        ...makeWorkflow(),
        workflow_type: 'ios_dev_test',
        status: 'ios_preintegration',
      },
      contractRef: 'ios_dev_test.ios_preintegration.v1',
      payload: {
        deliverable: DELIVERABLE,
        main_branch: 'main',
        work_branch: 'feature/ios',
        ios_work_branch: 'preintegration/example',
        verdict: 'passed',
      },
    });

    expect(result?.status).toBe('pending');
    expect(result?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'artifact_contract.body_field_missing',
          message: expect.stringContaining('base_branch'),
        }),
        expect.objectContaining({
          code: 'artifact_contract.body_field_missing',
          message: expect.stringContaining('changes'),
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

  it('fails iOS acceptance when report summary differs from payload counts', () => {
    writeDeliverable(
      'ios-test-plan.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_purpose: 'acceptance',
        cases: [
          {
            case_id: 'IOS-TC-001',
            title: '资料页徽章展示',
            steps: [],
            assertions: [],
          },
        ],
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
          total: 1,
          passed: 0,
          failed: 1,
          blocked: 0,
        },
        cases: [
          {
            case_id: 'IOS-TC-001',
            result: 'failed',
            case_evidence: ['CASE-001'],
            assertions: ['ASSERT-001'],
            bugs: [],
          },
        ],
        bugs: [],
        verdict: 'failed',
        evidence: ['CASE-001', 'ASSERT-001'],
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
        total: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
      },
    });

    expect(result?.status).toBe('failed');
    expect(result?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ios_acceptance_report_passed_mismatch',
        }),
        expect.objectContaining({
          code: 'ios_acceptance_report_failed_mismatch',
        }),
      ]),
    );
  });

  it('fails iOS acceptance when a passed case lacks CASE or ASSERT evidence', () => {
    writeDeliverable(
      'ios-test-plan.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_purpose: 'acceptance',
        cases: [
          {
            case_id: 'IOS-TC-001',
            title: '资料页徽章展示',
            steps: [],
            assertions: [],
          },
        ],
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
          total: 1,
          passed: 1,
          failed: 0,
          blocked: 0,
        },
        cases: [
          {
            case_id: 'IOS-TC-001',
            result: 'passed',
            case_evidence: ['OBS-001'],
            assertions: [],
            bugs: [],
          },
        ],
        bugs: [],
        verdict: 'passed',
        evidence: ['OBS-001'],
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
        total: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
      },
    });

    expect(result?.status).toBe('failed');
    expect(result?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ios_acceptance_report.passed_case_missing_case_evidence',
        }),
        expect.objectContaining({
          code: 'ios_acceptance_report.passed_case_missing_assertion',
        }),
      ]),
    );
  });

  it('fails iOS acceptance when a passed case cites failed or non-UI assertions', () => {
    writeDeliverable(
      'ios-test-plan.json',
      JSON.stringify({
        version: 1,
        platform: 'ios',
        service: TEST_SERVICE,
        session_purpose: 'acceptance',
        cases: [
          {
            case_id: 'IOS-TC-001',
            title: '资料页徽章展示',
            steps: [],
            assertions: [],
          },
        ],
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
          total: 1,
          passed: 1,
          failed: 0,
          blocked: 0,
        },
        cases: [
          {
            case_id: 'IOS-TC-001',
            result: 'passed',
            case_evidence: ['CASE-001'],
            assertions: ['ASSERT-001'],
            bugs: [],
          },
        ],
        bugs: [],
        verdict: 'passed',
        evidence: [
          'CASE-001',
          {
            id: 'ASSERT-001',
            type: 'network',
            status: 'failed',
          },
        ],
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
        total: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
      },
    });

    expect(result?.status).toBe('failed');
    expect(result?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ios_acceptance_report.passed_case_assertion_not_passed',
        }),
        expect.objectContaining({
          code: 'ios_acceptance_report.passed_case_missing_ui_or_app_state_assertion',
        }),
      ]),
    );
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
