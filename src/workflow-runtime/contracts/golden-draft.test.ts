import fs from 'fs';
import path from 'path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { WORKFLOW_COMPILER_ERROR_CODES } from './catalog-protocol-types.js';
import {
  GOLDEN_DRAFT_NEGATIVE_FIXTURES,
  GOLDEN_DRAFT_POSITIVE_FIXTURES,
} from './golden-draft-fixtures.js';
import {
  buildGoldenDraftExpectedArtifactsForTest,
  checkContractPackGoldenDraft,
  evaluateGoldenDraftNegativeFixture,
  generateContractPackGoldenDraft,
} from './golden-draft-pack.js';
import { checkHistoricalGoldenDraft } from './golden-draft-historical.js';
import {
  GOLDEN_DRAFT_ADDITIONAL_NEGATIVE_COVERAGE,
  GOLDEN_DRAFT_CASE_SEEDS,
  GOLDEN_DRAFT_POSITIVE_COVERAGE,
} from './golden-draft-source.js';
import { domainSeparatedSha256 } from './hash.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function draftFiles(): string[] {
  const root = path.join(contractsRoot, 'conformance/draft');
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile())
        files.push(
          path.relative(contractsRoot, absolute).split(path.sep).join('/'),
        );
    }
  };
  visit(root);
  return files.sort();
}

