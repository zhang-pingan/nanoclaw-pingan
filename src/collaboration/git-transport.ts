import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  lstatSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import YAML from 'yaml';

import {
  COLLABORATION_CONTROL_BRANCH,
  CollaborationProtocolError,
  authorizeCollaborationEvent,
  collaborationDataPathSchema,
  deterministicProjectionJson,
  dataUpdatePayloadSchema,
  readPublicKey,
  reduceCollaborationEvent,
  validateCollaborationGitHistory,
  type ActionDefinition,
  type CollaborationEvent,
  type CollaborationProjection,
  type CollaborationRepositoryDefinition,
  type CollaborationValidationCheckpoint,
  type MachineDefinition,
  type MemberDefinition,
  type RoleClaim,
  type RoleDefinition,
  type ValidatedCollaborationHistory,
} from './protocol/index.js';

const execFileAsync = promisify(execFile);
const CONTROL_REMOTE_REF = 'refs/remotes/origin/icarus/control';

export class CollaborationGitConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationGitConflictError';
  }
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function execute(
  cwd: string,
  binary: string,
  args: readonly string[],
  allowFailure = false,
): Promise<GitResult> {
  try {
    const result = await execFileAsync(binary, [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    const result = {
      stdout: value.stdout ?? '',
      stderr: value.stderr ?? value.message,
      exitCode: typeof value.code === 'number' ? value.code : 1,
    };
    if (allowFailure) return result;
    throw new Error(
      `${binary} ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
}

function writeRepositoryFile(
  checkoutPath: string,
  repositoryFile: string,
  contents: string,
): void {
  const target = path.resolve(checkoutPath, repositoryFile);
  const checkoutRoot = path.resolve(checkoutPath);
  const root = `${checkoutRoot}${path.sep}`;
  if (!target.startsWith(root))
    throw new Error(`Repository path escapes checkout: ${repositoryFile}`);
  const relativeSegments = path.relative(checkoutRoot, target).split(path.sep);
  let candidate = checkoutRoot;
  for (const segment of relativeSegments) {
    candidate = path.join(candidate, segment);
    try {
      if (lstatSync(candidate).isSymbolicLink())
        throw new Error(
          `Repository path traverses a symbolic link: ${repositoryFile}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function eventPath(event: CollaborationEvent): string {
  return `events/${String(event.epoch)}/${String(event.sequence).padStart(8, '0')}-${event.event_id}.json`;
}

function materializeEvent(
  checkoutPath: string,
  event: CollaborationEvent,
  projection: CollaborationProjection,
  materializedFiles: readonly CollaborationMaterializedFile[] = [],
): void {
  writeRepositoryFile(
    checkoutPath,
    eventPath(event),
    `${JSON.stringify(event, null, 2)}\n`,
  );
  writeRepositoryFile(
    checkoutPath,
    'projection/state.json',
    deterministicProjectionJson(projection),
  );
  if (event.event_type === 'member_registered') {
    const member = event.payload.member as MemberDefinition;
    writeRepositoryFile(
      checkoutPath,
      `groups/members/${member.principal_id}.json`,
      `${JSON.stringify(member, null, 2)}\n`,
    );
  } else if (event.event_type === 'role_claimed') {
    const role = String(event.payload.role);
    const principal = String(event.payload.principal_id);
    const claims = projection.roleClaims[role] ?? [];
    const claim = claims.find(
      (candidate) => candidate.principal_id === principal,
    );
    if (!claim)
      throw new Error('Materialized role claim is missing from projection');
    writeRepositoryFile(
      checkoutPath,
      `groups/claims/${role}/${principal}.json`,
      `${JSON.stringify(claim, null, 2)}\n`,
    );
  } else if (event.event_type === 'role_released') {
    const target = path.join(
      checkoutPath,
      'groups',
      'claims',
      String(event.payload.role),
      `${String(event.payload.principal_id)}.json`,
    );
    try {
      unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const file of materializedFiles)
    writeRepositoryFile(checkoutPath, file.path, file.contents);
}

export interface CollaborationSigningIdentity {
  readonly principalId: string;
  readonly agentId: string;
  readonly privateKeyPath: string;
  readonly publicKey: string;
  readonly keyRef: string;
}

export async function loadCollaborationSigningIdentity(input: {
  readonly principalId: string;
  readonly agentId: string;
  readonly privateKeyPath: string;
}): Promise<CollaborationSigningIdentity> {
  const publicKeyPath = `${input.privateKeyPath}.pub`;
  const publicKey = await readPublicKey(publicKeyPath);
  const sshResult = await execFileAsync(
    'ssh-keygen',
    ['-lf', publicKeyPath, '-E', 'sha256'],
    { encoding: 'utf8' },
  );
  const keyFingerprint = sshResult.stdout.match(/SHA256:[^\s]+/)?.[0];
  const keyType = publicKey.split(/\s+/, 1)[0];
  if (!keyFingerprint || !keyType)
    throw new Error(`Cannot derive SSH signing identity from ${publicKeyPath}`);
  return {
    principalId: input.principalId,
    agentId: input.agentId,
    privateKeyPath: input.privateKeyPath,
    publicKey,
    keyRef: `${keyType}:${keyFingerprint}`,
  };
}

export interface CreateCollaborationRepositoryInput {
  readonly remoteUrl: string;
  readonly repositoryPath: string;
  readonly definition: CollaborationRepositoryDefinition;
  readonly prompts: Readonly<Record<string, string>>;
  readonly genesisEvent: CollaborationEvent;
  readonly genesisProjection: CollaborationProjection;
  readonly identity: CollaborationSigningIdentity;
}

export interface AppendCollaborationEventInput {
  readonly remoteUrl: string;
  readonly repositoryPath: string;
  readonly previousHead: string | null;
  readonly checkpoint?: CollaborationValidationCheckpoint | null;
  readonly identity: CollaborationSigningIdentity;
  readonly materializedFiles?: readonly CollaborationMaterializedFile[];
  readonly buildEvent: (
    history: ValidatedCollaborationHistory,
  ) => CollaborationEvent;
}

export interface CollaborationMaterializedFile {
  readonly path: string;
  readonly contents: string;
}

function dataFileHash(contents: string): string {
  return `sha256:${crypto.createHash('sha256').update(contents, 'utf8').digest('hex')}`;
}

function validateMaterializedFiles(
  event: CollaborationEvent,
  files: readonly CollaborationMaterializedFile[],
): void {
  if (event.event_type !== 'data_updated') {
    if (files.length > 0)
      throw new Error(`${event.event_type} cannot materialize shared data`);
    return;
  }
  const payload = dataUpdatePayloadSchema.parse(event.payload);
  if (files.length !== 1 || files[0]?.path !== payload.path)
    throw new Error('data_updated must materialize exactly its declared path');
  const contents = files[0].contents;
  if (
    Buffer.byteLength(contents, 'utf8') !== payload.size_bytes ||
    dataFileHash(contents) !== payload.content_sha256
  )
    throw new Error('data_updated content does not match its size and hash');
}

export class CollaborationGitTransport {
  private readonly gitBinary: string;

  constructor(options: { readonly gitBinary?: string } = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
  }

  async createRepository(
    input: CreateCollaborationRepositoryInput,
  ): Promise<ValidatedCollaborationHistory> {
    const remoteHead = await execute(
      process.cwd(),
      this.gitBinary,
      ['ls-remote', '--heads', input.remoteUrl, COLLABORATION_CONTROL_BRANCH],
      true,
    );
    if (remoteHead.exitCode !== 0)
      throw new Error(
        `Collaboration remote cannot be read: ${remoteHead.stderr.trim()}`,
      );
    if (remoteHead.stdout.trim())
      throw new Error(
        'Collaboration control branch already exists on the remote',
      );

    const checkoutPath = await this.temporaryCheckout('create');
    try {
      await execute(checkoutPath, this.gitBinary, ['init', '-q']);
      await execute(checkoutPath, this.gitBinary, [
        'checkout',
        '-q',
        '--orphan',
        'icarus/control',
      ]);
      await execute(checkoutPath, this.gitBinary, [
        'remote',
        'add',
        'origin',
        input.remoteUrl,
      ]);
      await this.configureSigner(checkoutPath, input.identity);
      this.writeDefinition(checkoutPath, input.definition, input.prompts);
      const genesisMember = input.genesisEvent.payload
        .member as MemberDefinition;
      const genesisClaim = input.genesisEvent.payload.role_claim as RoleClaim;
      writeRepositoryFile(
        checkoutPath,
        `groups/members/${genesisMember.principal_id}.json`,
        `${JSON.stringify(genesisMember, null, 2)}\n`,
      );
      writeRepositoryFile(
        checkoutPath,
        `groups/claims/${genesisClaim.role}/${genesisClaim.principal_id}.json`,
        `${JSON.stringify(genesisClaim, null, 2)}\n`,
      );
      materializeEvent(
        checkoutPath,
        input.genesisEvent,
        input.genesisProjection,
      );
      await this.commit(checkoutPath, input.genesisEvent);
      const push = await execute(
        checkoutPath,
        this.gitBinary,
        ['push', 'origin', `HEAD:${COLLABORATION_CONTROL_BRANCH}`],
        true,
      );
      if (push.exitCode !== 0)
        throw new CollaborationGitConflictError(
          `Collaboration genesis push lost its CAS race: ${push.stderr.trim()}`,
        );
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
    await this.cloneBare(input.remoteUrl, input.repositoryPath);
    return this.fetchAndValidate({
      remoteUrl: input.remoteUrl,
      repositoryPath: input.repositoryPath,
      previousHead: null,
    });
  }

  async cloneAndValidate(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
  }): Promise<ValidatedCollaborationHistory> {
    await this.ensureBareCache(input.remoteUrl, input.repositoryPath);
    return this.fetchAndValidate({ ...input, previousHead: null });
  }

  async fetchAndValidate(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly previousHead: string | null;
    readonly checkpoint?: CollaborationValidationCheckpoint | null;
  }): Promise<ValidatedCollaborationHistory> {
    await this.ensureBareCache(input.remoteUrl, input.repositoryPath);
    const fetch = await execute(
      input.repositoryPath,
      this.gitBinary,
      [
        'fetch',
        '--no-tags',
        'origin',
        `+${COLLABORATION_CONTROL_BRANCH}:${CONTROL_REMOTE_REF}`,
      ],
      true,
    );
    if (fetch.exitCode !== 0)
      throw new Error(`Collaboration fetch failed: ${fetch.stderr.trim()}`);
    const head = (
      await execute(input.repositoryPath, this.gitBinary, [
        'rev-parse',
        CONTROL_REMOTE_REF,
      ])
    ).stdout.trim();
    await this.assertSafeTree(input.repositoryPath, head);
    return validateCollaborationGitHistory({
      repositoryPath: input.repositoryPath,
      head,
      previousHead: input.previousHead,
      checkpoint: input.checkpoint,
    });
  }

  async appendEvent(
    input: AppendCollaborationEventInput,
  ): Promise<ValidatedCollaborationHistory> {
    const history = await this.fetchAndValidate(input);
    const event = input.buildEvent(history);
    const materializedFiles = input.materializedFiles ?? [];
    validateMaterializedFiles(event, materializedFiles);
    authorizeCollaborationEvent(event, history.projection, {
      principalId: input.identity.principalId,
      signingKeyRef: input.identity.keyRef,
    });
    const projection = reduceCollaborationEvent(
      history.projection,
      event,
      history.definition,
    );
    const checkoutPath = await this.temporaryCheckout('append');
    try {
      await execute(checkoutPath, this.gitBinary, ['init', '-q']);
      await execute(checkoutPath, this.gitBinary, [
        'remote',
        'add',
        'origin',
        input.remoteUrl,
      ]);
      await execute(checkoutPath, this.gitBinary, [
        'fetch',
        '-q',
        '--no-tags',
        'origin',
        history.head,
      ]);
      await execute(checkoutPath, this.gitBinary, [
        'checkout',
        '-q',
        '--detach',
        'FETCH_HEAD',
      ]);
      await this.configureSigner(checkoutPath, input.identity);
      materializeEvent(checkoutPath, event, projection, materializedFiles);
      await this.commit(checkoutPath, event);
      const push = await execute(
        checkoutPath,
        this.gitBinary,
        ['push', 'origin', `HEAD:${COLLABORATION_CONTROL_BRANCH}`],
        true,
      );
      if (push.exitCode !== 0) {
        if (/non-fast-forward|fetch first|rejected/i.test(push.stderr))
          throw new CollaborationGitConflictError(
            'Collaboration event lost the remote fast-forward race',
          );
        throw new Error(`Collaboration push failed: ${push.stderr.trim()}`);
      }
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
    return this.fetchAndValidate({
      remoteUrl: input.remoteUrl,
      repositoryPath: input.repositoryPath,
      previousHead: history.head,
      checkpoint: {
        head: history.head,
        projection: history.projection,
      },
    });
  }

  private async temporaryCheckout(purpose: string): Promise<string> {
    const prefix = path.join(
      os.tmpdir(),
      `icarus-collaboration-${purpose}-${crypto.randomUUID()}-`,
    );
    mkdirSync(prefix, { recursive: true, mode: 0o700 });
    return prefix;
  }

  private async cloneBare(
    remoteUrl: string,
    repositoryPath: string,
  ): Promise<void> {
    if (existsSync(repositoryPath))
      throw new Error(
        `Collaboration cache path already exists: ${repositoryPath}`,
      );
    mkdirSync(path.dirname(repositoryPath), { recursive: true });
    const result = await execute(
      path.dirname(repositoryPath),
      this.gitBinary,
      ['clone', '-q', '--bare', remoteUrl, repositoryPath],
      true,
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Collaboration remote clone failed: ${result.stderr.trim()}`,
      );
    await execute(repositoryPath, this.gitBinary, [
      'remote',
      'set-url',
      'origin',
      remoteUrl,
    ]);
  }

  private async ensureBareCache(
    remoteUrl: string,
    repositoryPath: string,
  ): Promise<void> {
    if (!existsSync(repositoryPath))
      return this.cloneBare(remoteUrl, repositoryPath);
    const bare = await execute(
      repositoryPath,
      this.gitBinary,
      ['rev-parse', '--is-bare-repository'],
      true,
    );
    if (bare.exitCode !== 0 || bare.stdout.trim() !== 'true')
      throw new Error(
        `Collaboration cache exists but is not a bare repository: ${repositoryPath}`,
      );
    const configured = (
      await execute(repositoryPath, this.gitBinary, [
        'remote',
        'get-url',
        'origin',
      ])
    ).stdout.trim();
    if (configured !== remoteUrl)
      throw new Error(
        'Collaboration cache remote URL does not match local binding',
      );
  }

  private async configureSigner(
    checkoutPath: string,
    identity: CollaborationSigningIdentity,
  ): Promise<void> {
    const commands = [
      ['config', 'user.name', identity.principalId],
      ['config', 'user.email', `${identity.principalId}@icarus.local`],
      ['config', 'gpg.format', 'ssh'],
      ['config', 'user.signingkey', identity.privateKeyPath],
      ['config', 'commit.gpgsign', 'true'],
    ] as const;
    for (const args of commands)
      await execute(checkoutPath, this.gitBinary, args);
  }

  private async commit(
    checkoutPath: string,
    event: CollaborationEvent,
  ): Promise<void> {
    await execute(checkoutPath, this.gitBinary, ['add', '--all']);
    await execute(checkoutPath, this.gitBinary, [
      'commit',
      '-q',
      '-S',
      '-m',
      `collaboration: ${event.event_type} ${event.event_id}`,
    ]);
  }

  private writeDefinition(
    checkoutPath: string,
    definition: CollaborationRepositoryDefinition,
    prompts: Readonly<Record<string, string>>,
  ): void {
    writeRepositoryFile(
      checkoutPath,
      'group.yaml',
      YAML.stringify(definition.group),
    );
    writeRepositoryFile(
      checkoutPath,
      definition.group.machine_ref,
      YAML.stringify(definition.machine),
    );
    for (const role of Object.values(definition.roles))
      writeRepositoryFile(
        checkoutPath,
        `groups/roles/${role.role}.yaml`,
        YAML.stringify(role),
      );
    for (const action of Object.values(definition.actions))
      writeRepositoryFile(
        checkoutPath,
        `actions/${action.action_id}.yaml`,
        YAML.stringify(action),
      );
    for (const [repositoryFile, prompt] of Object.entries(prompts))
      if (!repositoryFile.startsWith('prompts/'))
        throw new Error(
          `Shared prompt must be below prompts/: ${repositoryFile}`,
        );
    for (const action of Object.values(definition.actions)) {
      if (prompts[action.input.prompt_ref] == null)
        throw new Error(
          `Shared prompt is missing for action ${action.action_id}: ${action.input.prompt_ref}`,
        );
    }
    for (const [repositoryFile, prompt] of Object.entries(prompts))
      writeRepositoryFile(checkoutPath, repositoryFile, prompt);
  }

  private async assertSafeTree(
    repositoryPath: string,
    head: string,
  ): Promise<void> {
    const tree = await execute(repositoryPath, this.gitBinary, [
      'ls-tree',
      '-r',
      head,
    ]);
    for (const row of tree.stdout.split('\n').filter(Boolean)) {
      const match = row.match(/^(\d+)\s+\w+\s+[0-9a-f]+\t(.+)$/);
      if (!match) throw new Error(`Invalid Git tree row: ${row}`);
      const [, mode, file] = match;
      if (mode === '120000' || mode === '160000')
        throw new CollaborationProtocolError(
          'PROTOCOL_QUARANTINED',
          `Collaboration control tree cannot contain links or submodules: ${file}`,
        );
      const allowed = [
        'group.yaml',
        'machine.yaml',
        'groups/',
        'actions/',
        'prompts/',
        'events/',
        'projection/',
        'data/',
        'artifacts/',
      ].some((prefix) => file === prefix || file.startsWith(prefix));
      if (!allowed)
        throw new CollaborationProtocolError(
          'PROTOCOL_QUARANTINED',
          `Unexpected file in collaboration control tree: ${file}`,
        );
    }
  }
}

export function collaborationRepositoryCachePath(
  repositoryRoot: string,
  remoteUrl: string,
): string {
  const digest = crypto.createHash('sha256').update(remoteUrl).digest('hex');
  return path.join(repositoryRoot, `${digest}.git`);
}

export function normalizeCollaborationDataPath(input: string): string {
  const candidate = input.startsWith('data/') ? input : `data/${input}`;
  const parsed = collaborationDataPathSchema.safeParse(candidate);
  if (!parsed.success)
    throw new Error(`Unsafe collaboration data path: ${input}`);
  return parsed.data;
}

export async function readPromptFromValidatedCacheAsync(input: {
  readonly repositoryPath: string;
  readonly head: string;
  readonly promptRef: string;
}): Promise<string> {
  const result = await execFileAsync(
    'git',
    ['show', `${input.head}:${input.promptRef}`],
    { cwd: input.repositoryPath, encoding: 'utf8' },
  );
  return result.stdout;
}

export async function listCollaborationSharedPaths(input: {
  readonly repositoryPath: string;
  readonly head: string;
}): Promise<readonly string[]> {
  const result = await execFileAsync(
    'git',
    ['ls-tree', '-r', '--name-only', input.head, '--', 'data', 'artifacts'],
    { cwd: input.repositoryPath, encoding: 'utf8' },
  );
  return result.stdout
    .split('\n')
    .filter(
      (value) => value.startsWith('data/') || value.startsWith('artifacts/'),
    );
}

export type { ActionDefinition, MachineDefinition, RoleDefinition };
