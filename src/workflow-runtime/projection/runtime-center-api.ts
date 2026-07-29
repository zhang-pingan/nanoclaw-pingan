import crypto from 'node:crypto';

import { canonicalJson } from '../contracts/hash.js';
import type { JsonObject } from '../contracts/types.js';
import {
  type ProjectionRebuildReceipt,
  type RuntimeCenterProjectionStatus,
  type RuntimeCenterView,
  type WorkflowProjectionRow,
  WorkflowProjectionStore,
  WorkflowProjectionRebuildAuthority,
} from './workflow-projection.js';

export type RuntimeCenterSort =
  | 'updated_desc'
  | 'started_desc'
  | 'deadline_asc'
  | 'severity_desc';

export interface RuntimeCenterFilters {
  readonly feature_id?: string;
  readonly workflow_status?: string;
  readonly operational_state?: string;
  readonly source_kind?: string;
  readonly pending_kind?: string;
  readonly trace_root_kind?: string;
  readonly started_from_at_ms?: number;
  readonly started_to_at_ms?: number;
}

export interface RuntimeCenterListRequest {
  readonly view: RuntimeCenterView;
  readonly page_size: number;
  readonly cursor: string | null;
  readonly filters: RuntimeCenterFilters;
  readonly sort: RuntimeCenterSort;
}

export interface RuntimeCenterListResponse {
  readonly items: readonly WorkflowProjectionRow[];
  readonly next_cursor: string | null;
  readonly snapshot_head_seq: number;
  readonly projection: RuntimeCenterProjectionStatus;
}

export type RuntimeCenterDeepLink =
  | {
      readonly format: 'icarus.runtime-link/1';
      readonly target: 'workflow';
      readonly workflow_id: string;
    }
  | {
      readonly format: 'icarus.runtime-link/1';
      readonly target: 'run';
      readonly workflow_id: string;
      readonly run_id: string;
    }
  | {
      readonly format: 'icarus.runtime-link/1';
      readonly target: 'node';
      readonly workflow_id: string;
      readonly run_id: string;
      readonly scope_id: string;
      readonly node_id: string;
    }
  | {
      readonly format: 'icarus.runtime-link/1';
      readonly target: 'attempt';
      readonly workflow_id: string;
      readonly run_id: string;
      readonly scope_id: string;
      readonly node_id: string;
      readonly attempt_id: string;
    }
  | {
      readonly format: 'icarus.runtime-link/1';
      readonly target: 'trace';
      readonly trace_id: string;
    }
  | {
      readonly format: 'icarus.runtime-link/1';
      readonly target: 'feature';
      readonly feature_id: string;
      readonly feature_route_id: string;
      readonly subject_ref: string;
    };

interface CursorPayload {
  readonly view: RuntimeCenterView;
  readonly filters: RuntimeCenterFilters;
  readonly sort: RuntimeCenterSort;
  readonly snapshot_head_seq: number;
  readonly last_tuple: JsonObject;
}

const views = new Set<RuntimeCenterView>([
  'workflows',
  'agent_executions',
  'pending',
  'trace',
]);
const filterKeys = new Set([
  'feature_id',
  'workflow_status',
  'operational_state',
  'source_kind',
  'pending_kind',
  'trace_root_kind',
  'started_from_at_ms',
  'started_to_at_ms',
]);
const viewFilters: Record<RuntimeCenterView, ReadonlySet<string>> = {
  workflows: new Set([
    'feature_id',
    'workflow_status',
    'operational_state',
    'source_kind',
    'started_from_at_ms',
    'started_to_at_ms',
  ]),
  agent_executions: new Set([
    'feature_id',
    'source_kind',
    'started_from_at_ms',
    'started_to_at_ms',
  ]),
  pending: new Set([
    'feature_id',
    'operational_state',
    'source_kind',
    'pending_kind',
    'started_from_at_ms',
    'started_to_at_ms',
  ]),
  trace: new Set([
    'feature_id',
    'source_kind',
    'trace_root_kind',
    'started_from_at_ms',
    'started_to_at_ms',
  ]),
};
const viewSorts: Record<RuntimeCenterView, ReadonlySet<RuntimeCenterSort>> = {
  workflows: new Set(['updated_desc', 'started_desc', 'deadline_asc']),
  agent_executions: new Set(['updated_desc', 'started_desc']),
  pending: new Set([
    'updated_desc',
    'started_desc',
    'deadline_asc',
    'severity_desc',
  ]),
  trace: new Set(['updated_desc', 'started_desc']),
};

