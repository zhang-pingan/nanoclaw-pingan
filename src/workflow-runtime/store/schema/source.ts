import type {
  LogicalQueryCatalogPayload,
  LogicalSchemaSourcePayload,
  LogicalTableMetadata,
  TypedRelationCatalogPayload,
} from '../../contracts/logical-schema-types.js';
import type {
  CapacityLogicalExtendedTableDelta,
  CapacityLogicalSchemaDelta,
} from '../../contracts/capacity-control-plane-types.js';
import {
  parseActivationSchemaPrerequisiteArtifact,
  type ActivationSchemaTableExtension,
} from './activation-source.js';
import { readPinnedSchemaInputArtifacts } from './dependencies.js';
import {
  parsePublisherSchemaPrerequisiteArtifact,
  type PublisherSchemaTableExtension,
} from './publisher-source.js';
import type { ExecutableSchemaSource } from './types.js';

interface AdditiveTableExtension {
  name: string;
  added_columns: LogicalTableMetadata['columns'];
  added_foreign_keys: LogicalTableMetadata['foreign_keys'];
  added_unique_keys: LogicalTableMetadata['unique_keys'];
  added_checks: LogicalTableMetadata['checks'];
  added_indexes: LogicalTableMetadata['indexes'];
}

function mergeExtension(
  table: LogicalTableMetadata,
  extension:
    | CapacityLogicalExtendedTableDelta
    | PublisherSchemaTableExtension
    | ActivationSchemaTableExtension
    | AdditiveTableExtension,
): LogicalTableMetadata {
  if (table.name !== extension.name) {
    throw new Error(`Capacity extension target mismatch: ${extension.name}`);
  }
  return {
    ...table,
    columns: [
      ...table.columns,
      ...extension.added_columns.map((column, index) => ({
        ...column,
        ordinal: table.columns.length + index + 1,
      })),
    ],
    foreign_keys: [...table.foreign_keys, ...extension.added_foreign_keys],
    unique_keys: [...table.unique_keys, ...extension.added_unique_keys],
    checks: [...table.checks, ...extension.added_checks],
    indexes: [...table.indexes, ...extension.added_indexes],
  };
}

function assertUnique(values: string[], label: string): void {
  const duplicate = values.find(
    (value, index) => values.indexOf(value) !== index,
  );
  if (duplicate) throw new Error(`Duplicate ${label}: ${duplicate}`);
}

function assertExecutableSource(source: ExecutableSchemaSource): void {
  if (source.tables.length !== 84) {
    throw new Error(`Expected 84 v1 tables, received ${source.tables.length}`);
  }
  if (source.queries.length !== 42) {
    throw new Error(
      `Expected 42 query intents, received ${source.queries.length}`,
    );
  }
  assertUnique(
    source.tables.map((table) => table.name),
    'table',
  );
  assertUnique(
    source.queries.map((query) => query.query_id),
    'query',
  );
  for (const table of source.tables) {
    assertUnique(
      table.columns.map((column) => column.name),
      `${table.name} column`,
    );
    assertUnique(
      table.checks.map((check) => check.check_id),
      `${table.name} check`,
    );
    assertUnique(
      table.foreign_keys.map((relation) => relation.relation_id),
      `${table.name} foreign key`,
    );
    assertUnique(
      table.unique_keys.map((key) => key.key_id),
      `${table.name} unique key`,
    );
    assertUnique(
      table.indexes.map((index) => index.index_id),
      `${table.name} index`,
    );
  }
}

function assertBaseRelations(
  source: LogicalSchemaSourcePayload,
  catalog: TypedRelationCatalogPayload,
): void {
  const expected = source.tables.flatMap((table) => [
    ...table.foreign_keys.map((relation) => ({
      relation_id: relation.relation_id,
      source_table: table.name,
    })),
    ...table.columns.flatMap((column) =>
      column.external_reference
        ? column.relation_ids.map((relationId) => ({
            relation_id: relationId,
            source_table: table.name,
          }))
        : [],
    ),
  ]);
  if (expected.length !== catalog.relations.length) {
    throw new Error('G0.6 typed relation catalog count does not match source');
  }
  for (const relation of expected) {
    if (
      !catalog.relations.some(
        (candidate) =>
          candidate.relation_id === relation.relation_id &&
          candidate.source_table === relation.source_table,
      )
    ) {
      throw new Error(`G0.6 typed relation missing: ${relation.relation_id}`);
    }
  }
}

