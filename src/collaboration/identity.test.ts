import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CollaborationIdentityService } from './identity.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'icarus-identity-test-'));
  roots.push(value);
  return value;
}

function key(testRoot: string, name: string): string {
  const target = path.join(testRoot, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', target]);
  return target;
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('CollaborationIdentityService', () => {
  it('derives a stable principal from the SSH fingerprint', async () => {
    const testRoot = root();
    const signingKey = key(testRoot, 'signing-key');
    const service = new CollaborationIdentityService(
      path.join(testRoot, 'store'),
    );

    const first = await service.resolveSigningIdentity(signingKey);
    const restarted = await new CollaborationIdentityService(
      path.join(testRoot, 'store'),
    ).resolveSigningIdentity(signingKey);

    expect(first.principalId).toMatch(/^principal_ssh_sha256_[A-Za-z0-9_-]+$/);
    expect(restarted.principalId).toBe(first.principalId);
    expect(restarted.keyRef).toBe(first.keyRef);
  });

  it('derives different principals from different public keys', async () => {
    const testRoot = root();
    const service = new CollaborationIdentityService(
      path.join(testRoot, 'store'),
    );
    const first = await service.resolveSigningIdentity(key(testRoot, 'key-a'));
    const second = await service.resolveSigningIdentity(key(testRoot, 'key-b'));

    expect(second.principalId).not.toBe(first.principalId);
    expect(second.agentId).toBe(first.agentId);
  });

  it('atomically creates one restart-stable agent id with private permissions', async () => {
    const testRoot = root();
    const storeDir = path.join(testRoot, 'store');
    const services = Array.from(
      { length: 12 },
      () => new CollaborationIdentityService(storeDir),
    );
    const concurrent = await Promise.all(
      services.map((service) => service.agentId()),
    );

    expect(new Set(concurrent).size).toBe(1);
    expect(concurrent[0]).toMatch(/^agent_[0-9a-f-]{36}$/);
    expect(await new CollaborationIdentityService(storeDir).agentId()).toBe(
      concurrent[0],
    );
    expect(statSync(services[0]!.identityDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(services[0]!.agentIdentityPath).mode & 0o777).toBe(0o600);
  });

  it('uses a different agent id for a different installation store', async () => {
    const testRoot = root();
    const first = await new CollaborationIdentityService(
      path.join(testRoot, 'store-a'),
    ).agentId();
    const second = await new CollaborationIdentityService(
      path.join(testRoot, 'store-b'),
    ).agentId();

    expect(second).not.toBe(first);
  });
});
