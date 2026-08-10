import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const supportedPlatforms = new Set(['darwin', 'linux']);
const supportedArchitectures = new Set(['arm64', 'x64']);
const target = `${process.platform}-${process.arch}`;
const binaryName = 'icarus-openat-helper';
const manifestName = 'manifest.json';
const sourcePath = path.join(projectRoot, 'native', 'anchored-file-helper.c');
const buildDirectory = path.join(projectRoot, 'build', 'native', target);
const buildBinary = path.join(buildDirectory, binaryName);
const buildManifest = path.join(buildDirectory, manifestName);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertSupportedTarget() {
  if (
    !supportedPlatforms.has(process.platform) ||
    !supportedArchitectures.has(process.arch)
  ) {
    throw new Error(
      `Workflow Pack anchored file helper does not support ${target}; supported targets are darwin/linux on arm64/x64`,
    );
  }
}

function readAndValidateBuildManifest() {
  const manifest = JSON.parse(fs.readFileSync(buildManifest, 'utf8'));
  if (
    manifest.formatVersion !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.binary !== binaryName ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256)
  ) {
    throw new Error('Workflow Pack anchored file helper manifest is invalid');
  }
  const stat = fs.lstatSync(buildBinary);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Workflow Pack anchored file helper is not a regular file');
  }
  if (sha256(buildBinary) !== manifest.sha256) {
    throw new Error('Workflow Pack anchored file helper hash mismatch');
  }
  return manifest;
}

function buildHelper() {
  assertSupportedTarget();
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('Workflow Pack anchored file helper source is invalid');
  }
  fs.mkdirSync(buildDirectory, { recursive: true });
  const temporaryBinary = path.join(
    buildDirectory,
    `.${binaryName}-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  const compiler = process.env.CC || 'cc';
  const result = spawnSync(
    compiler,
    [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      sourcePath,
      '-o',
      temporaryBinary,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    fs.rmSync(temporaryBinary, { force: true });
    throw new Error(
      `Workflow Pack anchored file helper build failed: ${result.stderr || result.error?.message || `compiler exited ${String(result.status)}`}`,
    );
  }
  fs.chmodSync(temporaryBinary, 0o755);
  fs.renameSync(temporaryBinary, buildBinary);
  const manifest = {
    formatVersion: 1,
    platform: process.platform,
    arch: process.arch,
    binary: binaryName,
    sha256: sha256(buildBinary),
  };
  const temporaryManifest = `${buildManifest}.${process.pid}-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  fs.renameSync(temporaryManifest, buildManifest);
}

function copyHelperToDist(outputRootInput) {
  assertSupportedTarget();
  const manifest = readAndValidateBuildManifest();
  const outputRoot = path.resolve(
    outputRootInput || path.join(projectRoot, 'dist'),
  );
  const outputStat = fs.lstatSync(outputRoot);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error(
      'Workflow Pack anchored file helper output root must be a regular directory',
    );
  }
  const destination = path.join(
    outputRoot,
    'workflow-packs',
    'native',
    target,
  );
  fs.mkdirSync(destination, { recursive: true });
  const destinationBinary = path.join(destination, binaryName);
  const destinationManifest = path.join(destination, manifestName);
  fs.copyFileSync(buildBinary, destinationBinary);
  fs.chmodSync(destinationBinary, 0o755);
  if (sha256(destinationBinary) !== manifest.sha256) {
    throw new Error('Copied Workflow Pack anchored file helper hash mismatch');
  }
  fs.writeFileSync(
    destinationManifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
}

const mode = process.argv[2] || 'build';
if (mode === 'build') buildHelper();
else if (mode === '--copy-dist') copyHelperToDist(process.argv[3]);
else throw new Error(`Unknown anchored file helper build mode: ${mode}`);
