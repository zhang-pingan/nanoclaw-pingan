import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  calculateArtifactHash,
  domainSeparatedSha256,
} from '../../contracts/hash.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from '../../contracts/types.js';
import {
  GENERATED_SCHEMA_DOMAIN,
  GENERATED_SCHEMA_PARAMETER_DOMAIN,
  GENERATED_SCHEMA_PLAN_BINDING_DOMAIN,
} from '../../contracts/generated-schema-authority.js';
import {
  ACTIVATION_SCHEMA_DELTA_DOMAIN,
  ACTIVATION_SCHEMA_INPUT_DOMAIN,
  ACTIVATION_SCHEMA_INPUT_RELATIVE_PATH,
  buildActivationSchemaPrerequisiteArtifact,
} from './activation-source.js';
import {
  ACTIVATION_REPAIR_SCHEMA_DELTA_DOMAIN,
  ACTIVATION_REPAIR_SCHEMA_INPUT_DOMAIN,
  ACTIVATION_REPAIR_SCHEMA_INPUT_RELATIVE_PATH,
  buildActivationRepairSchemaPrerequisiteArtifact,
} from './activation-repair-source.js';
import {
  G1_PHYSICAL_SCHEMA_IDENTITY_DOMAIN_SEPARATOR,
  G1_SCHEMA_DEPENDENCY_MANIFEST_DOMAIN_SEPARATOR,
  buildSchemaDependencyManifestArtifact,
} from './dependencies.js';
import {
  SQLITE_SCHEMA_IDENTITY_DOMAIN_SEPARATOR,
  calculateDatabaseSqliteSchemaIdentity,
  calculateManifestSqliteSchemaIdentity,
} from './database-identity.js';
import {
  SCHEMA3_TO_SCHEMA4_UPGRADE_RELATIVE_PATH,
  SCHEMA4_TO_SCHEMA5_UPGRADE_RELATIVE_PATH,
  SCHEMA5_TO_SCHEMA6_UPGRADE_RELATIVE_PATH,
  buildQueryFixtures,
  renderMigration,
  renderSchema3To4Upgrade,
  renderSchema4To5Upgrade,
  renderSchema5To6Upgrade,
} from './ddl.js';
import {
  assertClosedSchemaManifest,
  payloadAsJsonObject,
  reconstructSchemaManifest,
} from './manifest.js';
import {
  loadExecutableSchemaSource,
  loadSchema3ExecutableSchemaSource,
  loadSchema4ExecutableSchemaSource,
  loadSchema5ExecutableSchemaSource,
} from './source.js';
import {
  buildGeneratedSchemaPrerequisiteArtifact,
  GENERATED_SCHEMA_DELTA_DOMAIN,
  GENERATED_SCHEMA_INPUT_DOMAIN,
  GENERATED_SCHEMA_INPUT_RELATIVE_PATH,
} from './generated-schema-source.js';
import {
  buildPublisherSchemaPrerequisiteArtifact,
  PUBLISHER_SCHEMA_INPUT_RELATIVE_PATH,
} from './publisher-source.js';
import {
  collectSqliteEnvironmentEvidence,
  createMigratedDatabase,
  verifyQueryPlans,
  verifyReadOnlyConnection,
} from './sqlite-gate.js';
import type {
  ExecutableSchemaSource,
  G1SchemaDependencyManifestPayload,
  WorkflowRuntimeSchemaManifestPayload,
} from './types.js';

const schemaRoot = import.meta.dirname;

