import { describe, expect, it } from 'vitest';

import {
  isCurrentTemporaryRevision,
  renderInteractionCard,
  resolveTemporaryConfirmation,
} from './interactions/index.js';
import { calculateInteractionPayloadHash } from './index.js';
import { renderArtifact, renderMarkdown } from './rendering.js';
import {
  renderArtifacts,
  renderDag,
  renderInspectorPanel,
  renderOverview,
} from './runtime-inspector/index.js';
import { createTaskWorkspaceState, type TimelineEntry } from './state.js';

function temporaryConfirmation(
  sequence: number,
  revisionId: string,
): TimelineEntry {
  return {
    entry_id: `entry:${sequence}`,
    session_id: 'session:1',
    session_seq: sequence,
    kind: 'launch_status',
    source_kind: 'workspace',
    source_id: revisionId,
    source_event_seq: null,
    payload_json: {
      interaction_kind: 'temporary_confirmation',
      launch_intent_id: 'launch:1',
      revision: {
        revision_id: revisionId,
        revision_no: sequence,
        compiled_plan_hash: `sha256:${revisionId}`,
      },
    },
    occurred_at_ms: sequence,
    created_at_ms: sequence,
  };
}

describe('Task Workspace generic renderers', () => {
  it('escapes untrusted markdown HTML while retaining basic formatting', () => {
    const html = renderMarkdown('**safe** <img src=x onerror=alert(1)>');

    expect(html).toContain('<strong>safe</strong>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders resolved interaction cards disabled with canonical results', () => {
    const html = renderInteractionCard(
      {
        interaction_id: 'interaction:1',
        interaction_kind: 'approval',
        status: 'accepted',
        actions: [{ action_id: 'approve', label: 'Approve' }],
        canonical_result: { disposition: 'accepted' },
      },
      'pending',
    );

    expect(html).toContain('disabled');
    expect(html).toContain('canonical-result');
    expect(html).toContain('accepted');
  });

  it('keeps an armed Runtime Wait actionable', () => {
    const html = renderInteractionCard(
      {
        id: 'wait:1',
        wait_type: 'approval',
        status: 'armed',
      },
      'timeline',
    );

    expect(html).toContain('Approve');
    expect(html).not.toContain('disabled');
  });

  it('renders an exact Temporary Replan diff and preserves applying state', () => {
    const html = renderInteractionCard(
      {
        interaction_id: 'replan:1',
        interaction_kind: 'temporary_replan_confirmation',
        title: 'Temporary Replan',
        status: 'applying',
        proposal_hash: 'sha256:proposal',
        diff_json: { added_nodes: ['review_summary'] },
        risk_summary_json: { effect_ceiling: 'read_only' },
        canonical_result: { disposition: 'applying' },
      },
      'pending',
    );

    expect(html).toContain('Plan diff');
    expect(html).toContain('review_summary');
    expect(html).toContain('applying');
    expect(html).toContain('disabled');
  });

  it('expires a superseded Temporary confirmation card and keeps only the current revision actionable', () => {
    const oldRevision = temporaryConfirmation(1, 'revision:old');
    const currentRevision = temporaryConfirmation(2, 'revision:current');
    const resolved = resolveTemporaryConfirmation(oldRevision, [
      oldRevision,
      currentRevision,
    ]);

    expect(resolved).toMatchObject({
      status: 'expired',
      canonical_result: {
        disposition: 'expired',
        reason: 'revision_superseded',
        current_revision_id: 'revision:current',
      },
    });
    expect(renderInteractionCard(resolved!, 'timeline')).toContain('disabled');
    expect(
      normalizeStatus(
        resolveTemporaryConfirmation(currentRevision, [
          oldRevision,
          currentRevision,
        ]),
      ),
    ).toBe('pending');
    expect(
      isCurrentTemporaryRevision(
        { current_revision_id: 'revision:current' },
        'revision:old',
      ),
    ).toBe(false);
    expect(
      isCurrentTemporaryRevision(
        { draft: { current_revision_id: 'revision:current' } },
        'revision:current',
      ),
    ).toBe(true);
  });

  it('uses the Runtime Gateway domain and JCS for interaction payload hashes', async () => {
    await expect(
      calculateInteractionPayloadHash({ z: 1, a: true }),
    ).resolves.toBe(
      'sha256:e3e176c1e95fe27ddf2d4dd5a62484f42251c6112bb7a6f3733b44d8299b03f2',
    );
  });

  it('uses generic media and tabular Artifact rendering', () => {
    expect(
      renderArtifact({
        title: 'Screenshot',
        mime_type: 'image/png',
        url: '/api/artifacts/1',
      }),
    ).toContain('<img');
    expect(
      renderArtifact({
        title: 'Rows',
        content: [{ name: 'one', state: 'ready' }],
      }),
    ).toContain('tw-data-table');
    expect(
      renderArtifact({
        artifact_ref: 'artifact:runtime',
        display_json: { title: 'Runtime image', media_type: 'image/png' },
      }),
    ).toContain('image/png');
  });

  it('keeps the Inspector to the five specified panels', () => {
    const state = createTaskWorkspaceState();
    state.runtimeDetail = {
      format: 'icarus.workspace-runtime-detail/1',
      freshness: 'ready',
      workflows: [],
    };

    for (const panel of [
      'overview',
      'dag',
      'artifacts',
      'pending',
      'trace',
    ] as const) {
      state.inspectorPanel = panel;
      expect(renderInspectorPanel(state)).toBeTruthy();
    }
  });

  it('renders structured Runtime command hints and keeps unavailable history read-only', () => {
    const state = createTaskWorkspaceState();
    state.activeSession = {
      session_id: 'session:1',
      title: 'Temporary task',
      status: 'open',
      attention_state: 'none',
      current_run_selection: { kind: 'temporary_workflow' },
      updated_at_ms: 1,
      row_version: 1,
    };
    state.runtimeDetail = {
      format: 'icarus.workspace-runtime-detail/1',
      freshness: 'ready',
      workflows: [
        {
          workflow_id: 'workflow:1',
          availability: 'available',
          current_graph_run_id: 'run:1',
          command_hints: [
            {
              action: 'pause',
              workflow_id: 'workflow:1',
              run_id: 'run:1',
              expected_target_row_version: 4,
            },
          ],
          runs: [{ id: 'run:1', lifecycle: 'executing' }],
        },
      ],
    };

    expect(renderOverview(state)).toContain('data-command="pause"');
    expect(renderOverview(state)).toContain('data-tw-action="begin-replan"');

    state.runtimeDetail.workflows[0]!.availability = 'unavailable';
    const historical = renderOverview(state);
    expect(historical).toContain('Workflow is read-only');
    expect(historical).not.toContain('data-command="pause"');
    expect(historical).not.toContain('data-tw-action="begin-replan"');
  });

  it('renders Runtime edges, attempts, completion cuts, and linked Artifacts', () => {
    const state = createTaskWorkspaceState();
    state.activeSession = {
      session_id: 'session:1',
      title: 'Inspect task',
      status: 'open',
      attention_state: 'none',
      current_run_selection: { kind: 'temporary_workflow' },
      updated_at_ms: 1,
      row_version: 1,
    };
    state.runtimeDetail = {
      format: 'icarus.workspace-runtime-detail/1',
      freshness: 'ready',
      artifact_links: [
        {
          artifact_link_id: 'link:1',
          workflow_id: 'workflow:1',
          artifact_ref: 'artifact:workspace',
          display_json: { title: 'Workspace report', content: 'Reviewed' },
        },
      ],
      workflows: [
        {
          workflow_id: 'workflow:1',
          current_graph_run_id: 'run:1',
          runs: [{ id: 'run:1' }],
          scopes: [{ id: 'scope:1', graph_run_id: 'run:1' }],
          nodes: [
            {
              id: 'node:one',
              graph_run_id: 'run:1',
              scope_id: 'scope:1',
              node_key: 'collect',
              phase: 'terminal',
            },
            {
              id: 'node:two',
              graph_run_id: 'run:1',
              scope_id: 'scope:1',
              node_key: 'publish',
              phase: 'ready',
            },
          ],
          edges: [
            {
              id: 'edge:1',
              graph_run_id: 'run:1',
              from_node_id: 'node:one',
              to_node_id: 'node:two',
              edge_kind: 'control',
            },
          ],
          attempts: [
            {
              id: 'attempt:1',
              graph_run_id: 'run:1',
              node_id: 'node:one',
              attempt_no: 1,
              phase: 'terminal',
              execution_outcome: 'succeeded',
              query_id: 'query:1',
            },
          ],
          completion_cuts: [
            {
              id: 'cut:1',
              graph_run_id: 'run:1',
              scope_id: 'scope:1',
              outcome_kind: 'succeeded',
              exit_name: 'done',
              cut_hash: 'sha256:cut',
            },
          ],
          artifacts: [
            {
              id: 'runtime-artifact:1',
              graph_run_id: 'run:1',
              artifact_ref: 'artifact:runtime',
              display_json: { title: 'Runtime output', content: 'Complete' },
            },
          ],
        },
      ],
    };

    const dag = renderDag(state);
    expect(dag).toContain('1 edges');
    expect(dag).toContain('1 attempts');
    expect(dag).toContain('1 completion cuts');
    expect(dag).toContain('collect');
    expect(dag).toContain('publish');
    expect(dag).toContain('succeeded');

    const artifacts = renderArtifacts(state);
    expect(artifacts).toContain('Workspace report');
    expect(artifacts).toContain('Runtime output');
    expect(artifacts).toContain('data-artifact-ref="artifact:workspace"');
  });
});

function normalizeStatus(value: Record<string, unknown> | null): string {
  return String(value?.status ?? 'pending');
}
