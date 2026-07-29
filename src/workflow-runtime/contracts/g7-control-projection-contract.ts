import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G7_DATABASE_SCHEMA_HASH,
  G7_DATABASE_SCHEMA_VERSION,
  G7_EXIT_STATUS,
  G7_FIXTURE_BINDING_DOMAIN,
  G7_PERSISTENT_MODE_POLICY,
} from './g7-control-projection-types.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

export const G7_IMPLEMENTATION_SOURCE_PATHS = [
  'src/workflow-runtime/store/runtime-store/command-ingress-integrity.ts',
  'src/workflow-runtime/store/runtime-store/index.ts',
  'src/workflow-runtime/runtime/commands.ts',
  'src/workflow-runtime/runtime/node-execution.ts',
  'src/workflow-runtime/runtime/root-finalizer.ts',
  'src/workflow-runtime/runtime/graph-runtime.ts',
  'src/workflow-runtime/runtime/card-presentation.ts',
  'src/workflow-runtime/capacity/runtime-center-api.ts',
  'src/workflow-runtime/projection/workflow-projection.ts',
  'src/workflow-runtime/projection/runtime-center-api.ts',
  'src/workflow-runtime/projection/runtime-center-renderer/entry.ts',
] as const;

const evidenceSourcePaths = [
  'src/workflow-runtime/contracts/g7-control-projection-types.ts',
  'src/workflow-runtime/contracts/g7-control-projection-contract.ts',
  'src/workflow-runtime/contracts/g7-control-projection-contract-cli.ts',
  'src/workflow-runtime/contracts/g7-control-projection-contract.test.ts',
  'src/workflow-runtime/contracts/g7-control-projection-reference-model.ts',
  'src/workflow-runtime/contracts/g7-control-projection-reference-model.test.ts',
  'src/workflow-runtime/contracts/g7-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/runtime/g7-test-support.ts',
  'src/workflow-runtime/runtime/g7-control-recovery.test.ts',
  'src/workflow-runtime/runtime/g7-card-presentation.test.ts',
  'src/workflow-runtime/projection/g7-workflow-projection.test.ts',
] as const;

const exactBindings = [
  {
    name: 'g6_dynamic_close_accepted_candidate',
    path: 'src/workflow-runtime/contracts/contract-pack-g6-dynamic-close.json',
    hash: 'sha256:d6d1957d342ff4d0259ede4ec8e6dcc14f3ebad08408fc555a71832428b17f94',
  },
  {
    name: 'workflow_runtime_command_protocol',
    path: 'src/workflow-runtime/contracts/protocols/workflow-runtime-command-protocol-table.json',
    hash: 'sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba',
  },
  {
    name: 'workflow_run_transaction_protocol',
    path: 'src/workflow-runtime/contracts/protocols/workflow-run-transaction-protocol-table.json',
    hash: 'sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79',
  },
  {
    name: 'closed_schema_pack',
    path: 'src/workflow-runtime/contracts/contract-pack-closed-schemas.json',
    hash: 'sha256:6f7aa5b997c5a496a4eb95776a09f18e3c25753e7324a6ef1f095a23b8413d81',
  },
  {
    name: 'database_schema_11',
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema-v11.json',
    hash: 'sha256:2adb9376d341ad430155829647086bcc76f84ebf22dffac28c19d4026ea06ab2',
  },
] as const;

export type G7FixtureCategory = 'positive' | 'negative' | 'fault';

interface FixtureSeed {
  readonly caseId: string;
  readonly surface: string;
  readonly assertion: string;
  readonly expected: 'committed' | 'rejected' | 'rolled_back' | 'exact_replay';
  readonly exactError?: string;
}

export interface G7FixtureBindingInput extends JsonObject {
  readonly case_id: string;
  readonly category: G7FixtureCategory;
  readonly surface: string;
  readonly assertion: string;
  readonly handler: string;
  readonly operation: JsonObject;
  readonly oracle: JsonObject;
}

