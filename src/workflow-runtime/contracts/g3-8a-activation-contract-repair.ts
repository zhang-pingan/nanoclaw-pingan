import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import { G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE } from './g3-retention-executor-abi-preflight-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import {
  G38A_ERROR_PRECEDENCE,
  G38A_EVENT_TYPES,
  G38A_FORMATS,
  G38A_INVOCATION_DISPOSITIONS,
  G38A_STATUS,
  G38A_TERMINAL_DISPOSITIONS,
  type G38AActivationScenario,
  type G38ANegativeMutation,
  type G38ARejectionFixture,
  type G38ARepairPayload,
  type G38AScenarioFixture,
  type G38AScenarioResult,
  type G38ATerminalDisposition,
} from './g3-8a-activation-contract-repair-types.js';

const contractsRoot = import.meta.dirname;
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';

export const G38A_ROOT = 'conformance/g3.8a-activation-contract-repair';
export const G38A_REPAIR_SCHEMA_PATH =
  'registry/workflow-feature-release-activation-contract-repair-schema@1.json';
export const G38A_SCENARIO_SCHEMA_PATH =
  'registry/workflow-feature-release-activation-repair-scenario-schema@1.json';
export const G38A_NEGATIVE_CASES_SCHEMA_PATH =
  'registry/workflow-feature-release-activation-repair-negative-cases-schema@1.json';
export const G38A_REPAIR_PATH =
  'registry/workflow-feature-release-activation-contract-repair@1.json';
export const G38A_DOMAIN_CATALOG_PATH =
  'registry/workflow-feature-release-activation-contract-repair-domain-separators@1.json';
export const G38A_POSITIVE_CASES_PATH = `${G38A_ROOT}/positive-cases.json`;
export const G38A_NEGATIVE_CASES_PATH = `${G38A_ROOT}/negative-cases.json`;
export const G38A_FAULT_CASES_PATH = `${G38A_ROOT}/fault-cases.json`;
export const G38A_PACK_PATH =
  'contract-pack-g3.8a-activation-contract-repair.json';

export const G38A_REPAIR_DOMAIN =
  'icarus:workflow-feature-release-activation-contract-repair:1\n';
export const G38A_REPAIR_SCHEMA_DOMAIN =
  'icarus:workflow-feature-release-activation-contract-repair-schema:1\n';
export const G38A_SCENARIO_SCHEMA_DOMAIN =
  'icarus:workflow-feature-release-activation-repair-scenario-schema:1\n';
export const G38A_NEGATIVE_CASES_SCHEMA_DOMAIN =
  'icarus:workflow-feature-release-activation-repair-negative-cases-schema:1\n';
export const G38A_SCENARIO_RESULT_DOMAIN =
  'icarus:workflow-feature-release-activation-repair-scenario-result:1\n';
export const G38A_POSITIVE_DOMAIN =
  'icarus:workflow-g3-8a-activation-contract-repair-positive-cases:1\n';
export const G38A_NEGATIVE_DOMAIN =
  'icarus:workflow-g3-8a-activation-contract-repair-negative-cases:1\n';
export const G38A_FAULT_DOMAIN =
  'icarus:workflow-g3-8a-activation-contract-repair-fault-cases:1\n';
export const G38A_DOMAIN_CATALOG_DOMAIN =
  'icarus:workflow-feature-release-activation-contract-repair-domain-separators:1\n';
export const G38A_PACK_DOMAIN =
  'icarus:workflow-contract-pack-g3-8a-activation-contract-repair:1\n';

const CURRENT_SCHEMA_IDENTITY = {
  database_schema_version: 3,
  activation_schema_prerequisite_hash:
    'sha256:2e2e98cd8276d3b42b796afb34508be44800619d3781ddd88f10022c55a7a46e',
  g1_root_hash:
    'sha256:39f7aef4e28d3466f49832edda8ed3fd193eb4abb73b39287119ecb8247948b7',
  schema_manifest_hash:
    'sha256:9761bf8df83ace49b61c7dfce3f3523ecf7a69dacdccdd09837aa110ac021be6',
  migration_sha256:
    'sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345',
  g3_6_pack_hash:
    'sha256:4bea9b044c5dabe78d0d2b23353216f9a11b9265fea2a0004c9b811336cffadc',
  g3_7_pack_hash:
    'sha256:a1c6807f10d832876c63516687ce1965cff32ddcedd58d51ee8d24e18c4c21a3',
} as const;

const REMOVED_FIELDS = new Set([
  'receipt_required_for_all_duplicates',
  'failed_receipt',
  'conflict_receipt',
  'free_json_detail',
  'unverified_target_feature_release_id',
  'publisher_command_reuse',
  'in_memory_idempotency',
]);

export class G38AContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'G38AContractError';
  }
}

function object(
  properties: Record<string, JsonValue>,
  required = Object.keys(properties),
): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function hashSchema(): JsonObject {
  return { type: 'string', pattern: HASH_PATTERN };
}

const stringArraySchema = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
} as const;

const terminalRuleSchema = object({
  case_kind: { type: 'string', minLength: 1 },
  precondition: { type: 'string', minLength: 1 },
  invocation_disposition: { enum: [...G38A_INVOCATION_DISPOSITIONS] },
  command_terminal_disposition: {
    anyOf: [{ enum: [...G38A_TERMINAL_DISPOSITIONS] }, { type: 'null' }],
  },
  canonical_result_action: { enum: ['write', 'reference', 'unchanged'] },
  receipt_rule: {
    enum: ['required_original_transition', 'null_no_transition'],
  },
  pointer_mutation: { enum: ['exactly_once', 'none'] },
  invocation_append: { const: 'exactly_one' },
  event_profile: stringArraySchema,
  replay_rule: { type: 'string', minLength: 1 },
});

const relationChangeSchema = object({
  relation: { type: 'string', minLength: 1 },
  action: { enum: ['rebuild', 'modify', 'preserve'] },
  columns_added: stringArraySchema,
  columns_removed_or_replaced: stringArraySchema,
  foreign_keys: stringArraySchema,
  unique_keys: stringArraySchema,
  checks: stringArraySchema,
  triggers: stringArraySchema,
});

const columnRequirementSchema = object({
  relation: { type: 'string', minLength: 1 },
  name: { type: 'string', minLength: 1 },
  sqlite_type: { enum: ['TEXT', 'INTEGER'] },
  nullable: { type: 'boolean' },
  safe_integer: { enum: ['not_applicable', 'non_negative', 'positive'] },
  enum_values: stringArraySchema,
  role: { type: 'string', minLength: 1 },
});

const foreignKeyRequirementSchema = object({
  relation_id: { type: 'string', minLength: 1 },
  source_relation: { type: 'string', minLength: 1 },
  source_columns: stringArraySchema,
  target_relation: { type: 'string', minLength: 1 },
  target_columns: stringArraySchema,
  nullable: { type: 'boolean' },
  deferrability: { const: 'deferred' },
});

const uniqueKeyRequirementSchema = object({
  key_id: { type: 'string', minLength: 1 },
  relation: { type: 'string', minLength: 1 },
  columns: stringArraySchema,
  predicate: {
    anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
  },
});

const recoveryStepSchema = object({
  order: { type: 'integer', minimum: 1 },
  step_id: { type: 'string', minLength: 1 },
  rule: { type: 'string', minLength: 1 },
  tamper_action: { enum: ['not_applicable', 'fail_closed'] },
});

export const G38A_REPAIR_SCHEMA: JsonObject = {
  $schema: DRAFT_2020_12,
  $id: 'https://icarus.local/schemas/workflow-feature-release-activation-contract-repair/1',
  title: 'G3.8A Feature Release Activation Contract Repair v1',
  ...object({
    format: { const: G38A_FORMATS.repair },
    contract_version: { const: 1 },
    status: { const: G38A_STATUS },
    production_reachable: { const: false },
    owns_schema_implementation: { const: false },
    owns_activation_implementation: { const: false },
    current_database_schema_version: { const: 3 },
    required_database_schema_version: { const: 4 },
    current_schema_identity: object({
      database_schema_version: { const: 3 },
      activation_schema_prerequisite_hash: hashSchema(),
      g1_root_hash: hashSchema(),
      schema_manifest_hash: hashSchema(),
      migration_sha256: hashSchema(),
      g3_6_pack_hash: hashSchema(),
      g3_7_pack_hash: hashSchema(),
    }),
    preserved_boundaries: stringArraySchema,
    receipt_policy: object({
      semantic_owner: { const: 'committed_active_pointer_transition' },
      command_storage_rule: { const: 'present_only_for_terminal_applied' },
      first_applied: { const: 'required' },
      exact_replay_applied: { const: 'same_original_receipt' },
      first_failed: { const: 'null' },
      exact_replay_failed: { const: 'null' },
      same_key_domain_drift_conflict: { const: 'null' },
      pointer_cas_conflict: { const: 'null' },
      exact_replay_pointer_cas_conflict: { const: 'null' },
    }),
    terminal_semantics: {
      type: 'array',
      minItems: 8,
      maxItems: 8,
      items: terminalRuleSchema,
    },
    caller_claims_and_verified_facts: object({
      canonical_request_authority: { type: 'string', minLength: 1 },
      command_insert_facts: stringArraySchema,
      verified_fact_rule: { type: 'string', minLength: 1 },
      verified_fact_groups: stringArraySchema,
      rejection_rule: { type: 'string', minLength: 1 },
      event_binding_rule: { type: 'string', minLength: 1 },
    }),
    command_terminal_identity: object({
      terminal_disposition_values: {
        type: 'array',
        prefixItems: G38A_TERMINAL_DISPOSITIONS.map((value) => ({
          const: value,
        })),
        minItems: G38A_TERMINAL_DISPOSITIONS.length,
        maxItems: G38A_TERMINAL_DISPOSITIONS.length,
      },
      result_value_binding: stringArraySchema,
      invocation_binding: stringArraySchema,
      full_hash_binding_rule: { type: 'string', minLength: 1 },
      immutability_rule: { type: 'string', minLength: 1 },
      duplicate_reference_rule: { type: 'string', minLength: 1 },
    }),
    constraint_timing: object({
      command_insert: stringArraySchema,
      verified_fact_enrichment: stringArraySchema,
      pending_to_applied: stringArraySchema,
      pending_to_failed: stringArraySchema,
      pending_to_conflict: stringArraySchema,
      forbidden_at_insert: stringArraySchema,
    }),
    schema4_prerequisite: object({
      owner_gate: { const: 'G1.6' },
      prerequisite_id: {
        const: 'Activation Failure / Replay Persistence Schema Prerequisite',
      },
      database_schema_version: { const: 4 },
      relation_changes: { type: 'array', items: relationChangeSchema },
      column_requirements: {
        type: 'array',
        items: columnRequirementSchema,
      },
      foreign_key_requirements: {
        type: 'array',
        items: foreignKeyRequirementSchema,
      },
      unique_key_requirements: {
        type: 'array',
        items: uniqueKeyRequirementSchema,
      },
      query_intents: stringArraySchema,
      manifest_and_fixture_outputs: stringArraySchema,
    }),
    migration_boundary: object({
      production_reachable_before_g1_6: { const: false },
      schema3_upgrade_mode: {
        const: 'empty_activation_state_only_or_fail_closed',
      },
      required_empty_relations: stringArraySchema,
      preserved_relations: stringArraySchema,
      forbidden_migration_behavior: stringArraySchema,
      identity_cascade: stringArraySchema,
    }),
    recovery_algorithm: { type: 'array', items: recoveryStepSchema },
    error_precedence: {
      type: 'array',
      prefixItems: G38A_ERROR_PRECEDENCE.map((code) => ({ const: code })),
      minItems: G38A_ERROR_PRECEDENCE.length,
      maxItems: G38A_ERROR_PRECEDENCE.length,
    },
    g3_6_nested_error_precedence: {
      type: 'array',
      prefixItems: G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE.map((code) => ({
        const: code,
      })),
      minItems: G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE.length,
      maxItems: G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE.length,
    },
    fixture_coverage: object({
      positive_case_ids: stringArraySchema,
      negative_case_ids: stringArraySchema,
      fault_case_ids: stringArraySchema,
      real_schema3_reproduction: { const: true },
      unknown_removed_extra_fail_closed: { const: true },
    }),
    forbidden_solutions: stringArraySchema,
    implementation_handoff: object({
      next_slice: { const: 'G1.6' },
      g3_9_status: { const: 'BLOCKED_BY_G1_6' },
      activation_dml_authorized: { const: false },
      schema_manifest_change_authorized_in_g3_8a: { const: false },
      completion_condition: { type: 'string', minLength: 1 },
    }),
    contract_hash: hashSchema(),
  }),
};

