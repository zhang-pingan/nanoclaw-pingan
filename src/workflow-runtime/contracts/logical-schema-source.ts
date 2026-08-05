import type {
  ExternalReferenceMetadata,
  ForeignKeyAction,
  ForeignKeyDeferrability,
  IndexIntentKind,
  LogicalCheckKind,
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalColumnType,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalQueryCatalogPayload,
  LogicalQueryIntent,
  LogicalSchemaSourcePayload,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
  QueryOwner,
  SafeIntegerIntent,
  TypedRelationCatalogPayload,
  TypedRelationRecord,
} from './logical-schema-types.js';
import type { JsonValue } from './types.js';
import {
  RUNTIME_AUDIT_EVENT_TYPES,
  RUNTIME_FACT_KINDS,
  RUNTIME_PERMISSION_CODES,
} from './catalog-protocol-types.js';
import {
  WORKFLOW_COMMAND_REASON_CODES,
  WORKFLOW_COMMAND_TYPES,
} from './closed-schema-types.js';

interface ColumnSeed {
  name: string;
  logicalType: LogicalColumnType;
  nullable?: boolean;
  safeInteger?: SafeIntegerIntent;
  enumValues?: readonly string[];
  defaultIntent?: JsonValue;
  externalReference?: ExternalReferenceMetadata;
}

interface ForeignKeySeed {
  id: string;
  source: readonly string[];
  targetTable: string;
  target?: readonly string[];
  onDelete?: ForeignKeyAction;
  deferrability?: ForeignKeyDeferrability;
}

interface UniqueKeySeed {
  id: string;
  columns: readonly string[];
  predicate?: string;
}

interface CheckSeed {
  id: string;
  kind: LogicalCheckKind;
  columns: readonly string[];
  intent: string;
}

interface IndexSeed {
  id: string;
  kind: IndexIntentKind;
  columns: readonly string[];
  predicate?: string;
  queries?: readonly string[];
}

interface TableSeed {
  name: string;
  sourceSection: string;
  columns: readonly ColumnSeed[];
  primaryKey: readonly string[];
  autoIncrement?: boolean;
  foreignKeys?: readonly ForeignKeySeed[];
  uniqueKeys?: readonly UniqueKeySeed[];
  checks?: readonly CheckSeed[];
  indexes?: readonly IndexSeed[];
  pairedColumns?: readonly (readonly [string, string])[];
  exactlyOne?: readonly (readonly string[])[];
  atMostOne?: readonly (readonly string[])[];
}

const ext = (
  name: string,
  validatorOwner: string,
  referenceDomain: string,
  nullable = false,
  immutable = true,
): ColumnSeed => ({
  name,
  logicalType: 'external_reference',
  nullable,
  externalReference: {
    validator_owner: validatorOwner,
    reference_domain: referenceDomain,
    immutable,
  },
});

const id = (name: string, nullable = false): ColumnSeed => ({
  name,
  logicalType: 'identifier',
  nullable,
});

const text = (
  name: string,
  nullable = false,
  enumValues: readonly string[] = [],
): ColumnSeed => ({
  name,
  logicalType: 'text',
  nullable,
  enumValues,
});

const hash = (name: string, nullable = false): ColumnSeed => ({
  name,
  logicalType: 'hash',
  nullable,
});

const json = (name: string, nullable = false): ColumnSeed => ({
  name,
  logicalType: 'canonical_json',
  nullable,
});

const integer = (
  name: string,
  nullable = false,
  safeInteger: SafeIntegerIntent = 'non_negative',
): ColumnSeed => ({
  name,
  logicalType: 'integer',
  nullable,
  safeInteger,
});

const bool = (name: string, nullable = false): ColumnSeed => ({
  name,
  logicalType: 'boolean_integer',
  nullable,
  safeInteger: 'non_negative',
});

const at = (name: string, nullable = false): ColumnSeed =>
  integer(name, nullable, 'non_negative');

const valuePair = (
  prefix: string,
  nullable = false,
): readonly [ColumnSeed, ColumnSeed] => [
  id(`${prefix}_value_id`, nullable),
  hash(`${prefix}_hash`, nullable),
];

const registryPair = (
  prefix: string,
  nullable = false,
): readonly [ColumnSeed, ColumnSeed] => [
  id(`${prefix}_resource_id`, nullable),
  hash(`${prefix}_resource_hash`, nullable),
];

const externalPair = (
  prefix: string,
  validatorOwner: string,
  referenceDomain: string,
  nullable = false,
): readonly [ColumnSeed, ColumnSeed] => [
  ext(`${prefix}_ref`, validatorOwner, referenceDomain, nullable),
  hash(`${prefix}_hash`, nullable),
];

const rowVersion = (): ColumnSeed => integer('row_version');

const fk = (
  idValue: string,
  source: string | readonly string[],
  targetTable: string,
  target: string | readonly string[] = 'id',
  onDelete: ForeignKeyAction = 'restrict',
  deferrability: ForeignKeyDeferrability = 'deferred',
): ForeignKeySeed => ({
  id: idValue,
  source: typeof source === 'string' ? [source] : source,
  targetTable,
  target: typeof target === 'string' ? [target] : target,
  onDelete,
  deferrability,
});

const uk = (
  idValue: string,
  columns: readonly string[],
  predicate?: string,
): UniqueKeySeed => ({ id: idValue, columns, predicate });

const check = (
  idValue: string,
  kind: LogicalCheckKind,
  columns: readonly string[],
  intent: string,
): CheckSeed => ({ id: idValue, kind, columns, intent });

const index = (
  idValue: string,
  kind: IndexIntentKind,
  columns: readonly string[],
  predicate?: string,
  queries: readonly string[] = [],
): IndexSeed => ({ id: idValue, kind, columns, predicate, queries });

const valueFk = (
  idValue: string,
  prefix: string,
  onDelete: ForeignKeyAction = 'restrict',
): ForeignKeySeed =>
  fk(
    idValue,
    [`${prefix}_value_id`, `${prefix}_hash`],
    'workflow_values',
    ['id', 'content_hash'],
    onDelete,
  );

const registryFk = (idValue: string, prefix: string): ForeignKeySeed =>
  fk(
    idValue,
    [`${prefix}_resource_id`, `${prefix}_resource_hash`],
    'workflow_registry_resources',
    ['id', 'content_hash'],
  );

function buildColumns(
  tableName: string,
  columns: readonly ColumnSeed[],
  foreignKeys: readonly ForeignKeySeed[],
): LogicalColumnMetadata[] {
  const relationIds = new Map<string, string[]>();
  for (const relation of foreignKeys) {
    for (const column of relation.source) {
      const ids = relationIds.get(column) ?? [];
      ids.push(relation.id);
      relationIds.set(column, ids);
    }
  }
  for (const column of columns) {
    if (column.externalReference) {
      const ids = relationIds.get(column.name) ?? [];
      ids.push(`ext:${tableName}:${column.name}`);
      relationIds.set(column.name, ids);
    }
  }
  return columns.map((column, ordinal) => ({
    ordinal: ordinal + 1,
    name: column.name,
    logical_type: column.logicalType,
    sqlite_type_intent:
      column.logicalType === 'integer' ||
      column.logicalType === 'boolean_integer'
        ? 'INTEGER'
        : 'TEXT',
    nullable: column.nullable ?? false,
    default_intent: column.defaultIntent ?? null,
    safe_integer_intent: column.safeInteger ?? 'not_applicable',
    enum_values: [...(column.enumValues ?? [])],
    relation_ids: (relationIds.get(column.name) ?? []).sort(),
    external_reference: column.externalReference ?? null,
  }));
}

function buildAutomaticChecks(
  tableName: string,
  columns: readonly LogicalColumnMetadata[],
): LogicalCheckMetadata[] {
  const checks: LogicalCheckMetadata[] = [];
  for (const column of columns) {
    if (column.enum_values.length > 0) {
      checks.push({
        check_id: `ck:${tableName}:${column.name}:enum`,
        kind: 'enum_membership',
        columns: [column.name],
        expression_intent: `value belongs to the closed ${column.name} catalog`,
      });
    }
    if (column.logical_type === 'hash') {
      checks.push({
        check_id: `ck:${tableName}:${column.name}:hash`,
        kind: 'hash_format',
        columns: [column.name],
        expression_intent: 'sha256:<64 lowercase hexadecimal characters>',
      });
    }
    if (column.safe_integer_intent !== 'not_applicable') {
      checks.push({
        check_id: `ck:${tableName}:${column.name}:safe_integer`,
        kind: 'safe_integer',
        columns: [column.name],
        expression_intent:
          column.safe_integer_intent === 'positive'
            ? 'positive JavaScript safe integer'
            : 'non-negative JavaScript safe integer',
      });
    }
    if (column.logical_type === 'boolean_integer') {
      checks.push({
        check_id: `ck:${tableName}:${column.name}:boolean`,
        kind: 'boolean_integer',
        columns: [column.name],
        expression_intent: 'integer is exactly 0 or 1',
      });
    }
  }
  return checks;
}

function buildTable(seed: TableSeed, ordinal: number): LogicalTableMetadata {
  const foreignKeys: LogicalForeignKeyMetadata[] = (seed.foreignKeys ?? []).map(
    (relation) => ({
      relation_id: relation.id,
      source_columns: [...relation.source],
      target_table: relation.targetTable,
      target_columns: [...(relation.target ?? ['id'])],
      on_delete: relation.onDelete ?? 'restrict',
      deferrability: relation.deferrability ?? 'deferred',
    }),
  );
  const columns = buildColumns(seed.name, seed.columns, seed.foreignKeys ?? []);
  const checks = buildAutomaticChecks(seed.name, columns);
  for (const [left, right] of seed.pairedColumns ?? []) {
    checks.push({
      check_id: `ck:${seed.name}:${left}:${right}:pair`,
      kind: 'all_or_none',
      columns: [left, right],
      expression_intent: 'both columns are null or both columns are non-null',
    });
  }
  for (const group of seed.exactlyOne ?? []) {
    checks.push({
      check_id: `ck:${seed.name}:${group.join(':')}:exactly_one`,
      kind: 'exactly_one',
      columns: [...group],
      expression_intent: 'exactly one typed relation column is non-null',
    });
  }
  for (const group of seed.atMostOne ?? []) {
    checks.push({
      check_id: `ck:${seed.name}:${group.join(':')}:at_most_one`,
      kind: 'at_most_one',
      columns: [...group],
      expression_intent: 'at most one typed relation column is non-null',
    });
  }
  checks.push(
    ...(seed.checks ?? []).map((candidate) => ({
      check_id: candidate.id,
      kind: candidate.kind,
      columns: [...candidate.columns],
      expression_intent: candidate.intent,
    })),
  );
  const uniqueKeys: LogicalUniqueKeyMetadata[] = (seed.uniqueKeys ?? []).map(
    (candidate) => ({
      key_id: candidate.id,
      columns: [...candidate.columns],
      predicate_intent: candidate.predicate ?? null,
    }),
  );
  const indexes: LogicalIndexMetadata[] = (seed.indexes ?? []).map(
    (candidate) => ({
      index_id: candidate.id,
      kind: candidate.kind,
      columns: [...candidate.columns],
      predicate_intent: candidate.predicate ?? null,
      supports_query_ids: [...(candidate.queries ?? [])],
    }),
  );
  return {
    ordinal,
    name: seed.name,
    source_section: seed.sourceSection,
    columns,
    primary_key: {
      columns: [...seed.primaryKey],
      auto_increment_intent: seed.autoIncrement ?? false,
    },
    foreign_keys: foreignKeys,
    unique_keys: uniqueKeys,
    checks,
    indexes,
  };
}

