import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  it('persists one installation Client and generates private event Credentials', async () => {
    const root = temporaryDirectory();
    const service = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'store'),
    );

    const identity = await service.createPrincipalIdentity();
    const rotated = await service.createCredentialIdentity({
      principalId: identity.principalId,
    });
    const reloaded = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'store'),
    );

    expect(identity.principalId).toMatch(/^principal_[0-9a-f-]{36}$/u);
    expect(identity.clientId).toMatch(/^client_[0-9a-f-]{36}$/u);
    expect(identity.credentialId).toMatch(/^credential_[0-9a-f-]{36}$/u);
    expect(rotated.principalId).toBe(identity.principalId);
    expect(rotated.clientId).toBe(identity.clientId);
    expect(rotated.credentialId).not.toBe(identity.credentialId);
    expect(await reloaded.clientId()).toBe(identity.clientId);
    expect(identity.publicKey).toBe(
      readFileSync(`${identity.privateKeyPath}.pub`, 'utf8').trim(),
    );
    expect(statSync(path.dirname(identity.privateKeyPath)).mode & 0o777).toBe(
      0o700,
    );
    expect(statSync(identity.privateKeyPath).mode & 0o777).toBe(0o600);
  });

  it('resolves the independent Git transport SSH key and expands home paths', () => {
    const root = temporaryDirectory();
    const service = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'store'),
      '~/default-git-key',
    );

    expect(service.resolveGitSshKeyPath()).toBe(
      path.join(os.homedir(), 'default-git-key'),
    );
    expect(service.resolveGitSshKeyPath('~/explicit-git-key')).toBe(
      path.join(os.homedir(), 'explicit-git-key'),
    );
  });

  it('exports and imports only an explicit offline Group recovery Credential', async () => {
    const root = temporaryDirectory();
    const source = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'source'),
    );
    const principal = await source.createPrincipalIdentity();
    const recovery = await source.createCredentialIdentity({
      principalId: principal.principalId,
      clientId: principal.clientId,
      purpose: 'group_recovery',
    });
    const exportedPath = path.join(root, 'offline', 'group-recovery');

    await expect(
      source.exportRecoveryCredential(principal.credentialId, exportedPath),
    ).rejects.toThrow(/Group recovery/u);
    await source.exportRecoveryCredential(recovery.credentialId, exportedPath);
    expect(statSync(exportedPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${exportedPath}.icarus.json`).mode & 0o777).toBe(0o600);

    const destination = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'destination'),
    );
    const imported = await destination.importRecoveryCredential(exportedPath);
    expect(imported).toMatchObject({
      principalId: recovery.principalId,
      clientId: recovery.clientId,
      credentialId: recovery.credentialId,
      fingerprint: recovery.fingerprint,
      purpose: 'group_recovery',
    });
    expect(readFileSync(imported.privateKeyPath, 'utf8')).toBe(
      readFileSync(recovery.privateKeyPath, 'utf8'),
    );
  });

  it('exports the recovery trio exclusively without overwriting files or following symlinks', async () => {
    const root = temporaryDirectory();
    const service = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'store'),
    );
    const principal = await service.createPrincipalIdentity();
    const recovery = await service.createCredentialIdentity({
      principalId: principal.principalId,
      clientId: principal.clientId,
      purpose: 'group_recovery',
    });

    for (const [index, suffix] of ['', '.pub', '.icarus.json'].entries()) {
      const destination = path.join(root, `existing-${String(index)}`);
      const protectedPath = `${destination}${suffix}`;
      writeFileSync(protectedPath, `protected-${String(index)}`, {
        mode: 0o600,
      });

      await expect(
        service.exportRecoveryCredential(recovery.credentialId, destination),
      ).rejects.toThrow(/already exists|symlink/u);
      expect(readFileSync(protectedPath, 'utf8')).toBe(
        `protected-${String(index)}`,
      );
      for (const candidate of [
        destination,
        `${destination}.pub`,
        `${destination}.icarus.json`,
      ])
        if (candidate !== protectedPath)
          expect(existsSync(candidate)).toBe(false);
    }

    const protectedKey = path.join(root, 'protected-key');
    const symlinkDestination = path.join(root, 'symlink-export');
    writeFileSync(protectedKey, 'do-not-overwrite', { mode: 0o600 });
    symlinkSync(protectedKey, symlinkDestination);
    await expect(
      service.exportRecoveryCredential(
        recovery.credentialId,
        symlinkDestination,
      ),
    ).rejects.toThrow(/already exists|symlink/u);
    expect(lstatSync(symlinkDestination).isSymbolicLink()).toBe(true);
    expect(readFileSync(protectedKey, 'utf8')).toBe('do-not-overwrite');
    expect(existsSync(`${symlinkDestination}.pub`)).toBe(false);
    expect(existsSync(`${symlinkDestination}.icarus.json`)).toBe(false);
  });

  it('rejects recovery backups whose metadata, public key, and private key disagree', async () => {
    const root = temporaryDirectory();
    const source = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'source'),
    );
    const principal = await source.createPrincipalIdentity();
    const recovery = await source.createCredentialIdentity({
      principalId: principal.principalId,
      purpose: 'group_recovery',
    });
    const replacement = await source.createCredentialIdentity({
      principalId: principal.principalId,
      purpose: 'group_recovery',
    });
    const destination = new CollaborationProjectSpaceIdentityService(
      path.join(root, 'destination'),
    );

    const metadataMismatch = path.join(root, 'metadata-mismatch');
    await source.exportRecoveryCredential(
      recovery.credentialId,
      metadataMismatch,
    );
    const metadata = JSON.parse(
      readFileSync(`${metadataMismatch}.icarus.json`, 'utf8'),
    ) as Record<string, unknown>;
    metadata.public_key = replacement.publicKey;
    writeFileSync(
      `${metadataMismatch}.icarus.json`,
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(
      destination.importRecoveryCredential(metadataMismatch),
    ).rejects.toThrow(/keypair|fingerprint/u);

    const privateKeyMismatch = path.join(root, 'private-key-mismatch');
    await source.exportRecoveryCredential(
      recovery.credentialId,
      privateKeyMismatch,
    );
    copyFileSync(replacement.privateKeyPath, privateKeyMismatch);
    await expect(
      destination.importRecoveryCredential(privateKeyMismatch),
    ).rejects.toThrow(/keypair|fingerprint/u);
  });
});
