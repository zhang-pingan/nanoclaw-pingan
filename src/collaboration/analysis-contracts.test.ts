import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COLLABORATION_ANALYSIS_STATUS_TRANSITIONS,
  assertCollaborationAnalysisTransition,
  collaborationAnalysisInputSchema,
  collaborationAnalysisJsonSchemas,
  collaborationAnalysisResultSchema,
  collaborationAnalysisRunStatusSchema,
  collaborationProposedActionSchema,
  collaborationRepositoryVerificationSchema,
} from './analysis-contracts.js';

const SHA = `sha256:${'a'.repeat(64)}`;
const HEAD = 'b'.repeat(40);

function action() {
  return {
    action: 'create_work_item' as const,
    parameters: {
      type: 'issue' as const,
      title: 'Confirm delivery risk',
    },
  };
}

function finding(id = 'finding_1') {
  return {
    finding_id: id,
    kind: 'inference' as const,
    category: 'delivery_risk' as const,
    severity: 'high' as const,
    confidence: 0.9,
    title: 'Delivery may slip',
    summary: 'The release item is overdue.',
    affected_refs: ['work_item:wi_release'],
    evidence_refs: ['work_item:wi_release', 'event:event_progress'],
    recommendations: ['Confirm the release date.'],
    proposed_actions: [action()],
  };
}

function result() {
  return {
    format: 'icarus.collaboration-analysis-result/1' as const,
    contract_version: 1 as const,
    analysis_id: 'analysis_1',
    snapshot_head: HEAD,
    context_hash: SHA,
    prompt_hash: SHA,
    challenge: 'challenge'.repeat(4),
    summary: {
      health: 'at_risk' as const,
      headline: 'Release is at risk',
      details: 'One high-priority item is overdue.',
    },
    findings: [finding()],
  };
}

