import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TEST_DATA_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: `${process.env.TMPDIR || '/tmp'}/icarus-run-once-service-${process.pid}`,
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
}));

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

vi.mock('../mount-security.js', () => ({
  validateMount: vi.fn(),
}));

import { runContainerAgent } from '../container-runner.js';
import { _initTestDatabase } from '../db.js';
import { AgentQueue } from '../agent-queue.js';
import { validateMount } from '../mount-security.js';
import { InternalAgentRunOnceService } from './service.js';
import type { RegisteredAgent } from '../types.js';

const agent: RegisteredAgent = {
  name: 'L3 Agent',
  folder: 'l3agent',
  trigger: '@Andy',
  added_at: '2026-06-15T00:00:00.000Z',
};

describe('InternalAgentRunOnceService', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.mocked(runContainerAgent).mockReset();
    vi.mocked(validateMount).mockReset();
    fs.rmSync(path.join(TEST_DATA_DIR, 'run-once-workspaces', 'l3agent'), {
      recursive: true,
      force: true,
    });
  });

  it('preflights and forwards an allowlisted project workspace', async () => {
    vi.mocked(validateMount).mockReturnValue({
      allowed: true,
      reason: 'allowed',
      realHostPath: '/real/project',
      resolvedContainerPath: 'collaboration-project',
      effectiveReadonly: false,
    });
    vi.mocked(runContainerAgent).mockImplementation(
      async (_agent, _input, onProcess, onOutput) => {
        onProcess({} as never, 'container-test');
        await onOutput?.({ status: 'success', result: 'done' });
        return { status: 'success', result: null };
      },
    );
    const service = new InternalAgentRunOnceService({
      registeredAgents: () => ({ 'web:l3agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    await service.runOnce({
      system: 'collaboration action',
      messages: [{ role: 'user', content: 'edit the project' }],
      chat_jid: 'web:l3agent',
      workspace: {
        host_path: '/configured/project',
        access: 'workspace_write',
      },
    });

    expect(validateMount).toHaveBeenCalledWith(
      {
        hostPath: '/configured/project',
        containerPath: 'collaboration-project',
        readonly: false,
      },
      false,
    );
    expect(vi.mocked(runContainerAgent).mock.calls[0][1]).toMatchObject({
      workspace: { hostPath: '/real/project', readonly: false },
    });
  });

  it('fails closed when requested write access is downgraded', () => {
    vi.mocked(validateMount).mockReturnValue({
      allowed: true,
      reason: 'non-main agents are read-only',
      realHostPath: '/real/project',
      resolvedContainerPath: 'collaboration-project',
      effectiveReadonly: true,
    });
    const service = new InternalAgentRunOnceService({
      registeredAgents: () => ({ 'web:l3agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    expect(() =>
      service.preflightWorkspace({
        chatJid: 'web:l3agent',
        workspace: {
          host_path: '/configured/project',
          access: 'workspace_write',
        },
      }),
    ).toThrow(/downgraded to read-only/);
  });

  it('fails closed when no workspace allowlist entry exists', () => {
    vi.mocked(validateMount).mockReturnValue({
      allowed: false,
      reason: 'No mount allowlist configured',
    });
    const service = new InternalAgentRunOnceService({
      registeredAgents: () => ({ 'web:l3agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    expect(() =>
      service.preflightWorkspace({
        chatJid: 'web:l3agent',
        workspace: {
          host_path: '/configured/project',
          access: 'read_only',
        },
      }),
    ).toThrow(/No mount allowlist configured/);
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('runs the container in external system one-shot mode', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_agent, _input, onProcess, onOutput) => {
        onProcess({} as never, 'container-test');
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
      registeredAgents: () => ({ 'web:l3agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    const onAccepted = vi.fn();
    const result = await service.runOnce(
      {
        system: 'portal system prompt',
        messages: [{ role: 'user', content: 'question' }],
        chat_jid: 'web:l3agent',
        require_result: true,
        metadata: { source: 'l3agent', trace_id: 'trace-1' },
      },
      { onAccepted },
    );

    expect(result).toMatchObject({
      ok: true,
      text: 'answer',
      model: 'test-model',
    });
    expect(onAccepted).toHaveBeenCalledWith({
      runId: expect.any(String),
      queryId: expect.any(String),
      containerName: 'container-test',
    });
    expect(vi.mocked(runContainerAgent).mock.calls[0][1]).toMatchObject({
      system: 'portal system prompt',
      isolatedSession: true,
      requireResult: true,
      executionMode: 'external_system_once',
      isOneShot: true,
    });
    expect(vi.mocked(runContainerAgent).mock.calls[0][1].prompt).toContain(
      'Output files:',
    );
    expect(vi.mocked(runContainerAgent).mock.calls[0][1].prompt).toContain(
      'User request:\nquestion',
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        vi.mocked(runContainerAgent).mock.calls[0][1],
        'sessionId',
      ),
    ).toBe(false);
  });

  it('injects structured file metadata into the container prompt', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_agent, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'file answer',
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
      registeredAgents: () => ({ 'web:l3agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    await service.runOnce({
      system: 'portal system prompt',
      messages: [{ role: 'user', content: 'summarize attachment' }],
      chat_jid: 'web:l3agent',
      require_result: true,
      metadata: {},
      files: [
        {
          name: 'report.md',
          agent_path: '/workspace/run-once/inputs/upload-1/report.md',
          relative_path: 'inputs/upload-1/report.md',
          size: 12,
          sha256: 'abc123',
          content_type: 'text/markdown',
        },
      ],
    });

    expect(vi.mocked(runContainerAgent).mock.calls[0][1].prompt).toContain(
      'Available files:',
    );
    expect(vi.mocked(runContainerAgent).mock.calls[0][1].prompt).toContain(
      '/workspace/run-once/inputs/upload-1/report.md',
    );
    expect(vi.mocked(runContainerAgent).mock.calls[0][1].prompt).toContain(
      'User request:\nsummarize attachment',
    );
  });

  it('strips think blocks from run-once text responses', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_agent, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: '<think>private reasoning</think>visible answer',
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
      registeredAgents: () => ({ 'web:l3agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    const result = await service.runOnce({
      system: 'portal system prompt',
      messages: [{ role: 'user', content: 'question' }],
      chat_jid: 'web:l3agent',
      require_result: true,
      metadata: {},
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'visible answer',
    });
  });

  it('returns files generated under the run-once output directory', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_agent, input, _onProcess, onOutput) => {
        const match = input.prompt.match(
          /write them under (\/workspace\/run-once\/outputs\/[^/]+)\//,
        );
        if (!match?.[1]) throw new Error('output directory not injected');
        const outputRelativeDir = match[1].replace(
          /^\/workspace\/run-once\//,
          '',
        );
        const outputHostDir = path.resolve(
          TEST_DATA_DIR,
          'run-once-workspaces',
          'l3agent',
          outputRelativeDir,
        );
        fs.mkdirSync(outputHostDir, { recursive: true });
        fs.writeFileSync(path.join(outputHostDir, 'report.md'), '# Report\n');

        await onOutput?.({
          status: 'success',
          result: 'generated report',
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
      registeredAgents: () => ({ 'web:l3agent': agent }),
      queue: new AgentQueue(),
      onProcess: vi.fn(),
      maxInputChars: 10000,
    });

    const result = await service.runOnce({
      system: 'portal system prompt',
      messages: [{ role: 'user', content: 'generate a markdown report' }],
      chat_jid: 'web:l3agent',
      require_result: true,
      metadata: {},
    });

    expect(result).toMatchObject({
      ok: true,
      output_files: [
        {
          name: 'report.md',
          agent_path: expect.stringMatching(
            /^\/workspace\/run-once\/outputs\/[^/]+\/report\.md$/,
          ),
          relative_path: expect.stringMatching(/^outputs\/[^/]+\/report\.md$/),
          size: Buffer.byteLength('# Report\n'),
          sha256: expect.any(String),
          content_type: 'text/markdown',
          download_url: expect.stringContaining(
            '/internal/agent/run-once/files?',
          ),
        },
      ],
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.output_files?.[0]?.download_url).toContain(
      'chat_jid=web%3Al3agent',
    );
  });

  it('writes full run-once trace into the run-once workspace', async () => {
    vi.mocked(runContainerAgent).mockImplementation(
      async (_agent, _input, _onProcess, onOutput) => {
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
      registeredAgents: () => ({ 'internal:l3agent': agent }),
      queue: new AgentQueue(),
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
      TEST_DATA_DIR,
      'run-once-workspaces',
      'l3agent',
      result.trace_path!.replace(/^\/workspace\/run-once\//, ''),
    );
    const trace = JSON.parse(fs.readFileSync(hostTracePath, 'utf-8'));

    expect(trace).toMatchObject({
      schema_version: 1,
      status: 'success',
      chat_jid: 'internal:l3agent',
      agent_folder: 'l3agent',
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