const scenarioCoreSchema = object({
  format: { const: G38A_FORMATS.scenario },
  case_id: { type: 'string', minLength: 1 },
  invocation_kind: { enum: ['submit', 'recovery'] },
  existing_command_state: {
    enum: [
      'absent',
      'pending_clean',
      'terminal_applied',
      'terminal_failed',
      'terminal_pointer_conflict',
    ],
  },
  submitted_domain_request: { enum: ['exact', 'drift'] },
  requested_pointer_state: { enum: ['absent', 'present'] },
  preflight_outcome: { enum: ['accepted', 'failed', 'not_run'] },
  pointer_cas_outcome: { enum: ['matched', 'conflict', 'not_run'] },
  integrity_state: {
    enum: [
      'trusted',
      'tampered_command_result_binding',
      'tampered_receipt',
      'tampered_invocation_chain',
      'tampered_event_chain',
      'pending_with_transition_evidence',
    ],
  },
  fault_point: {
    enum: ['none', 'before_commit', 'after_commit_before_response'],
  },
});

const scenarioResultSchema = object({
  format: { const: G38A_FORMATS.scenarioResult },
  outcome: { enum: ['committed', 'rolled_back', 'fail_closed'] },
  code: { type: 'string', minLength: 1 },
  invocation_disposition: {
    anyOf: [{ enum: [...G38A_INVOCATION_DISPOSITIONS] }, { type: 'null' }],
  },
  canonical_terminal_disposition: {
    anyOf: [{ enum: [...G38A_TERMINAL_DISPOSITIONS] }, { type: 'null' }],
  },
  canonical_result_action: { enum: ['written', 'referenced', 'none'] },
  receipt: {
    anyOf: [{ const: 'original_transition_receipt' }, { type: 'null' }],
  },
  command_state_after: {
    enum: [
      'absent',
      'pending_clean',
      'terminal_applied',
      'terminal_failed',
      'terminal_pointer_conflict',
    ],
  },
  pointer_transition_count: { enum: [0, 1] },
  invocation_append_count: { enum: [0, 1] },
  events: stringArraySchema,
  preflight_reexecuted: { type: 'boolean' },
  terminal_fact_trusted: { type: 'boolean' },
});

export const G38A_SCENARIO_SCHEMA: JsonObject = {
  $schema: DRAFT_2020_12,
  $id: 'https://icarus.local/schemas/workflow-feature-release-activation-repair-scenario/1',
  title: 'G3.8A Activation Repair Scenario and Result v1',
  ...object({
    case_id: { type: 'string', minLength: 1 },
    scenario: scenarioCoreSchema,
    expected: scenarioResultSchema,
  }),
};

const negativeMutationSchema = object({
  case_id: { type: 'string', minLength: 1 },
  target: { enum: ['repair', 'scenario'] },
  operation: { enum: ['add', 'remove', 'replace', 'rehash_replace'] },
  pointer: { type: 'string', pattern: '^/' },
  value: {},
  expected_code: {
    enum: [
      'repair_removed_field',
      'repair_unknown_field',
      'repair_schema_invalid',
      'repair_hash_mismatch',
      'repair_semantic_mismatch',
      'scenario_schema_invalid',
    ],
  },
});

const rejectionFixtureSchema = object({
  case_id: { type: 'string', minLength: 1 },
  precedence_rank: { type: 'integer', minimum: 1 },
  outer_code: { enum: [...G38A_ERROR_PRECEDENCE] },
  nested_g3_6_code: {
    anyOf: [
      { enum: [...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE] },
      { type: 'null' },
    ],
  },
  phase: {
    enum: [
      'admission',
      'idempotency',
      'integrity',
      'preflight',
      'activation_transaction',
      'persistence',
    ],
  },
  classification: {
    enum: ['pre_admission', 'failed', 'conflict', 'fail_closed'],
  },
  command_effect: {
    enum: [
      'absent',
      'header_unchanged',
      'terminal_failed',
      'terminal_conflict',
      'transaction_rolled_back',
    ],
  },
  receipt: { type: 'null' },
  pointer_transition_count: { const: 0 },
  invocation_append_count: { enum: [0, 1] },
  verified_fact_prefix: stringArraySchema,
});

export const G38A_NEGATIVE_CASES_SCHEMA: JsonObject = {
  $schema: DRAFT_2020_12,
  $id: 'https://icarus.local/schemas/workflow-feature-release-activation-repair-negative-cases/1',
  title: 'G3.8A Activation Repair Negative Cases v1',
  ...object({
    format: {
      const:
        'icarus.workflow-g3-8a-activation-contract-repair-negative-cases/1',
    },
    mutation_case_count: { type: 'integer', minimum: 1 },
    rejection_case_count: { type: 'integer', minimum: 1 },
    case_count: { type: 'integer', minimum: 1 },
    mutation_cases: { type: 'array', items: negativeMutationSchema },
    rejection_cases: { type: 'array', items: rejectionFixtureSchema },
  }),
};

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const validateRepairSchema = ajv.compile(G38A_REPAIR_SCHEMA as AnySchema);
const validateScenarioFixtureSchema = ajv.compile(
  G38A_SCENARIO_SCHEMA as AnySchema,
);
const validateNegativeCasesSchema = ajv.compile(
  G38A_NEGATIVE_CASES_SCHEMA as AnySchema,
);

function terminalRule(
  caseKind: string,
  precondition: string,
  invocationDisposition: string,
  commandTerminalDisposition: string | null,
  canonicalResultAction: 'write' | 'reference' | 'unchanged',
  receiptRule: 'required_original_transition' | 'null_no_transition',
  pointerMutation: 'exactly_once' | 'none',
  eventProfile: string[],
  replayRule: string,
): JsonObject {
  return {
    case_kind: caseKind,
    precondition,
    invocation_disposition: invocationDisposition,
    command_terminal_disposition: commandTerminalDisposition,
    canonical_result_action: canonicalResultAction,
    receipt_rule: receiptRule,
    pointer_mutation: pointerMutation,
    invocation_append: 'exactly_one',
    event_profile: eventProfile,
    replay_rule: replayRule,
  };
}

function relationChange(
  relation: string,
  action: 'rebuild' | 'modify' | 'preserve',
  columnsAdded: string[],
  columnsRemovedOrReplaced: string[],
  foreignKeys: string[],
  uniqueKeys: string[],
  checks: string[],
  triggers: string[],
): JsonObject {
  return {
    relation,
    action,
    columns_added: columnsAdded,
    columns_removed_or_replaced: columnsRemovedOrReplaced,
    foreign_keys: foreignKeys,
    unique_keys: uniqueKeys,
    checks,
    triggers,
  };
}

function columnRequirement(
  relation: string,
  name: string,
  sqliteType: 'TEXT' | 'INTEGER',
  nullable: boolean,
  role: string,
  options: {
    safeInteger?: 'not_applicable' | 'non_negative' | 'positive';
    enumValues?: string[];
  } = {},
): JsonObject {
  return {
    relation,
    name,
    sqlite_type: sqliteType,
    nullable,
    safe_integer: options.safeInteger ?? 'not_applicable',
    enum_values: options.enumValues ?? [],
    role,
  };
}

function valueQuartetRequirements(
  relation: string,
  prefix: string,
  nullable: boolean,
  role: string,
): JsonObject[] {
  return [
    columnRequirement(relation, `${prefix}_value_id`, 'TEXT', nullable, role),
    columnRequirement(relation, `${prefix}_hash`, 'TEXT', nullable, role),
    columnRequirement(
      relation,
      `${prefix}_schema_resource_id`,
      'TEXT',
      nullable,
      role,
    ),
    columnRequirement(
      relation,
      `${prefix}_schema_hash`,
      'TEXT',
      nullable,
      role,
    ),
  ];
}

function releaseRequirements(
  relation: string,
  prefix: string,
  nullable: boolean,
  role: string,
): JsonObject[] {
  return [
    columnRequirement(relation, `${prefix}_id`, 'TEXT', nullable, role),
    columnRequirement(relation, `${prefix}_ref`, 'TEXT', nullable, role),
    columnRequirement(relation, `${prefix}_version`, 'TEXT', nullable, role),
    columnRequirement(relation, `${prefix}_hash`, 'TEXT', nullable, role),
  ];
}

function retentionRequirements(prefix: 'target' | 'previous'): JsonObject[] {
  const relation = 'workflow_feature_release_activation_commands';
  const stem = `verified_${prefix}_retention`;
  const role = `verified_${prefix}_retention_fact`;
  return [
    columnRequirement(relation, `${stem}_handle_id`, 'TEXT', true, role),
    columnRequirement(relation, `${stem}_handle_kind`, 'TEXT', true, role, {
      enumValues: ['published'],
    }),
    columnRequirement(
      relation,
      `${stem}_feature_release_id`,
      'TEXT',
      true,
      role,
    ),
    columnRequirement(
      relation,
      `${stem}_closure_manifest_id`,
      'TEXT',
      true,
      role,
    ),
    columnRequirement(relation, `${stem}_closure_hash`, 'TEXT', true, role),
    columnRequirement(relation, `${stem}_observed_status`, 'TEXT', true, role, {
      enumValues: ['held'],
    }),
    columnRequirement(
      relation,
      `${stem}_observed_row_version`,
      'INTEGER',
      true,
      role,
      { safeInteger: 'non_negative' },
    ),
  ];
}

function foreignKeyRequirement(
  relationId: string,
  sourceRelation: string,
  sourceColumns: string[],
  targetRelation: string,
  targetColumns: string[],
  nullable: boolean,
): JsonObject {
  return {
    relation_id: relationId,
    source_relation: sourceRelation,
    source_columns: sourceColumns,
    target_relation: targetRelation,
    target_columns: targetColumns,
    nullable,
    deferrability: 'deferred',
  };
}

function uniqueKeyRequirement(
  keyId: string,
  relation: string,
  columns: string[],
  predicate: string | null = null,
): JsonObject {
  return { key_id: keyId, relation, columns, predicate };
}

