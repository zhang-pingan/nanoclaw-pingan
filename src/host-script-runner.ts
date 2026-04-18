import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export const CONTAINER_LOCAL_SHELL_ROOT = '/workspace/project/local/shell';
export const HOST_LOCAL_SHELL_ROOT = path.join(process.cwd(), 'local', 'shell');
export const HOST_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
export const HOST_SCRIPT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ResolvedLocalHostScript {
  hostRoot: string;
  hostCandidatePath: string;
  realScriptPath: string;
  relativePath: string;
}

export interface RunLocalHostScriptResult {
  status: 'success' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  scriptPath: string;
  error?: string;
}

export interface RunLocalHostScriptOptions {
  hostRootDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function buildOutputChunk(
  current: string,
  chunk: Buffer,
  maxOutputBytes: number,
): { next: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, 'utf8');
  if (currentBytes >= maxOutputBytes) {
    return { next: current, truncated: true };
  }

  const remainingBytes = maxOutputBytes - currentBytes;
  const chunkText = chunk.toString('utf8');
  const chunkBytes = Buffer.byteLength(chunkText, 'utf8');
  if (chunkBytes <= remainingBytes) {
    return { next: current + chunkText, truncated: false };
  }

  let consumedBytes = 0;
  let cutoff = 0;
  for (const char of chunkText) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (consumedBytes + charBytes > remainingBytes) break;
    consumedBytes += charBytes;
    cutoff += char.length;
  }
  return {
    next: current + chunkText.slice(0, cutoff),
    truncated: true,
  };
}

function assertWithinRoot(realRoot: string, realTarget: string): void {
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(
      'Resolved script path escapes the allowed local/shell root',
    );
  }
}

export function resolveLocalHostScript(
  containerScriptPath: string,
  hostRootDir = HOST_LOCAL_SHELL_ROOT,
): ResolvedLocalHostScript {
  if (
    typeof containerScriptPath !== 'string' ||
    containerScriptPath.trim().length === 0
  ) {
    throw new Error('scriptPath must be a non-empty string');
  }

  const normalizedContainerPath = path.posix.normalize(containerScriptPath);
  const containerPrefix = `${CONTAINER_LOCAL_SHELL_ROOT}/`;
  if (!normalizedContainerPath.startsWith(containerPrefix)) {
    throw new Error(`scriptPath must start with ${containerPrefix}`);
  }

  const relativePath = normalizedContainerPath.slice(containerPrefix.length);
  if (!relativePath) {
    throw new Error('scriptPath must point to a file under local/shell');
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(hostRootDir);
  } catch (err) {
    throw new Error(
      `Local shell root is unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const hostCandidatePath = path.resolve(
    realRoot,
    ...relativePath.split('/').filter(Boolean),
  );

  let realScriptPath: string;
  try {
    realScriptPath = fs.realpathSync(hostCandidatePath);
  } catch (err) {
    throw new Error(
      `Script does not exist: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  assertWithinRoot(realRoot, realScriptPath);

  const stat = fs.statSync(realScriptPath);
  if (!stat.isFile()) {
    throw new Error('Resolved script path must be a regular file');
  }

  return {
    hostRoot: realRoot,
    hostCandidatePath,
    realScriptPath,
    relativePath,
  };
}

function buildMinimalEnv(): NodeJS.ProcessEnv {
  const envEntries = Object.entries({
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
  }).filter(([, value]) => typeof value === 'string' && value.length > 0);

  return Object.fromEntries(envEntries);
}

export async function runLocalHostScript(
  containerScriptPath: string,
  args: string[],
  options: RunLocalHostScriptOptions = {},
): Promise<RunLocalHostScriptResult> {
  const timeoutMs = options.timeoutMs ?? HOST_SCRIPT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? HOST_SCRIPT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  const resolved = resolveLocalHostScript(
    containerScriptPath,
    options.hostRootDir,
  );

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let finished = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const child = spawn(resolved.realScriptPath, args, {
      cwd: path.dirname(resolved.realScriptPath),
      env: buildMinimalEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (
      status: 'success' | 'error',
      exitCode: number | null,
      error?: string,
    ) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        status,
        exitCode,
        stdout: stdoutTruncated ? `${stdout}\n[stdout truncated]` : stdout,
        stderr: stderrTruncated ? `${stderr}\n[stderr truncated]` : stderr,
        durationMs: Date.now() - startedAt,
        scriptPath: resolved.realScriptPath,
        error,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const updated = buildOutputChunk(stdout, chunk, maxOutputBytes);
      stdout = updated.next;
      stdoutTruncated = stdoutTruncated || updated.truncated;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const updated = buildOutputChunk(stderr, chunk, maxOutputBytes);
      stderr = updated.next;
      stderrTruncated = stderrTruncated || updated.truncated;
    });

    child.on('error', (err) => {
      finish('error', null, `Failed to spawn script: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish('error', code, `Script timed out after ${timeoutMs}ms`);
        return;
      }
      if (signal) {
        finish('error', code, `Script terminated by signal ${signal}`);
        return;
      }
      if (code !== 0) {
        finish('error', code, `Script exited with code ${code}`);
        return;
      }
      finish('success', code ?? 0);
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
  });
}
