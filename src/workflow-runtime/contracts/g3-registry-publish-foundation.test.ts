import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { FEATURE_WORKFLOW_RESOURCE_KINDS } from './closed-schema-types.js';
import {
  checkG3RegistryPublishFoundation,
  evaluateG3RegistryPublishPreflight,
  G3_REGISTRY_PUBLISH_FOUNDATION_PATH,
  G3_REGISTRY_PUBLISH_PREFLIGHT_RESULT_SCHEMA,
  G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA,
  g3RegistryPublishFixturesForTest,
  parseAndEvaluateG3RegistryPublishPreflight,
} from './g3-registry-publish-foundation.js';
import { G3_REGISTRY_RESOURCE_TYPES } from './g3-registry-publish-types.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;
const workflowRuntimeRoot = path.resolve(contractsRoot, '..');

function artifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

describe('G3.1 Registry publish preflight foundation', () => {
  it('checks deterministic current schemas and Compiler semantic version read-only', () => {
    const first = checkG3RegistryPublishFoundation();
    const second = checkG3RegistryPublishFoundation();
    expect(second).toEqual(first);
    expect(first.payload).toMatchObject({
      gate: 'G3',
      slice: 'G3.1',
      status: 'DONE',
      g3_status: 'IN_PROGRESS',
      compiler_version: WORKFLOW_COMPILER_VERSION,
      production_registry_write_performed: false,
      published_recipe_count: 0,
      g4_through_g9_status: 'NOT_READY',
    });
    expect(artifact(G3_REGISTRY_PUBLISH_FOUNDATION_PATH).payload).toMatchObject(
      {
        implemented_surface: 'read_only_registry_publish_preflight_contract',
        slice_status: 'DONE',
        g3_status: 'IN_PROGRESS',
      },
    );
  });

  it('accepts an empty Production Registry and an isolated test-only closure', () => {
    const fixtures = g3RegistryPublishFixturesForTest();
    expect(fixtures.positive).toHaveLength(3);
    for (const testCase of fixtures.positive) {
      expect(evaluateG3RegistryPublishPreflight(testCase.input)).toEqual(
        testCase.expected_result,
      );
    }
    expect(fixtures.positive[0].expected_result).toMatchObject({
      outcome: 'accepted',
      target_registry: 'production',
      resource_count: 0,
      recipe_count: 0,
      side_effects: 'none_by_contract',
    });
    expect(fixtures.positive[1].expected_result).toMatchObject({
      outcome: 'accepted',
      target_registry: 'test_only',
      resource_count: 2,
      recipe_count: 0,
      side_effects: 'none_by_contract',
    });
    expect(fixtures.positive[0].input.resources).toEqual([]);
    expect(
      fixtures.positive[1].input.resources.every(
        (resource) => resource.launchability === 'test_only',
      ),
    ).toBe(true);
    expect(fixtures.positive[2].expected_result).toMatchObject({
      outcome: 'accepted',
      target_registry: 'test_only',
      resource_count: 3,
      recipe_count: 0,
      side_effects: 'none_by_contract',
    });
  });

  it('rejects every closed-world, identity, pinning, and side-effect negative fixture', () => {
    const fixtures = g3RegistryPublishFixturesForTest();
    expect(fixtures.negative.length).toBeGreaterThanOrEqual(19);
    for (const testCase of fixtures.negative) {
      expect(evaluateG3RegistryPublishPreflight(testCase.input)).toMatchObject({
        outcome: 'rejected',
        code: testCase.expected_code,
        dependency_closure_hash: null,
        side_effects: 'none_by_contract',
      });
    }
    expect(
      Object.fromEntries(
        fixtures.negative
          .filter((testCase) =>
            testCase.case_id.startsWith('negative.capability-outbox-'),
          )
          .map((testCase) => [testCase.case_id, testCase.expected_code]),
      ),
    ).toEqual({
      'negative.capability-outbox-binding-missing':
        'capability_outbox_binding_required',
      'negative.capability-outbox-policy-hash-mismatch':
        'capability_outbox_binding_mismatch',
      'negative.capability-outbox-latest-adapter': 'schema_invalid',
      'negative.capability-outbox-test-only-production':
        'test_only_promotion_forbidden',
    });
  });

  it('publishes closed Draft 2020-12 input and result schemas', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validateInput = ajv.compile(
      G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA as AnySchema,
    );
    const validateResult = ajv.compile(
      G3_REGISTRY_PUBLISH_PREFLIGHT_RESULT_SCHEMA as AnySchema,
    );
    const fixtures = g3RegistryPublishFixturesForTest();
    for (const testCase of fixtures.positive) {
      expect(
        validateInput(testCase.input),
        JSON.stringify(validateInput.errors),
      ).toBe(true);
      expect(
        validateResult(testCase.expected_result),
        JSON.stringify(validateResult.errors),
      ).toBe(true);
    }
    const unknown = structuredClone(fixtures.positive[0].input) as Record<
      string,
      unknown
    >;
    unknown.implicit_default = true;
    expect(validateInput(unknown)).toBe(false);
    expect(new Set(G3_REGISTRY_RESOURCE_TYPES)).toEqual(
      new Set([
        ...FEATURE_WORKFLOW_RESOURCE_KINDS,
        'feature_execution_artifact',
        'outbox_adapter',
      ]),
    );
  });

  it('strictly rejects duplicate JSON keys before preflight evaluation', () => {
    expect(() =>
      parseAndEvaluateG3RegistryPublishPreflight(
        Buffer.from('{"format":"x","format":"y"}', 'utf8'),
      ),
    ).toThrow(/Duplicate object key/);
  });

  it('reads only the Compiler semantic version and no execution or release implementation', () => {
    const source = fs.readFileSync(
      path.join(contractsRoot, 'g3-registry-publish-foundation.ts'),
      'utf8',
    );
    expect(source).toContain("from '../compiler/version.js'");
    expect(source).not.toMatch(/from ['"].*\/compiler\/(?!version\.js)/);
    expect(source).not.toMatch(/--accept|snapshot update/i);
    for (const forbidden of [
      '../registry/release-publisher',
      '../registry/feature-manifest',
      '../authoring/workflow-authoring',
      '../runtime/graph-runtime',
      '../projection/runtime-center-api',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    for (const relativePath of [
      'registry/release-publisher.ts',
      'registry/feature-manifest.ts',
      'registry/core-upgrade.ts',
      'authoring/workflow-authoring.ts',
    ]) {
      expect(fs.existsSync(path.join(workflowRuntimeRoot, relativePath))).toBe(
        false,
      );
    }
  });
});