export interface G7FixtureCase extends G7FixtureBindingInput {
  readonly binding_hash: Sha256Hash;
}

const positiveSeeds: readonly FixtureSeed[] = [
  [
    'authenticated_gateway_audit',
    'Command',
    'every authenticated call appends ingress audit and resolved calls also bind Header and Invocation',
  ],
  [
    'command_duplicate_conflict',
    'Command',
    'exact replay preserves Header canonical result without reauthorization or execution and appends duplicate audits',
  ],
  [
    'pause_resume_recovery',
    'Command/Recovery',
    'paused resumes through resuming drain without authority reset',
  ],
  [
    'cancel_run_t7c',
    'T7c',
    'local graph cancel wins the root close CAS and freezes local scope',
  ],
  [
    'cancel_workflow_t7c',
    'T7c',
    'workflow cancel wins the root close CAS and freezes workflow scope',
  ],
  [
    'deadline_system_grant',
    'Deadline/T7c',
    'deadline actor uses due-target grant and stable workflow deadline key',
  ],
  [
    'manual_skip_fact',
    'Command/T3',
    'paused nonterminal node becomes skipped and emits terminal Fact',
  ],
  [
    'authorized_manual_retry',
    'Command/T6d',
    'Gateway audit precedes authorized early schedule consumption',
  ],
  [
    'effect_reconcile_retry_wait',
    'T6e',
    'reconcile records finite retry-wait attempt without false success',
  ],
  [
    'effect_receipt_recovered',
    'T6e',
    'verified receipt and immutable snapshots resolve effect_unknown',
  ],
  [
    'effect_not_applied',
    'T6e',
    'verified not-applied proof resolves effect_unknown as failed',
  ],
  [
    'compensation_source_resolution',
    'T6e',
    'verified compensation closes compensation dead-letter blocker',
  ],
  [
    'claim_release_source_resolution',
    'T6e',
    'released fenced Claim closes claim blocker',
  ],
  [
    'resource_preflight_source_resolution',
    'T6e',
    'scheduled exact retry preflight closes resource blocker',
  ],
  [
    'integrity_restore_source_resolution',
    'T6e',
    'trusted full-chain evidence closes quarantine blocker',
  ],
  [
    'root_finalization_t8_resolution',
    'T6e/T8',
    'ready finalization source and blocker close commit with T8',
  ],
  [
    'last_blocker_restoration',
    'T6e',
    'highest remaining severity drives cache and last close restores healthy',
  ],
  [
    'administrative_abandon_confirmation',
    'Command',
    'same Human session consumes one five-minute confirmation',
  ],
  [
    'card_deterministic_snapshot',
    'Card',
    'exact identities deterministically persist pinned rendered snapshot',
  ],
  [
    'card_typed_action_dispatch',
    'Card',
    'closed action dispatches only wait business or runtime handler',
  ],
  [
    'projection_event_replay',
    'Projection',
    'adjacent source hash chain applies and exact replay duplicates',
  ],
  [
    'projection_generation_rebuild',
    'Projection',
    'validated export switches one generation atomically',
  ],
  [
    'runtime_center_closed_api',
    'Projection/API',
    'four views enforce closed filters sorts and page bounds',
  ],
  [
    'runtime_center_signed_cursor',
    'Projection/API',
    'HMAC cursor binds view filter sort and source head',
  ],
  [
    'runtime_center_empty_state',
    'Projection/Renderer',
    'zero rows remains distinct ready empty state',
  ],
  [
    'runtime_center_deep_link',
    'Projection/API',
    'typed deep link verifies bidirectional lineage',
  ],
  [
    'capacity_authoritative_subpage',
    'Capacity/API',
    'diagnostic subpage reads authoritative head snapshot telemetry and history',
  ],
  [
    'capacity_full_snapshot_replace',
    'Capacity/API',
    'closed full replacement calls Capacity Admin CAP0 through CAP4',
  ],
  [
    'renderer_import_isolation',
    'Boundary',
    'Runtime Center renderer is independent from Feature and monolith',
  ],
].map(([caseId, surface, assertion]) => ({
  caseId,
  surface,
  assertion,
  expected: 'committed' as const,
}));

