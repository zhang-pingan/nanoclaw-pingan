import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkflowAdapterExecutionStore } from './execution-store.js';
import type {
  WorkflowAdapterExecutionContext,
  WorkflowAgentDispatchRequest,
  WorkflowAgentResult,
} from './types.js';

const roots: string[] = [];
const stores: WorkflowAdapterExecutionStore[] = [];

function openStore(): WorkflowAdapterExecutionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-adapter-store-'));
  roots.push(root);
  const store = new WorkflowAdapterExecutionStore(
    path.join(root, 'adapter.db'),
  );
  stores.push(store);
  return store;
}

const request: WorkflowAgentDispatchRequest = {
  format: 'icarus.workflow-agent-dispatch-request/1',
  task: { title: 'Test', prompt: 'Complete the task', files: [] },
  result_schema: {
    id: 'example.result',
    version: '1.0.0',
    content_hash:
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  },
  metadata: {},
};

const context: Omit<WorkflowAdapterExecutionContext, 'executionId'> = {
  operationKey: 'operation-1',
  requestHash:
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  adapterResourceId: 'adapter-row',
  adapterResourceHash:
    'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  adapterRefId: 'icarus.adapter.container-agent',
  adapterRefVersion: '0.1.0',
  outboxId: 'outbox-1',
  outboxAttemptKind: 'deliver',
  outboxHistorySequence: 1,
  outboxKindAttemptNo: 1,
  outboxPolicyHash:
    'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  outboxMaxAttempts: 3,
  outboxDeadlineAtMs: 20_000,
  outboxLeaseOwner: 'worker-1',
  outboxLeaseToken: 'lease-1',
  requestValueId: 'request-value-1',
  effectOperationId: 'effect-1',
  graphRunId: 'run-1',
  scopeId: 'scope-1',
  nodeId: 'node-1',
  attemptId: 'attempt-1',
  delegationId: 'delegation-1',
  runWorkFenceEpoch: 1,
  scopeWorkFenceEpoch: 1,
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('WorkflowAdapterExecutionStore', () => {
  it('reserves a stable execution and accepts exact replay', () => {
    const store = openStore();
    const first = store.reserve({
      operationKey: context.operationKey,
      adapterRefId: context.adapterRefId,
      adapterResourceHash: context.adapterResourceHash,
      requestHash: context.requestHash,
      request,
      context,
      nowMs: 1000,
    });
    const replay = store.reserve({
      operationKey: context.operationKey,
      adapterRefId: context.adapterRefId,
      adapterResourceHash: context.adapterResourceHash,
      requestHash: context.requestHash,
      request,
      context,
      nowMs: 2000,
    });

    expect(replay).toEqual(first);
    expect(first.executionId).toMatch(/^wae-[0-9a-f]{40}$/);
  });

  it('rejects an operation-key collision', () => {
    const store = openStore();
    store.reserve({
      operationKey: context.operationKey,
      adapterRefId: context.adapterRefId,
      adapterResourceHash: context.adapterResourceHash,
      requestHash: context.requestHash,
      request,
      context,
      nowMs: 1000,
    });
    expect(() =>
      store.reserve({
        operationKey: context.operationKey,
        adapterRefId: context.adapterRefId,
        adapterResourceHash: context.adapterResourceHash,
        requestHash:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        request,
        context,
        nowMs: 2000,
      }),
    ).toThrow(/operation key collision/);
  });

  it('persists a terminal result until its T6b callback is delivered', () => {
    const store = openStore();
    const reserved = store.reserve({
      operationKey: context.operationKey,
      adapterRefId: context.adapterRefId,
      adapterResourceHash: context.adapterResourceHash,
      requestHash: context.requestHash,
      request,
      context,
      nowMs: 1000,
    });
    store.markAccepted(reserved.executionId, { run_id: 'run-once-1' }, 1100);
    store.markRunning(reserved.executionId, 1200);
    const result: WorkflowAgentResult = {
      format: 'icarus.workflow-agent-result/1',
      outcome: 'success',
      summary: 'done',
      provider: {
        adapter: context.adapterRefId,
        execution_id: reserved.executionId,
        metadata: {},
      },
      artifacts: [],
      error: null,
    };
    store.markTerminal(reserved.executionId, 'succeeded', result, null, 1300);

    expect(store.listPendingCallbacks()).toHaveLength(1);
    store.markCallbackDelivered(reserved.executionId, 1400);
    expect(store.listPendingCallbacks()).toEqual([]);
    expect(store.get(reserved.executionId)?.callbackDeliveredAtMs).toBe(1400);
  });
});
