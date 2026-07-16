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
  'migration/workflow-runtime-schema-v1.sql';

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

export function renderTable(table: LogicalTableMetadata): string {
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
    const expression = renderCheckExpression(check, table.columns);
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

export function buildSchemaTriggers(): SchemaTriggerDefinition[] {
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
  return [
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
  const triggers = buildSchemaTriggers();
  const statements = [
    ...source.tables.map(renderTable),
    ...source.tables.flatMap((table) =>
      table.unique_keys.map((key) => renderUniqueIndex(table, key)),
    ),
    ...source.tables.flatMap((table) =>
      table.indexes.map((index) => renderIndex(table, index)),
    ),
    ...triggers.map((trigger) => trigger.sql),
    'PRAGMA user_version = 1',
  ];
  return {
    sql: `${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
    statement_count: statements.length,
    triggers,
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
