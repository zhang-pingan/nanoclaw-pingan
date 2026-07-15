import {
  buildLogicalQueryCatalogPayload,
  buildLogicalSchemaSourcePayload,
  buildTypedRelationCatalogPayload,
} from './logical-schema-source.js';
import type { JsonValue } from './types.js';

export type LogicalSchemaFixtureTarget =
  | 'icarus.workflow-runtime-logical-schema-source/1'
  | 'icarus.workflow-runtime-typed-relation-catalog/1'
  | 'icarus.workflow-runtime-query-catalog/1';

export interface LogicalSchemaPositiveCase {
  case_id: string;
  target_format: LogicalSchemaFixtureTarget;
  assertion:
    | 'all_normative_tables_and_columns'
    | 'complete_constraint_intent'
    | 'typed_internal_relations'
    | 'explicit_external_references'
    | 'query_index_coverage'
    | 'metadata_only_boundary';
}

export type LogicalSchemaMutation =
  | { operation: 'add'; pointer: string; value: JsonValue }
  | { operation: 'remove'; pointer: string }
  | { operation: 'replace'; pointer: string; value: JsonValue };

export interface LogicalSchemaNegativeCase {
  case_id: string;
  target_format: LogicalSchemaFixtureTarget;
  mutation: LogicalSchemaMutation;
  expected_stage: 'schema' | 'semantic';
  expected_keyword: string | null;
  expected_instance_pointer: string | null;
  expected_code: 'logical_schema_contract_drift';
}

export const LOGICAL_SCHEMA_POSITIVE_CASES = [
  {
    case_id: 'all_normative_tables_and_columns',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    assertion: 'all_normative_tables_and_columns',
  },
  {
    case_id: 'complete_check_key_fk_index_intent',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    assertion: 'complete_constraint_intent',
  },
  {
    case_id: 'typed_internal_relations',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    assertion: 'typed_internal_relations',
  },
  {
    case_id: 'explicit_external_references',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    assertion: 'explicit_external_references',
  },
  {
    case_id: 'query_index_coverage',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
    assertion: 'query_index_coverage',
  },
  {
    case_id: 'metadata_only_boundary',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
    assertion: 'metadata_only_boundary',
  },
] as const satisfies readonly LogicalSchemaPositiveCase[];

const source = buildLogicalSchemaSourcePayload();
const relations = buildTypedRelationCatalogPayload();
const queries = buildLogicalQueryCatalogPayload();
const scopeIndex = source.tables.findIndex(
  (table) => table.name === 'workflow_graph_scopes',
);
const valueOwnershipIndex = source.tables.findIndex(
  (table) => table.name === 'workflow_value_ownerships',
);
const workflowsIndex = source.tables.findIndex(
  (table) => table.name === 'workflows',
);
const scopeTable = source.tables[scopeIndex]!;
const scopeIdIndex = scopeTable.columns.findIndex(
  (column) => column.name === 'id',
);
const scopePlanFkIndex = scopeTable.foreign_keys.findIndex(
  (relation) => relation.relation_id === 'fk:scopes:plan',
);
const scopeUniqueIndex = scopeTable.unique_keys.findIndex(
  (key) => key.key_id === 'uk:scopes:root',
);
const scopeCheckIndex = scopeTable.checks.findIndex(
  (candidate) => candidate.check_id === 'ck:scopes:nullable_plan',
);
const scopeIndexIndex = scopeTable.indexes.findIndex(
  (candidate) => candidate.index_id === 'idx:scopes:parent',
);
const workflowCreatedIndex = source.tables[workflowsIndex]!.columns.findIndex(
  (column) => column.name === 'created_at_ms',
);
const externalRelationIndex = relations.relations.findIndex(
  (relation) => relation.relation_kind === 'external_reference',
);
const internalRelationIndex = relations.relations.findIndex(
  (relation) => relation.relation_kind === 'foreign_key',
);
const queryIndex = queries.queries.findIndex(
  (candidate) => candidate.query_id === 'query:wait_deadline_due',
);

if (
  [
    scopeIndex,
    valueOwnershipIndex,
    workflowsIndex,
    scopeIdIndex,
    scopePlanFkIndex,
    scopeUniqueIndex,
    scopeCheckIndex,
    scopeIndexIndex,
    workflowCreatedIndex,
    externalRelationIndex,
    internalRelationIndex,
    queryIndex,
  ].some((indexValue) => indexValue < 0)
) {
  throw new Error('G0.6 fixture anchors are missing');
}

