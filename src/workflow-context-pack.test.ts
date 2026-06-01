import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from './config.js';
import {
  buildContextPackPromptInstructions,
  buildWorkflowContextPack,
} from './workflow-context-pack.js';
import { WORKFLOW_CONTEXT_KEYS } from './workflow-context.js';
import type { RegisteredGroup, Workflow } from './types.js';
import type { WorkflowContextRequirements } from './workflow-definition.js';

const SERVICE = 'context-pack-test-service';
const WORKFLOW_ID = 'wf-context-pack-test';

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: WORKFLOW_ID,
    name: 'Context pack hash test',
    service: SERVICE,
    start_from: 'plan',
    context: {
      requirement_description: '支持上下文包 hash 稳定性。',
      requirement_files: ['/tmp/context-pack-test.md'],
      main_branch: 'main',
      work_branch: 'feature/context-pack-test',
      deliverable: '2026-04-08_context_pack',
      ...(overrides.context || {}),
    },
    status: 'plan',
    current_delegation_id: '',
    round: 1,
    source_jid: 'main@g.us',
    paused_from: null,
    workflow_type: 'dev_test',
    created_at: '2026-04-08T00:00:00.000Z',
    updated_at: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function group(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '/nc',
    added_at: '2026-04-08T00:00:00.000Z',
    containerConfig: { services: ['icarus'] },
  };
}

const REQUIREMENTS: WorkflowContextRequirements = {
  readiness_policy: 'record_only',
  sources: [
    {
      id: 'user_input',
      type: 'workflow_input',
      required: true,
      fields: [
        'requirement_description',
        'requirement_files',
        'main_branch',
        'work_branch',
      ],
    },
    {
      id: 'service_codebase_location',
      type: 'codebase_location',
      required: false,
      service: 'icarus',
      verify_exists: true,
      verify_mounted_for_role: true,
    },
  ],
};

describe('workflow context pack', () => {
  beforeEach(() => {
    fs.rmSync(path.join(PROJECT_ROOT, 'projects', SERVICE), {
      recursive: true,
      force: true,
    });
  });

  it('reuses immutable context pack when only runtime timestamp changes', () => {
    const baseInput = {
      workflow: workflow(),
      stageKey: 'plan',
      role: 'planner',
      skill: 'plan-requirement',
      attempt: 1,
      targetFolder: 'web_plan',
      registeredGroups: { 'plan@g.us': group('web_plan') },
      contextRequirements: REQUIREMENTS,
    };

    const firstResult = buildWorkflowContextPack(baseInput);
    const first = firstResult.pack;
    const firstGeneratedAt = first.generated_at;
    const secondResult = buildWorkflowContextPack(baseInput);
    const second = secondResult.pack;

    expect(second.hash).toBe(first.hash);
    expect(second.generated_at).toBe(firstGeneratedAt);
    expect(secondResult.hostImmutablePackPath).toBe(
      firstResult.hostImmutablePackPath,
    );
    const immutableFiles = fs
      .readdirSync(
        path.join(
          PROJECT_ROOT,
          'projects',
          SERVICE,
          'workflow-context',
          WORKFLOW_ID,
          'plan',
        ),
      )
      .filter((file) => /^context-pack\.r\d+\.a\d+\.json$/.test(file));
    expect(immutableFiles).toHaveLength(1);
  });

  it('keeps context pack prompt short and points to latest only', () => {
    const context = {
      [WORKFLOW_CONTEXT_KEYS.contextPackPath]:
        `/workspace/projects/${SERVICE}/workflow-context/${WORKFLOW_ID}/plan/latest.json`,
      [WORKFLOW_CONTEXT_KEYS.contextPackImmutablePath]:
        `/workspace/projects/${SERVICE}/workflow-context/${WORKFLOW_ID}/plan/context-pack.r1.a1.json`,
      [WORKFLOW_CONTEXT_KEYS.contextPackHash]: 'sha256:abc',
      [WORKFLOW_CONTEXT_KEYS.contextPackSummary]: 'readiness=warning; inputs=4',
      [WORKFLOW_CONTEXT_KEYS.contextPackOpenQuestions]: '缺少工作分支',
      [WORKFLOW_CONTEXT_KEYS.contextReadinessStatus]: 'warning',
    };

    const prompt = buildContextPackPromptInstructions(context);

    expect(prompt).toContain('[Context Pack]');
    expect(prompt).toContain('latest: /workspace/projects/');
    expect(prompt).toContain('执行前请读取 latest');
    expect(prompt).not.toContain('immutable:');
    expect(prompt).not.toContain('hash:');
    expect(prompt).not.toContain('summary:');
    expect(prompt).not.toContain('open_questions:');
    expect(prompt).not.toContain('readiness: warning');
  });
});
