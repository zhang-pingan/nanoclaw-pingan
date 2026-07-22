import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import { checkHistoricalCompilerContractRepair } from '../contracts/compiler-contract-repair-historical.js';
import { assertCurrentG2SealedBoundary } from '../contracts/current-g2-sealed-boundary.js';
import { calculateArtifactHash } from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../contracts/types.js';
import {
  buildG2Candidates,
  G2_BINDING_PATH,
  G2_CANDIDATE_ROOT,
  G2_RESULTS_MANIFEST_PATH,
  G2_ROOT_MANIFEST_PATH,
  G2_TOOLCHAIN_PATH,
  renderCompilerJson,
} from './conformance.js';
import { compareAscii } from './normalizer.js';

const compilerRoot = import.meta.dirname;
const contractsRoot = path.resolve(compilerRoot, '../contracts');
const workflowRuntimeRoot = path.resolve(compilerRoot, '..');
export const G2_PRODUCTION_COMPILER_ROOT_DOMAIN =
  'icarus:workflow-contract-pack-g2-production-compiler:1\n';

function absoluteContractPath(relativePath: string): string {
  const absolutePath = path.resolve(contractsRoot, relativePath);
  if (!absolutePath.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`G2 artifact path escapes contracts root: ${relativePath}`);
  }
  return absolutePath;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absoluteContractPath(relativePath))),
  );
}

function schemaPayload(relativePath: string): AnySchema {
  return readArtifact(relativePath).payload as AnySchema;
}

function renderArtifact(artifact: ContractArtifactEnvelope): string {
  return renderCompilerJson(artifact);
}

function actualRawHash(contents: string): Sha256Hash {
  return `sha256:${crypto
    .createHash('sha256')
    .update(contents, 'utf8')
    .digest('hex')}`;
}

