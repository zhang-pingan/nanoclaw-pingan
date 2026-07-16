import { calculateArtifactHash } from './hash.js';
import {
  G0_CHANGE_IMPACTS,
  G0_COVERAGE_CATEGORIES,
  G0_INVENTORY_CLASSES,
  G0_SEMANTIC_HASH_KINDS,
  type G0ArtifactHashInventory,
  type G0GateReview,
  type G0MarkdownContractCoverage,
} from './g0-conformance-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const PATH_PATTERN = '^[A-Za-z0-9._@/-]+$';
type Schema = JsonObject;

export interface G0ConformanceArtifactDescriptor {
  artifact_path: string;
  artifact_format: string;
  ref_id: string;
  domain_separator: string;
  artifact_kind: 'schema' | 'coverage' | 'inventory' | 'gate_review';
  target_format: string | null;
}

export const G0_CONFORMANCE_ARTIFACT_DESCRIPTORS = [
  {
    artifact_path:
      'conformance/g0-exit/schemas/markdown-contract-coverage-schema.json',
    artifact_format: 'icarus.workflow-markdown-contract-coverage-schema/1',
    ref_id: 'icarus.workflow-markdown-contract-coverage-schema',
    domain_separator: 'icarus:workflow-markdown-contract-coverage-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-markdown-contract-coverage/1',
  },
  {
    artifact_path:
      'conformance/g0-exit/schemas/artifact-hash-inventory-schema.json',
    artifact_format: 'icarus.workflow-g0-artifact-hash-inventory-schema/1',
    ref_id: 'icarus.workflow-g0-artifact-hash-inventory-schema',
    domain_separator: 'icarus:workflow-g0-artifact-hash-inventory-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-g0-artifact-hash-inventory/1',
  },
  {
    artifact_path: 'conformance/g0-exit/schemas/g0-gate-review-schema.json',
    artifact_format: 'icarus.workflow-g0-gate-review-schema/1',
    ref_id: 'icarus.workflow-g0-gate-review-schema',
    domain_separator: 'icarus:workflow-g0-gate-review-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-g0-gate-review/1',
  },
  {
    artifact_path: 'conformance/g0-exit/markdown-contract-coverage@1.json',
    artifact_format: 'icarus.workflow-markdown-contract-coverage/1',
    ref_id: 'icarus.workflow-markdown-contract-coverage',
    domain_separator: 'icarus:workflow-markdown-contract-coverage-artifact:1\n',
    artifact_kind: 'coverage',
    target_format: null,
  },
  {
    artifact_path: 'conformance/g0-exit/artifact-hash-inventory@1.json',
    artifact_format: 'icarus.workflow-g0-artifact-hash-inventory/1',
    ref_id: 'icarus.workflow-g0-artifact-hash-inventory',
    domain_separator: 'icarus:workflow-g0-artifact-hash-inventory-artifact:1\n',
    artifact_kind: 'inventory',
    target_format: null,
  },
  {
    artifact_path: 'conformance/g0-exit/g0-gate-review@1.json',
    artifact_format: 'icarus.workflow-g0-gate-review/1',
    ref_id: 'icarus.workflow-g0-gate-review',
    domain_separator: 'icarus:workflow-g0-gate-review-artifact:1\n',
    artifact_kind: 'gate_review',
    target_format: null,
  },
] as const satisfies readonly G0ConformanceArtifactDescriptor[];

export const G0_CONFORMANCE_SCHEMA_FORMAT_BY_TARGET = Object.fromEntries(
  G0_CONFORMANCE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.target_format !== null,
  ).map((descriptor) => [
    descriptor.target_format!,
    descriptor.artifact_format,
  ]),
) as Record<string, string>;