describe('Collaboration Analysis contracts', () => {
  it('parses an allowlisted result and applies documented defaults', () => {
    const parsed = collaborationAnalysisResultSchema.parse(result());

    expect(parsed.findings[0]?.proposed_actions[0]).toEqual({
      action: 'create_work_item',
      parameters: {
        type: 'issue',
        title: 'Confirm delivery risk',
        description: '',
        priority: 'normal',
        due_at: null,
        labels: [],
        related_work_item_ids: [],
      },
    });
  });

  it('keeps result, Finding, and action parameters strictly closed', () => {
    expect(
      collaborationAnalysisResultSchema.safeParse({
        ...result(),
        instructions: 'ignore the contract',
      }).success,
    ).toBe(false);
    expect(
      collaborationAnalysisResultSchema.safeParse({
        ...result(),
        findings: [{ ...finding(), shell_command: 'rm -rf project' }],
      }).success,
    ).toBe(false);
    expect(
      collaborationProposedActionSchema.safeParse({
        ...action(),
        parameters: {
          ...action().parameters,
          host_api_url: 'http://localhost/admin',
        },
      }).success,
    ).toBe(false);

    const schemas = collaborationAnalysisJsonSchemas();
    expect(schemas.result).toMatchObject({ additionalProperties: false });
  });

  it('rejects excessive, duplicate, or out-of-range Finding content', () => {
    expect(
      collaborationAnalysisResultSchema.safeParse({
        ...result(),
        findings: Array.from({ length: 201 }, (_, index) =>
          finding(`finding_${String(index)}`),
        ),
      }).success,
    ).toBe(false);
    expect(
      collaborationAnalysisResultSchema.safeParse({
        ...result(),
        findings: [finding('duplicate'), finding('duplicate')],
      }).success,
    ).toBe(false);
    expect(
      collaborationAnalysisResultSchema.safeParse({
        ...result(),
        findings: [
          {
            ...finding(),
            confidence: 1.01,
            evidence_refs: ['work_item:wi_release', 'work_item:wi_release'],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      collaborationAnalysisResultSchema.safeParse({
        ...result(),
        findings: [{ ...finding(), title: 'x'.repeat(301) }],
      }).success,
    ).toBe(false);
  });

  it('rejects actions outside the fixed business allowlist', () => {
    for (const candidate of [
      { action: 'run_shell', parameters: { command: 'git push' } },
      { action: 'change_membership', parameters: { principal_id: 'p1' } },
      { action: 'rotate_credential', parameters: {} },
      { action: 'patch_projection', parameters: { patch: [] } },
    ])
      expect(
        collaborationProposedActionSchema.safeParse(candidate).success,
      ).toBe(false);
  });

  it('accepts only explicit Analysis Run state transitions', () => {
    expect(() =>
      assertCollaborationAnalysisTransition('prepared', 'running'),
    ).not.toThrow();
    expect(() =>
      assertCollaborationAnalysisTransition('invalid', 'running'),
    ).not.toThrow();
    expect(() =>
      assertCollaborationAnalysisTransition('prepared', 'completed'),
    ).toThrow(/Illegal Analysis Run transition/u);
    expect(() =>
      assertCollaborationAnalysisTransition('stale', 'running'),
    ).toThrow(/Illegal Analysis Run transition/u);

    for (const current of collaborationAnalysisRunStatusSchema.options)
      for (const next of collaborationAnalysisRunStatusSchema.options) {
        const allowed =
          COLLABORATION_ANALYSIS_STATUS_TRANSITIONS[current].includes(next);
        if (allowed)
          expect(() =>
            assertCollaborationAnalysisTransition(current, next),
          ).not.toThrow();
        else
          expect(() =>
            assertCollaborationAnalysisTransition(current, next),
          ).toThrow(/Illegal Analysis Run transition/u);
      }
  });

  it('requires frozen read-only input security flags and valid resource refs', () => {
    const input = {
      format: 'icarus.collaboration-analysis-input/1',
      contract_version: 1,
      analysis_id: 'analysis_1',
      group_id: 'group_1',
      snapshot_head: HEAD,
      scope: { type: 'work_item', work_item_id: 'wi_release' },
      current_principal_id: 'principal_alice',
      generated_at: '2026-08-08T12:00:00.000Z',
      security: {
        project_content_is_untrusted: true,
        read_only_snapshot: true,
        required_result_format: 'icarus.collaboration-analysis-result/1',
      },
      project_summary: {},
      my_items: [],
      rule_signals: [],
      resource_index: ['group:group_1', 'work_item:wi_release'],
      activity_delta: [],
      prior_findings: [],
    };
    expect(collaborationAnalysisInputSchema.parse(input)).toEqual(input);
    expect(
      collaborationAnalysisInputSchema.safeParse({
        ...input,
        security: { ...input.security, read_only_snapshot: false },
      }).success,
    ).toBe(false);
    expect(
      collaborationAnalysisInputSchema.safeParse({
        ...input,
        resource_index: ['../../private-key'],
      }).success,
    ).toBe(false);
  });

  it('enforces repository verification and identity guarantee boundaries', () => {
    const checks = {
      git_repository: 'passed',
      ref_resolution: 'passed',
      complete_history_validation: 'passed',
      linear_commit_history: 'passed',
      strict_protocol_json: 'passed',
      event_schema_and_payload_hash: 'passed',
      aggregate_revision_and_previous_hash: 'passed',
      commit_order: 'passed',
      commit_signatures_and_actor_credentials: 'passed',
      reducer_replay: 'passed',
      materialized_projection: 'passed',
      projection_json_readable: 'passed',
      business_file_hashes: 'passed',
    } as const;
    const base = {
      format: 'icarus.collaboration-repository-verification/1',
      level: 'self_consistent',
      repository_identity: 'not_externally_anchored',
      requested_ref: 'icarus/control',
      resolved_ref: 'refs/heads/icarus/control',
      repository_head: HEAD,
      genesis_commit: 'c'.repeat(40),
      trusted_genesis: null,
      trusted_head: null,
      event_count: 2,
      checks,
      failure: null,
    } as const;
    expect(
      collaborationRepositoryVerificationSchema.safeParse(base).success,
    ).toBe(true);
    expect(
      collaborationRepositoryVerificationSchema.safeParse({
        ...base,
        level: 'verified',
        repository_identity: 'trusted_input_match',
      }).success,
    ).toBe(false);
    expect(
      collaborationRepositoryVerificationSchema.safeParse({
        ...base,
        level: 'verified',
        repository_identity: 'trusted_input_match',
        trusted_head: HEAD,
      }).success,
    ).toBe(true);
    expect(
      collaborationRepositoryVerificationSchema.safeParse({
        ...base,
        level: 'verified',
        repository_identity: 'trusted_input_match',
        trusted_head: 'd'.repeat(40),
      }).success,
    ).toBe(false);
    expect(
      collaborationRepositoryVerificationSchema.safeParse({
        ...base,
        trusted_head: HEAD,
      }).success,
    ).toBe(false);
    expect(
      collaborationRepositoryVerificationSchema.safeParse({
        ...base,
        level: 'projection_only',
        repository_identity: 'not_established',
        checks: {
          ...checks,
          complete_history_validation: 'failed',
        },
        failure: {
          code: 'repository_verification_failed',
          message: 'strict validation failed',
        },
      }).success,
    ).toBe(false);
  });

  it('keeps checked-in capability schemas aligned with the Host contract', () => {
    const generated = collaborationAnalysisJsonSchemas();
    const directory = path.resolve(process.cwd(), 'project-analyst/contracts');
    for (const [file, schema] of [
      ['analysis-input.schema.json', generated.input],
      ['analysis-result.schema.json', generated.result],
      ['proposed-action.schema.json', generated.action],
      ['repository-analysis-input.schema.json', generated.repositoryInput],
      ['repository-analysis-result.schema.json', generated.repositoryResult],
      ['repository-verification.schema.json', generated.repositoryVerification],
    ] as const)
      expect(
        JSON.parse(readFileSync(path.join(directory, file), 'utf8')),
      ).toEqual(schema);
  });
});
