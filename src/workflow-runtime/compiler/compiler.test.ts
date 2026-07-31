import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkG2ProductionCompilerArtifacts,
  G2_PRODUCTION_COMPILER_ROOT_DOMAIN,
} from './artifacts.js';
import { G2_CANDIDATE_ROOT } from './conformance.js';
import { assertCurrentG2SealedBoundary } from '../contracts/current-g2-sealed-boundary.js';

const compilerRoot = import.meta.dirname;
const contractsRoot = path.resolve(compilerRoot, '../contracts');

function treeDigest(relativeRoot: string): string {
  const root = path.join(contractsRoot, relativeRoot);
  const hash = crypto.createHash('sha256');
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else {
        hash.update(path.relative(root, absolute), 'utf8');
        hash.update(fs.readFileSync(absolute));
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

describe('frozen G2 Production Compiler publication', () => {
  it('checks the historical candidate without rebuilding or changing it', () => {
    const before = treeDigest(G2_CANDIDATE_ROOT);
    const first = checkG2ProductionCompilerArtifacts();
    const middle = treeDigest(G2_CANDIDATE_ROOT);
    const second = checkG2ProductionCompilerArtifacts();
    expect(first.hash).toBe(
      'sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77',
    );
    expect(first.domain_separator).toBe(G2_PRODUCTION_COMPILER_ROOT_DOMAIN);
    expect(second.hash).toBe(first.hash);
    expect(middle).toBe(before);
    expect(treeDigest(G2_CANDIDATE_ROOT)).toBe(before);
  });

  it('keeps the historical candidate manifest frozen', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          contractsRoot,
          G2_CANDIDATE_ROOT,
          'candidate-results-manifest@1.json',
        ),
        'utf8',
      ),
    ) as {
      manifest_hash: string;
      compiled_count: number;
      rejected_count: number;
    };
    expect(manifest.manifest_hash).toBe(
      'sha256:c471bcf03ea23ce2d84d5a785b026ae222ec47f7d5fd5948bb8e19c89904b1d2',
    );
    expect(manifest.compiled_count).toBe(10);
    expect(manifest.rejected_count).toBe(30);
  });

  it('recognizes the exact Golden seal and current post-G2 boundaries', () => {
    expect(
      assertCurrentG2SealedBoundary(
        path.join(contractsRoot, 'conformance/sealed'),
      ),
    ).toBe('current_g2');
    expect(
      fs.readdirSync(path.join(compilerRoot, '../authoring')).sort(),
    ).toEqual([
      'feature-release-activation.test.ts',
      'feature-release-activation.ts',
      'workflow-publisher.test.ts',
      'workflow-publisher.ts',
    ]);
    expect(
      fs.readdirSync(path.join(compilerRoot, '../registry')).sort(),
    ).toEqual([
      'production-activation-entry.ts',
      'production-activation-runtime.ts',
      'production-activation.test.ts',
      'production-activation.ts',
    ]);
  });
});
