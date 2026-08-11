import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import { WorkflowRuntimeStore } from '../store/runtime-store/index.js';

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
  readonly pack_id: string | null;
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
  readonly view: RuntimeCenterView;
  readonly rows: readonly WorkflowProjectionRow[];
  readonly rowCount: number;
  readonly rowsHash: Sha256Hash;
  readonly sourceHeadSeq: number;
  readonly sourceHeadHash: Sha256Hash;
  readonly authorityRef: string;
  readonly authorityProof: Sha256Hash;
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

function sourceHeadHash(
  view: RuntimeCenterView,
  sourceHeadSeq: number,
  sourceHeads: ReadonlyMap<string, SourceHead>,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-projection-rebuild-source-head:1\n',
    {
      view,
      source_head_seq: sourceHeadSeq,
      source_heads: [...sourceHeads.entries()]
        .map(([stream, head]) => ({ stream, ...head }))
        .sort((left, right) => left.stream.localeCompare(right.stream, 'en')),
    },
  );
}

function rebuildAuthorityProof(
  exported: Omit<ProjectionRebuildExport, 'authorityProof'>,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-projection-rebuild-authority:1\n',
    exported as unknown as JsonObject,
  );
}

export function runtimeCenterProjectionGenerationId(
  view: RuntimeCenterView,
  sourceHeadSeq: number,
  rowsHashValue: Sha256Hash,
): string {
  return `generation:${view}:${sourceHeadSeq}:${rowsHashValue}`;
}

const trustedRebuildExports = new WeakMap<
  ProjectionRebuildExport,
  {
    readonly authority: RuntimeStoreWorkflowProjectionRebuildAuthority;
    readonly issuedProof: Sha256Hash;
  }
