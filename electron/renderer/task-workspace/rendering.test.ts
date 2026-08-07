import { describe, expect, it } from 'vitest';

import { renderInteractionCard } from './interactions/index.js';
import { calculateInteractionPayloadHash } from './index.js';
import { renderArtifact, renderMarkdown } from './rendering.js';
import {
  renderInspectorPanel,
  renderOverview,
} from './runtime-inspector/index.js';
import { createTaskWorkspaceState } from './state.js';

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
});
