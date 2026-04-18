import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTAINER_LOCAL_SHELL_ROOT,
  resolveLocalHostScript,
  runLocalHostScript,
} from './host-script-runner.js';

const tempDirs: string[] = [];

function makeTempShellRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-script-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'shell'), { recursive: true });
  return path.join(dir, 'shell');
}

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveLocalHostScript', () => {
  it('maps a container path into the configured host root', () => {
    const hostRoot = makeTempShellRoot();
    const scriptPath = path.join(hostRoot, 'ops', 'restart.sh');
    writeExecutable(scriptPath, '#!/bin/sh\nexit 0\n');

    const resolved = resolveLocalHostScript(
      `${CONTAINER_LOCAL_SHELL_ROOT}/ops/restart.sh`,
      hostRoot,
    );

    expect(resolved.relativePath).toBe('ops/restart.sh');
    expect(resolved.realScriptPath).toBe(fs.realpathSync(scriptPath));
  });

  it('rejects symlinks that escape the configured host root', () => {
    const hostRoot = makeTempShellRoot();
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-host-script-outside-'),
    );
    tempDirs.push(outsideDir);
    const outsideScript = path.join(outsideDir, 'outside.sh');
    writeExecutable(outsideScript, '#!/bin/sh\nexit 0\n');

    const linkPath = path.join(hostRoot, 'escape.sh');
    fs.symlinkSync(outsideScript, linkPath);

    expect(() =>
      resolveLocalHostScript(
        `${CONTAINER_LOCAL_SHELL_ROOT}/escape.sh`,
        hostRoot,
      ),
    ).toThrow('escapes the allowed local/shell root');
  });
});

describe('runLocalHostScript', () => {
  it('runs the script from its own directory', async () => {
    const hostRoot = makeTempShellRoot();
    const scriptPath = path.join(hostRoot, 'nested', 'pwd.sh');
    writeExecutable(scriptPath, '#!/bin/sh\npwd\nprintf "arg=%s\\n" "$1"\n');

    const result = await runLocalHostScript(
      `${CONTAINER_LOCAL_SHELL_ROOT}/nested/pwd.sh`,
      ['hello'],
      { hostRootDir: hostRoot, timeoutMs: 5000 },
    );

    expect(result.status).toBe('success');
    expect(result.stdout).toContain(path.join(hostRoot, 'nested'));
    expect(result.stdout).toContain('arg=hello');
    expect(result.exitCode).toBe(0);
  });

  it('returns an error result for non-zero exits', async () => {
    const hostRoot = makeTempShellRoot();
    const scriptPath = path.join(hostRoot, 'fail.sh');
    writeExecutable(scriptPath, '#!/bin/sh\necho "boom" 1>&2\nexit 7\n');

    const result = await runLocalHostScript(
      `${CONTAINER_LOCAL_SHELL_ROOT}/fail.sh`,
      [],
      { hostRootDir: hostRoot, timeoutMs: 5000 },
    );

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('boom');
    expect(result.error).toContain('code 7');
  });
});
