import { calculateArtifactHash } from '../../contracts/hash.js';
import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalForeignKeyMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
  TypedRelationRecord,
} from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
} from '../../contracts/types.js';

export const CHILD_COMPLETION_LINEAGE_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-child-completion-lineage-schema-prerequisite@1.json';
export const CHILD_COMPLETION_LINEAGE_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-child-completion-lineage-schema-prerequisite:1\n';

const CONSUMPTION_TABLE = 'workflow_graph_child_completion_consumptions';
const SCOPE_TABLE = 'workflow_graph_scopes';
const MAP_RESULT_TABLE = 'workflow_graph_map_item_results';

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

function uk(keyId: string, columns: string[]): LogicalUniqueKeyMetadata {
  return { key_id: keyId, columns, predicate_intent: null };
}

export const CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS = [
  fk(
    'fk:child_consumptions:child_scope_lineage',
    ['graph_run_id', 'child_scope_id', 'parent_scope_id', 'owner_node_id'],
    SCOPE_TABLE,
    ['graph_run_id', 'id', 'parent_scope_id', 'owner_node_id'],
  ),
  fk(
    'fk:child_consumptions:child_cut_lineage',
    ['graph_run_id', 'child_scope_id', 'child_completion_cut_id'],
    'workflow_graph_completion_cuts',
    ['graph_run_id', 'scope_id', 'id'],
  ),
  fk(
    'fk:child_consumptions:parent_scope_lineage',
    ['graph_run_id', 'parent_scope_id'],
    SCOPE_TABLE,
    ['graph_run_id', 'id'],
  ),
  fk(
    'fk:child_consumptions:owner_node_lineage',
    ['graph_run_id', 'parent_scope_id', 'owner_node_id'],
    'workflow_graph_nodes',
    ['graph_run_id', 'scope_id', 'id'],
  ),
  fk(
    'fk:child_consumptions:map_slot_lineage',
    [
      'graph_run_id',
      'parent_scope_id',
      'owner_node_id',
      'map_slot_id',
      'child_scope_id',
      'map_slot_outcome_state',
    ],
    MAP_RESULT_TABLE,
    [
      'graph_run_id',
      'owner_scope_id',
      'owner_node_id',
      'id',
      'scope_id',
      'outcome_state',
    ],
  ),
  fk(
    'fk:child_consumptions:disposition_event_lineage',
    ['graph_run_id', 'disposition_event_seq'],
    'workflow_graph_events',
    ['graph_run_id', 'seq'],
  ),
] as const satisfies readonly LogicalForeignKeyMetadata[];

export const CHILD_COMPLETION_LINEAGE_QUERY: LogicalQueryIntent = {
  query_id: 'query:child_completion_consumption_exact_lineage',
  owner: 'recovery',
  purpose:
    'load the unique parent consumption for one exact graph run and child scope',
  table: CONSUMPTION_TABLE,
  join_tables: [],
  equality_columns: ['graph_run_id', 'child_scope_id'],
  range_columns: [],
  state_predicate_intent: null,
  order_by: [],
  result_cardinality: 'zero_or_one',
  required_index_id: 'uk:child_consumptions:run_child_scope',
  execution_status: 'intent_only',
};

export interface ChildCompletionLineageSchemaPrerequisitePayload extends JsonObject {
  format: 'icarus.workflow-child-completion-lineage-schema-prerequisite/1';
  decision_id: 'R-020';
  schema_id: 'workflow-runtime-schema-v1';
  database_schema_version: 8;
  predecessor_database_schema_version: 7;
  delta_mode: 'exact_child_scope_cut_run_lineage_rebuild';
  exact_lineage_authority: JsonObject;
  affected_tables: JsonObject[];
  typed_relations: TypedRelationRecord[] & JsonObject[];
  query_intents: LogicalQueryIntent[] & JsonObject[];
  upgrade_contract: JsonObject;
  fixture_contract: JsonObject;
  forbidden_implementation: string[];
}

function typedRelation(
  relation: LogicalForeignKeyMetadata,
): TypedRelationRecord & JsonObject {
  return {
    relation_id: relation.relation_id,
    relation_kind: 'foreign_key',
    source_table: CONSUMPTION_TABLE,
    source_columns: [...relation.source_columns],
    target_table: relation.target_table,
    target_columns: [...relation.target_columns],
    on_delete: relation.on_delete,
    deferrability: relation.deferrability,
    validator_owner: null,
    reference_domain: null,
  };
}

