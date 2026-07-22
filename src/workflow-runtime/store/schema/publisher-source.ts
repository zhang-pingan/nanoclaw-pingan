import {
  calculateArtifactHash,
  domainSeparatedSha256,
} from '../../contracts/hash.js';
import { LOGICAL_SCHEMA_TABLES } from '../../contracts/logical-schema-source.js';
import type {
  ExternalReferenceMetadata,
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalColumnType,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
  SafeIntegerIntent,
  SqliteTypeIntent,
} from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../../contracts/types.js';

export const PUBLISHER_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-publisher-schema-prerequisite@1.json';
export const PUBLISHER_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-publisher-schema-prerequisite:1\n';
export const PUBLISHER_SCHEMA_DELTA_DOMAIN =
  'icarus:workflow-publisher-logical-schema-delta:1\n';

const G0_6_LOGICAL_SOURCE_HASH =
  'sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214' as const;
const G0_10_CAPACITY_DELTA_HASH =
  'sha256:5d9e79b5f9330a5111e6f61b8d04164c87839a60d55ea350c0aa87b8b1559e66' as const;

interface ColumnSeed {
  name: string;
  logical_type: LogicalColumnType;
  sqlite_type_intent: SqliteTypeIntent;
  nullable: boolean;
  default_intent: JsonValue;
  safe_integer_intent: SafeIntegerIntent;
  enum_values: string[];
  external_reference: ExternalReferenceMetadata | null;
}

interface TableSeed {
  name: string;
  columns: ColumnSeed[];
  primaryKey: string[];
  foreignKeys: LogicalForeignKeyMetadata[];
  uniqueKeys: LogicalUniqueKeyMetadata[];
  checks: LogicalCheckMetadata[];
  indexes: LogicalIndexMetadata[];
}

export interface PublisherSchemaTableExtension {
  name: 'workflow_values';
  base_table_hash: Sha256Hash;
  added_columns: [];
  added_foreign_keys: [];
  added_unique_keys: LogicalUniqueKeyMetadata[];
  added_checks: [];
  added_indexes: [];
}

export interface PublisherSchemaPrerequisitePayload {
  format: 'icarus.workflow-publisher-schema-prerequisite/1';
  schema_id: 'workflow-runtime-schema-v1';
  database_schema_version: 2;
  delta_mode: 'additive_only';
  contract_stage: 'g1_physical_schema_input';
  historical_inputs: {
    g0_6_logical_schema_source_hash: Sha256Hash;
    g0_10_capacity_delta_hash: Sha256Hash;
    identity_policy: 'preserve_exact_historical_artifacts';
  };
  normative_logical_schema_coverage: {
    prior_table_count: 78;
    added_table_count: 3;
    resulting_table_count: 81;
    object_names: string[];
  };
  added_tables: LogicalTableMetadata[];
  extended_tables: PublisherSchemaTableExtension[];
  query_intents: LogicalQueryIntent[];
  trigger_intents: string[];
  constraint_fixture_cases: string[];
  authoritative_existing_tables: string[];
  forbidden_implementation_surfaces: string[];
  delta_hash: Sha256Hash;
}

function column(
  name: string,
  logicalType: LogicalColumnType,
  sqliteType: SqliteTypeIntent,
  nullable = false,
  safeInteger: SafeIntegerIntent = 'not_applicable',
  enumValues: string[] = [],
  externalReference: ExternalReferenceMetadata | null = null,
): ColumnSeed {
  return {
    name,
    logical_type: logicalType,
    sqlite_type_intent: sqliteType,
    nullable,
    default_intent: null,
    safe_integer_intent: safeInteger,
    enum_values: enumValues,
    external_reference: externalReference,
  };
}

const id = (name: string, nullable = false) =>
  column(name, 'identifier', 'TEXT', nullable);
const text = (name: string, nullable = false, values: string[] = []) =>
  column(name, 'text', 'TEXT', nullable, 'not_applicable', values);
const hash = (name: string, nullable = false) =>
  column(name, 'hash', 'TEXT', nullable);
const integer = (
  name: string,
  nullable = false,
  safeInteger: SafeIntegerIntent = 'non_negative',
) => column(name, 'integer', 'INTEGER', nullable, safeInteger);
const at = (name: string, nullable = false) =>
  integer(name, nullable, 'non_negative');
