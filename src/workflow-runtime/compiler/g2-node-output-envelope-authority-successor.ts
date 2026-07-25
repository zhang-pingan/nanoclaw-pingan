import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import ts from 'typescript';

import { compileWorkflow } from './compiler.js';
import {
  buildWorkflowCompilerToolchainManifest,
  workflowCompilerIdentity,
} from './identity.js';
import { buildSemanticCorrectionCandidate } from './semantic-correction.js';
import type { WorkflowCompilerIdentity } from './types.js';
import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import {
  checkCompilerSemanticCorrectionContract,
  COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
} from '../contracts/compiler-semantic-correction-contract.js';
import {
  checkGeneratedSchemaJoinAuthorityRepair,
  GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_PACK_PATH,
} from '../contracts/generated-schema-join-authority-repair.js';
import type {
  CompilerConformanceDiagnosticV1,
  WorkflowCompilerConformanceCaseResultV1,
} from '../contracts/compiler-contract-repair-types.js';
import {
  authorCurrentG2GoldenExpectedResult,
  extractCurrentG2GoldenProgramBytes,
  extractCurrentG2GoldenProofBytes,
} from '../contracts/node-output-envelope-golden-authoring.js';
import { CURRENT_G2_GOLDEN_DRAFT_MANIFEST_PATH } from '../contracts/current-g2-golden-draft.js';
import {
  CURRENT_G2_GOLDEN_CASES_SCHEMA,
  CURRENT_G2_GOLDEN_INVENTORY_SCHEMA,
  CURRENT_G2_GOLDEN_MANIFEST_SCHEMA,
  CURRENT_G2_GOLDEN_REVIEW_SCHEMA,
} from '../contracts/current-g2-golden-schemas.js';
import type {
  CurrentG2GoldenCase,
  CurrentG2GoldenCaseCatalogPayload,
  CurrentG2GoldenContentIdentity,
  CurrentG2GoldenDraftManifestPayload,
  CurrentG2GoldenInventoryEntry,
  CurrentG2GoldenInventoryPayload,
  CurrentG2GoldenOptionalContentIdentity,
  CurrentG2GoldenReviewCase,
  CurrentG2GoldenReviewPayload,
} from '../contracts/current-g2-golden-types.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../contracts/types.js';

const contractsRoot = path.resolve(import.meta.dirname, '../contracts');
const projectRoot = path.resolve(contractsRoot, '../../..');

export const G2_NODE_OUTPUT_ENVELOPE_RC_ROOT =
  'conformance/review-candidate/g2-generated-schema-join-authority-v6';
export const G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT =
  'conformance/golden-draft/g2-generated-schema-join-authority-v6';
export const G2_NODE_OUTPUT_ENVELOPE_REVIEW_ROOT =
  'conformance/golden-review/g2-generated-schema-join-authority-v6';

export const G2_NODE_OUTPUT_ENVELOPE_TOOLCHAIN_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/workflow-compiler-toolchain@3.0.4.json`;
export const G2_NODE_OUTPUT_ENVELOPE_BINDING_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/g2-case-input-binding@4.json`;
export const G2_NODE_OUTPUT_ENVELOPE_CONTRACT_ROOT_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/working-contract-root@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_INPUT_ROOT_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/working-input-root@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_CANDIDATE_ROOT_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/working-candidate-root@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_WORKING_REVIEW_ROOT_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/working-review-root@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_RC_CASES_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/review-candidate-cases@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_RC_INVENTORY_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/artifact-inventory@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_RC_MANIFEST_PATH = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/review-candidate@2.json`;

export const G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/golden-draft-cases@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_DRAFT_INVENTORY_PATH = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/artifact-inventory@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/golden-draft-manifest@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_PATH = `${G2_NODE_OUTPUT_ENVELOPE_REVIEW_ROOT}/golden-review-report@2.json`;

export const G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF =
  'src/workflow-runtime/contracts/node-output-envelope-golden-authoring.ts';

const G2_NODE_OUTPUT_ENVELOPE_AUTHORING_MODULE_SPECIFIER =
  '../contracts/node-output-envelope-golden-authoring.js';
const G2_NODE_OUTPUT_ENVELOPE_AUTHORING_HELPERS = [
  'authorCurrentG2GoldenExpectedResult',
  'extractCurrentG2GoldenProgramBytes',
  'extractCurrentG2GoldenProofBytes',
] as const;

const DRAFT_CASES_SCHEMA_PATH = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/schemas/golden-draft-cases-schema@1.json`;
const DRAFT_INVENTORY_SCHEMA_PATH = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/schemas/golden-draft-inventory-schema@1.json`;
const DRAFT_MANIFEST_SCHEMA_PATH = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/schemas/golden-draft-manifest-schema@1.json`;
const REVIEW_SCHEMA_PATH = `${G2_NODE_OUTPUT_ENVELOPE_REVIEW_ROOT}/schemas/golden-review-report-schema@1.json`;

const PREDECESSOR = Object.freeze({
  working_contract_root:
    'sha256:8bcbef902859b406f99101b996e6c8ccc07785b05f1935d145a30f7f79f1ec19',
  working_input_root:
    'sha256:ecd9c3d889c6b0ce7d3ae7f1f59046b5950e24f1f17a38f2a55b25626d85e6aa',
  working_candidate_root:
    'sha256:9e217fad5593715ddadbf93a33e20d4caf8bf43386e86ceec22acf0fb654b0ce',
  working_review_root:
    'sha256:a448daa01c55cb98804e6d29bd9db214f596a75818230dbe47481a7a640cb92a',
  review_candidate_root:
    'sha256:6fe9c6804237ea00dfb73c50dcd9a5dd658956b54e67db554817067433c584f6',
  draft_manifest_hash:
    'sha256:965b1af2c4688c827a9d63f6b939a130271ab0e8b0fcf85a614cdd2620cb757e',
  golden_review_report_hash:
    'sha256:96f6d0feee0e4a7d77349e0d8210875dc518a40ada167785c0859193a0246180',
  golden_semantic_review_hash:
    'sha256:4481515b905ca062e3d028e17bb13ed2d4080059e844efa6c609ef292967e0de',
  sealed_bundle_hash:
    'sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05',
});

const RAW_SOURCE_DOMAIN = 'icarus:workflow-semantic-correction-raw-source:1\n';
const SNAPSHOT_DOMAIN = 'icarus:workflow-compiler-input-snapshot:2\n';
const EFFECTIVE_INPUT_DOMAIN =
  'icarus:workflow-compiler-effective-case-input:4\n';
const BINDING_DOMAIN = 'icarus:workflow-compiler-g2-case-input-binding:4\n';
const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const PLAN_DOMAIN = 'icarus:workflow-graph-plan:2\n';
const PROOF_BYTES_DOMAIN = 'icarus:workflow-current-g2-golden-proof-bytes:1\n';
const PROGRAM_BYTES_DOMAIN =
  'icarus:workflow-current-g2-golden-program-bytes:1\n';
const CASES_DOMAIN = 'icarus:workflow-current-g2-golden-draft-cases:1\n';
const INVENTORY_DOMAIN =
  'icarus:workflow-current-g2-golden-draft-inventory:1\n';
const MANIFEST_DOMAIN = 'icarus:workflow-current-g2-golden-draft-manifest:1\n';
const REPORT_DOMAIN = 'icarus:workflow-current-g2-golden-review-report:1\n';
const SOURCE_SET_DOMAIN =
  'icarus:workflow-compiler-g2-node-output-envelope-authority-source-set:1\n';
const RC_INVENTORY_DOMAIN =
  'icarus:workflow-compiler-g2-node-output-envelope-authority-inventory:1\n';

const ARTIFACT_DOMAINS = Object.freeze({
  working_contract:
    'icarus:workflow-compiler-g2-node-output-envelope-authority-working-contract-artifact:1\n',
  working_input:
    'icarus:workflow-compiler-g2-node-output-envelope-authority-working-input-artifact:1\n',
  working_candidate:
    'icarus:workflow-compiler-g2-node-output-envelope-authority-working-candidate-artifact:1\n',
  working_review:
    'icarus:workflow-compiler-g2-node-output-envelope-authority-working-review-artifact:1\n',
  rc_cases:
    'icarus:workflow-compiler-g2-node-output-envelope-authority-rc-cases-artifact:1\n',
  rc_inventory:
    'icarus:workflow-compiler-g2-node-output-envelope-authority-rc-inventory-artifact:1\n',
  rc: 'icarus:workflow-compiler-g2-node-output-envelope-authority-rc-artifact:1\n',
  draft_cases: 'icarus:workflow-current-g2-golden-draft-cases-artifact:1\n',
  draft_inventory:
    'icarus:workflow-current-g2-golden-draft-inventory-artifact:1\n',
  draft_manifest:
    'icarus:workflow-current-g2-golden-draft-manifest-artifact:1\n',
  draft_schema_cases:
    'icarus:workflow-current-g2-golden-draft-cases-schema:1\n',
  draft_schema_inventory:
    'icarus:workflow-current-g2-golden-draft-inventory-schema:1\n',
  draft_schema_manifest:
    'icarus:workflow-current-g2-golden-draft-manifest-schema:1\n',
  review: 'icarus:workflow-current-g2-golden-review-report-artifact:1\n',
  review_schema: 'icarus:workflow-current-g2-golden-review-report-schema:1\n',
});

