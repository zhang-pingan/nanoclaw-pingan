import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
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
const CREDENTIAL_DIRECTORY = 'credentials';
const CLIENT_ID_FILE = 'client.json';
const CLIENT_ID_FORMAT = 'icarus.collaboration-local-client/1';
const CREDENTIAL_METADATA_FORMAT = 'icarus.collaboration-local-credential/1';
const CLIENT_ID_PATTERN =
  /^client_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINCIPAL_ID_PATTERN =
  /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CREDENTIAL_ID_PATTERN =
  /^credential_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type CollaborationCredentialPurpose = 'event_signing' | 'group_recovery';

export interface CollaborationEventSigningIdentity {
  readonly principalId: string;
  readonly clientId: string;
  readonly credentialId: string;
  readonly privateKeyPath: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly purpose: CollaborationCredentialPurpose;
}

interface StoredClientIdentity {
  readonly format: typeof CLIENT_ID_FORMAT;
  readonly client_id: string;
}

interface StoredCredentialIdentity {
  readonly format: typeof CREDENTIAL_METADATA_FORMAT;
  readonly credential_id: string;
  readonly principal_id: string;
  readonly client_id: string;
  readonly public_key: string;
  readonly fingerprint: string;
  readonly purpose: CollaborationCredentialPurpose;
}

function expandLocalPath(value: string): string {
  return path.resolve(value.replace(/^~(?=$|[\\/])/u, os.homedir()));
}

