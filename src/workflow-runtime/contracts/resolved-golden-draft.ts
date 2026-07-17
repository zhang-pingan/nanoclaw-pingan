import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  checkHistoricalCompilerContractRepair,
  R016_HISTORICAL_ROOT,
} from './compiler-contract-repair-historical.js';
import { checkHistoricalGoldenDraft } from './golden-draft-historical.js';
import {
  SHA256_HASH_PATTERN,
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import {
  assertJsonObject,
  strictParseJson,
  strictParseJsonBytes,
} from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import {
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const contractsRoot = import.meta.dirname;
const workflowRuntimeRoot = path.resolve(contractsRoot, '..');
const repoRoot = path.resolve(contractsRoot, '../../..');

export const RESOLVED_GOLDEN_DRAFT_ROOT = 'conformance/draft/resolved-g2';
export const RESOLVED_GOLDEN_DRAFT_CASES_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/golden-draft-cases@3.json`;
export const RESOLVED_GOLDEN_REVIEW_HANDOFF_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/golden-semantic-review-handoff@1.json`;
export const RESOLVED_GOLDEN_DRAFT_INVENTORY_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/artifact-inventory@1.json`;
export const RESOLVED_GOLDEN_DRAFT_MANIFEST_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/golden-draft-manifest@3.json`;

const CASES_SCHEMA_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/schemas/resolved-golden-draft-cases-schema.json`;
const HANDOFF_SCHEMA_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/schemas/golden-semantic-review-handoff-schema.json`;
const INVENTORY_SCHEMA_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/schemas/resolved-golden-draft-inventory-schema.json`;
const MANIFEST_SCHEMA_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/schemas/resolved-golden-draft-manifest-schema.json`;
const FIXTURES_SCHEMA_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/schemas/resolved-golden-draft-fixtures-schema.json`;
const POSITIVE_FIXTURES_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/contract-fixtures/positive-cases.json`;
const NEGATIVE_FIXTURES_PATH = `${RESOLVED_GOLDEN_DRAFT_ROOT}/contract-fixtures/negative-cases.json`;

const HISTORICAL_V2_CASES_PATH =
  'conformance/compiler-contract-repair/draft/golden-draft-cases@2.json';
const HISTORICAL_V2_CASES_HASH =
  'sha256:049bb1ff11a03b038f0128497511e4b10c8e70ff283a2bb70309f323a49c251b';
const HISTORICAL_V2_MANIFEST_PATH =
  'conformance/compiler-contract-repair/draft/golden-draft-manifest@2.json';
const HISTORICAL_V2_MANIFEST_HASH =
  'sha256:6b3d3e337c2486b71508f2b6d37f0ce4d2f475d24229f5b87af4f96fec8215e1';

const G2_ROOT_PATH =
  'conformance/candidate/g2/contract-pack-g2-production-compiler.json';
const G2_TOOLCHAIN_PATH =
  'conformance/candidate/g2/workflow-compiler-toolchain@2.json';
const G2_BINDING_PATH = 'conformance/candidate/g2/g2-case-input-binding@1.json';
const G2_CANDIDATE_MANIFEST_PATH =
  'conformance/candidate/g2/candidate-results-manifest@1.json';

export const G2_PRODUCTION_COMPILER_ROOT_HASH =
  'sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77';
export const G2_TOOLCHAIN_HASH =
  'sha256:8bbbdf888bc531ed135adbd3641ea5bdd8aa605e332ab7ac3ac919a45a90ef45';
export const G2_COMPILER_BUILD_HASH =
  'sha256:acfeea59ca1e8ad117642152f51043dd1c581f1153942efaded44e9dc165c7ee';
export const G2_NORMALIZER_HASH =
  'sha256:7d08408f780ca4350e153d99fd60810554daefe3826b39fe5e2fa5abee340b60';
export const G2_PROOF_ALGORITHM_HASH =
  'sha256:e1f32fc4ceec2efa7cb9c19bbf91abd0487d044fa62aee682de836c0b2c03a5b';
export const G2_CASE_INPUT_BINDING_HASH =
  'sha256:538e77e33aeb8ca684388a83ee5a5a63a1b70aaa5cacc239be5f65814e9c18dc';
export const G2_CANDIDATE_RESULTS_MANIFEST_HASH =
  'sha256:c471bcf03ea23ce2d84d5a785b026ae222ec47f7d5fd5948bb8e19c89904b1d2';

const G0_10_ROOT_PATH =
  'conformance/capacity-control-plane-addendum/contract-pack-capacity-control-plane-addendum.json';
const G0_10_ROOT_HASH =
  'sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec';
const G1_DEPENDENCY_MANIFEST_PATH =
  'store/schema/artifacts/workflow-runtime-schema-dependency-manifest@1.json';
const G1_DEPENDENCY_MANIFEST_HASH =
  'sha256:ea039f582f0ebff2fb9bc7e512825612cf8f0f93ccdd4c5e43345f56ca2b7b89';
const G1_PHYSICAL_SCHEMA_IDENTITY =
  'sha256:8c667d62f69a8c67ba1edde467562e370377342a058b6dc4673ab9a383fe05a1';
const G1_ROOT_PATH = 'store/schema/contract-pack-g1-executable-schema.json';
const G1_ROOT_HASH =
  'sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756';
const MIGRATION_PATH =
  'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v1.sql';
const MIGRATION_RAW_HASH =
  'sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61';

const HASH = `sha256:${'0'.repeat(64)}` as Sha256Hash;
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const POINTER_PATTERN = '^(?:/(?:[^~/]|~[01])*)*$';
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const TOOLCHAIN_DOMAIN = 'icarus:workflow-compiler-toolchain-manifest:1\n';
const BINDING_DOMAIN = 'icarus:workflow-compiler-g2-case-input-binding:1\n';
const CANDIDATE_MANIFEST_DOMAIN =
  'icarus:workflow-compiler-candidate-results-manifest:1\n';
const CASE_CATALOG_DOMAIN =
  'icarus:workflow-compiler-resolved-golden-draft-cases:3\n';
const HANDOFF_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review-handoff:1\n';
const INVENTORY_DOMAIN =
  'icarus:workflow-compiler-resolved-golden-draft-inventory:1\n';
const MANIFEST_DOMAIN =
  'icarus:workflow-compiler-resolved-golden-draft-manifest:3\n';

type Schema = JsonObject;

export class ResolvedGoldenDraftError extends Error {
  readonly code = 'resolved_golden_draft_contract_drift';

  constructor(message: string) {
    super(message);
    this.name = 'ResolvedGoldenDraftError';
  }
}

function schemaString(options: JsonObject = {}): Schema {
  return { type: 'string', ...options };
}

function schemaEnum(values: readonly string[]): Schema {
  return { type: 'string', enum: [...values] };
}

function schemaInteger(minimum = 0): Schema {
  return { type: 'integer', minimum, maximum: SAFE_INTEGER_MAX };
}

function schemaArray(items: Schema, options: JsonObject = {}): Schema {
  return { type: 'array', items, ...options };
}

function closedObject(
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

const nullSchema: Schema = { type: 'null' };
const hashSchema = schemaString({ pattern: SHA256_HASH_PATTERN });
const pathSchema = schemaString({
  pattern: '^[A-Za-z0-9][A-Za-z0-9.@_/-]*$',
});
const versionedRefSchema = closedObject({
  id: schemaString({ pattern: VERSIONED_REF_ID_PATTERN }),
  version: schemaString({ pattern: VERSIONED_REF_VERSION_PATTERN }),
});

function diagnosticSchema(): Schema {
  return closedObject({
    code: schemaString({ minLength: 1 }),
    phase: schemaEnum([
      'parse',
      'schema',
      'bind',
      'prove',
      'normalize',
      'hash',
    ]),
    instance_pointer: schemaString({ pattern: POINTER_PATTERN }),
    schema_pointer: nullable(schemaString({ minLength: 1 })),
    stable_object_id: nullable(schemaString({ minLength: 1 })),
    detail_ref: nullable(schemaString({ minLength: 1 })),
  });
}

function assertionSchema(): Schema {
  return closedObject({
    assertion_id: schemaString({ minLength: 1 }),
    subject_pointer: schemaString({ pattern: POINTER_PATTERN }),
    operator: schemaEnum([
      'equals',
      'set_equals',
      'ordered_equals',
      'contains',
      'present',
      'absent',
    ]),
    expected: { $ref: '#/$defs/json_value' },
    rationale: schemaString({ minLength: 1 }),
  });
}

function exactIdentitySchema(): Schema {
  return closedObject({
    production_compiler_root_ref: pathSchema,
    production_compiler_root_hash: hashSchema,
    compiler_toolchain_file_ref: pathSchema,
    compiler_toolchain_manifest_ref: versionedRefSchema,
    compiler_toolchain_hash: hashSchema,
    compiler_version: { const: '2.0.0' },
    compiler_build_hash: hashSchema,
    canonical_normalizer_version: { const: '2.0.0' },
    canonical_normalizer_hash: hashSchema,
    proof_algorithm_version: { const: '2.0.0' },
    proof_algorithm_hash: hashSchema,
    error_catalog_ref: versionedRefSchema,
    error_catalog_hash: hashSchema,
    compiled_ir_schema_ref: pathSchema,
    compiled_ir_schema_hash: hashSchema,
    conformance_result_schema_ref: pathSchema,
    conformance_result_schema_hash: hashSchema,
    case_input_binding_ref: pathSchema,
    case_input_binding_hash: hashSchema,
    candidate_results_manifest_ref: pathSchema,
    candidate_results_manifest_hash: hashSchema,
  });
}

function casesPayloadSchema(): Schema {
  const jsonValue: Schema = {
    anyOf: [
      { type: 'null' },
      { type: 'boolean' },
      { type: 'number' },
      { type: 'string' },
      { type: 'array', items: { $ref: '#/$defs/json_value' } },
      {
        type: 'object',
        additionalProperties: { $ref: '#/$defs/json_value' },
      },
    ],
  };
  const expectedOracle = closedObject({
    status: { const: 'pending_independent_human_semantic_review' },
    expected_case_result_bytes_ref: nullSchema,
    expected_case_result_hash: nullSchema,
    expected_plan_hash: nullSchema,
    expected_proof_hashes: nullSchema,
    expected_program_hashes: nullSchema,
    expected_diagnostics: nullSchema,
  });
  const actualCandidate = closedObject({
    role: { const: 'actual_compiler_output_not_golden_oracle' },
    outcome: schemaEnum(['compiled', 'rejected']),
    result_ref: pathSchema,
    result_hash: hashSchema,
    result_raw_bytes_hash: hashSchema,
  });
  const reviewInput = closedObject({
    role: { const: 'hand_authored_review_input_not_expected_oracle' },
    draft_source_hash_candidate: nullable(hashSchema),
    draft_diagnostics_candidate: schemaArray(diagnosticSchema()),
    semantic_assertions: schemaArray(assertionSchema(), { minItems: 1 }),
    authored_by: { const: 'codex:contract-repair-author' },
  });
  const caseSchema = closedObject({
    case_id: schemaString({ minLength: 1 }),
    polarity: schemaEnum(['positive', 'negative']),
    source_kind: schemaEnum([
      'graph_scope',
      'workflow_definition',
      'workflow_schema',
    ]),
    coverage_tags: schemaArray(schemaString({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    raw_source_bytes_ref: pathSchema,
    raw_source_bytes_hash: hashSchema,
    historical_input_snapshot_ref: pathSchema,
    historical_input_snapshot_hash: hashSchema,
    g2_case_input_binding_ref: { const: G2_BINDING_PATH },
    g2_case_input_binding_hash: { const: G2_CASE_INPUT_BINDING_HASH },
    effective_case_input_hash: hashSchema,
    review_input: reviewInput,
    actual_compiler_candidate: actualCandidate,
    expected_golden_oracle: expectedOracle,
    review_owner: { const: 'human:local-owner' },
    review_status: { const: 'pending_human_semantic_review' },
  });
  return {
    $schema: DRAFT_2020_12,
    $id: 'https://icarus.local/schemas/resolved-golden-draft-cases-v3',
    ...closedObject({
      format: { const: 'icarus.workflow-compiler-golden-draft-cases/3' },
      bundle_version: { const: '3.0.0-resolved-draft' },
      draft_status: {
        const: 'resolved_identity_pending_human_semantic_review',
      },
      historical_g0_8_manifest_ref: {
        const: 'contract-pack-golden-draft.json',
      },
      historical_g0_8_manifest_hash: {
        const:
          'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22',
      },
      historical_r016_draft_ref: { const: HISTORICAL_V2_MANIFEST_PATH },
      historical_r016_draft_hash: { const: HISTORICAL_V2_MANIFEST_HASH },
      exact_g2_identity: exactIdentitySchema(),
      candidate_output_disposition: {
        const: 'actual_compiler_output_not_golden_oracle',
      },
      review_input_disposition: {
        const: 'hand_authored_semantic_review_input',
      },
      expected_oracle_disposition: {
        const: 'absent_pending_independent_human_semantic_review',
      },
      assertion_target: closedObject({
        artifact_format: {
          const: 'icarus.workflow-compiler-conformance-case-result/1',
        },
        schema_ref: pathSchema,
        schema_hash: hashSchema,
        pointer_root: { const: '' },
        canonicalization: { const: 'rfc8785_jcs' },
        encoding: { const: 'utf-8' },
        canonical_bytes: {
          const: 'jcs_full_result_including_result_hash',
        },
        hash_field: { const: 'result_hash' },
        hash_preimage: { const: 'jcs_result_without_result_hash' },
        hash_domain_separator: { const: RESULT_DOMAIN },
      }),
      cases: schemaArray(caseSchema, { minItems: 40, maxItems: 40 }),
      positive_case_count: { const: 10 },
      negative_case_count: { const: 30 },
      catalog_hash: hashSchema,
    }),
    $defs: { json_value: jsonValue },
  };
}

function handoffPayloadSchema(): Schema {
  const caseHandoff = closedObject({
    case_id: schemaString({ minLength: 1 }),
    review_input_pointer: schemaString({ pattern: POINTER_PATTERN }),
    actual_candidate_result_ref: pathSchema,
    actual_candidate_result_hash: hashSchema,
    expected_oracle_pointer: schemaString({ pattern: POINTER_PATTERN }),
    review_status: { const: 'pending_human_semantic_review' },
  });
  return {
    $schema: DRAFT_2020_12,
    $id: 'https://icarus.local/schemas/golden-semantic-review-handoff-v1',
    ...closedObject({
      format: {
        const: 'icarus.workflow-compiler-golden-semantic-review-handoff/1',
      },
      handoff_version: { const: '1.0.0-resolved-draft' },
      review_owner: { const: 'human:local-owner' },
      review_decision_status: { const: 'pending_not_recorded' },
      resolved_case_catalog_ref: { const: RESOLVED_GOLDEN_DRAFT_CASES_PATH },
      resolved_case_catalog_hash: hashSchema,
      actual_candidate_manifest_ref: { const: G2_CANDIDATE_MANIFEST_PATH },
      actual_candidate_manifest_hash: {
        const: G2_CANDIDATE_RESULTS_MANIFEST_HASH,
      },
      actual_candidate_disposition: {
        const: 'comparison_input_only_not_expected_oracle',
      },
      review_input_disposition: {
        const: 'hand_authored_assertions_and_diagnostics_pending_review',
      },
      expected_oracle_status: { const: 'absent_pending_human_decision' },
      case_handoffs: schemaArray(caseHandoff, {
        minItems: 40,
        maxItems: 40,
      }),
      review_checklist: schemaArray(schemaString({ minLength: 1 }), {
        minItems: 5,
      }),
      forbidden_actions: schemaArray(schemaString({ minLength: 1 }), {
        minItems: 6,
        uniqueItems: true,
      }),
      golden_semantic_review_record_ref: nullSchema,
      golden_semantic_review_record_hash: nullSchema,
      approval_status: { const: 'not_run' },
      golden_seal_status: { const: 'not_run' },
      conformance_sealed_write_status: { const: 'not_run' },
      handoff_hash: hashSchema,
    }),
  };
}

function inventoryPayloadSchema(): Schema {
  const entry = closedObject({
    path: pathSchema,
    role: schemaEnum([
      'schema',
      'case_catalog',
      'semantic_review_handoff',
      'positive_fixture',
      'negative_fixture',
    ]),
    format: schemaString({ minLength: 1 }),
    ref: versionedRefSchema,
    version: schemaInteger(1),
    domain_separator: schemaString({ minLength: 1 }),
    artifact_hash: hashSchema,
    raw_bytes_hash: hashSchema,
    byte_length: schemaInteger(1),
  });
  return {
    $schema: DRAFT_2020_12,
    $id: 'https://icarus.local/schemas/resolved-golden-draft-inventory-v1',
    ...closedObject({
      format: {
        const: 'icarus.workflow-compiler-resolved-golden-draft-inventory/1',
      },
      inventory_version: { const: '1.0.0' },
      entries: schemaArray(entry, { minItems: 1 }),
      entry_count: schemaInteger(1),
      inventory_hash: hashSchema,
    }),
  };
}

function manifestPayloadSchema(): Schema {
  return {
    $schema: DRAFT_2020_12,
    $id: 'https://icarus.local/schemas/resolved-golden-draft-manifest-v3',
    ...closedObject({
      format: { const: 'icarus.workflow-compiler-golden-draft-manifest/3' },
      bundle_version: { const: '3.0.0-resolved-draft' },
      draft_status: { const: 'published_pending_human_semantic_review' },
      exact_g2_identity_status: { const: 'resolved' },
      resolved_case_catalog_ref: { const: RESOLVED_GOLDEN_DRAFT_CASES_PATH },
      resolved_case_catalog_hash: hashSchema,
      semantic_review_handoff_ref: {
        const: RESOLVED_GOLDEN_REVIEW_HANDOFF_PATH,
      },
      semantic_review_handoff_hash: hashSchema,
      artifact_inventory_ref: { const: RESOLVED_GOLDEN_DRAFT_INVENTORY_PATH },
      artifact_inventory_hash: hashSchema,
      inventory_member_count: schemaInteger(1),
      generated_artifact_count: schemaInteger(1),
      generated_by_tool_hash: hashSchema,
      exact_g2_identity: exactIdentitySchema(),
      frozen_baselines: closedObject({
        g0_10_root_hash: { const: G0_10_ROOT_HASH },
        g1_dependency_manifest_hash: { const: G1_DEPENDENCY_MANIFEST_HASH },
        g1_physical_schema_identity: { const: G1_PHYSICAL_SCHEMA_IDENTITY },
        g1_root_hash: { const: G1_ROOT_HASH },
        sqlite_migration_raw_hash: { const: MIGRATION_RAW_HASH },
        historical_g0_8_root_hash: {
          const:
            'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22',
        },
        historical_r016_root_hash: { const: R016_HISTORICAL_ROOT },
      }),
      actual_candidate_output_status: { const: 'bound_review_comparison_only' },
      review_input_status: { const: 'published_pending_human_review' },
      expected_golden_oracle_status: { const: 'absent' },
      golden_semantic_review_status: { const: 'pending_not_run' },
      approval_status: { const: 'not_run' },
      golden_seal_status: { const: 'not_run' },
      conformance_sealed_write_status: { const: 'not_run' },
      g3_through_g9_status: { const: 'not_started' },
      positive_case_count: { const: 10 },
      negative_case_count: { const: 30 },
      manifest_hash: hashSchema,
    }),
  };
}

export const RESOLVED_GOLDEN_DRAFT_NEGATIVE_MUTATIONS = [
  'candidate_disposition_promoted_to_oracle',
  'candidate_result_copied_to_expected',
  'draft_diagnostics_copied_to_expected',
  'review_marked_approved',
  'golden_semantic_review_record_injected',
  'toolchain_hash_drift',
  'compiler_build_hash_drift',
  'normalizer_hash_drift',
  'proof_hash_drift',
  'case_input_binding_hash_drift',
  'candidate_manifest_hash_drift',
  'candidate_result_hash_drift',
  'effective_case_input_hash_drift',
  'case_removed',
  'case_duplicated',
  'handoff_case_removed',
  'inventory_member_removed',
  'inventory_raw_hash_drift',
  'seal_marked_complete',
  'g3_marked_started',
] as const;

type NegativeMutation =
  (typeof RESOLVED_GOLDEN_DRAFT_NEGATIVE_MUTATIONS)[number];

function fixturesPayloadSchema(): Schema {
  const positive = closedObject({
    case_id: schemaString({ minLength: 1 }),
    assertion: schemaString({ minLength: 1 }),
  });
  const negative = closedObject({
    case_id: schemaString({ minLength: 1 }),
    mutation: schemaEnum(RESOLVED_GOLDEN_DRAFT_NEGATIVE_MUTATIONS),
    expected_error_code: {
      const: 'resolved_golden_draft_contract_drift',
    },
  });
  return {
    $schema: DRAFT_2020_12,
    $id: 'https://icarus.local/schemas/resolved-golden-draft-fixtures-v1',
    oneOf: [
      closedObject({
        format: {
          const:
            'icarus.workflow-compiler-resolved-golden-draft-positive-cases/1',
        },
        cases: schemaArray(positive, { minItems: 1 }),
        case_count: schemaInteger(1),
      }),
      closedObject({
        format: {
          const:
            'icarus.workflow-compiler-resolved-golden-draft-negative-cases/1',
        },
        cases: schemaArray(negative, { minItems: 1 }),
        case_count: schemaInteger(1),
      }),
    ],
  };
}

function contractPath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new ResolvedGoldenDraftError(
      `Contract path escapes root: ${relativePath}`,
    );
  }
  return absolute;
}

function runtimePath(relativePath: string): string {
  const absolute = path.resolve(workflowRuntimeRoot, relativePath);
  if (!absolute.startsWith(`${workflowRuntimeRoot}${path.sep}`)) {
    throw new ResolvedGoldenDraftError(
      `Workflow Runtime path escapes root: ${relativePath}`,
    );
  }
  return absolute;
}

function readJsonObject(absolutePath: string): JsonObject {
  const value = strictParseJsonBytes(fs.readFileSync(absolutePath));
  assertJsonObject(value);
  return value;
}

function readContractObject(relativePath: string): JsonObject {
  return readJsonObject(contractPath(relativePath));
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(contractPath(relativePath))),
  );
}

function readRuntimeArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(runtimePath(relativePath))),
  );
}

