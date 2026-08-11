import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunOnceService } from './executors/run-once.js';
import { CollaborationProjectSpaceService } from './project-space-service.js';
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
  vi.restoreAllMocks();
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
      protocolVersion: 3,
      error: null,
      scheduler: { running: true },
    });
    await selected.stop();
    expect(selected.status().available).toBe(false);
  });

  it('runs initialization recovery on startup and waits for it before closing', async () => {
    const storeDir = root();
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const recoveryReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recover = vi
      .spyOn(
        CollaborationProjectSpaceService.prototype,
        'recoverInterruptedInitializations',
      )
      .mockImplementation(async () => {
        entered();
        await recoveryReleased;
        return [];
      });
    const selected = runtime(storeDir);

    expect(selected.start()).toBe(true);
    await recoveryEntered;
    expect(recover).toHaveBeenCalledOnce();
    const closeStore = vi.spyOn(selected.store, 'close');
    const stopping = selected.stop();
    await Promise.resolve();
    expect(closeStore).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('quiesces and restarts around a consistent local backup', async () => {
    const storeDir = root();
    const selected = runtime(storeDir);
    expect(selected.start()).toBe(true);
    const backupDirectory = path.join(storeDir, 'backup');
    const manifest = await selected.createBackup(backupDirectory);
    expect(manifest).toMatchObject({
      format: 'icarus.collaboration-backup/3',
      database_basename: 'collaboration.db',
      file: { size: expect.any(Number), sha256: expect.any(String) },
      staged_artifacts: {
        directory_basename: 'collaboration-staged-artifacts',
        files: [],
      },
    });
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
    selected.store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_slow_shutdown',
        remote_url: '/tmp/slow-remote.git',
        subscription_mode: 'observer',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: '2026-08-06T12:00:00.000Z',
      },
      name: 'Slow shutdown',
      lifecycle: 'active',
      ownerPrincipalId: 'principal_alice',
      repositoryPath: '/tmp/slow-repository.git',
    });
    let enterSync!: () => void;
    const syncEntered = new Promise<void>((resolve) => {
      enterSync = resolve;
    });
    let releaseSync!: () => void;
    const syncReleased = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    vi.spyOn(selected.groups, 'sync').mockImplementation(async () => {
      enterSync();
      await syncReleased;
      throw new Error('slow sync released');
    });
    const releaseLock = vi.spyOn(selected.store, 'releaseProcessLock');
    const closeStore = vi.spyOn(selected.store, 'close');

    const syncing = selected.scheduler.syncNow('group_slow_shutdown');
    await syncEntered;
    expect(
      selected.store
        .rawDatabaseForTests()
        .prepare(
          'SELECT COUNT(*) AS count FROM collaboration_process_locks WHERE group_id = ?',
        )
        .get('group_slow_shutdown'),
    ).toEqual({ count: 1 });

    const stopping = selected.stop();
    await Promise.resolve();
    expect(closeStore).not.toHaveBeenCalled();
    await expect(
      selected.scheduler.syncNow('group_slow_shutdown'),
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
      error: expect.stringMatching(/stale|reinitialize/i),
      scheduler: null,
    });
  });
});
