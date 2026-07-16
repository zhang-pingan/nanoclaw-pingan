import { domainSeparatedSha256 } from './hash.js';
import { LOGICAL_SCHEMA_TABLES } from './logical-schema-source.js';
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
} from './logical-schema-types.js';
import type {
  CapacityLogicalSchemaDelta,
  CapacityLogicalTableDelta,
} from './capacity-control-plane-types.js';
import type { JsonValue, Sha256Hash } from './types.js';

const BASE_LOGICAL_SCHEMA_MANIFEST_HASH =
  'sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520' as const;

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
  name: CapacityLogicalTableDelta['name'];
  columns: ColumnSeed[];
  primaryKey: string[];
  autoIncrement?: boolean;
  foreignKeys?: LogicalForeignKeyMetadata[];
  uniqueKeys?: LogicalUniqueKeyMetadata[];
  checks?: LogicalCheckMetadata[];
  indexes?: LogicalIndexMetadata[];
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
const canonicalJson = (name: string) => column(name, 'canonical_json', 'TEXT');
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
  sourceColumns: string | string[],
  targetTable: string,
  targetColumns: string | string[] = 'id',
): LogicalForeignKeyMetadata {
  return {
    relation_id: relationId,
    source_columns: Array.isArray(sourceColumns)
      ? sourceColumns
      : [sourceColumns],
    target_table: targetTable,
    target_columns: Array.isArray(targetColumns)
      ? targetColumns
      : [targetColumns],
    on_delete: 'restrict',
    deferrability: 'deferred',
  };
}

