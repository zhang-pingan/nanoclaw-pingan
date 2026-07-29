import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

describe('G8 real-file benchmark runner', () => {
  it('measures production T3 over an isolated cloned baseline', () => {
    const cases = runG8BenchmarkCases({
      rootDir: temporaryRoot('icarus-g8-t3-runner-'),
      identityMode: 'candidate_development',
      warmupIterations: 0,
      measurementIterations: 1,
      profiles: ['smoke', 'beyond_limit'],
      transactions: ['t3'],
      shapes: { t3: ['long_chain'] },
    });
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      transaction: 't3',
      shape: 'long_chain',
      profile: 'smoke',
      production_entry: 'reconcileFactT3a',
      beyond_limit_rejection: null,
    });
    expect(cases[0]!.statistics!.affected_rows).toBeGreaterThan(0);
    expect(cases[1]!.beyond_limit_rejection).toMatchObject({
      status: 'rejected_before_atomic_write',
      affected_rows: 0,
    });
  }, 60_000);

  it('measures every production T7 root-fence shape with staged subtree IDs', () => {
    const cases = runG8BenchmarkCases({
      rootDir: temporaryRoot('icarus-g8-t7-runner-'),
      identityMode: 'candidate_development',
      warmupIterations: 0,
      measurementIterations: 1,
      profiles: ['smoke'],
      transactions: ['t7'],
    });
    expect(cases).toHaveLength(5);
    expect(cases[0]).toMatchObject({
      transaction: 't7',
      shape: 'deep_tree',
      profile: 'smoke',
      production_entry: 'requestScopeCloseT7a',
      beyond_limit_rejection: null,
    });
    for (const benchmarkCase of cases)
      expect(benchmarkCase.statistics!.affected_rows).toBeGreaterThan(0);
  }, 60_000);

  it('seeds two distinct 128-item manifests at the supported nested-map limit', () => {
    const cases = runG8BenchmarkCases({
      rootDir: temporaryRoot('icarus-g8-t7-supported-map-runner-'),
      identityMode: 'candidate_development',
      warmupIterations: 0,
      measurementIterations: 1,
      profiles: ['supported_limit'],
      transactions: ['t7'],
      shapes: { t7: ['large_nested_map'] },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.dimensions).toMatchObject({
      max_map_items_total: 256,
      max_subtree_map_slots_per_fence: 256,
      observed_max_items_per_map: 128,
    });
    expect(cases[0]!.statistics!.affected_rows).toBeGreaterThan(0);
  }, 120_000);

  it('measures every production T8 required-child atomic shape', () => {
    const cases = runG8BenchmarkCases({
      rootDir: temporaryRoot('icarus-g8-t8-runner-'),
      identityMode: 'candidate_development',
      warmupIterations: 0,
      measurementIterations: 1,
      profiles: ['smoke'],
      transactions: ['t8'],
    });
    expect(cases).toHaveLength(4);
    expect(cases[0]).toMatchObject({
      transaction: 't8',
      shape: 'maximum_required_child',
      profile: 'smoke',
      production_entry: 'commitRootT8',
      beyond_limit_rejection: null,
    });
    for (const benchmarkCase of cases)
      expect(benchmarkCase.statistics!.affected_rows).toBeGreaterThan(0);
  }, 60_000);
});
