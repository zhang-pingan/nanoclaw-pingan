import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';

import {
  buildG2NodeOutputEnvelopeSuccessor,
  assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest,
  G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
  G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH,
  G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH,
} from '../compiler/g2-node-output-envelope-authority-successor.js';
import { evaluateCurrentG2GoldenReplay } from '../compiler/current-g2-golden-replay.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA,
  G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA,
  G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA,
} from './g2-node-output-envelope-authority-successor-seal-schemas.js';
import {
  buildG2NodeOutputEnvelopeSeal,
  checkG2NodeOutputEnvelopeSeal,
} from './g2-node-output-envelope-authority-successor-seal.js';
import {
  buildG2NodeOutputEnvelopeSemanticReview,
  checkG2NodeOutputEnvelopeSemanticReview,
  G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
  G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
  G2_NODE_OUTPUT_ENVELOPE_OWNER_APPROVAL_REVIEWED_AT_MS,
} from './g2-node-output-envelope-authority-successor-semantic-review.js';
import { strictParseJsonBytes } from './strict-json.js';
import {
  authorCurrentG2GoldenExpectedResult as authorV5ExpectedResult,
  extractCurrentG2GoldenProgramBytes as extractV5ProgramBytes,
  extractCurrentG2GoldenProofBytes as extractV5ProofBytes,
} from './generated-schema-join-authority-golden-authoring.js';
import {
  authorCurrentG2GoldenExpectedResult as authorV6ExpectedResult,
  extractCurrentG2GoldenProgramBytes as extractV6ProgramBytes,
  extractCurrentG2GoldenProofBytes as extractV6ProofBytes,
} from './node-output-envelope-golden-authoring.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

function rawHash(bytes: Uint8Array | string): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

const authoringModule = '../contracts/node-output-envelope-golden-authoring.js';
const authoringRef =
  'src/workflow-runtime/contracts/node-output-envelope-golden-authoring.ts';
const expectedResultHelper = 'authorCurrentG2GoldenExpectedResult';
const programBytesHelper = 'extractCurrentG2GoldenProgramBytes';
const proofBytesHelper = 'extractCurrentG2GoldenProofBytes';

function authoringBindingFixture(input: {
  imports: string;
  invocation?: string;
  declarations?: string;
  declaredRef?: string;
}): string {
  return [
    input.declaredRef ??
      `export const G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF = '${authoringRef}';`,
    input.imports,
    input.declarations ?? '',
    'export function buildFixture() {',
    input.invocation ?? `return ${expectedResultHelper}({});`,
    '}',
  ].join('\n');
}

function normalAuthoringImport(moduleSpecifier = authoringModule): string {
  return `import { ${expectedResultHelper}, ${programBytesHelper}, ${proofBytesHelper} } from '${moduleSpecifier}';`;
}

function approvedInput() {
  return {
    authorizedBy: 'human:local-owner',
    decision: 'approved' as const,
    approvedDraftManifestHash:
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
    approvedReviewReportHash:
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
    reviewedAtMs: G2_NODE_OUTPUT_ENVELOPE_OWNER_APPROVAL_REVIEWED_AT_MS,
  };
}

