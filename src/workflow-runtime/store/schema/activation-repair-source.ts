import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from '../../contracts/hash.js';
import { buildG38ARepairPayload } from '../../contracts/g3-8a-activation-contract-repair.js';
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
} from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../../contracts/types.js';
import {
  ACTIVATION_SCHEMA_INPUT_ARTIFACT_HASH,
  buildActivationSchemaPrerequisitePayload,
} from './activation-source.js';

export const ACTIVATION_REPAIR_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-feature-release-activation-failure-replay-schema-prerequisite@1.json';
export const ACTIVATION_REPAIR_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-feature-release-activation-failure-replay-schema-prerequisite:1\n';
export const ACTIVATION_REPAIR_SCHEMA_DELTA_DOMAIN =
  'icarus:workflow-feature-release-activation-failure-replay-logical-schema-delta:1\n';

export const G38A_FROZEN_IDENTITIES = {
  pack: 'sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f',
  artifact:
    'sha256:94cb2c390bb44298238b1ffac4184b04f59efbbeae6f268fbce7618104ec406b',
  contract:
    'sha256:70d4b9ef47c83711415636737292450538acaf5cc4547d3130b04b101e6707ae',
} as const;

type ActivationRelation =
  | 'workflow_feature_release_activation_commands'
  | 'workflow_feature_release_activation_invocations'
  | 'workflow_feature_release_activation_events';

interface G38AColumnRequirement extends JsonObject {
  relation: ActivationRelation;
  name: string;
  sqlite_type: 'TEXT' | 'INTEGER';
  nullable: boolean;
  safe_integer: 'not_applicable' | 'non_negative' | 'positive';
  enum_values: string[];
  role: string;
}

interface G38AForeignKeyRequirement extends JsonObject {
  relation_id: string;
  source_relation: ActivationRelation;
  source_columns: string[];
  target_relation: string;
  target_columns: string[];
  nullable: true;
  deferrability: 'deferred';
}

interface G38AUniqueKeyRequirement extends JsonObject {
  key_id: string;
  relation: ActivationRelation;
  columns: string[];
  predicate: string | null;
}

export interface ActivationRepairSchemaPrerequisitePayload extends JsonObject {
  format: 'icarus.workflow-feature-release-activation-failure-replay-schema-prerequisite/1';
  schema_id: 'workflow-runtime-schema-v1';
  database_schema_version: 4;
  delta_mode: 'rebuild_activation_relations';
  contract_stage: 'g1_physical_schema_input';
  historical_inputs: {
    schema3_activation_prerequisite_hash: Sha256Hash;
    identity_policy: 'preserve_schema3_as_upgrade_input';
  } & JsonObject;
  frozen_g3_8a_contract: {
    pack_hash: Sha256Hash;
    repair_artifact_hash: Sha256Hash;
    internal_contract_hash: Sha256Hash;
    column_requirement_count: 62;
    foreign_key_requirement_count: 12;
    unique_key_requirement_count: 7;
  } & JsonObject;
  column_requirements: G38AColumnRequirement[] & JsonObject[];
  foreign_key_requirements: G38AForeignKeyRequirement[] & JsonObject[];
  unique_key_requirements: G38AUniqueKeyRequirement[] & JsonObject[];
  relation_requirements: JsonObject[];
  rebuilt_tables: LogicalTableMetadata[] & JsonObject[];
  replaced_query_ids: string[];
  query_intents: LogicalQueryIntent[] & JsonObject[];
  trigger_intents: string[];
  constraint_fixture_cases: string[];
  schema3_upgrade_mode: 'empty_activation_state_only_or_fail_closed';
  schema3_required_empty_relations: string[];
  forbidden_implementation_surfaces: string[];
  delta_hash: Sha256Hash;
}

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