export class RuntimeCenterApiError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'cursor_invalid'
      | 'cursor_mismatch'
      | 'target_not_found'
      | 'permission_denied'
      | 'broken_link_integrity_error',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeCenterApiError';
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tuple(
  row: WorkflowProjectionRow,
  sort: RuntimeCenterSort,
): JsonObject {
  switch (sort) {
    case 'updated_desc':
      return { value: row.updated_at_ms, id: row.id };
    case 'started_desc':
      return { value: row.started_at_ms ?? -1, id: row.id };
    case 'deadline_asc':
      return {
        value: row.deadline_at_ms ?? Number.MAX_SAFE_INTEGER,
        id: row.id,
      };
    case 'severity_desc':
      return { value: row.severity_rank ?? -1, id: row.id };
  }
}

function compareRows(
  left: WorkflowProjectionRow,
  right: WorkflowProjectionRow,
  sort: RuntimeCenterSort,
): number {
  const leftTuple = tuple(left, sort);
  const rightTuple = tuple(right, sort);
  const direction = sort === 'deadline_asc' ? 1 : -1;
  const values = Number(leftTuple.value) - Number(rightTuple.value);
  return values === 0
    ? compareAscii(String(leftTuple.id), String(rightTuple.id))
    : values * direction;
}

function normalizeFilters(filters: RuntimeCenterFilters): RuntimeCenterFilters {
  return Object.fromEntries(
    Object.entries(filters).sort(([left], [right]) =>
      compareAscii(left, right),
    ),
  ) as RuntimeCenterFilters;
}

function assertRequest(request: RuntimeCenterListRequest): void {
  if (
    !views.has(request.view) ||
    !Number.isSafeInteger(request.page_size) ||
    request.page_size < 1 ||
    request.page_size > 200 ||
    !viewSorts[request.view].has(request.sort) ||
    Object.keys(request.filters).some(
      (key) => !filterKeys.has(key) || !viewFilters[request.view].has(key),
    )
  )
    throw new RuntimeCenterApiError(
      'invalid_request',
      'Runtime Center request uses an unknown view, filter, sort, or page size',
    );
  for (const [key, value] of Object.entries(request.filters)) {
    if (
      (key.endsWith('_at_ms') &&
        (!Number.isSafeInteger(value) || Number(value) < 0)) ||
      (!key.endsWith('_at_ms') &&
        (typeof value !== 'string' || value.length === 0))
    )
      throw new RuntimeCenterApiError(
        'invalid_request',
        `Invalid filter ${key}`,
      );
  }
  if (
    request.filters.started_from_at_ms !== undefined &&
    request.filters.started_to_at_ms !== undefined &&
    request.filters.started_from_at_ms > request.filters.started_to_at_ms
  )
    throw new RuntimeCenterApiError(
      'invalid_request',
      'Runtime Center started time range is inverted',
    );
}

function matches(
  row: WorkflowProjectionRow,
  filters: RuntimeCenterFilters,
): boolean {
  return (
    (filters.feature_id === undefined ||
      row.feature_id === filters.feature_id) &&
    (filters.workflow_status === undefined ||
      row.workflow_status === filters.workflow_status) &&
    (filters.operational_state === undefined ||
      row.operational_state === filters.operational_state) &&
    (filters.source_kind === undefined ||
      row.source_kind === filters.source_kind) &&
    (filters.pending_kind === undefined ||
      row.pending_kind === filters.pending_kind) &&
    (filters.trace_root_kind === undefined ||
      row.trace_root_kind === filters.trace_root_kind) &&
    (filters.started_from_at_ms === undefined ||
      (row.started_at_ms !== null &&
        row.started_at_ms >= filters.started_from_at_ms)) &&
    (filters.started_to_at_ms === undefined ||
      (row.started_at_ms !== null &&
        row.started_at_ms <= filters.started_to_at_ms))
  );
}

export class RuntimeCenterProjectionApi {
  constructor(
    private readonly projection: WorkflowProjectionStore,
    private readonly cursorSecret: Buffer,
    private readonly rebuildAuthority: WorkflowProjectionRebuildAuthority | null =
      null,
  ) {
    if (cursorSecret.byteLength < 32)
      throw new RuntimeCenterApiError(
        'invalid_request',
        'Runtime Center cursor secret must contain at least 32 bytes',
      );
  }

