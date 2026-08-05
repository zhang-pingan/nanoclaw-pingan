import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseSha256Hash } from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { Sha256Hash, VersionedRef } from '../contracts/types.js';
import { parseVersionedRef } from '../contracts/versioned-ref.js';

interface LegacyReleaseInventoryEntry {
  readonly path: string;
  readonly byte_length: number;
  readonly executable: boolean;
  readonly raw_sha256: Sha256Hash;
}

export interface LegacyCoreReleaseManifest {
  readonly format: 'icarus.core-release-manifest/1';
  readonly ref: VersionedRef;
  readonly database_schema_version: number;
  readonly database_schema_hash: Sha256Hash;
  readonly managed_node_distribution_hash: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly runtime_toolchain_hash: Sha256Hash;
  readonly core_entry_relative_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_relative_path: string;
  readonly validation_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly inventory: LegacyReleaseInventoryEntry[];
  readonly release_artifact_hash: Sha256Hash;
}

function rawSha256(file: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function safeRelative(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error(`${label} is not a safe relative path`);
  return value;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  )
    throw new Error(`${label} has unknown or missing fields`);
}

function parseInventory(value: unknown): LegacyReleaseInventoryEntry[] {
  if (!Array.isArray(value))
    throw new Error('Legacy release inventory invalid');
  const entries = value.map((candidate, index) => {
    assertJsonObject(candidate);
    exactKeys(
      candidate,
      ['byte_length', 'executable', 'path', 'raw_sha256'],
      `Legacy release inventory[${index}]`,
    );
    if (
      !Number.isSafeInteger(candidate.byte_length) ||
      Number(candidate.byte_length) < 0 ||
      typeof candidate.executable !== 'boolean'
    )
      throw new Error(`Legacy release inventory[${index}] metadata invalid`);
    return {
      path: safeRelative(
        candidate.path,
        `Legacy release inventory[${index}].path`,
      ),
      byte_length: Number(candidate.byte_length),
      executable: candidate.executable,
      raw_sha256: parseSha256Hash(candidate.raw_sha256),
    };
  });
  if (
    entries.some(
      (entry, index) =>
        entry.path === 'core-release-manifest.json' ||
        (index > 0 && entries[index - 1]!.path >= entry.path),
    )
  )
    throw new Error('Legacy release inventory paths are not unique and sorted');
  return entries;
}

function parseLegacyManifest(value: unknown): LegacyCoreReleaseManifest {
  assertJsonObject(value);
  const ref = parseVersionedRef(value.ref);
  if (
    value.format !== 'icarus.core-release-manifest/1' ||
    !Number.isSafeInteger(value.database_schema_version)
  )
    throw new Error('Legacy Core release manifest is invalid');
  return {
    format: value.format,
    ref,
    database_schema_version: Number(value.database_schema_version),
    database_schema_hash: parseSha256Hash(value.database_schema_hash),
    managed_node_distribution_hash: parseSha256Hash(
      value.managed_node_distribution_hash,
    ),
    runtime_launcher_hash: parseSha256Hash(value.runtime_launcher_hash),
    runtime_toolchain_hash: parseSha256Hash(value.runtime_toolchain_hash),
    core_entry_relative_path: safeRelative(
      value.core_entry_relative_path,
      'Legacy Core entry',
    ),
    core_entry_sha256: parseSha256Hash(value.core_entry_sha256),
    validation_entry_relative_path: safeRelative(
      value.validation_entry_relative_path,
      'Legacy validation entry',
    ),
    validation_entry_sha256: parseSha256Hash(value.validation_entry_sha256),
    core_build_hash: parseSha256Hash(value.core_build_hash),
    inventory: parseInventory(value.inventory),
    release_artifact_hash: parseSha256Hash(value.release_artifact_hash),
  };
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Legacy Core release path escapes its root');
}

export function readInstalledG8CoreReleaseManifest(
  runtimeHomeInput: string,
  releaseArtifactHashInput: string,
): LegacyCoreReleaseManifest {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const releaseArtifactHash = parseSha256Hash(releaseArtifactHashInput);
  const releaseRoot = fs.realpathSync(
    path.join(
      runtimeHome,
      'core-releases',
      releaseArtifactHash.slice('sha256:'.length),
    ),
  );
  assertInside(path.join(runtimeHome, 'core-releases'), releaseRoot);
  const manifest = parseLegacyManifest(
    strictParseJsonBytes(
      fs.readFileSync(path.join(releaseRoot, 'core-release-manifest.json')),
    ),
  );
  if (manifest.release_artifact_hash !== releaseArtifactHash)
    throw new Error('Legacy Core release selection mismatch');
  for (const entry of manifest.inventory) {
    const file = path.join(releaseRoot, entry.path);
    assertInside(releaseRoot, file);
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== entry.byte_length ||
      rawSha256(file) !== entry.raw_sha256
    )
      throw new Error(`Legacy Core release file mismatch: ${entry.path}`);
  }
  return manifest;
}
