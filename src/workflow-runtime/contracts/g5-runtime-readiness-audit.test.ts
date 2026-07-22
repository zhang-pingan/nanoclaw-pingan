import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function objects(value: unknown): JsonObject[] {
  expect(Array.isArray(value)).toBe(true);
  return value as JsonObject[];
}

describe('G5 Basic Runtime readiness audit', () => {
  it('proves the frozen T6d workflow-deadline path requires the G7-owned Runtime Command Gateway', () => {
    const authority = readArtifact(
      'governance/workflow-runtime-gate-ownership@1.json',
    );
    expect(authority.hash).toBe(
      'sha256:36289416db3c8898d9b50c04c5ad43fc6b74ef53bbd3a3c99f9d5f5b72786fa8',
    );
    const matrix = objects(authority.payload.matrix);
    const g5 = matrix.find((entry) => entry.gate === 'G5')!;
    const g7 = matrix.find((entry) => entry.gate === 'G7')!;

    const transactions = readArtifact(
      'protocols/workflow-run-transaction-protocol-table.json',
    );
    const transactionEntries = objects(transactions.payload.entries);
    const t6d = transactionEntries.find(
      (entry) => entry.transaction_id === 'T6d',
    )!;
    const t7c = transactionEntries.find(
      (entry) => entry.transaction_id === 'T7c',
    )!;

    const commands = readArtifact(
      'protocols/workflow-runtime-command-protocol-table.json',
    );
    const commandEntries = objects(commands.payload.entries);
    const deadlineCancel = commandEntries.find(
      (entry) => entry.command_type === 'cancel_workflow',
    )!;
    const manualRetryAdvance = commandEntries.find(
      (entry) => entry.command_type === 'advance_retry_schedule',
    )!;

    const queries = readArtifact(
      'sqlite/workflow-runtime-query-catalog@1.json',
    );
    const queryEntries = objects(queries.payload.queries);
    const deadlineDue = queryEntries.find(
      (entry) => entry.query_id === 'query:workflow_deadline_due',
    )!;
    const commandLookup = queryEntries.find(
      (entry) => entry.query_id === 'query:command_idempotency_lookup',
    )!;

    expect(g5.owned_transaction_protocols).toContain('T6d');
    expect(g5.explicitly_excluded_semantics).toContain(
      'runtime_command_gateway',
    );
    expect(g7.owned_semantics).toContain('runtime_command_gateway');
    expect(t6d.atomic_writes).toContain('stable_workflow_deadline_t7c_command');
    expect(t6d.failure_or_late_outcomes).toContain('late_deadline_command');
    expect(deadlineCancel.transaction_protocol).toBe('T7c');
    expect(deadlineCancel.system_grant).toMatchObject({
      actor_kind: 'system',
      reason_codes: ['deadline_enforced', 'safety_enforced'],
      predicate: 'due_target',
      authority_scope: 'cancel_workflow_only',
    });
    expect(t7c.preconditions).toContain('authorized_cancel_command');
    expect(t7c.atomic_writes).toContain('command_invocation_audit');
    expect(manualRetryAdvance.transaction_protocol).toBe('T6d');
    expect(deadlineDue.owner).toBe('workflow_watchdog');
    expect(commandLookup.owner).toBe('command_gateway');
  });

  it('proves Schema 4 has no independent durable workflow-deadline handoff relation', () => {
    const manifest = readArtifact(
      '../store/schema/artifacts/workflow-runtime-schema-manifest@1.json',
    );
    expect(manifest.hash).toBe(
      'sha256:87f6787dd5c6382df97120c2e10dc6624143c67efc35e57cb92ea22f16fa666b',
    );
    expect(manifest.payload.database_schema_version).toBe(4);
    const schemaTables = objects(manifest.payload.tables);
    const tableNames = schemaTables.map((table) => String(table.name));
    const handoffPattern =
      /deadline.*(?:handoff|intent|command)|(?:handoff|intent|command).*deadline|watchdog/;
    expect(tableNames.filter((name) => handoffPattern.test(name))).toEqual([]);
    expect(
      schemaTables.flatMap((table) =>
        objects(table.columns)
          .map((column) => `${String(table.name)}.${String(column.name)}`)
          .filter((name) => handoffPattern.test(name)),
      ),
    ).toEqual([]);
    expect(tableNames).toContain('workflow_runtime_commands');
    expect(tableNames).toContain('workflow_runtime_command_invocations');
  });
});
