import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';

export type RuntimeCenterView =
  | 'workflows'
  | 'agent_executions'
  | 'pending'
  | 'trace';

export type ProjectionGenerationState = 'ready' | 'rebuilding' | 'degraded';

export interface WorkflowProjectionRow extends JsonObject {
  readonly id: string;
  readonly view: RuntimeCenterView;
  readonly source_stream: string;
  readonly source_row_version: number;
  readonly source_event_seq: number;
  readonly projected_at_ms: number;
  readonly updated_at_ms: number;
  readonly started_at_ms: number | null;
  readonly deadline_at_ms: number | null;
  readonly severity_rank: number | null;
  readonly feature_id: string | null;
  readonly workflow_status: string | null;
  readonly operational_state: string | null;
  readonly source_kind: string;
  readonly pending_kind: string | null;
  readonly trace_root_kind: string | null;
  readonly workflow_id: string | null;
  readonly run_id: string | null;
  readonly summary: JsonObject;
}

export interface RuntimeCenterProjectionStatus {
  readonly state: ProjectionGenerationState;
  readonly projection_version: string;
  readonly source_head_seq: number;
  readonly projected_head_seq: number;
  readonly last_success_at_ms: number | null;
  readonly degradation_code: string | null;
}

export type WorkflowProjectionMutation =
  | {
      readonly kind: 'upsert';
      readonly row: WorkflowProjectionRow;
    }
  | {
      readonly kind: 'delete';
      readonly view: RuntimeCenterView;
      readonly rowId: string;
    };

export interface WorkflowProjectionEvent {
  readonly sourceStream: string;
  readonly sourceSeq: number;
  readonly previousEventHash: Sha256Hash | null;
  readonly mutations: readonly WorkflowProjectionMutation[];
  readonly occurredAtMs: number;
  readonly eventHash: Sha256Hash;
}

export function calculateWorkflowProjectionEventHash(
  event: Omit<WorkflowProjectionEvent, 'eventHash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-projection-event:1\n',
    event as unknown as JsonObject,
  );
}

interface ProjectionGeneration {
  readonly id: string;
  readonly rows: Map<string, WorkflowProjectionRow>;
  status: RuntimeCenterProjectionStatus;
}

interface SourceHead {
  readonly sequence: number;
  readonly hash: Sha256Hash;
}

export interface ProjectionRebuildExport {
  readonly rows: readonly WorkflowProjectionRow[];
  readonly rowsHash: Sha256Hash;
  readonly sourceHeadSeq: number;
}

export interface ProjectionRebuildReceipt {
  readonly jobRef: string;
  readonly disposition: 'rebuilt' | 'duplicate';
  readonly generationId: string;
}

function rowsHash(rows: readonly WorkflowProjectionRow[]): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-projection-rows:1\n',
    [...rows].sort((left, right) => left.id.localeCompare(right.id, 'en')),
  );
}

function assertProjectionRow(row: WorkflowProjectionRow): void {
  if (
    row.id.length === 0 ||
    !Number.isSafeInteger(row.source_row_version) ||
    row.source_row_version < 0 ||
    !Number.isSafeInteger(row.source_event_seq) ||
    row.source_event_seq < 0 ||
    !Number.isSafeInteger(row.projected_at_ms) ||
    !Number.isSafeInteger(row.updated_at_ms)
  )
    throw new Error('projection_row_invalid');
}

export class WorkflowProjectionStore {
  private readonly active = new Map<RuntimeCenterView, ProjectionGeneration>();
  private readonly sourceHeads = new Map<string, SourceHead>();
  private readonly rebuildJobs = new Map<string, ProjectionRebuildReceipt>();

  constructor(readonly projectionVersion = 'g7.1') {
    for (const view of [
      'workflows',
      'agent_executions',
      'pending',
      'trace',
    ] as const) {
      this.active.set(view, {
        id: `generation:${view}:0`,
        rows: new Map(),
        status: {
          state: 'ready',
          projection_version: projectionVersion,
          source_head_seq: 0,
          projected_head_seq: 0,
          last_success_at_ms: null,
          degradation_code: null,
        },
      });
    }
  }

