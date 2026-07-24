import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { pathToFileURL } from 'url';

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { calculateDatabaseSqliteSchemaIdentity } from '../schema/database-identity.js';
import { buildSchemaTriggers, renderMigration } from '../schema/ddl.js';
import {
  loadSchema3ExecutableSchemaSource,
  loadSchema4ExecutableSchemaSource,
} from '../schema/source.js';
import {
  WorkflowRuntimeConnectionFactory,
  WorkflowRuntimeStore,
  WorkflowRuntimeStoreError,
  type WorkflowRuntimeWriteTransaction,
} from './index.js';
import {
  assertRuntimeHostIdentity,
  currentRuntimeHostObservation,
} from './identity.js';
import {
  CURRENT_G1_SCHEMA_IDENTITIES,
  FROZEN_G1_1_IDENTITIES,
  loadFrozenWorkflowRuntimeStoreInputs,
  parseSQLiteExecutionProfilePayload,
} from './profile.js';

const temporaryRoots: string[] = [];
const openStores: WorkflowRuntimeStore[] = [];

function temporaryDatabase(): { root: string; databasePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g1-store-test-'));
  temporaryRoots.push(root);
  return { root, databasePath: path.join(root, 'workflow-runtime.db') };
}

function openFresh(databasePath: string): WorkflowRuntimeStore {
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath,
    databaseMode: 'create',
    identityMode: 'candidate_development',
  });
  openStores.push(store);
  return store;
}

