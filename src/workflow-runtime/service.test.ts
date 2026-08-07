import { afterEach, describe, expect, it } from 'vitest';

import { readGoldenCorpus } from './compiler/golden.js';
import type { JsonObject, Sha256Hash } from './contracts/types.js';
import {
  createG6MapFixture,
  type G6MapFixture,
} from './runtime/g6-test-support.js';
import { WorkflowRuntimeTransactionAuthority } from './service.js';

const fixtures: G6MapFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.instance.cleanup();
});

function expandCompilerInputSnapshot(): JsonObject {
  const testCase = readGoldenCorpus().cases.cases.find(
    (candidate) => candidate.case_id === 'positive.expand',
  );
  if (!testCase) throw new Error('positive.expand compiler fixture is missing');
  return testCase.registry_snapshot;
}

function createDynamicCompileCandidate(
  key: string,
  temporaryConfirmation: JsonObject,
): {
  fixture: G6MapFixture;
  authority: WorkflowRuntimeTransactionAuthority;
  buildId: string;
} {
  const fixture = createG6MapFixture(key, {
    dynamicMode: 'expand',
    stateConfigContent: {
      compiler_input_snapshot: expandCompilerInputSnapshot(),
      temporary_confirmation: temporaryConfirmation,
    },
  });
  fixtures.push(fixture);
  const authority = new WorkflowRuntimeTransactionAuthority(
    fixture.instance.store,
  );
  authority.advance('reconcile', 32, 20);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    authority.advance('schedule', 32, 30 + iteration);
    const build = fixture.instance.store.queryOne<{ id: string }>(
      `SELECT id FROM workflow_graph_scope_builds
        WHERE graph_run_id = ? AND scope_kind <> 'root'
          AND status = 'ready_to_compile'
        ORDER BY created_at_ms, id COLLATE BINARY LIMIT 1`,
      [fixture.graphRunId],
    );
    if (build) return { fixture, authority, buildId: build.id };
  }
  throw new Error('Dynamic compile candidate was not created');
}

function persistedFailure(
  fixture: G6MapFixture,
  buildId: string,
): {
  status: string;
  error_code: string;
  detail_json: string;
} {
  const failure = fixture.instance.store.queryOne<{
    status: string;
    error_code: string;
    detail_json: string;
  }>(
    `SELECT build.status, build.error_code,
            detail.inline_canonical_json AS detail_json
       FROM workflow_graph_scope_builds build
       JOIN workflow_values detail
         ON detail.id = build.error_detail_value_id
        AND detail.content_hash = build.error_detail_hash
      WHERE build.id = ?`,
    [buildId],
  );
  if (!failure) throw new Error('Compile failure was not persisted');
  return failure;
}

function requeueRootBuild(
  fixture: G6MapFixture,
  sourceSnapshot?: JsonObject,
): void {
  fixture.instance.store.withImmediateTransaction((transaction) => {
    expect(
      transaction.execute(
        `UPDATE workflow_graph_scope_builds
            SET status = 'ready_to_compile', compiled_plan_id = NULL,
                compiled_plan_hash = NULL, scope_id = NULL,
                source_snapshot_json = COALESCE(?, source_snapshot_json),
                source_snapshot_value_id = NULL, source_snapshot_hash = NULL,
                error_code = NULL, error_detail_value_id = NULL,
                error_detail_hash = NULL, row_version = row_version + 1,
                updated_at_ms = ?
          WHERE id = ? AND status = 'materialized'`,
        [
          sourceSnapshot ? JSON.stringify(sourceSnapshot) : null,
          90,
          fixture.rootBuildId,
        ],
      ).changes,
    ).toBe(1);
  });
}

function operationalState(fixture: G6MapFixture): {
  run_state: string;
  workflow_state: string;
} {
  return fixture.instance.store.queryOne<{
    run_state: string;
    workflow_state: string;
  }>(
    `SELECT run.operational_state AS run_state,
            workflow.operational_state AS workflow_state
       FROM workflow_graph_runs run
       JOIN workflows workflow ON workflow.id = run.workflow_id
      WHERE run.id = ?`,
    [fixture.graphRunId],
  )!;
}

