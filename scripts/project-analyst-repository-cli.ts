#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCollaborationAnalysisDeltaSelection,
  buildCollaborationAnalysisResourceCatalog,
  scopeCollaborationAnalysisResourceCatalog,
} from '../src/collaboration/analysis-context.js';
import {
  collaborationAnalysisScopeSchema,
  collaborationRepositoryAnalysisInputSchema,
  collaborationRepositoryVerificationSchema,
  type CollaborationAnalysisScope,
  type CollaborationRepositoryVerification,
} from '../src/collaboration/analysis-contracts.js';
import {
  buildCollaborationProjectInsight,
  buildMyItems,
} from '../src/collaboration/project-insight.js';
import { buildCollaborationGenesisSelfDescriptionFromBundle } from '../src/collaboration/group-self-description-contract.js';
import { PROJECT_ANALYST_BUNDLE_RELATIVE_PATHS } from '../src/collaboration/project-analyst-bundle.js';
import { validateCollaborationProjectSpaceHistory } from '../src/collaboration/project-space-git.js';
import type { ValidatedProjectSpaceHistory } from '../src/collaboration/project-space-service.js';
import { canonicalJsonStringify } from '../src/collaboration/protocol/canonical-json.js';
import {
  collaborationCanonicalHashV3,
  collaborationEventHashV3,
  workflowDefinitionVersionKey,
  type CollaborationProjectionV3,
} from '../src/collaboration/protocol/v3-reducer.js';
import { memberNotificationV3Schema } from '../src/collaboration/protocol/v3-schema.js';
import { COLLABORATION_CONTROL_BRANCH } from '../src/collaboration/protocol/version.js';

const DEFAULT_REF = 'icarus/control';
const TOOL_VERSION = 1;
const SKILL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function canonicalGenesisSelfDescription(groupId: string) {
  return buildCollaborationGenesisSelfDescriptionFromBundle({
    groupId,
    projectAnalystFiles: PROJECT_ANALYST_BUNDLE_RELATIVE_PATHS.map(
      (relative) => {
        const target = path.join(SKILL_ROOT, relative);
        const entry = lstatSync(target);
        if (entry.isSymbolicLink() || !entry.isFile())
          throw new Error(
            `Trusted Project Analyst bundle entry is not a regular file: ${relative}`,
          );
        return { path: relative, contents: readFileSync(target) };
      },
    ),
  });
}

function installControlledGitEnvironment(): () => void {
  const runtimeRoot = mkdtempSync(
    path.join(os.tmpdir(), 'icarus-project-analyst-git-runtime-'),
  );
  const hooksPath = path.join(runtimeRoot, 'hooks');
  mkdirSync(hooksPath);
  for (const name of Object.keys(process.env))
    if (name.startsWith('GIT_')) delete process.env[name];
  const commandConfig = [
    ['gpg.ssh.program', 'ssh-keygen'],
    ['core.hooksPath', hooksPath],
    ['core.fsmonitor', 'false'],
    ['core.pager', 'cat'],
    ['protocol.ext.allow', 'never'],
    ['protocol.file.allow', 'always'],
  ] as const;
  Object.assign(process.env, {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_COUNT: String(commandConfig.length),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  });
  for (const [index, [key, value]] of commandConfig.entries()) {
    process.env[`GIT_CONFIG_KEY_${String(index)}`] = key;
    process.env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  }
  return () => rmSync(runtimeRoot, { recursive: true, force: true });
}

interface CliOptions {
  readonly repository: string;
  readonly output: string;
  readonly requestedRef: string;
  readonly scope: CollaborationAnalysisScope;
  readonly principalId: string | null;
  readonly trustedGenesis: string | null;
  readonly trustedHead: string | null;
  readonly allowProjectionOnly: boolean;
  readonly force: boolean;
  readonly nowMs: number;
}

