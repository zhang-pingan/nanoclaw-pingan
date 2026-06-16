import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

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
    fs.rmSync(path.resolve('data/run-once-workspaces/l3agent'), {
      recursive: true,
      force: true,
    });
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

  it('writes full run-once trace into the run-once workspace', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: null,
          selectedModel: 'test-model',
          event: {
            type: 'command',
            name: 'command_started',
            status: 'running',
            summary: 'Running date',
            payload: {
              toolName: 'Bash',
              toolUseId: 'tool-1',
              commandPreview: 'date',
            },
          },
        });
        await onOutput?.({
          status: 'success',
          result: '2026-06-15 18:40:00 CST',
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
      registeredGroups: () => ({ 'internal:l3agent': group }),
      queue: new GroupQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    const result = await service.runOnce({
      system: 'use tools for realtime questions',
      messages: [{ role: 'user', content: '现在几点了' }],
      chat_jid: 'internal:l3agent',
      require_result: true,
      metadata: { source: 'l3agent', trace_id: 'trace-2' },
    });

    expect(result).toMatchObject({
      ok: true,
      text: '2026-06-15 18:40:00 CST',
      trace_path: expect.stringMatching(
        /^\/workspace\/run-once\/traces\/.+\.json$/,
      ),
    });

    const hostTracePath = path.resolve(
      'data/run-once-workspaces/l3agent',
      result.trace_path!.replace(/^\/workspace\/run-once\//, ''),
    );
    const trace = JSON.parse(fs.readFileSync(hostTracePath, 'utf-8'));

    expect(trace).toMatchObject({
      schema_version: 1,
      status: 'success',
      chat_jid: 'internal:l3agent',
      group_folder: 'l3agent',
      request: {
        system: 'use tools for realtime questions',
        messages: [{ role: 'user', content: '现在几点了' }],
        metadata: { source: 'l3agent', trace_id: 'trace-2' },
      },
      response: {
        ok: true,
        text: '2026-06-15 18:40:00 CST',
      },
      agent_trace: {
        query: {
          query_id: expect.any(String),
          source_type: 'internal_run_once',
        },
        summary: {
          toolCallCount: 1,
        },
        highlights: {
          models: expect.any(Array),
          tools: expect.any(Array),
        },
      },
      container_input: {
        cwd: '/workspace/run-once',
        executionMode: 'external_system_once',
      },
    });
    expect(trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'container_output',
          output: expect.objectContaining({
            event: expect.objectContaining({
              type: 'command',
              name: 'command_started',
            }),
          }),
        }),
        expect.objectContaining({
          kind: 'result',
          output: expect.objectContaining({
            result: '2026-06-15 18:40:00 CST',
          }),
        }),
        expect.objectContaining({
          kind: 'final',
          status: 'success',
        }),
      ]),
    );
  });
});