function buildColumnRequirements(): JsonObject[] {
  const command = 'workflow_feature_release_activation_commands';
  const invocation = 'workflow_feature_release_activation_invocations';
  const event = 'workflow_feature_release_activation_events';
  return [
    ...valueQuartetRequirements(
      command,
      'verified_compatibility_input',
      true,
      'verified_g3_6_input',
    ),
    ...valueQuartetRequirements(
      command,
      'verified_compatibility_result',
      true,
      'verified_g3_6_result',
    ),
    columnRequirement(
      command,
      'verified_feature_id',
      'TEXT',
      true,
      'verified_feature_owner',
    ),
    ...releaseRequirements(
      command,
      'verified_target_feature_release',
      true,
      'verified_target_release',
    ),
    ...releaseRequirements(
      command,
      'verified_previous_feature_release',
      true,
      'verified_previous_release',
    ),
    ...retentionRequirements('target'),
    ...retentionRequirements('previous'),
    columnRequirement(
      command,
      'observed_pointer_state',
      'TEXT',
      true,
      'verified_pointer_observation',
      { enumValues: ['absent', 'present'] },
    ),
    columnRequirement(
      command,
      'observed_pointer_row_version',
      'INTEGER',
      true,
      'verified_pointer_observation',
      { safeInteger: 'positive' },
    ),
    ...releaseRequirements(
      command,
      'observed_feature_release',
      true,
      'verified_pointer_observation',
    ),
    columnRequirement(
      command,
      'terminal_disposition',
      'TEXT',
      true,
      'canonical_terminal_outcome',
      { enumValues: [...G38A_TERMINAL_DISPOSITIONS] },
    ),
    ...valueQuartetRequirements(
      command,
      'canonical_terminal_result',
      true,
      'canonical_terminal_result',
    ),
    columnRequirement(
      command,
      'canonical_terminal_invocation_id',
      'TEXT',
      true,
      'canonical_terminal_invocation',
    ),
    columnRequirement(
      command,
      'canonical_terminal_invocation_no',
      'INTEGER',
      true,
      'canonical_terminal_invocation',
      { safeInteger: 'positive' },
    ),
    columnRequirement(
      command,
      'canonical_terminal_invocation_hash',
      'TEXT',
      true,
      'canonical_terminal_invocation',
    ),
    columnRequirement(
      command,
      'canonical_terminal_submitted_request_hash',
      'TEXT',
      true,
      'canonical_terminal_invocation',
    ),
    columnRequirement(
      command,
      'lifecycle',
      'TEXT',
      false,
      'command_lifecycle_replacement',
      { enumValues: ['pending', 'applied', 'failed', 'conflict'] },
    ),
    columnRequirement(
      invocation,
      'invocation_kind',
      'TEXT',
      false,
      'authenticated_invocation_kind',
      { enumValues: ['submit', 'recovery'] },
    ),
    ...valueQuartetRequirements(
      invocation,
      'referenced_terminal_result',
      true,
      'typed_terminal_result_reference',
    ),
    columnRequirement(
      event,
      'verified_feature_id',
      'TEXT',
      true,
      'nullable_verified_event_release',
    ),
    ...releaseRequirements(
      event,
      'verified_target_feature_release',
      true,
      'nullable_verified_event_release',
    ),
    ...releaseRequirements(
      event,
      'verified_previous_feature_release',
      true,
      'nullable_verified_event_release',
    ),
    columnRequirement(
      event,
      'event_type',
      'TEXT',
      false,
      'event_type_replacement',
      { enumValues: [...G38A_EVENT_TYPES] },
    ),
  ];
}

function buildForeignKeyRequirements(): JsonObject[] {
  const command = 'workflow_feature_release_activation_commands';
  const invocation = 'workflow_feature_release_activation_invocations';
  const event = 'workflow_feature_release_activation_events';
  const valueTarget = [
    'id',
    'content_hash',
    'schema_resource_id',
    'schema_resource_hash',
  ];
  const valueSource = (prefix: string) => [
    `${prefix}_value_id`,
    `${prefix}_hash`,
    `${prefix}_schema_resource_id`,
    `${prefix}_schema_hash`,
  ];
  const releaseTarget = ['feature_id', 'id', 'release_hash'];
  const releaseSource = (prefix: string, feature = 'verified_feature_id') => [
    feature,
    `${prefix}_id`,
    `${prefix}_hash`,
  ];
  const retentionTarget = [
    'id',
    'handle_kind',
    'feature_release_id',
    'closure_manifest_id',
    'closure_hash',
  ];
  const retentionSource = (prefix: 'target' | 'previous') => {
    const stem = `verified_${prefix}_retention`;
    return [
      `${stem}_handle_id`,
      `${stem}_handle_kind`,
      `${stem}_feature_release_id`,
      `${stem}_closure_manifest_id`,
      `${stem}_closure_hash`,
    ];
  };
  return [
    foreignKeyRequirement(
      'fk:activation_commands:verified_compatibility_input',
      command,
      valueSource('verified_compatibility_input'),
      'workflow_values',
      valueTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:verified_compatibility_result',
      command,
      valueSource('verified_compatibility_result'),
      'workflow_values',
      valueTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:verified_target_release',
      command,
      releaseSource('verified_target_feature_release'),
      'workflow_feature_releases',
      releaseTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:verified_previous_release',
      command,
      releaseSource('verified_previous_feature_release'),
      'workflow_feature_releases',
      releaseTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:observed_release',
      command,
      releaseSource('observed_feature_release'),
      'workflow_feature_releases',
      releaseTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:verified_target_retention',
      command,
      retentionSource('target'),
      'workflow_registry_retention_handles',
      retentionTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:verified_previous_retention',
      command,
      retentionSource('previous'),
      'workflow_registry_retention_handles',
      retentionTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:canonical_terminal_result',
      command,
      valueSource('canonical_terminal_result'),
      'workflow_values',
      valueTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_commands:canonical_terminal_invocation',
      command,
      [
        'canonical_terminal_invocation_id',
        'command_id',
        'canonical_terminal_invocation_no',
        'domain_request_hash',
        'terminal_disposition',
        'canonical_terminal_invocation_hash',
        'canonical_terminal_submitted_request_hash',
        ...valueSource('canonical_terminal_result'),
      ],
      invocation,
      [
        'id',
        'command_id',
        'invocation_no',
        'command_domain_request_hash',
        'disposition',
        'invocation_hash',
        'submitted_request_hash',
        ...valueSource('result'),
      ],
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_invocations:referenced_terminal_result',
      invocation,
      valueSource('referenced_terminal_result'),
      'workflow_values',
      valueTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_events:verified_target_release',
      event,
      releaseSource('verified_target_feature_release'),
      'workflow_feature_releases',
      releaseTarget,
      true,
    ),
    foreignKeyRequirement(
      'fk:activation_events:verified_previous_release',
      event,
      releaseSource('verified_previous_feature_release'),
      'workflow_feature_releases',
      releaseTarget,
      true,
    ),
  ];
}

function buildUniqueKeyRequirements(): JsonObject[] {
  return [
    uniqueKeyRequirement(
      'uk:activation_commands:idempotency',
      'workflow_feature_release_activation_commands',
      ['idempotency_domain', 'idempotency_key'],
    ),
    uniqueKeyRequirement(
      'uk:activation_commands:id_domain_request',
      'workflow_feature_release_activation_commands',
      ['command_id', 'domain_request_hash'],
    ),
    uniqueKeyRequirement(
      'uk:activation_invocations:command_no',
      'workflow_feature_release_activation_invocations',
      ['command_id', 'invocation_no'],
    ),
    uniqueKeyRequirement(
      'uk:activation_invocations:invocation_hash',
      'workflow_feature_release_activation_invocations',
      ['invocation_hash'],
    ),
    uniqueKeyRequirement(
      'uk:activation_invocations:terminal_binding',
      'workflow_feature_release_activation_invocations',
      [
        'id',
        'command_id',
        'invocation_no',
        'command_domain_request_hash',
        'disposition',
        'invocation_hash',
        'submitted_request_hash',
        'result_value_id',
        'result_hash',
        'result_schema_resource_id',
        'result_schema_hash',
      ],
    ),
    uniqueKeyRequirement(
      'uk:activation_events:attempt_phase_type',
      'workflow_feature_release_activation_events',
      ['command_id', 'attempt_no', 'phase', 'event_type'],
    ),
    uniqueKeyRequirement(
      'uk:activation_events:event_hash',
      'workflow_feature_release_activation_events',
      ['event_hash'],
    ),
  ];
}

const POSITIVE_CASE_IDS = [
  'first-applied-absent-pointer',
  'first-applied-present-pointer',
  'exact-replay-applied',
  'first-failed',
  'exact-replay-failed',
  'same-key-domain-drift-conflict',
  'repeated-same-key-domain-drift-conflict',
  'pointer-cas-conflict',
  'exact-replay-pointer-cas-conflict',
] as const;

const NEGATIVE_CASE_IDS = [
  'removed-field-receipt-required-for-all-duplicates',
  'unknown-top-level-field',
  'extra-nested-receipt-field',
  'missing-status',
  'production-reachable-forbidden',
  'current-schema-version-drift',
  'contract-hash-drift',
  'rehash-failed-receipt-semantic-drift',
  'rehash-terminal-rule-order-drift',
  'scenario-unknown-field',
  'scenario-removed-field',
  'scenario-invalid-command-state',
] as const;

const FAULT_CASE_IDS = [
  'rollback-after-request-value',
  'rollback-after-command-pending',
  'rollback-after-verified-preflight',
  'rollback-after-previous-draining',
  'rollback-after-target-active',
  'rollback-after-pointer-cas',
  'rollback-after-receipt',
  'rollback-after-terminal-invocation',
  'rollback-after-terminal-events',
  'post-commit-applied-response-lost',
  'reopen-after-applied-response-lost',
  'reopen-after-failed-response-lost',
  'tampered-command-result-binding',
  'tampered-receipt',
  'tampered-invocation-chain',
  'tampered-event-chain',
  'pending-with-transition-evidence',
] as const;

function buildRepairPayloadWithoutHash(): Omit<
  G38ARepairPayload,
  'contract_hash'
