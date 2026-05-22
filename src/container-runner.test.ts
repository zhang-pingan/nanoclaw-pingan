import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---ICARUS_OUTPUT_START---';
const OUTPUT_END_MARKER = '---ICARUS_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'icarus-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_NODE_MODULES_DIR: '/tmp/icarus-test-container-node-modules',
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  MYSQL_PROXY_PORT: 3307,
  SSH_KEY_PATH: null,
  AI_IMAGES_DIR: '/tmp/icarus-test-ai-images',
  ATTACHMENTS_DIR: '/tmp/icarus-test-attachments',
  DATA_DIR: '/tmp/icarus-test-data',
  DESKTOP_CAPTURES_DIR: '/tmp/icarus-test-desktop-captures',
  GROUPS_DIR: '/tmp/icarus-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

const mainGroup: RegisteredGroup = {
  name: 'Main Group',
  folder: 'main',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  isMain: true,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

async function readStdinJson(proc: ReturnType<typeof createFakeProcess>) {
  const chunks: Buffer[] = [];
  proc.stdin.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });
  await vi.advanceTimersByTimeAsync(10);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(result.failure).toMatchObject({
      failureType: 'timeout',
      failureSubtype: 'container_timeout_no_output',
      failureOrigin: 'container',
      retryable: true,
    });
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });


  it('returns structured failure when a required text result is missing', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, requireResult: true },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-789',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toBe(
      'Container completed without required text result',
    );
    expect(result.failure).toMatchObject({
      failureType: 'model_output_invalid',
      failureSubtype: 'agent_result_missing',
      failureOrigin: 'model',
      retryable: true,
    });
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: null, newSessionId: 'session-789' }),
    );
  });

  it('returns streamed error output instead of treating it as idle success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, requireResult: true },
      () => {},
      onOutput,
    );

    const streamedError: ContainerOutput = {
      status: 'error',
      result: null,
      error: 'SDK query ended without result message',
      failure: {
        failureType: 'model_output_invalid',
        failureSubtype: 'agent_result_missing',
        failureOrigin: 'model',
        retryable: true,
        details: { messageCount: 2, lastMessageType: 'attachment' },
      },
      newSessionId: 'session-error',
    };
    emitOutputMarker(fakeProc, streamedError);

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toEqual(streamedError);
    expect(onOutput).toHaveBeenCalledWith(streamedError);
  });

  it('returns structured failure when streamed output marker cannot be parsed', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{"status":\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.failure).toMatchObject({
      failureType: 'tool_contract_error',
      failureSubtype: 'container_output_parse_failed',
      failureOrigin: 'container',
      retryable: false,
    });
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('returns structured failure when the container exits non-zero', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.stderr.push('boom');
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.failure).toMatchObject({
      failureType: 'container_runtime_error',
      failureSubtype: 'container_exit_nonzero',
      failureOrigin: 'container',
      retryable: true,
    });
  });

  it('mounts isolated Linux node_modules over the main project node_modules', async () => {
    const { spawn } = await import('child_process');
    const resultPromise = runContainerAgent(
      mainGroup,
      { ...testInput, isMain: true },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const calls = vi.mocked(spawn).mock.calls;
    const args = calls[calls.length - 1][1] as string[];
    expect(args).toContain('-v');
    expect(args).toContain(
      '/tmp/icarus-test-container-node-modules:/workspace/project/node_modules',
    );
  });

  it('passes one-shot mode to the container input', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, isOneShot: true },
      () => {},
    );

    await expect(readStdinJson(fakeProc)).resolves.toMatchObject({
      isOneShot: true,
    });

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
