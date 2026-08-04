import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireDomainClaim,
  acquireCurrentDomainClaim,
  handoffRequiredChildDomainClaim,
  releaseDomainClaim,
  type DomainClaimFault,
  type DomainClaimRequest,
  type RequiredChildDomainClaimHandoffRequest,
} from '../creation/domain-claims.js';
import type { Sha256Hash } from './types.js';
import {
  buildR022DomainClaimHandoffArtifactsForTest,
  checkR022DomainClaimHandoffContract,
  R022_HISTORICAL_BLOCKER_SHA256,
  R022_SPEC_HEADING,
} from './r022-domain-claim-handoff-contract.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import { renderMigration } from '../store/schema/ddl.js';
import { createMigratedDatabase } from '../store/schema/sqlite-gate.js';
import {
  loadCurrentExecutableSchemaSource,
  loadSchema9ExecutableSchemaSource,
} from '../store/schema/source.js';
import type { ExecutableSchemaSource } from '../store/schema/types.js';

const currentSchema = loadCurrentExecutableSchemaSource();
const currentMigration = renderMigration(currentSchema);
const schema9 = loadSchema9ExecutableSchemaSource();
const schema9Migration = renderMigration(schema9);
const roots: string[] = [];

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

function transaction<T>(
  database: Database.Database,
  action: (tx: TestTransaction) => T,
): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action(new TestTransaction(database));
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function defaultValue(
  table: string,
  column: ExecutableSchemaSource['tables'][number]['columns'][number],
  suffix: string,
): string | number | null {
  if (column.nullable) return null;
  if (column.enum_values.length > 0) return column.enum_values[0]!;
  if (
    typeof column.default_intent === 'string' ||
    typeof column.default_intent === 'number'
  )
    return column.default_intent;
  if (column.logical_type === 'integer')
    return column.safe_integer_intent === 'positive' ? 1 : 0;
  if (column.logical_type === 'boolean_integer') return 0;
  if (column.logical_type === 'hash')
    return hash(`${table}:${column.name}:${suffix}`);
  if (column.logical_type === 'canonical_json') return '{}';
  return `${table}:${column.name}:${suffix}`;
}

function seedRow(
  database: Database.Database,
  source: ExecutableSchemaSource,
  tableName: string,
  overrides: Record<string, string | number | null>,
  suffix = tableName,
): void {
  const table = source.tables.find(
    (candidate) => candidate.name === tableName,
  )!;
  const auto = table.primary_key.auto_increment_intent
    ? table.primary_key.columns[0]
    : null;
  const columns = table.columns.filter((column) => column.name !== auto);
  database
    .prepare(
      `INSERT INTO "${tableName}" (${columns.map((column) => `"${column.name}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(
      ...columns.map((column) =>
        Object.hasOwn(overrides, column.name)
          ? overrides[column.name]
          : defaultValue(tableName, column, suffix),
      ),
    );
}

