import http from 'node:http';
import path from 'node:path';

import { listCollaborationSharedPaths } from './git-transport.js';
import type { CollaborationProjection } from './protocol/index.js';
import type { CollaborationRuntime } from './runtime.js';
import type {
  CollaborationExecutionRecord,
  CollaborationExecutorBinding,
  CollaborationGroupRecord,
  CollaborationSyncAttempt,
} from './store.js';

const API_PREFIX = '/api/collaboration';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A JSON object body is required');
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || !candidate.trim())
    throw new Error(`${key} is required`);
  return candidate.trim();
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : null;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function jsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

function redactRemoteUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.username || parsed.password) {
      parsed.username = 'redacted';
      parsed.password = '';
    }
    for (const key of [...parsed.searchParams.keys()])
      if (isSecretConfigKey(key)) parsed.searchParams.set(key, 'redacted');
    return parsed.toString();
  } catch {
    return input;
  }
}

function redactDiagnostic(
  input: string | null,
  sensitiveUrls: readonly string[] = [],
): string | null {
  if (input == null) return null;
  let output = input;
  for (const remoteUrl of sensitiveUrls)
    output = output.replaceAll(remoteUrl, redactRemoteUrl(remoteUrl));
  return output.replace(/https?:\/\/[^\s"']+/g, (candidate) =>
    redactRemoteUrl(candidate),
  );
}

function isSecretConfigKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const values = new Set(parts);
  if (
    parts.some((part) =>
      [
        'password',
        'passwd',
        'token',
        'secret',
        'credential',
        'credentials',
        'authorization',
      ].includes(part),
    )
  )
    return true;
  return (
    (values.has('api') && values.has('key')) ||
    (values.has('private') && values.has('key')) ||
    (values.has('signing') && values.has('key') && values.has('path'))
  );
}

function redactConfig(value: unknown, key = ''): unknown {
  if (isSecretConfigKey(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((child) => redactConfig(child));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, child]) => [childKey, redactConfig(child, childKey)],
      ),
    );
  return value;
}

function publicProjection(
  projection: CollaborationProjection | null,
): CollaborationProjection | null {
  if (!projection) return null;
  return {
    ...projection,
    members: Object.fromEntries(
      Object.entries(projection.members).map(([principalId, member]) => [
        principalId,
        { ...member, signing_public_key: '[redacted]' },
      ]),
    ),
  };
}

function publicGroup(group: CollaborationGroupRecord) {
  return {
    groupId: group.groupId,
    name: group.name,
    creatorPrincipalId: group.creatorPrincipalId,
    localPrincipalId: group.localPrincipalId,
    localAgentId: group.localAgentId,
    lifecycle: group.lifecycle,
    businessState: group.businessState,
    protocolStatus: group.protocolStatus,
    protocolError: redactDiagnostic(group.protocolError, [group.remoteUrl]),
    projection: publicProjection(group.projection),
    remoteUrl: redactRemoteUrl(group.remoteUrl),
    signingKeyRef: group.signingKeyRef,
    signingConfigured: Boolean(group.signingKeyPath),
    pollIntervalMs: group.pollIntervalMs,
    nextSyncAtMs: group.nextSyncAtMs,
    lastSyncAtMs: group.lastSyncAtMs,
    lastError: redactDiagnostic(group.lastError, [group.remoteUrl]),
    headCommit: group.headCommit,
  };
}

function publicBinding(binding: CollaborationExecutorBinding) {
  return {
    groupId: binding.groupId,
    role: binding.role,
    executorKind: binding.executorKind,
    adapter: binding.adapter,
    agentJid: binding.agentJid,
    workspacePath: binding.workspacePath,
    promptOverride: binding.promptOverride,
    filesystemAccessCap: binding.filesystemAccessCap,
    approvalPolicy: binding.approvalPolicy,
    config: redactConfig(binding.config),
    enabled: binding.enabled,
    updatedAtMs: binding.updatedAtMs,
  };
}

