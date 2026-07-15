import { calculateArtifactHash } from './hash.js';
import {
  FOREIGN_KEY_ACTIONS,
  FOREIGN_KEY_DEFERRABILITY,
  INDEX_INTENT_KINDS,
  LOGICAL_CHECK_KINDS,
  LOGICAL_COLUMN_TYPES,
  QUERY_OWNERS,
  SAFE_INTEGER_INTENTS,
  SQLITE_TYPE_INTENTS,
} from './logical-schema-types.js';
import {
  buildLogicalQueryCatalogPayload,
  buildLogicalSchemaSourcePayload,
  buildTypedRelationCatalogPayload,
} from './logical-schema-source.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$';
const SQL_IDENTIFIER_PATTERN = '^[a-z][a-z0-9_]*$';
const CONTRACT_ID_PATTERN = '^[a-z][a-z0-9_.:-]*$';

type Schema = JsonObject;

export interface LogicalSchemaArtifactDescriptor {
  artifact_path: string;
  artifact_format: string;
  ref_id: string;
  domain_separator: string;
  artifact_kind: 'schema' | 'metadata';
  target_format: string | null;
}

export const LOGICAL_SCHEMA_ARTIFACT_DESCRIPTORS = [
  {
    artifact_path: 'sqlite/workflow-runtime-logical-schema-source-schema.json',
    artifact_format: 'icarus.workflow-runtime-logical-schema-source-schema/1',
    ref_id: 'icarus.workflow-runtime-logical-schema-source-schema',
    domain_separator:
      'icarus:workflow-runtime-logical-schema-source-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-runtime-logical-schema-source/1',
  },
  {
    artifact_path: 'sqlite/workflow-runtime-typed-relation-catalog-schema.json',
    artifact_format: 'icarus.workflow-runtime-typed-relation-catalog-schema/1',
    ref_id: 'icarus.workflow-runtime-typed-relation-catalog-schema',
    domain_separator:
      'icarus:workflow-runtime-typed-relation-catalog-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
  },
  {
    artifact_path: 'sqlite/workflow-runtime-query-catalog-schema.json',
    artifact_format: 'icarus.workflow-runtime-query-catalog-schema/1',
    ref_id: 'icarus.workflow-runtime-query-catalog-schema',
    domain_separator: 'icarus:workflow-runtime-query-catalog-schema:1\n',
    artifact_kind: 'schema',
    target_format: 'icarus.workflow-runtime-query-catalog/1',
  },
  {
    artifact_path: 'sqlite/workflow-runtime-logical-schema-source@1.json',
    artifact_format: 'icarus.workflow-runtime-logical-schema-source/1',
    ref_id: 'icarus.workflow-runtime-logical-schema-source',
    domain_separator: 'icarus:workflow-runtime-logical-schema-source:1\n',
    artifact_kind: 'metadata',
    target_format: null,
  },
  {
    artifact_path: 'sqlite/workflow-runtime-typed-relation-catalog@1.json',
    artifact_format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    ref_id: 'icarus.workflow-runtime-typed-relation-catalog',
    domain_separator: 'icarus:workflow-runtime-typed-relation-catalog:1\n',
    artifact_kind: 'metadata',
    target_format: null,
  },
  {
    artifact_path: 'sqlite/workflow-runtime-query-catalog@1.json',
    artifact_format: 'icarus.workflow-runtime-query-catalog/1',
    ref_id: 'icarus.workflow-runtime-query-catalog',
    domain_separator: 'icarus:workflow-runtime-query-catalog:1\n',
    artifact_kind: 'metadata',
    target_format: null,
  },
] as const satisfies readonly LogicalSchemaArtifactDescriptor[];

export const LOGICAL_SCHEMA_FORMAT_BY_TARGET = Object.fromEntries(
  LOGICAL_SCHEMA_ARTIFACT_DESCRIPTORS.filter(
    (descriptor) => descriptor.target_format !== null,
  ).map((descriptor) => [
    descriptor.target_format!,
    descriptor.artifact_format,
  ]),
) as Record<string, string>;

function stringSchema(options: JsonObject = {}): Schema {
  return { type: 'string', ...options };
}

function integerSchema(minimum = 0): Schema {
  return { type: 'integer', minimum, maximum: SAFE_INTEGER_MAX };
}