export function buildChildCompletionLineageSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const payload: ChildCompletionLineageSchemaPrerequisitePayload = {
    format: 'icarus.workflow-child-completion-lineage-schema-prerequisite/1',
    decision_id: 'R-020',
    schema_id: 'workflow-runtime-schema-v1',
    database_schema_version: 8,
    predecessor_database_schema_version: 7,
    delta_mode: 'exact_child_scope_cut_run_lineage_rebuild',
    exact_lineage_authority: {
      child_scope_parent_owner:
        'graph_run_id_child_scope_id_parent_scope_id_owner_node_id',
      child_cut: 'graph_run_id_child_scope_id_child_completion_cut_id',
      parent_scope: 'graph_run_id_parent_scope_id',
      owner_node: 'graph_run_id_parent_scope_id_owner_node_id',
      map_slot:
        'graph_run_id_parent_scope_id_owner_node_id_map_slot_id_child_scope_id_map_slot_outcome_state',
      disposition_event: 'graph_run_id_disposition_event_seq',
      application_boolean_or_preauthorization: 'insufficient_and_forbidden',
    },
    affected_tables: [
      {
        table: SCOPE_TABLE,
        operation: 'add_candidate_key',
        key_id: 'uk:scopes:run_id_parent_owner',
        columns: ['graph_run_id', 'id', 'parent_scope_id', 'owner_node_id'],
      },
      {
        table: MAP_RESULT_TABLE,
        operation: 'add_candidate_keys',
        keys: [
          {
            key_id: 'uk:map_item_results:consumption_lineage',
            columns: [
              'graph_run_id',
              'owner_scope_id',
              'owner_node_id',
              'id',
              'scope_id',
              'outcome_state',
            ],
          },
          {
            key_id: 'uk:map_item_results:child_scope',
            columns: [
              'graph_run_id',
              'owner_scope_id',
              'owner_node_id',
              'scope_id',
            ],
          },
        ],
      },
      {
        table: CONSUMPTION_TABLE,
        operation: 'rebuild_exact_lineage',
        added_columns: ['graph_run_id', 'map_slot_outcome_state'],
        replaced_foreign_key_count: 5,
        resulting_foreign_key_count:
          CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS.length,
        preserved_unique_key: 'uk:child_consumptions:child_scope',
        added_unique_key: 'uk:child_consumptions:run_child_scope',
        map_terminal_states: ['completed', 'fenced'],
      },
    ],
    typed_relations: CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS.map(typedRelation),
    query_intents: [
      CHILD_COMPLETION_LINEAGE_QUERY as LogicalQueryIntent & JsonObject,
    ],
    upgrade_contract: {
      source_version: 7,
      target_version: 8,
      graph_run_derivation:
        'exact workflow_graph_scopes graph_run_id for child_scope_id',
      map_slot_outcome_derivation:
        'map_slot_completed_to_completed_map_slot_fenced_to_fenced_else_null',
      transaction:
        'single_begin_immediate_copy_validate_commit_or_full_rollback',
      cross_lineage_schema7_history: 'upgrade_fails_closed',
      historical_schema_5_6_7_and_upgrades: 'byte_immutable',
    },
    fixture_contract: {
      positive: ['same_lineage_consumption', 'reopen_and_exact_replay'],
      negative: [
        'cross_scope_child_and_cut',
        'same_scope_id_different_run',
        'same_run_different_scope',
        'wrong_parent_scope',
        'wrong_owner_node',
        'wrong_map_slot',
        'wrong_map_slot_child_scope',
        'wrong_map_slot_terminal_outcome',
        'cross_run_disposition_event',
        'duplicate_child_consumption',
      ],
      upgrade: [
        'valid_nonempty_schema7_to_schema8',
        'cross_lineage_schema7_upgrade_rollback_byte_exact',
      ],
      execution_target: 'real_file_sqlite',
    },
    forbidden_implementation: [
      'g6_dynamic_close_business_transactions',
      'child_creation_or_finalization',
      'subgraph_expand_map_materialization',
      'controller_quorum_or_fail_fast',
      'compensation_or_root_finalization',
      'g7_or_later_runtime_surface',
    ],
  };
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-child-completion-lineage-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-child-completion-lineage-schema-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: CHILD_COMPLETION_LINEAGE_SCHEMA_INPUT_DOMAIN,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function columnWithRelations(
  column: LogicalColumnMetadata,
  relations: readonly LogicalForeignKeyMetadata[],
): LogicalColumnMetadata {
  return {
    ...structuredClone(column),
    relation_ids: relations
      .filter((relation) => relation.source_columns.includes(column.name))
      .map((relation) => relation.relation_id),
  };
}

function addUniqueKey(
  table: LogicalTableMetadata,
  key: LogicalUniqueKeyMetadata,
): LogicalTableMetadata {
  const result = structuredClone(table);
  if (result.unique_keys.some((candidate) => candidate.key_id === key.key_id)) {
    throw new Error(`Schema 7 already contains ${key.key_id}`);
  }
  result.unique_keys.push(key);
  return result;
}