function uk(
  keyId: string,
  columns: string[],
  predicateIntent: string | null = null,
): LogicalUniqueKeyMetadata {
  return {
    key_id: keyId,
    columns,
    predicate_intent: predicateIntent,
  };
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
  const checks: LogicalCheckMetadata[] = [];
  for (const candidate of columns) {
    if (candidate.enum_values.length > 0)
      checks.push(
        check(
          `ck:${tableName}:${candidate.name}:enum`,
          'enum_membership',
          [candidate.name],
          `value is one of ${candidate.enum_values.join(' | ')}`,
        ),
      );
    if (candidate.logical_type === 'hash')
      checks.push(
        check(
          `ck:${tableName}:${candidate.name}:hash`,
          'hash_format',
          [candidate.name],
          'nullable or sha256:<64 lowercase hexadecimal characters>',
        ),
      );
    if (candidate.safe_integer_intent !== 'not_applicable')
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
}

function buildTable(
  seed: TableSeed,
  ordinal: number,
): CapacityLogicalTableDelta {
  const foreignKeys = seed.foreignKeys ?? [];
  const columns: LogicalColumnMetadata[] = seed.columns.map(
    (candidate, indexValue) => ({
      ordinal: indexValue + 1,
      ...candidate,
      relation_ids: foreignKeys
        .filter((relation) => relation.source_columns.includes(candidate.name))
        .map((relation) => relation.relation_id)
        .sort(),
    }),
  );
  return {
    ordinal,
    name: seed.name,
    source_section: 'Capacity management publication and audit',
    columns,
    primary_key: {
      columns: seed.primaryKey,
      auto_increment_intent: seed.autoIncrement ?? false,
    },
    foreign_keys: foreignKeys,
    unique_keys: seed.uniqueKeys ?? [],
    checks: [
      ...automaticChecks(seed.name, seed.columns),
      ...(seed.checks ?? []),
    ],
    indexes: seed.indexes ?? [],
  };
}

const TABLE_SEEDS: readonly TableSeed[] = [
  {
    name: 'runtime_capacity_head',
    columns: [
      integer('singleton_key', false, 'positive'),
      integer('current_capacity_revision', true, 'positive'),
      id('current_change_id', true),
      hash('current_config_hash', true),
      hash('current_publication_hash', true),
      id('pending_change_id', true),
      integer('row_version'),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['singleton_key'],
    foreignKeys: [
      fk(
        'fk:capacity_head:current_command_lineage',
        [
          'current_capacity_revision',
          'current_change_id',
          'current_config_hash',
        ],
        'runtime_capacity_admin_commands',
        [
          'assigned_capacity_revision',
          'assigned_change_id',
          'proposed_config_hash',
        ],
      ),
      fk(
        'fk:capacity_head:pending_command',
        'pending_change_id',
        'runtime_capacity_admin_commands',
        'assigned_change_id',
      ),
    ],
    checks: [
      check(
        'ck:capacity_head:singleton',
        'cross_column_equality',
        ['singleton_key'],
        'singleton_key equals 1',
      ),
      check(
        'ck:capacity_head:current_lineage_all_or_none',
        'all_or_none',
        [
          'current_capacity_revision',
          'current_change_id',
          'current_config_hash',
          'current_publication_hash',
        ],
        'current revision/change/config/publication lineage is all null or all non-null',
      ),
      check(
        'ck:capacity_head:pending_differs_from_current',
        'state_field_consistency',
        ['pending_change_id', 'current_change_id'],
        'pending change is null or differs from current change',
      ),
    ],
    indexes: [
      index('idx:capacity_head:singleton', 'lookup', ['singleton_key'], null, [
        'capacity_admin_load_head',
        'capacity_watcher_verify_committed_head',
      ]),
      index(
        'idx:capacity_head:pending',
        'recovery',
        ['pending_change_id'],
        'pending_change_id is not null',
        ['capacity_recovery_load_pending_change'],
      ),
    ],
  },
  {
    name: 'runtime_capacity_admin_commands',
    columns: [
      id('command_id'),
      text('idempotency_domain'),
      text('idempotency_key'),
      text('command_type', false, [
        'initialize_deployment_capacity',
        'replace_deployment_capacity',
      ]),
      integer('expected_capacity_revision', true, 'positive'),
      hash('expected_config_hash', true),
      integer('assigned_capacity_revision', true, 'positive'),
      id('assigned_change_id', true),
      hash('genesis_core_release_hash', true),
      canonicalJson('proposed_capacity_json'),
      hash('proposed_config_hash'),
      hash('request_hash'),
      text('reason_code', false, [
        'initial_provisioning',
        'planned_tuning',
        'incident_mitigation',
        'host_resource_change',
        'storage_pressure',
        'rollback',
      ]),
      id('reason_text_value_id', true),
      hash('reason_text_hash', true),
      id('evidence_manifest_value_id'),
      hash('evidence_manifest_hash'),
      id('canonical_result_value_id', true),
      hash('canonical_result_hash', true),
      at('created_at_ms'),
      at('finalized_at_ms', true),
    ],
    primaryKey: ['command_id'],
    foreignKeys: [
      fk(
        'fk:capacity_commands:reason_text_value',
        ['reason_text_value_id', 'reason_text_hash'],
        'workflow_values',
        ['id', 'content_hash'],
      ),
      fk(
        'fk:capacity_commands:evidence_value',
        ['evidence_manifest_value_id', 'evidence_manifest_hash'],
        'workflow_values',
        ['id', 'content_hash'],
      ),
      fk(
        'fk:capacity_commands:result_value',
        ['canonical_result_value_id', 'canonical_result_hash'],
        'workflow_values',
        ['id', 'content_hash'],
      ),
    ],
    uniqueKeys: [
      uk('uk:capacity_commands:idempotency', [
        'idempotency_domain',
        'idempotency_key',
      ]),
      uk(
        'uk:capacity_commands:assigned_revision',
        ['assigned_capacity_revision'],
        'assigned_capacity_revision is not null',
      ),
      uk(
        'uk:capacity_commands:assigned_change',
        ['assigned_change_id'],
        'assigned_change_id is not null',
      ),
      uk(
        'uk:capacity_commands:assigned_lineage',
        [
          'assigned_capacity_revision',
          'assigned_change_id',
          'proposed_config_hash',
        ],
        'assigned_capacity_revision and assigned_change_id are not null',
      ),
    ],
    checks: [
      check(
        'ck:capacity_commands:expected_pair',
        'all_or_none',
        ['expected_capacity_revision', 'expected_config_hash'],
        'expected revision and config hash are both null or both non-null',
      ),
      check(
        'ck:capacity_commands:assigned_pair',
        'all_or_none',
        ['assigned_capacity_revision', 'assigned_change_id'],
        'assigned revision and change id are both null or both non-null',
      ),
      check(
        'ck:capacity_commands:command_mapping',
        'closed_target_mapping',
        [
          'command_type',
          'expected_capacity_revision',
          'expected_config_hash',
          'genesis_core_release_hash',
          'reason_code',
          'reason_text_value_id',
          'reason_text_hash',
        ],
        'initialize has no expected pair, requires genesis release, initial reason and no reason text; replace requires expected pair, non-initial reason and reason text',
      ),
      check(
        'ck:capacity_commands:reason_text_pair',
        'all_or_none',
        ['reason_text_value_id', 'reason_text_hash'],
        'reason text value and hash are both null or both non-null',
      ),
      check(
        'ck:capacity_commands:result_pair',
        'all_or_none',
        ['canonical_result_value_id', 'canonical_result_hash'],
        'canonical result value and hash are both null or both non-null',
      ),
      check(
        'ck:capacity_commands:finalization',
        'state_field_consistency',
        ['canonical_result_value_id', 'finalized_at_ms'],
        'finalized timestamp is non-null exactly when canonical result is non-null',
      ),
    ],
    indexes: [
      index(
        'idx:capacity_commands:idempotency',
        'lookup',
        ['idempotency_domain', 'idempotency_key'],
        null,
        ['capacity_admin_find_idempotency'],
      ),
      index(
        'idx:capacity_commands:assigned_change',
        'recovery',
        ['assigned_change_id'],
        'assigned_change_id is not null',
        ['capacity_recovery_load_pending_change'],
      ),
    ],
  },
  {
    name: 'runtime_capacity_admin_invocations',
    columns: [
      id('id'),
      id('command_id'),
      integer('invocation_no', false, 'positive'),
      hash('submitted_request_hash'),
      external('actor_ref', 'capacity_admin_gateway', 'principal'),
      text('actor_kind', false, [
        'human',
        'feature_service',
        'automation',
        'system',
      ]),
      external('auth_session_ref', 'authentication_service', 'auth_session'),
      text('entrypoint'),
      external(
        'delegation_chain_ref',
        'authorization_service',
        'delegation_chain',
        true,
      ),
      text('required_permission', true, ['runtime.capacity.manage']),
      text('authorization_result', false, ['allowed', 'denied']),
      text('execution_result', false, [
        'applied',
        'denied',
        'conflict',
        'duplicate',
        'failed',
      ]),
      text('denial_code', true, [
        'permission_denied',
        'actor_kind_denied',
        'capacity_already_initialized',
        'capacity_snapshot_invalid',
        'capacity_transition_invalid',
        'expected_capacity_revision_conflict',
        'expected_config_hash_conflict',
        'capacity_change_in_progress',
        'idempotency_conflict',
        'audit_unavailable',
        'publication_failed',
      ]),
      integer('observed_capacity_revision', true, 'positive'),
      hash('observed_config_hash', true),
      at('requested_at_ms'),
      at('decided_at_ms'),
      at('applied_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:capacity_invocations:command',
        'command_id',
        'runtime_capacity_admin_commands',
        'command_id',
      ),
    ],
    uniqueKeys: [
      uk('uk:capacity_invocations:command_no', ['command_id', 'invocation_no']),
    ],
    checks: [
      check(
        'ck:capacity_invocations:observed_pair',
        'all_or_none',
        ['observed_capacity_revision', 'observed_config_hash'],
        'observed revision and config hash are both null or both non-null',
      ),
      check(
        'ck:capacity_invocations:result_consistency',
        'state_field_consistency',
        [
          'authorization_result',
          'execution_result',
          'denial_code',
          'applied_at_ms',
        ],
        'denied authorization has denied result and denial code; applied result has applied timestamp and no denial code',
      ),
    ],
    indexes: [
      index(
        'idx:capacity_invocations:command_history',
        'ordering',
        ['command_id', 'invocation_no'],
        null,
        ['capacity_admin_load_invocations'],
      ),
    ],
  },
  {
    name: 'runtime_capacity_change_events',
    columns: [
      integer('event_seq', false, 'positive'),
      id('change_id'),
      id('command_id'),
      integer('capacity_revision', false, 'positive'),
      text('event_type', false, [
        'prepared',
        'file_installed',
        'head_committed',
        'watcher_published',
        'recovered',
        'failed',
        'unauthorized_file_rejected',
      ]),
      hash('config_hash'),
      hash('publication_hash'),
      hash('previous_event_hash', true),
      hash('event_hash'),
      id('detail_value_id', true),
      hash('detail_hash', true),
      at('created_at_ms'),
    ],
    primaryKey: ['event_seq'],
    autoIncrement: true,
    foreignKeys: [
      fk(
        'fk:capacity_events:command',
        'command_id',
        'runtime_capacity_admin_commands',
        'command_id',
      ),
      fk(
        'fk:capacity_events:command_lineage',
        ['capacity_revision', 'change_id', 'config_hash'],
        'runtime_capacity_admin_commands',
        [
          'assigned_capacity_revision',
          'assigned_change_id',
          'proposed_config_hash',
        ],
      ),
      fk(
        'fk:capacity_events:detail_value',
        ['detail_value_id', 'detail_hash'],
        'workflow_values',
        ['id', 'content_hash'],
      ),
    ],
    uniqueKeys: [
      uk(
        'uk:capacity_events:single_commit_milestone',
        ['change_id', 'event_type'],
        'event_type is one of prepared | file_installed | head_committed | watcher_published',
      ),
      uk('uk:capacity_events:event_hash', ['event_hash']),
    ],
    checks: [
      check(
        'ck:capacity_events:detail_pair',
        'all_or_none',
        ['detail_value_id', 'detail_hash'],
        'detail value and hash are both null or both non-null',
      ),
      check(
        'ck:capacity_events:hash_chain',
        'state_field_consistency',
        ['event_seq', 'previous_event_hash', 'event_hash'],
        'event_seq 1 has null previous hash; later events reference the immediately preceding event hash',
      ),
    ],
    indexes: [
      index(
        'idx:capacity_events:change_history',
        'ordering',
        ['change_id', 'event_seq'],
        null,
        ['capacity_admin_load_change_history'],
      ),
      index(
        'idx:capacity_events:global_chain',
        'ordering',
        ['event_seq'],
        null,
        ['capacity_recovery_verify_event_chain'],
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

export const CAPACITY_LOGICAL_QUERY_INTENTS: readonly LogicalQueryIntent[] = [
  query(
    'capacity_admin_load_head',
    'command_gateway',
    'Load the singleton Capacity head for CAP0/CAP1 CAS validation',
    'runtime_capacity_head',
    ['singleton_key'],
    'singleton_key equals 1',
    'idx:capacity_head:singleton',
    'zero_or_one',
  ),
  query(
    'capacity_admin_find_idempotency',
    'command_gateway',
    'Resolve same-request duplicate or conflicting Capacity idempotency key',
    'runtime_capacity_admin_commands',
    ['idempotency_domain', 'idempotency_key'],
    null,
    'idx:capacity_commands:idempotency',
    'zero_or_one',
  ),
  query(
    'capacity_admin_load_invocations',
    'command_gateway',
    'Read immutable invocation history for an authenticated Capacity command',
    'runtime_capacity_admin_invocations',
    ['command_id'],
    null,
    'idx:capacity_invocations:command_history',
    'many',
    [{ column: 'invocation_no', direction: 'asc' }],
  ),
  query(
    'capacity_admin_load_change_history',
    'command_gateway',
    'Read immutable event history for one Capacity change',
    'runtime_capacity_change_events',
    ['change_id'],
    null,
    'idx:capacity_events:change_history',
    'many',
    [{ column: 'event_seq', direction: 'asc' }],
  ),
  query(
    'capacity_recovery_load_pending_change',
    'recovery',
    'Load the durable CAP1 journal selected by the pending head',
    'runtime_capacity_head',
    [],
    'pending_change_id is not null',
    'idx:capacity_head:pending',
    'zero_or_one',
    [],
    ['runtime_capacity_admin_commands'],
  ),
  query(
    'capacity_recovery_verify_event_chain',
    'recovery',
    'Replay the append-only Capacity change event hash chain',
    'runtime_capacity_change_events',
    [],
    null,
    'idx:capacity_events:global_chain',
    'bounded_batch',
    [{ column: 'event_seq', direction: 'asc' }],
  ),
  query(
    'capacity_watcher_verify_committed_head',
    'recovery',
    'Verify publication revision/change/config/publication lineage before pointer swap',
    'runtime_capacity_head',
    ['singleton_key'],
    'all publication lineage fields are non-null and equal the parsed envelope',
    'idx:capacity_head:singleton',
    'zero_or_one',
  ),
];

function baseSchedulerAdmission(): LogicalTableMetadata {
  const table = LOGICAL_SCHEMA_TABLES.find(
    (candidate) => candidate.name === 'workflow_graph_scheduler_admissions',
  );
  if (!table)
    throw new Error('Historical scheduler admission metadata missing');
  return table;
}

export function buildCapacityLogicalSchemaDelta(): CapacityLogicalSchemaDelta {
  const schedulerAdmission = baseSchedulerAdmission();
  const addedTables = TABLE_SEEDS.map((seed, indexValue) =>
    buildTable(seed, indexValue + 1),
  );
  const revisionColumn: LogicalColumnMetadata = {
    ordinal: 1,
    ...integer('capacity_revision', false, 'positive'),
    relation_ids: ['fk:scheduler_admissions:capacity_lineage'],
  };
  const changeColumn: LogicalColumnMetadata = {
    ordinal: 2,
    ...id('capacity_change_id'),
    relation_ids: ['fk:scheduler_admissions:capacity_lineage'],
  };
  const extendedTables: CapacityLogicalSchemaDelta['extended_tables'] = [
    {
      name: 'workflow_graph_scheduler_admissions',
      base_table_hash: domainSeparatedSha256(
        'icarus:workflow-g0-10-base-logical-table:1\n',
        schedulerAdmission as unknown as JsonValue,
      ),
      added_columns: [revisionColumn, changeColumn],
      added_foreign_keys: [
        fk(
          'fk:scheduler_admissions:capacity_lineage',
          ['capacity_revision', 'capacity_change_id', 'capacity_config_hash'],
          'runtime_capacity_admin_commands',
          [
            'assigned_capacity_revision',
            'assigned_change_id',
            'proposed_config_hash',
          ],
        ),
      ],
      added_unique_keys: [],
      added_checks: [
        check(
          'ck:scheduler_admissions:capacity_lineage_complete',
          'all_or_none',
          ['capacity_revision', 'capacity_change_id', 'capacity_config_hash'],
          'revision/change/config lineage is always non-null and comes from one immutable watcher pointer',
        ),
      ],
      added_indexes: [],
    },
  ];
  const withoutHash = {
    format:
      'icarus.workflow-capacity-control-plane-logical-schema-delta/1' as const,
    schema_id: 'workflow-runtime-schema-v1' as const,
    base_logical_schema_manifest_hash: BASE_LOGICAL_SCHEMA_MANIFEST_HASH,
    delta_mode: 'additive_only' as const,
    contract_stage: 'logical_metadata' as const,
    executable_status: 'non_executable' as const,
    ddl_generation_status: 'forbidden_in_g0_10' as const,
    sqlite_open_status: 'forbidden_in_g0_10' as const,
    added_tables: addedTables,
    extended_tables: extendedTables,
    query_intents: [...CAPACITY_LOGICAL_QUERY_INTENTS],
    invariants: [
      'runtime_capacity_head is the only mutable CAS pointer',
      'runtime_capacity_change_events is append-only and hash chained',
      'prepared file_installed head_committed and watcher_published occur at most once per change while recovered failed and unauthorized_file_rejected may repeat',
      'command idempotency is unique by trusted domain and key while every authenticated invocation appends audit',
      'assigned revision and change id are unique and strictly advance from the committed head',
      'Scheduler Admission stores revision change id and config hash from one watcher-published immutable pointer',
      'G0.10 metadata is additive and does not mutate the G0.6 historical logical schema artifact',
    ],
  };
  return {
    ...withoutHash,
    delta_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-control-plane-logical-schema-delta:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

export const CAPACITY_BASE_LOGICAL_SCHEMA_MANIFEST_HASH =
  BASE_LOGICAL_SCHEMA_MANIFEST_HASH as Sha256Hash;
