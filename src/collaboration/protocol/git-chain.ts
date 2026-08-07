import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import YAML from 'yaml';

import { collaborationPrincipalIdFromFingerprint } from '../identity.js';
import {
  authorizeCollaborationEvent,
  type VerifiedCommitSigner,
} from './authorization.js';
import { canonicalJsonStringify } from './canonical-json.js';
import {
  collaborationCanonicalHash,
  deterministicProjectionJson,
  findCollaborationMember,
  reduceCollaborationEvent,
  type CollaborationProjection,
} from './reducer.js';
import {
  actionDefinitionSchema,
  artifactMetadataSchema,
  collaborationEventSchema,
  dataUpdatePayloadSchema,
  groupDefinitionSchema,
  machineDefinitionSchema,
  machineLayoutDefinitionSchema,
  memberDefinitionSchema,
  roleDefinitionSchema,
  roleClaimSchema,
  handoffEnvelopeSchema,
  stateImplementationSchema,
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

async function showFileBytes(
  repositoryPath: string,
  commit: string,
  repositoryFile: string,
): Promise<Buffer> {
  const result = (await execFileAsync(
    'git',
    ['show', `${commit}:${repositoryFile}`],
    { cwd: repositoryPath, encoding: null, maxBuffer: 64 * 1024 * 1024 },
  )) as unknown as { stdout: Buffer };
  return result.stdout;
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
    actions[file] = action;
  }
  const implementations: Record<
    string,
    ReturnType<typeof stateImplementationSchema.parse>
  > = {};
  for (const file of await listFiles(
    repositoryPath,
    commit,
    'groups/implementations',
  )) {
    if (!file.endsWith('.yaml')) continue;
    const implementation = stateImplementationSchema.parse(
      YAML.parse(await showFile(repositoryPath, commit, file)),
    );
    implementations[implementation.state_id] = implementation;
  }
  const layoutFile = await git(
    repositoryPath,
    ['cat-file', '-e', `${commit}:layout.yaml`],
    { allowFailure: true },
  );
  const layout =
    layoutFile.exitCode === 0
      ? machineLayoutDefinitionSchema.parse(
          YAML.parse(await showFile(repositoryPath, commit, 'layout.yaml')),
        )
      : null;
  return validateRepositoryDefinition({
    group,
    machine,
    roles,
    actions,
    implementations,
    layout,
  });
}

function candidateMember(
  event: CollaborationEvent,
  projection: CollaborationProjection | null,
) {
  if (event.event_type === 'group_initialized')
    return memberDefinitionSchema.parse(event.payload.member);
  if (event.event_type === 'member_registered')
    return memberDefinitionSchema.parse(event.payload.member);
  return projection
    ? findCollaborationMember(
        projection,
        event.actor.principal_id,
        event.actor.agent_id,
      )
    : null;
}

