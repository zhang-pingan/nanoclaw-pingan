import { calculateArtifactHash } from '../../contracts/hash.js';
import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
  TypedRelationRecord,
} from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
} from '../../contracts/types.js';

export const DOMAIN_CLAIM_HANDOFF_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-domain-claim-handoff-schema-prerequisite@1.json';
export const DOMAIN_CLAIM_HANDOFF_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-domain-claim-handoff-schema-prerequisite:1\n';

const CLAIMS = 'workflow_domain_resource_claims';
const HEADS = 'workflow_domain_resource_heads';
const HANDOFFS = 'workflow_domain_resource_claim_handoffs';
const EFFECT_CLAIMS = 'workflow_graph_effect_operation_claims';
const EFFECTS = 'workflow_graph_effect_operations';
const SCHEDULES = 'workflow_root_finalization_schedules';
const RELATIONS = 'workflow_relations';

function column(
  ordinal: number,
  name: string,
  logicalType: LogicalColumnMetadata['logical_type'],
  nullable = false,
  enumValues: string[] = [],
  defaultIntent: LogicalColumnMetadata['default_intent'] = null,
  safeIntegerIntent: LogicalColumnMetadata['safe_integer_intent'] = logicalType ===
  'integer'
    ? 'non_negative'
    : 'not_applicable',
): LogicalColumnMetadata {
  return {
    ordinal,
    name,
    logical_type: logicalType,
    sqlite_type_intent: logicalType === 'integer' ? 'INTEGER' : 'TEXT',
    nullable,
    default_intent: defaultIntent,
    safe_integer_intent: safeIntegerIntent,
    enum_values: enumValues,
    relation_ids: [],
    external_reference: null,
  };
}

