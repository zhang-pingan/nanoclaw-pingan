import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  buildWorkflowCompilerToolchainManifest,
  workflowCompilerIdentity,
} from '../compiler/identity.js';
import type {
  WorkflowCompilerIdentity,
  WorkflowCompilerSourceKind,
} from '../compiler/types.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import type { WorkflowCompilerConformanceCaseResultV1 } from './compiler-contract-repair-types.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import { authorCurrentG2GoldenExpectedResult } from './node-output-envelope-golden-authoring.js';
import {
  checkStaticChildPlanBundleRepair,
  STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS,
} from './static-child-plan-bundle-repair.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

export const CURRENT_G2_STATIC_CHILD_REPLAY_ROOT =
  'conformance/current/g2-static-child-plan-bundle-replay-v7';
export const CURRENT_G2_STATIC_CHILD_REPLAY_AUTHORITY_REF = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/current-replay-authority@1.json`;
export const CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_REF = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/artifact-inventory@1.json`;
export const CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_REF = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/g2-g5-readiness@1.json`;

const AUTHORITY_SCHEMA_REF = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/schemas/current-replay-authority-schema@1.json`;
const INVENTORY_SCHEMA_REF = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/schemas/artifact-inventory-schema@1.json`;
const READINESS_SCHEMA_REF = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/schemas/g2-g5-readiness-schema@1.json`;

const V6_ROOT = 'conformance/sealed/g2-generated-schema-join-authority-v6';
const V6_SEAL_REF = `${V6_ROOT}/golden-conformance-bundle@2.json`;
const V6_SEAL_ARTIFACT_HASH =
  'sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11';
const V6_BUNDLE_HASH =
  'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7';
const V6_DRAFT_REF =
  'conformance/golden-draft/g2-generated-schema-join-authority-v6/golden-draft-manifest@2.json';
const V6_DRAFT_ARTIFACT_HASH =
  'sha256:b43960ab002a49d918bddbce057e51e1055b65e2e7a1d10e44fed25c28ea66c4';
const AUTHORING_REF =
  'src/workflow-runtime/contracts/node-output-envelope-golden-authoring.ts';
const AUTHORING_RAW_HASH =
  'sha256:a574091ca544a7b838936403d1bd55d3f1757468d453d5205aaa6f8a11f897ec';

const STATUS = 'G2_IN_PROGRESS_G5_IN_PROGRESS_G6_G9_NOT_READY';
const SNAPSHOT_DOMAIN = 'icarus:workflow-compiler-input-snapshot:2\n';
const CASE_SET_DOMAIN =
  'icarus:workflow-current-g2-static-child-replay-case-set:1\n';
const INVENTORY_DOMAIN =
  'icarus:workflow-current-g2-static-child-replay-inventory:1\n';
const MEMBER_TREE_DOMAIN =
  'icarus:workflow-current-g2-static-child-replay-member-tree:1\n';
const BUNDLE_DOMAIN =
  'icarus:workflow-current-g2-static-child-replay-bundle:1\n';
const COMPILER_IDENTITY_DOMAIN =
  'icarus:workflow-current-g2-static-child-replay-compiler-identity:1\n';

const shaSchema = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
const versionedRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
  },
};
const compilerIdentitySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'compiler_toolchain_manifest_ref',
    'compiler_toolchain_hash',
    'compiler_version',
    'compiler_build_hash',
    'canonical_normalizer_version',
    'canonical_normalizer_hash',
    'proof_algorithm_version',
    'proof_algorithm_hash',
    'error_catalog_ref',
    'error_catalog_hash',
    'compiled_ir_schema_ref',
    'compiled_ir_schema_hash',
    'conformance_result_schema_ref',
    'conformance_result_schema_hash',
  ],
  properties: {
    compiler_toolchain_manifest_ref: versionedRefSchema,
    compiler_toolchain_hash: shaSchema,
    compiler_version: { type: 'string', minLength: 1 },
    compiler_build_hash: shaSchema,
    canonical_normalizer_version: { type: 'string', minLength: 1 },
    canonical_normalizer_hash: shaSchema,
    proof_algorithm_version: { type: 'string', minLength: 1 },
    proof_algorithm_hash: shaSchema,
    error_catalog_ref: versionedRefSchema,
    error_catalog_hash: shaSchema,
    compiled_ir_schema_ref: { type: 'string', minLength: 1 },
    compiled_ir_schema_hash: shaSchema,
    conformance_result_schema_ref: { type: 'string', minLength: 1 },
    conformance_result_schema_hash: shaSchema,
  },
};
const contentIdentitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'raw_bytes_hash', 'semantic_hash'],
  properties: {
    path: { type: 'string', minLength: 1 },
    raw_bytes_hash: shaSchema,
    semantic_hash: shaSchema,
  },
};
const memberSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'path', 'hash'],
  properties: {
    role: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    hash: shaSchema,
  },
};