export const G1_ARTIFACT_PATHS = {
  publisherInput: PUBLISHER_SCHEMA_INPUT_RELATIVE_PATH,
  activationInput: ACTIVATION_SCHEMA_INPUT_RELATIVE_PATH,
  activationRepairInput: ACTIVATION_REPAIR_SCHEMA_INPUT_RELATIVE_PATH,
  generatedSchemaInput: GENERATED_SCHEMA_INPUT_RELATIVE_PATH,
  migration: 'migration/workflow-runtime-schema-v6.sql',
  schema3To4Upgrade: SCHEMA3_TO_SCHEMA4_UPGRADE_RELATIVE_PATH,
  schema4To5Upgrade: SCHEMA4_TO_SCHEMA5_UPGRADE_RELATIVE_PATH,
  schema5To6Upgrade: SCHEMA5_TO_SCHEMA6_UPGRADE_RELATIVE_PATH,
  dependencyManifest:
    'artifacts/workflow-runtime-schema-dependency-manifest@1.json',
  dependencyManifestContract:
    'artifacts/workflow-runtime-schema-dependency-manifest-contract@1.json',
  manifest: 'artifacts/workflow-runtime-schema-manifest@1.json',
  manifestContract:
    'artifacts/workflow-runtime-schema-manifest-contract@1.json',
  executableDdl: 'artifacts/workflow-runtime-executable-ddl@1.json',
  queryFixtures: 'fixtures/workflow-runtime-query-plan-fixtures@1.json',
  constraintFixtures:
    'fixtures/workflow-runtime-constraint-trigger-fixtures@1.json',
  schemaLint: 'artifacts/workflow-runtime-schema-lint@1.json',
  domains: 'catalogs/workflow-runtime-schema-domain-separators@1.json',
  root: 'contract-pack-g1-executable-schema.json',
} as const;

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function buildArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1' },
    version: 1,
    domain_separator: domainSeparator,
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function rawSha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function buildDependencyManifestContractArtifact(): ContractArtifactEnvelope {
  return buildArtifact(
    'icarus.workflow-runtime-schema-dependency-manifest-contract/1',
    'icarus.workflow-runtime-schema-dependency-manifest-contract',
    'icarus:workflow-runtime-schema-dependency-manifest-contract:1\n',
    {
      contract_kind: 'closed_required_members',
      unknown_fields: 'rejected',
      validator_owner: 'workflow_runtime_schema_gate',
      path_model: 'exact_required_members_only',
      directory_exclusions: 'forbidden',
      top_level_keys: [
        'dependency_set_id',
        'identity_scope',
        'member_count',
        'physical_member_count',
        'construction_provenance_count',
        'members',
        'physical_schema_identity',
      ],
      member_keys: [
        'role',
        'identity_effect',
        'path',
        'format',
        'ref',
        'version',
        'semantic_hash',
        'raw_sha256',
      ],
      ref_keys: ['id', 'version'],
      required_roles: [
        'g0_6_logical_schema_manifest',
        'logical_schema_source',
        'typed_relation_catalog',
        'query_catalog',
        'g0_10_capacity_logical_schema_delta',
        'publisher_schema_prerequisite',
        'feature_release_activation_schema_prerequisite',
        'activation_failure_replay_schema_prerequisite',
        'generated_schema_authority_prerequisite',
        'sqlite_execution_profile',
        'schema_manifest',
        'canonical_migration',
        'schema3_to_schema4_upgrade',
        'schema4_to_schema5_upgrade',
        'schema5_to_schema6_upgrade',
      ],
      member_order: 'required_roles_order',
      physical_identity_domain_separator:
        G1_PHYSICAL_SCHEMA_IDENTITY_DOMAIN_SEPARATOR,
    },
  );
}

function buildManifestContractArtifact(): ContractArtifactEnvelope {
  return buildArtifact(
    'icarus.workflow-runtime-schema-manifest-contract/1',
    'icarus.workflow-runtime-schema-manifest-contract',
    'icarus:workflow-runtime-schema-manifest-contract:1\n',
    {
      contract_kind: 'closed_keysets',
      unknown_fields: 'rejected',
      validator_owner: 'workflow_runtime_schema_gate',
      top_level_keys: [
        'schema_id',
        'database_name',
        'database_schema_version',
        'logical_inputs',
        'migration_path',
        'migration_sha256',
        'migration_statement_count',
        'table_count',
        'column_count',
        'primary_key_count',
        'unique_key_count',
        'foreign_key_count',
        'check_count',
        'index_count',
        'trigger_count',
        'external_reference_count',
        'tables',
        'triggers',
        'query_fixtures',
        'schema_hash',
      ],
      table_keys: [
        'ordinal',
        'name',
        'sql',
        'columns',
        'primary_key',
        'unique_keys',
        'foreign_keys',
        'checks',
        'indexes',
      ],
      column_keys: [
        'cid',
        'name',
        'sqlite_type',
        'nullable',
        'default_sql',
        'primary_key_ordinal',
        'logical_type',
        'external_reference',
      ],
      primary_key_keys: ['columns', 'auto_increment'],
      unique_key_keys: [
        'key_id',
        'columns',
        'predicate_intent',
        'origin',
        'sql',
      ],
      foreign_key_keys: [
        'relation_id',
        'source_columns',
        'target_table',
        'target_columns',
        'on_delete',
        'deferrability',
        'pragma_id',
      ],
      check_keys: [
        'check_id',
        'kind',
        'columns',
        'expression_intent',
        'expression_sql',
      ],
      index_keys: [
        'index_id',
        'kind',
        'columns',
        'predicate_intent',
        'supports_query_ids',
        'unique',
        'sql',
      ],
      external_reference_keys: [
        'validator_owner',
        'reference_domain',
        'immutable',
      ],
      trigger_keys: ['name', 'table', 'timing', 'event', 'owner_intent', 'sql'],
      query_fixture_keys: [
        'query_id',
        'owner',
        'coverage_area',
        'sql',
        'parameter_count',
        'required_index_id',
      ],
      schema_hash_domain_separator: 'icarus:workflow-runtime-schema:1\n',
    },
  );
}

