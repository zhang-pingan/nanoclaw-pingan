import type { JsonValue } from './types.js';

export const LOGICAL_COLUMN_TYPES = [
  'identifier',
  'text',
  'hash',
  'canonical_json',
  'integer',
  'boolean_integer',
  'external_reference',
] as const;

export type LogicalColumnType = (typeof LOGICAL_COLUMN_TYPES)[number];

export const SQLITE_TYPE_INTENTS = ['TEXT', 'INTEGER'] as const;
export type SqliteTypeIntent = (typeof SQLITE_TYPE_INTENTS)[number];

export const SAFE_INTEGER_INTENTS = [
  'not_applicable',
  'non_negative',
  'positive',
] as const;
export type SafeIntegerIntent = (typeof SAFE_INTEGER_INTENTS)[number];

export const FOREIGN_KEY_ACTIONS = ['restrict', 'cascade', 'set_null'] as const;
export type ForeignKeyAction = (typeof FOREIGN_KEY_ACTIONS)[number];

export const FOREIGN_KEY_DEFERRABILITY = [
  'not_deferrable',
  'deferred',
] as const;
export type ForeignKeyDeferrability =
  (typeof FOREIGN_KEY_DEFERRABILITY)[number];

export const LOGICAL_CHECK_KINDS = [
  'enum_membership',
  'hash_format',
  'safe_integer',
  'boolean_integer',
  'exactly_one',
  'at_most_one',
  'all_or_none',
  'state_field_consistency',
  'ordered_values',
  'cross_column_equality',
  'closed_target_mapping',
  'lineage_consistency',
] as const;
export type LogicalCheckKind = (typeof LOGICAL_CHECK_KINDS)[number];

export const INDEX_INTENT_KINDS = [
  'lookup',
  'scan',
  'ordering',
  'watchdog',
  'recovery',
  'gc_retention',
] as const;
export type IndexIntentKind = (typeof INDEX_INTENT_KINDS)[number];

export const QUERY_OWNERS = [
  'scheduler',
  'workflow_watchdog',
  'attempt_watchdog',
  'retry_timer',
  'wait_timer',
  'outbox_worker',
  'recovery',
  'operational_remediation',
  'root_finalizer',
  'reconciler',
  'subtree_fencer',
  'blob_coordinator',
  'retention_gc',
  'command_gateway',
  'checkpoint_loader',
] as const;
export type QueryOwner = (typeof QUERY_OWNERS)[number];

export interface ExternalReferenceMetadata {
  validator_owner: string;
  reference_domain: string;
  immutable: boolean;
}

export interface LogicalColumnMetadata {
  ordinal: number;
  name: string;
  logical_type: LogicalColumnType;
  sqlite_type_intent: SqliteTypeIntent;
  nullable: boolean;
  default_intent: JsonValue;
  safe_integer_intent: SafeIntegerIntent;
  enum_values: string[];
  relation_ids: string[];
  external_reference: ExternalReferenceMetadata | null;
}

export interface LogicalPrimaryKeyMetadata {
  columns: string[];
  auto_increment_intent: boolean;
}

export interface LogicalForeignKeyMetadata {
  relation_id: string;
  source_columns: string[];
  target_table: string;
  target_columns: string[];
  on_delete: ForeignKeyAction;
  deferrability: ForeignKeyDeferrability;
}

export interface LogicalUniqueKeyMetadata {
  key_id: string;
  columns: string[];
  predicate_intent: string | null;
}

export interface LogicalCheckMetadata {
  check_id: string;
  kind: LogicalCheckKind;
  columns: string[];
  expression_intent: string;
}

export interface LogicalIndexMetadata {
  index_id: string;
  kind: IndexIntentKind;
  columns: string[];
  predicate_intent: string | null;
  supports_query_ids: string[];
}

export interface LogicalTableMetadata {
  ordinal: number;
  name: string;
  source_section: string;
  columns: LogicalColumnMetadata[];
  primary_key: LogicalPrimaryKeyMetadata;
  foreign_keys: LogicalForeignKeyMetadata[];
  unique_keys: LogicalUniqueKeyMetadata[];
  checks: LogicalCheckMetadata[];
  indexes: LogicalIndexMetadata[];
}

export interface LogicalSchemaSourcePayload {
  schema_id: 'workflow-runtime-schema-v1';
  database_name: 'workflow-runtime.db';
  contract_stage: 'logical_metadata';
  executable_status: 'non_executable';
  ddl_generation_status: 'forbidden_in_g0_6';
  sqlite_open_status: 'forbidden_in_g0_6';
  table_count: number;
  column_count: number;
  tables: LogicalTableMetadata[];
  forbidden_logical_columns: string[];
  relation_policy: LogicalRelationPolicyMetadata;
}

export interface LogicalRelationPolicyMetadata {
  internal_targets: 'typed_foreign_keys_only';
  external_targets: 'explicit_external_reference_metadata';
  polymorphic_kind_id: 'forbidden';
  generic_error_fields: 'forbidden';
}

