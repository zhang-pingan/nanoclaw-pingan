import type {
  LogicalColumnMetadata,
  LogicalIndexMetadata,
  LogicalQueryIntent,
  LogicalTableMetadata,
  LogicalUniqueKeyMetadata,
} from '../../contracts/logical-schema-types.js';
import { renderCheckExpression } from './check-expressions.js';
import type {
  ExecutableSchemaSource,
  SchemaQueryFixture,
  SchemaTriggerDefinition,
} from './types.js';

export const MIGRATION_RELATIVE_PATH =
  'migration/workflow-runtime-schema-v8.sql';

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
}

function columnComment(column: LogicalColumnMetadata): string {
  const parts = [`logical_type=${column.logical_type}`];
  if (column.external_reference) {
    parts.push(
      'external_ref=1',
      `validator_owner=${column.external_reference.validator_owner}`,
      `reference_domain=${column.external_reference.reference_domain}`,
      `immutable=${column.external_reference.immutable ? 1 : 0}`,
    );
  }
  return `/* ${parts.join(' ')} */`;
}

function renderColumn(
  table: LogicalTableMetadata,
  column: LogicalColumnMetadata,
): string {
  const autoIncrement =
    table.primary_key.auto_increment_intent &&
    table.primary_key.columns.length === 1 &&
    table.primary_key.columns[0] === column.name;
  const parts = [q(column.name), column.sqlite_type_intent];
  if (autoIncrement) parts.push('PRIMARY KEY AUTOINCREMENT');
  if (!column.nullable) parts.push('NOT NULL');
  if (column.default_intent !== null) {
    parts.push('DEFAULT', sqlLiteral(column.default_intent));
  }
  parts.push(columnComment(column));
  return parts.join(' ');
}

const SCHEMA4_CAPACITY_INVOCATION_RESULT_CHECK =
  '(("authorization_result" = \'denied\' AND "execution_result" = \'denied\' AND "denial_code" IS NOT NULL AND "applied_at_ms" IS NULL) OR ("authorization_result" = \'allowed\' AND (("execution_result" = \'applied\' AND "denial_code" IS NULL AND "applied_at_ms" IS NOT NULL) OR ("execution_result" IN (\'conflict\', \'duplicate\', \'failed\') AND "applied_at_ms" IS NULL))))';

export function renderTable(
  table: LogicalTableMetadata,
  databaseSchemaVersion?: ExecutableSchemaSource['database_schema_version'],
): string {
  const definitions: string[] = table.columns.map((column) =>
    renderColumn(table, column),
  );
  if (!table.primary_key.auto_increment_intent) {
    definitions.push(
      `CONSTRAINT ${q(`pk:${table.name}`)} PRIMARY KEY (${table.primary_key.columns
        .map(q)
        .join(', ')})`,
    );
  }
  for (const foreignKey of table.foreign_keys) {
    const action = foreignKey.on_delete.replace('_', ' ').toUpperCase();
    const deferrability =
      foreignKey.deferrability === 'deferred'
        ? 'DEFERRABLE INITIALLY DEFERRED'
        : 'NOT DEFERRABLE';
    definitions.push(
      `CONSTRAINT ${q(foreignKey.relation_id)} FOREIGN KEY (${foreignKey.source_columns
        .map(q)
        .join(
          ', ',
        )}) REFERENCES ${q(foreignKey.target_table)} (${foreignKey.target_columns
        .map(q)
        .join(', ')}) ON DELETE ${action} ${deferrability}`,
    );
  }
  for (const check of table.checks) {
    const expression =
      databaseSchemaVersion !== undefined &&
      databaseSchemaVersion <= 4 &&
      check.check_id === 'ck:capacity_invocations:result_consistency'
        ? SCHEMA4_CAPACITY_INVOCATION_RESULT_CHECK
        : renderCheckExpression(check, table.columns);
    definitions.push(
      `CONSTRAINT ${q(check.check_id)} CHECK (${expression}) /* check_kind=${check.kind} logical_columns=${check.columns.join(',')} */`,
    );
  }
  return `CREATE TABLE ${q(table.name)} (\n${definitions
    .map((definition) => `  ${definition}`)
    .join(',\n')}\n)`;
}

export function renderPredicateIntent(intent: string): string {
  const normalized = intent.trim();
  const oneOf = normalized.match(
    /^([a-z0-9_]+) is one of ([a-z0-9_]+(?: \| [a-z0-9_]+)+)$/,
  );
  if (oneOf) {
    return `${q(oneOf[1])} IN (${oneOf[2]
      .split(' | ')
      .map((value) => `'${value}'`)
      .join(', ')})`;
  }
  const inValues = normalized.match(/^([a-z0-9_]+) in \((.+)\)$/);
  if (inValues) return `${q(inValues[1])} IN (${inValues[2]})`;
  const bothNotNull = normalized.match(
    /^([a-z0-9_]+) and ([a-z0-9_]+) are not null$/,
  );
  if (bothNotNull) {
    return `${q(bothNotNull[1])} IS NOT NULL AND ${q(bothNotNull[2])} IS NOT NULL`;
  }
  const clauses = normalized.split(' and ');
  if (clauses.length > 1) {
    return clauses.map(renderPredicateIntent).join(' AND ');
  }
  const nonNull = normalized.match(/^([a-z0-9_]+) is non-null$/);
  if (nonNull) return `${q(nonNull[1])} IS NOT NULL`;
  const notNull = normalized.match(/^([a-z0-9_]+) is not null$/);
  if (notNull) return `${q(notNull[1])} IS NOT NULL`;
  const isNull = normalized.match(/^([a-z0-9_]+) is null$/);
  if (isNull) return `${q(isNull[1])} IS NULL`;
  const equals = normalized.match(/^([a-z0-9_]+) = '([a-z0-9_]+)'$/);
  if (equals) return `${q(equals[1])} = '${equals[2]}'`;
  const equalsNumber = normalized.match(/^([a-z0-9_]+) equals ([0-9]+)$/);
  if (equalsNumber) return `${q(equalsNumber[1])} = ${equalsNumber[2]}`;
  throw new Error(`Predicate intent is not executable: ${intent}`);
}

export function renderUniqueIndex(
  table: LogicalTableMetadata,
  key: LogicalUniqueKeyMetadata,
): string {
  // SQLite foreign keys cannot target a partial UNIQUE index. These nullable
  // lineage keys have equivalent semantics as ordinary UNIQUE indexes because
  // SQLite permits repeated NULL values.
  const fkTargetNullableUnique = new Set([
    'uk:capacity_commands:assigned_change',
    'uk:capacity_commands:assigned_lineage',
  ]);
  const predicate =
    key.predicate_intent && !fkTargetNullableUnique.has(key.key_id)
      ? ` WHERE ${renderPredicateIntent(key.predicate_intent)}`
      : '';
  return `CREATE UNIQUE INDEX ${q(key.key_id)} ON ${q(table.name)} (${key.columns
    .map(q)
    .join(', ')})${predicate}`;
}

export function renderIndex(
  table: LogicalTableMetadata,
  index: LogicalIndexMetadata,
): string {
  const predicate = index.predicate_intent
    ? ` WHERE ${renderPredicateIntent(index.predicate_intent)}`
    : '';
  return `CREATE INDEX ${q(index.index_id)} ON ${q(table.name)} (${index.columns
    .map(q)
    .join(', ')})${predicate}`;
}

