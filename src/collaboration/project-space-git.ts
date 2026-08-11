import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  CollaborationProjectSpaceTransport,
  ValidatedProjectSpaceHistory,
} from './project-space-service.js';
import {
  collaborationEventHashV3,
  deterministicProjectionJsonV3,
  reduceCollaborationEventV3,
  validateCollaborationEventV3,
  workflowDefinitionVersionKey,
  type CollaborationProjectionV3,
} from './protocol/v3-reducer.js';
import {
  prettyCollaborationJson,
  strictParseJsonBytes,
} from './protocol/canonical-json.js';
import {
  artifactMetadataV3Schema,
  credentialDefinitionSchema,
  fileMetadataSchema,
  recoveryRequestSchema,
  type ArtifactMetadataV3,
  type CollaborationEventV3,
  type CredentialDefinition,
  type FileMetadata,
} from './protocol/v3-schema.js';
import {
  COLLABORATION_CONTROL_BRANCH,
  CollaborationProtocolError,
} from './protocol/version.js';
import type { CollaborationEventSigningIdentity } from './project-space-identity.js';

const execFileAsync = promisify(execFile);
const CONTROL_REMOTE_REF = 'refs/remotes/origin/icarus/control';
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface GitSshCommandResult extends CommandResult {
  readonly gitSshKeyPath: string;
}

export interface CollaborationProjectSpaceMaterializedFile {
  readonly path: string;
  readonly contents: string | Buffer | null;
}

export class CollaborationProjectSpaceGitConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationProjectSpaceGitConflictError';
  }
}

export class CollaborationProjectSpaceHistoryRewrittenError extends Error {
  constructor(
    message: string,
    readonly replacementGroupId: string | null,
  ) {
    super(message);
    this.name = 'CollaborationProjectSpaceHistoryRewrittenError';
  }
}