>();

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
  private readonly rebuildJobs = new Map<
    string,
    {
      readonly view: RuntimeCenterView;
      readonly authorityProof: Sha256Hash;
      readonly receipt: ProjectionRebuildReceipt;
    }
  >();

  constructor(
    readonly projectionVersion = 'g7.1',
    private readonly rebuildAuthority: RuntimeStoreWorkflowProjectionRebuildAuthority | null = null,
  ) {
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
    const issued = trustedRebuildExports.get(exported);
    if (
      !this.rebuildAuthority ||
      issued?.authority !== this.rebuildAuthority ||
      issued.issuedProof !== exported.authorityProof ||
      exported.authorityRef !== this.rebuildAuthority.authorityRef
    )
      throw new Error('projection_rebuild_source_untrusted');
    const existing = this.rebuildJobs.get(jobRef);
    if (existing) {
      if (
        existing.view !== view ||
        existing.authorityProof !== exported.authorityProof
      )
        throw new Error('projection_rebuild_job_conflict');
      return { ...existing.receipt, disposition: 'duplicate' };
    }
    const previous = this.active.get(view)!;
    previous.status = { ...previous.status, state: 'rebuilding' };
    const ids = new Set<string>();
    try {
      if (
        exported.view !== view ||
        exported.rowCount !== exported.rows.length ||
        exported.sourceHeadSeq < 0 ||
        !Number.isSafeInteger(exported.sourceHeadSeq)
      )
        throw new Error('projection_rebuild_export_invalid');
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
      if (
        rebuildAuthorityProof({
          view: exported.view,
          rows: exported.rows,
          rowCount: exported.rowCount,
          rowsHash: exported.rowsHash,
          sourceHeadSeq: exported.sourceHeadSeq,
          sourceHeadHash: exported.sourceHeadHash,
          authorityRef: exported.authorityRef,
        }) !== exported.authorityProof
      )
        throw new Error('projection_rebuild_authority_proof_mismatch');
      const generationId = runtimeCenterProjectionGenerationId(
        view,
        exported.sourceHeadSeq,
        exported.rowsHash,
      );
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
      this.rebuildJobs.set(jobRef, {
        view,
        authorityProof: exported.authorityProof,
        receipt,
      });
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

  canonicalState(view: RuntimeCenterView): string {
    return canonicalJson({
      rows: [...this.rows(view)],
      status: { ...this.status(view) },
    });
  }
}

interface RuntimeProjectionEventRow extends Record<string, unknown> {
  readonly graph_run_id: string;
  readonly workflow_id: string;
  readonly seq: number;
  readonly next_event_seq: number;
  readonly scope_id: string | null;
  readonly node_id: string | null;
  readonly attempt_id: string | null;
  readonly event_type: string;
  readonly idempotency_key: string;
  readonly payload_json: string | null;
  readonly payload_value_id: string | null;
  readonly payload_hash: Sha256Hash | null;
  readonly occurred_at_ms: number;
  readonly created_at_ms: number;
  readonly value_content_hash: Sha256Hash | null;
  readonly value_payload_state: string | null;
}

function assertCanonicalStoredJson(value: string, label: string): JsonObject {
  let parsed: JsonObject;
  try {
    parsed = JSON.parse(value) as JsonObject;
  } catch (error) {
    throw new Error(`${label}_json_invalid`, { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    canonicalJson(parsed) !== value
  )
    throw new Error(`${label}_json_noncanonical`);
  return parsed;
}

function loadTrustedRuntimeEvents(
  source: WorkflowRuntimeStore,
): readonly RuntimeProjectionEventRow[] {
  const events = source.queryAll<RuntimeProjectionEventRow>(
    `SELECT event.graph_run_id, run.workflow_id, event.seq,
            run.next_event_seq, event.scope_id, event.node_id, event.attempt_id,
            event.event_type, event.idempotency_key, event.payload_json,
            event.payload_value_id, event.payload_hash, event.occurred_at_ms,
            event.created_at_ms, value.content_hash AS value_content_hash,
            value.payload_state AS value_payload_state
       FROM workflow_graph_events AS event
       JOIN workflow_graph_runs AS run ON run.id = event.graph_run_id
       LEFT JOIN workflow_values AS value ON value.id = event.payload_value_id
      ORDER BY event.graph_run_id COLLATE BINARY, event.seq`,
    [],
  );
  const runs = source.queryAll<
    {
      id: string;
      next_event_seq: number;
    } & Record<string, unknown>
  >(
    'SELECT id, next_event_seq FROM workflow_graph_runs ORDER BY id COLLATE BINARY',
    [],
  );
  const observed = new Map<string, number>();
  for (const event of events) {
    const expectedSequence = (observed.get(event.graph_run_id) ?? 0) + 1;
    if (
      event.seq !== expectedSequence ||
      event.seq > event.next_event_seq ||
      !Number.isSafeInteger(event.occurred_at_ms) ||
      !Number.isSafeInteger(event.created_at_ms)
    )
      throw new Error('projection_runtime_event_sequence_invalid');
    observed.set(event.graph_run_id, event.seq);
    if (event.payload_json !== null)
      assertCanonicalStoredJson(event.payload_json, 'projection_runtime_event');
    if (
      (event.payload_value_id === null) !== (event.payload_hash === null) ||
      (event.payload_value_id !== null &&
        (event.value_content_hash !== event.payload_hash ||
          event.value_payload_state !== 'live'))
    )
      throw new Error('projection_runtime_event_value_binding_invalid');
  }
  for (const run of runs) {
    if ((observed.get(run.id) ?? 0) !== run.next_event_seq)
      throw new Error('projection_runtime_event_head_invalid');
  }
  return events;
}

function workflowRows(source: WorkflowRuntimeStore): WorkflowProjectionRow[] {
  const rows = source.queryAll<
    {
      id: string;
      status: string;
      operational_state: string;
      current_graph_run_id: string | null;
      workflow_revision: number;
      row_version: number;
      started_at_ms: number;
      deadline_at_ms: number | null;
      updated_at_ms: number;
      state_key: string | null;
      next_event_seq: number | null;
    } & Record<string, unknown>
  >(
    `SELECT workflow.id, workflow.status, workflow.operational_state,
            workflow.current_graph_run_id, workflow.workflow_revision,
            workflow.row_version, workflow.started_at_ms,
            workflow.deadline_at_ms, workflow.updated_at_ms,
            run.state_key, run.next_event_seq
       FROM workflows AS workflow
       LEFT JOIN workflow_graph_runs AS run
         ON run.id = workflow.current_graph_run_id
      ORDER BY workflow.id COLLATE BINARY`,
    [],
  );
  return rows.map((row) => ({
    id: row.id,
    view: 'workflows',
    source_stream: row.current_graph_run_id
      ? `runtime:graph-events:${row.current_graph_run_id}`
      : 'runtime:workflows',
    source_row_version: row.row_version,
    source_event_seq: row.next_event_seq ?? 0,
    projected_at_ms: row.updated_at_ms,
    updated_at_ms: row.updated_at_ms,
    started_at_ms: row.started_at_ms,
    deadline_at_ms: row.deadline_at_ms,
    severity_rank:
      row.operational_state === 'quarantined'
        ? 0
        : row.operational_state === 'action_required'
          ? 1
          : null,
    pack_id: null,
    workflow_status: row.status,
    operational_state: row.operational_state,
    source_kind: 'runtime_store',
    pending_kind: null,
    trace_root_kind: null,
    workflow_id: row.id,
    run_id: row.current_graph_run_id,
    summary: {
      state_key: row.state_key,
      workflow_revision: row.workflow_revision,
    },
  }));
}

function agentExecutionRows(
  source: WorkflowRuntimeStore,
): WorkflowProjectionRow[] {
  const rows = source.queryAll<
    {
      id: string;
      graph_run_id: string;
      workflow_id: string;
      node_id: string;
      phase: string;
      execution_outcome: string | null;
      row_version: number;
      created_at_ms: number;
      updated_at_ms: number;
      execution_started_at_ms: number | null;
      execution_deadline_at_ms: number | null;
      next_event_seq: number;
    } & Record<string, unknown>
  >(
    `SELECT attempt.id, attempt.graph_run_id, run.workflow_id,
            attempt.node_id, attempt.phase, attempt.execution_outcome,
            attempt.row_version, attempt.created_at_ms, attempt.updated_at_ms,
            attempt.execution_started_at_ms, attempt.execution_deadline_at_ms,
            run.next_event_seq
       FROM workflow_graph_node_attempts AS attempt
       JOIN workflow_graph_runs AS run ON run.id = attempt.graph_run_id
      ORDER BY attempt.id COLLATE BINARY`,
    [],
  );
  return rows.map((row) => ({
    id: row.id,
    view: 'agent_executions',
    source_stream: `runtime:graph-events:${row.graph_run_id}`,
    source_row_version: row.row_version,
    source_event_seq: row.next_event_seq,
    projected_at_ms: row.updated_at_ms,
    updated_at_ms: row.updated_at_ms,
    started_at_ms: row.execution_started_at_ms ?? row.created_at_ms,
    deadline_at_ms: row.execution_deadline_at_ms,
    severity_rank: null,
    pack_id: null,
    workflow_status: null,
    operational_state: null,
    source_kind: 'runtime_store',
    pending_kind: null,
    trace_root_kind: 'agent_execution',
    workflow_id: row.workflow_id,
    run_id: row.graph_run_id,
    summary: {
      node_id: row.node_id,
      phase: row.phase,
      execution_outcome: row.execution_outcome,
    },
  }));
}

function pendingRows(source: WorkflowRuntimeStore): WorkflowProjectionRow[] {
  const rows = source.queryAll<
    {
      id: string;
      workflow_id: string;
      graph_run_id: string;
      blocker_kind: string;
      severity: string;
      row_version: number;
      opened_at_ms: number;
      remediation_deadline_at_ms: number;
      next_event_seq: number;
    } & Record<string, unknown>
  >(
    `SELECT blocker.id, blocker.workflow_id, blocker.graph_run_id,
            blocker.blocker_kind, blocker.severity, blocker.row_version,
            blocker.opened_at_ms, blocker.remediation_deadline_at_ms,
            run.next_event_seq
       FROM workflow_operational_blockers AS blocker
       JOIN workflow_graph_runs AS run ON run.id = blocker.graph_run_id
      WHERE blocker.status = 'open'
      ORDER BY blocker.id COLLATE BINARY`,
    [],
  );
  return rows.map((row) => ({
    id: row.id,
    view: 'pending',
    source_stream: `runtime:graph-events:${row.graph_run_id}`,
    source_row_version: row.row_version,
    source_event_seq: row.next_event_seq,
    projected_at_ms: row.opened_at_ms,
    updated_at_ms: row.opened_at_ms,
    started_at_ms: row.opened_at_ms,
    deadline_at_ms: row.remediation_deadline_at_ms,
    severity_rank: row.severity === 'quarantine' ? 0 : 1,
    pack_id: null,
    workflow_status: null,
    operational_state: row.severity,
    source_kind: 'runtime_store',
    pending_kind: row.blocker_kind,
    trace_root_kind: null,
    workflow_id: row.workflow_id,
    run_id: row.graph_run_id,
    summary: { blocker_kind: row.blocker_kind, severity: row.severity },
  }));
}

function traceRows(
  events: readonly RuntimeProjectionEventRow[],
): WorkflowProjectionRow[] {
  return events.map((event) => ({
    id: `event:${event.graph_run_id}:${event.seq}`,
    view: 'trace',
    source_stream: `runtime:graph-events:${event.graph_run_id}`,
    source_row_version: event.seq,
    source_event_seq: event.seq,
    projected_at_ms: event.created_at_ms,
    updated_at_ms: event.created_at_ms,
    started_at_ms: event.occurred_at_ms,
    deadline_at_ms: null,
    severity_rank: event.event_type === 'orchestration_error' ? 0 : null,
    pack_id: null,
    workflow_status: null,
    operational_state: null,
    source_kind: 'runtime_store_event',
    pending_kind: null,
    trace_root_kind: 'workflow',
    workflow_id: event.workflow_id,
    run_id: event.graph_run_id,
    summary: {
      event_type: event.event_type,
      idempotency_key: event.idempotency_key,
      scope_id: event.scope_id,
      node_id: event.node_id,
      attempt_id: event.attempt_id,
    },
  }));
}

function freezeExport(
  exported: ProjectionRebuildExport,
): ProjectionRebuildExport {
  for (const row of exported.rows) {
    Object.freeze(row.summary);
    Object.freeze(row);
  }
  Object.freeze(exported.rows);
  return Object.freeze(exported);
}

export class RuntimeStoreWorkflowProjectionRebuildAuthority {
  constructor(
    readonly source: WorkflowRuntimeStore,
    readonly authorityRef: string,
  ) {
    if (!(source instanceof WorkflowRuntimeStore))
      throw new Error('projection_rebuild_runtime_store_required');
    if (authorityRef.length === 0)
      throw new Error('projection_rebuild_authority_ref_invalid');
  }

  export(view: RuntimeCenterView): ProjectionRebuildExport {
    if (!this.source.isOpen)
      throw new Error('projection_rebuild_runtime_store_closed');
    const events = loadTrustedRuntimeEvents(this.source);
    const rows = (
      view === 'workflows'
        ? workflowRows(this.source)
        : view === 'agent_executions'
          ? agentExecutionRows(this.source)
          : view === 'pending'
            ? pendingRows(this.source)
            : traceRows(events)
    ).sort((left, right) => left.id.localeCompare(right.id, 'en'));
    const sourceHeadSeq = events.length;
    const sourceHeadHash = domainSeparatedSha256(
      'icarus:workflow-projection-runtime-store-source-head:1\n',
      {
        database_schema_version: this.source.schemaVersion,
        view,
        source_event_count: events.length,
        events: events.map((event) => ({
          graph_run_id: event.graph_run_id,
          seq: event.seq,
          scope_id: event.scope_id,
          node_id: event.node_id,
          attempt_id: event.attempt_id,
          event_type: event.event_type,
          idempotency_key: event.idempotency_key,
          payload_json: event.payload_json,
          payload_value_id: event.payload_value_id,
          payload_hash: event.payload_hash,
          occurred_at_ms: event.occurred_at_ms,
          created_at_ms: event.created_at_ms,
        })),
        projected_rows_hash: rowsHash(rows),
      },
    );
    const withoutProof: Omit<ProjectionRebuildExport, 'authorityProof'> = {
      view,
      rows,
      rowCount: rows.length,
      rowsHash: rowsHash(rows),
      sourceHeadSeq,
      sourceHeadHash,
      authorityRef: this.authorityRef,
    };
    const exported = freezeExport({
      ...withoutProof,
      authorityProof: rebuildAuthorityProof(withoutProof),
    });
    trustedRebuildExports.set(exported, {
      authority: this,
      issuedProof: exported.authorityProof,
    });
    return exported;
  }
}
