import { calculateArtifactHash } from '../../contracts/hash.js';
import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
} from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
} from '../../contracts/types.js';

export const RUNTIME_COMMAND_INGRESS_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-runtime-command-ingress-schema-prerequisite@1.json';
export const RUNTIME_COMMAND_INGRESS_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-runtime-command-ingress-schema-prerequisite:1\n';

const INGRESS = 'workflow_runtime_command_ingress_invocations';
const INVOCATIONS = 'workflow_runtime_command_invocations';

const COMMAND_TYPES = [
  'pause_run',
  'resume_run',
  'cancel_run',
  'cancel_workflow',
  'skip_node',
  'advance_retry_schedule',
  'reconcile_effect',
  'submit_effect_receipt',
  'verify_effect_not_applied',
  'remediate_operational_blocker',
  'restore_integrity',
  'request_administrative_abandon',
  'confirm_administrative_abandon',
] as const;

const TARGET_KINDS = [
  'workflow',
  'run',
  'node',
  'retry_schedule',
  'effect_operation',
  'operational_blocker',
] as const;

const DENIAL_CODES = [
  'permission_denied',
  'feature_ceiling_denied',
  'command_policy_denied',
  'state_guard_failed',
  'target_not_found',
  'target_kind_invalid',
  'row_version_conflict',
  'evidence_invalid',
  'confirmation_required',
  'idempotency_conflict',
  'late_command',
] as const;

function column(
  ordinal: number,
  name: string,
  logicalType: LogicalColumnMetadata['logical_type'],
  nullable = false,
  enumValues: readonly string[] = [],
  safeIntegerIntent: LogicalColumnMetadata['safe_integer_intent'] =
    logicalType === 'integer' ? 'non_negative' : 'not_applicable',
  externalReference: LogicalColumnMetadata['external_reference'] = null,
): LogicalColumnMetadata {
  return {
    ordinal,
    name,
    logical_type: logicalType,
    sqlite_type_intent: logicalType === 'integer' ? 'INTEGER' : 'TEXT',
    nullable,
    default_intent: null,
    safe_integer_intent: safeIntegerIntent,
    enum_values: [...enumValues],
    relation_ids: [],
    external_reference: externalReference,
  };
}

