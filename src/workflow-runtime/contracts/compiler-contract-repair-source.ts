import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  buildCompilerContractRepairArtifact,
  type CompilerContractRepairSchemaDescriptor,
} from './compiler-contract-repair-artifacts.js';
import {
  COMPILER_G2_EXACT_IDENTITY_FIELDS,
  type CompilerG2CaseInputBindingEntryV1,
  type CompilerG2CaseInputBindingRequirementV1,
  type CompilerG2CaseInputBindingV1,
  type CompilerSemanticAssertionV2,
  type DefinitionStaticLoweringContractV1,
  type GoldenDraftCaseCatalogV2,
  type GoldenDraftCaseV2,
  type GoldenDraftManifestV2,
  type WorkflowCompilerConformanceCaseResultV1,
} from './compiler-contract-repair-types.js';
import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

export const COMPILER_CONTRACT_REPAIR_ROOT =
  'conformance/compiler-contract-repair' as const;
export const COMPILER_CONTRACT_REPAIR_MANIFEST_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/contract-pack-compiler-contract-repair.json` as const;
export const COMPILER_CONTRACT_REPAIR_DOMAIN_CATALOG_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/catalogs/compiler-contract-repair-domain-separators.json` as const;
export const COMPILER_CONTRACT_REPAIR_STATIC_LOWERING_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/contracts/definition-static-lowering-contract@1.json` as const;
export const COMPILER_CONTRACT_REPAIR_BINDING_REQUIREMENT_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/draft/g2-case-input-binding-requirement@1.json` as const;
export const COMPILER_CONTRACT_REPAIR_DRAFT_CASES_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/draft/golden-draft-cases@2.json` as const;
export const COMPILER_CONTRACT_REPAIR_DRAFT_MANIFEST_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/draft/golden-draft-manifest@2.json` as const;
export const COMPILER_CONTRACT_REPAIR_DECISION_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/compiler-contract-repair-decision@1.json` as const;
export const COMPILER_CONTRACT_REPAIR_FIXTURES_PATH =
  `${COMPILER_CONTRACT_REPAIR_ROOT}/contract-fixtures/repair-cases@1.json` as const;
export const COMPILER_CONTRACT_REPAIR_SPEC_PATH =
  'local/docs/dynamic-workflow-g2-contract-repair-v1.md' as const;
export const COMPILER_CONTRACT_REPAIR_BASE_SPEC_PATH =
  'local/docs/dynamic-workflow-dag-framework.md' as const;

export const HISTORICAL_G0_3_MANIFEST_HASH =
  'sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8' as const;
export const HISTORICAL_G0_8_MANIFEST_HASH =
  'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22' as const;
export const HISTORICAL_COMPILED_IR_SCHEMA_HASH =
  'sha256:7d2371a5df632220ba82ab0739b163134978885b8baaae6d7b247d53623be400' as const;
export const HISTORICAL_G0_8_CASE_CATALOG_HASH =
  'sha256:20be39783a5c775c0d804ce16db683540b72bcc2aa1750f9f1b93c9b7c1c4aa3' as const;
export const HISTORICAL_G0_8_BASE_SNAPSHOT_HASH =
  'sha256:0c251df1bb92f331c953ac00938d9a0903a07270d25525a372683bd17e58a6e9' as const;
export const HISTORICAL_G0_8_INTEGRITY_SNAPSHOT_HASH =
  'sha256:bfd174e78250899dc3a3e7c4de43684f75b8d3ec01ee307d9da3bdda87eef3c1' as const;
export const HISTORICAL_COMPILED_IR_SCHEMA_RAW_SHA256 =
  'sha256:b89d1a2a6a30b2c2c3d2526be6f12a492fb29314b1e38fb5c2856be0a47d5157' as const;
export const HISTORICAL_G0_8_CASE_CATALOG_RAW_SHA256 =
  'sha256:81c1d7e9d54c29b0785f50d340e2278a96c5866e77427a0f8719ec79e9b5f5a3' as const;
export const HISTORICAL_BASE_SPEC_RAW_SHA256 =
  'sha256:8f860bcba8c7f7e314d0ce115d505cbb00519d431fcfebce9bd2c387b70d8f1c' as const;

export const COMPILED_PLAN_V2_DOMAIN_SEPARATOR =
  'icarus:workflow-graph-plan:2\n' as const;
export const CONDITION_PROGRAM_V2_DOMAIN_SEPARATOR =
  'icarus:workflow-condition-program:2\n' as const;
export const STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure-member:1\n' as const;
export const STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure:1\n' as const;
export const COMPILER_CASE_RESULT_DOMAIN_SEPARATOR =
  'icarus:workflow-compiler-conformance-case-result:1\n' as const;
export const G2_CASE_INPUT_DOMAIN_SEPARATOR =
  'icarus:workflow-compiler-effective-case-input:1\n' as const;
export const G2_CASE_INPUT_BINDING_DOMAIN_SEPARATOR =
  'icarus:workflow-compiler-g2-case-input-binding:1\n' as const;

export function calculateCompilerConformanceCaseResultHash(
  result: Omit<WorkflowCompilerConformanceCaseResultV1, 'result_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
    result as unknown as JsonValue,
  );
}

const STATIC_LOWERING_REF = {
  id: 'icarus.workflow-definition-static-lowering-contract',
  version: '1.0.0',
} as const;

interface HistoricalCase extends JsonObject {
  case_id: string;
  polarity: 'positive' | 'negative';
  source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
  coverage_tags: string[];
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  input_snapshot_ref: string;
  input_snapshot_hash: Sha256Hash;
  expected_source_hash: Sha256Hash | null;
  expected_diagnostics: Array<{
    code: string;
    phase: string;
    instance_pointer: string;
    schema_pointer: string | null;
    stable_object_id: string | null;
    detail_ref: string | null;
  }>;
}

function readRepoBytes(relativePath: string): Buffer {
  const absolute = path.resolve(repoRoot, relativePath);
  if (!absolute.startsWith(`${repoRoot}${path.sep}`))
    throw new Error(`Repository path escapes root: ${relativePath}`);
  return fs.readFileSync(absolute);
}

function readContractArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      readRepoBytes(`src/workflow-runtime/contracts/${relativePath}`),
    ),
  );
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function compilerContractRepairSpecHash(): Sha256Hash {
  return rawSha256(readRepoBytes(COMPILER_CONTRACT_REPAIR_SPEC_PATH));
}

function withSemanticHash<T extends JsonObject>(
  payload: Omit<T, keyof JsonObject> | JsonObject,
  hashField: string,
  domainSeparator: string,
): T {
  const withoutHash = { ...payload } as JsonObject;
  delete withoutHash[hashField];
  return {
    ...withoutHash,
    [hashField]: domainSeparatedSha256(domainSeparator, withoutHash),
  } as T;
}

export function assertHistoricalCompilerContractInputs(): void {
  const pins = [
    ['contract-pack-closed-schemas.json', HISTORICAL_G0_3_MANIFEST_HASH],
    ['contract-pack-golden-draft.json', HISTORICAL_G0_8_MANIFEST_HASH],
    [
      'schemas/compiled-scope-plan-schema.json',
      HISTORICAL_COMPILED_IR_SCHEMA_HASH,
    ],
    [
      'conformance/draft/golden-draft-cases@1.json',
      HISTORICAL_G0_8_CASE_CATALOG_HASH,
    ],
    [
      'conformance/draft/snapshots/complete-base@1.json',
      HISTORICAL_G0_8_BASE_SNAPSHOT_HASH,
    ],
    [
      'conformance/draft/snapshots/compiler-integrity-mismatch@1.json',
      HISTORICAL_G0_8_INTEGRITY_SNAPSHOT_HASH,
    ],
  ] as const;
  for (const [relativePath, expectedHash] of pins) {
    const artifact = readContractArtifact(relativePath);
    if (artifact.hash !== expectedHash)
      throw new Error(`Historical compiler Contract drift: ${relativePath}`);
  }
  const rawPins = [
    [
      'src/workflow-runtime/contracts/schemas/compiled-scope-plan-schema.json',
      HISTORICAL_COMPILED_IR_SCHEMA_RAW_SHA256,
    ],
    [
      'src/workflow-runtime/contracts/conformance/draft/golden-draft-cases@1.json',
      HISTORICAL_G0_8_CASE_CATALOG_RAW_SHA256,
    ],
  ] as const;
  for (const [relativePath, expectedHash] of rawPins)
    if (rawSha256(readRepoBytes(relativePath)) !== expectedHash)
      throw new Error(`Historical compiler raw bytes drift: ${relativePath}`);
  if (
    rawSha256(readRepoBytes(COMPILER_CONTRACT_REPAIR_BASE_SPEC_PATH)) !==
    HISTORICAL_BASE_SPEC_RAW_SHA256
  )
    throw new Error('Historical base architecture spec bytes drift');
}

export function readHistoricalGoldenCases(): HistoricalCase[] {
  const artifact = readContractArtifact(
    'conformance/draft/golden-draft-cases@1.json',
  );
  const cases = artifact.payload.cases;
  if (!Array.isArray(cases)) throw new Error('Historical G0.8 cases missing');
  return cases as HistoricalCase[];
}

export function buildStaticLoweringContract(): DefinitionStaticLoweringContractV1 {
  return withSemanticHash<DefinitionStaticLoweringContractV1>(
    {
      format: 'icarus.workflow-definition-static-lowering-contract/1',
      applies_to_state_types: ['delegation', 'system'],
      normal_named_exits: ['success', 'failure'],
      capability_terminal_routes: [
        {
          terminal_status: 'succeeded',
          named_exit: 'success',
          transition_slot: 'on_complete.success',
        },
        {
          terminal_status: 'failed',
          named_exit: 'failure',
          transition_slot: 'on_complete.failure',
        },
      ],
      engine_error: {
        scope_outcome_kind: 'errored',
        named_exit: null,
        transition_slot: 'on_error',
      },
      local_graph_cancel: {
        scope_outcome_kind: 'cancelled',
        reason: 'local_graph',
        named_exit: null,
        transition_slot: 'on_local_cancel',
      },
      global_workflow_cancel: {
        scope_outcome_kind: 'cancelled',
        reason: 'workflow',
        named_exit: null,
        transition_slot: null,
        disposition: 'terminate_workflow_without_state_transition',
      },
    },
    'contract_hash',
    'icarus:workflow-definition-static-lowering-contract:1\n',
  );
}

function assertion(
  assertionId: string,
  subjectPointer: string,
  operator: CompilerSemanticAssertionV2['operator'],
  expected: JsonValue,
  rationale: string,
): CompilerSemanticAssertionV2 {
  return {
    assertion_id: assertionId,
    subject_pointer: subjectPointer,
    operator,
    expected,
    rationale,
  };
}

function positiveAssertions(
  caseId: string,
  staticLoweringHash: Sha256Hash,
): CompilerSemanticAssertionV2[] {
  switch (caseId) {
    case 'positive.static-lowering':
      return [
        assertion(
          'lowered-root-node',
          '/normalized_plan/nodes/0/type',
          'equals',
          'delegation',
          'Canonical node ordering places the single lowered capability node first.',
        ),
        assertion(
          'lowered-normal-named-exits',
          '/normalized_plan/interface_snapshot/exits',
          'set_equals',
          ['success', 'failure'],
          'Only capability success and failure are normal named exits.',
        ),
        assertion(
          'lowered-outcome-contract-ref',
          '/static_lowering_contract_ref',
          'equals',
          { ...STATIC_LOWERING_REF },
          'Engine error and cancellation semantics are bound by the versioned lowering contract.',
        ),
        assertion(
          'lowered-outcome-contract-hash',
          '/static_lowering_contract_hash',
          'equals',
          staticLoweringHash,
          'The exact lowering contract identity is part of the conformance result.',
        ),
      ];
    case 'positive.condition-route':
      return [
        assertion(
          'route-order',
          '/normalized_plan/route_groups/0/ordered_edge_ids',
          'ordered_equals',
          ['edge.accepted', 'edge.rejected'],
          'Priority edge precedes the default edge.',
        ),
        assertion(
          'condition-typed',
          '/normalized_plan/control_edges/0/condition_program/operand_types',
          'ordered_equals',
          ['boolean', 'boolean'],
          'Operand categories follow normalized evaluation order and enter the Plan hash.',
        ),
      ];
    case 'positive.wait':
      return [
        assertion(
          'wait-binding',
          '/normalized_plan/nodes/0/wait_binding/contract_ref',
          'equals',
          { id: 'fixture.wait.approval', version: '1.0.0' },
          'Canonical node ordering and the exact wait contract are explicit Plan facts.',
        ),
      ];
    case 'positive.subgraph':
      return [
        assertion(
          'subgraph-precompiled',
          '/normalized_plan/nodes/0/factory_binding/precompiled_plan_hash',
          'present',
          true,
          'Static subgraph binding requires an exact precompiled child Plan hash.',
        ),
      ];
    case 'positive.expand':
      return [
        assertion(
          'expand-graph-spec-port',
          '/normalized_plan/nodes/1/graph_spec_input_port',
          'equals',
          'graph_spec',
          'Nodes are sorted by id and Expand consumes the required GraphScopeSpec port.',
        ),
      ];
    case 'positive.map':
      return [
        assertion(
          'map-result-order',
          '/normalized_plan/nodes/1/result_order',
          'equals',
          'item_index',
          'Map result order is an explicit execution field in Compiled IR v2.',
        ),
      ];
    case 'positive.policy-intersection':
      return [
        assertion(
          'policy-minimum',
          '/normalized_plan/effective_limits/max_nodes',
          'equals',
          8,
          'Requested limit tightens the parent and Safety ceilings.',
        ),
      ];
    case 'positive.quality-revision-binding':
      return [
        assertion(
          'quality-feedback-schema',
          '/normalized_plan/nodes/1/effective_retry_policy/quality_revision/feedback_schema_ref',
          'equals',
          { id: 'fixture.schema.feedback', version: '1.0.0' },
          'Canonical node ordering preserves the exact feedback schema binding.',
        ),
      ];
    case 'positive.sound-subtype-different-hash':
      return [
        assertion(
          'subtype-rule',
          '/normalized_plan/data_edges/0/compatibility_proof/proof_rule',
          'equals',
          'enum_subset',
          'The Plan stores the sound proof rule for different schema hashes.',
        ),
      ];
    case 'positive.static-child-closure':
      return [
        assertion(
          'nested-static-closure-parent',
          '/normalized_plan/static_child_plan_closure/members/0/scope_key',
          'equals',
          'nested_child',
          'Parent-before-child canonical closure ordering lists the nested child first.',
        ),
        assertion(
          'nested-static-closure-leaf',
          '/normalized_plan/static_child_plan_closure/members/1/scope_key',
          'equals',
          'leaf_child',
          'The transitive inline leaf is a hashed closure member in Compiled IR v2.',
        ),
      ];
    default:
      throw new Error(`Unknown positive G0.8 case: ${caseId}`);
  }
}

function negativeAssertions(
  candidate: HistoricalCase,
): CompilerSemanticAssertionV2[] {
  const primary = candidate.expected_diagnostics[0];
  if (!primary)
    throw new Error(`Negative case lacks diagnostic: ${candidate.case_id}`);
  return [
    assertion(
      `${candidate.case_id}.diagnostic`,
      '/diagnostics/0/code',
      'equals',
      primary.code,
      'The rejected conformance result preserves the hand-authored stable diagnostic.',
    ),
    assertion(
      `${candidate.case_id}.no-plan`,
      '/normalized_plan',
      'equals',
      null,
      'A rejected case result cannot contain a normalized Compiled Plan.',
    ),
  ];
}

export function buildGoldenDraftCasesV2(
  resultSchemaRef: string,
  resultSchemaHash: Sha256Hash,
  staticLoweringHash: Sha256Hash,
): GoldenDraftCaseCatalogV2 {
  const historicalCases = readHistoricalGoldenCases();
  const cases: GoldenDraftCaseV2[] = historicalCases.map((candidate) => ({
    case_id: candidate.case_id,
    polarity: candidate.polarity,
    source_kind: candidate.source_kind,
    coverage_tags: [...candidate.coverage_tags],
    raw_source_bytes_ref: candidate.raw_source_bytes_ref,
    raw_source_bytes_hash: candidate.raw_source_bytes_hash,
    historical_input_snapshot_ref: candidate.input_snapshot_ref,
    historical_input_snapshot_hash: candidate.input_snapshot_hash,
    expected_source_hash: candidate.expected_source_hash,
    g2_case_input_binding_ref: null,
    g2_case_input_binding_hash: null,
    expected_case_result_bytes_ref: null,
    expected_case_result_hash: null,
    expected_plan_hash: null,
    expected_proof_hashes: null,
    expected_program_hashes: null,
    expected_diagnostics: candidate.expected_diagnostics.map((entry) => ({
      code: entry.code as never,
      phase: entry.phase as never,
      instance_pointer: entry.instance_pointer,
      schema_pointer: entry.schema_pointer,
      stable_object_id: entry.stable_object_id,
      detail_ref: entry.detail_ref,
    })),
    semantic_assertions:
      candidate.polarity === 'positive'
        ? positiveAssertions(candidate.case_id, staticLoweringHash)
        : negativeAssertions(candidate),
    review_status: 'blocked_pending_exact_g2_identity',
    authored_by: 'codex:contract-repair-author',
  }));
  return withSemanticHash<GoldenDraftCaseCatalogV2>(
    {
      format: 'icarus.workflow-compiler-golden-draft-cases/2',
      bundle_version: '2.0.0-contract-repair',
      historical_case_catalog_ref:
        'conformance/draft/golden-draft-cases@1.json',
      historical_case_catalog_hash: HISTORICAL_G0_8_CASE_CATALOG_HASH,
      assertion_target: {
        artifact_format: 'icarus.workflow-compiler-conformance-case-result/1',
        schema_ref: resultSchemaRef,
        schema_hash: resultSchemaHash,
        pointer_root: '',
        canonicalization: 'rfc8785_jcs',
        encoding: 'utf-8',
        canonical_bytes: 'jcs_full_result_including_result_hash',
        hash_field: 'result_hash',
        hash_preimage: 'jcs_result_without_result_hash',
        hash_domain_separator: COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
      },
      cases,
      positive_case_count: cases.filter(
        (entry) => entry.polarity === 'positive',
      ).length,
      negative_case_count: cases.filter(
        (entry) => entry.polarity === 'negative',
      ).length,
    },
    'catalog_hash',
    'icarus:workflow-compiler-golden-draft-cases:2\n',
  );
}

export function buildG2BindingRequirement(
  bindingSchemaRef: string,
  bindingSchemaHash: Sha256Hash,
): CompilerG2CaseInputBindingRequirementV1 {
  const cases = readHistoricalGoldenCases();
  return withSemanticHash<CompilerG2CaseInputBindingRequirementV1>(
    {
      format: 'icarus.workflow-compiler-g2-case-input-binding-requirement/1',
      historical_g0_8_manifest_ref: 'contract-pack-golden-draft.json',
      historical_g0_8_manifest_hash: HISTORICAL_G0_8_MANIFEST_HASH,
      historical_case_catalog_ref:
        'conformance/draft/golden-draft-cases@1.json',
      historical_case_catalog_hash: HISTORICAL_G0_8_CASE_CATALOG_HASH,
      historical_input_snapshot_semantics:
        'frozen_g0_stage_absence_not_g2_identity',
      resolved_binding_format:
        'icarus.workflow-compiler-g2-case-input-binding/1',
      resolved_binding_schema_ref: bindingSchemaRef,
      resolved_binding_schema_hash: bindingSchemaHash,
      effective_case_input_domain_separator: G2_CASE_INPUT_DOMAIN_SEPARATOR,
      binding_domain_separator: G2_CASE_INPUT_BINDING_DOMAIN_SEPARATOR,
      required_exact_identity_fields: [...COMPILER_G2_EXACT_IDENTITY_FIELDS],
      case_requirements: cases.map((candidate) => ({
        case_id: candidate.case_id,
        raw_source_bytes_ref: candidate.raw_source_bytes_ref,
        raw_source_bytes_hash: candidate.raw_source_bytes_hash,
        historical_input_snapshot_ref: candidate.input_snapshot_ref,
        historical_input_snapshot_hash: candidate.input_snapshot_hash,
        resolved_binding_ref: null,
        resolved_binding_hash: null,
        effective_case_input_hash: null,
        status: 'pending_exact_g2_identity',
      })),
      resolution_status: 'pending_g2_compiler_implementation',
      review_barrier: 'blocked_until_resolved_binding_is_published',
      mutation_policy: 'publish_new_version_never_rewrite',
    },
    'requirement_hash',
    'icarus:workflow-compiler-g2-case-input-binding-requirement:1\n',
  );
}

export function calculateEffectiveG2CaseInputHash(
  binding: Omit<CompilerG2CaseInputBindingV1, 'case_inputs' | 'binding_hash'>,
  entry: Omit<CompilerG2CaseInputBindingEntryV1, 'effective_case_input_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(G2_CASE_INPUT_DOMAIN_SEPARATOR, {
    case_id: entry.case_id,
    raw_source_bytes_ref: entry.raw_source_bytes_ref,
    raw_source_bytes_hash: entry.raw_source_bytes_hash,
    historical_input_snapshot_ref: entry.historical_input_snapshot_ref,
    historical_input_snapshot_hash: entry.historical_input_snapshot_hash,
    compiler_toolchain_manifest_ref: binding.compiler_toolchain_manifest_ref,
    compiler_toolchain_hash: binding.compiler_toolchain_hash,
    compiler_version: binding.compiler_version,
    compiler_build_hash: binding.compiler_build_hash,
    canonical_normalizer_version: binding.canonical_normalizer_version,
    canonical_normalizer_hash: binding.canonical_normalizer_hash,
    proof_algorithm_version: binding.proof_algorithm_version,
    proof_algorithm_hash: binding.proof_algorithm_hash,
    error_catalog_ref: binding.error_catalog_ref,
    error_catalog_hash: binding.error_catalog_hash,
    compiled_ir_schema_ref: binding.compiled_ir_schema_ref,
    compiled_ir_schema_hash: binding.compiled_ir_schema_hash,
    conformance_result_schema_ref: binding.conformance_result_schema_ref,
    conformance_result_schema_hash: binding.conformance_result_schema_hash,
  });
}

export function calculateG2CaseInputBindingHash(
  binding: Omit<CompilerG2CaseInputBindingV1, 'binding_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    G2_CASE_INPUT_BINDING_DOMAIN_SEPARATOR,
    binding as unknown as JsonValue,
  );
}

export function buildGoldenDraftManifestV2(
  caseCatalogHash: Sha256Hash,
  bindingRequirementHash: Sha256Hash,
  compiledIrSchemaHash: Sha256Hash,
  resultSchemaHash: Sha256Hash,
  staticLoweringHash: Sha256Hash,
): GoldenDraftManifestV2 {
  return withSemanticHash<GoldenDraftManifestV2>(
    {
      format: 'icarus.workflow-compiler-golden-draft-manifest/2',
      bundle_version: '2.0.0-contract-repair',
      draft_status: 'blocked_pending_exact_g2_identity',
      historical_g0_8_manifest_ref: 'contract-pack-golden-draft.json',
      historical_g0_8_manifest_hash: HISTORICAL_G0_8_MANIFEST_HASH,
      case_catalog_ref: COMPILER_CONTRACT_REPAIR_DRAFT_CASES_PATH,
      case_catalog_hash: caseCatalogHash,
      case_input_binding_requirement_ref:
        COMPILER_CONTRACT_REPAIR_BINDING_REQUIREMENT_PATH,
      case_input_binding_requirement_hash: bindingRequirementHash,
      compiled_ir_schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
      compiled_ir_schema_hash: compiledIrSchemaHash,
      conformance_result_schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiler-conformance-case-result-schema.json`,
      conformance_result_schema_hash: resultSchemaHash,
      static_lowering_contract_ref:
        COMPILER_CONTRACT_REPAIR_STATIC_LOWERING_PATH,
      static_lowering_contract_hash: staticLoweringHash,
      positive_case_count: 10,
      negative_case_count: 30,
      exact_g2_identity_status: 'absent_pending_implementation',
      expected_case_result_status: 'all_null',
      golden_semantic_review_status: 'absent',
      sealed_bundle_status: 'absent',
      next_required_draft_version:
        'new_version_with_resolved_exact_g2_identity',
    },
    'manifest_hash',
    'icarus:workflow-compiler-golden-draft-manifest:2\n',
  );
}