const AUTHORIZED_ACTOR = 'human:local-owner';

export class G2NodeOutputEnvelopeSuccessorError extends Error {
  readonly code = 'g2_node_output_envelope_successor_error';

  constructor(message: string) {
    super(message);
    this.name = 'G2NodeOutputEnvelopeSuccessorError';
  }
}

export interface G2NodeOutputEnvelopeSuccessorBuild {
  files: Map<string, string>;
  rc: ContractArtifactEnvelope;
  draft: ContractArtifactEnvelope;
  review: ContractArtifactEnvelope;
  compilerIdentity: WorkflowCompilerIdentity;
  exactEqualCount: number;
  pointerDifferenceCount: number;
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      `NodeOutputEnvelope path escapes contracts root: ${relativePath}`,
    );
  }
  return resolved;
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
    return value;
  } catch {
    throw new G2NodeOutputEnvelopeSuccessorError(`Expected object: ${label}`);
  }
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new G2NodeOutputEnvelopeSuccessorError(`Expected array: ${label}`);
  }
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function rawHash(bytes: Uint8Array | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function isLexicalBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isEnumDeclaration(parent) && parent.name === node) ||
    (ts.isModuleDeclaration(parent) && parent.name === node) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node)
  );
}

function boundSuccessorSource(successorSourceText: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const sourcePath = path.resolve(
    import.meta.dirname,
    'g2-node-output-envelope-authority-successor.ts',
  );
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const sourceFile = ts.createSourceFile(
    sourcePath,
    successorSourceText,
    options.target!,
    true,
    ts.ScriptKind.TS,
  );
  const host: ts.CompilerHost = {
    fileExists: (fileName) => fileName === sourcePath,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getDefaultLibFileName: () => 'lib.d.ts',
    getDirectories: () => [],
    getNewLine: () => '\n',
    getSourceFile: (fileName) =>
      fileName === sourcePath ? sourceFile : undefined,
    readFile: (fileName) =>
      fileName === sourcePath ? successorSourceText : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  const program = ts.createProgram([sourcePath], options, host);
  const boundSource = program.getSourceFile(sourcePath);
  if (
    boundSource !== sourceFile ||
    program.getSyntacticDiagnostics(sourceFile).length !== 0
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Successor authoring binding source is not valid TypeScript',
    );
  }
  return { sourceFile, checker: program.getTypeChecker() };
}

function authoringGeneratorIdentity(
  successorSourceText = fs.readFileSync(
    path.resolve(
      projectRoot,
      'src/workflow-runtime/compiler/g2-node-output-envelope-authority-successor.ts',
    ),
    'utf8',
  ),
): { ref: string; rawHash: Sha256Hash } {
  const { sourceFile, checker } = boundSuccessorSource(successorSourceText);
  const requiredImports = new Set<string>(
    G2_NODE_OUTPUT_ENVELOPE_AUTHORING_HELPERS,
  );
  const importedBindings = new Map<
    string,
    Array<{ declaration: ts.ImportSpecifier; moduleSpecifier: string }>
  >(G2_NODE_OUTPUT_ENVELOPE_AUTHORING_HELPERS.map((name) => [name, []]));

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text ===
        G2_NODE_OUTPUT_ENVELOPE_AUTHORING_MODULE_SPECIFIER &&
      (!statement.importClause ||
        statement.importClause.name !== undefined ||
        !statement.importClause.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings))
    ) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        'Successor authoring module access must use unique named imports',
      );
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (requiredImports.has(importedName)) {
        importedBindings.get(importedName)!.push({
          declaration: element,
          moduleSpecifier: statement.moduleSpecifier.text,
        });
      }
    }
  }

  const resolvedBindings = new Map<
    string,
    { declaration: ts.ImportSpecifier; localName: string; symbol: ts.Symbol }
  >();
  for (const exportedName of G2_NODE_OUTPUT_ENVELOPE_AUTHORING_HELPERS) {
    const candidates = importedBindings.get(exportedName)!;
    if (candidates.length !== 1) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        'Successor authoring helpers must each have one unique named import',
      );
    }
    const { declaration, moduleSpecifier } = candidates[0]!;
    const importDeclaration = declaration.parent.parent.parent;
    if (
      moduleSpecifier !== G2_NODE_OUTPUT_ENVELOPE_AUTHORING_MODULE_SPECIFIER ||
      !ts.isImportDeclaration(importDeclaration) ||
      importDeclaration.importClause?.isTypeOnly === true ||
      declaration.isTypeOnly
    ) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        'Declared authoring generator is not the generator actually imported and invoked',
      );
    }
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (
      !symbol ||
      !(symbol.flags & ts.SymbolFlags.Alias) ||
      symbol.declarations?.length !== 1 ||
      symbol.declarations[0] !== declaration
    ) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        'Successor authoring helper local binding is conflicting or non-unique',
      );
    }
    resolvedBindings.set(exportedName, {
      declaration,
      localName: declaration.name.text,
      symbol,
    });
  }

  if (
    new Set([...resolvedBindings.values()].map(({ symbol }) => symbol)).size !==
      G2_NODE_OUTPUT_ENVELOPE_AUTHORING_HELPERS.length ||
    new Set([...resolvedBindings.values()].map(({ localName }) => localName))
      .size !== G2_NODE_OUTPUT_ENVELOPE_AUTHORING_HELPERS.length
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Successor authoring helper local binding is conflicting or non-unique',
    );
  }

  const protectedBindingNames = new Set([
    ...G2_NODE_OUTPUT_ENVELOPE_AUTHORING_HELPERS,
    ...[...resolvedBindings.values()].map(({ localName }) => localName),
  ]);
  const acceptedDeclarations = new Set(
    [...resolvedBindings.values()].map(({ declaration }) => declaration.name),
  );
  let shadowedBinding = false;
  let authoringCallCount = 0;
  let escapedAuthoringBinding = false;
  let alternateAuthoringModuleAccess = false;
  const expectedResultSymbol = resolvedBindings.get(
    'authorCurrentG2GoldenExpectedResult',
  )!.symbol;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text ===
        G2_NODE_OUTPUT_ENVELOPE_AUTHORING_MODULE_SPECIFIER
    ) {
      alternateAuthoringModuleAccess = true;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[0]!.text ===
        G2_NODE_OUTPUT_ENVELOPE_AUTHORING_MODULE_SPECIFIER &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      alternateAuthoringModuleAccess = true;
    }
    if (
      ts.isIdentifier(node) &&
      protectedBindingNames.has(node.text) &&
      isLexicalBindingIdentifier(node) &&
      !acceptedDeclarations.has(node)
    ) {
      shadowedBinding = true;
    }
    if (
      ts.isIdentifier(node) &&
      checker.getSymbolAtLocation(node) === expectedResultSymbol &&
      !acceptedDeclarations.has(node) &&
      !(
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        node.parent.questionDotToken === undefined
      )
    ) {
      escapedAuthoringBinding = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.questionDotToken === undefined &&
      checker.getSymbolAtLocation(node.expression) === expectedResultSymbol
    ) {
      authoringCallCount += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (
    shadowedBinding ||
    escapedAuthoringBinding ||
    alternateAuthoringModuleAccess
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Successor authoring helper local binding is shadowed or non-unique',
    );
  }
  if (authoringCallCount !== 1) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Successor expected authoring must have one exact imported generator and one invocation',
    );
  }

  const declaredRefs: ts.VariableDeclaration[] = [];
  const collectDeclaredRefs = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF'
    ) {
      declaredRefs.push(node);
    }
    ts.forEachChild(node, collectDeclaredRefs);
  };
  collectDeclaredRefs(sourceFile);
  const declaredRef = declaredRefs[0];
  const declaredRefStatement = declaredRef?.parent.parent;
  if (
    declaredRefs.length !== 1 ||
    !declaredRef ||
    !ts.isVariableStatement(declaredRefStatement) ||
    declaredRefStatement.parent !== sourceFile ||
    !(declaredRef.parent.flags & ts.NodeFlags.Const) ||
    !declaredRefStatement.modifiers?.some(
      ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
    ) ||
    !declaredRef.initializer ||
    !ts.isStringLiteral(declaredRef.initializer) ||
    declaredRef.initializer.text !==
      G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Declared authoring generator ref is missing, conflicting, or drifted',
    );
  }

  const resolvedImport = path.resolve(
    import.meta.dirname,
    G2_NODE_OUTPUT_ENVELOPE_AUTHORING_MODULE_SPECIFIER.replace(/\.js$/, '.ts'),
  );
  const declaredPath = path.resolve(
    projectRoot,
    G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
  );
  if (
    resolvedImport !== declaredPath ||
    path.relative(projectRoot, resolvedImport).split(path.sep).join('/') !==
      G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Declared authoring generator is not the generator actually imported and invoked',
    );
  }
  return {
    ref: G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
    rawHash: rawHash(fs.readFileSync(declaredPath)),
  };
}