const external = (
  name: string,
  validatorOwner: string,
  referenceDomain: string,
) =>
  column(name, 'external_reference', 'TEXT', false, 'not_applicable', [], {
    validator_owner: validatorOwner,
    reference_domain: referenceDomain,
    immutable: true,
  });

function fk(
  relationId: string,
  sourceColumns: string[],
  targetTable: string,
  targetColumns: string[],
): LogicalForeignKeyMetadata {
  return {
    relation_id: relationId,
    source_columns: sourceColumns,
    target_table: targetTable,
    target_columns: targetColumns,
    on_delete: 'restrict',
    deferrability: 'deferred',
  };
}

function uk(
  keyId: string,
  columns: string[],
  predicateIntent: string | null = null,
): LogicalUniqueKeyMetadata {
  return { key_id: keyId, columns, predicate_intent: predicateIntent };
}

function check(
  checkId: string,
  kind: LogicalCheckMetadata['kind'],
  columns: string[],
  expressionIntent: string,
): LogicalCheckMetadata {
  return {
    check_id: checkId,
    kind,
    columns,
    expression_intent: expressionIntent,
  };
}

function index(
  indexId: string,
  kind: LogicalIndexMetadata['kind'],
  columns: string[],
  predicateIntent: string | null,
  supportsQueryIds: string[],
): LogicalIndexMetadata {
  return {
    index_id: indexId,
    kind,
    columns,
    predicate_intent: predicateIntent,
    supports_query_ids: supportsQueryIds,
  };
}

function automaticChecks(
  tableName: string,
  columns: ColumnSeed[],
): LogicalCheckMetadata[] {
  return columns.flatMap((candidate) => {
    const checks: LogicalCheckMetadata[] = [];
    if (candidate.enum_values.length > 0) {
      checks.push(
        check(
          `ck:${tableName}:${candidate.name}:enum`,
          'enum_membership',
          [candidate.name],
          `value is one of ${candidate.enum_values.join(' | ')}`,
        ),
      );
    }
    if (candidate.logical_type === 'hash') {
      checks.push(
        check(
          `ck:${tableName}:${candidate.name}:hash`,
          'hash_format',
          [candidate.name],
          'nullable or sha256:<64 lowercase hexadecimal characters>',
        ),
      );
    }
    if (candidate.safe_integer_intent !== 'not_applicable') {
      checks.push(
        check(
          `ck:${tableName}:${candidate.name}:safe_integer`,
          'safe_integer',
          [candidate.name],
          `${candidate.safe_integer_intent} JavaScript safe integer`,
        ),
      );
    }
    return checks;
  });
}

function buildTable(seed: TableSeed, ordinal: number): LogicalTableMetadata {
  const columns: LogicalColumnMetadata[] = seed.columns.map(
    (candidate, indexValue) => ({
      ordinal: indexValue + 1,
      ...candidate,
      relation_ids: seed.foreignKeys
        .filter((relation) => relation.source_columns.includes(candidate.name))
        .map((relation) => relation.relation_id)
        .sort(),
    }),
  );
  return {
    ordinal,
    name: seed.name,
    source_section: 'Publisher persistence idempotency and recovery audit',
    columns,
    primary_key: {
      columns: seed.primaryKey,
      auto_increment_intent: false,
    },
    foreign_keys: seed.foreignKeys,
    unique_keys: seed.uniqueKeys,
    checks: [...automaticChecks(seed.name, seed.columns), ...seed.checks],
    indexes: seed.indexes,
  };
}

const schemaBoundValueColumns = (prefix: string, nullable = false) => [
  id(`${prefix}_value_id`, nullable),
  hash(`${prefix}_hash`, nullable),
  id(`${prefix}_schema_resource_id`, nullable),
  hash(`${prefix}_schema_hash`, nullable),
];

const schemaBoundValueFk = (relationId: string, prefix: string) =>
  fk(
    relationId,
    [
      `${prefix}_value_id`,
      `${prefix}_hash`,
      `${prefix}_schema_resource_id`,
      `${prefix}_schema_hash`,
    ],
    'workflow_values',
    ['id', 'content_hash', 'schema_resource_id', 'schema_resource_hash'],
  );