function usage(exitCode = 2): never {
  process.stderr.write(`Usage:
  node repository-context.mjs --repository <path-or-git-url> --output <directory>
    [--ref icarus/control]
    [--scope project|mine|work_item:<id>|workflow_instance:<id>|delta:<head>]
    [--principal-id <principal_id>]
    [--trusted-genesis <commit>] [--trusted-head <commit>]
    [--allow-projection-only] [--force]
`);
  process.exit(exitCode);
}

function parseScope(value: string): CollaborationAnalysisScope {
  if (value === 'project' || value === 'mine')
    return collaborationAnalysisScopeSchema.parse({ type: value });
  for (const prefix of ['work_item', 'workflow_instance', 'delta'] as const) {
    const marker = `${prefix}:`;
    if (!value.startsWith(marker)) continue;
    const id = value.slice(marker.length);
    if (!id) throw new Error(`Analysis scope requires an id: ${value}`);
    if (prefix === 'work_item')
      return collaborationAnalysisScopeSchema.parse({
        type: prefix,
        work_item_id: id,
      });
    if (prefix === 'workflow_instance')
      return collaborationAnalysisScopeSchema.parse({
        type: prefix,
        workflow_instance_id: id,
      });
    return collaborationAnalysisScopeSchema.parse({
      type: prefix,
      since_snapshot_head: id,
    });
  }
  throw new Error(`Unsupported analysis scope: ${value}`);
}

function parseArguments(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    '--repository',
    '--output',
    '--ref',
    '--scope',
    '--principal-id',
    '--trusted-genesis',
    '--trusted-head',
    '--now',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === '--help' || name === '-h') usage(0);
    if (name === '--allow-projection-only' || name === '--force') {
      flags.add(name);
      continue;
    }
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    if (!valueOptions.has(name)) throw new Error(`Unknown option: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${name}`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
    index += 1;
  }
  const repository = values.get('--repository');
  const output = values.get('--output');
  if (!repository || !output) usage();
  const now = values.get('--now');
  const nowMs = now ? Date.parse(now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`Invalid --now value: ${now}`);
  return {
    repository,
    output: path.resolve(output),
    requestedRef: values.get('--ref') ?? DEFAULT_REF,
    scope: parseScope(values.get('--scope') ?? 'project'),
    principalId: values.get('--principal-id') ?? null,
    trustedGenesis: values.get('--trusted-genesis') ?? null,
    trustedHead: values.get('--trusted-head') ?? null,
    allowProjectionOnly: flags.has('--allow-projection-only'),
    force: flags.has('--force'),
    nowMs,
  };
}