function buildConstraintFixtureArtifact(
  source: ExecutableSchemaSource,
): ContractArtifactEnvelope {
  const enumChecks = source.tables.flatMap((table) =>
    table.checks
      .filter((check) => check.kind === 'enum_membership')
      .map((check) => `${table.name}:${check.check_id}`),
  );
  return buildArtifact(
    'icarus.workflow-runtime-constraint-trigger-fixtures/1',
    'icarus.workflow-runtime-constraint-trigger-fixtures',
    'icarus:workflow-runtime-constraint-trigger-fixtures:1\n',
    {
      execution_target: 'real_file_sqlite',
      enum_check_count: enumChecks.length,
      enum_checks: enumChecks,
      required_cases: [
        'invalid_enum_values',
        'negative_and_overflow_safe_integer',
        'activation_state_run_terminal_combinations',
        'workflow_business_and_operational_state_combinations',
        'operational_blocker_zero_and_multi_source',
        'typed_relation_zero_and_multi_target',
        'attempt_initial_and_non_initial_lineage',
        'attempt_quality_feedback_and_single_successor',
        'terminal_field_mutual_exclusion',
        'cross_run_and_cross_scope_foreign_keys',
        'duplicate_idempotency_key',
        'second_root_scope_close_request_and_cut',
        'stale_composite_lineage',
        'operational_blocker_cache_triggers',
        'capacity_event_hash_chain_and_immutability',
        'capacity_prepared_invocation_shape_and_immutability',
        'capacity_milestone_partial_unique_repetition',
        'capacity_head_revision_commit_trigger',
        'publisher_caller_idempotency_unique',
        'publisher_schema_bound_values_and_typed_identity_foreign_keys',
        'publisher_review_approval_expiry_ordering',
        'publisher_command_lifecycle_and_finalization',
        'publisher_invocation_disposition_hash_chain_and_immutability',
        'publisher_event_phase_hash_chain_and_immutability',
        'activation_caller_idempotency_unique',
        'activation_request_only_pending_insert',
        'activation_verified_fact_prefix_without_holes_or_fabrication',
        'activation_owner_lifecycle_resource_g3_6_retention_failure_facts',
        'activation_applied_only_receipt_and_terminal_invocation_result_binding',
        'activation_failed_conflict_null_receipt_and_no_pointer_mutation',
        'activation_exact_replay_terminal_result_reference',
        'activation_invocation_event_adjacency_immutability_and_tamper_rejection',
        'schema3_empty_activation_pointer_upgrade_to_schema4',
        'schema3_nonempty_activation_or_pointer_upgrade_fail_closed',
        'schema4_nonempty_capacity_upgrade_to_schema5_preserves_all_rows',
        'schema4_identity_or_copy_constraint_upgrade_fail_closed',
        'feature_release_owner_identity_single_active_and_legal_lifecycle',
        'active_pointer_owner_cas_immutability_delete_and_target_active',
        'retention_published_identity_held_observation_and_active_draining_protection',
      ],
      trigger_names: renderMigration(source).triggers.map(
        (trigger) => trigger.name,
      ),
    },
  );
}

function buildSchemaLintArtifact(
  source: ExecutableSchemaSource,
): ContractArtifactEnvelope {
  return buildArtifact(
    'icarus.workflow-runtime-schema-lint/1',
    'icarus.workflow-runtime-schema-lint',
    'icarus:workflow-runtime-schema-lint:1\n',
    {
      status: 'closed_fail_on_violation',
      rules: [
        'all_v1_logical_tables_present',
        'internal_relations_use_typed_foreign_keys',
        'typed_multi_targets_use_nullable_columns_and_exactly_one_check',
        'external_refs_have_validator_owner_and_reference_domain',
        'no_bare_internal_kind_id',
        'no_unowned_ref_column',
        'no_generic_error_json_error_text_or_error_fields',
        'no_ref_or_hash_abbreviation',
        'all_logical_checks_have_executable_named_sql',
        'all_query_intents_have_fixed_explain_fixture',
        'publisher_commands_invocations_and_events_are_first_class_tables',
        'publisher_values_bind_exact_value_hash_and_schema_identity',
        'publisher_invocations_and_events_are_append_only_hash_chains',
        'activation_commands_invocations_and_events_are_first_class_tables',
        'activation_values_bind_exact_value_hash_and_schema_identity',
        'activation_verified_groups_are_nullable_prefix_ordered',
        'activation_terminal_result_binds_immutable_invocation_composite',
        'activation_release_pointer_and_retention_relations_are_typed',
        'activation_invocations_and_events_are_append_only_hash_chains',
        'capacity_prepared_invocation_is_closed_and_append_only',
        'feature_release_lifecycle_and_active_pointer_cas_are_trigger_constrained',
      ],
      table_count: source.tables.length,
      query_count: source.queries.length,
      result: 'pass',
    },
  );
}