function allowedSigners(
  event: CollaborationEvent,
  projection: CollaborationProjection | null,
): Map<string, { readonly keyRef: string; readonly publicKey: string }> {
  const signers = new Map<
    string,
    { readonly keyRef: string; readonly publicKey: string }
  >();
  for (const members of Object.values(projection?.members ?? {}))
    for (const member of members)
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
    if (collaborationPrincipalIdFromFingerprint(fingerprint) !== principalId)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Collaboration principal is not derived from its SSH fingerprint: ${principalId}`,
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
  if (event.event_type === 'machine_revised')
    return (
      repositoryFile === 'group.yaml' ||
      repositoryFile === 'machine.yaml' ||
      repositoryFile.startsWith('groups/roles/') ||
      repositoryFile.startsWith('groups/implementations/') ||
      repositoryFile.startsWith('actions/') ||
      repositoryFile.startsWith('prompts/')
    );
  if (event.event_type === 'machine_layout_updated')
    return repositoryFile === 'layout.yaml';
  if (event.event_type === 'member_registered')
    return repositoryFile.startsWith('groups/members/');
  if (
    event.event_type === 'role_claimed' ||
    event.event_type === 'role_released'
  )
    return repositoryFile.startsWith('groups/claims/');
  if (
    event.event_type === 'state_implementation_published' ||
    event.event_type === 'state_implementation_revised' ||
    event.event_type === 'state_implementation_withdrawn'
  ) {
    const implementation = event.payload.implementation as
      | { role?: unknown; state_id?: unknown; action_ref?: unknown }
      | undefined;
    const role =
      typeof implementation?.role === 'string'
        ? implementation.role
        : String(event.payload.role ?? '');
    const stateId =
      typeof implementation?.state_id === 'string'
        ? implementation.state_id
        : String(event.payload.state_id ?? '');
    const implementationRef =
      typeof event.payload.implementation_ref === 'string'
        ? event.payload.implementation_ref
        : `groups/implementations/${role}/${stateId}.yaml`;
    const actionRef = implementation?.action_ref;
    const action = event.payload.action as
      | { input?: { prompt_ref?: unknown } }
      | undefined;
    const promptRef = action?.input?.prompt_ref;
    const ownedActionPrefix =
      role && stateId ? `actions/${role}/${stateId}/` : '';
    const ownedPromptPrefix =
      role && stateId ? `prompts/${role}/${stateId}/` : '';
    return (
      [implementationRef, actionRef, promptRef].includes(repositoryFile) ||
      Boolean(
        ownedActionPrefix && repositoryFile.startsWith(ownedActionPrefix),
      ) ||
      Boolean(ownedPromptPrefix && repositoryFile.startsWith(ownedPromptPrefix))
    );
  }
  if (event.event_type === 'data_updated')
    return repositoryFile === dataUpdatePayloadSchema.parse(event.payload).path;
  if (event.event_type === 'turn_completed') {
    const artifacts = Array.isArray(event.payload.artifacts)
      ? event.payload.artifacts.map(
          (value) => artifactMetadataSchema.parse(value).repository_path,
        )
      : [];
    return artifacts.includes(repositoryFile);
  }
  return false;
}

async function validateDataUpdateMaterialization(
  repositoryPath: string,
  commit: string,
  event: CollaborationEvent,
  eventFile: string,
  changedFiles: readonly string[],
): Promise<void> {
  if (event.event_type !== 'data_updated') return;
  const payload = dataUpdatePayloadSchema.parse(event.payload);
  const materializedFiles = changedFiles.filter(
    (file) => file !== eventFile && file !== 'projection/state.json',
  );
  if (materializedFiles.length !== 1 || materializedFiles[0] !== payload.path)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `data_updated must modify exactly ${payload.path}`,
    );
  const treeEntry = await git(repositoryPath, [
    'ls-tree',
    commit,
    '--',
    payload.path,
  ]);
  const mode = /^(\d{6}) blob [0-9a-f]+\t/u.exec(treeEntry.stdout)?.[1];
  if (mode !== '100644' && mode !== '100755')
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Materialized data must be a regular file: ${payload.path}`,
    );
  const contents = await showFile(repositoryPath, commit, payload.path);
  const size = Buffer.byteLength(contents, 'utf8');
  const digest = `sha256:${crypto
    .createHash('sha256')
    .update(contents, 'utf8')
    .digest('hex')}`;
  if (size !== payload.size_bytes || digest !== payload.content_sha256)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Materialized data does not match event hash and size: ${payload.path}`,
    );
}

async function validateDefinitionRevisionMaterialization(
  repositoryPath: string,
  commit: string,
  event: CollaborationEvent,
  eventFile: string,
  changedFiles: readonly string[],
  projection: CollaborationProjection | null,
  previousDefinition: CollaborationRepositoryDefinition,
): Promise<CollaborationRepositoryDefinition | null> {
  if (event.event_type === 'machine_layout_updated') {
    const layout = machineLayoutDefinitionSchema.parse(event.payload.layout);
    const unknownStateId = Object.keys(layout.nodes).find(
      (stateId) => !previousDefinition.machine.states[stateId],
    );
    if (unknownStateId)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Machine layout references an unknown State: ${unknownStateId}`,
      );
    if (
      collaborationCanonicalHash(layout) !== event.payload.layout_hash ||
      !changedFiles.includes('layout.yaml')
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        'Machine layout event does not match layout.yaml',
      );
    const materialized = machineLayoutDefinitionSchema.parse(
      YAML.parse(await showFile(repositoryPath, commit, 'layout.yaml')),
    );
    if (
      collaborationCanonicalHash(materialized) !==
      collaborationCanonicalHash(layout)
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        'Materialized Machine layout is invalid',
      );
    return null;
  }
  if (event.event_type !== 'machine_revised') return null;
  const definition = await loadCollaborationRepositoryDefinition(
    repositoryPath,
    commit,
  );
  const machine = machineDefinitionSchema.parse(event.payload.machine);
  const roles = Object.fromEntries(
    Object.entries(event.payload.roles as Record<string, unknown>).map(
      ([roleId, role]) => [roleId, roleDefinitionSchema.parse(role)],
    ),
  );
  const normalizedRequirements = Object.values(roles)
    .map((role) => ({
      role: role.role,
      min_members: role.cardinality.min,
      max_members: role.cardinality.max,
    }))
    .sort((left, right) => left.role.localeCompare(right.role));
  const expectedGroup = groupDefinitionSchema.parse({
    ...previousDefinition.group,
    required_roles: normalizedRequirements,
  });
  const materializedGroup = {
    ...definition.group,
    required_roles: [...definition.group.required_roles].sort((left, right) =>
      left.role.localeCompare(right.role),
    ),
  };
  if (
    collaborationCanonicalHash(definition.machine) !==
      collaborationCanonicalHash(machine) ||
    collaborationCanonicalHash(definition.roles) !==
      collaborationCanonicalHash(roles) ||
    collaborationCanonicalHash(materializedGroup) !==
      collaborationCanonicalHash(expectedGroup)
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Machine revision event does not match its creator-owned materialized definition',
    );
  const invalidated = Array.isArray(event.payload.invalidated_state_ids)
    ? event.payload.invalidated_state_ids.map(String)
    : [];
  for (const stateId of invalidated) {
    const active = projection?.stateImplementations[stateId];
    if (!active) continue;
    const removed = [
      active.implementationRef,
      active.implementation.action_ref,
      active.action?.input.prompt_ref,
    ].filter((value): value is string => Boolean(value));
    for (const repositoryFile of removed) {
      const exists = await git(
        repositoryPath,
        ['cat-file', '-e', `${commit}:${repositoryFile}`],
        { allowFailure: true },
      );
      if (exists.exitCode === 0)
        throw new CollaborationProtocolError(
          'PROTOCOL_QUARANTINED',
          `Machine revision did not remove invalidated implementation data: ${repositoryFile}`,
        );
    }
  }
  const unrelated = changedFiles.find(
    (file) =>
      file !== eventFile &&
      file !== 'projection/state.json' &&
      !materializedPathAllowed(event, file),
  );
  if (unrelated)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Machine revision modified unrelated file: ${unrelated}`,
    );
  return definition;
}

async function validateTurnCompletionMaterialization(
  repositoryPath: string,
  commit: string,
  event: CollaborationEvent,
  eventFile: string,
  changedFiles: readonly string[],
): Promise<void> {
  if (event.event_type !== 'turn_completed') return;
  const artifacts = Array.isArray(event.payload.artifacts)
    ? event.payload.artifacts.map((value) =>
        artifactMetadataSchema.parse(value),
      )
    : [];
  const materialized = changedFiles.filter(
    (file) => file !== eventFile && file !== 'projection/state.json',
  );
  if (
    JSON.stringify(materialized.sort()) !==
    JSON.stringify(artifacts.map((artifact) => artifact.repository_path).sort())
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'turn_completed artifact paths do not match its metadata',
    );
  for (const artifact of artifacts) {
    const treeEntry = await git(repositoryPath, [
      'ls-tree',
      commit,
      '--',
      artifact.repository_path,
    ]);
    const mode = /^(\d{6}) blob [0-9a-f]+\t/u.exec(treeEntry.stdout)?.[1];
    if (mode !== '100644' && mode !== '100755')
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Artifact must be a regular file: ${artifact.repository_path}`,
      );
    const contents = await showFileBytes(
      repositoryPath,
      commit,
      artifact.repository_path,
    );
    const digest = `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`;
    if (contents.byteLength !== artifact.size || digest !== artifact.sha256)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Artifact does not match event hash and size: ${artifact.repository_path}`,
      );
  }
}

async function validateHandoffReferences(
  repositoryPath: string,
  commit: string,
  event: CollaborationEvent,
): Promise<void> {
  const handoff =
    event.event_type === 'group_started' && event.payload.initial_handoff
      ? handoffEnvelopeSchema.parse(event.payload.initial_handoff)
      : event.event_type === 'turn_completed'
        ? handoffEnvelopeSchema.parse(event.payload.handoff)
        : null;
  if (!handoff) return;
  for (const repositoryPathRef of [
    ...handoff.data_refs,
    ...handoff.artifact_refs,
  ]) {
    const treeEntry = await git(repositoryPath, [
      'ls-tree',
      commit,
      '--',
      repositoryPathRef,
    ]);
    const match = /^(\d{6}) blob [0-9a-f]+\t([^\n]+)$/u.exec(
      treeEntry.stdout.trim(),
    );
    if (
      !match ||
      (match[1] !== '100644' && match[1] !== '100755') ||
      match[2] !== repositoryPathRef
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Handoff reference is not a verified regular file: ${repositoryPathRef}`,
      );
  }
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
  readonly validation: CollaborationValidationMetrics;
}

