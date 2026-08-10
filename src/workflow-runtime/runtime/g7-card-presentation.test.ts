import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CardPresentationDocument } from '../contracts/closed-schema-types.js';
import { canonicalJson } from '../contracts/hash.js';
import type { JsonObject } from '../contracts/types.js';
import {
  invokeCardAction,
  renderCardPresentation,
  type CardActionHandlers,
  type CardActionInvocation,
} from './card-presentation.js';
import { createG7Fixture, g7Hash, type G7Fixture } from './g7-test-support.js';

const fixtures: G7Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.instance.cleanup();
});

function fixture(key: string): G7Fixture {
  const created = createG7Fixture(`card-${key}`);
  fixtures.push(created);
  return created;
}

function contract(): CardPresentationDocument {
  return {
    format: 'icarus.card-presentation/1',
    ref: { id: 'g7.card', version: '1.0.0' },
    owner_pack_id: 'g7-pack',
    template_ref: { id: 'g7.card-template', version: '1.0.0' },
    template_hash: g7Hash('card-template'),
    variable_schema_ref: { id: 'g7.card-variables', version: '1.0.0' },
    variable_schema_hash: g7Hash('card-variable-schema'),
    supported_channel_adapters: [
      {
        adapter_ref: { id: 'g7.channel', version: '1.0.0' },
        adapter_hash: g7Hash('card-adapter'),
        render_profile_ref: { id: 'g7.render-profile', version: '1.0.0' },
      },
    ],
    render_limits: {
      max_payload_bytes: 4096,
      max_text_bytes: 1024,
      max_actions: 4,
    },
    fallback_text_template_ref: { id: 'g7.fallback', version: '1.0.0' },
    actions: [
      {
        action_id: 'approve',
        label: 'Approve',
        binding: {
          action_kind: 'wait_signal',
          wait_contract_ref: { id: 'g7.wait', version: '1.0.0' },
          action_value: 'approved',
          correlation_variable: 'approval_id',
        },
        required_permission: 'workflow.operate',
        idempotency_domain: 'card_interaction',
        expires_after_ms: 300,
      },
      {
        action_id: 'business',
        label: 'Submit',
        binding: {
          action_kind: 'business_command',
          business_command_contract_ref: {
            id: 'g7.business-command',
            version: '1.0.0',
          },
          command_input_variable: 'business_input',
        },
        required_permission: 'workflow.operate',
        idempotency_domain: 'card_interaction',
        expires_after_ms: 300,
      },
      {
        action_id: 'pause',
        label: 'Pause',
        binding: {
          action_kind: 'runtime_command',
          command_type: 'pause_run',
          target_binding: 'run',
        },
        required_permission: 'workflow.operate',
        idempotency_domain: 'card_interaction',
        expires_after_ms: 300,
      },
    ],
    snapshot_retention_policy_ref: {
      id: 'g7.card-retention',
      version: '1.0.0',
    },
    deterministic_render_fixture_ref: 'fixture:g7-card',
    deterministic_render_fixture_hash: g7Hash('card-fixture'),
    contract_hash: g7Hash('card-contract'),
  };
}

const variableSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'count'],
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
  },
};

function render(
  target: G7Fixture,
  renderedAtMs = 100,
  workflowId = target.workflowId,
) {
  const presentation = contract();
  return {
    presentation,
    rendered: renderCardPresentation(target.instance.store, {
      contract: presentation,
      presentationHash: presentation.contract_hash as `sha256:${string}`,
      template: {
        type: 'fact',
        title: { variable: 'title' },
        count: { variable: 'count' },
      },
      templateHash: presentation.template_hash as `sha256:${string}`,
      variableSchema,
      variableSchemaHash:
        presentation.variable_schema_hash as `sha256:${string}`,
      variables: { title: 'Review', count: 2 },
      fallbackText: 'Review (2)',
      channelAdapterRef: { id: 'g7.channel', version: '1.0.0' },
      channelAdapterHash: g7Hash('card-adapter'),
      renderProfileRef: { id: 'g7.render-profile', version: '1.0.0' },
      snapshotSchema: target.seed.refs.schema!,
      workflowId,
      graphRunId: target.graphRunId,
      renderedAtMs,
    }),
  };
}