function runSchemaLint(
  source: ExecutableSchemaSource,
  manifest: WorkflowRuntimeSchemaManifestPayload,
  migrationSql: string,
): void {
  const forbidden = [
    /\bowner_kind\b/,
    /\bowner_id\b/,
    /\btarget_kind\b/,
    /\btarget_id\b/,
    /\berror_json\b/,
    /\berror_text\b/,
    /\berror fields\b/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(migrationSql)) {
      throw new Error(`Schema lint forbidden SQL token: ${pattern.source}`);
    }
  }
  for (const table of source.tables) {
    const physical = manifest.tables.find(
      (candidate) => candidate.name === table.name,
    );
    if (!physical) throw new Error(`Schema lint missing table ${table.name}`);
    for (const column of table.columns) {
      if (
        column.name.endsWith('_ref') &&
        !column.external_reference &&
        column.relation_ids.length === 0
      ) {
        throw new Error(
          `Schema lint unowned reference: ${table.name}.${column.name}`,
        );
      }
      if (
        column.external_reference &&
        (!column.external_reference.validator_owner ||
          !column.external_reference.reference_domain)
      ) {
        throw new Error(
          `Schema lint incomplete external ref: ${table.name}.${column.name}`,
        );
      }
    }
    for (const relation of table.foreign_keys) {
      if (
        !physical.foreign_keys.some(
          (candidate) => candidate.relation_id === relation.relation_id,
        )
      ) {
        throw new Error(`Schema lint missing FK ${relation.relation_id}`);
      }
    }
  }
}

export interface BuiltG1Artifacts {
  migrationSql: string;
  schema3To4UpgradeSql: string;
  schema4To5UpgradeSql: string;
  schema5To6UpgradeSql: string;
  manifest: ContractArtifactEnvelope;
  dependencyManifest: ContractArtifactEnvelope;
  artifacts: Array<[string, ContractArtifactEnvelope]>;
  schemaHash: string;
  environmentSummary: ReturnType<typeof collectSqliteEnvironmentEvidence>;
}

