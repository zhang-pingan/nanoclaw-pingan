import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import {
  CAPACITY_LIMIT_PATHS,
  DEPLOYMENT_CAPACITY_KEYS,
  DEPLOYMENT_RUNTIME_CAPACITY_BASELINE_WITHOUT_HASH,
  ENFORCEMENT_RECORD_KEYS,
  LOCAL_SINGLE_USER_PRODUCT_FLOOR,
  LOCAL_SINGLE_USER_RETENTION_POLICY,
  LOCAL_SINGLE_USER_SAFETY_PROFILE,
  LOCAL_SINGLE_USER_SQLITE_CANDIDATE,
  PRODUCT_FLOOR_BENCHMARK_KEYS,
  PRODUCT_FLOOR_LIMIT_KEYS,
  RETENTION_DURATION_KEYS,
  RETENTION_RULE_KEYS,
  SAFETY_CEILING_GROUP_KEYS,
  SAFETY_ENFORCEMENT_RECORD_SEEDS,
  SAFETY_LIMIT_PATHS,
  SQLITE_PROFILE_KEYS,
  type DeploymentRuntimeCapacity,
  type WorkflowSafetyEnforcementRecord,
} from './safety-sqlite-types.js';
import { assertJsonObject, strictParseJson } from './strict-json.js';
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
const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$';
const LIMIT_PATH_PATTERN = '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$';

type Schema = JsonObject;

export interface SafetySqliteArtifactDescriptor {
  artifact_path: string;
  artifact_format: string;
  ref_id: string;
  domain_separator: string;
  artifact_kind: 'schema' | 'profile' | 'matrix';
  target_format: string | null;
}

export const SAFETY_SQLITE_ARTIFACT_DESCRIPTORS = [
  {
    artifact_path: 'safety/workflow-runtime-safety-profile-schema.json',
    artifact_format: 'icarus.workflow-runtime-safety-profile-schema/1',
    ref_id: 'icarus.workflow-runtime-safety-profile-schema',
    domain_separator: 'icarus:workflow-runtime-safety-profile-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-runtime-safety-profile/1',
  },
  {
    artifact_path: 'safety/deployment-runtime-capacity-schema.json',
    artifact_format: 'icarus.deployment-runtime-capacity-schema/1',
    ref_id: 'icarus.deployment-runtime-capacity-schema',
    domain_separator: 'icarus:deployment-runtime-capacity-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.deployment-runtime-capacity/1',
  },
  {
    artifact_path: 'safety/workflow-runtime-product-floor-schema.json',
    artifact_format: 'icarus.workflow-runtime-product-floor-schema/1',
    ref_id: 'icarus.workflow-runtime-product-floor-schema',
    domain_separator: 'icarus:workflow-runtime-product-floor-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-runtime-product-floor/1',
  },
  {
    artifact_path: 'safety/workflow-runtime-retention-policy-schema.json',
    artifact_format: 'icarus.workflow-runtime-retention-policy-schema/1',
    ref_id: 'icarus.workflow-runtime-retention-policy-schema',
    domain_separator: 'icarus:workflow-runtime-retention-policy-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-runtime-retention-policy/1',
  },
  {
    artifact_path: 'safety/workflow-safety-enforcement-matrix-schema.json',
    artifact_format: 'icarus.workflow-safety-enforcement-matrix-schema/1',
    ref_id: 'icarus.workflow-safety-enforcement-matrix-schema',
    domain_separator: 'icarus:workflow-safety-enforcement-matrix-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
  },
  {
    artifact_path: 'sqlite/sqlite-execution-profile-schema.json',
    artifact_format: 'icarus.sqlite-execution-profile-schema/1',
    ref_id: 'icarus.sqlite-execution-profile-schema',
    domain_separator: 'icarus:sqlite-execution-profile-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.sqlite-execution-profile/1',
  },
  {
    artifact_path: 'safety/local_single_user_safety@1.json',
    artifact_format: 'icarus.workflow-runtime-safety-profile/1',
    ref_id: 'icarus.local-single-user-safety',
    domain_separator: 'icarus:workflow-runtime-safety-profile:1\n',
    artifact_kind: 'profile',
    target_format: null,
  },
  {
    artifact_path: 'safety/local_single_user_product_floor@1.json',
    artifact_format: 'icarus.workflow-runtime-product-floor/1',
    ref_id: 'icarus.local-single-user-product-floor',
    domain_separator: 'icarus:workflow-runtime-product-floor:1\n',
    artifact_kind: 'profile',
    target_format: null,
  },
  {
    artifact_path: 'safety/local_single_user_retention@1.json',
    artifact_format: 'icarus.workflow-runtime-retention-policy/1',
    ref_id: 'icarus.local-single-user-retention',
    domain_separator: 'icarus:workflow-runtime-retention-policy:1\n',
    artifact_kind: 'profile',
    target_format: null,
  },
  {
    artifact_path: 'sqlite/local_single_user_sqlite@1.json',
    artifact_format: 'icarus.sqlite-execution-profile/1',
    ref_id: 'icarus.local-single-user-sqlite',
    domain_separator: 'icarus:sqlite-execution-profile:1\n',
    artifact_kind: 'profile',
    target_format: null,
  },
  {
    artifact_path: 'safety/local_single_user_safety_enforcement_matrix@1.json',
    artifact_format: 'icarus.workflow-safety-enforcement-matrix/1',
    ref_id: 'icarus.local-single-user-safety-enforcement-matrix',
    domain_separator: 'icarus:workflow-safety-enforcement-matrix:1\n',
    artifact_kind: 'matrix',
    target_format: null,
  },
] as const satisfies readonly SafetySqliteArtifactDescriptor[];