describe('G2 v6 authoring generator AST binding', () => {
  const expectedIdentity = {
    ref: authoringRef,
    rawHash:
      'sha256:a574091ca544a7b838936403d1bd55d3f1757468d453d5205aaa6f8a11f897ec',
  };

  it('accepts one normal named import bound to the exact module', () => {
    expect(
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(
        authoringBindingFixture({ imports: normalAuthoringImport() }),
      ),
    ).toEqual(expectedIdentity);
  });

  it('accepts legal local aliases and counts the aliased expected-result call', () => {
    const source = authoringBindingFixture({
      imports: `import {
        ${expectedResultHelper} as authorExpectedResult,
        ${programBytesHelper} as readProgramBytes,
        ${proofBytesHelper} as readProofBytes,
      } from '${authoringModule}';`,
      invocation: 'return authorExpectedResult({});',
    });
    expect(
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(source),
    ).toEqual(expectedIdentity);
  });

  it('accepts split named imports from the same exact module', () => {
    const source = authoringBindingFixture({
      imports: [
        `import { ${expectedResultHelper} as authorExpectedResult } from '${authoringModule}';`,
        `import { ${programBytesHelper} } from '${authoringModule}';`,
        `import { ${proofBytesHelper} as readProofBytes } from '${authoringModule}';`,
      ].join('\n'),
      invocation: 'return authorExpectedResult({});',
    });
    expect(
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(source),
    ).toEqual(expectedIdentity);
  });

  it('accepts wrapped dynamic and require access to unrelated modules', () => {
    const source = authoringBindingFixture({
      imports: normalAuthoringImport(),
      declarations: [
        "const unrelatedDynamic = import((('../contracts/unrelated.js' as const) satisfies string)!);",
        "const unrelatedRequired = (require as any)!((0, '../contracts/unrelated.js' as const));",
      ].join('\n'),
    });
    expect(
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(source),
    ).toEqual(expectedIdentity);
  });

  it.each([
    {
      name: 'all helpers from the wrong module',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(
          '../contracts/generated-schema-join-authority-golden-authoring.js',
        ),
      }),
    },
    {
      name: 'one helper from the wrong module',
      source: authoringBindingFixture({
        imports: [
          `import { ${expectedResultHelper}, ${programBytesHelper} } from '${authoringModule}';`,
          `import { ${proofBytesHelper} } from '../contracts/generated-schema-join-authority-golden-authoring.js';`,
        ].join('\n'),
      }),
    },
    {
      name: 'equivalent path with drifted module source bytes',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(
          '../contracts/./node-output-envelope-golden-authoring.js',
        ),
      }),
    },
    {
      name: 'missing expected-result helper',
      source: authoringBindingFixture({
        imports: `import { ${programBytesHelper}, ${proofBytesHelper} } from '${authoringModule}';`,
        declarations: `const ${expectedResultHelper} = (_input: unknown) => ({});`,
      }),
    },
    {
      name: 'missing program-bytes helper',
      source: authoringBindingFixture({
        imports: `import { ${expectedResultHelper}, ${proofBytesHelper} } from '${authoringModule}';`,
      }),
    },
    {
      name: 'missing proof-bytes helper',
      source: authoringBindingFixture({
        imports: `import { ${expectedResultHelper}, ${programBytesHelper} } from '${authoringModule}';`,
      }),
    },
    {
      name: 'duplicate exported helper under two aliases',
      source: authoringBindingFixture({
        imports: [
          normalAuthoringImport(),
          `import { ${expectedResultHelper} as secondAuthor } from '${authoringModule}';`,
        ].join('\n'),
      }),
    },
    {
      name: 'conflicting local aliases for two helpers',
      source: authoringBindingFixture({
        imports: `import {
          ${expectedResultHelper} as authorHelper,
          ${programBytesHelper} as authorHelper,
          ${proofBytesHelper},
        } from '${authoringModule}';`,
        invocation: 'return authorHelper({});',
      }),
    },
    {
      name: 'zero expected-result calls',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        invocation: 'return {};',
      }),
    },
    {
      name: 'two expected-result calls',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        invocation: `${expectedResultHelper}({}); return ${expectedResultHelper}({});`,
      }),
    },
    {
      name: 'indirect expected-result call through an escaped binding',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        invocation: `const indirect = ${expectedResultHelper}; return indirect({});`,
      }),
    },
    {
      name: 'direct plus indirect expected-result calls',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        invocation: `const indirect = ${expectedResultHelper}; ${expectedResultHelper}({}); return indirect({});`,
      }),
    },
    {
      name: 'optional expected-result call',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        invocation: `return ${expectedResultHelper}?.({});`,
      }),
    },
    {
      name: 'declared ref drift',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declaredRef:
          "export const G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF = 'src/workflow-runtime/contracts/generated-schema-join-authority-golden-authoring.ts';",
      }),
    },
    {
      name: 'duplicate declared ref',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `function nested() { const G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF = '${authoringRef}'; return G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF; }`,
      }),
    },
    {
      name: 'unrelated same-export-name local',
      source: authoringBindingFixture({
        imports: `import {
          ${expectedResultHelper} as authorExpectedResult,
          ${programBytesHelper},
          ${proofBytesHelper},
        } from '${authoringModule}';`,
        declarations: `const ${expectedResultHelper} = (_input: unknown) => ({});`,
        invocation: 'return authorExpectedResult({});',
      }),
    },
    {
      name: 'shadowed expected-result local binding',
      source: authoringBindingFixture({
        imports: `import {
          ${expectedResultHelper} as authorExpectedResult,
          ${programBytesHelper},
          ${proofBytesHelper},
        } from '${authoringModule}';`,
        declarations:
          'function shadow(authorExpectedResult: (_input: unknown) => unknown) { return authorExpectedResult({}); }',
        invocation: 'shadow(() => ({})); return authorExpectedResult({});',
      }),
    },
    {
      name: 'type-only helper imports',
      source: authoringBindingFixture({
        imports: `import type { ${expectedResultHelper}, ${programBytesHelper}, ${proofBytesHelper} } from '${authoringModule}';`,
      }),
    },
    {
      name: 'namespace import indirection',
      source: authoringBindingFixture({
        imports: `import * as authoring from '${authoringModule}';`,
        invocation: `return authoring.${expectedResultHelper}({});`,
      }),
    },
    {
      name: 'parallel namespace access to the exact module',
      source: authoringBindingFixture({
        imports: `${normalAuthoringImport()}\nimport * as authoring from '${authoringModule}';`,
      }),
    },
    {
      name: 'default access alongside the required named imports',
      source: authoringBindingFixture({
        imports: `import authoring, { ${expectedResultHelper}, ${programBytesHelper}, ${proofBytesHelper} } from '${authoringModule}';`,
      }),
    },
    {
      name: 'dynamic access alongside the required named imports',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import('${authoringModule}');`,
      }),
    },
    {
      name: 'dynamic access with a trailing comma',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import('${authoringModule}',);`,
      }),
    },
    {
      name: 'two-argument dynamic access with empty options',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import('${authoringModule}', {});`,
      }),
    },
    {
      name: 'two-argument dynamic access with import attributes',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import('${authoringModule}', { with: { type: 'json' } });`,
      }),
    },
    {
      name: 'dynamic access with a no-substitution template specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(\`${authoringModule}\`);`,
      }),
    },
    {
      name: 'dynamic access with a parenthesized exact specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(('${authoringModule}'), {});`,
      }),
    },
    {
      name: 'dynamic access with an as-const specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import('${authoringModule}' as const);`,
      }),
    },
    {
      name: 'dynamic access with an angle-bracket type assertion',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(<string>'${authoringModule}');`,
      }),
    },
    {
      name: 'dynamic access with a satisfies specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import('${authoringModule}' satisfies string);`,
      }),
    },
    {
      name: 'dynamic access with a non-null specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import('${authoringModule}'!);`,
      }),
    },
    {
      name: 'dynamic access with an awaited exact specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(await '${authoringModule}');`,
      }),
    },
    {
      name: 'dynamic access with a sequence specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import((0, '${authoringModule}'));`,
      }),
    },
    {
      name: 'dynamic access with an exact conditional branch',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(condition ? '${authoringModule}' : '../contracts/unrelated.js');`,
      }),
    },
    {
      name: 'dynamic access with an exact alternate conditional branch',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(condition ? '../contracts/unrelated.js' : '${authoringModule}');`,
      }),
    },
    {
      name: 'dynamic access with a logical-and exact result',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(condition && '${authoringModule}');`,
      }),
    },
    {
      name: 'dynamic access with a logical-or exact result',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(condition || '${authoringModule}');`,
      }),
    },
    {
      name: 'dynamic access with a nullish exact result',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import(condition ?? '${authoringModule}');`,
      }),
    },
    {
      name: 'dynamic access with nested transparent and result expressions',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const dynamicAuthoring = import((condition ? (0, ('${authoringModule}' satisfies string)!) : '../contracts/unrelated.js') as string, { with: { type: 'json' } });`,
      }),
    },
    {
      name: 'require access alongside the required named imports',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with a trailing comma',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require('${authoringModule}',);`,
      }),
    },
    {
      name: 'require access with an extra argument',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require('${authoringModule}', {});`,
      }),
    },
    {
      name: 'parenthesized require access',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = (require)('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with a no-substitution template specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require(\`${authoringModule}\`);`,
      }),
    },
    {
      name: 'require access with a parenthesized exact specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require(('${authoringModule}'));`,
      }),
    },
    {
      name: 'require access with an as-const specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require('${authoringModule}' as const);`,
      }),
    },
    {
      name: 'require access with an angle-bracket type assertion specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require(<string>'${authoringModule}');`,
      }),
    },
    {
      name: 'require access with a satisfies specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require('${authoringModule}' satisfies string);`,
      }),
    },
    {
      name: 'require access with a non-null specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require('${authoringModule}'!);`,
      }),
    },
    {
      name: 'require access with a sequence specifier',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require((0, '${authoringModule}'));`,
      }),
    },
    {
      name: 'require access with an exact conditional branch',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require(condition ? '../contracts/unrelated.js' : '${authoringModule}');`,
      }),
    },
    {
      name: 'require access with an as-expression callee',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = (require as any)('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with an angle-bracket asserted callee',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = (<typeof require>require)('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with a satisfies callee',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = (require satisfies unknown)('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with a non-null callee',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = require!('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with a sequence callee',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = (0, require)('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with a conditional callee',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = (condition ? require : otherRequire)('${authoringModule}');`,
      }),
    },
    {
      name: 'optional require access with a wrapped callee',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = (require as any)!?.('${authoringModule}');`,
      }),
    },
    {
      name: 'require access with nested callee and specifier wrappers',
      source: authoringBindingFixture({
        imports: normalAuthoringImport(),
        declarations: `const requiredAuthoring = ((require as any) satisfies unknown)!((0, ('${authoringModule}' as const)!));`,
      }),
    },
  ])('rejects $name', ({ source }) => {
    expect(() =>
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(source),
    ).toThrow();
  });
});