describe('G0.8 Golden Draft and Review Input', () => {
  it('keeps the frozen draft check read-only and pins G0.2-G0.7 identities', () => {
    const first = checkHistoricalGoldenDraft();
    const tracked = [
      ...draftFiles(),
      'catalogs/golden-draft-domain-separators.json',
      'contract-pack-golden-draft.json',
    ];
    const firstBytes = new Map(
      tracked.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );
    const second = checkHistoricalGoldenDraft();
    expect(second.hash).toBe(first.hash);
    for (const [relativePath, bytes] of firstBytes) {
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    }
    expect(readArtifact('contract-pack-foundation.json').hash).toBe(
      'sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d',
    );
    expect(readArtifact('contract-pack-closed-schemas.json').hash).toBe(
      'sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8',
    );
    expect(readArtifact('contract-pack-catalog-protocols.json').hash).toBe(
      'sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607',
    );
    expect(readArtifact('contract-pack-safety-sqlite.json').hash).toBe(
      'sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428',
    );
    expect(readArtifact('contract-pack-logical-schema.json').hash).toBe(
      'sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520',
    );
    expect(readArtifact('contract-pack-static-absence.json').hash).toBe(
      'sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2',
    );
  });

  it('stores complete raw bytes and validates every positive source against its closed authoring schema', () => {
    const catalog = readArtifact('conformance/draft/golden-draft-cases@1.json');
    const graphSchema = readArtifact('schemas/graph-scope-source-schema.json');
    const definitionSchema = readArtifact(
      'schemas/workflow-definition-schema.json',
    );
    const ajv = new Ajv2020({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    const validateGraph = ajv.compile(graphSchema.payload as AnySchema);
    const validateDefinition = ajv.compile(
      definitionSchema.payload as AnySchema,
    );
    const cases = catalog.payload.cases as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(40);
    for (const candidate of cases) {
      const relativePath = String(candidate.raw_source_bytes_ref);
      const bytes = fs.readFileSync(path.join(contractsRoot, relativePath));
      expect(bytes.byteLength).toBeGreaterThan(0);
      if (candidate.polarity !== 'positive') continue;
      const value = strictParseJsonBytes(bytes);
      const validate =
        candidate.source_kind === 'workflow_definition'
          ? validateDefinition
          : validateGraph;
      expect(
        validate(value),
        `${String(candidate.case_id)}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  it('covers all required positive topics, all 27 Compiler errors, and the removed Definition fields', () => {
    const catalog = readArtifact('conformance/draft/golden-draft-cases@1.json');
    const cases = catalog.payload.cases as Array<Record<string, unknown>>;
    const positive = cases.filter(
      (candidate) => candidate.polarity === 'positive',
    );
    const negative = cases.filter(
      (candidate) => candidate.polarity === 'negative',
    );
    expect(positive).toHaveLength(10);
    expect(negative).toHaveLength(30);
    const positiveTags = new Set(
      positive.flatMap((candidate) => candidate.coverage_tags as string[]),
    );
    expect(
      [...GOLDEN_DRAFT_POSITIVE_COVERAGE].every((tag) => positiveTags.has(tag)),
    ).toBe(true);
    const errorCodes = new Set(
      negative.flatMap((candidate) =>
        (candidate.expected_diagnostics as Array<Record<string, string>>).map(
          (diagnostic) => diagnostic.code,
        ),
      ),
    );
    expect(
      [...WORKFLOW_COMPILER_ERROR_CODES].every((code) => errorCodes.has(code)),
    ).toBe(true);
    const allTags = new Set(
      cases.flatMap((candidate) => candidate.coverage_tags as string[]),
    );
    expect(
      [...GOLDEN_DRAFT_ADDITIONAL_NEGATIVE_COVERAGE].every((tag) =>
        allTags.has(tag),
      ),
    ).toBe(true);
  });

  it('keeps every candidate Plan, proof and program artifact null pending independent review', () => {
    const catalog = readArtifact('conformance/draft/golden-draft-cases@1.json');
    const cases = catalog.payload.cases as Array<Record<string, unknown>>;
    for (const candidate of cases) {
      expect(candidate.expected_plan_bytes_ref).toBeNull();
      expect(candidate.expected_plan_hash).toBeNull();
      expect(candidate.expected_proof_hashes).toBeNull();
      expect(candidate.expected_program_hashes).toBeNull();
      expect(candidate.review_status).toBe('pending_human_review');
      expect(candidate.normalized_semantic_assertions).not.toEqual([]);
    }
  });

  it('freezes complete Registry, Interface, Policy and Safety input snapshots', () => {
    for (const relativePath of [
      'conformance/draft/snapshots/complete-base@1.json',
      'conformance/draft/snapshots/compiler-integrity-mismatch@1.json',
    ]) {
      const artifact = readArtifact(relativePath);
      const payload = artifact.payload;
      const registry = payload.registry_snapshot as Record<string, unknown>;
      const interfaces = payload.interface_snapshot as Record<string, unknown>;
      const policy = payload.policy_snapshot as Record<string, unknown>;
      const safety = payload.safety_snapshot as Record<string, unknown>;
      expect(payload.launchability).toBe('test_only');
      expect((registry.resources as unknown[]).length).toBeGreaterThanOrEqual(
        20,
      );
      expect(registry.resource_count).toBe(
        (registry.resources as unknown[]).length,
      );
      expect(interfaces.interfaces as unknown[]).toHaveLength(2);
      expect(policy.complete_policy).toBeTruthy();
      expect(safety.profile_id).toBe('local_single_user_safety@1');
      expect(safety.source_artifact_hash).toBe(
        readArtifact('safety/local_single_user_safety@1.json').hash,
      );
    }
  });

  it('binds immutable review input to human:local-owner without creating an approval or report', () => {
    const draft = readArtifact(
      'conformance/draft/golden-draft-manifest@1.json',
    );
    const request = readArtifact(
      'conformance/draft/golden-review-request@1.json',
    );
    const reportInput = readArtifact(
      'conformance/draft/golden-review-report-input@1.json',
    );
    expect(draft.payload.review_owner_actor_ref).toBe('human:local-owner');
    expect(draft.payload.golden_semantic_review_status).toBe('absent');
    expect(draft.payload.sealed_bundle_status).toBe('absent');
    expect(request.payload.draft_manifest_hash).toBe(draft.hash);
    expect(request.payload.requested_reviewer_actor_ref).toBe(
      'human:local-owner',
    );
    expect(request.payload.semantic_decision_status).toBe('pending');
    expect(request.payload.approval_record_status).toBe('absent');
    expect(reportInput.payload.review_request_hash).toBe(request.hash);
    expect(reportInput.payload.report_generation_status).toBe('not_run');
    expect(reportInput.payload.semantic_decision_status).toBe('pending');
  });

  it('executes all G0.8 contract positive and negative fixtures', () => {
    expect(GOLDEN_DRAFT_POSITIVE_FIXTURES).toHaveLength(8);
    expect(GOLDEN_DRAFT_NEGATIVE_FIXTURES).toHaveLength(25);
    for (const fixture of GOLDEN_DRAFT_NEGATIVE_FIXTURES) {
      expect(evaluateGoldenDraftNegativeFixture(fixture)).toBe(
        fixture.expected_error,
      );
    }
  });

  it('keeps closed schemas, domain coverage and raw source aggregate hash self-consistent', () => {
    const artifacts = buildGoldenDraftExpectedArtifactsForTest();
    const schemas = artifacts.filter(([relativePath]) =>
      relativePath.startsWith('conformance/draft/schemas/'),
    );
    expect(schemas).toHaveLength(5);
    for (const [, schema] of schemas) {
      expect(schema.payload.additionalProperties).toBe(false);
      expect(schema.payload.required).toEqual(
        Object.keys(schema.payload.properties as Record<string, unknown>),
      );
    }
    const domain = readArtifact('catalogs/golden-draft-domain-separators.json');
    expect((domain.payload.entries as unknown[]).length).toBeGreaterThan(10);
    const catalog = readArtifact('conformance/draft/golden-draft-cases@1.json');
    const draft = readArtifact(
      'conformance/draft/golden-draft-manifest@1.json',
    );
    const cases = catalog.payload.cases as Array<Record<string, unknown>>;
    const aggregate = domainSeparatedSha256(
      'icarus:workflow-golden-draft-raw-source-aggregate:1\n',
      cases.map((candidate) => ({
        case_id: candidate.case_id as string,
        raw_source_bytes_ref: candidate.raw_source_bytes_ref as string,
        raw_source_bytes_hash: candidate.raw_source_bytes_hash as string,
      })),
    );
    expect(draft.payload.raw_source_aggregate_hash).toBe(aggregate);
  });

  it('keeps sealing, Compiler, Store, Registry, Runtime Center and certification absent', () => {
    expect(
      fs.readdirSync(path.join(contractsRoot, 'conformance/sealed')),
    ).toEqual(['.gitkeep']);
    const manifest = readArtifact('contract-pack-golden-draft.json');
    expect(manifest.payload).toMatchObject({
      gate: 'G0.8',
      golden_semantic_review_status: 'absent',
      golden_seal_status: 'not_run',
      sealed_bundle_status: 'absent',
      production_compiler_status: 'absent',
      executable_ddl_status: 'absent',
      workflow_runtime_store_status: 'absent',
      registry_runtime_status: 'absent',
      runtime_center_ui_status: 'absent',
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
    });
    expect(
      fs.existsSync(path.join(contractsRoot, '../compiler/graph-compiler.ts')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(contractsRoot, '../store/runtime-store.ts')),
    ).toBe(false);
    expect(GOLDEN_DRAFT_CASE_SEEDS).toHaveLength(40);
  });
});
