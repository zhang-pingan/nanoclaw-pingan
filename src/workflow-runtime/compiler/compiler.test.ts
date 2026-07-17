import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import {
  COMPILER_G2_EXACT_IDENTITY_FIELDS,
  type CompilerSemanticAssertionV2,
  type GoldenDraftCaseCatalogV2,
  type WorkflowCompilerConformanceCaseResultV1,
} from '../contracts/compiler-contract-repair-types.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from '../contracts/types.js';
import {
  checkG2ProductionCompilerArtifacts,
  G2_PRODUCTION_COMPILER_ROOT_DOMAIN,
} from './artifacts.js';
import { buildG2Candidates, G2_CANDIDATE_ROOT } from './conformance.js';
import { compileWorkflow } from './compiler.js';
import { PLAN_DOMAIN_SEPARATOR } from './normalizer.js';

const compilerRoot = import.meta.dirname;
const contractsRoot = path.resolve(compilerRoot, '../contracts');

function artifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function jsonValueAtPointer(
  root: JsonValue,
  pointer: string,
): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  if (pointer === '') return current;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) current = current[Number(token)];
    else if (current && typeof current === 'object') current = current[token];
    else return undefined;
  }
  return current;
}

function assertionActualSet(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function assertSemanticAssertion(
  result: WorkflowCompilerConformanceCaseResultV1,
  assertion: CompilerSemanticAssertionV2,
): void {
  const actual = jsonValueAtPointer(result, assertion.subject_pointer);
  switch (assertion.operator) {
    case 'equals':
    case 'ordered_equals':
      expect(actual, assertion.assertion_id).toEqual(assertion.expected);
      break;
    case 'set_equals':
      expect(
        assertionActualSet(actual).map(String).sort(),
        assertion.assertion_id,
      ).toEqual(assertionActualSet(assertion.expected).map(String).sort());
      break;
    case 'contains':
      expect(assertionActualSet(actual), assertion.assertion_id).toContainEqual(
        assertion.expected,
      );
      break;
    case 'present':
      expect(actual, assertion.assertion_id).not.toBeUndefined();
      break;
    case 'absent':
      expect(actual, assertion.assertion_id).toBeUndefined();
      break;
  }
}

function candidateFiles(): Map<string, Buffer> {
  const root = path.join(contractsRoot, G2_CANDIDATE_ROOT);
  const files = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      if (fs.statSync(absolutePath).isDirectory()) visit(absolutePath);
      else
        files.set(
          path.relative(root, absolutePath),
          fs.readFileSync(absolutePath),
        );
    }
  };
  visit(root);
  return files;
}