function hash(label: string): string {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function fileHash(filePath: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

interface DatabaseGateSnapshot {
  readonly mainBytes: Buffer;
  readonly mainHash: string;
  readonly userVersion: number;
  readonly sqliteSchemaIdentity: string;
  readonly rowCounts: Readonly<Record<string, number>>;
}

function databaseGateSnapshot(databasePath: string): DatabaseGateSnapshot {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  let userVersion: number;
  let sqliteSchemaIdentity: string;
  let rowCounts: Record<string, number>;
  try {
    userVersion = Number(database.pragma('user_version', { simple: true }));
    sqliteSchemaIdentity = calculateDatabaseSqliteSchemaIdentity(database);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all() as string[];
    rowCounts = Object.fromEntries(
      tables.map((table) => [
        table,
        database.prepare(`SELECT count(*) FROM "${table}"`).pluck().get(),
      ]),
    ) as Record<string, number>;
  } finally {
    database.close();
  }
  const mainBytes = fs.readFileSync(databasePath);
  return {
    mainBytes,
    mainHash: fileHash(databasePath),
    userVersion,
    sqliteSchemaIdentity,
    rowCounts,
  };
}

function expectDatabaseGateUnchanged(
  databasePath: string,
  before: DatabaseGateSnapshot,
): void {
  const after = databaseGateSnapshot(databasePath);
  expect(after.mainBytes.equals(before.mainBytes)).toBe(true);
  expect(after.mainHash).toBe(before.mainHash);
  expect(after.userVersion).toBe(before.userVersion);
  expect(after.sqliteSchemaIdentity).toBe(before.sqliteSchemaIdentity);
  expect(after.rowCounts).toEqual(before.rowCounts);
}

function createSchema3Database(databasePath: string): void {
  const profile = loadFrozenWorkflowRuntimeStoreInputs().profile;
  const database = new Database(databasePath);
  try {
    database.pragma(`page_size = ${profile.page_size}`);
    database.pragma('auto_vacuum = INCREMENTAL');
    database.pragma('foreign_keys = ON');
    database.exec(renderMigration(loadSchema3ExecutableSchemaSource()).sql);
    database.pragma('journal_mode = WAL');
  } finally {
    database.close();
  }
}

function createSchema4Database(databasePath: string): void {
  const profile = loadFrozenWorkflowRuntimeStoreInputs().profile;
  const database = new Database(databasePath);
  try {
    database.pragma(`page_size = ${profile.page_size}`);
    database.pragma('auto_vacuum = INCREMENTAL');
    database.pragma('foreign_keys = ON');
    database.exec(renderMigration(loadSchema4ExecutableSchemaSource()).sql);
    database.pragma('journal_mode = WAL');
  } finally {
    database.close();
  }
}

function insertConstructionOnlyRow(
  databasePath: string,
  relation: string,
): void {
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = OFF');
    database.pragma('ignore_check_constraints = ON');
    const insertTriggerNames: Record<string, string[]> = {
      workflow_feature_release_activation_commands: [
        'trg:activation_commands:retention_observation_insert',
      ],
      workflow_feature_release_activation_invocations: [],
      workflow_feature_release_activation_events: [
        'trg:activation_events:command_binding',
      ],
      workflow_feature_active_releases: [
        'trg:feature_active_releases:target_active_insert',
      ],
    };
    const triggerNames = insertTriggerNames[relation];
    if (!triggerNames)
      throw new Error(`Unknown upgrade gate relation: ${relation}`);
    const schema3Triggers = new Map(
      buildSchemaTriggers(3).map((trigger) => [trigger.name, trigger.sql]),
    );
    for (const triggerName of triggerNames) {
      database.exec(`DROP TRIGGER "${triggerName}"`);
    }
    const columns = database
      .prepare(`PRAGMA table_info("${relation}")`)
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const required = columns.filter(
      (column) => column.notnull === 1 || column.pk > 0,
    );
    database
      .prepare(
        `INSERT INTO "${relation}" (${required.map((column) => `"${column.name}"`).join(', ')}) VALUES (${required.map(() => '?').join(', ')})`,
      )
      .run(
        ...required.map((column) =>
          column.type === 'INTEGER' ? 1 : `construction-${column.name}`,
        ),
      );
    for (const triggerName of triggerNames) {
      const sql = schema3Triggers.get(triggerName);
      if (!sql) throw new Error(`Missing Schema 3 trigger ${triggerName}`);
      database.exec(sql);
    }
    database.pragma('ignore_check_constraints = OFF');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

function driftSchema3SqliteIdentity(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(
      'CREATE INDEX "idx:test:schema3_identity_drift" ON "workflow_domain_resource_heads" ("namespace")',
    );
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

function insertPreservedForeignKeyViolation(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = OFF');
    database
      .prepare(
        `INSERT INTO workflow_registry_resource_dependencies
          (resource_id, dependency_resource_id, dependency_kind, expected_content_hash, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'missing:resource',
        'missing:dependency',
        'registry_exact',
        hash('missing:dependency'),
        1,
      );
    expect(database.pragma('foreign_key_check')).toHaveLength(2);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

function closeTracked(store: WorkflowRuntimeStore): void {
  store.close();
  const index = openStores.indexOf(store);
  if (index >= 0) openStores.splice(index, 1);
}

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  marker: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(marker)) {
        child.stdout.off('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes(marker)) {
        reject(
          new Error(
            `Child exited before ${marker}: code=${String(code)} output=${output}`,
          ),
        );
      }
    });
  });
}

async function collectChild(
  child: ChildProcessWithoutNullStreams,
  initialOutput: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    let stdout = initialOutput;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    if (store.isOpen) store.close();
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.sequential('G1.2 Workflow Runtime Store base', () => {
  it('strictly validates the closed Profile before PRAGMA interpolation', () => {
    const profile = loadFrozenWorkflowRuntimeStoreInputs().profile;
    expect(parseSQLiteExecutionProfilePayload(profile)).toEqual(profile);
    for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const candidate = structuredClone(profile) as unknown as Record<
        string,
        unknown
      >;
      candidate.busy_timeout_ms = invalid;
      expect(() => parseSQLiteExecutionProfilePayload(candidate)).toThrow(
        /finite positive safe integer|Unsupported JSON number/,
      );
    }
    for (const [field, value] of [
      ['journal_mode', 'delete'],
      ['auto_vacuum', 'full'],
      ['temp_store', 'file'],
      ['foreign_keys', false],
      ['read_only_query_only', false],
      ['mmap_size_bytes', 1],
    ] as const) {
      const candidate = structuredClone(profile) as unknown as Record<
        string,
        unknown
      >;
      candidate[field] = value;
      expect(() => parseSQLiteExecutionProfilePayload(candidate)).toThrow();
    }
    const openProfile = structuredClone(profile) as unknown as Record<
      string,
      unknown
    >;
    openProfile.unknown_pragma = 1;
    expect(() => parseSQLiteExecutionProfilePayload(openProfile)).toThrow(
      'unknown, duplicate, or missing field',
    );
  });

  it('pins G1.1/Profile identities and fails closed on frozen migration drift', () => {
    const inputs = loadFrozenWorkflowRuntimeStoreInputs();
    expect(inputs).toMatchObject({
      g1RootHash: CURRENT_G1_SCHEMA_IDENTITIES.root,
      schemaDependencyManifestArtifactHash:
        CURRENT_G1_SCHEMA_IDENTITIES.dependencyManifest,
      physicalSchemaIdentity: CURRENT_G1_SCHEMA_IDENTITIES.physicalSchema,
      schemaHash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
      migrationSha256: CURRENT_G1_SCHEMA_IDENTITIES.migration,
      deterministicDigest: CURRENT_G1_SCHEMA_IDENTITIES.deterministic,
      profileArtifactHash: CURRENT_G1_SCHEMA_IDENTITIES.profile,
    });
    const { root } = temporaryDatabase();
    const copiedSchema = path.join(root, 'schema');
    fs.cpSync(path.resolve(import.meta.dirname, '../schema'), copiedSchema, {
      recursive: true,
    });
    fs.appendFileSync(
      path.join(copiedSchema, 'migration/workflow-runtime-schema-v1.sql'),
      '\n-- drift\n',
    );
    expect(() =>
      loadFrozenWorkflowRuntimeStoreInputs({ schemaRoot: copiedSchema }),
    ).toThrow(/canonical_migration raw hash mismatch|migration drifted/);
  });

  it('fails closed on frozen Schema 3 to 4 upgrade SQL drift before opening the database', () => {
    const { root, databasePath } = temporaryDatabase();
    createSchema3Database(databasePath);
    const before = databaseGateSnapshot(databasePath);
    const copiedSchema = path.join(root, 'schema');
    fs.cpSync(path.resolve(import.meta.dirname, '../schema'), copiedSchema, {
      recursive: true,
    });
    fs.appendFileSync(
      path.join(copiedSchema, 'migration/workflow-runtime-schema-v3-to-v4.sql'),
      '\n-- drift\n',
    );

    expect(() =>
      loadFrozenWorkflowRuntimeStoreInputs({ schemaRoot: copiedSchema }),
    ).toThrow(/schema3_to_schema4_upgrade raw hash mismatch|upgrade drifted/);
    expectDatabaseGateUnchanged(databasePath, before);
  });

  it('fails closed on frozen Schema 4 to 5 upgrade SQL drift before opening the database', () => {
    const { root, databasePath } = temporaryDatabase();
    createSchema4Database(databasePath);
    const before = databaseGateSnapshot(databasePath);
    const copiedSchema = path.join(root, 'schema');
    fs.cpSync(path.resolve(import.meta.dirname, '../schema'), copiedSchema, {
      recursive: true,
    });
    fs.appendFileSync(
      path.join(copiedSchema, 'migration/workflow-runtime-schema-v4-to-v5.sql'),
      '\n-- drift\n',
    );

    expect(() =>
      loadFrozenWorkflowRuntimeStoreInputs({ schemaRoot: copiedSchema }),
    ).toThrow(/schema4_to_schema5_upgrade raw hash mismatch|upgrade drifted/);
    expectDatabaseGateUnchanged(databasePath, before);
  });

  it('loads exact Store dependencies regardless of unrelated Contract JSON', () => {
    const expected = loadFrozenWorkflowRuntimeStoreInputs();
    const { root } = temporaryDatabase();
    const copiedContracts = path.join(root, 'contracts');
    fs.cpSync(
      path.resolve(import.meta.dirname, '../../contracts'),
      copiedContracts,
      { recursive: true },
    );
    const unrelated = path.join(
      copiedContracts,
      'conformance/future-registry/unrelated-contract.json',
    );
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, '{"unrelated":true}\n');

    const observed = loadFrozenWorkflowRuntimeStoreInputs({
      contractsRoot: copiedContracts,
    });
    expect(observed).toMatchObject({
      g1RootHash: expected.g1RootHash,
      schemaDependencyManifestArtifactHash:
        expected.schemaDependencyManifestArtifactHash,
      physicalSchemaIdentity: expected.physicalSchemaIdentity,
      schemaHash: expected.schemaHash,
      migrationSha256: expected.migrationSha256,
    });
  });

  it('loads frozen schema artifacts without construction Contract sources', () => {
    const { root } = temporaryDatabase();
    const contractsRoot = path.join(root, 'contracts');
    const profileDirectory = path.join(contractsRoot, 'sqlite');
    fs.mkdirSync(profileDirectory, { recursive: true });
    fs.copyFileSync(
      path.resolve(
        import.meta.dirname,
        '../../contracts/sqlite/local_single_user_sqlite@1.json',
      ),
      path.join(profileDirectory, 'local_single_user_sqlite@1.json'),
    );
    expect(() =>
      loadFrozenWorkflowRuntimeStoreInputs({ contractsRoot }),
    ).not.toThrow();
  });

  it('bootstraps a fresh real-file database, reopens it, and reports candidate identity evidence', () => {
    const { databasePath } = temporaryDatabase();
    const store = openFresh(databasePath);
    expect(fs.statSync(databasePath).isFile()).toBe(true);
    expect(
      store.queryOne<{ page_size: number }>('PRAGMA page_size', [])?.page_size,
    ).toBe(4096);
    expect(
      store.queryOne<{ journal_mode: string }>('PRAGMA journal_mode', [])
        ?.journal_mode,
    ).toBe('wal');
    expect(
      store.queryOne<{ auto_vacuum: number }>('PRAGMA auto_vacuum', [])
        ?.auto_vacuum,
    ).toBe(2);
    expect(
      store.queryOne<{ query_only: number }>('PRAGMA query_only', [])
        ?.query_only,
    ).toBe(1);
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM sqlite_schema WHERE type = ? AND name NOT LIKE ?',
        ['table', 'sqlite_%'],
      )?.count,
    ).toBe(86);
    expect(
      store.queryOne<{ user_version: number }>('PRAGMA user_version', [])
        ?.user_version,
    ).toBe(6);
    expect(store.identityEvidence).toMatchObject({
      certification_status: 'candidate_not_certified',
      platform: 'darwin',
      arch: 'arm64',
      managed_node_version: 'v26.5.0',
      better_sqlite3_version: '12.11.1',
      sqlite_version: '3.53.2',
      runtime_launcher_profile_hash: null,
      core_binding_kind: 'development_checkout',
      release_artifact_profile_hash: null,
      release_identity_status: 'missing_until_g8',
    });
    expect(store).not.toHaveProperty('database');
    expect(store).not.toHaveProperty('prepare');
    closeTracked(store);

    const reopened = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
      identityMode: 'candidate_development',
    });
    openStores.push(reopened);
    expect(reopened.frozenInputs.schemaHash).toBe(
      CURRENT_G1_SCHEMA_IDENTITIES.schema,
    );
  });

  it('upgrades an empty frozen Schema 3 real file through historical Schema 4 and 5 to Schema 6', () => {
    const { databasePath } = temporaryDatabase();
    createSchema3Database(databasePath);
    const before = new Database(databasePath, { readonly: true });
    try {
      expect(before.pragma('user_version', { simple: true })).toBe(3);
      expect(calculateDatabaseSqliteSchemaIdentity(before)).toBe(
        FROZEN_G1_1_IDENTITIES.schema3SourceSqliteSchema,
      );
    } finally {
      before.close();
    }

    const upgraded = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
      identityMode: 'candidate_development',
    });
    openStores.push(upgraded);
    expect(
      upgraded.queryOne<{ user_version: number }>('PRAGMA user_version', [])
        ?.user_version,
    ).toBe(6);
    expect(
      upgraded.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM pragma_foreign_key_check',
        [],
      )?.count,
    ).toBe(0);
  });

  it('upgrades a nonempty frozen Schema 4 real file through Schema 5 to Schema 6 and preserves rows', () => {
    const { databasePath } = temporaryDatabase();
    createSchema4Database(databasePath);
    const seed = new Database(databasePath);
    try {
      seed
        .prepare(
          'INSERT INTO workflow_domain_resource_heads (namespace, key_hash, current_fencing_token, row_version) VALUES (?, ?, ?, ?)',
        )
        .run(
          'capacity-upgrade-preserved',
          hash('capacity-upgrade-preserved'),
          7,
          3,
        );
    } finally {
      seed.close();
    }
    const before = databaseGateSnapshot(databasePath);
    expect(before.userVersion).toBe(4);
    expect(before.sqliteSchemaIdentity).toBe(
      FROZEN_G1_1_IDENTITIES.schema4SourceSqliteSchema,
    );

    const upgraded = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
      identityMode: 'candidate_development',
    });
    openStores.push(upgraded);
    expect(
      upgraded.queryOne<{ user_version: number }>('PRAGMA user_version', [])
        ?.user_version,
    ).toBe(6);
    expect(
      upgraded.queryOne<{ current_fencing_token: number; row_version: number }>(
        'SELECT current_fencing_token, row_version FROM workflow_domain_resource_heads WHERE namespace = ?',
        ['capacity-upgrade-preserved'],
      ),
    ).toEqual({ current_fencing_token: 7, row_version: 3 });
  });

  it('rejects Schema 4 sqlite_schema identity drift before the first upgrade DDL', () => {
    const { databasePath } = temporaryDatabase();
    createSchema4Database(databasePath);
    const database = new Database(databasePath);
    try {
      database.exec(
        'CREATE INDEX "idx:test:schema4_identity_drift" ON "workflow_domain_resource_heads" ("namespace")',
      );
    } finally {
      database.close();
    }
    const before = databaseGateSnapshot(databasePath);
    expect(before.userVersion).toBe(4);
    expect(before.sqliteSchemaIdentity).not.toBe(
      FROZEN_G1_1_IDENTITIES.schema4SourceSqliteSchema,
    );

    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
        identityMode: 'candidate_development',
      }),
    ).toThrow('Schema 4 sqlite_schema identity mismatch');
    expectDatabaseGateUnchanged(databasePath, before);
  });

  it('rejects Schema 3 sqlite_schema identity drift before the first upgrade DDL', () => {
    const { databasePath } = temporaryDatabase();
    createSchema3Database(databasePath);
    driftSchema3SqliteIdentity(databasePath);
    const before = databaseGateSnapshot(databasePath);
    expect(before.userVersion).toBe(3);
    expect(before.sqliteSchemaIdentity).not.toBe(
      FROZEN_G1_1_IDENTITIES.schema3SourceSqliteSchema,
    );

    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
        identityMode: 'candidate_development',
      }),
    ).toThrow('Schema 3 sqlite_schema identity mismatch');
    expectDatabaseGateUnchanged(databasePath, before);
  });

  it('rolls back the complete Schema 3 to 6 DDL when target verification fails', () => {
    const { databasePath } = temporaryDatabase();
    createSchema3Database(databasePath);
    insertPreservedForeignKeyViolation(databasePath);
    const before = databaseGateSnapshot(databasePath);
    expect(before.userVersion).toBe(3);
    expect(before.sqliteSchemaIdentity).toBe(
      FROZEN_G1_1_IDENTITIES.schema3SourceSqliteSchema,
    );
    expect(before.rowCounts.workflow_registry_resource_dependencies).toBe(1);

    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
        identityMode: 'candidate_development',
      }),
    ).toThrow('foreign_key_check returned violations');
    expectDatabaseGateUnchanged(databasePath, before);
  });

  it.each([
    'workflow_feature_release_activation_commands',
    'workflow_feature_release_activation_invocations',
    'workflow_feature_release_activation_events',
    'workflow_feature_active_releases',
  ])(
    'fails closed before DDL when Schema 3 relation %s is non-empty',
    (relation) => {
      const { databasePath } = temporaryDatabase();
      createSchema3Database(databasePath);
      insertConstructionOnlyRow(databasePath, relation);
      const before = databaseGateSnapshot(databasePath);
      expect(before.userVersion).toBe(3);
      expect(before.sqliteSchemaIdentity).toBe(
        FROZEN_G1_1_IDENTITIES.schema3SourceSqliteSchema,
      );
      expect(before.rowCounts[relation]).toBe(1);
      expect(() =>
        WorkflowRuntimeConnectionFactory.openStore({
          databasePath,
          databaseMode: 'open_existing',
          identityMode: 'candidate_development',
        }),
      ).toThrow(`Schema 3 upgrade requires empty relation ${relation}`);
      expectDatabaseGateUnchanged(databasePath, before);
    },
  );

  it('enforces one in-process writer owner and releases ownership on close', () => {
    const { databasePath } = temporaryDatabase();
    const first = openFresh(databasePath);
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
        identityMode: 'candidate_development',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkflowRuntimeStoreError>>({
        code: 'writer_already_owned',
      }),
    );
    closeTracked(first);
    const second = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
      identityMode: 'candidate_development',
    });
    openStores.push(second);
    expect(second.isOpen).toBe(true);
  });

  it('rejects an existing schema mismatch', () => {
    const { databasePath } = temporaryDatabase();
    const store = openFresh(databasePath);
    closeTracked(store);
    const bytes = fs.readFileSync(databasePath);
    const expected = Buffer.from('workflow_graph_resource_accounts');
    let offset = bytes.indexOf(expected);
    let replacementCount = 0;
    while (offset >= 0) {
      Buffer.from('xorkflow_graph_resource_accounts').copy(bytes, offset);
      replacementCount += 1;
      offset = bytes.indexOf(expected, offset + expected.length);
    }
    expect(replacementCount).toBeGreaterThan(0);
    fs.writeFileSync(databasePath, bytes);
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
        identityMode: 'candidate_development',
      }),
    ).toThrow();
  });

  it('rejects an existing profile mismatch without modifying it to match WAL', () => {
    const { databasePath } = temporaryDatabase();
    const store = openFresh(databasePath);
    closeTracked(store);
    const bytes = fs.readFileSync(databasePath);
    expect(bytes[18]).toBe(2);
    expect(bytes[19]).toBe(2);
    bytes[18] = 1;
    bytes[19] = 1;
    fs.writeFileSync(databasePath, bytes);
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
        identityMode: 'candidate_development',
      }),
    ).toThrow('journal_mode: expected wal, received delete');
    const after = fs.readFileSync(databasePath);
    expect(after[18]).toBe(1);
    expect(after[19]).toBe(1);
  });

  it('forces read-only query_only, rejects writes, and closes explicitly', () => {
    const { databasePath } = temporaryDatabase();
    const store = openFresh(databasePath);
    const readOnly = WorkflowRuntimeConnectionFactory.openReadOnly({
      databasePath,
      identityMode: 'candidate_development',
    });
    expect(
      readOnly.queryOne<{ query_only: number }>('PRAGMA query_only', [])
        ?.query_only,
    ).toBe(1);
    expect(() =>
      readOnly.queryAll<{ namespace: string }>(
        'DELETE FROM workflow_domain_resource_heads WHERE namespace = ? RETURNING namespace',
        ['missing'],
      ),
    ).toThrow(/readonly|read-only/i);
    readOnly.close();
    expect(readOnly.isOpen).toBe(false);
    expect(() => readOnly.queryAll('SELECT 1 AS value', [])).toThrowError(
      expect.objectContaining<Partial<WorkflowRuntimeStoreError>>({
        code: 'connection_closed',
      }),
    );
    closeTracked(store);
    expect(store.isOpen).toBe(false);
    expect(() => store.queryAll('SELECT 1 AS value', [])).toThrowError(
      expect.objectContaining<Partial<WorkflowRuntimeStoreError>>({
        code: 'connection_closed',
      }),
    );
  });

  it('hosts synchronous BEGIN IMMEDIATE commit/rollback and rejects async or DDL callbacks', () => {
    const { databasePath } = temporaryDatabase();
    const store = openFresh(databasePath);
    const insert = (
      transaction: WorkflowRuntimeWriteTransaction,
      namespace: string,
    ) =>
      transaction.execute(
        'INSERT INTO workflow_domain_resource_heads (namespace, key_hash, current_fencing_token, row_version) VALUES (?, ?, ?, ?)',
        [namespace, hash(namespace), 0, 0],
      );

    const committed = store.withImmediateTransaction((transaction) => {
      expect(transaction.transactionKind).toBe('immediate');
      expect(transaction).not.toHaveProperty('database');
      insert(transaction, 'committed');
      return transaction.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_domain_resource_heads',
        [],
      )?.count;
    });
    expect(committed).toBe(1);

    expect(() =>
      store.withImmediateTransaction((transaction) => {
        insert(transaction, 'rolled-back');
        throw new Error('callback failure');
      }),
    ).toThrow('callback failure');

    const asyncCallback = (transaction: WorkflowRuntimeWriteTransaction) => {
      insert(transaction, 'async-rolled-back');
      return Promise.resolve('not allowed');
    };
    expect(() => store.withImmediateTransaction(asyncCallback)).toThrowError(
      expect.objectContaining<Partial<WorkflowRuntimeStoreError>>({
        code: 'transaction_callback_async',
      }),
    );
    expect(() =>
      store.withImmediateTransaction(async (transaction) => {
        insert(transaction, 'async-function-never-started');
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkflowRuntimeStoreError>>({
        code: 'transaction_callback_async',
      }),
    );
    expect(() =>
      store.withImmediateTransaction((transaction) =>
        transaction.execute('CREATE TABLE forbidden (id TEXT)', []),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<WorkflowRuntimeStoreError>>({
        code: 'write_statement_forbidden',
      }),
    );
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_domain_resource_heads',
        [],
      )?.count,
    ).toBe(1);
  });

  it('serializes a competing process behind a real BEGIN IMMEDIATE writer lock', async () => {
    const { databasePath } = temporaryDatabase();
    const store = openFresh(databasePath);
    const moduleUrl = pathToFileURL(
      path.join(import.meta.dirname, 'index.ts'),
    ).href;
    const childSource = `
      import { setTimeout as delay } from 'node:timers/promises';
      const [moduleUrl, databasePath] = process.argv.slice(-2);
      const { WorkflowRuntimeConnectionFactory } = await import(moduleUrl);
      const store = WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
        identityMode: 'candidate_development',
      });
      console.log('ready');
      await delay(100);
      const startedAt = Date.now();
      store.withImmediateTransaction((transaction) => {
        transaction.execute(
          'INSERT INTO workflow_domain_resource_heads (namespace, key_hash, current_fencing_token, row_version) VALUES (?, ?, ?, ?)',
          ['child', '${hash('child')}', 0, 0],
        );
      });
      console.log('elapsed:' + (Date.now() - startedAt));
      store.close();
    `;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        childSource,
        moduleUrl,
        databasePath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const initialOutput = await waitForOutput(child, 'ready\n');
    store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'INSERT INTO workflow_domain_resource_heads (namespace, key_hash, current_fencing_token, row_version) VALUES (?, ?, ?, ?)',
        ['parent', hash('parent'), 0, 0],
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    });
    const result = await collectChild(child, initialOutput);
    expect(result.code, result.stderr).toBe(0);
    const elapsed = Number(result.stdout.match(/elapsed:(\d+)/)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_domain_resource_heads',
        [],
      )?.count,
    ).toBe(2);
  }, 15_000);

  it('fails closed on host/certification identity mismatches before creating a database', () => {
    const profile = loadFrozenWorkflowRuntimeStoreInputs().profile;
    expect(() => assertRuntimeHostIdentity(profile, 'production')).toThrow(
      'candidate/not-certified',
    );
    const host = currentRuntimeHostObservation();
    expect(() =>
      assertRuntimeHostIdentity(profile, 'candidate_development', {
        ...host,
        platform: 'linux',
      }),
    ).toThrow('Runtime platform identity mismatch');

    const { databasePath } = temporaryDatabase();
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath: ':memory:',
        databaseMode: 'create',
        identityMode: 'candidate_development',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkflowRuntimeStoreError>>({
        code: 'database_path_invalid',
      }),
    );
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'create',
        identityMode: 'production',
      }),
    ).toThrow('release/launcher certification fields are null until G8');
    expect(fs.existsSync(databasePath)).toBe(false);
  });
});
