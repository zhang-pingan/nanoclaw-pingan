import { calculateArtifactHash } from '../../contracts/hash.js';
import type {
  LogicalCheckMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  TypedRelationRecord,
} from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
} from '../../contracts/types.js';
import {
  CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS,
  CHILD_COMPLETION_LINEAGE_QUERY,
} from './child-completion-lineage-source.js';

export const MAP_TERMINAL_CONSUMPTION_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-map-terminal-consumption-schema-prerequisite@1.json';
export const MAP_TERMINAL_CONSUMPTION_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-map-terminal-consumption-schema-prerequisite:1\n';

const CONSUMPTION_TABLE = 'workflow_graph_child_completion_consumptions';

export const MAP_TERMINAL_DISPOSITIONS = [
  'map_slot_completed',
  'map_slot_errored',
  'map_slot_cancelled',
  'map_slot_fenced',
] as const;

export const MAP_TERMINAL_OUTCOMES = [
  'completed',
  'errored',
  'cancelled',
  'fenced',
] as const;

export const NON_MAP_CHILD_CONSUMPTION_DISPOSITIONS = [
  'owner_output_published',
  'non_publish_parent_fenced',
  'non_publish_owner_fenced',
] as const;

const CURRENT_DISPOSITIONS = [
  'owner_output_published',
  ...MAP_TERMINAL_DISPOSITIONS,
  'non_publish_parent_fenced',
  'non_publish_owner_fenced',
] as const;