export const CURRENT_G2_STATIC_CHILD_REPLAY_AUTHORITY_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-static-child-replay-authority-v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'gate',
    'authority_version',
    'authority_kind',
    'authority_status',
    'publishable',
    'production_reachable',
    'approval_status',
    'signature_status',
    'seal_status',
    'independent_regression_status',
    'predecessor_v6',
    'static_child_plan_bundle_authority',
    'exact_compiler_identity',
    'authoring_generator',
    'case_count',
    'compiled_count',
    'rejected_count',
    'expected_result_coverage',
    'case_set_hash',
    'cases',
    'inventory_ref',
    'inventory_hash',
    'inventory_entry_count',
    'readiness_ref',
    'readiness_hash',
    'member_count',
    'members',
    'member_tree_hash',
    'bundle_hash',
  ],
  properties: {
    format: {
      const:
        'icarus.workflow-compiler-current-g2-static-child-replay-authority/1',
    },
    gate: { const: 'G2' },
    authority_version: { const: '7.0.0-current' },
    authority_kind: { const: 'additive_current_replay_not_semantic_seal' },
    authority_status: { const: STATUS },
    publishable: { const: false },
    production_reachable: { const: false },
    approval_status: { const: 'absent_not_fabricated' },
    signature_status: { const: 'absent' },
    seal_status: { const: 'not_created' },
    independent_regression_status: { const: 'not_created_by_directed_repair' },
    predecessor_v6: {
      type: 'object',
      additionalProperties: false,
      required: [
        'seal_ref',
        'seal_artifact_hash',
        'bundle_hash',
        'compiler_identity',
      ],
      properties: {
        seal_ref: { const: V6_SEAL_REF },
        seal_artifact_hash: { const: V6_SEAL_ARTIFACT_HASH },
        bundle_hash: { const: V6_BUNDLE_HASH },
        compiler_identity: compilerIdentitySchema,
      },
    },
    static_child_plan_bundle_authority: {
      type: 'object',
      additionalProperties: false,
      required: ['pack_ref', 'pack_hash', 'member_tree_hash', 'status'],
      properties: {
        pack_ref: { const: STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack },
        pack_hash: shaSchema,
        member_tree_hash: shaSchema,
        status: {
          const:
            'DIRECTED_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
        },
      },
    },
    exact_compiler_identity: compilerIdentitySchema,
    authoring_generator: {
      type: 'object',
      additionalProperties: false,
      required: [
        'ref',
        'raw_sha256',
        'predecessor_draft_ref',
        'predecessor_draft_artifact_hash',
        'production_compiler_import_forbidden',
      ],
      properties: {
        ref: { const: AUTHORING_REF },
        raw_sha256: { const: AUTHORING_RAW_HASH },
        predecessor_draft_ref: { const: V6_DRAFT_REF },
        predecessor_draft_artifact_hash: { const: V6_DRAFT_ARTIFACT_HASH },
        production_compiler_import_forbidden: { const: true },
      },
    },
    case_count: { const: 40 },
    compiled_count: { const: 11 },
    rejected_count: { const: 29 },
    expected_result_coverage: { const: 40 },
    case_set_hash: shaSchema,
    cases: {
      type: 'array',
      minItems: 40,
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'case_id',
          'source_kind',
          'outcome',
          'raw_source_bytes_ref',
          'raw_source_file_hash',
          'historical_registry_snapshot_ref',
          'historical_registry_snapshot_artifact_hash',
          'registry_snapshot_ref',
          'registry_snapshot_artifact_hash',
          'registry_snapshot_hash',
          'registry_snapshot_file_hash',
          'snapshot_compiler_identity_relation',
          'historical_expected_result',
          'expected_result',
        ],
        properties: {
          case_id: { type: 'string', minLength: 1 },
          source_kind: {
            enum: ['graph_scope', 'workflow_definition', 'workflow_schema'],
          },
          outcome: { enum: ['compiled', 'rejected'] },
          raw_source_bytes_ref: { type: 'string', minLength: 1 },
          raw_source_file_hash: shaSchema,
          historical_registry_snapshot_ref: { type: 'string', minLength: 1 },
          historical_registry_snapshot_artifact_hash: shaSchema,
          registry_snapshot_ref: { type: 'string', minLength: 1 },
          registry_snapshot_artifact_hash: shaSchema,
          registry_snapshot_hash: shaSchema,
          registry_snapshot_file_hash: shaSchema,
          snapshot_compiler_identity_relation: {
            enum: ['exact_current', 'intentional_integrity_negative_drift'],
          },
          historical_expected_result: contentIdentitySchema,
          expected_result: contentIdentitySchema,
        },
      },
    },
    inventory_ref: { const: CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_REF },
    inventory_hash: shaSchema,
    inventory_entry_count: { const: 84 },
    readiness_ref: { const: CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_REF },
    readiness_hash: shaSchema,
    member_count: { const: 5 },
    members: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: memberSchema,
    },
    member_tree_hash: shaSchema,
    bundle_hash: shaSchema,
  },
};