export interface CollaborationValidationCheckpoint {
  readonly head: string;
  readonly projection: CollaborationProjection;
}

export interface CollaborationValidationMetrics {
  readonly mode: 'full' | 'incremental';
  readonly validatedCommitCount: number;
  readonly totalSequence: number;
  readonly checkpointHead: string | null;
}

function assertLinearHistory(
  historyRows: readonly string[],
  precedingHead: string | null,
): string[] {
  const commits = historyRows.map((row) => row.split(' ')[0]!);
  for (const [index, row] of historyRows.entries()) {
    const [commit, ...parents] = row.split(' ');
    const expectedParent = index === 0 ? precedingHead : commits[index - 1]!;
    const expectedParents = expectedParent ? [expectedParent] : [];
    if (
      parents.length !== expectedParents.length ||
      parents.some(
        (parent, parentIndex) => parent !== expectedParents[parentIndex],
      )
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Collaboration history must be a linear single-parent chain at ${commit}`,
      );
  }
  return commits;
}

function firstProjectionDifference(
  materialized: unknown,
  replayed: unknown,
  path = '$',
): string | null {
  if (Object.is(materialized, replayed)) return null;
  if (Array.isArray(materialized) && Array.isArray(replayed)) {
    if (materialized.length !== replayed.length) return `${path}.length`;
    for (let index = 0; index < materialized.length; index += 1) {
      const difference = firstProjectionDifference(
        materialized[index],
        replayed[index],
        `${path}[${String(index)}]`,
      );
      if (difference) return difference;
    }
    return null;
  }
  if (
    materialized &&
    replayed &&
    typeof materialized === 'object' &&
    typeof replayed === 'object'
  ) {
    const materializedRecord = materialized as Record<string, unknown>;
    const replayedRecord = replayed as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(materializedRecord),
      ...Object.keys(replayedRecord),
    ]);
    for (const key of [...keys].sort()) {
      if (!(key in materializedRecord) || !(key in replayedRecord))
        return `${path}.${key}`;
      const difference = firstProjectionDifference(
        materializedRecord[key],
        replayedRecord[key],
        `${path}.${key}`,
      );
      if (difference) return difference;
    }
    return null;
  }
  return path;
}

async function checkpointMatchesMaterializedProjection(
  repositoryPath: string,
  checkpoint: CollaborationValidationCheckpoint,
): Promise<boolean> {
  if (checkpoint.projection.integrityStatus !== 'OK') return false;
  const projectionFile = await git(
    repositoryPath,
    ['cat-file', '-e', `${checkpoint.head}:projection/state.json`],
    { allowFailure: true },
  );
  if (projectionFile.exitCode !== 0) return false;
  try {
    const materialized = JSON.parse(
      await showFile(repositoryPath, checkpoint.head, 'projection/state.json'),
    ) as unknown;
    return (
      `${canonicalJsonStringify(materialized)}\n` ===
      deterministicProjectionJson(checkpoint.projection)
    );
  } catch {
    return false;
  }
}

export async function validateCollaborationGitHistory(input: {
  readonly repositoryPath: string;
  readonly head: string;
  readonly previousHead?: string | null;
  readonly checkpoint?: CollaborationValidationCheckpoint | null;
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
  const useCheckpoint = Boolean(
    input.checkpoint &&
    input.previousHead &&
    input.checkpoint.head === input.previousHead &&
    (await checkpointMatchesMaterializedProjection(
      input.repositoryPath,
      input.checkpoint,
    )),
  );
  const precedingHead = useCheckpoint ? input.checkpoint!.head : null;
  const historyRows = (
    await git(input.repositoryPath, [
      'rev-list',
      '--reverse',
      '--topo-order',
      '--parents',
      ...(precedingHead ? [`${precedingHead}..${input.head}`] : [input.head]),
    ])
  ).stdout
    .split('\n')
    .filter(Boolean);
  const commits = assertLinearHistory(historyRows, precedingHead);
  if (!useCheckpoint && commits.length === 0)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'The collaboration control branch is empty',
    );
  let definition = await loadCollaborationRepositoryDefinition(
    input.repositoryPath,
    useCheckpoint ? input.checkpoint!.head : commits[0]!,
  );
  let projection: CollaborationProjection | null = useCheckpoint
    ? structuredClone(input.checkpoint!.projection)
    : null;
  if (projection && projection.groupId !== definition.group.group_id)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'The validation checkpoint group does not match the repository definition',
    );
  const events: CollaborationEvent[] = [];
  for (const [index, commit] of commits.entries()) {
    const { eventFile, changedFiles } = await eventFileForCommit(
      input.repositoryPath,
      commit,
      !useCheckpoint && index === 0,
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
    if (useCheckpoint || index > 0) {
      const unauthorizedFile = changedFiles.find(
        (file) => file !== eventFile && !materializedPathAllowed(event, file),
      );
      if (unauthorizedFile)
        throw new CollaborationProtocolError(
          'PROTOCOL_QUARANTINED',
          `Event ${event.event_id} cannot modify ${unauthorizedFile}`,
        );
    }
    await validateDataUpdateMaterialization(
      input.repositoryPath,
      commit,
      event,
      eventFile,
      changedFiles,
    );
    const revisedDefinition = await validateDefinitionRevisionMaterialization(
      input.repositoryPath,
      commit,
      event,
      eventFile,
      changedFiles,
      projection,
      definition,
    );
    await validateTurnCompletionMaterialization(
      input.repositoryPath,
      commit,
      event,
      eventFile,
      changedFiles,
    );
    await validateHandoffReferences(input.repositoryPath, commit, event);
    const signer = await verifyCommitSigner(
      input.repositoryPath,
      commit,
      event,
      projection,
    );
    authorizeCollaborationEvent(event, projection, signer);
    projection = reduceCollaborationEvent(
      projection,
      event,
      revisedDefinition ?? definition,
    );
    if (revisedDefinition) definition = revisedDefinition;
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
      `${canonicalJsonStringify(materialized)}\n` !==
      deterministicProjectionJson(projection)
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `The materialized projection does not match event replay at ${firstProjectionDifference(materialized, projection) ?? '$'}`,
      );
  }
  await validateMaterializedIdentityState(
    input.repositoryPath,
    input.head,
    projection,
  );
  const headDefinition = await loadCollaborationRepositoryDefinition(
    input.repositoryPath,
    input.head,
  );
  await validateMaterializedImplementations(
    input.repositoryPath,
    input.head,
    projection,
    headDefinition,
  );
  return {
    head: input.head,
    commits,
    events,
    definition: headDefinition,
    projection,
    validation: {
      mode: useCheckpoint ? 'incremental' : 'full',
      validatedCommitCount: commits.length,
      totalSequence: projection.sequence,
      checkpointHead: useCheckpoint ? input.checkpoint!.head : null,
    },
  };
}

async function validateMaterializedImplementations(
  repositoryPath: string,
  head: string,
  projection: CollaborationProjection,
  definition: CollaborationRepositoryDefinition,
): Promise<void> {
  const expectedFiles = new Set<string>();
  for (const [stateId, active] of Object.entries(
    projection.stateImplementations,
  )) {
    expectedFiles.add(active.implementationRef);
    const materialized = definition.implementations[stateId];
    if (
      !materialized ||
      collaborationCanonicalHash(materialized) !== active.implementationHash
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Materialized state implementation is invalid: ${stateId}`,
      );
    if (!active.action) continue;
    const actionRef = active.implementation.action_ref!;
    expectedFiles.add(actionRef);
    const action = definition.actions[actionRef];
    if (!action || collaborationCanonicalHash(action) !== active.actionHash)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Materialized action is invalid: ${actionRef}`,
      );
    expectedFiles.add(action.input.prompt_ref);
    const prompt = await showFile(
      repositoryPath,
      head,
      action.input.prompt_ref,
    );
    if (
      `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}` !==
      active.promptHash
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Materialized prompt hash is invalid: ${action.input.prompt_ref}`,
      );
  }
  const actual = await listFiles(
    repositoryPath,
    head,
    'groups/implementations',
  );
  const expectedImplementations = [...expectedFiles]
    .filter((file) => file.startsWith('groups/implementations/'))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedImplementations))
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Materialized state implementations do not match event replay',
    );
  const expectedActions = [...expectedFiles]
    .filter((file) => file.startsWith('actions/'))
    .sort();
  const actualActions = await listFiles(repositoryPath, head, 'actions');
  if (JSON.stringify(actualActions) !== JSON.stringify(expectedActions))
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Materialized actions do not match event replay',
    );
  const expectedPrompts = [...expectedFiles]
    .filter((file) => file.startsWith('prompts/'))
    .sort();
  const actualPrompts = await listFiles(repositoryPath, head, 'prompts');
  if (JSON.stringify(actualPrompts) !== JSON.stringify(expectedPrompts))
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Materialized prompts do not match event replay',
    );
}

