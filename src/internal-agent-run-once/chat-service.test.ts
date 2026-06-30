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
import type { RegisteredGroup } from '../types.js';
import { InternalAgentChatService } from './chat-service.js';

const group: RegisteredGroup = {
  name: 'Deep Research Analyst',
  folder: 'deep_research_analyst_test',
  trigger: '@agent',
  added_at: '2026-06-29T00:00:00.000Z',
};

describe('InternalAgentChatService', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.mocked(runContainerAgent).mockReset();
  });

  it('runs a resumable agent chat with Deep Research runtime context', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: '分析结果',
          newSessionId: 'session-next',
          selectedModel: 'test-model',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-next',
          selectedModel: 'test-model',
        };
      },
    );

    const service = new InternalAgentChatService({
      registeredGroups: () => ({ 'web:deep-research-analyst': group }),
      queue: new GroupQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    const result = await service.chat({
      chat_jid: 'web:deep-research-analyst',
      session_id: 'session-prev',
      message: '对比引用报告',
      deep_research: {
        conversation_id: 'drs_1',
        mounted_root: '/workspace/extra/openai-deep-research',
        referenced_task_ids: ['dr_1', 'dr_2'],
      },
      metadata: { trace_id: 'msg_1' },
    });

    expect(result).toMatchObject({
      ok: true,
      text: '分析结果',
      session_id: 'session-next',
      model: 'test-model',
    });

    const input = vi.mocked(runContainerAgent).mock.calls[0][1];
    expect(input).toMatchObject({
      sessionId: 'session-prev',
      isolatedSession: false,
      isOneShot: true,
      requireResult: true,
    });
    expect(input.prompt).toContain('conversation_id: drs_1');
    expect(input.prompt).toContain(
      'mounted_root: /workspace/extra/openai-deep-research',
    );
    expect(input.prompt).toContain('- dr_1');
    expect(input.prompt).toContain('User request:\n对比引用报告');
    expect(input.system).toContain('Deep Research industry analyst agent');
  });
});
