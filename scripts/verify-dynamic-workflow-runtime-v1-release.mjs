import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const generatedRoot = path.join(
  repositoryRoot,
  'src/workflow-runtime/contracts/certification/production-candidate/generated',
);
const manifestPath = path.join(
  generatedRoot,
  'core-production-release-manifest@1.json',
);
const bindingPath = path.join(
  generatedRoot,
  'core-runtime-launch-binding-v3@1.json',
);
const archivePath = path.join(
  repositoryRoot,
  'src/workflow-runtime/contracts/certification/accepted-release-v1',
  'accepted-release-3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279.bundle.gz',
);
const archiveMagic = Buffer.from(
  'ICARUS_ACCEPTED_RELEASE_ARCHIVE_V1\0',
  'ascii',
);

const expected = Object.freeze({
  manifestRaw:
    'sha256:b26fb66d84afdea65f4926afa7fddc9c61c25d52158ae36137299ae26b96d6ea',
  bindingRaw:
    'sha256:e16b357c43ca0fd49aa2a9a7e6bbc6f23425f79adafcf75a8144cc42482e6ba7',
  release:
    'sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279',
  core: 'sha256:9b64c44d5491c214d8ad22080a72459d5babc9fa44f0cc4c1b3585c0cff07d57',
  inventory:
    'sha256:765cd6d00c26cf8fc627c6f081354ae346f26b79f5ad6c50b69721370acc11cd',
  binding:
    'sha256:9a191dca528d4cefa6545ca2a1311429b76c68efcea3d7db85f31da65d364dd6',
  activationEntry:
    'sha256:d7e9ef78935eec45d42855fc6e39142d9f133c364c0d85adb1ec568d6860ed2a',
  capacityBundle:
    'sha256:dec8fc5e9ebeec0b8d6033728d5131adb2009c32c48556242c8ac8fbb4b2fb33',
  releasePackage:
    'sha256:3670c0a7545c1b742c223d22672d13742517de8f9acfd231518b10aa7f7c2608',
  archiveRaw:
    'sha256:af1bca86bd359d30284ae02cc3f92da7ba1bc7e69fb210a9fed7d491978db43d',
  archiveByteLength: 27_509_298,
});

function fail(message) {
  throw new Error(`workflow_runtime_v1_release_invalid: ${message}`);
}

function rawSha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readExactJson(file, expectedHash) {
  const bytes = fs.readFileSync(file);
  const actual = rawSha256(bytes);
  if (actual !== expectedHash)
    fail(`${path.basename(file)} raw hash ${actual}`);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    fail(`${path.basename(file)} is not strict JSON: ${error.message}`);
  }
}

function safeMemberPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`unsafe inventory member path: ${String(value)}`);
  }
  return value;
}

const { bytes: manifestBytes, value: manifest } = readExactJson(
  manifestPath,
  expected.manifestRaw,
);
const { value: binding } = readExactJson(bindingPath, expected.bindingRaw);

if (
  manifest.format !== 'icarus.core-production-release-manifest/1' ||
  manifest.release_artifact_hash !== expected.release ||
  manifest.core_build_hash !== expected.core ||
  manifest.inventory_hash !== expected.inventory ||
  manifest.activation_entry_sha256 !== expected.activationEntry ||
  manifest.capacity_genesis_bootstrap_bundle_hash !== expected.capacityBundle ||
  !Array.isArray(manifest.inventory) ||
  manifest.inventory.length !== 9094
) {
  fail('manifest identity fields drifted');
}

const inventoryPaths = new Set();
let previousPath = '';
for (const member of manifest.inventory) {
  const memberPath = safeMemberPath(member.path);
  if (
    inventoryPaths.has(memberPath) ||
    memberPath <= previousPath ||
    !Number.isSafeInteger(member.byte_length) ||
    member.byte_length < 0 ||
    typeof member.executable !== 'boolean' ||
    !/^sha256:[0-9a-f]{64}$/.test(member.raw_sha256)
  ) {
    fail(`invalid or unordered manifest inventory member: ${memberPath}`);
  }
  inventoryPaths.add(memberPath);
  previousPath = memberPath;
}

const distCount = manifest.inventory.filter(({ path: memberPath }) =>
  memberPath.startsWith('dist/'),
).length;
const releasePackage = manifest.inventory.find(
  ({ path: memberPath }) => memberPath === 'package.json',
);
if (
  distCount !== 4701 ||
  releasePackage?.raw_sha256 !== expected.releasePackage ||
  manifest.inventory.some(({ path: memberPath }) =>
    memberPath.startsWith('docs/archive/'),
  )
) {
  fail('accepted inventory members drifted');
}

