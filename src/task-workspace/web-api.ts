import type http from 'node:http';

import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import { RuntimeWorkspaceGatewayError } from '../workflow-runtime/gateway/workspace.js';
import type { TaskRunSelection, TaskSessionStatus } from './contracts.js';
import { TaskWorkspaceService, TaskWorkspaceServiceError } from './service.js';
import { TaskWorkspaceStoreError } from './store.js';

const API_PREFIX = '/api/task-workspace';
const PERSONAL_PREFIX = '/api/personal-workflows';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

class TaskWorkspaceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'TaskWorkspaceApiError';
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new TaskWorkspaceApiError(
        'request_too_large',
        'Request body is too large',
        413,
      );
    }
    chunks.push(buffer);
  }
  const parsed = JSON.parse(
    Buffer.concat(chunks).toString('utf8') || '{}',
  ) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      'A JSON object body is required',
    );
  }
  return parsed as Record<string, unknown>;
}

function string(
  body: Record<string, unknown>,
  key: string,
  options: { optional?: boolean; max?: number; allowEmpty?: boolean } = {},
): string | null {
  const value = body[key];
  if (value == null && options.optional) return null;
  if (typeof value !== 'string') {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      `${key} must be a string`,
    );
  }
  const normalized = options.allowEmpty ? value : value.trim();
  if (
    (!options.allowEmpty && !normalized) ||
    value.length > (options.max ?? 100_000)
  ) {
    throw new TaskWorkspaceApiError('invalid_request', `${key} is invalid`);
  }
  return normalized;
}

function integer(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      `${key} must be a non-negative safe integer`,
    );
  }
  return Number(value);
}

function nullableInteger(
  body: Record<string, unknown>,
  key: string,
): number | null {
  if (body[key] === null) return null;
  return integer(body, key);
}

function jsonObject(body: Record<string, unknown>, key: string): JsonObject {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      `${key} must be an object`,
    );
  }
  return value as JsonObject;
}

function jsonValue(body: Record<string, unknown>, key: string): JsonValue {
  if (!(key in body) || body[key] === undefined) {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      `${key} must be valid JSON`,
    );
  }
  try {
    JSON.stringify(body[key]);
  } catch {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      `${key} must be valid JSON`,
    );
  }
  return body[key] as JsonValue;
}

function exactKeys(
  body: Record<string, unknown>,
  expected: readonly string[],
): void {
  const allowed = new Set(expected);
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
  if (unexpected.length > 0 || expected.some((key) => !(key in body))) {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      `Request fields must be exactly: ${expected.join(', ')}`,
    );
  }
}

function errorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string; retryable: boolean } };
} {
  if (error instanceof TaskWorkspaceApiError) {
    return {
      status: error.status,
      body: {
        error: { code: error.code, message: error.message, retryable: false },
      },
    };
  }
  if (error instanceof TaskWorkspaceStoreError) {
    return {
      status:
        error.code === 'not_found'
          ? 404
          : error.code === 'conflict'
            ? 409
            : 400,
      body: {
        error: { code: error.code, message: error.message, retryable: false },
      },
    };
  }
  if (error instanceof TaskWorkspaceServiceError) {
    return {
      status:
        error.code === 'not_found'
          ? 404
          : error.code === 'conflict'
            ? 409
            : error.code.endsWith('_unavailable')
              ? 503
              : 400,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      },
    };
  }
  if (error instanceof RuntimeWorkspaceGatewayError) {
    return {
      status:
        error.code === 'target_not_found'
          ? 404
          : error.code === 'permission_denied'
            ? 403
            : error.code === 'selection_stale' ||
                error.code === 'lineage_mismatch'
              ? 409
              : 400,
      body: {
        error: { code: error.code, message: error.message, retryable: false },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message:
          error instanceof Error
            ? error.message
            : 'Task Workspace request failed',
        retryable: false,
      },
    },
  };
}

function segment(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    for (let index = 1; index < match.length; index += 1) {
      if (match[index] !== undefined)
        match[index] = decodeURIComponent(match[index]!);
    }
  } catch {
    throw new TaskWorkspaceApiError(
      'invalid_request',
      'Path identifier is malformed',
    );
  }
  return match;
}