function buildRootManifest(
  files: Map<string, string>,
  toolchainHash: Sha256Hash,
  bindingHash: Sha256Hash,
  resultsManifestHash: Sha256Hash,
  compilerBuildHash: Sha256Hash,
): ContractArtifactEnvelope {
  const payload: JsonObject = {
    gate: 'G2',
    status: 'IMPLEMENTED',
    scope: 'production_compiler_vertical_slice_and_exact_case_input_identity',
    production_compiler_status: 'implemented',
    compiled_ir_format: 'icarus.workflow-graph-scope-plan/2',
    compiler_build_hash: compilerBuildHash,
    compiler_toolchain_ref: G2_TOOLCHAIN_PATH,
    compiler_toolchain_hash: toolchainHash,
    exact_case_input_binding_ref: G2_BINDING_PATH,
    exact_case_input_binding_hash: bindingHash,
    candidate_results_manifest_ref: G2_RESULTS_MANIFEST_PATH,
    candidate_results_manifest_hash: resultsManifestHash,
    candidate_result_disposition: 'actual_compiler_output_not_golden_oracle',
    candidate_case_count: 40,
    historical_r016_root:
      'sha256:776d516ba6c8c73a7da33895a4f4f3680054a1e93fbf056acdfc3ec36550b324',
    g0_10_root:
      'sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec',
    g1_root:
      'sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756',
    artifact_inventory: [...files.entries()]
      .map(([artifactPath, contents]) => ({
        path: artifactPath,
        raw_bytes_hash: actualRawHash(contents),
      }))
      .sort((left, right) => compareAscii(left.path, right.path)),
    golden_semantic_review_status: 'not_run',
    golden_seal_status: 'not_run',
    conformance_seal_status: 'not_run',
    g3_through_g9_status: 'not_started',
  };
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-contract-pack-g2-production-compiler/1',
    ref: {
      id: 'icarus.workflow-contract-pack-g2-production-compiler',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: G2_PRODUCTION_COMPILER_ROOT_DOMAIN,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function expectedFiles(): Map<string, string> {
  const candidates = buildG2Candidates();
  const files = new Map<string, string>();
  files.set(G2_TOOLCHAIN_PATH, renderCompilerJson(candidates.toolchain));
  files.set(G2_BINDING_PATH, renderCompilerJson(candidates.binding));
  for (const result of candidates.results) {
    files.set(
      `${G2_CANDIDATE_ROOT}/cases/${result.case_id}.result.json`,
      renderCompilerJson(result),
    );
  }
  files.set(
    G2_RESULTS_MANIFEST_PATH,
    renderCompilerJson(candidates.resultsManifest),
  );
  files.set(
    G2_ROOT_MANIFEST_PATH,
    renderArtifact(
      buildRootManifest(
        files,
        candidates.toolchain.toolchain_hash,
        candidates.binding.binding_hash,
        candidates.resultsManifest.manifest_hash,
        candidates.identity.compiler_build_hash,
      ),
    ),
  );
  return files;
}

function writeAtomic(relativePath: string, contents: string): void {
  const absolutePath = absoluteContractPath(relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporary = `${absolutePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, absolutePath);
}

function listCandidateFiles(): string[] {
  const root = absoluteContractPath(G2_CANDIDATE_ROOT);
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink())
        throw new Error(`G2 candidate tree contains symlink: ${absolutePath}`);
      if (stat.isDirectory()) visit(absolutePath);
      else if (stat.isFile()) {
        output.push(
          path.relative(contractsRoot, absolutePath).split(path.sep).join('/'),
        );
      }
    }
  };
  visit(root);
  return output.sort();
}

function validateCandidateSchemas(files: Map<string, string>): void {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const validateBinding = ajv.compile(
    schemaPayload(
      'conformance/compiler-contract-repair/schemas/g2-case-input-binding-schema.json',
    ),
  );
  const validateResult = ajv.compile(
    schemaPayload(
      'conformance/compiler-contract-repair/schemas/compiler-conformance-case-result-schema.json',
    ),
  );
  const binding = strictParseJsonBytes(
    Buffer.from(files.get(G2_BINDING_PATH) ?? '', 'utf8'),
  );
  if (!validateBinding(binding)) {
    throw new Error(
      `G2 binding schema failure: ${JSON.stringify(validateBinding.errors)}`,
    );
  }
  for (const [relativePath, contents] of files) {
    if (!relativePath.endsWith('.result.json')) continue;
    const result = strictParseJsonBytes(Buffer.from(contents, 'utf8'));
    if (!validateResult(result)) {
      throw new Error(
        `G2 result schema failure ${relativePath}: ${JSON.stringify(validateResult.errors)}`,
      );
    }
  }
}

function validateBoundaries(): void {
  checkHistoricalCompilerContractRepair();
  try {
    assertCurrentG2SealedBoundary(
      absoluteContractPath('conformance/sealed'),
    );
  } catch {
    throw new Error('Golden/conformance sealed boundary crossed');
  }
  const authoringRoot = path.join(workflowRuntimeRoot, 'authoring');
  if (fs.existsSync(authoringRoot)) {
    const allowedAuthoringFiles = new Set([
      'feature-release-activation.test.ts',
      'feature-release-activation.ts',
      'workflow-publisher.test.ts',
      'workflow-publisher.ts',
    ]);
    for (const entry of fs.readdirSync(authoringRoot)) {
      if (!allowedAuthoringFiles.has(entry)) {
        throw new Error(`G3+ boundary crossed: authoring/${entry}`);
      }
    }
  }
  for (const forbidden of [
    'registry',
    'runtime/graph-runtime.ts',
    'projection/runtime-center-api.ts',
  ]) {
    if (fs.existsSync(path.join(workflowRuntimeRoot, forbidden))) {
      throw new Error(`G3+ boundary crossed: ${forbidden}`);
    }
  }
}

export function generateG2ProductionCompilerArtifacts(): ContractArtifactEnvelope {
  return checkG2ProductionCompilerArtifacts();
}

export function checkG2ProductionCompilerArtifacts(): ContractArtifactEnvelope {
  validateBoundaries();
  const root = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(absoluteContractPath(G2_ROOT_MANIFEST_PATH)),
    ),
  );
  if (
    root.hash !==
    'sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77'
  ) {
    throw new Error('Frozen G2 Production Compiler root drift');
  }
  const manifest = strictParseJsonBytes(
    fs.readFileSync(absoluteContractPath(G2_RESULTS_MANIFEST_PATH)),
  );
  assertJsonObject(manifest);
  if (
    manifest.manifest_hash !==
    'sha256:c471bcf03ea23ce2d84d5a785b026ae222ec47f7d5fd5948bb8e19c89904b1d2'
  ) {
    throw new Error('Frozen G2 candidate manifest drift');
  }
  const inventory = root.payload.artifact_inventory;
  if (!Array.isArray(inventory) || inventory.length !== 43) {
    throw new Error('Frozen G2 artifact inventory drift');
  }
  const expectedPaths = new Set<string>([G2_ROOT_MANIFEST_PATH]);
  for (const value of inventory) {
    assertJsonObject(value);
    const relativePath = String(value.path);
    expectedPaths.add(relativePath);
    const actual = fs.readFileSync(absoluteContractPath(relativePath), 'utf8');
    if (actualRawHash(actual) !== value.raw_bytes_hash) {
      throw new Error(`Frozen G2 candidate bytes drift: ${relativePath}`);
    }
  }
  if (
    JSON.stringify(listCandidateFiles()) !==
    JSON.stringify([...expectedPaths].sort())
  ) {
    throw new Error('Frozen G2 candidate file set drift');
  }
  return root;
}
