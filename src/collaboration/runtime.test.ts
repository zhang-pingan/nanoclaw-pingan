import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunOnceService } from './executors/run-once.js';
import { CollaborationRuntime } from './runtime.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(
    path.join(os.tmpdir(), 'icarus-collaboration-runtime-'),
  );
  roots.push(value);
  return value;
}

function runtime(storeDir: string): CollaborationRuntime {
  const runOnceService: RunOnceService = { runOnce: vi.fn() };
  return new CollaborationRuntime({
    storeDir,
    runOnceService,
    workflowHost: null,
    codex: {
      binary: 'codex',
      cwd: storeDir,
      desktopVisibilityConfirmed: false,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('CollaborationRuntime', () => {
  it('starts an isolated collaboration.db and stops cleanly', () => {
    const storeDir = root();
    const selected = runtime(storeDir);
    expect(selected.start()).toBe(true);
    expect(selected.status()).toMatchObject({
      available: true,
      databasePath: path.join(storeDir, 'collaboration.db'),
      error: null,
      scheduler: { running: true },
    });
    selected.stop();
    expect(selected.status().available).toBe(false);
  });

  it('quiesces and restarts around a consistent local backup', async () => {
    const storeDir = root();
    const selected = runtime(storeDir);
    expect(selected.start()).toBe(true);
    const backupDirectory = path.join(storeDir, 'backup');
    const manifest = await selected.createBackup(backupDirectory);
    expect(manifest.files.map((file) => file.name)).toContain(
      'collaboration.db',
    );
    expect(selected.status()).toMatchObject({
      available: true,
      scheduler: { running: true },
    });
    selected.stop();
  });

  it('contains an incompatible local schema without blocking the Host', () => {
    const storeDir = root();
    const database = new Database(path.join(storeDir, 'collaboration.db'));
    database.pragma('user_version = 999');
    database.close();
    const selected = runtime(storeDir);

    expect(selected.start()).toBe(false);
    expect(selected.status()).toMatchObject({
      available: false,
      error: expect.stringMatching(/newer than supported|unsupported/i),
      scheduler: null,
    });
  });
});