describe('WorkflowRuntimeTransactionAuthority compile failures', () => {
  it('persists a rejected root build instead of leaving poison compile work', () => {
    const fixture = createG6MapFixture('service-root-compile-rejected', {
      dynamicMode: 'expand',
      stateConfigContent: {
        compiler_input_snapshot: expandCompilerInputSnapshot(),
      },
    });
    fixtures.push(fixture);
    requeueRootBuild(fixture, {
      format: 'icarus.workflow-definition/1',
      states: {},
    });
    const authority = new WorkflowRuntimeTransactionAuthority(
      fixture.instance.store,
    );

    expect(authority.advance('compile', 32, 100).processed).toBe(1);
    expect(persistedFailure(fixture, fixture.rootBuildId).status).toBe(
      'failed',
    );
    expect(operationalState(fixture)).toEqual({
      run_state: 'action_required',
      workflow_state: 'action_required',
    });
    expect(
      fixture.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_graph_events
          WHERE graph_run_id = ? AND event_type = 'build_failed'
            AND idempotency_key = ?`,
        [fixture.graphRunId, `build-failed:${fixture.rootBuildId}`],
      )!.count,
    ).toBe(1);
    expect(authority.advance('compile', 32, 101).processed).toBe(0);
  }, 30_000);

  it('fails a root build with no compiler snapshot instead of skipping it forever', () => {
    const fixture = createG6MapFixture('service-root-snapshot-missing', {
      dynamicMode: 'expand',
      stateConfigContent: {},
    });
    fixtures.push(fixture);
    requeueRootBuild(fixture);
    const authority = new WorkflowRuntimeTransactionAuthority(
      fixture.instance.store,
    );

    expect(authority.advance('compile', 32, 100)).toEqual({
      processed: 1,
      has_more: false,
    });
    const failure = persistedFailure(fixture, fixture.rootBuildId);
    expect(failure).toMatchObject({
      status: 'failed',
      error_code: 'compiler_snapshot_missing',
    });
    expect(JSON.parse(failure.detail_json)).toMatchObject({
      failure_kind: 'compiler_snapshot_missing',
      build_id: fixture.rootBuildId,
      graph_run_id: fixture.graphRunId,
    });
    expect(operationalState(fixture)).toEqual({
      run_state: 'action_required',
      workflow_state: 'action_required',
    });
    expect(
      fixture.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_graph_events
          WHERE graph_run_id = ? AND event_type = 'build_failed'`,
        [fixture.graphRunId],
      )!.count,
    ).toBe(1);
    expect(authority.advance('compile', 32, 101)).toEqual({
      processed: 0,
      has_more: false,
    });
  }, 30_000);

  it('persists compiler rejection diagnostics and does not reprocess the build', () => {
    const target = createDynamicCompileCandidate('service-compile-rejected', {
      source_json: {
        format: 'icarus.workflow-graph-scope/1',
        scope_key: 'invalid_dynamic_child',
      },
    });

    expect(target.authority.advance('compile', 32, 100)).toEqual({
      processed: 1,
      has_more: false,
    });
    const failure = persistedFailure(target.fixture, target.buildId);
    const detail = JSON.parse(failure.detail_json) as JsonObject;
    expect(failure.status).toBe('failed');
    expect(failure.error_code).not.toBe('integrity_violation');
    expect(detail).toMatchObject({
      format: 'icarus.workflow-runtime-compile-failure/1',
      failure_kind: 'compiler_rejected',
      build_id: target.buildId,
      diagnostics: expect.any(Array),
    });
    expect(target.authority.advance('compile', 32, 101)).toEqual({
      processed: 0,
      has_more: false,
    });
    expect(
      target.fixture.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_graph_events
          WHERE graph_run_id = ? AND event_type = 'build_failed'
            AND idempotency_key = ?`,
        [target.fixture.graphRunId, `build-failed:${target.buildId}`],
      )!.count,
    ).toBe(1);
  }, 30_000);

  it('persists confirmed hash mismatch as an integrity violation', () => {
    const confirmedPlanHash =
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as Sha256Hash;
    const target = createDynamicCompileCandidate(
      'service-confirmed-hash-mismatch',
      { plan_hash: confirmedPlanHash },
    );

    expect(target.authority.advance('compile', 32, 200).processed).toBe(1);
    const failure = persistedFailure(target.fixture, target.buildId);
    expect(failure).toMatchObject({
      status: 'failed',
      error_code: 'integrity_violation',
    });
    expect(JSON.parse(failure.detail_json)).toMatchObject({
      format: 'icarus.workflow-runtime-compile-failure/1',
      failure_kind: 'confirmed_identity_mismatch',
      confirmed_plan_hash: confirmedPlanHash,
      actual_plan_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(target.authority.advance('compile', 32, 201).processed).toBe(0);
  }, 30_000);
});
