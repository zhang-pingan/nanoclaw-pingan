import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { G8_READINESS_REPRESENTATIVES } from '../contracts/g8-limits.js';
import { runG8BenchmarkCases } from './benchmark-runner.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), label));
  roots.push(root);
  return root;
}

describe('G8 real-file readiness runner', () => {
  it('executes one Supported and one Beyond Limit representative per transaction family', () => {
    const cases = runG8BenchmarkCases({
      rootDir: temporaryRoot('icarus-g8-readiness-runner-'),
      identityMode: 'candidate_development',
      warmupIterations: 0,
      measurementIterations: 1,
    });
    expect(cases).toHaveLength(6);
    for (const transaction of ['t3', 't7', 't8'] as const) {
      const family = cases.filter((entry) => entry.transaction === transaction);
      expect(family).toHaveLength(2);
      expect(family.map((entry) => entry.shape)).toEqual([
        G8_READINESS_REPRESENTATIVES[transaction][0],
        G8_READINESS_REPRESENTATIVES[transaction][0],
      ]);
      expect(family[0]!.statistics!.affected_rows).toBeGreaterThan(0);
      expect(family[1]!.beyond_limit_rejection).toMatchObject({
        status: 'rejected_before_atomic_write',
        affected_rows: 0,
      });
      expect(family[1]!.beyond_limit_rejection!.database_after_hash).toBe(
        family[1]!.beyond_limit_rejection!.database_before_hash,
      );
    }
  }, 120_000);

  it('retains the T8 before-commit all-or-nothing fault invariant', () => {
    const cases = runG8BenchmarkCases({
      rootDir: temporaryRoot('icarus-g8-t8-atomic-runner-'),
      identityMode: 'candidate_development',
      warmupIterations: 0,
      measurementIterations: 1,
      profiles: ['smoke'],
      transactions: ['t8'],
      shapes: { t8: ['all_or_nothing'] },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      transaction: 't8',
      shape: 'all_or_nothing',
      production_entry: 'commitRootT8',
    });
    expect(cases[0]!.correctness_invariants).toContain(
      'before_commit fault leaves Cut and Child relations absent',
    );
  }, 60_000);
});
