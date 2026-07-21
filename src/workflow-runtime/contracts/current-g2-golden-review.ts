import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  checkCurrentG2GoldenDraftAtRootForTest,
  CURRENT_G2_GOLDEN_DRAFT_CASES_PATH,
  CURRENT_G2_GOLDEN_DRAFT_MANIFEST_PATH,
  CURRENT_G2_GOLDEN_DRAFT_ROOT,
} from './current-g2-golden-draft.js';
import { CURRENT_G2_GOLDEN_REVIEW_SCHEMA } from './current-g2-golden-schemas.js';
import type {
  CurrentG2GoldenReviewCase,
  CurrentG2GoldenReviewDifference,
  CurrentG2GoldenReviewPayload,
} from './current-g2-golden-types.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const CURRENT_G2_GOLDEN_REVIEW_ROOT =
  'conformance/golden-review/g2-semantic-correction';
export const CURRENT_G2_GOLDEN_REVIEW_SCHEMA_PATH =
  `${CURRENT_G2_GOLDEN_REVIEW_ROOT}/schemas/golden-review-report-schema@1.json`;
export const CURRENT_G2_GOLDEN_REVIEW_REPORT_PATH =
  `${CURRENT_G2_GOLDEN_REVIEW_ROOT}/golden-review-report@1.json`;

const RC_MANIFEST_PATH =
  'conformance/review-candidate/g2-semantic-correction/review-candidate.json';
const RC_CASES_PATH =
  'conformance/review-candidate/g2-semantic-correction/review-candidate-cases@1.json';
const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const REPORT_DOMAIN = 'icarus:workflow-current-g2-golden-review-report:1\n';
const REPORT_ARTIFACT_DOMAIN =
  'icarus:workflow-current-g2-golden-review-report-artifact:1\n';
const REPORT_SCHEMA_DOMAIN =
  'icarus:workflow-current-g2-golden-review-report-schema:1\n';

export type CurrentG2ActualLoader = (
  caseId: string,
  actualResultRef: string,
) => Uint8Array | string;

export interface CurrentG2GoldenReviewBuild {
  files: Map<string, string>;
  report: ContractArtifactEnvelope;
}

export class CurrentG2GoldenReviewError extends Error {
  readonly code = 'current_g2_golden_review_error';

