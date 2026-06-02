import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildIosApp, resolveIosDerivedDataPath } from './ios-simulator.js';

const tempDirs: string[] = [];
const originalDerivedDataDir = process.env.ICARUS_IOS_DERIVED_DATA_DIR;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (
          err: null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => callback(null, { stdout: '', stderr: '' }),
    ),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalDerivedDataDir === undefined) {
    delete process.env.ICARUS_IOS_DERIVED_DATA_DIR;
  } else {
    process.env.ICARUS_IOS_DERIVED_DATA_DIR = originalDerivedDataDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ios-repo-'));
  tempDirs.push(repo);
  const derivedDataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-ios-derived-data-'),
  );
  tempDirs.push(derivedDataRoot);
  process.env.ICARUS_IOS_DERIVED_DATA_DIR = derivedDataRoot;
  return repo;
}

function makeApp(repo: string, configuration: string, appName: string) {
  const appDir = path.join(
    resolveIosDerivedDataPath(repo),
    'Build',
    'Products',
    `${configuration}-iphonesimulator`,
    appName,
  );
  fs.mkdirSync(appDir, { recursive: true });
}

describe('buildIosApp', () => {
  it('uses configured app_name in an Icarus-owned derived data directory', async () => {
    const repo = makeRepo();
    makeApp(repo, 'Debug-CN', 'Runner-CN.app');

    const result = await buildIosApp(
      repo,
      {
        repo_path: 'catapp',
        workspace: 'ios/Runner.xcworkspace',
        scheme: 'cn',
        bundle_id: 'net.maoli.history.cn',
        app_name: 'Runner-CN',
        configuration: 'Debug-CN',
      },
      'iPhone 17',
    );

    const expectedDerivedData = resolveIosDerivedDataPath(repo);
    expect(result.appPath).toBe(
      path.join(
        expectedDerivedData,
        'Build',
        'Products',
        'Debug-CN-iphonesimulator',
        'Runner-CN.app',
      ),
    );
    expect(result.appPath.startsWith(repo + path.sep)).toBe(false);
    expect(result.command.args).toContain(expectedDerivedData);
  });

  it('falls back to the only app bundle in the build products directory', async () => {
    const repo = makeRepo();
    makeApp(repo, 'Debug-CN', 'Runner-CN.app');

    const result = await buildIosApp(
      repo,
      {
        repo_path: 'catapp',
        workspace: 'ios/Runner.xcworkspace',
        scheme: 'cn',
        bundle_id: 'net.maoli.history.cn',
        configuration: 'Debug-CN',
      },
      'iPhone 17',
    );

    expect(path.basename(result.appPath)).toBe('Runner-CN.app');
  });
});