function publicProvider(execution: CollaborationExecutionRecord) {
  const metadata = execution.providerMetadata ?? {};
  if (execution.adapter === 'codex-task')
    return {
      kind: 'codex-task',
      transport: metadata.transport,
      threadId: metadata.thread_id,
      turnId: metadata.turn_id,
      cliVersion: metadata.cli_version,
      ephemeral: metadata.ephemeral,
    };
  if (execution.executorKind === 'workflow')
    return {
      kind: 'workflow',
      workflowId: metadata.workflow_id,
      graphRunId: metadata.graph_run_id,
      lifecycle: metadata.lifecycle,
      operationalState: metadata.operational_state,
    };
  if (execution.executorKind === 'run_once')
    return {
      kind: 'run_once',
      runId: metadata.run_id,
      queryId: metadata.query_id,
    };
  return { kind: execution.executorKind };
}

function publicExecution(execution: CollaborationExecutionRecord) {
  const observation = execution.observation;
  return {
    executionId: execution.executionId,
    groupId: execution.groupId,
    turnId: execution.turnId,
    epoch: execution.epoch,
    attempt: execution.attempt,
    operationKey: execution.operationKey,
    executorKind: execution.executorKind,
    adapter: execution.adapter,
    state: execution.state,
    executionRef: execution.executionRef,
    provider: publicProvider(execution),
    observation: observation
      ? {
          state: observation.state,
          result: redactConfig(observation.result),
          resultHash: observation.resultHash,
          recoveryReason: observation.recoveryReason,
        }
      : null,
    recoveryRequiredReason: execution.recoveryRequiredReason,
    dispatchStartedAtMs: execution.dispatchStartedAtMs,
    receiptRecordedAtMs: execution.receiptRecordedAtMs,
    createdAtMs: execution.createdAtMs,
    updatedAtMs: execution.updatedAtMs,
  };
}

function publicSyncAttempt(
  attempt: CollaborationSyncAttempt,
  remoteUrl: string,
) {
  return {
    ...attempt,
    error: redactDiagnostic(attempt.error, [remoteUrl]),
  };
}

function enumValue<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const candidate = requiredString(value, key);
  if (!allowed.includes(candidate))
    throw new Error(`${key} has an unsupported value`);
  return candidate as T[number];
}

function assertExpectedRevision(
  group: CollaborationGroupRecord,
  body: Record<string, unknown>,
): void {
  if (!Number.isInteger(body.expectedRevision))
    throw new Error('expectedRevision is required');
  if (body.expectedRevision !== group.projection?.revision)
    throw new Error(
      `Expected revision ${String(body.expectedRevision)} does not match ${String(group.projection?.revision)}`,
    );
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && /^Expected revision /.test(error.message);
}

