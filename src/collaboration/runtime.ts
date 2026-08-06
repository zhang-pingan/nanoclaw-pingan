import path from 'node:path';

import type { Logger } from 'pino';

import type { RunOnceService } from './executors/run-once.js';
import type { CollaborationWorkflowHostService } from './executors/workflow.js';
import {
  ActionExecutorRegistry,
  CodexTaskActionExecutor,
  RunOnceActionExecutor,
  WorkflowActionExecutor,
} from './executors/index.js';
import { CollaborationGitTransport } from './git-transport.js';
import { CollaborationIdentityService } from './identity.js';
import { CollaborationScheduler } from './scheduler.js';
import { CollaborationGroupService } from './service.js';
import {
  CollaborationStore,
  createCollaborationBackup,
  rollbackCollaborationRestore,
  restoreCollaborationBackup,
  type CollaborationBackupManifest,
} from './store.js';

export interface CollaborationRuntimeOptions {
  readonly storeDir: string;
  readonly runOnceService: RunOnceService;
  readonly workflowHost?: CollaborationWorkflowHostService | null;
  readonly codex: {
    readonly binary: string;
    readonly cwd: string;
    readonly model?: string;
    readonly desktopVisibilityConfirmed: boolean;
    readonly requestTimeoutMs?: number;
  };
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly now?: () => number;
}

export interface CollaborationRuntimeStatus {
  readonly available: boolean;
  readonly databasePath: string;
  readonly repositoryRoot: string;
  readonly error: string | null;
  readonly scheduler: ReturnType<CollaborationScheduler['diagnostics']> | null;
}

export class CollaborationRuntime {
  readonly databasePath: string;
  readonly repositoryRoot: string;
  private storeValue: CollaborationStore | null = null;
  private groupsValue: CollaborationGroupService | null = null;
  private schedulerValue: CollaborationScheduler | null = null;
  private registryValue: ActionExecutorRegistry | null = null;
  private errorValue: string | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: CollaborationRuntimeOptions) {
    this.databasePath = path.join(options.storeDir, 'collaboration.db');
    this.repositoryRoot = path.join(
      options.storeDir,
      'collaboration-repositories',
    );
  }

  start(): boolean {
    if (this.storeValue) return true;
    try {
      const store = new CollaborationStore(this.databasePath);
      const groups = new CollaborationGroupService(
        store,
        new CollaborationGitTransport(),
        this.repositoryRoot,
        new CollaborationIdentityService(this.options.storeDir),
        this.options.now,
      );
      const registry = new ActionExecutorRegistry();
      registry.register(new RunOnceActionExecutor(this.options.runOnceService));
      if (this.options.workflowHost)
        registry.register(
          new WorkflowActionExecutor(this.options.workflowHost),
        );
      registry.register(
        new CodexTaskActionExecutor({
          binary: this.options.codex.binary,
          defaultCwd: this.options.codex.cwd,
          model: this.options.codex.model,
          desktopVisibilityConfirmed:
            this.options.codex.desktopVisibilityConfirmed,
          requestTimeoutMs: this.options.codex.requestTimeoutMs,
        }),
      );
      const scheduler = new CollaborationScheduler(store, groups, registry, {
        now: this.options.now,
      });
      this.storeValue = store;
      this.groupsValue = groups;
      this.registryValue = registry;
      this.schedulerValue = scheduler;
      this.errorValue = null;
      scheduler.start();
      this.options.logger.info(
        {
          databasePath: this.databasePath,
          repositoryRoot: this.repositoryRoot,
          workflowExecutor: Boolean(this.options.workflowHost),
          codexDesktopVisibilityConfirmed:
            this.options.codex.desktopVisibilityConfirmed,
        },
        'Collaboration Runtime started',
      );
      return true;
    } catch (error) {
      this.errorValue = error instanceof Error ? error.message : String(error);
      this.schedulerValue?.stop();
      this.storeValue?.close();
      this.storeValue = null;
      this.groupsValue = null;
      this.schedulerValue = null;
      this.registryValue = null;
      this.options.logger.error(
        { error: this.errorValue, databasePath: this.databasePath },
        'Collaboration Runtime is unavailable; other Host services remain active',
      );
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const store = this.storeValue;
    if (!store) return;
    const scheduler = this.schedulerValue;
    const stopping = (async () => {
      await scheduler?.stopAndDrain();
      store.close();
      if (this.storeValue !== store) return;
      this.storeValue = null;
      this.groupsValue = null;
      this.schedulerValue = null;
      this.registryValue = null;
    })();
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = null;
    }
  }

  status(): CollaborationRuntimeStatus {
    return {
      available: Boolean(this.storeValue),
      databasePath: this.databasePath,
      repositoryRoot: this.repositoryRoot,
      error: this.errorValue,
      scheduler: this.schedulerValue?.diagnostics() ?? null,
    };
  }

  get store(): CollaborationStore {
    if (!this.storeValue)
      throw new Error(
        this.errorValue
          ? `Collaboration Runtime is unavailable: ${this.errorValue}`
          : 'Collaboration Runtime is not started',
      );
    return this.storeValue;
  }

  get groups(): CollaborationGroupService {
    if (!this.groupsValue) {
      void this.store;
      throw new Error('Collaboration Group Service is unavailable');
    }
    return this.groupsValue;
  }

  get scheduler(): CollaborationScheduler {
    if (!this.schedulerValue) {
      void this.store;
      throw new Error('Collaboration Scheduler is unavailable');
    }
    return this.schedulerValue;
  }

  async createBackup(
    backupDirectory: string,
  ): Promise<CollaborationBackupManifest> {
    void this.store;
    await this.stop();
    try {
      return createCollaborationBackup({
        databasePath: this.databasePath,
        backupDirectory,
      });
    } finally {
      if (!this.start())
        throw new Error(
          this.errorValue ||
            'Collaboration Runtime could not restart after backup',
        );
    }
  }

  async restoreBackup(backupDirectory: string): Promise<{
    readonly rollbackDirectory: string | null;
  }> {
    void this.store;
    await this.stop();
    let rollbackDirectory: string | null = null;
    try {
      const result = restoreCollaborationBackup({
        databasePath: this.databasePath,
        backupDirectory,
      });
      rollbackDirectory = result.rollbackDirectory;
      if (!this.start()) {
        const restoredError =
          this.errorValue || 'Restored Collaboration Runtime could not start';
        if (!rollbackDirectory) throw new Error(restoredError);
        rollbackCollaborationRestore({
          databasePath: this.databasePath,
          rollbackDirectory,
        });
        rollbackDirectory = null;
        if (!this.start())
          throw new Error(
            `${restoredError}; the previous Collaboration Runtime also could not restart: ${this.errorValue ?? 'unknown error'}`,
          );
        throw new Error(
          `${restoredError}; the previous Collaboration database was restored`,
        );
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.storeValue) this.errorValue = message;
      this.options.logger.error(
        { error: message, backupDirectory },
        'Collaboration backup restore failed',
      );
      if (!this.storeValue) this.start();
      throw error;
    }
  }
}