export const CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-static-child-replay-inventory-v1',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'scope', 'entry_count', 'entries', 'inventory_hash'],
  properties: {
    format: {
      const:
        'icarus.workflow-compiler-current-g2-static-child-replay-inventory/1',
    },
    scope: {
      const:
        'all_current_authority_leaf_artifacts_excluding_inventory_and_authority',
    },
    entry_count: { const: 84 },
    entries: {
      type: 'array',
      minItems: 84,
      maxItems: 84,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'path',
          'kind',
          'case_id',
          'raw_bytes_hash',
          'artifact_hash',
          'semantic_hash',
        ],
        properties: {
          path: { type: 'string', minLength: 1 },
          kind: {
            enum: [
              'schema',
              'current_snapshot',
              'expected_result',
              'readiness',
            ],
          },
          case_id: { type: ['string', 'null'] },
          raw_bytes_hash: shaSchema,
          artifact_hash: { anyOf: [shaSchema, { type: 'null' }] },
          semantic_hash: shaSchema,
        },
      },
    },
    inventory_hash: shaSchema,
  },
};

export const CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-static-child-replay-readiness-v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'g2_status',
    'g5_status',
    'g6_through_g9_status',
    'current_replay_case_count',
    'current_replay_exact_required',
    'current_compiler_identity_hash',
    'case_set_hash',
    'predecessor_v6_bundle_hash',
    'static_child_bridge_pack_hash',
    'semantic_approval_created',
    'independent_regression_created',
    'closure_performed',
  ],
  properties: {
    format: { const: 'icarus.workflow-g2-g5-static-child-replay-readiness/1' },
    g2_status: { const: 'IN_PROGRESS' },
    g5_status: { const: 'IN_PROGRESS' },
    g6_through_g9_status: { const: 'NOT_READY' },
    current_replay_case_count: { const: 40 },
    current_replay_exact_required: { const: true },
    current_compiler_identity_hash: shaSchema,
    case_set_hash: shaSchema,
    predecessor_v6_bundle_hash: { const: V6_BUNDLE_HASH },
    static_child_bridge_pack_hash: shaSchema,
    semantic_approval_created: { const: false },
    independent_regression_created: { const: false },
    closure_performed: { const: false },
  },
};

interface InventoryEntry extends JsonObject {
  path: string;
  kind: 'schema' | 'current_snapshot' | 'expected_result' | 'readiness';
  case_id: string | null;
  raw_bytes_hash: Sha256Hash;
  artifact_hash: Sha256Hash | null;
  semantic_hash: Sha256Hash;
}

export interface CurrentG2StaticChildReplayAuthorityBuild {
  readonly files: Map<string, string>;
  readonly authority: ContractArtifactEnvelope;
  readonly inventory: ContractArtifactEnvelope;
  readonly readiness: ContractArtifactEnvelope;
  readonly compilerIdentity: WorkflowCompilerIdentity;
  readonly caseSetHash: Sha256Hash;
  readonly authoredExactCount: number;
}

export class CurrentG2StaticChildReplayAuthorityError extends Error {
  readonly code = 'current_g2_static_child_replay_authority_error';

  constructor(message: string) {
    super(message);
    this.name = 'CurrentG2StaticChildReplayAuthorityError';
  }
}

function absoluteContract(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      `Current G2 replay path escapes contracts root: ${relativePath}`,
    );
  }
  return resolved;
}

function readContractBytes(relativePath: string): Buffer {
  return fs.readFileSync(absoluteContract(relativePath));
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(readContractBytes(relativePath)),
  );
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
    return value;
  } catch {
    throw new CurrentG2StaticChildReplayAuthorityError(
      `Expected current G2 replay object: ${label}`,
    );
  }
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      `Expected current G2 replay array: ${label}`,
    );
  }
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function rawHash(value: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(
  format: string,
  id: string,
  refVersion: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const base = {
    format,
    ref: { id, version: refVersion },
    version: Number(format.slice(format.lastIndexOf('/') + 1)),
    domain_separator: domainSeparator,
    payload,
  };
  return {
    ...base,
    hash: calculateArtifactHash({
      ...base,
      hash: `sha256:${'0'.repeat(64)}`,
    }),
  };
}

function validateSchema(
  schema: JsonObject,
  value: JsonValue,
  label: string,
): void {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    schema as AnySchema,
  );
  if (!validate(value)) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      `${label} failed closed schema: ${JSON.stringify(validate.errors)}`,
    );
  }
}