interface Fixture {
  readonly root: string;
  readonly path: string;
  readonly database: Database.Database;
  readonly namespace: string;
  readonly keyHash: Sha256Hash;
  readonly recipeHash: Sha256Hash;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-r022-'));
  roots.push(root);
  const databasePath = path.join(root, 'workflow-runtime.db');
  const database = createMigratedDatabase(databasePath, currentMigration.sql);
  database.pragma('foreign_keys = OFF');
  database.pragma('ignore_check_constraints = ON');
  const recipeHash = hash('recipe');
  for (const id of ['workflow:parent', 'workflow:child', 'workflow:other'])
    seedRow(database, currentSchema, 'workflows', { id }, id);
  seedRow(database, currentSchema, 'workflow_registry_resources', {
    id: 'resource:recipe',
    content_hash: recipeHash,
  });
  for (const id of ['intake:parent', 'intake:child'])
    seedRow(database, currentSchema, 'workflow_task_intakes', { id }, id);
  for (const id of ['creation:child', 'creation:ready', 'creation:other'])
    seedRow(database, currentSchema, 'workflow_creation_requests', { id }, id);
  seedRow(
    database,
    currentSchema,
    'workflow_relations',
    {
      id: 'relation:parent-child',
      parent_workflow_id: 'workflow:parent',
      child_workflow_id: 'workflow:child',
    },
    'relation:parent-child',
  );
  seedRow(
    database,
    currentSchema,
    'workflow_relations',
    {
      id: 'relation:parent-other',
      parent_workflow_id: 'workflow:parent',
      child_workflow_id: 'workflow:other',
    },
    'relation:parent-other',
  );
  seedRow(
    database,
    currentSchema,
    'workflow_root_finalization_schedules',
    {
      id: 'schedule:child',
      workflow_id: 'workflow:parent',
      creation_request_id: 'creation:child',
      child_workflow_id: 'workflow:child',
      status: 'succeeded',
    },
    'schedule:child',
  );
  seedRow(
    database,
    currentSchema,
    'workflow_root_finalization_schedules',
    {
      id: 'schedule:ready',
      workflow_id: 'workflow:parent',
      creation_request_id: 'creation:ready',
      child_workflow_id: 'workflow:child',
      status: 'ready',
    },
    'schedule:ready',
  );
  seedRow(
    database,
    currentSchema,
    'workflow_root_finalization_schedules',
    {
      id: 'schedule:parent-other',
      workflow_id: 'workflow:parent',
      creation_request_id: 'creation:other',
      child_workflow_id: 'workflow:other',
      status: 'succeeded',
    },
    'schedule:parent-other',
  );
  for (const [id, workflowId] of [
    ['run:parent', 'workflow:parent'],
    ['run:child', 'workflow:child'],
    ['run:other', 'workflow:other'],
  ] as const)
    seedRow(database, currentSchema, 'workflow_graph_runs', {
      id,
      workflow_id: workflowId,
    });
  for (const [id, runId] of [
    ['effect:parent', 'run:parent'],
    ['effect:child:valid', 'run:child'],
    ['effect:child:wrong-owner', 'run:child'],
    ['effect:child:wrong-run', 'run:child'],
    ['effect:child:wrong-resource', 'run:child'],
    ['effect:child:wrong-epoch', 'run:child'],
    ['effect:child:wrong-token', 'run:child'],
  ] as const)
    seedRow(
      database,
      currentSchema,
      'workflow_graph_effect_operations',
      {
        id,
        graph_run_id: runId,
      },
      id,
    );
  database.pragma('ignore_check_constraints = OFF');
  database.pragma('foreign_keys = ON');
  return {
    root,
    path: databasePath,
    database,
    namespace: 'workspace',
    keyHash: hash('resource'),
    recipeHash,
  };
}

function claimRequest(
  value: Fixture,
  owner: 'workflow:parent' | 'workflow:child',
  creationKey: string,
  acquiredAtMs: number,
): DomainClaimRequest {
  return {
    namespace: value.namespace,
    keyHash: value.keyHash,
    mode: 'exclusive',
    ownerWorkflowId: owner,
    recipeResourceId: 'resource:recipe',
    recipeResourceHash: value.recipeHash,
    sourceIntakeId:
      owner === 'workflow:parent' ? 'intake:parent' : 'intake:child',
    creationKey,
    acquiredAtMs,
  };
}

function parentClaim(value: Fixture) {
  return transaction(value.database, (tx) =>
    acquireCurrentDomainClaim(
      tx,
      claimRequest(value, 'workflow:parent', 'parent', 10),
    ),
  );
}