function array(items: Schema, options: JsonObject = {}): Schema {
  return { type: 'array', items, ...options };
}

function object(
  properties: Record<string, Schema>,
  optional: readonly string[] = [],
): Schema {
  const optionalSet = new Set(optional);
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optionalSet.has(key)),
    properties,
  };
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: 'null' }] };
}

function schemaDocument(
  id: string,
  title: string,
  root: Schema,
  defs: Record<string, Schema>,
): Schema {
  return {
    $schema: DRAFT_2020_12,
    $id: id,
    title,
    ...root,
    $defs: defs,
  };
}

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

const identifier = stringSchema({
  minLength: 1,
  maxLength: 255,
  pattern: SQL_IDENTIFIER_PATTERN,
});
const contractId = stringSchema({
  minLength: 1,
  maxLength: 255,
  pattern: CONTRACT_ID_PATTERN,
});
const hashSchema = stringSchema({ pattern: SHA256_PATTERN });

function commonDefs(): Record<string, Schema> {
  return {
    external_reference: object({
      validator_owner: contractId,
      reference_domain: contractId,
      immutable: { type: 'boolean' },
    }),
    column: object({
      ordinal: integerSchema(1),
      name: identifier,
      logical_type: { enum: [...LOGICAL_COLUMN_TYPES] },
      sqlite_type_intent: { enum: [...SQLITE_TYPE_INTENTS] },
      nullable: { type: 'boolean' },
      default_intent: { type: 'null' },
      safe_integer_intent: { enum: [...SAFE_INTEGER_INTENTS] },
      enum_values: array(stringSchema(), { uniqueItems: true }),
      relation_ids: array(contractId, { uniqueItems: true }),
      external_reference: nullable(ref('external_reference')),
    }),
    primary_key: object({
      columns: array(identifier, { minItems: 1, uniqueItems: true }),
      auto_increment_intent: { type: 'boolean' },
    }),
    foreign_key: object({
      relation_id: contractId,
      source_columns: array(identifier, {
        minItems: 1,
        uniqueItems: true,
      }),
      target_table: identifier,
      target_columns: array(identifier, {
        minItems: 1,
        uniqueItems: true,
      }),
      on_delete: { enum: [...FOREIGN_KEY_ACTIONS] },
      deferrability: { enum: [...FOREIGN_KEY_DEFERRABILITY] },
    }),
    unique_key: object({
      key_id: contractId,
      columns: array(identifier, { minItems: 1, uniqueItems: true }),
      predicate_intent: nullable(stringSchema({ minLength: 1 })),
    }),
    check: object({
      check_id: contractId,
      kind: { enum: [...LOGICAL_CHECK_KINDS] },
      columns: array(identifier, { minItems: 1, uniqueItems: true }),
      expression_intent: stringSchema({ minLength: 1 }),
    }),
    index: object({
      index_id: contractId,
      kind: { enum: [...INDEX_INTENT_KINDS] },
      columns: array(identifier, { minItems: 1 }),
      predicate_intent: nullable(stringSchema({ minLength: 1 })),
      supports_query_ids: array(contractId, { uniqueItems: true }),
    }),
    table: object({
      ordinal: integerSchema(1),
      name: identifier,
      source_section: stringSchema({ minLength: 1 }),
      columns: array(ref('column'), { minItems: 1 }),
      primary_key: ref('primary_key'),
      foreign_keys: array(ref('foreign_key')),
      unique_keys: array(ref('unique_key')),
      checks: array(ref('check')),
      indexes: array(ref('index')),
    }),
  };
}

function logicalSchemaSourceSchema(): Schema {
  return schemaDocument(
    'urn:icarus:workflow-runtime-logical-schema-source:1',
    'Workflow Runtime Logical Schema Source v1 payload',
    object({
      schema_id: { const: 'workflow-runtime-schema-v1' },
      database_name: { const: 'workflow-runtime.db' },
      contract_stage: { const: 'logical_metadata' },
      executable_status: { const: 'non_executable' },
      ddl_generation_status: { const: 'forbidden_in_g0_6' },
      sqlite_open_status: { const: 'forbidden_in_g0_6' },
      table_count: integerSchema(1),
      column_count: integerSchema(1),
      tables: array(ref('table'), { minItems: 1 }),
      forbidden_logical_columns: array(identifier, {
        minItems: 1,
        uniqueItems: true,
      }),
      relation_policy: object({
        internal_targets: { const: 'typed_foreign_keys_only' },
        external_targets: {
          const: 'explicit_external_reference_metadata',
        },
        polymorphic_kind_id: { const: 'forbidden' },
        generic_error_fields: { const: 'forbidden' },
      }),
    }),
    commonDefs(),
  );
}