function foreignKey(
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

function uniqueKey(keyId: string, columns: string[]): LogicalUniqueKeyMetadata {
  return { key_id: keyId, columns, predicate_intent: null };
}

function check(
  checkId: string,
  columns: string[],
  expressionIntent: string,
): LogicalCheckMetadata {
  return {
    check_id: checkId,
    kind: 'state_field_consistency',
    columns,
    expression_intent: expressionIntent,
  };
}

function index(
  indexId: string,
  columns: string[],
  supportsQueryIds: string[] = [],
): LogicalIndexMetadata {
  return {
    index_id: indexId,
    kind: 'lookup',
    columns,
    predicate_intent: null,
    supports_query_ids: supportsQueryIds,
  };
}

function attachRelationIds(table: LogicalTableMetadata): LogicalTableMetadata {
  const result = structuredClone(table);
  for (const columnValue of result.columns) columnValue.relation_ids = [];
  for (const relation of result.foreign_keys) {
    for (const name of relation.source_columns) {
      const target = result.columns.find(
        (candidate) => candidate.name === name,
      );
      if (!target)
        throw new Error(`${table.name} relation column is absent: ${name}`);
      target.relation_ids.push(relation.relation_id);
    }
  }
  return result;
}

function replaceTable(
  tables: LogicalTableMetadata[],
  name: string,
  mutate: (table: LogicalTableMetadata) => LogicalTableMetadata,
): LogicalTableMetadata[] {
  let found = false;
  const result = tables.map((table) => {
    if (table.name !== name) return table;
    found = true;
    return attachRelationIds(mutate(structuredClone(table)));
  });
  if (!found) throw new Error(`Schema 9 R-022 target table is absent: ${name}`);
  return result;
}

function rebuildClaims(table: LogicalTableMetadata): LogicalTableMetadata {
  const resourceKeyIndex = table.unique_keys.findIndex(
    (key) => key.key_id === 'uk:domain_claims:resource',
  );
  const ownerResourceKeyIndex = table.unique_keys.findIndex(
    (key) => key.key_id === 'uk:domain_claims:owner_resource',
  );
  if (
    resourceKeyIndex < 0 ||
    ownerResourceKeyIndex < 0 ||
    table.columns.map((entry) => entry.name).join('\0') !==
      [
        'id',
        'namespace',
        'key_hash',
        'mode',
        'owner_workflow_id',
        'recipe_resource_id',
        'recipe_resource_hash',
        'source_intake_id',
        'creation_key',
        'fencing_token',
        'status',
        'acquired_at_ms',
        'released_at_ms',
        'row_version',
      ].join('\0')
  ) {
    throw new Error('Schema 9 Domain Claim authority drifted');
  }
  const next = table.columns.length + 1;
  table.columns.push(
    column(next, 'claim_epoch', 'integer', false, [], null, 'positive'),
    column(next + 1, 'fencing_token_identity', 'integer'),
    column(next + 2, 'acquisition_kind', 'text', false, ['direct', 'handoff']),
    column(next + 3, 'predecessor_claim_id', 'identifier', true),
    column(next + 4, 'handoff_id', 'identifier', true),
    column(next + 5, 'active_head_claim_id', 'identifier', true),
  );
  table.unique_keys.splice(
    resourceKeyIndex,
    1,
    uniqueKey('uk:domain_claims:resource_epoch', [
      'namespace',
      'key_hash',
      'claim_epoch',
    ]),
    uniqueKey('uk:domain_claims:exact_identity', [
      'namespace',
      'key_hash',
      'id',
      'owner_workflow_id',
      'mode',
      'claim_epoch',
      'fencing_token_identity',
    ]),
    uniqueKey('uk:domain_claims:head_identity', [
      'namespace',
      'key_hash',
      'id',
      'owner_workflow_id',
      'mode',
      'claim_epoch',
      'fencing_token_identity',
      'active_head_claim_id',
    ]),
    uniqueKey('uk:domain_claims:effect_identity', [
      'namespace',
      'key_hash',
      'id',
      'owner_workflow_id',
      'claim_epoch',
      'fencing_token_identity',
    ]),
    uniqueKey('uk:domain_claims:handoff_chain', [
      'handoff_id',
      'id',
      'predecessor_claim_id',
    ]),
  );
  table.unique_keys = table.unique_keys.filter(
    (key) => key.key_id !== 'uk:domain_claims:owner_resource',
  );
  table.foreign_keys.push(
    foreignKey(
      'fk:domain_claims:active_head',
      [
        'namespace',
        'key_hash',
        'active_head_claim_id',
        'owner_workflow_id',
        'mode',
        'claim_epoch',
        'fencing_token_identity',
      ],
      HEADS,
      [
        'namespace',
        'key_hash',
        'active_claim_id',
        'active_claim_owner_workflow_id',
        'active_claim_mode',
        'active_claim_epoch',
        'active_fencing_token_identity',
      ],
    ),
    foreignKey(
      'fk:domain_claims:predecessor_resource',
      ['namespace', 'key_hash', 'predecessor_claim_id'],
      CLAIMS,
      ['namespace', 'key_hash', 'id'],
    ),
    foreignKey(
      'fk:domain_claims:handoff_chain',
      ['handoff_id', 'id', 'predecessor_claim_id'],
      HANDOFFS,
      ['id', 'child_claim_id', 'parent_claim_id'],
    ),
  );
  table.unique_keys.push(
    uniqueKey('uk:domain_claims:resource_id', ['namespace', 'key_hash', 'id']),
  );
  table.checks.push(
    {
      check_id: 'ck:domain_claims:acquisition_kind:enum',
      kind: 'enum_membership',
      columns: ['acquisition_kind'],
      expression_intent: 'Claim acquisition kind is direct or handoff',
    },
    {
      check_id: 'ck:workflow_domain_resource_claims:acquisition_kind:enum',
      kind: 'enum_membership',
      columns: ['acquisition_kind'],
      expression_intent: 'Claim acquisition kind is direct or handoff',
    },
    check(
      'ck:domain_claims:fencing_identity',
      ['mode', 'fencing_token', 'fencing_token_identity'],
      'shared has null token identity zero; exclusive has matching positive token and identity',
    ),
    check(
      'ck:domain_claims:active_head_state',
      ['id', 'status', 'active_head_claim_id', 'released_at_ms'],
      'held or release_pending claim is the current head; released claim retains history without a head slot',
    ),
    check(
      'ck:domain_claims:acquisition_lineage',
      ['acquisition_kind', 'predecessor_claim_id', 'handoff_id'],
      'direct claim has no predecessor or handoff; handoff claim has both',
    ),
  );
  table.indexes.push(
    index('idx:domain_claims:resource_history', [
      'namespace',
      'key_hash',
      'claim_epoch',
      'id',
    ]),
  );
  return table;
}

function rebuildHeads(table: LogicalTableMetadata): LogicalTableMetadata {
  const next = table.columns.length + 1;
  table.columns.push(
    column(next, 'latest_claim_epoch', 'integer', false, [], 0),
    column(next + 1, 'active_claim_id', 'identifier', true),
    column(next + 2, 'active_claim_mode', 'text', true, [
      'shared',
      'exclusive',
    ]),
    column(next + 3, 'active_claim_owner_workflow_id', 'identifier', true),
    column(
      next + 4,
      'active_claim_epoch',
      'integer',
      true,
      [],
      null,
      'positive',
    ),
    column(next + 5, 'active_fencing_token_identity', 'integer', true),
    column(next + 6, 'active_claim_link_id', 'identifier', true),
  );
  table.unique_keys.push(
    uniqueKey('uk:domain_resource_heads:active_claim', [
      'namespace',
      'key_hash',
      'active_claim_id',
      'active_claim_owner_workflow_id',
      'active_claim_mode',
      'active_claim_epoch',
      'active_fencing_token_identity',
    ]),
  );
  table.foreign_keys.push(
    foreignKey(
      'fk:domain_resource_heads:active_claim',
      [
        'namespace',
        'key_hash',
        'active_claim_id',
        'active_claim_owner_workflow_id',
        'active_claim_mode',
        'active_claim_epoch',
        'active_fencing_token_identity',
        'active_claim_link_id',
      ],
      CLAIMS,
      [
        'namespace',
        'key_hash',
        'id',
        'owner_workflow_id',
        'mode',
        'claim_epoch',
        'fencing_token_identity',
        'active_head_claim_id',
      ],
    ),
  );
  table.checks.push(
    {
      check_id: 'ck:domain_resource_heads:active_claim_mode:enum',
      kind: 'enum_membership',
      columns: ['active_claim_mode'],
      expression_intent:
        'active Claim mode is shared or exclusive when present',
    },
    {
      check_id: 'ck:workflow_domain_resource_heads:active_claim_mode:enum',
      kind: 'enum_membership',
      columns: ['active_claim_mode'],
      expression_intent:
        'active Claim mode is shared or exclusive when present',
    },
    check(
      'ck:domain_resource_heads:active_shape',
      [
        'current_fencing_token',
        'latest_claim_epoch',
        'active_claim_id',
        'active_claim_owner_workflow_id',
        'active_claim_mode',
        'active_claim_epoch',
        'active_fencing_token_identity',
        'active_claim_link_id',
      ],
      'active claim tuple is all-null or exact with link id equal to claim id; exclusive identity equals current token and shared identity is zero',
    ),
  );
  return table;
}

function rebuildEffectClaims(
  table: LogicalTableMetadata,
): LogicalTableMetadata {
  const oldClaimRelation = table.foreign_keys.findIndex(
    (relation) => relation.relation_id === 'fk:effect_claims:claim',
  );
  if (oldClaimRelation < 0)
    throw new Error('Schema 9 Effect Claim relation is absent');
  const next = table.columns.length + 1;
  table.columns.push(
    column(next, 'graph_run_id', 'identifier'),
    column(next + 1, 'owner_workflow_id', 'identifier'),
    column(next + 2, 'namespace', 'text'),
    column(next + 3, 'key_hash', 'hash'),
    column(next + 4, 'claim_epoch', 'integer', false, [], null, 'positive'),
    column(next + 5, 'fencing_token_identity', 'integer'),
  );
  table.foreign_keys.splice(
    oldClaimRelation,
    1,
    foreignKey(
      'fk:effect_claims:claim_exact',
      [
        'namespace',
        'key_hash',
        'claim_id',
        'owner_workflow_id',
        'claim_epoch',
        'fencing_token_identity',
      ],
      CLAIMS,
      [
        'namespace',
        'key_hash',
        'id',
        'owner_workflow_id',
        'claim_epoch',
        'fencing_token_identity',
      ],
    ),
  );
  table.foreign_keys.push(
    foreignKey(
      'fk:effect_claims:operation_run',
      ['operation_id', 'graph_run_id'],
      EFFECTS,
      ['id', 'graph_run_id'],
    ),
    foreignKey(
      'fk:effect_claims:run_owner',
      ['graph_run_id', 'owner_workflow_id'],
      'workflow_graph_runs',
      ['id', 'workflow_id'],
    ),
  );
  table.checks.push(
    check(
      'ck:effect_claims:fencing_identity',
      ['access', 'fencing_token', 'fencing_token_identity'],
      'write token equals positive identity; read has null token and zero identity',
    ),
  );
  return table;
}

function addCandidateKey(
  table: LogicalTableMetadata,
  key: LogicalUniqueKeyMetadata,
): LogicalTableMetadata {
  table.unique_keys.push(key);
  return table;
}

function buildHandoffTable(ordinal: number): LogicalTableMetadata {
  const columns = [
    column(1, 'id', 'identifier'),
    column(2, 'namespace', 'text'),
    column(3, 'key_hash', 'hash'),
    column(4, 'parent_claim_id', 'identifier'),
    column(5, 'parent_workflow_id', 'identifier'),
    column(6, 'parent_claim_mode', 'text', false, ['exclusive']),
    column(7, 'parent_claim_epoch', 'integer', false, [], null, 'positive'),
    column(8, 'parent_fencing_token', 'integer', false, [], null, 'positive'),
    column(9, 'child_claim_id', 'identifier'),
    column(10, 'child_workflow_id', 'identifier'),
    column(11, 'child_claim_mode', 'text', false, ['exclusive']),
    column(12, 'child_claim_epoch', 'integer', false, [], null, 'positive'),
    column(13, 'child_fencing_token', 'integer', false, [], null, 'positive'),
    column(14, 'source_root_finalization_schedule_id', 'identifier'),
    column(15, 'source_creation_request_id', 'identifier'),
    column(16, 'source_workflow_relation_id', 'identifier'),
    column(17, 'source_root_finalization_schedule_status', 'text', false, [
      'succeeded',
    ]),
    column(18, 'created_at_ms', 'integer'),
  ];
  const table: LogicalTableMetadata = {
    ordinal,
    name: HANDOFFS,
    source_section: 'R-022 Domain Claim Handoff',
    columns,
    primary_key: { columns: ['id'], auto_increment_intent: false },
    foreign_keys: [
      foreignKey(
        'fk:domain_claim_handoffs:parent_claim',
        [
          'namespace',
          'key_hash',
          'parent_claim_id',
          'parent_workflow_id',
          'parent_claim_mode',
          'parent_claim_epoch',
          'parent_fencing_token',
        ],
        CLAIMS,
        [
          'namespace',
          'key_hash',
          'id',
          'owner_workflow_id',
          'mode',
          'claim_epoch',
          'fencing_token_identity',
        ],
      ),
      foreignKey(
        'fk:domain_claim_handoffs:child_claim',
        [
          'namespace',
          'key_hash',
          'child_claim_id',
          'child_workflow_id',
          'child_claim_mode',
          'child_claim_epoch',
          'child_fencing_token',
        ],
        CLAIMS,
        [
          'namespace',
          'key_hash',
          'id',
          'owner_workflow_id',
          'mode',
          'claim_epoch',
          'fencing_token_identity',
        ],
      ),
      foreignKey(
        'fk:domain_claim_handoffs:schedule_child',
        [
          'source_root_finalization_schedule_id',
          'parent_workflow_id',
          'source_creation_request_id',
          'child_workflow_id',
          'source_root_finalization_schedule_status',
        ],
        SCHEDULES,
        [
          'id',
          'workflow_id',
          'creation_request_id',
          'child_workflow_id',
          'status',
        ],
      ),
      foreignKey(
        'fk:domain_claim_handoffs:workflow_relation',
        [
          'source_workflow_relation_id',
          'parent_workflow_id',
          'child_workflow_id',
        ],
        RELATIONS,
        ['id', 'parent_workflow_id', 'child_workflow_id'],
      ),
    ],
    unique_keys: [
      uniqueKey('uk:domain_claim_handoffs:parent_claim', ['parent_claim_id']),
      uniqueKey('uk:domain_claim_handoffs:child_claim', ['child_claim_id']),
      uniqueKey('uk:domain_claim_handoffs:schedule_resource', [
        'source_root_finalization_schedule_id',
        'namespace',
        'key_hash',
      ]),
      uniqueKey('uk:domain_claim_handoffs:chain', [
        'id',
        'child_claim_id',
        'parent_claim_id',
      ]),
    ],
    checks: [
      {
        check_id: 'ck:domain_claim_handoffs:parent_claim_mode:enum',
        kind: 'enum_membership',
        columns: ['parent_claim_mode'],
        expression_intent: 'Parent Claim mode is exclusive',
      },
      {
        check_id: 'ck:domain_claim_handoffs:child_claim_mode:enum',
        kind: 'enum_membership',
        columns: ['child_claim_mode'],
        expression_intent: 'Child Claim mode is exclusive',
      },
      {
        check_id:
          'ck:domain_claim_handoffs:source_root_finalization_schedule_status:enum',
        kind: 'enum_membership',
        columns: ['source_root_finalization_schedule_status'],
        expression_intent: 'source Root Finalization Schedule is succeeded',
      },
      check(
        'ck:domain_claim_handoffs:exclusive_token_step',
        [
          'parent_claim_id',
          'child_claim_id',
          'parent_workflow_id',
          'child_workflow_id',
          'parent_claim_mode',
          'child_claim_mode',
          'parent_fencing_token',
          'child_fencing_token',
          'parent_claim_epoch',
          'child_claim_epoch',
        ],
        'distinct Parent and Child exclusive claims and owners with Child token and epoch exactly Parent plus one',
      ),
    ],
    indexes: [
      index(
        'idx:domain_claim_handoffs:resource_history',
        ['namespace', 'key_hash', 'child_claim_epoch', 'id'],
        ['query:domain_claim_handoff_exact_replay'],
      ),
    ],
  };
  return attachRelationIds(table);
}

export const DOMAIN_CLAIM_HANDOFF_QUERY: LogicalQueryIntent = {
  query_id: 'query:domain_claim_handoff_exact_replay',
  owner: 'root_finalizer',
  purpose:
    'recover exact required Child Domain Claim handoff after response loss',
  table: HANDOFFS,
  join_tables: [],
  equality_columns: ['namespace', 'key_hash', 'child_claim_id'],
  range_columns: [],
  state_predicate_intent: null,
  order_by: [],
  result_cardinality: 'zero_or_one',
  required_index_id: 'uk:domain_claim_handoffs:child_claim',
  execution_status: 'intent_only',
};

function relationRecord(
  table: LogicalTableMetadata,
  relation: LogicalForeignKeyMetadata,
): TypedRelationRecord & JsonObject {
  return {
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
  };
}

function prerequisiteRelation(
  relationId: string,
  sourceTable: string,
  sourceColumns: string[],
  targetTable: string,
  targetColumns: string[],
): TypedRelationRecord & JsonObject {
  return {
    relation_id: relationId,
    relation_kind: 'foreign_key',
    source_table: sourceTable,
    source_columns: sourceColumns,
    target_table: targetTable,
    target_columns: targetColumns,
    on_delete: 'restrict',
    deferrability: 'deferred',
    validator_owner: null,
    reference_domain: null,
  };
}

const REQUIRED_HANDOFF_RELATIONS = [
  prerequisiteRelation(
    'fk:domain_claims:active_head',
    CLAIMS,
    [
      'namespace',
      'key_hash',
      'active_head_claim_id',
      'owner_workflow_id',
      'mode',
      'claim_epoch',
      'fencing_token_identity',
    ],
    HEADS,
    [
      'namespace',
      'key_hash',
      'active_claim_id',
      'active_claim_owner_workflow_id',
      'active_claim_mode',
      'active_claim_epoch',
      'active_fencing_token_identity',
    ],
  ),
  prerequisiteRelation(
    'fk:domain_claims:predecessor_resource',
    CLAIMS,
    ['namespace', 'key_hash', 'predecessor_claim_id'],
    CLAIMS,
    ['namespace', 'key_hash', 'id'],
  ),
  prerequisiteRelation(
    'fk:domain_claims:handoff_chain',
    CLAIMS,
    ['handoff_id', 'id', 'predecessor_claim_id'],
    HANDOFFS,
    ['id', 'child_claim_id', 'parent_claim_id'],
  ),
  prerequisiteRelation(
    'fk:domain_resource_heads:active_claim',
    HEADS,
    [
      'namespace',
      'key_hash',
      'active_claim_id',
      'active_claim_owner_workflow_id',
      'active_claim_mode',
      'active_claim_epoch',
      'active_fencing_token_identity',
      'active_claim_link_id',
    ],
    CLAIMS,
    [
      'namespace',
      'key_hash',
      'id',
      'owner_workflow_id',
      'mode',
      'claim_epoch',
      'fencing_token_identity',
      'active_head_claim_id',
    ],
  ),
  prerequisiteRelation(
    'fk:domain_claim_handoffs:parent_claim',
    HANDOFFS,
    [
      'namespace',
      'key_hash',
      'parent_claim_id',
      'parent_workflow_id',
      'parent_claim_mode',
      'parent_claim_epoch',
      'parent_fencing_token',
    ],
    CLAIMS,
    [
      'namespace',
      'key_hash',
      'id',
      'owner_workflow_id',
      'mode',
      'claim_epoch',
      'fencing_token_identity',
    ],
  ),
  prerequisiteRelation(
    'fk:domain_claim_handoffs:child_claim',
    HANDOFFS,
    [
      'namespace',
      'key_hash',
      'child_claim_id',
      'child_workflow_id',
      'child_claim_mode',
      'child_claim_epoch',
      'child_fencing_token',
    ],
    CLAIMS,
    [
      'namespace',
      'key_hash',
      'id',
      'owner_workflow_id',
      'mode',
      'claim_epoch',
      'fencing_token_identity',
    ],
  ),
  prerequisiteRelation(
    'fk:domain_claim_handoffs:schedule_child',
    HANDOFFS,
    [
      'source_root_finalization_schedule_id',
      'parent_workflow_id',
      'source_creation_request_id',
      'child_workflow_id',
      'source_root_finalization_schedule_status',
    ],
    SCHEDULES,
    ['id', 'workflow_id', 'creation_request_id', 'child_workflow_id', 'status'],
  ),
  prerequisiteRelation(
    'fk:domain_claim_handoffs:workflow_relation',
    HANDOFFS,
    ['source_workflow_relation_id', 'parent_workflow_id', 'child_workflow_id'],
    RELATIONS,
    ['id', 'parent_workflow_id', 'child_workflow_id'],
  ),
  prerequisiteRelation(
    'fk:effect_claims:claim_exact',
    EFFECT_CLAIMS,
    [
      'namespace',
      'key_hash',
      'claim_id',
      'owner_workflow_id',
      'claim_epoch',
      'fencing_token_identity',
    ],
    CLAIMS,
    [
      'namespace',
      'key_hash',
      'id',
      'owner_workflow_id',
      'claim_epoch',
      'fencing_token_identity',
    ],
  ),
  prerequisiteRelation(
    'fk:effect_claims:operation_run',
    EFFECT_CLAIMS,
    ['operation_id', 'graph_run_id'],
    EFFECTS,
    ['id', 'graph_run_id'],
  ),
  prerequisiteRelation(
    'fk:effect_claims:run_owner',
    EFFECT_CLAIMS,
    ['graph_run_id', 'owner_workflow_id'],
    'workflow_graph_runs',
    ['id', 'workflow_id'],
  ),
];

function buildAppliedSchema(
  schema9Tables: LogicalTableMetadata[],
  schema9Queries: LogicalQueryIntent[],
): { tables: LogicalTableMetadata[]; queries: LogicalQueryIntent[] } {
  let tables = structuredClone(schema9Tables);
  tables = replaceTable(tables, CLAIMS, rebuildClaims);
  tables = replaceTable(tables, HEADS, rebuildHeads);
  tables = replaceTable(tables, EFFECT_CLAIMS, rebuildEffectClaims);
  tables = replaceTable(tables, EFFECTS, (table) =>
    addCandidateKey(
      table,
      uniqueKey('uk:effect_operations:id_run', ['id', 'graph_run_id']),
    ),
  );
  tables = replaceTable(tables, SCHEDULES, (table) =>
    addCandidateKey(
      table,
      uniqueKey('uk:root_finalization_schedules:handoff_child', [
        'id',
        'workflow_id',
        'creation_request_id',
        'child_workflow_id',
        'status',
      ]),
    ),
  );
  tables = replaceTable(tables, RELATIONS, (table) =>
    addCandidateKey(
      table,
      uniqueKey('uk:workflow_relations:id_parent_child', [
        'id',
        'parent_workflow_id',
        'child_workflow_id',
      ]),
    ),
  );
  tables.push(buildHandoffTable(tables.length + 1));
  return {
    tables,
    queries: [
      ...structuredClone(schema9Queries),
      structuredClone(DOMAIN_CLAIM_HANDOFF_QUERY),
    ],
  };
}

export function buildDomainClaimHandoffSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const payload: JsonObject = {
    format: 'icarus.workflow-domain-claim-handoff-schema-prerequisite/1',
    decision_id: 'R-022',
    schema_id: 'workflow-runtime-schema-v1',
    database_schema_version: 10,
    predecessor_database_schema_version: 9,
    canonical_model: 'owner_bound_append_history_with_exact_current_head',
    identity_contract: {
      claim_id: 'owner_workflow_and_creation_key_bound_stable_identity',
      history: 'released_rows_are_never_rekeyed_reused_or_deleted',
      resource_head: 'never_deleted_or_reset_after_first_acquire',
      resource_generation: 'strictly_monotonic_claim_epoch_per_resource',
      exclusive_fencing: 'child_token_equals_parent_token_plus_one',
    },
    relationship_contract: {
      current_holder:
        'bidirectional_deferred_composite_foreign_keys_between_claim_and_resource_head',
      handoff:
        'immutable_exact_parent_child_claim_schedule_creation_request_and_workflow_relation',
      effect_claim: 'exact_run_owner_resource_claim_epoch_and_fencing_identity',
      typed_relation_ids: [
        'fk:domain_claims:active_head',
        'fk:domain_claims:predecessor_resource',
        'fk:domain_claims:handoff_chain',
        'fk:domain_resource_heads:active_claim',
        'fk:domain_claim_handoffs:parent_claim',
        'fk:domain_claim_handoffs:child_claim',
        'fk:domain_claim_handoffs:schedule_child',
        'fk:domain_claim_handoffs:workflow_relation',
        'fk:effect_claims:claim_exact',
        'fk:effect_claims:operation_run',
        'fk:effect_claims:run_owner',
      ],
      exact_typed_relations: structuredClone(REQUIRED_HANDOFF_RELATIONS),
    },
    affected_tables: [
      CLAIMS,
      HEADS,
      HANDOFFS,
      EFFECT_CLAIMS,
      EFFECTS,
      SCHEDULES,
      RELATIONS,
    ],
    added_table_count: 1,
    query_intents: [
      structuredClone(DOMAIN_CLAIM_HANDOFF_QUERY) as LogicalQueryIntent &
        JsonObject,
    ],
    upgrade_contract: {
      source_version: 9,
      target_version: 10,
      schema9_claim_epoch: 1,
      schema9_acquisition_kind: 'direct',
      schema9_released_history: 'preserved_with_null_active_head',
      schema9_active_claim: 'exact_head_tuple_or_upgrade_fails_closed',
      transaction:
        'single_begin_immediate_copy_validate_commit_or_full_rollback',
      historical_schema_9_and_earlier_artifacts_ddl_upgrades: 'byte_immutable',
    },
    fixture_contract: {
      positive: [
        'direct_acquire_release_reacquire_append_history',
        'required_child_atomic_handoff',
        'response_loss_reopen_exact_replay',
        'effect_claim_exact_lineage',
      ],
      negative: [
        'duplicate_or_stale_version',
        'tamper',
        'wrong_owner',
        'wrong_parent_child',
        'wrong_resource',
        'wrong_token',
        'wrong_schedule_creation_request_relation',
        'effect_claim_lineage',
        'current_historical_authority_crossing',
      ],
      fault: [
        'release_before_head_cas',
        'head_cas_before_child_insert',
        'child_insert_before_handoff_insert',
        'handoff_insert_before_commit',
        'migration_copy_and_commit_rollback',
      ],
      historical_blocker:
        'schema9_all_status_unique_impossibility_remains_byte_exact_and_2_of_2',
      execution_target: 'real_file_sqlite',
    },
    rejected_models: {
      rekey_released_parent: 'closed_rejected_breaks_resource_provenance',
      reuse_parent_claim_row: 'closed_rejected_breaks_owner_bound_identity',
      partial_unique_only: 'closed_rejected_lacks_exact_current_head_relation',
      delete_or_ignore_released_row:
        'closed_rejected_breaks_audit_and_effect_lineage',
      delayed_post_t8_acquire: 'closed_rejected_breaks_atomicity',
    },
    forbidden_implementation: [
      'g6_dynamic_close_business_transactions',
      'child_creation_or_finalization',
      'subgraph_expand_map_materialization',
      'compensation_or_root_finalization',
      'g7_or_later_runtime_surface',
      'certification_or_production_activation',
    ],
  };
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-domain-claim-handoff-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-domain-claim-handoff-schema-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: DOMAIN_CLAIM_HANDOFF_SCHEMA_INPUT_DOMAIN,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

export function applyDomainClaimHandoffSchemaPrerequisite(
  schema9Tables: LogicalTableMetadata[],
  schema9Queries: LogicalQueryIntent[],
  artifact: ContractArtifactEnvelope,
): { tables: LogicalTableMetadata[]; queries: LogicalQueryIntent[] } {
  const expected = buildDomainClaimHandoffSchemaPrerequisiteArtifact();
  if (artifact.format !== expected.format || artifact.hash !== expected.hash) {
    throw new Error('R-022 Domain Claim handoff prerequisite drifted');
  }
  const applied = buildAppliedSchema(schema9Tables, schema9Queries);
  const actualRelations = applied.tables.flatMap((table) =>
    table.foreign_keys.map((relation) => relationRecord(table, relation)),
  );
  for (const required of REQUIRED_HANDOFF_RELATIONS) {
    const actual = actualRelations.find(
      (candidate) => candidate.relation_id === required.relation_id,
    );
    if (!actual || JSON.stringify(actual) !== JSON.stringify(required)) {
      throw new Error(
        `R-022 exact typed relation drifted: ${required.relation_id}`,
      );
    }
  }
  return applied;
}
