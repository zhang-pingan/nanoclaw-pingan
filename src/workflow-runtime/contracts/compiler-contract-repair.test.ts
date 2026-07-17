import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  COMPILER_G2_EXACT_IDENTITY_FIELDS,
  type CompilerG2CaseInputBindingV1,
  type DefinitionStaticLoweringContractV1,
  type GoldenDraftCaseCatalogV2,
  type WorkflowCompilerConformanceCaseResultV1,
} from './compiler-contract-repair-types.js';
import {
  COMPILER_CONTRACT_REPAIR_ARTIFACT_COUNT,
  buildCompiledPlanV2SampleForTest,
  buildCompilerContractRepairExpectedArtifactsForTest,
  checkContractPackCompilerContractRepair,
  generateContractPackCompilerContractRepair,
} from './compiler-contract-repair-pack.js';
import {
  COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
  COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
  COMPILER_CONTRACT_REPAIR_ROOT,
  COMPILER_CONTRACT_REPAIR_SPEC_PATH,
  COMPILER_CONTRACT_REPAIR_SPEC_SECTION,
  G2_CASE_INPUT_BINDING_DOMAIN_SEPARATOR,
  G2_CASE_INPUT_DOMAIN_SEPARATOR,
  HISTORICAL_COMPILED_IR_SCHEMA_HASH,
  HISTORICAL_COMPILED_IR_SCHEMA_RAW_SHA256,
  HISTORICAL_G0_3_MANIFEST_HASH,
  HISTORICAL_G0_8_CASE_CATALOG_HASH,
  HISTORICAL_G0_8_CASE_CATALOG_RAW_SHA256,
  HISTORICAL_G0_8_MANIFEST_HASH,
  assertHistoricalCompilerContractInputs,
  calculateCompilerConformanceCaseResultHash,
  calculateEffectiveG2CaseInputHash,
  calculateG2CaseInputBindingHash,
  compilerContractRepairSpecSectionBytes,
  compilerContractRepairSpecSectionHash,
  extractCompilerContractRepairSpecSectionBytes,
  validateSemanticHash,
} from './compiler-contract-repair-source.js';
import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import { strictParseJson, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import { historicalContractTreeDigest } from '../store/schema/artifacts.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');
const workflowRuntimeRoot = path.resolve(contractsRoot, '..');
const HASH = `sha256:${'0'.repeat(64)}` as Sha256Hash;

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function clone<T extends JsonValue>(value: T): T {
  return strictParseJson(JSON.stringify(value)) as T;
}

function repairFiles(): string[] {
  const root = path.join(contractsRoot, COMPILER_CONTRACT_REPAIR_ROOT);
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

function rawSha256(relativePath: string): Sha256Hash {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(contractsRoot, relativePath)))
    .digest('hex')}`;
}

function artifactByFormat(format: string): ContractArtifactEnvelope {
  const artifact = buildCompilerContractRepairExpectedArtifactsForTest().find(
    ([, candidate]) => candidate.format === format,
  )?.[1];
  if (!artifact) throw new Error(`Missing test artifact: ${format}`);
  return artifact;
}

function validatorForSchema(relativePath: string): ValidateFunction {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  return ajv.compile(readArtifact(relativePath).payload as AnySchema);
}

function validatorForPlanDefinition(definition: string): ValidateFunction {
  const schema = readArtifact(
    `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
  ).payload;
  return new Ajv2020({ strict: true, allErrors: true }).compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: schema.$defs,
    $ref: `#/$defs/${definition}`,
  } as AnySchema);
}

