import { describe, expect, it, vi } from 'vitest';

import {
  WorkflowExecutionAdapterRegistry,
  WorkflowExecutionAdapterUnavailableError,
} from './adapter-registry.js';
import type { WorkflowExecutionAdapter } from './types.js';

function adapter(preflight: () => Promise<void>): WorkflowExecutionAdapter {
  return {
    refId: 'adapter:test',
    preflight,
    start: async () => {
      throw new Error('not expected');
    },
    recover: async () => {
      throw new Error('not expected');
    },
  };
}

describe('WorkflowExecutionAdapterRegistry readiness', () => {
  it('refreshes ready to transiently unavailable after the TTL', async () => {
    let nowMs = 100;
    const preflight = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('provider connection lost'));
    const registry = new WorkflowExecutionAdapterRegistry({
      readinessTtlMs: 10,
      now: () => nowMs,
    });
    registry.register(adapter(preflight));

    await expect(registry.refresh('adapter:test')).resolves.toMatchObject({
      status: 'ready',
      checkedAtMs: 100,
    });
    nowMs = 109;
    await registry.refresh('adapter:test');
    expect(preflight).toHaveBeenCalledOnce();
    nowMs = 110;
    await expect(registry.refresh('adapter:test')).resolves.toMatchObject({
      status: 'unavailable',
      failureKind: 'transient',
      error: 'provider connection lost',
      checkedAtMs: 110,
    });
  });

  it('refreshes unavailable to ready without a Host restart', async () => {
    let nowMs = 200;
    const preflight = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new WorkflowExecutionAdapterUnavailableError(
          'missing WORKFLOW_TEST_CONFIGURATION=true',
          'configuration',
        ),
      )
      .mockResolvedValueOnce();
    const registry = new WorkflowExecutionAdapterRegistry({
      readinessTtlMs: 5,
      now: () => nowMs,
    });
    registry.register(adapter(preflight));

    await expect(registry.refresh('adapter:test')).resolves.toMatchObject({
      status: 'unavailable',
      failureKind: 'configuration',
    });
    nowMs = 205;
    await expect(registry.refresh('adapter:test')).resolves.toMatchObject({
      status: 'ready',
      checkedAtMs: 205,
    });
  });

  it('coalesces concurrent forced preflight refreshes', async () => {
    let resolvePreflight: (() => void) | null = null;
    const preflight = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePreflight = resolve;
        }),
    );
    const registry = new WorkflowExecutionAdapterRegistry();
    registry.register(adapter(preflight));

    const first = registry.preflight('adapter:test');
    const second = registry.preflight('adapter:test');
    expect(preflight).toHaveBeenCalledOnce();
    resolvePreflight!();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'ready' }),
      expect.objectContaining({ status: 'ready' }),
    ]);
  });
});
