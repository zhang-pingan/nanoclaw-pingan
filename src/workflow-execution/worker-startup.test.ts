import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { WorkflowRuntimeConnectionFactory } from '../workflow-runtime/gateway/connection.js';
import { WorkflowExecutionAdapterRegistry } from './adapter-registry.js';
import { WorkflowAdapterExecutionStore } from './execution-store.js';
import { WorkflowExecutionWorker } from './worker.js';
import type { WorkflowExecutionAdapter } from './types.js';

describe('WorkflowExecutionWorker startup', () => {
  it.skipIf(
    !process.execPath.includes(
      `${path.sep}toolchains${path.sep}node${path.sep}`,
    ),
  )('starts against an empty current-checkout Runtime store', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-worker-start-'));
    const runtimeStore = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: path.join(root, 'workflow-runtime.db'),
      databaseMode: 'create',
      identityMode: 'isolated_test',
    });
    const executionStore = new WorkflowAdapterExecutionStore(
      path.join(root, 'workflow-adapter-executions.db'),
    );
    const registry = new WorkflowExecutionAdapterRegistry();
    registry.register({
      refId: 'icarus.adapter.container-agent',
      preflight: async () => undefined,
      start: async () => {
        throw new Error('not expected');
      },
      recover: async () => {
        throw new Error('not expected');
      },
    } satisfies WorkflowExecutionAdapter);
    const worker = new WorkflowExecutionWorker({
      runtimeStore,
      executionStore,
      registry,
      pollIntervalMs: 1000,
      leaseOwner: 'test-worker',
    });

    try {
      await expect(worker.start()).resolves.toBeUndefined();
      await worker.stop();
    } finally {
      executionStore.close();
      runtimeStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
