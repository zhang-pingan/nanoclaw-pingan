import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CapacitySnapshotPublisher,
  CapacitySnapshotWatcher,
} from '../capacity/publication.js';
import {
  RuntimeCenterCapacityApi,
  RUNTIME_CENTER_CAPACITY_ROUTES,
} from '../capacity/runtime-center-api.js';
import { calculateDeploymentCapacityConfigHash } from '../contracts/capacity-control-plane-source.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject } from '../contracts/types.js';
import { createG7Fixture, g7Hash } from '../runtime/g7-test-support.js';
import {
  assertRuntimeCenterDeepLink,
  RuntimeCenterApiError,
  RuntimeCenterProjectionApi,
  type RuntimeCenterDeepLink,
} from './runtime-center-api.js';
import {
  createRuntimeCenterCapacityRendererState,
  createRuntimeCenterRendererState,
} from './runtime-center-renderer/entry.js';
import {
  calculateWorkflowProjectionEventHash,
  RuntimeStoreWorkflowProjectionRebuildAuthority,
  WorkflowProjectionStore,
  type RuntimeCenterView,
  type ProjectionRebuildExport,
  type WorkflowProjectionEvent,
  type WorkflowProjectionRow,
} from './workflow-projection.js';

const projectionFixtures: ReturnType<typeof createG7Fixture>[] = [];

afterEach(() => {
  while (projectionFixtures.length > 0)
    projectionFixtures.pop()!.instance.cleanup();
});

function projectionFixture(key: string): ReturnType<typeof createG7Fixture> {
  const created = createG7Fixture(`projection-${key}`);
  projectionFixtures.push(created);
  return created;
}

const badHash = domainSeparatedSha256(
  'icarus:g7-projection-test-tamper:1\n',
  {},
);

function row(
  id: string,
  sourceSeq: number,
  overrides: Partial<WorkflowProjectionRow> = {},
): WorkflowProjectionRow {
  return {
    id,
    view: 'workflows',
    source_stream: 'runtime:workflows',
    source_row_version: 1,
    source_event_seq: sourceSeq,
    projected_at_ms: 100 + sourceSeq,
    updated_at_ms: 100 + sourceSeq,
    started_at_ms: 50 + sourceSeq,
    deadline_at_ms: 1_000 + sourceSeq,
    severity_rank: null,
    pack_id: 'pack:g7',
    workflow_status: 'active',
    operational_state: 'healthy',
    source_kind: 'runtime',
    pending_kind: null,
    trace_root_kind: null,
    workflow_id: id,
    run_id: `run:${id}`,
    summary: { label: id },
    ...overrides,
  };
}

function event(
  sourceSeq: number,
  previousEventHash: `sha256:${string}` | null,
  rows: readonly WorkflowProjectionRow[],
  sourceStream = 'runtime:workflows',
): WorkflowProjectionEvent {
  const base = {
    sourceStream,
    sourceSeq,
    previousEventHash,
    mutations: rows.map((value) => ({ kind: 'upsert' as const, row: value })),
    occurredAtMs: 200 + sourceSeq,
  };
  return { ...base, eventHash: calculateWorkflowProjectionEventHash(base) };
}

function consumeRows(
  store: WorkflowProjectionStore,
  values: readonly WorkflowProjectionRow[],
): readonly WorkflowProjectionEvent[] {
  let previous: `sha256:${string}` | null = null;
  const events: WorkflowProjectionEvent[] = [];
  values.forEach((value, index) => {
    const next = event(index + 1, previous, [
      { ...value, source_event_seq: index + 1 },
    ]);
    expect(store.consume(next)).toBe('applied');
    previous = next.eventHash;
    events.push(next);
  });
  return events;
}

