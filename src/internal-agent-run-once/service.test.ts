import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../container-runner.js')>(
    '../container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent: vi.fn(),
  };
});

vi.mock('../model-selector.js', async () => {
  const actual = await vi.importActual<typeof import('../model-selector.js')>(
    '../model-selector.js',
  );
  return {
    ...actual,
    selectModel: vi.fn(async () => ({
      selectedModel: 'test-model',
      reason: 'test',
    })),
  };
});

import { runContainerAgent } from '../container-runner.js';
import { _initTestDatabase } from '../db.js';
import { GroupQueue } from '../group-queue.js';
import { InternalAgentRunOnceService } from './service.js';
import type { RegisteredGroup } from '../types.js';

const group: RegisteredGroup = {
  name: 'L3 Agent',
  folder: 'l3agent',
  trigger: '@Andy',
  added_at: '2026-06-15T00:00:00.000Z',
};

describe('InternalAgentRunOnceService', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.mocked(runContainerAgent).mockReset();
  });

  it('runs the container in external system one-shot mode', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'answer',
          selectedModel: 'test-model',
        });
        return {
          status: 'success',
          result: null,
          selectedModel: 'test-model',
        };
      },
    );

    const service = new InternalAgentRunOnceService({
      registeredGroups: () => ({ 'web:l3agent': group }),
      queue: new GroupQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    const result = await service.runOnce({
      system: 'portal system prompt',
      messages: [{ role: 'user', content: 'question' }],
      chat_jid: 'web:l3agent',
      require_result: true,
      metadata: { source: 'l3agent', trace_id: 'trace-1' },
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'answer',
      model: 'test-model',
    });
    expect(vi.mocked(runContainerAgent).mock.calls[0][1]).toMatchObject({
      prompt: 'question',
      system: 'portal system prompt',
      isolatedSession: true,
      requireResult: true,
      executionMode: 'external_system_once',
      isOneShot: true,
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        vi.mocked(runContainerAgent).mock.calls[0][1],
        'sessionId',
      ),
    ).toBe(false);
  });
});