function identityEquals(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cascadedCaseCompilerIdentity(
  historical: JsonObject,
  predecessor: JsonObject,
  current: JsonObject,
): JsonObject {
  const predecessorKeys = Object.keys(predecessor).sort();
  const currentKeys = Object.keys(current).sort();
  const historicalKeys = Object.keys(historical).sort();
  if (
    canonicalJson(predecessorKeys) !== canonicalJson(currentKeys) ||
    canonicalJson(predecessorKeys) !== canonicalJson(historicalKeys)
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Compiler identity field set drifted during current cascade',
    );
  }
  return Object.fromEntries(
    historicalKeys.map((key) => [
      key,
      identityEquals(historical[key]!, predecessor[key]!)
        ? structuredClone(current[key]!)
        : structuredClone(historical[key]!),
    ]),
  );
}

function currentSnapshot(
  historical: ContractArtifactEnvelope,
  caseId: string,
  predecessorIdentity: JsonObject,
  currentIdentity: JsonObject,
): ContractArtifactEnvelope {
  const payload = structuredClone(historical.payload);
  delete payload.snapshot_hash;
  payload.snapshot_id = `g2-static-child-plan-bundle-replay-v7:${caseId}`;
  payload.compiler_identity = cascadedCaseCompilerIdentity(
    object(payload.compiler_identity, 'historical compiler identity'),
    predecessorIdentity,
    currentIdentity,
  );
  payload.snapshot_hash = domainSeparatedSha256(SNAPSHOT_DOMAIN, payload);
  return artifact(
    historical.format,
    `${historical.ref.id}.static-child-plan-bundle-replay-v7`,
    '7.0.0-current',
    historical.domain_separator,
    payload,
  );
}

function inventoryEntry(
  pathValue: string,
  kind: InventoryEntry['kind'],
  caseId: string | null,
  bytes: string,
  semanticHash: Sha256Hash,
  artifactHash: Sha256Hash | null,
): InventoryEntry {
  return {
    path: pathValue,
    kind,
    case_id: caseId,
    raw_bytes_hash: rawHash(Buffer.from(bytes, 'utf8')),
    artifact_hash: artifactHash,
    semantic_hash: semanticHash,
  };
}

function schemaIdentity(pathValue: string, schema: JsonObject): InventoryEntry {
  const bytes = render(schema);
  return inventoryEntry(
    pathValue,
    'schema',
    null,
    bytes,
    domainSeparatedSha256(
      'icarus:workflow-current-g2-static-child-replay-schema:1\n',
      schema,
    ),
    null,
  );
}

function validateV6Boundary(): {
  seal: ContractArtifactEnvelope;
  draft: ContractArtifactEnvelope;
  predecessorIdentity: JsonObject;
} {
  const seal = readArtifact(V6_SEAL_REF);
  if (
    seal.hash !== V6_SEAL_ARTIFACT_HASH ||
    seal.payload.bundle_hash !== V6_BUNDLE_HASH
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Frozen G2 v6 predecessor identity drifted',
    );
  }
  const predecessorIdentity = object(
    seal.payload.exact_compiler_identity,
    'v6 exact compiler identity',
  );
  if (predecessorIdentity.compiler_version !== '3.0.4') {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Frozen G2 v6 predecessor compiler version drifted',
    );
  }
  const draft = readArtifact(V6_DRAFT_REF);
  if (
    draft.hash !== V6_DRAFT_ARTIFACT_HASH ||
    draft.payload.authoring_generator_ref !== AUTHORING_REF ||
    draft.payload.authoring_generator_hash !== AUTHORING_RAW_HASH
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Frozen G2 v6 authoring boundary drifted',
    );
  }
  if (
    rawHash(fs.readFileSync(path.join(repoRoot, AUTHORING_REF))) !==
    AUTHORING_RAW_HASH
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Frozen independent Golden authoring source bytes drifted',
    );
  }
  const authoringSource = fs.readFileSync(
    path.join(repoRoot, AUTHORING_REF),
    'utf8',
  );
  if (/from\s+['"][^'"]*\/compiler\//.test(authoringSource)) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Golden authoring imports the Production Compiler',
    );
  }
  return { seal, draft, predecessorIdentity };
}