> {
  return {
    format: G38A_FORMATS.repair,
    contract_version: 1,
    status: G38A_STATUS,
    production_reachable: false,
    owns_schema_implementation: false,
    owns_activation_implementation: false,
    current_database_schema_version: 3,
    required_database_schema_version: 4,
    current_schema_identity: { ...CURRENT_SCHEMA_IDENTITY },
    preserved_boundaries: [
      'G3.6 remains the only compatibility composition boundary and continues to call G3.3 and G3.5 with their exact schemas, queries, error precedence, and result semantics.',
      'G3.3/G3.5 canonical Value, Registry resource, Snapshot, Closure, dependency traversal, and publication-state authorities are unchanged.',
      'G1.5 Release lifecycle, single-active, owner-consistent active pointer, adjacent CAS, and active/draining Retention protection principles are unchanged.',
      'G2 sealed Compiler/Golden identities and G0.6/G0.10 historical artifacts remain byte-unchanged.',
      'Activation remains a separate closed command domain and cannot reuse Workflow Runtime, Capacity Admin, or Publisher command unions.',
    ],
    receipt_policy: {
      semantic_owner: 'committed_active_pointer_transition',
      command_storage_rule: 'present_only_for_terminal_applied',
      first_applied: 'required',
      exact_replay_applied: 'same_original_receipt',
      first_failed: 'null',
      exact_replay_failed: 'null',
      same_key_domain_drift_conflict: 'null',
      pointer_cas_conflict: 'null',
      exact_replay_pointer_cas_conflict: 'null',
    },
    terminal_semantics: [
      terminalRule(
        'first_applied',
        'No command exists; request is exact; all typed preflights pass; expected pointer CAS matches.',
        'applied',
        'applied',
        'write',
        'required_original_transition',
        'exactly_once',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:phase_succeeded',
          'preflight:phase_succeeded',
          'activation_transaction:activation_transaction_started',
          'activation_transaction:activation_committed',
          'finalize:terminal_result_committed',
        ],
        'Every later exact request is duplicate and references this canonical terminal result and receipt without rerunning the pointer transition.',
      ),
      terminalRule(
        'exact_replay_applied',
        'The bound command is terminal applied and command/result/receipt/Invocation/Event hashes verify.',
        'duplicate',
        'applied',
        'reference',
        'required_original_transition',
        'none',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:phase_succeeded',
          'finalize:terminal_replayed',
        ],
        'Repeated exact replay remains duplicate; the duplicate result has a typed reference to the same terminal result and carries the same original receipt bytes/hash.',
      ),
      terminalRule(
        'first_failed',
        'The closed canonical request is admitted and a domain preflight other than pointer CAS rejects.',
        'failed',
        'failed',
        'write',
        'null_no_transition',
        'none',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:phase_succeeded',
          'preflight:pre_transaction_failed',
          'finalize:terminal_result_committed',
        ],
        'Every later exact request is duplicate and references the failed canonical terminal result; receipt remains null.',
      ),
      terminalRule(
        'exact_replay_failed',
        'The bound command is terminal failed and command/result/Invocation/Event hashes verify.',
        'duplicate',
        'failed',
        'reference',
        'null_no_transition',
        'none',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:phase_succeeded',
          'finalize:terminal_replayed',
        ],
        'Repeated exact replay remains duplicate; it never synthesizes a pointer receipt.',
      ),
      terminalRule(
        'same_key_domain_drift_conflict',
        'The caller key already binds a different domain_request_hash.',
        'conflict',
        null,
        'unchanged',
        'null_no_transition',
        'none',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:domain_request_conflicted',
        ],
        'The canonical command remains unchanged. If already terminal, the conflict Invocation may reference its terminal result identity but never its receipt.',
      ),
      terminalRule(
        'repeated_same_key_domain_drift_conflict',
        'The same drifting request is submitted again against the caller key.',
        'conflict',
        null,
        'unchanged',
        'null_no_transition',
        'none',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:domain_request_conflicted',
        ],
        'It remains conflict rather than duplicate because exact replay is defined only against the command-bound domain request; one new Invocation/Event suffix is appended.',
      ),
      terminalRule(
        'pointer_cas_conflict',
        'The canonical request and all domain preflights pass but observed pointer state/version differs from expected.',
        'conflict',
        'conflict',
        'write',
        'null_no_transition',
        'none',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:phase_succeeded',
          'preflight:phase_succeeded',
          'activation_transaction:activation_transaction_started',
          'activation_transaction:pointer_cas_conflicted',
          'finalize:terminal_result_committed',
        ],
        'This is the canonical terminal result for the bound request. Later exact requests are duplicate and do not re-observe or mutate the pointer.',
      ),
      terminalRule(
        'exact_replay_pointer_cas_conflict',
        'The bound command is terminal pointer conflict and command/result/Invocation/Event hashes verify.',
        'duplicate',
        'conflict',
        'reference',
        'null_no_transition',
        'none',
        [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:phase_succeeded',
          'finalize:terminal_replayed',
        ],
        'Repeated exact replay remains duplicate, references the canonical pointer-conflict result, and has no receipt.',
      ),
    ],
    caller_claims_and_verified_facts: {
      canonical_request_authority:
        'The schema-bound canonical request Value is the sole exact record of caller claims, including feature, target/previous Release, expected pointer, compatibility input, and Retention observations.',
      command_insert_facts: [
        'command_id',
        'command_type',
        'idempotency_domain',
        'idempotency_key',
        'request_value_id/hash/schema_resource_id/schema_hash',
        'domain_request_hash',
        'created_at_ms',
        'lifecycle=pending',
        'row_version=0',
      ],
      verified_fact_rule:
        'A nullable verified_* typed binding appears only after the corresponding read-only preflight succeeded against authoritative rows; absence means unverified, never inferred false or replaced by a caller claim.',
      verified_fact_groups: [
        'verified G3.6 compatibility input/result schema-bound Values',
        'verified target Release owner/ref/version/hash and exact published resource set',
        'verified previous Release owner/ref/version/hash when expected pointer is present',
        'verified target/previous published Retention Handle and Closure identity with observed held status/row_version',
        'verified observed pointer absent/present, row_version, and typed Release identity',
      ],
      rejection_rule:
        'Owner, lifecycle, resource, G3.6, Retention, and pointer rejections terminalize a schema-valid command using only facts verified before rejection; they never fabricate missing typed facts.',
      event_binding_rule:
        'Event target/previous Release bindings are nullable all-or-none typed FKs and may be present only when that identity is already verified; early rejection Events use the canonical detail Value and null typed identity.',
    },
    command_terminal_identity: {
      terminal_disposition_values: [...G38A_TERMINAL_DISPOSITIONS],
      result_value_binding: [
        'canonical_terminal_result_value_id',
        'canonical_terminal_result_hash',
        'canonical_terminal_result_schema_resource_id',
        'canonical_terminal_result_schema_hash',
      ],
      invocation_binding: [
        'canonical_terminal_invocation_id',
        'canonical_terminal_invocation_no',
        'canonical_terminal_invocation_hash',
        'canonical_terminal_submitted_request_hash',
      ],
      full_hash_binding_rule:
        'A deferred composite FK binds command id/domain/submitted hash/terminal disposition plus canonical invocation id/no/hash and result Value id/hash/schema id/hash to one immutable Invocation terminal-binding UK.',
      immutability_rule:
        'All terminal identity, disposition, result, receipt, verified fact, finalized time, and row-version fields are immutable after the one adjacent pending-to-terminal transition.',
      duplicate_reference_rule:
        'Every duplicate Invocation stores a typed referenced_terminal_result Value identity equal to the command header; original terminal Invocation uses its own result identity; domain-drift conflict may reference an already terminal header but never changes it.',
    },
    constraint_timing: {
      command_insert: [
        'closed command type and non-empty caller idempotency key',
        'schema-bound canonical request Value exact hash/schema FK',
        'domain_request_hash format and command/key uniqueness',
        'pending lifecycle with every verified/observed/terminal/result/receipt field null',
      ],
      verified_fact_enrichment: [
        'only while pending',
        'null-to-exact monotonic population by closed verified fact groups',
        'nullable typed Release/Retention/Value FKs and all-or-none shapes',
        'no caller claim is copied into verified columns before authoritative equality succeeds',
      ],
      pending_to_applied: [
        'all target/G3.6/resource/Retention verified facts present',
        'previous verified facts present iff expected pointer was present',
        'observed pointer exactly equals expected pointer',
        'target is active, previous is draining when present, active pointer is target at applied version',
        'canonical receipt and terminal result/invocation bindings present and exact',
      ],
      pending_to_failed: [
        'canonical failed terminal result/invocation binding required',
        'canonical receipt and applied pointer version null',
        'only verified prefix facts may be non-null',
        'Release lifecycle and active pointer remain unchanged',
      ],
      pending_to_conflict: [
        'reserved for canonical pointer CAS conflict, never same-key domain drift',
        'verified observed pointer fact and canonical conflict result/invocation required',
        'canonical receipt and applied pointer version null',
        'Release lifecycle and active pointer remain unchanged',
      ],
      forbidden_at_insert: [
        'target/previous Release owner composite FK over caller-requested columns',
        'target/previous Retention identity/status/row-version trigger over caller-requested columns',
        'non-null compatibility result or verified Release/Retention facts',
        'receipt or terminal result',
      ],
    },
    schema4_prerequisite: {
      owner_gate: 'G1.6',
      prerequisite_id:
        'Activation Failure / Replay Persistence Schema Prerequisite',
      database_schema_version: 4,
      relation_changes: [
        relationChange(
          'workflow_feature_release_activation_commands',
          'rebuild',
          [
            'verified_compatibility_input_value_id/hash/schema_resource_id/schema_hash nullable quartet',
            'verified_compatibility_result_value_id/hash/schema_resource_id/schema_hash nullable quartet',
            'verified_feature_id nullable external Feature ref',
            'verified_target_feature_release_id/ref/version/hash nullable all-or-none',
            'verified_previous_feature_release_id/ref/version/hash nullable all-or-none',
            'verified_target_retention_handle_id/kind/feature_release_id/closure_manifest_id/closure_hash/observed_status/observed_row_version nullable group',
            'verified_previous_retention_handle_id/kind/feature_release_id/closure_manifest_id/closure_hash/observed_status/observed_row_version nullable group',
            'observed_pointer_state nullable absent|present',
            'observed_pointer_row_version and observed_release_id/ref/version/hash nullable present-only group',
            'terminal_disposition nullable applied|failed|conflict',
            'canonical_terminal_result_value_id/hash/schema_resource_id/schema_hash nullable quartet',
            'canonical_terminal_invocation_id/no/hash/submitted_request_hash nullable group',
          ],
          [
            'required compatibility_input/result columns replaced by nullable verified_* groups',
            'required caller-claim feature/target/previous Release columns replaced by canonical request Value plus nullable verified_* groups',
            'required caller-claim target/previous Retention observation columns replaced by nullable verified_* groups',
            'lifecycle enum extended from pending|applied|failed to pending|applied|failed|conflict',
          ],
          [
            'request quartet -> workflow_values exact Value/hash/schema parent remains required',
            'verified compatibility quartets -> workflow_values nullable deferred exact Value/hash/schema parents',
            'verified target/previous/observed Release groups -> workflow_feature_releases(feature_id,id,release_hash) nullable deferred parents',
            'verified target/previous Retention groups -> immutable published identity parent excluding mutable status/row_version',
            'canonical receipt quartet -> workflow_values nullable deferred exact Value/hash/schema parent',
            'canonical terminal result quartet -> workflow_values nullable deferred exact Value/hash/schema parent',
            'canonical terminal invocation/result/disposition/domain composite -> activation Invocation terminal-binding UK',
          ],
          [
            'UNIQUE(idempotency_domain,idempotency_key)',
            'UNIQUE(command_id,domain_request_hash)',
          ],
          [
            'pending has no verified/observed/terminal/result/receipt/finalized facts',
            'terminal lifecycle equals terminal_disposition and requires canonical terminal result/invocation plus finalized_at_ms',
            'receipt and applied_pointer_row_version exist iff terminal_disposition=applied',
            'failed/conflict require receipt=null and applied_pointer_row_version=null',
            'verified and observed groups are all-or-none with absent/present pointer shape',
          ],
          [
            'replace retention_observation_insert with pending-only monotonic verified-fact enrichment validation',
            'terminalization trigger validates applied authoritative state only on pending->applied',
            'failed/conflict terminalization validates result identity but never requires unverified Release/Retention facts',
            'identity/delete immutability and adjacent row_version remain',
          ],
        ),
        relationChange(
          'workflow_feature_release_activation_invocations',
          'rebuild',
          [
            'invocation_kind submit|recovery',
            'referenced_terminal_result_value_id/hash/schema_resource_id/schema_hash nullable quartet',
          ],
          [],
          [
            'command_id/domain_request_hash -> Activation command remains',
            'result quartet -> workflow_values exact Value/hash/schema parent remains',
            'referenced terminal result quartet -> workflow_values nullable exact Value/hash/schema parent',
          ],
          [
            'UNIQUE(command_id,invocation_no)',
            'UNIQUE(invocation_hash)',
            'terminal-binding UK over id/command/no/domain/submitted/disposition/invocation_hash/result quartet',
          ],
          [
            'duplicate submitted hash equals bound hash and references command canonical terminal result',
            'domain drift conflict submitted hash differs and cannot terminalize command',
            'pointer conflict submitted hash equals bound hash and is the canonical terminal result',
            'only applied has applied_at_ms; every result remains schema-bound',
          ],
          [
            'adjacent per-command domain-separated hash-chain validation',
            'command terminal-reference consistency validation',
            'UPDATE and DELETE forbidden',
          ],
        ),
        relationChange(
          'workflow_feature_release_activation_events',
          'rebuild',
          [
            'nullable verified target/previous Release typed groups',
            'event_type domain_request_conflicted|pointer_cas_conflicted|terminal_result_committed|terminal_replayed|integrity_failed',
          ],
          [
            'required target Release identity columns become nullable verified all-or-none groups',
          ],
          [
            'command and invocation FKs remain',
            'nullable target/previous groups -> workflow_feature_releases(feature_id,id,release_hash)',
            'detail quartet -> workflow_values nullable exact Value/hash/schema parent remains',
          ],
          [
            'UNIQUE(command_id,event_no)',
            'UNIQUE(command_id,attempt_no,phase,event_type)',
            'UNIQUE(event_hash)',
          ],
          [
            'closed phase/event/failure mapping includes replay and both conflict classes',
            'typed Release facts may appear only after the matching command verified group exists',
          ],
          [
            'nullable verified command binding validation',
            'adjacent per-command domain-separated hash-chain validation',
            'UPDATE and DELETE forbidden',
          ],
        ),
        relationChange(
          'workflow_feature_releases',
          'preserve',
          [],
          [],
          ['preserve owner identity parent (feature_id,id,release_hash)'],
          ['preserve per-Feature single-active partial UK'],
          ['preserve lifecycle/timestamp shape'],
          ['preserve identity and adjacent lifecycle/row-version protections'],
        ),
        relationChange(
          'workflow_feature_active_releases',
          'preserve',
          [],
          [],
          ['preserve owner-consistent Release composite FK'],
          ['preserve feature_id primary key'],
          ['preserve positive row_version'],
          [
            'preserve target-active, adjacent CAS, identity, and delete protections',
          ],
        ),
        relationChange(
          'workflow_registry_retention_handles',
          'modify',
          [],
          [],
          ['preserve immutable published Release/Closure identity parent'],
          ['preserve published identity UK'],
          ['preserve held/released shape'],
          [
            'preserve active/draining release and delete protection',
            'do not bind mutable status/row_version in a command FK',
          ],
        ),
      ],
      column_requirements: buildColumnRequirements(),
      foreign_key_requirements: buildForeignKeyRequirements(),
      unique_key_requirements: buildUniqueKeyRequirements(),
      query_intents: [
        'activation_find_idempotency: caller key -> command plus terminal disposition/result/receipt identity',
        'activation_lookup_terminal_result: command -> canonical terminal Invocation and schema-bound result Value',
        'activation_load_invocations: adjacent immutable Invocation history',
        'activation_load_events: adjacent immutable Event replay',
        'activation_recovery_scan_pending: bounded pending scan',
        'activation_expected_pointer_cas: owner pointer state/version and exact Release identity',
        'activation_release_preflight: target/previous exact owner/ref/version/hash/lifecycle/resource set',
        'activation_retention_preflight: exact published Handle/Closure plus mutable held status/row_version observation',
      ],
      manifest_and_fixture_outputs: [
        'G1.6 versioned physical prerequisite artifact and closed dependency member',
        'Database Schema 4 canonical migration and introspected Schema Manifest',
        'typed relation catalog and schema lint for every new nullable composite FK',
        'positive/negative constraint-trigger fixtures for all terminal and verified-fact shapes',
        'query-plan fixtures for all eight query intents',
        'real-file migration/reopen/integrity/foreign-key checks',
      ],
    },
    migration_boundary: {
      production_reachable_before_g1_6: false,
      schema3_upgrade_mode: 'empty_activation_state_only_or_fail_closed',
      required_empty_relations: [
        'workflow_feature_release_activation_commands',
        'workflow_feature_release_activation_invocations',
        'workflow_feature_release_activation_events',
        'workflow_feature_active_releases',
      ],
      preserved_relations: [
        'workflow_values',
        'workflow_registry_resources/dependencies/closure/snapshot',
        'workflow_feature_releases/resources',
        'workflow_registry_retention_handles/members',
        'workflow_publisher_commands/invocations/events',
      ],
      forbidden_migration_behavior: [
        'do not reinterpret or synthesize canonical results for non-empty Schema 3 Activation audit',
        'do not copy caller claims into verified typed columns',
        'do not weaken unknown-field, hash, FK, lifecycle, CAS, or Retention protections',
        'do not claim production backward compatibility for construction-only Schema 3 data',
      ],
      identity_cascade: [
        'rebuild G1 physical identity, dependency manifest, root, migration, Manifest, DDL, and Store pins deterministically',
        'rebuild current construction G3.1/G3.3/G3.5/G3.6/G3.7/G3.8A pins as required',
        'keep G0.6/G0.10 historical source and all G2 sealed artifacts byte-unchanged',
      ],
    },
    recovery_algorithm: [
      {
        order: 1,
        step_id: 'scan_pending',
        rule: 'Scan pending commands in created_at_ms/command_id order. A pending row must have no terminal result, receipt, applied pointer version, or committed transition evidence; otherwise fail closed.',
        tamper_action: 'fail_closed',
      },
      {
        order: 2,
        step_id: 'load_terminal_identity',
        rule: 'For a terminal command load the header-bound canonical Invocation and result Value through exact composite FKs; load receipt only for terminal applied.',
        tamper_action: 'fail_closed',
      },
      {
        order: 3,
        step_id: 'verify_canonical_bytes_and_hashes',
        rule: 'Strict-parse canonical Value bytes, verify schema resource identity, result hash, command/domain/request/result binding, and applied-only receipt hash/transition facts.',
        tamper_action: 'fail_closed',
      },
      {
        order: 4,
        step_id: 'verify_invocation_chain',
        rule: 'Replay every Invocation in adjacent order, recompute its domain-separated hash, and verify result/reference rules before trusting terminal state.',
        tamper_action: 'fail_closed',
      },
      {
        order: 5,
        step_id: 'verify_event_chain',
        rule: 'Replay every Event in adjacent order, recompute its domain-separated hash, verify phase/type/detail/typed-fact mapping, and require one terminal event for the canonical terminal Invocation.',
        tamper_action: 'fail_closed',
      },
      {
        order: 6,
        step_id: 'recover_clean_pending',
        rule: 'A clean pending command may rerun the exact G3.6 composition and Activation preflights in one BEGIN IMMEDIATE; its recovery Invocation becomes the original applied/failed/pointer-conflict canonical result, not duplicate.',
        tamper_action: 'not_applicable',
      },
      {
        order: 7,
        step_id: 'pre_commit_crash',
        rule: 'Any crash or injected fault before COMMIT rolls back request/verified facts, Release lifecycle, pointer, receipt, result, Invocation, Event, and command terminalization together; an absent command retries as first invocation.',
        tamper_action: 'not_applicable',
      },
      {
        order: 8,
        step_id: 'post_commit_response_lost',
        rule: 'After COMMIT, reopen the real database, verify terminal identity and both chains, append exactly one recovery duplicate Invocation plus recovery_started/recovery_succeeded/terminal_replayed Events, and never repeat pointer DML.',
        tamper_action: 'fail_closed',
      },
    ],
    error_precedence: [...G38A_ERROR_PRECEDENCE],
    g3_6_nested_error_precedence: [
      ...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE,
    ],
    fixture_coverage: {
      positive_case_ids: [...POSITIVE_CASE_IDS],
      negative_case_ids: allNegativeCaseIds(),
      fault_case_ids: [...FAULT_CASE_IDS],
      real_schema3_reproduction: true,
      unknown_removed_extra_fail_closed: true,
    },
    forbidden_solutions: [
      'in-memory idempotency or recovery authority',
      'fabricated verified Release, Retention, pointer, receipt, Invocation, or Event facts',
      'free JSON request/result/detail or raw exception text',
      'weakening additionalProperties=false, strict parsing, or removed/unknown field precedence',
      'polymorphic kind/id, untyped ref, unconstrained side table, or duplicated member graph',
      'reuse or extension of Workflow Runtime, Capacity Admin, or Publisher command unions',
      'latest/current fallback or re-derivation of previous Release during replay',
      'Activation DML, active-pointer mutation, Store API, loader, GC/delete, or G4-G9 implementation in G3.8A',
    ],
    implementation_handoff: {
      next_slice: 'G1.6',
      g3_9_status: 'BLOCKED_BY_G1_6',
      activation_dml_authorized: false,
      schema_manifest_change_authorized_in_g3_8a: false,
      completion_condition:
        'G1.6 implements Database Schema 4 exactly, passes its full real-file positive/negative/migration/query suite, deterministically cascades current construction identities, and leaves prohibited production surfaces absent.',
    },
  };
}