async function validateMaterializedIdentityState(
  repositoryPath: string,
  head: string,
  projection: CollaborationProjection,
): Promise<void> {
  const expectedMembers = new Map(
    Object.values(projection.members)
      .flat()
      .map((member) => [
        `groups/members/${member.principal_id}/${member.agent_id}.json`,
        member,
      ]),
  );
  const expectedClaims = new Map(
    Object.values(projection.roleClaims)
      .flat()
      .map((claim) => [
        `groups/claims/${claim.role}/${claim.principal_id}/${claim.agent_id}.json`,
        claim,
      ]),
  );
  const actualMembers = await listFiles(repositoryPath, head, 'groups/members');
  const actualClaims = await listFiles(repositoryPath, head, 'groups/claims');
  if (
    JSON.stringify(actualMembers) !==
      JSON.stringify([...expectedMembers.keys()].sort()) ||
    JSON.stringify(actualClaims) !==
      JSON.stringify([...expectedClaims.keys()].sort())
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Materialized members or role claims do not match event replay',
    );

  for (const [file, expected] of expectedMembers) {
    const actual = memberDefinitionSchema.parse(
      JSON.parse(await showFile(repositoryPath, head, file)),
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Materialized member does not match event replay: ${file}`,
      );
  }
  for (const [file, expected] of expectedClaims) {
    const actual = roleClaimSchema.parse(
      JSON.parse(await showFile(repositoryPath, head, file)),
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Materialized role claim does not match event replay: ${file}`,
      );
  }
}