describe('G2 v6 NodeOutputEnvelope authority successor', () => {
  it('builds a deterministic 40/40 Compiler 3.0.4 Draft', () => {
    const first = buildG2NodeOutputEnvelopeSuccessor();
    const second = buildG2NodeOutputEnvelopeSuccessor();
    expect([...second.files]).toEqual([...first.files]);
    expect(first.files).toHaveLength(172);
    expect(first.exactEqualCount).toBe(40);
    expect(first.pointerDifferenceCount).toBe(0);
    expect(first.rc.hash).toBe(
      'sha256:64fec8c48d3c6685f83bce980b8f85c03ce0d989aaa944e85e6a0d61c40297f1',
    );
    expect(first.draft.payload.draft_manifest_hash).toBe(
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
    );
    expect(first.review.payload.report_hash).toBe(
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
    );
    const draft = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        Buffer.from(
          first.files.get(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH)!,
        ),
      ),
    );
    expect(draft.payload).toMatchObject({
      case_count: 40,
      expected_result_coverage: 40,
      draft_status: 'frozen_pending_human_approval',
    });
  }, 30_000);

  it('puts one exact envelope descriptor on every compiled Plan node', () => {
    const built = buildG2NodeOutputEnvelopeSuccessor();
    const plans = [...built.files]
      .filter(
        ([path]) => path.includes('/expected/') && path.endsWith('.plan.json'),
      )
      .map(
        ([, bytes]) => strictParseJsonBytes(Buffer.from(bytes)) as JsonObject,
      );
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(Array.isArray(plan.nodes)).toBe(true);
      for (const node of plan.nodes as JsonObject[]) {
        expect(node.output_envelope_schema).toMatchObject({
          type: 'generated',
          generator: 'node_output_envelope',
          canonicalizer: 'RFC8785-JCS',
        });
      }
    }
  }, 30_000);

  it('binds the declared authoring source to the invoked generator and rejects the v5 impersonator', () => {
    const built = buildG2NodeOutputEnvelopeSuccessor();
    const draftManifest = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        Buffer.from(
          built.files.get(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH)!,
        ),
      ),
    );
    expect(draftManifest.payload).toMatchObject({
      authoring_generator_ref: G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
      authoring_generator_hash:
        'sha256:a574091ca544a7b838936403d1bd55d3f1757468d453d5205aaa6f8a11f897ec',
    });
    expect(
      rawHash(
        fs.readFileSync(
          path.join(repoRoot, G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF),
        ),
      ),
    ).toBe(draftManifest.payload.authoring_generator_hash);

    const successorSource = fs.readFileSync(
      path.join(
        repoRoot,
        'src/workflow-runtime/compiler/g2-node-output-envelope-authority-successor.ts',
      ),
      'utf8',
    );
    expect(
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(),
    ).toEqual({
      ref: G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
      rawHash: draftManifest.payload.authoring_generator_hash,
    });
    expect(() =>
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(
        successorSource.replace(
          '../contracts/node-output-envelope-golden-authoring.js',
          '../contracts/generated-schema-join-authority-golden-authoring.js',
        ),
      ),
    ).toThrow(
      'Declared authoring generator is not the generator actually imported and invoked',
    );

    const cases = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        Buffer.from(built.files.get(G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH)!),
      ),
    );
    const staticLowering = (cases.payload.cases as JsonObject[]).find(
      (entry) => entry.case_id === 'positive.static-lowering',
    )!;
    const sourceBinding = staticLowering.source_binding as JsonObject;
    const sourceText = fs.readFileSync(
      path.join(contractsRoot, String(sourceBinding.raw_source_bytes_ref)),
      'utf8',
    );
    const snapshot = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        fs.readFileSync(
          path.join(contractsRoot, String(sourceBinding.input_snapshot_ref)),
        ),
      ),
    );
    const expectedResultBinding = staticLowering.expected_result as JsonObject;
    const expectedPlanBinding = staticLowering.expected_plan as JsonObject;
    const expectedProofsBinding = staticLowering.expected_proofs as JsonObject;
    const expectedProgramsBinding =
      staticLowering.expected_programs as JsonObject;
    const expectedResultBytes = built.files.get(
      String(expectedResultBinding.path),
    )!;
    const expectedPlanBytes = built.files.get(
      String(expectedPlanBinding.path),
    )!;
    const expectedProofsBytes = built.files.get(
      String(expectedProofsBinding.path),
    )!;
    const expectedProgramsBytes = built.files.get(
      String(expectedProgramsBinding.path),
    )!;
    const expectedResult = strictParseJsonBytes(
      Buffer.from(expectedResultBytes),
    ) as JsonObject;
    const input = {
      caseId: 'positive.static-lowering',
      sourceKind: 'workflow_definition' as const,
      rawSourceText: sourceText,
      expectedSourceHash: expectedResult.source_hash as `sha256:${string}`,
      inputSnapshot: snapshot.payload,
      expectedDiagnostics: [],
    };
    const v5 = authorV5ExpectedResult(input);
    const v6 = authorV6ExpectedResult(input);
    const v5Plan = v5.normalized_plan as unknown as JsonObject;
    const v6Plan = v6.normalized_plan as unknown as JsonObject;
    const descriptorCount = (plan: JsonObject) =>
      (plan.nodes as JsonObject[]).filter(
        (node) => node.output_envelope_schema !== undefined,
      ).length;

    expect(descriptorCount(v5Plan)).toBe(0);
    expect(descriptorCount(v6Plan)).toBe(3);
    expect(v5.result_hash).toBe(
      'sha256:707cc336c6b96732d9c3bf96e42ee21d46db4b636912e50598dffdcb974a4ea4',
    );
    expect(v6.result_hash).toBe(
      'sha256:a09b8c0ef277d3a71cd486ccb96fedb2afe32ac15f05a86d2cbf5e071c95d394',
    );
    expect(v6).toEqual(expectedResult);
    expect(v5).not.toEqual(expectedResult);
    expect(v5Plan).not.toEqual(v6Plan);
    expect(v6Plan).toEqual(
      strictParseJsonBytes(Buffer.from(expectedPlanBytes)),
    );
    expect(extractV6ProofBytes(v6Plan)).toEqual(
      strictParseJsonBytes(Buffer.from(expectedProofsBytes)),
    );
    expect(extractV6ProgramBytes(v6Plan)).toEqual(
      strictParseJsonBytes(Buffer.from(expectedProgramsBytes)),
    );
    expect(rawHash(expectedResultBytes)).toBe(
      expectedResultBinding.raw_bytes_hash,
    );
    expect(rawHash(expectedPlanBytes)).toBe(expectedPlanBinding.raw_bytes_hash);
    expect(rawHash(expectedProofsBytes)).toBe(
      expectedProofsBinding.raw_bytes_hash,
    );
    expect(rawHash(expectedProgramsBytes)).toBe(
      expectedProgramsBinding.raw_bytes_hash,
    );
    expect(v6.result_hash).toBe(expectedResultBinding.semantic_hash);
    expect(v6Plan.plan_hash).toBe(expectedPlanBinding.semantic_hash);
    expect(v6.proof_hashes).toEqual(staticLowering.expected_proof_hashes);
    expect(v6.program_hashes).toEqual(staticLowering.expected_program_hashes);
    expect(extractV5ProofBytes(v5Plan)).toEqual(extractV6ProofBytes(v6Plan));
    expect(extractV5ProgramBytes(v5Plan)).toEqual(
      extractV6ProgramBytes(v6Plan),
    );
  }, 30_000);

  it('builds closed deterministic semantic-review and seal artifacts', () => {
    const review = buildG2NodeOutputEnvelopeSemanticReview(approvedInput());
    const seal = buildG2NodeOutputEnvelopeSeal();
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(
      ajv.compile(G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA as AnySchema)(
        review.review.payload,
      ),
    ).toBe(true);
    expect(
      ajv.compile(
        G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA as AnySchema,
      )(seal.bundle.payload),
    ).toBe(true);
    expect(
      ajv.compile(G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA as AnySchema)(
        seal.inventory.payload,
      ),
    ).toBe(true);
    expect(checkG2NodeOutputEnvelopeSemanticReview().hash).toBe(
      review.review.hash,
    );
    expect(checkG2NodeOutputEnvelopeSeal().hash).toBe(seal.bundle.hash);
    expect(seal.bundle.payload).toMatchObject({
      case_count: 40,
      sealed_artifact_count: 157,
      bundle_hash:
        'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7',
    });
  }, 30_000);

  it('rejects authoring source-byte drift against the approved Draft binding', () => {
    const authoringPath = path.join(
      repoRoot,
      G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
    );
    const readFileSync = fs.readFileSync;
    const readFileSyncSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation(((
        filePath: fs.PathOrFileDescriptor,
        options?: unknown,
      ) =>
        path.resolve(String(filePath)) === authoringPath
          ? Buffer.from('drifted NodeOutputEnvelope authoring source')
          : readFileSync(
              filePath,
              options as never,
            )) as typeof fs.readFileSync);
    try {
      expect(() =>
        buildG2NodeOutputEnvelopeSemanticReview(approvedInput()),
      ).toThrow(
        'Approved successor Draft does not bind the actual NodeOutputEnvelope authoring generator bytes',
      );
    } finally {
      readFileSyncSpy.mockRestore();
    }
  });

  it('passes exact current sealed replay', () => {
    expect(evaluateCurrentG2GoldenReplay()).toMatchObject({
      exact_equal_count: 40,
      mismatch_count: 0,
      passed: true,
    });
  }, 30_000);
});
