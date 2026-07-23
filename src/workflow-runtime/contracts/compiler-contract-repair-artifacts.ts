import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  COMPILER_DIAGNOSTIC_PHASES,
  WORKFLOW_COMPILER_ERROR_CODES,
} from './catalog-protocol-types.js';
import {
  COMPILED_CONDITION_OPERAND_TYPES,
  COMPILER_G2_EXACT_IDENTITY_FIELDS,
} from './compiler-contract-repair-types.js';
import { SHA256_HASH_PATTERN, calculateArtifactHash } from './hash.js';
import {
  assertJsonObject,
  strictParseJson,
  strictParseJsonBytes,
} from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';
import {
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const contractsRoot = import.meta.dirname;
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const STABLE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$';
const CLOSURE_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,510}$';
const POINTER_PATTERN = '^(?:/(?:[^~/]|~[01])*)*$';
const REPAIR_PATH_PATTERN =
  '^conformance/compiler-contract-repair/[A-Za-z0-9.@_/-]+$';
const HISTORICAL_DRAFT_PATH_PATTERN = '^conformance/draft/[A-Za-z0-9.@_/-]+$';

type Schema = JsonObject;

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

function string(options: JsonObject = {}): Schema {
  return { type: 'string', ...options };
}

function enumString(values: readonly string[]): Schema {
  return { type: 'string', enum: [...values] };
}

function integer(minimum = 0): Schema {
  return { type: 'integer', minimum, maximum: SAFE_INTEGER_MAX };
}

function array(items: Schema, options: JsonObject = {}): Schema {
  return { type: 'array', items, ...options };
}

function object(
  properties: Record<string, Schema>,
  optional: readonly string[] = [],
): Schema {
  const optionalKeys = new Set(optional);
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optionalKeys.has(key)),
    properties,
  };
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: 'null' }] };
}

const hashSchema = string({ pattern: SHA256_HASH_PATTERN });
const stableIdSchema = string({
  minLength: 1,
  maxLength: 255,
  pattern: STABLE_ID_PATTERN,
});
const versionedRefSchema = object({
  id: string({
    minLength: 1,
    maxLength: 255,
    pattern: VERSIONED_REF_ID_PATTERN,
  }),
  version: string({
    minLength: 1,
    maxLength: 64,
    pattern: VERSIONED_REF_VERSION_PATTERN,
  }),
});
const jsonValueSchema: Schema = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: ref('json_value') },
    { type: 'object', additionalProperties: ref('json_value') },
  ],
};

function readHistoricalCompiledPlanSchema(): Schema {
  const artifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(
        path.join(contractsRoot, 'schemas/compiled-scope-plan-schema.json'),
      ),
    ),
  );
  return strictParseJson(JSON.stringify(artifact.payload)) as Schema;
}

function staticClosureMemberSchema(): Schema {
  return object({
    closure_key: string({ pattern: CLOSURE_KEY_PATTERN }),
    parent_closure_key: nullable(string({ pattern: CLOSURE_KEY_PATTERN })),
    scope_key: stableIdSchema,
    owner_node_path: array(stableIdSchema, { minItems: 1 }),
    factory_kind: enumString(['inline', 'template']),
    source_ref: nullable(versionedRefSchema),
    source_hash: hashSchema,
    plan_ref: string({ minLength: 1 }),
    plan_hash: hashSchema,
    interface_snapshot_hash: hashSchema,
    member_hash: hashSchema,
  });
}

function outboxReconciliationSchema(): Schema {
  return {
    oneOf: [
      object({ type: { const: 'not_required' } }),
      object({
        type: { const: 'by_effect_key' },
        reconcile_action_ref: versionedRefSchema,
      }),
    ],
  };
}

function outboxEffectContractSchema(): Schema {
  return object({
    effect_type: { const: 'capability_dispatch' },
    adapter_ref: versionedRefSchema,
    delivery_policy_ref: versionedRefSchema,
    delivery_lane: { const: 'normal_execution' },
    reconciliation: ref('outbox_reconciliation'),
    idempotency: enumString(['provider_key', 'external_lookup']),
    delivery_requirement: { const: 'required' },
  });
}