function validateCaseBoundary(entry: JsonObject): void {
  const caseId = String(entry.case_id);
  const historicalPrefix = `${V6_ROOT}/`;
  const currentPrefix = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/`;
  for (const field of [
    'raw_source_bytes_ref',
    'historical_registry_snapshot_ref',
  ]) {
    if (!String(entry[field]).startsWith(historicalPrefix)) {
      throw new CurrentG2StaticChildReplayAuthorityError(
        `Current/historical authority boundary drift: ${caseId}/${field}`,
      );
    }
  }
  const historicalExpected = object(
    entry.historical_expected_result,
    'historical expected result',
  );
  if (!String(historicalExpected.path).startsWith(historicalPrefix)) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      `Historical expected result escaped v6 authority: ${caseId}`,
    );
  }
  if (
    !String(entry.registry_snapshot_ref).startsWith(
      `${currentPrefix}snapshots/`,
    )
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      `Current snapshot consumed the wrong authority: ${caseId}`,
    );
  }
  const expected = object(entry.expected_result, 'current expected result');
  if (!String(expected.path).startsWith(`${currentPrefix}expected/`)) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      `Current expected result consumed the wrong authority: ${caseId}`,
    );
  }
}

export function validateCurrentG2StaticChildReplayAuthorityPayloadForTest(
  payload: JsonObject,
): void {
  validateSchema(
    CURRENT_G2_STATIC_CHILD_REPLAY_AUTHORITY_SCHEMA,
    payload,
    'Current G2 static-child replay authority',
  );
  const currentIdentity = workflowCompilerIdentity(
    buildWorkflowCompilerToolchainManifest(),
  );
  if (
    !identityEquals(
      object(payload.exact_compiler_identity, 'authority compiler identity'),
      currentIdentity as unknown as JsonObject,
    )
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current Production Compiler identity does not match current authority',
    );
  }
  const predecessor = object(payload.predecessor_v6, 'predecessor v6');
  const predecessorIdentity = object(
    predecessor.compiler_identity,
    'predecessor compiler identity',
  );
  if (
    predecessorIdentity.compiler_version !== '3.0.4' ||
    currentIdentity.compiler_version !== '3.0.5' ||
    identityEquals(
      predecessorIdentity,
      currentIdentity as unknown as JsonObject,
    )
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current and historical G2 compiler authority boundary collapsed',
    );
  }
  const cases = objects(payload.cases, 'authority cases');
  const ids = cases.map((entry) => String(entry.case_id));
  if (new Set(ids).size !== 40) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current G2 replay case identity is missing or duplicated',
    );
  }
  for (const entry of cases) validateCaseBoundary(entry);
  if (domainSeparatedSha256(CASE_SET_DOMAIN, cases) !== payload.case_set_hash) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current G2 replay case-set hash drifted',
    );
  }
  const relations = cases.filter(
    (entry) =>
      entry.snapshot_compiler_identity_relation ===
      'intentional_integrity_negative_drift',
  );
  if (
    relations.length !== 1 ||
    relations[0]!.case_id !== 'negative.compiler-integrity-mismatch'
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current G2 replay identity-drift negative boundary is not exact',
    );
  }
  const members = objects(payload.members, 'authority members');
  if (
    domainSeparatedSha256(MEMBER_TREE_DOMAIN, members) !==
    payload.member_tree_hash
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current G2 replay member tree hash drifted',
    );
  }
  const bundleInput: JsonObject = {
    exact_compiler_identity: payload.exact_compiler_identity,
    case_set_hash: payload.case_set_hash,
    inventory_hash: payload.inventory_hash,
    readiness_hash: payload.readiness_hash,
    member_tree_hash: payload.member_tree_hash,
  };
  if (
    domainSeparatedSha256(BUNDLE_DOMAIN, bundleInput) !== payload.bundle_hash
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current G2 replay bundle hash drifted',
    );
  }
}

export function buildCurrentG2StaticChildReplayAuthority(): CurrentG2StaticChildReplayAuthorityBuild {
  const { seal, draft, predecessorIdentity } = validateV6Boundary();
  const bridge = checkStaticChildPlanBundleRepair();
  if (
    bridge.payload.status !==
      'DIRECTED_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION' ||
    bridge.payload.g2_g5_closed !== false ||
    bridge.payload.g6_ready !== false
  ) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Static-child bridge status escaped the directed-repair boundary',
    );
  }
  const compilerIdentity = workflowCompilerIdentity(
    buildWorkflowCompilerToolchainManifest(),
  );
  if (compilerIdentity.compiler_version !== '3.0.5') {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current replay authority requires Compiler 3.0.5',
    );
  }

  const files = new Map<string, string>();
  const inventoryEntries: InventoryEntry[] = [];
  const schemas: Array<[string, JsonObject]> = [
    [AUTHORITY_SCHEMA_REF, CURRENT_G2_STATIC_CHILD_REPLAY_AUTHORITY_SCHEMA],
    [INVENTORY_SCHEMA_REF, CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_SCHEMA],
    [READINESS_SCHEMA_REF, CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_SCHEMA],
  ];
  for (const [schemaPath, schema] of schemas) {
    const bytes = render(schema);
    files.set(schemaPath, bytes);
    inventoryEntries.push(schemaIdentity(schemaPath, schema));
  }

  const caseRecords: JsonObject[] = [];
  let authoredExactCount = 0;
  const v6Cases = objects(seal.payload.cases, 'frozen v6 cases');
  if (v6Cases.length !== 40) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Frozen G2 v6 case coverage is not 40',
    );
  }

  for (const sealedCase of v6Cases) {
    const caseId = String(sealedCase.case_id);
    const sourceKind = String(
      sealedCase.source_kind,
    ) as WorkflowCompilerSourceKind;
    const sourceRef = String(sealedCase.raw_source_bytes_ref);
    const historicalSnapshotRef = String(sealedCase.registry_snapshot_ref);
    const historicalExpectedIdentity = object(
      sealedCase.expected_result,
      'frozen expected result identity',
    );
    const historicalExpectedRef = String(historicalExpectedIdentity.path);
    for (const boundaryPath of [
      sourceRef,
      historicalSnapshotRef,
      historicalExpectedRef,
    ]) {
      if (!boundaryPath.startsWith(`${V6_ROOT}/`)) {
        throw new CurrentG2StaticChildReplayAuthorityError(
          `Frozen G2 v6 case escaped sealed root: ${caseId}`,
        );
      }
    }
    const sourceBytes = readContractBytes(sourceRef);
    const historicalSnapshotBytes = readContractBytes(historicalSnapshotRef);
    const historicalSnapshot = parseContractArtifactEnvelope(
      strictParseJsonBytes(historicalSnapshotBytes),
    );
    const historicalExpectedBytes = readContractBytes(historicalExpectedRef);
    const historicalExpected = strictParseJsonBytes(
      historicalExpectedBytes,
    ) as WorkflowCompilerConformanceCaseResultV1;
    if (
      rawHash(sourceBytes) !== sealedCase.raw_source_file_hash ||
      rawHash(historicalSnapshotBytes) !==
        sealedCase.input_snapshot_file_hash ||
      rawHash(historicalExpectedBytes) !==
        historicalExpectedIdentity.raw_bytes_hash
    ) {
      throw new CurrentG2StaticChildReplayAuthorityError(
        `Frozen G2 v6 leaf bytes drifted: ${caseId}`,
      );
    }

    const snapshot = currentSnapshot(
      historicalSnapshot,
      caseId,
      predecessorIdentity,
      compilerIdentity as unknown as JsonObject,
    );
    const snapshotPath = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/snapshots/${caseId}.snapshot@1.json`;
    const snapshotBytes = render(snapshot);
    files.set(snapshotPath, snapshotBytes);
    inventoryEntries.push(
      inventoryEntry(
        snapshotPath,
        'current_snapshot',
        caseId,
        snapshotBytes,
        snapshot.payload.snapshot_hash as Sha256Hash,
        snapshot.hash,
      ),
    );

    const expected = authorCurrentG2GoldenExpectedResult({
      caseId,
      sourceKind,
      rawSourceText: sourceBytes.toString('utf8'),
      expectedSourceHash: historicalExpected.source_hash,
      inputSnapshot: snapshot.payload,
      expectedDiagnostics: historicalExpected.diagnostics,
    });
    const expectedPath = `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/expected/${caseId}.result.json`;
    const expectedBytes = render(expected as unknown as JsonValue);
    files.set(expectedPath, expectedBytes);
    inventoryEntries.push(
      inventoryEntry(
        expectedPath,
        'expected_result',
        caseId,
        expectedBytes,
        expected.result_hash,
        null,
      ),
    );
    authoredExactCount += 1;

    const snapshotIdentity = object(
      snapshot.payload.compiler_identity,
      'current snapshot compiler identity',
    );
    const relation = identityEquals(
      snapshotIdentity,
      compilerIdentity as unknown as JsonObject,
    )
      ? 'exact_current'
      : 'intentional_integrity_negative_drift';
    caseRecords.push({
      case_id: caseId,
      source_kind: sourceKind,
      outcome: expected.outcome,
      raw_source_bytes_ref: sourceRef,
      raw_source_file_hash: rawHash(sourceBytes),
      historical_registry_snapshot_ref: historicalSnapshotRef,
      historical_registry_snapshot_artifact_hash: historicalSnapshot.hash,
      registry_snapshot_ref: snapshotPath,
      registry_snapshot_artifact_hash: snapshot.hash,
      registry_snapshot_hash: snapshot.payload.snapshot_hash,
      registry_snapshot_file_hash: rawHash(Buffer.from(snapshotBytes, 'utf8')),
      snapshot_compiler_identity_relation: relation,
      historical_expected_result: {
        path: historicalExpectedRef,
        raw_bytes_hash: rawHash(historicalExpectedBytes),
        semantic_hash: historicalExpected.result_hash,
      },
      expected_result: {
        path: expectedPath,
        raw_bytes_hash: rawHash(Buffer.from(expectedBytes, 'utf8')),
        semantic_hash: expected.result_hash,
      },
    });
  }

  const caseSetHash = domainSeparatedSha256(CASE_SET_DOMAIN, caseRecords);
  const readinessPayload: JsonObject = {
    format: 'icarus.workflow-g2-g5-static-child-replay-readiness/1',
    g2_status: 'IN_PROGRESS',
    g5_status: 'IN_PROGRESS',
    g6_through_g9_status: 'NOT_READY',
    current_replay_case_count: 40,
    current_replay_exact_required: true,
    current_compiler_identity_hash: domainSeparatedSha256(
      COMPILER_IDENTITY_DOMAIN,
      compilerIdentity as unknown as JsonObject,
    ),
    case_set_hash: caseSetHash,
    predecessor_v6_bundle_hash: V6_BUNDLE_HASH,
    static_child_bridge_pack_hash: bridge.hash,
    semantic_approval_created: false,
    independent_regression_created: false,
    closure_performed: false,
  };
  validateSchema(
    CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_SCHEMA,
    readinessPayload,
    'Current G2/G5 readiness',
  );
  const readiness = artifact(
    'icarus.workflow-g2-g5-static-child-replay-readiness/1',
    'icarus.workflow-g2-g5-static-child-replay-readiness',
    '1.0.0',
    'icarus:workflow-g2-g5-static-child-replay-readiness:1\n',
    readinessPayload,
  );
  const readinessBytes = render(readiness);
  files.set(CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_REF, readinessBytes);
  inventoryEntries.push(
    inventoryEntry(
      CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_REF,
      'readiness',
      null,
      readinessBytes,
      readiness.hash,
      readiness.hash,
    ),
  );

  inventoryEntries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const inventoryWithoutHash: JsonObject = {
    format:
      'icarus.workflow-compiler-current-g2-static-child-replay-inventory/1',
    scope:
      'all_current_authority_leaf_artifacts_excluding_inventory_and_authority',
    entry_count: inventoryEntries.length,
    entries: inventoryEntries as unknown as JsonValue,
  };
  const inventoryPayload: JsonObject = {
    ...inventoryWithoutHash,
    inventory_hash: domainSeparatedSha256(
      INVENTORY_DOMAIN,
      inventoryWithoutHash,
    ),
  };
  validateSchema(
    CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_SCHEMA,
    inventoryPayload,
    'Current G2 replay inventory',
  );
  const inventory = artifact(
    'icarus.workflow-compiler-current-g2-static-child-replay-inventory/1',
    'icarus.workflow-compiler-current-g2-static-child-replay-inventory',
    '1.0.0',
    'icarus:workflow-compiler-current-g2-static-child-replay-inventory:1\n',
    inventoryPayload,
  );
  files.set(CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_REF, render(inventory));

  const members: JsonObject[] = [
    { role: 'historical_v6_seal', path: V6_SEAL_REF, hash: seal.hash },
    {
      role: 'current_static_child_bridge_pack',
      path: STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack,
      hash: bridge.hash,
    },
    {
      role: 'independent_golden_authoring',
      path: AUTHORING_REF,
      hash: AUTHORING_RAW_HASH,
    },
    {
      role: 'current_g2_g5_readiness',
      path: CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_REF,
      hash: readiness.hash,
    },
    {
      role: 'current_replay_inventory',
      path: CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_REF,
      hash: inventory.hash,
    },
  ];
  const memberTreeHash = domainSeparatedSha256(MEMBER_TREE_DOMAIN, members);
  const bundleInput: JsonObject = {
    exact_compiler_identity: compilerIdentity as unknown as JsonObject,
    case_set_hash: caseSetHash,
    inventory_hash: inventory.hash,
    readiness_hash: readiness.hash,
    member_tree_hash: memberTreeHash,
  };
  const authorityPayload: JsonObject = {
    format:
      'icarus.workflow-compiler-current-g2-static-child-replay-authority/1',
    gate: 'G2',
    authority_version: '7.0.0-current',
    authority_kind: 'additive_current_replay_not_semantic_seal',
    authority_status: STATUS,
    publishable: false,
    production_reachable: false,
    approval_status: 'absent_not_fabricated',
    signature_status: 'absent',
    seal_status: 'not_created',
    independent_regression_status: 'not_created_by_directed_repair',
    predecessor_v6: {
      seal_ref: V6_SEAL_REF,
      seal_artifact_hash: seal.hash,
      bundle_hash: V6_BUNDLE_HASH,
      compiler_identity: predecessorIdentity,
    },
    static_child_plan_bundle_authority: {
      pack_ref: STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack,
      pack_hash: bridge.hash,
      member_tree_hash: bridge.payload.member_tree_hash,
      status: bridge.payload.status,
    },
    exact_compiler_identity: compilerIdentity as unknown as JsonObject,
    authoring_generator: {
      ref: AUTHORING_REF,
      raw_sha256: AUTHORING_RAW_HASH,
      predecessor_draft_ref: V6_DRAFT_REF,
      predecessor_draft_artifact_hash: draft.hash,
      production_compiler_import_forbidden: true,
    },
    case_count: 40,
    compiled_count: 11,
    rejected_count: 29,
    expected_result_coverage: 40,
    case_set_hash: caseSetHash,
    cases: caseRecords,
    inventory_ref: CURRENT_G2_STATIC_CHILD_REPLAY_INVENTORY_REF,
    inventory_hash: inventory.hash,
    inventory_entry_count: inventoryEntries.length,
    readiness_ref: CURRENT_G2_STATIC_CHILD_REPLAY_READINESS_REF,
    readiness_hash: readiness.hash,
    member_count: members.length,
    members,
    member_tree_hash: memberTreeHash,
    bundle_hash: domainSeparatedSha256(BUNDLE_DOMAIN, bundleInput),
  };
  validateCurrentG2StaticChildReplayAuthorityPayloadForTest(authorityPayload);
  const authority = artifact(
    'icarus.workflow-compiler-current-g2-static-child-replay-authority/1',
    'icarus.workflow-compiler-current-g2-static-child-replay-authority',
    '1.0.0',
    'icarus:workflow-compiler-current-g2-static-child-replay-authority:1\n',
    authorityPayload,
  );
  files.set(CURRENT_G2_STATIC_CHILD_REPLAY_AUTHORITY_REF, render(authority));

  return {
    files,
    authority,
    inventory,
    readiness,
    compilerIdentity,
    caseSetHash,
    authoredExactCount,
  };
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) result.push(relative);
      else {
        throw new CurrentG2StaticChildReplayAuthorityError(
          `Current replay authority contains non-file entry: ${relative}`,
        );
      }
    }
  };
  visit(root, '');
  return result.sort();
}