function typedRelationCatalogSchema(): Schema {
  return schemaDocument(
    'urn:icarus:workflow-runtime-typed-relation-catalog:1',
    'Workflow Runtime Typed Relation Catalog v1 payload',
    object({
      schema_id: { const: 'workflow-runtime-schema-v1' },
      executable_status: { const: 'non_executable' },
      internal_relation_count: integerSchema(),
      external_reference_count: integerSchema(),
      relations: array(ref('relation')),
    }),
    {
      relation: object({
        relation_id: contractId,
        relation_kind: { enum: ['foreign_key', 'external_reference'] },
        source_table: identifier,
        source_columns: array(identifier, {
          minItems: 1,
          uniqueItems: true,
        }),
        target_table: nullable(identifier),
        target_columns: array(identifier, { uniqueItems: true }),
        on_delete: nullable({ enum: [...FOREIGN_KEY_ACTIONS] }),
        deferrability: nullable({
          enum: [...FOREIGN_KEY_DEFERRABILITY],
        }),
        validator_owner: nullable(contractId),
        reference_domain: nullable(contractId),
      }),
    },
  );
}

function queryCatalogSchema(): Schema {
  return schemaDocument(
    'urn:icarus:workflow-runtime-query-catalog:1',
    'Workflow Runtime Query Catalog v1 payload',
    object({
      schema_id: { const: 'workflow-runtime-schema-v1' },
      executable_status: { const: 'non_executable' },
      sql_text_status: { const: 'absent' },
      query_count: integerSchema(1),
      queries: array(ref('query'), { minItems: 1 }),
    }),
    {
      order: object({
        column: identifier,
        direction: { enum: ['asc', 'desc'] },
      }),
      query: object({
        query_id: contractId,
        owner: { enum: [...QUERY_OWNERS] },
        purpose: stringSchema({ minLength: 1 }),
        table: identifier,
        join_tables: array(identifier, { uniqueItems: true }),
        equality_columns: array(identifier, { uniqueItems: true }),
        range_columns: array(identifier, { uniqueItems: true }),
        state_predicate_intent: nullable(stringSchema({ minLength: 1 })),
        order_by: array(ref('order')),
        result_cardinality: {
          enum: ['zero_or_one', 'many', 'bounded_batch'],
        },
        required_index_id: contractId,
        execution_status: { const: 'intent_only' },
      }),
    },
  );
}

export function buildLogicalSchemaArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const withoutHash = {
    format,
    ref: { id: refId, version: '1' },
    version: 1,
    domain_separator: domainSeparator,
    payload,
  };
  return {
    ...withoutHash,
    hash: calculateArtifactHash({
      ...withoutHash,
      hash: `sha256:${'0'.repeat(64)}`,
    }),
  };
}

export function payloadAsJsonValue(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

export function buildLogicalSchemaSemanticArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  const payloadByFormat: Record<string, JsonObject> = {
    'icarus.workflow-runtime-logical-schema-source-schema/1':
      logicalSchemaSourceSchema(),
    'icarus.workflow-runtime-typed-relation-catalog-schema/1':
      typedRelationCatalogSchema(),
    'icarus.workflow-runtime-query-catalog-schema/1': queryCatalogSchema(),
    'icarus.workflow-runtime-logical-schema-source/1': payloadAsJsonValue(
      buildLogicalSchemaSourcePayload(),
    ) as JsonObject,
    'icarus.workflow-runtime-typed-relation-catalog/1': payloadAsJsonValue(
      buildTypedRelationCatalogPayload(),
    ) as JsonObject,
    'icarus.workflow-runtime-query-catalog/1': payloadAsJsonValue(
      buildLogicalQueryCatalogPayload(),
    ) as JsonObject,
  };
  return LOGICAL_SCHEMA_ARTIFACT_DESCRIPTORS.map((descriptor) => [
    descriptor.artifact_path,
    buildLogicalSchemaArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      payloadByFormat[descriptor.artifact_format]!,
    ),
  ]);
}