export const SAFETY_SQLITE_SCHEMA_FORMAT_BY_TARGET = Object.fromEntries(
  SAFETY_SQLITE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.target_format !== null,
  ).map((descriptor) => [
    descriptor.target_format!,
    descriptor.artifact_format,
  ]),
) as Record<string, string>;

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

function integerSchema(minimum = 1): Schema {
  return { type: 'integer', minimum, maximum: SAFE_INTEGER_MAX };
}

function stringSchema(options: JsonObject = {}): Schema {
  return { type: 'string', ...options };
}

function nullableString(options: JsonObject = {}): Schema {
  return { anyOf: [stringSchema(options), { type: 'null' }] };
}

function object(
  properties: Record<string, Schema>,
  optional: readonly string[] = [],
): Schema {
  const optionalSet = new Set(optional);
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optionalSet.has(key)),
    properties,
  };
}

function schemaDocument(
  id: string,
  title: string,
  root: Schema,
  defs: Record<string, Schema> = {},
): Schema {
  return {
    $schema: DRAFT_2020_12,
    $id: id,
    title,
    ...root,
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  };
}

const hashSchema = stringSchema({ pattern: SHA256_PATTERN });
const versionedRefSchema = object({
  id: stringSchema({
    minLength: 1,
    maxLength: 255,
    pattern: VERSIONED_REF_ID_PATTERN,
  }),
  version: stringSchema({
    minLength: 1,
    maxLength: 64,
    pattern: VERSIONED_REF_VERSION_PATTERN,
    not: {
      anyOf: [
        {
          pattern:
            '^(?:[Cc][Uu][Rr][Rr][Ee][Nn][Tt]|[Hh][Ee][Aa][Dd]|[Ll][Aa][Tt][Ee][Ss][Tt]|[Mm][Aa][Ii][Nn]|[Mm][Aa][Ss][Tt][Ee][Rr]|[Nn][Ee][Xx][Tt]|[Ss][Nn][Aa][Pp][Ss][Hh][Oo][Tt])$',
        },
        { pattern: '(?:^|[._-])[xX](?:$|[._-])' },
      ],
    },
  }),
});