const negativeSeeds: readonly FixtureSeed[] = [
  [
    'unauthenticated_actor',
    'Command',
    'missing server authentication rejects',
    'forbidden_surface',
  ],
  [
    'permission_denied',
    'Command',
    'missing minimum permission denies and audits',
    'permission_denied',
  ],
  [
    'feature_ceiling_denied',
    'Command',
    'Feature ceiling cannot be widened by actor permission',
    'feature_ceiling_denied',
  ],
  [
    'command_policy_denied',
    'Command',
    'Published policy false denies and audits',
    'command_policy_denied',
  ],
  [
    'state_guard_failed',
    'Command',
    'closed state guard cannot be bypassed',
    'state_guard_failed',
  ],
  [
    'row_version_conflict',
    'Command',
    'stale expected version conflicts without target mutation',
    'row_version_conflict',
  ],
  [
    'target_kind_invalid',
    'Command',
    'closed typed claim resolving in a different target relation persists terminal ingress denial',
    'target_kind_invalid',
  ],
  [
    'target_not_found_ingress_denial',
    'Command',
    'missing claimed typed target persists terminal ingress denial without fabricated Header or Invocation',
    'target_not_found',
  ],
  [
    'evidence_invalid',
    'Command',
    'required typed evidence cannot be omitted',
    'evidence_invalid',
  ],
  [
    'idempotency_conflict',
    'Command',
    'same domain/key request drift conflicts',
    'idempotency_conflict',
  ],
  [
    'late_cancel_command',
    'T7c',
    'losing close command audits late and preserves winner',
    'late_command',
  ],
  [
    'deadline_actor_drift',
    'Deadline/T7c',
    'wrong actor reason key or not-due target rejects dedicated grant',
    'permission_denied',
  ],
  [
    'manual_retry_direct_g5',
    'T6d',
    'G5 public timer entry rejects manual authorization bypass',
    'forbidden_surface',
  ],
  [
    'manual_skip_unknown_effect',
    'Command',
    'unknown active effect prevents skip',
    'state_guard_failed',
  ],
  [
    'effect_key_mismatch',
    'T6e',
    'receipt or proof for another operation cannot resolve blocker',
    'precondition_failed',
  ],
  [
    'claim_not_released',
    'T6e',
    'held Claim cannot resolve claim blocker',
    'precondition_failed',
  ],
  [
    'resource_preflight_missing',
    'T6e',
    'missing or consumed schedule cannot resolve resource blocker',
    'precondition_failed',
  ],
  [
    'integrity_evidence_mismatch',
    'T6e',
    'hash mismatch or partial chain cannot restore quarantine',
    'command_policy_denied',
  ],
  [
    'root_finalization_not_ready',
    'T6e/T8',
    'non-ready finalization source cannot resolve or invoke T8',
    'precondition_failed',
  ],
  [
    'remediation_budget_exhausted',
    'T6e',
    'finite attempt or deadline ceiling rejects retry wait',
    'resource_unavailable',
  ],
  [
    'abandon_session_mismatch',
    'Command',
    'confirmation is bound to same Human session',
    'confirmation_required',
  ],
  [
    'abandon_confirmation_expired',
    'Command',
    'confirmation expires after exactly five minutes',
    'confirmation_required',
  ],
  [
    'card_secret_material',
    'Card',
    'secret-bearing field or obvious secret bytes reject before persistence',
    'contract_invalid',
  ],
  [
    'card_snapshot_tamper',
    'Card',
    'snapshot byte/hash drift fails before action handler',
    'integrity_violation',
  ],
  [
    'card_action_expired',
    'Card',
    'expired action returns inert denial without dispatch',
    'action_expired',
  ],
  [
    'projection_gap',
    'Projection',
    'source sequence gap degrades affected generation',
    'source_sequence_gap',
  ],
  [
    'projection_hash_tamper',
    'Projection',
    'source event hash mismatch degrades without partial write',
    'source_event_hash_mismatch',
  ],
  [
    'cursor_tamper_or_mismatch',
    'Projection/API',
    'signature request or snapshot mismatch fails closed',
    'cursor_invalid',
  ],
  [
    'deep_link_lineage_mismatch',
    'Projection/API',
    'broken lineage returns integrity error',
    'broken_link_integrity_error',
  ],
  [
    'capacity_initialize_or_patch',
    'Capacity/API',
    'Runtime Center rejects genesis initialization and field patch input',
    'forbidden_surface',
  ],
  [
    'capacity_delegation_bypass',
    'Capacity/API',
    'delegation cannot derive deployment Capacity authority',
    'permission_denied',
  ],
  [
    'projection_runtime_write_import',
    'Boundary',
    'Projection cannot import Runtime Store write connection',
    'forbidden_surface',
  ],
  [
    'g8_g9_surface_forbidden',
    'Boundary',
    'G7 cannot implement certification loader activation ingress or network',
    'forbidden_surface',
  ],
].map(([caseId, surface, assertion, exactError]) => ({
  caseId,
  surface,
  assertion,
  exactError,
  expected: 'rejected' as const,
}));

