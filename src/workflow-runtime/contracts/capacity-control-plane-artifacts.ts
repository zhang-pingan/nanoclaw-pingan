import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import {
  FOREIGN_KEY_ACTIONS,
  FOREIGN_KEY_DEFERRABILITY,
  INDEX_INTENT_KINDS,
  LOGICAL_CHECK_KINDS,
  LOGICAL_COLUMN_TYPES,
  QUERY_OWNERS,
  SAFE_INTEGER_INTENTS,
  SQLITE_TYPE_INTENTS,
} from './logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';
import {
  CAPACITY_ADMIN_ACTOR_KINDS,
  CAPACITY_ADMIN_COMMAND_TYPES,
  CAPACITY_ADMIN_DENIAL_CODES,
  CAPACITY_ADMIN_HUMAN_ENTRYPOINTS,
  CAPACITY_ADMIN_PERMISSION_CODES,
  CAPACITY_CHANGE_REASON_CODES,
  CAPACITY_FIXTURE_AREAS,
  CAPACITY_INVENTORY_CLASSES,
  CAPACITY_MARKDOWN_DELTA_CATEGORIES,
  CAPACITY_PROTOCOL_IDS,
  type CapacityArtifactInventory,
  type CapacityConformanceCaseArtifact,
  type CapacityGateReview,
  type CapacityLogicalSchemaDelta,
  type CapacityMarkdownDeltaCoverage,
  type CapacityProtocolCatalog,
  type CapacityDenialCatalogEntry,
  type CapacityPermissionCatalogEntry,
  type CapacityReasonCatalogEntry,
} from './capacity-control-plane-types.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const PATH_PATTERN = '^[A-Za-z0-9._@/-]+$';
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$';
const addendumRoot = 'conformance/capacity-control-plane-addendum';
type Schema = JsonObject;

export interface CapacityControlPlaneArtifactDescriptor {
  artifact_path: string;
  artifact_format: string;
  ref_id: string;
  domain_separator: string;
  artifact_kind:
    | 'schema'
    | 'catalog'
    | 'protocol'
    | 'logical_schema_delta'
    | 'coverage'
    | 'inventory'
    | 'gate_review'
    | 'fixture';
  target_format: string | null;
}

