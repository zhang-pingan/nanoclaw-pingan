import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
} from '../../contracts/logical-schema-types.js';
import type { JsonObject, Sha256Hash } from '../../contracts/types.js';

export const G1_SCHEMA_DEPENDENCY_ROLES = [
  'g0_6_logical_schema_manifest',
  'logical_schema_source',
  'typed_relation_catalog',
  'query_catalog',
  'g0_10_capacity_logical_schema_delta',
  'publisher_schema_prerequisite',
  'feature_release_activation_schema_prerequisite',
  'activation_failure_replay_schema_prerequisite',
  'sqlite_execution_profile',
  'schema_manifest',
  'canonical_migration',
  'schema3_to_schema4_upgrade',
  'schema4_to_schema5_upgrade',
] as const;

export type G1SchemaDependencyRole =
  (typeof G1_SCHEMA_DEPENDENCY_ROLES)[number];

export interface G1SchemaDependencyMember extends JsonObject {
  role: G1SchemaDependencyRole;
  identity_effect:
    | 'construction_provenance'
    | 'physical_schema_input'
    | 'physical_schema_output';
  path: string;
  format: string;
  ref: { id: string; version: string } & JsonObject;
  version: number;
  semantic_hash: Sha256Hash;
  raw_sha256: Sha256Hash;
}

export interface G1SchemaDependencyManifestPayload extends JsonObject {
  dependency_set_id: 'workflow-runtime-schema-v1';
  identity_scope: 'physical_schema_and_migration';
  member_count: 13;
  physical_member_count: 12;
  construction_provenance_count: 1;
  members: G1SchemaDependencyMember[] & JsonObject[];
  physical_schema_identity: Sha256Hash;
}

export interface ExecutableSchemaSource {
  schema_id: 'workflow-runtime-schema-v1';
  database_schema_version: 3 | 4 | 5;
  tables: LogicalTableMetadata[];
  queries: LogicalQueryIntent[];
  logical_inputs: SchemaLogicalInputs;
}

export interface SchemaLogicalInputs {
  logical_schema_source_hash: Sha256Hash;
  typed_relation_catalog_hash: Sha256Hash;
  query_catalog_hash: Sha256Hash;
  capacity_delta_hash: Sha256Hash;
  publisher_schema_prerequisite_hash: Sha256Hash;
  feature_release_activation_schema_prerequisite_hash: Sha256Hash;
  activation_failure_replay_schema_prerequisite_hash: Sha256Hash;
  sqlite_profile_hash: Sha256Hash;
}

export interface SchemaTriggerDefinition {
  name: string;
  table: string;
  timing: 'before' | 'after';
  event: 'insert' | 'update' | 'delete';
  owner_intent: string;
  sql: string;
}

export interface SchemaQueryFixture {
  query_id: string;
  owner: string;
  coverage_area:
    | 'scheduler'
    | 'watchdog'
    | 'recovery'
    | 't6e'
    | 't3'
    | 't7'
    | 'root_finalization'
    | 'gc'
    | 'outbox'
    | 'command'
    | 'checkpoint'
    | 'capacity';
  sql: string;
  parameter_count: number;
  required_index_id: string;
}

export interface SchemaManifestColumn {
  cid: number;
  name: string;
  sqlite_type: string;
  nullable: boolean;
  default_sql: string | null;
  primary_key_ordinal: number;
  logical_type: LogicalColumnMetadata['logical_type'];
  external_reference: LogicalColumnMetadata['external_reference'];
}

export interface SchemaManifestPrimaryKey {
  columns: string[];
  auto_increment: boolean;
}

export interface SchemaManifestForeignKey extends LogicalForeignKeyMetadata {
  pragma_id: number;
}

export interface SchemaManifestUniqueKey extends LogicalUniqueKeyMetadata {
  origin: string;
  sql: string;
}

export interface SchemaManifestCheck extends LogicalCheckMetadata {
  expression_sql: string;
}

export interface SchemaManifestIndex extends LogicalIndexMetadata {
  unique: boolean;
  sql: string;
}

export interface SchemaManifestTable {
  ordinal: number;
  name: string;
  sql: string;
  columns: SchemaManifestColumn[];
  primary_key: SchemaManifestPrimaryKey;
  unique_keys: SchemaManifestUniqueKey[];
  foreign_keys: SchemaManifestForeignKey[];
  checks: SchemaManifestCheck[];
  indexes: SchemaManifestIndex[];
}

export interface SchemaManifestTrigger extends SchemaTriggerDefinition {}

export interface WorkflowRuntimeSchemaManifestPayload extends JsonObject {
  schema_id: 'workflow-runtime-schema-v1';
  database_name: 'workflow-runtime.db';
  database_schema_version: 5;
  logical_inputs: SchemaLogicalInputs & JsonObject;
  migration_path: string;
  migration_sha256: Sha256Hash;
  migration_statement_count: number;
  table_count: number;
  column_count: number;
  primary_key_count: number;
  unique_key_count: number;
  foreign_key_count: number;
  check_count: number;
  index_count: number;
  trigger_count: number;
  external_reference_count: number;
  tables: SchemaManifestTable[] & JsonObject[];
  triggers: SchemaManifestTrigger[] & JsonObject[];
  query_fixtures: SchemaQueryFixture[] & JsonObject[];
  schema_hash: Sha256Hash;
}

export interface SqliteEnvironmentEvidence {
  managed_node_version: string;
  managed_node_exec_path: string;
  managed_distribution_hash: Sha256Hash;
  better_sqlite3_version: string;
  native_module_path: string;
  native_module_sha256: Sha256Hash;
  sqlite_version: string;
  sqlite_source_id: string;
  compile_options: string[];
  compile_options_hash: Sha256Hash;
}