function rebuildConsumption(
  table: LogicalTableMetadata,
  scope: LogicalTableMetadata,
  mapResult: LogicalTableMetadata,
): LogicalTableMetadata {
  const result = structuredClone(table);
  const expectedColumns = [
    'id',
    'child_scope_id',
    'child_completion_cut_id',
    'parent_scope_id',
    'owner_node_id',
    'map_slot_id',
    'disposition',
    'parent_work_fence_epoch',
    'disposition_event_seq',
    'created_at_ms',
  ];
  if (
    result.columns.map((column) => column.name).join('\0') !==
      expectedColumns.join('\0') ||
    result.foreign_keys.length !== 5
  ) {
    throw new Error('Schema 7 child completion consumption shape drifted');
  }
  const graphRun = scope.columns.find(
    (column) => column.name === 'graph_run_id',
  );
  const outcome = mapResult.columns.find(
    (column) => column.name === 'outcome_state',
  );
  if (!graphRun || !outcome) {
    throw new Error('Schema 7 lineage source columns are absent');
  }
  const graphRunColumn: LogicalColumnMetadata = {
    ...structuredClone(graphRun),
    ordinal: 0,
    relation_ids: [],
  };
  const outcomeColumn: LogicalColumnMetadata = {
    ...structuredClone(outcome),
    ordinal: 0,
    name: 'map_slot_outcome_state',
    nullable: true,
    enum_values: ['completed', 'fenced'],
    relation_ids: [],
  };
  const byName = new Map(result.columns.map((column) => [column.name, column]));
  const ordered = [
    byName.get('id')!,
    graphRunColumn,
    byName.get('child_scope_id')!,
    byName.get('child_completion_cut_id')!,
    byName.get('parent_scope_id')!,
    byName.get('owner_node_id')!,
    byName.get('map_slot_id')!,
    outcomeColumn,
    byName.get('disposition')!,
    byName.get('parent_work_fence_epoch')!,
    byName.get('disposition_event_seq')!,
    byName.get('created_at_ms')!,
  ];
  const relations = CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS.map((relation) => ({
    ...relation,
    source_columns: [...relation.source_columns],
    target_columns: [...relation.target_columns],
  }));
  result.columns = ordered.map((column, index) => ({
    ...columnWithRelations(column, relations),
    ordinal: index + 1,
  }));
  result.foreign_keys = relations;
  result.unique_keys = [
    ...result.unique_keys,
    uk('uk:child_consumptions:run_child_scope', [
      'graph_run_id',
      'child_scope_id',
    ]),
  ];
  result.checks = result.checks.filter(
    (check) => check.check_id !== 'ck:child_consumptions:map_disposition',
  );
  result.checks.push({
    check_id:
      'ck:workflow_graph_child_completion_consumptions:map_slot_outcome_state:enum',
    kind: 'enum_membership',
    columns: ['map_slot_outcome_state'],
    expression_intent:
      'value belongs to the closed map_slot_outcome_state catalog',
  });
  const mapOutcomeCheck: LogicalCheckMetadata = {
    check_id: 'ck:child_consumptions:map_disposition_lineage',
    kind: 'state_field_consistency',
    columns: ['disposition', 'map_slot_id', 'map_slot_outcome_state'],
    expression_intent:
      'map disposition has exact terminal map slot outcome and non-map disposition has neither',
  };
  result.checks.push(mapOutcomeCheck);
  return result;
}

export function applyChildCompletionLineageSchemaPrerequisite(
  schema7Tables: LogicalTableMetadata[],
  schema7Queries: LogicalQueryIntent[],
  artifact: ContractArtifactEnvelope,
): { tables: LogicalTableMetadata[]; queries: LogicalQueryIntent[] } {
  const expected = buildChildCompletionLineageSchemaPrerequisiteArtifact();
  if (artifact.format !== expected.format || artifact.hash !== expected.hash) {
    throw new Error('R-020 child completion lineage prerequisite drifted');
  }
  const scope = schema7Tables.find((table) => table.name === SCOPE_TABLE);
  const mapResult = schema7Tables.find(
    (table) => table.name === MAP_RESULT_TABLE,
  );
  const consumption = schema7Tables.find(
    (table) => table.name === CONSUMPTION_TABLE,
  );
  if (!scope || !mapResult || !consumption) {
    throw new Error('R-020 Schema 7 target table is absent');
  }
  const scope8 = addUniqueKey(
    scope,
    uk('uk:scopes:run_id_parent_owner', [
      'graph_run_id',
      'id',
      'parent_scope_id',
      'owner_node_id',
    ]),
  );
  let mapResult8 = addUniqueKey(
    mapResult,
    uk('uk:map_item_results:consumption_lineage', [
      'graph_run_id',
      'owner_scope_id',
      'owner_node_id',
      'id',
      'scope_id',
      'outcome_state',
    ]),
  );
  mapResult8 = addUniqueKey(
    mapResult8,
    uk('uk:map_item_results:child_scope', [
      'graph_run_id',
      'owner_scope_id',
      'owner_node_id',
      'scope_id',
    ]),
  );
  const consumption8 = rebuildConsumption(consumption, scope, mapResult);
  const replacements = new Map([
    [SCOPE_TABLE, scope8],
    [MAP_RESULT_TABLE, mapResult8],
    [CONSUMPTION_TABLE, consumption8],
  ]);
  const tables = schema7Tables.map((table) =>
    structuredClone(replacements.get(table.name) ?? table),
  );
  if (
    schema7Queries.some(
      (query) => query.query_id === CHILD_COMPLETION_LINEAGE_QUERY.query_id,
    )
  ) {
    throw new Error('Schema 7 already contains the R-020 query intent');
  }
  return {
    tables,
    queries: [
      ...schema7Queries,
      structuredClone(CHILD_COMPLETION_LINEAGE_QUERY),
    ],
  };
}