function externalReferenceFor(name: string): ExternalReferenceMetadata | null {
  if (name === 'verified_feature_id') {
    return {
      validator_owner: 'feature_registry',
      reference_domain: 'feature',
      immutable: true,
    };
  }
  if (name.endsWith('_feature_release_ref')) {
    return {
      validator_owner: 'feature_release_ref_validator',
      reference_domain: 'feature_release',
      immutable: true,
    };
  }
  return null;
}

function logicalTypeFor(requirement: G38AColumnRequirement): LogicalColumnType {
  if (requirement.sqlite_type === 'INTEGER') return 'integer';
  if (externalReferenceFor(requirement.name)) return 'external_reference';
  if (requirement.name.endsWith('_hash')) return 'hash';
  if (
    requirement.name.endsWith('_id') ||
    requirement.name === 'canonical_terminal_invocation_id'
  ) {
    return 'identifier';
  }
  return 'text';
}

function requirementColumn(
  requirement: G38AColumnRequirement,
): LogicalColumnMetadata {
  return {
    ordinal: 0,
    name: requirement.name,
    logical_type: logicalTypeFor(requirement),
    sqlite_type_intent: requirement.sqlite_type,
    nullable: requirement.nullable,
    default_intent: null,
    safe_integer_intent: requirement.safe_integer as SafeIntegerIntent,
    enum_values: [...requirement.enum_values],
    relation_ids: [],
    external_reference: externalReferenceFor(requirement.name),
  };
}

function cloneColumn(
  table: LogicalTableMetadata,
  name: string,
): LogicalColumnMetadata {
  const column = table.columns.find((candidate) => candidate.name === name);
  if (!column)
    throw new Error(`Schema 3 column is missing: ${table.name}.${name}`);
  return structuredClone(column);
}

function automaticChecks(
  tableName: string,
  columns: LogicalColumnMetadata[],
): LogicalCheckMetadata[] {
  return columns.flatMap((column) => {
    const checks: LogicalCheckMetadata[] = [];
    if (column.enum_values.length > 0) {
      checks.push(
        check(
          `ck:${tableName}:${column.name}:enum`,
          'enum_membership',
          [column.name],
          `value is one of ${column.enum_values.join(' | ')}`,
        ),
      );
    }
    if (column.logical_type === 'hash') {
      checks.push(
        check(
          `ck:${tableName}:${column.name}:hash`,
          'hash_format',
          [column.name],
          'nullable or sha256:<64 lowercase hexadecimal characters>',
        ),
      );
    }
    if (column.safe_integer_intent !== 'not_applicable') {
      checks.push(
        check(
          `ck:${tableName}:${column.name}:safe_integer`,
          'safe_integer',
          [column.name],
          `${column.safe_integer_intent} JavaScript safe integer`,
        ),
      );
    }
    return checks;
  });
}

function withRelations(
  columns: LogicalColumnMetadata[],
  foreignKeys: LogicalForeignKeyMetadata[],
): LogicalColumnMetadata[] {
  return columns.map((column, indexValue) => ({
    ...column,
    ordinal: indexValue + 1,
    relation_ids: foreignKeys
      .filter((relation) => relation.source_columns.includes(column.name))
      .map((relation) => relation.relation_id)
      .sort(),
  }));
}

function allOrNone(checkId: string, columns: string[]): LogicalCheckMetadata {
  return check(
    checkId,
    'all_or_none',
    columns,
    'all columns are null or all are non-null',
  );
}

function requirementColumns(
  requirements: G38AColumnRequirement[],
  relation: ActivationRelation,
): G38AColumnRequirement[] {
  return requirements.filter((entry) => entry.relation === relation);
}

function requirementForeignKeys(
  requirements: G38AForeignKeyRequirement[],
  relation: ActivationRelation,
): LogicalForeignKeyMetadata[] {
  return requirements
    .filter((entry) => entry.source_relation === relation)
    .map((entry) =>
      fk(entry.relation_id, [...entry.source_columns], entry.target_relation, [
        ...entry.target_columns,
      ]),
    );
}