export function buildG38ARepairPayload(): G38ARepairPayload {
  const withoutHash = buildRepairPayloadWithoutHash();
  return {
    ...withoutHash,
    contract_hash: domainSeparatedSha256(
      G38A_REPAIR_DOMAIN,
      withoutHash as unknown as JsonValue,
    ),
  } as G38ARepairPayload;
}

function eventsForTerminalReplay(
  invocationKind: 'submit' | 'recovery',
): string[] {
  if (invocationKind === 'recovery') {
    return [
      'authenticate:attempt_started',
      'recovery:recovery_started',
      'recovery:recovery_succeeded',
      'finalize:terminal_replayed',
    ];
  }
  return [
    'authenticate:attempt_started',
    'authenticate:phase_succeeded',
    'validate:phase_succeeded',
    'finalize:terminal_replayed',
  ];
}

function terminalFromCommand(
  commandState: G38AActivationScenario['existing_command_state'],
): G38ATerminalDisposition | null {
  switch (commandState) {
    case 'terminal_applied':
      return 'applied';
    case 'terminal_failed':
      return 'failed';
    case 'terminal_pointer_conflict':
      return 'conflict';
    case 'absent':
    case 'pending_clean':
      return null;
  }
}

function terminalState(
  disposition: G38ATerminalDisposition,
): G38AActivationScenario['existing_command_state'] {
  switch (disposition) {
    case 'applied':
      return 'terminal_applied';
    case 'failed':
      return 'terminal_failed';
    case 'conflict':
      return 'terminal_pointer_conflict';
  }
}

function result(
  values: Omit<G38AScenarioResult, 'format'>,
): G38AScenarioResult {
  return {
    format: G38A_FORMATS.scenarioResult,
    ...values,
  } as G38AScenarioResult;
}

function assertScenarioShape(scenario: G38AActivationScenario): void {
  if (
    scenario.existing_command_state === 'absent' &&
    scenario.submitted_domain_request === 'drift'
  ) {
    throw new G38AContractError(
      'scenario_schema_invalid',
      'An absent caller key cannot have a drifting domain request',
    );
  }
  const terminal = terminalFromCommand(scenario.existing_command_state);
  if (
    terminal !== null &&
    (scenario.preflight_outcome !== 'not_run' ||
      scenario.pointer_cas_outcome !== 'not_run')
  ) {
    throw new G38AContractError(
      'scenario_schema_invalid',
      'Terminal replay cannot rerun domain preflight or pointer CAS',
    );
  }
  if (
    scenario.submitted_domain_request === 'drift' &&
    (scenario.preflight_outcome !== 'not_run' ||
      scenario.pointer_cas_outcome !== 'not_run')
  ) {
    throw new G38AContractError(
      'scenario_schema_invalid',
      'Domain drift is decided before domain preflight and pointer CAS',
    );
  }
  if (
    terminal === null &&
    scenario.submitted_domain_request === 'exact' &&
    scenario.integrity_state === 'trusted' &&
    scenario.preflight_outcome === 'not_run'
  ) {
    throw new G38AContractError(
      'scenario_schema_invalid',
      'A first or clean-pending exact request must run preflight',
    );
  }
  if (
    scenario.preflight_outcome === 'failed' &&
    scenario.pointer_cas_outcome !== 'not_run'
  ) {
    throw new G38AContractError(
      'scenario_schema_invalid',
      'Pointer CAS is not evaluated after an earlier failed preflight',
    );
  }
}