async function execute(
  cwd: string,
  binary: string,
  args: readonly string[],
  allowFailure = false,
  gitSshKeyPath?: string,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(binary, [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitSshKeyPath
        ? {
            ...process.env,
            GIT_SSH_COMMAND: `ssh -i '${gitSshKeyPath.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes`,
          }
        : process.env,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    if (allowFailure)
      return {
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? value.message,
        exitCode: typeof value.code === 'number' ? value.code : 1,
      };
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Git protocol operation failed: ${binary} ${args.join(' ')}: ${value.stderr ?? value.message}`,
    );
  }
}

function normalizedGitSshKeyCandidates(input: {
  readonly gitSshKeyPath?: string;
  readonly gitSshKeyPaths?: readonly string[];
}): readonly string[] {
  const configured = input.gitSshKeyPaths?.length
    ? input.gitSshKeyPaths
    : [input.gitSshKeyPath ?? path.join(os.homedir(), '.ssh', 'id_rsa')];
  return [...new Set(configured.map((value) => path.resolve(value)))];
}

function isPublicKeyAuthenticationFailure(result: CommandResult): boolean {
  return /Permission denied \(publickey|no supported authentication methods available/iu.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

async function executeWithGitSshCandidates(
  cwd: string,
  binary: string,
  args: readonly string[],
  candidates: readonly string[],
): Promise<GitSshCommandResult> {
  if (!candidates.length) throw new Error('Git SSH key candidates are empty');
  for (const [index, gitSshKeyPath] of candidates.entries()) {
    const result = await execute(cwd, binary, args, true, gitSshKeyPath);
    if (result.exitCode === 0) return { ...result, gitSshKeyPath };
    const hasFallback = index + 1 < candidates.length;
    if (!hasFallback || !isPublicKeyAuthenticationFailure(result)) {
      const attempted = candidates.slice(0, index + 1);
      return {
        ...result,
        stderr:
          attempted.length > 1
            ? `${result.stderr.trim()}\nSSH keys tried: ${attempted.join(', ')}`
            : result.stderr,
        gitSshKeyPath,
      };
    }
  }
  throw new Error('Git SSH key fallback exhausted unexpectedly');
}

async function git(
  repositoryPath: string,
  args: readonly string[],
  allowFailure = false,
): Promise<CommandResult> {
  return execute(repositoryPath, 'git', args, allowFailure);
}

async function showBytes(
  repositoryPath: string,
  commit: string,
  repositoryFile: string,
): Promise<Buffer> {
  try {
    const result = (await execFileAsync(
      'git',
      ['show', `${commit}:${repositoryFile}`],
      {
        cwd: repositoryPath,
        encoding: null,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      },
    )) as unknown as { stdout: Buffer };
    return result.stdout;
  } catch (error) {
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Cannot read verified repository file ${repositoryFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function showJson(
  repositoryPath: string,
  commit: string,
  repositoryFile: string,
): Promise<unknown> {
  return strictParseJsonBytes(
    await showBytes(repositoryPath, commit, repositoryFile),
  );
}

function normalizedRepositoryPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 768 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '' || segment === '..')
  )
    throw new Error(`Unsafe collaboration repository path: ${value}`);
  return value;
}

function writeRepositoryFile(
  checkoutPath: string,
  repositoryFile: string,
  contents: string | Buffer,
): void {
  const safePath = normalizedRepositoryPath(repositoryFile);
  const root = `${path.resolve(checkoutPath)}${path.sep}`;
  const target = path.resolve(checkoutPath, safePath);
  if (!target.startsWith(root))
    throw new Error(`Repository path escapes checkout: ${repositoryFile}`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, { mode: 0o600 });
}

function deleteRepositoryFile(
  checkoutPath: string,
  repositoryFile: string,
): void {
  const safePath = normalizedRepositoryPath(repositoryFile);
  const target = path.resolve(checkoutPath, safePath);
  const root = `${path.resolve(checkoutPath)}${path.sep}`;
  if (!target.startsWith(root))
    throw new Error(`Repository path escapes checkout: ${repositoryFile}`);
  try {
    unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const EVENT_DIRECTORIES = {
  group: 'group',
  invite: 'invites',
  membership: 'members',
  recovery: 'recovery-requests',
  workspace: 'workspace',
  work_item: 'work-items',
  discussion: 'discussions',
  workflow_definition: 'workflow-definitions',
  workflow_instance: 'workflow-instances',
} as const;

export function collaborationProjectSpaceEventPath(
  event: CollaborationEventV3,
): string {
  const root = EVENT_DIRECTORIES[event.aggregate_type];
  const aggregate =
    event.aggregate_type === 'group' ? '' : `/${event.aggregate_id}`;
  return `events/${root}${aggregate}/${String(event.aggregate_revision).padStart(8, '0')}-${event.event_id}.json`;
}

function aggregateProjectionPath(event: CollaborationEventV3): string {
  switch (event.aggregate_type) {
    case 'group':
      return 'projections/group.json';
    case 'invite':
      return `projections/invites/${event.aggregate_id}.json`;
    case 'membership':
      return `projections/members/${event.aggregate_id}.json`;
    case 'recovery':
      return `projections/recovery-requests/${event.aggregate_id}.json`;
    case 'workspace':
      return `projections/workspace/${event.aggregate_id}.json`;
    case 'work_item':
      return `projections/work-items/${event.aggregate_id}.json`;
    case 'discussion':
      return `projections/discussions/${event.aggregate_id}.json`;
    case 'workflow_definition':
      return `projections/workflow-definitions/${event.aggregate_id}.json`;
    case 'workflow_instance':
      return `projections/workflow-instances/${event.aggregate_id}.json`;
  }
}

function aggregateProjectionValue(
  event: CollaborationEventV3,
  projection: CollaborationProjectionV3,
): unknown {
  switch (event.aggregate_type) {
    case 'group':
      return projection.group;
    case 'invite':
      return projection.invites[event.aggregate_id] ?? null;
    case 'membership':
      return {
        format: 'icarus.collaboration-member-projection/1',
        member: projection.members[event.aggregate_id] ?? null,
        clients: projection.clients[event.aggregate_id] ?? {},
        credentials: projection.credentials[event.aggregate_id] ?? {},
        executors: projection.executors[event.aggregate_id] ?? {},
        permission_grant:
          projection.permissionGrants[event.aggregate_id] ?? null,
      };
    case 'recovery':
      return projection.recoveryRequests[event.aggregate_id] ?? null;
    case 'workspace':
      return {
        format: 'icarus.collaboration-workspace-projection/1',
        principal_id: event.aggregate_id,
        updates: Object.values(projection.progressUpdates).filter(
          (update) => update.principal_id === event.aggregate_id,
        ),
        files: Object.values(projection.files).filter(
          (file) => file.uploader_principal_id === event.aggregate_id,
        ),
        actions: Object.values(projection.actions).filter(
          (action) => action.owner_principal_id === event.aggregate_id,
        ),
      };
    case 'work_item':
      return {
        format: 'icarus.collaboration-work-item-projection/1',
        item: projection.workItems[event.aggregate_id] ?? null,
        updates: projection.workItemUpdates[event.aggregate_id] ?? [],
      };
    case 'discussion':
      return (
        projection.discussions[event.aggregate_id] ?? {
          discussion: null,
          messages: {},
        }
      );
    case 'workflow_definition': {
      const version =
        projection.latestWorkflowDefinitionVersions[event.aggregate_id];
      return version
        ? projection.workflowDefinitions[
            workflowDefinitionVersionKey(event.aggregate_id, version)
          ]
        : null;
    }
    case 'workflow_instance':
      return {
        format: 'icarus.collaboration-workflow-instance-projection/1',
        instance: projection.workflowInstances[event.aggregate_id] ?? null,
        execution: projection.stateExecutions[event.aggregate_id] ?? {},
        turns: Object.fromEntries(
          Object.entries(projection.turns).filter(
            ([, turn]) => turn.workflow_instance_id === event.aggregate_id,
          ),
        ),
      };
  }
}

function fileDirectory(
  event: CollaborationEventV3,
  metadata: FileMetadata,
): string {
  return event.event_type.startsWith('shared_')
    ? `workspace/shared/documents/${metadata.file_id}`
    : `workspace/principals/${event.actor.principal_id}/files/${metadata.file_id}`;
}

function artifactDirectory(metadata: ArtifactMetadataV3): string {
  return metadata.scope.type === 'work_item'
    ? `artifacts/work-items/${metadata.scope.work_item_id}/${metadata.artifact_id}`
    : `artifacts/workflows/${metadata.scope.workflow_instance_id}/${metadata.scope.turn_id}/${metadata.artifact_id}`;
}

function eventArtifacts(event: CollaborationEventV3): ArtifactMetadataV3[] {
  if (
    event.event_type !== 'work_item_progress_posted' &&
    event.event_type !== 'turn_completed'
  )
    return [];
  return artifactMetadataV3Schema
    .array()
    .max(20)
    .parse(event.payload.artifacts);
}

function automaticMaterialization(
  event: CollaborationEventV3,
  projection: CollaborationProjectionV3,
): Map<string, string | Buffer | null> {
  const files = new Map<string, string | Buffer | null>();
  files.set(
    aggregateProjectionPath(event),
    prettyCollaborationJson(aggregateProjectionValue(event, projection)),
  );
  switch (event.event_type) {
    case 'group_initialized':
    case 'group_settings_updated':
    case 'group_archived':
    case 'group_reopened':
    case 'group_dissolved':
      files.set('group.json', prettyCollaborationJson(projection.group));
      if (event.event_type !== 'group_initialized') break;
      for (const [principalId, member] of Object.entries(projection.members)) {
        files.set(
          `members/${principalId}/member.json`,
          prettyCollaborationJson(member),
        );
        for (const client of Object.values(
          projection.clients[principalId] ?? {},
        ))
          files.set(
            `members/${principalId}/clients/${client.client_id}.json`,
            prettyCollaborationJson(client),
          );
        for (const credential of Object.values(
          projection.credentials[principalId] ?? {},
        ))
          files.set(
            `members/${principalId}/credentials/${credential.credential_id}.json`,
            prettyCollaborationJson(credential),
          );
        const grant = projection.permissionGrants[principalId];
        if (grant)
          files.set(
            `permissions/${principalId}.json`,
            prettyCollaborationJson(grant),
          );
      }
      break;
    case 'invite_issued':
    case 'invite_revoked': {
      const invite = projection.invites[event.aggregate_id];
      if (invite)
        files.set(
          `invites/${event.aggregate_id}.json`,
          prettyCollaborationJson(invite),
        );
      break;
    }
    case 'membership_requested':
    case 'membership_rejected':
    case 'member_registered':
    case 'member_suspended':
    case 'member_reactivated':
    case 'member_removed':
    case 'member_left': {
      const member = projection.members[event.aggregate_id];
      if (member)
        files.set(
          `members/${event.aggregate_id}/member.json`,
          prettyCollaborationJson(member),
        );
      if (
        event.event_type === 'membership_requested' ||
        (event.event_type === 'member_registered' && event.payload.client)
      ) {
        const client = event.payload.client as { client_id: string };
        const credential = event.payload.credential as {
          credential_id: string;
        };
        files.set(
          `members/${event.aggregate_id}/clients/${client.client_id}.json`,
          prettyCollaborationJson(
            projection.clients[event.aggregate_id]?.[client.client_id],
          ),
        );
        files.set(
          `members/${event.aggregate_id}/credentials/${credential.credential_id}.json`,
          prettyCollaborationJson(
            projection.credentials[event.aggregate_id]?.[
              credential.credential_id
            ],
          ),
        );
      }
      if (event.event_type === 'membership_requested') {
        const inviteId = event.payload.invite_id;
        if (typeof inviteId === 'string') {
          const invite = projection.invites[inviteId];
          if (invite) {
            files.set(
              `invites/${inviteId}.json`,
              prettyCollaborationJson(invite),
            );
            files.set(
              `projections/invites/${inviteId}.json`,
              prettyCollaborationJson(invite),
            );
          }
        }
      }
      if (event.event_type === 'member_left') {
        for (const client of Object.values(
          projection.clients[event.aggregate_id] ?? {},
        ))
          files.set(
            `members/${event.aggregate_id}/clients/${client.client_id}.json`,
            prettyCollaborationJson(client),
          );
        for (const credential of Object.values(
          projection.credentials[event.aggregate_id] ?? {},
        ))
          files.set(
            `members/${event.aggregate_id}/credentials/${credential.credential_id}.json`,
            prettyCollaborationJson(credential),
          );
        for (const executor of Object.values(
          projection.executors[event.aggregate_id] ?? {},
        ))
          files.set(
            `members/${event.aggregate_id}/executors/${executor.executor_id}.json`,
            prettyCollaborationJson(executor),
          );
        for (const turn of Object.values(projection.turns)) {
          if (
            turn.state !== 'recovery_required' ||
            turn.recovery_reason !== `member_left:${event.actor.principal_id}`
          )
            continue;
          const instance =
            projection.workflowInstances[turn.workflow_instance_id];
          files.set(
            `workflows/instances/${turn.workflow_instance_id}/turns/${turn.turn_id}.json`,
            prettyCollaborationJson(turn),
          );
          files.set(
            `workflows/instances/${turn.workflow_instance_id}/instance.json`,
            prettyCollaborationJson(instance),
          );
          files.set(
            `projections/workflow-instances/${turn.workflow_instance_id}.json`,
            prettyCollaborationJson({
              format: 'icarus.collaboration-workflow-instance-projection/1',
              instance: instance ?? null,
              execution:
                projection.stateExecutions[turn.workflow_instance_id] ?? {},
              turns: Object.fromEntries(
                Object.entries(projection.turns).filter(
                  ([, candidate]) =>
                    candidate.workflow_instance_id ===
                    turn.workflow_instance_id,
                ),
              ),
            }),
          );
        }
      }
      break;
    }
    case 'client_revoked': {
      const clientId = String(event.payload.client_id);
      files.set(
        `members/${event.aggregate_id}/clients/${clientId}.json`,
        prettyCollaborationJson(
          projection.clients[event.aggregate_id]?.[clientId],
        ),
      );
      for (const credential of Object.values(
        projection.credentials[event.aggregate_id] ?? {},
      ))
        if (credential.client_id === clientId)
          files.set(
            `members/${event.aggregate_id}/credentials/${credential.credential_id}.json`,
            prettyCollaborationJson(credential),
          );
      break;
    }
    case 'credential_rotated': {
      const credential = credentialDefinitionSchema.parse(
        event.payload.credential,
      );
      files.set(
        `members/${event.aggregate_id}/credentials/${credential.credential_id}.json`,
        prettyCollaborationJson(credential),
      );
      const revoked = event.payload.revoke_credential_id;
      if (typeof revoked === 'string')
        files.set(
          `members/${event.aggregate_id}/credentials/${revoked}.json`,
          prettyCollaborationJson(
            projection.credentials[event.aggregate_id]?.[revoked],
          ),
        );
      break;
    }
    case 'credential_revoked': {
      const credentialId = String(event.payload.credential_id);
      files.set(
        `members/${event.aggregate_id}/credentials/${credentialId}.json`,
        prettyCollaborationJson(
          projection.credentials[event.aggregate_id]?.[credentialId],
        ),
      );
      break;
    }
    case 'identity_recovery_requested':
    case 'owner_recovery_requested':
    case 'recovery_rejected':
    case 'recovery_expired':
    case 'recovery_cancelled':
      files.set(
        `recovery-requests/${event.aggregate_id}.json`,
        prettyCollaborationJson(
          projection.recoveryRequests[event.aggregate_id],
        ),
      );
      break;
    case 'recovery_approved': {
      const request = projection.recoveryRequests[event.aggregate_id];
      files.set(
        `recovery-requests/${event.aggregate_id}.json`,
        prettyCollaborationJson(request),
      );
      if (request) {
        files.set(
          `members/${request.target_principal_id}/clients/${request.requested_client.client_id}.json`,
          prettyCollaborationJson(request.requested_client),
        );
        for (const credential of Object.values(
          projection.credentials[request.target_principal_id] ?? {},
        ))
          files.set(
            `members/${request.target_principal_id}/credentials/${credential.credential_id}.json`,
            prettyCollaborationJson(credential),
          );
      }
      break;
    }
    case 'executor_registered': {
      const executor = event.payload.executor as { executor_id: string };
      files.set(
        `members/${event.aggregate_id}/executors/${executor.executor_id}.json`,
        prettyCollaborationJson(
          projection.executors[event.aggregate_id]?.[executor.executor_id],
        ),
      );
      break;
    }
    case 'executor_revoked':
      files.set(
        `members/${event.aggregate_id}/executors/${String(event.payload.executor_id)}.json`,
        prettyCollaborationJson(
          projection.executors[event.aggregate_id]?.[
            String(event.payload.executor_id)
          ],
        ),
      );
      break;
    case 'permission_granted':
    case 'permission_revoked':
      files.set(
        `permissions/${event.aggregate_id}.json`,
        prettyCollaborationJson(
          projection.permissionGrants[event.aggregate_id],
        ),
      );
      break;
    case 'progress_update_posted': {
      const update = event.payload.update as { update_id: string };
      files.set(
        `workspace/principals/${event.aggregate_id}/updates/${update.update_id}.json`,
        prettyCollaborationJson(projection.progressUpdates[update.update_id]),
      );
      break;
    }
    case 'shared_file_published':
    case 'shared_file_revised':
    case 'principal_file_published': {
      const metadata = fileMetadataSchema.parse(event.payload.metadata);
      files.set(
        `${fileDirectory(event, metadata)}/metadata.json`,
        prettyCollaborationJson(metadata),
      );
      break;
    }
    case 'action_published':
    case 'action_revised': {
      const action = event.payload.action as {
        action_id: string;
        owner_principal_id: string;
      };
      files.set(
        `workspace/principals/${action.owner_principal_id}/automations/actions/${action.action_id}.json`,
        prettyCollaborationJson(action),
      );
      break;
    }
    case 'work_item_created':
    case 'work_item_details_updated':
    case 'work_item_assignment_changed':
    case 'work_item_assignment_acknowledged':
    case 'work_item_assignment_declined':
    case 'work_item_status_changed':
    case 'work_item_relation_changed':
    case 'work_item_archived':
      files.set(
        `work-items/${event.aggregate_id}/item.json`,
        prettyCollaborationJson(projection.workItems[event.aggregate_id]),
      );
      break;
    case 'work_item_progress_posted': {
      const update = event.payload.update as { update_id: string };
      files.set(
        `work-items/${event.aggregate_id}/updates/${update.update_id}.json`,
        prettyCollaborationJson(
          projection.workItemUpdates[event.aggregate_id]?.find(
            (candidate) => candidate.update_id === update.update_id,
          ),
        ),
      );
      files.set(
        `work-items/${event.aggregate_id}/item.json`,
        prettyCollaborationJson(projection.workItems[event.aggregate_id]),
      );
      for (const artifact of eventArtifacts(event))
        files.set(
          `${artifactDirectory(artifact)}/metadata.json`,
          prettyCollaborationJson(artifact),
        );
      break;
    }
    case 'discussion_created': {
      files.set(
        `discussions/${event.aggregate_id}/thread.json`,
        prettyCollaborationJson(
          projection.discussions[event.aggregate_id]?.discussion,
        ),
      );
      const message = event.payload.message as
        | { message_id?: unknown }
        | undefined;
      if (typeof message?.message_id === 'string')
        files.set(
          `discussions/${event.aggregate_id}/messages/${message.message_id}.json`,
          prettyCollaborationJson(
            projection.discussions[event.aggregate_id]?.messages[
              message.message_id
            ],
          ),
        );
      break;
    }
    case 'discussion_resolved':
    case 'discussion_reopened':
      files.set(
        `discussions/${event.aggregate_id}/thread.json`,
        prettyCollaborationJson(
          projection.discussions[event.aggregate_id]?.discussion,
        ),
      );
      break;
    case 'message_posted':
    case 'message_revised': {
      const message = event.payload.message as { message_id: string };
      files.set(
        `discussions/${event.aggregate_id}/messages/${message.message_id}.json`,
        prettyCollaborationJson(
          projection.discussions[event.aggregate_id]?.messages[
            message.message_id
          ],
        ),
      );
      files.set(
        `discussions/${event.aggregate_id}/thread.json`,
        prettyCollaborationJson(
          projection.discussions[event.aggregate_id]?.discussion,
        ),
      );
      break;
    }
    case 'message_tombstoned': {
      const messageId = String(event.payload.message_id);
      files.set(
        `discussions/${event.aggregate_id}/messages/${messageId}.json`,
        prettyCollaborationJson(
          projection.discussions[event.aggregate_id]?.messages[messageId],
        ),
      );
      files.set(
        `discussions/${event.aggregate_id}/thread.json`,
        prettyCollaborationJson(
          projection.discussions[event.aggregate_id]?.discussion,
        ),
      );
      break;
    }
    case 'workflow_definition_proposed':
    case 'workflow_definition_published':
    case 'workflow_definition_retired':
    case 'workflow_layout_updated': {
      const version =
        event.event_type === 'workflow_layout_updated'
          ? Number(event.payload.version)
          : (projection.latestWorkflowDefinitionVersions[event.aggregate_id] ??
            0);
      const value =
        projection.workflowDefinitions[
          workflowDefinitionVersionKey(event.aggregate_id, version)
        ];
      if (!value)
        throw new Error('Workflow Definition materialization missing');
      const root = `workflows/definitions/${event.aggregate_id}`;
      files.set(
        `${root}/workflow.json`,
        prettyCollaborationJson(value.definition),
      );
      files.set(`${root}/machine.json`, prettyCollaborationJson(value.machine));
      files.set(`${root}/layout.json`, prettyCollaborationJson(value.layout));
      break;
    }
    case 'workflow_instance_created':
    case 'workflow_instance_started':
    case 'workflow_instance_paused':
    case 'workflow_instance_resumed':
    case 'workflow_instance_closed':
    case 'workflow_state_assignee_changed':
      files.set(
        `workflows/instances/${event.aggregate_id}/instance.json`,
        prettyCollaborationJson(
          projection.workflowInstances[event.aggregate_id],
        ),
      );
      {
        const instance = projection.workflowInstances[event.aggregate_id];
        if (instance?.scope.type !== 'work_item') break;
        const workItemId = instance.scope.work_item_id;
        files.set(
          `work-items/${workItemId}/item.json`,
          prettyCollaborationJson(projection.workItems[workItemId]),
        );
      }
      break;
    case 'state_execution_published':
    case 'state_execution_revised': {
      const execution = event.payload.execution as { state_id: string };
      files.set(
        `workflows/instances/${event.aggregate_id}/execution/${execution.state_id}.json`,
        prettyCollaborationJson(
          projection.stateExecutions[event.aggregate_id]?.[execution.state_id],
        ),
      );
      files.set(
        `workflows/instances/${event.aggregate_id}/instance.json`,
        prettyCollaborationJson(
          projection.workflowInstances[event.aggregate_id],
        ),
      );
      {
        const instance = projection.workflowInstances[event.aggregate_id];
        if (instance?.scope.type !== 'work_item') break;
        const workItemId = instance.scope.work_item_id;
        files.set(
          `work-items/${workItemId}/item.json`,
          prettyCollaborationJson(projection.workItems[workItemId]),
        );
      }
      break;
    }
    case 'state_execution_withdrawn':
      files.set(
        `workflows/instances/${event.aggregate_id}/execution/${String(event.payload.state_id)}.json`,
        null,
      );
      files.set(
        `workflows/instances/${event.aggregate_id}/instance.json`,
        prettyCollaborationJson(
          projection.workflowInstances[event.aggregate_id],
        ),
      );
      break;
    case 'turn_created':
    case 'turn_started':
    case 'action_dispatched':
    case 'action_waiting_input':
    case 'action_waiting_approval':
    case 'action_completed':
    case 'turn_timeout_observed':
    case 'turn_completed':
    case 'turn_cancelled':
    case 'turn_recovery_requested':
    case 'turn_recovered': {
      const turnId =
        event.event_type === 'turn_created'
          ? String((event.payload.turn as { turn_id: string }).turn_id)
          : String(event.payload.turn_id);
      files.set(
        `workflows/instances/${event.aggregate_id}/turns/${turnId}.json`,
        prettyCollaborationJson(projection.turns[turnId]),
      );
      files.set(
        `workflows/instances/${event.aggregate_id}/instance.json`,
        prettyCollaborationJson(
          projection.workflowInstances[event.aggregate_id],
        ),
      );
      if (event.event_type === 'turn_completed')
        for (const artifact of eventArtifacts(event))
          files.set(
            `${artifactDirectory(artifact)}/metadata.json`,
            prettyCollaborationJson(artifact),
          );
      {
        const instance = projection.workflowInstances[event.aggregate_id];
        if (instance?.scope.type !== 'work_item') break;
        const workItemId = instance.scope.work_item_id;
        files.set(
          `work-items/${workItemId}/item.json`,
          prettyCollaborationJson(projection.workItems[workItemId]),
        );
      }
      break;
    }
  }
  return files;
}

function allowedExtraMaterializationPaths(
  event: CollaborationEventV3,
): Set<string> {
  const allowed = new Set<string>();
  if (
    event.event_type === 'shared_file_published' ||
    event.event_type === 'shared_file_revised' ||
    event.event_type === 'principal_file_published'
  ) {
    const metadata = fileMetadataSchema.parse(event.payload.metadata);
    if (metadata.content_ref)
      allowed.add(`${fileDirectory(event, metadata)}/${metadata.content_ref}`);
  }
  if (
    event.event_type === 'action_published' ||
    event.event_type === 'action_revised'
  ) {
    const action = event.payload.action as { prompt_ref: string };
    allowed.add(action.prompt_ref);
  }
  for (const artifact of eventArtifacts(event))
    allowed.add(`${artifactDirectory(artifact)}/${artifact.content_ref}`);
  return allowed;
}

function mergeMaterializations(
  event: CollaborationEventV3,
  projection: CollaborationProjectionV3,
  extra: readonly CollaborationProjectSpaceMaterializedFile[],
): Map<string, string | Buffer | null> {
  const files = automaticMaterialization(event, projection);
  const allowedExtra = allowedExtraMaterializationPaths(event);
  for (const file of extra) {
    const safePath = normalizedRepositoryPath(file.path);
    if (!allowedExtra.has(safePath))
      throw new Error(
        `${event.event_type} cannot materialize unowned path ${safePath}`,
      );
    if (files.has(safePath))
      throw new Error(`Materialized path is duplicated: ${safePath}`);
    files.set(safePath, file.contents);
  }
  for (const required of allowedExtra)
    if (!files.has(required))
      throw new Error(
        `${event.event_type} requires materialized content at ${required}`,
      );
  validateContentFiles(event, files);
  return files;
}

function sha256(contents: Buffer | string): string {
  return `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`;
}

function validateContentFiles(
  event: CollaborationEventV3,
  files: ReadonlyMap<string, string | Buffer | null>,
): void {
  if (
    event.event_type === 'shared_file_published' ||
    event.event_type === 'shared_file_revised' ||
    event.event_type === 'principal_file_published'
  ) {
    const metadata = fileMetadataSchema.parse(event.payload.metadata);
    if (!metadata.content_ref) return;
    const content = files.get(
      `${fileDirectory(event, metadata)}/${metadata.content_ref}`,
    );
    if (content == null) throw new Error('File content is missing');
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    if (bytes.byteLength !== metadata.size || sha256(bytes) !== metadata.sha256)
      throw new Error('Business file content does not match its JSON sidecar');
  }
  if (
    event.event_type === 'action_published' ||
    event.event_type === 'action_revised'
  ) {
    const action = event.payload.action as {
      prompt_ref: string;
      prompt_hash: string;
    };
    const prompt = files.get(action.prompt_ref);
    if (typeof prompt !== 'string' && !Buffer.isBuffer(prompt))
      throw new Error('Action Prompt Markdown is missing');
    if (sha256(prompt) !== action.prompt_hash)
      throw new Error('Action Prompt content hash does not match Action JSON');
  }
  for (const artifact of eventArtifacts(event)) {
    const content = files.get(
      `${artifactDirectory(artifact)}/${artifact.content_ref}`,
    );
    if (content == null) throw new Error('Artifact content is missing');
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256)
      throw new Error('Artifact content does not match its JSON sidecar');
  }
}

async function changedFilesForCommit(
  repositoryPath: string,
  commit: string,
  root: boolean,
): Promise<Array<{ readonly status: string; readonly file: string }>> {
  const output = await git(repositoryPath, [
    'diff-tree',
    ...(root ? ['--root'] : []),
    '--no-commit-id',
    '--name-status',
    '-r',
    commit,
  ]);
  return output.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...parts] = line.split('\t');
      return { status: status ?? '', file: parts.at(-1) ?? '' };
    });
}

function eventFileFromChanges(
  commit: string,
  changes: readonly { readonly status: string; readonly file: string }[],
): string {
  const eventFiles = changes.filter(
    (change) =>
      change.status === 'A' &&
      change.file.startsWith('events/') &&
      change.file.endsWith('.json'),
  );
  if (eventFiles.length !== 1)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Commit ${commit} must append exactly one v3 event`,
    );
  if (
    changes.some(
      (change) =>
        change.file.startsWith('events/') &&
        change.file !== eventFiles[0]!.file,
    )
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Commit ${commit} modifies existing or multiple event files`,
    );
  return eventFiles[0]!.file;
}

function candidateCredential(
  event: CollaborationEventV3,
  projection: CollaborationProjectionV3 | null,
): CredentialDefinition | null {
  if (event.event_type === 'group_initialized')
    return credentialDefinitionSchema.parse(event.payload.credential);
  if (
    event.event_type === 'membership_requested' ||
    (event.event_type === 'member_registered' &&
      event.actor.principal_id ===
        (event.payload.member as { principal_id?: unknown }).principal_id) ||
    event.event_type === 'identity_recovery_requested' ||
    event.event_type === 'owner_recovery_requested'
  )
    return credentialDefinitionSchema.parse(
      event.event_type.endsWith('_recovery_requested')
        ? recoveryRequestSchema.parse(event.payload.request)
            .requested_credential
        : event.payload.credential,
    );
  if (event.event_type === 'recovery_cancelled')
    return (
      projection?.recoveryRequests[event.aggregate_id]?.requested_credential ??
      null
    );
  return (
    projection?.credentials[event.actor.principal_id]?.[
      event.actor.credential_id
    ] ?? null
  );
}

async function verifyCommitSigner(
  repositoryPath: string,
  commit: string,
  event: CollaborationEventV3,
  projection: CollaborationProjectionV3 | null,
): Promise<void> {
  const candidate = candidateCredential(event, projection);
  if (
    !candidate ||
    candidate.status !== 'active' ||
    candidate.credential_id !== event.actor.credential_id ||
    candidate.principal_id !== event.actor.principal_id ||
    candidate.client_id !== event.actor.client_id
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `No active Credential matches event actor at ${commit}`,
    );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'icarus-v3-signers-'));
  const allowedSignersPath = path.join(directory, 'allowed_signers');
  try {
    await writeFile(
      allowedSignersPath,
      `${candidate.principal_id} ${candidate.public_key}\n`,
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
      true,
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
    if (
      status !== 'G' ||
      principalId !== event.actor.principal_id ||
      !fingerprint
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Git signer does not match event actor at ${commit}`,
      );
    if (
      candidate.principal_id !== principalId ||
      candidate.fingerprint !== fingerprint
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Git signature fingerprint does not match Credential ${candidate.credential_id}`,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertSafeTree(
  repositoryPath: string,
  head: string,
): Promise<void> {
  const tree = await git(repositoryPath, ['ls-tree', '-r', head]);
  const allowedRoots = [
    'group.json',
    'invites/',
    'members/',
    'recovery-requests/',
    'permissions/',
    'workspace/',
    'work-items/',
    'discussions/',
    'workflows/',
    'artifacts/',
    'events/',
    'projections/',
  ];
  for (const row of tree.stdout.split('\n').filter(Boolean)) {
    const match = /^(\d+)\s+blob\s+[0-9a-f]+\t(.+)$/u.exec(row);
    if (!match || (match[1] !== '100644' && match[1] !== '100755'))
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Collaboration tree contains a non-regular entry: ${row}`,
      );
    const file = match[2]!;
    normalizedRepositoryPath(file);
    if (!allowedRoots.some((root) => file === root || file.startsWith(root)))
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Unexpected file in collaboration control tree: ${file}`,
      );
    if (
      !file.startsWith('workspace/') &&
      !file.startsWith('artifacts/') &&
      !file.endsWith('.json') &&
      !file.endsWith('.md')
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Structured collaboration files must be JSON: ${file}`,
      );
  }
}

