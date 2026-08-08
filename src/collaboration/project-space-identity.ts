import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  prettyCollaborationJson,
  strictParseJson,
} from './protocol/canonical-json.js';

const execFileAsync = promisify(execFile);
const IDENTITY_DIRECTORY = 'collaboration-identity';
const CLIENT_ID_FILE = 'client.json';
const CLIENT_ID_FORMAT = 'icarus.collaboration-local-client/1';
const CLIENT_ID_PATTERN =
  /^client_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CollaborationPrincipalIdentity {
  readonly principalId: string;
  readonly clientId: string;
  readonly privateKeyPath: string;
  readonly publicKey: string;
  readonly keyRef: string;
}

interface StoredClientIdentity {
  readonly format: typeof CLIENT_ID_FORMAT;
  readonly client_id: string;
}

export function collaborationPrincipalIdFromSshFingerprintV3(
  fingerprint: string,
): string {
  if (!/^SHA256:[A-Za-z0-9+/]+={0,2}$/u.test(fingerprint))
    throw new Error(`Unsupported SSH public key fingerprint: ${fingerprint}`);
  const digest = fingerprint
    .slice('SHA256:'.length)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `principal_ssh_sha256_${digest}`;
}

function parseStoredClientIdentity(contents: string, filePath: string): string {
  const parsed = strictParseJson(contents);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.format !== CLIENT_ID_FORMAT ||
    typeof parsed.client_id !== 'string' ||
    !CLIENT_ID_PATTERN.test(parsed.client_id)
  )
    throw new Error(`Collaboration Client identity is invalid: ${filePath}`);
  return parsed.client_id;
}

export class CollaborationProjectSpaceIdentityService {
  readonly identityDirectory: string;
  readonly clientIdentityPath: string;
  readonly defaultSigningKeyPath: string;
  private clientIdPromise: Promise<string> | null = null;

  constructor(
    storeDirectory: string,
    defaultSigningKeyPath = path.join(os.homedir(), '.ssh', 'id_rsa'),
  ) {
    const configuredDefault =
      defaultSigningKeyPath.trim() || path.join(os.homedir(), '.ssh', 'id_rsa');
    this.identityDirectory = path.join(storeDirectory, IDENTITY_DIRECTORY);
    this.clientIdentityPath = path.join(this.identityDirectory, CLIENT_ID_FILE);
    this.defaultSigningKeyPath = path.resolve(
      configuredDefault.replace(/^~(?=$|[\\/])/u, os.homedir()),
    );
  }

  clientId(): Promise<string> {
    this.clientIdPromise ??= this.loadOrCreateClientId().catch((error) => {
      this.clientIdPromise = null;
      throw error;
    });
    return this.clientIdPromise;
  }

  async resolveSigningIdentity(
    signingKeyPath?: string,
  ): Promise<CollaborationPrincipalIdentity> {
    const configuredPath = signingKeyPath?.trim() || this.defaultSigningKeyPath;
    const privateKeyPath = path.resolve(
      configuredPath.replace(/^~(?=$|[\\/])/u, os.homedir()),
    );
    const publicKeyPath = `${privateKeyPath}.pub`;
    const [clientId, publicKey, sshResult] = await Promise.all([
      this.clientId(),
      readFile(publicKeyPath, 'utf8').then((value) => value.trim()),
      execFileAsync('ssh-keygen', ['-lf', publicKeyPath, '-E', 'sha256'], {
        encoding: 'utf8',
      }),
    ]);
    const fingerprint = sshResult.stdout.match(/SHA256:[^\s]+/u)?.[0];
    const keyType = publicKey.split(/\s+/u, 1)[0];
    if (!fingerprint || !keyType)
      throw new Error(
        `Cannot derive SSH signing identity from ${publicKeyPath}`,
      );
    return {
      principalId: collaborationPrincipalIdFromSshFingerprintV3(fingerprint),
      clientId,
      privateKeyPath,
      publicKey,
      keyRef: `${keyType}:${fingerprint}`,
    };
  }

  private async loadOrCreateClientId(): Promise<string> {
    await mkdir(this.identityDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.identityDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error(
        `Collaboration identity directory is unsafe: ${this.identityDirectory}`,
      );
    await chmod(this.identityDirectory, 0o700);
    try {
      return await this.readClientId();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const candidate = `client_${crypto.randomUUID()}`;
    const temporaryPath = path.join(
      this.identityDirectory,
      `.client-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    let temporaryCreated = false;
    try {
      const handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      temporaryCreated = true;
      try {
        const record: StoredClientIdentity = {
          format: CLIENT_ID_FORMAT,
          client_id: candidate,
        };
        await handle.writeFile(prettyCollaborationJson(record), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, this.clientIdentityPath);
        await chmod(this.clientIdentityPath, 0o600);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return await this.readClientId();
      }
    } finally {
      if (temporaryCreated)
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
  }

  private async readClientId(): Promise<string> {
    const metadata = await lstat(this.clientIdentityPath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(
        `Collaboration Client identity file is unsafe: ${this.clientIdentityPath}`,
      );
    await chmod(this.clientIdentityPath, 0o600);
    return parseStoredClientIdentity(
      await readFile(this.clientIdentityPath, 'utf8'),
      this.clientIdentityPath,
    );
  }
}
