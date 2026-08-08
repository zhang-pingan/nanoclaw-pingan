import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CollaborationProjectSpaceIdentityService } from './project-space-identity.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'icarus-collaboration-identity-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Collaboration project-space identity', () => {
  it('uses the configured default SSH signing key when the request omits it', async () => {
    const root = temporaryDirectory();
    const defaultKeyPath = path.join(root, 'default-key');
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      defaultKeyPath,
    ]);
    const service = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'store'),
      defaultKeyPath,
    );

    const identity = await service.resolveSigningIdentity();

    expect(identity.privateKeyPath).toBe(defaultKeyPath);
    expect(identity.publicKey).toBe(
      readFileSync(`${defaultKeyPath}.pub`, 'utf8').trim(),
    );
    expect(identity.principalId).toMatch(/^principal_ssh_sha256_/u);
  });
});