const TABLE_SEEDS: readonly TableSeed[] = [
  {
    name: 'workflow_publisher_commands',
    columns: [
      id('command_id'),
      text('command_type', false, ['staged_publish']),
      text('idempotency_domain'),
      text('idempotency_key'),
      ...schemaBoundValueColumns('request'),
      hash('domain_request_hash'),
      external(
        'approved_review_ref',
        'workflow_authoring_review_registry',
        'approved_workflow_review',
      ),
      hash('approved_review_hash'),
      external(
        'reviewer_actor_ref',
        'publisher_authentication_gateway',
        'authenticated_principal',
      ),
      external(
        'reviewer_auth_session_ref',
        'authentication_service',
        'auth_session',
      ),
      at('approved_at_ms'),
      at('expires_at_ms'),
      ...schemaBoundValueColumns('source_manifest'),
      ...schemaBoundValueColumns('compiled_plan'),
      id('execution_artifact_resource_id'),
      hash('execution_artifact_hash'),
      id('closure_manifest_id'),
      hash('closure_hash'),
      id('target_feature_release_id'),
      hash('target_feature_release_hash'),
      id('applied_feature_release_id', true),
      hash('applied_feature_release_hash', true),
      ...schemaBoundValueColumns('canonical_receipt', true),
      text('lifecycle', false, ['pending', 'applied', 'failed']),
      at('created_at_ms'),
      at('finalized_at_ms', true),
      integer('row_version'),
    ],
    primaryKey: ['command_id'],
    foreignKeys: [
      schemaBoundValueFk('fk:publisher_commands:request_value', 'request'),
      schemaBoundValueFk(
        'fk:publisher_commands:source_manifest_value',
        'source_manifest',
      ),
      schemaBoundValueFk(
        'fk:publisher_commands:compiled_plan_value',
        'compiled_plan',
      ),
      fk(
        'fk:publisher_commands:execution_artifact',
        ['execution_artifact_resource_id', 'execution_artifact_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
      fk(
        'fk:publisher_commands:closure',
        ['closure_manifest_id', 'closure_hash'],
        'workflow_registry_closure_manifests',
        ['id', 'closure_hash'],
      ),
      fk(
        'fk:publisher_commands:target_feature_release',
        ['target_feature_release_id', 'target_feature_release_hash'],
        'workflow_feature_releases',
        ['id', 'release_hash'],
      ),
      fk(
        'fk:publisher_commands:applied_feature_release',
        ['applied_feature_release_id', 'applied_feature_release_hash'],
        'workflow_feature_releases',
        ['id', 'release_hash'],
      ),
      schemaBoundValueFk(
        'fk:publisher_commands:canonical_receipt_value',
        'canonical_receipt',
      ),
    ],
    uniqueKeys: [
      uk('uk:publisher_commands:idempotency', [
        'idempotency_domain',
        'idempotency_key',
      ]),
      uk('uk:publisher_commands:id_domain_request', [
        'command_id',
        'domain_request_hash',
      ]),
    ],
    checks: [
      check(
        'ck:publisher_commands:idempotency_non_empty',
        'state_field_consistency',
        ['idempotency_domain', 'idempotency_key'],
        'caller idempotency domain and key are non-empty bounded tokens',
      ),
      check(
        'ck:publisher_commands:review_window',
        'ordered_values',
        ['approved_at_ms', 'created_at_ms', 'expires_at_ms'],
        'approval precedes command creation and command creation precedes expiry',
      ),
      check(
        'ck:publisher_commands:applied_release_pair',
        'all_or_none',
        ['applied_feature_release_id', 'applied_feature_release_hash'],
        'applied Feature Release id and hash are both null or both non-null',
      ),
      check(
        'ck:publisher_commands:receipt_binding',
        'all_or_none',
        [
          'canonical_receipt_value_id',
          'canonical_receipt_hash',
          'canonical_receipt_schema_resource_id',
          'canonical_receipt_schema_hash',
        ],
        'canonical receipt Value hash and schema identity are all null or all non-null',
      ),
      check(
        'ck:publisher_commands:lifecycle',
        'state_field_consistency',
        [
          'lifecycle',
          'target_feature_release_id',
          'target_feature_release_hash',
          'applied_feature_release_id',
          'applied_feature_release_hash',
          'canonical_receipt_value_id',
          'finalized_at_ms',
        ],
        'pending has no result; applied binds the exact target release and receipt; failed binds only a receipt; terminal states have finalized time',
      ),
    ],
    indexes: [
      index(
        'idx:publisher_commands:idempotency',
        'lookup',
        ['idempotency_domain', 'idempotency_key'],
        null,
        ['publisher_find_idempotency'],
      ),
      index(
        'idx:publisher_commands:pending_recovery',
        'recovery',
        ['created_at_ms', 'command_id'],
        "lifecycle = 'pending'",
        ['publisher_recovery_scan_pending'],
      ),
    ],
  },
  {
    name: 'workflow_publisher_command_invocations',
    columns: [
      id('id'),
      id('command_id'),
      integer('invocation_no', false, 'positive'),
      hash('command_domain_request_hash'),
      hash('submitted_request_hash'),
      external(
        'actor_ref',
        'publisher_authentication_gateway',
        'authenticated_principal',
      ),
      external('auth_session_ref', 'authentication_service', 'auth_session'),
      at('requested_at_ms'),
      text('disposition', false, [
        'applied',
        'duplicate',
        'conflict',
        'failed',
      ]),
      ...schemaBoundValueColumns('result'),
      at('decided_at_ms'),
      at('applied_at_ms', true),
      hash('previous_invocation_hash', true),
      hash('invocation_hash'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:publisher_invocations:command_request',
        ['command_id', 'command_domain_request_hash'],
        'workflow_publisher_commands',
        ['command_id', 'domain_request_hash'],
      ),
      schemaBoundValueFk('fk:publisher_invocations:result_value', 'result'),
    ],
    uniqueKeys: [
      uk('uk:publisher_invocations:command_no', [
        'command_id',
        'invocation_no',
      ]),
      uk('uk:publisher_invocations:invocation_hash', ['invocation_hash']),
    ],
    checks: [
      check(
        'ck:publisher_invocations:result_consistency',
        'state_field_consistency',
        [
          'disposition',
          'command_domain_request_hash',
          'submitted_request_hash',
          'requested_at_ms',
          'decided_at_ms',
          'applied_at_ms',
        ],
        'applied duplicate and failed match the bound request; conflict differs; only applied has applied time; decision does not precede request',
      ),
      check(
        'ck:publisher_invocations:hash_chain',
        'state_field_consistency',
        ['invocation_no', 'previous_invocation_hash', 'invocation_hash'],
        'invocation 1 has no previous hash and later invocations name the adjacent prior hash',
      ),
    ],
    indexes: [
      index(
        'idx:publisher_invocations:command_history',
        'ordering',
        ['command_id', 'invocation_no'],
        null,
        ['publisher_load_invocations'],
      ),
    ],
  },
  {
    name: 'workflow_publisher_events',
    columns: [
      id('command_id'),
      integer('event_no', false, 'positive'),
      integer('attempt_no', false, 'positive'),
      text('phase', false, [
        'authenticate',
        'validate',
        'review',
        'preflight',
        'publish_transaction',
        'recovery',
        'finalize',
      ]),
      text('event_type', false, [
        'attempt_started',
        'phase_succeeded',
        'pre_transaction_failed',
        'publish_transaction_started',
        'publish_committed',
        'recovery_started',
        'recovery_succeeded',
        'recovery_failed',
        'terminal_failed',
      ]),
      text('failure_code', true),
      id('related_feature_release_id', true),
      hash('related_feature_release_hash', true),
      ...schemaBoundValueColumns('detail', true),
      hash('previous_event_hash', true),
      hash('event_hash'),
      at('occurred_at_ms'),
    ],
    primaryKey: ['command_id', 'event_no'],
    foreignKeys: [
      fk(
        'fk:publisher_events:command',
        ['command_id'],
        'workflow_publisher_commands',
        ['command_id'],
      ),
      fk(
        'fk:publisher_events:attempt_invocation',
        ['command_id', 'attempt_no'],
        'workflow_publisher_command_invocations',
        ['command_id', 'invocation_no'],
      ),
      fk(
        'fk:publisher_events:related_feature_release',
        ['related_feature_release_id', 'related_feature_release_hash'],
        'workflow_feature_releases',
        ['id', 'release_hash'],
      ),
      schemaBoundValueFk('fk:publisher_events:detail_value', 'detail'),
    ],
    uniqueKeys: [
      uk('uk:publisher_events:attempt_phase_type', [
        'command_id',
        'attempt_no',
        'phase',
        'event_type',
      ]),
      uk('uk:publisher_events:event_hash', ['event_hash']),
    ],
    checks: [
      check(
        'ck:publisher_events:related_release_pair',
        'all_or_none',
        ['related_feature_release_id', 'related_feature_release_hash'],
        'related Feature Release id and hash are both null or both non-null',
      ),
      check(
        'ck:publisher_events:detail_binding',
        'all_or_none',
        [
          'detail_value_id',
          'detail_hash',
          'detail_schema_resource_id',
          'detail_schema_hash',
        ],
        'detail Value hash and schema identity are all null or all non-null',
      ),
      check(
        'ck:publisher_events:hash_chain',
        'state_field_consistency',
        ['event_no', 'previous_event_hash', 'event_hash'],
        'event 1 has no previous hash and later events name the adjacent prior hash',
      ),
      check(
        'ck:publisher_events:event_mapping',
        'closed_target_mapping',
        ['phase', 'event_type', 'failure_code', 'related_feature_release_id'],
        'pre-transaction failures precede publish; commit and recovery success bind a release; recovery events use recovery phase; terminal failure uses finalize phase',
      ),
    ],
    indexes: [
      index(
        'idx:publisher_events:command_history',
        'ordering',
        ['command_id', 'event_no'],
        null,
        ['publisher_load_events'],
      ),
    ],
  },
];

function query(
  queryId: string,
  owner: LogicalQueryIntent['owner'],
  purpose: string,
  table: string,
  equalityColumns: string[],
  statePredicateIntent: string | null,
  requiredIndexId: string,
  resultCardinality: LogicalQueryIntent['result_cardinality'],
  orderBy: LogicalQueryIntent['order_by'] = [],
): LogicalQueryIntent {
  return {
    query_id: queryId,
    owner,
    purpose,
    table,
    join_tables: [],
    equality_columns: equalityColumns,
    range_columns: [],
    state_predicate_intent: statePredicateIntent,
    order_by: orderBy,
    result_cardinality: resultCardinality,
    required_index_id: requiredIndexId,
    execution_status: 'intent_only',
  };
}

const QUERY_INTENTS: LogicalQueryIntent[] = [
  query(
    'publisher_find_idempotency',
    'command_gateway',
    'Resolve an exact caller Publisher idempotency domain and key',
    'workflow_publisher_commands',
    ['idempotency_domain', 'idempotency_key'],
    null,
    'idx:publisher_commands:idempotency',
    'zero_or_one',
  ),
  query(
    'publisher_load_invocations',
    'command_gateway',
    'Read the immutable authenticated invocation chain for one Publisher command',
    'workflow_publisher_command_invocations',
    ['command_id'],
    null,
    'idx:publisher_invocations:command_history',
    'many',
    [{ column: 'invocation_no', direction: 'asc' }],
  ),
  query(
    'publisher_load_events',
    'recovery',
    'Replay one Publisher command append-only event hash chain',
    'workflow_publisher_events',
    ['command_id'],
    null,
    'idx:publisher_events:command_history',
    'many',
    [{ column: 'event_no', direction: 'asc' }],
  ),
  query(
    'publisher_recovery_scan_pending',
    'recovery',
    'Find Publisher commands requiring crash recovery without inferring release state',
    'workflow_publisher_commands',
    [],
    "lifecycle = 'pending'",
    'idx:publisher_commands:pending_recovery',
    'bounded_batch',
    [
      { column: 'created_at_ms', direction: 'asc' },
      { column: 'command_id', direction: 'asc' },
    ],
  ),
];

function workflowValuesExtension(): PublisherSchemaTableExtension {
  const table = LOGICAL_SCHEMA_TABLES.find(
    (candidate) => candidate.name === 'workflow_values',
  );
  if (!table) throw new Error('Historical workflow_values metadata is missing');
  return {
    name: 'workflow_values',
    base_table_hash: domainSeparatedSha256(
      'icarus:workflow-publisher-base-logical-table:1\n',
      table as unknown as JsonValue,
    ),
    added_columns: [],
    added_foreign_keys: [],
    added_unique_keys: [
      uk('uk:values:id_hash_schema', [
        'id',
        'content_hash',
        'schema_resource_id',
        'schema_resource_hash',
      ]),
    ],
    added_checks: [],
    added_indexes: [],
  };
}

export function buildPublisherSchemaPrerequisitePayload(): PublisherSchemaPrerequisitePayload {
  const addedTables = TABLE_SEEDS.map((seed, indexValue) =>
    buildTable(seed, indexValue + 1),
  );
  const withoutHash = {
    format: 'icarus.workflow-publisher-schema-prerequisite/1' as const,
    schema_id: 'workflow-runtime-schema-v1' as const,
    database_schema_version: 2 as const,
    delta_mode: 'additive_only' as const,
    contract_stage: 'g1_physical_schema_input' as const,
    historical_inputs: {
      g0_6_logical_schema_source_hash: G0_6_LOGICAL_SOURCE_HASH,
      g0_10_capacity_delta_hash: G0_10_CAPACITY_DELTA_HASH,
      identity_policy: 'preserve_exact_historical_artifacts' as const,
    },
    normative_logical_schema_coverage: {
      prior_table_count: 78 as const,
      added_table_count: 3 as const,
      resulting_table_count: 81 as const,
      object_names: addedTables.map((table) => table.name),
    },
    added_tables: addedTables,
    extended_tables: [workflowValuesExtension()],
    query_intents: QUERY_INTENTS,
    trigger_intents: [
      'Publisher command immutable request identity and terminal lifecycle transition',
      'Publisher invocation adjacent per-command hash chain and append-only rows',
      'Publisher event adjacent per-command hash chain and append-only rows',
    ],
    constraint_fixture_cases: [
      'publisher_caller_idempotency_unique',
      'publisher_schema_bound_values_and_typed_identity_foreign_keys',
      'publisher_review_approval_expiry_ordering',
      'publisher_command_lifecycle_and_finalization',
      'publisher_invocation_disposition_hash_chain_and_immutability',
      'publisher_event_phase_hash_chain_and_immutability',
    ],
    authoritative_existing_tables: [
      'workflow_values',
      'workflow_registry_resources',
      'workflow_registry_resource_dependencies',
      'workflow_registry_closure_manifests',
      'workflow_registry_closure_members',
      'workflow_registry_snapshots',
      'workflow_feature_releases',
      'workflow_feature_release_resources',
      'workflow_registry_retention_handles',
      'workflow_registry_retention_handle_members',
    ],
    forbidden_implementation_surfaces: [
      'workflow_publisher_publish_method',
      'publisher_write_transaction',
      'registry_staged_to_published_mutation',
      'feature_release_creation_transaction',
      'retention_handle_write',
      'execution_artifact_build_or_install',
      'publisher_receipt_execution_logic',
      'activation_or_active_pointer',
    ],
  };
  return {
    ...withoutHash,
    delta_hash: domainSeparatedSha256(
      PUBLISHER_SCHEMA_DELTA_DOMAIN,
      withoutHash as unknown as JsonValue,
    ),
  };
}

export function buildPublisherSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-publisher-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-publisher-schema-prerequisite',
      version: '1',
    },
    version: 1,
    domain_separator: PUBLISHER_SCHEMA_INPUT_DOMAIN,
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    payload: buildPublisherSchemaPrerequisitePayload() as unknown as JsonObject,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

export const PUBLISHER_SCHEMA_INPUT_ARTIFACT_HASH =
  buildPublisherSchemaPrerequisiteArtifact().hash;

export function parsePublisherSchemaPrerequisiteArtifact(
  artifact: ContractArtifactEnvelope,
): PublisherSchemaPrerequisitePayload {
  const expected = buildPublisherSchemaPrerequisiteArtifact();
  if (
    artifact.format !== expected.format ||
    artifact.ref.id !== expected.ref.id ||
    artifact.ref.version !== expected.ref.version ||
    artifact.version !== expected.version ||
    artifact.domain_separator !== expected.domain_separator ||
    artifact.hash !== expected.hash ||
    calculateArtifactHash(artifact) !== artifact.hash
  ) {
    throw new Error('Publisher Schema Prerequisite artifact identity drifted');
  }
  return artifact.payload as unknown as PublisherSchemaPrerequisitePayload;
}
