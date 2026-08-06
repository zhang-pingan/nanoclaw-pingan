import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  HOST_CORE_SNAPSHOT_DIRECTORY,
  type HostCoreSnapshotManifest,
  assertHostCoreSnapshotId,
  findHostCoreSnapshotByLabel,
  verifyHostCoreSnapshot,
} from './release.js';

function lstatIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function pointerTarget(snapshotId: string): string {
  return `${HOST_CORE_SNAPSHOT_DIRECTORY}/${assertHostCoreSnapshotId(snapshotId)}`;
}

function replacePointer(runtimeHome: string, target: string | null): void {
  const pointer = path.join(runtimeHome, 'active-core');
  if (target === null) {
    fs.rmSync(pointer, { force: true });
    return;
  }
  const temporary = path.join(
    runtimeHome,
    `.active-core.${String(process.pid)}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    fs.symlinkSync(target, temporary);
    fs.renameSync(temporary, pointer);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export interface ActiveHostCoreSnapshot {
  readonly snapshot_id: string;
  readonly snapshot_root: string;
  readonly core_entry_path: string;
  readonly manifest: HostCoreSnapshotManifest;
}

export function verifyActiveHostCore(
  runtimeHomeInput: string,
): ActiveHostCoreSnapshot {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const pointer = path.join(runtimeHome, 'active-core');
  const stat = fs.lstatSync(pointer);
  if (!stat.isSymbolicLink()) throw new Error('active_core_pointer_invalid');
  const relative = fs.readlinkSync(pointer);
  const match = /^host-core-snapshots\/([^/]+)$/.exec(relative);
  if (!match) throw new Error('active_core_pointer_invalid');
  const snapshotId = assertHostCoreSnapshotId(match[1]);
  const manifest = verifyHostCoreSnapshot(runtimeHome, snapshotId);
  const snapshotRoot = fs.realpathSync(pointer);
  const expectedRoot = fs.realpathSync(
    path.join(runtimeHome, HOST_CORE_SNAPSHOT_DIRECTORY, snapshotId),
  );
  if (snapshotRoot !== expectedRoot)
    throw new Error('active_core_pointer_invalid');
  return {
    snapshot_id: snapshotId,
    snapshot_root: snapshotRoot,
    core_entry_path: path.join(snapshotRoot, manifest.entry_relative_path),
    manifest,
  };
}

export function selectHostCoreSnapshot(options: {
  readonly runtimeHome: string;
  readonly snapshotId: string;
  readonly afterSwitch?: () => void;
}): ActiveHostCoreSnapshot {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const snapshotId = assertHostCoreSnapshotId(options.snapshotId);
  verifyHostCoreSnapshot(runtimeHome, snapshotId);
  const pointer = path.join(runtimeHome, 'active-core');
  const pointerStat = lstatIfPresent(pointer);
  if (pointerStat && !pointerStat.isSymbolicLink())
    throw new Error('active_core_pointer_invalid');
  const previous = pointerStat ? fs.readlinkSync(pointer) : null;
  replacePointer(runtimeHome, pointerTarget(snapshotId));
  try {
    options.afterSwitch?.();
    const active = verifyActiveHostCore(runtimeHome);
    if (active.snapshot_id !== snapshotId)
      throw new Error('active_core_post_switch_mismatch');
    return active;
  } catch (error) {
    replacePointer(runtimeHome, previous);
    throw error;
  }
}

// One-cycle compatibility alias. New callers should use selectHostCoreSnapshot.
export function activateHostCoreRelease(options: {
  readonly runtimeHome: string;
  readonly version: string;
  readonly skipValidation?: boolean;
  readonly confirm: (
    current: ActiveHostCoreSnapshot | null,
    target: HostCoreSnapshotManifest,
  ) => boolean;
}): ActiveHostCoreSnapshot {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const target = findHostCoreSnapshotByLabel(runtimeHome, options.version);
  const current = lstatIfPresent(path.join(runtimeHome, 'active-core'))
    ? verifyActiveHostCore(runtimeHome)
    : null;
  if (!options.confirm(current, target))
    throw new Error('host_core_activation_cancelled');
  return selectHostCoreSnapshot({
    runtimeHome,
    snapshotId: target.snapshot_id,
  });
}