export function buildG1Artifacts(
  options: { contractsRoot?: string } = {},
): BuiltG1Artifacts {
  const source = loadExecutableSchemaSource(options.contractsRoot);
  const schema3Source = loadSchema3ExecutableSchemaSource(
    options.contractsRoot,
  );
  const schema4Source = loadSchema4ExecutableSchemaSource(
    options.contractsRoot,
  );
  const schema5Source = loadSchema5ExecutableSchemaSource(
    options.contractsRoot,
  );
  const migration = renderMigration(source);
  const schema3Migration = renderMigration(schema3Source);
  const schema4Migration = renderMigration(schema4Source);
  const schema5Migration = renderMigration(schema5Source);
  if (
    rawSha256(schema3Migration.sql) !==
    'sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345'
  ) {
    throw new Error('Reproducible Schema 3 migration identity drifted');
  }
  if (
    rawSha256(schema4Migration.sql) !==
    'sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43'
  ) {
    throw new Error(
      'Reproducible historical Schema 4 migration identity drifted',
    );
  }
  if (
    rawSha256(schema5Migration.sql) !==
    'sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6'
  ) {
    throw new Error(
      'Reproducible historical Schema 5 migration identity drifted',
    );
  }
  const schema3To4Upgrade = renderSchema3To4Upgrade(
    schema3Source,
    schema4Source,
  );
  const schema4To5Upgrade = renderSchema4To5Upgrade(
    schema4Source,
    schema5Source,
  );
  const schema5To6Upgrade = renderSchema5To6Upgrade(schema5Source, source);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-g1-schema-'),
  );
  const databasePath = path.join(temporaryRoot, 'workflow-runtime.db');
  const schema3DatabasePath = path.join(
    temporaryRoot,
    'workflow-runtime-schema3.db',
  );
  const schema4DatabasePath = path.join(
    temporaryRoot,
    'workflow-runtime-schema4.db',
  );
  const schema5DatabasePath = path.join(
    temporaryRoot,
    'workflow-runtime-schema5.db',
  );
  const schema3Database = createMigratedDatabase(
    schema3DatabasePath,
    schema3Migration.sql,
  );
  let schema3SqliteSchemaIdentity: string;
  try {
    schema3SqliteSchemaIdentity =
      calculateDatabaseSqliteSchemaIdentity(schema3Database);
  } finally {
    schema3Database.close();
  }
  const schema4Database = createMigratedDatabase(
    schema4DatabasePath,
    schema4Migration.sql,
  );
  let schema4SqliteSchemaIdentity: string;
  try {
    schema4SqliteSchemaIdentity =
      calculateDatabaseSqliteSchemaIdentity(schema4Database);
  } finally {
    schema4Database.close();
  }
  const schema5Database = createMigratedDatabase(
    schema5DatabasePath,
    schema5Migration.sql,
  );
  let schema5SqliteSchemaIdentity: string;
  try {
    schema5SqliteSchemaIdentity =
      calculateDatabaseSqliteSchemaIdentity(schema5Database);
    if (
      schema5SqliteSchemaIdentity !==
      'sha256:5ee3c119cc6a0e0552e2a6fe45b51c8ffd08ec7acdbac66748978ed0d21fdb0a'
    ) {
      throw new Error(
        'Reproducible historical Schema 5 SQLite identity drifted',
      );
    }
  } finally {
    schema5Database.close();
  }
  const database = createMigratedDatabase(databasePath, migration.sql);
  let manifestPayload: WorkflowRuntimeSchemaManifestPayload;
  let environmentSummary: ReturnType<typeof collectSqliteEnvironmentEvidence>;
  try {
    manifestPayload = reconstructSchemaManifest(
      database,
      source,
      migration.sql,
      migration.statement_count,
      migration.triggers,
    );
    assertClosedSchemaManifest(manifestPayload);
    if (
      calculateDatabaseSqliteSchemaIdentity(database) !==
      calculateManifestSqliteSchemaIdentity(manifestPayload)
    ) {
      throw new Error('Schema 6 SQLite identity differs from its Manifest');
    }
    runSchemaLint(source, manifestPayload, migration.sql);
    verifyQueryPlans(database, buildQueryFixtures(source));
    environmentSummary = collectSqliteEnvironmentEvidence(database);
  } finally {
    database.close();
  }
  verifyReadOnlyConnection(databasePath);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });

  const manifestContract = buildManifestContractArtifact();
  const manifest = buildArtifact(
    'icarus.workflow-runtime-schema-manifest/1',
    'icarus.workflow-runtime-schema-manifest',
    'icarus:workflow-runtime-schema-manifest:1\n',
    payloadAsJsonObject(manifestPayload),
  );
  const dependencyManifestContract = buildDependencyManifestContractArtifact();
  const dependencyManifest = buildSchemaDependencyManifestArtifact(
    manifest,
    migration.sql,
    { contractsRoot: options.contractsRoot },
    schema3To4Upgrade.sql,
    schema4To5Upgrade.sql,
    schema5To6Upgrade.sql,
  );
  const executableDdl = buildArtifact(
    'icarus.workflow-runtime-executable-ddl/1',
    'icarus.workflow-runtime-executable-ddl',
    'icarus:workflow-runtime-executable-ddl:1\n',
    {
      schema_id: source.schema_id,
      database_schema_version: source.database_schema_version,
      logical_inputs: source.logical_inputs,
      migration_path: G1_ARTIFACT_PATHS.migration,
      migration_sha256: rawSha256(migration.sql),
      schema3_to_schema4_upgrade_path: G1_ARTIFACT_PATHS.schema3To4Upgrade,
      schema3_to_schema4_upgrade_sha256: rawSha256(schema3To4Upgrade.sql),
      schema4_to_schema5_upgrade_path: G1_ARTIFACT_PATHS.schema4To5Upgrade,
      schema4_to_schema5_upgrade_sha256: rawSha256(schema4To5Upgrade.sql),
      schema5_to_schema6_upgrade_path: G1_ARTIFACT_PATHS.schema5To6Upgrade,
      schema5_to_schema6_upgrade_sha256: rawSha256(schema5To6Upgrade.sql),
      schema3_source_migration_sha256: rawSha256(schema3Migration.sql),
      schema3_source_sqlite_schema_identity: schema3SqliteSchemaIdentity,
      schema4_source_migration_sha256: rawSha256(schema4Migration.sql),
      schema4_source_sqlite_schema_identity: schema4SqliteSchemaIdentity,
      schema5_source_migration_sha256: rawSha256(schema5Migration.sql),
      schema5_source_sqlite_schema_identity: schema5SqliteSchemaIdentity,
      sqlite_schema_identity:
        calculateManifestSqliteSchemaIdentity(manifestPayload),
      schema3_upgrade_mode: 'empty_activation_state_only_or_fail_closed',
      schema4_upgrade_mode:
        'rebuild_capacity_invocations_preserve_all_rows_or_fail_closed',
      schema5_upgrade_mode:
        'rebuild_workflow_values_preserve_all_rows_and_inbound_foreign_keys_or_fail_closed',
      schema3_required_empty_relations: [
        'workflow_feature_release_activation_commands',
        'workflow_feature_release_activation_invocations',
        'workflow_feature_release_activation_events',
        'workflow_feature_active_releases',
      ],
      statement_count: migration.statement_count,
      table_count: source.tables.length,
      trigger_count: migration.triggers.length,
      schema_hash: manifestPayload.schema_hash,
      executable_status: 'canonical_migration',
    } as unknown as JsonObject,
  );
  const queryFixtures = buildArtifact(
    'icarus.workflow-runtime-query-plan-fixtures/1',
    'icarus.workflow-runtime-query-plan-fixtures',
    'icarus:workflow-runtime-query-plan-fixtures:1\n',
    {
      schema_hash: manifestPayload.schema_hash,
      execution_target: 'real_file_sqlite',
      query_count: source.queries.length,
      fixtures: asJson(buildQueryFixtures(source)),
      required_coverage: [
        'scheduler',
        'watchdog',
        'recovery',
        't6e',
        't3',
        't7',
        'root_finalization',
        'gc',
        'outbox',
        'command',
        'capacity',
        'checkpoint',
      ],
    },
  );
  const constraintFixtures = buildConstraintFixtureArtifact(source);
  const schemaLint = buildSchemaLintArtifact(source);
  const domains = buildArtifact(
    'icarus.workflow-runtime-schema-domain-separators/1',
    'icarus.workflow-runtime-schema-domain-separators',
    'icarus:workflow-runtime-schema-domain-separators:1\n',
    {
      entries: [
        'icarus:workflow-runtime-schema:1\n',
        ACTIVATION_SCHEMA_INPUT_DOMAIN,
        ACTIVATION_SCHEMA_DELTA_DOMAIN,
        ACTIVATION_REPAIR_SCHEMA_INPUT_DOMAIN,
        ACTIVATION_REPAIR_SCHEMA_DELTA_DOMAIN,
        GENERATED_SCHEMA_INPUT_DOMAIN,
        GENERATED_SCHEMA_DELTA_DOMAIN,
        GENERATED_SCHEMA_DOMAIN,
        GENERATED_SCHEMA_PARAMETER_DOMAIN,
        GENERATED_SCHEMA_PLAN_BINDING_DOMAIN,
        SQLITE_SCHEMA_IDENTITY_DOMAIN_SEPARATOR,
        G1_SCHEMA_DEPENDENCY_MANIFEST_DOMAIN_SEPARATOR,
        G1_PHYSICAL_SCHEMA_IDENTITY_DOMAIN_SEPARATOR,
        dependencyManifestContract.domain_separator,
        manifestContract.domain_separator,
        manifest.domain_separator,
        executableDdl.domain_separator,
        queryFixtures.domain_separator,
        constraintFixtures.domain_separator,
        schemaLint.domain_separator,
        'icarus:workflow-runtime-schema-determinism:1\n',
        'icarus:workflow-runtime-schema-domain-separators:1\n',
        'icarus:workflow-contract-pack-g1-executable-schema:1\n',
      ].sort(),
    },
  );
  const members: Array<[string, ContractArtifactEnvelope]> = [
    [
      G1_ARTIFACT_PATHS.publisherInput,
      buildPublisherSchemaPrerequisiteArtifact(),
    ],
    [
      G1_ARTIFACT_PATHS.activationInput,
      buildActivationSchemaPrerequisiteArtifact(),
    ],
    [
      G1_ARTIFACT_PATHS.activationRepairInput,
      buildActivationRepairSchemaPrerequisiteArtifact(),
    ],
    [
      G1_ARTIFACT_PATHS.generatedSchemaInput,
      buildGeneratedSchemaPrerequisiteArtifact(),
    ],
    [G1_ARTIFACT_PATHS.dependencyManifestContract, dependencyManifestContract],
    [G1_ARTIFACT_PATHS.dependencyManifest, dependencyManifest],
    [G1_ARTIFACT_PATHS.manifestContract, manifestContract],
    [G1_ARTIFACT_PATHS.manifest, manifest],
    [G1_ARTIFACT_PATHS.executableDdl, executableDdl],
    [G1_ARTIFACT_PATHS.queryFixtures, queryFixtures],
    [G1_ARTIFACT_PATHS.constraintFixtures, constraintFixtures],
    [G1_ARTIFACT_PATHS.schemaLint, schemaLint],
    [G1_ARTIFACT_PATHS.domains, domains],
  ];
  const root = buildArtifact(
    'icarus.workflow-contract-pack-g1-executable-schema/1',
    'icarus.workflow-contract-pack-g1-executable-schema',
    'icarus:workflow-contract-pack-g1-executable-schema:1\n',
    {
      gate: 'G1.1',
      status: 'executable_ddl_schema_manifest',
      schema_dependency_manifest_hash: dependencyManifest.hash,
      physical_schema_identity: (
        dependencyManifest.payload as unknown as G1SchemaDependencyManifestPayload
      ).physical_schema_identity,
      schema_hash: manifestPayload.schema_hash,
      migration_sha256: rawSha256(migration.sql),
      schema3_to_schema4_upgrade_sha256: rawSha256(schema3To4Upgrade.sql),
      schema4_to_schema5_upgrade_sha256: rawSha256(schema4To5Upgrade.sql),
      schema5_to_schema6_upgrade_sha256: rawSha256(schema5To6Upgrade.sql),
      schema3_source_migration_sha256: rawSha256(schema3Migration.sql),
      schema3_source_sqlite_schema_identity: schema3SqliteSchemaIdentity,
      schema4_source_migration_sha256: rawSha256(schema4Migration.sql),
      schema4_source_sqlite_schema_identity: schema4SqliteSchemaIdentity,
      schema5_source_migration_sha256: rawSha256(schema5Migration.sql),
      schema5_source_sqlite_schema_identity: schema5SqliteSchemaIdentity,
      sqlite_schema_identity:
        calculateManifestSqliteSchemaIdentity(manifestPayload),
      deterministic_digest: domainSeparatedSha256(
        'icarus:workflow-runtime-schema-determinism:1\n',
        asJson({
          migration_sha256: rawSha256(migration.sql),
          schema3_to_schema4_upgrade_sha256: rawSha256(schema3To4Upgrade.sql),
          schema4_to_schema5_upgrade_sha256: rawSha256(schema4To5Upgrade.sql),
          schema5_to_schema6_upgrade_sha256: rawSha256(schema5To6Upgrade.sql),
          schema_hash: manifestPayload.schema_hash,
          member_hashes: members.map(([, artifact]) => artifact.hash),
        }),
      ),
      member_count: members.length,
      members: members.map(([artifactPath, artifact]) => ({
        path: artifactPath,
        format: artifact.format,
        hash: artifact.hash,
      })),
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
      environment_verification: [
        'database_and_connection_pragmas',
        'sqlite_version_source_id_compile_options',
        'better_sqlite3_version_and_native_module',
        'managed_node_distribution_and_executable',
      ],
      absent_components: [
        'workflow_runtime_store',
        'sqlite_connection_factory',
        'runtime_query_api',
        'workflow_runtime',
        'scheduler',
        'compiler_or_golden',
        'registry',
        'runtime_center_or_ui',
        'production_activation',
        'supported_limits_certification',
      ],
    },
  );
  members.push([G1_ARTIFACT_PATHS.root, root]);
  return {
    migrationSql: migration.sql,
    schema3To4UpgradeSql: schema3To4Upgrade.sql,
    schema4To5UpgradeSql: schema4To5Upgrade.sql,
    schema5To6UpgradeSql: schema5To6Upgrade.sql,
    manifest,
    dependencyManifest,
    artifacts: members,
    schemaHash: manifestPayload.schema_hash,
    environmentSummary,
  };
}

