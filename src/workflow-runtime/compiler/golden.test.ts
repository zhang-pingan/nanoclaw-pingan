import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../contracts/hash.js';
import {
  checkGoldenCorpus,
  generateGoldenCorpus,
  GOLDEN_CASES_PATH,
  readGoldenCorpus,
  readLegacyGoldenCorpus,
  replayGoldenCorpus,
} from './golden.js';

describe('Workflow Compiler Golden corpus', () => {
  it('preserves the 40 accepted case inputs and decisions during migration', () => {
    const legacy = readLegacyGoldenCorpus();
    const current = readGoldenCorpus().cases;
    expect(current.cases.map((entry) => entry.case_id)).toEqual(
      legacy.cases.map((entry) => entry.case_id),
    );
    expect(canonicalJson(current)).toBe(canonicalJson(legacy));
  });

  it('generates deterministically and replays every committed result', () => {
    const { cases, manifest } = readGoldenCorpus();
    expect(generateGoldenCorpus(cases, manifest.change_reason)).toEqual(
      generateGoldenCorpus(cases, manifest.change_reason),
    );
    expect(checkGoldenCorpus()).toEqual({
      caseCount: 40,
      exactCount: 40,
      mismatchedCaseIds: [],
    });
  });

  it('reports expected-result drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-golden-test-'));
    try {
      fs.copyFileSync(GOLDEN_CASES_PATH, path.join(root, 'cases@1.json'));
      fs.copyFileSync(
        path.join(path.dirname(GOLDEN_CASES_PATH), 'manifest@1.json'),
        path.join(root, 'manifest@1.json'),
      );
      const casesPath = path.join(root, 'cases@1.json');
      const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
      cases.cases[0].expected_result.outcome = 'compiled';
      fs.writeFileSync(casesPath, `${JSON.stringify(cases, null, 2)}\n`);
      expect(() => replayGoldenCorpus(root)).toThrow(
        'Golden manifest corpus hash drifted',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