function gitOutput(repositoryPath: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function git(repositoryPath: string, args: readonly string[]): string {
  return gitOutput(repositoryPath, args).trim();
}

function safeSourceLabel(value: string, local: boolean): string {
  if (local) return path.basename(path.resolve(value)) || 'repository';
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/u, '');
  } catch {
    const withoutUser = value.replace(/^[^@\s]+@/u, '');
    return withoutUser.replace(/[?#].*$/u, '').slice(0, 1024);
  }
}

function lstatIfPresent(value: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoGitObjectRewriting(repositoryPath: string): void {
  const replacements = git(repositoryPath, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/replace/',
  ]);
  if (replacements)
    throw new Error(
      `Git replacement refs are not allowed: ${replacements.split('\n')[0]}`,
    );
  const commonDirectory = git(repositoryPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const graftsPath = path.join(commonDirectory, 'info', 'grafts');
  const entry = lstatIfPresent(graftsPath);
  if (!entry) return;
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    readFileSync(graftsPath, 'utf8')
      .split('\n')
      .some((line) => line.trim() && !line.trimStart().startsWith('#'))
  )
    throw new Error('Git graft state is not allowed');
}

function prepareRepository(value: string): {
  readonly repositoryPath: string;
  readonly sourceKind: 'local' | 'git_url';
  readonly sourceLabel: string;
  readonly localSourcePath: string | null;
  readonly cleanup: () => void;
} {
  let sourceKind: 'local' | 'git_url' = 'git_url';
  let sourceLabel = safeSourceLabel(value, false);
  let localSourcePath: string | null = null;
  if (existsSync(value)) {
    localSourcePath = path.resolve(value);
    if (!statSync(localSourcePath).isDirectory())
      throw new Error('Local repository path must be a directory');
    sourceKind = 'local';
    sourceLabel = safeSourceLabel(value, true);
  } else {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'file:') {
        const candidate = fileURLToPath(parsed);
        if (existsSync(candidate) && statSync(candidate).isDirectory())
          localSourcePath = path.resolve(candidate);
      }
    } catch {
      // Non-URL Git locators, including SCP syntax, remain remote inputs.
    }
  }
  if (localSourcePath) {
    git(localSourcePath, ['rev-parse', '--git-dir']);
    assertNoGitObjectRewriting(localSourcePath);
  }
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), 'icarus-project-analyst-repository-'),
  );
  const repositoryPath = path.join(temporaryRoot, 'repository.git');
  try {
    execFileSync(
      'git',
      [
        'clone',
        '--mirror',
        '--no-local',
        '--no-tags',
        '--',
        value,
        repositoryPath,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(
      'Git repository clone failed; check the path or remote locator, access, and available transport credentials',
    );
  }
  try {
    assertNoGitObjectRewriting(repositoryPath);
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    repositoryPath,
    sourceKind,
    sourceLabel,
    localSourcePath,
    cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
  };
}

function canonicalProspectivePath(value: string): string {
  let existing = path.resolve(value);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missing);
}

function assertOutputOutsideLocalRepository(
  repositoryPath: string,
  output: string,
): void {
  const bare = git(repositoryPath, ['rev-parse', '--is-bare-repository']);
  const gitBoundary = git(repositoryPath, [
    'rev-parse',
    bare === 'true' ? '--absolute-git-dir' : '--show-toplevel',
  ]);
  const repositoryRoot = realpathSync(
    path.isAbsolute(gitBoundary)
      ? gitBoundary
      : path.resolve(repositoryPath, gitBoundary),
  );
  const canonicalOutput = canonicalProspectivePath(output);
  const relative = path.relative(repositoryRoot, canonicalOutput);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
    throw new Error(
      'Output directory must be outside the local Group repository to preserve read-only access',
    );
}

function refCandidates(requested: string): string[] {
  if (!requested || requested.startsWith('-') || requested.includes('\0'))
    throw new Error(`Unsafe Git ref: ${requested}`);
  if (requested.startsWith('refs/')) return [requested];
  return [
    requested,
    `refs/heads/${requested}`,
    `refs/remotes/origin/${requested}`,
  ];
}