  consume(
    event: WorkflowProjectionEvent,
  ): 'applied' | 'duplicate' | 'degraded' {
    const expectedHash = calculateWorkflowProjectionEventHash({
      sourceStream: event.sourceStream,
      sourceSeq: event.sourceSeq,
      previousEventHash: event.previousEventHash,
      mutations: event.mutations,
      occurredAtMs: event.occurredAtMs,
    });
    const affected = new Set(
      event.mutations.map((mutation) =>
        mutation.kind === 'upsert' ? mutation.row.view : mutation.view,
      ),
    );
    const head = this.sourceHeads.get(event.sourceStream);
    if (head && event.sourceSeq === head.sequence) {
      if (head.hash === event.eventHash && expectedHash === event.eventHash)
        return 'duplicate';
      this.degrade(affected, event.sourceSeq, 'source_event_hash_mismatch');
      return 'degraded';
    }
    if (
      expectedHash !== event.eventHash ||
      event.sourceSeq !== (head?.sequence ?? 0) + 1 ||
      event.previousEventHash !== (head?.hash ?? null)
    ) {
      this.degrade(
        affected,
        event.sourceSeq,
        expectedHash !== event.eventHash
          ? 'source_event_hash_mismatch'
          : 'source_sequence_gap',
      );
      return 'degraded';
    }
    for (const mutation of event.mutations) {
      if (mutation.kind === 'delete') continue;
      assertProjectionRow(mutation.row);
      if (
        mutation.row.source_stream !== event.sourceStream ||
        mutation.row.source_event_seq !== event.sourceSeq
      ) {
        this.degrade(
          new Set([mutation.row.view]),
          event.sourceSeq,
          'projection_row_source_binding_mismatch',
        );
        return 'degraded';
      }
    }
    for (const mutation of event.mutations) {
      const generation = this.active.get(
        mutation.kind === 'upsert' ? mutation.row.view : mutation.view,
      )!;
      if (generation.status.state !== 'ready') continue;
      if (mutation.kind === 'delete') {
        generation.rows.delete(mutation.rowId);
      } else {
        generation.rows.set(mutation.row.id, structuredClone(mutation.row));
      }
      generation.status = {
        ...generation.status,
        source_head_seq: event.sourceSeq,
        projected_head_seq: event.sourceSeq,
        last_success_at_ms: event.occurredAtMs,
      };
    }
    this.sourceHeads.set(event.sourceStream, {
      sequence: event.sourceSeq,
      hash: event.eventHash,
    });
    return 'applied';
  }

  private degrade(
    views: ReadonlySet<RuntimeCenterView>,
    sourceHead: number,
    code: string,
  ): void {
    for (const view of views) {
      const generation = this.active.get(view)!;
      generation.status = {
        ...generation.status,
        state: 'degraded',
        source_head_seq: Math.max(
          generation.status.source_head_seq,
          sourceHead,
        ),
        degradation_code: code,
      };
    }
  }

  rows(view: RuntimeCenterView): readonly WorkflowProjectionRow[] {
    return [...this.active.get(view)!.rows.values()].map((row) =>
      structuredClone(row),
    );
  }

  row(view: RuntimeCenterView, id: string): WorkflowProjectionRow | undefined {
    const row = this.active.get(view)!.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  status(view: RuntimeCenterView): RuntimeCenterProjectionStatus {
    return { ...this.active.get(view)!.status };
  }

  rebuild(
    view: RuntimeCenterView,
    jobRef: string,
    exported: ProjectionRebuildExport,
    completedAtMs: number,
  ): ProjectionRebuildReceipt {
    const existing = this.rebuildJobs.get(jobRef);
    if (existing) return { ...existing, disposition: 'duplicate' };
    const previous = this.active.get(view)!;
    previous.status = { ...previous.status, state: 'rebuilding' };
    const ids = new Set<string>();
    try {
      for (const row of exported.rows) {
        assertProjectionRow(row);
        if (
          row.view !== view ||
          row.source_event_seq > exported.sourceHeadSeq ||
          ids.has(row.id)
        )
          throw new Error('projection_rebuild_row_invalid');
        ids.add(row.id);
      }
      if (rowsHash(exported.rows) !== exported.rowsHash)
        throw new Error('projection_rebuild_hash_mismatch');
      const generationId = `generation:${view}:${exported.sourceHeadSeq}:${exported.rowsHash}`;
      const generation: ProjectionGeneration = {
        id: generationId,
        rows: new Map(
          exported.rows.map((row) => [row.id, structuredClone(row)]),
        ),
        status: {
          state: 'ready',
          projection_version: this.projectionVersion,
          source_head_seq: exported.sourceHeadSeq,
          projected_head_seq: exported.sourceHeadSeq,
          last_success_at_ms: completedAtMs,
          degradation_code: null,
        },
      };
      this.active.set(view, generation);
      const receipt: ProjectionRebuildReceipt = {
        jobRef,
        disposition: 'rebuilt',
        generationId,
      };
      this.rebuildJobs.set(jobRef, receipt);
      return receipt;
    } catch (error) {
      previous.status = {
        ...previous.status,
        state: 'degraded',
        degradation_code:
          error instanceof Error ? error.message : 'projection_rebuild_failed',
      };
      throw error;
    }
  }

  exportRowsHash(view: RuntimeCenterView): Sha256Hash {
    return rowsHash(this.rows(view));
  }

  canonicalState(view: RuntimeCenterView): string {
    return canonicalJson({
      rows: [...this.rows(view)],
      status: { ...this.status(view) },
    });
  }
}