export function loadExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  const inputs = readPinnedSchemaInputArtifacts({ contractsRoot });
  const g0_6Manifest = inputs.g0_6_logical_schema_manifest.artifact;
  const logicalSource = inputs.logical_schema_source.artifact;
  const typedRelations = inputs.typed_relation_catalog.artifact;
  const queryCatalog = inputs.query_catalog.artifact;
  const capacityDelta = inputs.g0_10_capacity_logical_schema_delta.artifact;
  const publisherInput = inputs.publisher_schema_prerequisite.artifact;
  const activationInput =
    inputs.feature_release_activation_schema_prerequisite.artifact;
  const sqliteProfile = inputs.sqlite_execution_profile.artifact;

  const base = logicalSource.payload as unknown as LogicalSchemaSourcePayload;
  const relations =
    typedRelations.payload as unknown as TypedRelationCatalogPayload;
  const baseQueries =
    queryCatalog.payload as unknown as LogicalQueryCatalogPayload;
  const delta = capacityDelta.payload as unknown as CapacityLogicalSchemaDelta;
  const publisher = parsePublisherSchemaPrerequisiteArtifact(publisherInput);
  const activation = parseActivationSchemaPrerequisiteArtifact(activationInput);
  if (
    base.schema_id !== 'workflow-runtime-schema-v1' ||
    base.table_count !== 74 ||
    base.column_count !== 1221
  ) {
    throw new Error('G0.6 logical schema source shape drifted');
  }
  if (
    activation.schema_id !== base.schema_id ||
    activation.database_schema_version !== 3 ||
    activation.delta_mode !== 'additive_only' ||
    activation.added_tables.length !== 3 ||
    activation.extended_tables.length !== 3 ||
    activation.historical_inputs.publisher_schema_prerequisite_hash !==
      publisherInput.hash ||
    activation.normative_logical_schema_coverage.prior_table_count !== 81 ||
    activation.normative_logical_schema_coverage.resulting_table_count !== 84
  ) {
    throw new Error(
      'Feature Release Activation Schema Prerequisite is not the expected additive input',
    );
  }
  if (
    delta.schema_id !== base.schema_id ||
    delta.delta_mode !== 'additive_only' ||
    delta.base_logical_schema_manifest_hash !== g0_6Manifest.hash ||
    delta.added_tables.length !== 4 ||
    delta.extended_tables.length !== 1 ||
    delta.delta_hash !==
      'sha256:e8917c737b1eae0f62abfa2de2dec6dc71875122a763882a46aee34c5c84cae6'
  ) {
    throw new Error('G0.10 capacity delta is not the expected additive input');
  }
  if (
    publisher.schema_id !== base.schema_id ||
    publisher.database_schema_version !== 2 ||
    publisher.delta_mode !== 'additive_only' ||
    publisher.added_tables.length !== 3 ||
    publisher.extended_tables.length !== 1 ||
    publisher.normative_logical_schema_coverage.prior_table_count !== 78 ||
    publisher.normative_logical_schema_coverage.resulting_table_count !== 81
  ) {
    throw new Error(
      'Publisher Schema Prerequisite is not the expected additive input',
    );
  }
  assertBaseRelations(base, relations);

  const extension = delta.extended_tables[0];
  const tables = base.tables.map((table) =>
    table.name === extension.name ? mergeExtension(table, extension) : table,
  );
  if (!tables.some((table) => table.name === extension.name)) {
    throw new Error(`Capacity extension target is absent: ${extension.name}`);
  }
  tables.push(
    ...delta.added_tables.map((table, index) => ({
      ...table,
      ordinal: base.tables.length + index + 1,
    })),
  );

  const publisherExtension = publisher.extended_tables[0];
  const publisherExtensionIndex = tables.findIndex(
    (table) => table.name === publisherExtension.name,
  );
  if (publisherExtensionIndex < 0) {
    throw new Error(
      `Publisher extension target is absent: ${publisherExtension.name}`,
    );
  }
  tables[publisherExtensionIndex] = mergeExtension(
    tables[publisherExtensionIndex],
    publisherExtension,
  );
  tables.push(
    ...publisher.added_tables.map((table, index) => ({
      ...table,
      ordinal: tables.length + index + 1,
    })),
  );

  for (const activationExtension of activation.extended_tables) {
    const activationExtensionIndex = tables.findIndex(
      (table) => table.name === activationExtension.name,
    );
    if (activationExtensionIndex < 0) {
      throw new Error(
        `Feature Release Activation extension target is absent: ${activationExtension.name}`,
      );
    }
    tables[activationExtensionIndex] = mergeExtension(
      tables[activationExtensionIndex],
      activationExtension,
    );
  }
  tables.push(
    ...activation.added_tables.map((table, index) => ({
      ...table,
      ordinal: tables.length + index + 1,
    })),
  );

  const result: ExecutableSchemaSource = {
    schema_id: 'workflow-runtime-schema-v1',
    database_schema_version: 3,
    tables,
    queries: [
      ...baseQueries.queries,
      ...delta.query_intents,
      ...publisher.query_intents,
      ...activation.query_intents,
    ],
    logical_inputs: {
      logical_schema_source_hash: logicalSource.hash,
      typed_relation_catalog_hash: typedRelations.hash,
      query_catalog_hash: queryCatalog.hash,
      capacity_delta_hash: capacityDelta.hash,
      publisher_schema_prerequisite_hash: publisherInput.hash,
      feature_release_activation_schema_prerequisite_hash: activationInput.hash,
      sqlite_profile_hash: sqliteProfile.hash,
    },
  };
  assertExecutableSource(result);
  return result;
}