function outboxDeliveryPolicySchema(): Schema {
  return object({
    format: { const: 'icarus.workflow-outbox-delivery-policy/1' },
    ref: versionedRefSchema,
    max_delivery_attempts: integer(1),
    max_reconcile_attempts: integer(0),
    delivery_duration_ms: integer(1),
    attempt_timeout_ms: integer(1),
    initial_backoff_ms: integer(0),
    max_backoff_ms: integer(0),
    backoff: enumString(['fixed', 'exponential']),
    deterministic_jitter_micros: {
      type: 'integer',
      minimum: 0,
      maximum: 1_000_000,
    },
    honor_retry_after: { type: 'boolean' },
    retryable_error_codes: array(stableIdSchema, { uniqueItems: true }),
    permanent_error_codes: array(stableIdSchema, { uniqueItems: true }),
    policy_hash: hashSchema,
  });
}

function effectiveOutboxDeliveryPolicySchema(): Schema {
  return object({
    max_delivery_attempts: integer(1),
    max_reconcile_attempts: integer(0),
    delivery_duration_ms: integer(1),
    attempt_timeout_ms: integer(1),
    initial_backoff_ms: integer(0),
    max_backoff_ms: integer(0),
    backoff: enumString(['fixed', 'exponential']),
    deterministic_jitter_micros: {
      type: 'integer',
      minimum: 0,
      maximum: 1_000_000,
    },
    honor_retry_after: { type: 'boolean' },
    retryable_error_codes: array(stableIdSchema, { uniqueItems: true }),
    permanent_error_codes: array(stableIdSchema, { uniqueItems: true }),
  });
}

function compiledOutboxExecutionBindingSchema(): Schema {
  return object({
    effect_contract: ref('outbox_effect_contract'),
    adapter_identity: object({
      resource_type: { const: 'outbox_adapter' },
      ref: versionedRefSchema,
      content_hash: hashSchema,
    }),
    delivery_policy_identity: object({
      resource_type: { const: 'outbox_policy' },
      ref: versionedRefSchema,
      content_hash: hashSchema,
    }),
    effective_policy_snapshot: object({
      format: { const: 'icarus.workflow-outbox-effective-policy-snapshot/1' },
      source_policy_ref: versionedRefSchema,
      source_policy_content_hash: hashSchema,
      source_policy_hash: hashSchema,
      effective_policy: ref('effective_outbox_delivery_policy'),
      runtime_safety_hash: hashSchema,
      snapshot_hash: hashSchema,
    }),
    binding_hash: hashSchema,
  });
}

export function buildCompiledScopePlanV2Schema(): Schema {
  const schema = readHistoricalCompiledPlanSchema();
  schema.$id = 'https://icarus.local/schemas/compiled-scope-plan-v2';
  schema.title = 'icarus.workflow-graph-scope-plan/2';
  assertJsonObject(schema.properties);
  assertJsonObject(schema.properties.format);
  schema.properties.format = {
    const: 'icarus.workflow-graph-scope-plan/2',
  };
  if (!Array.isArray(schema.required))
    throw new Error('Historical Compiled IR required list is missing');
  schema.required = schema.required.map((key) =>
    key === 'static_child_plan_closure_hash'
      ? 'static_child_plan_closure'
      : key,
  );
  delete schema.properties.static_child_plan_closure_hash;
  schema.properties.static_child_plan_closure = ref(
    'static_child_plan_closure',
  );

  assertJsonObject(schema.$defs);
  const definitions = schema.$defs;
  assertJsonObject(definitions.compiled_condition_program);
  const conditionProgram = definitions.compiled_condition_program;
  assertJsonObject(conditionProgram.properties);
  if (!Array.isArray(conditionProgram.required))
    throw new Error('Historical condition-program required list is missing');
  conditionProgram.required = [
    'normalized_ast',
    'operand_schema_hashes',
    'operand_types',
    'max_steps',
    'program_hash',
  ];
  conditionProgram.properties.operand_types = array(
    enumString(COMPILED_CONDITION_OPERAND_TYPES),
    { minItems: 1 },
  );

  assertJsonObject(definitions.compiled_node);
  const compiledNode = definitions.compiled_node;
  if (!Array.isArray(compiledNode.oneOf))
    throw new Error('Historical compiled-node union is missing');
  const mapBranch = compiledNode.oneOf.find((candidate) => {
    assertJsonObject(candidate);
    assertJsonObject(candidate.properties);
    assertJsonObject(candidate.properties.type);
    return candidate.properties.type.const === 'map';
  });
  if (!mapBranch) throw new Error('Historical CompiledMapNode is missing');
  assertJsonObject(mapBranch);
  assertJsonObject(mapBranch.properties);
  if (!Array.isArray(mapBranch.required))
    throw new Error('Historical CompiledMapNode required list is missing');
  mapBranch.required = [...mapBranch.required, 'result_order'];
  mapBranch.properties.result_order = { const: 'item_index' };

  definitions.static_child_plan_closure_member = staticClosureMemberSchema();
  definitions.static_child_plan_closure = object({
    members: array(ref('static_child_plan_closure_member'), {
      uniqueItems: true,
    }),
    member_count: integer(),
    closure_hash: hashSchema,
  });
  return schema;
}