function handoffRequest(
  value: Fixture,
  parentClaimId: string,
): RequiredChildDomainClaimHandoffRequest {
  return {
    parentClaimId,
    parentWorkflowId: 'workflow:parent',
    expectedParentClaimRowVersion: 1,
    expectedHeadRowVersion: 1,
    expectedParentFencingToken: 1,
    child: {
      ...claimRequest(value, 'workflow:child', 'child', 20),
      mode: 'exclusive',
    },
    rootFinalizationScheduleId: 'schedule:child',
    creationRequestId: 'creation:child',
    workflowRelationId: 'relation:parent-child',
    transferredAtMs: 21,
  };
}

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('R-022 required Child Domain Claim handoff', () => {
  it('pins the machine Contract, exact relation tuples, and historical blocker bytes', () => {
    const pack = checkR022DomainClaimHandoffContract();
    expect(pack.payload).toMatchObject({
      affected_gate_status: 'IN_PROGRESS',
      g6_production_implementation_count: 0,
      g6_status: 'BLOCKED_PENDING_REGRESSION_NOT_STARTED',
    });
    const prerequisite = JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          '../store/schema/inputs/workflow-domain-claim-handoff-schema-prerequisite@1.json',
        ),
        'utf8',
      ),
    ) as {
      payload: { relationship_contract: { exact_typed_relations: unknown[] } };
    };
    expect(
      prerequisite.payload.relationship_contract.exact_typed_relations,
    ).toHaveLength(11);
    const blocker = fs.readFileSync(
      path.join(
        import.meta.dirname,
        'g6-required-child-claim-handoff-blocker.test.ts',
      ),
    );
    expect(crypto.createHash('sha256').update(blocker).digest('hex')).toBe(
      R022_HISTORICAL_BLOCKER_SHA256,
    );
    const claims = currentSchema.tables.find(
      (table) => table.name === 'workflow_domain_resource_claims',
    )!;
    expect(
      claims.unique_keys.some(
        (key) => key.key_id === 'uk:domain_claims:resource',
      ),
    ).toBe(false);
    expect(
      claims.unique_keys.some(
        (key) => key.key_id === 'uk:domain_claims:resource_epoch',
      ),
    ).toBe(true);
  });

  it('fails Contract generation closed on normative section tamper', () => {
    const spec = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../../docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
      ),
      'utf8',
    );
    expect(buildR022DomainClaimHandoffArtifactsForTest(spec).size).toBe(2);
    expect(() =>
      buildR022DomainClaimHandoffArtifactsForTest(
        spec.replace(R022_SPEC_HEADING, '### removed R-022 heading'),
      ),
    ).toThrow(/normative section/);
  });

  it('releases and reacquires with append-only history and monotonic fencing', () => {
    const value = fixture();
    const parent = parentClaim(value);
    expect(parent).toMatchObject({ claimEpoch: 1, fencingToken: 1 });
    expect(
      transaction(value.database, (tx) =>
        releaseDomainClaim(tx, {
          claimId: parent.claimId,
          ownerWorkflowId: 'workflow:parent',
          expectedClaimRowVersion: 1,
          expectedHeadRowVersion: 1,
          expectedFencingToken: 1,
          releasedAtMs: 15,
        }),
      ).disposition,
    ).toBe('released');
    const child = transaction(value.database, (tx) =>
      acquireCurrentDomainClaim(
        tx,
        claimRequest(value, 'workflow:child', 'direct-child', 16),
      ),
    );
    expect(child).toMatchObject({ claimEpoch: 2, fencingToken: 2 });
    expect(
      value.database
        .prepare(
          'SELECT owner_workflow_id, status, claim_epoch, fencing_token FROM workflow_domain_resource_claims ORDER BY claim_epoch',
        )
        .all(),
    ).toEqual([
      {
        owner_workflow_id: 'workflow:parent',
        status: 'released',
        claim_epoch: 1,
        fencing_token: 1,
      },
      {
        owner_workflow_id: 'workflow:child',
        status: 'held',
        claim_epoch: 2,
        fencing_token: 2,
      },
    ]);
  });

  it('atomically hands off to an owner-bound Child and replays after reopen with zero DML', () => {
    const value = fixture();
    const parent = parentClaim(value);
    const request = handoffRequest(value, parent.claimId);
    const receipt = transaction(value.database, (tx) =>
      handoffRequiredChildDomainClaim(tx, request),
    );
    expect(receipt).toMatchObject({
      disposition: 'handed_off',
      childClaimEpoch: 2,
      childFencingToken: 2,
    });
    const before = value.database.serialize();
    value.database.close();
    const reopened = new Database(value.path);
    reopened.pragma('foreign_keys = ON');
    const replay = transaction(reopened, (tx) =>
      handoffRequiredChildDomainClaim(tx, request),
    );
    expect(replay).toEqual({ ...receipt, disposition: 'exact_replay' });
    expect(reopened.serialize().equals(before)).toBe(true);
    transaction(reopened, (tx) =>
      releaseDomainClaim(tx, {
        claimId: receipt.childClaimId,
        ownerWorkflowId: 'workflow:child',
        expectedClaimRowVersion: 1,
        expectedHeadRowVersion: 2,
        expectedFencingToken: 2,
        releasedAtMs: 30,
      }),
    );
    const afterChildRelease = reopened.serialize();
    expect(
      transaction(reopened, (tx) =>
        handoffRequiredChildDomainClaim(tx, request),
      ),
    ).toEqual({ ...receipt, disposition: 'exact_replay' });
    expect(reopened.serialize().equals(afterChildRelease)).toBe(true);
    reopened.close();
  });

  it.each<DomainClaimFault>([
    'after_parent_release',
    'after_head_change',
    'after_child_insert',
    'after_handoff_insert',
  ])('rolls the complete handoff back at %s', (fault) => {
    const value = fixture();
    const parent = parentClaim(value);
    const before = value.database.serialize();
    expect(() =>
      transaction(value.database, (tx) =>
        handoffRequiredChildDomainClaim(
          tx,
          handoffRequest(value, parent.claimId),
          fault,
        ),
      ),
    ).toThrow(`injected_fault:${fault}`);
    expect(value.database.serialize().equals(before)).toBe(true);
  });

  it('rejects wrong owner, resource, fencing token, relation, and stale versions', () => {
    const cases: Array<
      (
        request: RequiredChildDomainClaimHandoffRequest,
      ) => RequiredChildDomainClaimHandoffRequest
    > = [
      (request) => ({ ...request, parentWorkflowId: 'workflow:other' }),
      (request) => ({
        ...request,
        child: { ...request.child, ownerWorkflowId: 'workflow:other' },
      }),
      (request) => ({ ...request, expectedParentFencingToken: 2 }),
      (request) => ({ ...request, expectedParentClaimRowVersion: 2 }),
      (request) => ({ ...request, expectedHeadRowVersion: 2 }),
      (request) => ({
        ...request,
        child: { ...request.child, keyHash: hash('wrong-resource') },
      }),
      (request) => ({
        ...request,
        rootFinalizationScheduleId: 'schedule:ready',
      }),
      (request) => ({ ...request, creationRequestId: 'creation:other' }),
      (request) => ({
        ...request,
        workflowRelationId: 'relation:parent-other',
      }),
    ];
    for (const mutate of cases) {
      const value = fixture();
      const parent = parentClaim(value);
      expect(() =>
        transaction(value.database, (tx) =>
          handoffRequiredChildDomainClaim(
            tx,
            mutate(handoffRequest(value, parent.claimId)),
          ),
        ),
      ).toThrow();
      expect(
        value.database
          .prepare(
            'SELECT status FROM workflow_domain_resource_claims WHERE id = ?',
          )
          .pluck()
          .get(parent.claimId),
      ).toBe('held');
      value.database.close();
    }
  });

  it('rejects duplicate Parent/Child handoff and preserves the committed tuple', () => {
    const value = fixture();
    const parent = parentClaim(value);
    const request = handoffRequest(value, parent.claimId);
    const receipt = transaction(value.database, (tx) =>
      handoffRequiredChildDomainClaim(tx, request),
    );
    const before = value.database.serialize();
    expect(() =>
      transaction(value.database, (tx) =>
        handoffRequiredChildDomainClaim(tx, {
          ...request,
          child: {
            ...request.child,
            creationKey: 'duplicate-child',
            acquiredAtMs: 22,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      transaction(value.database, (tx) =>
        tx.execute(
          `INSERT INTO workflow_domain_resource_claim_handoffs
           SELECT id || ':duplicate', namespace, key_hash, parent_claim_id,
                  parent_workflow_id, parent_claim_mode, parent_claim_epoch,
                  parent_fencing_token, child_claim_id, child_workflow_id,
                  child_claim_mode, child_claim_epoch, child_fencing_token,
                  source_root_finalization_schedule_id,
                  source_creation_request_id, source_workflow_relation_id,
                  source_root_finalization_schedule_status, created_at_ms
             FROM workflow_domain_resource_claim_handoffs WHERE id = ?`,
          [receipt.handoffId],
        ),
      ),
    ).toThrow(/UNIQUE/);
    expect(value.database.serialize().equals(before)).toBe(true);
    value.database.close();
  });

  it('rejects Claim, Head, Handoff, and current-link tamper at the database boundary', () => {
    const value = fixture();
    const parent = parentClaim(value);
    const receipt = transaction(value.database, (tx) =>
      handoffRequiredChildDomainClaim(
        tx,
        handoffRequest(value, parent.claimId),
      ),
    );
    const before = value.database.serialize();
    for (const [sql, parameters, message] of [
      [
        `UPDATE workflow_domain_resource_claims
            SET acquired_at_ms = 999, status = 'released', released_at_ms = 31,
                active_head_claim_id = NULL, row_version = row_version + 1
          WHERE id = ?`,
        [receipt.childClaimId],
        /domain_claim_identity_is_immutable/,
      ],
      [
        'UPDATE workflow_domain_resource_claim_handoffs SET created_at_ms = 999 WHERE id = ?',
        [receipt.handoffId],
        /domain_claim_handoff_is_immutable/,
      ],
      [
        'DELETE FROM workflow_domain_resource_claims WHERE id = ?',
        [parent.claimId],
        /domain_claim_history_is_immutable/,
      ],
    ] as const) {
      expect(() =>
        transaction(value.database, (tx) => tx.execute(sql, parameters)),
      ).toThrow(message);
    }
    expect(() =>
      transaction(value.database, (tx) =>
        tx.execute(
          `UPDATE workflow_domain_resource_claims
              SET status = 'released', released_at_ms = 31,
                  active_head_claim_id = NULL, row_version = row_version + 1
            WHERE id = ?`,
          [receipt.childClaimId],
        ),
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(value.database.serialize().equals(before)).toBe(true);

    transaction(value.database, (tx) =>
      releaseDomainClaim(tx, {
        claimId: receipt.childClaimId,
        ownerWorkflowId: 'workflow:child',
        expectedClaimRowVersion: 1,
        expectedHeadRowVersion: 2,
        expectedFencingToken: receipt.childFencingToken,
        releasedAtMs: 32,
      }),
    );
    const releasedBefore = value.database.serialize();
    expect(() =>
      transaction(value.database, (tx) =>
        tx.execute(
          'DELETE FROM workflow_domain_resource_heads WHERE namespace = ? AND key_hash = ?',
          [value.namespace, value.keyHash],
        ),
      ),
    ).toThrow(/domain_resource_head_history_is_immutable/);
    expect(value.database.serialize().equals(releasedBefore)).toBe(true);
    value.database.close();
  });

  it('enforces exact Effect Claim run, owner, resource, epoch, and fencing lineage', () => {
    const value = fixture();
    const parent = parentClaim(value);
    const insert = (input: {
      operation: string;
      claimId: string;
      graphRunId: string;
      owner: string;
      namespace: string;
      keyHash: string;
      epoch: number;
      fencingToken: number;
      fencingIdentity: number;
    }) =>
      transaction(value.database, (tx) =>
        tx.execute(
          `INSERT INTO workflow_graph_effect_operation_claims (
             operation_id, claim_id, claim_spec_id, access, fencing_token,
             graph_run_id, owner_workflow_id, namespace, key_hash,
             claim_epoch, fencing_token_identity
           ) VALUES (?, ?, 'spec:write', 'write', ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.operation,
            input.claimId,
            input.fencingToken,
            input.graphRunId,
            input.owner,
            input.namespace,
            input.keyHash,
            input.epoch,
            input.fencingIdentity,
          ],
        ),
      );
    insert({
      operation: 'effect:parent',
      claimId: parent.claimId,
      graphRunId: 'run:parent',
      owner: 'workflow:parent',
      namespace: value.namespace,
      keyHash: value.keyHash,
      epoch: 1,
      fencingToken: 1,
      fencingIdentity: 1,
    });
    const receipt = transaction(value.database, (tx) =>
      handoffRequiredChildDomainClaim(
        tx,
        handoffRequest(value, parent.claimId),
      ),
    );
    const child = {
      claimId: receipt.childClaimId,
      graphRunId: 'run:child',
      owner: 'workflow:child',
      namespace: value.namespace,
      keyHash: value.keyHash,
      epoch: 2,
      fencingToken: 2,
      fencingIdentity: 2,
    };
    expect(() =>
      insert({ operation: 'effect:child:valid', ...child }),
    ).not.toThrow();
    for (const input of [
      {
        operation: 'effect:child:wrong-owner',
        ...child,
        owner: 'workflow:other',
      },
      {
        operation: 'effect:child:wrong-run',
        ...child,
        graphRunId: 'run:parent',
      },
      {
        operation: 'effect:child:wrong-resource',
        ...child,
        keyHash: hash('wrong-effect-resource'),
      },
      { operation: 'effect:child:wrong-epoch', ...child, epoch: 1 },
      {
        operation: 'effect:child:wrong-token',
        ...child,
        fencingToken: 1,
      },
    ]) {
      expect(() => insert(input)).toThrow();
    }
    expect(
      value.database
        .prepare(
          `SELECT claim.owner_workflow_id, claim.status, effect.fencing_token
             FROM workflow_graph_effect_operation_claims AS effect
             JOIN workflow_domain_resource_claims AS claim ON claim.id = effect.claim_id
            WHERE effect.operation_id = 'effect:parent'`,
        )
        .get(),
    ).toEqual({
      owner_workflow_id: 'workflow:parent',
      status: 'released',
      fencing_token: 1,
    });
    expect(
      value.database
        .prepare(
          `SELECT count(*) FROM pragma_foreign_key_check
            WHERE "table" IN (
              'workflow_domain_resource_claims',
              'workflow_domain_resource_heads',
              'workflow_domain_resource_claim_handoffs',
              'workflow_graph_effect_operation_claims'
            )`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it('fails closed when current and historical Schema/Claim authorities cross', () => {
    expect(schema9.database_schema_version).toBe(9);
    expect(currentSchema.database_schema_version).toBe(11);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-r022-cross-'));
    roots.push(root);
    const historical = createMigratedDatabase(
      path.join(root, 'schema9.db'),
      schema9Migration.sql,
    );
    const historicalBefore = historical.serialize();
    expect(() =>
      transaction(historical, (tx) =>
        acquireCurrentDomainClaim(tx, {
          namespace: 'cross',
          keyHash: hash('cross'),
          mode: 'exclusive',
          ownerWorkflowId: 'workflow:cross',
          recipeResourceId: 'resource:cross',
          recipeResourceHash: hash('recipe:cross'),
          sourceIntakeId: 'intake:cross',
          creationKey: 'cross',
          acquiredAtMs: 1,
        }),
      ),
    ).toThrow(/claim_epoch|latest_claim_epoch|active_claim/);
    expect(historical.serialize().equals(historicalBefore)).toBe(true);
    historical.close();

    const current = fixture();
    const currentBefore = current.database.serialize();
    expect(() =>
      transaction(current.database, (tx) =>
        acquireDomainClaim(
          tx,
          claimRequest(current, 'workflow:parent', 'historical-cross', 1),
        ),
      ),
    ).toThrow(/NOT NULL|domain_resource_head/);
    expect(current.database.serialize().equals(currentBefore)).toBe(true);
    current.database.close();
  });

  it('upgrades valid nonempty Schema 9 history and rolls invalid/copy faults back', () => {
    const upgrade = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '../store/schema/migration/workflow-runtime-schema-v9-to-v10.sql',
      ),
      'utf8',
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-r022-upgrade-'));
    roots.push(root);
    const seedHistory = (
      database: Database.Database,
      label: string,
      mode: 'shared' | 'exclusive',
      fencingToken: number | null,
      status: 'held' | 'released',
    ) => {
      const owner = `workflow:${label}`;
      const recipe = `resource:${label}`;
      const intake = `intake:${label}`;
      seedRow(database, schema9, 'workflows', { id: owner }, owner);
      seedRow(database, schema9, 'workflow_registry_resources', {
        id: recipe,
        content_hash: hash(`recipe:${label}`),
      });
      seedRow(
        database,
        schema9,
        'workflow_task_intakes',
        { id: intake },
        intake,
      );
      seedRow(database, schema9, 'workflow_domain_resource_claims', {
        id: `claim:${label}`,
        namespace: label,
        key_hash: hash(label),
        mode,
        owner_workflow_id: owner,
        recipe_resource_id: recipe,
        recipe_resource_hash: hash(`recipe:${label}`),
        source_intake_id: intake,
        creation_key: label,
        fencing_token: fencingToken,
        status,
        acquired_at_ms: 1,
        released_at_ms: status === 'released' ? 2 : null,
        row_version: status === 'released' ? 2 : 1,
      });
    };
    const valid = createMigratedDatabase(
      path.join(root, 'valid.db'),
      schema9Migration.sql,
    );
    valid.pragma('foreign_keys = OFF');
    valid.pragma('ignore_check_constraints = ON');
    seedHistory(valid, 'history', 'shared', null, 'released');
    valid.pragma('ignore_check_constraints = OFF');
    valid.pragma('foreign_keys = ON');
    valid.exec('BEGIN IMMEDIATE');
    valid.exec(upgrade);
    valid.exec('COMMIT');
    expect(valid.pragma('user_version', { simple: true })).toBe(10);
    expect(
      valid
        .prepare(
          'SELECT claim_epoch, acquisition_kind, active_head_claim_id FROM workflow_domain_resource_claims WHERE id = ?',
        )
        .get('claim:history'),
    ).toEqual({
      claim_epoch: 1,
      acquisition_kind: 'direct',
      active_head_claim_id: null,
    });
    valid.close();

    const invalid = createMigratedDatabase(
      path.join(root, 'invalid.db'),
      schema9Migration.sql,
    );
    invalid.pragma('foreign_keys = OFF');
    invalid.pragma('ignore_check_constraints = ON');
    seedHistory(invalid, 'mismatch', 'exclusive', 2, 'held');
    seedRow(invalid, schema9, 'workflow_domain_resource_heads', {
      namespace: 'mismatch',
      key_hash: hash('mismatch'),
      current_fencing_token: 1,
      row_version: 1,
    });
    invalid.pragma('ignore_check_constraints = OFF');
    invalid.pragma('foreign_keys = ON');
    const invalidBefore = invalid.serialize();
    invalid.exec('BEGIN IMMEDIATE');
    expect(() => invalid.exec(upgrade)).toThrow(/violation_count/);
    invalid.exec('ROLLBACK');
    expect(invalid.serialize().equals(invalidBefore)).toBe(true);
    expect(invalid.pragma('user_version', { simple: true })).toBe(9);
    invalid.close();

    const copyFault = createMigratedDatabase(
      path.join(root, 'copy-fault.db'),
      schema9Migration.sql,
    );
    copyFault.pragma('foreign_keys = OFF');
    copyFault.pragma('ignore_check_constraints = ON');
    seedHistory(copyFault, 'copy-fault', 'shared', null, 'released');
    copyFault.pragma('ignore_check_constraints = OFF');
    copyFault.pragma('foreign_keys = ON');
    const copyFaultBefore = copyFault.serialize();
    const copyBoundary =
      'FROM "workflow_domain_resource_claims_schema9";\n\nINSERT INTO "workflow_domain_resource_heads"';
    const faultyUpgrade = upgrade.replace(
      copyBoundary,
      'FROM "workflow_domain_resource_claims_schema9";\n\nSELECT * FROM "r022_injected_copy_fault";\n\nINSERT INTO "workflow_domain_resource_heads"',
    );
    expect(faultyUpgrade).not.toBe(upgrade);
    copyFault.exec('BEGIN IMMEDIATE');
    expect(() => copyFault.exec(faultyUpgrade)).toThrow(
      /r022_injected_copy_fault/,
    );
    copyFault.exec('ROLLBACK');
    expect(copyFault.serialize().equals(copyFaultBefore)).toBe(true);
    expect(copyFault.pragma('user_version', { simple: true })).toBe(9);
    copyFault.close();
  });

  it('rolls a deferred cross-owner Effect Claim migration failure back at commit', () => {
    const upgrade = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '../store/schema/migration/workflow-runtime-schema-v9-to-v10.sql',
      ),
      'utf8',
    );
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-r022-commit-fault-'),
    );
    roots.push(root);
    const database = createMigratedDatabase(
      path.join(root, 'commit-fault.db'),
      schema9Migration.sql,
    );
    database.pragma('foreign_keys = OFF');
    database.pragma('ignore_check_constraints = ON');
    for (const id of ['workflow:claim-owner', 'workflow:run-owner'])
      seedRow(database, schema9, 'workflows', { id }, id);
    seedRow(database, schema9, 'workflow_registry_resources', {
      id: 'resource:commit-fault',
      content_hash: hash('recipe:commit-fault'),
    });
    seedRow(database, schema9, 'workflow_task_intakes', {
      id: 'intake:commit-fault',
    });
    seedRow(database, schema9, 'workflow_domain_resource_claims', {
      id: 'claim:commit-fault',
      namespace: 'commit-fault',
      key_hash: hash('commit-fault'),
      mode: 'shared',
      owner_workflow_id: 'workflow:claim-owner',
      recipe_resource_id: 'resource:commit-fault',
      recipe_resource_hash: hash('recipe:commit-fault'),
      source_intake_id: 'intake:commit-fault',
      creation_key: 'commit-fault',
      fencing_token: null,
      status: 'held',
      acquired_at_ms: 1,
      released_at_ms: null,
      row_version: 1,
    });
    seedRow(database, schema9, 'workflow_graph_runs', {
      id: 'run:commit-fault',
      workflow_id: 'workflow:run-owner',
    });
    seedRow(database, schema9, 'workflow_graph_effect_operations', {
      id: 'effect:commit-fault',
      graph_run_id: 'run:commit-fault',
    });
    seedRow(database, schema9, 'workflow_graph_effect_operation_claims', {
      operation_id: 'effect:commit-fault',
      claim_id: 'claim:commit-fault',
      access: 'read',
      fencing_token: null,
    });
    database.pragma('ignore_check_constraints = OFF');
    database.pragma('foreign_keys = ON');
    const before = database.serialize();
    database.exec('BEGIN IMMEDIATE');
    database.exec(upgrade);
    expect(() => database.exec('COMMIT')).toThrow(/FOREIGN KEY/);
    if (database.inTransaction) database.exec('ROLLBACK');
    expect(database.serialize().equals(before)).toBe(true);
    expect(database.pragma('user_version', { simple: true })).toBe(9);
    database.close();
  });
});