export function assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(
  successorSourceText?: string,
): { ref: string; rawHash: Sha256Hash } {
  return authoringGeneratorIdentity(successorSourceText);
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(
  format: string,
  id: string,
  refVersion: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const value: ContractArtifactEnvelope = {
    format,
    ref: { id, version: refVersion },
    version: Number(format.slice(format.lastIndexOf('/') + 1)),
    domain_separator: domain,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  value.hash = calculateArtifactHash(value);
  return value;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function identity(
  artifactPath: string,
  semanticHash: Sha256Hash,
  bytes: Uint8Array | string,
): JsonObject {
  return {
    path: artifactPath,
    semantic_hash: semanticHash,
    raw_bytes_hash: rawHash(bytes),
  };
}

function contentIdentity(
  artifactPath: string,
  bytes: string,
  semanticHash: Sha256Hash,
  domain: string,
): CurrentG2GoldenContentIdentity {
  return {
    path: artifactPath,
    media_type: 'application/json',
    canonicalization: 'rfc8785_jcs',
    raw_bytes_hash: rawHash(bytes),
    semantic_hash: semanticHash,
    domain_separator: domain,
  };
}

function absentContent(): CurrentG2GoldenOptionalContentIdentity {
  return {
    path: null,
    media_type: null,
    canonicalization: null,
    raw_bytes_hash: null,
    semantic_hash: null,
    domain_separator: null,
  };
}

function draftInventoryEntry(
  value: CurrentG2GoldenContentIdentity,
  kind: CurrentG2GoldenInventoryEntry['kind'],
  caseId: string | null,
): CurrentG2GoldenInventoryEntry {
  return {
    path: value.path,
    kind,
    case_id: caseId,
    raw_bytes_hash: value.raw_bytes_hash,
    semantic_hash: value.semantic_hash,
    domain_separator: value.domain_separator,
  };
}

function validatePredecessor(): JsonObject {
  const draft = readArtifact(
    'conformance/golden-draft/g2-generated-schema-join-authority-v5/golden-draft-manifest@2.json',
  );
  const review = readArtifact(
    'conformance/golden-review/g2-generated-schema-join-authority-v5/golden-review-report@2.json',
  );
  const seal = readArtifact(
    'conformance/sealed/g2-generated-schema-join-authority-v5/golden-conformance-bundle@2.json',
  );
  if (
    draft.payload.draft_manifest_hash !== PREDECESSOR.draft_manifest_hash ||
    review.payload.report_hash !== PREDECESSOR.golden_review_report_hash ||
    seal.payload.bundle_hash !== PREDECESSOR.sealed_bundle_hash
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Predecessor immutable lineage drift',
    );
  }
  const semanticReview = readArtifact(
    'conformance/golden-semantic-review/g2-generated-schema-join-authority-v5/golden-semantic-review@2.json',
  );
  if (
    semanticReview.payload.review_hash !==
    PREDECESSOR.golden_semantic_review_hash
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Predecessor GoldenSemanticReview drift',
    );
  }
  return {
    predecessor_working_roots: {
      contract: PREDECESSOR.working_contract_root,
      input: PREDECESSOR.working_input_root,
      candidate: PREDECESSOR.working_candidate_root,
      working_review: PREDECESSOR.working_review_root,
    },
    predecessor_review_candidate_root: PREDECESSOR.review_candidate_root,
    predecessor_draft_manifest_hash: PREDECESSOR.draft_manifest_hash,
    predecessor_golden_review_report_hash:
      PREDECESSOR.golden_review_report_hash,
    predecessor_golden_semantic_review_hash:
      PREDECESSOR.golden_semantic_review_hash,
    predecessor_sealed_bundle_hash: PREDECESSOR.sealed_bundle_hash,
    predecessor_sealed_status: 'sealed_pending_ci_replay',
    successor_reason: 'r019_node_output_envelope_schema_authority_repair',
    approved_expected_semantics: 'changed_by_current_review',
  };
}

function successorSnapshot(
  caseId: string,
  bytes: string,
): ContractArtifactEnvelope {
  const predecessor = parseContractArtifactEnvelope(
    strictParseJsonBytes(Buffer.from(bytes, 'utf8')),
  );
  const payloadWithoutHash = clone(predecessor.payload);
  delete payloadWithoutHash.snapshot_hash;
  payloadWithoutHash.snapshot_id = `g2-generated-schema-join-authority-v6:${caseId}`;
  const payload = {
    ...payloadWithoutHash,
    snapshot_hash: domainSeparatedSha256(SNAPSHOT_DOMAIN, payloadWithoutHash),
  };
  return artifact(
    predecessor.format,
    `${predecessor.ref.id}.generated-schema-join-authority-v6`,
    '6.0.0',
    predecessor.domain_separator,
    payload,
  );
}

function resultHash(
  result: Omit<WorkflowCompilerConformanceCaseResultV1, 'result_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(RESULT_DOMAIN, result as JsonValue);
}

export function compileG2NodeOutputEnvelopeCase(
  caseId: string,
  sourceKind: 'graph_scope' | 'workflow_definition' | 'workflow_schema',
  sourceBytes: Buffer,
  snapshot: ContractArtifactEnvelope,
  compilerIdentity: WorkflowCompilerIdentity,
): WorkflowCompilerConformanceCaseResultV1 {
  const outcome = compileWorkflow({
    caseId,
    sourceKind,
    rawSourceBytes: sourceBytes,
    inputSnapshot: snapshot.payload,
    identity: compilerIdentity,
  });
  if (!outcome.ok) {
    const withoutHash = {
      format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
      case_id: caseId,
      source_kind: sourceKind,
      source_hash: outcome.value.sourceHash,
      outcome: 'rejected' as const,
      normalized_plan: null,
      static_lowering_contract_ref: null,
      static_lowering_contract_hash: null,
      diagnostics: outcome.value.diagnostics,
      proof_hashes: [] as Sha256Hash[],
      program_hashes: [] as Sha256Hash[],
    };
    return { ...withoutHash, result_hash: resultHash(withoutHash) };
  }
  const withoutHash = {
    format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
    case_id: caseId,
    source_kind: sourceKind,
    source_hash: outcome.value.sourceHash,
    outcome: 'compiled' as const,
    normalized_plan: outcome.value.plan,
    static_lowering_contract_ref: outcome.value.staticLowering
      ? {
          id: 'icarus.workflow-definition-static-lowering-contract',
          version: '1.0.0',
        }
      : null,
    static_lowering_contract_hash: outcome.value.staticLowering
      ? ('sha256:905b433c6909d6e61663a65d532850f60b0e62a9c6c5f039a1280e3dad44b430' as Sha256Hash)
      : null,
    diagnostics: [] as [],
    proof_hashes: outcome.value.proofHashes,
    program_hashes: outcome.value.programHashes,
  };
  return { ...withoutHash, result_hash: resultHash(withoutHash) };
}

function reducedRoots(
  roots: Record<string, { path: string; artifact: ContractArtifactEnvelope }>,
  files: Map<string, string>,
): JsonObject {
  return Object.fromEntries(
    Object.entries(roots).map(([key, value]) => [
      key,
      identity(
        value.path,
        value.artifact.hash,
        files.get(value.path) ?? render(value.artifact),
      ),
    ]),
  );
}

function validateSchema(schema: JsonObject, value: JsonValue, label: string) {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    schema as AnySchema,
  );
  if (!validate(value)) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      `${label} failed closed schema: ${JSON.stringify(validate.errors)}`,
    );
  }
}