function renderJson(artifact: ContractArtifactEnvelope): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function absoluteSchemaPath(relativePath: string): string {
  const absolute = path.resolve(schemaRoot, relativePath);
  if (!absolute.startsWith(`${schemaRoot}${path.sep}`)) {
    throw new Error(`Schema artifact escapes root: ${relativePath}`);
  }
  return absolute;
}

function writeAtomic(relativePath: string, bytes: string): void {
  const absolute = absoluteSchemaPath(relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, absolute);
}

export function generateG1Artifacts(): BuiltG1Artifacts {
  writeAtomic(
    G1_ARTIFACT_PATHS.publisherInput,
    renderJson(buildPublisherSchemaPrerequisiteArtifact()),
  );
  writeAtomic(
    G1_ARTIFACT_PATHS.activationInput,
    renderJson(buildActivationSchemaPrerequisiteArtifact()),
  );
  writeAtomic(
    G1_ARTIFACT_PATHS.activationRepairInput,
    renderJson(buildActivationRepairSchemaPrerequisiteArtifact()),
  );
  writeAtomic(
    G1_ARTIFACT_PATHS.generatedSchemaInput,
    renderJson(buildGeneratedSchemaPrerequisiteArtifact()),
  );
  const built = buildG1Artifacts();
  writeAtomic(G1_ARTIFACT_PATHS.migration, built.migrationSql);
  writeAtomic(G1_ARTIFACT_PATHS.schema3To4Upgrade, built.schema3To4UpgradeSql);
  writeAtomic(G1_ARTIFACT_PATHS.schema4To5Upgrade, built.schema4To5UpgradeSql);
  writeAtomic(G1_ARTIFACT_PATHS.schema5To6Upgrade, built.schema5To6UpgradeSql);
  for (const [artifactPath, artifact] of built.artifacts) {
    writeAtomic(artifactPath, renderJson(artifact));
  }
  return built;
}

