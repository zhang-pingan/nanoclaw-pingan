import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildCurrentG2GoldenDraftArtifactsForTest,
  checkCurrentG2GoldenDraftAtRootForTest,
  CURRENT_G2_GOLDEN_DRAFT_CASES_PATH,
  generateCurrentG2GoldenDraftAtRootForTest,
  validateCurrentG2GoldenDraftCaseCatalogForTest,
} from './current-g2-golden-draft.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
let temporaryRoot: string;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function casesPayload(): JsonObject {
  const built = buildCurrentG2GoldenDraftArtifactsForTest();
  const bytes = built.files.get(CURRENT_G2_GOLDEN_DRAFT_CASES_PATH)!;
  return (JSON.parse(bytes) as ContractArtifactEnvelope).payload;
}

function tempDraft(name: string): string {
  return path.join(temporaryRoot, name, 'g2-semantic-correction');
}

beforeAll(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-current-g2-golden-'));
});

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('current G2 expected Golden Draft', () => {
  it('authors deterministic 40/40 full result bytes and 11 compiled support sets', () => {
    const first = buildCurrentG2GoldenDraftArtifactsForTest();
    const second = buildCurrentG2GoldenDraftArtifactsForTest();
    expect([...second.files]).toEqual([...first.files]);
    expect(second.manifest.hash).toBe(first.manifest.hash);
    expect(second.manifest.payload.draft_manifest_hash).toBe(
      first.manifest.payload.draft_manifest_hash,
    );
    expect(first.expectedResults).toHaveLength(40);
    expect(
      [...first.expectedResults.values()].filter((entry) => entry.outcome === 'compiled'),
    ).toHaveLength(11);
    expect(
      [...first.expectedResults.values()].filter((entry) => entry.outcome === 'rejected'),
    ).toHaveLength(29);
    expect(first.files).toHaveLength(79);
    for (const bytes of first.files.values()) {
      expect(bytes).not.toMatch(/sha256:0{64}/);
    }
  });

  it('requires the exact session authority and preserves an exact repeated freeze', () => {
    const root = tempDraft('authorized');
    expect(() => generateCurrentG2GoldenDraftAtRootForTest(root, 'codex:self')).toThrow(
      /not authorized/,
    );
    const first = generateCurrentG2GoldenDraftAtRootForTest(
      root,
      'human:local-owner',
    );
    const second = generateCurrentG2GoldenDraftAtRootForTest(
      root,
      'human:local-owner',
    );
    expect(second.hash).toBe(first.hash);
    expect(checkCurrentG2GoldenDraftAtRootForTest(root).hash).toBe(first.hash);
  });

  it('rejects missing, duplicate, partial, and unknown case catalog state', () => {
    const missing = clone(casesPayload());
    (missing.cases as JsonObject[]).pop();
    expect(() => validateCurrentG2GoldenDraftCaseCatalogForTest(missing)).toThrow(
      /schema|missing/i,
    );

    const duplicate = clone(casesPayload());
    const duplicateCases = duplicate.cases as JsonObject[];
    duplicateCases[1]!.case_id = duplicateCases[0]!.case_id;
    expect(() => validateCurrentG2GoldenDraftCaseCatalogForTest(duplicate)).toThrow(
      /duplicate/,
    );

    const partial = clone(casesPayload());
    const compiled = (partial.cases as JsonObject[]).find(
      (entry) => entry.outcome === 'compiled',
    )!;
    (compiled.expected_plan as JsonObject).path = null;
    expect(() => validateCurrentG2GoldenDraftCaseCatalogForTest(partial)).toThrow(
      /schema|partial/i,
    );

    const unknown = clone(casesPayload());
    unknown.accept = true;
    expect(() => validateCurrentG2GoldenDraftCaseCatalogForTest(unknown)).toThrow(
      /schema/,
    );
  });

  it('fails read-only check on altered expected bytes, missing files, and RC binding drift', () => {
    const altered = tempDraft('altered');
    generateCurrentG2GoldenDraftAtRootForTest(altered, 'human:local-owner');
    const result = path.join(
      altered,
      'expected',
      'negative.json-syntax-invalid.result.json',
    );
    fs.appendFileSync(result, '\n');
    expect(() => checkCurrentG2GoldenDraftAtRootForTest(altered)).toThrow(/bytes drift/);

    const missing = tempDraft('missing');
    generateCurrentG2GoldenDraftAtRootForTest(missing, 'human:local-owner');
    fs.rmSync(
      path.join(missing, 'expected', 'negative.json-syntax-invalid.result.json'),
    );
    expect(() => checkCurrentG2GoldenDraftAtRootForTest(missing)).toThrow(
      /inventory conflict/,
    );

    const rcDrift = tempDraft('rc-drift');
    generateCurrentG2GoldenDraftAtRootForTest(rcDrift, 'human:local-owner');
    const manifestPath = path.join(rcDrift, 'golden-draft-manifest@1.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as JsonObject;
    const payload = manifest.payload as JsonObject;
    payload.review_candidate_hash = `sha256:${'f'.repeat(64)}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => checkCurrentG2GoldenDraftAtRootForTest(rcDrift)).toThrow(/bytes drift/);
  });

  it('has no Production Compiler, accept, candidate-result, or forbidden Draft import path', () => {
    const sources = [
      'current-g2-golden-authoring.ts',
      'current-g2-golden-draft.ts',
      'current-g2-golden-draft-cli.ts',
    ].map((name) => fs.readFileSync(path.join(contractsRoot, name), 'utf8'));
    for (const source of sources) {
      expect(source).not.toMatch(/from ['"].*\/compiler\//);
      expect(source).not.toMatch(
        /from ['"][^'"]*(?:normalizer|lowerer|assignability|proofs?)(?:\.[jt]s)?['"]|--accept/,
      );
      expect(source).not.toMatch(/candidate\/.*\/cases\/.*\.result\.json/);
      expect(source).not.toMatch(/(?:^|[-_@])v[56](?:$|[-_.@])/m);
    }
  });
});
