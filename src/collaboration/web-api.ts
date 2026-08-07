import http from 'node:http';
import path from 'node:path';

import { z } from 'zod';

import { buildCollaborationAuditV3 } from './audit.js';
import type {
  CollaborationActionExecutionV3,
  CollaborationExecutorBindingV3,
} from './project-space-store.js';
import type { CollaborationRuntime } from './runtime.js';
import { strictParseJson } from './protocol/canonical-json.js';
import {
  collaborationPermissionSchema,
  machineDefinitionV3Schema,
  workflowLayoutSchema,
  workItemStatusSchema,
} from './protocol/v3-schema.js';

const API_PREFIX = '/api/collaboration';
const MAX_BODY_BYTES = 14 * 1024 * 1024;

const identifier = z.string().min(1).max(160);
const expectedRevision = z.number().int().nonnegative();
const identityOverrideFields = new Set([
  'actorPrincipalId',
  'actorClientId',
  'actor_principal_id',
  'actor_client_id',
  'localPrincipalId',
  'localClientId',
  'repositoryPath',
]);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function redactRemoteUrl(input: string): string {
  try {
    const parsed = new URL(input);
    parsed.username = parsed.username ? 'redacted' : '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()])
      if (/token|secret|password|credential|authorization|api.?key/iu.test(key))
        parsed.searchParams.set(key, 'redacted');
    return parsed.toString();
  } catch {
    return input;
  }
}

function redactDiagnostic(input: string | null): string | null {
  if (!input) return input;
  return input
    .replace(/https?:\/\/[^\s]+/giu, (value) => redactRemoteUrl(value))
    .replace(
      /([?&](?:[^=&]*(?:token|secret|password|credential|authorization|api.?key)[^=&]*)=)[^&\s]+/giu,
      '$1redacted',
    );
}

function redactLocalSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLocalSecrets);
  if (!value || typeof value !== 'object')
    return typeof value === 'string' ? redactDiagnostic(value) : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|secret|password|credential|authorization|private.?key|api.?key/iu.test(
        key,
      )
        ? 'redacted'
        : redactLocalSecrets(item),
    ]),
  );
}

function publicBinding(binding: CollaborationExecutorBindingV3) {
  return {
    groupId: binding.groupId,
    instanceId: binding.instanceId,
    stateId: binding.stateId,
    principalId: binding.principalId,
    clientId: binding.clientId,
    actionHash: binding.actionHash,
    promptHash: binding.promptHash,
    executorId: binding.executorId,
    executorKind: binding.executorKind,
    filesystemAccess: binding.filesystemAccess,
    approvalPolicy: binding.approvalPolicy,
    config: redactLocalSecrets(binding.config),
    enabled: binding.enabled,
    updatedAtMs: binding.updatedAtMs,
  };
}

function publicExecution(execution: CollaborationActionExecutionV3) {
  return {
    executionId: execution.executionId,
    groupId: execution.groupId,
    instanceId: execution.instanceId,
    turnId: execution.turnId,
    epoch: execution.epoch,
    attempt: execution.attempt,
    claimantClientId: execution.claimantClientId,
    operationKey: execution.operationKey,
    executorId: execution.executorId,
    executorKind: execution.executorKind,
    state: execution.state,
    recoveryRequiredReason: redactDiagnostic(execution.recoveryRequiredReason),
    dispatchStartedAtMs: execution.dispatchStartedAtMs,
    receiptRecordedAtMs: execution.receiptRecordedAtMs,
    providerCompletedAtMs: execution.providerCompletedAtMs,
    updatedAtMs: execution.updatedAtMs,
  };
}

function publicGroup(
  group: ReturnType<CollaborationRuntime['store']['getGroup']>,
) {
  if (!group) return null;
  return {
    groupId: group.groupId,
    name: group.name,
    lifecycle: group.lifecycle,
    ownerPrincipalId: group.ownerPrincipalId,
    subscriptionMode: group.subscriptionMode,
    localPrincipalId: group.localPrincipalId,
    localClientId: group.localClientId,
    remoteUrl: redactRemoteUrl(group.remoteUrl),
    protocolStatus: group.protocolStatus,
    protocolError: redactDiagnostic(group.protocolError),
    pollIntervalMs: group.pollIntervalMs,
    nextSyncAtMs: group.nextSyncAtMs,
    lastVerifiedHead: group.lastVerifiedHead,
    lastSyncAtMs: group.lastSyncAtMs,
    lastError: redactDiagnostic(group.lastError),
    backoffAttempt: group.backoffAttempt,
    projection: group.projection,
  };
}