function requireObject(
  value: JsonValue | undefined,
  label: string,
): JsonObject {
  try {
    assertJsonObject(value);
  } catch {
    throw new ResolvedGoldenDraftError(`${label} must be an object`);
  }
  return value;
}

function requireArray(
  value: JsonValue | undefined,
  label: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new ResolvedGoldenDraftError(`${label} must be an array`);
  }
  return value;
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') {
    throw new ResolvedGoldenDraftError(`${label} must be a string`);
  }
  return value;
}

function cloneObject(value: JsonObject): JsonObject {
  const clone = strictParseJson(JSON.stringify(value));
  assertJsonObject(clone);
  return clone;
}

function rawSha256(bytes: Uint8Array | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function renderJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createArtifact(
  format: string,
  id: string,
  version: number,
  refVersion: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format,
    ref: { id, version: refVersion },
    version,
    domain_separator: domainSeparator,
    hash: HASH,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function semanticHash(
  object: JsonObject,
  field: string,
  domain: string,
): Sha256Hash {
  const withoutHash = { ...object };
  delete withoutHash[field];
  return domainSeparatedSha256(domain, withoutHash);
}

interface PinnedInputs {
  exactIdentity: JsonObject;
  assertionTarget: JsonObject;
  repairCases: JsonObject[];
  bindingCases: Map<string, JsonObject>;
  candidateResults: Map<string, JsonObject>;
}

function validateFrozenBaselines(): void {
  const historicalG0 = checkHistoricalGoldenDraft();
  if (
    historicalG0.hash !==
    'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22'
  ) {
    throw new ResolvedGoldenDraftError('Historical G0.8 root drift');
  }
  checkHistoricalCompilerContractRepair();
  if (readArtifact(G0_10_ROOT_PATH).hash !== G0_10_ROOT_HASH) {
    throw new ResolvedGoldenDraftError('G0.10 root drift');
  }
  const dependency = readRuntimeArtifact(G1_DEPENDENCY_MANIFEST_PATH);
  if (dependency.hash !== G1_DEPENDENCY_MANIFEST_HASH) {
    throw new ResolvedGoldenDraftError('G1 dependency manifest drift');
  }
  if (
    dependency.payload.physical_schema_identity !== G1_PHYSICAL_SCHEMA_IDENTITY
  ) {
    throw new ResolvedGoldenDraftError('G1 physical schema identity drift');
  }
  if (readRuntimeArtifact(G1_ROOT_PATH).hash !== G1_ROOT_HASH) {
    throw new ResolvedGoldenDraftError('G1 root drift');
  }
  if (
    rawSha256(fs.readFileSync(path.resolve(repoRoot, MIGRATION_PATH))) !==
    MIGRATION_RAW_HASH
  ) {
    throw new ResolvedGoldenDraftError('SQLite migration bytes drift');
  }
}

function loadPinnedInputs(): PinnedInputs {
  validateFrozenBaselines();
  const repairCasesArtifact = readArtifact(HISTORICAL_V2_CASES_PATH);
  const repairManifestArtifact = readArtifact(HISTORICAL_V2_MANIFEST_PATH);
  if (
    repairCasesArtifact.hash !== HISTORICAL_V2_CASES_HASH ||
    repairManifestArtifact.hash !== HISTORICAL_V2_MANIFEST_HASH
  ) {
    throw new ResolvedGoldenDraftError('R-016 Draft v2 identity drift');
  }
  const productionRoot = readArtifact(G2_ROOT_PATH);
  if (productionRoot.hash !== G2_PRODUCTION_COMPILER_ROOT_HASH) {
    throw new ResolvedGoldenDraftError('G2 Production Compiler root drift');
  }

  const toolchain = readContractObject(G2_TOOLCHAIN_PATH);
  const binding = readContractObject(G2_BINDING_PATH);
  const candidateManifest = readContractObject(G2_CANDIDATE_MANIFEST_PATH);
  if (
    semanticHash(toolchain, 'toolchain_hash', TOOLCHAIN_DOMAIN) !==
      G2_TOOLCHAIN_HASH ||
    toolchain.toolchain_hash !== G2_TOOLCHAIN_HASH
  ) {
    throw new ResolvedGoldenDraftError('G2 toolchain identity drift');
  }
  if (
    semanticHash(binding, 'binding_hash', BINDING_DOMAIN) !==
      G2_CASE_INPUT_BINDING_HASH ||
    binding.binding_hash !== G2_CASE_INPUT_BINDING_HASH
  ) {
    throw new ResolvedGoldenDraftError('G2 case-input binding drift');
  }
  if (
    semanticHash(
      candidateManifest,
      'manifest_hash',
      CANDIDATE_MANIFEST_DOMAIN,
    ) !== G2_CANDIDATE_RESULTS_MANIFEST_HASH ||
    candidateManifest.manifest_hash !== G2_CANDIDATE_RESULTS_MANIFEST_HASH
  ) {
    throw new ResolvedGoldenDraftError('G2 candidate manifest drift');
  }

  const compilerBuild = requireObject(
    toolchain.compiler_build,
    'toolchain.compiler_build',
  );
  const normalizer = requireObject(
    toolchain.canonical_normalizer,
    'toolchain.canonical_normalizer',
  );
  const proof = requireObject(
    toolchain.proof_algorithm,
    'toolchain.proof_algorithm',
  );
  if (
    compilerBuild.implementation_hash !== G2_COMPILER_BUILD_HASH ||
    normalizer.implementation_hash !== G2_NORMALIZER_HASH ||
    proof.implementation_hash !== G2_PROOF_ALGORITHM_HASH
  ) {
    throw new ResolvedGoldenDraftError(
      'G2 compiler/normalizer/proof identity drift',
    );
  }
  if (
    candidateManifest.disposition !==
      'actual_compiler_output_not_golden_oracle' ||
    candidateManifest.compiled_count !== 10 ||
    candidateManifest.rejected_count !== 30
  ) {
    throw new ResolvedGoldenDraftError('G2 candidate disposition/count drift');
  }

  const exactIdentity: JsonObject = {
    production_compiler_root_ref: G2_ROOT_PATH,
    production_compiler_root_hash: productionRoot.hash,
    compiler_toolchain_file_ref: G2_TOOLCHAIN_PATH,
    compiler_toolchain_manifest_ref: toolchain.ref as JsonValue,
    compiler_toolchain_hash: toolchain.toolchain_hash as JsonValue,
    compiler_version: toolchain.compiler_version as JsonValue,
    compiler_build_hash: compilerBuild.implementation_hash as JsonValue,
    canonical_normalizer_version: normalizer.version as JsonValue,
    canonical_normalizer_hash: normalizer.implementation_hash as JsonValue,
    proof_algorithm_version: proof.version as JsonValue,
    proof_algorithm_hash: proof.implementation_hash as JsonValue,
    error_catalog_ref: toolchain.error_catalog_ref as JsonValue,
    error_catalog_hash: toolchain.error_catalog_hash as JsonValue,
    compiled_ir_schema_ref: toolchain.compiled_ir_schema_ref as JsonValue,
    compiled_ir_schema_hash: toolchain.compiled_ir_schema_hash as JsonValue,
    conformance_result_schema_ref:
      toolchain.conformance_result_schema_ref as JsonValue,
    conformance_result_schema_hash:
      toolchain.conformance_result_schema_hash as JsonValue,
    case_input_binding_ref: G2_BINDING_PATH,
    case_input_binding_hash: binding.binding_hash as JsonValue,
    candidate_results_manifest_ref: G2_CANDIDATE_MANIFEST_PATH,
    candidate_results_manifest_hash:
      candidateManifest.manifest_hash as JsonValue,
  };

  const repairCases = requireArray(
    repairCasesArtifact.payload.cases,
    'R-016 Draft v2 cases',
  ).map((value, index) => requireObject(value, `R-016 case ${index}`));
  const assertionTarget = requireObject(
    repairCasesArtifact.payload.assertion_target,
    'R-016 assertion target',
  );
  const bindingCases = new Map<string, JsonObject>();
  for (const value of requireArray(binding.case_inputs, 'G2 binding cases')) {
    const entry = requireObject(value, 'G2 binding case');
    bindingCases.set(requireString(entry.case_id, 'binding case id'), entry);
  }
  const candidateResults = new Map<string, JsonObject>();
  for (const value of requireArray(
    candidateManifest.case_results,
    'G2 candidate results',
  )) {
    const entry = requireObject(value, 'G2 candidate result entry');
    const caseId = requireString(entry.case_id, 'candidate case id');
    const resultRef = requireString(entry.result_ref, 'candidate result ref');
    const resultBytes = fs.readFileSync(contractPath(resultRef));
    if (rawSha256(resultBytes) !== entry.result_raw_bytes_hash) {
      throw new ResolvedGoldenDraftError(
        `Candidate raw bytes drift: ${caseId}`,
      );
    }
    const result = readJsonObject(contractPath(resultRef));
    if (
      result.case_id !== caseId ||
      result.outcome !== entry.outcome ||
      result.result_hash !== entry.result_hash ||
      semanticHash(result, 'result_hash', RESULT_DOMAIN) !== entry.result_hash
    ) {
      throw new ResolvedGoldenDraftError(`Candidate result drift: ${caseId}`);
    }
    candidateResults.set(caseId, entry);
  }
  if (
    repairCases.length !== 40 ||
    bindingCases.size !== 40 ||
    candidateResults.size !== 40
  ) {
    throw new ResolvedGoldenDraftError('Resolved Draft case coverage drift');
  }
  return {
    exactIdentity,
    assertionTarget,
    repairCases,
    bindingCases,
    candidateResults,
  };
}

function buildCasesArtifact(inputs: PinnedInputs): ContractArtifactEnvelope {
  const cases = inputs.repairCases.map((repairCase) => {
    const caseId = requireString(repairCase.case_id, 'repair case id');
    const binding = inputs.bindingCases.get(caseId);
    const candidate = inputs.candidateResults.get(caseId);
    if (!binding || !candidate) {
      throw new ResolvedGoldenDraftError(`Missing resolved input: ${caseId}`);
    }
    if (
      repairCase.raw_source_bytes_ref !== binding.raw_source_bytes_ref ||
      repairCase.raw_source_bytes_hash !== binding.raw_source_bytes_hash ||
      repairCase.historical_input_snapshot_ref !==
        binding.historical_input_snapshot_ref ||
      repairCase.historical_input_snapshot_hash !==
        binding.historical_input_snapshot_hash
    ) {
      throw new ResolvedGoldenDraftError(
        `Case input identity drift: ${caseId}`,
      );
    }
    return {
      case_id: caseId,
      polarity: repairCase.polarity,
      source_kind: repairCase.source_kind,
      coverage_tags: repairCase.coverage_tags,
      raw_source_bytes_ref: repairCase.raw_source_bytes_ref,
      raw_source_bytes_hash: repairCase.raw_source_bytes_hash,
      historical_input_snapshot_ref: repairCase.historical_input_snapshot_ref,
      historical_input_snapshot_hash: repairCase.historical_input_snapshot_hash,
      g2_case_input_binding_ref: G2_BINDING_PATH,
      g2_case_input_binding_hash: G2_CASE_INPUT_BINDING_HASH,
      effective_case_input_hash: binding.effective_case_input_hash,
      review_input: {
        role: 'hand_authored_review_input_not_expected_oracle',
        draft_source_hash_candidate: repairCase.expected_source_hash,
        draft_diagnostics_candidate: repairCase.expected_diagnostics,
        semantic_assertions: repairCase.semantic_assertions,
        authored_by: 'codex:contract-repair-author',
      },
      actual_compiler_candidate: {
        role: 'actual_compiler_output_not_golden_oracle',
        outcome: candidate.outcome,
        result_ref: candidate.result_ref,
        result_hash: candidate.result_hash,
        result_raw_bytes_hash: candidate.result_raw_bytes_hash,
      },
      expected_golden_oracle: {
        status: 'pending_independent_human_semantic_review',
        expected_case_result_bytes_ref: null,
        expected_case_result_hash: null,
        expected_plan_hash: null,
        expected_proof_hashes: null,
        expected_program_hashes: null,
        expected_diagnostics: null,
      },
      review_owner: 'human:local-owner',
      review_status: 'pending_human_semantic_review',
    } as JsonObject;
  });
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-golden-draft-cases/3',
    bundle_version: '3.0.0-resolved-draft',
    draft_status: 'resolved_identity_pending_human_semantic_review',
    historical_g0_8_manifest_ref: 'contract-pack-golden-draft.json',
    historical_g0_8_manifest_hash:
      'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22',
    historical_r016_draft_ref: HISTORICAL_V2_MANIFEST_PATH,
    historical_r016_draft_hash: HISTORICAL_V2_MANIFEST_HASH,
    exact_g2_identity: inputs.exactIdentity,
    candidate_output_disposition: 'actual_compiler_output_not_golden_oracle',
    review_input_disposition: 'hand_authored_semantic_review_input',
    expected_oracle_disposition:
      'absent_pending_independent_human_semantic_review',
    assertion_target: inputs.assertionTarget,
    cases,
    positive_case_count: 10,
    negative_case_count: 30,
  };
  const payload = {
    ...withoutHash,
    catalog_hash: domainSeparatedSha256(CASE_CATALOG_DOMAIN, withoutHash),
  };
  return createArtifact(
    'icarus.workflow-compiler-golden-draft-cases/3',
    'icarus.workflow-compiler-golden-draft-cases',
    3,
    '3.0.0',
    'icarus:workflow-compiler-golden-draft-cases-artifact:3\n',
    payload,
  );
}

function buildHandoffArtifact(
  casesArtifact: ContractArtifactEnvelope,
): ContractArtifactEnvelope {
  const cases = requireArray(casesArtifact.payload.cases, 'resolved cases');
  const caseHandoffs = cases.map((value, index) => {
    const entry = requireObject(value, `resolved case ${index}`);
    const actual = requireObject(
      entry.actual_compiler_candidate,
      `actual candidate ${index}`,
    );
    return {
      case_id: entry.case_id,
      review_input_pointer: `/cases/${index}/review_input`,
      actual_candidate_result_ref: actual.result_ref,
      actual_candidate_result_hash: actual.result_hash,
      expected_oracle_pointer: `/cases/${index}/expected_golden_oracle`,
      review_status: 'pending_human_semantic_review',
    } as JsonObject;
  });
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-golden-semantic-review-handoff/1',
    handoff_version: '1.0.0-resolved-draft',
    review_owner: 'human:local-owner',
    review_decision_status: 'pending_not_recorded',
    resolved_case_catalog_ref: RESOLVED_GOLDEN_DRAFT_CASES_PATH,
    resolved_case_catalog_hash: casesArtifact.hash,
    actual_candidate_manifest_ref: G2_CANDIDATE_MANIFEST_PATH,
    actual_candidate_manifest_hash: G2_CANDIDATE_RESULTS_MANIFEST_HASH,
    actual_candidate_disposition: 'comparison_input_only_not_expected_oracle',
    review_input_disposition:
      'hand_authored_assertions_and_diagnostics_pending_review',
    expected_oracle_status: 'absent_pending_human_decision',
    case_handoffs: caseHandoffs,
    review_checklist: [
      'Verify each raw source and historical snapshot against its exact effective G2 case-input identity.',
      'Review hand-authored assertions and diagnostic candidates against the machine Contract and architecture semantics.',
      'Treat actual Production Compiler results only as comparison input, never as expected oracle bytes.',
      'Author any expected case-result bytes independently before comparing them with actual Compiler output.',
      'Record approved or changes_requested only in a later immutable GoldenSemanticReview owned by human:local-owner.',
      'Require complete 40-case coverage before any later seal attempt.',
    ],
    forbidden_actions: [
      'copy_actual_candidate_bytes_into_expected_oracle',
      'derive_expected_plan_from_production_compiler',
      'record_ai_or_compiler_approval',
      'run_golden_seal',
      'write_conformance_sealed',
      'start_g3_or_later_gate',
    ],
    golden_semantic_review_record_ref: null,
    golden_semantic_review_record_hash: null,
    approval_status: 'not_run',
    golden_seal_status: 'not_run',
    conformance_sealed_write_status: 'not_run',
  };
  return createArtifact(
    'icarus.workflow-compiler-golden-semantic-review-handoff/1',
    'icarus.workflow-compiler-golden-semantic-review-handoff',
    1,
    '1.0.0',
    'icarus:workflow-compiler-golden-semantic-review-handoff-artifact:1\n',
    {
      ...withoutHash,
      handoff_hash: domainSeparatedSha256(HANDOFF_DOMAIN, withoutHash),
    },
  );
}

function buildSchemaArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const entries: Array<[string, string, string, Schema]> = [
    [
      CASES_SCHEMA_PATH,
      'icarus.workflow-compiler-resolved-golden-draft-cases-schema/1',
      'icarus.workflow-compiler-resolved-golden-draft-cases-schema',
      casesPayloadSchema(),
    ],
    [
      HANDOFF_SCHEMA_PATH,
      'icarus.workflow-compiler-golden-semantic-review-handoff-schema/1',
      'icarus.workflow-compiler-golden-semantic-review-handoff-schema',
      handoffPayloadSchema(),
    ],
    [
      INVENTORY_SCHEMA_PATH,
      'icarus.workflow-compiler-resolved-golden-draft-inventory-schema/1',
      'icarus.workflow-compiler-resolved-golden-draft-inventory-schema',
      inventoryPayloadSchema(),
    ],
    [
      MANIFEST_SCHEMA_PATH,
      'icarus.workflow-compiler-resolved-golden-draft-manifest-schema/1',
      'icarus.workflow-compiler-resolved-golden-draft-manifest-schema',
      manifestPayloadSchema(),
    ],
    [
      FIXTURES_SCHEMA_PATH,
      'icarus.workflow-compiler-resolved-golden-draft-fixtures-schema/1',
      'icarus.workflow-compiler-resolved-golden-draft-fixtures-schema',
      fixturesPayloadSchema(),
    ],
  ];
  return entries.map(([artifactPath, format, id, payload]) => [
    artifactPath,
    createArtifact(
      format,
      id,
      1,
      '1.0.0',
      `icarus:${id.replace(/^icarus\./, '').replaceAll('.', '-')}:1\n`,
      payload,
    ),
  ]);
}

