import { afterEach, describe, expect, it } from 'vitest';

import { readGoldenCorpus } from './compiler/golden.js';
import { compileWorkflow } from './compiler/compiler.js';
import type { CompiledScopePlanV2Document } from './contracts/compiler-contract-repair-types.js';
import type { WorkflowCompilerStaticChildPlanBundle } from './contracts/static-child-plan-bundle-types.js';
import type { JsonObject, Sha256Hash } from './contracts/types.js';
import { canonicalJson } from './contracts/hash.js';
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

function cancelledExitFixture(): {
  source: JsonObject;
  snapshot: JsonObject;
  plan: CompiledScopePlanV2Document;
  staticChildPlanBundle: WorkflowCompilerStaticChildPlanBundle;
  childSource: JsonObject;
  childPlan: CompiledScopePlanV2Document;
} {
  const testCase = readGoldenCorpus().cases.cases.find(
    (candidate) => candidate.case_id === 'positive.subgraph',
  );
  if (!testCase)
    throw new Error('positive.subgraph compiler fixture is missing');
  const snapshot = JSON.parse(
    JSON.stringify(testCase.registry_snapshot),
  ) as JsonObject;
  const interfaceSnapshot = snapshot.interface_snapshot as JsonObject;
  const rootInterface = (interfaceSnapshot.interfaces as JsonObject[]).find(
    (entry) => (entry.ref as JsonObject).id === 'fixture.interface.root',
  );
  if (!rootInterface)
    throw new Error('positive.subgraph root interface is missing');
  (rootInterface.exits as JsonObject).cancelled = { output_ports: {} };
  const source = JSON.parse(
    Buffer.from(testCase.raw_source_base64, 'base64').toString('utf8'),
  ) as JsonObject;
  const terminal = (source.nodes as JsonObject[]).find(
    (node) => node.type === 'terminal',
  );
  if (!terminal) throw new Error('positive.subgraph terminal is missing');
  terminal.trigger = { type: 'root' };
  terminal.exit = 'cancelled';
  source.nodes = [terminal];
  source.control_edges = [];
  const completion = source.completion as JsonObject;
  const settledRule = (completion.settled_rules as JsonObject[])[0]!;
  const select = settledRule.select as JsonObject;
  select.exits = ['cancelled'];
  const compiled = compileWorkflow({
    caseId: 'service-exit-named-cancelled',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
    inputSnapshot: snapshot,
  });
  if (!compiled.ok) {
    throw new Error(
      `cancelled exit fixture did not compile: ${JSON.stringify(compiled.value)}`,
    );
  }
  return {
    source,
    snapshot,
    plan: compiled.value.plan,
    staticChildPlanBundle: compiled.value.staticChildPlanBundle,
    childSource: source,
    childPlan: compiled.value.plan,
  };
}

function advanceToTerminal(
  fixture: G6MapFixture,
  authority: WorkflowRuntimeTransactionAuthority,
): { status: string; final_outcome_kind: string | null } {
  let nowMs = 100;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let processed = 0;
    for (const phase of [
      'compile',
      'materialize',
      'reconcile',
      'schedule',
      'recover',
      'close',
    ] as const) {
      processed += authority.advance(phase, 32, nowMs).processed;
      nowMs += 1;
    }
    const workflow = fixture.instance.store.queryOne<{
      status: string;
      final_outcome_kind: string | null;
    }>('SELECT status, final_outcome_kind FROM workflows WHERE id = ?', [
      fixture.workflowId,
    ])!;
    if (workflow.status !== 'active') return workflow;
    if (processed === 0) break;
  }
  throw new Error(
    `Workflow did not reach a terminal state: ${JSON.stringify({
      workflow: fixture.instance.store.queryOne<Record<string, unknown>>(
        'SELECT status, operational_state, current_graph_run_id, row_version FROM workflows WHERE id = ?',
        [fixture.workflowId],
      ),
      run: fixture.instance.store.queryOne<Record<string, unknown>>(
        'SELECT lifecycle, control, operational_state, root_close_request_id, completion_cut_id, row_version FROM workflow_graph_runs WHERE id = ?',
        [fixture.graphRunId],
      ),
      scopes: fixture.instance.store.queryAll<Record<string, unknown>>(
        'SELECT id, scope_kind, lifecycle, close_request_id, completion_cut_id FROM workflow_graph_scopes WHERE graph_run_id = ?',
        [fixture.graphRunId],
      ),
      nodes: fixture.instance.store.queryAll<Record<string, unknown>>(
        'SELECT node_key, node_type, phase, trigger_state, terminal_status FROM workflow_graph_nodes WHERE graph_run_id = ?',
        [fixture.graphRunId],
      ),
    })}`,
  );
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

describe('WorkflowRuntimeTransactionAuthority Definition terminal routing', () => {
  const scenarios: Array<{
    name: string;
    target: string;
    terminal: JsonObject;
    expected: { status: string; final_outcome_kind: string };
  }> = [
    {
      name: 'normal',
      target: 'completed',
      terminal: { type: 'terminal', terminal_kind: 'normal' },
      expected: { status: 'completed', final_outcome_kind: 'normal' },
    },
    {
      name: 'errored',
      target: 'failed',
      terminal: {
        type: 'terminal',
        terminal_kind: 'errored',
        error_code: 'cancelled_business_exit_failed',
      },
      expected: { status: 'errored', final_outcome_kind: 'errored' },
    },
    {
      name: 'cancelled',
      target: 'cancelled_terminal',
      terminal: {
        type: 'terminal',
        terminal_kind: 'cancelled',
        cancel_reason: 'definition_declared_cancelled',
      },
      expected: { status: 'cancelled', final_outcome_kind: 'cancelled' },
    },
  ];

  it.each(scenarios)(
    'uses the Definition $name terminal for an exit literally named cancelled',
    (scenario) => {
      const fixture = createG6MapFixture(
        `definition-cancelled-exit-${scenario.name}`,
        {
          compiledFixture: cancelledExitFixture(),
          definitionStates: {
            run: {
              type: 'graph',
              exit_routes: { cancelled: { target: scenario.target } },
              on_error: { target: 'failed' },
              on_local_cancel: { target: 'cancelled_terminal' },
            },
            completed: { type: 'terminal', terminal_kind: 'normal' },
            failed: {
              type: 'terminal',
              terminal_kind: 'errored',
              error_code: 'fixture_failed',
            },
            cancelled_terminal: {
              type: 'terminal',
              terminal_kind: 'cancelled',
              cancel_reason: 'fixture_cancelled',
            },
            [scenario.target]: scenario.terminal,
          },
        },
      );
      fixtures.push(fixture);

      expect(
        advanceToTerminal(
          fixture,
          new WorkflowRuntimeTransactionAuthority(fixture.instance.store),
        ),
      ).toEqual(scenario.expected);
      expect(
        fixture.instance.store.queryOne<{ target_state_key: string }>(
          `SELECT target_state_key FROM workflow_state_transition_history
            WHERE workflow_id = ? ORDER BY created_at_ms DESC LIMIT 1`,
          [fixture.workflowId],
        ),
      ).toEqual({ target_state_key: scenario.target });
    },
  );
});

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