const faultSeeds: readonly FixtureSeed[] = [
  [
    'fault_before_command_commit',
    'Command',
    'Header Invocation Event and mutation fully roll back',
  ],
  [
    'fault_before_t7c_commit',
    'T7c',
    'close request fence command and audit fully roll back',
  ],
  [
    'fault_before_manual_retry_commit',
    'T6d',
    'schedule attempt admission ledger and audit fully roll back',
  ],
  [
    'fault_before_t6e_commit',
    'T6e',
    'source mutation attempt blocker state and audit fully roll back',
  ],
  [
    'fault_before_root_t8_commit',
    'T6e/T8',
    'blocker resolution and root commit remain one rollback boundary',
  ],
  [
    'fault_before_recovery_commit',
    'Recovery',
    'quarantine blocker events and cache fully roll back',
  ],
  [
    'fault_before_abandon_commit',
    'Command',
    'confirmation blockers schedules activation run and workflow roll back',
  ],
  [
    'fault_before_card_snapshot_commit',
    'Card',
    'snapshot Value and ownership fully roll back',
  ],
  [
    'projection_multi_mutation_atomicity',
    'Projection',
    'invalid later mutation leaves no earlier partial row',
  ],
  [
    'projection_rebuild_failure',
    'Projection',
    'failed rebuild preserves rows and degrades prior generation',
  ],
  [
    'response_loss_command',
    'Command',
    'reopen returns canonical result and appends duplicate Invocation',
  ],
  [
    'response_loss_deadline',
    'Deadline/T7c',
    'reopen stable deadline key returns duplicate without second close',
  ],
  [
    'response_loss_t6e',
    'T6e',
    'resolved blocker and source replay without duplicate resolution',
  ],
  [
    'tamper_command_result_reopen',
    'Command',
    'canonical result bytes fail domain-hash verification after reopen',
  ],
  [
    'tamper_card_snapshot_reopen',
    'Card',
    'rendered snapshot bytes fail domain-hash verification after reopen',
  ],
  [
    'tamper_recovery_authority',
    'Recovery',
    'cache manifest or completion lineage drift quarantines deterministically',
  ],
].map(([caseId, surface, assertion], index) => ({
  caseId,
  surface,
  assertion,
  expected: index < 8 ? ('rolled_back' as const) : ('exact_replay' as const),
  exactError: index < 8 ? 'fault_injected' : undefined,
}));