export class CollaborationWebApi {
  constructor(private readonly runtime: CollaborationRuntime) {}

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) return false;
    try {
      await this.route(req, res, url);
    } catch (error) {
      const unavailable = !this.runtime.status().available;
      send(res, unavailable ? 503 : isRevisionConflict(error) ? 409 : 400, {
        error: redactDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
        collaboration: this.publicRuntimeStatus(),
      });
    }
    return true;
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;
    if (pathname === `${API_PREFIX}/status` && req.method === 'GET') {
      send(res, 200, { collaboration: this.publicRuntimeStatus() });
      return;
    }
    if (pathname === `${API_PREFIX}/backup` && req.method === 'POST') {
      const body = object(await jsonBody(req));
      const backupDirectory =
        optionalString(body, 'backupDirectory') ??
        path.join(
          path.dirname(this.runtime.databasePath),
          'collaboration-backups',
          new Date().toISOString().replace(/[:.]/g, '-'),
        );
      const manifest = await this.runtime.createBackup(backupDirectory);
      send(res, 201, { backupDirectory, manifest });
      return;
    }
    if (pathname === `${API_PREFIX}/restore` && req.method === 'POST') {
      const body = object(await jsonBody(req));
      if (body.confirm !== 'RESTORE COLLABORATION')
        throw new Error('confirm must equal RESTORE COLLABORATION');
      const backupDirectory = requiredString(body, 'backupDirectory');
      const result = await this.runtime.restoreBackup(backupDirectory);
      send(res, 200, { ok: true, ...result });
      return;
    }

    const base = `${API_PREFIX}/groups`;
    if (pathname === base && req.method === 'GET') {
      const groups = this.runtime.groups
        .listGroups(url.searchParams.get('search') ?? '')
        .map(publicGroup);
      send(res, 200, { groups });
      return;
    }
    if (pathname === base && req.method === 'POST') {
      const body = object(await jsonBody(req));
      const group = await this.runtime.groups.createGroup(
        body as unknown as Parameters<
          CollaborationRuntime['groups']['createGroup']
        >[0],
      );
      send(res, 201, { group: publicGroup(group) });
      return;
    }
    if (pathname === `${base}/inspect` && req.method === 'POST') {
      const body = object(await jsonBody(req));
      const summary = await this.runtime.groups.inspectRemote(
        requiredString(body, 'remoteUrl'),
      );
      send(res, 200, { summary });
      return;
    }
    if (pathname === `${base}/join` && req.method === 'POST') {
      const body = object(await jsonBody(req));
      const group = await this.runtime.groups.joinGroup(
        body as unknown as Parameters<
          CollaborationRuntime['groups']['joinGroup']
        >[0],
      );
      send(res, 201, { group: publicGroup(group) });
      return;
    }

    const match = pathname.match(
      new RegExp(
        `^${base}/([^/]+)(?:/(sync|roles|commands|events|executors|executions|data|diagnostics)(?:/([^/]+))?)?$`,
      ),
    );
    if (!match) {
      send(res, 404, { error: 'Not found' });
      return;
    }
    const groupId = decodeURIComponent(match[1]);
    const resource = match[2] ?? 'detail';
    const child = match[3] ? decodeURIComponent(match[3]) : null;
    const group = this.runtime.store.getGroup(groupId);
    if (!group) {
      send(res, 404, { error: 'Collaboration group not found' });
      return;
    }

    if (resource === 'detail' && req.method === 'GET') {
      let history = this.runtime.groups.getCachedHistory(groupId);
      if (!history) {
        try {
          history = await this.runtime.groups.syncHistory(groupId);
        } catch {
          history = null;
        }
      }
      send(res, 200, {
        group: publicGroup(this.runtime.store.getGroup(groupId)!),
        definition: history ? redactConfig(history.definition) : null,
        bindings: this.runtime.store
          .listExecutorBindings(groupId)
          .map(publicBinding),
        executions: this.runtime.store
          .listExecutions(groupId)
          .map(publicExecution),
      });
      return;
    }
    if (resource === 'sync' && req.method === 'POST') {
      await this.runtime.scheduler.syncNow(groupId);
      send(res, 200, {
        group: publicGroup(this.runtime.store.getGroup(groupId)!),
      });
      return;
    }
    if (resource === 'roles' && req.method === 'GET') {
      send(res, 200, {
        roleClaims: group.projection?.roleClaims ?? {},
        bindings: this.runtime.store
          .listExecutorBindings(groupId)
          .map(publicBinding),
      });
      return;
    }
    if (resource === 'roles' && req.method === 'POST') {
      const body = object(await jsonBody(req));
      const updated = await this.runtime.groups.claimRole(
        groupId,
        requiredString(body, 'role'),
      );
      send(res, 200, { group: publicGroup(updated) });
      return;
    }
    if (resource === 'commands' && req.method === 'POST') {
      const body = object(await jsonBody(req));
      assertExpectedRevision(group, body);
      const command = requiredString(body, 'command');
      const updated =
        command === 'start'
          ? await this.runtime.groups.start(groupId)
          : command === 'pause'
            ? await this.runtime.groups.pause(groupId)
            : command === 'resume'
              ? await this.runtime.groups.resume(groupId)
              : command === 'close'
                ? await this.runtime.groups.close(
                    groupId,
                    requiredString(body, 'reason'),
                  )
                : command === 'recover'
                  ? await this.runtime.groups.recoverTurn(
                      groupId,
                      requiredString(body, 'reason'),
                    )
                  : command === 'create_turn'
                    ? (await this.runtime.groups.ensureTurn(
                        groupId,
                        requiredString(body, 'transitionId'),
                      ),
                      this.runtime.store.getGroup(groupId)!)
                    : null;
      if (!updated)
        throw new Error(`Unsupported collaboration command: ${command}`);
      send(res, 200, { group: publicGroup(updated) });
      return;
    }
    if (resource === 'events' && req.method === 'GET') {
      const limit = Math.min(
        500,
        Math.max(1, Number(url.searchParams.get('limit')) || 200),
      );
      send(res, 200, {
        events: this.runtime.store
          .listEventRecords(groupId, limit)
          .map((record) => ({
            commitHash: record.commitHash,
            event: redactConfig(record.event),
          })),
      });
      return;
    }
    if (resource === 'executors' && req.method === 'GET') {
      send(res, 200, {
        bindings: this.runtime.store
          .listExecutorBindings(groupId)
          .map(publicBinding),
      });
      return;
    }
    if (resource === 'executors' && child && req.method === 'PUT') {
      const body = object(await jsonBody(req));
      const holdsRole = (group.projection?.roleClaims[child] ?? []).some(
        (claim) =>
          claim.principal_id === group.localPrincipalId &&
          claim.agent_id === group.localAgentId,
      );
      if (!holdsRole)
        throw new Error(
          'Only a locally claimed role can configure an executor',
        );
      this.runtime.store.saveExecutorBinding({
        groupId,
        role: child,
        executorKind: enumValue(body, 'executorKind', [
          'run_once',
          'workflow',
          'external',
        ] as const),
        adapter: optionalString(body, 'adapter'),
        agentJid: optionalString(body, 'agentJid'),
        workspacePath: requiredString(body, 'workspacePath'),
        promptOverride: optionalString(body, 'promptOverride'),
        filesystemAccessCap: enumValue(body, 'filesystemAccessCap', [
          'read_only',
          'workspace_write',
        ] as const),
        approvalPolicy: enumValue(body, 'approvalPolicy', [
          'untrusted',
          'on-request',
          'never',
        ] as const),
        config:
          body.config &&
          typeof body.config === 'object' &&
          !Array.isArray(body.config)
            ? (body.config as Record<string, unknown>)
            : {},
        enabled: body.enabled !== false,
      });
      send(res, 200, {
        binding: publicBinding(
          this.runtime.store.getExecutorBinding(groupId, child)!,
        ),
      });
      return;
    }
    if (resource === 'executions' && req.method === 'GET') {
      send(res, 200, {
        executions: this.runtime.store
          .listExecutions(groupId)
          .map(publicExecution),
      });
      return;
    }
    if (resource === 'data' && req.method === 'GET') {
      send(res, 200, {
        paths: group.headCommit
          ? await listCollaborationSharedPaths({
              repositoryPath: group.repositoryPath,
              head: group.headCommit,
            })
          : [],
      });
      return;
    }
    if (resource === 'diagnostics' && req.method === 'GET') {
      send(res, 200, {
        collaboration: this.publicRuntimeStatus(),
        group: publicGroup(group),
        incidents: this.runtime.store
          .listIntegrityIncidents(groupId)
          .map((incident) => ({
            ...incident,
            message: redactDiagnostic(incident.message, [group.remoteUrl]),
          })),
        syncAttempts: this.runtime.store
          .listSyncAttempts(groupId, 50)
          .map((attempt) => publicSyncAttempt(attempt, group.remoteUrl)),
      });
      return;
    }
    send(res, 405, { error: 'Method not allowed' });
  }

  private publicRuntimeStatus() {
    const status = this.runtime.status();
    let sensitiveUrls: string[] = [];
    if (status.available) {
      try {
        sensitiveUrls = this.runtime.store
          .listGroups()
          .map((group) => group.remoteUrl);
      } catch {
        sensitiveUrls = [];
      }
    }
    return {
      available: status.available,
      error: redactDiagnostic(status.error, sensitiveUrls),
      scheduler: status.scheduler
        ? {
            ...status.scheduler,
            groupErrors: Object.fromEntries(
              Object.entries(status.scheduler.groupErrors).map(
                ([groupId, message]) => [
                  groupId,
                  redactDiagnostic(message, sensitiveUrls),
                ],
              ),
            ),
          }
        : null,
      database: path.basename(status.databasePath),
    };
  }
}

export const collaborationWebApiTestables = {
  publicGroup,
  publicBinding,
  publicExecution,
  publicSyncAttempt,
  redactConfig,
  redactDiagnostic,
  redactRemoteUrl,
};