const POSITIVE_CASES = [
  {
    case_id: 'exact-g2-identity-resolved',
    assertion:
      'All Compiler/toolchain/build/normalizer/proof/input/candidate identities are exact and non-placeholder.',
  },
  {
    case_id: 'three-way-artifact-separation',
    assertion:
      'Actual Compiler output, hand-authored review input, and expected Golden oracle are separate closed objects.',
  },
  {
    case_id: 'human-review-pending',
    assertion:
      'All 40 cases are pending semantic review by human:local-owner and no decision is recorded.',
  },
  {
    case_id: 'expected-oracle-absent',
    assertion:
      'Every expected Golden result/Plan/proof/program/diagnostic field is null.',
  },
  {
    case_id: 'historical-and-downstream-boundaries',
    assertion:
      'Historical v1/v2 remain frozen, sealed contains only .gitkeep, and G3+ remains absent.',
  },
] as const;

const NEGATIVE_CASES = RESOLVED_GOLDEN_DRAFT_NEGATIVE_MUTATIONS.map(
  (mutation) => ({
    case_id: `negative.${mutation.replaceAll('_', '-')}`,
    mutation,
    expected_error_code: 'resolved_golden_draft_contract_drift',
  }),
);

function buildFixtureArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  return [
    [
      POSITIVE_FIXTURES_PATH,
      createArtifact(
        'icarus.workflow-compiler-resolved-golden-draft-positive-cases/1',
        'icarus.workflow-compiler-resolved-golden-draft-positive-cases',
        1,
        '1.0.0',
        'icarus:workflow-compiler-resolved-golden-draft-positive-cases-artifact:1\n',
        {
          format:
            'icarus.workflow-compiler-resolved-golden-draft-positive-cases/1',
          cases: POSITIVE_CASES.map((entry) => ({ ...entry })),
          case_count: POSITIVE_CASES.length,
        },
      ),
    ],
    [
      NEGATIVE_FIXTURES_PATH,
      createArtifact(
        'icarus.workflow-compiler-resolved-golden-draft-negative-cases/1',
        'icarus.workflow-compiler-resolved-golden-draft-negative-cases',
        1,
        '1.0.0',
        'icarus:workflow-compiler-resolved-golden-draft-negative-cases-artifact:1\n',
        {
          format:
            'icarus.workflow-compiler-resolved-golden-draft-negative-cases/1',
          cases: NEGATIVE_CASES.map((entry) => ({ ...entry })),
          case_count: NEGATIVE_CASES.length,
        },
      ),
    ],
  ];
}