describe('G2 Production Compiler', () => {
  it('recompiles all 40 cases deterministically and keeps candidate checking read-only', () => {
    const before = candidateFiles();
    const first = buildG2Candidates();
    const second = buildG2Candidates();
    expect(second).toEqual(first);
    const manifest = checkG2ProductionCompilerArtifacts();
    expect(manifest.payload.status).toBe('IMPLEMENTED');
    expect(manifest.payload.candidate_result_disposition).toBe(
      'actual_compiler_output_not_golden_oracle',
    );
    expect(candidateFiles()).toEqual(before);
    expect(first.results).toHaveLength(40);
    expect(
      first.results.filter((result) => result.outcome === 'compiled'),
    ).toHaveLength(10);
    expect(
      first.results.filter((result) => result.outcome === 'rejected'),
    ).toHaveLength(30);
  });

  it('matches the hand-authored diagnostic tuples and source identities without importing them into Compiler code', () => {
    const catalog = artifact(
      'conformance/compiler-contract-repair/draft/golden-draft-cases@2.json',
    ).payload as unknown as GoldenDraftCaseCatalogV2;
    const actual = new Map(
      buildG2Candidates().results.map((result) => [result.case_id, result]),
    );
    for (const expected of catalog.cases) {
      const result = actual.get(expected.case_id);
      expect(result, expected.case_id).toBeDefined();
      expect(result?.source_hash, expected.case_id).toBe(
        expected.expected_source_hash,
      );
      expect(result?.diagnostics, expected.case_id).toEqual(
        expected.expected_diagnostics,
      );
      expect(result?.outcome, expected.case_id).toBe(
        expected.polarity === 'positive' ? 'compiled' : 'rejected',
      );
    }
  });

  it('satisfies every repaired positive semantic assertion from real normalized Plan output', () => {
    const catalog = artifact(
      'conformance/compiler-contract-repair/draft/golden-draft-cases@2.json',
    ).payload as unknown as GoldenDraftCaseCatalogV2;
    const actual = new Map(
      buildG2Candidates().results.map((result) => [result.case_id, result]),
    );
    for (const expected of catalog.cases.filter(
      (candidate) => candidate.polarity === 'positive',
    )) {
      const result = actual.get(expected.case_id);
      if (!result) throw new Error(`Missing result: ${expected.case_id}`);
      for (const assertion of expected.semantic_assertions) {
        assertSemanticAssertion(result, assertion);
      }
    }
  });

  it('binds complete Plan, result, proof, program, toolchain, and exact case-input identities', () => {
    const built = buildG2Candidates();
    const { toolchain_hash: toolchainHash, ...toolchainWithoutHash } =
      built.toolchain;
    expect(toolchainHash).toBe(
      domainSeparatedSha256(
        'icarus:workflow-compiler-toolchain-manifest:1\n',
        toolchainWithoutHash,
      ),
    );
    expect(built.binding.compiler_toolchain_hash).toBe(toolchainHash);
    expect(built.binding.case_inputs).toHaveLength(40);
    for (const field of COMPILER_G2_EXACT_IDENTITY_FIELDS) {
      expect(built.binding, field).toHaveProperty(field);
    }
    for (const result of built.results) {
      const { result_hash: resultHash, ...resultWithoutHash } = result;
      expect(resultHash, result.case_id).toBe(
        domainSeparatedSha256(
          'icarus:workflow-compiler-conformance-case-result:1\n',
          resultWithoutHash as JsonValue,
        ),
      );
      if (result.outcome !== 'compiled') continue;
      const { plan_hash: planHash, ...planWithoutHash } =
        result.normalized_plan;
      expect(planHash, result.case_id).toBe(
        domainSeparatedSha256(
          PLAN_DOMAIN_SEPARATOR,
          planWithoutHash as JsonValue,
        ),
      );
      expect(result.normalized_plan.compiler_toolchain_hash).toBe(
        toolchainHash,
      );
      expect(result.proof_hashes).toEqual(
        [...new Set(result.proof_hashes)].sort(),
      );
      expect(result.program_hashes).toEqual(
        [...new Set(result.program_hashes)].sort(),
      );
    }
    const root = checkG2ProductionCompilerArtifacts();
    expect(root.domain_separator).toBe(G2_PRODUCTION_COMPILER_ROOT_DOMAIN);
  });

  it('treats frozen G0.8 absent compiler fields as history, not resolved G2 identity', () => {
    const snapshot = artifact(
      'conformance/draft/snapshots/complete-base@1.json',
    ).payload;
    assertJsonObject(snapshot.compiler_identity);
    expect(snapshot.compiler_identity.production_compiler_status).toBe(
      'absent',
    );
    const built = buildG2Candidates();
    expect(built.toolchain.compiler_build.implementation_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(built.binding.compiler_build_hash).toBe(
      built.toolchain.compiler_build.implementation_hash,
    );
    expect(built.binding.compiler_build_hash).not.toBe(
      snapshot.compiler_identity.production_compiler_status,
    );
  });

  it('does not cross Golden seal or G3+ runtime boundaries', () => {
    expect(
      fs.readdirSync(path.join(contractsRoot, 'conformance/sealed')),
    ).toEqual(['.gitkeep']);
    for (const forbidden of [
      'registry',
      'authoring',
      'runtime/graph-runtime.ts',
      'projection/runtime-center-api.ts',
    ]) {
      expect(fs.existsSync(path.join(compilerRoot, '..', forbidden))).toBe(
        false,
      );
    }
  });

  it('rejects invalid literal bindings and nested condition type errors outside the frozen cases', () => {
    const identity = buildG2Candidates().identity;
    const snapshot = artifact(
      'conformance/draft/snapshots/complete-base@1.json',
    ).payload;
    const mapSource = strictParseJsonBytes(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'conformance/draft/cases/positive.map/source.json',
        ),
      ),
    );
    assertJsonObject(mapSource);
    const mapEdges = mapSource.data_edges;
    if (!Array.isArray(mapEdges)) throw new Error('Map data edges missing');
    assertJsonObject(mapEdges[0]);
    assertJsonObject(mapEdges[0].from);
    mapEdges[0].from.value = [1];
    const invalidLiteral = compileWorkflow({
      caseId: 'unit.invalid-literal',
      sourceKind: 'graph_scope',
      rawSourceBytes: Buffer.from(JSON.stringify(mapSource), 'utf8'),
      inputSnapshot: snapshot,
      identity,
    });
    expect(invalidLiteral.ok).toBe(false);
    if (invalidLiteral.ok)
      throw new Error('Invalid literal unexpectedly compiled');
    expect(invalidLiteral.value.diagnostics[0].code).toBe(
      'schema_not_assignable',
    );

    const routeSource = strictParseJsonBytes(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'conformance/draft/cases/positive.condition-route/source.json',
        ),
      ),
    );
    assertJsonObject(routeSource);
    const routeEdges = routeSource.control_edges;
    if (!Array.isArray(routeEdges)) throw new Error('Route edges missing');
    assertJsonObject(routeEdges[0]);
    const validCondition = routeEdges[0].when;
    routeEdges[0].when = {
      op: 'and',
      args: [
        validCondition,
        {
          op: 'lt',
          left: { literal: 'text' },
          right: { literal: 1 },
        },
      ],
    };
    const nestedTypeMismatch = compileWorkflow({
      caseId: 'unit.nested-condition-type-mismatch',
      sourceKind: 'graph_scope',
      rawSourceBytes: Buffer.from(JSON.stringify(routeSource), 'utf8'),
      inputSnapshot: snapshot,
      identity,
    });
    expect(nestedTypeMismatch.ok).toBe(false);
    if (nestedTypeMismatch.ok) {
      throw new Error('Nested condition type mismatch unexpectedly compiled');
    }
    expect(nestedTypeMismatch.value.diagnostics[0].code).toBe(
      'condition_type_mismatch',
    );
  });

  it('derives Definition diagnostics from bindings and real state keys', () => {
    const identity = buildG2Candidates().identity;
    const snapshot = artifact(
      'conformance/draft/snapshots/complete-base@1.json',
    ).payload;
    const source = strictParseJsonBytes(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'conformance/draft/cases/negative.child-recipe-dependency-cycle/source.json',
        ),
      ),
    );
    assertJsonObject(source);
    assertJsonObject(source.ref);
    source.ref.id = 'unrelated.definition.name';

    const outcome = compileWorkflow({
      caseId: 'unit.recipe-cycle-with-unrelated-name',
      sourceKind: 'workflow_definition',
      rawSourceBytes: Buffer.from(JSON.stringify(source), 'utf8'),
      inputSnapshot: snapshot,
      identity,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Recipe cycle unexpectedly compiled');
    expect(outcome.value.diagnostics[0]).toMatchObject({
      code: 'child_recipe_dependency_cycle',
      stable_object_id: 'fixture.recipe.cycle-a',
    });

    const mismatchSource = strictParseJsonBytes(
      fs.readFileSync(
        path.join(
          contractsRoot,
          'conformance/draft/cases/negative.child-recipe-set-mismatch/source.json',
        ),
      ),
    );
    assertJsonObject(mismatchSource);
    assertJsonObject(mismatchSource.entry_points);
    assertJsonObject(mismatchSource.entry_points.default);
    assertJsonObject(mismatchSource.states);
    const startState = mismatchSource.states.start;
    mismatchSource.states = { renamed: startState };
    mismatchSource.entry_points.default.state_key = 'renamed';
    const mismatch = compileWorkflow({
      caseId: 'unit.recipe-mismatch-with-renamed-state',
      sourceKind: 'workflow_definition',
      rawSourceBytes: Buffer.from(JSON.stringify(mismatchSource), 'utf8'),
      inputSnapshot: snapshot,
      identity,
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('Recipe mismatch unexpectedly compiled');
    expect(mismatch.value.diagnostics[0]).toMatchObject({
      code: 'child_recipe_set_mismatch',
      instance_pointer:
        '/states/renamed/on_complete/success/effects/operations/0/recipe_ref',
    });
  });
});