function exactPositiveIntegerObject(keys: readonly string[]): Schema {
  return object(
    Object.fromEntries(keys.map((key) => [key, integerSchema()])) as Record<
      string,
      Schema
    >,
  );
}

function safetyProfileSchema(): Schema {
  const ceilingGroups = Object.fromEntries(
    Object.entries(SAFETY_CEILING_GROUP_KEYS).map(([group, keys]) => [
      group,
      exactPositiveIntegerObject(keys),
    ]),
  ) as Record<string, Schema>;
  return schemaDocument(
    'urn:icarus:workflow-runtime-safety-profile:1',
    'Workflow Runtime Safety Profile v1 payload',
    object({
      profile_id: { const: 'local_single_user_safety@1' },
      deployment_profile: { const: 'local_single_user' },
      mutability: { const: 'immutable_versioned' },
      pinning_scope: { const: 'workflow_and_run_creation' },
      ceilings: object(ceilingGroups),
    }),
  );
}

function capacitySchema(): Schema {
  return schemaDocument(
    'urn:icarus:deployment-runtime-capacity:1',
    'Deployment Runtime Capacity v1',
    object({
      max_active_executions: integerSchema(),
      max_active_waits: integerSchema(),
      max_pending_signals: integerSchema(),
      max_outbox_inflight: integerSchema(),
      max_physical_blob_bytes: integerSchema(),
      soft_blob_high_water_bytes: integerSchema(),
      minimum_free_disk_bytes: integerSchema(),
      config_hash: hashSchema,
    }),
  );
}

function productFloorSchema(): Schema {
  return schemaDocument(
    'urn:icarus:workflow-runtime-product-floor:1',
    'Workflow Runtime Product Floor v1 payload',
    object({
      profile_id: { const: 'local_single_user_product_floor@1' },
      deployment_profile: { const: 'local_single_user' },
      runtime_surface: { const: 'node_service' },
      platform: { const: 'darwin' },
      arch: { const: 'arm64' },
      semantics: { const: 'minimum_certified_values' },
      limits: exactPositiveIntegerObject(PRODUCT_FLOOR_LIMIT_KEYS),
      benchmark_requirements: object({
        reference_machine_minimum: { const: 'apple_silicon_m2' },
        minimum_memory_gib: integerSchema(16),
        filesystem_type: { const: 'apfs' },
        storage_class: { const: 'internal_ssd' },
        power_source: { const: 'ac_power' },
        build_kind: { const: 'release' },
        concurrent_benchmark_interference: { const: 'forbidden' },
        warmup_iterations: integerSchema(10),
        measurement_iterations: integerSchema(100),
        scaling_profiles_percent: {
          type: 'array',
          prefixItems: [{ const: 25 }, { const: 50 }, { const: 100 }],
          items: false,
          minItems: 3,
          maxItems: 3,
        },
        required_report_metrics: {
          type: 'array',
          prefixItems: [
            { const: 'p50_ms' },
            { const: 'p95_ms' },
            { const: 'p99_ms' },
            { const: 'max_ms' },
            { const: 'wal_bytes' },
            { const: 'peak_rss_bytes' },
            { const: 'affected_rows' },
          ],
          items: false,
          minItems: 7,
          maxItems: 7,
        },
        beyond_limit_rejection: { const: 'before_atomic_write' },
        t3_p99_budget_ms: integerSchema(),
        t7_root_fence_p99_budget_ms: integerSchema(),
        t8_required_child_p99_budget_ms: integerSchema(),
        max_to_p99_budget_multiplier: integerSchema(2),
      }),
    }),
  );
}