  private sign(payload: CursorPayload): string {
    const encoded = Buffer.from(
      canonicalJson(payload as unknown as JsonObject),
      'utf8',
    ).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.cursorSecret)
      .update(encoded, 'ascii')
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  private parseCursor(cursor: string): CursorPayload {
    const [encoded, signature, extra] = cursor.split('.');
    if (!encoded || !signature || extra !== undefined)
      throw new RuntimeCenterApiError(
        'cursor_invalid',
        'Cursor shape is invalid',
      );
    const expected = crypto
      .createHmac('sha256', this.cursorSecret)
      .update(encoded, 'ascii')
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, 'base64url');
    } catch {
      throw new RuntimeCenterApiError(
        'cursor_invalid',
        'Cursor signature is invalid',
      );
    }
    if (
      supplied.byteLength !== expected.byteLength ||
      !crypto.timingSafeEqual(supplied, expected)
    )
      throw new RuntimeCenterApiError(
        'cursor_invalid',
        'Cursor signature is invalid',
      );
    try {
      return JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as CursorPayload;
    } catch {
      throw new RuntimeCenterApiError(
        'cursor_invalid',
        'Cursor payload is invalid',
      );
    }
  }

  list(request: RuntimeCenterListRequest): RuntimeCenterListResponse {
    assertRequest(request);
    const filters = normalizeFilters(request.filters);
    const status = this.projection.status(request.view);
    let rows = this.projection
      .rows(request.view)
      .filter((row) => matches(row, filters))
      .sort((left, right) => compareRows(left, right, request.sort));
    if (request.cursor !== null) {
      const cursor = this.parseCursor(request.cursor);
      if (
        cursor.view !== request.view ||
        cursor.sort !== request.sort ||
        cursor.snapshot_head_seq !== status.projected_head_seq ||
        canonicalJson(cursor.filters as unknown as JsonObject) !==
          canonicalJson(filters as unknown as JsonObject)
      )
        throw new RuntimeCenterApiError(
          'cursor_mismatch',
          'Cursor is not bound to this view snapshot',
        );
      const index = rows.findIndex(
        (row) =>
          canonicalJson(tuple(row, request.sort)) ===
          canonicalJson(cursor.last_tuple),
      );
      if (index < 0)
        throw new RuntimeCenterApiError(
          'cursor_mismatch',
          'Cursor row is no longer in the bound snapshot',
        );
      rows = rows.slice(index + 1);
    }
    const items = rows.slice(0, request.page_size);
    const nextCursor =
      rows.length > request.page_size
        ? this.sign({
            view: request.view,
            filters,
            sort: request.sort,
            snapshot_head_seq: status.projected_head_seq,
            last_tuple: tuple(items[items.length - 1]!, request.sort),
          })
        : null;
    return {
      items,
      next_cursor: nextCursor,
      snapshot_head_seq: status.projected_head_seq,
      projection: status,
    };
  }

  workflowDetail(workflowId: string): JsonObject {
    const row = this.projection.row('workflows', workflowId);
    if (!row)
      throw new RuntimeCenterApiError(
        'target_not_found',
        'Workflow projection is unavailable',
      );
    if (row.workflow_id !== workflowId)
      throw new RuntimeCenterApiError(
        'broken_link_integrity_error',
        'Workflow projection lineage is inconsistent',
      );
    return {
      item: row,
      projection: {
        ...this.projection.status('workflows'),
      } as unknown as JsonObject,
      source_row_version: row.source_row_version,
      link: {
        format: 'icarus.runtime-link/1',
        target: 'workflow',
        workflow_id: workflowId,
      },
    };
  }

  runDetail(runId: string): JsonObject {
    const row = this.projection
      .rows('workflows')
      .find((candidate) => candidate.run_id === runId);
    if (!row || !row.workflow_id)
      throw new RuntimeCenterApiError(
        'target_not_found',
        'Run projection is unavailable',
      );
    return {
      item: row,
      projection: {
        ...this.projection.status('workflows'),
      } as unknown as JsonObject,
      source_row_version: row.source_row_version,
      link: {
        format: 'icarus.runtime-link/1',
        target: 'run',
        workflow_id: row.workflow_id,
        run_id: runId,
      },
    };
  }

  rebuild(
    view: RuntimeCenterView,
    jobRef: string,
    actor: {
      readonly actorKind: string;
      readonly permissions: ReadonlySet<string>;
    },
    nowMs: number,
  ): ProjectionRebuildReceipt {
    if (
      actor.actorKind !== 'human' ||
      !actor.permissions.has('runtime.diagnose')
    )
      throw new RuntimeCenterApiError(
        'permission_denied',
        'Projection rebuild requires a diagnostic Human actor',
      );
    if (!this.rebuildAuthority)
      throw new RuntimeCenterApiError(
        'invalid_request',
        'Projection rebuild authority is unavailable',
      );
    return this.projection.rebuild(
      view,
      jobRef,
      this.rebuildAuthority.export(view),
      nowMs,
    );
  }
}

export function assertRuntimeCenterDeepLink(
  link: RuntimeCenterDeepLink,
  lineage: (link: RuntimeCenterDeepLink) => boolean,
): void {
  if (link.format !== 'icarus.runtime-link/1' || !lineage(link))
    throw new RuntimeCenterApiError(
      'broken_link_integrity_error',
      'Runtime Center deep link lineage is invalid',
    );
}