export function buildRepairDecision(
  compiledIrSchemaHash: Sha256Hash,
  resultSchemaHash: Sha256Hash,
  bindingSchemaHash: Sha256Hash,
  bindingRequirementHash: Sha256Hash,
  staticLoweringHash: Sha256Hash,
  draftManifestHash: Sha256Hash,
): JsonObject {
  return withSemanticHash(
    {
      format: 'icarus.workflow-compiler-contract-repair-decision/1',
      repair_id: 'R-016',
      repair_status: 'spec_and_contract_repaired',
      normative_spec: {
        base_spec_ref: COMPILER_CONTRACT_REPAIR_BASE_SPEC_PATH,
        base_spec_raw_sha256: HISTORICAL_BASE_SPEC_RAW_SHA256,
        additive_repair_spec_ref: COMPILER_CONTRACT_REPAIR_SPEC_PATH,
        additive_repair_spec_raw_sha256: compilerContractRepairSpecHash(),
        precedence: 'repair_addendum_overrides_r016_topics_only',
      },
      historical_contracts: {
        g0_3_manifest_hash: HISTORICAL_G0_3_MANIFEST_HASH,
        g0_8_manifest_hash: HISTORICAL_G0_8_MANIFEST_HASH,
        compiled_ir_v1_schema_hash: HISTORICAL_COMPILED_IR_SCHEMA_HASH,
        golden_draft_v1_case_catalog_hash: HISTORICAL_G0_8_CASE_CATALOG_HASH,
        mutation_policy: 'immutable_history',
      },
      normalized_assertion_target: {
        artifact_format: 'icarus.workflow-compiler-conformance-case-result/1',
        schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiler-conformance-case-result-schema.json`,
        schema_hash: resultSchemaHash,
        pointer_root: '',
        canonicalization: 'rfc8785_jcs',
        encoding: 'utf-8',
        canonical_bytes: 'jcs_full_result_including_result_hash',
        hash_field: 'result_hash',
        hash_domain_separator: COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
        hash_preimage: 'jcs_result_without_result_hash',
      },
      compiled_ir_v2: {
        format: 'icarus.workflow-graph-scope-plan/2',
        schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
        schema_hash: compiledIrSchemaHash,
        plan_hash_domain_separator: COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
        operand_types: 'required_in_compiled_condition_program',
        operand_type_order: 'normalized_ast_left_to_right_evaluation_order',
        map_result_order: 'required_literal_item_index',
        static_child_closure_storage: 'embedded_hashed_member_manifest',
        static_child_member_order:
          'parent_before_descendant_then_closure_key_ascending',
        static_child_plan_bytes:
          'independent_content_addressed_plan_ref_not_separate_golden_oracle',
        condition_program_hash_domain_separator:
          CONDITION_PROGRAM_V2_DOMAIN_SEPARATOR,
        closure_member_hash_domain_separator:
          STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
        closure_hash_domain_separator: STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
      },
      static_lowering: {
        contract_ref: COMPILER_CONTRACT_REPAIR_STATIC_LOWERING_PATH,
        contract_hash: staticLoweringHash,
        normal_named_exits: ['success', 'failure'],
        engine_error: 'errored_outcome_to_on_error_not_named_exit',
        local_cancel:
          'cancelled_local_graph_outcome_to_on_local_cancel_not_named_exit',
        global_cancel:
          'cancelled_workflow_outcome_terminates_without_state_transition',
      },
      additive_g2_identity_binding: {
        resolved_format: 'icarus.workflow-compiler-g2-case-input-binding/1',
        resolved_schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/g2-case-input-binding-schema.json`,
        resolved_schema_hash: bindingSchemaHash,
        requirement_ref: COMPILER_CONTRACT_REPAIR_BINDING_REQUIREMENT_PATH,
        requirement_hash: bindingRequirementHash,
        effective_case_input_domain_separator: G2_CASE_INPUT_DOMAIN_SEPARATOR,
        binding_domain_separator: G2_CASE_INPUT_BINDING_DOMAIN_SEPARATOR,
        g0_8_absent_identity_semantics:
          'historical_stage_fact_never_an_effective_g2_identity',
        current_status: 'pending_real_g2_implementation_hashes',
      },
      golden_draft_v2: {
        manifest_ref: COMPILER_CONTRACT_REPAIR_DRAFT_MANIFEST_PATH,
        manifest_hash: draftManifestHash,
        case_count: 40,
        raw_source_policy: 'reuse_historical_refs_and_hashes',
        input_snapshot_policy: 'reuse_historical_refs_and_hashes',
        review_status: 'blocked_pending_exact_g2_identity',
        future_mutation_policy: 'publish_new_version_never_rewrite',
      },
      forbidden_outputs: [
        'production_compiler',
        'golden_semantic_approval',
        'golden_seal',
        'conformance_sealed_artifact',
        'g3_or_later_implementation',
        'g8_or_g9_identity',
      ],
    },
    'repair_hash',
    'icarus:workflow-compiler-contract-repair-decision:1\n',
  );
}

