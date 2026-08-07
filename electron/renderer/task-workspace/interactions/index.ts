import {
  escapeAttribute,
  escapeHtml,
  isRecord,
  readableLabel,
  stringifyJson,
} from '../rendering.js';

export interface NormalizedInteraction {
  id: string;
  kind: string;
  status: string;
  title: string;
  prompt: string;
  snapshotHash: string;
  targetRowVersion: number;
  actions: Array<{
    id: string;
    label: string;
    payload: unknown;
    payloadHash: string;
    tone: string;
  }>;
  result: unknown;
  launchIntentId: string;
  revisionId: string;
  raw: Record<string, unknown>;
}

function actionsFrom(value: unknown): NormalizedInteraction['actions'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((action) => ({
      id: String(action.action_id ?? action.id ?? ''),
      label: String(
        action.label ??
          readableLabel(action.action_id ?? action.id ?? 'Submit'),
      ),
      payload: action.payload_json ?? action.payload ?? null,
      payloadHash: String(action.payload_hash ?? ''),
      tone: String(action.tone ?? ''),
    }))
    .filter((action) => action.id);
}

export function replanInteraction(
  replan: Record<string, unknown>,
): Record<string, unknown> {
  const proposal = isRecord(replan.proposal) ? replan.proposal : {};
  const preparation = isRecord(proposal.preparation)
    ? proposal.preparation
    : {};
  return {
    interaction_id: replan.replan_id,
    interaction_kind: 'temporary_replan_confirmation',
    title: 'Temporary Replan',
    prompt: proposal.instruction ?? '',
    status: replan.status,
    target_row_version: replan.row_version,
    proposal_hash: replan.proposal_hash,
    diff_json: preparation.diff_json ?? null,
    risk_summary_json: preparation.risk_summary_json ?? null,
    canonical_result: replan.canonical_receipt ?? null,
    replan,
  };
}

export function normalizeInteraction(
  input: Record<string, unknown>,
): NormalizedInteraction {
  const eventPayload = isRecord(input.payload) ? input.payload : null;
  const nested = isRecord(input.interaction)
    ? input.interaction
    : eventPayload && String(input.event_type ?? '').includes('wait')
      ? { ...input, ...eventPayload }
      : input;
  const snapshot = isRecord(nested.rendered_snapshot_json)
    ? nested.rendered_snapshot_json
    : isRecord(nested.rendered_snapshot)
      ? nested.rendered_snapshot
      : isRecord(nested.snapshot)
        ? nested.snapshot
        : nested;
  const revision = isRecord(nested.revision) ? nested.revision : null;
  const kind = String(
    nested.interaction_kind ??
      nested.target_kind ??
      (revision
        ? 'temporary_confirmation'
        : (nested.wait_type ?? 'interaction')),
  );
  const rawStatus = String(nested.status ?? 'pending');
  const status =
    ['armed', 'open', 'waiting', 'action_required'].includes(rawStatus) ||
    rawStatus === 'awaiting_confirmation'
      ? 'pending'
      : rawStatus;
  let actions = actionsFrom(snapshot.actions ?? nested.actions);
  if (!actions.length && kind === 'temporary_confirmation') {
    actions = [
      {
        id: 'confirm-temporary',
        label: 'Run this revision',
        payload: null,
        payloadHash: '',
        tone: 'primary',
      },
      {
        id: 'revise-temporary',
        label: 'Revise',
        payload: null,
        payloadHash: '',
        tone: '',
      },
      {
        id: 'cancel-temporary',
        label: 'Cancel',
        payload: null,
        payloadHash: '',
        tone: 'danger',
      },
    ];
  }
  if (!actions.length && kind === 'runtime_command_confirmation') {
    actions = [
      {
        id: 'confirm-runtime-command',
        label: `Confirm ${readableLabel(nested.action ?? 'Command')}`,
        payload: null,
        payloadHash: '',
        tone: nested.action === 'cancel' ? 'danger' : 'primary',
      },
    ];
  }
  if (!actions.length && kind === 'temporary_replan_request') {
    actions = [
      {
        id: 'prepare-replan',
        label: 'Prepare replan',
        payload: null,
        payloadHash: '',
        tone: 'primary',
      },
    ];
  }
  if (!actions.length && kind === 'temporary_replan_confirmation') {
    actions = [
      {
        id: 'confirm-replan',
        label: 'Apply replan',
        payload: null,
        payloadHash: '',
        tone: 'primary',
      },
      {
        id: 'cancel-replan',
        label: 'Cancel',
        payload: null,
        payloadHash: '',
        tone: 'danger',
      },
    ];
  }
  if (!actions.length && String(nested.wait_type) === 'approval') {
    actions = [
      {
        id: 'approve',
        label: 'Approve',
        payload: { approved: true },
        payloadHash: '',
        tone: 'primary',
      },
      {
        id: 'reject',
        label: 'Reject',
        payload: { approved: false },
        payloadHash: '',
        tone: 'danger',
      },
    ];
  }
  return {
    id: String(
      nested.interaction_id ??
        nested.proposal_id ??
        nested.replan_id ??
        nested.id ??
        nested.target_id ??
        '',
    ),
    kind,
    status,
    title: String(snapshot.title ?? nested.title ?? readableLabel(kind)),
    prompt: String(
      snapshot.prompt ??
        snapshot.description ??
        nested.prompt ??
        nested.summary ??
        '',
    ),
    snapshotHash: String(
      nested.rendered_snapshot_hash ?? snapshot.snapshot_hash ?? '',
    ),
    targetRowVersion: Number(
      nested.target_row_version ?? nested.expected_target_row_version ?? 0,
    ),
    actions,
    result: nested.canonical_result_json ?? nested.canonical_result ?? null,
    launchIntentId: String(nested.launch_intent_id ?? ''),
    revisionId: String(revision?.revision_id ?? nested.revision_id ?? ''),
    raw: { ...nested, ...snapshot },
  };
}

