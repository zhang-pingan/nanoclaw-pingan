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

    await management.deleteFeatureData('example-feature');

    expect(db.getWorkflow('core-workflow')).toBeTruthy();
    expect(db.getWorkflow('feature-workflow')).toBeUndefined();
  });

  it('keeps DB state retryable when filesystem deletion fails', async () => {
    const workspace = setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const now = new Date().toISOString();
    db.setRegisteredGroup('feature:example-feature:main', {
      name: 'Example Feature',
      folder: 'example_feature_main',
      trigger: '@Andy',
      added_at: now,
      requiresTrigger: false,
    });
    db.setFeatureGroupBinding({
      featureId: 'example-feature',
      groupKey: 'main',
      groupJid: 'feature:example-feature:main',
      groupFolder: 'example_feature_main',
    });
    db.createWorkflow({
      id: 'feature-workflow',
      name: 'Shared Flow',
      service: 'claude',
      start_from: 'start',
      context: {},
      status: 'active',
      current_delegation_id: '',
      round: 0,
      source_jid: 'feature:example-feature:main',
      paused_from: null,
      workflow_type: 'shared_flow',
      feature_id: 'example-feature',
      created_at: now,
      updated_at: now,
    });
    fs.mkdirSync(path.join(workspace, 'groups', 'example_feature_main'), {
      recursive: true,
    });

    const management = await import('./management.js');
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('rm failed');
    });
    try {
      await expect(
        management.deleteFeatureData('example-feature'),
      ).rejects.toThrow(/rm failed/);
    } finally {
      rmSpy.mockRestore();
    }

    expect(db.getWorkflow('feature-workflow')).toBeTruthy();
    expect(db.getFeatureGroupBinding('example-feature', 'main')).toBeTruthy();
  });

  it('drops feature-owned projection tables during data deletion', async () => {
    setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    db.getDatabase().exec(`
      CREATE TABLE feature_example_feature_projection (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO feature_example_feature_projection (id, value)
      VALUES ('row-1', 'value');
    `);

    const management = await import('./management.js');
    const summary = management.getFeatureDeletionSummary('example-feature');
    expect(summary.counts.feature_projection_tables).toBe(1);
    expect(summary.counts.feature_projection_rows).toBe(1);

    await management.deleteFeatureData('example-feature');

    const table = db
      .getDatabase()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_example_feature_projection'",
      )
      .get();
    expect(table).toBeUndefined();
  });

  it('stops feature groups before data deletion and reloads registered groups', async () => {
    const workspace = setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const now = new Date().toISOString();
    db.setRegisteredGroup('feature:example-feature:main', {
      name: 'Example Feature',
      folder: 'example_feature_main',
      trigger: '@Andy',
      added_at: now,
      requiresTrigger: false,
    });
    db.setFeatureGroupBinding({
      featureId: 'example-feature',
      groupKey: 'main',
      groupJid: 'feature:example-feature:main',
      groupFolder: 'example_feature_main',
    });
    fs.mkdirSync(path.join(workspace, 'groups', 'example_feature_main'), {
      recursive: true,
    });

    const stopped: string[] = [];
    let reloadCount = 0;
    const management = await import('./management.js');
    management.configureFeatureManagementHostHooks({
      stopFeatureGroups: (groups) => {
        stopped.push(...groups.map((group) => group.jid));
      },
      reloadRegisteredGroups: () => {
        reloadCount += 1;
      },
    });

    await management.deleteFeatureData('example-feature');

    expect(stopped).toEqual(['feature:example-feature:main']);
    expect(reloadCount).toBe(1);
    expect(
      db.getFeatureGroupBinding('example-feature', 'main'),
    ).toBeUndefined();
  });

  it('reloads registered groups after applying feature enable changes', async () => {
    setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    let reloadCount = 0;
    const management = await import('./management.js');
    management.configureFeatureManagementHostHooks({
      reloadRegisteredGroups: () => {
        reloadCount += 1;
      },
    });

    const result = await management.setFeatureEnabledAndApply({
      featureId: 'example-feature',
      enabled: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.runtimeApplied).toBe(true);
    expect(reloadCount).toBe(1);
  });
});