if (
  binding.format !== 'icarus.core-runtime-launch-binding/3' ||
  binding.binding_kind !== 'content_addressed_production_release' ||
  binding.release_manifest_sha256 !== expected.manifestRaw ||
  binding.release_artifact_hash !== expected.release ||
  binding.core_build_hash !== expected.core ||
  binding.activation_entry_sha256 !== expected.activationEntry ||
  binding.binding_hash !== expected.binding
) {
  fail('v3 binding identity fields drifted');
}

const archiveStat = fs.lstatSync(archivePath);
if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
  fail('accepted physical release archive is not a regular file');
}
const archiveBytes = fs.readFileSync(archivePath);
if (
  archiveBytes.length !== expected.archiveByteLength ||
  rawSha256(archiveBytes) !== expected.archiveRaw
) {
  fail('accepted physical release archive identity drifted');
}

let physicalBytes;
try {
  physicalBytes = gunzipSync(archiveBytes, {
    maxOutputLength: 256 * 1024 * 1024,
  });
} catch (error) {
  fail(`accepted physical release archive cannot be decoded: ${error.message}`);
}

let cursor = 0;
function readBytes(length, label) {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    cursor + length > physicalBytes.length
  ) {
    fail(`truncated physical release archive at ${label}`);
  }
  const bytes = physicalBytes.subarray(cursor, cursor + length);
  cursor += length;
  return bytes;
}
function readUInt32(label) {
  return readBytes(4, label).readUInt32BE(0);
}
function readUInt16(label) {
  return readBytes(2, label).readUInt16BE(0);
}
function readUInt64(label) {
  const value = readBytes(8, label).readBigUInt64BE(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail(`physical release member is too large at ${label}`);
  return Number(value);
}

if (!readBytes(archiveMagic.length, 'magic').equals(archiveMagic)) {
  fail('physical release archive format drifted');
}
const expectedRecords = [
  {
    path: 'core-production-release-manifest.json',
    byte_length: manifestBytes.length,
    executable: false,
    raw_sha256: expected.manifestRaw,
  },
  ...manifest.inventory,
];
const recordCount = readUInt32('record count');
if (recordCount !== expectedRecords.length) {
  fail(`physical release record count ${recordCount}`);
}

let verifiedByteLength = 0;
let executableMemberCount = 0;
for (let index = 0; index < expectedRecords.length; index += 1) {
  const expectedRecord = expectedRecords[index];
  const pathLength = readUInt32(`record ${index} path length`);
  const mode = readUInt16(`record ${index} mode`);
  const byteLength = readUInt64(`record ${index} byte length`);
  const memberPathBytes = readBytes(pathLength, `record ${index} path`);
  const memberPath = memberPathBytes.toString('utf8');
  if (
    !Buffer.from(memberPath, 'utf8').equals(memberPathBytes) ||
    safeMemberPath(memberPath) !== expectedRecord.path
  ) {
    fail(`physical release path mismatch at record ${index}`);
  }
  const expectedMode = expectedRecord.executable ? 0o755 : 0o644;
  if (mode !== expectedMode || byteLength !== expectedRecord.byte_length) {
    fail(`physical release size/mode mismatch: ${memberPath}`);
  }
  const memberBytes = readBytes(byteLength, memberPath);
  if (rawSha256(memberBytes) !== expectedRecord.raw_sha256) {
    fail(`physical release member hash mismatch: ${memberPath}`);
  }
  verifiedByteLength += byteLength;
  if (expectedRecord.executable) executableMemberCount += 1;
}
if (cursor !== physicalBytes.length) {
  fail('physical release archive has trailing bytes');
}

process.stdout.write(
  `${JSON.stringify(
    {
      workflow_runtime_v1_release: 'check:ok',
      release_artifact_hash: expected.release,
      release_manifest_raw_hash: expected.manifestRaw,
      core_build_hash: expected.core,
      binding_hash: expected.binding,
      binding_raw_hash: expected.bindingRaw,
      inventory_count: manifest.inventory.length,
      dist_member_count: distCount,
      physical_archive_raw_hash: expected.archiveRaw,
      physical_record_count: recordCount,
      physical_inventory_verified_count: recordCount - 1,
      physical_executable_member_count: executableMemberCount,
      physical_verified_byte_length: verifiedByteLength,
      physical_mismatch_count: 0,
    },
    null,
    2,
  )}\n`,
);
