import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
  CollaborationProjectSpaceStore,
} from './project-space-store.js';
import {
  CollaborationStorePreflightError,
  preflightCollaborationStore,
} from './store-preflight.js';
import {
  parseCollaborationStorePreflightArguments,
  runCollaborationStorePreflightCli,
} from './store-preflight-cli.js';

const roots: string[] = [];

function temporaryStore(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-collaboration-preflight-'),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Collaboration store preflight', () => {
  it('leaves an absent database for the Host to initialize', () => {
    const storeDir = temporaryStore();

    expect(preflightCollaborationStore({ storeDir })).toMatchObject({
      decision: 'absent',
      observedSchemaVersion: null,
      targetSchemaVersion: CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
      archiveDirectory: null,
    });
    expect(fs.existsSync(path.join(storeDir, 'collaboration.db'))).toBe(false);
  });

  it('validates and preserves a current database', () => {
    const storeDir = temporaryStore();
    const databasePath = path.join(storeDir, 'collaboration.db');
    new CollaborationProjectSpaceStore(databasePath).close();

    expect(preflightCollaborationStore({ storeDir })).toMatchObject({
      decision: 'compatible',
      observedSchemaVersion: CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
      archiveDirectory: null,
    });
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it('archives an incompatible database before allowing fresh initialization', () => {
    const storeDir = temporaryStore();
    const databasePath = path.join(storeDir, 'collaboration.db');
    const stale = new Database(databasePath);
    stale.exec('CREATE TABLE legacy_group (id TEXT PRIMARY KEY);');
    stale.pragma('user_version = 6');
    stale.close();
    fs.writeFileSync(`${databasePath}-wal`, '');
    fs.writeFileSync(`${databasePath}-shm`, '');

    const result = preflightCollaborationStore({
      storeDir,
      now: () => new Date('2026-08-09T12:34:56.789Z'),
    });

    expect(result).toMatchObject({
      decision: 'archived',
      observedSchemaVersion: 6,
      targetSchemaVersion: CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
    });
    expect(result.archiveDirectory).toContain(
      `collaboration-schema-20260809T123456789Z-v6-to-v${String(
        CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
      )}`,
    );
    expect(fs.existsSync(databasePath)).toBe(false);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(result.archiveDirectory!, 'manifest.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      format: 'icarus.collaboration-schema-archive/1',
      reason: 'schema_incompatible',
      observed_schema_version: 6,
      target_schema_version: CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
      members: [
        {
          name: 'collaboration.db',
          size: expect.any(Number),
          sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        {
          name: 'collaboration.db-wal',
          size: 0,
          sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        {
          name: 'collaboration.db-shm',
          size: 0,
          sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      ],
    });

    const current = new CollaborationProjectSpaceStore(databasePath);
    expect(
      current.rawDatabaseForTests().pragma('user_version', { simple: true }),
    ).toBe(CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION);
    current.close();
  });

  it('archives and rebuilds the lifecycle-only main v11 store as v12', () => {
    const storeDir = temporaryStore();
    const databasePath = path.join(storeDir, 'collaboration.db');
    new CollaborationProjectSpaceStore(databasePath).close();

    const lifecycleV11 = new Database(databasePath);
    lifecycleV11.exec(`
      DROP TABLE collaboration_link_index;
      UPDATE collaboration_meta
         SET value = 'icarus.collaboration-local-store/11'
       WHERE key = 'format';
      INSERT INTO collaboration_local_group_bindings (
        group_id, remote_url, principal_id, credential_id,
        recovery_credential_id, binding_state, detach_reason,
        terminal_head, cleanup_paths_json, cleanup_error, updated_at_ms
      ) VALUES (
        'group_main_v11', '/tmp/main-v11.git',
        'principal_main_v11', 'credential_main_v11',
        'credential_main_v11_recovery', 'retained', 'local_remove',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL, 1
      );
    `);
    lifecycleV11.pragma('user_version = 11');
    lifecycleV11.close();

    const result = preflightCollaborationStore({
      storeDir,
      now: () => new Date('2026-08-10T12:34:56.789Z'),
    });
    expect(result).toMatchObject({
      decision: 'archived',
      observedSchemaVersion: 11,
      targetSchemaVersion: 12,
    });
    expect(fs.existsSync(databasePath)).toBe(false);

    const archived = new Database(
      path.join(result.archiveDirectory!, 'collaboration.db'),
      { readonly: true },
    );
    expect(archived.pragma('user_version', { simple: true })).toBe(11);
    expect(
      archived
        .prepare(
          `SELECT binding_state FROM collaboration_local_group_bindings
            WHERE group_id = 'group_main_v11'`,
        )
        .get(),
    ).toEqual({ binding_state: 'retained' });
    expect(
      archived
        .prepare(
          `SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'collaboration_link_index'`,
        )
        .get(),
    ).toBeUndefined();
    archived.close();

    const rebuilt = new CollaborationProjectSpaceStore(databasePath);
    expect(
      rebuilt.rawDatabaseForTests().pragma('user_version', { simple: true }),
    ).toBe(12);
    expect(rebuilt.getLocalGroupBinding('group_main_v11')).toBeNull();
    expect(rebuilt.listGroupInitializations()).toEqual([]);
    rebuilt.close();
  });

  it('rejects a corrupt database without replacing it', () => {
    const storeDir = temporaryStore();
    const databasePath = path.join(storeDir, 'collaboration.db');
    fs.writeFileSync(databasePath, 'not a sqlite database');

    expect(() => preflightCollaborationStore({ storeDir })).toThrowError(
      expect.objectContaining<Partial<CollaborationStorePreflightError>>({
        code: 'DATABASE_INVALID',
      }),
    );
    expect(fs.readFileSync(databasePath, 'utf8')).toBe('not a sqlite database');
  });

  it('rejects a malformed current schema without archiving it', () => {
    const storeDir = temporaryStore();
    const databasePath = path.join(storeDir, 'collaboration.db');
    const database = new Database(databasePath);
    database.exec('CREATE TABLE incomplete_current (id TEXT PRIMARY KEY);');
    database.pragma(
      `user_version = ${String(CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION)}`,
    );
    database.close();

    expect(() => preflightCollaborationStore({ storeDir })).toThrowError(
      expect.objectContaining<Partial<CollaborationStorePreflightError>>({
        code: 'DATABASE_INVALID',
      }),
    );
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(fs.existsSync(path.join(storeDir, 'backups'))).toBe(false);
  });

  it('rejects an unversioned database with user tables', () => {
    const storeDir = temporaryStore();
    const databasePath = path.join(storeDir, 'collaboration.db');
    const database = new Database(databasePath);
    database.exec('CREATE TABLE unknown_data (id TEXT PRIMARY KEY);');
    database.close();

    expect(() => preflightCollaborationStore({ storeDir })).toThrowError(
      expect.objectContaining<Partial<CollaborationStorePreflightError>>({
        code: 'DATABASE_UNVERSIONED',
      }),
    );
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it('reports CLI failures without throwing an unhandled stack', () => {
    expect(
      parseCollaborationStorePreflightArguments([
        '--store-dir',
        '/tmp/icarus-store',
      ]),
    ).toEqual({ storeDir: '/tmp/icarus-store' });
    const errors: string[] = [];
    expect(
      runCollaborationStorePreflightCli([], {
        errorOutput: (line) => errors.push(line),
      }),
    ).toBe(1);
    expect(errors).toEqual([
      expect.stringMatching(/^Collaboration store preflight failed: Usage:/u),
    ]);
  });
});