function object(
  properties: Record<string, JsonValue>,
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

function array(items: JsonValue, minItems = 0, uniqueItems = false): Schema {
  return {
    type: 'array',
    items,
    minItems,
    ...(uniqueItems ? { uniqueItems: true } : {}),
  };
}

function string(options: JsonObject = {}): Schema {
  return { type: 'string', ...options };
}

function integer(minimum = 0): Schema {
  return {
    type: 'integer',
    minimum,
    maximum: Number.MAX_SAFE_INTEGER,
  };
}

const hash = string({ pattern: HASH_PATTERN });
const relativePath = string({ minLength: 1, pattern: PATH_PATTERN });

function schemaDocument(id: string, title: string, payload: Schema): Schema {
  return { $schema: DRAFT_2020_12, $id: id, title, ...payload };
}

function markdownCoverageSchema(): Schema {
  const entry = object({
    coverage_id: string({ minLength: 1 }),
    category: { enum: [...G0_COVERAGE_CATEGORIES] },
    value: string({ minLength: 1 }),
    contract_path: relativePath,
    contract_pointer: string({
      pattern: '^/(?:[^~/]|~[01])*(?:/(?:[^~/]|~[01])*)*$',
    }),
    markdown_section: string({ minLength: 1 }),
    markdown_anchor: string({ pattern: '^#[a-z0-9\u4e00-\u9fff-]+$' }),
    change_impact: { enum: [...G0_CHANGE_IMPACTS] },
    fixture_refs: array(relativePath, 1, true),
    entry_hash: hash,
  });
  return schemaDocument(
    'urn:icarus:workflow-markdown-contract-coverage:1',
    'Workflow Markdown and Contract Pack bidirectional coverage v1',
    object({
      format: { const: 'icarus.workflow-markdown-contract-coverage/1' },
      architecture_path: {
        const: 'local/docs/dynamic-workflow-dag-framework.md',
      },
      architecture_sha256: hash,
      extraction_policy: {
        const: 'conformance_only_no_runtime_markdown_extraction',
      },
      categories: {
        const: [...G0_COVERAGE_CATEGORIES],
      },
      entries: array(entry, 1),
      category_counts: object(
        Object.fromEntries(
          G0_COVERAGE_CATEGORIES.map((category) => [category, integer(1)]),
        ),
      ),
      contract_value_count: integer(1),
      markdown_value_count: integer(1),
      contract_values_without_markdown: { const: [] },
      markdown_values_without_contract: { const: [] },
      coverage_hash: hash,
    }),
  );
}

function artifactInventorySchema(): Schema {
  const inventoryEntry = object({
    artifact_id: string({ minLength: 1 }),
    owning_slice: {
      enum: Array.from({ length: 8 }, (_, index) => `G0.${index + 1}`),
    },
    artifact_class: { enum: [...G0_INVENTORY_CLASSES] },
    path: relativePath,
    format: {
      oneOf: [string({ minLength: 1 }), { type: 'null' }],
    },
    byte_length: integer(1),
    raw_sha256: hash,
    semantic_hash_kind: { enum: [...G0_SEMANTIC_HASH_KINDS] },
    semantic_hash: hash,
  });
  return schemaDocument(
    'urn:icarus:workflow-g0-artifact-hash-inventory:1',
    'Workflow G0 artifact hash inventory v1',
    object({
      format: { const: 'icarus.workflow-g0-artifact-hash-inventory/1' },
      inventory_scope: {
        const: 'all_g0_1_g0_8_exit_artifacts_and_raw_sources',
      },
      g0_9_closure_policy: {
        const: 'g0_9_leaf_artifacts_owned_by_root_manifest',
      },
      entries: array(inventoryEntry, 1),
      entry_count: integer(1),
      class_counts: object(
        Object.fromEntries(
          G0_INVENTORY_CLASSES.map((artifactClass) => [
            artifactClass,
            integer(),
          ]),
        ),
      ),
      slice_counts: object(
        Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `G0.${index + 1}`,
            integer(1),
          ]),
        ),
      ),
      duplicate_paths: { const: [] },
      missing_paths: { const: [] },
      inventory_hash: hash,
    }),
  );
}