export function checkG1Artifacts(): BuiltG1Artifacts {
  const expectedPublisherInput = renderJson(
    buildPublisherSchemaPrerequisiteArtifact(),
  );
  const actualPublisherInput = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.publisherInput),
    'utf8',
  );
  if (actualPublisherInput !== expectedPublisherInput) {
    throw new Error(
      `${G1_ARTIFACT_PATHS.publisherInput} drifted; run npm run schema:generate`,
    );
  }
  const expectedActivationInput = renderJson(
    buildActivationSchemaPrerequisiteArtifact(),
  );
  const actualActivationInput = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.activationInput),
    'utf8',
  );
  if (actualActivationInput !== expectedActivationInput) {
    throw new Error(
      `${G1_ARTIFACT_PATHS.activationInput} drifted; run npm run schema:generate`,
    );
  }
  const expectedActivationRepairInput = renderJson(
    buildActivationRepairSchemaPrerequisiteArtifact(),
  );
  const actualActivationRepairInput = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.activationRepairInput),
    'utf8',
  );
  if (actualActivationRepairInput !== expectedActivationRepairInput) {
    throw new Error(
      `${G1_ARTIFACT_PATHS.activationRepairInput} drifted; run npm run schema:generate`,
    );
  }
  const expectedGeneratedSchemaInput = renderJson(
    buildGeneratedSchemaPrerequisiteArtifact(),
  );
  const actualGeneratedSchemaInput = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.generatedSchemaInput),
    'utf8',
  );
  if (actualGeneratedSchemaInput !== expectedGeneratedSchemaInput) {
    throw new Error(
      `${G1_ARTIFACT_PATHS.generatedSchemaInput} drifted; run npm run schema:generate`,
    );
  }
  const built = buildG1Artifacts();
  const migrationBytes = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.migration),
    'utf8',
  );
  if (migrationBytes !== built.migrationSql) {
    throw new Error('Canonical migration drifted; run npm run schema:generate');
  }
  const upgradeBytes = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.schema3To4Upgrade),
    'utf8',
  );
  if (upgradeBytes !== built.schema3To4UpgradeSql) {
    throw new Error(
      'Schema 3 to 4 upgrade drifted; run npm run schema:generate',
    );
  }
  const schema4To5UpgradeBytes = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.schema4To5Upgrade),
    'utf8',
  );
  if (schema4To5UpgradeBytes !== built.schema4To5UpgradeSql) {
    throw new Error(
      'Schema 4 to 5 upgrade drifted; run npm run schema:generate',
    );
  }
  const schema5To6UpgradeBytes = fs.readFileSync(
    absoluteSchemaPath(G1_ARTIFACT_PATHS.schema5To6Upgrade),
    'utf8',
  );
  if (schema5To6UpgradeBytes !== built.schema5To6UpgradeSql) {
    throw new Error(
      'Schema 5 to 6 upgrade drifted; run npm run schema:generate',
    );
  }
  for (const [artifactPath, artifact] of built.artifacts) {
    const actual = fs.readFileSync(absoluteSchemaPath(artifactPath), 'utf8');
    if (actual !== renderJson(artifact)) {
      throw new Error(`${artifactPath} drifted; run npm run schema:generate`);
    }
  }
  return built;
}