export class TaskWorkspaceWebApi {
  constructor(
    private readonly service: TaskWorkspaceService,
    private readonly principalRef = 'human:local-owner',
  ) {}

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const pathname = url.pathname;
    if (
      !pathname.startsWith(API_PREFIX) &&
      !pathname.startsWith(PERSONAL_PREFIX)
    ) {
      return false;
    }
    try {
      await this.route(req, res, url);
    } catch (error) {
      const response = errorResponse(error);
      send(res, response.status, response.body);
    }
    return true;
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const pathname = url.pathname;
    if (pathname === `${API_PREFIX}/sessions`) {
      if (method === 'GET') {
        send(res, 200, {
          sessions: this.service.listSessions(this.principalRef),
        });
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        const session = this.service.createSession({
          principalRef: this.principalRef,
          title: string(body, 'title', { max: 500 })!,
          source: 'task_workspace',
        });
        send(res, 201, { session });
        return;
      }
    }
    if (pathname === `${API_PREFIX}/recipes` && method === 'GET') {
      send(res, 200, this.service.listRecipes(this.principalRef));
      return;
    }
    if (pathname === `${PERSONAL_PREFIX}` && method === 'GET') {
      send(res, 200, {
        workflows: this.service.listPersonalWorkflows(this.principalRef),
      });
      return;
    }

