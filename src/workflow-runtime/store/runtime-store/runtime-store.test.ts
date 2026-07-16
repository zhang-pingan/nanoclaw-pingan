import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { pathToFileURL } from 'url';

import { afterEach, describe, expect, it } from 'vitest';

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
      g1RootHash: FROZEN_G1_1_IDENTITIES.root,
      schemaHash: FROZEN_G1_1_IDENTITIES.schema,
      migrationSha256: FROZEN_G1_1_IDENTITIES.migration,
      deterministicDigest: FROZEN_G1_1_IDENTITIES.deterministic,
      profileArtifactHash: FROZEN_G1_1_IDENTITIES.profile,
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
    ).toThrow('migration drifted');
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
    ).toBe(78);
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
      FROZEN_G1_1_IDENTITIES.schema,
    );
  });

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