export function buildCompiledScopePlanV2ExecutionBindingSchema(): Schema {
  const schema = buildCompiledScopePlanV2Schema();
  schema.$id =
    'https://icarus.local/schemas/compiled-scope-plan-v2-execution-binding';
  schema.title = 'icarus.workflow-graph-scope-plan/2 execution binding';
  assertJsonObject(schema.$defs);
  const definitions = schema.$defs;
  definitions.outbox_reconciliation = outboxReconciliationSchema();
  definitions.outbox_effect_contract = outboxEffectContractSchema();
  definitions.outbox_delivery_policy = outboxDeliveryPolicySchema();
  definitions.effective_outbox_delivery_policy =
    effectiveOutboxDeliveryPolicySchema();
  definitions.compiled_outbox_execution_binding =
    compiledOutboxExecutionBindingSchema();

  assertJsonObject(definitions.workflow_capability);
  const capability = definitions.workflow_capability;
  assertJsonObject(capability.properties);
  if (!Array.isArray(capability.required)) {
    throw new Error('WorkflowGraphCapability required list is missing');
  }
  capability.required = [...capability.required, 'outbox_effect'];
  capability.properties.outbox_effect = ref('outbox_effect_contract');

  assertJsonObject(definitions.compiled_node);
  if (!Array.isArray(definitions.compiled_node.oneOf)) {
    throw new Error('Compiled node union is missing');
  }
  for (const candidate of definitions.compiled_node.oneOf) {
    assertJsonObject(candidate);
    assertJsonObject(candidate.properties);
    assertJsonObject(candidate.properties.type);
    if (
      candidate.properties.type.const !== 'delegation' &&
      candidate.properties.type.const !== 'system'
    ) {
      continue;
    }
    if (!Array.isArray(candidate.required)) {
      throw new Error('CompiledCapabilityNode required list is missing');
    }
    candidate.required = [...candidate.required, 'outbox_execution_binding'];
    candidate.properties.outbox_execution_binding = ref(
      'compiled_outbox_execution_binding',
    );
  }
  return schema;
}

const diagnosticSchema = object({
  code: enumString(WORKFLOW_COMPILER_ERROR_CODES),
  phase: enumString(COMPILER_DIAGNOSTIC_PHASES),
  instance_pointer: string({ pattern: POINTER_PATTERN }),
  schema_pointer: nullable(string({ pattern: '^#(?:/(?:[^~/]|~[01])*)*$' })),
  stable_object_id: nullable(string({ minLength: 1, maxLength: 255 })),
  detail_ref: nullable(string({ minLength: 1 })),
});

function buildCompilerConformanceCaseResultSchemaForPlan(
  planSchema: Schema,
  schemaId: string,
): Schema {
  assertJsonObject(planSchema.$defs);
  const {
    $schema: _planDialect,
    $id: _planId,
    title: _planTitle,
    $defs: _planDefinitions,
    ...planRoot
  } = planSchema;
  const common = {
    format: {
      const: 'icarus.workflow-compiler-conformance-case-result/1',
    },
    case_id: stableIdSchema,
    source_kind: enumString([
      'graph_scope',
      'workflow_definition',
      'workflow_schema',
    ]),
    proof_hashes: array(hashSchema, { uniqueItems: true }),
    program_hashes: array(hashSchema, { uniqueItems: true }),
    result_hash: hashSchema,
  };
  const compiled = (withStaticLoweringIdentity: boolean): Schema =>
    object({
      ...common,
      source_hash: hashSchema,
      outcome: { const: 'compiled' },
      normalized_plan: ref('compiled_scope_plan_v2'),
      static_lowering_contract_ref: withStaticLoweringIdentity
        ? versionedRefSchema
        : { type: 'null' },
      static_lowering_contract_hash: withStaticLoweringIdentity
        ? hashSchema
        : { type: 'null' },
      diagnostics: array(diagnosticSchema, { maxItems: 0 }),
    });
  const rejected = object({
    ...common,
    source_hash: nullable(hashSchema),
    outcome: { const: 'rejected' },
    normalized_plan: { type: 'null' },
    static_lowering_contract_ref: { type: 'null' },
    static_lowering_contract_hash: { type: 'null' },
    diagnostics: array(diagnosticSchema, { minItems: 1 }),
  });
  return {
    $schema: DRAFT_2020_12,
    $id: schemaId,
    title: 'icarus.workflow-compiler-conformance-case-result/1',
    oneOf: [compiled(true), compiled(false), rejected],
    $defs: {
      ...planSchema.$defs,
      compiled_scope_plan_v2: planRoot,
      json_value: jsonValueSchema,
      versioned_ref: versionedRefSchema,
    },
  };
}