function artifactRole(relativePath: string): string {
  if (relativePath.includes('/schemas/')) return 'schema';
  if (relativePath === RESOLVED_GOLDEN_DRAFT_CASES_PATH) return 'case_catalog';
  if (relativePath === RESOLVED_GOLDEN_REVIEW_HANDOFF_PATH)
    return 'semantic_review_handoff';
  if (relativePath === POSITIVE_FIXTURES_PATH) return 'positive_fixture';
  if (relativePath === NEGATIVE_FIXTURES_PATH) return 'negative_fixture';
  throw new ResolvedGoldenDraftError(`Unknown inventory role: ${relativePath}`);
}

function buildInventoryArtifact(
  leafArtifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const entries = leafArtifacts
    .map(([relativePath, artifact]) => {
      const bytes = renderJson(artifact);
      return {
        path: relativePath,
        role: artifactRole(relativePath),
        format: artifact.format,
        ref: artifact.ref,
        version: artifact.version,
        domain_separator: artifact.domain_separator,
        artifact_hash: artifact.hash,
        raw_bytes_hash: rawSha256(bytes),
        byte_length: Buffer.byteLength(bytes, 'utf8'),
      } as JsonObject;
    })
    .sort((left, right) =>
      String(left.path).localeCompare(String(right.path), 'en'),
    );
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-resolved-golden-draft-inventory/1',
    inventory_version: '1.0.0',
    entries,
    entry_count: entries.length,
  };
  return createArtifact(
    'icarus.workflow-compiler-resolved-golden-draft-inventory/1',
    'icarus.workflow-compiler-resolved-golden-draft-inventory',
    1,
    '1.0.0',
    'icarus:workflow-compiler-resolved-golden-draft-inventory-artifact:1\n',
    {
      ...withoutHash,
      inventory_hash: domainSeparatedSha256(INVENTORY_DOMAIN, withoutHash),
    },
  );
}

