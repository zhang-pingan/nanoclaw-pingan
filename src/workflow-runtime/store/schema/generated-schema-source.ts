import {
  calculateArtifactHash,
  domainSeparatedSha256,
} from '../../contracts/hash.js';
import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
} from '../../contracts/logical-schema-types.js';
import { LOGICAL_SCHEMA_TABLES } from '../../contracts/logical-schema-source.js';
import {
  GENERATED_SCHEMA_DOMAIN,
  GENERATED_SCHEMA_PARAMETER_DOMAIN,
  GENERATED_SCHEMA_PLAN_BINDING_DOMAIN,
} from '../../contracts/generated-schema-authority.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../../contracts/types.js';

export const GENERATED_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-generated-schema-authority-prerequisite@1.json';
export const GENERATED_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-generated-schema-authority-prerequisite:1\n';
export const GENERATED_SCHEMA_DELTA_DOMAIN =
  'icarus:workflow-generated-schema-authority-logical-schema-delta:1\n';

interface GeneratedSchemaValueRebuild extends JsonObject {
  table_name: 'workflow_values';
  base_table_hash: Sha256Hash;
  nullable_columns: ['schema_resource_id', 'schema_resource_hash'];
  added_columns: LogicalColumnMetadata[] & JsonObject[];
  added_foreign_keys: LogicalForeignKeyMetadata[] & JsonObject[];
  added_checks: LogicalCheckMetadata[] & JsonObject[];
}

export interface GeneratedSchemaPrerequisitePayload extends JsonObject {
  format: 'icarus.workflow-generated-schema-authority-prerequisite/1';
  schema_id: 'workflow-runtime-schema-v1';
  database_schema_version: 6;
  delta_mode: 'additive_tables_plus_workflow_values_authority_rebuild';
  generated_schema_contract: {
    schema_ref_scheme: 'icarus-generated-schema';
    schema_ref_pattern: '^icarus-generated-schema:sha256:[0-9a-f]{64}$';
    canonical_schema_bytes: 'UTF-8(RFC8785-JCS(schema_json))';
    raw_hash: 'SHA-256(canonical_schema_bytes)';
    schema_hash_domain: typeof GENERATED_SCHEMA_DOMAIN;
    parameter_hash_domain: typeof GENERATED_SCHEMA_PARAMETER_DOMAIN;
    plan_binding_hash_domain: typeof GENERATED_SCHEMA_PLAN_BINDING_DOMAIN;
    plan_binding: 'exact_plan_hash_and_generated_schema_tuple';
    resolver: 'persisted_schema_content_exact_ref_only';
    latest_lookup: 'forbidden';
    schema_json_schema_ref_rule: 'both_required_and_equivalent';
  } & JsonObject;
  historical_capacity_rebind: {
    current_logical_schema_manifest_hash: Sha256Hash;
    logical_schema_source_hash: Sha256Hash;
    historical_capacity_delta_artifact_hash: Sha256Hash;
    historical_capacity_delta_hash: Sha256Hash;
    historical_base_logical_schema_manifest_hash: Sha256Hash;
    compatibility_rule: 'identical_logical_source_semantics_only';
  } & JsonObject;
  added_tables: LogicalTableMetadata[] & JsonObject[];
  workflow_values_rebuild: GeneratedSchemaValueRebuild;
  query_intents: LogicalQueryIntent[] & JsonObject[];
  constraint_fixture_cases: string[] & JsonValue[];
  delta_hash: Sha256Hash;
}

function column(
  name: string,
  logicalType: LogicalColumnMetadata['logical_type'],
  sqliteType: LogicalColumnMetadata['sqlite_type_intent'],
  nullable = false,
  safeInteger: LogicalColumnMetadata['safe_integer_intent'] = 'not_applicable',
  enumValues: string[] = [],
  defaultIntent: JsonValue = null,
  relationIds: string[] = [],
): LogicalColumnMetadata {
  return {
    ordinal: 0,
    name,
    logical_type: logicalType,
    sqlite_type_intent: sqliteType,
    nullable,
    default_intent: defaultIntent,
    safe_integer_intent: safeInteger,
    enum_values: enumValues,
    relation_ids: relationIds,
    external_reference: null,
  };
}

