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

function setupWorkspace(): string {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-feature-container-resources-'),
  );
  process.chdir(tempDir);
  return tempDir;
}

describe('feature container resources', () => {
  it('syncs feature agents into the Claude agents directory', async () => {
    const workspace = setupWorkspace();
    const agentsDir = path.join(
      workspace,
      'features',
      'example-feature',
      'container',
      'agents',
    );
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'reviewer.md'),
      '# Reviewer\n',
      'utf-8',
    );

    const { featureResources } = await import('./registry.js');
    const { syncContainerAgents } = await import('./container-resources.js');
    featureResources.register({
      featureId: 'example-feature',
      kind: 'agents',
      dir: agentsDir,
    });

    const agentsDst = path.join(workspace, 'data', 'sessions', 'main', 'agents');
    syncContainerAgents({ groupFolder: 'main', agentsDst });

    expect(
      fs.readFileSync(
        path.join(agentsDst, 'example-feature-reviewer.md'),
        'utf-8',
      ),
    ).toBe('# Reviewer\n');
  });

  it('prepares read-only feature scripts and templates mount content', async () => {
    const workspace = setupWorkspace();
    const scriptsDir = path.join(
      workspace,
      'features',
      'example-feature',
      'container',
      'scripts',
    );
    const templatesDir = path.join(
      workspace,
      'features',
      'example-feature',
      'container',
      'templates',
    );
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'run.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    fs.writeFileSync(path.join(templatesDir, 'prompt.txt'), 'Prompt\n', 'utf-8');

    const { featureResources } = await import('./registry.js');
    const { prepareFeatureResourceMountDir } = await import(
      './container-resources.js'
    );
    featureResources.register({
      featureId: 'example-feature',
      kind: 'scripts',
      dir: scriptsDir,
    });
    featureResources.register({
      featureId: 'example-feature',
      kind: 'templates',
      dir: templatesDir,
    });

    const mountDir = prepareFeatureResourceMountDir('main');

    expect(mountDir).toContain(
      path.join('data', 'sessions', 'main', 'feature-resources'),
    );
    expect(
      fs.readFileSync(
        path.join(
          mountDir as string,
          'example-feature',
          'templates',
          'prompt.txt',
        ),
        'utf-8',
      ),
    ).toBe('Prompt\n');
    const copiedScript = path.join(
      mountDir as string,
      'example-feature',
      'scripts',
      'run.sh',
    );
    expect(fs.statSync(copiedScript).mode & 0o111).toBe(0);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(mountDir as string, 'manifest.json'), 'utf-8'),
    ) as { resources: Array<{ featureId: string; kind: string }> };
    expect(manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureId: 'example-feature',
          kind: 'scripts',
        }),
        expect.objectContaining({
          featureId: 'example-feature',
          kind: 'templates',
        }),
      ]),
    );
  });
});