export function resolvedGoldenDraftGeneratorHash(): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-compiler-resolved-golden-draft-generator:1\n',
    {
      source_ref: 'src/workflow-runtime/contracts/resolved-golden-draft.ts',
      source_raw_sha256: rawSha256(fs.readFileSync(import.meta.filename)),
    },
  );
}

function buildManifestArtifact(
  inputs: PinnedInputs,
  casesArtifact: ContractArtifactEnvelope,
  handoffArtifact: ContractArtifactEnvelope,
  inventoryArtifact: ContractArtifactEnvelope,
  generatedArtifactCount: number,
): ContractArtifactEnvelope {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-golden-draft-manifest/3',
    bundle_version: '3.0.0-resolved-draft',
    draft_status: 'published_pending_human_semantic_review',
    exact_g2_identity_status: 'resolved',
    resolved_case_catalog_ref: RESOLVED_GOLDEN_DRAFT_CASES_PATH,
    resolved_case_catalog_hash: casesArtifact.hash,
    semantic_review_handoff_ref: RESOLVED_GOLDEN_REVIEW_HANDOFF_PATH,
    semantic_review_handoff_hash: handoffArtifact.hash,
    artifact_inventory_ref: RESOLVED_GOLDEN_DRAFT_INVENTORY_PATH,
    artifact_inventory_hash: inventoryArtifact.hash,
    inventory_member_count: inventoryArtifact.payload.entry_count,
    generated_artifact_count: generatedArtifactCount,
    generated_by_tool_hash: resolvedGoldenDraftGeneratorHash(),
    exact_g2_identity: inputs.exactIdentity,
    frozen_baselines: {
      g0_10_root_hash: G0_10_ROOT_HASH,
      g1_dependency_manifest_hash: G1_DEPENDENCY_MANIFEST_HASH,
      g1_physical_schema_identity: G1_PHYSICAL_SCHEMA_IDENTITY,
      g1_root_hash: G1_ROOT_HASH,
      sqlite_migration_raw_hash: MIGRATION_RAW_HASH,
      historical_g0_8_root_hash:
        'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22',
      historical_r016_root_hash: R016_HISTORICAL_ROOT,
    },
    actual_candidate_output_status: 'bound_review_comparison_only',
    review_input_status: 'published_pending_human_review',
    expected_golden_oracle_status: 'absent',
    golden_semantic_review_status: 'pending_not_run',
    approval_status: 'not_run',
    golden_seal_status: 'not_run',
    conformance_sealed_write_status: 'not_run',
    g3_through_g9_status: 'not_started',
    positive_case_count: 10,
    negative_case_count: 30,
  };
  return createArtifact(
    'icarus.workflow-compiler-golden-draft-manifest/3',
    'icarus.workflow-compiler-golden-draft-manifest',
    3,
    '3.0.0',
    'icarus:workflow-compiler-golden-draft-manifest-artifact:3\n',
    {
      ...withoutHash,
      manifest_hash: domainSeparatedSha256(MANIFEST_DOMAIN, withoutHash),
    },
  );
}

interface BuiltResolvedDraft {
  inputs: PinnedInputs;
  artifacts: Array<[string, ContractArtifactEnvelope]>;
  casesArtifact: ContractArtifactEnvelope;
  handoffArtifact: ContractArtifactEnvelope;
  inventoryArtifact: ContractArtifactEnvelope;
  manifestArtifact: ContractArtifactEnvelope;
}