export function evaluateG38AActivationScenario(
  scenario: G38AActivationScenario,
): G38AScenarioResult {
  const validation = ajv.compile(scenarioCoreSchema as AnySchema);
  if (!validation(scenario)) {
    throw new G38AContractError(
      'scenario_schema_invalid',
      ajv.errorsText(validation.errors),
    );
  }
  assertScenarioShape(scenario);

  if (scenario.integrity_state !== 'trusted') {
    return result({
      outcome: 'fail_closed',
      code: 'terminal_integrity_mismatch',
      invocation_disposition: null,
      canonical_terminal_disposition: terminalFromCommand(
        scenario.existing_command_state,
      ),
      canonical_result_action: 'none',
      receipt: null,
      command_state_after: scenario.existing_command_state,
      pointer_transition_count: 0,
      invocation_append_count: 0,
      events: [],
      preflight_reexecuted: false,
      terminal_fact_trusted: false,
    });
  }

  const boundTerminal = terminalFromCommand(scenario.existing_command_state);
  if (scenario.submitted_domain_request === 'drift') {
    return result({
      outcome: 'committed',
      code: 'idempotency_conflict',
      invocation_disposition: 'conflict',
      canonical_terminal_disposition: boundTerminal,
      canonical_result_action: boundTerminal === null ? 'none' : 'referenced',
      receipt: null,
      command_state_after: scenario.existing_command_state,
      pointer_transition_count: 0,
      invocation_append_count: 1,
      events: [
        'authenticate:attempt_started',
        'authenticate:phase_succeeded',
        'validate:domain_request_conflicted',
      ],
      preflight_reexecuted: false,
      terminal_fact_trusted: boundTerminal !== null,
    });
  }

  if (boundTerminal !== null) {
    return result({
      outcome: 'committed',
      code: 'activation_duplicate',
      invocation_disposition: 'duplicate',
      canonical_terminal_disposition: boundTerminal,
      canonical_result_action: 'referenced',
      receipt:
        boundTerminal === 'applied' ? 'original_transition_receipt' : null,
      command_state_after: scenario.existing_command_state,
      pointer_transition_count: 0,
      invocation_append_count: 1,
      events: eventsForTerminalReplay(scenario.invocation_kind),
      preflight_reexecuted: false,
      terminal_fact_trusted: true,
    });
  }

  const terminalDisposition: G38ATerminalDisposition =
    scenario.preflight_outcome === 'failed'
      ? 'failed'
      : scenario.pointer_cas_outcome === 'conflict'
        ? 'conflict'
        : 'applied';
  const normalEvents =
    terminalDisposition === 'failed'
      ? [
          'authenticate:attempt_started',
          'authenticate:phase_succeeded',
          'validate:phase_succeeded',
          'preflight:pre_transaction_failed',
          'finalize:terminal_result_committed',
        ]
      : terminalDisposition === 'conflict'
        ? [
            'authenticate:attempt_started',
            'authenticate:phase_succeeded',
            'validate:phase_succeeded',
            'preflight:phase_succeeded',
            'activation_transaction:activation_transaction_started',
            'activation_transaction:pointer_cas_conflicted',
            'finalize:terminal_result_committed',
          ]
        : [
            'authenticate:attempt_started',
            'authenticate:phase_succeeded',
            'validate:phase_succeeded',
            'preflight:phase_succeeded',
            'activation_transaction:activation_transaction_started',
            'activation_transaction:activation_committed',
            'finalize:terminal_result_committed',
          ];
  const events =
    scenario.invocation_kind === 'recovery'
      ? [
          'authenticate:attempt_started',
          'recovery:recovery_started',
          ...normalEvents.slice(1),
          'recovery:recovery_succeeded',
        ]
      : normalEvents;

  if (scenario.fault_point === 'before_commit') {
    return result({
      outcome: 'rolled_back',
      code: 'activation_transaction_rolled_back',
      invocation_disposition: null,
      canonical_terminal_disposition: null,
      canonical_result_action: 'none',
      receipt: null,
      command_state_after: scenario.existing_command_state,
      pointer_transition_count: 0,
      invocation_append_count: 0,
      events: [],
      preflight_reexecuted: true,
      terminal_fact_trusted: false,
    });
  }

  return result({
    outcome: 'committed',
    code:
      scenario.fault_point === 'after_commit_before_response'
        ? 'response_lost_after_commit'
        : terminalDisposition === 'applied'
          ? 'activation_applied'
          : terminalDisposition === 'failed'
            ? 'activation_failed'
            : 'pointer_cas_conflict',
    invocation_disposition: terminalDisposition,
    canonical_terminal_disposition: terminalDisposition,
    canonical_result_action: 'written',
    receipt:
      terminalDisposition === 'applied' ? 'original_transition_receipt' : null,
    command_state_after: terminalState(terminalDisposition),
    pointer_transition_count: terminalDisposition === 'applied' ? 1 : 0,
    invocation_append_count: 1,
    events,
    preflight_reexecuted: true,
    terminal_fact_trusted: true,
  });
}

function scenario(
  caseId: string,
  overrides: Partial<G38AActivationScenario> = {},
): G38AActivationScenario {
  return {
    format: G38A_FORMATS.scenario,
    case_id: caseId,
    invocation_kind: 'submit',
    existing_command_state: 'absent',
    submitted_domain_request: 'exact',
    requested_pointer_state: 'absent',
    preflight_outcome: 'accepted',
    pointer_cas_outcome: 'matched',
    integrity_state: 'trusted',
    fault_point: 'none',
    ...overrides,
  };
}

function fixture(input: G38AActivationScenario): G38AScenarioFixture {
  return {
    case_id: input.case_id,
    scenario: input,
    expected: evaluateG38AActivationScenario(input),
  };
}

function buildPositiveFixtures(): G38AScenarioFixture[] {
  return [
    fixture(scenario('first-applied-absent-pointer')),
    fixture(
      scenario('first-applied-present-pointer', {
        requested_pointer_state: 'present',
      }),
    ),
    fixture(
      scenario('exact-replay-applied', {
        existing_command_state: 'terminal_applied',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
      }),
    ),
    fixture(
      scenario('first-failed', {
        preflight_outcome: 'failed',
        pointer_cas_outcome: 'not_run',
      }),
    ),
    fixture(
      scenario('exact-replay-failed', {
        existing_command_state: 'terminal_failed',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
      }),
    ),
    fixture(
      scenario('same-key-domain-drift-conflict', {
        existing_command_state: 'pending_clean',
        submitted_domain_request: 'drift',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
      }),
    ),
    fixture(
      scenario('repeated-same-key-domain-drift-conflict', {
        existing_command_state: 'terminal_applied',
        submitted_domain_request: 'drift',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
      }),
    ),
    fixture(
      scenario('pointer-cas-conflict', {
        pointer_cas_outcome: 'conflict',
      }),
    ),
    fixture(
      scenario('exact-replay-pointer-cas-conflict', {
        existing_command_state: 'terminal_pointer_conflict',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
      }),
    ),
  ];
}

function buildFaultFixtures(): G38AScenarioFixture[] {
  const rollbackCases = FAULT_CASE_IDS.slice(0, 9).map((caseId) =>
    fixture(
      scenario(caseId, {
        fault_point: 'before_commit',
      }),
    ),
  );
  return [
    ...rollbackCases,
    fixture(
      scenario('post-commit-applied-response-lost', {
        fault_point: 'after_commit_before_response',
      }),
    ),
    fixture(
      scenario('reopen-after-applied-response-lost', {
        invocation_kind: 'recovery',
        existing_command_state: 'terminal_applied',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
      }),
    ),
    fixture(
      scenario('reopen-after-failed-response-lost', {
        invocation_kind: 'recovery',
        existing_command_state: 'terminal_failed',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
      }),
    ),
    fixture(
      scenario('tampered-command-result-binding', {
        invocation_kind: 'recovery',
        existing_command_state: 'terminal_applied',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
        integrity_state: 'tampered_command_result_binding',
      }),
    ),
    fixture(
      scenario('tampered-receipt', {
        invocation_kind: 'recovery',
        existing_command_state: 'terminal_applied',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
        integrity_state: 'tampered_receipt',
      }),
    ),
    fixture(
      scenario('tampered-invocation-chain', {
        invocation_kind: 'recovery',
        existing_command_state: 'terminal_failed',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
        integrity_state: 'tampered_invocation_chain',
      }),
    ),
    fixture(
      scenario('tampered-event-chain', {
        invocation_kind: 'recovery',
        existing_command_state: 'terminal_pointer_conflict',
        preflight_outcome: 'not_run',
        pointer_cas_outcome: 'not_run',
        integrity_state: 'tampered_event_chain',
      }),
    ),
    fixture(
      scenario('pending-with-transition-evidence', {
        invocation_kind: 'recovery',
        existing_command_state: 'pending_clean',
        integrity_state: 'pending_with_transition_evidence',
      }),
    ),
  ];
}

function buildNegativeFixtures(): G38ANegativeMutation[] {
  return [
    {
      case_id: 'removed-field-receipt-required-for-all-duplicates',
      target: 'repair',
      operation: 'add',
      pointer: '/receipt_required_for_all_duplicates',
      value: true,
      expected_code: 'repair_removed_field',
    },
    {
      case_id: 'unknown-top-level-field',
      target: 'repair',
      operation: 'add',
      pointer: '/unexpected',
      value: true,
      expected_code: 'repair_unknown_field',
    },
    {
      case_id: 'extra-nested-receipt-field',
      target: 'repair',
      operation: 'add',
      pointer: '/receipt_policy/extra',
      value: 'forbidden',
      expected_code: 'repair_unknown_field',
    },
    {
      case_id: 'missing-status',
      target: 'repair',
      operation: 'remove',
      pointer: '/status',
      value: null,
      expected_code: 'repair_schema_invalid',
    },
    {
      case_id: 'production-reachable-forbidden',
      target: 'repair',
      operation: 'replace',
      pointer: '/production_reachable',
      value: true,
      expected_code: 'repair_schema_invalid',
    },
    {
      case_id: 'current-schema-version-drift',
      target: 'repair',
      operation: 'replace',
      pointer: '/current_database_schema_version',
      value: 4,
      expected_code: 'repair_schema_invalid',
    },
    {
      case_id: 'contract-hash-drift',
      target: 'repair',
      operation: 'replace',
      pointer: '/contract_hash',
      value:
        'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      expected_code: 'repair_hash_mismatch',
    },
    {
      case_id: 'rehash-failed-receipt-semantic-drift',
      target: 'repair',
      operation: 'rehash_replace',
      pointer: '/receipt_policy/first_failed',
      value: 'required',
      expected_code: 'repair_schema_invalid',
    },
    {
      case_id: 'rehash-terminal-rule-order-drift',
      target: 'repair',
      operation: 'rehash_replace',
      pointer: '/terminal_semantics/0/case_kind',
      value: 'first_applied_drifted',
      expected_code: 'repair_semantic_mismatch',
    },
    {
      case_id: 'scenario-unknown-field',
      target: 'scenario',
      operation: 'add',
      pointer: '/unexpected',
      value: true,
      expected_code: 'scenario_schema_invalid',
    },
    {
      case_id: 'scenario-removed-field',
      target: 'scenario',
      operation: 'add',
      pointer: '/free_json_detail',
      value: {},
      expected_code: 'scenario_schema_invalid',
    },
    {
      case_id: 'scenario-invalid-command-state',
      target: 'scenario',
      operation: 'replace',
      pointer: '/existing_command_state',
      value: 'failed',
      expected_code: 'scenario_schema_invalid',
    },
  ];
}

