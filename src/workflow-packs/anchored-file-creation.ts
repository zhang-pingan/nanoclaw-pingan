import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ANCHORED_FILE_HELPER_MAX_BYTES = 512 * 1024 * 1024;

const HELPER_BINARY_NAME = 'icarus-openat-helper';
const HELPER_MANIFEST_NAME = 'manifest.json';
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);

type HelperManifest = {
  readonly formatVersion: 1;
  readonly platform: string;
  readonly arch: string;
  readonly binary: typeof HELPER_BINARY_NAME;
  readonly sha256: string;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sha256(file: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function requiredStat(pathname: string, label: string): fs.Stats {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is missing: ${pathname}`);
    }
    throw error;
  }
}

function requireSupportedTarget(): string {
  const target = `${process.platform}-${process.arch}`;
  if (
    !SUPPORTED_PLATFORMS.has(process.platform) ||
    !SUPPORTED_ARCHITECTURES.has(process.arch)
  ) {
    throw new Error(
      `Workflow Pack anchored file helper does not support ${target}; supported targets are darwin/linux on arm64/x64`,
    );
  }
  return target;
}

function parseManifest(value: unknown): HelperManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow Pack anchored file helper manifest is invalid');
  }
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  if (
    keys.join(',') !== 'arch,binary,formatVersion,platform,sha256' ||
    manifest.formatVersion !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.binary !== HELPER_BINARY_NAME ||
    typeof manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256)
  ) {
    throw new Error('Workflow Pack anchored file helper manifest is invalid');
  }
  return manifest as HelperManifest;
}

export function validateAnchoredFileHelperDirectory(directory: string): string {
  const resolvedDirectory = path.resolve(directory);
  const directoryStat = requiredStat(
    resolvedDirectory,
    'Workflow Pack anchored file helper directory',
  );
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(
      'Workflow Pack anchored file helper directory is not a regular directory',
    );
  }
  const canonicalDirectory = fs.realpathSync.native(resolvedDirectory);
  if (canonicalDirectory !== resolvedDirectory) {
    throw new Error(
      'Workflow Pack anchored file helper directory changed through a symbolic link',
    );
  }

  const manifestPath = path.join(canonicalDirectory, HELPER_MANIFEST_NAME);
  const manifestStat = requiredStat(
    manifestPath,
    'Workflow Pack anchored file helper manifest',
  );
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(
      'Workflow Pack anchored file helper manifest is not a regular file',
    );
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as unknown;
  } catch (error) {
    throw new Error(
      `Workflow Pack anchored file helper manifest could not be parsed: ${asError(error).message}`,
    );
  }
  const manifest = parseManifest(manifestValue);

  const binaryPath = path.join(canonicalDirectory, manifest.binary);
  const binaryStat = requiredStat(
    binaryPath,
    'Workflow Pack anchored file helper binary',
  );
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) {
    throw new Error('Workflow Pack anchored file helper is not a regular file');
  }
  if ((binaryStat.mode & 0o111) === 0) {
    throw new Error('Workflow Pack anchored file helper is not executable');
  }
  if (sha256(binaryPath) !== manifest.sha256) {
    throw new Error('Workflow Pack anchored file helper hash mismatch');
  }
  return binaryPath;
}

export function resolveAnchoredFileHelperPath(): string {
  const target = requireSupportedTarget();
  const parentDirectory = path.dirname(import.meta.dirname);
  const tree = path.basename(parentDirectory);
  if (tree === 'src') {
    return validateAnchoredFileHelperDirectory(
      path.resolve(parentDirectory, '..', 'build', 'native', target),
    );
  }
  if (tree === 'dist') {
    return validateAnchoredFileHelperDirectory(
      path.join(import.meta.dirname, 'native', target),
    );
  }
  throw new Error(
    `Workflow Pack anchored file helper cannot resolve runtime tree ${tree}; run the helper build step and start from src or dist`,
  );
}

export interface AnchoredFileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface AnchoredFileCreationInput {
  readonly rootPath: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly afterParentOpened?: () => void | Promise<void>;
  readonly verifyCreatedFile: (identity: AnchoredFileIdentity) => void;
  /** Exercises a delivered helper failure boundary in adversarial tests. */
  readonly testProtocolMode?: 'exit_after_ready' | 'hang_after_ready';
  readonly timeoutMs?: number;
}

function assertPayloadSize(bytes: Uint8Array): void {
  if (bytes.byteLength > ANCHORED_FILE_HELPER_MAX_BYTES) {
    throw new Error(
      `Workflow Pack anchored file output exceeds ${ANCHORED_FILE_HELPER_MAX_BYTES} bytes`,
    );
  }
}

function spawnHelper(
  binary: string,
  input: AnchoredFileCreationInput,
): ChildProcessWithoutNullStreams {
  const args = [
    input.rootPath,
    input.relativePath,
    String(input.rootDevice),
    String(input.rootInode),
    input.mode.toString(8),
  ];
  if (input.testProtocolMode) args.push(input.testProtocolMode);
  return spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function createFileWithAnchoredParents(
  input: AnchoredFileCreationInput,
): Promise<void> {
  assertPayloadSize(input.bytes);
  const binary = resolveAnchoredFileHelperPath();
  const child = spawnHelper(binary, input);
  const bytes = Buffer.from(input.bytes);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));

  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let ready = false;
    let written = false;
    let commitSent = false;
    let operationError: Error | null = null;
    let stdinError: Error | null = null;
    let settled = false;
    let protocolQueue = Promise.resolve();
    let forcedTermination: NodeJS.Timeout | null = null;
    const pendingWrites = new Set<(error: Error) => void>();

    const rememberError = (error: unknown): Error => {
      const normalized = asError(error);
      if (!operationError) operationError = normalized;
      return normalized;
    };

    const rejectPendingWrites = (error: Error): void => {
      for (const rejectWrite of [...pendingWrites]) rejectWrite(error);
    };

    const abort = (error: unknown): void => {
      rememberError(error);
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (!forcedTermination) {
        forcedTermination = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1_000);
      }
    };

    const writeInput = (chunk: Uint8Array): Promise<void> =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        if (stdinError) {
          rejectWrite(stdinError);
          return;
        }
        let completed = false;
        const rejectOnce = (error: Error): void => {
          if (completed) return;
          completed = true;
          pendingWrites.delete(rejectOnce);
          rejectWrite(error);
        };
        pendingWrites.add(rejectOnce);
        try {
          child.stdin.write(chunk, (error?: Error | null) => {
            if (completed) return;
            completed = true;
            pendingWrites.delete(rejectOnce);
            if (error) rejectWrite(error);
            else resolveWrite();
          });
        } catch (error) {
          rejectOnce(asError(error));
        }
      });

    const endInput = (): void => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        try {
          child.stdin.end();
        } catch (error) {
          abort(error);
        }
      }
    };

    const handleLine = async (line: string): Promise<void> => {
      if (line === 'READY') {
        if (ready || written) {
          throw new Error(
            'Workflow Pack anchored file helper emitted READY out of order',
          );
        }
        ready = true;
        await input.afterParentOpened?.();
        await writeInput(length);
        await writeInput(bytes);
        return;
      }

      const match = line.match(/^WRITTEN ([0-9]+) ([0-9]+)$/u);
      if (match) {
        if (!ready || written) {
          throw new Error(
            'Workflow Pack anchored file helper emitted WRITTEN out of order',
          );
        }
        written = true;
        try {
          input.verifyCreatedFile({
            device: Number(match[1]),
            inode: Number(match[2]),
          });
          await writeInput(Buffer.from('C'));
          commitSent = true;
        } catch (error) {
          rememberError(error);
          try {
            await writeInput(Buffer.from('A'));
          } catch (writeError) {
            rememberError(writeError);
          }
        } finally {
          endInput();
        }
        return;
      }

      throw new Error(
        `Workflow Pack anchored file helper emitted an invalid protocol line: ${line}`,
      );
    };

    const enqueueLine = (line: string): void => {
      protocolQueue = protocolQueue
        .then(async () => {
          if (!operationError) await handleLine(line);
        })
        .catch((error) => abort(error));
    };

    const timeout = setTimeout(() => {
      abort(new Error('Workflow Pack anchored file helper timed out'));
    }, input.timeoutMs ?? 30_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        enqueueLine(line);
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on('error', (error) => {
      if (settled) return;
      const controlledError = new Error(
        `Workflow Pack anchored file helper input failed: ${error.message}`,
      );
      stdinError = controlledError;
      rejectPendingWrites(controlledError);
      abort(controlledError);
    });
    child.stdin.on('close', () => {
      if (pendingWrites.size > 0) {
        const error = new Error(
          'Workflow Pack anchored file helper input closed before the protocol completed',
        );
        stdinError = error;
        rejectPendingWrites(error);
        rememberError(error);
      }
    });
    child.once('error', (error) => abort(error));
    child.once('close', (code, signal) => {
      if (pendingWrites.size > 0) {
        rejectPendingWrites(
          new Error(
            'Workflow Pack anchored file helper exited before accepting all input',
          ),
        );
      }
      void protocolQueue.finally(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forcedTermination) clearTimeout(forcedTermination);
        if (operationError) {
          reject(operationError);
        } else if (code !== 0 || !ready || !written || !commitSent) {
          reject(
            new Error(
              `Workflow Pack anchored file creation failed: ${stderr.trim() || `helper exited ${String(code)}${signal ? ` (${signal})` : ''}`}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  });
}