function operationalStateSql(runExpression: string): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = ${runExpression} AND b."status" = 'open' AND b."severity" = 'quarantine') THEN 'quarantined' WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = ${runExpression} AND b."status" = 'open' AND b."severity" = 'action_required') THEN 'action_required' ELSE 'healthy' END`;
}

export function buildSchemaTriggers(
  databaseSchemaVersion: 3 | 4 | 5 | 6 | 7 | 8 = 8,
): SchemaTriggerDefinition[] {
  const refreshBody = (row: 'NEW' | 'OLD') => `
  UPDATE "workflow_graph_runs"
     SET "operational_state" = ${operationalStateSql(`${row}."graph_run_id"`)},
         "row_version" = "row_version" + 1
   WHERE "id" = ${row}."graph_run_id"
     AND "operational_state" <> 'administratively_abandoned';
  UPDATE "workflows"
     SET "operational_state" = ${operationalStateSql(`${row}."graph_run_id"`)},
         "row_version" = "row_version" + 1,
         "updated_at_ms" = CASE WHEN "updated_at_ms" < ${row}."opened_at_ms" THEN ${row}."opened_at_ms" ELSE "updated_at_ms" END
   WHERE "id" = ${row}."workflow_id"
     AND "operational_state" <> 'administratively_abandoned';`;
  const triggers: SchemaTriggerDefinition[] = [
    {
      name: 'trg:operational_blockers:insert_cache',
      table: 'workflow_operational_blockers',
      timing: 'after',
      event: 'insert',
      owner_intent: 'T6e operational-state cache maintenance',
      sql: `CREATE TRIGGER ${q('trg:operational_blockers:insert_cache')} AFTER INSERT ON ${q('workflow_operational_blockers')} BEGIN${refreshBody('NEW')}\nEND`,
    },
    {
      name: 'trg:operational_blockers:update_cache',
      table: 'workflow_operational_blockers',
      timing: 'after',
      event: 'update',
      owner_intent: 'T6e operational-state cache maintenance',
      sql: `CREATE TRIGGER ${q('trg:operational_blockers:update_cache')} AFTER UPDATE OF "status", "severity" ON ${q('workflow_operational_blockers')} WHEN OLD."status" IS NOT NEW."status" OR OLD."severity" IS NOT NEW."severity" BEGIN${refreshBody('NEW')}\nEND`,
    },
    {
      name: 'trg:intake_revisions:adjacent_parent',
      table: 'workflow_task_intake_revisions',
      timing: 'after',
      event: 'insert',
      owner_intent: 'append-only intake revision adjacency',
      sql: `CREATE TRIGGER ${q('trg:intake_revisions:adjacent_parent')} AFTER INSERT ON ${q('workflow_task_intake_revisions')} WHEN NEW."revision_no" > 0 BEGIN\n  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_task_intake_revisions" AS parent WHERE parent."id" = NEW."parent_revision_id" AND parent."intake_id" = NEW."intake_id" AND parent."revision_no" = NEW."revision_no" - 1) THEN RAISE(ABORT, 'intake_revision_parent_not_adjacent') END;\nEND`,
    },
    {
      name: 'trg:scopes:nullable_plan_close',
      table: 'workflow_graph_scopes',
      timing: 'before',
      event: 'update',
      owner_intent:
        'root setup error or cancel before closing a planless shell',
      sql: `CREATE TRIGGER ${q('trg:scopes:nullable_plan_close')} BEFORE UPDATE OF "lifecycle", "plan_id" ON ${q('workflow_graph_scopes')} WHEN NEW."plan_id" IS NULL AND NEW."lifecycle" IN ('closing', 'closed') BEGIN\n  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_graph_scope_close_requests" AS request WHERE request."scope_id" = NEW."id" AND request."graph_run_id" = NEW."graph_run_id" AND request."reason" IN ('engine_error', 'local_cancel', 'workflow_cancel')) THEN RAISE(ABORT, 'planless_root_close_without_setup_error_or_cancel') END;\nEND`,
    },
    {
      name: 'trg:command_confirmations:ttl_insert',
      table: 'workflow_runtime_command_confirmations',
      timing: 'after',
      event: 'insert',
      owner_intent: 'intent-bound administrative-abandon confirmation TTL',
      sql: `CREATE TRIGGER ${q('trg:command_confirmations:ttl_insert')} AFTER INSERT ON ${q('workflow_runtime_command_confirmations')} BEGIN\n  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_runtime_commands" AS command WHERE command."command_id" = NEW."request_command_id" AND NEW."expires_at_ms" = command."created_at_ms" + 300000) THEN RAISE(ABORT, 'command_confirmation_ttl_invalid') END;\nEND`,
    },
    {
      name: 'trg:command_confirmations:ttl_update',
      table: 'workflow_runtime_command_confirmations',
      timing: 'before',
      event: 'update',
      owner_intent:
        'immutable intent-bound administrative-abandon confirmation TTL',
      sql: `CREATE TRIGGER ${q('trg:command_confirmations:ttl_update')} BEFORE UPDATE OF "request_command_id", "expires_at_ms" ON ${q('workflow_runtime_command_confirmations')} BEGIN\n  SELECT CASE WHEN NEW."request_command_id" IS NOT OLD."request_command_id" OR NEW."expires_at_ms" IS NOT OLD."expires_at_ms" THEN RAISE(ABORT, 'command_confirmation_ttl_is_immutable') END;\nEND`,
    },
    {
      name: 'trg:capacity_events:hash_chain',
      table: 'runtime_capacity_change_events',
      timing: 'after',
      event: 'insert',
      owner_intent: 'global append-only Capacity event hash chain',
      sql: `CREATE TRIGGER ${q('trg:capacity_events:hash_chain')} AFTER INSERT ON ${q('runtime_capacity_change_events')} BEGIN\n  SELECT CASE WHEN (NEW."event_seq" = 1 AND NEW."previous_event_hash" IS NOT NULL) OR (NEW."event_seq" > 1 AND (SELECT previous."event_hash" FROM "runtime_capacity_change_events" AS previous WHERE previous."event_seq" = NEW."event_seq" - 1) IS NOT NEW."previous_event_hash") THEN RAISE(ABORT, 'capacity_event_hash_chain_invalid') END;\nEND`,
    },
    {
      name: 'trg:capacity_events:immutable_update',
      table: 'runtime_capacity_change_events',
      timing: 'before',
      event: 'update',
      owner_intent: 'append-only Capacity event audit',
      sql: `CREATE TRIGGER ${q('trg:capacity_events:immutable_update')} BEFORE UPDATE ON ${q('runtime_capacity_change_events')} BEGIN\n  SELECT RAISE(ABORT, 'capacity_event_is_immutable');\nEND`,
    },
    {
      name: 'trg:capacity_events:immutable_delete',
      table: 'runtime_capacity_change_events',
      timing: 'before',
      event: 'delete',
      owner_intent: 'append-only Capacity event audit',
      sql: `CREATE TRIGGER ${q('trg:capacity_events:immutable_delete')} BEFORE DELETE ON ${q('runtime_capacity_change_events')} BEGIN\n  SELECT RAISE(ABORT, 'capacity_event_is_immutable');\nEND`,
    },
    {
      name: 'trg:capacity_head:commit_transition',
      table: 'runtime_capacity_head',
      timing: 'before',
      event: 'update',
      owner_intent: 'CAP3 strict revision and pending-change commit',
      sql: `CREATE TRIGGER ${q('trg:capacity_head:commit_transition')} BEFORE UPDATE OF "current_capacity_revision", "current_change_id", "current_config_hash", "current_publication_hash" ON ${q('runtime_capacity_head')} WHEN NEW."current_change_id" IS NOT OLD."current_change_id" BEGIN\n  SELECT CASE WHEN OLD."pending_change_id" IS NOT NEW."current_change_id" OR NEW."pending_change_id" IS NOT NULL OR NEW."current_capacity_revision" <> COALESCE(OLD."current_capacity_revision", 0) + 1 THEN RAISE(ABORT, 'capacity_head_commit_transition_invalid') END;\nEND`,
    },
    {
      name: 'trg:publisher_commands:immutable_identity',
      table: 'workflow_publisher_commands',
      timing: 'before',
      event: 'update',
      owner_intent:
        'immutable Publisher caller request review and target identity',
      sql: `CREATE TRIGGER ${q('trg:publisher_commands:immutable_identity')} BEFORE UPDATE OF "command_type", "idempotency_domain", "idempotency_key", "request_value_id", "request_hash", "request_schema_resource_id", "request_schema_hash", "domain_request_hash", "approved_review_ref", "approved_review_hash", "reviewer_actor_ref", "reviewer_auth_session_ref", "approved_at_ms", "expires_at_ms", "source_manifest_value_id", "source_manifest_hash", "source_manifest_schema_resource_id", "source_manifest_schema_hash", "compiled_plan_value_id", "compiled_plan_hash", "compiled_plan_schema_resource_id", "compiled_plan_schema_hash", "execution_artifact_resource_id", "execution_artifact_hash", "closure_manifest_id", "closure_hash", "target_feature_release_id", "target_feature_release_hash", "created_at_ms" ON ${q('workflow_publisher_commands')} BEGIN\n  SELECT RAISE(ABORT, 'publisher_command_identity_is_immutable');\nEND`,
    },
    {
      name: 'trg:publisher_commands:lifecycle_transition',
      table: 'workflow_publisher_commands',
      timing: 'before',
      event: 'update',
      owner_intent: 'single pending to terminal Publisher command finalization',
      sql: `CREATE TRIGGER ${q('trg:publisher_commands:lifecycle_transition')} BEFORE UPDATE ON ${q('workflow_publisher_commands')} BEGIN\n  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR (NEW."lifecycle" IS NOT OLD."lifecycle" AND OLD."lifecycle" <> 'pending') THEN RAISE(ABORT, 'publisher_command_lifecycle_transition_invalid') END;\nEND`,
    },
    {
      name: 'trg:publisher_commands:immutable_delete',
      table: 'workflow_publisher_commands',
      timing: 'before',
      event: 'delete',
      owner_intent: 'durable Publisher command audit header',
      sql: `CREATE TRIGGER ${q('trg:publisher_commands:immutable_delete')} BEFORE DELETE ON ${q('workflow_publisher_commands')} BEGIN\n  SELECT RAISE(ABORT, 'publisher_command_is_immutable');\nEND`,
    },
    {
      name: 'trg:publisher_invocations:hash_chain',
      table: 'workflow_publisher_command_invocations',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'adjacent per-command authenticated Publisher invocation hash chain',
      sql: `CREATE TRIGGER ${q('trg:publisher_invocations:hash_chain')} AFTER INSERT ON ${q('workflow_publisher_command_invocations')} BEGIN\n  SELECT CASE WHEN (NEW."invocation_no" = 1 AND NEW."previous_invocation_hash" IS NOT NULL) OR (NEW."invocation_no" > 1 AND (SELECT previous."invocation_hash" FROM "workflow_publisher_command_invocations" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."invocation_no" = NEW."invocation_no" - 1) IS NOT NEW."previous_invocation_hash") THEN RAISE(ABORT, 'publisher_invocation_hash_chain_invalid') END;\nEND`,
    },
    {
      name: 'trg:publisher_invocations:immutable_update',
      table: 'workflow_publisher_command_invocations',
      timing: 'before',
      event: 'update',
      owner_intent: 'append-only authenticated Publisher invocation audit',
      sql: `CREATE TRIGGER ${q('trg:publisher_invocations:immutable_update')} BEFORE UPDATE ON ${q('workflow_publisher_command_invocations')} BEGIN\n  SELECT RAISE(ABORT, 'publisher_invocation_is_immutable');\nEND`,
    },
    {
      name: 'trg:publisher_invocations:immutable_delete',
      table: 'workflow_publisher_command_invocations',
      timing: 'before',
      event: 'delete',
      owner_intent: 'append-only authenticated Publisher invocation audit',
      sql: `CREATE TRIGGER ${q('trg:publisher_invocations:immutable_delete')} BEFORE DELETE ON ${q('workflow_publisher_command_invocations')} BEGIN\n  SELECT RAISE(ABORT, 'publisher_invocation_is_immutable');\nEND`,
    },
    {
      name: 'trg:publisher_events:hash_chain',
      table: 'workflow_publisher_events',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'adjacent per-command Publisher phase and recovery event hash chain',
      sql: `CREATE TRIGGER ${q('trg:publisher_events:hash_chain')} AFTER INSERT ON ${q('workflow_publisher_events')} BEGIN\n  SELECT CASE WHEN (NEW."event_no" = 1 AND NEW."previous_event_hash" IS NOT NULL) OR (NEW."event_no" > 1 AND (SELECT previous."event_hash" FROM "workflow_publisher_events" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."event_no" = NEW."event_no" - 1) IS NOT NEW."previous_event_hash") THEN RAISE(ABORT, 'publisher_event_hash_chain_invalid') END;\nEND`,
    },
    {
      name: 'trg:publisher_events:immutable_update',
      table: 'workflow_publisher_events',
      timing: 'before',
      event: 'update',
      owner_intent: 'append-only Publisher phase and recovery audit',
      sql: `CREATE TRIGGER ${q('trg:publisher_events:immutable_update')} BEFORE UPDATE ON ${q('workflow_publisher_events')} BEGIN\n  SELECT RAISE(ABORT, 'publisher_event_is_immutable');\nEND`,
    },
    {
      name: 'trg:publisher_events:immutable_delete',
      table: 'workflow_publisher_events',
      timing: 'before',
      event: 'delete',
      owner_intent: 'append-only Publisher phase and recovery audit',
      sql: `CREATE TRIGGER ${q('trg:publisher_events:immutable_delete')} BEFORE DELETE ON ${q('workflow_publisher_events')} BEGIN\n  SELECT RAISE(ABORT, 'publisher_event_is_immutable');\nEND`,
    },
    {
      name: 'trg:feature_releases:immutable_identity',
      table: 'workflow_feature_releases',
      timing: 'before',
      event: 'update',
      owner_intent: 'immutable Feature Release owner and exact identity',
      sql: `CREATE TRIGGER ${q('trg:feature_releases:immutable_identity')} BEFORE UPDATE OF "id", "feature_id", "release_ref", "release_version", "release_hash", "execution_artifact_resource_id", "execution_artifact_hash", "compatibility_snapshot_ref", "compatibility_snapshot_hash", "staged_at_ms" ON ${q('workflow_feature_releases')} BEGIN\n  SELECT RAISE(ABORT, 'feature_release_identity_is_immutable');\nEND`,
    },
    {
      name: 'trg:feature_releases:lifecycle_transition',
      table: 'workflow_feature_releases',
      timing: 'before',
      event: 'update',
      owner_intent:
        'adjacent Feature Release lifecycle timestamps and row-version CAS',
      sql: `CREATE TRIGGER ${q('trg:feature_releases:lifecycle_transition')} BEFORE UPDATE OF "status", "activated_at_ms", "disabled_at_ms", "row_version" ON ${q('workflow_feature_releases')} BEGIN\n  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR NOT ((OLD."status" = 'staged' AND NEW."status" = 'active' AND NEW."activated_at_ms" IS NOT NULL AND NEW."disabled_at_ms" IS NULL) OR (OLD."status" = 'active' AND NEW."status" = 'draining' AND NEW."activated_at_ms" IS OLD."activated_at_ms" AND NEW."disabled_at_ms" IS NULL) OR (OLD."status" = 'draining' AND NEW."status" = 'disabled' AND NEW."activated_at_ms" IS OLD."activated_at_ms" AND NEW."disabled_at_ms" IS NOT NULL) OR (OLD."status" = 'disabled' AND NEW."status" = 'deleting' AND NEW."activated_at_ms" IS OLD."activated_at_ms" AND NEW."disabled_at_ms" IS OLD."disabled_at_ms")) THEN RAISE(ABORT, 'feature_release_lifecycle_transition_invalid') END;\nEND`,
    },
    {
      name: 'trg:feature_releases:protected_delete',
      table: 'workflow_feature_releases',
      timing: 'before',
      event: 'delete',
      owner_intent: 'active and draining Feature Release delete protection',
      sql: `CREATE TRIGGER ${q('trg:feature_releases:protected_delete')} BEFORE DELETE ON ${q('workflow_feature_releases')} WHEN OLD."status" IN ('active', 'draining') BEGIN\n  SELECT RAISE(ABORT, 'active_or_draining_feature_release_delete_forbidden');\nEND`,
    },
    {
      name: 'trg:feature_active_releases:target_active_insert',
      table: 'workflow_feature_active_releases',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'first owner-consistent active pointer targets an active Release at row version one',
      sql: `CREATE TRIGGER ${q('trg:feature_active_releases:target_active_insert')} AFTER INSERT ON ${q('workflow_feature_active_releases')} BEGIN\n  SELECT CASE WHEN NEW."row_version" <> 1 OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."feature_id" AND release."id" = NEW."release_id" AND release."release_hash" = NEW."release_hash" AND release."status" = 'active') THEN RAISE(ABORT, 'feature_active_release_insert_invalid') END;\nEND`,
    },
    {
      name: 'trg:feature_active_releases:cas_update',
      table: 'workflow_feature_active_releases',
      timing: 'before',
      event: 'update',
      owner_intent:
        'owner-consistent active pointer adjacent CAS and target-active transition',
      sql: `CREATE TRIGGER ${q('trg:feature_active_releases:cas_update')} BEFORE UPDATE ON ${q('workflow_feature_active_releases')} BEGIN\n  SELECT CASE WHEN NEW."feature_id" IS NOT OLD."feature_id" OR NEW."row_version" <> OLD."row_version" + 1 OR (NEW."release_id" IS OLD."release_id" AND NEW."release_hash" IS OLD."release_hash") OR NEW."activated_at_ms" < OLD."activated_at_ms" OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."feature_id" AND release."id" = NEW."release_id" AND release."release_hash" = NEW."release_hash" AND release."status" = 'active') THEN RAISE(ABORT, 'feature_active_release_cas_invalid') END;\nEND`,
    },
    {
      name: 'trg:feature_active_releases:immutable_delete',
      table: 'workflow_feature_active_releases',
      timing: 'before',
      event: 'delete',
      owner_intent: 'active pointer delete protection',
      sql: `CREATE TRIGGER ${q('trg:feature_active_releases:immutable_delete')} BEFORE DELETE ON ${q('workflow_feature_active_releases')} BEGIN\n  SELECT RAISE(ABORT, 'feature_active_release_delete_forbidden');\nEND`,
    },
    {
      name: 'trg:retention_handles:immutable_published_identity',
      table: 'workflow_registry_retention_handles',
      timing: 'before',
      event: 'update',
      owner_intent:
        'immutable published Retention root Release and Closure identity',
      sql: `CREATE TRIGGER ${q('trg:retention_handles:immutable_published_identity')} BEFORE UPDATE OF "id", "handle_kind", "feature_release_id", "graph_run_id", "backup_id", "external_actor_ref", "closure_manifest_id", "closure_hash", "created_at_ms" ON ${q('workflow_registry_retention_handles')} BEGIN\n  SELECT RAISE(ABORT, 'retention_handle_identity_is_immutable');\nEND`,
    },
    {
      name: 'trg:retention_handles:release_transition',
      table: 'workflow_registry_retention_handles',
      timing: 'before',
      event: 'update',
      owner_intent:
        'adjacent held-to-released Retention transition with active Release protection',
      sql: `CREATE TRIGGER ${q('trg:retention_handles:release_transition')} BEFORE UPDATE OF "status", "released_at_ms", "row_version" ON ${q('workflow_registry_retention_handles')} BEGIN\n  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR OLD."status" <> 'held' OR NEW."status" <> 'released' OR (OLD."handle_kind" = 'published' AND EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."id" = OLD."feature_release_id" AND release."status" IN ('active', 'draining'))) THEN RAISE(ABORT, 'retention_handle_release_transition_invalid') END;\nEND`,
    },
    {
      name: 'trg:retention_handles:protected_delete',
      table: 'workflow_registry_retention_handles',
      timing: 'before',
      event: 'delete',
      owner_intent:
        'published Retention delete protection for active and draining Releases',
      sql: `CREATE TRIGGER ${q('trg:retention_handles:protected_delete')} BEFORE DELETE ON ${q('workflow_registry_retention_handles')} WHEN OLD."handle_kind" = 'published' AND EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."id" = OLD."feature_release_id" AND release."status" IN ('active', 'draining')) BEGIN\n  SELECT RAISE(ABORT, 'active_or_draining_release_retention_delete_forbidden');\nEND`,
    },
    {
      name: 'trg:activation_commands:immutable_identity',
      table: 'workflow_feature_release_activation_commands',
      timing: 'before',
      event: 'update',
      owner_intent:
        'immutable Activation caller key canonical request and creation identity',
      sql: `CREATE TRIGGER ${q('trg:activation_commands:immutable_identity')} BEFORE UPDATE OF "command_type", "idempotency_domain", "idempotency_key", "request_value_id", "request_hash", "request_schema_resource_id", "request_schema_hash", "domain_request_hash", "created_at_ms" ON ${q('workflow_feature_release_activation_commands')} BEGIN\n  SELECT RAISE(ABORT, 'activation_command_identity_is_immutable');\nEND`,
    },
    {
      name: 'trg:activation_commands:verified_fact_transition',
      table: 'workflow_feature_release_activation_commands',
      timing: 'before',
      event: 'update',
      owner_intent:
        'pending-only adjacent null-to-exact verified-fact enrichment and terminal immutability',
      sql: `CREATE TRIGGER ${q('trg:activation_commands:verified_fact_transition')} BEFORE UPDATE ON ${q('workflow_feature_release_activation_commands')} BEGIN\n  SELECT CASE WHEN OLD."lifecycle" <> 'pending' OR NEW."row_version" <> OLD."row_version" + 1 OR (OLD."verified_compatibility_input_value_id" IS NOT NULL AND (NEW."verified_compatibility_input_value_id" IS NOT OLD."verified_compatibility_input_value_id" OR NEW."verified_compatibility_input_hash" IS NOT OLD."verified_compatibility_input_hash" OR NEW."verified_compatibility_input_schema_resource_id" IS NOT OLD."verified_compatibility_input_schema_resource_id" OR NEW."verified_compatibility_input_schema_hash" IS NOT OLD."verified_compatibility_input_schema_hash")) OR (OLD."verified_compatibility_result_value_id" IS NOT NULL AND (NEW."verified_compatibility_result_value_id" IS NOT OLD."verified_compatibility_result_value_id" OR NEW."verified_compatibility_result_hash" IS NOT OLD."verified_compatibility_result_hash" OR NEW."verified_compatibility_result_schema_resource_id" IS NOT OLD."verified_compatibility_result_schema_resource_id" OR NEW."verified_compatibility_result_schema_hash" IS NOT OLD."verified_compatibility_result_schema_hash")) OR (OLD."verified_target_feature_release_id" IS NOT NULL AND (NEW."verified_feature_id" IS NOT OLD."verified_feature_id" OR NEW."verified_target_feature_release_id" IS NOT OLD."verified_target_feature_release_id" OR NEW."verified_target_feature_release_ref" IS NOT OLD."verified_target_feature_release_ref" OR NEW."verified_target_feature_release_version" IS NOT OLD."verified_target_feature_release_version" OR NEW."verified_target_feature_release_hash" IS NOT OLD."verified_target_feature_release_hash")) OR (OLD."verified_previous_feature_release_id" IS NOT NULL AND (NEW."verified_previous_feature_release_id" IS NOT OLD."verified_previous_feature_release_id" OR NEW."verified_previous_feature_release_ref" IS NOT OLD."verified_previous_feature_release_ref" OR NEW."verified_previous_feature_release_version" IS NOT OLD."verified_previous_feature_release_version" OR NEW."verified_previous_feature_release_hash" IS NOT OLD."verified_previous_feature_release_hash")) OR (OLD."verified_target_retention_handle_id" IS NOT NULL AND (NEW."verified_target_retention_handle_id" IS NOT OLD."verified_target_retention_handle_id" OR NEW."verified_target_retention_handle_kind" IS NOT OLD."verified_target_retention_handle_kind" OR NEW."verified_target_retention_feature_release_id" IS NOT OLD."verified_target_retention_feature_release_id" OR NEW."verified_target_retention_closure_manifest_id" IS NOT OLD."verified_target_retention_closure_manifest_id" OR NEW."verified_target_retention_closure_hash" IS NOT OLD."verified_target_retention_closure_hash")) OR (OLD."verified_target_retention_observed_status" IS NOT NULL AND (NEW."verified_target_retention_observed_status" IS NOT OLD."verified_target_retention_observed_status" OR NEW."verified_target_retention_observed_row_version" IS NOT OLD."verified_target_retention_observed_row_version")) OR (OLD."verified_previous_retention_handle_id" IS NOT NULL AND (NEW."verified_previous_retention_handle_id" IS NOT OLD."verified_previous_retention_handle_id" OR NEW."verified_previous_retention_handle_kind" IS NOT OLD."verified_previous_retention_handle_kind" OR NEW."verified_previous_retention_feature_release_id" IS NOT OLD."verified_previous_retention_feature_release_id" OR NEW."verified_previous_retention_closure_manifest_id" IS NOT OLD."verified_previous_retention_closure_manifest_id" OR NEW."verified_previous_retention_closure_hash" IS NOT OLD."verified_previous_retention_closure_hash")) OR (OLD."verified_previous_retention_observed_status" IS NOT NULL AND (NEW."verified_previous_retention_observed_status" IS NOT OLD."verified_previous_retention_observed_status" OR NEW."verified_previous_retention_observed_row_version" IS NOT OLD."verified_previous_retention_observed_row_version")) OR (OLD."observed_pointer_state" IS NOT NULL AND (NEW."observed_pointer_state" IS NOT OLD."observed_pointer_state" OR NEW."observed_pointer_row_version" IS NOT OLD."observed_pointer_row_version" OR NEW."observed_feature_release_id" IS NOT OLD."observed_feature_release_id" OR NEW."observed_feature_release_ref" IS NOT OLD."observed_feature_release_ref" OR NEW."observed_feature_release_version" IS NOT OLD."observed_feature_release_version" OR NEW."observed_feature_release_hash" IS NOT OLD."observed_feature_release_hash")) THEN RAISE(ABORT, 'activation_command_verified_fact_transition_invalid') END;\nEND`,
    },
    {
      name: 'trg:activation_commands:terminalization',
      table: 'workflow_feature_release_activation_commands',
      timing: 'before',
      event: 'update',
      owner_intent:
        'applied-only authoritative Release Retention pointer validation and closed failed/conflict result binding',
      sql: `CREATE TRIGGER ${q('trg:activation_commands:terminalization')} BEFORE UPDATE OF "lifecycle" ON ${q('workflow_feature_release_activation_commands')} WHEN NEW."lifecycle" <> OLD."lifecycle" BEGIN\n  SELECT CASE WHEN NEW."lifecycle" NOT IN ('applied', 'failed', 'conflict') OR NEW."terminal_disposition" IS NOT NEW."lifecycle" OR NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_invocations" AS invocation WHERE invocation."id" = NEW."canonical_terminal_invocation_id" AND invocation."command_id" = NEW."command_id" AND invocation."invocation_no" = NEW."canonical_terminal_invocation_no" AND invocation."command_domain_request_hash" = NEW."domain_request_hash" AND invocation."submitted_request_hash" = NEW."canonical_terminal_submitted_request_hash" AND invocation."disposition" = NEW."terminal_disposition" AND invocation."invocation_hash" = NEW."canonical_terminal_invocation_hash" AND invocation."result_value_id" = NEW."canonical_terminal_result_value_id" AND invocation."result_hash" = NEW."canonical_terminal_result_hash" AND invocation."result_schema_resource_id" = NEW."canonical_terminal_result_schema_resource_id" AND invocation."result_schema_hash" = NEW."canonical_terminal_result_schema_hash") OR (NEW."lifecycle" = 'applied' AND (NEW."observed_pointer_state" IS NULL OR NEW."verified_compatibility_input_value_id" IS NULL OR NEW."verified_compatibility_result_value_id" IS NULL OR NEW."verified_target_feature_release_id" IS NULL OR NEW."verified_target_retention_observed_status" <> 'held' OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."verified_feature_id" AND release."id" = NEW."verified_target_feature_release_id" AND release."release_ref" = NEW."verified_target_feature_release_ref" AND release."release_version" = NEW."verified_target_feature_release_version" AND release."release_hash" = NEW."verified_target_feature_release_hash" AND release."status" = 'active') OR NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS handle WHERE handle."id" = NEW."verified_target_retention_handle_id" AND handle."handle_kind" = 'published' AND handle."feature_release_id" = NEW."verified_target_retention_feature_release_id" AND handle."closure_manifest_id" = NEW."verified_target_retention_closure_manifest_id" AND handle."closure_hash" = NEW."verified_target_retention_closure_hash" AND handle."status" = 'held' AND handle."row_version" = NEW."verified_target_retention_observed_row_version") OR NOT EXISTS (SELECT 1 FROM "workflow_feature_active_releases" AS pointer WHERE pointer."feature_id" = NEW."verified_feature_id" AND pointer."release_id" = NEW."verified_target_feature_release_id" AND pointer."release_hash" = NEW."verified_target_feature_release_hash" AND pointer."row_version" = NEW."applied_pointer_row_version") OR (NEW."observed_pointer_state" = 'absent' AND (NEW."applied_pointer_row_version" <> 1 OR NEW."verified_previous_feature_release_id" IS NOT NULL OR NEW."verified_previous_retention_handle_id" IS NOT NULL)) OR (NEW."observed_pointer_state" = 'present' AND (NEW."applied_pointer_row_version" <> NEW."observed_pointer_row_version" + 1 OR NEW."verified_previous_feature_release_id" IS NULL OR NEW."verified_previous_retention_observed_status" <> 'held' OR NEW."observed_feature_release_id" IS NOT NEW."verified_previous_feature_release_id" OR NEW."observed_feature_release_ref" IS NOT NEW."verified_previous_feature_release_ref" OR NEW."observed_feature_release_version" IS NOT NEW."verified_previous_feature_release_version" OR NEW."observed_feature_release_hash" IS NOT NEW."verified_previous_feature_release_hash" OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS previous_release WHERE previous_release."feature_id" = NEW."verified_feature_id" AND previous_release."id" = NEW."verified_previous_feature_release_id" AND previous_release."release_ref" = NEW."verified_previous_feature_release_ref" AND previous_release."release_version" = NEW."verified_previous_feature_release_version" AND previous_release."release_hash" = NEW."verified_previous_feature_release_hash" AND previous_release."status" = 'draining') OR NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS previous_handle WHERE previous_handle."id" = NEW."verified_previous_retention_handle_id" AND previous_handle."handle_kind" = 'published' AND previous_handle."feature_release_id" = NEW."verified_previous_retention_feature_release_id" AND previous_handle."closure_manifest_id" = NEW."verified_previous_retention_closure_manifest_id" AND previous_handle."closure_hash" = NEW."verified_previous_retention_closure_hash" AND previous_handle."status" = 'held' AND previous_handle."row_version" = NEW."verified_previous_retention_observed_row_version"))))) OR (NEW."lifecycle" = 'conflict' AND (NEW."observed_pointer_state" IS NULL OR NEW."verified_compatibility_input_value_id" IS NULL OR NEW."verified_compatibility_result_value_id" IS NULL OR NEW."verified_target_feature_release_id" IS NULL OR NEW."verified_target_retention_observed_status" <> 'held')) THEN RAISE(ABORT, 'activation_command_terminalization_invalid') END;\nEND`,
    },
    {
      name: 'trg:activation_commands:immutable_delete',
      table: 'workflow_feature_release_activation_commands',
      timing: 'before',
      event: 'delete',
      owner_intent: 'durable Activation command audit header',
      sql: `CREATE TRIGGER ${q('trg:activation_commands:immutable_delete')} BEFORE DELETE ON ${q('workflow_feature_release_activation_commands')} BEGIN\n  SELECT RAISE(ABORT, 'activation_command_is_immutable');\nEND`,
    },
    {
      name: 'trg:activation_invocations:hash_chain',
      table: 'workflow_feature_release_activation_invocations',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'adjacent per-command authenticated Activation invocation hash chain',
      sql: `CREATE TRIGGER ${q('trg:activation_invocations:hash_chain')} AFTER INSERT ON ${q('workflow_feature_release_activation_invocations')} BEGIN\n  SELECT CASE WHEN (NEW."invocation_no" = 1 AND NEW."previous_invocation_hash" IS NOT NULL) OR (NEW."invocation_no" > 1 AND (SELECT previous."invocation_hash" FROM "workflow_feature_release_activation_invocations" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."invocation_no" = NEW."invocation_no" - 1) IS NOT NEW."previous_invocation_hash") THEN RAISE(ABORT, 'activation_invocation_hash_chain_invalid') END;\nEND`,
    },
    {
      name: 'trg:activation_invocations:terminal_reference',
      table: 'workflow_feature_release_activation_invocations',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'typed original terminal duplicate and domain-drift terminal-result references',
      sql: `CREATE TRIGGER ${q('trg:activation_invocations:terminal_reference')} AFTER INSERT ON ${q('workflow_feature_release_activation_invocations')} BEGIN\n  SELECT CASE WHEN (NEW."disposition" = 'duplicate' AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."domain_request_hash" = NEW."submitted_request_hash" AND command."lifecycle" IN ('applied', 'failed', 'conflict') AND command."canonical_terminal_result_value_id" = NEW."referenced_terminal_result_value_id" AND command."canonical_terminal_result_hash" = NEW."referenced_terminal_result_hash" AND command."canonical_terminal_result_schema_resource_id" = NEW."referenced_terminal_result_schema_resource_id" AND command."canonical_terminal_result_schema_hash" = NEW."referenced_terminal_result_schema_hash")) OR (NEW."disposition" IN ('applied', 'failed') AND (NEW."referenced_terminal_result_value_id" IS NOT NEW."result_value_id" OR NEW."referenced_terminal_result_hash" IS NOT NEW."result_hash" OR NEW."referenced_terminal_result_schema_resource_id" IS NOT NEW."result_schema_resource_id" OR NEW."referenced_terminal_result_schema_hash" IS NOT NEW."result_schema_hash")) OR (NEW."disposition" = 'conflict' AND NEW."submitted_request_hash" = NEW."command_domain_request_hash" AND (NEW."referenced_terminal_result_value_id" IS NOT NEW."result_value_id" OR NEW."referenced_terminal_result_hash" IS NOT NEW."result_hash" OR NEW."referenced_terminal_result_schema_resource_id" IS NOT NEW."result_schema_resource_id" OR NEW."referenced_terminal_result_schema_hash" IS NOT NEW."result_schema_hash")) OR (NEW."disposition" = 'conflict' AND NEW."submitted_request_hash" <> NEW."command_domain_request_hash" AND NEW."referenced_terminal_result_value_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."lifecycle" IN ('applied', 'failed', 'conflict') AND command."canonical_terminal_result_value_id" = NEW."referenced_terminal_result_value_id" AND command."canonical_terminal_result_hash" = NEW."referenced_terminal_result_hash" AND command."canonical_terminal_result_schema_resource_id" = NEW."referenced_terminal_result_schema_resource_id" AND command."canonical_terminal_result_schema_hash" = NEW."referenced_terminal_result_schema_hash")) THEN RAISE(ABORT, 'activation_invocation_terminal_reference_invalid') END;\nEND`,
    },
    {
      name: 'trg:activation_invocations:closed_replay_disposition',
      table: 'workflow_feature_release_activation_invocations',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'terminal exact-request replay is duplicate while domain drift remains conflict',
      sql: `CREATE TRIGGER ${q('trg:activation_invocations:closed_replay_disposition')} AFTER INSERT ON ${q('workflow_feature_release_activation_invocations')} WHEN NEW."disposition" IN ('applied', 'failed') OR (NEW."disposition" = 'conflict' AND NEW."submitted_request_hash" = NEW."command_domain_request_hash") BEGIN\n  SELECT CASE WHEN EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."lifecycle" IN ('applied', 'failed', 'conflict')) THEN RAISE(ABORT, 'activation_invocation_closed_replay_must_be_duplicate') END;\nEND`,
    },
    {
      name: 'trg:activation_invocations:immutable_update',
      table: 'workflow_feature_release_activation_invocations',
      timing: 'before',
      event: 'update',
      owner_intent: 'append-only authenticated Activation invocation audit',
      sql: `CREATE TRIGGER ${q('trg:activation_invocations:immutable_update')} BEFORE UPDATE ON ${q('workflow_feature_release_activation_invocations')} BEGIN\n  SELECT RAISE(ABORT, 'activation_invocation_is_immutable');\nEND`,
    },
    {
      name: 'trg:activation_invocations:immutable_delete',
      table: 'workflow_feature_release_activation_invocations',
      timing: 'before',
      event: 'delete',
      owner_intent: 'append-only authenticated Activation invocation audit',
      sql: `CREATE TRIGGER ${q('trg:activation_invocations:immutable_delete')} BEFORE DELETE ON ${q('workflow_feature_release_activation_invocations')} BEGIN\n  SELECT RAISE(ABORT, 'activation_invocation_is_immutable');\nEND`,
    },
    {
      name: 'trg:activation_events:command_binding',
      table: 'workflow_feature_release_activation_events',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'nullable Event Release facts equal an already verified command prefix',
      sql: `CREATE TRIGGER ${q('trg:activation_events:command_binding')} AFTER INSERT ON ${q('workflow_feature_release_activation_events')} BEGIN\n  SELECT CASE WHEN (NEW."verified_target_feature_release_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."verified_feature_id" = NEW."verified_feature_id" AND command."verified_target_feature_release_id" = NEW."verified_target_feature_release_id" AND command."verified_target_feature_release_ref" = NEW."verified_target_feature_release_ref" AND command."verified_target_feature_release_version" = NEW."verified_target_feature_release_version" AND command."verified_target_feature_release_hash" = NEW."verified_target_feature_release_hash")) OR (NEW."verified_previous_feature_release_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."verified_feature_id" = NEW."verified_feature_id" AND command."verified_previous_feature_release_id" = NEW."verified_previous_feature_release_id" AND command."verified_previous_feature_release_ref" = NEW."verified_previous_feature_release_ref" AND command."verified_previous_feature_release_version" = NEW."verified_previous_feature_release_version" AND command."verified_previous_feature_release_hash" = NEW."verified_previous_feature_release_hash")) THEN RAISE(ABORT, 'activation_event_command_binding_invalid') END;\nEND`,
    },
    {
      name: 'trg:activation_events:hash_chain',
      table: 'workflow_feature_release_activation_events',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'adjacent per-command Activation phase and recovery event hash chain',
      sql: `CREATE TRIGGER ${q('trg:activation_events:hash_chain')} AFTER INSERT ON ${q('workflow_feature_release_activation_events')} BEGIN\n  SELECT CASE WHEN (NEW."event_no" = 1 AND NEW."previous_event_hash" IS NOT NULL) OR (NEW."event_no" > 1 AND (SELECT previous."event_hash" FROM "workflow_feature_release_activation_events" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."event_no" = NEW."event_no" - 1) IS NOT NEW."previous_event_hash") THEN RAISE(ABORT, 'activation_event_hash_chain_invalid') END;\nEND`,
    },
    {
      name: 'trg:activation_events:immutable_update',
      table: 'workflow_feature_release_activation_events',
      timing: 'before',
      event: 'update',
      owner_intent: 'append-only Activation phase and recovery audit',
      sql: `CREATE TRIGGER ${q('trg:activation_events:immutable_update')} BEFORE UPDATE ON ${q('workflow_feature_release_activation_events')} BEGIN\n  SELECT RAISE(ABORT, 'activation_event_is_immutable');\nEND`,
    },
    {
      name: 'trg:activation_events:immutable_delete',
      table: 'workflow_feature_release_activation_events',
      timing: 'before',
      event: 'delete',
      owner_intent: 'append-only Activation phase and recovery audit',
      sql: `CREATE TRIGGER ${q('trg:activation_events:immutable_delete')} BEFORE DELETE ON ${q('workflow_feature_release_activation_events')} BEGIN\n  SELECT RAISE(ABORT, 'activation_event_is_immutable');\nEND`,
    },
  ];
  if (databaseSchemaVersion >= 5) {
    triggers.push(
      {
        name: 'trg:capacity_invocations:prepared_insert',
        table: 'runtime_capacity_admin_invocations',
        timing: 'before',
        event: 'insert',
        owner_intent:
          'prepared is the initial exact-request CAP1 decision for an assigned unfinished Command',
        sql: `CREATE TRIGGER ${q('trg:capacity_invocations:prepared_insert')} BEFORE INSERT ON ${q('runtime_capacity_admin_invocations')} WHEN NEW."execution_result" = 'prepared' BEGIN\n  SELECT CASE WHEN NEW."invocation_no" <> 1 OR NOT EXISTS (SELECT 1 FROM "runtime_capacity_admin_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."request_hash" = NEW."submitted_request_hash" AND command."assigned_capacity_revision" IS NOT NULL AND command."assigned_change_id" IS NOT NULL AND command."canonical_result_value_id" IS NULL AND command."canonical_result_hash" IS NULL AND command."finalized_at_ms" IS NULL) THEN RAISE(ABORT, 'capacity_prepared_invocation_invalid') END;\nEND`,
      },
      {
        name: 'trg:capacity_invocations:applied_insert',
        table: 'runtime_capacity_admin_invocations',
        timing: 'before',
        event: 'insert',
        owner_intent:
          'applied Invocation is Schema 4 provenance only and cannot be appended under Schema 5',
        sql: `CREATE TRIGGER ${q('trg:capacity_invocations:applied_insert')} BEFORE INSERT ON ${q('runtime_capacity_admin_invocations')} WHEN NEW."execution_result" = 'applied' BEGIN\n  SELECT RAISE(ABORT, 'capacity_applied_invocation_is_historical');\nEND`,
      },
      {
        name: 'trg:capacity_invocations:terminal_insert',
        table: 'runtime_capacity_admin_invocations',
        timing: 'before',
        event: 'insert',
        owner_intent:
          'new terminal audit rows preserve decision chronology and allowed invocations carry no denial code',
        sql: `CREATE TRIGGER ${q('trg:capacity_invocations:terminal_insert')} BEFORE INSERT ON ${q('runtime_capacity_admin_invocations')} WHEN NEW."execution_result" IN ('denied', 'conflict', 'failed') BEGIN\n  SELECT CASE WHEN NEW."decided_at_ms" < NEW."requested_at_ms" OR (NEW."authorization_result" = 'allowed' AND NEW."denial_code" IS NOT NULL) THEN RAISE(ABORT, 'capacity_terminal_invocation_invalid') END;\nEND`,
      },
      {
        name: 'trg:capacity_invocations:duplicate_insert',
        table: 'runtime_capacity_admin_invocations',
        timing: 'before',
        event: 'insert',
        owner_intent:
          'duplicate is an exact-request replay of an already finalized canonical Command result',
        sql: `CREATE TRIGGER ${q('trg:capacity_invocations:duplicate_insert')} BEFORE INSERT ON ${q('runtime_capacity_admin_invocations')} WHEN NEW."execution_result" = 'duplicate' BEGIN\n  SELECT CASE WHEN NEW."invocation_no" <= 1 OR NEW."denial_code" IS NOT NULL OR NEW."decided_at_ms" < NEW."requested_at_ms" OR NOT EXISTS (SELECT 1 FROM "runtime_capacity_admin_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."request_hash" = NEW."submitted_request_hash" AND command."canonical_result_value_id" IS NOT NULL AND command."canonical_result_hash" IS NOT NULL AND command."finalized_at_ms" IS NOT NULL) THEN RAISE(ABORT, 'capacity_duplicate_invocation_invalid') END;\nEND`,
      },
      {
        name: 'trg:capacity_invocations:immutable_update',
        table: 'runtime_capacity_admin_invocations',
        timing: 'before',
        event: 'update',
        owner_intent:
          'append-only authenticated Capacity Admin invocation audit',
        sql: `CREATE TRIGGER ${q('trg:capacity_invocations:immutable_update')} BEFORE UPDATE ON ${q('runtime_capacity_admin_invocations')} BEGIN\n  SELECT RAISE(ABORT, 'capacity_invocation_is_immutable');\nEND`,
      },
      {
        name: 'trg:capacity_invocations:immutable_delete',
        table: 'runtime_capacity_admin_invocations',
        timing: 'before',
        event: 'delete',
        owner_intent:
          'append-only authenticated Capacity Admin invocation audit',
        sql: `CREATE TRIGGER ${q('trg:capacity_invocations:immutable_delete')} BEFORE DELETE ON ${q('runtime_capacity_admin_invocations')} BEGIN\n  SELECT RAISE(ABORT, 'capacity_invocation_is_immutable');\nEND`,
      },
    );
  }
  if (databaseSchemaVersion >= 4) return triggers;

  const current = new Map(triggers.map((trigger) => [trigger.name, trigger]));
  const retained = (name: string): SchemaTriggerDefinition => {
    const trigger = current.get(name);
    if (!trigger) throw new Error(`Missing retained Schema 3 trigger: ${name}`);
    return trigger;
  };
  return [
    ...triggers.filter(
      (trigger) =>
        !trigger.table.startsWith('workflow_feature_release_activation_'),
    ),
    {
      name: 'trg:activation_commands:retention_observation_insert',
      table: 'workflow_feature_release_activation_commands',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'exact Release refs and held target/previous Retention observations',
      sql: `CREATE TRIGGER ${q('trg:activation_commands:retention_observation_insert')} AFTER INSERT ON ${q('workflow_feature_release_activation_commands')} BEGIN\n  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."feature_id" AND release."id" = NEW."target_feature_release_id" AND release."release_ref" = NEW."target_feature_release_ref" AND release."release_version" = NEW."target_feature_release_version" AND release."release_hash" = NEW."target_feature_release_hash") OR NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS handle WHERE handle."id" = NEW."target_retention_handle_id" AND handle."handle_kind" = 'published' AND handle."feature_release_id" = NEW."target_feature_release_id" AND handle."closure_manifest_id" = NEW."target_retention_closure_manifest_id" AND handle."closure_hash" = NEW."target_retention_closure_hash" AND handle."status" = NEW."target_retention_observed_status" AND handle."row_version" = NEW."target_retention_observed_row_version") OR (NEW."expected_pointer_state" = 'present' AND (NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."feature_id" AND release."id" = NEW."previous_feature_release_id" AND release."release_ref" = NEW."previous_feature_release_ref" AND release."release_version" = NEW."previous_feature_release_version" AND release."release_hash" = NEW."previous_feature_release_hash") OR NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS handle WHERE handle."id" = NEW."previous_retention_handle_id" AND handle."handle_kind" = 'published' AND handle."feature_release_id" = NEW."previous_feature_release_id" AND handle."closure_manifest_id" = NEW."previous_retention_closure_manifest_id" AND handle."closure_hash" = NEW."previous_retention_closure_hash" AND handle."status" = NEW."previous_retention_observed_status" AND handle."row_version" = NEW."previous_retention_observed_row_version"))) THEN RAISE(ABORT, 'activation_retention_observation_invalid') END;\nEND`,
    },
    {
      name: 'trg:activation_commands:immutable_identity',
      table: 'workflow_feature_release_activation_commands',
      timing: 'before',
      event: 'update',
      owner_intent:
        'immutable Activation caller request compatibility Release pointer and Retention identity',
      sql: `CREATE TRIGGER ${q('trg:activation_commands:immutable_identity')} BEFORE UPDATE OF "command_type", "idempotency_domain", "idempotency_key", "request_value_id", "request_hash", "request_schema_resource_id", "request_schema_hash", "domain_request_hash", "compatibility_input_value_id", "compatibility_input_hash", "compatibility_input_schema_resource_id", "compatibility_input_schema_hash", "compatibility_result_value_id", "compatibility_result_hash", "compatibility_result_schema_resource_id", "compatibility_result_schema_hash", "feature_id", "target_feature_release_id", "target_feature_release_ref", "target_feature_release_version", "target_feature_release_hash", "expected_pointer_state", "expected_pointer_row_version", "previous_feature_release_id", "previous_feature_release_ref", "previous_feature_release_version", "previous_feature_release_hash", "target_retention_handle_id", "target_retention_handle_kind", "target_retention_closure_manifest_id", "target_retention_closure_hash", "target_retention_observed_status", "target_retention_observed_row_version", "previous_retention_handle_id", "previous_retention_handle_kind", "previous_retention_closure_manifest_id", "previous_retention_closure_hash", "previous_retention_observed_status", "previous_retention_observed_row_version", "created_at_ms" ON ${q('workflow_feature_release_activation_commands')} BEGIN\n  SELECT RAISE(ABORT, 'activation_command_identity_is_immutable');\nEND`,
    },
    {
      name: 'trg:activation_commands:lifecycle_transition',
      table: 'workflow_feature_release_activation_commands',
      timing: 'before',
      event: 'update',
      owner_intent:
        'single pending-to-terminal Activation finalization with pointer and Retention verification',
      sql: `CREATE TRIGGER ${q('trg:activation_commands:lifecycle_transition')} BEFORE UPDATE OF "applied_pointer_row_version", "canonical_receipt_value_id", "canonical_receipt_hash", "canonical_receipt_schema_resource_id", "canonical_receipt_schema_hash", "lifecycle", "finalized_at_ms", "row_version" ON ${q('workflow_feature_release_activation_commands')} BEGIN\n  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR OLD."lifecycle" <> 'pending' OR NEW."lifecycle" NOT IN ('applied', 'failed') OR (NEW."lifecycle" = 'applied' AND (NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."feature_id" AND release."id" = NEW."target_feature_release_id" AND release."release_hash" = NEW."target_feature_release_hash" AND release."status" = 'active') OR NOT EXISTS (SELECT 1 FROM "workflow_feature_active_releases" AS pointer WHERE pointer."feature_id" = NEW."feature_id" AND pointer."release_id" = NEW."target_feature_release_id" AND pointer."release_hash" = NEW."target_feature_release_hash" AND pointer."row_version" = NEW."applied_pointer_row_version") OR (NEW."expected_pointer_state" = 'absent' AND NEW."applied_pointer_row_version" <> 1) OR (NEW."expected_pointer_state" = 'present' AND (NEW."applied_pointer_row_version" <> NEW."expected_pointer_row_version" + 1 OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS previous_release WHERE previous_release."feature_id" = NEW."feature_id" AND previous_release."id" = NEW."previous_feature_release_id" AND previous_release."release_hash" = NEW."previous_feature_release_hash" AND previous_release."status" = 'draining'))) OR NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS handle WHERE handle."id" = NEW."target_retention_handle_id" AND handle."status" = 'held' AND handle."row_version" = NEW."target_retention_observed_row_version") OR (NEW."expected_pointer_state" = 'present' AND NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS handle WHERE handle."id" = NEW."previous_retention_handle_id" AND handle."status" = 'held' AND handle."row_version" = NEW."previous_retention_observed_row_version")))) THEN RAISE(ABORT, 'activation_command_lifecycle_transition_invalid') END;\nEND`,
    },
    retained('trg:activation_commands:immutable_delete'),
    retained('trg:activation_invocations:hash_chain'),
    retained('trg:activation_invocations:immutable_update'),
    retained('trg:activation_invocations:immutable_delete'),
    {
      name: 'trg:activation_events:command_binding',
      table: 'workflow_feature_release_activation_events',
      timing: 'after',
      event: 'insert',
      owner_intent:
        'Activation Event typed target and previous Release identity equals command',
      sql: `CREATE TRIGGER ${q('trg:activation_events:command_binding')} AFTER INSERT ON ${q('workflow_feature_release_activation_events')} BEGIN\n  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."feature_id" = NEW."feature_id" AND command."target_feature_release_id" = NEW."target_feature_release_id" AND command."target_feature_release_ref" = NEW."target_feature_release_ref" AND command."target_feature_release_version" = NEW."target_feature_release_version" AND command."target_feature_release_hash" = NEW."target_feature_release_hash" AND command."previous_feature_release_id" IS NEW."previous_feature_release_id" AND command."previous_feature_release_ref" IS NEW."previous_feature_release_ref" AND command."previous_feature_release_version" IS NEW."previous_feature_release_version" AND command."previous_feature_release_hash" IS NEW."previous_feature_release_hash") THEN RAISE(ABORT, 'activation_event_command_binding_invalid') END;\nEND`,
    },
    retained('trg:activation_events:hash_chain'),
    retained('trg:activation_events:immutable_update'),
    retained('trg:activation_events:immutable_delete'),
  ];
}