function verifiedPrefixFor(code: string): string[] {
  const target = ['verified_target_release_identity'];
  const resources = [...target, 'verified_target_release_resource_set'];
  const compatibility = [
    ...resources,
    'verified_g3_6_compatibility_input',
    'verified_g3_6_compatibility_result',
  ];
  const targetLifecycle = [
    ...compatibility,
    'verified_target_staged_lifecycle',
  ];
  const previous = [...targetLifecycle, 'verified_previous_release_identity'];
  const previousLifecycle = [...previous, 'verified_previous_active_lifecycle'];
  const targetRetention = [
    ...previousLifecycle,
    'verified_target_retention_identity',
  ];
  const targetRetentionHeld = [
    ...targetRetention,
    'verified_target_retention_held_observation',
  ];
  const previousRetention = [
    ...targetRetentionHeld,
    'verified_previous_retention_identity',
  ];
  const previousRetentionHeld = [
    ...previousRetention,
    'verified_previous_retention_held_observation',
  ];
  if (
    code.endsWith('_strict_parse_invalid') ||
    code.endsWith('_removed_field') ||
    code.endsWith('_unknown_field') ||
    code.endsWith('_schema_invalid') ||
    code.endsWith('_hash_mismatch') ||
    code === 'activation_authentication_mismatch' ||
    code === 'idempotency_conflict' ||
    code === 'terminal_integrity_mismatch' ||
    code === 'target_release_missing' ||
    code === 'target_release_identity_mismatch' ||
    code === 'target_release_owner_mismatch'
  ) {
    return [];
  }
  if (code === 'target_release_resource_set_mismatch') return target;
  if (code === 'g3_6_preflight_rejected') return compatibility;
  if (code === 'target_release_lifecycle_invalid') return compatibility;
  if (
    code === 'previous_release_missing' ||
    code === 'previous_release_identity_mismatch' ||
    code === 'previous_release_owner_mismatch'
  ) {
    return targetLifecycle;
  }
  if (code === 'previous_release_lifecycle_invalid') return previous;
  if (
    code === 'target_retention_missing' ||
    code === 'target_retention_identity_mismatch'
  ) {
    return previousLifecycle;
  }
  if (
    code === 'target_retention_status_mismatch' ||
    code === 'target_retention_row_version_mismatch'
  ) {
    return targetRetention;
  }
  if (
    code === 'previous_retention_missing' ||
    code === 'previous_retention_identity_mismatch'
  ) {
    return targetRetentionHeld;
  }
  if (
    code === 'previous_retention_status_mismatch' ||
    code === 'previous_retention_row_version_mismatch'
  ) {
    return previousRetention;
  }
  if (
    code === 'pointer_cas_conflict' ||
    code === 'activation_persistence_identity_collision'
  ) {
    return previousRetentionHeld;
  }
  return [];
}

function rejectionFixture(
  code: (typeof G38A_ERROR_PRECEDENCE)[number],
  nestedG36Code: string | null = null,
): G38ARejectionFixture {
  const precedenceRank = G38A_ERROR_PRECEDENCE.indexOf(code) + 1;
  const preAdmission = precedenceRank <= 6;
  const idempotencyConflict = code === 'idempotency_conflict';
  const integrityFailure = code === 'terminal_integrity_mismatch';
  const pointerConflict = code === 'pointer_cas_conflict';
  const persistenceFailure =
    code === 'activation_persistence_identity_collision';
  const classification = preAdmission
    ? 'pre_admission'
    : idempotencyConflict || pointerConflict
      ? 'conflict'
      : integrityFailure || persistenceFailure
        ? 'fail_closed'
        : 'failed';
  const phase = preAdmission
    ? 'admission'
    : idempotencyConflict
      ? 'idempotency'
      : integrityFailure
        ? 'integrity'
        : pointerConflict
          ? 'activation_transaction'
          : persistenceFailure
            ? 'persistence'
            : 'preflight';
  const commandEffect = preAdmission
    ? 'absent'
    : idempotencyConflict || integrityFailure
      ? 'header_unchanged'
      : pointerConflict
        ? 'terminal_conflict'
        : persistenceFailure
          ? 'transaction_rolled_back'
          : 'terminal_failed';
  return {
    case_id:
      nestedG36Code === null
        ? `negative.${code}`
        : `negative.g3_6.${nestedG36Code}`,
    precedence_rank: precedenceRank,
    outer_code: code,
    nested_g3_6_code: nestedG36Code,
    phase,
    classification,
    command_effect: commandEffect,
    receipt: null,
    pointer_transition_count: 0,
    invocation_append_count:
      preAdmission || integrityFailure || persistenceFailure ? 0 : 1,
    verified_fact_prefix: verifiedPrefixFor(code),
  } as G38ARejectionFixture;
}

function buildRejectionFixtures(): G38ARejectionFixture[] {
  return G38A_ERROR_PRECEDENCE.flatMap((code) =>
    code === 'g3_6_preflight_rejected'
      ? G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE.map((nestedCode) =>
          rejectionFixture(code, nestedCode),
        )
      : [rejectionFixture(code)],
  );
}

function allNegativeCaseIds(): string[] {
  return [
    ...NEGATIVE_CASE_IDS,
    ...buildRejectionFixtures().map((entry) => entry.case_id),
  ];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function decodePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function applyMutation<T extends JsonValue>(
  candidate: T,
  mutation: G38ANegativeMutation,
): T {
  const resultValue = cloneJson(candidate);
  const segments = mutation.pointer.split('/').slice(1).map(decodePointerToken);
  if (segments.length === 0) {
    throw new G38AContractError(
      'repair_schema_invalid',
      'Negative mutation cannot replace the document root',
    );
  }
  let owner: unknown = resultValue;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(owner)) owner = owner[Number(segment)];
    else if (owner && typeof owner === 'object')
      owner = (owner as Record<string, unknown>)[segment];
    else
      throw new G38AContractError(
        'repair_schema_invalid',
        `Mutation pointer is absent: ${mutation.pointer}`,
      );
  }
  const key = segments.at(-1)!;
  if (!owner || typeof owner !== 'object') {
    throw new G38AContractError(
      'repair_schema_invalid',
      `Mutation owner is absent: ${mutation.pointer}`,
    );
  }
  if (mutation.operation === 'remove') {
    if (Array.isArray(owner)) owner.splice(Number(key), 1);
    else delete (owner as Record<string, unknown>)[key];
  } else if (Array.isArray(owner)) {
    owner[Number(key)] = cloneJson(mutation.value);
  } else {
    (owner as Record<string, unknown>)[key] = cloneJson(mutation.value);
  }
  if (mutation.target === 'repair' && mutation.operation === 'rehash_replace') {
    const repair = resultValue as unknown as G38ARepairPayload;
    const { contract_hash: ignored, ...withoutHash } = repair;
    void ignored;
    repair.contract_hash = domainSeparatedSha256(
      G38A_REPAIR_DOMAIN,
      withoutHash as unknown as JsonValue,
    );
  }
  return resultValue;
}

function findRemovedField(value: unknown, pointer = ''): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findRemovedField(value[index], `${pointer}/${index}`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (REMOVED_FIELDS.has(key)) return `${pointer}/${key}`;
    const found = findRemovedField(child, `${pointer}/${key}`);
    if (found) return found;
  }
  return null;
}

export function validateG38ARepairCandidate(candidate: unknown): void {
  const removed = findRemovedField(candidate);
  if (removed) {
    throw new G38AContractError(
      'repair_removed_field',
      `Removed repair field is forbidden at ${removed}`,
    );
  }
  if (!validateRepairSchema(candidate)) {
    const unknown = validateRepairSchema.errors?.some(
      (error) => error.keyword === 'additionalProperties',
    );
    throw new G38AContractError(
      unknown ? 'repair_unknown_field' : 'repair_schema_invalid',
      ajv.errorsText(validateRepairSchema.errors),
    );
  }
  const repair = candidate as G38ARepairPayload;
  const { contract_hash: ignored, ...withoutHash } = repair;
  void ignored;
  if (
    domainSeparatedSha256(
      G38A_REPAIR_DOMAIN,
      withoutHash as unknown as JsonValue,
    ) !== repair.contract_hash
  ) {
    throw new G38AContractError(
      'repair_hash_mismatch',
      'G3.8A repair contract hash mismatch',
    );
  }
  if (canonicalJson(repair) !== canonicalJson(buildG38ARepairPayload())) {
    throw new G38AContractError(
      'repair_semantic_mismatch',
      'G3.8A repair candidate differs from the frozen canonical contract',
    );
  }
}

function evaluateNegativeFixture(fixtureValue: G38ANegativeMutation): string {
  if (fixtureValue.target === 'repair') {
    const candidate = applyMutation(
      buildG38ARepairPayload() as unknown as JsonValue,
      fixtureValue,
    );
    try {
      validateG38ARepairCandidate(candidate);
      return 'accepted_unexpectedly';
    } catch (error) {
      return error instanceof G38AContractError
        ? error.code
        : 'unexpected_error';
    }
  }
  const candidate = applyMutation(
    scenario('negative-scenario-base') as unknown as JsonValue,
    fixtureValue,
  );
  const validation = ajv.compile(scenarioCoreSchema as AnySchema);
  return validation(candidate)
    ? 'accepted_unexpectedly'
    : 'scenario_schema_invalid';
}

function artifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const resultArtifact: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}` as Sha256Hash,
    payload,
  };
  resultArtifact.hash = calculateArtifactHash(resultArtifact);
  return resultArtifact;
}

function domainCatalog(): JsonObject {
  return {
    format:
      'icarus.workflow-feature-release-activation-contract-repair-domain-separators/1',
    domains: [
      { object: 'repair_contract', domain_separator: G38A_REPAIR_DOMAIN },
      { object: 'repair_schema', domain_separator: G38A_REPAIR_SCHEMA_DOMAIN },
      {
        object: 'scenario_schema',
        domain_separator: G38A_SCENARIO_SCHEMA_DOMAIN,
      },
      {
        object: 'negative_cases_schema',
        domain_separator: G38A_NEGATIVE_CASES_SCHEMA_DOMAIN,
      },
      {
        object: 'scenario_result',
        domain_separator: G38A_SCENARIO_RESULT_DOMAIN,
      },
      { object: 'positive_cases', domain_separator: G38A_POSITIVE_DOMAIN },
      { object: 'negative_cases', domain_separator: G38A_NEGATIVE_DOMAIN },
      { object: 'fault_cases', domain_separator: G38A_FAULT_DOMAIN },
      { object: 'contract_pack', domain_separator: G38A_PACK_DOMAIN },
    ],
  };
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const positive = buildPositiveFixtures();
  const negative = buildNegativeFixtures();
  const rejections = buildRejectionFixtures();
  const fault = buildFaultFixtures();
  const artifacts: Array<[string, ContractArtifactEnvelope]> = [
    [
      G38A_REPAIR_SCHEMA_PATH,
      artifact(
        'icarus.workflow-feature-release-activation-contract-repair-schema/1',
        'icarus.workflow-feature-release-activation-contract-repair-schema',
        G38A_REPAIR_SCHEMA_DOMAIN,
        G38A_REPAIR_SCHEMA,
      ),
    ],
    [
      G38A_SCENARIO_SCHEMA_PATH,
      artifact(
        'icarus.workflow-feature-release-activation-repair-scenario-schema/1',
        'icarus.workflow-feature-release-activation-repair-scenario-schema',
        G38A_SCENARIO_SCHEMA_DOMAIN,
        G38A_SCENARIO_SCHEMA,
      ),
    ],
    [
      G38A_NEGATIVE_CASES_SCHEMA_PATH,
      artifact(
        'icarus.workflow-feature-release-activation-repair-negative-cases-schema/1',
        'icarus.workflow-feature-release-activation-repair-negative-cases-schema',
        G38A_NEGATIVE_CASES_SCHEMA_DOMAIN,
        G38A_NEGATIVE_CASES_SCHEMA,
      ),
    ],
    [
      G38A_REPAIR_PATH,
      artifact(
        G38A_FORMATS.repair,
        'icarus.workflow-feature-release-activation-contract-repair',
        G38A_REPAIR_DOMAIN,
        buildG38ARepairPayload(),
      ),
    ],
    [
      G38A_POSITIVE_CASES_PATH,
      artifact(
        'icarus.workflow-g3-8a-activation-contract-repair-positive-cases/1',
        'icarus.workflow-g3-8a-activation-contract-repair-positive-cases',
        G38A_POSITIVE_DOMAIN,
        {
          format:
            'icarus.workflow-g3-8a-activation-contract-repair-positive-cases/1',
          case_count: positive.length,
          cases: positive,
        },
      ),
    ],
    [
      G38A_NEGATIVE_CASES_PATH,
      artifact(
        'icarus.workflow-g3-8a-activation-contract-repair-negative-cases/1',
        'icarus.workflow-g3-8a-activation-contract-repair-negative-cases',
        G38A_NEGATIVE_DOMAIN,
        {
          format:
            'icarus.workflow-g3-8a-activation-contract-repair-negative-cases/1',
          mutation_case_count: negative.length,
          rejection_case_count: rejections.length,
          case_count: negative.length + rejections.length,
          mutation_cases: negative,
          rejection_cases: rejections,
        },
      ),
    ],
    [
      G38A_FAULT_CASES_PATH,
      artifact(
        'icarus.workflow-g3-8a-activation-contract-repair-fault-cases/1',
        'icarus.workflow-g3-8a-activation-contract-repair-fault-cases',
        G38A_FAULT_DOMAIN,
        {
          format:
            'icarus.workflow-g3-8a-activation-contract-repair-fault-cases/1',
          case_count: fault.length,
          cases: fault,
        },
      ),
    ],
    [
      G38A_DOMAIN_CATALOG_PATH,
      artifact(
        'icarus.workflow-feature-release-activation-contract-repair-domain-separators/1',
        'icarus.workflow-feature-release-activation-contract-repair-domain-separators',
        G38A_DOMAIN_CATALOG_DOMAIN,
        domainCatalog(),
      ),
    ],
  ];
  return artifacts;
}

function buildPack(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  return artifact(
    'icarus.workflow-contract-pack-g3-8a-activation-contract-repair/1',
    'icarus.workflow-contract-pack-g3-8a-activation-contract-repair',
    G38A_PACK_DOMAIN,
    {
      format:
        'icarus.workflow-contract-pack-g3-8a-activation-contract-repair/1',
      g3_8a_status: G38A_STATUS,
      production_reachable: false,
      current_database_schema_version: 3,
      required_database_schema_version: 4,
      g3_9_status: 'BLOCKED_BY_G1_6',
      positive_case_count: POSITIVE_CASE_IDS.length,
      negative_case_count: allNegativeCaseIds().length,
      fault_case_count: FAULT_CASE_IDS.length,
      current_schema_identity: { ...CURRENT_SCHEMA_IDENTITY },
      members: artifacts.map(([artifactPath, member]) => ({
        path: artifactPath,
        ref: member.ref,
        hash: member.hash,
      })),
      forbidden_outputs: [
        'executable_ddl',
        'schema_manifest',
        'store_api',
        'activation_service',
        'active_pointer_dml',
        'g3_9_contract_pack',
        'production_loader',
        'g4_through_g9_runtime',
      ],
    },
  );
}

function absolute(relativePath: string): string {
  const resultPath = path.resolve(contractsRoot, relativePath);
  if (!resultPath.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new G38AContractError(
      'repair_schema_invalid',
      `Contract path escapes root: ${relativePath}`,
    );
  }
  return resultPath;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(relativePath: string, value: JsonValue): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, render(value), { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function validateArtifacts(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  pack: ContractArtifactEnvelope,
): void {
  const repair = artifacts.find(
    ([entryPath]) => entryPath === G38A_REPAIR_PATH,
  )?.[1].payload;
  if (!repair)
    throw new G38AContractError(
      'repair_schema_invalid',
      'Repair artifact missing',
    );
  validateG38ARepairCandidate(repair);
  const schema4 = (repair as G38ARepairPayload).schema4_prerequisite as {
    column_requirements: Array<{ relation: string; name: string }>;
    foreign_key_requirements: Array<{
      relation_id: string;
      source_columns: string[];
      target_columns: string[];
    }>;
    unique_key_requirements: Array<{ key_id: string }>;
  };
  const columnKeys = schema4.column_requirements.map(
    (entry) => `${entry.relation}.${entry.name}`,
  );
  if (new Set(columnKeys).size !== columnKeys.length) {
    throw new G38AContractError(
      'repair_semantic_mismatch',
      'Schema 4 column requirements contain a duplicate relation/name',
    );
  }
  if (
    schema4.foreign_key_requirements.some(
      (entry) => entry.source_columns.length !== entry.target_columns.length,
    )
  ) {
    throw new G38AContractError(
      'repair_semantic_mismatch',
      'Schema 4 composite FK arity mismatch',
    );
  }
  const relationIds = schema4.foreign_key_requirements.map(
    (entry) => entry.relation_id,
  );
  const keyIds = schema4.unique_key_requirements.map((entry) => entry.key_id);
  if (
    new Set(relationIds).size !== relationIds.length ||
    new Set(keyIds).size !== keyIds.length
  ) {
    throw new G38AContractError(
      'repair_semantic_mismatch',
      'Schema 4 FK/UK requirements contain duplicate ids',
    );
  }

  const positive = buildPositiveFixtures();
  const fault = buildFaultFixtures();
  for (const caseFixture of [...positive, ...fault]) {
    if (!validateScenarioFixtureSchema(caseFixture)) {
      throw new G38AContractError(
        'scenario_schema_invalid',
        `${caseFixture.case_id}: ${ajv.errorsText(validateScenarioFixtureSchema.errors)}`,
      );
    }
    if (
      canonicalJson(evaluateG38AActivationScenario(caseFixture.scenario)) !==
      canonicalJson(caseFixture.expected)
    ) {
      throw new G38AContractError(
        'repair_semantic_mismatch',
        `${caseFixture.case_id}: deterministic replay differs`,
      );
    }
  }
  for (const negative of buildNegativeFixtures()) {
    const actual = evaluateNegativeFixture(negative);
    if (actual !== negative.expected_code) {
      throw new G38AContractError(
        'repair_semantic_mismatch',
        `${negative.case_id}: expected ${negative.expected_code}, received ${actual}`,
      );
    }
  }
  const negativePayload = artifacts.find(
    ([entryPath]) => entryPath === G38A_NEGATIVE_CASES_PATH,
  )?.[1].payload;
  if (!negativePayload || !validateNegativeCasesSchema(negativePayload)) {
    throw new G38AContractError(
      'repair_schema_invalid',
      `Negative cases artifact is not closed: ${ajv.errorsText(validateNegativeCasesSchema.errors)}`,
    );
  }
  const rejectionFixtures = buildRejectionFixtures();
  for (const rejection of rejectionFixtures) {
    if (
      rejection.precedence_rank !==
        G38A_ERROR_PRECEDENCE.indexOf(rejection.outer_code) + 1 ||
      rejection.receipt !== null ||
      rejection.pointer_transition_count !== 0
    ) {
      throw new G38AContractError(
        'repair_semantic_mismatch',
        `${rejection.case_id}: rejection classification drifted`,
      );
    }
  }
  const nestedCodes = rejectionFixtures
    .filter((entry) => entry.outer_code === 'g3_6_preflight_rejected')
    .map((entry) => entry.nested_g3_6_code);
  if (
    canonicalJson(nestedCodes) !==
    canonicalJson([...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE])
  ) {
    throw new G38AContractError(
      'repair_semantic_mismatch',
      'G3.6 nested rejection precedence drifted',
    );
  }
  for (const [, member] of artifacts) {
    if (calculateArtifactHash(member) !== member.hash) {
      throw new G38AContractError(
        'repair_hash_mismatch',
        `${member.ref.id} artifact hash mismatch`,
      );
    }
  }
  if (calculateArtifactHash(pack) !== pack.hash) {
    throw new G38AContractError('repair_hash_mismatch', 'Pack hash mismatch');
  }
}

function expectedBuild(): {
  artifacts: Array<[string, ContractArtifactEnvelope]>;
  pack: ContractArtifactEnvelope;
} {
  const artifacts = buildArtifacts();
  const pack = buildPack(artifacts);
  validateArtifacts(artifacts, pack);
  return { artifacts, pack };
}

export function generateG38AActivationContractRepair(): ContractArtifactEnvelope {
  const built = expectedBuild();
  for (const [artifactPath, member] of built.artifacts) {
    writeAtomic(artifactPath, member);
  }
  writeAtomic(G38A_PACK_PATH, built.pack);
  return built.pack;
}

export function checkG38AActivationContractRepair(): ContractArtifactEnvelope {
  const built = expectedBuild();
  for (const [artifactPath, expected] of built.artifacts) {
    const actual = readArtifact(artifactPath);
    if (render(actual) !== render(expected)) {
      throw new G38AContractError(
        'repair_hash_mismatch',
        `${artifactPath} drifted; run contracts:g3.8a:generate`,
      );
    }
  }
  const pack = readArtifact(G38A_PACK_PATH);
  if (render(pack) !== render(built.pack)) {
    throw new G38AContractError(
      'repair_hash_mismatch',
      `${G38A_PACK_PATH} drifted; run contracts:g3.8a:generate`,
    );
  }
  validateArtifacts(
    built.artifacts.map(([artifactPath]) => [
      artifactPath,
      readArtifact(artifactPath),
    ]),
    pack,
  );
  return pack;
}

export function g38aActivationContractRepairFixturesForTest(): {
  positive: G38AScenarioFixture[];
  negative: G38ANegativeMutation[];
  rejection: G38ARejectionFixture[];
  fault: G38AScenarioFixture[];
} {
  return {
    positive: buildPositiveFixtures(),
    negative: buildNegativeFixtures(),
    rejection: buildRejectionFixtures(),
    fault: buildFaultFixtures(),
  };
}

export function g38aEvaluateNegativeFixtureForTest(
  fixtureValue: G38ANegativeMutation,
): string {
  return evaluateNegativeFixture(fixtureValue);
}
