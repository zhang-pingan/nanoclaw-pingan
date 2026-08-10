import path from 'node:path';

import type { Logger } from 'pino';

import type { RunOnceService } from './executors/run-once.js';
import type { CollaborationWorkflowHostService } from './executors/workflow.js';
import {
  ManagedAnalysisExecutorRegistry,
  RunOnceManagedAnalysisExecutor,
} from './analysis-executor.js';
import { CollaborationAnalysisService } from './analysis-service.js';
import {
  ActionExecutorRegistry,
  CodexTaskActionExecutor,
  RunOnceActionExecutor,
  WorkflowActionExecutor,
} from './executors/index.js';
import { CollaborationProjectSpaceGitTransport } from './project-space-git.js';
import { CollaborationProjectSpaceIdentityService } from './project-space-identity.js';
import { CollaborationProjectSpaceService } from './project-space-service.js';
import {
  CollaborationProjectSpaceStore,
  createCollaborationProjectSpaceBackup,
  restoreCollaborationProjectSpaceBackup,
  rollbackCollaborationProjectSpaceRestore,
  type CollaborationProjectSpaceBackupManifest,
} from './project-space-store.js';
import { CollaborationScheduler } from './scheduler.js';

export interface CollaborationRuntimeOptions {
  readonly storeDir: string;
  readonly defaultGitSshKeyPath?: string;
  readonly runOnceService: RunOnceService;
  readonly analysisAgentJid?: string | null;
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
  readonly protocolVersion: 3;
  readonly error: string | null;
  readonly scheduler: ReturnType<CollaborationScheduler['diagnostics']> | null;
}

export class CollaborationRuntime {
  readonly databasePath: string;
  readonly repositoryRoot: string;
  private storeValue: CollaborationProjectSpaceStore | null = null;
  private groupsValue: CollaborationProjectSpaceService | null = null;
  private schedulerValue: CollaborationScheduler | null = null;
  private registryValue: ActionExecutorRegistry | null = null;
  private analysisValue: CollaborationAnalysisService | null = null;
  private analysisExecutorsValue: ManagedAnalysisExecutorRegistry | null = null;
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
      const store = new CollaborationProjectSpaceStore(this.databasePath);
      const groups = new CollaborationProjectSpaceService(
        store,
        new CollaborationProjectSpaceGitTransport(),
        this.repositoryRoot,
        new CollaborationProjectSpaceIdentityService(
          this.options.storeDir,
          this.options.defaultGitSshKeyPath,
        ),
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
      const analysisExecutors = new ManagedAnalysisExecutorRegistry();
      if (this.options.analysisAgentJid)
        analysisExecutors.register(
          new RunOnceManagedAnalysisExecutor(this.options.runOnceService, {
            executorId: 'analysis_run_once',
            displayName: 'Icarus Managed Agent',
            agentJid: this.options.analysisAgentJid,
            temporaryRoot: path.join(
              this.options.storeDir,
              'collaboration-analysis-workspaces',
            ),
          }),
        );
      const analysis = new CollaborationAnalysisService(
        store,
        groups,
        analysisExecutors,
        { now: this.options.now },
      );
      const scheduler = new CollaborationScheduler(store, groups, registry, {
        now: this.options.now,
      });
      this.storeValue = store;
      this.groupsValue = groups;
      this.registryValue = registry;
      this.analysisValue = analysis;
      this.analysisExecutorsValue = analysisExecutors;
      this.schedulerValue = scheduler;
      this.errorValue = null;
      void groups
        .retryPendingLocalCleanups()
        .then((results) => {
          for (const result of results)
            if (result.cleanupPending)
              this.options.logger.warn(
                { groupId: result.groupId, error: result.cleanupError },
                'Collaboration local Group cleanup remains pending',
              );
        })
        .catch((error) =>
          this.options.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Collaboration local Group cleanup retry failed',
          ),
        );
      scheduler.start();
      this.options.logger.info(
        {
          protocolVersion: 3,
          databasePath: this.databasePath,
          repositoryRoot: this.repositoryRoot,
        },
        'Collaboration project-space v3 Runtime started',
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
      this.analysisValue = null;
      this.analysisExecutorsValue = null;
      this.options.logger.error(
        { error: this.errorValue, databasePath: this.databasePath },
        'Collaboration project-space v3 Runtime is unavailable',
      );
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const store = this.storeValue;
    if (!store) return;
    const scheduler = this.schedulerValue;
    const analysis = this.analysisValue;
    const stopping = (async () => {
      await analysis?.stopAndDrain();
      await scheduler?.stopAndDrain();
      store.close();
      if (this.storeValue !== store) return;
      this.storeValue = null;
      this.groupsValue = null;
      this.schedulerValue = null;
      this.registryValue = null;
      this.analysisValue = null;
      this.analysisExecutorsValue = null;
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
      protocolVersion: 3,
      error: this.errorValue,
      scheduler: this.schedulerValue?.diagnostics() ?? null,
    };
  }

  get store(): CollaborationProjectSpaceStore {
    if (!this.storeValue)
      throw new Error(
        this.errorValue
          ? `Collaboration Runtime is unavailable: ${this.errorValue}`
          : 'Collaboration Runtime is not started',
      );
    return this.storeValue;
  }

  get groups(): CollaborationProjectSpaceService {
    if (!this.groupsValue) {
      void this.store;
      throw new Error('Collaboration Project Space Service is unavailable');
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

  get executors(): ActionExecutorRegistry {
    if (!this.registryValue) {
      void this.store;
      throw new Error('Collaboration Executor Registry is unavailable');
    }
    return this.registryValue;
  }

  get analysis(): CollaborationAnalysisService {
    if (!this.analysisValue) {
      void this.store;
      throw new Error('Collaboration Analysis Service is unavailable');
    }
    return this.analysisValue;
  }

  get analysisExecutors(): ManagedAnalysisExecutorRegistry {
    if (!this.analysisExecutorsValue) {
      void this.store;
      throw new Error('Managed Analysis Executor registry is unavailable');
    }
    return this.analysisExecutorsValue;
  }

  async createBackup(
    backupDirectory: string,
  ): Promise<CollaborationProjectSpaceBackupManifest> {
    void this.store;
    await this.stop();
    try {
      return createCollaborationProjectSpaceBackup({
        databasePath: this.databasePath,
        backupDirectory,
      });
    } finally {
      if (!this.start())
        throw new Error(
          this.errorValue || 'Collaboration Runtime could not restart',
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
      const result = restoreCollaborationProjectSpaceBackup({
        databasePath: this.databasePath,
        backupDirectory,
      });
      rollbackDirectory = result.rollbackDirectory;
      if (!this.start()) {
        const restoredError =
          this.errorValue || 'Restored Collaboration Runtime could not start';
        if (!rollbackDirectory) throw new Error(restoredError);
        rollbackCollaborationProjectSpaceRestore({
          databasePath: this.databasePath,
          rollbackDirectory,
        });
        rollbackDirectory = null;
        if (!this.start())
          throw new Error(
            `${restoredError}; previous database also failed to restart`,
          );
        throw new Error(`${restoredError}; previous database was restored`);
      }
      return result;
    } catch (error) {
      if (!this.storeValue) this.start();
      throw error;
    }
  }
}