const RESOURCE_AND_CLAIM_TABLES: readonly TableSeed[] = [
  {
    name: 'workflow_graph_resource_accounts',
    sourceSection: 'Resource Ledger and scheduling',
    columns: [
      id('id'),
      ext(
        'deployment_scope_ref',
        'deployment_profile_registry',
        'deployment_scope',
        true,
      ),
      id('workflow_id', true),
      id('graph_run_id', true),
      id('scope_id', true),
      id('node_id', true),
      ...registryPair('execution_group', true),
      text('resource_type', false, [
        'state_activations_total',
        'graph_runs_total',
        'state_transitions_total',
        'child_workflows_total',
        'descendant_workflows_total',
        'scopes_total',
        'nodes_total',
        'edges_total',
        'map_items_total',
        'builds_total',
        'build_attempts_total',
        'attempts_total',
        'evaluator_attempts_total',
        'waits_total',
        'effect_operations_total',
        'facts_total',
        'logical_output_bytes_total',
        'stored_bytes_total',
        'active_waits',
        'active_executions',
        'input_tokens_total',
        'output_tokens_total',
        'tool_calls_total',
        'cost_micros_total',
      ]),
      integer('hard_limit', false, 'positive'),
      integer('reserved_amount'),
      integer('consumed_amount'),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:resource_accounts:workflow', 'workflow_id', 'workflows'),
      fk('fk:resource_accounts:run', 'graph_run_id', 'workflow_graph_runs'),
      fk('fk:resource_accounts:scope', 'scope_id', 'workflow_graph_scopes'),
      fk('fk:resource_accounts:node', 'node_id', 'workflow_graph_nodes'),
      registryFk('fk:resource_accounts:execution_group', 'execution_group'),
    ],
    exactlyOne: [
      [
        'deployment_scope_ref',
        'workflow_id',
        'graph_run_id',
        'scope_id',
        'node_id',
        'execution_group_resource_id',
      ],
    ],
    uniqueKeys: [
      uk(
        'uk:resource_accounts:deployment',
        ['deployment_scope_ref', 'resource_type'],
        'deployment_scope_ref is non-null',
      ),
      uk(
        'uk:resource_accounts:workflow',
        ['workflow_id', 'resource_type'],
        'workflow_id is non-null',
      ),
      uk(
        'uk:resource_accounts:run',
        ['graph_run_id', 'resource_type'],
        'graph_run_id is non-null',
      ),
      uk(
        'uk:resource_accounts:scope',
        ['scope_id', 'resource_type'],
        'scope_id is non-null',
      ),
      uk(
        'uk:resource_accounts:node',
        ['node_id', 'resource_type'],
        'node_id is non-null',
      ),
      uk(
        'uk:resource_accounts:execution_group',
        ['execution_group_resource_id', 'resource_type'],
        'execution_group_resource_id is non-null',
      ),
    ],
    checks: [
      check(
        'ck:resource_accounts:under_limit',
        'ordered_values',
        ['reserved_amount', 'consumed_amount', 'hard_limit'],
        'reserved_amount + consumed_amount does not exceed hard_limit',
      ),
    ],
  },
  {
    name: 'workflow_graph_resource_reservations',
    sourceSection: 'Resource Ledger and scheduling',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('reservation_group_id'),
      id('consumer_workflow_id', true),
      id('consumer_build_id', true),
      id('consumer_scope_id', true),
      id('consumer_node_id', true),
      id('consumer_attempt_id', true),
      id('consumer_wait_id', true),
      id('consumer_effect_id', true),
      id('consumer_fact_id', true),
      text('resource_type'),
      text('purpose'),
      text('settlement_mode', false, [
        'consume_on_create',
        'hold_then_release',
        'incremental',
      ]),
      integer('reserved_remaining'),
      integer('consumed_amount'),
      text('status', false, ['held', 'committed', 'released']),
      at('created_at_ms'),
      at('settled_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:resource_reservations:run', 'graph_run_id', 'workflow_graph_runs'),
      fk(
        'fk:resource_reservations:workflow',
        'consumer_workflow_id',
        'workflows',
      ),
      fk(
        'fk:resource_reservations:build',
        'consumer_build_id',
        'workflow_graph_scope_builds',
      ),
      fk(
        'fk:resource_reservations:scope',
        'consumer_scope_id',
        'workflow_graph_scopes',
      ),
      fk(
        'fk:resource_reservations:node',
        'consumer_node_id',
        'workflow_graph_nodes',
      ),
      fk(
        'fk:resource_reservations:attempt',
        'consumer_attempt_id',
        'workflow_graph_node_attempts',
      ),
      fk(
        'fk:resource_reservations:wait',
        'consumer_wait_id',
        'workflow_graph_waits',
      ),
      fk(
        'fk:resource_reservations:effect',
        'consumer_effect_id',
        'workflow_graph_effect_operations',
      ),
      fk(
        'fk:resource_reservations:fact',
        'consumer_fact_id',
        'workflow_graph_facts',
      ),
    ],
    exactlyOne: [
      [
        'consumer_workflow_id',
        'consumer_build_id',
        'consumer_scope_id',
        'consumer_node_id',
        'consumer_attempt_id',
        'consumer_wait_id',
        'consumer_effect_id',
        'consumer_fact_id',
      ],
    ],
    uniqueKeys: [
      uk(
        'uk:resource_reservations:workflow_consumer',
        ['graph_run_id', 'consumer_workflow_id', 'resource_type', 'purpose'],
        'consumer_workflow_id is non-null',
      ),
      uk(
        'uk:resource_reservations:build_consumer',
        ['graph_run_id', 'consumer_build_id', 'resource_type', 'purpose'],
        'consumer_build_id is non-null',
      ),
      uk(
        'uk:resource_reservations:scope_consumer',
        ['graph_run_id', 'consumer_scope_id', 'resource_type', 'purpose'],
        'consumer_scope_id is non-null',
      ),
      uk(
        'uk:resource_reservations:node_consumer',
        ['graph_run_id', 'consumer_node_id', 'resource_type', 'purpose'],
        'consumer_node_id is non-null',
      ),
      uk(
        'uk:resource_reservations:attempt_consumer',
        ['graph_run_id', 'consumer_attempt_id', 'resource_type', 'purpose'],
        'consumer_attempt_id is non-null',
      ),
      uk(
        'uk:resource_reservations:wait_consumer',
        ['graph_run_id', 'consumer_wait_id', 'resource_type', 'purpose'],
        'consumer_wait_id is non-null',
      ),
      uk(
        'uk:resource_reservations:effect_consumer',
        ['graph_run_id', 'consumer_effect_id', 'resource_type', 'purpose'],
        'consumer_effect_id is non-null',
      ),
      uk(
        'uk:resource_reservations:fact_consumer',
        ['graph_run_id', 'consumer_fact_id', 'resource_type', 'purpose'],
        'consumer_fact_id is non-null',
      ),
    ],
    checks: [
      check(
        'ck:resource_reservations:settlement_state',
        'state_field_consistency',
        ['status', 'settled_at_ms', 'reserved_remaining'],
        'held has no settlement time; committed/released have settlement time and consistent remaining reservation',
      ),
    ],
  },
  {
    name: 'workflow_graph_resource_reservation_postings',
    sourceSection: 'Resource Ledger and scheduling',
    columns: [
      id('reservation_id'),
      id('account_id'),
      integer('reserved_remaining'),
      integer('consumed_amount'),
      text('status', false, ['held', 'committed', 'released']),
      rowVersion(),
    ],
    primaryKey: ['reservation_id', 'account_id'],
    foreignKeys: [
      fk(
        'fk:reservation_postings:reservation',
        'reservation_id',
        'workflow_graph_resource_reservations',
      ),
      fk(
        'fk:reservation_postings:account',
        'account_id',
        'workflow_graph_resource_accounts',
      ),
    ],
  },
  {
    name: 'workflow_graph_resource_ledger_entries',
    sourceSection: 'Resource Ledger and scheduling',
    columns: [
      id('id'),
      id('graph_run_id'),
      integer('ledger_seq', false, 'positive'),
      id('reservation_group_id'),
      id('account_id'),
      id('reservation_id'),
      text('operation', false, ['reserve', 'commit', 'release', 'charge']),
      integer('delta_reserved'),
      integer('delta_consumed'),
      text('idempotency_key'),
      hash('previous_chain_hash'),
      hash('chain_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:ledger_entries:run', 'graph_run_id', 'workflow_graph_runs'),
      fk(
        'fk:ledger_entries:account',
        'account_id',
        'workflow_graph_resource_accounts',
      ),
      fk(
        'fk:ledger_entries:reservation',
        'reservation_id',
        'workflow_graph_resource_reservations',
      ),
    ],
    uniqueKeys: [
      uk('uk:ledger_entries:idempotency_key', ['idempotency_key']),
      uk('uk:ledger_entries:run_seq', ['graph_run_id', 'ledger_seq']),
    ],
  },
  {
    name: 'workflow_graph_scheduler_admissions',
    sourceSection: 'Resource Ledger and scheduling',
    columns: [
      integer('admission_seq', false, 'positive'),
      id('graph_run_id'),
      id('scope_id'),
      id('node_id'),
      id('attempt_id'),
      integer('eligible_event_seq'),
      id('execution_reservation_id'),
      hash('capacity_config_hash'),
      hash('runtime_supported_limits_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['admission_seq'],
    autoIncrement: true,
    foreignKeys: [
      fk('fk:scheduler_admissions:run', 'graph_run_id', 'workflow_graph_runs'),
      fk(
        'fk:scheduler_admissions:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:scheduler_admissions:node',
        ['graph_run_id', 'scope_id', 'node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:scheduler_admissions:attempt',
        ['graph_run_id', 'scope_id', 'node_id', 'attempt_id'],
        'workflow_graph_node_attempts',
        ['graph_run_id', 'scope_id', 'node_id', 'id'],
      ),
      fk(
        'fk:scheduler_admissions:reservation',
        'execution_reservation_id',
        'workflow_graph_resource_reservations',
      ),
    ],
  },
  {
    name: 'workflow_domain_resource_claims',
    sourceSection: 'Durable Domain Resource Claims',
    columns: [
      id('id'),
      text('namespace'),
      hash('key_hash'),
      text('mode', false, ['shared', 'exclusive']),
      id('owner_workflow_id'),
      ...registryPair('recipe'),
      id('source_intake_id'),
      text('creation_key'),
      integer('fencing_token', true),
      text('status', false, ['held', 'release_pending', 'released']),
      at('acquired_at_ms'),
      at('released_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:domain_claims:workflow', 'owner_workflow_id', 'workflows'),
      registryFk('fk:domain_claims:recipe', 'recipe'),
      fk(
        'fk:domain_claims:intake',
        'source_intake_id',
        'workflow_task_intakes',
      ),
    ],
    uniqueKeys: [
      uk('uk:domain_claims:owner_resource', [
        'owner_workflow_id',
        'namespace',
        'key_hash',
      ]),
      uk('uk:domain_claims:resource', ['namespace', 'key_hash']),
    ],
    checks: [
      check(
        'ck:domain_claims:fencing_mode',
        'state_field_consistency',
        ['mode', 'fencing_token'],
        'exclusive has a fencing token and shared has no fencing token',
      ),
      check(
        'ck:domain_claims:release_state',
        'state_field_consistency',
        ['status', 'released_at_ms'],
        'released has released_at_ms; held/release_pending do not claim release completion',
      ),
    ],
    indexes: [
      index('idx:domain_claims:resource_status', 'lookup', [
        'namespace',
        'key_hash',
        'status',
        'mode',
      ]),
    ],
  },
  {
    name: 'workflow_domain_resource_heads',
    sourceSection: 'Durable Domain Resource Claims',
    columns: [
      text('namespace'),
      hash('key_hash'),
      integer('current_fencing_token'),
      rowVersion(),
    ],
    primaryKey: ['namespace', 'key_hash'],
  },
];

const VALUE_REGISTRY_BACKUP_TABLES: readonly TableSeed[] = [
  {
    name: 'workflow_values',
    sourceSection: 'Immutable Value/Blob Store',
    columns: [
      id('id'),
      text('storage_kind', false, ['inline', 'blob', 'immutable_external']),
      json('inline_canonical_json', true),
      hash('blob_hash', true),
      ext(
        'immutable_external_locator',
        'storage_resolver',
        'immutable_external_locator',
        true,
      ),
      hash('expected_hash', true),
      hash('content_hash'),
      integer('byte_length'),
      text('media_type'),
      ...registryPair('schema'),
      ext('provenance_ref', 'value_provenance_validator', 'value_provenance'),
      text('retention_class', false, [
        'transient',
        'run_recovery',
        'workflow_audit',
        'user_artifact',
        'pinned',
      ]),
      text('payload_state', false, ['live', 'pruned', 'corrupt']),
      at('payload_pruned_at_ms', true),
      at('created_at_ms'),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:values:blob', 'blob_hash', 'workflow_blob_objects', 'blob_hash'),
      registryFk('fk:values:schema', 'schema'),
    ],
    uniqueKeys: [uk('uk:values:id_hash', ['id', 'content_hash'])],
    pairedColumns: [['immutable_external_locator', 'expected_hash']],
    exactlyOne: [
      ['inline_canonical_json', 'blob_hash', 'immutable_external_locator'],
    ],
    checks: [
      check(
        'ck:values:storage_shape',
        'state_field_consistency',
        [
          'storage_kind',
          'inline_canonical_json',
          'blob_hash',
          'immutable_external_locator',
          'expected_hash',
        ],
        'storage_kind selects exactly its own payload locator columns',
      ),
      check(
        'ck:values:payload_state',
        'state_field_consistency',
        ['payload_state', 'payload_pruned_at_ms'],
        'pruned has payload_pruned_at_ms; live/corrupt do not claim pruning time',
      ),
    ],
  },
  {
    name: 'workflow_value_edges',
    sourceSection: 'Immutable Value/Blob Store',
    columns: [
      id('parent_value_id'),
      id('child_value_id'),
      text('relation_kind', false, [
        'manifest_member',
        'artifact_file',
        'registry_dependency',
        'map_result_member',
      ]),
      text('member_key', true),
      integer('member_index', true),
      hash('child_expected_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['parent_value_id', 'child_value_id', 'relation_kind'],
    foreignKeys: [
      fk('fk:value_edges:parent', 'parent_value_id', 'workflow_values'),
      fk(
        'fk:value_edges:child',
        ['child_value_id', 'child_expected_hash'],
        'workflow_values',
        ['id', 'content_hash'],
      ),
    ],
    uniqueKeys: [
      uk(
        'uk:value_edges:member_key',
        ['parent_value_id', 'relation_kind', 'member_key'],
        'member_key is non-null',
      ),
      uk(
        'uk:value_edges:member_index',
        ['parent_value_id', 'relation_kind', 'member_index'],
        'member_index is non-null',
      ),
    ],
    exactlyOne: [['member_key', 'member_index']],
    indexes: [
      index(
        'idx:value_edges:parent',
        'gc_retention',
        ['parent_value_id', 'relation_kind', 'member_index', 'member_key'],
        undefined,
        ['query:value_children'],
      ),
    ],
  },
  {
    name: 'workflow_value_ownerships',
    sourceSection:
      'Immutable Value/Blob Store and SQLite relation expansion rules',
    columns: [
      id('value_id'),
      id('owner_workflow_id', true),
      id('owner_graph_run_id', true),
      id('owner_registry_resource_id', true),
      id('owner_feature_release_id', true),
      ext(
        'system_owner_ref',
        'core_subsystem_registry',
        'versioned_core_subsystem',
        true,
      ),
      at('created_at_ms'),
    ],
    primaryKey: ['value_id'],
    foreignKeys: [
      fk('fk:value_ownerships:value', 'value_id', 'workflow_values'),
      fk('fk:value_ownerships:workflow', 'owner_workflow_id', 'workflows'),
      fk(
        'fk:value_ownerships:run',
        'owner_graph_run_id',
        'workflow_graph_runs',
      ),
      fk(
        'fk:value_ownerships:registry_resource',
        'owner_registry_resource_id',
        'workflow_registry_resources',
      ),
      fk(
        'fk:value_ownerships:feature_release',
        'owner_feature_release_id',
        'workflow_feature_releases',
      ),
    ],
    exactlyOne: [
      [
        'owner_workflow_id',
        'owner_graph_run_id',
        'owner_registry_resource_id',
        'owner_feature_release_id',
        'system_owner_ref',
      ],
    ],
  },
  {
    name: 'workflow_blob_write_intents',
    sourceSection: 'Immutable Value/Blob Store',
    columns: [
      id('id'),
      hash('expected_hash'),
      integer('expected_byte_length'),
      integer('reserved_physical_bytes'),
      text('status', false, [
        'preparing',
        'installed',
        'committed',
        'abandoned',
      ]),
      ext(
        'lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        true,
        false,
      ),
      text('lease_token', true),
      at('lease_expires_at_ms', true),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    pairedColumns: [
      ['lease_owner', 'lease_token'],
      ['lease_owner', 'lease_expires_at_ms'],
    ],
    indexes: [
      index(
        'idx:blob_write_intents:expiry',
        'gc_retention',
        ['lease_expires_at_ms', 'id'],
        "status in ('preparing','installed')",
        ['query:blob_intent_expiry'],
      ),
    ],
  },
  {
    name: 'workflow_blob_objects',
    sourceSection: 'Immutable Value/Blob Store',
    columns: [
      hash('blob_hash'),
      integer('byte_length'),
      text('state', false, [
        'live',
        'gc_candidate',
        'deleting',
        'deleted',
        'corrupt',
      ]),
      integer('gc_epoch'),
      at('created_at_ms'),
      at('deleted_at_ms', true),
    ],
    primaryKey: ['blob_hash'],
    checks: [
      check(
        'ck:blob_objects:deleted_time',
        'state_field_consistency',
        ['state', 'deleted_at_ms'],
        'deleted has deleted_at_ms and other states do not',
      ),
    ],
    indexes: [
      index(
        'idx:blob_objects:gc_state',
        'gc_retention',
        ['state', 'gc_epoch', 'blob_hash'],
        "state in ('live','gc_candidate','deleting')",
        ['query:blob_gc_candidates'],
      ),
    ],
  },
  {
    name: 'workflow_registry_resources',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('id'),
      text('resource_type'),
      text('resource_id'),
      text('resource_version'),
      ext('owner_core_ref', 'core_release_registry', 'core_release', true),
      ext('owner_feature_id', 'feature_registry', 'feature', true),
      id('canonical_value_id'),
      hash('content_hash'),
      text('publication_state', false, ['staged', 'published', 'retired']),
      at('created_at_ms'),
      at('published_at_ms', true),
      at('retired_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:registry_resources:canonical_value',
        ['canonical_value_id', 'content_hash'],
        'workflow_values',
        ['id', 'content_hash'],
      ),
    ],
    uniqueKeys: [
      uk('uk:registry_resources:type_ref', [
        'resource_type',
        'resource_id',
        'resource_version',
      ]),
      uk('uk:registry_resources:id_hash', ['id', 'content_hash']),
    ],
    exactlyOne: [['owner_core_ref', 'owner_feature_id']],
    checks: [
      check(
        'ck:registry_resources:publication_time',
        'state_field_consistency',
        ['publication_state', 'published_at_ms', 'retired_at_ms'],
        'publication timestamps match staged/published/retired lifecycle',
      ),
    ],
  },
  {
    name: 'workflow_registry_resource_dependencies',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('resource_id'),
      id('dependency_resource_id'),
      text('dependency_kind'),
      hash('expected_content_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['resource_id', 'dependency_resource_id', 'dependency_kind'],
    foreignKeys: [
      fk(
        'fk:registry_dependencies:resource',
        'resource_id',
        'workflow_registry_resources',
      ),
      fk(
        'fk:registry_dependencies:dependency',
        ['dependency_resource_id', 'expected_content_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
    ],
  },
  {
    name: 'workflow_registry_closure_manifests',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('id'),
      hash('closure_hash'),
      ...valuePair('manifest'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [valueFk('fk:closure_manifests:value', 'manifest')],
    uniqueKeys: [
      uk('uk:closure_manifests:closure_hash', ['closure_hash']),
      uk('uk:closure_manifests:id_hash', ['id', 'closure_hash']),
    ],
    pairedColumns: [['manifest_value_id', 'manifest_hash']],
  },
  {
    name: 'workflow_registry_closure_members',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('closure_manifest_id'),
      id('resource_id'),
      text('resource_type'),
      hash('content_hash'),
      integer('member_index'),
    ],
    primaryKey: ['closure_manifest_id', 'resource_id'],
    foreignKeys: [
      fk(
        'fk:closure_members:manifest',
        'closure_manifest_id',
        'workflow_registry_closure_manifests',
      ),
      fk(
        'fk:closure_members:resource',
        ['resource_id', 'content_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
    ],
    uniqueKeys: [
      uk('uk:closure_members:manifest_index', [
        'closure_manifest_id',
        'member_index',
      ]),
    ],
  },
  {
    name: 'workflow_registry_snapshots',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('id'),
      hash('snapshot_hash'),
      id('closure_manifest_id'),
      hash('closure_hash'),
      text('compiler_version'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:registry_snapshots:closure',
        ['closure_manifest_id', 'closure_hash'],
        'workflow_registry_closure_manifests',
        ['id', 'closure_hash'],
      ),
    ],
    uniqueKeys: [
      uk('uk:registry_snapshots:snapshot_hash', ['snapshot_hash']),
      uk('uk:registry_snapshots:id_hash', ['id', 'snapshot_hash']),
    ],
  },
  {
    name: 'workflow_feature_releases',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('id'),
      ext('feature_id', 'feature_registry', 'feature'),
      ext('release_ref', 'feature_release_ref_validator', 'feature_release'),
      text('release_version'),
      hash('release_hash'),
      id('execution_artifact_resource_id', true),
      hash('execution_artifact_hash', true),
      text('status', false, [
        'staged',
        'active',
        'draining',
        'disabled',
        'deleting',
      ]),
      ...externalPair(
        'compatibility_snapshot',
        'core_compatibility_registry',
        'compatibility_snapshot',
      ),
      at('staged_at_ms'),
      at('activated_at_ms', true),
      at('disabled_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:feature_releases:execution_artifact',
        ['execution_artifact_resource_id', 'execution_artifact_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
    ],
    uniqueKeys: [
      uk('uk:feature_releases:feature_ref', [
        'feature_id',
        'release_ref',
        'release_version',
      ]),
      uk('uk:feature_releases:id_hash', ['id', 'release_hash']),
    ],
    pairedColumns: [
      ['execution_artifact_resource_id', 'execution_artifact_hash'],
    ],
  },
  {
    name: 'workflow_feature_release_resources',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('release_id'),
      id('resource_id'),
      hash('content_hash'),
      text('resource_role'),
    ],
    primaryKey: ['release_id', 'resource_id'],
    foreignKeys: [
      fk(
        'fk:feature_release_resources:release',
        'release_id',
        'workflow_feature_releases',
      ),
      fk(
        'fk:feature_release_resources:resource',
        ['resource_id', 'content_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
    ],
  },
  {
    name: 'workflow_feature_active_releases',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      ext('feature_id', 'feature_registry', 'feature'),
      id('release_id'),
      hash('release_hash'),
      rowVersion(),
      at('activated_at_ms'),
    ],
    primaryKey: ['feature_id'],
    foreignKeys: [
      fk(
        'fk:feature_active_releases:release',
        ['release_id', 'release_hash'],
        'workflow_feature_releases',
        ['id', 'release_hash'],
      ),
    ],
  },
  {
    name: 'workflow_registry_retention_handles',
    sourceSection:
      'Registry, Release, Retention and Backup and SQLite relation expansion rules',
    columns: [
      id('id'),
      text('handle_kind', false, [
        'published',
        'active_run',
        'manual_pin',
        'investigation',
      ]),
      id('feature_release_id', true),
      id('graph_run_id', true),
      id('backup_id', true),
      ext(
        'external_actor_ref',
        'command_actor_registry',
        'command_actor',
        true,
      ),
      id('closure_manifest_id'),
      hash('closure_hash'),
      text('status', false, ['held', 'released']),
      at('created_at_ms'),
      at('released_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:retention_handles:feature_release',
        'feature_release_id',
        'workflow_feature_releases',
      ),
      fk('fk:retention_handles:run', 'graph_run_id', 'workflow_graph_runs'),
      fk('fk:retention_handles:backup', 'backup_id', 'workflow_backups'),
      fk(
        'fk:retention_handles:closure',
        ['closure_manifest_id', 'closure_hash'],
        'workflow_registry_closure_manifests',
        ['id', 'closure_hash'],
      ),
    ],
    exactlyOne: [
      ['feature_release_id', 'graph_run_id', 'backup_id', 'external_actor_ref'],
    ],
    uniqueKeys: [
      uk(
        'uk:retention_handles:feature',
        ['handle_kind', 'feature_release_id', 'closure_manifest_id'],
        'feature_release_id is non-null',
      ),
      uk(
        'uk:retention_handles:run',
        ['handle_kind', 'graph_run_id', 'closure_manifest_id'],
        'graph_run_id is non-null',
      ),
      uk(
        'uk:retention_handles:backup',
        ['handle_kind', 'backup_id', 'closure_manifest_id'],
        'backup_id is non-null',
      ),
      uk(
        'uk:retention_handles:actor',
        ['handle_kind', 'external_actor_ref', 'closure_manifest_id'],
        'external_actor_ref is non-null',
      ),
    ],
    checks: [
      check(
        'ck:retention_handles:kind_root',
        'closed_target_mapping',
        [
          'handle_kind',
          'feature_release_id',
          'graph_run_id',
          'backup_id',
          'external_actor_ref',
        ],
        'handle_kind maps to exactly its allowed typed root',
      ),
      check(
        'ck:retention_handles:release_time',
        'state_field_consistency',
        ['status', 'released_at_ms'],
        'released has released_at_ms; held does not',
      ),
    ],
  },
  {
    name: 'workflow_registry_retention_handle_members',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [id('handle_id'), id('resource_id'), hash('content_hash')],
    primaryKey: ['handle_id', 'resource_id'],
    foreignKeys: [
      fk(
        'fk:retention_handle_members:handle',
        'handle_id',
        'workflow_registry_retention_handles',
      ),
      fk(
        'fk:retention_handle_members:resource',
        ['resource_id', 'content_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
    ],
  },
  {
    name: 'workflow_backups',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('id'),
      text('status', false, [
        'preparing',
        'copying',
        'completed',
        'failed',
        'expired',
      ]),
      ...externalPair(
        'database_snapshot',
        'backup_coordinator',
        'database_snapshot',
      ),
      ...valuePair('manifest', true),
      at('started_at_ms'),
      at('completed_at_ms', true),
      at('expires_at_ms'),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [valueFk('fk:backups:manifest', 'manifest')],
    pairedColumns: [['manifest_value_id', 'manifest_hash']],
    checks: [
      check(
        'ck:backups:status_time',
        'state_field_consistency',
        ['status', 'completed_at_ms'],
        'completed/failed have completion time and active backup phases do not',
      ),
    ],
  },
  {
    name: 'workflow_backup_blob_pins',
    sourceSection: 'Registry, Release, Retention and Backup',
    columns: [
      id('backup_id'),
      hash('blob_hash'),
      integer('expected_byte_length'),
      text('status', false, ['pinned', 'copied', 'released']),
      at('pinned_at_ms'),
      at('copied_at_ms', true),
      at('released_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['backup_id', 'blob_hash'],
    foreignKeys: [
      fk('fk:backup_blob_pins:backup', 'backup_id', 'workflow_backups'),
      fk(
        'fk:backup_blob_pins:blob',
        'blob_hash',
        'workflow_blob_objects',
        'blob_hash',
      ),
    ],
    checks: [
      check(
        'ck:backup_blob_pins:status_time',
        'state_field_consistency',
        ['status', 'copied_at_ms', 'released_at_ms'],
        'copy/release timestamps follow the pinned -> copied -> released lifecycle',
      ),
    ],
  },
];

const CREATION_WORKFLOW_CONTEXT_TABLES: readonly TableSeed[] = [
  {
    name: 'workflow_task_intakes',
    sourceSection: 'Intake, Routing and Creation',
    columns: [
      id('id'),
      text('request_id'),
      text('creation_domain'),
      text('creation_key'),
      text('source', false, [
        'global_assistant',
        'feature_ui',
        'schedule',
        'api',
        'workflow_transition',
      ]),
      ext('principal_ref', 'principal_identity_resolver', 'principal'),
      ...registryPair('routing_scope'),
      ...valuePair('raw_request', true),
      ...valuePair('initial_input'),
      ...valuePair('attachment_manifest'),
      text('explicit_task_kind', true),
      id('explicit_recipe_resource_id', true),
      text('status', false, [
        'routing',
        'needs_clarification',
        'awaiting_confirmation',
        'ready_to_create',
        'created',
        'unsupported',
        'rejected',
      ]),
      id('selected_recipe_resource_id', true),
      hash('selected_recipe_hash', true),
      id('current_revision_id'),
      integer('current_revision_no'),
      hash('current_revision_hash'),
      id('workflow_id', true),
      integer('next_attempt_no', false, 'positive'),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      registryFk('fk:task_intakes:routing_scope', 'routing_scope'),
      valueFk('fk:task_intakes:raw_request', 'raw_request'),
      valueFk('fk:task_intakes:initial_input', 'initial_input'),
      valueFk('fk:task_intakes:attachment_manifest', 'attachment_manifest'),
      fk(
        'fk:task_intakes:explicit_recipe',
        'explicit_recipe_resource_id',
        'workflow_registry_resources',
      ),
      fk(
        'fk:task_intakes:selected_recipe',
        ['selected_recipe_resource_id', 'selected_recipe_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
      fk(
        'fk:task_intakes:current_revision',
        ['id', 'current_revision_id', 'current_revision_no'],
        'workflow_task_intake_revisions',
        ['intake_id', 'id', 'revision_no'],
      ),
      fk('fk:task_intakes:workflow', 'workflow_id', 'workflows'),
    ],
    uniqueKeys: [
      uk('uk:task_intakes:request_id', ['request_id']),
      uk('uk:task_intakes:creation_key', ['creation_domain', 'creation_key']),
    ],
    pairedColumns: [
      ['raw_request_value_id', 'raw_request_hash'],
      ['selected_recipe_resource_id', 'selected_recipe_hash'],
    ],
    checks: [
      check(
        'ck:task_intakes:created_workflow',
        'state_field_consistency',
        ['status', 'workflow_id'],
        'created has workflow_id and all earlier/terminal rejection states do not',
      ),
      check(
        'ck:task_intakes:selected_recipe',
        'state_field_consistency',
        ['status', 'selected_recipe_resource_id', 'selected_recipe_hash'],
        'recipe selection fields appear only after a recipe has been selected',
      ),
    ],
  },
  {
    name: 'workflow_task_intake_revisions',
    sourceSection: 'Intake, Routing and Creation',
    columns: [
      id('id'),
      id('intake_id'),
      integer('revision_no'),
      id('parent_revision_id', true),
      ...valuePair('amendment', true),
      ...valuePair('effective_input'),
      ...valuePair('attachment_manifest'),
      ...registryPair('clarification_contract', true),
      id('source_routing_attempt_id', true),
      text('actor_kind', false, [
        'human',
        'feature_service',
        'automation',
        'system',
      ]),
      ext('principal_ref', 'principal_identity_resolver', 'principal'),
      text('idempotency_key'),
      hash('revision_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:intake_revisions:intake', 'intake_id', 'workflow_task_intakes'),
      fk(
        'fk:intake_revisions:parent',
        ['intake_id', 'parent_revision_id'],
        'workflow_task_intake_revisions',
        ['intake_id', 'id'],
      ),
      valueFk('fk:intake_revisions:amendment', 'amendment'),
      valueFk('fk:intake_revisions:effective_input', 'effective_input'),
      valueFk('fk:intake_revisions:attachments', 'attachment_manifest'),
      registryFk('fk:intake_revisions:clarification', 'clarification_contract'),
      fk(
        'fk:intake_revisions:routing_attempt',
        'source_routing_attempt_id',
        'workflow_routing_attempts',
      ),
    ],
    uniqueKeys: [
      uk('uk:intake_revisions:intake_revision', ['intake_id', 'revision_no']),
      uk('uk:intake_revisions:intake_id', ['intake_id', 'id']),
      uk('uk:intake_revisions:intake_id_no', [
        'intake_id',
        'id',
        'revision_no',
      ]),
      uk('uk:intake_revisions:idempotency', ['intake_id', 'idempotency_key']),
    ],
    pairedColumns: [
      ['amendment_value_id', 'amendment_hash'],
      [
        'clarification_contract_resource_id',
        'clarification_contract_resource_hash',
      ],
    ],
    checks: [
      check(
        'ck:intake_revisions:parent_sequence',
        'lineage_consistency',
        ['revision_no', 'parent_revision_id'],
        'revision zero has no parent; later revisions have the immediately preceding parent',
      ),
    ],
  },
  {
    name: 'workflow_routing_attempts',
    sourceSection: 'Intake, Routing and Creation',
    columns: [
      id('id'),
      id('intake_id'),
      integer('attempt_no', false, 'positive'),
      id('intake_revision_id'),
      hash('input_hash'),
      ...registryPair('parent_scope'),
      ...registryPair('scope'),
      ...registryPair('router_capability', true),
      ...valuePair('input_snapshot'),
      ...valuePair('decision'),
      text('decision_kind', false, [
        'recipe_selected',
        'child_scope_selected',
        'needs_clarification',
        'unsupported',
      ]),
      ...registryPair('target', true),
      integer('confidence_micros'),
      json('reason_codes_json'),
      json('missing_fields_json'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:routing_attempts:intake', 'intake_id', 'workflow_task_intakes'),
      fk(
        'fk:routing_attempts:revision',
        ['intake_id', 'intake_revision_id'],
        'workflow_task_intake_revisions',
        ['intake_id', 'id'],
      ),
      registryFk('fk:routing_attempts:parent_scope', 'parent_scope'),
      registryFk('fk:routing_attempts:scope', 'scope'),
      registryFk('fk:routing_attempts:router_capability', 'router_capability'),
      valueFk('fk:routing_attempts:input_snapshot', 'input_snapshot'),
      valueFk('fk:routing_attempts:decision', 'decision'),
      registryFk('fk:routing_attempts:target', 'target'),
    ],
    uniqueKeys: [
      uk('uk:routing_attempts:intake_attempt', ['intake_id', 'attempt_no']),
    ],
    pairedColumns: [
      ['router_capability_resource_id', 'router_capability_resource_hash'],
    ],
    checks: [
      check(
        'ck:routing_attempts:confidence_range',
        'ordered_values',
        ['confidence_micros'],
        'confidence_micros is between 0 and 1000000 inclusive',
      ),
      check(
        'ck:routing_attempts:decision_target',
        'state_field_consistency',
        ['decision_kind', 'target_resource_id', 'target_resource_hash'],
        'selected decisions have a target and non-selected decisions do not',
      ),
    ],
  },
  {
    name: 'workflow_creation_requests',
    sourceSection: 'Intake, Routing and Creation',
    columns: [
      id('id'),
      id('intake_id'),
      text('creation_mode', false, [
        'direct',
        'required_finalization',
        'best_effort_delivery',
      ]),
      text('creation_domain'),
      text('creation_key'),
      ...registryPair('recipe'),
      ...registryPair('definition'),
      text('entry_point'),
      ...registryPair('execution_policy'),
      ...valuePair('input_snapshot'),
      ...valuePair('attachment_manifest'),
      hash('creation_intent_hash'),
      hash('runtime_safety_hash'),
      id('launch_confirmation_id', true),
      hash('launch_confirmation_hash', true),
      text('status', false, [
        'pending',
        'blocked_retryable',
        'awaiting_confirmation',
        'created',
        'rejected_permanent',
        'cancelled',
      ]),
      id('workflow_id', true),
      text('error_code', true),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:creation_requests:intake', 'intake_id', 'workflow_task_intakes'),
      registryFk('fk:creation_requests:recipe', 'recipe'),
      registryFk('fk:creation_requests:definition', 'definition'),
      registryFk('fk:creation_requests:execution_policy', 'execution_policy'),
      valueFk('fk:creation_requests:input_snapshot', 'input_snapshot'),
      valueFk('fk:creation_requests:attachments', 'attachment_manifest'),
      fk(
        'fk:creation_requests:confirmation',
        ['launch_confirmation_id', 'launch_confirmation_hash'],
        'workflow_launch_confirmations',
        ['id', 'request_hash'],
      ),
      fk('fk:creation_requests:workflow', 'workflow_id', 'workflows'),
    ],
    uniqueKeys: [
      uk('uk:creation_requests:creation_key', [
        'creation_domain',
        'creation_key',
      ]),
      uk(
        'uk:creation_requests:intake_created',
        ['intake_id'],
        "status = 'created'",
      ),
    ],
    pairedColumns: [['launch_confirmation_id', 'launch_confirmation_hash']],
    checks: [
      check(
        'ck:creation_requests:terminal_fields',
        'state_field_consistency',
        ['status', 'workflow_id', 'error_code'],
        'created has workflow_id; rejected has error_code; non-terminal states have neither terminal field',
      ),
    ],
  },
  {
    name: 'workflow_launch_confirmations',
    sourceSection: 'Intake, Routing and Creation',
    columns: [
      id('id'),
      id('intake_id'),
      id('intake_revision_id'),
      hash('input_hash'),
      id('routing_decision_id'),
      hash('routing_decision_hash'),
      ...registryPair('recipe'),
      hash('creation_intent_hash'),
      ext('actor_ref', 'command_actor_registry', 'command_actor'),
      text('action', false, ['approve', 'decline']),
      at('expires_at_ms'),
      text('idempotency_key'),
      hash('request_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:launch_confirmations:intake',
        'intake_id',
        'workflow_task_intakes',
      ),
      fk(
        'fk:launch_confirmations:revision',
        ['intake_id', 'intake_revision_id'],
        'workflow_task_intake_revisions',
        ['intake_id', 'id'],
      ),
      fk(
        'fk:launch_confirmations:routing_attempt',
        'routing_decision_id',
        'workflow_routing_attempts',
      ),
      registryFk('fk:launch_confirmations:recipe', 'recipe'),
    ],
    uniqueKeys: [
      uk('uk:launch_confirmations:intake_idempotency', [
        'intake_id',
        'idempotency_key',
      ]),
      uk('uk:launch_confirmations:id_hash', ['id', 'request_hash']),
    ],
  },
  {
    name: 'workflow_creation_attempts',
    sourceSection: 'Intake, Routing and Creation',
    columns: [
      id('id'),
      id('creation_request_id'),
      integer('attempt_no', false, 'positive'),
      text('status', false, ['pending', 'retry_wait', 'succeeded', 'rejected']),
      text('error_code', true),
      at('retry_at_ms', true),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:creation_attempts:request',
        'creation_request_id',
        'workflow_creation_requests',
      ),
    ],
    uniqueKeys: [
      uk('uk:creation_attempts:request_attempt', [
        'creation_request_id',
        'attempt_no',
      ]),
    ],
    checks: [
      check(
        'ck:creation_attempts:retry_fields',
        'state_field_consistency',
        ['status', 'error_code', 'retry_at_ms'],
        'retry_wait has error_code and retry time; terminal success has neither',
      ),
    ],
  },
  {
    name: 'workflows',
    sourceSection: 'Workflow and Run',
    columns: [
      id('id'),
      text('status', false, [
        'active',
        'completed',
        'errored',
        'cancelled',
        'administratively_abandoned',
      ]),
      text('operational_state', false, [
        'healthy',
        'action_required',
        'quarantined',
        'administratively_abandoned',
      ]),
      ...registryPair('recipe'),
      text('recipe_version'),
      id('creation_request_id'),
      text('creation_domain'),
      text('creation_key'),
      ext('owner_principal_ref', 'principal_identity_resolver', 'principal'),
      ext('controlling_feature_id', 'feature_registry', 'feature', true),
      ext('creator_automation_ref', 'automation_registry', 'automation', true),
      hash('ownership_hash'),
      id('root_workflow_id'),
      id('parent_workflow_id', true),
      integer('workflow_depth'),
      id('lineage_budget_account_id'),
      ...registryPair('workflow_execution_policy'),
      ...registryPair('workflow_command_policy'),
      ...valuePair('workflow_input'),
      ...registryPair('workflow_input_schema'),
      ...registryPair('context_contract'),
      id('current_context_snapshot_id'),
      hash('current_context_snapshot_hash'),
      hash('runtime_safety_hash'),
      integer('state_activation_count'),
      integer('graph_run_count'),
      integer('state_transition_count'),
      integer('child_workflow_count'),
      at('started_at_ms'),
      at('deadline_at_ms', true),
      text('workflow_definition_version'),
      id('state_instance_id'),
      id('current_graph_run_id', true),
      text('final_outcome_kind', true, ['normal', 'errored', 'cancelled']),
      ...valuePair('final_output', true),
      hash('final_output_schema_hash', true),
      text('final_error_code', true),
      id('final_error_detail_value_id', true),
      hash('final_error_detail_hash', true),
      text('final_cancel_reason', true),
      integer('workflow_revision'),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
      at('finished_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      registryFk('fk:workflows:recipe', 'recipe'),
      fk(
        'fk:workflows:creation_request',
        'creation_request_id',
        'workflow_creation_requests',
      ),
      fk('fk:workflows:root', 'root_workflow_id', 'workflows'),
      fk('fk:workflows:parent', 'parent_workflow_id', 'workflows'),
      fk(
        'fk:workflows:lineage_account',
        'lineage_budget_account_id',
        'workflow_graph_resource_accounts',
      ),
      registryFk('fk:workflows:execution_policy', 'workflow_execution_policy'),
      registryFk('fk:workflows:command_policy', 'workflow_command_policy'),
      valueFk('fk:workflows:input', 'workflow_input'),
      registryFk('fk:workflows:input_schema', 'workflow_input_schema'),
      registryFk('fk:workflows:context_contract', 'context_contract'),
      fk(
        'fk:workflows:context_snapshot',
        ['id', 'current_context_snapshot_id', 'current_context_snapshot_hash'],
        'workflow_context_snapshots',
        ['workflow_id', 'id', 'snapshot_hash'],
      ),
      fk(
        'fk:workflows:state_instance',
        ['id', 'state_instance_id'],
        'workflow_state_activations',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:workflows:current_run',
        ['id', 'current_graph_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      valueFk('fk:workflows:final_output', 'final_output'),
      valueFk('fk:workflows:final_error_detail', 'final_error_detail'),
    ],
    uniqueKeys: [
      uk('uk:workflows:creation_key', ['creation_domain', 'creation_key']),
      uk('uk:workflows:id_state', ['id', 'state_instance_id']),
      uk('uk:workflows:id_run', ['id', 'current_graph_run_id']),
    ],
    pairedColumns: [
      ['final_output_value_id', 'final_output_hash'],
      ['final_error_detail_value_id', 'final_error_detail_hash'],
    ],
    checks: [
      check(
        'ck:workflows:status_time',
        'state_field_consistency',
        ['status', 'finished_at_ms'],
        'active has no finish time; every terminal business status has finish time',
      ),
      check(
        'ck:workflows:abandon_state',
        'cross_column_equality',
        ['status', 'operational_state'],
        'administratively_abandoned is set in both status columns or neither',
      ),
      check(
        'ck:workflows:final_outcome_shape',
        'state_field_consistency',
        [
          'status',
          'final_outcome_kind',
          'final_output_value_id',
          'final_error_code',
          'final_cancel_reason',
        ],
        'completed/errored/cancelled populate only their mutually exclusive final fields',
      ),
    ],
    indexes: [
      index(
        'idx:workflows:deadline',
        'watchdog',
        ['deadline_at_ms', 'id'],
        'finished_at_ms is null and deadline_at_ms is non-null',
        ['query:workflow_deadline_due'],
      ),
    ],
  },
  {
    name: 'workflow_state_activations',
    sourceSection: 'Workflow and Run',
    columns: [
      id('id'),
      id('workflow_id'),
      text('state_key'),
      text('state_type', false, [
        'delegation',
        'system',
        'interrupt',
        'graph',
        'terminal',
      ]),
      integer('activation_no', false, 'positive'),
      ...registryPair('workflow_definition'),
      text('workflow_definition_version'),
      ...valuePair('state_config'),
      text('status', false, ['active', 'completed', 'abandoned']),
      id('graph_run_id', true),
      id('entered_via_transition_id', true),
      text('terminal_kind', true, ['normal', 'errored']),
      ...valuePair('terminal_output', true),
      hash('terminal_output_schema_hash', true),
      text('terminal_error_code', true),
      id('terminal_error_detail_value_id', true),
      hash('terminal_error_detail_hash', true),
      at('started_at_ms'),
      at('finished_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:state_activations:workflow', 'workflow_id', 'workflows'),
      registryFk('fk:state_activations:definition', 'workflow_definition'),
      valueFk('fk:state_activations:config', 'state_config'),
      fk(
        'fk:state_activations:run',
        ['workflow_id', 'graph_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:state_activations:transition',
        'entered_via_transition_id',
        'workflow_state_transition_history',
      ),
      valueFk('fk:state_activations:terminal_output', 'terminal_output'),
      valueFk('fk:state_activations:terminal_error', 'terminal_error_detail'),
    ],
    uniqueKeys: [
      uk('uk:state_activations:workflow_activation', [
        'workflow_id',
        'activation_no',
      ]),
      uk(
        'uk:state_activations:graph_run',
        ['graph_run_id'],
        'graph_run_id is non-null',
      ),
      uk('uk:state_activations:workflow_id', ['workflow_id', 'id']),
    ],
    pairedColumns: [
      ['terminal_output_value_id', 'terminal_output_hash'],
      ['terminal_error_detail_value_id', 'terminal_error_detail_hash'],
    ],
    checks: [
      check(
        'ck:state_activations:type_run',
        'state_field_consistency',
        ['state_type', 'status', 'graph_run_id', 'terminal_kind'],
        'terminal activations complete without a run; non-terminal activations own exactly one run',
      ),
      check(
        'ck:state_activations:status_time',
        'state_field_consistency',
        ['status', 'finished_at_ms'],
        'active has no finish time; completed/abandoned have finish time',
      ),
      check(
        'ck:state_activations:terminal_shape',
        'state_field_consistency',
        [
          'terminal_kind',
          'terminal_output_value_id',
          'terminal_error_code',
          'terminal_error_detail_value_id',
        ],
        'normal and errored terminal activations populate mutually exclusive fields',
      ),
      check(
        'ck:state_activations:no_terminal_abandon',
        'state_field_consistency',
        ['state_type', 'status'],
        'terminal activation is never abandoned',
      ),
    ],
  },
  {
    name: 'workflow_graph_runs',
    sourceSection: 'Workflow and Run',
    columns: [
      id('id'),
      id('workflow_id'),
      text('state_key'),
      id('state_instance_id'),
      text('workflow_definition_version'),
      ...valuePair('state_config'),
      id('registry_snapshot_id'),
      hash('registry_snapshot_hash'),
      id('registry_retention_handle_id'),
      ...valuePair('runtime_safety_snapshot'),
      ...registryPair('runtime_supported_limits'),
      ...registryPair('sqlite_execution_profile'),
      hash('source_seed_hash'),
      id('root_scope_id'),
      id('root_build_id'),
      hash('root_plan_hash', true),
      integer('manifest_seq'),
      hash('manifest_head_hash'),
      integer('ledger_seq'),
      hash('ledger_head_hash'),
      text('lifecycle', false, [
        'initializing',
        'executing',
        'closing',
        'closed',
      ]),
      text('control', false, ['running', 'paused', 'resuming', 'cancelling']),
      text('operational_state', false, [
        'healthy',
        'action_required',
        'quarantined',
        'administratively_abandoned',
      ]),
      text('root_cancel_scope', true, ['local_graph', 'workflow']),
      id('root_close_request_id', true),
      id('completion_cut_id', true),
      integer('work_fence_epoch'),
      text('outcome_kind', true, ['completed', 'errored', 'cancelled']),
      text('exit_name', true),
      ...valuePair('output', true),
      text('error_code', true),
      id('error_detail_value_id', true),
      hash('error_detail_hash', true),
      integer('next_event_seq'),
      integer('last_admission_seq', true),
      rowVersion(),
      at('started_at_ms'),
      at('finished_at_ms', true),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:graph_runs:workflow', 'workflow_id', 'workflows'),
      fk(
        'fk:graph_runs:activation',
        ['workflow_id', 'state_instance_id'],
        'workflow_state_activations',
        ['workflow_id', 'id'],
      ),
      valueFk('fk:graph_runs:state_config', 'state_config'),
      fk(
        'fk:graph_runs:registry_snapshot',
        ['registry_snapshot_id', 'registry_snapshot_hash'],
        'workflow_registry_snapshots',
        ['id', 'snapshot_hash'],
      ),
      fk(
        'fk:graph_runs:retention_handle',
        'registry_retention_handle_id',
        'workflow_registry_retention_handles',
      ),
      valueFk('fk:graph_runs:safety_snapshot', 'runtime_safety_snapshot'),
      registryFk('fk:graph_runs:supported_limits', 'runtime_supported_limits'),
      registryFk('fk:graph_runs:sqlite_profile', 'sqlite_execution_profile'),
      fk(
        'fk:graph_runs:root_scope',
        ['id', 'root_scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:graph_runs:root_build',
        ['id', 'root_build_id'],
        'workflow_graph_scope_builds',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:graph_runs:root_close',
        ['id', 'root_scope_id', 'root_close_request_id'],
        'workflow_graph_scope_close_requests',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:graph_runs:completion_cut',
        ['id', 'root_scope_id', 'completion_cut_id'],
        'workflow_graph_completion_cuts',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      valueFk('fk:graph_runs:output', 'output'),
      valueFk('fk:graph_runs:error_detail', 'error_detail'),
    ],
    uniqueKeys: [
      uk('uk:graph_runs:workflow_activation', [
        'workflow_id',
        'state_instance_id',
      ]),
      uk('uk:graph_runs:workflow_id', ['workflow_id', 'id']),
      uk('uk:graph_runs:id_root_scope', ['id', 'root_scope_id']),
    ],
    pairedColumns: [
      ['output_value_id', 'output_hash'],
      ['error_detail_value_id', 'error_detail_hash'],
    ],
    checks: [
      check(
        'ck:graph_runs:closed_shape',
        'state_field_consistency',
        ['lifecycle', 'completion_cut_id', 'outcome_kind', 'finished_at_ms'],
        'closed has cut/outcome/finish time; non-closed has no completion cut',
      ),
      check(
        'ck:graph_runs:abandon_shape',
        'state_field_consistency',
        ['operational_state', 'lifecycle', 'completion_cut_id', 'outcome_kind'],
        'administratively abandoned run is not closed and has no cut/outcome',
      ),
      check(
        'ck:graph_runs:outcome_shape',
        'state_field_consistency',
        [
          'outcome_kind',
          'exit_name',
          'output_value_id',
          'error_code',
          'error_detail_value_id',
          'root_cancel_scope',
        ],
        'completed/errored/cancelled outcomes populate mutually exclusive fields',
      ),
    ],
  },
  {
    name: 'workflow_operational_blockers',
    sourceSection: 'Workflow and Run Operational Blockers',
    columns: [
      id('id'),
      id('workflow_id'),
      id('graph_run_id'),
      text('blocker_kind', false, [
        'effect_unknown',
        'compensation_dead_letter',
        'root_finalization_exhausted',
        'claim_release_failed',
        'resource_or_credential_unavailable',
        'integrity_quarantine',
      ]),
      text('severity', false, ['action_required', 'quarantine']),
      id('source_effect_operation_id', true),
      id('source_outbox_id', true),
      id('source_root_finalization_schedule_id', true),
      id('source_claim_id', true),
      integer('source_event_seq', true),
      text('error_code'),
      ...valuePair('evidence_manifest'),
      text('status', false, ['open', 'resolved', 'abandoned']),
      ...registryPair('remediation_policy'),
      integer('remediation_attempt_count'),
      at('next_remediation_at_ms', true),
      at('remediation_deadline_at_ms'),
      integer('opened_event_seq'),
      integer('resolved_event_seq', true),
      id('resolution_command_id', true),
      ...valuePair('resolution', true),
      rowVersion(),
      at('opened_at_ms'),
      at('resolved_at_ms', true),
      at('abandoned_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:operational_blockers:workflow', 'workflow_id', 'workflows'),
      fk(
        'fk:operational_blockers:run',
        ['workflow_id', 'graph_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:operational_blockers:effect',
        'source_effect_operation_id',
        'workflow_graph_effect_operations',
      ),
      fk(
        'fk:operational_blockers:outbox',
        'source_outbox_id',
        'workflow_outbox',
      ),
      fk(
        'fk:operational_blockers:finalization',
        'source_root_finalization_schedule_id',
        'workflow_root_finalization_schedules',
      ),
      fk(
        'fk:operational_blockers:claim',
        'source_claim_id',
        'workflow_domain_resource_claims',
      ),
      fk(
        'fk:operational_blockers:event',
        ['graph_run_id', 'source_event_seq'],
        'workflow_graph_events',
        ['graph_run_id', 'seq'],
      ),
      valueFk('fk:operational_blockers:evidence', 'evidence_manifest'),
      registryFk('fk:operational_blockers:policy', 'remediation_policy'),
      fk(
        'fk:operational_blockers:command',
        'resolution_command_id',
        'workflow_runtime_commands',
        'command_id',
      ),
      valueFk('fk:operational_blockers:resolution', 'resolution'),
    ],
    exactlyOne: [
      [
        'source_effect_operation_id',
        'source_outbox_id',
        'source_root_finalization_schedule_id',
        'source_claim_id',
        'source_event_seq',
      ],
    ],
    uniqueKeys: [
      uk(
        'uk:operational_blockers:effect_source',
        ['graph_run_id', 'blocker_kind', 'source_effect_operation_id'],
        'source_effect_operation_id is non-null',
      ),
      uk(
        'uk:operational_blockers:outbox_source',
        ['graph_run_id', 'blocker_kind', 'source_outbox_id'],
        'source_outbox_id is non-null',
      ),
      uk(
        'uk:operational_blockers:finalization_source',
        [
          'graph_run_id',
          'blocker_kind',
          'source_root_finalization_schedule_id',
        ],
        'source_root_finalization_schedule_id is non-null',
      ),
      uk(
        'uk:operational_blockers:claim_source',
        ['graph_run_id', 'blocker_kind', 'source_claim_id'],
        'source_claim_id is non-null',
      ),
      uk(
        'uk:operational_blockers:event_source',
        ['graph_run_id', 'blocker_kind', 'source_event_seq'],
        'source_event_seq is non-null',
      ),
    ],
    pairedColumns: [
      ['resolution_value_id', 'resolution_hash'],
      ['resolution_command_id', 'resolved_event_seq'],
    ],
    checks: [
      check(
        'ck:operational_blockers:resolution_shape',
        'state_field_consistency',
        [
          'status',
          'resolved_at_ms',
          'abandoned_at_ms',
          'resolution_command_id',
          'resolution_value_id',
        ],
        'open/resolved/abandoned populate only their permitted resolution fields',
      ),
    ],
    indexes: [
      index(
        'idx:operational_blockers:open',
        'recovery',
        ['graph_run_id', 'severity', 'status', 'id'],
        "status = 'open'",
        ['query:open_operational_blockers'],
      ),
      index(
        'idx:operational_blockers:remediation_due',
        'watchdog',
        ['next_remediation_at_ms', 'id'],
        "status = 'open' and next_remediation_at_ms is non-null",
        ['query:operational_remediation_due'],
      ),
    ],
  },
  {
    name: 'workflow_operational_blocker_remediation_attempts',
    sourceSection: 'Workflow and Run Operational Blockers',
    columns: [
      id('id'),
      id('blocker_id'),
      integer('attempt_no', false, 'positive'),
      text('attempt_key'),
      id('command_id', true),
      ...registryPair('remediation_policy'),
      text('attempt_kind', false, [
        'reconcile',
        'compensate',
        'finalization',
        'claim_release',
        'resource_preflight',
        'integrity_restore',
      ]),
      ...valuePair('request'),
      text('result', false, ['retry_wait', 'resolved', 'rejected']),
      ...valuePair('result', true),
      text('error_code', true),
      at('next_eligible_at_ms', true),
      at('started_at_ms'),
      at('finished_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:blocker_attempts:blocker',
        'blocker_id',
        'workflow_operational_blockers',
      ),
      fk(
        'fk:blocker_attempts:command',
        'command_id',
        'workflow_runtime_commands',
        'command_id',
      ),
      registryFk('fk:blocker_attempts:policy', 'remediation_policy'),
      valueFk('fk:blocker_attempts:request', 'request'),
      valueFk('fk:blocker_attempts:result', 'result'),
    ],
    uniqueKeys: [
      uk('uk:blocker_attempts:blocker_attempt', ['blocker_id', 'attempt_no']),
      uk('uk:blocker_attempts:key', ['attempt_key']),
    ],
    pairedColumns: [['result_value_id', 'result_hash']],
    checks: [
      check(
        'ck:blocker_attempts:result_shape',
        'state_field_consistency',
        ['result', 'result_value_id', 'error_code', 'next_eligible_at_ms'],
        'result fields match retry_wait/resolved/rejected semantics',
      ),
    ],
  },
  {
    name: 'workflow_state_transition_history',
    sourceSection: 'Workflow and Run',
    columns: [
      id('id'),
      id('workflow_id'),
      id('source_state_instance_id'),
      id('source_run_id'),
      id('completion_cut_id'),
      text('target_state_key', true),
      id('target_state_instance_id', true),
      id('target_run_id', true),
      integer('workflow_revision', false, 'positive'),
      hash('context_patch_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:transition_history:workflow', 'workflow_id', 'workflows'),
      fk(
        'fk:transition_history:source_activation',
        ['workflow_id', 'source_state_instance_id'],
        'workflow_state_activations',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:transition_history:source_run',
        ['workflow_id', 'source_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:transition_history:cut',
        'completion_cut_id',
        'workflow_graph_completion_cuts',
      ),
      fk(
        'fk:transition_history:target_activation',
        ['workflow_id', 'target_state_instance_id'],
        'workflow_state_activations',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:transition_history:target_run',
        ['workflow_id', 'target_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
    ],
    uniqueKeys: [
      uk('uk:transition_history:source_activation', [
        'source_state_instance_id',
      ]),
      uk('uk:transition_history:completion_cut', ['completion_cut_id']),
    ],
    checks: [
      check(
        'ck:transition_history:target_shape',
        'state_field_consistency',
        ['target_state_key', 'target_state_instance_id', 'target_run_id'],
        'global cancel has no target; terminal target has activation without run; non-terminal target has both',
      ),
    ],
  },
  {
    name: 'workflow_relations',
    sourceSection: 'Workflow and Run',
    columns: [
      id('id'),
      id('parent_workflow_id'),
      id('child_workflow_id'),
      id('root_workflow_id'),
      integer('workflow_depth', false, 'positive'),
      id('lineage_budget_account_id'),
      id('source_state_instance_id'),
      id('source_run_id'),
      id('source_completion_cut_id'),
      text('transition_effect_id'),
      text('relation_kind'),
      ...registryPair('recipe'),
      text('creation_key'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:workflow_relations:parent', 'parent_workflow_id', 'workflows'),
      fk('fk:workflow_relations:child', 'child_workflow_id', 'workflows'),
      fk('fk:workflow_relations:root', 'root_workflow_id', 'workflows'),
      fk(
        'fk:workflow_relations:lineage_account',
        'lineage_budget_account_id',
        'workflow_graph_resource_accounts',
      ),
      fk(
        'fk:workflow_relations:source_activation',
        'source_state_instance_id',
        'workflow_state_activations',
      ),
      fk(
        'fk:workflow_relations:source_run',
        'source_run_id',
        'workflow_graph_runs',
      ),
      fk(
        'fk:workflow_relations:source_cut',
        'source_completion_cut_id',
        'workflow_graph_completion_cuts',
      ),
      registryFk('fk:workflow_relations:recipe', 'recipe'),
    ],
    uniqueKeys: [
      uk('uk:workflow_relations:source_effect', [
        'parent_workflow_id',
        'source_completion_cut_id',
        'transition_effect_id',
      ]),
      uk('uk:workflow_relations:child', ['child_workflow_id']),
    ],
    checks: [
      check(
        'ck:workflow_relations:lineage',
        'lineage_consistency',
        [
          'parent_workflow_id',
          'child_workflow_id',
          'root_workflow_id',
          'workflow_depth',
          'lineage_budget_account_id',
        ],
        'parent/child/root lineage and shared descendant account are consistent',
      ),
    ],
  },
  {
    name: 'workflow_root_finalization_schedules',
    sourceSection: 'Workflow and Run Root Finalization',
    columns: [
      id('id'),
      id('workflow_id'),
      id('source_state_instance_id'),
      id('source_run_id'),
      id('root_scope_id'),
      id('close_request_id'),
      text('transition_effect_id'),
      id('transition_intake_id'),
      id('creation_request_id'),
      text('effect_type', false, ['required_child_workflow']),
      ...registryPair('recipe'),
      ...registryPair('routing_scope'),
      ext('principal_ref', 'principal_identity_resolver', 'principal'),
      hash('principal_hash'),
      ...valuePair('input_snapshot'),
      text('creation_domain'),
      text('creation_key'),
      hash('creation_intent_hash'),
      ...registryPair('finalization_policy'),
      text('status', false, [
        'pending',
        'retry_wait',
        'ready',
        'succeeded',
        'exhausted',
        'cancelled',
      ]),
      integer('attempt_count'),
      integer('max_attempts', false, 'positive'),
      at('next_eligible_at_ms', true),
      at('deadline_at_ms'),
      id('child_workflow_id', true),
      text('last_error_code', true),
      id('last_error_detail_value_id', true),
      hash('last_error_detail_hash', true),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
      at('completed_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:root_finalization_schedules:workflow', 'workflow_id', 'workflows'),
      fk(
        'fk:root_finalization_schedules:activation',
        ['workflow_id', 'source_state_instance_id'],
        'workflow_state_activations',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:root_finalization_schedules:run',
        ['workflow_id', 'source_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:root_finalization_schedules:scope',
        ['source_run_id', 'root_scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:root_finalization_schedules:close',
        ['source_run_id', 'root_scope_id', 'close_request_id'],
        'workflow_graph_scope_close_requests',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:root_finalization_schedules:intake',
        'transition_intake_id',
        'workflow_task_intakes',
      ),
      fk(
        'fk:root_finalization_schedules:creation_request',
        'creation_request_id',
        'workflow_creation_requests',
      ),
      registryFk('fk:root_finalization_schedules:recipe', 'recipe'),
      registryFk(
        'fk:root_finalization_schedules:routing_scope',
        'routing_scope',
      ),
      valueFk('fk:root_finalization_schedules:input', 'input_snapshot'),
      registryFk(
        'fk:root_finalization_schedules:policy',
        'finalization_policy',
      ),
      fk(
        'fk:root_finalization_schedules:child',
        'child_workflow_id',
        'workflows',
      ),
      valueFk('fk:root_finalization_schedules:last_error', 'last_error_detail'),
    ],
    uniqueKeys: [
      uk('uk:root_finalization_schedules:close_effect', [
        'close_request_id',
        'transition_effect_id',
      ]),
      uk('uk:root_finalization_schedules:creation_key', [
        'creation_domain',
        'creation_key',
      ]),
      uk('uk:root_finalization_schedules:intake', ['transition_intake_id']),
      uk('uk:root_finalization_schedules:creation_request', [
        'creation_request_id',
      ]),
    ],
    pairedColumns: [['last_error_detail_value_id', 'last_error_detail_hash']],
    checks: [
      check(
        'ck:root_finalization_schedules:attempt_budget',
        'ordered_values',
        ['attempt_count', 'max_attempts'],
        'attempt_count is between zero and max_attempts inclusive',
      ),
      check(
        'ck:root_finalization_schedules:success_shape',
        'state_field_consistency',
        ['status', 'child_workflow_id', 'completed_at_ms'],
        'succeeded has child and completion time; every other status has no child',
      ),
    ],
    indexes: [
      index(
        'idx:root_finalization_schedules:due',
        'watchdog',
        ['status', 'next_eligible_at_ms', 'id'],
        "status in ('pending','retry_wait')",
        ['query:root_finalization_due'],
      ),
    ],
  },
  {
    name: 'workflow_root_finalization_attempts',
    sourceSection: 'Workflow and Run Root Finalization',
    columns: [
      id('schedule_id'),
      integer('attempt_no', false, 'positive'),
      text('attempt_key'),
      ...valuePair('frozen_resolution'),
      ...valuePair('claim_preflight'),
      text('result', false, [
        'ready',
        'retryable_conflict',
        'permanent_rejection',
        'applied',
      ]),
      text('error_code', true),
      id('error_detail_value_id', true),
      hash('error_detail_hash', true),
      at('started_at_ms'),
      at('finished_at_ms'),
    ],
    primaryKey: ['schedule_id', 'attempt_no'],
    foreignKeys: [
      fk(
        'fk:root_finalization_attempts:schedule',
        'schedule_id',
        'workflow_root_finalization_schedules',
      ),
      valueFk('fk:root_finalization_attempts:resolution', 'frozen_resolution'),
      valueFk(
        'fk:root_finalization_attempts:claim_preflight',
        'claim_preflight',
      ),
      valueFk('fk:root_finalization_attempts:error_detail', 'error_detail'),
    ],
    uniqueKeys: [uk('uk:root_finalization_attempts:key', ['attempt_key'])],
    pairedColumns: [['error_detail_value_id', 'error_detail_hash']],
    checks: [
      check(
        'ck:root_finalization_attempts:result_shape',
        'state_field_consistency',
        ['result', 'error_code', 'error_detail_value_id'],
        'successful ready/applied results have no error; conflict/rejection may carry typed error detail',
      ),
    ],
  },
  {
    name: 'workflow_context_snapshots',
    sourceSection: 'Workflow and Run Context',
    columns: [
      id('id'),
      id('workflow_id'),
      integer('revision'),
      ...registryPair('contract'),
      id('previous_snapshot_id', true),
      hash('previous_snapshot_hash', true),
      ...valuePair('slots_manifest'),
      hash('snapshot_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:context_snapshots:workflow', 'workflow_id', 'workflows'),
      registryFk('fk:context_snapshots:contract', 'contract'),
      fk(
        'fk:context_snapshots:previous',
        ['workflow_id', 'previous_snapshot_id', 'previous_snapshot_hash'],
        'workflow_context_snapshots',
        ['workflow_id', 'id', 'snapshot_hash'],
      ),
      valueFk('fk:context_snapshots:slots_manifest', 'slots_manifest'),
    ],
    uniqueKeys: [
      uk('uk:context_snapshots:workflow_revision', ['workflow_id', 'revision']),
      uk('uk:context_snapshots:workflow_id_hash', [
        'workflow_id',
        'id',
        'snapshot_hash',
      ]),
    ],
    pairedColumns: [['previous_snapshot_id', 'previous_snapshot_hash']],
  },
  {
    name: 'workflow_context_slot_values',
    sourceSection: 'Workflow and Run Context',
    columns: [
      id('snapshot_id'),
      text('slot_name'),
      ...valuePair('value'),
      ...registryPair('schema'),
      integer('byte_length'),
      ext('provenance_ref', 'value_provenance_validator', 'value_provenance'),
    ],
    primaryKey: ['snapshot_id', 'slot_name'],
    foreignKeys: [
      fk(
        'fk:context_slots:snapshot',
        'snapshot_id',
        'workflow_context_snapshots',
      ),
      valueFk('fk:context_slots:value', 'value'),
      registryFk('fk:context_slots:schema', 'schema'),
    ],
  },
  {
    name: 'workflow_context_patches',
    sourceSection: 'Workflow and Run Context',
    columns: [
      id('id'),
      id('workflow_id'),
      id('source_run_id'),
      id('completion_cut_id'),
      ...valuePair('patch'),
      integer('operation_count'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:context_patches:workflow', 'workflow_id', 'workflows'),
      fk(
        'fk:context_patches:run',
        ['workflow_id', 'source_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:context_patches:cut',
        'completion_cut_id',
        'workflow_graph_completion_cuts',
      ),
      valueFk('fk:context_patches:value', 'patch'),
    ],
    uniqueKeys: [
      uk('uk:context_patches:completion_cut', ['completion_cut_id']),
    ],
  },
  {
    name: 'workflow_context_patch_operations',
    sourceSection: 'Workflow and Run Context',
    columns: [
      id('patch_id'),
      integer('operation_index'),
      text('operation', false, ['set', 'clear']),
      text('source_kind', true),
      text('source_port', true),
      text('source_slot', true),
      text('pointer', true),
      text('target_slot'),
      hash('old_value_hash', true),
      ...valuePair('new_value', true),
      hash('operation_hash'),
    ],
    primaryKey: ['patch_id', 'operation_index'],
    foreignKeys: [
      fk(
        'fk:context_patch_operations:patch',
        'patch_id',
        'workflow_context_patches',
      ),
      valueFk('fk:context_patch_operations:new_value', 'new_value'),
    ],
    uniqueKeys: [
      uk('uk:context_patch_operations:target_slot', [
        'patch_id',
        'target_slot',
      ]),
    ],
    pairedColumns: [['new_value_value_id', 'new_value_hash']],
    checks: [
      check(
        'ck:context_patch_operations:operation_shape',
        'state_field_consistency',
        [
          'operation',
          'source_kind',
          'source_port',
          'source_slot',
          'pointer',
          'new_value_value_id',
        ],
        'set has one valid typed source and new value; clear has no source or new value',
      ),
    ],
  },
];

const GRAPH_EXECUTION_TABLES: readonly TableSeed[] = [
  {
    name: 'workflow_graph_scope_plans',
    sourceSection: 'Scope Plan, Instance and Run Manifest',
    columns: [
      id('id'),
      id('graph_run_id'),
      hash('plan_hash'),
      text('format'),
      text('compiler_version'),
      json('source_json', true),
      ...valuePair('source', true),
      json('compiled_plan_json', true),
      id('compiled_plan_value_id', true),
      json('interface_snapshot_json'),
      hash('interface_snapshot_hash'),
      json('policy_snapshot_json'),
      hash('policy_snapshot_hash'),
      hash('capability_catalog_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:scope_plans:run', 'graph_run_id', 'workflow_graph_runs'),
      valueFk('fk:scope_plans:source', 'source'),
      fk(
        'fk:scope_plans:compiled_plan',
        ['compiled_plan_value_id', 'plan_hash'],
        'workflow_values',
        ['id', 'content_hash'],
      ),
    ],
    uniqueKeys: [
      uk('uk:scope_plans:run_hash', ['graph_run_id', 'plan_hash']),
      uk('uk:scope_plans:id_run_hash', ['id', 'graph_run_id', 'plan_hash']),
    ],
    atMostOne: [
      ['source_json', 'source_value_id'],
      ['compiled_plan_json', 'compiled_plan_value_id'],
    ],
  },
  {
    name: 'workflow_graph_scopes',
    sourceSection: 'Scope Plan, Instance and Run Manifest',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('parent_scope_id', true),
      id('owner_node_id', true),
      text('child_key', true),
      text('scope_kind', false, ['root', 'subgraph', 'expansion', 'map_item']),
      integer('depth'),
      id('plan_id', true),
      hash('plan_hash', true),
      json('input_snapshot_json', true),
      ...valuePair('input_snapshot', true),
      id('materialization_reservation_group_id', true),
      integer('owner_run_work_fence_epoch'),
      integer('owner_scope_work_fence_epoch'),
      text('lifecycle', false, [
        'materializing',
        'active',
        'closing',
        'closed',
      ]),
      integer('work_fence_epoch'),
      text('outcome_kind', true, ['completed', 'errored', 'cancelled']),
      text('exit_name', true),
      id('candidate_node_id', true),
      ...valuePair('output', true),
      text('error_code', true),
      id('error_detail_value_id', true),
      hash('error_detail_hash', true),
      id('close_request_id', true),
      id('completion_cut_id', true),
      integer('next_resolution_seq'),
      integer('next_candidate_seq'),
      rowVersion(),
      at('created_at_ms'),
      at('finished_at_ms', true),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:scopes:run', 'graph_run_id', 'workflow_graph_runs'),
      fk(
        'fk:scopes:parent',
        ['graph_run_id', 'parent_scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:scopes:owner_node',
        ['graph_run_id', 'parent_scope_id', 'owner_node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:scopes:plan',
        ['plan_id', 'graph_run_id', 'plan_hash'],
        'workflow_graph_scope_plans',
        ['id', 'graph_run_id', 'plan_hash'],
      ),
      valueFk('fk:scopes:input', 'input_snapshot'),
      fk(
        'fk:scopes:candidate_node',
        ['graph_run_id', 'id', 'candidate_node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      valueFk('fk:scopes:output', 'output'),
      valueFk('fk:scopes:error_detail', 'error_detail'),
      fk(
        'fk:scopes:close_request',
        ['graph_run_id', 'id', 'close_request_id'],
        'workflow_graph_scope_close_requests',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:scopes:completion_cut',
        ['graph_run_id', 'id', 'completion_cut_id'],
        'workflow_graph_completion_cuts',
        ['graph_run_id', 'scope_id', 'id'],
      ),
    ],
    uniqueKeys: [
      uk('uk:scopes:child_key', [
        'graph_run_id',
        'parent_scope_id',
        'owner_node_id',
        'child_key',
      ]),
      uk('uk:scopes:root', ['graph_run_id'], 'parent_scope_id is null'),
      uk('uk:scopes:run_id', ['graph_run_id', 'id']),
    ],
    pairedColumns: [
      ['plan_id', 'plan_hash'],
      ['input_snapshot_value_id', 'input_snapshot_hash'],
      ['output_value_id', 'output_hash'],
      ['error_detail_value_id', 'error_detail_hash'],
    ],
    checks: [
      check(
        'ck:scopes:nullable_plan',
        'state_field_consistency',
        ['scope_kind', 'parent_scope_id', 'plan_id', 'lifecycle'],
        'only a root materializing/setup-error shell may lack plan_id',
      ),
      check(
        'ck:scopes:root_ownership',
        'state_field_consistency',
        [
          'scope_kind',
          'parent_scope_id',
          'owner_node_id',
          'child_key',
          'depth',
        ],
        'root has no parent/owner/child key and depth zero; child scopes have all ownership fields',
      ),
      check(
        'ck:scopes:closed_shape',
        'state_field_consistency',
        [
          'lifecycle',
          'close_request_id',
          'completion_cut_id',
          'outcome_kind',
          'finished_at_ms',
        ],
        'closed scope has close/cut/outcome/finish; active phases have no cut',
      ),
    ],
    indexes: [
      index(
        'idx:scopes:parent',
        'scan',
        ['graph_run_id', 'parent_scope_id', 'depth', 'id'],
        undefined,
        ['query:subtree_scopes'],
      ),
    ],
  },
  {
    name: 'workflow_graph_run_manifest',
    sourceSection: 'Scope Plan, Instance and Run Manifest',
    columns: [
      id('graph_run_id'),
      integer('manifest_seq', false, 'positive'),
      text('entry_kind', false, ['scope_materialized', 'expansion_sealed']),
      id('scope_id', true),
      id('expansion_manifest_id', true),
      id('parent_scope_id', true),
      id('owner_node_id', true),
      text('child_key', true),
      text('scope_kind', true, ['root', 'subgraph', 'expansion', 'map_item']),
      hash('source_hash', true),
      hash('plan_hash', true),
      hash('interface_hash', true),
      hash('input_hash', true),
      hash('policy_hash', true),
      hash('expansion_hash', true),
      integer('item_count', true),
      hash('previous_manifest_hash'),
      hash('manifest_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['graph_run_id', 'manifest_seq'],
    foreignKeys: [
      fk('fk:run_manifest:run', 'graph_run_id', 'workflow_graph_runs'),
      fk(
        'fk:run_manifest:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:run_manifest:expansion',
        'expansion_manifest_id',
        'workflow_graph_expansion_manifests',
      ),
      fk(
        'fk:run_manifest:parent_scope',
        ['graph_run_id', 'parent_scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:run_manifest:owner_node',
        ['graph_run_id', 'parent_scope_id', 'owner_node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
    ],
    checks: [
      check(
        'ck:run_manifest:entry_shape',
        'state_field_consistency',
        [
          'entry_kind',
          'scope_id',
          'expansion_manifest_id',
          'source_hash',
          'plan_hash',
          'expansion_hash',
          'item_count',
        ],
        'scope and expansion entries populate only their own immutable manifest fields',
      ),
    ],
  },
  {
    name: 'workflow_graph_scope_builds',
    sourceSection: 'Scope Build and Expansion Manifest',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('owner_scope_id', true),
      id('owner_node_id', true),
      id('target_scope_id', true),
      text('invocation_key'),
      text('scope_kind', false, ['root', 'subgraph', 'expansion', 'map_item']),
      json('item_key_json', true),
      integer('item_index', true),
      json('source_seed_json', true),
      ...valuePair('source_seed', true),
      json('source_snapshot_json', true),
      ...valuePair('source_snapshot', true),
      json('input_snapshot_json', true),
      ...valuePair('input_snapshot', true),
      hash('compiler_snapshot_hash'),
      integer('run_work_fence_epoch'),
      integer('owner_scope_work_fence_epoch'),
      text('status', false, [
        'pending_snapshot',
        'ready_to_compile',
        'compiling',
        'compiled',
        'materialized',
        'failed',
        'fenced',
      ]),
      id('compiled_plan_id', true),
      hash('compiled_plan_hash', true),
      id('scope_id', true),
      id('materialization_reservation_group_id', true),
      integer('attempt_count', false, 'positive'),
      at('next_attempt_at_ms', true),
      at('deadline_at_ms', true),
      ext(
        'lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        true,
        false,
      ),
      text('lease_token', true),
      at('lease_expires_at_ms', true),
      text('error_code', true),
      id('error_detail_value_id', true),
      hash('error_detail_hash', true),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:scope_builds:run', 'graph_run_id', 'workflow_graph_runs'),
      fk(
        'fk:scope_builds:owner_scope',
        ['graph_run_id', 'owner_scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:scope_builds:owner_node',
        ['graph_run_id', 'owner_scope_id', 'owner_node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:scope_builds:target_scope',
        ['graph_run_id', 'target_scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      valueFk('fk:scope_builds:source_seed', 'source_seed'),
      valueFk('fk:scope_builds:source_snapshot', 'source_snapshot'),
      valueFk('fk:scope_builds:input_snapshot', 'input_snapshot'),
      fk(
        'fk:scope_builds:plan',
        ['compiled_plan_id', 'graph_run_id', 'compiled_plan_hash'],
        'workflow_graph_scope_plans',
        ['id', 'graph_run_id', 'plan_hash'],
      ),
      fk(
        'fk:scope_builds:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      valueFk('fk:scope_builds:error_detail', 'error_detail'),
    ],
    uniqueKeys: [
      uk('uk:scope_builds:invocation', [
        'graph_run_id',
        'owner_node_id',
        'invocation_key',
      ]),
      uk('uk:scope_builds:root', ['graph_run_id'], "scope_kind = 'root'"),
      uk('uk:scope_builds:run_id', ['graph_run_id', 'id']),
    ],
    pairedColumns: [
      ['compiled_plan_id', 'compiled_plan_hash'],
      ['error_detail_value_id', 'error_detail_hash'],
      ['lease_owner', 'lease_token'],
      ['lease_owner', 'lease_expires_at_ms'],
    ],
    checks: [
      check(
        'ck:scope_builds:source_shapes',
        'at_most_one',
        [
          'source_seed_json',
          'source_seed_value_id',
          'source_snapshot_json',
          'source_snapshot_value_id',
          'input_snapshot_json',
          'input_snapshot_value_id',
        ],
        'each JSON/ref representation uses at most one storage form',
      ),
      check(
        'ck:scope_builds:status_shape',
        'state_field_consistency',
        ['status', 'compiled_plan_id', 'scope_id', 'error_code'],
        'compiled/materialized/failed statuses populate their exact plan/scope/error fields',
      ),
    ],
  },
  {
    name: 'workflow_graph_expansion_manifests',
    sourceSection: 'Scope Build and Expansion Manifest',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('owner_node_id'),
      id('producer_attempt_id', true),
      text('mode', false, ['subgraph', 'expand', 'map']),
      ...valuePair('source_artifact'),
      json('manifest_json', true),
      ...valuePair('manifest', true),
      integer('item_count'),
      json('child_completion_policy_json'),
      hash('child_completion_policy_hash'),
      at('sealed_at_ms'),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:expansion_manifests:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:expansion_manifests:owner',
        ['graph_run_id', 'scope_id', 'owner_node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:expansion_manifests:producer_attempt',
        'producer_attempt_id',
        'workflow_graph_node_attempts',
      ),
      valueFk('fk:expansion_manifests:source_artifact', 'source_artifact'),
      valueFk('fk:expansion_manifests:manifest', 'manifest'),
    ],
    uniqueKeys: [uk('uk:expansion_manifests:owner', ['owner_node_id'])],
    atMostOne: [['manifest_json', 'manifest_value_id']],
  },
  {
    name: 'workflow_graph_map_item_results',
    sourceSection: 'Scope Build and Expansion Manifest',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('owner_scope_id'),
      id('owner_node_id'),
      id('expansion_manifest_id'),
      integer('item_index'),
      json('item_key_json'),
      hash('item_key_hash'),
      id('build_id', true),
      id('scope_id', true),
      text('outcome_state', false, [
        'open',
        'completed',
        'errored',
        'cancelled',
        'fenced',
      ]),
      text('exit_name', true),
      text('error_code', true),
      text('reason', true),
      ...valuePair('output', true),
      integer('completion_seq', true),
      integer('fence_event_seq', true),
      rowVersion(),
      at('created_at_ms'),
      at('resolved_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:map_item_results:owner_scope',
        ['graph_run_id', 'owner_scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:map_item_results:owner_node',
        ['graph_run_id', 'owner_scope_id', 'owner_node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:map_item_results:expansion',
        'expansion_manifest_id',
        'workflow_graph_expansion_manifests',
      ),
      fk(
        'fk:map_item_results:build',
        ['graph_run_id', 'build_id'],
        'workflow_graph_scope_builds',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:map_item_results:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      valueFk('fk:map_item_results:output', 'output'),
    ],
    uniqueKeys: [
      uk('uk:map_item_results:index', ['owner_node_id', 'item_index']),
      uk('uk:map_item_results:key', ['owner_node_id', 'item_key_hash']),
    ],
    checks: [
      check(
        'ck:map_item_results:outcome_shape',
        'state_field_consistency',
        [
          'outcome_state',
          'scope_id',
          'exit_name',
          'error_code',
          'reason',
          'output_value_id',
          'completion_seq',
          'fence_event_seq',
          'resolved_at_ms',
        ],
        'each open/completed/errored/cancelled/fenced result has its exact typed terminal shape',
      ),
    ],
  },
  {
    name: 'workflow_graph_nodes',
    sourceSection: 'Node, Attempt and Wait',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      text('node_key'),
      text('node_type', false, [
        'delegation',
        'system',
        'wait',
        'join',
        'subgraph',
        'expand',
        'map',
        'terminal',
      ]),
      id('capability_resource_id', true),
      text('capability_version', true),
      hash('capability_hash', true),
      json('normalized_node_json'),
      text('phase', false, [
        'pending',
        'ready',
        'active',
        'waiting',
        'retry_wait',
        'terminal',
      ]),
      text('trigger_state', false, ['unknown', 'true', 'false', 'error']),
      text('input_state', false, ['open', 'sealed', 'impossible', 'error']),
      json('trigger_cut_json', true),
      hash('trigger_cut_hash', true),
      json('input_snapshot_json', true),
      ...valuePair('input_snapshot', true),
      json('selected_edges_json', true),
      integer('activation_event_seq', true),
      integer('run_work_fence_epoch_at_activation', true),
      integer('scope_work_fence_epoch_at_activation', true),
      text('terminal_status', true, [
        'succeeded',
        'failed',
        'skipped',
        'cancelled',
      ]),
      text('terminal_code', true),
      text('child_exit', true),
      ...valuePair('published_output_envelope', true),
      hash('port_contract_hash', true),
      id('current_attempt_id', true),
      integer('current_attempt_no', true, 'positive'),
      id('active_wait_id', true),
      text('controller_state', true, [
        'sealing',
        'running',
        'closing_remaining',
        'settled',
      ]),
      json('controller_decision_json', true),
      hash('controller_decision_hash', true),
      integer('controller_remaining_count', true),
      id('controller_reservation_group_id', true),
      rowVersion(),
      at('ready_at_ms', true),
      at('terminal_at_ms', true),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:nodes:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:nodes:capability',
        ['capability_resource_id', 'capability_hash'],
        'workflow_registry_resources',
        ['id', 'content_hash'],
      ),
      valueFk('fk:nodes:input_snapshot', 'input_snapshot'),
      valueFk('fk:nodes:output_envelope', 'published_output_envelope'),
      fk(
        'fk:nodes:current_attempt',
        [
          'graph_run_id',
          'scope_id',
          'id',
          'current_attempt_id',
          'current_attempt_no',
        ],
        'workflow_graph_node_attempts',
        ['graph_run_id', 'scope_id', 'node_id', 'id', 'attempt_no'],
      ),
      fk(
        'fk:nodes:active_wait',
        ['graph_run_id', 'scope_id', 'id', 'active_wait_id'],
        'workflow_graph_waits',
        ['graph_run_id', 'scope_id', 'node_id', 'id'],
      ),
    ],
    uniqueKeys: [
      uk('uk:nodes:scope_key', ['scope_id', 'node_key']),
      uk('uk:nodes:scope_id', ['scope_id', 'id']),
      uk('uk:nodes:run_scope_id', ['graph_run_id', 'scope_id', 'id']),
    ],
    pairedColumns: [
      ['capability_resource_id', 'capability_hash'],
      ['trigger_cut_json', 'trigger_cut_hash'],
      ['published_output_envelope_value_id', 'published_output_envelope_hash'],
      ['current_attempt_id', 'current_attempt_no'],
      ['controller_decision_json', 'controller_decision_hash'],
    ],
    checks: [
      check(
        'ck:nodes:phase_shape',
        'state_field_consistency',
        ['phase', 'ready_at_ms', 'terminal_at_ms', 'terminal_status'],
        'ready/terminal timestamps and terminal outcome follow node phase',
      ),
      check(
        'ck:nodes:activation_snapshot',
        'state_field_consistency',
        [
          'activation_event_seq',
          'run_work_fence_epoch_at_activation',
          'scope_work_fence_epoch_at_activation',
          'trigger_cut_hash',
          'input_snapshot_hash',
        ],
        'activated work freezes event and both work epochs with trigger/input snapshot',
      ),
      check(
        'ck:nodes:controller_shape',
        'state_field_consistency',
        [
          'node_type',
          'controller_state',
          'controller_decision_json',
          'controller_remaining_count',
          'controller_reservation_group_id',
        ],
        'controller fields exist only for child-owner nodes',
      ),
    ],
    indexes: [
      index(
        'idx:nodes:ready',
        'ordering',
        ['phase', 'activation_event_seq', 'id'],
        "phase = 'ready'",
        ['query:scheduler_ready_nodes'],
      ),
    ],
  },
  {
    name: 'workflow_graph_node_attempts',
    sourceSection: 'Node, Attempt and Wait',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('node_id'),
      integer('attempt_no', false, 'positive'),
      text('continuation_kind', false, [
        'initial',
        'execution_retry',
        'quality_revision',
      ]),
      id('parent_attempt_id', true),
      integer('parent_attempt_no', true, 'positive'),
      text('phase', false, [
        'preparing',
        'dispatch_pending',
        'running',
        'evaluating',
        'terminal',
      ]),
      text('execution_outcome', true, ['succeeded', 'failed', 'cancelled']),
      text('quality_decision', true, [
        'pass',
        'needs_revision',
        'fail',
        'pending',
      ]),
      json('input_snapshot_json', true),
      ...valuePair('input_snapshot', true),
      json('selected_edges_json'),
      ...valuePair('context_pack'),
      ext(
        'delegation_id',
        'delegation_provider_registry',
        'delegation_execution',
        true,
      ),
      ext(
        'external_execution_id',
        'executor_adapter_registry',
        'external_execution',
        true,
      ),
      text('action_name', true),
      text('query_id', true),
      at('dispatch_started_at_ms', true),
      at('dispatch_deadline_at_ms', true),
      at('execution_started_at_ms', true),
      at('execution_deadline_at_ms', true),
      id('timeout_event_id', true),
      ...valuePair('artifact_refs', true),
      ...valuePair('result', true),
      ...valuePair('evaluation', true),
      ...valuePair('quality_revision_feedback', true),
      text('retry_reason_code', true),
      text('error_code', true),
      id('error_detail_value_id', true),
      hash('error_detail_hash', true),
      ...valuePair('usage_summary', true),
      text('acceptance_state', false, ['open', 'fenced']),
      integer('run_work_fence_epoch'),
      integer('scope_work_fence_epoch'),
      id('resource_reservation_group_id'),
      ext(
        'lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        true,
        false,
      ),
      text('lease_token', true),
      at('lease_expires_at_ms', true),
      at('heartbeat_at_ms', true),
      ext(
        'evaluation_lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        true,
        false,
      ),
      text('evaluation_lease_token', true),
      at('evaluation_lease_expires_at_ms', true),
      integer('evaluation_attempt_count'),
      at('evaluation_next_attempt_at_ms', true),
      at('evaluation_deadline_at_ms', true),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
      at('finished_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:node_attempts:node',
        ['graph_run_id', 'scope_id', 'node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:node_attempts:parent',
        [
          'graph_run_id',
          'scope_id',
          'node_id',
          'parent_attempt_id',
          'parent_attempt_no',
        ],
        'workflow_graph_node_attempts',
        ['graph_run_id', 'scope_id', 'node_id', 'id', 'attempt_no'],
      ),
      valueFk('fk:node_attempts:input_snapshot', 'input_snapshot'),
      valueFk('fk:node_attempts:context_pack', 'context_pack'),
      fk(
        'fk:node_attempts:timeout_event',
        ['graph_run_id', 'timeout_event_id'],
        'workflow_graph_events',
        ['graph_run_id', 'seq'],
      ),
      valueFk('fk:node_attempts:artifact_refs', 'artifact_refs'),
      valueFk('fk:node_attempts:result', 'result'),
      valueFk('fk:node_attempts:evaluation', 'evaluation'),
      valueFk('fk:node_attempts:feedback', 'quality_revision_feedback'),
      valueFk('fk:node_attempts:error_detail', 'error_detail'),
      valueFk('fk:node_attempts:usage_summary', 'usage_summary'),
    ],
    uniqueKeys: [
      uk('uk:node_attempts:node_attempt', ['node_id', 'attempt_no']),
      uk(
        'uk:node_attempts:delegation',
        ['delegation_id'],
        'delegation_id is non-null',
      ),
      uk(
        'uk:node_attempts:parent',
        ['parent_attempt_id'],
        'parent_attempt_id is non-null',
      ),
      uk('uk:node_attempts:composite', [
        'graph_run_id',
        'scope_id',
        'node_id',
        'id',
        'attempt_no',
      ]),
      uk('uk:node_attempts:run_scope_node_id', [
        'graph_run_id',
        'scope_id',
        'node_id',
        'id',
      ]),
      uk('uk:node_attempts:run_id', ['graph_run_id', 'id']),
    ],
    pairedColumns: [
      ['parent_attempt_id', 'parent_attempt_no'],
      ['dispatch_started_at_ms', 'dispatch_deadline_at_ms'],
      ['execution_started_at_ms', 'execution_deadline_at_ms'],
      ['quality_revision_feedback_value_id', 'quality_revision_feedback_hash'],
      ['error_detail_value_id', 'error_detail_hash'],
      ['lease_owner', 'lease_token'],
      ['lease_owner', 'lease_expires_at_ms'],
      ['evaluation_lease_owner', 'evaluation_lease_token'],
      ['evaluation_lease_owner', 'evaluation_lease_expires_at_ms'],
    ],
    checks: [
      check(
        'ck:node_attempts:continuation',
        'lineage_consistency',
        [
          'attempt_no',
          'continuation_kind',
          'parent_attempt_id',
          'parent_attempt_no',
        ],
        'attempt one is initial without parent; later attempts are typed continuations from adjacent same-node parent',
      ),
      check(
        'ck:node_attempts:quality_feedback',
        'state_field_consistency',
        [
          'quality_decision',
          'continuation_kind',
          'quality_revision_feedback_value_id',
        ],
        'feedback exists exactly for needs_revision and quality-revision continuation',
      ),
      check(
        'ck:node_attempts:terminal_shape',
        'state_field_consistency',
        ['phase', 'execution_outcome', 'quality_decision', 'finished_at_ms'],
        'terminal attempt has its typed outcome/decision and finish time',
      ),
    ],
    indexes: [
      index(
        'idx:node_attempts:execution_deadline',
        'watchdog',
        ['execution_deadline_at_ms', 'id'],
        "phase = 'running'",
        ['query:attempt_execution_deadline_due'],
      ),
      index(
        'idx:node_attempts:lease_expiry',
        'recovery',
        ['lease_expires_at_ms', 'id'],
        'lease_owner is non-null',
        ['query:attempt_lease_expired'],
      ),
      index(
        'idx:node_attempts:evaluation_due',
        'watchdog',
        ['evaluation_next_attempt_at_ms', 'id'],
        "phase = 'evaluating' and evaluation_next_attempt_at_ms is non-null",
        ['query:evaluation_due'],
      ),
    ],
  },
  {
    name: 'workflow_graph_retry_schedules',
    sourceSection: 'Node, Attempt and Wait',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('node_id'),
      id('source_attempt_id'),
      integer('source_attempt_no', false, 'positive'),
      integer('next_attempt_no', false, 'positive'),
      text('continuation_kind', false, ['execution_retry', 'quality_revision']),
      ...valuePair('quality_revision_feedback', true),
      text('retry_reason_code'),
      hash('retry_policy_hash'),
      integer('backoff_ms'),
      at('eligible_at_ms'),
      id('attempt_reservation_id'),
      text('status', false, ['scheduled', 'consumed', 'cancelled']),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:retry_schedules:node',
        ['graph_run_id', 'scope_id', 'node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:retry_schedules:attempt',
        [
          'graph_run_id',
          'scope_id',
          'node_id',
          'source_attempt_id',
          'source_attempt_no',
        ],
        'workflow_graph_node_attempts',
        ['graph_run_id', 'scope_id', 'node_id', 'id', 'attempt_no'],
      ),
      valueFk('fk:retry_schedules:feedback', 'quality_revision_feedback'),
      fk(
        'fk:retry_schedules:reservation',
        'attempt_reservation_id',
        'workflow_graph_resource_reservations',
      ),
    ],
    uniqueKeys: [
      uk('uk:retry_schedules:node_next', ['node_id', 'next_attempt_no']),
      uk('uk:retry_schedules:source_attempt', ['source_attempt_id']),
    ],
    pairedColumns: [
      ['quality_revision_feedback_value_id', 'quality_revision_feedback_hash'],
    ],
    checks: [
      check(
        'ck:retry_schedules:adjacent_attempt',
        'lineage_consistency',
        ['source_attempt_no', 'next_attempt_no'],
        'next_attempt_no is source_attempt_no plus one',
      ),
      check(
        'ck:retry_schedules:feedback_kind',
        'state_field_consistency',
        [
          'continuation_kind',
          'quality_revision_feedback_value_id',
          'retry_reason_code',
        ],
        'quality revision has exact feedback and quality_needs_revision code; execution retry has neither feedback nor that code',
      ),
    ],
    indexes: [
      index(
        'idx:retry_schedules:due',
        'watchdog',
        ['eligible_at_ms', 'id'],
        "status = 'scheduled'",
        ['query:retry_schedule_due'],
      ),
    ],
  },
  {
    name: 'workflow_graph_waits',
    sourceSection: 'Node, Attempt and Wait',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('node_id'),
      text('wait_type', false, ['signal', 'timer', 'approval']),
      ...registryPair('contract'),
      text('correlation_key'),
      hash('correlation_key_hash'),
      text('registration_key'),
      ...valuePair('payload', true),
      text('status', false, [
        'registering',
        'armed',
        'resolved',
        'timed_out',
        'cancelled',
      ]),
      at('armed_at_ms', true),
      at('deadline_at_ms', true),
      at('resolved_at_ms', true),
      ext(
        'registration_lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        true,
        false,
      ),
      text('registration_lease_token', true),
      at('registration_lease_expires_at_ms', true),
      integer('run_work_fence_epoch'),
      integer('scope_work_fence_epoch'),
      id('resource_reservation_group_id'),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:waits:node',
        ['graph_run_id', 'scope_id', 'node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      registryFk('fk:waits:contract', 'contract'),
      valueFk('fk:waits:payload', 'payload'),
    ],
    uniqueKeys: [
      uk('uk:waits:correlation', [
        'graph_run_id',
        'contract_resource_id',
        'correlation_key_hash',
      ]),
      uk('uk:waits:node', ['node_id']),
      uk('uk:waits:composite', ['graph_run_id', 'scope_id', 'node_id', 'id']),
      uk('uk:waits:run_id', ['graph_run_id', 'id']),
    ],
    pairedColumns: [
      ['payload_value_id', 'payload_hash'],
      ['registration_lease_owner', 'registration_lease_token'],
      ['registration_lease_owner', 'registration_lease_expires_at_ms'],
    ],
    checks: [
      check(
        'ck:waits:status_time',
        'state_field_consistency',
        ['status', 'armed_at_ms', 'deadline_at_ms', 'resolved_at_ms'],
        'armed/terminal wait timestamps match lifecycle and timer always has deadline',
      ),
    ],
    indexes: [
      index(
        'idx:waits:deadline',
        'watchdog',
        ['deadline_at_ms', 'id'],
        "status = 'armed' and deadline_at_ms is non-null",
        ['query:wait_deadline_due'],
      ),
    ],
  },
];

const GRAPH_FACT_AND_EFFECT_TABLES: readonly TableSeed[] = [
  {
    name: 'workflow_graph_edges',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      text('edge_key'),
      text('edge_kind', false, ['control', 'data']),
      json('compiled_edge_json'),
      hash('compiled_edge_hash'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:edges:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
    ],
    uniqueKeys: [
      uk('uk:edges:scope_key', ['scope_id', 'edge_key']),
      uk('uk:edges:run_scope_id', ['graph_run_id', 'scope_id', 'id']),
    ],
    indexes: [
      index(
        'idx:edges:scope_kind',
        'lookup',
        ['scope_id', 'edge_kind', 'id'],
        undefined,
        ['query:t3_affected_edges'],
      ),
    ],
  },
  {
    name: 'workflow_graph_control_edge_resolutions',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('edge_id'),
      text('state', false, ['unresolved', 'taken', 'not_taken', 'error']),
      hash('decision_input_hash', true),
      json('decision_json', true),
      text('error_code', true),
      integer('resolution_seq', true),
      at('resolved_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['edge_id'],
    foreignKeys: [
      fk('fk:control_resolutions:edge', 'edge_id', 'workflow_graph_edges'),
    ],
    checks: [
      check(
        'ck:control_resolutions:state_shape',
        'state_field_consistency',
        [
          'state',
          'decision_input_hash',
          'decision_json',
          'error_code',
          'resolution_seq',
          'resolved_at_ms',
        ],
        'unresolved has no decision fields; resolved/error states have one immutable resolution shape',
      ),
    ],
  },
  {
    name: 'workflow_graph_data_edge_resolutions',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('edge_id'),
      text('state', false, ['unresolved', 'available', 'unavailable', 'error']),
      ...valuePair('value', true),
      hash('schema_hash', true),
      id('source_attempt_id', true),
      text('error_code', true),
      integer('resolution_seq', true),
      at('resolved_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['edge_id'],
    foreignKeys: [
      fk('fk:data_resolutions:edge', 'edge_id', 'workflow_graph_edges'),
      valueFk('fk:data_resolutions:value', 'value'),
      fk(
        'fk:data_resolutions:source_attempt',
        'source_attempt_id',
        'workflow_graph_node_attempts',
      ),
    ],
    pairedColumns: [['value_value_id', 'value_hash']],
    checks: [
      check(
        'ck:data_resolutions:state_shape',
        'state_field_consistency',
        [
          'state',
          'value_value_id',
          'schema_hash',
          'source_attempt_id',
          'error_code',
          'resolution_seq',
          'resolved_at_ms',
        ],
        'available/unavailable/error/unresolved each populate only their permitted immutable fields',
      ),
    ],
  },
  {
    name: 'workflow_graph_terminal_candidates',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('terminal_node_id'),
      text('exit_name'),
      ...valuePair('output_snapshot'),
      integer('candidate_seq', false, 'positive'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:terminal_candidates:node',
        ['graph_run_id', 'scope_id', 'terminal_node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      valueFk('fk:terminal_candidates:output', 'output_snapshot'),
    ],
    uniqueKeys: [
      uk('uk:terminal_candidates:scope_node', ['scope_id', 'terminal_node_id']),
      uk('uk:terminal_candidates:scope_id', ['scope_id', 'id']),
    ],
  },
  {
    name: 'workflow_graph_completion_eligibilities',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      text('rule_id'),
      text('phase', false, ['early', 'settled']),
      integer('eligibility_event_seq', false, 'positive'),
      id('selected_candidate_id'),
      json('fact_snapshot_json'),
      hash('fact_snapshot_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:completion_eligibilities:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:completion_eligibilities:candidate',
        ['scope_id', 'selected_candidate_id'],
        'workflow_graph_terminal_candidates',
        ['scope_id', 'id'],
      ),
      fk(
        'fk:completion_eligibilities:event',
        ['graph_run_id', 'eligibility_event_seq'],
        'workflow_graph_events',
        ['graph_run_id', 'seq'],
      ),
    ],
    uniqueKeys: [
      uk('uk:completion_eligibilities:scope_rule', ['scope_id', 'rule_id']),
    ],
    indexes: [
      index(
        'idx:completion_eligibilities:arbitration',
        'ordering',
        ['graph_run_id', 'eligibility_event_seq', 'rule_id', 'scope_id'],
        undefined,
        ['query:resume_eligibility_arbitration'],
      ),
    ],
  },
  {
    name: 'workflow_graph_scope_close_requests',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      text('selected_rule_id', true),
      id('candidate_id', true),
      integer('eligibility_event_seq', true),
      json('fact_snapshot_json'),
      hash('fact_snapshot_hash'),
      json('node_frontier_json'),
      hash('node_frontier_hash'),
      json('edge_frontier_json'),
      hash('edge_frontier_hash'),
      integer('trigger_event_seq', false, 'positive'),
      integer('fenced_work_epoch_at_creation'),
      text('reason', false, [
        'normal',
        'engine_error',
        'local_cancel',
        'workflow_cancel',
        'parent_close',
      ]),
      text('error_code', true),
      id('error_detail_value_id', true),
      hash('error_detail_hash', true),
      json('cancel_payload_json', true),
      hash('cancel_payload_hash', true),
      hash('request_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:close_requests:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:close_requests:candidate',
        ['scope_id', 'candidate_id'],
        'workflow_graph_terminal_candidates',
        ['scope_id', 'id'],
      ),
      fk(
        'fk:close_requests:eligibility',
        ['scope_id', 'selected_rule_id'],
        'workflow_graph_completion_eligibilities',
        ['scope_id', 'rule_id'],
      ),
      fk(
        'fk:close_requests:trigger_event',
        ['graph_run_id', 'trigger_event_seq'],
        'workflow_graph_events',
        ['graph_run_id', 'seq'],
      ),
      valueFk('fk:close_requests:error_detail', 'error_detail'),
    ],
    uniqueKeys: [
      uk('uk:close_requests:scope', ['scope_id']),
      uk('uk:close_requests:scope_id', ['scope_id', 'id']),
      uk('uk:close_requests:run_scope_id', ['graph_run_id', 'scope_id', 'id']),
    ],
    pairedColumns: [
      ['selected_rule_id', 'candidate_id'],
      ['error_detail_value_id', 'error_detail_hash'],
      ['cancel_payload_json', 'cancel_payload_hash'],
    ],
    checks: [
      check(
        'ck:close_requests:reason_shape',
        'state_field_consistency',
        [
          'reason',
          'selected_rule_id',
          'candidate_id',
          'eligibility_event_seq',
          'error_code',
          'error_detail_value_id',
          'cancel_payload_json',
        ],
        'normal/error/cancel/parent-close requests populate mutually exclusive rule, error and cancel fields',
      ),
    ],
  },
  {
    name: 'workflow_graph_completion_cuts',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('close_request_id'),
      text('selected_rule_id', true),
      id('candidate_id', true),
      text('outcome_kind', false, ['completed', 'errored', 'cancelled']),
      text('exit_name', true),
      ...valuePair('output', true),
      hash('completion_policy_hash'),
      integer('cut_event_seq', false, 'positive'),
      hash('cut_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:completion_cuts:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:completion_cuts:close',
        ['graph_run_id', 'scope_id', 'close_request_id'],
        'workflow_graph_scope_close_requests',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:completion_cuts:candidate',
        ['scope_id', 'candidate_id'],
        'workflow_graph_terminal_candidates',
        ['scope_id', 'id'],
      ),
      valueFk('fk:completion_cuts:output', 'output'),
      fk(
        'fk:completion_cuts:event',
        ['graph_run_id', 'cut_event_seq'],
        'workflow_graph_events',
        ['graph_run_id', 'seq'],
      ),
    ],
    uniqueKeys: [
      uk('uk:completion_cuts:scope', ['scope_id']),
      uk('uk:completion_cuts:close', ['close_request_id']),
      uk('uk:completion_cuts:run_scope_id', ['graph_run_id', 'scope_id', 'id']),
    ],
    checks: [
      check(
        'ck:completion_cuts:outcome_shape',
        'state_field_consistency',
        [
          'outcome_kind',
          'exit_name',
          'output_value_id',
          'selected_rule_id',
          'candidate_id',
        ],
        'completed has rule/candidate/exit/output while error/cancel omit normal-selection fields',
      ),
    ],
  },
  {
    name: 'workflow_graph_child_completion_consumptions',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('id'),
      id('child_scope_id'),
      id('child_completion_cut_id'),
      id('parent_scope_id'),
      id('owner_node_id'),
      id('map_slot_id', true),
      text('disposition', false, [
        'owner_output_published',
        'map_slot_completed',
        'map_slot_fenced',
        'non_publish_parent_fenced',
        'non_publish_owner_fenced',
      ]),
      integer('parent_work_fence_epoch'),
      integer('disposition_event_seq', false, 'positive'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:child_consumptions:child_scope',
        'child_scope_id',
        'workflow_graph_scopes',
      ),
      fk(
        'fk:child_consumptions:child_cut',
        'child_completion_cut_id',
        'workflow_graph_completion_cuts',
      ),
      fk(
        'fk:child_consumptions:parent_scope',
        'parent_scope_id',
        'workflow_graph_scopes',
      ),
      fk(
        'fk:child_consumptions:owner_node',
        ['parent_scope_id', 'owner_node_id'],
        'workflow_graph_nodes',
        ['scope_id', 'id'],
      ),
      fk(
        'fk:child_consumptions:map_slot',
        'map_slot_id',
        'workflow_graph_map_item_results',
      ),
    ],
    uniqueKeys: [uk('uk:child_consumptions:child_scope', ['child_scope_id'])],
    checks: [
      check(
        'ck:child_consumptions:map_disposition',
        'state_field_consistency',
        ['disposition', 'map_slot_id'],
        'map dispositions have map slot and non-map owner dispositions do not',
      ),
    ],
  },
  {
    name: 'workflow_graph_subtree_fence_manifests',
    sourceSection: 'Edge Resolution, Candidate and Cut',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('source_close_request_id'),
      ...valuePair('scope_epochs_manifest'),
      ...valuePair('fenced_work_manifest'),
      ...valuePair('cleanup_effect_keys_manifest'),
      hash('subtree_fence_hash'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:subtree_fence_manifests:run',
        'graph_run_id',
        'workflow_graph_runs',
      ),
      fk(
        'fk:subtree_fence_manifests:close',
        'source_close_request_id',
        'workflow_graph_scope_close_requests',
      ),
      valueFk(
        'fk:subtree_fence_manifests:scope_epochs',
        'scope_epochs_manifest',
      ),
      valueFk('fk:subtree_fence_manifests:fenced_work', 'fenced_work_manifest'),
      valueFk(
        'fk:subtree_fence_manifests:cleanup_keys',
        'cleanup_effect_keys_manifest',
      ),
    ],
    uniqueKeys: [
      uk('uk:subtree_fence_manifests:close', ['source_close_request_id']),
    ],
  },
  {
    name: 'workflow_graph_inbox_events',
    sourceSection: 'Inbox, Late Result, Event and Effect Journal',
    columns: [
      integer('inbox_seq', false, 'positive'),
      ext('provider_ref', 'adapter_registry', 'signal_provider'),
      ext('provider_event_id', 'adapter_registry', 'provider_event'),
      ext('principal_ref', 'principal_identity_resolver', 'principal'),
      id('workflow_id'),
      id('graph_run_id'),
      ...registryPair('contract'),
      text('correlation_key'),
      hash('correlation_key_hash'),
      id('target_wait_id', true),
      ...valuePair('payload'),
      integer('byte_length'),
      ...valuePair('ingress_authorization'),
      ...valuePair('binding_authorization', true),
      text('disposition', false, [
        'pending',
        'accepted',
        'rejected',
        'duplicate',
        'conflict',
        'late',
        'unmatched_expired',
      ]),
      at('received_at_ms'),
      at('expires_at_ms'),
      at('resolved_at_ms', true),
    ],
    primaryKey: ['inbox_seq'],
    autoIncrement: true,
    foreignKeys: [
      fk('fk:inbox_events:workflow', 'workflow_id', 'workflows'),
      fk(
        'fk:inbox_events:run',
        ['workflow_id', 'graph_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      registryFk('fk:inbox_events:contract', 'contract'),
      fk(
        'fk:inbox_events:wait',
        ['graph_run_id', 'target_wait_id'],
        'workflow_graph_waits',
        ['graph_run_id', 'id'],
      ),
      valueFk('fk:inbox_events:payload', 'payload'),
      valueFk('fk:inbox_events:ingress_auth', 'ingress_authorization'),
      valueFk('fk:inbox_events:binding_auth', 'binding_authorization'),
    ],
    uniqueKeys: [
      uk('uk:inbox_events:provider_event', [
        'provider_ref',
        'provider_event_id',
      ]),
    ],
    checks: [
      check(
        'ck:inbox_events:disposition_shape',
        'state_field_consistency',
        [
          'disposition',
          'target_wait_id',
          'binding_authorization_value_id',
          'resolved_at_ms',
        ],
        'pending may be unbound; terminal dispositions have resolution time and accepted/rejected binding authorization',
      ),
    ],
    indexes: [
      index(
        'idx:inbox_events:correlation',
        'lookup',
        [
          'graph_run_id',
          'contract_resource_id',
          'correlation_key_hash',
          'disposition',
          'inbox_seq',
        ],
        undefined,
        ['query:pending_signal_match'],
      ),
      index(
        'idx:inbox_events:expiry',
        'gc_retention',
        ['expires_at_ms', 'inbox_seq'],
        "disposition = 'pending'",
        ['query:pending_signal_expiry'],
      ),
    ],
  },
  {
    name: 'workflow_graph_late_results',
    sourceSection: 'Inbox, Late Result, Event and Effect Journal',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('node_id'),
      id('attempt_id', true),
      id('wait_id', true),
      ext('source_event_id', 'callback_ingress_registry', 'callback_event'),
      ...valuePair('payload'),
      text('fence_reason'),
      at('received_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:late_results:node',
        ['graph_run_id', 'scope_id', 'node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:late_results:attempt',
        ['graph_run_id', 'attempt_id'],
        'workflow_graph_node_attempts',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:late_results:wait',
        ['graph_run_id', 'wait_id'],
        'workflow_graph_waits',
        ['graph_run_id', 'id'],
      ),
      valueFk('fk:late_results:payload', 'payload'),
    ],
    exactlyOne: [['attempt_id', 'wait_id']],
    uniqueKeys: [uk('uk:late_results:source_event', ['source_event_id'])],
  },
  {
    name: 'workflow_graph_effect_operations',
    sourceSection: 'Inbox, Late Result, Event and Effect Journal',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      id('node_id'),
      id('attempt_id'),
      text('operation_key'),
      json('key_strategy_json'),
      hash('key_strategy_hash'),
      text('execution_lane', false, ['normal', 'close_cleanup']),
      id('close_request_id', true),
      text('effect_type'),
      text('status', false, [
        'intended',
        'dispatched',
        'succeeded',
        'failed',
        'compensation_pending',
        'compensated',
        'compensation_not_required',
        'action_required',
      ]),
      ...valuePair('request'),
      ...valuePair('receipt', true),
      ...valuePair('before_state', true),
      ...valuePair('after_state', true),
      ...valuePair('immutable_output_snapshot', true),
      ...valuePair('compensation', true),
      ext(
        'lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        true,
        false,
      ),
      text('lease_token', true),
      at('lease_expires_at_ms', true),
      rowVersion(),
      at('created_at_ms'),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:effect_operations:attempt',
        ['graph_run_id', 'scope_id', 'node_id', 'attempt_id'],
        'workflow_graph_node_attempts',
        ['graph_run_id', 'scope_id', 'node_id', 'id'],
      ),
      fk(
        'fk:effect_operations:close',
        'close_request_id',
        'workflow_graph_scope_close_requests',
      ),
      valueFk('fk:effect_operations:request', 'request'),
      valueFk('fk:effect_operations:receipt', 'receipt'),
      valueFk('fk:effect_operations:before', 'before_state'),
      valueFk('fk:effect_operations:after', 'after_state'),
      valueFk('fk:effect_operations:output', 'immutable_output_snapshot'),
      valueFk('fk:effect_operations:compensation', 'compensation'),
    ],
    uniqueKeys: [uk('uk:effect_operations:key', ['operation_key'])],
    pairedColumns: [
      ['lease_owner', 'lease_token'],
      ['lease_owner', 'lease_expires_at_ms'],
    ],
    checks: [
      check(
        'ck:effect_operations:lane_close',
        'state_field_consistency',
        ['execution_lane', 'close_request_id'],
        'close_cleanup requires close_request_id and normal lane forbids it',
      ),
      check(
        'ck:effect_operations:status_shape',
        'state_field_consistency',
        [
          'status',
          'receipt_value_id',
          'before_state_value_id',
          'after_state_value_id',
          'immutable_output_snapshot_value_id',
          'compensation_value_id',
        ],
        'effect status matches receipt/snapshot/compensation evidence',
      ),
    ],
  },
  {
    name: 'workflow_graph_effect_operation_claims',
    sourceSection: 'Inbox, Late Result, Event and Effect Journal',
    columns: [
      id('operation_id'),
      id('claim_id'),
      text('claim_spec_id'),
      text('access', false, ['read', 'write']),
      integer('fencing_token', true),
    ],
    primaryKey: ['operation_id', 'claim_id'],
    foreignKeys: [
      fk(
        'fk:effect_claims:operation',
        'operation_id',
        'workflow_graph_effect_operations',
      ),
      fk(
        'fk:effect_claims:claim',
        'claim_id',
        'workflow_domain_resource_claims',
      ),
    ],
    checks: [
      check(
        'ck:effect_claims:write_fence',
        'state_field_consistency',
        ['access', 'fencing_token'],
        'write requires fencing token and read forbids it',
      ),
    ],
  },
  {
    name: 'workflow_graph_facts',
    sourceSection: 'Inbox, Late Result, Event and Effect Journal',
    columns: [
      id('id'),
      id('graph_run_id'),
      id('scope_id'),
      integer('event_seq', false, 'positive'),
      integer('causal_event_seq', true, 'positive'),
      integer('causal_wave'),
      text('fact_kind', false, RUNTIME_FACT_KINDS),
      text('stable_object_kind'),
      text('stable_object_id'),
      text('fact_key'),
      ...valuePair('payload'),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:facts:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:facts:event',
        ['graph_run_id', 'event_seq'],
        'workflow_graph_events',
        ['graph_run_id', 'seq'],
      ),
      valueFk('fk:facts:payload', 'payload'),
    ],
    uniqueKeys: [
      uk('uk:facts:key', ['graph_run_id', 'fact_key']),
      uk('uk:facts:event_seq', ['graph_run_id', 'event_seq']),
    ],
    indexes: [
      index(
        'idx:facts:scope_event',
        'ordering',
        ['graph_run_id', 'scope_id', 'event_seq'],
        undefined,
        ['query:t3_fact_frontier'],
      ),
      index(
        'idx:facts:queue',
        'ordering',
        ['graph_run_id', 'causal_wave', 'fact_kind', 'stable_object_id'],
        undefined,
        ['query:t3_fact_queue'],
      ),
    ],
  },
  {
    name: 'workflow_graph_events',
    sourceSection: 'Inbox, Late Result, Event and Effect Journal',
    columns: [
      id('graph_run_id'),
      integer('seq', false, 'positive'),
      id('scope_id', true),
      id('node_id', true),
      id('attempt_id', true),
      text('event_type', false, [
        ...RUNTIME_FACT_KINDS,
        ...RUNTIME_AUDIT_EVENT_TYPES,
      ]),
      text('idempotency_key'),
      json('payload_json', true),
      ...valuePair('payload', true),
      at('occurred_at_ms'),
      at('created_at_ms'),
    ],
    primaryKey: ['graph_run_id', 'seq'],
    foreignKeys: [
      fk('fk:events:run', 'graph_run_id', 'workflow_graph_runs'),
      fk(
        'fk:events:scope',
        ['graph_run_id', 'scope_id'],
        'workflow_graph_scopes',
        ['graph_run_id', 'id'],
      ),
      fk(
        'fk:events:node',
        ['graph_run_id', 'scope_id', 'node_id'],
        'workflow_graph_nodes',
        ['graph_run_id', 'scope_id', 'id'],
      ),
      fk(
        'fk:events:attempt',
        ['graph_run_id', 'attempt_id'],
        'workflow_graph_node_attempts',
        ['graph_run_id', 'id'],
      ),
      valueFk('fk:events:payload', 'payload'),
    ],
    uniqueKeys: [uk('uk:events:idempotency', ['idempotency_key'])],
    atMostOne: [['payload_json', 'payload_value_id']],
  },
];

const OUTBOX_COMMAND_CHECKPOINT_TABLES: readonly TableSeed[] = [
  {
    name: 'workflow_outbox',
    sourceSection: 'Outbox, Lease and Recovery',
    columns: [
      id('id'),
      text('effect_key'),
      id('workflow_id', true),
      id('attempt_id', true),
      id('wait_id', true),
      id('effect_operation_id', true),
      id('domain_claim_id', true),
      ext(
        'projection_target_ref',
        'projection_target_registry',
        'projection_target',
        true,
      ),
      integer('aggregate_row_version', true),
      text('effect_type'),
      ...registryPair('adapter'),
      ...registryPair('delivery_policy'),
      ...valuePair('policy_snapshot'),
      text('delivery_lane', false, [
        'normal_execution',
        'close_cleanup',
        'system_projection',
      ]),
      text('delivery_requirement', false, ['required', 'best_effort']),
      ...valuePair('payload'),
      text('status', false, [
        'pending',
        'processing',
        'reconciling',
        'succeeded',
        'dead_letter',
        'action_required',
      ]),
      integer('delivery_attempt_count'),
      integer('reconcile_attempt_count'),
      at('next_attempt_at_ms', true),
      at('deadline_at_ms'),
      ext(
        'lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        true,
        false,
      ),
      text('lease_token', true),
      at('lease_expires_at_ms', true),
      text('last_result_kind', true),
      text('last_error_code', true),
      at('created_at_ms'),
      at('delivered_at_ms', true),
      at('updated_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:outbox:workflow', 'workflow_id', 'workflows'),
      fk('fk:outbox:attempt', 'attempt_id', 'workflow_graph_node_attempts'),
      fk('fk:outbox:wait', 'wait_id', 'workflow_graph_waits'),
      fk(
        'fk:outbox:effect',
        'effect_operation_id',
        'workflow_graph_effect_operations',
      ),
      fk(
        'fk:outbox:claim',
        'domain_claim_id',
        'workflow_domain_resource_claims',
      ),
      registryFk('fk:outbox:adapter', 'adapter'),
      registryFk('fk:outbox:delivery_policy', 'delivery_policy'),
      valueFk('fk:outbox:policy_snapshot', 'policy_snapshot'),
      valueFk('fk:outbox:payload', 'payload'),
    ],
    exactlyOne: [
      [
        'workflow_id',
        'attempt_id',
        'wait_id',
        'effect_operation_id',
        'domain_claim_id',
        'projection_target_ref',
      ],
    ],
    uniqueKeys: [uk('uk:outbox:effect_key', ['effect_key'])],
    pairedColumns: [
      ['lease_owner', 'lease_token'],
      ['lease_owner', 'lease_expires_at_ms'],
    ],
    checks: [
      check(
        'ck:outbox:aggregate_version',
        'state_field_consistency',
        ['projection_target_ref', 'aggregate_row_version'],
        'external projection target has null aggregate row version; internal aggregate targets freeze row version',
      ),
      check(
        'ck:outbox:status_time',
        'state_field_consistency',
        ['status', 'delivered_at_ms', 'last_result_kind', 'last_error_code'],
        'succeeded has delivered time; failed/reconcile states preserve typed last result',
      ),
    ],
    indexes: [
      index(
        'idx:outbox:due',
        'watchdog',
        ['next_attempt_at_ms', 'id'],
        "status in ('pending','reconciling')",
        ['query:outbox_due'],
      ),
      index(
        'idx:outbox:lease_expiry',
        'recovery',
        ['lease_expires_at_ms', 'id'],
        "status in ('processing','reconciling')",
        ['query:outbox_lease_expired'],
      ),
    ],
  },
  {
    name: 'workflow_outbox_attempts',
    sourceSection: 'Outbox, Lease and Recovery',
    columns: [
      id('id'),
      id('outbox_id'),
      integer('history_seq', false, 'positive'),
      text('attempt_kind', false, ['deliver', 'reconcile']),
      integer('kind_attempt_no', false, 'positive'),
      ...registryPair('adapter'),
      hash('policy_hash'),
      ext(
        'lease_owner',
        'runtime_worker_registry',
        'worker_lease',
        false,
        false,
      ),
      text('lease_token'),
      ...valuePair('request'),
      text('result_kind'),
      text('result_code', true),
      ...valuePair('receipt', true),
      ext('external_id', 'adapter_registry', 'provider_result', true),
      at('started_at_ms'),
      at('finished_at_ms'),
      at('next_attempt_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:outbox_attempts:outbox', 'outbox_id', 'workflow_outbox'),
      registryFk('fk:outbox_attempts:adapter', 'adapter'),
      valueFk('fk:outbox_attempts:request', 'request'),
      valueFk('fk:outbox_attempts:receipt', 'receipt'),
    ],
    uniqueKeys: [
      uk('uk:outbox_attempts:history', ['outbox_id', 'history_seq']),
      uk('uk:outbox_attempts:kind_no', [
        'outbox_id',
        'attempt_kind',
        'kind_attempt_no',
      ]),
    ],
    pairedColumns: [['receipt_value_id', 'receipt_hash']],
  },
  {
    name: 'workflow_runtime_commands',
    sourceSection: 'Workflow Runtime Command authorization and audit',
    columns: [
      id('command_id'),
      text('idempotency_domain'),
      text('idempotency_key'),
      text('command_type', false, WORKFLOW_COMMAND_TYPES),
      id('workflow_id', true),
      id('run_id', true),
      id('node_id', true),
      id('retry_schedule_id', true),
      id('effect_operation_id', true),
      id('operational_blocker_id', true),
      integer('expected_row_version'),
      text('reason_code', false, WORKFLOW_COMMAND_REASON_CODES),
      ...valuePair('reason_text', true),
      ...valuePair('evidence_manifest'),
      hash('request_hash'),
      ...valuePair('canonical_result', true),
      at('created_at_ms'),
      at('finalized_at_ms', true),
    ],
    primaryKey: ['command_id'],
    foreignKeys: [
      fk('fk:runtime_commands:workflow', 'workflow_id', 'workflows'),
      fk('fk:runtime_commands:run', 'run_id', 'workflow_graph_runs'),
      fk('fk:runtime_commands:node', 'node_id', 'workflow_graph_nodes'),
      fk(
        'fk:runtime_commands:retry',
        'retry_schedule_id',
        'workflow_graph_retry_schedules',
      ),
      fk(
        'fk:runtime_commands:effect',
        'effect_operation_id',
        'workflow_graph_effect_operations',
      ),
      fk(
        'fk:runtime_commands:blocker',
        'operational_blocker_id',
        'workflow_operational_blockers',
      ),
      valueFk('fk:runtime_commands:reason_text', 'reason_text'),
      valueFk('fk:runtime_commands:evidence', 'evidence_manifest'),
      valueFk('fk:runtime_commands:result', 'canonical_result'),
    ],
    exactlyOne: [
      [
        'workflow_id',
        'run_id',
        'node_id',
        'retry_schedule_id',
        'effect_operation_id',
        'operational_blocker_id',
      ],
    ],
    uniqueKeys: [
      uk('uk:runtime_commands:idempotency', [
        'idempotency_domain',
        'idempotency_key',
      ]),
      uk('uk:runtime_commands:id_hash', ['command_id', 'request_hash']),
    ],
    pairedColumns: [
      ['reason_text_value_id', 'reason_text_hash'],
      ['canonical_result_value_id', 'canonical_result_hash'],
    ],
    checks: [
      check(
        'ck:runtime_commands:target_mapping',
        'closed_target_mapping',
        [
          'command_type',
          'workflow_id',
          'run_id',
          'node_id',
          'retry_schedule_id',
          'effect_operation_id',
          'operational_blocker_id',
        ],
        'command type maps to exactly one of the six closed typed targets',
      ),
      check(
        'ck:runtime_commands:finalization',
        'state_field_consistency',
        ['canonical_result_value_id', 'finalized_at_ms'],
        'canonical result and finalized time appear together',
      ),
    ],
    indexes: [
      index(
        'idx:runtime_commands:idempotency',
        'lookup',
        ['idempotency_domain', 'idempotency_key'],
        undefined,
        ['query:command_idempotency_lookup'],
      ),
    ],
  },
  {
    name: 'workflow_runtime_command_invocations',
    sourceSection: 'Workflow Runtime Command authorization and audit',
    columns: [
      id('id'),
      id('command_id'),
      integer('invocation_no', false, 'positive'),
      hash('submitted_request_hash'),
      ext('actor_ref', 'command_actor_registry', 'command_actor'),
      text('actor_kind', false, [
        'human',
        'feature_service',
        'automation',
        'system',
      ]),
      ext(
        'auth_session_ref',
        'authentication_session_registry',
        'auth_session',
      ),
      text('entrypoint'),
      ext('source_feature_id', 'feature_registry', 'feature', true),
      ext(
        'delegation_chain_ref',
        'delegation_authorization_registry',
        'delegation_chain',
        true,
      ),
      text('required_permission', false, RUNTIME_PERMISSION_CODES),
      ...registryPair('command_policy'),
      text('authorization_result', false, ['allowed', 'denied']),
      text('execution_result', false, [
        'applied',
        'denied',
        'conflict',
        'duplicate',
        'late',
      ]),
      hash('target_before_hash', true),
      hash('target_after_hash', true),
      integer('resulting_event_seq', true),
      id('close_request_id', true),
      id('effect_operation_id', true),
      at('requested_at_ms'),
      at('decided_at_ms'),
      at('applied_at_ms', true),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:command_invocations:command',
        'command_id',
        'workflow_runtime_commands',
        'command_id',
      ),
      registryFk('fk:command_invocations:policy', 'command_policy'),
      fk(
        'fk:command_invocations:close',
        'close_request_id',
        'workflow_graph_scope_close_requests',
      ),
      fk(
        'fk:command_invocations:effect',
        'effect_operation_id',
        'workflow_graph_effect_operations',
      ),
    ],
    uniqueKeys: [
      uk('uk:command_invocations:number', ['command_id', 'invocation_no']),
    ],
    checks: [
      check(
        'ck:command_invocations:execution_shape',
        'state_field_consistency',
        [
          'authorization_result',
          'execution_result',
          'target_before_hash',
          'target_after_hash',
          'resulting_event_seq',
          'close_request_id',
          'effect_operation_id',
          'applied_at_ms',
        ],
        'allowed/applied may have target-after and resulting facts; denied/conflict/duplicate/late cannot mutate target',
      ),
    ],
  },
  {
    name: 'workflow_runtime_command_confirmations',
    sourceSection: 'Workflow Runtime Command authorization and audit',
    columns: [
      id('id'),
      id('request_command_id'),
      id('workflow_id'),
      ext('actor_ref', 'command_actor_registry', 'command_actor'),
      ext(
        'auth_session_ref',
        'authentication_session_registry',
        'auth_session',
      ),
      integer('expected_workflow_row_version'),
      hash('request_hash'),
      ...valuePair('evidence_manifest'),
      text('status', false, ['pending', 'consumed', 'expired']),
      at('expires_at_ms'),
      at('consumed_at_ms', true),
      rowVersion(),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk(
        'fk:command_confirmations:command',
        'request_command_id',
        'workflow_runtime_commands',
        'command_id',
      ),
      fk('fk:command_confirmations:workflow', 'workflow_id', 'workflows'),
      valueFk('fk:command_confirmations:evidence', 'evidence_manifest'),
    ],
    uniqueKeys: [
      uk('uk:command_confirmations:request', ['request_command_id']),
    ],
    checks: [
      check(
        'ck:command_confirmations:status_time',
        'state_field_consistency',
        ['status', 'expires_at_ms', 'consumed_at_ms'],
        'consumed has consumed time; pending/expired do not',
      ),
      check(
        'ck:command_confirmations:ttl',
        'ordered_values',
        ['expires_at_ms'],
        'expiry equals request time plus 300000 milliseconds',
      ),
    ],
  },
  {
    name: 'workflow_checkpoints',
    sourceSection: 'Snapshot and Checkpoint',
    columns: [
      id('id'),
      id('workflow_id'),
      integer('checkpoint_version', false, 'positive'),
      integer('workflow_revision'),
      id('source_state_instance_id', true),
      id('source_run_id', true),
      id('completion_cut_id', true),
      json('snapshot_json', true),
      ...valuePair('snapshot', true),
      at('created_at_ms'),
    ],
    primaryKey: ['id'],
    foreignKeys: [
      fk('fk:checkpoints:workflow', 'workflow_id', 'workflows'),
      fk(
        'fk:checkpoints:activation',
        ['workflow_id', 'source_state_instance_id'],
        'workflow_state_activations',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:checkpoints:run',
        ['workflow_id', 'source_run_id'],
        'workflow_graph_runs',
        ['workflow_id', 'id'],
      ),
      fk(
        'fk:checkpoints:cut',
        'completion_cut_id',
        'workflow_graph_completion_cuts',
      ),
      valueFk('fk:checkpoints:snapshot', 'snapshot'),
    ],
    uniqueKeys: [
      uk('uk:checkpoints:workflow_version', [
        'workflow_id',
        'checkpoint_version',
      ]),
      uk(
        'uk:checkpoints:completion_cut',
        ['completion_cut_id'],
        'completion_cut_id is non-null',
      ),
    ],
    atMostOne: [['snapshot_json', 'snapshot_value_id']],
    indexes: [
      index(
        'idx:checkpoints:workflow_version',
        'ordering',
        ['workflow_id', 'checkpoint_version'],
        undefined,
        ['query:latest_checkpoint'],
      ),
    ],
  },
];

function query(
  queryId: string,
  owner: QueryOwner,
  purpose: string,
  table: string,
  requiredIndexId: string,
  options: {
    joinTables?: readonly string[];
    equality?: readonly string[];
    range?: readonly string[];
    predicate?: string;
    orderBy?: ReadonlyArray<readonly [string, 'asc' | 'desc']>;
    cardinality?: LogicalQueryIntent['result_cardinality'];
  } = {},
): LogicalQueryIntent {
  return {
    query_id: queryId,
    owner,
    purpose,
    table,
    join_tables: [...(options.joinTables ?? [])],
    equality_columns: [...(options.equality ?? [])],
    range_columns: [...(options.range ?? [])],
    state_predicate_intent: options.predicate ?? null,
    order_by: (options.orderBy ?? []).map(([column, direction]) => ({
      column,
      direction,
    })),
    result_cardinality: options.cardinality ?? 'bounded_batch',
    required_index_id: requiredIndexId,
    execution_status: 'intent_only',
  };
}

export const LOGICAL_QUERY_INTENTS: readonly LogicalQueryIntent[] = [
  query(
    'query:scheduler_ready_nodes',
    'scheduler',
    'durable fair admission of ready nodes',
    'workflow_graph_nodes',
    'idx:nodes:ready',
    {
      equality: ['phase'],
      predicate: "phase = 'ready'",
      orderBy: [
        ['activation_event_seq', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:workflow_deadline_due',
    'workflow_watchdog',
    'find unfinished workflows whose frozen deadline is due',
    'workflows',
    'idx:workflows:deadline',
    {
      range: ['deadline_at_ms'],
      predicate: 'finished_at_ms is null and deadline_at_ms is non-null',
      orderBy: [
        ['deadline_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:attempt_execution_deadline_due',
    'attempt_watchdog',
    'find running attempts whose execution deadline is due',
    'workflow_graph_node_attempts',
    'idx:node_attempts:execution_deadline',
    {
      range: ['execution_deadline_at_ms'],
      predicate: "phase = 'running'",
      orderBy: [
        ['execution_deadline_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:evaluation_due',
    'attempt_watchdog',
    'continue bounded evaluator work',
    'workflow_graph_node_attempts',
    'idx:node_attempts:evaluation_due',
    {
      range: ['evaluation_next_attempt_at_ms'],
      predicate: "phase = 'evaluating'",
      orderBy: [
        ['evaluation_next_attempt_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:retry_schedule_due',
    'retry_timer',
    'consume scheduled retry or quality-revision continuation',
    'workflow_graph_retry_schedules',
    'idx:retry_schedules:due',
    {
      range: ['eligible_at_ms'],
      predicate: "status = 'scheduled'",
      orderBy: [
        ['eligible_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:wait_deadline_due',
    'wait_timer',
    'resolve armed finite waits at their deadline',
    'workflow_graph_waits',
    'idx:waits:deadline',
    {
      range: ['deadline_at_ms'],
      predicate: "status = 'armed' and deadline_at_ms is non-null",
      orderBy: [
        ['deadline_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:outbox_due',
    'outbox_worker',
    'claim due delivery or reconciliation work',
    'workflow_outbox',
    'idx:outbox:due',
    {
      range: ['next_attempt_at_ms'],
      predicate: "status in ('pending','reconciling')",
      orderBy: [
        ['next_attempt_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:outbox_lease_expired',
    'recovery',
    'recover processing or reconciling outbox leases',
    'workflow_outbox',
    'idx:outbox:lease_expiry',
    {
      range: ['lease_expires_at_ms'],
      predicate: "status in ('processing','reconciling')",
      orderBy: [
        ['lease_expires_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:attempt_lease_expired',
    'recovery',
    'recover stale internal attempt worker leases',
    'workflow_graph_node_attempts',
    'idx:node_attempts:lease_expiry',
    {
      range: ['lease_expires_at_ms'],
      predicate: 'lease_owner is non-null',
      orderBy: [
        ['lease_expires_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:pending_signal_match',
    'reconciler',
    'match pre-arm signal by exact run contract and correlation',
    'workflow_graph_inbox_events',
    'idx:inbox_events:correlation',
    {
      equality: [
        'graph_run_id',
        'contract_resource_id',
        'correlation_key_hash',
        'disposition',
      ],
      predicate: "disposition = 'pending'",
      orderBy: [['inbox_seq', 'asc']],
      cardinality: 'zero_or_one',
    },
  ),
  query(
    'query:pending_signal_expiry',
    'retention_gc',
    'expire unmatched pending signals by frozen TTL',
    'workflow_graph_inbox_events',
    'idx:inbox_events:expiry',
    {
      range: ['expires_at_ms'],
      predicate: "disposition = 'pending'",
      orderBy: [
        ['expires_at_ms', 'asc'],
        ['inbox_seq', 'asc'],
      ],
    },
  ),
  query(
    'query:blob_intent_expiry',
    'blob_coordinator',
    'recover or abandon expired blob write intents',
    'workflow_blob_write_intents',
    'idx:blob_write_intents:expiry',
    {
      range: ['lease_expires_at_ms'],
      predicate: "status in ('preparing','installed')",
      orderBy: [
        ['lease_expires_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:blob_gc_candidates',
    'retention_gc',
    'scan blob GC state machine work',
    'workflow_blob_objects',
    'idx:blob_objects:gc_state',
    {
      equality: ['state'],
      range: ['gc_epoch'],
      predicate: "state in ('live','gc_candidate','deleting')",
      orderBy: [
        ['gc_epoch', 'asc'],
        ['blob_hash', 'asc'],
      ],
    },
  ),
  query(
    'query:open_operational_blockers',
    'recovery',
    'derive effective operational state from open blockers',
    'workflow_operational_blockers',
    'idx:operational_blockers:open',
    {
      equality: ['graph_run_id', 'status'],
      predicate: "status = 'open'",
      orderBy: [
        ['severity', 'desc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:operational_remediation_due',
    'operational_remediation',
    'continue only the frozen remediation lane',
    'workflow_operational_blockers',
    'idx:operational_blockers:remediation_due',
    {
      range: ['next_remediation_at_ms'],
      predicate: "status = 'open' and next_remediation_at_ms is non-null",
      orderBy: [
        ['next_remediation_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:root_finalization_due',
    'root_finalizer',
    'continue finite required-child finalization schedules',
    'workflow_root_finalization_schedules',
    'idx:root_finalization_schedules:due',
    {
      equality: ['status'],
      range: ['next_eligible_at_ms'],
      predicate: "status in ('pending','retry_wait')",
      orderBy: [
        ['next_eligible_at_ms', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:t3_affected_edges',
    'reconciler',
    'find only affected control/data edges for a scope fact',
    'workflow_graph_edges',
    'idx:edges:scope_kind',
    { equality: ['scope_id', 'edge_kind'], orderBy: [['id', 'asc']] },
  ),
  query(
    'query:t3_fact_frontier',
    'reconciler',
    'read an ordered scope fact frontier',
    'workflow_graph_facts',
    'idx:facts:scope_event',
    {
      equality: ['graph_run_id', 'scope_id'],
      range: ['event_seq'],
      orderBy: [['event_seq', 'asc']],
    },
  ),
  query(
    'query:t3_fact_queue',
    'reconciler',
    'drain deterministic causal fact queue',
    'workflow_graph_facts',
    'idx:facts:queue',
    {
      equality: ['graph_run_id'],
      orderBy: [
        ['causal_wave', 'asc'],
        ['fact_kind', 'asc'],
        ['stable_object_id', 'asc'],
      ],
    },
  ),
  query(
    'query:resume_eligibility_arbitration',
    'reconciler',
    'arbitrate persisted eligibility during resume drain',
    'workflow_graph_completion_eligibilities',
    'idx:completion_eligibilities:arbitration',
    {
      equality: ['graph_run_id'],
      orderBy: [
        ['eligibility_event_seq', 'asc'],
        ['rule_id', 'asc'],
        ['scope_id', 'asc'],
      ],
    },
  ),
  query(
    'query:subtree_scopes',
    'subtree_fencer',
    'enumerate a complete descendant scope set for one atomic fence',
    'workflow_graph_scopes',
    'idx:scopes:parent',
    {
      equality: ['graph_run_id', 'parent_scope_id'],
      orderBy: [
        ['depth', 'asc'],
        ['id', 'asc'],
      ],
    },
  ),
  query(
    'query:value_children',
    'retention_gc',
    'walk immutable Value manifest reachability',
    'workflow_value_edges',
    'idx:value_edges:parent',
    {
      equality: ['parent_value_id'],
      orderBy: [
        ['relation_kind', 'asc'],
        ['member_index', 'asc'],
        ['member_key', 'asc'],
      ],
    },
  ),
  query(
    'query:command_idempotency_lookup',
    'command_gateway',
    'resolve canonical command header by trusted domain and key',
    'workflow_runtime_commands',
    'idx:runtime_commands:idempotency',
    {
      equality: ['idempotency_domain', 'idempotency_key'],
      cardinality: 'zero_or_one',
    },
  ),
  query(
    'query:latest_checkpoint',
    'checkpoint_loader',
    'load latest workflow checkpoint watermark',
    'workflow_checkpoints',
    'idx:checkpoints:workflow_version',
    {
      equality: ['workflow_id'],
      orderBy: [['checkpoint_version', 'desc']],
      cardinality: 'zero_or_one',
    },
  ),
] as const;

const TABLE_SEEDS = [
  ...RESOURCE_AND_CLAIM_TABLES,
  ...VALUE_REGISTRY_BACKUP_TABLES,
  ...CREATION_WORKFLOW_CONTEXT_TABLES,
  ...GRAPH_EXECUTION_TABLES,
  ...GRAPH_FACT_AND_EFFECT_TABLES,
  ...OUTBOX_COMMAND_CHECKPOINT_TABLES,
] as const;

export const LOGICAL_SCHEMA_TABLES: readonly LogicalTableMetadata[] =
  TABLE_SEEDS.map((seed, indexValue) => buildTable(seed, indexValue + 1));

export function buildLogicalSchemaSourcePayload(): LogicalSchemaSourcePayload {
  return {
    schema_id: 'workflow-runtime-schema-v1',
    database_name: 'workflow-runtime.db',
    contract_stage: 'logical_metadata',
    executable_status: 'non_executable',
    ddl_generation_status: 'forbidden_in_g0_6',
    sqlite_open_status: 'forbidden_in_g0_6',
    table_count: LOGICAL_SCHEMA_TABLES.length,
    column_count: LOGICAL_SCHEMA_TABLES.reduce(
      (total, table) => total + table.columns.length,
      0,
    ),
    tables: LOGICAL_SCHEMA_TABLES.map((table) => structuredClone(table)),
    forbidden_logical_columns: [
      'control_epoch',
      'owner_kind',
      'owner_id',
      'target_kind',
      'target_id',
      'error_json',
      'error_text',
      'timestamps',
    ],
    relation_policy: {
      internal_targets: 'typed_foreign_keys_only',
      external_targets: 'explicit_external_reference_metadata',
      polymorphic_kind_id: 'forbidden',
      generic_error_fields: 'forbidden',
    },
  };
}

export function buildTypedRelationCatalogPayload(): TypedRelationCatalogPayload {
  const relations: TypedRelationRecord[] = [];
  for (const table of LOGICAL_SCHEMA_TABLES) {
    for (const relation of table.foreign_keys) {
      relations.push({
        relation_id: relation.relation_id,
        relation_kind: 'foreign_key',
        source_table: table.name,
        source_columns: [...relation.source_columns],
        target_table: relation.target_table,
        target_columns: [...relation.target_columns],
        on_delete: relation.on_delete,
        deferrability: relation.deferrability,
        validator_owner: null,
        reference_domain: null,
      });
    }
    for (const column of table.columns) {
      if (!column.external_reference) continue;
      relations.push({
        relation_id: `ext:${table.name}:${column.name}`,
        relation_kind: 'external_reference',
        source_table: table.name,
        source_columns: [column.name],
        target_table: null,
        target_columns: [],
        on_delete: null,
        deferrability: null,
        validator_owner: column.external_reference.validator_owner,
        reference_domain: column.external_reference.reference_domain,
      });
    }
  }
  relations.sort((left, right) =>
    left.relation_id < right.relation_id
      ? -1
      : left.relation_id > right.relation_id
        ? 1
        : 0,
  );
  return {
    schema_id: 'workflow-runtime-schema-v1',
    executable_status: 'non_executable',
    internal_relation_count: relations.filter(
      (relation) => relation.relation_kind === 'foreign_key',
    ).length,
    external_reference_count: relations.filter(
      (relation) => relation.relation_kind === 'external_reference',
    ).length,
    relations,
  };
}

export function buildLogicalQueryCatalogPayload(): LogicalQueryCatalogPayload {
  return {
    schema_id: 'workflow-runtime-schema-v1',
    executable_status: 'non_executable',
    sql_text_status: 'absent',
    query_count: LOGICAL_QUERY_INTENTS.length,
    queries: LOGICAL_QUERY_INTENTS.map((candidate) =>
      structuredClone(candidate),
    ),
  };
}
