import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
  return JSON.parse(bytes.toString('utf8'));
}

const manifest = readExactJson(manifestPath, expected.manifestRaw);
const binding = readExactJson(bindingPath, expected.bindingRaw);

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
    },
    null,
    2,
  )}\n`,
);