function retentionSchema(): Schema {
  return schemaDocument(
    'urn:icarus:workflow-runtime-retention-policy:1',
    'Workflow Runtime Retention Policy v1 payload',
    object({
      profile_id: { const: 'local_single_user_retention@1' },
      deployment_profile: { const: 'local_single_user' },
      mutability: { const: 'immutable_versioned' },
      durations_ms: exactPositiveIntegerObject(RETENTION_DURATION_KEYS),
      rules: object({
        duration_origin: { const: 'entered_eligible_state_at_ms' },
        run_recovery_strong_states: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['active', 'closing', 'action_required', 'quarantined'],
          },
          minItems: 4,
          maxItems: 4,
          uniqueItems: true,
        },
        user_artifact_not_before_workflow_closed: { const: true },
        feature_policy_may_only_extend_user_artifact: { const: true },
        manual_pin_may_extend_backup: { const: true },
        existing_objects_pin_policy_ref_and_hash: { const: true },
      }),
    }),
  );
}

function enforcementMatrixSchema(): Schema {
  const record = object({
    limit_path: stringSchema({ pattern: LIMIT_PATH_PATTERN }),
    business_limit_path: nullableString({ pattern: LIMIT_PATH_PATTERN }),
    resource_type: nullableString({ pattern: '^[a-z][a-z0-9_]*$' }),
    account_scope: nullableString({ pattern: '^[a-z][a-z0-9_]*$' }),
    consumer_kind: nullableString({ pattern: '^[a-z][a-z0-9_]*$' }),
    enforcement_component: stringSchema({ pattern: '^[a-z][a-z0-9_]*$' }),
    reservation_point: nullableString({
      pattern: '^[A-Za-z0-9][A-Za-z0-9_]*$',
    }),
    settlement_mode: {
      enum: ['consume_on_create', 'hold_then_release', 'incremental', null],
    },
    failure_code: stringSchema({ pattern: '^[a-z][a-z0-9_]*$' }),
    failure_outcome: stringSchema({ pattern: '^[a-z][a-z0-9_]*$' }),
    included_in_plan_hash: { type: 'boolean' },
    supported_limit_path: nullableString({ pattern: LIMIT_PATH_PATTERN }),
    t7_fence_dimension: nullableString({ pattern: LIMIT_PATH_PATTERN }),
    record_hash: hashSchema,
  });
  return schemaDocument(
    'urn:icarus:workflow-safety-enforcement-matrix:1',
    'Workflow Safety Enforcement Matrix v1 payload',
    object({
      matrix_id: { const: 'local_single_user_safety_enforcement_matrix@1' },
      safety_profile_ref: ref('versioned_ref'),
      safety_profile_hash: hashSchema,
      capacity_config_hash: hashSchema,
      safety_limit_count: { const: SAFETY_LIMIT_PATHS.length },
      capacity_limit_count: { const: CAPACITY_LIMIT_PATHS.length },
      records: {
        type: 'array',
        items: ref('enforcement_record'),
        minItems: SAFETY_LIMIT_PATHS.length + CAPACITY_LIMIT_PATHS.length,
        maxItems: SAFETY_LIMIT_PATHS.length + CAPACITY_LIMIT_PATHS.length,
      },
    }),
    { versioned_ref: versionedRefSchema, enforcement_record: record },
  );
}