async function assertLinearHistory(
  repositoryPath: string,
  head: string,
): Promise<string[]> {
  const rows = (
    await git(repositoryPath, [
      'rev-list',
      '--reverse',
      '--topo-order',
      '--parents',
      head,
    ])
  ).stdout
    .split('\n')
    .filter(Boolean);
  const commits = rows.map((row) => row.split(' ')[0]!);
  for (const [index, row] of rows.entries()) {
    const [, ...parents] = row.split(' ');
    const expected = index === 0 ? [] : [commits[index - 1]!];
    if (
      parents.length !== expected.length ||
      parents.some((parent, parentIndex) => parent !== expected[parentIndex])
    )
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Collaboration history is not linear at ${commits[index]}`,
      );
  }
  if (commits.length === 0)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Collaboration control branch is empty',
    );
  return commits;
}

async function verifyMaterializedCommit(
  repositoryPath: string,
  commit: string,
  eventFile: string,
  event: CollaborationEventV3,
  projection: CollaborationProjectionV3,
  changes: readonly { readonly status: string; readonly file: string }[],
): Promise<void> {
  const automatic = automaticMaterialization(event, projection);
  const allowedExtra = allowedExtraMaterializationPaths(event);
  const changed = new Set(changes.map((change) => change.file));
  const allowed = new Set([eventFile, ...automatic.keys(), ...allowedExtra]);
  const required = [eventFile, ...allowedExtra];
  if (
    required.some((file) => !changed.has(file)) ||
    [...changed].some((file) => !allowed.has(file))
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      `Event ${event.event_id} changed unauthorized materialized paths`,
    );
  for (const [file, contents] of automatic) {
    const status = changes.find((change) => change.file === file)?.status;
    if (contents === null) {
      if (status !== 'D')
        throw new CollaborationProtocolError(
          'PROTOCOL_QUARANTINED',
          `Event ${event.event_id} must delete ${file}`,
        );
      continue;
    }
    const actual = await showBytes(repositoryPath, commit, file);
    const expectedBytes =
      typeof contents === 'string' ? Buffer.from(contents) : contents;
    if (!actual.equals(expectedBytes))
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Materialized JSON does not match replay at ${file}`,
      );
  }
  const contentFiles = new Map<string, string | Buffer | null>(automatic);
  for (const file of allowedExtra)
    contentFiles.set(file, await showBytes(repositoryPath, commit, file));
  try {
    validateContentFiles(event, contentFiles);
  } catch (error) {
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function validateCollaborationProjectSpaceHistory(input: {
  readonly repositoryPath: string;
  readonly head: string;
  readonly previousHead?: string | null;
}): Promise<ValidatedProjectSpaceHistory> {
  if (input.previousHead && input.previousHead !== input.head) {
    const ancestry = await git(
      input.repositoryPath,
      ['merge-base', '--is-ancestor', input.previousHead, input.head],
      true,
    );
    if (ancestry.exitCode !== 0)
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        'The remote collaboration control history was rewritten',
      );
  }
  await assertSafeTree(input.repositoryPath, input.head);
  const commits = await assertLinearHistory(input.repositoryPath, input.head);
  let projection: CollaborationProjectionV3 | null = null;
  const eventRecords: Array<{
    event: CollaborationEventV3;
    commitHash: string;
    commitOrder: number;
  }> = [];
  for (const [index, commit] of commits.entries()) {
    const changes = await changedFilesForCommit(
      input.repositoryPath,
      commit,
      index === 0,
    );
    const eventFile = eventFileFromChanges(commit, changes);
    const event = validateCollaborationEventV3(
      await showJson(input.repositoryPath, commit, eventFile),
    );
    if (eventFile !== collaborationProjectSpaceEventPath(event))
      throw new CollaborationProtocolError(
        'PROTOCOL_QUARANTINED',
        `Event path does not match Aggregate revision and id: ${eventFile}`,
      );
    await verifyCommitSigner(input.repositoryPath, commit, event, projection);
    projection = reduceCollaborationEventV3(projection, event);
    await verifyMaterializedCommit(
      input.repositoryPath,
      commit,
      eventFile,
      event,
      projection,
      changes,
    );
    eventRecords.push({
      event,
      commitHash: commit,
      commitOrder: index + 1,
    });
  }
  if (!projection)
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Collaboration projection could not be constructed',
    );
  const group = await showJson(input.repositoryPath, input.head, 'group.json');
  if (
    prettyCollaborationJson(group) !== prettyCollaborationJson(projection.group)
  )
    throw new CollaborationProtocolError(
      'PROTOCOL_QUARANTINED',
      'Materialized group.json does not match verified replay',
    );
  return { head: input.head, projection, eventRecords };
}

