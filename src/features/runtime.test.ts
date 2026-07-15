import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
let tempDir: string | null = null;

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.ICARUS_FEATURES;
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-feature-runtime-'));
  process.chdir(tempDir);

  const featureRoot = path.join(tempDir, 'features', 'example-feature');
  fs.mkdirSync(path.join(featureRoot, 'host'), { recursive: true });
  fs.mkdirSync(path.join(featureRoot, 'container', 'groups', 'main'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(featureRoot, 'container', 'skills'), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(featureRoot, 'host', 'index.mjs'),
    [
      'export function activate(context) {',
      '  context.api.register({',
      "    method: 'GET',",
      "    path: '/api/features/example-feature/ping',",
      '    handler: ({ res }) => {',
      "      res.writeHead(200, { 'Content-Type': 'application/json' });",
      '      res.end(JSON.stringify({ ok: true, featureId: context.featureId }));',
      '    },',
      '  });',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(featureRoot, 'container', 'groups', 'main', 'CLAUDE.md'),
    'Feature group memory\n',
    'utf-8',
  );

  writeJson(path.join(featureRoot, 'feature.json'), {
    id: 'example-feature',
    name: 'Example Feature',
    version: '0.1.0',
    hostEntry: './host/index.mjs',
    rendererEntry: './renderer/index.js',
    apiPrefix: '/api/features/example-feature',
    nav: [{ key: 'example-feature', label: 'Example', order: 300 }],
    requiredGroups: [
      {
        key: 'main',
        jid: 'feature:example-feature:main',
        name: 'Example Feature',
        folder: 'example_feature_main',
        requiresTrigger: false,
        description: 'Example feature dedicated agent group',
        claudeMd: './container/groups/main/CLAUDE.md',
      },
    ],
    resources: {
      skills: './container/skills',
    },
  });
  writeJson(path.join(tempDir, 'local', 'features.json'), {
    enabled: ['example-feature', 'example-feature'],
  });
  fs.writeFileSync(
    path.join(featureRoot, 'container', 'skills', 'SKILL.md'),
    '# Example skill\n',
    'utf-8',
  );

  return tempDir;
}

describe('feature runtime', () => {
  it('activates enabled features, provisions groups, registers APIs and resources', async () => {
    const workspace = setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const runtime = await import('./runtime.js');

    await runtime.activateConfiguredFeatures();

    const enabled = runtime.getEnabledFeatureInfo();
    expect(enabled.map((feature) => feature.id)).toEqual(['example-feature']);
    expect(enabled[0].nav[0]).toMatchObject({
      key: 'example-feature',
      rendererEntryUrl: '/features/example-feature/renderer/index.js',
    });

    const group = db.getRegisteredGroup('feature:example-feature:main');
    expect(group).toMatchObject({
      folder: 'example_feature_main',
      requiresTrigger: false,
    });
    expect(
      fs.readFileSync(
        path.join(workspace, 'groups', 'example_feature_main', 'CLAUDE.md'),
        'utf-8',
      ),
    ).toBe('Feature group memory\n');
    expect(db.getFeatureGroupBinding('example-feature', 'main')).toMatchObject({
      group_jid: 'feature:example-feature:main',
      group_folder: 'example_feature_main',
    });

    const { featureApiRoutes } = await import('./registry.js');
    const writes: string[] = [];
    const handled = await featureApiRoutes.dispatch({
      req: { method: 'GET' } as never,
      res: {
        writeHead: () => undefined,
        end: (chunk: string) => writes.push(chunk),
      } as never,
      url: new URL('http://localhost/api/features/example-feature/ping'),
    });
    expect(handled).toBe(true);
    expect(writes).toEqual(['{"ok":true,"featureId":"example-feature"}']);

    expect(() =>
      runtime.resolveEnabledFeatureStaticPath(
        '/features/example-feature/feature.json',
      ),
    ).toThrow(/renderer/);
    expect(
      runtime.resolveEnabledFeatureStaticPath(
        '/features/example-feature/renderer/index.js',
      )?.filePath,
    ).toContain(
      path.join('features', 'example-feature', 'renderer', 'index.js'),
    );
  });

  it('rejects enabled features with missing declared resource directories', async () => {
    setupFeatureWorkspace();
    fs.rmSync(
      path.join(
        tempDir as string,
        'features',
        'example-feature',
        'container',
        'skills',
      ),
      { recursive: true, force: true },
    );
    const db = await import('../db.js');
    db._initTestDatabase();
    const runtime = await import('./runtime.js');

    await expect(runtime.activateConfiguredFeatures()).rejects.toThrow(
      /resources.skills not found/,
    );
  });

  it('rejects removed runtime resource declarations', async () => {
    const { normalizeFeatureManifest } = await import('./manifest.js');
    for (const removedKey of [
      'workflowDefinitions',
      'cards',
      'artifactContracts',
      'workflowEvaluators',
    ]) {
      const result = normalizeFeatureManifest({
        id: 'example-feature',
        name: 'Example Feature',
        version: '0.1.0',
        resources: { [removedKey]: './container/removed' },
      });
      expect(result.manifest).toBeUndefined();
      expect(result.errors).toContain(
        `resources.${removedKey} is no longer supported`,
      );
    }
  });

  it('applies feature disable immediately by clearing runtime registries', async () => {
    setupFeatureWorkspace();
    const db = await import('../db.js');
    db._initTestDatabase();
    const runtime = await import('./runtime.js');
    const management = await import('./management.js');
    const { featureApiRoutes } = await import('./registry.js');

    await runtime.activateConfiguredFeatures();
    expect(runtime.getEnabledFeatureInfo()).toHaveLength(1);

    const result = await management.setFeatureEnabledAndApply({
      featureId: 'example-feature',
      enabled: false,
    });

    expect(result.error).toBeUndefined();
    expect(result.runtimeApplied).toBe(true);
    expect(runtime.getEnabledFeatureInfo()).toHaveLength(0);
    const handled = await featureApiRoutes.dispatch({
      req: { method: 'GET' } as never,
      res: {
        writeHead: () => undefined,
        end: () => undefined,
      } as never,
      url: new URL('http://localhost/api/features/example-feature/ping'),
    });
    expect(handled).toBe(false);
  });

  it('requires feature MCP profiles to be declared in permissions', async () => {
    const workspace = setupFeatureWorkspace();
    const featureRoot = path.join(workspace, 'features', 'example-feature');
    fs.mkdirSync(path.join(featureRoot, 'container', 'mcp'), {
      recursive: true,
    });
    writeJson(path.join(featureRoot, 'container', 'mcp', 'mcp.json'), {
      profiles: { example_mcp: [] },
      groups: { global: ['example_mcp'] },
    });
    const manifestPath = path.join(featureRoot, 'feature.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.resources.mcp = './container/mcp';
    writeJson(manifestPath, manifest);

    const db = await import('../db.js');
    db._initTestDatabase();
    const runtime = await import('./runtime.js');

    await expect(runtime.activateConfiguredFeatures()).rejects.toThrow(
      /permissions\.mcpServers/,
    );
  });
});