function buildResolvedDraft(): BuiltResolvedDraft {
  const inputs = loadPinnedInputs();
  const schemaArtifacts = buildSchemaArtifacts();
  const casesArtifact = buildCasesArtifact(inputs);
  const handoffArtifact = buildHandoffArtifact(casesArtifact);
  const fixtureArtifacts = buildFixtureArtifacts();
  const leafArtifacts: Array<[string, ContractArtifactEnvelope]> = [
    ...schemaArtifacts,
    [RESOLVED_GOLDEN_DRAFT_CASES_PATH, casesArtifact] as [
      string,
      ContractArtifactEnvelope,
    ],
    [RESOLVED_GOLDEN_REVIEW_HANDOFF_PATH, handoffArtifact] as [
      string,
      ContractArtifactEnvelope,
    ],
    ...fixtureArtifacts,
  ];
  leafArtifacts.sort(([left], [right]) => left.localeCompare(right, 'en'));
  const inventoryArtifact = buildInventoryArtifact(leafArtifacts);
  const generatedArtifactCount = leafArtifacts.length + 2;
  const manifestArtifact = buildManifestArtifact(
    inputs,
    casesArtifact,
    handoffArtifact,
    inventoryArtifact,
    generatedArtifactCount,
  );
  const artifacts = [
    ...leafArtifacts,
    [RESOLVED_GOLDEN_DRAFT_INVENTORY_PATH, inventoryArtifact] as [
      string,
      ContractArtifactEnvelope,
    ],
    [RESOLVED_GOLDEN_DRAFT_MANIFEST_PATH, manifestArtifact] as [
      string,
      ContractArtifactEnvelope,
    ],
  ].sort(([left], [right]) => left.localeCompare(right, 'en'));
  return {
    inputs,
    artifacts,
    casesArtifact,
    handoffArtifact,
    inventoryArtifact,
    manifestArtifact,
  };
}

function artifactByFormat(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  format: string,
): ContractArtifactEnvelope {
  const artifact = artifacts.find(([, value]) => value.format === format)?.[1];
  if (!artifact) {
    throw new ResolvedGoldenDraftError(`Missing artifact format: ${format}`);
  }
  return artifact;
}

function compileValidators(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const schemaTargets: Array<[string, string]> = [
    [
      'icarus.workflow-compiler-golden-draft-cases/3',
      'icarus.workflow-compiler-resolved-golden-draft-cases-schema/1',
    ],
    [
      'icarus.workflow-compiler-golden-semantic-review-handoff/1',
      'icarus.workflow-compiler-golden-semantic-review-handoff-schema/1',
    ],
    [
      'icarus.workflow-compiler-resolved-golden-draft-inventory/1',
      'icarus.workflow-compiler-resolved-golden-draft-inventory-schema/1',
    ],
    [
      'icarus.workflow-compiler-golden-draft-manifest/3',
      'icarus.workflow-compiler-resolved-golden-draft-manifest-schema/1',
    ],
    [
      'icarus.workflow-compiler-resolved-golden-draft-positive-cases/1',
      'icarus.workflow-compiler-resolved-golden-draft-fixtures-schema/1',
    ],
    [
      'icarus.workflow-compiler-resolved-golden-draft-negative-cases/1',
      'icarus.workflow-compiler-resolved-golden-draft-fixtures-schema/1',
    ],
  ];
  const validators = new Map<string, ValidateFunction>();
  for (const [, schemaFormat] of schemaTargets) {
    const schemaArtifact = artifactByFormat(artifacts, schemaFormat);
    ajv.compile(schemaArtifact.payload as AnySchema);
  }
  for (const [targetFormat, schemaFormat] of schemaTargets) {
    validators.set(
      targetFormat,
      ajv.compile(
        artifactByFormat(artifacts, schemaFormat).payload as AnySchema,
      ),
    );
  }
  return validators;
}

interface DraftState {
  cases: JsonObject;
  handoff: JsonObject;
  inventory: JsonObject;
  manifest: JsonObject;
}

function stateFromBuild(build: BuiltResolvedDraft): DraftState {
  return {
    cases: cloneObject(build.casesArtifact.payload),
    handoff: cloneObject(build.handoffArtifact.payload),
    inventory: cloneObject(build.inventoryArtifact.payload),
    manifest: cloneObject(build.manifestArtifact.payload),
  };
}

function validateWithSchema(
  state: DraftState,
  validators: Map<string, ValidateFunction>,
): void {
  const values: Array<[string, JsonObject]> = [
    ['icarus.workflow-compiler-golden-draft-cases/3', state.cases],
    [
      'icarus.workflow-compiler-golden-semantic-review-handoff/1',
      state.handoff,
    ],
    [
      'icarus.workflow-compiler-resolved-golden-draft-inventory/1',
      state.inventory,
    ],
    ['icarus.workflow-compiler-golden-draft-manifest/3', state.manifest],
  ];
  for (const [format, value] of values) {
    const validate = validators.get(format)!;
    if (!validate(value)) {
      throw new ResolvedGoldenDraftError(
        `${format} closed schema failure: ${JSON.stringify(validate.errors)}`,
      );
    }
  }
}

function assertCanonicalEqual(
  actual: JsonValue,
  expected: JsonValue,
  label: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ResolvedGoldenDraftError(`${label} drift`);
  }
}

function validateState(
  state: DraftState,
  build: BuiltResolvedDraft,
  validators: Map<string, ValidateFunction>,
): void {
  validateWithSchema(state, validators);
  assertCanonicalEqual(
    state.cases.exact_g2_identity as JsonValue,
    build.inputs.exactIdentity,
    'Resolved cases exact G2 identity',
  );
  assertCanonicalEqual(
    state.manifest.exact_g2_identity as JsonValue,
    build.inputs.exactIdentity,
    'Resolved manifest exact G2 identity',
  );

  const cases = requireArray(state.cases.cases, 'resolved Draft cases');
  const seen = new Set<string>();
  for (const [index, value] of cases.entries()) {
    const entry = requireObject(value, `resolved Draft case ${index}`);
    const caseId = requireString(entry.case_id, 'resolved Draft case id');
    if (seen.has(caseId)) {
      throw new ResolvedGoldenDraftError(`Duplicate resolved case: ${caseId}`);
    }
    seen.add(caseId);
    const repair = build.inputs.repairCases.find(
      (candidate) => candidate.case_id === caseId,
    );
    const binding = build.inputs.bindingCases.get(caseId);
    const candidate = build.inputs.candidateResults.get(caseId);
    if (!repair || !binding || !candidate) {
      throw new ResolvedGoldenDraftError(`Unknown resolved case: ${caseId}`);
    }
    if (
      entry.g2_case_input_binding_hash !== G2_CASE_INPUT_BINDING_HASH ||
      entry.effective_case_input_hash !== binding.effective_case_input_hash
    ) {
      throw new ResolvedGoldenDraftError(`Resolved input drift: ${caseId}`);
    }
    const review = requireObject(entry.review_input, `review input ${caseId}`);
    assertCanonicalEqual(
      review.semantic_assertions as JsonValue,
      repair.semantic_assertions as JsonValue,
      `Review assertions ${caseId}`,
    );
    assertCanonicalEqual(
      review.draft_diagnostics_candidate as JsonValue,
      repair.expected_diagnostics as JsonValue,
      `Review diagnostics ${caseId}`,
    );
    const actual = requireObject(
      entry.actual_compiler_candidate,
      `actual candidate ${caseId}`,
    );
    if (
      actual.role !== 'actual_compiler_output_not_golden_oracle' ||
      actual.result_ref !== candidate.result_ref ||
      actual.result_hash !== candidate.result_hash ||
      actual.result_raw_bytes_hash !== candidate.result_raw_bytes_hash
    ) {
      throw new ResolvedGoldenDraftError(`Actual candidate drift: ${caseId}`);
    }
    const expected = requireObject(
      entry.expected_golden_oracle,
      `expected oracle ${caseId}`,
    );
    if (
      expected.status !== 'pending_independent_human_semantic_review' ||
      Object.entries(expected).some(
        ([key, value]) => key !== 'status' && value !== null,
      )
    ) {
      throw new ResolvedGoldenDraftError(
        `Expected oracle was populated before human review: ${caseId}`,
      );
    }
  }
  if (seen.size !== 40) {
    throw new ResolvedGoldenDraftError(
      'Resolved Draft case coverage is incomplete',
    );
  }

  const handoffs = requireArray(
    state.handoff.case_handoffs,
    'semantic review case handoffs',
  );
  if (
    handoffs.length !== 40 ||
    state.handoff.review_decision_status !== 'pending_not_recorded' ||
    state.handoff.golden_semantic_review_record_ref !== null ||
    state.handoff.golden_semantic_review_record_hash !== null
  ) {
    throw new ResolvedGoldenDraftError(
      'Semantic review handoff boundary drift',
    );
  }
  for (const value of handoffs) {
    const handoff = requireObject(value, 'case handoff');
    const caseId = requireString(handoff.case_id, 'handoff case id');
    const candidate = build.inputs.candidateResults.get(caseId);
    if (
      !candidate ||
      handoff.actual_candidate_result_ref !== candidate.result_ref ||
      handoff.actual_candidate_result_hash !== candidate.result_hash
    ) {
      throw new ResolvedGoldenDraftError(`Case handoff drift: ${caseId}`);
    }
  }

  assertCanonicalEqual(
    state.inventory.entries as JsonValue,
    build.inventoryArtifact.payload.entries as JsonValue,
    'Resolved Draft inventory',
  );
  if (
    state.inventory.entry_count !==
      requireArray(state.inventory.entries, 'inventory entries').length ||
    state.manifest.artifact_inventory_hash !== build.inventoryArtifact.hash ||
    state.manifest.resolved_case_catalog_hash !== build.casesArtifact.hash ||
    state.manifest.semantic_review_handoff_hash !==
      build.handoffArtifact.hash ||
    state.manifest.expected_golden_oracle_status !== 'absent' ||
    state.manifest.approval_status !== 'not_run' ||
    state.manifest.golden_seal_status !== 'not_run' ||
    state.manifest.conformance_sealed_write_status !== 'not_run' ||
    state.manifest.g3_through_g9_status !== 'not_started'
  ) {
    throw new ResolvedGoldenDraftError(
      'Resolved Draft manifest boundary drift',
    );
  }
}

