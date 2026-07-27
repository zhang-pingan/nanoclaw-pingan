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
import { parseActivationRepairSchemaPrerequisiteArtifact } from './activation-repair-source.js';
import {
  readPinnedSchemaInputArtifacts,
  type LoadedSchemaInputArtifacts,
} from './dependencies.js';
import {
  parsePublisherSchemaPrerequisiteArtifact,
  type PublisherSchemaTableExtension,
} from './publisher-source.js';
import type { ExecutableSchemaSource } from './types.js';
import { applyGeneratedSchemaPrerequisite } from './generated-schema-source.js';
import { applyNodeOutputEnvelopeSchemaPrerequisite } from './node-output-envelope-source.js';
import { applyChildCompletionLineageSchemaPrerequisite } from './child-completion-lineage-source.js';
import { applyMapTerminalConsumptionSchemaPrerequisite } from './map-terminal-consumption-source.js';
import { applyDomainClaimHandoffSchemaPrerequisite } from './domain-claim-handoff-source.js';

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

function assertSchema3ExecutableSource(source: ExecutableSchemaSource): void {
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

function assertExecutableSource(source: ExecutableSchemaSource): void {
  if (source.database_schema_version !== 10) {
    throw new Error('Current executable Database Schema must be version 10');
  }
  if (source.tables.length !== 87) {
    throw new Error(`Expected 87 v1 tables, received ${source.tables.length}`);
  }
  if (source.queries.length !== 46) {
    throw new Error(
      `Expected 46 query intents, received ${source.queries.length}`,
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
      table.checks.map((entry) => entry.check_id),
      `${table.name} check`,
    );
    assertUnique(
      table.foreign_keys.map((entry) => entry.relation_id),
      `${table.name} foreign key`,
    );
    assertUnique(
      table.unique_keys.map((entry) => entry.key_id),
      `${table.name} unique key`,
    );
    assertUnique(
      table.indexes.map((entry) => entry.index_id),
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

function buildSchema3ExecutableSource(
  inputs: LoadedSchemaInputArtifacts,
): ExecutableSchemaSource {
  const g0_6Manifest = inputs.g0_6_logical_schema_manifest.artifact;
  const logicalSource = inputs.logical_schema_source.artifact;
  const typedRelations = inputs.typed_relation_catalog.artifact;
  const queryCatalog = inputs.query_catalog.artifact;
  const capacityDelta = inputs.g0_10_capacity_logical_schema_delta.artifact;
  const publisherInput = inputs.publisher_schema_prerequisite.artifact;
  const activationInput =
    inputs.feature_release_activation_schema_prerequisite.artifact;
  const sqliteProfile = inputs.sqlite_execution_profile.artifact;
  const activationRepairInput =
    inputs.activation_failure_replay_schema_prerequisite.artifact;

  const base = logicalSource.payload as unknown as LogicalSchemaSourcePayload;
  const relations =
    typedRelations.payload as unknown as TypedRelationCatalogPayload;
  const baseQueries =
    queryCatalog.payload as unknown as LogicalQueryCatalogPayload;
  const currentDelta =
    capacityDelta.payload as unknown as CapacityLogicalSchemaDelta;
  const generatedSchemaPrerequisite = inputs
    .generated_schema_authority_prerequisite.artifact.payload as unknown as {
    historical_capacity_rebind: {
      current_logical_schema_manifest_hash: string;
      logical_schema_source_hash: string;
      historical_capacity_delta_artifact_hash: string;
      historical_capacity_delta_hash: string;
      historical_base_logical_schema_manifest_hash: string;
      compatibility_rule: string;
    };
  };
  const delta = structuredClone(currentDelta);
  const historicalInvocation = delta.added_tables.find(
    (table) => table.name === 'runtime_capacity_admin_invocations',
  );
  if (!historicalInvocation) {
    throw new Error('G0.10 Capacity Invocation table is absent');
  }
  const historicalExecutionResult = historicalInvocation.columns.find(
    (column) => column.name === 'execution_result',
  );
  if (!historicalExecutionResult?.enum_values?.includes('prepared')) {
    throw new Error('Current G0.10 Capacity prepared result is absent');
  }
  historicalExecutionResult.enum_values =
    historicalExecutionResult.enum_values.filter(
      (value) => value !== 'prepared',
    );
  const historicalResultCheck = historicalInvocation.checks.find(
    (check) => check.check_id === 'ck:capacity_invocations:result_consistency',
  );
  if (!historicalResultCheck) {
    throw new Error('G0.10 Capacity Invocation result CHECK is absent');
  }
  historicalResultCheck.columns = historicalResultCheck.columns.filter(
    (column) => column !== 'invocation_no' && column !== 'decided_at_ms',
  );
  historicalResultCheck.expression_intent =
    'denied authorization has denied result and denial code; applied result has applied timestamp and no denial code';
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
    delta.base_logical_schema_manifest_hash !==
      generatedSchemaPrerequisite.historical_capacity_rebind
        .historical_base_logical_schema_manifest_hash ||
    delta.added_tables.length !== 4 ||
    delta.extended_tables.length !== 1 ||
    currentDelta.delta_hash !==
      generatedSchemaPrerequisite.historical_capacity_rebind
        .historical_capacity_delta_hash ||
    capacityDelta.hash !==
      generatedSchemaPrerequisite.historical_capacity_rebind
        .historical_capacity_delta_artifact_hash ||
    g0_6Manifest.hash !==
      generatedSchemaPrerequisite.historical_capacity_rebind
        .current_logical_schema_manifest_hash ||
    logicalSource.hash !==
      generatedSchemaPrerequisite.historical_capacity_rebind
        .logical_schema_source_hash ||
    generatedSchemaPrerequisite.historical_capacity_rebind
      .compatibility_rule !== 'identical_logical_source_semantics_only'
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
      activation_failure_replay_schema_prerequisite_hash:
        activationRepairInput.hash,
      sqlite_profile_hash: sqliteProfile.hash,
    },
  };
  assertSchema3ExecutableSource(result);
  return result;
}

export function loadSchema3ExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema3ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}

export function loadExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema9ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}

