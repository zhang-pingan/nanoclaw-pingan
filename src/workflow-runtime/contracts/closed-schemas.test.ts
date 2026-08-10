import fs from 'fs';
import path from 'path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  CLOSED_SCHEMA_DESCRIPTORS,
  CLOSED_SCHEMA_UNIONS,
} from './closed-schema-artifacts.js';
import {
  CLOSED_SCHEMA_NEGATIVE_CASES,
  CLOSED_SCHEMA_POSITIVE_CASES,
} from './closed-schema-fixtures.js';
import {
  checkContractPackClosedSchemas,
  generateContractPackClosedSchemas,
} from './closed-schema-pack.js';
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

describe('G0.3 closed schema Contract Pack', () => {
  it('checks all generated artifacts without mutating their bytes', () => {
    const trackedPaths = [
      'contract-pack-foundation.json',
      'contract-pack-closed-schemas.json',
      'catalogs/foundation-domain-separators.json',
      'catalogs/closed-schema-domain-separators.json',
      'conformance/closed-schemas/positive-cases.json',
      'conformance/closed-schemas/negative-cases.json',
      ...CLOSED_SCHEMA_DESCRIPTORS.map(
        (descriptor) => descriptor.artifact_path,
      ),
    ];
    const generated = generateContractPackClosedSchemas();
    expect(generateContractPackClosedSchemas().hash).toBe(generated.hash);
    const before = new Map(
      trackedPaths.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );

    const manifest = checkContractPackClosedSchemas();
    expect(manifest.payload.gate).toBe('G0.3');
    for (const [relativePath, bytes] of before) {
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    }
  });

  it('validates every positive fixture and rejects every negative fixture', () => {
    const ajv = new Ajv2020({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
    });
    const validators = new Map(
      CLOSED_SCHEMA_DESCRIPTORS.map((descriptor) => [
        descriptor.artifact_format,
        ajv.compile(
          readArtifact(descriptor.artifact_path).payload as AnySchema,
        ),
      ]),
    );

    for (const testCase of CLOSED_SCHEMA_POSITIVE_CASES) {
      const validate = validators.get(testCase.schema_format)!;
      expect(validate(testCase.instance), testCase.case_id).toBe(true);
    }
    for (const testCase of CLOSED_SCHEMA_NEGATIVE_CASES) {
      const validate = validators.get(testCase.schema_format)!;
      expect(validate(testCase.instance), testCase.case_id).toBe(false);
    }
  });

  it('freezes the complete state, node, command, and pack resource unions', () => {
    expect(CLOSED_SCHEMA_UNIONS.workflow_state_types).toEqual([
      'delegation',
      'system',
      'interrupt',
      'graph',
      'terminal',
    ]);
    expect(CLOSED_SCHEMA_UNIONS.graph_node_types).toEqual([
      'delegation',
      'system',
      'wait',
      'join',
      'subgraph',
      'expand',
      'map',
      'terminal',
    ]);
    expect(CLOSED_SCHEMA_UNIONS.command_types).toHaveLength(13);
    expect(CLOSED_SCHEMA_UNIONS.command_reason_codes).toHaveLength(17);
    expect(CLOSED_SCHEMA_UNIONS.pack_resource_kinds).toHaveLength(23);
    expect(CLOSED_SCHEMA_UNIONS.value_binding_sources).toEqual([
      'workflow_input',
      'context_slot',
      'completed_output',
      'artifact',
      'constant',
    ]);
    expect(CLOSED_SCHEMA_UNIONS.graph_input_binding_sources).toEqual([
      'workflow_input',
      'context_slot',
      'artifact',
      'constant',
    ]);
    expect(CLOSED_SCHEMA_UNIONS.transition_effect_input_sources).toEqual([
      'context_slot',
      'completed_output',
      'constant',
    ]);
  });

  it('pins explicit regressions for removed Definition, Transition, and Pack fields', () => {
    const caseIds = new Set(
      CLOSED_SCHEMA_NEGATIVE_CASES.map((testCase) => testCase.case_id),
    );
    for (const expectedCaseId of [
      'definition_rejects_legacy_role',
      'transition_rejects_notification_delivery_requirement',
      'transition_rejects_child_creation_key_template',
      'transition_rejects_both_child_delivery_policies',
      'pack_manifest_rejects_workflowDefinitions',
      'pack_manifest_rejects_cards',
      'pack_manifest_rejects_artifactContracts',
      'pack_manifest_rejects_workflowEvaluators',
      'pack_manifest_rejects_parent_source_path',
      'source_rejects_loop_node',
      'compiled_plan_rejects_unknown_field',
      'compiled_plan_rejects_unknown_generated_schema_scheme',
      'compiled_plan_rejects_missing_generated_schema_json',
      'compiled_plan_rejects_both_artifact_contract_choices',
    ]) {
      expect(caseIds.has(expectedCaseId), expectedCaseId).toBe(true);
    }
  });
});
