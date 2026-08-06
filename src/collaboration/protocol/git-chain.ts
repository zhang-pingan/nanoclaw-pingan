import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import YAML from 'yaml';

import {
  authorizeCollaborationEvent,
  type VerifiedCommitSigner,
} from './authorization.js';
import {
  deterministicProjectionJson,
  reduceCollaborationEvent,
  type CollaborationProjection,
} from './reducer.js';
import {
  actionDefinitionSchema,
  collaborationEventSchema,
  groupDefinitionSchema,
  machineDefinitionSchema,
  memberDefinitionSchema,
  roleDefinitionSchema,
  validateRepositoryDefinition,
  type CollaborationEvent,
  type CollaborationRepositoryDefinition,
} from './schema.js';
import { CollaborationProtocolError } from './version.js';

const execFileAsync = promisify(execFile);

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

async function git(
  repositoryPath: string,
  args: readonly string[],
  options: { readonly allowFailure?: boolean } = {},
): Promise<GitResult & { readonly exitCode: number }> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd: repositoryPath,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    if (options.allowFailure)
      return {
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? value.message,
        exitCode: typeof value.code === 'number' ? value.code : 1,
      };
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Git protocol operation failed: git ${args.join(' ')}: ${value.stderr ?? value.message}`,
    );
  }
}

async function showFile(
  repositoryPath: string,
  commit: string,
  repositoryFile: string,
): Promise<string> {
  return (await git(repositoryPath, ['show', `${commit}:${repositoryFile}`]))
    .stdout;
}

async function listFiles(
  repositoryPath: string,
  commit: string,
  prefix: string,
): Promise<string[]> {
  const result = await git(repositoryPath, [
    'ls-tree',
    '-r',
    '--name-only',
    commit,
    '--',
    prefix,
  ]);
  return result.stdout.split('\n').filter(Boolean).sort();
}

export async function loadCollaborationRepositoryDefinition(
  repositoryPath: string,
  commit: string,
): Promise<CollaborationRepositoryDefinition> {
  const group = groupDefinitionSchema.parse(
    YAML.parse(await showFile(repositoryPath, commit, 'group.yaml')),
  );
  const machine = machineDefinitionSchema.parse(
    YAML.parse(await showFile(repositoryPath, commit, group.machine_ref)),
  );
  const roles: Record<
    string,
    ReturnType<typeof roleDefinitionSchema.parse>
  > = {};
  for (const file of await listFiles(repositoryPath, commit, 'groups/roles')) {
    if (!file.endsWith('.yaml')) continue;
    const role = roleDefinitionSchema.parse(
      YAML.parse(await showFile(repositoryPath, commit, file)),
    );
    roles[role.role] = role;
  }
  const actions: Record<
    string,
    ReturnType<typeof actionDefinitionSchema.parse>
  > = {};
  for (const file of await listFiles(repositoryPath, commit, 'actions')) {
    if (!file.endsWith('.yaml')) continue;
    const action = actionDefinitionSchema.parse(
      YAML.parse(await showFile(repositoryPath, commit, file)),
    );
    actions[action.action_id] = action;
  }
  return validateRepositoryDefinition({ group, machine, roles, actions });
}

function candidateMember(
  event: CollaborationEvent,
  projection: CollaborationProjection | null,
) {
  if (event.event_type === 'group_initialized')
    return memberDefinitionSchema.parse(event.payload.member);
  if (event.event_type === 'member_registered')
    return memberDefinitionSchema.parse(event.payload.member);
  return projection?.members[event.actor.principal_id] ?? null;
}

function allowedSigners(
  event: CollaborationEvent,
  projection: CollaborationProjection | null,
): Map<string, { readonly keyRef: string; readonly publicKey: string }> {
  const signers = new Map<
    string,
    { readonly keyRef: string; readonly publicKey: string }
  >();
  for (const member of Object.values(projection?.members ?? {}))
    signers.set(member.principal_id, {
      keyRef: member.signing_key_ref,
      publicKey: member.signing_public_key,
    });
  const candidate = candidateMember(event, projection);
  if (candidate)
    signers.set(candidate.principal_id, {
      keyRef: candidate.signing_key_ref,
      publicKey: candidate.signing_public_key,
    });
  return signers;
}

async function verifyCommitSigner(
  repositoryPath: string,
  commit: string,
  event: CollaborationEvent,
  projection: CollaborationProjection | null,
): Promise<VerifiedCommitSigner> {
  const signers = allowedSigners(event, projection);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'icarus-collaboration-signers-'),
  );
  const allowedSignersPath = path.join(directory, 'allowed_signers');
  try {
    await writeFile(
      allowedSignersPath,
      `${[...signers.entries()]
        .map(([principal, signer]) => `${principal} ${signer.publicKey}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    );
    const verification = await git(
      repositoryPath,
      [
        '-c',
        `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
        'verify-commit',
        '--raw',
        commit,
      ],
      { allowFailure: true },
    );
    if (verification.exitCode !== 0)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Git commit signature is invalid for ${commit}: ${verification.stderr.trim()}`,
      );
    const signature = await git(repositoryPath, [
      '-c',
      `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
      'show',
      '-s',
      '--format=%G?%x00%GS%x00%GF',
      commit,
    ]);
    const [status, principalId, fingerprint] = signature.stdout
      .trim()
      .split('\0');
    if (status !== 'G' || !principalId || !fingerprint)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Git commit signature identity is incomplete for ${commit}`,
      );
    const signer = signers.get(principalId);
    if (!signer || !signer.keyRef.endsWith(fingerprint))
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Git signature fingerprint does not match member ${principalId}`,
      );
    return { principalId, signingKeyRef: signer.keyRef };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function materializedPathAllowed(
  event: CollaborationEvent,
  repositoryFile: string,
): boolean {
  if (repositoryFile === 'projection/state.json') return true;
  if (event.event_type === 'member_registered')
    return repositoryFile.startsWith('groups/members/');
  if (
    event.event_type === 'role_claimed' ||
    event.event_type === 'role_released'
  )
    return repositoryFile.startsWith('groups/claims/');
  if (event.event_type === 'data_updated')
    return repositoryFile.startsWith('data/');
  if (event.event_type === 'artifact_published')
    return repositoryFile.startsWith('artifacts/');
  return false;
}

