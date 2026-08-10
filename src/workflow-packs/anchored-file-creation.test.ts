import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ANCHORED_FILE_HELPER_MAX_BYTES,
  createFileWithAnchoredParents,
  resolveAnchoredFileHelperPath,
  validateAnchoredFileHelperDirectory,
} from './anchored-file-creation.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-anchored-helper-')),
  );
  roots.push(root);
  return root;
}

function inputFor(
  root: string,
  overrides: Partial<Parameters<typeof createFileWithAnchoredParents>[0]> = {},
): Parameters<typeof createFileWithAnchoredParents>[0] {
  const stat = fs.statSync(root);
  return {
    rootPath: root,
    rootDevice: stat.dev,
    rootInode: stat.ino,
    relativePath: 'nested/output.bin',
    bytes: Buffer.from('delivered-helper'),
    mode: 0o600,
    verifyCreatedFile: () => undefined,
    ...overrides,
  };
}

describe('anchored file helper delivery and protocol', () => {
  it('creates output with the delivered helper when PATH and CC have no compiler', async () => {
    const root = makeRoot();
    const originalPath = process.env.PATH;
    const originalCompiler = process.env.CC;
    process.env.PATH = '/definitely/no/toolchain';
    process.env.CC = '/definitely/no/compiler';
    try {
      await createFileWithAnchoredParents(inputFor(root));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCompiler === undefined) delete process.env.CC;
      else process.env.CC = originalCompiler;
    }

    expect(fs.readFileSync(path.join(root, 'nested/output.bin'), 'utf8')).toBe(
      'delivered-helper',
    );
  });

  it('rejects an oversized payload before resolving or spawning the helper', async () => {
    const root = makeRoot();
    const oversizedWithoutAllocation = {
      byteLength: ANCHORED_FILE_HELPER_MAX_BYTES + 1,
    } as Uint8Array;

    await expect(
      createFileWithAnchoredParents(
        inputFor(root, { bytes: oversizedWithoutAllocation }),
      ),
    ).rejects.toThrow(`output exceeds ${ANCHORED_FILE_HELPER_MAX_BYTES} bytes`);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('turns an early helper exit and stdin EPIPE into a controlled rejection', async () => {
    const root = makeRoot();
    await expect(
      createFileWithAnchoredParents(
        inputFor(root, {
          bytes: Buffer.alloc(16 * 1024 * 1024, 1),
          testProtocolMode: 'exit_after_ready',
        }),
      ),
    ).rejects.toThrow(/anchored file helper/u);
    expect(fs.existsSync(path.join(root, 'nested/output.bin'))).toBe(false);
  });

  it('kills a hung helper and reports a controlled timeout', async () => {
    const root = makeRoot();
    await expect(
      createFileWithAnchoredParents(
        inputFor(root, {
          testProtocolMode: 'hang_after_ready',
          timeoutMs: 25,
        }),
      ),
    ).rejects.toThrow('timed out');
    expect(fs.existsSync(path.join(root, 'nested/output.bin'))).toBe(false);
  });

  it('survives helper stdin failure in an independent Node Host process', () => {
    const root = makeRoot();
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), 'src/workflow-packs/anchored-file-creation.ts'),
    ).href;
    const script = `
      import fs from 'node:fs';
      import { createFileWithAnchoredParents } from ${JSON.stringify(moduleUrl)};
      const root = ${JSON.stringify(root)};
      const stat = fs.statSync(root);
      try {
        await createFileWithAnchoredParents({
          rootPath: root,
          rootDevice: stat.dev,
          rootInode: stat.ino,
          relativePath: 'child/output.bin',
          bytes: Buffer.alloc(32 * 1024 * 1024, 1),
          mode: 0o600,
          testProtocolMode: 'exit_after_ready',
          verifyCreatedFile() {},
        });
        process.exitCode = 2;
      } catch (error) {
        console.log('HOST_SURVIVED_STDIN_FAILURE');
        console.log(error instanceof Error ? error.message : String(error));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          CC: '/definitely/no/compiler',
          PATH: '/definitely/no/toolchain',
        },
        timeout: 15_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('HOST_SURVIVED_STDIN_FAILURE');
    expect(result.stdout).toContain('anchored file helper input failed');
    expect(fs.existsSync(path.join(root, 'child/output.bin'))).toBe(false);
  });

  it('rolls back the anchored file when the commit decision stream ends', async () => {
    const root = makeRoot();
    const helper = resolveAnchoredFileHelperPath();
    const stat = fs.statSync(root);
    const child = spawn(
      helper,
      [root, 'decision/output.bin', String(stat.dev), String(stat.ino), '600'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const payload = Buffer.from('must-be-rolled-back');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));

    const closeCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes('READY\n') && !stdout.includes('PAYLOAD_SENT')) {
          stdout += 'PAYLOAD_SENT';
          child.stdin.write(length);
          child.stdin.write(payload);
        }
        if (stdout.includes('WRITTEN ') && !child.stdin.writableEnded) {
          child.stdin.end();
        }
      });
      child.once('close', resolve);
    });

    expect(closeCode).not.toBe(0);
    expect(stderr).toContain('commit decision input ended before commit');
    expect(fs.existsSync(path.join(root, 'decision/output.bin'))).toBe(false);
  });

  it('rejects a tampered delivered helper by its manifest hash', () => {
    const deliveredHelper = resolveAnchoredFileHelperPath();
    const deliveredDirectory = path.dirname(deliveredHelper);
    const copiedDirectory = path.join(makeRoot(), 'delivered-copy');
    fs.cpSync(deliveredDirectory, copiedDirectory, { recursive: true });
    fs.appendFileSync(
      path.join(copiedDirectory, path.basename(deliveredHelper)),
      Buffer.from('tamper'),
    );

    expect(() => validateAnchoredFileHelperDirectory(copiedDirectory)).toThrow(
      'hash mismatch',
    );
  });

  it('reports a missing delivered helper without runtime compilation', () => {
    const deliveredHelper = resolveAnchoredFileHelperPath();
    const deliveredDirectory = path.dirname(deliveredHelper);
    const copiedDirectory = path.join(makeRoot(), 'missing-helper-copy');
    fs.cpSync(deliveredDirectory, copiedDirectory, { recursive: true });
    fs.rmSync(path.join(copiedDirectory, path.basename(deliveredHelper)));

    expect(() => validateAnchoredFileHelperDirectory(copiedDirectory)).toThrow(
      'helper binary is missing',
    );
  });
});
