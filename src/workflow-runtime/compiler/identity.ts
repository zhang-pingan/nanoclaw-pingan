import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import {
  STRICT_JSON_PARSER_PACKAGE,
  STRICT_JSON_PARSER_VERSION,
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../contracts/types.js';
import type {
  WorkflowCompilerIdentity,
  WorkflowCompilerToolchainManifest,
} from './types.js';
import { compareAscii } from './normalizer.js';

export const WORKFLOW_COMPILER_VERSION = '3.0.1';
export const CANONICAL_NORMALIZER_VERSION = '2.0.1';
export const PROOF_ALGORITHM_VERSION = '2.0.1';
export const WORKFLOW_COMPILER_TOOLCHAIN_REF = {
  id: 'icarus.workflow-compiler-toolchain',
  version: '3.0.1',
} as const;

const compilerRoot = import.meta.dirname;
const repoRoot = path.resolve(compilerRoot, '../../..');
const NORMALIZER_REFS = [
  'src/workflow-runtime/compiler/normalizer.ts',
] as const;
const PROOF_REFS = ['src/workflow-runtime/compiler/proofs.ts'] as const;
const COMPILER_REFS = [
  'src/workflow-runtime/compiler/compiler.ts',
  'src/workflow-runtime/compiler/identity.ts',
  'src/workflow-runtime/compiler/normalizer.ts',
  'src/workflow-runtime/compiler/proofs.ts',
  'src/workflow-runtime/compiler/schema-profile.ts',
  'src/workflow-runtime/compiler/snapshot.ts',
  'src/workflow-runtime/compiler/types.ts',
] as const;

const COMPILED_IR_SCHEMA_REF =
  'conformance/compiler-contract-repair/schemas/compiled-scope-plan-v2-schema.json';
const RESULT_SCHEMA_REF =
  'conformance/compiler-contract-repair/schemas/compiler-conformance-case-result-schema.json';
const ERROR_CATALOG_REF = {
  id: 'icarus.workflow-compiler-error-catalog',
  version: '2.0.0',
} as const;

function repoBytes(relativePath: string): Buffer {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(
      `Compiler identity path escapes repository: ${relativePath}`,
    );
  }
  return fs.readFileSync(absolutePath);
}

function rawHash(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function artifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      repoBytes(`src/workflow-runtime/contracts/${relativePath}`),
    ),
  );
}

function jsonObject(relativePath: string): JsonObject {
  const value = strictParseJsonBytes(repoBytes(relativePath));
  assertJsonObject(value);
  return value;
}

function sourceSetHash(
  domain: string,
  references: readonly string[],
): Sha256Hash {
  return domainSeparatedSha256(domain, {
    files: references.map((ref) => ({
      ref,
      raw_sha256: rawHash(repoBytes(ref)),
    })),
  });
}

function packageLockEntries(): Array<{
  name: string;
  version: string;
  integrity: string;
}> {
  const lock = strictParseJsonBytes(repoBytes('package-lock.json'));
  if (!lock || Array.isArray(lock) || typeof lock !== 'object') {
    throw new Error('package-lock.json must be an object');
  }
  const packages = lock.packages;
  if (!packages || Array.isArray(packages) || typeof packages !== 'object') {
    throw new Error('package-lock.json packages are missing');
  }
  const required = new Set(['ajv', 'json-canonicalize', 'jsonc-parser']);
  const entries: Array<{ name: string; version: string; integrity: string }> =
    [];
  for (const [packagePath, value] of Object.entries(packages)) {
    if (!packagePath.startsWith('node_modules/')) continue;
    const name = packagePath.slice('node_modules/'.length);
    if (!required.has(name) || !value || Array.isArray(value)) continue;
    assertJsonObject(value);
    if (
      typeof value.version !== 'string' ||
      typeof value.integrity !== 'string'
    ) {
      throw new Error(`Locked Compiler dependency is incomplete: ${name}`);
    }
    entries.push({ name, version: value.version, integrity: value.integrity });
  }
  entries.sort((left, right) => compareAscii(left.name, right.name));
  if (entries.length !== required.size) {
    throw new Error('Compiler dependency lock set is incomplete');
  }
  return entries;
}