async function eventFileForCommit(
  repositoryPath: string,
  commit: string,
  root: boolean,
): Promise<{ readonly eventFile: string; readonly changedFiles: string[] }> {
  const args = [
    'diff-tree',
    ...(root ? ['--root'] : []),
    '--no-commit-id',
    '--name-status',
    '-r',
    commit,
  ];
  const rows = (await git(repositoryPath, args)).stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...fileParts] = line.split('\t');
      return { status, file: fileParts.at(-1) ?? '' };
    });
  const events = rows.filter(
    (row) => row.status === 'A' && /^events\/\d+\/[^/]+\.json$/.test(row.file),
  );
  if (events.length !== 1)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Commit ${commit} must append exactly one event`,
    );
  const changedEvent = rows.find(
    (row) => row.file.startsWith('events/') && row.file !== events[0]?.file,
  );
  if (changedEvent)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Commit ${commit} modifies an existing event: ${changedEvent.file}`,
    );
  return {
    eventFile: events[0]!.file,
    changedFiles: rows.map((row) => row.file),
  };
}

export interface ValidatedCollaborationHistory {
  readonly head: string;
  readonly commits: readonly string[];
  readonly events: readonly CollaborationEvent[];
  readonly definition: CollaborationRepositoryDefinition;
  readonly projection: CollaborationProjection;
}

export async function validateCollaborationGitHistory(input: {
  readonly repositoryPath: string;
  readonly head: string;
  readonly previousHead?: string | null;
}): Promise<ValidatedCollaborationHistory> {
  if (input.previousHead && input.previousHead !== input.head) {
    const ancestry = await git(
      input.repositoryPath,
      ['merge-base', '--is-ancestor', input.previousHead, input.head],
      { allowFailure: true },
    );
    if (ancestry.exitCode !== 0)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        'The remote collaboration control history was rewritten',
      );
  }
  const commits = (
    await git(input.repositoryPath, ['rev-list', '--reverse', input.head])
  ).stdout
    .split('\n')
    .filter(Boolean);
  if (commits.length === 0)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'The collaboration control branch is empty',
    );
  const definition = await loadCollaborationRepositoryDefinition(
    input.repositoryPath,
    commits[0]!,
  );
  let projection: CollaborationProjection | null = null;
  const events: CollaborationEvent[] = [];
  for (const [index, commit] of commits.entries()) {
    const { eventFile, changedFiles } = await eventFileForCommit(
      input.repositoryPath,
      commit,
      index === 0,
    );
    const event = collaborationEventSchema.parse(
      JSON.parse(await showFile(input.repositoryPath, commit, eventFile)),
    );
    const expectedPathPrefix = `events/${String(event.epoch)}/`;
    if (
      !eventFile.startsWith(expectedPathPrefix) ||
      !eventFile.endsWith(`-${event.event_id}.json`)
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Event path does not match its epoch and id: ${eventFile}`,
      );
    if (index > 0) {
      const unauthorizedFile = changedFiles.find(
        (file) => file !== eventFile && !materializedPathAllowed(event, file),
      );
      if (unauthorizedFile)
        throw new CollaborationProtocolError(
          'PROTOCOL_QUARANTINED',
          `Event ${event.event_id} cannot modify ${unauthorizedFile}`,
        );
    }
    const signer = await verifyCommitSigner(
      input.repositoryPath,
      commit,
      event,
      projection,
    );
    authorizeCollaborationEvent(event, projection, signer);
    projection = reduceCollaborationEvent(projection, event, definition);
    events.push(event);
  }
  if (!projection)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'The collaboration projection could not be constructed',
    );
  const projectionFile = await git(
    input.repositoryPath,
    ['cat-file', '-e', `${input.head}:projection/state.json`],
    { allowFailure: true },
  );
  if (projectionFile.exitCode === 0) {
    const materialized = JSON.parse(
      await showFile(input.repositoryPath, input.head, 'projection/state.json'),
    ) as unknown;
    if (
      `${JSON.stringify(materialized, null, 2)}\n` !==
      deterministicProjectionJson(projection)
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        'The materialized projection does not match event replay',
      );
  }
  return {
    head: input.head,
    commits,
    events,
    definition,
    projection,
  };
}

export async function readPublicKey(publicKeyPath: string): Promise<string> {
  return (await readFile(publicKeyPath, 'utf8')).trim();
}
