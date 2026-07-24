import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  buildCapacityControlPlaneExpectedArtifactsForTest,
  CAPACITY_CONTROL_PLANE_MANIFEST_PATH,
  checkHistoricalG0_9Conformance,
} from './capacity-control-plane-pack.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject, JsonValue } from './types.js';

const contractsRoot = import.meta.dirname;

function fail(message: string): never {
  throw new Error(`current Capacity compatibility check: ${message}`);
}

function bytes(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`))
    fail(`path escapes contracts root: ${relativePath}`);
  return resolved;
}

function checkCurrentCapacityCompatibility(): JsonObject {
  checkHistoricalG0_9Conformance();
  const artifacts = buildCapacityControlPlaneExpectedArtifactsForTest();
  for (const [relativePath, expected] of artifacts) {
    parseContractArtifactEnvelope(expected);
    const actual = fs.readFileSync(absolute(relativePath), 'utf8');
    if (actual !== bytes(expected)) fail(`${relativePath} byte drift`);
  }
  const manifest = strictParseJsonBytes(
    fs.readFileSync(absolute(CAPACITY_CONTROL_PLANE_MANIFEST_PATH)),
  ) as JsonObject;
  parseContractArtifactEnvelope(manifest);
  const members = (manifest.payload as JsonObject).artifacts;
  if (!Array.isArray(members)) fail('manifest artifacts are missing');
  const expectedMembers = new Map(
    artifacts.map(([relativePath, artifact]) => [relativePath, artifact.hash]),
  );
  if (
    members.length !== expectedMembers.size ||
    members.some((member) => {
      if (!member || typeof member !== 'object' || Array.isArray(member))
        return true;
      const value = member as JsonObject;
      return expectedMembers.get(String(value.path)) !== value.hash;
    })
  )
    fail('manifest member identity drift');
  const sealedRoot = absolute('conformance/sealed');
  const sealed = fs.readdirSync(sealedRoot).sort();
  const allowed = [
    '.gitkeep',
    'g2-capability-outbox-binding-v3',
    'g2-generated-schema-join-authority-v4',
    'g2-production-compiler-replay-repair-v2',
    'g2-semantic-correction',
  ].sort();
  if (JSON.stringify(sealed) !== JSON.stringify(allowed))
    fail(`unexpected current sealed tree: ${sealed.join(', ')}`);
  for (const entry of sealed) {
    const stat = fs.lstatSync(path.join(sealedRoot, entry));
    if (stat.isSymbolicLink()) fail(`sealed entry is a symlink: ${entry}`);
  }
  return manifest;
}

function generateCurrentCapacityCompatibility(): JsonObject {
  const artifacts = buildCapacityControlPlaneExpectedArtifactsForTest();
  for (const [relativePath, expected] of artifacts) {
    const target = absolute(relativePath);
    const temporary = `${target}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, bytes(expected), { encoding: 'utf8' });
    fs.renameSync(temporary, target);
  }
  return checkCurrentCapacityCompatibility();
}

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: capacity-control-plane-current <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateCurrentCapacityCompatibility()
      : checkCurrentCapacityCompatibility();
  console.log(`capacity_control_plane_current=${command}:ok`);
  console.log(`capacity_control_plane_hash=${String(manifest.hash)}`);
} catch (error) {
  console.error(
    `capacity_control_plane_current=check:failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
