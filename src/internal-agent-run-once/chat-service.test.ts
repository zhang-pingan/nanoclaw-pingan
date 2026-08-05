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
import { AgentQueue } from '../agent-queue.js';
import type { RegisteredAgent } from '../types.js';
import { InternalAgentChatService } from './chat-service.js';

const agent: RegisteredAgent = {
  name: 'Chat Agent',
  folder: 'chat_agent_test',
  trigger: '@agent',
  added_at: '2026-06-29T00:00:00.000Z',
};

describe('InternalAgentChatService', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.mocked(runContainerAgent).mockReset();
  });

  it('runs a resumable agent chat with caller-provided prompt and system', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_agent, _input, _onProcess, onOutput) => {
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
      registeredAgents: () => ({ 'web:chat-agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    const result = await service.chat({
      chat_jid: 'web:chat-agent',
      session_id: 'session-prev',
      system: 'caller system prompt',
      message: 'caller runtime context\n\nUser request:\n对比引用报告',
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
    expect(input.prompt).toBe(
      'caller runtime context\n\nUser request:\n对比引用报告',
    );
    expect(input.prompt).toContain('User request:\n对比引用报告');
    expect(input.system).toBe('caller system prompt');
  });
});
