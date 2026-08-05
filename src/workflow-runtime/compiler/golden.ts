import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkflowCompilerConformanceCaseResultV1 } from '../contracts/compiler-contract-repair-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { compileWorkflowCase } from './case-result.js';
import {
  WORKFLOW_COMPILER_VERSION,
  workflowCompilerIdentity,
} from './identity.js';
import type { WorkflowCompilerSourceKind } from './types.js';

export const GOLDEN_CASES_FORMAT = 'icarus.workflow-compiler-golden-cases/1';
export const GOLDEN_MANIFEST_FORMAT =
  'icarus.workflow-compiler-golden-manifest/1';
export const GOLDEN_CORPUS_VERSION = '1.0.0';
export const GOLDEN_CORPUS_ROOT = path.join(import.meta.dirname, 'golden');
export const GOLDEN_CASES_PATH = path.join(GOLDEN_CORPUS_ROOT, 'cases@1.json');
export const GOLDEN_MANIFEST_PATH = path.join(
  GOLDEN_CORPUS_ROOT,
  'manifest@1.json',
);

const CORPUS_HASH_DOMAIN = 'icarus:workflow-compiler-golden-corpus:1\n';
const LEGACY_AUTHORITY = path.resolve(
  import.meta.dirname,
  '../contracts/conformance/current/g2-generated-output-schema-authority-replay-v8/current-replay-authority@2.json',
);
const CONTRACTS_ROOT = path.resolve(import.meta.dirname, '../contracts');

export interface GoldenCase extends JsonObject {
  case_id: string;
  source_kind: WorkflowCompilerSourceKind;
  raw_source_base64: string;
  registry_snapshot: JsonObject;
  expected_result: WorkflowCompilerConformanceCaseResultV1;
}

export interface GoldenCases extends JsonObject {
  format: typeof GOLDEN_CASES_FORMAT;
  cases: GoldenCase[];
}

export interface GoldenManifest {
  format: typeof GOLDEN_MANIFEST_FORMAT;
  corpus_version: typeof GOLDEN_CORPUS_VERSION;
  compiler_version: string;
  case_count: number;
  corpus_hash: Sha256Hash;
  change_reason?: string;
}

export interface GoldenReplayResult {
  readonly caseCount: number;
  readonly exactCount: number;
  readonly mismatchedCaseIds: readonly string[];
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(filePath: string): JsonValue {
  return strictParseJsonBytes(fs.readFileSync(filePath));
}

function containedLegacyPath(relativePath: string): string {
  const resolved = path.resolve(CONTRACTS_ROOT, relativePath);
  if (!resolved.startsWith(`${CONTRACTS_ROOT}${path.sep}`)) {
    throw new Error(
      `Legacy Golden path escapes contracts root: ${relativePath}`,
    );
  }
  return resolved;
}

function asSourceKind(value: JsonValue): WorkflowCompilerSourceKind {
  if (
    value !== 'graph_scope' &&
    value !== 'workflow_definition' &&
    value !== 'workflow_schema'
  ) {
    throw new Error(`Unknown Golden source kind: ${String(value)}`);
  }
  return value;
}

function parseCases(value: JsonValue): GoldenCases {
  assertJsonObject(value);
  if (value.format !== GOLDEN_CASES_FORMAT || !Array.isArray(value.cases)) {
    throw new Error('Golden cases format is invalid');
  }
  const ids = new Set<string>();
  const cases = value.cases.map((entry, index) => {
    assertJsonObject(entry);
    assertJsonObject(entry.registry_snapshot);
    assertJsonObject(entry.expected_result);
    if (
      typeof entry.case_id !== 'string' ||
      typeof entry.raw_source_base64 !== 'string'
    ) {
      throw new Error(`Golden case ${index} is incomplete`);
    }
    if (ids.has(entry.case_id)) {
      throw new Error(`Duplicate Golden case: ${entry.case_id}`);
    }
    ids.add(entry.case_id);
    return {
      case_id: entry.case_id,
      source_kind: asSourceKind(entry.source_kind),
      raw_source_base64: entry.raw_source_base64,
      registry_snapshot: entry.registry_snapshot,
      expected_result:
        entry.expected_result as unknown as WorkflowCompilerConformanceCaseResultV1,
    } satisfies GoldenCase;
  });
  cases.sort((left, right) => left.case_id.localeCompare(right.case_id, 'en'));
  return { format: GOLDEN_CASES_FORMAT, cases };
}

function corpusHash(cases: GoldenCases): Sha256Hash {
  return domainSeparatedSha256(CORPUS_HASH_DOMAIN, cases);
}

function parseManifest(value: JsonValue): GoldenManifest {
  assertJsonObject(value);
  if (
    value.format !== GOLDEN_MANIFEST_FORMAT ||
    value.corpus_version !== GOLDEN_CORPUS_VERSION ||
    typeof value.compiler_version !== 'string' ||
    typeof value.case_count !== 'number' ||
    typeof value.corpus_hash !== 'string'
  ) {
    throw new Error('Golden manifest format is invalid');
  }
  if (
    value.change_reason !== undefined &&
    typeof value.change_reason !== 'string'
  ) {
    throw new Error('Golden change reason must be a string');
  }
  return value as unknown as GoldenManifest;
}

export function readGoldenCorpus(root = GOLDEN_CORPUS_ROOT): {
  readonly cases: GoldenCases;
  readonly manifest: GoldenManifest;
} {
  const cases = parseCases(readJson(path.join(root, 'cases@1.json')));
  const manifest = parseManifest(readJson(path.join(root, 'manifest@1.json')));
  if (manifest.case_count !== cases.cases.length) {
    throw new Error('Golden manifest case count drifted');
  }
  if (manifest.corpus_hash !== corpusHash(cases)) {
    throw new Error('Golden manifest corpus hash drifted');
  }
  return { cases, manifest };
}

export function readLegacyGoldenCorpus(): GoldenCases {
  const authority = readJson(LEGACY_AUTHORITY);
  assertJsonObject(authority);
  assertJsonObject(authority.payload);
  if (!Array.isArray(authority.payload.cases)) {
    throw new Error('Legacy Golden authority has no cases');
  }
  const cases = authority.payload.cases.map((entry) => {
    assertJsonObject(entry);
    assertJsonObject(entry.expected_result);
    const snapshotEnvelope = readJson(
      containedLegacyPath(String(entry.registry_snapshot_ref)),
    );
    assertJsonObject(snapshotEnvelope);
    assertJsonObject(snapshotEnvelope.payload);
    const expected = readJson(
      containedLegacyPath(String(entry.expected_result.path)),
    );
    assertJsonObject(expected);
    return {
      case_id: String(entry.case_id),
      source_kind: asSourceKind(entry.source_kind),
      raw_source_base64: fs
        .readFileSync(containedLegacyPath(String(entry.raw_source_bytes_ref)))
        .toString('base64'),
      registry_snapshot: snapshotEnvelope.payload,
      expected_result:
        expected as unknown as WorkflowCompilerConformanceCaseResultV1,
    } satisfies GoldenCase;
  });
  cases.sort((left, right) => left.case_id.localeCompare(right.case_id, 'en'));
  return { format: GOLDEN_CASES_FORMAT, cases };
}

export function generateGoldenCorpus(
  inputs: GoldenCases,
  changeReason?: string,
): { readonly cases: GoldenCases; readonly manifest: GoldenManifest } {
  const identity = workflowCompilerIdentity();
  const cases: GoldenCases = {
    format: GOLDEN_CASES_FORMAT,
    cases: inputs.cases.map((entry) => ({
      ...entry,
      expected_result: compileWorkflowCase(
        entry.case_id,
        entry.source_kind,
        Buffer.from(entry.raw_source_base64, 'base64'),
        entry.registry_snapshot,
        identity,
      ),
    })),
  };
  const manifest: GoldenManifest = {
    format: GOLDEN_MANIFEST_FORMAT,
    corpus_version: GOLDEN_CORPUS_VERSION,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    case_count: cases.cases.length,
    corpus_hash: corpusHash(cases),
    ...(changeReason ? { change_reason: changeReason } : {}),
  };
  return { cases, manifest };
}

function writeCorpus(
  root: string,
  generated: { readonly cases: GoldenCases; readonly manifest: GoldenManifest },
): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'cases@1.json'), render(generated.cases));
  fs.writeFileSync(
    path.join(root, 'manifest@1.json'),
    render(generated.manifest as unknown as JsonValue),
  );
}

