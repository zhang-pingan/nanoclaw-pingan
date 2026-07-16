import {
  COMPILER_DIAGNOSTIC_PHASES,
  WORKFLOW_COMPILER_ERROR_CODES,
} from './catalog-protocol-types.js';
import { SHA256_HASH_PATTERN, calculateArtifactHash } from './hash.js';
import { SAFETY_CEILING_GROUP_KEYS } from './safety-sqlite-types.js';
import { strictParseJson } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';
import {
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const STABLE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$';
const POINTER_PATTERN = '^(?:/(?:[^~/]|~[01])*)*$';

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
const relativePathSchema = string({
  minLength: 1,
  pattern: '^conformance/draft/[A-Za-z0-9.@_/-]+$',
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

const diagnosticSchema = object({
  code: enumString(WORKFLOW_COMPILER_ERROR_CODES),
  phase: enumString(COMPILER_DIAGNOSTIC_PHASES),
  instance_pointer: string({ pattern: POINTER_PATTERN }),
  schema_pointer: nullable(string({ pattern: '^#(?:/(?:[^~/]|~[01])*)*$' })),
  stable_object_id: nullable(string({ minLength: 1, maxLength: 255 })),
  detail_ref: nullable(string({ minLength: 1 })),
});

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

const caseSchema = object({
  case_id: stableIdSchema,
  polarity: enumString(['positive', 'negative']),
  source_kind: enumString([
    'graph_scope',
    'workflow_definition',
    'workflow_schema',
  ]),
  coverage_tags: array(stableIdSchema, { minItems: 1, uniqueItems: true }),
  raw_source_bytes_ref: relativePathSchema,
  raw_source_bytes_hash: hashSchema,
  input_snapshot_ref: relativePathSchema,
  input_snapshot_hash: hashSchema,
  expected_source_hash: nullable(hashSchema),
  expected_plan_bytes_ref: { type: 'null' },
  expected_plan_hash: { type: 'null' },
  expected_proof_hashes: { type: 'null' },
  expected_program_hashes: { type: 'null' },
  expected_diagnostics: array(diagnosticSchema),
  normalized_semantic_assertions: array(assertionSchema, { minItems: 1 }),
  review_status: { const: 'pending_human_review' },
  authored_by: { const: 'codex:draft-author' },
});

function caseCatalogSchema(): Schema {
  return object({
    format: { const: 'icarus.workflow-compiler-golden-draft-cases/1' },
    bundle_version: { const: '1.0.0-draft' },
    cases: array(caseSchema, { minItems: 1 }),
    positive_case_count: integer(1),
    negative_case_count: integer(1),
    catalog_hash: hashSchema,
  });
}

function compilerInputSnapshotSchema(): Schema {
  const resource = object({
    resource_type: stableIdSchema,
    ref: versionedRefSchema,
    content_hash: hashSchema,
    content: ref('json_value'),
  });
  const compilerIdentity = object({
    toolchain_inputs_ref: string({ minLength: 1 }),
    toolchain_inputs_hash: hashSchema,
    error_catalog_ref: versionedRefSchema,
    error_catalog_hash: hashSchema,
    strict_parser_wrapper_hash: hashSchema,
    production_compiler_status: { const: 'absent' },
    canonical_normalizer_status: { const: 'absent' },
    proof_algorithm_status: { const: 'absent' },
    identity_match: { type: 'boolean' },
  });
  const registry = object({
    snapshot_ref: string({ minLength: 1 }),
    snapshot_hash: hashSchema,
    resource_count: integer(1),
    resources: array(resource, { minItems: 1 }),
  });
  const interfaces = object({
    snapshot_ref: string({ minLength: 1 }),
    snapshot_hash: hashSchema,
    interfaces: array(ref('json_value'), { minItems: 1 }),
  });
  const policies = object({
    snapshot_ref: string({ minLength: 1 }),
    snapshot_hash: hashSchema,
    complete_policy: ref('json_value'),
  });
  const safetyGroups = Object.fromEntries(
    Object.entries(SAFETY_CEILING_GROUP_KEYS).map(([group, keys]) => [
      group,
      object(Object.fromEntries(keys.map((key) => [key, integer(1)]))),
    ]),
  );
  const safety = object({
    profile_id: { const: 'local_single_user_safety@1' },
    deployment_profile: { const: 'local_single_user' },
    mutability: { const: 'immutable_versioned' },
    pinning_scope: { const: 'workflow_and_run_creation' },
    ceilings: object(safetyGroups),
    source_artifact_ref: string({ minLength: 1 }),
    source_artifact_hash: hashSchema,
  });
  return object({
    format: { const: 'icarus.workflow-compiler-input-snapshot/1' },
    snapshot_id: stableIdSchema,
    launchability: { const: 'test_only' },
    compiler_identity: compilerIdentity,
    registry_snapshot: registry,
    interface_snapshot: interfaces,
    policy_snapshot: policies,
    safety_snapshot: safety,
    snapshot_hash: hashSchema,
  });
}

const snapshotDescriptorSchema = object({
  ref: relativePathSchema,
  hash: hashSchema,
});

function draftManifestSchema(): Schema {
  return object({
    format: { const: 'icarus.workflow-compiler-golden-draft-manifest/1' },
    bundle_version: { const: '1.0.0-draft' },
    draft_status: { const: 'candidate_pending_human_review' },
    draft_author_actor_ref: { const: 'codex:draft-author' },
    review_owner_actor_ref: { const: 'human:local-owner' },
    draft_generator_tool_hash: hashSchema,
    case_catalog_ref: relativePathSchema,
    case_catalog_hash: hashSchema,
    input_snapshots: array(snapshotDescriptorSchema, { minItems: 1 }),
    raw_source_count: integer(1),
    raw_source_aggregate_hash: hashSchema,
    positive_case_count: integer(1),
    negative_case_count: integer(1),
    positive_coverage: array(stableIdSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    negative_error_code_coverage: array(
      enumString(WORKFLOW_COMPILER_ERROR_CODES),
      { minItems: 1, uniqueItems: true },
    ),
    additional_negative_coverage: array(stableIdSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    expected_plan_artifact_status: { const: 'all_null_pending_review' },
    expected_proof_program_status: { const: 'all_null_pending_review' },
    golden_semantic_review_status: { const: 'absent' },
    sealed_bundle_status: { const: 'absent' },
    manifest_hash: hashSchema,
  });
}

function reviewRequestSchema(): Schema {
  return object({
    format: { const: 'icarus.workflow-golden-review-request/1' },
    review_request_id: stableIdSchema,
    draft_manifest_ref: relativePathSchema,
    draft_manifest_hash: hashSchema,
    requested_reviewer_actor_ref: { const: 'human:local-owner' },
    checklist_version: { const: 'golden-semantic-review-checklist@1' },
    case_ids: array(stableIdSchema, { minItems: 1, uniqueItems: true }),
    previous_bundle_ref: { type: 'null' },
    previous_bundle_hash: { type: 'null' },
    semantic_decision_status: { const: 'pending' },
    approval_record_status: { const: 'absent' },
    immutable_request_hash: hashSchema,
  });
}

function reviewReportInputSchema(): Schema {
  return object({
    format: { const: 'icarus.workflow-golden-review-report-input/1' },
    report_input_id: stableIdSchema,
    review_request_ref: relativePathSchema,
    review_request_hash: hashSchema,
    draft_manifest_ref: relativePathSchema,
    draft_manifest_hash: hashSchema,
    case_catalog_ref: relativePathSchema,
    case_catalog_hash: hashSchema,
    input_snapshots: array(snapshotDescriptorSchema, { minItems: 1 }),
    allowed_operations: array(stableIdSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    forbidden_module_classes: array(stableIdSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    report_generation_status: { const: 'not_run' },
    semantic_decision_status: { const: 'pending' },
    immutable_input_hash: hashSchema,
  });
}

export interface GoldenDraftSchemaDescriptor {
  artifact_path: string;
  artifact_format: string;
  target_format: string;
  domain_separator: string;
  build_schema: () => Schema;
}

export const GOLDEN_DRAFT_SCHEMA_DESCRIPTORS: readonly GoldenDraftSchemaDescriptor[] =
  [
    {
      artifact_path:
        'conformance/draft/schemas/compiler-input-snapshot-schema.json',
      artifact_format: 'icarus.workflow-compiler-input-snapshot-schema/1',
      target_format: 'icarus.workflow-compiler-input-snapshot/1',
      domain_separator: 'icarus:workflow-compiler-input-snapshot-schema:1\n',
      build_schema: compilerInputSnapshotSchema,
    },
    {
      artifact_path: 'conformance/draft/schemas/golden-draft-cases-schema.json',
      artifact_format: 'icarus.workflow-compiler-golden-draft-cases-schema/1',
      target_format: 'icarus.workflow-compiler-golden-draft-cases/1',
      domain_separator:
        'icarus:workflow-compiler-golden-draft-cases-schema:1\n',
      build_schema: caseCatalogSchema,
    },
    {
      artifact_path:
        'conformance/draft/schemas/golden-draft-manifest-schema.json',
      artifact_format:
        'icarus.workflow-compiler-golden-draft-manifest-schema/1',
      target_format: 'icarus.workflow-compiler-golden-draft-manifest/1',
      domain_separator:
        'icarus:workflow-compiler-golden-draft-manifest-schema:1\n',
      build_schema: draftManifestSchema,
    },
    {
      artifact_path:
        'conformance/draft/schemas/golden-review-request-schema.json',
      artifact_format: 'icarus.workflow-golden-review-request-schema/1',
      target_format: 'icarus.workflow-golden-review-request/1',
      domain_separator: 'icarus:workflow-golden-review-request-schema:1\n',
      build_schema: reviewRequestSchema,
    },
    {
      artifact_path:
        'conformance/draft/schemas/golden-review-report-input-schema.json',
      artifact_format: 'icarus.workflow-golden-review-report-input-schema/1',
      target_format: 'icarus.workflow-golden-review-report-input/1',
      domain_separator: 'icarus:workflow-golden-review-report-input-schema:1\n',
      build_schema: reviewReportInputSchema,
    },
  ] as const;

export const GOLDEN_DRAFT_SCHEMA_FORMAT_BY_TARGET = Object.fromEntries(
  GOLDEN_DRAFT_SCHEMA_DESCRIPTORS.map((descriptor) => [
    descriptor.target_format,
    descriptor.artifact_format,
  ]),
) as Record<string, string>;

export function buildGoldenDraftArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const detached = strictParseJson(JSON.stringify(payload)) as JsonObject;
  const artifact: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload: detached,
  };
  return { ...artifact, hash: calculateArtifactHash(artifact) };
}

export function buildGoldenDraftSchemaArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  return GOLDEN_DRAFT_SCHEMA_DESCRIPTORS.map((descriptor) => [
    descriptor.artifact_path,
    buildGoldenDraftArtifact(
      descriptor.artifact_format,
      descriptor.artifact_format.slice(
        0,
        descriptor.artifact_format.lastIndexOf('/'),
      ),
      descriptor.domain_separator,
      {
        $schema: DRAFT_2020_12,
        $id: `https://icarus.local/schemas/${descriptor.target_format.replaceAll('.', '/').replace('/', '-')}`,
        title: descriptor.target_format,
        ...descriptor.build_schema(),
        $defs: {
          json_value: jsonValueSchema,
          versioned_ref: versionedRefSchema,
        },
      },
    ),
  ]);
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
