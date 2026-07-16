import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  assertHistoricalG0_9Conformance,
  CAPACITY_BASELINE_HISTORICAL_HASH,
  CAPACITY_SCHEMA_HISTORICAL_HASH,
  G0_10_HISTORICAL_IDENTITIES,
  G0_9_HISTORICAL_ROOT_HASH,
  G0_9_HISTORICAL_TOOL_HASH,
} from './capacity-control-plane-source.js';
import { g0ConformanceToolHash } from './g0-conformance-source.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

describe('G0.9 historical conformance identity', () => {
  it('pins the historical root, generator, member closure, and prior slice hashes', () => {
    const manifest = assertHistoricalG0_9Conformance();
    expect(manifest.hash).toBe(G0_9_HISTORICAL_ROOT_HASH);
    expect(g0ConformanceToolHash()).toBe(G0_9_HISTORICAL_TOOL_HASH);
    expect(manifest.payload.prior_manifest_hashes).toEqual({
      'G0.2': G0_10_HISTORICAL_IDENTITIES['G0.2'],
      'G0.3': G0_10_HISTORICAL_IDENTITIES['G0.3'],
      'G0.4': G0_10_HISTORICAL_IDENTITIES['G0.4'],
      'G0.5': G0_10_HISTORICAL_IDENTITIES['G0.5'],
      'G0.6': G0_10_HISTORICAL_IDENTITIES['G0.6'],
      'G0.7': G0_10_HISTORICAL_IDENTITIES['G0.7'],
      'G0.8': G0_10_HISTORICAL_IDENTITIES['G0.8'],
    });
  });

  it('pins the historical Capacity schema and bootstrap baseline identities', () => {
    expect(
      readArtifact('safety/deployment-runtime-capacity-schema.json').hash,
    ).toBe(CAPACITY_SCHEMA_HISTORICAL_HASH);
    const baseline = strictParseJsonBytes(
      fs.readFileSync(
        path.join(repoRoot, 'config/workflow-runtime-capacity.json'),
      ),
    ) as Record<string, unknown>;
    expect(baseline.config_hash).toBe(CAPACITY_BASELINE_HISTORICAL_HASH);
  });

  it('is read-only across repeated historical verification', () => {
    const manifest = readArtifact('contract-pack-g0-conformance-exit.json');
    const paths = [
      'contract-pack-g0-conformance-exit.json',
      ...(manifest.payload.artifacts as Array<{ path: string }>).map(
        (artifact) => artifact.path,
      ),
    ];
    const before = new Map(
      paths.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );
    assertHistoricalG0_9Conformance();
    assertHistoricalG0_9Conformance();
    for (const [relativePath, bytes] of before)
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
  });
});