export interface RenderedMigration {
  sql: string;
  statement_count: number;
  triggers: SchemaTriggerDefinition[];
}

export function renderMigration(
  source: ExecutableSchemaSource,
): RenderedMigration {
  const triggers = buildSchemaTriggers(source.database_schema_version);
  const statements = [
    ...source.tables.map((table) =>
      renderTable(table, source.database_schema_version),
    ),
    ...source.tables.flatMap((table) =>
      table.unique_keys.map((key) => renderUniqueIndex(table, key)),
    ),
    ...source.tables.flatMap((table) =>
      table.indexes.map((index) => renderIndex(table, index)),
    ),
    ...triggers.map((trigger) => trigger.sql),
    `PRAGMA user_version = ${source.database_schema_version}`,
  ];
  return {
    sql: `${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
    statement_count: statements.length,
    triggers,
  };
}

export const SCHEMA3_TO_SCHEMA4_UPGRADE_RELATIVE_PATH =
  'migration/workflow-runtime-schema-v3-to-v4.sql';
export const SCHEMA4_TO_SCHEMA5_UPGRADE_RELATIVE_PATH =
  'migration/workflow-runtime-schema-v4-to-v5.sql';
export const SCHEMA5_TO_SCHEMA6_UPGRADE_RELATIVE_PATH =
  'migration/workflow-runtime-schema-v5-to-v6.sql';
export const SCHEMA6_TO_SCHEMA7_UPGRADE_RELATIVE_PATH =
  'migration/workflow-runtime-schema-v6-to-v7.sql';
export const SCHEMA7_TO_SCHEMA8_UPGRADE_RELATIVE_PATH =
  'migration/workflow-runtime-schema-v7-to-v8.sql';

const ACTIVATION_REBUILT_TABLES = [
  'workflow_feature_release_activation_commands',
  'workflow_feature_release_activation_invocations',
  'workflow_feature_release_activation_events',
] as const;

export function renderSchema3To4Upgrade(
  schema3: ExecutableSchemaSource,
  schema4: ExecutableSchemaSource,
): RenderedMigration {
  if (
    schema3.database_schema_version !== 3 ||
    schema4.database_schema_version !== 4
  ) {
    throw new Error('Schema 3 to 4 upgrade source versions are invalid');
  }
  const tables = ACTIVATION_REBUILT_TABLES.map((name) => {
    const table = schema4.tables.find((candidate) => candidate.name === name);
    if (!table) throw new Error(`Schema 4 upgrade table is missing: ${name}`);
    return table;
  });
  for (const name of ACTIVATION_REBUILT_TABLES) {
    if (!schema3.tables.some((table) => table.name === name)) {
      throw new Error(`Schema 3 upgrade table is missing: ${name}`);
    }
  }
  const triggers = buildSchemaTriggers(4).filter((trigger) =>
    ACTIVATION_REBUILT_TABLES.includes(
      trigger.table as (typeof ACTIVATION_REBUILT_TABLES)[number],
    ),
  );
  const statements = [
    `DROP TABLE ${q('workflow_feature_release_activation_events')}`,
    `DROP TABLE ${q('workflow_feature_release_activation_invocations')}`,
    `DROP TABLE ${q('workflow_feature_release_activation_commands')}`,
    ...tables.map((table) => renderTable(table, 4)),
    ...tables.flatMap((table) =>
      table.unique_keys.map((key) => renderUniqueIndex(table, key)),
    ),
    ...tables.flatMap((table) =>
      table.indexes.map((index) => renderIndex(table, index)),
    ),
    ...triggers.map((trigger) => trigger.sql),
    'PRAGMA user_version = 4',
  ];
  return {
    sql: `${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
    statement_count: statements.length,
    triggers,
  };
}

export function renderSchema4To5Upgrade(
  schema4: ExecutableSchemaSource,
  schema5: ExecutableSchemaSource,
): RenderedMigration {
  if (
    schema4.database_schema_version !== 4 ||
    schema5.database_schema_version !== 5
  ) {
    throw new Error('Schema 4 to 5 upgrade source versions are invalid');
  }
  const tableName = 'runtime_capacity_admin_invocations';
  const oldTableName = `${tableName}_schema4`;
  const schema4Table = schema4.tables.find(
    (candidate) => candidate.name === tableName,
  );
  const schema5Table = schema5.tables.find(
    (candidate) => candidate.name === tableName,
  );
  if (!schema4Table || !schema5Table) {
    throw new Error('Capacity Invocation upgrade table is missing');
  }
  const schema4Columns = schema4Table.columns.map((column) => column.name);
  const schema5Columns = schema5Table.columns.map((column) => column.name);
  if (
    schema4Columns.length !== schema5Columns.length ||
    schema4Columns.some((column, index) => column !== schema5Columns[index])
  ) {
    throw new Error('Capacity Invocation upgrade cannot change columns');
  }
  const triggers = buildSchemaTriggers(5).filter(
    (trigger) => trigger.table === tableName,
  );
  const columnList = schema5Columns.map(q).join(', ');
  const statements = [
    `ALTER TABLE ${q(tableName)} RENAME TO ${q(oldTableName)}`,
    renderTable(schema5Table, 5),
    `INSERT INTO ${q(tableName)} (${columnList}) SELECT ${columnList} FROM ${q(oldTableName)}`,
    `DROP TABLE ${q(oldTableName)}`,
    ...schema5Table.unique_keys.map((key) =>
      renderUniqueIndex(schema5Table, key),
    ),
    ...schema5Table.indexes.map((index) => renderIndex(schema5Table, index)),
    ...triggers.map((trigger) => trigger.sql),
    'PRAGMA user_version = 5',
  ];
  return {
    sql: `${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
    statement_count: statements.length,
    triggers,
  };
}

export function renderSchema5To6Upgrade(
  schema5: ExecutableSchemaSource,
  schema6: ExecutableSchemaSource,
): RenderedMigration {
  if (
    schema5.database_schema_version !== 5 ||
    schema6.database_schema_version !== 6
  ) {
    throw new Error('Schema 5 to 6 upgrade source versions are invalid');
  }
  const tableName = 'workflow_values';
  const oldTableName = `${tableName}_schema5`;
  const schema5Table = schema5.tables.find(
    (candidate) => candidate.name === tableName,
  );
  const schema6Table = schema6.tables.find(
    (candidate) => candidate.name === tableName,
  );
  if (!schema5Table || !schema6Table) {
    throw new Error('Schema 6 workflow_values rebuild table is missing');
  }
  const schema5Columns = schema5Table.columns.map((column) => column.name);
  if (
    schema6Table.columns.length <= schema5Columns.length ||
    schema5Columns.some(
      (column, index) => schema6Table.columns[index]?.name !== column,
    )
  ) {
    throw new Error(
      'Schema 6 workflow_values must preserve every Schema 5 column',
    );
  }
  const addedTables = schema6.tables.filter(
    (table) =>
      !schema5.tables.some((candidate) => candidate.name === table.name),
  );
  if (
    addedTables.length !== 2 ||
    addedTables[0]?.name !== 'workflow_generated_schema_contents' ||
    addedTables[1]?.name !== 'workflow_plan_generated_schemas'
  ) {
    throw new Error('Schema 6 generated schema authority tables drifted');
  }
  const oldColumnList = schema5Columns.map(q).join(', ');
  const valueTriggers = buildSchemaTriggers(6).filter(
    (trigger) => trigger.table === tableName,
  );
  const statements = [
    'PRAGMA legacy_alter_table = ON',
    `ALTER TABLE ${q(tableName)} RENAME TO ${q(oldTableName)}`,
    ...addedTables.map((table) => renderTable(table, 6)),
    ...addedTables.flatMap((table) =>
      table.unique_keys.map((key) => renderUniqueIndex(table, key)),
    ),
    ...addedTables.flatMap((table) =>
      table.indexes.map((indexValue) => renderIndex(table, indexValue)),
    ),
    renderTable(schema6Table, 6),
    `INSERT INTO ${q(tableName)} (${oldColumnList}, ${q('schema_authority_kind')}) SELECT ${oldColumnList}, 'registry' FROM ${q(oldTableName)}`,
    `DROP TABLE ${q(oldTableName)}`,
    ...schema6Table.unique_keys.map((key) =>
      renderUniqueIndex(schema6Table, key),
    ),
    ...schema6Table.indexes.map((indexValue) =>
      renderIndex(schema6Table, indexValue),
    ),
    ...valueTriggers.map((trigger) => trigger.sql),
    'PRAGMA legacy_alter_table = OFF',
    'PRAGMA user_version = 6',
  ];
  return {
    sql: `${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
    statement_count: statements.length,
    triggers: valueTriggers,
  };
}

export function renderSchema6To7Upgrade(
  schema6: ExecutableSchemaSource,
  schema7: ExecutableSchemaSource,
): RenderedMigration {
  if (
    schema6.database_schema_version !== 6 ||
    schema7.database_schema_version !== 7
  ) {
    throw new Error('Schema 6 to 7 upgrade source versions are invalid');
  }
  const affected = [
    'workflow_values',
    'workflow_plan_generated_schemas',
  ] as const;
  const sourceTables = affected.map((name) =>
    schema6.tables.find((table) => table.name === name),
  );
  const targetTables = affected.map((name) =>
    schema7.tables.find((table) => table.name === name),
  );
  if (sourceTables.some((table) => !table) || targetTables.some((table) => !table)) {
    throw new Error('Schema 7 NodeOutputEnvelope authority table is missing');
  }
  for (let index = 0; index < affected.length; index += 1) {
    const sourceColumns = sourceTables[index]!.columns.map((column) => column.name);
    const targetColumns = targetTables[index]!.columns.map((column) => column.name);
    if (
      sourceColumns.length !== targetColumns.length ||
      sourceColumns.some((column, columnIndex) => column !== targetColumns[columnIndex])
    ) {
      throw new Error(`Schema 7 ${affected[index]} cannot change columns`);
    }
  }
  const values = targetTables[0]!;
  const bindings = targetTables[1]!;
  const valuesColumns = values.columns.map((column) => column.name).map(q).join(', ');
  const bindingColumns = bindings.columns.map((column) => column.name).map(q).join(', ');
  const valueTriggers = buildSchemaTriggers(7).filter(
    (trigger) => trigger.table === values.name,
  );
  const statements = [
    'PRAGMA legacy_alter_table = ON',
    `ALTER TABLE ${q(values.name)} RENAME TO ${q(`${values.name}_schema6`)}`,
    `ALTER TABLE ${q(bindings.name)} RENAME TO ${q(`${bindings.name}_schema6`)}`,
    renderTable(bindings, 7),
    renderTable(values, 7),
    `INSERT INTO ${q(bindings.name)} (${bindingColumns}) SELECT ${bindingColumns} FROM ${q(`${bindings.name}_schema6`)}`,
    `INSERT INTO ${q(values.name)} (${valuesColumns}) SELECT ${valuesColumns} FROM ${q(`${values.name}_schema6`)}`,
    `DROP TABLE ${q(`${values.name}_schema6`)}`,
    `DROP TABLE ${q(`${bindings.name}_schema6`)}`,
    ...bindings.unique_keys.map((key) => renderUniqueIndex(bindings, key)),
    ...bindings.indexes.map((indexValue) => renderIndex(bindings, indexValue)),
    ...values.unique_keys.map((key) => renderUniqueIndex(values, key)),
    ...values.indexes.map((indexValue) => renderIndex(values, indexValue)),
    ...valueTriggers.map((trigger) => trigger.sql),
    'PRAGMA legacy_alter_table = OFF',
    'PRAGMA user_version = 7',
  ];
  return {
    sql: `${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
    statement_count: statements.length,
    triggers: valueTriggers,
  };
}

export function renderSchema7To8Upgrade(
  schema7: ExecutableSchemaSource,
  schema8: ExecutableSchemaSource,
): RenderedMigration {
  if (
    schema7.database_schema_version !== 7 ||
    schema8.database_schema_version !== 8
  ) {
    throw new Error('Schema 7 to 8 upgrade source versions are invalid');
  }
  const consumptionName = 'workflow_graph_child_completion_consumptions';
  const scopeName = 'workflow_graph_scopes';
  const mapResultName = 'workflow_graph_map_item_results';
  const oldConsumptionName = `${consumptionName}_schema7`;
  const schema7Consumption = schema7.tables.find(
    (table) => table.name === consumptionName,
  );
  const schema8Consumption = schema8.tables.find(
    (table) => table.name === consumptionName,
  );
  const schema7Scope = schema7.tables.find((table) => table.name === scopeName);
  const schema8Scope = schema8.tables.find((table) => table.name === scopeName);
  const schema7MapResult = schema7.tables.find(
    (table) => table.name === mapResultName,
  );
  const schema8MapResult = schema8.tables.find(
    (table) => table.name === mapResultName,
  );
  if (
    !schema7Consumption ||
    !schema8Consumption ||
    !schema7Scope ||
    !schema8Scope ||
    !schema7MapResult ||
    !schema8MapResult
  ) {
    throw new Error('Schema 8 R-020 lineage table is missing');
  }
  const scopeAddedKeys = schema8Scope.unique_keys.filter(
    (key) =>
      !schema7Scope.unique_keys.some(
        (candidate) => candidate.key_id === key.key_id,
      ),
  );
  const mapAddedKeys = schema8MapResult.unique_keys.filter(
    (key) =>
      !schema7MapResult.unique_keys.some(
        (candidate) => candidate.key_id === key.key_id,
      ),
  );
  if (
    scopeAddedKeys.length !== 1 ||
    mapAddedKeys.length !== 2 ||
    schema8Consumption.columns.length !== schema7Consumption.columns.length + 2
  ) {
    throw new Error('Schema 8 R-020 lineage delta drifted');
  }
  const targetColumns = schema8Consumption.columns
    .map((column) => q(column.name))
    .join(', ');
  const selectExpressions = schema8Consumption.columns.map((column) => {
    if (column.name === 'graph_run_id') return `${q('scope')}.${q('graph_run_id')}`;
    if (column.name === 'map_slot_outcome_state') {
      return `CASE ${q('consumption')}.${q('disposition')} WHEN 'map_slot_completed' THEN 'completed' WHEN 'map_slot_fenced' THEN 'fenced' ELSE NULL END`;
    }
    return `${q('consumption')}.${q(column.name)}`;
  });
  const statements = [
    'PRAGMA legacy_alter_table = ON',
    `ALTER TABLE ${q(consumptionName)} RENAME TO ${q(oldConsumptionName)}`,
    ...scopeAddedKeys.map((key) => renderUniqueIndex(schema8Scope, key)),
    ...mapAddedKeys.map((key) => renderUniqueIndex(schema8MapResult, key)),
    renderTable(schema8Consumption, 8),
    `INSERT INTO ${q(consumptionName)} (${targetColumns}) SELECT ${selectExpressions.join(', ')} FROM ${q(oldConsumptionName)} AS ${q('consumption')} JOIN ${q(scopeName)} AS ${q('scope')} ON ${q('scope')}.${q('id')} = ${q('consumption')}.${q('child_scope_id')}`,
    `DROP TABLE ${q(oldConsumptionName)}`,
    ...schema8Consumption.unique_keys.map((key) =>
      renderUniqueIndex(schema8Consumption, key),
    ),
    ...schema8Consumption.indexes.map((indexValue) =>
      renderIndex(schema8Consumption, indexValue),
    ),
    'PRAGMA legacy_alter_table = OFF',
    'PRAGMA user_version = 8',
  ];
  return {
    sql: `${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
    statement_count: statements.length,
    triggers: [],
  };
}

function statePredicateSql(query: LogicalQueryIntent): string | null {
  if (!query.state_predicate_intent) return null;
  if (query.query_id === 'capacity_watcher_verify_committed_head') {
    return '"current_capacity_revision" = ? AND "current_change_id" = ? AND "current_config_hash" = ? AND "current_publication_hash" = ?';
  }
  return renderPredicateIntent(query.state_predicate_intent);
}

function coverageArea(
  query: LogicalQueryIntent,
): SchemaQueryFixture['coverage_area'] {
  if (query.query_id.includes('capacity')) return 'capacity';
  if (query.owner === 'scheduler') return 'scheduler';
  if (query.owner.includes('watchdog') || query.owner.includes('timer'))
    return 'watchdog';
  if (query.owner === 'operational_remediation') return 't6e';
  if (query.owner === 'root_finalizer') return 'root_finalization';
  if (query.owner === 'subtree_fencer') return 't7';
  if (query.owner === 'blob_coordinator' || query.owner === 'retention_gc')
    return 'gc';
  if (query.owner === 'outbox_worker') return 'outbox';
  if (query.owner === 'command_gateway') return 'command';
  if (query.owner === 'checkpoint_loader') return 'checkpoint';
  if (query.query_id.includes('t3') || query.owner === 'reconciler')
    return 't3';
  return 'recovery';
}

export function buildQueryFixtures(
  source: ExecutableSchemaSource,
): SchemaQueryFixture[] {
  return source.queries.map((query) => {
    const predicates: string[] = [];
    let parameterCount = 0;
    for (const column of query.equality_columns) {
      predicates.push(`${q(column)} = ?`);
      parameterCount += 1;
    }
    for (const column of query.range_columns) {
      predicates.push(`${q(column)} <= ?`);
      parameterCount += 1;
    }
    const statePredicate = statePredicateSql(query);
    if (statePredicate) {
      predicates.push(statePredicate);
      parameterCount += (statePredicate.match(/\?/g) ?? []).length;
    }
    const order = query.order_by.length
      ? ` ORDER BY ${query.order_by
          .map((entry) => `${q(entry.column)} ${entry.direction.toUpperCase()}`)
          .join(', ')}`
      : '';
    const sql = `SELECT * FROM ${q(query.table)} INDEXED BY ${q(query.required_index_id)} WHERE ${predicates.length ? predicates.join(' AND ') : '1 = 1'}${order} LIMIT 50`;
    return {
      query_id: query.query_id,
      owner: query.owner,
      coverage_area: coverageArea(query),
      sql,
      parameter_count: parameterCount,
      required_index_id: query.required_index_id,
    };
  });
}
