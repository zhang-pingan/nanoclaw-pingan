import { z } from 'zod';

const identifierSchema = z.string().min(1).max(240);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const isoTimeSchema = z.string().datetime({ offset: true });
const resourceRefSchema = z
  .string()
  .min(3)
  .max(1200)
  .regex(
    /^(?:work_item|workflow_instance|turn|discussion|message|notification|event|file|principal|recovery|group):[^\s]+$/u,
  );

export const collaborationAnalysisScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project') }).strict(),
  z.object({ type: z.literal('mine') }).strict(),
  z
    .object({
      type: z.literal('work_item'),
      work_item_id: identifierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('workflow_instance'),
      workflow_instance_id: identifierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('delta'),
      since_snapshot_head: gitCommitSchema,
    })
    .strict(),
]);
export type CollaborationAnalysisScope = z.infer<
  typeof collaborationAnalysisScopeSchema
>;

export const collaborationAnalysisHealthSchema = z.enum([
  'healthy',
  'needs_attention',
  'at_risk',
  'critical',
  'unknown',
]);

export const collaborationFindingKindSchema = z.enum([
  'fact',
  'inference',
  'question',
]);
export const collaborationFindingCategorySchema = z.enum([
  'delivery_risk',
  'schedule_risk',
  'dependency_risk',
  'workflow_stall',
  'assignment_gap',
  'quality_gap',
  'missing_evidence',
  'collaboration_gap',
  'information_conflict',
  'capacity_risk',
  'identity_risk',
  'protocol_risk',
  'question',
]);
export const collaborationFindingSeveritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

const createWorkItemActionSchema = z
  .object({
    action: z.literal('create_work_item'),
    parameters: z
      .object({
        type: z.enum(['task', 'issue', 'decision', 'milestone']),
        title: z.string().min(1).max(300),
        description: z.string().max(32_000).default(''),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        due_at: isoTimeSchema.nullable().default(null),
        labels: z.array(identifierSchema).max(100).default([]),
        related_work_item_ids: z.array(identifierSchema).max(100).default([]),
      })
      .strict(),
  })
  .strict();

const openDiscussionActionSchema = z
  .object({
    action: z.literal('open_discussion'),
    parameters: z
      .object({
        title: z.string().min(1).max(300),
        body: z.string().min(1).max(64_000),
        scope: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('group') }).strict(),
            z
              .object({ type: z.literal('work_item'), ref: identifierSchema })
              .strict(),
            z
              .object({
                type: z.literal('workflow_instance'),
                ref: identifierSchema,
              })
              .strict(),
            z
              .object({ type: z.literal('turn'), ref: identifierSchema })
              .strict(),
          ])
          .default({ type: 'group' }),
        mentions: z.array(identifierSchema).max(100).default([]),
      })
      .strict(),
  })
  .strict();

const postProgressActionSchema = z
  .object({
    action: z.literal('post_progress'),
    parameters: z
      .object({
        summary: z.string().min(1).max(4000),
        completed: z.array(z.string().min(1).max(1000)).max(100).default([]),
        next_steps: z.array(z.string().min(1).max(1000)).max(100).default([]),
        blockers: z.array(z.string().min(1).max(1000)).max(100).default([]),
        work_item_refs: z.array(identifierSchema).max(100).default([]),
        workflow_instance_refs: z.array(identifierSchema).max(100).default([]),
      })
      .strict(),
  })
  .strict();

const watchWorkItemActionSchema = z
  .object({
    action: z.literal('watch_work_item'),
    parameters: z.object({ work_item_id: identifierSchema }).strict(),
  })
  .strict();

const requestInformationActionSchema = z
  .object({
    action: z.literal('request_information'),
    parameters: z
      .object({
        title: z.string().min(1).max(300),
        question: z.string().min(1).max(64_000),
        affected_refs: z.array(resourceRefSchema).max(100).default([]),
        mentions: z.array(identifierSchema).max(100).default([]),
      })
      .strict(),
  })
  .strict();

const publishAnalysisReportActionSchema = z
  .object({
    action: z.literal('publish_analysis_report'),
    parameters: z
      .object({
        title: z.string().min(1).max(240),
        include_finding_ids: z.array(identifierSchema).min(1).max(200),
        destination: z.enum(['principal_workspace', 'shared_files']),
      })
      .strict(),
  })
  .strict();