export function buildRepairFixtures(): JsonObject {
  return {
    format: 'icarus.workflow-compiler-contract-repair-fixtures/1',
    positive_cases: [
      'compiled_ir_v2_closed',
      'condition_operand_types_hashed',
      'map_result_order_explicit',
      'static_child_closure_embedded',
      'static_lowering_outcomes_disjoint',
      'single_assertion_target',
      'g0_8_inputs_additively_bound',
      'historical_bytes_unchanged',
    ],
    negative_cases: [
      'compiled_ir_v1_field_injection',
      'operand_types_missing',
      'map_result_order_missing',
      'closure_members_external_or_unhashed',
      'engine_error_as_named_exit',
      'local_cancel_as_named_exit',
      'assertion_target_review_projection',
      'g0_8_absent_identity_treated_as_g2_identity',
      'resolved_binding_missing_exact_hash',
      'draft_review_before_binding',
      'historical_artifact_rewrite',
      'sealed_output_created_by_repair',
    ],
    positive_case_count: 8,
    negative_case_count: 12,
  };
}

export function buildDomainCatalog(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  schemaDescriptors: readonly CompilerContractRepairSchemaDescriptor[],
): ContractArtifactEnvelope {
  const extra = [
    {
      format: 'icarus.workflow-graph-scope-plan/2',
      domain_separator: COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
      artifact_path: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
    },
    {
      format: 'icarus.workflow-condition-program/2',
      domain_separator: CONDITION_PROGRAM_V2_DOMAIN_SEPARATOR,
      artifact_path: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
    },
    {
      format: 'icarus.workflow-static-child-plan-closure-member/1',
      domain_separator: STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
      artifact_path: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
    },
    {
      format: 'icarus.workflow-static-child-plan-closure/1',
      domain_separator: STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
      artifact_path: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
    },
    {
      format: 'icarus.workflow-compiler-conformance-case-result/1',
      domain_separator: COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
      artifact_path: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiler-conformance-case-result-schema.json`,
    },
    {
      format: 'icarus.workflow-compiler-effective-case-input/1',
      domain_separator: G2_CASE_INPUT_DOMAIN_SEPARATOR,
      artifact_path: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/g2-case-input-binding-schema.json`,
    },
    {
      format: 'icarus.workflow-compiler-g2-case-input-binding/1',
      domain_separator: G2_CASE_INPUT_BINDING_DOMAIN_SEPARATOR,
      artifact_path: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/g2-case-input-binding-schema.json`,
    },
    {
      format: 'icarus.workflow-contract-pack-compiler-contract-repair/1',
      domain_separator:
        'icarus:workflow-contract-pack-compiler-contract-repair:1\n',
      artifact_path: COMPILER_CONTRACT_REPAIR_MANIFEST_PATH,
    },
    {
      format: 'icarus.workflow-compiler-contract-repair-domain-separators/1',
      domain_separator:
        'icarus:workflow-compiler-contract-repair-domain-separators:1\n',
      artifact_path: COMPILER_CONTRACT_REPAIR_DOMAIN_CATALOG_PATH,
    },
  ];
  const entries = [
    ...artifacts.map(([artifactPath, artifact]) => ({
      format: artifact.format,
      domain_separator: artifact.domain_separator,
      artifact_path: artifactPath,
    })),
    ...schemaDescriptors.map((descriptor) => ({
      format: descriptor.target_format,
      domain_separator:
        extra.find((entry) => entry.format === descriptor.target_format)
          ?.domain_separator ?? descriptor.domain_separator,
      artifact_path: descriptor.artifact_path,
    })),
    ...extra,
  ]
    .filter(
      (entry, index, values) =>
        values.findIndex((candidate) => candidate.format === entry.format) ===
        index,
    )
    .sort((left, right) =>
      left.format < right.format ? -1 : left.format > right.format ? 1 : 0,
    );
  return buildCompilerContractRepairArtifact(
    'icarus.workflow-compiler-contract-repair-domain-separators/1',
    'icarus.workflow-compiler-contract-repair-domain-separators',
    'icarus:workflow-compiler-contract-repair-domain-separators:1\n',
    { registry_version: 1, entries },
  );
}

export function compilerContractRepairToolHash(): Sha256Hash {
  const sourceFiles = [
    'compiler-contract-repair-artifacts.ts',
    'compiler-contract-repair-pack.ts',
    'compiler-contract-repair-source.ts',
    'compiler-contract-repair-types.ts',
  ];
  return domainSeparatedSha256(
    'icarus:workflow-compiler-contract-repair-tool:1\n',
    sourceFiles.map((relativePath) => ({
      path: relativePath,
      source_sha256: rawSha256(
        readRepoBytes(`src/workflow-runtime/contracts/${relativePath}`),
      ),
    })),
  );
}

export function validateSemanticHash(
  payload: JsonObject,
  hashField: string,
  domainSeparator: string,
): boolean {
  const withoutHash = { ...payload };
  const actual = withoutHash[hashField];
  delete withoutHash[hashField];
  return actual === domainSeparatedSha256(domainSeparator, withoutHash);
}

export function canonicalObject(value: unknown): JsonObject {
  assertJsonObject(value);
  return JSON.parse(canonicalJson(value as JsonValue)) as JsonObject;
}