async function requestBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function jsonBody<T extends z.ZodType>(
  req: http.IncomingMessage,
  schema: T,
): Promise<z.infer<T>> {
  const value = strictParseJson(
    (await requestBuffer(req)).toString('utf8') || '{}',
  );
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const override = Object.keys(value).find((key) =>
      identityOverrideFields.has(key),
    );
    if (override)
      throw new Error(`${override} is Host-derived and must not be provided`);
  }
  return schema.parse(value);
}

function multipartBoundary(req: http.IncomingMessage): string {
  const contentType = req.headers['content-type'] ?? '';
  const match = contentType.match(
    /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu,
  );
  const value = match?.[1] ?? match?.[2];
  if (!value) throw new Error('multipart/form-data boundary is required');
  return value;
}

async function multipartFile(req: http.IncomingMessage): Promise<{
  readonly metadata: Record<string, unknown>;
  readonly file: Buffer;
}> {
  const body = await requestBuffer(req);
  const boundary = Buffer.from(`--${multipartBoundary(req)}`, 'ascii');
  const parts: Array<{ name: string; body: Buffer }> = [];
  let cursor = body.indexOf(boundary);
  while (cursor >= 0) {
    cursor += boundary.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n')))
      cursor += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) throw new Error('Malformed multipart headers');
    const headers = body.subarray(cursor, headerEnd).toString('utf8');
    const name = headers.match(
      /content-disposition:[^\r\n]*\bname="([^"]+)"/iu,
    )?.[1];
    if (!name) throw new Error('Multipart part name is required');
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) throw new Error('Malformed multipart boundary');
    const end =
      next >= 2 && body.subarray(next - 2, next).equals(Buffer.from('\r\n'))
        ? next - 2
        : next;
    parts.push({ name, body: body.subarray(headerEnd + 4, end) });
    cursor = next;
  }
  const metadataPart = parts.find((part) => part.name === 'metadata');
  const filePart = parts.find((part) => part.name === 'file');
  if (!metadataPart || !filePart)
    throw new Error('Multipart upload requires metadata and file parts');
  const metadata = strictParseJson(metadataPart.body.toString('utf8'));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Multipart metadata must be a JSON object');
  return { metadata: metadata as Record<string, unknown>, file: filePart.body };
}

const fileMetadataInputSchema = z
  .object({
    expectedRevision,
    fileName: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(255),
    fileId: identifier.optional(),
    previousRevision: z.number().int().positive().nullable().optional(),
    workItemRefs: z.array(identifier).optional(),
    workflowInstanceRefs: z.array(identifier).optional(),
    discussionRefs: z.array(identifier).optional(),
  })
  .strict();