export function buildCompilerConformanceCaseResultSchema(): Schema {
  return buildCompilerConformanceCaseResultSchemaForPlan(
    buildCompiledScopePlanV2Schema(),
    'https://icarus.local/schemas/compiler-conformance-case-result-v1',
  );
}

export function buildCompilerConformanceCaseResultExecutionBindingSchema(): Schema {
  return buildCompilerConformanceCaseResultSchemaForPlan(
    buildCompiledScopePlanV2ExecutionBindingSchema(),
    'https://icarus.local/schemas/compiler-conformance-case-result-execution-binding-v1',
  );
}

export function buildStaticLoweringContractSchema(): Schema {
  const terminalRoute = object({
    terminal_status: enumString(['succeeded', 'failed']),
    named_exit: enumString(['success', 'failure']),
    transition_slot: enumString(['on_complete.success', 'on_complete.failure']),
  });
  return object({
    format: { const: 'icarus.workflow-definition-static-lowering-contract/1' },
    applies_to_state_types: array(enumString(['delegation', 'system']), {
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
    }),
    normal_named_exits: array(enumString(['success', 'failure']), {
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
    }),
    capability_terminal_routes: array(terminalRoute, {
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
    }),
    engine_error: object({
      scope_outcome_kind: { const: 'errored' },
      named_exit: { type: 'null' },
      transition_slot: { const: 'on_error' },
    }),
    local_graph_cancel: object({
      scope_outcome_kind: { const: 'cancelled' },
      reason: { const: 'local_graph' },
      named_exit: { type: 'null' },
      transition_slot: { const: 'on_local_cancel' },
    }),
    global_workflow_cancel: object({
      scope_outcome_kind: { const: 'cancelled' },
      reason: { const: 'workflow' },
      named_exit: { type: 'null' },
      transition_slot: { type: 'null' },
      disposition: { const: 'terminate_workflow_without_state_transition' },
    }),
    contract_hash: hashSchema,
  });
}

const bindingEntrySchema = object({
  case_id: stableIdSchema,
  raw_source_bytes_ref: string({ pattern: HISTORICAL_DRAFT_PATH_PATTERN }),
  raw_source_bytes_hash: hashSchema,
  historical_input_snapshot_ref: string({
    pattern: HISTORICAL_DRAFT_PATH_PATTERN,
  }),
  historical_input_snapshot_hash: hashSchema,
  effective_case_input_hash: hashSchema,
});

export function buildG2CaseInputBindingSchema(): Schema {
  return object({
    format: { const: 'icarus.workflow-compiler-g2-case-input-binding/1' },
    binding_version: string({ minLength: 1 }),
    historical_g0_8_manifest_ref: string({
      pattern: '^contract-pack-golden-draft.json$',
    }),
    historical_g0_8_manifest_hash: hashSchema,
    historical_case_catalog_ref: string({
      pattern: HISTORICAL_DRAFT_PATH_PATTERN,
    }),
    historical_case_catalog_hash: hashSchema,
    compiler_toolchain_manifest_ref: versionedRefSchema,
    compiler_toolchain_hash: hashSchema,
    compiler_version: string({ minLength: 1 }),
    compiler_build_hash: hashSchema,
    canonical_normalizer_version: string({ minLength: 1 }),
    canonical_normalizer_hash: hashSchema,
    proof_algorithm_version: string({ minLength: 1 }),
    proof_algorithm_hash: hashSchema,
    error_catalog_ref: versionedRefSchema,
    error_catalog_hash: hashSchema,
    compiled_ir_schema_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    compiled_ir_schema_hash: hashSchema,
    conformance_result_schema_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    conformance_result_schema_hash: hashSchema,
    case_inputs: array(bindingEntrySchema, {
      minItems: 40,
      maxItems: 40,
      uniqueItems: true,
    }),
    binding_hash: hashSchema,
  });
}