const id = (name: string, nullable = false, relations: string[] = []) =>
  column(
    name,
    'identifier',
    'TEXT',
    nullable,
    'not_applicable',
    [],
    null,
    relations,
  );
const text = (
  name: string,
  nullable = false,
  values: string[] = [],
  defaultIntent: JsonValue = null,
) =>
  column(
    name,
    'text',
    'TEXT',
    nullable,
    'not_applicable',
    values,
    defaultIntent,
  );
const hash = (name: string, nullable = false, relations: string[] = []) =>
  column(name, 'hash', 'TEXT', nullable, 'not_applicable', [], null, relations);
const integer = (name: string) =>
  column(name, 'integer', 'INTEGER', false, 'non_negative');
const canonicalJson = (name: string) => column(name, 'canonical_json', 'TEXT');

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
  columns: string[],
  supports: string[],
): LogicalIndexMetadata {
  return {
    index_id: indexId,
    kind: 'lookup',
    columns,
    predicate_intent: null,
    supports_query_ids: supports,
  };
}

function table(
  ordinal: number,
  name: string,
  columns: LogicalColumnMetadata[],
  primaryKey: string[],
  foreignKeys: LogicalForeignKeyMetadata[],
  uniqueKeys: LogicalUniqueKeyMetadata[],
  checks: LogicalCheckMetadata[],
  indexes: LogicalIndexMetadata[],
): LogicalTableMetadata {
  return {
    ordinal,
    name,
    source_section: 'Generated Schema Content and Plan Binding Authority',
    columns: columns.map((entry, indexValue) => ({
      ...entry,
      ordinal: indexValue + 1,
    })),
    primary_key: { columns: primaryKey, auto_increment_intent: false },
    foreign_keys: foreignKeys,
    unique_keys: uniqueKeys,
    checks,
    indexes,
  };
}