const schemaDescriptors = [
  [
    'deployment-runtime-capacity-publication-schema',
    'icarus.deployment-runtime-capacity-publication-schema/1',
    'icarus.deployment-runtime-capacity-publication-schema',
    'icarus:deployment-runtime-capacity-publication-schema:1\n',
    'icarus.deployment-runtime-capacity-publication/1',
  ],
  [
    'capacity-admin-command-schema',
    'icarus.capacity-admin-command-schema/1',
    'icarus.capacity-admin-command-schema',
    'icarus:capacity-admin-command-schema:1\n',
    'icarus.capacity-admin-command/1',
  ],
  [
    'capacity-permission-catalog-schema',
    'icarus.workflow-capacity-permission-catalog-schema/1',
    'icarus.workflow-capacity-permission-catalog-schema',
    'icarus:workflow-capacity-permission-catalog-schema:1\n',
    'icarus.workflow-capacity-permission-catalog/1',
  ],
  [
    'capacity-reason-catalog-schema',
    'icarus.workflow-capacity-reason-catalog-schema/1',
    'icarus.workflow-capacity-reason-catalog-schema',
    'icarus:workflow-capacity-reason-catalog-schema:1\n',
    'icarus.workflow-capacity-reason-catalog/1',
  ],
  [
    'capacity-denial-catalog-schema',
    'icarus.workflow-capacity-denial-catalog-schema/1',
    'icarus.workflow-capacity-denial-catalog-schema',
    'icarus:workflow-capacity-denial-catalog-schema:1\n',
    'icarus.workflow-capacity-denial-catalog/1',
  ],
  [
    'capacity-control-plane-protocol-schema',
    'icarus.workflow-capacity-control-plane-protocol-schema/1',
    'icarus.workflow-capacity-control-plane-protocol-schema',
    'icarus:workflow-capacity-control-plane-protocol-schema:1\n',
    'icarus.workflow-capacity-control-plane-protocol/1',
  ],
  [
    'capacity-logical-schema-delta-schema',
    'icarus.workflow-capacity-control-plane-logical-schema-delta-schema/1',
    'icarus.workflow-capacity-control-plane-logical-schema-delta-schema',
    'icarus:workflow-capacity-control-plane-logical-schema-delta-schema:1\n',
    'icarus.workflow-capacity-control-plane-logical-schema-delta/1',
  ],
  [
    'capacity-markdown-delta-coverage-schema',
    'icarus.workflow-capacity-control-plane-markdown-delta-coverage-schema/1',
    'icarus.workflow-capacity-control-plane-markdown-delta-coverage-schema',
    'icarus:workflow-capacity-control-plane-markdown-delta-coverage-schema:1\n',
    'icarus.workflow-capacity-control-plane-markdown-delta-coverage/1',
  ],
  [
    'capacity-artifact-inventory-schema',
    'icarus.workflow-capacity-control-plane-artifact-inventory-schema/1',
    'icarus.workflow-capacity-control-plane-artifact-inventory-schema',
    'icarus:workflow-capacity-control-plane-artifact-inventory-schema:1\n',
    'icarus.workflow-capacity-control-plane-artifact-inventory/1',
  ],
  [
    'capacity-gate-review-schema',
    'icarus.workflow-capacity-control-plane-gate-review-schema/1',
    'icarus.workflow-capacity-control-plane-gate-review-schema',
    'icarus:workflow-capacity-control-plane-gate-review-schema:1\n',
    'icarus.workflow-capacity-control-plane-gate-review/1',
  ],
  [
    'capacity-positive-cases-schema',
    'icarus.workflow-capacity-control-plane-positive-cases-schema/1',
    'icarus.workflow-capacity-control-plane-positive-cases-schema',
    'icarus:workflow-capacity-control-plane-positive-cases-schema:1\n',
    'icarus.workflow-capacity-control-plane-positive-cases/1',
  ],
  [
    'capacity-negative-cases-schema',
    'icarus.workflow-capacity-control-plane-negative-cases-schema/1',
    'icarus.workflow-capacity-control-plane-negative-cases-schema',
    'icarus:workflow-capacity-control-plane-negative-cases-schema:1\n',
    'icarus.workflow-capacity-control-plane-negative-cases/1',
  ],
  [
    'capacity-fault-cases-schema',
    'icarus.workflow-capacity-control-plane-fault-cases-schema/1',
    'icarus.workflow-capacity-control-plane-fault-cases-schema',
    'icarus:workflow-capacity-control-plane-fault-cases-schema:1\n',
    'icarus.workflow-capacity-control-plane-fault-cases/1',
  ],
] as const;

const semanticDescriptors = [
  [
    'catalogs/capacity-permission-catalog.json',
    'icarus.workflow-capacity-permission-catalog/1',
    'icarus.workflow-capacity-permission-catalog',
    'icarus:workflow-capacity-permission-catalog:1\n',
    'catalog',
  ],
  [
    'catalogs/capacity-reason-catalog.json',
    'icarus.workflow-capacity-reason-catalog/1',
    'icarus.workflow-capacity-reason-catalog',
    'icarus:workflow-capacity-reason-catalog:1\n',
    'catalog',
  ],
  [
    'catalogs/capacity-denial-catalog.json',
    'icarus.workflow-capacity-denial-catalog/1',
    'icarus.workflow-capacity-denial-catalog',
    'icarus:workflow-capacity-denial-catalog:1\n',
    'catalog',
  ],
  [
    'protocols/capacity-control-plane-protocol@1.json',
    'icarus.workflow-capacity-control-plane-protocol/1',
    'icarus.workflow-capacity-control-plane-protocol',
    'icarus:workflow-capacity-control-plane-protocol-artifact:1\n',
    'protocol',
  ],
  [
    'sqlite/capacity-control-plane-logical-schema-delta@1.json',
    'icarus.workflow-capacity-control-plane-logical-schema-delta/1',
    'icarus.workflow-capacity-control-plane-logical-schema-delta',
    'icarus:workflow-capacity-control-plane-logical-schema-delta-artifact:1\n',
    'logical_schema_delta',
  ],
  [
    'markdown-delta-coverage@1.json',
    'icarus.workflow-capacity-control-plane-markdown-delta-coverage/1',
    'icarus.workflow-capacity-control-plane-markdown-delta-coverage',
    'icarus:workflow-capacity-control-plane-markdown-delta-coverage-artifact:1\n',
    'coverage',
  ],
  [
    'artifact-inventory@1.json',
    'icarus.workflow-capacity-control-plane-artifact-inventory/1',
    'icarus.workflow-capacity-control-plane-artifact-inventory',
    'icarus:workflow-capacity-control-plane-artifact-inventory-artifact:1\n',
    'inventory',
  ],
  [
    'gate-review@1.json',
    'icarus.workflow-capacity-control-plane-gate-review/1',
    'icarus.workflow-capacity-control-plane-gate-review',
    'icarus:workflow-capacity-control-plane-gate-review-artifact:1\n',
    'gate_review',
  ],
  [
    'positive-cases.json',
    'icarus.workflow-capacity-control-plane-positive-cases/1',
    'icarus.workflow-capacity-control-plane-positive-cases',
    'icarus:workflow-capacity-control-plane-positive-cases:1\n',
    'fixture',
  ],
  [
    'negative-cases.json',
    'icarus.workflow-capacity-control-plane-negative-cases/1',
    'icarus.workflow-capacity-control-plane-negative-cases',
    'icarus:workflow-capacity-control-plane-negative-cases:1\n',
    'fixture',
  ],
  [
    'fault-cases.json',
    'icarus.workflow-capacity-control-plane-fault-cases/1',
    'icarus.workflow-capacity-control-plane-fault-cases',
    'icarus:workflow-capacity-control-plane-fault-cases:1\n',
    'fixture',
  ],
] as const;