function requirementUniqueKeys(
  requirements: G38AUniqueKeyRequirement[],
  relation: ActivationRelation,
): LogicalUniqueKeyMetadata[] {
  return requirements
    .filter((entry) => entry.relation === relation)
    .map((entry) => uk(entry.key_id, [...entry.columns], entry.predicate));
}

function buildCommandTable(
  schema3: LogicalTableMetadata,
  columnRequirements: G38AColumnRequirement[],
  fkRequirements: G38AForeignKeyRequirement[],
  ukRequirements: G38AUniqueKeyRequirement[],
): LogicalTableMetadata {
  const retainedBefore = [
    'command_id',
    'command_type',
    'idempotency_domain',
    'idempotency_key',
    'request_value_id',
    'request_hash',
    'request_schema_resource_id',
    'request_schema_hash',
    'domain_request_hash',
  ].map((name) => cloneColumn(schema3, name));
  const repairColumns = requirementColumns(
    columnRequirements,
    schema3.name as ActivationRelation,
  );
  const lifecycle = repairColumns.find((entry) => entry.name === 'lifecycle');
  if (!lifecycle) throw new Error('G3.8A lifecycle requirement is missing');
  const columns = [
    ...retainedBefore,
    ...repairColumns
      .filter((entry) => entry.name !== 'lifecycle')
      .map(requirementColumn),
    cloneColumn(schema3, 'applied_pointer_row_version'),
    cloneColumn(schema3, 'canonical_receipt_value_id'),
    cloneColumn(schema3, 'canonical_receipt_hash'),
    cloneColumn(schema3, 'canonical_receipt_schema_resource_id'),
    cloneColumn(schema3, 'canonical_receipt_schema_hash'),
    requirementColumn(lifecycle),
    cloneColumn(schema3, 'created_at_ms'),
    cloneColumn(schema3, 'finalized_at_ms'),
    cloneColumn(schema3, 'row_version'),
  ];
  const foreignKeys = [
    fk(
      'fk:activation_commands:request_value',
      [
        'request_value_id',
        'request_hash',
        'request_schema_resource_id',
        'request_schema_hash',
      ],
      'workflow_values',
      ['id', 'content_hash', 'schema_resource_id', 'schema_resource_hash'],
    ),
    ...requirementForeignKeys(
      fkRequirements,
      schema3.name as ActivationRelation,
    ),
    fk(
      'fk:activation_commands:canonical_receipt_value',
      [
        'canonical_receipt_value_id',
        'canonical_receipt_hash',
        'canonical_receipt_schema_resource_id',
        'canonical_receipt_schema_hash',
      ],
      'workflow_values',
      ['id', 'content_hash', 'schema_resource_id', 'schema_resource_hash'],
    ),
  ];
  const targetRelease = [
    'verified_feature_id',
    'verified_target_feature_release_id',
    'verified_target_feature_release_ref',
    'verified_target_feature_release_version',
    'verified_target_feature_release_hash',
  ];
  const previousRelease = [
    'verified_previous_feature_release_id',
    'verified_previous_feature_release_ref',
    'verified_previous_feature_release_version',
    'verified_previous_feature_release_hash',
  ];
  const targetRetentionIdentity = [
    'verified_target_retention_handle_id',
    'verified_target_retention_handle_kind',
    'verified_target_retention_feature_release_id',
    'verified_target_retention_closure_manifest_id',
    'verified_target_retention_closure_hash',
  ];
  const previousRetentionIdentity = [
    'verified_previous_retention_handle_id',
    'verified_previous_retention_handle_kind',
    'verified_previous_retention_feature_release_id',
    'verified_previous_retention_closure_manifest_id',
    'verified_previous_retention_closure_hash',
  ];
  const checks = [
    ...automaticChecks(schema3.name, columns),
    check(
      'ck:activation_commands:idempotency_non_empty',
      'state_field_consistency',
      ['idempotency_domain', 'idempotency_key'],
      'caller idempotency domain and key are non-empty bounded tokens',
    ),
    allOrNone('ck:activation_commands:verified_compatibility_input', [
      'verified_compatibility_input_value_id',
      'verified_compatibility_input_hash',
      'verified_compatibility_input_schema_resource_id',
      'verified_compatibility_input_schema_hash',
    ]),
    allOrNone('ck:activation_commands:verified_compatibility_result', [
      'verified_compatibility_result_value_id',
      'verified_compatibility_result_hash',
      'verified_compatibility_result_schema_resource_id',
      'verified_compatibility_result_schema_hash',
    ]),
    allOrNone('ck:activation_commands:verified_target_release', targetRelease),
    allOrNone(
      'ck:activation_commands:verified_previous_release',
      previousRelease,
    ),
    allOrNone(
      'ck:activation_commands:verified_target_retention_identity',
      targetRetentionIdentity,
    ),
    allOrNone('ck:activation_commands:verified_target_retention_observation', [
      'verified_target_retention_observed_status',
      'verified_target_retention_observed_row_version',
    ]),
    allOrNone(
      'ck:activation_commands:verified_previous_retention_identity',
      previousRetentionIdentity,
    ),
    allOrNone(
      'ck:activation_commands:verified_previous_retention_observation',
      [
        'verified_previous_retention_observed_status',
        'verified_previous_retention_observed_row_version',
      ],
    ),
    allOrNone('ck:activation_commands:canonical_terminal_result', [
      'canonical_terminal_result_value_id',
      'canonical_terminal_result_hash',
      'canonical_terminal_result_schema_resource_id',
      'canonical_terminal_result_schema_hash',
    ]),
    allOrNone('ck:activation_commands:canonical_terminal_invocation', [
      'canonical_terminal_invocation_id',
      'canonical_terminal_invocation_no',
      'canonical_terminal_invocation_hash',
      'canonical_terminal_submitted_request_hash',
    ]),
    allOrNone('ck:activation_commands:receipt_binding', [
      'canonical_receipt_value_id',
      'canonical_receipt_hash',
      'canonical_receipt_schema_resource_id',
      'canonical_receipt_schema_hash',
    ]),
    check(
      'ck:activation_commands:verified_prefix',
      'state_field_consistency',
      columns.map((column) => column.name),
      'nullable verified facts form a monotonic legal preflight prefix without holes',
    ),
    check(
      'ck:activation_commands:pointer_observation_shape',
      'closed_target_mapping',
      [
        'observed_pointer_state',
        'observed_pointer_row_version',
        'observed_feature_release_id',
        'observed_feature_release_ref',
        'observed_feature_release_version',
        'observed_feature_release_hash',
      ],
      'null is unverified, absent has no row/release, and present has the complete row/release fact',
    ),
    check(
      'ck:activation_commands:target_previous_distinct',
      'cross_column_equality',
      [
        'verified_target_feature_release_id',
        'verified_previous_feature_release_id',
      ],
      'verified target and previous Feature Release identities differ',
    ),
    check(
      'ck:activation_commands:lifecycle',
      'state_field_consistency',
      columns.map((column) => column.name),
      'pending has no verified or terminal facts; terminal binds exact result and Invocation; only applied has receipt and applied pointer version',
    ),
  ];
  return {
    ordinal: schema3.ordinal,
    name: schema3.name,
    source_section: 'G1.6 Activation failure/replay Schema 4 prerequisite',
    columns: withRelations(columns, foreignKeys),
    primary_key: structuredClone(schema3.primary_key),
    foreign_keys: foreignKeys,
    unique_keys: requirementUniqueKeys(
      ukRequirements,
      schema3.name as ActivationRelation,
    ),
    checks,
    indexes: [
      index(
        'idx:activation_commands:idempotency',
        'lookup',
        ['idempotency_domain', 'idempotency_key'],
        null,
        ['activation_find_idempotency'],
      ),
      index(
        'idx:activation_commands:terminal_result',
        'lookup',
        [
          'command_id',
          'terminal_disposition',
          'canonical_terminal_invocation_no',
        ],
        "lifecycle in ('applied', 'failed', 'conflict')",
        ['activation_lookup_terminal_result'],
      ),
      index(
        'idx:activation_commands:pending_recovery',
        'recovery',
        ['created_at_ms', 'command_id'],
        "lifecycle = 'pending'",
        ['activation_recovery_scan_pending'],
      ),
    ],
  };
}