export function renderInteractionCard(
  input: Record<string, unknown>,
  surface: 'timeline' | 'pending',
): string {
  const interaction = normalizeInteraction(input);
  const resolved = interaction.status !== 'pending';
  const revision = isRecord(interaction.raw.revision)
    ? interaction.raw.revision
    : null;
  const risk =
    revision && isRecord(revision.risk_summary_json)
      ? revision.risk_summary_json
      : isRecord(interaction.raw.risk_summary_json)
        ? interaction.raw.risk_summary_json
        : null;
  const diff = isRecord(interaction.raw.diff_json)
    ? interaction.raw.diff_json
    : null;
  const identifier =
    interaction.id ||
    interaction.launchIntentId ||
    interaction.revisionId ||
    `${interaction.kind}:${surface}`;
  const needsPayload =
    interaction.kind === 'temporary_confirmation' ||
    interaction.kind === 'temporary_replan_request' ||
    interaction.kind === 'runtime_wait' ||
    interaction.kind === 'signal' ||
    interaction.raw.wait_type === 'signal';
  return `
    <section class="tw-interaction" data-interaction-id="${escapeAttribute(identifier)}" data-interaction-kind="${escapeAttribute(interaction.kind)}" data-launch-intent-id="${escapeAttribute(interaction.launchIntentId)}" data-revision-id="${escapeAttribute(interaction.revisionId)}">
      <header>
        <span class="tw-interaction-kind">${escapeHtml(readableLabel(interaction.kind))}</span>
        <span class="tw-status ${resolved ? 'is-resolved' : 'is-pending'}">${escapeHtml(interaction.status)}</span>
      </header>
      <h3>${escapeHtml(interaction.title)}</h3>
      ${interaction.prompt ? `<p>${escapeHtml(interaction.prompt)}</p>` : ''}
      ${revision ? `<dl class="tw-inline-facts"><div><dt>Revision</dt><dd>${escapeHtml(revision.revision_no ?? '--')}</dd></div><div><dt>Plan hash</dt><dd title="${escapeAttribute(revision.compiled_plan_hash ?? '')}">${escapeHtml(String(revision.compiled_plan_hash ?? '--').slice(0, 16))}</dd></div></dl>` : ''}
      ${risk ? `<details class="tw-disclosure"><summary>Risk summary</summary><pre>${escapeHtml(stringifyJson(risk))}</pre></details>` : ''}
      ${diff ? `<details class="tw-disclosure tw-replan-diff" open><summary>Plan diff</summary><pre class="tw-diff">${escapeHtml(stringifyJson(diff))}</pre></details>` : ''}
      ${needsPayload && !resolved ? `<textarea class="tw-interaction-input" data-role="interaction-value" rows="2" placeholder="${interaction.kind === 'temporary_confirmation' ? 'Revision instruction' : interaction.kind === 'temporary_replan_request' ? 'Replan instruction' : 'Response'}"></textarea>` : ''}
      <div class="tw-interaction-actions">
        ${interaction.actions
          .map(
            (action) =>
              `<button type="button" class="tw-btn ${action.tone === 'primary' ? 'tw-btn-primary' : action.tone === 'danger' ? 'tw-btn-danger' : 'tw-btn-quiet'}" data-tw-action="interaction" data-interaction-action="${escapeAttribute(action.id)}" data-payload-hash="${escapeAttribute(action.payloadHash)}"${resolved ? ' disabled' : ''}>${escapeHtml(action.label)}</button>`,
          )
          .join('')}
      </div>
      ${interaction.result != null ? `<div class="tw-canonical-result"><strong>Result</strong><pre>${escapeHtml(stringifyJson(interaction.result))}</pre></div>` : ''}
    </section>`;
}
