import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseContractArtifactEnvelope } from './artifact.js';
import { domainSeparatedSha256, parseSha256Hash } from './hash.js';
import type {
  G8FoundationContractArtifact,
  G8MinimumMachineClassPayload,
  G8StartupSmokeHarnessPayload,
} from './g8-certification-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export const G8_MINIMUM_MACHINE_CLASS_PATH =
  'src/workflow-runtime/contracts/certification/minimum-machine-class@1.json';
export const G8_STARTUP_SMOKE_HARNESS_PATH =
  'src/workflow-runtime/contracts/certification/startup-smoke-harness@1.json';

const minimumMachineSources = [
  'src/workflow-runtime/certification/machine-class.ts',
  'src/workflow-runtime/contracts/g8-foundation-contracts.ts',
] as const;
const startupSmokeSources = [
  'src/workflow-runtime/certification/machine-class.ts',
  'src/workflow-runtime/certification/release-entry.ts',
  'src/workflow-runtime/certification/startup-smoke.ts',
  'src/workflow-runtime/contracts/g8-foundation-contracts.ts',
  'src/workflow-runtime/store/runtime-store/identity.ts',
  'src/workflow-runtime/store/runtime-store/index.ts',
  'src/workflow-runtime/store/runtime-store/profile.ts',
] as const;

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function sourceTreeHash(
  projectRoot: string,
  domain: string,
  sourcePaths: readonly string[],
): Sha256Hash {
  const entries = [...sourcePaths].sort().map((sourcePath) => ({
    path: sourcePath,
    raw_sha256: rawSha256(path.join(projectRoot, sourcePath)),
  }));
  return domainSeparatedSha256(domain, entries);
}

function artifact<TPayload extends JsonObject>(
  format: G8FoundationContractArtifact['format'],
  ref: { id: string; version: string },
  domainSeparator: string,
  payload: TPayload,
): G8FoundationContractArtifact<TPayload> {
  const withoutHash = {
    format,
    ref,
    version: 1,
    domain_separator: domainSeparator,
    payload,
  } as const;
  return {
    ...withoutHash,
    hash: domainSeparatedSha256(
      domainSeparator,
      withoutHash as unknown as JsonValue,
    ),
  };
}

export interface G8FoundationArtifacts {
  readonly minimumMachineClass: G8FoundationContractArtifact<G8MinimumMachineClassPayload>;
  readonly startupSmokeHarness: G8FoundationContractArtifact<G8StartupSmokeHarnessPayload>;
}

export function createG8FoundationArtifacts(
  projectRoot: string,
): G8FoundationArtifacts {
  const minimumMachinePayload: G8MinimumMachineClassPayload = {
    class_id: 'local_single_user_minimum_machine@1',
    deployment_profile: 'local_single_user',
    platform: 'darwin',
    arch: 'arm64',
    cpu_family: 'apple_silicon',
    minimum_cpu_generation: 2,
    minimum_memory_bytes: 17179869184,
    filesystem_type: 'apfs',
    storage_class: 'internal_ssd',
    startup_power_source: 'any',
    certification_power_source: 'ac_power',
    certification_interference: 'none_operator_confirmed',
    observation_source_tree_hash: sourceTreeHash(
      projectRoot,
      'icarus:minimum-machine-observation-source-tree:1\n',
      minimumMachineSources,
    ),
  };
  const minimumMachineClass = artifact(
    'icarus.minimum-machine-class/1',
    { id: 'local_single_user_minimum_machine', version: '1.0.0' },
    'icarus:minimum-machine-class:1\n',
    minimumMachinePayload,
  );
  const startupSmokePayload: G8StartupSmokeHarnessPayload = {
    harness_id: 'local_single_user_startup_smoke@1',
    deployment_profile: 'local_single_user',
    runtime_surface: 'node_service',
    identity_mode: 'certification_observation',
    database_schema_version: 11,
    database_kind: 'isolated_temporary_real_file',
    database_filename: 'workflow-runtime.db',
    connection_profile: 'production_pragmas',
    transaction_kind: 'begin_immediate',
    transaction_probe: 'zero_row_parameterized_dml',
    reopen_required: true,
    integrity_check_required: true,
    startup_smoke_max_duration_ms: 5000,
    implementation_source_tree_hash: sourceTreeHash(
      projectRoot,
      'icarus:startup-smoke-implementation-source-tree:1\n',
      startupSmokeSources,
    ),
  };
  const startupSmokeHarness = artifact(
    'icarus.startup-smoke-harness/1',
    { id: 'local_single_user_startup_smoke', version: '1.0.0' },
    'icarus:startup-smoke-harness:1\n',
    startupSmokePayload,
  );
  return { minimumMachineClass, startupSmokeHarness };
}

function exactKeys(value: object, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} has an unknown, duplicate, or missing field`);
  }
}

function readArtifact<TPayload extends JsonObject>(
  filePath: string,
  expectedFormat: G8FoundationContractArtifact['format'],
  expectedRef: { id: string; version: string },
  expectedDomain: string,
  payloadKeys: readonly string[],
): G8FoundationContractArtifact<TPayload> {
  const artifactValue = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(filePath)),
  );
  exactKeys(artifactValue.payload, payloadKeys, expectedFormat);
  if (
    artifactValue.format !== expectedFormat ||
    artifactValue.ref.id !== expectedRef.id ||
    artifactValue.ref.version !== expectedRef.version ||
    artifactValue.version !== 1 ||
    artifactValue.domain_separator !== expectedDomain
  ) {
    throw new Error(`${expectedFormat} fixed identity drifted`);
  }
  parseSha256Hash(artifactValue.hash);
  return artifactValue as unknown as G8FoundationContractArtifact<TPayload>;
}

export function loadG8FoundationArtifacts(
  contractsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'certification',
  ),
): G8FoundationArtifacts {
  const minimumMachineClass = readArtifact<G8MinimumMachineClassPayload>(
    path.join(contractsRoot, 'minimum-machine-class@1.json'),
    'icarus.minimum-machine-class/1',
    { id: 'local_single_user_minimum_machine', version: '1.0.0' },
    'icarus:minimum-machine-class:1\n',
    [
      'class_id',
      'deployment_profile',
      'platform',
      'arch',
      'cpu_family',
      'minimum_cpu_generation',
      'minimum_memory_bytes',
      'filesystem_type',
      'storage_class',
      'startup_power_source',
      'certification_power_source',
      'certification_interference',
      'observation_source_tree_hash',
    ],
  );
  const startupSmokeHarness = readArtifact<G8StartupSmokeHarnessPayload>(
    path.join(contractsRoot, 'startup-smoke-harness@1.json'),
    'icarus.startup-smoke-harness/1',
    { id: 'local_single_user_startup_smoke', version: '1.0.0' },
    'icarus:startup-smoke-harness:1\n',
    [
      'harness_id',
      'deployment_profile',
      'runtime_surface',
      'identity_mode',
      'database_schema_version',
      'database_kind',
      'database_filename',
      'connection_profile',
      'transaction_kind',
      'transaction_probe',
      'reopen_required',
      'integrity_check_required',
      'startup_smoke_max_duration_ms',
      'implementation_source_tree_hash',
    ],
  );
  return { minimumMachineClass, startupSmokeHarness };
}
