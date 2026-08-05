import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  workflowAgentResultSchema,
  workflowAgentDispatchRequestSchema,
  type WorkflowAdapterExecutionContext,
  type WorkflowAdapterExecutionRecord,
  type WorkflowAdapterExecutionState,
  type WorkflowAgentDispatchRequest,
  type WorkflowAgentResult,
} from './types.js';

interface ExecutionRow {
  execution_id: string;
  operation_key: string;
  adapter_ref_id: string;
  adapter_resource_hash: string;
  request_hash: string;
  request_json: string;
  context_json: string;
  state: WorkflowAdapterExecutionState;
  provider_metadata_json: string;
  result_json: string | null;
  error_code: string | null;
  callback_state: 'pending' | 'delivered';
  callback_delivered_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

const TERMINAL_STATES: readonly WorkflowAdapterExecutionState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
];

function stableExecutionId(operationKey: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`icarus:workflow-adapter-execution:1\n${operationKey}`)
    .digest('hex');
  return `wae-${digest.slice(0, 40)}`;
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseRow(row: ExecutionRow): WorkflowAdapterExecutionRecord {
  return {
    executionId: row.execution_id,
    operationKey: row.operation_key,
    adapterRefId: row.adapter_ref_id,
    adapterResourceHash: row.adapter_resource_hash,
    requestHash: row.request_hash,
    request: workflowAgentDispatchRequestSchema.parse(
      JSON.parse(row.request_json),
    ),
    context: JSON.parse(row.context_json) as WorkflowAdapterExecutionContext,
    state: row.state,
    providerMetadata: JSON.parse(row.provider_metadata_json) as Record<
      string,
      unknown
    >,
    result: row.result_json
      ? workflowAgentResultSchema.parse(JSON.parse(row.result_json))
      : null,
    errorCode: row.error_code,
    callbackDeliveredAtMs: row.callback_delivered_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export class WorkflowAdapterExecutionStore {
  readonly databasePath: string;
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.databasePath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    if (
      fs.existsSync(this.databasePath) &&
      fs.lstatSync(this.databasePath).isSymbolicLink()
    ) {
      throw new Error(
        'Workflow Adapter execution database cannot be a symlink',
      );
    }
    this.database = new Database(this.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_adapter_executions (
        execution_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL UNIQUE,
        adapter_ref_id TEXT NOT NULL,
        adapter_resource_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'reserved', 'accepted', 'running', 'waiting_approval',
          'succeeded', 'failed', 'cancelled', 'blocked'
        )),
        provider_metadata_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        callback_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (callback_state IN ('pending', 'delivered')),
        callback_delivered_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_adapter_executions_state
        ON workflow_adapter_executions(state, updated_at_ms);
    `);
    const columns = this.database
      .prepare<
        [],
        { name: string }
      >('PRAGMA table_info(workflow_adapter_executions)')
      .all();
    if (!columns.some((column) => column.name === 'callback_state')) {
      this.database.exec(
        "ALTER TABLE workflow_adapter_executions ADD COLUMN callback_state TEXT NOT NULL DEFAULT 'pending' CHECK (callback_state IN ('pending', 'delivered'))",
      );
    }
    if (!columns.some((column) => column.name === 'callback_delivered_at_ms')) {
      this.database.exec(
        'ALTER TABLE workflow_adapter_executions ADD COLUMN callback_delivered_at_ms INTEGER',
      );
    }
  }

  reserve(input: {
    readonly operationKey: string;
    readonly adapterRefId: string;
    readonly adapterResourceHash: string;
    readonly requestHash: string;
    readonly request: WorkflowAgentDispatchRequest;
    readonly context: Omit<WorkflowAdapterExecutionContext, 'executionId'>;
    readonly nowMs: number;
  }): WorkflowAdapterExecutionRecord {
    const executionId = stableExecutionId(input.operationKey);
    const context: WorkflowAdapterExecutionContext = {
      ...input.context,
      executionId,
    };
    const requestJson = exactJson(input.request);
    const contextJson = exactJson(context);
    const transaction = this.database.transaction(() => {
      const existing = this.database
        .prepare<
          [string],
          ExecutionRow
        >('SELECT * FROM workflow_adapter_executions WHERE operation_key = ?')
        .get(input.operationKey);
      if (existing) {
        if (
          existing.execution_id !== executionId ||
          existing.adapter_ref_id !== input.adapterRefId ||
          existing.adapter_resource_hash !== input.adapterResourceHash ||
          existing.request_hash !== input.requestHash ||
          existing.request_json !== requestJson ||
          existing.context_json !== contextJson
        ) {
          throw new Error(
            `Workflow Adapter operation key collision: ${input.operationKey}`,
          );
        }
        return parseRow(existing);
      }
      this.database
        .prepare(
          `INSERT INTO workflow_adapter_executions (
             execution_id, operation_key, adapter_ref_id,
             adapter_resource_hash, request_hash, request_json, context_json,
             state, provider_metadata_json, result_json, error_code,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', '{}', NULL, NULL, ?, ?)`,
        )
        .run(
          executionId,
          input.operationKey,
          input.adapterRefId,
          input.adapterResourceHash,
          input.requestHash,
          requestJson,
          contextJson,
          input.nowMs,
          input.nowMs,
        );
      return this.get(executionId)!;
    });
    return transaction();
  }

  get(executionId: string): WorkflowAdapterExecutionRecord | null {
    const row = this.database
      .prepare<
        [string],
        ExecutionRow
      >('SELECT * FROM workflow_adapter_executions WHERE execution_id = ?')
      .get(executionId);
    return row ? parseRow(row) : null;
  }

  listRecoverable(): WorkflowAdapterExecutionRecord[] {
    return this.database
      .prepare<[], ExecutionRow>(
        `SELECT * FROM workflow_adapter_executions
          WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
          ORDER BY created_at_ms, execution_id`,
      )
      .all()
      .map(parseRow);
  }

  listPendingCallbacks(): WorkflowAdapterExecutionRecord[] {
    return this.database
      .prepare<[], ExecutionRow>(
        `SELECT * FROM workflow_adapter_executions
          WHERE state IN ('succeeded', 'failed', 'cancelled', 'blocked')
            AND callback_state = 'pending'
          ORDER BY updated_at_ms, execution_id`,
      )
      .all()
      .map(parseRow);
  }

  markAccepted(
    executionId: string,
    providerMetadata: Record<string, unknown>,
    nowMs: number,
  ): WorkflowAdapterExecutionRecord {
    const changed = this.database
      .prepare(
        `UPDATE workflow_adapter_executions
            SET state = 'accepted', provider_metadata_json = ?, updated_at_ms = ?
          WHERE execution_id = ? AND state IN ('reserved', 'accepted')`,
      )
      .run(exactJson(providerMetadata), nowMs, executionId).changes;
    if (changed !== 1)
      throw new Error(
        `Cannot accept Workflow Adapter execution ${executionId}`,
      );
    return this.get(executionId)!;
  }

  markRunning(executionId: string, nowMs: number): void {
    const changed = this.database
      .prepare(
        `UPDATE workflow_adapter_executions
            SET state = 'running', updated_at_ms = ?
          WHERE execution_id = ? AND state IN ('accepted', 'running')`,
      )
      .run(nowMs, executionId).changes;
    if (changed !== 1)
      throw new Error(`Cannot run Workflow Adapter execution ${executionId}`);
  }

  markTerminal(
    executionId: string,
    state: (typeof TERMINAL_STATES)[number],
    result: WorkflowAgentResult,
    errorCode: string | null,
    nowMs: number,
  ): WorkflowAdapterExecutionRecord {
    if (!TERMINAL_STATES.includes(state))
      throw new Error(`Invalid Workflow Adapter terminal state: ${state}`);
    const resultJson = exactJson(workflowAgentResultSchema.parse(result));
    const current = this.get(executionId);
    if (!current)
      throw new Error(`Workflow Adapter execution not found: ${executionId}`);
    if (TERMINAL_STATES.includes(current.state)) {
      if (
        current.state !== state ||
        exactJson(current.result) !== resultJson ||
        current.errorCode !== errorCode
      ) {
        throw new Error(
          `Workflow Adapter terminal replay drift: ${executionId}`,
        );
      }
      return current;
    }
    const changed = this.database
      .prepare(
        `UPDATE workflow_adapter_executions
            SET state = ?, result_json = ?, error_code = ?, updated_at_ms = ?
          WHERE execution_id = ?
            AND state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')`,
      )
      .run(state, resultJson, errorCode, nowMs, executionId).changes;
    if (changed !== 1)
      throw new Error(
        `Cannot finish Workflow Adapter execution ${executionId}`,
      );
    return this.get(executionId)!;
  }

  markCallbackDelivered(executionId: string, nowMs: number): void {
    const changed = this.database
      .prepare(
        `UPDATE workflow_adapter_executions
            SET callback_state = 'delivered', callback_delivered_at_ms = ?,
                updated_at_ms = ?
          WHERE execution_id = ?
            AND state IN ('succeeded', 'failed', 'cancelled', 'blocked')
            AND callback_state IN ('pending', 'delivered')`,
      )
      .run(nowMs, nowMs, executionId).changes;
    if (changed !== 1)
      throw new Error(
        `Cannot deliver Workflow Adapter callback ${executionId}`,
      );
  }

  close(): void {
    if (this.database.open) this.database.close();
  }
}