function buildInvocationTable(
  schema3: LogicalTableMetadata,
  columnRequirements: G38AColumnRequirement[],
  fkRequirements: G38AForeignKeyRequirement[],
  ukRequirements: G38AUniqueKeyRequirement[],
): LogicalTableMetadata {
  const insertAfterInvocationNo = requirementColumns(
    columnRequirements,
    schema3.name as ActivationRelation,
  ).find((entry) => entry.name === 'invocation_kind');
  if (!insertAfterInvocationNo)
    throw new Error('G3.8A invocation_kind is missing');
  const referenced = requirementColumns(
    columnRequirements,
    schema3.name as ActivationRelation,
  ).filter((entry) => entry.name !== 'invocation_kind');
  const columns = schema3.columns.flatMap((column) => {
    if (column.name === 'invocation_no') {
      return [
        structuredClone(column),
        requirementColumn(insertAfterInvocationNo),
      ];
    }
    if (column.name === 'decided_at_ms') {
      return [...referenced.map(requirementColumn), structuredClone(column)];
    }
    return [structuredClone(column)];
  });
  const foreignKeys = [
    fk(
      'fk:activation_invocations:command_request',
      ['command_id', 'command_domain_request_hash'],
      'workflow_feature_release_activation_commands',
      ['command_id', 'domain_request_hash'],
    ),
    fk(
      'fk:activation_invocations:result_value',
      [
        'result_value_id',
        'result_hash',
        'result_schema_resource_id',
        'result_schema_hash',
      ],
      'workflow_values',
      ['id', 'content_hash', 'schema_resource_id', 'schema_resource_hash'],
    ),
    ...requirementForeignKeys(
      fkRequirements,
      schema3.name as ActivationRelation,
    ),
  ];
  return {
    ordinal: schema3.ordinal,
    name: schema3.name,
    source_section: 'G1.6 Activation failure/replay Schema 4 prerequisite',
    columns: withRelations(columns, foreignKeys),
    primary_key: structuredClone(schema3.primary_key),
    foreign_keys: foreignKeys,
    unique_keys: requirementUniqueKeys(
      ukRequirements,
      schema3.name as ActivationRelation,
    ),
    checks: [
      ...automaticChecks(schema3.name, columns),
      allOrNone('ck:activation_invocations:referenced_terminal_result', [
        'referenced_terminal_result_value_id',
        'referenced_terminal_result_hash',
        'referenced_terminal_result_schema_resource_id',
        'referenced_terminal_result_schema_hash',
      ]),
      check(
        'ck:activation_invocations:result_consistency',
        'state_field_consistency',
        columns.map((column) => column.name),
        'terminal, duplicate, domain-drift conflict, and pointer-conflict result/reference shapes are closed',
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
  };
}

function buildEventTable(
  schema3: LogicalTableMetadata,
  columnRequirements: G38AColumnRequirement[],
  fkRequirements: G38AForeignKeyRequirement[],
  ukRequirements: G38AUniqueKeyRequirement[],
): LogicalTableMetadata {
  const replacements = new Map(
    requirementColumns(
      columnRequirements,
      schema3.name as ActivationRelation,
    ).map((entry) => [entry.name, entry]),
  );
  const removed = new Set([
    'feature_id',
    'target_feature_release_id',
    'target_feature_release_ref',
    'target_feature_release_version',
    'target_feature_release_hash',
    'previous_feature_release_id',
    'previous_feature_release_ref',
    'previous_feature_release_version',
    'previous_feature_release_hash',
  ]);
  const releaseColumns = [...replacements.values()]
    .filter((entry) => entry.name !== 'event_type')
    .map(requirementColumn);
  const eventType = replacements.get('event_type');
  if (!eventType) throw new Error('G3.8A Event event_type is missing');
  const columns = schema3.columns.flatMap((column) => {
    if (removed.has(column.name)) return [];
    if (column.name === 'event_type') return [requirementColumn(eventType)];
    if (column.name === 'detail_value_id') {
      return [...releaseColumns, structuredClone(column)];
    }
    return [structuredClone(column)];
  });
  const foreignKeys = [
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
    ...requirementForeignKeys(
      fkRequirements,
      schema3.name as ActivationRelation,
    ),
    fk(
      'fk:activation_events:detail_value',
      [
        'detail_value_id',
        'detail_hash',
        'detail_schema_resource_id',
        'detail_schema_hash',
      ],
      'workflow_values',
      ['id', 'content_hash', 'schema_resource_id', 'schema_resource_hash'],
    ),
  ];
  return {
    ordinal: schema3.ordinal,
    name: schema3.name,
    source_section: 'G1.6 Activation failure/replay Schema 4 prerequisite',
    columns: withRelations(columns, foreignKeys),
    primary_key: structuredClone(schema3.primary_key),
    foreign_keys: foreignKeys,
    unique_keys: requirementUniqueKeys(
      ukRequirements,
      schema3.name as ActivationRelation,
    ),
    checks: [
      ...automaticChecks(schema3.name, columns),
      check(
        'ck:activation_events:verified_release_binding',
        'closed_target_mapping',
        [
          'verified_feature_id',
          'verified_target_feature_release_id',
          'verified_target_feature_release_ref',
          'verified_target_feature_release_version',
          'verified_target_feature_release_hash',
          'verified_previous_feature_release_id',
          'verified_previous_feature_release_ref',
          'verified_previous_feature_release_version',
          'verified_previous_feature_release_hash',
        ],
        'verified target and previous Release groups are nullable, all-or-none, and prefix ordered',
      ),
      allOrNone('ck:activation_events:detail_binding', [
        'detail_value_id',
        'detail_hash',
        'detail_schema_resource_id',
        'detail_schema_hash',
      ]),
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
        'closed phase event failure mapping covers replay conflict and integrity events',
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
  };
}

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
    'Resolve caller key with terminal disposition result and receipt identity',
    'workflow_feature_release_activation_commands',
    ['idempotency_domain', 'idempotency_key'],
    null,
    'idx:activation_commands:idempotency',
    'zero_or_one',
  ),
  query(
    'activation_lookup_terminal_result',
    'recovery',
    'Load the header-bound canonical terminal Invocation and result Value',
    'workflow_feature_release_activation_commands',
    ['command_id'],
    "lifecycle in ('applied', 'failed', 'conflict')",
    'idx:activation_commands:terminal_result',
    'zero_or_one',
    [],
    ['workflow_feature_release_activation_invocations', 'workflow_values'],
  ),
  query(
    'activation_load_invocations',
    'command_gateway',
    'Replay adjacent immutable Activation Invocation history',
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
    'Replay adjacent immutable Activation Event history',
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
    'Bounded scan of clean pending Activation commands',
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
    'Read owner pointer state version and exact Release identity',
    'workflow_feature_active_releases',
    ['feature_id'],
    null,
    'idx:feature_active_releases:activation_cas',
    'zero_or_one',
  ),
  query(
    'activation_release_preflight',
    'command_gateway',
    'Verify exact Release owner identity lifecycle and authoritative resource set',
    'workflow_feature_releases',
    ['feature_id', 'id', 'release_hash', 'status'],
    null,
    'idx:feature_releases:activation_preflight',
    'zero_or_one',
    [],
    ['workflow_feature_release_resources'],
  ),
  query(
    'activation_retention_preflight',
    'command_gateway',
    'Verify immutable published Handle identity and mutable held observation',
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

function buildRebuiltTables(
  columnRequirements: G38AColumnRequirement[],
  fkRequirements: G38AForeignKeyRequirement[],
  ukRequirements: G38AUniqueKeyRequirement[],
): LogicalTableMetadata[] {
  const schema3Tables = buildActivationSchemaPrerequisitePayload().added_tables;
  const table = (name: ActivationRelation) => {
    const result = schema3Tables.find((candidate) => candidate.name === name);
    if (!result)
      throw new Error(`Schema 3 Activation table is missing: ${name}`);
    return result;
  };
  return [
    buildCommandTable(
      table('workflow_feature_release_activation_commands'),
      columnRequirements,
      fkRequirements,
      ukRequirements,
    ),
    buildInvocationTable(
      table('workflow_feature_release_activation_invocations'),
      columnRequirements,
      fkRequirements,
      ukRequirements,
    ),
    buildEventTable(
      table('workflow_feature_release_activation_events'),
      columnRequirements,
      fkRequirements,
      ukRequirements,
    ),
  ];
}

export function buildActivationRepairSchemaPrerequisitePayload(): ActivationRepairSchemaPrerequisitePayload {
  const repair = buildG38ARepairPayload();
  if (repair.contract_hash !== G38A_FROZEN_IDENTITIES.contract) {
    throw new Error('G3.8A internal Contract identity drifted');
  }
  const schema4 = repair.schema4_prerequisite as {
    relation_changes: JsonObject[];
    column_requirements: G38AColumnRequirement[];
    foreign_key_requirements: G38AForeignKeyRequirement[];
    unique_key_requirements: G38AUniqueKeyRequirement[];
    query_intents: string[];
  };
  if (
    schema4.column_requirements.length !== 62 ||
    schema4.foreign_key_requirements.length !== 12 ||
    schema4.unique_key_requirements.length !== 7 ||
    schema4.query_intents.length !== 8
  ) {
    throw new Error('G3.8A Schema 4 handoff cardinality drifted');
  }
  const withoutHash = {
    format:
      'icarus.workflow-feature-release-activation-failure-replay-schema-prerequisite/1' as const,
    schema_id: 'workflow-runtime-schema-v1' as const,
    database_schema_version: 4 as const,
    delta_mode: 'rebuild_activation_relations' as const,
    contract_stage: 'g1_physical_schema_input' as const,
    historical_inputs: {
      schema3_activation_prerequisite_hash:
        ACTIVATION_SCHEMA_INPUT_ARTIFACT_HASH,
      identity_policy: 'preserve_schema3_as_upgrade_input' as const,
    },
    frozen_g3_8a_contract: {
      pack_hash: G38A_FROZEN_IDENTITIES.pack,
      repair_artifact_hash: G38A_FROZEN_IDENTITIES.artifact,
      internal_contract_hash: G38A_FROZEN_IDENTITIES.contract,
      column_requirement_count: 62 as const,
      foreign_key_requirement_count: 12 as const,
      unique_key_requirement_count: 7 as const,
    },
    column_requirements: structuredClone(schema4.column_requirements),
    foreign_key_requirements: structuredClone(schema4.foreign_key_requirements),
    unique_key_requirements: structuredClone(schema4.unique_key_requirements),
    relation_requirements: structuredClone(schema4.relation_changes),
    rebuilt_tables: buildRebuiltTables(
      schema4.column_requirements,
      schema4.foreign_key_requirements,
      schema4.unique_key_requirements,
    ),
    replaced_query_ids: QUERY_INTENTS.map((entry) => entry.query_id),
    query_intents: structuredClone(QUERY_INTENTS),
    trigger_intents: [
      'pending insert accepts only caller key schema-bound request domain hash and empty verified/terminal shape',
      'pending verified facts populate null-to-exact in legal prefix order with adjacent row_version',
      'pending-to-applied validates complete target previous compatibility Retention pointer and applied-only receipt facts',
      'pending-to-failed or conflict requires terminal result Invocation binding without receipt or pointer mutation',
      'canonical terminal header binds immutable Invocation through deferred composite FK',
      'Invocation result and terminal reference mappings are closed and append-only',
      'terminal exact-request replay permits duplicate only while same-key domain drift remains conflict',
      'Event verified Release groups are nullable command-bound and append-only',
      'G1.5 Release active-pointer and Retention protection triggers remain byte-equivalent',
    ],
    constraint_fixture_cases: [
      'g3_8a_exact_62_columns_12_foreign_keys_7_unique_keys',
      'activation_insert_request_only_pending_shape',
      'activation_verified_prefix_no_holes_or_fabrication',
      'activation_owner_lifecycle_resource_g3_6_retention_failures_are_schema_valid',
      'activation_applied_only_receipt_and_terminal_binding',
      'activation_failed_conflict_null_receipt_and_no_pointer_facts',
      'activation_duplicate_references_header_terminal_result',
      'activation_domain_drift_conflict_never_terminalizes_header',
      'activation_invocation_event_adjacency_immutability_and_tamper_rejection',
      'activation_terminal_result_lookup_and_pending_recovery_query_plans',
      'schema3_empty_upgrade_success',
      'schema3_nonempty_activation_or_pointer_upgrade_fail_closed',
    ],
    schema3_upgrade_mode: 'empty_activation_state_only_or_fail_closed' as const,
    schema3_required_empty_relations: [
      'workflow_feature_release_activation_commands',
      'workflow_feature_release_activation_invocations',
      'workflow_feature_release_activation_events',
      'workflow_feature_active_releases',
    ],
    forbidden_implementation_surfaces: [
      'feature_release_activation_service_or_business_dml',
      'active_pointer_business_mutation',
      'production_loader',
      'retention_gc_or_delete_executor',
      'execution_artifact_build_or_install',
      'workflow_runtime_capacity_or_publisher_command_union_reuse',
      'g4_through_g9_runtime',
    ],
  };
  return {
    ...withoutHash,
    delta_hash: domainSeparatedSha256(
      ACTIVATION_REPAIR_SCHEMA_DELTA_DOMAIN,
      withoutHash as unknown as JsonValue,
    ),
  } as unknown as ActivationRepairSchemaPrerequisitePayload;
}

export function buildActivationRepairSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format:
      'icarus.workflow-feature-release-activation-failure-replay-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-feature-release-activation-failure-replay-schema-prerequisite',
      version: '1',
    },
    version: 1,
    domain_separator: ACTIVATION_REPAIR_SCHEMA_INPUT_DOMAIN,
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    payload:
      buildActivationRepairSchemaPrerequisitePayload() as unknown as JsonObject,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

export const ACTIVATION_REPAIR_SCHEMA_INPUT_ARTIFACT_HASH =
  buildActivationRepairSchemaPrerequisiteArtifact().hash;

export function parseActivationRepairSchemaPrerequisiteArtifact(
  artifact: ContractArtifactEnvelope,
): ActivationRepairSchemaPrerequisitePayload {
  const expected = buildActivationRepairSchemaPrerequisiteArtifact();
  if (
    artifact.format !== expected.format ||
    artifact.ref.id !== expected.ref.id ||
    artifact.ref.version !== expected.ref.version ||
    artifact.version !== expected.version ||
    artifact.domain_separator !== expected.domain_separator ||
    artifact.hash !== expected.hash ||
    calculateArtifactHash(artifact) !== artifact.hash ||
    canonicalJson(artifact.payload) !== canonicalJson(expected.payload)
  ) {
    throw new Error(
      'Activation Failure / Replay Schema Prerequisite identity drifted',
    );
  }
  return artifact.payload as unknown as ActivationRepairSchemaPrerequisitePayload;
}