export const LOGICAL_SCHEMA_NEGATIVE_CASES = [
  {
    case_id: 'source_rejects_unknown_top_level_field',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'add',
      pointer: '/sql',
      value: 'executable_statement_forbidden',
    },
    expected_stage: 'schema',
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '',
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_missing_table_count',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: { operation: 'remove', pointer: '/table_count' },
    expected_stage: 'schema',
    expected_keyword: 'required',
    expected_instance_pointer: '',
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_table_field',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'add',
      pointer: `/tables/${scopeIndex}/create_sql`,
      value: 'forbidden',
    },
    expected_stage: 'schema',
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: `/tables/${scopeIndex}`,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_column_type',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/columns/${scopeIdIndex}/logical_type`,
      value: 'blob',
    },
    expected_stage: 'schema',
    expected_keyword: 'enum',
    expected_instance_pointer: `/tables/${scopeIndex}/columns/${scopeIdIndex}/logical_type`,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'query_rejects_embedded_sql_text',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
    mutation: {
      operation: 'add',
      pointer: `/queries/${queryIndex}/sql_text`,
      value: 'SELECT 1',
    },
    expected_stage: 'schema',
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: `/queries/${queryIndex}`,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'relation_rejects_unknown_relation_kind',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: `/relations/${internalRelationIndex}/relation_kind`,
      value: 'polymorphic',
    },
    expected_stage: 'schema',
    expected_keyword: 'enum',
    expected_instance_pointer: `/relations/${internalRelationIndex}/relation_kind`,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_table_count_drift',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: { operation: 'replace', pointer: '/table_count', value: 73 },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_column_count_drift',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: { operation: 'replace', pointer: '/column_count', value: 1 },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_missing_normative_table',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: { operation: 'remove', pointer: `/tables/${scopeIndex}` },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_duplicate_table_name',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${valueOwnershipIndex}/name`,
      value: 'workflow_graph_scopes',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_duplicate_column_name',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/columns/1/name`,
      value: 'id',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_column_ordinal_drift',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/columns/${scopeIdIndex}/ordinal`,
      value: 2,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_nullable_primary_key',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/columns/${scopeIdIndex}/nullable`,
      value: true,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_primary_key_column',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/primary_key/columns/0`,
      value: 'missing_id',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_fk_source_column',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/foreign_keys/${scopePlanFkIndex}/source_columns/0`,
      value: 'missing_plan_id',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_fk_target_table',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/foreign_keys/${scopePlanFkIndex}/target_table`,
      value: 'workflow_missing_table',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_fk_target_column',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/foreign_keys/${scopePlanFkIndex}/target_columns/0`,
      value: 'missing_plan_id',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_unique_column',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/unique_keys/${scopeUniqueIndex}/columns/0`,
      value: 'missing_run_id',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_check_column',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/checks/${scopeCheckIndex}/columns/0`,
      value: 'missing_scope_kind',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unknown_index_column',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/indexes/${scopeIndexIndex}/columns/0`,
      value: 'missing_graph_run_id',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_polymorphic_owner_kind',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${valueOwnershipIndex}/columns/1/name`,
      value: 'owner_kind',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_control_epoch',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/columns/1/name`,
      value: 'control_epoch',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_generic_error_json',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${scopeIndex}/columns/1/name`,
      value: 'error_json',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_unqualified_absolute_time',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${workflowsIndex}/columns/${workflowCreatedIndex}/name`,
      value: 'created_at',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_missing_external_metadata',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: `/tables/${valueOwnershipIndex}/columns/5/external_reference`,
      value: null,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'relation_rejects_count_drift',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/internal_relation_count',
      value: 0,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'relation_rejects_missing_relation',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    mutation: {
      operation: 'remove',
      pointer: `/relations/${internalRelationIndex}`,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'relation_rejects_target_drift',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: `/relations/${internalRelationIndex}/target_table`,
      value: 'workflow_values',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'relation_rejects_external_validator_loss',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: `/relations/${externalRelationIndex}/validator_owner`,
      value: null,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'query_rejects_count_drift',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
    mutation: { operation: 'replace', pointer: '/query_count', value: 1 },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'query_rejects_unknown_table',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: `/queries/${queryIndex}/table`,
      value: 'workflow_missing_table',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'query_rejects_unknown_column',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: `/queries/${queryIndex}/range_columns/0`,
      value: 'missing_deadline_at_ms',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'query_rejects_unknown_index',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: `/queries/${queryIndex}/required_index_id`,
      value: 'idx:missing',
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'logical_schema_contract_drift',
  },
  {
    case_id: 'source_rejects_executable_status_spoof',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
    mutation: {
      operation: 'replace',
      pointer: '/executable_status',
      value: 'executable',
    },
    expected_stage: 'schema',
    expected_keyword: 'const',
    expected_instance_pointer: '/executable_status',
    expected_code: 'logical_schema_contract_drift',
  },
] as const satisfies readonly LogicalSchemaNegativeCase[];