describe('R-016 Compiler spec and Contract repair', () => {
  it('generates deterministically and keeps the check path read-only', () => {
    const first = generateContractPackCompilerContractRepair();
    const files = repairFiles();
    const firstBytes = new Map(
      files.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );

    const second = generateContractPackCompilerContractRepair();
    expect(second.hash).toBe(first.hash);
    expect(checkContractPackCompilerContractRepair().hash).toBe(first.hash);
    expect(files).toHaveLength(COMPILER_CONTRACT_REPAIR_ARTIFACT_COUNT + 1);
    expect(first.payload.artifact_count).toBe(
      COMPILER_CONTRACT_REPAIR_ARTIFACT_COUNT,
    );
    for (const [relativePath, bytes] of firstBytes)
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
  });

  it('pins G0.3 and G0.8 semantic identities and historical raw bytes', () => {
    expect(() => assertHistoricalCompilerContractInputs()).not.toThrow();
    expect(readArtifact('contract-pack-closed-schemas.json').hash).toBe(
      HISTORICAL_G0_3_MANIFEST_HASH,
    );
    expect(readArtifact('contract-pack-golden-draft.json').hash).toBe(
      HISTORICAL_G0_8_MANIFEST_HASH,
    );
    expect(
      readArtifact(
        'conformance/capacity-control-plane-addendum/contract-pack-capacity-control-plane-addendum.json',
      ).hash,
    ).toBe(
      'sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec',
    );
    expect(readArtifact('schemas/compiled-scope-plan-schema.json').hash).toBe(
      HISTORICAL_COMPILED_IR_SCHEMA_HASH,
    );
    expect(
      readArtifact('conformance/draft/golden-draft-cases@1.json').hash,
    ).toBe(HISTORICAL_G0_8_CASE_CATALOG_HASH);
    expect(rawSha256('schemas/compiled-scope-plan-schema.json')).toBe(
      HISTORICAL_COMPILED_IR_SCHEMA_RAW_SHA256,
    );
    expect(rawSha256('conformance/draft/golden-draft-cases@1.json')).toBe(
      HISTORICAL_G0_8_CASE_CATALOG_RAW_SHA256,
    );
    const sectionBytes = compilerContractRepairSpecSectionBytes();
    expect(sectionBytes.toString('utf8')).toMatch(
      new RegExp(`^${COMPILER_CONTRACT_REPAIR_SPEC_SECTION}`),
    );
    const specSectionHash = `sha256:${crypto
      .createHash('sha256')
      .update(sectionBytes)
      .digest('hex')}`;
    expect(compilerContractRepairSpecSectionHash()).toBe(specSectionHash);
    const architecture = fs.readFileSync(
      path.join(repoRoot, COMPILER_CONTRACT_REPAIR_SPEC_PATH),
      'utf8',
    );
    expect(
      extractCompilerContractRepairSpecSectionBytes(
        `# Unrelated preface\n\n${architecture}`,
      ),
    ).toEqual(sectionBytes);
    expect(
      extractCompilerContractRepairSpecSectionBytes(
        architecture.replace(
          'blocked_pending_exact_g2_identity',
          'changed_r016_contract_value',
        ),
      ),
    ).not.toEqual(sectionBytes);
    expect(historicalContractTreeDigest()).toBe(
      'a40e2e801ae4bb331a90b49eca457c48e29cc88c3eb32670dedd3c90387a8d15',
    );
  });

  it('publishes a closed Compiled IR v2 with the execution fields in hashed Plan bytes', () => {
    const validatePlan = validatorForSchema(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
    );
    const plan = buildCompiledPlanV2SampleForTest();
    expect(validatePlan(plan), JSON.stringify(validatePlan.errors)).toBe(true);

    const { plan_hash: planHash, ...planWithoutHash } = plan;
    expect(planHash).toBe(
      domainSeparatedSha256(
        COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
        planWithoutHash as JsonValue,
      ),
    );
    expect(plan.static_child_plan_closure.members).toEqual([]);

    const missingClosure = clone(plan) as JsonObject;
    delete missingClosure.static_child_plan_closure;
    expect(validatePlan(missingClosure)).toBe(false);

    const v1ClosureField = clone(plan) as JsonObject;
    v1ClosureField.static_child_plan_closure_hash = HASH;
    expect(validatePlan(v1ClosureField)).toBe(false);

    const unknownField = clone(plan) as JsonObject;
    unknownField.runtime_fallback = 'recompile';
    expect(validatePlan(unknownField)).toBe(false);

    const validateCondition = validatorForPlanDefinition(
      'compiled_condition_program',
    );
    const condition: JsonObject = {
      normalized_ast: {
        op: 'eq',
        left: { literal: true },
        right: { literal: false },
      },
      operand_schema_hashes: {},
      operand_types: ['boolean', 'boolean'],
      max_steps: 1,
      program_hash: HASH,
    };
    expect(
      validateCondition(condition),
      JSON.stringify(validateCondition.errors),
    ).toBe(true);
    const missingOperandTypes = clone(condition) as JsonObject;
    delete missingOperandTypes.operand_types;
    expect(validateCondition(missingOperandTypes)).toBe(false);
    expect(validateCondition.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'required',
          params: { missingProperty: 'operand_types' },
        }),
      ]),
    );

    const validateNode = validatorForPlanDefinition('compiled_node');
    const sampleNode = plan.nodes[0] as JsonObject;
    const mapNode: JsonObject = {
      id: 'map',
      type: 'map',
      source_config_hash: HASH,
      trigger_program: sampleNode.trigger_program,
      input_ports: {},
      output_ports: {},
      effective_limits: {},
      body_binding: {
        kind: 'inline',
        source_snapshot_ref: 'fixture:inline-map-body',
        source_hash: HASH,
        precompiled_plan_hash: HASH,
        interface_snapshot: plan.interface_snapshot,
      },
      items_input_port: 'items',
      item_child_input_port: 'item',
      shared_child_input_bindings: {},
      result_output_port: 'results',
      effective_max_items: null,
      effective_child_concurrency: null,
      completion: { type: 'all_settled', child_error: 'record' },
      child_policy: {
        effective_policy_snapshot: plan.effective_policy_snapshot,
        effective_policy_hash: HASH,
      },
      result_order: 'item_index',
    };
    expect(validateNode(mapNode), JSON.stringify(validateNode.errors)).toBe(
      true,
    );
    const missingResultOrder = clone(mapNode) as JsonObject;
    delete missingResultOrder.result_order;
    expect(validateNode(missingResultOrder)).toBe(false);
    expect(validateNode.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'required',
          params: { missingProperty: 'result_order' },
        }),
      ]),
    );
  });

  it('defines one closed canonical conformance-result assertion target and hash identity', () => {
    const catalog = readArtifact(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/draft/golden-draft-cases@2.json`,
    ).payload as unknown as GoldenDraftCaseCatalogV2;
    expect(catalog.assertion_target).toEqual({
      artifact_format: 'icarus.workflow-compiler-conformance-case-result/1',
      schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiler-conformance-case-result-schema.json`,
      schema_hash: artifactByFormat(
        'icarus.workflow-compiler-conformance-case-result-schema/1',
      ).hash,
      pointer_root: '',
      canonicalization: 'rfc8785_jcs',
      encoding: 'utf-8',
      canonical_bytes: 'jcs_full_result_including_result_hash',
      hash_field: 'result_hash',
      hash_preimage: 'jcs_result_without_result_hash',
      hash_domain_separator: COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
    });
    for (const candidate of catalog.cases)
      for (const assertion of candidate.semantic_assertions) {
        expect(assertion).not.toHaveProperty('target_artifact');
        expect(assertion.subject_pointer).toMatch(/^(?:\/(?:[^~/]|~[01])*)*$/);
        expect(assertion.subject_pointer).not.toMatch(/^\/normalized(?:\/|$)/);
      }
    const validateCatalog = validatorForSchema(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/golden-draft-cases-v2-schema.json`,
    );
    expect(
      validateCatalog(catalog),
      JSON.stringify(validateCatalog.errors),
    ).toBe(true);
    const wrongResultDomain = clone(catalog) as JsonObject;
    (wrongResultDomain.assertion_target as JsonObject).hash_domain_separator =
      'icarus:workflow-compiler-conformance-case-result:2\n';
    expect(validateCatalog(wrongResultDomain)).toBe(false);

    const validateResult = validatorForSchema(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiler-conformance-case-result-schema.json`,
    );
    const resultWithoutHash = {
      format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
      case_id: 'fixture.compiled',
      source_kind: 'graph_scope' as const,
      source_hash: HASH,
      outcome: 'compiled' as const,
      normalized_plan: buildCompiledPlanV2SampleForTest(),
      static_lowering_contract_ref: null,
      static_lowering_contract_hash: null,
      diagnostics: [] as [],
      proof_hashes: [] as Sha256Hash[],
      program_hashes: [] as Sha256Hash[],
    };
    const result: WorkflowCompilerConformanceCaseResultV1 = {
      ...resultWithoutHash,
      result_hash:
        calculateCompilerConformanceCaseResultHash(resultWithoutHash),
    };
    expect(validateResult(result), JSON.stringify(validateResult.errors)).toBe(
      true,
    );
    expect(Buffer.from(canonicalJson(result), 'utf8').toString('utf8')).toBe(
      canonicalJson(result),
    );

    const halfBoundLowering = clone(result) as JsonObject;
    halfBoundLowering.static_lowering_contract_ref = {
      id: 'icarus.workflow-definition-static-lowering-contract',
      version: '1.0.0',
    };
    expect(validateResult(halfBoundLowering)).toBe(false);

    const resultWithUnknown = clone(result) as JsonObject;
    resultWithUnknown.review_projection = {};
    expect(validateResult(resultWithUnknown)).toBe(false);
  });

  it('keeps normal lowering exits disjoint from error and cancellation outcomes', () => {
    const loweringArtifact = readArtifact(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/contracts/definition-static-lowering-contract@1.json`,
    );
    const lowering =
      loweringArtifact.payload as unknown as DefinitionStaticLoweringContractV1;
    expect(lowering.normal_named_exits).toEqual(['success', 'failure']);
    expect(lowering.capability_terminal_routes).toEqual([
      {
        terminal_status: 'succeeded',
        named_exit: 'success',
        transition_slot: 'on_complete.success',
      },
      {
        terminal_status: 'failed',
        named_exit: 'failure',
        transition_slot: 'on_complete.failure',
      },
    ]);
    expect(lowering.engine_error).toEqual({
      scope_outcome_kind: 'errored',
      named_exit: null,
      transition_slot: 'on_error',
    });
    expect(lowering.local_graph_cancel).toEqual({
      scope_outcome_kind: 'cancelled',
      reason: 'local_graph',
      named_exit: null,
      transition_slot: 'on_local_cancel',
    });
    expect(lowering.global_workflow_cancel).toEqual({
      scope_outcome_kind: 'cancelled',
      reason: 'workflow',
      named_exit: null,
      transition_slot: null,
      disposition: 'terminate_workflow_without_state_transition',
    });
    expect(
      validateSemanticHash(
        lowering,
        'contract_hash',
        'icarus:workflow-definition-static-lowering-contract:1\n',
      ),
    ).toBe(true);

    const validateLowering = validatorForSchema(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/definition-static-lowering-contract-schema.json`,
    );
    const engineErrorAsExit = clone(lowering) as JsonObject;
    (engineErrorAsExit.engine_error as JsonObject).named_exit = 'error';
    expect(validateLowering(engineErrorAsExit)).toBe(false);
    const localCancelAsExit = clone(lowering) as JsonObject;
    (localCancelAsExit.local_graph_cancel as JsonObject).named_exit = 'cancel';
    expect(validateLowering(localCancelAsExit)).toBe(false);
  });

  it('additively binds every frozen G0.8 input to exact future G2 identities', () => {
    const historical = readArtifact(
      'conformance/draft/golden-draft-cases@1.json',
    ).payload.cases as JsonObject[];
    const current = readArtifact(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/draft/golden-draft-cases@2.json`,
    ).payload as unknown as GoldenDraftCaseCatalogV2;
    expect(current.cases).toHaveLength(40);
    for (const candidate of current.cases) {
      const prior = historical.find(
        (entry) => entry.case_id === candidate.case_id,
      )!;
      expect(candidate.raw_source_bytes_ref).toBe(prior.raw_source_bytes_ref);
      expect(candidate.raw_source_bytes_hash).toBe(prior.raw_source_bytes_hash);
      expect(candidate.historical_input_snapshot_ref).toBe(
        prior.input_snapshot_ref,
      );
      expect(candidate.historical_input_snapshot_hash).toBe(
        prior.input_snapshot_hash,
      );
      expect(candidate.g2_case_input_binding_ref).toBeNull();
      expect(candidate.expected_case_result_bytes_ref).toBeNull();
      expect(candidate.review_status).toBe('blocked_pending_exact_g2_identity');
    }

    const historicalSnapshot = readArtifact(
      'conformance/draft/snapshots/complete-base@1.json',
    ).payload.compiler_identity as JsonObject;
    expect(historicalSnapshot).toMatchObject({
      production_compiler_status: 'absent',
      canonical_normalizer_status: 'absent',
      proof_algorithm_status: 'absent',
    });
    const requirement = readArtifact(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/draft/g2-case-input-binding-requirement@1.json`,
    ).payload;
    expect(requirement.historical_input_snapshot_semantics).toBe(
      'frozen_g0_stage_absence_not_g2_identity',
    );
    expect(requirement.required_exact_identity_fields).toEqual(
      COMPILER_G2_EXACT_IDENTITY_FIELDS,
    );
    expect(requirement.resolution_status).toBe(
      'pending_g2_compiler_implementation',
    );
    expect(requirement.review_barrier).toBe(
      'blocked_until_resolved_binding_is_published',
    );

    const identity = {
      format: 'icarus.workflow-compiler-g2-case-input-binding/1' as const,
      binding_version: 'fixture-resolved-1',
      historical_g0_8_manifest_ref: 'contract-pack-golden-draft.json',
      historical_g0_8_manifest_hash: HISTORICAL_G0_8_MANIFEST_HASH,
      historical_case_catalog_ref:
        'conformance/draft/golden-draft-cases@1.json',
      historical_case_catalog_hash: HISTORICAL_G0_8_CASE_CATALOG_HASH,
      compiler_toolchain_manifest_ref: {
        id: 'icarus.workflow-compiler-toolchain',
        version: '2.0.0',
      },
      compiler_toolchain_hash: HASH,
      compiler_version: '2.0.0',
      compiler_build_hash: HASH,
      canonical_normalizer_version: '2.0.0',
      canonical_normalizer_hash: HASH,
      proof_algorithm_version: '2.0.0',
      proof_algorithm_hash: HASH,
      error_catalog_ref: {
        id: 'icarus.workflow-compiler-error-catalog',
        version: '1.0.0',
      },
      error_catalog_hash: HASH,
      compiled_ir_schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiled-scope-plan-v2-schema.json`,
      compiled_ir_schema_hash: artifactByFormat(
        'icarus.workflow-compiled-scope-plan-schema/2',
      ).hash,
      conformance_result_schema_ref: `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/compiler-conformance-case-result-schema.json`,
      conformance_result_schema_hash: artifactByFormat(
        'icarus.workflow-compiler-conformance-case-result-schema/1',
      ).hash,
    };
    const caseInputs = current.cases.map((candidate) => {
      const entryWithoutHash = {
        case_id: candidate.case_id,
        raw_source_bytes_ref: candidate.raw_source_bytes_ref,
        raw_source_bytes_hash: candidate.raw_source_bytes_hash,
        historical_input_snapshot_ref: candidate.historical_input_snapshot_ref,
        historical_input_snapshot_hash:
          candidate.historical_input_snapshot_hash,
      };
      return {
        ...entryWithoutHash,
        effective_case_input_hash: calculateEffectiveG2CaseInputHash(
          identity,
          entryWithoutHash,
        ),
      };
    });
    const bindingWithoutHash = { ...identity, case_inputs: caseInputs };
    const binding: CompilerG2CaseInputBindingV1 = {
      ...bindingWithoutHash,
      binding_hash: calculateG2CaseInputBindingHash(bindingWithoutHash),
    };
    expect(requirement.effective_case_input_domain_separator).toBe(
      G2_CASE_INPUT_DOMAIN_SEPARATOR,
    );
    expect(requirement.binding_domain_separator).toBe(
      G2_CASE_INPUT_BINDING_DOMAIN_SEPARATOR,
    );
    const validateBinding = validatorForSchema(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/schemas/g2-case-input-binding-schema.json`,
    );
    expect(
      validateBinding(binding),
      JSON.stringify(validateBinding.errors),
    ).toBe(true);
    const missingProofIdentity = clone(binding) as JsonObject;
    delete missingProofIdentity.proof_algorithm_hash;
    expect(validateBinding(missingProofIdentity)).toBe(false);
    const missingCase = clone(binding) as JsonObject;
    (missingCase.case_inputs as JsonValue[]).pop();
    expect(validateBinding(missingCase)).toBe(false);
  });

  it('keeps review, seal, Compiler, G3+, and G8/G9 identity outside the repair', () => {
    const manifest = readArtifact(
      `${COMPILER_CONTRACT_REPAIR_ROOT}/contract-pack-compiler-contract-repair.json`,
    );
    expect(manifest.payload).toMatchObject({
      repair_id: 'R-016',
      r016_status: 'CLOSED',
      g2_status: 'READY',
      i2_status: 'READY',
      i3_status: 'READY',
      production_compiler_status: 'absent',
      exact_g2_identity_status: 'pending_implementation',
      golden_semantic_review_status: 'absent',
      golden_seal_status: 'not_run',
      conformance_sealed_status: 'empty',
      g3_through_g9_status: 'NOT_READY',
      release_identity_status: 'missing_until_g8',
      normative_spec_ref: COMPILER_CONTRACT_REPAIR_SPEC_PATH,
      normative_spec_section: COMPILER_CONTRACT_REPAIR_SPEC_SECTION,
      normative_spec_section_raw_sha256:
        compilerContractRepairSpecSectionHash(),
    });
    expect(
      fs.readdirSync(path.join(contractsRoot, 'conformance/sealed')),
    ).toEqual(['.gitkeep']);
    expect(fs.existsSync(path.join(workflowRuntimeRoot, 'compiler'))).toBe(
      false,
    );
    for (const forbidden of [
      'registry',
      'authoring',
      'runtime/graph-runtime.ts',
      'projection/runtime-center-api.ts',
    ])
      expect(fs.existsSync(path.join(workflowRuntimeRoot, forbidden))).toBe(
        false,
      );
  });
});