function expectApiCode(
  callback: () => unknown,
  code: RuntimeCenterApiError['code'],
) {
  try {
    callback();
    throw new Error(`Expected Runtime Center error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeCenterApiError);
    expect((error as RuntimeCenterApiError).code).toBe(code);
  }
}

describe('G7 Workflow Projection and Runtime Center API', () => {
  it('replays exact events and degrades on source gaps or hash tamper', () => {
    const projection = new WorkflowProjectionStore();
    const first = event(1, null, [row('workflow:1', 1)]);
    expect(projection.consume(first)).toBe('applied');
    expect(projection.consume(first)).toBe('duplicate');
    expect(projection.rows('workflows')).toHaveLength(1);

    const gap = event(3, first.eventHash, [row('workflow:3', 3)]);
    expect(projection.consume(gap)).toBe('degraded');
    expect(projection.status('workflows')).toMatchObject({
      state: 'degraded',
      degradation_code: 'source_sequence_gap',
    });

    const tamperedStore = new WorkflowProjectionStore();
    expect(tamperedStore.consume({ ...first, eventHash: badHash })).toBe(
      'degraded',
    );
    expect(tamperedStore.rows('workflows')).toHaveLength(0);
    expect(tamperedStore.status('workflows').degradation_code).toBe(
      'source_event_hash_mismatch',
    );
  });

  it('validates a whole event before applying any mutation', () => {
    const projection = new WorkflowProjectionStore();
    const mixed = event(1, null, [
      row('workflow:valid', 1),
      row('workflow:invalid', 1, { source_stream: 'wrong:stream' }),
    ]);
    expect(projection.consume(mixed)).toBe('degraded');
    expect(projection.rows('workflows')).toHaveLength(0);
    expect(projection.status('workflows').degradation_code).toBe(
      'projection_row_source_binding_mismatch',
    );
  });

  it('atomically switches validated rebuild generations and preserves failures', () => {
    const source = projectionFixture('generation-switch');
    const authority = new RuntimeStoreWorkflowProjectionRebuildAuthority(
      source.instance.store,
      'projection-authority:g7',
    );
    const exported = authority.export('workflows');
    const target = new WorkflowProjectionStore('g7.1', authority);
    const rebuilt = target.rebuild('workflows', 'rebuild:g7:1', exported, 500);
    expect(rebuilt.disposition).toBe('rebuilt');
    expect(target.rows('workflows')).toEqual(exported.rows);
    expect(target.row('workflows', source.workflowId)).toMatchObject({
      workflow_id: source.workflowId,
      run_id: source.graphRunId,
      source_kind: 'runtime_store',
    });
    expect(
      target.rebuild('workflows', 'rebuild:g7:1', exported, 501),
    ).toMatchObject({
      disposition: 'duplicate',
      generationId: rebuilt.generationId,
    });
    source.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflows
            SET row_version = row_version + 1, updated_at_ms = 501
          WHERE id = ?`,
        [source.workflowId],
      );
    });
    const driftedJobExport = authority.export('workflows');
    expect(() =>
      target.rebuild('workflows', 'rebuild:g7:1', driftedJobExport, 501),
    ).toThrow(/projection_rebuild_job_conflict/);
    expect(target.rows('workflows')).toEqual(exported.rows);

    expect(() => {
      (exported as { rowsHash: typeof badHash }).rowsHash = badHash;
    }).toThrow();
    const beforeRows = target.rows('workflows');
    const wrongView = authority.export('trace');
    expect(() =>
      target.rebuild('workflows', 'rebuild:g7:bad', wrongView, 502),
    ).toThrow(/projection_rebuild_export_invalid/);
    expect(target.rows('workflows')).toEqual(beforeRows);
    expect(target.status('workflows')).toMatchObject({
      state: 'degraded',
      degradation_code: 'projection_rebuild_export_invalid',
    });

    const forged = {
      ...exported,
      rows: [row('workflow:forged', 1)],
      rowCount: 1,
      rowsHash: badHash,
    };
    expect(() =>
      target.rebuild(
        'workflows',
        'rebuild:g7:forged',
        forged as ProjectionRebuildExport,
        503,
      ),
    ).toThrow(/projection_rebuild_source_untrusted/);
    expect(
      () =>
        new RuntimeStoreWorkflowProjectionRebuildAuthority(
          new WorkflowProjectionStore() as never,
          'projection-authority:forged',
        ),
    ).toThrow(/runtime_store_required/);

    source.instance.closeStore();
    expect(() => authority.export('workflows')).toThrow(/runtime_store_closed/);
    source.instance.reopenStore();
    const reopenedAuthority =
      new RuntimeStoreWorkflowProjectionRebuildAuthority(
        source.instance.store,
        'projection-authority:g7',
      );
    const reopenedExport = reopenedAuthority.export('workflows');
    expect(reopenedExport.rowsHash).toBe(driftedJobExport.rowsHash);
    const reopenedProjection = new WorkflowProjectionStore(
      'g7.1',
      reopenedAuthority,
    );
    expect(
      reopenedProjection.rebuild(
        'workflows',
        'rebuild:g7:reopen',
        reopenedExport,
        504,
      ).disposition,
    ).toBe('rebuilt');
    expect(
      reopenedProjection.row('workflows', source.workflowId),
    ).toBeDefined();
  });

  it('rejects forged persisted projection source after reopen', () => {
    const source = projectionFixture('persisted-event-tamper');
    const authority = new RuntimeStoreWorkflowProjectionRebuildAuthority(
      source.instance.store,
      'projection-authority:tamper',
    );
    expect(authority.export('trace').rows.length).toBeGreaterThan(0);
    source.instance.closeStore();
    const database = new Database(source.instance.databasePath);
    try {
      database.pragma('ignore_check_constraints = ON');
      database
        .prepare(
          `UPDATE workflow_graph_events
              SET payload_json = '{ "forged": true }',
                  payload_value_id = NULL, payload_hash = NULL
            WHERE graph_run_id = ? AND seq = 1`,
        )
        .run(source.graphRunId);
      database.pragma('ignore_check_constraints = OFF');
    } finally {
      database.close();
    }
    source.instance.reopenStore();
    const reopenedAuthority =
      new RuntimeStoreWorkflowProjectionRebuildAuthority(
        source.instance.store,
        'projection-authority:tamper',
      );
    expect(() => reopenedAuthority.export('trace')).toThrow(
      /projection_runtime_event_json_noncanonical/,
    );
  });

  it('rejects a persisted event with a spliced Value/hash shape', () => {
    const source = projectionFixture('persisted-value-splice');
    source.instance.closeStore();
    const database = new Database(source.instance.databasePath);
    try {
      database.pragma('ignore_check_constraints = ON');
      database
        .prepare(
          `UPDATE workflow_graph_events
              SET payload_json = NULL, payload_value_id = NULL,
                  payload_hash = ?
            WHERE graph_run_id = ? AND seq = 1`,
        )
        .run(g7Hash('projection-forged-payload'), source.graphRunId);
      database.pragma('ignore_check_constraints = OFF');
    } finally {
      database.close();
    }
    source.instance.reopenStore();
    const authority = new RuntimeStoreWorkflowProjectionRebuildAuthority(
      source.instance.store,
      'projection-authority:value-splice',
    );
    expect(() => authority.export('trace')).toThrow(
      /projection_runtime_event_value_binding_invalid/,
    );
  });

  it('binds signed cursors to view, filters, sort, and snapshot head', () => {
    const projection = new WorkflowProjectionStore();
    const events = consumeRows(projection, [
      row('workflow:1', 1, { updated_at_ms: 301 }),
      row('workflow:2', 2, { updated_at_ms: 302 }),
      row('workflow:3', 3, { updated_at_ms: 303 }),
    ]);
    const api = new RuntimeCenterProjectionApi(projection, Buffer.alloc(32, 7));
    const first = api.list({
      view: 'workflows',
      page_size: 2,
      cursor: null,
      filters: { pack_id: 'pack:g7' },
      sort: 'updated_desc',
    });
    expect(first.items.map((item) => item.id)).toEqual([
      'workflow:3',
      'workflow:2',
    ]);
    expect(first.next_cursor).not.toBeNull();
    expect(
      api
        .list({
          view: 'workflows',
          page_size: 2,
          cursor: first.next_cursor,
          filters: { pack_id: 'pack:g7' },
          sort: 'updated_desc',
        })
        .items.map((item) => item.id),
    ).toEqual(['workflow:1']);

    const cursor = first.next_cursor!;
    expectApiCode(
      () =>
        api.list({
          view: 'workflows',
          page_size: 2,
          cursor: `${cursor.slice(0, -1)}x`,
          filters: { pack_id: 'pack:g7' },
          sort: 'updated_desc',
        }),
      'cursor_invalid',
    );
    expectApiCode(
      () =>
        api.list({
          view: 'workflows',
          page_size: 2,
          cursor,
          filters: { pack_id: 'pack:other' },
          sort: 'updated_desc',
        }),
      'cursor_mismatch',
    );

    const fourth = event(4, events[2]!.eventHash, [row('workflow:4', 4)]);
    expect(projection.consume(fourth)).toBe('applied');
    expectApiCode(
      () =>
        api.list({
          view: 'workflows',
          page_size: 2,
          cursor,
          filters: { pack_id: 'pack:g7' },
          sort: 'updated_desc',
        }),
      'cursor_mismatch',
    );
  });

  it('provides stable ready-empty renderer state and lineage-checked deep links', () => {
    const projection = new WorkflowProjectionStore();
    const api = new RuntimeCenterProjectionApi(projection, Buffer.alloc(32, 9));
    const empty = api.list({
      view: 'workflows',
      page_size: 20,
      cursor: null,
      filters: {},
      sort: 'updated_desc',
    });
    expect(empty).toMatchObject({ items: [], next_cursor: null });
    expect(createRuntimeCenterRendererState('workflows', empty)).toEqual({
      view: 'workflows',
      mode: 'empty',
      itemCount: 0,
      commandHintsEnabled: true,
    });

    const link: RuntimeCenterDeepLink = {
      format: 'icarus.runtime-link/1',
      target: 'node',
      workflow_id: 'workflow:1',
      run_id: 'run:1',
      scope_id: 'scope:1',
      node_id: 'node:1',
    };
    expect(() => assertRuntimeCenterDeepLink(link, () => true)).not.toThrow();
    expectApiCode(
      () => assertRuntimeCenterDeepLink(link, () => false),
      'broken_link_integrity_error',
    );
  });

  it('restricts rebuild to a diagnostic Human actor', () => {
    const source = projectionFixture('runtime-center');
    const authority = new RuntimeStoreWorkflowProjectionRebuildAuthority(
      source.instance.store,
      'projection-authority:runtime-center',
    );
    const projection = new WorkflowProjectionStore('g7.1', authority);
    const api = new RuntimeCenterProjectionApi(
      projection,
      Buffer.alloc(32, 5),
      authority,
    );
    expectApiCode(
      () =>
        api.rebuild(
          'workflows',
          'job:denied',
          {
            actorKind: 'automation',
            permissions: new Set(['runtime.diagnose']),
          },
          600,
        ),
      'permission_denied',
    );
    expect(
      api.rebuild(
        'workflows',
        'job:allowed',
        { actorKind: 'human', permissions: new Set(['runtime.diagnose']) },
        601,
      ).disposition,
    ).toBe('rebuilt');
  });

  it('serves Capacity as an authoritative subpage and submits only full replacement Commands', () => {
    const target = createG7Fixture('capacity-subpage');
    try {
      const publisher = new CapacitySnapshotPublisher(
        path.join(target.instance.dataRoot, 'workflow-runtime-capacity.json'),
      );
      const watcher = new CapacitySnapshotWatcher();
      const api = new RuntimeCenterCapacityApi(
        target.instance.store,
        publisher,
        watcher,
        () => ({
          usage: { active_executions: 2, physical_blob_bytes: 4096 },
          backpressure: { executions: false, storage: false },
          over_capacity: {
            active_executions: false,
            physical_blob_bytes: false,
          },
        }),
      );
      const before = api.getCapacity();
      expect(before).toMatchObject({
        route: RUNTIME_CENTER_CAPACITY_ROUTES.current,
        current: {
          capacity_revision: 1,
          capacity_change_id: 'capacity-defaults-change:1',
        },
        pending: null,
        watcher: { state: 'unpublished' },
        telemetry: { usage: { active_executions: 2 } },
      });
      expect(api.getChanges()).toMatchObject({
        route: RUNTIME_CENTER_CAPACITY_ROUTES.changes,
        changes: [expect.objectContaining({ assigned_capacity_revision: 1 })],
        events: [
          expect.objectContaining({
            capacity_revision: 1,
            change_id: 'capacity-defaults-change:1',
            event_type: 'head_committed',
          }),
        ],
      });

      const current = target.capacityWatcher.current()!;
      const { config_hash: _currentConfigHash, ...currentValues } =
        current.capacity;
      const proposedValues = {
        ...currentValues,
        max_active_executions: current.capacity.max_active_executions + 1,
      };
      const proposedCapacity = {
        ...proposedValues,
        config_hash: calculateDeploymentCapacityConfigHash(proposedValues),
      };
      const replacement = {
        command_type: 'replace_deployment_capacity' as const,
        command_id: 'capacity:g7:replace',
        idempotency_key: 'capacity:g7:replace',
        expected_capacity_revision: current.capacity_revision,
        expected_config_hash: current.capacity.config_hash,
        proposed_capacity: proposedCapacity,
        reason_code: 'planned_tuning' as const,
        reason_text:
          'Increase execution slots after reviewing local utilization.',
        evidence_refs: ['capacity-report:g7'],
      };
      const invocation = {
        authenticated: true,
        actorRef: 'human:local-owner',
        sessionActorRef: 'human:local-owner',
        actorKind: 'human' as const,
        authSessionRef: 'session:g7:capacity',
        entrypoint: 'runtime_center' as const,
        delegationChainRef: null,
        permissions: ['runtime.capacity.manage'],
        requestedAtMs: 700,
      };
      const persistence = {
        evidenceManifest: target.seed.values.context!,
        reasonText: target.seed.values.context!,
        resultSchema: target.seed.refs.schema!,
      };
      const applied = api.postChange(replacement, invocation, persistence, 701);
      expect(applied).toMatchObject({
        route: RUNTIME_CENTER_CAPACITY_ROUTES.replace,
        result: { disposition: 'prepared', capacityRevision: 2 },
        current: {
          current: {
            capacity_revision: 2,
            config_hash: proposedCapacity.config_hash,
          },
          watcher: { state: 'current', capacity_revision: 2 },
        },
      });
      expect(createRuntimeCenterCapacityRendererState(applied.current)).toEqual(
        {
          mode: 'ready',
          canSubmitReplacement: true,
          capacityRevision: 2,
          hasBackpressure: false,
          hasOverCapacity: false,
        },
      );
      expect(api.getChanges().changes).toHaveLength(2);

      expect(() =>
        api.postChange(
          {
            command_type: 'initialize_deployment_capacity',
            command_id: 'capacity:g7:initialize-forbidden',
            idempotency_key: 'capacity:g7:initialize-forbidden',
            proposed_capacity: proposedCapacity,
            reason_code: 'initial_provisioning',
          },
          invocation,
          persistence,
          702,
        ),
      ).toThrow(/only full replacement Commands/);
      expect(() =>
        api.postChange(
          {
            command_type: 'replace_deployment_capacity',
            max_active_executions: 99,
          },
          invocation,
          persistence,
          703,
        ),
      ).toThrow(/unknown or missing field/);

      const denied = api.postChange(
        {
          ...replacement,
          command_id: 'capacity:g7:delegated',
          idempotency_key: 'capacity:g7:delegated',
          expected_capacity_revision: 2,
          expected_config_hash: proposedCapacity.config_hash,
        },
        { ...invocation, delegationChainRef: 'delegation:forbidden' },
        persistence,
        704,
      );
      expect(denied.result).toMatchObject({
        disposition: 'denied',
        denialCode: 'permission_denied',
      });
      expect(denied.current.current?.capacity_revision).toBe(2);
    } finally {
      target.instance.cleanup();
    }
  });
});
