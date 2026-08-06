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
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IDENTITY_DIRECTORY = 'collaboration-identity';
const AGENT_ID_FILE = 'agent.json';
const AGENT_ID_FORMAT = 'icarus.collaboration-local-identity/1';
const AGENT_ID_PATTERN =
  /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CollaborationSigningIdentity {
  readonly principalId: string;
  readonly agentId: string;
  readonly privateKeyPath: string;
  readonly publicKey: string;
  readonly keyRef: string;
}

interface StoredAgentIdentity {
  readonly format: typeof AGENT_ID_FORMAT;
  readonly agentId: string;
}

export function collaborationPrincipalIdFromFingerprint(
  fingerprint: string,
): string {
  if (!/^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(fingerprint))
    throw new Error(`Unsupported SSH public key fingerprint: ${fingerprint}`);
  const digest = fingerprint
    .slice('SHA256:'.length)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `principal_ssh_sha256_${digest}`;
}

function parseStoredAgentIdentity(contents: string, filePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Collaboration agent identity is invalid: ${filePath}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Partial<StoredAgentIdentity>).format !== AGENT_ID_FORMAT ||
    typeof (parsed as Partial<StoredAgentIdentity>).agentId !== 'string' ||
    !AGENT_ID_PATTERN.test((parsed as StoredAgentIdentity).agentId)
  )
    throw new Error(`Collaboration agent identity is invalid: ${filePath}`);
  return (parsed as StoredAgentIdentity).agentId;
}

export class CollaborationIdentityService {
  readonly identityDirectory: string;
  readonly agentIdentityPath: string;
  private agentIdPromise: Promise<string> | null = null;

  constructor(storeDir: string) {
    this.identityDirectory = path.join(storeDir, IDENTITY_DIRECTORY);
    this.agentIdentityPath = path.join(this.identityDirectory, AGENT_ID_FILE);
  }

  agentId(): Promise<string> {
    this.agentIdPromise ??= this.loadOrCreateAgentId().catch((error) => {
      this.agentIdPromise = null;
      throw error;
    });
    return this.agentIdPromise;
  }

  async resolveSigningIdentity(
    signingKeyPath: string,
  ): Promise<CollaborationSigningIdentity> {
    const privateKeyPath = path.resolve(signingKeyPath.trim());
    const publicKeyPath = `${privateKeyPath}.pub`;
    const [agentId, publicKey, sshResult] = await Promise.all([
      this.agentId(),
      readFile(publicKeyPath, 'utf8').then((value) => value.trim()),
      execFileAsync('ssh-keygen', ['-lf', publicKeyPath, '-E', 'sha256'], {
        encoding: 'utf8',
      }),
    ]);
    const fingerprint = sshResult.stdout.match(/SHA256:[^\s]+/)?.[0];
    const keyType = publicKey.split(/\s+/, 1)[0];
    if (!fingerprint || !keyType)
      throw new Error(
        `Cannot derive SSH signing identity from ${publicKeyPath}`,
      );
    return {
      principalId: collaborationPrincipalIdFromFingerprint(fingerprint),
      agentId,
      privateKeyPath,
      publicKey,
      keyRef: `${keyType}:${fingerprint}`,
    };
  }

  private async loadOrCreateAgentId(): Promise<string> {
    await mkdir(this.identityDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.identityDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error(
        `Collaboration identity directory is unsafe: ${this.identityDirectory}`,
      );
    await chmod(this.identityDirectory, 0o700);

    try {
      return await this.readAgentId();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const candidate = `agent_${crypto.randomUUID()}`;
    const temporaryPath = path.join(
      this.identityDirectory,
      `.agent-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    const record: StoredAgentIdentity = {
      format: AGENT_ID_FORMAT,
      agentId: candidate,
    };
    let temporaryCreated = false;
    try {
      const handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      temporaryCreated = true;
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, this.agentIdentityPath);
        await chmod(this.agentIdentityPath, 0o600);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return await this.readAgentId();
      }
    } finally {
      if (temporaryCreated)
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
  }

  private async readAgentId(): Promise<string> {
    const metadata = await lstat(this.agentIdentityPath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(
        `Collaboration agent identity file is unsafe: ${this.agentIdentityPath}`,
      );
    await chmod(this.agentIdentityPath, 0o600);
    return parseStoredAgentIdentity(
      await readFile(this.agentIdentityPath, 'utf8'),
      this.agentIdentityPath,
    );
  }
}