export function loadCurrentExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  const inputs = readPinnedSchemaInputArtifacts({ contractsRoot });
  const schema9 = buildSchema9ExecutableSource(inputs);
  const applied = applyDomainClaimHandoffSchemaPrerequisite(
    schema9.tables,
    schema9.queries,
    inputs.domain_claim_handoff_schema_prerequisite.artifact,
  );
  const result: ExecutableSchemaSource = {
    ...schema9,
    database_schema_version: 10,
    tables: applied.tables,
    queries: applied.queries,
    logical_inputs: {
      ...schema9.logical_inputs,
      domain_claim_handoff_schema_prerequisite_hash:
        inputs.domain_claim_handoff_schema_prerequisite.artifact.hash,
    },
  };
  assertExecutableSource(result);
  return result;
}

function buildSchema9ExecutableSource(
  inputs: LoadedSchemaInputArtifacts,
): ExecutableSchemaSource {
  const schema8 = buildSchema8ExecutableSource(inputs);
  const applied = applyMapTerminalConsumptionSchemaPrerequisite(
    schema8.tables,
    schema8.queries,
    inputs.map_terminal_consumption_schema_prerequisite.artifact,
  );
  const result: ExecutableSchemaSource = {
    ...schema8,
    database_schema_version: 9,
    tables: applied.tables,
    queries: applied.queries,
    logical_inputs: {
      ...schema8.logical_inputs,
      map_terminal_consumption_schema_prerequisite_hash:
        inputs.map_terminal_consumption_schema_prerequisite.artifact.hash,
    },
  };
  return result;
}

export function loadSchema9ExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema9ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}

function buildSchema8ExecutableSource(
  inputs: LoadedSchemaInputArtifacts,
): ExecutableSchemaSource {
  const schema7 = buildSchema7ExecutableSource(inputs);
  const applied = applyChildCompletionLineageSchemaPrerequisite(
    schema7.tables,
    schema7.queries,
    inputs.child_completion_lineage_schema_prerequisite.artifact,
  );
  const result: ExecutableSchemaSource = {
    ...schema7,
    database_schema_version: 8,
    tables: applied.tables,
    queries: applied.queries,
    logical_inputs: {
      ...schema7.logical_inputs,
      child_completion_lineage_schema_prerequisite_hash:
        inputs.child_completion_lineage_schema_prerequisite.artifact.hash,
    },
  };
  return result;
}

export function loadSchema8ExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema8ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}