function match(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

export class CollaborationWebApi {
  constructor(private readonly runtime: CollaborationRuntime) {}

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!url.pathname.startsWith(API_PREFIX)) return false;
    try {
      await this.route(req, res, url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(
        res,
        !this.runtime.status().available
          ? 503
          : /revision conflict|stale/iu.test(message)
            ? 409
            : 400,
        { error: message, collaboration: this.publicRuntimeStatus() },
      );
    }
    return true;
  }

  private publicRuntimeStatus() {
    const status = this.runtime.status();
    return {
      available: status.available,
      protocolVersion: status.protocolVersion,
      error: status.error,
      scheduler: status.scheduler,
    };
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    if (pathname === `${API_PREFIX}/status` && method === 'GET') {
      send(res, 200, { collaboration: this.publicRuntimeStatus() });
      return;
    }
    if (pathname === `${API_PREFIX}/backup` && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ backupDirectory: z.string().min(1).optional() }).strict(),
      );
      const backupDirectory =
        body.backupDirectory ??
        path.join(
          path.dirname(this.runtime.databasePath),
          'collaboration-backups',
          new Date().toISOString().replace(/[:.]/gu, '-'),
        );
      send(res, 201, {
        backupDirectory,
        manifest: await this.runtime.createBackup(backupDirectory),
      });
      return;
    }
    if (pathname === `${API_PREFIX}/restore` && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            backupDirectory: z.string().min(1),
            confirm: z.literal('RESTORE COLLABORATION V3'),
          })
          .strict(),
      );
      send(res, 200, await this.runtime.restoreBackup(body.backupDirectory));
      return;
    }
    if (pathname === `${API_PREFIX}/groups` && method === 'GET') {
      send(res, 200, {
        groups: this.runtime.store.listGroups().map(publicGroup),
      });
      return;
    }
    if (pathname === `${API_PREFIX}/groups/inspect` && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ remoteUrl: z.string().min(1) }).strict(),
      );
      send(res, 200, await this.runtime.groups.inspectRemote(body.remoteUrl));
      return;
    }
    if (pathname === `${API_PREFIX}/subscriptions` && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            remoteUrl: z.string().min(1),
            pollIntervalMs: z.number().int().positive().optional(),
            notificationsEnabled: z.boolean().optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(await this.runtime.groups.observeGroup(body)),
      });
      return;
    }
    let found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/subscriptions/([^/]+)$`, 'u'),
    );
    if (found && method === 'DELETE') {
      send(res, 200, {
        removed: this.runtime.store.deleteSubscription(found[1]!),
      });
      return;
    }
    if (pathname === `${API_PREFIX}/groups` && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            remoteUrl: z.string().min(1),
            name: z.string().min(1).max(240),
            signingKeyPath: z.string().min(1),
            displayName: z.string().min(1).max(160),
            clientDisplayName: z.string().min(1).max(160),
            membershipPolicy: z.enum(['open', 'approval', 'invite_only']),
            observerAccess: z.enum(['allowed', 'members_only']),
            groupId: identifier.optional(),
            pollIntervalMs: z.number().int().positive().optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(await this.runtime.groups.createGroup(body)),
      });
      return;
    }

    found = match(pathname, new RegExp(`^${API_PREFIX}/groups/([^/]+)$`, 'u'));
    if (found && method === 'GET') {
      const group = this.runtime.store.getGroup(found[1]!);
      if (!group) throw new Error('Collaboration Group not found');
      send(res, 200, {
        group: publicGroup(group),
        bindings: this.runtime.store
          .listExecutorBindings(group.groupId)
          .map(publicBinding),
        executions: this.runtime.store
          .listActionExecutions(group.groupId)
          .map(publicExecution),
        notifications:
          group.localPrincipalId && group.localClientId
            ? this.runtime.store.listPendingNotifications({
                principalId: group.localPrincipalId,
                clientId: group.localClientId,
                groupId: group.groupId,
              })
            : [],
      });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/sync$`, 'u'),
    );
    if (found && method === 'POST') {
      const history = await this.runtime.groups.sync(found[1]!);
      send(res, 200, {
        group: publicGroup(this.runtime.store.getGroup(found[1]!)),
        verifiedHead: history.head,
      });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/reopen$`, 'u'),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ expectedRevision, reason: z.string().min(1) }).strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.reopenGroup(
            found[1]!,
            body.reason,
            body.expectedRevision,
          ),
        ),
      });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/archive$`, 'u'),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ expectedRevision, reason: z.string().min(1) }).strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.archiveGroup(
            found[1]!,
            body.reason,
            body.expectedRevision,
          ),
        ),
      });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/join-requests$`, 'u'),
    );
    if (found && method === 'POST') {
      const group = this.runtime.store.getGroup(found[1]!);
      if (!group) throw new Error('Collaboration Group not found');
      const body = await jsonBody(
        req,
        z
          .object({
            signingKeyPath: z.string().min(1),
            displayName: z.string().min(1),
            clientDisplayName: z.string().min(1),
            inviteId: identifier.optional(),
            pollIntervalMs: z.number().int().positive().optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.joinGroup({
            remoteUrl: group.remoteUrl,
            ...body,
          }),
        ),
      });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/invites$`, 'u'),
    );
    if (found && method === 'GET') {
      send(res, 200, { invites: this.requireProjection(found[1]!).invites });
      return;
    }
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            principalId: identifier,
            expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
            expectedRevision,
          })
          .strict(),
      );
      const group = await this.runtime.groups.issueInvite({
        groupId: found[1]!,
        principalId: body.principalId,
        expiresAt: body.expiresAt,
        expectedRevision: body.expectedRevision,
      });
      send(res, 201, { group: publicGroup(group) });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/invites/([^/]+)/revoke$`, 'u'),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            reason: z.string().min(1).max(4000),
          })
          .strict(),
      );
      const group = await this.runtime.groups.revokeInvite({
        groupId: found[1]!,
        inviteId: found[2]!,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
      });
      send(res, 200, { group: publicGroup(group) });
      return;
    }
    found = match(
      pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/join-requests/([^/]+)/(approve|reject)$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ expectedRevision, reason: z.string().optional() }).strict(),
      );
      const group =
        found[3] === 'approve'
          ? await this.runtime.groups.approveMembership(
              found[1]!,
              found[2]!,
              body.expectedRevision,
            )
          : await this.runtime.groups.rejectMembership(
              found[1]!,
              found[2]!,
              body.reason ?? 'rejected',
              body.expectedRevision,
            );
      send(res, 200, { group: publicGroup(group) });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/members$`, 'u'),
    );
    if (found && method === 'GET') {
      const projection = this.requireProjection(found[1]!);
      send(res, 200, {
        members: projection.members,
        clients: projection.clients,
        executors: projection.executors,
        permissionGrants: projection.permissionGrants,
      });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/clients$`, 'u'),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            displayName: z.string().min(1).max(160),
            capabilities: z.array(identifier).max(100).optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.registerCurrentClient({
            groupId: found[1]!,
            ...body,
          }),
        ),
      });
      return;
    }
    found = match(
      pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/permissions/([^/]+)$`, 'u'),
    );
    if (found && method === 'PUT') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            grants: z.array(collaborationPermissionSchema).max(50),
          })
          .strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.updatePermissions({
            groupId: found[1]!,
            principalId: found[2]!,
            expectedRevision: body.expectedRevision,
            grants: body.grants,
          }),
        ),
      });
      return;
    }

    if (await this.workspaceRoutes(req, res, url)) return;
    if (await this.workItemRoutes(req, res, url)) return;
    if (await this.discussionRoutes(req, res, url)) return;
    if (await this.workflowRoutes(req, res, url)) return;
    if (await this.auditRoutes(req, res, url)) return;
    throw new Error(`Unknown collaboration v3 route: ${method} ${pathname}`);
  }

  private requireProjection(groupId: string) {
    const projection = this.runtime.store.getGroup(groupId)?.projection;
    if (!projection)
      throw new Error('Collaboration Group has no verified projection');
    return projection;
  }

  private async workspaceRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    let found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/files$`, 'u'),
    );
    if (found && method === 'GET') {
      send(res, 200, { files: this.runtime.store.listFileIndex(found[1]!) });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/files/content$`, 'u'),
    );
    if (found && method === 'GET') {
      const repositoryFile = url.searchParams.get('path');
      const indexed = this.runtime.store
        .listFileIndex(found[1]!)
        .find((file) => file.repositoryPath === repositoryFile);
      if (!repositoryFile || !indexed)
        throw new Error('Verified file path is not indexed');
      const contents = await this.runtime.groups.readVerifiedFile({
        groupId: found[1]!,
        repositoryFile,
      });
      res.writeHead(200, {
        'Content-Type': String(
          indexed.metadata.media_type ?? 'application/octet-stream',
        ),
        'Content-Length': contents.byteLength,
      });
      res.end(contents);
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/workspace/me/updates$`, 'u'),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            summary: z.string().min(1),
            completed: z.array(z.string()).optional(),
            inProgress: z.array(z.string()).optional(),
            nextSteps: z.array(z.string()).optional(),
            blockers: z.array(z.string()).optional(),
            workItemRefs: z.array(identifier).optional(),
            workflowInstanceRefs: z.array(identifier).optional(),
            artifactRefs: z.array(z.string()).optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.postProgress({
            groupId: found[1]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workspace/(shared|me)/files$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.startsWith('multipart/form-data')) {
        const upload = await multipartFile(req);
        const metadata = fileMetadataInputSchema.parse(upload.metadata);
        const group =
          found[2] === 'shared'
            ? await this.runtime.groups.publishSharedFile({
                groupId: found[1]!,
                ...metadata,
                contents: upload.file,
              })
            : await this.runtime.groups.publishPrincipalFile({
                groupId: found[1]!,
                ...metadata,
                contents: upload.file,
              });
        send(res, 201, { group: publicGroup(group) });
        return true;
      }
      const body = await jsonBody(
        req,
        fileMetadataInputSchema
          .extend({
            externalLocator: z
              .object({
                type: z.enum(['https', 'object_store']),
                locator: z.string().min(1),
              })
              .strict(),
            externalSize: z.number().int().nonnegative(),
            externalSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          })
          .strict(),
      );
      const group =
        found[2] === 'shared'
          ? await this.runtime.groups.publishSharedFile({
              groupId: found[1]!,
              ...body,
            })
          : await this.runtime.groups.publishPrincipalFile({
              groupId: found[1]!,
              ...body,
            });
      send(res, 201, { group: publicGroup(group) });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/workspace/me/actions$`, 'u'),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            actionId: identifier,
            name: z.string().min(1),
            version: z.number().int().positive(),
            kind: z.enum(['run_once', 'workflow', 'external']),
            adapter: identifier.nullable().optional(),
            workflowRef: identifier.nullable().optional(),
            prompt: z.string(),
            filesystemAccess: z.enum(['read_only', 'workspace_write']),
            resultSchema: z
              .object({
                ref: identifier,
                schema: z.record(z.string(), z.unknown()).nullable(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.publishAction({
            groupId: found[1]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    return false;
  }

  private async workItemRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    let found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/work-items$`, 'u'),
    );
    if (found && method === 'GET') {
      const projection = this.requireProjection(found[1]!);
      send(res, 200, {
        workItems: Object.values(projection.workItems),
        updates: projection.workItemUpdates,
      });
      return true;
    }
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            workItemId: identifier.optional(),
            type: z.enum(['task', 'issue', 'decision', 'milestone']),
            title: z.string().min(1),
            description: z.string().optional(),
            status: z.enum(['proposed', 'open']).optional(),
            priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
            ownerPrincipalId: identifier.optional(),
            preferredExecutorId: identifier.nullable().optional(),
            contributors: z.array(identifier).optional(),
            watchers: z.array(identifier).optional(),
            acceptanceCriteria: z.array(z.string()).optional(),
            labels: z.array(identifier).optional(),
            dueAt: z.string().datetime({ offset: true }).nullable().optional(),
            parentId: identifier.nullable().optional(),
            blockedBy: z.array(identifier).optional(),
            relatedItems: z.array(identifier).optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.createWorkItem({
            groupId: found[1]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/work-items/([^/]+)$`, 'u'),
    );
    if (found && method === 'GET') {
      const projection = this.requireProjection(found[1]!);
      send(res, 200, {
        workItem: projection.workItems[found[2]!] ?? null,
        updates: projection.workItemUpdates[found[2]!] ?? [],
      });
      return true;
    }
    if (found && method === 'PATCH') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            type: z.enum(['task', 'issue', 'decision', 'milestone']).optional(),
            title: z.string().min(1).optional(),
            description: z.string().optional(),
            priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
            preferredExecutorId: identifier.nullable().optional(),
            contributors: z.array(identifier).optional(),
            watchers: z.array(identifier).optional(),
            acceptanceCriteria: z.array(z.string()).optional(),
            labels: z.array(identifier).optional(),
            dueAt: z.string().datetime({ offset: true }).nullable().optional(),
          })
          .strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.updateWorkItemDetails({
            groupId: found[1]!,
            workItemId: found[2]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/work-items/([^/]+)/artifacts$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const upload = await multipartFile(req);
      const metadata = z
        .object({
          fileName: z.string().min(1).max(255),
          mediaType: z.string().min(1).max(255),
        })
        .strict()
        .parse(upload.metadata);
      send(
        res,
        201,
        await this.runtime.groups.stageWorkItemArtifact({
          groupId: found[1]!,
          workItemId: found[2]!,
          ...metadata,
          contents: upload.file,
        }),
      );
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/work-items/([^/]+)/assignment/(acknowledge|decline)$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            reason: z.string().min(1).optional(),
          })
          .strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.answerWorkItemAssignment({
            groupId: found[1]!,
            workItemId: found[2]!,
            expectedRevision: body.expectedRevision,
            accepted: found[3] === 'acknowledge',
            reason: body.reason,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/work-items/([^/]+)/archive$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ expectedRevision, reason: z.string().min(1) }).strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.archiveWorkItem({
            groupId: found[1]!,
            workItemId: found[2]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/work-items/([^/]+)/(progress|status|relations|assignment)$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const common = { groupId: found[1]!, workItemId: found[2]! };
      if (found[3] === 'progress') {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              summary: z.string().min(1),
              completed: z.array(z.string()).optional(),
              nextSteps: z.array(z.string()).optional(),
              blockers: z.array(z.string()).optional(),
              artifactIds: z.array(identifier).max(20).optional(),
              artifactRefs: z.array(z.string()).optional(),
            })
            .strict(),
        );
        send(res, 201, {
          group: publicGroup(
            await this.runtime.groups.postWorkItemProgress({
              ...common,
              ...body,
            }),
          ),
        });
      } else if (found[3] === 'status') {
        const body = await jsonBody(
          req,
          z.object({ expectedRevision, status: workItemStatusSchema }).strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.changeWorkItemStatus({
              ...common,
              ...body,
            }),
          ),
        });
      } else if (found[3] === 'relations') {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              parentId: identifier.nullable().optional(),
              blockedBy: z.array(identifier).optional(),
              relatedItems: z.array(identifier).optional(),
            })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.changeWorkItemRelations({
              ...common,
              ...body,
            }),
          ),
        });
      } else {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              ownerPrincipalId: identifier,
              preferredExecutorId: identifier.nullable().optional(),
              requireAcknowledgement: z.boolean().optional(),
            })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.changeWorkItemAssignment({
              ...common,
              ...body,
            }),
          ),
        });
      }
      return true;
    }
    return false;
  }

  private async discussionRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    let found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/discussions$`, 'u'),
    );
    if (found && method === 'GET') {
      send(res, 200, {
        discussions: this.requireProjection(found[1]!).discussions,
      });
      return true;
    }
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            threadId: identifier.optional(),
            title: z.string().min(1),
            scope: z.union([
              z.object({ type: z.literal('group') }).strict(),
              z
                .object({
                  type: z.enum(['work_item', 'workflow_instance', 'turn']),
                  ref: identifier,
                })
                .strict(),
            ]),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.createDiscussion({
            groupId: found[1]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/discussions/([^/]+)/reopen$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(req, z.object({ expectedRevision }).strict());
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.setDiscussionResolved({
            groupId: found[1]!,
            threadId: found[2]!,
            expectedRevision: body.expectedRevision,
            resolved: false,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/discussions/([^/]+)/messages$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            messageId: identifier.optional(),
            body: z.string().min(1),
            mentions: z.array(identifier).optional(),
            refs: z.array(z.string()).optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.postDiscussionMessage({
            groupId: found[1]!,
            threadId: found[2]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/discussions/([^/]+)/messages/([^/]+)$`,
        'u',
      ),
    );
    if (found && method === 'PATCH') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            body: z.string().min(1),
            mentions: z.array(identifier).optional(),
            refs: z.array(z.string()).optional(),
          })
          .strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.reviseDiscussionMessage({
            groupId: found[1]!,
            threadId: found[2]!,
            messageId: found[3]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    if (found && method === 'DELETE') {
      const body = await jsonBody(
        req,
        z.object({ expectedRevision, reason: z.string().optional() }).strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.tombstoneDiscussionMessage({
            groupId: found[1]!,
            threadId: found[2]!,
            messageId: found[3]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/discussions/([^/]+)/resolve$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ expectedRevision, resolved: z.boolean() }).strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.setDiscussionResolved({
            groupId: found[1]!,
            threadId: found[2]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    return false;
  }

  private async workflowRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    let found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/workflow-definitions$`, 'u'),
    );
    if (found && method === 'GET') {
      const projection = this.requireProjection(found[1]!);
      send(res, 200, {
        definitions: projection.workflowDefinitions,
        latestVersions: projection.latestWorkflowDefinitionVersions,
      });
      return true;
    }
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            definitionId: identifier,
            expectedRevision,
            version: z.number().int().positive(),
            name: z.string().min(1),
            description: z.string().optional(),
            launchPolicy: z
              .object({
                group_admin: z.boolean(),
                work_item_owner: z.boolean(),
                principals: z.array(identifier),
              })
              .strict()
              .optional(),
            machine: machineDefinitionV3Schema,
            layout: workflowLayoutSchema,
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.proposeWorkflowDefinition({
            groupId: found[1]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-definitions/([^/]+)/(draft|publish|layout)$`,
        'u',
      ),
    );
    if (found && ['PUT', 'POST'].includes(method)) {
      if (found[3] === 'draft') {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              version: z.number().int().positive(),
              name: z.string().min(1),
              description: z.string().optional(),
              launchPolicy: z
                .object({
                  group_admin: z.boolean(),
                  work_item_owner: z.boolean(),
                  principals: z.array(identifier),
                })
                .strict()
                .optional(),
              machine: machineDefinitionV3Schema,
              layout: workflowLayoutSchema,
            })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.proposeWorkflowDefinition({
              groupId: found[1]!,
              definitionId: found[2]!,
              ...body,
            }),
          ),
        });
      } else if (found[3] === 'publish') {
        const body = await jsonBody(
          req,
          z
            .object({ expectedRevision, version: z.number().int().positive() })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.publishWorkflowDefinition({
              groupId: found[1]!,
              definitionId: found[2]!,
              ...body,
            }),
          ),
        });
      } else {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              version: z.number().int().positive(),
              view: z.enum(['free', 'participants']),
              nodes: z.record(
                identifier,
                z.object({ x: z.number(), y: z.number() }).strict(),
              ),
            })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.updateWorkflowLayout({
              groupId: found[1]!,
              definitionId: found[2]!,
              ...body,
            }),
          ),
        });
      }
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-definitions/([^/]+)/retire$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z.object({ expectedRevision, reason: z.string().min(1) }).strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.retireWorkflowDefinition({
            groupId: found[1]!,
            definitionId: found[2]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/workflow-instances$`, 'u'),
    );
    if (found && method === 'GET') {
      const projection = this.requireProjection(found[1]!);
      send(res, 200, {
        instances: projection.workflowInstances,
        executions: projection.stateExecutions,
        turns: projection.turns,
      });
      return true;
    }
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            definitionId: identifier,
            definitionVersion: z.number().int().positive(),
            instanceId: identifier.optional(),
            scope: z.union([
              z.object({ type: z.literal('group') }).strict(),
              z
                .object({
                  type: z.literal('work_item'),
                  work_item_id: identifier,
                })
                .strict(),
            ]),
            relatedWorkItemRefs: z.array(identifier).optional(),
            participantBindings: z.record(identifier, identifier).optional(),
            stateAssignments: z.record(identifier, identifier).optional(),
            workItemStatusMapping: z
              .record(identifier, workItemStatusSchema)
              .optional(),
          })
          .strict(),
      );
      send(res, 201, {
        group: publicGroup(
          await this.runtime.groups.createWorkflowInstance({
            groupId: found[1]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/reassign$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            stateId: identifier,
            principalId: identifier,
          })
          .strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.reassignWorkflowState({
            groupId: found[1]!,
            instanceId: found[2]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/states/([^/]+)/execution/withdraw$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(req, z.object({ expectedRevision }).strict());
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.withdrawStateExecution({
            groupId: found[1]!,
            instanceId: found[2]!,
            stateId: found[3]!,
            expectedRevision: body.expectedRevision,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/commands$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            command: z.enum([
              'start',
              'pause',
              'resume',
              'close',
              'create_turn',
            ]),
            reason: z.string().optional(),
            turnId: identifier.optional(),
          })
          .strict(),
      );
      let group;
      if (body.command === 'start')
        group = await this.runtime.groups.startWorkflowInstance({
          groupId: found[1]!,
          instanceId: found[2]!,
          expectedRevision: body.expectedRevision,
        });
      else if (body.command === 'pause' || body.command === 'resume')
        group = await this.runtime.groups.setWorkflowInstancePaused({
          groupId: found[1]!,
          instanceId: found[2]!,
          expectedRevision: body.expectedRevision,
          paused: body.command === 'pause',
          reason: body.reason,
        });
      else if (body.command === 'close')
        group = await this.runtime.groups.closeWorkflowInstance({
          groupId: found[1]!,
          instanceId: found[2]!,
          expectedRevision: body.expectedRevision,
          reason: body.reason ?? 'closed',
        });
      else
        group = await this.runtime.groups.createTurn({
          groupId: found[1]!,
          instanceId: found[2]!,
          expectedRevision: body.expectedRevision,
          turnId: body.turnId,
        });
      send(res, 200, { group: publicGroup(group) });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/states/([^/]+)/execution$`,
        'u',
      ),
    );
    if (found && method === 'PUT') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            mode: z.enum(['manual', 'assisted', 'automatic']),
            actionId: identifier.nullable().optional(),
            binding: z
              .object({
                executorId: identifier,
                executorKind: z.enum([
                  'run_once',
                  'workflow',
                  'external',
                  'codex',
                ]),
                workspacePath: z.string().min(1),
                filesystemAccess: z.enum(['read_only', 'workspace_write']),
                approvalPolicy: z.enum(['untrusted', 'on-request', 'never']),
                config: z.record(z.string(), z.unknown()),
                enabled: z.boolean(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      );
      const binding = body.binding;
      if (body.mode !== 'manual' && !binding)
        throw new Error('Non-manual execution requires a local Binding');
      if (body.mode === 'manual' && binding)
        throw new Error('Manual execution cannot configure a local Binding');
      const group = await this.runtime.groups.publishStateExecution({
        groupId: found[1]!,
        instanceId: found[2]!,
        stateId: found[3]!,
        expectedRevision: body.expectedRevision,
        mode: body.mode,
        actionId: body.actionId,
      });
      if (body.mode !== 'manual') {
        const execution =
          group.projection?.stateExecutions[found[2]!]?.[found[3]!];
        if (!execution?.action_hash || !execution.prompt_hash)
          throw new Error('Non-manual execution requires a local Binding');
        this.runtime.store.saveExecutorBinding({
          groupId: found[1]!,
          instanceId: found[2]!,
          stateId: found[3]!,
          principalId: group.localPrincipalId!,
          clientId: group.localClientId!,
          actionHash: execution.action_hash,
          promptHash: execution.prompt_hash,
          ...binding!,
        });
      }
      send(res, 200, { group: publicGroup(group) });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/turns/current$`,
        'u',
      ),
    );
    if (found && method === 'GET') {
      const projection = this.requireProjection(found[1]!);
      const instance = projection.workflowInstances[found[2]!];
      send(res, 200, {
        turn: instance?.active_turn_id
          ? projection.turns[instance.active_turn_id]
          : null,
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/turns/([^/]+)/artifacts$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const upload = await multipartFile(req);
      const metadata = z
        .object({
          attempt: z.number().int().positive(),
          fencingToken: z.string().min(1),
          fileName: z.string().min(1).max(255),
          mediaType: z.string().min(1).max(255),
        })
        .strict()
        .parse(upload.metadata);
      send(
        res,
        201,
        await this.runtime.groups.stageTurnArtifact({
          groupId: found[1]!,
          instanceId: found[2]!,
          turnId: found[3]!,
          ...metadata,
          contents: upload.file,
        }),
      );
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/turns/([^/]+)/cancel$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const body = await jsonBody(
        req,
        z
          .object({
            expectedRevision,
            attempt: z.number().int().positive(),
            fencingToken: z.string().min(1).nullable().optional(),
            reason: z.string().min(1),
          })
          .strict(),
      );
      send(res, 200, {
        group: publicGroup(
          await this.runtime.groups.cancelTurn({
            groupId: found[1]!,
            instanceId: found[2]!,
            turnId: found[3]!,
            ...body,
          }),
        ),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/workflow-instances/([^/]+)/turns/([^/]+)/(start|complete|recover)$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      if (found[4] === 'start') {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              executorId: identifier.nullable().optional(),
            })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.startTurn({
              groupId: found[1]!,
              instanceId: found[2]!,
              turnId: found[3]!,
              ...body,
            }),
          ),
        });
      } else if (found[4] === 'complete') {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              attempt: z.number().int().positive(),
              fencingToken: z.string(),
              outcome: identifier,
              summary: z.string().min(1),
              instruction: z.string().optional(),
              markers: z.array(identifier).optional(),
              dataRefs: z.array(z.string()).optional(),
              artifactIds: z.array(identifier).max(20).optional(),
              artifactRefs: z.array(z.string()).optional(),
              data: z.record(z.string(), z.unknown()).optional(),
            })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.completeTurn({
              groupId: found[1]!,
              instanceId: found[2]!,
              turnId: found[3]!,
              ...body,
            }),
          ),
        });
      } else {
        const body = await jsonBody(
          req,
          z
            .object({
              expectedRevision,
              previousAttempt: z.number().int().positive(),
              reason: z.string().min(1),
            })
            .strict(),
        );
        send(res, 200, {
          group: publicGroup(
            await this.runtime.groups.recoverTurn({
              groupId: found[1]!,
              instanceId: found[2]!,
              turnId: found[3]!,
              ...body,
            }),
          ),
        });
      }
      return true;
    }
    return false;
  }

  private async auditRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    let found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/activity$`, 'u'),
    );
    if (found && method === 'GET') {
      send(res, 200, { activity: this.requireProjection(found[1]!).activity });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/audit(?:/export)?$`, 'u'),
    );
    if (found && method === 'GET') {
      const group = this.runtime.store.getGroup(found[1]!);
      if (!group?.projection) throw new Error('Collaboration Group not found');
      send(
        res,
        200,
        buildCollaborationAuditV3({
          group,
          projection: group.projection,
          eventRecords: this.runtime.store.listEventRecords(
            group.groupId,
            5000,
          ),
          executions: this.runtime.store.listActionExecutions(group.groupId),
          notifications: this.runtime.store.listNotificationsForAudit(
            group.groupId,
          ),
          localEvidence: this.runtime.store.listLocalAuditEvidence(
            group.groupId,
          ),
          includeContent: url.searchParams.get('include_content') === 'true',
        }),
      );
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(`^${API_PREFIX}/groups/([^/]+)/diagnostics$`, 'u'),
    );
    if (found && method === 'GET') {
      send(res, 200, {
        group: publicGroup(this.runtime.store.getGroup(found[1]!)),
        syncAttempts: redactLocalSecrets(
          this.runtime.store.listSyncAttempts(found[1]!),
        ),
        integrityIncidents: redactLocalSecrets(
          this.runtime.store.listIntegrityIncidents(found[1]!),
        ),
        scheduler: this.runtime.scheduler.diagnostics(),
      });
      return true;
    }
    found = match(
      url.pathname,
      new RegExp(
        `^${API_PREFIX}/groups/([^/]+)/notifications/([^/]+)/delivered$`,
        'u',
      ),
    );
    if (found && method === 'POST') {
      const group = this.runtime.store.getGroup(found[1]!);
      if (!group?.localPrincipalId || !group.localClientId)
        throw new Error('Observer has no local notifications');
      send(res, 200, {
        delivered: this.runtime.store.markNotificationDelivered(
          found[2]!,
          group.localPrincipalId,
          group.localClientId,
        ),
      });
      return true;
    }
    return false;
  }
}