function mutateState(state: DraftState, mutation: NegativeMutation): void {
  const cases = requireArray(state.cases.cases, 'mutation cases');
  const first = requireObject(cases[0], 'first mutation case');
  const firstActual = requireObject(
    first.actual_compiler_candidate,
    'first mutation actual candidate',
  );
  const firstExpected = requireObject(
    first.expected_golden_oracle,
    'first mutation expected oracle',
  );
  const identity = requireObject(
    state.cases.exact_g2_identity,
    'mutation identity',
  );
  switch (mutation) {
    case 'candidate_disposition_promoted_to_oracle':
      firstActual.role = 'expected_golden_oracle';
      return;
    case 'candidate_result_copied_to_expected':
      firstExpected.expected_case_result_bytes_ref = firstActual.result_ref;
      firstExpected.expected_case_result_hash = firstActual.result_hash;
      return;
    case 'draft_diagnostics_copied_to_expected': {
      const review = requireObject(first.review_input, 'mutation review input');
      firstExpected.expected_diagnostics = review.draft_diagnostics_candidate;
      return;
    }
    case 'review_marked_approved':
      state.handoff.review_decision_status = 'approved';
      return;
    case 'golden_semantic_review_record_injected':
      state.handoff.golden_semantic_review = {
        reviewer_actor_ref: 'human:local-owner',
        decision: 'approved',
      };
      return;
    case 'toolchain_hash_drift':
      identity.compiler_toolchain_hash = HASH;
      return;
    case 'compiler_build_hash_drift':
      identity.compiler_build_hash = HASH;
      return;
    case 'normalizer_hash_drift':
      identity.canonical_normalizer_hash = HASH;
      return;
    case 'proof_hash_drift':
      identity.proof_algorithm_hash = HASH;
      return;
    case 'case_input_binding_hash_drift':
      first.g2_case_input_binding_hash = HASH;
      return;
    case 'candidate_manifest_hash_drift':
      state.handoff.actual_candidate_manifest_hash = HASH;
      return;
    case 'candidate_result_hash_drift':
      firstActual.result_hash = HASH;
      return;
    case 'effective_case_input_hash_drift':
      first.effective_case_input_hash = HASH;
      return;
    case 'case_removed':
      cases.pop();
      return;
    case 'case_duplicated':
      cases.push(cloneObject(first));
      return;
    case 'handoff_case_removed':
      requireArray(state.handoff.case_handoffs, 'mutation handoffs').pop();
      return;
    case 'inventory_member_removed':
      requireArray(state.inventory.entries, 'mutation inventory').pop();
      return;
    case 'inventory_raw_hash_drift': {
      const entry = requireObject(
        requireArray(state.inventory.entries, 'mutation inventory')[0],
        'mutation inventory entry',
      );
      entry.raw_bytes_hash = HASH;
      return;
    }
    case 'seal_marked_complete':
      state.manifest.golden_seal_status = 'complete';
      return;
    case 'g3_marked_started':
      state.manifest.g3_through_g9_status = 'started';
      return;
  }
}

function validateArtifacts(build: BuiltResolvedDraft): void {
  const validators = compileValidators(build.artifacts);
  for (const [, artifact] of build.artifacts) {
    const validator = validators.get(artifact.format);
    if (validator && !validator(artifact.payload)) {
      throw new ResolvedGoldenDraftError(
        `${artifact.format} failed closed schema: ${JSON.stringify(validator.errors)}`,
      );
    }
  }
  validateState(stateFromBuild(build), build, validators);
  for (const fixture of NEGATIVE_CASES) {
    const state = stateFromBuild(build);
    mutateState(state, fixture.mutation);
    try {
      validateState(state, build, validators);
    } catch (error) {
      if (
        error instanceof ResolvedGoldenDraftError &&
        error.code === fixture.expected_error_code
      ) {
        continue;
      }
      throw error;
    }
    throw new ResolvedGoldenDraftError(
      `Negative fixture was accepted: ${fixture.case_id}`,
    );
  }
}

function validateBoundaries(): void {
  validateFrozenBaselines();
  const sealed = fs.readdirSync(contractPath('conformance/sealed'));
  if (sealed.length !== 1 || sealed[0] !== '.gitkeep') {
    throw new ResolvedGoldenDraftError(
      'conformance/sealed must contain only .gitkeep',
    );
  }
  for (const forbidden of [
    'registry',
    'authoring',
    'runtime/graph-runtime.ts',
    'projection/runtime-center-api.ts',
  ]) {
    if (fs.existsSync(path.join(workflowRuntimeRoot, forbidden))) {
      throw new ResolvedGoldenDraftError(`G3+ boundary crossed: ${forbidden}`);
    }
  }
}

function writeAtomic(relativePath: string, contents: string): void {
  const absolute = contractPath(relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, absolute);
}

function listGeneratedFiles(): string[] {
  const root = contractPath(RESOLVED_GOLDEN_DRAFT_ROOT);
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new ResolvedGoldenDraftError(
          `Resolved Draft tree contains symlink: ${absolute}`,
        );
      }
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        output.push(
          path.relative(contractsRoot, absolute).split(path.sep).join('/'),
        );
      }
    }
  };
  visit(root);
  return output.sort((left, right) => left.localeCompare(right, 'en'));
}

export function buildResolvedGoldenDraftExpectedArtifactsForTest(): Array<
  [string, ContractArtifactEnvelope]
> {
  return buildResolvedDraft().artifacts;
}

export function runResolvedGoldenDraftNegativeVerificationForTest(): number {
  const build = buildResolvedDraft();
  validateArtifacts(build);
  return NEGATIVE_CASES.length;
}

export function generateResolvedGoldenDraftArtifacts(): ContractArtifactEnvelope {
  validateBoundaries();
  const build = buildResolvedDraft();
  validateArtifacts(build);
  for (const [relativePath, artifact] of build.artifacts) {
    writeAtomic(relativePath, renderJson(artifact));
  }
  return build.manifestArtifact;
}

export function checkResolvedGoldenDraftArtifacts(): ContractArtifactEnvelope {
  validateBoundaries();
  const build = buildResolvedDraft();
  validateArtifacts(build);
  const expectedFiles = build.artifacts.map(([relativePath]) => relativePath);
  const actualFiles = listGeneratedFiles();
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) {
    throw new ResolvedGoldenDraftError('Resolved Draft tree inventory drift');
  }
  for (const [relativePath, artifact] of build.artifacts) {
    const expected = renderJson(artifact);
    const actual = fs.readFileSync(contractPath(relativePath), 'utf8');
    if (actual !== expected) {
      throw new ResolvedGoldenDraftError(
        `Resolved Draft bytes drift: ${relativePath}`,
      );
    }
  }
  return build.manifestArtifact;
}
