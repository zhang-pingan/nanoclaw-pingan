import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  G32A_PROFILE_SCHEMA,
  G32A_RESULT_SCHEMA,
  checkG32AFeatureManifestIntake,
  g32aFeatureManifestIntakeFixturesForTest,
  parseAndEvaluateG32AFeatureManifest,
} from './g3-2a-feature-manifest-intake.js';
import type { G32AIntakeResult } from './g3-2a-feature-manifest-intake-types.js';

const contractsRoot = import.meta.dirname;

describe('G3.2A Feature Manifest vNext strict intake semantics', () => {
  it('checks generated artifacts and validates both closed schemas', () => {
    const pack = checkG32AFeatureManifestIntake();
    const ajv = new Ajv2020({ strict: true });
    const profile = JSON.parse(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'registry/feature-manifest-vnext-strict-intake-profile@1.json',
        ),
        'utf8',
      ),
    ) as { payload: AnySchema };
    const profileSchemaArtifact = JSON.parse(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'registry/feature-manifest-vnext-strict-intake-profile-schema@1.json',
        ),
        'utf8',
      ),
    ) as { payload: AnySchema };
    const resultSchema = JSON.parse(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'registry/feature-manifest-vnext-strict-intake-result-schema@1.json',
        ),
        'utf8',
      ),
    ) as { payload: AnySchema };
    expect(ajv.validate(profileSchemaArtifact.payload, profile.payload)).toBe(
      true,
    );
    expect(
      ajv.validate(resultSchema.payload as AnySchema, {
        format: 'icarus.workflow-feature-manifest-vnext-strict-intake-result/1',
        outcome: 'rejected',
        code: 'feature_manifest_unknown_field',
        phase: 'removed_unknown_structural_intake',
        diagnostics: [
          {
            code: 'feature_manifest_unknown_field',
            phase: 'removed_unknown_structural_intake',
            pointer: '/unexpected',
            detail: 'x',
          },
        ],
        feature_id: null,
        manifest_hash: null,
        reader_invoked: false,
        resolver_invoked: false,
        root_snapshot_status: 'not_invoked',
        source_hash_status: 'not_invoked',
        dependency_resolution_status: 'not_attempted',
      }),
    ).toBe(true);
    expect(pack.payload.registry_write_performed).toBe(false);
    expect(pack.payload.publisher_executed).toBe(false);
    expect(pack.payload.activation_performed).toBe(false);
  });

  it('covers every positive and negative fixture deterministically', () => {
    const fixtures = g32aFeatureManifestIntakeFixturesForTest();
    expect(fixtures.positive.length).toBeGreaterThanOrEqual(2);
    expect(fixtures.negative.length).toBeGreaterThanOrEqual(10);
    for (const fixture of fixtures.positive) {
      expect(fixture.expected.outcome, fixture.case_id).toBe('accepted');
      expect(
        parseAndEvaluateG32AFeatureManifest(
          Buffer.from(fixture.input_text),
          fixture.observations,
        ),
      ).toEqual(fixture.expected);
    }
    for (const fixture of fixtures.negative) {
      expect(fixture.expected.outcome, fixture.case_id).toBe('rejected');
      const replay = parseAndEvaluateG32AFeatureManifest(
        Buffer.from(fixture.input_text),
        fixture.observations,
      );
      expect(replay.code, fixture.case_id).toBe(fixture.expected.code);
      expect(replay.phase, fixture.case_id).toBe(fixture.expected.phase);
    }
  });

  it('freezes the required precedence matrix', () => {
    const fixtures = g32aFeatureManifestIntakeFixturesForTest();
    const codes = new Map(
      fixtures.negative.map((fixture) => [
        fixture.case_id,
        fixture.expected.code,
      ]),
    );
    expect(codes.get('precedence-duplicate-key-before-unknown-and-hash')).toBe(
      'feature_manifest_json_duplicate_key',
    );
    expect(codes.get('precedence-removed-before-unknown')).toBe(
      'feature_manifest_removed_resource_key',
    );
    expect(codes.get('unknown-field-before-schema')).toBe(
      'feature_manifest_unknown_field',
    );
    expect(codes.get('hash-before-ownership-order-path')).toBe(
      'feature_manifest_hash_mismatch',
    );
    expect(codes.get('ownership-before-order-and-path')).toBe(
      'feature_manifest_ownership_invalid',
    );
    expect(codes.get('moving-root-after-lexical-validation')).toBe(
      'feature_manifest_source_root_moved',
    );
    expect(codes.get('source-hash-drift-after-path-read')).toBe(
      'feature_manifest_source_hash_mismatch',
    );
    expect(codes.get('dependency-resolution-last')).toBe(
      'feature_manifest_dependency_unresolved',
    );
  });

  it('does not read source_path or perform Registry/Publisher/Activation work', () => {
    const source = fs.readFileSync(
      path.join(contractsRoot, 'g3-2a-feature-manifest-intake.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/readFileSync\([^)]*source_path/);
    expect(source).not.toMatch(/registry\.(write|insert|update|activate)/i);
    expect(source).not.toMatch(
      /Publisher|Production loader|FeatureRelease\.activate/,
    );
    expect(G32A_RESULT_SCHEMA.properties).toBeDefined();
    expect(
      (G32A_RESULT_SCHEMA as { additionalProperties?: unknown })
        .additionalProperties,
    ).toBe(false);
  });
});