export const collaborationProposedActionSchema = z.discriminatedUnion(
  'action',
  [
    createWorkItemActionSchema,
    openDiscussionActionSchema,
    postProgressActionSchema,
    watchWorkItemActionSchema,
    requestInformationActionSchema,
    publishAnalysisReportActionSchema,
  ],
);
export type CollaborationProposedAction = z.infer<
  typeof collaborationProposedActionSchema
>;

export const COLLABORATION_ANALYSIS_ALLOWED_ACTION_TYPES = [
  'create_work_item',
  'open_discussion',
  'post_progress',
  'watch_work_item',
  'request_information',
  'publish_analysis_report',
] as const satisfies readonly CollaborationProposedAction['action'][];

export const collaborationAnalysisFindingSchema = z
  .object({
    finding_id: identifierSchema,
    kind: collaborationFindingKindSchema,
    category: collaborationFindingCategorySchema,
    severity: collaborationFindingSeveritySchema,
    confidence: z.number().min(0).max(1),
    title: z.string().min(1).max(300),
    summary: z.string().min(1).max(8000),
    affected_refs: z.array(resourceRefSchema).min(1).max(100),
    evidence_refs: z.array(resourceRefSchema).min(1).max(200),
    recommendations: z.array(z.string().min(1).max(2000)).max(100).default([]),
    proposed_actions: z
      .array(collaborationProposedActionSchema)
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((finding, context) => {
    for (const key of ['affected_refs', 'evidence_refs'] as const)
      if (new Set(finding[key]).size !== finding[key].length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be unique`,
        });
  });
export type CollaborationAnalysisFinding = z.infer<
  typeof collaborationAnalysisFindingSchema
>;

export const collaborationAnalysisResultSchema = z
  .object({
    format: z.literal('icarus.collaboration-analysis-result/1'),
    contract_version: z.literal(1),
    analysis_id: identifierSchema,
    snapshot_head: gitCommitSchema,
    context_hash: sha256Schema,
    prompt_hash: sha256Schema,
    challenge: z.string().min(32).max(240),
    summary: z
      .object({
        health: collaborationAnalysisHealthSchema,
        headline: z.string().min(1).max(300),
        details: z.string().max(16_000),
      })
      .strict(),
    findings: z.array(collaborationAnalysisFindingSchema).max(200),
  })
  .strict()
  .superRefine((result, context) => {
    const ids = result.findings.map((finding) => finding.finding_id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'finding_id must be unique within a result',
      });
  });
export type CollaborationAnalysisResult = z.infer<
  typeof collaborationAnalysisResultSchema
>;

export const collaborationRepositoryVerificationLevelSchema = z.enum([
  'verified',
  'self_consistent',
  'projection_only',
  'unverified',
]);
export type CollaborationRepositoryVerificationLevel = z.infer<
  typeof collaborationRepositoryVerificationLevelSchema
>;

const collaborationRepositoryVerificationCheckSchema = z.enum([
  'passed',
  'failed',
  'not_run',
]);

export const collaborationRepositoryVerificationSchema = z
  .object({
    format: z.literal('icarus.collaboration-repository-verification/1'),
    level: collaborationRepositoryVerificationLevelSchema,
    repository_identity: z.enum([
      'trusted_input_match',
      'not_externally_anchored',
      'not_established',
    ]),
    requested_ref: z.string().min(1).max(1024),
    resolved_ref: z.string().min(1).max(1024).nullable(),
    repository_head: gitCommitSchema.nullable(),
    genesis_commit: gitCommitSchema.nullable(),
    trusted_genesis: gitCommitSchema.nullable(),
    trusted_head: gitCommitSchema.nullable(),
    event_count: z.number().int().nonnegative(),
    checks: z
      .object({
        git_repository: collaborationRepositoryVerificationCheckSchema,
        ref_resolution: collaborationRepositoryVerificationCheckSchema,
        complete_history_validation:
          collaborationRepositoryVerificationCheckSchema,
        linear_commit_history: collaborationRepositoryVerificationCheckSchema,
        strict_protocol_json: collaborationRepositoryVerificationCheckSchema,
        event_schema_and_payload_hash:
          collaborationRepositoryVerificationCheckSchema,
        aggregate_revision_and_previous_hash:
          collaborationRepositoryVerificationCheckSchema,
        commit_order: collaborationRepositoryVerificationCheckSchema,
        commit_signatures_and_actor_credentials:
          collaborationRepositoryVerificationCheckSchema,
        reducer_replay: collaborationRepositoryVerificationCheckSchema,
        materialized_projection: collaborationRepositoryVerificationCheckSchema,
        projection_json_readable:
          collaborationRepositoryVerificationCheckSchema,
        business_file_hashes: collaborationRepositoryVerificationCheckSchema,
      })
      .strict(),
    failure: z
      .object({
        code: identifierSchema,
        message: z.string().min(1).max(16_000),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((verification, context) => {
    const checks = Object.values(verification.checks);
    if (
      ['verified', 'self_consistent'].includes(verification.level) &&
      checks.some((check) => check !== 'passed')
    )
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'verified and self_consistent require every check to pass',
      });
    if (
      ['verified', 'self_consistent'].includes(verification.level) &&
      (verification.resolved_ref === null ||
        verification.repository_head === null ||
        verification.genesis_commit === null ||
        verification.failure !== null)
    )
      context.addIssue({
        code: 'custom',
        path: ['repository_head'],
        message:
          'verified and self_consistent require resolved Git metadata and no failure',
      });
    if (
      verification.level === 'verified' &&
      verification.repository_identity !== 'trusted_input_match'
    )
      context.addIssue({
        code: 'custom',
        path: ['repository_identity'],
        message: 'verified requires a matching trusted genesis or head',
      });
    if (
      verification.level === 'verified' &&
      verification.trusted_genesis === null &&
      verification.trusted_head === null
    )
      context.addIssue({
        code: 'custom',
        path: ['trusted_head'],
        message: 'verified requires a trusted genesis or head input',
      });
    if (
      verification.trusted_head !== null &&
      verification.repository_head !== null &&
      verification.trusted_head !== verification.repository_head
    )
      context.addIssue({
        code: 'custom',
        path: ['trusted_head'],
        message: 'trusted_head must match repository_head',
      });
    if (
      verification.trusted_genesis !== null &&
      verification.genesis_commit !== null &&
      verification.trusted_genesis !== verification.genesis_commit
    )
      context.addIssue({
        code: 'custom',
        path: ['trusted_genesis'],
        message: 'trusted_genesis must match genesis_commit',
      });
    if (
      verification.level === 'self_consistent' &&
      verification.repository_identity !== 'not_externally_anchored'
    )
      context.addIssue({
        code: 'custom',
        path: ['repository_identity'],
        message: 'self_consistent cannot claim an external identity anchor',
      });
    if (
      verification.level === 'self_consistent' &&
      (verification.trusted_genesis !== null ||
        verification.trusted_head !== null)
    )
      context.addIssue({
        code: 'custom',
        path: ['trusted_head'],
        message: 'self_consistent cannot include a trusted commit input',
      });
    if (
      ['projection_only', 'unverified'].includes(verification.level) &&
      verification.repository_identity !== 'not_established'
    )
      context.addIssue({
        code: 'custom',
        path: ['repository_identity'],
        message: `${verification.level} cannot establish repository identity`,
      });
    if (
      ['projection_only', 'unverified'].includes(verification.level) &&
      verification.failure === null
    )
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: `${verification.level} requires a verification failure`,
      });
    if (
      verification.level === 'projection_only' &&
      verification.checks.projection_json_readable !== 'passed'
    )
      context.addIssue({
        code: 'custom',
        path: ['checks', 'projection_json_readable'],
        message: 'projection_only requires readable Projection JSON',
      });
    if (
      verification.level === 'projection_only' &&
      (verification.resolved_ref === null ||
        verification.repository_head === null ||
        verification.genesis_commit === null ||
        verification.checks.complete_history_validation !== 'failed')
    )
      context.addIssue({
        code: 'custom',
        path: ['checks', 'complete_history_validation'],
        message:
          'projection_only requires resolved Git metadata and a failed complete history validation',
      });
    if (
      verification.level === 'projection_only' &&
      verification.checks.materialized_projection === 'passed'
    )
      context.addIssue({
        code: 'custom',
        path: ['checks', 'materialized_projection'],
        message: 'projection_only cannot claim Projection replay verification',
      });
  });
export type CollaborationRepositoryVerification = z.infer<
  typeof collaborationRepositoryVerificationSchema
>;

export const collaborationRepositoryAnalysisInputSchema = z
  .object({
    format: z.literal('icarus.collaboration-repository-analysis-input/1'),
    contract_version: z.literal(1),
    repository: z
      .object({
        source_kind: z.enum(['local', 'git_url']),
        source_label: z.string().min(1).max(1024),
        requested_ref: z.string().min(1).max(1024),
        resolved_ref: z.string().min(1).max(1024),
        repository_head: gitCommitSchema,
        genesis_commit: gitCommitSchema,
      })
      .strict(),
    scope: collaborationAnalysisScopeSchema,
    current_principal_id: identifierSchema.nullable(),
    resource_catalog_hash: sha256Schema,
    generated_at: isoTimeSchema,
    security: z
      .object({
        repository_content_is_untrusted: z.literal(true),
        read_only_repository: z.literal(true),
        required_result_format: z.literal(
          'icarus.collaboration-repository-analysis-result/1',
        ),
        result_is_not_icarus_analysis_run: z.literal(true),
      })
      .strict(),
    verification: collaborationRepositoryVerificationSchema,
    change_range: z
      .object({
        since_snapshot_head: gitCommitSchema,
        repository_head: gitCommitSchema,
        event_count: z.number().int().nonnegative(),
        changed_refs: z.array(resourceRefSchema).max(20_000),
      })
      .strict()
      .nullable(),
    project_summary: z.record(z.string(), z.unknown()),
    my_items: z.array(z.record(z.string(), z.unknown())).max(1000),
    rule_signals: z.array(z.record(z.string(), z.unknown())).max(1000),
    resource_index: z.array(resourceRefSchema).max(20_000),
    activity_delta: z.array(z.record(z.string(), z.unknown())).max(2000),
    prior_findings: z.array(z.record(z.string(), z.unknown())).max(1000),
  })
  .strict()
  .superRefine((input, context) => {
    for (const [repositoryField, verificationField] of [
      ['requested_ref', 'requested_ref'],
      ['resolved_ref', 'resolved_ref'],
      ['repository_head', 'repository_head'],
      ['genesis_commit', 'genesis_commit'],
    ] as const)
      if (
        input.repository[repositoryField] !==
        input.verification[verificationField]
      )
        context.addIssue({
          code: 'custom',
          path: ['verification', verificationField],
          message: `${verificationField} must match repository metadata`,
        });
    if (input.verification.level === 'unverified')
      context.addIssue({
        code: 'custom',
        path: ['verification', 'level'],
        message: 'unverified diagnostics cannot produce an analysis context',
      });
    if (input.scope.type === 'mine' && input.current_principal_id === null)
      context.addIssue({
        code: 'custom',
        path: ['current_principal_id'],
        message: 'mine scope requires current_principal_id',
      });
    if ((input.scope.type === 'delta') !== (input.change_range !== null))
      context.addIssue({
        code: 'custom',
        path: ['change_range'],
        message: 'change_range must be present exactly for delta scope',
      });
    if (
      input.scope.type === 'delta' &&
      input.change_range !== null &&
      (input.change_range.since_snapshot_head !==
        input.scope.since_snapshot_head ||
        input.change_range.repository_head !== input.repository.repository_head)
    )
      context.addIssue({
        code: 'custom',
        path: ['change_range'],
        message: 'change_range must match the delta scope and repository head',
      });
  });
export type CollaborationRepositoryAnalysisInput = z.infer<
  typeof collaborationRepositoryAnalysisInputSchema
>;

export const collaborationRepositoryAnalysisResultSchema = z
  .object({
    format: z.literal('icarus.collaboration-repository-analysis-result/1'),
    contract_version: z.literal(1),
    repository_head: gitCommitSchema,
    context_hash: sha256Schema,
    resource_catalog_hash: sha256Schema,
    scope: collaborationAnalysisScopeSchema,
    verification_level: z.enum([
      'verified',
      'self_consistent',
      'projection_only',
    ]),
    summary: z
      .object({
        health: collaborationAnalysisHealthSchema,
        headline: z.string().min(1).max(300),
        details: z.string().max(16_000),
      })
      .strict(),
    findings: z.array(collaborationAnalysisFindingSchema).max(200),
  })
  .strict()
  .superRefine((result, context) => {
    const ids = result.findings.map((finding) => finding.finding_id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'finding_id must be unique within a result',
      });
  });
export type CollaborationRepositoryAnalysisResult = z.infer<
  typeof collaborationRepositoryAnalysisResultSchema
>;

export const collaborationAnalysisInputSchema = z
  .object({
    format: z.literal('icarus.collaboration-analysis-input/1'),
    contract_version: z.literal(1),
    analysis_id: identifierSchema,
    group_id: identifierSchema,
    snapshot_head: gitCommitSchema,
    scope: collaborationAnalysisScopeSchema,
    current_principal_id: identifierSchema.nullable(),
    generated_at: isoTimeSchema,
    security: z
      .object({
        project_content_is_untrusted: z.literal(true),
        read_only_snapshot: z.literal(true),
        required_result_format: z.literal(
          'icarus.collaboration-analysis-result/1',
        ),
      })
      .strict(),
    change_range: z
      .object({
        since_snapshot_head: gitCommitSchema,
        snapshot_head: gitCommitSchema,
        event_count: z.number().int().nonnegative(),
        changed_refs: z.array(resourceRefSchema).max(20_000),
      })
      .strict()
      .nullable()
      .optional(),
    project_summary: z.record(z.string(), z.unknown()),
    my_items: z.array(z.record(z.string(), z.unknown())).max(1000),
    rule_signals: z.array(z.record(z.string(), z.unknown())).max(1000),
    resource_index: z.array(resourceRefSchema).max(20_000),
    activity_delta: z.array(z.record(z.string(), z.unknown())).max(2000),
    prior_findings: z.array(z.record(z.string(), z.unknown())).max(1000),
  })
  .strict();
export type CollaborationAnalysisInput = z.infer<
  typeof collaborationAnalysisInputSchema
>;

export const collaborationAnalysisRunStatusSchema = z.enum([
  'prepared',
  'running',
  'awaiting_external_result',
  'validating',
  'ready_for_review',
  'invalid',
  'partially_applied',
  'completed',
  'cancelled',
  'failed',
  'stale',
]);
export type CollaborationAnalysisRunStatus = z.infer<
  typeof collaborationAnalysisRunStatusSchema
>;

export const collaborationFindingDecisionSchema = z.enum([
  'accepted',
  'deferred',
  'ignored',
  'false_positive',
]);
export type CollaborationFindingDecision = z.infer<
  typeof collaborationFindingDecisionSchema
>;

export const COLLABORATION_ANALYSIS_STATUS_TRANSITIONS: Readonly<
  Record<
    CollaborationAnalysisRunStatus,
    readonly CollaborationAnalysisRunStatus[]
  >
> = {
  prepared: ['running', 'awaiting_external_result', 'cancelled', 'stale'],
  running: ['validating', 'failed', 'stale'],
  awaiting_external_result: ['validating', 'cancelled', 'stale'],
  validating: ['ready_for_review', 'invalid', 'stale'],
  invalid: ['awaiting_external_result', 'running', 'stale'],
  ready_for_review: ['partially_applied', 'completed', 'stale'],
  partially_applied: ['partially_applied', 'completed', 'stale'],
  completed: ['stale'],
  cancelled: [],
  failed: ['running', 'stale'],
  stale: [],
};

export function assertCollaborationAnalysisTransition(
  current: CollaborationAnalysisRunStatus,
  next: CollaborationAnalysisRunStatus,
): void {
  if (!COLLABORATION_ANALYSIS_STATUS_TRANSITIONS[current].includes(next))
    throw new Error(`Illegal Analysis Run transition: ${current} -> ${next}`);
}

export function collaborationAnalysisJsonSchemas(): {
  readonly input: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly action: Record<string, unknown>;
  readonly repositoryInput: Record<string, unknown>;
  readonly repositoryResult: Record<string, unknown>;
  readonly repositoryVerification: Record<string, unknown>;
} {
  return {
    input: z.toJSONSchema(collaborationAnalysisInputSchema) as Record<
      string,
      unknown
    >,
    result: z.toJSONSchema(collaborationAnalysisResultSchema) as Record<
      string,
      unknown
    >,
    action: z.toJSONSchema(collaborationProposedActionSchema) as Record<
      string,
      unknown
    >,
    repositoryInput: z.toJSONSchema(
      collaborationRepositoryAnalysisInputSchema,
    ) as Record<string, unknown>,
    repositoryResult: z.toJSONSchema(
      collaborationRepositoryAnalysisResultSchema,
    ) as Record<string, unknown>,
    repositoryVerification: z.toJSONSchema(
      collaborationRepositoryVerificationSchema,
    ) as Record<string, unknown>,
  };
}
