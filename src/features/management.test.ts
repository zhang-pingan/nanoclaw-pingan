import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
let tempDir: string | null = null;

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function setupFeatureWorkspace(): string {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-feature-management-'),
  );
  process.chdir(tempDir);

  writeJson(
    path.join(tempDir, 'container', 'workflow-definitions', 'shared_flow.json'),
    {
      key: 'shared_flow',
      versions: [],
    },
  );

  const featureRoot = path.join(tempDir, 'features', 'example-feature');
  writeJson(path.join(featureRoot, 'feature.json'), {
    id: 'example-feature',
    name: 'Example Feature',
    version: '0.1.0',
    resources: {
      workflowDefinitions: './container/workflow-definitions',
    },
  });
  writeJson(
    path.join(
      featureRoot,
      'container',
      'workflow-definitions',
      'shared_flow.json',
    ),
    {
      key: 'shared_flow',
      versions: [],
    },
  );

  return tempDir;
}

describe('feature management', () => {
  it('does not delete core workflows when legacy workflow_type overlaps core definitions', async () => {
    setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const now = new Date().toISOString();
    const baseWorkflow = {
      name: 'Shared Flow',
      service: 'claude',
      start_from: 'start',
      context: {},
      status: 'active' as const,
      current_delegation_id: '',
      round: 0,
      paused_from: null,
      workflow_type: 'shared_flow',
      created_at: now,
      updated_at: now,
    };
    db.createWorkflow({
      ...baseWorkflow,
      id: 'core-workflow',
      source_jid: 'core:main',
      feature_id: null,
    });
    db.createWorkflow({
      ...baseWorkflow,
      id: 'feature-workflow',
      source_jid: 'feature:example-feature:main',
      feature_id: 'example-feature',
    });

    const management = await import('./management.js');
    expect(
      management.getFeatureDeletionSummary('example-feature').counts.workflows,
    ).toBe(1);

    management.deleteFeatureData('example-feature');

    expect(db.getWorkflow('core-workflow')).toBeTruthy();
    expect(db.getWorkflow('feature-workflow')).toBeUndefined();
  });
});
