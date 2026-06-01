import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

async function loadModuleWithReposDir(reposDir: string) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    GROUPS_DIR: path.join(reposDir, 'groups'),
    REPOS_DIR: reposDir,
  }));
  return import('./ios-service-config.js');
}

afterEach(() => {
  vi.doUnmock('../config.js');
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveIosServiceConfig', () => {
  it('resolves clients.ios repo under REPOS_DIR', async () => {
    const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ios-repos-'));
    tempDirs.push(reposDir);
    fs.mkdirSync(path.join(reposDir, 'catstory-ios'), { recursive: true });
    const { resolveIosServiceConfig } = await loadModuleWithReposDir(reposDir);

    const resolved = resolveIosServiceConfig('catstory', {
      registry: {
        catstory: {
          repo_path: 'catstory',
          clients: {
            ios: {
              repo_path: 'catstory-ios',
              scheme: 'CatstoryDebug',
              bundle_id: 'com.example.catstory',
            },
          },
        },
      },
    });

    expect(resolved.ios_repo_host_path).toBe(
      path.join(reposDir, 'catstory-ios'),
    );
  });

  it('rejects unsafe clients.ios repo paths', async () => {
    const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ios-repos-'));
    tempDirs.push(reposDir);
    const { resolveIosServiceConfig } = await loadModuleWithReposDir(reposDir);

    expect(() =>
      resolveIosServiceConfig('catstory', {
        registry: {
          catstory: {
            clients: {
              ios: {
                repo_path: '../catstory-ios',
                scheme: 'CatstoryDebug',
                bundle_id: 'com.example.catstory',
              },
            },
          },
        },
      }),
    ).toThrow('safe relative path');
  });
});
