import { calculateArtifactHash } from './hash.js';
import { buildStaticAbsenceContracts } from './static-absence-source.js';
import {
  PRODUCT_SURFACE_KINDS,
  PRODUCT_SURFACE_STATUSES,
} from './static-absence-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$';
const STABLE_ID_PATTERN = '^[a-z0-9][a-z0-9._-]*$';

type Schema = JsonObject;

export interface StaticAbsenceArtifactDescriptor {
  artifact_path: string;
  artifact_format: string;
  ref_id: string;
  domain_separator: string;
  artifact_kind: 'schema' | 'manifest';
  target_format: string | null;
}

export const STATIC_ABSENCE_ARTIFACT_DESCRIPTORS = [
  {
    artifact_path: 'static/workflow-runtime-absence-baseline-schema.json',
    artifact_format: 'icarus.workflow-runtime-absence-baseline-schema/1',
    ref_id: 'icarus.workflow-runtime-absence-baseline-schema',
    domain_separator: 'icarus:workflow-runtime-absence-baseline-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-runtime-absence-baseline/1',
  },
  {
    artifact_path: 'static/product-surface-coverage-schema.json',
    artifact_format: 'icarus.product-surface-coverage-schema/1',
    ref_id: 'icarus.product-surface-coverage-schema',
    domain_separator: 'icarus:product-surface-coverage-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.product-surface-coverage/1',
  },
  {
    artifact_path: 'static/migration-candidate-boundary-schema.json',
    artifact_format: 'icarus.migration-candidate-boundary-schema/1',
    ref_id: 'icarus.migration-candidate-boundary-schema',
    domain_separator: 'icarus:migration-candidate-boundary-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.migration-candidate-boundary/1',
  },
  {
    artifact_path: 'static/workflow-runtime-absence-baseline@1.json',
    artifact_format: 'icarus.workflow-runtime-absence-baseline/1',
    ref_id: 'icarus.workflow-runtime-absence-baseline',
    domain_separator: 'icarus:workflow-runtime-absence-baseline-artifact:1\n',
    artifact_kind: 'manifest',
    target_format: null,
  },
  {
    artifact_path: 'static/product-surface-coverage@1.json',
    artifact_format: 'icarus.product-surface-coverage/1',
    ref_id: 'icarus.product-surface-coverage',
    domain_separator: 'icarus:product-surface-coverage-artifact:1\n',
    artifact_kind: 'manifest',
    target_format: null,
  },
  {
    artifact_path: 'static/migration-candidate-boundary@1.json',
    artifact_format: 'icarus.migration-candidate-boundary/1',
    ref_id: 'icarus.migration-candidate-boundary',
    domain_separator: 'icarus:migration-candidate-boundary-artifact:1\n',
    artifact_kind: 'manifest',
    target_format: null,
  },
] as const satisfies readonly StaticAbsenceArtifactDescriptor[];

export const STATIC_ABSENCE_FORMAT_BY_TARGET = Object.fromEntries(
  STATIC_ABSENCE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.target_format !== null,
  ).map((descriptor) => [
    descriptor.target_format!,
    descriptor.artifact_format,
  ]),
) as Record<string, string>;

function object(
  properties: Record<string, JsonValue>,
  options: {
    required?: string[];
    oneOf?: JsonValue[];
  } = {},
): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: options.required ?? Object.keys(properties),
    ...(options.oneOf ? { oneOf: options.oneOf } : {}),
  };
}

function array(
  items: JsonValue,
  options: { minItems?: number; uniqueItems?: boolean } = {},
): Schema {
  return {
    type: 'array',
    items,
    ...(options.minItems === undefined ? {} : { minItems: options.minItems }),
    ...(options.uniqueItems === undefined
      ? {}
      : { uniqueItems: options.uniqueItems }),
  };
}

function stringSchema(
  options: { pattern?: string; minLength?: number } = {},
): Schema {
  return {
    type: 'string',
    ...(options.pattern ? { pattern: options.pattern } : {}),
    ...(options.minLength === undefined
      ? {}
      : { minLength: options.minLength }),
  };
}

function integer(minimum = 0): Schema {
  return { type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER };
}

const hash = stringSchema({ pattern: SHA256_PATTERN });
const nullableHash: Schema = { oneOf: [hash, { type: 'null' }] };
const nullableString: Schema = {
  oneOf: [stringSchema({ minLength: 1 }), { type: 'null' }],
};

function schemaDocument(
  id: string,
  title: string,
  payloadSchema: Schema,
): Schema {
  return {
    $schema: DRAFT_2020_12,
    $id: id,
    title,
    ...payloadSchema,
  };
}