export const CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS = [
  ...schemaDescriptors.map(
    ([fileName, format, refId, domainSeparator, targetFormat]) => ({
      artifact_path: `${addendumRoot}/schemas/${fileName}.json`,
      artifact_format: format,
      ref_id: refId,
      domain_separator: domainSeparator,
      artifact_kind: 'schema' as const,
      target_format: targetFormat,
    }),
  ),
  ...semanticDescriptors.map(
    ([relativePath, format, refId, domainSeparator, artifactKind]) => ({
      artifact_path: `${addendumRoot}/${relativePath}`,
      artifact_format: format,
      ref_id: refId,
      domain_separator: domainSeparator,
      artifact_kind:
        artifactKind as CapacityControlPlaneArtifactDescriptor['artifact_kind'],
      target_format: null,
    }),
  ),
] as const satisfies readonly CapacityControlPlaneArtifactDescriptor[];

export const CAPACITY_CONTROL_PLANE_SCHEMA_FORMAT_BY_TARGET =
  Object.fromEntries(
    CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS.filter(
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
  return { type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER };
}

const hash = string({ pattern: HASH_PATTERN });
const id = string({ minLength: 1, maxLength: 256, pattern: ID_PATTERN });
const relativePath = string({ minLength: 1, pattern: PATH_PATTERN });
const nullableHash = { oneOf: [hash, { type: 'null' }] };
const nullableString = { oneOf: [string({ minLength: 1 }), { type: 'null' }] };

function schemaDocument(
  idValue: string,
  title: string,
  payload: Schema,
): Schema {
  return { $schema: DRAFT_2020_12, $id: idValue, title, ...payload };
}

function capacitySnapshotSchema(): Schema {
  return object({
    max_active_executions: integer(1),
    max_active_waits: integer(1),
    max_pending_signals: integer(1),
    max_outbox_inflight: integer(1),
    max_physical_blob_bytes: integer(1),
    soft_blob_high_water_bytes: integer(1),
    minimum_free_disk_bytes: integer(1),
    config_hash: hash,
  });
}

function publicationSchema(): Schema {
  return schemaDocument(
    'urn:icarus:deployment-runtime-capacity-publication:1',
    'Deployment Runtime Capacity Publication v1',
    object({
      format: { const: 'icarus.deployment-runtime-capacity-publication/1' },
      deployment_profile: { const: 'local_single_user' },
      capacity_revision: integer(1),
      capacity_change_id: id,
      previous_config_hash: nullableHash,
      capacity: capacitySnapshotSchema(),
      publication_hash: hash,
    }),
  );
}

function capacityAdminCommandSchema(): Schema {
  const common = {
    command_id: id,
    idempotency_key: id,
    proposed_capacity: capacitySnapshotSchema(),
    evidence_refs: array(id, 0, true),
  };
  return schemaDocument(
    'urn:icarus:capacity-admin-command:1',
    'Capacity Admin Command closed union v1',
    {
      oneOf: [
        object({
          command_type: { const: 'initialize_deployment_capacity' },
          ...common,
          reason_code: { const: 'initial_provisioning' },
          core_release_hash: hash,
        }),
        object({
          command_type: { const: 'replace_deployment_capacity' },
          ...common,
          expected_capacity_revision: integer(1),
          expected_config_hash: hash,
          reason_code: {
            enum: CAPACITY_CHANGE_REASON_CODES.filter(
              (value) => value !== 'initial_provisioning',
            ),
          },
          reason_text: string({ minLength: 1, maxLength: 4096 }),
        }),
      ],
    },
  );
}

function permissionCatalogSchema(): Schema {
  const entry = object({
    permission: { enum: [...CAPACITY_ADMIN_PERMISSION_CODES] },
    scope: { const: 'deployment' },
    allowed_actor_kinds: { const: ['human'] },
    production_principal: { const: 'human:local-owner' },
    allowed_entrypoints: { const: [...CAPACITY_ADMIN_HUMAN_ENTRYPOINTS] },
    delegation: { const: 'forbidden' },
    workflow_ownership_derivation: { const: 'forbidden' },
    feature_manifest_ceiling_derivation: { const: 'forbidden' },
  });
  return schemaDocument(
    'urn:icarus:workflow-capacity-permission-catalog:1',
    'Capacity Permission Catalog v1',
    object({
      format: { const: 'icarus.workflow-capacity-permission-catalog/1' },
      permission_codes: { const: [...CAPACITY_ADMIN_PERMISSION_CODES] },
      entries: array(entry, 1),
      catalog_hash: hash,
    }),
  );
}

function reasonCatalogSchema(): Schema {
  const entry = object({
    reason_code: { enum: [...CAPACITY_CHANGE_REASON_CODES] },
    allowed_command_types: array(
      { enum: [...CAPACITY_ADMIN_COMMAND_TYPES] },
      1,
      true,
    ),
    reason_text_required: { type: 'boolean' },
    evidence_required: { type: 'boolean' },
    minimum_evidence_refs: integer(),
  });
  return schemaDocument(
    'urn:icarus:workflow-capacity-reason-catalog:1',
    'Capacity Reason Catalog v1',
    object({
      format: { const: 'icarus.workflow-capacity-reason-catalog/1' },
      reason_codes: { const: [...CAPACITY_CHANGE_REASON_CODES] },
      entries: array(entry, CAPACITY_CHANGE_REASON_CODES.length),
      catalog_hash: hash,
    }),
  );
}

function denialCatalogSchema(): Schema {
  const entry = object({
    denial_code: { enum: [...CAPACITY_ADMIN_DENIAL_CODES] },
    retryability: {
      enum: [
        'never_same_request',
        'refresh_head_and_resubmit',
        'retry_same_request',
      ],
    },
    head_mutation: { const: 'forbidden' },
    pending_change_creation: { const: 'forbidden' },
    invocation_audit: { const: 'required_after_authentication' },
  });
  return schemaDocument(
    'urn:icarus:workflow-capacity-denial-catalog:1',
    'Capacity Denial Catalog v1',
    object({
      format: { const: 'icarus.workflow-capacity-denial-catalog/1' },
      denial_codes: { const: [...CAPACITY_ADMIN_DENIAL_CODES] },
      entries: array(entry, CAPACITY_ADMIN_DENIAL_CODES.length),
      catalog_hash: hash,
    }),
  );
}

function protocolSchema(): Schema {
  const step = object({
    protocol_id: { enum: [...CAPACITY_PROTOCOL_IDS] },
    name: {
      enum: [
        'authenticate_validate',
        'prepare',
        'install_file',
        'commit_head',
        'watcher_publish',
      ],
    },
    transaction_mode: {
      enum: ['none', 'begin_immediate', 'short_begin_immediate'],
    },
    external_work: {
      enum: ['none', 'filesystem_durability', 'immutable_pointer_swap'],
    },
    preconditions: array(string({ minLength: 1 }), 1),
    atomic_writes: array(string({ minLength: 1 }), 1),
    success_outcome: string({ minLength: 1 }),
    failure_outcomes: array(string({ minLength: 1 }), 1),
    crash_recovery: array(string({ minLength: 1 }), 1),
    forbidden_actions: array(string({ minLength: 1 }), 1),
  });
  const boundary = object({
    boundary_id: id,
    protocol_id: { enum: [...CAPACITY_PROTOCOL_IDS] },
    injected_after: string({ minLength: 1 }),
    committed_head_visibility: { enum: ['old', 'new'] },
    watcher_visibility: { enum: ['old', 'new'] },
    recovery_action: string({ minLength: 1 }),
  });
  return schemaDocument(
    'urn:icarus:workflow-capacity-control-plane-protocol:1',
    'Capacity Control-Plane CAP0-CAP4 Protocol v1',
    object({
      format: { const: 'icarus.workflow-capacity-control-plane-protocol/1' },
      protocol_ids: { const: [...CAPACITY_PROTOCOL_IDS] },
      steps: array(step, CAPACITY_PROTOCOL_IDS.length),
      crash_boundaries: array(boundary, 4),
      protocol_hash: hash,
    }),
  );
}

function externalReferenceSchema(): Schema {
  return object({
    validator_owner: string({ minLength: 1 }),
    reference_domain: string({ minLength: 1 }),
    immutable: { type: 'boolean' },
  });
}

function logicalColumnSchema(): Schema {
  return object({
    ordinal: integer(1),
    name: id,
    logical_type: { enum: [...LOGICAL_COLUMN_TYPES] },
    sqlite_type_intent: { enum: [...SQLITE_TYPE_INTENTS] },
    nullable: { type: 'boolean' },
    default_intent: {},
    safe_integer_intent: { enum: [...SAFE_INTEGER_INTENTS] },
    enum_values: array(string({ minLength: 1 }), 0, true),
    relation_ids: array(id, 0, true),
    external_reference: {
      oneOf: [externalReferenceSchema(), { type: 'null' }],
    },
  });
}

function logicalForeignKeySchema(): Schema {
  return object({
    relation_id: id,
    source_columns: array(id, 1, true),
    target_table: id,
    target_columns: array(id, 1, true),
    on_delete: { enum: [...FOREIGN_KEY_ACTIONS] },
    deferrability: { enum: [...FOREIGN_KEY_DEFERRABILITY] },
  });
}

function logicalUniqueKeySchema(): Schema {
  return object({
    key_id: id,
    columns: array(id, 1, true),
    predicate_intent: nullableString,
  });
}

function logicalCheckSchema(): Schema {
  return object({
    check_id: id,
    kind: { enum: [...LOGICAL_CHECK_KINDS] },
    columns: array(id, 1, true),
    expression_intent: string({ minLength: 1 }),
  });
}

function logicalIndexSchema(): Schema {
  return object({
    index_id: id,
    kind: { enum: [...INDEX_INTENT_KINDS] },
    columns: array(id, 1),
    predicate_intent: nullableString,
    supports_query_ids: array(id, 1, true),
  });
}

function logicalQuerySchema(): Schema {
  return object({
    query_id: id,
    owner: { enum: [...QUERY_OWNERS] },
    purpose: string({ minLength: 1 }),
    table: id,
    join_tables: array(id, 0, true),
    equality_columns: array(id, 0, true),
    range_columns: array(id, 0, true),
    state_predicate_intent: nullableString,
    order_by: array(
      object({ column: id, direction: { enum: ['asc', 'desc'] } }),
    ),
    result_cardinality: {
      enum: ['zero_or_one', 'many', 'bounded_batch'],
    },
    required_index_id: id,
    execution_status: { const: 'intent_only' },
  });
}

function logicalTableSchema(): Schema {
  return object({
    ordinal: integer(1),
    name: {
      enum: [
        'runtime_capacity_head',
        'runtime_capacity_admin_commands',
        'runtime_capacity_admin_invocations',
        'runtime_capacity_change_events',
      ],
    },
    source_section: { const: 'Capacity management publication and audit' },
    columns: array(logicalColumnSchema(), 1),
    primary_key: object({
      columns: array(id, 1, true),
      auto_increment_intent: { type: 'boolean' },
    }),
    foreign_keys: array(logicalForeignKeySchema()),
    unique_keys: array(logicalUniqueKeySchema()),
    checks: array(logicalCheckSchema(), 1),
    indexes: array(logicalIndexSchema()),
  });
}

function logicalDeltaSchema(): Schema {
  const extended = object({
    name: { const: 'workflow_graph_scheduler_admissions' },
    base_table_hash: hash,
    added_columns: array(logicalColumnSchema(), 2),
    added_foreign_keys: array(logicalForeignKeySchema(), 1),
    added_unique_keys: array(logicalUniqueKeySchema()),
    added_checks: array(logicalCheckSchema(), 1),
    added_indexes: array(logicalIndexSchema()),
  });
  return schemaDocument(
    'urn:icarus:workflow-capacity-control-plane-logical-schema-delta:1',
    'Capacity Control-Plane Logical Schema Additive Delta v1',
    object({
      format: {
        const: 'icarus.workflow-capacity-control-plane-logical-schema-delta/1',
      },
      schema_id: { const: 'workflow-runtime-schema-v1' },
      base_logical_schema_manifest_hash: hash,
      delta_mode: { const: 'additive_only' },
      contract_stage: { const: 'logical_metadata' },
      executable_status: { const: 'non_executable' },
      ddl_generation_status: { const: 'forbidden_in_g0_10' },
      sqlite_open_status: { const: 'forbidden_in_g0_10' },
      added_tables: array(logicalTableSchema(), 4),
      extended_tables: array(extended, 1),
      query_intents: array(logicalQuerySchema(), 1),
      invariants: array(string({ minLength: 1 }), 1, true),
      delta_hash: hash,
    }),
  );
}

function coverageSchema(): Schema {
  const entry = object({
    coverage_id: string({ minLength: 1 }),
    category: { enum: [...CAPACITY_MARKDOWN_DELTA_CATEGORIES] },
    value: string({ minLength: 1 }),
    contract_path: relativePath,
    contract_pointer: string({ minLength: 1, pattern: '^/' }),
    markdown_section: string({ minLength: 1 }),
    fixture_refs: array(relativePath, 1, true),
    change_impact: {
      enum: [
        'capacity_contract_version_required',
        'capacity_protocol_and_fixture_update_required',
        'g1_schema_manifest_and_ddl_update_required',
      ],
    },
    entry_hash: hash,
  });
  return schemaDocument(
    'urn:icarus:workflow-capacity-control-plane-markdown-delta-coverage:1',
    'Capacity Control-Plane Markdown Delta Coverage v1',
    object({
      format: {
        const:
          'icarus.workflow-capacity-control-plane-markdown-delta-coverage/1',
      },
      architecture_path: {
        const: 'local/docs/dynamic-workflow-dag-framework.md',
      },
      spec_binding_scope: { const: 'capacity_contract_values_only' },
      prior_g0_9_root_hash: hash,
      extraction_policy: {
        const: 'g0_10_delta_only_no_runtime_markdown_extraction',
      },
      categories: { const: [...CAPACITY_MARKDOWN_DELTA_CATEGORIES] },
      entries: array(entry, 1),
      category_counts: object(
        Object.fromEntries(
          CAPACITY_MARKDOWN_DELTA_CATEGORIES.map((category) => [
            category,
            integer(1),
          ]),
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

function inventorySchema(): Schema {
  const entry = object({
    artifact_id: string({ minLength: 1 }),
    owning_slice: { enum: ['G0.9', 'G0.10'] },
    artifact_class: { enum: [...CAPACITY_INVENTORY_CLASSES] },
    path: relativePath,
    format: string({ minLength: 1 }),
    byte_length: integer(1),
    raw_sha256: hash,
    semantic_hash: hash,
  });
  return schemaDocument(
    'urn:icarus:workflow-capacity-control-plane-artifact-inventory:1',
    'Capacity Control-Plane Artifact Inventory v1',
    object({
      format: {
        const: 'icarus.workflow-capacity-control-plane-artifact-inventory/1',
      },
      inventory_scope: {
        const: 'g0_9_historical_root_and_g0_10_non_recursive_leaf_artifacts',
      },
      closure_policy: {
        const: 'inventory_gate_domain_and_root_owned_by_g0_10_manifest',
      },
      entries: array(entry, 1),
      entry_count: integer(1),
      class_counts: object(
        Object.fromEntries(
          CAPACITY_INVENTORY_CLASSES.map((artifactClass) => [
            artifactClass,
            integer(),
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
  const criterion = object({
    criterion_id: id,
    status: { const: 'pass' },
    evidence_hashes: array(hash, 1),
  });
  const historicalProperties = Object.fromEntries(
    [
      'G0.2',
      'G0.3',
      'G0.4',
      'G0.5',
      'G0.6',
      'G0.7',
      'G0.8',
      'G0.9',
      'capacity_schema',
      'capacity_baseline',
    ].map((key) => [key, hash]),
  );
  return schemaDocument(
    'urn:icarus:workflow-capacity-control-plane-gate-review:1',
    'Capacity Control-Plane Gate Review v1',
    object({
      format: {
        const: 'icarus.workflow-capacity-control-plane-gate-review/1',
      },
      gate_id: { const: 'G0.10' },
      review_kind: { const: 'capacity_control_plane_addendum' },
      decision: { const: 'pass' },
      prior_g0_9_root_hash: hash,
      historical_identity_hashes: object(historicalProperties),
      exit_criteria: array(criterion, 10),
      markdown_delta_coverage_hash: hash,
      artifact_inventory_hash: hash,
      status_proof: object({
        g0_status: { const: 'DONE' },
        i11_status: { const: 'DONE' },
        g1_status: { const: 'READY' },
        g2_status: { const: 'READY' },
        g3_through_g9_status: { const: 'NOT_READY' },
        r014_status: { const: 'CLOSED' },
        executable_ddl_status: { const: 'absent' },
        workflow_runtime_store_status: { const: 'absent' },
        capacity_gateway_status: { const: 'absent' },
        capacity_publisher_status: { const: 'absent' },
        capacity_watcher_status: { const: 'absent' },
        scheduler_status: { const: 'absent' },
        runtime_center_ui_status: { const: 'absent' },
        golden_semantic_review_status: { const: 'absent' },
        golden_seal_status: { const: 'not_run' },
        sealed_directory_entry: { const: '.gitkeep' },
      }),
      review_hash: hash,
    }),
  );
}

function caseArtifactSchema(format: string): Schema {
  const candidate = object({
    case_id: id,
    area: { enum: [...CAPACITY_FIXTURE_AREAS] },
    scenario: id,
    expected_result: string({ minLength: 1 }),
    expected_head_effect: {
      enum: ['unchanged', 'pending_prepared', 'committed'],
    },
    assertion: string({ minLength: 1 }),
  });
  return schemaDocument(
    `urn:${format.replaceAll('.', ':').replace('/', ':')}`,
    `${format} closed fixture artifact`,
    object({
      format: { const: format },
      cases: array(candidate, 1),
      case_count: integer(1),
    }),
  );
}

const SCHEMA_BUILDERS: Record<string, () => Schema> = {
  'icarus.deployment-runtime-capacity-publication/1': publicationSchema,
  'icarus.capacity-admin-command/1': capacityAdminCommandSchema,
  'icarus.workflow-capacity-permission-catalog/1': permissionCatalogSchema,
  'icarus.workflow-capacity-reason-catalog/1': reasonCatalogSchema,
  'icarus.workflow-capacity-denial-catalog/1': denialCatalogSchema,
  'icarus.workflow-capacity-control-plane-protocol/1': protocolSchema,
  'icarus.workflow-capacity-control-plane-logical-schema-delta/1':
    logicalDeltaSchema,
  'icarus.workflow-capacity-control-plane-markdown-delta-coverage/1':
    coverageSchema,
  'icarus.workflow-capacity-control-plane-artifact-inventory/1':
    inventorySchema,
  'icarus.workflow-capacity-control-plane-gate-review/1': gateReviewSchema,
  'icarus.workflow-capacity-control-plane-positive-cases/1': () =>
    caseArtifactSchema(
      'icarus.workflow-capacity-control-plane-positive-cases/1',
    ),
  'icarus.workflow-capacity-control-plane-negative-cases/1': () =>
    caseArtifactSchema(
      'icarus.workflow-capacity-control-plane-negative-cases/1',
    ),
  'icarus.workflow-capacity-control-plane-fault-cases/1': () =>
    caseArtifactSchema('icarus.workflow-capacity-control-plane-fault-cases/1'),
};

function detachedObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function buildCapacityControlPlaneArtifact(
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

export function buildCapacityControlPlaneSchemaArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  return CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.artifact_kind === 'schema',
  ).map((descriptor) => [
    descriptor.artifact_path,
    buildCapacityControlPlaneArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      SCHEMA_BUILDERS[descriptor.target_format!]!(),
    ),
  ]);
}

export function buildCapacityCatalogArtifacts(
  permissions: readonly CapacityPermissionCatalogEntry[],
  reasons: readonly CapacityReasonCatalogEntry[],
  denials: readonly CapacityDenialCatalogEntry[],
): Array<[string, ContractArtifactEnvelope]> {
  const payloads = new Map<string, JsonObject>();
  const permissionWithoutHash = detachedObject({
    format: 'icarus.workflow-capacity-permission-catalog/1' as const,
    permission_codes: [...CAPACITY_ADMIN_PERMISSION_CODES],
    entries: permissions,
  });
  payloads.set('icarus.workflow-capacity-permission-catalog/1', {
    ...permissionWithoutHash,
    catalog_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-permission-catalog-payload:1\n',
      permissionWithoutHash,
    ),
  });
  const reasonWithoutHash = detachedObject({
    format: 'icarus.workflow-capacity-reason-catalog/1' as const,
    reason_codes: [...CAPACITY_CHANGE_REASON_CODES],
    entries: reasons,
  });
  payloads.set('icarus.workflow-capacity-reason-catalog/1', {
    ...reasonWithoutHash,
    catalog_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-reason-catalog-payload:1\n',
      reasonWithoutHash,
    ),
  });
  const denialWithoutHash = detachedObject({
    format: 'icarus.workflow-capacity-denial-catalog/1' as const,
    denial_codes: [...CAPACITY_ADMIN_DENIAL_CODES],
    entries: denials,
  });
  payloads.set('icarus.workflow-capacity-denial-catalog/1', {
    ...denialWithoutHash,
    catalog_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-denial-catalog-payload:1\n',
      denialWithoutHash,
    ),
  });
  return CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.artifact_kind === 'catalog',
  ).map((descriptor) => [
    descriptor.artifact_path,
    buildCapacityControlPlaneArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      payloads.get(descriptor.artifact_format)!,
    ),
  ]);
}

export function buildCapacityProtocolArtifact(
  protocol: CapacityProtocolCatalog,
): [string, ContractArtifactEnvelope] {
  const descriptor = CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS.find(
    (candidate) => candidate.artifact_kind === 'protocol',
  )!;
  return [
    descriptor.artifact_path,
    buildCapacityControlPlaneArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      protocol,
    ),
  ];
}

export function buildCapacityLogicalDeltaArtifact(
  delta: CapacityLogicalSchemaDelta,
): [string, ContractArtifactEnvelope] {
  const descriptor = CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS.find(
    (candidate) => candidate.artifact_kind === 'logical_schema_delta',
  )!;
  return [
    descriptor.artifact_path,
    buildCapacityControlPlaneArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      delta,
    ),
  ];
}

export function buildCapacityFixtureArtifacts(
  positive: CapacityConformanceCaseArtifact,
  negative: CapacityConformanceCaseArtifact,
  fault: CapacityConformanceCaseArtifact,
): Array<[string, ContractArtifactEnvelope]> {
  const payloads = new Map<string, CapacityConformanceCaseArtifact>([
    [positive.format, positive],
    [negative.format, negative],
    [fault.format, fault],
  ]);
  return CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.artifact_kind === 'fixture',
  ).map((descriptor) => [
    descriptor.artifact_path,
    buildCapacityControlPlaneArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      payloads.get(descriptor.artifact_format)!,
    ),
  ]);
}

export function buildCapacityDynamicArtifact(
  kind: 'coverage' | 'inventory' | 'gate_review',
  payload:
    | CapacityMarkdownDeltaCoverage
    | CapacityArtifactInventory
    | CapacityGateReview,
): [string, ContractArtifactEnvelope] {
  const descriptor = CAPACITY_CONTROL_PLANE_ARTIFACT_DESCRIPTORS.find(
    (candidate) => candidate.artifact_kind === kind,
  )!;
  return [
    descriptor.artifact_path,
    buildCapacityControlPlaneArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      payload,
    ),
  ];
}