function buildSchema7ExecutableSource(
  inputs: LoadedSchemaInputArtifacts,
): ExecutableSchemaSource {
  const schema6 = buildSchema6ExecutableSource(inputs);
  const tables = applyNodeOutputEnvelopeSchemaPrerequisite(
    schema6.tables,
    inputs.node_output_envelope_schema_authority_prerequisite.artifact,
  );
  const result: ExecutableSchemaSource = {
    ...schema6,
    database_schema_version: 7,
    tables,
    logical_inputs: {
      ...schema6.logical_inputs,
      node_output_envelope_schema_authority_prerequisite_hash:
        inputs.node_output_envelope_schema_authority_prerequisite.artifact.hash,
    },
  };
  return result;
}

export function loadSchema7ExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema7ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}

function buildSchema6ExecutableSource(
  inputs: LoadedSchemaInputArtifacts,
): ExecutableSchemaSource {
  const schema5 = buildSchema5ExecutableSource(inputs);
  const applied = applyGeneratedSchemaPrerequisite(
    schema5.tables,
    inputs.generated_schema_authority_prerequisite.artifact,
  );
  const result: ExecutableSchemaSource = {
    ...schema5,
    database_schema_version: 6,
    tables: applied.tables,
    queries: [...schema5.queries, ...applied.queries],
    logical_inputs: {
      ...schema5.logical_inputs,
      generated_schema_authority_prerequisite_hash:
        inputs.generated_schema_authority_prerequisite.artifact.hash,
    },
  };
  return result;
}

export function loadSchema6ExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema6ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}

function buildSchema5ExecutableSource(
  inputs: LoadedSchemaInputArtifacts,
): ExecutableSchemaSource {
  const schema4 = buildSchema4ExecutableSource(inputs);
  const currentDelta = inputs.g0_10_capacity_logical_schema_delta.artifact
    .payload as unknown as CapacityLogicalSchemaDelta;
  const currentInvocation = currentDelta.added_tables.find(
    (table) => table.name === 'runtime_capacity_admin_invocations',
  );
  if (!currentInvocation) {
    throw new Error('Current Capacity Invocation table is absent');
  }
  const tables = schema4.tables.map((table) =>
    table.name === currentInvocation.name
      ? { ...structuredClone(currentInvocation), ordinal: table.ordinal }
      : table,
  );
  const result: ExecutableSchemaSource = {
    ...schema4,
    database_schema_version: 5,
    tables,
    logical_inputs: {
      ...schema4.logical_inputs,
      capacity_delta_hash:
        inputs.g0_10_capacity_logical_schema_delta.artifact.hash,
    },
  };
  return result;
}

export function loadSchema5ExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema5ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}

function buildSchema4ExecutableSource(
  inputs: LoadedSchemaInputArtifacts,
): ExecutableSchemaSource {
  const schema3 = buildSchema3ExecutableSource(inputs);
  const repair = parseActivationRepairSchemaPrerequisiteArtifact(
    inputs.activation_failure_replay_schema_prerequisite.artifact,
  );
  if (
    repair.database_schema_version !== 4 ||
    repair.delta_mode !== 'rebuild_activation_relations' ||
    repair.rebuilt_tables.length !== 3 ||
    repair.column_requirements.length !== 62 ||
    repair.foreign_key_requirements.length !== 12 ||
    repair.unique_key_requirements.length !== 7 ||
    repair.query_intents.length !== 8
  ) {
    throw new Error('Activation Failure / Replay Schema Prerequisite drifted');
  }

  const replacements = new Map(
    repair.rebuilt_tables.map((table) => [table.name, table]),
  );
  const tables = schema3.tables.map((table) =>
    replacements.has(table.name)
      ? structuredClone(replacements.get(table.name)!)
      : table,
  );
  if (
    [...replacements.keys()].some(
      (name) => !tables.some((table) => table.name === name),
    )
  ) {
    throw new Error('Activation repair replacement table is absent');
  }
  const replacedQueries = new Set(repair.replaced_query_ids);
  const result: ExecutableSchemaSource = {
    ...schema3,
    database_schema_version: 4,
    tables,
    queries: [
      ...schema3.queries.filter(
        (query) => !replacedQueries.has(query.query_id),
      ),
      ...repair.query_intents,
    ],
    logical_inputs: {
      ...schema3.logical_inputs,
      activation_failure_replay_schema_prerequisite_hash:
        inputs.activation_failure_replay_schema_prerequisite.artifact.hash,
    },
  };
  return result;
}

export function loadSchema4ExecutableSchemaSource(
  contractsRoot?: string,
): ExecutableSchemaSource {
  return buildSchema4ExecutableSource(
    readPinnedSchemaInputArtifacts({ contractsRoot }),
  );
}