function invocation(
  presentation: CardPresentationDocument,
  snapshot: { id: string; hash: string },
  actionId: string,
): CardActionInvocation {
  return {
    presentation_ref: presentation.ref,
    presentation_hash: presentation.contract_hash as `sha256:${string}`,
    rendered_snapshot_ref: snapshot.id,
    rendered_snapshot_hash: snapshot.hash as `sha256:${string}`,
    action_id: actionId,
    idempotency_key: `card:${actionId}`,
    expected_target_row_version: 3,
    submitted_at_ms: 120,
    credential_ref: 'credential:g7/card',
  };
}

function handlers(): CardActionHandlers {
  return {
    waitSignal: vi.fn(() => ({
      disposition: 'applied' as const,
      result: { ok: true },
    })),
    businessCommand: vi.fn(() => ({
      disposition: 'duplicate' as const,
      result: { replay: true },
    })),
    runtimeCommand: vi.fn(() => ({
      disposition: 'row_version_conflict' as const,
      result: { denial_code: 'row_version_conflict' },
    })),
  };
}

describe('G7 Card Presentation and action ingress', () => {
  it('renders deterministic immutable pinned snapshots and dispatches only typed handlers', () => {
    const target = fixture('deterministic');
    const first = render(target);
    const second = render(target);
    expect(second.rendered).toEqual(first.rendered);
    expect(first.rendered.payload).toMatchObject({
      content: { type: 'fact', title: 'Review', count: 2 },
      fallback_text: 'Review (2)',
    });
    expect(
      target.instance.store.queryOne(
        `SELECT v.retention_class, o.owner_graph_run_id,
                v.inline_canonical_json
           FROM workflow_values v
           JOIN workflow_value_ownerships o ON o.value_id = v.id
          WHERE v.id = ?`,
        [first.rendered.snapshot.id],
      ),
    ).toMatchObject({
      retention_class: 'pinned',
      owner_graph_run_id: target.graphRunId,
    });

    const typedHandlers = handlers();
    const actor = {
      ...target.actor,
      entrypoint: 'card_action' as const,
    };
    expect(
      invokeCardAction(
        target.instance.store,
        {
          contract: first.presentation,
          invocation: invocation(
            first.presentation,
            first.rendered.snapshot,
            'approve',
          ),
          actor,
          nowMs: 130,
        },
        typedHandlers,
      ).disposition,
    ).toBe('applied');
    expect(
      invokeCardAction(
        target.instance.store,
        {
          contract: first.presentation,
          invocation: invocation(
            first.presentation,
            first.rendered.snapshot,
            'business',
          ),
          actor,
          nowMs: 130,
        },
        typedHandlers,
      ).disposition,
    ).toBe('duplicate');
    expect(
      invokeCardAction(
        target.instance.store,
        {
          contract: first.presentation,
          invocation: invocation(
            first.presentation,
            first.rendered.snapshot,
            'pause',
          ),
          actor,
          nowMs: 130,
        },
        typedHandlers,
      ).disposition,
    ).toBe('row_version_conflict');
    expect(typedHandlers.waitSignal).toHaveBeenCalledTimes(1);
    expect(typedHandlers.businessCommand).toHaveBeenCalledTimes(1);
    expect(typedHandlers.runtimeCommand).toHaveBeenCalledTimes(1);
  });

  it('separates identical snapshot content by Run ownership', () => {
    const firstTarget = fixture('run-identity-first');
    const secondTarget = fixture('run-identity-second');
    const first = render(firstTarget);
    const second = render(secondTarget);
    expect(second.rendered.payload).toEqual(first.rendered.payload);
    expect(second.rendered.snapshot.id).not.toBe(first.rendered.snapshot.id);
    expect(
      secondTarget.instance.store.queryOne(
        `SELECT o.owner_graph_run_id, json_extract(v.inline_canonical_json, '$.workflow_id') AS workflow_id,
                json_extract(v.inline_canonical_json, '$.graph_run_id') AS graph_run_id
           FROM workflow_values v JOIN workflow_value_ownerships o ON o.value_id = v.id
          WHERE v.id = ?`,
        [second.rendered.snapshot.id],
      ),
    ).toMatchObject({
      owner_graph_run_id: secondTarget.graphRunId,
      workflow_id: secondTarget.workflowId,
      graph_run_id: secondTarget.graphRunId,
    });
  });

  it('rejects canonical snapshot tamper before invoking a handler', () => {
    const target = fixture('tamper');
    const { presentation, rendered } = render(target);
    const row = target.instance.store.queryOne<{
      inline_canonical_json: string;
    }>('SELECT inline_canonical_json FROM workflow_values WHERE id = ?', [
      rendered.snapshot.id,
    ])!;
    const tampered = {
      ...(JSON.parse(row.inline_canonical_json) as JsonObject),
      fallback_text: 'tampered',
    };
    const bytes = canonicalJson(tampered);
    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_values SET inline_canonical_json = ?, byte_length = ?
          WHERE id = ?`,
        [bytes, Buffer.byteLength(bytes), rendered.snapshot.id],
      );
    });
    const typedHandlers = handlers();
    expect(() =>
      invokeCardAction(
        target.instance.store,
        {
          contract: presentation,
          invocation: invocation(presentation, rendered.snapshot, 'approve'),
          actor: { ...target.actor, entrypoint: 'card_action' },
          nowMs: 130,
        },
        typedHandlers,
      ),
    ).toThrow(/snapshot presentation binding drifted/);
    expect(typedHandlers.waitSignal).not.toHaveBeenCalled();
  });

  it('rolls a tentative snapshot back when Run ownership verification fails', () => {
    const target = fixture('ownership-rollback');
    const valueCount = target.instance.store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_values',
      [],
    )!.count;
    const ownershipCount = target.instance.store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_value_ownerships',
      [],
    )!.count;
    expect(() => render(target, 100, 'workflow:not-the-run-owner')).toThrow(
      /Run\/Workflow ownership is invalid/,
    );
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_values',
        [],
      )!.count,
    ).toBe(valueCount);
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_value_ownerships',
        [],
      )!.count,
    ).toBe(ownershipCount);
  });

  it('returns an inert expiry result without dispatch', () => {
    const target = fixture('expired');
    const { presentation, rendered } = render(target);
    const typedHandlers = handlers();
    expect(
      invokeCardAction(
        target.instance.store,
        {
          contract: presentation,
          invocation: invocation(presentation, rendered.snapshot, 'approve'),
          actor: { ...target.actor, entrypoint: 'card_action' },
          nowMs: 401,
        },
        typedHandlers,
      ),
    ).toMatchObject({
      disposition: 'action_expired',
      result: { denial_code: 'action_expired' },
    });
    expect(typedHandlers.waitSignal).not.toHaveBeenCalled();
  });

  it('rejects secret-bearing variables and secret bytes before persistence', () => {
    const target = fixture('secret');
    const presentation = contract();
    expect(() =>
      renderCardPresentation(target.instance.store, {
        contract: presentation,
        presentationHash: presentation.contract_hash as `sha256:${string}`,
        template: { value: { variable: 'api_token' } },
        templateHash: presentation.template_hash as `sha256:${string}`,
        variableSchema: {
          type: 'object',
          required: ['api_token'],
          additionalProperties: false,
          properties: { api_token: { type: 'string' } },
        },
        variableSchemaHash:
          presentation.variable_schema_hash as `sha256:${string}`,
        variables: { api_token: 'Bearer card-secret' },
        fallbackText: 'Unavailable',
        channelAdapterRef: { id: 'g7.channel', version: '1.0.0' },
        channelAdapterHash: g7Hash('card-adapter'),
        renderProfileRef: { id: 'g7.render-profile', version: '1.0.0' },
        snapshotSchema: target.seed.refs.schema!,
        workflowId: target.workflowId,
        graphRunId: target.graphRunId,
        renderedAtMs: 100,
      }),
    ).toThrow(/secret-bearing field/);
  });
});