function resolveRef(
  repositoryPath: string,
  requested: string,
): {
  readonly resolvedRef: string;
  readonly head: string;
} {
  for (const candidate of refCandidates(requested)) {
    try {
      const head = git(repositoryPath, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${candidate}^{commit}`,
      ]);
      if (/^[a-f0-9]{40,64}$/u.test(head))
        return { resolvedRef: candidate, head };
    } catch {
      // Try the next canonical control-ref spelling.
    }
  }
  throw new Error(
    `Git ref not found: ${requested}. Expected ${COLLABORATION_CONTROL_BRANCH}.`,
  );
}

function rootCommit(repositoryPath: string, head: string): string {
  const roots = git(repositoryPath, [
    'rev-list',
    '--max-parents=0',
    '--reverse',
    head,
  ])
    .split('\n')
    .filter(Boolean);
  if (roots.length !== 1)
    throw new Error(
      'Collaboration history must have exactly one genesis commit',
    );
  return roots[0]!;
}

function assertTrustedAnchors(input: {
  readonly head: string;
  readonly genesis: string;
  readonly trustedHead: string | null;
  readonly trustedGenesis: string | null;
}): boolean {
  for (const [label, actual, trusted] of [
    ['head', input.head, input.trustedHead],
    ['genesis', input.genesis, input.trustedGenesis],
  ] as const) {
    if (trusted && !/^[a-f0-9]{40,64}$/u.test(trusted))
      throw new Error(`Trusted ${label} must be a full Git commit id`);
    if (trusted && trusted !== actual)
      throw new Error(
        `Trusted ${label} mismatch: expected ${trusted}, resolved ${actual}`,
      );
  }
  return Boolean(input.trustedHead || input.trustedGenesis);
}

function passedChecks(): CollaborationRepositoryVerification['checks'] {
  return {
    git_repository: 'passed',
    ref_resolution: 'passed',
    complete_history_validation: 'passed',
    linear_commit_history: 'passed',
    strict_protocol_json: 'passed',
    event_schema_and_payload_hash: 'passed',
    aggregate_revision_and_previous_hash: 'passed',
    commit_order: 'passed',
    commit_signatures_and_actor_credentials: 'passed',
    reducer_replay: 'passed',
    materialized_projection: 'passed',
    projection_json_readable: 'passed',
    business_file_hashes: 'passed',
  };
}

function failureVerification(input: {
  readonly requestedRef: string;
  readonly resolvedRef: string | null;
  readonly head: string | null;
  readonly genesis: string | null;
  readonly trustedGenesis: string | null;
  readonly trustedHead: string | null;
  readonly message: string;
  readonly projectionOnly: boolean;
}): CollaborationRepositoryVerification {
  return collaborationRepositoryVerificationSchema.parse({
    format: 'icarus.collaboration-repository-verification/1',
    level: input.projectionOnly ? 'projection_only' : 'unverified',
    repository_identity: 'not_established',
    requested_ref: input.requestedRef,
    resolved_ref: input.resolvedRef,
    repository_head: input.head,
    genesis_commit: input.genesis,
    trusted_genesis: input.trustedGenesis,
    trusted_head: input.trustedHead,
    event_count: 0,
    checks: {
      git_repository: 'passed',
      ref_resolution: input.head ? 'passed' : 'failed',
      complete_history_validation: 'failed',
      linear_commit_history: 'not_run',
      strict_protocol_json: 'not_run',
      event_schema_and_payload_hash: 'not_run',
      aggregate_revision_and_previous_hash: 'not_run',
      commit_order: 'not_run',
      commit_signatures_and_actor_credentials: 'not_run',
      reducer_replay: 'not_run',
      materialized_projection: 'not_run',
      projection_json_readable: input.projectionOnly ? 'passed' : 'not_run',
      business_file_hashes: 'not_run',
    },
    failure: { code: 'repository_verification_failed', message: input.message },
  });
}

function showJson(
  repositoryPath: string,
  head: string,
  repositoryFile: string,
): unknown {
  return JSON.parse(git(repositoryPath, ['show', `${head}:${repositoryFile}`]));
}

function projectionFiles(repositoryPath: string, head: string): string[] {
  return repositoryFiles(repositoryPath, head).filter(
    (file) => file.startsWith('projections/') && file.endsWith('.json'),
  );
}

function repositoryFiles(repositoryPath: string, head: string): string[] {
  const fields = gitOutput(repositoryPath, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    head,
  ]).split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

function loadProjectionOnly(
  repositoryPath: string,
  head: string,
  failure: string,
): CollaborationProjectionV3 {
  const group = showJson(repositoryPath, head, 'group.json') as {
    group_id?: unknown;
  };
  if (typeof group.group_id !== 'string')
    throw new Error('Projection-only fallback cannot parse group.json');
  const projection: CollaborationProjectionV3 = {
    format: 'icarus.collaboration-projection/3',
    protocolVersion: 3,
    groupId: group.group_id,
    group: group as CollaborationProjectionV3['group'],
    aggregateHeads: {},
    invites: {},
    members: {},
    clients: {},
    credentials: {},
    recoveryRequests: {},
    executors: {},
    permissionGrants: {},
    progressUpdates: {},
    files: {},
    artifacts: {},
    fileLocations: {},
    actions: {},
    workItems: {},
    workItemUpdates: {},
    discussions: {},
    notifications: {},
    workflowDefinitions: {},
    latestWorkflowDefinitionVersions: {},
    workflowInstances: {},
    stateExecutions: {},
    turns: {},
    timeoutObservations: {},
    seenEventIds: [],
    activity: [],
    integrityStatus: 'PROTOCOL_QUARANTINED',
    integrityMessage: failure,
  };
  for (const file of projectionFiles(repositoryPath, head)) {
    const value = showJson(repositoryPath, head, file) as Record<string, any>;
    let match = /^projections\/invites\/([^/]+)\.json$/u.exec(file);
    if (match) projection.invites[match[1]!] = value as any;
    match = /^projections\/members\/([^/]+)\.json$/u.exec(file);
    if (match) {
      const id = match[1]!;
      if (value.member) projection.members[id] = value.member;
      projection.clients[id] = value.clients ?? {};
      projection.credentials[id] = value.credentials ?? {};
      projection.executors[id] = value.executors ?? {};
      if (value.permission_grant)
        projection.permissionGrants[id] = value.permission_grant;
    }
    match = /^projections\/recovery-requests\/([^/]+)\.json$/u.exec(file);
    if (match) projection.recoveryRequests[match[1]!] = value as any;
    match = /^projections\/workspace\/([^/]+)\.json$/u.exec(file);
    if (match) {
      for (const update of value.updates ?? [])
        projection.progressUpdates[update.update_id] = update;
      for (const metadata of value.files ?? [])
        projection.files[metadata.file_id] = metadata;
      for (const action of value.actions ?? [])
        projection.actions[action.action_id] = action;
    }
    match = /^projections\/work-items\/([^/]+)\.json$/u.exec(file);
    if (match) {
      const id = match[1]!;
      if (value.item) projection.workItems[id] = value.item;
      projection.workItemUpdates[id] = value.updates ?? [];
    }
    match = /^projections\/discussions\/([^/]+)\.json$/u.exec(file);
    if (match && value.discussion)
      projection.discussions[match[1]!] = value as any;
    match = /^projections\/notifications\/([^/]+)\.json$/u.exec(file);
    if (match) {
      const id = match[1]!;
      const notification = memberNotificationV3Schema.parse(value);
      if (notification.notification_id !== id)
        throw new Error(
          `Projection notification id does not match path: ${file}`,
        );
      projection.notifications[id] = notification;
    }
    match = /^projections\/workflow-definitions\/([^/]+)\.json$/u.exec(file);
    if (match && value.definition) {
      const definitionId = match[1]!;
      const version = Number(value.definition.version);
      projection.workflowDefinitions[
        workflowDefinitionVersionKey(definitionId, version)
      ] = value as any;
      projection.latestWorkflowDefinitionVersions[definitionId] = version;
    }
    match = /^projections\/workflow-instances\/([^/]+)\.json$/u.exec(file);
    if (match) {
      const id = match[1]!;
      if (value.instance) projection.workflowInstances[id] = value.instance;
      projection.stateExecutions[id] = value.execution ?? {};
      for (const turn of Object.values(value.turns ?? {}) as any[])
        projection.turns[turn.turn_id] = turn;
    }
  }
  const files = repositoryFiles(repositoryPath, head);
  for (const file of files) {
    const metadataMatch =
      /^(workspace\/(?:shared\/documents|principals\/([^/]+)\/files)\/([^/]+))\/metadata\.json$/u.exec(
        file,
      );
    if (metadataMatch) {
      const metadata = showJson(repositoryPath, head, file) as any;
      projection.files[metadata.file_id] = metadata;
      projection.fileLocations[metadata.file_id] = {
        scope: metadataMatch[2] ? 'principal' : 'shared',
        principalId: metadataMatch[2] ?? null,
        repositoryDirectory: metadataMatch[1]!,
      };
    }
    if (/^artifacts\/.+\/metadata\.json$/u.test(file)) {
      const artifact = showJson(repositoryPath, head, file) as any;
      projection.artifacts[artifact.artifact_id] = artifact;
    }
    if (!/^events\/.+\.json$/u.test(file)) continue;
    try {
      const event = showJson(repositoryPath, head, file) as Record<string, any>;
      if (
        typeof event.event_id !== 'string' ||
        typeof event.aggregate_type !== 'string' ||
        typeof event.aggregate_id !== 'string'
      )
        continue;
      projection.seenEventIds.push(event.event_id);
      projection.activity.push({
        eventId: event.event_id,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        aggregateRevision: Number(event.aggregate_revision),
        eventType: event.event_type,
        actorPrincipalId: event.actor?.principal_id ?? 'unknown',
        actorClientId: event.actor?.client_id ?? 'unknown',
        occurredAt: event.occurred_at,
      });
      projection.aggregateHeads[
        `${event.aggregate_type}:${event.aggregate_id}`
      ] = {
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        revision: Number(event.aggregate_revision),
        eventHash: collaborationEventHashV3(event as any),
        eventId: event.event_id,
      };
    } catch {
      // Projection-only mode deliberately makes no event guarantees.
    }
  }
  return projection;
}

function prepareOutput(directory: string, force: boolean): void {
  const managedFiles = [
    'context.json',
    'manifest.json',
    'verification.json',
    'result-template.json',
    'resources/catalog.json',
  ];
  const outputEntry = lstatIfPresent(directory);
  if (outputEntry?.isSymbolicLink())
    throw new Error('Output directory must not be a symbolic link');
  if (outputEntry && !outputEntry.isDirectory())
    throw new Error('Output path must be a directory');
  if (!outputEntry) mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length && !force)
    throw new Error(
      'Output directory is not empty; pass --force to replace files',
    );
  const resources = path.join(directory, 'resources');
  const resourcesEntry = lstatIfPresent(resources);
  if (resourcesEntry?.isSymbolicLink())
    throw new Error('Managed output directory must not be a symbolic link');
  if (resourcesEntry && !resourcesEntry.isDirectory())
    throw new Error('Managed resources path must be a directory');
  const existingManagedFiles = managedFiles.flatMap((relative) => {
    const target = path.join(directory, relative);
    const entry = lstatIfPresent(target);
    if (!entry) return [];
    if (entry.isSymbolicLink() || !entry.isFile())
      throw new Error(
        `Managed output file must be a regular file: ${relative}`,
      );
    return [target];
  });
  if (force) for (const target of existingManagedFiles) unlinkSync(target);
  if (!resourcesEntry) mkdirSync(resources);
}

function writeJson(directory: string, relative: string, value: unknown): void {
  const target = path.join(directory, relative);
  const entry = lstatIfPresent(target);
  if (entry && (entry.isSymbolicLink() || !entry.isFile()))
    throw new Error(`Managed output target is not a regular file: ${relative}`);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFailure(
  output: string,
  force: boolean,
  verification: CollaborationRepositoryVerification,
): void {
  prepareOutput(output, force);
  writeJson(output, 'verification.json', verification);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.scope.type === 'mine' && !options.principalId)
    throw new Error('The mine scope requires --principal-id');
  const cleanupGitRuntime = installControlledGitEnvironment();
  let prepared: ReturnType<typeof prepareRepository>;
  try {
    prepared = prepareRepository(options.repository);
  } catch (error) {
    cleanupGitRuntime();
    throw error;
  }
  let resolvedRef: string | null = null;
  let head: string | null = null;
  let genesis: string | null = null;
  try {
    if (prepared.localSourcePath)
      assertOutputOutsideLocalRepository(
        prepared.localSourcePath,
        options.output,
      );
    ({ resolvedRef, head } = resolveRef(
      prepared.repositoryPath,
      options.requestedRef,
    ));
    genesis = rootCommit(prepared.repositoryPath, head);
    const anchored = assertTrustedAnchors({
      head,
      genesis,
      trustedHead: options.trustedHead,
      trustedGenesis: options.trustedGenesis,
    });
    let history: ValidatedProjectSpaceHistory | null = null;
    let projection: CollaborationProjectionV3;
    let verification: CollaborationRepositoryVerification;
    try {
      history = await validateCollaborationProjectSpaceHistory({
        repositoryPath: prepared.repositoryPath,
        head,
        canonicalGenesisSelfDescription,
      });
      projection = history.projection;
      verification = collaborationRepositoryVerificationSchema.parse({
        format: 'icarus.collaboration-repository-verification/1',
        level: anchored ? 'verified' : 'self_consistent',
        repository_identity: anchored
          ? 'trusted_input_match'
          : 'not_externally_anchored',
        requested_ref: options.requestedRef,
        resolved_ref: resolvedRef,
        repository_head: head,
        genesis_commit: genesis,
        trusted_genesis: options.trustedGenesis,
        trusted_head: options.trustedHead,
        event_count: history.eventRecords.length,
        checks: passedChecks(),
        failure: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.allowProjectionOnly) {
        const diagnostic = failureVerification({
          requestedRef: options.requestedRef,
          resolvedRef,
          head,
          genesis,
          trustedGenesis: options.trustedGenesis,
          trustedHead: options.trustedHead,
          message,
          projectionOnly: false,
        });
        writeFailure(options.output, options.force, diagnostic);
        throw new Error(
          `${message}. Wrote unverified diagnostics; no analysis context was created.`,
        );
      }
      projection = loadProjectionOnly(prepared.repositoryPath, head, message);
      verification = failureVerification({
        requestedRef: options.requestedRef,
        resolvedRef,
        head,
        genesis,
        trustedGenesis: options.trustedGenesis,
        trustedHead: options.trustedHead,
        message,
        projectionOnly: true,
      });
    }
    if (options.principalId && !projection.members[options.principalId])
      throw new Error(
        `Principal is not present in the selected repository head: ${options.principalId}`,
      );
    const pseudoGroup = {
      localPrincipalId: options.principalId,
      localClientId: null,
      localCredentialId: null,
      protocolStatus:
        verification.level === 'verified' ||
        verification.level === 'self_consistent'
          ? 'OK'
          : 'PROTOCOL_QUARANTINED',
      protocolError: verification.failure?.message ?? null,
      ownerPrincipalId: projection.group.owner_principal_id,
      subscriptionMode: 'observer',
      lastError: verification.failure?.message ?? null,
      lastSyncAtMs: null,
    } as any;
    const insight = buildCollaborationProjectInsight({
      group: pseudoGroup,
      projection,
      snapshotHead: head,
      nowMs: options.nowMs,
    });
    const myItems = buildMyItems({
      group: pseudoGroup,
      projection,
      nowMs: options.nowMs,
    });
    const fullCatalog = buildCollaborationAnalysisResourceCatalog(projection);
    const delta =
      options.scope.type === 'delta'
        ? history
          ? buildCollaborationAnalysisDeltaSelection({
              scope: options.scope,
              history,
              fullCatalog,
            })
          : (() => {
              throw new Error(
                'Delta scope is unavailable for projection-only analysis',
              );
            })()
        : null;
    if (options.scope.type === 'delta' && !delta)
      throw new Error(
        'Delta scope requires a base commit in the validated control history',
      );
    const catalog =
      delta?.catalog ??
      scopeCollaborationAnalysisResourceCatalog({
        catalog: fullCatalog,
        scope: options.scope,
        projection,
        currentPrincipalId: options.principalId,
        myItemRefs: myItems.map(
          (item) => `${item.resource_type}:${item.resource_id}`,
        ),
      });
    const resourceIndex = Object.keys(catalog).sort();
    const resourceCatalogHash = collaborationCanonicalHashV3(catalog);
    const visible = new Set(resourceIndex);
    const ruleSignals = insight.signals.filter((signal) =>
      [...signal.affected_refs, ...signal.evidence_refs].every((ref) =>
        visible.has(ref),
      ),
    );
    const visibleMyItems = myItems.filter(
      (item) =>
        options.scope.type === 'mine' ||
        visible.has(`${item.resource_type}:${item.resource_id}`),
    );
    const activity = (delta?.activity ?? insight.recent_activity).filter(
      (event) => visible.has(`event:${event.eventId}`),
    );
    const context = collaborationRepositoryAnalysisInputSchema.parse({
      format: 'icarus.collaboration-repository-analysis-input/1',
      contract_version: 1,
      repository: {
        source_kind: prepared.sourceKind,
        source_label: prepared.sourceLabel,
        requested_ref: options.requestedRef,
        resolved_ref: resolvedRef,
        repository_head: head,
        genesis_commit: genesis,
      },
      scope: options.scope,
      current_principal_id: options.principalId,
      resource_catalog_hash: resourceCatalogHash,
      generated_at: new Date(options.nowMs).toISOString(),
      security: {
        repository_content_is_untrusted: true,
        read_only_repository: true,
        required_result_format:
          'icarus.collaboration-repository-analysis-result/1',
        result_is_not_icarus_analysis_run: true,
      },
      verification,
      change_range:
        delta && options.scope.type === 'delta'
          ? {
              since_snapshot_head: options.scope.since_snapshot_head,
              repository_head: head,
              event_count: delta.eventCount,
              changed_refs: delta.changedRefs,
            }
          : null,
      project_summary: {
        format: insight.format,
        group_id: insight.group_id,
        repository_head: head,
        generated_at: insight.generated_at,
        health: insight.health,
        counts: insight.counts,
        verification_level: verification.level,
      },
      my_items: visibleMyItems,
      rule_signals: ruleSignals,
      resource_index: resourceIndex,
      activity_delta: activity,
      prior_findings: [],
    });
    const contextHash = collaborationCanonicalHashV3(context);
    const resultTemplate = {
      format: 'icarus.collaboration-repository-analysis-result/1',
      contract_version: 1,
      repository_head: head,
      context_hash: contextHash,
      resource_catalog_hash: resourceCatalogHash,
      scope: options.scope,
      verification_level: verification.level,
      summary: {
        health: 'unknown',
        headline: 'Replace with a concise project assessment',
        details: '',
      },
      findings: [],
    };
    prepareOutput(options.output, options.force);
    writeJson(options.output, 'context.json', context);
    writeJson(options.output, 'manifest.json', {
      format: 'icarus.collaboration-repository-analysis-manifest/1',
      contract_version: 1,
      tool_version: TOOL_VERSION,
      repository_head: head,
      context_hash: contextHash,
      resource_catalog_hash: resourceCatalogHash,
      scope: options.scope,
      verification_level: verification.level,
      result_format: resultTemplate.format,
      host_analysis_run_binding: false,
    });
    writeJson(options.output, 'verification.json', verification);
    writeJson(options.output, 'resources/catalog.json', catalog);
    writeJson(options.output, 'result-template.json', resultTemplate);
    process.stdout.write(
      `${canonicalJsonStringify({
        ok: true,
        output: options.output,
        repository_head: head,
        context_hash: contextHash,
        resource_catalog_hash: resourceCatalogHash,
        verification_level: verification.level,
        resource_count: resourceIndex.length,
      })}\n`,
    );
  } finally {
    try {
      prepared.cleanup();
    } finally {
      cleanupGitRuntime();
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