export function buildWorkflowCompilerToolchainManifest(): WorkflowCompilerToolchainManifest {
  const managedRuntimeRef =
    'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json';
  const managedRuntime = jsonObject(managedRuntimeRef);
  const graphSchema = artifact('schemas/graph-scope-source-schema.json');
  const definitionSchema = artifact('schemas/workflow-definition-schema.json');
  const irSchema = artifact(COMPILED_IR_SCHEMA_REF);
  const resultSchema = artifact(RESULT_SCHEMA_REF);
  const errorCatalog = artifact(
    'conformance/compiler-semantic-correction/workflow-compiler-error-catalog@2.json',
  );
  const strictParserWrapperRef =
    'src/workflow-runtime/contracts/strict-json.ts';
  const normalizerHash = sourceSetHash(
    'icarus:workflow-compiler-normalizer-build:2\n',
    NORMALIZER_REFS,
  );
  const proofHash = sourceSetHash(
    'icarus:workflow-compiler-proof-build:2\n',
    PROOF_REFS,
  );
  const compilerBuildHash = sourceSetHash(
    'icarus:workflow-production-compiler-build:2\n',
    COMPILER_REFS,
  );
  const schemaProfileHash = domainSeparatedSha256(
    'icarus:workflow-compiler-schema-profile:2\n',
    {
      profile: 'closed-source-and-definition-plus-locked-workflow-schema',
      graph_schema_hash: graphSchema.hash,
      definition_schema_hash: definitionSchema.hash,
      forbidden_schema_keywords: [
        '$dynamicAnchor',
        '$dynamicRef',
        '$recursiveAnchor',
        '$recursiveRef',
        'allOf',
        'anyOf',
        'contains',
        'dependentRequired',
        'dependentSchemas',
        'if',
        'not',
        'oneOf',
        'patternProperties',
        'propertyNames',
        'then',
        'unevaluatedItems',
        'unevaluatedProperties',
      ],
    },
  );
  const withoutHash = {
    format: 'icarus.workflow-compiler-toolchain-manifest/1',
    ref: WORKFLOW_COMPILER_TOOLCHAIN_REF,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    runtime: {
      node_version: String(managedRuntime.node_runtime_version),
      npm_version: String(managedRuntime.npm_version),
      managed_runtime_manifest_ref: 'toolchain/node-v26.5.0-darwin-arm64.json',
      managed_runtime_manifest_hash: managedRuntime.manifest_hash as Sha256Hash,
    },
    package_lock_hash: rawHash(repoBytes('package-lock.json')),
    locked_packages: packageLockEntries(),
    strict_parser: {
      package: STRICT_JSON_PARSER_PACKAGE,
      version: STRICT_JSON_PARSER_VERSION,
      wrapper_ref: strictParserWrapperRef,
      wrapper_hash: rawHash(repoBytes(strictParserWrapperRef)),
    },
    schema_profile: {
      version: '2.0.0',
      graph_schema_ref: 'schemas/graph-scope-source-schema.json',
      graph_schema_hash: graphSchema.hash,
      definition_schema_ref: 'schemas/workflow-definition-schema.json',
      definition_schema_hash: definitionSchema.hash,
      profile_hash: schemaProfileHash,
    },
    canonical_normalizer: {
      version: CANONICAL_NORMALIZER_VERSION,
      implementation_refs: [...NORMALIZER_REFS],
      implementation_hash: normalizerHash,
    },
    proof_algorithm: {
      version: PROOF_ALGORITHM_VERSION,
      implementation_refs: [...PROOF_REFS],
      implementation_hash: proofHash,
    },
    compiler_build: {
      implementation_refs: [...COMPILER_REFS],
      implementation_hash: compilerBuildHash,
    },
    error_catalog_ref: ERROR_CATALOG_REF,
    error_catalog_hash: errorCatalog.hash,
    compiled_ir_schema_ref: COMPILED_IR_SCHEMA_REF,
    compiled_ir_schema_hash: irSchema.hash,
    conformance_result_schema_ref: RESULT_SCHEMA_REF,
    conformance_result_schema_hash: resultSchema.hash,
  } as WorkflowCompilerToolchainManifest;
  return {
    ...withoutHash,
    toolchain_hash: domainSeparatedSha256(
      'icarus:workflow-compiler-toolchain-manifest:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

export function workflowCompilerIdentity(
  manifest = buildWorkflowCompilerToolchainManifest(),
): WorkflowCompilerIdentity {
  return {
    compiler_toolchain_manifest_ref: manifest.ref,
    compiler_toolchain_hash: manifest.toolchain_hash,
    compiler_version: manifest.compiler_version,
    compiler_build_hash: manifest.compiler_build.implementation_hash,
    canonical_normalizer_version: manifest.canonical_normalizer.version,
    canonical_normalizer_hash:
      manifest.canonical_normalizer.implementation_hash,
    proof_algorithm_version: manifest.proof_algorithm.version,
    proof_algorithm_hash: manifest.proof_algorithm.implementation_hash,
    error_catalog_ref: manifest.error_catalog_ref,
    error_catalog_hash: manifest.error_catalog_hash,
    compiled_ir_schema_ref: manifest.compiled_ir_schema_ref,
    compiled_ir_schema_hash: manifest.compiled_ir_schema_hash,
    conformance_result_schema_ref: manifest.conformance_result_schema_ref,
    conformance_result_schema_hash: manifest.conformance_result_schema_hash,
  };
}