export interface TypedRelationRecord {
  relation_id: string;
  relation_kind: 'foreign_key' | 'external_reference';
  source_table: string;
  source_columns: string[];
  target_table: string | null;
  target_columns: string[];
  on_delete: ForeignKeyAction | null;
  deferrability: ForeignKeyDeferrability | null;
  validator_owner: string | null;
  reference_domain: string | null;
}

export interface TypedRelationCatalogPayload {
  schema_id: 'workflow-runtime-schema-v1';
  executable_status: 'non_executable';
  internal_relation_count: number;
  external_reference_count: number;
  relations: TypedRelationRecord[];
}

export interface LogicalQueryIntent {
  query_id: string;
  owner: QueryOwner;
  purpose: string;
  table: string;
  join_tables: string[];
  equality_columns: string[];
  range_columns: string[];
  state_predicate_intent: string | null;
  order_by: LogicalQueryOrder[];
  result_cardinality: 'zero_or_one' | 'many' | 'bounded_batch';
  required_index_id: string;
  execution_status: 'intent_only';
}

export interface LogicalQueryOrder {
  column: string;
  direction: 'asc' | 'desc';
}

export interface LogicalQueryCatalogPayload {
  schema_id: 'workflow-runtime-schema-v1';
  executable_status: 'non_executable';
  sql_text_status: 'absent';
  query_count: number;
  queries: LogicalQueryIntent[];
}

export const LOGICAL_SCHEMA_SOURCE_KEYS = [
  'schema_id',
  'database_name',
  'contract_stage',
  'executable_status',
  'ddl_generation_status',
  'sqlite_open_status',
  'table_count',
  'column_count',
  'tables',
  'forbidden_logical_columns',
  'relation_policy',
] as const satisfies readonly (keyof LogicalSchemaSourcePayload)[];

export const LOGICAL_TABLE_KEYS = [
  'ordinal',
  'name',
  'source_section',
  'columns',
  'primary_key',
  'foreign_keys',
  'unique_keys',
  'checks',
  'indexes',
] as const satisfies readonly (keyof LogicalTableMetadata)[];

export const LOGICAL_RELATION_POLICY_KEYS = [
  'internal_targets',
  'external_targets',
  'polymorphic_kind_id',
  'generic_error_fields',
] as const satisfies readonly (keyof LogicalRelationPolicyMetadata)[];

export const LOGICAL_COLUMN_KEYS = [
  'ordinal',
  'name',
  'logical_type',
  'sqlite_type_intent',
  'nullable',
  'default_intent',
  'safe_integer_intent',
  'enum_values',
  'relation_ids',
  'external_reference',
] as const satisfies readonly (keyof LogicalColumnMetadata)[];

export const EXTERNAL_REFERENCE_KEYS = [
  'validator_owner',
  'reference_domain',
  'immutable',
] as const satisfies readonly (keyof ExternalReferenceMetadata)[];

export const LOGICAL_PRIMARY_KEY_KEYS = [
  'columns',
  'auto_increment_intent',
] as const satisfies readonly (keyof LogicalPrimaryKeyMetadata)[];

export const LOGICAL_FOREIGN_KEY_KEYS = [
  'relation_id',
  'source_columns',
  'target_table',
  'target_columns',
  'on_delete',
  'deferrability',
] as const satisfies readonly (keyof LogicalForeignKeyMetadata)[];

export const LOGICAL_UNIQUE_KEY_KEYS = [
  'key_id',
  'columns',
  'predicate_intent',
] as const satisfies readonly (keyof LogicalUniqueKeyMetadata)[];

export const LOGICAL_CHECK_KEYS = [
  'check_id',
  'kind',
  'columns',
  'expression_intent',
] as const satisfies readonly (keyof LogicalCheckMetadata)[];

export const LOGICAL_INDEX_KEYS = [
  'index_id',
  'kind',
  'columns',
  'predicate_intent',
  'supports_query_ids',
] as const satisfies readonly (keyof LogicalIndexMetadata)[];

export const TYPED_RELATION_KEYS = [
  'relation_id',
  'relation_kind',
  'source_table',
  'source_columns',
  'target_table',
  'target_columns',
  'on_delete',
  'deferrability',
  'validator_owner',
  'reference_domain',
] as const satisfies readonly (keyof TypedRelationRecord)[];

export const TYPED_RELATION_CATALOG_KEYS = [
  'schema_id',
  'executable_status',
  'internal_relation_count',
  'external_reference_count',
  'relations',
] as const satisfies readonly (keyof TypedRelationCatalogPayload)[];

export const LOGICAL_QUERY_KEYS = [
  'query_id',
  'owner',
  'purpose',
  'table',
  'join_tables',
  'equality_columns',
  'range_columns',
  'state_predicate_intent',
  'order_by',
  'result_cardinality',
  'required_index_id',
  'execution_status',
] as const satisfies readonly (keyof LogicalQueryIntent)[];

export const LOGICAL_QUERY_ORDER_KEYS = [
  'column',
  'direction',
] as const satisfies readonly (keyof LogicalQueryOrder)[];

export const LOGICAL_QUERY_CATALOG_KEYS = [
  'schema_id',
  'executable_status',
  'sql_text_status',
  'query_count',
  'queries',
] as const satisfies readonly (keyof LogicalQueryCatalogPayload)[];