function typedRelation(
  relation: (typeof CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS)[number],
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

export function buildMapTerminalConsumptionSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const payload: JsonObject = {
    format: 'icarus.workflow-map-terminal-consumption-schema-prerequisite/1',
    decision_id: 'R-021',
    schema_id: 'workflow-runtime-schema-v1',
    database_schema_version: 9,
    predecessor_database_schema_version: 8,
    delta_mode: 'closed_map_terminal_consumption_catalog_rebuild',
    terminal_tuple_catalog: {
      map_dispositions: [...MAP_TERMINAL_DISPOSITIONS],
      map_outcomes: [...MAP_TERMINAL_OUTCOMES],
      exact_pairs: MAP_TERMINAL_DISPOSITIONS.map((disposition, index) => ({
        disposition,
        outcome: MAP_TERMINAL_OUTCOMES[index],
        map_slot_required: true,
      })),
      non_map_dispositions: [...NON_MAP_CHILD_CONSUMPTION_DISPOSITIONS],
      non_map_slot_and_outcome: 'both_null',
    },
    affected_tables: [
      {
        table: CONSUMPTION_TABLE,
        operation: 'rebuild_closed_terminal_catalog',
        added_columns: [],
        added_candidate_keys: [],
        preserved_foreign_key_count:
          CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS.length,
        disposition_catalog: [...CURRENT_DISPOSITIONS],
        map_terminal_outcome_catalog: [...MAP_TERMINAL_OUTCOMES],
        preserved_unique_keys: [
          'uk:child_consumptions:child_scope',
          'uk:child_consumptions:run_child_scope',
        ],
      },
    ],
    typed_relations: CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS.map(typedRelation),
    query_intents: [
      structuredClone(CHILD_COMPLETION_LINEAGE_QUERY) as LogicalQueryIntent &
        JsonObject,
    ],
    upgrade_contract: {
      source_version: 8,
      target_version: 9,
      row_mapping: 'all_columns_byte_preserving_no_semantic_rewrite',
      transaction:
        'single_begin_immediate_copy_validate_commit_or_full_rollback',
      valid_nonempty_schema8_history: 'preserved_row_for_row',
      invalid_schema8_history: 'upgrade_fails_closed',
      historical_schema_8_and_earlier_artifacts_ddl_upgrades: 'byte_immutable',
    },
    fixture_contract: {
      positive_map_terminals: [...MAP_TERMINAL_OUTCOMES],
      positive_non_map: [...NON_MAP_CHILD_CONSUMPTION_DISPOSITIONS],
      replay: ['commit_reopen_exact_replay'],
      negative: [
        'wrong_disposition_outcome',
        'missing_map_slot',
        'missing_map_outcome',
        'non_map_carries_slot_or_outcome',
        'cross_run',
        'cross_scope',
        'wrong_child_cut',
        'wrong_parent',
        'wrong_owner',
        'wrong_map_slot',
        'wrong_event',
        'duplicate_consumption',
        'tamper',
        'identity_drift',
      ],
      upgrade: [
        'valid_nonempty_schema8_to_schema9_row_preserving',
        'invalid_history_rollback_exact_schema8',
        'copy_fault_rollback_exact_schema8',
      ],
      historical_blocker: 'schema8_errored_cancelled_remains_reproduced',
      execution_target: 'real_file_sqlite',
    },
    forbidden_implementation: [
      'g6_dynamic_close_business_transactions',
      'child_creation_or_finalization',
      'subgraph_expand_map_materialization',
      'controller_quorum_or_fail_fast',
      'compensation_or_root_finalization',
      'g7_or_later_runtime_surface',
      'certification_or_production_activation',
    ],
  };
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-map-terminal-consumption-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-map-terminal-consumption-schema-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: MAP_TERMINAL_CONSUMPTION_SCHEMA_INPUT_DOMAIN,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function rebuildConsumption(table: LogicalTableMetadata): LogicalTableMetadata {
  const result = structuredClone(table);
  const expectedColumns = [
    'id',
    'graph_run_id',
    'child_scope_id',
    'child_completion_cut_id',
    'parent_scope_id',
    'owner_node_id',
    'map_slot_id',
    'map_slot_outcome_state',
    'disposition',
    'parent_work_fence_epoch',
    'disposition_event_seq',
    'created_at_ms',
  ];
  if (
    result.columns.map((column) => column.name).join('\0') !==
      expectedColumns.join('\0') ||
    result.foreign_keys.length !==
      CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS.length ||
    result.foreign_keys.some(
      (relation, index) =>
        JSON.stringify(relation) !==
        JSON.stringify(CHILD_COMPLETION_LINEAGE_FOREIGN_KEYS[index]),
    )
  ) {
    throw new Error('Schema 8 child consumption lineage shape drifted');
  }
  const disposition = result.columns.find(
    (column) => column.name === 'disposition',
  );
  const outcome = result.columns.find(
    (column) => column.name === 'map_slot_outcome_state',
  );
  if (!disposition || !outcome) {
    throw new Error('Schema 8 terminal consumption catalog is absent');
  }
  if (
    disposition.enum_values.join('\0') !==
      [
        'owner_output_published',
        'map_slot_completed',
        'map_slot_fenced',
        'non_publish_parent_fenced',
        'non_publish_owner_fenced',
      ].join('\0') ||
    outcome.enum_values.join('\0') !== ['completed', 'fenced'].join('\0')
  ) {
    throw new Error('Schema 8 terminal consumption catalog drifted');
  }
  disposition.enum_values = [...CURRENT_DISPOSITIONS];
  outcome.enum_values = [...MAP_TERMINAL_OUTCOMES];
  const priorCheckIndex = result.checks.findIndex(
    (check) =>
      check.check_id === 'ck:child_consumptions:map_disposition_lineage',
  );
  if (priorCheckIndex < 0) {
    throw new Error('Schema 8 map disposition lineage CHECK is absent');
  }
  const currentCheck: LogicalCheckMetadata = {
    check_id: 'ck:child_consumptions:terminal_disposition_lineage',
    kind: 'state_field_consistency',
    columns: ['disposition', 'map_slot_id', 'map_slot_outcome_state'],
    expression_intent:
      'map terminal disposition has its exact terminal slot outcome and non-map disposition has neither',
  };
  result.checks.splice(priorCheckIndex, 1, currentCheck);
  return result;
}

export function applyMapTerminalConsumptionSchemaPrerequisite(
  schema8Tables: LogicalTableMetadata[],
  schema8Queries: LogicalQueryIntent[],
  artifact: ContractArtifactEnvelope,
): { tables: LogicalTableMetadata[]; queries: LogicalQueryIntent[] } {
  const expected = buildMapTerminalConsumptionSchemaPrerequisiteArtifact();
  if (artifact.format !== expected.format || artifact.hash !== expected.hash) {
    throw new Error('R-021 map terminal consumption prerequisite drifted');
  }
  const consumption = schema8Tables.find(
    (table) => table.name === CONSUMPTION_TABLE,
  );
  if (!consumption) throw new Error('R-021 Schema 8 target table is absent');
  const query = schema8Queries.find(
    (candidate) =>
      candidate.query_id === CHILD_COMPLETION_LINEAGE_QUERY.query_id,
  );
  if (
    JSON.stringify(query) !== JSON.stringify(CHILD_COMPLETION_LINEAGE_QUERY)
  ) {
    throw new Error('Schema 8 exact consumption lookup query drifted');
  }
  return {
    tables: schema8Tables.map((table) =>
      table.name === CONSUMPTION_TABLE
        ? rebuildConsumption(table)
        : structuredClone(table),
    ),
    queries: structuredClone(schema8Queries),
  };
}
