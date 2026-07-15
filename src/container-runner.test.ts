import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import path from 'path';

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

// Mock env reader
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
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
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
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
  const originalMavenEnv = {
    MAVEN_OPTS: process.env.MAVEN_OPTS,
    MAVEN_SETTINGS_PATH: process.env.MAVEN_SETTINGS_PATH,
    MAVEN_SETTINGS_XML: process.env.MAVEN_SETTINGS_XML,
    MVN_SETTINGS_XML: process.env.MVN_SETTINGS_XML,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(readEnvFile).mockReset();
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => false,
    } as any);
    delete process.env.MAVEN_OPTS;
    delete process.env.MAVEN_SETTINGS_PATH;
    delete process.env.MAVEN_SETTINGS_XML;
    delete process.env.MVN_SETTINGS_XML;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalMavenEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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
    expect(result.final).toBe(true);
    expect(result.newSessionId).toBe('session-456');
  });

  it('forwards non-final empty success marker but resolves with final completion marker', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    const nonFinalMarker: ContainerOutput = {
      status: 'success',
      result: null,
      final: false,
      newSessionId: 'session-non-final',
    };
    emitOutputMarker(fakeProc, nonFinalMarker);

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(onOutput).toHaveBeenCalledWith(nonFinalMarker);
    expect(result).toMatchObject({
      status: 'success',
      result: null,
      final: true,
      newSessionId: 'session-non-final',
    });
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

  it('reports code 137 as a killed container instead of an API retry root cause', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.stderr.push(
      [
        '[agent-runner] [msg #5] type=system/api_retry',
        '[agent-runner] SDK event: api_retry status=running summary=API retry 4/10 in 4519ms',
      ].join('\n'),
    );
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container exited with code 137');
    expect(result.error).toContain('process was killed with SIGKILL');
    expect(result.error).toContain('Last output:');
    expect(result.failure).toMatchObject({
      failureType: 'container_runtime_error',
      failureSubtype: 'container_killed_137',
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

  it('mounts configured Maven settings and repository into the container defaults', async () => {
    const { spawn } = await import('child_process');
    const fs = await import('fs');
    const { readEnvFile } = await import('./env.js');
    vi.mocked(readEnvFile).mockImplementation((keys: string[]) => {
      const env: Record<string, string> = {};
      if (keys.includes('MAVEN_SETTINGS_XML')) {
        env.MAVEN_SETTINGS_XML = '/host/maven/settings.xml';
      }
      return env;
    });
    vi.mocked(fs.default.existsSync).mockImplementation(
      (filePath) =>
        filePath === '/host/maven/settings.xml' ||
        filePath === '/host/maven/repository',
    );
    vi.mocked(fs.default.statSync).mockImplementation(
      (filePath) =>
        ({
          isDirectory: () => filePath === '/host/maven/repository',
          isFile: () => filePath === '/host/maven/settings.xml',
        }) as any,
    );
    vi.mocked(fs.default.readFileSync).mockImplementation((filePath) => {
      if (filePath === '/host/maven/settings.xml') {
        return [
          '<settings>',
          '  <localRepository>/host/maven/repository</localRepository>',
          '</settings>',
        ].join('\n');
      }
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

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
    expect(args).toContain(
      '/host/maven/settings.xml:/home/node/.m2/settings.xml:ro',
    );
    expect(args).toContain('/host/maven/repository:/home/node/.m2/repository');
    expect(args).toContain('-e');
    expect(args).toContain(
      'MAVEN_OPTS=-Dmaven.repo.local=/home/node/.m2/repository',
    );
  });

  it('uses default Maven settings and repository paths when not configured', async () => {
    const { spawn } = await import('child_process');
    const homeDir = process.env.HOME || '';
    const settingsPath = path.join(homeDir, '.m2', 'settings.xml');
    const repositoryPath = path.join(homeDir, '.m2', 'repository');

    vi.mocked(fs.existsSync).mockImplementation(
      (filePath) => filePath === settingsPath || filePath === repositoryPath,
    );
    vi.mocked(fs.statSync).mockImplementation(
      (filePath) =>
        ({
          isDirectory: () => filePath === repositoryPath,
          isFile: () => filePath === settingsPath,
        }) as any,
    );
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (filePath === settingsPath) {
        return '<settings></settings>';
      }
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

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
    expect(args).toContain(`${settingsPath}:/home/node/.m2/settings.xml:ro`);
    expect(args).toContain(`${repositoryPath}:/home/node/.m2/repository`);
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

  it('passes external system once fields to the container input', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        system: 'external system prompt',
        executionMode: 'external_system_once',
        isolatedSession: true,
        requireResult: true,
        isOneShot: true,
      },
      () => {},
    );

    await expect(readStdinJson(fakeProc)).resolves.toMatchObject({
      system: 'external system prompt',
      executionMode: 'external_system_once',
      isolatedSession: true,
      requireResult: true,
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

  it('mounts a writable run-once workspace for external system once', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        executionMode: 'external_system_once',
        isolatedSession: true,
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);

    const { spawn } = await import('child_process');
    const calls = vi.mocked(spawn).mock.calls;
    const args = calls[calls.length - 1][1] as string[];
    expect(args).toContain(
      '/tmp/icarus-test-data/run-once-workspaces/test-group:/workspace/run-once',
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      '/tmp/icarus-test-data/run-once-workspaces/test-group',
      { recursive: true },
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('mounts validated additional mounts', async () => {
    const { spawn } = await import('child_process');
    vi.mocked(validateAdditionalMounts).mockReturnValueOnce([
      {
        hostPath: '/host/report-readable',
        containerPath: '/workspace/extra/report-data',
        readonly: true,
      },
    ]);

    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/host/report-readable',
            containerPath: 'report-data',
            readonly: true,
          },
        ],
      },
    };
    const resultPromise = runContainerAgent(group, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(validateAdditionalMounts).toHaveBeenCalledWith(
      group.containerConfig?.additionalMounts,
      group.name,
      false,
    );
    const calls = vi.mocked(spawn).mock.calls;
    const args = calls[calls.length - 1][1] as string[];
    expect(args).toContain(
      '/host/report-readable:/workspace/extra/report-data:ro',
    );
  });

});
