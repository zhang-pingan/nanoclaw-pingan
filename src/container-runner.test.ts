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
  AGENTS_DIR: '/tmp/icarus-test-agents',
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

vi.mock('./workflow-packs/execution-resources.js', () => ({
  verifyWorkflowPackExecutionResourcePin: vi.fn((pin: unknown) => pin),
}));

const readOnlyGateMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  verify: vi.fn(),
  cleanup: vi.fn(),
  mountPath: vi.fn((scope: string) => `/tmp/read-only-gate/${scope}`),
}));

const fileScopeAuthorityMocks = vi.hoisted(() => ({
  createAuthority: vi.fn(),
  register: vi.fn(),
  deactivateAndDrain: vi.fn(async () => undefined),
  cleanup: vi.fn(),
}));

vi.mock('./workflow-packs/read-only-file-gate.js', () => ({
  prepareWorkflowPackReadOnlyFileGate: readOnlyGateMocks.prepare,
}));

vi.mock('./workflow-packs/execution-file-scope-authority.js', () => ({
  createWorkflowPackExecutionFileScopeAuthority:
    fileScopeAuthorityMocks.createAuthority,
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

import {
  runContainerAgent,
  writeAgentsSnapshot,
  ContainerOutput,
} from './container-runner.js';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
import type { RegisteredAgent } from './types.js';
import type { WorkflowPackExecutionResourcePin } from './workflow-packs/execution-resources.js';

function sha256(value: string): `sha256:${string}` {
  return `sha256:${value}`;
}

const testAgent: RegisteredAgent = {
  name: 'Test Agent',
  folder: 'test-agent',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  agentFolder: 'test-agent',
  chatJid: 'web:test',
  isMain: false,
};

const mainAgent: RegisteredAgent = {
  name: 'Main Agent',
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

describe('available Agent snapshot contract', () => {
  it('labels snapshot creation time as generatedAt', () => {
    vi.mocked(fs.writeFileSync).mockReset();

    writeAgentsSnapshot(
      'main',
      true,
      [
        {
          jid: 'web:research',
          name: 'Research',
          lastActivity: '',
          isRegistered: true,
        },
      ],
      new Set(['web:research']),
    );

    const serialized = vi.mocked(fs.writeFileSync).mock.calls[0][1];
    const snapshot = JSON.parse(String(serialized)) as Record<string, unknown>;
    expect(snapshot.generatedAt).toEqual(expect.any(String));
    expect(Object.keys(snapshot).sort()).toEqual(['agents', 'generatedAt']);
  });
});

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
    readOnlyGateMocks.prepare.mockReset();
    readOnlyGateMocks.verify.mockReset();
    readOnlyGateMocks.verify.mockReturnValue({ clean: true, changes: [] });
    readOnlyGateMocks.cleanup.mockReset();
    readOnlyGateMocks.mountPath.mockClear();
    readOnlyGateMocks.prepare.mockReturnValue({
      rootPath: '/tmp/read-only-gate',
      verify: readOnlyGateMocks.verify,
      cleanup: readOnlyGateMocks.cleanup,
      mountPath: readOnlyGateMocks.mountPath,
    });
    fileScopeAuthorityMocks.createAuthority.mockReset();
    fileScopeAuthorityMocks.createAuthority.mockReturnValue({
      id: 'authority-test',
      ipcRootPath: '/tmp/read-only-authority',
      hostActionResultsPath: '/tmp/read-only-authority/host-action-results',
      register: fileScopeAuthorityMocks.register,
      deactivateAndDrain: fileScopeAuthorityMocks.deactivateAndDrain,
      cleanup: fileScopeAuthorityMocks.cleanup,
    });
    fileScopeAuthorityMocks.register.mockReset();
    fileScopeAuthorityMocks.deactivateAndDrain.mockReset();
    fileScopeAuthorityMocks.deactivateAndDrain.mockResolvedValue(undefined);
    fileScopeAuthorityMocks.cleanup.mockReset();
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
      testAgent,
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
      testAgent,
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
      testAgent,
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
      testAgent,
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
      testAgent,
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
      testAgent,
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
      testAgent,
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
    const resultPromise = runContainerAgent(testAgent, testInput, () => {});

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
    const resultPromise = runContainerAgent(testAgent, testInput, () => {});

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
      mainAgent,
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

    const resultPromise = runContainerAgent(testAgent, testInput, () => {});

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

    const resultPromise = runContainerAgent(testAgent, testInput, () => {});

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
      testAgent,
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
      testAgent,
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
      testAgent,
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
      '/tmp/icarus-test-data/run-once-workspaces/test-agent:/workspace/run-once',
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      '/tmp/icarus-test-data/run-once-workspaces/test-agent',
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

  it('mounts an explicit read-only project for external system once without exposing its host path', async () => {
    const resultPromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        isolatedSession: true,
        workspace: { hostPath: '/host/collaboration-project', readonly: true },
      },
      () => {},
    );

    const input = readStdinJson(fakeProc);
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { spawn } = await import('child_process');
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('/host/collaboration-project:/workspace/project:ro');
    await expect(input).resolves.toMatchObject({
      projectWorkspaceMounted: true,
    });
    await expect(input).resolves.not.toHaveProperty('workspace');
  });

  it('uses an explicit writable project instead of the main Agent default project', async () => {
    const resultPromise = runContainerAgent(
      mainAgent,
      {
        ...testInput,
        isMain: true,
        executionMode: 'external_system_once',
        isolatedSession: true,
        workspace: { hostPath: '/host/writable-project', readonly: false },
      },
      () => {},
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { spawn } = await import('child_process');
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('/host/writable-project:/workspace/project');
    expect(args).not.toContain(`${process.cwd()}:/workspace/project`);
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

    const agent: RegisteredAgent = {
      ...testAgent,
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
    const resultPromise = runContainerAgent(agent, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(validateAdditionalMounts).toHaveBeenCalledWith(
      agent.containerConfig?.additionalMounts,
      agent.name,
      false,
    );
    const calls = vi.mocked(spawn).mock.calls;
    const args = calls[calls.length - 1][1] as string[];
    expect(args).toContain(
      '/host/report-readable:/workspace/extra/report-data:ro',
    );
  });

  it('mounts only pinned Pack discovery resources and sends a sanitized Run contract', async () => {
    const pin: WorkflowPackExecutionResourcePin = {
      pack_id: 'example-pack',
      pack_version: '1.0.0',
      manifest_hash: sha256('1'.repeat(64)),
      execution_artifact_resource_id: 'registry-resource:pack-execution',
      execution_artifact_hash: sha256('2'.repeat(64)),
      execution_resource_files: {
        agents: [
          {
            path: 'reviewer.md',
            content_hash: sha256('3'.repeat(64)),
            byte_length: 1,
          },
        ],
        skills: [
          {
            path: 'pack-skill/SKILL.md',
            content_hash: sha256('4'.repeat(64)),
            byte_length: 1,
          },
        ],
        mcp: [
          {
            path: 'mcp.json',
            content_hash: sha256('5'.repeat(64)),
            byte_length: 1,
          },
        ],
        scripts: [
          {
            path: 'server.mjs',
            content_hash: sha256('6'.repeat(64)),
            byte_length: 1,
          },
        ],
        templates: [
          {
            path: 'report.md',
            content_hash: sha256('7'.repeat(64)),
            byte_length: 1,
          },
        ],
      },
      permissions: {
        host_actions: [],
        file_scopes: [],
        mcp_servers: ['pack-tools'],
        effect_ceiling: 'read_only' as const,
      },
      registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
      registry_snapshot_hash: sha256('8'.repeat(64)),
      root_path: '/host/pinned/example-pack-v1',
    };
    const resultPromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        runId: 'pack-run-resources',
        queryId: 'pack-query-resources',
        isolatedSession: true,
        workflowPackExecutionResources: pin,
      },
      () => {},
    );
    const containerInput = await readStdinJson(fakeProc);
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { spawn } = await import('child_process');
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain(
      '/host/pinned/example-pack-v1:/workspace/workflow-pack-resources:ro',
    );
    expect(args).toContain(
      '/host/pinned/example-pack-v1/skills:/home/node/.claude/skills:ro',
    );
    expect(args).toContain(
      '/host/pinned/example-pack-v1/agents:/home/node/.claude/agents:ro',
    );
    expect(args.some((arg) => arg.endsWith(':/workspace/agent'))).toBe(false);
    expect(args.some((arg) => arg.includes(':/workspace/attachments'))).toBe(
      false,
    );
    expect(args.some((arg) => arg.includes(':/workspace/uploads'))).toBe(false);
    expect(args.some((arg) => arg.includes(':/app/custom-tools'))).toBe(false);
    expect(args.some((arg) => arg.includes(':/home/node/.m2'))).toBe(false);
    expect(args.some((arg) => arg.startsWith('MYSQL_PROXY_URL='))).toBe(false);
    expect(args.some((arg) => arg.startsWith('MAVEN_OPTS='))).toBe(false);
    expect(containerInput.workflowPackExecutionResources).toMatchObject({
      format: 'icarus.workflow-pack-run-resources/1',
      pack_id: 'example-pack',
      root_path: '/workspace/workflow-pack-resources',
      permissions: pin.permissions,
      resource_paths: {
        agents: '/workspace/workflow-pack-resources/agents',
        skills: '/workspace/workflow-pack-resources/skills',
        mcp: '/workspace/workflow-pack-resources/mcp',
        scripts: '/workspace/workflow-pack-resources/scripts',
        templates: '/workspace/workflow-pack-resources/templates',
      },
    });
    expect(
      JSON.stringify(containerInput.workflowPackExecutionResources),
    ).not.toContain('/host/pinned');
  });

  it('rejects a Pack workspace mount without the pinned file scope', async () => {
    await expect(
      runContainerAgent(
        testAgent,
        {
          ...testInput,
          executionMode: 'external_system_once',
          runId: 'pack-run-rejected-workspace',
          queryId: 'pack-query-rejected-workspace',
          workspace: { hostPath: '/host/workspace', readonly: true },
          workflowPackExecutionResources: {
            pack_id: 'example-pack',
            pack_version: '1.0.0',
            manifest_hash: `sha256:${'1'.repeat(64)}`,
            execution_artifact_resource_id: 'registry-resource:pack-execution',
            execution_artifact_hash: `sha256:${'2'.repeat(64)}`,
            execution_resource_files: {},
            permissions: {
              host_actions: [],
              file_scopes: [],
              mcp_servers: [],
              effect_ceiling: 'read_only',
            },
            registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
            registry_snapshot_hash: `sha256:${'8'.repeat(64)}`,
            root_path: '/host/pinned/example-pack-v1',
          },
        },
        () => {},
      ),
    ).rejects.toThrow('did not declare the workspace file scope');
  });

  it('uses writable isolated copies for declared read-only Pack file scopes', async () => {
    const resultPromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        runId: 'pack-run-shadow-mounts',
        queryId: 'pack-query-shadow-mounts',
        workspace: { hostPath: '/host/workspace', readonly: false },
        workflowPackExecutionResources: {
          pack_id: 'example-pack',
          pack_version: '1.0.0',
          manifest_hash: sha256('1'.repeat(64)),
          execution_artifact_resource_id: 'registry-resource:pack-execution',
          execution_artifact_hash: sha256('2'.repeat(64)),
          execution_resource_files: {},
          permissions: {
            host_actions: ['send_file'],
            file_scopes: ['agent', 'workspace'],
            mcp_servers: [],
            effect_ceiling: 'read_only',
          },
          registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
          registry_snapshot_hash: sha256('8'.repeat(64)),
          root_path: '/host/pinned/example-pack-v1',
        },
      },
      () => {},
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { spawn } = await import('child_process');
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(readOnlyGateMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: expect.arrayContaining([
          { scope: 'workspace', sourcePath: '/host/workspace' },
          {
            scope: 'agent',
            sourcePath: expect.stringContaining('test-agent'),
          },
        ]),
      }),
    );
    expect(args).toContain('/tmp/read-only-gate/workspace:/workspace/project');
    expect(args).toContain('/tmp/read-only-gate/agent:/workspace/agent');
    expect(args).toContain(
      '/tmp/read-only-authority/messages:/workspace/ipc/messages',
    );
    expect(args).toContain(
      '/tmp/read-only-authority/tasks:/workspace/ipc/tasks',
    );
    expect(args).toContain(
      '/tmp/read-only-authority/host-action-results:/workspace/ipc/host-action-results:ro',
    );
    expect(args.some((arg) => arg.includes('/host/workspace:'))).toBe(false);
    expect(args.some((arg) => arg.includes(':/workspace/run-once'))).toBe(true);
    expect(args).toContain(
      '/host/pinned/example-pack-v1:/workspace/workflow-pack-resources:ro',
    );
    expect(readOnlyGateMocks.verify).toHaveBeenCalledOnce();
    expect(readOnlyGateMocks.cleanup).toHaveBeenCalledOnce();
    expect(fileScopeAuthorityMocks.createAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'pack-run-shadow-mounts',
        queryId: 'pack-query-shadow-mounts',
        agentFolder: 'test-agent',
        hostActions: ['send_file'],
        mappings: expect.arrayContaining([
          expect.objectContaining({
            scope: 'workspace',
            sourcePath: '/host/workspace',
            shadowHostPath: '/tmp/read-only-gate/workspace',
          }),
          expect.objectContaining({
            scope: 'agent',
            shadowHostPath: '/tmp/read-only-gate/agent',
          }),
        ]),
      }),
    );
    expect(fileScopeAuthorityMocks.register).toHaveBeenCalledOnce();
    expect(fileScopeAuthorityMocks.deactivateAndDrain).toHaveBeenCalledOnce();
    expect(fileScopeAuthorityMocks.cleanup).toHaveBeenCalledOnce();
  });

  it('buffers read-only Pack success until the persistent file gate passes', async () => {
    const onOutput = vi.fn(async () => undefined);
    const resultPromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        runId: 'pack-run-buffered-success',
        queryId: 'pack-query-buffered-success',
        workflowPackExecutionResources: {
          pack_id: 'example-pack',
          pack_version: '1.0.0',
          manifest_hash: sha256('1'.repeat(64)),
          execution_artifact_resource_id: 'registry-resource:pack-execution',
          execution_artifact_hash: sha256('2'.repeat(64)),
          execution_resource_files: {},
          permissions: {
            host_actions: [],
            file_scopes: ['agent'],
            mcp_servers: [],
            effect_ceiling: 'read_only',
          },
          registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
          registry_snapshot_hash: sha256('8'.repeat(64)),
          root_path: '/host/pinned/example-pack-v1',
        },
      },
      () => {},
      onOutput,
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'verified' });
    await vi.advanceTimersByTimeAsync(10);
    expect(onOutput).not.toHaveBeenCalledWith(
      expect.objectContaining({ result: 'verified' }),
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ status: 'success' }),
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', result: 'verified' }),
    );
    expect(readOnlyGateMocks.cleanup).toHaveBeenCalledOnce();
  });

  it('overrides a streamed success when the read-only Pack file gate is dirty', async () => {
    readOnlyGateMocks.verify.mockReturnValue({
      clean: false,
      changes: ['agent:report.md changed (content)'],
    });
    const onOutput = vi.fn(async () => undefined);
    const resultPromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        runId: 'pack-run-dirty',
        queryId: 'pack-query-dirty',
        workflowPackExecutionResources: {
          pack_id: 'example-pack',
          pack_version: '1.0.0',
          manifest_hash: sha256('1'.repeat(64)),
          execution_artifact_resource_id: 'registry-resource:pack-execution',
          execution_artifact_hash: sha256('2'.repeat(64)),
          execution_resource_files: {},
          permissions: {
            host_actions: [],
            file_scopes: ['agent'],
            mcp_servers: [],
            effect_ceiling: 'read_only',
          },
          registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
          registry_snapshot_hash: sha256('8'.repeat(64)),
          root_path: '/host/pinned/example-pack-v1',
        },
      },
      () => {},
      onOutput,
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'do not deliver' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toEqual(
      expect.objectContaining({
        status: 'error',
        failure: expect.objectContaining({
          failureSubtype: 'workflow_pack_read_only_file_state_changed',
          retryable: true,
        }),
      }),
    );
    expect(onOutput).not.toHaveBeenCalledWith(
      expect.objectContaining({ result: 'do not deliver' }),
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        failure: expect.objectContaining({ retryable: true }),
      }),
    );
    expect(readOnlyGateMocks.cleanup).toHaveBeenCalledOnce();
  });

  it('cleans a read-only Pack file gate when process registration and kill fail', async () => {
    fakeProc.kill.mockImplementationOnce(() => {
      throw new Error('kill failed');
    });
    const result = await runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        runId: 'pack-run-registration-error',
        queryId: 'pack-query-registration-error',
        workflowPackExecutionResources: {
          pack_id: 'example-pack',
          pack_version: '1.0.0',
          manifest_hash: sha256('1'.repeat(64)),
          execution_artifact_resource_id: 'registry-resource:pack-execution',
          execution_artifact_hash: sha256('2'.repeat(64)),
          execution_resource_files: {},
          permissions: {
            host_actions: [],
            file_scopes: ['agent'],
            mcp_servers: [],
            effect_ceiling: 'read_only',
          },
          registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
          registry_snapshot_hash: sha256('8'.repeat(64)),
          root_path: '/host/pinned/example-pack-v1',
        },
      },
      () => {
        throw new Error('registration failed');
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: 'error',
        failure: expect.objectContaining({
          failureSubtype: 'container_process_registration_error',
        }),
      }),
    );
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(readOnlyGateMocks.cleanup).toHaveBeenCalledOnce();
    expect(fileScopeAuthorityMocks.register).not.toHaveBeenCalled();
    expect(fileScopeAuthorityMocks.cleanup).toHaveBeenCalledOnce();
  });

  it('unregisters the Run file authority after a spawned process error', async () => {
    const resultPromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        runId: 'pack-run-process-error',
        queryId: 'pack-query-process-error',
        workflowPackExecutionResources: {
          pack_id: 'example-pack',
          pack_version: '1.0.0',
          manifest_hash: sha256('1'.repeat(64)),
          execution_artifact_resource_id: 'registry-resource:pack-execution',
          execution_artifact_hash: sha256('2'.repeat(64)),
          execution_resource_files: {},
          permissions: {
            host_actions: ['send_file'],
            file_scopes: ['agent'],
            mcp_servers: [],
            effect_ceiling: 'read_only',
          },
          registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
          registry_snapshot_hash: sha256('8'.repeat(64)),
          root_path: '/host/pinned/example-pack-v1',
        },
      },
      () => undefined,
    );
    expect(fileScopeAuthorityMocks.register).toHaveBeenCalledOnce();

    fakeProc.emit('error', new Error('spawned process failed'));
    await vi.advanceTimersByTimeAsync(10);
    expect(fileScopeAuthorityMocks.deactivateAndDrain).not.toHaveBeenCalled();
    fakeProc.emit('close', null);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        failure: expect.objectContaining({
          failureSubtype: 'container_spawn_error',
        }),
      }),
    );
    expect(fileScopeAuthorityMocks.deactivateAndDrain).toHaveBeenCalledOnce();
    expect(fileScopeAuthorityMocks.cleanup).toHaveBeenCalledOnce();
    expect(readOnlyGateMocks.cleanup).toHaveBeenCalledOnce();
  });

  it('does not apply the Pack file gate to an ordinary Agent session', async () => {
    const resultPromise = runContainerAgent(testAgent, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'ordinary-agent' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ status: 'success', result: 'ordinary-agent' }),
    );

    const { spawn } = await import('child_process');
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(readOnlyGateMocks.prepare).not.toHaveBeenCalled();
    expect(args.some((arg) => arg.endsWith(':/workspace/agent'))).toBe(true);
    expect(args.some((arg) => arg.includes('/tmp/read-only-gate'))).toBe(false);
    expect(fileScopeAuthorityMocks.createAuthority).not.toHaveBeenCalled();
  });

  it('does not apply the Pack file gate to non-Pack or writable Pack Runs', async () => {
    const nonPackPromise = runContainerAgent(
      testAgent,
      { ...testInput, executionMode: 'external_system_once' },
      () => {},
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'non-pack' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await nonPackPromise;
    expect(readOnlyGateMocks.prepare).not.toHaveBeenCalled();

    for (const effect_ceiling of [
      'workspace_write',
      'external_write',
    ] as const) {
      fakeProc = createFakeProcess();
      const writablePackPromise = runContainerAgent(
        testAgent,
        {
          ...testInput,
          executionMode: 'external_system_once',
          workflowPackExecutionResources: {
            pack_id: 'example-pack',
            pack_version: '1.0.0',
            manifest_hash: sha256('1'.repeat(64)),
            execution_artifact_resource_id: 'registry-resource:pack-execution',
            execution_artifact_hash: sha256('2'.repeat(64)),
            execution_resource_files: {},
            permissions: {
              host_actions: [],
              file_scopes: ['agent'],
              mcp_servers: [],
              effect_ceiling,
            },
            registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
            registry_snapshot_hash: sha256('8'.repeat(64)),
            root_path: '/host/pinned/example-pack-v1',
          },
        },
        () => {},
      );
      emitOutputMarker(fakeProc, {
        status: 'success',
        result: `${effect_ceiling}-pack`,
      });
      await vi.advanceTimersByTimeAsync(10);
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      await writablePackPromise;
      expect(readOnlyGateMocks.prepare).not.toHaveBeenCalled();
      expect(fileScopeAuthorityMocks.createAuthority).not.toHaveBeenCalled();
    }

    const { spawn } = await import('child_process');
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(args.some((arg) => arg.endsWith(':/workspace/agent'))).toBe(true);
    expect(args.some((arg) => arg.includes('/tmp/read-only-gate'))).toBe(false);
  });

  it('starts ordinary and writable Pack Runs while a read-only Pack Run remains active', async () => {
    const readOnlyProcess = fakeProc;
    const readOnlyPromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        runId: 'overlap-read-only-run',
        queryId: 'overlap-read-only-query',
        workflowPackExecutionResources: {
          pack_id: 'read-only-pack',
          pack_version: '1.0.0',
          manifest_hash: sha256('1'.repeat(64)),
          execution_artifact_resource_id: 'registry-resource:read-only',
          execution_artifact_hash: sha256('2'.repeat(64)),
          execution_resource_files: {},
          permissions: {
            host_actions: [],
            file_scopes: ['agent'],
            mcp_servers: [],
            effect_ceiling: 'read_only',
          },
          registry_snapshot_id: 'registry-snapshot:read-only-pack@1.0.0',
          registry_snapshot_hash: sha256('8'.repeat(64)),
          root_path: '/host/pinned/read-only-pack-v1',
        },
      },
      () => {},
    );
    expect(fileScopeAuthorityMocks.register).toHaveBeenCalledOnce();

    fakeProc = createFakeProcess();
    const ordinaryProcess = fakeProc;
    const ordinaryPromise = runContainerAgent(testAgent, testInput, () => {});
    emitOutputMarker(ordinaryProcess, {
      status: 'success',
      result: 'ordinary-overlap',
    });
    ordinaryProcess.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(ordinaryPromise).resolves.toMatchObject({
      status: 'success',
      result: 'ordinary-overlap',
    });

    fakeProc = createFakeProcess();
    const writableProcess = fakeProc;
    const writablePromise = runContainerAgent(
      testAgent,
      {
        ...testInput,
        executionMode: 'external_system_once',
        workflowPackExecutionResources: {
          pack_id: 'writable-pack',
          pack_version: '1.0.0',
          manifest_hash: sha256('3'.repeat(64)),
          execution_artifact_resource_id: 'registry-resource:writable',
          execution_artifact_hash: sha256('4'.repeat(64)),
          execution_resource_files: {},
          permissions: {
            host_actions: [],
            file_scopes: ['agent'],
            mcp_servers: [],
            effect_ceiling: 'workspace_write',
          },
          registry_snapshot_id: 'registry-snapshot:writable-pack@1.0.0',
          registry_snapshot_hash: sha256('9'.repeat(64)),
          root_path: '/host/pinned/writable-pack-v1',
        },
      },
      () => {},
    );
    emitOutputMarker(writableProcess, {
      status: 'success',
      result: 'writable-overlap',
    });
    writableProcess.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(writablePromise).resolves.toMatchObject({
      status: 'success',
      result: 'writable-overlap',
    });

    expect(readOnlyGateMocks.verify).not.toHaveBeenCalled();
    emitOutputMarker(readOnlyProcess, {
      status: 'success',
      result: 'read-only-finished',
    });
    readOnlyProcess.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(readOnlyPromise).resolves.toMatchObject({
      status: 'success',
    });
  });
});