function gateReviewSchema(): Schema {
  const identity = object({
    slice_id: {
      enum: Array.from({ length: 8 }, (_, index) => `G0.${index + 1}`),
    },
    identity_kind: {
      enum: ['toolchain_manifest', 'contract_pack_manifest'],
    },
    primary_identity_hash: hash,
    supporting_identity_hashes: array(hash),
  });
  const criterion = object({
    criterion_id: string({ minLength: 1 }),
    status: { const: 'pass' },
    evidence_hashes: array(hash, 1),
  });
  const gateStatus = object({
    gate_id: { pattern: '^G[0-9]+$', type: 'string' },
    status: { enum: ['DONE', 'READY', 'NOT_READY'] },
  });
  return schemaDocument(
    'urn:icarus:workflow-g0-gate-review:1',
    'Workflow G0 conformance exit review v1',
    object({
      format: { const: 'icarus.workflow-g0-gate-review/1' },
      gate_id: { const: 'G0' },
      review_kind: { const: 'machine_conformance_exit_review' },
      decision: { const: 'pass' },
      slice_identities: array(identity, 8),
      exit_criteria: array(criterion, 9),
      markdown_coverage_hash: hash,
      artifact_inventory_hash: hash,
      absence_proof: object({
        workflow_runtime_absence_hash: hash,
        product_surface_coverage_hash: hash,
        migration_candidate_boundary_hash: hash,
        production_source_hits: { const: 0 },
        removed_api_hits: { const: 0 },
        removed_ui_hits: { const: 0 },
        legacy_schema_hits: { const: 0 },
        legacy_filesystem_hits: { const: 0 },
        active_resource_hits: { const: 0 },
        candidate_reachability_hits: { const: 0 },
      }),
      status_proof: object({
        golden_review_request_status: { const: 'pending' },
        golden_review_report_status: { const: 'not_run' },
        golden_semantic_review_status: { const: 'absent' },
        golden_seal_status: { const: 'not_run' },
        sealed_bundle_status: { const: 'absent' },
        sealed_directory_entry: { const: '.gitkeep' },
        expected_plan_bytes_status: { const: 'all_null' },
        expected_plan_hash_status: { const: 'all_null' },
        expected_proof_program_hash_status: { const: 'all_null' },
        sqlite_profile_status: { const: 'candidate' },
        sqlite_certification_status: { const: 'not_certified' },
        executable_ddl_status: { const: 'absent' },
        schema_manifest_status: { const: 'absent' },
        workflow_runtime_store_status: { const: 'absent' },
        production_compiler_status: { const: 'absent' },
        golden_bundle_status: { const: 'absent' },
        registry_runtime_status: { const: 'absent' },
        runtime_center_ui_status: { const: 'absent' },
      }),
      gate_statuses: array(gateStatus, 10),
      conformance_entrypoint: { const: 'npm run test:g0' },
      review_hash: hash,
    }),
  );
}

export function buildG0ConformanceArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const base: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  return { ...base, hash: calculateArtifactHash(base) };
}

export function buildG0ConformanceSchemaArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  const schemaPayloads = new Map<string, Schema>([
    ['icarus.workflow-markdown-contract-coverage/1', markdownCoverageSchema()],
    ['icarus.workflow-g0-artifact-hash-inventory/1', artifactInventorySchema()],
    ['icarus.workflow-g0-gate-review/1', gateReviewSchema()],
  ]);
  return G0_CONFORMANCE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.artifact_kind === 'schema',
  ).map((descriptor) => [
    descriptor.artifact_path,
    buildG0ConformanceArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      schemaPayloads.get(descriptor.target_format!)!,
    ),
  ]);
}

export function buildG0ConformanceSemanticArtifacts(
  coverage: G0MarkdownContractCoverage,
  inventory: G0ArtifactHashInventory,
  review: G0GateReview,
): Array<[string, ContractArtifactEnvelope]> {
  const payloads = new Map<string, JsonObject>([
    [
      'icarus.workflow-markdown-contract-coverage/1',
      coverage as unknown as JsonObject,
    ],
    [
      'icarus.workflow-g0-artifact-hash-inventory/1',
      inventory as unknown as JsonObject,
    ],
    ['icarus.workflow-g0-gate-review/1', review as unknown as JsonObject],
  ]);
  return G0_CONFORMANCE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.artifact_kind !== 'schema',
  ).map((descriptor) => [
    descriptor.artifact_path,
    buildG0ConformanceArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      payloads.get(descriptor.artifact_format)!,
    ),
  ]);
}