export function buildG2BindingRequirementSchema(): Schema {
  const caseRequirement = object({
    case_id: stableIdSchema,
    raw_source_bytes_ref: string({ pattern: HISTORICAL_DRAFT_PATH_PATTERN }),
    raw_source_bytes_hash: hashSchema,
    historical_input_snapshot_ref: string({
      pattern: HISTORICAL_DRAFT_PATH_PATTERN,
    }),
    historical_input_snapshot_hash: hashSchema,
    resolved_binding_ref: { type: 'null' },
    resolved_binding_hash: { type: 'null' },
    effective_case_input_hash: { type: 'null' },
    status: { const: 'pending_exact_g2_identity' },
  });
  return object({
    format: {
      const: 'icarus.workflow-compiler-g2-case-input-binding-requirement/1',
    },
    historical_g0_8_manifest_ref: string({
      pattern: '^contract-pack-golden-draft.json$',
    }),
    historical_g0_8_manifest_hash: hashSchema,
    historical_case_catalog_ref: string({
      pattern: HISTORICAL_DRAFT_PATH_PATTERN,
    }),
    historical_case_catalog_hash: hashSchema,
    historical_input_snapshot_semantics: {
      const: 'frozen_g0_stage_absence_not_g2_identity',
    },
    resolved_binding_format: {
      const: 'icarus.workflow-compiler-g2-case-input-binding/1',
    },
    resolved_binding_schema_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    resolved_binding_schema_hash: hashSchema,
    effective_case_input_domain_separator: {
      const: 'icarus:workflow-compiler-effective-case-input:1\n',
    },
    binding_domain_separator: {
      const: 'icarus:workflow-compiler-g2-case-input-binding:1\n',
    },
    required_exact_identity_fields: {
      const: [...COMPILER_G2_EXACT_IDENTITY_FIELDS],
    },
    case_requirements: array(caseRequirement, {
      minItems: 40,
      maxItems: 40,
      uniqueItems: true,
    }),
    resolution_status: { const: 'pending_g2_compiler_implementation' },
    review_barrier: {
      const: 'blocked_until_resolved_binding_is_published',
    },
    mutation_policy: { const: 'publish_new_version_never_rewrite' },
    requirement_hash: hashSchema,
  });
}

const assertionSchema = object({
  assertion_id: stableIdSchema,
  subject_pointer: string({ pattern: POINTER_PATTERN }),
  operator: enumString([
    'equals',
    'set_equals',
    'ordered_equals',
    'contains',
    'present',
    'absent',
  ]),
  expected: ref('json_value'),
  rationale: string({ minLength: 1 }),
});

function assertionTargetSchema(): Schema {
  return object({
    artifact_format: {
      const: 'icarus.workflow-compiler-conformance-case-result/1',
    },
    schema_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    schema_hash: hashSchema,
    pointer_root: { const: '' },
    canonicalization: { const: 'rfc8785_jcs' },
    encoding: { const: 'utf-8' },
    canonical_bytes: { const: 'jcs_full_result_including_result_hash' },
    hash_field: { const: 'result_hash' },
    hash_preimage: { const: 'jcs_result_without_result_hash' },
    hash_domain_separator: {
      const: 'icarus:workflow-compiler-conformance-case-result:1\n',
    },
  });
}