function publicKeyMaterial(value: string, filePath: string): string {
  const [algorithm, encoded] = value.trim().split(/\s+/u);
  if (!algorithm || !encoded)
    throw new Error(
      `Collaboration Credential public key is invalid: ${filePath}`,
    );
  return `${algorithm} ${encoded}`;
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

function parseStoredCredentialIdentity(
  contents: string,
  filePath: string,
): StoredCredentialIdentity {
  const parsed = strictParseJson(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(
      `Collaboration Credential metadata is invalid: ${filePath}`,
    );
  const value = parsed as Record<string, unknown>;
  if (
    value.format !== CREDENTIAL_METADATA_FORMAT ||
    typeof value.credential_id !== 'string' ||
    !CREDENTIAL_ID_PATTERN.test(value.credential_id) ||
    typeof value.principal_id !== 'string' ||
    !PRINCIPAL_ID_PATTERN.test(value.principal_id) ||
    typeof value.client_id !== 'string' ||
    !CLIENT_ID_PATTERN.test(value.client_id) ||
    typeof value.public_key !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    !/^SHA256:[A-Za-z0-9+/]+={0,2}$/u.test(value.fingerprint) ||
    (value.purpose !== 'event_signing' && value.purpose !== 'group_recovery')
  )
    throw new Error(
      `Collaboration Credential metadata is invalid: ${filePath}`,
    );
  return value as unknown as StoredCredentialIdentity;
}

export class CollaborationProjectSpaceIdentityService {
  readonly identityDirectory: string;
  readonly credentialDirectory: string;
  readonly defaultGitSshKeyPath: string;
  private clientIdPromise: Promise<string> | null = null;

  constructor(
    storeDirectory: string,
    defaultGitSshKeyPath = process.env.SSH_KEY_PATH ||
      path.join(os.homedir(), '.ssh', 'id_rsa'),
  ) {
    this.identityDirectory = path.join(storeDirectory, IDENTITY_DIRECTORY);
    this.credentialDirectory = path.join(
      this.identityDirectory,
      CREDENTIAL_DIRECTORY,
    );
    this.defaultGitSshKeyPath = expandLocalPath(
      defaultGitSshKeyPath.trim() ||
        process.env.SSH_KEY_PATH?.trim() ||
        path.join(os.homedir(), '.ssh', 'id_rsa'),
    );
  }

  clientId(): Promise<string> {
    this.clientIdPromise ??= this.loadOrCreateClientId().catch((error) => {
      this.clientIdPromise = null;
      throw error;
    });
    return this.clientIdPromise;
  }

  resolveGitSshKeyPath(configured?: string | null): string {
    return expandLocalPath(
      configured?.trim() ||
        process.env.SSH_KEY_PATH?.trim() ||
        this.defaultGitSshKeyPath,
    );
  }

  async createPrincipalIdentity(): Promise<CollaborationEventSigningIdentity> {
    return this.createCredentialIdentity({
      principalId: `principal_${crypto.randomUUID()}`,
      purpose: 'event_signing',
    });
  }

  async createCredentialIdentity(input: {
    readonly principalId: string;
    readonly purpose?: CollaborationCredentialPurpose;
    readonly clientId?: string;
  }): Promise<CollaborationEventSigningIdentity> {
    if (!PRINCIPAL_ID_PATTERN.test(input.principalId))
      throw new Error(
        `Invalid Collaboration Principal id: ${input.principalId}`,
      );
    const clientId = input.clientId ?? (await this.clientId());
    if (!CLIENT_ID_PATTERN.test(clientId))
      throw new Error(`Invalid Collaboration Client id: ${clientId}`);
    const credentialId = `credential_${crypto.randomUUID()}`;
    const directory = path.join(this.credentialDirectory, credentialId);
    await this.ensurePrivateDirectory(directory);
    const privateKeyPath = path.join(directory, 'credential');
    await execFileAsync(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-f', privateKeyPath],
      { encoding: 'utf8' },
    );
    await chmod(privateKeyPath, 0o600);
    await chmod(`${privateKeyPath}.pub`, 0o600);
    const publicKey = (await readFile(`${privateKeyPath}.pub`, 'utf8')).trim();
    const fingerprint = await this.fingerprintPublicKey(
      `${privateKeyPath}.pub`,
    );
    const metadata: StoredCredentialIdentity = {
      format: CREDENTIAL_METADATA_FORMAT,
      credential_id: credentialId,
      principal_id: input.principalId,
      client_id: clientId,
      public_key: publicKey,
      fingerprint,
      purpose: input.purpose ?? 'event_signing',
    };
    await writeFile(
      path.join(directory, 'metadata.json'),
      prettyCollaborationJson(metadata),
      { mode: 0o600 },
    );
    return this.localCredential(metadata, privateKeyPath);
  }

  async loadCredentialIdentity(
    credentialId: string,
  ): Promise<CollaborationEventSigningIdentity> {
    if (!CREDENTIAL_ID_PATTERN.test(credentialId))
      throw new Error(`Invalid Collaboration Credential id: ${credentialId}`);
    const directory = path.join(this.credentialDirectory, credentialId);
    const metadataPath = path.join(directory, 'metadata.json');
    const privateKeyPath = path.join(directory, 'credential');
    const publicKeyPath = `${privateKeyPath}.pub`;
    const [
      directoryMetadata,
      keyMetadata,
      publicKeyMetadata,
      metadataMetadata,
      metadata,
    ] = await Promise.all([
      lstat(directory),
      lstat(privateKeyPath),
      lstat(publicKeyPath),
      lstat(metadataPath),
      readFile(metadataPath, 'utf8').then((contents) =>
        parseStoredCredentialIdentity(contents, metadataPath),
      ),
    ]);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      !keyMetadata.isFile() ||
      keyMetadata.isSymbolicLink() ||
      !publicKeyMetadata.isFile() ||
      publicKeyMetadata.isSymbolicLink() ||
      !metadataMetadata.isFile() ||
      metadataMetadata.isSymbolicLink()
    )
      throw new Error(
        `Collaboration Credential storage is unsafe: ${directory}`,
      );
    await chmod(directory, 0o700);
    await chmod(privateKeyPath, 0o600);
    await chmod(publicKeyPath, 0o600);
    await chmod(metadataPath, 0o600);
    await this.validateCredentialKeypair(
      metadata,
      privateKeyPath,
      publicKeyPath,
    );
    return this.localCredential(metadata, privateKeyPath);
  }

  async exportRecoveryCredential(
    credentialId: string,
    destinationPath: string,
  ): Promise<string> {
    const identity = await this.loadCredentialIdentity(credentialId);
    if (identity.purpose !== 'group_recovery')
      throw new Error('Only a Group recovery Credential can be exported');
    const destination = expandLocalPath(destinationPath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(identity.privateKeyPath, destination);
    await chmod(destination, 0o600);
    await copyFile(`${identity.privateKeyPath}.pub`, `${destination}.pub`);
    await chmod(`${destination}.pub`, 0o600);
    const metadata = await readFile(
      path.join(this.credentialDirectory, credentialId, 'metadata.json'),
      'utf8',
    );
    await writeFile(`${destination}.icarus.json`, metadata, { mode: 0o600 });
    return destination;
  }

  async importRecoveryCredential(
    sourcePath: string,
  ): Promise<CollaborationEventSigningIdentity> {
    const source = expandLocalPath(sourcePath);
    const metadataPath = `${source}.icarus.json`;
    const metadata = parseStoredCredentialIdentity(
      await readFile(metadataPath, 'utf8'),
      metadataPath,
    );
    if (metadata.purpose !== 'group_recovery')
      throw new Error('Imported Credential is not a Group recovery Credential');
    const sourcePublicKeyPath = `${source}.pub`;
    const [sourceMetadata, publicKeyMetadata, metadataFileMetadata] =
      await Promise.all([
        lstat(source),
        lstat(sourcePublicKeyPath),
        lstat(metadataPath),
      ]);
    if (
      !sourceMetadata.isFile() ||
      sourceMetadata.isSymbolicLink() ||
      !publicKeyMetadata.isFile() ||
      publicKeyMetadata.isSymbolicLink() ||
      !metadataFileMetadata.isFile() ||
      metadataFileMetadata.isSymbolicLink()
    )
      throw new Error('Imported Group recovery Credential files are unsafe');
    await this.validateCredentialKeypair(metadata, source, sourcePublicKeyPath);
    const directory = path.join(
      this.credentialDirectory,
      metadata.credential_id,
    );
    await this.ensurePrivateDirectory(directory);
    const privateKeyPath = path.join(directory, 'credential');
    await copyFile(source, privateKeyPath);
    await copyFile(sourcePublicKeyPath, `${privateKeyPath}.pub`);
    await chmod(privateKeyPath, 0o600);
    await chmod(`${privateKeyPath}.pub`, 0o600);
    await writeFile(
      path.join(directory, 'metadata.json'),
      prettyCollaborationJson(metadata),
      { mode: 0o600 },
    );
    return this.localCredential(metadata, privateKeyPath);
  }

  private localCredential(
    metadata: StoredCredentialIdentity,
    privateKeyPath: string,
  ): CollaborationEventSigningIdentity {
    return {
      principalId: metadata.principal_id,
      clientId: metadata.client_id,
      credentialId: metadata.credential_id,
      privateKeyPath,
      publicKey: metadata.public_key,
      fingerprint: metadata.fingerprint,
      purpose: metadata.purpose,
    };
  }

  private async fingerprintPublicKey(publicKeyPath: string): Promise<string> {
    const result = await execFileAsync(
      'ssh-keygen',
      ['-lf', publicKeyPath, '-E', 'sha256'],
      { encoding: 'utf8' },
    );
    const fingerprint = result.stdout.match(/SHA256:[^\s]+/u)?.[0];
    if (!fingerprint)
      throw new Error(
        `Cannot fingerprint Collaboration Credential: ${publicKeyPath}`,
      );
    return fingerprint;
  }

  private async validateCredentialKeypair(
    metadata: StoredCredentialIdentity,
    privateKeyPath: string,
    publicKeyPath: string,
  ): Promise<void> {
    const [storedPublicKey, derived, fingerprint] = await Promise.all([
      readFile(publicKeyPath, 'utf8'),
      execFileAsync('ssh-keygen', ['-y', '-f', privateKeyPath], {
        encoding: 'utf8',
      }),
      this.fingerprintPublicKey(publicKeyPath),
    ]);
    const expected = publicKeyMaterial(metadata.public_key, publicKeyPath);
    if (
      publicKeyMaterial(storedPublicKey, publicKeyPath) !== expected ||
      publicKeyMaterial(derived.stdout, privateKeyPath) !== expected ||
      fingerprint !== metadata.fingerprint
    )
      throw new Error(
        `Collaboration Credential keypair or fingerprint mismatches: ${metadata.credential_id}`,
      );
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error(
        `Collaboration identity directory is unsafe: ${directory}`,
      );
    await chmod(directory, 0o700);
  }

  private async loadOrCreateClientId(): Promise<string> {
    await this.ensurePrivateDirectory(this.identityDirectory);
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

  private get clientIdentityPath(): string {
    return path.join(this.identityDirectory, CLIENT_ID_FILE);
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
