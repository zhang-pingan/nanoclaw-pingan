import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  buildG9ContentAddressedCoreBinding,
  checkInstalledG9ProductionCandidateRelease,
  installG9ProductionCandidateRelease,
} from './release-manifest.js';
import { parseSha256Hash } from '../contracts/hash.js';
import {
  G9_PRODUCTION_CORE_BINDING_OUTPUT,
  G9_PRODUCTION_RELEASE_MANIFEST_OUTPUT,
} from '../contracts/g9-production-activation-types.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const command = process.argv[2];
if (command !== 'generate' && command !== 'check')
  throw new Error('Usage: g9-production-release-cli.ts <generate|check>');

function rawSha256(file: string) {
  return parseSha256Hash(
    `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`,
  );
}

function atomicWrite(file: string, bytes: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, file);
}

const stageRoot = fs.mkdtempSync('/private/tmp/icarus-g9-release-candidate-');
try {
  const runtimeHome = path.join(stageRoot, 'runtime-home');
  const nodeRoot = path.join(runtimeHome, 'toolchains/node');
  fs.mkdirSync(nodeRoot, { recursive: true });
  fs.symlinkSync(
    path.dirname(path.dirname(fs.realpathSync(process.execPath))),
    path.join(nodeRoot, 'active-node'),
  );
  const output = path.join(stageRoot, 'core-production-release-manifest.json');
  const manifest = installG9ProductionCandidateRelease({
    projectRoot,
    runtimeHome,
    manifestOutput: output,
  });
  checkInstalledG9ProductionCandidateRelease(runtimeHome, manifest);
  const binding = buildG9ContentAddressedCoreBinding(
    manifest,
    rawSha256(output),
  );
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const bindingBytes = `${JSON.stringify(binding, null, 2)}\n`;

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const releaseSchema = JSON.parse(
    fs.readFileSync(
      path.join(
        projectRoot,
        'src/workflow-runtime/contracts/production-activation/schemas/core-production-release-manifest-schema.json',
      ),
      'utf8',
    ),
  ) as AnySchema;
  const bindingSchema = JSON.parse(
    fs.readFileSync(
      path.join(
        projectRoot,
        'src/workflow-runtime/contracts/production-activation/schemas/core-runtime-launch-binding-v3-schema.json',
      ),
      'utf8',
    ),
  ) as AnySchema;
  if (!ajv.compile(releaseSchema)(manifest))
    throw new Error('Generated G9 Production Release Manifest failed schema');
  if (!ajv.compile(bindingSchema)(binding))
    throw new Error('Generated G9 Core binding failed schema');

  for (const [relative, bytes] of [
    [G9_PRODUCTION_RELEASE_MANIFEST_OUTPUT, manifestBytes],
    [G9_PRODUCTION_CORE_BINDING_OUTPUT, bindingBytes],
  ] as const) {
    const file = path.join(projectRoot, relative);
    if (command === 'generate') atomicWrite(file, bytes);
    else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== bytes)
      throw new Error(`G9 Production Release candidate drifted: ${relative}`);
  }

  console.log(`g9_production_release=${command}:ok`);
  console.log(`release_artifact_hash=${manifest.release_artifact_hash}`);
  console.log(`core_build_hash=${manifest.core_build_hash}`);
  console.log(`core_binding_hash=${binding.binding_hash}`);
  console.log(`activation_entry_sha256=${manifest.activation_entry_sha256}`);
} finally {
  fs.rmSync(stageRoot, { recursive: true, force: true });
}