function generatedSchemaTables(): LogicalTableMetadata[] {
  const schemaRefColumn: LogicalColumnMetadata = {
    ...id('schema_ref'),
    logical_type: 'external_reference',
    external_reference: {
      validator_owner: 'generated_schema_ref_validator',
      reference_domain: 'icarus_generated_schema_content_address',
      immutable: true,
    },
  };
  const contents = table(
    85,
    'workflow_generated_schema_contents',
    [
      schemaRefColumn,
      hash('schema_raw_hash'),
      hash('schema_hash'),
      canonicalJson('canonical_schema_json'),
      text('canonicalizer', false, ['RFC8785-JCS']),
      integer('byte_length'),
      integer('created_at_ms'),
    ],
    ['schema_ref'],
    [],
    [
      uk('uk:generated_schema_contents:ref_hash', [
        'schema_ref',
        'schema_hash',
      ]),
    ],
    [
      check(
        'ck:generated_schema_contents:ref',
        'state_field_consistency',
        ['schema_ref', 'schema_raw_hash'],
        'schema_ref is the exact icarus-generated-schema form of schema_raw_hash',
      ),
      check(
        'ck:generated_schema_contents:raw_hash:hash',
        'hash_format',
        ['schema_raw_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:generated_schema_contents:schema_hash:hash',
        'hash_format',
        ['schema_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:generated_schema_contents:canonicalizer:enum',
        'enum_membership',
        ['canonicalizer'],
        'value belongs to the closed canonicalizer catalog',
      ),
      check(
        'ck:generated_schema_contents:byte_length:safe_integer',
        'safe_integer',
        ['byte_length'],
        'non-negative JavaScript safe integer',
      ),
      check(
        'ck:generated_schema_contents:created_at_ms:safe_integer',
        'safe_integer',
        ['created_at_ms'],
        'non-negative JavaScript safe integer',
      ),
    ],
    [],
  );
  const queryId = 'reconciler_resolve_plan_generated_schema';
  const bindings = table(
    86,
    'workflow_plan_generated_schemas',
    [
      id('plan_id', false, ['fk:plan_generated_schemas:plan']),
      id('graph_run_id', false, ['fk:plan_generated_schemas:plan']),
      hash('plan_hash', false, ['fk:plan_generated_schemas:plan']),
      id('schema_ref', false, ['fk:plan_generated_schemas:content']),
      hash('schema_hash', false, ['fk:plan_generated_schemas:content']),
      text('generator', false, [
        'join_expose',
        'child_completion',
        'map_result',
      ]),
      hash('parameter_hash'),
      hash('binding_hash'),
      integer('created_at_ms'),
    ],
    ['plan_id', 'schema_ref', 'generator', 'parameter_hash'],
    [
      fk(
        'fk:plan_generated_schemas:plan',
        ['plan_id', 'graph_run_id', 'plan_hash'],
        'workflow_graph_scope_plans',
        ['id', 'graph_run_id', 'plan_hash'],
      ),
      fk(
        'fk:plan_generated_schemas:content',
        ['schema_ref', 'schema_hash'],
        'workflow_generated_schema_contents',
        ['schema_ref', 'schema_hash'],
      ),
    ],
    [
      uk('uk:plan_generated_schemas:value_authority', [
        'plan_id',
        'plan_hash',
        'schema_ref',
        'schema_hash',
        'generator',
        'parameter_hash',
      ]),
    ],
    [
      check(
        'ck:plan_generated_schemas:plan_hash:hash',
        'hash_format',
        ['plan_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:plan_generated_schemas:schema_hash:hash',
        'hash_format',
        ['schema_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:plan_generated_schemas:parameter_hash:hash',
        'hash_format',
        ['parameter_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:plan_generated_schemas:binding_hash:hash',
        'hash_format',
        ['binding_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:plan_generated_schemas:generator:enum',
        'enum_membership',
        ['generator'],
        'value belongs to the closed generator catalog',
      ),
      check(
        'ck:plan_generated_schemas:created_at_ms:safe_integer',
        'safe_integer',
        ['created_at_ms'],
        'non-negative JavaScript safe integer',
      ),
    ],
    [
      index(
        'idx:plan_generated_schemas:resolve',
        ['plan_id', 'schema_ref'],
        [queryId],
      ),
    ],
  );
  return [contents, bindings];
}

function valueAuthorityRebuild(
  schema5ValueTable: LogicalTableMetadata,
): GeneratedSchemaValueRebuild {
  const relation = 'fk:values:plan_generated_schema';
  const addedColumns = [
    text(
      'schema_authority_kind',
      false,
      ['registry', 'plan_generated'],
      'registry',
    ),
    id('schema_plan_id', true, [relation]),
    hash('schema_plan_hash', true, [relation]),
    id('generated_schema_ref', true, [relation]),
    hash('generated_schema_hash', true, [relation]),
    text('generated_schema_generator', true, [
      'join_expose',
      'child_completion',
      'map_result',
    ]),
    hash('generated_schema_parameter_hash', true, [relation]),
  ].map((entry, indexValue) => ({
    ...entry,
    ordinal: schema5ValueTable.columns.length + indexValue + 1,
  }));
  return {
    table_name: 'workflow_values',
    base_table_hash: domainSeparatedSha256(
      'icarus:workflow-generated-schema-authority-base-values-table:1\n',
      schema5ValueTable as unknown as JsonValue,
    ),
    nullable_columns: ['schema_resource_id', 'schema_resource_hash'],
    added_columns: addedColumns as JsonObject[] & LogicalColumnMetadata[],
    added_foreign_keys: [
      fk(
        relation,
        [
          'schema_plan_id',
          'schema_plan_hash',
          'generated_schema_ref',
          'generated_schema_hash',
          'generated_schema_generator',
          'generated_schema_parameter_hash',
        ],
        'workflow_plan_generated_schemas',
        [
          'plan_id',
          'plan_hash',
          'schema_ref',
          'schema_hash',
          'generator',
          'parameter_hash',
        ],
      ),
    ] as JsonObject[] & LogicalForeignKeyMetadata[],
    added_checks: [
      check(
        'ck:workflow_values:schema_authority_kind:enum',
        'enum_membership',
        ['schema_authority_kind'],
        'value belongs to the closed schema_authority_kind catalog',
      ),
      check(
        'ck:workflow_values:generated_schema_generator:enum',
        'enum_membership',
        ['generated_schema_generator'],
        'null or value belongs to the closed generated schema generator catalog',
      ),
      check(
        'ck:values:schema_authority_shape',
        'state_field_consistency',
        [
          'schema_authority_kind',
          'schema_resource_id',
          'schema_resource_hash',
          'schema_plan_id',
          'schema_plan_hash',
          'generated_schema_ref',
          'generated_schema_hash',
          'generated_schema_generator',
          'generated_schema_parameter_hash',
        ],
        'registry and plan_generated authority tuples are mutually exclusive and complete',
      ),
      check(
        'ck:workflow_values:schema_plan_hash:hash',
        'hash_format',
        ['schema_plan_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:workflow_values:generated_schema_hash:hash',
        'hash_format',
        ['generated_schema_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
      check(
        'ck:workflow_values:generated_schema_parameter_hash:hash',
        'hash_format',
        ['generated_schema_parameter_hash'],
        'sha256:<64 lowercase hexadecimal characters>',
      ),
    ] as JsonObject[] & LogicalCheckMetadata[],
  };
}

function schema5WorkflowValuesTable(): LogicalTableMetadata {
  const historical = LOGICAL_SCHEMA_TABLES.find(
    (tableValue) => tableValue.name === 'workflow_values',
  );
  if (!historical)
    throw new Error('Historical workflow_values table is absent');
  return {
    ...structuredClone(historical),
    unique_keys: [
      ...structuredClone(historical.unique_keys),
      uk('uk:values:id_hash_schema', [
        'id',
        'content_hash',
        'schema_resource_id',
        'schema_resource_hash',
      ]),
    ],
  };
}

export function buildGeneratedSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const queryId = 'reconciler_resolve_plan_generated_schema';
  const withoutHash = {
    format:
      'icarus.workflow-generated-schema-authority-prerequisite/1' as const,
    schema_id: 'workflow-runtime-schema-v1' as const,
    database_schema_version: 6 as const,
    delta_mode:
      'additive_tables_plus_workflow_values_authority_rebuild' as const,
    generated_schema_contract: {
      schema_ref_scheme: 'icarus-generated-schema' as const,
      schema_ref_pattern:
        '^icarus-generated-schema:sha256:[0-9a-f]{64}$' as const,
      canonical_schema_bytes: 'UTF-8(RFC8785-JCS(schema_json))' as const,
      raw_hash: 'SHA-256(canonical_schema_bytes)' as const,
      schema_hash_domain: GENERATED_SCHEMA_DOMAIN,
      parameter_hash_domain: GENERATED_SCHEMA_PARAMETER_DOMAIN,
      plan_binding_hash_domain: GENERATED_SCHEMA_PLAN_BINDING_DOMAIN,
      plan_binding: 'exact_plan_hash_and_generated_schema_tuple' as const,
      resolver: 'persisted_schema_content_exact_ref_only' as const,
      latest_lookup: 'forbidden' as const,
      schema_json_schema_ref_rule: 'both_required_and_equivalent' as const,
    },
    historical_capacity_rebind: {
      current_logical_schema_manifest_hash:
        'sha256:e0b1bb30303e9bf0c45fdc5383ec7f61f90b2bb2e6ed8e422c5478a1dfd134cc' as const,
      logical_schema_source_hash:
        'sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214' as const,
      historical_capacity_delta_artifact_hash:
        'sha256:b15daf99f68f8447aff1da5a9411460497ae29e7067a3802ac588d790066fe30' as const,
      historical_capacity_delta_hash:
        'sha256:ca81abe11e332890bde7420fdf8f040856e8076bba9bbc4a03d15ffedb439e3a' as const,
      historical_base_logical_schema_manifest_hash:
        'sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520' as const,
      compatibility_rule: 'identical_logical_source_semantics_only' as const,
    },
    added_tables: generatedSchemaTables(),
    workflow_values_rebuild: valueAuthorityRebuild(
      schema5WorkflowValuesTable(),
    ),
    query_intents: [
      {
        query_id: queryId,
        owner: 'reconciler',
        purpose:
          'Resolve one Plan-local generated schema by exact persisted Plan and content-addressed ref',
        table: 'workflow_plan_generated_schemas',
        join_tables: ['workflow_generated_schema_contents'],
        equality_columns: ['plan_id', 'schema_ref'],
        range_columns: [],
        state_predicate_intent: null,
        order_by: [],
        result_cardinality: 'zero_or_one',
        required_index_id: 'idx:plan_generated_schemas:resolve',
        execution_status: 'intent_only',
      },
    ],
    constraint_fixture_cases: [
      'generated_schema_ref_content_hash_equivalence',
      'generated_schema_unknown_scheme_rejected',
      'plan_generated_schema_exact_plan_fk',
      'workflow_value_registry_authority',
      'workflow_value_plan_generated_authority',
      'workflow_value_mixed_or_incomplete_authority_rejected',
    ],
  };
  const payload: GeneratedSchemaPrerequisitePayload = {
    ...withoutHash,
    delta_hash: domainSeparatedSha256(
      GENERATED_SCHEMA_DELTA_DOMAIN,
      withoutHash as unknown as JsonValue,
    ),
  } as unknown as GeneratedSchemaPrerequisitePayload;
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-generated-schema-authority-prerequisite/1',
    ref: {
      id: 'icarus.workflow-generated-schema-authority-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: GENERATED_SCHEMA_INPUT_DOMAIN,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

export function applyGeneratedSchemaPrerequisite(
  schema5Tables: LogicalTableMetadata[],
  artifact: ContractArtifactEnvelope,
): { tables: LogicalTableMetadata[]; queries: LogicalQueryIntent[] } {
  const payload =
    artifact.payload as unknown as GeneratedSchemaPrerequisitePayload;
  const values = schema5Tables.find(
    (tableValue) => tableValue.name === 'workflow_values',
  );
  if (!values) throw new Error('Schema 5 workflow_values table is absent');
  const expected = buildGeneratedSchemaPrerequisiteArtifact();
  const baseHash = domainSeparatedSha256(
    'icarus:workflow-generated-schema-authority-base-values-table:1\n',
    values as unknown as JsonValue,
  );
  if (
    artifact.format !== expected.format ||
    artifact.hash !== expected.hash ||
    payload.delta_hash !== expected.payload.delta_hash ||
    payload.workflow_values_rebuild.base_table_hash !== baseHash
  ) {
    throw new Error('Generated Schema prerequisite identity drifted');
  }
  const rebuild = payload.workflow_values_rebuild;
  const nullable = new Set<string>(rebuild.nullable_columns);
  const rebuiltValues: LogicalTableMetadata = {
    ...values,
    columns: [
      ...values.columns.map((entry) =>
        nullable.has(entry.name) ? { ...entry, nullable: true } : entry,
      ),
      ...structuredClone(rebuild.added_columns),
    ],
    foreign_keys: [
      ...values.foreign_keys,
      ...structuredClone(rebuild.added_foreign_keys),
    ],
    checks: [...values.checks, ...structuredClone(rebuild.added_checks)],
  };
  return {
    tables: [
      ...schema5Tables.map((entry) =>
        entry.name === rebuiltValues.name ? rebuiltValues : entry,
      ),
      ...structuredClone(payload.added_tables),
    ],
    queries: structuredClone(payload.query_intents),
  };
}