function handlerFor(surface: string): string {
  return `g7_${surface
    .toLowerCase()
    .replaceAll('/', '_')
    .replaceAll(/[^a-z0-9_]+/g, '_')}_production`;
}

export function calculateG7FixtureBindingHash(
  fixture: G7FixtureBindingInput,
): Sha256Hash {
  return domainSeparatedSha256(G7_FIXTURE_BINDING_DOMAIN, fixture);
}

function buildFixture(
  seed: FixtureSeed,
  category: G7FixtureCategory,
): G7FixtureCase {
  const withoutHash: G7FixtureBindingInput = {
    case_id: seed.caseId,
    category,
    surface: seed.surface,
    assertion: seed.assertion,
    handler: handlerFor(seed.surface),
    operation: {
      scenario_key: `g7:${category}:${seed.caseId}`,
      runtime_database: 'isolated_real_file_sqlite',
      projection_database: 'isolated_generation_store',
      transaction_mode: 'BEGIN_IMMEDIATE',
      virtual_clock_ms: 1_782_000_000_000,
      fake_adapter_only: true,
      fault_point:
        category === 'fault' && seed.expected === 'rolled_back'
          ? 'before_commit'
          : null,
      reopen: category === 'fault' || seed.expected === 'exact_replay',
    },
    oracle: {
      disposition: seed.expected,
      authoritative_runtime_state:
        seed.expected === 'committed' || seed.expected === 'exact_replay'
          ? 'committed'
          : 'unchanged',
      exact_error: seed.exactError ?? null,
      duplicate_authoritative_writes: 0,
      projection_can_write_runtime: false,
    },
  };
  return {
    ...withoutHash,
    binding_hash: calculateG7FixtureBindingHash(withoutHash),
  };
}

export const G7_POSITIVE_FIXTURES = positiveSeeds.map((seed) =>
  buildFixture(seed, 'positive'),
);
export const G7_NEGATIVE_FIXTURES = negativeSeeds.map((seed) =>
  buildFixture(seed, 'negative'),
);
export const G7_FAULT_FIXTURES = faultSeeds.map((seed) =>
  buildFixture(seed, 'fault'),
);

const artifactPaths = {
  protocol:
    'conformance/g7-control-projection/g7-control-card-projection-recovery-protocol@1.json',
  positive: 'conformance/g7-control-projection/positive-cases.json',
  negative: 'conformance/g7-control-projection/negative-cases.json',
  fault: 'conformance/g7-control-projection/fault-cases.json',
  reference:
    'conformance/g7-control-projection/g7-control-card-projection-recovery-reference-authority@1.json',
  implementation:
    'implementation/g7-control-card-projection-recovery-implementation@1.json',
  pack: 'contract-pack-g7-control-card-projection-recovery.json',
} as const;

function rawSha256(bytes: Buffer | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function inventory(paths: readonly string[]): JsonObject[] {
  return paths.map((relativePath) => {
    const absolute = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolute))
      throw new Error(`Missing G7 source ${relativePath}`);
    return {
      path: relativePath,
      raw_sha256: rawSha256(fs.readFileSync(absolute)),
    };
  });
}

function artifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const base = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    payload,
  };
  return {
    ...base,
    hash: calculateArtifactHash({ ...base, hash: `sha256:${'0'.repeat(64)}` }),
  };
}

