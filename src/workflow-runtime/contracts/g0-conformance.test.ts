import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildG0ConformanceExpectedArtifactsForTest,
  checkContractPackG0Conformance,
  evaluateG0ConformanceFixture,
  generateContractPackG0Conformance,
} from './g0-conformance-pack.js';
import {
  G0_CONFORMANCE_NEGATIVE_FIXTURES,
  G0_CONFORMANCE_POSITIVE_FIXTURES,
} from './g0-conformance-fixtures.js';
import {
  G0_1_IDENTITY_HASHES,
  G0_MARKDOWN_SEMANTIC_FORMATS,
  G0_PRIOR_MANIFEST_IDENTITIES,
} from './g0-conformance-source.js';
import type {
  G0ArtifactHashInventory,
  G0GateReview,
  G0MarkdownContractCoverage,
} from './g0-conformance-types.js';
import { parseContractArtifactEnvelope } from './artifact.js';
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

function readPayload<T>(relativePath: string): T {
  return readArtifact(relativePath).payload as unknown as T;
}

function rawSha256(relativePath: string): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repoRoot, relativePath)))
    .digest('hex')}`;
}

describe('G0.9 G0 Conformance Exit', () => {
  it('generates deterministically, keeps check read-only, and pins G0.1-G0.8 exact identities', () => {
    const first = generateContractPackG0Conformance();
    const tracked = [
      ...buildG0ConformanceExpectedArtifactsForTest().map(
        ([relativePath]) => relativePath,
      ),
      'contract-pack-g0-conformance-exit.json',
    ];
    const firstBytes = new Map(
      tracked.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );
    const second = generateContractPackG0Conformance();
    expect(second.hash).toBe(first.hash);
    expect(checkContractPackG0Conformance().hash).toBe(first.hash);
    for (const [relativePath, bytes] of firstBytes)
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    for (const identity of Object.values(G0_PRIOR_MANIFEST_IDENTITIES))
      expect(readArtifact(identity.path).hash).toBe(identity.hash);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(contractsRoot, 'toolchain/node-v26.5.0-darwin-arm64.json'),
          'utf8',
        ),
      ).manifest_hash,
    ).toBe(G0_1_IDENTITY_HASHES.managed_distribution_manifest);
  });

  it('covers Markdown and Contract Pack values in both directions', () => {
    const coverage = readPayload<G0MarkdownContractCoverage>(
      'conformance/g0-exit/markdown-contract-coverage@1.json',
    );
    expect(coverage.contract_values_without_markdown).toEqual([]);
    expect(coverage.markdown_values_without_contract).toEqual([]);
    expect(coverage.contract_value_count).toBe(coverage.entries.length);
    expect(coverage.markdown_value_count).toBe(coverage.entries.length);
    expect(coverage.category_counts).toMatchObject({
      semantic_format: 19,
      compiler_error_code: 27,
      runtime_fact_kind: 13,
      runtime_event_type: 39,
    });
    expect(
      coverage.entries
        .filter((entry) => entry.category === 'semantic_format')
        .map((entry) => entry.value)
        .sort(),
    ).toEqual(G0_MARKDOWN_SEMANTIC_FORMATS.map((seed) => seed.value).sort());
    expect(
      coverage.entries.every((entry) => entry.fixture_refs.length > 0),
    ).toBe(true);
  });

  it('inventories every G0.1-G0.8 identity, manifest member and raw source byte file', () => {
    const inventory = readPayload<G0ArtifactHashInventory>(
      'conformance/g0-exit/artifact-hash-inventory@1.json',
    );
    expect(inventory.entry_count).toBe(133);
    expect(inventory.class_counts).toEqual({
      toolchain_identity: 9,
      contract_manifest: 7,
      contract_artifact: 76,
      raw_source_bytes: 40,
      capacity_config: 1,
    });
    expect(inventory.duplicate_paths).toEqual([]);
    expect(inventory.missing_paths).toEqual([]);
    expect(new Set(inventory.entries.map((entry) => entry.path)).size).toBe(
      inventory.entry_count,
    );
    for (const entry of inventory.entries)
      expect(entry.raw_sha256, entry.path).toBe(rawSha256(entry.path));
  });

  it('records a passing G0 review while only unlocking G1 and G2', () => {
    const review = readPayload<G0GateReview>(
      'conformance/g0-exit/g0-gate-review@1.json',
    );
    expect(review.decision).toBe('pass');
    expect(review.slice_identities).toHaveLength(8);
    expect(review.exit_criteria).toHaveLength(9);
    expect(
      review.exit_criteria.every((criterion) => criterion.status === 'pass'),
    ).toBe(true);
    expect(review.gate_statuses).toEqual([
      { gate_id: 'G0', status: 'DONE' },
      { gate_id: 'G1', status: 'READY' },
      { gate_id: 'G2', status: 'READY' },
      ...Array.from({ length: 7 }, (_, index) => ({
        gate_id: `G${index + 3}`,
        status: 'NOT_READY',
      })),
    ]);
  });

  it('keeps Golden review pending, expected artifacts null, and sealed bytes absent', () => {
    const review = readPayload<G0GateReview>(
      'conformance/g0-exit/g0-gate-review@1.json',
    );
    expect(review.status_proof).toMatchObject({
      golden_review_request_status: 'pending',
      golden_review_report_status: 'not_run',
      golden_semantic_review_status: 'absent',
      golden_seal_status: 'not_run',
      sealed_bundle_status: 'absent',
      expected_plan_bytes_status: 'all_null',
      expected_plan_hash_status: 'all_null',
      expected_proof_program_hash_status: 'all_null',
    });
    expect(
      fs.readdirSync(path.join(contractsRoot, 'conformance/sealed')),
    ).toEqual(['.gitkeep']);
    const casesPayload = readPayload<Record<string, unknown>>(
      'conformance/draft/golden-draft-cases@1.json',
    );
    const cases = casesPayload.cases as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(40);
    expect(
      cases.every(
        (candidate) =>
          candidate.expected_plan_bytes_ref === null &&
          candidate.expected_plan_hash === null &&
          candidate.expected_proof_hashes === null &&
          candidate.expected_program_hashes === null,
      ),
    ).toBe(true);
  });

  it('keeps SQLite candidate/not-certified and future implementation artifacts absent', () => {
    const review = readPayload<G0GateReview>(
      'conformance/g0-exit/g0-gate-review@1.json',
    );
    expect(review.status_proof).toMatchObject({
      sqlite_profile_status: 'candidate',
      sqlite_certification_status: 'not_certified',
      executable_ddl_status: 'absent',
      schema_manifest_status: 'absent',
      workflow_runtime_store_status: 'absent',
      production_compiler_status: 'absent',
      golden_bundle_status: 'absent',
      registry_runtime_status: 'absent',
      runtime_center_ui_status: 'absent',
    });
  });

  it('executes all positive and negative G0 exit fixtures', () => {
    expect(G0_CONFORMANCE_POSITIVE_FIXTURES).toHaveLength(8);
    expect(G0_CONFORMANCE_NEGATIVE_FIXTURES).toHaveLength(20);
    for (const fixture of G0_CONFORMANCE_NEGATIVE_FIXTURES)
      expect(evaluateG0ConformanceFixture(fixture)).toBe(
        fixture.expected_error,
      );
  });

  it('keeps every G0.9 artifact closed, domain-covered and publicly buildable', () => {
    const artifacts = buildG0ConformanceExpectedArtifactsForTest();
    expect(artifacts).toHaveLength(9);
    const formats = new Set(artifacts.map(([, artifact]) => artifact.format));
    expect(formats.size).toBe(9);
    const manifest = checkContractPackG0Conformance();
    expect(manifest.payload.g0_status).toBe('DONE');
    expect(manifest.payload.g1_status).toBe('READY');
    expect(manifest.payload.g2_status).toBe('READY');
    expect(manifest.payload.certification_status).toBe('not_certified');
  });
});