function absenceBaselineSchema(): Schema {
  return schemaDocument(
    'urn:icarus:workflow-runtime-absence-baseline:1',
    'Workflow Runtime Absence Baseline v1 payload',
    object({
      format: { const: 'icarus.workflow-runtime-absence-baseline/1' },
      source_core_build_hash: hash,
      generated_by_tool_hash: hash,
      production_source_absence_hash: hash,
      removed_api_negative_fixture_hash: hash,
      removed_ui_negative_fixture_hash: hash,
      schema_absence_hash: hash,
      filesystem_absence_hash: hash,
      active_resource_absence_hash: hash,
      protected_capability_fixture_hash: hash,
      test_data_root_isolation_hash: hash,
      migration_candidate_boundary_hash: hash,
      baseline_hash: hash,
    }),
  );
}

function productSurfaceCoverageSchema(): Schema {
  const baseEntryProperties: Record<string, JsonValue> = {
    surface_id: stringSchema({ pattern: STABLE_ID_PATTERN }),
    surface_kind: { enum: [...PRODUCT_SURFACE_KINDS] },
    owner_feature_id: nullableString,
    status: { enum: [...PRODUCT_SURFACE_STATUSES] },
    replacement_ref: nullableString,
    contract_fixture_hash: nullableHash,
    removal_fixture_hash: nullableHash,
    entry_hash: hash,
  };
  const activeEntry = object({
    ...baseEntryProperties,
    status: { const: 'active' },
    replacement_ref: stringSchema({ minLength: 1 }),
    contract_fixture_hash: hash,
    removal_fixture_hash: { type: 'null' },
  });
  const removedEntry = object({
    ...baseEntryProperties,
    status: { const: 'removed' },
    replacement_ref: { type: 'null' },
    contract_fixture_hash: { type: 'null' },
    removal_fixture_hash: hash,
  });
  return schemaDocument(
    'urn:icarus:product-surface-coverage:1',
    'Product Surface Coverage Manifest v1 payload',
    object({
      format: { const: 'icarus.product-surface-coverage/1' },
      source_core_build_hash: hash,
      generated_by_tool_hash: hash,
      entries: array({ oneOf: [activeEntry, removedEntry] }, { minItems: 1 }),
      active_surface_count: integer(),
      removed_surface_count: integer(),
      manifest_hash: hash,
    }),
  );
}

function migrationCandidateBoundarySchema(): Schema {
  return schemaDocument(
    'urn:icarus:migration-candidate-boundary:1',
    'Migration Candidate Boundary Manifest v1 payload',
    object({
      format: { const: 'icarus.migration-candidate-boundary/1' },
      source_core_build_hash: hash,
      candidate_root: { const: 'local/migration-candidates/' },
      archive_manifest_hash: hash,
      checksum_manifest_hash: hash,
      archived_file_count: integer(1),
      production_import_reachability_hash: hash,
      test_helper_reachability_hash: hash,
      setup_reachability_hash: hash,
      feature_registry_reachability_hash: hash,
      compiler_fixture_reachability_hash: hash,
      build_context_reachability_hash: hash,
      release_artifact_reachability_hash: hash,
      boundary_hash: hash,
    }),
  );
}

export function buildStaticAbsenceArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const withoutHash = {
    format,
    ref: { id: refId, version: '1' },
    version: 1,
    domain_separator: domainSeparator,
    payload,
  };
  return {
    ...withoutHash,
    hash: calculateArtifactHash({
      ...withoutHash,
      hash: `sha256:${'0'.repeat(64)}`,
    }),
  };
}

export function staticPayloadAsJsonObject(value: unknown): JsonObject {
  return structuredClone(value) as JsonObject;
}

export function buildStaticAbsenceSemanticArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  const contracts = buildStaticAbsenceContracts();
  const payloadByFormat: Record<string, JsonObject> = {
    'icarus.workflow-runtime-absence-baseline-schema/1':
      absenceBaselineSchema(),
    'icarus.product-surface-coverage-schema/1': productSurfaceCoverageSchema(),
    'icarus.migration-candidate-boundary-schema/1':
      migrationCandidateBoundarySchema(),
    'icarus.workflow-runtime-absence-baseline/1': staticPayloadAsJsonObject(
      contracts.absenceBaseline,
    ),
    'icarus.product-surface-coverage/1': staticPayloadAsJsonObject(
      contracts.surfaceManifest,
    ),
    'icarus.migration-candidate-boundary/1': staticPayloadAsJsonObject(
      contracts.candidateBoundary,
    ),
  };
  return STATIC_ABSENCE_ARTIFACT_DESCRIPTORS.map((descriptor) => [
    descriptor.artifact_path,
    buildStaticAbsenceArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      payloadByFormat[descriptor.artifact_format],
    ),
  ]);
}