export function checkCurrentG2StaticChildReplayAuthorityAtRootForTest(
  root: string,
): CurrentG2StaticChildReplayAuthorityBuild {
  const built = buildCurrentG2StaticChildReplayAuthority();
  const expected = [...built.files]
    .map(
      ([relativePath, bytes]) =>
        [
          relativePath.slice(CURRENT_G2_STATIC_CHILD_REPLAY_ROOT.length + 1),
          bytes,
        ] as const,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const actualPaths = listFiles(root);
  const expectedPaths = expected.map(([relativePath]) => relativePath);
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new CurrentG2StaticChildReplayAuthorityError(
      'Current replay authority file boundary drifted',
    );
  }
  for (const [relativePath, expectedBytes] of expected) {
    const actualBytes = fs.readFileSync(path.join(root, relativePath), 'utf8');
    if (actualBytes !== expectedBytes) {
      throw new CurrentG2StaticChildReplayAuthorityError(
        `Current replay authority bytes drifted: ${relativePath}`,
      );
    }
  }
  return built;
}

export function generateCurrentG2StaticChildReplayAuthority(): CurrentG2StaticChildReplayAuthorityBuild {
  const built = buildCurrentG2StaticChildReplayAuthority();
  for (const [relativePath, bytes] of built.files) {
    const target = absoluteContract(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, bytes, 'utf8');
    fs.renameSync(temporary, target);
  }
  return built;
}

export function checkCurrentG2StaticChildReplayAuthority(): CurrentG2StaticChildReplayAuthorityBuild {
  return checkCurrentG2StaticChildReplayAuthorityAtRootForTest(
    absoluteContract(CURRENT_G2_STATIC_CHILD_REPLAY_ROOT),
  );
}