export function buildGoldenDraftCasesV2Schema(): Schema {
  const candidate = object({
    case_id: stableIdSchema,
    polarity: enumString(['positive', 'negative']),
    source_kind: enumString([
      'graph_scope',
      'workflow_definition',
      'workflow_schema',
    ]),
    coverage_tags: array(stableIdSchema, { minItems: 1, uniqueItems: true }),
    raw_source_bytes_ref: string({ pattern: HISTORICAL_DRAFT_PATH_PATTERN }),
    raw_source_bytes_hash: hashSchema,
    historical_input_snapshot_ref: string({
      pattern: HISTORICAL_DRAFT_PATH_PATTERN,
    }),
    historical_input_snapshot_hash: hashSchema,
    expected_source_hash: nullable(hashSchema),
    g2_case_input_binding_ref: { type: 'null' },
    g2_case_input_binding_hash: { type: 'null' },
    expected_case_result_bytes_ref: { type: 'null' },
    expected_case_result_hash: { type: 'null' },
    expected_plan_hash: { type: 'null' },
    expected_proof_hashes: { type: 'null' },
    expected_program_hashes: { type: 'null' },
    expected_diagnostics: array(diagnosticSchema),
    semantic_assertions: array(assertionSchema, { minItems: 1 }),
    review_status: { const: 'blocked_pending_exact_g2_identity' },
    authored_by: { const: 'codex:contract-repair-author' },
  });
  return object({
    format: { const: 'icarus.workflow-compiler-golden-draft-cases/2' },
    bundle_version: { const: '2.0.0-contract-repair' },
    historical_case_catalog_ref: string({
      pattern: HISTORICAL_DRAFT_PATH_PATTERN,
    }),
    historical_case_catalog_hash: hashSchema,
    assertion_target: assertionTargetSchema(),
    cases: array(candidate, { minItems: 40, maxItems: 40 }),
    positive_case_count: { const: 10 },
    negative_case_count: { const: 30 },
    catalog_hash: hashSchema,
  });
}

export function buildGoldenDraftManifestV2Schema(): Schema {
  return object({
    format: { const: 'icarus.workflow-compiler-golden-draft-manifest/2' },
    bundle_version: { const: '2.0.0-contract-repair' },
    draft_status: { const: 'blocked_pending_exact_g2_identity' },
    historical_g0_8_manifest_ref: string({
      pattern: '^contract-pack-golden-draft.json$',
    }),
    historical_g0_8_manifest_hash: hashSchema,
    case_catalog_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    case_catalog_hash: hashSchema,
    case_input_binding_requirement_ref: string({
      pattern: REPAIR_PATH_PATTERN,
    }),
    case_input_binding_requirement_hash: hashSchema,
    compiled_ir_schema_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    compiled_ir_schema_hash: hashSchema,
    conformance_result_schema_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    conformance_result_schema_hash: hashSchema,
    static_lowering_contract_ref: string({ pattern: REPAIR_PATH_PATTERN }),
    static_lowering_contract_hash: hashSchema,
    positive_case_count: { const: 10 },
    negative_case_count: { const: 30 },
    exact_g2_identity_status: { const: 'absent_pending_implementation' },
    expected_case_result_status: { const: 'all_null' },
    golden_semantic_review_status: { const: 'absent' },
    sealed_bundle_status: { const: 'absent' },
    next_required_draft_version: {
      const: 'new_version_with_resolved_exact_g2_identity',
    },
    manifest_hash: hashSchema,
  });
}

export interface CompilerContractRepairSchemaDescriptor {
  artifact_path: string;
  artifact_format: string;
  target_format: string;
  domain_separator: string;
  build_schema: () => Schema;
}