function externalColumn(
  ordinal: number,
  name: string,
  validatorOwner: string,
  referenceDomain: string,
  nullable = false,
): LogicalColumnMetadata {
  return column(
    ordinal,
    name,
    'external_reference',
    nullable,
    [],
    'not_applicable',
    {
      validator_owner: validatorOwner,
      reference_domain: referenceDomain,
      immutable: true,
    },
  );
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

function uniqueKey(
  keyId: string,
  columns: string[],
): LogicalUniqueKeyMetadata {
  return { key_id: keyId, columns, predicate_intent: null };
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

function attachRelationIds(table: LogicalTableMetadata): LogicalTableMetadata {
  for (const relation of table.foreign_keys) {
    for (const source of relation.source_columns) {
      const target = table.columns.find((candidate) => candidate.name === source);
      if (!target) throw new Error(`Schema 11 relation column is absent: ${source}`);
      target.relation_ids.push(relation.relation_id);
    }
  }
  return table;
}

function buildIngressTable(ordinal: number): LogicalTableMetadata {
  const claimedTargetColumns = TARGET_KINDS.map((kind) => `claimed_${kind}_id`);
  const columns: LogicalColumnMetadata[] = [
    column(1, 'id', 'identifier'),
    column(2, 'idempotency_domain', 'text'),
    column(3, 'idempotency_key', 'text'),
    column(4, 'ingress_no', 'integer', false, [], 'positive'),
    column(5, 'submitted_command_id', 'identifier'),
    column(6, 'canonical_request_json', 'canonical_json'),
    column(7, 'submitted_request_hash', 'hash'),
    column(8, 'command_type', 'text', false, COMMAND_TYPES),
    column(9, 'claimed_target_kind', 'text', false, TARGET_KINDS),
    ...claimedTargetColumns.map((name, indexValue) =>
      column(10 + indexValue, name, 'identifier', true),
    ),
    externalColumn(16, 'actor_ref', 'command_actor_registry', 'command_actor'),
    column(17, 'actor_kind', 'text', false, [
      'human',
      'feature_service',
      'automation',
      'system',
    ]),
    externalColumn(
      18,
      'auth_session_ref',
      'authentication_session_registry',
      'auth_session',
    ),
    column(19, 'entrypoint', 'text', false, [
      'runtime_center',
      'feature_page',
      'feature_host_api',
      'external_api',
      'automation',
      'card_action',
      'deadline_watchdog',
    ]),
    externalColumn(20, 'source_feature_id', 'feature_registry', 'feature', true),
    externalColumn(
      21,
      'delegation_chain_ref',
      'delegation_authorization_registry',
      'delegation_chain',
      true,
    ),
    column(22, 'resolution_result', 'text', false, [
      'prepared',
      'resolved',
      'target_not_found',
      'target_kind_invalid',
    ]),
    column(23, 'authorization_result', 'text', false, [
      'pending',
      'not_evaluated',
      'allowed',
      'denied',
    ]),
    column(24, 'execution_result', 'text', false, [
      'prepared',
      'applied',
      'denied',
      'conflict',
      'duplicate',
      'late',
    ]),
    column(25, 'denial_code', 'text', true, DENIAL_CODES),
    column(26, 'canonical_result_json', 'canonical_json', true),
    column(27, 'canonical_result_hash', 'hash', true),
    column(28, 'resolved_command_id', 'identifier', true),
    column(29, 'resolved_invocation_id', 'identifier', true),
    column(30, 'requested_at_ms', 'integer'),
    column(31, 'decided_at_ms', 'integer', true),
    column(32, 'applied_at_ms', 'integer', true),
  ];
  const table: LogicalTableMetadata = {
    ordinal,
    name: INGRESS,
    source_section: 'G7 authenticated Runtime Command ingress audit',
    columns,
    primary_key: { columns: ['id'], auto_increment_intent: false },
    foreign_keys: [
      foreignKey(
        'fk:command_ingress:resolved_invocation',
        ['resolved_command_id', 'resolved_invocation_id'],
        INVOCATIONS,
        ['command_id', 'id'],
      ),
    ],
    unique_keys: [
      uniqueKey('uk:command_ingress:domain_number', [
        'idempotency_domain',
        'idempotency_key',
        'ingress_no',
      ]),
      uniqueKey('uk:command_ingress:resolved_invocation', [
        'resolved_command_id',
        'resolved_invocation_id',
      ]),
    ],
    checks: [
      check(
        'ck:workflow_runtime_command_ingress_invocations:ingress_no:safe_integer',
        'safe_integer',
        ['ingress_no'],
        'positive JavaScript safe integer',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:submitted_request_hash:hash',
        'hash_format',
        ['submitted_request_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:command_type:enum',
        'enum_membership',
        ['command_type'],
        'value belongs to the closed command_type catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:claimed_target_kind:enum',
        'enum_membership',
        ['claimed_target_kind'],
        'value belongs to the closed claimed target catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:actor_kind:enum',
        'enum_membership',
        ['actor_kind'],
        'value belongs to the closed actor_kind catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:entrypoint:enum',
        'enum_membership',
        ['entrypoint'],
        'value belongs to the closed Runtime Command entrypoint catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:resolution_result:enum',
        'enum_membership',
        ['resolution_result'],
        'value belongs to the closed resolution result catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:authorization_result:enum',
        'enum_membership',
        ['authorization_result'],
        'value belongs to the closed authorization result catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:execution_result:enum',
        'enum_membership',
        ['execution_result'],
        'value belongs to the closed execution result catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:denial_code:enum',
        'enum_membership',
        ['denial_code'],
        'nullable value belongs to the closed denial code catalog',
      ),
      check(
        'ck:workflow_runtime_command_ingress_invocations:canonical_result_hash:hash',
        'hash_format',
        ['canonical_result_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      ...['requested_at_ms', 'decided_at_ms', 'applied_at_ms'].map((name) =>
        check(
          `ck:workflow_runtime_command_ingress_invocations:${name}:safe_integer`,
          'safe_integer',
          [name],
          'non-negative JavaScript safe integer',
        ),
      ),
      check(
        'ck:command_ingress:claimed_target_exactly_one',
        'exactly_one',
        claimedTargetColumns,
        'exactly one closed claimed typed target identifier is present',
      ),
      check(
        'ck:command_ingress:claimed_target_mapping',
        'closed_target_mapping',
        ['claimed_target_kind', ...claimedTargetColumns],
        'claimed target kind maps to exactly one same-kind typed identifier',
      ),
      check(
        'ck:command_ingress:canonical_request_json',
        'state_field_consistency',
        ['canonical_request_json'],
        'canonical request is valid JSON',
      ),
      check(
        'ck:command_ingress:canonical_result_pair',
        'all_or_none',
        ['canonical_result_json', 'canonical_result_hash'],
        'canonical result JSON and hash appear together',
      ),
      check(
        'ck:command_ingress:resolved_pair',
        'all_or_none',
        ['resolved_command_id', 'resolved_invocation_id'],
        'resolved Command and Invocation identity appear together',
      ),
      check(
        'ck:command_ingress:terminal_shape',
        'state_field_consistency',
        [
          'resolution_result',
          'authorization_result',
          'execution_result',
          'denial_code',
          'canonical_result_json',
          'resolved_command_id',
          'decided_at_ms',
          'applied_at_ms',
        ],
        'prepared is incomplete; unresolved denial has no resolved identity; resolved terminal disposition has exact resolved identity',
      ),
      check(
        'ck:command_ingress:chronology',
        'ordered_values',
        ['requested_at_ms', 'decided_at_ms', 'applied_at_ms'],
        'terminal decision is not before request and applied time lies within the decision interval',
      ),
    ],
    indexes: [
      index(
        'idx:command_ingress:idempotency_history',
        ['idempotency_domain', 'idempotency_key', 'ingress_no'],
        ['query:command_ingress_idempotency_history'],
      ),
      index('idx:command_ingress:submitted_command', ['submitted_command_id']),
    ],
  };
  return attachRelationIds(table);
}

const INGRESS_QUERY: LogicalQueryIntent = {
  query_id: 'query:command_ingress_idempotency_history',
  owner: 'command_gateway',
  purpose: 'load immutable authenticated ingress history for one trusted idempotency domain and key',
  table: INGRESS,
  join_tables: [],
  equality_columns: ['idempotency_domain', 'idempotency_key'],
  range_columns: [],
  state_predicate_intent: null,
  order_by: [{ column: 'ingress_no', direction: 'asc' }],
  result_cardinality: 'many',
  required_index_id: 'idx:command_ingress:idempotency_history',
  execution_status: 'intent_only',
};

function applySchema11(
  schema10Tables: LogicalTableMetadata[],
  schema10Queries: LogicalQueryIntent[],
): { tables: LogicalTableMetadata[]; queries: LogicalQueryIntent[] } {
  const tables = structuredClone(schema10Tables);
  const invocations = tables.find((table) => table.name === INVOCATIONS);
  if (!invocations) throw new Error('Schema 10 Runtime Command Invocation is absent');
  if (
    invocations.unique_keys.some(
      (key) => key.key_id === 'uk:command_invocations:command_id',
    )
  ) {
    throw new Error('Schema 11 Runtime Command Invocation candidate key already exists');
  }
  invocations.unique_keys.push(
    uniqueKey('uk:command_invocations:command_id', ['command_id', 'id']),
  );
  tables.push(buildIngressTable(tables.length + 1));
  return {
    tables,
    queries: [...structuredClone(schema10Queries), structuredClone(INGRESS_QUERY)],
  };
}

export function buildRuntimeCommandIngressSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const payload: JsonObject = {
    format: 'icarus.workflow-runtime-command-ingress-schema-prerequisite/1',
    decision_id: 'G7_MISSING_TARGET_AUDIT',
    schema_id: 'workflow-runtime-schema-v1',
    database_schema_version: 11,
    predecessor_database_schema_version: 10,
    delta_mode: 'additive_ingress_audit_and_candidate_key',
    audit_model: {
      authenticated_ingress: 'one prepared then terminal immutable row per authenticated invocation',
      claimed_target: 'closed exactly-one typed identifier without target foreign key',
      resolved_target: 'exact composite foreign key to resolved Command Invocation',
      unresolved_target: 'terminal denied ingress row without fabricated Command Header',
      transaction: 'resolved ingress Header Invocation Event and mutation commit or roll back together',
      replay: 'every exact replay drift late denial and applied call appends ingress history',
      header: 'immutable request identity with exactly-once canonical result finalization',
      resolved_invocation: 'append-only target-verified authorization and execution audit',
    },
    affected_tables: [
      INGRESS,
      'workflow_runtime_commands',
      INVOCATIONS,
      'workflow_runtime_command_confirmations',
    ],
    added_table_count: 1,
    added_candidate_keys: ['uk:command_invocations:command_id'],
    query_intents: [structuredClone(INGRESS_QUERY) as LogicalQueryIntent & JsonObject],
    historical_contract: {
      schema_10_and_earlier_artifacts: 'byte_immutable',
      upgrade: 'single_transaction_additive_or_full_rollback',
      claimed_identifier_foreign_keys: 'forbidden',
      opaque_or_fabricated_target: 'forbidden',
    },
  };
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-runtime-command-ingress-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-runtime-command-ingress-schema-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: RUNTIME_COMMAND_INGRESS_SCHEMA_INPUT_DOMAIN,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

export function applyRuntimeCommandIngressSchemaPrerequisite(
  schema10Tables: LogicalTableMetadata[],
  schema10Queries: LogicalQueryIntent[],
  artifact: ContractArtifactEnvelope,
): { tables: LogicalTableMetadata[]; queries: LogicalQueryIntent[] } {
  const expected = buildRuntimeCommandIngressSchemaPrerequisiteArtifact();
  if (artifact.format !== expected.format || artifact.hash !== expected.hash) {
    throw new Error('G7 Runtime Command ingress prerequisite drifted');
  }
  return applySchema11(schema10Tables, schema10Queries);
}