export interface CollaborationVirtualTreeNode {
  readonly id: string;
  readonly name: string;
  readonly type: 'directory' | 'file' | 'structured';
  readonly repositoryPath: string | null;
  readonly rawId: string | null;
  readonly children?: readonly CollaborationVirtualTreeNode[];
}

function principalDisplayName(
  projection: CollaborationProjectionV3,
  principalId: string,
): string {
  const display = projection.members[principalId]?.display_name ?? principalId;
  return `${display} · ${principalId.slice(-4)}`;
}

export function buildCollaborationVirtualTree(
  projection: CollaborationProjectionV3,
): readonly CollaborationVirtualTreeNode[] {
  const sharedFiles = Object.values(projection.files).filter(
    (metadata) =>
      projection.fileLocations[metadata.file_id]?.scope === 'shared',
  );
  const memberNodes = Object.values(projection.members)
    .sort((left, right) =>
      principalDisplayName(projection, left.principal_id).localeCompare(
        principalDisplayName(projection, right.principal_id),
      ),
    )
    .map((member) => {
      const principalFiles = Object.values(projection.files).filter(
        (metadata) =>
          metadata.uploader_principal_id === member.principal_id &&
          projection.fileLocations[metadata.file_id]?.scope === 'principal',
      );
      return {
        id: `principal:${member.principal_id}`,
        name: principalDisplayName(projection, member.principal_id),
        type: 'directory' as const,
        repositoryPath: `workspace/principals/${member.principal_id}`,
        rawId: member.principal_id,
        children: [
          {
            id: `principal:${member.principal_id}:updates`,
            name: 'Progress updates',
            type: 'structured' as const,
            repositoryPath: `workspace/principals/${member.principal_id}/updates`,
            rawId: member.principal_id,
          },
          ...principalFiles.map((metadata) => ({
            id: `file:${metadata.file_id}`,
            name: metadata.original_filename,
            type: 'file' as const,
            repositoryPath: metadata.content_ref
              ? `${projection.fileLocations[metadata.file_id]?.repositoryDirectory}/${metadata.content_ref}`
              : null,
            rawId: metadata.file_id,
          })),
          {
            id: `principal:${member.principal_id}:automations`,
            name: 'Automations',
            type: 'structured' as const,
            repositoryPath: `workspace/principals/${member.principal_id}/automations`,
            rawId: member.principal_id,
          },
        ],
      };
    });
  return [
    {
      id: 'shared',
      name: 'Shared space',
      type: 'directory',
      repositoryPath: 'workspace/shared',
      rawId: null,
      children: sharedFiles.map((metadata) => ({
        id: `file:${metadata.file_id}`,
        name: metadata.original_filename,
        type: 'file',
        repositoryPath: metadata.content_ref
          ? `${projection.fileLocations[metadata.file_id]?.repositoryDirectory}/${metadata.content_ref}`
          : null,
        rawId: metadata.file_id,
      })),
    },
    {
      id: 'members',
      name: 'Member spaces',
      type: 'directory',
      repositoryPath: 'workspace/principals',
      rawId: null,
      children: memberNodes,
    },
    {
      id: 'work-items',
      name: 'Work Items',
      type: 'structured',
      repositoryPath: 'work-items',
      rawId: null,
      children: Object.values(projection.workItems).map((item) => ({
        id: `work-item:${item.work_item_id}`,
        name: `${item.work_item_id} ${item.title}`,
        type: 'structured',
        repositoryPath: `work-items/${item.work_item_id}/item.json`,
        rawId: item.work_item_id,
      })),
    },
    {
      id: 'discussions',
      name: 'Discussions',
      type: 'structured',
      repositoryPath: 'discussions',
      rawId: null,
    },
    {
      id: 'workflows',
      name: 'Workflows',
      type: 'structured',
      repositoryPath: 'workflows',
      rawId: null,
    },
    {
      id: 'audit',
      name: 'Audit records',
      type: 'structured',
      repositoryPath: 'events',
      rawId: null,
    },
  ];
}