export const COMPILER_CONTRACT_REPAIR_SCHEMA_DESCRIPTORS: readonly CompilerContractRepairSchemaDescriptor[] =
  [
    {
      artifact_path:
        'conformance/compiler-contract-repair/schemas/compiled-scope-plan-v2-schema.json',
      artifact_format: 'icarus.workflow-compiled-scope-plan-schema/2',
      target_format: 'icarus.workflow-graph-scope-plan/2',
      domain_separator: 'icarus:workflow-compiled-scope-plan-schema:2\n',
      build_schema: buildCompiledScopePlanV2Schema,
    },
    {
      artifact_path:
        'conformance/compiler-contract-repair/schemas/compiler-conformance-case-result-schema.json',
      artifact_format:
        'icarus.workflow-compiler-conformance-case-result-schema/1',
      target_format: 'icarus.workflow-compiler-conformance-case-result/1',
      domain_separator:
        'icarus:workflow-compiler-conformance-case-result-schema:1\n',
      build_schema: buildCompilerConformanceCaseResultSchema,
    },
    {
      artifact_path:
        'conformance/compiler-contract-repair/schemas/definition-static-lowering-contract-schema.json',
      artifact_format:
        'icarus.workflow-definition-static-lowering-contract-schema/1',
      target_format: 'icarus.workflow-definition-static-lowering-contract/1',
      domain_separator:
        'icarus:workflow-definition-static-lowering-contract-schema:1\n',
      build_schema: buildStaticLoweringContractSchema,
    },
    {
      artifact_path:
        'conformance/compiler-contract-repair/schemas/g2-case-input-binding-schema.json',
      artifact_format:
        'icarus.workflow-compiler-g2-case-input-binding-schema/1',
      target_format: 'icarus.workflow-compiler-g2-case-input-binding/1',
      domain_separator:
        'icarus:workflow-compiler-g2-case-input-binding-schema:1\n',
      build_schema: buildG2CaseInputBindingSchema,
    },
    {
      artifact_path:
        'conformance/compiler-contract-repair/schemas/g2-case-input-binding-requirement-schema.json',
      artifact_format:
        'icarus.workflow-compiler-g2-case-input-binding-requirement-schema/1',
      target_format:
        'icarus.workflow-compiler-g2-case-input-binding-requirement/1',
      domain_separator:
        'icarus:workflow-compiler-g2-case-input-binding-requirement-schema:1\n',
      build_schema: buildG2BindingRequirementSchema,
    },
    {
      artifact_path:
        'conformance/compiler-contract-repair/schemas/golden-draft-cases-v2-schema.json',
      artifact_format: 'icarus.workflow-compiler-golden-draft-cases-schema/2',
      target_format: 'icarus.workflow-compiler-golden-draft-cases/2',
      domain_separator:
        'icarus:workflow-compiler-golden-draft-cases-schema:2\n',
      build_schema: buildGoldenDraftCasesV2Schema,
    },
    {
      artifact_path:
        'conformance/compiler-contract-repair/schemas/golden-draft-manifest-v2-schema.json',
      artifact_format:
        'icarus.workflow-compiler-golden-draft-manifest-schema/2',
      target_format: 'icarus.workflow-compiler-golden-draft-manifest/2',
      domain_separator:
        'icarus:workflow-compiler-golden-draft-manifest-schema:2\n',
      build_schema: buildGoldenDraftManifestV2Schema,
    },
  ] as const;

export const COMPILER_CONTRACT_REPAIR_SCHEMA_FORMAT_BY_TARGET =
  Object.fromEntries(
    COMPILER_CONTRACT_REPAIR_SCHEMA_DESCRIPTORS.map((descriptor) => [
      descriptor.target_format,
      descriptor.artifact_format,
    ]),
  ) as Record<string, string>;

export function buildCompilerContractRepairArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const detached = strictParseJson(JSON.stringify(payload)) as JsonObject;
  const revision = Number(format.slice(format.lastIndexOf('/') + 1));
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error(`Invalid repair artifact format revision: ${format}`);
  const artifact: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: `${revision}.0.0` },
    version: revision,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload: detached,
  };
  return { ...artifact, hash: calculateArtifactHash(artifact) };
}

export function buildCompilerContractRepairSchemaArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  return COMPILER_CONTRACT_REPAIR_SCHEMA_DESCRIPTORS.map((descriptor) => {
    const built = descriptor.build_schema();
    const existingDefinitions = built.$defs;
    if (existingDefinitions !== undefined)
      assertJsonObject(existingDefinitions);
    const schema = {
      $schema: DRAFT_2020_12,
      $id:
        typeof built.$id === 'string'
          ? built.$id
          : `https://icarus.local/schemas/${descriptor.target_format.replaceAll('.', '/').replace('/', '-')}`,
      title:
        typeof built.title === 'string'
          ? built.title
          : descriptor.target_format,
      ...built,
      $defs: {
        json_value: jsonValueSchema,
        versioned_ref: versionedRefSchema,
        ...(existingDefinitions ?? {}),
      },
    };
    return [
      descriptor.artifact_path,
      buildCompilerContractRepairArtifact(
        descriptor.artifact_format,
        descriptor.artifact_format.slice(
          0,
          descriptor.artifact_format.lastIndexOf('/'),
        ),
        descriptor.domain_separator,
        schema,
      ),
    ];
  });
}

export function artifactDescriptor(
  artifactPath: string,
  artifact: ContractArtifactEnvelope,
): JsonObject {
  return {
    path: artifactPath,
    format: artifact.format,
    ref: artifact.ref,
    version: artifact.version,
    domain_separator: artifact.domain_separator,
    hash: artifact.hash,
  };
}
