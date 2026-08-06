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
  const runOnceService: RunOnceService = {
    preflightWorkspace: vi.fn(),
    runOnce: vi.fn(),
  };
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
  it('starts an isolated collaboration.db and stops cleanly', async () => {
    const storeDir = root();
    const selected = runtime(storeDir);
    expect(selected.start()).toBe(true);
    expect(selected.status()).toMatchObject({
      available: true,
      databasePath: path.join(storeDir, 'collaboration.db'),
      error: null,
      scheduler: { running: true },
    });
    await selected.stop();
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
    await selected.stop();
  });

  it('drains an in-flight scheduler sync and releases its lock before closing the store', async () => {
    const storeDir = root();
    const selected = runtime(storeDir);
    expect(selected.start()).toBe(true);
    selected.scheduler.stop();
    selected.store.registerGroup({
      groupId: 'ag_slow_shutdown',
      name: 'Slow shutdown',
      creatorPrincipalId: 'alice',
      localPrincipalId: 'alice',
      localAgentId: 'agent_alice',
      remoteUrl: '/tmp/slow-remote.git',
      repositoryPath: '/tmp/slow-repository.git',
      signingKeyPath: '/tmp/slow-signing-key',
      signingPublicKey: 'ssh-ed25519 test',
      signingKeyRef: 'ssh-ed25519:SHA256:test',
      pollIntervalMs: 15_000,
    });
    let enterSync!: () => void;
    const syncEntered = new Promise<void>((resolve) => {
      enterSync = resolve;
    });
    let releaseSync!: () => void;
    const syncReleased = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    vi.spyOn(selected.groups, 'syncHistory').mockImplementation(async () => {
      enterSync();
      await syncReleased;
      throw new Error('slow sync released');
    });
    const releaseLock = vi.spyOn(selected.store, 'releaseGroupLock');
    const closeStore = vi.spyOn(selected.store, 'close');

    const syncing = selected.scheduler.syncNow('ag_slow_shutdown');
    await syncEntered;
    expect(
      selected.store
        .rawDatabaseForTests()
        .prepare(
          'SELECT COUNT(*) AS count FROM collaboration_process_locks WHERE group_id = ?',
        )
        .get('ag_slow_shutdown'),
    ).toEqual({ count: 1 });

    const stopping = selected.stop();
    await Promise.resolve();
    expect(closeStore).not.toHaveBeenCalled();
    await expect(
      selected.scheduler.syncNow('ag_slow_shutdown'),
    ).rejects.toThrow(/quiescing/);

    releaseSync();
    await expect(syncing).rejects.toThrow('slow sync released');
    await stopping;

    expect(releaseLock).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(releaseLock.mock.invocationCallOrder[0]).toBeLessThan(
      closeStore.mock.invocationCallOrder[0]!,
    );
    expect(selected.status().available).toBe(false);
    await selected.stop();
    expect(closeStore).toHaveBeenCalledOnce();
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