function sqliteProfileSchema(): Schema {
  return schemaDocument(
    'urn:icarus:sqlite-execution-profile:1',
    'SQLite Execution Profile v1 candidate payload',
    object({
      profile_id: { const: 'local_single_user_sqlite@1' },
      certification_status: { const: 'candidate' },
      deployment_profile: { const: 'local_single_user' },
      runtime_surface: { const: 'node_service' },
      platform: { const: 'darwin' },
      arch: { const: 'arm64' },
      journal_mode: { const: 'wal' },
      synchronous: { const: 'full' },
      foreign_keys: { const: true },
      busy_timeout_ms: integerSchema(),
      page_size: integerSchema(),
      auto_vacuum: { const: 'incremental' },
      temp_store: { const: 'memory' },
      wal_autocheckpoint_pages: integerSchema(),
      journal_size_limit_bytes: integerSchema(),
      cache_size_kib: integerSchema(),
      mmap_size_bytes: { const: 0 },
      trusted_schema: { const: false },
      recursive_triggers: { const: false },
      read_uncommitted: { const: false },
      locking_mode: { const: 'normal' },
      read_only_query_only: { const: true },
      sqlite_version: { type: 'null' },
      sqlite_source_id: { type: 'null' },
      sqlite_compile_options_hash: { type: 'null' },
      better_sqlite3_version: { const: '12.11.1' },
      better_sqlite3_native_module_hash: { type: 'null' },
      managed_node_distribution_ref: ref('versioned_ref'),
      managed_node_distribution_hash: hashSchema,
      node_runtime_version: { const: '26.5.0' },
      node_executable_hash: hashSchema,
      release_artifact_hash: { type: 'null' },
      runtime_launcher_hash: { type: 'null' },
      identity_binding_rule: { const: 'release_build_generated_at_g8' },
      profile_application: {
        const: 'immutable_restart_and_recertification_required',
      },
    }),
    { versioned_ref: versionedRefSchema },
  );
}

const SCHEMA_PAYLOADS: Record<string, Schema> = {
  'icarus.workflow-runtime-safety-profile-schema/1': safetyProfileSchema(),
  'icarus.deployment-runtime-capacity-schema/1': capacitySchema(),
  'icarus.workflow-runtime-product-floor-schema/1': productFloorSchema(),
  'icarus.workflow-runtime-retention-policy-schema/1': retentionSchema(),
  'icarus.workflow-safety-enforcement-matrix-schema/1':
    enforcementMatrixSchema(),
  'icarus.sqlite-execution-profile-schema/1': sqliteProfileSchema(),
};

function detachedObject(value: unknown): JsonObject {
  const detached = strictParseJson(JSON.stringify(value));
  assertJsonObject(detached);
  return detached;
}

export function buildSafetySqliteArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: unknown,
): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload: detachedObject(payload),
  };
  return { ...artifact, hash: calculateArtifactHash(artifact) };
}

export function buildDeploymentRuntimeCapacityBaseline(): DeploymentRuntimeCapacity {
  const payload = detachedObject(
    DEPLOYMENT_RUNTIME_CAPACITY_BASELINE_WITHOUT_HASH,
  );
  return {
    ...DEPLOYMENT_RUNTIME_CAPACITY_BASELINE_WITHOUT_HASH,
    config_hash: domainSeparatedSha256(
      'icarus:deployment-runtime-capacity:1\n',
      payload,
    ),
  };
}

export function buildSafetyEnforcementRecords(): WorkflowSafetyEnforcementRecord[] {
  return SAFETY_ENFORCEMENT_RECORD_SEEDS.map((seed) => {
    const payload = detachedObject(seed);
    return {
      ...seed,
      record_hash: domainSeparatedSha256(
        'icarus:workflow-safety-enforcement-record:1\n',
        payload,
      ),
    };
  });
}

function schemaArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  return SAFETY_SQLITE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.artifact_kind === 'schema',
  ).map((descriptor) => [
    descriptor.artifact_path,
    buildSafetySqliteArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      SCHEMA_PAYLOADS[descriptor.artifact_format]!,
    ),
  ]);
}

export function buildSafetySqliteSemanticArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  const safetyDescriptor = SAFETY_SQLITE_ARTIFACT_DESCRIPTORS.find(
    (descriptor) =>
      descriptor.artifact_format === 'icarus.workflow-runtime-safety-profile/1',
  )!;
  const safetyArtifact = buildSafetySqliteArtifact(
    safetyDescriptor.artifact_format,
    safetyDescriptor.ref_id,
    safetyDescriptor.domain_separator,
    LOCAL_SINGLE_USER_SAFETY_PROFILE,
  );
  const capacity = buildDeploymentRuntimeCapacityBaseline();
  const matrixDescriptor = SAFETY_SQLITE_ARTIFACT_DESCRIPTORS.find(
    (descriptor) =>
      descriptor.artifact_format ===
      'icarus.workflow-safety-enforcement-matrix/1',
  )!;
  const profilePayloads: Record<string, unknown> = {
    'icarus.workflow-runtime-product-floor/1': LOCAL_SINGLE_USER_PRODUCT_FLOOR,
    'icarus.workflow-runtime-retention-policy/1':
      LOCAL_SINGLE_USER_RETENTION_POLICY,
    'icarus.sqlite-execution-profile/1': LOCAL_SINGLE_USER_SQLITE_CANDIDATE,
  };
  const profiles = SAFETY_SQLITE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) =>
      descriptor.artifact_kind === 'profile' &&
      descriptor.artifact_format !== 'icarus.workflow-runtime-safety-profile/1',
  ).map(
    (descriptor) =>
      [
        descriptor.artifact_path,
        buildSafetySqliteArtifact(
          descriptor.artifact_format,
          descriptor.ref_id,
          descriptor.domain_separator,
          profilePayloads[descriptor.artifact_format]!,
        ),
      ] as [string, ContractArtifactEnvelope],
  );
  const matrixArtifact = buildSafetySqliteArtifact(
    matrixDescriptor.artifact_format,
    matrixDescriptor.ref_id,
    matrixDescriptor.domain_separator,
    {
      matrix_id: 'local_single_user_safety_enforcement_matrix@1',
      safety_profile_ref: safetyArtifact.ref,
      safety_profile_hash: safetyArtifact.hash,
      capacity_config_hash: capacity.config_hash,
      safety_limit_count: SAFETY_LIMIT_PATHS.length,
      capacity_limit_count: CAPACITY_LIMIT_PATHS.length,
      records: buildSafetyEnforcementRecords(),
    },
  );
  return [
    ...schemaArtifacts(),
    [safetyDescriptor.artifact_path, safetyArtifact],
    ...profiles,
    [matrixDescriptor.artifact_path, matrixArtifact],
  ];
}

export const SAFETY_SQLITE_TYPESCRIPT_KEYS = {
  'icarus.workflow-runtime-safety-profile/1': [
    'profile_id',
    'deployment_profile',
    'mutability',
    'pinning_scope',
    'ceilings',
  ],
  'icarus.deployment-runtime-capacity/1': DEPLOYMENT_CAPACITY_KEYS,
  'icarus.workflow-runtime-product-floor/1': [
    'profile_id',
    'deployment_profile',
    'runtime_surface',
    'platform',
    'arch',
    'semantics',
    'limits',
    'benchmark_requirements',
  ],
  'icarus.workflow-runtime-retention-policy/1': [
    'profile_id',
    'deployment_profile',
    'mutability',
    'durations_ms',
    'rules',
  ],
  'icarus.workflow-safety-enforcement-matrix/1': [
    'matrix_id',
    'safety_profile_ref',
    'safety_profile_hash',
    'capacity_config_hash',
    'safety_limit_count',
    'capacity_limit_count',
    'records',
  ],
  'icarus.sqlite-execution-profile/1': SQLITE_PROFILE_KEYS,
} as const;

export const SAFETY_SQLITE_NESTED_TYPESCRIPT_KEYS = {
  product_floor_limits: PRODUCT_FLOOR_LIMIT_KEYS,
  product_floor_benchmark: PRODUCT_FLOOR_BENCHMARK_KEYS,
  retention_durations: RETENTION_DURATION_KEYS,
  retention_rules: RETENTION_RULE_KEYS,
  enforcement_record: ENFORCEMENT_RECORD_KEYS,
} as const;

export function payloadAsJsonValue(value: unknown): JsonValue {
  return strictParseJson(JSON.stringify(value));
}
