import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { RUN_TRANSACTION_PROTOCOL_ENTRIES } from './protocol-table-types.js';
import type { Sha256Hash } from './types.js';
import { acquireDomainClaim } from '../creation/domain-claims.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import { renderMigration } from '../store/schema/ddl.js';
import { createMigratedDatabase } from '../store/schema/sqlite-gate.js';
import { loadExecutableSchemaSource } from '../store/schema/source.js';
import { stableRuntimeId } from '../runtime/graph-store.js';

const schema = loadExecutableSchemaSource();
const migration = renderMigration(schema);

function hash(label: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

class TestTransaction implements WorkflowRuntimeWriteTransaction {
  readonly transactionKind = 'immediate' as const;

  constructor(private readonly database: Database.Database) {}

  execute(sql: string, parameters: readonly WorkflowRuntimeSqlValue[]) {
    const result = this.database.prepare(sql).run(...parameters);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[] {
    return this.database.prepare(sql).all(...parameters) as T[];
  }

  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined {
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }
}

describe('G6 required-child Domain Claim handoff blocker', () => {
  it('pins the T8 atomic handoff requirement against the current all-status resource unique key', () => {
    const t8 = RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
      (entry) => entry.transaction_id === 'T8',
    )!;
    expect(t8.atomic_writes).toContain(
      'all_required_child_workflows_relations_claim_handoffs',
    );
    expect(t8.cas_guards).toContain(
      'required_child_schedule_and_claim_versions',
    );

    const claims = schema.tables.find(
      (table) => table.name === 'workflow_domain_resource_claims',
    )!;
    expect(
      claims.unique_keys.find(
        (key) => key.key_id === 'uk:domain_claims:resource',
      ),
    ).toMatchObject({ columns: ['namespace', 'key_hash'] });
    expect(
      claims.columns.find((column) => column.name === 'status')?.enum_values,
    ).toEqual(['held', 'release_pending', 'released']);
  });

  it('proves the owner-bound Production acquire cannot reacquire a released resource for a required Child', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-g6-claim-handoff-blocker-'),
    );
    const database = createMigratedDatabase(
      path.join(root, 'workflow-runtime.db'),
      migration.sql,
    );
    const namespace = 'fixture.domain';
    const keyHash = hash('shared-resource');
    const parentClaimId = stableRuntimeId('claim', {
      namespace,
      key_hash: keyHash,
      owner_workflow_id: 'workflow:parent',
      creation_key: 'parent-key',
    });
    const childClaimId = stableRuntimeId('claim', {
      namespace,
      key_hash: keyHash,
      owner_workflow_id: 'workflow:child',
      creation_key: 'child-key',
    });
    try {
      expect(childClaimId).not.toBe(parentClaimId);
      database.pragma('foreign_keys = OFF');
      database
        .prepare(
          `INSERT INTO workflow_domain_resource_claims (
             id, namespace, key_hash, mode, owner_workflow_id,
             recipe_resource_id, recipe_resource_hash, source_intake_id,
             creation_key, fencing_token, status, acquired_at_ms,
             released_at_ms, row_version
           ) VALUES (?, ?, ?, 'exclusive', 'workflow:parent',
             'resource:recipe', ?, 'intake:parent', 'parent-key', 1,
             'released', 1, 2, 2)`,
        )
        .run(parentClaimId, namespace, keyHash, hash('recipe'));
      database
        .prepare(
          `INSERT INTO workflow_domain_resource_heads (
             namespace, key_hash, current_fencing_token, row_version
           ) VALUES (?, ?, 1, 1)`,
        )
        .run(namespace, keyHash);
      database.pragma('foreign_keys = ON');

      database.exec('BEGIN IMMEDIATE');
      expect(() =>
        acquireDomainClaim(new TestTransaction(database), {
          namespace,
          keyHash,
          mode: 'exclusive',
          ownerWorkflowId: 'workflow:child',
          recipeResourceId: 'resource:recipe',
          recipeResourceHash: hash('recipe'),
          sourceIntakeId: 'intake:child',
          creationKey: 'child-key',
          acquiredAtMs: 3,
        }),
      ).toThrow(
        /UNIQUE constraint failed: workflow_domain_resource_claims\.namespace, workflow_domain_resource_claims\.key_hash/,
      );
      database.exec('ROLLBACK');

      expect(
        database
          .prepare(
            'SELECT id, owner_workflow_id, status, fencing_token FROM workflow_domain_resource_claims',
          )
          .all(),
      ).toEqual([
        {
          id: parentClaimId,
          owner_workflow_id: 'workflow:parent',
          status: 'released',
          fencing_token: 1,
        },
      ]);
      expect(
        database
          .prepare(
            'SELECT current_fencing_token FROM workflow_domain_resource_heads WHERE namespace = ? AND key_hash = ?',
          )
          .pluck()
          .get(namespace, keyHash),
      ).toBe(1);
    } finally {
      if (database.inTransaction) database.exec('ROLLBACK');
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
