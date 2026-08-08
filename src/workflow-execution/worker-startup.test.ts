import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { WorkflowRuntimeConnectionFactory } from '../workflow-runtime/gateway/connection.js';
import {
  WorkflowExecutionAdapterRegistry,
  WorkflowExecutionAdapterUnavailableError,
} from './adapter-registry.js';
import { WorkflowAdapterExecutionStore } from './execution-store.js';
import { WorkflowExecutionWorker } from './worker.js';
import type { WorkflowExecutionAdapter } from './types.js';

describe('WorkflowExecutionWorker startup', () => {
  it('preflights every Adapter and keeps the Host available when one fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-worker-start-'));
    const runtimeStore = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: path.join(root, 'workflow-runtime.db'),
      databaseMode: 'create',
    });
    const executionStore = new WorkflowAdapterExecutionStore(
      path.join(root, 'workflow-adapter-executions.db'),
    );
    const registry = new WorkflowExecutionAdapterRegistry();
    const readyPreflight = vi.fn(async () => undefined);
    const unavailablePreflight = vi.fn(async () => {
      throw new WorkflowExecutionAdapterUnavailableError(
        'WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED=true',
        'configuration',
      );
    });
    registry.register({
      refId: 'icarus.adapter.container-agent',
      preflight: readyPreflight,
      start: async () => {
        throw new Error('not expected');
      },
      recover: async () => {
        throw new Error('not expected');
      },
    } satisfies WorkflowExecutionAdapter);
    registry.register({
      refId: 'icarus.adapter.codex-task',
      preflight: unavailablePreflight,
      start: async () => {
        throw new Error('not expected');
      },
      recover: async () => {
        throw new Error('not expected');
      },
    } satisfies WorkflowExecutionAdapter);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const worker = new WorkflowExecutionWorker({
      runtimeStore,
      executionStore,
      registry,
      pollIntervalMs: 1000,
      leaseOwner: 'test-worker',
      logger,
    });

    try {
      await expect(worker.start()).resolves.toBeUndefined();
      expect(readyPreflight).toHaveBeenCalledOnce();
      expect(unavailablePreflight).toHaveBeenCalledOnce();
      expect(
        registry.getReadiness('icarus.adapter.container-agent'),
      ).toMatchObject({
        status: 'ready',
        error: null,
      });
      expect(registry.getReadiness('icarus.adapter.codex-task')).toMatchObject({
        status: 'unavailable',
        error: 'WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED=true',
        failureKind: 'configuration',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterRefId: 'icarus.adapter.codex-task',
        }),
        expect.stringContaining('preflight failed'),
      );
      await worker.stop();
    } finally {
      executionStore.close();
      runtimeStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