export function replayGoldenCorpus(
  root = GOLDEN_CORPUS_ROOT,
): GoldenReplayResult {
  const { cases } = readGoldenCorpus(root);
  const identity = workflowCompilerIdentity();
  const mismatchedCaseIds = cases.cases
    .filter((entry) => {
      const actual = compileWorkflowCase(
        entry.case_id,
        entry.source_kind,
        Buffer.from(entry.raw_source_base64, 'base64'),
        entry.registry_snapshot,
        identity,
      );
      return canonicalJson(actual) !== canonicalJson(entry.expected_result);
    })
    .map((entry) => entry.case_id);
  return {
    caseCount: cases.cases.length,
    exactCount: cases.cases.length - mismatchedCaseIds.length,
    mismatchedCaseIds,
  };
}

export function checkGoldenCorpus(): GoldenReplayResult {
  const committed = readGoldenCorpus();
  const generated = generateGoldenCorpus(
    committed.cases,
    committed.manifest.change_reason,
  );
  if (
    render(generated.cases) !== fs.readFileSync(GOLDEN_CASES_PATH, 'utf8') ||
    render(generated.manifest as unknown as JsonValue) !==
      fs.readFileSync(GOLDEN_MANIFEST_PATH, 'utf8')
  ) {
    throw new Error('Golden corpus drifted; run npm run golden:update');
  }
  return replayGoldenCorpus();
}

export function updateGoldenCorpus(changeReason?: string): GoldenReplayResult {
  const inputs = fs.existsSync(GOLDEN_CASES_PATH)
    ? readGoldenCorpus().cases
    : readLegacyGoldenCorpus();
  const generated = generateGoldenCorpus(inputs, changeReason);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-golden-'),
  );
  try {
    writeCorpus(temporaryRoot, generated);
    const replay = replayGoldenCorpus(temporaryRoot);
    if (replay.mismatchedCaseIds.length > 0) {
      throw new Error(
        `Generated Golden replay failed: ${replay.mismatchedCaseIds.join(', ')}`,
      );
    }
    fs.mkdirSync(GOLDEN_CORPUS_ROOT, { recursive: true });
    for (const fileName of ['cases@1.json', 'manifest@1.json']) {
      fs.copyFileSync(
        path.join(temporaryRoot, fileName),
        path.join(GOLDEN_CORPUS_ROOT, fileName),
      );
    }
    return replay;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