function bindings(): JsonObject[] {
  return exactBindings.map((binding) => {
    const observed = parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(path.join(repoRoot, binding.path))),
    );
    if (observed.hash !== binding.hash)
      throw new Error(`${binding.name} identity drift: ${observed.hash}`);
    return { ...binding };
  });
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const upstream = bindings();
  const protocol = artifact(
    'icarus.workflow-g7-control-card-projection-recovery-protocol/1',
    'icarus.workflow-g7-control-card-projection-recovery-protocol',
    'icarus:workflow-g7-control-card-projection-recovery-protocol:1\n',
    {
      gate: 'G7',
      status: G7_EXIT_STATUS,
      persistent_mode_policy: G7_PERSISTENT_MODE_POLICY,
      accepted_base: 'main@dd3c10831dd2e9da91dcb83f28e321d538f41a05',
      database_schema_version: G7_DATABASE_SCHEMA_VERSION,
      database_schema_hash: G7_DATABASE_SCHEMA_HASH,
      schema_change_required: true,
      transaction_host: 'WorkflowRuntimeStore.withImmediateTransaction',
      transaction_mode: 'BEGIN_IMMEDIATE',
      owned_transactions: ['COMMAND', 'T7c', 'T6e', 'Recovery'],
      owned_surfaces: [
        'Deadline_Watchdog_System_Grant',
        'Runtime_Command_Gateway',
        'authorized_manual_retry_handoff',
        'Operational_Blocker_resolution_and_abandon',
        'Card_Presentation_and_action_ingress',
        'Workflow_Projection_and_Runtime_Center_API',
        'Runtime_Center_Capacity_authoritative_subpage',
        'Runtime_Center_renderer_isolation',
      ],
      exact_deadline_authority: {
        actor: 'system:deadline-watchdog',
        domain: 'system:deadline-watchdog',
        key: 'workflow-deadline:<workflow_id>:<deadline_at_ms>',
        reasons: ['deadline_enforced', 'safety_enforced'],
        predicate: 'due_target',
        grant: 'cancel_workflow_only',
      },
      projection_write_boundary:
        'projection_and_renderer_have_no_authoritative_Runtime_Store_write_connection',
      authenticated_ingress_audit: {
        relation: 'workflow_runtime_command_ingress_invocations',
        append_per_authenticated_call: true,
        pre_resolution: true,
        claimed_target: 'closed_exactly_one_typed_non_fk_union',
        unresolved_terminal_denials: [
          'target_not_found',
          'target_kind_invalid',
        ],
        unresolved_resolved_identity: 'forbidden',
        resolved_identity:
          'exact_workflow_runtime_commands_and_workflow_runtime_command_invocations',
        atomicity:
          'ingress_header_invocation_event_and_domain_mutation_same_immediate_transaction',
        exact_replay:
          'append_ingress_and_resolved_invocation_without_reauthorization_or_reexecution_and_preserve_header_canonical_result',
        same_key_drift:
          'append_ingress_and_resolved_conflict_invocation_without_header_overwrite',
      },
      authority_residuals: [],
      bindings: upstream,
      forbidden: [
        'G8_certification',
        'G9_loader_activation_ingress_network',
        'real_Adapter_or_user_data',
        'authentication_bypass',
        'Projection_Runtime_write_connection',
        'terminal_Node_or_State_reopen',
        'frozen_historical_artifact_rewrite',
      ],
    },
  );
  const positive = artifact(
    'icarus.workflow-g7-control-card-projection-recovery-positive-cases/1',
    'icarus.workflow-g7-control-card-projection-recovery-positive-cases',
    'icarus:workflow-g7-control-card-projection-recovery-positive-cases:1\n',
    { cases: G7_POSITIVE_FIXTURES as unknown as JsonValue },
  );
  const negative = artifact(
    'icarus.workflow-g7-control-card-projection-recovery-negative-cases/1',
    'icarus.workflow-g7-control-card-projection-recovery-negative-cases',
    'icarus:workflow-g7-control-card-projection-recovery-negative-cases:1\n',
    { cases: G7_NEGATIVE_FIXTURES as unknown as JsonValue },
  );
  const fault = artifact(
    'icarus.workflow-g7-control-card-projection-recovery-fault-cases/1',
    'icarus.workflow-g7-control-card-projection-recovery-fault-cases',
    'icarus:workflow-g7-control-card-projection-recovery-fault-cases:1\n',
    { cases: G7_FAULT_FIXTURES as unknown as JsonValue },
  );
  const evidence = inventory(evidenceSourcePaths);
  const reference = artifact(
    'icarus.workflow-g7-control-card-projection-recovery-reference-authority/1',
    'icarus.workflow-g7-control-card-projection-recovery-reference-authority',
    'icarus:workflow-g7-control-card-projection-recovery-reference-authority:1\n',
    {
      independent_from_runtime_and_store: true,
      command_idempotency_model:
        'canonical_header_plus_append_only_invocations',
      blocker_model: 'highest_open_severity_then_last_blocker_restoration',
      projection_model: 'strict_adjacent_source_hash_chain',
      card_model: 'snapshot_hash_permission_and_expiry_intersection',
      property_tests: true,
      real_file_sqlite_runtime_evidence: true,
      virtual_clock_and_fake_adapter_only: true,
      evidence,
      evidence_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g7-control-card-projection-recovery-evidence-tree:1\n',
        evidence,
      ),
    },
  );
  const sources = inventory(G7_IMPLEMENTATION_SOURCE_PATHS);
  const implementation = artifact(
    'icarus.workflow-g7-control-card-projection-recovery-implementation/1',
    'icarus.workflow-g7-control-card-projection-recovery-implementation',
    'icarus:workflow-g7-control-card-projection-recovery-implementation:1\n',
    {
      production_target: true,
      production_ingress_enabled: false,
      certification_enabled: false,
      production_implementation_count: sources.length,
      sources,
      source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g7-control-card-projection-recovery-source-tree:1\n',
        sources,
      ),
    },
  );
  const members = [
    protocol,
    positive,
    negative,
    fault,
    reference,
    implementation,
  ].map((member) => ({
    format: member.format,
    ref: member.ref,
    hash: member.hash,
  }));
  const pack = artifact(
    'icarus.workflow-contract-pack-g7-control-card-projection-recovery/1',
    'icarus.workflow-contract-pack-g7-control-card-projection-recovery',
    'icarus:workflow-contract-pack-g7-control-card-projection-recovery:1\n',
    {
      gate: 'G7',
      status: G7_EXIT_STATUS,
      g6_state: 'DONE_OPERATIONALLY_ACCEPTED',
      g7_state: 'IN_PROGRESS',
      g7_done: false,
      g8_through_g9: 'NOT_READY',
      persistent_mode_policy: G7_PERSISTENT_MODE_POLICY,
      production_implementation_count: G7_IMPLEMENTATION_SOURCE_PATHS.length,
      positive_case_count: G7_POSITIVE_FIXTURES.length,
      negative_case_count: G7_NEGATIVE_FIXTURES.length,
      fault_case_count: G7_FAULT_FIXTURES.length,
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g7-control-card-projection-recovery-member-tree:1\n',
        members,
      ),
    },
  );
  return [
    [artifactPaths.protocol, protocol],
    [artifactPaths.positive, positive],
    [artifactPaths.negative, negative],
    [artifactPaths.fault, fault],
    [artifactPaths.reference, reference],
    [artifactPaths.implementation, implementation],
    [artifactPaths.pack, pack],
  ];
}

function bytes(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateG7ControlProjectionContracts(): void {
  for (const [relativePath, value] of buildArtifacts()) {
    const absolute = path.join(contractsRoot, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, bytes(value), {
      encoding: 'utf8',
      mode: 0o644,
    });
    fs.renameSync(temporary, absolute);
  }
}

export function checkG7ControlProjectionContracts(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | null = null;
  for (const [relativePath, expected] of buildArtifacts()) {
    const absolute = path.join(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes(expected)
    )
      throw new Error(
        `${relativePath} is not generated byte-for-byte; run contracts:g7:generate`,
      );
    parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute)),
    );
    if (relativePath === artifactPaths.pack) pack = expected;
  }
  if (pack === null)
    throw new Error(
      'G7 Control / Card / Projection / Recovery Contract Pack is missing',
    );
  return pack;
}
