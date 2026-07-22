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
import { PUBLISHER_SCHEMA_INPUT_ARTIFACT_HASH } from './publisher-source.js';

export const ACTIVATION_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-feature-release-activation-schema-prerequisite@1.json';
export const ACTIVATION_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-feature-release-activation-schema-prerequisite:1\n';
export const ACTIVATION_SCHEMA_DELTA_DOMAIN =
  'icarus:workflow-feature-release-activation-logical-schema-delta:1\n';

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

export interface ActivationSchemaTableExtension {
  name:
    | 'workflow_feature_releases'
    | 'workflow_feature_active_releases'
    | 'workflow_registry_retention_handles';
  base_table_hash: Sha256Hash;
  added_columns: LogicalColumnMetadata[];
  added_foreign_keys: LogicalForeignKeyMetadata[];
  added_unique_keys: LogicalUniqueKeyMetadata[];
  added_checks: LogicalCheckMetadata[];
  added_indexes: LogicalIndexMetadata[];
}

export interface ActivationSchemaPrerequisitePayload {
  format: 'icarus.workflow-feature-release-activation-schema-prerequisite/1';
  schema_id: 'workflow-runtime-schema-v1';
  database_schema_version: 3;
  delta_mode: 'additive_only';
  contract_stage: 'g1_physical_schema_input';
  historical_inputs: {
    g0_6_logical_schema_source_hash: Sha256Hash;
    g0_10_capacity_delta_hash: Sha256Hash;
    publisher_schema_prerequisite_hash: Sha256Hash;
    identity_policy: 'preserve_exact_historical_artifacts';
  };
  normative_logical_schema_coverage: {
    prior_table_count: 81;
    added_table_count: 3;
    resulting_table_count: 84;
    object_names: string[];
  };
  added_tables: LogicalTableMetadata[];
  extended_tables: ActivationSchemaTableExtension[];
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
  nullable = false,
) =>
  column(name, 'external_reference', 'TEXT', nullable, 'not_applicable', [], {
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
    source_section:
      'Feature Release Activation persistence prerequisite and recovery audit',
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

const releaseFk = (
  relationId: string,
  featureColumn: string,
  releaseIdColumn: string,
  releaseHashColumn: string,
) =>
  fk(
    relationId,
    [featureColumn, releaseIdColumn, releaseHashColumn],
    'workflow_feature_releases',
    ['feature_id', 'id', 'release_hash'],
  );

const retentionFk = (relationId: string, prefix: string) =>
  fk(
    relationId,
    [
      `${prefix}_retention_handle_id`,
      `${prefix}_retention_handle_kind`,
      `${prefix}_feature_release_id`,
      `${prefix}_retention_closure_manifest_id`,
      `${prefix}_retention_closure_hash`,
    ],
    'workflow_registry_retention_handles',
    [
      'id',
      'handle_kind',
      'feature_release_id',
      'closure_manifest_id',
      'closure_hash',
    ],
  );

const TABLE_SEEDS: readonly TableSeed[] = [
  {
    name: 'workflow_feature_release_activation_commands',
    columns: [
      id('command_id'),
      text('command_type', false, ['activate_feature_release']),
      text('idempotency_domain'),
      text('idempotency_key'),
      ...schemaBoundValueColumns('request'),
      hash('domain_request_hash'),
      ...schemaBoundValueColumns('compatibility_input'),
      ...schemaBoundValueColumns('compatibility_result'),
      external('feature_id', 'feature_registry', 'feature'),
      id('target_feature_release_id'),
      external(
        'target_feature_release_ref',
        'feature_release_ref_validator',
        'feature_release',
      ),
      text('target_feature_release_version'),
      hash('target_feature_release_hash'),
      text('expected_pointer_state', false, ['absent', 'present']),
      integer('expected_pointer_row_version', true),
      id('previous_feature_release_id', true),
      external(
        'previous_feature_release_ref',
        'feature_release_ref_validator',
        'feature_release',
        true,
      ),
      text('previous_feature_release_version', true),
      hash('previous_feature_release_hash', true),
      id('target_retention_handle_id'),
      text('target_retention_handle_kind', false, ['published']),
      id('target_retention_closure_manifest_id'),
      hash('target_retention_closure_hash'),
      text('target_retention_observed_status', false, ['held']),
      integer('target_retention_observed_row_version'),
      id('previous_retention_handle_id', true),
      text('previous_retention_handle_kind', true, ['published']),
      id('previous_retention_closure_manifest_id', true),
      hash('previous_retention_closure_hash', true),
      text('previous_retention_observed_status', true, ['held']),
      integer('previous_retention_observed_row_version', true),
      integer('applied_pointer_row_version', true),
      ...schemaBoundValueColumns('canonical_receipt', true),
      text('lifecycle', false, ['pending', 'applied', 'failed']),
      at('created_at_ms'),
      at('finalized_at_ms', true),
      integer('row_version'),
    ],
    primaryKey: ['command_id'],
    foreignKeys: [
      schemaBoundValueFk('fk:activation_commands:request_value', 'request'),
      schemaBoundValueFk(
        'fk:activation_commands:compatibility_input_value',
        'compatibility_input',
      ),
      schemaBoundValueFk(
        'fk:activation_commands:compatibility_result_value',
        'compatibility_result',
      ),
      releaseFk(
        'fk:activation_commands:target_release_owner',
        'feature_id',
        'target_feature_release_id',
        'target_feature_release_hash',
      ),
      releaseFk(
        'fk:activation_commands:previous_release_owner',
        'feature_id',
        'previous_feature_release_id',
        'previous_feature_release_hash',
      ),
      retentionFk('fk:activation_commands:target_retention', 'target'),
      retentionFk('fk:activation_commands:previous_retention', 'previous'),
      schemaBoundValueFk(
        'fk:activation_commands:canonical_receipt_value',
        'canonical_receipt',
      ),
    ],
    uniqueKeys: [
      uk('uk:activation_commands:idempotency', [
        'idempotency_domain',
        'idempotency_key',
      ]),
      uk('uk:activation_commands:id_domain_request', [
        'command_id',
        'domain_request_hash',
      ]),
    ],
    checks: [
      check(
        'ck:activation_commands:idempotency_non_empty',
        'state_field_consistency',
        ['idempotency_domain', 'idempotency_key'],
        'caller idempotency domain and key are non-empty bounded tokens',
      ),
      check(
        'ck:activation_commands:expected_pointer_shape',
        'closed_target_mapping',
        [
          'expected_pointer_state',
          'expected_pointer_row_version',
          'previous_feature_release_id',
          'previous_feature_release_ref',
          'previous_feature_release_version',
          'previous_feature_release_hash',
          'previous_retention_handle_id',
          'previous_retention_handle_kind',
          'previous_retention_closure_manifest_id',
          'previous_retention_closure_hash',
          'previous_retention_observed_status',
          'previous_retention_observed_row_version',
        ],
        'absent expects no previous pointer or Retention identity; present binds every previous field',
      ),
      check(
        'ck:activation_commands:target_previous_distinct',
        'cross_column_equality',
        ['target_feature_release_id', 'previous_feature_release_id'],
        'target and previous Feature Release identities differ when previous is present',
      ),
      check(
        'ck:activation_commands:receipt_binding',
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
        'ck:activation_commands:lifecycle',
        'state_field_consistency',
        [
          'lifecycle',
          'applied_pointer_row_version',
          'canonical_receipt_value_id',
          'finalized_at_ms',
        ],
        'pending has no result; applied binds pointer version and receipt; failed binds neither; terminal states have finalized time',
      ),
    ],
    indexes: [
      index(
        'idx:activation_commands:idempotency',
        'lookup',
        ['idempotency_domain', 'idempotency_key'],
        null,
        ['activation_find_idempotency'],
      ),
      index(
        'idx:activation_commands:pending_recovery',
        'recovery',
        ['created_at_ms', 'command_id'],
        "lifecycle = 'pending'",
        ['activation_recovery_scan_pending'],
      ),
    ],
  },
  {
    name: 'workflow_feature_release_activation_invocations',
    columns: [
      id('id'),
      id('command_id'),
      integer('invocation_no', false, 'positive'),
      hash('command_domain_request_hash'),
      hash('submitted_request_hash'),
      external(
        'actor_ref',
        'feature_release_activation_authentication_gateway',
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
        'fk:activation_invocations:command_request',
        ['command_id', 'command_domain_request_hash'],
        'workflow_feature_release_activation_commands',
        ['command_id', 'domain_request_hash'],
      ),
      schemaBoundValueFk('fk:activation_invocations:result_value', 'result'),
    ],
    uniqueKeys: [
      uk('uk:activation_invocations:command_no', [
        'command_id',
        'invocation_no',
      ]),
      uk('uk:activation_invocations:invocation_hash', ['invocation_hash']),
    ],
    checks: [
      check(
        'ck:activation_invocations:result_consistency',
        'state_field_consistency',
        [
          'disposition',
          'command_domain_request_hash',
          'submitted_request_hash',
          'requested_at_ms',
          'decided_at_ms',
          'applied_at_ms',
        ],
        'non-conflict results match the command request; conflict may be caller drift or pointer CAS; only applied has applied time',
      ),
      check(
        'ck:activation_invocations:hash_chain',
        'state_field_consistency',
        ['invocation_no', 'previous_invocation_hash', 'invocation_hash'],
        'invocation 1 has no previous hash and later invocations name the adjacent prior hash',
      ),
    ],
    indexes: [
      index(
        'idx:activation_invocations:command_history',
        'ordering',
        ['command_id', 'invocation_no'],
        null,
        ['activation_load_invocations'],
      ),
    ],
  },
  {
    name: 'workflow_feature_release_activation_events',
    columns: [
      id('command_id'),
      integer('event_no', false, 'positive'),
      integer('attempt_no', false, 'positive'),
      text('phase', false, [
        'authenticate',
        'validate',
        'preflight',
        'activation_transaction',
        'recovery',
        'finalize',
      ]),
      text('event_type', false, [
        'attempt_started',
        'phase_succeeded',
        'pre_transaction_failed',
        'activation_transaction_started',
        'activation_committed',
        'recovery_started',
        'recovery_succeeded',
        'recovery_failed',
        'terminal_failed',
      ]),
      text('failure_code', true),
      external('feature_id', 'feature_registry', 'feature'),
      id('target_feature_release_id'),
      external(
        'target_feature_release_ref',
        'feature_release_ref_validator',
        'feature_release',
      ),
      text('target_feature_release_version'),
      hash('target_feature_release_hash'),
      id('previous_feature_release_id', true),
      external(
        'previous_feature_release_ref',
        'feature_release_ref_validator',
        'feature_release',
        true,
      ),
      text('previous_feature_release_version', true),
      hash('previous_feature_release_hash', true),
      ...schemaBoundValueColumns('detail', true),
      hash('previous_event_hash', true),
      hash('event_hash'),
      at('occurred_at_ms'),
    ],
    primaryKey: ['command_id', 'event_no'],
    foreignKeys: [
      fk(
        'fk:activation_events:command',
        ['command_id'],
        'workflow_feature_release_activation_commands',
        ['command_id'],
      ),
      fk(
        'fk:activation_events:attempt_invocation',
        ['command_id', 'attempt_no'],
        'workflow_feature_release_activation_invocations',
        ['command_id', 'invocation_no'],
      ),
      releaseFk(
        'fk:activation_events:target_release_owner',
        'feature_id',
        'target_feature_release_id',
        'target_feature_release_hash',
      ),
      releaseFk(
        'fk:activation_events:previous_release_owner',
        'feature_id',
        'previous_feature_release_id',
        'previous_feature_release_hash',
      ),
      schemaBoundValueFk('fk:activation_events:detail_value', 'detail'),
    ],
    uniqueKeys: [
      uk('uk:activation_events:attempt_phase_type', [
        'command_id',
        'attempt_no',
        'phase',
        'event_type',
      ]),
      uk('uk:activation_events:event_hash', ['event_hash']),
    ],
    checks: [
      check(
        'ck:activation_events:previous_release_binding',
        'all_or_none',
        [
          'previous_feature_release_id',
          'previous_feature_release_ref',
          'previous_feature_release_version',
          'previous_feature_release_hash',
        ],
        'previous Feature Release id ref version and hash are all null or all non-null',
      ),
      check(
        'ck:activation_events:detail_binding',
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
        'ck:activation_events:hash_chain',
        'state_field_consistency',
        ['event_no', 'previous_event_hash', 'event_hash'],
        'event 1 has no previous hash and later events name the adjacent prior hash',
      ),
      check(
        'ck:activation_events:event_mapping',
        'closed_target_mapping',
        ['phase', 'event_type', 'failure_code'],
        'phase and event type map to success or failure consistently',
      ),
    ],
    indexes: [
      index(
        'idx:activation_events:command_history',
        'ordering',
        ['command_id', 'event_no'],
        null,
        ['activation_load_events'],
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
  joinTables: string[] = [],
): LogicalQueryIntent {
  return {
    query_id: queryId,
    owner,
    purpose,
    table,
    join_tables: joinTables,
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
    'activation_find_idempotency',
    'command_gateway',
    'Resolve an exact caller Activation idempotency domain and key',
    'workflow_feature_release_activation_commands',
    ['idempotency_domain', 'idempotency_key'],
    null,
    'idx:activation_commands:idempotency',
    'zero_or_one',
  ),
  query(
    'activation_load_invocations',
    'command_gateway',
    'Read the immutable authenticated invocation chain for one Activation command',
    'workflow_feature_release_activation_invocations',
    ['command_id'],
    null,
    'idx:activation_invocations:command_history',
    'many',
    [{ column: 'invocation_no', direction: 'asc' }],
  ),
  query(
    'activation_load_events',
    'recovery',
    'Replay one Activation command append-only event hash chain',
    'workflow_feature_release_activation_events',
    ['command_id'],
    null,
    'idx:activation_events:command_history',
    'many',
    [{ column: 'event_no', direction: 'asc' }],
  ),
  query(
    'activation_recovery_scan_pending',
    'recovery',
    'Find Activation commands requiring crash recovery without inferring pointer state',
    'workflow_feature_release_activation_commands',
    [],
    "lifecycle = 'pending'",
    'idx:activation_commands:pending_recovery',
    'bounded_batch',
    [
      { column: 'created_at_ms', direction: 'asc' },
      { column: 'command_id', direction: 'asc' },
    ],
  ),
  query(
    'activation_expected_pointer_cas',
    'command_gateway',
    'Read one owner-consistent active pointer and its CAS row version',
    'workflow_feature_active_releases',
    ['feature_id'],
    null,
    'idx:feature_active_releases:activation_cas',
    'zero_or_one',
  ),
  query(
    'activation_release_preflight',
    'command_gateway',
    'Verify target or previous exact owner Release and lifecycle',
    'workflow_feature_releases',
    ['feature_id', 'id', 'release_hash', 'status'],
    null,
    'idx:feature_releases:activation_preflight',
    'zero_or_one',
  ),
  query(
    'activation_retention_preflight',
    'command_gateway',
    'Verify target or previous exact published held Retention identity and observation',
    'workflow_registry_retention_handles',
    [
      'feature_release_id',
      'handle_kind',
      'status',
      'closure_manifest_id',
      'closure_hash',
    ],
    null,
    'idx:retention_handles:activation_preflight',
    'zero_or_one',
    [],
    ['workflow_feature_releases', 'workflow_registry_closure_manifests'],
  ),
];

function tableBaseHash(tableName: ActivationSchemaTableExtension['name']) {
  const table = LOGICAL_SCHEMA_TABLES.find(
    (candidate) => candidate.name === tableName,
  );
  if (!table) throw new Error(`Historical ${tableName} metadata is missing`);
  return domainSeparatedSha256(
    'icarus:workflow-feature-release-activation-base-logical-table:1\n',
    table as unknown as JsonValue,
  );
}

function buildExtensions(): ActivationSchemaTableExtension[] {
  return [
    {
      name: 'workflow_feature_releases',
      base_table_hash: tableBaseHash('workflow_feature_releases'),
      added_columns: [],
      added_foreign_keys: [],
      added_unique_keys: [
        uk('uk:feature_releases:owner_identity', [
          'feature_id',
          'id',
          'release_hash',
        ]),
        uk(
          'uk:feature_releases:single_active',
          ['feature_id'],
          "status = 'active'",
        ),
      ],
      added_checks: [
        check(
          'ck:feature_releases:lifecycle_timestamps',
          'state_field_consistency',
          ['status', 'staged_at_ms', 'activated_at_ms', 'disabled_at_ms'],
          'staged active draining disabled and deleting lifecycles have ordered closed timestamp shapes',
        ),
      ],
      added_indexes: [
        index(
          'idx:feature_releases:activation_preflight',
          'lookup',
          ['feature_id', 'id', 'release_hash', 'status'],
          null,
          ['activation_release_preflight'],
        ),
      ],
    },
    {
      name: 'workflow_feature_active_releases',
      base_table_hash: tableBaseHash('workflow_feature_active_releases'),
      added_columns: [],
      added_foreign_keys: [
        releaseFk(
          'fk:feature_active_releases:owner_release',
          'feature_id',
          'release_id',
          'release_hash',
        ),
      ],
      added_unique_keys: [],
      added_checks: [
        check(
          'ck:feature_active_releases:positive_row_version',
          'state_field_consistency',
          ['row_version'],
          'active pointer row version starts at one',
        ),
      ],
      added_indexes: [
        index(
          'idx:feature_active_releases:activation_cas',
          'lookup',
          ['feature_id', 'row_version', 'release_id', 'release_hash'],
          null,
          ['activation_expected_pointer_cas'],
        ),
      ],
    },
    {
      name: 'workflow_registry_retention_handles',
      base_table_hash: tableBaseHash('workflow_registry_retention_handles'),
      added_columns: [],
      added_foreign_keys: [],
      added_unique_keys: [
        uk('uk:retention_handles:published_identity', [
          'id',
          'handle_kind',
          'feature_release_id',
          'closure_manifest_id',
          'closure_hash',
        ]),
      ],
      added_checks: [],
      added_indexes: [
        index(
          'idx:retention_handles:activation_preflight',
          'lookup',
          [
            'feature_release_id',
            'handle_kind',
            'status',
            'closure_manifest_id',
            'closure_hash',
            'row_version',
            'id',
          ],
          null,
          ['activation_retention_preflight'],
        ),
      ],
    },
  ];
}

export function buildActivationSchemaPrerequisitePayload(): ActivationSchemaPrerequisitePayload {
  const addedTables = TABLE_SEEDS.map((seed, indexValue) =>
    buildTable(seed, indexValue + 1),
  );
  const withoutHash = {
    format:
      'icarus.workflow-feature-release-activation-schema-prerequisite/1' as const,
    schema_id: 'workflow-runtime-schema-v1' as const,
    database_schema_version: 3 as const,
    delta_mode: 'additive_only' as const,
    contract_stage: 'g1_physical_schema_input' as const,
    historical_inputs: {
      g0_6_logical_schema_source_hash: G0_6_LOGICAL_SOURCE_HASH,
      g0_10_capacity_delta_hash: G0_10_CAPACITY_DELTA_HASH,
      publisher_schema_prerequisite_hash: PUBLISHER_SCHEMA_INPUT_ARTIFACT_HASH,
      identity_policy: 'preserve_exact_historical_artifacts' as const,
    },
    normative_logical_schema_coverage: {
      prior_table_count: 81 as const,
      added_table_count: 3 as const,
      resulting_table_count: 84 as const,
      object_names: addedTables.map((table) => table.name),
    },
    added_tables: addedTables,
    extended_tables: buildExtensions(),
    query_intents: QUERY_INTENTS,
    trigger_intents: [
      'Feature Release immutable identity and adjacent legal lifecycle transitions',
      'Per-Feature single-active Release and owner-consistent active pointer target',
      'Active pointer insert/update CAS adjacency, identity immutability, and delete protection',
      'Published Retention immutable root identity, held observation, and active/draining Release protection',
      'Activation command immutable request identity and single pending-to-terminal transition',
      'Activation invocation adjacent per-command hash chain and append-only rows',
      'Activation event adjacent per-command hash chain and append-only rows',
    ],
    constraint_fixture_cases: [
      'activation_caller_idempotency_unique',
      'activation_schema_bound_values_and_typed_release_retention_foreign_keys',
      'activation_expected_pointer_absent_present_shape',
      'activation_command_lifecycle_and_finalization',
      'activation_invocation_disposition_hash_chain_and_immutability',
      'activation_event_phase_hash_chain_and_immutability',
      'feature_release_owner_identity_single_active_and_legal_lifecycle',
      'active_pointer_owner_cas_immutability_delete_and_target_active',
      'retention_published_identity_held_observation_and_active_draining_protection',
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
      'workflow_feature_active_releases',
      'workflow_registry_retention_handles',
      'workflow_registry_retention_handle_members',
    ],
    forbidden_implementation_surfaces: [
      'feature_release_activation_contract',
      'feature_release_activation_method',
      'activation_business_dml_or_transaction',
      'active_pointer_business_mutation',
      'production_loader',
      'retention_gc_or_delete_executor',
      'execution_artifact_build_or_install',
      'workflow_runtime_or_capacity_command_union_reuse',
      'g4_through_g9_runtime',
    ],
  };
  return {
    ...withoutHash,
    delta_hash: domainSeparatedSha256(
      ACTIVATION_SCHEMA_DELTA_DOMAIN,
      withoutHash as unknown as JsonValue,
    ),
  };
}

export function buildActivationSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-feature-release-activation-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-feature-release-activation-schema-prerequisite',
      version: '1',
    },
    version: 1,
    domain_separator: ACTIVATION_SCHEMA_INPUT_DOMAIN,
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    payload:
      buildActivationSchemaPrerequisitePayload() as unknown as JsonObject,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

export const ACTIVATION_SCHEMA_INPUT_ARTIFACT_HASH =
  buildActivationSchemaPrerequisiteArtifact().hash;

export function parseActivationSchemaPrerequisiteArtifact(
  artifact: ContractArtifactEnvelope,
): ActivationSchemaPrerequisitePayload {
  const expected = buildActivationSchemaPrerequisiteArtifact();
  if (
    artifact.format !== expected.format ||
    artifact.ref.id !== expected.ref.id ||
    artifact.ref.version !== expected.ref.version ||
    artifact.version !== expected.version ||
    artifact.domain_separator !== expected.domain_separator ||
    artifact.hash !== expected.hash ||
    calculateArtifactHash(artifact) !== artifact.hash
  ) {
    throw new Error(
      'Feature Release Activation Schema Prerequisite artifact identity drifted',
    );
  }
  return artifact.payload as unknown as ActivationSchemaPrerequisitePayload;
}