function pointerValue(root: JsonValue, pointer: string): JsonValue | undefined {
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

function assertionPass(result: JsonValue, assertion: JsonObject): boolean {
  const observed = pointerValue(result, String(assertion.subject_pointer));
  switch (assertion.operator) {
    case 'equals':
    case 'ordered_equals':
      return (
        canonicalJson(observed ?? null) === canonicalJson(assertion.expected)
      );
    case 'set_equals': {
      const left = Array.isArray(observed)
        ? observed
        : observed && typeof observed === 'object'
          ? Object.keys(observed)
          : [];
      const right = Array.isArray(assertion.expected)
        ? assertion.expected
        : [assertion.expected];
      return (
        canonicalJson([...left].sort()) === canonicalJson([...right].sort())
      );
    }
    case 'contains':
      return Array.isArray(observed)
        ? observed.some(
            (entry) =>
              canonicalJson(entry) === canonicalJson(assertion.expected),
          )
        : !!observed &&
            typeof observed === 'object' &&
            typeof assertion.expected === 'string' &&
            assertion.expected in observed;
    case 'present':
      return observed !== undefined;
    case 'absent':
      return observed === undefined;
    default:
      return false;
  }
}

function joinAuthoritySource(
  sourceText: string,
  callerSuppliesOutputPorts: boolean,
): string {
  const source = object(
    strictParseJsonBytes(Buffer.from(sourceText, 'utf8')),
    'join authority source',
  );
  source.scope_key = callerSuppliesOutputPorts
    ? 'join_caller_authority_rejected'
    : 'join_generated_authority';
  source.nodes = [
    {
      id: 'producer',
      type: 'system',
      trigger: { type: 'root' },
      capability_ref: {
        id: 'fixture.capability.route',
        version: '1.0.0',
      },
    },
    {
      id: 'join',
      type: 'join',
      trigger: { type: 'all', edge_ids: ['control.producer_join'] },
      input_ports: {
        source: {
          schema_ref: {
            id: 'fixture.schema.route-result',
            version: '1.0.0',
          },
          max_bytes: 4096,
          aggregation: { type: 'single', required: true, select: 'only' },
        },
      },
      expose: { renamed: { input_port: 'source' } },
      ...(callerSuppliesOutputPorts
        ? {
            output_ports: {
              renamed: {
                schema_ref: {
                  id: 'fixture.schema.route-result',
                  version: '1.0.0',
                },
                max_bytes: 4096,
                required: true,
              },
            },
          }
        : {}),
    },
    {
      id: 'sink',
      type: 'join',
      trigger: { type: 'all', edge_ids: ['control.join_sink'] },
      input_ports: {
        value: {
          schema_ref: {
            id: 'fixture.schema.route-result',
            version: '1.0.0',
          },
          max_bytes: 4096,
          aggregation: { type: 'single', required: true, select: 'only' },
        },
      },
      expose: {},
    },
    {
      id: 'done',
      type: 'terminal',
      trigger: { type: 'all', edge_ids: ['control.sink_done'] },
      exit: 'done',
    },
  ];
  source.control_edges = [
    {
      id: 'control.producer_join',
      kind: 'control',
      from_node_id: 'producer',
      to_node_id: 'join',
      on: { statuses: ['succeeded'] },
    },
    {
      id: 'control.join_sink',
      kind: 'control',
      from_node_id: 'join',
      to_node_id: 'sink',
      on: { statuses: ['succeeded'] },
    },
    {
      id: 'control.sink_done',
      kind: 'control',
      from_node_id: 'sink',
      to_node_id: 'done',
      on: { statuses: ['succeeded'] },
    },
  ];
  source.data_edges = [
    {
      id: 'data.producer_join',
      kind: 'data',
      from: { type: 'node_output', node_id: 'producer', port: 'result' },
      to: { node_id: 'join', port: 'source' },
    },
    {
      id: 'data.join_sink',
      kind: 'data',
      from: { type: 'node_output', node_id: 'join', port: 'renamed' },
      to: { node_id: 'sink', port: 'value' },
    },
  ];
  source.route_groups = [];
  return canonicalJson(source);
}

export function buildG2NodeOutputEnvelopeSuccessor(): G2NodeOutputEnvelopeSuccessorBuild {
  const authoringGenerator = authoringGeneratorIdentity();
  const predecessorLineage = validatePredecessor();
  const semanticContract = checkCompilerSemanticCorrectionContract();
  const generatedSchemaJoinAuthorityContract =
    checkGeneratedSchemaJoinAuthorityRepair();
  const built = buildSemanticCorrectionCandidate();
  const toolchain = buildWorkflowCompilerToolchainManifest();
  const compilerIdentity = workflowCompilerIdentity(toolchain);
  const files = new Map<string, string>();
  files.set(G2_NODE_OUTPUT_ENVELOPE_TOOLCHAIN_PATH, render(toolchain));

  const actualResults = new Map<
    string,
    WorkflowCompilerConformanceCaseResultV1
  >();
  const expectedResults = new Map<
    string,
    WorkflowCompilerConformanceCaseResultV1
  >();
  const successorCases: Array<{
    input: (typeof built.inputs.cases)[number];
    sourcePath: string;
    sourceBytes: Buffer;
    snapshotPath: string;
    snapshot: ContractArtifactEnvelope;
    snapshotBytes: string;
    actualPath: string;
    actualBytes: string;
    actual: WorkflowCompilerConformanceCaseResultV1;
    effectiveInputHash: Sha256Hash;
  }> = [];

  const joinBaseInput = built.inputs.cases.find(
    (candidate) => candidate.case_id === 'positive.condition-route',
  );
  if (!joinBaseInput) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Join authority base case disappeared',
    );
  }
  const joinBaseSourceText = built.files.get(
    joinBaseInput.raw_source_bytes_ref,
  );
  const joinBaseSnapshotText = built.files.get(
    joinBaseInput.input_snapshot_ref,
  );
  if (!joinBaseSourceText || !joinBaseSnapshotText) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'Join authority base source or snapshot disappeared',
    );
  }

  for (const input of built.inputs.cases) {
    const isJoinPositive = input.case_id === 'positive.condition-route';
    const isJoinNegative = input.case_id === 'negative.graph-cross-scope-edge';
    const joinOverride = isJoinPositive || isJoinNegative;
    const sourceText = joinOverride
      ? joinAuthoritySource(joinBaseSourceText, isJoinNegative)
      : built.files.get(input.raw_source_bytes_ref);
    const snapshotText = joinOverride
      ? joinBaseSnapshotText
      : built.files.get(input.input_snapshot_ref);
    if (!sourceText || !snapshotText) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        `Missing successor source or snapshot: ${input.case_id}`,
      );
    }
    const sourcePath = joinOverride
      ? `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/inputs/${input.case_id}.source.json`
      : `conformance/sealed/g2-semantic-correction/inputs/${input.case_id}.source.json`;
    const sourceBytes = joinOverride
      ? Buffer.from(sourceText, 'utf8')
      : fs.readFileSync(absolute(sourcePath));
    const sourceSemanticHash = domainSeparatedSha256(
      RAW_SOURCE_DOMAIN,
      sourceBytes.toString('utf8'),
    );
    if (
      (!joinOverride && sourceSemanticHash !== input.raw_source_bytes_hash) ||
      sourceBytes.toString('utf8') !== sourceText
    ) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        `Sealed source lineage drift: ${input.case_id}`,
      );
    }
    if (joinOverride) files.set(sourcePath, sourceText);
    const effectiveInput = joinOverride
      ? {
          ...input,
          coverage_tags: isJoinPositive
            ? [
                'generated_schema_authority',
                'join_expose_rename',
                'downstream_data_edge_proof',
              ]
            : ['join_expose_caller_authority_forbidden'],
          raw_source_bytes_ref: sourcePath,
          raw_source_bytes_hash: sourceSemanticHash,
          expected_source_hash: domainSeparatedSha256(
            'icarus:workflow-graph-source:1\n',
            object(
              strictParseJsonBytes(sourceBytes),
              'join authority source hash',
            ),
          ),
          review_input: isJoinPositive
            ? {
                role: 'hand_authored_review_input_not_expected_oracle',
                expected_diagnostics: [],
                semantic_assertions: [
                  {
                    assertion_id: 'join-expose-generator',
                    subject_pointer:
                      '/normalized_plan/nodes/1/output_ports/renamed/schema/generator',
                    operator: 'equals',
                    expected: 'join_expose',
                    rationale:
                      'Join expose is lowered from the compiled input contract.',
                  },
                  {
                    assertion_id: 'join-expose-schema-ref',
                    subject_pointer:
                      '/normalized_plan/nodes/1/output_ports/renamed/schema/schema_ref',
                    operator: 'present',
                    expected: true,
                    rationale:
                      'The generated schema carries content-addressed identity.',
                  },
                  {
                    assertion_id: 'join-expose-schema-json',
                    subject_pointer:
                      '/normalized_plan/nodes/1/output_ports/renamed/schema/schema_json',
                    operator: 'present',
                    expected: true,
                    rationale:
                      'The generated schema carries canonical resolvable content.',
                  },
                  {
                    assertion_id: 'join-downstream-proof',
                    subject_pointer:
                      '/normalized_plan/data_edges/0/compatibility_proof/proof_hash',
                    operator: 'present',
                    expected: true,
                    rationale:
                      'The downstream edge is proven against the lowered join output.',
                  },
                ],
              }
            : {
                role: 'hand_authored_review_input_not_expected_oracle',
                expected_diagnostics: [
                  {
                    code: 'schema_unknown_field',
                    phase: 'schema',
                    instance_pointer: '/nodes/1/output_ports',
                    schema_pointer: '#/oneOf/3/additionalProperties',
                    stable_object_id: 'join',
                    detail_ref: null,
                  },
                ],
                semantic_assertions: [
                  {
                    assertion_id: 'join-caller-output-authority-rejected',
                    subject_pointer: '/diagnostics/0/code',
                    operator: 'equals',
                    expected: 'schema_unknown_field',
                    rationale:
                      'Source join output authority is compiler-owned and closed.',
                  },
                  {
                    assertion_id: 'join-caller-output-authority-no-plan',
                    subject_pointer: '/normalized_plan',
                    operator: 'equals',
                    expected: null,
                    rationale:
                      'Rejected caller authority cannot produce a Compiled Plan.',
                  },
                ],
              },
        }
      : input;
    const snapshot = successorSnapshot(input.case_id, snapshotText);
    const snapshotPath = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/inputs/${input.case_id}.snapshot@2.json`;
    const snapshotBytes = render(snapshot);
    files.set(snapshotPath, snapshotBytes);
    const actual = compileG2NodeOutputEnvelopeCase(
      input.case_id,
      input.source_kind,
      sourceBytes,
      snapshot,
      compilerIdentity,
    );
    const actualPath = `${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/actual/${input.case_id}.result.json`;
    const actualBytes = canonicalJson(actual);
    files.set(actualPath, actualBytes);
    actualResults.set(input.case_id, actual);
    const effectiveInputHash = domainSeparatedSha256(EFFECTIVE_INPUT_DOMAIN, {
      case_id: input.case_id,
      raw_source_bytes_ref: sourcePath,
      raw_source_bytes_hash: input.raw_source_bytes_hash,
      input_snapshot_ref: snapshotPath,
      input_snapshot_hash: snapshot.hash,
      identity: compilerIdentity as unknown as JsonObject,
    });
    successorCases.push({
      input: effectiveInput,
      sourcePath,
      sourceBytes,
      snapshotPath,
      snapshot,
      snapshotBytes,
      actualPath,
      actualBytes,
      actual,
      effectiveInputHash,
    });
  }

  const bindingWithoutHash = {
    format: 'icarus.workflow-compiler-g2-case-input-binding/4',
    binding_version: 'g2-generated-schema-join-authority-v6',
    compiler_identity: compilerIdentity as unknown as JsonObject,
    case_inputs: successorCases.map((entry) => ({
      case_id: entry.input.case_id,
      raw_source_bytes_ref: entry.sourcePath,
      raw_source_bytes_hash: entry.input.raw_source_bytes_hash,
      input_snapshot_ref: entry.snapshotPath,
      input_snapshot_hash: entry.snapshot.hash,
      effective_case_input_hash: entry.effectiveInputHash,
    })),
  };
  const binding = {
    ...bindingWithoutHash,
    binding_hash: domainSeparatedSha256(BINDING_DOMAIN, bindingWithoutHash),
  };
  files.set(G2_NODE_OUTPUT_ENVELOPE_BINDING_PATH, render(binding));

  const sourceSetHash = domainSeparatedSha256(
    SOURCE_SET_DOMAIN,
    successorCases.map((entry) => ({
      case_id: entry.input.case_id,
      source_hash: entry.input.raw_source_bytes_hash,
      snapshot_hash: entry.snapshot.hash,
    })),
  );
  const contractRoot = artifact(
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-contract/1',
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-contract',
    '2.0.0-working',
    ARTIFACT_DOMAINS.working_contract,
    {
      gate: 'G2',
      construction_phase: 'WORKING',
      status: 'WORKING_CONTRACT_SUCCESSOR',
      publishable: false,
      production_reachable: false,
      semantic_correction_contract_ref:
        COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
      semantic_correction_contract_hash: semanticContract.hash,
      generated_schema_join_authority_contract_ref:
        GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_PACK_PATH,
      generated_schema_join_authority_contract_hash:
        generatedSchemaJoinAuthorityContract.hash,
      generated_schema_join_authority_contract_status:
        generatedSchemaJoinAuthorityContract.payload.status,
      predecessor_lineage: predecessorLineage,
      approved_expected_semantics: 'canonical_node_output_envelope_authority',
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_CONTRACT_ROOT_PATH, render(contractRoot));

  const inputRoot = artifact(
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-input/1',
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-input',
    '2.0.0-working',
    ARTIFACT_DOMAINS.working_input,
    {
      gate: 'G2',
      construction_phase: 'WORKING',
      status: 'WORKING_INPUTS_SUCCESSOR',
      publishable: false,
      production_reachable: false,
      source_set_hash: sourceSetHash,
      compiler_identity: compilerIdentity as unknown as JsonObject,
      case_count: 40,
      cases: successorCases.map((entry) => ({
        case_id: entry.input.case_id,
        source_ref: entry.sourcePath,
        source_hash: entry.input.raw_source_bytes_hash,
        source_raw_bytes_hash: rawHash(entry.sourceBytes),
        snapshot_ref: entry.snapshotPath,
        snapshot_hash: entry.snapshot.hash,
        snapshot_raw_bytes_hash: rawHash(entry.snapshotBytes),
        effective_case_input_hash: entry.effectiveInputHash,
      })),
      predecessor_lineage: predecessorLineage,
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_INPUT_ROOT_PATH, render(inputRoot));

  const candidateRoot = artifact(
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-candidate/1',
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-candidate',
    '2.0.0-working',
    ARTIFACT_DOMAINS.working_candidate,
    {
      gate: 'G2',
      construction_phase: 'WORKING',
      status: 'WORKING_COMPILER_COMPARISON_SUCCESSOR',
      disposition: 'actual_compiler_output_not_golden_oracle',
      publishable: false,
      production_reachable: false,
      compiler_toolchain_ref: G2_NODE_OUTPUT_ENVELOPE_TOOLCHAIN_PATH,
      compiler_toolchain_hash: toolchain.toolchain_hash,
      compiler_identity: compilerIdentity as unknown as JsonObject,
      case_input_binding_ref: G2_NODE_OUTPUT_ENVELOPE_BINDING_PATH,
      case_input_binding_hash: binding.binding_hash,
      case_count: 40,
      compiled_count: 11,
      rejected_count: 29,
      results: successorCases.map((entry) => ({
        case_id: entry.input.case_id,
        outcome: entry.actual.outcome,
        result_ref: entry.actualPath,
        result_hash: entry.actual.result_hash,
        result_raw_bytes_hash: rawHash(entry.actualBytes),
      })),
      predecessor_lineage: predecessorLineage,
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_CANDIDATE_ROOT_PATH, render(candidateRoot));

  const workingReviewRoot = artifact(
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-review/1',
    'icarus.workflow-compiler-g2-node-output-envelope-authority-working-review',
    '2.0.0-working',
    ARTIFACT_DOMAINS.working_review,
    {
      gate: 'G2',
      construction_phase: 'WORKING',
      status: 'WORKING_REVIEW_SUCCESSOR',
      publishable: false,
      production_reachable: false,
      expected_oracle_role: 'independent_authoring_required',
      actual_comparison_role: 'actual_compiler_output_not_golden_oracle',
      case_count: 40,
      cases: successorCases.map((entry) => ({
        case_id: entry.input.case_id,
        polarity: entry.input.polarity,
        source_kind: entry.input.source_kind,
        coverage_tags: entry.input.coverage_tags,
        review_input: entry.input.review_input,
        actual_compiler_candidate: {
          result_ref: entry.actualPath,
          result_hash: entry.actual.result_hash,
          result_raw_bytes_hash: rawHash(entry.actualBytes),
        },
      })),
      predecessor_lineage: predecessorLineage,
      human_review_status: 'not_requested_until_frozen_draft',
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(
    G2_NODE_OUTPUT_ENVELOPE_WORKING_REVIEW_ROOT_PATH,
    render(workingReviewRoot),
  );

  const workingRoots = {
    contract: {
      path: G2_NODE_OUTPUT_ENVELOPE_CONTRACT_ROOT_PATH,
      artifact: contractRoot,
    },
    input: {
      path: G2_NODE_OUTPUT_ENVELOPE_INPUT_ROOT_PATH,
      artifact: inputRoot,
    },
    candidate: {
      path: G2_NODE_OUTPUT_ENVELOPE_CANDIDATE_ROOT_PATH,
      artifact: candidateRoot,
    },
    working_review: {
      path: G2_NODE_OUTPUT_ENVELOPE_WORKING_REVIEW_ROOT_PATH,
      artifact: workingReviewRoot,
    },
  };
  const boundWorkingRoots = reducedRoots(workingRoots, files);
  const rcCases = artifact(
    'icarus.workflow-compiler-g2-node-output-envelope-authority-rc-cases/1',
    'icarus.workflow-compiler-g2-node-output-envelope-authority-rc-cases',
    '2.0.0-rc',
    ARTIFACT_DOMAINS.rc_cases,
    {
      format:
        'icarus.workflow-compiler-g2-node-output-envelope-authority-rc-cases/1',
      construction_phase: 'RC_REVIEW',
      case_count: 40,
      source_set_hash: sourceSetHash,
      cases: successorCases.map((entry) => ({
        case_id: entry.input.case_id,
        polarity: entry.input.polarity,
        source_kind: entry.input.source_kind,
        coverage_tags: entry.input.coverage_tags,
        source_identity: identity(
          entry.sourcePath,
          entry.input.raw_source_bytes_hash,
          entry.sourceBytes,
        ),
        input_snapshot_identity: identity(
          entry.snapshotPath,
          entry.snapshot.hash,
          entry.snapshotBytes,
        ),
        effective_case_input_hash: entry.effectiveInputHash,
        review_input: entry.input.review_input,
        actual_compiler_comparison: {
          result_ref: entry.actualPath,
          result_hash: entry.actual.result_hash,
          result_raw_bytes_hash: rawHash(entry.actualBytes),
        },
      })),
    },
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_RC_CASES_PATH, render(rcCases));

  const rcInventoryEntries = [...files.entries()]
    .filter(([artifactPath]) =>
      artifactPath.startsWith(`${G2_NODE_OUTPUT_ENVELOPE_RC_ROOT}/`),
    )
    .map(([artifactPath, bytes]) => ({
      path: artifactPath,
      raw_bytes_hash: rawHash(bytes),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const rcInventoryPayloadWithoutHash = {
    format:
      'icarus.workflow-compiler-g2-node-output-envelope-authority-inventory/1',
    construction_phase: 'RC_REVIEW',
    inventory_scope: 'successor_rc_leaf_artifacts_excluding_inventory_and_root',
    entry_count: rcInventoryEntries.length,
    entries: rcInventoryEntries,
  };
  const rcInventory = artifact(
    'icarus.workflow-compiler-g2-node-output-envelope-authority-inventory/1',
    'icarus.workflow-compiler-g2-node-output-envelope-authority-inventory',
    '2.0.0-rc',
    ARTIFACT_DOMAINS.rc_inventory,
    {
      ...rcInventoryPayloadWithoutHash,
      inventory_hash: domainSeparatedSha256(
        RC_INVENTORY_DOMAIN,
        rcInventoryPayloadWithoutHash,
      ),
    },
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_RC_INVENTORY_PATH, render(rcInventory));
  const rc = artifact(
    'icarus.workflow-compiler-g2-node-output-envelope-authority-review-candidate/1',
    'icarus.workflow-compiler-g2-node-output-envelope-authority-review-candidate',
    '2.0.0-rc',
    ARTIFACT_DOMAINS.rc,
    {
      gate: 'G2',
      construction_phase: 'RC_REVIEW',
      status: 'REPLAY_REPAIR_SUCCESSOR_PENDING_HUMAN_REVIEW',
      publishable: false,
      production_reachable: false,
      bound_working_roots: boundWorkingRoots,
      compiler_identity: {
        exact_identity: compilerIdentity as unknown as JsonObject,
      },
      source_identity: { source_set_hash: sourceSetHash },
      cases_ref: G2_NODE_OUTPUT_ENVELOPE_RC_CASES_PATH,
      cases_hash: rcCases.hash,
      inventory_ref: G2_NODE_OUTPUT_ENVELOPE_RC_INVENTORY_PATH,
      inventory_hash: rcInventory.hash,
      actual_comparison: {
        results_manifest_ref: G2_NODE_OUTPUT_ENVELOPE_CANDIDATE_ROOT_PATH,
        results_manifest_hash: candidateRoot.hash,
        role: 'actual_compiler_output_not_golden_oracle',
      },
      predecessor_lineage: predecessorLineage,
      case_count: 40,
      compiled_count: 11,
      rejected_count: 29,
      lifecycle: 'RC_REVIEW',
      blocker: 'OPEN_BLOCKING_G2',
      golden_semantic_review_status: 'not_run',
      seal_status: 'not_run',
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_RC_MANIFEST_PATH, render(rc));

  const draftInventory: CurrentG2GoldenInventoryEntry[] = [];
  for (const [kind, schemaPath, schema, domain] of [
    [
      'cases',
      DRAFT_CASES_SCHEMA_PATH,
      CURRENT_G2_GOLDEN_CASES_SCHEMA,
      ARTIFACT_DOMAINS.draft_schema_cases,
    ],
    [
      'inventory',
      DRAFT_INVENTORY_SCHEMA_PATH,
      CURRENT_G2_GOLDEN_INVENTORY_SCHEMA,
      ARTIFACT_DOMAINS.draft_schema_inventory,
    ],
    [
      'manifest',
      DRAFT_MANIFEST_SCHEMA_PATH,
      CURRENT_G2_GOLDEN_MANIFEST_SCHEMA,
      ARTIFACT_DOMAINS.draft_schema_manifest,
    ],
  ] as const) {
    const schemaArtifact = artifact(
      `icarus.workflow-current-g2-golden-draft-${kind}-schema/1`,
      `icarus.workflow-current-g2-golden-draft-${kind}-schema`,
      '2.0.0-draft',
      domain,
      schema,
    );
    const bytes = render(schemaArtifact);
    files.set(schemaPath, bytes);
    draftInventory.push({
      path: schemaPath,
      kind: 'schema',
      case_id: null,
      raw_bytes_hash: rawHash(bytes),
      semantic_hash: schemaArtifact.hash,
      domain_separator: schemaArtifact.domain_separator,
    });
  }

  const draftCases: CurrentG2GoldenCase[] = [];
  for (const entry of successorCases) {
    const expectedDiagnostics = objects(
      object(entry.input.review_input, 'review input').expected_diagnostics,
      'expected diagnostics',
    ) as unknown as CompilerConformanceDiagnosticV1[];
    const expected = authorCurrentG2GoldenExpectedResult({
      caseId: entry.input.case_id,
      sourceKind: entry.input.source_kind,
      rawSourceText: entry.sourceBytes.toString('utf8'),
      expectedSourceHash: entry.input.expected_source_hash,
      inputSnapshot: entry.snapshot.payload,
      expectedDiagnostics,
    });
    expectedResults.set(entry.input.case_id, expected);
    const resultPath = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/expected/${entry.input.case_id}.result.json`;
    const resultBytes = canonicalJson(expected);
    files.set(resultPath, resultBytes);
    const resultIdentity = contentIdentity(
      resultPath,
      resultBytes,
      expected.result_hash,
      RESULT_DOMAIN,
    );
    draftInventory.push(
      draftInventoryEntry(
        resultIdentity,
        'expected_result',
        entry.input.case_id,
      ),
    );
    let planIdentity: CurrentG2GoldenOptionalContentIdentity = absentContent();
    let proofsIdentity: CurrentG2GoldenOptionalContentIdentity =
      absentContent();
    let programsIdentity: CurrentG2GoldenOptionalContentIdentity =
      absentContent();
    if (expected.outcome === 'compiled') {
      const planPath = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/expected/${entry.input.case_id}.plan.json`;
      const proofsPath = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/expected/${entry.input.case_id}.proofs.json`;
      const programsPath = `${G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT}/expected/${entry.input.case_id}.programs.json`;
      const planBytes = canonicalJson(expected.normalized_plan);
      const proofs = extractCurrentG2GoldenProofBytes(expected.normalized_plan);
      const programs = extractCurrentG2GoldenProgramBytes(
        expected.normalized_plan,
      );
      const proofsBytes = canonicalJson(proofs);
      const programsBytes = canonicalJson(programs);
      files.set(planPath, planBytes);
      files.set(proofsPath, proofsBytes);
      files.set(programsPath, programsBytes);
      planIdentity = contentIdentity(
        planPath,
        planBytes,
        expected.normalized_plan.plan_hash as Sha256Hash,
        PLAN_DOMAIN,
      );
      proofsIdentity = contentIdentity(
        proofsPath,
        proofsBytes,
        domainSeparatedSha256(PROOF_BYTES_DOMAIN, proofs),
        PROOF_BYTES_DOMAIN,
      );
      programsIdentity = contentIdentity(
        programsPath,
        programsBytes,
        domainSeparatedSha256(PROGRAM_BYTES_DOMAIN, programs),
        PROGRAM_BYTES_DOMAIN,
      );
      for (const [value, kind] of [
        [planIdentity, 'expected_plan'],
        [proofsIdentity, 'expected_proofs'],
        [programsIdentity, 'expected_programs'],
      ] as const) {
        draftInventory.push(
          draftInventoryEntry(
            value as CurrentG2GoldenContentIdentity,
            kind,
            entry.input.case_id,
          ),
        );
      }
    }
    const reviewInput = object(entry.input.review_input, 'review input');
    draftCases.push({
      case_id: entry.input.case_id,
      polarity: entry.input.polarity,
      source_kind: entry.input.source_kind,
      coverage_tags: clone(entry.input.coverage_tags),
      source_binding: {
        raw_source_bytes_ref: entry.sourcePath,
        raw_source_bytes_hash: entry.input.raw_source_bytes_hash,
        raw_source_file_hash: rawHash(entry.sourceBytes),
        input_snapshot_ref: entry.snapshotPath,
        input_snapshot_hash: entry.snapshot.hash,
        input_snapshot_file_hash: rawHash(entry.snapshotBytes),
        effective_case_input_hash: entry.effectiveInputHash,
      },
      outcome: expected.outcome,
      expected_result: resultIdentity,
      expected_plan: planIdentity,
      expected_proofs: proofsIdentity,
      expected_programs: programsIdentity,
      expected_plan_hash:
        expected.outcome === 'compiled'
          ? (expected.normalized_plan.plan_hash as Sha256Hash)
          : null,
      expected_proof_hashes: clone(expected.proof_hashes),
      expected_program_hashes: clone(expected.program_hashes),
      expected_diagnostics: clone(expected.diagnostics),
      semantic_assertions: clone(
        objects(reviewInput.semantic_assertions, 'semantic assertions'),
      ),
      authored_from: 'current_spec_machine_contract_source_snapshot',
      human_judgment: null,
    });
  }

  const draftCasesWithoutHash = {
    format: 'icarus.workflow-compiler-current-g2-golden-draft-cases/1' as const,
    construction_phase: 'RC_REVIEW' as const,
    draft_status: 'frozen_pending_human_approval' as const,
    publishable: false as const,
    production_reachable: false as const,
    review_candidate_ref: G2_NODE_OUTPUT_ENVELOPE_RC_MANIFEST_PATH,
    review_candidate_hash: rc.hash,
    source_set_hash: sourceSetHash,
    bound_working_roots: boundWorkingRoots,
    case_count: 40 as const,
    compiled_count: 11 as const,
    rejected_count: 29 as const,
    expected_result_coverage: 40 as const,
    human_judgment_coverage: 0 as const,
    cases: draftCases,
  };
  const draftCasesPayload = {
    ...draftCasesWithoutHash,
    cases_hash: domainSeparatedSha256(CASES_DOMAIN, draftCasesWithoutHash),
  } as CurrentG2GoldenCaseCatalogPayload;
  validateSchema(
    CURRENT_G2_GOLDEN_CASES_SCHEMA,
    draftCasesPayload,
    'NodeOutputEnvelope Draft cases',
  );
  const draftCasesArtifact = artifact(
    'icarus.workflow-compiler-current-g2-golden-draft-cases/1',
    'icarus.workflow-compiler-current-g2-golden-draft-cases',
    '2.0.0-draft',
    ARTIFACT_DOMAINS.draft_cases,
    draftCasesPayload,
  );
  const draftCasesBytes = render(draftCasesArtifact);
  files.set(G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH, draftCasesBytes);
  draftInventory.push({
    path: G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH,
    kind: 'case_catalog',
    case_id: null,
    raw_bytes_hash: rawHash(draftCasesBytes),
    semantic_hash: draftCasesArtifact.hash,
    domain_separator: draftCasesArtifact.domain_separator,
  });
  draftInventory.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const draftInventoryWithoutHash = {
    format:
      'icarus.workflow-compiler-current-g2-golden-draft-inventory/1' as const,
    construction_phase: 'RC_REVIEW' as const,
    inventory_scope: 'all_draft_leaf_artifacts_excluding_manifest' as const,
    entry_count: draftInventory.length,
    entries: draftInventory,
  };
  const draftInventoryPayload = {
    ...draftInventoryWithoutHash,
    inventory_hash: domainSeparatedSha256(
      INVENTORY_DOMAIN,
      draftInventoryWithoutHash,
    ),
  } as CurrentG2GoldenInventoryPayload;
  validateSchema(
    CURRENT_G2_GOLDEN_INVENTORY_SCHEMA,
    draftInventoryPayload,
    'NodeOutputEnvelope Draft inventory',
  );
  const draftInventoryArtifact = artifact(
    'icarus.workflow-compiler-current-g2-golden-draft-inventory/1',
    'icarus.workflow-compiler-current-g2-golden-draft-inventory',
    '2.0.0-draft',
    ARTIFACT_DOMAINS.draft_inventory,
    draftInventoryPayload,
  );
  files.set(
    G2_NODE_OUTPUT_ENVELOPE_DRAFT_INVENTORY_PATH,
    render(draftInventoryArtifact),
  );

  const draftManifestWithoutHash = {
    format:
      'icarus.workflow-compiler-current-g2-golden-draft-manifest/1' as const,
    gate: 'G2' as const,
    construction_phase: 'RC_REVIEW' as const,
    draft_status: 'frozen_pending_human_approval' as const,
    publishable: false as const,
    production_reachable: false as const,
    review_candidate_ref: G2_NODE_OUTPUT_ENVELOPE_RC_MANIFEST_PATH,
    review_candidate_hash: rc.hash,
    source_set_hash: sourceSetHash,
    bound_working_roots: boundWorkingRoots,
    semantic_correction_contract_ref:
      COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
    semantic_correction_contract_hash: semanticContract.hash,
    semantic_correction_input_manifest_ref:
      G2_NODE_OUTPUT_ENVELOPE_INPUT_ROOT_PATH,
    semantic_correction_input_manifest_hash: inputRoot.hash,
    source_case_catalog_ref: G2_NODE_OUTPUT_ENVELOPE_RC_CASES_PATH,
    source_case_catalog_hash: rcCases.hash,
    case_input_binding_ref: G2_NODE_OUTPUT_ENVELOPE_BINDING_PATH,
    case_input_binding_hash: binding.binding_hash,
    toolchain_file_ref: G2_NODE_OUTPUT_ENVELOPE_TOOLCHAIN_PATH,
    toolchain_file_hash: toolchain.toolchain_hash,
    authoring_generator_ref: authoringGenerator.ref,
    authoring_generator_hash: authoringGenerator.rawHash,
    exact_compiler_identity: compilerIdentity,
    cases_ref: G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH,
    cases_hash: draftCasesArtifact.hash,
    inventory_ref: G2_NODE_OUTPUT_ENVELOPE_DRAFT_INVENTORY_PATH,
    inventory_hash: draftInventoryArtifact.hash,
    case_count: 40 as const,
    compiled_count: 11 as const,
    rejected_count: 29 as const,
    expected_result_coverage: 40 as const,
    expected_plan_coverage: 11 as const,
    expected_proof_bytes_coverage: 11 as const,
    expected_program_bytes_coverage: 11 as const,
    human_review: {
      status: 'not_requested' as const,
      reviewer_actor_ref: 'human:local-owner' as const,
      judgment_coverage: 0 as const,
      judgment_record_ref: null,
      judgment_record_hash: null,
    },
    approval: { status: 'absent' as const, ref: null, hash: null },
    signature: { status: 'absent' as const, ref: null, hash: null },
    seal: {
      status: 'absent' as const,
      ref: null,
      hash: null,
      sealed_artifact_count: 0 as const,
      conformance_sealed_write_status: 'not_run' as const,
    },
    golden_semantic_review_status: 'not_run' as const,
    golden_review_report_status: 'generated_after_draft_freeze' as const,
    g3_through_g9_status: 'not_started' as const,
  };
  const draftManifestPayload = {
    ...draftManifestWithoutHash,
    draft_manifest_hash: domainSeparatedSha256(
      MANIFEST_DOMAIN,
      draftManifestWithoutHash as unknown as JsonValue,
    ),
  } as CurrentG2GoldenDraftManifestPayload;
  validateSchema(
    CURRENT_G2_GOLDEN_MANIFEST_SCHEMA,
    draftManifestPayload,
    'NodeOutputEnvelope Draft manifest',
  );
  const draft = artifact(
    'icarus.workflow-compiler-current-g2-golden-draft-manifest/1',
    'icarus.workflow-compiler-current-g2-golden-draft-manifest',
    '2.0.0-draft',
    ARTIFACT_DOMAINS.draft_manifest,
    draftManifestPayload,
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH, render(draft));

  const reviewCases: CurrentG2GoldenReviewCase[] = [];
  let semanticAssertionCount = 0;
  let semanticAssertionFailureCount = 0;
  let exactEqualCount = 0;
  const comparisonMismatches: string[] = [];
  for (const draftCase of draftCases) {
    const expected = expectedResults.get(draftCase.case_id)!;
    const actual = actualResults.get(draftCase.case_id)!;
    const exactEqual = canonicalJson(expected) === canonicalJson(actual);
    if (exactEqual) exactEqualCount += 1;
    else {
      comparisonMismatches.push(
        `${draftCase.case_id}: expected=${canonicalJson(expected)} actual=${canonicalJson(actual)}`,
      );
    }
    const assertions = draftCase.semantic_assertions;
    const failures = assertions
      .filter((assertion) => !assertionPass(expected as never, assertion))
      .map((assertion) => ({
        assertion_id: assertion.assertion_id,
        subject_pointer: assertion.subject_pointer,
        expected: assertion.expected,
        observed:
          pointerValue(expected as never, String(assertion.subject_pointer)) ??
          null,
      }));
    semanticAssertionCount += assertions.length;
    semanticAssertionFailureCount += failures.length;
    const actualEntry = successorCases.find(
      (entry) => entry.input.case_id === draftCase.case_id,
    )!;
    reviewCases.push({
      case_id: draftCase.case_id,
      source_ref: draftCase.source_binding.raw_source_bytes_ref,
      snapshot_ref: draftCase.source_binding.input_snapshot_ref,
      expected_result_ref: draftCase.expected_result.path,
      expected_result_hash: expected.result_hash,
      actual_result_ref: actualEntry.actualPath,
      actual_result_hash: actual.result_hash,
      outcome: expected.outcome,
      byte_equal: exactEqual,
      semantic_equal: exactEqual,
      normalized_plan:
        expected.outcome === 'compiled'
          ? clone(expected.normalized_plan)
          : null,
      diagnostic_pointers: expected.diagnostics.map(
        (diagnostic) => diagnostic.instance_pointer,
      ),
      semantic_assertion_count: assertions.length,
      semantic_assertion_failures: failures,
      difference_count: 0,
      differences: [],
    });
  }
  if (
    exactEqualCount !== 40 ||
    semanticAssertionCount !== 95 ||
    semanticAssertionFailureCount !== 0
  ) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      `Successor comparison is incomplete: exact=${exactEqualCount}/40 assertions=${semanticAssertionCount - semanticAssertionFailureCount}/${semanticAssertionCount}; ${comparisonMismatches.join('; ')}`,
    );
  }
  const reviewPayloadWithoutHash = {
    format:
      'icarus.workflow-compiler-current-g2-golden-review-report/1' as const,
    construction_phase: 'RC_REVIEW' as const,
    report_kind: 'read_only_draft_candidate_comparison' as const,
    publishable: false as const,
    production_reachable: false as const,
    draft_manifest_ref: G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH,
    draft_manifest_hash: draftManifestPayload.draft_manifest_hash,
    review_candidate_ref: G2_NODE_OUTPUT_ENVELOPE_RC_MANIFEST_PATH,
    review_candidate_hash: rc.hash,
    candidate_root_ref: G2_NODE_OUTPUT_ENVELOPE_CANDIDATE_ROOT_PATH,
    candidate_root_hash: candidateRoot.hash,
    actual_results_manifest_ref: G2_NODE_OUTPUT_ENVELOPE_CANDIDATE_ROOT_PATH,
    actual_results_manifest_hash: candidateRoot.hash,
    actual_comparison_role: 'actual_compiler_output_not_golden_oracle' as const,
    case_count: 40 as const,
    compiled_count: 11 as const,
    rejected_count: 29 as const,
    expected_coverage: 40 as const,
    comparison_coverage: 40 as const,
    byte_equal_count: exactEqualCount,
    semantic_equal_count: exactEqualCount,
    semantic_assertion_count: semanticAssertionCount,
    semantic_assertion_failure_count: semanticAssertionFailureCount,
    difference_count: 0,
    cases: reviewCases,
    human_review: {
      status: 'not_requested' as const,
      reviewer_actor_ref: 'human:local-owner' as const,
      judgment_coverage: 0 as const,
    },
    approval_status: 'absent' as const,
    signature_status: 'absent' as const,
    seal_status: 'absent' as const,
    golden_semantic_review_status: 'not_run' as const,
    g3_through_g9_status: 'not_started' as const,
  };
  const reviewPayload = {
    ...reviewPayloadWithoutHash,
    report_hash: domainSeparatedSha256(REPORT_DOMAIN, reviewPayloadWithoutHash),
  } as CurrentG2GoldenReviewPayload;
  validateSchema(
    CURRENT_G2_GOLDEN_REVIEW_SCHEMA,
    reviewPayload,
    'NodeOutputEnvelope review report',
  );
  const review = artifact(
    'icarus.workflow-compiler-current-g2-golden-review-report/1',
    'icarus.workflow-compiler-current-g2-golden-review-report',
    '2.0.0-draft-review',
    ARTIFACT_DOMAINS.review,
    reviewPayload,
  );
  const reviewSchema = artifact(
    'icarus.workflow-current-g2-golden-review-report-schema/1',
    'icarus.workflow-current-g2-golden-review-report-schema',
    '2.0.0-draft-review',
    ARTIFACT_DOMAINS.review_schema,
    CURRENT_G2_GOLDEN_REVIEW_SCHEMA,
  );
  files.set(REVIEW_SCHEMA_PATH, render(reviewSchema));
  files.set(G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_PATH, render(review));

  return {
    files,
    rc,
    draft,
    review,
    compilerIdentity,
    exactEqualCount,
    pointerDifferenceCount: 0,
  };
}

function treeFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) {
        throw new G2NodeOutputEnvelopeSuccessorError(
          `Successor tree contains symlink: ${entry}`,
        );
      }
      if (stat.isDirectory()) visit(entry);
      else
        output.push(
          path.relative(contractsRoot, entry).split(path.sep).join('/'),
        );
    }
  };
  visit(root);
  return output.sort();
}

function checkFiles(files: Map<string, string>): void {
  for (const root of [
    G2_NODE_OUTPUT_ENVELOPE_RC_ROOT,
    G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT,
    G2_NODE_OUTPUT_ENVELOPE_REVIEW_ROOT,
  ]) {
    const expected = [...files.keys()]
      .filter((entry) => entry.startsWith(`${root}/`))
      .sort();
    if (canonicalJson(treeFiles(absolute(root))) !== canonicalJson(expected)) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        `Successor inventory drift: ${root}`,
      );
    }
  }
  for (const [relativePath, expected] of files) {
    if (fs.readFileSync(absolute(relativePath), 'utf8') !== expected) {
      throw new G2NodeOutputEnvelopeSuccessorError(
        `Successor bytes drift: ${relativePath}`,
      );
    }
  }
}

function writeTrees(files: Map<string, string>): void {
  const roots = [
    G2_NODE_OUTPUT_ENVELOPE_RC_ROOT,
    G2_NODE_OUTPUT_ENVELOPE_DRAFT_ROOT,
    G2_NODE_OUTPUT_ENVELOPE_REVIEW_ROOT,
  ];
  if (roots.some((root) => fs.existsSync(absolute(root)))) {
    checkFiles(files);
    return;
  }
  const temporaries = roots.map((root) => ({
    root,
    path: fs.mkdtempSync(`${absolute(root)}.tmp-`),
  }));
  try {
    for (const [relativePath, bytes] of files) {
      const temporary = temporaries.find(({ root }) =>
        relativePath.startsWith(`${root}/`),
      );
      if (!temporary) {
        throw new G2NodeOutputEnvelopeSuccessorError(
          `Successor output is outside managed roots: ${relativePath}`,
        );
      }
      const target = path.join(
        temporary.path,
        relativePath.slice(temporary.root.length + 1),
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    for (const temporary of temporaries) {
      fs.mkdirSync(path.dirname(absolute(temporary.root)), { recursive: true });
      fs.renameSync(temporary.path, absolute(temporary.root));
    }
  } catch (error) {
    for (const temporary of temporaries) {
      fs.rmSync(temporary.path, { recursive: true, force: true });
    }
    throw error;
  }
}

export function generateG2NodeOutputEnvelopeSuccessor(
  authorizedBy: string,
): G2NodeOutputEnvelopeSuccessorBuild {
  if (authorizedBy !== AUTHORIZED_ACTOR) {
    throw new G2NodeOutputEnvelopeSuccessorError(
      'NodeOutputEnvelope successor generation is not authorized',
    );
  }
  const built = buildG2NodeOutputEnvelopeSuccessor();
  writeTrees(built.files);
  return built;
}

export function checkG2NodeOutputEnvelopeSuccessor(): G2NodeOutputEnvelopeSuccessorBuild {
  const built = buildG2NodeOutputEnvelopeSuccessor();
  checkFiles(built.files);
  return built;
}