export class CollaborationProjectSpaceGitTransport implements CollaborationProjectSpaceTransport {
  constructor(private readonly gitBinary = 'git') {}

  async inspect(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly previousHead?: string | null;
    readonly gitSshKeyPath?: string;
    readonly gitSshKeyPaths?: readonly string[];
  }): Promise<ValidatedProjectSpaceHistory> {
    const candidates = normalizedGitSshKeyCandidates(input);
    const clonedWith = await this.ensureBareCache(
      input.remoteUrl,
      input.repositoryPath,
      candidates,
    );
    const fetch = await executeWithGitSshCandidates(
      input.repositoryPath,
      this.gitBinary,
      [
        'fetch',
        '--no-tags',
        'origin',
        `+${COLLABORATION_CONTROL_BRANCH}:${CONTROL_REMOTE_REF}`,
      ],
      clonedWith ? [clonedWith] : candidates,
    );
    if (fetch.exitCode !== 0)
      throw new Error(`Collaboration fetch failed: ${fetch.stderr.trim()}`);
    const head = (
      await execute(input.repositoryPath, this.gitBinary, [
        'rev-parse',
        CONTROL_REMOTE_REF,
      ])
    ).stdout.trim();
    let history: ValidatedProjectSpaceHistory;
    try {
      history = await validateCollaborationProjectSpaceHistory({
        repositoryPath: input.repositoryPath,
        head,
        previousHead: input.previousHead,
      });
    } catch (error) {
      if (
        input.previousHead &&
        error instanceof CollaborationProtocolError &&
        /history was rewritten/iu.test(error.message)
      ) {
        const replacement = await validateCollaborationProjectSpaceHistory({
          repositoryPath: input.repositoryPath,
          head,
        }).catch(() => null);
        throw new CollaborationProjectSpaceHistoryRewrittenError(
          replacement
            ? `The remote control history now belongs to Group ${replacement.projection.groupId}; the old identity was not migrated and must observe or join the new Group`
            : 'The remote collaboration control history was rewritten; the old identity was not migrated',
          replacement?.projection.groupId ?? null,
        );
      }
      throw error;
    }
    return {
      ...history,
      transportGitSshKeyPath: fetch.gitSshKeyPath,
    };
  }

  async reinitialize(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath: string;
    readonly identity: CollaborationEventSigningIdentity;
    readonly genesisEvent: CollaborationEventV3;
    readonly genesisProjection: CollaborationProjectionV3;
  }): Promise<ValidatedProjectSpaceHistory> {
    const checkoutPath = await this.temporaryCheckout('initialize');
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
      this.materialize(
        checkoutPath,
        input.genesisEvent,
        input.genesisProjection,
        [],
      );
      await this.commit(checkoutPath, input.genesisEvent);
      const head = (
        await execute(checkoutPath, this.gitBinary, ['rev-parse', 'HEAD'])
      ).stdout.trim();
      const history = await validateCollaborationProjectSpaceHistory({
        repositoryPath: checkoutPath,
        head,
      });
      const push = await execute(
        checkoutPath,
        this.gitBinary,
        ['push', 'origin', `+HEAD:${COLLABORATION_CONTROL_BRANCH}`],
        true,
        input.gitSshKeyPath,
      );
      if (push.exitCode !== 0)
        throw new Error(
          `Collaboration initialization force push was rejected by the Git server: ${push.stderr.trim()}`,
        );
      return {
        ...history,
        transportGitSshKeyPath: input.gitSshKeyPath,
      };
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
  }

  async refreshAfterReinitialize(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath: string;
  }): Promise<ValidatedProjectSpaceHistory> {
    const history = await this.inspect({
      ...input,
      previousHead: null,
    });
    await execute(input.repositoryPath, this.gitBinary, [
      'update-ref',
      COLLABORATION_CONTROL_BRANCH,
      history.head,
    ]);
    await execute(input.repositoryPath, this.gitBinary, [
      'reflog',
      'expire',
      '--expire=now',
      '--all',
    ]);
    await execute(input.repositoryPath, this.gitBinary, ['gc', '--prune=now']);
    return history;
  }

  async create(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly gitSshKeyPath?: string;
    readonly gitSshKeyPaths?: readonly string[];
    readonly identity: CollaborationEventSigningIdentity;
    readonly genesisEvent: CollaborationEventV3;
    readonly genesisProjection: CollaborationProjectionV3;
  }): Promise<ValidatedProjectSpaceHistory> {
    const candidates = normalizedGitSshKeyCandidates(input);
    const remoteHead = await executeWithGitSshCandidates(
      process.cwd(),
      this.gitBinary,
      ['ls-remote', '--heads', input.remoteUrl, COLLABORATION_CONTROL_BRANCH],
      candidates,
    );
    if (remoteHead.exitCode !== 0)
      throw new Error(
        `Collaboration remote cannot be read: ${remoteHead.stderr.trim()}`,
      );
    if (remoteHead.stdout.trim())
      throw new Error('Collaboration control branch already exists');
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
      this.materialize(
        checkoutPath,
        input.genesisEvent,
        input.genesisProjection,
        [],
      );
      await this.commit(checkoutPath, input.genesisEvent);
      const push = await execute(
        checkoutPath,
        this.gitBinary,
        ['push', 'origin', `HEAD:${COLLABORATION_CONTROL_BRANCH}`],
        true,
        remoteHead.gitSshKeyPath,
      );
      if (push.exitCode !== 0)
        throw new CollaborationProjectSpaceGitConflictError(
          `Genesis push lost its CAS race: ${push.stderr.trim()}`,
        );
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
    await this.cloneBare(input.remoteUrl, input.repositoryPath, [
      remoteHead.gitSshKeyPath,
    ]);
    return this.inspect({
      remoteUrl: input.remoteUrl,
      repositoryPath: input.repositoryPath,
      previousHead: null,
      gitSshKeyPaths: [remoteHead.gitSshKeyPath],
    });
  }

  async append(input: {
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly previousHead: string | null;
    readonly gitSshKeyPath?: string;
    readonly gitSshKeyPaths?: readonly string[];
    readonly identity: CollaborationEventSigningIdentity;
    readonly buildEvent: (history: ValidatedProjectSpaceHistory) =>
      | CollaborationEventV3
      | {
          readonly event: CollaborationEventV3;
          readonly materializedFiles: readonly CollaborationProjectSpaceMaterializedFile[];
        };
  }): Promise<ValidatedProjectSpaceHistory> {
    const candidates = normalizedGitSshKeyCandidates(input);
    const history = await this.inspect({
      ...input,
      gitSshKeyPaths: candidates,
    });
    const gitSshKeyPath = history.transportGitSshKeyPath ?? candidates[0]!;
    const built = input.buildEvent(history);
    const event = 'event' in built ? built.event : built;
    const extra = 'event' in built ? built.materializedFiles : [];
    if (
      input.identity.principalId !== event.actor.principal_id ||
      input.identity.clientId !== event.actor.client_id ||
      input.identity.credentialId !== event.actor.credential_id
    )
      throw new Error('Local signing identity does not match event actor');
    const projection = reduceCollaborationEventV3(history.projection, event);
    mergeMaterializations(event, projection, extra);
    const checkoutPath = await this.temporaryCheckout('append');
    try {
      await execute(checkoutPath, this.gitBinary, ['init', '-q']);
      await execute(checkoutPath, this.gitBinary, [
        'remote',
        'add',
        'origin',
        input.remoteUrl,
      ]);
      await execute(
        checkoutPath,
        this.gitBinary,
        ['fetch', '-q', '--no-tags', 'origin', history.head],
        false,
        gitSshKeyPath,
      );
      await execute(checkoutPath, this.gitBinary, [
        'checkout',
        '-q',
        '--detach',
        'FETCH_HEAD',
      ]);
      await this.configureSigner(checkoutPath, input.identity);
      this.materialize(checkoutPath, event, projection, extra);
      await this.commit(checkoutPath, event);
      const push = await execute(
        checkoutPath,
        this.gitBinary,
        ['push', 'origin', `HEAD:${COLLABORATION_CONTROL_BRANCH}`],
        true,
        gitSshKeyPath,
      );
      if (push.exitCode !== 0) {
        if (/non-fast-forward|fetch first|rejected/iu.test(push.stderr))
          throw new CollaborationProjectSpaceGitConflictError(
            'Collaboration event lost the remote fast-forward race',
          );
        throw new Error(`Collaboration push failed: ${push.stderr.trim()}`);
      }
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
    return this.inspect({
      remoteUrl: input.remoteUrl,
      repositoryPath: input.repositoryPath,
      previousHead: history.head,
      gitSshKeyPath,
    });
  }

  async readVerifiedFile(input: {
    readonly repositoryPath: string;
    readonly verifiedHead: string;
    readonly repositoryFile: string;
  }): Promise<Buffer> {
    return showBytes(
      input.repositoryPath,
      input.verifiedHead,
      normalizedRepositoryPath(input.repositoryFile),
    );
  }

  private materialize(
    checkoutPath: string,
    event: CollaborationEventV3,
    projection: CollaborationProjectionV3,
    extra: readonly CollaborationProjectSpaceMaterializedFile[],
  ): void {
    const files = mergeMaterializations(event, projection, extra);
    writeRepositoryFile(
      checkoutPath,
      collaborationProjectSpaceEventPath(event),
      prettyCollaborationJson(event),
    );
    for (const [file, contents] of files)
      if (contents === null) deleteRepositoryFile(checkoutPath, file);
      else writeRepositoryFile(checkoutPath, file, contents);
  }

  private async configureSigner(
    checkoutPath: string,
    identity: CollaborationEventSigningIdentity,
  ): Promise<void> {
    for (const args of [
      ['config', 'user.name', identity.principalId],
      ['config', 'user.email', `${identity.principalId}@icarus.local`],
      ['config', 'gpg.format', 'ssh'],
      ['config', 'user.signingkey', identity.privateKeyPath],
      ['config', 'commit.gpgsign', 'true'],
    ] as const)
      await execute(checkoutPath, this.gitBinary, args);
  }

  private async commit(
    checkoutPath: string,
    event: CollaborationEventV3,
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

  private async temporaryCheckout(purpose: string): Promise<string> {
    return mkdtemp(
      path.join(
        os.tmpdir(),
        `icarus-collaboration-v3-${purpose}-${crypto.randomUUID()}-`,
      ),
    );
  }

  private async cloneBare(
    remoteUrl: string,
    repositoryPath: string,
    gitSshKeyPaths: readonly string[],
  ): Promise<string> {
    if (existsSync(repositoryPath))
      throw new Error(`Collaboration cache already exists: ${repositoryPath}`);
    mkdirSync(path.dirname(repositoryPath), { recursive: true });
    const result = await executeWithGitSshCandidates(
      path.dirname(repositoryPath),
      this.gitBinary,
      ['clone', '-q', '--bare', remoteUrl, repositoryPath],
      gitSshKeyPaths,
    );
    if (result.exitCode !== 0)
      throw new Error(`Collaboration clone failed: ${result.stderr.trim()}`);
    return result.gitSshKeyPath;
  }

  private async ensureBareCache(
    remoteUrl: string,
    repositoryPath: string,
    gitSshKeyPaths: readonly string[],
  ): Promise<string | null> {
    if (!existsSync(repositoryPath)) {
      return this.cloneBare(remoteUrl, repositoryPath, gitSshKeyPaths);
    }
    const bare = await execute(
      repositoryPath,
      this.gitBinary,
      ['rev-parse', '--is-bare-repository'],
      true,
    );
    if (bare.exitCode !== 0 || bare.stdout.trim() !== 'true')
      throw new Error('Collaboration cache is not a bare Git repository');
    const configured = (
      await execute(repositoryPath, this.gitBinary, [
        'remote',
        'get-url',
        'origin',
      ])
    ).stdout.trim();
    if (configured !== remoteUrl)
      throw new Error('Collaboration cache remote URL does not match binding');
    return null;
  }
}

export const collaborationProjectSpaceGitTestables = {
  automaticMaterialization,
  allowedExtraMaterializationPaths,
  mergeMaterializations,
  validateContentFiles,
  collaborationEventHashV3,
  deterministicProjectionJsonV3,
};
