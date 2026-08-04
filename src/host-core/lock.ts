import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  domainSeparatedSha256,
  parseSha256Hash,
} from '../workflow-runtime/contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../workflow-runtime/contracts/strict-json.js';
import type {
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';

interface HostCoreLockOwner {
  readonly format: 'icarus.host-core-lock-owner/1';
  readonly token: string;
  readonly pid: number;
  readonly acquired_at_ms: number;
  readonly process_start_marker: string | null;
  readonly owner_hash: Sha256Hash;
}

export interface HostCoreLockHandle {
  readonly path: string;
  readonly token: string;
  release(): void;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function processStartMarker(pid: number): string | null {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const marker = result.stdout.trim();
  return marker || null;
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  )
    throw new Error('host_core_lock_owner_invalid');
}

function buildOwner(input: {
  token: string;
  pid: number;
  acquiredAtMs: number;
  processStartMarker: string | null;
}): HostCoreLockOwner {
  const payload = {
    format: 'icarus.host-core-lock-owner/1' as const,
    token: input.token,
    pid: input.pid,
    acquired_at_ms: input.acquiredAtMs,
    process_start_marker: input.processStartMarker,
  };
  return {
    ...payload,
    owner_hash: domainSeparatedSha256(
      'icarus:host-core-lock-owner:1\n',
      payload as unknown as JsonValue,
    ),
  };
}

function parseOwner(bytes: Uint8Array): HostCoreLockOwner {
  const value = strictParseJsonBytes(bytes);
  assertJsonObject(value);
  exactKeys(value, [
    'acquired_at_ms',
    'format',
    'owner_hash',
    'pid',
    'process_start_marker',
    'token',
  ]);
  if (
    value.format !== 'icarus.host-core-lock-owner/1' ||
    typeof value.token !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !Number.isSafeInteger(value.acquired_at_ms) ||
    Number(value.acquired_at_ms) < 0 ||
    (value.process_start_marker !== null &&
      typeof value.process_start_marker !== 'string')
  )
    throw new Error('host_core_lock_owner_invalid');
  const owner = buildOwner({
    token: value.token,
    pid: Number(value.pid),
    acquiredAtMs: Number(value.acquired_at_ms),
    processStartMarker: value.process_start_marker,
  });
  if (parseSha256Hash(value.owner_hash) !== owner.owner_hash)
    throw new Error('host_core_lock_owner_hash_invalid');
  return owner;
}

function ownerIsLive(owner: HostCoreLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
  const observedMarker = processStartMarker(owner.pid);
  return (
    owner.process_start_marker === null ||
    observedMarker === null ||
    observedMarker === owner.process_start_marker
  );
}

function readOwner(lockPath: string): HostCoreLockOwner {
  const stat = fs.lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('host_core_lock_file_invalid');
  return parseOwner(fs.readFileSync(lockPath));
}

export function acquireHostCoreLock(options: {
  readonly runtimeHome: string;
  readonly name:
    | '.host-core-release-registry.lock'
    | '.host-core-activation.lock';
  readonly busyError: string;
  readonly now?: () => number;
}): HostCoreLockHandle {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const lockPath = path.join(runtimeHome, options.name);
  const token = crypto.randomBytes(16).toString('hex');
  const owner = buildOwner({
    token,
    pid: process.pid,
    acquiredAtMs: (options.now ?? Date.now)(),
    processStartMarker: processStartMarker(process.pid),
  });
  const candidate = path.join(runtimeHome, `.${options.name}.${token}.owner`);
  const descriptor = fs.openSync(candidate, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.unlinkSync(candidate);
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }

  try {
    for (;;) {
      try {
        fs.linkSync(candidate, lockPath);
        fsyncDirectory(runtimeHome);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const observed = readOwner(lockPath);
        if (ownerIsLive(observed)) throw new Error(options.busyError);
        const stale = path.join(runtimeHome, `.${options.name}.${token}.stale`);
        try {
          fs.renameSync(lockPath, stale);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT')
            continue;
          throw renameError;
        }
        const reclaimed = readOwner(stale);
        if (reclaimed.token !== observed.token)
          throw new Error('host_core_stale_lock_identity_changed');
        fs.unlinkSync(stale);
        fsyncDirectory(runtimeHome);
      }
    }
  } finally {
    fs.unlinkSync(candidate);
  }

  let released = false;
  return {
    path: lockPath,
    token,
    release(): void {
      if (released) return;
      const installed = readOwner(lockPath);
      if (installed.token !== token)
        throw new Error('host_core_lock_ownership_lost');
      fs.unlinkSync(lockPath);
      fsyncDirectory(runtimeHome);
      released = true;
    },
  };
}