  constructor(message: string) {
    super(message);
    this.name = 'CurrentG2GoldenReviewError';
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new CurrentG2GoldenReviewError(`Golden review path escapes root: ${relativePath}`);
  }
  return resolved;
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
  } catch {
    throw new CurrentG2GoldenReviewError(`Expected object: ${label}`);
  }
  return value;
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new CurrentG2GoldenReviewError(`Expected array: ${label}`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function string(value: JsonValue, label: string): string {
  if (typeof value !== 'string') throw new CurrentG2GoldenReviewError(`Expected string: ${label}`);
  return value;
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rawHash(bytes: Uint8Array | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readArtifactAt(absolutePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(strictParseJsonBytes(fs.readFileSync(absolutePath)));
}

function readRepositoryArtifact(relativePath: string): ContractArtifactEnvelope {
  return readArtifactAt(absolute(relativePath));
}

function artifact(
  format: string,
  id: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const value: ContractArtifactEnvelope = {
    format,
    ref: { id, version: '1.0.0-draft-review' },
    version: 1,
    domain_separator: domain,
    hash: rawHash('unreachable'),
    payload,
  };
  value.hash = calculateArtifactHash(value);
  return value;
}

function renderArtifact(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function localDraftPath(draftRoot: string, repositoryPath: string): string {
  const prefix = `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new CurrentG2GoldenReviewError(`Draft reference escapes Draft root: ${repositoryPath}`);
  }
  return path.join(draftRoot, repositoryPath.slice(prefix.length));
}

function pointerToken(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function differences(
  expected: JsonValue,
  actual: JsonValue,
  pointer = '',
  output: CurrentG2GoldenReviewDifference[] = [],
): CurrentG2GoldenReviewDifference[] {
  if (canonicalJson(expected) === canonicalJson(actual)) return output;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    output.push({ pointer, kind: 'value_mismatch', expected, actual });
    return output;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const count = Math.max(expected.length, actual.length);
    for (let index = 0; index < count; index += 1) {
      const nestedPointer = `${pointer}/${index}`;
      if (index >= expected.length) {
        output.push({
          pointer: nestedPointer,
          kind: 'missing_expected',
          expected: null,
          actual: clone(actual[index]!),
        });
      } else if (index >= actual.length) {
        output.push({
          pointer: nestedPointer,
          kind: 'missing_actual',
          expected: clone(expected[index]!),
          actual: null,
        });
      } else {
        differences(expected[index]!, actual[index]!, nestedPointer, output);
      }
    }
    return output;
  }
  const expectedObject = object(expected, 'expected difference object');
  const actualObject = object(actual, 'actual difference object');
  const keys = new Set([...Object.keys(expectedObject), ...Object.keys(actualObject)]);
  for (const key of [...keys].sort()) {
    const nestedPointer = `${pointer}/${pointerToken(key)}`;
    if (!(key in expectedObject)) {
      output.push({
        pointer: nestedPointer,
        kind: 'missing_expected',
        expected: null,
        actual: clone(actualObject[key]!),
      });
    } else if (!(key in actualObject)) {
      output.push({
        pointer: nestedPointer,
        kind: 'missing_actual',
        expected: clone(expectedObject[key]!),
        actual: null,
      });
    } else {
      differences(expectedObject[key]!, actualObject[key]!, nestedPointer, output);
    }
  }
  return output;
}

function resolvePointer(root: JsonValue, pointer: string): { found: boolean; value: JsonValue } {
  if (pointer === '') return { found: true, value: root };
  let current: JsonValue = root;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: null };
      }
      current = current[index]!;
    } else if (current && typeof current === 'object' && token in current) {
      current = current[token]!;
    } else {
      return { found: false, value: null };
    }
  }
  return { found: true, value: current };
}

function assertionPass(result: JsonValue, assertion: JsonObject): boolean {
  const resolved = resolvePointer(result, string(assertion.subject_pointer, 'assertion pointer'));
  const operator = string(assertion.operator, 'assertion operator');
  if (operator === 'present') return resolved.found === assertion.expected;
  if (operator === 'absent') return !resolved.found === assertion.expected;
  if (!resolved.found) return false;
  if (operator === 'equals' || operator === 'ordered_equals') {
    return canonicalJson(resolved.value) === canonicalJson(assertion.expected);
  }
  if (operator === 'set_equals') {
    const left = Array.isArray(resolved.value)
      ? [...resolved.value]
      : resolved.value && typeof resolved.value === 'object'
        ? Object.keys(resolved.value)
        : [resolved.value];
    const right = Array.isArray(assertion.expected)
      ? [...assertion.expected]
      : [assertion.expected];
    return canonicalJson(left.sort(compareJson)) === canonicalJson(right.sort(compareJson));
  }
  if (operator === 'contains') {
    if (Array.isArray(resolved.value)) {
      return resolved.value.some(
        (entry) => canonicalJson(entry) === canonicalJson(assertion.expected),
      );
    }
    if (typeof resolved.value === 'string' && typeof assertion.expected === 'string') {
      return resolved.value.includes(assertion.expected);
    }
    return (
      !!resolved.value &&
      typeof resolved.value === 'object' &&
      typeof assertion.expected === 'string' &&
      assertion.expected in resolved.value
    );
  }
  return false;
}

function compareJson(left: JsonValue, right: JsonValue): number {
  const leftBytes = canonicalJson(left);
  const rightBytes = canonicalJson(right);
  return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
}

function validateResultHash(result: JsonObject, label: string): Sha256Hash {
  const resultHash = string(result.result_hash, `${label} result hash`) as Sha256Hash;
  const withoutHash = clone(result);
  delete withoutHash.result_hash;
  if (domainSeparatedSha256(RESULT_DOMAIN, withoutHash) !== resultHash) {
    throw new CurrentG2GoldenReviewError(`${label} result hash drift`);
  }
  return resultHash;
}

function defaultActualLoader(_caseId: string, actualResultRef: string): Uint8Array {
  return fs.readFileSync(absolute(actualResultRef));
}

export function buildCurrentG2GoldenReviewArtifactsForTest(
  draftRoot: string,
  actualLoader: CurrentG2ActualLoader = defaultActualLoader,
  enforceRcActualIdentity = true,
): CurrentG2GoldenReviewBuild {
  const checkedDraft = checkCurrentG2GoldenDraftAtRootForTest(draftRoot);
  const draftManifest = readArtifactAt(path.join(draftRoot, 'golden-draft-manifest@1.json'));
  if (
    draftManifest.hash !== checkedDraft.hash ||
    draftManifest.payload.draft_status !== 'frozen_pending_human_approval'
  ) {
    throw new CurrentG2GoldenReviewError('Golden review requires the exact frozen Draft');
  }
  const draftCases = readArtifactAt(path.join(draftRoot, 'golden-draft-cases@1.json'));
  const rc = readRepositoryArtifact(RC_MANIFEST_PATH);
  const rcCases = readRepositoryArtifact(RC_CASES_PATH);
  if (rc.hash !== draftManifest.payload.review_candidate_hash) {
    throw new CurrentG2GoldenReviewError('Golden review RC binding drift');
  }
  const rcById = new Map(
    objects(rcCases.payload.cases, 'RC cases').map((entry) => [String(entry.case_id), entry]),
  );
  const reviewCases: CurrentG2GoldenReviewCase[] = [];
  let byteEqualCount = 0;
  let semanticEqualCount = 0;
  let assertionCount = 0;
  let assertionFailureCount = 0;
  let differenceCount = 0;
  let compiledCount = 0;
  let rejectedCount = 0;
  for (const draftCase of objects(draftCases.payload.cases, 'Draft cases')) {
    const caseId = string(draftCase.case_id, 'Draft case id');
    const rcCase = rcById.get(caseId);
    if (!rcCase) throw new CurrentG2GoldenReviewError(`RC comparison case missing: ${caseId}`);
    const expectedIdentity = object(draftCase.expected_result, 'expected result identity');
    const expectedRef = string(expectedIdentity.path, 'expected result ref');
    const expectedBytes = fs.readFileSync(localDraftPath(draftRoot, expectedRef), 'utf8');
    if (rawHash(expectedBytes) !== expectedIdentity.raw_bytes_hash) {
      throw new CurrentG2GoldenReviewError(`Expected result raw hash drift: ${caseId}`);
    }
    const expected = object(
      strictParseJsonBytes(Buffer.from(expectedBytes, 'utf8')),
      'expected result',
    );
    const expectedHash = validateResultHash(expected, `Expected ${caseId}`);
    if (expectedHash !== expectedIdentity.semantic_hash) {
      throw new CurrentG2GoldenReviewError(`Expected result semantic hash drift: ${caseId}`);
    }
    const comparison = object(rcCase.actual_compiler_comparison, 'actual comparison');
    const actualRef = string(comparison.result_ref, 'actual result ref');
    const loaded = actualLoader(caseId, actualRef);
    const actualBytes = typeof loaded === 'string' ? loaded : Buffer.from(loaded).toString('utf8');
    if (enforceRcActualIdentity && rawHash(actualBytes) !== comparison.result_raw_bytes_hash) {
      throw new CurrentG2GoldenReviewError(`Actual result raw hash drift: ${caseId}`);
    }
    const actual = object(
      strictParseJsonBytes(Buffer.from(actualBytes, 'utf8')),
      'actual result',
    );
    const actualHash = validateResultHash(actual, `Actual ${caseId}`);
    if (enforceRcActualIdentity && actualHash !== comparison.result_hash) {
      throw new CurrentG2GoldenReviewError(`Actual result semantic hash drift: ${caseId}`);
    }
    const caseDifferences = differences(expected, actual);
    const byteEqual = expectedBytes === canonicalJson(actual);
    const semanticEqual = canonicalJson(expected) === canonicalJson(actual);
    if (byteEqual) byteEqualCount += 1;
    if (semanticEqual) semanticEqualCount += 1;
    const assertions = objects(draftCase.semantic_assertions, 'semantic assertions');
    const failures = assertions
      .filter((assertion) => !assertionPass(expected, assertion))
      .map((assertion) => ({
        assertion_id: assertion.assertion_id,
        subject_pointer: assertion.subject_pointer,
        expected: clone(assertion.expected),
        observed: resolvePointer(
          expected,
          string(assertion.subject_pointer, 'assertion pointer'),
        ).value,
      }));
    assertionCount += assertions.length;
    assertionFailureCount += failures.length;
    differenceCount += caseDifferences.length;
    if (expected.outcome === 'compiled') compiledCount += 1;
    else rejectedCount += 1;
    const sourceBinding = object(draftCase.source_binding, 'source binding');
    reviewCases.push({
      case_id: caseId,
      source_ref: string(sourceBinding.raw_source_bytes_ref, 'source ref'),
      snapshot_ref: string(sourceBinding.input_snapshot_ref, 'snapshot ref'),
      expected_result_ref: expectedRef,
      expected_result_hash: expectedHash,
      actual_result_ref: actualRef,
      actual_result_hash: actualHash,
      outcome: string(expected.outcome, 'expected outcome') as never,
      byte_equal: byteEqual,
      semantic_equal: semanticEqual,
      normalized_plan:
        expected.outcome === 'compiled'
          ? clone(object(expected.normalized_plan, 'expected normalized plan'))
          : null,
      diagnostic_pointers: objects(expected.diagnostics, 'expected diagnostics').map(
        (diagnostic) => string(diagnostic.instance_pointer, 'diagnostic pointer'),
      ),
      semantic_assertion_count: assertions.length,
      semantic_assertion_failures: failures,
      difference_count: caseDifferences.length,
      differences: caseDifferences,
    });
  }
  if (
    reviewCases.length !== 40 ||
    rcById.size !== 40 ||
    compiledCount !== 11 ||
    rejectedCount !== 29
  ) {
    throw new CurrentG2GoldenReviewError('Golden review comparison coverage is partial');
  }
  const boundRoots = object(rc.payload.bound_working_roots, 'RC Working roots');
  const candidate = object(boundRoots.candidate, 'candidate root');
  const actualComparison = object(rc.payload.actual_comparison, 'RC actual comparison');
  const payloadWithoutHash: Omit<CurrentG2GoldenReviewPayload, 'report_hash'> = {
    format: 'icarus.workflow-compiler-current-g2-golden-review-report/1',
    construction_phase: 'RC_REVIEW',
    report_kind: 'read_only_draft_candidate_comparison',
    publishable: false,
    production_reachable: false,
    draft_manifest_ref: CURRENT_G2_GOLDEN_DRAFT_MANIFEST_PATH,
    draft_manifest_hash: string(
      draftManifest.payload.draft_manifest_hash,
      'draft manifest hash',
    ) as Sha256Hash,
    review_candidate_ref: RC_MANIFEST_PATH,
    review_candidate_hash: rc.hash,
    candidate_root_ref: string(candidate.path, 'candidate root ref'),
    candidate_root_hash: string(candidate.semantic_hash, 'candidate root hash') as Sha256Hash,
    actual_results_manifest_ref: string(
      actualComparison.results_manifest_ref,
      'actual results manifest ref',
    ),
    actual_results_manifest_hash: string(
      actualComparison.results_manifest_hash,
      'actual results manifest hash',
    ) as Sha256Hash,
    actual_comparison_role: 'actual_compiler_output_not_golden_oracle',
    case_count: 40,
    compiled_count: 11,
    rejected_count: 29,
    expected_coverage: 40,
    comparison_coverage: 40,
    byte_equal_count: byteEqualCount,
    semantic_equal_count: semanticEqualCount,
    semantic_assertion_count: assertionCount,
    semantic_assertion_failure_count: assertionFailureCount,
    difference_count: differenceCount,
    cases: reviewCases,
    human_review: {
      status: 'not_requested',
      reviewer_actor_ref: 'human:local-owner',
      judgment_coverage: 0,
    },
    approval_status: 'absent',
    signature_status: 'absent',
    seal_status: 'absent',
    golden_semantic_review_status: 'not_run',
    g3_through_g9_status: 'not_started',
  };
  const payload = {
    ...(payloadWithoutHash as JsonObject),
    report_hash: domainSeparatedSha256(
      REPORT_DOMAIN,
      payloadWithoutHash as unknown as JsonValue,
    ),
  } as CurrentG2GoldenReviewPayload;
  const report = artifact(
    'icarus.workflow-compiler-current-g2-golden-review-report/1',
    'icarus.workflow-compiler-current-g2-golden-review-report',
    REPORT_ARTIFACT_DOMAIN,
    payload,
  );
  const schema = artifact(
    'icarus.workflow-current-g2-golden-review-report-schema/1',
    'icarus.workflow-current-g2-golden-review-report-schema',
    REPORT_SCHEMA_DOMAIN,
    CURRENT_G2_GOLDEN_REVIEW_SCHEMA,
  );
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    CURRENT_G2_GOLDEN_REVIEW_SCHEMA as AnySchema,
  );
  if (!validate(report.payload)) {
    throw new CurrentG2GoldenReviewError(
      `Golden review report failed closed schema: ${JSON.stringify(validate.errors)}`,
    );
  }
  return {
    files: new Map([
      [CURRENT_G2_GOLDEN_REVIEW_SCHEMA_PATH, renderArtifact(schema)],
      [CURRENT_G2_GOLDEN_REVIEW_REPORT_PATH, renderArtifact(report)],
    ]),
    report,
  };
}

function localReviewPath(reviewRoot: string, repositoryPath: string): string {
  const prefix = `${CURRENT_G2_GOLDEN_REVIEW_ROOT}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new CurrentG2GoldenReviewError(`Review reference escapes root: ${repositoryPath}`);
  }
  return path.join(reviewRoot, repositoryPath.slice(prefix.length));
}

function checkFiles(reviewRoot: string, files: Map<string, string>): void {
  const expected = [...files.keys()].map((entry) => path.relative(reviewRoot, localReviewPath(reviewRoot, entry))).sort();
  const actual = fs.existsSync(reviewRoot)
    ? fs.readdirSync(reviewRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(reviewRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
        .sort()
    : [];
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new CurrentG2GoldenReviewError('Golden review inventory conflict');
  }
  for (const [repositoryPath, bytes] of files) {
    if (fs.readFileSync(localReviewPath(reviewRoot, repositoryPath), 'utf8') !== bytes) {
      throw new CurrentG2GoldenReviewError(`Golden review bytes drift: ${repositoryPath}`);
    }
  }
}

export function generateCurrentG2GoldenReviewAtRootsForTest(
  draftRoot: string,
  reviewRoot: string,
  actualLoader: CurrentG2ActualLoader = defaultActualLoader,
  enforceRcActualIdentity = true,
): ContractArtifactEnvelope {
  const built = buildCurrentG2GoldenReviewArtifactsForTest(
    draftRoot,
    actualLoader,
    enforceRcActualIdentity,
  );
  if (fs.existsSync(reviewRoot)) {
    checkFiles(reviewRoot, built.files);
    return built.report;
  }
  fs.mkdirSync(path.dirname(reviewRoot), { recursive: true });
  const temporary = fs.mkdtempSync(`${reviewRoot}.tmp-`);
  try {
    for (const [repositoryPath, bytes] of built.files) {
      const target = path.join(temporary, path.relative(reviewRoot, localReviewPath(reviewRoot, repositoryPath)));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    fs.renameSync(temporary, reviewRoot);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return built.report;
}

export function checkCurrentG2GoldenReviewAtRootsForTest(
  draftRoot: string,
  reviewRoot: string,
  actualLoader: CurrentG2ActualLoader = defaultActualLoader,
  enforceRcActualIdentity = true,
): ContractArtifactEnvelope {
  const built = buildCurrentG2GoldenReviewArtifactsForTest(
    draftRoot,
    actualLoader,
    enforceRcActualIdentity,
  );
  checkFiles(reviewRoot, built.files);
  return built.report;
}

export function generateCurrentG2GoldenReview(): ContractArtifactEnvelope {
  return generateCurrentG2GoldenReviewAtRootsForTest(
    absolute(CURRENT_G2_GOLDEN_DRAFT_ROOT),
    absolute(CURRENT_G2_GOLDEN_REVIEW_ROOT),
  );
}

export function checkCurrentG2GoldenReview(): ContractArtifactEnvelope {
  return checkCurrentG2GoldenReviewAtRootsForTest(
    absolute(CURRENT_G2_GOLDEN_DRAFT_ROOT),
    absolute(CURRENT_G2_GOLDEN_REVIEW_ROOT),
  );
}
