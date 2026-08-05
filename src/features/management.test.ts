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

  const featureRoot = path.join(tempDir, 'features', 'example-feature');
  writeJson(path.join(featureRoot, 'feature.json'), {
    id: 'example-feature',
    name: 'Example Feature',
    version: '0.1.0',
  });

  return tempDir;
}

describe('feature management', () => {
  it('keeps DB state retryable when filesystem deletion fails', async () => {
    const workspace = setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const now = new Date().toISOString();
    db.setRegisteredAgent('feature:example-feature:main', {
      name: 'Example Feature',
      folder: 'example_feature_main',
      trigger: '@Andy',
      added_at: now,
      requiresTrigger: false,
    });
    db.setFeatureAgentBinding({
      featureId: 'example-feature',
      agentKey: 'main',
      agentJid: 'feature:example-feature:main',
      agentFolder: 'example_feature_main',
    });
    fs.mkdirSync(path.join(workspace, 'agents', 'example_feature_main'), {
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

    expect(db.getFeatureAgentBinding('example-feature', 'main')).toBeTruthy();
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

  it('reports external feature data roots without deleting them', async () => {
    const workspace = setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const externalRoot = path.join(workspace, 'external-workspace');
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.writeFileSync(path.join(externalRoot, 'keep.txt'), 'keep\n');
    const { registerExternalFeatureDataRoot } = await import('./data-roots.js');
    registerExternalFeatureDataRoot({
      featureId: 'example-feature',
      rootId: 'workspace',
      rootPath: externalRoot,
      readonly: true,
    });

    const management = await import('./management.js');
    const summary = management.getFeatureDeletionSummary('example-feature');
    expect(summary.counts.external_feature_data_roots).toBe(1);
    expect(summary.externalDataRoots).toEqual([
      {
        rootId: 'workspace',
        rootPath: externalRoot,
        readonly: true,
      },
    ]);
    expect(summary.paths).not.toContain(externalRoot);

    await management.deleteFeatureData('example-feature');

    expect(fs.existsSync(path.join(externalRoot, 'keep.txt'))).toBe(true);
  });

  it('stops feature agents before data deletion and reloads registered agents', async () => {
    const workspace = setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const now = new Date().toISOString();
    db.setRegisteredAgent('feature:example-feature:main', {
      name: 'Example Feature',
      folder: 'example_feature_main',
      trigger: '@Andy',
      added_at: now,
      requiresTrigger: false,
    });
    db.setFeatureAgentBinding({
      featureId: 'example-feature',
      agentKey: 'main',
      agentJid: 'feature:example-feature:main',
      agentFolder: 'example_feature_main',
    });
    fs.mkdirSync(path.join(workspace, 'agents', 'example_feature_main'), {
      recursive: true,
    });

    const stopped: string[] = [];
    let reloadCount = 0;
    const management = await import('./management.js');
    management.configureFeatureManagementHostHooks({
      stopFeatureAgents: (agents) => {
        stopped.push(...agents.map((agent) => agent.jid));
      },
      reloadRegisteredAgents: () => {
        reloadCount += 1;
      },
    });

    await management.deleteFeatureData('example-feature');

    expect(stopped).toEqual(['feature:example-feature:main']);
    expect(reloadCount).toBe(1);
    expect(
      db.getFeatureAgentBinding('example-feature', 'main'),
    ).toBeUndefined();
  });

  it('reloads registered agents after applying feature enable changes', async () => {
    setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    let reloadCount = 0;
    const management = await import('./management.js');
    management.configureFeatureManagementHostHooks({
      reloadRegisteredAgents: () => {
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