    let match = segment(
      pathname,
      /^\/api\/task-workspace\/runtime-links\/workflows\/([^/]+)$/,
    );
    if (match && method === 'GET') {
      send(
        res,
        200,
        this.service.resolveRuntimeLink(match[1]!, this.principalRef),
      );
      return;
    }
    match = segment(pathname, /^\/api\/task-workspace\/sessions\/([^/]+)$/);
    if (match && method === 'GET') {
      send(
        res,
        200,
        await this.service.getSession(match[1]!, this.principalRef),
      );
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/(complete|reopen|archive)$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      const status: Record<string, TaskSessionStatus> = {
        complete: 'completed',
        reopen: 'open',
        archive: 'archived',
      };
      const session = this.service.updateSessionStatus({
        sessionId: match[1]!,
        principalRef: this.principalRef,
        status: status[match[2]!]!,
        expectedRowVersion: integer(body, 'expected_row_version'),
      });
      send(res, 200, { session });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/messages$/,
    );
    if (match && method === 'GET') {
      send(res, 200, {
        messages: this.service.listMessages(match[1]!, this.principalRef),
      });
      return;
    }
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      const action = string(body, 'action', { max: 16 });
      const textValue = string(body, 'text', {
        max: 100_000,
        allowEmpty: false,
      })!;
      if (action === 'send') {
        const result = await this.service.send({
          sessionId: match[1]!,
          principalRef: this.principalRef,
          text: textValue,
          replyToMessageId: string(body, 'reply_to_message_id', {
            optional: true,
            max: 512,
          }),
        });
        send(res, 201, result);
        return;
      }
      if (action === 'run') {
        const launch = await this.service.run({
          sessionId: match[1]!,
          principalRef: this.principalRef,
          text: textValue,
          selectionToken: string(body, 'selection_token', {
            optional: true,
            max: 16_384,
          }),
          idempotencyKey: string(body, 'idempotency_key', { max: 512 })!,
        });
        send(res, 202, { launch_intent: launch });
        return;
      }
      throw new TaskWorkspaceApiError(
        'invalid_request',
        'action must be exactly send or run',
      );
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/coordinator-turns\/([^/]+)\/retry$/,
    );
    if (match && method === 'POST') {
      send(res, 200, {
        turn: this.service.retryCoordinatorTurn({
          sessionId: match[1]!,
          turnId: match[2]!,
          principalRef: this.principalRef,
        }),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/timeline$/,
    );
    if (match && method === 'GET') {
      const raw = Number(url.searchParams.get('after_session_seq') ?? 0);
      if (!Number.isSafeInteger(raw) || raw < 0) {
        throw new TaskWorkspaceApiError(
          'invalid_request',
          'after_session_seq must be a non-negative safe integer',
        );
      }
      send(
        res,
        200,
        await this.service.timeline({
          sessionId: match[1]!,
          principalRef: this.principalRef,
          afterSessionSeq: raw,
        }),
      );
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/runtime-detail$/,
    );
    if (match && method === 'GET') {
      send(
        res,
        200,
        await this.service.runtimeDetail(match[1]!, this.principalRef),
      );
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/runtime-timeline\/rebuild$/,
    );
    if (match && method === 'POST') {
      this.service.rebuildTimeline(match[1]!, this.principalRef);
      send(res, 202, { accepted: true });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/run-selection$/,
    );
    if (match && method === 'PUT') {
      const body = await jsonBody(req);
      const kind = string(body, 'kind', { max: 32 });
      let selection: TaskRunSelection;
      if (kind === 'temporary_workflow') {
        selection = { kind };
      } else if (kind === 'published_recipe') {
        const token = string(body, 'selection_token', { max: 16_384 })!;
        const item = this.service
          .listRecipes(this.principalRef)
          .items.find((candidate) => candidate.selection_token === token);
        if (!item) {
          throw new RuntimeWorkspaceGatewayError(
            'selection_stale',
            'Recipe selection token is stale',
          );
        }
        selection = {
          kind,
          recipe_ref: item.recipe_ref,
          recipe_hash: item.recipe_hash,
          recipe_kind: item.recipe_kind,
        };
      } else {
        throw new TaskWorkspaceApiError(
          'invalid_request',
          'kind must be temporary_workflow or published_recipe',
        );
      }
      const session = this.service.setRunSelection({
        sessionId: match[1]!,
        principalRef: this.principalRef,
        selection,
        expectedRowVersion: integer(body, 'expected_row_version'),
      });
      send(res, 200, { session });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/launch-intents$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      const launch = await this.service.run({
        sessionId: match[1]!,
        principalRef: this.principalRef,
        text: string(body, 'text', { max: 100_000 })!,
        selectionToken: string(body, 'selection_token', {
          optional: true,
          max: 16_384,
        }),
        idempotencyKey: string(body, 'idempotency_key', { max: 512 })!,
      });
      send(res, 202, { launch_intent: launch });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/launch-intents\/([^/]+)$/,
    );
    if (match && method === 'GET') {
      send(res, 200, {
        launch_intent: this.service.getLaunchIntent(
          match[1]!,
          this.principalRef,
        ),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/launch-intents\/([^/]+)\/(revise|confirm|cancel)$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      if (match[2] === 'revise') {
        const revision = await this.service.reviseTemporary({
          launchIntentId: match[1]!,
          principalRef: this.principalRef,
          instruction: string(body, 'instruction', { max: 100_000 })!,
        });
        send(res, 201, { revision });
        return;
      }
      if (match[2] === 'confirm') {
        const launch = await this.service.confirmTemporary({
          launchIntentId: match[1]!,
          revisionId: string(body, 'revision_id', { max: 512 })!,
          principalRef: this.principalRef,
          expectedRowVersion: integer(body, 'expected_row_version'),
        });
        send(res, 202, { launch_intent: launch });
        return;
      }
      const launch = this.service.cancelLaunch({
        launchIntentId: match[1]!,
        principalRef: this.principalRef,
        expectedRowVersion: integer(body, 'expected_row_version'),
      });
      send(res, 200, { launch_intent: launch });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/interactions\/([^/]+)\/submit$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      exactKeys(body, [
        'rendered_snapshot_hash',
        'action_id',
        'payload_json',
        'payload_hash',
        'expected_target_row_version',
        'idempotency_key',
      ]);
      send(
        res,
        200,
        this.service.submitInteraction({
          principalRef: this.principalRef,
          submission: {
            interaction_id: match[1]!,
            rendered_snapshot_hash: string(body, 'rendered_snapshot_hash', {
              max: 71,
            })! as Sha256Hash,
            action_id: string(body, 'action_id', { max: 255 })!,
            payload_json: jsonValue(body, 'payload_json'),
            payload_hash: string(body, 'payload_hash', {
              max: 71,
            })! as Sha256Hash,
            expected_target_row_version: integer(
              body,
              'expected_target_row_version',
            ),
            idempotency_key: string(body, 'idempotency_key', { max: 512 })!,
          },
        }),
      );
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/runtime-command-proposals$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      exactKeys(body, [
        'workflow_id',
        'run_id',
        'action',
        'expected_target_row_version',
        'idempotency_key',
      ]);
      const action = string(body, 'action', { max: 16 });
      if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
        throw new TaskWorkspaceApiError(
          'invalid_request',
          'action must be exactly pause, resume, or cancel',
        );
      }
      send(res, 201, {
        proposal: this.service.createCommandProposal({
          sessionId: match[1]!,
          principalRef: this.principalRef,
          workflowId: string(body, 'workflow_id', { max: 512 })!,
          runId: string(body, 'run_id', { max: 512 })!,
          action,
          expectedTargetRowVersion: integer(
            body,
            'expected_target_row_version',
          ),
          idempotencyKey: string(body, 'idempotency_key', { max: 512 })!,
        }),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/runtime-command-proposals\/([^/]+)\/confirm$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      exactKeys(body, ['expected_row_version', 'proposal_hash']);
      send(res, 200, {
        proposal: this.service.confirmCommandProposal({
          proposalId: match[1]!,
          principalRef: this.principalRef,
          expectedRowVersion: integer(body, 'expected_row_version'),
          proposalHash: string(body, 'proposal_hash', {
            max: 71,
          })! as Sha256Hash,
        }),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/replans$/,
    );
    if (match && method === 'GET') {
      send(res, 200, {
        replans: this.service.listReplans(match[1]!, this.principalRef),
      });
      return;
    }
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      exactKeys(body, [
        'workflow_id',
        'run_id',
        'instruction',
        'idempotency_key',
      ]);
      send(res, 201, {
        replan: await this.service.createReplan({
          sessionId: match[1]!,
          principalRef: this.principalRef,
          workflowId: string(body, 'workflow_id', { max: 512 })!,
          runId: string(body, 'run_id', { max: 512 })!,
          instruction: string(body, 'instruction', { max: 100_000 })!,
          idempotencyKey: string(body, 'idempotency_key', { max: 512 })!,
        }),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/replans\/([^/]+)\/(confirm|cancel)$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      if (match[2] === 'confirm') {
        exactKeys(body, ['expected_row_version', 'proposal_hash']);
      } else {
        exactKeys(body, ['expected_row_version']);
      }
      const common = {
        replanId: match[1]!,
        principalRef: this.principalRef,
        expectedRowVersion: integer(body, 'expected_row_version'),
      };
      send(res, 200, {
        replan:
          match[2] === 'confirm'
            ? this.service.confirmReplan({
                ...common,
                proposalHash: string(body, 'proposal_hash', {
                  max: 71,
                })! as Sha256Hash,
              })
            : this.service.cancelReplan(common),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/task-workspace\/sessions\/([^/]+)\/personal-workflow-drafts$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      exactKeys(body, ['workflow_id', 'run_id']);
      send(res, 201, {
        draft: await this.service.createPersonalWorkflowDraft({
          sessionId: match[1]!,
          principalRef: this.principalRef,
          workflowId: string(body, 'workflow_id', { max: 512 })!,
          runId: string(body, 'run_id', { max: 512 })!,
        }),
      });
      return;
    }
    match = segment(pathname, /^\/api\/personal-workflows\/drafts\/([^/]+)$/);
    if (match && method === 'GET') {
      send(res, 200, {
        draft: this.service.getPersonalWorkflowDraft(
          match[1]!,
          this.principalRef,
        ),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/personal-workflows\/drafts\/([^/]+)\/(revise|validate|dry-run|review|publish)$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      if (match[2] === 'revise') {
        exactKeys(body, ['expected_row_version', 'source_json']);
        send(res, 201, {
          draft: this.service.revisePersonalWorkflow({
            draftId: match[1]!,
            principalRef: this.principalRef,
            expectedRowVersion: integer(body, 'expected_row_version'),
            source: jsonObject(body, 'source_json'),
          }),
        });
        return;
      }
      if (match[2] === 'review') {
        exactKeys(body, ['expected_row_version', 'review']);
        const review = jsonObject(body, 'review');
        exactKeys(review, ['approved', 'display_name', 'description']);
        if (review.approved !== true) {
          throw new TaskWorkspaceApiError(
            'invalid_request',
            'review.approved must be true',
          );
        }
        const displayName = string(review, 'display_name', { max: 255 })!;
        const description = string(review, 'description', {
          optional: true,
          max: 2_000,
        });
        send(res, 200, {
          draft: this.service.advancePersonalWorkflow({
            draftId: match[1]!,
            principalRef: this.principalRef,
            expectedRowVersion: integer(body, 'expected_row_version'),
            action: 'review',
            review: {
              approved: true,
              display_name: displayName,
              description,
            },
          }),
        });
        return;
      }
      if (match[2] === 'publish') {
        exactKeys(body, ['expected_row_version', 'idempotency_key']);
      } else {
        exactKeys(body, ['expected_row_version']);
      }
      send(res, 200, {
        draft: this.service.advancePersonalWorkflow({
          draftId: match[1]!,
          principalRef: this.principalRef,
          expectedRowVersion: integer(body, 'expected_row_version'),
          action: match[2]! as 'validate' | 'dry-run' | 'review' | 'publish',
          review: null,
          idempotencyKey:
            match[2] === 'publish'
              ? string(body, 'idempotency_key', { max: 512 })!
              : null,
        }),
      });
      return;
    }
    match = segment(
      pathname,
      /^\/api\/personal-workflows\/releases\/([^/]+)\/activate$/,
    );
    if (match && method === 'POST') {
      const body = await jsonBody(req);
      exactKeys(body, ['expected_pointer_row_version', 'idempotency_key']);
      send(res, 200, {
        draft: this.service.activatePersonalWorkflow({
          releaseId: match[1]!,
          principalRef: this.principalRef,
          expectedPointerRowVersion: nullableInteger(
            body,
            'expected_pointer_row_version',
          ),
          idempotencyKey: string(body, 'idempotency_key', { max: 512 })!,
        }),
      });
      return;
    }
    if (
      /^\/api\/personal-workflows\/releases\/[^/]+\/export$/.test(pathname) ||
      pathname === `${PERSONAL_PREFIX}/import`
    ) {
      throw new TaskWorkspaceApiError(
        'not_implemented',
        'Personal Workflow export/import is deferred',
        501,
      );
    }
    throw new TaskWorkspaceApiError(
      'not_found',
      'Task Workspace route not found',
      404,
    );
  }
}
